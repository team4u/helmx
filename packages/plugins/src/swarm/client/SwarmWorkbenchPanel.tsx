/**
 * builtin:swarm right workbench panel (single sequential board orchestration card, Fast Refresh compliant).
 */
import type { ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helmx/protocol/browser'
import {
  Badge, Button, Callout, EmptyState, LoadingState, Stack, StatusLight, Tooltip, resolveLocalizedText,
  type BadgeTone, type LocalizedText, type StatusLightTone,
} from '@helmx/plugin-client'
import * as C from './copy.ts'
import { useSwarmPanelController } from './useSwarmPanelController.ts'
import {
  SwarmBoardPostsSection,
  SwarmCloseGroupDialog,
  SwarmMembersSection,
  SwarmRetainedWorktreesSection,
} from './SwarmPanelSections.tsx'

export function SwarmWorkbenchPanel(props?: Partial<WorkbenchPanelProps>): ReactNode {
  const s = useSwarmPanelController(props)
  const t = (text: LocalizedText): string => resolveLocalizedText(text, s.locale)

  if (s.conversationId === undefined || (!s.link && !s.hasArchivedTag)) {
    return (
      <div className="sw-panel">
        <EmptyState compact title={t(C.PANEL_EMPTY_TITLE)} hint={t(C.PANEL_EMPTY_HINT)} />
      </div>
    )
  }
  if (s.loading) {
    return <div className="sw-panel"><LoadingState label={t(C.PANEL_LOADING)} /></div>
  }
  if (!s.model || !s.effectiveBoard) {
    return (
      <div className="sw-panel">
        <Callout tone={s.loadError ? 'err' : 'warn'} title={t(C.PANEL_STATUS_LOAD_FAILED)}>
          {s.loadError ? <p className="sw-panel-error-text">{s.loadError}</p> : null}
          <Button size="xs" icon="rotate-cw" onClick={s.fallback.reload}>
            {t(C.PANEL_RETRY)}
          </Button>
        </Callout>
      </div>
    )
  }

  const { effectiveBoard, model } = s
  const currentConvId = s.conversationId
  const isCoordinatorActive =
    effectiveBoard.group.status === 'active' && currentConvId === effectiveBoard.group.coordinatorConversationId
  const headlineText = C.resolvePanelHeadlineText(effectiveBoard, s.locale)
  const resolvePostConversationId = (post: { from: string }): number =>
    post.from === 'coordinator'
      ? effectiveBoard.group.coordinatorConversationId
      : (s.memberConvByName.get(post.from) ?? currentConvId)
  const statusLight: StatusLightTone =
    model.status === 'attention' ? 'blocked' : model.status === 'completed' ? 'done' : 'working'
  const statusBadgeTone: BadgeTone =
    model.status === 'attention' ? 'warn' : model.status === 'completed' ? 'neutral' : 'accent'

  return (
    <div ref={s.panelRef} className="sw-panel">
      <div className="sw-panel-head">
        <span className="sw-panel-head-left">
          <StatusLight tone={statusLight} label={C.panelStatusLabel(model.status, s.locale)} />
          <span className="sw-panel-title" title={effectiveBoard.group.title}>{effectiveBoard.group.title}</span>
          <Badge tone={statusBadgeTone}>{C.panelStatusLabel(model.status, s.locale)}</Badge>
          <Badge tone="neutral" className="tabular-nums">{`${model.progress.done}/${model.progress.total}`}</Badge>
          {s.groupTiming ? (
            <Tooltip content={s.groupTiming.tooltip} className="sw-timing-tooltip">
              <span className="sw-panel-elapsed tabular-nums">{s.groupTiming.label}</span>
            </Tooltip>
          ) : null}
        </span>
        <Stack direction="horizontal" gap="xs" align="center" className="sw-panel-head-actions">
          {s.isFallbackData ? (
            <>
              <Badge tone="neutral">{t(C.PANEL_FALLBACK_NOTE)}</Badge>
              <Button size="xs" icon="rotate-cw" onClick={s.fallback.reload}>
                {t(C.PANEL_REFRESH)}
              </Button>
            </>
          ) : null}
          {isCoordinatorActive ? (
            <Button
              size="xs"
              icon="check-circle"
              className="sw-panel-close-btn"
              disabled={s.busyAction !== undefined}
              onClick={s.openCloseDialog}
            >
              {t(C.PANEL_CLOSE_GROUP)}
            </Button>
          ) : null}
        </Stack>
      </div>

      {headlineText ? <p className={`sw-panel-headline sw-panel-headline-${model.headlineTone}`}>{headlineText}</p> : null}

      {model.objective !== undefined ? (
        <div className="sw-panel-objective">
          <span className="sw-panel-kv-key">{t(C.PANEL_OBJECTIVE)}</span>
          <p className="sw-panel-objective-text">{model.objective}</p>
        </div>
      ) : null}

      <SwarmMembersSection
        locale={s.locale}
        effectiveBoard={effectiveBoard}
        model={model}
        nowMs={s.nowMs}
        isCoordinatorActive={isCoordinatorActive}
        busyAction={s.busyAction}
        onOpenConversation={s.ctx.openConversationDrawer}
        onAbortMember={s.runAbortMember}
      />

      {model.retainedWorktrees?.length ? (
        <SwarmRetainedWorktreesSection locale={s.locale} items={model.retainedWorktrees} />
      ) : null}

      <SwarmBoardPostsSection
        locale={s.locale}
        conversationId={currentConvId}
        effectiveBoard={effectiveBoard}
        model={model}
        historyExpanded={s.historyExpanded}
        highlightedSeq={s.highlightedSeq}
        jumpBackStack={s.jumpBackStack}
        peekState={s.peekState}
        peekPost={s.peekPost}
        peekAnchorRef={s.peekAnchorRef}
        peekLoading={s.peekReadState.loading}
        peekError={s.peekReadState.error}
        hasEarlier={s.readState.hasEarlier}
        loadingEarlier={s.readState.loadingEarlier}
        readLoading={s.readState.loading}
        readError={s.readState.error}
        resolvePostConversationId={resolvePostConversationId}
        onToggleHistory={() => s.setHistoryExpanded((v) => !v)}
        onJumpBack={s.handleJumpBack}
        onDismissJumpBack={() => s.setJumpBackStack([])}
        onLoadEarlier={s.readState.loadEarlier}
        onRetryRead={s.readState.retry}
        onOpenPeek={s.handleOpenPeek}
        onPushPeekRef={s.pushPeekRef}
        onPopPeekRef={s.popPeekRef}
        onLocateFromPeek={s.handleLocateFromPeek}
        onRetryPeek={s.peekReadState.retry}
        onClosePeek={() => s.setPeekState(undefined)}
      />

      {isCoordinatorActive ? (
        <SwarmCloseGroupDialog
          locale={s.locale}
          open={s.closeDialogOpen}
          closing={s.busyAction === 'close_group'}
          keepWorktree={s.closeKeepWorktree}
          abortRunning={s.closeAbortRunning}
          hasActiveWorkingMembers={effectiveBoard.activeWorkingMembers.length > 0}
          error={s.closeError}
          onKeepWorktreeChange={s.setCloseKeepWorktree}
          onAbortRunningChange={s.setCloseAbortRunning}
          onClose={s.dismissCloseDialog}
          onConfirm={s.confirmCloseGroup}
        />
      ) : null}
    </div>
  )
}
