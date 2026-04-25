export type BridgeToolManifestEntry = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type BridgeFileState = {
  path: string
  sha256?: string | null
  content?: string | null
  summary?: string | null
  is_partial?: boolean
}

export type BridgeWorkspaceSnapshot = {
  workspace_id: string
  cwd: string
  branch?: string | null
  files: BridgeFileState[]
  memory?: string | null
}

export type BridgeConversationMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export type BridgeSecondaryProcessorConfig = {
  enabled?: boolean
  model?: string | null
  endpoint?: string | null
}

export type BridgeSessionCreateRequest = {
  session_label: string
  user_id: string
  system_prompt?: string
  workspace: BridgeWorkspaceSnapshot
  tool_manifest?: BridgeToolManifestEntry[]
  metadata?: Record<string, unknown>
}

export type BridgeSessionCreateResponse = {
  session_id: string
  websocket_url: string
  expires_at: string
}

export type BridgeTurnRequest = {
  turn_id: string
  prompt: string
  messages?: BridgeConversationMessage[]
  workspace_patch?: BridgeWorkspaceSnapshot
  tool_manifest?: BridgeToolManifestEntry[]
  secondary_processor?: BridgeSecondaryProcessorConfig
  metadata?: Record<string, unknown>
}

export type BridgeClientEnvelope =
  | {
      type: 'turn.start'
      payload: BridgeTurnRequest
    }
  | {
      type: 'session.configure'
      payload: Record<string, unknown>
    }
  | {
      type: 'tool.result'
      payload: Record<string, unknown>
    }
  | {
      type: 'session.close'
      payload: Record<string, unknown>
    }

export type BridgeServerEnvelope =
  | {
      type: 'session.ready'
      payload: { session_id: string; label: string }
    }
  | {
      type: 'session.configured'
      payload: Record<string, unknown>
    }
  | {
      type: 'turn.started'
      payload: { turn_id: string }
    }
  | {
      type: 'delta.thinking'
      payload: { turn_id: string; delta: string }
    }
  | {
      type: 'delta.output_text'
      payload: { turn_id: string; delta: string }
    }
  | {
      type: 'tool.call'
      payload: {
        turn_id: string
        id: string
        name: string
        input: Record<string, unknown>
      }
    }
  | {
      type: 'tool.result.ack'
      payload: { tool_use_id?: string }
    }
  | {
      type: 'turn.completed'
      payload: { turn_id: string }
    }
  | {
      type: 'session.closed'
      payload: Record<string, unknown>
    }
  | {
      type: 'error'
      payload: { turn_id?: string; message: string }
    }
