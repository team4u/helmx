/**
 * Data hooks for the builtin:swarm client (strict boundary parsing, cancellation-safe).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePluginContext, usePluginLocale, useSharedNowMs } from '@helmx/plugin-client'
import { parseBoardReadPosts, parseBoardView, type BoardPost, type BoardViewDoc } from './board-model.ts'
import { panelStatusInvalid } from './copy.ts'

export { useSharedNowMs as useElapsedNowMs }

function mergePostLists(existing: readonly BoardPost[], incoming: readonly BoardPost[]): BoardPost[] {
  if (incoming.length === 0) return [...existing]
  const bySeq = new Map<number, BoardPost>(existing.map((p) => [p.seq, p]))
  for (const p of incoming) bySeq.set(p.seq, p)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface SwarmBoardFallbackState {
  view: BoardViewDoc | undefined; loading: boolean; error: string | undefined; reload: () => void
}

export function useSwarmBoardStatusFallback(
  groupId: string | undefined,
  options: { conversationId?: number; enabled?: boolean; allowConversationLookup?: boolean } = {},
): SwarmBoardFallbackState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const enabled = options.enabled !== false
  const allowLookup = options.allowConversationLookup === true
  const [view, setView] = useState<BoardViewDoc | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const gen = useRef(0)
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    const hasGroupId = Boolean(groupId)
    if (!enabled || (!hasGroupId && !(allowLookup && options.conversationId !== undefined))) {
      setView(undefined); setError(undefined); setLoading(false); return
    }
    const cur = ++gen.current
    setLoading(true); setError(undefined)
    void ctx
      .callAction('board_status', hasGroupId ? { groupId } : {}, { conversationId: options.conversationId })
      .then((raw) => {
        if (gen.current !== cur) return
        const parsed = parseBoardView(raw)
        if (!parsed) { setError(panelStatusInvalid(locale)); setView(undefined) } else setView(parsed)
      })
      .catch((err: unknown) => { if (gen.current === cur) { setError(errText(err)); setView(undefined) } })
      .finally(() => { if (gen.current === cur) setLoading(false) })
  }, [enabled, groupId, allowLookup, options.conversationId, ctx, locale, nonce])

  return { view, loading, error, reload }
}

export interface SwarmBoardReadState {
  posts: BoardPost[]; loading: boolean; loadingEarlier: boolean; hasEarlier: boolean
  error: string | undefined; retry: () => void; loadEarlier: () => void
}

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
  const gen = useRef(0)
  const earlierGen = useRef(0)
  const lastGroupId = useRef<string | undefined>(undefined)
  const loadedKey = useRef<string | undefined>(undefined)

  const retry = useCallback(() => { loadedKey.current = undefined; setEarlierExhausted(false); setNonce((n) => n + 1) }, [])

  useEffect(() => {
    if (lastGroupId.current !== groupId) {
      lastGroupId.current = groupId; loadedKey.current = undefined; gen.current += 1; earlierGen.current += 1
      setPosts([]); setError(undefined); setLoading(false); setLoadingEarlier(false); setEarlierExhausted(false)
    }
    if (!open || !groupId) return
    const targetKey = `${groupId}:${options.headSeq ?? 0}`
    if (loadedKey.current === targetKey) return
    const cur = ++gen.current
    setLoading(true); setError(undefined)
    void ctx
      .callAction('board_read', { groupId, limit: 200 }, { conversationId: options.conversationId })
      .then((raw) => {
        if (gen.current !== cur) return
        const parsed = parseBoardReadPosts(raw)
        if (!parsed) setError(panelStatusInvalid(locale))
        else { loadedKey.current = targetKey; setPosts((prev) => mergePostLists(prev, parsed)) }
      })
      .catch((err: unknown) => { if (gen.current === cur) setError(errText(err)) })
      .finally(() => { if (gen.current === cur) setLoading(false) })
  }, [open, groupId, options.headSeq, options.conversationId, ctx, locale, nonce])

  const minSeq = posts.length > 0 ? posts[0]!.seq : options.initialOldestSeq
  const hasEarlier = open && !earlierExhausted && minSeq !== undefined && minSeq > 1 && (options.headSeq ?? 0) > posts.length

  const loadEarlier = useCallback(() => {
    if (!groupId || loadingEarlier || loading || minSeq === undefined || minSeq <= 1) return
    const limit = Math.min(200, minSeq - 1)
    const sinceSeq = Math.max(0, minSeq - 1 - limit)
    const cur = ++earlierGen.current
    const targetGroupId = groupId
    setLoadingEarlier(true); setError(undefined)
    void ctx
      .callAction('board_read', { groupId: targetGroupId, sinceSeq, limit }, { conversationId: options.conversationId })
      .then((raw) => {
        if (earlierGen.current !== cur || lastGroupId.current !== targetGroupId) return
        const parsed = parseBoardReadPosts(raw)
        if (!parsed) setError(panelStatusInvalid(locale))
        else if (parsed.length === 0 || parsed[0]!.seq >= minSeq) setEarlierExhausted(true)
        else setPosts((prev) => mergePostLists(prev, parsed))
      })
      .catch((err: unknown) => { if (earlierGen.current === cur && lastGroupId.current === targetGroupId) setError(errText(err)) })
      .finally(() => { if (earlierGen.current === cur) setLoadingEarlier(false) })
  }, [groupId, loadingEarlier, loading, minSeq, ctx, options.conversationId, locale])

  return { posts, loading, loadingEarlier, hasEarlier, error, retry, loadEarlier }
}

export interface SwarmBoardPeekState {
  posts: BoardPost[]; loading: boolean; error: string | undefined; retry: () => void
}

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
  const gen = useRef(0)
  const lastGroupId = useRef<string | undefined>(undefined)
  const attempted = useRef(new Set<number>())

  const retry = useCallback(() => {
    if (targetSeq !== undefined) attempted.current.delete(targetSeq)
    setError(undefined); setNonce((n) => n + 1)
  }, [targetSeq])

  useEffect(() => {
    if (lastGroupId.current !== groupId) {
      lastGroupId.current = groupId; attempted.current.clear(); gen.current += 1
      setPosts([]); setError(undefined); setLoading(false)
    }
    if (!enabled || !groupId || targetSeq === undefined) { setLoading(false); setError(undefined); return }
    if (attempted.current.has(targetSeq)) return
    const cur = ++gen.current
    const seq = targetSeq
    setLoading(true); setError(undefined)
    void ctx
      .callAction('board_read', { groupId, seqs: [seq] }, { conversationId: options.conversationId })
      .then((raw) => {
        if (gen.current !== cur) return
        const parsed = parseBoardReadPosts(raw)
        if (!parsed) setError(panelStatusInvalid(locale))
        else { attempted.current.add(seq); if (parsed.length > 0) setPosts((prev) => mergePostLists(prev, parsed)) }
      })
      .catch((err: unknown) => { if (gen.current === cur) setError(errText(err)) })
      .finally(() => { if (gen.current === cur) setLoading(false) })
  }, [enabled, groupId, targetSeq, options.conversationId, ctx, locale, nonce])

  return { posts, loading, error, retry }
}
