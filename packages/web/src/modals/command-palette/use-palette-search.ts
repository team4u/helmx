/**
 * 命令面板 FTS5 全文检索状态：200ms 防抖 + AbortController + 代数守卫 + IME 组合态延后；
 * 查询变化先同步清空旧结果（settledQuery 前缀判断）避免旧命中闪烁。
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { searchApi } from '../../lib/api.js'
import { isAbortError } from '../../lib/request-manager.js'
import type { PaletteSearchHit } from '../command-palette-model.js'

export interface PaletteSearch {
  query: string
  setQuery: (next: string) => void
  isComposing: boolean
  /** 同步读取的组合态（键盘 / Esc 处理用，避免闭包拿到过期 state）。 */
  composingRef: RefObject<boolean>
  hits: PaletteSearchHit[]
  searching: boolean
  searchFailed: boolean
  settledQuery: string
}

export function usePaletteSearch(inputEl: HTMLInputElement | null, searchDebounceMs: number): PaletteSearch {
  const [query, setQuery] = useState('')
  const [isComposing, setIsComposing] = useState(false)
  const [hits, setHits] = useState<PaletteSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [settledQuery, setSettledQuery] = useState('')
  const composingRef = useRef(false)
  const searchGenRef = useRef(0)
  const searchAbortRef = useRef<AbortController | null>(null)
  const settledQueryRef = useRef('')

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

    const q = query.trim()
    if (q === '') {
      searchGenRef.current += 1
      settledQueryRef.current = ''
      setSettledQuery('')
      setHits([])
      setSearching(false)
      setSearchFailed(false)
      return
    }

    if (isComposing) {
      setSearching(false)
      return
    }

    const gen = ++searchGenRef.current
    setSearching(true)
    setSearchFailed(false)
    if (settledQueryRef.current !== '' && !q.startsWith(settledQueryRef.current)) {
      setHits([])
    }

    const timer = setTimeout(() => {
      const controller = new AbortController()
      searchAbortRef.current = controller
      searchApi
        .query(q, { signal: controller.signal })
        .then((items) => {
          if (gen !== searchGenRef.current || controller.signal.aborted) return
          settledQueryRef.current = q
          setSettledQuery(q)
          setHits(items.slice(0, 8))
          setSearchFailed(false)
          setSearching(false)
        })
        .catch((err: unknown) => {
          if (gen !== searchGenRef.current || controller.signal.aborted || isAbortError(err)) return
          settledQueryRef.current = q
          setSettledQuery(q)
          setHits([])
          setSearchFailed(true)
          setSearching(false)
        })
    }, searchDebounceMs)

    return () => {
      clearTimeout(timer)
      searchAbortRef.current?.abort()
      searchAbortRef.current = null
    }
  }, [query, isComposing, searchDebounceMs])

  return { query, setQuery, isComposing, composingRef, hits, searching, searchFailed, settledQuery }
}
