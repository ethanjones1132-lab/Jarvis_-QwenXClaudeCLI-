import { afterEach, describe, expect, test } from 'bun:test'
import { getExtraBodyParams } from '../../services/api/claude.js'
import { StreamingToolExecutor } from '../../services/tools/StreamingToolExecutor.js'
import { runToolUse } from '../../services/tools/toolExecution.js'
import {
  formatUnknownToolError,
  getToolCallRepairHint,
} from '../../utils/toolCallReference.js'
import { shouldIncludeToolChoiceForRequest } from '../../utils/apiCompatibility.js'
import { shouldLoadHeadlessPlugins } from '../../utils/headlessPluginPolicy.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, ORIGINAL_ENV)
})

const FAKE_TOOLS = [
  { name: 'TaskStop', aliases: ['KillShell'] },
  { name: 'Read', aliases: [] },
] as const

function createToolUseContext() {
  return {
    options: {
      tools: [...FAKE_TOOLS],
      mcpClients: [],
    },
    abortController: new AbortController(),
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    getAppState: () => ({}),
    setAppState: () => {},
    readFileState: {},
    messages: [],
  } as any
}

async function collectToolResultFromRunToolUse(toolName: string) {
  const toolUse = {
    id: 'toolu_test',
    name: toolName,
    input: {},
  } as any

  const assistantMessage = {
    uuid: 'assistant_uuid',
    message: { id: 'msg_test' },
  } as any

  for await (const update of runToolUse(
    toolUse,
    assistantMessage,
    (() => true) as any,
    createToolUseContext(),
  )) {
    if (update.message?.type === 'user') {
      return update.message.toolUseResult as string
    }
  }

  throw new Error('Expected a tool_result user message from runToolUse')
}

async function collectToolResultFromStreamingExecutor(toolName: string) {
  const assistantMessage = {
    uuid: 'assistant_uuid',
    message: { id: 'msg_test' },
  } as any

  const executor = new StreamingToolExecutor(
    [...FAKE_TOOLS] as any,
    (() => true) as any,
    createToolUseContext(),
  )

  executor.addTool(
    {
      id: 'toolu_test',
      type: 'tool_use',
      name: toolName,
      input: {},
    } as any,
    assistantMessage,
  )

  for await (const update of executor.getRemainingResults()) {
    if (update.message?.type === 'user') {
      return update.message.toolUseResult as string
    }
  }

  throw new Error(
    'Expected a tool_result user message from StreamingToolExecutor',
  )
}

describe('tool-call reconstruction', () => {
  test('shared unknown-tool formatter includes repair guidance', () => {
    const formatted = formatUnknownToolError(
      'TaskSto',
      FAKE_TOOLS.map(tool => tool.name),
    )

    expect(formatted).toContain('Error: No such tool available: TaskSto')
    expect(formatted).toContain('Closest matches: TaskStop')
    expect(formatted).toContain('"name": "TaskStop"')
  })

  test('streaming and non-streaming unknown-tool paths return the same repair text', async () => {
    const [nonStreaming, streaming] = await Promise.all([
      collectToolResultFromRunToolUse('TaskSto'),
      collectToolResultFromStreamingExecutor('TaskSto'),
    ])

    expect(nonStreaming).toBe(streaming)
    expect(nonStreaming).toContain('Closest matches: TaskStop')
  })

  test('generated runtime tools remain loadable through the repair helper', () => {
    const hint = getToolCallRepairHint('TaskStop')
    expect(hint).toBeTruthy()
    expect(hint).toContain('Exact tool contract for `TaskStop`')
  })

  test('generated module inventory maps renamed modules to live runtime names', async () => {
    const artifactPath = new URL(
      '../../constants/ToolReference.generated.json',
      import.meta.url,
    )
    const artifact = JSON.parse(
      await Bun.file(artifactPath).text(),
    ) as {
      moduleInventory: Array<{
        module: string
        presentInRuntimeRegistry: boolean
        matchingRuntimeNames: string[]
      }>
    }

    const expectedMappings = new Map([
      ['AgentTool', 'Agent'],
      ['FileReadTool', 'Read'],
      ['FileWriteTool', 'Write'],
      ['TaskStopTool', 'TaskStop'],
      ['BashTool', 'Bash'],
    ])

    for (const [moduleName, runtimeName] of expectedMappings) {
      const entry = artifact.moduleInventory.find(
        module => module.module === moduleName,
      )
      expect(entry).toBeTruthy()
      expect(entry?.presentInRuntimeRegistry).toBe(true)
      expect(entry?.matchingRuntimeNames).toContain(runtimeName)
    }
  })
})

describe('compatibility policy', () => {
  test('native mode preserves Anthropic-specific extra body fields', () => {
    process.env.CLAUDE_CODE_COMPAT_MODE = 'native'
    process.env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({
      anthropic_beta: ['existing-beta'],
      context_management: { clear: 'none' },
      metadata: { user_id: 'user-1' },
      output_config: { format: { type: 'json_schema' } },
      speed: 'fast',
      tool_choice: { type: 'tool', name: 'TaskStop' },
    })

    const extraBody = getExtraBodyParams(['new-beta'])
    expect(extraBody.anthropic_beta).toEqual(['existing-beta', 'new-beta'])
    expect(extraBody.context_management).toEqual({ clear: 'none' })
    expect(extraBody.metadata).toEqual({ user_id: 'user-1' })
    expect(extraBody.output_config).toEqual({ format: { type: 'json_schema' } })
    expect(extraBody.speed).toBe('fast')
    expect(extraBody.tool_choice).toEqual({ type: 'tool', name: 'TaskStop' })
  })

  test('compatibility mode strips Anthropic-only fields but preserves tool_choice', () => {
    process.env.CLAUDE_CODE_COMPAT_MODE = 'ollama'
    process.env.CLAUDE_CODE_EXTRA_BODY = JSON.stringify({
      anthropic_beta: ['existing-beta'],
      context_management: { clear: 'none' },
      metadata: { user_id: 'user-1' },
      output_config: { format: { type: 'json_schema' } },
      speed: 'fast',
      tool_choice: { type: 'tool', name: 'TaskStop' },
    })

    const extraBody = getExtraBodyParams(['new-beta'])
    expect(extraBody.anthropic_beta).toBeUndefined()
    expect(extraBody.context_management).toBeUndefined()
    expect(extraBody.metadata).toBeUndefined()
    expect(extraBody.output_config).toBeUndefined()
    expect(extraBody.speed).toBeUndefined()
    expect(extraBody.tool_choice).toEqual({ type: 'tool', name: 'TaskStop' })
  })

  test('tool_choice inclusion requires both tools and a defined toolChoice', () => {
    expect(
      shouldIncludeToolChoiceForRequest({
        hasTools: true,
        toolChoice: { type: 'auto' },
      }),
    ).toBe(true)
    expect(
      shouldIncludeToolChoiceForRequest({
        hasTools: false,
        toolChoice: { type: 'auto' },
      }),
    ).toBe(false)
    expect(
      shouldIncludeToolChoiceForRequest({
        hasTools: true,
        toolChoice: undefined,
      }),
    ).toBe(false)
  })

  test('headless plugin loading only depends on bare mode', () => {
    expect(shouldLoadHeadlessPlugins({ bareMode: false })).toBe(true)
    expect(shouldLoadHeadlessPlugins({ bareMode: true })).toBe(false)
  })
})
