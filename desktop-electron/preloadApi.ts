import type { LauncherConfig } from '../desktop-app/config.js'
import type {
  DesktopBuddyProfile,
  DesktopBuddyProfileDraft,
  DesktopEvent,
  DesktopFeatureSnapshot,
  DesktopRuntimeState,
  DesktopShellPayload,
  ModelCatalogResponse,
  PendingPermission,
  RemoteBridgeHealth,
  SnapshotEvent,
} from '../desktop-app/types.js'
import type {
  ThunderSessionDetectedPayload,
  ThunderStepUpdatePayload,
  ThunderLogStreamPayload,
  ThunderStepId,
} from './thunder/thunderTypes.js'

export type JarvisBootstrapPayload = {
  config: LauncherConfig
  shell: DesktopShellPayload
  features: DesktopFeatureSnapshot
  models: ModelCatalogResponse
}

export type JarvisCompanionPayload = {
  ok: boolean
  activeProfileId: string | null
  profiles: DesktopBuddyProfile[]
  buddy: DesktopFeatureSnapshot['buddy']
  features: DesktopFeatureSnapshot
}

export type JarvisBridge = {
  bootstrap(): Promise<JarvisBootstrapPayload>
  getConfig(): Promise<LauncherConfig>
  saveConfig(config: Partial<LauncherConfig>): Promise<LauncherConfig>
  getShell(): Promise<DesktopShellPayload>
  saveShell(shell: Partial<DesktopShellPayload>): Promise<DesktopShellPayload>
  getFeatures(): Promise<DesktopFeatureSnapshot>
  getModels(): Promise<ModelCatalogResponse>
  checkRemoteHealth(config?: Partial<LauncherConfig>): Promise<RemoteBridgeHealth>
  startSession(
    config?: Partial<LauncherConfig>,
    options?: { launchIntroPrompt?: string },
  ): Promise<void>
  sendPrompt(content: string): Promise<unknown>
  interruptSession(): Promise<void>
  stopSession(): Promise<void>
  clearTranscript(options?: { silent?: boolean }): Promise<void>
  respondToPermission(
    requestId: string,
    decision: 'allow' | 'deny',
    permanent?: boolean,
  ): Promise<void>
  getSandboxStatus(): Promise<{
    wsl2Sandbox: { available: boolean; distro?: string; reason?: string }
  }>

  listCompanionProfiles(): Promise<JarvisCompanionPayload>
  runCompanionAction(
    action: 'hatch' | 'rehatch' | 'pet' | 'mute' | 'unmute' | 'reset',
  ): Promise<JarvisCompanionPayload>
  createCompanionProfile(
    profile?: Partial<DesktopBuddyProfileDraft>,
  ): Promise<JarvisCompanionPayload>
  updateCompanionProfile(
    profileId: string,
    profile: Partial<DesktopBuddyProfileDraft>,
  ): Promise<JarvisCompanionPayload>
  selectCompanionProfile(profileId: string): Promise<JarvisCompanionPayload>
  deleteCompanionProfile(profileId: string): Promise<JarvisCompanionPayload>
  onEvent(
    listener: (event: SnapshotEvent | DesktopEvent) => void,
  ): () => void
  onBackendState(
    listener: (state: { ready: boolean; url: string | null; error?: string }) => void,
  ): () => void
  getPlatform(): Promise<string>
  minimizeWindow(): Promise<void>
  maximizeWindow(): Promise<void>
  closeWindow(): Promise<void>

  // Drive setup wizard
  getDriveStatus(): Promise<{
    state: string
    setupComplete: boolean
    folderIds: Record<string, string> | null
    steps: Array<{
      stepIndex: number
      total: number
      title: string
      instruction: string
      requiresUserAction: boolean
      actionLabel?: string
    }>
  }>
  saveDriveCredentials(credentialsPath: string): Promise<{ ok: boolean }>
  authorizeDrive(): Promise<{ ok: boolean; folderIds?: Record<string, string> }>

  // Thunder Compute
  thunderOpenTerminal(): Promise<{ ok: boolean }>
  thunderBeginAutomation(
    instanceId: string,
    bridgeApiKey: string,
  ): Promise<{ ok: boolean; publicUrl?: string; instanceId?: string; error?: string }>
  thunderAbortAutomation(): Promise<{ ok: boolean }>
  thunderHealthCheck(
    publicUrl: string,
    apiKey: string,
  ): Promise<{ ok: boolean }>
  thunderCheckSession(
    instanceId: string,
  ): Promise<{ running: boolean; instanceId: string | null }>
  thunderForwardPort(
    instanceId: string,
  ): Promise<{ ok: boolean; publicUrl?: string; error?: string }>
  thunderGetSteps(): Promise<Array<{ id: ThunderStepId; label: string }>>
  // V2 snapshot-driven pathway
  thunderStartSession(
    bridgeApiKey: string,
    snapshotName?: string,
  ): Promise<{ ok: boolean; publicUrl?: string; instanceId?: string; error?: string }>
  thunderGetStepsV2(): Promise<Array<{ id: ThunderStepId; label: string }>>
  // V2 attach — reconnect to an already-running instance (skips create + wait)
  thunderAttachInstance(
    instanceId: string,
    bridgeApiKey: string,
  ): Promise<{ ok: boolean; publicUrl?: string; instanceId?: string; error?: string }>
  thunderGetStepsV2Attach(): Promise<Array<{ id: ThunderStepId; label: string }>>
  onThunderSessionDetected(
    listener: (payload: ThunderSessionDetectedPayload) => void,
  ): () => void
  onThunderStepUpdate(
    listener: (payload: ThunderStepUpdatePayload) => void,
  ): () => void
  onThunderLogStream(
    listener: (payload: ThunderLogStreamPayload) => void,
  ): () => void
}

export type JarvisRendererSnapshot = {
  runtime: DesktopRuntimeState
  pendingPermissions: PendingPermission[]
  events: DesktopEvent[]
}
