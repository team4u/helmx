/**
 * `builtin:swarm` 组合层集成测试共享环境基座。
 *
 * 将 `openSwarmEnv`、SIGKILL 造数子进程 `spawnSigkillSeeder`、按角色路由的 `setSwarmRoleResponses`
 * 与请求元信息提取 `captureRequestMeta` 集中于此，供拆分后的多个领域集成测试文件复用；
 * `createGitTemplate` 由每个测试文件在各自的 `describe` 作用域内创建并清理，避免跨文件共享状态。
 */
import type { TestContext } from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'

import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../../hub/src/app.js'
import {
  makeFauxProvider,
  sanitizedHostEnv,
  type FauxProviderHandle,
  type GitTemplate,
} from './plugin-test-env.js'

export const WORKFLOW_ID = 'builtin:workflow'
export const WORKTREE_ID = 'builtin:worktree'

const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli')
const KERNEL_DIR = new URL('../../../kernel/', import.meta.url).pathname
export const PI_AI_FAUX_URL = pathToFileURL(join(KERNEL_DIR, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js')).href
export const HUB_APP_URL = pathToFileURL(new URL('../../../hub/src/app.ts', import.meta.url).pathname).href
export const PLUGIN_BUILD_URL = import.meta.resolve('@helmx/plugin-build')

export async function spawnSigkillSeeder(
  t: TestContext,
  root: string,
  scriptName: string,
  scriptBody: string,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
  const scriptPath = join(root, scriptName)
  writeFileSync(scriptPath, scriptBody, 'utf8')
  let child: ChildProcess | undefined
  t.after(() => {
    if (child && child.exitCode === null && !child.killed) {
      child.kill('SIGKILL')
    }
  })
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    child = spawn(process.execPath, [TSX_CLI, scriptPath], {
      cwd: root,
      env: sanitizedHostEnv({ ...extraEnv }),
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
      reject(new Error(`SIGKILL seeder ${scriptName} timed out (30s):\n${stdout}\n${stderr}`))
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
        reject(new Error(`Seeder ${scriptName} did not exit via SIGKILL (code=${code}, signal=${signal}):\n${stdout}\n${stderr}`))
      }
    })
  })
}

export interface SwarmTestEnv {
  dataDir: string
  repoDir: string
  faux: FauxProviderHandle
  app: Awaited<ReturnType<typeof createHelmx>>
  close(): Promise<void>
}

export async function openSwarmEnv(root: string, gitTemplate: GitTemplate): Promise<SwarmTestEnv> {
  const dataDir = join(root, 'data')
  const repoDir = join(root, 'repo')
  gitTemplate.cloneTo(repoDir)
  const faux = makeFauxProvider({
    models: [{ id: 'faux-1' }, { id: 'faux-2' }],
  })
  const app = await createHelmx({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: repoDir,
    model: 'faux/faux-1',
    providers: [faux.provider],
  })
  if (app.kernel.plugins.get('builtin:title')?.enabled) {
    await app.kernel.plugins.setConfig('builtin:title', { autoTitle: false })
  }
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
