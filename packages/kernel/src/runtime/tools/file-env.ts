/**
 * Unified execution environment adapters for `write`/`edit`: local (`node:fs`) and remote (`EnvFabric`)
 * paths share one writable interface and `env/file-mutation-queue` canonical lock semantics.
 * Remote guards (`guards.requireRemoteEnv`) reject missing `EnvFabric` or offline nodes explicitly without
 * silently falling back to Hub's local disk.
 */
import type { Context } from '@earendil-works/chord/context'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { targetPathShape, type TargetPlatform } from '@helmx/protocol'
import { envWithFileMutationQueue, localWithFileMutationQueue } from '../../env/file-mutation-queue.js'
import { nodePathForShape, resolveTargetPath } from './target-path.js'
import { requireRemoteEnv, type FileOpAction } from './guards.js'
import type { HelmxToolDeps } from '../tool-deps.js'

/** Canonical probe result shape (aligned with `ExecutionEnv.canonicalPath` `Result`). */
type CanonicalProbeResult =
  | { ok: true; value: string }
  | { ok: false; error: { code: string; message: string } }

/**
 * Unified writable execution environment for `write`/`edit`: node-agnostic single template.
 * Unwraps `Result` inside and throws on failure; outer template catches and returns redacted `*_failed` text.
 */
interface WritableFileEnv {
  /** Canonical probe: resolves existing files (and symlinks) to their canonical paths (so symlink writes align with
   *  their target in mutex queues); falls back to lexical absolute path when missing. */
  canonicalProbe(path: string, context: Context): Promise<CanonicalProbeResult>
  /** Read full UTF-8 text. */
  readTextFile(path: string, context: Context): Promise<string>
  /** Write full UTF-8 text. */
  writeFile(path: string, content: string, context: Context): Promise<void>
  /** Recursively ensure parent directory exists. */
  ensureDir(path: string, context: Context): Promise<void>
  /** Read-modify-write mutex window (shared local/remote canonical namespace; see `env/file-mutation-queue.ts`). */
  withMutationQueue<T>(path: string, fn: () => Promise<T>, context: Context): Promise<T>
}

/** Local write/edit implementation: in-process `node:fs`; errors propagate as-is. */
function localWritableEnv(): WritableFileEnv {
  return {
    // Use realpath directly for canonicalPath; treat resolution failures (missing/dangling symlink/EACCES)
    // as missing so real IO errors surface on subsequent mkdir/writeFile.
    canonicalProbe: async (path, _context): Promise<CanonicalProbeResult> => {
      try {
        return { ok: true, value: await realpath(path) }
      } catch (error) {
        return {
          ok: false,
          error: {
            code: (error as { code?: string }).code ?? 'not_found',
            message: String(error),
          },
        }
      }
    },
    readTextFile: (path, _context) => readFile(path, 'utf8'),
    writeFile: async (path, content, _context) => {
      await writeFile(path, content, 'utf8')
    },
    ensureDir: async (path, _context) => {
      await mkdir(path, { recursive: true })
    },
    withMutationQueue: (path, fn, context) => localWithFileMutationQueue(path, fn, context.abortSignal),
  }
}

/** Remote write/edit implementation: `EnvFabric` RPC; unwraps `Result` and throws on failure. */
function remoteWritableEnv(env: ExecutionEnv): WritableFileEnv {
  return {
    canonicalProbe: (path, context) => env.canonicalPath(path, context),
    readTextFile: async (path, context) => {
      const result = await env.readTextFile(path, context)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    writeFile: async (path, content, context) => {
      const result = await env.writeFile(path, content, context)
      if (!result.ok) throw new Error(result.error.message)
    },
    ensureDir: async (path, context) => {
      const result = await env.createDir(path, { recursive: true }, context)
      if (!result.ok) throw new Error(result.error.message)
    },
    withMutationQueue: (path, fn, context) => envWithFileMutationQueue(env, path, fn, context),
  }
}

/** Construct `write`/`edit` execution environment: guards remote nodes first (explicit error text), local uses `node:fs`. */
export function writableEnvFor(
  deps: HelmxToolDeps,
  nodeId: string,
  base: string,
  action: Extract<FileOpAction, 'write' | 'edit'>,
): { error: string } | { env: WritableFileEnv } {
  if (nodeId !== 'local') {
    const remote = requireRemoteEnv(deps.envFabric, nodeId, base, action)
    if ('error' in remote) return { error: remote.error }
    return { env: remoteWritableEnv(remote.env) }
  }
  return { env: localWritableEnv() }
}

/**
 * Resolve writable target path: `cwd` (`base`) acts only as base for relative paths; absolute paths and `../`
 * traversals are permitted (same boundary as `bash`, enforced by OS permissions). Lexical resolution follows
 * target path shape (`posix`/`win32`, never Hub host default), rejecting Windows drive-relative paths (`C:rel`).
 * Existing targets resolve via `canonicalPath`/`realpath` so symlink writes target the real file and align with
 * `env/file-mutation-queue` canonical keys; missing targets (including dangling symlinks — `writeFile` creates the
 * symlink target, matching bash redirection) fall back to lexical absolute path; real permission errors surface
 * on subsequent `mkdir`/`writeFile`.
 */
export async function resolveWritableTarget(
  probe: (path: string, context: Context) => Promise<CanonicalProbeResult>,
  raw: string,
  base: string,
  platform: TargetPlatform | undefined,
  context: Context,
): Promise<{ ok: true; abs: string } | { ok: false; message: string }> {
  const resolvedR = resolveTargetPath(raw, base, platform)
  if (!resolvedR.ok) return { ok: false, message: `invalid_path: ${resolvedR.reason}` }
  const absolute = resolvedR.abs
  const targetRealR = await probe(absolute, context)
  if (targetRealR.ok) return { ok: true, abs: targetRealR.value }
  return { ok: true, abs: absolute }
}

/** `dirname` using the path shape's rules (`win32` backslash separators). */
export function dirnameForShape(abs: string): string {
  return nodePathForShape(targetPathShape(abs)).dirname(abs)
}

/** `basename` using the path shape's rules. */
export function basenameForShape(abs: string): string {
  return nodePathForShape(targetPathShape(abs)).basename(abs)
}
