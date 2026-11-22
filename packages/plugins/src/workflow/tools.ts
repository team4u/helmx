/**
 * builtin:workflow 模型工具注册（自 workflow.ts 入口拆出；签名不变）。
 *
 * 2 个模型工具（五端复用的执行面）按域分治：
 * - subagent：派生子代理（在 tool-subagent.ts）；
 * - SubagentWorkflow：DSL 确定性编排脚本（内联 / 文件 / 已保存定义）；
 * （cleanup_worktree 已迁至 builtin:worktree 的 worktree/tools.ts。）
 */
import {
  HelmxError,
  safeResultText,
  type HelmxPluginContext,
} from '@helmx/protocol'
import type { WorkflowRunSummary } from '../contracts.js'
import { normalizeWorkflowArgs } from './engine/runtime.js'
import type { WorkflowService } from './engine/index.js'
import type { BackgroundPolicy } from './background.js'
import { registerSubagentTool } from './tool-subagent.js'

export interface WorkflowToolDeps {
  workflows: WorkflowService
  /** 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子。 */
  assertCanSpawn(conversationId: number): void
  /** background 缺省与显式拒绝（权威 ownership 判定）。 */
  resolveBackground: BackgroundPolicy['resolveBackground']
  /** run 启停后的 runs 投影刷新。 */
  syncRunsDoc(): void
}

const workflowOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    background: { type: 'boolean' },
    summary: {},
  },
  required: ['ok'],
} as const

/** 持久化给 Timeline / ToolView 的轻量有界 UI 索引契约（严禁镜像整棵 WorkflowRunSummary）。 */
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

/** workflow run -> 工具结果信封（failed/aborted 置 isError；完整 summary 留给 structuredOutput）。 */
function workflowResultEnvelope(run: WorkflowRunSummary): {
  output: Array<{ type: 'text'; text: string }>
  isError?: boolean
  structuredOutput: unknown
  presentationMeta: Record<string, unknown>
} {
  const failed = run.status === 'failed' || run.status === 'aborted'
  return {
    output: [{ type: 'text', text: safeResultText(run) }],
    ...(failed ? { isError: true } : {}),
    structuredOutput: { ok: !failed, summary: run },
    presentationMeta: workflowPresentationMeta(run),
  }
}

/** workflow 后台调度句柄信封（UI details 仅保留轻量索引字段）。 */
function workflowBackgroundHandle(run: WorkflowRunSummary): {
  output: Array<{ type: 'text'; text: string }>
  structuredOutput: unknown
  presentationMeta: Record<string, unknown>
} {
  const payload = { ok: true, background: true, summary: run }
  return {
    output: [{ type: 'text', text: safeResultText(payload) }],
    structuredOutput: payload,
    presentationMeta: workflowPresentationMeta(run, true),
  }
}

export function registerWorkflowTools(ctx: HelmxPluginContext, deps: WorkflowToolDeps): void {
  const { workflows, assertCanSpawn, resolveBackground, syncRunsDoc } = deps

  // ---- 模型工具：subagent（见 tool-subagent.ts） ----
  registerSubagentTool(ctx, { workflows, assertCanSpawn, resolveBackground, syncRunsDoc })

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
        return {
          output: [{ type: 'text', text: 'workflow_failed: label 必须为非空字符串' }],
          isError: true,
          structuredOutput: { ok: false, summary: 'invalid label: 必须为非空字符串' },
          presentationMeta: { ok: false },
        }
      }
      if (a['background'] !== undefined && typeof a['background'] !== 'boolean') {
        return {
          output: [{ type: 'text', text: 'workflow_failed: background 必须为 boolean' }],
          isError: true,
          structuredOutput: { ok: false, summary: 'invalid background: 必须为 boolean' },
          presentationMeta: { ok: false },
        }
      }
      // background 缺省与显式拒绝（与 subagent 同款权威 ownership 判定）。
      const backgroundChoice = resolveBackground(
        context.conversationId,
        a['background'] === undefined ? undefined : a['background'] === true,
      )
      if (!backgroundChoice.ok) {
        return {
          output: [{ type: 'text', text: `workflow_failed: ${backgroundChoice.message}` }],
          isError: true,
          structuredOutput: { ok: false, summary: backgroundChoice.reason },
          presentationMeta: { ok: false },
        }
      }

      const waitAndFinishSync = async (runId: string) => {
        const current = workflows.getRun(runId)
        if (current.status !== 'running') {
          syncRunsDoc()
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
          syncRunsDoc()
        }
      }

      try {
        // 跨重启/工具重放幂等：以受信 (conversationId, callId) 查既有 Run，绝不重复派生。
        if (typeof context.callId === 'string' && context.callId !== '') {
          const existing = workflows.findRunByParentToolCall(context.conversationId, context.callId)
          if (existing !== undefined) {
            if (backgroundChoice.background) {
              syncRunsDoc()
              return workflowBackgroundHandle(workflows.getRun(existing.id))
            }
            return await waitAndFinishSync(existing.id)
          }
        }

        // 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子，不创建任何 run 记录。
        assertCanSpawn(context.conversationId)
        const input: Record<string, unknown> = {}
        if (a['script'] !== undefined) input['script'] = String(a['script'])
        if (a['scriptPath'] !== undefined) input['scriptPath'] = String(a['scriptPath'])
        if (a['name'] !== undefined) input['name'] = String(a['name'])
        if (a['label'] !== undefined) input['label'] = (a['label'] as string).trim()
        // 工具 args 归一化（原内核 kernel-tools 行为迁入插件）：模型常把 JSON
        // 对象序列化成字符串传入，这里统一解包（双层/标量原样语义不变）。
        if (a['args'] !== undefined) input['args'] = normalizeWorkflowArgs(a['args'])
        if (a['resumeFromRunId'] !== undefined) input['resumeFromRunId'] = String(a['resumeFromRunId'])
        const runContext = {
          ...(context.callId !== undefined ? { parentToolCallId: context.callId } : {}),
          notifyParentOnSettle: backgroundChoice.background,
        }
        const started = await workflows.run({ ...input, conversationId: context.conversationId }, runContext)
        if (backgroundChoice.background) {
          syncRunsDoc()
          return workflowBackgroundHandle(started)
        }
        return await waitAndFinishSync(started.id)
      } catch (error) {
        // 宿主优雅关停挂起期间父回合 abortSignal 触发：必须原样上抛拒绝，让
        // pi-durable 保持 ToolTask 未结算并在重启后按 replay: 'safe' 幂等重放。
        if (workflows.isHostClosing() && workflows.isAutoRecoverOnRestart() && context.signal?.aborted) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: [{ type: 'text', text: `workflow_failed: ${message}` }],
          isError: true,
          structuredOutput: { ok: false, summary: message },
          presentationMeta: { ok: false, status: 'failed' },
        }
      }
    },
  })
}
