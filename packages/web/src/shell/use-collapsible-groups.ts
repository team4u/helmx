/**
 * Shared search-aware section collapse hook used by ConversationOverview and SidebarConversationList.
 */
import { useCallback, useMemo, useState } from 'react'

const EMPTY_COLLAPSED_KEYS: ReadonlySet<string> = new Set()

export interface UseCollapsibleGroupsResult {
  activeCollapsedKeys: ReadonlySet<string>
  toggleGroupCollapsed: (groupKey: string) => void
  searchActive: boolean
  normalizedQuery: string
}

/**
 * Manages section collapse keys while temporarily expanding matching sections
 * whenever a search query is active, without losing prior collapsed keys once
 * search is cleared.
 */
export function useCollapsibleGroups(query: string): UseCollapsibleGroupsResult {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [searchCollapseState, setSearchCollapseState] = useState<{ query: string; keys: Set<string> }>({
    query: '',
    keys: new Set(),
  })

  const normalizedQuery = query.trim()
  const searchActive = normalizedQuery !== ''

  const activeCollapsedKeys = useMemo<ReadonlySet<string>>(() => {
    if (searchActive) {
      return searchCollapseState.query === normalizedQuery ? searchCollapseState.keys : EMPTY_COLLAPSED_KEYS
    }
    return collapsedGroups
  }, [searchActive, searchCollapseState, normalizedQuery, collapsedGroups])

  const toggleGroupCollapsed = useCallback(
    (groupKey: string): void => {
      if (searchActive) {
        setSearchCollapseState((prev) => {
          const nextKeys = prev.query === normalizedQuery ? new Set(prev.keys) : new Set<string>()
          if (nextKeys.has(groupKey)) nextKeys.delete(groupKey)
          else nextKeys.add(groupKey)
          return { query: normalizedQuery, keys: nextKeys }
        })
        return
      }
      setCollapsedGroups((prev) => {
        const next = new Set(prev)
        if (next.has(groupKey)) next.delete(groupKey)
        else next.add(groupKey)
        return next
      })
    },
    [searchActive, normalizedQuery],
  )

  return {
    activeCollapsedKeys,
    toggleGroupCollapsed,
    searchActive,
    normalizedQuery,
  }
}
