/**
 * Node-side read-only skill library discovery and live reading:
 * - Scans target node machine-level roots (`~/.helmx/skills`, `~/.agents/skills`) when `nodeId !== 'local'`
 *   plus optional workspace `<cwd>/.helmx/skills`;
 * - Read-only, never copied into Hub dataDir;
 * - Priority contract: Hub data > Hub ~/.agents/skills > node ~/.helmx/skills > node ~/.agents/skills > workspace;
 * - Strips `managedByPlugin` on node skills so nodes cannot impersonate host-managed plugin skills;
 * - Bounded TOCTOU-safe reads + explicit `unavailable` / `409` / `502` diagnostics on failures.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  HelmxError,
  assertSafeSkillRelativePath,
  assertSkillId,
  escapeXml,
  parseSkillFrontmatter,
  pathRulesForShape,
  targetPathShape,
  type SkillSummary,
} from '@helmx/protocol'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { isPathWithin, readFileBounded, type BoundedReadFailure } from './bounded-file-reader.js'

export const NODE_SKILLS_RELATIVE_DIR = '.helmx/skills'
export const DEFAULT_NODE_MACHINE_SKILL_ROOTS = ['~/.helmx/skills', '~/.agents/skills'] as const
export const MAX_NODE_SKILL_FILE_BYTES = 256 * 1024
export const MAX_NODE_SKILLS = 256
export const MAX_NODE_SKILL_REFERENCES = 512
export const MAX_NODE_SKILL_REFERENCE_DEPTH = 8
export const NODE_SKILL_SCAN_CONCURRENCY = 5
export const NODE_SKILLS_CACHE_TTL_MS = 5_000

const NODE_SKILL_UTF8_DECODER = new TextDecoder('utf-8')

export interface NodeSkillsHostPort {
  executionEnv(nodeId: string, cwd: string): ExecutionEnv
  redact(text: string): string
  nodeIpc: { isOnline(nodeId: string): boolean }
}

export interface NodeSkillScanOptions {
  machineRoots?: readonly string[]
  shadowedIds?: ReadonlySet<string>
  cacheTtlMs?: number
  now?: () => number
}

export type NodeSkillScan =
  | { kind: 'ok'; skills: SkillSummary[]; shadowedSkillIds?: string[] }
  | { kind: 'unavailable'; reason: string; skills?: SkillSummary[]; shadowedSkillIds?: string[] }

interface CachedNodeSkillScan {
  expiresAt: number
  skills: SkillSummary[]
  shadowedSkillIds: string[]
}

let nodeSkillsCacheByHost = new WeakMap<NodeSkillsHostPort, Map<string, CachedNodeSkillScan>>()

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorCodeOf(err: unknown): string {
  return err instanceof HelmxError ? err.code : 'unknown'
}

function buildNodeSkillsCacheKey(nodeId: string, cwd: string, options?: NodeSkillScanOptions): string {
  const rootsKey = (options?.machineRoots ?? DEFAULT_NODE_MACHINE_SKILL_ROOTS).join('\u0001')
  const shadowedKey =
    options?.shadowedIds !== undefined && options.shadowedIds.size > 0
      ? [...options.shadowedIds].sort((a, b) => a.localeCompare(b)).join('\u0001')
      : ''
  return `${nodeId}\u0000${cwd}\u0000${rootsKey}\u0000${shadowedKey}`
}

function cloneAndRedactSkills(skills: readonly SkillSummary[], redact: (text: string) => string): SkillSummary[] {
  return skills.map((skill) => {
    const safeId = redact(skill.id)
    return {
      ...skill,
      id: safeId,
      name: skill.name !== '' ? redact(skill.name) : safeId,
      ...(skill.description !== undefined && skill.description !== '' ? { description: redact(skill.description) } : {}),
      references: skill.references.map(redact),
    }
  })
}

/**
 * Invalidate cached node skill scan entries:
 * - no `host`: resets global cache map;
 * - `host` without `coordinate`: clears all entries for that host;
 * - `host` + `coordinate`: invalidates matching `(nodeId, cwd)` (or whole `nodeId`) entries.
 */
export function invalidateNodeSkillsCache(
  host?: NodeSkillsHostPort,
  coordinate?: { nodeId?: string; cwd?: string },
): void {
  if (host === undefined) {
    nodeSkillsCacheByHost = new WeakMap()
    return
  }
  const map = nodeSkillsCacheByHost.get(host)
  if (map === undefined) return
  if (coordinate === undefined) {
    map.clear()
    return
  }
  const targetNodeId = coordinate.nodeId ?? 'local'
  const prefix =
    coordinate.cwd !== undefined ? `${targetNodeId}\u0000${coordinate.cwd}\u0000` : `${targetNodeId}\u0000`
  for (const key of map.keys()) {
    if (key.startsWith(prefix)) map.delete(key)
  }
}

type NodeFileRead =
  | { kind: 'absent' }
  | { kind: 'refused'; reason: string }
  | { kind: 'content'; text: string }

function isAbsentRootError(error: { code: string; message: string }): boolean {
  return (
    error.code === 'not_found' ||
    error.code === 'not_directory' ||
    error.message.includes('ENOTDIR') ||
    error.message.includes('ENOENT')
  )
}

function joinUnderCwd(cwd: string, ...segments: string[]): string {
  return pathRulesForShape(targetPathShape(cwd)).join(cwd, ...segments)
}

function rootDedupKey(realRoot: string): string {
  return targetPathShape(realRoot) === 'win32' ? realRoot.toLowerCase() : realRoot
}

function resolveNodeSkillRoots(
  nodeId: string,
  cwd: string,
  options?: NodeSkillScanOptions,
): string[] {
  const roots: string[] = []
  if (nodeId !== 'local') {
    roots.push(...(options?.machineRoots ?? DEFAULT_NODE_MACHINE_SKILL_ROOTS))
  }
  if (cwd !== '') {
    roots.push(joinUnderCwd(cwd, ...NODE_SKILLS_RELATIVE_DIR.split('/')))
  }
  return roots
}

function formatNodeFileFailure(
  safePath: string,
  failure: BoundedReadFailure,
  redact: (text: string) => string,
): string {
  switch (failure.stage) {
    case 'canonical':
      return `解析 ${safePath} 真实路径失败（${failure.code}）：${redact(failure.message)}`
    case 'outside_dir':
      return `${safePath} 解析到技能目录之外，拒绝读取`
    case 'open':
    case 'read':
      return `读取 ${safePath} 失败（${failure.code}）：${redact(failure.message)}`
    case 'info':
      return `读取 ${safePath} 元信息失败（${failure.code}）：${redact(failure.message)}`
    case 'after_info':
      return `读取 ${safePath} 后复核元信息失败（${failure.code}）：${redact(failure.message)}`
    case 'not_regular_file':
      return `${safePath} 在打开后不是普通文件（kind=${failure.fileKind}），拒绝读取`
    case 'size_exceeded':
      return `${safePath} 为 ${failure.size} 字节，超过 ${failure.maxBytes} 字节读取上限，正文未读取`
    case 'binary_file':
      return `${safePath} 为二进制文件（${failure.size} 字节），正文未读取`
    case 'read_exceeded':
      return `${safePath} 读取到 ${failure.bytesRead} 字节，超过 ${failure.maxBytes} 字节上限，正文不采用`
    case 'file_changed':
      return `${safePath} 读取期间发生变化（size ${failure.beforeSize} -> ${failure.afterSize}），不采用可能不完整的快照`
    case 'size_mismatch':
      return `${safePath} 实读 ${failure.bytesRead} 字节与稳定大小 ${failure.stableSize} 不一致，不采用可能不完整的快照`
  }
}

async function readNodeFileBounded(
  env: ExecutionEnv,
  path: string,
  redact: (text: string) => string,
  withinDir?: string,
): Promise<NodeFileRead> {
  const safePath = redact(path)
  const read = await readFileBounded(env, path, {
    maxBytes: MAX_NODE_SKILL_FILE_BYTES,
    ...(withinDir !== undefined ? { withinDir } : {}),
    decoder: NODE_SKILL_UTF8_DECODER,
  })
  if (read.kind === 'refused') {
    return { kind: 'refused', reason: formatNodeFileFailure(safePath, read.failure, redact) }
  }
  return read
}

interface ReferenceScanState {
  count: number
}

async function collectNodeReferences(
  env: ExecutionEnv,
  redact: (text: string) => string,
  dir: string,
  rel = '',
  depth = 0,
  state: ReferenceScanState = { count: 0 },
): Promise<string[]> {
  if (state.count > MAX_NODE_SKILL_REFERENCES) return []
  const listed = await env.listDir(rel === '' ? dir : joinUnderCwd(dir, ...rel.split('/')), BACKGROUND_CONTEXT)
  if (!listed.ok) {
    if (listed.error.code === 'not_found') return []
    throw new HelmxError(
      'node_skill_read_failed',
      `列出节点技能目录 ${redact(rel === '' ? dir : `${dir}/${rel}`)} 失败（${listed.error.code}）：${redact(listed.error.message)}`,
      502,
    )
  }
  const out: string[] = []
  for (const entry of listed.value) {
    if (state.count > MAX_NODE_SKILL_REFERENCES) break
    if (entry.name.startsWith('.')) continue
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.kind === 'directory') {
      if (depth >= MAX_NODE_SKILL_REFERENCE_DEPTH) continue
      if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'dist') continue
      const nested = await collectNodeReferences(env, redact, dir, relPath, depth + 1, state)
      for (const item of nested) out.push(item)
    } else if (entry.kind === 'file' && entry.name !== 'SKILL.md') {
      try {
        out.push(assertSafeSkillRelativePath(relPath))
        state.count += 1
      } catch {
        // Invalid relative paths cannot be read via load_skill; exclude from catalog (same as Hub collectFiles).
      }
    }
  }
  return depth === 0 ? out.sort() : out
}

export async function scanNodeSkills(
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd = '',
  options?: NodeSkillScanOptions,
): Promise<NodeSkillScan> {
  try {
    return await scanNodeSkillsInner(host, nodeIdInput, cwd, options)
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: `发现节点技能失败（${errorCodeOf(err)}）：${host.redact(errorMessageOf(err))}`,
    }
  }
}

async function scanNodeSkillsInner(
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd: string,
  options?: NodeSkillScanOptions,
): Promise<NodeSkillScan> {
  const nodeId = nodeIdInput ?? 'local'
  const rawRoots = resolveNodeSkillRoots(nodeId, cwd, options)
  if (rawRoots.length === 0) return { kind: 'ok', skills: [] }
  const redact = (text: string): string => host.redact(text)

  if (nodeId !== 'local') {
    try {
      if (!host.nodeIpc.isOnline(nodeId)) {
        invalidateNodeSkillsCache(host, { nodeId })
        return { kind: 'unavailable', reason: `目标节点 ${nodeId} 当前离线，未能读取其节点技能库。` }
      }
    } catch (err) {
      invalidateNodeSkillsCache(host, { nodeId })
      return {
        kind: 'unavailable',
        reason: `检查目标节点 ${nodeId} 在线状态失败（${errorCodeOf(err)}）：${redact(errorMessageOf(err))}`,
      }
    }
  }

  const ttlMs = options?.cacheTtlMs ?? NODE_SKILLS_CACHE_TTL_MS
  const nowMs = options?.now !== undefined ? options.now() : Date.now()
  const cacheKey = ttlMs > 0 ? buildNodeSkillsCacheKey(nodeId, cwd, options) : undefined
  if (cacheKey !== undefined) {
    const hostCache = nodeSkillsCacheByHost.get(host)
    const cached = hostCache?.get(cacheKey)
    if (cached !== undefined) {
      if (cached.expiresAt > nowMs) {
        return {
          kind: 'ok',
          skills: cloneAndRedactSkills(cached.skills, redact),
          ...(cached.shadowedSkillIds.length > 0 ? { shadowedSkillIds: cached.shadowedSkillIds.map(redact) } : {}),
        }
      }
      hostCache!.delete(cacheKey)
    }
  }

  let env: ExecutionEnv
  try {
    env = host.executionEnv(nodeId, cwd)
  } catch (err) {
    return {
      kind: 'unavailable',
      reason: `获取节点 ${nodeId} 执行环境失败（${errorCodeOf(err)}）：${redact(errorMessageOf(err))}`,
    }
  }

  const seenRoots = new Set<string>()
  const byId = new Map<string, SkillSummary>()
  const shadowedSkillIds = new Set<string>()
  const unavailableReasons: string[] = []

  for (const rawRoot of rawRoots) {
    let canonical: Awaited<ReturnType<ExecutionEnv['canonicalPath']>>
    try {
      canonical = await env.canonicalPath(rawRoot, BACKGROUND_CONTEXT)
    } catch (err) {
      unavailableReasons.push(`解析节点技能目录 ${rawRoot} 失败（${errorCodeOf(err)}）：${redact(errorMessageOf(err))}`)
      continue
    }
    if (!canonical.ok) {
      if (isAbsentRootError(canonical.error)) continue
      unavailableReasons.push(`解析节点技能目录 ${rawRoot} 失败（${canonical.error.code}）：${redact(canonical.error.message)}`)
      continue
    }
    const realRoot = canonical.value
    const dedup = rootDedupKey(realRoot)
    if (seenRoots.has(dedup)) continue
    seenRoots.add(dedup)

    let listed: Awaited<ReturnType<ExecutionEnv['listDir']>>
    try {
      listed = await env.listDir(realRoot, BACKGROUND_CONTEXT)
    } catch (err) {
      unavailableReasons.push(`列出节点技能目录 ${rawRoot} 失败（${errorCodeOf(err)}）：${redact(errorMessageOf(err))}`)
      continue
    }
    if (!listed.ok) {
      if (isAbsentRootError(listed.error)) continue
      unavailableReasons.push(`列出节点技能目录 ${rawRoot} 失败（${listed.error.code}）：${redact(listed.error.message)}`)
      continue
    }

    const candidates = listed.value.filter(
      (entry) => entry.kind === 'directory' && !entry.name.startsWith('.'),
    )
    if (candidates.length > MAX_NODE_SKILLS) {
      unavailableReasons.push(
        `节点技能目录 ${rawRoot} 含 ${candidates.length} 个条目，超过 ${MAX_NODE_SKILLS} 上限，未纳入该目录技能。`,
      )
      continue
    }

    const toScan: string[] = []
    for (const entry of candidates.sort((a, b) => a.name.localeCompare(b.name))) {
      try {
        assertSkillId(entry.name)
      } catch {
        continue
      }
      if (options?.shadowedIds?.has(entry.name)) {
        shadowedSkillIds.add(entry.name)
        continue
      }
      if (byId.has(entry.name)) continue
      toScan.push(entry.name)
    }

    type CandidateOutcome =
      | { kind: 'skip' }
      | { kind: 'ok'; rawId: string; summary: SkillSummary }
      | { kind: 'unavailable'; reason: string }

    const outcomes = new Array<CandidateOutcome>(toScan.length)
    let nextIdx = 0
    let stopRoot = false
    const workerCount = Math.min(NODE_SKILL_SCAN_CONCURRENCY, toScan.length)
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          if (stopRoot) return
          const idx = nextIdx
          nextIdx += 1
          if (idx >= toScan.length) return
          const skillName = toScan[idx]!
          const safeSkillName = redact(skillName)
          const skillDir = joinUnderCwd(realRoot, skillName)
          const skillMdR = await readNodeFileBounded(env, joinUnderCwd(skillDir, 'SKILL.md'), redact, skillDir)
          if (skillMdR.kind === 'absent') {
            outcomes[idx] = { kind: 'skip' }
            continue
          }
          if (skillMdR.kind === 'refused') {
            outcomes[idx] = { kind: 'unavailable', reason: `节点技能 ${safeSkillName} 读取失败：${skillMdR.reason}` }
            stopRoot = true
            return
          }
          let frontmatter: ReturnType<typeof parseSkillFrontmatter>
          try {
            frontmatter = parseSkillFrontmatter(skillMdR.text)
          } catch {
            outcomes[idx] = { kind: 'skip' }
            continue
          }
          let references: string[]
          try {
            references = await collectNodeReferences(env, redact, skillDir)
          } catch (err) {
            if (err instanceof HelmxError) {
              outcomes[idx] = { kind: 'unavailable', reason: err.message }
              stopRoot = true
              return
            }
            throw err
          }
          if (references.length > MAX_NODE_SKILL_REFERENCES) {
            outcomes[idx] = {
              kind: 'unavailable',
              reason: `节点技能 ${safeSkillName} 含 ${references.length} 个 references 文件，超过 ${MAX_NODE_SKILL_REFERENCES} 上限，未纳入该目录技能。`,
            }
            stopRoot = true
            return
          }
          outcomes[idx] = {
            kind: 'ok',
            rawId: skillName,
            summary: {
              id: safeSkillName,
              name: frontmatter.name !== '' ? redact(frontmatter.name) : safeSkillName,
              ...(frontmatter.description !== '' ? { description: redact(frontmatter.description) } : {}),
              references: references.map(redact),
              // managedByPlugin deliberately stripped: a node may only host normal skills, never host-managed plugin skills.
              source: 'node',
            },
          }
        }
      }),
    )

    for (const outcome of outcomes) {
      if (outcome === undefined || outcome.kind === 'skip') continue
      if (outcome.kind === 'unavailable') {
        unavailableReasons.push(outcome.reason)
        break
      }
      byId.set(outcome.rawId, outcome.summary)
    }
  }

  const skills = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  const sortedShadowedIds = [...shadowedSkillIds].map(redact).sort((a, b) => a.localeCompare(b))
  if (unavailableReasons.length > 0) {
    return {
      kind: 'unavailable',
      reason: redact(unavailableReasons.join('; ')),
      ...(skills.length > 0 ? { skills } : {}),
      ...(sortedShadowedIds.length > 0 ? { shadowedSkillIds: sortedShadowedIds } : {}),
    }
  }
  if (cacheKey !== undefined) {
    let hostCache = nodeSkillsCacheByHost.get(host)
    if (hostCache === undefined) {
      hostCache = new Map()
      nodeSkillsCacheByHost.set(host, hostCache)
    }
    const endNow = options?.now !== undefined ? options.now() : Date.now()
    hostCache.set(cacheKey, {
      expiresAt: endNow + ttlMs,
      skills: cloneAndRedactSkills(skills, redact),
      shadowedSkillIds: sortedShadowedIds,
    })
  }
  return {
    kind: 'ok',
    skills,
    ...(sortedShadowedIds.length > 0 ? { shadowedSkillIds: sortedShadowedIds } : {}),
  }
}

export async function readNodeSkillFile(
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd: string,
  skillId: string,
  path: string,
  options?: NodeSkillScanOptions,
): Promise<string> {
  try {
    return await readNodeSkillFileInner(host, nodeIdInput, cwd, skillId, path, options)
  } catch (err) {
    if (err instanceof HelmxError && err.code === 'not_found') {
      invalidateNodeSkillsCache(host, { nodeId: nodeIdInput ?? 'local', cwd })
    }
    if (err instanceof HelmxError) throw err
    const safeSkillId = host.redact(skillId)
    throw new HelmxError(
      'node_skill_read_failed',
      `reading node skill '${safeSkillId}' on node '${nodeIdInput ?? 'local'}' failed unexpectedly (${errorCodeOf(err)}): ${host.redact(errorMessageOf(err))}`,
      502,
      { skillId: safeSkillId },
    )
  }
}

async function readNodeSkillFileInner(
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd: string,
  skillId: string,
  path: string,
  options?: NodeSkillScanOptions,
): Promise<string> {
  const redact = (text: string): string => host.redact(text)
  const safeSkillId = redact(skillId)
  const safePath = redact(path)
  try {
    assertSkillId(skillId)
  } catch (err) {
    throw new HelmxError('validation_error', `Invalid skill id: ${redact(errorMessageOf(err))}`, 400, { skillId: safeSkillId })
  }
  let rel: string
  try {
    rel = assertSafeSkillRelativePath(path)
  } catch (err) {
    throw new HelmxError('validation_error', `Invalid skill-relative path: ${redact(errorMessageOf(err))}`, 400, { skillId: safeSkillId, path: safePath })
  }
  const safeRel = redact(rel)
  const nodeId = nodeIdInput ?? 'local'
  const rawRoots = resolveNodeSkillRoots(nodeId, cwd, options)
  if (rawRoots.length === 0) {
    throw new HelmxError('not_found', `skill does not exist: ${safeSkillId}`, 404, { skillId: safeSkillId })
  }

  if (nodeId !== 'local') {
    try {
      if (!host.nodeIpc.isOnline(nodeId)) {
        throw new HelmxError('node_offline', `node '${nodeId}' is offline; cannot read node skill '${safeSkillId}' (refusing to fall back to Hub skills)`, 409, { nodeId, skillId: safeSkillId })
      }
    } catch (err) {
      if (err instanceof HelmxError) throw err
      throw new HelmxError('node_offline', `checking node '${nodeId}' online state failed (${errorCodeOf(err)}): ${redact(errorMessageOf(err))}`, 409, { nodeId, skillId: safeSkillId })
    }
  }

  let env: ExecutionEnv
  try {
    env = host.executionEnv(nodeId, cwd)
  } catch (err) {
    throw new HelmxError(
      'node_skill_read_failed',
      `acquiring execution env for node '${nodeId}' failed (${errorCodeOf(err)}): ${redact(errorMessageOf(err))}`,
      502,
      { nodeId, skillId: safeSkillId },
    )
  }

  const seenRoots = new Set<string>()
  for (const rawRoot of rawRoots) {
    const safeRawRoot = redact(rawRoot)
    const canonical = await env.canonicalPath(rawRoot, BACKGROUND_CONTEXT)
    if (!canonical.ok) {
      if (isAbsentRootError(canonical.error)) continue
      throw new HelmxError(
        'node_skill_read_failed',
        `resolving node skill root '${safeRawRoot}' failed (${canonical.error.code}): ${redact(canonical.error.message)}`,
        502,
        { nodeId, skillId: safeSkillId },
      )
    }
    const realRoot = canonical.value
    const dedup = rootDedupKey(realRoot)
    if (seenRoots.has(dedup)) continue
    seenRoots.add(dedup)

    const skillDir = joinUnderCwd(realRoot, skillId)
    const dirInfoR = await env.fileInfo(skillDir, BACKGROUND_CONTEXT)
    if (!dirInfoR.ok) {
      if (isAbsentRootError(dirInfoR.error)) continue
      throw new HelmxError(
        'node_skill_read_failed',
        `inspecting node skill '${safeSkillId}' on node '${nodeId}' failed (${dirInfoR.error.code}): ${redact(dirInfoR.error.message)}`,
        502,
        { nodeId, skillId: safeSkillId },
      )
    }
    if (dirInfoR.value.kind === 'symlink') {
      throw new HelmxError(
        'node_skill_read_failed',
        `reading node skill '${safeSkillId}' on node '${nodeId}' failed: skill directory is a symlink`,
        502,
        { nodeId, skillId: safeSkillId },
      )
    }
    if (dirInfoR.value.kind !== 'directory') continue

    const skillRealR = await env.canonicalPath(skillDir, BACKGROUND_CONTEXT)
    if (!skillRealR.ok) {
      if (isAbsentRootError(skillRealR.error)) continue
      throw new HelmxError(
        'node_skill_read_failed',
        `resolving node skill '${safeSkillId}' on node '${nodeId}' failed (${skillRealR.error.code}): ${redact(skillRealR.error.message)}`,
        502,
        { nodeId, skillId: safeSkillId },
      )
    }
    const skillReal = skillRealR.value
    if (!isPathWithin(skillReal, realRoot)) {
      throw new HelmxError(
        'node_skill_read_failed',
        `reading node skill '${safeSkillId}' on node '${nodeId}' failed: skill directory resolves outside skills root`,
        502,
        { nodeId, skillId: safeSkillId },
      )
    }

    const skillMdRead = await readNodeFileBounded(env, joinUnderCwd(skillReal, 'SKILL.md'), redact, skillReal)
    if (skillMdRead.kind === 'absent') continue
    if (skillMdRead.kind === 'refused') {
      throw new HelmxError('node_skill_read_failed', `reading node skill '${safeSkillId}' (SKILL.md) on node '${nodeId}' failed: ${skillMdRead.reason}`, 502, {
        nodeId,
        skillId: safeSkillId,
        path: 'SKILL.md',
      })
    }
    try {
      parseSkillFrontmatter(skillMdRead.text)
    } catch {
      continue
    }
    if (rel === 'SKILL.md') return skillMdRead.text

    const target = joinUnderCwd(skillReal, ...rel.split('/'))
    const read = await readNodeFileBounded(env, target, redact, skillReal)
    if (read.kind === 'absent') {
      throw new HelmxError('not_found', `skill does not exist: ${safeSkillId}`, 404, { skillId: safeSkillId, path: safeRel })
    }
    if (read.kind === 'refused') {
      throw new HelmxError('node_skill_read_failed', `reading node skill '${safeSkillId}' (${safeRel}) on node '${nodeId}' failed: ${read.reason}`, 502, {
        nodeId,
        skillId: safeSkillId,
        path: safeRel,
      })
    }
    return read.text
  }

  throw new HelmxError('not_found', `skill does not exist: ${safeSkillId}`, 404, { skillId: safeSkillId, path: safeRel })
}

export function nodeSkillsUnavailableSection(
  nodeId: string | undefined,
  cwd: string,
  reason: string,
): { id: 'profile.node-skills-unavailable'; text: string } {
  const dir = cwd !== '' ? joinUnderCwd(cwd, ...NODE_SKILLS_RELATIVE_DIR.split('/')) : DEFAULT_NODE_MACHINE_SKILL_ROOTS.join(', ')
  return {
    id: 'profile.node-skills-unavailable',
    text: `<node_skills_unavailable dir="${escapeXml(dir)}" node="${escapeXml(nodeId ?? 'local')}">\n${escapeXml(reason)}\n</node_skills_unavailable>`,
  }
}
