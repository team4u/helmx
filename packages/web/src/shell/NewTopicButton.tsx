/**
 * Shared New Topic trigger + dropdown candidate menu used across
 * ConversationOverview toolbar, SidebarConversationList header, and empty guide.
 */
import { useRef, type ReactNode } from 'react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  HelmxIcon,
  IconButton,
  Stack,
  Tooltip,
} from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatModShiftShortcut } from './shortcuts-model.js'
import type { AgentStanding } from './sidebar-model.js'
import { RemoteNodeTag } from './SidebarPrimitives.js'

export interface NewTopicButtonProps {
  candidates: ReadonlyArray<AgentStanding>
  onSelectProfile: (profileId: string, opts?: { flush?: boolean }) => void
  /** `'toolbar'` = Overview header button, `'icon'` = compact sidebar icon, `'empty'` = empty state CTA. */
  variant: 'toolbar' | 'icon' | 'empty'
  className?: string
  align?: 'start' | 'end'
  active?: boolean
}

export function NewTopicButton({
  candidates,
  onSelectProfile,
  variant,
  className,
  align = variant === 'empty' ? 'start' : 'end',
  active = false,
}: NewTopicButtonProps): ReactNode {
  const { t } = useWebLocale()
  const pickedRef = useRef(false)
  if (candidates.length === 0) return null

  const newTopicShortcut = formatModShiftShortcut('O')
  const singleCandidate = candidates.length === 1 ? (candidates[0] ?? null) : null

  if (singleCandidate !== null) {
    const title = t('shell.agents.newTopicUnderWithShortcut', {
      label: singleCandidate.label,
      shortcut: newTopicShortcut,
    })
    if (variant === 'icon') {
      return (
        <Tooltip content={title} side="top">
          <IconButton
            variant="ghost"
            size="xs"
            className={className}
            icon={<HelmxIcon name="plus" size={13} />}
            aria-label={t('conv.pane.newTopic')}
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelectProfile(singleCandidate.profileId)}
          />
        </Tooltip>
      )
    }
    return (
      <Button
        variant={variant === 'toolbar' ? 'primary' : 'secondary'}
        size="sm"
        className={className}
        icon={<HelmxIcon name="plus" size={12} />}
        aria-label={t('conv.pane.newTopic')}
        title={title}
        onClick={() => onSelectProfile(singleCandidate.profileId)}
      >
        {variant === 'toolbar' ? (
          <span className="pane-action-label">{t('conv.pane.newTopic')}</span>
        ) : (
          t('conv.pane.newTopic')
        )}
      </Button>
    )
  }

  const multiTitle = t('conv.pane.newTopicWithShortcut', { shortcut: newTopicShortcut })

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) pickedRef.current = false
      }}
    >
      {variant === 'icon' ? (
        <Tooltip content={multiTitle} side="top">
          <DropdownMenuTrigger asChild>
            <IconButton
              variant="ghost"
              size="xs"
              className={className}
              icon={<HelmxIcon name="plus" size={13} />}
              aria-label={t('conv.pane.newTopic')}
              aria-haspopup="menu"
              aria-current={active ? 'page' : undefined}
            />
          </DropdownMenuTrigger>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>
          <Button
            variant={variant === 'toolbar' ? 'primary' : 'secondary'}
            size="sm"
            className={className}
            icon={<HelmxIcon name="plus" size={12} />}
            aria-label={t('conv.pane.newTopic')}
            title={multiTitle}
            aria-haspopup="menu"
          >
            <Stack inline direction="horizontal" gap="xs" align="center">
              {variant === 'toolbar' ? (
                <span className="pane-action-label">{t('conv.pane.newTopic')}</span>
              ) : (
                <span>{t('conv.pane.newTopic')}</span>
              )}
              <HelmxIcon name="chevron-down" size={11} />
            </Stack>
          </Button>
        </DropdownMenuTrigger>
      )}
      <DropdownMenuPortal>
        <DropdownMenuContent
          className="pane-more-popover"
          align={align}
          sideOffset={4}
          onCloseAutoFocus={(e) => {
            if (pickedRef.current) {
              pickedRef.current = false
              e.preventDefault()
            }
          }}
        >
          {candidates.map((standing) => {
            const nodeId = standing.primaryConversation?.nodeId
            const remoteNodeId = nodeId !== undefined && nodeId !== '' && nodeId !== 'local' ? nodeId : null
            return (
              <DropdownMenuItem
                key={standing.profileId}
                title={t('shell.agents.newTopicUnder', { label: standing.label })}
                onSelect={() => {
                  pickedRef.current = true
                  onSelectProfile(standing.profileId, { flush: false })
                }}
              >
                <span className="pane-more-item-label">
                  <HelmxIcon name="bot" size={13} />
                  {standing.label}
                  {remoteNodeId !== null && <RemoteNodeTag nodeId={remoteNodeId} />}
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenuPortal>
    </DropdownMenu>
  )
}
