import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { mkdir, readFile, writeFile, appendFile, readdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, delimiter, dirname, join, relative } from 'path'
import open from 'open'
import {
  getDefaultConfig,
  getConfigPath,
  loadLauncherConfig,
  saveLauncherConfig,
  type LauncherConfig,
} from './config.js'
import {
  createDesktopBuddyProfile,
  deleteDesktopBuddyProfile,
  getCoordinatorToolNames,
  getDesktopBuddySnapshot,
  getDesktopCompanionIntro,
  getDesktopMemoryDir,
  getDesktopMemoryEntrypoint,
  hatchDesktopCompanion,
  isAutoDreamEnabledDesktop,
  isAutoMemoryEnabledDesktop,
  listDesktopBuddyProfiles,
  listSessionsTouchedSinceDesktop,
  MAX_ENTRYPOINT_LINES,
  muteDesktopCompanion,
  petDesktopCompanion,
  rehatchDesktopCompanion,
  readLastConsolidatedAtDesktop,
  readMemoryPreview,
  resetDesktopCompanion,
  selectDesktopBuddyProfile,
  triggerSessionEventReaction,
  unmuteDesktopCompanion,
  updateDesktopBuddyProfile,
} from './featureRuntime.js'
import { compactLocalConversation } from './localConversation.js'
import {
  isThunderSessionIntroPrompt,
} from './sessionLaunchPrompts.js'
import {
  ALTERNATE_OLLAMA_MODEL,
  AGENTIC_OLLAMA_MODEL,
  buildLocalCompatibilityPrompt,
  DEFAULT_OLLAMA_MODEL,
  getKnownModelCatalog,
  getRecommendedOllamaModel,
  isAgenticModel,
  QWOPUS_OLLAMA_MODEL,
} from './modelProfiles.js'
import {
  getDriveAuthState,
  runOAuthFlow,
  saveCredentialsFrom,
  saveToken,
  loadCredentials,
  getDriveSetupSteps,
  type DriveAuthState,
  type OAuthToken,
} from './drive/driveAuth.js'
import {
  initializeDriveFolders,
} from './drive/driveStore.js'
import { retrieveContext } from './drive/contextStore.js'
import { routeAndStore } from './drive/categoryManager.js'
import { analyzeAndDescribe } from './drive/toolAnalyzer.js'
import {
  buildFewShotBlock,
  storeSuccessTrace,
  storeFailureTrace,
} from './reasoning/experienceReplay.js'
import { loadJournalContext, updateJournal } from './reasoning/journal.js'
import { shouldTriggerAutoDream, runAutoDreamPass } from './reasoning/autoDream.js'
import { loadEmbeddingCache, persistEmbeddingCache } from './drive/driveCache.js'
import { assembleContext, buildOllamaOptions, CONTEXT_BUDGET } from './agent/contextAssembler.js'
import {
  validateToolCall,
  buildOllamaToolList,
  getToolSchema,
  normalizeLocalToolName,
  buildCapabilityReport,
  formatCapabilityReport,
} from './agent/localToolContract.js'
import {
  normalizeToolCallCandidates,
  tryParseEmbeddedToolCalls,
} from './agent/toolCallParser.js'
import { buildToolRoutingHint, getToolFastPathLabel, NO_TOOL_LABELS, isWeatherQuery, isDriveStatusQuery } from './agent/toolFastPath.js'
import { classifyTask, buildComplexityHint, isAmbiguousRequest } from './agent/taskClassifier.js'
import { buildObservation, detectResultStagnation, preflightCheck, checkDeadEnd, isTransientError, analyzeFailurePattern } from './agent/responseAuditor.js'
import { storeCorrection, loadRelevantCorrections } from './agent/correctionMemory.js'
import { shouldUseInProcessOllamaSession } from './ollamaSessionMode.js'
import { shouldSkipSharedRuntimeContextRetrievals } from './sharedRuntimeContext.js'
import {
  getDefaultPersistedLauncherState,
  loadPersistedLauncherState,
  savePersistedLauncherState,
  type PersistedLauncherState,
} from './state.js'
import { renderAppHtml } from './template.js'
import { renderAppClientJs } from './appClient.js'
import {
  createToolLoopGuardState,
  inspectToolLoop,
  type ToolLoopGuardState,
} from './toolLoopGuard.js'
import {
  createIdleRuntimeState,
  type DesktopFeatureSnapshot,
  type DesktopEvent,
  type DesktopShellPayload,
  type DesktopRuntimeState,
  type DesktopUiState,
  type IntegrationRegistryEntry,
  type LocalChatMessage,
  type ModelCatalogResponse,
  type PendingPermission,
  type RemoteBridgeHealth,
  type RuntimeMode,
  type SnapshotEvent,
} from './types.js'
import { normalizeJarvisMessageEvent } from './eventNormalization.js'
import {
  addPermissionRule,
  computeInputHash,
  findMatchingRule,
  initDefaultRules,
  inputContainsSensitivePath,
  loadPermissionRules,
  READ_ONLY_TOOLS,
} from './permissionRules.js'
import {
  buildChildEnvForWsl,
  buildWslCommand,
  checkWsl2SandboxReadiness,
  detectWsl2,
  wslPathOf,
  type Wsl2ReadinessResult,
} from './wslSandbox.js'

type ActiveChildSession = {
  kind: 'claude'
  id: string
  child: ReturnType<typeof Bun.spawn>
  pendingPermissions: Map<string, PendingPermission>
  initializeRequestId: string
  config: LauncherConfig
  toolLoopGuard: ToolLoopGuardState
  companionIntroHatchedAt: number | null
  launchIntroPrompt: string | null
  suppressedLaunchIntroPrompt: string | null
  hideLaunchTranscriptNoise: boolean
  launchHandshakeTimer: ReturnType<typeof setTimeout> | null
  launchHandshakeResolved: boolean
  launchHandshakeWaiters: Array<() => void>
  visiblePromptCount: number
  history: LocalChatMessage[]
  summary: string
  sharedLocalTurn: SharedLocalTurnState | null
}

type ActiveLocalSession = {
  kind: 'ollama-legacy'
  id: string
  provider: 'ollama' | 'llama-cpp'
  pendingPermissions: Map<string, PendingPermission>
  config: LauncherConfig
  history: LocalChatMessage[]
  summary: string
  inFlightAbort: AbortController | null
  runtimeChild: ReturnType<typeof Bun.spawn> | null
  requestUrl: string
  readyLabel: string
  busyLabel: string
  visiblePromptCount: number
  /** Persists ReAct violation count across user messages within the same session */
  reactViolationCount: number
}

type ActiveSession = ActiveChildSession | ActiveLocalSession

type SharedLocalToolStep = {
  toolUseId: string
  toolName: string
  args: Record<string, unknown>
  resultPreview: string
  success: boolean
  storedInDrive?: boolean
}

type SharedLocalTurnState = {
  turnId: string
  userContent: string
  assistantText: string
  assistantEventSeen: boolean
  toolSteps: SharedLocalToolStep[]
  toolStepsById: Map<string, SharedLocalToolStep>
  startedAt: number
  completedAt: number | null
  resultSubtype: string | null
  resultText: string
  finalized: boolean
}

const encoder = new TextEncoder()
const workspaceRoot = process.cwd()
const LOCAL_SAFE_NUM_CTX = 2048
const LLAMA_CPP_PORT = 11435
const LLAMA_CPP_HOST = '127.0.0.1'
const LLAMA_CPP_GPU_LAYERS = '999'
const CHILD_LAUNCH_TIMEOUT_MS = 45_000

// ── Drive auth state (refreshed on each Drive API route) ──────────────────
let cachedDriveAuthState: DriveAuthState = { status: 'not-configured' }

async function refreshDriveAuthState(): Promise<DriveAuthState> {
  try {
    cachedDriveAuthState = await getDriveAuthState(cachedConfig.drive)
  } catch {
    cachedDriveAuthState = { status: 'not-configured' }
  }
  return cachedDriveAuthState
}

// ── Agentic session tool executor (local shell only — no child process) ────

// ── Absolute paths for system tools that Electron's stripped PATH may miss ──
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * Augmented PATH injected into every child process so tools are found even
 * when Electron strips down the environment at launch.
 */
const CHILD_PATH = [
  process.env.PATH ?? '',
  'C:\\Windows\\System32',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  'C:\\Program Files\\Git\\usr\\bin',
  'C:\\Program Files\\Git\\bin',
].filter(Boolean).join(';')

const CHILD_ENV = { ...process.env, PATH: CHILD_PATH }

/** Spawn a process and collect stdout + stderr concurrently with exit. */
async function spawnCollect(
  cmd: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: CHILD_ENV,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  const completion = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  const awaited = opts.timeoutMs && opts.timeoutMs > 0
    ? Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            try {
              proc.kill()
            } catch {
              // Ignore kill failures and surface the timeout error instead.
            }
            reject(new Error(`Command timed out after ${opts.timeoutMs} ms`))
          }, opts.timeoutMs)
        }),
      ])
    : completion

  // Read streams and wait for exit concurrently — reading after exit risks
  // missing buffered output on fast-exiting processes.
  const [stdout, stderr] = await awaited
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
  }
  return { stdout, stderr, exitCode: proc.exitCode ?? 0 }
}

function normalizeGlobPath(value: string): string {
  return value.replace(/\\/g, '/')
}

function formatTimestamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  const seconds = String(date.getSeconds()).padStart(2, '0')
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeGlobPath(pattern.trim())
  let regex = '^'

  for (let i = 0; i < normalized.length; ) {
    const char = normalized[i]
    if (char === '*') {
      if (normalized[i + 1] === '*') {
        if (normalized[i + 2] === '/') {
          regex += '(?:.*/)?'
          i += 3
        } else {
          regex += '.*'
          i += 2
        }
        continue
      }
      regex += '[^/]*'
      i++
      continue
    }

    if (char === '?') {
      regex += '[^/]'
      i++
      continue
    }

    if (char === '{') {
      const end = normalized.indexOf('}', i + 1)
      if (end > i + 1) {
        const parts = normalized
          .slice(i + 1, end)
          .split(',')
          .map(part => escapeRegExp(part.trim()))
        regex += `(?:${parts.join('|')})`
        i = end + 1
        continue
      }
    }

    regex += escapeRegExp(char)
    i++
  }

  regex += '$'
  return new RegExp(regex, process.platform === 'win32' ? 'i' : '')
}

async function collectFilesRecursive(rootDir: string): Promise<string[]> {
  const collected: string[] = []
  const rootStat = await stat(rootDir).catch(() => null)
  if (!rootStat) {
    return collected
  }
  if (rootStat.isFile()) {
    return [rootDir]
  }
  if (!rootStat.isDirectory()) {
    return collected
  }
  const stack = [rootDir]

  while (stack.length > 0) {
    const current = stack.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else {
        collected.push(fullPath)
      }
    }
  }

  return collected
}

function requestNeedsLiveToolEvidence(userContent: string): boolean {
  const normalized = userContent.trim().toLowerCase()
  if (!normalized) {
    return false
  }

  const currentStateSignals = [
    /\b(latest|newest|most recent|recent|oldest|last modified|currently|right now)\b/i,
    /\b(file|files|folder|directory|path|documents|downloads|desktop|pictures|videos|music)\b/i,
  ]

  return currentStateSignals.every(pattern => pattern.test(normalized))
}

function requestLooksLikeLatestFileLookup(userContent: string): boolean {
  return /\b(latest|newest|most recent|last modified)\b/i.test(userContent) &&
    /\bfile\b/i.test(userContent) &&
    /\b(folder|directory|documents|downloads|desktop|pictures|videos|music)\b/i.test(userContent)
}

function describeRequestedFolder(userContent: string): string | null {
  const match = userContent.match(/\b(documents|downloads|desktop|pictures|videos|music)\b/i)
  return match ? `${match[1][0]!.toUpperCase()}${match[1].slice(1).toLowerCase()} folder` : null
}

function getRequestedKnownFolderName(userContent: string): string | null {
  const match = userContent.match(/\b(documents|downloads|desktop|pictures|videos|music)\b/i)
  return match ? `${match[1][0]!.toUpperCase()}${match[1].slice(1).toLowerCase()}` : null
}

function resolveKnownUserFolderPath(folderName: string): string | null {
  const home = homedir()
  const normalized = folderName.trim().toLowerCase()
  const candidates =
    normalized === 'documents'
      ? [join(home, 'OneDrive', 'Documents'), join(home, 'Documents')]
      : normalized === 'downloads'
        ? [join(home, 'Downloads'), join(home, 'OneDrive', 'Downloads')]
        : normalized === 'desktop'
          ? [join(home, 'OneDrive', 'Desktop'), join(home, 'Desktop')]
          : normalized === 'pictures'
            ? [
                join(home, 'OneDrive', 'Pictures'),
                join(home, 'Pictures'),
                join(home, 'Documents', 'My Pictures'),
              ]
            : normalized === 'videos'
              ? [
                  join(home, 'OneDrive', 'Videos'),
                  join(home, 'Videos'),
                  join(home, 'Documents', 'My Videos'),
                ]
              : normalized === 'music'
                ? [
                    join(home, 'OneDrive', 'Music'),
                    join(home, 'Music'),
                    join(home, 'Documents', 'My Music'),
                  ]
                : []

  return candidates.find(candidate => existsSync(candidate)) ?? null
}

function getKnownUserFolderPaths(): Array<{ name: string; path: string }> {
  return ['Documents', 'Downloads', 'Desktop', 'Pictures', 'Videos', 'Music']
    .map(name => {
      const path = resolveKnownUserFolderPath(name)
      return path ? { name, path } : null
    })
    .filter((entry): entry is { name: string; path: string } => entry !== null)
}

function buildKnownUserFolderHintText(): string {
  return getKnownUserFolderPaths()
    .map(entry => `- ${entry.name}: ${entry.path}`)
    .join('\n')
}

function isSkippableMetadataFileName(fileName: string): boolean {
  const normalized = fileName.trim().toLowerCase()
  return normalized === 'desktop.ini' ||
    normalized === 'thumbs.db' ||
    normalized === '.ds_store'
}

function resolveRequestedKnownFolderPath(userContent: string): string | null {
  const folderName = getRequestedKnownFolderName(userContent)
  return folderName ? resolveKnownUserFolderPath(folderName) : null
}

function buildSemanticToolRepairMessage(
  userContent: string,
  toolName: string,
): string | null {
  if (!requestLooksLikeLatestFileLookup(userContent)) {
    return null
  }

  if (toolName === 'ListDirectory' || toolName === 'Glob') {
    return null
  }

  const requestedFolderPath = resolveRequestedKnownFolderPath(userContent)
  const pathHint = requestedFolderPath
    ? ` Use the exact folder path ${requestedFolderPath}.`
    : ''

  return `This tool cannot answer a latest/newest file lookup because it does not provide the directory contents ranked by last-modified time. Retry with ListDirectory on the target folder.${pathHint} If you specifically need only files, use Glob on that folder instead.`
}

function coerceKnownFolderToolArgs(
  userContent: string,
  toolName: string,
  args: Record<string, unknown>,
): { args: Record<string, unknown>; note?: string } {
  const requestedFolderPath = resolveRequestedKnownFolderPath(userContent)
  if (!requestedFolderPath) {
    return { args }
  }

  if (!['ListDirectory', 'Glob', 'Grep'].includes(toolName)) {
    return { args }
  }

  const nextArgs = { ...args }
  const rawPath = String(nextArgs.path ?? nextArgs.directory ?? '').trim()

  if (requestLooksLikeLatestFileLookup(userContent)) {
    if (rawPath.toLowerCase() !== requestedFolderPath.toLowerCase()) {
      nextArgs.path = requestedFolderPath
      if ('directory' in nextArgs) {
        delete nextArgs.directory
      }
      return {
        args: nextArgs,
        note: `Adjusted ${toolName} path to the requested folder: ${requestedFolderPath}`,
      }
    }
    return { args: nextArgs }
  }

  if (!rawPath || !existsSync(rawPath)) {
    nextArgs.path = requestedFolderPath
    if ('directory' in nextArgs) {
      delete nextArgs.directory
    }
    return {
      args: nextArgs,
      note: `Adjusted ${toolName} path to the requested folder: ${requestedFolderPath}`,
    }
  }

  return { args: nextArgs }
}

function deriveLatestFileAnswerFromToolResults(
  userContent: string,
  toolSteps: Array<{
    toolName: string
    resultPreview: string
    success: boolean
  }>,
  candidateAnswer: string,
): string | null {
  if (!requestLooksLikeLatestFileLookup(userContent)) {
    return null
  }

  const successfulSteps = toolSteps.filter(step => step.success)
  for (const step of successfulSteps) {
    if (step.toolName === 'ListDirectory') {
      const fileLines = step.resultPreview
        .split(/\r?\n/)
        .filter(line => /^f\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+/.test(line.trim()))
      if (fileLines.length === 0) {
        continue
      }

      let chosenMatch: RegExpMatchArray | null = null
      for (const fileLine of fileLines) {
        const parsed = fileLine.trim().match(/^f\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.+)$/)
        if (!parsed) {
          continue
        }
        if (isSkippableMetadataFileName(parsed[2])) {
          continue
        }
        chosenMatch = parsed
        break
      }

      const match = chosenMatch ??
        fileLines[0]!.trim().match(/^f\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.+)$/)
      if (!match) {
        continue
      }
      const [, timestamp, fileName] = match
      if (candidateAnswer.toLowerCase().includes(fileName.toLowerCase())) {
        return null
      }
      const folderDescription = describeRequestedFolder(userContent)
      return folderDescription
        ? `The most recent file in your ${folderDescription} is ${fileName} last modified on ${timestamp}.`
        : `The most recent file is ${fileName} last modified on ${timestamp}.`
    }

    if (step.toolName === 'Glob') {
      const candidatePaths = step.resultPreview
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean)
      const firstPath =
        candidatePaths.find(path => !isSkippableMetadataFileName(basename(path))) ??
        candidatePaths[0]
      if (!firstPath) {
        continue
      }
      const fileName = basename(firstPath)
      if (candidateAnswer.toLowerCase().includes(fileName.toLowerCase())) {
        return null
      }
      const folderDescription = describeRequestedFolder(userContent)
      return folderDescription
        ? `The most recent file found for your ${folderDescription} lookup is ${fileName}.`
        : `The most recent file found is ${fileName}.`
    }
  }

  return null
}

function buildIncompleteTaskResponse(
  userContent: string,
  toolSteps: Array<{
    toolName: string
    resultPreview: string
    success: boolean
  }>,
): string {
  const failedSteps = toolSteps.filter(step => !step.success)
  const lastFailure = failedSteps.at(-1)
  if (lastFailure) {
    return `I could not complete that request yet because ${lastFailure.toolName} kept failing. Last error: ${lastFailure.resultPreview}`
  }
  if (requestNeedsLiveToolEvidence(userContent)) {
    return 'I could not complete that request yet because it needs live tool evidence and the model did not produce a usable grounded answer.'
  }
  return 'I could not complete that request yet with the available tool results.'
}

async function executeLocalTool(
  toolName: string,
  args: Record<string, unknown>,
  workingDir: string,
): Promise<{ output: string; success: boolean; error?: string }> {
  const canonicalToolName = normalizeLocalToolName(toolName)

  const parseOptionalNumber = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }
    return null
  }

  const sliceOutputLines = (
    content: string,
    offset: unknown = 0,
    limit: unknown = 100,
  ): string => {
    const lines = content
      .split(/\r?\n/)
      .map(line => line.trimEnd())
      .filter(line => line.length > 0)

    const normalizedOffset = Math.max(
      0,
      Math.trunc(parseOptionalNumber(offset) ?? 0),
    )
    const normalizedLimit = Math.max(
      1,
      Math.trunc(parseOptionalNumber(limit) ?? 100),
    )

    return lines
      .slice(normalizedOffset, normalizedOffset + normalizedLimit)
      .join('\n')
  }

  try {
    switch (canonicalToolName) {

      // ── read_file ─────────────────────────────────────────────────────────
      case 'Read': {
        const p = String(args.file_path ?? args.path ?? '').trim()
        if (!p) return { output: '', success: false, error: 'file_path is required' }
        if (!existsSync(p)) {
          return { output: '', success: false, error: `File does not exist: ${p}` }
        }
        if (typeof args.pages === 'string' && args.pages.trim()) {
          return {
            output: '',
            success: false,
            error:
              'PDF page selection is not supported by the in-process local adapter. Use the full Claude/Ollama runtime for paged document reads.',
          }
        }

        // ── Binary document detection ─────────────────────────────────────────
        // .docx, .xlsx, .pptx are ZIP containers — reading as UTF-8 returns noise.
        // Instead, extract readable text using PowerShell's ZIP API.
        const lowerPath = p.toLowerCase()
        if (lowerPath.endsWith('.docx') || lowerPath.endsWith('.xlsx') || lowerPath.endsWith('.pptx')) {
          const escapedPath = p.replace(/'/g, "''")
          const psScript = [
            `Add-Type -Assembly System.IO.Compression.FileSystem`,
            `$zip = [System.IO.Compression.ZipFile]::OpenRead('${escapedPath}')`,
            `$entry = $zip.Entries | Where-Object { $_.FullName -match '^word/document\\.xml$|^xl/sharedStrings\\.xml$|^ppt/slides/slide1\\.xml$' } | Select-Object -First 1`,
            `if ($entry) {`,
            `  $reader = [System.IO.StreamReader]::new($entry.Open())`,
            `  $xml = $reader.ReadToEnd()`,
            `  $reader.Close()`,
            `  $zip.Dispose()`,
            `  $text = [System.Text.RegularExpressions.Regex]::Replace($xml, '<[^>]+>', ' ')`,
            `  $text = [System.Text.RegularExpressions.Regex]::Replace($text, '\\s+', ' ').Trim()`,
            `  Write-Output $text`,
            `} else { $zip.Dispose(); Write-Output '(no readable text entry found in this document)' }`,
          ].join('; ')
          const shellCmd = [POWERSHELL_EXE, '-NoProfile', '-NonInteractive', '-Command', psScript]
          const { stdout, stderr, exitCode } = await spawnCollect(shellCmd, { timeoutMs: 15_000 })
          const extracted = (stdout || stderr || '').trim().slice(0, 6000)
          if (exitCode === 0 && extracted && !extracted.startsWith('(no readable')) {
            return { output: `[Extracted text from ${basename(p)}]\n\n${extracted}`, success: true }
          }
          return {
            output: '',
            success: false,
            error: `"${basename(p)}" is a binary Office document. Text extraction via PowerShell failed${extracted ? ': ' + extracted.slice(0, 200) : ''}. Try opening it in Word/Excel and copying the text, or export it as .txt first.`,
          }
        }

        const content = await readFile(p, 'utf8')
        const offset = parseOptionalNumber(args.offset)
        const limit = parseOptionalNumber(args.limit)
        const visible =
          offset !== null || limit !== null
            ? content
                .split(/\r?\n/)
                .slice(
                  Math.max(0, Math.trunc((offset ?? 1) - 1)),
                  Math.max(0, Math.trunc((offset ?? 1) - 1)) +
                    Math.max(1, Math.trunc(limit ?? 200)),
                )
                .join('\n')
            : content
        const truncated = visible.length > 8000
          ? content.slice(0, 8000) + `\n\n[...truncated — file is ${content.length} chars total]`
          : visible
        return { output: truncated, success: true }
      }

      // ── write_file ────────────────────────────────────────────────────────
      case 'Write': {
        const p = String(args.file_path ?? args.path ?? '').trim()
        const c = String(args.content ?? '')
        if (!p) return { output: '', success: false, error: 'file_path is required' }
        // { recursive: true } suppresses EEXIST in most cases, but on Windows with
        // OneDrive-synced folders (Documents, Desktop) which are junction points,
        // Node.js can still throw EEXIST even when the directory already exists.
        // Explicitly catch EEXIST so we always proceed to the write.
        await mkdir(dirname(p), { recursive: true }).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'EEXIST') throw e
        })
        await writeFile(p, c, 'utf8')
        return { output: `Written ${c.length} chars to ${p}`, success: true }
      }

      // ── list_directory ────────────────────────────────────────────────────
      case 'ListDirectory': {
        const p = String(args.path ?? workingDir).trim()
        if (!existsSync(p)) {
          return { output: '', success: false, error: `Path does not exist: ${p}` }
        }
        const pathStat = await stat(p).catch(() => null)
        if (!pathStat?.isDirectory()) {
          return { output: '', success: false, error: `Path is not a directory: ${p}` }
        }

        const entries = await readdir(p, { withFileTypes: true })
        const ranked = (await Promise.all(
          entries.map(async entry => {
            const fullPath = join(p, entry.name)
            const entryStat = await stat(fullPath).catch(() => null)
            if (!entryStat) return null  // skip entries we can't stat (permission denied etc.)
            return {
              type: entry.isDirectory() ? 'd' : 'f',
              name: entry.name,
              mtimeMs: entryStat.mtimeMs,
              lastWriteTime: formatTimestamp(entryStat.mtime),
            }
          }),
        )).filter((e): e is NonNullable<typeof e> => e !== null)

        const output = ranked
          .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name))
          .map(entry => `${entry.type}  ${entry.lastWriteTime}  ${entry.name}`)
          .join('\n')

        return { output: output.trim().slice(0, 4000) || '(empty directory)', success: true }
      }

      // ── search_files ──────────────────────────────────────────────────────
      case 'Grep': {
        const pattern = String(args.pattern ?? '').trim()
        const directory = String(args.path ?? args.directory ?? workingDir).trim()
        const globPattern = String(args.glob ?? '**/*')
        const outputMode = String(args.output_mode ?? 'content').trim()
        const caseInsensitive = Boolean(args['-i'])
        if (!pattern) return { output: '', success: false, error: 'pattern is required' }
        if (!existsSync(directory)) {
          return { output: '', success: false, error: `Path does not exist: ${directory}` }
        }

        let lineMatcher: RegExp
        try {
          lineMatcher = new RegExp(pattern, caseInsensitive ? 'i' : undefined)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { output: '', success: false, error: `Invalid regex: ${message}` }
        }

        const fileMatcher = globToRegExp(globPattern)
        const files = await collectFilesRecursive(directory)
        const matches: string[] = []
        const matchingFiles = new Set<string>()

        // Respect head_limit for the inner scan cap (default 250, max 500)
        const scanLimit = Math.min(500, Math.max(1, Math.trunc(parseOptionalNumber(args.head_limit) ?? 250)))

        outer: for (const file of files) {
          const relativePath = normalizeGlobPath(relative(directory, file))
          if (!fileMatcher.test(relativePath) && !fileMatcher.test(basename(file))) {
            continue
          }

          let content: string
          try {
            content = await readFile(file, 'utf8')
          } catch {
            continue
          }

          const lines = content.split(/\r?\n/)
          for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
            const line = lines[lineNumber] ?? ''
            if (!lineMatcher.test(line)) {
              continue
            }
            matchingFiles.add(relativePath)
            matches.push(`${relativePath}:${lineNumber + 1}:${line}`)
            if (matches.length >= scanLimit) {
              break outer
            }
          }
        }

        const offset = Math.max(0, Math.trunc(parseOptionalNumber(args.offset) ?? 0))
        const limit = Math.max(1, Math.trunc(parseOptionalNumber(args.head_limit) ?? 250))
        const output =
          outputMode === 'count'
            ? String(matches.length)
            : outputMode === 'files_with_matches'
              ? Array.from(matchingFiles).slice(offset, offset + limit).join('\n')
              : matches.slice(offset, offset + limit).join('\n')
        // Return success:true even when empty — no matches is not an error.
        // The auditor in responseAuditor.ts detects the "(no matches)" string and
        // injects a hint to broaden the search.
        return { output: output.slice(0, 4000) || '(no matches)', success: true }
      }

      // ── bash ──────────────────────────────────────────────────────────────
      case 'Bash': {
        const command = String(args.command ?? '').trim()
        const rawCwd = String(args.workingDir ?? workingDir).trim()
        if (!command) return { output: '', success: false, error: 'command is required' }

        // Validate working dir — fall back to workspace if model gives bad path
        const cwd = existsSync(rawCwd) ? rawCwd : workingDir
        const timeoutMs = parseOptionalNumber(args.timeout)

        const shell: string[] = process.platform === 'win32'
          ? [POWERSHELL_EXE, '-NoProfile', '-NonInteractive', '-Command', command]
          : ['sh', '-c', command]

        const { stdout, stderr, exitCode } = await spawnCollect(shell, { cwd, timeoutMs: timeoutMs ?? undefined })
        const combined = [stdout, stderr].filter(s => s.trim()).join('\n').slice(0, 4000)
        if (exitCode !== 0) {
          // Parse common PowerShell error patterns and add targeted correction hints
          let errorHint = ''
          if (/CommandNotFoundException|not recognized as.*cmdlet|is not recognized/i.test(combined)) {
            errorHint = '\n[HINT] Command not found. Options: (1) Use the full absolute path to the executable, (2) Install it via winget/choco/npm, or (3) Check spelling.'
          } else if (/Access.*denied|UnauthorizedAccess|PermissionDenied/i.test(combined)) {
            errorHint = '\n[HINT] Permission denied. Run as Administrator or use a path you have write access to.'
          } else if (/cannot be loaded because running scripts is disabled|ExecutionPolicy/i.test(combined)) {
            errorHint = '\n[HINT] PowerShell execution policy blocks this script. Run: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'
          } else if (/No such file or directory|path.*does not exist/i.test(combined)) {
            errorHint = '\n[HINT] File or directory not found. Use Glob or ListDirectory to verify the path before retrying.'
          } else if (/timed out/i.test(combined)) {
            errorHint = '\n[HINT] Command timed out. Break the task into smaller steps or add a timeout parameter.'
          }
          return {
            output: (combined || `(command exited with code ${exitCode})`) + errorHint,
            success: false,
          }
        }
        return { output: combined || '(no output)', success: true }
      }

      // ── edit_file ─────────────────────────────────────────────────────────
      case 'Edit': {
        const p = String(args.file_path ?? args.path ?? '').trim()
        const oldStr = String(args.old_string ?? '')
        const newStr = String(args.new_string ?? '')
        if (!p) return { output: '', success: false, error: 'file_path is required' }
        if (!existsSync(p)) return { output: '', success: false, error: `File does not exist: ${p}` }
        if (oldStr === '') return { output: '', success: false, error: 'old_string cannot be empty' }

        const original = await readFile(p, 'utf8')
        const replaceAll = Boolean(args.replace_all)

        if (!original.includes(oldStr)) {
          return { output: '', success: false, error: `old_string not found in ${p}. Check whitespace, line endings, and exact characters.` }
        }
        if (!replaceAll) {
          const firstIdx = original.indexOf(oldStr)
          const lastIdx = original.lastIndexOf(oldStr)
          if (firstIdx !== lastIdx) {
            return { output: '', success: false, error: `old_string appears multiple times in ${p}. Set replace_all to true or provide more surrounding context to make it unique.` }
          }
        }

        const updated = replaceAll
          ? original.split(oldStr).join(newStr)
          : original.replace(oldStr, newStr)

        await writeFile(p, updated, 'utf8')
        return { output: `Edited ${p} — replaced ${replaceAll ? 'all occurrences' : '1 occurrence'} of the target string.`, success: true }
      }

      // ── glob ──────────────────────────────────────────────────────────────
      case 'Glob': {
        const pattern = String(args.pattern ?? '').trim()
        const rootDir = String(args.path ?? workingDir).trim()
        if (!pattern) return { output: '', success: false, error: 'pattern is required' }
        if (!existsSync(rootDir)) return { output: '', success: false, error: `Directory does not exist: ${rootDir}` }

        const matcher = globToRegExp(pattern)
        const files = await collectFilesRecursive(rootDir)
        const matchedFiles = files.filter(file => {
          const relativePath = normalizeGlobPath(relative(rootDir, file))
          return matcher.test(relativePath) || matcher.test(basename(file))
        })

        const ranked = (await Promise.all(
          matchedFiles.map(async file => {
            const s = await stat(file).catch(() => null)
            return s ? { file, mtimeMs: s.mtimeMs } : null
          }),
        )).filter((e): e is NonNullable<typeof e> => e !== null)

        const output = ranked
          .sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file))
          .slice(0, 200)
          .map(item => item.file)
          .join('\n')

        return { output: output.slice(0, 4000) || '(no matches)', success: true }
      }

      // ── web_fetch ─────────────────────────────────────────────────────────
      case 'WebFetch': {
        const url = String(args.url ?? '').trim()
        if (!url) return { output: '', success: false, error: 'url is required' }
        if (!/^https?:\/\//i.test(url)) {
          return { output: '', success: false, error: 'url must start with http:// or https://' }
        }
        let resp: Response
        try {
          resp = await fetch(url, {
            headers: { 'User-Agent': 'JarvisAgent/1.0', 'Accept': 'text/html,text/plain,application/json' },
            signal: AbortSignal.timeout(15_000),
          })
        } catch (fetchErr: any) {
          return { output: '', success: false, error: `Fetch failed: ${fetchErr?.message ?? fetchErr}` }
        }
        if (!resp.ok) return { output: '', success: false, error: `HTTP ${resp.status} for ${url}` }

        const contentType = resp.headers.get('content-type') ?? ''
        const raw = await resp.text()

        // Strip HTML tags for readability, keep text content
        let text = raw
        if (contentType.includes('html')) {
          text = raw
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/\s{3,}/g, '\n\n')
            .trim()
        }
        return { output: text.slice(0, 6000), success: true }
      }

      // ── web_search ────────────────────────────────────────────────────────
      // Search chain: Brave API (best) → SearXNG public (open metasearch) → DDG zero-click (fallback)
      // Brave API: https://api.search.brave.com — free tier 2000 req/month
      // SearXNG: open-source metasearch engine — queries Google, Bing, DDG simultaneously
      // Multiple instances tried in order; first successful response wins
      // DDG zero-click: limited to famous entities but always available as last resort
      case 'WebSearch': {
        const query = String(args.query ?? '').trim()
        if (!query) return { output: '', success: false, error: 'query is required' }

        const allowedDomains = Array.isArray(args.allowed_domains)
          ? args.allowed_domains.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          : []
        const blockedDomains = Array.isArray(args.blocked_domains)
          ? args.blocked_domains.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          : []
        const scopedQuery = [
          query,
          ...allowedDomains.map(d => `site:${d}`),
          ...blockedDomains.map(d => `-site:${d}`),
        ].join(' ')

        // ── Try Brave Search API first ──────────────────────────────────────
        const braveKey = (process.env.BRAVE_SEARCH_API_KEY ?? cachedConfig.braveSearchApiKey ?? '').trim()
        if (braveKey) {
          try {
            const braveUrl = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(scopedQuery)}&count=5`
            const braveResp = await fetch(braveUrl, {
              headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': braveKey,
              },
              signal: AbortSignal.timeout(8_000),
            })
            if (braveResp.ok) {
              const braveData = await braveResp.json() as {
                web?: { results?: Array<{ title: string; description?: string; url: string }> }
              }
              const results = braveData.web?.results ?? []
              if (results.length > 0) {
                const output = results.map((r, i) =>
                  `${i + 1}. **${r.title}**\n${r.description ?? '(no description)'}\n${r.url}`
                ).join('\n\n')
                return { output: output.slice(0, 5000), success: true }
              }
            }
          } catch {
            // Brave failed — fall through to SearXNG
          }
        }

        // ── Try SearXNG public instances ────────────────────────────────────
        // Open-source metasearch engine — queries Google, Bing, DDG simultaneously
        // Multiple instances tried in order; first successful response wins
        const SEARXNG_INSTANCES = [
          'https://searx.be',
          'https://searxng.site',
          'https://search.sapti.me',
          'https://searx.tiekoetter.com',
        ]
        for (const base of SEARXNG_INSTANCES) {
          try {
            const searxUrl = `${base}/search?q=${encodeURIComponent(scopedQuery)}&format=json&safesearch=0`
            const searxResp = await fetch(searxUrl, {
              headers: {
                'User-Agent': 'JarvisAgent/1.0',
                'Accept': 'application/json',
              },
              signal: AbortSignal.timeout(8_000),
            })
            if (!searxResp.ok) continue
            const searxData = await searxResp.json() as {
              results?: Array<{ title: string; content?: string; url: string }>
            }
            const results = (searxData.results ?? []).slice(0, 5)
            if (results.length > 0) {
              const output = results.map((r, i) =>
                `${i + 1}. **${r.title}**\n${r.content ?? '(no description)'}\n${r.url}`
              ).join('\n\n')
              return { output: output.slice(0, 5000), success: true }
            }
          } catch {
            continue // Try next instance
          }
        }

        // ── DDG zero-click fallback ─────────────────────────────────────────
        // Limited to Wikipedia-adjacent topics but always available
        const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(scopedQuery)}&format=json&no_html=1&skip_disambig=1`
        let ddgResp: Response
        try {
          ddgResp = await fetch(ddgUrl, {
            headers: { 'User-Agent': 'JarvisAgent/1.0' },
            signal: AbortSignal.timeout(8_000),
          })
        } catch (fetchErr: any) {
          return { output: '', success: false, error: `All search backends failed. Last error: ${fetchErr?.message ?? fetchErr}` }
        }
        if (!ddgResp.ok) {
          return { output: '', success: false, error: `All search backends failed (DDG HTTP ${ddgResp.status})` }
        }

        let ddgData: any
        try {
          ddgData = await ddgResp.json()
        } catch {
          return { output: '', success: false, error: 'Failed to parse fallback search response' }
        }

        if (!ddgData || typeof ddgData !== 'object') {
          return { output: '', success: false, error: 'Fallback search returned no parseable data' }
        }
        const abstract = String(ddgData.AbstractText || ddgData.Answer || '').trim()
        const related = (ddgData.RelatedTopics ?? [])
          .filter((t: any) => t && typeof t.Text === 'string' && t.Text.trim())
          .slice(0, 5)
          .map((t: any) => t.Text.trim())
          .join('\n')

        const result = [abstract, related].filter(Boolean).join('\n\n')
        if (!result) {
          return {
            output: '',
            success: false,
            error:
              'All search backends (Brave/SearXNG/DuckDuckGo) returned no results for this query. ' +
              'Do NOT retry WebSearch. Switch approach immediately:\n' +
              '- Weather: Bash → `curl.exe -s "wttr.in/?format=3"`\n' +
              '- News/articles: WebFetch a specific known URL\n' +
              '- Set BRAVE_SEARCH_API_KEY in Settings for reliable web search results.',
          }
        }
        return { output: result.slice(0, 5000), success: true }
      }

      // ── check_drive_status ────────────────────────────────────────────────
      case 'CheckDriveStatus': {
        // Build a live capability report from the current session config
        const drive = cachedConfig.drive
        const report = buildCapabilityReport({
          driveConnected: Boolean(drive.setupComplete && drive.folderIds),
          memoryPath: getDesktopMemoryEntrypoint(cachedConfig.workspacePath),
          model: cachedConfig.ollamaModel,
        })
        return { output: formatCapabilityReport(report), success: true }
      }

      // ── write_memory ──────────────────────────────────────────────────────
      case 'WriteMemory': {
        const entryName = String(args.name ?? '').trim()
        const entryDesc = String(args.description ?? '').trim()
        const entryType = String(args.type ?? 'feedback').trim()
        const entryBody = String(args.body ?? '').trim()

        if (!entryName || !entryBody) {
          return { output: '', success: false, error: 'WriteMemory requires name and body' }
        }

        const memoryPath = getDesktopMemoryEntrypoint(workingDir)
        await mkdir(dirname(memoryPath), { recursive: true })

        // Read existing MEMORY.md so we can check for duplicates
        let existing = ''
        try { existing = await readFile(memoryPath, 'utf8') } catch { /* first entry */ }

        // Skip write if an entry with the same name already exists
        if (existing.includes(`name: ${entryName}`)) {
          return {
            output: `Memory entry "${entryName}" already exists. Use Edit tool on ${memoryPath} to update it.`,
            success: true,
          }
        }

        const newEntry =
          `\n---\n` +
          `name: ${entryName}\n` +
          `description: ${entryDesc || entryName}\n` +
          `type: ${entryType}\n` +
          `---\n\n` +
          `${entryBody}\n`

        await writeFile(memoryPath, existing + newEntry, 'utf8')
        return { output: `Memory entry "${entryName}" saved to ${memoryPath}`, success: true }
      }

      default:
        return {
          output: '',
          success: false,
          error: `Unknown tool: ${canonicalToolName || toolName}. Available tools: Read, Write, Edit, Grep, Glob, Bash, ListDirectory, WebSearch, WebFetch, CheckDriveStatus, WriteMemory`,
        }
    }
  } catch (err) {
    return {
      output: '',
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── Idle heartbeat — fires companion reaction every 2 min while session is open and idle ──
let idleHeartbeatTimer: ReturnType<typeof setInterval> | null = null
const IDLE_HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000

function startIdleHeartbeat(): void {
  stopIdleHeartbeat()
  idleHeartbeatTimer = setInterval(() => {
    // Only fire when a local/shared Ollama session is running and NOT busy
    if (!session || (!isLocalSession(session) && !isSharedLocalSession(session)) || runtimeState.busy) return
    if (session.config.backend !== 'ollama') return
    triggerSessionEventReaction('thinking')
  }, IDLE_HEARTBEAT_INTERVAL_MS)
}

function stopIdleHeartbeat(): void {
  if (idleHeartbeatTimer) {
    clearInterval(idleHeartbeatTimer)
    idleHeartbeatTimer = null
  }
}

let cachedConfig = await loadLauncherConfig(workspaceRoot)
let persistedState =
  await loadPersistedLauncherState(workspaceRoot)
let runtimeState: DesktopRuntimeState =
  persistedState.runtimeState ?? createIdleRuntimeState(workspaceRoot)
let session: ActiveSession | null = null
const recentEvents: DesktopEvent[] = [...persistedState.recentEvents]
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>()
let persistChain = Promise.resolve()
const messageFlowCounters = {
  parsedChildLineCount: 0,
  normalizedMessageCount: 0,
  droppedChildLineCount: 0,
}

persistedState.pendingPermissions = []

// ── Permission rules — warm the cache and seed defaults on first run ──────
void initDefaultRules()

// ── WSL2 sandbox readiness — checked once at startup ─────────────────────
let wsl2SandboxStatus: Wsl2ReadinessResult = { available: false, reason: 'Not yet checked.' }
void checkWsl2SandboxReadiness(cachedConfig.wslDistro).then(result => {
  wsl2SandboxStatus = result
})

function toIsoOrNull(timestampMs: number): string | null {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return null
  }
  return new Date(timestampMs).toISOString()
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

async function getDesktopFeatureSnapshot(): Promise<DesktopFeatureSnapshot> {
  const companion = getDesktopBuddySnapshot()
  const memory = await readMemoryPreview(cachedConfig.workspacePath)
  const { coordinatorTools, workerTools } = getCoordinatorToolNames()
  const lastConsolidatedAt = await readLastConsolidatedAtDesktop(
    cachedConfig.workspacePath,
  ).catch(() => 0)
  const sessionsSinceLast = await listSessionsTouchedSinceDesktop(
    cachedConfig.workspacePath,
    lastConsolidatedAt,
  )
    .then(ids => ids.length)
    .catch(() => 0)
  const hoursSinceLast =
    lastConsolidatedAt > 0 ? (Date.now() - lastConsolidatedAt) / 3_600_000 : Infinity
  const autoDreamEnabled = isAutoDreamEnabledDesktop()
  // Keep these thresholds in sync with autoDream.ts constants (MIN_HOURS_GATE=0.5, MIN_SESSIONS_GATE=1)
  const autoDreamReady =
    autoDreamEnabled && hoursSinceLast >= 0.5 && sessionsSinceLast >= 1

  return {
    buddy: companion,
    coordinator: {
      available: true,
      active: cachedConfig.coordinatorMode,
      coordinatorTools: coordinatorTools.sort(),
      workerTools: workerTools.sort(),
      strictDelegationRules: [
        'Synthesize worker findings before issuing follow-up work.',
        'Delegate with file paths, line numbers, and concrete edits instead of vague goals.',
        'Do not say "based on your findings" and push understanding back onto the worker.',
      ],
      swarmStatus:
        'Process-based teammates and swarm mailboxes exist in the leaked codebase. Desktop mode surfaces the coordinator stack and keeps the launch toggle ready for native-tool sessions.',
    },
    autoDream: {
      enabled: autoDreamEnabled,
      ready: autoDreamReady,
      minHours: 0.5,
      minSessions: 1,
      lastConsolidatedAt: toIsoOrNull(lastConsolidatedAt),
      sessionsSinceLast,
      phases: ['Orient', 'Gather', 'Consolidate', 'Prune'],
      lockStatus: autoDreamReady
        ? 'Gates open — memory consolidation will run after this session.'
        : `Waiting: ${hoursSinceLast < 0.5 ? 'need 30 min since last pass' : ''} ${sessionsSinceLast < 1 ? 'need 1 session' : ''}`.trim(),
    },
    memory: {
      enabled: isAutoMemoryEnabledDesktop(),
      memoryDir: getDesktopMemoryDir(cachedConfig.workspacePath),
      entrypointPath: getDesktopMemoryEntrypoint(cachedConfig.workspacePath),
      lineCount: memory.lineCount,
      maxLines: MAX_ENTRYPOINT_LINES,
      preview: memory.preview,
      previewTruncated: memory.previewTruncated,
      rules: [
        'Treat MEMORY.md as a pointer index, not a dump of raw memory content.',
        'Only update the index after the real file write succeeds.',
        'Treat remembered facts as hints and verify them against the codebase before acting.',
      ],
    },
  }
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}

function text(message: string, status = 200): Response {
  return new Response(message, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}

function isChildSession(target: ActiveSession | null): target is ActiveChildSession {
  return target?.kind === 'claude'
}

function isLocalSession(target: ActiveSession | null): target is ActiveLocalSession {
  return target?.kind === 'ollama-legacy'
}

function clearLaunchHandshakeTimer(target: ActiveChildSession): void {
  if (target.launchHandshakeTimer) {
    clearTimeout(target.launchHandshakeTimer)
    target.launchHandshakeTimer = null
  }
}

function resolveLaunchHandshakeWaiters(target: ActiveChildSession): void {
  const waiters = target.launchHandshakeWaiters.splice(0)
  for (const resolve of waiters) {
    try {
      resolve()
    } catch {
      // Ignore waiter cleanup errors.
    }
  }
}

function markLaunchHandshakeResolved(target: ActiveChildSession): void {
  target.launchHandshakeResolved = true
  clearLaunchHandshakeTimer(target)
  resolveLaunchHandshakeWaiters(target)
}

async function waitForLaunchHandshake(
  target: ActiveChildSession,
  timeoutMs = 10_000,
): Promise<boolean> {
  if (target.launchHandshakeResolved) {
    return true
  }

  return await new Promise<boolean>(resolve => {
    const finish = (ready: boolean) => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
      const index = target.launchHandshakeWaiters.indexOf(onReady)
      if (index !== -1) {
        target.launchHandshakeWaiters.splice(index, 1)
      }
      resolve(ready)
    }

    const onReady = () => finish(true)
    const timeoutHandle = setTimeout(() => finish(false), timeoutMs)
    target.launchHandshakeWaiters.push(onReady)
  })
}

function getPendingPermissions(): PendingPermission[] {
  if (!session) {
    return []
  }
  return Array.from(session.pendingPermissions.values())
}

function buildPersistedState(): PersistedLauncherState {
  const trackedConversation = isLocalSession(session) || isSharedLocalSession(session)
  return {
    ...persistedState,
    runtimeState,
    recentEvents: recentEvents.slice(-300),
    pendingPermissions: [],
    lastLocalHistory: trackedConversation
      ? [...session.history]
      : persistedState.lastLocalHistory,
    lastLocalSummary: trackedConversation
      ? session.summary
      : persistedState.lastLocalSummary,
  }
}

function buildShellPayload(): DesktopShellPayload {
  return {
    uiState: persistedState.uiState,
    integrations: persistedState.integrations,
  }
}

function updateUiState(patch: Partial<DesktopUiState>): DesktopUiState {
  persistedState.uiState = {
    ...persistedState.uiState,
    ...patch,
  }
  schedulePersist()
  return persistedState.uiState
}

function normalizeIntegrationEntry(
  value: Partial<IntegrationRegistryEntry>,
): IntegrationRegistryEntry | null {
  const id =
    typeof value.id === 'string' && value.id.trim()
      ? value.id.trim()
      : randomUUID()
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl.trim() : ''
  if (!name || !baseUrl) {
    return null
  }

  const tags = Array.isArray(value.tags)
    ? value.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map(tag => tag.trim())
        .filter(Boolean)
    : []

  return {
    id,
    name,
    category:
      typeof value.category === 'string' && value.category.trim()
        ? value.category.trim()
        : 'General',
    baseUrl,
    authMode:
      value.authMode === 'bearer' ||
      value.authMode === 'api-key' ||
      value.authMode === 'basic'
        ? value.authMode
        : 'none',
    status:
      value.status === 'ready' || value.status === 'paused'
        ? value.status
        : 'draft',
    notes: typeof value.notes === 'string' ? value.notes : '',
    tags,
    updatedAt: new Date().toISOString(),
  }
}

function saveIntegrations(entries: unknown): IntegrationRegistryEntry[] {
  const nextEntries = Array.isArray(entries)
    ? entries
        .map(entry =>
          normalizeIntegrationEntry(
            entry as Partial<IntegrationRegistryEntry>,
          ),
        )
        .filter((entry): entry is IntegrationRegistryEntry => Boolean(entry))
    : []

  persistedState.integrations = nextEntries
  if (
    persistedState.uiState.selectedIntegrationId &&
    !nextEntries.some(
      entry => entry.id === persistedState.uiState.selectedIntegrationId,
    )
  ) {
    persistedState.uiState = {
      ...persistedState.uiState,
      selectedIntegrationId: nextEntries[0]?.id ?? null,
    }
  }
  schedulePersist()
  return persistedState.integrations
}

function schedulePersist(): void {
  const snapshot = buildPersistedState()
  persistedState = snapshot
  persistChain = persistChain
    .then(() => savePersistedLauncherState(snapshot))
    .catch(() => undefined)
}

function remember(event: DesktopEvent): void {
  recentEvents.push(event)
  if (recentEvents.length > 300) {
    recentEvents.shift()
  }
  schedulePersist()
}

function broadcast(event: DesktopEvent | SnapshotEvent): void {
  const chunk = encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
  for (const client of sseClients) {
    try {
      client.enqueue(chunk)
    } catch {
      sseClients.delete(client)
    }
  }
}

function getActiveTurnIdForNormalization(): string | null {
  if (session && isSharedLocalSession(session) && session.sharedLocalTurn) {
    return session.sharedLocalTurn.turnId
  }
  return null
}

function withNormalizedMessage(event: DesktopEvent): DesktopEvent {
  if (event.type !== 'message') {
    return event
  }
  const normalized = normalizeJarvisMessageEvent(event.message, {
    sessionId: runtimeState.sessionId,
    turnId: getActiveTurnIdForNormalization(),
  })
  messageFlowCounters.normalizedMessageCount += 1
  return { ...event, normalized }
}

function logMessageFlowCounters(reason: string): void {
  console.debug(
    '[jarvis-message-flow]',
    JSON.stringify({
      reason,
      parsedChildLineCount: messageFlowCounters.parsedChildLineCount,
      normalizedMessageCount: messageFlowCounters.normalizedMessageCount,
      droppedChildLineCount: messageFlowCounters.droppedChildLineCount,
    }),
  )
}

function emit(event: DesktopEvent): void {
  const withNormalization = withNormalizedMessage(event)
  remember(withNormalization)
  broadcast(withNormalization)
}

function updateRuntimeState(
  patch: Partial<DesktopRuntimeState> & {
    label: string
    tone: DesktopRuntimeState['tone']
  },
): void {
  runtimeState = {
    ...runtimeState,
    ...patch,
    running: patch.running ?? session !== null,
    busy: patch.busy ?? runtimeState.busy,
    backend: patch.backend ?? runtimeState.backend,
    mode: patch.mode ?? runtimeState.mode,
    model: patch.model ?? runtimeState.model,
    workspacePath: patch.workspacePath ?? runtimeState.workspacePath,
    sessionId: patch.sessionId ?? runtimeState.sessionId,
  }
  emit({
    type: 'state',
    state: runtimeState,
  })
}

function getSnapshot(): SnapshotEvent {
  return {
    type: 'snapshot',
    state: runtimeState,
    pendingPermissions: getPendingPermissions(),
    events: recentEvents,
    wsl2Sandbox: wsl2SandboxStatus,
  }
}

function resolveCliCommand(): string[] {
  // Injected by the Electron main process (which runs as Jarvis.exe and can
  // reliably find ClaudeCodeCli.exe next to itself via dirname(process.execPath)).
  // JarvisWorker.exe lives in resources/bin/ and cannot derive this on its own.
  const injectedCli = process.env.JARVIS_CLI_EXE?.trim()
  if (injectedCli && existsSync(injectedCli)) {
    return [injectedCli]
  }

  // Dev fallback: when running without the Electron wrapper (e.g. bun run launcher.ts directly)
  const siblingCli = join(dirname(process.execPath), 'ClaudeCodeCli.exe')
  if (existsSync(siblingCli)) {
    return [siblingCli]
  }

  const repoCli = join(workspaceRoot, 'dist-desktop', 'ClaudeCodeCli.exe')
  if (existsSync(repoCli)) {
    return [repoCli]
  }

  const bunCandidates = [
    process.env.BUN_EXE,
    process.execPath,
    process.argv0,
    typeof Bun !== 'undefined' && typeof Bun.which === 'function'
      ? Bun.which('bun')
      : null,
  ]

  // Use absolute path: spawn cwd is the user's workspace, not the repo root
  const cliEntry = join(workspaceRoot, 'entrypoints', 'cli.tsx')

  for (const candidate of bunCandidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      continue
    }
    const normalizedCandidate = candidate.trim()
    if (!existsSync(normalizedCandidate)) {
      continue
    }
    if (/^bun(?:\.exe)?$/i.test(basename(normalizedCandidate))) {
      return [normalizedCandidate, 'run', cliEntry]
    }
  }

  return ['bun', 'run', cliEntry]
}

function hasPackagedCliRuntime(): boolean {
  return existsSync(join(workspaceRoot, 'node_modules', 'vscode-jsonrpc', 'node.js'))
}

function resolveSourceCliCommand(): string[] {
  // Same injected-path logic as resolveCliCommand() — prefer the compiled binary
  // (starts in ~1 s) over bun JIT from source (30–90 s cold start).
  const injectedCli = process.env.JARVIS_CLI_EXE?.trim()
  if (injectedCli && existsSync(injectedCli)) {
    return [injectedCli]
  }

  const siblingCli = join(dirname(process.execPath), 'ClaudeCodeCli.exe')
  if (existsSync(siblingCli)) {
    return [siblingCli]
  }

  const repoCli = join(workspaceRoot, 'dist-desktop', 'ClaudeCodeCli.exe')
  if (existsSync(repoCli)) {
    return [repoCli]
  }

  // Fall back to source. Resolve bun via parent-process candidates so we get
  // the real bun.exe path rather than relying on PATH in the child environment
  // (Windows PATH in spawned processes can differ from the shell PATH).
  const bunCandidates = [
    process.env.BUN_EXE,
    process.execPath,
    process.argv0,
    typeof Bun !== 'undefined' && typeof Bun.which === 'function'
      ? Bun.which('bun')
      : null,
  ]

  // Absolute path — spawn cwd is the user's workspace, not the repo root
  const cliEntry = join(workspaceRoot, 'entrypoints', 'cli.tsx')

  for (const candidate of bunCandidates) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue
    const normalizedCandidate = candidate.trim()
    if (!existsSync(normalizedCandidate)) continue
    if (/^bun(?:\.exe)?$/i.test(basename(normalizedCandidate))) {
      return [normalizedCandidate, 'run', cliEntry]
    }
  }

  return ['bun', 'run', cliEntry]
}

function isLocalSafeMode(config: LauncherConfig): boolean {
  return shouldUseInProcessOllamaSession(config)
}

function isSharedLocalRuntime(config: LauncherConfig): boolean {
  return config.backend === 'ollama' && !isLocalSafeMode(config)
}

function getRuntimeModeForConfig(config: LauncherConfig): RuntimeMode {
  if (config.backend === 'anthropic') {
    return 'anthropic'
  }
  if (config.backend === 'remote-glm') {
    return 'remote-glm'
  }
  return isLocalSafeMode(config) ? 'ollama-legacy' : 'ollama-shared'
}

function getConfiguredSessionModel(config: LauncherConfig): string {
  if (config.backend === 'anthropic') {
    return config.anthropicModel.trim()
  }
  if (config.backend === 'remote-glm') {
    return config.remoteGlmModel.trim()
  }
  return config.ollamaModel.trim()
}

function getRestoredLocalConversation(config: LauncherConfig): {
  history: LocalChatMessage[]
  summary: string
} {
  const shouldRestore =
    persistedState.runtimeState.workspacePath === config.workspacePath.trim()
  const restoredHistory = shouldRestore ? persistedState.lastLocalHistory : []
  const restoredSummary = shouldRestore ? persistedState.lastLocalSummary : ''
  return compactLocalConversation(restoredHistory, restoredSummary)
}

function isRemoteGlmMode(config: LauncherConfig): boolean {
  return config.backend === 'remote-glm'
}

function normalizeStartSessionPayload(payload: unknown): {
  config: Partial<LauncherConfig>
  launchIntroPrompt: string | null
} {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      config: {},
      launchIntroPrompt: null,
    }
  }

  const raw = payload as Record<string, unknown>
  const config =
    raw.config && typeof raw.config === 'object' && !Array.isArray(raw.config)
      ? (raw.config as Partial<LauncherConfig>)
      : (() => {
          const copy = { ...raw }
          delete copy.config
          delete copy.launchIntroPrompt
          return copy as Partial<LauncherConfig>
        })()
  const launchIntroPrompt =
    typeof raw.launchIntroPrompt === 'string' &&
    raw.launchIntroPrompt.trim().length > 0
      ? raw.launchIntroPrompt.trim()
      : null

  return {
    config,
    launchIntroPrompt,
  }
}

function normalizeRemoteGlmBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) {
    return ''
  }
  return trimmed.replace(/\/(?:healthz|v1(?:\/messages)?)$/i, '')
}

function getRemoteGlmHealthUrl(baseUrl: string): string {
  return `${normalizeRemoteGlmBaseUrl(baseUrl)}/healthz`
}

function getLocalPluginCacheDir(): string {
  return join(dirname(getConfigPath()), 'local-plugin-cache')
}

function getOllamaMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) {
    return 'http://localhost:11434/v1/messages'
  }
  return trimmed.endsWith('/v1') ? `${trimmed}/messages` : `${trimmed}/v1/messages`
}

function getOllamaApiUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) {
    return `http://localhost:11434${path}`
  }
  return trimmed.endsWith('/v1')
    ? `${trimmed.slice(0, -3)}${path}`
    : `${trimmed}${path}`
}

function getOllamaTagsUrl(baseUrl: string): string {
  return getOllamaApiUrl(baseUrl, '/api/tags')
}

function getLlamaCppBaseUrl(): string {
  return `http://${LLAMA_CPP_HOST}:${LLAMA_CPP_PORT}`
}

function getLlamaCppHealthUrl(): string {
  return `${getLlamaCppBaseUrl()}/health`
}

function getLlamaCppChatUrl(): string {
  return `${getLlamaCppBaseUrl()}/v1/chat/completions`
}

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase()
}

function isQwopusModel(model: string): boolean {
  return normalizeModelName(model) === normalizeModelName(QWOPUS_OLLAMA_MODEL)
}

function getLlamaServerPath(): string | null {
  const candidates = [
    process.env.LLAMA_SERVER_PATH?.trim(),
    join(
      process.env.LOCALAPPDATA ??
        join(homedir(), 'AppData', 'Local'),
      'Microsoft',
      'WinGet',
      'Packages',
      'ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe',
      'llama-server.exe',
    ),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'llama.cpp', 'llama-server.exe'),
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

async function getQwopusBlobPath(): Promise<string> {
  const manifestPath = join(
    homedir(),
    '.ollama',
    'models',
    'manifests',
    'registry.ollama.ai',
    'library',
    'qwopus3.5-9b-v3',
    'q4km',
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    layers?: Array<{ mediaType?: string; digest?: string }>
  }
  const modelLayer = manifest.layers?.find(layer =>
    layer.mediaType === 'application/vnd.ollama.image.model' &&
    typeof layer.digest === 'string',
  )
  if (!modelLayer?.digest) {
    throw new Error('Unable to locate the Qwopus GGUF blob in the Ollama manifest.')
  }

  const blobPath = join(
    homedir(),
    '.ollama',
    'models',
    'blobs',
    modelLayer.digest.replace(':', '-'),
  )
  if (!existsSync(blobPath)) {
    throw new Error(`Qwopus GGUF blob is missing at ${blobPath}.`)
  }
  return blobPath
}

async function waitForHttpHealth(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now()
  let lastError = 'No response yet.'
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
      lastError = `Health check returned ${response.status}.`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await Bun.sleep(250)
  }
  throw new Error(`Timed out waiting for llama.cpp to become healthy. ${lastError}`)
}

function extractAssistantBlocks(
  response: any,
): Array<{ type: 'text'; text: string }> {
  if (!Array.isArray(response?.content)) {
    return []
  }
  return response.content
    .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
    .map((block: any) => ({
      type: 'text' as const,
      text: block.text,
    }))
}

function extractAssistantBlocksFromChatContent(
  content: unknown,
): Array<{ type: 'text'; text: string }> {
  if (typeof content !== 'string') {
    return []
  }
  return [
    {
      type: 'text',
      text: content,
    },
  ]
}

function cleanLocalAssistantText(content: string): string {
  return content
    .replace(/<\/?think>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function getCompanionSystemPrompt(): string {
  return getDesktopCompanionIntro()?.text ?? ''
}

function getEffectiveSystemPrompt(
  config: LauncherConfig,
  conversationSummary = '',
): string {
  const companionPrompt = getCompanionSystemPrompt()
  if (config.backend !== 'ollama') {
    return [config.appendSystemPrompt.trim(), companionPrompt]
      .filter(Boolean)
      .join('\n\n')
  }

  const toolsAvailable = !isLocalSafeMode(config)
  // Shared child-runtime and safe-mode chat use the native tool contract.
  // The legacy ReAct JSON framing stays reserved for the direct Ollama loop.
  const localPrompt = buildLocalCompatibilityPrompt({
    model: config.ollamaModel.trim() || AGENTIC_OLLAMA_MODEL,
    disableToolsForLocal: !toolsAvailable,
    enableExperimentalLocalTools: toolsAvailable,
    disableThinkingForLocal: config.disableThinkingForLocal,
    toolPromptStyle: 'native-tool-use',
    appendSystemPrompt: config.appendSystemPrompt,
    conversationSummary,
  })
  const sharedLocalEnvelopeInstruction =
    !isLocalSafeMode(config)
      ? [
          'Shared local runtime note:',
          'User turns may arrive wrapped in a read-only context envelope.',
          'Treat any content between <<<JARVIS_SHARED_LOCAL_CONTEXT>>> and <<<END_JARVIS_SHARED_LOCAL_CONTEXT>>> as background context only.',
          'Treat the text between <<<JARVIS_USER_REQUEST>>> and <<<END_JARVIS_USER_REQUEST>>> as the actual user request.',
        ].join(' ')
      : ''
  return [localPrompt, sharedLocalEnvelopeInstruction, companionPrompt]
    .filter(Boolean)
    .join('\n\n')
}

function isSharedLocalSession(target: ActiveSession | null): target is ActiveChildSession {
  return Boolean(target && target.kind === 'claude' && isSharedLocalRuntime(target.config))
}

function createSharedLocalTurnState(userContent: string): SharedLocalTurnState {
  return {
    turnId: randomUUID(),
    userContent,
    assistantText: '',
    assistantEventSeen: false,
    toolSteps: [],
    toolStepsById: new Map(),
    startedAt: Date.now(),
    completedAt: null,
    resultSubtype: null,
    resultText: '',
    finalized: false,
  }
}

function appendConversationHistory(
  target: { history: LocalChatMessage[]; summary: string },
  message: LocalChatMessage,
): void {
  target.history.push(message)
  const compacted = compactLocalConversation(target.history, target.summary)
  target.history = compacted.history
  target.summary = compacted.summary
  schedulePersist()
}

function unwrapSharedLocalPrompt(content: string): string {
  const marker = '<<<JARVIS_USER_REQUEST>>>'
  const endMarker = '<<<END_JARVIS_USER_REQUEST>>>'
  const start = content.indexOf(marker)
  const end = content.indexOf(endMarker)
  if (start === -1 || end === -1 || end <= start) {
    return content.trim()
  }
  return content.slice(start + marker.length, end).trim()
}

function buildChildEnv(config: LauncherConfig): Record<string, string> {
  const env = { ...process.env } as Record<string, string>
  env.CLAUDE_CODE_ENTRYPOINT = 'desktop'
  // Force external build variant — the CLI source tree is the ant/internal
  // build and inherits USER_TYPE=ant from the parent shell on developer
  // machines. That enables ant-only GrowthBook model-override lookups which
  // block indefinitely without Anthropic credentials. Pin to 'external' so
  // the child behaves identically to a published binary.
  env.USER_TYPE = 'external'
  delete env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS
  delete env.CLAUDE_CODE_DISABLE_THINKING
  delete env.OLLAMA_NEW_ENGINE
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR
  delete env.CLAUDE_CODE_FAST_INIT
  if (config.coordinatorMode) {
    env.CLAUDE_CODE_COORDINATOR_MODE = '1'
  } else {
    delete env.CLAUDE_CODE_COORDINATOR_MODE
  }

  if (config.disableNonessentialTraffic) {
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
  } else {
    delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC
  }

  delete env.CLAUDE_CODE_DISABLE_THINKING
  delete env.OLLAMA_NEW_ENGINE
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR

  if (config.backend === 'anthropic') {
    env.CLAUDE_CODE_COMPAT_MODE = 'native'
    if (config.anthropicApiKey.trim()) {
      env.ANTHROPIC_API_KEY = config.anthropicApiKey.trim()
    }
    if (config.anthropicBaseUrl.trim()) {
      env.ANTHROPIC_BASE_URL = config.anthropicBaseUrl.trim()
    } else {
      delete env.ANTHROPIC_BASE_URL
    }
    if (config.anthropicModel.trim()) {
      env.ANTHROPIC_MODEL = config.anthropicModel.trim()
    }
    return env
  }

  if (config.backend === 'remote-glm') {
    env.CLAUDE_CODE_COMPAT_MODE = 'generic'
    env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
    env.ANTHROPIC_BASE_URL = normalizeRemoteGlmBaseUrl(config.remoteGlmBaseUrl)
    env.ANTHROPIC_API_KEY = config.remoteGlmApiKey.trim()
    env.ANTHROPIC_MODEL = config.remoteGlmModel.trim() || 'gpt-oss-auto'
    return env
  }

  env.OLLAMA_BASE_URL =
    config.ollamaBaseUrl.trim() || 'http://localhost:11434/v1'
  env.OLLAMA_MODEL = config.ollamaModel.trim() || AGENTIC_OLLAMA_MODEL
  env.CLAUDE_CODE_COMPAT_MODE = 'ollama'
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
  env.OLLAMA_NEW_ENGINE = 'true'

  // Trick the Anthropic SDK into routing to Ollama
  env.ANTHROPIC_BASE_URL = env.OLLAMA_BASE_URL
  env.ANTHROPIC_API_KEY = 'ollama-dummy-key'
  env.ANTHROPIC_MODEL = env.OLLAMA_MODEL

  if (isSharedLocalRuntime(config)) {
    env.CLAUDE_CODE_SIMPLE = '1'
    env.CLAUDE_CODE_FAST_INIT = '1'
    // vscode-jsonrpc is --external in the ClaudeCodeCli.exe bun build; ship it
    // alongside the binary and point NODE_PATH at it so the binary can resolve it.
    const cliNodePath = process.env.JARVIS_NODE_PATH?.trim()
    if (cliNodePath) {
      const existing = env.NODE_PATH ?? ''
      env.NODE_PATH = existing ? `${cliNodePath}${delimiter}${existing}` : cliNodePath
    }
  }

  if (config.disableThinkingForLocal) {
    env.CLAUDE_CODE_DISABLE_THINKING = '1'
  }
  if (isLocalSafeMode(config)) {
    env.CLAUDE_CODE_PLUGIN_CACHE_DIR = getLocalPluginCacheDir()
  }
  return env
}

function buildCliArgs(
  config: LauncherConfig,
): string[] {
  const args = [
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
  ]

  const model =
    config.backend === 'anthropic'
      ? config.anthropicModel.trim()
      : config.backend === 'remote-glm'
        ? config.remoteGlmModel.trim()
        : config.ollamaModel.trim()
  if (model) {
    args.push('--model', model)
  }

  if (config.backend === 'ollama' && config.disableThinkingForLocal) {
    args.push('--thinking', 'disabled')
  }

  if (isLocalSafeMode(config)) {
    args.push('--bare')
    args.push('--disable-slash-commands')
    args.push('--tools', '')
  } else if (isSharedLocalRuntime(config)) {
    // Skip keychain reads, hooks, LSP, plugin sync, prefetches so the child
    // can answer the initialize handshake well within the 45-second window.
    args.push('--bare')
    // Shared local Ollama sessions are expected to run without manual approval
    // pauses so tool calls can flow immediately.
    args.push('--permission-mode', 'bypassPermissions')
  }

  return args
}

function withCompanionIntroIfNeeded(
  target: ActiveChildSession,
  content: string,
): string {
  const companionIntro = getDesktopCompanionIntro()
  if (!companionIntro) {
    return content
  }
  if (target.companionIntroHatchedAt === companionIntro.hatchedAt) {
    return content
  }
  target.companionIntroHatchedAt = companionIntro.hatchedAt
  return `${companionIntro.text}\n\nUser message:\n${content}`
}

function scheduleLaunchIntroPrompt(target: ActiveChildSession): void {
  const launchIntroPrompt = target.launchIntroPrompt
  if (!launchIntroPrompt) {
    return
  }

  target.launchIntroPrompt = null
  target.suppressedLaunchIntroPrompt = launchIntroPrompt

  void sendPrompt(launchIntroPrompt).catch(error => {
    const message = error instanceof Error ? error.message : String(error)
    emit({
      type: 'stderr',
      line: `Launch intro prompt failed: ${message}`,
    })
    updateRuntimeState({
      label: 'Launch intro prompt failed',
      tone: 'error',
      busy: false,
    })
  })
}

function getChildSessionReadyLabel(config: LauncherConfig): string {
  return config.backend === 'anthropic'
    ? 'Anthropic session ready'
    : config.backend === 'remote-glm'
      ? `Remote GPT-OSS session ready / ${config.remoteGlmModel}`
      : isSharedLocalRuntime(config)
        ? `Local shared runtime ready / Ollama / ${config.ollamaModel}`
        : `Ollama session ready / ${config.ollamaModel}`
}

async function maybeActivateAgenticLocalFallback(
  activeConfig: LauncherConfig,
  sessionId: string,
  reason: string,
): Promise<boolean> {
  if (!isSharedLocalRuntime(activeConfig) || !activeConfig.enableAgenticLocalMode) {
    return false
  }

  emit({
      type: 'info',
      label: 'Local agent fallback',
      body:
        `${reason} ` +
        'Falling back to the legacy in-process Jarvis loop so the local session stays usable.',
    })

  let fallback: ActiveLocalSession | null = null
  try {
    await mkdir(getLocalPluginCacheDir(), { recursive: true })
    fallback = createLocalSession(activeConfig, sessionId)
    if (fallback.provider === 'llama-cpp') {
      await ensureQwopusRuntime(fallback)
    }
    session = fallback
    updateRuntimeState({
      label: fallback.readyLabel,
      tone: 'warning',
      busy: false,
      running: true,
      backend: 'ollama',
      mode: 'ollama-legacy',
      model: fallback.config.ollamaModel.trim() || AGENTIC_OLLAMA_MODEL,
      workspacePath: activeConfig.workspacePath,
      sessionId: fallback.id,
    })
    return true
  } catch (fallbackError) {
    const fallbackMessage =
      fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
    if (fallback?.runtimeChild && !fallback.runtimeChild.killed) {
      try {
        fallback.runtimeChild.kill()
      } catch {}
    }
    emit({
      type: 'stderr',
      line: `Local agent fallback failed: ${fallbackMessage}`,
    })
    return false
  }
}

async function handleFailedChildLaunch(
  target: ActiveChildSession | null,
  activeConfig: LauncherConfig,
  sessionId: string,
  reason: string,
): Promise<boolean> {
  if (target) {
    markLaunchHandshakeResolved(target)
    if (!target.child.killed) {
      try {
        target.child.kill()
      } catch {}
    }
  }

  if (session?.id === sessionId) {
    session = null
  }

  if (await maybeActivateAgenticLocalFallback(activeConfig, sessionId, reason)) {
    return true
  }

  const mode = getRuntimeModeForConfig(activeConfig)
  const model = getConfiguredSessionModel(activeConfig)

  updateRuntimeState({
    running: false,
    busy: false,
    label: 'Launch failed',
    tone: 'error',
    backend: activeConfig.backend,
    mode,
    model,
    workspacePath: activeConfig.workspacePath,
    sessionId: null,
  })
  return false
}

async function getInstalledOllamaModels(): Promise<string[]> {
  try {
    const response = await fetch(
      getOllamaTagsUrl(cachedConfig.ollamaBaseUrl.trim() || 'http://localhost:11434/v1'),
    )
    if (!response.ok) {
      throw new Error(await response.text())
    }
    const payload = await response.json()
    if (!Array.isArray(payload?.models)) {
      return []
    }
    return payload.models
      .map((model: any) => model?.model ?? model?.name)
      .filter((model: unknown): model is string => typeof model === 'string' && model.trim().length > 0)
  } catch {
    return []
  }
}

async function getRemoteGlmBridgeHealth(
  config: LauncherConfig,
): Promise<RemoteBridgeHealth> {
  const baseUrl = normalizeRemoteGlmBaseUrl(config.remoteGlmBaseUrl)
  const apiKey = config.remoteGlmApiKey.trim()

  if (!baseUrl) {
    return {
      ok: false,
      ready: false,
      baseUrl: '',
      message:
        'Add the GPT-OSS bridge URL to connect Jarvis to your remote server.',
      checkedAt: new Date().toISOString(),
    }
  }
  if (!apiKey) {
    return {
      ok: false,
      ready: false,
      baseUrl,
      message: 'Add the bridge API key before launching a remote Jarvis session.',
      checkedAt: new Date().toISOString(),
    }
  }

  const response = await fetch(getRemoteGlmHealthUrl(baseUrl), {
    headers: {
      'X-Api-Key': apiKey,
    },
  }).catch(error => ({
    ok: false,
    status: 0,
    json: async () => null,
    error: error instanceof Error ? error.message : String(error),
  }))

  if ('error' in response) {
    return {
      ok: false,
      ready: false,
      baseUrl,
      message: `Bridge health check failed: ${response.error}`,
      checkedAt: new Date().toISOString(),
    }
  }

  const payload = (await response.json().catch(() => null)) as
    | {
        ready?: boolean
        upstreams?: {
          primary?: { ok?: boolean; error?: string; model?: string }
          fast?: { ok?: boolean; error?: string; model?: string }
        }
      }
    | null

  if (!response.ok) {
    return {
      ok: false,
      ready: false,
      baseUrl,
      message:
        payload?.ready === false
          ? 'Bridge reachable, but the GPT-OSS upstreams are not ready yet.'
          : `Bridge health check returned ${response.status}.`,
      checkedAt: new Date().toISOString(),
      upstreams: payload?.upstreams,
    }
  }

  if (payload?.ready === false) {
    const primaryError = payload.upstreams?.primary?.error
    const fastError = payload.upstreams?.fast?.error
    const detail = [primaryError, fastError].filter(Boolean).join(' | ')
    return {
      ok: false,
      ready: false,
      baseUrl,
      message:
        detail ||
        'Bridge reachable, but the GPT-OSS upstreams are not ready yet.',
      checkedAt: new Date().toISOString(),
      upstreams: payload.upstreams,
    }
  }

  return {
    ok: true,
    ready: true,
    baseUrl,
    message: 'Remote GPT-OSS bridge is ready.',
    checkedAt: new Date().toISOString(),
    upstreams: payload?.upstreams,
  }
}

async function ensureRemoteGlmBridge(config: LauncherConfig): Promise<void> {
  const health = await getRemoteGlmBridgeHealth(config)
  if (!health.ok) {
    throw new Error(health.message)
  }
}

async function getModelCatalog(): Promise<ModelCatalogResponse> {
  const installedModels = await getInstalledOllamaModels()
  return {
    defaultModel: getRecommendedOllamaModel(installedModels),
    alternateModel: ALTERNATE_OLLAMA_MODEL,
    installedModels,
    models: getKnownModelCatalog(installedModels),
  }
}

async function sendLine(
  target: ActiveSession,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!isChildSession(target)) {
    throw new Error('This session does not accept Claude control messages.')
  }
  if (target.child.killed) {
    throw new Error('The CLI process is no longer running.')
  }
  if (target.child.stdin) {
    await target.child.stdin.write(`${JSON.stringify(payload)}\n`)
    await target.child.stdin.flush()
  }
}

async function processStreamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void> | void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line) {
        try {
          await onLine(line)
        } catch {
          // Never let a single bad line kill the stream processor
        }
      }
      newlineIndex = buffer.indexOf('\n')
    }
  }

  const tail = buffer.trim()
  if (tail) {
    try {
      await onLine(tail)
    } catch {}
  }
}

function removePermission(target: ActiveSession, requestId: string): void {
  const perm = target.pendingPermissions.get(requestId)
  if (perm?.timeoutHandle != null) {
    clearTimeout(perm.timeoutHandle)
  }
  if (target.pendingPermissions.delete(requestId)) {
    emit({
      type: 'permission_resolved',
      requestId,
    })
  }
}

async function handleStdoutLine(
  target: ActiveChildSession,
  line: string,
): Promise<void> {
  if (session?.id !== target.id) {
    return
  }
  messageFlowCounters.parsedChildLineCount += 1

  let parsed: any
  try {
    parsed = JSON.parse(line)
  } catch {
    messageFlowCounters.droppedChildLineCount += 1
    emit({
      type: 'stderr',
      line: `[stdout] ${line}`,
    })
    return
  }
  const normalizedParsed = normalizeJarvisMessageEvent(parsed, {
    sessionId: target.id,
    turnId: target.sharedLocalTurn?.turnId ?? null,
  })

  if (
    parsed?.type === 'control_request' &&
    parsed?.request?.subtype === 'can_use_tool'
  ) {
    const requestId: string = parsed.request_id
    const toolName: string = parsed.request.tool_name ?? ''
    const toolUseId: string = parsed.request.tool_use_id ?? ''
    const input: Record<string, unknown> = parsed.request.input ?? {}
    const description: string | undefined = parsed.request.description

    // ── 1. Sensitive path auto-deny ────────────────────────────────────────
    if (inputContainsSensitivePath(input)) {
      await respondToPermission(requestId, 'deny', false, toolUseId, input)
      emit({
        type: 'info',
        label: 'Permission auto-denied',
        body: `${toolName} was auto-denied: input targets a sensitive path.`,
      })
      return
    }

    // ── 2. Check denyAlways / allowAlways rules ────────────────────────────
    const rules = await loadPermissionRules()

    if (findMatchingRule(toolName, input, rules.denyAlways)) {
      await respondToPermission(requestId, 'deny', false, toolUseId, input)
      return
    }

    if (
      READ_ONLY_TOOLS.has(toolName) ||
      findMatchingRule(toolName, input, rules.allowAlways)
    ) {
      await respondToPermission(requestId, 'allow', false, toolUseId, input)
      return
    }

    // ── 3. No rule matched — show UI and start 30s auto-deny timeout ───────
    const permission: PendingPermission = {
      requestId,
      toolName,
      toolUseId,
      input,
      description,
    }

    const timeoutHandle = setTimeout(() => {
      if (target.pendingPermissions.has(requestId)) {
        void respondToPermission(requestId, 'deny', false, toolUseId, input).catch(() => {})
        emit({
          type: 'info',
          label: 'Permission timed out',
          body: `${toolName} was auto-denied after 30 seconds with no response.`,
        })
      }
    }, 30_000)

    permission.timeoutHandle = timeoutHandle
    target.pendingPermissions.set(requestId, permission)

    // Strip internal-only field before broadcasting to renderer
    const { timeoutHandle: _omit, ...permissionForRenderer } = permission
    emit({
      type: 'permission',
      ...permissionForRenderer,
    })
    return
  }


  if (parsed?.type === 'control_cancel_request') {
    removePermission(target, parsed.request_id)
    return
  }

  if (
    parsed?.type === 'control_response' &&
    parsed?.response?.request_id === target.initializeRequestId
  ) {
    if (parsed.response.subtype === 'success') {
      markLaunchHandshakeResolved(target)
      const modelCount = Array.isArray(parsed.response.response?.models)
        ? parsed.response.response.models.length
        : 0
      if (!target.hideLaunchTranscriptNoise) {
        emit({
          type: 'info',
          label: 'Session initialized',
          body: `Launcher handshake completed. ${modelCount} models were advertised by the CLI session.`,
        })
      }
      updateRuntimeState({
        label: getChildSessionReadyLabel(target.config),
        tone: 'running',
        busy: false,
      })
      scheduleLaunchIntroPrompt(target)
    } else {
      markLaunchHandshakeResolved(target)
      emit({
        type: 'stderr',
        line: `Initialization failed: ${parsed.response.error}`,
      })
      await handleFailedChildLaunch(
        target,
        target.config,
        target.id,
        `Initialization failed: ${parsed.response.error ?? 'unknown error'}.`,
      )
    }
    return
  }

  if (
    target.suppressedLaunchIntroPrompt &&
    parsed?.type === 'message' &&
    getParsedMessageRole(parsed) === 'user'
  ) {
    const content = getParsedMessageContent(parsed) ?? ''
    if (isThunderSessionIntroPrompt(String(content))) {
      target.suppressedLaunchIntroPrompt = null
      return
    }
  }

  if (target.suppressedLaunchIntroPrompt && getParsedMessageRole(parsed) === 'assistant') {
    target.suppressedLaunchIntroPrompt = null
    target.hideLaunchTranscriptNoise = false
  }

  let suppressSharedLocalPromptEcho = false
  if (isSharedLocalSession(target) && getParsedMessageRole(parsed) === 'user') {
    const content = getParsedMessageContent(parsed)
    const plainText = extractPlainTextFromContent(content)
    const unwrapped = unwrapSharedLocalPrompt(plainText || (typeof content === 'string' ? content : ''))
    if (unwrapped) {
      if (parsed.message?.message && typeof parsed.message.message === 'object') {
        parsed.message.message.content = unwrapped
      } else if (parsed.message && typeof parsed.message === 'object') {
        parsed.message.content = unwrapped
      } else if (typeof parsed === 'object' && parsed) {
        parsed.content = unwrapped
      }
    }
    suppressSharedLocalPromptEcho = isSharedLocalPromptEcho(target, parsed)
  }

  if (!isSharedLocalSession(target)) {
    if (normalizedParsed.kind === 'result') {
      updateRuntimeState({
        label: getChildSessionReadyLabel(target.config),
        tone: 'running',
        busy: false,
      })
    }
  }

  if (!suppressSharedLocalPromptEcho) {
    emit({
      type: 'message',
      message: parsed,
    })
  }

  if (isSharedLocalSession(target)) {
    await recordSharedLocalTurnEvent(target, parsed)
    const parsedSubtype = getParsedResultSubtype(parsed)
    if (normalizedParsed.kind === 'result') {
      if (parsedSubtype === 'success') {
        triggerSessionEventReaction('turn_complete')
      } else {
        triggerSessionEventReaction('session_error', parsedSubtype ?? 'result')
      }
      await finalizeSharedLocalTurn(target, parsed)
      return
    }
  }

  // Companion reactions keyed to session events
  if (parsed?.type === 'message') {
    const role = getParsedMessageRole(parsed)
    const content = getParsedMessageContent(parsed)
    if (role === 'assistant' && Array.isArray(content)) {
      const hasToolUse = content.some(
        (block: any) => block?.type === 'tool_use' || block?.type === 'server_tool_use',
      )
      const hasToolError = content.some(
        (block: any) => block?.type === 'tool_result' && block?.is_error === true,
      )
      const hasThinking = content.some(
        (block: any) => block?.type === 'thinking',
      )
      if (hasToolError) {
        triggerSessionEventReaction('tool_error')
      } else if (hasToolUse) {
        triggerSessionEventReaction('tool_call')
      } else if (hasThinking) {
        triggerSessionEventReaction('thinking')
      }
    }
    if (role === 'result' && getParsedResultSubtype(parsed) === 'success') {
      triggerSessionEventReaction('turn_complete')
    }
  }

  if (target.config.backend === 'ollama' && target.config.enableExperimentalLocalTools) {
    const inspection = inspectToolLoop(target.toolLoopGuard, parsed)
    target.toolLoopGuard = inspection.nextState
    if (inspection.warning) {
      emit({
        type: 'info',
        label: 'Local tool guard',
        body: inspection.warning,
      })
    }
    if (inspection.shouldStop) {
      void stopSession(
        'Stopped experimental local tool session after repeated identical tool calls',
      )
    }
  }

  if (normalizedParsed.isTerminal || messageFlowCounters.parsedChildLineCount % 50 === 0) {
    logMessageFlowCounters(
      normalizedParsed.isTerminal ? 'terminal-event' : 'stream-progress',
    )
  }
}

function watchSession(target: ActiveChildSession): void {
  void processStreamLines(target.child.stdout, line =>
    handleStdoutLine(target, line),
  )
  void processStreamLines(target.child.stderr, line => {
    if (session?.id !== target.id) {
      return
    }
    emit({
      type: 'stderr',
      line,
    })
  })

  void target.child.exited.then(code => {
    clearLaunchHandshakeTimer(target)
    if (session?.id !== target.id) {
      return
    }
    stopIdleHeartbeat()
    if (isSharedLocalSession(target) && code !== 0 && target.sharedLocalTurn) {
      triggerSessionEventReaction('session_error', `exit ${code}`)
    }
    if (
      !target.launchHandshakeResolved &&
      target.config.backend === 'ollama' &&
      target.config.enableAgenticLocalMode
    ) {
      void handleFailedChildLaunch(
        target,
        target.config,
        target.id,
        `The Claude child runtime exited with code ${code} before initialization completed.`,
      )
      return
    }
    session = null
    updateRuntimeState({
      running: false,
      busy: false,
      label:
        code === 0 ? 'Session ended cleanly' : `Session exited with code ${code}`,
      tone: code === 0 ? 'idle' : 'error',
      mode: 'idle',
      sessionId: null,
    })
    emit({
      type: 'info',
      label: 'Process exit',
      body: `CLI exited with code ${code}.`,
    })
  })
}

async function stopSession(label = 'Session stopped'): Promise<void> {
  const active = session
  if (!active) {
    return
  }

  session = null
  for (const requestId of active.pendingPermissions.keys()) {
    emit({
      type: 'permission_resolved',
      requestId,
    })
  }
  active.pendingPermissions.clear()

  if (isChildSession(active)) {
    markLaunchHandshakeResolved(active)
    try {
      active.child.stdin?.end()
    } catch {}
    try {
      active.child.kill()
    } catch {}
    await active.child.exited.catch(() => undefined)
  } else if (active.inFlightAbort) {
    active.inFlightAbort.abort()
    active.inFlightAbort = null
  }

  if (isLocalSession(active) && active.runtimeChild) {
    try {
      active.runtimeChild.kill()
    } catch {}
    await active.runtimeChild.exited.catch(() => undefined)
  }

  // Companion session-end reaction + stop idle heartbeat
  stopIdleHeartbeat()
  if (
    (isLocalSession(active) && active.config.enableAgenticLocalMode) ||
    isSharedLocalSession(active)
  ) {
    triggerSessionEventReaction('turn_complete')
  }

  updateRuntimeState({
    running: false,
    busy: false,
    label,
    tone: 'idle',
    mode: 'idle',
    sessionId: null,
  })
}

function createLocalSession(
  config: LauncherConfig,
  sessionId: string,
): ActiveLocalSession {
  const compacted = getRestoredLocalConversation(config)

  const provider = isQwopusModel(config.ollamaModel) ? 'llama-cpp' : 'ollama'
  const rawModel = config.ollamaModel.trim() || AGENTIC_OLLAMA_MODEL

  // Phase 0.1: Model enforcement — silently prefer the instruct model for agentic
  // sessions. qwen2.5-coder lacks the instruct fine-tuning for ReAct format and is
  // the #1 cause of "Action without Thought" violations seen in production chat logs.
  //
  // Strategy: if the configured model name is a known non-instruct model (coder, base,
  // q4_0, etc.), override to AGENTIC_OLLAMA_MODEL. We can't query installed models
  // synchronously here, so we rely on the name pattern. The user can still run a
  // non-instruct model by explicitly picking it — this only fires when the coder
  // variant is the *default* selection.
  let model = rawModel
  if (config.enableAgenticLocalMode && provider === 'ollama') {
    const normalizedRaw = rawModel.trim().toLowerCase()
    const isNonInstructModel = (
      normalizedRaw.includes('coder') ||
      (normalizedRaw.includes('qwen') && !normalizedRaw.includes('instruct') && !normalizedRaw.includes('qwopus'))
    )
    if (isNonInstructModel) {
      model = AGENTIC_OLLAMA_MODEL
      emit({
        type: 'info',
        label: 'Model override',
        body: `Switched from "${rawModel}" → "${AGENTIC_OLLAMA_MODEL}" for agentic mode. The coder variant lacks instruct fine-tuning needed for reliable ReAct format. If "${AGENTIC_OLLAMA_MODEL}" is not installed, run: ollama pull ${AGENTIC_OLLAMA_MODEL}`,
      })
    } else if (!isAgenticModel(rawModel)) {
      // Non-instruct, non-coder — warn but don't override (could be a custom model)
      emit({
        type: 'info',
        label: 'Model warning',
        body: `"${rawModel}" may not support reliable ReAct format in agentic mode. For best results use: ${AGENTIC_OLLAMA_MODEL}`,
      })
    }
  }

    return {
      kind: 'ollama-legacy',
      id: sessionId,
      provider,
      pendingPermissions: new Map(),
    config: {
      ...config,
      localRuntimeEngine: 'legacy-inprocess',
      ollamaModel: model,
    },
    history: compacted.history,
    summary: compacted.summary,
    inFlightAbort: null,
    runtimeChild: null,
    requestUrl:
      provider === 'llama-cpp'
        ? getLlamaCppChatUrl()
        : getOllamaMessagesUrl(config.ollamaBaseUrl.trim() || 'http://localhost:11434/v1'),
    readyLabel:
      provider === 'llama-cpp'
        ? `Legacy local runtime ready / llama.cpp / ${model}`
        : config.enableAgenticLocalMode
          ? `Local agentic session ready / Ollama / ${model}`
          : `Local safe mode ready / Ollama / ${model}`,
    busyLabel:
      provider === 'llama-cpp'
        ? `Querying local llama.cpp runtime / ${model}`
        : config.enableAgenticLocalMode
          ? `Running local agentic loop / Ollama / ${model}`
          : `Querying Ollama / ${model}`,
    visiblePromptCount: 0,
    reactViolationCount: 0,
  }
}

function watchLlamaCppRuntime(target: ActiveLocalSession): void {
  if (!target.runtimeChild) {
    return
  }

  void processStreamLines(target.runtimeChild.stderr, line => {
    const normalized = line.trim()
    if (!normalized) {
      return
    }
    if (/error|failed|exception/i.test(normalized)) {
      emit({
        type: 'stderr',
        line: `[llama.cpp] ${normalized}`,
      })
    }
  })

  void target.runtimeChild.exited.then(code => {
    if (session?.id !== target.id) {
      return
    }
    stopIdleHeartbeat()
    session = null
    updateRuntimeState({
      running: false,
      busy: false,
      label:
        code === 0
          ? 'Legacy local runtime stopped'
          : `Legacy local runtime exited with code ${code}`,
      tone: code === 0 ? 'idle' : 'error',
      mode: 'idle',
      sessionId: null,
    })
    emit({
      type: 'info',
      label: 'Local runtime exit',
      body: `llama.cpp exited with code ${code}.`,
    })
  })
}

async function ensureQwopusRuntime(target: ActiveLocalSession): Promise<void> {
  const llamaServerPath = getLlamaServerPath()
  if (!llamaServerPath) {
    throw new Error(
      'llama-server.exe was not found. Install llama.cpp or set LLAMA_SERVER_PATH.',
    )
  }

  const modelBlobPath = await getQwopusBlobPath()
  const child = Bun.spawn(
    [
      llamaServerPath,
      '--model',
      modelBlobPath,
      '--host',
      LLAMA_CPP_HOST,
      '--port',
      String(LLAMA_CPP_PORT),
      '--ctx-size',
      String(LOCAL_SAFE_NUM_CTX),
      '--n-gpu-layers',
      LLAMA_CPP_GPU_LAYERS,
      '--batch-size',
      '128',
      '--ubatch-size',
      '64',
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  target.runtimeChild = child
  watchLlamaCppRuntime(target)
  await waitForHttpHealth(getLlamaCppHealthUrl(), 30000)
}

async function startSession(payload: unknown): Promise<void> {
  const { config, launchIntroPrompt } = normalizeStartSessionPayload(payload)
  if (session) {
    await stopSession('Restarting session')
  }

  const activeConfig: LauncherConfig = {
    ...getDefaultConfig(workspaceRoot),
    ...config,
    workspacePath:
      typeof config.workspacePath === 'string' && config.workspacePath.trim()
        ? config.workspacePath.trim()
        : workspaceRoot,
  }
  const restoredLocalConversation =
    activeConfig.backend === 'ollama'
      ? getRestoredLocalConversation(activeConfig)
      : null

  const sessionId = randomUUID()
  const mode = getRuntimeModeForConfig(activeConfig)
  const model = getConfiguredSessionModel(activeConfig)
  const initializeAppendSystemPrompt = getEffectiveSystemPrompt(
    activeConfig,
    restoredLocalConversation?.summary ?? '',
  )

  if (activeConfig.backend === 'ollama') {
    const installedModels = await getInstalledOllamaModels()
    const requestedModel = activeConfig.ollamaModel.trim() || AGENTIC_OLLAMA_MODEL
    if (installedModels.length > 0 && !installedModels.includes(requestedModel)) {
      throw new Error(
        `Selected local model "${requestedModel}" is not installed. Install it first or choose one of: ${installedModels.join(', ')}`,
      )
    }
  }

  if (isRemoteGlmMode(activeConfig)) {
    await ensureRemoteGlmBridge(activeConfig)
  }

  runtimeState = {
    ...runtimeState,
    running: true,
    busy: !isLocalSafeMode(activeConfig),
    label:
      activeConfig.backend === 'anthropic'
        ? 'Launching Anthropic session'
        : activeConfig.backend === 'remote-glm'
          ? `Connecting to rented GPT-OSS server / ${activeConfig.remoteGlmModel}`
        : isLocalSafeMode(activeConfig)
          ? isQwopusModel(activeConfig.ollamaModel)
            ? `Starting local llama.cpp runtime / ${activeConfig.ollamaModel}`
            : activeConfig.enableAgenticLocalMode
              ? `Starting local agentic Ollama session / ${activeConfig.ollamaModel}`
              : `Starting local safe mode / Ollama / ${activeConfig.ollamaModel}`
          : `Launching local shared runtime / Ollama / ${activeConfig.ollamaModel}`,
    tone: 'running',
    backend: activeConfig.backend,
    mode,
    model:
      activeConfig.backend === 'anthropic'
        ? activeConfig.anthropicModel.trim()
        : activeConfig.backend === 'remote-glm'
          ? activeConfig.remoteGlmModel.trim()
          : activeConfig.ollamaModel.trim(),
    workspacePath: activeConfig.workspacePath,
    sessionId,
  }
  emit({
    type: 'state',
    state: runtimeState,
  })
  try {
    if (isLocalSafeMode(activeConfig)) {
      await mkdir(getLocalPluginCacheDir(), { recursive: true })
      const active = createLocalSession(activeConfig, sessionId)
      session = active
      if (active.provider === 'llama-cpp') {
        await ensureQwopusRuntime(active)
      }
      emit({
        type: 'info',
        label: 'Launch mode',
        body:
          active.provider === 'llama-cpp'
            ? `Using llama.cpp local mode with ${active.config.ollamaModel}. Local tools stay disabled here while Jarvis keeps the stable chat path available.`
            : activeConfig.enableAgenticLocalMode
              ? `Using the legacy in-process Jarvis agent loop with ${active.config.ollamaModel}. All tool use stays local.`
              : `Using direct Ollama safe mode with ${active.config.ollamaModel}. Tools are disabled in this path while Jarvis keeps the stable local fallback available.`,
      })
      // Companion wakes up with a session-start greeting
      if (activeConfig.enableAgenticLocalMode) {
        triggerSessionEventReaction('session_start')
      }

      // Start idle heartbeat for companion reactions during quiet periods
      startIdleHeartbeat()

      // Emit Jarvis session greeting on first-ever session (empty history)
      const hadPriorHistory = active.history.length > 0 || Boolean(active.summary)
      if (!hadPriorHistory && activeConfig.enableAgenticLocalMode) {
        const buddySnap = getDesktopBuddySnapshot()
        const companionName = buddySnap.hatched ? buddySnap.name : null
        const greeting = companionName
          ? `Session open. I'm Jarvis — ${companionName} is on the rail. What can I help you with?`
          : `Session open. I'm Jarvis, your local AI agent. What can I help you with?`
        emit({
          type: 'message',
          message: {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: greeting }] },
          },
        })
        appendLocalHistory(active, { role: 'assistant', content: greeting })
      }

      if (hadPriorHistory) {
        emit({
          type: 'info',
          label: 'Conversation restored',
          body: active.summary
            ? `Recovered prior local context with ${active.history.length} recent messages plus a compact session summary.`
            : `Recovered ${active.history.length} recent local messages from the previous desktop session.`,
        })
      }
      updateRuntimeState({
        label: active.readyLabel,
        tone: 'running',
        busy: false,
        backend: 'ollama',
        mode: 'ollama-legacy',
        model: active.config.ollamaModel,
        workspacePath: activeConfig.workspacePath,
        sessionId: active.id,
      })
      return
    }

    const command = [
      ...(isSharedLocalRuntime(activeConfig)
        ? resolveSourceCliCommand()
        : resolveCliCommand()),
      ...buildCliArgs(activeConfig),
    ]

    // ── Determine whether to launch inside WSL2 for bubblewrap sandboxing ──
    const baseEnv = buildChildEnv(activeConfig)
    let child: ReturnType<typeof Bun.spawn>

    if (activeConfig.useSandbox && wsl2SandboxStatus.available && wsl2SandboxStatus.distro) {
      const wslDistro = wsl2SandboxStatus.distro
      const wslCommand = buildWslCommand(wslDistro, command)
      const wslEnv = buildChildEnvForWsl(activeConfig, baseEnv)
      const wslCwd = wslPathOf(activeConfig.workspacePath)
      emit({
        type: 'info',
        label: 'WSL2 sandbox',
        body: `Launching CLI inside WSL2 distro "${wslDistro}" with bubblewrap sandboxing.`,
      })
      child = Bun.spawn(wslCommand, {
        cwd: activeConfig.workspacePath, // Bun cwd stays Windows; WSL handles Linux cwd via env
        env: wslEnv,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    } else {
      child = Bun.spawn(command, {
        cwd: activeConfig.workspacePath,
        env: baseEnv,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })
    }


    const active: ActiveChildSession = {
      kind: 'claude',
      id: sessionId,
      child,
      pendingPermissions: new Map(),
      initializeRequestId: randomUUID(),
      config: activeConfig,
      toolLoopGuard: createToolLoopGuardState(),
      companionIntroHatchedAt: getDesktopCompanionIntro()?.hatchedAt ?? null,
      launchIntroPrompt:
        activeConfig.backend === 'remote-glm' && launchIntroPrompt
          ? launchIntroPrompt
          : null,
      suppressedLaunchIntroPrompt: null,
      hideLaunchTranscriptNoise:
        activeConfig.backend === 'remote-glm' && Boolean(launchIntroPrompt),
      launchHandshakeTimer: null,
      launchHandshakeResolved: false,
      launchHandshakeWaiters: [],
      visiblePromptCount: 0,
      history: restoredLocalConversation?.history ?? [],
      summary: restoredLocalConversation?.summary ?? '',
      sharedLocalTurn: null,
    }

    session = active
    if (isSharedLocalRuntime(activeConfig) && restoredLocalConversation?.summary.trim()) {
      emit({
        type: 'info',
        label: 'Conversation restored',
        body:
          'Seeded the shared local runtime with the last compact local session summary so planning continuity carries over without reusing the legacy loop transcript verbatim.',
      })
    }
    if (isSharedLocalRuntime(activeConfig)) {
      triggerSessionEventReaction('session_start')
      startIdleHeartbeat()
    }
    active.launchHandshakeTimer = setTimeout(() => {
      const childAlive = !active.child.killed
      emit({
        type: 'info',
        label: 'Init timeout diagnosis',
        body: `Child process ${childAlive ? 'is still alive (stdin not processed)' : 'has already exited'} after ${Math.round(CHILD_LAUNCH_TIMEOUT_MS / 1000)} s without completing the initialize handshake. Falling back to legacy in-process loop.`,
      })
      void handleFailedChildLaunch(
        active,
        activeConfig,
        sessionId,
        `The Claude child runtime did not answer the initialize request within ${Math.round(CHILD_LAUNCH_TIMEOUT_MS / 1000)} seconds.`,
      )
    }, CHILD_LAUNCH_TIMEOUT_MS)
    if (!active.hideLaunchTranscriptNoise) {
      emit({
        type: 'info',
        label: 'Launch command',
        body:
          command.join(' ') +
          (activeConfig.backend === 'remote-glm'
            ? `\n\nRemote bridge: ${normalizeRemoteGlmBaseUrl(activeConfig.remoteGlmBaseUrl)}`
            : '') +
          (activeConfig.coordinatorMode
            ? '\n\nCoordinator mode is enabled for this session.'
            : ''),
      })
    }
    watchSession(active)

    await sendLine(active, {
      type: 'control_request',
      request_id: active.initializeRequestId,
      request: {
        subtype: 'initialize',
        promptSuggestions: false,
        agentProgressSummaries: true,
        appendSystemPrompt: initializeAppendSystemPrompt || undefined,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const active = session?.id === sessionId ? session : null
    if (active && isLocalSession(active) && active.runtimeChild && !active.runtimeChild.killed) {
      try {
        active.runtimeChild.kill()
      } catch {}
    }
    if (
      await handleFailedChildLaunch(
        active && isChildSession(active) ? active : null,
        activeConfig,
        sessionId,
        `The Claude child runtime could not start (${message}).`,
      )
    ) {
      return
    }
    throw error
  }
}

async function respondToPermission(
  requestId: string,
  decision: 'allow' | 'deny',
  permanent = false,
  // For auto-resolve calls where the permission isn't stored in pendingPermissions yet
  inlineToolUseId?: string,
  inlineInput?: Record<string, unknown>,
): Promise<void> {
  const active = session
  if (!active) {
    // During auto-deny the session may have been stopped; silently skip.
    return
  }
  if (!isChildSession(active)) {
    throw new Error('Legacy local runtime has no tool permission requests.')
  }

  // Prefer the stored permission; fall back to inline values for auto-resolve
  const permission = active.pendingPermissions.get(requestId)
  const resolvedInput = permission?.input ?? inlineInput ?? {}
  const resolvedToolUseId = permission?.toolUseId ?? inlineToolUseId ?? ''
  const resolvedToolName = permission?.toolName ?? ''

  // Persist the rule if the user chose a permanent decision
  if (permanent && resolvedToolName) {
    const inputHash = computeInputHash(resolvedToolName, resolvedInput)
    if (decision === 'allow') {
      await addPermissionRule('allowAlways', resolvedToolName, inputHash)
    } else {
      await addPermissionRule('denyAlways', resolvedToolName, inputHash)
    }
  }

  const response =
    decision === 'allow'
      ? {
          behavior: 'allow',
          updatedInput: resolvedInput,
          toolUseID: resolvedToolUseId,
          decisionClassification: permanent ? 'user_permanent' : 'user_temporary',
        }
      : {
          behavior: 'deny',
          message: 'Denied in Jarvis.',
          toolUseID: resolvedToolUseId,
          decisionClassification: 'user_reject',
        }

  await sendLine(active, {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response,
    },
  })
  removePermission(active, requestId)
}

function appendLocalHistory(
  target: { history: LocalChatMessage[]; summary: string },
  message: LocalChatMessage,
): void {
  appendConversationHistory(target, message)
}

async function sendLocalSafePrompt(
  target: ActiveLocalSession,
  content: string,
): Promise<void> {
  if (target.inFlightAbort) {
    throw new Error('Wait for the current local response before sending another prompt.')
  }

  const model = target.config.ollamaModel.trim() || AGENTIC_OLLAMA_MODEL

  emit({
    type: 'message',
    message: {
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    },
  })

  appendLocalHistory(target, {
    role: 'user',
    content,
  })

  const controller = new AbortController()
  target.inFlightAbort = controller
  updateRuntimeState({
    label: target.busyLabel,
    tone: 'running',
    busy: true,
  })

  try {
    const response =
      target.provider === 'llama-cpp'
        ? await fetch(target.requestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 96,
              temperature: 0,
              messages: [
                {
                  role: 'system',
                  content: getEffectiveSystemPrompt(target.config, target.summary),
                },
                ...target.history.map(message => ({
                  role: message.role,
                  content: message.content,
                })),
              ],
            }),
            signal: controller.signal,
          })
        : await fetch(target.requestUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 1024,
              messages: target.history.map(message => ({
                role: message.role,
                content: message.content,
              })),
              system: getEffectiveSystemPrompt(target.config, target.summary),
            }),
            signal: controller.signal,
          })

    if (!response.ok) {
      throw new Error(await response.text())
    }

    const payload = await response.json()
    const assistantBlocks =
      target.provider === 'llama-cpp'
        ? extractAssistantBlocksFromChatContent(payload?.choices?.[0]?.message?.content)
        : extractAssistantBlocks(payload)
    const assistantText = cleanLocalAssistantText(
      assistantBlocks.map(block => block.text).join('\n\n'),
    )

    if (!assistantText) {
      throw new Error(
        target.provider === 'llama-cpp'
          ? 'llama.cpp returned no assistant text.'
          : 'Ollama returned no assistant text.',
      )
    }

    appendLocalHistory(target, {
      role: 'assistant',
      content: assistantText,
    })
    emit({
      type: 'message',
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: assistantBlocks,
        },
      },
    })
    if (session?.id === target.id) {
      updateRuntimeState({
        label: target.readyLabel,
        tone: 'running',
        busy: false,
      })
    }
  } catch (error) {
    if (controller.signal.aborted) {
      emit({
        type: 'info',
        label: 'Interrupted',
        body:
          target.provider === 'llama-cpp'
            ? 'Stopped the in-flight llama.cpp request.'
            : 'Stopped the in-flight Ollama request.',
      })
      if (session?.id === target.id) {
        updateRuntimeState({
          label: target.readyLabel,
          tone: 'running',
          busy: false,
        })
      }
      return
    }

    const message = error instanceof Error ? error.message : String(error)
    emit({
      type: 'stderr',
      line: message,
    })
    if (session?.id === target.id) {
      updateRuntimeState({
        label:
          target.provider === 'llama-cpp'
            ? 'llama.cpp request failed'
            : 'Ollama request failed',
        tone: 'error',
        busy: false,
      })
    }
  } finally {
    if (target.inFlightAbort === controller) {
      target.inFlightAbort = null
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agentic local session — full ReAct loop with cloud brain context injection
// ─────────────────────────────────────────────────────────────────────────────

const MAX_AGENT_ITERATIONS = 12

/**
 * Some Ollama models (e.g. qwen2.5-coder) emit tool calls as a JSON object
 * in the message content field rather than using the tool_calls array.
 * Detect this and normalize into the standard tool_calls format.
 */
/** Try to parse a single tool-call object from a candidate JSON string. */
function parseSingleToolCall(candidate: string): any | null {
  try {
    const parsed = JSON.parse(candidate.trim())
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.name === 'string' &&
      parsed.name.length > 0 &&
      parsed.arguments !== undefined
    ) {
      // Ollama requires arguments to be a JSON *string*, not an object.
      return {
        id: randomUUID(),
        type: 'function',
        function: {
          name: parsed.name,
          arguments: typeof parsed.arguments === 'string'
            ? parsed.arguments
            : JSON.stringify(parsed.arguments),
        },
      }
    }
  } catch {
    // not valid JSON
  }
  return null
}

/**
 * Some Ollama models (e.g. qwen2.5-coder) emit tool calls as a JSON object
 * in the message content field rather than using the tool_calls array.
 * They may embed the JSON anywhere in the text (often inside a code fence).
 * Detect and normalize into the standard tool_calls format.
 */
function tryParseEmbeddedToolCall(content: string): any | null {
  if (!content || !content.trim()) return null

  // Strategy 1: find the first ```json ... ``` or ``` ... ``` block
  const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i)
  if (fenceMatch) {
    const result = parseSingleToolCall(fenceMatch[1])
    if (result) return result
  }

  // Strategy 2: entire content (after stripping outer fences) is the JSON
  const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  if (stripped.startsWith('{')) {
    return parseSingleToolCall(stripped)
  }

  // Strategy 3: find first bare { ... } block in the text
  const braceStart = content.indexOf('{')
  if (braceStart !== -1) {
    const braceEnd = content.lastIndexOf('}')
    if (braceEnd > braceStart) {
      const result = parseSingleToolCall(content.slice(braceStart, braceEnd + 1))
      if (result) return result
    }
  }

  return null
}

/**
 * Load in-session failure lessons from failed-tool-calls.json.
 * Returns a compact formatted string of recent tool failures (last 8 entries,
 * up to 10 failure lines) so the model starts each turn aware of what has
 * previously gone wrong — equivalent to RLVR's negative reward signal injected
 * as in-context guidance instead of gradient updates.
 */
async function loadInSessionFailureLessons(
  workspacePath: string,
  userContent: string,
  maxEntries = 8,
): Promise<string> {
  const logPath = join(getDesktopMemoryDir(workspacePath), 'failed-tool-calls.json')
  try {
    const raw = await readFile(logPath, 'utf8')
    const entries = JSON.parse(raw) as Array<{
      timestamp: string
      userRequest: string
      failures: Array<{ tool: string; error: string }>
    }>
    if (!entries.length) return ''
    const recent = entries.slice(-maxEntries)
    const lines = recent.flatMap(e =>
      e.failures.map(f => `- ${f.tool}: ${f.error.slice(0, 90)}`)
    )
    return lines.slice(0, 10).join('\n')
  } catch {
    return ''
  }
}

/**
 * Load today's episodic session log entries.
 * Returns a compact summary of the last 3 tasks completed (or attempted) today,
 * giving the model cross-conversation continuity without needing AutoDream.
 */
async function loadTodayEpisodes(
  workspacePath: string,
  maxEntries = 3,
): Promise<string> {
  const episodesDir = join(getDesktopMemoryDir(workspacePath), 'episodes')
  const dateStr = new Date().toISOString().split('T')[0]!
  const episodePath = join(episodesDir, `${dateStr}.jsonl`)
  try {
    const raw = await readFile(episodePath, 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean)
    const last = lines.slice(-maxEntries)
    const parsed = last.map(line => {
      try {
        return JSON.parse(line) as {
          ts: string
          userRequest: string
          toolsUsed: string[]
          failureCount: number
          outcome: string
        }
      } catch { return null }
    }).filter((e): e is NonNullable<typeof e> => e !== null)
    if (!parsed.length) return ''
    return parsed.map(e =>
      `- [${e.outcome.toUpperCase()}] "${e.userRequest.slice(0, 60)}" → ${e.toolsUsed.join('→')}` +
      (e.failureCount > 0 ? ` (${e.failureCount} tool failures)` : '')
    ).join('\n')
  } catch {
    return ''
  }
}

async function sendAgenticLocalPrompt(
  target: ActiveLocalSession,
  userContent: string,
): Promise<void> {
  if (target.inFlightAbort) {
    throw new Error('Wait for the current response before sending another prompt.')
  }

  const config = cachedConfig

  // ── Negative feedback detection ───────────────────────────────────────────
  // If the user expresses dissatisfaction with the previous response, inject
  // a correction note into the system context so Jarvis addresses it directly.
  // This is the feedback degradation signal (Reflexion paper: linguistic feedback).
  const NEGATIVE_FEEDBACK_SIGNALS = [
    /\bthat'?s?\s+(wrong|incorrect|not right|bad|terrible|useless|not what I asked)\b/i,
    /\byou'?re?\s+wrong\b/i,
    /\bthat doesn'?t?\s+(work|help|answer)\b/i,
    /\bnot what (I|we) (asked|wanted|needed)\b/i,
    /\byou (missed|misunderstood|ignored)\b/i,
    /\bwrong answer\b/i,
    /\btry again\b/i,
    /\bno,?\s+that'?s?\s+not\b/i,
  ]
  const hasNegativeFeedback = NEGATIVE_FEEDBACK_SIGNALS.some(p => p.test(userContent))

  const ollamaBaseUrl = config.ollamaBaseUrl.trim() || 'http://localhost:11434/v1'
  const ollamaApiBase = ollamaBaseUrl.replace(/\/+$/, '')
  const chatUrl = ollamaApiBase.endsWith('/v1')
    ? `${ollamaApiBase}/chat/completions`
    : `${ollamaApiBase}/v1/chat/completions`
  const model = target.config.ollamaModel.trim() || AGENTIC_OLLAMA_MODEL

  // Emit user message to event bus
  emit({
    type: 'message',
    message: { type: 'user', message: { role: 'user', content: userContent } },
  })
  appendLocalHistory(target, { role: 'user', content: userContent })

  const controller = new AbortController()
  target.inFlightAbort = controller
  updateRuntimeState({ label: `Thinking… (${model})`, tone: 'running', busy: true })

  const toolSteps: Array<{ toolName: string; args: Record<string, unknown>; resultPreview: string; success: boolean }> = []
  let fullAssistantResponse = ''
  let chainOfThought = ''
  let iterationCount = 0
  let groundingRetryCount = 0
  const MAX_GROUNDING_RETRIES = 2
  // Use session-persisted violation count so escalation accumulates across user messages
  // (not just within a single message). Stored on the session object.
  let consecutiveFailureCount = 0    // any consecutive failures
  let sameToolConsecutiveFailures = 0 // consecutive failures of the SAME tool
  let lastFailedTool = ''
  let proseToolRepairCount = 0       // times we re-prompted for a prose-encoded tool call
  // Per-tool failure count this turn — used to block tools that keep failing
  const sessionToolFailures: Record<string, number> = {}
  const needsLiveToolEvidence = requestNeedsLiveToolEvidence(userContent)
  // Tracks recent tool results for stagnation detection (last 3 per tool name)
  const recentToolResults: Record<string, string[]> = {}

  try {
    // Keep the first visible shared-runtime prompt snappy by skipping the
    // Drive/journal/few-shot retrieval pass until we have some turn history.
    // Nonessential traffic still forces the lean path for every turn.
    // Load persisted embedding cache from disk so cold starts don't re-embed
    const embeddingCachePath = join(getDesktopMemoryDir(config.workspacePath), '.embedding-cache.json')
    loadEmbeddingCache(embeddingCachePath).catch(() => undefined)

    const [driveContext, journalContext, fewShotExamples] = shouldSkipSharedRuntimeContextRetrievals(
      target.visiblePromptCount,
      config.disableNonessentialTraffic,
    )
      ? ['', '', '']
      : await Promise.all([
          retrieveContext(config.drive, userContent, ollamaBaseUrl, CONTEXT_BUDGET.driveContext).catch(() => ''),
          loadJournalContext(config.drive).catch(() => ''),
          buildFewShotBlock(config.drive, userContent, ollamaBaseUrl).catch(() => ''),
        ])

    // ── In-session failure lessons (loaded every turn, not just AutoDream) ───
    // These are the failures logged THIS session and past sessions, filtered to
    // tools + error types relevant to the current request so the model starts
    // aware of what tends to go wrong instead of rediscovering it mid-loop.
    const inSessionFailureLessons = await loadInSessionFailureLessons(
      config.workspacePath, userContent,
    ).catch(() => '')

    // ── Correction memory — past user corrections keyed by task similarity ──
    // Unlike generic failure lessons, these are explicit user corrections ("that
    // was wrong", "stop doing X") stored with the task they came from.  Only
    // corrections whose task keywords overlap with the current request are loaded,
    // so they fire precisely instead of polluting unrelated tasks.
    const relevantCorrections = await loadRelevantCorrections(
      getDesktopMemoryDir(config.workspacePath), userContent,
    ).catch(() => '')

    // ── Episodic continuity — what happened earlier today ──────────────────
    // Inject the last 3 task outcomes from today's episode log so the model
    // has cross-conversation memory without needing AutoDream to consolidate.
    const episodicContext = await loadTodayEpisodes(config.workspacePath).catch(() => '')

    const rawMemoryIndex = await readMemoryPreview(config.workspacePath)
      .then(result => result.preview.join('\n'))
      .catch(() => '')
    // Combine MEMORY.md + failure lessons + targeted corrections into memory block
    const memoryIndex = [
      rawMemoryIndex,
      inSessionFailureLessons ? `\n## Recent Failure Patterns (this session)\n${inSessionFailureLessons}` : '',
      relevantCorrections ? `\n${relevantCorrections}` : '',
    ].filter(Boolean).join('')

    // Append episodic context to journal
    const enhancedJournalContext = [
      journalContext,
      episodicContext ? `\n## Recent Activity (today)\n${episodicContext}` : '',
    ].filter(Boolean).join('')

    const requestedKnownFolderPath = resolveRequestedKnownFolderPath(userContent)
    const knownFolderHints = buildKnownUserFolderHintText()

    const buddySnapshot = getDesktopBuddySnapshot()
    const companionLine = buddySnapshot.hatched
      ? `- Your companion: ${buddySnapshot.name} (${buddySnapshot.species}, ${buddySnapshot.rarity}) — ${buddySnapshot.personality}`
      : '- No companion is currently active.'
    const workspaceName = target.config.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'

    const runtimeContext = [
      `## Runtime Environment`,
      `- OS: Windows`,
      `- Home directory: ${homedir()}`,
      `- Workspace: ${workspaceName} (${target.config.workspacePath})`,
      `- File paths on this system use Windows format (e.g. C:\\Users\\ethan\\Downloads).`,
      `- When locating executables or checking whether a command exists, use Windows-native commands like where.exe or Get-Command; do not use whereis.`,
      `- When a file path is needed and the user has not provided one, derive it from the home directory above. Do NOT guess Linux or macOS paths.`,
      companionLine,
      requestedKnownFolderPath
        ? `- For the current request, the referenced known folder resolves to: ${requestedKnownFolderPath}`
        : '',
      knownFolderHints
        ? `- Known Windows user folders on this machine:\n${knownFolderHints}`
        : '',
    ].filter(Boolean).join('\n')

    // ── Build capability context — Jarvis must know its own state ────────────
    const driveConnected = Boolean(config.drive.setupComplete && config.drive.folderIds)
    const capabilityLines: string[] = ['## Jarvis Capability Status']
    capabilityLines.push(
      driveConnected
        ? `- Google Drive cloud brain: CONNECTED — experience replay, journal, and context retrieval are ACTIVE`
        : `- Google Drive cloud brain: NOT CONNECTED — Drive features disabled (journal, experience replay, retrieval all offline)`,
    )
    if (driveConnected && config.drive.folderIds) {
      capabilityLines.push(`- Drive AgentMemory: ${Object.keys(config.drive.folderIds).length} category folders active`)
    }
    capabilityLines.push(`- Model: ${model} (${isAgenticModel(model) ? 'instruct — full ReAct' : 'non-instruct — limited ReAct'})`)
    capabilityLines.push(`- Local tools available: Read, Write, Edit, Glob, Grep, Bash, ListDirectory, WebSearch, WebFetch, CheckDriveStatus`)
    capabilityLines.push(``)
    capabilityLines.push(`## Capability Rules (MANDATORY — follow these exactly)`)
    capabilityLines.push(`- WEATHER queries: Bash with \`curl.exe -s "wttr.in/?format=3"\` — no API key, always works. CRITICAL: on Windows PowerShell you MUST use curl.exe (not curl — curl is a broken alias in PowerShell). NEVER use WebSearch for weather.`)
    capabilityLines.push(`- DRIVE/MEMORY STATUS: use CheckDriveStatus tool (no arguments). NEVER use WebSearch to check your own state.`)
    capabilityLines.push(`- SELF-STATUS ("are you connected?", "is X working?"): use CheckDriveStatus or Read on config files — never WebSearch.`)
    capabilityLines.push(`- WEBSEARCH: include specific details in every query (location, entity name, full question). Never use 1-2 word queries.`)
    capabilityLines.push(`- WEBFETCH: never use URLs with "your_api_key", placeholder variables, or "example.com".`)
    capabilityLines.push(`- If a tool fails: read the error, change the approach, do NOT retry with identical arguments.`)
    const capabilityContext = capabilityLines.join('\n')

    const feedbackNote = hasNegativeFeedback
      ? `\n\n## ⚠ User Feedback Alert\nThe user expressed dissatisfaction with your previous response. Before responding:\n1. Identify specifically what was wrong about the last answer\n2. Do NOT repeat the same approach\n3. Address the user's correction directly in your first sentence\n4. If you are unsure what went wrong, ask one specific clarifying question`
      : ''
    const fullCapabilityContext = capabilityContext + feedbackNote

    // Companion context — intro text tells Jarvis about the watching companion,
    // stat values tune Jarvis's response personality for this session
    const companionIntro = getDesktopCompanionIntro()
    const companionSystemText = companionIntro?.text ?? ''
    const companionSnapshot = getDesktopBuddySnapshot()
    const companionStats = companionSnapshot.hatched ? (companionSnapshot.stats as Record<string, number>) : undefined

    // The direct in-process Ollama loop still uses the legacy ReAct framing.
    const systemPrompt = [
      buildLocalCompatibilityPrompt({
        model,
        disableToolsForLocal: false,
        enableExperimentalLocalTools: true,
        disableThinkingForLocal: false,
        toolPromptStyle: 'legacy-react',
        appendSystemPrompt: config.appendSystemPrompt,
        conversationSummary: target.summary,
        runtimeContext,
        capabilityContext: fullCapabilityContext,
        companionStats,
      }),
      companionSystemText,
    ].filter(Boolean).join('\n\n')

    // ── Build initial message array ──────────────────────────────────────────
    const { messages } = assembleContext({
      systemPrompt,
      memoryIndex,
      journalContext: enhancedJournalContext,
      fewShotExamples,
      driveContext,
      history: target.history.slice(0, -1), // exclude the user message we just added
      userMessage: userContent,
    })

    const ollamaOptions = buildOllamaOptions(config.ollamaVram)
    const tools = buildOllamaToolList()

    // ── Inject tool routing hint + complexity hint into the last user message ─
    // buildToolRoutingHint analyses the request and prepends a short advisory
    // hint (e.g. "start with Bash for weather") so iteration 1 steers toward
    // the right tool without restricting tool availability.
    // classifyTask adds a complexity tier annotation for multi-step planning.
    const routingHint = buildToolRoutingHint(userContent)
    const taskClassification = classifyTask(userContent)
    const complexityHint = buildComplexityHint(taskClassification)

    // Emit the complexity classification as an info event for visibility
    if (taskClassification.complexity !== 'simple') {
      emit({
        type: 'info',
        label: `Task: ${taskClassification.complexity}`,
        body: `${taskClassification.reason} (~${taskClassification.estimatedToolCalls} tool calls expected)`,
      })
    }

    // For genuinely multi-domain compound tasks, require a PLAN block before
    // the first tool call.  Research and code tasks intentionally excluded:
    // research just needs a WebSearch routing hint (PLAN causes the model to
    // Require a PLAN block for any non-trivial task complexity.
    // compound: multi-step cross-domain tasks
    // research: web + Drive synthesis tasks
    // code: file-edit + multi-tool sequences
    const needsPlanningStep = ['compound', 'research', 'code'].includes(taskClassification.complexity)

    const planningPrefix = needsPlanningStep
      ? `[PLANNING REQUIRED] Before your first tool call on this turn, output a PLAN block:\n\n` +
        `PLAN:\n` +
        `1. [What exactly is the user asking for?]\n` +
        `2. [What information or state do I need to discover first?]\n` +
        `3. [Ordered list of tool calls I expect to make]\n` +
        `4. [What does a complete, correct answer look like?]\n\n` +
        `Then proceed with THOUGHT → ACTION as normal. The PLAN block is required on this first turn only.\n\n`
      : ''

    const turnMessages: any[] = messages.map((msg: any, idx: number) => {
      if (idx === messages.length - 1 && msg.role === 'user') {
        const hints = [complexityHint, routingHint].filter(Boolean).join('\n')
        const baseContent = typeof msg.content === 'string' ? msg.content : String(msg.content ?? '')
        const withPlan = planningPrefix + baseContent
        const content = hints ? `${hints}\n\n${withPlan}` : withPlan
        return { ...msg, content }
      }
      return msg
    })

    // ── Confidence gate — intercept genuinely ambiguous requests ────────────
    // If the message is a vague pronoun reference ("do it", "try that") with no
    // domain signal and no fast-path match, ask ONE clarifying question instead
    // of making a likely-wrong tool call.
    if (isAmbiguousRequest(userContent) && getToolFastPathLabel(userContent) === null) {
      const clarifyText =
        "I'd like to help, but I'm not quite sure what you'd like me to do — could you give me a bit more detail? For example, what should I work on, or what were you hoping for?"
      emit({ type: 'text', text: clarifyText })
      updateRuntimeState({ label: target.readyLabel, tone: 'idle', busy: false })
      target.history.push({ role: 'assistant', content: clarifyText })
      return
    }

    // ── Pre-flight: confirm Ollama is reachable before entering the loop ────
    {
      const pingUrl = chatUrl.replace(/\/v1\/chat\/completions$/, '/api/tags')
      let pingOk = false
      try {
        const pingResp = await fetch(pingUrl, { method: 'GET', signal: AbortSignal.timeout(4_000) })
        pingOk = pingResp.ok
      } catch {
        pingOk = false
      }
      if (!pingOk) {
        emit({
          type: 'stderr',
          line: `Ollama is not reachable at ${pingUrl}. Make sure Ollama is running (run: ollama serve) and try again.`,
        })
        updateRuntimeState({ label: target.readyLabel, tone: 'error', busy: false })
        return
      }
    }

    // ── Intent router: enforce no-tool mode for explain/diagnostic labels ───
    // When the user explicitly asks to stop acting or asks a diagnostic question,
    // strip tools from the request entirely so the model cannot make a tool call.
    // A single uncontested Ollama call returns the answer; the loop then breaks.
    const fastPathLabel = getToolFastPathLabel(userContent)
    const noToolMode = fastPathLabel !== null && NO_TOOL_LABELS.has(fastPathLabel)
    if (noToolMode) {
      emit({
        type: 'info',
        label: `Intent: ${fastPathLabel}`,
        body: 'No-tool mode enforced — model will answer directly without executing tools.',
      })
    }

    // ── ReAct agent loop ─────────────────────────────────────────────────────
    while (iterationCount < MAX_AGENT_ITERATIONS) {
      if (controller.signal.aborted) break
      iterationCount++

      // ── Rolling task anchor — prevents context drift in multi-tool tasks ─────
      // qwen2.5:7b loses goal orientation after 2-3 tool calls. Inject compact
      // anchors at iterations 2, 4, and 6 to keep the model on-task.
      // Iteration 4 adds a trajectory check; iteration 6 hints at graceful exit.
      if (iterationCount === 2 || iterationCount === 4 || iterationCount === 6) {
        const anchor = userContent.length > 100
          ? userContent.slice(0, 100) + '...'
          : userContent
        const anchorContent =
          iterationCount === 2
            ? `[Task anchor] Original request: "${anchor}" — keep working on this.`
            : iterationCount === 4
              ? `[Goal check — iteration 4] Still working on: "${anchor}". ` +
                `Review your last tool results: are they actually moving toward this goal? ` +
                `If a tool keeps failing, switch strategy now.`
              : `[Goal check — iteration 6] Still working on: "${anchor}". ` +
                `You have used ${toolSteps.length} tool calls. ` +
                `If you cannot complete this in 2 more calls, give a partial FINAL ANSWER with what you found so far.`
        turnMessages.push({ role: 'user', content: anchorContent })
      }

      // ── Mid-loop progress injection ──────────────────────────────────────
      // After 6 iterations the model can lose track of what it has tried.
      // Inject a compact progress summary so the next THOUGHT has full context.
      if (iterationCount === 7 && toolSteps.length > 0) {
        const progressLines = toolSteps.map((s, i) =>
          `${i + 1}. ${s.toolName} → ${s.success ? 'OK' : 'FAILED'}: ${s.resultPreview.slice(0, 80)}`
        )
        const progressMsg =
          `[PROGRESS CHECK — iteration ${iterationCount}]\n` +
          `You have made ${toolSteps.length} tool call(s) so far:\n` +
          progressLines.join('\n') + '\n\n' +
          `Based on this history, reconsider your approach before the next THOUGHT. ` +
          `Do not repeat a tool call that already failed with the same arguments.`
        turnMessages.push({ role: 'user', content: progressMsg })
      }

      const requestBody: Record<string, unknown> = {
        model,
        messages: turnMessages,
        options: ollamaOptions,
        stream: false,
        // noToolMode strips the tool list so the model cannot make any tool call —
        // used for no_tools_explain and diagnostic_question fast-path labels.
        tools: noToolMode ? undefined : tools,
        max_tokens: config.ollamaVram.numPredict,
      }

      let response: Response
      try {
        // 120-second per-turn timeout — gives slow model loading enough headroom
        const turnTimeout = AbortSignal.timeout(120_000)
        response = await fetch(chatUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.any([controller.signal, turnTimeout]),
        })
      } catch (err: any) {
        if (controller.signal.aborted) break
        if (err?.name === 'TimeoutError') {
          emit({ type: 'info', label: 'Timeout', body: `Ollama took > 120 s at ${chatUrl} — try a shorter prompt or reduce context.` })
          break
        }
        throw err
      }

      if (!response.ok) {
        throw new Error(`Ollama API error ${response.status}: ${await response.text()}`)
      }

      const data: any = await response.json()
      const message = data.choices?.[0]?.message ?? data.message

      if (!message) break

      // Extract thinking content if present
      const rawContent: string = message.content ?? ''
      const thinkMatch = rawContent.match(/<thinking>([\s\S]*?)<\/thinking>/i)
      if (thinkMatch) {
        chainOfThought += thinkMatch[1] + '\n'
      }
      const visibleContent = rawContent.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim()

      // ── PLAN block validation (turn 2 enforcement) ───────────────────────
      // For non-simple tasks the first turn should contain a PLAN block.
      // If turn 1 response lacks it, inject a correction on turn 2 so the model
      // plans before making further tool calls.
      if (iterationCount === 2 && needsPlanningStep && !/\bPLAN:/m.test(rawContent)) {
        turnMessages.push({ role: 'assistant', content: rawContent })
        turnMessages.push({
          role: 'user',
          content:
            `[PLAN MISSING] You skipped the required PLAN block. Before making any tool call, ` +
            `output a PLAN that lists:\n` +
            `1. What exactly the user is asking\n` +
            `2. What information you need to gather first\n` +
            `3. The ordered tool calls you expect to make\n` +
            `4. What a complete answer looks like\n\n` +
            `Start your response with "PLAN:" now.`,
        })
        continue
      }

      // ── Replanning trigger — fires at 2 and 4 consecutive failures ──────────
      // Injects a failure diagnosis so the model understands WHY it's stuck
      // (not just that it failed) and is forced to change strategy explicitly.
      if (consecutiveFailureCount === 2 && toolSteps.length >= 2) {
        const failureAnalysis = analyzeFailurePattern(toolSteps)
        const failedSummary = toolSteps
          .filter(s => !s.success)
          .slice(-3)
          .map(s => `${s.toolName}: ${s.resultPreview.slice(0, 100)}`)
          .join('\n')
        turnMessages.push({
          role: 'user',
          content:
            `[REPLAN — FAILURE DIAGNOSIS] Two consecutive failures. You must change your approach.\n\n` +
            `Recent failures:\n${failedSummary}\n\n` +
            (failureAnalysis ? `Failure patterns detected:\n${failureAnalysis}\n\n` : '') +
            `MANDATORY: Output a REVISED PLAN before your next tool call:\n` +
            `1. What specifically went wrong and why (reference the error text above)\n` +
            `2. What you will NOT attempt again (name the exact tool or argument pattern)\n` +
            `3. Your new approach and which tools you will use instead\n\n` +
            `Start with "REVISED PLAN:" then THOUGHT → ACTION.`,
        })
      }

      // ── Second replan — critical escalation at 4 consecutive failures ─────
      if (consecutiveFailureCount === 4 && toolSteps.length >= 4) {
        const failureAnalysis = analyzeFailurePattern(toolSteps)
        turnMessages.push({
          role: 'user',
          content:
            `[SECOND REPLAN — CRITICAL] Four consecutive failures. Your approach is fundamentally broken.\n\n` +
            (failureAnalysis ? `Failure analysis:\n${failureAnalysis}\n\n` : '') +
            `REQUIRED — choose one:\n` +
            `A) If you have a COMPLETELY different strategy: output "REVISED PLAN:" and describe it, then THOUGHT → ACTION.\n` +
            `B) If the task cannot be completed with available tools: output FINAL ANSWER explaining what you tried, what failed, and what the user needs to do to unblock you.\n\n` +
            `Do NOT make the same tool call you have already tried. Do NOT invent fake results.`,
        })
      }

      // ── ReAct schema enforcement ─────────────────────────────────────────
      // If the model emits a tool call but did NOT include a THOUGHT: line,
      // reject the turn and inject a corrective prompt so the model reasons
      // before acting on the next iteration.
      const candidateToolCalls = normalizeToolCallCandidates(message.tool_calls)
      const hasEmbeddedToolCall = candidateToolCalls.length === 0 && tryParseEmbeddedToolCalls(visibleContent || rawContent).length > 0
      const hasAnyToolCall = candidateToolCalls.length > 0 || hasEmbeddedToolCall
      // Allow leading whitespace/indentation before THOUGHT: — model sometimes
      // outputs a blank line or a space before the keyword, which is fine.
      const hasThought = /^\s*THOUGHT:/m.test(rawContent)

      if (hasAnyToolCall && !hasThought) {
        target.reactViolationCount++
        turnMessages.push({ role: 'assistant', content: rawContent })

        // Re-inject the routing hint so the model also has a reminder of WHICH
        // tool to use — format errors often co-occur with wrong tool choice.
        const reRoutingHint = buildToolRoutingHint(userContent)
        const reRoutingSuffix = reRoutingHint ? `\n\n${reRoutingHint}` : ''

        // After 2 violations escalate with stronger language and format example
        const isEscalated = target.reactViolationCount >= 2
        const correctionMsg = isEscalated
          ? `CRITICAL FORMAT ERROR (violation #${target.reactViolationCount}): Every single response MUST start with THOUGHT:. ` +
            `Your tool call was NOT executed. The system physically cannot process a tool call without a preceding THOUGHT.\n\n` +
            `Copy this template exactly:\n\n` +
            `THOUGHT: The user is asking about [X]. I need to [Y]. I will use [TOOL] because [REASON].\n` +
            `ACTION: {"name": "ToolName", "arguments": {"param": "value"}}\n\n` +
            `Start your response with "THOUGHT:" — not with ACTION, not with JSON, not with any other text.` +
            reRoutingSuffix
          : `SCHEMA VIOLATION: You called a tool without a THOUGHT. Your response was rejected.\n\n` +
            `You MUST follow this exact format:\n\n` +
            `THOUGHT: [What is the user asking? What specific information do I need? Why is this tool the right one? What do I expect it to return?]\n` +
            `ACTION: [one tool call in strict JSON]\n\n` +
            `Now retry. Start your response with "THOUGHT:"` +
            reRoutingSuffix

        turnMessages.push({ role: 'user', content: correctionMsg })
        emit({
          type: 'info',
          label: 'ReAct enforce',
          body: `Action without Thought detected (violation #${target.reactViolationCount}) — tool call rejected, requiring THOUGHT first.`,
        })
        updateRuntimeState({ label: `Thinking… iteration ${iterationCount}`, tone: 'running', busy: true })
        continue
      }

      // ── Resolve tool calls — native field OR embedded JSON in content ─────
      // qwen2.5-coder and other Ollama models sometimes emit tool calls as a
      // raw JSON object in the content field instead of using message.tool_calls.
      let toolCalls: any[] = normalizeToolCallCandidates(message.tool_calls)
      if (toolCalls.length === 0) {
        toolCalls = tryParseEmbeddedToolCalls(visibleContent || rawContent)
      }

      // ── No tool call → final answer ──────────────────────────────────────
      if (toolCalls.length === 0) {
        // ── Prose-encoded tool call detector (hard validator) ─────────────────
        // The model sometimes describes a tool call in natural language instead of
        // executing it — "I will call WebSearch with query X" without emitting
        // actual tool_calls.  Detect future-tense action descriptions that name a
        // known tool and re-prompt for the actual JSON call (max 2 repairs per session).
        if (!noToolMode && !rawContent.includes('FINAL ANSWER:')) {
          const TOOL_NAME_RE = /\b(Bash|WebSearch|WebFetch|Read|Edit|Write|Grep|Glob|ListDirectory|WriteMemory|CheckDriveStatus)\b/
          const FUTURE_INTENT_RE = /(?:I(?:'ll| will| am going to)|Let me|Now I(?:'ll| will)|Next,? I(?:'ll| will)|I(?:'m| am) (?:going to|about to))\s+(?:call|use|invoke|run|execute|try|search with|search for|fetch|look up)/i
          const PAST_RECAP_RE = /(?:I used|I called|I searched|I found|I ran|the result|as expected|above shows)/i
          if (
            FUTURE_INTENT_RE.test(rawContent) &&
            TOOL_NAME_RE.test(rawContent) &&
            !PAST_RECAP_RE.test(rawContent) &&
            iterationCount < MAX_AGENT_ITERATIONS - 2
          ) {
            proseToolRepairCount = (proseToolRepairCount ?? 0) + 1
            if (proseToolRepairCount <= 2) {
              turnMessages.push({ role: 'assistant', content: rawContent })
              turnMessages.push({
                role: 'user',
                content:
                  'Your last response described a tool call in plain text instead of executing it. ' +
                  'Do NOT describe tool calls — execute them directly. ' +
                  'Output ONLY the JSON tool call now, no explanation, no THOUGHT wrapper.',
              })
              emit({ type: 'info', label: 'Prose tool repair', body: 'Model described a tool call in prose — re-prompting for actual execution.' })
              continue
            }
          }
        }

        // noToolMode means the model had no tools available — skip grounding retry.
        if (!noToolMode && needsLiveToolEvidence && toolSteps.length === 0 && groundingRetryCount < MAX_GROUNDING_RETRIES) {
          groundingRetryCount++
          turnMessages.push({ role: 'assistant', content: rawContent })
          turnMessages.push({
            role: 'user',
            content:
              'This request depends on current local machine state, so it is not satisfied yet. Call an appropriate tool now, inspect the live result, and then answer. Do not guess from memory and do not print JSON tool-call examples.',
          })
          emit({
            type: 'info',
            label: 'Grounding retry',
            body: 'The model answered before inspecting live data, so the agent is requiring a real tool call before it can finish.',
          })
          updateRuntimeState({ label: `Thinking... iteration ${iterationCount}`, tone: 'running', busy: true })
          continue
        }

        fullAssistantResponse = visibleContent || rawContent
        const groundedAnswer = deriveLatestFileAnswerFromToolResults(
          userContent,
          toolSteps,
          fullAssistantResponse,
        )
        if (groundedAnswer) {
          fullAssistantResponse = groundedAnswer
        }
        break
      }

      // ── Process tool calls ───────────────────────────────────────────────
      // Ollama API requires tool_call arguments to be a JSON string, not an object.
      // Normalize here so both native and embedded tool calls are safe to re-send.
      turnMessages.push({ role: 'assistant', content: rawContent, tool_calls: toolCalls })

      for (const tc of toolCalls) {
        const toolName: string = normalizeLocalToolName(tc.function?.name ?? '')
        const rawArgs: unknown = tc.function?.arguments ?? {}
        const toolId: string = tc.id ?? randomUUID()

        // Layer 1 + 2: Validate
        const schema = getToolSchema(toolName)
        let validatedArgs: Record<string, unknown>

        if (schema) {
          const validation = validateToolCall({ toolName, rawArgs, schema })
          if (!validation.ok) {
            // Inject repair message and retry (Layer 3)
            turnMessages.push({
              role: 'tool',
              tool_call_id: toolId,
              content: validation.repairMessage,
            })
            emit({ type: 'info', label: 'Tool repair', body: `${toolName}: ${validation.errors[0]}` })
            toolSteps.push({ toolName, args: {}, resultPreview: `REPAIR: ${validation.errors[0]}`, success: false })
            continue
          }
          validatedArgs = validation.args
        } else {
          // SendMessage / SendUserMessage are Claude-internal transport mechanisms,
          // not real tools.  The model should write FINAL ANSWER instead.
          const lowerToolName = toolName.toLowerCase().replace(/[_\s-]/g, '')
          if (lowerToolName === 'sendmessage' || lowerToolName === 'sendusermessage') {
            turnMessages.push({
              role: 'tool',
              tool_call_id: toolId,
              content:
                'SendMessage is not a tool — it is the output channel used by a different runtime. ' +
                'To respond to the user, write your answer as a FINAL ANSWER: block. ' +
                'Do not call SendMessage or SendUserMessage again.',
            })
            emit({ type: 'info', label: 'Tool repair', body: `${toolName}: blocked — not a valid local tool. Redirected to FINAL ANSWER.` })
            toolSteps.push({ toolName, args: {}, resultPreview: 'REPAIR: SendMessage is not a valid local tool', success: false })
            consecutiveFailureCount++
            continue
          }
          // Unknown tool — try to parse args and proceed
          validatedArgs = (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs))
            ? rawArgs as Record<string, unknown>
            : {}
        }

        const semanticRepairMessage = buildSemanticToolRepairMessage(
          userContent,
          toolName,
        )
        if (semanticRepairMessage) {
          turnMessages.push({
            role: 'tool',
            tool_call_id: toolId,
            content: semanticRepairMessage,
          })
          emit({ type: 'info', label: 'Tool repair', body: `${toolName}: switched to a better-fit filesystem tool.` })
          toolSteps.push({
            toolName,
            args: validatedArgs,
            resultPreview: `REPAIR: ${semanticRepairMessage}`,
            success: false,
          })
          consecutiveFailureCount++
          continue
        }

        // Phase 1.2: Pre-flight validation — catch bad args before the tool fires
        const preflight = preflightCheck(toolName, validatedArgs)
        if (!preflight.allow) {
          turnMessages.push({
            role: 'tool',
            tool_call_id: toolId,
            content: preflight.blockMessage!,
          })
          emit({ type: 'info', label: 'Pre-flight block', body: `${toolName}: ${preflight.blockMessage!.slice(0, 120)}` })
          toolSteps.push({
            toolName,
            args: validatedArgs,
            resultPreview: `PREFLIGHT BLOCK: ${preflight.blockMessage!.slice(0, 200)}`,
            success: false,
          })
          consecutiveFailureCount++

          // Phase 1.4: Dead-end detection — surface to user if stuck
          const deadEndHint = (sameToolConsecutiveFailures >= 2 || consecutiveFailureCount >= 4 ||
            Object.values(sessionToolFailures).reduce((a, b) => a + b, 0) >= 6)
            ? checkDeadEnd(consecutiveFailureCount, toolSteps)
            : null
          if (deadEndHint) {
            turnMessages.push({ role: 'user', content: deadEndHint })
            emit({ type: 'info', label: 'Dead-end detected', body: `${consecutiveFailureCount} consecutive failures — injecting escalation hint.` })
          }
          continue
        }

        const coercedArgs = coerceKnownFolderToolArgs(
          userContent,
          toolName,
          validatedArgs,
        )
        if (coercedArgs.note) {
          emit({ type: 'info', label: 'Path repair', body: coercedArgs.note })
        }

        // Session-level tool failure block: once WebSearch has failed once this turn
        // (all 3 backends down), block all further WebSearch calls immediately.
        // Threshold is >= 1 because "all backends failed" means retrying is pointless.
        const sessionFailCount = sessionToolFailures[toolName] ?? 0
        if (sessionFailCount >= 1 && toolName === 'WebSearch') {
          const blockMsg =
            `[SESSION BLOCK] WebSearch already failed this session — all 3 backends returned no results. ` +
            `Do not retry WebSearch. Think about what the user actually asked for and use a different approach:\n\n` +
            `- If they need a location-based result: use Bash → \`curl.exe -s "ipinfo.io/json"\` to get their city, then WebFetch a specific URL\n` +
            `- If they need web content: WebFetch a specific known URL directly\n` +
            `- If the task cannot be completed without working web search: give a FINAL ANSWER explaining the limitation`
          turnMessages.push({ role: 'tool', tool_call_id: toolId, content: blockMsg })
          toolSteps.push({ toolName, args: coercedArgs.args, resultPreview: blockMsg.slice(0, 200), success: false })
          consecutiveFailureCount++
          sameToolConsecutiveFailures++
          continue
        }

        // Execute the tool
        updateRuntimeState({ label: `Running tool: ${toolName}`, tone: 'running', busy: true })
        const result = await executeLocalTool(toolName, coercedArgs.args, target.config.workspacePath)

        // When a tool fails but returned useful output (e.g. WebSearch "(no results...)",
        // Bash stderr, non-zero exit with combined stdout+stderr), surface that output
        // rather than hiding it behind a generic "Unknown error" fallback.
        let resultText: string
        if (result.success) {
          resultText = result.output
        } else if (result.output && result.output.trim()) {
          resultText = result.error
            ? `ERROR: ${result.error}\n${result.output}`
            : result.output
        } else {
          resultText = `ERROR: ${result.error ?? 'Unknown error'}`
        }

        if (
          !result.success &&
          /(path does not exist|file does not exist|enoent|no such file or directory)/i.test(resultText)
        ) {
          const folderHints = buildKnownUserFolderHintText()
          if (folderHints) {
            resultText = [
              resultText,
              requestedKnownFolderPath
                ? `Requested folder for this user message: ${requestedKnownFolderPath}`
                : '',
              `Known Windows user folders on this machine:\n${folderHints}`,
            ].filter(Boolean).join('\n')
          }
        }

        toolSteps.push({
          toolName,
          args: coercedArgs.args,
          resultPreview: resultText.slice(0, 300),
          success: result.success,
        })

        // Phase 1.4: Track consecutive failure streak.
        // Transient errors (network timeout, rate-limit) are noted but do NOT
        // count toward the dead-end threshold — they are environmental, not
        // model logic errors, and shouldn't trigger premature escalation.
        if (result.success) {
          consecutiveFailureCount = 0
          sameToolConsecutiveFailures = 0
          lastFailedTool = ''
        } else if (!isTransientError(resultText)) {
          consecutiveFailureCount++
          if (toolName === lastFailedTool) {
            sameToolConsecutiveFailures++
          } else {
            sameToolConsecutiveFailures = 1
            lastFailedTool = toolName
          }
          sessionToolFailures[toolName] = (sessionToolFailures[toolName] ?? 0) + 1
        }

        // Store the tool result in Drive for future retrieval (fire-and-forget)
        if (result.success && config.drive.setupComplete) {
          const analysis = analyzeAndDescribe(
            toolName, validatedArgs, result.output, userContent, true
          )
          routeAndStore(config.drive, analysis, result.output, ollamaBaseUrl).catch(() => undefined)
        }

        // Track results per tool for stagnation detection
        if (!recentToolResults[toolName]) recentToolResults[toolName] = []
        const stagnationHint = detectResultStagnation(recentToolResults[toolName], resultText)
        recentToolResults[toolName].push(resultText.slice(0, 300))
        if (recentToolResults[toolName].length > 3) recentToolResults[toolName].shift()

        // ── Post-ListDirectory follow-through hint ───────────────────────────
        // If the user wants file content (read/summarize/open) and ListDirectory
        // succeeded, inject the full path of the most-recent file so the model
        // NEVER needs to ask "what is the path?" — it has it right here.
        if (toolName === 'ListDirectory' && result.success) {
          const wantsContent = /\b(read|open|summarize|summary|contents?|tell me (what'?s? in|about)|what does it say|show me)\b/i.test(userContent)
          if (wantsContent) {
            const dirPath = String(coercedArgs.args.path ?? '').trim()
            const fileLines = resultText
              .split(/\r?\n/)
              .filter(line => /^f\s+\d{4}-\d{2}-\d{2}/.test(line.trim()))
              .filter(line => !isSkippableMetadataFileName(line.trim().split(/\s+/).slice(2).join(' ')))
            if (fileLines.length > 0 && dirPath) {
              const parts = fileLines[0]!.trim().split(/\s+/)
              const fileName = parts.slice(2).join(' ') // handles filenames with spaces
              const fullPath = join(dirPath, fileName)
              resultText += `\n\n[SYSTEM HINT] The most recent file is: ${fullPath}\nYour next ACTION must be: Read with file_path="${fullPath}"\nDo NOT ask the user for the path — you already have it above. Call Read immediately.`
            }
          }
        }

        // Inject result back into conversation — run through auditor first so
        // correction hints are appended when recognisable failure patterns are detected.
        // buildObservation pre-caps the raw result to 600 chars when a correction hint
        // is present, guaranteeing the hint is never cut off by the outer obsLen cap.
        let observation = buildObservation(toolName, coercedArgs.args, resultText)

        // Cap the raw observation BEFORE adding critical guidance hints so those
        // hints are always fully visible regardless of the raw result length.
        const obsLen = iterationCount <= 3 ? 2000 : 1500
        if (observation.length > obsLen) {
          observation = observation.slice(0, obsLen) +
            `\n[...truncated — ${observation.length - obsLen} chars omitted to stay within context budget]`
        }

        // Append critical guidance AFTER capping — these must always be fully visible.
        if (stagnationHint) observation += stagnationHint

        // Phase 1.4: Dead-end escalation.
        // Trigger on 2 same-tool consecutive failures (stuck on one tool) OR 5 any failures
        // (broadly stuck). This prevents premature escalation when legitimately pivoting tools.
        const deadEndHint = (sameToolConsecutiveFailures >= 2 || consecutiveFailureCount >= 4 ||
            Object.values(sessionToolFailures).reduce((a, b) => a + b, 0) >= 6)
          ? checkDeadEnd(consecutiveFailureCount, toolSteps)
          : null
        if (deadEndHint) {
          observation += deadEndHint
          emit({ type: 'info', label: 'Dead-end detected', body: `${sameToolConsecutiveFailures} same-tool / ${consecutiveFailureCount} total failures — escalation hint injected.` })
          triggerSessionEventReaction('session_error', toolName)
        }

        turnMessages.push({
          role: 'tool',
          tool_call_id: toolId,
          content: observation,
        })

        emit({
          type: 'info',
          label: `Tool: ${toolName}`,
          body: resultText.slice(0, 200),
        })
      }

      updateRuntimeState({ label: `Thinking… iteration ${iterationCount}`, tone: 'running', busy: true })
    }

    // ── Emit final answer ────────────────────────────────────────────────────
    // Strip ReAct format artifacts that leak into final answers.
    // The model sometimes writes "ACTION: None" or bare "THOUGHT:" lines in its
    // final prose response — these are internal scaffolding, not user-facing content.
    const rawFinalText = fullAssistantResponse || buildIncompleteTaskResponse(userContent, toolSteps)
    const finalText = rawFinalText
      // Remove standalone "ACTION: none" / "ACTION: None." lines
      .replace(/^ACTION:\s*(none\.?|None\.?)\s*\n?/gm, '')
      // Remove bare "ACTION:" lines with no meaningful content
      .replace(/^ACTION:\s*\n/gm, '')
      // Remove stray "THOUGHT:" prefix lines that leaked into final text
      .replace(/^THOUGHT:\s*\n/gm, '')
      // Remove "OBSERVATION:" prefix lines
      .replace(/^OBSERVATION:\s*\n/gm, '')
      // Downcase ALL-CAPS exclamations — the model occasionally shouts despite the rule.
      // Preserves single-word acronyms (URL, JSON, etc.) by only targeting 2+ consecutive caps words.
      .replace(/\b([A-Z]{2,}(?:\s+[A-Z]{2,})+)\b/g, (m) => m.charAt(0) + m.slice(1).toLowerCase())
      .trim()
    emit({
      type: 'message',
      message: {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: finalText }] },
      },
    })
    appendLocalHistory(target, { role: 'assistant', content: finalText })

    // ── Post-turn: store success trace + update journal (fire-and-forget) ───
    if (config.drive.setupComplete) {
      const trace = {
        taskDescription: userContent,
        chainOfThought,
        toolSteps,
        finalAnswer: finalText,
        rating: 4,  // assume success; degraded if user reports otherwise
        success: true,
        tokensUsed: 0,
        durationMs: 0,
      }
      storeSuccessTrace(config.drive, trace, ollamaBaseUrl).catch(() => undefined)
      // Persist embedding cache to disk so the next session skips re-embedding
      persistEmbeddingCache(embeddingCachePath).catch(() => undefined)
      updateJournal(
        config.drive,
        {
          tasksCompleted: 1,
          toolStats: toolSteps.reduce<Record<string, { attempts: number; successes: number }>>((acc, s) => {
            acc[s.toolName] = acc[s.toolName] ?? { attempts: 0, successes: 0 }
            acc[s.toolName]!.attempts++
            if (s.success) acc[s.toolName]!.successes++
            return acc
          }, {}),
          errors: toolSteps.filter(s => !s.success).map(s => `${s.toolName}: ${s.resultPreview}`),
          userFeedback: null,
          durationMs: 0,
        },
        ollamaBaseUrl,
        model,
      ).catch(() => undefined)
    }

    // ── Phase 2.3: Real-time memory note for successful multi-tool tasks ──────
    // Write a compact memory note immediately after a successful tool chain
    // so the pattern is captured before AutoDream runs (which may be deferred).
    const successfulTools = toolSteps.filter(s => s.success).map(s => s.toolName)
    if (successfulTools.length >= 2 && fullAssistantResponse && config.drive.setupComplete) {
      const memoryPath = getDesktopMemoryEntrypoint(config.workspacePath)
      const noteTimestamp = new Date().toISOString().split('T')[0] // YYYY-MM-DD
      const toolChain = successfulTools.join(' → ')
      const taskSummary = userContent.slice(0, 80).replace(/[\n\r:'"]/g, ' ').trim()
      const memoryNote =
        `\n---\nname: session_note_${noteTimestamp.replace(/-/g, '')}_${randomUUID().slice(0, 4)}\n` +
        `description: Completed task - ${taskSummary}\ntype: session\n---\n` +
        `Tools used: ${toolChain}\nDate: ${noteTimestamp}\n`

      // Append to MEMORY.md (non-blocking, fire-and-forget)
      import('fs/promises').then(({ readFile, writeFile }) =>
        readFile(memoryPath, 'utf8')
          .then(existing => writeFile(memoryPath, existing + memoryNote, 'utf8'))
          .catch(() => writeFile(memoryPath, `# Session Memory\n${memoryNote}`, 'utf8'))
      ).catch(() => undefined)
    }

    // ── Post-session: persist failed tool calls for AutoDream feedback loop ──
    // Any tool failure this session gets appended to failed-tool-calls.json in
    // the memory folder. AutoDream reads this file during consolidation and
    // synthesizes "learned patterns" that get encoded into permanent MEMORY.md
    // entries — so Jarvis gets better at the same tasks over time.
    const sessionFailures = toolSteps.filter(s => !s.success)
    if (sessionFailures.length > 0) {
      const failLogPath = join(getDesktopMemoryDir(config.workspacePath), 'failed-tool-calls.json')
      const failEntry = {
        timestamp: new Date().toISOString(),
        userRequest: userContent.slice(0, 200),
        failures: sessionFailures.map(s => ({
          tool: s.toolName,
          args: s.args,
          error: s.resultPreview.slice(0, 300),
        })),
      }
      readFile(failLogPath, 'utf8')
        .then(raw => JSON.parse(raw) as unknown[])
        .catch(() => [] as unknown[])
        .then(existing => {
          const updated = [...existing, failEntry].slice(-50) // keep last 50 sessions
          return writeFile(failLogPath, JSON.stringify(updated, null, 2), 'utf8')
        })
        .catch(() => undefined)
    }

    // ── Post-session: correction memory — store user rejections with task context ─
    // When the user explicitly rejected this response, record what approach failed
    // and what they corrected us on.  Only fires when negative feedback is detected
    // AND at least one tool was called (otherwise nothing to correct).
    if (hasNegativeFeedback && toolSteps.length > 0) {
      const failedToolNames = [...new Set(toolSteps.filter(s => !s.success).map(s => s.toolName))]
      const correctionText = userContent  // the user's message IS the correction signal
      storeCorrection(
        getDesktopMemoryDir(config.workspacePath),
        userContent,
        correctionText,
        failedToolNames.length > 0 ? failedToolNames : toolSteps.map(s => s.toolName),
      ).catch(() => undefined)
    }

    // ── Post-session: episodic log (Phase A memory tier) ─────────────────────
    // Appends a one-line JSONL record per session so AutoDream and future
    // retrieval have a time-series of what tasks were attempted and how they went.
    {
      const episodesDir = join(getDesktopMemoryDir(config.workspacePath), 'episodes')
      const dateStr = new Date().toISOString().split('T')[0]! // YYYY-MM-DD
      const episodePath = join(episodesDir, `${dateStr}.jsonl`)
      const failCount = toolSteps.filter(s => !s.success).length
      const episodeEntry = JSON.stringify({
        ts: new Date().toISOString(),
        userRequest: userContent.slice(0, 120).replace(/\n/g, ' '),
        toolsUsed: [...new Set(toolSteps.map(s => s.toolName))],
        failureCount: failCount,
        totalToolCalls: toolSteps.length,
        // user_rejected overrides success: user expressed explicit dissatisfaction
        outcome: hasNegativeFeedback ? 'user_rejected'
          : failCount === 0 ? 'success'
          : toolSteps.some(s => s.success) ? 'partial' : 'failed',
      })
      mkdir(episodesDir, { recursive: true })
        .catch((e: NodeJS.ErrnoException) => { if (e.code !== 'EEXIST') throw e })
        .then(() => appendFile(episodePath, episodeEntry + '\n', 'utf8'))
        .catch(() => undefined)
    }

    // ── Post-session: trigger AutoDream consolidation if gates pass ──────────
    void shouldTriggerAutoDream(config.workspacePath).then(shouldRun => {
      if (!shouldRun) return
      emit({ type: 'info', label: 'AutoDream', body: 'Memory consolidation starting in background…' })
      return runAutoDreamPass(config.workspacePath, config.drive, ollamaBaseUrl, model)
        .then(() => emit({ type: 'info', label: 'AutoDream', body: 'Memory consolidation complete.' }))
        .catch(() => undefined)
    }).catch(() => undefined)

    updateRuntimeState({ label: target.readyLabel, tone: 'running', busy: false })
  } catch (err) {
    if (!controller.signal.aborted) {
      const message = err instanceof Error ? err.message : String(err)
      emit({ type: 'stderr', line: `Agentic session error: ${message}` })
      if (config.drive.setupComplete && toolSteps.length > 0) {
        storeFailureTrace(
          config.drive,
          { taskDescription: userContent, whatWentWrong: message, toolSteps },
          cachedConfig.ollamaBaseUrl,
          model,
        ).catch(() => undefined)
      }
      updateRuntimeState({ label: 'Error', tone: 'error', busy: false })
    }
  } finally {
    if (target.inFlightAbort === controller) {
      target.inFlightAbort = null
    }
  }
}

type DesktopSendResult = {
  intercepted?: 'buddy'
  features?: DesktopFeatureSnapshot
}

async function runBuddyShortcut(): Promise<DesktopSendResult> {
  const buddy = getDesktopBuddySnapshot()
  const features = buddy.hatched
    ? { ...(await getDesktopFeatureSnapshot()), buddy: petDesktopCompanion() }
    : { ...(await getDesktopFeatureSnapshot()), buddy: hatchDesktopCompanion() }

  emit({
    type: 'info',
    label: buddy.hatched ? 'Companion pet' : 'Companion hatched',
    body: buddy.hatched
      ? `${features.buddy.name} is back on the rail and watching the live edge with you.`
      : `${features.buddy.name} hatched and docked beside the prompt rail.`,
  })

  return {
    intercepted: 'buddy',
    features,
  }
}

function normalizeSharedLocalToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim()
  }
  if (Array.isArray(content)) {
    return content
      .map(block => {
        if (!block || typeof block !== 'object') {
          return ''
        }
        const typed = block as Record<string, unknown>
        if (typeof typed.text === 'string') {
          return typed.text
        }
        if (typeof typed.content === 'string') {
          return typed.content
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
      .trim()
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return ''
}

function summarizeSharedLocalToolResult(
  content: unknown,
  isError: boolean,
): string {
  const normalized = normalizeSharedLocalToolResultContent(content)
  const prefix = isError ? 'ERROR: ' : ''
  return (prefix + normalized || (isError ? 'ERROR: tool result unavailable' : 'Tool result available')).slice(0, 3000)
}

async function runLocalMemoryHooks(input: {
  config: LauncherConfig
  workspacePath: string
  ollamaBaseUrl: string
  model: string
  taskDescription: string
  chainOfThought: string
  toolSteps: Array<{
    toolName: string
    args: Record<string, unknown>
    resultPreview: string
    success: boolean
  }>
  finalAnswer: string
  success: boolean
  durationMs?: number
  errorMessage?: string
}): Promise<void> {
  if (!input.config.drive.setupComplete) {
    return
  }

  if (!input.success) {
    if (input.toolSteps.length > 0 && input.errorMessage) {
      await storeFailureTrace(
        input.config.drive,
        {
          taskDescription: input.taskDescription,
          whatWentWrong: input.errorMessage,
          toolSteps: input.toolSteps,
        },
        input.ollamaBaseUrl,
        input.model,
      ).catch(() => undefined)
    }
    return
  }

  const successfulTools = input.toolSteps.filter(step => step.success).map(step => step.toolName)
  const trace = {
    taskDescription: input.taskDescription,
    chainOfThought: input.chainOfThought || [
      successfulTools.length > 0 ? `Tools used: ${successfulTools.join(' → ')}` : 'No tools were needed.',
      input.finalAnswer ? `Answer: ${input.finalAnswer.slice(0, 280)}` : '',
    ].filter(Boolean).join('\n'),
    toolSteps: input.toolSteps,
    finalAnswer: input.finalAnswer,
    rating: 4,
    success: true,
    tokensUsed: 0,
    durationMs: input.durationMs ?? 0,
  }

  storeSuccessTrace(input.config.drive, trace, input.ollamaBaseUrl).catch(() => undefined)
  updateJournal(
    input.config.drive,
    {
      tasksCompleted: 1,
      toolStats: input.toolSteps.reduce<Record<string, { attempts: number; successes: number }>>((acc, step) => {
        acc[step.toolName] = acc[step.toolName] ?? { attempts: 0, successes: 0 }
        acc[step.toolName]!.attempts++
        if (step.success) {
          acc[step.toolName]!.successes++
        }
        return acc
      }, {}),
      errors: input.toolSteps.filter(step => !step.success).map(step => `${step.toolName}: ${step.resultPreview}`),
      userFeedback: null,
      durationMs: input.durationMs ?? 0,
    },
    input.ollamaBaseUrl,
    input.model,
  ).catch(() => undefined)

  const successfulToolsForNote = input.toolSteps.filter(step => step.success).map(step => step.toolName)
  if (successfulToolsForNote.length >= 2 && input.finalAnswer.trim()) {
    const memoryPath = getDesktopMemoryEntrypoint(input.workspacePath)
    const noteTimestamp = new Date().toISOString().split('T')[0]
    const toolChain = successfulToolsForNote.join(' → ')
    const taskSummary = input.taskDescription.slice(0, 80).replace(/[\n\r:'"]/g, ' ').trim()
    const memoryNote =
      `\n---\nname: session_note_${noteTimestamp.replace(/-/g, '')}_${randomUUID().slice(0, 4)}\n` +
      `description: Completed task - ${taskSummary}\ntype: session\n---\n` +
      `Tools used: ${toolChain}\nDate: ${noteTimestamp}\n`

    import('fs/promises').then(({ readFile, writeFile }) =>
      readFile(memoryPath, 'utf8')
        .then(existing => writeFile(memoryPath, existing + memoryNote, 'utf8'))
        .catch(() => writeFile(memoryPath, `# Session Memory\n${memoryNote}`, 'utf8')),
    ).catch(() => undefined)
  }

  void shouldTriggerAutoDream(input.workspacePath).then(shouldRun => {
    if (!shouldRun) return
    emit({
      type: 'info',
      label: 'AutoDream',
      body: 'Memory consolidation starting in background…',
    })
    return runAutoDreamPass(
      input.workspacePath,
      input.config.drive,
      input.ollamaBaseUrl,
      input.model,
    )
      .then(() => emit({ type: 'info', label: 'AutoDream', body: 'Memory consolidation complete.' }))
      .catch(() => undefined)
  }).catch(() => undefined)
}

async function buildSharedLocalTurnContent(
  target: ActiveChildSession,
  userContent: string,
): Promise<{ content: string; turnState: SharedLocalTurnState }> {
  const config = target.config
  const ollamaBaseUrl = config.ollamaBaseUrl.trim() || 'http://localhost:11434/v1'
  // Keep the first visible shared-runtime prompt snappy by skipping the
  // Drive/journal/few-shot retrieval pass until we have some turn history.
  // Nonessential traffic still forces the lean path for every turn.
  const [driveContext, journalContext, fewShotExamples] = shouldSkipSharedRuntimeContextRetrievals(
    target.visiblePromptCount,
    config.disableNonessentialTraffic,
  )
    ? ['', '', '']
    : await Promise.all([
        retrieveContext(config.drive, userContent, ollamaBaseUrl, CONTEXT_BUDGET.driveContext).catch(() => ''),
        loadJournalContext(config.drive).catch(() => ''),
        buildFewShotBlock(config.drive, userContent, ollamaBaseUrl).catch(() => ''),
      ])
  const memoryPreview = await readMemoryPreview(config.workspacePath).catch(() => ({
    preview: ['No MEMORY.md index has been written for this workspace yet.'],
  }))

  const requestedKnownFolderPath = resolveRequestedKnownFolderPath(userContent)
  const knownFolderHints = buildKnownUserFolderHintText()
  const buddySnapshot = getDesktopBuddySnapshot()
  const companionIntro = getDesktopCompanionIntro()
  const driveConnected = Boolean(config.drive.setupComplete && config.drive.folderIds)
  const workspaceName = config.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
  const taskClassification = classifyTask(userContent)
  const routingHint = buildToolRoutingHint(userContent)
  const complexityHint = buildComplexityHint(taskClassification)
  const feedbackNote = [
    /\bthat'?s?\s+(wrong|incorrect|not right|bad|terrible|useless|not what I asked)\b/i,
    /\byou'?re?\s+wrong\b/i,
    /\bthat doesn'?t?\s+(work|help|answer)\b/i,
    /\bnot what (I|we) (asked|wanted|needed)\b/i,
    /\byou (missed|misunderstood|ignored)\b/i,
    /\bwrong answer\b/i,
    /\btry again\b/i,
    /\bno,?\s+that'?s?\s+not\b/i,
  ].some(pattern => pattern.test(userContent))
    ? 'The user has indicated the previous answer was not good. Correct the mistake directly and do not repeat the same approach.'
    : ''

  const runtimeContext = [
    `## Runtime Environment`,
    `- OS: Windows`,
    `- Home directory: ${homedir()}`,
    `- Workspace: ${workspaceName} (${config.workspacePath})`,
    `- File paths on this system use Windows format (e.g. C:\\Users\\ethan\\Downloads).`,
    `- When a file path is needed and the user has not provided one, derive it from the home directory above. Do NOT guess Linux or macOS paths.`,
    requestedKnownFolderPath
      ? `- For the current request, the referenced known folder resolves to: ${requestedKnownFolderPath}`
      : '',
    knownFolderHints
      ? `- Known Windows user folders on this machine:\n${knownFolderHints}`
      : '',
  ].filter(Boolean).join('\n')

  const capabilityContext = [
    `## Jarvis Capability Status`,
    driveConnected
      ? `- Google Drive cloud brain: CONNECTED — experience replay, journal, and context retrieval are ACTIVE`
      : `- Google Drive cloud brain: NOT CONNECTED — Drive features disabled (journal, experience replay, retrieval all offline)`,
    driveConnected && config.drive.folderIds
      ? `- Drive AgentMemory: ${Object.keys(config.drive.folderIds).length} category folders active`
      : '',
    `- Companion: ${buddySnapshot.hatched ? `${buddySnapshot.name} (${buddySnapshot.species}, ${buddySnapshot.rarity}) — ${buddySnapshot.personality}` : 'No companion is currently active.'}`,
    `- Model: ${config.ollamaModel.trim() || AGENTIC_OLLAMA_MODEL}`,
    `- Local tools available: Read, Write, Edit, Glob, Grep, Bash, ListDirectory, WebSearch, WebFetch, CheckDriveStatus`,
    feedbackNote ? `- User feedback: ${feedbackNote}` : '',
    taskClassification.complexity !== 'simple'
      ? `- Task complexity: ${taskClassification.complexity} — ${taskClassification.reason}`
      : '',
    routingHint ? `- Routing hint: ${routingHint}` : '',
    complexityHint ? `- Planning hint: ${complexityHint}` : '',
  ].filter(Boolean).join('\n')

  const promptParts = [
    '<<<JARVIS_SHARED_LOCAL_CONTEXT>>>',
    runtimeContext,
    capabilityContext,
    companionIntro?.text ?? '',
    memoryPreview.preview.join('\n'),
    journalContext,
    fewShotExamples,
    driveContext,
    '<<<END_JARVIS_SHARED_LOCAL_CONTEXT>>>',
    '<<<JARVIS_USER_REQUEST>>>',
    userContent.trim(),
    '<<<END_JARVIS_USER_REQUEST>>>',
  ].filter(Boolean)

  return {
    content: promptParts.join('\n\n'),
    turnState: createSharedLocalTurnState(userContent),
  }
}

function getParsedMessageRole(parsed: any): string | null {
  return (
    parsed?.message?.role ??
    parsed?.message?.message?.role ??
    parsed?.role ??
    parsed?.message?.type ??  // handles { type: 'message', message: { type: 'result', ... } }
    null
  )
}

function getParsedMessageContent(parsed: any): unknown {
  return (
    parsed?.message?.content ??
    parsed?.message?.message?.content ??
    parsed?.content ??
    null
  )
}

function extractPlainTextFromContent(content: unknown): string {
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
      const typed = block as Record<string, unknown>
      if (typeof typed.text === 'string') {
        return typed.text
      }
      if (typeof typed.content === 'string') {
        return typed.content
      }
      if (typeof typed.connector_text === 'string') {
        return typed.connector_text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
}

function getParsedResultSubtype(parsed: any): string | null {
  return (
    parsed?.subtype ??
    parsed?.message?.subtype ??
    parsed?.message?.message?.subtype ??
    null
  )
}

function getParsedResultText(parsed: any): string {
  const direct = parsed?.result
  if (typeof direct === 'string') {
    return direct
  }
  const messageResult = parsed?.message?.result
  if (typeof messageResult === 'string') {
    return messageResult
  }
  const nestedMessageResult = parsed?.message?.message?.result
  if (typeof nestedMessageResult === 'string') {
    return nestedMessageResult
  }
  return ''
}

function extractSharedLocalToolUseBlocks(content: unknown): Array<{
  toolUseId: string
  toolName: string
  args: Record<string, unknown>
}> {
  if (!Array.isArray(content)) {
    return []
  }

  return content
    .filter(block => block && typeof block === 'object')
    .filter((block: any) => block?.type === 'tool_use' || block?.type === 'server_tool_use')
    .map((block: any) => {
      const toolUseId = String(block.id ?? block.tool_use_id ?? randomUUID())
      const toolName = String(block.name ?? 'Tool')
      const rawInput = block.input
      let args: Record<string, unknown> = {}
      if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
        args = rawInput as Record<string, unknown>
      } else if (typeof rawInput === 'string' && rawInput.trim()) {
        try {
          const parsed = JSON.parse(rawInput)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed as Record<string, unknown>
          }
        } catch {
          args = {}
        }
      }
      return { toolUseId, toolName, args }
    })
}

function extractSharedLocalToolResultBlocks(content: unknown): Array<{
  toolUseId: string
  content: unknown
  isError: boolean
}> {
  if (!Array.isArray(content)) {
    return []
  }

  return content
    .filter(block => block && typeof block === 'object')
    .filter((block: any) => block?.type === 'tool_result')
    .map((block: any) => ({
      toolUseId: String(block.tool_use_id ?? ''),
      content: block.content,
      isError: Boolean(block.is_error),
    }))
    .filter(block => block.toolUseId.length > 0)
}

function isSharedLocalPromptEcho(
  target: ActiveChildSession,
  parsed: any,
): boolean {
  const turn = target.sharedLocalTurn
  if (!turn || getParsedMessageRole(parsed) !== 'user') {
    return false
  }

  const content = getParsedMessageContent(parsed)
  if (extractSharedLocalToolResultBlocks(content).length > 0) {
    return false
  }

  const plainText = extractPlainTextFromContent(content)
  const unwrapped = unwrapSharedLocalPrompt(
    plainText || (typeof content === 'string' ? content : ''),
  )
  return unwrapped === turn.userContent
}

async function recordSharedLocalTurnEvent(
  target: ActiveChildSession,
  parsed: any,
): Promise<void> {
  const turn = target.sharedLocalTurn
  if (!turn) {
    return
  }

  const role = getParsedMessageRole(parsed)
  const content = getParsedMessageContent(parsed)
  const normalized = normalizeJarvisMessageEvent(parsed, {
    sessionId: target.id,
    turnId: turn.turnId,
  })

  if (role === 'assistant') {
    turn.assistantEventSeen = true
    const assistantText = cleanLocalAssistantText(
      Array.isArray(content)
        ? extractAssistantBlocks({ content }).map(block => block.text).join('\n\n')
        : extractAssistantBlocksFromChatContent(content).map(block => block.text).join('\n\n'),
    )
    if (assistantText) {
      turn.assistantText = [turn.assistantText, assistantText].filter(Boolean).join('\n\n')
    }

    for (const block of extractSharedLocalToolUseBlocks(content)) {
      if (turn.toolStepsById.has(block.toolUseId)) {
        continue
      }
      const step: SharedLocalToolStep = {
        toolUseId: block.toolUseId,
        toolName: block.toolName,
        args: block.args,
        resultPreview: '',
        success: false,
        storedInDrive: false,
      }
      turn.toolStepsById.set(step.toolUseId, step)
      turn.toolSteps.push(step)
    }
  }

  if (
    normalized.displayRole === 'assistant' &&
    (normalized.kind === 'stream_event' || normalized.kind === 'streamlined_text')
  ) {
    const streamText = cleanLocalAssistantText(normalized.text)
    if (streamText) {
      turn.assistantEventSeen = true
      turn.assistantText = [turn.assistantText, streamText].filter(Boolean).join('\n\n')
    }
  }

  if (role === 'user') {
    for (const resultBlock of extractSharedLocalToolResultBlocks(content)) {
      const step = turn.toolStepsById.get(resultBlock.toolUseId)
      const resultPreview = summarizeSharedLocalToolResult(
        resultBlock.content,
        resultBlock.isError,
      )
      if (step) {
        step.resultPreview = resultPreview
        step.success = !resultBlock.isError
      }

      if (!resultBlock.isError && step && target.config.drive.setupComplete && !step.storedInDrive) {
        const analysis = analyzeAndDescribe(
          step.toolName,
          step.args,
          resultPreview,
          turn.userContent,
          true,
        )
        routeAndStore(
          target.config.drive,
          analysis,
          resultPreview,
          target.config.ollamaBaseUrl.trim() || 'http://localhost:11434/v1',
        ).catch(() => undefined)
        step.storedInDrive = true
      } else if (resultBlock.isError) {
        triggerSessionEventReaction('tool_error')
      }
    }
  }
}

async function finalizeSharedLocalTurn(
  target: ActiveChildSession,
  parsed: any,
): Promise<void> {
  const turn = target.sharedLocalTurn
  if (!turn || turn.finalized) {
    return
  }

  turn.finalized = true
  turn.completedAt = Date.now()
  turn.resultSubtype = getParsedResultSubtype(parsed)
  turn.resultText = getParsedResultText(parsed)

  const model = target.config.ollamaModel.trim() || AGENTIC_OLLAMA_MODEL
  const ollamaBaseUrl = target.config.ollamaBaseUrl.trim() || 'http://localhost:11434/v1'
  const finalText = cleanLocalAssistantText(
    turn.assistantText || turn.resultText || buildIncompleteTaskResponse(turn.userContent, turn.toolSteps),
  )
  const success = turn.resultSubtype === 'success' || (typeof parsed?.is_error === 'boolean' && !parsed.is_error)
  const durationMs = Math.max(0, turn.completedAt - turn.startedAt)
  const synthesizedFallbackText = cleanLocalAssistantText(
    finalText ||
      turn.resultText ||
      'Response produced with no assistant text payload; see timeline event.',
  )
  let synthesizedAssistant = false

  try {
    if (!turn.assistantEventSeen) {
      emit({
        type: 'message',
        message: {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: synthesizedFallbackText }],
          },
          parent_tool_use_id: null,
          session_id: target.id,
          uuid: randomUUID(),
          timestamp: new Date().toISOString(),
        },
      })
      turn.assistantEventSeen = true
      synthesizedAssistant = true
    }
    if (success) {
      appendConversationHistory(target, { role: 'assistant', content: finalText })
      await runLocalMemoryHooks({
        config: target.config,
        workspacePath: target.config.workspacePath,
        ollamaBaseUrl,
        model,
        taskDescription: turn.userContent,
        chainOfThought: [
          turn.toolSteps.length > 0
            ? `Tools used: ${turn.toolSteps.map(step => step.toolName).join(' → ')}`
            : 'No tools were needed.',
          finalText ? `Answer: ${finalText.slice(0, 280)}` : '',
        ].filter(Boolean).join('\n'),
        toolSteps: turn.toolSteps.map(step => ({
          toolName: step.toolName,
          args: step.args,
          resultPreview: step.resultPreview,
          success: step.success,
        })),
        finalAnswer: finalText,
        success: true,
        durationMs,
      })
    } else {
      const errorMessage = turn.resultText || 'Shared local turn failed.'
      emit({
        type: 'stderr',
        line: errorMessage,
      })
      await runLocalMemoryHooks({
        config: target.config,
        workspacePath: target.config.workspacePath,
        ollamaBaseUrl,
        model,
        taskDescription: turn.userContent,
        chainOfThought: turn.toolSteps.length > 0
          ? `Tools used: ${turn.toolSteps.map(step => step.toolName).join(' → ')}`
          : 'No tools were needed.',
        toolSteps: turn.toolSteps.map(step => ({
          toolName: step.toolName,
          args: step.args,
          resultPreview: step.resultPreview,
          success: step.success,
        })),
        finalAnswer: finalText,
        success: false,
        durationMs,
        errorMessage,
      })
    }
  } finally {
    updateRuntimeState({
      label: `Local shared runtime ready / Ollama / ${model}`,
      tone: 'running',
      busy: false,
    })
    logMessageFlowCounters(`shared-turn-${turn.turnId}`)
    target.sharedLocalTurn = null
  }
}

async function sendPrompt(content: string): Promise<DesktopSendResult> {
  if (content.trim() === '/buddy') {
    return runBuddyShortcut()
  }

  const active = session
  if (!active) {
    throw new Error('No active session.')
  }

  if (isChildSession(active) && !active.launchHandshakeResolved) {
    const ready = await waitForLaunchHandshake(active)
    if (!ready) {
      throw new Error('Jarvis is still starting. Please try again in a moment.')
    }
    if (session?.id !== active.id) {
      throw new Error('The session changed before the prompt could be sent.')
    }
  }

  if (isSharedLocalSession(active)) {
    if (active.sharedLocalTurn) {
      throw new Error('Wait for the current shared local response before sending another prompt.')
    }

    const model = active.config.ollamaModel.trim() || AGENTIC_OLLAMA_MODEL
    const isHiddenLaunchIntroPrompt = active.suppressedLaunchIntroPrompt === content

    // Only occupy the turn slot and mark busy for visible (non-hidden) prompts.
    // A hidden launch-intro must not block the user's first real message.
    if (!isHiddenLaunchIntroPrompt) {
      active.sharedLocalTurn = createSharedLocalTurnState(content)
      updateRuntimeState({ label: `Thinking… (${model})`, tone: 'running', busy: true })
      triggerSessionEventReaction('thinking')
      emit({
        type: 'message',
        message: {
          type: 'user',
          message: {
            role: 'user',
            content,
          },
        },
      })
    }

      try {
        const built = await buildSharedLocalTurnContent(active, content)
        if (!isHiddenLaunchIntroPrompt) {
          built.turnState.startedAt = active.sharedLocalTurn!.startedAt
          built.turnState.turnId = active.sharedLocalTurn!.turnId
          active.sharedLocalTurn = built.turnState
      }
      await sendLine(active, {
        type: 'user',
        session_id: '',
        message: {
          role: 'user',
          content: built.content,
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      })
        if (!isHiddenLaunchIntroPrompt) {
          appendConversationHistory(active, {
            role: 'user',
            content,
          })
          active.visiblePromptCount += 1
        }
      } catch (error) {
        if (!isHiddenLaunchIntroPrompt) {
          active.sharedLocalTurn = null
          updateRuntimeState({
          label: `Local shared runtime ready / Ollama / ${model}`,
          tone: 'running',
          busy: false,
        })
      }
      throw error
    }
    return {}
  }

  if (isLocalSession(active)) {
    if (active.config.enableAgenticLocalMode) {
      await sendAgenticLocalPrompt(active, content)
    } else {
      await sendLocalSafePrompt(active, content)
    }
    active.visiblePromptCount += 1
    return {}
  }

  const payload = {
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
  const isHiddenLaunchIntroPrompt = active.suppressedLaunchIntroPrompt === content
  if (!isHiddenLaunchIntroPrompt) {
    updateRuntimeState({ label: 'Thinking…', tone: 'running', busy: true })
    emit({
      type: 'message',
      message: payload,
    })
  }
  await sendLine(active, {
    ...payload,
  })
  return {}
}

async function interruptSession(): Promise<void> {
  const active = session
  if (!active) {
    throw new Error('No active session.')
  }

  if (isLocalSession(active)) {
    if (active.inFlightAbort) {
      active.inFlightAbort.abort()
      active.inFlightAbort = null
    }
    return
  }

  await sendLine(active, {
    type: 'control_request',
    request_id: randomUUID(),
    request: {
      subtype: 'interrupt',
    },
  })
}

function clearTranscript(options: { silent?: boolean } = {}): void {
  recentEvents.length = 0
  persistedState.lastLocalHistory = []
  persistedState.lastLocalSummary = ''
  if (isLocalSession(session) || isSharedLocalSession(session)) {
    session.history = []
    session.summary = ''
    if (isSharedLocalSession(session)) {
      session.sharedLocalTurn = null
    }
  }
  if (!options.silent) {
    emit({
      type: 'info',
      label: 'Transcript',
      body: 'Cleared the desktop transcript and local safe-mode memory cache.',
    })
  }
  schedulePersist()
}

async function parseRequestJson(request: Request): Promise<any> {
  try {
    return await request.json()
  } catch {
    return {}
  }
}

const configuredPort = Number(process.env.CLAUDE_BODY_DESKTOP_PORT ?? '0')

const server = Bun.serve({
  port:
    Number.isFinite(configuredPort) && configuredPort > 0
      ? configuredPort
      : 0,
  fetch: async request => {
    try {
      const url = new URL(request.url)

        if (url.pathname === '/') {
          return new Response(renderAppHtml(), {
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store, no-cache, must-revalidate',
            },
          })
        }

        if (url.pathname === '/app.js') {
          return new Response(renderAppClientJs(), {
            headers: {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store, no-cache, must-revalidate',
            },
          })
        }

      if (url.pathname === '/favicon.ico') {
        return new Response(null, { status: 204 })
      }

      if (url.pathname === '/api/config' && request.method === 'GET') {
        return json(cachedConfig)
      }

      if (url.pathname === '/api/config' && request.method === 'POST') {
        const payload = await parseRequestJson(request)
        cachedConfig = {
          ...getDefaultConfig(workspaceRoot),
          ...payload,
          workspacePath: payload.workspacePath?.trim() || workspaceRoot,
        }
        await saveLauncherConfig(cachedConfig)
        emit({
          type: 'info',
          label: 'Configuration',
          body: `Saved launcher config to disk for ${cachedConfig.backend}.`,
        })
        return json(cachedConfig)
      }

      if (url.pathname === '/api/models' && request.method === 'GET') {
        return json(await getModelCatalog())
      }

      if (url.pathname === '/api/features' && request.method === 'GET') {
        return json(await getDesktopFeatureSnapshot())
      }

      if (url.pathname === '/api/companion/hatch' && request.method === 'POST') {
        const buddy = hatchDesktopCompanion()
        emit({
          type: 'info',
          label: 'Companion hatched',
          body: `${buddy.name} hatched beside the prompt rail.`,
        })
        return json({ ok: true, buddy, features: await getDesktopFeatureSnapshot() })
      }

      if (url.pathname === '/api/companion/rehatch' && request.method === 'POST') {
        const buddy = rehatchDesktopCompanion()
        emit({
          type: 'info',
          label: 'Companion rehatched',
          body: `${buddy.name} kept the same profile shell but picked up a fresh soul.`,
        })
        return json({ ok: true, buddy, features: await getDesktopFeatureSnapshot() })
      }

      if (url.pathname === '/api/companion/pet' && request.method === 'POST') {
        const buddy = petDesktopCompanion()
        emit({
          type: 'info',
          label: 'Companion pet',
          body: `${buddy.name} reacted from the dock.`,
        })
        return json({ ok: true, buddy, features: await getDesktopFeatureSnapshot() })
      }

      if (url.pathname === '/api/companion/mute' && request.method === 'POST') {
        const buddy = muteDesktopCompanion()
        emit({
          type: 'info',
          label: 'Companion muted',
          body: 'Jarvis will keep the companion present, but speech bubbles are suppressed.',
        })
        return json({ ok: true, buddy, features: await getDesktopFeatureSnapshot() })
      }

      if (url.pathname === '/api/companion/unmute' && request.method === 'POST') {
        const buddy = unmuteDesktopCompanion()
        emit({
          type: 'info',
          label: 'Companion unmuted',
          body: `${buddy.name} is visible again in the chat dock.`,
        })
        return json({ ok: true, buddy, features: await getDesktopFeatureSnapshot() })
      }

      if (url.pathname === '/api/companion/reset' && request.method === 'POST') {
        const buddy = resetDesktopCompanion()
        emit({
          type: 'info',
          label: 'Companion reset',
          body: 'The companion roster was cleared and the dock returned to the dormant state.',
        })
        return json({ ok: true, buddy, features: await getDesktopFeatureSnapshot() })
      }

      if (url.pathname === '/api/companion/profiles' && request.method === 'GET') {
        const buddy = getDesktopBuddySnapshot()
        return json({
          ok: true,
          activeProfileId: buddy.activeProfileId,
          profiles: listDesktopBuddyProfiles(),
          buddy,
          features: await getDesktopFeatureSnapshot(),
        })
      }

      if (
        url.pathname === '/api/companion/profile/create' &&
        request.method === 'POST'
      ) {
        const payload = await parseRequestJson(request)
        const buddy = createDesktopBuddyProfile(payload?.profile ?? {})
        emit({
          type: 'info',
          label: 'Companion created',
          body: `${buddy.name} was added to Companion Studio and set active on the rail.`,
        })
        return json({
          ok: true,
          activeProfileId: buddy.activeProfileId,
          profiles: listDesktopBuddyProfiles(),
          buddy,
          features: await getDesktopFeatureSnapshot(),
        })
      }

      if (
        url.pathname === '/api/companion/profile/update' &&
        request.method === 'POST'
      ) {
        const payload = await parseRequestJson(request)
        if (!payload?.profileId) {
          return text('profileId is required.', 400)
        }
        const buddy = updateDesktopBuddyProfile(
          String(payload.profileId),
          payload?.profile ?? {},
        )
        emit({
          type: 'info',
          label: 'Companion updated',
          body: `${buddy.name} was updated in Companion Studio.`,
        })
        return json({
          ok: true,
          activeProfileId: buddy.activeProfileId,
          profiles: listDesktopBuddyProfiles(),
          buddy,
          features: await getDesktopFeatureSnapshot(),
        })
      }

      if (
        url.pathname === '/api/companion/profile/select' &&
        request.method === 'POST'
      ) {
        const payload = await parseRequestJson(request)
        if (!payload?.profileId) {
          return text('profileId is required.', 400)
        }
        const buddy = selectDesktopBuddyProfile(String(payload.profileId))
        emit({
          type: 'info',
          label: 'Companion switched',
          body: `${buddy.name} is now the active Jarvis companion.`,
        })
        return json({
          ok: true,
          activeProfileId: buddy.activeProfileId,
          profiles: listDesktopBuddyProfiles(),
          buddy,
          features: await getDesktopFeatureSnapshot(),
        })
      }

      if (
        url.pathname === '/api/companion/profile/delete' &&
        request.method === 'POST'
      ) {
        const payload = await parseRequestJson(request)
        if (!payload?.profileId) {
          return text('profileId is required.', 400)
        }
        const buddy = deleteDesktopBuddyProfile(String(payload.profileId))
        emit({
          type: 'info',
          label: 'Companion removed',
          body: buddy.hatched
            ? `${buddy.name} is still active after the roster update.`
            : 'The companion roster is empty again.',
        })
        return json({
          ok: true,
          activeProfileId: buddy.activeProfileId,
          profiles: listDesktopBuddyProfiles(),
          buddy,
          features: await getDesktopFeatureSnapshot(),
        })
      }

      if (url.pathname === '/api/shell' && request.method === 'GET') {
        return json(buildShellPayload())
      }

      if (url.pathname === '/api/shell' && request.method === 'POST') {
        const payload = await parseRequestJson(request)
        if (payload?.uiState && typeof payload.uiState === 'object') {
          updateUiState(payload.uiState as Partial<DesktopUiState>)
        }
        if ('integrations' in (payload ?? {})) {
          saveIntegrations(payload.integrations)
        }
        return json(buildShellPayload())
      }

      if (url.pathname === '/api/remote-health' && request.method === 'POST') {
        const payload = await parseRequestJson(request)
        const config = {
          ...cachedConfig,
          ...(payload?.config ?? {}),
        } as LauncherConfig
        return json(await getRemoteGlmBridgeHealth(config))
      }

      if (url.pathname === '/api/events' && request.method === 'GET') {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              sseClients.add(controller)
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(getSnapshot())}\n\n`),
              )
            },
            cancel() {
              sseClients.delete(this as never)
            },
          }),
          {
            headers: {
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              'Content-Type': 'text/event-stream',
            },
          },
        )
      }

      if (url.pathname === '/api/session/start' && request.method === 'POST') {
        const payload = await parseRequestJson(request)
        await startSession(payload)
        return json({ ok: true })
      }

      if (url.pathname === '/api/session/send' && request.method === 'POST') {
        const payload = await parseRequestJson(request)
        if (!payload.content?.trim()) {
          return text('Prompt content is required.', 400)
        }
        const content = payload.content.trim()
        const result = await sendPrompt(content).catch(error => {
          const message = error instanceof Error ? error.message : String(error)
          emit({
            type: 'stderr',
            line: message,
          })
          updateRuntimeState({
            label: 'Prompt failed',
            tone: 'error',
            busy: false,
          })
          throw error
        })
        return json({ ok: true, ...(result ?? {}) })
      }

      if (
        url.pathname === '/api/session/permission' &&
        request.method === 'POST'
      ) {
        const payload = await parseRequestJson(request)
        if (payload.decision !== 'allow' && payload.decision !== 'deny') {
          return text('Permission decision must be allow or deny.', 400)
        }
        const permanent = payload.permanent === true
        await respondToPermission(payload.requestId, payload.decision, permanent)
        return json({ ok: true })
      }

      if (
        url.pathname === '/api/sandbox/status' &&
        request.method === 'GET'
      ) {
        // Refresh the WSL2 readiness check on demand
        wsl2SandboxStatus = await checkWsl2SandboxReadiness(cachedConfig.wslDistro)
        return json({ wsl2Sandbox: wsl2SandboxStatus })
      }


      if (
        url.pathname === '/api/session/interrupt' &&
        request.method === 'POST'
      ) {
        await interruptSession()
        return json({ ok: true })
      }

      if (url.pathname === '/api/session/stop' && request.method === 'POST') {
        await stopSession('Session stopped by desktop launcher')
        return json({ ok: true })
      }

      if (
        url.pathname === '/api/transcript/clear' &&
        request.method === 'POST'
      ) {
        const payload = await parseRequestJson(request)
        clearTranscript({ silent: payload?.silent === true })
        return json({ ok: true })
      }

      // ── Drive setup wizard routes ──────────────────────────────────────────
      // These only touch the local session config and Drive — Thunder untouched.

      if (url.pathname === '/api/drive/status' && request.method === 'GET') {
        const state = await refreshDriveAuthState()
        return json({
          state: state.status,
          setupComplete: cachedConfig.drive.setupComplete,
          folderIds: cachedConfig.drive.folderIds,
          steps: getDriveSetupSteps(),
        })
      }

      if (url.pathname === '/api/drive/setup/steps' && request.method === 'GET') {
        return json({ steps: getDriveSetupSteps() })
      }

      if (url.pathname === '/api/drive/setup/credentials' && request.method === 'POST') {
        const payload = await parseRequestJson(request)
        const sourcePath = typeof payload.path === 'string' ? payload.path.trim() : ''
        if (!sourcePath) return text('path is required', 400)

        await saveCredentialsFrom(sourcePath, cachedConfig.drive)
        emit({
          type: 'info',
          label: 'Drive credentials saved',
          body: 'OAuth credentials saved. Click "Authorize" to connect your Google account.',
        })
        return json({ ok: true })
      }

      // Returns the OAuth URL + client credentials so the Electron main process
      // can handle the browser flow and token exchange using Chromium networking.
      if (url.pathname === '/api/drive/auth-params' && request.method === 'GET') {
        const creds = await loadCredentials(cachedConfig.drive.credentialsPath)
        if (!creds) return text('Credentials not saved yet', 400)
        const redirectUri = 'http://localhost:8765/oauth2callback'
        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        authUrl.searchParams.set('client_id', creds.clientId)
        authUrl.searchParams.set('redirect_uri', redirectUri)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/drive.file')
        authUrl.searchParams.set('access_type', 'offline')
        authUrl.searchParams.set('prompt', 'consent')
        return json({
          authUrl: authUrl.toString(),
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          redirectUri,
          tokenPath: cachedConfig.drive.tokenPath,
        })
      }

      // Receives a completed token from the Electron main process after
      // it finishes the OAuth exchange using Chromium networking.
      if (url.pathname === '/api/drive/setup/token' && request.method === 'POST') {
        try {
          const payload = await parseRequestJson(request)
          const token = payload as OAuthToken
          if (!token?.access_token || !token?.refresh_token) {
            return text('Invalid token payload', 400)
          }
          await saveToken(cachedConfig.drive.tokenPath, token)

          const folderIds = await initializeDriveFolders(cachedConfig.drive)
          cachedConfig = {
            ...cachedConfig,
            drive: {
              ...cachedConfig.drive,
              folderIds: {
                root: folderIds.root,
                core: folderIds.core,
                reasoning: folderIds.reasoning,
                chains: folderIds.chains,
                failures: folderIds.failures,
                fewShots: folderIds.fewShots,
                categories: folderIds.categories,
                sessions: folderIds.sessions,
                adapters: folderIds.adapters,
              },
              setupComplete: true,
            },
          }
          await saveLauncherConfig(cachedConfig)
          await refreshDriveAuthState()

          emit({
            type: 'info',
            label: 'Drive ready',
            body: 'AgentMemory folder created in Google Drive. Cloud brain is active.',
          })
          return json({ ok: true, folderIds })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          emit({ type: 'stderr', line: `Drive token save failed: ${msg}` })
          return text(msg, 500)
        }
      }

      if (url.pathname === '/api/drive/setup/authorize' && request.method === 'POST') {
        emit({
          type: 'info',
          label: 'Drive authorization',
          body: 'Opening browser for Google sign-in. Return here after approving access.',
        })
        try {
          await runOAuthFlow(cachedConfig.drive)
          emit({
            type: 'info',
            label: 'Drive authorized',
            body: 'Google account connected. Initializing AgentMemory folder structure…',
          })

          // Initialize Drive folder tree
          const folderIds = await initializeDriveFolders(cachedConfig.drive)
          cachedConfig = {
            ...cachedConfig,
            drive: {
              ...cachedConfig.drive,
              folderIds: {
                root: folderIds.root,
                core: folderIds.core,
                reasoning: folderIds.reasoning,
                chains: folderIds.chains,
                failures: folderIds.failures,
                fewShots: folderIds.fewShots,
                categories: folderIds.categories,
                sessions: folderIds.sessions,
                adapters: folderIds.adapters,
              },
              setupComplete: true,
            },
          }
          await saveLauncherConfig(cachedConfig)
          await refreshDriveAuthState()

          emit({
            type: 'info',
            label: 'Drive ready',
            body:
              'AgentMemory folder created in Google Drive. ' +
              'The cloud brain is active — experience replay, journal, and context retrieval are live.',
          })
          return json({ ok: true, folderIds })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          emit({ type: 'stderr', line: `Drive authorization failed: ${msg}` })
          return text(msg, 500)
        }
      }

      if (url.pathname === '/api/drive/context' && request.method === 'POST') {
        if (!cachedConfig.drive.setupComplete) {
          return json({ context: '', reason: 'drive-not-configured' })
        }
        const payload = await parseRequestJson(request)
        const query = typeof payload.query === 'string' ? payload.query.trim() : ''
        if (!query) return json({ context: '' })
        const ollamaBaseUrl = cachedConfig.ollamaBaseUrl.trim() || 'http://localhost:11434/v1'
        const context = await retrieveContext(cachedConfig.drive, query, ollamaBaseUrl).catch(() => '')
        return json({ context })
      }

      if (url.pathname === '/api/drive/journal' && request.method === 'GET') {
        if (!cachedConfig.drive.setupComplete) return json({ journal: '' })
        const ollamaBaseUrl = cachedConfig.ollamaBaseUrl.trim() || 'http://localhost:11434/v1'
        const journal = await loadJournalContext(cachedConfig.drive).catch(() => '')
        return json({ journal })
      }

      // ── Agentic mode toggle ───────────────────────────────────────────────
      if (url.pathname === '/api/config/agentic-mode' && request.method === 'POST') {
        const payload = await parseRequestJson(request)
        const enabled = Boolean(payload.enabled)
        cachedConfig = { ...cachedConfig, enableAgenticLocalMode: enabled }
        await saveLauncherConfig(cachedConfig)
        const body =
          cachedConfig.localRuntimeEngine === 'shared-runtime'
            ? enabled
              ? 'Legacy in-process fallback keeps its full local agent loop enabled. Shared local runtime remains the primary Ollama engine.'
              : 'Legacy in-process fallback will stay in local safe mode if Jarvis has to fall back from the shared local runtime.'
            : enabled
              ? `Full legacy ReAct agent loop active. Using ${AGENTIC_OLLAMA_MODEL} with tool calling and Drive context injection.`
              : 'Switched the legacy local runtime to direct Ollama safe mode (no tool calling).'
        emit({
          type: 'info',
          label: enabled ? 'Agentic mode enabled' : 'Agentic mode disabled',
          body,
        })
        return json({ ok: true, enableAgenticLocalMode: cachedConfig.enableAgenticLocalMode })
      }

      // ── VRAM options update ───────────────────────────────────────────────
      if (url.pathname === '/api/config/vram' && request.method === 'POST') {
        const payload = await parseRequestJson(request)
        cachedConfig = {
          ...cachedConfig,
          ollamaVram: { ...cachedConfig.ollamaVram, ...(payload ?? {}) },
        }
        await saveLauncherConfig(cachedConfig)
        return json({ ok: true, ollamaVram: cachedConfig.ollamaVram })
      }

      return text('Not found', 404)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit({
        type: 'stderr',
        line: message,
      })
      return text(message, 500)
    }
  },
})

schedulePersist()

// ── Check Drive auth state on startup (non-blocking) ──────────────────────
refreshDriveAuthState().then(state => {
  if (state.status === 'ready') {
    emit({
      type: 'info',
      label: 'Cloud brain active',
      body:
        'Google Drive connected. Experience replay, journal, and context retrieval are live. ' +
        (cachedConfig.localRuntimeEngine === 'shared-runtime'
          ? `Shared local runtime selected - ${cachedConfig.ollamaModel} will use the Claude planning loop while the legacy fallback stays ${cachedConfig.enableAgenticLocalMode ? 'agentic' : 'safe'}.`
          : cachedConfig.enableAgenticLocalMode
            ? `Legacy local runtime selected - ${cachedConfig.ollamaModel} will use the full ReAct loop.`
            : 'Legacy local runtime is in safe mode - enable agentic mode to use local tool calling.'),
    })
  } else if (state.status === 'needs-credentials' || state.status === 'needs-oauth') {
    emit({
      type: 'info',
      label: 'Cloud brain not configured',
      body:
        'Google Drive is not connected. Open Settings → Cloud Brain to run the setup wizard ' +
        'and unlock experience replay, adaptive journal, and context retrieval.',
    })
  }
}).catch(() => undefined)

emit({
  type: 'info',
  label: 'Launcher ready',
  body: `Jarvis desktop launcher listening at ${server.url.href}`,
})

if (process.env.CLAUDE_BODY_DESKTOP_SKIP_OPEN === '1') {
  // biome-ignore lint/suspicious/noConsole: explicit smoke-test hook
  console.log(server.url.href)
}

if (process.env.CLAUDE_BODY_DESKTOP_SKIP_OPEN !== '1') {
  void open(server.url.href, { wait: false }).catch(error => {
    emit({
      type: 'stderr',
      line: `Failed to open browser automatically: ${String(error)}`,
    })
  })
}
