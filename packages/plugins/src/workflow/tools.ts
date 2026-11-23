/**
 * builtin:workflow 模型工具注册：subagent 与 SubagentWorkflow。
 *
 * - subagent：单子代理派生（人类默认后台建 Run，自动化同步走 ctx.host.spawnAgent 不污染 runs）；
 * - SubagentWorkflow：DSL 确定性编排脚本执行（内联 / 文件 / 已保存定义 / 续跑）。
 */
import {
  HelmxError,
  NODE_ID_PATTERN,
  isValidNodeId,
  safeResultText,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
  type HelmxPluginContext,
} from '@helmx/protocol'
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  HARD_MAX_SUBAGENT_DEPTH,
  withWorkflowSpawnMeta,
  type WorkflowRunSummary,
} from '../contracts.js'
import type { BackgroundPolicy } from './background.js'
import { EFFORT_LEVELS, normalizeWorkflowArgs } from './dsl/index.js'
import { deriveSubagentNameFromPrompt, type WorkflowService } from './runs/index.js'
import { executionOf } from './tool-result.js'

export interface WorkflowToolDeps {
  workflows: WorkflowService
  assertCanSpawn(conversationId: number): void
  resolveBackground: BackgroundPolicy['resolveBackground']
  syncRunsDoc?: () => void
}

const subagentOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    background: { type: 'boolean' },
    runId: { type: 'string' },
    status: { type: 'string' },
    result: {},
    execution: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        conversationId: { type: 'number' },
        executionId: { type: 'string' },
        effectiveCwd: { type: 'string' },
        worktree: {
          type: 'object',
          properties: { path: { type: 'string' }, branch: { type: 'string' } },
          required: ['path', 'branch'],
        },
      },
    },
  },
  required: ['ok'],
} as const

const subagentPresentationMetaSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    background: { type: 'boolean' },
    runId: { type: 'string' },
    status: { type: 'string' },
    execution: {
      type: 'object',
      properties: {
        nodeId: { type: 'string' },
        conversationId: { type: 'number' },
        executionId: { type: 'string' },
        effectiveCwd: { type: 'string' },
        worktree: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            path: { type: 'string' },
            branch: { type: 'string' },
          },
          required: ['path', 'branch'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  required: ['ok'],
  additionalProperties: false,
} as const

const workflowOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    background: { type: 'boolean' },
    summary: {},
  },
  required: ['ok'],
} as const

const workflowPresentationMetaSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    background: { type: 'boolean' },
    runId: { type: 'string' },
    status: { type: 'string' },
    label: { type: 'string' },
  },
  required: ['ok'],
  additionalProperties: false,
} as const

function presentationExecutionOf(info: AgentExecutionInfo): Record<string, unknown> | undefined {
  const full = executionOf(info)
  const out: Record<string, unknown> = {}
  if (full['nodeId'] !== undefined) out['nodeId'] = full['nodeId']
  if (full['conversationId'] !== undefined) out['conversationId'] = full['conversationId']
  if (full['executionId'] !== undefined) out['executionId'] = full['executionId']
  if (full['effectiveCwd'] !== undefined) out['effectiveCwd'] = full['effectiveCwd']
  const wt = full['worktree']
  if (wt !== null && typeof wt === 'object' && !Array.isArray(wt)) {
    const wtRec = wt as Record<string, unknown>
    out['worktree'] = {
      ...(typeof wtRec['id'] === 'string' && wtRec['id'] !== '' ? { id: wtRec['id'] } : {}),
      path: wtRec['path'],
      branch: wtRec['branch'],
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function subagentError(text: string, result: string) {
  return {
    output: [{ type: 'text' as const, text }],
    isError: true,
    structuredOutput: { ok: false, result },
    presentationMeta: { ok: false },
  }
}

function workflowError(text: string, summary: string, status?: string) {
  return {
    output: [{ type: 'text' as const, text }],
    isError: true,
    structuredOutput: { ok: false, summary },
    presentationMeta: status !== undefined ? { ok: false, status } : { ok: false },
  }
}

function workflowPresentationMeta(
  run: Pick<WorkflowRunSummary, 'id' | 'status' | 'name'>,
  background = false,
): Record<string, unknown> {
  const failed = run.status === 'failed' || run.status === 'aborted'
  const trimmedName = run.name.trim()
  const label = trimmedName.length > 200 ? trimmedName.slice(0, 200) : trimmedName
  return {
    ok: background ? true : !failed,
    ...(background ? { background: true } : {}),
    runId: run.id,
    status: run.status,
    ...(label !== '' ? { label } : {}),
  }
}

function workflowResultEnvelope(run: WorkflowRunSummary) {
  const failed = run.status === 'failed' || run.status === 'aborted'
  return {
    output: [{ type: 'text' as const, text: safeResultText(run) }],
    ...(failed ? { isError: true } : {}),
    structuredOutput: { ok: !failed, summary: run },
    presentationMeta: workflowPresentationMeta(run),
  }
}

function workflowBackgroundHandle(run: WorkflowRunSummary) {
  const payload = { ok: true, background: true, summary: run }
  return {
    output: [{ type: 'text' as const, text: safeResultText(payload) }],
    structuredOutput: payload,
    presentationMeta: workflowPresentationMeta(run, true),
  }
}

export function registerWorkflowTools(ctx: HelmxPluginContext, deps: WorkflowToolDeps): void {
  const { workflows, assertCanSpawn, resolveBackground, syncRunsDoc } = deps

  // ---- 模型工具：subagent ----
  ctx.tool({
    name: 'subagent',
    replay: 'safe',
    promptGuidelines: [
      'Pass a short descriptive label (4-40 chars); for background runs, keep responding or doing other work and wait for the automatic steer report instead of polling.',
      'Full subagent, runtime, worktree, and lifecycle reference: load_skill({ skillId: "workflow", path: "references/subagents.md" }).',
    ],
    description:
      'Spawn a subagent for one delegated task. Human conversations default to background (returns runId; completion arrives as a steer follow-up); automated conversations (bot/helmx) run synchronously (background:true rejected). Pass background:false only when the next step depends on the result. Supports label, agentType (Profile ID or external runtime), fork, nodeId, cwd, isolation:"worktree", model, effort, gate, schema, attachments, maxSubagentDepth, and resume. See load_skill({ skillId: "workflow", path: "references/subagents.md" }).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Subagent task instructions' },
        label: { type: 'string', description: 'Short task label (4-40 chars, optional)' },
        agentType: { type: 'string', description: 'Profile ID or external runtime (defaults to assistant; fork inherits parent)' },
        nodeId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: NODE_ID_PATTERN,
          description:
            'Optional target compute node ID (overrides Profile/parent node; explicit "local" switches back to the Hub host; requires cwd or a compatible Profile cwd on remote nodes; mutually exclusive with resume)',
        },
        cwd: { type: 'string', description: 'Absolute working directory (optional)' },
        fork: {
          type: 'boolean',
          description: 'Fork a native child from parent completed context (default false; mutually exclusive with resume; native only)',
        },
        background: {
          type: 'boolean',
          description: 'Run in background (default true for human, false for automated)',
        },
        isolation: {
          type: 'string',
          enum: ['worktree'],
          description: 'Allocate an isolated Git worktree on the target node',
        },
        schema: { type: 'object', description: 'Structured-output JSON Schema (optional)' },
        gate: { type: 'string', description: 'Acceptance shell command (optional; exit != 0 fails)' },
        resume: { type: 'string', description: 'Prior execution.conversationId or executionId to continue' },
        model: { type: 'string', description: "Model override 'provider/model' (optional)" },
        effort: {
          type: 'string',
          enum: [...EFFORT_LEVELS],
          description: 'Reasoning effort (optional)',
        },
        maxSubagentDepth: {
          type: 'number',
          minimum: 1,
          maximum: HARD_MAX_SUBAGENT_DEPTH,
          description: `Subtree spawn-depth ceiling (1..${HARD_MAX_SUBAGENT_DEPTH}; inherits current ceiling, default ${DEFAULT_MAX_SUBAGENT_DEPTH})`,
        },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Artifact IDs passed to the subagent (optional)' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    structuredOutputSchema: subagentOutputSchema,
    presentationMetaSchema: subagentPresentationMetaSchema,
    async execute(args, context) {
      const a = args as Record<string, unknown>
      let label: string | undefined
      if (a['label'] !== undefined) {
        if (typeof a['label'] !== 'string') {
          return subagentError('subagent_failed: label 必须为 string', 'invalid label: 必须为 string')
        }
        const trimmed = a['label'].trim()
        if (trimmed !== '') label = trimmed
      }
      if (a['maxSubagentDepth'] !== undefined) {
        const raw = a['maxSubagentDepth']
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > HARD_MAX_SUBAGENT_DEPTH) {
          return subagentError(
            `subagent_failed: maxSubagentDepth 必须是 1..${HARD_MAX_SUBAGENT_DEPTH} 的整数（收到 ${JSON.stringify(raw)}）`,
            `invalid maxSubagentDepth: ${JSON.stringify(raw)}`,
          )
        }
      }
      if (a['isolation'] !== undefined && a['isolation'] !== 'worktree') {
        return subagentError(
          `subagent_failed: isolation 仅允许 'worktree'（收到 ${JSON.stringify(a['isolation'])}），不合法值绝不静默丢弃`,
          `invalid isolation: ${JSON.stringify(a['isolation'])}`,
        )
      }
      if (a['attachments'] !== undefined) {
        const list = a['attachments']
        if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
          return subagentError('subagent_failed: attachments 需为非空字符串数组（产物 ID 列表）', 'invalid attachments: 需为非空字符串数组')
        }
      }
      if (a['background'] !== undefined && typeof a['background'] !== 'boolean') {
        return subagentError('subagent_failed: background 必须为 boolean', 'invalid background: 必须为 boolean')
      }
      if (a['fork'] !== undefined && typeof a['fork'] !== 'boolean') {
        return subagentError('subagent_failed: fork 必须为 boolean', 'invalid fork: 必须为 boolean')
      }
      if (a['fork'] === true && a['resume'] !== undefined) {
        return subagentError('subagent_failed: fork 与 resume 互斥，不能同时从父会话分叉并续接既有子会话', 'fork 与 resume 互斥')
      }
      let nodeId: string | undefined
      if (a['nodeId'] !== undefined) {
        if (!isValidNodeId(a['nodeId'])) {
          return subagentError(
            `subagent_failed: nodeId 非法（收到 ${JSON.stringify(a['nodeId'])}），需匹配 ${NODE_ID_PATTERN}`,
            `invalid nodeId: ${JSON.stringify(a['nodeId'])}`,
          )
        }
        if (a['resume'] !== undefined) {
          return subagentError('subagent_failed: nodeId 与 resume 互斥，不能在续接既有子会话时切换计算节点', 'nodeId 与 resume 互斥')
        }
        nodeId = a['nodeId']
      }
      const backgroundChoice = resolveBackground(
        context.conversationId,
        a['background'] === undefined ? undefined : a['background'] === true,
      )
      if (!backgroundChoice.ok) {
        return subagentError(`subagent_failed: ${backgroundChoice.message}`, backgroundChoice.reason)
      }

      let resolved: AgentExecutionInfo | undefined
      const formatBackgroundHandle = (runId: string, exec?: AgentExecutionInfo) => {
        const summary = workflows.getRun(runId)
        const headerExec =
          exec ??
          (() => {
            const loaded = workflows.loadRunHeaderAndDetail(runId)
            return loaded.header.kind === 'subagent' ? loaded.header.execution : undefined
          })()
        const payload = {
          ok: true,
          background: true,
          runId: summary.id,
          status: summary.status,
          ...(headerExec !== undefined ? { execution: executionOf(headerExec) } : {}),
        }
        const execMeta = headerExec !== undefined ? presentationExecutionOf(headerExec) : undefined
        return {
          output: [{ type: 'text' as const, text: safeResultText(payload) }],
          structuredOutput: payload,
          presentationMeta: {
            ok: true,
            background: true,
            runId: summary.id,
            status: summary.status,
            ...(execMeta !== undefined ? { execution: execMeta } : {}),
          },
        }
      }

      try {
        if (backgroundChoice.background) {
          if (typeof context.callId === 'string' && context.callId !== '') {
            const existing = workflows.findRunByParentToolCall(context.conversationId, context.callId)
            if (existing !== undefined) {
              syncRunsDoc?.()
              return formatBackgroundHandle(existing.id, existing.kind === 'subagent' ? existing.execution : undefined)
            }
          }
          assertCanSpawn(context.conversationId)
          const request: AgentSpawnRequest = {
            parentConversationId: context.conversationId,
            ...(context.callId !== undefined ? { parentToolCallId: context.callId } : {}),
            prompt: String(a['prompt']),
            ...(label !== undefined && a['resume'] === undefined ? { title: label } : {}),
            ...(a['agentType'] !== undefined ? { agentType: String(a['agentType']) } : {}),
            ...(nodeId !== undefined ? { nodeId } : {}),
            ...(a['cwd'] !== undefined ? { cwd: String(a['cwd']) } : {}),
            ...(a['fork'] === true ? { fork: true } : {}),
            ...(a['isolation'] !== undefined ? { isolation: 'worktree' } : {}),
            ...(a['schema'] !== undefined ? { schema: a['schema'] as Record<string, unknown> } : {}),
            ...(a['gate'] !== undefined ? { gate: String(a['gate']) } : {}),
            ...(a['resume'] !== undefined ? { resume: String(a['resume']) } : {}),
            ...(a['model'] !== undefined ? { model: String(a['model']) } : {}),
            ...(a['effort'] !== undefined ? { effort: String(a['effort']) } : {}),
            ...(a['maxSubagentDepth'] !== undefined
              ? { meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: Number(a['maxSubagentDepth']) }) }
              : {}),
            ...(Array.isArray(a['attachments']) ? { attachments: a['attachments'] as string[] } : {}),
            onResolved: (info) => {
              resolved = info
            },
            signal: context.signal,
          }
          const started = await workflows.startBackgroundAgent(request, {
            parentToolCallId: context.callId,
            ...(label !== undefined ? { label } : {}),
            notifyParentOnSettle: true,
          })
          syncRunsDoc?.()
          return formatBackgroundHandle(started.run.id, started.execution)
        }

        // 同步路径：直调 ctx.host.spawnAgent，不落 WorkflowRun；优雅重启重放时按 (parent, callId) 原位 reattach。
        const hasCallId = typeof context.callId === 'string' && context.callId !== ''
        const existingChild =
          hasCallId && a['resume'] === undefined
            ? ctx.host
                .listConversations()
                .find((c) => c.parentConversationId === context.conversationId && c.parentToolCallId === context.callId)
            : undefined
        if (existingChild === undefined) assertCanSpawn(context.conversationId)

        const requestId = hasCallId ? `helmx:spawn:${context.conversationId}:${context.callId}` : undefined
        const redact = (text: string) => ctx.host.redact(text)
        const syncTitle =
          existingChild === undefined && a['resume'] === undefined
            ? label !== undefined
              ? redact(label)
              : deriveSubagentNameFromPrompt(String(a['prompt']), redact)
            : undefined
        const syncRequest: AgentSpawnRequest = {
          parentConversationId: context.conversationId,
          ...(context.callId !== undefined ? { parentToolCallId: context.callId } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
          prompt: String(a['prompt']),
          ...(a['agentType'] !== undefined ? { agentType: String(a['agentType']) } : {}),
          ...(a['isolation'] !== undefined ? { isolation: 'worktree' } : {}),
          ...(a['schema'] !== undefined ? { schema: a['schema'] as Record<string, unknown> } : {}),
          ...(a['gate'] !== undefined ? { gate: String(a['gate']) } : {}),
          ...(a['maxSubagentDepth'] !== undefined
            ? { meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: Number(a['maxSubagentDepth']) }) }
            : {}),
          ...(existingChild !== undefined
            ? {
                reattach: {
                  conversationId: existingChild.id,
                  ...(existingChild.cwd !== '' ? { effectiveCwd: existingChild.cwd } : {}),
                },
              }
            : {
                ...(syncTitle !== undefined ? { title: syncTitle } : {}),
                ...(nodeId !== undefined ? { nodeId } : {}),
                ...(a['cwd'] !== undefined ? { cwd: String(a['cwd']) } : {}),
                ...(a['fork'] === true ? { fork: true } : {}),
                ...(a['resume'] !== undefined ? { resume: String(a['resume']) } : {}),
                ...(a['model'] !== undefined ? { model: String(a['model']) } : {}),
                ...(a['effort'] !== undefined ? { effort: String(a['effort']) } : {}),
                ...(Array.isArray(a['attachments']) ? { attachments: a['attachments'] as string[] } : {}),
              }),
          onResolved: (info) => {
            resolved = info
          },
          signal: context.signal,
        }
        const raw = await ctx.host.spawnAgent(syncRequest)
        const payload = {
          ok: true,
          result: raw,
          ...(resolved !== undefined ? { execution: executionOf(resolved) } : {}),
        }
        const execMeta = resolved !== undefined ? presentationExecutionOf(resolved) : undefined
        return {
          output: [{ type: 'text' as const, text: safeResultText(payload) }],
          structuredOutput: payload,
          presentationMeta: {
            ok: true,
            status: 'completed',
            ...(execMeta !== undefined ? { execution: execMeta } : {}),
          },
        }
      } catch (error) {
        if (workflows.isHostClosing() && workflows.isAutoRecoverOnRestart() && context.signal?.aborted) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        const execMeta = resolved !== undefined ? presentationExecutionOf(resolved) : undefined
        return {
          output: [{ type: 'text' as const, text: `subagent_failed: ${message}` }],
          isError: true,
          structuredOutput: {
            ok: false,
            result: message,
            ...(resolved !== undefined ? { execution: executionOf(resolved) } : {}),
          },
          presentationMeta: {
            ok: false,
            status: 'failed',
            ...(execMeta !== undefined ? { execution: execMeta } : {}),
          },
        }
      }
    },
  })

  // ---- 模型工具：SubagentWorkflow ----
  ctx.tool({
    name: 'SubagentWorkflow',
    replay: 'safe',
    promptGuidelines: [
      'Read the DSL reference before writing non-trivial scripts: load_skill({ skillId: "workflow", path: "references/dsl.md" }).',
      'Set a concise meta.name or label; for background runs, keep working and wait for the terminal steer report instead of polling.',
    ],
    description:
      'Run a deterministic SubagentWorkflow JS script in the current conversation. Provide exactly one of script, scriptPath, or name (or only resumeFromRunId to replay). Human conversations default to background (returns handle; completion arrives as a steer follow-up); automated conversations run synchronously. See load_skill({ skillId: "workflow", path: "references/dsl.md" }).',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Inline DSL script source' },
        scriptPath: { type: 'string', description: 'Absolute path to DSL script file' },
        name: { type: 'string', description: 'Saved workflow name' },
        label: { type: 'string', description: 'Display label override (optional)' },
        args: { description: 'JSON input passed as args to the script' },
        resumeFromRunId: { type: 'string', description: 'Existing runId to replay from checkpoint (optional)' },
        background: {
          type: 'boolean',
          description: 'Run in background (default true for human, false for automated)',
        },
      },
      additionalProperties: false,
    },
    structuredOutputSchema: workflowOutputSchema,
    presentationMetaSchema: workflowPresentationMetaSchema,
    async execute(args, context) {
      const a = args as Record<string, unknown>
      if (a['label'] !== undefined && (typeof a['label'] !== 'string' || a['label'].trim() === '')) {
        return workflowError('workflow_failed: label 必须为非空字符串', 'invalid label: 必须为非空字符串')
      }
      if (a['background'] !== undefined && typeof a['background'] !== 'boolean') {
        return workflowError('workflow_failed: background 必须为 boolean', 'invalid background: 必须为 boolean')
      }
      const backgroundChoice = resolveBackground(
        context.conversationId,
        a['background'] === undefined ? undefined : a['background'] === true,
      )
      if (!backgroundChoice.ok) {
        return workflowError(`workflow_failed: ${backgroundChoice.message}`, backgroundChoice.reason)
      }

      const waitAndFinishSync = async (runId: string) => {
        const current = workflows.getRun(runId)
        if (current.status !== 'running') {
          syncRunsDoc?.()
          return workflowResultEnvelope(current)
        }
        const onAbort = () => {
          if (workflows.isAutoRecoverOnRestart() && workflows.isHostClosing()) return
          void workflows.abort(runId).catch(() => {})
        }
        context.signal?.addEventListener('abort', onAbort, { once: true })
        if (context.signal?.aborted) onAbort()
        try {
          await workflows.wait(runId)
          if (workflows.isHostClosing() && workflows.isAutoRecoverOnRestart() && context.signal?.aborted) {
            throw new HelmxError('aborted', '宿主优雅关停挂起，等待重启后重放', 409)
          }
          return workflowResultEnvelope(workflows.getRun(runId))
        } finally {
          context.signal?.removeEventListener('abort', onAbort)
          syncRunsDoc?.()
        }
      }

      try {
        if (typeof context.callId === 'string' && context.callId !== '') {
          const existing = workflows.findRunByParentToolCall(context.conversationId, context.callId)
          if (existing !== undefined) {
            if (backgroundChoice.background) {
              syncRunsDoc?.()
              return workflowBackgroundHandle(workflows.getRun(existing.id))
            }
            return await waitAndFinishSync(existing.id)
          }
        }

        assertCanSpawn(context.conversationId)
        const input: Record<string, unknown> = {}
        if (a['script'] !== undefined) input['script'] = String(a['script'])
        if (a['scriptPath'] !== undefined) input['scriptPath'] = String(a['scriptPath'])
        if (a['name'] !== undefined) input['name'] = String(a['name'])
        if (a['label'] !== undefined) input['label'] = (a['label'] as string).trim()
        if (a['args'] !== undefined) input['args'] = normalizeWorkflowArgs(a['args'])
        if (a['resumeFromRunId'] !== undefined) input['resumeFromRunId'] = String(a['resumeFromRunId'])
        const started = await workflows.run(
          { ...input, conversationId: context.conversationId },
          {
            ...(context.callId !== undefined ? { parentToolCallId: context.callId } : {}),
            notifyParentOnSettle: backgroundChoice.background,
          },
        )
        if (backgroundChoice.background) {
          syncRunsDoc?.()
          return workflowBackgroundHandle(started)
        }
        return await waitAndFinishSync(started.id)
      } catch (error) {
        if (workflows.isHostClosing() && workflows.isAutoRecoverOnRestart() && context.signal?.aborted) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        return workflowError(`workflow_failed: ${message}`, message, 'failed')
      }
    },
  })
}
