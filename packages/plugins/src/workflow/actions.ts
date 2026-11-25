/**
 * builtin:workflow 10 个统一动作注册（五端复用：HTTP / CLI / run_action / Workflow / Web UI）：
 * - 工作流库：list / get / save / delete
 * - 运行观测与控制：runs / inspect / abort / run / steer / resume_failed
 */
import { HelmxError, type HelmxPluginContext } from '@helmx/protocol'
import type { WorkflowService } from './runs/index.js'
import { steerBackgroundSubagent } from './steer.js'

export const WORKFLOW_STEER_TOOL_NAME = 'workflow_steer' as const

export interface WorkflowActionDeps {
  workflows: WorkflowService
  assertCanSpawn(conversationId: number): void
  syncRunsDoc?: () => void
}

function assertConversationIdConsistent(
  inputConvId: number | undefined,
  contextConvId: number | undefined,
): void {
  if (inputConvId !== undefined && contextConvId !== undefined && inputConvId !== contextConvId) {
    throw new HelmxError(
      'validation_error',
      `conversationId 冲突：输入指定 ${String(inputConvId)} 与调用上下文 ${contextConvId} 不一致，请显式统一`,
      400,
      { inputConversationId: inputConvId, contextConversationId: contextConvId },
    )
  }
}

export function registerWorkflowActions(ctx: HelmxPluginContext, deps: WorkflowActionDeps): void {
  const { workflows, assertCanSpawn, syncRunsDoc } = deps

  ctx.action({
    id: 'list',
    description: 'List saved workflow definitions',
    exposeToPrompt: false,
    idempotent: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { workflows: { type: 'array', items: { type: 'object' } } },
      required: ['workflows'],
      additionalProperties: false,
    },
    cli: { command: ['workflows', 'list'], description: 'List saved workflow definitions' },
    async handler() {
      return { workflows: workflows.list() }
    },
  })

  ctx.action({
    id: 'get',
    description: 'Read the full definition of a saved workflow (read-only source and metadata; Web/AI are read-only, no editing)',
    exposeToPrompt: false,
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Saved workflow name' } },
      required: ['name'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { workflow: { type: 'object' } },
      required: ['workflow'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'get'],
      description: 'Read a saved workflow definition (read-only source and metadata)',
      positional: [{ field: 'name', required: true }],
    },
    async handler(input) {
      const { name } = input as { name: string }
      try {
        return { workflow: workflows.get(name) }
      } catch (error) {
        if (error instanceof HelmxError && error.code === 'not_found') {
          throw new HelmxError('not_found', `工作流 ${name} 不存在`, 404, { name })
        }
        throw error
      }
    },
  })

  ctx.action({
    id: 'save',
    description: 'Save a workflow definition as a cross-conversation asset from script source (the default name comes from meta.name; overwriting is refused unless overwrite: true)',
    exposeToPrompt: false,
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', minLength: 1, description: 'Full script source' },
        name: { type: 'string', description: 'Save name (optional; defaults to meta.name; rejected when it disagrees with meta.name)' },
        overwrite: { type: 'boolean', description: 'Overwrite a definition with the same name (refused by default)' },
      },
      required: ['script'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        created: { type: 'boolean' },
        workflow: { type: 'object' },
      },
      required: ['created', 'workflow'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'save'],
      description: 'Save a workflow definition (positional is a local script file or target name)',
      positional: [{ field: 'name', readFileInto: 'script' }],
    },
    async handler(input) {
      const a = input as Record<string, unknown>
      return workflows.save({
        script: String(a['script']),
        ...(a['name'] !== undefined ? { name: String(a['name']) } : {}),
        ...(a['overwrite'] !== undefined ? { overwrite: a['overwrite'] === true } : {}),
      })
    },
  })

  ctx.action({
    id: 'delete',
    description: 'Delete a saved workflow definition file (historical run records are unaffected)',
    exposeToPrompt: false,
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Saved workflow name' } },
      required: ['name'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        deleted: { type: 'boolean', const: true },
        name: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['deleted', 'name', 'path'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'delete'],
      description: 'Delete a saved workflow definition file (historical run records are unaffected)',
      positional: [{ field: 'name', required: true }],
    },
    async handler(input) {
      const { name } = input as { name: string }
      return workflows.delete(name)
    },
  })

  ctx.action({
    id: 'runs',
    description: 'List workflow run records',
    exposeToPrompt: false,
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'integer', minimum: 1, description: 'Filter by conversation' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { runs: { type: 'array', items: { type: 'object' } } },
      required: ['runs'],
      additionalProperties: false,
    },
    cli: { command: ['workflows', 'runs'], description: 'List workflow run records' },
    async handler(input, context) {
      const { conversationId } = input as { conversationId?: number }
      assertConversationIdConsistent(conversationId, context.conversationId)
      const filter = conversationId ?? context.conversationId
      const runs = workflows.listRuns()
      return { runs: filter !== undefined ? runs.filter((r) => r.conversationId === filter) : runs }
    },
  })

  ctx.action({
    id: 'inspect',
    description: 'Inspect a single workflow run',
    exposeToPrompt: false,
    idempotent: true,
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run ID' } },
      required: ['runId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { run: { type: 'object' } },
      required: ['run'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'inspect'],
      description: 'Inspect a single workflow run',
      positional: [{ field: 'runId', required: true }],
    },
    async handler(input) {
      const { runId } = input as { runId: string }
      try {
        return { run: workflows.getRun(runId) }
      } catch (error) {
        if (error instanceof HelmxError && error.code === 'not_found') {
          throw new HelmxError('not_found', `工作流运行不存在: ${runId}`, 404, { runId })
        }
        throw error
      }
    },
  })

  ctx.action({
    id: 'abort',
    description: 'Abort a workflow run',
    exposeToPrompt: false,
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run ID' } },
      required: ['runId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { run: { type: 'object' } },
      required: ['run'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'abort'],
      description: 'Abort a workflow run',
      positional: [{ field: 'runId', required: true }],
    },
    async handler(input) {
      const { runId } = input as { runId: string }
      await workflows.abort(runId)
      syncRunsDoc?.()
      return { run: workflows.getRun(runId) }
    },
  })

  ctx.action({
    id: 'run',
    description: 'Start a workflow run in the specified or current conversation; the CLI passes the current conversation via --current',
    exposeToPrompt: false,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Saved workflow name (exactly one of name / script / scriptPath)' },
        script: { type: 'string', description: 'Orchestration script source (inline)' },
        scriptPath: { type: 'string', description: 'Absolute path of the orchestration script file' },
        label: { type: 'string', minLength: 1, description: 'Optional display label for this run (overrides meta.name / scriptPath basename)' },
        args: { description: 'Arbitrary JSON args passed to the script as-is' },
        resumeFromRunId: { type: 'string', description: 'Existing runId to resume either a DSL workflow run from its last checkpoint or a failed/aborted background subagent run' },
        conversationId: { type: 'integer', minimum: 1, description: 'Target conversation; a new run must specify one, the CLI can use --current' },
        wait: { type: 'boolean', description: 'Wait for the terminal state and return the latest run (failed/aborted throw)' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { run: { type: 'object' } },
      required: ['run'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'run'],
      description: 'Start a workflow run in the specified or current conversation (CLI uses --current)',
      positional: [{ field: 'name', readFileInto: 'script' }],
      timeoutMs: 0,
    },
    async handler(input, context) {
      const { wait, ...request } = input as { wait?: boolean; conversationId?: number; label?: string } & Record<string, unknown>
      if (request.label !== undefined && (typeof request.label !== 'string' || request.label.trim() === '')) {
        throw new HelmxError('validation_error', 'label 必须为非空字符串', 400, { label: request.label })
      }
      assertConversationIdConsistent(request.conversationId, context.conversationId)
      if (request.conversationId === undefined && context.conversationId !== undefined) {
        request.conversationId = context.conversationId
      }
      const depthTarget = typeof request.conversationId === 'number' ? request.conversationId : context.conversationId
      if (depthTarget !== undefined) assertCanSpawn(depthTarget)
      const started = await workflows.run(request)
      syncRunsDoc?.()
      if (wait === true) {
        await workflows.wait(started.id)
        const terminal = workflows.getRun(started.id)
        if (terminal.status === 'failed' || terminal.status === 'aborted') {
          throw new HelmxError(
            `workflow_${terminal.status}`,
            terminal.error ?? `工作流运行 ${started.id} 终态为 ${terminal.status}`,
            500,
            { runId: started.id, status: terminal.status },
          )
        }
        return { run: terminal }
      }
      return { run: started }
    },
  })

  ctx.action({
    id: 'steer',
    description:
      'Add mid-run guidance to a running background subagent: native sub-conversations go through the kernel guarded port with atomic ownership and CAS watermark rechecks. Only runs with kind=subagent and status=running are supported; DSL workflows and human ownership are rejected. Within a conversation only the initiating conversation itself or its ancestors may steer. steered=true only means delivery succeeded, not that the guidance was executed; timeouts and disconnects are not retried automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Background subagent run ID (the runId returned by the subagent tool with background:true)' },
        text: { type: 'string', description: 'Guidance text to inject (non-empty; delivered verbatim into the target execution with a run-source prefix)' },
      },
      required: ['runId', 'text'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        steered: { type: 'boolean', const: true },
        runId: { type: 'string' },
        targetKind: { type: 'string', const: 'native' },
        conversationId: { type: 'number', description: 'Steered native sub-conversation ID' },
        ownership: { type: 'string', const: 'helmx' },
        stateChangeSeq: { type: 'number', description: 'Authoritative watermark that passed the recheck at commit' },
        guardLevel: { type: 'string', const: 'cas', description: 'Guard level (kernel CAS recheck)' },
      },
      required: ['steered', 'runId', 'targetKind', 'conversationId', 'ownership', 'stateChangeSeq', 'guardLevel'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'steer'],
      description: 'Steer a running background subagent back on course',
      positional: [{ field: 'runId', required: true }],
    },
    exposeAsTool: { name: WORKFLOW_STEER_TOOL_NAME },
    async handler(input, context) {
      const { runId, text } = input as { runId: string; text: string }
      return steerBackgroundSubagent(
        {
          getRun: (id) => workflows.getRun(id),
          isConversationCancelling: (id) => workflows.isConversationCancelling(id),
          getConversation: (id) => ctx.host.getConversation(id),
          getConversationOwnership: (id) => ctx.host.getConversationOwnership(id),
          submitInputGuarded: (id, prompt, opts, guard) =>
            ctx.host.submitInputGuarded(id, prompt, opts, guard),
        },
        { runId, text },
        {
          ...(context.conversationId !== undefined ? { conversationId: context.conversationId } : {}),
          ...(context.signal !== undefined ? { signal: context.signal } : {}),
        },
      )
    },
  })

  ctx.action({
    id: 'resume_failed',
    description:
      'Batch resume recoverable failed workflows and background subagents for a conversation or across all conversations; non-recoverable items (non-failed, missing handle/spec, workflow_action_uncertain, crash_recovery_limit, or already superseded by resumedByRunId) are recorded in skipped without fabricating recovery.',
    exposeToPrompt: false,
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'integer',
          minimum: 1,
          description: 'Target conversation ID (CLI supports --current auto-injection; mutually exclusive with all)',
        },
        all: {
          type: 'boolean',
          description: 'Scan recoverable failed tasks across all conversations (mutually exclusive with conversationId)',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        resumed: { type: 'array', items: { type: 'object' } },
        skipped: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              runId: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['runId', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['resumed', 'skipped'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'resume-failed'],
      description: 'Batch resume recoverable failed workflows and background subagents for a conversation or globally',
    },
    async handler(input, context) {
      const { conversationId: requestedConvId, all } = input as {
        conversationId?: number
        all?: boolean
      }
      if (requestedConvId !== undefined && (!Number.isInteger(requestedConvId) || requestedConvId < 1)) {
        throw new HelmxError('validation_error', `conversationId 必须是正整数（收到 ${String(requestedConvId)}）`, 400, {
          conversationId: requestedConvId,
        })
      }
      if (all !== undefined && typeof all !== 'boolean') {
        throw new HelmxError('validation_error', `all 必须为 boolean（收到 ${String(all)}）`, 400, { all })
      }
      if (requestedConvId !== undefined && all === true) {
        throw new HelmxError('validation_error', 'conversationId 与 all 互斥，请仅指定其一', 400, {
          conversationId: requestedConvId,
          all,
        })
      }
      assertConversationIdConsistent(requestedConvId, context.conversationId)
      const targetConvId = all === true ? undefined : (requestedConvId ?? context.conversationId)
      if (all !== true && targetConvId === undefined) {
        throw new HelmxError(
          'validation_error',
          '缺少目标范围：需要提供 conversationId、all: true 或在 CLI 使用 --current',
          400,
        )
      }

      const summaries = workflows
        .listRuns()
        .filter((item) => item.status === 'failed' && (all === true || item.conversationId === targetConvId))
        .sort((a, b) => a.createdAt - b.createdAt)

      const resumed: Array<Record<string, unknown>> = []
      const skipped: Array<{ runId: string; reason: string }> = []

      for (const item of summaries) {
        const verdict = workflows.inspectResumability(item.id)
        if (!verdict.resumable) {
          skipped.push({ runId: item.id, reason: verdict.reason })
          continue
        }
        try {
          assertCanSpawn(item.conversationId)
          const runSummary = await workflows.run({ resumeFromRunId: item.id })
          resumed.push(runSummary as unknown as Record<string, unknown>)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          skipped.push({ runId: item.id, reason })
        }
      }
      syncRunsDoc?.()
      return { resumed, skipped }
    },
  })
}
