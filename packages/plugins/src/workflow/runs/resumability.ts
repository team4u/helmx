/**
 * runs/resumability.ts — Structured failure classification and single authoritative resumability evaluator.
 */
import { HelmxError } from '@helmx/protocol'
import { readJournal, WorkflowMetaError, WorkflowRuntimeError, type JournalReadResult } from '../dsl/index.js'
import type { RunDetail, RunHeader } from './types.js'

export const MAX_CRASH_RECOVERIES = 3

export const NON_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'workflow_action_uncertain',
  'journal_read_failed',
  'validation_error',
  'syntax_error',
  'crash_recovery_limit',
  'missing_subagent_spec',
  'missing_script_source',
])

export function classifyRunFailureCode(
  cause: unknown,
  errorText?: string,
  fallbackCode = 'workflow_failed',
): string {
  if (cause instanceof HelmxError && cause.code !== '') return cause.code
  if (cause instanceof WorkflowMetaError) return 'validation_error'
  if (cause instanceof WorkflowRuntimeError) {
    return cause.message.toLowerCase().includes('workflow script has a syntax error')
      ? 'syntax_error'
      : 'validation_error'
  }
  if (errorText !== undefined) {
    const bracketed = /^\[([a-z][a-z0-9_]*)\]/i.exec(errorText.trim())
    if (bracketed !== null) return bracketed[1]!.toLowerCase()
    const lower = errorText.toLowerCase()
    if (lower.includes('workflow_action_uncertain')) return 'workflow_action_uncertain'
    if (lower.includes('journal_read_failed')) return 'journal_read_failed'
    if (lower.includes('workflow script has a syntax error')) return 'syntax_error'
  }
  return fallbackCode
}

export interface ResumabilityContext {
  getTakenOverBy?(runId: string): string | undefined
  readScriptFile?(scriptPath: string): string
}

export interface InspectResumabilityOptions {
  mode?: 'failed' | 'startup_in_place' | 'explicit_resume'
  hasExplicitScriptOverride?: boolean
}

export type RunResumabilityVerdict =
  | {
      resumable: true
      script?: string
      scriptPath?: string
      savedName?: string
      journal?: JournalReadResult
      resumeRef?: string
    }
  | {
      resumable: false
      code: string
      reason: string
      journal?: JournalReadResult
    }

function resolvePersistedScript(
  header: Extract<RunHeader, { kind: 'workflow' }>,
  detail: RunDetail,
  ctx: ResumabilityContext,
): { ok: true; script: string; scriptPath?: string; savedName?: string } | { ok: false } {
  if (detail.script !== undefined) return { ok: true, script: detail.script }
  if (header.scriptPath !== undefined) {
    if (ctx.readScriptFile === undefined) {
      return {
        ok: true,
        script: '',
        scriptPath: header.scriptPath,
        ...(header.savedName !== undefined ? { savedName: header.savedName } : {}),
      }
    }
    try {
      const script = ctx.readScriptFile(header.scriptPath)
      return {
        ok: true,
        script,
        scriptPath: header.scriptPath,
        ...(header.savedName !== undefined ? { savedName: header.savedName } : {}),
      }
    } catch {
      return { ok: false }
    }
  }
  return { ok: false }
}

function inspectJournalHealth(runId: string, journalPath: string): { ok: true; journal: JournalReadResult } | { ok: false; code: string; reason: string; journal: JournalReadResult } {
  const journal = readJournal(journalPath)
  if (journal.readFailed !== undefined) {
    return {
      ok: false,
      code: 'journal_read_failed',
      reason: `[journal_read_failed] 工作流 ${runId} 账本不可读（${journal.readFailed.code}）：${journal.readFailed.message}`,
      journal,
    }
  }
  if (journal.actionUncertain) {
    const why =
      journal.failedActions > 0
        ? '存在失败（ok:false）的动作终态行'
        : '账本存在已开始但未确认完成或无法判定的动作调用'
    return {
      ok: false,
      code: 'workflow_action_uncertain',
      reason:
        `[workflow_action_uncertain] 工作流 ${runId} 的${why}（failedActions=${journal.failedActions}），无法安全恢复；` +
        '请人工确认该动作副作用后，从其 journal 中移除对应 action 行或放弃 resume',
      journal,
    }
  }
  return { ok: true, journal }
}

/** Single authoritative resumability evaluator across startup recovery, explicit resume, and summary badges. */
export function inspectRunResumability(
  header: RunHeader,
  detail: RunDetail,
  ctx: ResumabilityContext = {},
  options: InspectResumabilityOptions = {},
): RunResumabilityVerdict {
  const mode = options.mode ?? 'failed'

  if (mode === 'startup_in_place') {
    const projectedCrashes = header.phase === 'suspended' ? (header.crashRecoveries ?? 0) : (header.crashRecoveries ?? 0) + 1
    if (projectedCrashes > MAX_CRASH_RECOVERIES) {
      return {
        resumable: false,
        code: 'crash_recovery_limit',
        reason: `[crash_recovery_limit] 连续异常崩溃恢复超过上限（${MAX_CRASH_RECOVERIES} 次），已触发熔断中止恢复`,
      }
    }
    if (header.kind === 'subagent') {
      if (detail.subagentSpec === undefined) {
        return {
          resumable: false,
          code: 'missing_subagent_spec',
          reason: 'subagent run interrupted by process restart（缺少持久化启动规格 subagentSpec，无法自动恢复）',
        }
      }
      return { resumable: true }
    }
    const scriptRes = resolvePersistedScript(header, detail, ctx)
    if (!scriptRes.ok) {
      return {
        resumable: false,
        code: 'missing_script_source',
        reason: 'run interrupted by process restart（未持久化脚本源，无法原位续跑）',
      }
    }
    const j = inspectJournalHealth(header.id, header.journalPath)
    if (!j.ok) return { resumable: false, code: j.code, reason: j.reason, journal: j.journal }
    return {
      resumable: true,
      script: scriptRes.script,
      ...(scriptRes.scriptPath !== undefined ? { scriptPath: scriptRes.scriptPath } : {}),
      ...(scriptRes.savedName !== undefined ? { savedName: scriptRes.savedName } : {}),
      journal: j.journal,
    }
  }

  if (mode === 'explicit_resume') {
    if (header.kind === 'subagent') {
      if (header.status !== 'failed' && header.status !== 'aborted') {
        return {
          resumable: false,
          code: 'validation_error',
          reason: `后台子代理 ${header.id} 当前状态为 ${header.status}，仅 failed/aborted 状态支持 resumeFromRunId 续接`,
        }
      }
      const exec = header.execution ?? detail.subagentMeta?.execution
      const resumeRef = exec?.executionId ?? (exec?.conversationId !== undefined ? String(exec.conversationId) : undefined)
      if (detail.subagentSpec === undefined || resumeRef === undefined) {
        return {
          resumable: false,
          code: 'validation_error',
          reason: `后台子代理 ${header.id} 缺少可续接执行句柄或持久化规格（无法执行 resumeFromRunId）`,
        }
      }
      return { resumable: true, resumeRef }
    }

    let script: string | undefined
    let scriptPath: string | undefined
    let savedName: string | undefined
    if (!options.hasExplicitScriptOverride) {
      const scriptRes = resolvePersistedScript(header, detail, ctx)
      if (!scriptRes.ok) {
        return {
          resumable: false,
          code: 'validation_error',
          reason: `工作流 ${header.id} 未持久化脚本源，无法 resume；请显式提供 script/scriptPath`,
        }
      }
      script = scriptRes.script
      scriptPath = scriptRes.scriptPath
      savedName = scriptRes.savedName
    }
    const j = inspectJournalHealth(header.id, header.journalPath)
    if (!j.ok) return { resumable: false, code: j.code, reason: j.reason, journal: j.journal }
    return {
      resumable: true,
      ...(script !== undefined ? { script } : {}),
      ...(scriptPath !== undefined ? { scriptPath } : {}),
      ...(savedName !== undefined ? { savedName } : {}),
      journal: j.journal,
    }
  }

  // mode === 'failed'
  if (header.status !== 'failed') {
    return { resumable: false, code: 'not_failed', reason: `状态为 ${header.status}（非 failed）` }
  }
  if (header.errorCode !== undefined && NON_RETRYABLE_ERROR_CODES.has(header.errorCode)) {
    return {
      resumable: false,
      code: header.errorCode,
      reason: `不可自动恢复错误：${header.error ?? header.errorCode}`,
    }
  }
  const takenOverBy = ctx.getTakenOverBy?.(header.id)
  if (takenOverBy !== undefined) {
    return { resumable: false, code: 'already_resumed', reason: `已被 ${takenOverBy} 接管续跑` }
  }

  if (header.kind === 'subagent') {
    const exec = header.execution ?? detail.subagentMeta?.execution
    const hasHandle = exec?.conversationId !== undefined || exec?.executionId !== undefined
    if (detail.subagentSpec === undefined || !hasHandle) {
      return {
        resumable: false,
        code: 'missing_subagent_spec',
        reason: '缺少可续接执行句柄或持久化规格 subagentSpec',
      }
    }
    return { resumable: true }
  }

  const scriptRes = resolvePersistedScript(header, detail, ctx)
  if (!scriptRes.ok) {
    return { resumable: false, code: 'missing_script_source', reason: '未持久化脚本源' }
  }
  const j = inspectJournalHealth(header.id, header.journalPath)
  if (!j.ok) return { resumable: false, code: j.code, reason: j.reason, journal: j.journal }
  return {
    resumable: true,
    script: scriptRes.script,
    ...(scriptRes.scriptPath !== undefined ? { scriptPath: scriptRes.scriptPath } : {}),
    ...(scriptRes.savedName !== undefined ? { savedName: scriptRes.savedName } : {}),
    journal: j.journal,
  }
}
