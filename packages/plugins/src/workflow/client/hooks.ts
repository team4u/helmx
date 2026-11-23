/**
 * Shared client hooks for builtin:workflow:
 * - useWorkflowRunsDoc: wraps usePluginSessionDocState with frozen EMPTY_RUNS & status;
 * - useInspectedRun: lazy full-run `inspect` fetch with generation guard (gives expanded
 *   Workbench cards full `result` AND full `nodes` with `output`/`prompt`/`schema`);
 * - useWorkflowLibrary: fetches saved workflows once on mount + manual reload (locale-independent).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  usePluginContext,
  usePluginLocale,
  usePluginSessionDocState,
  type PluginDocLoadStatus,
} from '@helmx/plugin-client'
import type { WorkflowRunSummary } from '../../contracts.js'
import { libListInvalid } from './copy.js'
import { asPlainRecord, parseSavedWorkflowList, type SavedWorkflowView } from './parsers.js'

const EMPTY_RUNS: ReadonlyArray<WorkflowRunSummary> = Object.freeze([])

export interface WorkflowRunsDocResult {
  runs: ReadonlyArray<WorkflowRunSummary>
  status: PluginDocLoadStatus
  retry: () => void
}

export function useWorkflowRunsDoc(conversationId: number | undefined): WorkflowRunsDocResult {
  const state = usePluginSessionDocState<{ runs?: WorkflowRunSummary[] }>(
    'runs',
    conversationId !== undefined ? { conversationId } : undefined,
  )
  const runs = Array.isArray(state.data?.runs) ? state.data.runs : EMPTY_RUNS
  return {
    runs,
    status: state.status,
    retry: state.retry,
  }
}

export interface InspectedRunState {
  loading: boolean
  error: string | undefined
  hasResult: boolean
  hasResolvedResult: boolean
  result: unknown
  retry: () => void
}

export function useInspectedRun(run: WorkflowRunSummary, enabled: boolean): InspectedRunState {
  const ctx = usePluginContext()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx

  const [fetched, setFetched] = useState<{ key: string; result: unknown } | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)

  const hasInlineResult = run.result !== undefined
  const needsInspect = enabled && !hasInlineResult && run.hasResult === true
  const fetchKey = `${run.id}:${run.status}:${run.updatedAt}`
  const cached = fetched !== undefined && fetched.key === fetchKey ? fetched : undefined

  const retry = useCallback(() => {
    setError(undefined)
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!needsInspect) return
    if (cached !== undefined) return
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    void ctxRef.current
      .callAction('inspect', { runId: run.id })
      .then((raw) => {
        if (generation.current !== current) return
        const rec = asPlainRecord(raw)
        const inspected = asPlainRecord(rec?.['run'])
        if (inspected === undefined || inspected['id'] !== run.id || !Object.hasOwn(inspected, 'result')) {
          throw new Error(`Invalid inspect payload for ${run.id}`)
        }
        setFetched({ key: fetchKey, result: inspected['result'] })
      })
      .catch((err: unknown) => {
        if (generation.current !== current) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
  }, [needsInspect, run.id, fetchKey, cached, nonce])

  const hasResult = hasInlineResult || run.hasResult === true
  const hasResolvedResult = hasInlineResult || cached !== undefined
  const result = hasInlineResult ? run.result : cached?.result
  return {
    loading,
    error,
    hasResult,
    hasResolvedResult,
    result,
    retry,
  }
}

export interface WorkflowLibraryState {
  items: SavedWorkflowView[] | undefined
  loading: boolean
  error: string | undefined
  reload: () => Promise<void>
}

export function useWorkflowLibrary(): WorkflowLibraryState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const localeRef = useRef(locale)
  localeRef.current = locale

  const [items, setItems] = useState<SavedWorkflowView[] | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const generation = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const raw = await ctxRef.current.callAction('list', {})
      if (generation.current !== current) return
      const parsed = parseSavedWorkflowList(raw)
      if (parsed === undefined) {
        setError(libListInvalid(localeRef.current))
      } else {
        setItems(parsed)
      }
    } catch (err) {
      if (generation.current !== current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { items, loading, error, reload }
}
