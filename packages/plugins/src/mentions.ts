/**
 * builtin:mentions: cross-Profile `@` collaboration plugin (non-locked, toggleable).
 *
 * Responsibilities:
 * - Low-priority `before_turn` (priority -100, running after default tool-stripping hooks) injects
 *   `mentions.catalog` (`<available_profiles>`) when active dispatch tools (`helmx.dispatch-tools`) survive;
 * - Exposes the idempotent `list_mentionable` action (the `@` completion source, CLI `helmx mentions list_mentionable`);
 * - Registers the composer `@` completion source `role-mentions`.
 */
import {
  HelmxError,
  isPluginSummaryActive,
  type DispatchToolsCapability,
  type HelmxPluginContext,
  type PluginDefinition,
} from '@helmx/protocol'
import {
  describeHint,
  extractSystemSummary,
  isCollaborationCandidate,
  renderProfileCatalogSection,
  toCatalogEntry,
  type ProfileCatalogEntry,
} from './mentions/catalog.js'

export const MENTIONS_PLUGIN_ID = 'builtin:mentions'
export const MENTIONS_CATALOG_SECTION_ID = 'mentions.catalog'
export const MENTIONS_COMPLETER_ID = 'role-mentions'

/** Catalog injection hook priority: below default 0 so it runs after tool-stripping hooks. */
const CATALOG_HOOK_PRIORITY = -100

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
} from './mentions/catalog.js'

interface MentionsRuntimeHelpers {
  computeCatalog(currentProfileId: string): Promise<ProfileCatalogEntry[]>
  dispatchToolNames(tools: readonly { name: string }[]): string[]
}

function createMentionsRuntimeHelpers(ctx: HelmxPluginContext): MentionsRuntimeHelpers {
  const { profiles } = ctx.host

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

  return { computeCatalog, dispatchToolNames }
}

export function createMentionsPlugin(): PluginDefinition {
  return {
    id: MENTIONS_PLUGIN_ID,
    name: { en: 'Role Mentions', 'zh-CN': '角色点名' },
    description: {
      en: 'Provides @ role mention completion in the composer and injects the cross-role collaboration catalog (<available_profiles>) when dispatch tools are active.',
      'zh-CN': '在输入框提供 @ 角色点名补全，并在存在派工工具时注入可协作角色目录（<available_profiles>）。',
    },
    icon: 'bot',
    version: '0.1.0',
    definePlugin(ctx) {
      const { profiles } = ctx.host
      const helpers = createMentionsRuntimeHelpers(ctx)

      ctx.hook.onBeforeTurn(
        async (turn) => {
          const withoutMentions = turn.sections.filter((s) => s.id !== MENTIONS_CATALOG_SECTION_ID)
          const hadMentions = withoutMentions.length !== turn.sections.length
          const tools = helpers.dispatchToolNames(turn.tools)
          if (tools.length === 0) {
            return hadMentions ? { action: 'transform', value: { ...turn, sections: withoutMentions } } : { action: 'continue' }
          }
          const entries = await helpers.computeCatalog(turn.conversation.profileId)
          if (entries.length === 0) {
            return hadMentions ? { action: 'transform', value: { ...turn, sections: withoutMentions } } : { action: 'continue' }
          }
          const sections = [
            ...withoutMentions,
            { id: MENTIONS_CATALOG_SECTION_ID, text: renderProfileCatalogSection(entries, { dispatchToolNames: tools }) },
          ]
          return { action: 'transform', value: { ...turn, sections } }
        },
        { priority: CATALOG_HOOK_PRIORITY },
      )

      ctx.action<
        { query?: string; conversationId?: number; profileId?: string },
        { items: Array<{ id: string; label: string; insertText: string; hint: string; icon: string }> }
      >({
        id: 'list_mentionable',
        description:
          'List Profile candidates that the current conversation or a standby role can @ mention for collaboration (the @ completion source; --current / --conversation-id / --profile-id pick the context)',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Filter prefix (empty by default)' },
            conversationId: {
              type: 'number',
              description:
                'Explicit target conversation (used when the CLI has no calling context; Web conversation completion omits it and defers to the server context)',
            },
            profileId: {
              type: 'string',
              minLength: 1,
              description:
                "Explicit target role (used with no conversation context, e.g. standby draft mode; with conversation context, the server conversation's role wins)",
            },
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
              throw new HelmxError('not_found', `profile does not exist: ${input.profileId}`, 404, {
                profileId: input.profileId,
              })
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
          const entries = await helpers.computeCatalog(targetProfileId)
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
        id: MENTIONS_COMPLETER_ID,
        label: { en: 'Mention roles', 'zh-CN': '点名角色' },
        trigger: '@',
        priority: 100,
        source: { kind: 'action', actionId: 'list_mentionable' },
      })
    },
  }
}
