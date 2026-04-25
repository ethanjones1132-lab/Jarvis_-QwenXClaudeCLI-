/**
 * SnapshotUpdateDialog — Agent memory snapshot update prompt.
 *
 * Shown when an agent definition has a pending snapshot update. The user
 * chooses how to handle the conflict between the current memory state and
 * the incoming snapshot:
 *
 *   - merge:   Combine new snapshot data with existing memory (creates a
 *              merge prompt via buildMergePrompt()).
 *   - keep:    Ignore the snapshot; keep current memory as-is.
 *   - replace: Overwrite current memory with the snapshot entirely.
 *
 * Integration points:
 *   - dialogLaunchers.tsx (site ~3173): launchSnapshotUpdateDialog()
 *   - main.tsx (~2261): checks pendingSnapshotUpdate, calls launchSnapshotUpdateDialog()
 *   - main.tsx (~2269): imports buildMergePrompt() for merge action
 *
 * Props interface derived from dialogLaunchers.tsx:37:
 *   <SnapshotUpdateDialog
 *     agentType={props.agentType}
 *     scope={props.scope}
 *     snapshotTimestamp={props.snapshotTimestamp}
 *     onComplete={done}
 *     onCancel={() => done('keep')}
 *   />
 */

import React, { useState, useCallback } from 'react'
import { Box, Text, useInput } from 'ink'
import type { AgentMemoryScope } from '../../tools/AgentTool/agentMemory.js'

type SnapshotChoice = 'merge' | 'keep' | 'replace'

type SnapshotUpdateDialogProps = {
  agentType: string
  scope: AgentMemoryScope
  snapshotTimestamp: string
  onComplete: (choice: SnapshotChoice) => void
  onCancel: () => void
}

const CHOICES: { key: string; value: SnapshotChoice; label: string; description: string }[] = [
  {
    key: 'm',
    value: 'merge',
    label: 'Merge',
    description: 'Combine snapshot with existing memory',
  },
  {
    key: 'k',
    value: 'keep',
    label: 'Keep',
    description: 'Ignore snapshot, keep current memory',
  },
  {
    key: 'r',
    value: 'replace',
    label: 'Replace',
    description: 'Overwrite memory with snapshot',
  },
]

export function SnapshotUpdateDialog({
  agentType,
  scope,
  snapshotTimestamp,
  onComplete,
  onCancel,
}: SnapshotUpdateDialogProps): React.ReactElement {
  const [selectedIndex, setSelectedIndex] = useState(0)

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex(i => Math.max(0, i - 1))
    } else if (key.downArrow) {
      setSelectedIndex(i => Math.min(CHOICES.length - 1, i + 1))
    } else if (key.return) {
      onComplete(CHOICES[selectedIndex]!.value)
    } else if (key.escape) {
      onCancel()
    } else {
      // Check for shortcut keys
      const match = CHOICES.find(c => c.key === input.toLowerCase())
      if (match) {
        onComplete(match.value)
      }
    }
  })

  const formattedTimestamp = new Date(snapshotTimestamp).toLocaleString()

  return (
    <Box flexDirection="column" paddingLeft={1} paddingTop={1}>
      <Text bold color="yellow">
        Agent Memory Snapshot Update
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text bold>Agent:</Text> {agentType}
        </Text>
        <Text>
          <Text bold>Scope:</Text> {scope}
        </Text>
        <Text>
          <Text bold>Snapshot:</Text> {formattedTimestamp}
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>
          A memory snapshot update is pending. How would you like to proceed?
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {CHOICES.map((choice, i) => (
          <Text key={choice.key}>
            {i === selectedIndex ? '> ' : '  '}
            <Text bold={i === selectedIndex} color={i === selectedIndex ? 'cyan' : undefined}>
              [{choice.key}] {choice.label}
            </Text>
            <Text dimColor> - {choice.description}</Text>
          </Text>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Use arrow keys + Enter, or press m/k/r. Esc to cancel (keeps current).
        </Text>
      </Box>
    </Box>
  )
}

/**
 * Build a merge prompt that instructs the model to combine the incoming
 * snapshot data with the agent's existing memory.
 *
 * Called from main.tsx (~2270) when the user chooses 'merge'.
 */
export function buildMergePrompt(
  agentType: string,
  scope: AgentMemoryScope,
): string {
  return [
    `A memory snapshot update is available for agent "${agentType}" (scope: ${scope}).`,
    'Please merge the incoming snapshot data with the existing memory:',
    '1. Read the current MEMORY.md and any referenced memory files.',
    '2. Compare with the snapshot content.',
    '3. Combine entries, preferring newer information where conflicts exist.',
    '4. Remove duplicates and outdated entries.',
    '5. Write the merged result back to the memory files.',
    'Preserve the existing memory structure and formatting conventions.',
  ].join('\n')
}
