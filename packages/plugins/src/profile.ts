/**
 * builtin:profile: the resident roles-and-skills foundation (locked: true).
 *
 * Responsibilities (memory split to builtin:memory; kernel-owned core skills helmx-cli /
 * app-builder / conversations / profiles live in @helmx/kernel under core:* namespaces):
 * - Bootstrap the default assistant Profile's managed metadata (`managedByPlugin: 'builtin:profile'`) at startup;
 * - before_turn injects profile.system (SYSTEM.md), profile.skills (the available skill
 *   catalog), profile.assets-missing (a missing-SYSTEM.md warning), and profile.agents /
 *   profile.agents-unavailable (the workspace AGENTS.md project conventions; read failures or a
 *   remote node going offline are stated explicitly, never silently degraded);
 * - a low-priority before_turn (running after the default-priority tool-stripping hooks) injects
 *   profile.catalog per the turn's actual turn.tools (the cross-Profile collaboration catalog;
 *   leaf subagents whose dispatch tools were stripped get no injection, and neither do turns without dispatch tools when builtin:workflow is disabled);
 * - registers the load_skill tool (Profile whitelist + live plugin enablement) and the
 *   idempotent list_mentionable action (the @ completion source, auto-mapped to HTTP / helmx
 *   list_mentionable CLI);
 * - registers the idempotent node-scoped discovery actions skill_catalog / skill_read
 *   (exposeToPrompt:false + scope:{conversationIds:[]} UI/CLI read paths: every session-context
 *   call -- run_action / workflow / HTTP body.conversationId -- is excluded by the scope ACL,
 *   so the model can never enumerate or read foreign coordinates; context-free human calls
 *   carry an explicit registered nodeId with optional cwd validated at the input boundary);
 * - the left-sidebar assistant Profile standing navigation (conversation:profile:assistant, not
 *   dependent on any particular conversation existing).
 */
import {
  HelmxError,
  escapeXml,
  isAbsoluteTargetPath,
  isPluginSummaryActive,
  isSkillAvailable,
  pathRulesForShape,
  targetPathShape,
  type DispatchToolsCapability,
  type HelmxHostProfilesPort,
  type HelmxPluginContext,
  type JsonSchema,
  type PluginDefinition,
  type Profile,
  type SkillSummary,
} from '@helmx/protocol'
import { errorMessageOf } from './shared-helpers.js'
import {
  describeHint,
  extractSystemSummary,
  isCollaborationCandidate,
  renderProfileCatalogSection,
  toCatalogEntry,
  type ProfileCatalogEntry,
} from './profile/catalog.js'
import { computeAgentsMdSection } from './profile/agents-md.js'
import {
  invalidateNodeSkillsCache,
  nodeSkillsUnavailableSection,
  readNodeSkillFile,
} from './profile/node-skills.js'
import { listScopedSkills, SKILL_SUMMARY_JSON_SCHEMA, type ScopedSkillCatalog } from './profile/scoped-skills.js'

const DEFAULT_PROFILE_ID = 'assistant'

/** Plugin ID declaring ownership of the default `assistant` Profile metadata. */
export const PROFILE_MANAGED_BY = 'builtin:profile'

/** Catalog injection hook priority: below default 0 so it runs after tool-stripping hooks. */
const CATALOG_HOOK_PRIORITY = -100

export {
  AGENTS_MD_FILENAME,
  MAX_AGENTS_MD_CHARS,
  computeAgentsMdSection,
  type AgentsMdHostPort,
  type AgentsMdInjection,
} from './profile/agents-md.js'
export {
  NODE_SKILLS_RELATIVE_DIR,
  DEFAULT_NODE_MACHINE_SKILL_ROOTS,
  MAX_NODE_SKILL_FILE_BYTES,
  MAX_NODE_SKILLS,
  MAX_NODE_SKILL_REFERENCES,
  MAX_NODE_SKILL_REFERENCE_DEPTH,
  NODE_SKILL_SCAN_CONCURRENCY,
  NODE_SKILLS_CACHE_TTL_MS,
  invalidateNodeSkillsCache,
  nodeSkillsUnavailableSection,
  scanNodeSkills,
  readNodeSkillFile,
  type NodeSkillScan,
  type NodeSkillScanOptions,
  type NodeSkillsHostPort,
} from './profile/node-skills.js'
export {
  SKILL_SUMMARY_JSON_SCHEMA,
  listScopedSkills,
  type HubSkillsPort,
  type ScopedSkillCatalog,
} from './profile/scoped-skills.js'
export {
  PROFILE_SUMMARY_MAX_CODEPOINTS,
  describeHint,
  describePosition,
  extractSystemSummary,
  isCollaborationCandidate,
  renderProfileCatalogSection,
  toCatalogEntry,
  truncateCodePoints,
  type ProfileCatalogEntry,
} from './profile/catalog.js'

/**
 * Bootstrap the default assistant Profile's managed metadata: explicitly write
 * managedByPlugin: 'builtin:profile' when missing (kept as-is when it holds another value
 * or already exists -- no old-data normalization); a missing default Profile is a kernel
 * not-initialized anomaly and propagates honestly.
 */
async function ensureDefaultProfileManaged(profiles: HelmxHostProfilesPort): Promise<void> {
  const existing = await profiles.get(DEFAULT_PROFILE_ID)
  if (existing === undefined) {
    throw new Error(
      `default profile '${DEFAULT_PROFILE_ID}' does not exist (the kernel's ensureDefault should run before plugin startup)`,
    )
  }
  if (existing.managedByPlugin !== undefined) return
  const next: Profile = { ...existing, managedByPlugin: PROFILE_MANAGED_BY }
  await profiles.save(next)
}

/**
 * Input boundary shared by coordinate-scoped skill actions (`skill_catalog` / `skill_read`):
 * requires an explicit registered `nodeId` and validates optional `cwd` lexically without `..`.
 */
function resolveScopedSkillTarget(
  host: HelmxPluginContext['host'],
  input: { nodeId?: string; cwd?: string },
): { nodeId: string; cwd?: string } {
  if (typeof input.nodeId !== 'string' || input.nodeId.trim() === '' || input.nodeId !== input.nodeId.trim()) {
    throw new HelmxError(
      'validation_error',
      'missing or invalid explicit nodeId: these actions are context-free only and require a non-empty target nodeId (with optional cwd)',
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
      registered = host.nodeIpc.isOnline(nodeId)
    } catch (err) {
      throw new HelmxError(
        'validation_error',
        `cannot verify node '${nodeId}' registration (${err instanceof HelmxError ? err.code : 'unknown'}): ${errorMessageOf(err)}`,
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

/**
 * Shared Hub-vs-Node skill resolver for `skill_read` and `load_skill`:
 * Hub catalog skills always win over same-name node skills; ids absent from Hub fall through
 * to live reads on the target node coordinate.
 */
async function readResolvedSkillFile(
  host: HelmxPluginContext['host'],
  params: {
    skillId: string
    path?: string
    nodeId: string | undefined
    cwd: string
    authorize?: (skill: SkillSummary) => void
  },
): Promise<{ text: string }> {
  const { skills } = host
  const hubSkill = (await skills.list()).find((skill) => skill.id === params.skillId)
  if (hubSkill !== undefined) {
    params.authorize?.(hubSkill)
    return { text: await skills.readFile(params.skillId, params.path) }
  }
  // Node files can never claim host plugin management; synthesize a plain summary for whitelist checks.
  params.authorize?.({ id: params.skillId, name: params.skillId, references: [], source: 'node' })
  return {
    text: await readNodeSkillFile(host, params.nodeId, params.cwd, params.skillId, params.path ?? 'SKILL.md'),
  }
}

interface ProfileRuntimeHelpers {
  readSystemOrEmpty(profileId: string): Promise<string>
  listAvailableSkills(
    profileId: string,
    conversation: { nodeId?: string; cwd: string },
    prefetchedProfile?: Promise<Awaited<ReturnType<HelmxHostProfilesPort['get']>>>,
  ): Promise<{ available: SkillSummary[]; nodeUnavailable?: string }>
  computeCatalog(currentProfileId: string): Promise<ProfileCatalogEntry[]>
  dispatchToolNames(tools: readonly { name: string }[]): string[]
}

function createProfileRuntimeHelpers(ctx: HelmxPluginContext): ProfileRuntimeHelpers {
  const { profiles, skills } = ctx.host
  const missingNotified = new Set<string>()

  const readSystemOrEmpty = async (profileId: string): Promise<string> => {
    try {
      const text = await profiles.getSystem(profileId)
      missingNotified.delete(profileId)
      return text
    } catch (err) {
      if (err instanceof HelmxError && err.code === 'not_found') {
        if (!missingNotified.has(profileId)) {
          await ctx.host.emitEvent('notification', {
            type: 'notification',
            level: 'warning',
            title: `Profile asset file missing: ${profileId}/SYSTEM.md`,
            body: `Profile asset ${profileId}/SYSTEM.md does not exist (possibly deleted externally); this turn proceeds with empty content; writing the system prompt again self-heals it`,
          })
          missingNotified.add(profileId)
        }
        return ''
      }
      throw err
    }
  }

  const listAvailableSkills = async (
    profileId: string,
    conversation: { nodeId?: string; cwd: string },
    prefetchedProfile?: Promise<Awaited<ReturnType<typeof profiles.get>>>,
  ): Promise<{ available: SkillSummary[]; nodeUnavailable?: string }> => {
    const profile = await (prefetchedProfile ?? profiles.get(profileId))
    if (profile === undefined) {
      throw new HelmxError(
        'profile_not_found',
        `conversation-bound profile '${profileId}' does not exist (the skill catalog cannot be filtered by Profile)`,
        500,
        { profileId },
      )
    }
    const activePluginIds = new Set(ctx.host.listPlugins().filter(isPluginSummaryActive).map((p) => p.id))
    const scoped = await listScopedSkills(skills, ctx.host, conversation.nodeId, conversation.cwd)
    return {
      available: scoped.skills.filter((skill) => isSkillAvailable(skill, profile, activePluginIds)),
      ...(scoped.nodeUnavailable !== undefined ? { nodeUnavailable: scoped.nodeUnavailable } : {}),
    }
  }

  const readCandidateSummary = async (profileId: string): Promise<string | undefined> => {
    try {
      return extractSystemSummary(await profiles.getSystem(profileId))
    } catch (err) {
      if (err instanceof HelmxError && err.code === 'not_found') return undefined
      throw err
    }
  }

  const collectProvidedDispatchTools = (activePluginIds?: ReadonlySet<string>): string[] => {
    const seen = new Set<string>()
    const names: string[] = []
    for (const entry of ctx.consume<DispatchToolsCapability>('helmx.dispatch-tools')) {
      if (activePluginIds !== undefined && !activePluginIds.has(entry.pluginId)) continue
      const toolNames = entry.impl?.toolNames
      if (!Array.isArray(toolNames)) continue
      for (const name of toolNames) {
        if (typeof name === 'string' && name.length > 0 && !seen.has(name)) {
          seen.add(name)
          names.push(name)
        }
      }
    }
    return names
  }

  const computeCatalog = async (currentProfileId: string): Promise<ProfileCatalogEntry[]> => {
    const [allProfiles, pluginSummaries] = await Promise.all([
      profiles.list(),
      ctx.host.listPlugins(),
    ])
    const activePluginIds = new Set(pluginSummaries.filter(isPluginSummaryActive).map((p) => p.id))
    if (collectProvidedDispatchTools(activePluginIds).length === 0) return []
    const candidates = allProfiles.filter((p) => isCollaborationCandidate(p, currentProfileId, activePluginIds))
    return Promise.all(
      candidates.map(async (profile) => ({
        ...toCatalogEntry(profile),
        summary: await readCandidateSummary(profile.id),
      })),
    )
  }

  const dispatchToolNames = (tools: readonly { name: string }[]): string[] =>
    collectProvidedDispatchTools().filter((name) => tools.some((t) => t.name === name))

  return { readSystemOrEmpty, listAvailableSkills, computeCatalog, dispatchToolNames }
}

function registerProfileTurnHooks(ctx: HelmxPluginContext, helpers: ProfileRuntimeHelpers): void {
  const { profiles } = ctx.host

  ctx.hook.onBeforeTurn(async (turn) => {
    const profileId = turn.conversation.profileId
    const profilePromise = profiles.get(profileId)
    const [rawSystem, skillCatalog, agentsMd, profileRecord] = await Promise.all([
      helpers.readSystemOrEmpty(profileId),
      helpers.listAvailableSkills(profileId, turn.conversation, profilePromise),
      computeAgentsMdSection(ctx.host, turn.conversation.nodeId, turn.conversation.cwd),
      profilePromise,
    ])
    const sections = [...turn.sections]
    if (rawSystem.trim()) {
      sections.push({ id: 'profile.system', text: rawSystem })
    } else {
      sections.push({
        id: 'profile.assets-missing',
        text: [
          '<profile_assets_missing>',
          `This turn lacks the SYSTEM.md of Profile '${profileId}' (file missing or empty).`,
          'You currently have no persona for this Profile: tell the user the asset is missing, answer carefully, and do not pretend to have a specific persona; it recovers automatically once the asset is written.',
          '</profile_assets_missing>',
        ].join('\n'),
      })
    }
    if (agentsMd.kind === 'section') sections.push({ id: agentsMd.id, text: agentsMd.text })
    if (profileRecord?.restrictToCwd === true) {
      sections.push({
        id: 'profile.workspace-boundary',
        text: [
          '<workspace_boundary>',
          `This conversation is restricted to its working directory: ${turn.conversation.cwd}`,
          'File tools (read/write/edit/register_artifact) only accept paths inside that directory; relative paths, ../ traversals, and absolute paths outside it are rejected with path_outside_workspace.',
          'Stay inside the working directory; when a task genuinely needs outside paths, say so instead of attempting them.',
          '</workspace_boundary>',
        ].join('\n'),
      })
    }
    if (skillCatalog.nodeUnavailable !== undefined) {
      sections.push(nodeSkillsUnavailableSection(turn.conversation.nodeId, turn.conversation.cwd, skillCatalog.nodeUnavailable))
    }
    if (skillCatalog.available.length) {
      const catalog = skillCatalog.available
        .map((skill) =>
          `<skill id="${escapeXml(skill.id)}"><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description ?? '')}</description><references>${skill.references.map(escapeXml).join(', ')}</references></skill>`,
        )
        .join('\n')
      sections.push({
        id: 'profile.skills',
        text: `<available_skills>\n${catalog}\n</available_skills>\nUse load_skill to read a skill before applying it. Read reference files only as needed.`,
      })
    }
    return { action: 'transform', value: { ...turn, sections } }
  })

  ctx.hook.onBeforeTurn(
    async (turn) => {
      const tools = helpers.dispatchToolNames(turn.tools)
      if (tools.length === 0) return { action: 'continue' }
      const entries = await helpers.computeCatalog(turn.conversation.profileId)
      if (entries.length === 0) return { action: 'continue' }
      const sections = [...turn.sections, { id: 'profile.catalog', text: renderProfileCatalogSection(entries, { dispatchToolNames: tools }) }]
      return { action: 'transform', value: { ...turn, sections } }
    },
    { priority: CATALOG_HOOK_PRIORITY },
  )
}

function registerProfileMentionable(ctx: HelmxPluginContext, computeCatalog: ProfileRuntimeHelpers['computeCatalog']): void {
  const { profiles } = ctx.host

  ctx.action<
    { query?: string; conversationId?: number; profileId?: string },
    { items: Array<{ id: string; label: string; insertText: string; hint: string; icon: string }> }
  >({
    id: 'list_mentionable',
    description: 'List Profile candidates that the current conversation or a standby role can @ mention for collaboration (the @ completion source; --current / --conversation-id / --profile-id pick the context)',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Filter prefix (empty by default)' },
        conversationId: { type: 'number', description: 'Explicit target conversation (used when the CLI has no calling context; Web conversation completion omits it and defers to the server context)' },
        profileId: { type: 'string', minLength: 1, description: 'Explicit target role (used with no conversation context, e.g. standby draft mode; with conversation context, the server conversation\'s role wins)' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              insertText: { type: 'string' },
              hint: { type: 'string' },
              icon: { type: 'string' },
            },
            required: ['id', 'label', 'insertText', 'hint', 'icon'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
      additionalProperties: false,
    },
    exposeToPrompt: false,
    idempotent: true,
    async handler(input, context) {
      let targetProfileId: string
      if (context.conversationId !== undefined) {
        targetProfileId = ctx.host.getConversation(context.conversationId).profileId
      } else if (input.conversationId !== undefined) {
        targetProfileId = ctx.host.getConversation(input.conversationId).profileId
      } else if (input.profileId !== undefined) {
        const profile = await profiles.get(input.profileId)
        if (profile === undefined) {
          throw new HelmxError('not_found', `profile does not exist: ${input.profileId}`, 404, { profileId: input.profileId })
        }
        targetProfileId = profile.id
      } else {
        throw new HelmxError(
          'validation_error',
          'Missing conversation or role context: Web completion carries it automatically; in the CLI, use --current or specify --conversation-id / --profile-id explicitly',
          400,
        )
      }
      const query = (input.query ?? '').trim().toLowerCase()
      const entries = await computeCatalog(targetProfileId)
      const items = entries
        .filter((entry) => {
          if (query === '') return true
          const haystack = `${entry.id}\n${entry.name}\n${entry.summary ?? ''}`.toLowerCase()
          return haystack.includes(query)
        })
        .map((entry) => ({
          id: entry.id,
          label: `@${entry.id} · ${entry.name}`,
          insertText: `@${entry.id} `,
          hint: describeHint(entry),
          icon: 'bot',
        }))
      return { items }
    },
  })

  ctx.ui.composerCompleter({
    id: 'profile-mentions',
    label: { en: 'Mention roles', 'zh-CN': '点名角色' },
    trigger: '@',
    priority: 100,
    source: { kind: 'action', actionId: 'list_mentionable' },
  })
}

function registerScopedSkillActions(ctx: HelmxPluginContext): void {
  const { skills } = ctx.host

  ctx.action<{ nodeId?: string; cwd?: string }, ScopedSkillCatalog>({
    id: 'skill_catalog',
    description:
      'List the merged skill catalog for a target node (and optional workspace cwd): Hub skills (dataDir > machine-level shared roots) plus the node machine-level roots (~/.helmx/skills, ~/.agents/skills) and optional workspace <cwd>/.helmx/skills; same-name node ids are shadowed (reported in shadowedNodeSkillIds) and node scan failures in nodeUnavailable. Context-free only (scope excludes every session-context call): must carry an explicit registered nodeId',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', minLength: 1, description: 'Target node id (must be currently registered on this Hub)' },
        cwd: { type: 'string', minLength: 1, description: 'Optional absolute working directory on the target node (adds <cwd>/.helmx/skills)' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Effective coordinate node id' },
        cwd: { type: 'string', description: 'Effective coordinate working directory (present when cwd was supplied)' },
        skills: { type: 'array', items: SKILL_SUMMARY_JSON_SCHEMA, description: 'Merged effective catalog (Hub data > Hub agents > node machine > workspace), sorted by id' },
        shadowedNodeSkillIds: { type: 'array', items: { type: 'string' }, description: 'Node skill ids shadowed by a same-name Hub skill (the Hub version is the effective one)' },
        nodeUnavailable: { type: 'string', description: 'Explicit redacted diagnostic when the node-side scan failed (absent when healthy; never a silent empty list)' },
      },
      required: ['nodeId', 'skills', 'shadowedNodeSkillIds'],
      additionalProperties: false,
    } satisfies JsonSchema,
    exposeToPrompt: false,
    idempotent: true,
    // The real ACL: excludes every conversation-carrying call before the handler.
    scope: { conversationIds: [] },
    async handler(input) {
      const target = resolveScopedSkillTarget(ctx.host, input)
      return listScopedSkills(skills, ctx.host, target.nodeId, target.cwd ?? '')
    },
  })

  ctx.action<{ skillId: string; path?: string; nodeId?: string; cwd?: string }, { text: string }>({
    id: 'skill_read',
    description:
      "Read a skill file on a target node (with optional workspace cwd), mirroring load_skill resolution: a Hub catalog hit (dataDir > machine-level shared roots) reads from the Hub, otherwise the node machine-level / workspace source is read live. Context-free only (scope excludes every session-context call; the Profile.skills whitelist governs the model-facing load_skill tool instead): must carry an explicit registered nodeId",
    inputSchema: {
      type: 'object',
      properties: {
        skillId: { type: 'string', minLength: 1, description: 'Skill id to read' },
        path: { type: 'string', minLength: 1, description: "Skill-relative file path (defaults to 'SKILL.md')" },
        nodeId: { type: 'string', minLength: 1, description: 'Target node id (must be currently registered on this Hub)' },
        cwd: { type: 'string', minLength: 1, description: 'Optional absolute working directory on the target node' },
      },
      required: ['skillId', 'nodeId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The file content read (same shape as GET /api/skills/:id)' },
      },
      required: ['text'],
      additionalProperties: false,
    } satisfies JsonSchema,
    exposeToPrompt: false,
    idempotent: true,
    scope: { conversationIds: [] },
    async handler(input) {
      const target = resolveScopedSkillTarget(ctx.host, input)
      return readResolvedSkillFile(ctx.host, {
        skillId: input.skillId,
        path: input.path ?? 'SKILL.md',
        nodeId: target.nodeId,
        cwd: target.cwd ?? '',
      })
    },
  })
}

function registerLoadSkillTool(ctx: HelmxPluginContext): void {
  const { profiles } = ctx.host

  ctx.tool<{ skillId: string; path?: string }>({
    name: 'load_skill',
    description: 'Read a skill\'s SKILL.md, or reference files inside the skill directory on demand. Example path: references/guide.md.',
    inputSchema: {
      type: 'object',
      properties: { skillId: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 } },
      required: ['skillId'],
      additionalProperties: false,
    },
    async execute(input, context) {
      const conversation = ctx.host.getConversation(context.conversationId)
      const profileId = conversation.profileId
      const profile = await profiles.get(profileId)
      if (profile === undefined) {
        throw new HelmxError(
          'profile_not_found',
          `conversation-bound profile '${profileId}' does not exist; cannot determine skill availability`,
          500,
          { profileId },
        )
      }
      const activePluginIds = new Set(ctx.host.listPlugins().filter(isPluginSummaryActive).map((p) => p.id))
      return readResolvedSkillFile(ctx.host, {
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
    },
  })
}

export function createProfilePlugin(): PluginDefinition {
  return {
    id: 'builtin:profile',
    name: { en: 'Roles & Skills Foundation', 'zh-CN': '角色与技能基座' },
    description: {
      en: 'Resident foundation: injects SYSTEM.md and the available skill catalog (Hub skills plus the conversation node\'s read-only workspace skills) per the conversation Profile, providing the load_skill tool and the default assistant role.',
      'zh-CN': '常驻基座：按会话 Profile 注入 SYSTEM.md 与可用技能目录（Hub 技能 + 会话节点工作区的只读技能库），提供 load_skill 工具与默认助手角色。',
    },
    icon: 'bot',
    version: '0.1.0',
    locked: true,
    definePlugin(ctx) {
      const { profiles } = ctx.host
      ctx.service({
        id: 'profile-skills',
        async start() {
          invalidateNodeSkillsCache(ctx.host)
          await ensureDefaultProfileManaged(profiles)
        },
        async stop() {
          invalidateNodeSkillsCache(ctx.host)
        },
      })

      const helpers = createProfileRuntimeHelpers(ctx)
      registerProfileTurnHooks(ctx, helpers)
      registerProfileMentionable(ctx, helpers.computeCatalog)
      registerScopedSkillActions(ctx)
      registerLoadSkillTool(ctx)

      ctx.ui.sidebarItem({
        id: 'assistant',
        label: { en: 'Personal Assistant', 'zh-CN': '个人助理' },
        target: `conversation:profile:${DEFAULT_PROFILE_ID}`,
        order: 0,
      })
    },
  }
}
