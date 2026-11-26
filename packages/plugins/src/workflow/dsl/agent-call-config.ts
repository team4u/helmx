/**
 * dsl/agent-call-config.ts — Resolves a worker `agent()` call into a validated, scoped, journal-identified
 * configuration. Option / host-capability / resume-label / schema / cap rejections respond to the worker
 * before any node or journal state is touched.
 */
import type { WorkflowNodeState } from '../../contracts.js'
import {
  compileJsonSchema,
  derivedLabel,
  readCallScope,
  scopedResumeKey,
  ScriptCallOptionError,
  validateAgentCallOptions,
  type ValidatedAgentCall,
} from './boundary.js'
import type { AgentJournalKeyInput } from './journal.js'
import type { CompiledSchema, JournalScope, WorkerAgentCallPayload } from './types.js'
import { errorMessageOf, type CompletedChild, type RuntimeSharedContext } from './runtime-shared.js'

export interface ResolvedAgentCallConfig {
  opts: ValidatedAgentCall
  scope: JournalScope
  workflowRootPath: string
  compiledSchema: CompiledSchema | undefined
  index: number
  attemptLimit: number
  agentId: string
  label: string
  agentType: string
  model: string | undefined
  isolation: 'worktree' | undefined
  nodeId: string | undefined
  node: WorkflowNodeState
  keyInput: AgentJournalKeyInput
  resumed: CompletedChild | undefined
}

export function resolveAgentCallConfig(
  ctx: RuntimeSharedContext,
  callId: number,
  payload: WorkerAgentCallPayload,
): ResolvedAgentCallConfig | undefined {
  let opts: ValidatedAgentCall
  try {
    opts = validateAgentCallOptions(payload.prompt, payload.opts, payload.goalMode === true)
  } catch (error) {
    if (error instanceof ScriptCallOptionError) {
      ctx.respond(callId, false, undefined, error.message, false)
      return undefined
    }
    ctx.respond(callId, false, undefined, errorMessageOf(error), true)
    return undefined
  }

  if (opts.gate !== undefined && ctx.host.runGate === undefined) {
    ctx.respond(callId, false, undefined, 'This workflow host cannot run gate commands.', true)
    return undefined
  }
  if (opts.resume !== undefined && ctx.host.resumeAgent === undefined) {
    ctx.respond(callId, false, undefined, 'This workflow host cannot resume agents.', true)
    return undefined
  }

  const scope = readCallScope(payload)
  const workflowRootPath =
    typeof payload.workflowRootPath === 'string' && payload.workflowRootPath !== ''
      ? payload.workflowRootPath
      : 'root'

  let resumed: CompletedChild | undefined
  if (opts.resume !== undefined) {
    resumed = ctx.completedByLabel.get(scopedResumeKey(workflowRootPath, opts.resume))
    if (resumed === undefined) {
      const known = [...ctx.completedByLabel.values()]
        .filter((child) => child.workflowRootPath === workflowRootPath)
        .map((child) => child.label)
      ctx.respond(
        callId,
        false,
        undefined,
        `agent() opts.resume: no agent has completed under the label "${opts.resume}" in this run. ${
          known.length === 0 ? 'No agent has completed yet.' : `Known labels: ${known.map((l) => `"${l}"`).join(', ')}.`
        }`,
        true,
      )
      return undefined
    }
  }

  let compiledSchema: CompiledSchema | undefined
  if (opts.schema !== undefined) {
    const comp = compileJsonSchema(opts.schema)
    if (!comp.ok) {
      ctx.respond(callId, false, undefined, comp.message, true)
      return undefined
    }
    compiledSchema = comp.compiled
  }

  if (ctx.agentCount() >= ctx.agentCap) {
    ctx.respond(callId, false, undefined, `Workflow exceeded its cap of ${ctx.agentCap} agents.`, true)
    return undefined
  }

  const index = ctx.nextCallIndex()
  ctx.incrementAgentCount()
  const maxAttempts = opts.maxAttempts ?? 1
  const previousAttempts =
    ctx.retryFailedCalls && maxAttempts > 1 ? ctx.replay.terminalFailureAttempt(scope) : 0
  const attemptLimit = previousAttempts + maxAttempts
  const logicalId =
    scope.scopePath === 'root' ? String(scope.scopeCallIndex) : `${scope.scopePath}:${scope.scopeCallIndex}`
  const agentId = resumed?.agentId ?? `wf-agent-${logicalId}`
  const label = opts.label ?? resumed?.label ?? derivedLabel(opts.prompt)
  const agentType = resumed?.agentType ?? opts.agentType ?? 'assistant'
  const model = resumed !== undefined ? resumed.model : opts.model
  const isolation = resumed !== undefined ? resumed.isolation : opts.isolation
  const nodeId = resumed !== undefined ? undefined : opts.nodeId
  ctx.openLaunches.set(callId, label)

  const node: WorkflowNodeState = {
    id: `agent-${index}`,
    kind: 'agent',
    status: 'pending',
    label,
    agentType,
    prompt: opts.prompt,
    ...(model !== undefined ? { model } : {}),
    ...(compiledSchema !== undefined ? { schema: compiledSchema.schema } : {}),
    ...(payload.ambientPhaseIndex !== undefined ? { phaseIndex: payload.ambientPhaseIndex } : {}),
    ...(payload.ambientPhaseTitle !== undefined ? { phaseTitle: payload.ambientPhaseTitle } : {}),
    ...(opts.gate !== undefined ? { gateCommand: opts.gate } : {}),
  }
  ctx.emitNode(index, node)

  const keyInput: AgentJournalKeyInput = {
    prompt: opts.prompt,
    label: opts.label,
    model: opts.model,
    agentType: opts.agentType,
    effort: opts.effort,
    isolation: opts.isolation,
    gate: opts.gate,
    resume: opts.resume,
    attachments: opts.attachments,
    maxSubagentDepth: opts.maxSubagentDepth,
    cwd: opts.cwd,
    nodeId: opts.nodeId,
    schema: opts.schema,
  }

  return {
    opts,
    scope,
    workflowRootPath,
    compiledSchema,
    index,
    attemptLimit,
    agentId,
    label,
    agentType,
    model,
    isolation,
    nodeId,
    node,
    keyInput,
    resumed,
  }
}
