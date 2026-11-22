/**
 * builtin:workflow 模型工具 subagent（自 tools.ts 拆出）。
 *
 * 派生子代理（原生 Profile / 外部运行时）：入参逐项强校验（非法值显式
 * 拒绝、绝不静默丢弃）、background 缺省按权威 ownership 判定、执行元数据
 * （conversationId / executionId / worktree）独立于业务 result 回报。
 */
import {
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
} from '../contracts.js'
import { executionOf } from './tool-result.js'
import type { WorkflowService } from './engine/index.js'
import type { BackgroundPolicy } from './background.js'
import type { WorkflowToolDeps } from './tools.js'

/** subagent 工具 effort 合法枚举（与内核原生 spawn 执行行同源）。 */
const SPAWN_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

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

/** 持久化给 Timeline / ToolView 的轻量有界 UI 索引契约（严禁混入大块 result 正文）。 */
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

/** 提取 UI 渲染所需的轻量 execution 索引，剔除内部多余 worktree 元字段。 */
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

/** 工具错误信封：文本 + structuredOutput.ok=false + 轻量 presentationMeta（isError）。 */
function envelopeError(text: string, result: string): {
  output: Array<{ type: 'text'; text: string }>
  isError: boolean
  structuredOutput: unknown
  presentationMeta: Record<string, unknown>
} {
  return {
    output: [{ type: 'text', text }],
    isError: true,
    structuredOutput: { ok: false, result },
    presentationMeta: { ok: false },
  }
}

export function registerSubagentTool(
  ctx: HelmxPluginContext,
  deps: Pick<WorkflowToolDeps, 'workflows' | 'assertCanSpawn' | 'resolveBackground' | 'syncRunsDoc'>,
): void {
  const { workflows, assertCanSpawn, resolveBackground, syncRunsDoc } = deps

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
          enum: [...SPAWN_EFFORT_LEVELS],
          description: 'Reasoning effort (optional)',
        },
        maxSubagentDepth: {
          type: 'number',
          minimum: 1,
          maximum: HARD_MAX_SUBAGENT_DEPTH,
          description: `Subtree spawn-depth ceiling (1..${HARD_MAX_SUBAGENT_DEPTH}; inherits current ceiling, default ${DEFAULT_MAX_SUBAGENT_DEPTH})`,
        },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Artifact IDs passed to the subagent (optional)' },
        secretNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Parent secret env var names to grant (external runtimes only, optional)',
        },
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
          return envelopeError('subagent_failed: label 必须为 string', 'invalid label: 必须为 string')
        }
        const trimmed = a['label'].trim()
        if (trimmed !== '') label = trimmed
      }
      if (a['maxSubagentDepth'] !== undefined) {
        const raw = a['maxSubagentDepth']
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > HARD_MAX_SUBAGENT_DEPTH) {
          return envelopeError(
            `subagent_failed: maxSubagentDepth 必须是 1..${HARD_MAX_SUBAGENT_DEPTH} 的整数（收到 ${JSON.stringify(raw)}）`,
            `invalid maxSubagentDepth: ${JSON.stringify(raw)}`,
          )
        }
      }
      if (a['isolation'] !== undefined && a['isolation'] !== 'worktree') {
        return envelopeError(`subagent_failed: isolation 仅允许 'worktree'（收到 ${JSON.stringify(a['isolation'])}），不合法值绝不静默丢弃`, `invalid isolation: ${JSON.stringify(a['isolation'])}`)
      }
      if (a['attachments'] !== undefined) {
        const list = a['attachments']
        if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.length === 0)) {
          return envelopeError('subagent_failed: attachments 需为非空字符串数组（产物 ID 列表）', 'invalid attachments: 需为非空字符串数组')
        }
      }
      if (a['secretNames'] !== undefined) {
        const list = a['secretNames']
        if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.length === 0)) {
          return envelopeError(
            'subagent_failed: secretNames 需为非空字符串数组（机密环境变量名；缺省不携带任何父会话机密）',
            'invalid secretNames: 需为非空字符串数组',
          )
        }
      }
      if (a['background'] !== undefined && typeof a['background'] !== 'boolean') {
        return envelopeError('subagent_failed: background 必须为 boolean', 'invalid background: 必须为 boolean')
      }
      if (a['fork'] !== undefined && typeof a['fork'] !== 'boolean') {
        return envelopeError('subagent_failed: fork 必须为 boolean', 'invalid fork: 必须为 boolean')
      }
      if (a['fork'] === true && a['resume'] !== undefined) {
        return envelopeError(
          'subagent_failed: fork 与 resume 互斥，不能同时从父会话分叉并续接既有子会话',
          'fork 与 resume 互斥',
        )
      }
      let nodeId: string | undefined
      if (a['nodeId'] !== undefined) {
        if (!isValidNodeId(a['nodeId'])) {
          return envelopeError(
            `subagent_failed: nodeId 非法（收到 ${JSON.stringify(a['nodeId'])}），需匹配 ${NODE_ID_PATTERN}`,
            `invalid nodeId: ${JSON.stringify(a['nodeId'])}`,
          )
        }
        if (a['resume'] !== undefined) {
          return envelopeError(
            'subagent_failed: nodeId 与 resume 互斥，不能在续接既有子会话时切换计算节点',
            'nodeId 与 resume 互斥',
          )
        }
        nodeId = a['nodeId']
      }
      // background 缺省与显式拒绝（权威 ownership 判定，非角色枚举）。
      const backgroundChoice = resolveBackground(
        context.conversationId,
        a['background'] === undefined ? undefined : a['background'] === true,
      )
      if (!backgroundChoice.ok) {
        return envelopeError(`subagent_failed: ${backgroundChoice.message}`, backgroundChoice.reason)
      }
      let resolved: AgentExecutionInfo | undefined

      const formatBackgroundHandle = (runId: string, exec?: AgentExecutionInfo) => {
        const summary = workflows.getRun(runId)
        const effectiveExec = exec ?? workflows.loadRunRecord(runId).subagentMeta?.execution
        const payload = {
          ok: true,
          background: true,
          runId: summary.id,
          status: summary.status,
          ...(effectiveExec !== undefined ? { execution: executionOf(effectiveExec) } : {}),
        }
        const execMeta = effectiveExec !== undefined ? presentationExecutionOf(effectiveExec) : undefined
        return {
          output: [{ type: 'text', text: safeResultText(payload) }],
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

      const formatTerminalResult = (runId: string, initialExec?: AgentExecutionInfo) => {
        const final = workflows.getRun(runId)
        const resolvedInfo = resolved ?? initialExec ?? workflows.loadRunRecord(runId).subagentMeta?.execution
        const execMeta = resolvedInfo !== undefined ? presentationExecutionOf(resolvedInfo) : undefined
        if (final.status === 'completed') {
          const payload = {
            ok: true,
            result: final.result,
            ...(resolvedInfo !== undefined ? { execution: executionOf(resolvedInfo) } : {}),
          }
          return {
            output: [{ type: 'text', text: safeResultText(payload) }],
            structuredOutput: payload,
            presentationMeta: {
              ok: true,
              runId: final.id,
              status: final.status,
              ...(execMeta !== undefined ? { execution: execMeta } : {}),
            },
          }
        }
        const message = final.error ?? `子代理运行 ${runId} 终态为 ${final.status}`
        return {
          output: [{ type: 'text', text: `subagent_failed: ${message}` }],
          isError: true,
          structuredOutput: {
            ok: false,
            result: message,
            ...(resolvedInfo !== undefined ? { execution: executionOf(resolvedInfo) } : {}),
          },
          presentationMeta: {
            ok: false,
            runId: final.id,
            status: final.status,
            ...(execMeta !== undefined ? { execution: execMeta } : {}),
          },
        }
      }

      const waitForegroundRunAndFormat = async (runId: string, initialExec?: AgentExecutionInfo, attachAbortOnReplay = false) => {
        const current = workflows.getRun(runId)
        if (current.detachedAt !== undefined) {
          syncRunsDoc()
          return formatBackgroundHandle(runId, initialExec)
        }
        if (current.status !== 'running') {
          syncRunsDoc()
          return formatTerminalResult(runId, initialExec)
        }
        const onAbort = () => {
          if (workflows.isAutoRecoverOnRestart() && workflows.isHostClosing()) return
          void workflows.abort(runId).catch(() => {})
        }
        if (attachAbortOnReplay) {
          context.signal?.addEventListener('abort', onAbort, { once: true })
          if (context.signal?.aborted) onAbort()
        }
        try {
          const outcome = await workflows.waitForeground(runId, {
            ...(attachAbortOnReplay
              ? { onDetached: () => context.signal?.removeEventListener('abort', onAbort) }
              : {}),
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
          })
          if (outcome === 'detached') {
            syncRunsDoc()
            return formatBackgroundHandle(runId, initialExec)
          }
          return formatTerminalResult(runId, initialExec)
        } finally {
          if (attachAbortOnReplay) context.signal?.removeEventListener('abort', onAbort)
        }
      }

      try {
        // 跨重启/工具重放幂等：以受信 (conversationId, callId) 查既有 Run，绝不重复派生。
        if (typeof context.callId === 'string' && context.callId !== '') {
          const existing = workflows.findRunByParentToolCall(context.conversationId, context.callId)
          if (existing !== undefined) {
            if (backgroundChoice.background || existing.detachedAt !== undefined) {
              syncRunsDoc()
              return formatBackgroundHandle(existing.id, existing.subagentMeta?.execution)
            }
            return await waitForegroundRunAndFormat(existing.id, existing.subagentMeta?.execution, true)
          }
        }

        // 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子，不创建任何后台 run。
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
          ...(Array.isArray(a['secretNames']) ? { secretNames: a['secretNames'] as string[] } : {}),
          onResolved: (info) => {
            resolved = info
          },
          signal: context.signal,
        }

        if (backgroundChoice.background) {
          const started = await workflows.startBackgroundAgent(request, {
            parentToolCallId: context.callId,
            ...(label !== undefined ? { label } : {}),
            notifyParentOnSettle: true,
          })
          syncRunsDoc()
          return formatBackgroundHandle(started.run.id, started.execution)
        }
        // 同步路径统一走受管后台单子代理启动：从启动起即有 durable WorkflowRun
        //（foreground 模式：record 标记 syncForeground、notifyParentOnSettle
        // 初始 false、父 signal 绑定至 detach 或终态），等待 detach 唤醒或终态；
        // 不再裸调 ctx.host.spawnAgent（生命周期与 SubagentWorkflow 同构，
        // UI/动作可按 runId detach 转后台）。
        const started = await workflows.startBackgroundAgent(request, {
          parentToolCallId: context.callId,
          ...(label !== undefined ? { label } : {}),
          notifyParentOnSettle: false,
          foreground: true,
        })
        syncRunsDoc()
        return await waitForegroundRunAndFormat(started.run.id, started.execution, false)
      } catch (error) {
        // 宿主优雅关停挂起期间父回合 abortSignal 触发：必须原样上抛拒绝，让
        // pi-durable 保持 ToolTask 未结算并在重启后按 replay: 'safe' 幂等重放，
        // 绝不能吞错伪装成已结算的失败 tool_result。
        if (workflows.isHostClosing() && workflows.isAutoRecoverOnRestart() && context.signal?.aborted) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        const execMeta = resolved !== undefined ? presentationExecutionOf(resolved) : undefined
        return {
          output: [{ type: 'text', text: `subagent_failed: ${message}` }],
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
      } finally {
        syncRunsDoc()
      }
    },
  })
}
