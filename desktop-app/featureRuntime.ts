import { randomUUID } from 'crypto'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { getCompanion, roll } from '../buddy/companion.js'
import { companionIntroText } from '../buddy/prompt.js'
import { renderFace, renderSprite } from '../buddy/sprites.js'
import {
  EYES,
  HATS,
  RARITIES,
  RARITY_STARS,
  SPECIES,
  STAT_NAMES,
  type CompanionBones,
  type Eye,
  type Hat,
  type Rarity,
  type Species,
} from '../buddy/types.js'
import {
  enableConfigs,
  getGlobalConfig,
  getOrCreateUserID,
  saveGlobalConfig,
  type JarvisCompanionProfile,
} from '../utils/config.js'
import type {
  DesktopBuddyProfile,
  DesktopBuddyProfileDraft,
  DesktopBuddySnapshot,
  DesktopBuddyRarity,
} from './types.js'

export const MAX_ENTRYPOINT_LINES = 200
const MAX_ENTRYPOINT_BYTES = 25_000
const LOCK_FILE = '.consolidate-lock'
const MEMORY_ENTRYPOINT_NAME = 'MEMORY.md'
const COMPANION_REACTION_TTL_MS = 10_000

const COORDINATOR_MODE_ALLOWED_TOOLS = [
  'Agent',
  'TaskStop',
  'SendMessage',
  'SyntheticOutput',
]

const ASYNC_AGENT_ALLOWED_TOOLS = [
  'Read',
  'WebSearch',
  'TodoWrite',
  'Grep',
  'WebFetch',
  'Glob',
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  'Skill',
  'SyntheticOutput',
  'ToolSearch',
  'EnterWorktree',
  'ExitWorktree',
]

const RARITY_FLOOR: Record<Rarity, number> = {
  common: 5,
  uncommon: 15,
  rare: 25,
  epic: 35,
  legendary: 50,
}

const COMPANION_NAME_BANK: Record<string, string[]> = {
  duck: ['Quill', 'Marsh', 'Pico', 'Drift', 'Sable'],
  goose: ['Brass', 'Piper', 'Ash', 'Morrow', 'Rune'],
  blob: ['Mote', 'Pebble', 'Echo', 'Kelp', 'Luma'],
  cat: ['Vesper', 'Miso', 'Cinder', 'Rook', 'Nori'],
  dragon: ['Ember', 'Aster', 'Pyre', 'Onyx', 'Vale'],
  octopus: ['Ink', 'Tangle', 'Ripple', 'Harbor', 'Nova'],
  owl: ['Iris', 'Hush', 'Orbit', 'Vale', 'Axiom'],
  penguin: ['Trek', 'Floe', 'Kite', 'Slate', 'Poe'],
  turtle: ['Moss', 'Harbor', 'Tide', 'Basil', 'Rune'],
  snail: ['Glint', 'Mica', 'Patch', 'Puddle', 'Lilt'],
  ghost: ['Wisp', 'Static', 'Velvet', 'Murmur', 'Halo'],
  axolotl: ['Lotus', 'Pebble', 'Aloe', 'Finch', 'Lune'],
  capybara: ['Juniper', 'Cove', 'Barley', 'Marlow', 'Dune'],
  cactus: ['Thorn', 'Sage', 'Oasis', 'Kindle', 'Flint'],
  robot: ['Circuit', 'Relay', 'Vector', 'Pulse', 'Atlas'],
  rabbit: ['Sprig', 'Junie', 'Clover', 'Bramble', 'Pip'],
  mushroom: ['Morel', 'Spore', 'Button', 'Truffle', 'Mica'],
  chonk: ['Biscuit', 'Rumble', 'Puff', 'Anchor', 'Mallow'],
}

const DEFAULT_COMPANION_NAMES = ['Scout', 'Warden', 'Echo', 'Harbor', 'Kite']
const COMPANION_PERSONALITY_LINES = [
  'spots weak links before they become regressions',
  'keeps the room calm while the logs get loud',
  'pokes at strange edges until the real issue blinks',
  'pulls the big picture back into view mid-turn',
  'offers dry commentary whenever the stack gets dramatic',
  'stays curious around weird failures and unfinished ideas',
  'likes steady progress, clean notes, and decisive follow-through',
]

const STAT_DESCRIPTIONS: Record<string, string> = {
  DEBUGGING: 'Reaction bias toward bugs, weak links, and regressions.',
  PATIENCE: 'Calmer copy during long or noisy work.',
  CHAOS: 'More edge-case curiosity and playful reactions.',
  WISDOM: 'More synthesis and big-picture reactions.',
  SNARK: 'Drier, sharper commentary.',
}

type DesktopCompanionOverlayState = {
  reaction: string | null
  reactionExpiresAt: number
}

export type DesktopCompanion = {
  id: string
  name: string
  species: string
  eye: string
  hat: string
  shiny: boolean
  rarity: DesktopBuddyRarity
  rarityStars: string
  personality: string
  face: string
  sprite: string[]
  stats: Record<string, number>
}

let companionOverlayState: DesktopCompanionOverlayState = {
  reaction: null,
  reactionExpiresAt: 0,
}

export function getCoordinatorToolNames(): {
  coordinatorTools: string[]
  workerTools: string[]
} {
  return {
    coordinatorTools: [...COORDINATOR_MODE_ALLOWED_TOOLS],
    workerTools: [...ASYNC_AGENT_ALLOWED_TOOLS],
  }
}

function getClaudeConfigDir(): string {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return join(appData, 'Claude')
}

function sanitizePath(input: string): string {
  return input.replace(/[^a-zA-Z0-9]/g, '-')
}

function getProjectStorageRoot(workspacePath: string): string {
  return join(getClaudeConfigDir(), 'projects', sanitizePath(workspacePath))
}

export function getDesktopMemoryDir(workspacePath: string): string {
  return join(getProjectStorageRoot(workspacePath), 'memory')
}

export function getDesktopMemoryEntrypoint(workspacePath: string): string {
  return join(getDesktopMemoryDir(workspacePath), MEMORY_ENTRYPOINT_NAME)
}

export async function readLastConsolidatedAtDesktop(
  workspacePath: string,
): Promise<number> {
  try {
    const lockStats = await stat(join(getDesktopMemoryDir(workspacePath), LOCK_FILE))
    return lockStats.mtimeMs
  } catch {
    return 0
  }
}

export async function listSessionsTouchedSinceDesktop(
  workspacePath: string,
  sinceMs: number,
): Promise<string[]> {
  try {
    const dir = getProjectStorageRoot(workspacePath)
    const entries = await readdir(dir, { withFileTypes: true })
    const matches = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(async entry => {
          const full = join(dir, entry.name)
          try {
            const details = await stat(full)
            return details.mtimeMs > sinceMs ? entry.name.replace(/\.jsonl$/i, '') : null
          } catch {
            return null
          }
        }),
    )
    return matches.filter((value): value is string => typeof value === 'string')
  } catch {
    return []
  }
}

export function isAutoMemoryEnabledDesktop(): boolean {
  return !/^(1|true)$/i.test(process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY ?? '')
}

export function isAutoDreamEnabledDesktop(): boolean {
  return isAutoMemoryEnabledDesktop()
}

export type EntrypointTruncation = {
  content: string
  lineCount: number
  byteCount: number
  wasLineTruncated: boolean
  wasByteTruncated: boolean
}

export function truncateEntrypointContentDesktop(raw: string): EntrypointTruncation {
  const trimmed = raw.trim()
  const contentLines = trimmed ? trimmed.split('\n') : []
  const lineCount = contentLines.length
  const byteCount = Buffer.byteLength(trimmed, 'utf8')
  const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES
  const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES

  if (!wasLineTruncated && !wasByteTruncated) {
    return {
      content: trimmed,
      lineCount,
      byteCount,
      wasLineTruncated,
      wasByteTruncated,
    }
  }

  let truncated = wasLineTruncated
    ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
    : trimmed

  while (Buffer.byteLength(truncated, 'utf8') > MAX_ENTRYPOINT_BYTES) {
    const cutAt = truncated.lastIndexOf('\n')
    truncated = cutAt > 0 ? truncated.slice(0, cutAt) : truncated.slice(0, -1)
  }

  return {
    content:
      truncated +
      `\n\n> WARNING: ${MEMORY_ENTRYPOINT_NAME} exceeded the desktop preview limits and was truncated.`,
    lineCount,
    byteCount,
    wasLineTruncated,
    wasByteTruncated,
  }
}

function hashString(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length)]!
}

function ensureDesktopCompanionConfig(): void {
  enableConfigs()
}

function getDesktopCompanionIdentity(): {
  userId: string
  identityLabel: string
} {
  ensureDesktopCompanionConfig()
  const config = getGlobalConfig()
  const userId = config.oauthAccount?.accountUuid ?? getOrCreateUserID()
  const identityLabel =
    config.oauthAccount?.displayName?.trim() ||
    config.oauthAccount?.emailAddress?.trim() ||
    `Local Jarvis user ${userId.slice(0, 8)}`
  return {
    userId,
    identityLabel,
  }
}

function normalizeSpecies(value: string | undefined, fallback: Species): Species {
  return SPECIES.includes(value as Species) ? (value as Species) : fallback
}

function normalizeEye(value: string | undefined, fallback: Eye): Eye {
  return EYES.includes(value as Eye) ? (value as Eye) : fallback
}

function normalizeHat(value: string | undefined, fallback: Hat): Hat {
  return HATS.includes(value as Hat) ? (value as Hat) : fallback
}

function normalizeRarity(
  value: string | undefined,
  fallback: Rarity,
): Rarity {
  return RARITIES.includes(value as Rarity) ? (value as Rarity) : fallback
}

function trimOrFallback(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : fallback
}

function buildStatsFromProfile(
  profile: Pick<JarvisCompanionProfile, 'id' | 'createdAt' | 'rarity'>,
): Record<(typeof STAT_NAMES)[number], number> {
  const rng = mulberry32(
    hashString(`${profile.id}:${profile.createdAt}:${profile.rarity}:stats`),
  )
  const floor = RARITY_FLOOR[profile.rarity]
  const peak = pick(rng, STAT_NAMES)
  let dump = pick(rng, STAT_NAMES)
  while (dump === peak) {
    dump = pick(rng, STAT_NAMES)
  }

  const stats = {} as Record<(typeof STAT_NAMES)[number], number>
  for (const name of STAT_NAMES) {
    if (name === peak) {
      stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30))
    } else if (name === dump) {
      stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15))
    } else {
      stats[name] = floor + Math.floor(rng() * 40)
    }
  }
  return stats
}

function buildBonesFromProfile(profile: JarvisCompanionProfile): CompanionBones {
  return {
    rarity: profile.rarity,
    species: profile.species,
    eye: profile.eye,
    hat: profile.hat,
    shiny: profile.shiny,
    stats: buildStatsFromProfile(profile),
  }
}

function buildDesktopProfile(profile: JarvisCompanionProfile): DesktopBuddyProfile {
  return {
    id: profile.id,
    name: profile.name,
    personality: profile.personality,
    species: profile.species,
    eye: profile.eye,
    hat: profile.hat,
    shiny: profile.shiny,
    rarity: profile.rarity,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    isActive: false,
  }
}

function setDesktopCompanionReaction(
  reaction: string | null,
  ttlMs = COMPANION_REACTION_TTL_MS,
): void {
  companionOverlayState = reaction
    ? {
        reaction,
        reactionExpiresAt: Date.now() + ttlMs,
      }
    : {
        reaction: null,
        reactionExpiresAt: 0,
      }
}

function getDesktopCompanionReaction(): string | null {
  if (
    companionOverlayState.reaction &&
    companionOverlayState.reactionExpiresAt > Date.now()
  ) {
    return companionOverlayState.reaction
  }
  return null
}

function createDesktopCompanionSoul(
  userId: string,
  species: Species,
): {
  name: string
  personality: string
} {
  const rng = mulberry32(hashString(`${userId}:${species}:${Date.now()}:${Math.random()}`))
  const names = COMPANION_NAME_BANK[species] ?? DEFAULT_COMPANION_NAMES
  return {
    name: pick(rng, names),
    personality: pick(rng, COMPANION_PERSONALITY_LINES),
  }
}

function createDefaultBuddyDraft(userId: string): DesktopBuddyProfileDraft {
  const { bones } = roll(userId)
  const soul = createDesktopCompanionSoul(userId, bones.species)
  return {
    name: soul.name,
    personality: soul.personality,
    species: bones.species,
    eye: bones.eye,
    hat: bones.hat,
    shiny: bones.shiny,
    rarity: bones.rarity,
  }
}

function sanitizeBuddyDraft(
  draft: Partial<DesktopBuddyProfileDraft> | undefined,
  userId: string,
): DesktopBuddyProfileDraft {
  const fallback = createDefaultBuddyDraft(userId)
  return {
    name: trimOrFallback(draft?.name, fallback.name),
    personality: trimOrFallback(draft?.personality, fallback.personality),
    species: normalizeSpecies(draft?.species, fallback.species),
    eye: normalizeEye(draft?.eye, fallback.eye),
    hat: normalizeHat(draft?.hat, fallback.hat),
    shiny: typeof draft?.shiny === 'boolean' ? draft.shiny : fallback.shiny,
    rarity: normalizeRarity(draft?.rarity, fallback.rarity),
  }
}

function migrateLegacyCompanionIfNeeded(): {
  profiles: JarvisCompanionProfile[]
  activeProfileId: string | null
} {
  const config = getGlobalConfig()
  const existingProfiles = Array.isArray(config.jarvisCompanionProfiles)
    ? config.jarvisCompanionProfiles
    : []
  if (existingProfiles.length > 0) {
    const activeProfileId = config.jarvisActiveCompanionProfileId ?? existingProfiles[0]?.id ?? null
    return {
      profiles: existingProfiles,
      activeProfileId,
    }
  }

  const legacy = getCompanion()
  if (!legacy) {
    return {
      profiles: [],
      activeProfileId: null,
    }
  }

  const profile: JarvisCompanionProfile = {
    id: `legacy-${legacy.hatchedAt}`,
    name: legacy.name,
    personality: legacy.personality,
    species: legacy.species,
    eye: legacy.eye,
    hat: legacy.hat,
    shiny: legacy.shiny,
    rarity: legacy.rarity,
    createdAt: legacy.hatchedAt,
    updatedAt: legacy.hatchedAt,
  }

  saveGlobalConfig(current => ({
    ...current,
    jarvisCompanionProfiles: [profile],
    jarvisActiveCompanionProfileId: profile.id,
  }))

  return {
    profiles: [profile],
    activeProfileId: profile.id,
  }
}

function getStoredCompanionProfiles(): {
  profiles: JarvisCompanionProfile[]
  activeProfileId: string | null
} {
  const { userId } = getDesktopCompanionIdentity()
  const migrated = migrateLegacyCompanionIfNeeded()
  const normalizedProfiles = migrated.profiles
    .filter((profile): profile is JarvisCompanionProfile => Boolean(profile?.id))
    .map(profile => {
      const fallback = createDefaultBuddyDraft(userId)
      return {
        id: profile.id,
        name: trimOrFallback(profile.name, fallback.name),
        personality: trimOrFallback(profile.personality, fallback.personality),
        species: normalizeSpecies(profile.species, fallback.species),
        eye: normalizeEye(profile.eye, fallback.eye),
        hat: normalizeHat(profile.hat, fallback.hat),
        shiny: Boolean(profile.shiny),
        rarity: normalizeRarity(profile.rarity, fallback.rarity),
        createdAt:
          typeof profile.createdAt === 'number' && Number.isFinite(profile.createdAt)
            ? profile.createdAt
            : Date.now(),
        updatedAt:
          typeof profile.updatedAt === 'number' && Number.isFinite(profile.updatedAt)
            ? profile.updatedAt
            : Date.now(),
      }
    })

  const activeProfileId =
    normalizedProfiles.find(profile => profile.id === migrated.activeProfileId)?.id ??
    normalizedProfiles[0]?.id ??
    null

  return {
    profiles: normalizedProfiles,
    activeProfileId,
  }
}

function saveStoredCompanionProfiles(
  profiles: JarvisCompanionProfile[],
  activeProfileId: string | null,
): void {
  saveGlobalConfig(current => ({
    ...current,
    jarvisCompanionProfiles: profiles,
    jarvisActiveCompanionProfileId: activeProfileId,
  }))
}

function getActiveCompanionProfile(): JarvisCompanionProfile | null {
  const { profiles, activeProfileId } = getStoredCompanionProfiles()
  return profiles.find(profile => profile.id === activeProfileId) ?? null
}

export function listDesktopBuddyProfiles(): DesktopBuddyProfile[] {
  const { profiles, activeProfileId } = getStoredCompanionProfiles()
  return profiles.map(profile => ({
    ...buildDesktopProfile(profile),
    isActive: profile.id === activeProfileId,
  }))
}

function buildDesktopCompanionFromProfile(
  profile: JarvisCompanionProfile,
): DesktopCompanion {
  const bones = buildBonesFromProfile(profile)
  return {
    id: profile.id,
    name: profile.name,
    species: profile.species,
    eye: profile.eye,
    hat: profile.hat,
    shiny: profile.shiny,
    rarity: profile.rarity,
    rarityStars: RARITY_STARS[profile.rarity],
    personality: profile.personality,
    face: renderFace(bones),
    sprite: renderSprite(bones),
    stats: bones.stats,
  }
}

export function getDesktopCompanion(
  workspacePath: string,
  userSeed = process.env.USERNAME ?? 'local-user',
): DesktopCompanion {
  void workspacePath
  const activeProfile = getActiveCompanionProfile()
  if (activeProfile) {
    return buildDesktopCompanionFromProfile(activeProfile)
  }

  const draft = createDefaultBuddyDraft(userSeed)
  const previewProfile: JarvisCompanionProfile = {
    id: 'preview',
    name: draft.name,
    personality: draft.personality,
    species: draft.species as Species,
    eye: draft.eye as Eye,
    hat: draft.hat as Hat,
    shiny: draft.shiny,
    rarity: draft.rarity as Rarity,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  return buildDesktopCompanionFromProfile(previewProfile)
}

export function getDesktopBuddySnapshot(): DesktopBuddySnapshot {
  const { userId, identityLabel } = getDesktopCompanionIdentity()
  const config = getGlobalConfig()
  const { profiles, activeProfileId } = getStoredCompanionProfiles()
  const activeProfile = profiles.find(profile => profile.id === activeProfileId) ?? null
  const muted = Boolean(config.companionMuted)
  const fallbackDraft = createDefaultBuddyDraft(userId)
  const previewProfile =
    activeProfile ??
    ({
      id: 'preview',
      name: 'No active buddy',
      personality:
        'Create a Jarvis buddy profile in Companion Studio or use /buddy for a quick hatch.',
      species: fallbackDraft.species as Species,
      eye: fallbackDraft.eye as Eye,
      hat: fallbackDraft.hat as Hat,
      shiny: fallbackDraft.shiny,
      rarity: fallbackDraft.rarity as Rarity,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } satisfies JarvisCompanionProfile)
  const desktopCompanion = buildDesktopCompanionFromProfile(previewProfile)
  const identityBound = Boolean(activeProfile)

  return {
    active: true,
    hatched: Boolean(activeProfile),
    hatchedAt: activeProfile?.createdAt ?? null,
    muted,
    identityBound,
    identityLabel:
      activeProfile === null
        ? 'Manual Jarvis buddy studio'
        : `${identityLabel} / profile-bound Jarvis buddy`,
    activeProfileId,
    profiles: profiles.map(profile => ({
      ...buildDesktopProfile(profile),
      isActive: profile.id === activeProfileId,
    })),
    name: desktopCompanion.name,
    species: desktopCompanion.species,
    eye: desktopCompanion.eye,
    hat: desktopCompanion.hat,
    shiny: desktopCompanion.shiny,
    rarity: desktopCompanion.rarity,
    rarityStars: desktopCompanion.rarityStars,
    personality: desktopCompanion.personality,
    face: desktopCompanion.face,
    sprite: desktopCompanion.sprite,
    stats: desktopCompanion.stats,
    statDescriptions: { ...STAT_DESCRIPTIONS },
    reaction: muted ? null : getDesktopCompanionReaction(),
    availableActions: activeProfile
      ? ['pet', muted ? 'unmute' : 'mute', 'new', 'edit', 'delete']
      : ['hatch', 'new'],
  }
}

export function createDesktopBuddyProfile(
  draft?: Partial<DesktopBuddyProfileDraft>,
): DesktopBuddySnapshot {
  const { userId } = getDesktopCompanionIdentity()
  const nextDraft = sanitizeBuddyDraft(draft, userId)
  const now = Date.now()
  const profile: JarvisCompanionProfile = {
    id: randomUUID(),
    name: nextDraft.name,
    personality: nextDraft.personality,
    species: nextDraft.species as Species,
    eye: nextDraft.eye as Eye,
    hat: nextDraft.hat as Hat,
    shiny: nextDraft.shiny,
    rarity: nextDraft.rarity as Rarity,
    createdAt: now,
    updatedAt: now,
  }
  const { profiles } = getStoredCompanionProfiles()
  saveStoredCompanionProfiles([...profiles, profile], profile.id)
  saveGlobalConfig(current => ({
    ...current,
    companionMuted: false,
  }))
  setDesktopCompanionReaction(`${profile.name} joined the rail beside your prompt box.`)
  return getDesktopBuddySnapshot()
}

export function updateDesktopBuddyProfile(
  profileId: string,
  draft: Partial<DesktopBuddyProfileDraft>,
): DesktopBuddySnapshot {
  const { userId } = getDesktopCompanionIdentity()
  const { profiles, activeProfileId } = getStoredCompanionProfiles()
  const target = profiles.find(profile => profile.id === profileId)
  if (!target) {
    return getDesktopBuddySnapshot()
  }

  const sanitized = sanitizeBuddyDraft(
    {
      name: draft.name ?? target.name,
      personality: draft.personality ?? target.personality,
      species: draft.species ?? target.species,
      eye: draft.eye ?? target.eye,
      hat: draft.hat ?? target.hat,
      shiny: draft.shiny ?? target.shiny,
      rarity: draft.rarity ?? target.rarity,
    },
    userId,
  )

  const updatedProfiles = profiles.map(profile =>
    profile.id === profileId
      ? {
          ...profile,
          name: sanitized.name,
          personality: sanitized.personality,
          species: sanitized.species as Species,
          eye: sanitized.eye as Eye,
          hat: sanitized.hat as Hat,
          shiny: sanitized.shiny,
          rarity: sanitized.rarity as Rarity,
          updatedAt: Date.now(),
        }
      : profile,
  )

  saveStoredCompanionProfiles(updatedProfiles, activeProfileId)
  setDesktopCompanionReaction(`${sanitized.name} was updated in Companion Studio.`)
  return getDesktopBuddySnapshot()
}

export function selectDesktopBuddyProfile(
  profileId: string,
): DesktopBuddySnapshot {
  const { profiles } = getStoredCompanionProfiles()
  const nextActive = profiles.find(profile => profile.id === profileId)
  if (!nextActive) {
    return getDesktopBuddySnapshot()
  }
  saveStoredCompanionProfiles(profiles, profileId)
  setDesktopCompanionReaction(`${nextActive.name} is now your active Jarvis companion.`)
  return getDesktopBuddySnapshot()
}

export function deleteDesktopBuddyProfile(
  profileId: string,
): DesktopBuddySnapshot {
  const { profiles, activeProfileId } = getStoredCompanionProfiles()
  const remaining = profiles.filter(profile => profile.id !== profileId)
  const nextActiveId =
    activeProfileId === profileId ? remaining[0]?.id ?? null : activeProfileId
  saveStoredCompanionProfiles(remaining, nextActiveId)
  setDesktopCompanionReaction(
    remaining[0]
      ? `${remaining[0].name} is still on the rail.`
      : 'The companion lane is clear again.',
  )
  return getDesktopBuddySnapshot()
}

export function hatchDesktopCompanion(): DesktopBuddySnapshot {
  const current = getActiveCompanionProfile()
  if (current) {
    setDesktopCompanionReaction(`${current.name} is already active on the rail.`)
    return getDesktopBuddySnapshot()
  }
  return createDesktopBuddyProfile()
}

export function rehatchDesktopCompanion(): DesktopBuddySnapshot {
  const current = getActiveCompanionProfile()
  if (!current) {
    return createDesktopBuddyProfile()
  }
  const { userId } = getDesktopCompanionIdentity()
  const soul = createDesktopCompanionSoul(userId, current.species)
  return updateDesktopBuddyProfile(current.id, {
    name: soul.name,
    personality: soul.personality,
  })
}

export function petDesktopCompanion(): DesktopBuddySnapshot {
  const activeProfile = getActiveCompanionProfile()
  if (!activeProfile) {
    return hatchDesktopCompanion()
  }
  setDesktopCompanionReaction(
    `${activeProfile.name} leans into the attention and settles back onto the rail.`,
  )
  return getDesktopBuddySnapshot()
}

export function muteDesktopCompanion(): DesktopBuddySnapshot {
  ensureDesktopCompanionConfig()
  saveGlobalConfig(current => ({
    ...current,
    companionMuted: true,
  }))
  setDesktopCompanionReaction(null)
  return getDesktopBuddySnapshot()
}

export function unmuteDesktopCompanion(): DesktopBuddySnapshot {
  ensureDesktopCompanionConfig()
  saveGlobalConfig(current => ({
    ...current,
    companionMuted: false,
  }))
  const activeProfile = getActiveCompanionProfile()
  if (activeProfile) {
    setDesktopCompanionReaction(`${activeProfile.name} is back on the rail.`, 8_000)
  }
  return getDesktopBuddySnapshot()
}

export function resetDesktopCompanion(): DesktopBuddySnapshot {
  saveStoredCompanionProfiles([], null)
  saveGlobalConfig(current => ({
    ...current,
    companionMuted: false,
  }))
  setDesktopCompanionReaction(
    'The companion lane is quiet again. Create a new buddy whenever you want.',
  )
  return getDesktopBuddySnapshot()
}

export function getDesktopCompanionIntro(): {
  text: string
  hatchedAt: number
} | null {
  ensureDesktopCompanionConfig()
  const config = getGlobalConfig()
  const activeProfile = getActiveCompanionProfile()
  if (!activeProfile || config.companionMuted) {
    return null
  }
  return {
    text: companionIntroText(activeProfile.name, activeProfile.species),
    hatchedAt: activeProfile.updatedAt,
  }
}

export function triggerSessionEventReaction(
  event: 'tool_call' | 'tool_error' | 'thinking' | 'turn_complete' | 'session_start' | 'session_error',
  detail?: string,
): void {
  const profile = getActiveCompanionProfile()
  if (!profile || Boolean(getGlobalConfig().companionMuted)) return

  const stats = buildStatsFromProfile(profile)
  const snark = stats.SNARK ?? 0
  const wisdom = stats.WISDOM ?? 0
  const debug = stats.DEBUGGING ?? 0
  const chaos = stats.CHAOS ?? 0
  const patience = stats.PATIENCE ?? 0

  const lines: Record<typeof event, string[]> = {
    session_start: [
      `${profile.name} perks up and settles in beside the prompt box.`,
      wisdom > 60
        ? `${profile.name} takes a quiet breath. Ready.`
        : `${profile.name} flicks an ear. Let's go.`,
      debug > 60
        ? `${profile.name} is already scanning for edge cases.`
        : `${profile.name} nods. Session open.`,
      chaos > 60
        ? `${profile.name} is inexplicably excited about whatever comes next.`
        : `${profile.name} settles in. Ready when you are.`,
      snark > 70
        ? `${profile.name} raises an eyebrow expectantly.`
        : `${profile.name} is here and paying attention.`,
      `${profile.name} is on the rail.`,
    ],
    tool_call: [
      debug > 60
        ? `${profile.name} watches the tool call closely.`
        : `${profile.name} glances at the tool.`,
      `${profile.name} notes something's running.`,
      patience > 60
        ? `${profile.name} waits calmly while the tool executes.`
        : `${profile.name} tilts its head at the tool output.`,
      debug > 70
        ? `${profile.name} is tracking every argument.`
        : `${profile.name} keeps one eye on the result.`,
      snark > 70
        ? `${profile.name} mentally bets on the outcome.`
        : `${profile.name} observes.`,
      chaos > 60
        ? `${profile.name} wonders what the tool will find.`
        : `${profile.name} watches quietly.`,
    ],
    tool_error: [
      snark > 60
        ? `${profile.name} raises an eyebrow. Again.`
        : `${profile.name} looks concerned.`,
      snark > 80
        ? `${profile.name} quietly judges the stack trace.`
        : `${profile.name} watches the error.`,
      debug > 70
        ? `${profile.name} is already diagnosing the root cause.`
        : `${profile.name} frowns at the output.`,
      wisdom > 60
        ? `${profile.name} thinks it knows what went wrong.`
        : `${profile.name} makes a note.`,
      snark > 65
        ? `${profile.name} files this under "predictable".`
        : `${profile.name} hopes the retry goes better.`,
      patience > 60
        ? `${profile.name} remains calm. Errors happen.`
        : `${profile.name} looks mildly exasperated.`,
    ],
    thinking: [
      wisdom > 60
        ? `${profile.name} sits very still.`
        : `${profile.name} waits.`,
      chaos > 60
        ? `${profile.name} seems oddly excited about this.`
        : `${profile.name} is patient.`,
      patience > 70
        ? `${profile.name} is perfectly comfortable with the pause.`
        : `${profile.name} watches the cursor blink.`,
      wisdom > 70
        ? `${profile.name} appreciates the thinking step.`
        : `${profile.name} keeps watch.`,
      debug > 60
        ? `${profile.name} is curious what the THOUGHT will surface.`
        : `${profile.name} hums quietly.`,
    ],
    turn_complete: [
      `${profile.name} relaxes.`,
      debug > 60 ? `${profile.name} checks the output.` : `${profile.name} approves.`,
      wisdom > 70
        ? `${profile.name} nods. Good answer.`
        : `${profile.name} settles back.`,
      snark > 70
        ? `${profile.name} concedes that went well.`
        : `${profile.name} looks satisfied.`,
      chaos > 60
        ? `${profile.name} is already curious about the next one.`
        : `${profile.name} marks it done.`,
    ],
    session_error: [
      snark > 70
        ? `${profile.name} squints at the error. Typical.`
        : `${profile.name} looks worried.`,
      debug > 60
        ? `${profile.name} is already reading the stack trace.`
        : `${profile.name} wishes it could help more.`,
      wisdom > 60
        ? `${profile.name} thinks this might be environmental.`
        : `${profile.name} watches the logs scroll.`,
      patience > 60
        ? `${profile.name} takes a breath. Recoverable.`
        : `${profile.name} winces.`,
    ],
  }

  const pool = lines[event]
  const rng = mulberry32(hashString(`${profile.id}:${event}:${Date.now()}`))
  const line = pick(rng, pool)
  setDesktopCompanionReaction(
    detail ? `${line} (${detail.slice(0, 40)})` : line,
    event === 'session_start' ? 12_000 : 7_000,
  )
}

export async function readMemoryPreview(workspacePath: string): Promise<{
  preview: string[]
  lineCount: number
  previewTruncated: boolean
  entrypointPath: string
  memoryDir: string
}> {
  const entrypointPath = getDesktopMemoryEntrypoint(workspacePath)
  const memoryDir = getDesktopMemoryDir(workspacePath)
  try {
    const raw = await readFile(entrypointPath, 'utf8')
    const truncated = truncateEntrypointContentDesktop(raw)
    return {
      preview: truncated.content.split('\n').slice(0, 8).filter(Boolean),
      lineCount: truncated.lineCount,
      previewTruncated:
        truncated.wasLineTruncated ||
        truncated.wasByteTruncated ||
        truncated.content.split('\n').length > 8,
      entrypointPath,
      memoryDir,
    }
  } catch {
    return {
      preview: ['No MEMORY.md index has been written for this workspace yet.'],
      lineCount: 0,
      previewTruncated: false,
      entrypointPath,
      memoryDir,
    }
  }
}
