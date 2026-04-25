/**
 * Thunder Compute — IPC Handler Registration
 *
 * Registers all Thunder-related IPC channels in the main process.
 * Orchestrates the Phase 1 → Phase 2 flow.
 */

import { exec } from 'child_process'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  openTerminalWindow,
  writeTransitionMessage,
  closeTerminalWindow,
} from './thunderTerminal.js'
import { startDetection } from './thunderDetection.js'
import { parseTnrStatus } from './thunderStatus.js'
import {
  runAutomation,
  runAutomationV2,
  runAutomationV2Attach,
  type AutomationResult,
  buildThunderHealthCheckUrl,
  resolveThunderPublicUrl,
} from './thunderAutomation.js'
import {
  THUNDER_STEPS,
  THUNDER_STEPS_V2,
  THUNDER_STEPS_V2_ATTACH,
  type ThunderStepId,
  type ThunderStepState,
} from './thunderTypes.js'

let detectionCleanup: (() => void) | null = null
let automationAbort: AbortController | null = null

/**
 * Check if a Thunder instance from a previous session is still running.
 * Returns the instance ID if running, null otherwise.
 */
export function checkExistingSession(instanceId: string): Promise<string | null> {
  return new Promise(resolve => {
    if (!instanceId) {
      resolve(null)
      return
    }
    exec('tnr status --no-wait', { timeout: 15_000 }, (error, stdout) => {
      if (error) {
        resolve(null)
        return
      }
      const runningInstance = parseTnrStatus(stdout).find(
        inst => inst.id === instanceId && inst.status === 'running',
      )
      resolve(runningInstance ? instanceId : null)
    })
  })
}

/**
 * Register all Thunder IPC handlers.
 * Must be called once from main process initialization.
 */
export function registerThunderIpc(getMainWindow: () => BrowserWindow | null): void {
  // Open the terminal window and start Phase 1 detection
  ipcMain.handle('thunder:open-terminal', async () => {
    const mainWin = getMainWindow()
    if (!mainWin) {
      throw new Error('Main window not available')
    }

    openTerminalWindow(mainWin)

    // Start detection polling
    detectionCleanup = await startDetection((instanceId: string) => {
      // Transition: show message in terminal, close, notify renderer
      writeTransitionMessage('Session detected \u2014 Jarvis is taking over...')

      setTimeout(() => {
        closeTerminalWindow()
        const win = getMainWindow()
        if (win && !win.isDestroyed()) {
          win.webContents.send('thunder:session-detected', { instanceId })
        }
      }, 1500)
    })

    return { ok: true }
  })

  // Begin Phase 2 automation
  ipcMain.handle(
    'thunder:begin-automation',
    async (_event, instanceId: string, bridgeApiKey: string) => {
      const mainWin = getMainWindow()
      if (!mainWin) {
        throw new Error('Main window not available')
      }

      automationAbort = new AbortController()

      const emitter = {
        updateStep(
          stepId: ThunderStepId,
          state: ThunderStepState,
          error: string | null,
        ): void {
          if (!mainWin.isDestroyed()) {
            mainWin.webContents.send('thunder:step-update', {
              stepId,
              state,
              error,
            })
          }
        },
        log(source: string, text: string): void {
          if (!mainWin.isDestroyed()) {
            mainWin.webContents.send('thunder:log-stream', {
              source,
              text,
            })
          }
        },
      }

      try {
        const result: AutomationResult = await runAutomation(
          instanceId,
          bridgeApiKey,
          mainWin,
          emitter,
          automationAbort.signal,
        )

        // Mark save-config as done
        emitter.updateStep('save-config', 'done', null)

        // Explicit completion broadcast — the panel awaits the invoke
        // return, but this gives any other subscribed listener a clean
        // signal that the full pipeline finished successfully.
        if (!mainWin.isDestroyed()) {
          mainWin.webContents.send('thunder:automation-complete', {
            instanceId: result.instanceId,
            publicUrl: result.publicUrl,
          })
        }

        return {
          ok: true,
          publicUrl: result.publicUrl,
          instanceId: result.instanceId,
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },
  )

  // Abort automation
  ipcMain.handle('thunder:abort-automation', () => {
    automationAbort?.abort()
    automationAbort = null
    detectionCleanup?.()
    detectionCleanup = null
    return { ok: true }
  })

  // Run health check on a public URL (for resume flow)
  ipcMain.handle(
    'thunder:health-check',
    async (_event, publicUrl: string, apiKey: string) => {
      try {
        const response = await fetch(buildThunderHealthCheckUrl(publicUrl), {
          headers: { 'X-Api-Key': apiKey },
          signal: AbortSignal.timeout(10_000),
        })
        return { ok: response.ok }
      } catch {
        return { ok: false }
      }
    },
  )

  // Check existing session for resume flow
  ipcMain.handle(
    'thunder:check-session',
    async (_event, instanceId: string) => {
      const result = await checkExistingSession(instanceId)
      return { running: result !== null, instanceId: result }
    },
  )

  // Forward a port (for resume flow, Step 4)
  ipcMain.handle('thunder:forward-port', async (_event, instanceId: string) => {
    return new Promise(resolve => {
      if (!instanceId) {
        resolve({ ok: false, error: 'No Thunder instance ID was provided.' })
        return
      }
      exec(
        `tnr ports forward ${instanceId} --add 8787`,
        { timeout: 30_000 },
        (error, stdout, stderr) => {
          if (error) {
            resolve({ ok: false, error: error.message })
            return
          }

          const forwardOutput = `${stdout}\n${stderr}`.trim()
          const publicUrl = resolveThunderPublicUrl(forwardOutput, 8787)
          if (publicUrl) {
            resolve({ ok: true, publicUrl })
            return
          }

          exec('tnr ports list', { timeout: 10_000 }, (listErr, listStdout, listStderr) => {
            if (!listErr) {
              const listOutput = `${listStdout}\n${listStderr}`.trim()
              const listedUrl = resolveThunderPublicUrl(listOutput, 8787)
              if (listedUrl) {
                resolve({ ok: true, publicUrl: listedUrl })
                return
              }
            }

            resolve({
              ok: false,
              error:
                'Port 8787 was forwarded, but Thunder did not expose a public URL yet. Retry in a few seconds.',
            })
          })
        },
      )
    })
  })

  // Get Thunder steps list for UI initialization
  ipcMain.handle('thunder:get-steps', () => {
    return THUNDER_STEPS
  })

  // V2: Single-shot session start — creates instance, waits, forwards port, polls /healthz
  ipcMain.handle(
    'thunder:start-session',
    async (_event, bridgeApiKey: string, snapshotName?: string) => {
      const mainWin = getMainWindow()
      if (!mainWin) throw new Error('Main window not available')

      automationAbort = new AbortController()

      const emitter = {
        updateStep(stepId: ThunderStepId, state: ThunderStepState, error: string | null): void {
          if (!mainWin.isDestroyed()) {
            mainWin.webContents.send('thunder:step-update', { stepId, state, error })
          }
        },
        log(source: string, text: string): void {
          if (!mainWin.isDestroyed()) {
            mainWin.webContents.send('thunder:log-stream', { source, text })
          }
        },
      }

      try {
        const result: AutomationResult = await runAutomationV2(
          bridgeApiKey,
          mainWin,
          emitter,
          automationAbort.signal,
          snapshotName ? { snapshotName } : undefined,
        )

        if (!mainWin.isDestroyed()) {
          mainWin.webContents.send('thunder:automation-complete', {
            instanceId: result.instanceId,
            publicUrl: result.publicUrl,
          })
        }

        return { ok: true, publicUrl: result.publicUrl, instanceId: result.instanceId }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  // Get V2 steps list (for renderer to initialize the v2 progress UI)
  ipcMain.handle('thunder:get-steps-v2', () => {
    return THUNDER_STEPS_V2
  })

  // Get V2 attach steps list (3-step reconnect flow)
  ipcMain.handle('thunder:get-steps-v2-attach', () => {
    return THUNDER_STEPS_V2_ATTACH
  })

  // V2 attach: reconnect to an already-running instance (skip create + wait)
  ipcMain.handle(
    'thunder:attach-instance',
    async (_event, instanceId: string, bridgeApiKey: string) => {
      const mainWin = getMainWindow()
      if (!mainWin) throw new Error('Main window not available')

      automationAbort = new AbortController()

      const emitter = {
        updateStep(stepId: ThunderStepId, state: ThunderStepState, error: string | null): void {
          if (!mainWin.isDestroyed()) {
            mainWin.webContents.send('thunder:step-update', { stepId, state, error })
          }
        },
        log(source: string, text: string): void {
          if (!mainWin.isDestroyed()) {
            mainWin.webContents.send('thunder:log-stream', { source, text })
          }
        },
      }

      try {
        const result: AutomationResult = await runAutomationV2Attach(
          instanceId,
          bridgeApiKey,
          mainWin,
          emitter,
          automationAbort.signal,
        )

        if (!mainWin.isDestroyed()) {
          mainWin.webContents.send('thunder:automation-complete', {
            instanceId: result.instanceId,
            publicUrl: result.publicUrl,
          })
        }

        return { ok: true, publicUrl: result.publicUrl, instanceId: result.instanceId }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
