/**
 * Universal URL-hash-backed detail drawer controller for plugin Screen views.
 *
 * Binds drawer open/item/create state to the enclosing `ScreenHost` params
 * scope (`useScreenParams()`, automatically isolated across main `sp.*` and
 * split `ssp.*` panes) with unified browser/mobile Back semantics:
 * - closed -> open (item or create): passes `{ push: true }` so browser/mobile
 *   Back closes the drawer and stays on the screen instead of leaving it;
 * - open -> switch item/mode: omits `push` (host `replace`, paired with
 *   symmetric back-pop when returning to the pre-open hash);
 * - close: omits `push` (safe on deep links and symmetric with closed -> open);
 * - stale/nonexistent item params (via optional `hasItem` predicate): treated
 *   as closed so selecting a real item still pushes history;
 * - unhosted context (e.g. `settingsPanel` or standalone SSR/tests without
 *   `setParams`): transparently falls back to local React state.
 *
 * Pure `.ts` hook module (Fast Refresh friendly).
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import type { ScreenParamsScope } from '@helmx/protocol/browser'
import { useScreenParams } from '../screen-params.js'

export type ScreenDrawerMode = 'closed' | 'create' | 'edit'

export interface UseScreenDrawerOptions {
  /** Screen param key holding the active item id (defaults to `'edit'`). */
  param?: string
  /** Optional screen param key enabling create mode when equal to `'1'` (e.g. `'create'`). */
  createParam?: string
  /**
   * Predicate checking whether a non-empty `itemId` currently resolves to a
   * rendered item (defaults to `() => true`). Returning `false` for loaded but
   * missing IDs prevents stale deep links from blocking `push` when a real
   * item is clicked later. Return `true` while initial data is still loading
   * so deep links are preserved until data settles.
   */
  hasItem?: (id: string) => boolean
  /**
   * Optional explicit scope override (for standalone/unit harnesses passing
   * `ScreenProps` directly without an enclosing `ScreenHost` / `ScreenParamsContext`).
   */
  scope?: Partial<Pick<ScreenParamsScope, 'params' | 'setParams'>>
}

export interface UseScreenDrawerResult {
  /** Whether the drawer should currently be open (`creating` or a resolved `itemId`). */
  open: boolean
  /** Current drawer mode derived from the resolved state. */
  mode: ScreenDrawerMode
  /** Raw non-empty active item ID (undefined in create mode or when unset). */
  itemId: string | undefined
  /** True when `createParam === '1'` (create takes precedence over `param`). */
  creating: boolean
  /** Open or switch to an existing item drawer. Pushes history when transitioning from closed. */
  openItem: (id: string, extraPatch?: Record<string, string | undefined>) => void
  /** Open or switch to the create drawer (requires `createParam`). Pushes history when closed. */
  openCreate: (extraPatch?: Record<string, string | undefined>) => void
  /** Close the drawer (`replace` / symmetric back-pop on host). */
  close: (extraPatch?: Record<string, string | undefined>) => void
  /** Spread directly onto `<DetailDrawer {...drawer.drawerProps} ... />`. */
  drawerProps: {
    open: boolean
    onClose: () => void
  }
}

export function useScreenDrawer(options?: UseScreenDrawerOptions): UseScreenDrawerResult {
  const param = options?.param ?? 'edit'
  const createParam = options?.createParam
  const contextScope = useScreenParams()
  const overrideSetParams = options?.scope?.setParams
  const hasOverrideScope = typeof overrideSetParams === 'function'
  const activeSetParams = hasOverrideScope ? overrideSetParams : contextScope?.setParams
  const isHosted = typeof activeSetParams === 'function'
  const activeParams = hasOverrideScope ? options?.scope?.params : contextScope?.params

  const [localItemId, setLocalItemId] = useState<string | undefined>(undefined)
  const [localCreating, setLocalCreating] = useState(false)

  const creating =
    createParam !== undefined
      ? isHosted
        ? activeParams?.[createParam] === '1'
        : localCreating
      : false

  const rawItem = isHosted ? activeParams?.[param] : localItemId
  const itemId = creating ? undefined : rawItem !== undefined && rawItem !== '' ? rawItem : undefined
  const itemResolved = itemId !== undefined ? (options?.hasItem ? options.hasItem(itemId) : true) : false
  const open = creating || itemResolved
  const mode: ScreenDrawerMode = creating ? 'create' : open ? 'edit' : 'closed'

  const openRef = useRef(open)
  openRef.current = open
  const isHostedRef = useRef(isHosted)
  isHostedRef.current = isHosted
  const setParamsRef = useRef(activeSetParams)
  setParamsRef.current = activeSetParams

  const openItem = useCallback(
    (id: string, extraPatch?: Record<string, string | undefined>) => {
      if (id === '') return
      if (isHostedRef.current) {
        const shouldPush = !openRef.current
        setParamsRef.current?.(
          {
            ...extraPatch,
            ...(createParam !== undefined ? { [createParam]: undefined } : {}),
            [param]: id,
          },
          shouldPush ? { push: true } : undefined,
        )
        return
      }
      setLocalCreating(false)
      setLocalItemId(id)
    },
    [param, createParam],
  )

  const openCreate = useCallback(
    (extraPatch?: Record<string, string | undefined>) => {
      if (createParam === undefined) return
      if (isHostedRef.current) {
        const shouldPush = !openRef.current
        setParamsRef.current?.(
          {
            ...extraPatch,
            [param]: undefined,
            [createParam]: '1',
          },
          shouldPush ? { push: true } : undefined,
        )
        return
      }
      setLocalItemId(undefined)
      setLocalCreating(true)
    },
    [param, createParam],
  )

  const close = useCallback(
    (extraPatch?: Record<string, string | undefined>) => {
      if (isHostedRef.current) {
        setParamsRef.current?.({
          ...extraPatch,
          [param]: undefined,
          ...(createParam !== undefined ? { [createParam]: undefined } : {}),
        })
        return
      }
      setLocalCreating(false)
      setLocalItemId(undefined)
    },
    [param, createParam],
  )

  const drawerProps = useMemo(
    () => ({
      open,
      onClose: () => close(),
    }),
    [open, close],
  )

  return {
    open,
    mode,
    itemId,
    creating,
    openItem,
    openCreate,
    close,
    drawerProps,
  }
}
