/**
 * Thunder Compute — Phase 2 Automation Engine
 *
 * Orchestrates all post-creation steps: tnr connect, SSH setup,
 * remote dependency install, vLLM launch, bridge start, port forwarding,
 * and end-to-end health check.
 */

import { exec } from 'child_process'
import { access, readFile, writeFile, unlink } from 'fs/promises'
import { tmpdir } from 'os'
import { homedir } from 'os'
import path from 'path'
import { spawn as spawnPty, type IPty } from 'node-pty'
import { Client as SshClient, type SFTPWrapper } from 'ssh2'
import type { BrowserWindow } from 'electron'
import { parseTnrStatus } from './thunderStatus.js'
import { execFileNoThrowWithCwd } from '../../utils/execFileNoThrow.js'
import type {
  ThunderSshInfo,
  ThunderStepId,
  ThunderStepState,
} from './thunderTypes.js'

type StepEmitter = {
  updateStep(stepId: ThunderStepId, state: ThunderStepState, error: string | null): void
  log(source: string, text: string): void
}

type AutomationContext = {
  instanceId: string
  bridgeApiKey: string
  emitter: StepEmitter
  mainWindow: BrowserWindow
  abortSignal: AbortSignal
}

type PtyCommandResult = {
  exitCode: number
  output: string
}

type PtySpawnImpl = typeof spawnPty

type SnapshotRuntimeProbe = {
  ready: boolean
  missing: string[]
  snapshotMarker: string | null
  gpuSummary: string | null
  vllmVersion: string | null
}

type BridgeHealthProbe = {
  ready: boolean
  ok: boolean
  auto_model_alias: string | null
  upstreams: Record<string, {
    ok?: boolean
    lane?: string
    model?: string
    base_url?: string
    models_listed?: string[]
    model_available?: boolean
    error?: string
    probe?: string
  }>
}

type RemoteBridgePayloadFile = {
  relativePath: string
  content: Buffer
}

type BridgeVerificationResult = {
  name: string
  status: 'ok' | 'warn' | 'error'
  detail: string
}

type BridgeLocalModelsProbeCategory =
  | 'ok'
  | 'upstream-not-ready'
  | 'auth-failed'
  | 'bridge-unreachable'
  | 'unexpected-status'

type RemoteBridgeVerification = {
  envStatus: 'launch-key' | 'placeholder' | 'unexpected-key' | 'missing'
  codeStatus: 'reasoning-fix-present' | 'reasoning-fix-missing' | 'missing'
  modelsStatusCode: number | null
  modelsCategory: BridgeLocalModelsProbeCategory
  modelsBody: string
  modelsError: string
}

type ResolvedInjectionCommandPaths = {
  tnrPath: string
  sshPath: string
}

type DirectSshTarget = {
  instanceId: string
  uuid: string
  ip: string
  port: number
  username: string
  keyPath: string
  tnrPath: string
  sshPath: string
}

type ThunderPublicUrlResolution = {
  publicUrl: string
  source: 'tnr ports forward' | 'tnr ports list'
}

type PublicHealthObservation = {
  statusCode: number | null
  bodySnippet: string
  note: string
}

const REMOTE_REPO_ROOT_MARKER_NAME = '.jarvis-remote-repo-root'
const REMOTE_REPO_ROOT_DIRNAME = 'claude-code-src-leaked'
const REMOTE_BRIDGE_RUNTIME_RELATIVE_PATHS = [
  'server/remote_glm_bridge/__init__.py',
  'server/remote_glm_bridge/config.py',
  'server/remote_glm_bridge/glm_backend.py',
  'server/remote_glm_bridge/main.py',
  'server/remote_glm_bridge/protocol.py',
  'server/remote_glm_bridge/requirements.txt',
  'server/remote_glm_bridge/schemas.py',
  'server/remote_glm_bridge/session_store.py',
] as const

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath)
    return true
  } catch {
    return false
  }
}

export function summarizeLogValue(value: string, maxLength = 160): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return '(empty)'
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
}

export function classifyBridgeLocalModelsProbe(
  statusCode: number | null,
): BridgeLocalModelsProbeCategory {
  if (statusCode === 200) {
    return 'ok'
  }
  if (statusCode === 503) {
    return 'upstream-not-ready'
  }
  if (statusCode === 401 || statusCode === 403) {
    return 'auth-failed'
  }
  if (statusCode === null || statusCode === 0) {
    return 'bridge-unreachable'
  }
  return 'unexpected-status'
}

export function formatBridgeVerificationResult(result: BridgeVerificationResult): string {
  const statusLabel =
    result.status === 'ok'
      ? 'OK'
      : result.status === 'warn'
        ? 'WARN'
        : 'FAIL'
  return `[bridge-verify] ${statusLabel} ${result.name} - ${result.detail}`
}

export function formatPublicHealthObservation(observation: PublicHealthObservation): string {
  if (observation.statusCode === null) {
    return `${observation.note}; body=${observation.bodySnippet || '(empty)'}`
  }
  return `HTTP ${observation.statusCode}; ${observation.note}; body=${observation.bodySnippet || '(empty)'}`
}

export function getRemoteBridgeRuntimeRelativePaths(): string[] {
  return [...REMOTE_BRIDGE_RUNTIME_RELATIVE_PATHS]
}

function getElectronResourcesPath(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return typeof resourcesPath === 'string' ? resourcesPath : null
}

async function resolveLocalBridgePayloadRoot(): Promise<string> {
  const resourcesPath = getElectronResourcesPath()
  const candidates = [
    process.env.JARVIS_REPO_ROOT,
    process.cwd(),
    resourcesPath ? path.join(resourcesPath, 'app.asar') : null,
    resourcesPath,
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidate of candidates) {
    const bridgeMainPath = path.join(candidate, 'server', 'remote_glm_bridge', 'main.py')
    if (await pathExists(bridgeMainPath)) {
      return candidate
    }
  }

  throw new Error(
    'Could not locate the local bridge runtime payload. Checked the repo root, current working directory, and packaged app resources.',
  )
}

async function loadLocalBridgePayload(): Promise<RemoteBridgePayloadFile[]> {
  const payloadRoot = await resolveLocalBridgePayloadRoot()
  return Promise.all(
    REMOTE_BRIDGE_RUNTIME_RELATIVE_PATHS.map(async relativePath => ({
      relativePath,
      content: await readFile(path.join(payloadRoot, relativePath)),
    })),
  )
}

function buildRemoteRepoRootMarkerPath(remoteRepoRoot: string): string {
  return path.posix.join(path.posix.dirname(remoteRepoRoot), REMOTE_REPO_ROOT_MARKER_NAME)
}

export function buildBridgeProvisionPromoteCommand(
  stagingDir: string,
  remoteRepoRoot: string,
): string {
  const stagedBridgeDir = path.posix.join(stagingDir, 'server', 'remote_glm_bridge')
  const targetServerDir = path.posix.join(remoteRepoRoot, 'server')
  const targetBridgeDir = path.posix.join(targetServerDir, 'remote_glm_bridge')
  const targetBridgeTmp = `${targetBridgeDir}.jarvis-next`
  const targetBridgeBak = `${targetBridgeDir}.jarvis-prev`
  const markerPath = buildRemoteRepoRootMarkerPath(remoteRepoRoot)

  return [
    'set -e',
    `STAGING_DIR=${shellQuote(stagingDir)}`,
    `STAGED_BRIDGE_DIR=${shellQuote(stagedBridgeDir)}`,
    `REMOTE_REPO_ROOT=${shellQuote(remoteRepoRoot)}`,
    `REMOTE_REPO_ROOT_MARKER=${shellQuote(markerPath)}`,
    `TARGET_SERVER_DIR=${shellQuote(targetServerDir)}`,
    `TARGET_BRIDGE_DIR=${shellQuote(targetBridgeDir)}`,
    `TARGET_BRIDGE_TMP=${shellQuote(targetBridgeTmp)}`,
    `TARGET_BRIDGE_BAK=${shellQuote(targetBridgeBak)}`,
    'cleanup_mode=error',
    'restore_backup=0',
    'cleanup() {',
    '  status=$?',
    '  if [ "$cleanup_mode" != "success" ] && [ "$restore_backup" = "1" ] && [ -d "$TARGET_BRIDGE_BAK" ] && [ ! -e "$TARGET_BRIDGE_DIR" ]; then',
    '    mv "$TARGET_BRIDGE_BAK" "$TARGET_BRIDGE_DIR"',
    '  fi',
    '  rm -rf "$TARGET_BRIDGE_TMP" "$STAGING_DIR"',
    '  if [ "$cleanup_mode" = "success" ]; then',
    '    rm -rf "$TARGET_BRIDGE_BAK"',
    '  fi',
    '  exit $status',
    '}',
    'trap cleanup EXIT',
    'mkdir -p "$TARGET_SERVER_DIR"',
    '[ -f "$STAGED_BRIDGE_DIR/main.py" ]',
    '[ -f "$STAGED_BRIDGE_DIR/requirements.txt" ]',
    'rm -rf "$TARGET_BRIDGE_TMP" "$TARGET_BRIDGE_BAK"',
    'mv "$STAGED_BRIDGE_DIR" "$TARGET_BRIDGE_TMP"',
    'if [ -e "$TARGET_BRIDGE_DIR" ]; then',
    '  mv "$TARGET_BRIDGE_DIR" "$TARGET_BRIDGE_BAK"',
    '  restore_backup=1',
    'fi',
    'mv "$TARGET_BRIDGE_TMP" "$TARGET_BRIDGE_DIR"',
    'restore_backup=0',
    'mkdir -p "$(dirname "$REMOTE_REPO_ROOT_MARKER")" 2>/dev/null || true',
    'printf "%s\\n" "$REMOTE_REPO_ROOT" > "$REMOTE_REPO_ROOT_MARKER"',
    'cleanup_mode=success',
  ].join('\n')
}

export function getThunderAutomationStepSequence(snapshotReady: boolean): ThunderStepId[] {
  return snapshotReady
    ? [
        'connect-instance',
        'get-ssh-info',
        'pull-bridge',
        'start-vllm',
        'poll-vllm',
        'start-bridge',
        'poll-bridge',
        'verify-ports',
        'forward-port',
        'health-check',
        'save-config',
      ]
    : [
        'connect-instance',
        'get-ssh-info',
        'pull-bridge',
        'system-prep',
        'start-vllm',
        'poll-vllm',
        'start-bridge',
        'poll-bridge',
        'verify-ports',
        'forward-port',
        'health-check',
        'save-config',
    ]
}

export function parseBridgeHealthProbe(text: string): BridgeHealthProbe | null {
  try {
    const parsed = JSON.parse(text) as BridgeHealthProbe
    if (!parsed || typeof parsed !== 'object') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

export function formatBridgeHealthProbeSummary(health: BridgeHealthProbe): string {
  const upstreamSummaries = Object.entries(health.upstreams ?? {})
    .map(([lane, status]) => {
      if (status.ok) {
        return `${lane}:ok`
      }
      const detail =
        status.error ??
        (status.model_available === false ? 'model unavailable' : 'unhealthy')
      return `${lane}:not-ready(${detail})`
    })
    .join(', ')

  return `ready=${health.ready}; ok=${health.ok}; upstreams=${upstreamSummaries || '(none)'}`
}

export function extractThunderPortUrl(text: string, port = 8787): string | null {
  const portText = String(port)
  const candidates = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? []

  for (const candidate of candidates) {
    const normalized = candidate.replace(/[),.;]+$/g, '')
    if (normalized.includes(portText)) {
      return normalized
    }
  }

  const match = text.match(new RegExp(`https?:\\/\\/[^\\s"'<>]*${portText}[^\\s"'<>]*`, 'i'))
  return match ? match[0] : null
}

function normalizeThunderPublicUrl(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url.replace(/\/+$/, '')
  }
}

export function resolveThunderPublicUrl(text: string, port = 8787): string | null {
  const directUrl = extractThunderPortUrl(text, port)
  if (directUrl) {
    return normalizeThunderPublicUrl(directUrl)
  }

  const portText = String(port)
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }

    const lower = trimmed.toLowerCase()
    if (
      lower.startsWith('id  ') ||
      lower.startsWith('id\t') ||
      lower.startsWith('id ') ||
      lower.startsWith('uuid ') ||
      lower.includes('forwarded ports') ||
      lower.includes('access forwarded ports')
    ) {
      continue
    }

    const match = trimmed.match(/^(\S+)\s+([a-z0-9-]+)\s+(\S+)\s+(.+)$/i)
    if (!match) {
      continue
    }

    const uuid = match[2]
    const forwardedPorts = match[4]
    if (new RegExp(`(^|\\s)${portText}(?:\\s|$)`).test(forwardedPorts)) {
      return normalizeThunderPublicUrl(`https://${uuid}-${portText}.thundercompute.net`)
    }
  }

  return null
}

export function buildThunderHealthCheckUrl(publicUrl: string): string {
  return new URL('/healthz', publicUrl).toString()
}

function buildRemoteRepoRootResolutionPrelude(strict: boolean): string {
  return [
    'REMOTE_REPO_ROOT_MARKER="$HOME/.jarvis-remote-repo-root"',
    'read_remote_repo_root_marker() {',
    '  if [ -f "$REMOTE_REPO_ROOT_MARKER" ]; then',
    '    marker_root="$(tr -d \'\\r\\n\' < "$REMOTE_REPO_ROOT_MARKER" 2>/dev/null)"',
    '    if [ -n "$marker_root" ] && [ -f "$marker_root/server/remote_glm_bridge/main.py" ]; then',
    '      printf "%s" "$marker_root"',
    '      return 0',
    '    fi',
    '  fi',
    '  return 1',
    '}',
    'cache_remote_repo_root() {',
    '  mkdir -p "$(dirname "$REMOTE_REPO_ROOT_MARKER")" 2>/dev/null || true',
    '  printf "%s\\n" "$REMOTE_REPO_ROOT" > "$REMOTE_REPO_ROOT_MARKER" 2>/dev/null || true',
    '}',
    'resolve_remote_repo_root() {',
    '  if [ -n "${JARVIS_REMOTE_REPO_ROOT:-}" ] && [ -f "${JARVIS_REMOTE_REPO_ROOT%/}/server/remote_glm_bridge/main.py" ]; then',
    '    printf "%s" "${JARVIS_REMOTE_REPO_ROOT%/}"',
    '    return 0',
    '  fi',
    '  marker_root="$(read_remote_repo_root_marker 2>/dev/null || true)"',
    '  if [ -n "$marker_root" ]; then',
    '    printf "%s" "$marker_root"',
    '    return 0',
    '  fi',
    '  for candidate in "$HOME/claude-code-src-leaked" "$HOME/workspace/claude-code-src-leaked" "$HOME/src/claude-code-src-leaked" "$HOME/projects/claude-code-src-leaked" "/workspace/claude-code-src-leaked" "/opt/claude-code-src-leaked"; do',
    '    if [ -f "$candidate/server/remote_glm_bridge/main.py" ]; then',
    '      printf "%s" "$candidate"',
    '      return 0',
    '    fi',
    '  done',
    '  remote_main="$(find "$HOME" -maxdepth 8 -type f -path "*/server/remote_glm_bridge/main.py" 2>/dev/null | head -n 1)"',
    '  if [ -n "$remote_main" ]; then',
    '    printf "%s" "${remote_main%/server/remote_glm_bridge/main.py}"',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    'REMOTE_REPO_ROOT="$(resolve_remote_repo_root)"',
    'if [ -z "$REMOTE_REPO_ROOT" ]; then',
    strict
      ? '  echo "REMOTE_REPO_ROOT_MISSING"'
      : '  REMOTE_REPO_ROOT=""',
    strict ? '  exit 1' : '  :',
    'fi',
    'if [ -n "$REMOTE_REPO_ROOT" ]; then',
    '  cache_remote_repo_root',
    'fi',
    'export JARVIS_REMOTE_REPO_ROOT="$REMOTE_REPO_ROOT"',
  ].join('\n')
}

export function buildSnapshotRuntimeProbeCommand(): string {
  return [
    'set +e',
    buildRemoteRepoRootResolutionPrelude(false),
    'snapshot_marker=""',
    'for candidate in /etc/thunder-snapshot.manifest "$HOME/.thunder-snapshot" "$HOME/vllm-env/.thunder-snapshot" "$REMOTE_REPO_ROOT/.thunder-snapshot"; do',
    '  if [ -f "$candidate" ]; then',
    '    snapshot_marker="$candidate"',
    '    break',
    '  fi',
    'done',
    'model_cache_ready=0',
    'for candidate in "$HOME/.cache/huggingface/hub/models--openai--gpt-oss-120b" "$HOME/.cache/huggingface/hub/models--openai--gpt-oss-120b/snapshots" "$HOME/.cache/huggingface/hub/models--openai--gpt-oss-120b/blobs" "$HOME/gptoss-120b" "$HOME/models/gpt-oss-120b"; do',
    '  if [ -d "$candidate" ]; then',
    '    model_cache_ready=1',
    '    break',
    '  fi',
    'done',
    'echo "SNAPSHOT_MARKER=${snapshot_marker}"',
    'echo "GPU_SUMMARY=$(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null | head -1)"',
    'curl_ready=0',
    'if command -v curl >/dev/null 2>&1; then',
    '  curl_ready=1',
    'fi',
    'echo "CURL_READY=${curl_ready}"',
    'venv_ready=0',
    'if [ -f "$HOME/vllm-env/bin/activate" ]; then',
    '  venv_ready=1',
    'fi',
    'echo "VENV_READY=${venv_ready}"',
    'echo "MODEL_CACHE_READY=${model_cache_ready}"',
    'bridge_ready=0',
    'if [ -n "$REMOTE_REPO_ROOT" ] && [ -f "$REMOTE_REPO_ROOT/server/remote_glm_bridge/main.py" ]; then',
    '  bridge_ready=1',
    'fi',
    'echo "BRIDGE_READY=${bridge_ready}"',
    'echo "GPT_OSS_RUNTIME_READY=0"',
    'echo "MXFP4_READY=0"',
    'if [ -f "$HOME/vllm-env/bin/activate" ]; then',
    '  . "$HOME/vllm-env/bin/activate"',
    '  python3 -c "import importlib.util; import vllm; from vllm import ModelRegistry; supported = set(ModelRegistry.get_supported_archs()); has_gpt_oss = (\'GptOssForCausalLM\' in supported) or (\'GPTForCausalLM\' in supported) or (importlib.util.find_spec(\'vllm.model_executor.models.gpt_oss\') is not None); has_mxfp4 = importlib.util.find_spec(\'vllm.model_executor.layers.quantization.mxfp4\') is not None; print(\'VLLM_VERSION=\' + vllm.__version__); print(\'GPT_OSS_RUNTIME_READY=\' + (\'1\' if has_gpt_oss else \'0\')); print(\'MXFP4_READY=\' + (\'1\' if has_mxfp4 else \'0\'))" 2>/dev/null || true',
    'fi',
  ].join('\n')
}

export function parseSnapshotRuntimeProbe(text: string): SnapshotRuntimeProbe {
  const pairs = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (match) {
      pairs.set(match[1], match[2].trim())
    }
  }

  const snapshotMarker = pairs.get('SNAPSHOT_MARKER') ?? ''
  const gpuSummary = pairs.get('GPU_SUMMARY') ?? ''
  const hasCurl = pairs.get('CURL_READY') === '1'
  const hasVenv = pairs.get('VENV_READY') === '1'
  const hasModelCache = pairs.get('MODEL_CACHE_READY') === '1'
  const hasBridge = pairs.get('BRIDGE_READY') === '1'
  const hasGptOssRuntime = pairs.get('GPT_OSS_RUNTIME_READY') === '1'
  const hasMxfp4 = pairs.get('MXFP4_READY') === '1'
  const vllmVersion = pairs.get('VLLM_VERSION') ?? ''

  const missing: string[] = []
  if (!gpuSummary) missing.push('GPU')
  if (!hasCurl) missing.push('curl')
  if (!hasVenv) missing.push('vllm-env')
  if (!hasModelCache) missing.push('model cache')
  if (!hasBridge) missing.push('bridge runtime')
  if (!hasGptOssRuntime) missing.push('native GPT-OSS runtime')
  if (!hasMxfp4) missing.push('MXFP4 support')
  if (!vllmVersion) missing.push('vLLM import')

  return {
    ready: missing.length === 0,
    missing,
    snapshotMarker: snapshotMarker || null,
    gpuSummary: gpuSummary || null,
    vllmVersion: vllmVersion || null,
  }
}

export function extractLatestVllmProgress(
  text: string,
): { summary: string; shardNum: number } {
  const matches = [...text.matchAll(
    /Loading safetensors checkpoint shards:\s*(\d+)%.*?\|?\s*(\d+)\/(\d+)/gi,
  )]
  const match = matches.at(-1)
  if (!match) {
    return { summary: '', shardNum: -1 }
  }
  return {
    summary: `${match[1]}% (${match[2]}/${match[3]} shards)`,
    shardNum: parseInt(match[2]!, 10),
  }
}

export function buildLegacyRuntimePrepCommand(): string {
  return [
    buildRemoteRepoRootResolutionPrelude(false),
    'export DEBIAN_FRONTEND=noninteractive',
    'run_with_heartbeat() {',
    '  label="$1"',
    '  shift',
    '  heartbeat() {',
    '    while sleep 60; do',
    '      echo "${label}: still working..."',
    '    done',
    '  }',
    '  heartbeat &',
    '  heartbeat_pid=$!',
    '  "$@"',
    '  status=$?',
    '  kill "$heartbeat_pid" 2>/dev/null || true',
    '  wait "$heartbeat_pid" 2>/dev/null || true',
    '  return $status',
    '}',
    'run_with_heartbeat apt-get-update sudo apt-get update',
    'run_with_heartbeat apt-get-install sudo apt-get install -y python3-venv python3-pip build-essential curl',
    'if [ ! -x "$HOME/vllm-env/bin/python" ]; then',
    '  python3 -m venv "$HOME/vllm-env"',
    'fi',
    '. "$HOME/vllm-env/bin/activate"',
    'run_with_heartbeat pip-upgrade python -m pip install --upgrade pip',
    'if [ -z "$REMOTE_REPO_ROOT" ]; then',
    '  echo "REMOTE_REPO_ROOT_MISSING_AFTER_PROVISIONING"',
    '  exit 1',
    'fi',
    'run_with_heartbeat vllm-install python -m pip install --no-cache-dir --upgrade "vllm>=0.12.0"',
    'BRIDGE_REQUIREMENTS="$REMOTE_REPO_ROOT/server/remote_glm_bridge/requirements.txt"',
    'if [ -f "$BRIDGE_REQUIREMENTS" ]; then',
    '  run_with_heartbeat bridge-requirements python -m pip install --no-cache-dir --upgrade -r "$BRIDGE_REQUIREMENTS"',
    'else',
    '  echo "BRIDGE_REQUIREMENTS_MISSING"',
    '  run_with_heartbeat bridge-fallback python -m pip install --no-cache-dir --upgrade fastapi uvicorn httpx pydantic',
    'fi',
    'export PYTHONPATH="$REMOTE_REPO_ROOT:${PYTHONPATH:-}"',
    'python -m compileall "$REMOTE_REPO_ROOT/server/remote_glm_bridge"',
    'python -c "import server.remote_glm_bridge.main"',
    'python -c "import importlib.util; import vllm; from vllm import ModelRegistry; supported = set(ModelRegistry.get_supported_archs()); has_gpt_oss = (\'GptOssForCausalLM\' in supported) or (\'GPTForCausalLM\' in supported) or (importlib.util.find_spec(\'vllm.model_executor.models.gpt_oss\') is not None); has_mxfp4 = importlib.util.find_spec(\'vllm.model_executor.layers.quantization.mxfp4\') is not None; assert has_gpt_oss; assert has_mxfp4; print(\'VLLM_VERSION=\' + vllm.__version__); print(\'GPT_OSS_RUNTIME_READY=1\'); print(\'MXFP4_READY=1\')"',
    'grep -qxF \'export PATH="$HOME/.local/bin:$PATH"\' ~/.bashrc || echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc',
    'export PATH="$HOME/.local/bin:$PATH"',
    'CANDIDATES=$(find /usr/lib/x86_64-linux-gnu /usr/local/cuda /usr/local/nvidia /usr/lib64 /opt/thunder /opt/nvidia /usr/lib /lib /lib64 -maxdepth 5 -name "libcuda.so*" 2>/dev/null | head -n 20)',
    'REAL_LIB=$(printf "%s\\n" "$CANDIDATES" | grep -v "/stubs/" | grep -E "libcuda\\.so(\\.1)?$" | head -n 1)',
    'if [ -z "$REAL_LIB" ]; then',
    '  echo "Could not find libcuda.so.1 anywhere on this Thunder Compute instance."',
    '  exit 1',
    'fi',
    'LIB_DIR=${REAL_LIB%/*}',
    'sudo mkdir -p /usr/lib/x86_64-linux-gnu',
    '[ -e /usr/lib/x86_64-linux-gnu/libcuda.so.1 ] || sudo ln -sf "$REAL_LIB" /usr/lib/x86_64-linux-gnu/libcuda.so.1',
    '[ -e /usr/lib/x86_64-linux-gnu/libcuda.so ] || sudo ln -sf "$REAL_LIB" /usr/lib/x86_64-linux-gnu/libcuda.so',
    'printf "%s\\n%s\\n/usr/local/cuda/lib64\\n/usr/local/cuda/lib64/stubs\\n" /usr/lib/x86_64-linux-gnu "$LIB_DIR" | sudo tee /etc/ld.so.conf.d/jarvis-cuda.conf > /dev/null',
    'sudo ldconfig',
    'python -c "import ctypes; ctypes.CDLL(\'libcuda.so.1\'); import vllm; print(\'VLLM_VERSION=\' + vllm.__version__)"',
  ].join('\n')
}

export function buildVllmLaunchCommand(): string {
  return [
    'export CUDA_VISIBLE_DEVICES=0',
    'export VLLM_TARGET_DEVICE=cuda',
    'export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True',
    'export LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu:/usr/local/cuda/lib64:/usr/local/cuda/lib64/stubs:/usr/local/nvidia/lib64:${LD_LIBRARY_PATH:-}',
    'mv ~/gptoss-120b.log ~/gptoss-120b.log.bak 2>/dev/null || true',
    'python3 -c "import ctypes; ctypes.CDLL(\'libcuda.so.1\')" || { echo "PRELAUNCH_LIBCUDA_FAIL"; exit 1; }',
    '. "$HOME/vllm-env/bin/activate"',
    'python3 -c "import importlib.util; from vllm import ModelRegistry; supported = set(ModelRegistry.get_supported_archs()); has_gpt_oss = (\'GptOssForCausalLM\' in supported) or (\'GPTForCausalLM\' in supported) or (importlib.util.find_spec(\'vllm.model_executor.models.gpt_oss\') is not None); has_mxfp4 = importlib.util.find_spec(\'vllm.model_executor.layers.quantization.mxfp4\') is not None; assert has_gpt_oss; assert has_mxfp4; print(\'GPT_OSS_RUNTIME_READY=1\'); print(\'MXFP4_READY=1\')" || { echo "GPT_OSS_RUNTIME_UNSUPPORTED"; exit 1; }',
    'export PYTHONPATH="$HOME:${PYTHONPATH:-}"',
    'nohup python3 -m vllm.entrypoints.openai.api_server \\',
    '  --model openai/gpt-oss-120b \\',
    '  --host 0.0.0.0 \\',
    '  --port 8000 \\',
    '  --dtype auto \\',
    '  --gpu-memory-utilization 0.85 \\',
    '  --max-model-len 2048 \\',
    '  --max-num-seqs 2 \\',
    '  --max-num-batched-tokens 2048 \\',
    '  --block-size 16 \\',
    '  --enforce-eager \\',
    '  --trust-remote-code \\',
    '  --no-enable-log-requests \\',
    '  --generation-config vllm > ~/gptoss-120b.log 2>&1 &',
    'echo "VLLM_PID=$!"',
  ].join('\n')
}

export function buildBridgeLaunchCommand(bridgeApiKey: string): string {
  return [
    buildRemoteRepoRootResolutionPrelude(true),
    '. "$HOME/vllm-env/bin/activate"',
    'cd "$REMOTE_REPO_ROOT"',
    'export PYTHONPATH="$REMOTE_REPO_ROOT:${PYTHONPATH:-}"',
    `export GPT_OSS_BRIDGE_API_KEYS="${bridgeApiKey}"`,
    'export GPT_OSS_BASE_URL="http://127.0.0.1:8000/v1"',
    'export GPT_OSS_PRIMARY_MODEL="openai/gpt-oss-120b"',
    'export GPT_OSS_FAST_BASE_URL="http://127.0.0.1:8000/v1"',
    'export GPT_OSS_FAST_MODEL="openai/gpt-oss-120b"',
    'export GPT_OSS_AUTO_MODEL_ALIAS="gpt-oss-auto"',
    'nohup python3 -m uvicorn server.remote_glm_bridge.main:app \\',
    '  --host 0.0.0.0 --port 8787 > ~/jarvis-bridge.log 2>&1 &',
    'echo "BRIDGE_PID=$!"',
  ].join('\n')
}

function execAsync(
  command: string,
  options: { timeout?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { timeout: options.timeout ?? 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\nstderr: ${stderr}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function resolvePreferredExecutable(
  preferredPaths: string[],
  fallback: string,
): Promise<string> {
  for (const candidate of preferredPaths) {
    if (await pathExists(candidate)) {
      return candidate
    }
  }
  return fallback
}

async function resolveInjectionCommandPaths(): Promise<ResolvedInjectionCommandPaths> {
  const tnrPath = await resolvePreferredExecutable(
    process.platform === 'win32'
      ? ['C:/Program Files (x86)/tnr/tnr.exe']
      : [],
    'tnr',
  )
  const sshPath = await resolvePreferredExecutable(
    process.platform === 'win32'
      ? ['C:/Windows/System32/OpenSSH/ssh.exe']
      : [],
    'ssh',
  )
  return { tnrPath, sshPath }
}

function formatCommandFailure(
  file: string,
  args: string[],
  result: { stdout: string; stderr: string; code: number; error?: string },
): string {
  const renderedCommand = [file, ...args].join(' ')
  const detail = result.error || `exit code ${result.code}`
  const parts = [`${renderedCommand} failed: ${detail}`]
  const stderr = summarizeLogValue(result.stderr || '')
  const stdout = summarizeLogValue(result.stdout || '')
  if (stderr !== '(empty)') {
    parts.push(`stderr=${stderr}`)
  }
  if (stdout !== '(empty)') {
    parts.push(`stdout=${stdout}`)
  }
  return parts.join('\n')
}

async function runDeterministicCommand(
  file: string,
  args: string[],
  options: {
    timeout?: number
    input?: string
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileNoThrowWithCwd(file, args, {
    cwd: process.cwd(),
    env: process.env,
    timeout: options.timeout ?? 30_000,
    stdin: typeof options.input === 'string' ? 'pipe' : 'ignore',
    input: options.input,
  })
  if (result.code !== 0) {
    throw new Error(formatCommandFailure(file, args, result))
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

type PtyCommandOptions = {
  command: string
  args: string[]
  emitter: StepEmitter
  source: string
  timeoutMs?: number
  abortSignal?: AbortSignal
  cwd?: string
  env?: Record<string, string | undefined>
  spawnImpl?: PtySpawnImpl
  successPatterns?: Array<RegExp | string>
  successDebounceMs?: number
}

function getPtyLaunchSpec(
  command: string,
  args: string[],
): {
  file: string
  args: string[]
} {
  if (process.platform === 'win32') {
    return {
      file: 'cmd.exe',
      args: ['/c', command, ...args],
    }
  }

  return {
    file: command,
    args,
  }
}

// Run interactive CLI commands through a PTY so they can initialize terminal
// state on Windows without wedging the backend automation pipeline.
export async function runPtyCommand(
  options: PtyCommandOptions,
): Promise<PtyCommandResult> {
  const {
    command,
    args,
    emitter,
    source,
    timeoutMs = 30_000,
    abortSignal,
    cwd = process.cwd(),
    env = process.env as Record<string, string | undefined>,
    spawnImpl = spawnPty,
    successPatterns = [],
    successDebounceMs = 250,
  } = options

  if (abortSignal?.aborted) {
    throw new Error('Operation aborted before launch.')
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let terminal: IPty | null = null
    let output = ''
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    let successHandle: ReturnType<typeof setTimeout> | null = null
    let successDetected = false

    const cleanup = (): void => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      if (successHandle) {
        clearTimeout(successHandle)
        successHandle = null
      }
      abortSignal?.removeEventListener('abort', onAbort)
      terminal = null
    }

    const finish = (err: Error | null, result?: PtyCommandResult): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (err) {
        reject(err)
        return
      }
      resolve(result!)
    }

    const killTerminal = (): void => {
      try {
        terminal?.kill()
      } catch {
        // Best effort cleanup.
      }
    }

    const matchesSuccessPattern = (text: string): boolean => {
      if (successPatterns.length === 0) {
        return false
      }
      return successPatterns.some(pattern =>
        typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text),
      )
    }

    const resolveAfterSuccess = (): void => {
      if (successHandle || settled) {
        return
      }
      successHandle = setTimeout(() => {
        killTerminal()
        finish(null, { exitCode: 0, output })
      }, successDebounceMs)
    }

    const onAbort = (): void => {
      killTerminal()
      finish(
        new Error(`Operation aborted while running ${command} ${args.join(' ')}`),
      )
    }

    try {
      const launchSpec = getPtyLaunchSpec(command, args)
      const ptyOptions =
        process.platform === 'win32'
          ? {
              name: 'xterm-256color',
              cols: 80,
              rows: 24,
              cwd,
              env,
              useConpty: true,
            }
          : {
              name: 'xterm-256color',
              cols: 80,
              rows: 24,
              cwd,
              env,
            }
      terminal = spawnImpl(launchSpec.file, launchSpec.args, {
        ...ptyOptions,
      } as Parameters<PtySpawnImpl>[2])
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)))
      return
    }

    terminal.onData(chunk => {
      output += chunk
      emitter.log(source, chunk)
      if (!successDetected && matchesSuccessPattern(output)) {
        successDetected = true
        resolveAfterSuccess()
      }
    })

    terminal.onExit(({ exitCode, signal }) => {
      const normalizedExitCode = typeof exitCode === 'number' ? exitCode : 1
      if (normalizedExitCode !== 0) {
        const tail = output.trimEnd().slice(-500)
        finish(
          new Error(
            `${command} ${args.join(' ')} exited with code ${normalizedExitCode}${signal !== undefined ? ` (signal ${signal})` : ''}.\n${tail}`,
          ),
        )
        return
      }
      finish(null, { exitCode: normalizedExitCode, output })
    })

    abortSignal?.addEventListener('abort', onAbort, { once: true })

    timeoutHandle = setTimeout(() => {
      killTerminal()
      finish(
        new Error(
          `${command} ${args.join(' ')} timed out after ${timeoutMs / 1000}s.`,
        ),
      )
    }, timeoutMs)
  })
}

/**
 * Execute a command on the remote GPU instance via SSH.
 * Streams stdout/stderr to the emitter. Rejects on non-zero exit.
 *
 * @param stallTimeoutMs  If set, the promise rejects if no new output arrives
 *                        within this window. Essential for catching silent pip
 *                        hangs during vLLM shard downloads.
 */
function sshExec(
  client: SshClient,
  command: string,
  emitter: StepEmitter,
  source: string,
  timeoutMs: number = 300_000,
  stallTimeoutMs?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false

    const finish = (err: Error | null, result?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(wallTimer)
      if (stallHandle) clearTimeout(stallHandle)
      if (err) { reject(err); return }
      resolve(result!)
    }

    // Wall-clock timeout — hard cap regardless of activity
    const wallTimer = setTimeout(() => {
      finish(new Error(`SSH command timed out after ${timeoutMs / 1000}s: ${command.slice(0, 80)}`))
    }, timeoutMs)

    // Activity watchdog — reset on every chunk of output
    let stallHandle: ReturnType<typeof setTimeout> | null = null
    const resetStallTimer = (): void => {
      if (!stallTimeoutMs) return
      if (stallHandle) clearTimeout(stallHandle)
      stallHandle = setTimeout(() => {
        finish(
          new Error(
            `SSH command stalled — no output for ${stallTimeoutMs / 1000}s: ${command.slice(0, 80)}\n` +
            `Last output:\n${output.slice(-400)}`,
          ),
        )
      }, stallTimeoutMs)
    }
    resetStallTimer()

    client.exec(command, (err, stream) => {
      if (err) {
        finish(err)
        return
      }
      stream.on('data', (data: Buffer) => {
        const text = data.toString()
        output += text
        emitter.log(source, text)
        resetStallTimer()
      })
      stream.stderr.on('data', (data: Buffer) => {
        const text = data.toString()
        output += text
        emitter.log(source, text)
        resetStallTimer()
      })
      stream.on('close', (code: number) => {
        if (code !== 0) {
          finish(
            new Error(
              `Remote command exited with code ${code}: ${command.slice(0, 80)}\n${output.slice(-500)}`,
            ),
          )
          return
        }
        finish(null, output)
      })
    })
  })
}

function connectSshOnce(info: ThunderSshInfo, privateKey: Buffer): Promise<SshClient> {
  return new Promise((resolve, reject) => {
    const client = new SshClient()
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({
        host: info.host,
        port: info.port,
        username: info.username,
        privateKey,
        // Send a keepalive packet every 15 seconds, tolerate up to 4 missed
        // before treating the connection as dead. This keeps the session alive
        // during the 25-minute vLLM model loading window.
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
      })
  })
}

async function connectSsh(
  info: ThunderSshInfo,
  privateKey: Buffer,
  emitter: StepEmitter,
): Promise<SshClient> {
  const MAX_ATTEMPTS = 6
  const RETRY_DELAY_MS = 10_000

  let lastError: Error | null = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await connectSshOnce(info, privateKey)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < MAX_ATTEMPTS) {
        emitter.log(
          'get-ssh-info',
          `SSH connection attempt ${attempt}/${MAX_ATTEMPTS} failed: ${lastError.message.split('\n')[0]}. ` +
          `Retrying in ${RETRY_DELAY_MS / 1000}s...`,
        )
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
      }
    }
  }
  throw new Error(
    `SSH connection failed after ${MAX_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
  )
}

function openSftp(client: SshClient): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(err)
        return
      }
      resolve(sftp)
    })
  })
}

function sftpWriteFile(
  sftp: SFTPWrapper,
  remotePath: string,
  data: Buffer,
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.writeFile(remotePath, data, err => {
      if (err) {
        reject(err)
        return
      }
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

// Patterns that indicate the SSH daemon is not yet ready on the remote
// instance. These are transient errors that should trigger a retry rather
// than an immediate failure.
const SSH_NOT_READY_PATTERNS = [
  /ssh service not available/i,
  /tcp port check failed/i,
  /connection.*(refused|reset|timed out)/i,
  /no connection could be made/i,
]

function isSshNotReadyError(message: string): boolean {
  return SSH_NOT_READY_PATTERNS.some(re => re.test(message))
}

async function stepConnectInstance(ctx: AutomationContext): Promise<string> {
  ctx.emitter.updateStep('connect-instance', 'active', null)

  const MAX_ATTEMPTS = 8
  const RETRY_DELAY_MS = 15_000

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (ctx.abortSignal.aborted) {
      const abortErr = new Error('Automation aborted by user')
      ctx.emitter.updateStep('connect-instance', 'error', abortErr.message)
      throw abortErr
    }

    try {
      const result = await runPtyCommand({
        command: 'tnr',
        args: ['connect', ctx.instanceId],
        emitter: ctx.emitter,
        source: 'connect-instance',
        abortSignal: ctx.abortSignal,
        timeoutMs: 120_000,
        successPatterns: [
          /Connection established successfully/i,
          /Welcome to Thunder Compute/i,
        ],
        successDebounceMs: 500,
      })
      ctx.emitter.log(
        'connect-instance',
        `Connected to Thunder instance ${ctx.instanceId}; continuing with SSH setup.`,
      )
      ctx.emitter.updateStep('connect-instance', 'done', null)
      return result.output
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))

      if (!isSshNotReadyError(lastError.message)) {
        // Not a transient SSH-not-ready error — fail immediately.
        ctx.emitter.updateStep('connect-instance', 'error', lastError.message)
        throw lastError
      }

      if (attempt < MAX_ATTEMPTS) {
        ctx.emitter.log(
          'connect-instance',
          `SSH service not ready on attempt ${attempt}/${MAX_ATTEMPTS}. ` +
          `Retrying in ${RETRY_DELAY_MS / 1000}s... (${lastError.message.split('\n')[0]})`,
        )
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, RETRY_DELAY_MS)
          ctx.abortSignal.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          }, { once: true })
        })
      }
    }
  }

  const finalMsg =
    `Could not connect to instance ${ctx.instanceId} after ${MAX_ATTEMPTS} attempts. ` +
    `SSH service never became available.\n${lastError?.message ?? ''}`
  ctx.emitter.updateStep('connect-instance', 'error', finalMsg)
  throw new Error(finalMsg)
}

function extractSshInfoFromText(text: string): Partial<ThunderSshInfo> {
  const info: Partial<ThunderSshInfo> = {}

  const hostMatch = text.match(
    /(?:ssh\s+.*?@)?(\d+\.\d+\.\d+\.\d+|[\w.-]+\.thundercompute\.\w+)/i,
  )
  if (hostMatch) {
    info.host = hostMatch[1]
  }

  const portMatch = text.match(/-p\s+(\d+)/)
  if (portMatch) {
    info.port = parseInt(portMatch[1], 10)
  }

  const keyMatch = text.match(/-i\s+"?([^"\s]+)"?/)
  if (keyMatch) {
    info.privateKeyPath = keyMatch[1]
  }

  return info
}

function extractSshInfoFromOpenSshConfig(text: string): Partial<ThunderSshInfo> {
  const info: Partial<ThunderSshInfo> = {}

  const hostMatch = text.match(/^hostname\s+(.+)$/im)
  if (hostMatch) {
    info.host = hostMatch[1].trim()
  }

  const portMatch = text.match(/^port\s+(\d+)$/im)
  if (portMatch) {
    info.port = parseInt(portMatch[1], 10)
  }

  const keyMatch = text.match(/^identityfile\s+(.+)$/im)
  if (keyMatch) {
    info.privateKeyPath = keyMatch[1].trim()
  }

  const userMatch = text.match(/^user\s+(.+)$/im)
  if (userMatch) {
    info.username = userMatch[1].trim()
  }

  return info
}

function isResolvedOpenSshConfig(alias: string, info: Partial<ThunderSshInfo>): boolean {
  return Boolean(
    info.host &&
      info.host !== alias &&
      info.privateKeyPath &&
      info.privateKeyPath.length > 0,
  )
}

async function stepGetSshInfo(
  ctx: AutomationContext,
  connectOutput = '',
): Promise<ThunderSshInfo> {
  ctx.emitter.updateStep('get-ssh-info', 'active', null)
  try {
    const parsedFromConnect = extractSshInfoFromText(connectOutput)
    const alias = `tnr-${ctx.instanceId}`

    let host = parsedFromConnect.host ?? ''
    let port = parsedFromConnect.port ?? 22
    let privateKeyPath = parsedFromConnect.privateKeyPath ?? ''
    let username = parsedFromConnect.username ?? 'ubuntu'

    ctx.emitter.log('get-ssh-info', `Resolving SSH alias ${alias} from OpenSSH config...`)

    const sshConfigDeadline = Date.now() + 15_000
    while (Date.now() < sshConfigDeadline) {
      try {
        const { stdout: sshConfig } = await execAsync(`ssh -G ${alias}`, {
          timeout: 15_000,
        })
        ctx.emitter.log('get-ssh-info', sshConfig)

        const parsedFromConfig = extractSshInfoFromOpenSshConfig(sshConfig)
        if (isResolvedOpenSshConfig(alias, parsedFromConfig)) {
          host = parsedFromConfig.host ?? host
          port = parsedFromConfig.port ?? port
          privateKeyPath = parsedFromConfig.privateKeyPath ?? privateKeyPath
          username = parsedFromConfig.username ?? username
          ctx.emitter.log('get-ssh-info', `Resolved SSH alias ${alias}.`)
          break
        }
      } catch (err) {
        ctx.emitter.log(
          'get-ssh-info',
          `ssh -G ${alias} did not resolve cleanly; retrying...`,
        )
        if (err instanceof Error) {
          ctx.emitter.log('get-ssh-info', `${err.message}\n`)
        }
      }
      await new Promise(r => setTimeout(r, 1_000))
    }

    if (!host || !privateKeyPath) {
      try {
        const { stdout } = await execAsync('tnr status --no-wait', { timeout: 15_000 })
        ctx.emitter.log('get-ssh-info', stdout)
        const parsedFromStatus = extractSshInfoFromText(stdout)
        host = parsedFromStatus.host ?? host
        port = parsedFromStatus.port ?? port
        privateKeyPath = parsedFromStatus.privateKeyPath ?? privateKeyPath
        username = parsedFromStatus.username ?? username
      } catch {
        // Non-fatal: we may already have enough info
      }
    }

    // Fallback: check common locations
    if (!privateKeyPath) {
      const candidates = [
        path.join(homedir(), '.tnr', 'id_rsa'),
        path.join(homedir(), '.tnr', 'ssh_key'),
        path.join(
          process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
          'tnr',
          'id_rsa',
        ),
        path.join(
          process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
          'tnr',
          'ssh_key',
        ),
      ]
      for (const candidate of candidates) {
        try {
          await readFile(candidate)
          privateKeyPath = candidate
          break
        } catch {
          // Try next
        }
      }
    }

    if (!host) {
      throw new Error(
        `Could not determine SSH host for ${alias}. Re-run connect and check ~/.ssh/config. Raw output logged above.`,
      )
    }
    if (!privateKeyPath) {
      throw new Error(
        `Could not find SSH private key for ${alias}. Checked ~/.ssh/config, ~/.tnr/, and %APPDATA%/tnr/.`,
      )
    }

    const info: ThunderSshInfo = {
      host,
      port,
      username,
      privateKeyPath,
    }
    ctx.emitter.updateStep('get-ssh-info', 'done', null)
    return info
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('get-ssh-info', 'error', msg)
    throw err
  }
}

async function stepDetectSnapshotRuntime(
  client: SshClient,
  ctx: AutomationContext,
): Promise<SnapshotRuntimeProbe> {
  const probe = await sshExec(
    client,
    buildSnapshotRuntimeProbeCommand(),
    ctx.emitter,
    'system-prep',
    180_000,
    120_000,
  )
  const status = parseSnapshotRuntimeProbe(probe)
  if (status.ready) {
    const marker = status.snapshotMarker ?? 'unlabeled snapshot'
    ctx.emitter.log(
      'system-prep',
      `Snapshot runtime verified (${marker}; ${status.gpuSummary}; vLLM ${status.vllmVersion}).`,
    )
  } else {
    ctx.emitter.log(
      'system-prep',
      `Snapshot runtime incomplete. Missing: ${status.missing.join(', ')}. Falling back to legacy bootstrap.`,
    )
  }
  return status
}

async function stepSystemPrep(
  client: SshClient,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('system-prep', 'active', null)
  try {
    await sshExec(
      client,
      buildLegacyRuntimePrepCommand(),
      ctx.emitter,
      'system-prep',
      2_700_000,
      300_000,
    )
    ctx.emitter.log('system-prep', 'Legacy runtime preparation complete.')
    ctx.emitter.updateStep('system-prep', 'done', null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('system-prep', 'error', msg)
    throw err
  }
}

async function stepStartVllm(
  client: SshClient,
  ctx: AutomationContext,
): Promise<string> {
  ctx.emitter.updateStep('start-vllm', 'active', null)
  try {
    const venvCheck = await sshExec(
      client,
      '[ -f "$HOME/vllm-env/bin/activate" ] && echo "VLLM_ENV_READY" || echo "VLLM_ENV_MISSING"',
      ctx.emitter,
      'start-vllm',
      10_000,
    )
    if (!venvCheck.includes('VLLM_ENV_READY')) {
      throw new Error(
        'vllm-env is missing on the remote instance. The snapshot is incomplete or the fallback runtime prep did not finish.',
      )
    }
    ctx.emitter.log('start-vllm', 'Pinned vllm-env detected.')

    // ---- Pre-flight: confirm enough free GPU memory ----------------------
    // GPT-OSS-120B (MXFP4) needs ~63 GB for weights. vLLM then allocates KV
    // cache blocks from the same pool. With --gpu-memory-utilization 0.85
    // (~69.6 GB ceiling) we still need roughly 70 000 MiB free before launch.
    // If another process is consuming VRAM (e.g. a zombie vLLM from a
    // previous failed run), we fail immediately with a clear message.
    const memCheck = await sshExec(
      client,
      [
        'FREE_MIB=$(nvidia-smi --query-gpu=memory.free --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d \' \')',
        'echo "GPU_MEM_FREE=${FREE_MIB}MiB"',
        'if [ -z "$FREE_MIB" ] || [ "$FREE_MIB" -lt 70000 ]; then',
        '  echo "GPU_MEM_INSUFFICIENT: ${FREE_MIB}MiB free — need at least 70000MiB"',
        '  exit 1',
        'fi',
      ].join('\n'),
      ctx.emitter,
      'start-vllm',
      15_000,
    )
    ctx.emitter.log('start-vllm', memCheck.trim())

    // ---- Kill any zombie vLLM/uvicorn from previous attempts -------------
    // Best-effort — ignore errors if nothing is running.
    await sshExec(
      client,
      'pkill -f "vllm.entrypoints" 2>/dev/null || true; pkill -f "gptoss" 2>/dev/null || true; sleep 2',
      ctx.emitter,
      'start-vllm',
      15_000,
    ).catch(() => { /* intentionally swallow */ })

    // ---- Launch vLLM (OOM-safe parameters) ------------------------------
    //
    //  --gpu-memory-utilization 0.85  → ~69.6 GB ceiling; leaves more headroom
    //                                   for the weights + CUDA context.
    //  --max-model-len 2048           → smaller KV pool = fewer OOM kills.
    //  --max-num-seqs 2               → minimal concurrency, reduces KV pressure.
    //  --block-size 16                → smaller paged-attention blocks reduce
    //                                   wasted VRAM at the pool boundary.
    //  --enforce-eager                → skip CUDA graph capture; faster start,
    //                                   no additional per-graph VRAM overhead.
    //  --dtype auto                   → honour MXFP4 quantization in model config.
    //  --disable-log-requests         → reduces log noise during model loading.
    //  --generation-config vllm       → use vLLM's own generation defaults
    //                                   rather than the model's (avoids HF hub
    //                                   fetch errors for custom configs).
    const output = await sshExec(
      client,
      buildVllmLaunchCommand(),
      ctx.emitter,
      'start-vllm',
      30_000,
    )
    const pidMatch = output.match(/VLLM_PID=(\d+)/)
    const pid = pidMatch ? pidMatch[1] : 'unknown'
    ctx.emitter.log('start-vllm', `vLLM started with PID ${pid}`)
    ctx.emitter.updateStep('start-vllm', 'done', null)
    return pid
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('start-vllm', 'error', msg)
    throw err
  }
}

async function stepPollVllm(
  client: SshClient,
  ctx: AutomationContext,
  launchMode: 'snapshot' | 'legacy',
): Promise<void> {
  ctx.emitter.updateStep('poll-vllm', 'active', null)
  const TIMEOUT_MS =
    launchMode === 'snapshot'
      ? 20 * 60 * 1000
      : 35 * 60 * 1000 // 35 minutes — generous for model weight download
  const POLL_INTERVAL = 15_000
  const startTime = Date.now()
  let lastLogTail = ''
  let lastProgressSummary = ''
  let lastHeartbeatAt = 0

  // Shard stall detection: if the shard number doesn't advance for
  // SHARD_STALL_MS we check whether the vLLM process is still alive.
  let lastShardSeen = -1
  let lastShardAdvanceAt = Date.now()
  const SHARD_STALL_MS = 10 * 60 * 1000 // 10 minutes

  // Widen fatal-pattern detection to catch kernel OOM killer and low-level
  // faults that may not produce a Python traceback.
  function detectFatalPattern(lower: string): string | null {
    if (lower.includes('unknown quantization method: mxfp4')) {
      return 'The installed vLLM build is too old for GPT-OSS MXFP4 weights. The snapshot or fallback runtime must use a modern GPT-OSS-capable vLLM release with MXFP4 support.'
    }
    if (
      lower.includes("model architectures ['gptossforcausallm'] are not supported") ||
      lower.includes('model architectures [\'gptossforcausallm\'] are not supported')
    ) {
      return 'The installed vLLM build does not include native GPT-OSS model support. The snapshot or fallback runtime must use a modern GPT-OSS-capable vLLM release.'
    }
    if (lower.includes('cuda out of memory') || lower.includes('out of memory: kill')) {
      return 'vLLM ran out of GPU memory. The KV cache allocation exceeded the GPU ceiling.\n' +
        'Current flags: --gpu-memory-utilization 0.85 --max-model-len 2048. ' +
        'If this still OOMs, try reducing --gpu-memory-utilization to 0.80 or --max-model-len to 1536.'
    }
    if (lower.includes('oom_kill_process') || lower.includes('oom-kill event')) {
      return 'Linux kernel OOM killer terminated vLLM. Check dmesg for details.'
    }
    if (lower.includes('segmentation fault') || lower.includes('segfault')) {
      return 'vLLM process received SIGSEGV (segmentation fault). Usually indicates a CUDA driver / vLLM version mismatch.'
    }
    if (lower.includes('illegal instruction')) {
      return 'vLLM process received SIGILL (illegal instruction). This instance may not support the AVX-512 extensions required by the installed torch build.'
    }
    if (lower.includes('bus error')) {
      return 'vLLM process received SIGBUS. Likely a memory-mapped file corruption — restart the instance.'
    }
    if (lower.includes('cannot allocate memory') || lower.includes('malloc failed')) {
      return 'vLLM could not allocate system (CPU) memory. The instance may be out of RAM as well as VRAM.'
    }
    if (lower.includes('libcuda.so cannot found') || lower.includes('assertionerror: libcuda')) {
      return null // handled separately below with ldconfig recovery
    }
    if (lower.includes('engine core initialization failed') || lower.includes('failed core proc')) {
      return null // handled separately below with root-cause extraction
    }
    if (lower.includes('traceback') && lower.includes('error')) {
      return null // handled separately below
    }
    return null
  }

  try {
    while (Date.now() - startTime < TIMEOUT_MS) {
      if (ctx.abortSignal.aborted) {
        throw new Error('Automation aborted by user')
      }

      let emittedUpdateThisPoll = false

      // ---- Check vLLM readiness via HTTP --------------------------------
      try {
        const result = await sshExec(
          client,
          'curl -sf http://127.0.0.1:8000/v1/models',
          ctx.emitter,
          'poll-vllm',
          10_000,
        )
        if (result.includes('model')) {
          ctx.emitter.log('poll-vllm', 'VLLM_READY')
          ctx.emitter.updateStep('poll-vllm', 'done', null)
          return
        }
      } catch {
        // Not ready yet — check logs for fatal errors below
      }

      // ---- Tail the log for progress + error info -----------------------
      try {
        const logTail = await sshExec(
          client,
          'tail -n 60 ~/gptoss-120b.log 2>/dev/null || echo "(no log yet)"',
          ctx.emitter,
          'poll-vllm',
          5_000,
        )

        const lower = logTail.toLowerCase()
        const { summary: progressSummary, shardNum } = extractLatestVllmProgress(logTail)

        // Track shard advancement for stall detection
        if (shardNum > lastShardSeen) {
          lastShardSeen = shardNum
          lastShardAdvanceAt = Date.now()
        }

        if (progressSummary && progressSummary !== lastProgressSummary) {
          lastProgressSummary = progressSummary
          ctx.emitter.log('poll-vllm', `VLLM_PROGRESS: ${progressSummary}`)
          emittedUpdateThisPoll = true
        }

        // ---- Fatal pattern checks (widened set) ---
        const wideError = detectFatalPattern(lower)
        if (wideError) {
          throw new Error(`${wideError}\n\nLast log:\n${logTail}\n\nCheck ~/gptoss-120b.log for the full traceback.`)
        }

        // libcuda linker failure — attempt ldconfig recovery
        if (lower.includes('libcuda.so cannot found') || lower.includes('assertionerror: libcuda')) {
          try {
            await sshExec(
              client,
              'sudo ldconfig && export LD_LIBRARY_PATH=/usr/local/cuda/lib64:/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}',
              ctx.emitter,
              'poll-vllm',
              10_000,
            )
            ctx.emitter.log('poll-vllm', 'Ran sudo ldconfig to refresh linker cache — please retry the automation.')
          } catch {
            // Best effort
          }
          throw new Error(
            'vLLM/Triton could not find libcuda.so. Ran "sudo ldconfig" as a recovery attempt. ' +
            'Please retry the automation. If the error persists, verify the NVIDIA driver is installed ' +
            'and /usr/local/cuda/lib64 is on LD_LIBRARY_PATH.',
          )
        }

        // Engine core init failure — extract root cause
        if (lower.includes('engine core initialization failed') || lower.includes('failed core proc')) {
          let rootCause = logTail
          try {
            rootCause = await sshExec(
              client,
              'grep -i -E "(error|exception|killed|oom|memory|signal)" ~/gptoss-120b.log | tail -n 15',
              ctx.emitter,
              'poll-vllm',
              5_000,
            )
          } catch { /* best effort */ }
          throw new Error(
            `vLLM engine failed to initialize. Root cause:\n${rootCause || logTail}\n\nFull log: ~/gptoss-120b.log`,
          )
        }

        // Generic Python traceback
        if (lower.includes('traceback') && lower.includes('error')) {
          throw new Error(`vLLM crashed during startup. Last log output:\n${logTail}`)
        }

        // ---- Shard stall detection ----------------------------------------
        // If a shard number was seen but hasn't advanced in SHARD_STALL_MS,
        // the downloader/loader is stuck. Check if the process is still alive.
        if (
          lastShardSeen >= 0 &&
          Date.now() - lastShardAdvanceAt > SHARD_STALL_MS
        ) {
          ctx.emitter.log('poll-vllm', `SHARD_STALL_DETECTED: shard ${lastShardSeen} has not advanced in ${SHARD_STALL_MS / 60_000} minutes — investigating...`)
          try {
            const alive = await sshExec(
              client,
              'pgrep -a -f "vllm.entrypoints" 2>/dev/null || echo "VLLM_PROCESS_DEAD"',
              ctx.emitter,
              'poll-vllm',
              5_000,
            )
            if (alive.includes('VLLM_PROCESS_DEAD')) {
              // Process is gone — check dmesg for OOM kill
              let dmesg = ''
              try {
                dmesg = await sshExec(
                  client,
                  'sudo dmesg 2>/dev/null | grep -i -E "(oom|kill|memory)" | tail -n 15 || echo "(dmesg unavailable)"',
                  ctx.emitter,
                  'poll-vllm',
                  10_000,
                )
              } catch { /* best effort */ }
              throw new Error(
                `vLLM process died silently at shard ${lastShardSeen} — almost certainly an OOM kill.\n` +
                `dmesg (last 15 memory/kill lines):\n${dmesg}\n` +
                `Full log: cat ~/gptoss-120b.log\n` +
                `Recovery: the launcher now defaults to --gpu-memory-utilization 0.85 and --max-model-len 2048. If this still OOMs, reduce to 0.80 / 1536 and retry.`,
              )
            }
            // Process alive but stalled — emit diagnostic and reset stall timer
            // so we don't loop-throw on every poll cycle
            ctx.emitter.log('poll-vllm', `vLLM process is alive (${alive.trim()}) but shard loading appears stalled. Will continue polling.`)
            lastShardAdvanceAt = Date.now() // reset so next check is 10 min out
          } catch (err) {
            if (err instanceof Error && (err.message.includes('OOM kill') || err.message.includes('silently'))) {
              throw err // propagate OOM-kill error up
            }
            // SSH errors during stall check — non-fatal, keep polling
          }
        }

        if (logTail !== lastLogTail) {
          lastLogTail = logTail
          ctx.emitter.log('poll-vllm', logTail)
          emittedUpdateThisPoll = true
        } else if (Date.now() - lastHeartbeatAt > 60_000) {
          lastHeartbeatAt = Date.now()
          ctx.emitter.log(
            'poll-vllm',
            progressSummary
              ? `VLLM_POLL: still loading... (${progressSummary})`
              : 'VLLM_POLL: still loading... (no new log output)',
          )
          emittedUpdateThisPoll = true
        }
      } catch (err) {
        if (
          err instanceof Error &&
          !err.message.includes('SSH command timed out') &&
          !err.message.includes('stalled')
        ) {
          throw err
        }
      }

      if (!emittedUpdateThisPoll && Date.now() - lastHeartbeatAt > 60_000) {
        lastHeartbeatAt = Date.now()
        ctx.emitter.log(
          'poll-vllm',
          lastProgressSummary
            ? `VLLM_POLL: still loading... (${lastProgressSummary})`
            : 'VLLM_POLL: still loading...',
        )
      }
      await new Promise(r => setTimeout(r, POLL_INTERVAL))
    }

    // Timeout — pull the last log tail for context
    let finalLog = ''
    try {
      finalLog = await sshExec(client, 'tail -n 30 ~/gptoss-120b.log 2>/dev/null', ctx.emitter, 'poll-vllm', 5_000)
    } catch { /* best effort */ }
    throw new Error(
      `vLLM has not become ready after ${TIMEOUT_MS / 60_000} minutes.\n` +
      `Last progress: ${lastProgressSummary || '(no shard progress detected)'}\n` +
      `Last log:\n${finalLog || '(empty)'}\n` +
      `Check ~/gptoss-120b.log for download/initialization progress. ` +
      (launchMode === 'snapshot'
        ? `If the snapshot was healthy, this usually means the local vLLM environment or cached weights are incomplete.`
        : `If the model weights are still downloading (~63 GB), extend the timeout and retry.`),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('poll-vllm', 'error', msg)
    throw err
  }
}

async function stepPullBridge(
  client: SshClient,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('pull-bridge', 'active', null)
  let stagingDir: string | null = null
  let sftp: SFTPWrapper | null = null

  try {
    const payload = await loadLocalBridgePayload()
    const remoteHome = (
      await sshExec(
        client,
        'printf "%s" "$HOME"',
        ctx.emitter,
        'pull-bridge',
        10_000,
      )
    ).trim()
    if (!remoteHome) {
      throw new Error('Could not resolve the remote home directory for bridge provisioning.')
    }

    const remoteRepoRoot = path.posix.join(remoteHome, REMOTE_REPO_ROOT_DIRNAME)
    const remoteBridgeDir = path.posix.join(remoteRepoRoot, 'server', 'remote_glm_bridge')
    ctx.emitter.log(
      'pull-bridge',
      `Provisioning bridge runtime from the local workspace to ${remoteBridgeDir}.`,
    )

    stagingDir = (
      await sshExec(
        client,
        'mktemp -d "$HOME/.jarvis-bridge-upload.XXXXXX"',
        ctx.emitter,
        'pull-bridge',
        10_000,
      )
    ).trim()
    if (!stagingDir) {
      throw new Error('Could not create a remote staging directory for bridge provisioning.')
    }

    await sshExec(
      client,
      `mkdir -p ${shellQuote(path.posix.join(stagingDir, 'server', 'remote_glm_bridge'))}`,
      ctx.emitter,
      'pull-bridge',
      10_000,
    )

    sftp = await openSftp(client)
    for (const file of payload) {
      if (ctx.abortSignal.aborted) {
        throw new Error('Automation aborted by user')
      }
      const remotePath = path.posix.join(stagingDir, file.relativePath)
      await sftpWriteFile(sftp, remotePath, file.content)
    }

    await sshExec(
      client,
      buildBridgeProvisionPromoteCommand(stagingDir, remoteRepoRoot),
      ctx.emitter,
      'pull-bridge',
      30_000,
    )
    ctx.emitter.log(
      'pull-bridge',
      `Bridge runtime provisioned successfully (${payload.length} files uploaded).`,
    )
    ctx.emitter.updateStep('pull-bridge', 'done', null)
  } catch (err) {
    if (stagingDir) {
      await sshExec(
        client,
        `rm -rf ${shellQuote(stagingDir)}`,
        ctx.emitter,
        'pull-bridge',
        10_000,
      ).catch(() => {
        // Best effort cleanup if provisioning fails mid-upload.
      })
    }
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('pull-bridge', 'error', msg)
    throw err
  } finally {
    sftp?.end()
  }
}

async function stepStartBridge(
  client: SshClient,
  ctx: AutomationContext,
): Promise<string> {
  ctx.emitter.updateStep('start-bridge', 'active', null)
  try {
    const output = await sshExec(
      client,
      buildBridgeLaunchCommand(ctx.bridgeApiKey),
      ctx.emitter,
      'start-bridge',
      30_000,
    )
    const pidMatch = output.match(/BRIDGE_PID=(\d+)/)
    const pid = pidMatch ? pidMatch[1] : 'unknown'
    ctx.emitter.log('start-bridge', `Bridge started with PID ${pid}`)
    ctx.emitter.updateStep('start-bridge', 'done', null)
    return pid
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : String(err)
    const msg = rawMsg.includes('REMOTE_REPO_ROOT_MISSING')
      ? 'Bridge runtime is missing on the remote instance after provisioning. Re-run the "Provision bridge runtime" step and verify ~/.jarvis-remote-repo-root points at ~/claude-code-src-leaked.'
      : rawMsg
    ctx.emitter.updateStep('start-bridge', 'error', msg)
    throw new Error(msg)
  }
}

async function stepPollBridge(
  client: SshClient,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('poll-bridge', 'active', null)
  const TIMEOUT_MS = 3 * 60 * 1000 // 3 minutes
  const startTime = Date.now()
  let lastHealth: BridgeHealthProbe | null = null
  let lastHealthRaw = ''

  try {
    while (Date.now() - startTime < TIMEOUT_MS) {
      if (ctx.abortSignal.aborted) {
        throw new Error('Automation aborted by user')
      }

      try {
        const healthRaw = await sshExec(
          client,
          `curl -sS -H "X-Api-Key: ${ctx.bridgeApiKey}" http://127.0.0.1:8787/healthz`,
          ctx.emitter,
          'poll-bridge',
          10_000,
        )
        const health = parseBridgeHealthProbe(healthRaw)
        lastHealthRaw = healthRaw.trim()
        if (health?.ready) {
          ctx.emitter.log('poll-bridge', 'BRIDGE_READY')
          ctx.emitter.updateStep('poll-bridge', 'done', null)
          return
        }
        if (health) {
          lastHealth = health
          ctx.emitter.log(
            'poll-bridge',
            `BRIDGE_POLL: not ready yet (${formatBridgeHealthProbeSummary(health)})`,
          )
        } else {
          ctx.emitter.log('poll-bridge', 'BRIDGE_POLL: waiting...')
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        ctx.emitter.log(
          'poll-bridge',
          `BRIDGE_POLL: waiting... (${message.split('\n')[0]})`,
        )
      }

      await new Promise(r => setTimeout(r, 5_000))
    }

    let bridgeLogTail = ''
    let vllmLogTail = ''
    try {
      bridgeLogTail = await sshExec(
        client,
        'tail -n 40 ~/jarvis-bridge.log 2>/dev/null || echo "(no bridge log)"',
        ctx.emitter,
        'poll-bridge',
        10_000,
      )
    } catch {
      // Best effort.
    }
    try {
      vllmLogTail = await sshExec(
        client,
        'tail -n 20 ~/gptoss-120b.log 2>/dev/null || echo "(no vllm log)"',
        ctx.emitter,
        'poll-bridge',
        10_000,
      )
    } catch {
      // Best effort.
    }

    throw new Error(
      [
        'Bridge process did not become ready.',
        lastHealth
          ? `Last healthz response: ${formatBridgeHealthProbeSummary(lastHealth)}`
          : `Last healthz response: ${lastHealthRaw || '(no response)'}`,
        `Bridge log tail:\n${bridgeLogTail || '(unavailable)'}`,
        `vLLM log tail:\n${vllmLogTail || '(unavailable)'}`,
      ].join('\n\n'),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('poll-bridge', 'error', msg)
    throw err
  }
}

async function stepVerifyPorts(
  client: SshClient,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('verify-ports', 'active', null)
  try {
    const output = await sshExec(
      client,
      "ss -ltnp | grep -E ':(8000|8787)\\b'",
      ctx.emitter,
      'verify-ports',
      10_000,
    )
    const has8000 = output.includes(':8000')
    const has8787 = output.includes(':8787')

    if (!has8000) {
      const logTail = await sshExec(
        client,
        'tail -n 10 ~/gptoss-120b.log 2>/dev/null || echo "(no log)"',
        ctx.emitter,
        'verify-ports',
        5_000,
      )
      throw new Error(`Port 8000 (vLLM) not listening.\n${logTail}`)
    }
    if (!has8787) {
      const logTail = await sshExec(
        client,
        'tail -n 10 ~/jarvis-bridge.log 2>/dev/null || echo "(no log)"',
        ctx.emitter,
        'verify-ports',
        5_000,
      )
      throw new Error(`Port 8787 (bridge) not listening.\n${logTail}`)
    }

    ctx.emitter.updateStep('verify-ports', 'done', null)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('verify-ports', 'error', msg)
    throw err
  }
}

async function stepForwardPort(ctx: AutomationContext): Promise<string> {
  ctx.emitter.updateStep('forward-port', 'active', null)
  try {
    // Forward port 8787
    let forwardOutput = ''
    try {
      const result = await execAsync(`tnr ports forward ${ctx.instanceId} --add 8787`, {
        timeout: 30_000,
      })
      forwardOutput = `${result.stdout}\n${result.stderr}`.trim()
      if (forwardOutput) {
        ctx.emitter.log('forward-port', forwardOutput)
      }
    } catch (err) {
      forwardOutput = err instanceof Error ? err.message : String(err)
      ctx.emitter.log(
        'forward-port',
        `Port forward request returned an error; will still poll the port list. ${forwardOutput.split('\n')[0]}`,
      )
    }

    const directUrl = resolveThunderPublicUrl(forwardOutput, 8787)
    if (directUrl) {
      ctx.emitter.log('forward-port', `Public URL: ${directUrl}`)
      ctx.emitter.updateStep('forward-port', 'done', null)
      return directUrl
    }

    ctx.emitter.log('forward-port', 'Port forward requested. Polling for public URL...')

    // Poll for port to appear in listing
    const TIMEOUT = 60_000
    const start = Date.now()
    let lastPortsList = ''
    while (Date.now() - start < TIMEOUT) {
      if (ctx.abortSignal.aborted) {
        throw new Error('Automation aborted by user')
      }

      const { stdout, stderr } = await execAsync('tnr ports list', { timeout: 10_000 })
      const portsOutput = `${stdout}\n${stderr}`.trim()
      lastPortsList = portsOutput
      ctx.emitter.log('forward-port', portsOutput)

      const publicUrl = resolveThunderPublicUrl(portsOutput, 8787)
      if (publicUrl) {
        ctx.emitter.log('forward-port', `Public URL: ${publicUrl}`)
        ctx.emitter.updateStep('forward-port', 'done', null)
        return publicUrl
      }

      await new Promise(r => setTimeout(r, 3_000))
    }

    throw new Error(
      [
        'Port forwarding timed out. Port 8787 did not appear in tnr ports list.',
        forwardOutput ? `Forward command output:\n${forwardOutput}` : null,
        lastPortsList ? `Last tnr ports list output:\n${lastPortsList}` : null,
      ]
        .filter((chunk): chunk is string => Boolean(chunk))
        .join('\n\n'),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('forward-port', 'error', msg)
    throw err
  }
}

async function stepHealthCheck(
  publicUrl: string,
  ctx: AutomationContext,
): Promise<void> {
  ctx.emitter.updateStep('health-check', 'active', null)
  const TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes — Thunder DNS propagation can take 1-3 min
  const POLL_MS = 5_000
  const start = Date.now()
  let lastLogAt = 0

  ctx.emitter.log('health-check', `Polling ${buildThunderHealthCheckUrl(publicUrl)} (up to 10 min)…`)

  try {
    while (Date.now() - start < TIMEOUT_MS) {
      if (ctx.abortSignal.aborted) {
        throw new Error('Automation aborted by user')
      }

      try {
        const response = await fetch(buildThunderHealthCheckUrl(publicUrl), {
          headers: { 'X-Api-Key': ctx.bridgeApiKey },
          signal: AbortSignal.timeout(10_000),
        })
        if (response.ok) {
          const body = await response.text().catch(() => '')
          const probe = parseBridgeHealthProbe(body)
          const summary = probe ? formatBridgeHealthProbeSummary(probe) : body.slice(0, 80)
          ctx.emitter.log('health-check', `Public URL live — ${summary}`)
          ctx.emitter.updateStep('health-check', 'done', null)
          return
        }
        // Got a response but not ok (e.g. 503 bridge not ready yet)
        const elapsed = Math.round((Date.now() - start) / 1000)
        if (Date.now() - lastLogAt > 20_000) {
          ctx.emitter.log('health-check', `+${elapsed}s: bridge reached but not ready (${response.status}) — waiting…`)
          lastLogAt = Date.now()
        }
      } catch {
        const elapsed = Math.round((Date.now() - start) / 1000)
        if (Date.now() - lastLogAt > 20_000) {
          ctx.emitter.log('health-check', `+${elapsed}s: URL not yet routable — DNS propagating…`)
          lastLogAt = Date.now()
        }
      }

      await new Promise(r => setTimeout(r, POLL_MS))
    }

    throw new Error(
      'Bridge is running and ports are forwarded, but the public URL did not respond within 10 minutes. ' +
      'Thunder DNS propagation may be slow. Wait 60 seconds and retry the health check.',
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ctx.emitter.updateStep('health-check', 'error', msg)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export type AutomationResult = {
  publicUrl: string
  instanceId: string
}

/**
 * Run the full Phase 2 automation sequence.
 * Throws on any step failure with the step already marked as error.
 */
export async function runAutomation(
  instanceId: string,
  bridgeApiKey: string,
  mainWindow: BrowserWindow,
  emitter: StepEmitter,
  abortSignal: AbortSignal,
): Promise<AutomationResult> {
  const ctx: AutomationContext = {
    instanceId,
    bridgeApiKey,
    emitter,
    mainWindow,
    abortSignal,
  }

  // Step 1: Connect
  const connectOutput = await stepConnectInstance(ctx)

  // Step 2: SSH info
  const sshInfo = await stepGetSshInfo(ctx, connectOutput)

  // Read private key
  const privateKey = await readFile(sshInfo.privateKeyPath)

  // Establish SSH connection (retries up to 6× on transient failures)
  const client = await connectSsh(sshInfo, privateKey, emitter)
  try {
    const snapshotRuntime = await stepDetectSnapshotRuntime(client, ctx)
    await stepPullBridge(client, ctx)
    if (!snapshotRuntime.ready) {
      // Step 3A: Provision bridge runtime before legacy bootstrap so system-prep
      // can install and validate the uploaded bridge requirements.
      // Step 3B: Legacy bootstrap fallback
      await stepSystemPrep(client, ctx)
    } else {
      ctx.emitter.updateStep(
        'system-prep',
        'skipped',
        'Snapshot runtime already includes the pinned vLLM environment, so only the bridge runtime was refreshed.',
      )
    }

    // Step 3C: Start vLLM
    await stepStartVllm(client, ctx)

    // Step 3D: Poll vLLM readiness
    await stepPollVllm(client, ctx, snapshotRuntime.ready ? 'snapshot' : 'legacy')

    // Step 3E: Start bridge
    await stepStartBridge(client, ctx)

    // Step 3F: Poll bridge readiness
    await stepPollBridge(client, ctx)

    // Step 3F-ii: Model proxy smoke test — confirm bridge can actually reach vLLM.
    // The health check (/healthz) passes even if GPT_OSS_BASE_URL is wrong;
    // this probe exercises the full request path before we forward the port.
    ctx.emitter.log('poll-bridge', 'Running model proxy smoke test...')
    try {
      const smokeResult = await sshExec(
        client,
        `curl -sf -H 'X-Api-Key: ${ctx.bridgeApiKey}' http://127.0.0.1:8787/v1/models`,
        ctx.emitter,
        'poll-bridge',
        15_000,
      )
      if (!smokeResult.includes('model')) {
        throw new Error(
          `Bridge returned an unexpected response from /v1/models. ` +
          `The vLLM backend may not be reachable via GPT_OSS_BASE_URL.\nResponse: ${smokeResult.slice(0, 300)}`,
        )
      }
      ctx.emitter.log('poll-bridge', 'Bridge model proxy smoke test PASSED.')
    } catch (smokeErr) {
      const smokeMsg = smokeErr instanceof Error ? smokeErr.message : String(smokeErr)
      throw new Error(
        `Bridge is running but the model proxy is broken.\n${smokeMsg}\n` +
        `Check ~/jarvis-bridge.log and verify GPT_OSS_BASE_URL=http://127.0.0.1:8000/v1`,
      )
    }

    // Step 3G: Verify ports
    await stepVerifyPorts(client, ctx)
  } finally {
    client.end()
  }

  // Step 4: Port forwarding (back on Windows)
  const publicUrl = await stepForwardPort(ctx)

  // Step 5: End-to-end health check
  await stepHealthCheck(publicUrl, ctx)

  // Step 6 is handled by the caller (save config)
  ctx.emitter.updateStep('save-config', 'active', null)

  return { publicUrl, instanceId }
}

// ---------------------------------------------------------------------------
// V2: Snapshot-driven 5-step automation (no SSH orchestration)
// ---------------------------------------------------------------------------

const V2_SNAPSHOT_NAME = 'jarvis-snap-v2'
const V2_CREATE_TIMEOUT_MS = 8 * 60 * 1000
const V2_WAIT_RUNNING_TIMEOUT_MS = 4 * 60 * 1000
const V2_HEALTHZ_TIMEOUT_MS = 90 * 60 * 1000
const V2_HEALTHZ_POLL_MS = 3_000
const V2_LOG_INTERVAL_MS = 60_000

type TnrInstanceJson = {
  id: string
  uuid: string
  ip: string
  port: number
  status: string
}

/**
 * Resolve SSH connection details for a Thunder instance from tnr status --json.
 * Returns null if the instance is not found or the command fails.
 */
async function resolveTnrInstanceSsh(
  instanceId: string,
  tnrPath = 'tnr',
): Promise<{ uuid: string; ip: string; port: number } | null> {
  try {
    const { stdout } = await runDeterministicCommand(tnrPath, ['status', '--no-wait', '--json'], {
      timeout: 15_000,
    })
    const jsonStart = stdout.indexOf('[')
    const instances: TnrInstanceJson[] = jsonStart >= 0 ? JSON.parse(stdout.slice(jsonStart)) : []
    const inst = instances.find(i => i.id === instanceId)
    if (inst && inst.uuid && inst.ip && inst.port) {
      return { uuid: inst.uuid, ip: inst.ip, port: inst.port }
    }
  } catch {
    // ignore
  }
  return null
}

/**
 * Build the direct SSH command arguments for a Thunder instance.
 * Uses forward slashes in key path (required by OpenSSH on Windows).
 */
function buildDirectSshTarget(
  instanceId: string,
  ssh: { uuid: string; ip: string; port: number },
  commands: ResolvedInjectionCommandPaths,
): DirectSshTarget {
  return {
    instanceId,
    uuid: ssh.uuid,
    ip: ssh.ip,
    port: ssh.port,
    username: 'ubuntu',
    keyPath: path.join(homedir(), '.thunder', 'keys', ssh.uuid).replace(/\\/g, '/'),
    tnrPath: commands.tnrPath,
    sshPath: commands.sshPath,
  }
}

function buildDirectSshArgs(target: DirectSshTarget, remoteCommand?: string): string[] {
  const args = [
    '-i',
    target.keyPath,
    '-p',
    String(target.port),
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    `${target.username}@${target.ip}`,
  ]
  if (remoteCommand) {
    args.push(remoteCommand)
  }
  return args
}

async function primeThunderSshAccess(
  target: DirectSshTarget,
  emitter: StepEmitter,
  stepId: ThunderStepId,
): Promise<void> {
  emitter.log(
    stepId,
    `[bridge-verify] WARN direct SSH failed; priming access with non-interactive tnr connect for instance ${target.instanceId}...`,
  )
  const result = await execFileNoThrowWithCwd(
    target.tnrPath,
    ['connect', target.instanceId],
    {
      cwd: process.cwd(),
      env: process.env,
      timeout: 20_000,
      stdin: 'pipe',
      input: 'exit\n',
    },
  )
  const keyReady = await pathExists(target.keyPath)
  emitter.log(
    stepId,
    formatBridgeVerificationResult({
      name: 'SSH prime',
      status: keyReady ? 'ok' : 'warn',
      detail: keyReady
        ? `key file ready at ${target.keyPath}`
        : `tnr connect exited without writing ${target.keyPath}; ${summarizeLogValue(result.stderr || result.error || result.stdout || '')}`,
    }),
  )
}

async function runDirectSshCommand(
  target: DirectSshTarget,
  remoteCommand: string,
  emitter: StepEmitter,
  stepId: ThunderStepId,
  timeout = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runDeterministicCommand(
      target.sshPath,
      buildDirectSshArgs(target, remoteCommand),
      { timeout },
    )
  } catch (firstErr) {
    await primeThunderSshAccess(target, emitter, stepId)
    try {
      return await runDeterministicCommand(
        target.sshPath,
        buildDirectSshArgs(target, remoteCommand),
        { timeout },
      )
    } catch (secondErr) {
      const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
      const secondMsg = secondErr instanceof Error ? secondErr.message : String(secondErr)
      throw new Error(
        [
          'The Windows Electron subprocess could not execute direct OpenSSH for Thunder bridge injection.',
          'Retried once after non-interactive `tnr connect` priming and it still failed.',
          `First attempt: ${summarizeLogValue(firstMsg, 240)}`,
          `Retry after priming: ${summarizeLogValue(secondMsg, 240)}`,
        ].join('\n'),
      )
    }
  }
}

function buildBridgeApplyCommand(): string {
  const copyBridgeFiles = REMOTE_BRIDGE_RUNTIME_RELATIVE_PATHS
    .map(rel => {
      const remoteName = path.basename(rel)
      const destDir = `/opt/jarvis-bridge/server/remote_glm_bridge`
      return `sudo cp /tmp/jarvis-bridge-upload-${remoteName} ${destDir}/${remoteName} 2>/dev/null || true`
    })
    .join(' && ')

  return [
    'sudo mv /tmp/jarvis-bridge-new.env /etc/jarvis-bridge.env 2>/dev/null || true',
    copyBridgeFiles,
    'sudo pkill -f "uvicorn server.remote_glm_bridge" 2>/dev/null || true',
  ].join(' && ')
}

function buildBridgeVerificationCommand(bridgeApiKey: string): string {
  return [
    'set -e',
    `CURRENT_BRIDGE_KEY=${shellQuote(bridgeApiKey)}`,
    'ENV_STATUS=missing',
    'if sudo test -f /etc/jarvis-bridge.env; then',
    '  if sudo grep -Fq "PLACEHOLDER_OVERWRITE_AT_LAUNCH" /etc/jarvis-bridge.env; then',
    '    ENV_STATUS=placeholder',
    '  elif sudo grep -Fq "GPT_OSS_BRIDGE_API_KEYS=$CURRENT_BRIDGE_KEY" /etc/jarvis-bridge.env; then',
    '    ENV_STATUS=launch-key',
    '  else',
    '    ENV_STATUS=unexpected-key',
    '  fi',
    'fi',
    'CODE_STATUS=missing',
    'if sudo test -f /opt/jarvis-bridge/server/remote_glm_bridge/glm_backend.py; then',
    `  if sudo grep -Fq ${shellQuote('delta.get("reasoning")')} /opt/jarvis-bridge/server/remote_glm_bridge/glm_backend.py; then`,
    '    CODE_STATUS=reasoning-fix-present',
    '  else',
    '    CODE_STATUS=reasoning-fix-missing',
    '  fi',
    'fi',
    'MODELS_STATUS=000',
    'MODELS_BODY=""',
    'MODELS_ERR=""',
    'for attempt in 1 2 3 4 5 6; do',
    '  body_file="$(mktemp)"',
    '  err_file="$(mktemp)"',
    '  MODELS_STATUS="$(curl -sS -H "X-Api-Key: $CURRENT_BRIDGE_KEY" http://127.0.0.1:8787/v1/models -o "$body_file" -w "%{http_code}" 2>"$err_file" || true)"',
    '  MODELS_BODY="$(tr "\\r\\n" "  " < "$body_file" | head -c 180)"',
    '  MODELS_ERR="$(tr "\\r\\n" "  " < "$err_file" | head -c 180)"',
    '  rm -f "$body_file" "$err_file"',
    '  if [ "$MODELS_STATUS" != "000" ]; then',
    '    break',
    '  fi',
    '  sleep 2',
    'done',
    'MODELS_CATEGORY=unexpected-status',
    'if [ "$MODELS_STATUS" = "200" ]; then',
    '  MODELS_CATEGORY=ok',
    'elif [ "$MODELS_STATUS" = "503" ]; then',
    '  MODELS_CATEGORY=upstream-not-ready',
    'elif [ "$MODELS_STATUS" = "401" ] || [ "$MODELS_STATUS" = "403" ]; then',
    '  MODELS_CATEGORY=auth-failed',
    'elif [ "$MODELS_STATUS" = "000" ]; then',
    '  MODELS_CATEGORY=bridge-unreachable',
    'fi',
    'printf "VERIFY_ENV=%s\\n" "$ENV_STATUS"',
    'printf "VERIFY_CODE=%s\\n" "$CODE_STATUS"',
    'printf "VERIFY_MODELS_STATUS=%s\\n" "$MODELS_STATUS"',
    'printf "VERIFY_MODELS_CATEGORY=%s\\n" "$MODELS_CATEGORY"',
    'printf "VERIFY_MODELS_BODY=%s\\n" "$MODELS_BODY"',
    'printf "VERIFY_MODELS_ERR=%s\\n" "$MODELS_ERR"',
  ].join('\n')
}

function parseRemoteBridgeVerification(stdout: string): RemoteBridgeVerification {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const equalsIndex = line.indexOf('=')
    if (equalsIndex <= 0) {
      continue
    }
    values.set(line.slice(0, equalsIndex), line.slice(equalsIndex + 1).trim())
  }

  const rawStatusCode = values.get('VERIFY_MODELS_STATUS') ?? ''
  const parsedStatusCode = rawStatusCode ? Number.parseInt(rawStatusCode, 10) : Number.NaN
  return {
    envStatus: (values.get('VERIFY_ENV') as RemoteBridgeVerification['envStatus']) ?? 'missing',
    codeStatus: (values.get('VERIFY_CODE') as RemoteBridgeVerification['codeStatus']) ?? 'missing',
    modelsStatusCode: Number.isFinite(parsedStatusCode) ? parsedStatusCode : null,
    modelsCategory:
      (values.get('VERIFY_MODELS_CATEGORY') as BridgeLocalModelsProbeCategory) ??
      classifyBridgeLocalModelsProbe(Number.isFinite(parsedStatusCode) ? parsedStatusCode : null),
    modelsBody: summarizeLogValue(values.get('VERIFY_MODELS_BODY') ?? ''),
    modelsError: summarizeLogValue(values.get('VERIFY_MODELS_ERR') ?? ''),
  }
}

function buildBridgeVerificationResults(
  verification: RemoteBridgeVerification,
): {
  results: BridgeVerificationResult[]
  fatalMessages: string[]
} {
  const results: BridgeVerificationResult[] = []
  const fatalMessages: string[] = []

  if (verification.envStatus === 'launch-key') {
    results.push({
      name: 'bridge env',
      status: 'ok',
      detail: 'remote env file contains the current launch key',
    })
  } else {
    const detail =
      verification.envStatus === 'placeholder'
        ? 'remote env file still contains PLACEHOLDER_OVERWRITE_AT_LAUNCH'
        : verification.envStatus === 'unexpected-key'
          ? 'remote env file does not contain the current launch key'
          : 'remote env file is missing'
    results.push({ name: 'bridge env', status: 'error', detail })
    fatalMessages.push(detail)
  }

  if (verification.codeStatus === 'reasoning-fix-present') {
    results.push({
      name: 'glm_backend.py',
      status: 'ok',
      detail: 'remote bridge contains the delta.get("reasoning") fix',
    })
  } else {
    const detail =
      verification.codeStatus === 'reasoning-fix-missing'
        ? 'remote glm_backend.py is missing the delta.get("reasoning") fix'
        : 'remote glm_backend.py is missing'
    results.push({ name: 'glm_backend.py', status: 'error', detail })
    fatalMessages.push(detail)
  }

  if (verification.modelsCategory === 'ok') {
    results.push({
      name: 'local /v1/models',
      status: 'ok',
      detail: `authenticated bridge probe succeeded (HTTP ${verification.modelsStatusCode ?? 200})`,
    })
  } else if (verification.modelsCategory === 'upstream-not-ready') {
    results.push({
      name: 'local /v1/models',
      status: 'warn',
      detail: `bridge auth succeeded but vLLM is still cold-loading (HTTP ${verification.modelsStatusCode ?? 503}; ${verification.modelsBody})`,
    })
  } else if (verification.modelsCategory === 'auth-failed') {
    const detail = `bridge rejected the launch API key (HTTP ${verification.modelsStatusCode ?? 401}; ${verification.modelsBody})`
    results.push({ name: 'local /v1/models', status: 'error', detail })
    fatalMessages.push(detail)
  } else if (verification.modelsCategory === 'bridge-unreachable') {
    const detail = `bridge did not respond to the local authenticated probe (${verification.modelsError})`
    results.push({ name: 'local /v1/models', status: 'error', detail })
    fatalMessages.push(detail)
  } else {
    const detail = `bridge returned an unexpected /v1/models response (HTTP ${verification.modelsStatusCode ?? 0}; ${verification.modelsBody || verification.modelsError})`
    results.push({ name: 'local /v1/models', status: 'error', detail })
    fatalMessages.push(detail)
  }

  return { results, fatalMessages }
}
/**
 * Upload the fixed bridge runtime files and per-launch API key to a Thunder instance,
 * then restart the bridge. This is a best-effort operation — failures are logged but
 * do not abort the automation.
 *
 * What it does:
 *  1. Writes the per-launch env file (with the correct API key + vLLM settings) to a
 *     local temp file and uploads it via `tnr scp`.
 *  2. Uploads the current local bridge Python files via `tnr scp` (one file at a time),
 *     so any local fixes are deployed to the instance.
 *  3. SSH-moves the env file to /etc/jarvis-bridge.env and copies the bridge files
 *     into /opt/jarvis-bridge/server/remote_glm_bridge/, then restarts uvicorn via
 *     `pkill -f uvicorn` so s6 auto-revives it with the new code + key.
 */
async function uploadBridgeAndInjectKey(
  instanceId: string,
  bridgeApiKey: string,
  emitter: StepEmitter,
  stepId: ThunderStepId = 'forward-port',
): Promise<void> {
  const commands = await resolveInjectionCommandPaths()
  emitter.log(stepId, `[bridge-verify] Using Thunder CLI: ${commands.tnrPath}`)
  emitter.log(stepId, `[bridge-verify] Using OpenSSH: ${commands.sshPath}`)

  const ssh = await resolveTnrInstanceSsh(instanceId, commands.tnrPath)
  if (!ssh) {
    emitter.log(stepId, `Warning: instance ${instanceId} not found in tnr status — skipping bridge upload.`)
    const msg = `Instance ${instanceId} was not found in tnr status while preparing bridge injection.`
    emitter.updateStep(stepId, 'error', msg)
    throw new Error(msg)
  }

  const target = buildDirectSshTarget(instanceId, ssh, commands)
  emitter.log(stepId, 'Uploading bridge code + API key to instance...')
  const uploadResults: BridgeVerificationResult[] = []

  // ── 1. Write and upload env file ─────────────────────────────────────────
  const tmpEnv = path.join(tmpdir(), `jarvis-bridge-${instanceId}.env`)
  try {
    const envContent = [
      `GPT_OSS_BRIDGE_API_KEYS=${bridgeApiKey}`,
      `GPT_OSS_BASE_URL=http://127.0.0.1:8000/v1`,
      `GPT_OSS_PRIMARY_MODEL=openai/gpt-oss-120b`,
      `GPT_OSS_FAST_BASE_URL=http://127.0.0.1:8000/v1`,
      `GPT_OSS_FAST_MODEL=openai/gpt-oss-120b`,
      `GPT_OSS_AUTO_MODEL_ALIAS=gpt-oss-auto`,
      `PYTHONPATH=/opt/jarvis-bridge`,
    ].join('\n')
    await writeFile(tmpEnv, envContent, 'utf8')
    await runDeterministicCommand(
      commands.tnrPath,
      ['scp', tmpEnv, `${instanceId}:/tmp/jarvis-bridge-new.env`],
      { timeout: 15_000 },
    )
    uploadResults.push({
      name: 'env upload',
      status: 'ok',
      detail: 'staged /tmp/jarvis-bridge-new.env via tnr scp',
    })
  } catch (err) {
    uploadResults.push({
      name: 'env upload',
      status: 'warn',
      detail: summarizeLogValue(err instanceof Error ? err.message : String(err), 220),
    })
  } finally {
    unlink(tmpEnv).catch(() => {})
  }

  // ── 2. Upload fixed bridge Python files ──────────────────────────────────
  let payloadRoot: string | null = null
  let bridgePayloadRootResolved = false
  try {
    payloadRoot = await resolveLocalBridgePayloadRoot()
    bridgePayloadRootResolved = true
  } catch {
    emitter.log(stepId, 'Warning: could not locate local bridge payload — skipping Python file upload.')
  }

  if (!bridgePayloadRootResolved && !payloadRoot) {
    uploadResults.push({
      name: 'bridge runtime upload',
      status: 'warn',
      detail: 'could not locate the local bridge payload root; reusing remote snapshot files',
    })
  }

  if (payloadRoot) {
    let uploadCount = 0
    const failedUploads: string[] = []
    for (const relativePath of REMOTE_BRIDGE_RUNTIME_RELATIVE_PATHS) {
      const localPath = path.join(payloadRoot, relativePath)
      const remoteName = path.basename(relativePath)
      const tmpRemote = `/tmp/jarvis-bridge-upload-${remoteName}`
      try {
        await runDeterministicCommand(
          commands.tnrPath,
          ['scp', localPath, `${instanceId}:${tmpRemote}`],
          { timeout: 20_000 },
        )
        uploadCount += 1
      } catch (err) {
        failedUploads.push(
          `${relativePath} (${summarizeLogValue(err instanceof Error ? err.message : String(err), 120)})`,
        )
      }
    }
    uploadResults.push({
      name: 'bridge runtime upload',
      status: failedUploads.length === 0 ? 'ok' : 'warn',
      detail:
        failedUploads.length === 0
          ? `staged ${uploadCount}/${REMOTE_BRIDGE_RUNTIME_RELATIVE_PATHS.length} bridge files via tnr scp`
          : `staged ${uploadCount}/${REMOTE_BRIDGE_RUNTIME_RELATIVE_PATHS.length} bridge files; failed: ${failedUploads.join(', ')}`,
    })
  }

  // ── 3. SSH: apply env + bridge files, restart uvicorn ────────────────────
  for (const result of uploadResults) {
    emitter.log(stepId, formatBridgeVerificationResult(result))
  }

  try {
    await runDirectSshCommand(target, buildBridgeApplyCommand(), emitter, stepId, 30_000)
    emitter.log(
      stepId,
      formatBridgeVerificationResult({
        name: 'SSH apply',
        status: 'ok',
        detail: 'copied env + bridge files and requested uvicorn restart via pkill',
      }),
    )
    await new Promise(r => setTimeout(r, 4_000))
  } catch (applyErr) {
    const msg = applyErr instanceof Error ? applyErr.message : String(applyErr)
    emitter.log(
      stepId,
      formatBridgeVerificationResult({
        name: 'SSH apply',
        status: 'error',
        detail: summarizeLogValue(msg, 280),
      }),
    )
    emitter.updateStep(stepId, 'error', msg)
    throw new Error(msg)
  }

  let verificationOutput = ''
  try {
    const verify = await runDirectSshCommand(
      target,
      buildBridgeVerificationCommand(bridgeApiKey),
      emitter,
      stepId,
      35_000,
    )
    verificationOutput = verify.stdout
  } catch (verifyErr) {
    const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr)
    emitter.log(
      stepId,
      formatBridgeVerificationResult({
        name: 'verification bundle',
        status: 'error',
        detail: summarizeLogValue(msg, 280),
      }),
    )
    emitter.updateStep(stepId, 'error', msg)
    throw new Error(msg)
  }

  const verification = parseRemoteBridgeVerification(verificationOutput)
  const { results, fatalMessages } = buildBridgeVerificationResults(verification)
  for (const result of results) {
    emitter.log(stepId, formatBridgeVerificationResult(result))
  }

  if (fatalMessages.length > 0) {
    const msg = `Bridge injection verification failed on instance ${instanceId}: ${fatalMessages.join(' | ')}`
    emitter.updateStep(stepId, 'error', msg)
    throw new Error(msg)
  }
}

// Keep the old name as an alias so call sites don't need updating.
async function injectBridgeApiKey(
  instanceId: string,
  bridgeApiKey: string,
  emitter: StepEmitter,
): Promise<void> {
  await uploadBridgeAndInjectKey(instanceId, bridgeApiKey, emitter, 'forward-port')
}

async function resolveForwardedThunderPublicUrl(
  instanceId: string,
  emitter: StepEmitter,
  stepId: ThunderStepId,
): Promise<ThunderPublicUrlResolution> {
  const forward = await execAsync(`tnr ports forward ${instanceId} --add 8787`, { timeout: 30_000 })
    .catch(err => ({ stdout: '', stderr: (err as Error).message }))
  const forwardOutput = `${forward.stdout}\n${forward.stderr}`.trim()
  emitter.log(stepId, forwardOutput || '(no output)')

  const directUrl = resolveThunderPublicUrl(forwardOutput, 8787)
  if (directUrl) {
    return { publicUrl: directUrl, source: 'tnr ports forward' }
  }

  const listed = await execAsync('tnr ports list', { timeout: 10_000 })
    .catch(() => ({ stdout: '', stderr: '' }))
  const listOutput = `${listed.stdout}\n${listed.stderr}`.trim()
  emitter.log(stepId, listOutput || '(no output from tnr ports list)')
  const listedUrl = resolveThunderPublicUrl(listOutput, 8787)
  if (!listedUrl) {
    throw new Error(
      `Port forwarded but no public URL found.\nForward output:\n${forwardOutput}\nList output:\n${listOutput}`,
    )
  }
  return { publicUrl: listedUrl, source: 'tnr ports list' }
}

async function pollThunderHealthUntilReady(
  publicUrl: string,
  emitter: StepEmitter,
  stepId: ThunderStepId,
  abortSignal: AbortSignal,
  timeoutMessage: string,
): Promise<void> {
  const healthUrl = buildThunderHealthCheckUrl(publicUrl)
  emitter.log(stepId, `Polling ${healthUrl} until vLLM + bridge ready...`)

  const healthDeadline = Date.now() + V2_HEALTHZ_TIMEOUT_MS
  const pollStart = Date.now()
  let lastLog = 0
  let healthReady = false
  let lastObservation: PublicHealthObservation = {
    statusCode: null,
    bodySnippet: '(no response yet)',
    note: 'waiting for first public health response',
  }

  while (Date.now() < healthDeadline) {
    if (abortSignal.aborted) {
      throw new Error('Automation aborted by user.')
    }

    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) })
      const body = await resp.text()
      const probe = parseBridgeHealthProbe(body)
      const summarizedBody = probe
        ? formatBridgeHealthProbeSummary(probe)
        : summarizeLogValue(body, 180)

      if (resp.ok && probe?.ready) {
        emitter.log(stepId, `Ready: ${formatBridgeHealthProbeSummary(probe)}`)
        lastObservation = {
          statusCode: resp.status,
          bodySnippet: summarizedBody,
          note: 'bridge reports ready',
        }
        healthReady = true
        break
      }

      const observation: PublicHealthObservation = resp.ok
        ? {
            statusCode: resp.status,
            bodySnippet: summarizedBody,
            note: 'public /healthz reachable but not ready yet',
          }
        : {
            statusCode: resp.status,
            bodySnippet: summarizedBody,
            note: 'public /healthz returned non-success',
          }
      lastObservation = observation
      if (Date.now() - lastLog > V2_LOG_INTERVAL_MS) {
        const elapsed = Math.round((Date.now() - pollStart) / 60_000)
        emitter.log(stepId, `+${elapsed}min: ${formatPublicHealthObservation(observation)}`)
        lastLog = Date.now()
      }
    } catch (err) {
      lastObservation = {
        statusCode: null,
        bodySnippet: summarizeLogValue(err instanceof Error ? err.message : String(err), 180),
        note: 'bridge not reachable from the public URL',
      }
      if (Date.now() - lastLog > V2_LOG_INTERVAL_MS) {
        const elapsed = Math.round((Date.now() - pollStart) / 60_000)
        emitter.log(stepId, `+${elapsed}min: ${formatPublicHealthObservation(lastObservation)}`)
        lastLog = Date.now()
      }
    }
    await new Promise(r => setTimeout(r, V2_HEALTHZ_POLL_MS))
  }

  if (!healthReady) {
    throw new Error(`${timeoutMessage} Last public health response: ${formatPublicHealthObservation(lastObservation)}`)
  }
}

async function logPublicModelsProbe(
  publicUrl: string,
  bridgeApiKey: string,
  emitter: StepEmitter,
  stepId: ThunderStepId,
): Promise<void> {
  const modelsUrl = new URL('/v1/models', publicUrl).toString()
  try {
    const resp = await fetch(modelsUrl, {
      headers: { 'X-Api-Key': bridgeApiKey },
      signal: AbortSignal.timeout(10_000),
    })
    const body = summarizeLogValue(await resp.text(), 180)
    emitter.log(
      stepId,
      formatBridgeVerificationResult({
        name: 'public /v1/models',
        status: resp.ok ? 'ok' : 'warn',
        detail: `HTTP ${resp.status}; ${body}`,
      }),
    )
  } catch (err) {
    emitter.log(
      stepId,
      formatBridgeVerificationResult({
        name: 'public /v1/models',
        status: 'warn',
        detail: summarizeLogValue(err instanceof Error ? err.message : String(err), 220),
      }),
    )
  }
}

/**
 * 5-step snapshot-driven automation:
 *   1. create-instance  — tnr create from jarvis-snap-v2
 *   2. wait-running     — poll tnr status until RUNNING
 *   3. forward-port     — tnr ports forward 8787, parse public URL
 *   4. poll-healthz     — fetch /healthz until ready (vLLM cold load: 40-90 min)
 *   5. attach           — return { publicUrl, instanceId }
 *
 * Between steps 2 and 3, injects the per-launch API key via one SSH call
 * using Thunder's managed key at ~/.thunder/keys/<uuid>.
 */
export async function runAutomationV2(
  bridgeApiKey: string,
  mainWindow: BrowserWindow,
  emitter: StepEmitter,
  abortSignal: AbortSignal,
  options?: { snapshotName?: string },
): Promise<AutomationResult> {
  const snapshotName = options?.snapshotName ?? V2_SNAPSHOT_NAME

  const checkAbort = () => {
    if (abortSignal.aborted) throw new Error('Automation aborted by user.')
  }

  // ── Step 1: create-instance ──────────────────────────────────────────────
  emitter.updateStep('create-instance', 'active', null)
  emitter.log('create-instance', `Creating Thunder H100 from snapshot '${snapshotName}'...`)

  const createCmd = `tnr create --mode prototyping --gpu h100 --template ${snapshotName} --disk-size-gb 500 --num-gpus 1 --vcpus 8 --json -y`
  emitter.log('create-instance', `> ${createCmd}`)

  let instanceId: string
  try {
    const { stdout, stderr } = await execAsync(createCmd, { timeout: V2_CREATE_TIMEOUT_MS })
    const combined = `${stdout}\n${stderr}`.trim()
    emitter.log('create-instance', combined)

    // Try JSON first (--json flag), then text patterns
    let parsed: { id?: string } | null = null
    try { parsed = JSON.parse(stdout.trim()) } catch { /* not JSON */ }

    const id = parsed?.id
      ?? combined.match(/(?:instance(?:\s+id)?[:\s#]+)(\d+)/im)?.[1]
      ?? combined.match(/(?:^|\s)(\d+)(?:\s|$)/m)?.[1]

    if (!id) {
      throw new Error(`Cannot parse instance ID from tnr create output:\n${combined.slice(0, 500)}`)
    }
    instanceId = id
    emitter.log('create-instance', `Instance ID: ${instanceId}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emitter.updateStep('create-instance', 'error', msg)
    throw err
  }
  emitter.updateStep('create-instance', 'done', null)

  // ── Step 2: wait-running ─────────────────────────────────────────────────
  emitter.updateStep('wait-running', 'active', null)
  emitter.log('wait-running', `Waiting for instance ${instanceId} to reach running state...`)

  let instanceUuid: string | null = null
  let instanceIp: string | null = null
  let instancePort: number | null = null
  const waitDeadline = Date.now() + V2_WAIT_RUNNING_TIMEOUT_MS
  let running = false

  while (Date.now() < waitDeadline) {
    checkAbort()
    await new Promise(r => setTimeout(r, 5_000))
    checkAbort()

    try {
      const { stdout } = await execAsync('tnr status --no-wait --json', { timeout: 15_000 })
      const jsonStart = stdout.indexOf('[')
      const instances: TnrInstanceJson[] = jsonStart >= 0
        ? JSON.parse(stdout.slice(jsonStart))
        : []
      const inst = instances.find(i => i.id === instanceId)
      if (inst) {
        const s = inst.status.toLowerCase()
        emitter.log('wait-running', `Status: ${inst.status}`)
        if (s === 'running') {
          instanceUuid = inst.uuid
          instanceIp = inst.ip
          instancePort = inst.port
          running = true
          break
        }
      } else {
        emitter.log('wait-running', `Instance ${instanceId} not yet visible...`)
      }
    } catch {
      // JSON parse failed — fall back to text parser
      try {
        const { stdout } = await execAsync('tnr status --no-wait', { timeout: 15_000 })
        const inst = parseTnrStatus(stdout).find(i => i.id === instanceId)
        if (inst?.status === 'running') { running = true; break }
        emitter.log('wait-running', `Status: ${inst?.status ?? 'unknown'}`)
      } catch { /* ignore poll failure */ }
    }
  }

  if (!running) {
    const msg = `Instance ${instanceId} did not reach running state within ${V2_WAIT_RUNNING_TIMEOUT_MS / 60_000} min.`
    emitter.updateStep('wait-running', 'error', msg)
    throw new Error(msg)
  }
  emitter.log('wait-running', `Instance ${instanceId} is running.`)
  emitter.updateStep('wait-running', 'done', null)

  // ── Step 2.5: inject per-launch API key (tnr scp + one SSH restart) ─────
  await injectBridgeApiKey(instanceId, bridgeApiKey, emitter)

  // ── Step 3: forward-port ─────────────────────────────────────────────────
  emitter.updateStep('forward-port', 'active', null)
  emitter.log('forward-port', `Forwarding port 8787 for instance ${instanceId}...`)

  let publicUrl: string
  try {
    const resolution = await resolveForwardedThunderPublicUrl(instanceId, emitter, 'forward-port')
    publicUrl = resolution.publicUrl
    emitter.log('forward-port', `Public URL source: ${resolution.source}`)
    emitter.log('forward-port', `Public URL: ${publicUrl}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emitter.updateStep('forward-port', 'error', msg)
    throw err
  }
  emitter.updateStep('forward-port', 'done', null)

  // ── Step 4: poll-healthz ─────────────────────────────────────────────────
  emitter.updateStep('poll-healthz', 'active', null)
  emitter.log('poll-healthz', 'Cold boot: model loads from disk - expect 40-90 min on first start.')
  try {
    await pollThunderHealthUntilReady(
      publicUrl,
      emitter,
      'poll-healthz',
      abortSignal,
      `Bridge did not become ready within ${V2_HEALTHZ_TIMEOUT_MS / 60_000} min. Check /var/log/jarvis/bridge.log and /var/log/jarvis/vllm.log on instance ${instanceId}.`,
    )
    await logPublicModelsProbe(publicUrl, bridgeApiKey, emitter, 'poll-healthz')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emitter.updateStep('poll-healthz', 'error', msg)
    throw err
  }
  /*
  emitter.log('poll-healthz', `Cold boot: model loads from disk — expect 40-90 min on first start.`)

  const healthDeadline = Date.now() + V2_HEALTHZ_TIMEOUT_MS
  const pollStart = Date.now()
  let lastLog = 0
  let healthReady = false

  while (Date.now() < healthDeadline) {
    checkAbort()
    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) })
      const body = await resp.text()
      const probe = parseBridgeHealthProbe(body)
      const summarizedBody = probe
        ? formatBridgeHealthProbeSummary(probe)
        : summarizeLogValue(body, 180)
      if (resp.ok && probe?.ready) {
        emitter.log('poll-healthz', `Ready: ${formatBridgeHealthProbeSummary(probe)}`)
        lastHealthObservation = {
          statusCode: resp.status,
          bodySnippet: summarizedBody,
          note: 'bridge reports ready',
        }
        healthReady = true
        break
      }
      if (Date.now() - lastLog > V2_LOG_INTERVAL_MS) {
          emitter.log('poll-healthz', `+${elapsed}min: not ready — ${probe ? formatBridgeHealthProbeSummary(probe) : body.slice(0, 100)}`)
        const elapsed = Math.round((Date.now() - pollStart) / 60_000)
        }
      }
    } catch {
      if (Date.now() - lastLog > V2_LOG_INTERVAL_MS) {
        const elapsed = Math.round((Date.now() - pollStart) / 60_000)
        emitter.log('poll-healthz', `+${elapsed}min: bridge not reachable — vLLM still loading...`)
        lastLog = Date.now()
      }
    }
    await new Promise(r => setTimeout(r, V2_HEALTHZ_POLL_MS))
  }

  if (!healthReady) {
    const msg = `Bridge did not become ready within ${V2_HEALTHZ_TIMEOUT_MS / 60_000} min. Check: ssh tnr-${instanceId} 'tail -f /var/log/jarvis/vllm.log'`
    emitter.updateStep('poll-healthz', 'error', msg)
    throw new Error(msg)
  }
  */
  emitter.updateStep('poll-healthz', 'done', null)

  // ── Step 5: attach ───────────────────────────────────────────────────────
  emitter.updateStep('attach', 'active', null)
  emitter.log('attach', `Session active — public URL: ${publicUrl}`)
  emitter.updateStep('attach', 'done', null)

  return { publicUrl, instanceId }
}

/**
 * 3-step attach flow for an already-running instance (steps 3-5 of runAutomationV2).
 * Skips create-instance and wait-running — use when the instance is known to be up.
 *
 *   1. forward-port  — tnr ports forward 8787, parse public URL
 *   2. poll-healthz  — fetch /healthz until bridge ready
 *   3. attach        — return { publicUrl, instanceId }
 */
export async function runAutomationV2Attach(
  instanceId: string,
  bridgeApiKey: string,
  mainWindow: BrowserWindow,
  emitter: StepEmitter,
  abortSignal: AbortSignal,
): Promise<AutomationResult> {
  const checkAbort = () => {
    if (abortSignal.aborted) throw new Error('Automation aborted by user.')
  }

  // ── Step 1: forward-port ─────────────────────────────────────────────────
  emitter.updateStep('forward-port', 'active', null)
  emitter.log('forward-port', `Forwarding port 8787 for instance ${instanceId}...`)

  let publicUrl: string
  try {
    const resolution = await resolveForwardedThunderPublicUrl(instanceId, emitter, 'forward-port')
    publicUrl = resolution.publicUrl
    emitter.log('forward-port', `Public URL source: ${resolution.source}`)
    emitter.log('forward-port', `Public URL: ${publicUrl}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emitter.updateStep('forward-port', 'error', msg)
    throw err
  }
  emitter.updateStep('forward-port', 'done', null)

  checkAbort()

  // ── Step 1.5: inject per-launch API key ──────────────────────────────────
  // The snapshot bakes in PLACEHOLDER_OVERWRITE_AT_LAUNCH as the bridge key.
  // Without injection, every completion request is rejected and the CLI hangs.
  await injectBridgeApiKey(instanceId, bridgeApiKey, emitter)

  checkAbort()

  // ── Step 2: poll-healthz ─────────────────────────────────────────────────
  emitter.updateStep('poll-healthz', 'active', null)
  emitter.log('poll-healthz', 'If vLLM is still loading, this may take 40-90 min on first boot.')
  try {
    await pollThunderHealthUntilReady(
      publicUrl,
      emitter,
      'poll-healthz',
      abortSignal,
      `Bridge did not become ready within ${V2_HEALTHZ_TIMEOUT_MS / 60_000} min. Check /var/log/jarvis/bridge.log and /var/log/jarvis/vllm.log on instance ${instanceId}.`,
    )
    await logPublicModelsProbe(publicUrl, bridgeApiKey, emitter, 'poll-healthz')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    emitter.updateStep('poll-healthz', 'error', msg)
    throw err
  }
  /*

  const healthDeadline = Date.now() + V2_HEALTHZ_TIMEOUT_MS
  const pollStart = Date.now()
  let lastLog = 0
  let healthReady = false

  while (Date.now() < healthDeadline) {
    checkAbort()
    try {
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) })
      if (resp.ok) {
        const body = await resp.text()
        const probe = parseBridgeHealthProbe(body)
        if (probe?.ready) {
          emitter.log('poll-healthz', `Ready: ${formatBridgeHealthProbeSummary(probe)}`)
          healthReady = true
          break
        }
        if (Date.now() - lastLog > V2_LOG_INTERVAL_MS) {
          const elapsed = Math.round((Date.now() - pollStart) / 60_000)
          emitter.log('poll-healthz', `+${elapsed}min: not ready — ${probe ? formatBridgeHealthProbeSummary(probe) : body.slice(0, 100)}`)
          lastLog = Date.now()
        }
      }
    } catch {
      if (Date.now() - lastLog > V2_LOG_INTERVAL_MS) {
        const elapsed = Math.round((Date.now() - pollStart) / 60_000)
        emitter.log('poll-healthz', `+${elapsed}min: bridge not reachable — vLLM may still be loading...`)
        lastLog = Date.now()
      }
    }
    await new Promise(r => setTimeout(r, V2_HEALTHZ_POLL_MS))
  }

  if (!healthReady) {
    const msg = `Bridge did not become ready within ${V2_HEALTHZ_TIMEOUT_MS / 60_000} min. SSH into instance ${instanceId} and run: journalctl -u jarvis-vllm.service -u jarvis-bridge.service`
    emitter.updateStep('poll-healthz', 'error', msg)
    throw new Error(msg)
  }
  */
  emitter.updateStep('poll-healthz', 'done', null)

  // ── Step 3: attach ───────────────────────────────────────────────────────
  emitter.updateStep('attach', 'active', null)
  emitter.log('attach', `Session active — public URL: ${publicUrl}`)
  emitter.updateStep('attach', 'done', null)

  return { publicUrl, instanceId }
}
