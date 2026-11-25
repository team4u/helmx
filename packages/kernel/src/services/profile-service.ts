/**
 * ProfileService: manages `profiles/<id>/` (profile.json + SYSTEM.md).
 * Profile schema conforms to @helmx/protocol (id required; name/model/tags optional).
 * An empty or omitted model means unconfigured—runtime reports an explicit error rather than fabricating a default model in the service layer.
 * Long-term MEMORY.md is autonomously managed by the builtin:memory plugin and does not belong here.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HelmxError,
  PROFILE_STARTERS_MAX_ITEMS,
  PROFILE_STARTER_LABEL_MAX_LENGTH,
  PROFILE_STARTER_PROMPT_MAX_LENGTH,
  assertProfileId,
  assertSkillId,
  isJsonObject,
  isValidProfileId,
  type Profile,
  type ProfileChangedEvent,
  type ProfileStarterPrompt,
} from '@helmx/protocol'
import {
  atomicWriteFile,
  atomicWriteJson,
  readJsonFileOptional,
  readTextFile,
} from './atomic-file.js'
import { withFileLock } from './file-lock.js'

export type { Profile }

export const DEFAULT_PROFILE_ID = 'assistant'
const DEFAULT_PROFILE_NAME = 'person assist'
/** Valid thinking level enum values (aligned with pi-ai ModelThinkingLevel; single source shared with HTTP validation). */
export const PROFILE_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const THINKING_LEVELS = new Set<string>(PROFILE_THINKING_LEVELS)

/**
 * Cross-platform absolute path check: POSIX `/`, Windows drive `^[a-zA-Z]:[\\/]` and UNC `^\\\\[^\\]+\\[^\\]+`.
 * Evaluates remote/Windows target path shape independently of the Hub host OS.
 */
export function isCrossPlatformAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p)
}

/**
 * Default resident system prompt (kernel-only, zero hardcoded plugin/skill/worktree copy).
 * Enabled plugins dynamically inject their own capabilities (skills, memory, etc.) via hooks.
 */
export const SYSTEM_DEFAULT = [
  '# System Prompt',
  '',
  'You are a personal assistant running on the Helmx microkernel.',
  '',
  'Use Markdown for normal replies. When generating files for users to view on Web, register artifacts via `write(..., artifact: true)` or `register_artifact({ path })`, and link them in your reply using `[filename](artifact:<id>)` or `![image](artifact:<id>)`.',
  '',
].join('\n')

function profileDir(dataDir: string, id: string): string {
  return join(dataDir, 'profiles', id)
}

export interface ProfileValidationOptions {
  /** Optional subject prefix (e.g. `profile 'foo' `) prepended to error messages. */
  prefix?: string
  /** Error sink; defaults to throwing a plain `Error` (HTTP boundary supplies `ValidationError`). */
  fail?: (message: string) => never
}

const defaultFail = (message: string): never => {
  throw new Error(message)
}

/** Unicode code-point length (surrogate pairs count as 1, matching visual display width; canonical across contract). */
function codePointLength(text: string): number {
  let count = 0
  for (const _ of text) count += 1
  return count
}

/** Validate a single starter prompt at the boundary: label is normalized by trimming, prompt preserves original text;
 * unknown fields are rejected (starters are user-editable data; silently dropping fields causes data loss in UI saves). */
function validateProfileStarter(item: unknown, at: string, fail: (message: string) => never): ProfileStarterPrompt {
  if (!isJsonObject(item)) fail(`${at} must be { label, prompt } object`)
  const obj = item as Record<string, unknown>
  const label = obj['label']
  const prompt = obj['prompt']
  if (Object.keys(obj).some((key) => key !== 'label' && key !== 'prompt')) {
    fail(`${at} may only accept label and prompt fields`)
  }
  if (typeof label !== 'string') fail(`${at}.label must be a string`)
  const normalizedLabel = (label as string).trim()
  if (codePointLength(normalizedLabel) === 0) fail(`${at}.label cannot be empty after trimming`)
  if (codePointLength(normalizedLabel) > PROFILE_STARTER_LABEL_MAX_LENGTH) {
    fail(`${at}.label at most ${PROFILE_STARTER_LABEL_MAX_LENGTH} Unicode code points`)
  }
  if (typeof prompt !== 'string') fail(`${at}.prompt must be a string`)
  const promptText = prompt as string
  if (promptText.trim() === '') fail(`${at}.prompt cannot be pure whitespace`)
  if (codePointLength(promptText) > PROFILE_STARTER_PROMPT_MAX_LENGTH) {
    fail(`${at}.prompt at most ${PROFILE_STARTER_PROMPT_MAX_LENGTH} Unicode code points (preserves original text without truncation)`)
  }
  return { label: normalizedLabel, prompt: promptText }
}

/** Shared Profile starters validation (used by both ProfileService and HTTP parseProfileBody). */
export function validateProfileStarters(raw: unknown, opts: ProfileValidationOptions = {}): ProfileStarterPrompt[] {
  const prefix = opts.prefix ?? ''
  const fail = opts.fail ?? defaultFail
  if (!Array.isArray(raw)) {
    fail(`${prefix}starters must be an array of { label, prompt } objects`)
  }
  const items = raw as unknown[]
  if (items.length > PROFILE_STARTERS_MAX_ITEMS) {
    fail(`${prefix}starters at most ${PROFILE_STARTERS_MAX_ITEMS} items`)
  }
  return items.map((item, index) => validateProfileStarter(item, `${prefix}starters[${index}]`, fail))
}

const ALLOWED_PROFILE_KEYS = new Set([
  'id',
  'name',
  'model',
  'thinkingLevel',
  'nodeId',
  'cwd',
  'tags',
  'skills',
  'starters',
  'managedByPlugin',
  'restrictToCwd',
  'system',
])

/** Validate Profile input at the boundary (shared by create/update); returns the normalized persistable shape. */
export function validateProfileInput(input: unknown): Profile {
  if (!isJsonObject(input)) throw new Error('profile must be an object')
  const id = input['id']
  if (typeof id !== 'string' || !isValidProfileId(id)) {
    throw new Error(`illegal profile id: ${String(id)} (only allows a-z 0-9 and hyphen)`)
  }
  const prefix = `profile '${id}' `
  for (const key of Object.keys(input)) {
    if (!ALLOWED_PROFILE_KEYS.has(key)) {
      throw new Error(`${prefix}contains unknown field '${key}'`)
    }
  }
  const profile: Profile = { id }
  const name = input['name']
  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim() === '') {
      throw new Error(`${prefix}name cannot be empty`)
    }
    profile.name = name
  }
  const model = input['model']
  if (model !== undefined) {
    if (typeof model !== 'string') throw new Error(`${prefix}model must be a string`)
    profile.model = model
  }
  const thinkingLevel = input['thinkingLevel']
  if (thinkingLevel !== undefined) {
    if (typeof thinkingLevel !== 'string' || !THINKING_LEVELS.has(thinkingLevel)) {
      throw new Error(`${prefix}thinkingLevel is invalid (valid values: ${[...THINKING_LEVELS].join(' | ')})`)
    }
    profile.thinkingLevel = thinkingLevel
  }
  const nodeId = input['nodeId']
  if (nodeId !== undefined) {
    if (typeof nodeId !== 'string' || nodeId === '') {
      throw new Error(`${prefix}nodeId must be a non-empty string when present (compute node ID)`)
    }
    profile.nodeId = nodeId
  }
  const cwd = input['cwd']
  if (cwd !== undefined) {
    if (typeof cwd !== 'string' || cwd === '') {
      throw new Error(`${prefix}cwd must be a non-empty string when present (target platform absolute path)`)
    }
    profile.cwd = cwd
  }
  const tags = input['tags']
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
      throw new Error(`${prefix}tags must be a string array`)
    }
    profile.tags = [...tags] as string[]
  }
  // Skill allowlist: elements must be valid skill IDs; duplicates are deduplicated before persisting ([] is preserved
  // to disable all skills). Saving not-yet-installed IDs is permitted since skill directories are runtime state;
  // runtime checks availability uniformly via isSkillAvailable.
  const skills = input['skills']
  if (skills !== undefined) {
    if (!Array.isArray(skills) || skills.some((s) => typeof s !== 'string')) {
      throw new Error(`${prefix}skills must be a string array (skill ID allowlist; defaults to all enabled, empty array disables all)`)
    }
    const deduped: string[] = []
    for (const skillId of skills) {
      assertSkillId(skillId)
      if (!deduped.includes(skillId)) deduped.push(skillId)
    }
    profile.skills = deduped
  }
  // Empty-conversation starter prompts: up to 6 items; label is trimmed, non-empty, and <=24 code points (persisted trimmed);
  // prompt must not be pure whitespace and preserves original text (<=4000 code points, never truncated).
  // An empty array [] is explicitly persisted (meaning "cleared custom starters, fall back to host defaults"); omitted leaves field unset.
  const starters = input['starters']
  if (starters !== undefined) {
    profile.starters = validateProfileStarters(starters, { prefix })
  }
  const managedByPlugin = input['managedByPlugin']
  if (managedByPlugin !== undefined) {
    if (typeof managedByPlugin !== 'string' || managedByPlugin.trim() === '') {
      throw new Error(`${prefix}managedByPlugin must be a non-empty string when present (owning plugin ID)`)
    }
    profile.managedByPlugin = managedByPlugin
  }
  const restrictToCwd = input['restrictToCwd']
  if (restrictToCwd !== undefined) {
    if (typeof restrictToCwd !== 'boolean') {
      throw new Error(`${prefix}restrictToCwd must be a boolean when present (cwd guardrail for file tools, defaults to false)`)
    }
    profile.restrictToCwd = restrictToCwd
  }
  return profile
}

/** Validate file asset against the current contract without guessing legacy formats or ignoring unknown execution fields. */
function normalizeProfile(value: unknown, id: string): Profile {
  if (!isJsonObject(value)) throw new Error(`profile.json has invalid structure: ${id}`)
  return validateProfileInput({ ...value, id })
}

/** Binding re-check dependency before deletion: HTTP layer injects conversation query so the service layer closes
 * the race window between route fast-path check, concurrent create/PATCH binding, and disk deletion. */
interface ProfileDeleteDeps {
  isProfileInUse(profileId: string): boolean | Promise<boolean>
}

/**
 * Optional event publish port (narrow structural slice of the runtime's EventHub):
 * ProfileService emits `profile.changed` after successful save/delete so connected
 * Web/CLI clients re-read the profile catalog. Omitted in pure-service tests.
 */
export interface ProfileServiceEvents {
  publish(type: 'profile.changed', payload: unknown): unknown
}

export class ProfileService {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; profile: Profile }>()
  private mutationEpochValue = 0

  constructor(
    private readonly dataDir: string,
    private readonly events?: ProfileServiceEvents,
    private readonly options?: { assertWritable?: () => void },
  ) {}

  get mutationEpoch(): number {
    return this.mutationEpochValue
  }

  /** Invalidate cached `profile.json` entries (invoked by `AssetReloader` on `profiles/` changes or after mutations). */
  invalidateCache(id?: string): void {
    this.mutationEpochValue += 1
    if (id !== undefined) this.cache.delete(id)
    else this.cache.clear()
  }

  /** Bootstrap the default assistant profile on first startup (returns existing profile unchanged without overwriting user edits). */
  async ensureDefault(): Promise<Profile> {
    const existing = await this.get(DEFAULT_PROFILE_ID)
    if (existing !== undefined) return existing
    const profile: Profile = {
      id: DEFAULT_PROFILE_ID,
      name: DEFAULT_PROFILE_NAME,
      tags: [DEFAULT_PROFILE_ID],
    }
    const dir = profileDir(this.dataDir, profile.id)
    const filePath = join(dir, 'profile.json')
    await atomicWriteJson(filePath, profile)
    await atomicWriteFile(join(dir, 'SYSTEM.md'), SYSTEM_DEFAULT)
    this.cache.delete(profile.id)
    return profile
  }

  async list(): Promise<Profile[]> {
    const root = join(this.dataDir, 'profiles')
    let entries: string[]
    try {
      entries = await readdir(root)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return []
      throw err
    }
    const profiles: Profile[] = []
    for (const entry of entries) {
      const profile = await this.get(entry)
      if (profile !== undefined) profiles.push(profile)
    }
    profiles.sort((a, b) => a.id.localeCompare(b.id))
    return profiles
  }

  async get(id: string): Promise<Profile | undefined> {
    assertProfileId(id)
    const filePath = join(profileDir(this.dataDir, id), 'profile.json')
    let info: { mtimeMs: number; size: number }
    try {
      info = await stat(filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.cache.delete(id)
        return undefined
      }
      throw err
    }
    const cached = this.cache.get(id)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      return structuredClone(cached.profile)
    }
    const value = await readJsonFileOptional(filePath)
    if (value === undefined) {
      this.cache.delete(id)
      return undefined
    }
    const profile = normalizeProfile(value, id)
    this.cache.set(id, { mtimeMs: info.mtimeMs, size: info.size, profile })
    return structuredClone(profile)
  }

  /** Create or replace a profile (if system is provided, atomically syncs to SYSTEM.md without writing it into profile.json). */
  async save(input: unknown): Promise<Profile> {
    this.options?.assertWritable?.()
    if (!isJsonObject(input)) throw new Error('profile must be an object')
    const rawSystem = input['system']
    if (rawSystem !== undefined && typeof rawSystem !== 'string') {
      throw new Error('profile system must be a string')
    }
    const profile = validateProfileInput(input)
    const dir = profileDir(this.dataDir, profile.id)
    const existing = await this.get(profile.id)
    await atomicWriteJson(join(dir, 'profile.json'), profile)
    this.invalidateCache(profile.id)
    if (rawSystem !== undefined) {
      await this.updateSystem(profile.id, rawSystem)
    } else if (existing === undefined) {
      await atomicWriteFile(join(dir, 'SYSTEM.md'), SYSTEM_DEFAULT)
    }
    // Emit only after all writes succeed: validateProfileInput already strips `system` (detail endpoints attach it on demand).
    this.events?.publish('profile.changed', { type: 'profile.changed', profile } satisfies ProfileChangedEvent)
    return profile
  }

  /**
   * Delete a profile; the default assistant profile is protected and cannot be deleted.
   * deps.isProfileInUse (optional): re-checks right before deleting on disk that no conversation binds this profile,
   * throwing 409 profile_in_use if bound (prevents TOCTOU races across awaits between route check and concurrent create/PATCH);
   * when omitted, only the default profile protection applies (caller is responsible for checking bindings).
   */
  async delete(id: string, deps?: ProfileDeleteDeps): Promise<void> {
    this.options?.assertWritable?.()
    assertProfileId(id)
    if (id === DEFAULT_PROFILE_ID) {
      throw new Error(`default profile '${DEFAULT_PROFILE_ID}' cannot be deleted`)
    }
    if (deps !== undefined && (await deps.isProfileInUse(id))) {
      throw new HelmxError('profile_in_use', `profile ${id} is still bound by conversations; unbind before deleting`, 409, {
        profileId: id,
      })
    }
    const existing = await this.get(id)
    await rm(profileDir(this.dataDir, id), { recursive: true, force: true })
    this.invalidateCache(id)
    // Notify only for a profile that actually existed (delete on a missing id is an idempotent no-op and must not fabricate a removal event).
    if (existing !== undefined) {
      this.events?.publish('profile.changed', {
        type: 'profile.changed',
        profile: existing,
        removed: true,
      } satisfies ProfileChangedEvent)
    }
  }

  async getSystem(id: string): Promise<string> {
    assertProfileId(id)
    return readTextFile(join(profileDir(this.dataDir, id), 'SYSTEM.md'))
  }

  async updateSystem(id: string, text: string): Promise<string> {
    this.options?.assertWritable?.()
    assertProfileId(id)
    if (typeof text !== 'string') throw new Error('system text must be a string')
    const path = join(profileDir(this.dataDir, id), 'SYSTEM.md')
    return withFileLock(path, async () => {
      await atomicWriteFile(path, text)
      return text
    })
  }
}
