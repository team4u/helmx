/**
 * builtin:swarm tool-call timeline one-line renderer (26px `.trace-row`, Fast Refresh compliant).
 */
import { useMemo, type ReactNode } from 'react'
import type { ToolViewProps } from '@helmx/protocol/browser'
import {
  Badge, HelmxIcon, StatusLight, formatDurationMs, resolveLocalizedText,
  usePluginContext, usePluginDoc, usePluginLocale, useToolActivity, type HelmxLocale, type StatusLightTone,
} from '@helmx/plugin-client'
import { SWARM_WORKBENCH_PANEL_ID, type SwarmIndexDoc } from './models.ts'
import { isPlainObject, resolveConversationBoardLink } from './board-model.ts'
import { extractSwarmPresentationMeta, resolveSwarmToolClickTarget, resolveSwarmToolFacts, type SwarmToolFacts } from './model-tool-view.ts'
import { useElapsedNowMs } from './hooks.ts'
import * as C from './copy.ts'

const TOOL_TITLES: Readonly<Record<string, typeof C.TRACE_DISPATCH>> = {
  swarm_create_group: C.TRACE_CREATE_GROUP,
  swarm_update_group: C.TRACE_UPDATE_GROUP,
  swarm_dispatch_worker: C.TRACE_DISPATCH,
  swarm_board_post: C.TRACE_BOARD_POST,
  swarm_board_read: C.TRACE_BOARD_READ,
  swarm_board_status: C.TRACE_BOARD_STATUS,
  swarm_abort_worker: C.TRACE_ABORT,
  swarm_switch_worker_model: C.TRACE_SWITCH_MODEL,
  swarm_inspect_worker: C.TRACE_INSPECT,
  swarm_archive_worker: C.TRACE_ARCHIVE,
  swarm_close_group: C.TRACE_CLOSE_GROUP,
}

function buildTraceSummary(facts: SwarmToolFacts, locale: HelmxLocale): string {
  const parts: string[] = []
  switch (facts.toolName) {
    case 'swarm_create_group':
    case 'swarm_update_group':
      if (facts.groupTitle) parts.push(facts.groupTitle)
      break
    case 'swarm_dispatch_worker':
      if (facts.memberName) parts.push(`@${facts.memberName}`)
      if (facts.taskExcerpt) parts.push(facts.taskExcerpt)
      break
    case 'swarm_board_post':
      if (facts.postKind && facts.postKind in C.POST_KIND_LABELS) parts.push(C.postKindLabel(facts.postKind, locale))
      if (facts.postTargets?.length) {
        parts.push(`-> ${facts.postTargets.map((t) => (t === 'all' || t === 'coordinator' ? t : `@${t}`)).join(', ')}`)
      }
      if (facts.taskExcerpt) parts.push(facts.taskExcerpt)
      break
    case 'swarm_board_read':
      if (facts.postCount !== undefined) parts.push(C.tracePostCount(facts.postCount, locale))
      break
    case 'swarm_abort_worker':
      if (facts.memberName) parts.push(`@${facts.memberName}`)
      if (facts.aborted === false) parts.push(C.traceAbortedNoop(locale))
      break
    case 'swarm_switch_worker_model':
      if (facts.memberName) parts.push(`@${facts.memberName}`)
      if (facts.model) parts.push(facts.model)
      break
    case 'swarm_inspect_worker':
    case 'swarm_archive_worker':
      if (facts.memberName) parts.push(`@${facts.memberName}`)
      break
    case 'swarm_close_group':
      if (facts.retainedCount && facts.retainedCount > 0) parts.push(C.traceRetainedCount(facts.retainedCount, locale))
      break
  }
  return parts.join(' · ')
}

export function SwarmToolView(props: ToolViewProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const index = usePluginDoc<SwarmIndexDoc>('index')

  const meta = extractSwarmPresentationMeta(props)
  const facts = useMemo(() => resolveSwarmToolFacts(props.toolName, props.input, meta), [props.toolName, props.input, meta])
  const viewerConvId = props.conversationId ?? ctx.conversationId

  const targetGroupId = useMemo(() => {
    if (typeof meta?.['groupId'] === 'string' && meta['groupId']) return meta['groupId']
    if (isPlainObject(props.input) && typeof props.input['groupId'] === 'string' && props.input['groupId']) return props.input['groupId']
    return resolveConversationBoardLink(viewerConvId, index)?.groupId
  }, [meta, props.input, viewerConvId, index])

  const memberLookup = useMemo(() => {
    const byName = new Map<string, number>()
    if (targetGroupId && Array.isArray(index?.workers)) {
      for (const w of index.workers) {
        if (w?.groupId === targetGroupId && typeof w.name === 'string' && w.name && typeof w.conversationId === 'number' && !byName.has(w.name)) {
          byName.set(w.name, w.conversationId)
        }
      }
    }
    return (name: string): number | undefined => byName.get(name)
  }, [index, targetGroupId])

  const clickTarget = useMemo(() => resolveSwarmToolClickTarget(facts, { memberLookup }), [facts, memberLookup])
  const isRunning = props.status === 'running'
  const isError = props.status === 'error'
  useToolActivity(props.callId, isRunning)

  const nowMs = useElapsedNowMs(isRunning)
  const elapsedMs = isRunning
    ? props.startedAt !== undefined && nowMs !== undefined ? Math.max(0, nowMs - props.startedAt) : undefined
    : props.durationMs

  const lightTone: StatusLightTone = isRunning ? 'working' : isError ? 'failed' : 'done'
  const lightLabel = isRunning ? C.traceStatusRunning(locale) : isError ? C.traceStatusError(locale) : C.traceStatusDone(locale)
  const errorLine = isError && typeof props.result === 'string' ? (props.result.split(/\r?\n/, 1)[0] ?? '').trim() : ''
  const title = resolveLocalizedText(TOOL_TITLES[props.toolName] ?? C.TRACE_UNKNOWN_TOOL, locale)
  const summary = buildTraceSummary(facts, locale)
  const displaySummary = isError && errorLine ? errorLine : summary
  const seqBadge = facts.seq !== undefined ? `#${facts.seq}` : undefined

  // 右侧 external-link 仅提示「点击跳转」；折叠/展开统一由宿主行首 chevron 提供，
  // 无跳转目标的行不再可点（不伪造展开入口，调用详情经宿主 IO 面板查看）。
  const rowBody = (
    <>
      <span className="trace-row-left">
        <HelmxIcon name={facts.toolName === 'swarm_dispatch_worker' ? 'bot' : 'network'} size={12} />
        <span className="trace-tool-name sw-trace-name" title={title}>{title}</span>
        {displaySummary ? <span className={`trace-tool-summary${isError ? ' sw-trace-error' : ''}`} title={displaySummary}>{displaySummary}</span> : null}
      </span>
      <span className="trace-row-right sw-trace-right">
        {seqBadge ? <Badge tone="neutral" className="sw-trace-badge tabular-nums">{seqBadge}</Badge> : null}
        <StatusLight tone={lightTone} label={lightLabel} />
        {elapsedMs !== undefined ? <span className="trace-duration tabular-nums">{formatDurationMs(elapsedMs)}</span> : null}
        {clickTarget !== undefined ? <HelmxIcon name="external-link" size={11} className="trace-row-link" /> : null}
      </span>
    </>
  )

  if (clickTarget === undefined) {
    return (
      <div className="trace-entry">
        <div className={`trace-row sw-trace-row${isError ? ' trace-row-error' : ''}`}>{rowBody}</div>
      </div>
    )
  }

  const labelTarget =
    clickTarget.kind === 'member' && facts.memberName
      ? C.traceOpenMemberLabel(facts.memberName, locale)
      : C.traceOpenWorkbenchLabel(locale)

  return (
    <div className="trace-entry">
      <button
        type="button"
        className={`trace-row sw-trace-row sw-trace-row-btn${isError ? ' trace-row-error' : ''}`}
        aria-label={`${[title, summary, seqBadge].filter(Boolean).join(' ')} — ${labelTarget}`}
        onClick={() => {
          if (clickTarget.kind === 'member') ctx.openConversationDrawer(clickTarget.conversationId)
          else {
            const focusParams: Record<string, unknown> = {}
            if (targetGroupId !== undefined) focusParams['groupId'] = targetGroupId
            if (facts.seq !== undefined) focusParams['postSeq'] = facts.seq
            ctx.openWorkbench(SWARM_WORKBENCH_PANEL_ID, Object.keys(focusParams).length > 0 ? focusParams : undefined)
          }
        }}
      >
        {rowBody}
      </button>
    </div>
  )
}
