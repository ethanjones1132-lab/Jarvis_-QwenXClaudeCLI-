import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getConfigPath } from './config.js'
import {
  createIdleRuntimeState,
  type DesktopEvent,
  type DesktopRuntimeState,
  type DesktopUiState,
  type IntegrationRegistryEntry,
  type LocalChatMessage,
  type PendingPermission,
} from './types.js'

const STATE_VERSION = 2
const MAX_EVENTS = 300
const MAX_LOCAL_HISTORY = 24

export type PersistedLauncherState = {
  version: number
  runtimeState: DesktopRuntimeState
  uiState: DesktopUiState
  recentEvents: DesktopEvent[]
  pendingPermissions: PendingPermission[]
  lastLocalHistory: LocalChatMessage[]
  lastLocalSummary: string
  integrations: IntegrationRegistryEntry[]
}

export function getLauncherStatePath(): string {
  return join(dirname(getConfigPath()), 'launcher-state.json')
}

export function getDefaultPersistedLauncherState(
  workspacePath: string,
): PersistedLauncherState {
  return {
    version: STATE_VERSION,
    runtimeState: createIdleRuntimeState(workspacePath),
    uiState: {
      activeView: 'chat',
      advancedSettingsOpen: false,
      selectedIntegrationId: null,
    },
    recentEvents: [],
    pendingPermissions: [],
    lastLocalHistory: [],
    lastLocalSummary: '',
    integrations: [],
  }
}

function clampEvents(events: unknown): DesktopEvent[] {
  if (!Array.isArray(events)) {
    return []
  }
  return events.slice(-MAX_EVENTS) as DesktopEvent[]
}

function clampPermissions(permissions: unknown): PendingPermission[] {
  if (!Array.isArray(permissions)) {
    return []
  }
  return permissions as PendingPermission[]
}

function clampLocalHistory(history: unknown): LocalChatMessage[] {
  if (!Array.isArray(history)) {
    return []
  }
  return history.slice(-MAX_LOCAL_HISTORY) as LocalChatMessage[]
}

function clampUiState(value: unknown): DesktopUiState {
  if (!value || typeof value !== 'object') {
    return {
      activeView: 'chat',
      advancedSettingsOpen: false,
      selectedIntegrationId: null,
    }
  }

  const candidate = value as Partial<DesktopUiState>
  const activeView =
    candidate.activeView === 'autodream' ||
    candidate.activeView === 'memory' ||
    candidate.activeView === 'integrations' ||
    candidate.activeView === 'companion'
      ? candidate.activeView
      : 'chat'

  return {
    activeView,
    advancedSettingsOpen: Boolean(candidate.advancedSettingsOpen),
    selectedIntegrationId:
      typeof candidate.selectedIntegrationId === 'string'
        ? candidate.selectedIntegrationId
        : null,
  }
}

function clampIntegrations(value: unknown): IntegrationRegistryEntry[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter(
      (entry): entry is Partial<IntegrationRegistryEntry> =>
        Boolean(entry) && typeof entry === 'object',
    )
    .map(entry => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      category: typeof entry.category === 'string' ? entry.category : 'General',
      baseUrl: typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
      authMode:
        entry.authMode === 'bearer' ||
        entry.authMode === 'api-key' ||
        entry.authMode === 'basic'
          ? entry.authMode
          : 'none',
      status:
        entry.status === 'ready' || entry.status === 'paused'
          ? entry.status
          : 'draft',
      notes: typeof entry.notes === 'string' ? entry.notes : '',
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((tag): tag is string => typeof tag === 'string')
        : [],
      updatedAt:
        typeof entry.updatedAt === 'string'
          ? entry.updatedAt
          : new Date().toISOString(),
    }))
    .filter(entry => entry.id && entry.name)
}

export async function loadPersistedLauncherState(
  workspacePath: string,
): Promise<PersistedLauncherState> {
  const defaults = getDefaultPersistedLauncherState(workspacePath)
  try {
    const raw = await readFile(getLauncherStatePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PersistedLauncherState>
    const runtimeState: DesktopRuntimeState = {
      ...defaults.runtimeState,
      ...(parsed.runtimeState ?? {}),
      running: false,
      busy: false,
      tone:
        parsed.runtimeState?.running || parsed.runtimeState?.busy
          ? 'warning'
          : (parsed.runtimeState?.tone ?? defaults.runtimeState.tone),
      label:
        parsed.runtimeState?.running || parsed.runtimeState?.busy
          ? 'Recovered previous launcher transcript. Launch a new session to continue.'
          : (parsed.runtimeState?.label ?? defaults.runtimeState.label),
      workspacePath:
        parsed.runtimeState?.workspacePath?.trim() || defaults.runtimeState.workspacePath,
      sessionId: null,
    }

    return {
      version:
        typeof parsed.version === 'number' ? parsed.version : defaults.version,
      runtimeState,
      uiState: clampUiState(parsed.uiState),
      recentEvents: clampEvents(parsed.recentEvents),
      pendingPermissions: clampPermissions(parsed.pendingPermissions),
      lastLocalHistory: clampLocalHistory(parsed.lastLocalHistory),
      lastLocalSummary:
        typeof parsed.lastLocalSummary === 'string'
          ? parsed.lastLocalSummary
          : defaults.lastLocalSummary,
      integrations: clampIntegrations(parsed.integrations),
    }
  } catch {
    return defaults
  }
}

export async function savePersistedLauncherState(
  state: PersistedLauncherState,
): Promise<void> {
  await mkdir(dirname(getLauncherStatePath()), { recursive: true })
  await writeFile(
    getLauncherStatePath(),
    JSON.stringify(
      {
        ...state,
        version: STATE_VERSION,
        recentEvents: state.recentEvents.slice(-MAX_EVENTS),
        lastLocalHistory: state.lastLocalHistory.slice(-MAX_LOCAL_HISTORY),
      },
      null,
      2,
    ),
    'utf8',
  )
}
