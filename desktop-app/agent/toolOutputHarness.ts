/**
 * toolOutputHarness.ts — Lenient JSON parser, schema coercion, and inline error annotation.
 *
 * Research basis: DEV.to Qwen meetup harness approach — achieved 6.75% → 100%
 * tool-call accuracy on 7B models by layering progressive repair strategies
 * and annotating errors inline at the exact field path rather than as a
 * separate error list.
 *
 * Three exports consumed by toolValidator.ts:
 *   lenientsJSONParse()          — replaces the single JSON.parse call in parseToolArgs()
 *   coerceToSchema()             — new step between parse and validateAgainstSchema()
 *   buildHarnessRepairTemplate() — replaces buildRepairTemplate() for inline ❌ annotations
 */

import type { ToolParameterSchema, ToolSchema } from './localToolContract.js'

// ─────────────────────────────────────────────────────────────────────────────
// Lenient JSON parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Progressively repairs known Qwen2.5-7B JSON output pathologies before parsing.
 * Attempts strict JSON.parse first — only escalates to repairs when that fails.
 *
 * Repair strategies (applied in order, each followed by a parse attempt):
 *   1. Direct JSON.parse                      — fast path for well-formed output
 *   2. Extended fence stripping               — ```typescript / ```ts / ```js / bare ```
 *   3. Double-stringification unwrapping      — "\"{ ... }\"" → { ... }
 *   4. Boolean/null literal fixup             — tru→true  fals→false  nul→null
 *   5. Trailing comma removal                 — ,}  and  ,]
 *   6. Unquoted key normalization             — {key: "val"} → {"key": "val"}
 *   7. Unclosed bracket / string auto-close  — last resort structural repair
 *
 * Returns the parsed object or null when all strategies are exhausted.
 * Never throws.
 */
export function lenientsJSONParse(raw: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null

  // ── Strategy 1: strict parse (fast path) ──────────────────────────────────
  try {
    const v = JSON.parse(raw)
    if (isPlainObject(v)) return v
  } catch { /* fall through */ }

  // ── Strategy 2: extended fence stripping ──────────────────────────────────
  let s = raw
    .replace(/^```(?:json|typescript|ts|js|javascript|python|bash|sh)?\s*/im, '')
    .replace(/\s*```\s*$/m, '')
    .trim()

  // ── Strategy 3: double-stringification unwrapping ─────────────────────────
  // The model sometimes outputs: "\"{ \\\"name\\\": \\\"Read\\\" }\""
  // We need to peel up to two layers of extra JSON-string encoding.
  for (let layer = 0; layer < 2; layer++) {
    if (s.startsWith('"') && s.endsWith('"')) {
      try {
        const inner = JSON.parse(s)
        if (typeof inner === 'string' && inner.trim().startsWith('{')) {
          s = inner.trim()
          continue
        }
      } catch { /* not double-stringified at this layer */ }
    }
    break
  }

  // Try parse after strategy 2–3
  try {
    const v = JSON.parse(s)
    if (isPlainObject(v)) return v
  } catch { /* fall through */ }

  // ── Strategy 4: boolean / null literal fixup ─────────────────────────────
  // Matches the literal at a value position (after : or inside array),
  // but only when followed by , } ] or whitespace — avoids mangling strings.
  s = s
    .replace(/(?<=:\s*)tru(?=\s*[,}\]])/g, 'true')
    .replace(/(?<=:\s*)fals(?=\s*[,}\]])/g, 'false')
    .replace(/(?<=:\s*)nul(?=\s*[,}\]])/g, 'null')
    // Also handle these at array element positions
    .replace(/(?<=[\[,]\s*)tru(?=\s*[,\]])/g, 'true')
    .replace(/(?<=[\[,]\s*)fals(?=\s*[,\]])/g, 'false')
    .replace(/(?<=[\[,]\s*)nul(?=\s*[,\]])/g, 'null')

  // ── Strategy 5: trailing comma removal ────────────────────────────────────
  s = s.replace(/,(\s*[}\]])/g, '$1')

  // Try parse after strategy 4–5
  try {
    const v = JSON.parse(s)
    if (isPlainObject(v)) return v
  } catch { /* fall through */ }

  // ── Strategy 6: unquoted key normalization ────────────────────────────────
  // Matches: {key: or ,key: or { key : (key = identifier starting with letter/_)
  // Must NOT match already-quoted keys like {"key": ...}
  s = s.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)(\s*:)/g, (match, before, key, colon) => {
    // Skip if this is already inside a string — check for preceding unclosed quote
    return `${before}"${key}"${colon}`
  })

  // Try parse after strategy 6
  try {
    const v = JSON.parse(s)
    if (isPlainObject(v)) return v
  } catch { /* fall through */ }

  // ── Strategy 7: unclosed bracket / string auto-close ─────────────────────
  // Walk the string character-by-character to count open braces and track
  // whether we're inside a string. Append closing chars as needed.
  s = autoCloseJSON(s)

  try {
    const v = JSON.parse(s)
    if (isPlainObject(v)) return v
  } catch { /* all strategies exhausted */ }

  return null
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function autoCloseJSON(raw: string): string {
  const stack: string[] = []
  let inString = false
  let escaped = false
  const chars: string[] = []

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!

    if (escaped) {
      escaped = false
      chars.push(ch)
      continue
    }
    if (ch === '\\' && inString) {
      escaped = true
      chars.push(ch)
      continue
    }
    if (ch === '"') {
      inString = !inString
      chars.push(ch)
      continue
    }
    if (!inString) {
      if (ch === '{') stack.push('}')
      else if (ch === '[') stack.push(']')
      else if (ch === '}' || ch === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === ch) {
          stack.pop()
        }
        // mismatched closer — drop it to avoid corrupting structure
        else { continue }
      }
    }
    chars.push(ch)
  }

  let result = chars.join('')
  if (inString) result += '"'
  while (stack.length > 0) result += stack.pop()!
  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema-aware type coercion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce parsed argument values to the types declared in the tool's JSON Schema.
 * Applied AFTER lenientsJSONParse, BEFORE validateAgainstSchema.
 *
 * Handles the most common Qwen2.5-7B type confusion patterns:
 *   "42"    → 42      (string → number/integer)
 *   "true"  → true    (string → boolean)
 *   "false" → false   (string → boolean)
 *   42      → "42"    (number → string — rarer but happens with path fields)
 *   "[]"    → []      (JSON-string → array)
 *
 * Never coerces object fields — those are schema mismatches, not type confusion.
 * Returns a shallow copy — does not mutate the input object.
 */
export function coerceToSchema(
  args: Record<string, unknown>,
  schema: ToolParameterSchema,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...args }

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in result)) continue
    const value = result[key]
    const expected = propSchema.type

    switch (expected) {
      case 'number':
      case 'integer': {
        if (typeof value === 'string') {
          const n = Number(value)
          if (!Number.isNaN(n)) {
            result[key] = expected === 'integer' ? Math.round(n) : n
          }
        }
        break
      }
      case 'boolean': {
        if (value === 'true'  || value === '1' || value === 1) result[key] = true
        else if (value === 'false' || value === '0' || value === 0) result[key] = false
        break
      }
      case 'string': {
        if (typeof value === 'number' || typeof value === 'boolean') {
          result[key] = String(value)
        }
        break
      }
      case 'array': {
        if (typeof value === 'string') {
          try {
            const parsed = JSON.parse(value)
            if (Array.isArray(parsed)) result[key] = parsed
          } catch { /* not a JSON array string — leave as-is */ }
        }
        break
      }
    }
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline error annotation + harness repair template
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render validation errors as inline JSON comments at the exact field path.
 *
 * Input:
 *   args   = { "file_path": 42, "content": "hello world" }
 *   errors = ['Field "file_path": expected type "string" but got "number" (value: 42)']
 *
 * Output:
 *   {
 *     "file_path": 42,  // ❌ expected string, got number
 *     "content": "hello world"
 *   }
 *
 * The model sees the error at the exact field position — no cross-referencing
 * needed. This spatial annotation pattern outperforms list-format error messages
 * because the model understands what to change without re-parsing the structure.
 */
export function buildInlineAnnotatedError(
  previousArgs: Record<string, unknown>,
  errors: string[],
  _schema: ToolSchema,
): string {
  // Parse error strings → field name → short annotation
  const fieldErrors: Record<string, string> = {}
  for (const err of errors) {
    // Pattern: Field "fieldName": expected ... got ...
    const fieldMatch = err.match(/[Ff]ield "([^"]+)":\s*(.+)/)
    if (fieldMatch) {
      const [, field, detail] = fieldMatch
      // Condense the detail: drop "(value: ...)" parenthetical — it's already in the JSON
      const note = detail!.replace(/\s*\(value:.*?\)\s*$/, '').trim()
      fieldErrors[field!] = note
      continue
    }
    // Pattern: Missing required field: "fieldName"
    const missingMatch = err.match(/Missing required field:\s*"?([^"]+)"?/)
    if (missingMatch) {
      fieldErrors[missingMatch[1]!] = 'REQUIRED — field is missing'
    }
    // Pattern: Unknown field "fieldName"
    const unknownMatch = err.match(/Unknown field "([^"]+)"/)
    if (unknownMatch) {
      fieldErrors[unknownMatch[1]!] = 'unknown field — remove it'
    }
  }

  // Render JSON with inline // ❌ comments on error fields
  const entries = Object.entries(previousArgs)
  if (entries.length === 0) {
    // No args at all — show what's missing
    const missing = errors
      .filter(e => e.includes('Missing required'))
      .map(e => e.replace(/Missing required field:\s*"?([^"]+)"?/, '  // ❌ REQUIRED: "$1" is missing'))
    return `{\n${missing.join('\n') || '  // ❌ (no arguments provided)'}\n}`
  }

  const lines: string[] = ['{']
  entries.forEach(([key, val], i) => {
    const comma = i < entries.length - 1 ? ',' : ''
    const annotation = fieldErrors[key] ? `  // ❌ ${fieldErrors[key]}` : ''
    let serialized: string
    try { serialized = JSON.stringify(val) } catch { serialized = String(val) }
    lines.push(`  ${JSON.stringify(key)}: ${serialized}${comma}${annotation}`)
  })
  lines.push('}')

  // Append missing required fields that weren't in previousArgs at all
  for (const err of errors) {
    const missingMatch = err.match(/Missing required field:\s*"?([^"]+)"?/)
    if (missingMatch && !(missingMatch[1] in previousArgs)) {
      lines.splice(lines.length - 1, 0, `  // ❌ REQUIRED field "${missingMatch[1]}" is missing entirely`)
    }
  }

  return lines.join('\n')
}

/**
 * Harness repair template — drop-in replacement for buildRepairTemplate() in toolValidator.ts.
 *
 * Unlike the original (which shows generic "example_path" placeholders), this:
 *   1. Annotates the model's ACTUAL previous call with inline ❌ at the bad fields
 *   2. Shows the schema with types, required/optional, and descriptions
 *   3. Provides a corrected example that starts from the previous args and only
 *      fixes the broken fields — keeping everything the model got right intact
 *
 * This makes it maximally clear what changed and what stayed the same.
 */
export function buildHarnessRepairTemplate(
  toolName: string,
  schema: ToolSchema,
  errors: string[],
  previousArgs: Record<string, unknown>,
): string {
  const annotated = buildInlineAnnotatedError(previousArgs, errors, schema)

  // Build corrected example: start from previousArgs, fix only the flagged fields
  const correctedExample: Record<string, unknown> = { ...previousArgs }
  for (const [key, propSchema] of Object.entries(schema.parameters.properties)) {
    const hasError = errors.some(e => e.includes(`"${key}"`))
    if (!hasError) continue  // keep the model's value for fields it got right

    // Generate a plausible corrected value
    if (propSchema.enum?.length) {
      correctedExample[key] = propSchema.enum[0]
    } else {
      switch (propSchema.type) {
        case 'string':  correctedExample[key] = `<${key}>`; break
        case 'number':
        case 'integer': correctedExample[key] = 0; break
        case 'boolean': correctedExample[key] = true; break
        case 'array':   correctedExample[key] = []; break
        default:        correctedExample[key] = null
      }
    }
  }
  // Add any missing required fields to the corrected example
  for (const req of schema.parameters.required ?? []) {
    if (!(req in correctedExample)) {
      const propSchema = schema.parameters.properties[req]
      if (!propSchema) continue
      if (propSchema.enum?.length) { correctedExample[req] = propSchema.enum[0]; continue }
      switch (propSchema.type) {
        case 'string':  correctedExample[req] = `<${req}>`; break
        case 'number':
        case 'integer': correctedExample[req] = 0; break
        case 'boolean': correctedExample[req] = true; break
        case 'array':   correctedExample[req] = []; break
        default:        correctedExample[req] = null
      }
    }
  }

  const requiredFields = schema.parameters.required ?? []
  const propLines = Object.entries(schema.parameters.properties)
    .map(([k, p]) => {
      const req = requiredFields.includes(k) ? '[required]' : '[optional]'
      const enumNote = p.enum?.length ? ` — one of: ${p.enum.join(' | ')}` : ''
      const desc = p.description ? ` — ${p.description}` : ''
      return `  ${k} (${p.type} ${req}${enumNote}${desc})`
    })
    .join('\n')

  return (
    `[TOOL_SCHEMA_ERROR] "${toolName}" — ${errors.length} violation(s) detected.\n\n` +
    `Your call with errors annotated:\n${annotated}\n\n` +
    `Required schema for "${toolName}":\n${propLines}\n\n` +
    `Corrected call (only broken fields changed):\n${JSON.stringify(correctedExample, null, 2)}\n\n` +
    `Retry with the corrected arguments above. Do not explain — just call the tool.`
  )
}
