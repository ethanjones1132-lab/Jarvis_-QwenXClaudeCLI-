/**
 * toolValidator.ts — Three-layer tool call validation and retry loop.
 *
 * Qwen2.5-7B-Instruct has strong native tool-calling but can still produce:
 *   1. Structurally invalid JSON (rare, caught by Layer 1)
 *   2. Correct JSON but wrong argument types or missing required fields (Layer 2)
 *   3. Valid schema but semantically wrong arguments (Layer 3 — LLM self-repair)
 *
 * Layer 1 — JSON parse guard:
 *   Wrap the raw model output in a try/catch.  If JSON.parse fails, inject
 *   an error message back into context and retry once with temperature=0.
 *
 * Layer 2 — Schema validation:
 *   Validate tool arguments against the declared JSON Schema for that tool.
 *   Produce a structured error message listing every field violation and
 *   inject it as a synthetic "tool" result so the model can self-correct.
 *
 * Layer 3 — Semantic self-repair:
 *   After Layer 2 fails twice, give the model the full schema + original
 *   intent and ask it to regenerate the call from scratch.  This is the
 *   "repair template" approach: show the model exactly what went wrong and
 *   what the correct structure looks like.
 *
 * Max retries across all layers: 3 total per tool call.
 */

import type { ToolParameterSchema, ToolSchema, ValidationResult, ToolCallAttempt, ToolCallValidationResult } from './localToolContract.js'
import { LOCAL_TOOL_SCHEMAS as CANONICAL_SCHEMAS, normalizeLocalToolName } from './localToolContract.js'
import { lenientsJSONParse, coerceToSchema, buildHarnessRepairTemplate } from './toolOutputHarness.js'

// Re-export types for consumers that import from toolValidator
export type { ToolParameterSchema, ToolSchema, ValidationResult, ToolCallAttempt, ToolCallValidationResult }

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: JSON parse guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Safely parse a tool call argument payload.
 * Handles both raw JSON strings and already-parsed objects from the Ollama SDK.
 */
export function parseToolArgs(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return {}
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    // Delegate to the lenient harness parser — handles all known Qwen2.5-7B
    // output pathologies: fence variants, tru/fals/nul literals, trailing commas,
    // unquoted keys, double-stringification, and unclosed brackets/strings.
    return lenientsJSONParse(raw)
  }
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: Schema validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a parsed argument object against a tool's parameter schema.
 * Returns all violations in human-readable form for model self-repair.
 */
export function validateAgainstSchema(
  args: Record<string, unknown>,
  schema: ToolParameterSchema,
): ValidationResult {
  const errors: string[] = []

  // Check required fields
  for (const required of schema.required ?? []) {
    if (!(required in args) || args[required] === undefined || args[required] === null) {
      errors.push(`Missing required field: "${required}"`)
    }
  }

  // Check property types
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in args)) continue
    const value = args[key]
    const expectedType = propSchema.type

    const actualType = Array.isArray(value) ? 'array' : typeof value
    const typeMatch =
      actualType === expectedType ||
      (expectedType === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (expectedType === 'number' && typeof value === 'number')

    if (!typeMatch) {
      errors.push(
        `Field "${key}": expected type "${expectedType}" but got "${actualType}" (value: ${JSON.stringify(value).slice(0, 60)})`,
      )
    }

    // Check enum constraint
    if (propSchema.enum && !propSchema.enum.includes(String(value))) {
      errors.push(
        `Field "${key}": value "${value}" is not one of the allowed values: [${propSchema.enum.join(', ')}]`,
      )
    }
  }

  // Warn about unknown fields (don't fail on them — could be model hallucination)
  for (const key of Object.keys(args)) {
    if (!(key in schema.properties)) {
      errors.push(`Unknown field "${key}" — remove it from the call`)
    }
  }

  return errors.length === 0 ? { ok: true, args } : { ok: false, errors }
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: Repair template generator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a self-repair prompt injected as a "tool" role message.
 * The model reads this and regenerates the tool call with corrections.
 */
/**
 * Build a self-repair prompt for the model.
 * Delegates to buildHarnessRepairTemplate() from toolOutputHarness.ts,
 * which produces inline ❌ annotations at the exact field path rather than
 * a generic example with "example_key" placeholders.
 *
 * Kept as a named export so existing call sites outside validateToolCall()
 * continue to work without modification.
 */
export function buildRepairTemplate(
  toolName: string,
  schema: ToolSchema,
  errors: string[],
  previousArgs: Record<string, unknown>,
): string {
  return buildHarnessRepairTemplate(toolName, schema, errors, previousArgs)
}

// ─────────────────────────────────────────────────────────────────────────────
// Full validation pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all three validation layers against a single tool call attempt.
 *
 * Returns either the validated args (ready to pass to the tool executor)
 * or a repair message to inject into the conversation and retry.
 */
export function validateToolCall(attempt: ToolCallAttempt): ToolCallValidationResult {
  // Layer 1: JSON parse (via lenient harness)
  const parsed = parseToolArgs(attempt.rawArgs)
  if (!parsed) {
    const repairMessage = buildHarnessRepairTemplate(
      attempt.toolName,
      attempt.schema,
      ['Could not parse tool arguments as JSON. Arguments must be a valid JSON object.'],
      {},
    )
    return { ok: false, repairMessage, errors: ['JSON parse failure'] }
  }

  // Layer 1.5: Schema-aware type coercion — converts "42"→42, "true"→true, etc.
  // Applied before validation so trivial type mismatches self-heal without a repair loop.
  const coerced = coerceToSchema(parsed, attempt.schema.parameters)

  // Layer 2: Schema validation (on coerced args)
  const validation = validateAgainstSchema(coerced, attempt.schema.parameters)
  if (!validation.ok) {
    const repairMessage = buildHarnessRepairTemplate(
      attempt.toolName,
      attempt.schema,
      validation.errors,
      coerced,
    )
    return { ok: false, repairMessage, errors: validation.errors }
  }

  return { ok: true, args: coerced }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registry — delegates to the canonical schemas in localToolContract.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @deprecated Use LOCAL_TOOL_SCHEMAS from localToolContract.ts directly.
 * Kept for backward compatibility — aliases resolve through normalizeLocalToolName.
 */
export const LOCAL_TOOL_SCHEMAS = CANONICAL_SCHEMAS

/** Look up a tool schema by name. Accepts both canonical and legacy names. */
export function getToolSchema(toolName: string): ToolSchema | null {
  const canonical = normalizeLocalToolName(toolName)
  return CANONICAL_SCHEMAS.find(s => s.name === canonical) ?? null
}

/** Build the tools array for the Ollama chat/completions request body. */
export function buildOllamaToolList(): Array<{ type: 'function'; function: ToolSchema }> {
  return CANONICAL_SCHEMAS.map(schema => ({ type: 'function' as const, function: schema }))
}
