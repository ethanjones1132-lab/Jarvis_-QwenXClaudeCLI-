/**
 * contextAssembler.ts — Token-budgeted message assembly for the agentic local session.
 *
 * Hard constraint: the RTX 4060 (8 GB VRAM) with Qwen2.5-7B-Instruct at Q4_K_M
 * can safely hold a 8 192-token KV cache.  We reserve 1 024 tokens for the model
 * response, leaving 7 168 tokens for the full context window.
 *
 * Budget allocation:
 *   ┌─────────────────────────┬───────────────┐
 *   │ Slot                    │ Max tokens    │
 *   ├─────────────────────────┼───────────────┤
 *   │ System prompt (static)  │      600      │
 *   │ Memory index (MEMORY.md)│      900      │
 *   │ Journal + identity      │      750      │
 *   │ Few-shot examples       │      400      │
 *   │ Drive retrieved context │    1 200      │
 *   │ Conversation history    │    2 400      │
 *   │ Current user message    │      868      │
 *   ├─────────────────────────┼───────────────┤
 *   │ TOTAL INPUT             │    7 118      │
 *   │ Response reserve        │    1 024      │
 *   │ GRAND TOTAL             │    8 142      │
 *   └─────────────────────────┴───────────────┘
 *
 * Memory expanded (600→900) — MEMORY.md entries now fit with room to spare.
 * Drive trimmed (1800→1200) — Drive context was over-allocated vs. its actual utility.
 * User message expanded (568→868) — longer requests no longer get truncated.
 * Few-shot trimmed (600→400) — model already learned format after first turn.
 * History expanded (2200→2400) — more conversation context for multi-turn tasks.
 * Journal trimmed (800→750) — minor, offset by memory+user gains.
 *
 * The assembler trims each slot to its budget, dropping oldest history turns
 * first, then truncating Drive context, then truncating the journal.  The
 * system prompt and user message are never truncated — they must be authored
 * to fit.
 */

import type { LocalChatMessage } from '../types.js'
import { compressHistory, compressDriveContext } from './contextCompressor.js'

// ─────────────────────────────────────────────────────────────────────────────
// Token estimation (char / 4 approximation — no tiktoken dependency)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Token estimator that accounts for structural character density.
 * JSON, URLs, and code have many punctuation/symbol characters that
 * tokenize at roughly 1.5–2 chars/token rather than prose's 4 chars/token.
 * This prevents the model from exceeding the KV cache on tool-heavy turns.
 */
export function estimateTokens(text: string): number {
  // Count structural chars: JSON punctuation, URL chars, code operators
  const structural = (text.match(/[{}[\]"':,/\\=&?#@!<>|^~%;()+*]/g) ?? []).length
  const prose = text.length - structural
  // Structural chars ≈ 2 chars/token; prose ≈ 4 chars/token
  return Math.ceil(prose / 4 + structural / 2)
}

// ─────────────────────────────────────────────────────────────────────────────
// Budget constants (tokens)
// ─────────────────────────────────────────────────────────────────────────────

export const CONTEXT_BUDGET = {
  system:          600,
  memoryIndex:     900,
  journal:         750,
  fewShot:         400,
  driveContext:    1200,
  history:         2400,
  userMessage:     868,
  responseReserve: 1024,
  total:           8192,
} as const

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hard-truncate a string to fit within a token budget.
 * Uses 3.5 chars/token as a conservative estimate (accounting for some
 * structural character density) so we never silently overflow the KV cache.
 */
function fitToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const maxChars = Math.floor(maxTokens * 3.5)
  return text.slice(0, maxChars)
}

/**
 * Trim the conversation history to fit within the token budget using a
 * sliding window: drop the OLDEST turns first, keeping the most recent context.
 *
 * Pair-aware: never drops the user half of an exchange while keeping the
 * assistant half. An orphaned assistant message at the start of history
 * confuses the model (it sees a response with no preceding question).
 */
function trimHistory(
  history: LocalChatMessage[],
  maxTokens: number,
): LocalChatMessage[] {
  if (history.length === 0) return []

  let tokensUsed = 0
  const kept: LocalChatMessage[] = []

  // Walk backwards — newest turns are kept first
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!
    const t = estimateTokens(msg.content)
    if (tokensUsed + t > maxTokens && kept.length > 0) break
    kept.unshift(msg)
    tokensUsed += t
  }

  // Never start with an orphaned assistant message — the model would see a
  // response without its question, breaking conversational coherence.
  // Also deduct the stripped tokens so the caller's token accounting stays accurate.
  while (kept.length > 0 && kept[0]!.role === 'assistant') {
    tokensUsed -= estimateTokens(kept[0]!.content)
    kept.shift()
  }

  return kept
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembled message types
// ─────────────────────────────────────────────────────────────────────────────

export type AssembledMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
}

export type ContextAssemblyInput = {
  /** Static system prompt from modelProfiles.buildLocalCompatibilityPrompt */
  systemPrompt: string
  /** Contents of MEMORY.md (Claude-style memory index) */
  memoryIndex: string
  /** Journal + identity block from journal.loadJournalContext */
  journalContext: string
  /** Few-shot examples from experienceReplay.buildFewShotBlock */
  fewShotExamples: string
  /** Retrieved Drive context from contextStore.retrieveContext */
  driveContext: string
  /** Full conversation history for this session */
  history: LocalChatMessage[]
  /** The current user message */
  userMessage: string
}

export type ContextAssemblyResult = {
  messages: AssembledMessage[]
  /** Breakdown of tokens actually used per slot */
  tokenUsage: Record<keyof typeof CONTEXT_BUDGET, number>
  /** True if any slot was trimmed to fit */
  wasTrimmed: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Main assembler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assemble the final message array for an Ollama chat/completions request.
 *
 * Enforces the token budget allocation strictly.  The returned messages array
 * is ready to pass directly to the Ollama API.
 */
export function assembleContext(input: ContextAssemblyInput): ContextAssemblyResult {
  let wasTrimmed = false

  // ── 1. System prompt (never truncated — must be authored to fit) ─────────
  const systemTokens = estimateTokens(input.systemPrompt)
  // Soft guard: if the static system prompt alone exceeds its slot, every
  // other slot gets squeezed. Log a warning so over-runs don't silently corrupt
  // the budget — we cannot truncate the system prompt because it would break
  // mid-sentence, but at least we surface the issue.
  if (systemTokens > CONTEXT_BUDGET.system) {
    // Use console.warn so it appears in the Electron main process log without
    // disrupting the response flow.
    console.warn(
      `[contextAssembler] System prompt token overflow: ${systemTokens} tokens > ${CONTEXT_BUDGET.system} budget. ` +
      `Reduce the system prompt by ~${systemTokens - CONTEXT_BUDGET.system} tokens to avoid KV cache pressure.`
    )
  }

  // ── 2. Memory index ───────────────────────────────────────────────────────
  const memoryFit = fitToTokens(input.memoryIndex, CONTEXT_BUDGET.memoryIndex)
  if (memoryFit.length < input.memoryIndex.length) wasTrimmed = true
  const memoryTokens = estimateTokens(memoryFit)

  // ── 3. Journal context ────────────────────────────────────────────────────
  const journalFit = fitToTokens(input.journalContext, CONTEXT_BUDGET.journal)
  if (journalFit.length < input.journalContext.length) wasTrimmed = true
  const journalTokens = estimateTokens(journalFit)

  // ── 4. Few-shot examples ──────────────────────────────────────────────────
  const fewShotFit = fitToTokens(input.fewShotExamples, CONTEXT_BUDGET.fewShot)
  if (fewShotFit.length < input.fewShotExamples.length) wasTrimmed = true
  const fewShotTokens = estimateTokens(fewShotFit)

  // ── 5. Drive retrieved context ────────────────────────────────────────────
  // compressDriveContext() selects paragraphs by keyword relevance to the
  // current task instead of blindly truncating from the end.  This keeps the
  // most task-relevant Drive context even when the total exceeds the budget.
  const driveFit = compressDriveContext(
    input.driveContext, input.userMessage, CONTEXT_BUDGET.driveContext,
  )
  if (driveFit.length < input.driveContext.length) wasTrimmed = true
  const driveTokens = estimateTokens(driveFit)

  // ── 6. History (sliding window + episodic compression) ───────────────────
  // When history usage exceeds 70% of budget, compressHistory() summarises
  // past episode turns into single-line previews before the sliding-window
  // trimmer runs.  User turns are always kept verbatim.
  const rawHistoryTokens = input.history.reduce(
    (sum, m) => sum + estimateTokens(m.content), 0,
  )
  const processedHistory =
    rawHistoryTokens > CONTEXT_BUDGET.history * 0.70
      ? compressHistory(input.history, CONTEXT_BUDGET.history, input.userMessage)
      : input.history
  const trimmedHistory = trimHistory(processedHistory, CONTEXT_BUDGET.history)
  if (trimmedHistory.length < input.history.length) wasTrimmed = true
  const historyTokens = trimmedHistory.reduce(
    (sum, m) => sum + estimateTokens(m.content), 0,
  )

  // ── 7. User message ───────────────────────────────────────────────────────
  const userTokens = estimateTokens(input.userMessage)

  // ── Build the system message body ────────────────────────────────────────
  const systemParts: string[] = [input.systemPrompt]

  if (memoryFit.trim()) {
    systemParts.push(`## Memory Index\n${memoryFit}`)
  }
  if (journalFit.trim()) {
    systemParts.push(journalFit)
  }
  if (fewShotFit.trim()) {
    systemParts.push(fewShotFit)
  }
  if (driveFit.trim()) {
    systemParts.push(`## Retrieved Context\n${driveFit}`)
  }

  const systemContent = systemParts.filter(Boolean).join('\n\n')

  // ── Assemble messages array ───────────────────────────────────────────────
  const messages: AssembledMessage[] = [
    { role: 'system', content: systemContent },
    ...trimmedHistory.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: input.userMessage },
  ]

  return {
    messages,
    tokenUsage: {
      system:          systemTokens,
      memoryIndex:     memoryTokens,
      journal:         journalTokens,
      fewShot:         fewShotTokens,
      driveContext:    driveTokens,
      history:         historyTokens,
      userMessage:     userTokens,
      responseReserve: CONTEXT_BUDGET.responseReserve,
      total: systemTokens + memoryTokens + journalTokens + fewShotTokens +
             driveTokens + historyTokens + userTokens + CONTEXT_BUDGET.responseReserve,
    },
    wasTrimmed,
  }
}

/**
 * Build the Ollama request options object from the config VRAM settings.
 * Pass this as the `options` field in the chat/completions request.
 */
export function buildOllamaOptions(vram: {
  numCtx: number
  flashAttention: boolean
  kvCacheType: string
  numPredict: number
  temperature: number
}): Record<string, unknown> {
  return {
    num_ctx:          vram.numCtx,
    flash_attn:       vram.flashAttention,
    kv_cache_type:    vram.kvCacheType,
    num_predict:      vram.numPredict,
    temperature:      vram.temperature,
    // Keep GPU fully utilized — all layers to VRAM
    num_gpu:          99,
    // Deterministic for tool calls (model will lower temp itself for non-tool turns)
    seed:             -1,
  }
}
