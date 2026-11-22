/**
 * Data hooks for the builtin:swarm client (host store driven, zero private
 * dependencies; pure functions live in *-model.ts, display copy in copy.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePluginContext, usePluginLocale, useSharedNowMs } from '@helmx/plugin-client'
import { parseBoardReadPosts, parseBoardView, type BoardPost, type BoardViewDoc } from './board-model.ts'
import { panelStatusInvalid } from './copy.ts'

/** Shared 1Hz stopwatch (SSR first frame returns undefined). */
export function useElapsedNowMs(active: boolean): number | undefined {
  return useSharedNowMs(active)
}

export interface SwarmBoardFallbackState {
  view: BoardViewDoc | undefined
  loading: boolean
  error: string | undefined
  reload: () => void
}

/**
 * Explicit one-shot `board_status` fallback for groups without a live
 * board-view session doc (closed / coordinatorDetached / projection pending):
 * strict boundary parsing — structurally invalid payloads fail explicitly with
 * a Retry affordance, never a fabricated "running" board.
 */
export function useSwarmBoardStatusFallback(
  groupId: string | undefined,
  options: { conversationId?: number; enabled?: boolean; allowConversationLookup?: boolean } = {},
): SwarmBoardFallbackState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const enabled = options.enabled !== false
  const allowConversationLookup = options.allowConversationLookup === true
  const [view, setView] = useState<BoardViewDoc | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)

  const reload = useCallback(() => {
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    const hasGroupId = groupId !== undefined && groupId !== ''
    const canLookupByConv = allowConversationLookup && options.conversationId !== undefined
    if (!enabled || (!hasGroupId && !canLookupByConv)) {
      setView(undefined)
      setError(undefined)
      setLoading(false)
      return
    }
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    const input = hasGroupId ? { groupId } : {}
    void ctx
      .callAction('board_status', input, { conversationId: options.conversationId })
      .then((raw) => {
        if (generation.current !== current) return
        const parsed = parseBoardView(raw)
        if (parsed === undefined) {
          setError(panelStatusInvalid(locale))
          setView(undefined)
          return
        }
        setView(parsed)
      })
      .catch((err: unknown) => {
        if (generation.current !== current) return
        setError(err instanceof Error ? err.message : String(err))
        setView(undefined)
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
  }, [enabled, groupId, allowConversationLookup, options.conversationId, ctx, locale, nonce])

  return { view, loading, error, reload }
}

function mergePostLists(existing: readonly BoardPost[], incoming: readonly BoardPost[]): BoardPost[] {
  if (incoming.length === 0) return [...existing]
  const bySeq = new Map<number, BoardPost>()
  for (const p of existing) bySeq.set(p.seq, p)
  for (const p of incoming) bySeq.set(p.seq, p)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}

export interface SwarmBoardReadState {
  posts: BoardPost[]
  loading: boolean
  loadingEarlier: boolean
  hasEarlier: boolean
  error: string | undefined
  retry: () => void
  loadEarlier: () => void
}

/**
 * On-demand `board_read` history loader for the "show full record" affordance
 * in the workbench panel: loads the newest page (`limit: 200`), accumulates
 * earlier pages backwards via `sinceSeq` when `headSeq > 200`, tracks headSeq
 * updates without discarding earlier pages, and resets cleanly on group switch.
 */
export function useSwarmBoardReadOnce(
  groupId: string | undefined,
  open: boolean,
  options: { conversationId?: number; headSeq?: number; initialOldestSeq?: number } = {},
): SwarmBoardReadState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [posts, setPosts] = useState<BoardPost[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierExhausted, setEarlierExhausted] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)
  const earlierGen = useRef(0)
  const lastGroupId = useRef<string | undefined>(undefined)
  const loadedKey = useRef<string | undefined>(undefined)

  const retry = useCallback(() => {
    loadedKey.current = undefined
    setEarlierExhausted(false)
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    if (lastGroupId.current !== groupId) {
      lastGroupId.current = groupId
      loadedKey.current = undefined
      generation.current += 1
      earlierGen.current += 1
      setPosts([])
      setError(undefined)
      setLoading(false)
      setLoadingEarlier(false)
      setEarlierExhausted(false)
    }
    if (!open || groupId === undefined || groupId === '') return
    const targetKey = `${groupId}:${options.headSeq ?? 0}`
    if (loadedKey.current === targetKey) return
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    void ctx
      .callAction('board_read', { groupId, limit: 200 }, { conversationId: options.conversationId })
      .then((raw) => {
        if (generation.current !== current) return
        const parsed = parseBoardReadPosts(raw)
        if (parsed === undefined) {
          setError(panelStatusInvalid(locale))
          return
        }
        loadedKey.current = targetKey
        setPosts((prev) => mergePostLists(prev, parsed))
      })
      .catch((err: unknown) => {
        if (generation.current !== current) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
  }, [open, groupId, options.headSeq, options.conversationId, ctx, locale, nonce])

  const contiguousMinSeq =
    posts.length > 0
      ? posts[0]!.seq
      : options.initialOldestSeq

  const hasEarlier =
    open &&
    !earlierExhausted &&
    contiguousMinSeq !== undefined &&
    contiguousMinSeq > 1 &&
    (options.headSeq ?? 0) > posts.length

  const loadEarlier = useCallback(() => {
    if (groupId === undefined || groupId === '' || loadingEarlier || loading) return
    if (contiguousMinSeq === undefined || contiguousMinSeq <= 1) return
    const pageLimit = Math.min(200, contiguousMinSeq - 1)
    const sinceSeq = Math.max(0, contiguousMinSeq - 1 - pageLimit)
    const current = ++earlierGen.current
    const targetGroupId = groupId
    setLoadingEarlier(true)
    setError(undefined)
    void ctx
      .callAction(
        'board_read',
        { groupId: targetGroupId, sinceSeq, limit: pageLimit },
        { conversationId: options.conversationId },
      )
      .then((raw) => {
        if (earlierGen.current !== current || lastGroupId.current !== targetGroupId) return
        const parsed = parseBoardReadPosts(raw)
        if (parsed === undefined) {
          setError(panelStatusInvalid(locale))
          return
        }
        if (parsed.length === 0 || parsed[0]!.seq >= contiguousMinSeq) {
          setEarlierExhausted(true)
          return
        }
        setPosts((prev) => mergePostLists(prev, parsed))
      })
      .catch((err: unknown) => {
        if (earlierGen.current !== current || lastGroupId.current !== targetGroupId) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (earlierGen.current === current) setLoadingEarlier(false)
      })
  }, [groupId, loadingEarlier, loading, contiguousMinSeq, ctx, options.conversationId, locale])

  return { posts, loading, loadingEarlier, hasEarlier, error, retry, loadEarlier }
}

export interface SwarmBoardPeekState {
  posts: BoardPost[]
  loading: boolean
  error: string | undefined
  retry: () => void
}

/**
 * Exact O(1) `board_read({ groupId, seqs: [targetSeq] })` loader for `#seq`
 * peek popovers when the referenced post is not in the live/history cache
 * (works for any seq even in >200 post groups, accumulates fetched posts per
 * group so nested `#18 -> #12 -> #5` navigation never refetches).
 */
export function useSwarmBoardPeekPost(
  groupId: string | undefined,
  targetSeq: number | undefined,
  options: { conversationId?: number; enabled?: boolean } = {},
): SwarmBoardPeekState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const enabled = options.enabled === true
  const [posts, setPosts] = useState<BoardPost[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)
  const lastGroupId = useRef<string | undefined>(undefined)
  const attemptedSeqs = useRef(new Set<number>())

  const retry = useCallback(() => {
    if (targetSeq !== undefined) attemptedSeqs.current.delete(targetSeq)
    setError(undefined)
    setNonce((n) => n + 1)
  }, [targetSeq])

  useEffect(() => {
    if (lastGroupId.current !== groupId) {
      lastGroupId.current = groupId
      attemptedSeqs.current.clear()
      generation.current += 1
      setPosts([])
      setError(undefined)
      setLoading(false)
    }
    if (!enabled || groupId === undefined || groupId === '' || targetSeq === undefined) {
      setLoading(false)
      setError(undefined)
      return
    }
    if (attemptedSeqs.current.has(targetSeq)) return
    const current = ++generation.current
    const seqToFetch = targetSeq
    setLoading(true)
    setError(undefined)
    void ctx
      .callAction(
        'board_read',
        { groupId, seqs: [seqToFetch] },
        { conversationId: options.conversationId },
      )
      .then((raw) => {
        if (generation.current !== current) return
        const parsed = parseBoardReadPosts(raw)
        if (parsed === undefined) {
          setError(panelStatusInvalid(locale))
          return
        }
        attemptedSeqs.current.add(seqToFetch)
        if (parsed.length > 0) {
          setPosts((prev) => mergePostLists(prev, parsed))
        }
      })
      .catch((err: unknown) => {
        if (generation.current !== current) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
  }, [enabled, groupId, targetSeq, options.conversationId, ctx, locale, nonce])

  return { posts, loading, error, retry }
}
