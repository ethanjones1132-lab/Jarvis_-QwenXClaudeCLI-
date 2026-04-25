/**
 * createWorkflowCommand — Surfaces registered workflows as slash commands.
 *
 * Integration: commands.ts calls getWorkflowCommands() to inject workflow
 * commands into the CLI command registry.
 *
 * Each registered workflow becomes a /workflow-<name> command.
 */

import type { LocalCommand } from '../../types/command.js'
import { getRegisteredWorkflows } from './WorkflowTool.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'

export type WorkflowCommand = LocalCommand & {
  workflowName: string
}

/**
 * Create a slash command for a specific workflow.
 */
export function createWorkflowCommand(workflowName: string, description: string): WorkflowCommand {
  return {
    type: 'local' as const,
    name: `workflow-${workflowName}`,
    description: `Run workflow: ${description}`,
    isEnabled: true,
    workflowName,
    call: async () => {
      // When invoked as a slash command, the command handler should queue
      // a tool call to WorkflowTool with action='run' and the workflow name.
      // This stub returns a prompt that the REPL will process as a user message.
      return {
        prompt: `Use the ${WORKFLOW_TOOL_NAME} tool to run the "${workflowName}" workflow.`,
      }
    },
  }
}

/**
 * Returns all registered workflows as CLI commands.
 * Called by commands.ts: getWorkflowCommands()
 */
export function getWorkflowCommands(): WorkflowCommand[] {
  return getRegisteredWorkflows().map(wf =>
    createWorkflowCommand(wf.name, wf.description),
  )
}
