#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

const result = spawnSync(
  process.platform === 'win32' ? 'bun.exe' : 'bun',
  ['run', 'scripts/generate-tool-reference.ts'],
  {
    stdio: 'inherit',
    // Force external/non-ant build context so Bun doesn't execute ant-only
    // code paths (e.g. getAntModelOverrideConfig) that are dead-code eliminated
    // in production builds via --define process.env.USER_TYPE="external".
    env: { ...process.env, USER_TYPE: 'external' },
  },
)

if (result.error) {
  console.error(
    'prepare-src: failed to launch Bun for tool reference generation:',
    result.error.message,
  )
  process.exit(1)
}

if (typeof result.status === 'number' && result.status !== 0) {
  process.exit(result.status)
}

console.log('prepare-src: generated tool reference artifacts')
