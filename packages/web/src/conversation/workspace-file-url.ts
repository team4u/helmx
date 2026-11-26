/**
 * Workspace file link & image URL parser (pure functions, zero React/DOM deps).
 *
 * Recognizes safe workspace-relative paths, bare absolute paths strictly contained
 * within `conversationCwd`, and `file://` URLs strictly contained within
 * `conversationCwd`, normalizing relative references against `workspaceBaseDir`
 * and extracting optional line ranges from either an `#L<start>(C<col>)?(-L?<end>(C<col>)?)?`
 * fragment or a compiler-style trailing `:line(:col)?(-line(:col)?)?` suffix.
 */
import { normalizeTargetPath, pathRulesForShape, targetPathShape } from '@helmx/protocol/browser'

export interface WorkspaceFileRef {
  path: string
  startLine?: number
  endLine?: number
}

export interface WorkspaceConversationNode {
  readonly id: number
  readonly nodeId: string
  readonly cwd: string
  readonly parentConversationId?: number
}

export interface ResolvedWorkspaceFileTarget extends WorkspaceFileRef {
  conversationId: number
}

const EMPTY_WORKSPACE_NODES: ReadonlyArray<WorkspaceConversationNode> = Object.freeze([])

const EXPLICIT_SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/
const WINDOWS_DRIVE_ABS_RE = /^[A-Za-z]:[\\/]/
const BARE_LOCALHOST_RE = /^localhost(?::\d+)?$/i
const BARE_IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/
const BARE_WEB_TLD_RE = /\.(?:com|org|net|io|dev|app|ai|cn|edu|gov|co|me|xyz|info|biz)(?::\d+)?$/i
const LINE_FRAGMENT_RE = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i
// Compiler-style trailing line suffix: file.ts:420, file.ts:420:10, file.ts:420-430, file.ts:420:10-430:5
const TRAILING_COLON_LINE_RE = /:(\d{1,7})(?::\d{1,5})?(?:-(\d{1,7})(?::\d{1,5})?)?$/

function isWindowsDriveOrUnc(raw: string): boolean {
  return WINDOWS_DRIVE_ABS_RE.test(raw) || raw.startsWith('\\\\')
}

/**
 * Returns true when a raw link/image URL uses a local filesystem reference
 * (`file:` scheme or bare Windows drive/UNC path) that browsers must not follow
 * as a hyperlink or `<img src>` when outside `conversationCwd`.
 */
export function isDisallowedFileUrl(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false
  const trimmed = raw.trim()
  return trimmed.toLowerCase().startsWith('file:') || isWindowsDriveOrUnc(trimmed)
}

function parseLineRange(fragment: string): { startLine?: number; endLine?: number } {
  if (fragment === '') return {}
  const match = LINE_FRAGMENT_RE.exec(fragment)
  if (match === null) return {}
  const startLine = Number(match[1])
  if (!Number.isSafeInteger(startLine) || startLine <= 0) return {}
  if (match[2] === undefined) return { startLine }
  const endLine = Number(match[2])
  if (!Number.isSafeInteger(endLine) || endLine < startLine) {
    return { startLine }
  }
  return { startLine, endLine }
}

/**
 * Strip a compiler-style trailing `:line(:col)?(-line(:col)?)?` suffix (e.g.
 * `src/app.ts:420`, `src/app.ts:420:10`, `src/app.ts:420-430`) into the bare
 * path plus a line range, mirroring `parseLineRange` semantics. Only applies
 * when the remainder still looks like a path (contains `/`, `\`, or `.`), so
 * scheme-ish tokens such as `telnet:23` or hosts like `localhost:3000` keep
 * their original classification. Returns null when no valid suffix is present.
 */
function splitTrailingLineSuffix(
  raw: string,
): { path: string; startLine?: number; endLine?: number } | null {
  const match = TRAILING_COLON_LINE_RE.exec(raw)
  if (match === null || match.index === 0) return null
  const path = raw.slice(0, match.index)
  if (path === '' || !/[./\\]/.test(path)) return null
  const startLine = Number(match[1])
  if (!Number.isSafeInteger(startLine) || startLine <= 0) return null
  if (match[2] === undefined) return { path, startLine }
  const endLine = Number(match[2])
  if (!Number.isSafeInteger(endLine) || endLine < startLine) {
    return { path, startLine }
  }
  return { path, startLine, endLine }
}

/**
 * Resolve a decoded absolute path strictly inside `conversationCwd`, returning
 * a normalized workspace-relative POSIX path or `null` on mismatch/escape.
 */
function relativizeInsideCwd(
  candidatePath: string,
  conversationCwd: string | undefined,
  opts: { allowRootCwd: boolean },
): string | null {
  if (conversationCwd === undefined) return null
  const trimmedCwd = conversationCwd.trim()
  if (trimmedCwd === '') return null
  if (candidatePath === '' || candidatePath.includes('\0')) return null

  const cwdShape = targetPathShape(trimmedCwd)
  if (cwdShape === undefined) return null

  if (cwdShape === 'win32') {
    const normCwdR = normalizeTargetPath(trimmedCwd, 'win32')
    const normFileR = normalizeTargetPath(candidatePath, 'win32')
    if (!normCwdR.ok || !normFileR.ok) return null
    const normCwd = normCwdR.path
    const normFile = normFileR.path
    const base = /^[A-Za-z]:\\$/.test(normCwd) || normCwd === '\\' || normCwd.endsWith('\\') && pathRulesForShape('win32').dirname(normCwd) === normCwd
      ? normCwd
      : normCwd.replace(/\\+$/, '')
    if (!opts.allowRootCwd && base.endsWith('\\')) return null
    const prefix = base.endsWith('\\') ? base : `${base}\\`
    if (!normFile.toLowerCase().startsWith(prefix.toLowerCase())) return null
    const relWin = normFile.slice(prefix.length)
    if (relWin === '' || relWin.endsWith('\\')) return null
    return relWin.replace(/\\/g, '/')
  }

  if (targetPathShape(candidatePath) !== 'posix') return null
  const posix = pathRulesForShape('posix')
  const normCwd = posix.normalize(trimmedCwd)
  const normFile = posix.normalize(candidatePath)
  const base = normCwd === '/' ? '/' : normCwd.replace(/\/+$/, '')
  if (!opts.allowRootCwd && base === '/') return null
  const prefix = base === '/' ? '/' : `${base}/`
  if (!normFile.startsWith(prefix)) return null
  const relPosix = normFile.slice(prefix.length)
  if (relPosix === '' || relPosix === '.' || relPosix.endsWith('/')) return null
  return relPosix
}

function parseFileSchemeRef(
  beforeHash: string,
  conversationCwd: string | undefined,
): string | null {
  if (!beforeHash.toLowerCase().startsWith('file://')) return null
  if (beforeHash.includes('?')) return null

  let url: URL
  try {
    url = new URL(beforeHash)
  } catch {
    return null
  }
  if (url.protocol !== 'file:' || url.search !== '') return null
  if (url.hostname !== '' && url.hostname.toLowerCase() !== 'localhost') {
    return null
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (decodedPath === '' || decodedPath.includes('\0')) return null

  // Windows drive URL: file:///C:/a/b -> pathname '/C:/a/b' -> 'C:/a/b'
  const candidatePath = /^\/[A-Za-z]:(?:[\\/]|$)/.test(decodedPath)
    ? decodedPath.slice(1)
    : decodedPath

  return relativizeInsideCwd(candidatePath, conversationCwd, { allowRootCwd: true })
}

/**
 * Parse a Markdown link/image href/src into a workspace-relative file reference.
 * Returns null for anchors, external URLs, bare host/domain links, query strings,
 * paths escaping `conversationCwd`, or absolute paths outside `conversationCwd`
 * (or when `conversationCwd` is missing or points to filesystem root).
 */
export function parseWorkspaceFileRef(
  raw: string | undefined,
  opts?: { conversationCwd?: string; workspaceBaseDir?: string },
): WorkspaceFileRef | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (trimmed.startsWith('#') || trimmed.startsWith('//')) return null

  const hashIdx = trimmed.indexOf('#')
  const beforeHash = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)
  const fragment = hashIdx === -1 ? '' : trimmed.slice(hashIdx + 1)
  if (beforeHash === '') return null

  if (/^file:/i.test(beforeHash)) {
    const relPath = parseFileSchemeRef(beforeHash, opts?.conversationCwd)
    if (relPath === null) return null
    return { path: relPath, ...parseLineRange(fragment) }
  }

  if (beforeHash.includes('?')) return null

  // Bare absolute paths (/repo/a.ts, C:/repo/a.ts, \\server\share\repo\a.ts):
  // strictly narrow against conversationCwd (non-root) and return directly without workspaceBaseDir.
  if (beforeHash.startsWith('/') || isWindowsDriveOrUnc(beforeHash)) {
    let decodedAbs: string
    try {
      decodedAbs = decodeURIComponent(beforeHash)
    } catch {
      return null
    }
    if (decodedAbs.includes('?')) return null
    const suffix = splitTrailingLineSuffix(decodedAbs)
    const relPath = relativizeInsideCwd(
      suffix !== null ? suffix.path : decodedAbs,
      opts?.conversationCwd,
      { allowRootCwd: false },
    )
    if (relPath === null) return null
    return {
      path: relPath,
      ...(suffix !== null
        ? { startLine: suffix.startLine, ...(suffix.endLine !== undefined ? { endLine: suffix.endLine } : {}) }
        : {}),
      ...parseLineRange(fragment),
    }
  }

  // Strip a trailing compiler-style `:line` suffix before scheme/host
  // classification so `src/app.ts:420` resolves as a workspace file with a
  // line range instead of a scheme-ish URL or a path with the suffix baked in.
  const suffix = splitTrailingLineSuffix(beforeHash)
  const candidate = suffix !== null ? suffix.path : beforeHash

  if (EXPLICIT_SCHEME_RE.test(candidate)) return null
  if (candidate.includes('\\')) return null

  // Reject bare domain/host links that do not explicitly start with ./ or ../
  if (!candidate.startsWith('./') && !candidate.startsWith('../')) {
    const firstSeg = candidate.split('/')[0] ?? ''
    if (
      BARE_LOCALHOST_RE.test(firstSeg) ||
      BARE_IPV4_RE.test(firstSeg) ||
      BARE_WEB_TLD_RE.test(firstSeg)
    ) {
      return null
    }
  }

  let decodedRel: string
  try {
    decodedRel = decodeURIComponent(candidate)
  } catch {
    return null
  }
  if (
    decodedRel === '' ||
    decodedRel.includes('\0') ||
    decodedRel.includes('\\') ||
    decodedRel.includes('?') ||
    decodedRel.startsWith('/')
  ) {
    return null
  }

  const posix = pathRulesForShape('posix')
  let combined = decodedRel
  if (opts?.workspaceBaseDir !== undefined) {
    const rawBase = opts.workspaceBaseDir.trim().replace(/^\/+/, '').replace(/\/+$/, '')
    if (rawBase !== '' && rawBase !== '.') {
      const baseNorm = posix.normalize(rawBase)
      if (baseNorm === '..' || baseNorm.startsWith('../')) return null
      if (baseNorm !== '.') {
        combined = `${baseNorm}/${decodedRel}`
      }
    }
  }

  const normalized = posix.normalize(combined)
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/')
  ) {
    return null
  }

  return {
    path: normalized,
    ...(suffix !== null
      ? { startLine: suffix.startLine, ...(suffix.endLine !== undefined ? { endLine: suffix.endLine } : {}) }
      : {}),
    ...parseLineRange(fragment),
  }
}

/**
 * Group conversation workspace nodes by `(rootConversationId, nodeId)` so every
 * conversation in a task tree can resolve absolute / `file://` file links
 * belonging to siblings or descendants on the same compute node.
 */
export function buildSameTreeWorkspacesMap(
  nodes: ReadonlyArray<WorkspaceConversationNode>,
): Map<number, ReadonlyArray<WorkspaceConversationNode>> {
  const byId = new Map<number, WorkspaceConversationNode>()
  for (const node of nodes) {
    byId.set(node.id, node)
  }

  const rootCache = new Map<number, number>()
  const rootOf = (startId: number): number => {
    const cached = rootCache.get(startId)
    if (cached !== undefined) return cached
    const visited = new Set<number>()
    const path: number[] = []
    let curId: number | undefined = startId
    let rootId = startId
    while (curId !== undefined) {
      const existingRoot = rootCache.get(curId)
      if (existingRoot !== undefined) {
        rootId = existingRoot
        break
      }
      if (visited.has(curId)) {
        const cycleStart = path.indexOf(curId)
        rootId = Math.min(...path.slice(cycleStart))
        break
      }
      visited.add(curId)
      path.push(curId)
      rootId = curId
      const parentId: number | undefined = byId.get(curId)?.parentConversationId
      if (parentId === undefined || !byId.has(parentId)) break
      curId = parentId
    }
    for (const id of path) {
      rootCache.set(id, rootId)
    }
    return rootId
  }

  const groups = new Map<string, WorkspaceConversationNode[]>()
  const nodeGroupKey = new Map<number, string>()
  for (const node of byId.values()) {
    const rootId = rootOf(node.id)
    const key = `${rootId}\0${node.nodeId || 'local'}`
    nodeGroupKey.set(node.id, key)
    if (typeof node.cwd === 'string' && node.cwd.trim() !== '') {
      let list = groups.get(key)
      if (list === undefined) {
        list = []
        groups.set(key, list)
      }
      list.push(node)
    }
  }

  const frozenGroups = new Map<string, ReadonlyArray<WorkspaceConversationNode>>()
  for (const [key, list] of groups) {
    list.sort((a, b) => a.id - b.id)
    frozenGroups.set(key, Object.freeze(list))
  }

  const result = new Map<number, ReadonlyArray<WorkspaceConversationNode>>()
  for (const node of byId.values()) {
    const key = nodeGroupKey.get(node.id)!
    result.set(node.id, frozenGroups.get(key) ?? EMPTY_WORKSPACE_NODES)
  }
  return result
}

/**
 * Resolve a Markdown file link/image against the viewer conversation first, then
 * fall back ONLY for absolute / `file:` URLs to other workspaces in the same
 * conversation tree on the same compute node (picking the most specific `cwd`
 * match, breaking ties by highest conversation ID).
 */
export function resolveWorkspaceFileRef(
  raw: string | undefined,
  opts: {
    conversationId: number
    conversationCwd?: string
    workspaceBaseDir?: string
    treeWorkspaces?: ReadonlyArray<Pick<WorkspaceConversationNode, 'id' | 'cwd'>>
  },
): ResolvedWorkspaceFileTarget | null {
  const primary = parseWorkspaceFileRef(raw, {
    conversationCwd: opts.conversationCwd,
    workspaceBaseDir: opts.workspaceBaseDir,
  })
  if (primary !== null) {
    return { ...primary, conversationId: opts.conversationId }
  }

  if (typeof raw !== 'string' || opts.treeWorkspaces === undefined || opts.treeWorkspaces.length === 0) {
    return null
  }
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return null
  }
  const hashIdx = trimmed.indexOf('#')
  const beforeHash = hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)
  if (
    beforeHash === '' ||
    (!/^file:/i.test(beforeHash) && !beforeHash.startsWith('/') && !isWindowsDriveOrUnc(beforeHash))
  ) {
    return null
  }

  let best: { id: number; ref: WorkspaceFileRef } | null = null
  for (const ws of opts.treeWorkspaces) {
    if (ws.id === opts.conversationId) continue
    const candidate = parseWorkspaceFileRef(raw, { conversationCwd: ws.cwd })
    if (candidate === null) continue
    if (
      best === null ||
      candidate.path.length < best.ref.path.length ||
      (candidate.path.length === best.ref.path.length && ws.id > best.id)
    ) {
      best = { id: ws.id, ref: candidate }
    }
  }
  return best !== null ? { ...best.ref, conversationId: best.id } : null
}
