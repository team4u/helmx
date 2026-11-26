/**
 * Panel-local composer ModelPicker mode registry and hook (`useComposerModelPickerMode`).
 *
 * Allows mounted composer slot components (in both persisted Conversation
 * Composer and AgentStandbyPane) to contribute selectable modes (e.g. one-turn
 * model selection) to the host `ModelPickerControl` without hardcoding plugin
 * IDs or mounting duplicate pickers.
 *
 * Pure TS module (exports Context + store factory + hook, no components — Fast Refresh compliant).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react'

export interface ComposerModelPickerModeSelection {
  modelKey: string
  thinkingLevel: string
}

export interface ComposerModelPickerModeSpec {
  id?: string
  label: string
  hint?: string
  effectiveModel?: string
  activeThinkingLevel?: string
  hideResetDefault?: boolean
  onApply: (selection: ComposerModelPickerModeSelection) => void | Promise<void>
}

export interface ComposerModelPickerModeRegistration {
  key: string
  spec: ComposerModelPickerModeSpec
}

export interface ComposerModelPickerModeRegistry {
  register(key: string, spec: ComposerModelPickerModeSpec): () => void
  getModes(): readonly ComposerModelPickerModeRegistration[]
  has(key: string): boolean
  subscribe(listener: () => void): () => void
  setOpenMode(handler: ((modeKey: string) => void) | null): () => void
  openMode(modeKey: string): boolean
}

interface ModeEntry {
  token: symbol
  spec: ComposerModelPickerModeSpec
}

/**
 * Creates a composer-scoped registry mapping mode keys to picker mode specs
 * and providing a host `openMode` trigger handle. `getModes()` returns a
 * referentially stable frozen snapshot between mutations so
 * `useSyncExternalStore` stays render-minimal.
 */
export function createComposerModelPickerModeRegistry(): ComposerModelPickerModeRegistry {
  const buckets = new Map<string, ModeEntry[]>()
  const listeners = new Set<() => void>()
  let snapshot: readonly ComposerModelPickerModeRegistration[] = Object.freeze([])
  let openModeHandler: ((modeKey: string) => void) | null = null
  let openModeToken: symbol | null = null

  const rebuildSnapshot = (): void => {
    const next: ComposerModelPickerModeRegistration[] = []
    for (const [key, entries] of buckets) {
      const top = entries.length > 0 ? entries[entries.length - 1] : undefined
      if (top !== undefined) {
        next.push({ key, spec: top.spec })
      }
    }
    snapshot = Object.freeze(next)
  }

  const emit = (): void => {
    for (const listener of [...listeners]) {
      listener()
    }
  }

  return {
    register(key: string, spec: ComposerModelPickerModeSpec): () => void {
      if (key === '' || spec.label.trim() === '') {
        return () => {}
      }
      const token = Symbol()
      const existing = buckets.get(key)
      if (existing === undefined) {
        buckets.set(key, [{ token, spec }])
      } else {
        existing.push({ token, spec })
      }
      rebuildSnapshot()
      emit()
      let released = false
      return () => {
        if (released) return
        released = true
        const list = buckets.get(key)
        if (list === undefined) return
        const idx = list.findIndex((entry) => entry.token === token)
        if (idx === -1) return
        list.splice(idx, 1)
        if (list.length === 0) {
          buckets.delete(key)
        }
        rebuildSnapshot()
        emit()
      }
    },

    getModes(): readonly ComposerModelPickerModeRegistration[] {
      return snapshot
    },

    has(key: string): boolean {
      if (key === '') return false
      return (buckets.get(key)?.length ?? 0) > 0
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      let unsubscribed = false
      return () => {
        if (unsubscribed) return
        unsubscribed = true
        listeners.delete(listener)
      }
    },

    setOpenMode(handler: ((modeKey: string) => void) | null): () => void {
      if (handler === null) {
        openModeHandler = null
        openModeToken = null
        return () => {}
      }
      const token = Symbol()
      openModeHandler = handler
      openModeToken = token
      let released = false
      return () => {
        if (released) return
        released = true
        if (openModeToken === token) {
          openModeHandler = null
          openModeToken = null
        }
      }
    },

    openMode(modeKey: string): boolean {
      if (modeKey === '' || openModeHandler === null) return false
      const entries = buckets.get(modeKey)
      if (entries === undefined || entries.length === 0) return false
      openModeHandler(modeKey)
      return true
    },
  }
}

export const ComposerModelPickerModeContext = createContext<ComposerModelPickerModeRegistry | undefined>(undefined)

/**
 * Registers a mode inside the nearest enclosing `ComposerModelPickerModeContext`.
 * Keeps `spec.onApply` in a ref so callback identity changes never trigger
 * registry updates or popover re-renders; only `spec === null` or display
 * metadata changes update the registry.
 */
export function useComposerModelPickerMode(
  key: string,
  spec: ComposerModelPickerModeSpec | null,
): { openMode: () => boolean } {
  const registry = useContext(ComposerModelPickerModeContext)
  const onApplyRef = useRef(spec?.onApply)
  onApplyRef.current = spec?.onApply

  const active =
    registry !== undefined &&
    key !== '' &&
    spec !== null &&
    spec.label.trim() !== ''

  const specId = spec?.id
  const specLabel = spec?.label ?? ''
  const specHint = spec?.hint
  const specEffectiveModel = spec?.effectiveModel
  const specActiveThinkingLevel = spec?.activeThinkingLevel
  const specHideResetDefault = spec?.hideResetDefault

  useEffect(() => {
    if (!active || registry === undefined) return
    return registry.register(key, {
      ...(specId !== undefined ? { id: specId } : {}),
      label: specLabel,
      ...(specHint !== undefined ? { hint: specHint } : {}),
      ...(specEffectiveModel !== undefined ? { effectiveModel: specEffectiveModel } : {}),
      ...(specActiveThinkingLevel !== undefined ? { activeThinkingLevel: specActiveThinkingLevel } : {}),
      ...(specHideResetDefault !== undefined ? { hideResetDefault: specHideResetDefault } : {}),
      onApply: (selection) => onApplyRef.current?.(selection),
    })
  }, [
    registry,
    active,
    key,
    specId,
    specLabel,
    specHint,
    specEffectiveModel,
    specActiveThinkingLevel,
    specHideResetDefault,
  ])

  const openMode = useCallback((): boolean => {
    if (!active || registry === undefined) return false
    return registry.openMode(key)
  }, [active, registry, key])

  return useMemo(() => ({ openMode }), [openMode])
}
