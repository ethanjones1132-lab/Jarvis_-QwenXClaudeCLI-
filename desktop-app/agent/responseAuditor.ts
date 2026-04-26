import { readFileSync, existsSync } from 'fs'

/**
 * responseAuditor.ts
 *
 * Two-phase auditing for the Jarvis agentic loop:
 *
 * Phase A — Pre-flight (before execution):
 *   Catch bad arguments before the tool fires. Validates WebSearch queries for
 *   specificity, WebFetch URLs for placeholders, Edit paths for existence, etc.
 *   Returns a blocking repair message without executing the tool.
 *
 * Phase B — Post-execution (after the tool runs):
 *   Audits tool results for known failure patterns and appends correction hints
 *   to the OBSERVATION so the model's next THOUGHT has explicit recovery guidance.
 *
 * Dead-end detection:
 *   Tracks consecutive failure count across tool calls. When 3+ consecutive
 *   failures occur, injects an escalation hint directing Jarvis to surface the
 *   problem to the user rather than continuing to spin.
 */

export interface AuditResult {
  /** Whether the tool result looks clean */
  pass: boolean
  /** Short description of the detected issue */
  issue?: string
  /** Hint injected after the raw tool output in the OBSERVATION */
  correctionHint?: string
}

export interface PreflightResult {
  /** Whether the tool call should be allowed to proceed */
  allow: boolean
  /** Blocking message to inject as the tool result if not allowed */
  blockMessage?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase A: Pre-flight validation
// ─────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = [
  /your_api_key/i,
  /your_key/i,
  /example\.com/i,
  /\byour_\w+/i,
  /\<your[\w_]+\>/i,
  /insert.*key.*here/i,
  /api_key_here/i,
  // Curly-brace template literals that the model forgot to fill in:
  // e.g. {latitude}, {longitude}, {city}, {api_key}, {user_id}
  /\{[a-zA-Z_][a-zA-Z0-9_]*\}/,
]

const VAGUE_QUERY_PATTERNS = [
  /^current weather$/i,
  /^weather$/i,
  /^news$/i,
  /^today$/i,
  /^search$/i,
]

/**
 * Pre-flight check — runs BEFORE the tool executes.
 * Returns { allow: false, blockMessage } to prevent execution with a repair hint,
 * or { allow: true } to proceed.
 */
export function preflightCheck(
  toolName: string,
  args: Record<string, unknown>,
): PreflightResult {
  switch (toolName) {
    case 'WebSearch': {
      const query = String(args.query ?? '').trim()

      // Block self-referential/capability questions — these should be answered from
      // CheckDriveStatus or system knowledge, not by searching the web.
      const META_QUERY_PATTERNS = [
        /^(can you|do you|are you|could you)\s+(access|use|browse|search|reach|connect)/i,
        /^(what can you|what tools|what are your capabilities)/i,
        /^(check|test|verify)\s+(your|the)\s+(connection|internet|web|tools|access)/i,
        /^(do you have|have you got)\s+(web|internet|search|online)\s+(access|connection)/i,
      ]
      if (META_QUERY_PATTERNS.some(p => p.test(query))) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] "${query}" is a question about your own capabilities, not a web search.\n\n` +
            `Use CheckDriveStatus (no arguments) to get your live runtime status, ` +
            `then answer directly from the report. Do not use WebSearch for self-status checks.`,
        }
      }

      // Block overly vague queries that will return nothing
      if (VAGUE_QUERY_PATTERNS.some(p => p.test(query))) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] WebSearch query "${query}" is too vague and will return no useful results.\n\n` +
            `Think about what the user actually asked for:\n` +
            `- If they asked about weather: use Bash with \`curl.exe -s "wttr.in/?format=3"\`\n` +
            `- If they asked a specific question: add location, date, entity name, or full question to the query\n` +
            `- If they asked about your own capabilities: use CheckDriveStatus (no arguments) and answer directly\n` +
            `Retry with a specific query relevant to the user's actual request.`,
        }
      }

      // Block queries with placeholder text
      if (PLACEHOLDER_PATTERNS.some(p => p.test(query))) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] WebSearch query contains a placeholder value: "${query}".\n` +
            `Replace the placeholder with the actual search terms before retrying.`,
        }
      }

      // Warn if query is suspiciously short (< 3 words and not clearly specific)
      if (query.split(/\s+/).length < 2 && query.length < 10) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] WebSearch query "${query}" has only one word and is unlikely to return useful results.\n` +
            `Add more specific context: location, time, full question, or entity name.`,
        }
      }
      return { allow: true }
    }

    case 'WebFetch': {
      const url = String(args.url ?? '').trim()

      // Block URLs with placeholder API keys or obvious template literals
      if (PLACEHOLDER_PATTERNS.some(p => p.test(url))) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] WebFetch URL contains a placeholder value: "${url}".\n\n` +
            `This URL has unfilled template variables (like "your_api_key" or "example.com").\n` +
            `Options:\n` +
            `1. If you need weather: use Bash with \`curl.exe -s "wttr.in/?format=3"\` — no key needed.\n` +
            `2. If you need a real API: ask the user to provide the actual endpoint and credentials.\n` +
            `3. Use WebSearch with a specific query instead of fetching a URL directly.`,
        }
      }

      // Block localhost unless it's a known local service (Ollama, etc.)
      if (/localhost|127\.0\.0\.1/.test(url) && !/(:11434|:8080|:3000)/.test(url)) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] WebFetch URL "${url}" points to localhost with an unusual port.\n` +
            `Known local services: Ollama at :11434. If you intended a different local service, verify it is running first with Bash.`,
        }
      }

      // Block URLs with very long query strings — these are usually auto-constructed
      // from memory and almost never resolve correctly (e.g. weather.com canonical IDs,
      // timeanddate.com city paths). Use WebSearch first, then WebFetch a found URL.
      const queryString = url.includes('?') ? url.split('?')[1] ?? '' : ''
      if (queryString.length > 80) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] WebFetch URL has a very long query string that looks auto-generated: "${url.slice(0, 140)}"\n\n` +
            `Constructed URLs are almost always wrong. Options:\n` +
            `1. Use WebSearch to find a real URL, then WebFetch it\n` +
            `2. For weather: Bash → \`curl.exe -s "wttr.in/?format=3"\`\n` +
            `3. For Wikipedia: WebFetch https://en.wikipedia.org/wiki/[Topic]`,
        }
      }

      return { allow: true }
    }

    case 'Edit': {
      const filePath = String(args.file_path ?? args.path ?? '').trim()
      if (!filePath) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] Edit requires file_path but it is empty or missing.\n` +
            `Use Glob to find the correct file path first, then retry Edit with the exact path.`,
        }
      }
      if (!filePath.includes('\\') && !filePath.includes('/')) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] Edit path "${filePath}" looks like a bare filename, not an absolute path.\n` +
            `Use Glob to find the full absolute path first, then retry Edit.`,
        }
      }
      // Verify old_string is actually present in the file before the edit fires.
      // An Edit with an old_string that doesn't exist is a silent no-op — the model
      // will think it succeeded but the file won't change.
      const oldString = String(args.old_string ?? '').trim()
      if (oldString && existsSync(filePath)) {
        try {
          const fileContent = readFileSync(filePath, 'utf8')
          if (!fileContent.includes(oldString)) {
            return {
              allow: false,
              blockMessage:
                `[PREFLIGHT BLOCK] Edit old_string not found in file "${filePath}".\n\n` +
                `The exact text you provided to replace does not exist in the file. ` +
                `This edit would be a silent no-op.\n\n` +
                `Steps to fix:\n` +
                `1. Use Read to see the file's current content\n` +
                `2. Copy the exact text you want to replace (including whitespace/indentation)\n` +
                `3. Retry Edit with the corrected old_string`,
            }
          }
        } catch {
          // If we can't read the file, let Edit handle the error itself
        }
      }
      return { allow: true }
    }

    case 'Write': {
      const filePath = String(args.file_path ?? args.path ?? '').trim()
      if (!filePath) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] Write requires file_path but it is empty.\n` +
            `Provide the full absolute path where you want to create the file.`,
        }
      }
      return { allow: true }
    }

    case 'Bash': {
      const command = String(args.command ?? '').trim()
      if (command.length < 3) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] Bash command "${command}" is too short to be valid.\n` +
            `Provide a complete shell command.`,
        }
      }
      // Block dangerous destructive commands — must be explicit
      if (/rm\s+-rf\s+\/(?!tmp|temp)/i.test(command) || /format\s+[a-z]:/i.test(command)) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] This Bash command appears destructive and was blocked: "${command.slice(0, 80)}".\n` +
            `If this is intentional, ask the user to confirm before executing.`,
        }
      }
      // On Windows PowerShell, bare `curl` is an alias for Invoke-WebRequest with
      // different syntax. Always require `curl.exe` for HTTP requests.
      // Auto-correct rather than block — avoids an unnecessary loop iteration.
      if (/\bcurl\s/.test(command) && !/\bcurl\.exe\s/.test(command)) {
        const fixed = command.replace(/\bcurl\s/, 'curl.exe ')
        ;(args as Record<string, unknown>)['command'] = fixed
        // Allow the corrected command to proceed — no block needed
      }

      if (process.platform === 'win32') {
        const lookupMatch = command.match(/^(whereis|which)\s+(.+)$/i)
        if (lookupMatch) {
          const lookupTarget = lookupMatch[2]?.trim()
          if (lookupTarget) {
            ;(args as Record<string, unknown>)['command'] = `where.exe ${lookupTarget}`
          }
        }
      }
      return { allow: true }
    }

    case 'Glob': {
      const pattern = String(args.pattern ?? '').trim()
      // If the model passed an absolute path (no glob chars) as the pattern,
      // it probably meant to use ListDirectory or Read instead.
      if ((pattern.startsWith('C:\\') || pattern.startsWith('/')) && !/[*?[\]{}]/.test(pattern)) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] Glob pattern "${pattern.slice(0, 80)}" looks like an absolute path, not a glob pattern.\n\n` +
            `Glob requires a wildcard pattern like "**/*.txt" and an optional "path" argument.\n` +
            `- To list a directory: use ListDirectory with path="${pattern}"\n` +
            `- To find files by name: use Glob with pattern="**/*.txt" and path="${pattern}"`,
        }
      }
      return { allow: true }
    }

    case 'Grep': {
      const pattern = String(args.pattern ?? '').trim()
      if (!pattern) {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] Grep requires a pattern argument but none was provided.\n` +
            `Provide a regex or literal string to search for.`,
        }
      }
      // Catch obviously invalid regex that would crash ripgrep
      try {
        new RegExp(pattern)
      } catch {
        return {
          allow: false,
          blockMessage:
            `[PREFLIGHT BLOCK] Grep pattern "${pattern.slice(0, 60)}" is not a valid regular expression.\n` +
            `Fix the regex syntax, or use a plain literal string (no special chars needed for exact matches).`,
        }
      }
      return { allow: true }
    }

    default:
      return { allow: true }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dead-end escalation tracker
// ─────────────────────────────────────────────────────────────────────────────

// Patterns that indicate transient/environmental failures — not logic errors.
// These should not count toward the dead-end spiral threshold.
const TRANSIENT_ERROR_PATTERNS = [
  /fetch failed|network error|econnreset|econnrefused/i,
  /aborted|timed? ?out/i,
  /ENOTFOUND|ETIMEDOUT/i,
  /rate.?limit|too many requests|429/i,
  /service unavailable|503/i,
]

/**
 * Returns true if the result preview looks like a transient infrastructure
 * failure (network, timeout, rate-limit) rather than a logic error.
 * Used to avoid triggering dead-end escalation on connectivity blips.
 */
export function isTransientError(resultPreview: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some(p => p.test(resultPreview))
}

/**
 * Returns an escalation hint when too many consecutive tool failures are detected.
 * Call this after each tool step to check whether Jarvis should surface the
 * problem to the user instead of continuing to spiral.
 *
 * Transient errors (network timeouts, rate limits) are noted but do NOT count
 * toward the consecutive failure threshold — they are environmental, not logic bugs.
 */
export function checkDeadEnd(
  consecutiveFailures: number,
  toolSteps: Array<{ toolName: string; resultPreview: string; success: boolean }>,
): string | null {
  if (consecutiveFailures < 3) return null

  const failedTools = toolSteps
    .filter(s => !s.success)
    .slice(-3)
    .map(s => `${s.toolName}: ${s.resultPreview.slice(0, 80)}`)
    .join('\n')

  return (
    `\n\n[DEAD-END DETECTED] ${consecutiveFailures} consecutive tool failures. ` +
    `You are stuck in a failure loop. STOP attempting more tool calls.\n\n` +
    `Recent failures:\n${failedTools}\n\n` +
    `REQUIRED RESPONSE: Output a FINAL ANSWER that:\n` +
    `1. Tells the user what you tried and what failed\n` +
    `2. Asks for one specific piece of information that would unblock you\n` +
    `3. Does NOT attempt another tool call\n\n` +
    `Example: "FINAL ANSWER: I tried X, Y, and Z but hit [specific error]. ` +
    `Could you tell me [specific thing needed]?"`
  )
}

const FILE_NOT_FOUND = /(path does not exist|file does not exist|enoent|no such file or directory)/i
const PERMISSION_DENIED = /(permission denied|access denied|eacces)/i
const NON_ZERO_EXIT = /Exit code (?!0\b)(\d+)/i
// Matches both truly empty strings AND the sentinel "(no matches)" / "(no matches — ...)" strings
// that Grep/Glob return when the search finds nothing.
const EMPTY_RESULT = /^\s*$|^\(no matches/i

/**
 * Audits a single tool call result.
 *
 * @param toolName   The normalised tool name (e.g. "Read", "Bash", "Grep")
 * @param toolInput  The arguments that were passed to the tool
 * @param toolResult The raw output string returned by the tool executor
 */
export function auditToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolResult: string,
): AuditResult {
  // ── File-not-found on read/search tools ───────────────────────────────────
  if (['Read', 'Grep', 'Glob', 'ListDirectory'].includes(toolName) && FILE_NOT_FOUND.test(toolResult)) {
    const attemptedPath = toolInput['file_path'] ?? toolInput['path'] ?? toolInput['pattern'] ?? '(unknown)'
    return {
      pass: false,
      issue: 'file_not_found',
      correctionHint:
        `\n\n[AUDITOR] Path not found: "${attemptedPath}". ` +
        `Use Glob with a wildcard pattern to locate the correct path before trying again. ` +
        `Do not guess or reuse the same path.`,
    }
  }

  // ── Permission error ───────────────────────────────────────────────────────
  if (PERMISSION_DENIED.test(toolResult)) {
    return {
      pass: false,
      issue: 'permission_denied',
      correctionHint:
        `\n\n[AUDITOR] Permission denied. ` +
        `Do not retry the same path. Inform the user that elevated access is required.`,
    }
  }

  // ── Non-zero Bash exit code ────────────────────────────────────────────────
  if (toolName === 'Bash' && NON_ZERO_EXIT.test(toolResult)) {
    return {
      pass: false,
      issue: 'bash_nonzero_exit',
      correctionHint:
        `\n\n[AUDITOR] The command exited with a non-zero code. ` +
        `Read the error output above carefully. Fix the argument or command — ` +
        `do not retry the identical call.`,
    }
  }

  // ── Empty result from search tools (likely wrong pattern) ─────────────────
  if (['Grep', 'Glob'].includes(toolName) && EMPTY_RESULT.test(toolResult)) {
    const pattern = toolInput['pattern'] ?? toolInput['glob'] ?? '(unknown)'
    return {
      pass: false,
      issue: 'empty_search_result',
      correctionHint:
        `\n\n[AUDITOR] No results for pattern "${pattern}". ` +
        `Broaden the search — try a shorter keyword, remove path constraints, or switch tools (Glob ↔ Grep).`,
    }
  }

  // ── Write EEXIST — Windows/OneDrive junction quirk ────────────────────────
  if (toolName === 'Write' && /EEXIST/i.test(toolResult)) {
    const path = String(toolInput['file_path'] ?? toolInput['path'] ?? '').trim()
    return {
      pass: false,
      issue: 'write_eexist',
      correctionHint:
        `\n\n[AUDITOR] Write failed with EEXIST. The parent directory already exists — ` +
        `this is a Windows/OneDrive filesystem quirk. Retry using Bash:\n` +
        `\`New-Item -Path "${path || 'C:\\Users\\ethan\\Desktop\\new_file.txt'}" -ItemType File -Force\`\n` +
        `This creates the file even if the directory exists and is a OneDrive junction.`,
    }
  }

  // ── Write/Edit generic error ───────────────────────────────────────────────
  if (['Write', 'Edit'].includes(toolName) && /error|failed|invalid/i.test(toolResult)) {
    return {
      pass: false,
      issue: 'write_edit_error',
      correctionHint:
        `\n\n[AUDITOR] The ${toolName} operation reported an error. ` +
        `Read the target file first to confirm its current content, then retry with corrected arguments.`,
    }
  }

  // ── WebSearch returned no results ──────────────────────────────────────────
  // Fires when all backends (Brave/SearXNG/DDG) return empty.
  // NOTE: Do NOT default to weather here — weather suggestions confuse the model
  // when the user did not ask about weather at all. Give generic alternatives only.
  if (toolName === 'WebSearch' && !toolResult.trim()) {
    return {
      pass: false,
      issue: 'websearch_no_results',
      correctionHint:
        `\n\n[AUDITOR] WebSearch returned no results. Do NOT retry WebSearch. ` +
        `Think about what the user actually asked for and choose an alternative:\n` +
        `- If they asked about your capabilities: answer from CheckDriveStatus output or conversation history\n` +
        `- If they want a specific web page: use WebFetch with a known URL\n` +
        `- If they want system info: use Bash\n` +
        `- If they asked a factual question: answer from your training knowledge`,
    }
  }
  if (toolName === 'WebSearch' && /all search backends|no results — all/i.test(toolResult)) {
    return {
      pass: false,
      issue: 'websearch_all_backends_failed',
      correctionHint:
        `\n\n[AUDITOR] All WebSearch backends failed. Do NOT retry WebSearch on this turn. ` +
        `Re-read the user's original request and choose an alternative approach that matches what they actually asked for. ` +
        `Do NOT default to fetching weather unless the user specifically asked about weather.`,
    }
  }

  // ── WebFetch returned a 4xx client error ───────────────────────────────────
  // Usually means the URL was invented/guessed and doesn't actually exist.
  if (toolName === 'WebFetch' && /HTTP 4\d\d/.test(toolResult)) {
    const statusMatch = toolResult.match(/HTTP (\d+)/)
    const status = statusMatch?.[1] ?? '4xx'
    return {
      pass: false,
      issue: 'webfetch_client_error',
      correctionHint:
        `\n\n[AUDITOR] WebFetch returned HTTP ${status} — this URL does not exist or is blocked.\n` +
        `Do not retry the same URL. If you constructed this URL from memory, it is likely wrong.\n` +
        `Options:\n` +
        `1. Use WebSearch to find a real URL first, then WebFetch it\n` +
        `2. Weather: Bash → \`curl.exe -s "wttr.in/?format=3"\`\n` +
        `3. Wikipedia: WebFetch https://en.wikipedia.org/wiki/[Topic]`,
    }
  }

  return { pass: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Jaccard word similarity (stagnation helper)
// ─────────────────────────────────────────────────────────────────────────────

// Strip volatile tokens (timestamps, relative times, counts) before word
// comparison so a result that changes only in "updated 2 minutes ago" or
// "2026-04-19T12:34:56Z" doesn't falsely look like new content to the detector.
const VOLATILE_TOKEN_RE = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b|\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b|\b(?:just now|\d+\s+(?:second|minute|hour|day|week|month)s?\s+ago)\b/gi

function wordSet(text: string): Set<string> {
  return new Set(
    text.replace(VOLATILE_TOKEN_RE, ' ').toLowerCase().trim().split(/\s+/).filter(w => w.length > 2)
  )
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = wordSet(a)
  const setB = wordSet(b)
  if (setA.size === 0 && setB.size === 0) return 1
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const w of setA) {
    if (setB.has(w)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return intersection / union
}

/**
 * Detects semantic stagnation — same result returned multiple times
 * even if the tool call arguments or formatting differed slightly.
 *
 * Uses Jaccard word-level similarity (threshold 0.80) instead of prefix
 * comparison — catches "same results, different whitespace/ordering".
 * Volatile tokens (timestamps, relative dates) are stripped before comparison
 * so minor metadata changes don't mask genuine stagnation.
 */
export function detectResultStagnation(
  recentResults: string[],
  currentResult: string,
): string | null {
  if (recentResults.length < 2) return null
  const last2 = recentResults.slice(-2)
  // Count how many of the last 2 results are semantically identical to current
  const stagnantCount = last2.filter(prev => {
    // Short results: exact match after trim
    if (currentResult.trim().length < 100) {
      return prev.trim() === currentResult.trim()
    }
    // Long results: use Jaccard similarity — >= 0.80 = semantically the same.
    // Lowered from 0.85 to avoid false negatives on results with slight metadata churn.
    return jaccardSimilarity(prev, currentResult) >= 0.80
  }).length

  if (stagnantCount >= 2) {
    return (
      `\n\n[AUDITOR] You have received semantically identical results 3 times in a row. ` +
      `This tool call is not producing new information. STOP using this tool. ` +
      `Switch to a completely different approach: try a different tool, different arguments, or tell the user what you found and ask for clarification.`
    )
  }
  return null
}

/**
 * Wraps the raw tool result with an audit correction hint when applicable.
 * When a correction hint exists, the raw result is pre-capped to 600 chars so
 * the hint is always fully visible — never truncated by the outer obsLen cap.
 */
export function buildObservation(
  toolName: string,
  toolInput: Record<string, unknown>,
  rawResult: string,
): string {
  const audit = auditToolCall(toolName, toolInput, rawResult)
  if (!audit.pass && audit.correctionHint) {
    // Trim raw result so the correction hint always fits within the outer obsLen cap
    const trimmedRaw = rawResult.length > 600
      ? rawResult.slice(0, 600) + '\n...[error detail truncated — see correction hint below]'
      : rawResult
    return trimmedRaw + audit.correctionHint
  }
  return rawResult
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure pattern analysis
// ─────────────────────────────────────────────────────────────────────────────

function identifyFailureType(combinedPreviews: string): string {
  if (/ENOENT|path does not exist|file does not exist|no such file/i.test(combinedPreviews))
    return 'File/path not found — use Glob to locate the correct path before retrying'
  if (/EEXIST/i.test(combinedPreviews))
    return 'Directory already exists (OneDrive quirk) — use Bash with New-Item instead of Write'
  if (/PREFLIGHT BLOCK/i.test(combinedPreviews))
    return 'Pre-flight validation rejected the call — read the block message and change the arguments'
  if (/HTTP 4\d\d|404|403/i.test(combinedPreviews))
    return 'URL does not exist or is blocked — use WebSearch to find the real URL first'
  if (/no results|no matches|\(no matches\)/i.test(combinedPreviews))
    return 'Empty results — query or pattern is too narrow, broaden it or switch tools'
  if (/Exit code [1-9]/i.test(combinedPreviews))
    return 'Bash command exited with error — read stderr and fix the command syntax'
  if (/SESSION BLOCK|too many failures/i.test(combinedPreviews))
    return 'Tool blocked by session guard — switch to an alternative tool entirely'
  if (/old_string not found/i.test(combinedPreviews))
    return 'Edit old_string not found — Read the file first to get the exact current text'
  if (/permission denied|EACCES/i.test(combinedPreviews))
    return 'Permission denied — do not retry this path; inform the user elevated access is needed'
  return ''
}

/**
 * Analyzes recent tool steps and identifies recurring failure patterns.
 * Returns a human-readable diagnosis string for injection into the REPLAN prompt.
 * Returns '' if no significant patterns are found.
 */
export function analyzeFailurePattern(
  toolSteps: Array<{ toolName: string; args: Record<string, unknown>; resultPreview: string; success: boolean }>,
): string {
  const failures = toolSteps.filter(s => !s.success)
  if (failures.length < 2) return ''

  // Group failures by tool
  const byTool: Record<string, typeof failures> = {}
  for (const f of failures) {
    byTool[f.toolName] = byTool[f.toolName] ?? []
    byTool[f.toolName]!.push(f)
  }

  const lines: string[] = []

  for (const [tool, steps] of Object.entries(byTool)) {
    if (steps.length < 2) continue

    // Detect argument looping — same or nearly-same args repeated
    const argShapes = steps.map(s => JSON.stringify(s.args))
    const uniqueShapes = new Set(argShapes)
    const isArgLooping = uniqueShapes.size <= Math.ceil(steps.length / 2)

    const combinedPreviews = steps.map(s => s.resultPreview).join(' ')
    const rootCause = identifyFailureType(combinedPreviews)

    lines.push(
      `• ${tool} failed ${steps.length}x` +
      (isArgLooping ? ' (ARGUMENT LOOP — same args, same failure, same result)' : ''),
    )
    if (rootCause) lines.push(`  Root cause: ${rootCause}`)
    lines.push(`  Last error: ${steps[steps.length - 1]!.resultPreview.slice(0, 120)}`)
  }

  // Cross-tool pattern: all unique tools failing (tool rotation without progress)
  const uniqueFailedTools = new Set(failures.map(s => s.toolName))
  if (uniqueFailedTools.size >= 3 && failures.length >= 3) {
    lines.push(`• Tool rotation detected — ${uniqueFailedTools.size} different tools all failed. The task itself may not be solvable with current information.`)
  }

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic grader — content-level pass/partial/fail
// ─────────────────────────────────────────────────────────────────────────────

export type SemanticGrade = 'success' | 'partial' | 'fail'

export type CriticVerdict = {
  pass: boolean
  confidence: 0 | 1 | 2    // 0=uncertain, 1=likely, 2=confident
  evidence: string          // excerpt from results proving the verdict
  suggestion?: string       // what to try differently on fail
}

/**
 * Fast-path semantic grader — no LLM call required.
 * Checks whether a tool result actually contains content relevant to taskGoal.
 *
 * Returns:
 *   'success' — result clearly addresses the task
 *   'partial'  — result is related but uncertain (default for side-effect tools)
 *   'fail'     — structurally OK but content has zero relevance to the task
 *
 * Per-tool decision logic:
 *
 *   Bash:        empty output → 'fail'; otherwise → 'partial' (side effects
 *                may not echo task keywords — never hard-fail bash by default)
 *
 *   WebSearch:   zero results / "no results" → 'fail'; ≥2 keywords in any
 *                snippet → 'success'; ≥1 keyword → 'partial'; none → 'fail'
 *
 *   WebFetch:    empty → 'fail'; ≥2 keywords in title+opening → 'success';
 *                ≥2 keywords anywhere in body → 'success'; ≥1 → 'partial';
 *                none → 'fail'
 *
 *   File tools   (Read/Glob/Grep/Write/Edit/ListDirectory/CheckDriveStatus):
 *                non-empty → 'success'; empty → 'fail'
 *
 *   Unknown:     'partial' (don't penalise tools we don't know about)
 *
 * NOTE: 'fail' should ONLY be returned when we have high confidence the result
 * is off-topic. When uncertain, return 'partial' — the launcher only increments
 * consecutiveFailureCount for 'fail', not 'partial'.
 */
export function semanticGrade(
  toolName: string,
  taskGoal: string,
  rawOutput: string,
): SemanticGrade {
  const output = rawOutput ?? ''

  // File / system tools — structural success = semantic success
  const FILE_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ListDirectory', 'CheckDriveStatus']
  if (FILE_TOOLS.includes(toolName)) {
    return output.trim() ? 'success' : 'fail'
  }

  const keywords = extractSemanticKeywords(taskGoal)

  // Bash: side effects (installs, git ops, file writes) don't echo task keywords.
  // Only fail if truly empty — never hard-fail bash on keyword absence.
  if (toolName === 'Bash') {
    return output.trim() ? 'partial' : 'fail'
  }

  if (toolName === 'WebSearch') {
    if (!output.trim() || /no results|nothing found|\(no results/i.test(output)) return 'fail'
    const low = output.toLowerCase()
    const matchCount = keywords.filter(kw => low.includes(kw)).length
    if (matchCount >= 2) return 'success'
    if (matchCount >= 1) return 'partial'
    return 'fail'
  }

  if (toolName === 'WebFetch') {
    if (!output.trim()) return 'fail'
    // Check title / opening ~400 chars first (highest signal)
    const opening = output.slice(0, 400).toLowerCase()
    const fullText = output.toLowerCase()
    const openingMatches = keywords.filter(kw => opening.includes(kw)).length
    const fullMatches = keywords.filter(kw => fullText.includes(kw)).length
    if (openingMatches >= 2 || fullMatches >= 2) return 'success'
    if (fullMatches >= 1) return 'partial'
    return 'fail'
  }

  // Unknown / future tools — default to partial (don't break what we don't know)
  return 'partial'
}

/**
 * Extract task-relevant keywords (≥4 chars, not stop-words, max 8).
 * Used internally by semanticGrade() and by contextCompressor.ts.
 */
function extractSemanticKeywords(text: string): string[] {
  const STOP = new Set([
    'the', 'and', 'for', 'this', 'that', 'with', 'from', 'have', 'what',
    'which', 'where', 'when', 'then', 'than', 'just', 'also', 'will',
    'your', 'their', 'there', 'here', 'into', 'about', 'over', 'after',
    'before', 'been', 'some', 'more', 'very', 'make', 'each', 'does',
  ])
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP.has(w))
    .slice(0, 8)
}

// ─────────────────────────────────────────────────────────────────────────────
// Async ToolCritic — isolated subgoal completion check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Isolated secondary Ollama call that verifies whether a subgoal has been achieved.
 *
 * CRITICAL DESIGN NOTE — isolation is the entire point:
 *   The critic sees ONLY the subgoal description + recent successful tool results.
 *   It does NOT see the primary model's reasoning chain, THOUGHT blocks, or prior
 *   tool calls. This breaks the "I just ran this so it must be right" confirmation
 *   bias documented in ToolCritic (arxiv 2510.17052).
 *
 * Used by strategicPlanner.ts (P2) to decide whether to advance to the next subgoal
 * or retry. For P0 this is wired but not called in the hot loop — it's called
 * after major subgoal milestones only.
 *
 * Prompt is ultra-compact (~80 tokens) so it barely dents the context budget.
 * Timeout is 15s — if the critic times out, returns confidence=0 (uncertain)
 * and the caller continues rather than blocking.
 */
export async function criticCheck(
  subgoal: string,
  toolResults: Array<{ toolName: string; resultPreview: string; success: boolean }>,
  ollamaBaseUrl: string,
  model: string,
): Promise<CriticVerdict> {
  const successfulResults = toolResults
    .filter(r => r.success)
    .slice(-3)
    .map(r => `${r.toolName}: ${r.resultPreview.slice(0, 200)}`)
    .join('\n')

  if (!successfulResults) {
    return { pass: false, confidence: 2, evidence: 'No successful tool results yet.' }
  }

  const prompt =
    `Task: ${subgoal.slice(0, 200)}\n\n` +
    `Tool results:\n${successfulResults}\n\n` +
    `Has the task been completed? Reply with ONLY: yes / partial / no\n` +
    `Then one sentence of evidence.`

  try {
    const resp = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0, num_predict: 60 },
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!resp.ok) throw new Error(`critic HTTP ${resp.status}`)

    const data: any = await resp.json()
    const text: string = (data.message?.content ?? '').toLowerCase().trim()
    const evidence = (data.message?.content ?? '').slice(0, 150)

    if (text.startsWith('yes')) {
      return { pass: true, confidence: 2, evidence }
    }
    if (text.startsWith('partial')) {
      return { pass: false, confidence: 1, evidence, suggestion: 'Continue gathering evidence for this subgoal.' }
    }
    if (text.startsWith('no')) {
      return { pass: false, confidence: 2, evidence, suggestion: 'Try a different tool or approach for this subgoal.' }
    }

    // Unparseable response — treat as uncertain
    return { pass: false, confidence: 0, evidence: 'Critic response was not parseable.', suggestion: 'Treat as uncertain — continue.' }
  } catch {
    // Timeout or network error — don't block the session
    return { pass: false, confidence: 0, evidence: 'Critic call failed or timed out — treating as uncertain.' }
  }
}
