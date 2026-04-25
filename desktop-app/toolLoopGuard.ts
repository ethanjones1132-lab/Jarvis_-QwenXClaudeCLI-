export type ToolLoopGuardState = {
  lastSignature: string | null
  repeatCount: number
  totalToolTurns: number
  warned: boolean
}

export type ToolLoopGuardResult = {
  nextState: ToolLoopGuardState
  warning?: string
  shouldStop?: boolean
}

export function createToolLoopGuardState(): ToolLoopGuardState {
  return {
    lastSignature: null,
    repeatCount: 0,
    totalToolTurns: 0,
    warned: false,
  }
}

function getToolSignature(message: unknown): string | null {
  const content = (message as any)?.message?.content
  if (!Array.isArray(content)) {
    return null
  }

  const toolUses = content.filter(
    (block: any) => block?.type === 'tool_use' && typeof block.name === 'string',
  )
  if (toolUses.length === 0) {
    return null
  }

  return toolUses
    .map((block: any) => `${block.name}:${JSON.stringify(block.input ?? {})}`)
    .join('|')
}

export function inspectToolLoop(
  state: ToolLoopGuardState,
  message: unknown,
): ToolLoopGuardResult {
  const signature = getToolSignature(message)
  if (!signature) {
    return {
      nextState: {
        ...state,
        lastSignature: null,
        repeatCount: 0,
      },
    }
  }

  const repeatCount =
    state.lastSignature === signature ? state.repeatCount + 1 : 1
  const nextState: ToolLoopGuardState = {
    lastSignature: signature,
    repeatCount,
    totalToolTurns: state.totalToolTurns + 1,
    warned: state.warned || repeatCount >= 2,
  }

  // Hard stop at 2 repeats — not 3. The first repeat is the signal; the second
  // confirms stagnation. Waiting for a third wastes a full inference round-trip
  // and burns context tokens on a path that's already proven fruitless.
  if (repeatCount >= 2) {
    return {
      nextState,
      warning:
        'STAGNATION DETECTED: You have called the same tool with identical arguments twice in a row. ' +
        'This approach is not working. You MUST switch strategy completely: ' +
        'try a different tool, different arguments, or tell the user what you found and ask for clarification. ' +
        'Do NOT call the same tool again.',
      shouldStop: false, // inject the message and let the model recover rather than hard-stopping
    }
  }

  // Absolute hard stop — too many total tool turns regardless of variety
  if (nextState.totalToolTurns >= 14) {
    return {
      nextState,
      warning:
        'Maximum tool turn budget reached (14 turns). Stopping to prevent runaway execution.',
      shouldStop: true,
    }
  }

  return { nextState }
}
