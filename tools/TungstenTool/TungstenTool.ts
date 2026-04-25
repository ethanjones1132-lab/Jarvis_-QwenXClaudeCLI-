/**
 * TungstenTool — Tmux-based virtual terminal management for Claude Code.
 *
 * Uses Claude's isolated tmux socket (see utils/tmuxSocket.ts) to create,
 * manage, and observe terminal panes. Only available when USER_TYPE === 'ant'.
 *
 * Architectural notes:
 * - NOT concurrency-safe: uses a singleton virtual terminal abstraction that
 *   conflicts between agents (see constants/tools.ts:96).
 * - Does NOT define an outputSchema (Tool.ts:398 notes this explicitly).
 * - Tracks which sessions have used Tungsten for cleanup via /clear caches.
 * - Marks tmux as "used" so Shell.ts initializes the socket for subsequent
 *   Bash commands (tmuxSocket.ts:184).
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  checkTmuxAvailable,
  ensureSocketInitialized,
  getClaudeSocketName,
  markTmuxToolUsed,
} from '../../utils/tmuxSocket.js'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { logForDebugging } from '../../utils/debug.js'
import { getPlatform } from '../../utils/platform.js'

// ── State tracking ──────────────────────────────────────────────────────────

/** Sessions that have used TungstenTool (for cleanup). */
const sessionsWithTungstenUsage = new Set<string>()

/** Whether TungstenTool has been initialized in this process. */
let initialized = false

export function clearSessionsWithTungstenUsage(): void {
  sessionsWithTungstenUsage.clear()
}

export function resetInitializationState(): void {
  initialized = false
}

// ── Tmux helpers ────────────────────────────────────────────────────────────

async function execTmuxCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const socket = getClaudeSocketName()
  const fullArgs = ['-L', socket, ...args]

  if (getPlatform() === 'windows') {
    // Route through WSL — `-e` execs tmux directly without the login shell.
    // Without it, bash eats `#` as a comment in display-message templates.
    const result = await execFileNoThrow('wsl', ['-e', 'tmux', ...fullArgs], {
      env: { ...process.env, WSL_UTF8: '1' },
    })
    return {
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      code: result.code ?? 1,
    }
  }
  const result = await execFileNoThrow('tmux', fullArgs)
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    code: result.code ?? 1,
  }
}

async function listSessions(): Promise<string[]> {
  const result = await execTmuxCommand([
    'list-sessions',
    '-F',
    '#{session_name}',
  ])
  if (result.code !== 0) return []
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
}

async function listPanes(
  sessionName: string,
): Promise<{ paneId: string; title: string; active: boolean }[]> {
  const result = await execTmuxCommand([
    'list-panes',
    '-t',
    sessionName,
    '-F',
    '#{pane_id}\t#{pane_title}\t#{pane_active}',
  ])
  if (result.code !== 0) return []
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [paneId, title, active] = line.split('\t')
      return { paneId: paneId!, title: title ?? '', active: active === '1' }
    })
}

async function capturePane(
  target: string,
  lines?: number,
): Promise<string> {
  const args = [
    'capture-pane',
    '-t',
    target,
    '-p', // print to stdout
    '-J', // join wrapped lines
  ]
  if (lines !== undefined) {
    args.push('-S', `-${lines}`)
  }
  const result = await execTmuxCommand(args)
  return result.code === 0 ? result.stdout : ''
}

async function sendKeys(target: string, keys: string): Promise<boolean> {
  const result = await execTmuxCommand(['send-keys', '-t', target, keys, 'Enter'])
  return result.code === 0
}

// ── Schema ──────────────────────────────────────────────────────────────────

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum([
        'create_session',
        'list_sessions',
        'create_pane',
        'list_panes',
        'send_keys',
        'capture',
        'kill_session',
      ])
      .describe('The tmux action to perform.'),
    session_name: z
      .string()
      .optional()
      .describe('Target session name. Required for most actions.'),
    command: z
      .string()
      .optional()
      .describe(
        'For send_keys: the text/command to send. For create_session/create_pane: optional initial command.',
      ),
    pane_target: z
      .string()
      .optional()
      .describe('Pane target (e.g. "%0"). Used by send_keys, capture.'),
    lines: z
      .number()
      .optional()
      .describe('Number of scrollback lines to capture. Default: full buffer.'),
    direction: z
      .enum(['horizontal', 'vertical'])
      .optional()
      .describe('Split direction for create_pane. Default: vertical.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const TOOL_NAME = 'Tungsten'

const DESCRIPTION =
  'Manage tmux virtual terminal sessions, panes, and capture output in Claude\'s isolated socket.'

const PROMPT = `Use this tool to create and manage tmux terminal sessions for running long-lived processes, observing output, and managing concurrent terminal environments.

Actions:
- create_session: Create a new named tmux session. Optionally run a command.
- list_sessions: List all active tmux sessions on Claude's socket.
- create_pane: Split the current window to create a new pane.
- list_panes: List panes in a session.
- send_keys: Send keystrokes/commands to a specific pane.
- capture: Capture visible output from a pane.
- kill_session: Terminate a tmux session.

All operations use Claude's isolated tmux socket. They will NOT affect the user's own tmux sessions.`

// ── Tool implementation ─────────────────────────────────────────────────────

export const TungstenTool = buildTool({
  name: TOOL_NAME,
  searchHint: 'tmux terminal pane session management',
  maxResultSizeChars: 200_000,
  shouldDefer: false,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isEnabled() {
    return process.env.USER_TYPE === 'ant'
  },

  isConcurrencySafe() {
    // Singleton virtual terminal abstraction conflicts between agents.
    return false
  },

  isReadOnly(input) {
    return input.action === 'list_sessions' ||
      input.action === 'list_panes' ||
      input.action === 'capture'
  },

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    return PROMPT
  },

  async checkPermissions(input, _context) {
    return { behavior: 'allow' as const, updatedInput: input }
  },

  async call(input, context) {
    // Ensure tmux is available
    const available = await checkTmuxAvailable()
    if (!available) {
      return {
        data: {
          error: 'tmux is not installed or not available. TungstenTool requires tmux.',
        },
      }
    }

    // Mark tmux as used so Shell.ts initializes the socket
    markTmuxToolUsed()

    // Ensure socket is initialized
    await ensureSocketInitialized()

    if (!initialized) {
      initialized = true
      logForDebugging('[Tungsten] First use in this process — socket initialized.')
    }

    // Track session usage for cleanup
    if (context.sessionId) {
      sessionsWithTungstenUsage.add(context.sessionId)
    }

    const { action } = input

    switch (action) {
      case 'create_session': {
        const name = input.session_name ?? `cc-${Date.now()}`
        const args = ['new-session', '-d', '-s', name]
        if (input.command) {
          args.push(input.command)
        }
        const result = await execTmuxCommand(args)
        if (result.code !== 0) {
          return { data: { error: `Failed to create session "${name}": ${result.stderr}` } }
        }
        return { data: { session: name, status: 'created' } }
      }

      case 'list_sessions': {
        const sessions = await listSessions()
        return { data: { sessions } }
      }

      case 'create_pane': {
        const session = input.session_name ?? 'base'
        const splitFlag = input.direction === 'horizontal' ? '-h' : '-v'
        const args = ['split-window', splitFlag, '-t', session]
        if (input.command) {
          args.push(input.command)
        }
        const result = await execTmuxCommand(args)
        if (result.code !== 0) {
          return { data: { error: `Failed to create pane in "${session}": ${result.stderr}` } }
        }
        const panes = await listPanes(session)
        return { data: { session, panes, status: 'pane_created' } }
      }

      case 'list_panes': {
        const session = input.session_name ?? 'base'
        const panes = await listPanes(session)
        return { data: { session, panes } }
      }

      case 'send_keys': {
        const target = input.pane_target ?? input.session_name ?? 'base'
        const keys = input.command
        if (!keys) {
          return { data: { error: 'send_keys requires a "command" parameter.' } }
        }
        const ok = await sendKeys(target, keys)
        if (!ok) {
          return { data: { error: `Failed to send keys to "${target}".` } }
        }
        return { data: { target, status: 'keys_sent' } }
      }

      case 'capture': {
        const target = input.pane_target ?? input.session_name ?? 'base'
        const output = await capturePane(target, input.lines)
        return { data: { target, output } }
      }

      case 'kill_session': {
        const session = input.session_name
        if (!session) {
          return { data: { error: 'kill_session requires a "session_name" parameter.' } }
        }
        const result = await execTmuxCommand(['kill-session', '-t', session])
        if (result.code !== 0) {
          return { data: { error: `Failed to kill session "${session}": ${result.stderr}` } }
        }
        return { data: { session, status: 'killed' } }
      }

      default:
        return { data: { error: `Unknown action: ${action}` } }
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
    }
  },

  userFacingName() {
    return 'Tungsten (Tmux)'
  },

  toAutoClassifierInput(input) {
    return `Tungsten ${input.action} ${input.session_name ?? ''} ${input.command ?? ''}`.trim()
  },
} satisfies ToolDef<InputSchema, unknown>)
