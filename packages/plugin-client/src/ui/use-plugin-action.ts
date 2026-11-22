/**
 * Shared plugin action invocation hook (`usePluginAction`).
 *
 * Standardizes the in-flight mutual-exclusion / error-capture / unmount-safety
 * boilerplate previously re-implemented in every plugin client:
 * - Ref-backed synchronous mutex prevents double-submit races within a single
 *   React render tick;
 * - Exposes `pending` (boolean), `pendingKey` (caller-provided mutex key or
 *   actionId while in flight), `error`, `run(...)`, and `clearError()`;
 * - Never calls setState after unmount;
 * - Optionally surfaces errors via `ctx.notify(message, 'error')` when
 *   `notifyError: true` is configured.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePluginContext } from '../plugin-context.js'

export interface UsePluginActionOptions<TResult = unknown> {
  /** Format a thrown error into the display string stored in `error` (and optional toast). */
  formatError?: (error: unknown, actionId: string) => string
  /** Invoked on success when still mounted. */
  onSuccess?: (result: TResult, actionId: string) => void
  /** Invoked on error when still mounted. */
  onError?: (message: string, error: unknown, actionId: string) => void
  /** When true, also sends `ctx.notify(message, 'error')` on failure. */
  notifyError?: boolean
}

export interface RunPluginActionOptions<TResult = unknown> {
  /** Mutex / row key exposed via `pendingKey` while in flight (defaults to `actionId`). */
  key?: string
  /** Target plugin id when invoking a cross-plugin action (forwards to `ctx.callAction`). */
  pluginId?: string
  /** Explicit conversation id override (forwards to `ctx.callAction`). */
  conversationId?: number
  /** Per-call success callback (invoked before hook-level `onSuccess`, only if mounted). */
  onSuccess?: (result: TResult) => void
  /** Per-call error callback (invoked before hook-level `onError`, only if mounted). */
  onError?: (message: string, error: unknown) => void
}

export interface UsePluginActionResult<TResult = unknown> {
  /** True while an invocation owned by this hook is in flight. */
  pending: boolean
  /** Active in-flight key (`options.key ?? actionId`), or `undefined` when idle. */
  pendingKey: string | undefined
  /** Most recent formatted error message, cleared on the next `run` or `clearError()`. */
  error: string | undefined
  /**
   * Execute `ctx.callAction(actionId, input, targetPluginId)` under the
   * hook-level in-flight mutex. Returns the action result on success, or
   * `undefined` when skipped due to an active in-flight call or when the call fails.
   */
  run: <T = TResult>(
    actionId: string,
    input?: unknown,
    options?: RunPluginActionOptions<T>,
  ) => Promise<T | undefined>
  /** Clear any recorded error message. */
  clearError: () => void
}

function defaultFormatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function usePluginAction<TResult = unknown>(
  hookOptions?: UsePluginActionOptions<TResult>,
): UsePluginActionResult<TResult> {
  const ctx = usePluginContext()
  const [pendingKey, setPendingKey] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const inFlightRef = useRef(false)
  const mountedRef = useRef(true)
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const optionsRef = useRef(hookOptions)
  optionsRef.current = hookOptions

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const clearError = useCallback(() => {
    setError(undefined)
  }, [])

  const run = useCallback(
    async <T = TResult>(
      actionId: string,
      input?: unknown,
      callOptions?: RunPluginActionOptions<T>,
    ): Promise<T | undefined> => {
      if (inFlightRef.current) return undefined
      inFlightRef.current = true
      const key = callOptions?.key ?? actionId
      if (mountedRef.current) {
        setPendingKey(key)
        setError(undefined)
      }
      try {
        const callOpts =
          callOptions?.pluginId !== undefined || callOptions?.conversationId !== undefined
            ? {
                ...(callOptions.pluginId !== undefined ? { pluginId: callOptions.pluginId } : {}),
                ...(callOptions.conversationId !== undefined ? { conversationId: callOptions.conversationId } : {}),
              }
            : undefined
        const result = (await ctxRef.current.callAction(
          actionId,
          input,
          callOpts,
        )) as T
        if (mountedRef.current) {
          callOptions?.onSuccess?.(result)
          optionsRef.current?.onSuccess?.(result as unknown as TResult, actionId)
        }
        return result
      } catch (err) {
        const formatter = optionsRef.current?.formatError ?? defaultFormatError
        const message = formatter(err, actionId)
        if (mountedRef.current) {
          setError(message)
          if (optionsRef.current?.notifyError === true) {
            ctxRef.current.notify(message, 'error')
          }
          callOptions?.onError?.(message, err)
          optionsRef.current?.onError?.(message, err, actionId)
        }
        return undefined
      } finally {
        inFlightRef.current = false
        if (mountedRef.current) {
          setPendingKey(undefined)
        }
      }
    },
    [],
  )

  return {
    pending: pendingKey !== undefined,
    pendingKey,
    error,
    run,
    clearError,
  }
}
