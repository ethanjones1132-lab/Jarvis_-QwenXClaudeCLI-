import { readFileSync } from 'node:fs'

type ToolReferenceParameter = {
  name: string
  required: boolean
  type: string
  description?: string
  enumValues?: unknown[]
  example: unknown
}

type ToolReferenceEntry = {
  name: string
  aliases: string[]
  enabled: boolean
  strict: boolean
  alwaysLoad: boolean
  shouldDefer: boolean
  searchHint?: string
  description: string
  requiredParameters: string[]
  parameters: ToolReferenceParameter[]
  exampleInput: Record<string, unknown>
  anthropicToolUseTemplate: {
    type: 'tool_use'
    id: string
    name: string
    input: Record<string, unknown>
  }
  repairPrompt: string
}

type ToolReferenceArtifact = {
  generatedAt: string
  invocationContract: {
    rules: string[]
  }
  runtimeTools: ToolReferenceEntry[]
}

let cachedArtifact: ToolReferenceArtifact | null | undefined

export function normalizeToolName(value: string): string {
  return value.trim().toLowerCase()
}

function loadToolReferenceArtifact(): ToolReferenceArtifact | null {
  if (cachedArtifact !== undefined) {
    return cachedArtifact
  }

  try {
    const fileUrl = new URL('../constants/ToolReference.generated.json', import.meta.url)
    const raw = readFileSync(fileUrl, 'utf8')
    cachedArtifact = JSON.parse(raw) as ToolReferenceArtifact
    return cachedArtifact
  } catch {
    cachedArtifact = null
    return null
  }
}

function findToolReferenceEntry(toolName: string): ToolReferenceEntry | null {
  const artifact = loadToolReferenceArtifact()
  if (!artifact) return null

  const normalized = normalizeToolName(toolName)
  const directMatch =
    artifact.runtimeTools.find(
      entry =>
        normalizeToolName(entry.name) === normalized ||
        entry.aliases.some(alias => normalizeToolName(alias) === normalized),
    ) ?? null

  return directMatch
}

function scoreNameMatch(requestedName: string, candidate: string): number {
  const requested = normalizeToolName(requestedName)
  const target = normalizeToolName(candidate)
  if (requested === target) return 100
  if (target.startsWith(requested)) return 80
  if (requested.startsWith(target)) return 70
  if (target.includes(requested) || requested.includes(target)) return 60

  const requestedTokens = new Set(requested.split(/[^a-z0-9]+/).filter(Boolean))
  const targetTokens = target.split(/[^a-z0-9]+/).filter(Boolean)
  let overlap = 0
  for (const token of targetTokens) {
    if (requestedTokens.has(token)) overlap += 1
  }
  return overlap * 10
}

export function getToolCallRepairHint(toolName: string): string | null {
  const entry = findToolReferenceEntry(toolName)
  if (!entry) return null

  const parameterSummary =
    entry.parameters.length > 0
      ? entry.parameters
          .map(
            parameter =>
              `- \`${parameter.name}\`${parameter.required ? ' (required)' : ''}: ${parameter.type}${parameter.description ? ` - ${parameter.description}` : ''}`,
          )
          .join('\n')
      : '- This tool takes an empty object as input.'

  return [
    `Exact tool contract for \`${entry.name}\`:`,
    entry.description ? `Description: ${entry.description}` : '',
    'Expected parameters:',
    parameterSummary,
    'Retry guidance:',
    entry.repairPrompt,
    'Anthropic tool-use block template:',
    JSON.stringify(entry.anthropicToolUseTemplate, null, 2),
  ]
    .filter(Boolean)
    .join('\n')
}

export function getUnknownToolRepairHint(
  requestedToolName: string,
  availableToolNames: readonly string[],
): string | null {
  const artifact = loadToolReferenceArtifact()
  if (!artifact) return null

  const candidates = availableToolNames
    .map(name => ({
      name,
      score: scoreNameMatch(requestedToolName, name),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(candidate => candidate.name)

  if (candidates.length === 0) {
    const enabledExamples = artifact.runtimeTools
      .filter(tool => tool.enabled)
      .slice(0, 5)
      .map(tool => tool.name)
    return [
      `Tool names must match the runtime registry exactly. \`${requestedToolName}\` is not available.`,
      `Available examples: ${enabledExamples.join(', ')}`,
    ].join('\n')
  }

  const firstMatch = findToolReferenceEntry(candidates[0]!)
  return [
    `Tool names must match the runtime registry exactly. \`${requestedToolName}\` is not available.`,
    `Closest matches: ${candidates.join(', ')}`,
    firstMatch ? getToolCallRepairHint(firstMatch.name) : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function formatUnknownToolError(
  requestedToolName: string,
  availableToolNames: readonly string[],
): string {
  const repairHint = getUnknownToolRepairHint(
    requestedToolName,
    availableToolNames,
  )
  return (
    `Error: No such tool available: ${requestedToolName}` +
    (repairHint ? `\n\n${repairHint}` : '')
  )
}
