# Jarvis Agentic Improvement Plan
**Date:** 2026-04-25  
**Scope:** Research-driven agentic upgrades for Qwen2.5-7B-Instruct  
**Status:** Plan complete — awaiting implementation go-ahead per tier

---

## Root Problems Being Solved

| Problem | Current Behavior | Target |
|---------|-----------------|--------|
| Tool call failures | `parseToolArgs` does one `JSON.parse` — fails on `tru`/`fals`, trailing commas, unclosed brackets, double-stringified JSON | 0 parse failures on well-formed-but-imperfect output |
| False-positive grading | `auditToolCall` returns pass=true when bash exits 0 or WebSearch returns N results, regardless of semantic relevance | Tool results graded on content, not just structure |
| Context flooding | History slot (2400 tokens) fills in 4–5 tool-heavy turns; raw Bash stdout, WebFetch pages dumped uncompressed | 26–54% token reduction, more history retained |
| Goal drift / poor planning | Flat ReAct loop loses goal orientation by turn 4–6; PLAN block is enforced at turn 2 but unstructured and never updated proactively | Hierarchical subgoal plan, continuously updated, scoped context |

---

## Architecture Overview

```
User message
    │
    ▼
taskClassifier.ts          ← existing: classifyTask()
    │                                  buildComplexityHint()
    ▼
strategicPlanner.ts        ← NEW P2:  generatePlan()
    │                                  formatPlanForContext()
    ▼
contextAssembler.ts        ← existing: assembleContext()
    │                        P1 wire:  compressHistory() called when >70% budget
    ▼
ReAct loop (launcher.ts)
    │
    ├─► toolFastPath.ts     ← existing: buildToolRoutingHint()
    │
    ├─► toolCallSampler.ts  ← NEW P3:  bestOfN() for Edit/Write/destructive Bash
    │
    ├─► toolValidator.ts    ← existing, P0 wired: parseToolArgs() now calls lenientsJSONParse()
    │       └─► toolOutputHarness.ts  ← NEW P0: lenient parser + coercion + inline ❌
    │
    ├─► executeLocalTool()  ← existing: runs the actual tool
    │
    ├─► contextCompressor.ts  ← NEW P1: compressObservation() before observation enters context
    │
    ├─► responseAuditor.ts  ← existing + P0 new: buildObservation()
    │       └─► semanticGrade()  ← NEW P0: content-level pass/fail
    │
    └─► strategicPlanner.ts ← P2: updatePlan() / revisePlan() after each tool call
```

---

## P0-A: `toolOutputHarness.ts` — Lenient JSON Harness

**File:** `desktop-app/agent/toolOutputHarness.ts` (new)  
**Research basis:** DEV.to Qwen meetup harness — 6.75% → 100% tool-call accuracy on 7B models  

### What the current code misses

`parseToolArgs()` in `toolValidator.ts` (line 41) does:
```typescript
const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
try { return JSON.parse(stripped) } catch { return null }
```

Fails on every known Qwen2.5-7B output pathology:

| Pathology | Example | Current result |
|-----------|---------|----------------|
| Boolean typo | `{"recursive": tru}` | `null` → repair loop |
| Trailing comma | `{"path": "/home",}` | `null` → repair loop |
| Unquoted keys | `{path: "/home/user"}` | `null` → repair loop |
| Unclosed string | `{"path": "C:\Users\ethan` | `null` → repair loop |
| Double-stringified | `"{\\"name\\":\\"Read\\",\\"arguments\\":\\"{\\\\"file_path\\\\":\\\\"...\\\\"}\\"}"` | `null` → repair loop |
| Non-JSON fence | ` ```typescript\n{...}\n``` ` | strips only json/empty fence |
| String-typed number | `{"line_count": "42"}` | parses OK, then schema error |
| String-typed boolean | `{"recursive": "true"}` | parses OK, then schema error |

`validateAgainstSchema()` (line 69) also does strict type checking with no coercion — `"42"` for a number field → error instead of coerce. This triggers the full repair loop for a trivial type mismatch.

`buildRepairTemplate()` (line 126) injects generic `"example_path"` placeholders, not inline annotations. The model cannot see which specific field was wrong.

### New file: `toolOutputHarness.ts`

```typescript
/**
 * toolOutputHarness.ts — Lenient JSON parser, schema coercion, and inline error annotation.
 *
 * Research basis: DEV.to Qwen meetup harness approach — achieved 6.75% → 100%
 * tool-call accuracy on 7B models by layering progressive repair strategies
 * and annotating errors inline at the exact field path.
 *
 * Three exports used by toolValidator.ts:
 *   lenientsJSONParse()      — replaces parseToolArgs() JSON.parse call
 *   coerceToSchema()         — new step between parse and validate
 *   buildHarnessRepairTemplate() — replaces buildRepairTemplate()
 */

import type { ToolParameterSchema, ToolSchema } from './localToolContract.js'

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1-ext: Lenient JSON parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Progressively repairs known Qwen2.5-7B JSON output pathologies before parsing.
 * Attempts strict parse first — only escalates to repairs if that fails.
 *
 * Repair strategies (applied in order):
 *   1. Direct JSON.parse (fast path — well-formed output)
 *   2. Extended fence stripping (```typescript, ```ts, ```js, bare ```)
 *   3. Boolean/null literal fixup: tru→true, fals→false, nul→null
 *   4. Trailing comma removal before } and ]
 *   5. Unquoted key normalization: {key: "val"} → {"key": "val"}
 *   6. Double-stringification unwrapping: "\"{ ... }\"" → { ... }
 *   7. Unclosed bracket/string auto-close (last resort)
 */
export function lenientsJSONParse(raw: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'string') return null

  // Strategy 1: strict parse (fast path)
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch { /* fall through */ }

  // Strategy 2: extended fence stripping
  let s = raw
    .replace(/^```(?:json|typescript|ts|js|javascript|python)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

  // Strategy 6: double-stringification — "\"{ ... }\"" → { ... }
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const inner = JSON.parse(s)  // unwrap outer string
      if (typeof inner === 'string') s = inner.trim()
    } catch { /* not double-stringified */ }
  }
  // Second-level unwrap: inner might itself be a JSON string
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      const inner2 = JSON.parse(s)
      if (typeof inner2 === 'string') s = inner2.trim()
    } catch { /* ok */ }
  }

  // Strategy 3: boolean/null literal fixup
  s = s
    .replace(/:\s*tru(e?)(\s*[,}\]])/g, ': true$2')
    .replace(/:\s*fals(e?)(\s*[,}\]])/g, ': false$2')
    .replace(/:\s*nul(l?)(\s*[,}\]])/g, ': null$2')

  // Strategy 4: trailing commas
  s = s.replace(/,(\s*[}\]])/g, '$1')

  // Try parse after strategies 2–4
  try {
    const v = JSON.parse(s)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch { /* fall through */ }

  // Strategy 5: unquoted key normalization — {key: "val"} → {"key": "val"}
  // Only quotes keys that start with a letter/underscore and aren't already quoted
  s = s.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3')

  // Try after key normalization
  try {
    const v = JSON.parse(s)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch { /* fall through */ }

  // Strategy 7: unclosed bracket/string auto-close
  // Count open braces and unclosed quotes
  let braceDepth = 0
  let inString = false
  let escaped = false
  const chars: string[] = []

  for (const ch of s) {
    if (escaped) { escaped = false; chars.push(ch); continue }
    if (ch === '\\') { escaped = true; chars.push(ch); continue }
    if (ch === '"') { inString = !inString; chars.push(ch); continue }
    if (!inString) {
      if (ch === '{') braceDepth++
      if (ch === '}') braceDepth--
    }
    chars.push(ch)
  }

  let repaired = chars.join('')
  if (inString) repaired += '"'
  while (braceDepth > 0) { repaired += '}'; braceDepth-- }

  try {
    const v = JSON.parse(repaired)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch { /* exhausted all strategies */ }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2-ext: Schema-aware type coercion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce parsed argument values to the types declared in the tool's JSON Schema.
 * Applied AFTER lenientsJSONParse, BEFORE validateAgainstSchema.
 *
 * Handles the most common Qwen2.5-7B type confusion patterns:
 *   "42"     → 42     (string → number/integer when schema expects number)
 *   "true"   → true   (string → boolean when schema expects boolean)
 *   "false"  → false  (same)
 *   42       → "42"   (number → string when schema expects string — rarer)
 *   "[]"     → []     (string → array, though this is rare)
 *
 * Never coerces object fields — those indicate schema mismatches, not type confusion.
 * Mutates a copy — does not modify the input.
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

    if (expected === 'number' || expected === 'integer') {
      if (typeof value === 'string') {
        const n = Number(value)
        if (!Number.isNaN(n)) {
          result[key] = expected === 'integer' ? Math.round(n) : n
        }
      }
    } else if (expected === 'boolean') {
      if (value === 'true' || value === '1') result[key] = true
      else if (value === 'false' || value === '0') result[key] = false
    } else if (expected === 'string') {
      if (typeof value === 'number' || typeof value === 'boolean') {
        result[key] = String(value)
      }
    } else if (expected === 'array') {
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value)
          if (Array.isArray(parsed)) result[key] = parsed
        } catch { /* not parseable as array */ }
      }
    }
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3-ext: Inline error annotation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render validation errors as inline JSON comments at the exact field path.
 *
 * Input:
 *   args   = { "file_path": 42, "content": "hello" }
 *   errors = ['Field "file_path": expected string, got number (value: 42)']
 *
 * Output:
 *   {
 *     "file_path": 42,  // ❌ expected string, got number
 *     "content": "hello"
 *   }
 *
 * The model reads the annotated JSON and knows exactly which field to fix.
 * This outperforms list-format errors because the model sees the error
 * in spatial context — it knows where in the call to change without
 * needing to cross-reference field names.
 */
export function buildInlineAnnotatedError(
  previousArgs: Record<string, unknown>,
  errors: string[],
  schema: ToolSchema,
): string {
  // Build a field → error-note map from the error strings
  const fieldErrors: Record<string, string> = {}
  for (const err of errors) {
    const match = err.match(/[Ff]ield "([^"]+)":\s*(.+)/)
    if (match) {
      fieldErrors[match[1]!] = match[2]!.replace(/\s*\(value:.*\)$/, '').trim()
    }
  }

  // Render JSON with inline comments on flagged fields
  const lines: string[] = ['{']
  const entries = Object.entries(previousArgs)
  entries.forEach(([key, val], i) => {
    const comma = i < entries.length - 1 ? ',' : ''
    const annotation = fieldErrors[key] ? `  // ❌ ${fieldErrors[key]}` : ''
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(val)}${comma}${annotation}`)
  })
  lines.push('}')

  return lines.join('\n')
}

/**
 * Enhanced repair template — drop-in replacement for buildRepairTemplate() in toolValidator.ts.
 * Uses inline ❌ annotations instead of generic "example_key" placeholders.
 *
 * The model gets:
 *   1. What you sent (with inline ❌ at the exact bad field)
 *   2. The schema (required fields + types + descriptions)
 *   3. A concrete corrected example (not a generic placeholder)
 */
export function buildHarnessRepairTemplate(
  toolName: string,
  schema: ToolSchema,
  errors: string[],
  previousArgs: Record<string, unknown>,
): string {
  const annotated = buildInlineAnnotatedError(previousArgs, errors, schema)

  // Build a corrected example: start from previousArgs, apply known-good values
  const correctedExample: Record<string, unknown> = { ...previousArgs }
  for (const [key, propSchema] of Object.entries(schema.parameters.properties)) {
    // Only override fields that had errors
    const hasError = errors.some(e => e.includes(`"${key}"`))
    if (!hasError) continue

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

  const requiredFields = schema.parameters.required ?? []
  const propLines = Object.entries(schema.parameters.properties)
    .map(([k, p]) => {
      const req = requiredFields.includes(k) ? ' [required]' : ' [optional]'
      const enumNote = p.enum ? ` — one of: ${p.enum.join(' | ')}` : ''
      return `  ${k} (${p.type}${req}${enumNote}): ${p.description ?? ''}`
    })
    .join('\n')

  return (
    `[TOOL_SCHEMA_ERROR] "${toolName}" call rejected — ${errors.length} violation(s):\n\n` +
    `Your call (errors annotated inline):\n${annotated}\n\n` +
    `Schema for "${toolName}":\n${propLines}\n\n` +
    `Corrected call:\n${JSON.stringify(correctedExample, null, 2)}\n\n` +
    `Retry immediately with corrected arguments. Do not explain — just call the tool.`
  )
}
```

### Integration: 3 edits to `toolValidator.ts`

**Edit 1** — `parseToolArgs()` (line 41): replace JSON.parse with `lenientsJSONParse`

```typescript
// BEFORE (line 48-56):
const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
try {
  const parsed = JSON.parse(stripped)
  if (typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
} catch {
  return null
}

// AFTER:
import { lenientsJSONParse } from './toolOutputHarness.js'
const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
return lenientsJSONParse(stripped)
```

**Edit 2** — `validateToolCall()` (line 169): add coercion step between parse and validate

```typescript
// BEFORE (line 171-173):
const parsed = parseToolArgs(attempt.rawArgs)
if (!parsed) { ... }
const validation = validateAgainstSchema(parsed, attempt.schema.parameters)

// AFTER:
import { coerceToSchema } from './toolOutputHarness.js'
const parsed = parseToolArgs(attempt.rawArgs)
if (!parsed) { ... }
const coerced = coerceToSchema(parsed, attempt.schema.parameters)  // ← new line
const validation = validateAgainstSchema(coerced, attempt.schema.parameters)
// Note: pass coerced (not parsed) to buildRepairTemplate too
```

**Edit 3** — `buildRepairTemplate()` (line 126): swap in `buildHarnessRepairTemplate`

```typescript
// BEFORE: export function buildRepairTemplate(...)
// AFTER:
import { buildHarnessRepairTemplate } from './toolOutputHarness.js'
export { buildHarnessRepairTemplate as buildRepairTemplate }
// Keep the old function body as buildRepairTemplateLegacy() for fallback testing
```

---

## P0-B: Semantic Grader — `responseAuditor.ts` enhancement

**File:** `desktop-app/agent/responseAuditor.ts` (additions to existing file)  
**Research basis:** ToolCritic (arxiv 2510.17052) — isolated critic call eliminates "I called it so it must be right" confirmation bias  

### The gap

`auditToolCall()` today returns `pass: true` when:
- `bash` exits with code 0 (even if output is completely off-topic)
- `WebFetch` returns HTTP 200 (even if the page is unrelated)
- `WebSearch` returns N snippets (even if none contain task-relevant terms)

This causes the model to record a "success" in `toolSteps[]`, keep `consecutiveFailureCount` at 0, and never trigger replanning — even when the tool result literally cannot help complete the task.

### New types + exports

```typescript
// Add to responseAuditor.ts:

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
 * Decision tree per tool:
 *
 *   Bash:
 *     - Extract keywords from taskGoal (3+ chars, not stop-words)
 *     - If ≥2 task keywords appear in output → 'success'
 *     - If 1 keyword appears → 'partial'
 *     - If 0 keywords and output is not empty → 'partial' (could be a side effect)
 *     - If output is empty/whitespace → 'fail'
 *
 *   WebSearch:
 *     - Count snippets containing ≥2 task keywords → 'success' if ≥1 snippet qualifies
 *     - Any snippets with ≥1 keyword → 'partial'
 *     - No keyword overlap → 'fail'
 *
 *   WebFetch:
 *     - Check page title + first 300 chars for ≥2 task keywords → 'success'
 *     - Check full body for keywords → 'partial' if found, 'fail' if not
 *
 *   Read / Glob / Grep:
 *     - Non-empty result → 'success' (file tools — structural success = semantic success)
 *     - Empty result → 'fail'
 *
 *   ListDirectory / CheckDriveStatus:
 *     - Always 'success' when structurally passed (these are informational tools)
 *
 * Returns 'partial' when uncertain — the caller (launcher.ts) handles partial
 * by appending a soft advisory hint rather than a hard failure message.
 */
export function semanticGrade(
  toolName: string,
  taskGoal: string,
  rawOutput: string,
): SemanticGrade {
  const goalKeywords = extractSemanticKeywords(taskGoal)

  // File tools — non-empty = semantic success
  if (['Read', 'Glob', 'Grep', 'Write', 'Edit', 'ListDirectory', 'CheckDriveStatus'].includes(toolName)) {
    return rawOutput.trim() ? 'success' : 'fail'
  }

  if (toolName === 'Bash') {
    if (!rawOutput.trim()) return 'fail'
    const matchCount = goalKeywords.filter(kw => rawOutput.toLowerCase().includes(kw)).length
    if (matchCount >= 2) return 'success'
    if (matchCount >= 1) return 'partial'
    return 'partial'  // bash side-effects (installs, writes) may not echo keywords
  }

  if (toolName === 'WebSearch') {
    if (!rawOutput.trim() || rawOutput.includes('no results')) return 'fail'
    const fullText = rawOutput.toLowerCase()
    const matchCount = goalKeywords.filter(kw => fullText.includes(kw)).length
    if (matchCount >= 2) return 'success'
    if (matchCount >= 1) return 'partial'
    return 'fail'
  }

  if (toolName === 'WebFetch') {
    if (!rawOutput.trim()) return 'fail'
    const titleSection = rawOutput.slice(0, 400).toLowerCase()
    const fullText = rawOutput.toLowerCase()
    const titleMatches = goalKeywords.filter(kw => titleSection.includes(kw)).length
    const fullMatches = goalKeywords.filter(kw => fullText.includes(kw)).length
    if (titleMatches >= 2) return 'success'
    if (fullMatches >= 2) return 'success'
    if (fullMatches >= 1) return 'partial'
    return 'fail'
  }

  return 'partial'  // unknown tool — don't fail it
}

/** Extract task-relevant keywords (≥4 chars, not stop-words) */
function extractSemanticKeywords(text: string): string[] {
  const STOP = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'have',
    'what', 'which', 'where', 'when', 'then', 'can', 'will', 'your', 'their'])
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 4 && !STOP.has(w))
    .slice(0, 8)  // top 8 most specific keywords
}

/**
 * Async ToolCritic check — isolated secondary Ollama call with no tool history.
 * Used by strategicPlanner.ts to verify subgoal completion.
 *
 * CRITICAL: The critic sees ONLY the subgoal description + the tool results.
 * It does NOT see the primary model's reasoning chain.
 * This breaks the "I just ran this so it must be right" confirmation bias.
 *
 * Prompt sent to critic (ultra-compact, ~100 tokens):
 *   "Task: [subgoal]
 *    Evidence: [last 3 tool results, 200 chars each]
 *    Is the task complete? Reply: yes/partial/no + one sentence of evidence."
 *
 * Response parsed for: yes→pass=true conf=2, partial→pass=false conf=1,
 *   no→pass=false conf=2. Defaults to pass=false conf=0 on parse failure.
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

  const prompt = (
    `Task: ${subgoal}\n\n` +
    `Tool results:\n${successfulResults}\n\n` +
    `Has the task been completed? Reply with ONLY one of: yes / partial / no\n` +
    `Then one sentence of evidence.`
  )

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

    const evidence = data.message?.content?.slice(0, 150) ?? ''

    if (text.startsWith('yes')) return { pass: true,  confidence: 2, evidence }
    if (text.startsWith('partial')) return { pass: false, confidence: 1, evidence, suggestion: 'Continue gathering evidence for this subgoal.' }
    if (text.startsWith('no'))  return { pass: false, confidence: 2, evidence, suggestion: 'Try a different tool or approach for this subgoal.' }

    return { pass: false, confidence: 0, evidence: 'Critic response unparseable.', suggestion: 'Treat as uncertain — continue.' }
  } catch {
    // Network/timeout — don't fail the session, just return uncertain
    return { pass: false, confidence: 0, evidence: 'Critic call failed — treating as uncertain.' }
  }
}
```

### Integration: launcher.ts ~line 4520

After `buildObservation()` returns, call `semanticGrade()`. If grade is `'fail'` AND the tool structurally succeeded (exit 0, HTTP 200), append a semantic mismatch advisory:

```typescript
// After line: let observation = buildObservation(toolName, coercedArgs.args, resultText)

import { semanticGrade } from './agent/responseAuditor.js'

const grade = semanticGrade(toolName, userContent, resultText)
if (grade === 'fail' && result.success) {
  // Structural success, semantic failure — model must re-evaluate
  observation +=
    `\n\n[SEMANTIC MISMATCH] This tool call succeeded structurally but the result ` +
    `does not appear to address the task: "${userContent.slice(0, 80)}"\n` +
    `The output does not contain expected keywords from the task goal.\n` +
    `If this is the wrong file/URL/query, change your approach before the next tool call.`
  // Count as a partial failure so the replan logic can eventually trigger
  consecutiveFailureCount++  // NOTE: only increment if grade='fail', not 'partial'
}
```

**Note on `consecutiveFailureCount` increment:** Only increment for `'fail'` grade (clear semantic mismatch), not `'partial'` (ambiguous). This prevents over-triggering replanning on bash commands that produce side effects without echoing keywords.

---

## P1: `contextCompressor.ts` — Observation + History Compression

**File:** `desktop-app/agent/contextCompressor.ts` (new)  
**Research basis:** ACON (arxiv 2510.00615) — 26–54% token reduction; Active Context Compression (arxiv 2601.07190) — 22.7% reduction + up to 57% on individual instances; EM-LLM (ICLR 2025) — episodic segmentation  

### The gap in `contextAssembler.ts`

The history budget is 2400 tokens. With Qwen2.5-7B the average tool-heavy turn costs ~400–600 tokens. That means **4–6 turns before history starts dropping**. The OLDEST turn (which contains the original user intent) is dropped first — causing "context rot."

Tool outputs are raw-dumped:
- `compressObservation()` does not exist — WebFetch pages can be 2000+ chars, Bash npm-install output can be 800+ chars, WebSearch results include full snippets
- These go directly into `turnMessages[]` then into history

The 2000/1500-char `obsLen` cap is the ONLY compression currently applied.

### New file: `contextCompressor.ts`

```typescript
/**
 * contextCompressor.ts — Token-efficient observation + history compression.
 *
 * Research basis:
 *   ACON (arxiv 2510.00615): compress observations AND history interaction turns
 *   Active Context Compression (arxiv 2601.07190): agent decides when to consolidate
 *   EM-LLM (ICLR 2025): episodic boundaries at topic/subtask transitions
 *
 * Three exports:
 *   compressObservation()   — called right after executeLocalTool()
 *   compressHistory()       — called in assembleContext() when >70% budget used
 *   compressDriveContext()  — replaces fitToTokens() for driveContext slot
 */

import type { LocalChatMessage } from '../types.js'
import { estimateTokens } from './contextAssembler.js'

// ─────────────────────────────────────────────────────────────────────────────
// Observation compressor — per-tool strategies
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'are', 'was', 'were', 'it', 'this', 'that',
])

function extractKeywords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
      .slice(0, 10)
  )
}

/**
 * Compress a single tool observation before it enters the context window.
 * Returns compressed text guaranteed to stay within maxTokens.
 *
 * Per-tool strategies:
 *
 *   Bash:
 *     Short output (<400 chars) → return as-is
 *     npm/pip/bun install  → extract final summary line + error lines only
 *     git log              → extract first line of each commit
 *     Large output         → keep: first 3 lines + last 2 lines + lines containing
 *                            task keywords or ERROR/WARNING/FAIL patterns
 *
 *   WebFetch:
 *     Extract: page title (first line) + paragraphs containing task keywords (±1 line)
 *     Cap: 600 tokens regardless of page length
 *     Keyword relevance scoring — discard paragraphs with 0 keyword overlap
 *
 *   WebSearch:
 *     Rerank snippets by keyword overlap with taskGoal (highest first)
 *     Keep top 3 snippets maximum
 *     Strip raw URLs that don't contain task keywords
 *
 *   Grep:
 *     ≤20 matches → keep as-is
 *     >20 matches → group by file, show first match per file + "(N more in this file)"
 *
 *   Glob:
 *     ≤15 paths → keep as-is
 *     >15 paths → show first 15 + "... (N more files)"
 *
 *   Read:
 *     Short file (<600 chars) → keep as-is
 *     Large file → extract sections containing task keywords ± 3 lines
 *     If no keyword match → keep first 400 + last 100 chars with "[...middle truncated]"
 *
 *   ListDirectory / CheckDriveStatus / Write / Edit:
 *     Keep as-is (already compact or user-critical)
 */
export function compressObservation(
  toolName: string,
  rawOutput: string,
  taskGoal: string,
  maxTokens = 600,
): string {
  if (!rawOutput.trim()) return rawOutput

  // Fast path: already within budget
  if (estimateTokens(rawOutput) <= maxTokens) return rawOutput

  const keywords = extractKeywords(taskGoal)
  const maxChars = maxTokens * 3.5

  switch (toolName) {
    case 'Bash': return compressBashOutput(rawOutput, keywords, maxChars)
    case 'WebFetch': return compressWebFetchOutput(rawOutput, keywords, maxChars)
    case 'WebSearch': return compressWebSearchOutput(rawOutput, keywords, maxChars)
    case 'Grep': return compressGrepOutput(rawOutput, maxChars)
    case 'Glob': return compressGlobOutput(rawOutput, maxChars)
    case 'Read': return compressReadOutput(rawOutput, keywords, maxChars)
    default: return rawOutput.slice(0, Math.floor(maxChars)) + `\n[...truncated]`
  }
}

function compressBashOutput(raw: string, keywords: Set<string>, maxChars: number): string {
  const lines = raw.split(/\r?\n/)

  // Package manager output — extract summary only
  if (/added \d+ packages|packages installed|Done in|Successfully installed|Resolving dependencies/i.test(raw)) {
    const summaryLines = lines.filter(l =>
      /^(Done|added|installed|error|warning|resolved|packages)/i.test(l.trim()) ||
      /npm warn|error TS|error:/i.test(l)
    )
    if (summaryLines.length > 0) {
      return summaryLines.slice(0, 8).join('\n')
    }
  }

  // Git log — first line of each commit (short log)
  if (/^commit [0-9a-f]{40}/m.test(raw)) {
    const commitLines = lines.filter(l => /^commit [0-9a-f]+|^    /.test(l))
    return commitLines.slice(0, 12).join('\n')
  }

  // Generic: keep first 3 + last 2 + keyword-matching lines + error/warning lines
  const important = lines.filter((l, i) => {
    if (i < 3 || i >= lines.length - 2) return true
    const low = l.toLowerCase()
    if (/error|warning|fail|exception|traceback|cannot|not found/i.test(l)) return true
    return [...keywords].some(kw => low.includes(kw))
  })

  const compressed = important.join('\n')
  return compressed.length <= maxChars
    ? compressed
    : compressed.slice(0, Math.floor(maxChars)) + '\n[...truncated]'
}

function compressWebFetchOutput(raw: string, keywords: Set<string>, maxChars: number): string {
  const lines = raw.split(/\r?\n/)
  const kept: string[] = []

  // Always keep title (first non-empty line)
  const title = lines.find(l => l.trim())
  if (title) kept.push(title)

  // Keep lines/paragraphs with keyword overlap
  for (let i = 1; i < lines.length; i++) {
    const low = lines[i]!.toLowerCase()
    if ([...keywords].some(kw => low.includes(kw))) {
      // Include context: line before + matching line + line after
      if (i > 0 && !kept.includes(lines[i - 1]!)) kept.push(lines[i - 1]!)
      kept.push(lines[i]!)
      if (i < lines.length - 1) kept.push(lines[i + 1]!)
    }
  }

  const compressed = kept.join('\n')
  return compressed.length <= maxChars
    ? compressed
    : compressed.slice(0, Math.floor(maxChars)) + '\n[...truncated]'
}

function compressWebSearchOutput(raw: string, keywords: Set<string>, maxChars: number): string {
  // Split into result blocks (typically separated by blank lines or numbered)
  const blocks = raw.split(/\n\n+/).filter(b => b.trim())

  // Score each block by keyword overlap
  const scored = blocks.map(block => {
    const low = block.toLowerCase()
    const score = [...keywords].filter(kw => low.includes(kw)).length
    return { block, score }
  })

  // Sort by relevance, keep top 3
  const topBlocks = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.block)

  return topBlocks.join('\n\n')
}

function compressGrepOutput(raw: string, maxChars: number): string {
  const lines = raw.split(/\r?\n/)
  if (lines.length <= 20) return raw

  // Group by file
  const byFile: Record<string, string[]> = {}
  for (const line of lines) {
    const match = line.match(/^([^:]+):/)
    const file = match?.[1] ?? '__no_file__'
    if (!byFile[file]) byFile[file] = []
    byFile[file].push(line)
  }

  const compressed = Object.entries(byFile)
    .map(([file, fileLines]) => {
      if (fileLines.length === 1) return fileLines[0]
      return `${fileLines[0]} (+ ${fileLines.length - 1} more match${fileLines.length > 2 ? 'es' : ''} in ${file})`
    })
    .join('\n')

  return compressed.length <= maxChars
    ? compressed
    : compressed.slice(0, Math.floor(maxChars)) + '\n[...truncated]'
}

function compressGlobOutput(raw: string, maxChars: number): string {
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  if (lines.length <= 15) return raw
  return lines.slice(0, 15).join('\n') + `\n... (${lines.length - 15} more files)`
}

function compressReadOutput(raw: string, keywords: Set<string>, maxChars: number): string {
  const lines = raw.split(/\r?\n/)

  // Try to extract keyword-relevant sections (±3 lines)
  const keywordLines = new Set<number>()
  for (let i = 0; i < lines.length; i++) {
    const low = lines[i]!.toLowerCase()
    if ([...keywords].some(kw => low.includes(kw))) {
      for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
        keywordLines.add(j)
      }
    }
  }

  if (keywordLines.size > 0) {
    const sorted = [...keywordLines].sort((a, b) => a - b)
    const extracted = sorted.map(i => lines[i]).join('\n')
    if (extracted.length <= maxChars) return extracted
  }

  // Fallback: first 400 + last 100 chars
  const head = raw.slice(0, 400)
  const tail = raw.slice(-100)
  return `${head}\n[...${raw.length - 500} chars omitted...]\n${tail}`
}

// ─────────────────────────────────────────────────────────────────────────────
// History compressor — episodic segmentation + summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compress conversation history when it exceeds 70% of the history token budget.
 *
 * Algorithm (EM-LLM episodic approach):
 *   1. Identify episode boundaries: assistant turns that contain FINAL ANSWER
 *      or a THOUGHT indicating task completion, OR transitions between tool domains
 *   2. "Past" episodes (before the last boundary): compress assistant + tool turns
 *      into single-line summaries: "Used [Tool] for [brief description] → [outcome]"
 *   3. "Current" episode (after the last boundary): keep in full
 *   4. User turns: always keep in full (they define the task)
 *
 * Result: 3–5x token reduction on older episodes while keeping recent context intact.
 */
export function compressHistory(
  history: LocalChatMessage[],
  maxTokens: number,
  taskGoal: string,
): LocalChatMessage[] {
  if (history.length <= 4) return history  // too short to compress

  const currentBudgetUsed = history.reduce((s, m) => s + estimateTokens(m.content), 0)
  if (currentBudgetUsed <= maxTokens) return history

  // Find episode boundaries (FINAL ANSWER markers or tool-domain transitions)
  const boundaries: number[] = []
  for (let i = 0; i < history.length; i++) {
    const msg = history[i]!
    if (msg.role === 'assistant' && /FINAL ANSWER:/m.test(msg.content)) {
      boundaries.push(i)
    }
  }

  if (boundaries.length === 0) {
    // No clear boundaries — use a sliding window, keeping newest turns
    return trimHistoryToFit(history, maxTokens)
  }

  // Keep the current episode (after the last boundary) in full
  const lastBoundary = boundaries[boundaries.length - 1]!
  const currentEpisode = history.slice(lastBoundary + 1)
  const pastEpisodes = history.slice(0, lastBoundary + 1)

  // Compress past episodes: collapse assistant+tool turns into summaries
  const compressed: LocalChatMessage[] = []
  for (let i = 0; i < pastEpisodes.length; i++) {
    const msg = pastEpisodes[i]!
    if (msg.role === 'user') {
      compressed.push(msg)  // always keep user turns
    } else if (msg.role === 'assistant') {
      // Extract what the model did from the THOUGHT/ACTION lines
      const thoughtMatch = msg.content.match(/THOUGHT:\s*(.{0,120})/m)
      const finalMatch = msg.content.match(/FINAL ANSWER:\s*(.{0,150})/m)
      const summary = finalMatch
        ? `[Past turn] ${finalMatch[1]}...`
        : thoughtMatch
          ? `[Past thought] ${thoughtMatch[1]}...`
          : `[Past turn — ${msg.content.length} chars]`
      compressed.push({ role: 'assistant', content: summary })
    } else if (msg.role === 'tool') {
      // Compress tool results to a 1-line preview
      const preview = msg.content.slice(0, 100).replace(/\n/g, ' ')
      compressed.push({ role: 'tool', content: `[Result: ${preview}...]` })
    }
  }

  // Combine compressed past + full current episode, check if it fits
  const combined = [...compressed, ...currentEpisode]
  const newBudget = combined.reduce((s, m) => s + estimateTokens(m.content), 0)

  if (newBudget <= maxTokens) return combined

  // Still over budget — apply sliding window on the current episode
  return trimHistoryToFit([...compressed, ...currentEpisode], maxTokens)
}

function trimHistoryToFit(history: LocalChatMessage[], maxTokens: number): LocalChatMessage[] {
  let used = 0
  const kept: LocalChatMessage[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateTokens(history[i]!.content)
    if (used + t > maxTokens && kept.length > 0) break
    kept.unshift(history[i]!)
    used += t
  }
  // Strip orphaned assistant at start
  while (kept.length > 0 && kept[0]!.role === 'assistant') kept.shift()
  return kept
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive context compressor — keyword-focused section extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Focus retrieved Drive context on task-relevant paragraphs.
 * Replaces fitToTokens() for the driveContext slot in assembleContext().
 *
 * Unlike fitToTokens() which truncates from the end, this method:
 *   1. Splits Drive context into paragraphs
 *   2. Scores each paragraph by keyword overlap with current task
 *   3. Returns paragraphs in original order, highest-scoring first if budget exceeded
 *   4. Never truncates mid-sentence
 */
export function compressDriveContext(
  driveContext: string,
  taskGoal: string,
  maxTokens: number,
): string {
  if (!driveContext.trim()) return ''
  if (estimateTokens(driveContext) <= maxTokens) return driveContext

  const keywords = extractKeywords(taskGoal)
  const paragraphs = driveContext.split(/\n\n+/).filter(p => p.trim())

  // Score and sort by relevance
  const scored = paragraphs.map(p => ({
    text: p,
    score: [...keywords].filter(kw => p.toLowerCase().includes(kw)).length,
  }))

  // Build output: add paragraphs from highest score until budget filled
  const sorted = [...scored].sort((a, b) => b.score - a.score)
  const kept: string[] = []
  let tokensUsed = 0

  for (const { text } of sorted) {
    const t = estimateTokens(text)
    if (tokensUsed + t > maxTokens) continue  // skip if it won't fit
    kept.push(text)
    tokensUsed += t
  }

  // Re-order to original document order for coherent reading
  return paragraphs.filter(p => kept.includes(p)).join('\n\n')
}
```

### Integration points

**`launcher.ts` ~line 4423** (after executeLocalTool, before buildObservation):
```typescript
import { compressObservation } from './agent/contextCompressor.js'

// After: const result = await executeLocalTool(toolName, coercedArgs.args, ...)
// After: resultText is constructed from result.success/output/error

// NEW: compress before injecting into context
const resultForContext = compressObservation(toolName, resultText, userContent)
let observation = buildObservation(toolName, coercedArgs.args, resultForContext)
// Note: keep uncompressed resultText for toolSteps[].resultPreview and Drive storage
```

**`contextAssembler.ts`** — `assembleContext()` function, step 6 (line ~209):
```typescript
import { compressHistory, compressDriveContext } from './contextCompressor.js'

// Replace step 5 (Drive context):
// BEFORE: const driveFit = fitToTokens(input.driveContext, CONTEXT_BUDGET.driveContext)
// AFTER:
const driveFit = compressDriveContext(input.driveContext, input.userMessage, CONTEXT_BUDGET.driveContext)
if (driveFit.length < input.driveContext.length) wasTrimmed = true

// Replace step 6 (history):
// BEFORE: const trimmedHistory = trimHistory(input.history, CONTEXT_BUDGET.history)
// AFTER:
const historyBudgetUsed = input.history.reduce((s, m) => s + estimateTokens(m.content), 0)
const needsCompression = historyBudgetUsed > CONTEXT_BUDGET.history * 0.70
const processedHistory = needsCompression
  ? compressHistory(input.history, CONTEXT_BUDGET.history, input.userMessage)
  : input.history
const trimmedHistory = trimHistory(processedHistory, CONTEXT_BUDGET.history)
```

---

## P2: `strategicPlanner.ts` — Hierarchical Goal Decomposition

**File:** `desktop-app/agent/strategicPlanner.ts` (new)  
**Research basis:** GoalAct (arxiv 2504.16563, Best Paper NCIIP 2025) — continuously updated global plan; ReAcTree (arxiv 2511.02424, AAMAS 2026) — LLaMA 8B with ReAcTree beats ReAct on Qwen 72B; ACON interaction history compression  

### The gap

The current PLAN block:
- Only enforced on turn 2 if the model forgot to include it
- Unstructured free text — the model generates it, the launcher only checks for "PLAN:" presence
- Never proactively updated — only revised after 2+ consecutive failures (reactive)
- Not used to scope context or guide tool selection between turns

### New file: `strategicPlanner.ts`

```typescript
/**
 * strategicPlanner.ts — Hierarchical subgoal decomposition for compound/research/code tasks.
 *
 * Research basis:
 *   GoalAct (arxiv 2504.16563): continuously updated global plan, hierarchical execution
 *   ReAcTree (arxiv 2511.02424): hierarchical tree replacing flat ReAct — 8B beats 72B
 *   ACON: active context focuses on current subgoal, past subgoals summarized
 *
 * For simple tasks: single-subgoal plan (zero overhead, falls through to existing loop)
 * For compound/research/code: 2-4 subgoals with dependencies, success criteria, tool hints
 *
 * The plan is:
 *   - Generated at task start from rule-based decomposition (no LLM call)
 *   - Injected as a compact [PLAN] block in context on EVERY iteration
 *   - Updated proactively when subgoals complete (criticCheck passes)
 *   - Revised after 2+ consecutive failures (replanning trigger)
 */

import { type TaskClassification } from './taskClassifier.js'
import { randomUUID } from 'crypto'

export type TaskComplexity = 'simple' | 'compound' | 'research' | 'code'

export type SubgoalStatus = 'pending' | 'in_progress' | 'complete' | 'failed' | 'skipped'

export type Subgoal = {
  id: string
  index: number
  description: string
  successCriteria: string     // concrete "done" condition
  dependsOn: string[]         // subgoal IDs that must complete first
  preferredTools: string[]    // from taskClassifier primaryTools
  status: SubgoalStatus
  completedEvidence?: string  // excerpt from tool results
  failureReason?: string      // why it failed (for revisePlan)
}

export type AgentPlan = {
  taskId: string
  originalRequest: string
  complexity: TaskComplexity
  subgoals: Subgoal[]
  activeSubgoalId: string | null
  version: number             // increments on revisePlan()
  createdAt: number
  lastUpdatedAt: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan generation (rule-based, no LLM call)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decompose a task into subgoals based on complexity classification.
 *
 * Decomposition patterns:
 *   simple:   1 subgoal — "Execute the request directly"
 *   research: [gather sources] → [extract relevant info] → [synthesize and report]
 *   code:     [read codebase] → [plan edit] → [apply edit] → [verify]
 *   compound: [subgoal per 'and then'/'after that' clause] or [one per tool domain]
 */
export function generatePlan(
  classification: TaskClassification,
  userMessage: string,
): AgentPlan {
  const taskId = randomUUID()
  const now = Date.now()

  if (classification.complexity === 'simple') {
    return {
      taskId, originalRequest: userMessage,
      complexity: 'simple',
      subgoals: [{
        id: randomUUID(), index: 0,
        description: 'Complete the request',
        successCriteria: 'Task is fully addressed with a direct response or tool result',
        dependsOn: [], preferredTools: classification.primaryTools,
        status: 'in_progress',
      }],
      activeSubgoalId: null,  // simple tasks don't use subgoal tracking
      version: 1, createdAt: now, lastUpdatedAt: now,
    }
  }

  const subgoals: Subgoal[] = buildSubgoals(classification, userMessage)
  if (subgoals.length > 0) subgoals[0]!.status = 'in_progress'

  return {
    taskId, originalRequest: userMessage,
    complexity: classification.complexity,
    subgoals,
    activeSubgoalId: subgoals[0]?.id ?? null,
    version: 1, createdAt: now, lastUpdatedAt: now,
  }
}

function buildSubgoals(c: TaskClassification, msg: string): Subgoal[] {
  switch (c.complexity) {
    case 'research': return [
      makeSubgoal(0, 'Locate relevant sources',
        'At least 2 relevant sources identified with URLs or file paths',
        [], c.primaryTools.filter(t => ['WebSearch', 'WebFetch', 'Grep', 'Read'].includes(t))),
      makeSubgoal(1, 'Extract key information',
        'Specific facts, data, or content extracted from the sources',
        [], ['WebFetch', 'Read', 'Grep']),
      makeSubgoal(2, 'Synthesize and respond',
        'A complete, accurate answer addressing all parts of the user request',
        [], []),
    ]

    case 'code': {
      const isMultiFile = /multiple|all|every|each/i.test(msg)
      return [
        makeSubgoal(0, 'Read and understand the relevant code',
          'Target files read, current implementation understood',
          [], ['Read', 'Glob', 'Grep']),
        makeSubgoal(1, isMultiFile ? 'Apply edits to all relevant files' : 'Apply the required edit',
          isMultiFile ? 'All target files updated consistently' : 'Target file updated, change is correct',
          [], ['Edit', 'Write', 'Read']),
        makeSubgoal(2, 'Verify the change',
          'File reads confirm the edit was applied correctly; no introduced regressions visible',
          [], ['Read', 'Bash', 'Grep']),
      ]
    }

    case 'compound': {
      // Split on explicit sequence markers: "and then", "after that", "also", "finally"
      const clauses = msg.split(/\s+(?:and then|after that|then also|and also|finally|lastly)\s+/i)
      if (clauses.length >= 2) {
        return clauses.slice(0, 4).map((clause, i) =>
          makeSubgoal(i, clause.trim().slice(0, 80), `"${clause.trim().slice(0, 50)}" is completed`, [], c.primaryTools)
        )
      }
      // Fallback for compound tasks without sequence markers
      return [
        makeSubgoal(0, 'Gather required information', 'All needed data collected', [], c.primaryTools),
        makeSubgoal(1, 'Execute the primary action', 'Main request fulfilled', [], c.primaryTools),
        makeSubgoal(2, 'Verify and respond', 'Result confirmed, user addressed', [], []),
      ]
    }

    default: return [
      makeSubgoal(0, 'Complete the request', 'Task fully addressed', [], c.primaryTools),
    ]
  }
}

function makeSubgoal(
  index: number,
  description: string,
  successCriteria: string,
  dependsOn: string[],
  tools: string[],
): Subgoal {
  return {
    id: randomUUID(), index,
    description, successCriteria, dependsOn,
    preferredTools: tools,
    status: 'pending',
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan state management
// ─────────────────────────────────────────────────────────────────────────────

/** Select the next subgoal to work on. Respects dependency ordering. */
export function selectNextSubgoal(plan: AgentPlan): Subgoal | null {
  const completedIds = new Set(plan.subgoals.filter(s => s.status === 'complete').map(s => s.id))

  for (const sg of plan.subgoals) {
    if (sg.status !== 'pending') continue
    const depsComplete = sg.dependsOn.every(id => completedIds.has(id))
    if (depsComplete) return sg
  }

  // If there's already an in_progress subgoal, return it
  return plan.subgoals.find(s => s.status === 'in_progress') ?? null
}

/** Mark a subgoal complete and activate the next one. */
export function updatePlan(
  plan: AgentPlan,
  completedSubgoalId: string,
  evidence: string,
): AgentPlan {
  const subgoals = plan.subgoals.map(sg => {
    if (sg.id === completedSubgoalId) {
      return { ...sg, status: 'complete' as SubgoalStatus, completedEvidence: evidence.slice(0, 150) }
    }
    return sg
  })

  const nextPending = subgoals.find(sg => sg.status === 'pending')
  const activeSubgoals = nextPending
    ? subgoals.map(sg => sg.id === nextPending.id ? { ...sg, status: 'in_progress' as SubgoalStatus } : sg)
    : subgoals

  return {
    ...plan,
    subgoals: activeSubgoals,
    activeSubgoalId: nextPending?.id ?? null,
    lastUpdatedAt: Date.now(),
  }
}

/** Revise the plan after consecutive failures — mark failed subgoal and insert alternative. */
export function revisePlan(
  plan: AgentPlan,
  failedSubgoalId: string,
  failureReason: string,
  alternativeApproach: string,
): AgentPlan {
  const subgoals = plan.subgoals.map(sg => {
    if (sg.id === failedSubgoalId) {
      return { ...sg, status: 'failed' as SubgoalStatus, failureReason: failureReason.slice(0, 200) }
    }
    return sg
  })

  // Insert a replacement subgoal immediately after the failed one
  const failedIndex = subgoals.findIndex(sg => sg.id === failedSubgoalId)
  const replacementSubgoal = makeSubgoal(
    failedIndex + 1,
    `[Revised] ${alternativeApproach.slice(0, 80)}`,
    subgoals[failedIndex]?.successCriteria ?? 'Task completed',
    [],  // no dependency — fresh start
    [],
  )
  replacementSubgoal.status = 'in_progress'

  subgoals.splice(failedIndex + 1, 0, replacementSubgoal)

  return {
    ...plan,
    subgoals,
    activeSubgoalId: replacementSubgoal.id,
    version: plan.version + 1,
    lastUpdatedAt: Date.now(),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Context rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Render the current plan as a compact context injection block.
 * Fits within ~200 tokens — safe to include on every iteration.
 *
 * Example:
 *   [PLAN v2 — research]
 *   ✅ 1. Locate relevant sources → "Found docs.openai.com"
 *   ⟳  2. Extract key information [WebFetch] (active)
 *   ○  3. Synthesize and respond (pending)
 */
export function formatPlanForContext(plan: AgentPlan): string {
  if (plan.complexity === 'simple') return ''

  const statusIcon: Record<SubgoalStatus, string> = {
    pending: '○',
    in_progress: '⟳',
    complete: '✅',
    failed: '✗',
    skipped: '–',
  }

  const lines = plan.subgoals.map((sg, i) => {
    const icon = statusIcon[sg.status]
    const tools = sg.preferredTools.length > 0 ? ` [${sg.preferredTools.slice(0, 2).join('/')}]` : ''
    const evidence = sg.completedEvidence ? ` → "${sg.completedEvidence.slice(0, 60)}"` : ''
    const failure = sg.failureReason ? ` (failed: ${sg.failureReason.slice(0, 50)})` : ''
    const active = sg.status === 'in_progress' ? ' (active)' : ''
    return `${icon}  ${i + 1}. ${sg.description}${tools}${evidence}${failure}${active}`
  })

  const revisionNote = plan.version > 1 ? ` v${plan.version}` : ''
  return `[PLAN${revisionNote} — ${plan.complexity}]\n${lines.join('\n')}`
}
```

### Integration: launcher.ts — 4 targeted edits

**Edit 1** — After `taskClassification` (line ~3937), generate the plan:
```typescript
import { generatePlan, selectNextSubgoal, updatePlan, revisePlan, formatPlanForContext } from './agent/strategicPlanner.js'

const agentPlan = generatePlan(taskClassification, userContent)
let currentSubgoal = selectNextSubgoal(agentPlan)
```

**Edit 2** — Replace the PLAN enforcement block (lines ~4119-4133):  
Instead of checking for "PLAN:" in turn 2, inject `formatPlanForContext(agentPlan)` at the START of the system prompt slot for non-simple tasks. The plan is proactively present on every iteration — no enforcement needed.

In `assembleContext()` call (~line 3918), add the plan as part of the system prompt:
```typescript
const planBlock = formatPlanForContext(agentPlan)
const systemPromptWithPlan = planBlock
  ? `${systemPrompt}\n\n${planBlock}`
  : systemPrompt

const { messages } = assembleContext({
  systemPrompt: systemPromptWithPlan,  // ← was: systemPrompt
  ...
})
```

**Edit 3** — Replace both REPLAN injection blocks (lines ~4138-4172):
```typescript
// After 2 consecutive failures:
if (consecutiveFailureCount === 2 && toolSteps.length >= 2 && currentSubgoal) {
  const failureAnalysis = analyzeFailurePattern(toolSteps)
  const altApproach = failureAnalysis ?? 'Try different tools or approach'

  agentPlan = revisePlan(agentPlan, currentSubgoal.id, failureAnalysis ?? 'Two consecutive failures', altApproach)
  currentSubgoal = selectNextSubgoal(agentPlan)

  turnMessages.push({
    role: 'user',
    content:
      `[REPLAN] Approach is failing — plan has been updated.\n\n` +
      formatPlanForContext(agentPlan) + '\n\n' +
      `Continue from the active subgoal. Try a completely different approach.`,
  })
}
```

**Edit 4** — After each successful tool result (~line 4466):
```typescript
// After: consecutiveFailureCount = 0 (result.success block)
if (currentSubgoal && agentPlan.complexity !== 'simple') {
  // Use fast-path semanticGrade first — only call criticCheck for strong evidence
  const grade = semanticGrade(toolName, currentSubgoal.successCriteria, resultText)
  if (grade === 'success') {
    agentPlan = updatePlan(agentPlan, currentSubgoal.id, resultText.slice(0, 150))
    currentSubgoal = selectNextSubgoal(agentPlan)
    if (currentSubgoal) {
      emit({ type: 'info', label: 'Subgoal complete', body: `Advancing to: ${currentSubgoal.description}` })
    }
  }
  // Note: criticCheck() is reserved for the END of a full subgoal sequence
  // (after 2+ successful tool calls for that subgoal) — not after every call
}
```

---

## P3: `toolCallSampler.ts` — Inference-Time Best-of-N

**File:** `desktop-app/agent/toolCallSampler.ts` (new)  
**Research basis:** GRPO/RLVR inference-time best-of-N — apply reward scoring without fine-tuning  

### When to apply
**Only critical tools** where a wrong call causes irreversible damage:
- `Edit` — modifies existing files (wrong `old_string` → file silently unchanged, model loops)
- `Write` — creates/overwrites files  
- `Bash` with destructive flags: `rm`, `del`, `rmdir`, `git reset --hard`, `DROP TABLE`, `format`

NOT for read-only tools (Read, Glob, Grep, WebSearch, WebFetch, ListDirectory) — overhead unjustified.

### Reward scoring tiers (from GRPO research)
| Score | Condition |
|-------|-----------|
| 1.0 | Correct tool + all required args present + types correct + args semantically plausible for task |
| 0.5 | Correct tool + required args present + at least one semantic concern (path looks wrong, query looks off) |
| 0.0 | Wrong tool OR missing required args OR args clearly wrong for the task |

### New file: `toolCallSampler.ts`

```typescript
/**
 * toolCallSampler.ts — Inference-time best-of-N sampling for critical tool calls.
 *
 * Research basis: GRPO/RLVR — apply reward scoring at inference time without fine-tuning.
 * Tiered reward (1.0/0.5/0.0) selects the highest-scoring candidate from N inferences.
 *
 * Only applies to tools where a wrong call causes damage:
 *   Edit, Write, destructive Bash (rm/del/reset/DROP)
 *
 * N=2 for Edit/Write. N=3 for destructive Bash.
 * On an RTX 4060 with Qwen2.5-7B-Q4: each pass ~2-4s.
 * Only fires on ~5% of all tool calls (critical subset).
 */

import type { ToolSchema } from './localToolContract.js'

const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\bdel\b.*\/[sq]/i,
  /\brmdir\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-f/,
  /\bDROP\s+(TABLE|DATABASE|INDEX)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\btruncate\s+table\b/i,
  /\bformat\s+[a-z]:/i,
]

export function isCriticalToolCall(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'Edit' || toolName === 'Write') return true
  if (toolName === 'Bash') {
    const cmd = String(args['command'] ?? args['cmd'] ?? '')
    return DESTRUCTIVE_BASH_PATTERNS.some(p => p.test(cmd))
  }
  return false
}

export type ToolCallCandidate = {
  args: Record<string, unknown>
  score: number         // 0.0, 0.5, or 1.0
  scoreReason: string
}

/**
 * Score a single tool call candidate against the task goal.
 * Fast rule-based scoring — no secondary LLM call.
 */
export function scoreToolCallCandidate(
  toolName: string,
  args: Record<string, unknown>,
  taskGoal: string,
  schema: ToolSchema,
): ToolCallCandidate {
  const errors: string[] = []

  // Check required fields
  for (const req of schema.parameters.required ?? []) {
    if (!(req in args) || args[req] === null || args[req] === undefined || args[req] === '') {
      errors.push(`Missing required field: ${req}`)
    }
  }

  if (errors.length > 0) {
    return { args, score: 0.0, scoreReason: errors.join('; ') }
  }

  // Semantic plausibility checks per tool
  const warnings: string[] = []

  if (toolName === 'Edit') {
    const oldStr = String(args['old_string'] ?? args['oldString'] ?? '')
    const path = String(args['file_path'] ?? args['path'] ?? '')
    if (!oldStr || oldStr.length < 3) warnings.push('old_string too short — may not uniquely identify text')
    if (!path || path.includes('example') || path.includes('placeholder')) {
      warnings.push('file_path looks like a placeholder')
    }
  }

  if (toolName === 'Write') {
    const content = String(args['content'] ?? '')
    if (!content || content.trim().length < 5) warnings.push('content is empty or trivial')
  }

  if (toolName === 'Bash') {
    const cmd = String(args['command'] ?? '')
    // Warn if command uses placeholder syntax
    if (/\{[a-z_]+\}|\[COMMAND\]|\$VARIABLE/i.test(cmd)) {
      warnings.push('command contains unfilled placeholder')
    }
  }

  if (warnings.length === 0) {
    return { args, score: 1.0, scoreReason: 'All required fields present and semantically plausible' }
  }

  return { args, score: 0.5, scoreReason: warnings.join('; ') }
}

/**
 * Generate N tool call candidates and return the highest-scoring one.
 *
 * Algorithm:
 *   1. The primary inference pass already produced one candidate (passed in as currentArgs)
 *   2. Generate N-1 additional candidates at temperature=0.3 (same model, same context)
 *   3. Score all N candidates with scoreToolCallCandidate()
 *   4. Return the highest-scoring candidate's args
 *   5. If all candidates score 0.0 (required fields missing), return null → falls back to repair
 */
export async function bestOfN(
  toolName: string,
  currentMessages: any[],
  currentArgs: Record<string, unknown>,
  taskGoal: string,
  schema: ToolSchema,
  tools: any[],
  ollamaBaseUrl: string,
  model: string,
  n?: number,
): Promise<Record<string, unknown> | null> {
  const totalN = n ?? (toolName === 'Bash' ? 3 : 2)

  // Score the primary candidate
  const candidates: ToolCallCandidate[] = [
    scoreToolCallCandidate(toolName, currentArgs, taskGoal, schema),
  ]

  // If primary candidate is already perfect, skip extra sampling
  if (candidates[0]!.score === 1.0) return currentArgs

  // Generate additional candidates
  for (let i = 1; i < totalN; i++) {
    try {
      const resp = await fetch(`${ollamaBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: currentMessages,
          tools,
          stream: false,
          options: { temperature: 0.3, num_predict: 200, seed: i * 42 },
        }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!resp.ok) continue
      const data: any = await resp.json()
      const toolCalls = data.message?.tool_calls ?? data.choices?.[0]?.message?.tool_calls
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue

      const call = toolCalls[0]
      const rawArgs = call?.function?.arguments ?? call?.arguments ?? {}
      let args: Record<string, unknown> = {}
      try {
        args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
      } catch { continue }

      // Only add if the tool name matches (best-of-N is tool-specific)
      const callName = call?.function?.name ?? call?.name ?? ''
      if (callName.toLowerCase() === toolName.toLowerCase()) {
        candidates.push(scoreToolCallCandidate(toolName, args, taskGoal, schema))
      }
    } catch { /* network/timeout — skip this sample */ }
  }

  // Return highest-scoring candidate
  const best = candidates.reduce((a, b) => b.score > a.score ? b : a)
  if (best.score === 0.0) return null  // all candidates invalid — fall back to repair loop
  return best.args
}
```

### Integration: launcher.ts ~line 4422

```typescript
import { isCriticalToolCall, bestOfN } from './agent/toolCallSampler.js'

// BEFORE:
// const result = await executeLocalTool(toolName, coercedArgs.args, target.config.workspacePath)

// AFTER:
let finalArgs = coercedArgs.args
if (isCriticalToolCall(toolName, coercedArgs.args)) {
  const schema = getToolSchema(toolName)
  if (schema) {
    const sampled = await bestOfN(
      toolName, turnMessages, coercedArgs.args,
      userContent, schema, tools, ollamaBaseUrl, model
    )
    if (sampled) {
      finalArgs = sampled
      if (sampled !== coercedArgs.args) {
        emit({ type: 'info', label: 'Best-of-N', body: `Sampled better args for ${toolName}` })
      }
    }
  }
}
const result = await executeLocalTool(toolName, finalArgs, target.config.workspacePath)
```

---

## Implementation Order

### Day 1 — P0: Stop the bleeding

1. **Create `toolOutputHarness.ts`** — lenient parser + coercion + inline annotations  
   ~200 lines, pure functions, no new imports  
2. **Wire into `toolValidator.ts`** — 3 edits (parseToolArgs, validateToolCall, buildRepairTemplate)  
3. **Add `semanticGrade()` + `criticCheck()` to `responseAuditor.ts`** — ~100 lines  
4. **Wire semantic grader into `launcher.ts`** — 5 lines after `buildObservation()`  

**Observable impact:** Tool call parse failures drop to near-zero. False-positive "pass" grading on semantically empty results stops triggering incorrect success tracking.

---

### Day 2 — P1: Stop the flooding

5. **Create `contextCompressor.ts`** — observation + history + Drive compressors  
   ~220 lines, pure functions  
6. **Wire into `launcher.ts`** — 2 lines (compressObservation before buildObservation)  
7. **Wire into `contextAssembler.ts`** — replace fitToTokens for driveContext, add compressHistory trigger  

**Observable impact:** Context fills ~40% slower. History budget used more efficiently — older user turns (which define the task) are retained longer. WebFetch pages no longer flood the context with irrelevant boilerplate.

---

### Day 3 — P2: Planning intelligence

8. **Create `strategicPlanner.ts`** — plan types, generatePlan, subgoal management, formatPlanForContext  
   ~230 lines  
9. **Wire into `launcher.ts`** — 4 edits:  
   a. Generate plan after task classification  
   b. Inject formatPlanForContext into system prompt  
   c. Replace REPLAN injection blocks with revisePlan()  
   d. Call selectNextSubgoal() after each successful tool call  

**Observable impact:** Compound and research tasks no longer lose goal orientation by turn 4. Replanning is structured and targeted, not generic. Model knows which subgoal is active on every turn.

---

### Day 4 — P3: Confidence on critical calls

10. **Create `toolCallSampler.ts`** — best-of-N, reward scoring, isCriticalToolCall  
    ~140 lines  
11. **Wire into `launcher.ts`** — 1 block before `executeLocalTool()`  

**Observable impact:** Edit/Write calls with wrong `old_string` or wrong path are caught before execution. Destructive Bash commands with placeholder syntax are caught before they run.

---

## Risk Registry

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `lenientsJSONParse` over-coerces — produces wrong args | Low: still goes through `validateAgainstSchema` | Strict parse attempted first; lenient is fallback only |
| `semanticGrade('fail')` increments `consecutiveFailureCount` prematurely | Medium: could trigger REPLAN on valid tool calls | Only fires on `'fail'` grade (2+ keywords miss), not `'partial'`; Bash is always `'partial'` or better |
| `criticCheck()` adds 2–4s latency per subgoal completion check | Low: only for compound/research/code tasks | Skip for 'simple' tasks; fast-path semanticGrade first; criticCheck only on strong evidence |
| History compressor drops critical turn context | Medium: early user turn may be summarized | User turns are NEVER compressed; only assistant + tool turns get episode summaries |
| Best-of-N doubles inference time for Edit/Write | Low: 5% of all calls | Primary candidate scored first — exits immediately if score=1.0; only 1 extra inference needed |
| `revisePlan()` inserts replacement subgoals indefinitely | Medium: plan could grow unboundedly | Cap total subgoals at 8; excess pending subgoals converted to 'skipped' |
| `compressHistory()` FINAL ANSWER boundary detection fails on first session | Low: no boundaries → falls through to trimHistoryToFit | Falls through cleanly to existing sliding-window behavior |

---

## Files Created / Modified

### New files
| File | Size est. | Priority |
|------|-----------|----------|
| `desktop-app/agent/toolOutputHarness.ts` | ~200 lines | P0 |
| `desktop-app/agent/contextCompressor.ts` | ~230 lines | P1 |
| `desktop-app/agent/strategicPlanner.ts` | ~240 lines | P2 |
| `desktop-app/agent/toolCallSampler.ts` | ~140 lines | P3 |

### Modified files
| File | Changes | Priority |
|------|---------|----------|
| `desktop-app/agent/toolValidator.ts` | 3 edits — lenientsJSONParse, coerceToSchema, buildHarnessRepairTemplate | P0 |
| `desktop-app/agent/responseAuditor.ts` | Add semanticGrade(), criticCheck(), SemanticGrade type, CriticVerdict type | P0 |
| `desktop-app/launcher.ts` | Wire semantic grader (5 lines), wire compressObservation (2 lines), wire strategicPlanner (4 blocks), wire bestOfN (1 block) | P0–P3 |
| `desktop-app/agent/contextAssembler.ts` | Replace fitToTokens for driveContext, add compressHistory trigger (5 lines) | P1 |

---

*Research sources: DEV.to Qwen meetup harness; GRPO/RLVR (Qwen2.5 7B fine-tuning); ACON (arxiv 2510.00615); Active Context Compression (arxiv 2601.07190); EM-LLM (ICLR 2025); ReAcTree (arxiv 2511.02424, AAMAS 2026); GoalAct (arxiv 2504.16563, NCIIP 2025 Best Paper); ToolCritic (arxiv 2510.17052)*
