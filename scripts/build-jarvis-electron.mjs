import { spawnSync } from 'child_process'
import { copyFile, cp, mkdir, rm, writeFile } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const outDir = path.join(repoRoot, 'dist-jarvis')
const rendererOutDir = path.join(outDir, 'renderer')
const thunderOutDir = path.join(outDir, 'thunder')
const bridgeRuntimeOutDir = path.join(outDir, 'server', 'remote_glm_bridge')
const distDesktopDir = path.join(repoRoot, 'dist-desktop')
const electronPackageOutDir = path.join(distDesktopDir, 'electron')
const shouldPackage = process.argv.includes('--package')
const remoteBridgeRuntimeFiles = [
  '__init__.py',
  'config.py',
  'glm_backend.py',
  'main.py',
  'protocol.py',
  'requirements.txt',
  'schemas.py',
  'session_store.py',
]

// Native modules that cannot be bundled by esbuild
const NATIVE_EXTERNALS = ['node-pty', 'ssh2']

// bun:bundle is a Bun compile-time macro — shim it for esbuild builds.
const BUN_BUNDLE_ALIAS = {
  'bun:bundle': path.join(repoRoot, 'utils', 'bunBundleShim.ts'),
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command.endsWith('.cmd'),
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`)
  }
}

function tryRunCommand(command, args, label) {
  try {
    runCommand(command, args)
  } catch (error) {
    console.warn(`[jarvis-build] ${label} skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function toPowerShellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function stopRunningPackagedWindowsProcesses() {
  if (process.platform !== 'win32') {
    return
  }

  const distDesktopDirQuoted = toPowerShellSingleQuoted(
    `${distDesktopDir}${path.sep}`,
  )
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$distDesktopDir = ${distDesktopDirQuoted}`,
    '$matches = Get-Process | Where-Object {',
    '  $_.Path -and $_.Path.StartsWith($distDesktopDir, [System.StringComparison]::OrdinalIgnoreCase)',
    '}',
    'foreach ($proc in $matches) {',
    '  Write-Host "[jarvis-build] Stopping locked process $($proc.ProcessName) ($($proc.Id)) from $($proc.Path)"',
    '}',
    '$matches | Stop-Process -Force',
  ].join('; ')

  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], {
    cwd: repoRoot,
    stdio: 'inherit',
  })

  if (result.error) {
    console.warn(
      `[jarvis-build] Could not stop packaged processes: ${result.error.message}`,
    )
  }
}

await rm(outDir, { recursive: true, force: true })
await mkdir(rendererOutDir, { recursive: true })
await mkdir(thunderOutDir, { recursive: true })
await mkdir(bridgeRuntimeOutDir, { recursive: true })
await mkdir(distDesktopDir, { recursive: true })

await build({
  entryPoints: [path.join(repoRoot, 'desktop-electron', 'main.ts')],
  outfile: path.join(outDir, 'main.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron', ...NATIVE_EXTERNALS],
  alias: BUN_BUNDLE_ALIAS,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

await build({
  entryPoints: [path.join(repoRoot, 'desktop-electron', 'preload.ts')],
  outfile: path.join(outDir, 'preload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  alias: BUN_BUNDLE_ALIAS,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

const rendererOutFile = path.join(rendererOutDir, 'main.js')

await build({
  entryPoints: [path.join(repoRoot, 'desktop-electron', 'renderer', 'main.tsx')],
  outfile: rendererOutFile,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome124',
  jsx: 'automatic',
  alias: BUN_BUNDLE_ALIAS,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

// Thunder terminal preload (separate BrowserWindow)
await build({
  entryPoints: [path.join(repoRoot, 'desktop-electron', 'thunder', 'terminalPreload.ts')],
  outfile: path.join(thunderOutDir, 'terminalPreload.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  alias: BUN_BUNDLE_ALIAS,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

// Thunder terminal renderer (xterm.js in browser)
await build({
  entryPoints: [path.join(repoRoot, 'desktop-electron', 'thunder', 'terminalRenderer.ts')],
  outfile: path.join(thunderOutDir, 'terminalRenderer.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome124',
  alias: BUN_BUNDLE_ALIAS,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
})

await copyFile(
  path.join(repoRoot, 'desktop-electron', 'renderer', 'index.html'),
  path.join(rendererOutDir, 'index.html'),
)
await copyFile(
  path.join(repoRoot, 'desktop-electron', 'renderer', 'styles.css'),
  path.join(rendererOutDir, 'styles.css'),
)

// Copy external stylesheets (e.g. glass.css)
try {
  await cp(
    path.join(repoRoot, 'desktop-electron', 'renderer', 'styles'),
    path.join(rendererOutDir, 'styles'),
    { recursive: true }
  )
} catch (e) {
  // Ignored if styles directory doesn't exist
}

// Thunder terminal HTML
await copyFile(
  path.join(repoRoot, 'desktop-electron', 'thunder', 'terminal.html'),
  path.join(thunderOutDir, 'terminal.html'),
)

for (const file of remoteBridgeRuntimeFiles) {
  await copyFile(
    path.join(repoRoot, 'server', 'remote_glm_bridge', file),
    path.join(bridgeRuntimeOutDir, file),
  )
}

// Copy native node modules so they're available at runtime
for (const mod of NATIVE_EXTERNALS) {
  const src = path.join(repoRoot, 'node_modules', mod)
  const dest = path.join(outDir, 'node_modules', mod)
  try {
    await cp(src, dest, { recursive: true })
  } catch (err) {
    console.warn(`[jarvis-build] Could not copy ${mod}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ssh2 depends on cpu-features and asn1 — copy its transitive native deps too
const ssh2Deps = ['cpu-features']
for (const dep of ssh2Deps) {
  const src = path.join(repoRoot, 'node_modules', dep)
  const dest = path.join(outDir, 'node_modules', dep)
  try {
    await cp(src, dest, { recursive: true })
  } catch {
    // Optional native dep, skip if missing
  }
}

await writeFile(
  path.join(outDir, 'package.json'),
  JSON.stringify(
    {
      name: 'jarvis-desktop',
      version: '0.1.0',
      description: 'Jarvis desktop shell for the Claude-derived coding workspace.',
      author: 'Jarvis',
      main: 'main.cjs',
    },
    null,
    2,
  ),
  'utf8',
)

if (process.platform === 'win32') {
  runCommand('bun', [
    'build',
    '--compile',
    '--windows-hide-console',
    '--windows-title',
    'Jarvis Worker',
    '--windows-description',
    'Jarvis background runtime worker',
    '--outfile',
    path.join(distDesktopDir, 'JarvisWorker.exe'),
    'desktop-app/launcher.ts',
  ])

  tryRunCommand('bun', [
    'build',
    '--compile',
    '--windows-hide-console',
    '--windows-title',
    'Claude Code CLI',
    '--windows-description',
    'Headless Claude Code worker for Jarvis',
    '--outfile',
    path.join(distDesktopDir, 'ClaudeCodeCli.exe'),
    // Dead-code-eliminate ant-only conditional requires
    '--define', 'process.env.USER_TYPE="external"',
    '--define', 'process.env.CLAUDE_CODE_VERIFY_PLAN="false"',
    '--define', 'process.env.DEV="false"',
    '--define', 'process.env.NODE_ENV="production"',
    // Optional npm packages — fail gracefully at runtime if unused
    '--external', 'asciichart',
    '--external', 'turndown',
    '--external', 'sharp',
    // vscode-jsonrpc: kept external because bun bundling it causes ESM/CJS
    // hoisting conflicts with the AWS SDK packages (undici version clash).
    // Instead, ship it alongside the binary via electron-builder extraFiles
    // and inject NODE_PATH so the binary finds it at runtime.
    '--external', 'vscode-jsonrpc',
    '--external', '@opentelemetry/exporter-metrics-otlp-grpc',
    '--external', '@opentelemetry/exporter-metrics-otlp-http',
    '--external', '@opentelemetry/exporter-metrics-otlp-proto',
    '--external', '@opentelemetry/exporter-prometheus',
    '--external', '@opentelemetry/exporter-logs-otlp-grpc',
    '--external', '@opentelemetry/exporter-logs-otlp-http',
    '--external', '@opentelemetry/exporter-logs-otlp-proto',
    '--external', '@opentelemetry/exporter-trace-otlp-grpc',
    '--external', '@opentelemetry/exporter-trace-otlp-http',
    '--external', '@opentelemetry/exporter-trace-otlp-proto',
    '--external', '@anthropic-ai/mcpb',
    '--external', 'modifiers-napi',
    'entrypoints/cli.tsx',
  ], 'ClaudeCodeCli.exe compile')
}

if (shouldPackage) {
  if (process.platform === 'win32') {
    stopRunningPackagedWindowsProcesses()
    await rm(electronPackageOutDir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 250,
    })
    await mkdir(electronPackageOutDir, { recursive: true })
  }

  runCommand(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
    'electron-builder',
    '--config',
    'electron-builder.json',
  ])

  if (process.platform === 'win32') {
    await writeFile(
      path.join(distDesktopDir, 'Jarvis.cmd'),
      [
        '@echo off',
        'set "SCRIPT_DIR=%~dp0"',
        'start "" "%SCRIPT_DIR%electron\\win-unpacked\\Jarvis.exe"',
        '',
      ].join('\r\n'),
      'utf8',
    )
  }
}
