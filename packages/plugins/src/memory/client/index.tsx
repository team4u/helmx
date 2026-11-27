/**
 * builtin:memory client component (Fast Refresh compliant: component exports only).
 * Renders per-Profile MEMORY.md editor, toggle switch, and Dream status/controls in the profile detail drawer.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProfileDetailSlotProps } from '@helmx/protocol/browser'
import {
  Button,
  Callout,
  Card,
  ErrorText,
  Field,
  HelmxIcon,
  HelperText,
  LoadingState,
  Stack,
  Switch,
  Textarea,
  usePluginContext,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  MEMORY_COPY as C,
  memoryCharCount,
  memoryDreamCandidates,
  memoryDreamLastError,
  memoryDreamLastRun,
  memoryDreamNextRun,
  memoryDreamRunResult,
  memoryDreamSchedule,
  memoryLineCount,
} from './copy.ts'
import { isDreamStatusResult, type DreamRunResult, type DreamStatusResult } from './models.ts'
import './index.css'

interface MemoryGetResult {
  profileId: string
  enabled: boolean
  content: string
  initialized: boolean
}

type Operation = 'load' | 'toggle' | 'save'
type DreamOperation = 'status' | 'run' | 'auto' | 'refresh'

interface PanelState {
  profileId: string
  generation: number
  memory: MemoryGetResult | null
  draft: string | null
  error: string | null
  busy: Operation | null
  dreamStatus: DreamStatusResult | null
  dreamError: string | null
  dreamBusy: DreamOperation | null
  dreamRefreshFailed: boolean
}

const emptyPanel = (profileId: string, generation: number, loading = false): PanelState => ({
  profileId,
  generation,
  memory: null,
  draft: null,
  error: null,
  busy: loading ? 'load' : null,
  dreamStatus: null,
  dreamError: null,
  dreamBusy: loading ? 'status' : null,
  dreamRefreshFailed: false,
})

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function ProfileMemorySection(props: ProfileDetailSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const { profileId, isNew, disabled } = props
  const effectiveId = isNew ? '' : profileId.trim()

  const [panel, setPanel] = useState<PanelState>(() => emptyPanel('', 0))
  const generation = useRef(0)
  const requestGen = useRef(0)
  const dreamStatusReq = useRef(0)
  const mounted = useRef(false)
  const currentProfile = useRef(effectiveId)
  const panelRef = useRef(panel)
  const callAction = useRef(ctx.callAction)
  const notifyRef = useRef(ctx.notify)

  currentProfile.current = effectiveId
  callAction.current = ctx.callAction
  notifyRef.current = ctx.notify
  panelRef.current = panel

  const isCurrent = useCallback(
    (targetId: string, token: number, reqToken = requestGen.current) =>
      mounted.current && currentProfile.current === targetId && generation.current === token && requestGen.current === reqToken,
    [],
  )

  const patchPanel = useCallback((targetId: string, token: number, patch: Partial<PanelState> | ((prev: PanelState) => Partial<PanelState>)) => {
    setPanel((prev) => {
      if (prev.profileId !== targetId || prev.generation !== token) return prev
      const next = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }
      panelRef.current = next
      return next
    })
  }, [])

  const load = useCallback(async (targetId: string, token: number, existingReq?: number): Promise<void> => {
    if (!isCurrent(targetId, token, existingReq)) return
    const req = existingReq ?? ++requestGen.current
    patchPanel(targetId, token, { busy: 'load', error: null })
    try {
      const result = (await callAction.current('get', { profileId: targetId })) as MemoryGetResult
      if (!isCurrent(targetId, token, req)) return
      patchPanel(targetId, token, (prev) => ({ memory: result, draft: prev.draft ?? result.content }))
    } catch (err) {
      if (!isCurrent(targetId, token, req)) return
      patchPanel(targetId, token, { memory: null, error: errorMessage(err) })
    } finally {
      if (isCurrent(targetId, token, req)) patchPanel(targetId, token, { busy: null })
    }
  }, [isCurrent, patchPanel])

  const loadDreamStatus = useCallback(async (targetId: string, token: number): Promise<void> => {
    if (!isCurrent(targetId, token)) return
    const req = ++dreamStatusReq.current
    try {
      const result = (await callAction.current('dream_status', { profileId: targetId })) as unknown
      if (!isCurrent(targetId, token) || dreamStatusReq.current !== req) return
      if (!isDreamStatusResult(result)) {
        patchPanel(targetId, token, { dreamStatus: null, dreamError: t(C.dreamMalformed) })
        return
      }
      patchPanel(targetId, token, { dreamStatus: result, dreamError: null })
    } catch (err) {
      if (!isCurrent(targetId, token) || dreamStatusReq.current !== req) return
      patchPanel(targetId, token, { dreamStatus: null, dreamError: errorMessage(err) })
    } finally {
      if (isCurrent(targetId, token) && dreamStatusReq.current === req) {
        patchPanel(targetId, token, (prev) => (prev.dreamBusy === 'status' ? { dreamBusy: null } : {}))
      }
    }
  }, [isCurrent, patchPanel, t])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [])

  useEffect(() => {
    const token = ++generation.current
    const initial = emptyPanel(effectiveId, token, effectiveId !== '')
    panelRef.current = initial
    setPanel(initial)
    if (effectiveId !== '') {
      void load(effectiveId, token)
      void loadDreamStatus(effectiveId, token)
    }
    return () => {
      if (generation.current === token) generation.current += 1
    }
  }, [effectiveId, load, loadDreamStatus])

  const refreshMemoryAfterDream = useCallback(async (targetId: string, token: number): Promise<'updated' | 'kept-dirty' | 'switched' | 'failed'> => {
    try {
      const fresh = (await callAction.current('get', { profileId: targetId })) as MemoryGetResult
      if (!isCurrent(targetId, token)) return 'switched'
      const cur = panelRef.current
      const dirty = cur.profileId === targetId && cur.generation === token && cur.memory !== null && cur.draft !== null && cur.draft !== cur.memory.content
      patchPanel(targetId, token, { memory: fresh, dreamRefreshFailed: false, ...(dirty ? {} : { draft: fresh.content }) })
      return dirty ? 'kept-dirty' : 'updated'
    } catch {
      if (!isCurrent(targetId, token)) return 'switched'
      patchPanel(targetId, token, { dreamRefreshFailed: true })
      return 'failed'
    }
  }, [isCurrent, patchPanel])

  const view = panel.profileId === effectiveId && panel.generation === generation.current ? panel : emptyPanel(effectiveId, generation.current)

  const handleDreamRun = async () => {
    const targetId = effectiveId
    const token = generation.current
    if (targetId === '' || view.dreamBusy !== null || view.busy !== null) return
    patchPanel(targetId, token, { dreamBusy: 'run', dreamError: null })
    try {
      const result = (await callAction.current('dream', { profileId: targetId })) as DreamRunResult
      if (!isCurrent(targetId, token)) return
      let notice = memoryDreamRunResult(result, locale)
      let keptDirty = false
      if (result.applied && (await refreshMemoryAfterDream(targetId, token)) === 'kept-dirty') {
        keptDirty = true
        notice = `${notice} ${t(C.dreamDraftKept)}`
      }
      if (!isCurrent(targetId, token)) return
      notifyRef.current(notice, result.conflict || keptDirty ? 'warning' : 'info')
      await loadDreamStatus(targetId, token)
    } catch (err) {
      if (!isCurrent(targetId, token)) return
      patchPanel(targetId, token, { dreamError: errorMessage(err) })
    } finally {
      if (isCurrent(targetId, token)) patchPanel(targetId, token, { dreamBusy: null })
    }
  }

  const handleDreamRefreshRetry = async () => {
    const targetId = effectiveId
    const token = generation.current
    if (targetId === '' || view.dreamBusy !== null || view.busy !== null) return
    patchPanel(targetId, token, { dreamBusy: 'refresh' })
    try {
      await refreshMemoryAfterDream(targetId, token)
    } finally {
      if (isCurrent(targetId, token)) patchPanel(targetId, token, { dreamBusy: null })
    }
  }

  const handleDreamAutoToggle = async () => {
    const targetId = effectiveId
    const token = generation.current
    if (targetId === '' || view.dreamStatus === null || view.dreamBusy !== null) return
    const nextEnabled = !view.dreamStatus.config.enabled
    patchPanel(targetId, token, { dreamBusy: 'auto', dreamError: null })
    try {
      await callAction.current('dream_configure', { enabled: nextEnabled })
      if (!isCurrent(targetId, token)) return
      notifyRef.current(t(nextEnabled ? C.dreamResumedNotice : C.dreamPausedNotice), 'info')
      await loadDreamStatus(targetId, token)
    } catch (err) {
      if (!isCurrent(targetId, token)) return
      patchPanel(targetId, token, { dreamError: errorMessage(err) })
    } finally {
      if (isCurrent(targetId, token)) patchPanel(targetId, token, { dreamBusy: null })
    }
  }

  const handleToggle = async (next: boolean) => {
    const targetId = effectiveId
    const token = generation.current
    if (targetId === '' || view.memory === null || view.busy !== null || view.dreamBusy !== null) return
    const req = ++requestGen.current
    patchPanel(targetId, token, { busy: 'toggle', error: null })
    try {
      await callAction.current('configure', { profileId: targetId, enabled: next })
      if (!isCurrent(targetId, token, req)) return
      await load(targetId, token, req)
    } catch (err) {
      if (!isCurrent(targetId, token, req)) return
      patchPanel(targetId, token, { error: errorMessage(err) })
    } finally {
      if (isCurrent(targetId, token, req)) patchPanel(targetId, token, { busy: null })
    }
  }

  const handleSave = async () => {
    const targetId = effectiveId
    const token = generation.current
    const submittedText = view.draft
    if (targetId === '' || submittedText === null || view.busy !== null || view.dreamBusy !== null) return
    const req = ++requestGen.current
    patchPanel(targetId, token, { busy: 'save', error: null })
    try {
      await callAction.current('set', { profileId: targetId, text: submittedText, mode: 'replace' })
      if (!isCurrent(targetId, token, req)) return
      const fresh = (await callAction.current('get', { profileId: targetId })) as MemoryGetResult
      if (!isCurrent(targetId, token, req)) return
      patchPanel(targetId, token, (prev) => ({
        memory: fresh,
        ...(prev.draft === submittedText ? { draft: fresh.content } : {}),
      }))
      notifyRef.current(t(C.savedNotice), 'info')
    } catch (err) {
      if (!isCurrent(targetId, token, req)) return
      patchPanel(targetId, token, { error: errorMessage(err) })
    } finally {
      if (isCurrent(targetId, token, req)) patchPanel(targetId, token, { busy: null })
    }
  }

  if (isNew) {
    return (
      <Card variant="subtle" title={t(C.sectionTitle)}>
        <HelperText>{t(C.newProfileHint)}</HelperText>
      </Card>
    )
  }
  if (effectiveId === '') return null

  const token = generation.current
  const dreamLocksContent = view.dreamBusy === 'run' || view.dreamBusy === 'refresh'
  const effectiveDraft = view.draft ?? view.memory?.content ?? ''
  const dirty = view.draft !== null && view.draft !== view.memory?.content

  return (
    <Stack gap="md">
      <Card
        variant="subtle"
        title={t(C.sectionTitle)}
        actions={
          view.memory !== null ? (
            <Switch
              checked={view.memory.enabled}
              disabled={disabled || view.busy !== null || dreamLocksContent}
              onChange={(next) => void handleToggle(next)}
              label={t(C.switchLabel)}
            />
          ) : undefined
        }
      >
        {view.error !== null && (
          <Callout tone="err">
            <ErrorText live>{view.error}</ErrorText>
          </Callout>
        )}

        {view.memory === null ? (
          view.busy === 'load' ? (
            <LoadingState label={t(C.loading)} />
          ) : view.error === null ? (
            <HelperText>{t(C.notLoaded)}</HelperText>
          ) : (
            <Stack direction="horizontal" align="center" gap="sm" wrap>
              <HelperText>{t(C.loadFailed)}</HelperText>
              <Button variant="secondary" size="sm" disabled={view.busy !== null} onClick={() => void load(effectiveId, token)}>
                {t(C.retry)}
              </Button>
            </Stack>
          )
        ) : !view.memory.enabled ? (
          <HelperText>{t(C.disabledHint)}</HelperText>
        ) : (
          <Stack gap="sm">
            <Field
              label={
                <span className="mono tabular-nums text-subtle">
                  {memoryCharCount(effectiveDraft.length, locale)}
                  {effectiveDraft ? memoryLineCount(effectiveDraft.split('\n').length, locale) : ''}
                </span>
              }
              hint={dirty ? t(C.dirtyHint) : undefined}
            >
              <Textarea
                mono
                className="memory-section-textarea"
                rows={8}
                placeholder={t(C.placeholder)}
                value={effectiveDraft}
                disabled={disabled}
                onChange={(e) => patchPanel(effectiveId, token, { draft: e.target.value })}
                aria-label={t(C.textareaLabel)}
              />
            </Field>
            <Stack direction="horizontal" align="center" gap="sm" wrap>
              <Button
                variant="primary"
                size="sm"
                icon="save"
                pending={view.busy === 'save'}
                disabled={disabled || (view.busy !== null && view.busy !== 'save') || dreamLocksContent || !dirty}
                onClick={() => void handleSave()}
              >
                {view.busy === 'save' ? t(C.saving) : t(C.save)}
              </Button>
            </Stack>
          </Stack>
        )}
      </Card>
      {view.memory !== null && view.memory.enabled ? (
        <MemoryDreamBlock
          targetId={effectiveId}
          disabled={disabled}
          status={view.dreamStatus}
          error={view.dreamError}
          busy={view.dreamBusy}
          refreshFailed={view.dreamRefreshFailed}
          memoryBusy={view.busy !== null}
          onRun={() => void handleDreamRun()}
          onAutoToggle={() => void handleDreamAutoToggle()}
          onRefreshRetry={() => void handleDreamRefreshRetry()}
        />
      ) : null}
    </Stack>
  )
}

interface MemoryDreamBlockProps {
  targetId: string
  disabled: boolean
  status: DreamStatusResult | null
  error: string | null
  busy: DreamOperation | null
  refreshFailed: boolean
  memoryBusy: boolean
  onRun: () => void
  onAutoToggle: () => void
  onRefreshRetry: () => void
}

function MemoryDreamBlock(props: MemoryDreamBlockProps): ReactNode {
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const { status, error, busy, disabled } = props
  const row = status?.profiles.find((p) => p.profileId === props.targetId)
  const autoConfig = status?.config ?? null
  const statusLoading = status === null && error === null
  const lastError = row?.lastRun?.error
  return (
    <Card
      variant="subtle"
      title={
        <Stack direction="horizontal" align="center" gap="xs" inline>
          <HelmxIcon name="moon-star" size={12} />
          <span>{t(C.dreamTitle)}</span>
        </Stack>
      }
      actions={
        <Stack direction="horizontal" align="center" gap="xs" wrap>
          <Button
            variant="secondary"
            size="sm"
            icon="moon-star"
            pending={busy === 'run'}
            disabled={disabled || (busy !== null && busy !== 'run') || statusLoading || props.memoryBusy}
            onClick={props.onRun}
          >
            {busy === 'run' ? t(C.dreamRunning) : t(C.dreamRun)}
          </Button>
          {autoConfig !== null && (
            <Button variant="ghost" size="sm" disabled={disabled || busy !== null} onClick={props.onAutoToggle}>
              {autoConfig.enabled ? t(C.dreamPause) : t(C.dreamResume)}
            </Button>
          )}
        </Stack>
      }
    >
      {statusLoading ? (
        <LoadingState label={t(C.dreamStatusLoading)} />
      ) : autoConfig !== null ? (
        <Stack direction="horizontal" align="center" gap="sm" wrap className="memory-dream-meta">
          <span className="mono tabular-nums">{memoryDreamSchedule(autoConfig, locale)}</span>
          {autoConfig.enabled && status?.nextRunAt !== undefined && (
            <span className="text-subtle tabular-nums">{memoryDreamNextRun(status.nextRunAt, locale)}</span>
          )}
          {row !== undefined && (
            <span className="text-subtle tabular-nums">{memoryDreamCandidates(row.candidateCount, locale)}</span>
          )}
          {row?.lastRun !== undefined && (
            <span className="text-subtle tabular-nums">{memoryDreamLastRun(row.lastRun, locale)}</span>
          )}
        </Stack>
      ) : (
        <HelperText>{t(C.dreamLoadFailed)}</HelperText>
      )}
      {lastError && <HelperText className="memory-dream-diag">{memoryDreamLastError(lastError, locale)}</HelperText>}
      {props.refreshFailed && (
        <Callout tone="warn">
          <div className="memory-dream-refresh-error" role="alert">
            <Stack direction="horizontal" align="center" gap="sm" wrap>
              <span>{t(C.dreamRefreshFailed)}</span>
              <Button variant="secondary" size="sm" disabled={disabled || busy !== null || props.memoryBusy} onClick={props.onRefreshRetry}>
                {t(C.retry)}
              </Button>
            </Stack>
          </div>
        </Callout>
      )}
      {error !== null && (
        <Callout tone="err">
          <ErrorText live>{error}</ErrorText>
        </Callout>
      )}
      <HelperText>{t(C.dreamGlobalHint)}</HelperText>
    </Card>
  )
}
