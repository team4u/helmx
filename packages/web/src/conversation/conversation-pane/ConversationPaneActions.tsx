/**
 * Action cluster of the conversation top bar: outline popover, new topic, workbench (badge),
 * close / fullscreen / split controls, and the more menu (rename, compact, archive, reset,
 * delete). The drawer is an inspection surface stacked over the main context: main-stage
 * navigation actions (new topic) are never rendered inside it.
 */
import { useRef } from 'react'
import type { ConversationSummary } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  HelmxIcon,
  IconButton,
  Tooltip,
  type BadgeTone,
} from '@helmx/ui'
import { conversationsApi } from '../../lib/api.js'
import { useWebLocale } from '../../i18n/use-web-locale.js'
import { patchConversationArchived } from '../../shell/archive-ops.js'
import { isConversationDeletable } from '../../shell/sidebar-model.js'
import { formatModShiftShortcut, formatModShortcut } from '../../shell/shortcuts-model.js'
import { CloseSplitButton, SplitToggleButton } from '../../ui/SplitControls.js'
import { ConversationOutlinePopover } from '../ConversationOutlinePopover.js'
import type { WorkbenchSummaryBadge, WorkbenchTab } from '../workbench-model.js'
import type { ConversationPaneActions as ConversationPaneActionsApi } from './use-conversation-pane-actions.js'
import type { ConversationPaneOutline } from './use-conversation-pane-outline.js'

interface ConversationMoreMenuProps {
  conversation: ConversationSummary
  actionPending: string | null
  compactPending: boolean
  isCompacting: boolean
  archived: boolean
  canManageArchive: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  runAction: ConversationPaneActionsApi['runAction']
  onRename: () => void
  onRequestReset: () => void
  onRequestDelete: () => void
}

/** More menu: close auto-focus returns to the trigger unless the user interacted outside. */
function ConversationMoreMenu({
  conversation,
  actionPending,
  compactPending,
  isCompacting,
  archived,
  canManageArchive,
  open,
  onOpenChange,
  runAction,
  onRename,
  onRequestReset,
  onRequestDelete,
}: ConversationMoreMenuProps) {
  const { t } = useWebLocale()
  const moreButtonRef = useRef<HTMLButtonElement | null>(null)
  const moreInteractedOutsideRef = useRef(false)
  const archivePending = actionPending === 'archive' || actionPending === 'restore-archive'
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (next) moreInteractedOutsideRef.current = false
        onOpenChange(next)
      }}
    >
      <DropdownMenuTrigger asChild>
        <IconButton
          ref={moreButtonRef}
          icon={<HelmxIcon name="more" size={14} />}
          variant="ghost"
          size="sm"
          label={t('conv.pane.moreActions')}
          aria-expanded={open}
        />
      </DropdownMenuTrigger>
      <DropdownMenuPortal>
        <DropdownMenuContent
          className="pane-more-popover"
          align="end"
          sideOffset={6}
          onInteractOutside={() => {
            moreInteractedOutsideRef.current = true
          }}
          onCloseAutoFocus={(e) => {
            if (moreInteractedOutsideRef.current) {
              moreInteractedOutsideRef.current = false
              return
            }
            e.preventDefault()
            moreButtonRef.current?.focus()
          }}
        >
          <DropdownMenuItem
            className="popover-item"
            onSelect={() => {
              onRename()
            }}
          >
            <span className="pane-more-item-label">
              <HelmxIcon name="edit" size={13} />
              {t('conv.pane.renameConversation')}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            className="popover-item"
            disabled={actionPending !== null || isCompacting}
            onSelect={() => {
              void runAction('compact', () => conversationsApi.compact(conversation.id), t('conv.pane.compactionSubmitted'))
            }}
          >
            <span className="pane-more-item-label">
              <HelmxIcon
                name={compactPending ? 'loader' : 'archive'}
                size={13}
                className={compactPending ? 'spin-slow' : undefined}
              />
              {isCompacting ? t('conv.divider.compacting') : t('conv.pane.compactContext')}
            </span>
          </DropdownMenuItem>
          {canManageArchive && (
            <DropdownMenuItem
              className="popover-item"
              disabled={actionPending !== null}
              onSelect={() => {
                void runAction(
                  archived ? 'restore-archive' : 'archive',
                  () => patchConversationArchived(conversation, !archived),
                  archived ? t('conv.pane.restored') : t('conv.pane.archived'),
                )
              }}
            >
              <span className="pane-more-item-label">
                <HelmxIcon
                  name={archivePending ? 'loader' : archived ? 'rotate-ccw' : 'archive'}
                  size={13}
                  className={archivePending ? 'spin-slow' : undefined}
                />
                {archived ? t('conv.pane.restoreConversation') : t('conv.pane.archiveConversation')}
              </span>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="popover-separator" />
          <DropdownMenuItem
            className="popover-item popover-item-danger"
            danger
            disabled={actionPending !== null}
            onSelect={() => {
              onRequestReset()
            }}
          >
            <span className="pane-more-item-label">
              <HelmxIcon name={actionPending === 'reset' ? 'loader' : 'rotate-ccw'} size={13} />
              {t('conv.pane.resetContextCmd')}
            </span>
          </DropdownMenuItem>
          {isConversationDeletable(conversation) && (
            <DropdownMenuItem
              className="popover-item popover-item-danger"
              danger
              onSelect={() => {
                onRequestDelete()
              }}
            >
              <span className="pane-more-item-label">
                <HelmxIcon name="trash-2" size={13} />
                {t('conv.pane.deleteConversation')}
              </span>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  )
}

export interface ConversationPaneActionsProps {
  conversation: ConversationSummary
  isSplit?: boolean
  isDrawer?: boolean
  isCompacting: boolean
  compactPending: boolean
  actionPending: string | null
  canCreateThread: boolean
  archived: boolean
  canManageArchive: boolean
  outline: ConversationPaneOutline
  timelineHasItems: boolean
  workbench: {
    tabs: ReadonlyArray<WorkbenchTab>
    badge: WorkbenchSummaryBadge
    hasPanel: boolean
    /** Workbench drawer open on this (non-drawer) pane: the button shows as active. */
    active: boolean
    hasAnyArtifacts: boolean
  }
  split: { isSplitActive: boolean; toggleSplit: () => void }
  moreOpen: boolean
  onMoreOpenChange: (open: boolean) => void
  runAction: ConversationPaneActionsApi['runAction']
  onRename: () => void
  onNewThread: () => void
  onOpenWorkbench: () => void
  /** Drawer only: close the drawer and show the conversation on the main stage. */
  onOpenFullscreen: () => void
  onRequestReset: () => void
  onRequestDelete: () => void
  onCloseSplit?: () => void
  onCloseDrawer?: () => void
}

export function ConversationPaneActions({
  conversation,
  isSplit,
  isDrawer,
  isCompacting,
  compactPending,
  actionPending,
  canCreateThread,
  archived,
  canManageArchive,
  outline,
  timelineHasItems,
  workbench,
  split,
  moreOpen,
  onMoreOpenChange,
  runAction,
  onRename,
  onNewThread,
  onOpenWorkbench,
  onOpenFullscreen,
  onRequestReset,
  onRequestDelete,
  onCloseSplit,
  onCloseDrawer,
}: ConversationPaneActionsProps) {
  const { t } = useWebLocale()
  // 计数与色调由插件 public-doc badge 与内置产物共同决定。
  const workbenchCount = workbench.badge.totalCount
  const workbenchBadgeTone: BadgeTone = workbench.badge.tone === 'warn' ? 'warn' : workbench.badge.tone === 'accent' ? 'accent' : 'neutral'
  const showWorkbench = workbenchCount > 0 || workbench.hasPanel || workbench.hasAnyArtifacts
  return (
    <div className="pane-actions">
      <ConversationOutlinePopover
        open={outline.open}
        onOpenChange={outline.onOpenChange}
        hasItems={timelineHasItems}
        badgeCount={outline.badgeCount}
        nodes={outline.nodes}
        activeNodeKey={outline.activeNodeKey}
        totalRunMs={conversation.runDurationMs}
        liveTiming={conversation}
        summaryTurnCount={conversation.completionSeq > 0 ? conversation.completionSeq : undefined}
        hasEarlierHistory={outline.hasEarlierHistory}
        loadingEarlierHistory={outline.loadingEarlierHistory}
        onLoadEarlierHistory={outline.loadEarlierHistory}
        onSelectTarget={outline.onSelectTarget}
      />
      {canCreateThread && !isDrawer ? (
        <Button
          size="sm"
          icon={<HelmxIcon name="plus" size={12} />}
          aria-label={t('conv.pane.newTopic')}
          title={t('conv.pane.newTopicTitle', { shortcut: formatModShiftShortcut('O') })}
          disabled={actionPending !== null}
          onClick={onNewThread}
        >
          <span className="pane-action-label">{t('conv.pane.newTopic')}</span>
        </Button>
      ) : null}
      {showWorkbench ? (
        <Button
          size="sm"
          variant={workbench.active ? 'primary' : 'secondary'}
          icon={<HelmxIcon name="panel-right" size={12} />}
          aria-label={workbenchCount > 0 ? t('conv.pane.workbenchWithCount', { count: workbenchCount }) : t('conv.pane.workbench')}
          title={t('conv.pane.workbenchTitle', { shortcut: formatModShortcut('J') })}
          onClick={onOpenWorkbench}
        >
          <span className="pane-action-label">{t('conv.pane.workbench')}</span>
          {workbenchCount > 0 && (
            <Badge tone={workbenchBadgeTone} className="tabular-nums">
              {workbenchCount}
            </Badge>
          )}
        </Button>
      ) : null}
      {isDrawer && onCloseDrawer !== undefined ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<HelmxIcon name="external-link" size={12} />}
          className="conversation-drawer-primary-btn"
          aria-label={t('conv.pane.openFullscreen')}
          title={t('conv.pane.openFullscreenTitle')}
          onClick={onOpenFullscreen}
        >
          <span className="pane-action-label">{t('conv.pane.fullscreen')}</span>
        </Button>
      ) : isSplit && onCloseSplit !== undefined ? (
        <CloseSplitButton onCloseSplit={onCloseSplit} />
      ) : (
        <span className={split.isSplitActive ? undefined : 'pane-split-btn'}>
          <SplitToggleButton isSplitActive={split.isSplitActive} onToggleSplit={split.toggleSplit} />
        </span>
      )}
      <span className="pane-more-menu">
        <ConversationMoreMenu
          conversation={conversation}
          actionPending={actionPending}
          compactPending={compactPending}
          isCompacting={isCompacting}
          archived={archived}
          canManageArchive={canManageArchive}
          open={moreOpen}
          onOpenChange={onMoreOpenChange}
          runAction={runAction}
          onRename={onRename}
          onRequestReset={onRequestReset}
          onRequestDelete={onRequestDelete}
        />
      </span>
      {isDrawer && onCloseDrawer !== undefined ? (
        <Tooltip content={t('conv.pane.closeChildDrawer')} side="bottom">
          <Button
            size="sm"
            variant="ghost"
            icon={<HelmxIcon name="x" size={13} />}
            className="conversation-drawer-close-btn"
            aria-label={t('conv.pane.closeDrawerAria')}
            onClick={onCloseDrawer}
          >
            <span className="pane-action-label">{t('common.close')}</span>
          </Button>
        </Tooltip>
      ) : null}
    </div>
  )
}
