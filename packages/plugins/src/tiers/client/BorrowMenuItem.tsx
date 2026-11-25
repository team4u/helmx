/**
 * Unified composer `+` menu item for builtin:tiers one-turn model borrow (`COMPOSER_MENU_SLOT`).
 * Works on both eligible top-level human conversations and standby drafts; returns null on
 * subagents / `helmx`-owned conversations without opening subscriptions.
 * Exports only React components (Fast Refresh compliant).
 */
import { useRef, type ReactNode } from 'react'
import type { ComposerMenuSlotProps, ConversationSummary } from '@helmx/protocol/browser'
import {
  DropdownMenuItem,
  HelmxIcon,
  resolveLocalizedText,
  usePluginContext,
  usePluginLocale,
  usePluginSessionDoc,
} from '@helmx/plugin-client'
import {
  TIERS_BORROW_SESSION_DOC,
  emitBorrowPickerOpen,
  isConversationBusyForBorrow,
  isTiersBorrowEligibleConversation,
  makeBorrowScopeKey,
  parseTierBorrowSessionView,
  readStandbyBorrowDraft,
  resolveBorrowPanel,
} from './borrow-models.ts'
import { TIERS_COPY as C } from './copy.ts'
import './styles.css'

function scheduleBorrowPickerOpen(scopeKey: string): void {
  const fire = (): void => {
    emitBorrowPickerOpen(scopeKey)
  }
  const deferFrame = (): void => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(fire)
    } else {
      fire()
    }
  }
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(deferFrame)
  } else {
    setTimeout(fire, 0)
  }
}

function BorrowMenuItemConversation({
  conversation,
  disabled,
  onCloseMenu,
}: {
  conversation: ConversationSummary
  disabled: boolean
  onCloseMenu?: () => void
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const itemRef = useRef<HTMLDivElement | null>(null)
  const rawDoc = usePluginSessionDoc<unknown>(TIERS_BORROW_SESSION_DOC, {
    conversationId: conversation.id,
  })
  const borrow = parseTierBorrowSessionView(rawDoc)
  const busy = isConversationBusyForBorrow(conversation)
  const activeBorrow = borrow?.phase === 'active'
  const hasBorrow = borrow !== null
  const isDisabled = disabled || (busy && !activeBorrow)

  return (
    <DropdownMenuItem
      ref={itemRef}
      className={`tiers-borrow-menu-item${hasBorrow ? ' tiers-borrow-menu-item--active' : ''}`}
      disabled={isDisabled}
      title={busy && !activeBorrow ? t(C.borrowMenuBusyTitle) : undefined}
      data-tiers-borrow-phase={borrow?.phase ?? 'none'}
      onSelect={() => {
        const panel = resolveBorrowPanel(itemRef.current, { checkOpenPlusTrigger: true })
        const scopeKey = makeBorrowScopeKey(panel, { conversationId: conversation.id })
        onCloseMenu?.()
        if (busy && activeBorrow) {
          ctx.notify(t(C.borrowMenuActiveBusyHint), 'info')
          return
        }
        scheduleBorrowPickerOpen(scopeKey)
      }}
    >
      <HelmxIcon name="sparkles" size={14} className="tiers-borrow-menu-icon" />
      <span className="tiers-borrow-menu-label">{t(C.borrowMenuLabel)}</span>
      <span className="tiers-borrow-menu-trailing">
        {hasBorrow ? <HelmxIcon name="check" size={13} className="tiers-borrow-menu-check" /> : null}
        <span className="tiers-borrow-menu-hint mono">/model</span>
      </span>
    </DropdownMenuItem>
  )
}

function BorrowMenuItemStandby({
  profileId,
  draftMeta,
  disabled,
  onCloseMenu,
}: {
  profileId: string
  draftMeta?: Readonly<Record<string, unknown>>
  disabled: boolean
  onCloseMenu?: () => void
}): ReactNode {
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const itemRef = useRef<HTMLDivElement | null>(null)
  const armed = readStandbyBorrowDraft(draftMeta) !== null

  return (
    <DropdownMenuItem
      ref={itemRef}
      className={`tiers-borrow-menu-item${armed ? ' tiers-borrow-menu-item--active' : ''}`}
      disabled={disabled}
      data-tiers-borrow-phase={armed ? 'armed' : 'none'}
      onSelect={() => {
        const panel = resolveBorrowPanel(itemRef.current, { checkOpenPlusTrigger: true })
        const scopeKey = makeBorrowScopeKey(panel, { profileId })
        onCloseMenu?.()
        scheduleBorrowPickerOpen(scopeKey)
      }}
    >
      <HelmxIcon name="sparkles" size={14} className="tiers-borrow-menu-icon" />
      <span className="tiers-borrow-menu-label">{t(C.borrowMenuLabel)}</span>
      <span className="tiers-borrow-menu-trailing">
        {armed ? <HelmxIcon name="check" size={13} className="tiers-borrow-menu-check" /> : null}
        <span className="tiers-borrow-menu-hint mono">/model</span>
      </span>
    </DropdownMenuItem>
  )
}

export function BorrowMenuItem(props: ComposerMenuSlotProps): ReactNode {
  if (props.conversation !== undefined) {
    if (!isTiersBorrowEligibleConversation(props.conversation)) {
      return null
    }
    return (
      <BorrowMenuItemConversation
        conversation={props.conversation}
        disabled={props.disabled === true}
        onCloseMenu={props.onCloseMenu}
      />
    )
  }
  if (props.profileId === undefined || props.setDraftMeta === undefined) {
    return null
  }
  return (
    <BorrowMenuItemStandby
      profileId={props.profileId}
      draftMeta={props.draftMeta}
      disabled={props.disabled === true}
      onCloseMenu={props.onCloseMenu}
    />
  )
}
