/** Model commands: models list / default / providers / refresh / filter. */
import type { ModelCatalog, ModelProviderSummary, ModelProvidersRefreshResult, SetModelFilterBody } from '@helmx/protocol'
import { flagValue, type FlagSpec } from '../args.js'
import { CliError } from '../errors.js'
import { printTableColumns } from '../output.js'
import { assertNoExtraPositionals, printResult } from './shared.js'
import type { CommandContext, CommandSpec } from './shared.js'

/** Flag specs for models refresh (--provider is optional; --json is handled globally). */
const REFRESH_FLAGS: readonly FlagSpec[] = [
  { name: 'provider', type: 'string', help: 'refresh only the specified provider (defaults to all dynamic providers)' },
]

/** Flag specs for models default. */
const DEFAULT_FLAGS: readonly FlagSpec[] = [
  { name: 'set', type: 'string', help: 'set global default model (provider/model; empty string to clear)' },
  { name: 'thinking', type: 'string', help: 'set global default thinking level (off/minimal/low/medium/high/xhigh/max; empty string to clear)' },
  { name: 'model-thinking', type: 'string', help: 'set a per-model thinking default (provider/model=level; modelId may contain slashes; empty level clears that model entry)' },
  { name: 'compaction', type: 'string', help: 'set global compaction model (provider/model; empty string to clear)' },
  { name: 'compaction-thinking', type: 'string', help: 'set global compaction thinking level (off/minimal/low/medium/high/xhigh/max; empty string to clear)' },
]

/** Flag specs for models filter (--disable is repeatable; --clear empties the provider's disabled list). */
const FILTER_FLAGS: readonly FlagSpec[] = [
  { name: 'provider', type: 'string', help: 'target provider ID (only omitted when clearing all disabled entries)' },
  { name: 'disable', type: 'string', repeated: true, help: 'model ID to disable (repeatable; replaces the full disabled list for that provider)' },
  { name: 'clear', type: 'boolean', help: 'clear the disabled list for that provider (with --provider; clears all if omitted)' },
]

export function modelsCommands(): CommandSpec[] {
  return [
    {
      path: ['models', 'list'],
      description: 'List available models (GET /api/models)',
      async run(ctx: CommandContext) {
        const hub = await ctx.hub()
        const catalog = await hub.get<ModelCatalog>('/api/models')
        printResult(ctx, ctx.json ? catalog : catalog.models)
      },
    },
    {
      path: ['models', 'default'],
      description: 'View or set global default model, per-model thinking defaults, and compaction model (GET/PUT /api/models/default)',
      flags: DEFAULT_FLAGS,
      async run(ctx: CommandContext) {
        assertNoExtraPositionals(ctx.positionals, 0)
        const hub = await ctx.hub()
        const set = flagValue<string>(ctx.flags, 'set')
        const thinking = flagValue<string>(ctx.flags, 'thinking')
        const modelThinking = flagValue<string>(ctx.flags, 'model-thinking')
        const compaction = flagValue<string>(ctx.flags, 'compaction')
        const compactionThinking = flagValue<string>(ctx.flags, 'compaction-thinking')
        // Parse `provider/model=level` once at the first `=` (modelId may contain slashes, never `=`).
        const modelThinkingEntry =
          modelThinking === undefined
            ? undefined
            : (() => {
                const eq = modelThinking.indexOf('=')
                if (eq <= 0) {
                  throw new CliError(
                    `--model-thinking expects provider/model=level (received '${modelThinking}')`,
                    'invalid_flag_value',
                  )
                }
                return { model: modelThinking.slice(0, eq), level: modelThinking.slice(eq + 1) }
              })()
        if (
          set === undefined &&
          thinking === undefined &&
          modelThinkingEntry === undefined &&
          compaction === undefined &&
          compactionThinking === undefined
        ) {
          printResult(
            ctx,
            await hub.get<{
              defaultModel: string
              defaultThinkingLevel: string
              modelThinkingLevels: Record<string, string>
              defaultCompactionModel: string
              defaultCompactionThinkingLevel: string
            }>('/api/models/default'),
          )
          return
        }
        printResult(
          ctx,
          await hub.put<{
            ok: boolean
            defaultModel: string
            defaultThinkingLevel: string
            modelThinkingLevels: Record<string, string>
            defaultCompactionModel: string
            defaultCompactionThinkingLevel: string
          }>(
            '/api/models/default',
            {
              ...(set !== undefined ? { model: set } : {}),
              ...(thinking !== undefined ? { thinkingLevel: thinking } : {}),
              ...(modelThinkingEntry !== undefined
                ? { modelThinking: modelThinkingEntry.model, modelThinkingLevel: modelThinkingEntry.level }
                : {}),
              ...(compaction !== undefined ? { compactionModel: compaction } : {}),
              ...(compactionThinking !== undefined ? { compactionThinkingLevel: compactionThinking } : {}),
            },
          ),
        )
      },
    },
    {
      path: ['models', 'providers'],
      description: 'List Pi providers and authentication methods (GET /api/models/providers)',
      async run(ctx: CommandContext) {
        const hub = await ctx.hub()
        const providers = await hub.get<ModelProviderSummary[]>('/api/models/providers')
        if (ctx.json || !Array.isArray(providers)) {
          printResult(ctx, providers)
          return
        }
        printTableColumns(ctx.io, providers, [
          { label: 'id', value: (p) => p.id },
          { label: 'name', value: (p) => p.name },
          { label: 'models', value: (p) => String(p.modelCount) },
          { label: 'auth', value: (p) => p.authMethods.map((m) => m.label || m.type).join(', ') },
          { label: 'dynamic', value: (p) => (p.dynamic === true ? 'yes' : 'no') },
        ])
      },
    },
    {
      path: ['models', 'refresh'],
      description: 'Refresh dynamic model catalog (POST /api/models/refresh)',
      flags: REFRESH_FLAGS,
      async run(ctx: CommandContext) {
        assertNoExtraPositionals(ctx.positionals, 0)
        const provider = flagValue<string>(ctx.flags, 'provider')
        const hub = await ctx.hub()
        const result = await hub.post<ModelProvidersRefreshResult>('/api/models/refresh', {
          ...(provider !== undefined ? { provider } : {}),
        })
        printResult(ctx, result)
      },
    },
    {
      path: ['models', 'filter'],
      description: 'View or set disabled models (GET/PUT /api/models/filter)',
      flags: FILTER_FLAGS,
      async run(ctx: CommandContext) {
        assertNoExtraPositionals(ctx.positionals, 0)
        const hub = await ctx.hub()
        const provider = flagValue<string>(ctx.flags, 'provider')
        const disable = (ctx.flags.get('disable') as string[] | undefined) ?? []
        const clear = ctx.flags.get('clear') === true

        // Read mode: without any write flags, display disabled models from the current catalog.
        if (provider === undefined && disable.length === 0 && !clear) {
          const catalog = await hub.get<ModelCatalog>('/api/models')
          if (ctx.json) {
            printResult(ctx, catalog)
            return
          }
          const disabled = catalog.models.filter((m) => m.disabled === true)
          printResult(
            ctx,
            disabled.length === 0
              ? 'no disabled models'
              : disabled.map((m) => `${m.provider}/${m.modelId}`),
          )
          return
        }

        if (clear && disable.length > 0) {
          throw new CliError('--clear and --disable are mutually exclusive', 'invalid_flag_value')
        }
        const body: SetModelFilterBody = clear
          ? { ...(provider !== undefined ? { provider } : {}), disabledModels: [] }
          : { ...(provider !== undefined ? { provider } : {}), disabledModels: disable }
        if (provider === undefined && disable.length > 0) {
          throw new CliError('without --provider, only clearing all disabled entries is supported (cannot pass --disable)', 'invalid_flag_value')
        }
        printResult(ctx, await hub.put<{ ok: boolean; catalog: ModelCatalog }>('/api/models/filter', body))
      },
    },
  ]
}
