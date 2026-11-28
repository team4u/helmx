/**
 * Single debounced async Omnibox search hook (`GET /api/omnibox/search`):
 * - 200ms debounce + AbortController + generation guard + IME composition deferral
 * - Prefix-carry anti-flicker (`settledQuery`) while typing continuations
 * - Honest degraded-state flags (`requestFailed`, `messagesUnavailable`, `failedPlugins`)
 */
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { HelmxLocale, OmniboxPluginHit } from '@helmx/protocol/browser'
import { omniboxApi } from '../lib/api.js'
import { isAbortError } from '../lib/request-manager.js'
import { parseOmniboxQuery } from './matcher.js'
import type { OmniboxMessageHit } from './sources/conversations.js'

export interface UseOmniboxSearchOptions {
  inputEl: HTMLInputElement | null
  searchDebounceMs: number
  locale: HelmxLocale
  conversationId: number | undefined
}

export interface OmniboxSearchState {
  query: string
  setQuery: (next: string) => void
  isComposing: boolean
  /** Synchronous IME composition flag for keyboard / Esc handlers. */
  composingRef: RefObject<boolean>
  messages: OmniboxMessageHit[]
  pluginItems: OmniboxPluginHit[]
  messagesUnavailable: boolean
  failedPlugins: string[]
  requestFailed: boolean
  searching: boolean
  settledQuery: string
}

const DEFAULT_REMOTE_LIMIT = 12

export function useOmniboxSearch({
  inputEl,
  searchDebounceMs,
  locale,
  conversationId,
}: UseOmniboxSearchOptions): OmniboxSearchState {
  const [query, setQuery] = useState('')
  const [isComposing, setIsComposing] = useState(false)
  const [messages, setMessages] = useState<OmniboxMessageHit[]>([])
  const [pluginItems, setPluginItems] = useState<OmniboxPluginHit[]>([])
  const [messagesUnavailable, setMessagesUnavailable] = useState(false)
  const [failedPlugins, setFailedPlugins] = useState<string[]>([])
  const [requestFailed, setRequestFailed] = useState(false)
  const [searching, setSearching] = useState(false)
  const [settledQuery, setSettledQuery] = useState('')

  const composingRef = useRef(false)
  const searchGenRef = useRef(0)
  const searchAbortRef = useRef<AbortController | null>(null)
  const settledQueryRef = useRef('')

  const remoteQuery = useMemo(() => {
    const parsed = parseOmniboxQuery(query, 'all')
    // Exact `#<id>` pin resolves strictly against local conversations at 0ms without remote noise.
    return parsed.exactConversationId !== null ? '' : parsed.searchText
  }, [query])

  useEffect(() => {
    if (!inputEl) return
    const onCompositionStart = () => {
      composingRef.current = true
      setIsComposing(true)
    }
    const onCompositionEnd = () => {
      composingRef.current = false
      setIsComposing(false)
    }
    inputEl.addEventListener('compositionstart', onCompositionStart)
    inputEl.addEventListener('compositionend', onCompositionEnd)
    return () => {
      inputEl.removeEventListener('compositionstart', onCompositionStart)
      inputEl.removeEventListener('compositionend', onCompositionEnd)
    }
  }, [inputEl])

  useEffect(() => {
    searchAbortRef.current?.abort()
    searchAbortRef.current = null

    if (remoteQuery === '') {
      searchGenRef.current += 1
      settledQueryRef.current = ''
      setSettledQuery('')
      setMessages([])
      setPluginItems([])
      setMessagesUnavailable(false)
      setFailedPlugins([])
      setRequestFailed(false)
      setSearching(false)
      return
    }

    if (isComposing) {
      setSearching(false)
      return
    }

    const gen = ++searchGenRef.current
    setSearching(true)
    setRequestFailed(false)
    if (settledQueryRef.current !== '' && !remoteQuery.startsWith(settledQueryRef.current)) {
      setMessages([])
      setPluginItems([])
      setMessagesUnavailable(false)
      setFailedPlugins([])
    }

    const timer = setTimeout(() => {
      const controller = new AbortController()
      searchAbortRef.current = controller
      omniboxApi
        .search(remoteQuery, {
          limit: DEFAULT_REMOTE_LIMIT,
          locale,
          ...(conversationId !== undefined ? { conversationId } : {}),
          signal: controller.signal,
        })
        .then((res) => {
          if (gen !== searchGenRef.current || controller.signal.aborted) return
          const nextMessages = Array.isArray(res?.messages) ? (res.messages as OmniboxMessageHit[]) : []
          const nextPlugins = Array.isArray(res?.pluginItems) ? res.pluginItems : []
          const nextFailedPlugins = Array.isArray(res?.failedPlugins)
            ? res.failedPlugins.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
            : []
          settledQueryRef.current = remoteQuery
          setSettledQuery(remoteQuery)
          setMessages(nextMessages)
          setPluginItems(nextPlugins)
          setMessagesUnavailable(res?.messagesUnavailable === true)
          setFailedPlugins(nextFailedPlugins)
          setRequestFailed(false)
          setSearching(false)
        })
        .catch((err: unknown) => {
          if (gen !== searchGenRef.current || controller.signal.aborted || isAbortError(err)) return
          settledQueryRef.current = remoteQuery
          setSettledQuery(remoteQuery)
          setMessages([])
          setPluginItems([])
          setMessagesUnavailable(false)
          setFailedPlugins([])
          setRequestFailed(true)
          setSearching(false)
        })
    }, searchDebounceMs)

    return () => {
      clearTimeout(timer)
      searchAbortRef.current?.abort()
      searchAbortRef.current = null
    }
  }, [remoteQuery, isComposing, searchDebounceMs, locale, conversationId])

  return {
    query,
    setQuery,
    isComposing,
    composingRef,
    messages,
    pluginItems,
    messagesUnavailable,
    failedPlugins,
    requestFailed,
    searching,
    settledQuery,
  }
}
