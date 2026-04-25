import React, {
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { LauncherConfig } from '../../desktop-app/config.js'
import {
  getNormalizedEventDedupeKey,
  normalizeJarvisMessageEvent,
} from '../../desktop-app/eventNormalization.js'
import { THUNDER_SESSION_INTRO_PROMPT } from '../../desktop-app/sessionLaunchPrompts.js'
import type {
  DesktopBuddyProfile,
  DesktopBuddyProfileDraft,
  DesktopEvent,
  DesktopFeatureSnapshot,
  DesktopRuntimeState,
  DesktopShellPayload,
  DesktopView,
  ModelCatalogResponse,
  PendingPermission,
  type NormalizedJarvisEvent,
  RemoteBridgeHealth,
  SnapshotEvent,
  StatusTone,
} from '../../desktop-app/types.js'
import type {
  JarvisBootstrapPayload,
  JarvisBridge,
  JarvisCompanionPayload,
} from '../preloadApi.js'
import { motion, AnimatePresence } from 'framer-motion'
import { GENTLE, SNAPPY } from './constants/springs.js'
import { DriveSetupWizard } from './components/DriveSetupWizard.js'
import { CompanionDock } from './components/CompanionDock.js'
import { CompanionTab } from './components/CompanionTab.js'
import { ThunderAutomationPanel } from './components/ThunderAutomationPanel.js'
import { TitleBar } from './components/TitleBar.js'
import { WebGLBackground } from './components/WebGLBackground.js'
import { Slideover } from './components/Slideover.js'
import { AgentStatusBar } from './components/AgentStatusBar.js'
import { VerificationHold } from './components/VerificationHold.js'
import { InputArea } from './components/InputArea.js'
import { CommandPalette, type PaletteCommand } from './components/CommandPalette.js'
import { useAgentStore } from './store/agentStore.js'
import type { VerificationRequest } from './types/agent.js'

/* JarvisBridge global is declared in components/TitleBar.tsx */

type AugmentedDesktopEvent = DesktopEvent & { id: number }

type TranscriptDetail = {
  title: string
  body: string
}

type TranscriptEntry = {
  id: string
  kind: 'message' | 'timeline'
  role?: 'user' | 'assistant'
  speaker?: string
  label?: string
  tone?: StatusTone
  body: string
  chips: string[]
  details: TranscriptDetail[]
}

type TranscriptBuildMetrics = {
  renderedMessageCount: number
  renderedTimelineCount: number
  dedupedCount: number
}

type TranscriptBuildResult = {
  entries: TranscriptEntry[]
  metrics: TranscriptBuildMetrics
}

type ConfigNotice = {
  tone: StatusTone
  message: string
}

const MAX_TRANSCRIPT_EVENTS = 320
const SHARED_RUNTIME_DEFAULT_MIGRATION = 'shared-runtime-default-v1'
const NAV_ITEMS: Array<{ id: DesktopView; label: string; glyph: string }> = [
  { id: 'chat', label: 'Chat', glyph: 'CH' },
  { id: 'autodream', label: 'AutoDream', glyph: 'AD' },
  { id: 'memory', label: 'Memory', glyph: 'ME' },
  { id: 'integrations', label: 'Integrations', glyph: 'AP' },
  { id: 'companion', label: 'Companion', glyph: 'BD' },
]

const DEFAULT_CONFIG: LauncherConfig = {
  workspacePath: '',
  backend: 'ollama',
  anthropicApiKey: '',
  anthropicBaseUrl: '',
  anthropicModel: 'claude-3-7-sonnet-20250219',
  ollamaBaseUrl: 'http://localhost:11434/v1',
  ollamaModel: '',
  localRuntimeEngine: 'shared-runtime',
  remoteGlmBaseUrl: '',
  remoteGlmApiKey: '',
  remoteGlmModel: 'gpt-oss-auto',
  coordinatorMode: false,
  disableToolsForLocal: true,
  enableExperimentalLocalTools: false,
  disableNonessentialTraffic: true,
  disableThinkingForLocal: true,
  appendSystemPrompt: '',
  thunderInstanceId: '',
  thunderPublicUrl: '',
  thunderSessionActive: false,
  useSandbox: false,
  wslDistro: '',
  sharedRuntimeDefaultMigration: SHARED_RUNTIME_DEFAULT_MIGRATION,
  enableAgenticLocalMode: true,
  braveSearchApiKey: 'BSAMujLEIQYcq2sc5HaL-u6_-21ED3U',
  drive: {
    credentialsPath: '',
    tokenPath: '',
    folderIds: null,
    setupComplete: false,
    embeddingModel: 'nomic-embed-text',
  },
  ollamaVram: {
    numCtx: 8192,
    flashAttention: true,
    kvCacheType: 'q8_0',
    numPredict: 4096,
    temperature: 0.2,
  },
}

const DEFAULT_SHELL: DesktopShellPayload = {
  uiState: {
    activeView: 'chat',
    advancedSettingsOpen: false,
    selectedIntegrationId: null,
  },
  integrations: [],
}

const IDLE_RUNTIME: DesktopRuntimeState = {
  running: false,
  busy: false,
  label: 'Idle',
  tone: 'idle',
  backend: null,
  mode: 'idle',
  model: '',
  workspacePath: '',
  sessionId: null,
}

const DEFAULT_BUDDY_DRAFT: DesktopBuddyProfileDraft = {
  name: '',
  personality: '',
  species: 'duck',
  eye: '.',
  hat: 'none',
  shiny: false,
  rarity: 'common',
}

function laneLabel(value: string): string {
  if (!value || value === 'gpt-oss-auto') {
    return 'Auto'
  }
  if (value === 'gpt-oss-120b' || value === '120b') {
    return '120B'
  }
  if (value === 'gpt-oss-20b' || value === '20b') {
    return '20B'
  }
  return value
}

function formatDateTime(value: string | number | null | undefined): string {
  if (!value) {
    return 'Unknown'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : date.toLocaleString([], {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
}

function titleCase(value: string): string {
  if (!value) {
    return ''
  }
  return value[0]!.toUpperCase() + value.slice(1)
}

function stringifyForDetail(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function cleanReActOutput(text: string): string {
  if (!text) return text
  // Extract only the FINAL ANSWER content when present
  const finalAnswerMatch = /FINAL ANSWER:\s*([\s\S]+)$/m.exec(text)
  if (finalAnswerMatch?.[1]) {
    return finalAnswerMatch[1].trim()
  }
  // If only a THOUGHT: block with no FINAL ANSWER, strip the prefix
  return text.replace(/^THOUGHT:\s*/i, '').trim()
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(block => {
      if (!block || typeof block !== 'object') {
        return ''
      }
      if ('type' in block && block.type === 'text' && typeof block.text === 'string') {
        return block.text
      }
      if (
        'type' in block &&
        block.type === 'connector_text' &&
        typeof block.connector_text === 'string'
      ) {
        return block.connector_text
      }
      if (
        'type' in block &&
        (block.type === 'thinking' || block.type === 'tool_result')
      ) {
        return ''
      }
      return typeof (block as { content?: unknown }).content === 'string'
        ? ((block as { content: string }).content ?? '')
        : ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function extractBlocksByType(content: unknown, type: string): Array<Record<string, any>> {
  if (!Array.isArray(content)) {
    return []
  }
  return content.filter(
    block => Boolean(block) && typeof block === 'object' && block.type === type,
  ) as Array<Record<string, any>>
}

function extractToolResults(content: unknown): TranscriptDetail[] {
  if (!Array.isArray(content)) {
    return []
  }
  return content
    .filter(block => block && typeof block === 'object' && block.type === 'tool_result')
    .map(block => ({
      title: `Tool result${block.tool_use_id ? ` ${block.tool_use_id}` : ''}`,
      body: stringifyForDetail(block.content ?? block),
    }))
}

function unwrapMessagePayload(message: Record<string, any>): Record<string, any> {
  if (
    message.type === 'message' &&
    message.message &&
    typeof message.message === 'object' &&
    !Array.isArray(message.message)
  ) {
    return message.message as Record<string, any>
  }
  return message
}

function summarizeUnknownMessage(
  message: Record<string, any>,
  normalized: NormalizedJarvisEvent,
): string {
  const payload = unwrapMessagePayload(message)
  if (normalized.text.trim()) {
    return normalized.text
  }
  if (typeof payload.message === 'string') {
    return payload.message
  }
  if (typeof payload.content === 'string') {
    return payload.content
  }
  if (typeof payload.subtype === 'string') {
    return `Event subtype: ${payload.subtype}`
  }
  return 'A runtime event was received.'
}

function normalizeUserEntry(
  id: number,
  message: Record<string, any>,
  normalized: NormalizedJarvisEvent,
): TranscriptEntry[] {
  const payload = unwrapMessagePayload(message)
  const content = payload.message?.content ?? payload.content ?? ''
  const text = normalized.text || extractTextContent(content)
  const details = extractToolResults(content)
  return [
    {
      id: `user-${id}`,
      kind: 'message',
      role: 'user',
      speaker: 'You',
      body: text || 'Sent a user message.',
      chips: details.length > 0 ? ['tool result'] : [],
      details,
    },
  ]
}

function normalizeAssistantEntry(
  id: number,
  message: Record<string, any>,
  normalized: NormalizedJarvisEvent,
  chips: string[] = [],
): TranscriptEntry[] {
  const payload = unwrapMessagePayload(message)
  const content = payload.message?.content ?? payload.content ?? []
  const text = cleanReActOutput(normalized.text || extractTextContent(content))
  const thinkingBlocks = extractBlocksByType(content, 'thinking')
  const toolUses = extractBlocksByType(content, 'tool_use').concat(
    extractBlocksByType(content, 'server_tool_use'),
  )
  const redactedThinking = extractBlocksByType(content, 'redacted_thinking')
  const details: TranscriptDetail[] = []

  if (thinkingBlocks.length > 0) {
    details.push({
      title: 'Thinking',
      body: thinkingBlocks
        .map(block => block.thinking || block.text || stringifyForDetail(block))
        .join('\n\n'),
    })
  }
  if (redactedThinking.length > 0) {
    details.push({
      title: 'Redacted thinking',
      body: `Jarvis received ${redactedThinking.length} redacted thinking block${redactedThinking.length === 1 ? '' : 's'}.`,
    })
  }
  for (const tool of toolUses) {
    details.push({
      title: `Tool input: ${tool.name || 'Unnamed tool'}`,
      body: stringifyForDetail(tool.input ?? tool),
    })
  }

  return [
    {
      id: `assistant-${id}`,
      kind: 'message',
      role: 'assistant',
      speaker: 'Jarvis',
      body:
        text ||
        (toolUses.length > 0
          ? 'Issued tool calls and is waiting for the local execution loop.'
          : 'Assistant response received.'),
      chips: [
        ...(thinkingBlocks.length > 0 ? ['thinking'] : []),
        ...toolUses.map(tool => tool.name || 'tool'),
        ...chips,
      ],
      details,
    },
  ]
}

function resolveNormalizedMessage(
  event: AugmentedDesktopEvent,
): NormalizedJarvisEvent | null {
  if (event.type !== 'message') {
    return null
  }
  return event.normalized ?? normalizeJarvisMessageEvent(event.message)
}

export function buildTranscriptEntries(
  events: AugmentedDesktopEvent[],
): TranscriptBuildResult {
  const entries: TranscriptEntry[] = []
  const streamEntryByTurn = new Map<string, number>()
  const seenMessageKeys = new Set<string>()
  let dedupedCount = 0

  for (const event of events) {
    if (event.type === 'message') {
      const message = event.message as Record<string, any>
      const normalized = resolveNormalizedMessage(event)
      if (!normalized) {
        continue
      }
      const dedupeKey = getNormalizedEventDedupeKey(normalized)
      if (seenMessageKeys.has(dedupeKey)) {
        dedupedCount += 1
        continue
      }
      seenMessageKeys.add(dedupeKey)

      if (normalized.kind === 'user' || normalized.displayRole === 'user') {
        entries.push(...normalizeUserEntry(event.id, message, normalized))
        continue
      }

      if (normalized.kind === 'stream_event' && normalized.displayRole === 'assistant') {
        const turnKey = normalized.turnId ?? `stream-${event.id}`
        const existingIndex = streamEntryByTurn.get(turnKey)
        const streamText = cleanReActOutput(normalized.text)
        if (existingIndex !== undefined) {
          const existing = entries[existingIndex]
          if (existing && streamText) {
            existing.body = cleanReActOutput(
              [existing.body, streamText].filter(Boolean).join(''),
            )
          }
          continue
        }
        const [entry] = normalizeAssistantEntry(event.id, message, normalized, ['stream'])
        entry.body = streamText || 'Jarvis is streaming a response...'
        entries.push(entry)
        if (normalized.turnId) {
          streamEntryByTurn.set(normalized.turnId, entries.length - 1)
        }
        continue
      }

      if (normalized.kind === 'assistant' || normalized.displayRole === 'assistant') {
        if (normalized.turnId) {
          streamEntryByTurn.delete(normalized.turnId)
        }
        entries.push(...normalizeAssistantEntry(event.id, message, normalized))
        continue
      }

      entries.push({
        id: `event-${event.id}`,
        kind: 'timeline',
        label: titleCase(normalized.kind.replace(/_/g, ' ')),
        tone: normalized.isErrorLike ? 'error' : 'idle',
        body: summarizeUnknownMessage(message, normalized),
        chips: normalized.kind === 'unknown' ? ['unknown'] : [],
        details: [
          {
            title: 'Raw event',
            body: stringifyForDetail(message),
          },
        ],
      })
      continue
    }

    if (event.type === 'info') {
      entries.push({
        id: `info-${event.id}`,
        kind: 'timeline',
        label: event.label || 'Runtime',
        tone: 'idle',
        body: event.body || '',
        chips: [],
        details: [],
      })
      continue
    }

    if (event.type === 'stderr') {
      entries.push({
        id: `stderr-${event.id}`,
        kind: 'timeline',
        label: 'Runtime',
        tone: 'error',
        body: event.line || '',
        chips: ['stderr'],
        details: [],
      })
      continue
    }

    if (event.type === 'permission') {
      entries.push({
        id: `permission-${event.id}`,
        kind: 'timeline',
        label: 'Permission requested',
        tone: 'warning',
        body:
          event.description ||
          `${event.toolName} is waiting for approval in the safety rail.`,
        chips: [event.toolName],
        details: [
          {
            title: 'Tool input',
            body: stringifyForDetail(event.input),
          },
        ],
      })
    }
  }

  const renderedMessageCount = entries.filter(entry => entry.kind === 'message').length
  const renderedTimelineCount = entries.length - renderedMessageCount
  return {
    entries,
    metrics: {
      renderedMessageCount,
      renderedTimelineCount,
      dedupedCount,
    },
  }
}

function withNormalizedMessageEvent(event: DesktopEvent): DesktopEvent {
  if (event.type !== 'message') {
    return event
  }
  if (event.normalized) {
    return event
  }
  return {
    ...event,
    normalized: normalizeJarvisMessageEvent(event.message),
  }
}

function getUnnormalizedMessageMergeKey(message: unknown): string {
  const payload =
    message && typeof message === 'object' && !Array.isArray(message)
      ? (message as Record<string, any>)
      : {}
  const type = typeof payload.type === 'string' ? payload.type : ''
  const nested =
    payload.message && typeof payload.message === 'object' && !Array.isArray(payload.message)
      ? (payload.message as Record<string, any>)
      : null
  const role =
    typeof nested?.role === 'string'
      ? nested.role
      : typeof payload.role === 'string'
        ? payload.role
        : ''
  const content =
    typeof nested?.content === 'string'
      ? nested.content
      : typeof payload.content === 'string'
        ? payload.content
        : ''

  if (content.trim().length > 0 && (role === 'user' || type === 'user')) {
    return `message:user:${content.trim()}`
  }
  if (content.trim().length > 0 && (role === 'assistant' || type === 'assistant')) {
    return `message:assistant:${content.trim()}`
  }
  return `message:raw:${stringifyForDetail(message)}`
}

function getDesktopEventMergeKey(event: DesktopEvent | AugmentedDesktopEvent): string {
  if (event.type === 'message') {
    if (event.normalized) {
      return `message:${getNormalizedEventDedupeKey(event.normalized)}`
    }
    return getUnnormalizedMessageMergeKey(event.message)
  }
  if (event.type === 'info') {
    return `info:${event.label}:${event.body}`
  }
  if (event.type === 'stderr') {
    return `stderr:${event.line}`
  }
  if (event.type === 'permission') {
    return `permission:${event.requestId}:${event.toolName}`
  }
  if (event.type === 'permission_resolved') {
    return `permission_resolved:${event.requestId}`
  }
  return `state:${event.state.sessionId ?? '-'}:${event.state.label}:${event.state.tone}:${event.state.busy ? '1' : '0'}`
}

export function mergeSnapshotEventsForTranscript(
  current: AugmentedDesktopEvent[],
  snapshotEvents: DesktopEvent[],
  nextEventIdStart: number,
): { events: AugmentedDesktopEvent[]; nextEventId: number } {
  let nextEventId = nextEventIdStart
  const normalizedSnapshot = snapshotEvents
    .slice(-MAX_TRANSCRIPT_EVENTS)
    .map(event => withNormalizedMessageEvent(event))

  if (current.length === 0) {
    nextEventId = 1
    return {
      events: normalizedSnapshot.map(event => ({
        ...event,
        id: nextEventId++,
      })),
      nextEventId,
    }
  }

  // Track turnIds for which the snapshot already has a terminal (finalized) event.
  // Stream-phase events in current for these turns are stale and must not be
  // appended after the snapshot's finalized entry — doing so causes order drift
  // and duplicate assistant content in buildTranscriptEntries.
  const finalizedTurnIds = new Set<string>()
  for (const event of normalizedSnapshot) {
    if (event.type === 'message' && event.normalized?.isTerminal && event.normalized.turnId) {
      finalizedTurnIds.add(event.normalized.turnId)
    }
  }

  const currentByKey = new Map<string, AugmentedDesktopEvent>()
  for (const event of current) {
    currentByKey.set(getDesktopEventMergeKey(event), event)
  }

  const merged: AugmentedDesktopEvent[] = []
  const seenKeys = new Set<string>()
  for (const event of normalizedSnapshot) {
    const key = getDesktopEventMergeKey(event)
    if (seenKeys.has(key)) {
      continue
    }
    seenKeys.add(key)
    const existing = currentByKey.get(key)
    if (existing) {
      merged.push(existing)
      continue
    }
    merged.push({
      ...event,
      id: nextEventId++,
    })
  }

  for (const event of current) {
    const key = getDesktopEventMergeKey(event)
    if (seenKeys.has(key)) {
      continue
    }
    seenKeys.add(key)
    // Drop stream-phase events whose turn is already finalized in the snapshot.
    // The snapshot's terminal assistant entry supersedes all partial stream deltas.
    if (
      event.type === 'message' &&
      event.normalized?.phase === 'stream' &&
      event.normalized.turnId &&
      finalizedTurnIds.has(event.normalized.turnId)
    ) {
      continue
    }
    merged.push(event)
  }

  return {
    events: merged.slice(-MAX_TRANSCRIPT_EVENTS),
    nextEventId,
  }
}

function statusClass(tone: StatusTone | undefined): string {
  if (tone === 'running') {
    return 'is-running'
  }
  if (tone === 'error') {
    return 'is-error'
  }
  if (tone === 'warning') {
    return 'is-warning'
  }
  return ''
}

function viewTitle(view: DesktopView): string {
  if (view === 'autodream') {
    return 'AutoDream'
  }
  if (view === 'memory') {
    return 'Memory'
  }
  if (view === 'integrations') {
    return 'Integrations'
  }
  if (view === 'companion') {
    return 'Companion'
  }
  return 'Chat'
}

function buildNotice(error: unknown): ConfigNotice {
  return {
    tone: 'error',
    message: error instanceof Error ? error.message : String(error),
  }
}

export function App(): React.ReactNode {
  const [config, setConfig] = useState<LauncherConfig>(DEFAULT_CONFIG)
  const [shell, setShell] = useState<DesktopShellPayload>(DEFAULT_SHELL)
  const [features, setFeatures] = useState<DesktopFeatureSnapshot | null>(null)
  const [models, setModels] = useState<ModelCatalogResponse | null>(null)
  const [runtime, setRuntime] = useState<DesktopRuntimeState>(IDLE_RUNTIME)
  const [events, setEvents] = useState<AugmentedDesktopEvent[]>([])
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([])
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [remoteHealth, setRemoteHealth] = useState<RemoteBridgeHealth | null>(null)
  const [notice, setNotice] = useState<ConfigNotice | null>(null)
  const [backendState, setBackendState] = useState<{
    ready: boolean
    url: string | null
    error?: string
  }>({ ready: false, url: null })
  const [integrationSearch, setIntegrationSearch] = useState('')
  const [integrationStatusFilter, setIntegrationStatusFilter] = useState<
    'all' | 'draft' | 'ready' | 'paused'
  >('all')
  const [integrationForm, setIntegrationForm] = useState({
    id: '',
    name: '',
    category: '',
    baseUrl: '',
    authMode: 'none',
    status: 'draft',
    tags: '',
    notes: '',
  })
  const [buddyEditor, setBuddyEditor] =
    useState<DesktopBuddyProfileDraft>(DEFAULT_BUDDY_DRAFT)
  const [selectedBuddyId, setSelectedBuddyId] = useState<string | null>(null)
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  const [driveWizardOpen, setDriveWizardOpen] = useState(false)
  const [driveSteps, setDriveSteps] = useState<Array<{
    stepIndex: number
    total: number
    title: string
    instruction: string
    requiresUserAction: boolean
    actionLabel?: string
  }>>([])
  const [driveSetupComplete, setDriveSetupComplete] = useState(true) // optimistic default
  const [wsl2Sandbox, setWsl2Sandbox] = useState<{
    available: boolean
    distro?: string
    reason?: string
  } | null>(null)
  // Maps requestId -> seconds remaining on the auto-deny countdown
  const [permissionCountdowns, setPermissionCountdowns] = useState<Record<string, number>>({})
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)
  const transcriptBottomRef = useRef<HTMLDivElement | null>(null)
  const nextEventId = useRef(1)
  const pendingOptimisticContent = useRef<string | null>(null)
  const reattachPendingRef = useRef(true)
  const observerSuppressedRef = useRef(false)
  const transcriptAttachedRef = useRef(true)
  const transcriptUnlockTimerRef = useRef<number | null>(null)
  const [transcriptAttached, setTranscriptAttached] = useState(true)
  const [transcriptHasUnseenBelow, setTranscriptHasUnseenBelow] = useState(false)

  // Thunder Compute state
  const [thunderPhase, setThunderPhase] = useState<
    'idle' | 'terminal' | 'automating' | 'complete'
  >('idle')
  const [thunderInstanceId, setThunderInstanceId] = useState('')
  const [thunderResumeAvailable, setThunderResumeAvailable] = useState(false)
  // 'v2' for new snapshot-driven sessions; 'v1' for legacy SSH-orchestrated resume; 'attach' for reconnect to existing
  const [thunderMode, setThunderMode] = useState<'v1' | 'v2' | 'attach'>('v2')
  const [attachInstanceInput, setAttachInstanceInput] = useState('')

  const transcriptBuild = useMemo(() => buildTranscriptEntries(events), [events])
  const transcriptEntries = transcriptBuild.entries
  const activeView = shell.uiState.activeView
  const activeBuddy = features?.buddy ?? null

  useEffect(() => {
    console.debug(
      '[jarvis-render-metrics]',
      JSON.stringify({
        eventCount: events.length,
        renderedMessageCount: transcriptBuild.metrics.renderedMessageCount,
        renderedTimelineCount: transcriptBuild.metrics.renderedTimelineCount,
        dedupedCount: transcriptBuild.metrics.dedupedCount,
      }),
    )
  }, [
    events.length,
    transcriptBuild.metrics.dedupedCount,
    transcriptBuild.metrics.renderedMessageCount,
    transcriptBuild.metrics.renderedTimelineCount,
  ])

  useEffect(() => {
    let cancelled = false
    window.jarvis
      .bootstrap()
      .then(async (payload: JarvisBootstrapPayload) => {
        if (cancelled) {
          return
        }
        setConfig(payload.config)
        setShell(payload.shell)
        setFeatures(payload.features)
        setModels(payload.models)
        setLoading(false)

        // Check Drive setup status — show wizard if not yet configured
        try {
          const driveStatus = await window.jarvis.getDriveStatus()
          setDriveSetupComplete(driveStatus.setupComplete)
          if (!driveStatus.setupComplete && driveStatus.steps?.length > 0) {
            setDriveSteps(driveStatus.steps)
            setDriveWizardOpen(true)
          }
        } catch {
          // Drive status unavailable — not a blocking error
        }

        // Check for resumable Thunder session
        if (
          payload.config.thunderSessionActive &&
          payload.config.thunderInstanceId
        ) {
          try {
            const check = await window.jarvis.thunderCheckSession(
              payload.config.thunderInstanceId,
            )
            if (!cancelled && check.running) {
              if (payload.config.remoteGlmApiKey) {
                // Use attach mode — instance already has vLLM + bridge running via s6;
                // V1 SSH orchestration would try to restart them and conflict with the loaded GPU.
                setThunderMode('attach')
                setThunderInstanceId(payload.config.thunderInstanceId)
                setThunderResumeAvailable(false)
                setThunderPhase('automating')
              } else {
                setThunderResumeAvailable(true)
              }
            } else if (!cancelled) {
              // Instance no longer running — clear session fields
              const cleared: LauncherConfig = {
                ...payload.config,
                thunderInstanceId: '',
                thunderPublicUrl: '',
                thunderSessionActive: false,
              }
              setConfig(cleared)
              void window.jarvis.saveConfig(cleared)
            }
          } catch {
            // tnr not available or failed — ignore
          }
        }
      })
      .catch(error => {
        if (!cancelled) {
          setNotice(buildNotice(error))
          setLoading(false)
        }
      })

    const disposeEvents = window.jarvis.onEvent(payload => {
      startTransition(() => {
        if ((payload as SnapshotEvent).type === 'snapshot') {
          const snapshot = payload as SnapshotEvent
          setRuntime(snapshot.state)
          setPendingPermissions(snapshot.pendingPermissions)
          if ((snapshot as any).wsl2Sandbox) {
            setWsl2Sandbox((snapshot as any).wsl2Sandbox)
          }
          setEvents(current => {
            const merged = mergeSnapshotEventsForTranscript(
              current,
              snapshot.events,
              nextEventId.current,
            )
            nextEventId.current = merged.nextEventId
            return merged.events
          })
          transcriptAttachedRef.current = true
          reattachPendingRef.current = true
          return
        }

        const event = withNormalizedMessageEvent(payload as DesktopEvent)
        if (event.type === 'state') {
          setRuntime(event.state)
          return
        }
        // Deduplicate: if this is the SSE echo of the user message we already
        // added optimistically, drop it so it doesn't appear twice.
        if (event.type === 'message' && pendingOptimisticContent.current !== null) {
          const normalized = event.normalized ?? normalizeJarvisMessageEvent(event.message)
          if (normalized.displayRole === 'user') {
            const arrived = normalized.text
            if (arrived.trim() === pendingOptimisticContent.current.trim()) {
              pendingOptimisticContent.current = null
              return
            }
          }
        }
        if (event.type === 'permission') {
          setPendingPermissions(current => {
            const rest = current.filter(item => item.requestId !== event.requestId)
            return [...rest, event]
          })
        }
        if (event.type === 'permission_resolved') {
          setPendingPermissions(current =>
            current.filter(item => item.requestId !== event.requestId),
          )
        }
        setEvents(current => {
          const normalized = event.type === 'message' ? event.normalized : null
          if (normalized) {
            const key = getNormalizedEventDedupeKey(normalized)
            const alreadySeen = current.some(existing => {
              if (existing.type !== 'message' || !existing.normalized) {
                return false
              }
              return getNormalizedEventDedupeKey(existing.normalized) === key
            })
            if (alreadySeen) {
              return current
            }
          }
          const next = [...current, { ...event, id: nextEventId.current++ }]
          return next.slice(-MAX_TRANSCRIPT_EVENTS)
        })
      })
    })

    const disposeBackend = window.jarvis.onBackendState(payload => {
      setBackendState(payload)
    })

    // Thunder: listen for session detection from Phase 1
    const disposeThunder = window.jarvis.onThunderSessionDetected(payload => {
      setThunderInstanceId(payload.instanceId)
      setThunderPhase('automating')
    })

    return () => {
      cancelled = true
      disposeEvents()
      disposeBackend()
      disposeThunder()
    }
  }, [])

  // ── Permission countdown timer (30s) ────────────────────────────────────
  useEffect(() => {
    if (pendingPermissions.length === 0) {
      setPermissionCountdowns({})
      return
    }

    // Initialize countdown for any new permissions
    setPermissionCountdowns(current => {
      const next = { ...current }
      for (const perm of pendingPermissions) {
        if (!(perm.requestId in next)) {
          next[perm.requestId] = 30
        }
      }
      // Remove countdowns for resolved permissions
      for (const key of Object.keys(next)) {
        if (!pendingPermissions.some(p => p.requestId === key)) {
          delete next[key]
        }
      }
      return next
    })

    const interval = setInterval(() => {
      setPermissionCountdowns(current => {
        const next = { ...current }
        for (const key of Object.keys(next)) {
          if (typeof next[key] === 'number') {
            next[key] = Math.max(0, next[key]! - 1)
          }
        }
        return next
      })
    }, 1000)

    return () => clearInterval(interval)
  }, [pendingPermissions])

  useEffect(() => {
    if (!features?.buddy) {
      return
    }
    const activeProfile =
      features.buddy.profiles.find(profile => profile.isActive) ??
      features.buddy.profiles[0] ??
      null
    if (!activeProfile) {
      setSelectedBuddyId(null)
      setBuddyEditor(DEFAULT_BUDDY_DRAFT)
      return
    }
    if (!selectedBuddyId || !features.buddy.profiles.some(p => p.id === selectedBuddyId)) {
      setSelectedBuddyId(activeProfile.id)
      setBuddyEditor({
        name: activeProfile.name,
        personality: activeProfile.personality,
        species: activeProfile.species,
        eye: activeProfile.eye,
        hat: activeProfile.hat,
        shiny: activeProfile.shiny,
        rarity: activeProfile.rarity,
      })
    }
  }, [features, selectedBuddyId])

  useEffect(() => {
    setSettingsOpen(shell.uiState.advancedSettingsOpen)
  }, [shell.uiState.advancedSettingsOpen])

  useEffect(() => {
    transcriptAttachedRef.current = transcriptAttached
  }, [transcriptAttached])

  useEffect(() => {
    return () => {
      if (transcriptUnlockTimerRef.current !== null) {
        window.clearTimeout(transcriptUnlockTimerRef.current)
      }
    }
  }, [])

  function syncTranscriptAttachment(force = false): void {
    const scrollElement = transcriptScrollRef.current
    if (!scrollElement || (!force && observerSuppressedRef.current)) {
      return
    }
    const distanceFromBottom = Math.max(
      0,
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight,
    )
    const nextAttached = transcriptAttachedRef.current
      ? distanceFromBottom <= 76
      : distanceFromBottom <= 28
    transcriptAttachedRef.current = nextAttached
    setTranscriptAttached(current => (current === nextAttached ? current : nextAttached))
    setTranscriptHasUnseenBelow(transcriptEntries.length > 0 && !nextAttached)
  }

  function scrollTranscriptToBottom(behavior: ScrollBehavior = 'auto'): void {
    const scrollElement = transcriptScrollRef.current
    if (!scrollElement) {
      return
    }
    const bottomOffset = transcriptBottomRef.current?.offsetTop ?? scrollElement.scrollHeight
    observerSuppressedRef.current = true
    if (transcriptUnlockTimerRef.current !== null) {
      window.clearTimeout(transcriptUnlockTimerRef.current)
      transcriptUnlockTimerRef.current = null
    }
    scrollElement.scrollTo({ top: bottomOffset, behavior })
    transcriptUnlockTimerRef.current = window.setTimeout(() => {
      observerSuppressedRef.current = false
      transcriptUnlockTimerRef.current = null
      syncTranscriptAttachment(true)
    }, behavior === 'smooth' ? 240 : 40)
  }

  useLayoutEffect(() => {
    const scrollElement = transcriptScrollRef.current
    if (!scrollElement) {
      return
    }
    if (transcriptAttached || reattachPendingRef.current) {
      scrollTranscriptToBottom(reattachPendingRef.current ? 'smooth' : 'auto')
      transcriptAttachedRef.current = true
      setTranscriptAttached(true)
      setTranscriptHasUnseenBelow(false)
      reattachPendingRef.current = false
    } else if (transcriptEntries.length > 0) {
      syncTranscriptAttachment(true)
    }
  }, [transcriptEntries, transcriptAttached])

  useEffect(() => {
    const scrollElement = transcriptScrollRef.current
    if (!scrollElement) {
      return
    }

    const handleScroll = (): void => {
      syncTranscriptAttachment()
    }

    handleScroll()
    scrollElement.addEventListener('scroll', handleScroll, { passive: true })
    return () => scrollElement.removeEventListener('scroll', handleScroll)
  }, [transcriptEntries.length])

  const filteredIntegrations = shell.integrations.filter(entry => {
    if (
      integrationStatusFilter !== 'all' &&
      entry.status !== integrationStatusFilter
    ) {
      return false
    }
    if (!integrationSearch.trim()) {
      return true
    }
    const query = integrationSearch.trim().toLowerCase()
    return (
      entry.name.toLowerCase().includes(query) ||
      entry.category.toLowerCase().includes(query) ||
      entry.baseUrl.toLowerCase().includes(query) ||
      entry.notes.toLowerCase().includes(query) ||
      entry.tags.some(tag => tag.toLowerCase().includes(query))
    )
  })

  async function persistShell(nextShell: DesktopShellPayload): Promise<void> {
    const saved = await window.jarvis.saveShell(nextShell)
    setShell(saved)
  }

  async function applyCompanionPayload(
    promise: Promise<JarvisCompanionPayload>,
  ): Promise<void> {
    const payload = await promise
    setFeatures(payload.features)
    setNotice({
      tone: 'idle',
      message: payload.buddy.hatched
        ? `${payload.buddy.name} is active in the companion lane.`
        : 'Companion Studio updated.',
    })
  }

  async function handleSaveConfig(): Promise<void> {
    try {
      const saved = await window.jarvis.saveConfig(config)
      setConfig(saved)
      setNotice({ tone: 'idle', message: 'Jarvis settings saved.' })
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  function resetTranscriptView(): void {
    nextEventId.current = 1
    setEvents([])
    transcriptAttachedRef.current = true
    setTranscriptHasUnseenBelow(false)
    setTranscriptAttached(true)
  }

  async function handleStartSession(options: {
    configOverride?: LauncherConfig
    resetTranscript?: boolean
    launchIntroPrompt?: string
  } = {}): Promise<void> {
    try {
      if (options.resetTranscript) {
        await window.jarvis.clearTranscript({ silent: true })
        resetTranscriptView()
        setPrompt('')
      }
      const sessionConfig = options.configOverride ?? config
      await window.jarvis.startSession(sessionConfig, {
        launchIntroPrompt: options.launchIntroPrompt,
      })
      reattachPendingRef.current = true
      setNotice({ tone: 'idle', message: 'Jarvis session launched.' })
      const nextShell = {
        ...shell,
        uiState: { ...shell.uiState, activeView: 'chat' as DesktopView },
      }
      setShell(nextShell)
      void persistShell(nextShell)
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleSendPrompt(): Promise<void> {
    const content = prompt.trim()
    if (!content) {
      return
    }
    try {
      reattachPendingRef.current = true
      setPrompt('')
      // Optimistically add the user message immediately so it appears in the
      // feed without waiting for the SSE round-trip (which can take 1-5 s).
      pendingOptimisticContent.current = content
      setEvents(current => {
        const next = [
          ...current,
          {
            type: 'message' as const,
            message: { type: 'user', message: { role: 'user', content } },
            id: nextEventId.current++,
          },
        ]
        return next.slice(-MAX_TRANSCRIPT_EVENTS)
      })
      const response = (await window.jarvis.sendPrompt(content)) as
        | { features?: DesktopFeatureSnapshot }
        | undefined
      if (response?.features) {
        setFeatures(response.features)
      }
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handlePermission(
    requestId: string,
    decision: 'allow' | 'deny',
    permanent = false,
  ): Promise<void> {
    try {
      await window.jarvis.respondToPermission(requestId, decision, permanent)
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleCheckRemoteHealth(): Promise<void> {
    try {
      const health = await window.jarvis.checkRemoteHealth(config)
      setRemoteHealth(health)
      setNotice({
        tone: health.ok && health.ready ? 'idle' : 'warning',
        message: health.message,
      })
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  // --- Thunder Compute handlers ---

  async function handleNewGpuSession(): Promise<void> {
    // Require bridge API key before starting
    if (!config.remoteGlmApiKey) {
      setNotice({
        tone: 'warning',
        message: 'Set your Bridge API key in Settings before launching a GPU session.',
      })
      toggleSettings(true)
      return
    }
    // V2 path: go straight to the automation panel — instance is created there.
    // No terminal window, no detection phase.
    setThunderMode('v2')
    setThunderInstanceId('')
    setThunderPhase('automating')
  }

  function handleThunderComplete(publicUrl: string, instanceId: string): void {
    setThunderPhase('complete')
    // Save session config
    const updated: LauncherConfig = {
      ...config,
      remoteGlmBaseUrl: publicUrl,
      remoteGlmModel: 'gpt-oss-auto',
      thunderInstanceId: instanceId,
      thunderPublicUrl: publicUrl,
      thunderSessionActive: true,
      backend: 'remote-glm',
    }
    setConfig(updated)
    void window.jarvis.saveConfig(updated)
    setNotice({
      tone: 'idle',
      message: `GPU session active. Instance ${instanceId} connected via ${publicUrl}`,
    })
    // Auto-launch a fresh Jarvis session with a hidden first turn.
    void handleStartSession({
      configOverride: updated,
      resetTranscript: true,
      launchIntroPrompt: THUNDER_SESSION_INTRO_PROMPT,
    })
    // Reset phase after a moment so the panel clears
    setTimeout(() => setThunderPhase('idle'), 2000)
  }

  function handleThunderAbort(): void {
    setThunderPhase('idle')
    setNotice({
      tone: 'warning',
      message: 'GPU session aborted. The Thunder instance may still be running.',
    })
  }

  async function handleThunderResume(): Promise<void> {
    if (!config.thunderInstanceId || !config.remoteGlmApiKey) {
      return
    }
    // Use attach mode — instance already has vLLM + bridge running via s6;
    // V1 SSH orchestration would conflict with the already-loaded GPU.
    setThunderMode('attach')
    setThunderInstanceId(config.thunderInstanceId)
    setThunderPhase('automating')
  }

  function handleThunderAttach(instanceId: string): void {
    if (!instanceId.trim() || !config.remoteGlmApiKey) {
      setNotice({
        tone: 'warning',
        message: !config.remoteGlmApiKey
          ? 'Set your Bridge API key in Settings before connecting.'
          : 'Enter a valid instance ID.',
      })
      return
    }
    setThunderMode('attach')
    setThunderInstanceId(instanceId.trim())
    setAttachInstanceInput('')
    setThunderPhase('automating')
  }

  async function handleCompanionAction(
    action: 'hatch' | 'rehatch' | 'pet' | 'mute' | 'unmute' | 'reset',
  ): Promise<void> {
    try {
      await applyCompanionPayload(window.jarvis.runCompanionAction(action))
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleCreateBuddy(): Promise<void> {
    try {
      await applyCompanionPayload(window.jarvis.createCompanionProfile(buddyEditor))
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleUpdateBuddy(): Promise<void> {
    if (!selectedBuddyId) {
      await handleCreateBuddy()
      return
    }
    try {
      await applyCompanionPayload(
        window.jarvis.updateCompanionProfile(selectedBuddyId, buddyEditor),
      )
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleSelectBuddy(profile: DesktopBuddyProfile): Promise<void> {
    setSelectedBuddyId(profile.id)
    setBuddyEditor({
      name: profile.name,
      personality: profile.personality,
      species: profile.species,
      eye: profile.eye,
      hat: profile.hat,
      shiny: profile.shiny,
      rarity: profile.rarity,
    })
    try {
      await applyCompanionPayload(window.jarvis.selectCompanionProfile(profile.id))
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleDeleteBuddy(): Promise<void> {
    if (!selectedBuddyId) {
      return
    }
    try {
      await applyCompanionPayload(window.jarvis.deleteCompanionProfile(selectedBuddyId))
      setSelectedBuddyId(null)
      setBuddyEditor(DEFAULT_BUDDY_DRAFT)
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  async function handleClearTranscript(): Promise<void> {
    try {
      await window.jarvis.clearTranscript()
      resetTranscriptView()
    } catch (error) {
      setNotice(buildNotice(error))
    }
  }

  function reattachTranscript(): void {
    reattachPendingRef.current = true
    transcriptAttachedRef.current = true
    setTranscriptAttached(true)
    setTranscriptHasUnseenBelow(false)
  }

  function openView(view: DesktopView): void {
    const nextShell = {
      ...shell,
      uiState: {
        ...shell.uiState,
        activeView: view,
      },
    }
    setShell(nextShell)
    void persistShell(nextShell)
  }

  function toggleSettings(nextOpen?: boolean): void {
    const open = nextOpen ?? !settingsOpen
    setSettingsOpen(open)
    const nextShell = {
      ...shell,
      uiState: {
        ...shell.uiState,
        advancedSettingsOpen: open,
      },
    }
    setShell(nextShell)
    void persistShell(nextShell)
  }

  function loadIntegrationForm(id: string | null): void {
    const entry = shell.integrations.find(item => item.id === id)
    if (!entry) {
      setIntegrationForm({
        id: '',
        name: '',
        category: '',
        baseUrl: '',
        authMode: 'none',
        status: 'draft',
        tags: '',
        notes: '',
      })
      return
    }
    setIntegrationForm({
      id: entry.id,
      name: entry.name,
      category: entry.category,
      baseUrl: entry.baseUrl,
      authMode: entry.authMode,
      status: entry.status,
      tags: entry.tags.join(', '),
      notes: entry.notes,
    })
  }

  async function saveIntegration(): Promise<void> {
    const now = new Date().toISOString()
    const id = integrationForm.id || crypto.randomUUID()
    const nextEntry = {
      id,
      name: integrationForm.name.trim(),
      category: integrationForm.category.trim() || 'General',
      baseUrl: integrationForm.baseUrl.trim(),
      authMode: integrationForm.authMode as any,
      status: integrationForm.status as any,
      notes: integrationForm.notes.trim(),
      tags: integrationForm.tags
        .split(',')
        .map(tag => tag.trim())
        .filter(Boolean),
      updatedAt: now,
    }
    if (!nextEntry.name) {
      setNotice({ tone: 'warning', message: 'Integrations need a name.' })
      return
    }
    const nextIntegrations = shell.integrations
      .filter(entry => entry.id !== id)
      .concat(nextEntry)
      .sort((left, right) => left.name.localeCompare(right.name))
    const nextShell = {
      ...shell,
      integrations: nextIntegrations,
      uiState: {
        ...shell.uiState,
        selectedIntegrationId: id,
      },
    }
    await persistShell(nextShell)
    loadIntegrationForm(id)
    setNotice({ tone: 'idle', message: 'Integration saved.' })
  }

  async function deleteIntegration(): Promise<void> {
    if (!integrationForm.id) {
      return
    }
    const nextShell = {
      ...shell,
      integrations: shell.integrations.filter(entry => entry.id !== integrationForm.id),
      uiState: {
        ...shell.uiState,
        selectedIntegrationId: null,
      },
    }
    await persistShell(nextShell)
    loadIntegrationForm(null)
  }

  useEffect(() => {
    loadIntegrationForm(shell.uiState.selectedIntegrationId)
  }, [shell.uiState.selectedIntegrationId, shell.integrations])

  /* ── CMD+K global command palette ───────────────────────────────────── */
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCmdPaletteOpen(open => !open)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  /* ── Bridge worker state into the agent state machine ───── */
  const agentStore = useAgentStore()
  useEffect(() => {
    if (pendingPermissions.length > 0) {
      const next = pendingPermissions[0]
      const inputPreview = JSON.stringify(next.input, null, 2)
      const request: VerificationRequest = {
        requestId: next.requestId,
        message: `Jarvis is requesting permission to run ${next.toolName}.`,
        context:
          (next.description ? `${next.description}\n\n` : '') + inputPreview,
        confirmLabel: `Allow ${next.toolName}`,
        denyLabel: `Block ${next.toolName}`,
      }
      agentStore.requestVerification(request)
    } else if (agentStore.verification !== null) {
      // Pending list cleared externally — drop the hold
      agentStore.resolveVerification('confirm')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingPermissions])

  useEffect(() => {
    if (runtime.tone === 'error') {
      agentStore.setError(runtime.label)
    } else if (runtime.busy || runtime.running) {
      agentStore.setState('thinking')
    } else {
      agentStore.setState('idle')
      agentStore.clearThinking()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.tone, runtime.busy, runtime.running, runtime.label])

  // Sync model name from runtime into agentStore for display
  useEffect(() => {
    if (runtime.model) {
      agentStore.setModelName(runtime.model)
    } else if (config.backend === 'remote-glm') {
      agentStore.setModelName(config.remoteGlmModel || 'GPT-OSS')
    } else {
      agentStore.setModelName(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.model, config.backend, config.remoteGlmModel])

  // Drive agentStore state from message events (tool_use → executing, thinking → thinking)
  useEffect(() => {
    const lastEvent = events[events.length - 1]
    if (!lastEvent || lastEvent.type !== 'message') return
    const message = lastEvent.message as Record<string, any>
    const payload = unwrapMessagePayload(message)
    const normalized =
      lastEvent.normalized ?? normalizeJarvisMessageEvent(lastEvent.message)
    const content = payload.message?.content ?? payload.content ?? []
    if (normalized.displayRole === 'assistant' && Array.isArray(content)) {
      const hasToolUse = content.some(
        (block: any) => block?.type === 'tool_use' || block?.type === 'server_tool_use',
      )
      const hasThinking = content.some((block: any) => block?.type === 'thinking')
      if (hasToolUse) {
        agentStore.setState('executing')
      } else if (hasThinking) {
        const thinkingText = content
          .filter((block: any) => block?.type === 'thinking')
          .map((block: any) => String(block.thinking || ''))
          .join('')
        if (thinkingText) agentStore.appendThinking(thinkingText)
        agentStore.setState('thinking')
      }
    }
    if (normalized.kind === 'result' && !normalized.isErrorLike) {
      agentStore.setState('idle')
      agentStore.clearThinking()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events])

  const handleVerificationDecision = (
    decision: 'confirm' | 'deny',
    request: VerificationRequest,
  ): void => {
    void window.jarvis
      .respondToPermission(request.requestId, decision === 'confirm' ? 'allow' : 'deny')
      .catch(error => {
        setNotice(buildNotice(error))
      })
  }

  const chatModeLabel =
    config.backend === 'remote-glm'
      ? `Remote / ${laneLabel(config.remoteGlmModel)}`
      : config.backend === 'ollama'
        ? `Local / ${config.localRuntimeEngine === 'shared-runtime' ? 'Shared' : 'Legacy'} / ${config.ollamaModel || 'Ollama'}`
        : `Anthropic / ${config.anthropicModel || 'Claude'}`

  /* ── Command palette definitions ─────────────────────────────────────────
   * All core actions reachable from root in ≤ 4 interactions via CMD+K.
   * ─────────────────────────────────────────────────────────────────────── */
  const paletteCommands = useMemo<PaletteCommand[]>(
    () => [
      ...NAV_ITEMS.map(item => ({
        id: `nav-${item.id}`,
        glyph: item.glyph,
        label: `Go to ${item.label}`,
        description: `Switch to the ${item.label} view`,
        execute: () => openView(item.id),
      })),
      {
        id: 'action-send',
        glyph: '→',
        label: 'Send prompt',
        description: 'Submit the current composer text',
        execute: () => void handleSendPrompt(),
      },
      {
        id: 'action-launch',
        glyph: '▶',
        label: 'Launch session',
        description: 'Start a new Jarvis session',
        execute: () => void handleStartSession(),
      },
      {
        id: 'action-interrupt',
        glyph: '⏸',
        label: 'Interrupt',
        description: 'Interrupt the running session',
        execute: () => void window.jarvis.interruptSession().catch(() => {}),
      },
      {
        id: 'action-stop',
        glyph: '■',
        label: 'Stop session',
        description: 'Terminate the active Jarvis session',
        execute: () => void window.jarvis.stopSession().catch(() => {}),
      },
      {
        id: 'action-clear',
        glyph: '⌫',
        label: 'Clear transcript',
        description: 'Remove all messages from the feed',
        execute: () => void handleClearTranscript(),
      },
      {
        id: 'action-gpu',
        glyph: 'GPU',
        label: 'New GPU session',
        description: 'Launch Thunder Compute terminal',
        execute: () => void handleNewGpuSession(),
      },
      {
        id: 'action-health',
        glyph: '✓',
        label: 'Check server',
        description: 'Ping the configured bridge endpoint',
        execute: () => void handleCheckRemoteHealth(),
      },
      {
        id: 'action-settings',
        glyph: 'ST',
        label: 'Open settings',
        description: 'Connection controls and model configuration',
        execute: () => toggleSettings(true),
      },
      {
        id: 'action-pet',
        glyph: '♥',
        label: 'Pet buddy',
        description: `Give ${activeBuddy?.name ?? 'your companion'} some affection`,
        execute: () => void handleCompanionAction('pet'),
      },
      {
        id: 'action-mute',
        glyph: activeBuddy?.muted ? '🔊' : '🔇',
        label: activeBuddy?.muted ? 'Unmute buddy' : 'Mute buddy',
        description: activeBuddy?.muted
          ? 'Re-enable companion reactions'
          : 'Silence companion speech bubbles',
        execute: () =>
          void handleCompanionAction(activeBuddy?.muted ? 'unmute' : 'mute'),
      },
      {
        id: 'action-rehatch',
        glyph: '🥚',
        label: 'Rehatch buddy',
        description: 'Reset and re-roll your companion',
        execute: () => void handleCompanionAction('rehatch'),
      },
      {
        id: 'action-bridge-health',
        glyph: '⚡',
        label: 'Check bridge health',
        description: 'Ping the remote GLM bridge endpoint',
        execute: () => void handleCheckRemoteHealth(),
      },
      {
        id: 'action-show-memory',
        glyph: 'ME',
        label: 'Show memory',
        description: 'Open the MEMORY.md preview',
        execute: () => openView('memory'),
      },
      {
        id: 'action-autodream',
        glyph: 'AD',
        label: 'Open AutoDream',
        description: 'View memory consolidation status and trigger a pass',
        execute: () => openView('autodream'),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeView, activeBuddy?.name, activeBuddy?.muted, runtime.running],
  )

  return (
    <>
    <WebGLBackground />
    {/* Global command palette — CMD+K renders above everything */}
    <CommandPalette
      open={cmdPaletteOpen}
      onClose={() => setCmdPaletteOpen(false)}
      commands={paletteCommands}
    />
    <div className="jarvis-root">
      <TitleBar
        subtitle={chatModeLabel}
        statusLabel={runtime.label}
        statusTone={runtime.tone}
        gpuModelName={runtime.model || config.remoteGlmModel || 'GPT-OSS 120B'}
        gpuStatus={
          config.backend === 'remote-glm'
            ? runtime.running
              ? 'active'
              : thunderPhase === 'automating'
                ? 'polling'
                : 'disconnected'
            : undefined
        }
      />

      <div className="shell-grid">
        <aside className="nav-rail">
          <div className="nav-stack">
            {NAV_ITEMS.map(item => (
              <button
                key={item.id}
                className={`nav-button ${activeView === item.id ? 'active' : ''}`}
                onClick={() => openView(item.id)}
                title={item.label}
              >
                <span className="nav-glyph">{item.glyph}</span>
                <span className="nav-text">{item.label}</span>
              </button>
            ))}
          </div>
          <div className="nav-footer">
            {!driveSetupComplete && (
              <button
                className="nav-button ghost"
                title="Connect Google Drive cloud brain"
                onClick={() => {
                  if (driveSteps.length === 0) {
                    void window.jarvis.getDriveStatus().then(status => {
                      setDriveSteps(status.steps ?? [])
                      setDriveWizardOpen(true)
                    }).catch(() => {})
                  } else {
                    setDriveWizardOpen(true)
                  }
                }}
              >
                <span className="nav-glyph">DR</span>
                <span className="nav-text">Drive</span>
              </button>
            )}
            <button className="nav-button ghost" onClick={() => toggleSettings()}>
              <span className="nav-glyph">ST</span>
              <span className="nav-text">Settings</span>
            </button>
          </div>
        </aside>

        <main className="workspace-shell">
          <section className={`hero-strip ${activeView === 'chat' ? 'is-chat' : ''}`}>
            <div className="hero-copy">
              <div className="eyebrow">Jarvis Runtime</div>
              <h1>{viewTitle(activeView)}</h1>
              <p>
                Native desktop shell, Claude-grounded companion behavior, and a
                cleaner command-center interface for GPT-OSS orchestration.
              </p>
            </div>
            <div className="hero-chips">
              <div className="hero-chip">
                <span>Worker</span>
                <strong>{backendState.ready ? 'Ready' : 'Booting'}</strong>
              </div>
              <div className="hero-chip">
                <span>Lane</span>
                <strong>{laneLabel(config.remoteGlmModel)}</strong>
              </div>
              <div className="hero-chip">
                <span>Fallback</span>
                <strong>{models?.defaultModel || 'Loading'}</strong>
              </div>
            </div>
          </section>

          <div className={`workspace-grid ${activeView === 'chat' ? 'chat-active' : ''}`}>
            <section className="content-column">
              {activeView === 'chat' && thunderPhase === 'automating' && (
                <div className="thunder-automation-stage">
                  <ThunderAutomationPanel
                    instanceId={thunderInstanceId}
                    bridgeApiKey={config.remoteGlmApiKey}
                    onComplete={handleThunderComplete}
                    onAbort={handleThunderAbort}
                    mode={thunderMode}
                  />
                </div>
              )}

              {activeView === 'chat' && thunderPhase !== 'automating' && (
                <div className="chat-shell">
                  {thunderResumeAvailable && thunderPhase === 'idle' && (
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 16px',
                      background: 'var(--accent-soft)',
                      borderRadius: 'var(--radius-sm)',
                      marginBottom: 8,
                      fontSize: 13,
                    }}>
                      <span style={{ color: 'var(--accent-strong)', fontWeight: 600 }}>
                        Active Thunder session: {config.thunderInstanceId}
                      </span>
                      <button
                        className="ghost-button"
                        style={{ marginLeft: 'auto', fontSize: 12 }}
                        onClick={() => void handleThunderResume()}
                      >
                        Resume session
                      </button>
                    </div>
                  )}
                  <div className="command-strip">
                    <div className="command-strip-left">
                      <span className="signal-dot" />
                      <span>{runtime.label}</span>
                      <span className="command-chip">{chatModeLabel}</span>
                      {remoteHealth && (
                        <span
                          className={`command-chip ${remoteHealth.ok && remoteHealth.ready ? 'ok' : 'warn'}`}
                        >
                          {remoteHealth.message}
                        </span>
                      )}
                    </div>
                    <div className="command-strip-actions">
                      <button className="ghost-button" onClick={() => void handleNewGpuSession()}>
                        New GPU Session
                      </button>
                      <input
                        className="command-strip-input"
                        type="text"
                        placeholder="Instance ID..."
                        value={attachInstanceInput}
                        onChange={e => setAttachInstanceInput(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleThunderAttach(attachInstanceInput)
                        }}
                      />
                      <button
                        className="ghost-button"
                        disabled={!attachInstanceInput.trim()}
                        onClick={() => handleThunderAttach(attachInstanceInput)}
                      >
                        Reconnect
                      </button>
                      <button className="ghost-button" onClick={() => void handleCheckRemoteHealth()}>
                        Check server
                      </button>
                      <button className="ghost-button" onClick={() => void handleClearTranscript()}>
                        Clear feed
                      </button>
                      <button className="primary-button" onClick={() => void handleStartSession()}>
                        Launch
                      </button>
                    </div>
                  </div>

                  {/*
                   * Focus-weighted flex: transcript physically relinquishes
                   * spatial weight when the settings drawer is open.
                   * motion.div layout ensures the resize is physically smooth.
                   */}
                  <motion.div
                    layout
                    className="transcript-panel"
                    animate={{
                      flexGrow: settingsOpen ? 1.5 : 3,
                    }}
                    transition={GENTLE}
                    style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
                  >
                    <div className="transcript-scroll" ref={transcriptScrollRef}>
                      <div className="transcript-list">
                        {loading && <div className="empty-state">Booting Jarvis...</div>}
                        {!loading && transcriptEntries.length === 0 && (
                          <div className="empty-state">
                            Launch Jarvis against your GPT-OSS server to begin a session.
                          </div>
                        )}
                        <AnimatePresence initial={false}>
                          {transcriptEntries.map(entry => (
                            <motion.article
                              key={entry.id}
                              layout="position"
                              initial={{ opacity: 0, y: 12, scale: 0.985 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -8, scale: 0.98 }}
                              transition={entry.kind === 'timeline' ? GENTLE : SNAPPY}
                              className={`transcript-card ${entry.kind} ${entry.role ?? ''} ${statusClass(entry.tone)}`}
                            >
                              <div className="transcript-head">
                                <strong>{entry.speaker || entry.label || 'Jarvis'}</strong>
                                {entry.label && entry.speaker ? <span>{entry.label}</span> : null}
                              </div>
                              {entry.chips.length > 0 && (
                                <div className="transcript-badges">
                                  {entry.chips.map(chip => (
                                    <span key={`${entry.id}-${chip}`} className="command-chip subtle">
                                      {chip}
                                    </span>
                                  ))}
                                </div>
                              )}
                              <div className="transcript-body">{entry.body}</div>
                              {entry.details.length > 0 && (
                                <div className="transcript-details">
                                  {entry.details.map(detail => (
                                    <details key={`${entry.id}-${detail.title}`}>
                                      <summary>{detail.title}</summary>
                                      <pre>{detail.body}</pre>
                                    </details>
                                  ))}
                                </div>
                              )}
                            </motion.article>
                          ))}
                        </AnimatePresence>
                        <div ref={transcriptBottomRef} className="transcript-bottom-sentinel" />
                      </div>
                    </div>

                    <AnimatePresence initial={false}>
                      {transcriptHasUnseenBelow && !transcriptAttached && (
                        <motion.button
                          className="jump-latest"
                          onClick={reattachTranscript}
                          initial={{ opacity: 0, x: '-50%', y: 12, scale: 0.94 }}
                          animate={{ opacity: 1, x: '-50%', y: 0, scale: 1 }}
                          exit={{ opacity: 0, x: '-50%', y: 10, scale: 0.96 }}
                          transition={SNAPPY}
                        >
                          Jump to latest
                        </motion.button>
                      )}
                    </AnimatePresence>
                  </motion.div>

                  {/* Inline permission cards — appear between transcript and composer */}
                  <AnimatePresence>
                    {pendingPermissions.length > 0 && (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 8 }}
                        transition={SNAPPY}
                        style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}
                      >
                        {pendingPermissions.map(permission => {
                          const countdown = permissionCountdowns[permission.requestId]
                          const countdownCritical = typeof countdown === 'number' && countdown <= 10
                          return (
                            <motion.div
                              key={permission.requestId}
                              className="permission-card"
                              layout="position"
                              initial={{ opacity: 0, y: 10, scale: 0.985 }}
                              animate={{ opacity: 1, y: 0, scale: 1 }}
                              exit={{ opacity: 0, y: -8, scale: 0.98 }}
                              transition={SNAPPY}
                            >
                              <div className="permission-card-header">
                                <strong>{permission.toolName}</strong>
                                {typeof countdown === 'number' && (
                                  <span
                                    className={`permission-countdown${countdownCritical ? ' critical' : ''}`}
                                    title="Auto-denied if no response within 30 seconds"
                                  >
                                    {countdown}s
                                  </span>
                                )}
                              </div>
                              <p>{permission.description || 'Awaiting your decision.'}</p>
                              {permission.input && Object.keys(permission.input).length > 0 && (
                                <details className="permission-input-details">
                                  <summary>Input details</summary>
                                  <pre className="permission-input-code">{JSON.stringify(permission.input, null, 2)}</pre>
                                </details>
                              )}
                              <div className="permission-actions">
                                <button
                                  className="primary-button"
                                  onClick={() => void handlePermission(permission.requestId, 'allow')}
                                >
                                  Allow once
                                </button>
                                <button
                                  className="ghost-button"
                                  onClick={() => void handlePermission(permission.requestId, 'allow', true)}
                                  title="Always allow this tool with this exact input"
                                >
                                  Allow always
                                </button>
                                <button
                                  className="ghost-button danger"
                                  onClick={() => void handlePermission(permission.requestId, 'deny')}
                                >
                                  Deny
                                </button>
                                <button
                                  className="ghost-button danger"
                                  onClick={() => void handlePermission(permission.requestId, 'deny', true)}
                                  title="Always deny this tool with this exact input"
                                >
                                  Deny always
                                </button>
                              </div>
                            </motion.div>
                          )
                        })}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/*
                   * Bottom dock wrapper — position:relative so the companion
                   * window can use absolute satellite positioning.
                   */}
                  <div
                    className={`composer-band ${!transcriptAttached ? 'detached' : ''}`}
                    style={{ position: 'relative' }}
                  >
                    {/* Chat bar — 75ch anchor, strict agentic proportions */}
                    <div className="bottom-dock-inner">
                      <div className="composer-header">
                        <div>
                          <div className="eyebrow">Prompt rail</div>
                        </div>
                        <span className={`command-chip ${statusClass(runtime.tone)}`}>
                          {runtime.busy ? 'Busy' : 'Ready'}
                        </span>
                      </div>
                      <InputArea
                        value={prompt}
                        onChange={setPrompt}
                        onSubmit={() => void handleSendPrompt()}
                        onInterrupt={() =>
                          void window.jarvis.interruptSession().catch(error => {
                            setNotice(buildNotice(error))
                          })
                        }
                        thinking={runtime.busy}
                        placeholder="Send a prompt into the active Jarvis session. Ctrl/Cmd+Enter sends."
                      />
                    </div>
                  </div>
                </div>
              )}

              {activeView === 'autodream' && features && (
                <section className="feature-grid">
                  <div className="feature-card span-6">
                    <div className="eyebrow">Cadence</div>
                    <h2>{features.autoDream.ready ? 'Ready to consolidate' : 'Waiting on gates'}</h2>
                    <p>{features.autoDream.lockStatus}</p>
                  </div>
                  <div className="feature-card span-3">
                    <div className="eyebrow">Session gate</div>
                    <h2>{features.autoDream.sessionsSinceLast}</h2>
                    <p>Target: {features.autoDream.minSessions} sessions</p>
                  </div>
                  <div className="feature-card span-3">
                    <div className="eyebrow">Time gate</div>
                    <h2>{features.autoDream.minHours}h</h2>
                    <p>
                      {features.autoDream.lastConsolidatedAt
                        ? `Last pass ${formatDateTime(features.autoDream.lastConsolidatedAt)}`
                        : 'No prior pass recorded'}
                    </p>
                  </div>
                  <div className="feature-card span-12">
                    <div className="eyebrow">Dream phases</div>
                    <div className="phase-row">
                      {features.autoDream.phases.map(phase => (
                        <span key={phase} className="phase-pill">
                          {phase}
                        </span>
                      ))}
                    </div>
                  </div>
                </section>
              )}

              {activeView === 'memory' && features && (
                <section className="feature-grid">
                  <div className="feature-card span-4">
                    <div className="eyebrow">Entrypoint</div>
                    <h2>MEMORY.md</h2>
                    <p>{features.memory.entrypointPath}</p>
                  </div>
                  <div className="feature-card span-4">
                    <div className="eyebrow">Indexed lines</div>
                    <h2>{features.memory.lineCount}</h2>
                    <p>Preview limit {features.memory.maxLines} lines</p>
                  </div>
                  <div className="feature-card span-4">
                    <div className="eyebrow">Status</div>
                    <h2>{features.memory.enabled ? 'Enabled' : 'Disabled'}</h2>
                    <p>Skeptical memory discipline is still enforced.</p>
                  </div>
                  <div className="feature-card span-8">
                    <div className="eyebrow">Preview</div>
                    <pre className="memory-preview">
                      {features.memory.preview.join('\n')}
                    </pre>
                  </div>
                  <div className="feature-card span-4">
                    <div className="eyebrow">Rules</div>
                    <ul className="bullet-list">
                      {features.memory.rules.map(rule => (
                        <li key={rule}>{rule}</li>
                      ))}
                    </ul>
                  </div>
                </section>
              )}

              {activeView === 'integrations' && (
                <section className="integration-shell">
                  <div className="integration-toolbar">
                    <input
                      value={integrationSearch}
                      onChange={event => setIntegrationSearch(event.target.value)}
                      placeholder="Search integrations"
                    />
                    <div className="segmented-control">
                      {(['all', 'ready', 'draft', 'paused'] as const).map(filter => (
                        <button
                          key={filter}
                          className={integrationStatusFilter === filter ? 'active' : ''}
                          onClick={() => setIntegrationStatusFilter(filter)}
                        >
                          {titleCase(filter)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="integration-grid">
                    <div className="feature-card">
                      <div className="eyebrow">Registry</div>
                      <div className="integration-list">
                        {filteredIntegrations.map(entry => (
                          <button
                            key={entry.id}
                            className={`integration-row ${shell.uiState.selectedIntegrationId === entry.id ? 'active' : ''}`}
                            onClick={() => {
                              const nextShell = {
                                ...shell,
                                uiState: {
                                  ...shell.uiState,
                                  selectedIntegrationId: entry.id,
                                },
                              }
                              setShell(nextShell)
                              void persistShell(nextShell)
                            }}
                          >
                            <strong>{entry.name}</strong>
                            <span>{entry.category}</span>
                            <span>{entry.status}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="feature-card">
                      <div className="eyebrow">Editor</div>
                      <div className="form-grid">
                        <label>
                          Name
                          <input
                            value={integrationForm.name}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                name: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label>
                          Category
                          <input
                            value={integrationForm.category}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                category: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label className="span-2">
                          Base URL
                          <input
                            value={integrationForm.baseUrl}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                baseUrl: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label>
                          Auth
                          <select
                            value={integrationForm.authMode}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                authMode: event.target.value,
                              }))
                            }
                          >
                            <option value="none">None</option>
                            <option value="bearer">Bearer</option>
                            <option value="api-key">API key</option>
                            <option value="basic">Basic</option>
                          </select>
                        </label>
                        <label>
                          Status
                          <select
                            value={integrationForm.status}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                status: event.target.value,
                              }))
                            }
                          >
                            <option value="draft">Draft</option>
                            <option value="ready">Ready</option>
                            <option value="paused">Paused</option>
                          </select>
                        </label>
                        <label className="span-2">
                          Tags
                          <input
                            value={integrationForm.tags}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                tags: event.target.value,
                              }))
                            }
                          />
                        </label>
                        <label className="span-2">
                          Notes
                          <textarea
                            value={integrationForm.notes}
                            onChange={event =>
                              setIntegrationForm(current => ({
                                ...current,
                                notes: event.target.value,
                              }))
                            }
                          />
                        </label>
                      </div>
                      <div className="panel-actions">
                        <button className="primary-button" onClick={() => void saveIntegration()}>
                          Save integration
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() => {
                            const nextShell = {
                              ...shell,
                              uiState: {
                                ...shell.uiState,
                                selectedIntegrationId: null,
                              },
                            }
                            setShell(nextShell)
                            void persistShell(nextShell)
                          }}
                        >
                          New entry
                        </button>
                        <button className="ghost-button danger" onClick={() => void deleteIntegration()}>
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              )}

              {activeView === 'companion' && features && (
                <CompanionTab
                  buddy={features.buddy ?? null}
                  buddyEditor={buddyEditor}
                  setBuddyEditor={setBuddyEditor}
                  selectedBuddyId={selectedBuddyId}
                  onSelectBuddy={handleSelectBuddy}
                  onCreateBuddy={handleCreateBuddy}
                  onUpdateBuddy={handleUpdateBuddy}
                  onDeleteBuddy={handleDeleteBuddy}
                  onAction={handleCompanionAction}
                />
              )}
            </section>

            <motion.aside
              className="context-rail"
              layout
              initial={{ opacity: 0, x: 14 }}
              animate={{ opacity: 1, x: 0 }}
              transition={GENTLE}
            >
              <motion.div className="rail-card" layout transition={GENTLE}>
                <div className="eyebrow">Runtime</div>
                <h3>{runtime.running ? 'Session live' : 'Ready state'}</h3>
                <p>{runtime.label}</p>
                <div className="rail-list">
                  <div>
                    <span>Backend</span>
                    <strong>{config.backend}</strong>
                  </div>
                  <div>
                    <span>Model</span>
                    <strong>{runtime.model || config.remoteGlmModel || 'Unassigned'}</strong>
                  </div>
                  <div>
                    <span>Worker URL</span>
                    <strong>{backendState.url || 'Starting'}</strong>
                  </div>
                </div>
              </motion.div>

              {/* Floating companion speech bubble — appears above the dock when reaction is set */}
              <AnimatePresence>
                {activeBuddy?.reaction && !activeBuddy.muted && (
                  <motion.div
                    key={activeBuddy.reaction}
                    initial={{ opacity: 0, y: 10, scale: 0.9 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 6, scale: 0.94 }}
                    transition={SNAPPY}
                    style={{
                      padding: '10px 14px',
                      borderRadius: '14px 14px 4px 14px',
                      border: '1px solid rgba(0,229,255,0.28)',
                      background: 'rgba(10,11,15,0.94)',
                      backdropFilter: 'blur(14px)',
                      color: 'var(--text)',
                      fontSize: 13,
                      lineHeight: 1.5,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.4), 0 0 16px rgba(0,229,255,0.08)',
                      flexShrink: 0,
                    }}
                  >
                    <div style={{ fontSize: 10, color: 'var(--accent-strong)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4, fontFamily: '"DM Sans", sans-serif' }}>
                      {activeBuddy.name || 'Companion'}
                    </div>
                    {activeBuddy.reaction}
                  </motion.div>
                )}
              </AnimatePresence>

              <CompanionDock
                buddy={features?.buddy ?? null}
                loading={!features}
                onAction={action => void handleCompanionAction(action)}
                onOpenStudio={() => openView('companion')}
                onSelectProfile={profile => void handleSelectBuddy(profile)}
                modelBadge={config.backend === 'remote-glm' && runtime.running}
              />
            </motion.aside>
          </div>
        </main>
      </div>

      <Slideover
        side="right"
        width="min(440px, calc(100vw - 48px))"
        open={settingsOpen}
        onClose={() => toggleSettings(false)}
        onEdgeOpen={() => toggleSettings(true)}
        className="settings-drawer-panel"
      >
        <div className="settings-header">
          <div>
            <div className="eyebrow">Connection controls</div>
            <h2>Jarvis settings</h2>
          </div>
        </div>
        <div className="settings-body">
          <div className="segmented-control">
            <button
              className={config.backend === 'remote-glm' ? 'active' : ''}
              onClick={() => setConfig(current => ({ ...current, backend: 'remote-glm' }))}
            >
              Remote
            </button>
            <button
              className={config.backend === 'ollama' ? 'active' : ''}
              onClick={() => setConfig(current => ({ ...current, backend: 'ollama' }))}
            >
              Local
            </button>
            <button
              className={config.backend === 'anthropic' ? 'active' : ''}
              onClick={() => setConfig(current => ({ ...current, backend: 'anthropic' }))}
            >
              Anthropic
            </button>
          </div>

          <div className="drawer-form">
            <label>
              Workspace path
              <input
                value={config.workspacePath}
                onChange={event =>
                  setConfig(current => ({ ...current, workspacePath: event.target.value }))
                }
              />
            </label>

            {config.backend === 'remote-glm' && (
              <>
                <label>
                  Bridge URL
                  <input
                    value={config.remoteGlmBaseUrl}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        remoteGlmBaseUrl: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  API key
                  <input
                    type="password"
                    value={config.remoteGlmApiKey}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        remoteGlmApiKey: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Lane
                  <select
                    value={config.remoteGlmModel}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        remoteGlmModel: event.target.value,
                      }))
                    }
                  >
                    <option value="gpt-oss-auto">Auto</option>
                    <option value="gpt-oss-120b">120B</option>
                    <option value="gpt-oss-20b">20B</option>
                  </select>
                </label>
              </>
            )}

            {config.backend === 'ollama' && (
              <>
                <label>
                  Ollama base URL
                  <input
                    value={config.ollamaBaseUrl}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        ollamaBaseUrl: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Local runtime engine
                  <select
                    value={config.localRuntimeEngine}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        localRuntimeEngine: event.target.value as LauncherConfig['localRuntimeEngine'],
                      }))
                    }
                  >
                    <option value="shared-runtime">Shared Claude runtime</option>
                    <option value="legacy-inprocess">Legacy in-process Jarvis loop</option>
                  </select>
                </label>
                <label>
                  Local model
                  <input
                    value={config.ollamaModel}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        ollamaModel: event.target.value,
                      }))
                    }
                  />
                </label>
              </>
            )}

            {config.backend === 'anthropic' && (
              <>
                <label>
                  Base URL
                  <input
                    value={config.anthropicBaseUrl}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        anthropicBaseUrl: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  API key
                  <input
                    type="password"
                    value={config.anthropicApiKey}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        anthropicApiKey: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  Model
                  <input
                    value={config.anthropicModel}
                    onChange={event =>
                      setConfig(current => ({
                        ...current,
                        anthropicModel: event.target.value,
                      }))
                    }
                  />
                </label>
              </>
            )}

            <label className="toggle-field">
              <input
                type="checkbox"
                checked={config.coordinatorMode}
                onChange={event =>
                  setConfig(current => ({
                    ...current,
                    coordinatorMode: event.target.checked,
                  }))
                }
              />
              <span>Enable coordinator mode</span>
            </label>
            <label className="toggle-field">
              <input
                type="checkbox"
                checked={config.disableThinkingForLocal}
                onChange={event =>
                  setConfig(current => ({
                    ...current,
                    disableThinkingForLocal: event.target.checked,
                  }))
                }
              />
              <span>
                Disable thinking for local {config.localRuntimeEngine === 'shared-runtime' ? 'runtime' : 'fallback'}
              </span>
            </label>
            <label>
              Appended system prompt
              <textarea
                value={config.appendSystemPrompt}
                onChange={event =>
                  setConfig(current => ({
                    ...current,
                    appendSystemPrompt: event.target.value,
                  }))
                }
              />
            </label>
          </div>
        </div>
          {/* ── WSL2 Sandbox ───────────────────────────────────────────────── */}
          <div className="settings-section">
            <div className="eyebrow">Security</div>
            <label className="toggle-field">
              <input
                id="setting-use-sandbox"
                type="checkbox"
                checked={config.useSandbox ?? false}
                onChange={event =>
                  setConfig(current => ({
                    ...current,
                    useSandbox: event.target.checked,
                  }))
                }
              />
              <span>
                WSL2 sandbox{' '}
                <span style={{ opacity: 0.6, fontSize: '0.8em' }}>
                  (run CLI inside WSL2 for bubblewrap isolation)
                </span>
              </span>
            </label>
            {(config.useSandbox || wsl2Sandbox) && (
              <div
                style={{
                  marginTop: 6,
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: wsl2Sandbox?.available ? 'rgba(80,200,120,0.12)' : 'rgba(255,180,0,0.12)',
                  fontSize: '0.83em',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span>
                  {wsl2Sandbox?.available
                    ? `✅ Ready — distro: ${wsl2Sandbox.distro ?? 'auto'}`
                    : `⚠ ${wsl2Sandbox?.reason ?? 'Checking WSL2 availability…'}`}
                </span>
                <button
                  className="ghost-button"
                  style={{ padding: '2px 8px', fontSize: '0.85em' }}
                  onClick={async () => {
                    const result = await window.jarvis.getSandboxStatus().catch(() => null)
                    if (result?.wsl2Sandbox) setWsl2Sandbox(result.wsl2Sandbox)
                  }}
                >
                  Re-check
                </button>
              </div>
            )}
            {config.useSandbox && (
              <label>
                WSL2 distro{' '}
                <span style={{ opacity: 0.6 }}>(blank = auto-detect)</span>
                <input
                  id="setting-wsl-distro"
                  type="text"
                  placeholder="Ubuntu"
                  value={config.wslDistro ?? ''}
                  onChange={event =>
                    setConfig(current => ({
                      ...current,
                      wslDistro: event.target.value,
                    }))
                  }
                />
              </label>
            )}
          </div>

        <div className="settings-footer">
          <button className="ghost-button" onClick={() => void handleCheckRemoteHealth()}>
            Check server
          </button>
          <button className="primary-button" onClick={() => void handleSaveConfig()}>
            Save settings
          </button>
        </div>
      </Slideover>

      {notice && (
        <div className={`notice-bar ${statusClass(notice.tone)}`}>
          <span>{notice.message}</span>
          <button onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <AgentStatusBar />

      <div
        style={{
          position: 'fixed',
          left: '50%',
          bottom: 64,
          transform: 'translateX(-50%)',
          width: 'min(640px, calc(100vw - 80px))',
          zIndex: 220,
          pointerEvents: 'auto',
        }}
      >
        <VerificationHold onDecision={handleVerificationDecision} />
      </div>

      {driveWizardOpen && driveSteps.length > 0 && (
        <DriveSetupWizard
          steps={driveSteps}
          onComplete={() => {
            setDriveWizardOpen(false)
            setDriveSetupComplete(true)
            setNotice({ tone: 'idle', message: 'Google Drive connected. Jarvis cloud brain is active.' })
          }}
          onDismiss={() => setDriveWizardOpen(false)}
        />
      )}
    </div>
    </>
  )
}
