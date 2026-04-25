import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createServer } from 'http'
import * as https from 'https'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import path from 'path'
import readline from 'readline'
import type { LauncherConfig } from '../desktop-app/config.js'
import { registerThunderIpc } from './thunder/thunderIpc.js'

type BackendState = {
  ready: boolean
  url: string | null
  error?: string
}

let mainWindow: BrowserWindow | null = null
let backendProcess: ChildProcessWithoutNullStreams | null = null
let backendUrl: string | null = null
let backendReadyPromise: Promise<string> | null = null
let backendState: BackendState = {
  ready: false,
  url: null,
}
let eventStreamAbort: AbortController | null = null

function getRepoRoot(): string {
  return process.env.JARVIS_REPO_ROOT ?? path.resolve(__dirname, '..')
}

function getRendererEntry(): string {
  return path.join(__dirname, 'renderer', 'index.html')
}

function getPreloadEntry(): string {
  return path.join(__dirname, 'preload.cjs')
}

function broadcastBackendState(): void {
  const payload = { ...backendState }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('jarvis:backend-state', payload)
  }
}

function broadcastEvent(payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('jarvis:event', payload)
  }
}

function resolveWorkerCommand(): {
  command: string
  args: string[]
  cwd: string
} {
  const repoRoot = getRepoRoot()
  const packagedWorker = path.join(process.resourcesPath, 'bin', 'JarvisWorker.exe')
  if (app.isPackaged && existsSync(packagedWorker)) {
    return {
      command: packagedWorker,
      args: [],
      cwd: process.resourcesPath,
    }
  }

  const devWorker = path.join(repoRoot, 'dist-desktop', 'JarvisWorker.exe')
  if (existsSync(devWorker)) {
    return {
      command: devWorker,
      args: [],
      cwd: repoRoot,
    }
  }

  return {
    command: 'bun',
    args: ['run', 'desktop-app/launcher.ts'],
    cwd: repoRoot,
  }
}

/**
 * Resolve the absolute path to ClaudeCodeCli.exe from the Electron main
 * process — where process.execPath IS Jarvis.exe, so dirname() points at the
 * win-unpacked directory that holds all sibling binaries.  The worker process
 * (JarvisWorker.exe) lives in resources/bin/ and cannot derive this path
 * reliably, so we inject it as JARVIS_CLI_EXE.
 */
function resolveCliExePath(): string {
  // Packaged: ClaudeCodeCli.exe is placed next to Jarvis.exe by extraFiles
  const siblingCli = path.join(path.dirname(process.execPath), 'ClaudeCodeCli.exe')
  if (existsSync(siblingCli)) return siblingCli

  // Dev: built binary lives in dist-desktop/ next to JarvisWorker.exe
  const repoCli = path.join(getRepoRoot(), 'dist-desktop', 'ClaudeCodeCli.exe')
  if (existsSync(repoCli)) return repoCli

  return ''
}

async function ensureUserDataReady(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
}

async function ensureBackend(): Promise<string> {
  if (backendReadyPromise) {
    return backendReadyPromise
  }

  backendReadyPromise = new Promise<string>((resolve, reject) => {
    const worker = resolveWorkerCommand()
    const child = spawn(worker.command, worker.args, {
      cwd: worker.cwd,
      env: {
        ...process.env,
        CLAUDE_BODY_DESKTOP_SKIP_OPEN: '1',
        APPDATA: process.env.APPDATA ?? app.getPath('appData'),
        JARVIS_CLI_EXE: resolveCliExePath(),
        JARVIS_NODE_PATH: path.join(path.dirname(process.execPath), 'node_modules'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    backendProcess = child

    const stdout = readline.createInterface({ input: child.stdout })
    stdout.on('line', line => {
      const match = line.match(/https?:\/\/\S+/)
      if (!match) {
        return
      }
      backendUrl = match[0]
      backendState = {
        ready: true,
        url: backendUrl,
      }
      broadcastBackendState()
      void startEventBridge()
      resolve(backendUrl)
      stdout.close()
    })

    child.stderr.on('data', chunk => {
      const message = chunk.toString()
      if (!message.trim()) {
        return
      }
      backendState = {
        ready: false,
        url: backendUrl,
        error: message.trim(),
      }
      broadcastBackendState()
    })

    child.on('exit', code => {
      backendProcess = null
      backendReadyPromise = null
      backendUrl = null
      eventStreamAbort?.abort()
      eventStreamAbort = null
      backendState = {
        ready: false,
        url: null,
        error: `Jarvis worker exited with code ${code ?? 0}.`,
      }
      broadcastBackendState()
    })

    child.on('error', error => {
      backendReadyPromise = null
      backendState = {
        ready: false,
        url: null,
        error: String(error),
      }
      broadcastBackendState()
      reject(error)
    })
  })

  return backendReadyPromise
}

async function backendJson<T>(
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const baseUrl = await ensureBackend()
  const response = await fetch(new URL(pathname, baseUrl), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) {
    throw new Error(await response.text())
  }
  return (await response.json()) as T
}

async function backendPost<T>(
  pathname: string,
  payload?: unknown,
): Promise<T> {
  return backendJson<T>(pathname, {
    method: 'POST',
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
}

async function startEventBridge(): Promise<void> {
  if (!backendUrl || eventStreamAbort) {
    return
  }

  const abort = new AbortController()
  eventStreamAbort = abort

  try {
    const response = await fetch(new URL('/api/events', backendUrl), {
      signal: abort.signal,
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    })
    if (!response.ok || !response.body) {
      throw new Error(`Event stream failed with ${response.status}.`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLines = chunk
          .split('\n')
          .filter(line => line.startsWith('data: '))
          .map(line => line.slice(6))
        if (dataLines.length > 0) {
          try {
            broadcastEvent(JSON.parse(dataLines.join('\n')))
          } catch {}
        }
        boundary = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    if (!abort.signal.aborted) {
      backendState = {
        ready: false,
        url: backendUrl,
        error: error instanceof Error ? error.message : String(error),
      }
      broadcastBackendState()
      eventStreamAbort = null
      setTimeout(() => {
        if (backendProcess) {
          void startEventBridge()
        }
      }, 1_000)
    }
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 900,
    minHeight: 600,
    transparent: true,
    backgroundColor: '#151515',
    ...(process.platform === 'darwin'
      ? { vibrancy: 'under-window' as const }
      : {}),
    titleBarStyle: 'hidden',
    title: 'Jarvis',
    frame: false,
    show: false,
    webPreferences: {
      preload: getPreloadEntry(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  void win.loadFile(getRendererEntry())
  return win
}

ipcMain.handle('jarvis:bootstrap', async () => {
  const [config, shell, features, models] = await Promise.all([
    backendJson('/api/config'),
    backendJson('/api/shell'),
    backendJson('/api/features'),
    backendJson('/api/models'),
  ])
  return { config, shell, features, models }
})

ipcMain.handle('jarvis:get-config', () => backendJson('/api/config'))
ipcMain.handle('jarvis:save-config', (_event, payload: Partial<LauncherConfig>) =>
  backendPost('/api/config', payload),
)
ipcMain.handle('jarvis:get-shell', () => backendJson('/api/shell'))
ipcMain.handle('jarvis:save-shell', (_event, payload: unknown) =>
  backendPost('/api/shell', payload),
)
ipcMain.handle('jarvis:get-features', () => backendJson('/api/features'))
ipcMain.handle('jarvis:get-models', () => backendJson('/api/models'))
ipcMain.handle('jarvis:check-remote-health', (_event, payload: unknown) =>
  backendPost('/api/remote-health', payload),
)
ipcMain.handle('jarvis:start-session', (_event, payload: unknown) =>
  backendPost('/api/session/start', payload),
)
ipcMain.handle('jarvis:send-prompt', (_event, content: string) =>
  backendPost('/api/session/send', { content }),
)
ipcMain.handle('jarvis:interrupt-session', () =>
  backendPost('/api/session/interrupt'),
)
ipcMain.handle('jarvis:stop-session', () => backendPost('/api/session/stop'))
ipcMain.handle('jarvis:clear-transcript', (_event, payload: unknown) =>
  backendPost('/api/transcript/clear', payload),
)
ipcMain.handle(
  'jarvis:respond-to-permission',
  (_event, requestId: string, decision: 'allow' | 'deny', permanent?: boolean) =>
    backendPost('/api/session/permission', { requestId, decision, permanent: permanent === true }),
)
ipcMain.handle('jarvis:list-companion-profiles', () =>
  backendJson('/api/companion/profiles'),
)
ipcMain.handle(
  'jarvis:run-companion-action',
  (_event, action: string) => backendPost(`/api/companion/${action}`),
)
ipcMain.handle('jarvis:create-companion-profile', (_event, profile: unknown) =>
  backendPost('/api/companion/profile/create', { profile }),
)
ipcMain.handle(
  'jarvis:update-companion-profile',
  (_event, profileId: string, profile: unknown) =>
    backendPost('/api/companion/profile/update', { profileId, profile }),
)
ipcMain.handle('jarvis:select-companion-profile', (_event, profileId: string) =>
  backendPost('/api/companion/profile/select', { profileId }),
)
ipcMain.handle('jarvis:delete-companion-profile', (_event, profileId: string) =>
  backendPost('/api/companion/profile/delete', { profileId }),
)
ipcMain.handle('jarvis:minimize-window', () => {
  BrowserWindow.getFocusedWindow()?.minimize()
})
ipcMain.handle('jarvis:maximize-window', () => {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) {
    return
  }
  if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }
})
ipcMain.handle('jarvis:close-window', () => {
  BrowserWindow.getFocusedWindow()?.close()
})
ipcMain.handle('jarvis:get-platform', () => process.platform)
ipcMain.handle('jarvis:get-sandbox-status', () => backendJson('/api/sandbox/status'))

// ── Drive setup wizard IPC handlers ─────────────────────────────────────────
ipcMain.handle('jarvis:drive-status', () =>
  backendJson('/api/drive/status'),
)
ipcMain.handle('jarvis:drive-save-credentials', (_event, path: string) =>
  backendPost('/api/drive/setup/credentials', { path }),
)
// Drive OAuth is handled entirely in the Electron main process so that
// Chromium's networking stack (full Windows cert store + proxy support)
// is used for all HTTPS calls — avoiding TLS issues with the Bun binary.
ipcMain.handle('jarvis:drive-authorize', async () => {
  // 1. Get auth params from backend (client_id, client_secret, auth URL)
  const params = await backendJson<{
    authUrl: string
    clientId: string
    clientSecret: string
    redirectUri: string
    tokenPath: string
  }>('/api/drive/auth-params')

  // 2. Spin up a local Node HTTP server on 8765 to receive the OAuth callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost:8765')
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404)
        res.end()
        return
      }
      const error = url.searchParams.get('error')
      const authCode = url.searchParams.get('code')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<html><body style="font-family:sans-serif;padding:40px">' +
        (authCode
          ? '<h2>Authorization successful!</h2><p>Jarvis is connected to Google Drive. You can close this tab.</p>'
          : `<h2>Authorization denied.</h2><p>${error ?? 'Unknown error'}</p>`) +
        '</body></html>',
      )
      server.close()
      if (authCode) {
        resolve(authCode)
      } else {
        reject(new Error(`OAuth denied: ${error ?? 'unknown'}`))
      }
    })
    server.listen(8765, '127.0.0.1', () => {
      // 3. Open browser for Google sign-in
      void shell.openExternal(params.authUrl)
    })
    // 2-minute timeout
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('OAuth flow timed out after 2 minutes.'))
    }, 120_000)
    server.on('close', () => clearTimeout(timeout))
    server.on('error', (err) => reject(err))
  })

  // 4. Exchange auth code for tokens using Node https (Chromium cert store)
  const token = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const body = new URLSearchParams({
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    }).toString()
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => { data += chunk.toString() })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`Token exchange failed (${res.statusCode}): ${data}`))
            } else {
              const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600
              resolve({
                access_token: parsed.access_token,
                refresh_token: parsed.refresh_token,
                expires_at: Date.now() + expiresIn * 1000 - 60_000,
                token_type: parsed.token_type ?? 'Bearer',
                scope: parsed.scope ?? '',
              })
            }
          } catch {
            reject(new Error(`Failed to parse token response: ${data}`))
          }
        })
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })

  // 5. Send the completed token to the Bun backend to save + init Drive folders
  return backendPost('/api/drive/setup/token', token)
})

// Register Thunder Compute IPC handlers
registerThunderIpc(() => mainWindow)

app.whenReady().then(async () => {
  await ensureUserDataReady()
  mainWindow = createWindow()
  void ensureBackend()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
  }
})

app.on('before-quit', () => {
  eventStreamAbort?.abort()
  eventStreamAbort = null
  if (backendProcess) {
    backendProcess.kill()
    backendProcess = null
  }
})
