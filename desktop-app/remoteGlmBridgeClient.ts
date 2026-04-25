import WebSocket from 'ws'

import type {
  BridgeClientEnvelope,
  BridgeServerEnvelope,
  BridgeSessionCreateRequest,
  BridgeSessionCreateResponse,
  BridgeTurnRequest,
} from './remoteGlmBridgeTypes.js'

type TurnHandlers = {
  onEvent?: (event: BridgeServerEnvelope) => void
  onCompleted?: () => void
  onError?: (error: Error) => void
}

type RemoteGlmBridgeClientOptions = {
  baseUrl: string
  apiKey: string
  webSocketFactory?: (url: string, headers: Record<string, string>) => WebSocket
}

function withJsonHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

function toWebSocketProtocol(protocol: string): string {
  if (protocol === 'http:') {
    return 'ws:'
  }
  if (protocol === 'https:') {
    return 'wss:'
  }
  return protocol
}

function attachSessionToken(url: URL, apiKey: string): string {
  if (!url.searchParams.has('token')) {
    url.searchParams.set('token', apiKey)
  }
  return url.toString()
}

function buildFallbackWebSocketUrl(
  baseUrl: string,
  sessionId: string,
  apiKey: string,
): string {
  const normalizedBase = new URL(`${normalizeBaseUrl(baseUrl)}/`)
  normalizedBase.protocol = toWebSocketProtocol(normalizedBase.protocol)
  normalizedBase.pathname = `${normalizedBase.pathname.replace(/\/$/, '')}/v1/sessions/${sessionId}/stream`
  return attachSessionToken(normalizedBase, apiKey)
}

function resolveWebSocketUrl(
  baseUrl: string,
  websocketUrl: string | null | undefined,
  apiKey: string,
  sessionId: string,
): string {
  const fallback = buildFallbackWebSocketUrl(baseUrl, sessionId, apiKey)
  const candidate = websocketUrl?.trim()
  if (!candidate) {
    return fallback
  }

  try {
    if (/^wss?:\/\//i.test(candidate) || /^https?:\/\//i.test(candidate)) {
      const parsed = new URL(candidate)
      parsed.protocol = toWebSocketProtocol(parsed.protocol)
      return attachSessionToken(parsed, apiKey)
    }

    const normalizedBase = new URL(`${normalizeBaseUrl(baseUrl)}/`)
    normalizedBase.protocol = toWebSocketProtocol(normalizedBase.protocol)
    const relativePath = candidate.replace(/^\/+/, '')
    const parsed = new URL(relativePath, normalizedBase.toString())
    return attachSessionToken(parsed, apiKey)
  } catch {
    return fallback
  }
}

export class RemoteGlmBridgeClient {
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly webSocketFactory: (
    url: string,
    headers: Record<string, string>,
  ) => WebSocket

  private socket: WebSocket | null = null
  private sessionWebSocketUrls = new Map<string, string>()
  private pendingTurns = new Map<string, TurnHandlers>()

  constructor(options: RemoteGlmBridgeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.apiKey = options.apiKey
    this.webSocketFactory =
      options.webSocketFactory ??
      ((url, headers) => new WebSocket(url, { headers }))
  }

  async createSession(
    request: BridgeSessionCreateRequest,
  ): Promise<BridgeSessionCreateResponse> {
    const response = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: withJsonHeaders(this.apiKey),
      body: JSON.stringify(request),
    })
    if (!response.ok) {
      throw new Error(await response.text())
    }
    const session = (await response.json()) as Partial<BridgeSessionCreateResponse>
    if (typeof session.session_id !== 'string' || !session.session_id.trim()) {
      throw new Error('Remote bridge session response did not include session_id')
    }
    if (typeof session.expires_at !== 'string' || !session.expires_at.trim()) {
      throw new Error('Remote bridge session response did not include expires_at')
    }

    const websocketUrl = resolveWebSocketUrl(
      this.baseUrl,
      session.websocket_url,
      this.apiKey,
      session.session_id,
    )
    this.sessionWebSocketUrls.set(session.session_id, websocketUrl)

    return {
      session_id: session.session_id,
      websocket_url: websocketUrl,
      expires_at: session.expires_at,
    }
  }

  async connect(sessionId: string): Promise<void> {
    const wsUrl =
      this.sessionWebSocketUrls.get(sessionId) ??
      buildFallbackWebSocketUrl(this.baseUrl, sessionId, this.apiKey)
    const headers = { Authorization: `Bearer ${this.apiKey}` }
    this.socket = this.webSocketFactory(wsUrl, headers)

    await new Promise<void>((resolve, reject) => {
      const socket = this.socket
      if (!socket) {
        reject(new Error('WebSocket creation failed'))
        return
      }

      socket.once('open', () => resolve())
      socket.once('error', error => reject(error))
      socket.on('message', data => {
        const event = JSON.parse(String(data)) as BridgeServerEnvelope
        this.handleServerEvent(event)
      })
      socket.on('close', () => {
        for (const turn of this.pendingTurns.values()) {
          turn.onError?.(new Error('Remote bridge socket closed'))
        }
        this.pendingTurns.clear()
      })
    })
  }

  startTurn(turn: BridgeTurnRequest, handlers: TurnHandlers = {}): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Remote bridge is not connected')
    }
    this.pendingTurns.set(turn.turn_id, handlers)
    this.send({
      type: 'turn.start',
      payload: turn,
    })
  }

  configure(payload: Record<string, unknown>): void {
    this.send({
      type: 'session.configure',
      payload,
    })
  }

  sendToolResult(payload: Record<string, unknown>): void {
    this.send({
      type: 'tool.result',
      payload,
    })
  }

  close(): void {
    if (!this.socket) {
      return
    }
    this.send({
      type: 'session.close',
      payload: {},
    })
    this.socket.close()
    this.socket = null
  }

  private send(envelope: BridgeClientEnvelope): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('Remote bridge is not connected')
    }
    this.socket.send(JSON.stringify(envelope))
  }

  private handleServerEvent(event: BridgeServerEnvelope): void {
    if (
      'payload' in event &&
      event.payload &&
      'turn_id' in event.payload &&
      typeof event.payload.turn_id === 'string'
    ) {
      const turn = this.pendingTurns.get(event.payload.turn_id)
      if (event.type === 'turn.completed') {
        turn?.onCompleted?.()
        this.pendingTurns.delete(event.payload.turn_id)
        return
      }
      if (event.type === 'error') {
        turn?.onError?.(new Error(event.payload.message))
        this.pendingTurns.delete(event.payload.turn_id)
        return
      }
      turn?.onEvent?.(event)
    }
  }
}
