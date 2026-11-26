/**
 * Hub HTTP client: the CLI's sole network boundary.
 * Success: entity/array directly; failure: {error:{code,message,details?}} (ApiErrorBody).
 * Credential priority: HELMX_TOKEN / HELMX_HUB_URL env > cli-token file > default 3202.
 */
import type { ApiErrorBody, ArtifactMetadata } from '@helmx/protocol'
import { CliError } from './errors.js'
import type { Io } from './options.js'

export const DEFAULT_HUB_URL = 'http://127.0.0.1:3202'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_STREAM_FRAME_BYTES = 4 * 1024 * 1024

function exceedsStreamFrameLimit(text: string): boolean {
  return (
    text.length > MAX_STREAM_FRAME_BYTES ||
    (text.length > (MAX_STREAM_FRAME_BYTES >> 2) && Buffer.byteLength(text, 'utf8') > MAX_STREAM_FRAME_BYTES)
  )
}

const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '')

/** Error with AbortError semantics thrown by the stream abort race (classified as code 'aborted' by callers). */
function streamAbortError(): Error {
  const err = new Error('stream cancelled')
  err.name = 'AbortError'
  return err
}

export interface HubEndpoint {
  baseUrl: string
  token?: string
}

/**
 * Resolve Hub URL and auth token.
 * Token trust boundary: explicit HELMX_TOKEN takes precedence (caller guarantees it belongs to target Hub);
 * otherwise attach the stored token only when target baseUrl exactly matches the hubUrl recorded in
 * the credential file — never send an old Hub's token when HELMX_HUB_URL points elsewhere.
 */
export function resolveEndpoint(env: NodeJS.ProcessEnv, credential: { hubUrl?: string; token?: string }): HubEndpoint {
  const envUrl = normalizeUrl(env['HELMX_HUB_URL'] ?? '')
  const credUrl = normalizeUrl(credential.hubUrl ?? '')
  const baseUrl = envUrl || credUrl || DEFAULT_HUB_URL
  if (env['HELMX_TOKEN']) return { baseUrl, token: env['HELMX_TOKEN'] }
  // Attach the stored token only when the credential file records a non-empty hubUrl matching baseUrl;
  // missing/blank hubUrl cannot prove origin, so never forward the token to an arbitrary HELMX_HUB_URL.
  const sameHub = credUrl !== '' && credUrl === baseUrl
  return { baseUrl, token: sameHub ? credential.token : undefined }
}

export class HubClient {
  constructor(
    private readonly endpoint: HubEndpoint,
    private readonly io: Io,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  get baseUrl(): string {
    return this.endpoint.baseUrl
  }

  /**
   * Build headers for authenticated requests; fail explicitly with a hint when token is missing instead of sending unauthenticated requests.
   * auth:'optional' exception: attach token if present, still allow unauthenticated requests (e.g. /api/auth/status).
   */
  private authHeaders(extra: Record<string, string> = {}, optional = false): Record<string, string> {
    if (!this.endpoint.token) {
      if (optional) return extra
      throw new CliError(
        `No token configured (${this.endpoint.baseUrl}). Run helmx login or set HELMX_TOKEN.`,
        'unauthorized',
      )
    }
    return { authorization: `Bearer ${this.endpoint.token}`, ...extra }
  }

  private signal(external?: AbortSignal): AbortSignal | undefined {
    return this.signalFor(undefined, external)
  }

  private async toCliError(response: Response, where: string, preloadedText?: string): Promise<CliError> {
    const text = preloadedText ?? (await response.text().catch(() => ''))
    let message = text || `${where} returned HTTP ${response.status}`
    let code = `http_${response.status}`
    let details: unknown
    try {
      const parsed = JSON.parse(text) as Partial<ApiErrorBody>
      if (parsed && typeof parsed === 'object' && parsed.error) {
        const { error } = parsed
        if (typeof error.code === 'string') code = error.code
        if (typeof error.message === 'string') message = error.message
        if ('details' in error) details = error.details
      }
    } catch {
      /* non-JSON error body: preserve raw text */
    }
    if (response.status === 401) {
      return new CliError(`${message} (unauthorized: ${this.endpoint.baseUrl}). Run helmx login or set HELMX_TOKEN.`, code, 1, details)
    }
    return new CliError(message, code, 1, details)
  }

  private async parseEntity<T>(response: Response, where: string): Promise<T> {
    let text: string
    try {
      text = await response.text()
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new CliError(`request timed out reading response body (${this.timeoutMs}ms): ${where}`, 'timeout')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`response body aborted: ${where}`, 'aborted')
      }
      throw new CliError(
        `failed to read Hub response body (${where}): ${err instanceof Error ? err.message : String(err)}`,
        'invalid_response',
      )
    }
    if (!response.ok) throw await this.toCliError(response, where, text)
    if (text === '') return undefined as T // empty body success such as 204 No Content
    try {
      return JSON.parse(text) as T
    } catch {
      throw new CliError(`Hub returned non-JSON response (${where}): ${text.slice(0, 200)}`, 'invalid_response')
    }
  }

  /**
   * Per-request timeout control: defaults to instance timeout; explicit timeoutMs overrides,
   * and 0 disables request timeout (--wait long-polling), preserving only caller signal cancellation.
   */
  private signalFor(timeoutMs: number | undefined, external?: AbortSignal): AbortSignal | undefined {
    const ms = timeoutMs !== undefined ? timeoutMs : this.timeoutMs
    if (ms <= 0) return external
    const timeout = AbortSignal.timeout(ms)
    return external ? AbortSignal.any([timeout, external]) : timeout
  }

  /** Establish a streaming response guarded by connection-phase timeout only (once headers arrive, caller signal governs). */
  private async openConnectStream(
    where: string,
    path: string,
    init: Omit<RequestInit, 'signal'>,
    callerSignal?: AbortSignal,
  ): Promise<Response> {
    const connectController = new AbortController()
    const connectTimer = setTimeout(() => connectController.abort(), this.timeoutMs)
    connectTimer.unref?.()
    try {
      return await this.fetchHub(
        where,
        path,
        {
          ...init,
          signal: callerSignal
            ? AbortSignal.any([connectController.signal, callerSignal])
            : connectController.signal,
        },
        { callerSignal, connectTimeoutLabel: 'connection timed out' },
      )
    } finally {
      clearTimeout(connectTimer)
    }
  }

  /**
   * Perform a single Hub fetch with unified timeout / abort / unreachable error classification.
   */
  private async fetchHub(
    where: string,
    path: string,
    init: RequestInit,
    opts: { timeoutMs?: number; callerSignal?: AbortSignal; connectTimeoutLabel?: string } = {},
  ): Promise<Response> {
    try {
      return await this.io.fetchImpl(`${this.endpoint.baseUrl}${path}`, {
        ...init,
        redirect: 'error',
      })
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        if (opts.connectTimeoutLabel !== undefined) {
          if (opts.callerSignal?.aborted === true) throw new CliError('cancelled', 'aborted')
          throw new CliError(`${opts.connectTimeoutLabel} (${opts.timeoutMs ?? this.timeoutMs}ms): ${where}`, 'timeout')
        }
        if (err.name === 'TimeoutError') {
          const ms = opts.timeoutMs !== undefined ? opts.timeoutMs : this.timeoutMs
          throw new CliError(`request timed out (${ms}ms): ${where}`, 'timeout')
        }
        throw new CliError(`request cancelled: ${where}`, 'aborted')
      }
      throw new CliError(
        `cannot connect to Hub (${this.endpoint.baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
  }

  /**
   * JSON request; omits request body when body is undefined. timeoutMs=0 disables the default timeout
   * (for --wait long waits); any other value overrides the instance default.
   * auth: true (default) requires token; false forces anonymous; 'optional' attaches token if present
   * and proceeds without one otherwise (used to probe public endpoints like status).
   */
  async request<T>(method: string, path: string, opts: { body?: unknown; auth?: boolean | 'optional'; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = {}
    if (opts.auth === 'optional') Object.assign(headers, this.authHeaders({}, true))
    else if (opts.auth !== false) Object.assign(headers, this.authHeaders())
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const response = await this.fetchHub(
      `${method} ${path}`,
      path,
      {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: this.signalFor(opts.timeoutMs, opts.signal),
      },
      { timeoutMs: opts.timeoutMs },
    )
    return this.parseEntity<T>(response, `${method} ${path}`)
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, { signal })
  }

  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('POST', path, { body: body ?? {}, signal })
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body: body ?? {} })
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body: body ?? {} })
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path)
  }

  /** Binary content download: returns the raw Response (already verified 2xx). */
  async raw(path: string, signal?: AbortSignal): Promise<Response> {
    const response = await this.fetchHub(`GET ${path}`, path, {
      headers: this.authHeaders(),
      signal: this.signal(signal),
    })
    if (!response.ok) throw await this.toCliError(response, `GET ${path}`)
    return response
  }

  /**
   * Binary artifact upload (POST /api/conversations/:id/artifacts):
   * application/octet-stream body + URL-encoded x-artifact-filename + optional MIME type.
   */
  async uploadArtifact(
    conversationId: number,
    fileName: string,
    bytes: Uint8Array,
    mimeType?: string,
  ): Promise<ArtifactMetadata> {
    const path = `/api/conversations/${conversationId}/artifacts`
    const headers = this.authHeaders({
      'content-type': 'application/octet-stream',
      'x-artifact-filename': encodeURIComponent(fileName),
      ...(mimeType !== undefined ? { 'x-artifact-mime-type': mimeType } : {}),
    })
    const response = await this.fetchHub(`POST ${path}`, path, {
      method: 'POST',
      headers,
      body: Uint8Array.from(bytes),
      signal: this.signal(undefined),
    })
    return this.parseEntity<ArtifactMetadata>(response, `POST ${path}`)
  }

  /**
   * Race one chunk read against the caller's abort signal. Why: on long-lived undici SSE
   * connections a pending read() does not reliably reject when the fetch AbortSignal fires,
   * so consumer-loop exit must never depend on that side effect alone. The losing read()
   * promise keeps a no-op catch so its eventual rejection can never surface as
   * unhandledRejection after the race has already settled.
   */
  private readChunkWithAbort(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    if (signal?.aborted) throw streamAbortError()
    if (!signal) return reader.read()
    const read = reader.read()
    read.catch(() => {})
    const abort = new Promise<never>((_, reject) => {
      const onAbort = (): void => reject(streamAbortError())
      const stopTracking = (): void => signal.removeEventListener('abort', onAbort)
      signal.addEventListener('abort', onAbort, { once: true })
      // read settled first: drop the listener so per-chunk abort handlers never accumulate.
      read.then(stopTracking, stopTracking)
    })
    return Promise.race([read, abort])
  }

  /**
   * Bounded reader teardown: reader.cancel() itself can hang on a wedged stream, so race it
   * against a short unref'd timer and always release the lock — cleanup must never trade one
   * unbounded wait for another.
   */
  private async cancelReaderBounded(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 500): Promise<void> {
    const bounded = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })
    try {
      await Promise.race([reader.cancel().catch(() => {}), bounded])
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * NDJSON streaming POST: consumes response.body chunk by chunk (never buffers the full response),
   * parsing each complete line as JSON and passing it to onLine; the trailing line may omit a newline.
   * Parse and consumer errors propagate directly; cancellation closes the reader so the Hub stops the command.
   * Connection/HTTP errors use the unified error envelope; AbortSignal cancels chunk-by-chunk immediately.
   */
  async streamNdjson(
    method: string,
    path: string,
    opts: { body?: unknown; onLine: (value: unknown) => void; signal?: AbortSignal } = { onLine: () => {} },
  ): Promise<void> {
    const headers = this.authHeaders({ accept: 'application/x-ndjson' })
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const response = await this.openConnectStream(
      `${method} ${path}`,
      path,
      {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      },
      opts.signal,
    )
    if (opts.signal?.aborted) throw new CliError(`stream cancelled: ${method} ${path}`, 'aborted')
    if (!response.ok) throw await this.toCliError(response, `${method} ${path}`)
    if (!response.body) {
      throw new CliError(`Hub did not return a streaming response body (${method} ${path})`, 'invalid_response')
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (contentType !== 'application/x-ndjson') {
      await response.body.cancel()
      throw new CliError(`Hub response content-type is not application/x-ndjson (${method} ${path})`, 'invalid_response')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = ''
    const consume = (line: string): void => {
      if (line.trim() === '') return
      if (exceedsStreamFrameLimit(line)) {
        throw new CliError('Hub NDJSON frame exceeded maximum size limit', 'invalid_response')
      }
      let value: unknown
      try { value = JSON.parse(line) } catch {
        throw new CliError(`Hub NDJSON stream contained a non-JSON line (${method} ${path})`, 'invalid_response')
      }
      opts.onLine(value)
    }
    try {
      for (;;) {
        opts.signal?.throwIfAborted()
        const { done, value } = await this.readChunkWithAbort(reader, opts.signal)
        if (done) break
        const decoded = decoder.decode(value, { stream: true })
        if (decoded.length === 0) continue
        buffer += decoded
        let cursor = 0
        let newline = buffer.indexOf('\n', cursor)
        while (newline !== -1) {
          const line =
            newline > cursor && buffer.charCodeAt(newline - 1) === 13
              ? buffer.slice(cursor, newline - 1)
              : buffer.slice(cursor, newline)
          cursor = newline + 1
          consume(line)
          newline = buffer.indexOf('\n', cursor)
        }
        if (cursor > 0) {
          buffer = cursor < buffer.length ? buffer.slice(cursor) : ''
        }
        if (exceedsStreamFrameLimit(buffer)) {
          throw new CliError('Hub NDJSON frame exceeded maximum size limit', 'invalid_response')
        }
      }
      opts.signal?.throwIfAborted()
      buffer += decoder.decode()
      if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1)
      consume(buffer)
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new CliError(`stream cancelled: ${method} ${path}`, 'aborted')
      }
      throw err
    } finally {
      await this.cancelReaderBounded(reader)
    }
  }

  /**
   * Subscribe to any GET SSE endpoint (shares framing parser with /api/events): handles both \n\n and \r\n\r\n,
   * forwarding event name and data payload to onFrame. Connection/HTTP errors use the unified envelope
   * (404 etc. throw structured CliError so callers can decide whether to stop retrying).
   * The timeout applies only to establishing the connection; once open, consumption exits on caller
   * abort via an explicit race (a pending read() on an aborted long-lived undici stream may never
   * reject), never on read() rejection alone. onFrame commonly aborts synchronously (watch settle):
   * the parse loop checks right after each frame and stops before issuing another read().
   */
  async streamSse(
    path: string,
    listeners: {
      onFrame: (frame: { event: string; data: string }) => void
      signal?: AbortSignal
    },
  ): Promise<void> {
    const callerAborted = (): boolean => listeners.signal?.aborted === true
    const response = await this.openConnectStream(
      `GET ${path}`,
      path,
      { headers: this.authHeaders({ accept: 'text/event-stream' }) },
      listeners.signal,
    )
    if (callerAborted()) throw new CliError('cancelled', 'aborted')
    if (!response.ok) throw await this.toCliError(response, `GET ${path}`)
    if (!response.body) {
      throw new CliError(`Hub did not return a streaming response body (GET ${path})`, 'invalid_response')
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'text/event-stream') {
      await response.body.cancel().catch(() => {})
      throw new CliError(`Hub response content-type is not text/event-stream (GET ${path})`, 'invalid_response')
    }
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffer = ''
    let pendingCr = false
    const processBufferFrames = (): void => {
      let cursor = 0
      let boundary = buffer.indexOf('\n\n', cursor)
      while (boundary !== -1) {
        const block = buffer.slice(cursor, boundary)
        cursor = boundary + 2
        if (exceedsStreamFrameLimit(block)) {
          throw new CliError('Hub SSE frame exceeded maximum size limit', 'invalid_response')
        }
        let event = 'message'
        const dataLines: string[] = []
        let lineStart = 0
        while (lineStart <= block.length) {
          const nl = block.indexOf('\n', lineStart)
          const line = nl === -1 ? block.slice(lineStart) : block.slice(lineStart, nl)
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          if (nl === -1) break
          lineStart = nl + 1
        }
        if (dataLines.length > 0) {
          listeners.onFrame({ event, data: dataLines.join('\n') })
          if (callerAborted()) throw new CliError('cancelled', 'aborted')
        }
        boundary = buffer.indexOf('\n\n', cursor)
      }
      if (cursor > 0) {
        buffer = cursor < buffer.length ? buffer.slice(cursor) : ''
      }
      if (exceedsStreamFrameLimit(buffer)) {
        throw new CliError('Hub SSE frame exceeded maximum size limit', 'invalid_response')
      }
    }
    try {
      for (;;) {
        const { done, value } = await this.readChunkWithAbort(reader, listeners.signal)
        if (done) {
          let tail = decoder.decode()
          if (pendingCr) {
            tail = `\r${tail}`
            pendingCr = false
          }
          if (tail.length > 0) {
            if (tail.includes('\r')) tail = tail.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
            buffer += tail
            processBufferFrames()
          }
          break
        }
        let chunkText = decoder.decode(value, { stream: true })
        if (chunkText.length === 0) continue
        if (pendingCr) {
          chunkText = `\r${chunkText}`
          pendingCr = false
        }
        if (chunkText.charCodeAt(chunkText.length - 1) === 13) {
          pendingCr = true
          chunkText = chunkText.slice(0, -1)
        }
        if (chunkText.length === 0) continue
        if (chunkText.includes('\r')) {
          chunkText = chunkText.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
        }
        buffer += chunkText
        processBufferFrames()
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (callerAborted()) throw new CliError('cancelled', 'aborted')
        throw new CliError(`stream interrupted: GET ${path}`, 'aborted')
      }
      if (err instanceof TypeError) {
        throw new CliError(`Hub SSE stream contained invalid UTF-8 bytes (GET ${path})`, 'invalid_response')
      }
      throw err
    } finally {
      await this.cancelReaderBounded(reader)
    }
  }
}
