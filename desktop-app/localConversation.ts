import type { LocalChatMessage } from './types.js'

const MAX_HISTORY_MESSAGES = 12
const MAX_SUMMARY_CHARS = 5000

export type LocalConversationState = {
  history: LocalChatMessage[]
  summary: string
}

function summarizeMessage(message: LocalChatMessage): string {
  const prefix = message.role === 'user' ? 'User' : 'Assistant'
  const normalized = message.content.replace(/\s+/g, ' ').trim()
  const clipped =
    normalized.length > 280 ? `${normalized.slice(0, 277).trim()}...` : normalized
  return `${prefix}: ${clipped}`
}

function mergeSummaries(existingSummary: string, additions: string[]): string {
  const blocks = [existingSummary.trim(), ...additions.map(item => item.trim())]
    .filter(Boolean)
    .join('\n')
    .trim()

  if (blocks.length <= MAX_SUMMARY_CHARS) {
    return blocks
  }

  return blocks.slice(blocks.length - MAX_SUMMARY_CHARS).trim()
}

export function compactLocalConversation(
  history: LocalChatMessage[],
  summary: string,
): LocalConversationState {
  if (history.length <= MAX_HISTORY_MESSAGES) {
    return {
      history,
      summary,
    }
  }

  const keepCount = MAX_HISTORY_MESSAGES
  const toSummarize = history.slice(0, history.length - keepCount)
  const retained = history.slice(history.length - keepCount)
  const additions = toSummarize.map(summarizeMessage)

  return {
    history: retained,
    summary: mergeSummaries(summary, additions),
  }
}
