/**
 * builtin:swarm composer activity tray (COMPOSER_DOCK_SLOT, coordinator-only, Fast Refresh compliant).
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { ComposerScopeProps } from '@helmx/protocol'
import {
  DockTray, DockTrayRow, HelmxIcon, Tooltip, resolveLocalizedText,
  useConversation, useConversations, usePluginContext, usePluginDoc, usePluginLocale, usePluginSessionDoc,
} from '@helmx/plugin-client'
import { SWARM_WORKBENCH_PANEL_TARGET, type SwarmIndexDoc } from './models.ts'
import { buildSwarmTraySummary, resolveSwarmTrayLiveSnippet, type SwarmTrayItem } from './model-tray.ts'
import { resolveGroupTimingView, resolveTrayMemberTimingView } from './model-timing.ts'
import { parseBoardView, resolveConversationBoardLink, type BoardViewDoc } from './board-model.ts'
import { useElapsedNowMs } from './hooks.ts'
import * as C from './copy.ts'

function SwarmTrayLiveLine(props: {
  conversationId: number | undefined; isBlocked: boolean; fallback?: string; emptyFallback?: string; inline?: boolean
}): ReactNode {
  const locale = usePluginLocale()
  const conv = useConversation(props.conversationId, { includeDetail: false })
  const snippet =
    props.conversationId !== undefined
      ? resolveSwarmTrayLiveSnippet(
          {
            isBlocked: props.isBlocked,
            ...(conv.summary ? { summary: conv.summary } : {}),
            ...(conv.live ? { live: conv.live } : {}),
            ...(conv.pendingAsks[0] ? { pendingAsk: conv.pendingAsks[0] } : {}),
            ...(conv.loadError ? { detailError: conv.loadError } : {}),
            ...(props.fallback ? { fallbackDoing: props.fallback } : {}),
          },
          locale,
        )
      : undefined
  const text = snippet ?? props.emptyFallback
  if (!text?.trim()) return null
  return <span className={props.inline ? 'dock-tray-frontline sw-tray-frontline' : 'dock-tray-row-live sw-tray-row-live'} title={text}>{text}</span>
}

function SwarmTrayRow(props: { item: SwarmTrayItem; nowMs: number | undefined; busy: boolean; onAbort: (key: string, name: string) => void }): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { item, nowMs } = props
  const rowTiming = resolveTrayMemberTimingView(item, nowMs, locale)
  return (
    <DockTrayRow
      classPrefix="sw-tray"
      status={item.isBlocked ? 'blocked' : 'running'}
      statusLabel={C.memberLiveStateLabel(item.isBlocked ? 'blocked' : 'working', locale)}
      title={`@${item.name}`}
      idText={`#${item.conversationId}`}
      badge={
        rowTiming ? (
          <Tooltip content={rowTiming.tooltip} className="sw-timing-tooltip">
            <span className={`dock-tray-elapsed sw-tray-row-elapsed tabular-nums${rowTiming.isWarn ? ' sw-tray-row-elapsed-warn' : ''}`}>{rowTiming.label}</span>
          </Tooltip>
        ) : undefined
      }
      live={<SwarmTrayLiveLine conversationId={item.conversationId} isBlocked={item.isBlocked} fallback={item.doing} />}
      onOpen={() => ctx.openConversationDrawer(item.conversationId)}
      openAriaLabel={`@${item.name} — ${C.trayRowOpenLabel(item.name, locale)}`}
      actions={
        <button type="button" className="btn btn-xs btn-danger" disabled={props.busy} onClick={() => props.onAbort(`abort:${item.name}`, item.name)}>
          <HelmxIcon name="square" size={11} /><span>{resolveLocalizedText(C.ACTION_ABORT, locale)}</span>
        </button>
      }
    />
  )
}

function SwarmCoordinatorTray(props: { conversationId: number; groupId: string }): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const { conversationId, groupId } = props
  const conversations = useConversations()
  const [expanded, setExpanded] = useState(false)
  const [busyKey, setBusyKey] = useState<string | undefined>(undefined)

  const rawBoard = usePluginSessionDoc<BoardViewDoc | null>('board-view', { conversationId })
  const board = useMemo(() => {
    const parsed = rawBoard !== undefined ? parseBoardView(rawBoard) : undefined
    return parsed && parsed.group.id === groupId && parsed.group.coordinatorConversationId === conversationId && parsed.group.status === 'active'
      ? parsed
      : undefined
  }, [rawBoard, conversationId, groupId])

  const summary = useMemo(() => (board ? buildSwarmTraySummary(board, conversations) : undefined), [board, conversations])
  const nowMs = useElapsedNowMs(Boolean(summary && summary.items.length > 0))
  if (!summary || summary.items.length === 0 || !board) return null

  const hasBlocked = summary.blockedCount > 0
  const countText = C.trayCount(summary.blockedCount, summary.workingCount, locale)
  const runAbort = (key: string, memberName: string): void => {
    if (busyKey !== undefined) return
    setBusyKey(key)
    void ctx
      .callAction('abort_worker', { groupId: board.group.id, name: memberName }, { conversationId })
      .catch((err: unknown) => ctx.notify(C.trayAbortFailed(err instanceof Error ? err.message : String(err), locale), 'error'))
      .finally(() => setBusyKey(undefined))
  }

  const frontlineText = summary.frontline ? C.trayFrontline(summary.frontline, locale) : undefined
  const headlineItem = summary.items[0]
  const groupTiming = resolveGroupTimingView(board, conversations, nowMs, locale)
  const baseTitle = resolveLocalizedText(expanded ? C.TRAY_COLLAPSE : C.TRAY_EXPAND, locale)

  return (
    <DockTray
      classPrefix="sw-tray"
      warn={hasBlocked}
      regionLabel={resolveLocalizedText(C.TRAY_REGION_ARIA, locale)}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      toggleLabel={C.trayToggleLabel(expanded, countText, locale)}
      toggleTitle={groupTiming ? `${baseTitle}\n${groupTiming.tooltip}` : baseTitle}
      status={hasBlocked ? 'blocked' : 'running'}
      statusLabel={countText}
      badge={<span className="badge badge-neutral dock-tray-badge sw-tray-badge tabular-nums">{C.trayProgress(summary.doneCount, summary.activeCount, locale)}</span>}
      count={summary.items.length > 1 || expanded ? countText : undefined}
      frontline={
        headlineItem ? (
          <SwarmTrayLiveLine conversationId={headlineItem.conversationId} isBlocked={headlineItem.isBlocked} fallback={headlineItem.doing} emptyFallback={frontlineText} inline />
        ) : frontlineText ? (
          <span className="dock-tray-frontline sw-tray-frontline">{frontlineText}</span>
        ) : undefined
      }
      elapsed={groupTiming?.label}
      barAction={
        <button type="button" className="btn btn-xs dock-tray-workbench sw-tray-workbench" onClick={() => ctx.openWorkbench(SWARM_WORKBENCH_PANEL_TARGET)}>
          <HelmxIcon name="network" size={11} /><span>{resolveLocalizedText(C.TRAY_WORKBENCH, locale)}</span>
        </button>
      }
    >
      {summary.items.map((item) => (
        <SwarmTrayRow key={item.key} item={item} nowMs={nowMs} busy={busyKey !== undefined} onAbort={runAbort} />
      ))}
    </DockTray>
  )
}

export function SwarmActiveTray(props?: Partial<ComposerScopeProps>): ReactNode {
  const ctx = usePluginContext()
  const conversationId = props?.conversation?.id ?? ctx.conversationId
  const index = usePluginDoc<SwarmIndexDoc>('index')
  const link = useMemo(() => resolveConversationBoardLink(conversationId, index), [conversationId, index])
  if (conversationId === undefined || !link || link.coordinatorConversationId !== conversationId) return null
  return <SwarmCoordinatorTray key={conversationId} conversationId={conversationId} groupId={link.groupId} />
}
