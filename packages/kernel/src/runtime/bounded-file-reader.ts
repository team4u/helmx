/**
 * Shared TOCTOU-safe bounded UTF-8 file reader for kernel turn context and scoped skill reads.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { targetPathShape } from '@helmx/protocol'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'

const DEFAULT_UTF8_DECODER = new TextDecoder('utf-8')
const BINARY_PROBE_BYTES = 8192

export type BoundedReadFailure =
  | { stage: 'canonical'; code: string; message: string }
  | { stage: 'outside_dir' }
  | { stage: 'open'; code: string; message: string }
  | { stage: 'info'; code: string; message: string }
  | { stage: 'not_regular_file'; fileKind: string }
  | { stage: 'size_exceeded'; size: number; maxBytes: number }
  | { stage: 'binary_file'; size: number }
  | { stage: 'read'; code: string; message: string }
  | { stage: 'read_exceeded'; bytesRead: number; maxBytes: number }
  | { stage: 'after_info'; code: string; message: string }
  | { stage: 'file_changed'; beforeSize: number; afterSize: number; beforeMtime: number; afterMtime: number }
  | { stage: 'size_mismatch'; bytesRead: number; stableSize: number }

export type BoundedFileReadResult =
  | { kind: 'absent' }
  | { kind: 'refused'; failure: BoundedReadFailure }
  | { kind: 'content'; text: string }

/** Directories and missing paths (including EISDIR) count as normal absence; other errors refuse explicitly. */
export function isAbsentFileError(error: { code: string; message: string }): boolean {
  return error.code === 'not_found' || error.code === 'is_directory' || error.message.includes('EISDIR')
}

/** Verify `target` stays lexically within `root` (blocks intermediate symlinks escaping a directory tree). */
export function isPathWithin(target: string, root: string): boolean {
  const shape = targetPathShape(root)
  const normTarget = shape === 'win32' ? target.toLowerCase() : target
  const normRoot = shape === 'win32' ? root.toLowerCase() : root
  const sep = shape === 'win32' ? '\\' : '/'
  const prefix = normRoot.endsWith(sep) ? normRoot : normRoot + sep
  return normTarget === normRoot || normTarget.startsWith(prefix)
}

function hasNullBytePrefix(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, BINARY_PROBE_BYTES)
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) return true
  }
  return false
}

/**
 * Bounded TOCTOU-safe UTF-8 read via ExecutionEnv:
 * canonicalPath -> optional containment check -> openBinaryReader({ noFollow: true }) ->
 * pre-read handle.info -> bounded handle.read(0, maxBytes + 1) -> post-read handle.info consistency.
 */
export async function readFileBounded(
  env: ExecutionEnv,
  path: string,
  options: { maxBytes: number; withinDir?: string; decoder?: TextDecoder; rejectBinary?: boolean },
): Promise<BoundedFileReadResult> {
  const canonical = await env.canonicalPath(path, BACKGROUND_CONTEXT)
  if (!canonical.ok) {
    if (isAbsentFileError(canonical.error)) return { kind: 'absent' }
    return { kind: 'refused', failure: { stage: 'canonical', code: canonical.error.code, message: canonical.error.message } }
  }
  const realPath = canonical.value
  if (options.withinDir !== undefined && !isPathWithin(realPath, options.withinDir)) {
    return { kind: 'refused', failure: { stage: 'outside_dir' } }
  }

  const openedR = await env.openBinaryReader(realPath, { noFollow: true }, BACKGROUND_CONTEXT)
  if (!openedR.ok) {
    if (isAbsentFileError(openedR.error)) return { kind: 'absent' }
    return { kind: 'refused', failure: { stage: 'open', code: openedR.error.code, message: openedR.error.message } }
  }
  const reader = openedR.value
  try {
    const infoR = await reader.info(BACKGROUND_CONTEXT)
    if (!infoR.ok) {
      return { kind: 'refused', failure: { stage: 'info', code: infoR.error.code, message: infoR.error.message } }
    }
    const info = infoR.value
    if (info.kind !== 'file') {
      return { kind: 'refused', failure: { stage: 'not_regular_file', fileKind: info.kind } }
    }
    if (info.size > options.maxBytes) {
      return { kind: 'refused', failure: { stage: 'size_exceeded', size: info.size, maxBytes: options.maxBytes } }
    }

    const readR = await reader.read(0, options.maxBytes + 1, BACKGROUND_CONTEXT)
    if (!readR.ok) {
      return { kind: 'refused', failure: { stage: 'read', code: readR.error.code, message: readR.error.message } }
    }
    const bytes = readR.value
    if (bytes.byteLength > options.maxBytes) {
      return { kind: 'refused', failure: { stage: 'read_exceeded', bytesRead: bytes.byteLength, maxBytes: options.maxBytes } }
    }

    const afterR = await reader.info(BACKGROUND_CONTEXT)
    if (!afterR.ok) {
      return { kind: 'refused', failure: { stage: 'after_info', code: afterR.error.code, message: afterR.error.message } }
    }
    const after = afterR.value
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      return {
        kind: 'refused',
        failure: {
          stage: 'file_changed',
          beforeSize: info.size,
          afterSize: after.size,
          beforeMtime: info.mtimeMs,
          afterMtime: after.mtimeMs,
        },
      }
    }
    if (bytes.byteLength !== after.size) {
      return { kind: 'refused', failure: { stage: 'size_mismatch', bytesRead: bytes.byteLength, stableSize: after.size } }
    }
    if (options.rejectBinary === true && hasNullBytePrefix(bytes)) {
      return { kind: 'refused', failure: { stage: 'binary_file', size: bytes.byteLength } }
    }
    const decoder = options.decoder ?? DEFAULT_UTF8_DECODER
    return { kind: 'content', text: decoder.decode(bytes) }
  } finally {
    await reader.close(BACKGROUND_CONTEXT)
  }
}
