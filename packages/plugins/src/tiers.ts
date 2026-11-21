/**
 * builtin:tiers: semantic model tiers (`tier/<id>`) and reusable preset templates.
 *
 * Responsibilities (all policy & UX live here; kernel keeps only thin dereferencing):
 * - Mounts the active tier table into kernel ModelRegistry via `ctx.host.registerModelTiers`
 *   during `prepare()` (auto-unmounted on plugin disable; in-use check blocks accidental disable
 *   when global defaults or Profiles still reference `tier/*`);
 * - Bootstraps the managed skill `model-tiers` (orchestration patterns & template playbook);
 * - Optionally injects a compact `<available_model_tiers>` index via `before_turn` (only when
 *   usable non-disabled tiers exist and `autoInjectCatalog !== false`; zero tool-name hardcoding);
 * - Exposes `list / set / remove / replace / save_template / apply_template / delete_template`
 *   via `ctx.action` (auto-mapped to HTTP, `helmx tiers ...` CLI, and Agent actions);
 * - Contributes `TiersManagerScreen` (full-stage tier & template editor) and `TiersSettingsPanel`.
 */
import {
  HelmxError,
  MODEL_TIER_DESCRIPTION_MAX_LENGTH,
  type ModelTierCatalogEntry,
  type ModelTierRegistration,
  type ModelTierSpec,
  type PluginDefinition,
} from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import { readTiersSkillAsset } from './tiers/assets.js'
import {
  MAX_TIERS_COUNT,
  MODEL_TIERS_SKILL_ID,
  TIERS_PLUGIN_ID,
  TIERS_SCREEN_ID,
  TIERS_STATE_DOC,
  TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH,
  TIER_TEMPLATE_NAME_MAX_LENGTH,
  TIER_THINKING_LEVELS,
  createEmptyTiersState,
  type TierTemplate,
  type TiersPluginConfig,
  type TiersStateDoc,
} from './tiers/contracts.js'
import {
  assertConcreteModelRef,
  assertRemovedTiersNotInUse,
  assertTargetModelNotDisabled,
  assertTemplateCapacity,
  assertTemplateId,
  assertTierId,
  findTierReferences,
  normalizeTemplateMeta,
  normalizeTierSpec,
  normalizeTiersRecord,
  projectTierEntries,
  renderModelTiersCatalogSection,
  sanitizeStateDoc,
} from './tiers/validation.js'

export {
  TIERS_PLUGIN_ID,
  TIERS_STATE_DOC,
  TIERS_SCREEN_ID,
  MODEL_TIERS_SKILL_ID,
  TIER_THINKING_LEVELS,
  type TierTemplate,
  type TiersStateDoc,
  type TiersPluginConfig,
}

const TIER_ENTRY_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['id', 'model', 'available'],
  properties: {
    id: { type: 'string' },
    model: { type: 'string' },
    thinkingLevel: { type: 'string' },
    description: { type: 'string' },
    available: { type: 'boolean' },
    disabled: { type: 'boolean' },
    thinkingLevels: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const

const TIER_SPEC_INPUT_SCHEMA = {
  type: 'object',
  required: ['model'],
  properties: {
    model: { type: 'string', minLength: 1 },
    thinkingLevel: { type: 'string' },
    description: { type: 'string', maxLength: MODEL_TIER_DESCRIPTION_MAX_LENGTH },
  },
  additionalProperties: false,
} as const

const TEMPLATE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'tiers', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    tiers: { type: 'object', additionalProperties: TIER_SPEC_INPUT_SCHEMA },
    updatedAt: { type: 'number' },
  },
  additionalProperties: false,
} as const

const LIST_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['tiers', 'templates', 'autoInjectCatalog'],
  properties: {
    tiers: { type: 'array', items: TIER_ENTRY_OUTPUT_SCHEMA },
    templates: { type: 'array', items: TEMPLATE_OUTPUT_SCHEMA },
    activeTemplate: { type: 'string' },
    autoInjectCatalog: { type: 'boolean' },
  },
  additionalProperties: false,
} as const

export function createTiersPlugin(): PluginDefinition {
  return {
    id: TIERS_PLUGIN_ID,
    name: { en: 'Model Tiers', 'zh-CN': '模型档位' },
    description: {
      en: 'Semantic model tiers (tier/<id>) and reusable preset templates for multi-model collaboration across subagents, workflows, and swarm.',
      'zh-CN': '语义模型档位（tier/<id>）与可复用编制模板：一次定义模型定位，自动服务子代理、工作流与 Swarm 协同。',
    },
    icon: 'layers',
    version: '0.1.0',
    ...resolvePluginClientAssets(TIERS_PLUGIN_ID, 'tiers', 'tiers_plugin_client_missing'),
    definePlugin(ctx) {
      ctx.configSchema({
        autoInjectCatalog: {
          type: 'boolean',
          default: true,
          label: { en: 'Auto-inject tier catalog', 'zh-CN': '自动注入档位目录' },
          description: {
            en: 'Inject a concise <available_model_tiers> directory into every turn when usable tiers exist. Disable to rely purely on the model-tiers skill.',
            'zh-CN': '配置了可用档位时在每回合注入精炼的 <available_model_tiers> 目录；关闭后仅通过 model-tiers 技能按需查询。',
          },
        },
      })

      const stateDoc = ctx.doc<TiersStateDoc>(TIERS_STATE_DOC, createEmptyTiersState(), { public: true })
      let registration: ModelTierRegistration | undefined
      let writeChain: Promise<unknown> = Promise.resolve()

      const enqueueWrite = <T>(op: () => Promise<T>): Promise<T> => {
        const run = writeChain.then(op, op)
        writeChain = run.then(() => undefined, () => undefined)
        return run
      }

      const readState = (): TiersStateDoc => sanitizeStateDoc(stateDoc.get())

      const autoInjectEnabled = (): boolean => {
        const cfg = ctx.getConfig() as TiersPluginConfig
        return cfg.autoInjectCatalog !== false
      }

      const buildListPayload = async (): Promise<{
        tiers: ModelTierCatalogEntry[]
        templates: TierTemplate[]
        activeTemplate?: string
        autoInjectCatalog: boolean
      }> => {
        const state = readState()
        const catalog = await ctx.host.listModels()
        const tiers = projectTierEntries(state.tiers, catalog)
        const templates = Object.values(state.templates).sort(
          (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
        )
        return {
          tiers,
          templates,
          ...(state.activeTemplate !== undefined ? { activeTemplate: state.activeTemplate } : {}),
          autoInjectCatalog: autoInjectEnabled(),
        }
      }

      // Mount active tiers in `prepare()` so `defaultModel` / `Profile.model` targeting `tier/<id>`
      // resolve cleanly before services start and before the SDK scheduler resumes conversations.
      ctx.service({
        id: 'tiers-runtime',
        prepare() {
          registration = ctx.host.registerModelTiers(() => readState().tiers)
        },
        async start() {
          await ctx.host.skills.ensureSkill(readTiersSkillAsset())
          if (Object.keys(readState().tiers).length > 0) {
            await registration?.notifyChanged()
          }
        },
        async stop() {
          await writeChain
          const reg = registration
          registration = undefined
          reg?.release()
        },
        async inUse() {
          const state = readState()
          if (Object.keys(state.tiers).length === 0) return []
          const [catalog, profiles] = await Promise.all([
            ctx.host.listModels(),
            ctx.host.profiles.list(),
          ])
          return findTierReferences(catalog, profiles)
        },
      })

      ctx.hook.onBeforeTurn(async (turn) => {
        if (!autoInjectEnabled()) return { action: 'continue' }
        const state = readState()
        if (Object.keys(state.tiers).length === 0) return { action: 'continue' }
        const catalog = await ctx.host.listModels()
        const entries = projectTierEntries(state.tiers, catalog)
        const text = renderModelTiersCatalogSection(entries)
        if (text === undefined) return { action: 'continue' }
        return {
          action: 'transform',
          value: {
            ...turn,
            sections: [...turn.sections, { id: 'tiers.catalog', text }],
          },
        }
      })

      // ---- Actions (HTTP / CLI `helmx tiers ...` / Agent run_action) ----

      ctx.action({
        id: 'list',
        description: 'List configured model tiers (with live availability), saved preset templates, and catalog injection state',
        idempotent: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: LIST_OUTPUT_SCHEMA,
        handler: async () => buildListPayload(),
      })

      ctx.action({
        id: 'set',
        description: 'Create or update one model tier binding (tier/<id> -> concrete provider/model, optional thinkingLevel and description)',
        inputSchema: {
          type: 'object',
          required: ['id', 'model'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 63 },
            model: { type: 'string', minLength: 1 },
            thinkingLevel: { type: 'string', enum: ['', ...TIER_THINKING_LEVELS] },
            description: { type: 'string', maxLength: MODEL_TIER_DESCRIPTION_MAX_LENGTH },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          required: ['tier', 'tiers'],
          properties: {
            tier: TIER_ENTRY_OUTPUT_SCHEMA,
            tiers: { type: 'array', items: TIER_ENTRY_OUTPUT_SCHEMA },
          },
          additionalProperties: false,
        },
        handler: async (input: { id: string; model: string; thinkingLevel?: string; description?: string }) =>
          enqueueWrite(async () => {
            const id = assertTierId(input.id)
            const spec = normalizeTierSpec(
              {
                model: assertConcreteModelRef(input.model),
                ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
                ...(input.description !== undefined ? { description: input.description } : {}),
              },
              id,
            )
            const catalog = await ctx.host.listModels()
            assertTargetModelNotDisabled(catalog, spec.model)
            const current = readState()
            const isNew = !Object.prototype.hasOwnProperty.call(current.tiers, id)
            if (isNew && Object.keys(current.tiers).length >= MAX_TIERS_COUNT) {
              throw new HelmxError('validation_error', `At most ${MAX_TIERS_COUNT} model tiers are allowed`, 400, {
                maxTiers: MAX_TIERS_COUNT,
              })
            }
            const nextTiers: Record<string, ModelTierSpec> = { ...current.tiers, [id]: spec }
            stateDoc.set({
              tiers: nextTiers,
              templates: current.templates,
            })
            await stateDoc.flush()
            await registration?.notifyChanged()
            const refreshed = await ctx.host.listModels()
            const projected = projectTierEntries(nextTiers, refreshed)
            const tier = projected.find((entry) => entry.id === id)!
            return { tier, tiers: projected }
          }),
      })

      ctx.action({
        id: 'remove',
        description: 'Delete a model tier binding (rejects with 409 model_tier_in_use if referenced by defaults or Profiles unless force: true)',
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 63 },
            force: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          required: ['removed', 'tiers'],
          properties: {
            removed: { type: 'string' },
            tiers: { type: 'array', items: TIER_ENTRY_OUTPUT_SCHEMA },
          },
          additionalProperties: false,
        },
        handler: async (input: { id: string; force?: boolean }) =>
          enqueueWrite(async () => {
            const id = assertTierId(input.id)
            const current = readState()
            if (!Object.prototype.hasOwnProperty.call(current.tiers, id)) {
              throw new HelmxError('model_tier_not_found', `Model tier '${id}' does not exist`, 404, { id })
            }
            const [catalog, profiles] = await Promise.all([
              ctx.host.listModels(),
              ctx.host.profiles.list(),
            ])
            assertRemovedTiersNotInUse(new Set([id]), catalog, profiles, input.force)
            const nextTiers = { ...current.tiers }
            delete nextTiers[id]
            stateDoc.set({
              tiers: nextTiers,
              templates: current.templates,
            })
            await stateDoc.flush()
            await registration?.notifyChanged()
            const refreshed = await ctx.host.listModels()
            return { removed: id, tiers: projectTierEntries(nextTiers, refreshed) }
          }),
      })

      ctx.action({
        id: 'replace',
        description: 'Atomically replace the entire active model tiers table (primarily used by the Model Tiers UI editor)',
        exposeToPrompt: false,
        cli: { hidden: true },
        inputSchema: {
          type: 'object',
          required: ['tiers'],
          properties: {
            tiers: { type: 'object', additionalProperties: TIER_SPEC_INPUT_SCHEMA },
            force: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        outputSchema: LIST_OUTPUT_SCHEMA,
        handler: async (input: { tiers: Record<string, ModelTierSpec>; force?: boolean }) =>
          enqueueWrite(async () => {
            const nextTiers = normalizeTiersRecord(input.tiers)
            const current = readState()
            const removed = new Set(
              Object.keys(current.tiers).filter((id) => !Object.prototype.hasOwnProperty.call(nextTiers, id)),
            )
            const [catalog, profiles] = await Promise.all([
              ctx.host.listModels(),
              ctx.host.profiles.list(),
            ])
            for (const spec of Object.values(nextTiers)) {
              assertTargetModelNotDisabled(catalog, spec.model)
            }
            assertRemovedTiersNotInUse(removed, catalog, profiles, input.force)
            stateDoc.set({
              tiers: nextTiers,
              templates: current.templates,
            })
            await stateDoc.flush()
            await registration?.notifyChanged()
            return buildListPayload()
          }),
      })

      ctx.action({
        id: 'save_template',
        description: 'Save a reusable tier preset template (defaults to snapshotting the currently active tiers when tiers is omitted)',
        cli: { command: ['tiers', 'save-template'] },
        inputSchema: {
          type: 'object',
          required: ['id', 'name'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 63 },
            name: { type: 'string', minLength: 1, maxLength: TIER_TEMPLATE_NAME_MAX_LENGTH },
            description: { type: 'string', maxLength: TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH },
            tiers: { type: 'object', additionalProperties: TIER_SPEC_INPUT_SCHEMA },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          required: ['template', 'templates'],
          properties: {
            template: TEMPLATE_OUTPUT_SCHEMA,
            templates: { type: 'array', items: TEMPLATE_OUTPUT_SCHEMA },
          },
          additionalProperties: false,
        },
        handler: async (input: {
          id: string
          name: string
          description?: string
          tiers?: Record<string, ModelTierSpec>
        }) =>
          enqueueWrite(async () => {
            const id = assertTemplateId(input.id)
            const meta = normalizeTemplateMeta({ name: input.name, description: input.description })
            const current = readState()
            assertTemplateCapacity(current.templates, id)
            const sourceTiers = input.tiers !== undefined ? normalizeTiersRecord(input.tiers) : { ...current.tiers }
            if (Object.keys(sourceTiers).length === 0) {
              throw new HelmxError(
                'validation_error',
                'Cannot save an empty tier template: configure at least one tier first or pass tiers explicitly',
                400,
              )
            }
            const template: TierTemplate = {
              id,
              name: meta.name,
              ...(meta.description !== undefined ? { description: meta.description } : {}),
              tiers: sourceTiers,
              updatedAt: Date.now(),
            }
            const nextTemplates = { ...current.templates, [id]: template }
            stateDoc.set({
              tiers: current.tiers,
              templates: nextTemplates,
              ...(input.tiers === undefined ? { activeTemplate: id } : current.activeTemplate ? { activeTemplate: current.activeTemplate } : {}),
            })
            await stateDoc.flush()
            const templates = Object.values(nextTemplates).sort(
              (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
            )
            return { template, templates }
          }),
      })

      ctx.action({
        id: 'apply_template',
        description: 'Switch the active model tiers roster to a saved preset template in one step',
        cli: { command: ['tiers', 'apply-template'] },
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 63 },
            force: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        outputSchema: LIST_OUTPUT_SCHEMA,
        handler: async (input: { id: string; force?: boolean }) =>
          enqueueWrite(async () => {
            const id = assertTemplateId(input.id)
            const current = readState()
            const template = current.templates[id]
            if (template === undefined) {
              throw new HelmxError('tier_template_not_found', `Tier template '${id}' does not exist`, 404, { id })
            }
            const nextTiers = normalizeTiersRecord(template.tiers)
            const removed = new Set(
              Object.keys(current.tiers).filter((tid) => !Object.prototype.hasOwnProperty.call(nextTiers, tid)),
            )
            const [catalog, profiles] = await Promise.all([
              ctx.host.listModels(),
              ctx.host.profiles.list(),
            ])
            for (const spec of Object.values(nextTiers)) {
              assertTargetModelNotDisabled(catalog, spec.model)
            }
            assertRemovedTiersNotInUse(removed, catalog, profiles, input.force)
            stateDoc.set({
              tiers: nextTiers,
              templates: current.templates,
              activeTemplate: id,
            })
            await stateDoc.flush()
            await registration?.notifyChanged()
            return buildListPayload()
          }),
      })

      ctx.action({
        id: 'delete_template',
        description: 'Delete a saved tier preset template (does not affect currently active tiers)',
        cli: { command: ['tiers', 'delete-template'] },
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 63 },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          required: ['deleted', 'templates'],
          properties: {
            deleted: { type: 'string' },
            templates: { type: 'array', items: TEMPLATE_OUTPUT_SCHEMA },
          },
          additionalProperties: false,
        },
        handler: async (input: { id: string }) =>
          enqueueWrite(async () => {
            const id = assertTemplateId(input.id)
            const current = readState()
            if (!Object.prototype.hasOwnProperty.call(current.templates, id)) {
              throw new HelmxError('tier_template_not_found', `Tier template '${id}' does not exist`, 404, { id })
            }
            const nextTemplates = { ...current.templates }
            delete nextTemplates[id]
            stateDoc.set({
              tiers: current.tiers,
              templates: nextTemplates,
              ...(current.activeTemplate !== undefined && current.activeTemplate !== id
                ? { activeTemplate: current.activeTemplate }
                : {}),
            })
            await stateDoc.flush()
            const templates = Object.values(nextTemplates).sort(
              (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
            )
            return { deleted: id, templates }
          }),
      })

      // ---- Declarative UI (client.tsx React track; zero Emoji, Lucide icons) ----

      ctx.ui.sidebarItem({
        id: 'tiers-manager',
        label: { en: 'Model Tiers', 'zh-CN': '模型档位' },
        icon: 'layers',
        target: `screen:${TIERS_PLUGIN_ID}/${TIERS_SCREEN_ID}`,
        order: 16,
      })

      ctx.ui.screen({
        id: TIERS_SCREEN_ID,
        label: { en: 'Model Tiers', 'zh-CN': '模型档位' },
        icon: 'layers',
        client: { module: 'index.tsx', export: 'TiersManagerScreen' },
      })

      ctx.ui.settingsPanel({
        id: 'tiers-settings',
        label: { en: 'Model Tiers', 'zh-CN': '模型档位' },
        order: 26,
        client: { module: 'index.tsx', export: 'TiersSettingsPanel' },
      })
    },
  }
}
