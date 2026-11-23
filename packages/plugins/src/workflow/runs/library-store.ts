/**
 * runs/library-store.ts — File-backed saved workflow library (`<dataDir>/workflows/<name>.js`).
 */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { HelmxError } from '@helmx/protocol'
import type {
  SavedWorkflowDetail,
  SavedWorkflowSummary,
  WorkflowDeleteResult,
  WorkflowSaveRequest,
  WorkflowSaveResult,
} from '../../contracts.js'
import {
  extractMeta,
  hasMetaDeclaration,
  MAX_SCRIPT_LENGTH,
  precheckScriptSyntax,
  type WorkflowMeta,
} from '../dsl/index.js'

export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function fileStatsOf(path: string): { updatedAt: number; size: number } {
  try {
    const stats = statSync(path)
    return { updatedAt: Math.trunc(stats.mtimeMs), size: stats.size }
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    throw new HelmxError('io_error', `cannot read file facts ${path}: ${err.message}`, 500, { path, code: err.code })
  }
}

function summaryFromSource(
  name: string,
  path: string,
  source: string,
  stats: { updatedAt: number; size: number },
): SavedWorkflowSummary {
  try {
    const { meta } = extractMeta(source)
    return {
      name,
      path,
      updatedAt: stats.updatedAt,
      size: stats.size,
      description: meta.description,
      ...(meta.whenToUse !== undefined ? { whenToUse: meta.whenToUse } : {}),
      ...(meta.phases !== undefined ? { phases: meta.phases } : {}),
    }
  } catch (error) {
    return {
      name,
      path,
      updatedAt: stats.updatedAt,
      size: stats.size,
      metadataError: error instanceof Error ? error.message : String(error),
    }
  }
}

export class WorkflowLibrary {
  constructor(private readonly dataDir: string) {}

  workflowsDir(): string {
    return join(this.dataDir, 'workflows')
  }

  list(): SavedWorkflowSummary[] {
    const dir = this.workflowsDir()
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return []
      throw new HelmxError('io_error', `cannot read workflows directory ${dir}: ${err.message}`, 500, { path: dir, code: err.code })
    }
    const out: SavedWorkflowSummary[] = []
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.js')) continue
      const name = entry.slice(0, -3)
      if (!SAFE_NAME.test(name)) continue
      const path = join(dir, entry)
      let source: string
      try {
        source = readFileSync(path, 'utf-8')
      } catch (error) {
        const err = error as NodeJS.ErrnoException
        if (err.code === 'ENOENT') continue
        throw new HelmxError('io_error', `cannot read workflow script ${path}: ${err.message}`, 500, { path, code: err.code })
      }
      if (!hasMetaDeclaration(source)) continue
      out.push(summaryFromSource(name, path, source, fileStatsOf(path)))
    }
    return out
  }

  get(name: string): SavedWorkflowDetail {
    const path = this.resolveSavedName(name)
    const source = this.readScriptFile(path)
    return { ...summaryFromSource(name, path, source, fileStatsOf(path)), script: source }
  }

  save(request: WorkflowSaveRequest): WorkflowSaveResult {
    if (typeof request.script !== 'string' || request.script.trim().length === 0) {
      throw new HelmxError('validation_error', 'save requires a non-empty script string', 400)
    }
    const script = request.script
    let meta: WorkflowMeta
    try {
      meta = precheckScriptSyntax(script).meta
    } catch (error) {
      throw new HelmxError(
        'workflow_script_invalid',
        `workflow script validation failed: ${error instanceof Error ? error.message : String(error)}`,
        400,
      )
    }

    const name = request.name ?? meta.name
    if (!SAFE_NAME.test(name)) {
      throw new HelmxError('validation_error', `workflow name "${name}" is invalid: must match ${SAFE_NAME.source}`, 400, { name })
    }
    if (request.name !== undefined && request.name !== meta.name) {
      throw new HelmxError(
        'validation_error',
        `save name ${request.name} disagrees with the script's meta.name "${meta.name}"; unify the names first`,
        400,
        { name: request.name, metaName: meta.name },
      )
    }

    const dir = this.workflowsDir()
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${name}.js`)
    const existing = this.savedEntryStats(name, target)
    if (existing !== undefined && request.overwrite !== true) {
      throw new HelmxError(
        'workflow_already_exists',
        `a workflow named ${name} already exists (${target}); overwrite: true is required to overwrite`,
        409,
        { name, path: target },
      )
    }

    const tmp = join(dir, `.save-${name}-${randomUUID()}.tmp`)
    try {
      const fd = openSync(tmp, 'wx', 0o644)
      try {
        writeSync(fd, script, null, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      if (existing === undefined) {
        try {
          linkSync(tmp, target)
        } catch (error) {
          const err = error as NodeJS.ErrnoException
          if (err.code === 'EEXIST') {
            throw new HelmxError(
              'workflow_already_exists',
              `a workflow named ${name} already exists (concurrent write); overwrite: true is required`,
              409,
              { name, path: target },
            )
          }
          throw error
        }
        unlinkSync(tmp)
      } else {
        renameSync(tmp, target)
      }
    } catch (error) {
      try {
        unlinkSync(tmp)
      } catch {
        // Already consumed or never created.
      }
      if (error instanceof HelmxError) throw error
      const err = error as NodeJS.ErrnoException
      throw new HelmxError('io_error', `failed to write workflow definition ${target}: ${err.message}`, 500, {
        path: target,
        code: err.code,
      })
    }

    return {
      created: existing === undefined,
      workflow: summaryFromSource(name, target, script, fileStatsOf(target)),
    }
  }

  delete(name: string): WorkflowDeleteResult {
    if (!SAFE_NAME.test(name)) {
      throw new HelmxError('validation_error', `workflow name "${name}" is invalid: must match ${SAFE_NAME.source}`, 400, { name })
    }
    const dir = this.workflowsDir()
    const target = join(dir, `${name}.js`)
    let entry: ReturnType<typeof lstatSync>
    try {
      entry = lstatSync(target)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') throw new HelmxError('not_found', `workflow ${name} does not exist`, 404, { name, path: target })
      throw new HelmxError('io_error', `cannot read workflow entry ${target}: ${err.message}`, 500, { path: target, code: err.code })
    }
    if (entry.isSymbolicLink()) {
      const real = realpathSync(target)
      const expected = join(realpathSync(dir), `${name}.js`)
      if (real !== expected) {
        throw new HelmxError('validation_error', `workflow "${name}" is a symlink pointing outside the directory (${real}); refused`, 400, { name, real })
      }
    } else if (!entry.isFile()) {
      throw new HelmxError('validation_error', `workflow entry ${target} is not a regular file; refused`, 400, { name, path: target })
    }
    try {
      unlinkSync(target)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      throw new HelmxError('io_error', `failed to delete workflow definition ${target}: ${err.message}`, 500, { path: target, code: err.code })
    }
    return { deleted: true, name, path: target }
  }

  private savedEntryStats(name: string, target: string): { updatedAt: number; size: number } | undefined {
    try {
      const resolved = this.resolveSavedName(name)
      const stats = statSync(resolved)
      if (!stats.isFile()) {
        throw new HelmxError('validation_error', `workflow entry ${target} is not a regular file`, 400, { name, path: target })
      }
      return { updatedAt: Math.trunc(stats.mtimeMs), size: stats.size }
    } catch (error) {
      if (error instanceof HelmxError) throw error
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return undefined
      throw new HelmxError('io_error', `cannot stat workflow entry ${target}: ${err.message}`, 500, { path: target, code: err.code })
    }
  }

  resolveSavedName(name: string): string {
    if (!SAFE_NAME.test(name)) {
      throw new HelmxError('validation_error', `workflow name "${name}" is invalid: must match ${SAFE_NAME.source}`, 400, { name })
    }
    const dir = this.workflowsDir()
    const target = join(dir, `${name}.js`)
    try {
      const real = realpathSync(target)
      const realDir = realpathSync(dir)
      if (real !== join(realDir, `${name}.js`)) {
        throw new HelmxError('validation_error', `workflow "${name}" is a symlink pointing outside the directory (${real}); refused`, 400, { name, real })
      }
      return target
    } catch (error) {
      if (error instanceof HelmxError) throw error
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') return target
      throw new HelmxError('io_error', `cannot resolve workflow path ${target}: ${err.message}`, 500, { path: target, code: err.code })
    }
  }

  resolveExplicitPath(scriptPath: string): string {
    return resolve(scriptPath)
  }

  readScriptFile(path: string): string {
    let source: string
    try {
      const st = statSync(path)
      if (!st.isFile()) throw new HelmxError('not_found', `workflow script is not a regular file: ${path}`, 404, { path })
      source = readFileSync(path, 'utf-8')
    } catch (error) {
      if (error instanceof HelmxError) throw error
      const err = error as NodeJS.ErrnoException
      throw new HelmxError('not_found', `workflow script file unreadable (${err.code ?? 'unknown'}): ${path}`, 404, { path, code: err.code })
    }
    if (source.length > MAX_SCRIPT_LENGTH) {
      throw new HelmxError('validation_error', `workflow script is ${source.length} chars, over the cap of ${MAX_SCRIPT_LENGTH}`, 400, { path })
    }
    return source
  }

  peekMeta(script: string): WorkflowMeta | undefined {
    try {
      return extractMeta(script).meta
    } catch {
      return undefined
    }
  }
}
