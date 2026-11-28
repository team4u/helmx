/**
 * `builtin:swarm` 组合层集成测试共享环境基座。
 *
 * 将 `openSwarmEnv`、`openSwarmRuntime`、SIGKILL 造数子进程 `spawnSigkillSeeder`、
 * 按角色路由的 `setSwarmRoleResponses` 与请求元信息提取 `captureRequestMeta` 集中于此，
 * 供拆分后的多个领域集成测试文件复用；
 * `createGitTemplate` 由每个测试文件在各自的 `describe` 作用域内创建并清理，避免跨文件共享状态。
 */
import type { TestContext } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'

import { KernelRuntime } from '@helmx/kernel'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../../hub/src/app.js'
import { createMentionsPlugin } from '../../src/mentions.js'
import { createSwarmPlugin } from '../../src/swarm.js'
import { createWorkflowPlugin } from '../../src/workflow.js'
import { createWorktreePlugin } from '../../src/worktree.js'
import {
  makeFauxProvider,
  sanitizedHostEnv,
  type FauxProviderHandle,
  type GitTemplate,
} from './plugin-test-env.js'

export const WORKFLOW_ID = 'builtin:workflow'
export const WORKTREE_ID = 'builtin:worktree'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const require = createRequire(import.meta.url)

function distAndSrc(relDist: string, relSrc: string): { dist: string; src: string } {
  return {
    dist: join(REPO_ROOT, relDist),
    src: join(REPO_ROOT, relSrc),
  }
}

const DIST_DEPS = [
  join(REPO_ROOT, 'packages/protocol/dist/index.js'),
  join(REPO_ROOT, 'packages/env-io/dist/index.js'),
  join(REPO_ROOT, 'packages/kernel/dist/index.js'),
  join(REPO_ROOT, 'packages/plugin-build/dist/index.js'),
  join(REPO_ROOT, 'packages/plugins/dist/mentions.js'),
  join(REPO_ROOT, 'packages/plugins/dist/workflow.js'),
  join(REPO_ROOT, 'packages/plugins/dist/worktree.js'),
  join(REPO_ROOT, 'packages/plugins/dist/swarm.js'),
  join(REPO_ROOT, 'packages/hub/dist/app.js'),
]

/**
 * When built `dist/` outputs are present (always true under `pnpm test:integration` and after
 * `pnpm build`), SIGKILL seeders run as plain Node ESM `.mjs` with zero `tsx` transpilation.
 * If `dist/` is absent, fall back cleanly to direct `node --require tsx/preflight --import tsx`.
 */
export const SEEDER_USE_DIST = DIST_DEPS.every((p) => existsSync(p))

function resolveSeederModuleUrl(relDist: string, relSrc: string): string {
  const { dist, src } = distAndSrc(relDist, relSrc)
  return pathToFileURL(SEEDER_USE_DIST ? dist : src).href
}

export const PI_AI_FAUX_URL = import.meta.resolve('@earendil-works/pi-ai/providers/faux')
export const KERNEL_URL = resolveSeederModuleUrl('packages/kernel/dist/index.js', 'packages/kernel/src/index.ts')
export const PLUGIN_BUILD_URL = SEEDER_USE_DIST
  ? pathToFileURL(join(REPO_ROOT, 'packages/plugin-build/dist/index.js')).href
  : import.meta.resolve('@helmx/plugin-build')
export const HUB_APP_URL = resolveSeederModuleUrl('packages/hub/dist/app.js', 'packages/hub/src/app.ts')
export const MENTIONS_PLUGIN_URL = resolveSeederModuleUrl('packages/plugins/dist/mentions.js', 'packages/plugins/src/mentions.ts')
export const WORKFLOW_PLUGIN_URL = resolveSeederModuleUrl('packages/plugins/dist/workflow.js', 'packages/plugins/src/workflow.ts')
export const WORKTREE_PLUGIN_URL = resolveSeederModuleUrl('packages/plugins/dist/worktree.js', 'packages/plugins/src/worktree.ts')
export const SWARM_PLUGIN_URL = resolveSeederModuleUrl('packages/plugins/dist/swarm.js', 'packages/plugins/src/swarm.ts')

let cachedTsxLoaderArgs: readonly string[] | undefined
function tsxDirectArgs(): readonly string[] {
  if (cachedTsxLoaderArgs === undefined) {
    const preflight = require.resolve('tsx/preflight')
    const loader = pathToFileURL(require.resolve('tsx')).href
    cachedTsxLoaderArgs = ['--require', preflight, '--import', loader]
  }
  return cachedTsxLoaderArgs
}

/**
 * Generate the inline ESM bootstrap snippet for SIGKILL seeders that opens a real
 * 4-plugin Swarm runtime (`mentions`, `workflow`, `worktree`, `swarm`) with kernel Profile/Skills,
 * matching `createHelmx` without loading unrelated plugins.
 */
export function buildSwarmSeederOpenSnippet(): string {
  return `
import { KernelRuntime } from ${JSON.stringify(KERNEL_URL)}
import { createPluginBuildProvider } from ${JSON.stringify(PLUGIN_BUILD_URL)}
import { createMentionsPlugin } from ${JSON.stringify(MENTIONS_PLUGIN_URL)}
import { createWorkflowPlugin } from ${JSON.stringify(WORKFLOW_PLUGIN_URL)}
import { createWorktreePlugin } from ${JSON.stringify(WORKTREE_PLUGIN_URL)}
import { createSwarmPlugin } from ${JSON.stringify(SWARM_PLUGIN_URL)}

async function openSwarmApp({ dataDir, cwd, model, providers }) {
  const kernel = await KernelRuntime.open({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd,
    model,
    providers,
    autoResume: false,
  })
  await kernel.plugins.register(createMentionsPlugin())
  await kernel.plugins.register(createWorkflowPlugin())
  await kernel.plugins.register(createWorktreePlugin())
  await kernel.plugins.register(createSwarmPlugin())
  await kernel.start()
  return { kernel, close: () => kernel.close() }
}
`
}

export async function spawnSigkillSeeder(
  t: TestContext,
  root: string,
  scriptName: string,
  scriptBody: string,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const effectiveName = SEEDER_USE_DIST
    ? scriptName.replace(/\.mts$/i, '.mjs')
    : scriptName.replace(/\.mjs$/i, '.mts')
  const scriptPath = join(root, effectiveName)
  writeFileSync(scriptPath, scriptBody, 'utf8')
  let child: ChildProcess | undefined
  t.after(() => {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGKILL')
    }
  }, { timeout: 60_000 })
  const spawnArgs = SEEDER_USE_DIST ? [scriptPath] : [...tsxDirectArgs(), scriptPath]
  const spawnEnv = SEEDER_USE_DIST
    ? sanitizedHostEnv({ ...extraEnv })
    : sanitizedHostEnv({
        TSX_TSCONFIG_PATH: join(REPO_ROOT, 'tsconfig.dev.json'),
        ...extraEnv,
      })
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child = spawn(process.execPath, spawnArgs, {
      cwd: root,
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    const timer = setTimeout(() => {
      child?.kill('SIGKILL')
      reject(new Error(`SIGKILL seeder ${effectiveName} timed out (30s):\n${stdout}\n${stderr}`))
    }, 30_000)
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (signal === 'SIGKILL' || code === 137) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(`Seeder ${effectiveName} did not exit via SIGKILL (code=${code}, signal=${signal}):\n${stdout}\n${stderr}`))
      }
    })
  })
}

export interface SwarmRuntimeApp {
  kernel: KernelRuntime
  close(): Promise<void>
}

export interface OpenSwarmRuntimeOptions {
  dataDir: string
  cwd: string
  faux: FauxProviderHandle
  autoStart?: boolean
  hubPlatform?: () => string | undefined
  /**
   * When `true`, boots full `createHelmx` with all builtin plugins (for tests explicitly
   * asserting default `createHelmx` composition). Default `false` boots real `KernelRuntime`
   * with the 4 core Swarm-stack plugins (`mentions`, `workflow`, `worktree`, `swarm`).
   */
  fullHub?: boolean
}

export async function openSwarmRuntime(options: OpenSwarmRuntimeOptions): Promise<SwarmRuntimeApp> {
  const { dataDir, cwd, faux, autoStart = true, hubPlatform, fullHub = false } = options
  if (fullHub) {
    const app = await createHelmx({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd,
      model: 'faux/faux-1',
      providers: [faux.provider],
      autoStart,
      ...(hubPlatform !== undefined ? { hubPlatform } : {}),
    })
    if (app.kernel.plugins.get('builtin:title')?.enabled) {
      await app.kernel.plugins.setConfig('builtin:title', { autoTitle: false })
    }
    return app
  }
  const kernel = await KernelRuntime.open({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd,
    model: 'faux/faux-1',
    providers: [faux.provider],
    autoResume: false,
    ...(hubPlatform !== undefined ? { hubPlatform } : {}),
  })
  try {
    await kernel.plugins.register(createMentionsPlugin())
    await kernel.plugins.register(createWorkflowPlugin())
    await kernel.plugins.register(createWorktreePlugin())
    await kernel.plugins.register(createSwarmPlugin())
    if (autoStart) await kernel.start()
    return {
      kernel,
      close: () => kernel.close(),
    }
  } catch (err) {
    await kernel.close().catch(() => {})
    throw err
  }
}

export interface SwarmTestEnv {
  dataDir: string
  repoDir: string
  faux: FauxProviderHandle
  app: SwarmRuntimeApp
  close(): Promise<void>
}

export async function openSwarmEnv(
  root: string,
  gitTemplate: GitTemplate,
  options?: { hubPlatform?: () => string | undefined; fullHub?: boolean },
): Promise<SwarmTestEnv> {
  const dataDir = join(root, 'data')
  const repoDir = join(root, 'repo')
  gitTemplate.cloneTo(repoDir)
  const faux = makeFauxProvider({
    models: [{ id: 'faux-1' }, { id: 'faux-2' }],
  })
  const app = await openSwarmRuntime({
    dataDir,
    cwd: repoDir,
    faux,
    ...(options?.hubPlatform !== undefined ? { hubPlatform: options.hubPlatform } : {}),
    ...(options?.fullHub !== undefined ? { fullHub: options.fullHub } : {}),
  })
  faux.setResponses([])
  return {
    dataDir,
    repoDir,
    faux,
    app,
    async close() {
      await app.close()
    },
  }
}

export function captureRequestMeta(messages: readonly Record<string, unknown>[]): {
  toolNames: string[]
  sectionsById: Record<string, string>
} {
  const tools = getCurrentTools(messages as never)
  const sectionsById: Record<string, string> = {}
  for (const m of messages) {
    if (m['role'] === 'system' && typeof m['sections'] === 'object' && m['sections'] !== null) {
      for (const [k, v] of Object.entries(m['sections'] as Record<string, unknown>)) {
        if (typeof v === 'string') sectionsById[k] = v
      }
    }
  }
  return {
    toolNames: tools.map((t) => t.name),
    sectionsById,
  }
}

type FauxStep = NonNullable<Parameters<FauxProviderHandle['setResponses']>[0]>[number]
type FauxFactoryArgs = Parameters<Extract<FauxStep, (...args: never[]) => unknown>>

export function setSwarmRoleResponses(
  faux: FauxProviderHandle,
  queues: Record<string, FauxStep[]>,
  maxCalls = 32,
): void {
  const cursors = new Map<string, number>()
  const dispatch: FauxStep = (async (ctx: FauxFactoryArgs[0], ...rest: [FauxFactoryArgs[1], FauxFactoryArgs[2], FauxFactoryArgs[3]]) => {
    const groupSec =
      captureRequestMeta(ctx.messages as unknown as Record<string, unknown>[]).sectionsById['swarm.active_group'] ?? ''
    const workerMatch = /role="worker" name="([^"]+)"/.exec(groupSec)
    const roleKey = workerMatch ? workerMatch[1]! : groupSec.includes('role="coordinator"') ? 'coordinator' : 'other'
    const list = queues[roleKey] ?? queues['*'] ?? []
    const idx = cursors.get(roleKey) ?? 0
    cursors.set(roleKey, idx + 1)
    const step = list[idx]
    if (step === undefined) {
      throw new Error(`Unexpected faux request for swarm role "${roleKey}" at index ${idx}`)
    }
    if (typeof step === 'function') {
      return await step(ctx, ...rest)
    }
    return step
  }) as FauxStep
  faux.setResponses(Array.from({ length: maxCalls }, () => dispatch))
}

export function isSettledStatus(status: string): boolean {
  return status === 'idle' || status === 'done'
}
