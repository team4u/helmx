import { useId, useMemo, useState } from 'react'
import { resolveLocalizedText, type AskFieldSpec, type AskSpec } from '@helmx/protocol/browser'
import { asksApi } from '../lib/api.js'
import {
  Button,
  Callout,
  Field,
  HelperText,
  HelmxIcon,
  IconButton,
  Input,
  ModelPickerControl,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  Select,
  Stack,
  StatusLight,
} from '@helmx/plugin-client'
import { useConversations, usePendingAsks, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { collectSubtreeIds } from './ancestry-model.js'
import { useModelPickerControlAdapter } from './model-picker-adapter.js'

export interface AskDockProps {
  conversationId: number
}

/** Source-conversation badge: shown when the ask belongs to another
 * conversation; clicking opens that child conversation's drawer. */
interface AskSourceInfo {
  conversationId: number
  title: string
}

interface TerminalSnapshot {
  source: 'context' | 'description'
  text: string
  prefix?: string
}

/** Extract the terminal snapshot (last 40 lines) from the ask extension field
 * terminalSnapshot or from a fenced block in resolved descriptionText (stripping fence lines). */
function extractTerminalSnapshot(ask: AskSpec, descriptionText: string): TerminalSnapshot | undefined {
  const extra = ask as AskSpec & { context?: { terminalSnapshot?: unknown } }
  const fromContext = extra.context?.terminalSnapshot
  if (typeof fromContext === 'string' && fromContext.trim() !== '') {
    return { source: 'context', text: lastLines(fromContext, 40) }
  }
  const desc = descriptionText
  const marker = desc.indexOf('```')
  if (marker !== -1) {
    const prefix = desc.slice(0, marker).trim()
    let body = desc.slice(marker + 3)
    const firstNewline = body.indexOf('\n')
    if (firstNewline !== -1) {
      body = body.slice(firstNewline + 1)
    }
    const closing = body.lastIndexOf('```')
    if (closing !== -1) {
      body = body.slice(0, closing)
    }
    if (body.trim() !== '') {
      return { source: 'description', text: lastLines(body, 40), ...(prefix !== '' ? { prefix } : {}) }
    }
  }
  return undefined
}

function lastLines(text: string, max: number): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.length <= max ? lines.join('\n') : lines.slice(-max).join('\n')
}

function initialAskAnswers(fields: ReadonlyArray<AskFieldSpec>): Record<string, string> {
  const initial: Record<string, string> = {}
  for (const field of fields) {
    if (typeof field.defaultValue === 'string' && field.defaultValue !== '') {
      initial[field.name] = field.defaultValue
    }
  }
  return initial
}

function AskFieldInput({
  conversationId,
  field,
  fieldId,
  fieldLabel,
  value,
  onChange,
  disabled,
}: {
  conversationId: number
  field: AskFieldSpec
  fieldId: string
  fieldLabel: string
  value: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  const { locale, t } = useWebLocale()
  const pickerAdapter = useModelPickerControlAdapter(conversationId)
  if (field.type === 'select') {
    const options = [
      { value: '', label: t('composer.ask.selectPlaceholder') },
      ...(field.options ?? []).map((opt) => ({
        value: opt.value,
        label: resolveLocalizedText(opt.label, locale),
      })),
    ]
    return (
      <Select
        value={value}
        disabled={disabled}
        options={options}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  if (field.type === 'choice') {
    return (
      <div className="ask-dock-choice-group" role="radiogroup" aria-label={fieldLabel}>
        {(field.options ?? []).map((opt) => {
          const selected = value === opt.value
          const optLabel = resolveLocalizedText(opt.label, locale)
          const optDesc =
            opt.description !== undefined ? resolveLocalizedText(opt.description, locale) : undefined
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              className={`ask-dock-choice-btn${selected ? ' ask-dock-choice-btn--selected' : ''}`}
              disabled={disabled}
              onClick={() => onChange(opt.value)}
            >
              <span className="ask-dock-choice-radio" aria-hidden="true" />
              <span className="ask-dock-choice-body">
                <span className="ask-dock-choice-label">{optLabel}</span>
                {optDesc !== undefined && optDesc !== '' ? (
                  <span className="ask-dock-choice-desc">{optDesc}</span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
    )
  }
  if (field.type === 'model') {
    const placeholder = t('composer.ask.modelKeepCurrent')
    return (
      <ModelPickerControl
        buttonId={fieldId}
        buttonAriaLabel={`${fieldLabel}: ${value || placeholder}`}
        buttonTitle={value || placeholder}
        placeholderLabel={placeholder}
        effectiveModel={value || undefined}
        activeThinkingLevel=""
        resetLabel={placeholder}
        resetTitle={t('composer.ask.modelResetTitle')}
        popoverSide="top"
        enableShortcut={false}
        showThinkingLevels={false}
        disabled={disabled}
        copy={pickerAdapter.copy}
        onNotice={pickerAdapter.onNotice}
        onOpenModelsCenter={pickerAdapter.onOpenModelsCenter}
        onApply={(id) => onChange(id)}
        onResetDefault={() => onChange('')}
      />
    )
  }
  if (field.type === 'confirm') {
    return (
      <Stack direction="horizontal" inline gap="xs" className="ask-dock-confirm-actions">
        <Button
          variant={value === 'true' ? 'primary' : 'default'}
          size="sm"
          icon={<HelmxIcon name="check" size={12} />}
          disabled={disabled}
          onClick={() => onChange('true')}
        >
          {t('composer.ask.approve')}
        </Button>
        <Button
          variant={value === 'false' ? 'danger' : 'default'}
          size="sm"
          icon={<HelmxIcon name="x" size={12} />}
          disabled={disabled}
          onClick={() => onChange('false')}
        >
          {t('composer.ask.reject')}
        </Button>
      </Stack>
    )
  }
  return (
    <Input
      type="text"
      value={value}
      disabled={disabled}
      placeholder={fieldLabel}
      onChange={(e) => onChange(e.target.value)}
      autoComplete="off"
    />
  )
}

function AskCard({ ask, source }: { ask: AskSpec; source?: AskSourceInfo }) {
  const { openConversationDrawer } = useStoreActions()
  const { locale, t } = useWebLocale()
  // The same approval can appear in both an ancestor panel and a child
  // conversation drawer; form labels associate with this instance only.
  const formId = useId()
  const [answers, setAnswers] = useState<Record<string, string>>(() => initialAskAnswers(ask.fields))
  const [submitting, setSubmitting] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const titleText = resolveLocalizedText(ask.title, locale)
  const descText = ask.description !== undefined ? resolveLocalizedText(ask.description, locale) : ''
  const hintText = ask.hint !== undefined ? resolveLocalizedText(ask.hint, locale) : ''
  const snapshot = useMemo(() => extractTerminalSnapshot(ask, descText), [ask, descText])

  const isSingleConfirm = ask.fields.length === 1 && ask.fields[0]?.type === 'confirm'
  const missingRequired = ask.fields
    .filter((f) => f.required === true)
    .filter((f) => (answers[f.name] ?? '').trim() === '')

  const submitAnswers = async (payload: Record<string, string>): Promise<void> => {
    setSubmitting('answer')
    setError(null)
    try {
      await asksApi.answer(ask.id, payload, ask.expectedStateSeq)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(null)
    }
  }

  const submit = async (): Promise<void> => {
    await submitAnswers(answers)
  }

  const cancel = async (): Promise<void> => {
    setSubmitting('cancel')
    setError(null)
    try {
      await asksApi.cancel(ask.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(null)
    }
  }

  const visibleDescription =
    snapshot?.source === 'description'
      ? snapshot.prefix
      : descText.trim() ? descText : undefined

  return (
    <form
      className="ask-dock"
      onSubmit={(e) => {
        e.preventDefault()
        if (isSingleConfirm || submitting !== null || missingRequired.length > 0) return
        void submit()
      }}
    >
      <div className="ask-dock-header">
        <StatusLight tone="blocked" label={t('composer.ask.awaitingApproval')} />
        <span className="ask-dock-title">{titleText}</span>
        {(ask.ownerPluginId !== undefined || ask.expectedStateSeq !== undefined) && (
          /* 机器元数据（owner 插件 / CAS seq）不再是常驻徽章：小号 info 入口 + 可访问 Popover。 */
          <PopoverRoot>
            <PopoverTrigger asChild>
              <IconButton
                icon="info"
                variant="ghost"
                size="xs"
                className="ask-dock-meta-btn"
                label={t('composer.ask.metaAria')}
              />
            </PopoverTrigger>
            <PopoverContent align="start" className="ask-dock-meta-popover">
              <div className="kv-list">
                {ask.ownerPluginId !== undefined ? (
                  <>
                    <div className="kv-key">{t('composer.ask.metaOwner')}</div>
                    <div className="kv-val mono">{ask.ownerPluginId}</div>
                  </>
                ) : null}
                {ask.expectedStateSeq !== undefined ? (
                  <>
                    <div className="kv-key">{t('composer.ask.metaSeq')}</div>
                    <div className="kv-val mono tabular-nums">{ask.expectedStateSeq}</div>
                  </>
                ) : null}
              </div>
              {ask.expectedStateSeq !== undefined ? (
                <HelperText className="ask-dock-meta-hint">{t('composer.ask.casTitle')}</HelperText>
              ) : null}
            </PopoverContent>
          </PopoverRoot>
        )}
        {source !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<HelmxIcon name="corner-down-right" size={11} />}
            className="ask-dock-source-btn"
            title={source.title !== ''
              ? t('composer.ask.openChildTitle', { id: source.conversationId, title: source.title })
              : t('composer.ask.openChildDrawer', { id: source.conversationId })}
            aria-label={t('composer.ask.openChildDrawer', { id: source.conversationId })}
            onClick={() => openConversationDrawer(source.conversationId)}
          >
            {t('composer.ask.fromSource', { id: source.conversationId })}
          </Button>
        ) : null}
      </div>
      {visibleDescription !== undefined ? (
        <div className="ask-dock-desc">
          {visibleDescription}
        </div>
      ) : null}
      {snapshot !== undefined ? (
        <div className="ask-dock-snapshot">
          <Button
            variant="ghost"
            size="sm"
            icon={<HelmxIcon name={snapshotOpen ? 'chevron-down' : 'chevron-right'} size={12} />}
            className="ask-dock-snapshot-btn"
            onClick={() => setSnapshotOpen((v) => !v)}
          >
            {t('composer.ask.terminalSnapshot')}
          </Button>
          {snapshotOpen ? (
            <pre className="code-block-pre selectable ask-dock-snapshot-pre">
              <code>{snapshot.text}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
      {ask.fields.length > 0 ? (
        <Stack gap="sm" className="ask-dock-fields">
          {ask.fields.map((field) => {
            const fieldLabel = resolveLocalizedText(field.label, locale)
            const fieldId = `${formId}-${field.name}`
            return (
              <Field
                key={field.name}
                className="ask-dock-field"
                label={fieldLabel}
                required={field.required === true}
                htmlFor={field.type === 'confirm' || field.type === 'choice' ? false : fieldId}
              >
                <AskFieldInput
                  conversationId={ask.conversationId}
                  field={field}
                  fieldId={fieldId}
                  fieldLabel={fieldLabel}
                  value={answers[field.name] ?? ''}
                  disabled={submitting !== null}
                  onChange={(v) => {
                    const next = { ...answers, [field.name]: v }
                    setAnswers(next)
                    if (isSingleConfirm) {
                      void submitAnswers({ [field.name]: v })
                    }
                  }}
                />
              </Field>
            )
          })}
        </Stack>
      ) : null}
      {hintText.trim() !== '' ? (
        <HelperText className="ask-dock-hint">{hintText}</HelperText>
      ) : null}
      {error !== null ? (
        <Callout tone="err">
          <span className="callout-text">{error}</span>
        </Callout>
      ) : null}
      <Stack direction="horizontal" justify="end" wrap gap="sm" className="ask-dock-actions">
        <Button
          pending={submitting === 'cancel'}
          disabled={submitting !== null && submitting !== 'cancel'}
          onClick={() => void cancel()}
        >
          {t('common.cancel')}
        </Button>
        {!isSingleConfirm ? (
          <Button
            type="submit"
            variant="primary"
            icon={<HelmxIcon name="check" size={12} />}
            pending={submitting === 'answer'}
            disabled={(submitting !== null && submitting !== 'answer') || missingRequired.length > 0}
          >
            {t('composer.ask.submit')}
          </Button>
        ) : null}
      </Stack>
    </form>
  )
}

function AskDockActive({
  conversationId,
  pendingAsks,
}: {
  conversationId: number
  pendingAsks: ReadonlyArray<AskSpec>
}) {
  const conversations = useConversations()
  // Ancestry derives purely from conversations; pending asks of
  // descendant conversations are surfaced as well.
  const subtreeIds = useMemo(
    () => collectSubtreeIds(conversations, conversationId),
    [conversations, conversationId],
  )
  const pending = pendingAsks.filter(
    (a) => a.status === 'pending' && subtreeIds.has(a.conversationId),
  )
  if (pending.length === 0) return null
  return (
    <Stack gap="sm" className="ask-dock-stack">
      {pending.map((ask) => (
        <AskCard
          key={ask.id}
          ask={ask}
          {...(ask.conversationId !== conversationId
            ? {
                source: {
                  conversationId: ask.conversationId,
                  title: conversations.find((conv) => conv.id === ask.conversationId)?.title ?? '',
                },
              }
            : {})}
        />
      ))}
    </Stack>
  )
}

/** Bottom-docked approval stack: pending AskDoc cards of the current
 * conversation and all of its descendants. AskDoc is conversation-scoped:
 * answer/cancel still go through the original asksApi (with the
 * expectedStateSeq CAS); this dock only aggregates display and changes nothing
 * about the approval chain. */
export function AskDock({ conversationId }: AskDockProps) {
  const pendingAsks = usePendingAsks()
  if (!pendingAsks.some((a) => a.status === 'pending')) return null
  return <AskDockActive conversationId={conversationId} pendingAsks={pendingAsks} />
}
