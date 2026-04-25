/**
 * Canonical tool contract for the local Ollama/Qwen agent loop.
 *
 * The wider Jarvis runtime documents tools such as Read, Grep, Glob, Edit,
 * Write, Bash, WebFetch, and WebSearch. The older local adapter used a second
 * lowercase naming scheme. This module keeps the local path aligned with the
 * canonical contract while still accepting legacy aliases from older prompts or
 * model habits.
 */

export type ToolParameterSchema = {
  type: 'object'
  properties: Record<string, {
    type: string
    description?: string
    enum?: string[]
    items?: { type: string }
  }>
  required?: string[]
}

export type ToolSchema = {
  name: string
  description: string
  parameters: ToolParameterSchema
  /** One-line description of what the tool returns — used in prompt TOOL GUIDE. */
  expected_output?: string
}

export type ValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; errors: string[] }

export type ToolCallAttempt = {
  toolName: string
  rawArgs: unknown
  schema: ToolSchema
}

export type ToolCallValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; repairMessage: string; errors: string[] }

const LOCAL_TOOL_NAME_ALIASES: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  edit_file: 'Edit',
  grep: 'Grep',
  glob: 'Glob',
  listdir: 'ListDirectory',
  list_directory: 'ListDirectory',
  listdirectory: 'ListDirectory',
  read: 'Read',
  read_file: 'Read',
  search_files: 'Grep',
  webfetch: 'WebFetch',
  web_fetch: 'WebFetch',
  websearch: 'WebSearch',
  web_search: 'WebSearch',
  write: 'Write',
  write_file: 'Write',
  check_drive_status: 'CheckDriveStatus',
  checkdrivestatus: 'CheckDriveStatus',
  drive_status: 'CheckDriveStatus',
  drivestatus: 'CheckDriveStatus',
  write_memory: 'WriteMemory',
  writememory: 'WriteMemory',
  save_memory: 'WriteMemory',
  savememory: 'WriteMemory',
  remember: 'WriteMemory',
}

const LOCAL_TOOL_ARGUMENT_ALIASES: Record<string, Record<string, string>> = {
  Bash: {
    cmd: 'command',
    shell_command: 'command',
    run: 'command',
  },
  Edit: {
    path: 'file_path',
  },
  Grep: {
    directory: 'path',
  },
  Read: {
    path: 'file_path',
  },
  Write: {
    path: 'file_path',
  },
}

export const LOCAL_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'Read',
    description: 'Read the contents of a file from an absolute path.',
    expected_output: 'File text content, or error if path is invalid or file not found.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to read.',
        },
        offset: {
          type: 'integer',
          description: 'Optional line number to start reading from.',
        },
        limit: {
          type: 'integer',
          description: 'Optional number of lines to read.',
        },
        pages: {
          type: 'string',
          description: 'Optional PDF page range such as "1-5" or "3".',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'Write',
    description: 'Write content to a file, creating it if needed.',
    expected_output: 'Confirmation message with bytes written, or error on permission/path failure.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to write.',
        },
        content: {
          type: 'string',
          description: 'Full content to write.',
        },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'Edit',
    description: 'Replace exact text inside an existing file.',
    expected_output: 'Diff snippet showing replaced text, or error if old_string not found.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'The absolute path to the file to edit.',
        },
        old_string: {
          type: 'string',
          description: 'The exact text to replace.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text.',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace all matching occurrences when true.',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents with a regular expression.',
    expected_output: 'Matching lines with file paths and line numbers, or empty if no matches.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression pattern to search for.',
        },
        path: {
          type: 'string',
          description: 'Optional file or directory to search in.',
        },
        glob: {
          type: 'string',
          description: 'Optional glob filter such as "*.ts" or "*.{ts,tsx}".',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Controls whether matching lines, matching files, or counts are returned.',
        },
        '-B': {
          type: 'integer',
          description: 'Lines of context to show before each match.',
        },
        '-A': {
          type: 'integer',
          description: 'Lines of context to show after each match.',
        },
        '-C': {
          type: 'integer',
          description: 'Alias for context.',
        },
        context: {
          type: 'integer',
          description: 'Lines of context to show before and after each match.',
        },
        '-n': {
          type: 'boolean',
          description: 'Show line numbers in content mode.',
        },
        '-i': {
          type: 'boolean',
          description: 'Use case-insensitive matching.',
        },
        type: {
          type: 'string',
          description: 'Optional file type filter such as js, ts, py, or go.',
        },
        head_limit: {
          type: 'integer',
          description: 'Maximum number of result lines or entries to return.',
        },
        offset: {
          type: 'integer',
          description: 'Number of result lines or entries to skip before returning matches.',
        },
        multiline: {
          type: 'boolean',
          description: 'Enable multiline regex matching.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern.',
    expected_output: 'List of matching absolute file paths, or empty if no matches.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern such as "**/*.ts" or "src/**/*.tsx".',
        },
        path: {
          type: 'string',
          description: 'Optional root directory to search from.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'Bash',
    description: 'Execute a shell command and return stdout and stderr.',
    expected_output: 'stdout + stderr text and exit code. Non-zero exit = command failed.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run.',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in milliseconds.',
        },
        description: {
          type: 'string',
          description: 'Optional human-readable summary of the command.',
        },
        run_in_background: {
          type: 'boolean',
          description: 'Optional background-run hint. Unsupported values will be ignored by the local adapter.',
        },
        dangerouslyDisableSandbox: {
          type: 'boolean',
          description: 'Optional sandbox override hint. Ignored by the local adapter.',
        },
        workingDir: {
          type: 'string',
          description: 'Optional legacy working directory override.',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'WebSearch',
    description: 'Search the web for current information on a topic.',
    expected_output: 'Result snippets with titles, URLs, and summaries. May be empty.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query string.',
        },
        allowed_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of domains to include.',
        },
        blocked_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of domains to exclude.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'WebFetch',
    description: 'Fetch a URL and return its text content.',
    expected_output: 'Page text content (HTML stripped). May be truncated for large pages.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch.',
        },
        prompt: {
          type: 'string',
          description: 'Optional instruction describing what information to focus on.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'ListDirectory',
    description: 'List files and subdirectories at a path, newest first.',
    expected_output: 'Names sorted newest-first. First entry = most recent file.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional absolute directory path to list.',
        },
      },
    },
  },
  {
    name: 'CheckDriveStatus',
    expected_output: 'Structured runtime status: Drive connection, memory path, available tools.',
    description:
      'Check whether the Google Drive cloud brain is connected and return its full status. ' +
      'Use this whenever the user asks if Drive is connected, if memory is working, or to ' +
      'verify your own runtime state. Never use WebSearch for self-status checks.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'WriteMemory',
    expected_output: 'Confirmation that memory entry was persisted, or error on write failure.',
    description:
      'Persist a new fact, user preference, or learned behavior to your permanent memory (MEMORY.md). ' +
      'Use this when you discover something important about the user, their project, or a tool pattern ' +
      'that should be remembered across sessions. The entry will be available in your next session. ' +
      'Do NOT write ephemeral session state — only write durable facts worth remembering long-term.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short snake_case identifier for this memory entry (e.g. "user_preferred_shell").',
        },
        description: {
          type: 'string',
          description: 'One-line summary of what this memory entry contains.',
        },
        type: {
          type: 'string',
          enum: ['user', 'feedback', 'project', 'reference'],
          description: 'Memory type: user (about the user), feedback (behavioral rule), project (task/goal), reference (external resource pointer).',
        },
        body: {
          type: 'string',
          description: 'The memory content. For feedback entries, include a "Why:" and "How to apply:" line.',
        },
      },
      required: ['name', 'description', 'type', 'body'],
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Tool guide generator — compact decision matrix for the system prompt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the TOOL GUIDE block for the system prompt.
 * Each line: Tool(key_args) -> returns: expected_output
 * Followed by routing rules for common misroutes.
 */
export function buildToolGuide(): string {
  const lines: string[] = ['TOOL GUIDE — pick the right tool on the first try:']
  for (const schema of LOCAL_TOOL_SCHEMAS) {
    const required = schema.parameters.required ?? []
    const argSig = required.length > 0 ? required.join(', ') : 'no args'
    const output = schema.expected_output ?? 'result'
    lines.push(`  ${schema.name}(${argSig}) -> ${output}`)
  }
  lines.push(
    'ROUTING RULES:',
    '  self-state/status -> CheckDriveStatus, never WebSearch',
    '  file content question -> Read or ListDirectory first, never guess',
    '  edit a file -> Read first, then Edit with exact old_string',
    '  web info -> WebSearch(2+ words, include topic) then WebFetch for detail',
    '  weather -> Bash: curl.exe -s "wttr.in/?format=3" (curl.exe on Windows)',
    '  create file -> Write(file_path, content). Bash fallback only if Write fails',
    '  find files -> Glob(pattern). Scope with path= when possible',
  )
  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared tool rules — de-duplicated guidance used by both prompt styles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Common tool-use rules shared between the legacy-react and native-tool-use
 * prompt paths. Kept here so changes propagate to both paths automatically.
 */
export const SHARED_TOOL_RULES: string[] = [
  'Call tools directly — never describe the tool invocation in user-facing prose, and never route it through SendUserMessage or SendMessage. Tool calls are not messages.',
  'Tool arguments must be strict JSON with no commentary, no markdown fences, and no invented fields.',
  'Requests that depend on current machine state are not satisfied until you inspect live tool output. This includes filesystem questions, latest/newest/most-recent lookups, installed-tool checks, current environment state, and any other request that could have changed since training.',
  'For latest/newest/most recent file questions, use a filesystem tool first. If ListDirectory returns newest-first entries, the first file entry is the answer. Do not guess from memory and do not answer from older entries.',
  'Before you finalize any tool-grounded answer, verify that the answer directly matches the freshest relevant tool result and that you have fully satisfied the user request.',
  'Core Claude-compatible tool names in this runtime include Read, Grep, Glob, Edit, Write, Bash, WebFetch, WebSearch, and ListDirectory.',
  'CRITICAL BASH SCHEMA: The Bash tool requires a `command` field — NOT `cmd`, `shell_command`, or `run`. Example: {"command": "ls -la"}. Any other field name for the shell command will be rejected.',
  'Use the exact runtime tool name and exact parameter names from the schema. If the system returns a tool repair template after an error, follow it exactly on the next attempt.',
  'If you were trained on legacy local aliases like read_file or search_files, map them to the canonical runtime names instead of emitting the aliases.',
  'The full Claude child runtime may also expose additional built-in and MCP-provided tools. Use any tool surfaced by the native schema exactly as named.',
  'Never fabricate tool availability. If a needed tool is missing, explain the limitation plainly.',
  'If you catch yourself writing a tool invocation as text, stop and emit the actual tool call through the runtime instead.',
]

// ─────────────────────────────────────────────────────────────────────────────
// Capability registry
// ─────────────────────────────────────────────────────────────────────────────

export type CapabilityReport = {
  tools: string[]
  driveConnected: boolean
  memoryPath: string | null
  model: string
  webSearchAvailable: boolean
  timestamp: string
}

/**
 * Build a human-readable capability report for Jarvis to consult when asked
 * about its own state. Pass the values from the current session config.
 */
export function buildCapabilityReport(opts: {
  driveConnected: boolean
  memoryPath: string | null
  model: string
}): CapabilityReport {
  return {
    tools: LOCAL_TOOL_SCHEMAS.map(s => s.name),
    driveConnected: opts.driveConnected,
    memoryPath: opts.memoryPath,
    model: opts.model,
    webSearchAvailable: true,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Format the capability report as a human-readable string for injection
 * into the OBSERVATION when CheckDriveStatus is called.
 */
export function formatCapabilityReport(report: CapabilityReport): string {
  const lines = [
    `## Jarvis Runtime Status`,
    `Timestamp: ${report.timestamp}`,
    `Model: ${report.model}`,
    ``,
    `### Google Drive Brain`,
    report.driveConnected
      ? `Status: CONNECTED`
      : `Status: NOT CONNECTED — experience replay, journal, and context retrieval are disabled`,
    ``,
    `### Memory`,
    report.memoryPath
      ? `MEMORY.md path: ${report.memoryPath}`
      : `Memory: not configured`,
    ``,
    `### Available Tools`,
    report.tools.join(', '),
    ``,
    `### Web Search`,
    `WebSearch: available (DuckDuckGo instant answers)`,
    `WebFetch: available (direct URL fetch)`,
    `Weather: use Bash with \`curl -s "wttr.in/?format=3"\` — no API key needed`,
  ]
  return lines.join('\n')
}

export function normalizeLocalToolName(toolName: string): string {
  const trimmed = toolName.trim()
  if (!trimmed) return ''

  return (
    LOCAL_TOOL_NAME_ALIASES[trimmed] ??
    LOCAL_TOOL_NAME_ALIASES[trimmed.toLowerCase()] ??
    trimmed
  )
}

export function normalizeLocalToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const canonicalName = normalizeLocalToolName(toolName)
  const aliases = LOCAL_TOOL_ARGUMENT_ALIASES[canonicalName]
  if (!aliases) {
    return { ...args }
  }

  const normalized = { ...args }
  for (const [legacyKey, canonicalKey] of Object.entries(aliases)) {
    if (legacyKey in normalized && !(canonicalKey in normalized)) {
      normalized[canonicalKey] = normalized[legacyKey]
    }
    delete normalized[legacyKey]
  }

  return normalized
}

export function parseToolArgs(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    const stripped = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim()
    try {
      const parsed = JSON.parse(stripped)
      if (typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
  }
  return null
}

export function validateAgainstSchema(
  args: Record<string, unknown>,
  schema: ToolParameterSchema,
): ValidationResult {
  const errors: string[] = []

  for (const required of schema.required ?? []) {
    if (
      !(required in args) ||
      args[required] === undefined ||
      args[required] === null
    ) {
      errors.push(`Missing required field: "${required}"`)
    }
  }

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in args)) continue

    const value = args[key]
    const expectedType = propSchema.type
    const actualType = Array.isArray(value) ? 'array' : typeof value
    const typeMatch =
      actualType === expectedType ||
      (expectedType === 'integer' &&
        typeof value === 'number' &&
        Number.isInteger(value)) ||
      (expectedType === 'number' && typeof value === 'number')

    if (!typeMatch) {
      errors.push(
        `Field "${key}": expected type "${expectedType}" but got "${actualType}" (value: ${JSON.stringify(value).slice(0, 60)})`,
      )
    }

    if (propSchema.enum && !propSchema.enum.includes(String(value))) {
      errors.push(
        `Field "${key}": value "${value}" is not one of the allowed values: [${propSchema.enum.join(', ')}]`,
      )
    }
  }

  // Unknown fields: silently strip rather than reject the whole call.
  // The model occasionally emits extra fields like "retries" or "description"
  // that aren't in the schema. Rejecting causes a wasted loop iteration;
  // stripping is safe because the tool executor ignores unknown args anyway.
  const cleanedArgs = Object.fromEntries(
    Object.entries(args).filter(([k]) => k in schema.properties),
  )

  return errors.length === 0 ? { ok: true, args: cleanedArgs } : { ok: false, errors }
}

export function buildRepairTemplate(
  toolName: string,
  schema: ToolSchema,
  errors: string[],
  previousArgs: Record<string, unknown>,
): string {
  const schemaExample: Record<string, string> = {}
  for (const [key, prop] of Object.entries(schema.parameters.properties)) {
    const exampleValue =
      prop.enum?.[0] ??
      (prop.type === 'string'
        ? `"example_${key}"`
        : prop.type === 'number' || prop.type === 'integer'
          ? '0'
          : prop.type === 'boolean'
            ? 'true'
            : prop.type === 'array'
              ? '[]'
              : 'null')
    schemaExample[key] = exampleValue as string
  }

  return (
    `TOOL_SCHEMA_ERROR for tool "${toolName}":\n\n` +
    `Violations detected:\n` +
    errors.map(error => `  - ${error}`).join('\n') +
    `\n\nYour previous arguments:\n${JSON.stringify(previousArgs, null, 2)}\n\n` +
    `Correct schema for "${toolName}":\n` +
    `Required fields: [${(schema.parameters.required ?? []).join(', ')}]\n` +
    `Properties:\n` +
    Object.entries(schema.parameters.properties)
      .map(([key, prop]) => {
        const enumPart = prop.enum ? `, one of: ${prop.enum.join('|')}` : ''
        return `  ${key} (${prop.type}${enumPart}): ${prop.description ?? ''}`
      })
      .join('\n') +
    `\n\nExample valid call:\n${JSON.stringify(schemaExample, null, 2)}\n\n` +
    'Retry the tool call with corrected arguments. Do not explain - just call the tool.'
  )
}

export function validateToolCall(
  attempt: ToolCallAttempt,
): ToolCallValidationResult {
  const canonicalToolName = normalizeLocalToolName(attempt.toolName)
  const schema = getToolSchema(canonicalToolName) ?? attempt.schema
  const parsed = parseToolArgs(attempt.rawArgs)

  if (!parsed) {
    const repairMessage = buildRepairTemplate(
      canonicalToolName,
      schema,
      ['Could not parse tool arguments as JSON. Arguments must be a valid JSON object.'],
      {},
    )
    return { ok: false, repairMessage, errors: ['JSON parse failure'] }
  }

  const normalizedArgs = normalizeLocalToolArguments(canonicalToolName, parsed)
  const validation = validateAgainstSchema(normalizedArgs, schema.parameters)
  if (!validation.ok) {
    const repairMessage = buildRepairTemplate(
      canonicalToolName,
      schema,
      validation.errors,
      normalizedArgs,
    )
    return { ok: false, repairMessage, errors: validation.errors }
  }

  return { ok: true, args: normalizedArgs }
}

export function getToolSchema(toolName: string): ToolSchema | null {
  const canonicalToolName = normalizeLocalToolName(toolName)
  return (
    LOCAL_TOOL_SCHEMAS.find(schema => schema.name === canonicalToolName) ?? null
  )
}

export function buildOllamaToolList(): Array<{
  type: 'function'
  function: ToolSchema
}> {
  return LOCAL_TOOL_SCHEMAS.map(schema => ({
    type: 'function' as const,
    function: schema,
  }))
}
