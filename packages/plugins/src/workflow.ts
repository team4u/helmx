/**
 * builtin:workflow — Deterministic multi-agent orchestration & subagent plugin.
 *
 * Layered internal architecture (zero static dependency on sibling builtin:worktree):
 * - ./workflow/dsl/    — Pure JS DSL runtime, metadata extractor, canonical JSONL journal & worker
 * - ./workflow/runs/   — KV RunHeader + lazy RunDetail repository, RunCoordinator, StartupRecovery, library
 * - ./workflow/{config,depth,projection,background,steer,hooks,tools,actions,ui,assets}.ts — Plugin adapters
 * - ./workflow/client/ — React UI surfaces (timelineRenderer / toolView / slot / workbenchPanel / screen)
 */
import {
  HELMX_SEARCH_CAPABILITY_ID,
  type DispatchToolsCapability,
  type PluginDefinition,
  type PluginSearchItem,
  type PluginSearchProvider,
} from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import { compactOneLine, rankSearchCandidates } from './search-utils.js'
import {
  CONVERSATION_DEPTH_CAPABILITY_ID,
  WORKFLOW_PLUGIN_ID,
  WORKFLOW_RUNS_DOC,
  WORKFLOW_RUN_BADGES_DOC,
  WORKFLOW_SKILL_ID,
  type ConversationDepthCapability,
  type SavedWorkflowSummary,
  type WorkflowRunSessionDocState,
} from './contracts.js'
import { WORKFLOW_STEER_TOOL_NAME, registerWorkflowActions } from './workflow/actions.js'
import { readWorkflowSkillAsset } from './workflow/assets.js'
import { createBackgroundPolicy, createBackgroundReporter } from './workflow/background.js'
import {
  isEffectiveAutoRecover,
  readAutoRecoverOnRestart,
  readMaxConcurrentAgents,
  readMaxSubagentDepth,
  registerWorkflowConfigSchema,
} from './workflow/config.js'
import { createManagedSubagentRegistry, type ManagedSubagentEntry } from './workflow/depth.js'
import { registerWorkflowHooks } from './workflow/hooks.js'
import { createRunsProjection, type WorkflowLocalizedBadgesDocState } from './workflow/projection.js'
import {
  createWorkflowEngineHost,
  WorkflowService,
  type RunHeader,
} from './workflow/runs/index.js'
import { registerWorkflowTools } from './workflow/tools.js'
import { registerWorkflowUi } from './workflow/ui.js'

export { WORKFLOW_PLUGIN_ID, WORKFLOW_SKILL_ID }

export function createWorkflowPlugin(): PluginDefinition {
  return {
    id: WORKFLOW_PLUGIN_ID,
    name: { en: 'Workflows & Subagents', 'zh-CN': '工作流与子代理' },
    description: {
      en: 'Deterministic multi-agent orchestration: subagent / SubagentWorkflow tools, run records and the task panel (managed Git worktrees live in builtin:worktree).',
      'zh-CN': '确定性多智能体编排：subagent / SubagentWorkflow 工具、运行记录与任务面板（受管 Git 工作树由 builtin:worktree 提供）。',
    },
    icon: 'workflow',
    version: '0.1.0',
    ...resolvePluginClientAssets(WORKFLOW_PLUGIN_ID, 'workflow', 'workflow_plugin_client_missing'),
    definePlugin(ctx) {
      // Transient in-memory UI projections (zero SQLite write amplification).
      const runsDoc = ctx.sessionDoc<WorkflowRunSessionDocState>(
        WORKFLOW_RUNS_DOC,
        { runs: [] },
        { public: true, durable: false },
      )
      const badgesDoc = ctx.doc<WorkflowLocalizedBadgesDocState>(
        WORKFLOW_RUN_BADGES_DOC,
        { byConversation: {} },
        { public: true, durable: false },
      )

      // Durable per-key KV namespaces (O(1) SQLite row UPSERT, auto-redacted).
      const runsKv = ctx.kv<RunHeader>('runs')
      const depthKv = ctx.kv<ManagedSubagentEntry>('depth')

      // Validate config at definition time (fail fast, never run sick).
      registerWorkflowConfigSchema(ctx)
      readMaxConcurrentAgents(ctx)
      readMaxSubagentDepth(ctx)
      readAutoRecoverOnRestart(ctx)

      const registry = createManagedSubagentRegistry({
        kv: depthKv,
        configuredMaxSubagentDepth: () => readMaxSubagentDepth(ctx),
        externalDepthSources: () => ctx.consume<ConversationDepthCapability>(CONVERSATION_DEPTH_CAPABILITY_ID),
      })

      const backgroundPolicy = createBackgroundPolicy({
        getConversationOwnership: (id) => ctx.host.getConversationOwnership(id),
      })
      const backgroundReporter = createBackgroundReporter({
        getConversation: (id) => ctx.host.getConversation(id),
        emitEvent: (type, payload) => ctx.host.emitEvent(type, payload),
        submitInput: (conversationId, text, opts) => ctx.host.submitInput(conversationId, text, opts),
        isConversationCancelling: (id) => workflows.isConversationCancelling(id),
        listActiveRuns: () => workflows.listActiveRuns(),
      })

      const projection = createRunsProjection({
        runsDoc,
        badgesDoc,
        listRuns: () => workflows.listRuns(),
        listConversations: () => ctx.host.listConversations(),
      })

      const workflows = new WorkflowService({
        dataDir: ctx.dataDir,
        kv: runsKv,
        concurrency: readMaxConcurrentAgents(ctx),
        autoRecoverOnRestart: () => isEffectiveAutoRecover(ctx),
        deferReconcile: true,
        redact: (text) => ctx.host.redact(text),
        onTakeoverUpdated: (prior) => projection.upsertRun(prior),
        host: createWorkflowEngineHost({
          host: {
            spawnAgent: (request) => ctx.host.spawnAgent(request),
            invokeAction: (pluginId, actionId, input, invokeContext) =>
              ctx.host.invokeAction(pluginId, actionId, input, invokeContext),
            prepareAction: (pluginId, actionId, input, prepareContext) =>
              ctx.host.prepareAction(pluginId, actionId, input, prepareContext),
            execEnv: (req, opts) => ctx.host.execEnv(req, opts),
            listActions: () => ctx.host.listActions(),
            getConversation: (id) => ctx.host.getConversation(id),
            getConversationOwnership: (id) => ctx.host.getConversationOwnership(id),
            abortConversationGuarded: (id, guard) => ctx.host.abortConversationGuarded(id, guard),
            emitEvent(type: string, payload: unknown, options?: { broadcast?: boolean }) {
              return ctx.host.emitEvent(type, payload, options)
            },
            runGate: (command, options) => ctx.host.runGate(command, options),
            get isClosing() {
              return ctx.host.isClosing
            },
          },
          projection,
          deliverBackgroundReport: (run, info) => backgroundReporter.deliver(run, info),
        }),
      })

      registerWorkflowHooks(ctx, { registry, workflows, projection })

      ctx.service({
        id: 'workflow-engine',
        async prepare() {
          await workflows.prepareRecovery()
        },
        async start() {
          await ctx.host.skills.ensureSkill(readWorkflowSkillAsset())
          await workflows.init()
          projection.sync()
        },
        async reconcile() {
          await workflows.reconcile()
        },
        async stop() {
          projection.beginStopping()
          if (ctx.host.isClosing && isEffectiveAutoRecover(ctx)) {
            await workflows.suspend()
          } else {
            await workflows.close()
          }
          await runsKv.flush()
          await depthKv.flush()
        },
        liveTasks() {
          return workflows
            .listActiveRuns()
            .filter((r) => r.status === 'running')
            .map((r) => `workflow:${r.id}`)
        },
      })

      registerWorkflowTools(ctx, {
        workflows,
        assertCanSpawn: (conversationId) => registry.assertCanSpawn(conversationId),
        resolveBackground: (conversationId, explicit) => backgroundPolicy.resolveBackground(conversationId, explicit),
      })
      ctx.provide<DispatchToolsCapability>('helmx.dispatch-tools', {
        toolNames: ['subagent', 'SubagentWorkflow'],
        orchestrationTools: [WORKFLOW_STEER_TOOL_NAME],
      })

      ctx.provide<PluginSearchProvider>(HELMX_SEARCH_CAPABILITY_ID, {
        search(input, signal) {
          if (signal.aborted) return []
          const saved = workflows.list()
          return rankSearchCandidates<SavedWorkflowSummary, PluginSearchItem>({
            query: input.query,
            limit: input.limit,
            signal,
            items: saved,
            fields: (wf) => {
              const description =
                wf.description !== undefined ? compactOneLine(ctx.host.redact(wf.description)) : undefined
              const whenToUse =
                wf.whenToUse !== undefined ? compactOneLine(ctx.host.redact(wf.whenToUse)) : undefined
              const phaseTitles = wf.phases?.map((phase) => ctx.host.redact(phase.title)) ?? []
              return {
                primary: [wf.name],
                secondary: [description, whenToUse, ...phaseTitles],
                keywords: ['workflow', 'workflows', 'library', 'template', 'subagent', '工作流', '工作流库', '模板'],
              }
            },
            tieBreaker: (wf) => wf.name,
            toResult: (wf, score) => {
              const description =
                wf.description !== undefined ? compactOneLine(ctx.host.redact(wf.description)) : undefined
              const whenToUse =
                wf.whenToUse !== undefined ? compactOneLine(ctx.host.redact(wf.whenToUse)) : undefined
              const phaseTitles = wf.phases?.map((phase) => ctx.host.redact(phase.title)) ?? []
              const subtitle =
                description ??
                whenToUse ??
                (phaseTitles.length > 0 ? compactOneLine(phaseTitles.join(' -> ')) : undefined)
              const badge =
                wf.metadataError !== undefined
                  ? { en: 'Metadata issue', 'zh-CN': '元数据异常' }
                  : wf.phases !== undefined && wf.phases.length > 0
                    ? { en: `${wf.phases.length} phases`, 'zh-CN': `${wf.phases.length} 阶段` }
                    : undefined
              return {
                id: `workflow:${wf.name}`,
                kind: 'resource',
                title: wf.name,
                ...(subtitle !== undefined ? { subtitle } : {}),
                breadcrumb: [{ en: 'Workflow Library', 'zh-CN': '工作流库' }],
                icon: 'workflow',
                ...(badge !== undefined ? { badge } : {}),
                target: `screen:${WORKFLOW_PLUGIN_ID}/library?wf=${encodeURIComponent(wf.name)}`,
                score,
              }
            },
          })
        },
      })

      registerWorkflowActions(ctx, {
        workflows,
        assertCanSpawn: (conversationId) => registry.assertCanSpawn(conversationId),
      })

      registerWorkflowUi(ctx)
    },
  }
}
