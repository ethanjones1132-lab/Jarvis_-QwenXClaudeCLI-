import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

import type { BridgeServerEnvelope } from './remoteGlmBridgeTypes.js'

export type RemoteAssistantPayload = {
  role: 'assistant'
  content: BetaContentBlock[]
}

function createTextBlock(): Extract<BetaContentBlock, { type: 'text' }> {
  return {
    type: 'text',
    text: '',
  } as Extract<BetaContentBlock, { type: 'text' }>
}

function createThinkingBlock(): Extract<BetaContentBlock, { type: 'thinking' }> {
  return {
    type: 'thinking',
    thinking: '',
    signature: '',
  } as Extract<BetaContentBlock, { type: 'thinking' }>
}

export class RemoteGlmResponseAccumulator {
  private readonly blocks: BetaContentBlock[] = []

  applyEvent(event: BridgeServerEnvelope): void {
    if (event.type === 'delta.output_text') {
      const last = this.blocks[this.blocks.length - 1]
      if (!last || last.type !== 'text') {
        this.blocks.push(createTextBlock())
      }
      const target = this.blocks[this.blocks.length - 1]
      if (target && target.type === 'text') {
        target.text += event.payload.delta
      }
      return
    }

    if (event.type === 'delta.thinking') {
      const last = this.blocks[this.blocks.length - 1]
      if (!last || last.type !== 'thinking') {
        this.blocks.push(createThinkingBlock())
      }
      const target = this.blocks[this.blocks.length - 1]
      if (target && target.type === 'thinking') {
        target.thinking += event.payload.delta
      }
      return
    }

    if (event.type === 'tool.call') {
      this.blocks.push({
        type: 'tool_use',
        id: event.payload.id,
        name: event.payload.name,
        input: event.payload.input,
      } as BetaContentBlock)
    }
  }

  toContentBlocks(): BetaContentBlock[] {
    return [...this.blocks]
  }

  toAssistantPayload(): RemoteAssistantPayload {
    return {
      role: 'assistant',
      content: this.toContentBlocks(),
    }
  }
}

export function adaptRemoteBridgeEvents(events: BridgeServerEnvelope[]) {
  const accumulator = new RemoteGlmResponseAccumulator()
  for (const event of events) {
    accumulator.applyEvent(event)
  }
  return accumulator.toAssistantPayload()
}
