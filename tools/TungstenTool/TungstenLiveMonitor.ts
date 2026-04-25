/**
 * TungstenLiveMonitor — Continuous output watcher for tmux panes.
 *
 * Captures scrollback from a target pane at regular intervals and emits
 * diffs (new lines since last capture). Used by the orchestration layer
 * to stream long-running command output back to the model without
 * requiring explicit capture calls.
 */

import {
  checkTmuxAvailable,
  getClaudeSocketName,
} from '../../utils/tmuxSocket.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getPlatform } from '../../utils/platform.js'

export type MonitorEvent = {
  paneTarget: string
  newLines: string[]
  timestamp: number
}

export type MonitorCallback = (event: MonitorEvent) => void

const DEFAULT_POLL_INTERVAL_MS = 1_000

async function execTmuxCapture(
  paneTarget: string,
): Promise<string> {
  const socket = getClaudeSocketName()
  const args = ['-L', socket, 'capture-pane', '-t', paneTarget, '-p', '-J']

  if (getPlatform() === 'windows') {
    const result = await execFileNoThrow('wsl', ['-e', 'tmux', ...args], {
      env: { ...process.env, WSL_UTF8: '1' },
    })
    return result.stdout || ''
  }
  const result = await execFileNoThrow('tmux', args)
  return result.stdout || ''
}

export class TungstenLiveMonitor {
  private paneTarget: string
  private callback: MonitorCallback
  private intervalMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private lastLines: string[] = []
  private running = false

  constructor(
    paneTarget: string,
    callback: MonitorCallback,
    intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  ) {
    this.paneTarget = paneTarget
    this.callback = callback
    this.intervalMs = intervalMs
  }

  async start(): Promise<boolean> {
    const available = await checkTmuxAvailable()
    if (!available) return false

    if (this.running) return true
    this.running = true

    // Initial capture to set baseline
    const initial = await execTmuxCapture(this.paneTarget)
    this.lastLines = initial.split('\n')

    this.timer = setInterval(() => {
      void this.poll()
    }, this.intervalMs)

    return true
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  isRunning(): boolean {
    return this.running
  }

  private async poll(): Promise<void> {
    if (!this.running) return

    try {
      const output = await execTmuxCapture(this.paneTarget)
      const currentLines = output.split('\n')

      // Find new lines by comparing lengths (tmux appends to scrollback)
      const newLines =
        currentLines.length > this.lastLines.length
          ? currentLines.slice(this.lastLines.length)
          : []

      if (newLines.length > 0) {
        this.lastLines = currentLines
        this.callback({
          paneTarget: this.paneTarget,
          newLines,
          timestamp: Date.now(),
        })
      }
    } catch {
      // Pane may have been destroyed — stop polling
      this.stop()
    }
  }
}
