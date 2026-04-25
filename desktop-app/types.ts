import type { BackendType } from './config.js'

export type StatusTone = 'idle' | 'running' | 'error' | 'warning'

export type RuntimeMode =
  | 'idle'
  | 'anthropic'
  | 'remote-glm'
  | 'ollama-safe'
  | 'ollama-experimental'
  | 'ollama-shared'
  | 'ollama-legacy'

export type DesktopView =
  | 'chat'
  | 'autodream'
  | 'memory'
  | 'integrations'
  | 'companion'

export type DesktopBuddyRarity =
  | 'common'
  | 'uncommon'
  | 'rare'
  | 'epic'
  | 'legendary'

export type DesktopBuddyProfileDraft = {
  name: string
  personality: string
  species: string
  eye: string
  hat: string
  shiny: boolean
  rarity: DesktopBuddyRarity
}

export type DesktopBuddyProfile = DesktopBuddyProfileDraft & {
  id: string
  createdAt: number
  updatedAt: number
  isActive: boolean
}

export type IntegrationAuthMode =
  | 'none'
  | 'bearer'
  | 'api-key'
  | 'basic'

export type IntegrationStatus = 'draft' | 'ready' | 'paused'

export type IntegrationRegistryEntry = {
  id: string
  name: string
  category: string
  baseUrl: string
  authMode: IntegrationAuthMode
  status: IntegrationStatus
  notes: string
  tags: string[]
  updatedAt: string
}

export type DesktopUiState = {
  activeView: DesktopView
  advancedSettingsOpen: boolean
  selectedIntegrationId: string | null
}

export type RemoteBridgeHealth = {
  ok: boolean
  ready: boolean
  baseUrl: string
  message: string
  checkedAt: string
  upstreams?: {
    primary?: { ok?: boolean; error?: string; model?: string }
    fast?: { ok?: boolean; error?: string; model?: string }
  }
}

export type DesktopShellPayload = {
  uiState: DesktopUiState
  integrations: IntegrationRegistryEntry[]
}

export type PendingPermission = {
  requestId: string
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  description?: string
  /** Internal: cleared when permission is resolved. NOT sent to the renderer. */
  timeoutHandle?: ReturnType<typeof setTimeout>
}

export type NormalizedJarvisEventKind =
  | 'assistant'
  | 'user'
  | 'result'
  | 'system_init'
  | 'system_status'
  | 'session_state_changed'
  | 'task_notification'
  | 'task_started'
  | 'task_progress'
  | 'task_complete'
  | 'task_interrupted'
  | 'hook_event'
  | 'post_turn_summary'
  | 'api_retry'
  | 'local_command_output'
  | 'files_persisted'
  | 'compact_boundary'
  | 'elicitation_complete'
  | 'stream_event'
  | 'tool_progress'
  | 'tool_use_summary'
  | 'auth_status'
  | 'rate_limit_event'
  | 'prompt_suggestion'
  | 'control_request'
  | 'control_response'
  | 'control_cancel_request'
  | 'keep_alive'
  | 'streamlined_text'
  | 'unknown'

export type NormalizedJarvisEventPhase = 'stream' | 'terminal' | 'event'
export type NormalizedJarvisDisplayRole = 'user' | 'assistant' | 'timeline'

export type NormalizedJarvisEvent = {
  id: string
  timestamp: number
  sessionId: string | null
  turnId: string | null
  source: 'sdk' | 'control' | 'desktop' | 'unknown'
  kind: NormalizedJarvisEventKind
  phase: NormalizedJarvisEventPhase
  displayRole: NormalizedJarvisDisplayRole
  text: string
  raw: unknown
  isTerminal: boolean
  isErrorLike: boolean
}

export type DesktopRuntimeState = {
  running: boolean
  busy: boolean
  label: string
  tone: StatusTone
  backend: BackendType | null
  mode: RuntimeMode
  model: string
  workspacePath: string
  sessionId: string | null
}

export type DesktopEvent =
  | {
      type: 'state'
      state: DesktopRuntimeState
    }
  | {
      type: 'message'
      message: unknown
      normalized?: NormalizedJarvisEvent
    }
  | {
      type: 'stderr'
      line: string
    }
  | {
      type: 'info'
      label: string
      body: string
    }
  | ({
      type: 'permission'
    } & PendingPermission)
  | {
      type: 'permission_resolved'
      requestId: string
    }

export type SnapshotEvent = {
  type: 'snapshot'
  state: DesktopRuntimeState
  pendingPermissions: PendingPermission[]
  events: DesktopEvent[]
  wsl2Sandbox?: {
    available: boolean
    distro?: string
    reason?: string
  }
}

export type LocalChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type ModelCatalogEntry = {
  id: string
  label: string
  installed: boolean
  description: string
  role: 'default' | 'alternate' | 'reasoning'
  recommendedMode: 'safe' | 'experimental'
  toolReadiness: 'ready-for-tools' | 'ready-for-chat' | 'candidate-for-tools' | 'not-recommended'
}

export type ModelCatalogResponse = {
  defaultModel: string
  alternateModel: string
  installedModels: string[]
  models: ModelCatalogEntry[]
}

export type DesktopBuddySnapshot = {
  active: boolean
  hatched: boolean
  hatchedAt: number | null
  muted: boolean
  identityBound: boolean
  identityLabel: string
  activeProfileId: string | null
  profiles: DesktopBuddyProfile[]
  name: string
  species: string
  eye: string
  hat: string
  shiny: boolean
  rarity: string
  rarityStars: string
  personality: string
  face: string
  sprite: string[]
  stats: Record<string, number>
  statDescriptions: Record<string, string>
  reaction: string | null
  availableActions: string[]
}

export type DesktopCoordinatorSnapshot = {
  available: boolean
  active: boolean
  coordinatorTools: string[]
  workerTools: string[]
  strictDelegationRules: string[]
  swarmStatus: string
}

export type DesktopAutoDreamSnapshot = {
  enabled: boolean
  ready: boolean
  minHours: number
  minSessions: number
  lastConsolidatedAt: string | null
  sessionsSinceLast: number
  phases: string[]
  lockStatus: string
}

export type DesktopMemorySnapshot = {
  enabled: boolean
  memoryDir: string
  entrypointPath: string
  lineCount: number
  maxLines: number
  preview: string[]
  previewTruncated: boolean
  rules: string[]
}

export type DesktopFeatureSnapshot = {
  buddy: DesktopBuddySnapshot
  coordinator: DesktopCoordinatorSnapshot
  autoDream: DesktopAutoDreamSnapshot
  memory: DesktopMemorySnapshot
}

export function createIdleRuntimeState(
  workspacePath: string,
): DesktopRuntimeState {
  return {
    running: false,
    busy: false,
    label: 'Idle',
    tone: 'idle',
    backend: null,
    mode: 'idle',
    model: '',
    workspacePath,
    sessionId: null,
  }
}
