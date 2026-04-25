/**
 * WorkflowTool — Executes pre-defined workflow scripts within Claude Code.
 *
 * Feature-gated on WORKFLOW_SCRIPTS. Workflows are multi-step automation
 * scripts that can spawn agents, run commands, and produce structured output.
 * Each workflow run gets an isolated git worktree (slug: wf_<runId>-<idx>).
 *
 * Integration points:
 * - tools.ts: registered via feature('WORKFLOW_SCRIPTS')
 * - tasks.ts: creates LocalWorkflowTask for background tracking
 * - components/permissions/PermissionRequest.tsx: custom WorkflowPermissionRequest
 * - commands.ts: getWorkflowCommands() surfaces workflows as slash commands
 * - utils/worktree.ts: ephemeral worktree cleanup (wf_<runId>-<idx> pattern)
 */

import { z } from 'zod/v4'
import { randomUUID } from 'node:crypto'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logForDebugging } from '../../utils/debug.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'

// ── Workflow registry ───────────────────────────────────────────────────────

export type WorkflowDefinition = {
  name: string
  description: string
  /** Steps are executed sequentially. Each step gets the previous step's output. */
  steps: WorkflowStep[]
}

export type WorkflowStep = {
  /** Display name for progress tracking. */
  label: string
  /** The action to execute. */
  action: 'bash' | 'agent' | 'prompt'
  /** Command string (for bash), agent prompt (for agent), or literal text (for prompt). */
  content: string
  /** Working directory override. If absent, uses current worktree. */
  cwd?: string
  /** If true, failure of this step does not abort the workflow. */
  continueOnError?: boolean
}

export type WorkflowRunResult = {
  workflowName: string
  runId: string
  status: 'completed' | 'failed' | 'partial'
  stepResults: StepResult[]
}

type StepResult = {
  label: string
  status: 'completed' | 'failed' | 'skipped'
  output?: string
  error?: string
}

/** Global workflow registry populated by initBundledWorkflows(). */
const workflowRegistry = new Map<string, WorkflowDefinition>()

export function registerWorkflow(def: WorkflowDefinition): void {
  workflowRegistry.set(def.name, def)
}

export function getRegisteredWorkflows(): WorkflowDefinition[] {
  return [...workflowRegistry.values()]
}

export function getWorkflow(name: string): WorkflowDefinition | undefined {
  return workflowRegistry.get(name)
}

// ── Schema ──────────────────────────────────────────────────────────────────

const inputSchema = lazySchema(() =>
  z.strictObject({
    workflow_name: z
      .string()
      .describe('Name of the workflow to execute. Use list_workflows to see available workflows.'),
    action: z
      .enum(['run', 'list_workflows', 'describe'])
      .describe('Action to perform: run a workflow, list available ones, or describe a specific workflow.'),
    step_override: z
      .record(z.string(), z.string())
      .optional()
      .describe('Optional key-value overrides for workflow step content. Keys are step labels.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const DESCRIPTION =
  'Execute pre-defined multi-step workflow scripts. Workflows automate sequences of bash commands, agent prompts, and structured operations.'

const PROMPT = `Use this tool to run pre-defined workflows that automate multi-step development tasks.

Actions:
- list_workflows: List all available workflow definitions.
- describe: Show the steps of a specific workflow.
- run: Execute a workflow. Each step runs sequentially. Results are aggregated.

Workflows run in isolated worktrees when possible. Step failures can be configured to halt or continue.`

// ── Tool implementation ─────────────────────────────────────────────────────

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'automation workflow script multi-step execution',
  maxResultSizeChars: 200_000,
  shouldDefer: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isEnabled() {
    return workflowRegistry.size > 0
  },

  isConcurrencySafe() {
    return false
  },

  isReadOnly(input) {
    return input.action !== 'run'
  },

  async description() {
    return DESCRIPTION
  },

  async prompt() {
    const names = [...workflowRegistry.keys()]
    if (names.length === 0) return PROMPT
    return `${PROMPT}\n\nAvailable workflows: ${names.join(', ')}`
  },

  async checkPermissions(input, _context) {
    // Workflow execution always requires permission
    if (input.action === 'run') {
      return { behavior: 'ask' as const, updatedInput: input }
    }
    return { behavior: 'allow' as const, updatedInput: input }
  },

  async call(input, context) {
    const { action, workflow_name } = input

    switch (action) {
      case 'list_workflows': {
        const workflows = getRegisteredWorkflows().map(w => ({
          name: w.name,
          description: w.description,
          stepCount: w.steps.length,
        }))
        return { data: { workflows } }
      }

      case 'describe': {
        const wf = getWorkflow(workflow_name)
        if (!wf) {
          return { data: { error: `Workflow "${workflow_name}" not found.` } }
        }
        return {
          data: {
            name: wf.name,
            description: wf.description,
            steps: wf.steps.map((s, i) => ({
              index: i,
              label: s.label,
              action: s.action,
              continueOnError: s.continueOnError ?? false,
            })),
          },
        }
      }

      case 'run': {
        const wf = getWorkflow(workflow_name)
        if (!wf) {
          return { data: { error: `Workflow "${workflow_name}" not found.` } }
        }

        const runId = randomUUID().slice(0, 12)
        logForDebugging(`[Workflow] Starting "${wf.name}" run=${runId}`)

        const stepResults: StepResult[] = []
        let overallStatus: 'completed' | 'failed' | 'partial' = 'completed'

        for (const step of wf.steps) {
          const content = input.step_override?.[step.label] ?? step.content

          try {
            logForDebugging(`[Workflow] Step: ${step.label} (${step.action})`)

            // For this reconstruction, steps produce placeholder results.
            // In production, 'bash' steps exec via BashTool, 'agent' steps
            // spawn via AgentTool, and 'prompt' steps return literal text.
            let output: string
            switch (step.action) {
              case 'bash':
                output = `[bash] Would execute: ${content}`
                break
              case 'agent':
                output = `[agent] Would prompt: ${content}`
                break
              case 'prompt':
                output = content
                break
              default:
                output = `[unknown action: ${step.action}]`
            }

            stepResults.push({ label: step.label, status: 'completed', output })
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            stepResults.push({ label: step.label, status: 'failed', error })

            if (!step.continueOnError) {
              overallStatus = 'failed'
              // Mark remaining steps as skipped
              const idx = wf.steps.indexOf(step)
              for (const remaining of wf.steps.slice(idx + 1)) {
                stepResults.push({ label: remaining.label, status: 'skipped' })
              }
              break
            }
            overallStatus = 'partial'
          }
        }

        const result: WorkflowRunResult = {
          workflowName: wf.name,
          runId,
          status: overallStatus,
          stepResults,
        }

        logForDebugging(`[Workflow] "${wf.name}" run=${runId} status=${overallStatus}`)
        return { data: result }
      }

      default:
        return { data: { error: `Unknown action: ${action}` } }
    }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
    }
  },

  userFacingName() {
    return 'Workflow'
  },

  toAutoClassifierInput(input) {
    return `Workflow ${input.action} ${input.workflow_name}`.trim()
  },
} satisfies ToolDef<InputSchema, unknown>)
