/**
 * Shared signal-bound stream lifecycle helpers for CLI streaming commands
 * (SSE event/doc watchers and NDJSON streams).
 */
import process from 'node:process'
import { CliError } from './errors.js'
import type { HubClient } from './hub-client.js'
import type { Io } from './options.js'

export interface StreamRunContext {
  /** Signal aborted on SIGINT, SIGTERM, optional timeout, or explicit `abort()`. */
  signal: AbortSignal
  /** Abort the stream programmatically (e.g. once a watch condition settles). */
  abort(): void
  /** True when the stream was aborted by SIGINT/SIGTERM. */
  readonly cancelled: boolean
  /** True when the stream was aborted by the optional `timeoutMs` timer. */
  readonly timedOut: boolean
}

export interface StreamRunResult {
  /** True when aborted by SIGINT/SIGTERM. */
  cancelled: boolean
  /** True when aborted by `timeoutMs`. */
  timedOut: boolean
  /** True when aborted by any reason (signal, timeout, or programmatic `abort()`). */
  aborted: boolean
}

/**
 * Run a streaming operation with unified SIGINT/SIGTERM + optional timeout AbortController management.
 * Guarantees listener/timer cleanup in `finally`.
 * When `swallowAbort` is true (default), `CliError(code='aborted')` resolves with the abort outcome
 * rather than throwing (unless `swallowOnlyOnSignal` is set and the abort did not come from a signal).
 */
export async function runWithSignalAbort(
  run: (stream: StreamRunContext) => Promise<void>,
  options: {
    timeoutMs?: number
    /** If true (default), swallow CliError('aborted') and return the outcome. */
    swallowAbort?: boolean
    /** If true, swallow CliError('aborted') only when triggered by SIGINT/SIGTERM (not mid-stream drops). */
    swallowOnlyOnSignal?: boolean
  } = {},
): Promise<StreamRunResult> {
  const controller = new AbortController()
  let cancelled = false
  let timedOut = false
  const onSignal = (): void => {
    if (cancelled) return
    cancelled = true
    controller.abort()
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  const timer =
    options.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, options.timeoutMs)
      : undefined
  timer?.unref?.()

  const streamCtx: StreamRunContext = {
    signal: controller.signal,
    abort: () => controller.abort(),
    get cancelled() {
      return cancelled
    },
    get timedOut() {
      return timedOut
    },
  }

  let aborted = false
  try {
    await run(streamCtx)
  } catch (err) {
    const isAbortErr = err instanceof CliError && err.code === 'aborted'
    const shouldSwallow =
      options.swallowOnlyOnSignal === true
        ? cancelled && isAbortErr
        : options.swallowAbort !== false && (isAbortErr || controller.signal.aborted)
    if (shouldSwallow) {
      aborted = true
    } else {
      throw err
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  return { cancelled, timedOut, aborted: aborted || controller.signal.aborted }
}

/**
 * Subscribe to a JSON-framed SSE endpoint with unified SIGINT/SIGTERM (+ optional timeout) handling
 * and malformed-frame tolerance (logs a diagnostic to stderr and skips non-JSON frames).
 */
export async function watchJsonSse(
  hub: HubClient,
  io: Io,
  path: string,
  onJsonFrame: (event: string, payload: unknown, stream: StreamRunContext) => void,
  options: { timeoutMs?: number } = {},
): Promise<StreamRunResult> {
  return runWithSignalAbort(
    (stream) =>
      hub.streamSse(path, {
        signal: stream.signal,
        onFrame: ({ event, data }) => {
          let payload: unknown
          try {
            payload = JSON.parse(data)
          } catch {
            io.err(`helmx: ignoring non-JSON SSE frame (${data.slice(0, 120)})\n`)
            return
          }
          onJsonFrame(event, payload, stream)
        },
      }),
    options,
  )
}
