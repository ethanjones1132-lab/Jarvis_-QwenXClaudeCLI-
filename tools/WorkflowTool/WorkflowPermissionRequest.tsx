/**
 * WorkflowPermissionRequest — Custom permission dialog for WorkflowTool.
 *
 * Shows the workflow name, step count, and action summary when the model
 * requests permission to execute a workflow.
 *
 * Integration: components/permissions/PermissionRequest.tsx switches on
 * WorkflowTool to render this component instead of FallbackPermissionRequest.
 */

import React from 'react'
import { Box, Text } from 'ink'
import { getWorkflow } from './WorkflowTool.js'

type WorkflowPermissionRequestProps = {
  input: {
    workflow_name: string
    action: string
    step_override?: Record<string, string>
  }
  onAllow: () => void
  onDeny: () => void
}

export function WorkflowPermissionRequest({
  input,
  onAllow,
  onDeny,
}: WorkflowPermissionRequestProps): React.ReactElement {
  const wf = getWorkflow(input.workflow_name)

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text bold color="yellow">
        Workflow Execution Request
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Workflow:</Text> {input.workflow_name}
        </Text>
        {wf && (
          <>
            <Text>
              <Text bold>Description:</Text> {wf.description}
            </Text>
            <Text>
              <Text bold>Steps:</Text> {wf.steps.length}
            </Text>
            <Box marginTop={1} flexDirection="column">
              {wf.steps.map((step, i) => (
                <Text key={i} dimColor>
                  {`  ${i + 1}. [${step.action}] ${step.label}`}
                  {step.continueOnError ? ' (continue on error)' : ''}
                </Text>
              ))}
            </Box>
          </>
        )}
        {!wf && (
          <Text color="red">
            Workflow &quot;{input.workflow_name}&quot; not found in registry.
          </Text>
        )}
      </Box>
    </Box>
  )
}
