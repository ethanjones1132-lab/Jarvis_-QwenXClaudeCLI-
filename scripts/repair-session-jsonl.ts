import { basename } from 'path'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'

type TranscriptEntry = {
  type?: string
  uuid?: string
  parentUuid?: string | null
  message?: {
    content?: unknown
  }
}

function usage(): never {
  throw new Error(
    'Usage: bun run scripts/repair-session-jsonl.ts <path-to-session.jsonl> [--in-place]',
  )
}

function parseArgs(argv: string[]): { filePath: string; inPlace: boolean } {
  const args = argv.slice(2)
  const filePath = args.find(arg => !arg.startsWith('--'))
  if (!filePath) {
    usage()
  }
  return {
    filePath,
    inPlace: args.includes('--in-place'),
  }
}

function isChainMessage(entry: TranscriptEntry): boolean {
  return (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'attachment' ||
    entry.type === 'system'
  )
}

function collectToolUseIds(entry: TranscriptEntry): string[] {
  const content = entry.message?.content
  if (!Array.isArray(content)) {
    return []
  }
  return content
    .filter(
      (block: any) => block?.type === 'tool_use' && typeof block.id === 'string',
    )
    .map((block: any) => block.id)
}

function pruneOrphanToolResults(entry: TranscriptEntry, knownToolUseIds: Set<string>): {
  entry: TranscriptEntry
  removed: number
} {
  const content = entry.message?.content
  if (!Array.isArray(content)) {
    return { entry, removed: 0 }
  }

  let removed = 0
  const nextContent = content.filter((block: any) => {
    if (block?.type !== 'tool_result') {
      return true
    }
    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : ''
    const keep = toolUseId && knownToolUseIds.has(toolUseId)
    if (!keep) {
      removed += 1
    }
    return keep
  })

  if (removed === 0) {
    return { entry, removed }
  }

  return {
    entry: {
      ...entry,
      message: {
        ...(entry.message ?? {}),
        content: nextContent,
      },
    },
    removed,
  }
}

async function main(): Promise<void> {
  const { filePath, inPlace } = parseArgs(process.argv)
  await stat(filePath)

  const raw = await readFile(filePath, 'utf8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  const knownUuids = new Set<string>()
  const knownToolUseIds = new Set<string>()
  let lastValidParent: string | null = null
  let repairedParents = 0
  let removedToolResults = 0

  const outputLines = lines.map(line => {
    let parsed = JSON.parse(line) as TranscriptEntry

    if (parsed.type === 'assistant') {
      for (const toolUseId of collectToolUseIds(parsed)) {
        knownToolUseIds.add(toolUseId)
      }
    }

    if (parsed.type === 'user') {
      const result = pruneOrphanToolResults(parsed, knownToolUseIds)
      parsed = result.entry
      removedToolResults += result.removed
    }

    if (isChainMessage(parsed) && typeof parsed.uuid === 'string') {
      const originalParent =
        typeof parsed.parentUuid === 'string' || parsed.parentUuid === null
          ? parsed.parentUuid
          : lastValidParent

      const parentExists =
        originalParent === null || knownUuids.has(originalParent)
      if (!parentExists) {
        parsed = {
          ...parsed,
          parentUuid: lastValidParent,
        }
        repairedParents += 1
      }

      knownUuids.add(parsed.uuid)
      lastValidParent = parsed.uuid
    }

    return JSON.stringify(parsed)
  })

  const output = `${outputLines.join('\n')}\n`

  if (inPlace) {
    const backupPath = `${filePath}.bak`
    await writeFile(backupPath, raw, 'utf8')
    await writeFile(filePath, output, 'utf8')
    console.log(
      `Repaired ${basename(filePath)} in place. Fixed parent links: ${repairedParents}. Removed orphan tool_result blocks: ${removedToolResults}. Backup: ${backupPath}`,
    )
    return
  }

  const outputPath = filePath.replace(/\.jsonl$/i, '.repaired.jsonl')
  await mkdir('.', { recursive: true })
  await writeFile(outputPath, output, 'utf8')
  console.log(
    `Wrote ${basename(outputPath)}. Fixed parent links: ${repairedParents}. Removed orphan tool_result blocks: ${removedToolResults}.`,
  )
}

await main()
