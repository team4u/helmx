/**
 * builtin:profile 节点技能库：目标节点机器级根目录（`~/.helmx/skills`、`~/.agents/skills`）
 * 与工作区 `<cwd>/.helmx/skills` 下的只读技能来源（策略归插件层；内核只提供
 * executionEnv / nodeIpc / redact 机制端口，本模块零内核改动）。
 *
 * 契约与诚实性纪律（对齐仓库 AGENTS.md 第 3 节红线与 agents-md.ts 先例）：
 * - 只读发现与加载：节点技能永远留在节点事实来源上，绝不复制进 Hub
 *   SkillService 的 dataDir；每回合 before_turn 重新发现、load_skill 与
 *   skill_read 每次都读节点当前内容（节点技能更新即生效，不回写历史上下文）；
 * - 同名优先级契约（明确、不依赖 listDir 顺序）：
 *   1. Hub dataDir（含受管技能，永远最高）
 *   2. Hub 机器级共享根 ~/.agents/skills
 *   3. 远端节点机器级根目录 ~/.helmx/skills > ~/.agents/skills（nodeId !== 'local'）
 *   4. 工作区项目级目录 <cwd>/.helmx/skills（local 与远端节点均在提供 cwd 时叠加）
 *   节点侧所有根均标 source: 'node'，只能补充、不能覆盖 Hub 版本：同名时
 *   catalog 不收录节点版本，load_skill / skill_read 无来源参数、永远解析到
 *   最高优先级版本（若 cwd 恰好是节点主目录，按 canonicalPath 去重免重复扫描）；
 * - 目录缺失（不存在 / 非目录）属常态，按空处理；节点离线、宿主能力未接线、
 *   权限或 IO 故障绝不静默降级为「无节点技能」，显式返回 unavailable 诊断
 *   （before_turn 注入显式说明段，load_skill / skill_read 显式报错）；单个
 *   技能条目内容缺失（无 SKILL.md）或 frontmatter 非法按第三方常态跳过该条目；
 * - 读取全程使用 ExecutionEnv 安全原语封死 TOCTOU 与无界读取（同
 *   agents-md 口径）：canonicalPath 解析后以 openBinaryReader(realPath,
 *   { noFollow: true }) 打开，kind/size 以同句柄 reader.info 为权威，正文只经
 *   reader.read(0, MAX_NODE_SKILL_FILE_BYTES + 1) 有界定位读，读后同句柄
 *   二次复核，绝不 readTextFile 无界整读；frontmatter 的 name/description
 *   进入系统提示前经宿主脱敏（机密不进系统提示词），load_skill 工具输出走
 *   宿主统一工具输出脱敏管道；
 * - 技能内相对路径与 id 共用 @helmx/protocol skill-contract 契约（与 Hub
 *   技能完全同一词汇）：穿越 / 绝对路径 / 反斜杠 / 非法字符一律拒绝；
 * - 节点文件的软链组织是节点本地事实（Windows junction 同理）：发现时
 *   listDir 把软链列为 symlink 而不跟随（技能目录为软链即跳过），读取时
 *   fileInfo + canonicalPath 包含校验 + noFollow 拒最终组件软链；模型可请求的路径
 *   被相对路径词汇限制在技能目录树内。本模块不做 OS 沙箱，与 Hub 技能口径一致。
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

/** 节点技能库在工作区内的相对目录（POSIX 分隔符；路径合成按 cwd 形状选规则）。 */
export const NODE_SKILLS_RELATIVE_DIR = '.helmx/skills'

/** 远端节点（nodeId !== 'local'）机器级技能根目录（按优先级顺序；经节点端 ~ 展开到节点宿主用户主目录）。 */
export const DEFAULT_NODE_MACHINE_SKILL_ROOTS = ['~/.helmx/skills', '~/.agents/skills'] as const

/**
 * 节点技能单文件读取前置字节上限（有界保护，与 AGENTS.md 读取同口径）：
 * SKILL.md 与 references 文件超过该字节数即不读正文——发现层显式报
 * unavailable（哪个技能超限写进诊断）、读取层显式 502 拒绝。
 */
export const MAX_NODE_SKILL_FILE_BYTES = 256 * 1024

/** 单根目录节点技能条目上限：超过按病态目录显式不可用，绝不静默截断。 */
export const MAX_NODE_SKILLS = 256

/** 单个节点技能 references 文件数上限：超过按病态技能跳过/报错，绝不静默截断。 */
export const MAX_NODE_SKILL_REFERENCES = 512

/** 单个节点技能 references 子目录递归最大深度（根为 0，最多下钻 8 层子目录）。 */
export const MAX_NODE_SKILL_REFERENCE_DEPTH = 8

/** 单根目录内并发扫描节点技能目录的并发度上限。 */
export const NODE_SKILL_SCAN_CONCURRENCY = 5

/** 健康节点技能目录扫描结果的短时 TTL 缓存窗口（毫秒）。 */
export const NODE_SKILLS_CACHE_TTL_MS = 5_000

/** 节点技能正文按 UTF-8 解码（非法序列替换为 U+FFFD，与 Hub readTextFile 同口径）。 */
const NODE_SKILL_UTF8_DECODER = new TextDecoder('utf-8')

/** 读取依赖的最小宿主形状（真实 ctx.host 天然满足；测试可注入受控实现）。 */
export interface NodeSkillsHostPort {
  executionEnv(nodeId: string, cwd: string): ExecutionEnv
  redact(text: string): string
  nodeIpc: { isOnline(nodeId: string): boolean }
}

/** 节点技能扫描/读取选项（主要用于测试覆盖机器级根目录、同名遮蔽剪枝与 TTL 控制）。 */
export interface NodeSkillScanOptions {
  machineRoots?: readonly string[]
  /** 已被 Hub 同名技能遮蔽的技能 ID 集合（扫描时跳过读取 SKILL.md 与 references，仅记录遮蔽）。 */
  shadowedIds?: ReadonlySet<string>
  /** 健康扫描结果短时缓存毫秒数（默认 `NODE_SKILLS_CACHE_TTL_MS`；`<= 0` 禁用缓存）。 */
  cacheTtlMs?: number
  /** 时钟注入（供测试确定性推进 TTL）。 */
  now?: () => number
}

/** 发现结果：ok=可用技能摘要（按 id 排序）；unavailable=显式诊断（已脱敏、未转义，健康根的技能仍保留）。 */
export type NodeSkillScan =
  | { kind: 'ok'; skills: SkillSummary[]; shadowedSkillIds?: string[] }
  | { kind: 'unavailable'; reason: string; skills?: SkillSummary[]; shadowedSkillIds?: string[] }

interface CachedNodeSkillScan {
  expiresAt: number
  skills: SkillSummary[]
  shadowedSkillIds: string[]
}

let nodeSkillsCacheByHost = new WeakMap<NodeSkillsHostPort, Map<string, CachedNodeSkillScan>>()

function buildNodeSkillsCacheKey(nodeId: string, cwd: string, options?: NodeSkillScanOptions): string {
  const rootsKey = (options?.machineRoots ?? DEFAULT_NODE_MACHINE_SKILL_ROOTS).join('\u0001')
  const shadowedKey =
    options?.shadowedIds !== undefined && options.shadowedIds.size > 0
      ? [...options.shadowedIds].sort((a, b) => a.localeCompare(b)).join('\u0001')
      : ''
  return `${nodeId}\u0000${cwd}\u0000${rootsKey}\u0000${shadowedKey}`
}

function cloneAndRedactSkills(skills: readonly SkillSummary[], redact: (text: string) => string): SkillSummary[] {
  return skills.map((skill) => ({
    ...skill,
    name: skill.name !== '' ? redact(skill.name) : skill.id,
    ...(skill.description !== undefined && skill.description !== '' ? { description: redact(skill.description) } : {}),
    references: [...skill.references],
  }))
}

/**
 * 失效节点技能短时缓存：
 * - 不传 `host`：清空全部宿主实例缓存；
 * - 传 `host` 但不传 `coordinate`：清空该宿主全部坐标缓存（插件启停 / 重载）；
 * - 同时传 `coordinate`：精确失效匹配的 `(nodeId, cwd)`（或整节点）缓存条目（如 `load_skill` 未命中时）。
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

/** 有界读取结果：absent=常态缺失；refused=显式不可读（已脱敏、未转义）；content=同句柄稳定读到的 UTF-8 正文。 */
type NodeFileRead =
  | { kind: 'absent' }
  | { kind: 'refused'; reason: string }
  | { kind: 'content'; text: string }

function errorCodeOf(err: unknown): string {
  return err instanceof HelmxError ? err.code : 'unknown'
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 目录与缺失（含 is_directory）属常态；其余错误显式不可读。 */
function isAbsentFileError(error: { code: string; message: string }): boolean {
  return error.code === 'not_found' || error.code === 'is_directory' || error.message.includes('EISDIR')
}

/** 根目录不存在或路径中存在非目录组件属常态空，其余错误显式不可读。 */
function isAbsentRootError(error: { code: string; message: string }): boolean {
  return (
    error.code === 'not_found' ||
    error.code === 'not_directory' ||
    error.message.includes('ENOTDIR') ||
    error.message.includes('ENOENT')
  )
}

/** 工作区路径合成：按目标路径自身形状选择词法规则（POSIX 与 Windows 靶点均安全，不假设远端 home）。 */
function joinUnderCwd(cwd: string, ...segments: string[]): string {
  return pathRulesForShape(targetPathShape(cwd)).join(cwd, ...segments)
}

/** 规范化目录去重键（Windows 下按大小写折叠，避免主目录作 cwd 时重复扫描）。 */
function rootDedupKey(realRoot: string): string {
  return targetPathShape(realRoot) === 'win32' ? realRoot.toLowerCase() : realRoot
}

/** 校验 target 词法上位于 root 目录树内（防中间软链越出技能目录）。 */
function isPathWithin(target: string, root: string): boolean {
  const shape = targetPathShape(root)
  const normTarget = shape === 'win32' ? target.toLowerCase() : target
  const normRoot = shape === 'win32' ? root.toLowerCase() : root
  const sep = shape === 'win32' ? '\\' : '/'
  const prefix = normRoot.endsWith(sep) ? normRoot : normRoot + sep
  return normTarget === normRoot || normTarget.startsWith(prefix)
}

/**
 * 解析目标节点的技能发现根目录列表（按优先级从高到低排列）：
 * - local：Hub 已提供 dataDir + ~/.agents/skills，此处仅在提供 cwd 时扫描工作区 `.helmx/skills`；
 * - 远端节点：依次扫描机器级 `~/.helmx/skills`、`~/.agents/skills`，以及可选的工作区 `<cwd>/.helmx/skills`。
 */
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

/**
 * 有界安全读取节点上的一个文件（local 与 remote ExecutionEnv 共用同一契约，
 * 均在 BACKGROUND_CONTEXT 下调用；同 agents-md 的读取纪律，见模块头注释）。
 */
async function readNodeFileBounded(
  env: ExecutionEnv,
  path: string,
  redact: (text: string) => string,
  withinDir?: string,
): Promise<NodeFileRead> {
  const canonical = await env.canonicalPath(path, BACKGROUND_CONTEXT)
  if (!canonical.ok) {
    if (isAbsentFileError(canonical.error)) return { kind: 'absent' }
    return {
      kind: 'refused',
      reason: `解析 ${path} 真实路径失败（${canonical.error.code}）：${redact(canonical.error.message)}`,
    }
  }
  const realPath = canonical.value
  if (withinDir !== undefined && !isPathWithin(realPath, withinDir)) {
    return {
      kind: 'refused',
      reason: `${path} 解析到技能目录之外，拒绝读取`,
    }
  }

  const openedR = await env.openBinaryReader(realPath, { noFollow: true }, BACKGROUND_CONTEXT)
  if (!openedR.ok) {
    // 打开失败即止步：绝无 readTextFile 等无界回退。
    if (isAbsentFileError(openedR.error)) return { kind: 'absent' }
    return {
      kind: 'refused',
      reason: `读取 ${path} 失败（${openedR.error.code}）：${redact(openedR.error.message)}`,
    }
  }
  const reader = openedR.value
  try {
    const infoR = await reader.info(BACKGROUND_CONTEXT)
    if (!infoR.ok) {
      return { kind: 'refused', reason: `读取 ${path} 元信息失败（${infoR.error.code}）：${redact(infoR.error.message)}` }
    }
    const info = infoR.value
    if (info.kind !== 'file') {
      return { kind: 'refused', reason: `${path} 在打开后不是普通文件（kind=${info.kind}），拒绝读取` }
    }
    if (info.size > MAX_NODE_SKILL_FILE_BYTES) {
      return { kind: 'refused', reason: `${path} 为 ${info.size} 字节，超过 ${MAX_NODE_SKILL_FILE_BYTES} 字节读取上限，正文未读取` }
    }

    const readR = await reader.read(0, MAX_NODE_SKILL_FILE_BYTES + 1, BACKGROUND_CONTEXT)
    if (!readR.ok) {
      return { kind: 'refused', reason: `读取 ${path} 失败（${readR.error.code}）：${redact(readR.error.message)}` }
    }
    const bytes = readR.value
    if (bytes.byteLength > MAX_NODE_SKILL_FILE_BYTES) {
      return { kind: 'refused', reason: `${path} 读取到 ${bytes.byteLength} 字节，超过 ${MAX_NODE_SKILL_FILE_BYTES} 字节上限，正文不采用` }
    }

    const afterR = await reader.info(BACKGROUND_CONTEXT)
    if (!afterR.ok) {
      return { kind: 'refused', reason: `读取 ${path} 后复核元信息失败（${afterR.error.code}）：${redact(afterR.error.message)}` }
    }
    const after = afterR.value
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
      return { kind: 'refused', reason: `${path} 读取期间发生变化（size ${info.size} -> ${after.size}），不采用可能不完整的快照` }
    }
    if (bytes.byteLength !== after.size) {
      return { kind: 'refused', reason: `${path} 实读 ${bytes.byteLength} 字节与稳定大小 ${after.size} 不一致，不采用可能不完整的快照` }
    }
    return { kind: 'content', text: NODE_SKILL_UTF8_DECODER.decode(bytes) }
  } finally {
    await reader.close(BACKGROUND_CONTEXT)
  }
}

interface ReferenceScanState {
  count: number
}

/** 递归收集技能目录内 references 相对路径（listDir 不跟随软链：symlink 条目跳过且不下钻；
 * 跳过隐藏项与 node_modules / __pycache__ / dist，与 Hub collectFiles 同语义；限制最大目录深度
 * `MAX_NODE_SKILL_REFERENCE_DEPTH` 并在收集达 `MAX_NODE_SKILL_REFERENCES + 1` 时提前终止）。 */
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
    if (listed.error.code === 'not_found') return [] // 并发删除：该层按空处理
    throw new HelmxError(
      'node_skill_read_failed',
      `列出节点技能目录 ${rel === '' ? dir : `${dir}/${rel}`} 失败（${listed.error.code}）：${redact(listed.error.message)}`,
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

/**
 * 发现目标节点（机器级根 + 可选工作区 cwd `.helmx/skills/`）下的节点技能：
 * - 目录不存在属常态 → ok([])；
 * - 单条目缺 SKILL.md / frontmatter 非法 / 目录为软链 / id 非法 → 跳过该条目
 *   （第三方内容常态，与共享根 skippable 语义一致）；
 * - 节点离线（isOnline === false，不进入 executionEnv 以免阻塞在重连窗口）、
 *   宿主能力未接线、listDir / 读取的真实 IO 故障、条目数超上限 → 显式
 *   unavailable（绝不静默当作空）；
 * - frontmatter 强制剥离 managedByPlugin：节点文件不得冒充宿主受管插件技能
 *   （与机器级共享根同规则）；
 * - 结果按 id 排序（同 id 取更高优先级的节点根目录）；name/description 已脱敏。
 */
export async function scanNodeSkills(
  host: NodeSkillsHostPort,
  nodeIdInput: string | undefined,
  cwd = '',
  options?: NodeSkillScanOptions,
): Promise<NodeSkillScan> {
  try {
    return await scanNodeSkillsInner(host, nodeIdInput, cwd, options)
  } catch (err) {
    // 意外异常（宿主端口未接线 / 远端连接中途丢失等）同样显式不可用，绝不静默当作空。
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
          ...(cached.shadowedSkillIds.length > 0 ? { shadowedSkillIds: [...cached.shadowedSkillIds] } : {}),
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
        continue // 非法 id 的目录不进目录清单（第三方内容常态）
      }
      if (options?.shadowedIds?.has(entry.name)) {
        shadowedSkillIds.add(entry.name)
        continue // 已被 Hub 同名技能遮蔽：直接跳过 SKILL.md 与 references 扫描
      }
      if (byId.has(entry.name)) continue // 更高优先级节点根已提供同名技能
      toScan.push(entry.name)
    }

    type CandidateOutcome =
      | { kind: 'skip' }
      | { kind: 'ok'; summary: SkillSummary }
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
          const skillDir = joinUnderCwd(realRoot, skillName)
          const skillMdR = await readNodeFileBounded(env, joinUnderCwd(skillDir, 'SKILL.md'), redact, skillDir)
          if (skillMdR.kind === 'absent') {
            outcomes[idx] = { kind: 'skip' }
            continue // 无 SKILL.md：不是技能，常态跳过
          }
          if (skillMdR.kind === 'refused') {
            outcomes[idx] = { kind: 'unavailable', reason: `节点技能 ${skillName} 读取失败：${skillMdR.reason}` }
            stopRoot = true
            return
          }
          let frontmatter: ReturnType<typeof parseSkillFrontmatter>
          try {
            frontmatter = parseSkillFrontmatter(skillMdR.text)
          } catch {
            outcomes[idx] = { kind: 'skip' }
            continue // frontmatter 非法：跳过该条目（第三方内容，与共享根 skippable 语义一致）
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
              reason: `节点技能 ${skillName} 含 ${references.length} 个 references 文件，超过 ${MAX_NODE_SKILL_REFERENCES} 上限，未纳入该目录技能。`,
            }
            stopRoot = true
            return
          }
          outcomes[idx] = {
            kind: 'ok',
            summary: {
              id: skillName,
              name: frontmatter.name !== '' ? redact(frontmatter.name) : skillName,
              ...(frontmatter.description !== '' ? { description: redact(frontmatter.description) } : {}),
              references,
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
      byId.set(outcome.summary.id, outcome.summary)
    }
  }

  const skills = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
  const sortedShadowedIds = [...shadowedSkillIds].sort((a, b) => a.localeCompare(b))
  if (unavailableReasons.length > 0) {
    return {
      kind: 'unavailable',
      reason: unavailableReasons.join('; '),
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

/**
 * load_skill / skill_read 的节点分支：按优先级依次在节点机器级根与工作区根
 * 读取最新文件内容（无缓存；每回合发现亦同源重扫）。调用方保证该 skillId 已确认
 * 不在 Hub 任一根（同名优先级：Hub 版本永远先被解析，节点版本无法被绕过读到）。
 * - 边界校验先行：skill id 与包内相对路径共用 @helmx/protocol 契约；
 * - 节点离线 → 409 node_offline；读取 / 越界 / 超限 / 稳定性复核失败 →
 *   502 node_skill_read_failed（含脱敏诊断）；文件不存在 → 404 not_found。
 */
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
    // load_skill / skill_read 未命中时立即失效对应 (nodeId, cwd) 的扫描短缓存，使新增或删除的技能下回合立即可见。
    if (err instanceof HelmxError && err.code === 'not_found') {
      invalidateNodeSkillsCache(host, { nodeId: nodeIdInput ?? 'local', cwd })
    }
    // HelmxError（校验 / 离线 / not_found / 已显式化的读取失败）原样上抛；
    // 意外异常（宿主端口未接线 / 远端连接中途丢失等）统一显式 502，绝不伪装成功。
    if (err instanceof HelmxError) throw err
    throw new HelmxError(
      'node_skill_read_failed',
      `reading node skill '${skillId}' on node '${nodeIdInput ?? 'local'}' failed unexpectedly (${errorCodeOf(err)}): ${host.redact(errorMessageOf(err))}`,
      502,
      { skillId },
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
  try {
    assertSkillId(skillId)
  } catch (err) {
    throw new HelmxError('validation_error', `Invalid skill id: ${err instanceof Error ? err.message : String(err)}`, 400, { skillId })
  }
  let rel: string
  try {
    rel = assertSafeSkillRelativePath(path)
  } catch (err) {
    throw new HelmxError('validation_error', `Invalid skill-relative path: ${err instanceof Error ? err.message : String(err)}`, 400, { skillId, path })
  }
  const nodeId = nodeIdInput ?? 'local'
  const rawRoots = resolveNodeSkillRoots(nodeId, cwd, options)
  if (rawRoots.length === 0) {
    throw new HelmxError('not_found', `skill does not exist: ${skillId}`, 404, { skillId })
  }
  const redact = (text: string): string => host.redact(text)

  if (nodeId !== 'local') {
    try {
      if (!host.nodeIpc.isOnline(nodeId)) {
        throw new HelmxError('node_offline', `node '${nodeId}' is offline; cannot read node skill '${skillId}' (refusing to fall back to Hub skills)`, 409, { nodeId, skillId })
      }
    } catch (err) {
      if (err instanceof HelmxError) throw err
      throw new HelmxError('node_offline', `checking node '${nodeId}' online state failed (${errorCodeOf(err)}): ${redact(errorMessageOf(err))}`, 409, { nodeId, skillId })
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
      { nodeId, skillId },
    )
  }

  const seenRoots = new Set<string>()
  for (const rawRoot of rawRoots) {
    const canonical = await env.canonicalPath(rawRoot, BACKGROUND_CONTEXT)
    if (!canonical.ok) {
      if (isAbsentRootError(canonical.error)) continue
      throw new HelmxError(
        'node_skill_read_failed',
        `resolving node skill root '${rawRoot}' failed (${canonical.error.code}): ${redact(canonical.error.message)}`,
        502,
        { nodeId, skillId },
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
        `inspecting node skill '${skillId}' on node '${nodeId}' failed (${dirInfoR.error.code}): ${redact(dirInfoR.error.message)}`,
        502,
        { nodeId, skillId },
      )
    }
    if (dirInfoR.value.kind === 'symlink') {
      throw new HelmxError(
        'node_skill_read_failed',
        `reading node skill '${skillId}' on node '${nodeId}' failed: skill directory is a symlink`,
        502,
        { nodeId, skillId },
      )
    }
    if (dirInfoR.value.kind !== 'directory') continue

    const skillRealR = await env.canonicalPath(skillDir, BACKGROUND_CONTEXT)
    if (!skillRealR.ok) {
      if (isAbsentRootError(skillRealR.error)) continue
      throw new HelmxError(
        'node_skill_read_failed',
        `resolving node skill '${skillId}' on node '${nodeId}' failed (${skillRealR.error.code}): ${redact(skillRealR.error.message)}`,
        502,
        { nodeId, skillId },
      )
    }
    const skillReal = skillRealR.value
    if (!isPathWithin(skillReal, realRoot)) {
      throw new HelmxError(
        'node_skill_read_failed',
        `reading node skill '${skillId}' on node '${nodeId}' failed: skill directory resolves outside skills root`,
        502,
        { nodeId, skillId },
      )
    }

    const skillMdRead = await readNodeFileBounded(env, joinUnderCwd(skillReal, 'SKILL.md'), redact, skillReal)
    if (skillMdRead.kind === 'absent') continue
    if (skillMdRead.kind === 'refused') {
      throw new HelmxError('node_skill_read_failed', `reading node skill '${skillId}' (SKILL.md) on node '${nodeId}' failed: ${skillMdRead.reason}`, 502, {
        nodeId,
        skillId,
        path: 'SKILL.md',
      })
    }
    try {
      parseSkillFrontmatter(skillMdRead.text)
    } catch {
      continue // broken frontmatter: same skippable rule as scanNodeSkills
    }
    if (rel === 'SKILL.md') return skillMdRead.text

    const target = joinUnderCwd(skillReal, ...rel.split('/'))
    const read = await readNodeFileBounded(env, target, redact, skillReal)
    if (read.kind === 'absent') {
      // This root owns skillId: do not fall through to lower-priority roots.
      throw new HelmxError('not_found', `skill does not exist: ${skillId}`, 404, { skillId, path: rel })
    }
    if (read.kind === 'refused') {
      throw new HelmxError('node_skill_read_failed', `reading node skill '${skillId}' (${rel}) on node '${nodeId}' failed: ${read.reason}`, 502, {
        nodeId,
        skillId,
        path: rel,
      })
    }
    return read.text
  }

  throw new HelmxError('not_found', `skill does not exist: ${skillId}`, 404, { skillId, path: rel })
}

/** before_turn 显式注入段（节点技能库不可用说明；reason 已脱敏，此处统一转义）。 */
export function nodeSkillsUnavailableSection(nodeId: string | undefined, cwd: string, reason: string): { id: 'profile.node-skills-unavailable'; text: string } {
  const dir = cwd !== '' ? joinUnderCwd(cwd, ...NODE_SKILLS_RELATIVE_DIR.split('/')) : DEFAULT_NODE_MACHINE_SKILL_ROOTS.join(', ')
  return {
    id: 'profile.node-skills-unavailable',
    text: `<node_skills_unavailable dir="${escapeXml(dir)}" node="${escapeXml(nodeId ?? 'local')}">\n${escapeXml(reason)}\n</node_skills_unavailable>`,
  }
}
