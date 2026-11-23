/**
 * Outbound response gzip compression (unified exit in the Hub handler layer).
 *
 * Policy:
 * - Only compress application/json responses (SSE text/event-stream, NDJSON streams, binary artifacts,
 *   and static assets are excluded here; static assets are compressed on demand by static.ts);
 * - Compress only when the client Accept-Encoding includes gzip (q>0); HEAD requests, bodyless responses,
 *   and responses that already carry content-encoding are returned verbatim;
 * - Skip compression at or below GZIP_MIN_BYTES or when compressed output is not smaller than raw bytes;
 * - Rebuild the Response after compression: replace content-length with the compressed byte count so the
 *   Node adapter passes it through verbatim; merge Vary with existing values (e.g. Origin from CORS) and Accept-Encoding;
 * - On compression failure, fall back to identity (identical bytes, always accepted by clients; no content fallback).
 */
import { promisify } from 'node:util'
import { gzip as gzipCallback, gzipSync } from 'node:zlib'

const gzipAsync = promisify(gzipCallback)

/** JSON response compression threshold (bytes): below this, compression gains do not outweigh CPU and TLS framing overhead. */
const GZIP_MIN_BYTES = 1024

/** Payloads at or above 32 KiB offload compression to async zlib so large responses do not stall the event loop, while smaller payloads stay synchronous to avoid libuv threadpool contention. */
export const ASYNC_GZIP_THRESHOLD_BYTES = 32 * 1024

export function compressGzip(input: Uint8Array): Buffer | Promise<Buffer> {
  if (input.byteLength < ASYNC_GZIP_THRESHOLD_BYTES) {
    return gzipSync(input)
  }
  return gzipAsync(input)
}

/** Maximum JSON response size buffered for synchronous gzip compression (4 MiB, aligned with plugin-route JSON redaction cap). */
export const GZIP_JSON_MAX_BYTES = 4 * 1024 * 1024

/** Streams already switched to streaming mode (e.g. oversized plugin JSON redaction) bypass gzip buffering immediately. */
const streamingJsonBodies = new WeakSet<ReadableStream<Uint8Array>>()

/** Marks a `ReadableStream` as an intentionally streaming JSON response so `gzipJsonResponse` passes it through untouched. */
export function markStreamingJsonBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  streamingJsonBodies.add(body)
  return body
}

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(totalBytes))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Parse Accept-Encoding to determine whether gzip is accepted (including x-gzip alias; q=0 means rejected). */
export function acceptsGzip(request: Request): boolean {
  const header = request.headers.get('accept-encoding')
  if (header === null) return false
  for (const part of header.split(',')) {
    const [tokenRaw, ...params] = part.trim().split(';')
    const token = tokenRaw?.trim().toLowerCase()
    if (token !== 'gzip' && token !== 'x-gzip') continue
    const q = params.map((p) => p.trim()).find((p) => p.toLowerCase().startsWith('q='))
    if (q !== undefined) {
      const weight = Number(q.slice(2))
      if (!Number.isFinite(weight) || weight === 0) continue
    }
    return true
  }
  return false
}

/** Merge Accept-Encoding into the Vary header (preserving existing values such as Origin without duplicating). */
function mergeVaryAcceptEncoding(headers: Headers): void {
  const existing = headers.get('vary')
  if (existing === null) {
    headers.set('vary', 'Accept-Encoding')
    return
  }
  const tokens = existing
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '')
  if (!tokens.includes('accept-encoding')) {
    headers.set('vary', `${existing}, Accept-Encoding`)
  }
}

/**
 * Conditionally gzip-compress JSON responses (called after withCors in hub.ts so Vary merging sees
 * any Origin header added by CORS).
 *
 * Cache semantics: every compressible application/json response (even when sent uncompressed due to HEAD,
 * client not accepting gzip, below threshold, or no size savings) gets `Vary: Accept-Encoding` merged—the same
 * URL has two representations, and omitting Vary would allow proxies to reuse an identity response across encodings.
 *
 * Body safety: reads `response.body` via a bounded chunk reader capped at `GZIP_JSON_MAX_BYTES`
 * (never `response.clone().arrayBuffer()`, avoiding tee double-buffering and event-loop stalls on
 * oversized/streaming JSON). Payloads exceeding the cap (or already marked streaming) pass through as
 * an identity `ReadableStream` with `Vary: Accept-Encoding` preserved.
 */
export async function gzipJsonResponse(request: Request, response: Response): Promise<Response> {
  if (response.headers.has('content-encoding')) return response
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) return response
  // Always merge Vary (mutates original response headers directly without touching body, matching withCors)
  mergeVaryAcceptEncoding(response.headers)
  if (request.method === 'HEAD') return response
  if (response.body === null) return response
  if (!acceptsGzip(request)) return response
  if (streamingJsonBodies.has(response.body)) return response

  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && /^\d+$/.test(declaredLength.trim())) {
    const parsedLength = Number(declaredLength.trim())
    if (Number.isSafeInteger(parsedLength) && parsedLength > GZIP_JSON_MAX_BYTES) {
      return response
    }
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let exceeded = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      chunks.push(value)
      totalBytes += value.byteLength
      if (totalBytes > GZIP_JSON_MAX_BYTES) {
        exceeded = true
        break
      }
    }
  } catch (err) {
    await reader.cancel(err).catch(() => {})
    throw err
  }

  if (exceeded) {
    let index = 0
    const stitched = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (index < chunks.length) {
          const next = chunks[index]!
          chunks[index] = new Uint8Array(0)
          index += 1
          controller.enqueue(next)
          return
        }
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) {
              reader.releaseLock()
              controller.close()
              return
            }
            if (value !== undefined && value.byteLength > 0) {
              controller.enqueue(value)
              return
            }
          }
        } catch (err) {
          reader.releaseLock()
          controller.error(err)
        }
      },
      async cancel(reason) {
        chunks.length = 0
        await reader.cancel(reason).catch(() => {})
      },
    })
    return new Response(stitched, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  }

  reader.releaseLock()
  const raw = concatChunks(chunks, totalBytes)
  const identityResponse = () =>
    new Response(raw, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    })
  if (raw.byteLength < GZIP_MIN_BYTES) return identityResponse()
  let compressed: Uint8Array
  try {
    compressed = await compressGzip(raw)
  } catch {
    // zlib will not fail for valid buffers; if it ever does, identity encoding is always acceptable to clients
    // (identical bytes, not a content fallback).
    return identityResponse()
  }
  if (compressed.byteLength >= raw.byteLength) return identityResponse()
  const headers = new Headers(response.headers)
  headers.delete('content-length')
  headers.set('content-length', String(compressed.byteLength))
  headers.set('content-encoding', 'gzip')
  mergeVaryAcceptEncoding(headers)
  // Wrap in `new Uint8Array(...)` to normalize BodyInit typing (matches static.ts).
  return new Response(new Uint8Array(compressed), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
