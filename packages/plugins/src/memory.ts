/**
 * builtin:memory: autonomous per-Profile long-term memory plugin (`MEMORY.md`, `update_memory`, daily Dream).
 */
import { HelmxError, PROFILE_DETAIL_SECTION_SLOT, type HelmxHostProfilesPort, type PluginActionContext, type PluginDefinition } from '@helmx/protocol'
import { loadManagedSkillAsset, resolvePluginClientAssets } from './asset-paths.js'
import { reportPluginError } from './shared-helpers.js'
import { isMemorySessionEligible, MEMORY_PLUGIN_ID, MAX_MEMORY_CHARS, MemoryStore } from './memory/store.js'
import {
  createDreamEngine,
  defaultDreamTimezone,
  type DreamDoc,
  type DreamEngineOptions,
  type DreamRunSummary,
  type DreamStatusView,
} from './memory/dream.js'

export const MEMORY_SKILL_ID = 'memory' as const
export { isMemorySessionEligible, MEMORY_PLUGIN_ID, MAX_MEMORY_CHARS, MEMORY_DEFAULT, MemoryStore } from './memory/store.js'
export {
  createDreamEngine,
  dreamBudgetChars,
  parseDreamModelOutput,
  nextDailyRunAt,
  looksLikeLowValueHumanInput,
  stripExcerptNoise,
  stripFencedCodeBlocks,
  DREAM_TARGET_CHARS,
  DREAM_MAX_TOKENS,
  type DreamCandidate,
  type DreamClock,
  type DreamConfig,
  type DreamDoc,
  type DreamHostPorts,
  type DreamProfileRunRecord,
  type DreamRunSummary,
  type DreamRuntime,
  type DreamStatusView,
} from './memory/dream.js'

export interface MemoryPluginDoc {
  disabledProfiles: string[]
  initializedProfiles: string[]
}

const MEMORY_TRUNCATION_NOTE = `\n[ helmx note: MEMORY.md exceeds the ${MAX_MEMORY_CHARS}-character cap; the above is the first ${MAX_MEMORY_CHARS} characters; use update_memory(mode='replace') to consolidate and trim memory ]`
const MEMORY_USAGE_NOTE =
  'Only call `update_memory` when the user explicitly asks to remember/forget something or corrects a durable preference; daily Dream consolidates normal turns automatically. Never store pending deploy/commit lists, transient status, or facts already in repo docs.'

const PROFILE_SELECTOR_INPUT = {
  type: 'object',
  properties: { profileId: { type: 'string', minLength: 1 } },
  additionalProperties: false,
} as const

const DREAM_CONFIG_OUTPUT = {
  type: 'object',
  properties: { enabled: { type: 'boolean' }, hour: { type: 'number' }, timezone: { type: 'string' }, nextRunAt: { type: 'number' } },
  required: ['enabled', 'hour', 'timezone'],
  additionalProperties: false,
} as const

export function isProfileMemoryEnabled(doc: Pick<MemoryPluginDoc, 'disabledProfiles'> | undefined, profileId: string): boolean {
  return !(doc?.disabledProfiles ?? []).includes(profileId)
}

async function requireProfile(profiles: HelmxHostProfilesPort, profileId: string): Promise<void> {
  if ((await profiles.get(profileId)) === undefined) {
    throw new HelmxError('profile_not_found', `Profile '${profileId}' does not exist`, 404, { profileId })
  }
}

function resolveActionProfileId(
  explicitProfileId: string | undefined,
  context: PluginActionContext,
  getConversation: (id: number) => { profileId: string },
): string {
  if (explicitProfileId !== undefined) return explicitProfileId
  if (context.conversationId !== undefined) return getConversation(context.conversationId).profileId
  throw new HelmxError('validation_error', 'Missing Profile target: provide --profile-id or a conversation context (CLI uses --current)', 400)
}

function disabledError(profileId: string, action: string): HelmxError {
  return new HelmxError('memory_disabled_for_profile', `Profile '${profileId}' has long-term memory disabled; ${action} is forbidden`, 403, { profileId })
}

function readMemorySkillAsset() {
  return loadManagedSkillAsset({
    pluginId: MEMORY_PLUGIN_ID,
    skillId: MEMORY_SKILL_ID,
    relativeDir: 'memory/skill',
    missingErrorCode: 'memory_skill_missing',
  })
}

export function createMemoryPlugin(options: { dream?: DreamEngineOptions } = {}): PluginDefinition {
  return {
    id: MEMORY_PLUGIN_ID,
    name: { en: 'Long-term Memory', 'zh-CN': '长期记忆' },
    description: {
      en: 'Autonomous long-term memory: manages MEMORY.md injection and toggles per Profile, providing the update_memory tool.',
      'zh-CN': '自主长期记忆：按 Profile 管理 MEMORY.md 注入与开关，提供 update_memory 工具。',
    },
    icon: 'sparkles',
    version: '0.1.0',
    ...resolvePluginClientAssets(MEMORY_PLUGIN_ID, 'memory', 'memory_plugin_client_missing'),
    definePlugin(ctx) {
      ctx.configSchema({
        dreamModel: {
          type: 'string',
          format: 'model',
          default: '',
          label: { en: 'Dream model', 'zh-CN': 'Dream 整理模型' },
          description: {
            en: 'Optional model used for daily memory Dream consolidation (leave default to follow the conversation/Profile model).',
            'zh-CN': '每日记忆 Dream 整理使用的模型（留空则沿用会话/Profile 生效模型）。',
          },
        },
      })
      const { profiles } = ctx.host
      const store = new MemoryStore(ctx.host)
      const stateDoc = ctx.doc<MemoryPluginDoc>('state', { disabledProfiles: [], initializedProfiles: [] })
      const missingNotified = new Set<string>()

      const isEnabled = (profileId: string): boolean => isProfileMemoryEnabled(stateDoc.get(), profileId)
      const isInitialized = (profileId: string): boolean => stateDoc.get().initializedProfiles.includes(profileId)
      const markInitialized = (profileId: string): void => {
        stateDoc.update((c) => (c.initializedProfiles.includes(profileId) ? c : { ...c, initializedProfiles: [...c.initializedProfiles, profileId] }))
      }
      const pruneDeletedProfile = (profileId: string): void => {
        missingNotified.delete(profileId)
        stateDoc.update((c) => {
          if (!c.disabledProfiles.includes(profileId) && !c.initializedProfiles.includes(profileId)) return c
          return {
            ...c,
            disabledProfiles: c.disabledProfiles.filter((id) => id !== profileId),
            initializedProfiles: c.initializedProfiles.filter((id) => id !== profileId),
          }
        })
      }
      const reconcileDeletedProfiles = async (): Promise<void> => {
        const snapshot = stateDoc.get()
        if (snapshot.disabledProfiles.length === 0 && snapshot.initializedProfiles.length === 0 && missingNotified.size === 0) {
          return
        }
        const existingIds = new Set((await profiles.list()).map((p) => p.id))
        for (const id of [...missingNotified]) {
          if (!existingIds.has(id)) missingNotified.delete(id)
        }
        stateDoc.update((c) => {
          const disabledProfiles = c.disabledProfiles.filter((id) => existingIds.has(id))
          const initializedProfiles = c.initializedProfiles.filter((id) => existingIds.has(id))
          if (disabledProfiles.length === c.disabledProfiles.length && initializedProfiles.length === c.initializedProfiles.length) {
            return c
          }
          return { ...c, disabledProfiles, initializedProfiles }
        })
      }
      const resolveAndRequire = async (explicit: string | undefined, context: PluginActionContext): Promise<string> => {
        const profileId = resolveActionProfileId(explicit, context, (id) => ctx.host.getConversation(id))
        await requireProfile(profiles, profileId)
        return profileId
      }

      ctx.action<{ profileId?: string }, { profileId: string; enabled: boolean; content: string; initialized: boolean }>({
        id: 'get',
        description: 'Read the Profile long-term memory content and switch state (--profile-id or --current)',
        exposeToPrompt: false,
        idempotent: true,
        inputSchema: PROFILE_SELECTOR_INPUT,
        outputSchema: {
          type: 'object',
          properties: { profileId: { type: 'string' }, enabled: { type: 'boolean' }, content: { type: 'string' }, initialized: { type: 'boolean' } },
          required: ['profileId', 'enabled', 'content', 'initialized'],
          additionalProperties: false,
        },
        async handler(input, context) {
          const profileId = await resolveAndRequire(input.profileId, context)
          let content = ''
          try {
            content = await store.getMemory(profileId)
          } catch (err) {
            if (!(err instanceof HelmxError && err.code === 'not_found')) throw err
          }
          return { profileId, enabled: isEnabled(profileId), content, initialized: isInitialized(profileId) }
        },
      })

      ctx.action<{ profileId?: string; text: string; mode?: 'append' | 'replace' }, { profileId: string; updated: boolean; length: number }>({
        id: 'set',
        description: 'Write the Profile MEMORY.md in full or append (--profile-id or --current)',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          properties: { profileId: { type: 'string', minLength: 1 }, text: { type: 'string' }, mode: { type: 'string', enum: ['replace', 'append'] } },
          required: ['text'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { profileId: { type: 'string' }, updated: { type: 'boolean' }, length: { type: 'number' } },
          required: ['profileId', 'updated', 'length'],
          additionalProperties: false,
        },
        async handler(input, context) {
          const profileId = await resolveAndRequire(input.profileId, context)
          if (!isEnabled(profileId)) throw disabledError(profileId, 'writing MEMORY.md')
          const written = await store.updateMemory(profileId, input.text, input.mode ?? 'replace')
          markInitialized(profileId)
          return { profileId, updated: true, length: written.length }
        },
      })

      ctx.action<{ profileId?: string; enabled: boolean; text?: string }, { profileId: string; enabled: boolean }>({
        id: 'configure',
        description: 'Configure the Profile long-term memory switch (--profile-id or --current)',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          properties: { profileId: { type: 'string', minLength: 1 }, enabled: { type: 'boolean' }, text: { type: 'string' } },
          required: ['enabled'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { profileId: { type: 'string' }, enabled: { type: 'boolean' } },
          required: ['profileId', 'enabled'],
          additionalProperties: false,
        },
        async handler(input, context) {
          const profileId = await resolveAndRequire(input.profileId, context)
          if (input.text !== undefined) {
            if (!isEnabled(profileId) && !input.enabled) throw disabledError(profileId, 'writing MEMORY.md')
            await store.updateMemory(profileId, input.text, 'replace')
            markInitialized(profileId)
          }
          if (input.enabled && !isInitialized(profileId)) {
            await store.ensureMemory(profileId)
            markInitialized(profileId)
          }
          stateDoc.update((c) => ({
            ...c,
            disabledProfiles: input.enabled
              ? c.disabledProfiles.filter((id) => id !== profileId)
              : c.disabledProfiles.includes(profileId)
                ? c.disabledProfiles
                : [...c.disabledProfiles, profileId],
          }))
          return { profileId, enabled: input.enabled }
        },
      })

      ctx.hook.onBeforeTurn(async (turn) => {
        const profileId = turn.conversation.profileId
        if (!isEnabled(profileId) || !isMemorySessionEligible(turn.conversation)) {
          if (!turn.tools.some((t) => t.name === 'update_memory')) return { action: 'continue' }
          return { action: 'transform', value: { ...turn, tools: turn.tools.filter((t) => t.name !== 'update_memory') } }
        }
        const sections = [...turn.sections]
        let rawMemory = ''
        try {
          rawMemory = await store.getMemory(profileId)
          missingNotified.delete(profileId)
          if (!isInitialized(profileId)) markInitialized(profileId)
        } catch (err) {
          if (!(err instanceof HelmxError && err.code === 'not_found')) throw err
          if (!isInitialized(profileId)) {
            rawMemory = await store.ensureMemory(profileId)
            markInitialized(profileId)
          } else {
            if (!missingNotified.has(profileId)) {
              await ctx.host.emitEvent('notification', {
                type: 'notification',
                level: 'warning',
                title: `Long-term memory file missing: ${profileId}/MEMORY.md`,
                body: `Profile '${profileId}' MEMORY.md once existed but was deleted externally; this turn proceeds without memory and self-heals after the next update_memory write or file restoration`,
              })
              missingNotified.add(profileId)
            }
            sections.push({
              id: 'memory.assets-missing',
              text: `<memory_assets_missing>\n[Warning] Long-term memory asset missing (${profileId}/MEMORY.md existed but was deleted).\nPlease remind the user to check the profiles directory or rebuild via update_memory; until then you have no long-term memory.\n</memory_assets_missing>`,
            })
          }
        }
        if (rawMemory.trim()) {
          const memory = rawMemory.length > MAX_MEMORY_CHARS ? `${rawMemory.slice(0, MAX_MEMORY_CHARS)}${MEMORY_TRUNCATION_NOTE}` : rawMemory
          sections.push({ id: 'memory.content', text: `<memory>\n${memory}\n</memory>\n${MEMORY_USAGE_NOTE}` })
        } else {
          sections.push({ id: 'memory.guide', text: MEMORY_USAGE_NOTE })
        }
        return { action: 'transform', value: { ...turn, sections } }
      })

      ctx.tool<{ text: string; mode: 'append' | 'replace' }>({
        name: 'update_memory',
        description: `Update the current conversation Profile's MEMORY.md (top-level conversations only). append adds content; replace swaps the full text (over ${MAX_MEMORY_CHARS} chars requires a replace to trim first).`,
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } },
          required: ['text', 'mode'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const conversation = ctx.host.getConversation(context.conversationId)
          if (!isMemorySessionEligible(conversation)) {
            throw new HelmxError(
              'memory_session_not_eligible',
              `Conversation ${conversation.id} is a child conversation; calling update_memory is only allowed in top-level conversations`,
              403,
              { conversationId: conversation.id, profileId: conversation.profileId },
            )
          }
          if (!isEnabled(conversation.profileId)) throw disabledError(conversation.profileId, 'calling update_memory')
          const content = await store.updateMemory(conversation.profileId, input.text, input.mode)
          markInitialized(conversation.profileId)
          return { updated: true, profileId: conversation.profileId, length: content.length }
        },
      })

      const dreamDoc = ctx.doc<DreamDoc>('dream', {
        version: 1,
        config: { enabled: true, hour: 3, timezone: defaultDreamTimezone() },
        runs: {},
      })
      const emitDreamError = (title: string, detail: unknown): void => {
        reportPluginError(ctx.host, {
          logTag: 'memory-dream',
          bodyPrefix: '[memory-dream]',
          title,
          detail,
        })
      }
      const dream = createDreamEngine(
        {
          dataDir: ctx.dataDir,
          doc: dreamDoc,
          redact: (t) => ctx.host.redact(t),
          atomicWriteFile: (p, c) => ctx.host.atomicWriteFile(p, c),
          completeText: (i) => ctx.host.completeText(i),
          getDreamModel: () => {
            const raw = (ctx.getConfig() as { dreamModel?: unknown }).dreamModel
            return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : undefined
          },
          listConversations: (f) => ctx.host.listConversations(f),
          store,
          profiles: { list: async () => ctx.host.profiles.list() },
          isMemoryEnabled: isEnabled,
          emitError: emitDreamError,
        },
        options.dream,
      )

      ctx.host.onEvent('profile.changed', (event) => {
        if (
          event &&
          typeof event === 'object' &&
          (event as { type?: unknown }).type === 'profile.changed' &&
          (event as { removed?: unknown }).removed === true
        ) {
          const profileId = (event as { profile?: { id?: unknown } }).profile?.id
          if (typeof profileId === 'string' && profileId !== '') pruneDeletedProfile(profileId)
        }
      })
      ctx.hook.onTurnSettled((payload) => dream.collectFromSettledTurn(payload))
      ctx.service({
        id: 'memory-dream',
        liveTasks: () => dream.liveTasks(),
        async start() {
          await ctx.host.skills.ensureSkill(readMemorySkillAsset())
          await reconcileDeletedProfiles()
          await dream.start()
        },
        stop: () => dream.stop(),
      })

      ctx.action<{ profileId?: string }, DreamRunSummary>({
        id: 'dream',
        description: 'Run memory Dream consolidation for one Profile now (--profile-id or --current)',
        exposeToPrompt: false,
        cli: { timeoutMs: 0 },
        inputSchema: PROFILE_SELECTOR_INPUT,
        outputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string' }, ran: { type: 'boolean' }, reason: { type: 'string' },
            applied: { type: 'boolean' }, conflict: { type: 'boolean' }, candidateCount: { type: 'number' },
            beforeChars: { type: 'number' }, afterChars: { type: 'number' }, sentCount: { type: 'number' }, consumed: { type: 'number' },
          },
          required: ['profileId', 'ran', 'candidateCount'],
          additionalProperties: false,
        },
        async handler(input, context) {
          const profileId = await resolveAndRequire(input.profileId, context)
          if (!isEnabled(profileId)) throw disabledError(profileId, 'dreaming (which writes MEMORY.md)')
          try {
            return await dream.dreamFor(profileId)
          } catch (err) {
            emitDreamError(`memory dream of profile '${profileId}' failed`, err)
            throw err
          }
        },
      })

      ctx.action<{ profileId?: string }, DreamStatusView & { profileId?: string }>({
        id: 'dream_status',
        description: 'Dream status: schedule config, next run, in-flight profiles, and per-Profile counts/last run',
        exposeToPrompt: false,
        idempotent: true,
        inputSchema: PROFILE_SELECTOR_INPUT,
        outputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
            config: {
              type: 'object',
              properties: { enabled: { type: 'boolean' }, hour: { type: 'number' }, timezone: { type: 'string' } },
              required: ['enabled', 'hour', 'timezone'],
              additionalProperties: false,
            },
            nextRunAt: { type: 'number' },
            running: { type: 'array', items: { type: 'string' } },
            profiles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  profileId: { type: 'string' }, enabled: { type: 'boolean' }, candidateCount: { type: 'number' },
                  memoryChars: { type: ['number', 'null'] }, lastRun: { type: 'object' },
                },
                required: ['profileId', 'enabled', 'candidateCount', 'memoryChars'],
                additionalProperties: false,
              },
            },
          },
          required: ['config', 'running', 'profiles'],
          additionalProperties: false,
        },
        async handler(input, context) {
          const focus =
            input.profileId !== undefined
              ? input.profileId
              : context.conversationId !== undefined
                ? ctx.host.getConversation(context.conversationId).profileId
                : undefined
          if (focus !== undefined) await requireProfile(profiles, focus)
          const view = await dream.status(focus)
          return focus === undefined ? view : { ...view, profileId: focus }
        },
      })

      ctx.action<{ enabled?: boolean; hour?: number; timezone?: string }, { enabled: boolean; hour: number; timezone: string; nextRunAt?: number }>({
        id: 'dream_configure',
        description: 'Configure the daily Dream schedule (global): --enabled, --hour <0-23>, --timezone <IANA>',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          properties: { enabled: { type: 'boolean' }, hour: { type: 'integer', minimum: 0, maximum: 23 }, timezone: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
        outputSchema: DREAM_CONFIG_OUTPUT,
        handler: (input) => dream.configure(input),
      })

      ctx.ui.slot({
        id: 'profile-memory-section',
        target: PROFILE_DETAIL_SECTION_SLOT,
        order: 10,
        client: { module: 'index.tsx', export: 'ProfileMemorySection' },
      })
    },
  }
}
