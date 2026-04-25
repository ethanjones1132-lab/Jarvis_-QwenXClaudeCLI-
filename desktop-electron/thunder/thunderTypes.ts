/** Thunder Compute session orchestrator types */

export type ThunderStepId =
  | 'connect-instance'
  | 'get-ssh-info'
  | 'system-prep'
  | 'start-vllm'
  | 'poll-vllm'
  | 'pull-bridge'
  | 'start-bridge'
  | 'poll-bridge'
  | 'verify-ports'
  | 'forward-port'
  | 'health-check'
  | 'save-config'
  // v2 snapshot-driven pathway
  | 'create-instance'
  | 'wait-running'
  | 'poll-healthz'
  | 'attach'

export type ThunderStepState = 'pending' | 'active' | 'done' | 'error'
  | 'skipped'

export type ThunderStepStatus = {
  id: ThunderStepId
  label: string
  state: ThunderStepState
  startedAt: number | null
  error: string | null
}

export type ThunderSessionConfig = {
  thunderInstanceId: string
  thunderPublicUrl: string
  thunderSessionActive: boolean
}

export type ThunderSshInfo = {
  host: string
  port: number
  username: string
  privateKeyPath: string
}

export type ThunderLogLine = {
  timestamp: number
  source: ThunderStepId | 'detection' | 'pty'
  text: string
}

export type ThunderSessionDetectedPayload = {
  instanceId: string
}

export type ThunderStepUpdatePayload = {
  stepId: ThunderStepId
  state: ThunderStepState
  error: string | null
}

export type ThunderLogStreamPayload = {
  source: string
  text: string
}

export const THUNDER_STEPS_V2: Array<{ id: ThunderStepId; label: string }> = [
  { id: 'create-instance', label: 'Create GPU instance' },
  { id: 'wait-running', label: 'Wait for instance ready' },
  { id: 'forward-port', label: 'Forward port 8787' },
  { id: 'poll-healthz', label: 'Wait for model load' },
  { id: 'attach', label: 'Attach session' },
]

/** 3-step list for reconnecting to an already-running instance (skips create + wait). */
export const THUNDER_STEPS_V2_ATTACH: Array<{ id: ThunderStepId; label: string }> = [
  { id: 'forward-port', label: 'Forward port 8787' },
  { id: 'poll-healthz', label: 'Wait for bridge ready' },
  { id: 'attach', label: 'Attach session' },
]

export const THUNDER_STEPS: Array<{ id: ThunderStepId; label: string }> = [
  { id: 'connect-instance', label: 'Connect to instance' },
  { id: 'get-ssh-info', label: 'Get SSH details' },
  { id: 'pull-bridge', label: 'Provision bridge runtime' },
  { id: 'system-prep', label: 'Prepare fallback runtime' },
  { id: 'start-vllm', label: 'Start vLLM server' },
  { id: 'poll-vllm', label: 'Wait for model loading' },
  { id: 'start-bridge', label: 'Start bridge server' },
  { id: 'poll-bridge', label: 'Verify bridge ready' },
  { id: 'verify-ports', label: 'Verify listening ports' },
  { id: 'forward-port', label: 'Forward port 8787' },
  { id: 'health-check', label: 'End-to-end health check' },
  { id: 'save-config', label: 'Save config & connect' },
]

export const THUNDER_ERROR_MESSAGES: Record<string, string> = {
  'connect-failed':
    "Could not connect to instance {id}. Run 'tnr status' to verify it is still running.",
  'ssh-failed':
    'Could not establish SSH connection to the GPU instance. Verify the instance is active and tnr connect completed successfully.',
  'vllm-oom':
    'vLLM ran out of GPU memory loading the 120B model. Check ~/gptoss-120b.log. The launcher now defaults to --gpu-memory-utilization 0.85 and --max-model-len 2048; if it still fails, try 0.80 / 1536.',
  'vllm-timeout':
    'vLLM has not become ready. If the snapshot is healthy, check that the pinned vllm-env includes native GPT-OSS plus MXFP4 support and that the local weights cache is complete. If the legacy fallback is running, the model weights may still be downloading (~63GB). Check ~/gptoss-120b.log for progress.',
  'bridge-crash':
    'Bridge process failed to start. Check ~/jarvis-bridge.log for Python errors. Verify that ~/claude-code-src-leaked/server/remote_glm_bridge was uploaded successfully and that ~/.jarvis-remote-repo-root points at ~/claude-code-src-leaked.',
  'public-url-unreachable':
    'Bridge is running and ports are forwarded, but the public URL is not responding. This is usually a propagation delay. Wait 60 seconds and retry the health check.',
}
