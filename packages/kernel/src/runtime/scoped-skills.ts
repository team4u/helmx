/**
 * Coordinate-scoped skill discovery and live reading (`Hub` + `node` + optional workspace `cwd`).
 *
 * Keeps `services/skill-service.ts` pure local filesystem IO while composing `SkillService` with
 * `EnvFabric` here in `runtime/`.
 */
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import {
  HelmxError,
  isAbsoluteTargetPath,
  isPluginSummaryActive,
  isSkillAvailable,
  pathRulesForShape,
  targetPathShape,
  type ConversationSummary,
  type PluginSummary,
  type Profile,
  type ScopedSkillCatalog,
  type SkillSummary,
} from '@helmx/protocol'
import type { ProfileService, SkillService } from '../services/index.js'
import { isSafeRelativePath } from '../http/validate.js'
import {
  invalidateNodeSkillsCache,
  nodeSkillsUnavailableSection,
  readNodeSkillFile,
  scanNodeSkills,
  type NodeSkillScanOptions,
  type NodeSkillsHostPort,
} from './node-skills.js'

export interface HubSkillsPort {
  list(): Promise<SkillSummary[]>
}

export async function listScopedSkills(
  skills: HubSkillsPort,
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd = '',
  options?: NodeSkillScanOptions,
): Promise<ScopedSkillCatalog> {
  const hub = await skills.list()
  const byId = new Map(hub.map((skill) => [skill.id, skill]))
  const hubIds = new Set(byId.keys())
  const effectiveShadowedIds =
    options?.shadowedIds !== undefined ? new Set([...options.shadowedIds, ...hubIds]) : hubIds
  const scan = await scanNodeSkills(host, nodeIdInput, cwd, {
    ...options,
    shadowedIds: effectiveShadowedIds,
  })
  const shadowedSet = new Set<string>(scan.shadowedSkillIds ?? [])
  const nodeSkills = scan.kind === 'ok' ? scan.skills : (scan.skills ?? [])
  for (const skill of nodeSkills) {
    if (byId.has(skill.id)) shadowedSet.add(skill.id)
    else byId.set(skill.id, skill)
  }
  const shadowedNodeSkillIds = [...shadowedSet].sort((a, b) => a.localeCompare(b))
  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  return {
    nodeId: nodeIdInput ?? 'local',
    ...(cwd !== '' ? { cwd } : {}),
    skills: merged,
    shadowedNodeSkillIds,
    ...(scan.kind === 'unavailable' ? { nodeUnavailable: scan.reason } : {}),
  }
}

export interface ScopedSkillServiceDeps {
  readonly skills: Pick<SkillService, 'list' | 'readFile'>
  readonly profiles: Pick<ProfileService, 'get'>
  readonly getConversation: (conversationId: number) => ConversationSummary
  readonly executionEnv: (nodeId: string, cwd: string) => ExecutionEnv
  readonly redact: (text: string) => string
  readonly isNodeOnline: (nodeId: string) => boolean
  readonly listPlugins: () => ReadonlyArray<PluginSummary>
}

export class ScopedSkillService {
  private readonly nodeHost: NodeSkillsHostPort

  constructor(private readonly deps: ScopedSkillServiceDeps) {
    this.nodeHost = {
      executionEnv: (nodeId, cwd) => this.deps.executionEnv(nodeId, cwd),
      redact: (text) => this.deps.redact(text),
      nodeIpc: { isOnline: (nodeId) => this.deps.isNodeOnline(nodeId) },
    }
  }

  get nodeSkillsHost(): NodeSkillsHostPort {
    return this.nodeHost
  }

  invalidateNodeCache(coordinate?: { nodeId?: string; cwd?: string }): void {
    invalidateNodeSkillsCache(this.nodeHost, coordinate)
  }

  /**
   * Input boundary for explicit coordinate-scoped skill reads (`core:skills.catalog` / `core:skills.read`):
   * requires a non-empty, untrimmed-safe registered `nodeId` and validates optional `cwd` lexically without `..`.
   */
  resolveTarget(input: { nodeId?: string; cwd?: string }): { nodeId: string; cwd?: string } {
    if (typeof input.nodeId !== 'string' || input.nodeId.trim() === '' || input.nodeId !== input.nodeId.trim()) {
      throw new HelmxError(
        'validation_error',
        'missing or invalid explicit nodeId: scoped skill access requires a non-empty target nodeId (with optional cwd)',
        400,
      )
    }
    const { nodeId, cwd } = input
    if (cwd !== undefined) {
      if (!isAbsoluteTargetPath(cwd)) {
        throw new HelmxError(
          'validation_error',
          `cwd must be an absolute path in the target node's own shape (POSIX '/', Windows drive/UNC): ${cwd}`,
          400,
          { nodeId, cwd },
        )
      }
      const normalized = pathRulesForShape(targetPathShape(cwd)).normalize(cwd)
      if (normalized.split(/[\\/]/).includes('..')) {
        throw new HelmxError(
          'validation_error',
          `cwd must normalize without '..' escapes (got ${cwd} -> ${normalized}); refusing to target an arbitrary coordinate`,
          400,
          { nodeId, cwd },
        )
      }
    }
    if (nodeId !== 'local') {
      let registered: boolean
      try {
        registered = this.deps.isNodeOnline(nodeId)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new HelmxError(
          'validation_error',
          `cannot verify node '${nodeId}' registration (${err instanceof HelmxError ? err.code : 'unknown'}): ${msg}`,
          400,
          { nodeId },
        )
      }
      if (!registered) {
        throw new HelmxError(
          'validation_error',
          `node '${nodeId}' is not currently registered on this Hub (unknown id or disconnected); refusing to target an arbitrary coordinate`,
          400,
          { nodeId },
        )
      }
    }
    return cwd === undefined ? { nodeId } : { nodeId, cwd }
  }

  async listCatalog(input: { nodeId?: string; cwd?: string }): Promise<ScopedSkillCatalog> {
    const target = this.resolveTarget(input)
    return listScopedSkills(this.deps.skills, this.nodeHost, target.nodeId, target.cwd ?? '')
  }

  async readScoped(input: { skillId: string; path?: string; nodeId?: string; cwd?: string }): Promise<{ text: string }> {
    const target = this.resolveTarget(input)
    return this.readResolvedSkillFile({
      skillId: input.skillId,
      path: input.path ?? 'SKILL.md',
      nodeId: target.nodeId,
      cwd: target.cwd ?? '',
    })
  }

  async listAvailableForConversation(
    profileId: string,
    conversation: { nodeId?: string; cwd: string },
    prefetchedProfile?: Promise<Profile | undefined>,
  ): Promise<{ available: SkillSummary[]; nodeUnavailable?: string }> {
    const profile = await (prefetchedProfile ?? this.deps.profiles.get(profileId))
    if (profile === undefined) {
      throw new HelmxError(
        'profile_not_found',
        `conversation-bound profile '${profileId}' does not exist (the skill catalog cannot be filtered by Profile)`,
        500,
        { profileId },
      )
    }
    const activePluginIds = new Set(this.deps.listPlugins().filter(isPluginSummaryActive).map((p) => p.id))
    const scoped = await listScopedSkills(this.deps.skills, this.nodeHost, conversation.nodeId, conversation.cwd)
    return {
      available: scoped.skills.filter((skill) => isSkillAvailable(skill, profile, activePluginIds)),
      ...(scoped.nodeUnavailable !== undefined ? { nodeUnavailable: scoped.nodeUnavailable } : {}),
    }
  }

  async loadSkillForConversation(
    conversationId: number,
    input: { skillId: string; path?: string },
  ): Promise<{ text: string }> {
    const conversation = this.deps.getConversation(conversationId)
    const profileId = conversation.profileId
    const profile = await this.deps.profiles.get(profileId)
    if (profile === undefined) {
      throw new HelmxError(
        'profile_not_found',
        `conversation-bound profile '${profileId}' does not exist; cannot determine skill availability`,
        500,
        { profileId },
      )
    }
    const activePluginIds = new Set(this.deps.listPlugins().filter(isPluginSummaryActive).map((p) => p.id))
    return this.readResolvedSkillFile({
      skillId: input.skillId,
      ...(input.path !== undefined ? { path: input.path } : {}),
      nodeId: conversation.nodeId,
      cwd: conversation.cwd,
      authorize: (skill) => {
        if (isSkillAvailable(skill, profile, activePluginIds)) return
        throw new HelmxError(
          'skill_not_available',
          `skill '${input.skillId}' is unavailable for profile '${profileId}' (not whitelisted, or its managing plugin is disabled); adjust the profile skills config to use it`,
          403,
          {
            skillId: input.skillId,
            profileId,
            ...(skill.managedByPlugin !== undefined ? { managedByPlugin: skill.managedByPlugin } : {}),
          },
        )
      },
    })
  }

  private async readResolvedSkillFile(params: {
    skillId: string
    path?: string
    nodeId: string | undefined
    cwd: string
    authorize?: (skill: SkillSummary) => void
  }): Promise<{ text: string }> {
    const hubSkill = (await this.deps.skills.list()).find((skill) => skill.id === params.skillId)
    if (hubSkill !== undefined) {
      params.authorize?.(hubSkill)
      return { text: await this.deps.skills.readFile(params.skillId, params.path) }
    }
    // Node files can never claim host plugin management; synthesize a plain summary for whitelist checks.
    params.authorize?.({ id: params.skillId, name: params.skillId, references: [], source: 'node' })
    return {
      text: await readNodeSkillFile(this.nodeHost, params.nodeId, params.cwd, params.skillId, params.path ?? 'SKILL.md'),
    }
  }
}

export { nodeSkillsUnavailableSection }

/**
 * Shared read handler for HTTP `GET /api/skills/:id` and `core:skills.read`:
 * validates relative `path`, enforces `cwd` requires `nodeId`, and delegates
 * to `scopedSkills` when `nodeId` is specified or Hub `skills.readFile` otherwise.
 */
export async function readSkillForOperation(
  skills: Pick<SkillService, 'readFile'>,
  scopedSkills: Pick<ScopedSkillService, 'readScoped'> | undefined,
  input: { id: string; path?: string; nodeId?: string; cwd?: string },
): Promise<{ text: string }> {
  const { id, path, nodeId, cwd } = input
  if (path !== undefined && !isSafeRelativePath(path)) {
    throw new HelmxError('path_traversal', `skill file path out of bounds: ${id}/${path}`, 400)
  }
  if (cwd !== undefined && nodeId === undefined) {
    throw new HelmxError('validation_error', 'cwd requires an explicit nodeId', 400, { cwd })
  }
  if (nodeId !== undefined) {
    if (scopedSkills === undefined) {
      throw new HelmxError('unsupported', 'scoped skill reader is not available', 501)
    }
    return scopedSkills.readScoped({
      skillId: id,
      ...(path !== undefined ? { path } : {}),
      nodeId,
      ...(cwd !== undefined ? { cwd } : {}),
    })
  }
  const text = await skills.readFile(id, path)
  return { text }
}
