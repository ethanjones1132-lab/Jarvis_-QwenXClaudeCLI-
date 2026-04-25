import type { ModelCatalogEntry } from './types.js'
import { buildToolGuide, SHARED_TOOL_RULES } from './agent/localToolContract.js'

export const QWOPUS_OLLAMA_MODEL = 'qwopus3.5-9b-v3:q4km'
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5-coder:7b'
export const ALTERNATE_OLLAMA_MODEL = QWOPUS_OLLAMA_MODEL
export const REMOVED_OLLAMA_MODELS = ['llama3.1:8b'] as const

// ── Agentic local model — primary model for the full ReAct agent loop ───────
// Preference order (first installed wins):
//   1. qwen2.5:7b-instruct-q4_K_M  — best tool adherence at 7B, native JSON schema
//   2. qwen2.5:7b-instruct          — same model, shorter Ollama tag alias
//   3. qwen2.5:7b                   — default Ollama tag (ships as instruct)
//   4. deepseek-r1:7b               — built-in CoT reasoning, solid fallback
export const AGENTIC_OLLAMA_MODEL = 'qwen2.5:7b-instruct-q4_K_M'
export const AGENTIC_OLLAMA_FALLBACKS = [
  'qwen2.5:7b-instruct',
  'qwen2.5:7b',
  'deepseek-r1:7b',
] as const

// Embedding model — runs on CPU via Ollama, consumes zero VRAM during inference
export const EMBEDDING_OLLAMA_MODEL = 'nomic-embed-text'

type ModelPreset = Omit<ModelCatalogEntry, 'installed'>

type LocalToolPromptStyle = 'native-tool-use' | 'legacy-react'

const KNOWN_MODEL_PRESETS: ModelPreset[] = [
  {
    id: AGENTIC_OLLAMA_MODEL,
    label: 'Qwen2.5 7B Instruct (Agentic)',
    description:
      'Primary agentic local model for Jarvis. Q4_K_M quantization fits in ~4.5 GB VRAM on an RTX 4060, leaving headroom for the KV cache. Supports native JSON function-call schemas, structured CoT reasoning, and the full ReAct tool loop. This is the model that powers the cloud-brain system with Drive context injection and experience replay.',
    role: 'default',
    recommendedMode: 'safe',
    toolReadiness: 'ready-for-tools',
  },
  {
    id: DEFAULT_OLLAMA_MODEL,
    label: 'Qwen2.5 Coder 7B',
    description:
      'Safe-mode fallback for direct chat and code tasks when the agentic loop is disabled. Fastest clean coding model in the local stack.',
    role: 'alternate',
    recommendedMode: 'safe',
    toolReadiness: 'candidate-for-tools',
  },
  {
    id: 'deepseek-r1:7b',
    label: 'DeepSeek R1 7B',
    description:
      'Built-in chain-of-thought reasoning model. Strong agentic fallback when the Qwen instruct model is unavailable. Native <think> tags give structured reasoning at 7B scale.',
    role: 'alternate',
    recommendedMode: 'safe',
    toolReadiness: 'ready-for-tools',
  },
  {
    id: ALTERNATE_OLLAMA_MODEL,
    label: 'Qwopus 3.5 9B v3',
    description:
      'Legacy heavyweight local reasoning model. Keep it available for comparison or experimentation, but it is no longer the preferred default for the Jarvis desktop shell.',
    role: 'alternate',
    recommendedMode: 'safe',
    toolReadiness: 'ready-for-chat',
  },
]

function normalizeModelName(value: string): string {
  return value.trim().toLowerCase()
}

export function getKnownModelCatalog(
  installedModels: string[],
): ModelCatalogEntry[] {
  const installedSet = new Set(installedModels.map(normalizeModelName))
  const known = KNOWN_MODEL_PRESETS.map(preset => ({
    ...preset,
    installed: installedSet.has(normalizeModelName(preset.id)),
  }))

  const knownIds = new Set(known.map(entry => normalizeModelName(entry.id)))
  const extras = installedModels
    .filter(model => !knownIds.has(normalizeModelName(model)))
    .map<ModelCatalogEntry>(model => ({
      id: model,
      label: model,
      installed: true,
      description:
        'Installed locally. Custom model with no launcher-specific tuning profile yet.',
      role: 'alternate',
      recommendedMode: 'safe',
      toolReadiness: 'candidate-for-tools',
    }))

  return [...known, ...extras]
}

export function getRecommendedOllamaModel(installedModels: string[]): string {
  const installedSet = new Set(installedModels.map(normalizeModelName))
  // Walk the agentic preference chain — first installed wins
  for (const candidate of [AGENTIC_OLLAMA_MODEL, ...AGENTIC_OLLAMA_FALLBACKS]) {
    if (installedSet.has(normalizeModelName(candidate))) {
      return candidate
    }
  }
  if (installedSet.has(normalizeModelName(DEFAULT_OLLAMA_MODEL))) {
    return DEFAULT_OLLAMA_MODEL
  }
  if (installedModels.length > 0) {
    return installedModels[0]!
  }
  return AGENTIC_OLLAMA_MODEL
}

export function isAgenticModel(model: string): boolean {
  const n = normalizeModelName(model)
  return n.includes('instruct') || n.includes('deepseek-r1')
}

/**
 * Given the configured model, return the model that should ACTUALLY be used
 * for an agentic (ReAct) session.
 *
 * The coder variant (qwen2.5-coder) lacks the instruct fine-tuning for ReAct
 * format adherence. If the user has the coder model configured but the instruct
 * model is also installed, silently prefer the instruct model. This is the #1
 * cause of ReAct format violations in practice.
 */
export function resolveAgenticModel(
  configuredModel: string,
  installedModels: string[],
): { model: string; wasOverridden: boolean; reason: string | null } {
  const normalized = normalizeModelName(configuredModel)

  // If the configured model is already an instruct variant, use it as-is
  if (isAgenticModel(configuredModel)) {
    return { model: configuredModel, wasOverridden: false, reason: null }
  }

  // Non-instruct model configured — try to find a better agentic model
  const installedSet = new Set(installedModels.map(normalizeModelName))

  if (installedSet.has(normalizeModelName(AGENTIC_OLLAMA_MODEL))) {
    return {
      model: AGENTIC_OLLAMA_MODEL,
      wasOverridden: true,
      reason: `Switched from "${configuredModel}" to "${AGENTIC_OLLAMA_MODEL}" for agentic mode — the instruct variant has significantly better tool call and ReAct format adherence.`,
    }
  }

  // No instruct model available — fall back to configured model with a warning
  return {
    model: configuredModel,
    wasOverridden: false,
    reason: `Warning: "${configuredModel}" is not an instruct model. ReAct format violations are likely. Install "${AGENTIC_OLLAMA_MODEL}" for reliable agentic behavior.`,
  }
}

export function buildLocalCompatibilityPrompt(options: {
  model: string
  disableToolsForLocal: boolean
  enableExperimentalLocalTools: boolean
  disableThinkingForLocal: boolean
  /**
   * Native tool-use guidance is for Claude-child/shared sessions.
   * Legacy ReAct guidance is reserved for the direct in-process Ollama loop.
   */
  toolPromptStyle?: LocalToolPromptStyle
  appendSystemPrompt: string
  conversationSummary?: string
  /** Injected OS/path context so the model knows where it is running */
  runtimeContext?: string
  /** Injected capability status — Drive connected, memory path, etc. */
  capabilityContext?: string
  /** Companion stat values (0–100) that tune Jarvis response personality */
  companionStats?: Record<string, number>
}): string {
  const parts: string[] = [
    'You are Jarvis — a local AI agent assistant running inside a desktop application on the user\'s Windows PC. You are powered by a local Ollama model. You are NOT Claude, do NOT say you were created by Anthropic, and do NOT introduce yourself as anything other than Jarvis. If asked who you are, say: "I\'m Jarvis, your local AI agent."',
    'Prioritize direct, useful engineering help over roleplay or filler.',
    'Do not emit chain-of-thought. Give concise conclusions, code, and next actions.',
    'HONESTY RULE: If a tool fails or you cannot complete a task, say so plainly. Never invent or fabricate a summary, directory listing, or file content that you did not actually retrieve from a tool. If you do not have tool output for a request, say "I was not able to retrieve that" and explain why.',
  ]

  // ── Companion stat personality modulation ─────────────────────────────────
  if (options.companionStats && Object.keys(options.companionStats).length > 0) {
    const s = options.companionStats
    const traits: string[] = []
    if ((s['SNARK'] ?? 0) > 65) traits.push('dry and direct — cut filler, do not over-explain, be blunt when clarity demands it')
    if ((s['WISDOM'] ?? 0) > 65) traits.push('analytical — lead with the big-picture implication before diving into details')
    if ((s['DEBUGGING'] ?? 0) > 65) traits.push('diagnostic — proactively flag edge cases, failure modes, and hidden assumptions')
    if ((s['CHAOS'] ?? 0) > 65) traits.push('exploratory — willing to propose unconventional or non-obvious approaches')
    if ((s['PATIENCE'] ?? 0) > 65) traits.push('thorough — take time to explain the why, not just the what')
    if (traits.length > 0) {
      parts.push(
        `Response personality for this session (shaped by your companion\'s character):\n` +
        traits.map(t => `- ${t}`).join('\n')
      )
    }
  }

  const normalizedModel = normalizeModelName(options.model)
  const useLegacyReactToolLoop = options.toolPromptStyle === 'legacy-react'
  const toolsAreEnabled = options.enableExperimentalLocalTools && !options.disableToolsForLocal

  if (
    normalizedModel.includes('qwen2.5') &&
    normalizedModel.includes('instruct') &&
    useLegacyReactToolLoop &&
    toolsAreEnabled
  ) {
    // Primary agentic model — strict ReAct loop. Keep this block under ~450 tokens total.
    parts.push(
      'AGENT FORMAT — follow exactly on every turn:\n' +
      'THOUGHT: [Write 2-3 sentences covering all four: (1) what the user needs, (2) what tool results have revealed so far, (3) what this next tool call will do and why it will succeed where prior attempts did not, (4) what you will do if it fails.]\n' +
      'ACTION: [One tool call — strict JSON, no fences, no extra fields.]\n' +
      '...repeat until complete, then:\n' +
      'THOUGHT: [The task is complete. Evidence from tool results: (state the specific result that proves the task is done.)]\n' +
      'FINAL ANSWER: [Direct response to the user. Plain prose only — no ACTION:, THOUGHT:, or OBSERVATION: lines.]',
    )
    parts.push(
      'RULES (non-negotiable):\n' +
      '1. THOUGHT must come before every ACTION — system rejects any action without it.\n' +
      '2. One tool call per turn. Never two.\n' +
      '3. On error: diagnose root cause in THOUGHT, change arguments, then retry. Never retry identical calls.\n' +
      '4. [PREFLIGHT BLOCK] = tool rejected before running. Read the reason, fix args, retry.\n' +
      '5. [DEAD-END DETECTED] = stop all tools, give FINAL ANSWER explaining what failed.\n' +
      '6. Diagnostic/behavioral questions ("why did you do X?", "stop and explain", "why are you doing this?") = answer from conversation history only, no tools.\n' +
      '7. Never ALL CAPS. Never fabricate tool output. Never invent file paths or URLs.\n' +
      '8. FINAL ANSWER must be plain prose only. Never write "ACTION:", "THOUGHT:", or "OBSERVATION:" inside a FINAL ANSWER block. The user only sees FINAL ANSWER — they cannot see THOUGHT or ACTION.',
    )
    parts.push(buildToolGuide())
  } else if (normalizedModel.includes('qwopus3.5-9b-v3')) {
    parts.push(
      'Use structured reasoning internally, but keep the visible answer tight, practical, and execution-oriented.',
    )
    parts.push(
      'When solving engineering tasks, plan briefly, then move directly into precise edits or commands.',
    )
  } else if (normalizedModel.includes('qwen2.5-coder')) {
    parts.push(
      'Bias toward code-first answers, exact edits, and explicit file-oriented reasoning.',
    )
    if (useLegacyReactToolLoop && toolsAreEnabled) {
    parts.push(
      'You are operating in agentic mode with access to real tools. USE THEM — do not describe tool calls in text, do not show JSON examples to the user, do not ask the user to run the tool. Call the tool directly and report the result.',
    )
    parts.push(
      'NEVER output JSON tool call objects as text or code blocks in your response. The only valid way to invoke a tool is through the native function-call mechanism.',
    )
    parts.push(
      'If a tool returns an error, read the error message, correct the arguments (especially file paths), and retry immediately.',
    )
    }
  }

  if (options.capabilityContext?.trim()) {
    parts.push(options.capabilityContext.trim())
  }

  if (options.runtimeContext?.trim()) {
    parts.push(options.runtimeContext.trim())
  }

  if (toolsAreEnabled && !useLegacyReactToolLoop) {
    parts.push(
      'When tools are available, call them directly through the runtime\'s native tool-use mechanism - never describe the tool invocation in user-facing prose, and never route it through SendUserMessage or SendMessage. Tool calls are not messages.',
    )
    parts.push(
      'Tool arguments must match the runtime schema exactly, with no commentary, no markdown fences, and no invented fields.',
    )
    for (const rule of SHARED_TOOL_RULES) {
      parts.push(rule)
    }
    parts.push(buildToolGuide())
  }

  if (useLegacyReactToolLoop && toolsAreEnabled) {
    for (const rule of SHARED_TOOL_RULES) {
      parts.push(rule)
    }
  }

  if (!toolsAreEnabled) {
    parts.push(
      'Tools are disabled in this mode. Never claim to have called tools or inspected files unless the user provided the content in chat.',
    )
  }

  if (options.disableThinkingForLocal) {
    parts.push(
      'Do not include hidden reasoning markers, thinking tags, or scratchpad output.',
    )
  }

  if (options.conversationSummary?.trim()) {
    parts.push(`Prior session summary:\n${options.conversationSummary.trim()}`)
  }

  if (options.appendSystemPrompt.trim()) {
    parts.push(options.appendSystemPrompt.trim())
  }

  return parts.join('\n\n')
}
