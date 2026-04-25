import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Anthropic from '@anthropic-ai/sdk'
import { getEmptyToolPermissionContext } from '../Tool.js'
import { getAllBaseTools } from '../tools.js'
import { getBuiltInAgents } from '../tools/AgentTool/builtInAgents.js'
import { getActiveAgentsFromList } from '../tools/AgentTool/loadAgentsDir.js'
import { toolToAPISchema } from '../utils/api.js'
import { normalizeToolName } from '../utils/toolCallReference.js'
import { enableConfigs } from '../utils/config.js'
import { zodToJsonSchema } from '../utils/zodToJsonSchema.js'

type JSONSchema = Anthropic.Tool.InputSchema

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
  inputSchema: JSONSchema
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
  generationError?: string
}

type ToolReferenceArtifact = {
  generatedAt: string
  source: string
  invocationContract: {
    primaryFormat: 'anthropic_tool_use_block'
    rules: string[]
    anthropicBlockTemplate: {
      type: 'tool_use'
      id: string
      name: 'ToolName'
      input: Record<string, unknown>
    }
  }
  runtimeTools: ToolReferenceEntry[]
  moduleInventory: ToolReferenceModuleInventoryEntry[]
}

type ToolReferenceModuleInventoryEntry = {
  module: string
  declaredNames: string[]
  declaredAliases: string[]
  matchingRuntimeNames: string[]
  presentInRuntimeRegistry: boolean
  discoveryError?: string
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = dirname(__dirname)
const TOOLS_DIR = join(REPO_ROOT, 'tools')
const JSON_OUTPUT = join(REPO_ROOT, 'constants', 'ToolReference.generated.json')
const TS_OUTPUT = join(REPO_ROOT, 'constants', 'ToolConfig.generated.ts')
const MD_OUTPUT = join(REPO_ROOT, 'docs', 'tool-reference.generated.md')

function schemaType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'unknown'
  const explicitType = schema['type']
  if (typeof explicitType === 'string') return explicitType
  if (Array.isArray(explicitType) && explicitType.length > 0) {
    return explicitType.map(item => String(item)).join(' | ')
  }
  if (Array.isArray(schema['enum'])) return 'enum'
  if (Array.isArray(schema['oneOf'])) return 'oneOf'
  if (Array.isArray(schema['anyOf'])) return 'anyOf'
  return 'unknown'
}

function getExampleScalar(
  propertyName: string,
  schema: Record<string, unknown>,
): unknown {
  if ('default' in schema) return schema['default']

  const enumValues = Array.isArray(schema['enum']) ? schema['enum'] : null
  if (enumValues && enumValues.length > 0) {
    return enumValues[0]
  }

  const normalizedName = propertyName.toLowerCase()
  const type = schemaType(schema)

  if (type === 'boolean') return false
  if (type === 'integer') return 1
  if (type === 'number') return 1

  if (type === 'string') {
    const format = typeof schema['format'] === 'string' ? schema['format'] : ''
    if (format === 'uri' || normalizedName.includes('url')) {
      return 'https://example.com'
    }
    if (
      normalizedName.includes('path') ||
      normalizedName.includes('file') ||
      normalizedName.endsWith('dir') ||
      normalizedName.includes('directory')
    ) {
      return '/absolute/path/to/file'
    }
    if (normalizedName.includes('command')) {
      return 'git status'
    }
    if (normalizedName.includes('query') || normalizedName.includes('pattern')) {
      return 'example query'
    }
    if (normalizedName.includes('prompt')) {
      return 'Describe the intended change and constraints'
    }
    if (normalizedName.includes('description')) {
      return 'Short task summary'
    }
    if (normalizedName.includes('branch')) {
      return 'feature/example-change'
    }
    if (normalizedName.includes('model')) {
      return 'sonnet'
    }
    if (normalizedName.includes('name')) {
      return 'example-name'
    }
    return 'example'
  }

  return 'example'
}

function buildExampleValue(
  propertyName: string,
  schema: Record<string, unknown> | undefined,
): unknown {
  if (!schema) return 'example'

  const oneOf = Array.isArray(schema['oneOf'])
    ? (schema['oneOf'] as Array<Record<string, unknown>>)
    : null
  if (oneOf && oneOf.length > 0) {
    return buildExampleValue(propertyName, oneOf[0])
  }

  const anyOf = Array.isArray(schema['anyOf'])
    ? (schema['anyOf'] as Array<Record<string, unknown>>)
    : null
  if (anyOf && anyOf.length > 0) {
    return buildExampleValue(propertyName, anyOf[0])
  }

  const type = schemaType(schema)
  if (type === 'object') {
    const properties =
      schema['properties'] && typeof schema['properties'] === 'object'
        ? (schema['properties'] as Record<string, Record<string, unknown>>)
        : {}
    const required = new Set(
      Array.isArray(schema['required']) ? schema['required'].map(String) : [],
    )
    const chosenKeys =
      required.size > 0 ? Array.from(required) : Object.keys(properties).slice(0, 2)
    const example: Record<string, unknown> = {}
    for (const key of chosenKeys) {
      example[key] = buildExampleValue(key, properties[key])
    }
    return example
  }

  if (type === 'array') {
    const itemSchema =
      schema['items'] && typeof schema['items'] === 'object'
        ? (schema['items'] as Record<string, unknown>)
        : undefined
    return [buildExampleValue(`${propertyName}_item`, itemSchema)]
  }

  return getExampleScalar(propertyName, schema)
}

function buildParameters(schema: JSONSchema): ToolReferenceParameter[] {
  const properties =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {}
  const required = new Set(
    Array.isArray((schema as Record<string, unknown>).required)
      ? ((schema as Record<string, unknown>).required as unknown[]).map(String)
      : [],
  )

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    required: required.has(name),
    type: schemaType(propertySchema),
    description:
      typeof propertySchema.description === 'string'
        ? propertySchema.description
        : undefined,
    enumValues: Array.isArray(propertySchema.enum)
      ? [...propertySchema.enum]
      : undefined,
    example: buildExampleValue(name, propertySchema),
  }))
}

function buildRepairPrompt(
  toolName: string,
  requiredParameters: string[],
  exampleInput: Record<string, unknown>,
): string {
  const requiredSummary =
    requiredParameters.length > 0
      ? requiredParameters.map(name => `\`${name}\``).join(', ')
      : 'none'

  return [
    `Retry the tool call using the exact tool name \`${toolName}\`.`,
    `Required parameters: ${requiredSummary}.`,
    'Arguments must be strict JSON only: no markdown fences, no XML wrappers, no extra commentary, and no invented fields.',
    `Example input: ${JSON.stringify(exampleInput, null, 2)}`,
  ].join('\n')
}

function extractQuotedStrings(expression: string): string[] {
  return [...expression.matchAll(/['"`]([^'"`]+)['"`]/g)].map(match => match[1]!)
}

function extractNamedStringConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>()
  for (const match of source.matchAll(
    /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(['"`])([^'"`]+)\2/g,
  )) {
    constants.set(match[1]!, match[3]!)
  }
  return constants
}

function extractNamedStringArrayConstants(source: string): Map<string, string[]> {
  const constants = new Map<string, string[]>()
  for (const match of source.matchAll(
    /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*\[([\s\S]*?)\]/g,
  )) {
    const values = extractQuotedStrings(match[2]!)
    if (values.length > 0) {
      constants.set(match[1]!, values)
    }
  }
  return constants
}

function resolveStringExpression(
  expression: string,
  namedStrings: Map<string, string>,
): string | null {
  const trimmed = expression.trim()
  const quotedMatch = trimmed.match(/^['"`]([^'"`]+)['"`]$/)
  if (quotedMatch) return quotedMatch[1]!
  return namedStrings.get(trimmed) ?? null
}

function resolveStringArrayExpression(
  expression: string,
  namedStringArrays: Map<string, string[]>,
): string[] {
  const trimmed = expression.trim()
  if (trimmed.startsWith('[')) {
    return extractQuotedStrings(trimmed)
  }
  return namedStringArrays.get(trimmed) ?? []
}

async function discoverModuleToolContract(
  moduleName: string,
): Promise<Omit<ToolReferenceModuleInventoryEntry, 'matchingRuntimeNames' | 'presentInRuntimeRegistry'>> {
  const modulePath = join(TOOLS_DIR, moduleName)
  const entries = await readdir(modulePath, { withFileTypes: true })
  const sourceFiles = entries
    .filter(entry => entry.isFile())
    .filter(entry => entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
    .map(entry => join(modulePath, entry.name))

  if (sourceFiles.length === 0) {
    return {
      module: moduleName,
      declaredNames: [],
      declaredAliases: [],
      discoveryError: 'No top-level TypeScript source files found for this module.',
    }
  }

  const namedStrings = new Map<string, string>()
  const namedStringArrays = new Map<string, string[]>()
  const declaredNames = new Set<string>()
  const declaredAliases = new Set<string>()

  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, 'utf8')
    for (const [key, value] of extractNamedStringConstants(source)) {
      namedStrings.set(key, value)
    }
    for (const [key, value] of extractNamedStringArrayConstants(source)) {
      namedStringArrays.set(key, value)
    }
  }

  for (const sourceFile of sourceFiles) {
    const source = await readFile(sourceFile, 'utf8')
    if (!source.includes('buildTool({')) {
      continue
    }

    for (const line of source.split(/\r?\n/)) {
      const nameMatch = line.match(/^\s*name:\s*([^,]+),?\s*$/)
      if (nameMatch) {
        const resolvedName = resolveStringExpression(nameMatch[1]!, namedStrings)
        if (resolvedName) {
          declaredNames.add(resolvedName)
        }
      }

      const aliasesMatch = line.match(/^\s*aliases:\s*([^,].*),?\s*$/)
      if (aliasesMatch) {
        for (const alias of resolveStringArrayExpression(
          aliasesMatch[1]!,
          namedStringArrays,
        )) {
          declaredAliases.add(alias)
        }
      }
    }
  }

  const discoveredNames = [...declaredNames]
  const discoveredAliases = [...declaredAliases]

  return {
    module: moduleName,
    declaredNames: discoveredNames.sort((a, b) => a.localeCompare(b)),
    declaredAliases: discoveredAliases.sort((a, b) => a.localeCompare(b)),
    ...(discoveredNames.length === 0 && discoveredAliases.length === 0
      ? {
          discoveryError:
            'No runtime tool name or alias declaration could be extracted from top-level module sources.',
        }
      : {}),
  }
}

async function getModuleInventory(
  runtimeTools: ToolReferenceEntry[],
): Promise<ToolReferenceModuleInventoryEntry[]> {
  const runtimeNameToPrimary = new Map<string, string>()
  for (const tool of runtimeTools) {
    runtimeNameToPrimary.set(normalizeToolName(tool.name), tool.name)
    for (const alias of tool.aliases) {
      runtimeNameToPrimary.set(normalizeToolName(alias), tool.name)
    }
  }

  const entries = await readdir(TOOLS_DIR, { withFileTypes: true })
  const inventory = await Promise.all(
    entries
      .filter(entry => entry.isDirectory())
      .filter(entry => !['shared', 'testing'].includes(entry.name))
      .map(async entry => {
        const discovered = await discoverModuleToolContract(entry.name)
        const matchingRuntimeNames = Array.from(
          new Set(
            [...discovered.declaredNames, ...discovered.declaredAliases]
              .map(name => runtimeNameToPrimary.get(normalizeToolName(name)))
              .filter((name): name is string => Boolean(name)),
          ),
        ).sort((a, b) => a.localeCompare(b))

        return {
          ...discovered,
          matchingRuntimeNames,
          presentInRuntimeRegistry: matchingRuntimeNames.length > 0,
        } satisfies ToolReferenceModuleInventoryEntry
      }),
  )

  return inventory.sort((a, b) => a.module.localeCompare(b.module))
}

async function buildToolReferenceArtifact(): Promise<ToolReferenceArtifact> {
  const tools = [...getAllBaseTools()].sort((a, b) => a.name.localeCompare(b.name))
  const allAgents = getBuiltInAgents()
  const activeAgents = getActiveAgentsFromList(allAgents)

  const runtimeTools = await Promise.all(
    tools.map(async tool => {
      const fallbackInputSchema = (
        'inputJSONSchema' in tool && tool.inputJSONSchema
          ? tool.inputJSONSchema
          : zodToJsonSchema(tool.inputSchema)
      ) as JSONSchema
      const fallbackParameters = buildParameters(fallbackInputSchema)
      const fallbackRequiredParameters = fallbackParameters
        .filter(parameter => parameter.required)
        .map(parameter => parameter.name)
      const fallbackExampleInput = Object.fromEntries(
        fallbackParameters
          .filter(
            parameter => parameter.required || fallbackParameters.length === 1,
          )
          .map(parameter => [parameter.name, parameter.example]),
      )

      try {
        const schema = await toolToAPISchema(tool, {
          getToolPermissionContext: async () => getEmptyToolPermissionContext(),
          tools,
          agents: activeAgents,
          allowedAgentTypes: activeAgents.map(agent => agent.agentType),
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        })

        const inputSchema = schema.input_schema
        const parameters = buildParameters(inputSchema)
        const requiredParameters = parameters
          .filter(parameter => parameter.required)
          .map(parameter => parameter.name)
        const exampleInput = Object.fromEntries(
          parameters
            .filter(parameter => parameter.required || parameters.length === 1)
            .map(parameter => [parameter.name, parameter.example]),
        )

        const anthropicToolUseTemplate = {
          type: 'tool_use' as const,
          id: 'toolu_example',
          name: tool.name,
          input: exampleInput,
        }

        return {
          name: tool.name,
          aliases: tool.aliases ? [...tool.aliases] : [],
          enabled: tool.isEnabled(),
          strict: tool.strict === true,
          alwaysLoad: tool.alwaysLoad === true,
          shouldDefer: tool.shouldDefer === true,
          searchHint: tool.searchHint,
          description: schema.description,
          inputSchema,
          requiredParameters,
          parameters,
          exampleInput,
          anthropicToolUseTemplate,
          repairPrompt: buildRepairPrompt(
            tool.name,
            requiredParameters,
            exampleInput,
          ),
        } satisfies ToolReferenceEntry
      } catch (error) {
        return {
          name: tool.name,
          aliases: tool.aliases ? [...tool.aliases] : [],
          enabled: tool.isEnabled(),
          strict: tool.strict === true,
          alwaysLoad: tool.alwaysLoad === true,
          shouldDefer: tool.shouldDefer === true,
          searchHint: tool.searchHint,
          description:
            `Prompt extraction failed while building this artifact. ` +
            `Use the schema below and inspect the tool source directly if needed.`,
          inputSchema: fallbackInputSchema,
          requiredParameters: fallbackRequiredParameters,
          parameters: fallbackParameters,
          exampleInput: fallbackExampleInput,
          anthropicToolUseTemplate: {
            type: 'tool_use',
            id: 'toolu_example',
            name: tool.name,
            input: fallbackExampleInput,
          },
          repairPrompt:
            buildRepairPrompt(
              tool.name,
              fallbackRequiredParameters,
              fallbackExampleInput,
            ),
          generationError: error instanceof Error ? error.message : String(error),
        } satisfies ToolReferenceEntry
      }
    }),
  )

  return {
    generatedAt: new Date().toISOString(),
    source: 'Generated from getAllBaseTools() and toolToAPISchema() in the reconstructed Claude Code source tree.',
    invocationContract: {
      primaryFormat: 'anthropic_tool_use_block',
      rules: [
        'Tool calls must use the exact tool name exposed by the runtime.',
        'Tool input must be strict JSON matching the input_schema for that tool.',
        'Do not wrap tool calls in markdown fences, XML envelopes, or explanatory prose.',
        'When a tool call fails, retry with the exact parameter names and types from the schema.',
      ],
      anthropicBlockTemplate: {
        type: 'tool_use',
        id: 'toolu_example',
        name: 'ToolName',
        input: {
          example_key: 'example value',
        },
      },
    },
    runtimeTools,
    moduleInventory: await getModuleInventory(runtimeTools),
  }
}

function renderMarkdown(artifact: ToolReferenceArtifact): string {
  const lines: string[] = [
    '# Claude Code Tool Reference',
    '',
    `Generated: ${artifact.generatedAt}`,
    '',
    '## Invocation contract',
    '',
    'Claude Code expects Anthropic-style structured tool-use content blocks, not freeform XML text.',
    '',
    '```json',
    JSON.stringify(artifact.invocationContract.anthropicBlockTemplate, null, 2),
    '```',
    '',
    'Rules:',
    ...artifact.invocationContract.rules.map(rule => `- ${rule}`),
    '',
    '## Runtime tools',
    '',
  ]

  for (const tool of artifact.runtimeTools) {
    lines.push(`### ${tool.name}`)
    lines.push('')
    lines.push(`- Enabled: ${tool.enabled ? 'yes' : 'no'}`)
    lines.push(`- Strict: ${tool.strict ? 'yes' : 'no'}`)
    lines.push(`- Deferred: ${tool.shouldDefer ? 'yes' : 'no'}`)
    if (tool.aliases.length > 0) {
      lines.push(`- Aliases: ${tool.aliases.join(', ')}`)
    }
    if (tool.searchHint) {
      lines.push(`- Search hint: ${tool.searchHint}`)
    }
    if (tool.description) {
      lines.push(`- Description: ${tool.description}`)
    }
    if (tool.requiredParameters.length > 0) {
      lines.push(
        `- Required parameters: ${tool.requiredParameters.map(name => `\`${name}\``).join(', ')}`,
      )
    }
    if (tool.generationError) {
      lines.push(`- Generation error: ${tool.generationError}`)
    }
    lines.push('')
    lines.push('Example input:')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(tool.exampleInput, null, 2))
    lines.push('```')
    lines.push('')
    lines.push('Tool-use block template:')
    lines.push('')
    lines.push('```json')
    lines.push(JSON.stringify(tool.anthropicToolUseTemplate, null, 2))
    lines.push('```')
    lines.push('')
  }

  if (artifact.moduleInventory.length > 0) {
    lines.push('## Tool module inventory')
    lines.push('')
    for (const module of artifact.moduleInventory) {
      lines.push(`### ${module.module}`)
      lines.push('')
      lines.push(
        `- Present in runtime registry: ${module.presentInRuntimeRegistry ? 'yes' : 'no'}`,
      )
      lines.push(
        `- Declared names: ${module.declaredNames.length > 0 ? module.declaredNames.join(', ') : 'none discovered'}`,
      )
      lines.push(
        `- Declared aliases: ${module.declaredAliases.length > 0 ? module.declaredAliases.join(', ') : 'none discovered'}`,
      )
      lines.push(
        `- Matching runtime names: ${module.matchingRuntimeNames.length > 0 ? module.matchingRuntimeNames.join(', ') : 'none'}`,
      )
      if (module.discoveryError) {
        lines.push(`- Discovery error: ${module.discoveryError}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

function renderToolConfigTs(artifact: ToolReferenceArtifact): string {
  const allTools = artifact.runtimeTools.map(tool => tool.name)
  const enabledTools = artifact.runtimeTools
    .filter(tool => tool.enabled)
    .map(tool => tool.name)

  return [
    `export const GENERATED_TOOL_REFERENCE_AT = ${JSON.stringify(artifact.generatedAt)};`,
    `export const ALL_TOOLS = ${JSON.stringify(allTools, null, 2)} as const;`,
    `export const ENABLED_TOOLS = ${JSON.stringify(enabledTools, null, 2)} as const;`,
  ].join('\n\n')
}

async function main(): Promise<void> {
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ??= '1'
  process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ??= '1'
  enableConfigs()

  const artifact = await buildToolReferenceArtifact()
  await mkdir(dirname(JSON_OUTPUT), { recursive: true }).catch(() => {})
  await mkdir(dirname(MD_OUTPUT), { recursive: true }).catch(() => {})

  await writeFile(JSON_OUTPUT, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')
  await writeFile(TS_OUTPUT, `${renderToolConfigTs(artifact)}\n`, 'utf8')
  await writeFile(MD_OUTPUT, `${renderMarkdown(artifact)}\n`, 'utf8')

  console.log(
    `Generated tool reference artifacts for ${artifact.runtimeTools.length} tools.`,
  )
}

await main()
