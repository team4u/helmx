/**
 * 内置插件静态资产目录解析（src / dist 双运行形态共用）。
 *
 * Why：tsx 源码直跑时插件入口位于 <pkg>/src/，构建产物运行时位于 <pkg>/dist/
 * （client 等资产目录由 scripts/copy-plugin-clients.mjs 随 dist 复制）；按
 * 「与入口同目录优先、回退 <pkg>/src/」定位，两种形态都能找到资产。本模块与
 * 各插件入口文件同层（src/ 或 dist/），以自身位置推导与以调用方入口推导等价。
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmxError, PREBUILT_CLIENT_DIR_NAME, type PluginSkillAsset } from '@helmx/protocol'

export interface PluginClientAssets {
  clientRoot?: string
  prebuiltClientDir?: string
}

export interface ManagedSkillAssetSpec {
  pluginId: string
  skillId: string
  /** Relative directory under `packages/plugins/src/` (e.g. `'workflow/skill'` or `'swarm/assets/swarm'`). */
  relativeDir: string
  missingErrorCode: string
  /** Reference filenames under `<relativeDir>/references/<name>`. */
  references?: readonly string[]
  /** Optional content transform applied to `SKILL.md` and every reference file. */
  transform?: (content: string) => string
}

/**
 * Resolve a built-in plugin static asset directory across both tsx-source (`src/`) and built (`dist/`)
 * layouts, failing explicitly with `missingErrorCode` if neither candidate exists.
 */
export function resolvePluginAssetDir(
  pluginId: string,
  relativeSubdir: string,
  missingErrorCode: string,
): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const segments = relativeSubdir.split('/').filter((segment) => segment.length > 0)
  const local = join(here, ...segments)
  if (existsSync(local)) return local

  const srcFallback = join(dirname(here), 'src', ...segments)
  if (existsSync(srcFallback)) return srcFallback

  throw new HelmxError(
    missingErrorCode,
    `Built-in plugin ${pluginId} cannot find asset directory '${relativeSubdir}' (tried: "${local}", "${srcFallback}")`,
    500,
    { pluginId, paths: [local, srcFallback] },
  )
}

/**
 * Load a built-in managed skill asset (`SKILL.md` + optional `references/*.md`) from disk.
 */
export function loadManagedSkillAsset(spec: ManagedSkillAssetSpec): PluginSkillAsset {
  const dir = resolvePluginAssetDir(spec.pluginId, spec.relativeDir, spec.missingErrorCode)
  const apply = (raw: string): string => (spec.transform !== undefined ? spec.transform(raw) : raw)
  const skillMd = apply(readFileSync(join(dir, 'SKILL.md'), 'utf-8'))
  const references: Record<string, string> = {}
  for (const name of spec.references ?? []) {
    references[name] = apply(readFileSync(join(dir, 'references', name), 'utf-8'))
  }
  return {
    id: spec.skillId,
    skillMd,
    references,
  }
}

function entryExistsOnDisk(targetPath: string): boolean {
  try {
    lstatSync(targetPath)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    return true
  }
}

/**
 * 解析内置插件前端双轨资产目录：
 * - 优先探测同层的 `<pkg>/src|dist/<pluginDir>/dist-client`（存在则作为 `prebuiltClientDir`，零 runtime 编译/npm 依赖）；
 * - 同时定位 `clientRoot`（优先 `<pkg>/src|dist/<pluginDir>/client`，缺失回退 `<pkg>/src/<pluginDir>/client`）供开发态即时编译或检验；
 * - 两轨都不存在按调用方给定的错误码显式报错（绝不静默降级）。
 */
export function resolvePluginClientAssets(
  pluginId: string,
  pluginDir: string,
  missingErrorCode: string,
): PluginClientAssets {
  const here = dirname(fileURLToPath(import.meta.url))
  const localDistClient = join(here, pluginDir, PREBUILT_CLIENT_DIR_NAME)
  const prebuiltClientDir = entryExistsOnDisk(localDistClient) ? localDistClient : undefined

  const localClient = join(here, pluginDir, 'client')
  const srcFallback = join(dirname(here), 'src', pluginDir, 'client')
  const clientRoot = existsSync(localClient)
    ? localClient
    : existsSync(srcFallback)
      ? srcFallback
      : undefined

  if (clientRoot === undefined && prebuiltClientDir === undefined) {
    throw new HelmxError(
      missingErrorCode,
      `内置插件 ${pluginId} 找不到 client 或 dist-client 组件目录（期望 ${localDistClient}、${localClient} 或 ${srcFallback}）`,
      500,
    )
  }

  return {
    ...(clientRoot !== undefined ? { clientRoot } : {}),
    ...(prebuiltClientDir !== undefined ? { prebuiltClientDir } : {}),
  }
}

