/**
 * Composer toolbar pill + controlled ModelPickerControl for builtin:tiers one-turn model borrow
 * (`COMPOSER_TOOLBAR_SLOT`).
 * - Unarmed & closed: zero visible chrome / zero Tab stops (mounts invisible PopoverAnchor only);
 * - Armed (`armed` or standby draftMeta): compact 24px pill `[ Next turn: <label> × ]`;
 * - Active (`active`): compact 24px pill `[ This turn: <label> × ]` where `×` disables auto-restore
 *   even while busy without triggering nested buttons or opening the Popover.
 * - Handles `/model` locally via `useComposerCommand('borrow-model', openPicker)` and subscribes
 *   to panel-isolated events from `BorrowMenuItem`.
 * Exports only React components (Fast Refresh compliant).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ComposerToolbarSlotProps, ConversationSummary } from '@helmx/protocol/browser'
import {
  HelmxIcon,
  ModelPickerControl,
  resolveLocalizedText,
  useComposerCommand,
  usePluginAction,
  usePluginContext,
  usePluginLocale,
  usePluginSessionDoc,
} from '@helmx/plugin-client'
import {
  TIERS_BORROW_COMMAND_ID,
  TIERS_BORROW_SESSION_DOC,
  TIERS_INPUT_META_KEY,
  formatBorrowTargetLabel,
  isConversationBusyForBorrow,
  isTiersBorrowEligibleConversation,
  makeBorrowScopeKey,
  makeStandbyBorrowMetaValue,
  parseTierBorrowSessionView,
  readStandbyBorrowDraft,
  resolveBorrowPanel,
  subscribeBorrowPickerOpen,
  type TierBorrowSessionView,
} from './borrow-models.ts'
import {
  TIERS_COPY as C,
  borrowActivePillTitle,
  borrowArmedPillTitle,
  buildTiersPickerCopy,
  tiersActionFailed,
} from './copy.ts'
import './styles.css'

function BorrowToolbarPillConversation({
  conversation,
  disabled,
}: {
  conversation: ConversationSummary
  disabled: boolean
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = useCallback(
    (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale),
    [locale],
  )
  const pickerCopy = useMemo(() => buildTiersPickerCopy(locale), [locale])
  const rawDoc = usePluginSessionDoc<unknown>(TIERS_BORROW_SESSION_DOC, {
    conversationId: conversation.id,
  })
  const rawDocRef = useRef<unknown>(rawDoc)
  rawDocRef.current = rawDoc

  const [optimistic, setOptimistic] = useState<{
    conversationId: number
    baseDoc: unknown
    view: TierBorrowSessionView | null
  } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    setOptimistic((prev) =>
      prev !== null && prev.conversationId === conversation.id && prev.baseDoc === rawDoc ? prev : null,
    )
  }, [conversation.id, rawDoc])

  const docView = parseTierBorrowSessionView(rawDoc)
  const effectiveBorrow =
    optimistic !== null && optimistic.conversationId === conversation.id && optimistic.baseDoc === rawDoc
      ? optimistic.view
      : docView

  const busy = isConversationBusyForBorrow(conversation)

  const borrowAction = usePluginAction({
    notifyError: true,
    formatError: (err) => tiersActionFailed(err, locale),
  })

  const openPicker = useCallback((): void => {
    if (disabled) return
    if (busy) {
      ctx.notify(t(C.borrowBusyNotice), 'warning')
      return
    }
    setPickerOpen(true)
  }, [busy, ctx, disabled, t])

  useComposerCommand(TIERS_BORROW_COMMAND_ID, openPicker)

  useEffect(() => {
    return subscribeBorrowPickerOpen(
      () =>
        makeBorrowScopeKey(resolveBorrowPanel(rootRef.current), {
          conversationId: conversation.id,
        }),
      openPicker,
    )
  }, [conversation.id, openPicker])

  const handleApply = useCallback(
    async (model: string, thinkingLevel: string | null): Promise<void> => {
      if (borrowAction.pending) return
      const baseDoc = rawDocRef.current
      await borrowAction.run(
        'set_borrow',
        {
          conversationId: conversation.id,
          model,
          ...(thinkingLevel !== null && thinkingLevel !== '' ? { effort: thinkingLevel } : {}),
        },
        {
          conversationId: conversation.id,
          onSuccess: (raw) => {
            const parsed = parseTierBorrowSessionView(raw)
            if (parsed !== null && rawDocRef.current === baseDoc) {
              setOptimistic({ conversationId: conversation.id, baseDoc, view: parsed })
            }
          },
        },
      )
    },
    [borrowAction, conversation.id],
  )

  const handleClear = useCallback(async (): Promise<void> => {
    if (borrowAction.pending) return
    const baseDoc = rawDocRef.current
    await borrowAction.run(
      'clear_borrow',
      { conversationId: conversation.id },
      {
        conversationId: conversation.id,
        onSuccess: () => {
          if (rawDocRef.current === baseDoc) {
            setOptimistic({ conversationId: conversation.id, baseDoc, view: null })
          }
        },
      },
    )
  }, [borrowAction, conversation.id])

  const hasBorrow = effectiveBorrow !== null
  const isActive = effectiveBorrow?.phase === 'active'
  const pickerDisabled = disabled || busy || borrowAction.pending
  const clearDisabled = disabled || borrowAction.pending
  const wrapperClass = hasBorrow
    ? `tiers-borrow-pill ${isActive ? 'tiers-borrow-pill--active' : 'tiers-borrow-pill--armed'}`
    : pickerOpen
      ? 'tiers-borrow-anchor-open'
      : 'tiers-borrow-anchor-idle'

  const targetText =
    effectiveBorrow !== null
      ? formatBorrowTargetLabel(effectiveBorrow.targetLabel, effectiveBorrow.effort)
      : ''
  const pillPrefix = isActive ? t(C.borrowPillActivePrefix) : t(C.borrowPillArmedPrefix)
  const mainTitle =
    effectiveBorrow !== null
      ? isActive
        ? borrowActivePillTitle(effectiveBorrow.targetConcreteModel, locale)
        : borrowArmedPillTitle(effectiveBorrow.targetConcreteModel, locale)
      : ''
  const clearAria = isActive ? t(C.borrowClearActiveAria) : t(C.borrowClearArmedAria)

  return (
    <span
      ref={rootRef}
      className={wrapperClass}
      data-tiers-borrow-phase={effectiveBorrow?.phase ?? 'none'}
      data-tiers-borrow-model={effectiveBorrow?.targetModel}
    >
      <ModelPickerControl
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        showResetDefault={false}
        enableShortcut={false}
        effectiveModel={effectiveBorrow?.targetModel ?? conversation.model}
        activeThinkingLevel={effectiveBorrow?.effort ?? ''}
        copy={pickerCopy}
        disabled={pickerDisabled}
        pending={borrowAction.pending}
        onNotice={(msg, tone) => ctx.notify(msg, tone)}
        onApply={handleApply}
        renderTrigger={({ open }) =>
          hasBorrow ? (
            <button
              type="button"
              className="tiers-borrow-pill-main"
              aria-expanded={open}
              disabled={pickerDisabled}
              title={mainTitle}
            >
              {borrowAction.pending ? (
                <HelmxIcon name="loader" size={11} className="spin-slow" />
              ) : (
                <HelmxIcon name="sparkles" size={11} />
              )}
              <span className="tiers-borrow-pill-prefix">{pillPrefix}</span>
              <span className="tiers-borrow-pill-model mono">{targetText}</span>
            </button>
          ) : null
        }
      />
      {hasBorrow ? (
        <button
          type="button"
          className="tiers-borrow-pill-clear"
          aria-label={clearAria}
          title={clearAria}
          disabled={clearDisabled}
          onClick={() => void handleClear()}
        >
          <HelmxIcon name="x" size={11} />
        </button>
      ) : null}
    </span>
  )
}

function BorrowToolbarPillStandby({
  profileId,
  effectiveModel,
  draftMeta,
  setDraftMeta,
  disabled,
}: {
  profileId: string
  effectiveModel?: string
  draftMeta?: Readonly<Record<string, unknown>>
  setDraftMeta: (key: string, value: unknown) => void
  disabled: boolean
}): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = useCallback(
    (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale),
    [locale],
  )
  const pickerCopy = useMemo(() => buildTiersPickerCopy(locale), [locale])
  const [pickerOpen, setPickerOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const standbyBorrow = readStandbyBorrowDraft(draftMeta)

  const openPicker = useCallback((): void => {
    if (disabled) return
    setPickerOpen(true)
  }, [disabled])

  useComposerCommand(TIERS_BORROW_COMMAND_ID, openPicker)

  useEffect(() => {
    return subscribeBorrowPickerOpen(
      () => makeBorrowScopeKey(resolveBorrowPanel(rootRef.current), { profileId }),
      openPicker,
    )
  }, [profileId, openPicker])

  const handleApply = useCallback(
    (model: string, thinkingLevel: string | null): void => {
      setDraftMeta(TIERS_INPUT_META_KEY, makeStandbyBorrowMetaValue(model, thinkingLevel))
    },
    [setDraftMeta],
  )

  const handleClear = useCallback((): void => {
    setDraftMeta(TIERS_INPUT_META_KEY, undefined)
  }, [setDraftMeta])

  const hasBorrow = standbyBorrow !== null
  const wrapperClass = hasBorrow
    ? 'tiers-borrow-pill tiers-borrow-pill--armed'
    : pickerOpen
      ? 'tiers-borrow-anchor-open'
      : 'tiers-borrow-anchor-idle'
  const targetText =
    standbyBorrow !== null
      ? formatBorrowTargetLabel(standbyBorrow.borrowModel, standbyBorrow.effort)
      : ''
  const mainTitle =
    standbyBorrow !== null ? borrowArmedPillTitle(standbyBorrow.borrowModel, locale) : ''
  const clearAria = t(C.borrowClearArmedAria)

  return (
    <span
      ref={rootRef}
      className={wrapperClass}
      data-tiers-borrow-phase={hasBorrow ? 'armed' : 'none'}
      data-tiers-borrow-model={standbyBorrow?.borrowModel}
    >
      <ModelPickerControl
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        showResetDefault={false}
        enableShortcut={false}
        effectiveModel={standbyBorrow?.borrowModel ?? effectiveModel}
        activeThinkingLevel={standbyBorrow?.effort ?? ''}
        copy={pickerCopy}
        disabled={disabled}
        onNotice={(msg, tone) => ctx.notify(msg, tone)}
        onApply={handleApply}
        renderTrigger={({ open }) =>
          hasBorrow ? (
            <button
              type="button"
              className="tiers-borrow-pill-main"
              aria-expanded={open}
              disabled={disabled}
              title={mainTitle}
            >
              <HelmxIcon name="sparkles" size={11} />
              <span className="tiers-borrow-pill-prefix">{t(C.borrowPillArmedPrefix)}</span>
              <span className="tiers-borrow-pill-model mono">{targetText}</span>
            </button>
          ) : null
        }
      />
      {hasBorrow ? (
        <button
          type="button"
          className="tiers-borrow-pill-clear"
          aria-label={clearAria}
          title={clearAria}
          disabled={disabled}
          onClick={handleClear}
        >
          <HelmxIcon name="x" size={11} />
        </button>
      ) : null}
    </span>
  )
}

export function BorrowToolbarPill(props: ComposerToolbarSlotProps): ReactNode {
  if (props.conversation !== undefined) {
    if (!isTiersBorrowEligibleConversation(props.conversation)) {
      return null
    }
    return (
      <BorrowToolbarPillConversation
        conversation={props.conversation}
        disabled={props.disabled === true}
      />
    )
  }
  if (props.profileId === undefined || props.setDraftMeta === undefined) {
    return null
  }
  return (
    <BorrowToolbarPillStandby
      profileId={props.profileId}
      effectiveModel={props.effectiveModel}
      draftMeta={props.draftMeta}
      setDraftMeta={props.setDraftMeta}
      disabled={props.disabled === true}
    />
  )
}
