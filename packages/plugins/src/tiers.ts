/** builtin:tiers: semantic model tiers (`tier/<id>`), preset templates, one-turn model borrow, and `switch_model` relay. */
import {
  COMPOSER_STATUS_SLOT,
  COMPOSER_TOOLBAR_SLOT,
  HelmxError,
  MODEL_TIER_DESCRIPTION_MAX_LENGTH,
  ORCHESTRATOR_TIER_MAX_STEPS_LIMIT,
  type ModelCatalog,
  type ModelTierKind,
  type ModelTiersCapability,
  type ModelTierSpec,
  type PluginDefinition,
} from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  asConversationEntryEvent,
  asDeletedConversationId,
  resolveTargetConversationId,
} from './shared-helpers.js'
import { readTiersSkillAsset } from './tiers/assets.js'
import {
  createTierBorrowManager,
  resolveBorrowTarget,
  toTierBorrowSessionView,
  type ClearBorrowResult,
  type ResolvedBorrowTarget,
  type SwitchModelToolInput,
} from './tiers/borrow.js'
import {
  createTierOrchestratorManager,
  type ExitPlanModeToolInput,
  type HandBackToPlannerToolInput,
} from './tiers/orchestrator.js'
import {
  MAX_TIERS_COUNT,
  MODEL_TIERS_SKILL_ID,
  ORCHESTRATOR_TRANSITION_META_SCHEMA,
  SWITCH_MODEL_META_SCHEMA,
  TIERS_BORROW_ELIGIBLE_SCOPE,
  TIERS_BORROW_KV,
  TIERS_BORROW_SESSION_DOC,
  TIERS_EXIT_PLAN_MODE_TOOL,
  TIERS_HAND_BACK_TOOL,
  TIERS_INPUT_META_KEY,
  TIERS_ORCHESTRATOR_KV,
  TIERS_ORCHESTRATOR_SESSION_DOC,
  TIERS_PLUGIN_ID,
  TIERS_SCREEN_ID,
  TIERS_STATE_DOC,
  TIERS_SWITCH_MODEL_TOOL,
  TIER_BORROW_SESSION_VIEW_SCHEMA,
  TIER_ORCHESTRATOR_SESSION_VIEW_SCHEMA,
  TIER_TEMPLATE_DESCRIPTION_MAX_LENGTH,
  TIER_TEMPLATE_NAME_MAX_LENGTH,
  TIER_THINKING_LEVELS,
  createEmptyTiersState,
  isTiersBorrowEligible,
  parseTiersBorrowInputMeta,
  type OrchestratorTransitionMeta,
  type ParsedTiersBorrowInputMeta,
  type SwitchModelPresentationMeta,
  type TierBorrowPhase,
  type TierBorrowRecord,
  type TierBorrowSessionView,
  type TierBorrowSource,
  type TierOrchestratorPhase,
  type TierOrchestratorRecord,
  type TierOrchestratorSessionView,
  type TierTemplate,
  type TierThinkingLevel,
  type TiersPluginConfig,
  type TiersStateDoc,
} from './tiers/contracts.js'
import {
  assertConcreteModelRef, assertRemovedTiersNotInUse, assertTemplateCapacity,
  assertTemplateId, assertTierId, assertTierSpecModelsNotDisabled, findTierReferences, normalizeTemplateMeta, normalizeTierSpec,
  normalizeTiersRecord, projectTierEntries, renderModelTiersCatalogSection, sanitizeStateDoc,
} from './tiers/validation.js'

export {
  TIERS_PLUGIN_ID,
  TIERS_STATE_DOC,
  TIERS_SCREEN_ID,
  MODEL_TIERS_SKILL_ID,
  TIER_THINKING_LEVELS,
  TIERS_BORROW_KV,
  TIERS_BORROW_SESSION_DOC,
  TIERS_SWITCH_MODEL_TOOL,
  TIERS_INPUT_META_KEY,
  TIERS_BORROW_ELIGIBLE_SCOPE,
  TIERS_ORCHESTRATOR_KV,
  TIERS_ORCHESTRATOR_SESSION_DOC,
  TIERS_EXIT_PLAN_MODE_TOOL,
  TIERS_HAND_BACK_TOOL,
  TIER_BORROW_SESSION_VIEW_SCHEMA,
  TIER_ORCHESTRATOR_SESSION_VIEW_SCHEMA,
  SWITCH_MODEL_META_SCHEMA,
  ORCHESTRATOR_TRANSITION_META_SCHEMA,
  isTiersBorrowEligible,
  parseTiersBorrowInputMeta,
  resolveBorrowTarget,
  toTierBorrowSessionView,
  type TierTemplate,
  type TiersStateDoc,
  type TiersPluginConfig,
  type TierThinkingLevel,
  type TierBorrowPhase,
  type TierBorrowSource,
  type TierBorrowRecord,
  type TierBorrowSessionView,
  type TierOrchestratorPhase,
  type TierOrchestratorRecord,
  type TierOrchestratorSessionView,
  type OrchestratorTransitionMeta,
  type SwitchModelPresentationMeta,
  type ParsedTiersBorrowInputMeta,
  type ResolvedBorrowTarget,
  type ClearBorrowResult,
}

const ID_PROP = { type: 'string', minLength: 1, maxLength: 63 } as const
const TIER_SPEC_SCHEMA = {
  type: 'object', required: ['model'], additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['single', 'orchestrator'] },
    model: { type: 'string', minLength: 1 },
    thinkingLevel: { type: 'string' },
    executorModel: { type: 'string', minLength: 1 },
    executorThinkingLevel: { type: 'string' },
    maxExecutionSteps: { type: 'integer', minimum: 0, maximum: ORCHESTRATOR_TIER_MAX_STEPS_LIMIT },
    description: { type: 'string', maxLength: MODEL_TIER_DESCRIPTION_MAX_LENGTH },
  },
} as const
const TIER_ENTRY_SCHEMA = {
  type: 'object', required: ['id', 'model', 'available'], additionalProperties: false,
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['single', 'orchestrator'] },
    model: { type: 'string' },
    thinkingLevel: { type: 'string' },
    executorModel: { type: 'string' },
    executorThinkingLevel: { type: 'string' },
    maxExecutionSteps: { type: 'integer' },
    description: { type: 'string' },
    available: { type: 'boolean' },
    disabled: { type: 'boolean' },
    thinkingLevels: { type: 'array', items: { type: 'string' } },
    executorThinkingLevels: { type: 'array', items: { type: 'string' } },
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
      const borrowKv = ctx.kv<TierBorrowRecord>(TIERS_BORROW_KV)
      const borrowDoc = ctx.sessionDoc<TierBorrowSessionView | null>(TIERS_BORROW_SESSION_DOC, null, {
        public: true,
        durable: false,
      })
      const orchestratorKv = ctx.kv<TierOrchestratorRecord>(TIERS_ORCHESTRATOR_KV)
      const orchestratorDoc = ctx.sessionDoc<TierOrchestratorSessionView | null>(TIERS_ORCHESTRATOR_SESSION_DOC, null, {
        public: true,
        durable: false,
      })
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
      const borrowManager = createTierBorrowManager({
        ctx,
        kv: borrowKv,
        borrowDoc,
        readTiersState: readState,
      })
      const orchestratorManager = createTierOrchestratorManager({
        ctx,
        kv: orchestratorKv,
        orchestratorDoc,
        readTiersState: readState,
      })
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
        for (const spec of Object.values(nextTiers)) assertTierSpecModelsNotDisabled(catalog, spec)
        assertRemovedTiersNotInUse(removed, catalog, profiles, opts.force)
        await persist({ tiers: nextTiers, templates: current.templates, ...(opts.activeTemplate ? { activeTemplate: opts.activeTemplate } : {}) })
        return buildListPayload(catalog)
      }

      ctx.service({
        id: 'tiers-runtime',
        prepare() {
          borrowManager.setStopping(false)
          orchestratorManager.setStopping(false)
        },
        async start() {
          borrowManager.setStopping(false)
          orchestratorManager.setStopping(false)
          cachedState = sanitizeStateDoc(stateDoc.get())
          await ctx.host.skills.ensureSkill(readTiersSkillAsset())
          borrowManager.hydrate()
          orchestratorManager.hydrate()
          if (Object.keys(readState().tiers).length > 0) await notifyTiersChanged()
        },
        async reconcile() {
          await borrowManager.reconcile()
          await orchestratorManager.reconcile()
        },
        async stop() {
          await borrowManager.stop()
          await orchestratorManager.stop()
          await writeChain
          cachedState = undefined
        },
        async inUse() {
          const borrowItems = borrowManager.inUseItems()
          const orchestratorItems = orchestratorManager.inUseItems()
          if (Object.keys(readState().tiers).length === 0) return [...borrowItems, ...orchestratorItems]
          const [catalog, profiles] = await Promise.all([ctx.host.listModels(), ctx.host.profiles.list()])
          return [...findTierReferences(catalog, profiles), ...borrowItems, ...orchestratorItems]
        },
      })

      ctx.hook.onInput((payload) => borrowManager.handleInput(payload), { priority: -180 })
      ctx.hook.onInput((payload) => orchestratorManager.handleInput(payload), { priority: -200 })

      ctx.hook.onBeforeTurn(async (turn) => {
        if (!autoInjectEnabled()) return { action: 'continue' }
        const state = readState()
        if (Object.keys(state.tiers).length === 0) return { action: 'continue' }
        if (orchestratorManager.isUnderOrchestratorTree(turn.conversation)) return { action: 'continue' }
        const text = renderModelTiersCatalogSection(projectTierEntries(state.tiers, await ctx.host.listModels()))
        return text ? { action: 'transform', value: { ...turn, sections: [...turn.sections, { id: 'tiers.catalog', text }] } } : { action: 'continue' }
      })

      // Run after builtin:plan (-50) so /plan retains precedence, and before profile (-100).
      ctx.hook.onBeforeTurn((turn) => orchestratorManager.handleBeforeTurn(turn), { priority: -60 })

      // Synchronous transform after workflow (300) and worktree (200) so builtin:tiers never holds liveTasks open.
      ctx.hook.onAgentSpawn((request) => orchestratorManager.handleAgentSpawn(request), { priority: 100 })

      ctx.hook.onTurnSettled(async (payload) => {
        await borrowManager.handleTurnSettled(payload.conversation.id)
        await orchestratorManager.handleTurnSettled(payload.conversation.id)
      })

      ctx.host.onEvent('conversation.upsert', async (payload) => {
        await orchestratorManager.handleConversationUpsert(payload)
      })

      ctx.host.onEvent('conversation.deleted', async (payload) => {
        const conversationId = asDeletedConversationId(payload)
        if (conversationId !== undefined) {
          await orchestratorManager.handleConversationDeleted(conversationId)
          await borrowManager.handleConversationDeleted(conversationId)
        }
      })

      ctx.host.onEvent('conversation.entry', async (payload) => {
        const entry = asConversationEntryEvent(payload)
        if (entry !== undefined && entry.kind === 'pi.reset') {
          await orchestratorManager.handleConversationReset(entry.conversationId)
          await borrowManager.handleConversationReset(entry.conversationId)
        }
      })

      ctx.tool<ExitPlanModeToolInput>({
        name: TIERS_EXIT_PLAN_MODE_TOOL,
        description:
          'Finish planning in an orchestrator tier session and switch this conversation in place to the Executor model with workspace write access.',
        promptGuidelines: [
          'In an orchestrator tier Planning Phase, call exit_plan_mode({ plan }) once you are ready to implement code changes so control transfers to the Executor model.',
        ],
        scope: TIERS_BORROW_ELIGIBLE_SCOPE,
        inputSchema: {
          type: 'object',
          required: ['plan'],
          additionalProperties: false,
          properties: {
            plan: {
              type: 'string',
              minLength: 1,
              description: 'Concrete implementation plan (exact file paths, symbols, steps, and verification commands)',
            },
          },
        },
        presentationMetaSchema: ORCHESTRATOR_TRANSITION_META_SCHEMA,
        execute: (input, context) => orchestratorManager.executeExitPlanModeTool(input, context),
      })

      ctx.tool<HandBackToPlannerToolInput>({
        name: TIERS_HAND_BACK_TOOL,
        description:
          'Return control from the Executor model back to the Planner model inside an orchestrator tier session for replanning or final review.',
        promptGuidelines: [
          'In an orchestrator tier Execution Phase, call hand_back_to_planner({ reason, summary }) when blocked, discovering a design flaw, needing architectural arbitration, or reaching the execution step budget.',
        ],
        scope: TIERS_BORROW_ELIGIBLE_SCOPE,
        inputSchema: {
          type: 'object',
          required: ['reason', 'summary'],
          additionalProperties: false,
          properties: {
            reason: { type: 'string', minLength: 1, description: 'Concise reason for returning to the planner' },
            summary: { type: 'string', minLength: 1, description: 'Summary of edits completed, verification outputs, and open issues' },
          },
        },
        presentationMetaSchema: ORCHESTRATOR_TRANSITION_META_SCHEMA,
        execute: (input, context) => orchestratorManager.executeHandBackTool(input, context),
      })

      ctx.tool<SwitchModelToolInput>({
        name: TIERS_SWITCH_MODEL_TOOL,
        description:
          'Switch the current top-level conversation to another model tier (tier/<id> or <tierId>) or concrete model (provider/modelId or unique modelId) for the next reasoning step. By default (restoreAfterTurn: true), the original model restores automatically after this turn settles.',
        promptGuidelines: [
          'Use switch_model in a top-level conversation when you want to hand off the next reasoning step in the SAME thread to a stronger or specialized model while keeping full context; default restoreAfterTurn=true restores the original model automatically after the turn, so do not call switch_model a second time to restore.',
        ],
        scope: TIERS_BORROW_ELIGIBLE_SCOPE,
        inputSchema: {
          type: 'object',
          required: ['model'],
          additionalProperties: false,
          properties: {
            model: {
              type: 'string',
              minLength: 1,
              description:
                'Target model tier (tier/<id> or <tierId>) or concrete model (provider/modelId or unique modelId).',
            },
            effort: {
              type: 'string',
              enum: [...TIER_THINKING_LEVELS],
              description: 'Optional thinking/reasoning level override for the switched model.',
            },
            restoreAfterTurn: {
              type: 'boolean',
              description:
                'Automatically restore the original model after this turn finishes (default true). Pass false to switch permanently.',
            },
          },
        },
        presentationMetaSchema: SWITCH_MODEL_META_SCHEMA,
        execute: (input, context) => borrowManager.executeSwitchModelTool(input, context),
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
        description: 'Create or update one model tier binding (tier/<id> -> concrete single model or dual-phase planner/executor pair)',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object', required: ['id', 'model'], additionalProperties: false,
          properties: {
            id: ID_PROP,
            kind: { type: 'string', enum: ['single', 'orchestrator'] },
            model: { type: 'string', minLength: 1 },
            thinkingLevel: { type: 'string', enum: ['', ...TIER_THINKING_LEVELS] },
            executorModel: { type: 'string', minLength: 1 },
            executorThinkingLevel: { type: 'string', enum: ['', ...TIER_THINKING_LEVELS] },
            maxExecutionSteps: { type: 'integer', minimum: 0, maximum: ORCHESTRATOR_TIER_MAX_STEPS_LIMIT },
            description: { type: 'string', maxLength: MODEL_TIER_DESCRIPTION_MAX_LENGTH },
          },
        },
        outputSchema: { type: 'object', required: ['tier', 'tiers'], additionalProperties: false, properties: { tier: TIER_ENTRY_SCHEMA, tiers: { type: 'array', items: TIER_ENTRY_SCHEMA } } },
        handler: (input: {
          id: string
          kind?: ModelTierKind
          model: string
          thinkingLevel?: string
          executorModel?: string
          executorThinkingLevel?: string
          maxExecutionSteps?: number
          description?: string
        }) =>
          enqueueWrite(async () => {
            const id = assertTierId(input.id)
            const spec = normalizeTierSpec({
              ...(input.kind !== undefined ? { kind: input.kind } : {}),
              model: assertConcreteModelRef(input.model),
              ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
              ...(input.executorModel !== undefined ? { executorModel: input.executorModel } : {}),
              ...(input.executorThinkingLevel !== undefined ? { executorThinkingLevel: input.executorThinkingLevel } : {}),
              ...(input.maxExecutionSteps !== undefined ? { maxExecutionSteps: input.maxExecutionSteps } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
            }, id)
            const catalog = await ctx.host.listModels()
            assertTierSpecModelsNotDisabled(catalog, spec)
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

      const conversationIdProp = {
        type: 'integer',
        minimum: 1,
        description: 'Target conversation ID (defaults to current conversation context)',
      } as const

      ctx.action<{ conversationId?: number }, TierBorrowSessionView | null>({
        id: 'get_borrow',
        description: 'Read current armed or active one-turn model borrow state for a conversation (--conversation-id or --current)',
        exposeToPrompt: false,
        idempotent: true,
        cli: { command: ['tiers', 'get-borrow'] },
        inputSchema: {
          type: 'object',
          properties: { conversationId: conversationIdProp },
          additionalProperties: false,
        },
        outputSchema: { anyOf: [TIER_BORROW_SESSION_VIEW_SCHEMA, { type: 'null' }] },
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          return borrowManager.getBorrow(targetId)
        },
      })

      ctx.action<{ conversationId?: number; model: string; effort?: string }, TierBorrowSessionView>({
        id: 'set_borrow',
        description: 'Arm a one-turn model borrow for the next message in a top-level human conversation (--conversation-id or --current)',
        exposeToPrompt: false,
        cli: { command: ['tiers', 'set-borrow'] },
        inputSchema: {
          type: 'object',
          required: ['model'],
          additionalProperties: false,
          properties: {
            conversationId: conversationIdProp,
            model: {
              type: 'string',
              minLength: 1,
              description: 'Target tier (tier/<id> or <tierId>) or concrete model (provider/modelId or unique modelId)',
            },
            effort: {
              type: 'string',
              description: 'Optional thinking/reasoning level override',
            },
          },
        },
        outputSchema: TIER_BORROW_SESSION_VIEW_SCHEMA,
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          return borrowManager.setBorrow(targetId, {
            model: input.model,
            ...(input.effort !== undefined ? { effort: input.effort } : {}),
            source: 'ui',
          })
        },
      })

      ctx.action<{ conversationId?: number }, ClearBorrowResult>({
        id: 'clear_borrow',
        description: 'Cancel an armed one-turn model borrow or disable auto-restore on an active borrow (--conversation-id or --current)',
        exposeToPrompt: false,
        cli: { command: ['tiers', 'clear-borrow'] },
        inputSchema: {
          type: 'object',
          properties: { conversationId: conversationIdProp },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          required: ['cleared'],
          additionalProperties: false,
          properties: {
            cleared: { type: 'boolean' },
            previousPhase: { type: 'string', enum: ['armed', 'active'] },
          },
        },
        handler(input, context) {
          const targetId = resolveTargetConversationId(input.conversationId, context)
          return borrowManager.clearBorrow(targetId)
        },
      })

      const label = { en: 'Model Tiers', 'zh-CN': '模型档位' }
      ctx.ui.sidebarItem({ id: 'tiers-manager', label, icon: 'layers', target: `screen:${TIERS_PLUGIN_ID}/${TIERS_SCREEN_ID}`, order: 16 })
      ctx.ui.screen({ id: TIERS_SCREEN_ID, label, icon: 'layers', client: { module: 'manager.tsx', export: 'TiersManagerScreen' } })
      ctx.ui.settingsPanel({ id: 'tiers-settings', label, order: 26, client: { module: 'settings.tsx', export: 'TiersSettingsPanel' } })
      ctx.ui.slot({
        id: 'tiers-orchestrator-status',
        target: COMPOSER_STATUS_SLOT,
        order: 5,
        client: { module: 'OrchestratorStatusBadge.tsx', export: 'OrchestratorStatusBadge' },
      })
      ctx.ui.slot({
        id: 'tiers-borrow-toolbar-pill',
        target: COMPOSER_TOOLBAR_SLOT,
        order: 15,
        client: { module: 'BorrowToolbarPill.tsx', export: 'BorrowToolbarPill' },
      })
      ctx.ui.toolView({
        id: 'tiers-switch-model-row',
        toolNames: [TIERS_SWITCH_MODEL_TOOL],
        replaceRow: true,
        client: { module: 'SwitchModelToolRow.tsx', export: 'SwitchModelToolRow' },
      })
      ctx.ui.toolView({
        id: 'tiers-orchestrator-row',
        toolNames: [TIERS_EXIT_PLAN_MODE_TOOL, TIERS_HAND_BACK_TOOL],
        replaceRow: true,
        client: { module: 'OrchestratorToolRow.tsx', export: 'OrchestratorToolRow' },
      })
    },
  }
}
