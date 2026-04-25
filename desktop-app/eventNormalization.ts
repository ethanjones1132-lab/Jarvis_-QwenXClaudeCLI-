import type {
  NormalizedJarvisDisplayRole,
  NormalizedJarvisEvent,
  NormalizedJarvisEventKind,
  NormalizedJarvisEventPhase,
} from './types.js'

type NormalizeOptions = {
  sessionId?: string | null
  turnId?: string | null
  now?: number
}

function asRecord(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return null
}

function parseTimestamp(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) {
      return ms
    }
  }
  return fallback
}

function createSyntheticId(): string {
  const maybeCrypto = (globalThis as any).crypto
  if (maybeCrypto && typeof maybeCrypto.randomUUID === 'function') {
    return maybeCrypto.randomUUID()
  }
  return `jarvis-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function unwrapMessagePayload(rawMessage: unknown): Record<string, any> {
  const root = asRecord(rawMessage)
  if (!root) {
    return {}
  }
  if (root.type === 'message') {
    const nested = asRecord(root.message)
    if (nested) {
      return nested
    }
  }
  return root
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim()
  }
  if (!Array.isArray(content)) {
    return ''
  }
  return content
    .map(block => {
      const typed = asRecord(block)
      if (!typed) {
        return ''
      }
      if (typeof typed.text === 'string') {
        return typed.text
      }
      if (typeof typed.connector_text === 'string') {
        return typed.connector_text
      }
      if (typeof typed.content === 'string') {
        return typed.content
      }
      if (typeof typed.output === 'string') {
        return typed.output
      }
      return ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
}

function extractStreamEventText(payload: Record<string, any>): string {
  const event = asRecord(payload.event)
  const delta = asRecord(event?.delta)
  return (
    firstString([
      delta?.text,
      delta?.partial_json,
      event?.text,
      payload.text,
      payload.output,
    ]) ?? ''
  )
}

function extractMessageText(
  payload: Record<string, any>,
  kind: NormalizedJarvisEventKind,
  subtype: string | null,
): string {
  if (kind === 'stream_event') {
    return extractStreamEventText(payload)
  }

  if (kind === 'assistant' || kind === 'user' || kind === 'streamlined_text') {
    const content =
      payload.message?.content ??
      payload.content ??
      payload.message?.message?.content ??
      payload.text
    const text = extractTextContent(content)
    if (text) {
      return text
    }
  }

  if (kind === 'result') {
    return (
      firstString([
        payload.result,
        payload.message?.result,
        payload.message?.message?.result,
        payload.subtype,
        payload.message?.subtype,
      ]) ?? ''
    )
  }

  if (kind === 'tool_use_summary') {
    return firstString([payload.summary, payload.tool_summary]) ?? ''
  }

  if (kind === 'prompt_suggestion') {
    return firstString([payload.suggestion]) ?? ''
  }

  if (kind === 'auth_status') {
    const output = Array.isArray(payload.output)
      ? payload.output.filter((line: unknown) => typeof line === 'string').join('\n')
      : ''
    return output || (typeof payload.error === 'string' ? payload.error : '')
  }

  if (kind === 'local_command_output') {
    return firstString([
      payload.output,
      payload.command,
      payload.message,
      payload.content,
    ]) ?? ''
  }

  const generic =
    firstString([
      payload.message,
      payload.content,
      payload.description,
      payload.error,
      payload.status,
      payload.state,
      payload.subtype,
      subtype,
    ]) ?? ''

  return generic
}

function resolveKind(
  payload: Record<string, any>,
  role: string | null,
  subtype: string | null,
): NormalizedJarvisEventKind {
  const type = typeof payload.type === 'string' ? payload.type : ''

  if (role === 'assistant' || type === 'assistant') {
    return 'assistant'
  }
  if (role === 'user' || type === 'user') {
    return 'user'
  }
  if (role === 'result' || type === 'result') {
    return 'result'
  }

  if (type === 'system') {
    if (subtype === 'init') return 'system_init'
    if (subtype === 'status') return 'system_status'
    if (subtype === 'session_state_changed') return 'session_state_changed'
    if (subtype === 'task_notification') return 'task_notification'
    if (subtype === 'task_started') return 'task_started'
    if (subtype === 'task_progress') return 'task_progress'
    if (subtype === 'task_complete') return 'task_complete'
    if (subtype === 'task_interrupted') return 'task_interrupted'
    if (
      subtype === 'hook_started' ||
      subtype === 'hook_progress' ||
      subtype === 'hook_response'
    ) {
      return 'hook_event'
    }
    if (subtype === 'post_turn_summary') return 'post_turn_summary'
    if (subtype === 'api_retry') return 'api_retry'
    if (subtype === 'local_command_output') return 'local_command_output'
    if (subtype === 'files_persisted') return 'files_persisted'
    if (subtype === 'compact_boundary') return 'compact_boundary'
    if (subtype === 'elicitation_complete') return 'elicitation_complete'
  }

  if (type === 'stream_event') return 'stream_event'
  if (type === 'tool_progress') return 'tool_progress'
  if (type === 'tool_use_summary' || type === 'streamlined_tool_use_summary') {
    return 'tool_use_summary'
  }
  if (type === 'streamlined_text') return 'streamlined_text'
  if (type === 'auth_status') return 'auth_status'
  if (type === 'rate_limit_event') return 'rate_limit_event'
  if (type === 'prompt_suggestion') return 'prompt_suggestion'
  if (type === 'control_request') return 'control_request'
  if (type === 'control_response') return 'control_response'
  if (type === 'control_cancel_request') return 'control_cancel_request'
  if (type === 'keep_alive') return 'keep_alive'

  return 'unknown'
}

function resolveDisplayRole(kind: NormalizedJarvisEventKind): NormalizedJarvisDisplayRole {
  if (kind === 'user') {
    return 'user'
  }
  if (kind === 'assistant' || kind === 'stream_event' || kind === 'streamlined_text') {
    return 'assistant'
  }
  return 'timeline'
}

function resolvePhase(kind: NormalizedJarvisEventKind): NormalizedJarvisEventPhase {
  if (kind === 'stream_event' || kind === 'streamlined_text') {
    return 'stream'
  }
  if (kind === 'result' || kind === 'task_complete' || kind === 'task_interrupted') {
    return 'terminal'
  }
  return 'event'
}

function isErrorLike(
  payload: Record<string, any>,
  kind: NormalizedJarvisEventKind,
  subtype: string | null,
): boolean {
  const lowerSubtype = (subtype ?? '').toLowerCase()
  if (kind === 'result') {
    if (typeof payload.is_error === 'boolean' && payload.is_error) {
      return true
    }
    return lowerSubtype.startsWith('error')
  }
  if (kind === 'auth_status') {
    return typeof payload.error === 'string' && payload.error.trim().length > 0
  }
  if (kind === 'control_response') {
    const response = asRecord(payload.response)
    return response?.subtype === 'error'
  }
  if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
    return true
  }
  return false
}

function resolveSource(kind: NormalizedJarvisEventKind): NormalizedJarvisEvent['source'] {
  if (
    kind === 'control_request' ||
    kind === 'control_response' ||
    kind === 'control_cancel_request' ||
    kind === 'keep_alive'
  ) {
    return 'control'
  }
  if (kind === 'unknown') {
    return 'unknown'
  }
  return 'sdk'
}

export function getNormalizedEventDedupeKey(event: NormalizedJarvisEvent): string {
  // User messages must use a content-based key so that an optimistic insert
  // (synthetic UUID) and the matching SSE echo or snapshot replay (real UUID)
  // produce the same key and are correctly deduplicated across all merge paths.
  if (event.kind === 'user' && event.text.trim()) {
    return `user:${event.text.trim()}`
  }
  return `${event.id}:${event.turnId ?? '-'}:${event.kind}`
}

export function normalizeJarvisMessageEvent(
  rawMessage: unknown,
  options: NormalizeOptions = {},
): NormalizedJarvisEvent {
  const now = options.now ?? Date.now()
  const payload = unwrapMessagePayload(rawMessage)
  const role =
    firstString([
      payload.message?.role,
      payload.message?.message?.role,
      payload.role,
      payload.message?.type,
    ]) ?? null
  const subtype =
    firstString([
      payload.subtype,
      payload.message?.subtype,
      payload.message?.message?.subtype,
      payload.response?.subtype,
      payload.request?.subtype,
    ]) ?? null

  const kind = resolveKind(payload, role, subtype)
  const displayRole = resolveDisplayRole(kind)
  const phase = resolvePhase(kind)
  const extractedText = extractMessageText(payload, kind, subtype)
  const unknownFallback = kind === 'unknown' ? 'Runtime event received.' : ''
  const text = extractedText || firstString([subtype, unknownFallback]) || unknownFallback

  const sessionId =
    firstString([
      payload.session_id,
      payload.message?.session_id,
      options.sessionId,
    ]) ?? null
  const turnId =
    firstString([
      options.turnId,
      payload.turn_id,
      payload.parent_tool_use_id,
      payload.message?.turn_id,
    ]) ?? null
  const id =
    firstString([
      payload.uuid,
      payload.request_id,
      payload.tool_use_id,
      payload.task_id,
      payload.hook_id,
    ]) ?? createSyntheticId()
  const timestamp = parseTimestamp(
    payload.timestamp ?? payload.created_at ?? payload.time,
    now,
  )
  const errorLike = isErrorLike(payload, kind, subtype)

  return {
    id,
    timestamp,
    sessionId,
    turnId,
    source: resolveSource(kind),
    kind,
    phase,
    displayRole,
    text,
    raw: rawMessage,
    isTerminal: phase === 'terminal',
    isErrorLike: errorLike,
  }
}
