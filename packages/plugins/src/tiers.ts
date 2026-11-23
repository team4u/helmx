/** builtin:tiers: semantic model tiers (`tier/<id>`) and reusable preset templates. */
import {
  HelmxError, MODEL_TIER_DESCRIPTION_MAX_LENGTH,
  type ModelCatalog, type ModelTiersCapability, type ModelTierSpec, type PluginDefinition,
} from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import { readTiersSkillAsset } from './tiers/assets.js'
import {
  MAX_TIERS_COUNT, MODEL_TIERS_SKILL_ID, TIERS_PLUGIN_ID, TIERS_SCREEN_ID, TIERS_STATE_DOC,
  TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH, TIER_TEMPLATE_NAME_MAX_LENGTH, TIER_THINKING_LEVELS,
  createEmptyTiersState, type TierTemplate, type TiersPluginConfig, type TiersStateDoc,
} from './tiers/contracts.js'
import {
  assertConcreteModelRef, assertRemovedTiersNotInUse, assertTargetModelNotDisabled, assertTemplateCapacity,
  assertTemplateId, assertTierId, findTierReferences, normalizeTemplateMeta, normalizeTierSpec,
  normalizeTiersRecord, projectTierEntries, renderModelTiersCatalogSection, sanitizeStateDoc,
} from './tiers/validation.js'

export {
  TIERS_PLUGIN_ID, TIERS_STATE_DOC, TIERS_SCREEN_ID, MODEL_TIERS_SKILL_ID, TIER_THINKING_LEVELS,
  type TierTemplate, type TiersStateDoc, type TiersPluginConfig,
}

const ID_PROP = { type: 'string', minLength: 1, maxLength: 63 } as const
const TIER_SPEC_SCHEMA = {
  type: 'object', required: ['model'], additionalProperties: false,
  properties: { model: { type: 'string', minLength: 1 }, thinkingLevel: { type: 'string' }, description: { type: 'string', maxLength: MODEL_TIER_DESCRIPTION_MAX_LENGTH } },
} as const
const TIER_ENTRY_SCHEMA = {
  type: 'object', required: ['id', 'model', 'available'], additionalProperties: false,
  properties: {
    id: { type: 'string' }, model: { type: 'string' }, thinkingLevel: { type: 'string' },
    description: { type: 'string' }, available: { type: 'boolean' }, disabled: { type: 'boolean' },
    thinkingLevels: { type: 'array', items: { type: 'string' } },
  },
} as const
const TEMPLATE_SCHEMA = {
  type: 'object', required: ['id', 'name', 'tiers', 'updatedAt'], additionalProperties: false,
  properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, tiers: { type: 'object', additionalProperties: TIER_SPEC_SCHEMA }, updatedAt: { type: 'number' } },
} as const
const LIST_OUTPUT_SCHEMA = {
  type: 'object', required: ['tiers', 'templates', 'autoInjectCatalog'], additionalProperties: false,
  properties: { tiers: { type: 'array', items: TIER_ENTRY_SCHEMA }, templates: { type: 'array', items: TEMPLATE_SCHEMA }, activeTemplate: { type: 'string' }, autoInjectCatalog: { type: 'boolean' } },
} as const

const sortTemplates = (templates: Readonly<Record<string, TierTemplate>>): TierTemplate[] =>
  Object.values(templates).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))

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
      const tierChangeListeners = new Set<() => Promise<void> | void>()
      let writeChain: Promise<unknown> = Promise.resolve()
      let cachedState: TiersStateDoc | undefined

      const enqueueWrite = <T>(op: () => Promise<T>): Promise<T> => {
        const run = writeChain.then(op, op)
        writeChain = run.then(() => undefined, () => undefined)
        return run
      }
      const readState = (): TiersStateDoc => {
        if (cachedState === undefined) {
          cachedState = sanitizeStateDoc(stateDoc.get())
        }
        return cachedState
      }
      const autoInjectEnabled = (): boolean => (ctx.getConfig() as TiersPluginConfig).autoInjectCatalog !== false
      const notifyTiersChanged = async (): Promise<void> => {
        for (const listener of [...tierChangeListeners]) {
          await listener()
        }
      }
      const persist = async (next: TiersStateDoc, notifyTiers = true): Promise<void> => {
        const sanitized = sanitizeStateDoc(next)
        stateDoc.set(sanitized)
        cachedState = sanitized
        try {
          await stateDoc.flush()
        } catch (err) {
          cachedState = undefined
          throw err
        }
        if (notifyTiers) await notifyTiersChanged()
      }

      ctx.provide<ModelTiersCapability>('helmx.model-tiers', {
        getTiers: () => readState().tiers,
        onChanged: (listener) => {
          tierChangeListeners.add(listener)
          return () => {
            tierChangeListeners.delete(listener)
          }
        },
      })

      const buildListPayload = async (catalog?: ModelCatalog) => {
        const state = readState()
        return {
          tiers: projectTierEntries(state.tiers, catalog ?? await ctx.host.listModels()),
          templates: sortTemplates(state.templates),
          ...(state.activeTemplate ? { activeTemplate: state.activeTemplate } : {}),
          autoInjectCatalog: autoInjectEnabled(),
        }
      }

      const applyRoster = async (nextTiers: Record<string, ModelTierSpec>, opts: { force?: boolean; activeTemplate?: string }) => {
        const current = readState()
        const removed = new Set(Object.keys(current.tiers).filter((id) => !Object.hasOwn(nextTiers, id)))
        const [catalog, profiles] = await Promise.all([ctx.host.listModels(), ctx.host.profiles.list()])
        for (const spec of Object.values(nextTiers)) assertTargetModelNotDisabled(catalog, spec.model)
        assertRemovedTiersNotInUse(removed, catalog, profiles, opts.force)
        await persist({ tiers: nextTiers, templates: current.templates, ...(opts.activeTemplate ? { activeTemplate: opts.activeTemplate } : {}) })
        return buildListPayload(catalog)
      }

      ctx.service({
        id: 'tiers-runtime',
        async start() {
          cachedState = sanitizeStateDoc(stateDoc.get())
          await ctx.host.skills.ensureSkill(readTiersSkillAsset())
          if (Object.keys(readState().tiers).length > 0) await notifyTiersChanged()
        },
        async stop() {
          await writeChain
          cachedState = undefined
        },
        async inUse() {
          if (Object.keys(readState().tiers).length === 0) return []
          const [catalog, profiles] = await Promise.all([ctx.host.listModels(), ctx.host.profiles.list()])
          return findTierReferences(catalog, profiles)
        },
      })

      ctx.hook.onBeforeTurn(async (turn) => {
        if (!autoInjectEnabled()) return { action: 'continue' }
        const state = readState()
        if (Object.keys(state.tiers).length === 0) return { action: 'continue' }
        const text = renderModelTiersCatalogSection(projectTierEntries(state.tiers, await ctx.host.listModels()))
        return text ? { action: 'transform', value: { ...turn, sections: [...turn.sections, { id: 'tiers.catalog', text }] } } : { action: 'continue' }
      })

      ctx.action({
        id: 'list',
        description: 'List configured model tiers (with live availability), saved preset templates, and catalog injection state',
        exposeToPrompt: false,
        idempotent: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: LIST_OUTPUT_SCHEMA,
        handler: () => buildListPayload(),
      })

      ctx.action({
        id: 'set',
        description: 'Create or update one model tier binding (tier/<id> -> concrete provider/model, optional thinkingLevel and description)',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object', required: ['id', 'model'], additionalProperties: false,
          properties: { id: ID_PROP, model: { type: 'string', minLength: 1 }, thinkingLevel: { type: 'string', enum: ['', ...TIER_THINKING_LEVELS] }, description: { type: 'string', maxLength: MODEL_TIER_DESCRIPTION_MAX_LENGTH } },
        },
        outputSchema: { type: 'object', required: ['tier', 'tiers'], additionalProperties: false, properties: { tier: TIER_ENTRY_SCHEMA, tiers: { type: 'array', items: TIER_ENTRY_SCHEMA } } },
        handler: (input: { id: string; model: string; thinkingLevel?: string; description?: string }) =>
          enqueueWrite(async () => {
            const id = assertTierId(input.id)
            const spec = normalizeTierSpec({ model: assertConcreteModelRef(input.model), ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}), ...(input.description !== undefined ? { description: input.description } : {}) }, id)
            const catalog = await ctx.host.listModels()
            assertTargetModelNotDisabled(catalog, spec.model)
            const cur = readState()
            if (!Object.hasOwn(cur.tiers, id) && Object.keys(cur.tiers).length >= MAX_TIERS_COUNT) {
              throw new HelmxError('validation_error', `At most ${MAX_TIERS_COUNT} model tiers are allowed`, 400, { maxTiers: MAX_TIERS_COUNT })
            }
            const nextTiers = { ...cur.tiers, [id]: spec }
            await persist({ tiers: nextTiers, templates: cur.templates })
            const tiers = projectTierEntries(nextTiers, catalog)
            return { tier: tiers.find((e) => e.id === id)!, tiers }
          }),
      })

      ctx.action({
        id: 'remove',
        description: 'Delete a model tier binding (rejects with 409 model_tier_in_use if referenced unless force: true)',
        exposeToPrompt: false,
        inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID_PROP, force: { type: 'boolean' } } },
        outputSchema: { type: 'object', required: ['removed', 'tiers'], additionalProperties: false, properties: { removed: { type: 'string' }, tiers: { type: 'array', items: TIER_ENTRY_SCHEMA } } },
        handler: (input: { id: string; force?: boolean }) =>
          enqueueWrite(async () => {
            const id = assertTierId(input.id)
            const cur = readState()
            if (!Object.hasOwn(cur.tiers, id)) throw new HelmxError('model_tier_not_found', `Model tier '${id}' does not exist`, 404, { id })
            const [catalog, profiles] = await Promise.all([ctx.host.listModels(), ctx.host.profiles.list()])
            assertRemovedTiersNotInUse(new Set([id]), catalog, profiles, input.force)
            const nextTiers = { ...cur.tiers }
            delete nextTiers[id]
            await persist({ tiers: nextTiers, templates: cur.templates })
            return { removed: id, tiers: projectTierEntries(nextTiers, catalog) }
          }),
      })

      ctx.action({
        id: 'replace',
        description: 'Atomically replace the entire active model tiers table (used by the Model Tiers UI editor)',
        visibility: 'ui',
        inputSchema: { type: 'object', required: ['tiers'], additionalProperties: false, properties: { tiers: { type: 'object', additionalProperties: TIER_SPEC_SCHEMA }, force: { type: 'boolean' } } },
        outputSchema: LIST_OUTPUT_SCHEMA,
        handler: (input: { tiers: Record<string, ModelTierSpec>; force?: boolean }) =>
          enqueueWrite(() => applyRoster(normalizeTiersRecord(input.tiers), { force: input.force })),
      })

      ctx.action({
        id: 'save_template',
        description: 'Save a reusable tier preset template (defaults to snapshotting active tiers when tiers is omitted)',
        exposeToPrompt: false,
        cli: { command: ['tiers', 'save-template'] },
        inputSchema: {
          type: 'object', required: ['id', 'name'], additionalProperties: false,
          properties: { id: ID_PROP, name: { type: 'string', minLength: 1, maxLength: TIER_TEMPLATE_NAME_MAX_LENGTH }, description: { type: 'string', maxLength: TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH }, tiers: { type: 'object', additionalProperties: TIER_SPEC_SCHEMA } },
        },
        outputSchema: { type: 'object', required: ['template', 'templates'], additionalProperties: false, properties: { template: TEMPLATE_SCHEMA, templates: { type: 'array', items: TEMPLATE_SCHEMA } } },
        handler: (input: { id: string; name: string; description?: string; tiers?: Record<string, ModelTierSpec> }) =>
          enqueueWrite(async () => {
            const id = assertTemplateId(input.id)
            const meta = normalizeTemplateMeta({ name: input.name, description: input.description })
            const cur = readState()
            assertTemplateCapacity(cur.templates, id)
            const sourceTiers = input.tiers !== undefined ? normalizeTiersRecord(input.tiers) : { ...cur.tiers }
            if (Object.keys(sourceTiers).length === 0) {
              throw new HelmxError('validation_error', 'Cannot save an empty tier template: configure at least one tier first or pass tiers explicitly', 400)
            }
            const template: TierTemplate = { id, ...meta, tiers: sourceTiers, updatedAt: Date.now() }
            const nextTemplates = { ...cur.templates, [id]: template }
            const activeTemplate = input.tiers === undefined ? id : cur.activeTemplate
            await persist({ tiers: cur.tiers, templates: nextTemplates, ...(activeTemplate ? { activeTemplate } : {}) }, false)
            return { template, templates: sortTemplates(nextTemplates) }
          }),
      })

      ctx.action({
        id: 'apply_template',
        description: 'Switch the active model tiers roster to a saved preset template in one step',
        exposeToPrompt: false,
        cli: { command: ['tiers', 'apply-template'] },
        inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID_PROP, force: { type: 'boolean' } } },
        outputSchema: LIST_OUTPUT_SCHEMA,
        handler: (input: { id: string; force?: boolean }) =>
          enqueueWrite(async () => {
            const id = assertTemplateId(input.id)
            const tpl = readState().templates[id]
            if (!tpl) throw new HelmxError('tier_template_not_found', `Tier template '${id}' does not exist`, 404, { id })
            return applyRoster(normalizeTiersRecord(tpl.tiers), { force: input.force, activeTemplate: id })
          }),
      })

      ctx.action({
        id: 'delete_template',
        description: 'Delete a saved tier preset template (does not affect currently active tiers)',
        exposeToPrompt: false,
        cli: { command: ['tiers', 'delete-template'] },
        inputSchema: { type: 'object', required: ['id'], additionalProperties: false, properties: { id: ID_PROP } },
        outputSchema: { type: 'object', required: ['deleted', 'templates'], additionalProperties: false, properties: { deleted: { type: 'string' }, templates: { type: 'array', items: TEMPLATE_SCHEMA } } },
        handler: (input: { id: string }) =>
          enqueueWrite(async () => {
            const id = assertTemplateId(input.id)
            const cur = readState()
            if (!Object.hasOwn(cur.templates, id)) throw new HelmxError('tier_template_not_found', `Tier template '${id}' does not exist`, 404, { id })
            const nextTemplates = { ...cur.templates }
            delete nextTemplates[id]
            await persist({ tiers: cur.tiers, templates: nextTemplates, ...(cur.activeTemplate && cur.activeTemplate !== id ? { activeTemplate: cur.activeTemplate } : {}) }, false)
            return { deleted: id, templates: sortTemplates(nextTemplates) }
          }),
      })

      const label = { en: 'Model Tiers', 'zh-CN': '模型档位' }
      ctx.ui.sidebarItem({ id: 'tiers-manager', label, icon: 'layers', target: `screen:${TIERS_PLUGIN_ID}/${TIERS_SCREEN_ID}`, order: 16 })
      ctx.ui.screen({ id: TIERS_SCREEN_ID, label, icon: 'layers', client: { module: 'manager.tsx', export: 'TiersManagerScreen' } })
      ctx.ui.settingsPanel({ id: 'tiers-settings', label, order: 26, client: { module: 'settings.tsx', export: 'TiersSettingsPanel' } })
    },
  }
}
