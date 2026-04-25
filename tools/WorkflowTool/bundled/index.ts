/**
 * Bundled workflow initializer.
 *
 * Called by tools.ts before WorkflowTool is loaded:
 *   require('./tools/WorkflowTool/bundled/index.js').initBundledWorkflows()
 *
 * Registers built-in workflow definitions into the global workflow registry
 * so they are available when WorkflowTool.isEnabled() is checked.
 */

import { registerWorkflow, type WorkflowDefinition } from '../WorkflowTool.js'

/**
 * Built-in workflows shipped with Claude Code.
 * Each workflow is a multi-step automation script.
 */
const BUNDLED_WORKFLOWS: WorkflowDefinition[] = [
  {
    name: 'test-and-lint',
    description: 'Run linting, type-checking, and tests in sequence.',
    steps: [
      {
        label: 'lint',
        action: 'bash',
        content: 'npm run lint 2>&1 || true',
        continueOnError: true,
      },
      {
        label: 'typecheck',
        action: 'bash',
        content: 'npx tsc --noEmit 2>&1',
        continueOnError: true,
      },
      {
        label: 'test',
        action: 'bash',
        content: 'npm test 2>&1',
      },
    ],
  },
  {
    name: 'build-and-verify',
    description: 'Build the project and verify the output.',
    steps: [
      {
        label: 'clean',
        action: 'bash',
        content: 'rm -rf dist/ build/ 2>/dev/null; echo "Clean complete"',
        continueOnError: true,
      },
      {
        label: 'build',
        action: 'bash',
        content: 'npm run build 2>&1',
      },
      {
        label: 'verify',
        action: 'bash',
        content: 'ls -la dist/ 2>/dev/null || ls -la build/ 2>/dev/null || echo "No build output directory found"',
      },
    ],
  },
  {
    name: 'review-changes',
    description: 'Review current git changes with an agent before committing.',
    steps: [
      {
        label: 'diff',
        action: 'bash',
        content: 'git diff --stat && echo "---" && git diff',
      },
      {
        label: 'review',
        action: 'agent',
        content: 'Review the git diff output above. Identify potential issues: bugs, security concerns, style violations, missing tests. Provide a brief summary.',
      },
    ],
  },
]

let initialized = false

/**
 * Register all bundled workflows. Safe to call multiple times.
 */
export function initBundledWorkflows(): void {
  if (initialized) return
  initialized = true

  for (const wf of BUNDLED_WORKFLOWS) {
    registerWorkflow(wf)
  }
}
