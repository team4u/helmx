/**
 * builtin:memory client component (Fast Refresh compliant: component exports only).
 * Renders per-Profile MEMORY.md editor, toggle switch, and Dream status/controls in the profile detail drawer.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProfileDetailSlotProps } from '@helmx/protocol'
import { HelmxIcon, Switch, usePluginContext, usePluginLocale, usePluginTranslator } from '@helmx/plugin-client'
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
  dreamNotice: string | null
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
  dreamNotice: null,
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

  currentProfile.current = effectiveId
  callAction.current = ctx.callAction
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
    patchPanel(targetId, token, { dreamBusy: 'run', dreamNotice: null, dreamError: null })
    try {
      const result = (await callAction.current('dream', { profileId: targetId })) as DreamRunResult
      if (!isCurrent(targetId, token)) return
      let notice = memoryDreamRunResult(result, locale)
      if (result.applied && (await refreshMemoryAfterDream(targetId, token)) === 'kept-dirty') {
        notice = `${notice} ${t(C.dreamDraftKept)}`
      }
      if (!isCurrent(targetId, token)) return
      patchPanel(targetId, token, { dreamNotice: notice })
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
    patchPanel(targetId, token, { dreamBusy: 'auto', dreamNotice: null, dreamError: null })
    try {
      await callAction.current('dream_configure', { enabled: !view.dreamStatus.config.enabled })
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
    } catch (err) {
      if (!isCurrent(targetId, token, req)) return
      patchPanel(targetId, token, { error: errorMessage(err) })
    } finally {
      if (isCurrent(targetId, token, req)) patchPanel(targetId, token, { busy: null })
    }
  }

  if (isNew) {
    return (
      <section className="section-flat">
        <div className="section-flat-header"><span className="section-flat-title">{t(C.sectionTitle)}</span></div>
        <div className="text-subtle">{t(C.newProfileHint)}</div>
      </section>
    )
  }
  if (effectiveId === '') return null

  const token = generation.current
  const dreamLocksContent = view.dreamBusy === 'run' || view.dreamBusy === 'refresh'
  const effectiveDraft = view.draft ?? view.memory?.content ?? ''
  const dirty = view.draft !== null && view.draft !== view.memory?.content

  return (
    <section className="section-flat">
      <div className="section-flat-header memory-section-header">
        <span className="section-flat-title">{t(C.sectionTitle)}</span>
        {view.memory !== null && (
          <Switch
            checked={view.memory.enabled}
            disabled={disabled || view.busy !== null || dreamLocksContent}
            onChange={(next) => void handleToggle(next)}
            label={t(C.switchLabel)}
          />
        )}
      </div>

      {view.error !== null && (
        <div className="badge badge-warn memory-section-error" role="alert"><span>{view.error}</span></div>
      )}

      {view.memory === null ? (
        <div className="memory-section-load">
          {view.busy === 'load' && <HelmxIcon name="loader" size={12} className="spin-slow" />}
          {view.error === null ? (
            <span>{view.busy === 'load' ? t(C.loading) : t(C.notLoaded)}</span>
          ) : (
            <>
              <span>{t(C.loadFailed)}</span>
              <button type="button" className="btn btn-secondary btn-sm" disabled={view.busy !== null} onClick={() => void load(effectiveId, token)}>
                {t(C.retry)}
              </button>
            </>
          )}
        </div>
      ) : !view.memory.enabled ? (
        <div className="text-subtle">{t(C.disabledHint)}</div>
      ) : (
        <>
          <div className="flex-row-between memory-section-meta">
            <span className="mono">
              {memoryCharCount(effectiveDraft.length, locale)}
              {effectiveDraft ? memoryLineCount(effectiveDraft.split('\n').length, locale) : ''}
            </span>
          </div>
          <textarea
            className="input mono memory-section-textarea"
            rows={8}
            placeholder={t(C.placeholder)}
            value={effectiveDraft}
            disabled={disabled}
            onChange={(e) => patchPanel(effectiveId, token, { draft: e.target.value })}
            aria-label={t(C.textareaLabel)}
          />
          <div className="flex-row memory-section-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={disabled || view.busy !== null || dreamLocksContent || !dirty}
              onClick={() => void handleSave()}
            >
              {view.busy === 'save' ? <HelmxIcon name="loader" size={13} className="spin-slow" /> : <HelmxIcon name="save" size={13} />}
              <span>{view.busy === 'save' ? t(C.saving) : t(C.save)}</span>
            </button>
            {dirty && <span className="text-subtle">{t(C.dirtyHint)}</span>}
          </div>
          <MemoryDreamBlock
            targetId={effectiveId}
            disabled={disabled}
            status={view.dreamStatus}
            notice={view.dreamNotice}
            error={view.dreamError}
            busy={view.dreamBusy}
            refreshFailed={view.dreamRefreshFailed}
            memoryBusy={view.busy !== null}
            onRun={() => void handleDreamRun()}
            onAutoToggle={() => void handleDreamAutoToggle()}
            onRefreshRetry={() => void handleDreamRefreshRetry()}
          />
        </>
      )}
    </section>
  )
}

interface MemoryDreamBlockProps {
  targetId: string
  disabled: boolean
  status: DreamStatusResult | null
  notice: string | null
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
  const { status, notice, error, busy, disabled } = props
  const row = status?.profiles.find((p) => p.profileId === props.targetId)
  const autoConfig = status?.config ?? null
  const statusLoading = status === null && error === null
  const lastError = row?.lastRun?.error
  return (
    <div className="memory-dream-block">
      <div className="flex-row-between memory-section-header">
        <span className="text-subtle memory-dream-title">
          <HelmxIcon name="moon-star" size={12} />
          <span>{t(C.dreamTitle)}</span>
        </span>
        <div className="flex-row memory-dream-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled || busy !== null || statusLoading || props.memoryBusy}
            onClick={props.onRun}
          >
            {busy === 'run' ? <HelmxIcon name="loader" size={13} className="spin-slow" /> : <HelmxIcon name="moon-star" size={13} />}
            <span>{busy === 'run' ? t(C.dreamRunning) : t(C.dreamRun)}</span>
          </button>
          {autoConfig !== null && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={disabled || busy !== null} onClick={props.onAutoToggle}>
              <span>{autoConfig.enabled ? t(C.dreamPause) : t(C.dreamResume)}</span>
            </button>
          )}
        </div>
      </div>
      <div className="memory-dream-meta">
        {autoConfig !== null ? (
          <>
            <span className="mono">{memoryDreamSchedule(autoConfig, locale)}</span>
            {autoConfig.enabled && status?.nextRunAt !== undefined && <span className="text-subtle">{memoryDreamNextRun(status.nextRunAt, locale)}</span>}
            {row !== undefined && <span className="text-subtle">{memoryDreamCandidates(row.candidateCount, locale)}</span>}
            {row?.lastRun !== undefined && <span className="text-subtle">{memoryDreamLastRun(row.lastRun, locale)}</span>}
          </>
        ) : (
          <span className="text-subtle">{t(error !== null ? C.dreamLoadFailed : C.dreamStatusLoading)}</span>
        )}
      </div>
      {lastError && <div className="text-subtle memory-dream-diag">{memoryDreamLastError(lastError, locale)}</div>}
      {props.refreshFailed && (
        <div className="memory-dream-refresh-error" role="alert">
          <span>{t(C.dreamRefreshFailed)}</span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || busy !== null || props.memoryBusy} onClick={props.onRefreshRetry}>
            {t(C.retry)}
          </button>
        </div>
      )}
      {notice !== null && <div className="text-subtle memory-dream-notice">{notice}</div>}
      {error !== null && <div className="badge badge-warn memory-section-error" role="alert"><span>{error}</span></div>}
      <div className="text-subtle">{t(C.dreamGlobalHint)}</div>
    </div>
  )
}
