import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  ALTERNATE_OLLAMA_MODEL,
  DEFAULT_OLLAMA_MODEL,
  REMOVED_OLLAMA_MODELS,
} from './modelProfiles.js'

export type BackendType = 'anthropic' | 'ollama' | 'remote-glm'
export type LocalRuntimeEngine = 'shared-runtime' | 'legacy-inprocess'
export const SHARED_RUNTIME_DEFAULT_MIGRATION = 'shared-runtime-default-v1'

// -- Google Drive cloud-brain configuration ---------------------------------
export type DriveConfig = {
  // Path to the downloaded Google OAuth credentials JSON from Cloud Console
  credentialsPath: string
  // Stored after first OAuth flow - refresh token kept here
  tokenPath: string
  // Drive folder IDs populated on first run by the setup wizard
  folderIds: {
    root: string           // AgentMemory/
    core: string           // AgentMemory/core/
    reasoning: string      // AgentMemory/reasoning/
    chains: string         // AgentMemory/reasoning/chains/
    failures: string       // AgentMemory/reasoning/failures/
    fewShots: string       // AgentMemory/reasoning/few_shots/
    categories: string     // AgentMemory/categories/
    sessions: string       // AgentMemory/sessions/
    adapters: string       // AgentMemory/adapters/
  } | null
  // Whether the full Drive setup wizard has been completed
  setupComplete: boolean
  // Embedding model to use via Ollama embeddings API (CPU, zero VRAM)
  embeddingModel: string
}

// -- VRAM-optimized Ollama inference options --------------------------------
export type OllamaVramOptions = {
  // Hard cap on active context tokens - prevents KV-cache OOM on 8 GB cards
  numCtx: number
  // Flash attention reduces KV-cache VRAM by ~30 %
  flashAttention: boolean
  // Quantized KV cache halves KV VRAM vs fp16
  kvCacheType: 'q8_0' | 'q4_0' | 'f16'
  // Max tokens to generate per response
  numPredict: number
  // Temperature - low for tool calls, slightly higher for chat
  temperature: number
}

export type LauncherConfig = {
  workspacePath: string
  backend: BackendType
  anthropicApiKey: string
  anthropicBaseUrl: string
  anthropicModel: string
  ollamaBaseUrl: string
  ollamaModel: string
  localRuntimeEngine: LocalRuntimeEngine
  remoteGlmBaseUrl: string
  remoteGlmApiKey: string
  remoteGlmModel: string
  coordinatorMode: boolean
  disableToolsForLocal: boolean
  enableExperimentalLocalTools: boolean
  disableNonessentialTraffic: boolean
  disableThinkingForLocal: boolean
  appendSystemPrompt: string
  thunderInstanceId: string
  thunderPublicUrl: string
  thunderSessionActive: boolean
  // -- Cloud Brain (Google Drive) -------------------------------------------
  drive: DriveConfig
  // -- Agentic local mode ----------------------------------------------------
  // When true the local Ollama session runs the full ReAct agent loop with
  // tool calling, experience replay, and Drive context injection instead of
  // the simple chat-only safe-mode path.
  enableAgenticLocalMode: boolean
  ollamaVram: OllamaVramOptions
  /** Optional Brave Search API key - enables real web search results.
   *  Free tier: 2000 queries/month at https://api.search.brave.com
   *  Falls back to SearXNG public instances if not set. */
  braveSearchApiKey: string
  // -- WSL2 Sandbox ----------------------------------------------------------
  /** When true the CLI child process is spawned inside WSL2 so that
   *  bubblewrap (bwrap) sandboxing is available on Windows hosts. */
  useSandbox: boolean
  /** Preferred WSL2 distro name. Leave empty to auto-detect. */
  wslDistro: string
  /** One-time migration marker to force shared runtime defaults. */
  sharedRuntimeDefaultMigration: string | null
}

function getConfigDir(): string {
  const appData =
    process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'ClaudeBodyDesktop')
}

export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json')
}

function getDefaultDriveConfig(): DriveConfig {
  const configDir = getConfigDir()
  return {
    credentialsPath: join(configDir, 'google_credentials.json'),
    tokenPath: join(configDir, 'google_token.json'),
    folderIds: null,
    setupComplete: false,
    embeddingModel: 'nomic-embed-text',
  }
}

function getDefaultOllamaVram(): OllamaVramOptions {
  return {
    // 8 192 tokens - safe ceiling for 8 GB VRAM with Q4_K_M + quantized KV cache
    numCtx: 8192,
    flashAttention: true,
    kvCacheType: 'q8_0',
    numPredict: 1024,
    temperature: 0.1,
  }
}

function normalizeLocalRuntimeEngine(
  value: unknown,
  fallback: LocalRuntimeEngine,
): LocalRuntimeEngine {
  return value === 'legacy-inprocess' || value === 'shared-runtime'
    ? value
    : fallback
}

export function getDefaultConfig(workspacePath: string): LauncherConfig {
  return {
    workspacePath,
    backend: 'ollama',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL ?? '',
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-3-7-sonnet-20250219',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
    ollamaModel:
      process.env.OLLAMA_MODEL &&
      !REMOVED_OLLAMA_MODELS.includes(process.env.OLLAMA_MODEL as any)
        ? process.env.OLLAMA_MODEL
        : DEFAULT_OLLAMA_MODEL,
    localRuntimeEngine: 'shared-runtime',
    remoteGlmBaseUrl:
      process.env.GPT_OSS_BRIDGE_URL ??
      process.env.REMOTE_OSS_BASE_URL ??
      process.env.REMOTE_GLM_BASE_URL ??
      '',
    remoteGlmApiKey:
      process.env.GPT_OSS_BRIDGE_API_KEY ??
      process.env.REMOTE_OSS_API_KEY ??
      process.env.REMOTE_GLM_API_KEY ??
      '',
    remoteGlmModel:
      process.env.GPT_OSS_MODEL ??
      process.env.REMOTE_OSS_MODEL ??
      process.env.REMOTE_GLM_MODEL ??
      'gpt-oss-auto',
    coordinatorMode: false,
    disableToolsForLocal: true,
    enableExperimentalLocalTools: false,
    disableNonessentialTraffic: true,
    disableThinkingForLocal: true,
    appendSystemPrompt: '',
    thunderInstanceId: '',
    thunderPublicUrl: '',
    thunderSessionActive: false,
    drive: getDefaultDriveConfig(),
    enableAgenticLocalMode: true,
    ollamaVram: getDefaultOllamaVram(),
    braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY ?? '',
    useSandbox: false,
    wslDistro: '',
    sharedRuntimeDefaultMigration: SHARED_RUNTIME_DEFAULT_MIGRATION,
  }
}

export async function loadLauncherConfig(
  workspacePath: string,
): Promise<LauncherConfig> {
  const defaults = getDefaultConfig(workspacePath)
  try {
    const raw = await readFile(getConfigPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<LauncherConfig>
    const parsedBackend = parsed.backend ?? defaults.backend
    const parsedEngine = normalizeLocalRuntimeEngine(
      parsed.localRuntimeEngine,
      defaults.localRuntimeEngine,
    )
    const migrationMarker =
      typeof parsed.sharedRuntimeDefaultMigration === 'string' &&
      parsed.sharedRuntimeDefaultMigration.trim().length > 0
        ? parsed.sharedRuntimeDefaultMigration
        : null
    const shouldApplySharedRuntimeDefaults =
      migrationMarker !== SHARED_RUNTIME_DEFAULT_MIGRATION
    const merged: LauncherConfig = {
      ...defaults,
      ...parsed,
      workspacePath: parsed.workspacePath?.trim() || defaults.workspacePath,
      anthropicApiKey: parsed.anthropicApiKey ?? defaults.anthropicApiKey,
      anthropicBaseUrl: parsed.anthropicBaseUrl ?? defaults.anthropicBaseUrl,
      anthropicModel: parsed.anthropicModel ?? defaults.anthropicModel,
      ollamaBaseUrl: parsed.ollamaBaseUrl ?? defaults.ollamaBaseUrl,
      ollamaModel:
        !parsed.ollamaModel ||
        REMOVED_OLLAMA_MODELS.includes(parsed.ollamaModel as any)
          ? defaults.ollamaModel || ALTERNATE_OLLAMA_MODEL
          : parsed.ollamaModel,
      localRuntimeEngine: parsedEngine,
        // Migrate persisted 'shared-runtime' for ollama → 'legacy-inprocess'.
      remoteGlmBaseUrl: parsed.remoteGlmBaseUrl ?? defaults.remoteGlmBaseUrl,
      remoteGlmApiKey: parsed.remoteGlmApiKey ?? defaults.remoteGlmApiKey,
      remoteGlmModel: parsed.remoteGlmModel ?? defaults.remoteGlmModel,
      appendSystemPrompt:
        parsed.appendSystemPrompt ?? defaults.appendSystemPrompt,
      thunderInstanceId: parsed.thunderInstanceId ?? defaults.thunderInstanceId,
      thunderPublicUrl: parsed.thunderPublicUrl ?? defaults.thunderPublicUrl,
      thunderSessionActive:
        parsed.thunderSessionActive ?? defaults.thunderSessionActive,
      drive: {
        ...defaults.drive,
        ...(parsed.drive ?? {}),
        folderIds: parsed.drive?.folderIds ?? defaults.drive.folderIds,
        setupComplete: parsed.drive?.setupComplete ?? defaults.drive.setupComplete,
      },
      enableAgenticLocalMode:
        parsed.enableAgenticLocalMode ?? defaults.enableAgenticLocalMode,
      braveSearchApiKey: parsed.braveSearchApiKey ?? defaults.braveSearchApiKey,
      ollamaVram: {
        ...defaults.ollamaVram,
        ...(parsed.ollamaVram ?? {}),
      },
      useSandbox: parsed.useSandbox ?? defaults.useSandbox,
      wslDistro: parsed.wslDistro ?? defaults.wslDistro,
      sharedRuntimeDefaultMigration: migrationMarker,
    }
    merged.backend = shouldApplySharedRuntimeDefaults ? 'ollama' : parsedBackend
    merged.localRuntimeEngine = shouldApplySharedRuntimeDefaults
      ? 'shared-runtime'
      : parsedEngine
    merged.sharedRuntimeDefaultMigration = shouldApplySharedRuntimeDefaults
      ? SHARED_RUNTIME_DEFAULT_MIGRATION
      : migrationMarker ?? defaults.sharedRuntimeDefaultMigration

    if (shouldApplySharedRuntimeDefaults) {
      await saveLauncherConfig(merged)
    }
    return merged
  } catch {
    return defaults
  }
}

export async function saveLauncherConfig(config: LauncherConfig): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true })
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2), 'utf8')
}
