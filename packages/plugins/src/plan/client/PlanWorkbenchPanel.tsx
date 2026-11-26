/**
 * Plan workbench panel (`workbenchPanel` for builtin:plan).
 * Subscribes to `usePluginSessionDocState('plan')` and renders mode state,
 * current draft markdown (with inline human editing & CAS conflict detection),
 * latest approved artifact metadata, and mode toggle.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { WorkbenchPanelProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  Card,
  CopyButton,
  EmptyState,
  Field,
  HelmxIcon,
  Input,
  KvGrid,
  LoadingState,
  MarkdownView,
  MonoId,
  Stack,
  Textarea,
  formatCompactTimestamp,
  resolveLocalizedText,
  usePluginAction,
  usePluginContext,
  usePluginLocale,
  usePluginSessionDocState,
} from '@helmx/plugin-client'
import {
  PLAN_COPY,
  planActionFailedNotice,
  planModeLabel,
  planStaleDraftWarning,
  planUpdatedLabel,
  planVersionLabel,
} from './copy.ts'
import { isPlanEligibleConversation, parsePlanSessionView } from './models.ts'
import { PLAN_SESSION_DOC, type PlanSessionView } from './types.ts'

const DEFAULT_NORMAL_VIEW: PlanSessionView = {
  mode: 'normal',
  awaitingApproval: false,
}

interface EditingDraftState {
  baseVersion: number
  title: string
  markdown: string
}

function PlanWorkbenchPanelInner({ conversationId }: { conversationId: number }): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)

  const docState = usePluginSessionDocState<unknown>(PLAN_SESSION_DOC, { conversationId })
  const rawDocRef = useRef<unknown>(docState.data)
  rawDocRef.current = docState.data

  const [pendingView, setPendingView] = useState<{
    conversationId: number
    baseDoc: unknown
    view: PlanSessionView
  } | null>(null)
  const [editing, setEditing] = useState<EditingDraftState | null>(null)

  useEffect(() => {
    setEditing(null)
  }, [conversationId])

  useEffect(() => {
    setPendingView((prev) =>
      prev !== null && prev.conversationId === conversationId && prev.baseDoc === docState.data ? prev : null,
    )
  }, [conversationId, docState.data])

  const toggleAction = usePluginAction({
    notifyError: true,
    formatError: (err) =>
      planActionFailedNotice(t(PLAN_COPY.actionToggle), err instanceof Error ? err.message : String(err), locale),
  })

  const saveDraftAction = usePluginAction({
    notifyError: true,
    formatError: (err) =>
      planActionFailedNotice(t(PLAN_COPY.actionUpdateDraft), err instanceof Error ? err.message : String(err), locale),
  })

  const docView = parsePlanSessionView(docState.data)
  const hasActionOverride =
    pendingView !== null && pendingView.conversationId === conversationId && pendingView.baseDoc === docState.data
  const effectiveView = hasActionOverride
    ? pendingView.view
    : (docView ?? DEFAULT_NORMAL_VIEW)

  const handleToggle = (): void => {
    const baseDoc = rawDocRef.current
    void toggleAction.run(
      'toggle',
      { conversationId },
      {
        conversationId,
        onSuccess: (raw) => {
          const parsed = parsePlanSessionView(raw)
          if (parsed !== undefined && rawDocRef.current === baseDoc) {
            setPendingView({ conversationId, baseDoc, view: parsed })
          }
        },
      },
    )
  }

  const handleSaveDraft = (): void => {
    if (editing === null || saveDraftAction.pending) return
    const trimmedTitle = editing.title.trim()
    if (trimmedTitle === '' || editing.markdown.trim() === '') return
    const baseDoc = rawDocRef.current
    void saveDraftAction.run(
      'update_draft',
      {
        conversationId,
        title: trimmedTitle,
        markdown: editing.markdown,
        expectedVersion: editing.baseVersion,
      },
      {
        conversationId,
        onSuccess: (raw) => {
          const parsed = parsePlanSessionView(raw)
          if (parsed !== undefined && rawDocRef.current === baseDoc) {
            setPendingView({ conversationId, baseDoc, view: parsed })
          }
          setEditing(null)
        },
      },
    )
  }

  const isPlanning = effectiveView.mode === 'planning'
  const modeTone = effectiveView.awaitingApproval ? 'warn' : isPlanning ? 'accent' : 'neutral'
  const modeText = planModeLabel(
    effectiveView.mode,
    effectiveView.awaitingApproval,
    locale,
  )

  const draft = effectiveView.draft
  const approved = effectiveView.approved

  const draftSubtitle =
    draft !== undefined ? (
      <Stack direction="horizontal" gap="xs" align="center" wrap>
        <Badge tone="neutral" mono>
          {planVersionLabel(draft.version)}
        </Badge>
        {draft.updatedAt > 0 ? (
          <span className="tabular-nums">{planUpdatedLabel(formatCompactTimestamp(draft.updatedAt), locale)}</span>
        ) : null}
      </Stack>
    ) : undefined

  const approvedItems =
    approved !== undefined
      ? [
          {
            key: t(PLAN_COPY.approvedKvPlan),
            value: (
              <Stack direction="horizontal" gap="xs" align="center" wrap>
                <span>{approved.title}</span>
                <Badge tone="neutral" mono>
                  {planVersionLabel(approved.version)}
                </Badge>
              </Stack>
            ),
          },
          {
            key: t(PLAN_COPY.approvedKvArtifact),
            value: (
              <Button
                variant="inline"
                size="xs"
                icon="file-text"
                onClick={() => ctx.openArtifact(approved.artifactId)}
              >
                {approved.artifactName}
              </Button>
            ),
          },
          {
            key: t(PLAN_COPY.approvedKvArtifactId),
            value: <MonoId value={approved.artifactId} />,
          },
          ...(approved.approvedAt > 0
            ? [
                {
                  key: t(PLAN_COPY.approvedKvApprovedAt),
                  value: <span className="tabular-nums">{formatCompactTimestamp(approved.approvedAt)}</span>,
                },
              ]
            : []),
          {
            key: t(PLAN_COPY.approvedKvHandoff),
            value: t(approved.handoffUsed ? PLAN_COPY.handoffYes : PLAN_COPY.handoffNo),
          },
          ...(approved.executionModel !== undefined
            ? [
                {
                  key: t(PLAN_COPY.approvedKvExecutionModel),
                  value: <span className="mono">{approved.executionModel}</span>,
                },
              ]
            : []),
        ]
      : undefined

  return (
    <div className="plan-workbench">
      <div className="plan-workbench-head">
        <span className="plan-workbench-title">
          <HelmxIcon name="list-tree" size={14} />
          <span>{t(PLAN_COPY.panelTitle)}</span>
          <Badge tone={modeTone}>{modeText}</Badge>
        </span>
        <Button
          size="xs"
          variant={isPlanning ? 'secondary' : 'primary'}
          icon={isPlanning ? 'x' : 'list-tree'}
          pending={toggleAction.pending}
          disabled={toggleAction.pending}
          onClick={handleToggle}
        >
          {t(isPlanning ? PLAN_COPY.exitPlanning : PLAN_COPY.enterPlanning)}
        </Button>
      </div>

      {docState.status === 'loading' && docView === undefined && !hasActionOverride ? (
        <LoadingState label={t(PLAN_COPY.loading)} />
      ) : docState.status === 'error' && docView === undefined ? (
        <Callout tone="err" title={t(PLAN_COPY.loadError)}>
          {docState.error ? <p className="plan-error-text">{docState.error}</p> : null}
          <Button size="xs" icon="rotate-cw" onClick={docState.retry}>
            {t(PLAN_COPY.retry)}
          </Button>
        </Callout>
      ) : (
        <>
          {draft !== undefined ? (
            <Card
              variant="elevated"
              className="plan-draft-card"
              title={draft.title}
              subtitle={draftSubtitle}
              actions={
                editing === null ? (
                  <Stack direction="horizontal" gap="xs" align="center">
                    <Button
                      variant="ghost"
                      size="xs"
                      icon="edit-3"
                      onClick={() =>
                        setEditing({
                          baseVersion: draft.version,
                          title: draft.title,
                          markdown: draft.markdown,
                        })
                      }
                    >
                      {t(PLAN_COPY.editDraft)}
                    </Button>
                    {draft.markdown.trim() !== '' ? (
                      <CopyButton
                        text={draft.markdown}
                        label={t(PLAN_COPY.copyDraft)}
                        className="btn btn-ghost btn-xs"
                      />
                    ) : null}
                  </Stack>
                ) : undefined
              }
            >
              {editing !== null ? (
                <form
                  className="plan-editor"
                  onSubmit={(e) => {
                    e.preventDefault()
                    handleSaveDraft()
                  }}
                >
                  {draft.version !== editing.baseVersion ? (
                    <Callout tone="warn">
                      <Stack gap="xs">
                        <span>{planStaleDraftWarning(draft.version, locale)}</span>
                        <div>
                          <Button
                            type="button"
                            size="xs"
                            variant="secondary"
                            icon="rotate-cw"
                            onClick={() =>
                              setEditing({
                                baseVersion: draft.version,
                                title: draft.title,
                                markdown: draft.markdown,
                              })
                            }
                          >
                            {t(PLAN_COPY.loadLatestDraft)}
                          </Button>
                        </div>
                      </Stack>
                    </Callout>
                  ) : null}
                  <Field label={t(PLAN_COPY.editTitleLabel)} required>
                    <Input
                      value={editing.title}
                      disabled={saveDraftAction.pending}
                      onChange={(e) =>
                        setEditing((prev) => (prev ? { ...prev, title: e.target.value } : null))
                      }
                    />
                  </Field>
                  <Field label={t(PLAN_COPY.editMarkdownLabel)} required>
                    <Textarea
                      className="plan-editor-textarea"
                      value={editing.markdown}
                      disabled={saveDraftAction.pending}
                      onChange={(e) =>
                        setEditing((prev) => (prev ? { ...prev, markdown: e.target.value } : null))
                      }
                    />
                  </Field>
                  <div className="plan-editor-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={saveDraftAction.pending}
                      onClick={() => setEditing(null)}
                    >
                      {t(PLAN_COPY.cancelEdit)}
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      size="xs"
                      icon="save"
                      pending={saveDraftAction.pending}
                      disabled={
                        saveDraftAction.pending ||
                        editing.title.trim() === '' ||
                        editing.markdown.trim() === ''
                      }
                    >
                      {t(PLAN_COPY.saveDraft)}
                    </Button>
                  </div>
                </form>
              ) : draft.markdown.trim() !== '' ? (
                <MarkdownView
                  className="plan-markdown selectable"
                  text={draft.markdown}
                  conversationId={conversationId}
                />
              ) : (
                <div className="text-muted">{t(PLAN_COPY.draftEmptyMarkdown)}</div>
              )}
            </Card>
          ) : (
            <EmptyState
              compact
              icon="list-tree"
              title={t(PLAN_COPY.emptyTitle)}
              hint={t(PLAN_COPY.emptyHint)}
            />
          )}

          {approvedItems !== undefined ? (
            <Card variant="subtle" className="plan-approved-card" title={t(PLAN_COPY.approvedSectionTitle)}>
              <KvGrid items={approvedItems} />
            </Card>
          ) : null}
        </>
      )}
    </div>
  )
}

export function PlanWorkbenchPanel(props?: Partial<WorkbenchPanelProps>): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = (text: { en: string; 'zh-CN': string }) => resolveLocalizedText(text, locale)
  const conversationId = props?.conversation?.id ?? ctx.conversationId

  if (conversationId === undefined) {
    return (
      <div className="plan-workbench">
        <EmptyState compact icon="list-tree" title={t(PLAN_COPY.noConversation)} />
      </div>
    )
  }

  if (props?.conversation !== undefined && !isPlanEligibleConversation(props.conversation)) {
    return (
      <div className="plan-workbench">
        <EmptyState compact icon="list-tree" title={t(PLAN_COPY.ineligibleConversation)} />
      </div>
    )
  }

  return <PlanWorkbenchPanelInner conversationId={conversationId} />
}
