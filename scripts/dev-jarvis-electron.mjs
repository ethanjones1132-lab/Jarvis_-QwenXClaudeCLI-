import { spawn } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

await import('./build-jarvis-electron.mjs')

function resolveElectronCommand() {
  if (process.platform === 'win32') {
    const directBinary = path.join(repoRoot, 'node_modules', '.bin', 'electron.exe')
    if (existsSync(directBinary)) {
      return directBinary
    }
    return path.join(repoRoot, 'node_modules', '.bin', 'electron.cmd')
  }

  const unixBinary = path.join(repoRoot, 'node_modules', '.bin', 'electron')
  return existsSync(unixBinary) ? unixBinary : 'npx'
}

const electronCommand = resolveElectronCommand()
const electronArgs =
  electronCommand === 'npx'
    ? ['electron', path.join(repoRoot, 'dist-jarvis', 'main.cjs')]
    : [path.join(repoRoot, 'dist-jarvis', 'main.cjs')]

const child = spawn(
  electronCommand,
  electronArgs,
  {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32' && electronCommand.endsWith('.cmd'),
    env: {
      ...process.env,
      JARVIS_REPO_ROOT: repoRoot,
    },
  },
)

child.on('exit', code => {
  process.exit(code ?? 0)
})
