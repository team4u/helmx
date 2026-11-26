/**
 * Bounded ReadableStream helpers shared by HTTP gzip compression, plugin JSON redaction, and upload limits.
 */

export interface BoundedReadResult {
  readonly chunks: Uint8Array[]
  readonly totalBytes: number
  readonly exceeded: boolean
}

/** Concatenate byte chunks into a single `Uint8Array<ArrayBuffer>` sized exactly to `totalBytes`. */
export function concatUint8Arrays(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(totalBytes))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Read chunks from `reader` until EOF or `totalBytes > maxBytes`.
 * When `cancelOnExceed` is true, cancels `reader` before returning `exceeded: true`;
 * otherwise leaves `reader` locked at the break point so `stitchRemainingStream` can stream the tail.
 */
export async function readBoundedChunks(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  options?: { readonly cancelOnExceed?: boolean },
): Promise<BoundedReadResult> {
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  let exceeded = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined || value.byteLength === 0) continue
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        exceeded = true
        if (options?.cancelOnExceed) {
          await reader.cancel().catch(() => {})
        } else {
          chunks.push(value)
        }
        break
      }
      chunks.push(value)
    }
  } catch (err) {
    await reader.cancel(err).catch(() => {})
    throw err
  }
  return { chunks, totalBytes, exceeded }
}

/**
 * Reassemble already-buffered `chunks` followed by the remainder of `reader` into a single `ReadableStream`.
 * Drops references to yielded buffered chunks immediately so memory stays bounded while streaming.
 */
export function stitchRemainingStream(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        const next = chunks[index]!
        chunks[index] = new Uint8Array(0)
        index += 1
        controller.enqueue(next)
        return
      }
      try {
        for (;;) {
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
}
