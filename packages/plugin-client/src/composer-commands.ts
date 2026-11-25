/**
 * Panel-local composer command handler registry and hook (`useComposerCommand`).
 *
 * Allows mounted composer slot components (in both persisted Conversation
 * Composer and AgentStandbyPane) to claim interactive execution of their
 * plugin's `CommandSpec` (e.g. `toggle-plan` toggling local standby
 * `inputMeta` or optimistically toggling persisted session state) without
 * routing through raw RPC or adding one-off protocol fields.
 *
 * Pure TS module (exports Context + store factory + hook, no components — Fast Refresh compliant).
 */
import { createContext, useContext, useEffect, useRef } from 'react'
import { PluginClientContext } from './plugin-context.js'

export type ComposerCommandHandler = () => void | Promise<void>

export type ComposerCommandInvokeResult =
  | { handled: true; result: void | Promise<void> }
  | { handled: false }

export interface ComposerCommandRegistry {
  register(pluginId: string, commandId: string, handler: ComposerCommandHandler): () => void
  has(pluginId: string, commandId: string): boolean
  invoke(pluginId: string, commandId: string): ComposerCommandInvokeResult
  subscribe(listener: () => void): () => void
  getVersion(): number
}

interface HandlerEntry {
  token: symbol
  handler: ComposerCommandHandler
}

/**
 * Creates a composer-scoped registry mapping `(pluginId, commandId)` pairs to
 * local handlers. Key-set presence version (`getVersion()`) increments only when
 * a `(pluginId, commandId)` pair transitions between absent and present (`0 -> 1`
 * or `1 -> 0`), keeping React subscriptions minimal.
 */
export function createComposerCommandRegistry(): ComposerCommandRegistry {
  const buckets = new Map<string, HandlerEntry[]>()
  const listeners = new Set<() => void>()
  let version = 0

  const makeKey = (pluginId: string, commandId: string): string => `${pluginId}\0${commandId}`
  const emit = (): void => {
    for (const listener of [...listeners]) {
      listener()
    }
  }

  return {
    register(pluginId: string, commandId: string, handler: ComposerCommandHandler): () => void {
      if (pluginId === '' || commandId === '') {
        return () => {}
      }
      const key = makeKey(pluginId, commandId)
      const token = Symbol()
      const existing = buckets.get(key)
      if (existing === undefined) {
        buckets.set(key, [{ token, handler }])
        version += 1
        emit()
      } else {
        existing.push({ token, handler })
      }
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
          version += 1
          emit()
        }
      }
    },

    has(pluginId: string, commandId: string): boolean {
      if (pluginId === '' || commandId === '') return false
      return (buckets.get(makeKey(pluginId, commandId))?.length ?? 0) > 0
    },

    invoke(pluginId: string, commandId: string): ComposerCommandInvokeResult {
      if (pluginId === '' || commandId === '') return { handled: false }
      const list = buckets.get(makeKey(pluginId, commandId))
      const top = list !== undefined && list.length > 0 ? list[list.length - 1] : undefined
      if (top === undefined) return { handled: false }
      return { handled: true, result: top.handler() }
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

    getVersion(): number {
      return version
    },
  }
}

export const ComposerCommandContext = createContext<ComposerCommandRegistry | undefined>(undefined)

/**
 * Registers a local handler for this plugin's `commandId` inside the nearest
 * enclosing `ComposerCommandContext` (and `PluginClientContext`). Keeps a ref to
 * the latest `handler` so closure updates never churn registry subscriptions.
 * No-op when mounted outside composer command contexts or with `handler: undefined`.
 */
export function useComposerCommand(
  commandId: string,
  handler: ComposerCommandHandler | undefined,
): void {
  const registry = useContext(ComposerCommandContext)
  const pluginId = useContext(PluginClientContext)?.pluginId
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  const active =
    registry !== undefined &&
    pluginId !== undefined &&
    pluginId !== '' &&
    commandId !== '' &&
    handler !== undefined

  useEffect(() => {
    if (!active) return
    return registry.register(pluginId, commandId, () => handlerRef.current?.())
  }, [active, registry, pluginId, commandId])
}
