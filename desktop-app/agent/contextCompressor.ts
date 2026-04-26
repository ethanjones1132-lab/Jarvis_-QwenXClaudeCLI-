/**
 * contextCompressor.ts — Token-efficient observation, history, and Drive context compression.
 *
 * Research basis:
 *   ACON (arxiv 2510.00615): 26–54% token reduction by compressing both environment
 *     observations AND interaction history turns
 *   Active Context Compression (arxiv 2601.07190): agent autonomously decides when
 *     to consolidate history — 22.7% reduction, up to 57% on individual instances
 *   EM-LLM (ICLR 2025): episodic segmentation at topic/subtask boundaries — current
 *     episode gets full detail, past episodes get summaries only
 *
 * Three exports:
 *   compressObservation()  — per-tool compression called right after executeLocalTool()
 *   compressHistory()      — called in assembleContext() when history >70% of budget
 *   compressDriveContext() — replaces fitToTokens() for the driveContext slot
 *
 * Design principle: compress at the SOURCE, not at the output.
 * The existing obsLen cap (2000/1500 chars) is a hard ceiling that truncates
 * mid-sentence and drops the tail of tool output regardless of its importance.
 * compressObservation() surgically extracts the high-signal lines BEFORE the
 * cap applies — so what reaches the context window is compact AND complete.
 */

import type { LocalChatMessage } from '../types.js'
import { estimateTokens } from './contextAssembler.js'

// ─────────────────────────────────────────────────────────────────────────────
// Shared keyword extraction
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'this', 'that', 'with', 'from', 'have', 'what',
  'which', 'where', 'when', 'then', 'than', 'just', 'also', 'will',
  'your', 'their', 'there', 'here', 'into', 'about', 'over', 'after',
  'before', 'been', 'some', 'more', 'very', 'make', 'each', 'does',
  'into', 'onto', 'upon', 'such', 'like', 'most', 'only', 'both',
])

export function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP_WORDS.has(w))
      .slice(0, 10),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Observation compressor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compress a single tool observation before it enters turnMessages[].
 *
 * Called immediately after executeLocalTool() returns, before buildObservation().
 * Reduces raw output to the signal lines the model needs — errors, summaries,
 * task-relevant content — discarding repetitive boilerplate.
 *
 * Per-tool strategies:
 *
 *   Bash:
 *     Short output (<= 600 chars) → keep as-is
 *     Package manager (npm/bun/pip/yarn) → summary + error lines only
 *     Git log → first line of each commit only
 *     Large output → head 3 + tail 2 + error/warning lines + keyword lines
 *
 *   WebFetch:
 *     Title (first non-empty line) always kept
 *     Paragraphs with >= 1 task keyword kept (± context line)
 *     Cap at maxTokens regardless of page length
 *
 *   WebSearch:
 *     Rerank result blocks by keyword overlap (highest first)
 *     Keep top 3 blocks
 *
 *   Grep:
 *     <= 20 lines → keep as-is
 *     > 20 lines → group by file: first match + "(N more in file.ts)"
 *
 *   Glob:
 *     <= 15 paths → keep as-is
 *     > 15 paths → first 15 + "... (N more files)"
 *
 *   Read:
 *     Short file (<= 800 chars) → keep as-is
 *     Large file → extract keyword-adjacent lines (± 3) or head+tail fallback
 *
 *   All others → keep as-is (already compact or user-critical)
 */
export function compressObservation(
  toolName: string,
  rawOutput: string,
  taskGoal: string,
  maxTokens = 600,
): string {
  if (!rawOutput || !rawOutput.trim()) return rawOutput

  // Fast path: already within budget
  if (estimateTokens(rawOutput) <= maxTokens) return rawOutput

  const keywords = extractKeywords(taskGoal)
  const maxChars = Math.floor(maxTokens * 3.5)

  switch (toolName) {
    case 'Bash':         return compressBash(rawOutput, keywords, maxChars)
    case 'WebFetch':     return compressWebFetch(rawOutput, keywords, maxChars)
    case 'WebSearch':    return compressWebSearch(rawOutput, keywords, maxChars)
    case 'Grep':         return compressGrep(rawOutput, maxChars)
    case 'Glob':         return compressGlob(rawOutput, maxChars)
    case 'Read':         return compressRead(rawOutput, keywords, maxChars)
    default:
      // Unknown or pass-through tools: hard-truncate as last resort
      return rawOutput.slice(0, maxChars) +
        (rawOutput.length > maxChars ? `\n[...truncated — ${rawOutput.length - maxChars} chars omitted]` : '')
  }
}

// ── Bash ─────────────────────────────────────────────────────────────────────

function compressBash(raw: string, keywords: Set<string>, maxChars: number): string {
  const lines = raw.split(/\r?\n/)

  // Package manager: npm / bun / pip / yarn install output
  if (/added \d+ package|packages installed|done in \d|successfully installed|resolving dependencies|bun install|bun add/i.test(raw)) {
    const summaryLines = lines.filter(l =>
      /^(done|added|installed|found|packages|warning|error|warn|npm warn|bun warn)/i.test(l.trim()) ||
      /error (ts|:|TS)\d+/i.test(l) ||
      /\d+ package/i.test(l),
    )
    if (summaryLines.length > 0) {
      return cap(summaryLines.slice(0, 10).join('\n'), maxChars)
    }
  }

  // Git log: keep first line of each commit
  if (/^commit [0-9a-f]{7,40}/m.test(raw)) {
    const commitLines = lines.filter(l => /^commit [0-9a-f]+/.test(l) || /^    \S/.test(l))
    return cap(commitLines.slice(0, 16).join('\n'), maxChars)
  }

  // General large bash output: keep structural lines + keyword lines
  const important: string[] = []
  const tail = Math.max(0, lines.length - 2)

  lines.forEach((line, i) => {
    if (i < 3 || i >= tail) { important.push(line); return }
    const low = line.toLowerCase()
    if (/error|warning|warn|fail|exception|traceback|cannot|not found|denied|enoent|killed|signal/i.test(line)) {
      important.push(line)
      return
    }
    if ([...keywords].some(kw => low.includes(kw))) {
      important.push(line)
    }
  })

  // Deduplicate consecutive identical lines (common in install output)
  const deduped = important.filter((l, i) => i === 0 || l !== important[i - 1])
  return cap(deduped.join('\n'), maxChars)
}

// ── WebFetch ──────────────────────────────────────────────────────────────────

function compressWebFetch(raw: string, keywords: Set<string>, maxChars: number): string {
  const lines = raw.split(/\r?\n/)
  const kept = new Set<number>()

  // Always keep title (first non-empty line)
  const titleIdx = lines.findIndex(l => l.trim())
  if (titleIdx >= 0) kept.add(titleIdx)

  // Keep lines containing task keywords, plus one line of context either side
  lines.forEach((line, i) => {
    const low = line.toLowerCase()
    if ([...keywords].some(kw => low.includes(kw))) {
      if (i > 0) kept.add(i - 1)
      kept.add(i)
      if (i < lines.length - 1) kept.add(i + 1)
    }
  })

  // If no keyword matches at all, keep opening paragraph (first 10 lines)
  if (kept.size <= 1) {
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      if (lines[i]!.trim()) kept.add(i)
    }
  }

  const sorted = [...kept].sort((a, b) => a - b)
  return cap(sorted.map(i => lines[i]).join('\n'), maxChars)
}

// ── WebSearch ─────────────────────────────────────────────────────────────────

function compressWebSearch(raw: string, keywords: Set<string>, maxChars: number): string {
  // Split into result blocks — typically separated by blank lines or numbered entries
  const blocks = raw.split(/\n\n+/).filter(b => b.trim())
  if (blocks.length <= 3) return cap(raw, maxChars)

  // Score each block by keyword overlap
  const scored = blocks.map(block => {
    const low = block.toLowerCase()
    const score = [...keywords].filter(kw => low.includes(kw)).length
    return { block, score }
  })

  // Sort by relevance, keep top 3
  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(s => s.block)

  return cap(top.join('\n\n'), maxChars)
}

// ── Grep ──────────────────────────────────────────────────────────────────────

function compressGrep(raw: string, maxChars: number): string {
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  if (lines.length <= 20) return raw

  // Group by file path
  const byFile: Record<string, string[]> = {}
  for (const line of lines) {
    // Typical grep output: "path/to/file.ts:42:  content"
    const colonIdx = line.indexOf(':')
    const file = colonIdx > 0 ? line.slice(0, colonIdx) : '__bare__'
    if (!byFile[file]) byFile[file] = []
    byFile[file]!.push(line)
  }

  const compressed = Object.entries(byFile)
    .map(([, fileLines]) => {
      if (fileLines.length === 1) return fileLines[0]
      const extra = fileLines.length - 1
      return `${fileLines[0]}  (+${extra} more match${extra > 1 ? 'es' : ''} in this file)`
    })
    .join('\n')

  return cap(compressed, maxChars)
}

// ── Glob ──────────────────────────────────────────────────────────────────────

function compressGlob(raw: string, maxChars: number): string {
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  if (lines.length <= 15) return raw
  const hidden = lines.length - 15
  return cap(lines.slice(0, 15).join('\n') + `\n... (${hidden} more file${hidden > 1 ? 's' : ''})`, maxChars)
}

// ── Read ──────────────────────────────────────────────────────────────────────

function compressRead(raw: string, keywords: Set<string>, maxChars: number): string {
  const lines = raw.split(/\r?\n/)

  // Try to extract keyword-relevant sections (± 3 lines)
  const relevant = new Set<number>()
  lines.forEach((line, i) => {
    const low = line.toLowerCase()
    if ([...keywords].some(kw => low.includes(kw))) {
      for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
        relevant.add(j)
      }
    }
  })

  if (relevant.size > 0) {
    const sorted = [...relevant].sort((a, b) => a - b)
    const extracted = sorted.map(i => lines[i]).join('\n')
    if (extracted.length <= maxChars) return extracted
    return cap(extracted, maxChars)
  }

  // Fallback: head + tail with omission notice
  const head = raw.slice(0, 500)
  const tail = raw.slice(-150)
  const omitted = raw.length - 650
  if (omitted <= 0) return raw
  return `${head}\n[...${omitted} chars omitted — no keyword matches found...]\n${tail}`
}

// ── Shared cap helper ─────────────────────────────────────────────────────────

function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) + `\n[...truncated]`
}

// ─────────────────────────────────────────────────────────────────────────────
// History compressor — episodic segmentation + summary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compress conversation history when it exceeds 70% of the history token budget.
 *
 * Algorithm (EM-LLM episodic approach):
 *   1. Find episode boundaries: assistant turns containing "FINAL ANSWER:"
 *      indicate a completed task — everything before the last boundary is a
 *      "past episode"
 *   2. Past episodes: collapse assistant + tool turns into compact summaries
 *      ("Used WebSearch → found X"; "Used Bash → installed Y")
 *   3. Current episode (after last boundary): keep in full
 *   4. User turns: ALWAYS kept in full regardless of episode
 *
 * This preserves:
 *   - The original user intent (user turns never compressed)
 *   - The current working context (current episode full)
 *   - Institutional memory (past episodes summarised, not dropped)
 *
 * Falls through to trimHistoryToFit() when no episode boundaries exist —
 * identical behaviour to the existing sliding-window in assembleContext.ts.
 */
export function compressHistory(
  history: LocalChatMessage[],
  maxTokens: number,
  _taskGoal: string,
): LocalChatMessage[] {
  if (history.length <= 4) return history

  // Check if compression is even needed
  const currentUsage = history.reduce((s, m) => s + estimateTokens(m.content), 0)
  if (currentUsage <= maxTokens) return history

  // Find FINAL ANSWER episode boundaries
  const boundaries: number[] = []
  history.forEach((msg, i) => {
    if (msg.role === 'assistant' && /FINAL ANSWER:/m.test(msg.content)) {
      boundaries.push(i)
    }
  })

  // No clear boundaries — fall through to sliding window
  if (boundaries.length === 0) {
    return trimHistoryToFit(history, maxTokens)
  }

  const lastBoundary = boundaries[boundaries.length - 1]!
  const pastEpisode  = history.slice(0, lastBoundary + 1)
  const currentEpisode = history.slice(lastBoundary + 1)

  // Compress past episodes
  const compressed: LocalChatMessage[] = []
  for (let i = 0; i < pastEpisode.length; i++) {
    const msg = pastEpisode[i]!

    if (msg.role === 'user') {
      // User turns always kept verbatim
      compressed.push(msg)
      continue
    }

    if (msg.role === 'assistant') {
      // Distil to a single-line summary — prefer FINAL ANSWER, then THOUGHT
      const finalMatch  = msg.content.match(/FINAL ANSWER:\s*(.{0,160})/m)
      const thoughtMatch = msg.content.match(/THOUGHT:\s*(.{0,120})/m)
      const summary = finalMatch
        ? `[Past response] ${finalMatch[1]!.trim()}...`
        : thoughtMatch
          ? `[Past thought] ${thoughtMatch[1]!.trim()}...`
          : `[Past response — ${msg.content.length} chars compressed]`
      compressed.push({ role: 'assistant', content: summary })
      continue
    }

    if (msg.role === 'tool') {
      // Compress tool result to a 1-line preview
      const preview = msg.content.replace(/\n+/g, ' ').slice(0, 120)
      compressed.push({ role: 'tool', content: `[Result: ${preview}...]` })
      continue
    }

    // Any other role — keep as-is
    compressed.push(msg)
  }

  const combined = [...compressed, ...currentEpisode]
  const newUsage  = combined.reduce((s, m) => s + estimateTokens(m.content), 0)

  if (newUsage <= maxTokens) return combined

  // Still over budget after compression — apply sliding window on combined
  return trimHistoryToFit(combined, maxTokens)
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

  // Never start with an orphaned assistant turn
  while (kept.length > 0 && kept[0]!.role === 'assistant') kept.shift()
  return kept
}

// ─────────────────────────────────────────────────────────────────────────────
// Drive context compressor — keyword-focused paragraph selection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Focus retrieved Drive context on task-relevant paragraphs.
 * Replaces fitToTokens() for the driveContext slot in assembleContext().
 *
 * fitToTokens() truncates from the end — a date-ordered Drive store means
 * the oldest (potentially most relevant) context gets dropped first.
 *
 * This compressor:
 *   1. Splits Drive context into paragraphs
 *   2. Scores each paragraph by keyword overlap with current task
 *   3. Selects highest-scoring paragraphs that fit within maxTokens
 *   4. Re-orders selected paragraphs to original document order
 *   5. Never truncates mid-paragraph — always complete blocks
 *
 * Falls back to fitToTokens behaviour if no paragraphs score above zero
 * (the task has no extractable keywords, or Drive context is all code/JSON).
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

  if (paragraphs.length <= 1) {
    // Single block — hard-truncate as last resort
    return fitToTokens(driveContext, maxTokens)
  }

  // Score each paragraph
  const scored = paragraphs.map((text, originalIndex) => ({
    text,
    originalIndex,
    score: keywords.size > 0
      ? [...keywords].filter(kw => text.toLowerCase().includes(kw)).length
      : 0,
  }))

  // Sort by relevance descending; secondary sort = recency (higher index = newer)
  const sorted = [...scored].sort((a, b) =>
    b.score !== a.score ? b.score - a.score : b.originalIndex - a.originalIndex,
  )

  // Greedily pick paragraphs until budget is full
  const pickedIndices = new Set<number>()
  let tokensUsed = 0

  for (const { text, originalIndex } of sorted) {
    const t = estimateTokens(text)
    if (tokensUsed + t > maxTokens) continue
    pickedIndices.add(originalIndex)
    tokensUsed += t
    if (tokensUsed >= maxTokens * 0.9) break
  }

  if (pickedIndices.size === 0) {
    // No paragraph fits or no keyword scores — fall back to hard truncation
    return fitToTokens(driveContext, maxTokens)
  }

  // Re-order to original document sequence for coherent reading
  return paragraphs
    .filter((_, i) => pickedIndices.has(i))
    .join('\n\n')
}

/** Hard-truncate at the last complete sentence within the char budget. */
function fitToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text
  const maxChars = Math.floor(maxTokens * 3.5)
  const truncated = text.slice(0, maxChars)
  // Try to end on a sentence boundary
  const lastPeriod = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('.\n'),
  )
  return lastPeriod > maxChars * 0.7
    ? truncated.slice(0, lastPeriod + 1)
    : truncated
}
