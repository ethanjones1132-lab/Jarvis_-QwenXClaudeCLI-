/**
 * Thunder Compute - Phase 1 Session Detection
 *
 * Polls `tnr status --no-wait` to detect when a new instance reaches running state.
 * Uses PTY output as a corroborating signal to increase poll frequency.
 *
 * IMPORTANT: `tnr status` without --no-wait is an interactive live monitor that
 * never exits. Always use --no-wait for polling.
 */

import { exec } from 'child_process'
import { getPtyOutputBuffer } from './thunderTerminal.js'
import { parseTnrStatus, type TnrInstance } from './thunderStatus.js'

type DetectionState = {
  baselineIds: Set<string>
  pollInterval: ReturnType<typeof setInterval> | null
  fastPolling: boolean
  resolved: boolean
  onDetected: ((instanceId: string) => void) | null
}

const state: DetectionState = {
  baselineIds: new Set(),
  pollInterval: null,
  fastPolling: false,
  resolved: false,
  onDetected: null,
}

/**
 * Execute `tnr status --no-wait` and return parsed instances.
 * The --no-wait flag is critical - without it, tnr status enters
 * an interactive live monitor that never exits.
 */
function pollTnrStatus(): Promise<TnrInstance[]> {
  return new Promise(resolve => {
    exec('tnr status --no-wait', { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        // Log stderr for debugging but don't fail - tnr might just have no instances.
        if (stderr && stderr.trim()) {
          console.error('[thunder-detection] tnr status stderr:', stderr.trim())
        }
        resolve([])
        return
      }

      console.log('[thunder-detection] tnr status raw:', stdout)
      resolve(parseTnrStatus(stdout))
    })
  })
}

/**
 * Check if PTY output suggests the user is near completion of the wizard.
 * Used as a corroborating signal to increase poll frequency.
 */
function checkPtyForCompletionHints(): boolean {
  const buffer = getPtyOutputBuffer()
  if (!buffer) {
    return false
  }

  const lower = buffer.toLowerCase()
  return (
    lower.includes('create instance') ||
    lower.includes('mode:') ||
    lower.includes('gpu type:') ||
    lower.includes('disk size:') ||
    lower.includes('creating') ||
    lower.includes('provisioning') ||
    lower.includes('instance created') ||
    lower.includes('\u2713') ||
    lower.includes('success')
  )
}

/**
 * Start the detection loop.
 * Captures baseline tnr status, then polls for new running instances.
 *
 * @param onDetected - Called with the new instance ID when detection succeeds
 * @returns Cleanup function to stop detection
 */
export async function startDetection(
  onDetected: (instanceId: string) => void,
): Promise<() => void> {
  state.resolved = false
  state.fastPolling = false
  state.onDetected = onDetected

  const baselineInstances = await pollTnrStatus()
  state.baselineIds = new Set(baselineInstances.map(inst => inst.id))
  console.log('[thunder-detection] baseline instance IDs:', [...state.baselineIds])

  const runPoll = async (): Promise<void> => {
    if (state.resolved) {
      return
    }

    if (!state.fastPolling && checkPtyForCompletionHints()) {
      console.log('[thunder-detection] PTY hints detected, switching to fast polling')
      state.fastPolling = true
      if (state.pollInterval) {
        clearInterval(state.pollInterval)
      }
      state.pollInterval = setInterval(() => void runPoll(), 2_000)
    }

    const instances = await pollTnrStatus()
    console.log(
      '[thunder-detection] poll result:',
      instances.map(i => `${i.id}=${i.status}`).join(', ') || '(none)',
    )

    for (const inst of instances) {
      if (inst.status === 'running' && !state.baselineIds.has(inst.id)) {
        console.log('[thunder-detection] NEW RUNNING INSTANCE:', inst.id)
        state.resolved = true
        if (state.pollInterval) {
          clearInterval(state.pollInterval)
          state.pollInterval = null
        }
        state.onDetected?.(inst.id)
        return
      }
    }
  }

  state.pollInterval = setInterval(() => void runPoll(), 6_000)
  void runPoll()

  return () => {
    state.resolved = true
    if (state.pollInterval) {
      clearInterval(state.pollInterval)
      state.pollInterval = null
    }
  }
}
