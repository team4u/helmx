/**
 * client.tsx 轨道内核测试：真实 esbuild 编译 + PluginHost getClientModule +
 * HTTP GET /api/plugins/:id/client.mjs 端点。
 *
 * 覆盖：真实编译产物（external 重写为 __helmx_shared_*）、缓存命中（同 hash 不重编）、
 * 依赖源变化缓存失效、路径逃逸（../ 与符号链接）拒绝、停用插件拒绝提供、
 * HTTP 鉴权边界（无 token 401）、模块缺失/编译错误显式报错（无静默降级）、
 * 注册边界（client 引用无 clientRoot 拒绝；module 形状非法拒绝）。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { test, before, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import {
  AuthService,
  createHubHandler,
  CredentialService,
  doctorPluginDir,
  loadExternalPlugins,
  PluginHost,
  ProfileService,
  ProviderService,
  SkillService,
  type HttpEventHub,
  type KernelHttpTarget,
  type PluginHostBackend,
} from '@helmx/kernel'
import { createMermaidPlugin } from '../src/mermaid.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import {
  buildPluginClientBundleDir,
  clearClientCompilerMemoryCache,
  compilePluginClientModule,
  createPluginBuildProvider,
  installNodeChunkBridge,
  resolveDefaultBuiltinClientCacheDir,
  safeDirName,
  safeFileName,
} from '@helmx/plugin-build'
import {
  HelmxError,
  PREBUILT_CLIENT_DIR_NAME,
  PREBUILT_CLIENT_MANIFEST_FILE,
  prebuiltChunkFileName,
  type ConversationSummary,
} from '@helmx/protocol'
import { createMermaidLoader } from '../src/mermaid/client/mermaid-loader.js'
import { MemoryDocStore, deferred, makeConversationSummary, waitFor } from './helpers/plugin-test-env.js'

// ---------------------------------------------------------------------------
// 测试基座（真实临时目录 + 真实 services + 真实 PluginHost）
// ---------------------------------------------------------------------------

let dataDir: string
let pluginHost: PluginHost
let token: string | undefined
let procToken: { token: string; dispose(): void } | undefined

class TestEventHub implements HttpEventHub {
  response(): Response {
    return new Response(null, { status: 204 })
  }
}

const makeConversation = (id: number): ConversationSummary => makeConversationSummary({ id, profileId: 'default' })

function makeBackend(): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    updateConversation: async (id) => makeConversation(id),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    onEvent: () => () => {},
    abortConversation: async () => {},
    getConversationOwnership(): 'helmx' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmxError('unsupported', '本 fixture 不执行节点命令', 501) },
    emitEvent: () => {},
  }
}

function makeKernel(auth: AuthService): KernelHttpTarget {
  const kernel: KernelHttpTarget = {
    dataDir,
    auth,
    events: new TestEventHub(),
    profiles: new ProfileService(join(dataDir, 'profiles.json')),
    skills: new SkillService(dataDir),
    credentials: new CredentialService(dataDir),
    providers: new ProviderService(dataDir),
    artifacts: undefined as never,
    plugins: pluginHost,
    conversations: {
      listConversations: () => [],
      getConversationDetail: async (id: number) => {
        throw new HelmxError('not_found', `会话不存在: ${id}`, 404)
      },
      createConversation: async () => makeConversation(1),
      updateConversation: async (id: number) => makeConversation(id),
      deleteConversation: async () => {},
      deleteConversations: async (ids: readonly number[]) => ({ deleted: [...ids], failures: [] }),
      submitInput: async () => ({ submissionId: 'sub' }),
      waitForInput: async (id: number) => ({ conversationId: id, submissionId: 'sub', text: '', entry: { id: 'e', kind: 'pi.assistant' } }),
      abortConversation: async () => {},
      resetConversation: async (id: number) => makeConversation(id),
      compactConversation: async (id: number) => ({ taskId: 1, conversation: makeConversation(id) }),
      forkConversation: async (id: number) => makeConversation(id + 100),
      search: async () => [],
    },
    asks: {
      listAsks: () => [],
      answerAsk: async () => ({}) as never,
      cancelAsk: async () => ({}) as never,
    },
    models: {
      listModels: async () => ({ models: [], thinkingLevels: {} }),
      listModelProviders: () => [],
    },
    nodes: {
      listNodes: async () => [],
      issueNodeToken: async () => ({ nodeId: 'local', token: 'local:t', createdAt: 1 }),
      removeNode: async () => {},
      execEnv: async () => ({ ok: true, exitCode: 0, output: '', timedOut: false }),
    },
  }
  return kernel
}


async function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  opts?: { auth?: boolean; headers?: Record<string, string> },
): Promise<{ status: number; text: string; buffer: Buffer; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) }
  if (opts?.auth !== false && token !== undefined) headers.authorization = `Bearer ${token}`
  const res = await handler(new Request(`http://127.0.0.1:3202${path}`, { method, headers }))
  const arrayBuf = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuf)
  const text = buffer.toString('utf8')
  return { status: res.status, text, buffer, headers: res.headers }
}

/** 真实 clientRoot 夹具：client.tsx（依赖本地 helper.tsx + react external）。 */
let clientRoot: string
let handler: (req: Request) => Promise<Response>

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'helmx-plugin-client-'))
  clientRoot = join(dataDir, 'fixture-plugin-src')
  await mkdir(clientRoot, { recursive: true })
  await writeFile(
    join(clientRoot, 'helper.tsx'),
    `import { useState } from 'react'\nexport function useCounter(): [number, () => void] {\n  const [n, setN] = useState(0)\n  return [n, () => setN(n + 1)]\n}\n`,
  )
  await writeFile(
    join(clientRoot, 'client.tsx'),
    `import { useCounter } from './helper'\nimport { useState } from 'react'\n\nexport function Panel(props: { title: string }) {\n  const [n, bump] = useCounter()\n  const [label] = useState(props.title)\n  return label + ':' + n\n}\n`,
  )

  pluginHost = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: makeBackend(),
    docs: new MemoryDocStore(),
  })
  await pluginHost.register({
    id: 'test:client-fixture',
    name: 'client 夹具插件',
    clientRoot,
    definePlugin(ctx) {
      ctx.ui.screen({ id: 'panel', label: '夹具面板', client: { module: 'client.tsx', export: 'Panel' } })
    },
  })
  await pluginHost.register(createMermaidPlugin())
  // Pre-warm the two extra mermaid entrypoints in parallel so cold runs overlap esbuild work
  // while warm runs reuse the shared content-hash-verified builtin cache.
  await Promise.all([
    pluginHost.getClientModule('builtin:mermaid', 'mermaid-loader.ts'),
    pluginHost.getClientModule('builtin:mermaid', 'MermaidPreviewModal.tsx'),
  ])

  const authService = new AuthService(dataDir)
  const kernel = makeKernel(authService)
  handler = createHubHandler(kernel)
  const createdToken = authService.createProcessToken()
  procToken = createdToken
  token = createdToken.token
}, { timeout: 60_000 })

after(async () => {
  procToken?.dispose()
  await rm(dataDir, { recursive: true, force: true })
}, { timeout: 60_000 })

// ---------------------------------------------------------------------------
// 编译与缓存
// ---------------------------------------------------------------------------

test('真实编译：产物为 ESM，react external 重写为 __helmx_shared_* 命名空间', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  assert.ok(result.code.length > 0)
  assert.match(result.code, /__helmx_shared_react/)
  // bundle 内联本地依赖（helper 不再是独立 import）
  assert.doesNotMatch(result.code, /['"]\.\/helper['"]/)
  // 绝不打包第二份 React（external 生效）
  assert.doesNotMatch(result.code, /useState\s*\(\)\s*\{/)
  assert.match(result.contentHash, /^[0-9a-f]{24}$/)
})

test('缓存命中：同源重复获取 contentHash 一致且产物已落盘', { timeout: 60_000 }, async () => {
  const first = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  const second = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  assert.equal(first.contentHash, second.contentHash)
  assert.equal(first.code, second.code)
})

test('依赖源变化：本地依赖 helper.tsx 变更后 hash 变化（重新编译）', { timeout: 60_000 }, async () => {
  const before = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  await writeFile(
    join(clientRoot, 'helper.tsx'),
    `import { useState } from 'react'\nexport function useCounter(): [number, () => void] {\n  const [n, setN] = useState(10)\n  return [n, () => setN(n + 2)]\n}\n`,
  )
  const after = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  assert.notEqual(before.contentHash, after.contentHash)
  assert.notEqual(before.code, after.code)
})

// ---------------------------------------------------------------------------
// 路径逃逸与形状拒绝
// ---------------------------------------------------------------------------

test('路径逃逸拒绝：.. 越根 / 绝对路径 / 非 ts 扩展', { timeout: 60_000 }, async () => {
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', '../secrets.ts'),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
  )
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', '/etc/passwd.ts'),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
  )
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', 'client.js'),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
  )
})

test('符号链接逃逸拒绝：clientRoot 内符号链接指向根外文件', { timeout: 60_000 }, async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'helmx-plugin-client-outside-'))
  try {
    const outsideFile = join(outsideDir, 'evil.ts')
    await writeFile(outsideFile, 'export const x = 1\n')
    const linkPath = join(clientRoot, 'linked.ts')
    await symlink(outsideFile, linkPath)
    await assert.rejects(
      pluginHost.getClientModule('test:client-fixture', 'linked.ts'),
      (err: unknown) => err instanceof HelmxError && (err.code === 'client_module_out_of_root' || err.code === 'invalid_client_module'),
    )
  } finally {
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('模块不存在：显式 400 client_root_invalid，无静默空产物', { timeout: 60_000 }, async () => {
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', 'missing.ts'),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_root_invalid',
  )
})

// ---------------------------------------------------------------------------
// 生命周期与注册边界
// ---------------------------------------------------------------------------

test('停用插件拒绝提供 client 模块（409）', { timeout: 60_000 }, async () => {
  await pluginHost.disable('test:client-fixture')
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', 'client.tsx'),
    (err: unknown) => err instanceof HelmxError && err.code === 'plugin_client_unavailable' && err.status === 409,
  )
  await pluginHost.enable('test:client-fixture')
  const back = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  assert.ok(back.code.length > 0)
})

test('注册边界：client 引用但插件无 clientRoot 显式拒绝', { timeout: 60_000 }, async () => {
  await assert.rejects(
    pluginHost.register({
      id: 'test:no-root',
      definePlugin(ctx) {
        ctx.ui.screen({ id: 's', label: 's', client: { module: 'client.tsx', export: 'X' } })
      },
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_ui_spec',
  )
})

test('注册边界：client.module 形状非法（.. / 绝对路径 / 扩展名）拒绝', { timeout: 60_000 }, async () => {
  for (const bad of ['../x.ts', '/abs.ts', 'mod.js', 'a/../b.tsx']) {
    await assert.rejects(
      pluginHost.register({
        id: `test:bad-module-${bad.replace(/[^a-z]/gi, '_')}`,
        clientRoot,
        definePlugin(ctx) {
          ctx.ui.screen({ id: 's', label: 's', client: { module: bad, export: 'X' } })
        },
      }),
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
    )
  }
})

test('注册边界：clientRoot 含 .. 或相对路径的插件定义拒绝', { timeout: 60_000 }, async () => {
  await assert.rejects(
    pluginHost.register({
      id: 'test:bad-root-1',
      clientRoot: 'relative/dir',
      definePlugin() {},
    }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_definition',
  )
})

// ---------------------------------------------------------------------------
// HTTP 端点
// ---------------------------------------------------------------------------

test('HTTP：无 token 401；有效 token 200 返回 JS 与 hash 头', { timeout: 60_000 }, async () => {
  const unauth = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx', { auth: false })
  assert.equal(unauth.status, 401)

  const ok = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type') ?? '', /text\/javascript/)
  assert.match(ok.headers.get('x-helmx-client-hash') ?? '', /^[0-9a-f]{24}$/)
  assert.match(ok.text, /__helmx_shared_react/)
})

test('HTTP：If-None-Match 命中 contentHash 时返回 304 Not Modified 且无 body', { timeout: 60_000 }, async () => {
  const first = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('vary'), 'Accept-Encoding')
  const hash = first.headers.get('x-helmx-client-hash')!
  const etag = first.headers.get('etag')!
  assert.ok(hash)
  assert.equal(etag, `"${hash}"`)

  // 强 ETag 匹配返回 304；裸 hash 不再返回 304（仅认规范 ETag）
  const res304 = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx', {
    headers: { 'if-none-match': etag },
  })
  assert.equal(res304.status, 304)
  assert.equal(res304.text, '')
  assert.equal(res304.headers.get('etag'), etag)
  assert.equal(res304.headers.get('x-helmx-client-hash'), hash)
  assert.equal(res304.headers.get('vary'), 'Accept-Encoding')

  const res200RawHash = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx', {
    headers: { 'if-none-match': hash },
  })
  assert.equal(res200RawHash.status, 200)
})

test('HTTP：Accept-Encoding: gzip 返回 Content-Encoding: gzip 且解压后与原产物一致', { timeout: 60_000 }, async () => {
  const plain = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
  assert.equal(plain.status, 200)

  const gzRes = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx', {
    headers: { 'accept-encoding': 'gzip, deflate, br' },
  })
  assert.equal(gzRes.status, 200)
  assert.equal(gzRes.headers.get('content-encoding'), 'gzip')
  const { gunzipSync } = await import('node:zlib')
  const decompressed = gunzipSync(gzRes.buffer).toString('utf8')
  assert.equal(decompressed, plain.text)
})

test('HTTP：HEAD 请求返回 200 与 headers 但无 body', { timeout: 60_000 }, async () => {
  const head = await call(handler, 'HEAD', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
  assert.match(head.headers.get('content-type') ?? '', /text\/javascript/)
  assert.match(head.headers.get('x-helmx-client-hash') ?? '', /^[0-9a-f]{24}$/)
})

test('HTTP：缺 module 参数 400；越根 module 400/404 错误信封', { timeout: 60_000 }, async () => {
  const noModule = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs')
  assert.equal(noModule.status, 400)

  const escape = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=..%2Fsecrets.ts')
  assert.equal(escape.status, 400)
})

test('HTTP：停用插件返回 409 错误信封（不返回 JS）', { timeout: 60_000 }, async () => {
  await pluginHost.disable('test:client-fixture')
  try {
    const res = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
    assert.equal(res.status, 409)
    const body = JSON.parse(res.text) as { error?: { code?: string } }
    assert.equal(body.error?.code, 'plugin_client_unavailable')
  } finally {
    await pluginHost.enable('test:client-fixture')
  }
})

test('HTTP：编译错误（语法违约源）显式 422 诊断，无静默降级', { timeout: 60_000 }, async () => {
  await writeFile(join(clientRoot, 'broken.ts'), 'export const x = (((\n')
  try {
    const res = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=broken.ts')
    assert.equal(res.status, 422)
    const body = JSON.parse(res.text) as { error?: { code?: string; message?: string } }
    assert.equal(body.error?.code, 'client_compile_failed')
    assert.match(body.error?.message ?? '', /broken\.ts/)
  } finally {
    await rm(join(clientRoot, 'broken.ts'), { force: true })
  }
})

test('HTTP：未声明 clientRoot 的插件 404', { timeout: 60_000 }, async () => {
  await pluginHost.register({ id: 'test:no-client', definePlugin() {} })
  const res = await call(handler, 'GET', '/api/plugins/test%3Ano-client/client.mjs?module=client.tsx')
  assert.equal(res.status, 404)
  const body = JSON.parse(res.text) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'plugin_client_unavailable')
})

test('export * from 本地依赖：依赖源变化后 hash 变化（旧实现正则扫描漏 export-from）', { timeout: 60_000 }, async () => {
  await writeFile(join(clientRoot, 're-export.ts'), "export * from './values'\nexport const local = 1\n")
  await writeFile(join(clientRoot, 'values.ts'), 'export const fromValues = 1\n')
  await writeFile(join(clientRoot, 'entry-export-star.ts'), "export { local } from './re-export'\n")
  try {
    const before = await pluginHost.getClientModule('test:client-fixture', 'entry-export-star.ts')
    // values.ts 只经 export * 链引入（自身无直接 import 语句）；改它必须失效缓存。
    // 注：未消费符号会被 esbuild tree-shake，产物代码可能相同——hash 必须变化。
    await writeFile(join(clientRoot, 'values.ts'), 'export const fromValues = 2\n')
    const after = await pluginHost.getClientModule('test:client-fixture', 'entry-export-star.ts')
    assert.notEqual(before.contentHash, after.contentHash)
  } finally {
    await rm(join(clientRoot, 're-export.ts'), { force: true })
    await rm(join(clientRoot, 'values.ts'), { force: true })
    await rm(join(clientRoot, 'entry-export-star.ts'), { force: true })
  }
})

test('编译失败后可重试：失败不缓存，修复源后重新编译成功', { timeout: 60_000 }, async () => {
  await writeFile(join(clientRoot, 'retry.ts'), 'export const x = (((\n')
  try {
    await assert.rejects(pluginHost.getClientModule('test:client-fixture', 'retry.ts'))
    await writeFile(join(clientRoot, 'retry.ts'), 'export const x = 1\n')
    const ok = await pluginHost.getClientModule('test:client-fixture', 'retry.ts')
    assert.ok(ok.code.length > 0)
  } finally {
    await rm(join(clientRoot, 'retry.ts'), { force: true })
  }
})

test('迟到编译拒绝：编译期间插件停用，产物不得返回成功（epoch 守卫）', { timeout: 60_000 }, async () => {
  // 先破坏依赖源使编译足够慢不可行（esbuild 很快）——改用直连 host：并发触发编译与 disable
  await writeFile(
    join(clientRoot, 'late.ts'),
    "import { useCounter } from './helper'\nexport const v = 1\n",
  )
  try {
    const compiling = pluginHost.getClientModule('test:client-fixture', 'late.ts')
    const disabling = pluginHost.disable('test:client-fixture')
    const [lateResult] = await Promise.allSettled([compiling])
    await disabling
    if (lateResult.status === 'fulfilled') {
      // 竞态窗口未命中（编译先完成）：此时插件已停用，再次获取必须拒绝
      // 且 fulfill 本身发生在 disable 前不算缺陷——验证停用后拒绝即可
    } else {
      assert.equal((lateResult.reason as HelmxError).code, 'plugin_client_unavailable')
    }
    await assert.rejects(
      pluginHost.getClientModule('test:client-fixture', 'late.ts'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_client_unavailable',
    )
  } finally {
    await pluginHost.enable('test:client-fixture')
    await rm(join(clientRoot, 'late.ts'), { force: true })
  }
})

test('clientRoot 跨平台绝对路径：Windows 盘符合法、foo..bar 目录名不再误拒', { timeout: 60_000 }, async () => {
  // 目录名含字面 ..（合法目录名）不应误拒；旧实现 clientRoot.includes('..') 会拒绝
  const dotDotDir = join(dataDir, 'foo..bar')
  await mkdir(dotDotDir, { recursive: true })
  await pluginHost.register({
    id: 'test:dotdot-root',
    clientRoot: dotDotDir,
    definePlugin() {},
  })
  // Windows 盘符形态在注册层合法（非 POSIX startsWith('/') 误拒）；目录存在性由编译期校验
  await pluginHost.register({
    id: 'test:win-root',
    clientRoot: 'C:\\helmx\\plugins\\demo\\client',
    definePlugin() {},
  })
  // 相对路径仍拒绝
  await assert.rejects(
    pluginHost.register({ id: 'test:rel-root', clientRoot: 'relative/dir', definePlugin() {} }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_definition',
  )
  // 整段 .. 仍拒绝（真正的越根；join 会归一化掉 ..，故用字面量路径保留 .. 段）
  await assert.rejects(
    pluginHost.register({ id: 'test:seg-root', clientRoot: `${dataDir}/a/../b`, definePlugin() {} }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_definition',
  )
})

test('代码分割与共享 Chunk：builtin:mermaid 主包不内联核心库且产出异步 chunk，体积大幅收敛', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
  assert.ok(result.code.length > 0, '主包代码不能为空')
  assert.ok(result.gzipped, '必须产出 gzipped 字节')

  // 1. builtin:mermaid 主包不内联 mermaid 核心库，gzip 体积收敛至 < 20 KB
  assert.ok(
    result.gzipped.length < 20 * 1024,
    `主包 gzip 体积 (${result.gzipped.length} 字节) 必须 < 20 KB`,
  )
  assert.doesNotMatch(result.code, /mermaidAPI|getRegisteredDiagramsMetadata/, '主包不得直接内联 mermaid 核心库')
  assert.match(result.code, /__helmx_import_chunk/, '主包必须通过 __helmx_import_chunk 按需加载 mermaid')
  assert.deepEqual(
    result.exports.filter((name) => name !== '__helmxClientCss'),
    ['MermaidCodeBlock'],
    'index.tsx 只导出 MermaidCodeBlock 组件（Fast Refresh 契约）',
  )

  const chunks = result.chunks ?? {}
  const chunkEntries = Object.entries(chunks)
  assert.ok(chunkEntries.length > 0, 'mermaid 必须产出异步 chunks')

  // 2. mermaid.esm.min 与 flowDiagram / pieDiagram 异步 chunk 存在且体积受控
  const coreEntry = chunkEntries.find(([name]) => name.includes('mermaid.esm.min'))
  const flowEntry = chunkEntries.find(([name]) => name.includes('flowDiagram'))
  const pieEntry = chunkEntries.find(([name]) => name.includes('pieDiagram'))
  assert.ok(coreEntry, '产物中必须包含 mermaid.esm.min 异步 chunk')
  assert.ok(flowEntry, '产物中必须包含 flowDiagram 异步 chunk')
  assert.ok(pieEntry, '产物中必须包含 pieDiagram 异步 chunk')

  assert.ok(
    flowEntry[1].gzipped && flowEntry[1].gzipped.length < 35 * 1024,
    `flowDiagram chunk gzip (${flowEntry[1].gzipped?.length} 字节) 必须 < 35 KB`,
  )
  assert.ok(
    pieEntry[1].gzipped && pieEntry[1].gzipped.length < 35 * 1024,
    `pieDiagram chunk gzip (${pieEntry[1].gzipped?.length} 字节) 必须 < 35 KB`,
  )

  // 3. 所有编译产物（主包 + 全部异步 chunk）gzip 总和 < 1.8 MB（证明无重复内联膨胀）
  let totalGzipped = result.gzipped.length
  for (const [, chunk] of chunkEntries) {
    totalGzipped += chunk.gzipped?.length ?? 0
  }
  assert.ok(
    totalGzipped < 1.8 * 1024 * 1024,
    `所有编译产物 gzip 总和 (${totalGzipped} 字节) 必须 < 1.8 MB`,
  )
})

test('loadMermaid 单例与并发去重、失败清除缓存后可重试', { timeout: 60_000 }, async () => {
  const fakeMermaid = {
    initialize: () => {},
    render: async () => ({ svg: '<svg></svg>' }),
  } as unknown as typeof import('mermaid').default

  // 1. 并发去重：在途请求共享同一 Promise，解析后后续复用
  const pendingImport = deferred<{ default: typeof fakeMermaid }>()
  let calls = 0
  const loader1 = createMermaidLoader(() => {
    calls += 1
    return pendingImport.promise
  })
  const p1 = loader1.load()
  const p2 = loader1.load()
  const p3 = loader1.load()
  assert.equal(calls, 1, '并发 load() 只能触发一次底层 import')
  assert.ok(p1 === p2 && p2 === p3, '并发 load() 必须返回同一 Promise 实例')

  pendingImport.resolve({ default: fakeMermaid })
  const [m1, m2, m3] = await Promise.all([p1, p2, p3])
  assert.ok(m1 === fakeMermaid && m2 === fakeMermaid && m3 === fakeMermaid)
  assert.ok((await loader1.load()) === fakeMermaid)
  assert.equal(calls, 1, '已成功后再次 load() 不得重复 import')

  // 2. 异步失败后清空缓存：第二次重试重新触发 import 并恢复成功
  let attempt = 0
  const loader2 = createMermaidLoader(async () => {
    attempt += 1
    if (attempt === 1) throw new Error('chunk fetch timeout')
    return { default: fakeMermaid }
  })
  const [r1, r2] = await Promise.allSettled([loader2.load(), loader2.load()])
  assert.equal(r1.status, 'rejected')
  assert.equal(r2.status, 'rejected')
  assert.match((r1 as PromiseRejectedResult).reason.message, /chunk fetch timeout/)
  assert.equal(attempt, 1, '首次失败的并发调用共享同一 attempt')

  const [ok1, ok2] = await Promise.all([loader2.load(), loader2.load()])
  assert.equal(attempt, 2, '失败后清空缓存，重试必须重新触发 import（且并发重试同样去重）')
  assert.ok(ok1 === fakeMermaid && ok2 === fakeMermaid)

  // 3. 同步抛错与非法模块形状也必须清空缓存以便重试
  let syncAttempt = 0
  const loader3 = createMermaidLoader(() => {
    syncAttempt += 1
    if (syncAttempt === 1) throw new Error('sync load failure')
    if (syncAttempt === 2) return Promise.resolve({} as never)
    return Promise.resolve(fakeMermaid)
  })
  await assert.rejects(() => loader3.load(), /sync load failure/)
  await assert.rejects(() => loader3.load(), /missing initialize\/render/)
  assert.ok((await loader3.load()) === fakeMermaid)
  assert.equal(syncAttempt, 3)
})

test('HTTP Chunk 端点：200/gzip/immutable 缓存、304 协商、400 形状非法、409 过时 hash、404 缺失与 409 停用防护', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
  const contentHash = result.contentHash
  const chunks = result.chunks ?? {}
  const flowChunkName = Object.keys(chunks).find((k) => k.includes('flowDiagram'))!
  assert.ok(flowChunkName)

  // 1. 有效 chunk 请求：200 OK，immutable 缓存头，gzip 内容
  const res200 = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=${contentHash}`,
    { headers: { 'accept-encoding': 'gzip' } },
  )
  assert.equal(res200.status, 200)
  assert.equal(res200.headers.get('content-encoding'), 'gzip')
  assert.equal(res200.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.equal(res200.headers.get('etag'), `"${contentHash}:${flowChunkName}"`)
  assert.equal(res200.headers.get('x-helmx-client-hash'), contentHash)

  const flowChunk = chunks[flowChunkName]
  assert.ok(flowChunk)
  const decompressed = gunzipSync(res200.buffer).toString('utf8')
  assert.equal(decompressed, flowChunk.code)

  // 2. 304 协商缓存命中
  const res304 = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=${contentHash}`,
    { headers: { 'if-none-match': `"${contentHash}:${flowChunkName}"` } },
  )
  assert.equal(res304.status, 304)
  assert.equal(res304.text, '')
  assert.equal(res304.headers.get('etag'), `"${contentHash}:${flowChunkName}"`)
  assert.equal(res304.headers.get('cache-control'), 'private, max-age=31536000, immutable')

  // 3. 非法 chunk 形状直接 400
  for (const bad of ['../escape.js', 'a/../b.js', 'bad..js', 'noext', 'chunk.mjs', '/abs.js', 'dir/sub.js']) {
    const resBad = await call(
      handler,
      'GET',
      `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${encodeURIComponent(bad)}&hash=${contentHash}`,
    )
    assert.equal(resBad.status, 400, `chunk=${bad} 应返回 400`)
    const body = JSON.parse(resBad.text) as { error?: { code?: string } }
    assert.equal(body.error?.code, 'invalid_client_module')
  }

  // 4. hash 失效保护（409 client_chunk_stale）
  const resStale = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=000000000000000000000000`,
  )
  assert.equal(resStale.status, 409)
  const bodyStale = JSON.parse(resStale.text) as { error?: { code?: string } }
  assert.equal(bodyStale.error?.code, 'client_chunk_stale')

  // 5. 不存在的 chunk（404 client_chunk_not_found）
  const resMissing = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=nonexistent_chunk_404.js&hash=${contentHash}`,
  )
  assert.equal(resMissing.status, 404)
  const bodyMissing = JSON.parse(resMissing.text) as { error?: { code?: string } }
  assert.equal(bodyMissing.error?.code, 'client_chunk_not_found')

  // 6. 停用插件（409 plugin_client_unavailable）
  await pluginHost.disable('builtin:mermaid')
  try {
    const resDisabled = await call(
      handler,
      'GET',
      `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=${contentHash}`,
    )
    assert.equal(resDisabled.status, 409)
    const bodyDisabled = JSON.parse(resDisabled.text) as { error?: { code?: string } }
    assert.equal(bodyDisabled.error?.code, 'plugin_client_unavailable')
  } finally {
    await pluginHost.enable('builtin:mermaid')
  }

  // 7. 直接调用 PluginHost getClientModule 检验
  const directChunk = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx', { chunk: flowChunkName })
  assert.equal(directChunk.code, flowChunk.code)
  assert.equal(directChunk.contentHash, contentHash)

  await assert.rejects(
    pluginHost.getClientModule('builtin:mermaid', 'index.tsx', { chunk: '../bad.js' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
  )
  await assert.rejects(
    pluginHost.getClientModule('builtin:mermaid', 'index.tsx', { chunk: flowChunkName, hash: 'badhash' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_chunk_stale',
  )
  await assert.rejects(
    pluginHost.getClientModule('builtin:mermaid', 'index.tsx', { chunk: 'missing.js' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_chunk_not_found',
  )
})

test('HTTP Chunk 304：只接受完整 chunk ETag，裸 contentHash 不匹配（不误吞同 hash 其他 chunk）', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
  const contentHash = result.contentHash
  const flowChunkName = Object.keys(result.chunks ?? {}).find((k) => k.includes('flowDiagram'))!
  const pieChunkName = Object.keys(result.chunks ?? {}).find((k) => k.includes('pieDiagram'))!

  // 裸 contentHash 不得命中任何 chunk（否则浏览器会把同 hash 下其他 chunk 的缓存误判为命中）
  const resRawHash = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=${contentHash}`,
    { headers: { 'if-none-match': contentHash } },
  )
  assert.equal(resRawHash.status, 200, '裸 contentHash 不得作为 chunk 304 匹配')

  // 完整 chunk ETag 命中 304
  const res304 = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=${contentHash}`,
    { headers: { 'if-none-match': `"${contentHash}:${flowChunkName}"` } },
  )
  assert.equal(res304.status, 304)

  // 不同 chunk 的完整 ETag 不命中其他 chunk
  const resOtherChunk = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${pieChunkName}&hash=${contentHash}`,
    { headers: { 'if-none-match': `"${contentHash}:${flowChunkName}"` } },
  )
  assert.equal(resOtherChunk.status, 200, '另一 chunk 的完整 ETag 不得命中')

  // 主模块请求匹配规范 quoted ETag 返回 304；裸 hash 不再返回 304
  const resMainEtag = await call(
    handler,
    'GET',
    '/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx',
    { headers: { 'if-none-match': `"${contentHash}"` } },
  )
  assert.equal(resMainEtag.status, 304, '主模块请求匹配规范 quoted ETag 返回 304')

  const resMainRaw = await call(
    handler,
    'GET',
    '/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx',
    { headers: { 'if-none-match': contentHash } },
  )
  assert.equal(resMainRaw.status, 200, '主模块请求裸 hash 不再返回 304')
})

test('内存缓存 npm 依赖失效：受控 npm 依赖内容变化后不得永久返回旧 bundle', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-client-npm-mem-'))
  try {
    // 构造受控 npm 根：packageRoot/node_modules/tiny-dep/index.js
    const npmRoot = join(scratch, 'host-pkg')
    const depDir = join(npmRoot, 'node_modules', 'tiny-dep')
    await mkdir(depDir, { recursive: true })
    const depEntry = join(depDir, 'index.js')
    await writeFile(join(depDir, 'package.json'), JSON.stringify({ name: 'tiny-dep', main: 'index.js' }))
    await writeFile(depEntry, 'export const value = () => 1\n')
    const clientRoot = join(scratch, 'client-root')
    await mkdir(clientRoot, { recursive: true })
    await writeFile(
      join(clientRoot, 'index.tsx'),
      "import { value } from 'tiny-dep'\nexport const v = value()\n",
    )
    const npmRoots = [{ specifiers: ['tiny-dep'], packageRoot: npmRoot }]
    const first = await compilePluginClientModule('test:npm-mem', clientRoot, 'index.tsx', scratch, { npmRoots })
    // 第二次（内存缓存命中）与第一次一致
    const second = await compilePluginClientModule('test:npm-mem', clientRoot, 'index.tsx', scratch, { npmRoots })
    assert.equal(second.contentHash, first.contentHash)
    // 首版产物真实求值：v === 1（npm 依赖第一版内容）
    const evalMod = async (code: string): Promise<{ v: number }> =>
      (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Math.random()}`)) as never
    assert.equal((await evalMod(first.code)).v, 1)
    // npm 依赖内容变化（保持本地源不变）：内存缓存必须失效，重新编译产出新 hash/新内容
    await writeFile(depEntry, 'export const value = () => 2\n')
    const third = await compilePluginClientModule('test:npm-mem', clientRoot, 'index.tsx', scratch, { npmRoots })
    assert.notEqual(third.contentHash, first.contentHash, 'npm 依赖内容变化后内存缓存必须失效')
    assert.equal((await evalMod(third.code)).v, 2, '新产物必须携带新版 npm 依赖内容（真实求值验证）')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('磁盘缓存 npm 依赖失效：跨进程重启后（清内存缓存）npm 依赖变化同样失效重编译', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-client-npm-disk-'))
  try {
    const npmRoot = join(scratch, 'host-pkg')
    const depDir = join(npmRoot, 'node_modules', 'tiny-dep2')
    await mkdir(depDir, { recursive: true })
    const depEntry = join(depDir, 'index.js')
    await writeFile(join(depDir, 'package.json'), JSON.stringify({ name: 'tiny-dep2', main: 'index.js' }))
    await writeFile(depEntry, 'export const value = () => 10\n')
    const clientRoot = join(scratch, 'client-root')
    await mkdir(clientRoot, { recursive: true })
    await writeFile(
      join(clientRoot, 'index.tsx'),
      "import { value } from 'tiny-dep2'\nexport const v = value()\n",
    )
    const npmRoots = [{ specifiers: ['tiny-dep2'], packageRoot: npmRoot }]
    const first = await compilePluginClientModule('test:npm-disk', clientRoot, 'index.tsx', scratch, { npmRoots })
    // 模拟进程重启：清空内存缓存，磁盘清单复查路径生效
    const { clearClientCompilerMemoryCache } = await import('@helmx/plugin-build')
    clearClientCompilerMemoryCache()
    const cached = await compilePluginClientModule('test:npm-disk', clientRoot, 'index.tsx', scratch, { npmRoots })
    assert.equal(cached.contentHash, first.contentHash, '未变化时磁盘缓存命中')
    await writeFile(depEntry, 'export const value = () => 20\n')
    clearClientCompilerMemoryCache()
    const recompiled = await compilePluginClientModule('test:npm-disk', clientRoot, 'index.tsx', scratch, { npmRoots })
    assert.notEqual(recompiled.contentHash, first.contentHash, 'npm 依赖变化后磁盘缓存必须失效')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('双轨 prebuiltClientDir：PluginHost 无 buildProvider 直接服务预编译主模块、chunk、CSS、gzip 与 stale hash', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-prebuilt-host-'))
  try {
    const srcRoot = join(scratch, 'client-src')
    const outDir = join(scratch, PREBUILT_CLIENT_DIR_NAME)
    await mkdir(srcRoot, { recursive: true })
    await writeFile(join(srcRoot, 'styles.css'), '.prebuilt-badge { font-weight: 600 }\n')
    await writeFile(join(srcRoot, 'lazy.ts'), 'export const answer = () => "prebuilt-chunk-ok"\n')
    await writeFile(
      join(srcRoot, 'index.tsx'),
      "import './styles.css'\nexport function PrebuiltPanel() { return 'panel' }\nexport const loadChunk = async () => (await import('./lazy')).answer()\n",
    )

    const built = await buildPluginClientBundleDir({
      pluginId: 'test:prebuilt-only',
      clientRoot: srcRoot,
      outDir,
      modules: ['index.tsx'],
    })
    const expectedHash = built.manifest.modules['index.tsx']!.contentHash
    const chunkNames = built.manifest.modules['index.tsx']!.chunks ?? []
    assert.ok(chunkNames.length > 0, 'prebuild must emit lazy chunk')

    // Remove source files completely and spin up a PluginHost with NO buildProvider.
    await rm(srcRoot, { recursive: true, force: true })
    const hostDir = join(scratch, 'host-data')
    await mkdir(hostDir, { recursive: true })
    const host = new PluginHost({
      dataDir: hostDir,
      docs: new MemoryDocStore(),
      host: makeBackend(),
      // Intentionally no buildProvider!
    })
    try {
      await host.register({
        id: 'test:prebuilt-only',
        name: 'Prebuilt Only',
        version: '0.1.0',
        prebuiltClientDir: outDir,
        definePlugin(ctx) {
          ctx.ui.screen({
            id: 'main',
            label: 'Main',
            client: { module: 'index.tsx', export: 'PrebuiltPanel' },
          })
        },
      }, { enabled: true })

      const summary = host.list().find((p) => p.id === 'test:prebuilt-only')
      assert.deepEqual(summary?.clientHashes, { 'index.tsx': expectedHash })

      const mainBundle = await host.getClientModule('test:prebuilt-only', 'index.tsx', { hash: expectedHash })
      assert.equal(mainBundle.contentHash, expectedHash)
      assert.match(mainBundle.code, /PrebuiltPanel/)
      assert.match(mainBundle.code, /prebuilt-badge/)
      assert.ok(mainBundle.gzipped && mainBundle.gzipped.length > 0)
      assert.equal(gunzipSync(mainBundle.gzipped!).toString('utf-8'), mainBundle.code)

      const chunkBundle = await host.getClientModule('test:prebuilt-only', 'index.tsx', {
        chunk: chunkNames[0]!,
        hash: expectedHash,
      })
      assert.match(chunkBundle.code, /prebuilt-chunk-ok/)
      assert.ok(chunkBundle.gzipped && chunkBundle.gzipped.length > 0)

      await assert.rejects(
        () => host.getClientModule('test:prebuilt-only', 'index.tsx', { hash: 'stale-hash' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'client_module_stale' && err.status === 409,
      )
      await assert.rejects(
        () => host.getClientModule('test:prebuilt-only', 'index.tsx', { chunk: 'missing.js', hash: 'stale-hash' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'client_chunk_stale' && err.status === 409,
      )
      await assert.rejects(
        () => host.getClientModule('test:prebuilt-only', 'index.tsx', { chunk: 'missing.js', hash: expectedHash }),
        (err: unknown) => err instanceof HelmxError && err.code === 'client_chunk_not_found' && err.status === 404,
      )
    } finally {
      await host.dispose()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('损坏/缺失/符号链接逃逸的 dist-client 必须显式报错，绝不静默降级回 clientRoot', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-prebuilt-strict-'))
  try {
    const srcRoot = join(scratch, 'client-src')
    const outDir = join(scratch, PREBUILT_CLIENT_DIR_NAME)
    await mkdir(srcRoot, { recursive: true })
    await writeFile(join(srcRoot, 'lazy.ts'), 'export const val = 1\n')
    await writeFile(
      join(srcRoot, 'index.tsx'),
      'export function GoodExport() { return "ok" }\nexport const load = () => import("./lazy")\n',
    )
    const built = await buildPluginClientBundleDir({
      pluginId: 'test:strict-prebuilt',
      clientRoot: srcRoot,
      outDir,
      modules: ['index.tsx'],
    })

    const makeHostWithProvider = async (suffix: string) => {
      const dir = join(scratch, suffix)
      await mkdir(dir, { recursive: true })
      return new PluginHost({
        dataDir: dir,
        docs: new MemoryDocStore(),
        host: makeBackend(),
        buildProvider: createPluginBuildProvider(),
      })
    }

    // 1. Export not present in prebuilt manifest -> rejects with invalid_client_export (no fallback to buildProvider).
    const h1 = await makeHostWithProvider('h1')
    try {
      await assert.rejects(
        () => h1.register({
          id: 'test:strict-prebuilt',
          name: 'Strict',
          version: '0.1.0',
          clientRoot: srcRoot,
          prebuiltClientDir: outDir,
          definePlugin(ctx) {
            ctx.ui.screen({ id: 's', label: 'S', client: { module: 'index.tsx', export: 'MissingExport' } })
          },
        }),
        (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_export',
      )
    } finally {
      await h1.dispose()
    }

    // Copy prebuilt outDir before step 2 mutates it so step 3 tests symlink escape on the same real bundle
    // without repeating an identical esbuild pass.
    const { cp, readFile: readFileP } = await import('node:fs/promises')
    const outDirSym = join(scratch, 'dist-client-sym')
    await cp(outDir, outDirSym, { recursive: true })

    // 2. Deleted chunk file -> rejects with prebuilt_client_invalid (no fallback to buildProvider).
    const entry = built.manifest.modules['index.tsx']!
    const chunkRel = prebuiltChunkFileName(entry.entryFile, entry.chunks![0]!)
    await rm(join(outDir, chunkRel))
    const h2 = await makeHostWithProvider('h2')
    try {
      await assert.rejects(
        () => h2.register({
          id: 'test:strict-prebuilt',
          name: 'Strict',
          version: '0.1.0',
          clientRoot: srcRoot,
          prebuiltClientDir: outDir,
          definePlugin(ctx) {
            ctx.ui.screen({ id: 's', label: 'S', client: { module: 'index.tsx', export: 'GoodExport' } })
          },
        }),
        (err: unknown) => err instanceof HelmxError && err.code === 'prebuilt_client_invalid',
      )
    } finally {
      await h2.dispose()
    }

    // 3. Symlink escape on entryFile -> rejects with client_module_out_of_root.
    const outsideFile = join(scratch, 'outside-secret.mjs')
    await writeFile(outsideFile, 'export function GoodExport() { return "evil" }\n')
    const symEntry = JSON.parse(await readFileP(join(outDirSym, PREBUILT_CLIENT_MANIFEST_FILE), 'utf8'))
    const entryRel = symEntry.modules['index.tsx'].entryFile
    await rm(join(outDirSym, entryRel))
    await symlink(outsideFile, join(outDirSym, entryRel))
    const h3 = await makeHostWithProvider('h3')
    try {
      await assert.rejects(
        () => h3.register({
          id: 'test:strict-sym',
          name: 'Strict Sym',
          version: '0.1.0',
          clientRoot: srcRoot,
          prebuiltClientDir: outDirSym,
          definePlugin(ctx) {
            ctx.ui.screen({ id: 's', label: 'S', client: { module: 'index.tsx', export: 'GoodExport' } })
          },
        }),
        (err: unknown) => err instanceof HelmxError && err.code === 'client_module_out_of_root',
      )
    } finally {
      await h3.dispose()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('外部插件 dist-client-only 分发：无源码无 node_modules 无 buildProvider 下 doctor/load/enable/serve 全通', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-ext-prebuilt-'))
  try {
    const buildSrc = join(scratch, 'author-client')
    await mkdir(buildSrc, { recursive: true })
    await writeFile(
      join(buildSrc, 'index.tsx'),
      'export function ExtScreen() { return "ext-prebuilt" }\n',
    )

    const pluginDir = join(scratch, 'data', 'installed-plugins', 'my-prebuilt-ext')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ id: 'my-prebuilt-ext', main: 'index.mjs', clientDist: 'custom-dist' }, null, 2),
    )
    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default {
        id: 'my-prebuilt-ext',
        name: 'My Prebuilt Ext',
        version: '0.1.0',
        definePlugin(ctx) {
          ctx.ui.screen({ id: 'home', label: 'Home', client: { module: 'index.tsx', export: 'ExtScreen' } })
        },
      }\n`,
    )
    await buildPluginClientBundleDir({
      pluginId: 'my-prebuilt-ext',
      clientRoot: buildSrc,
      outDir: join(pluginDir, 'custom-dist'),
      modules: ['index.tsx'],
    })

    // Doctor WITHOUT buildProvider succeeds!
    const okReport = await doctorPluginDir(pluginDir, {})
    assert.equal(okReport.ok, true, `expected doctor ok without buildProvider, got: ${JSON.stringify(okReport)}`)

    // Load and enable on PluginHost WITHOUT buildProvider!
    const hostDataDir = join(scratch, 'data')
    const host = new PluginHost({
      dataDir: hostDataDir,
      docs: new MemoryDocStore(),
      host: makeBackend(),
    })
    try {
      await loadExternalPlugins(hostDataDir, host)
      await host.enable('my-prebuilt-ext')
      const mod = await host.getClientModule('my-prebuilt-ext', 'index.tsx')
      assert.match(mod.code, /ExtScreen/)
    } finally {
      await host.dispose()
    }

    // Escaping clientDist symlink must fail doctor explicitly.
    const outsideDist = join(scratch, 'outside-dist')
    await mkdir(outsideDist, { recursive: true })
    await writeFile(join(outsideDist, PREBUILT_CLIENT_MANIFEST_FILE), JSON.stringify({ version: 1, modules: {} }))
    const escapePluginDir = join(scratch, 'escape-ext')
    await mkdir(escapePluginDir, { recursive: true })
    await writeFile(join(escapePluginDir, 'plugin.json'), JSON.stringify({ id: 'escape-ext', main: 'index.mjs' }))
    await writeFile(join(escapePluginDir, 'index.mjs'), 'export default { id: "escape-ext", name: "E", version: "0.1.0", definePlugin() {} }\n')
    await symlink(outsideDist, join(escapePluginDir, PREBUILT_CLIENT_DIR_NAME))
    const escapeReport = await doctorPluginDir(escapePluginDir, {})
    assert.equal(escapeReport.ok, false)
    assert.ok(escapeReport.checks.some((c) => c.error?.code === 'invalid_plugin_definition'))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('builtin:mermaid 构建产物在无 node_modules/mermaid、无 client/、无 buildProvider 的隔离目录可无依赖运行', { timeout: 60_000 }, async () => {
  // Dev source factory uses clientRoot + npmDependencies (source live-compile track).
  const devDef = createMermaidPlugin()
  assert.equal(devDef.prebuiltClientDir, undefined)
  assert.ok(devDef.clientRoot && devDef.npmDependencies?.['mermaid/dist/mermaid.esm.min.mjs'])

  const scratch = await mkdtemp(join(tmpdir(), 'helmx-mermaid-dist-iso-'))
  try {
    // Stage ONLY dist/mermaid.js + dist/asset-paths.js + dist/mermaid/dist-client (no node_modules/mermaid, no client/).
    const { cp } = await import('node:fs/promises')
    const pkgRoot = join(import.meta.dirname, '..')
    const isoPkg = join(scratch, 'pkg')
    const isoDist = join(isoPkg, 'dist')
    await mkdir(join(isoDist, 'mermaid'), { recursive: true })
    await mkdir(join(isoPkg, 'node_modules', '@helmx'), { recursive: true })
    await symlink(join(pkgRoot, '../protocol'), join(isoPkg, 'node_modules', '@helmx', 'protocol'))
    await writeFile(join(isoPkg, 'package.json'), JSON.stringify({ name: '@helmx/plugins', type: 'module' }))
    await cp(join(pkgRoot, 'dist', 'mermaid.js'), join(isoDist, 'mermaid.js'))
    await cp(join(pkgRoot, 'dist', 'asset-paths.js'), join(isoDist, 'asset-paths.js'))
    await cp(
      join(pkgRoot, 'dist', 'mermaid', PREBUILT_CLIENT_DIR_NAME),
      join(isoDist, 'mermaid', PREBUILT_CLIENT_DIR_NAME),
      { recursive: true },
    )

    const mod = (await import(pathToFileURL(join(isoDist, 'mermaid.js')).href)) as {
      createMermaidPlugin: typeof createMermaidPlugin
    }
    const distDef = mod.createMermaidPlugin()
    assert.equal(distDef.clientRoot, undefined, 'isolated dist-client-only copy has no clientRoot')
    assert.equal(distDef.npmDependencies, undefined, 'prebuilt dist-client must not require runtime npmDependencies')
    assert.ok(distDef.prebuiltClientDir?.endsWith(PREBUILT_CLIENT_DIR_NAME))

    const hostDir = join(scratch, 'host-data')
    await mkdir(hostDir, { recursive: true })
    const host = new PluginHost({
      dataDir: hostDir,
      docs: new MemoryDocStore(),
      host: makeBackend(),
      // No buildProvider!
    })
    try {
      await host.register(distDef, { enabled: true })
      const mainBundle = await host.getClientModule('builtin:mermaid', 'index.tsx')
      assert.match(mainBundle.code, /MermaidCodeBlock/)
      const chunkKeys = Object.keys(mainBundle.chunks ?? {})
      assert.ok(chunkKeys.length > 0, 'prebuilt mermaid must carry split diagram chunks')
      const flowChunkName = chunkKeys.find((k) => k.includes('flowDiagram'))
      assert.ok(flowChunkName, `expected flowDiagram chunk in ${chunkKeys.join(', ')}`)
      const flowChunk = await host.getClientModule('builtin:mermaid', 'index.tsx', {
        chunk: flowChunkName,
        hash: mainBundle.contentHash,
      })
      assert.ok(flowChunk.code.length > 0)
    } finally {
      await host.dispose()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('createPluginBuildProvider builtinCacheDir：显式共享、false 关闭、非法空串拒绝、源码修改 sha256 即时失效且隔离临时 builtin 夹具', { timeout: 60_000 }, async () => {
  assert.throws(
    () => createPluginBuildProvider({ builtinCacheDir: '   ' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_definition',
  )

  const scratch = await mkdtemp(join(tmpdir(), 'helmx-builtin-cache-opt-'))
  try {
    const srcRoot = join(scratch, 'client-src')
    const sharedCache = join(scratch, 'shared-cache')
    const hostA = join(scratch, 'host-a')
    const hostB = join(scratch, 'host-b')
    await mkdir(srcRoot, { recursive: true })
    await writeFile(join(srcRoot, 'index.tsx'), 'export const version = "v1"\n')

    // 1. Explicit builtinCacheDir routes builtin:* into sharedCache while non-builtin stays in request.cacheDir.
    const provider = createPluginBuildProvider({ builtinCacheDir: sharedCache })
    const first = await provider.compileClientModule({
      pluginId: 'builtin:cache-routing-test',
      clientRoot: srcRoot,
      moduleRef: 'index.tsx',
      cacheDir: hostA,
      npmRoots: [],
    })
    const ext = await provider.compileClientModule({
      pluginId: 'ext:cache-routing-test',
      clientRoot: srcRoot,
      moduleRef: 'index.tsx',
      cacheDir: hostA,
      npmRoots: [],
    })

    const baseName = safeFileName('index.tsx')
    assert.ok(
      existsSync(join(sharedCache, 'plugin-staging', safeDirName('builtin:cache-routing-test'), `${baseName}.deps.json`)),
      'builtin:* must populate explicit builtinCacheDir',
    )
    assert.equal(
      existsSync(join(hostA, 'plugin-staging', safeDirName('builtin:cache-routing-test'))),
      false,
      'builtin:* must not duplicate staging into per-host dataDir when builtinCacheDir is set',
    )
    assert.ok(
      existsSync(join(hostA, 'plugin-staging', safeDirName('ext:cache-routing-test'), `${baseName}.deps.json`)),
      'external plugins must remain isolated inside request.cacheDir',
    )
    assert.equal(ext.contentHash, first.contentHash)

    // 2. Different host dataDir reuses the shared disk cache after clearing memory cache, and source edits invalidate via sha256.
    clearClientCompilerMemoryCache()
    const warmFromHostB = await provider.compileClientModule({
      pluginId: 'builtin:cache-routing-test',
      clientRoot: srcRoot,
      moduleRef: 'index.tsx',
      cacheDir: hostB,
      npmRoots: [],
    })
    assert.equal(warmFromHostB.contentHash, first.contentHash)
    assert.equal(warmFromHostB.code, first.code)
    assert.equal(existsSync(join(hostB, 'plugin-staging')), false)

    await writeFile(join(srcRoot, 'index.tsx'), 'export const version = "v2"\n')
    clearClientCompilerMemoryCache()
    const edited = await provider.compileClientModule({
      pluginId: 'builtin:cache-routing-test',
      clientRoot: srcRoot,
      moduleRef: 'index.tsx',
      cacheDir: hostB,
      npmRoots: [],
    })
    assert.notEqual(edited.contentHash, first.contentHash, 'source edit must invalidate shared disk cache via sha256')
    assert.match(edited.code, /v2/)

    // 3. builtinCacheDir: false and default workspace provider keep temporary synthetic builtin:* fixtures isolated in request.cacheDir.
    const defaultCache = resolveDefaultBuiltinClientCacheDir()
    assert.ok(defaultCache && defaultCache.includes('helmx-plugin-clients'), 'workspace checkout should detect default builtin cache dir')
    const isolatedDir = join(scratch, 'host-isolated')
    const disabledDir = join(scratch, 'host-disabled')
    await createPluginBuildProvider().compileClientModule({
      pluginId: 'builtin:temp-outside-workspace',
      clientRoot: srcRoot,
      moduleRef: 'index.tsx',
      cacheDir: isolatedDir,
      npmRoots: [],
    })
    assert.ok(
      existsSync(join(isolatedDir, 'plugin-staging', safeDirName('builtin:temp-outside-workspace'), `${baseName}.deps.json`)),
      'default provider must not share cache for synthetic builtin:* outside packages/plugins/src',
    )
    await createPluginBuildProvider({ builtinCacheDir: false }).compileClientModule({
      pluginId: 'builtin:disabled-cache',
      clientRoot: srcRoot,
      moduleRef: 'index.tsx',
      cacheDir: disabledDir,
      npmRoots: [],
    })
    assert.ok(
      existsSync(join(disabledDir, 'plugin-staging', safeDirName('builtin:disabled-cache'), `${baseName}.deps.json`)),
      'builtinCacheDir: false must write into request.cacheDir',
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('跨进程并发冷编译共享缓存：自动回收死 PID 残留锁、无竞态碰撞且零锁/临时文件残留', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-multiprocess-cache-'))
  try {
    const srcRoot = join(scratch, 'client-src')
    const sharedCache = join(scratch, 'shared-cache')
    const pluginId = 'builtin:mp-lock-test'
    await mkdir(srcRoot, { recursive: true })
    await writeFile(join(srcRoot, 'lazy.ts'), 'export const lazyValue = () => "mp-chunk-ok"\n')
    await writeFile(
      join(srcRoot, 'index.tsx'),
      'export const load = async () => (await import("./lazy")).lazyValue()\nexport const tag = "mp-ok"\n',
    )

    // Obtain a genuinely exited child PID to plant a realistic stale lockfile (no guessed PIDs).
    const deadPid = await new Promise<number>((resolvePid, rejectPid) => {
      const probe = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
      probe.once('error', rejectPid)
      probe.once('exit', () => resolvePid(probe.pid!))
    })
    const stagingDir = join(sharedCache, 'plugin-staging', safeDirName(pluginId))
    const baseName = safeFileName('index.tsx')
    await mkdir(stagingDir, { recursive: true })
    await writeFile(
      join(stagingDir, `.${baseName}.compile.lock`),
      `${deadPid} stale-dead-holder\n`,
    )

    const pluginBuildEntry = import.meta.resolve('@helmx/plugin-build')
    const workerScript = [
      `import { compilePluginClientModule } from ${JSON.stringify(pluginBuildEntry)};`,
      `const res = await compilePluginClientModule(${JSON.stringify(pluginId)}, ${JSON.stringify(srcRoot)}, 'index.tsx', ${JSON.stringify(sharedCache)});`,
      'process.stdout.write(JSON.stringify({ hash: res.contentHash, len: res.code.length, chunks: Object.keys(res.chunks ?? {}).sort() }));',
    ].join('\n')

    const runWorker = (): Promise<{ hash: string; len: number; chunks: string[] }> =>
      new Promise((resolveWorker, rejectWorker) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => {
          stdout += String(chunk)
        })
        child.stderr.on('data', (chunk) => {
          stderr += String(chunk)
        })
        child.once('error', rejectWorker)
        child.once('close', (code) => {
          if (code !== 0) {
            rejectWorker(new Error(`worker exited ${code}: ${stderr}`))
            return
          }
          try {
            resolveWorker(JSON.parse(stdout) as { hash: string; len: number; chunks: string[] })
          } catch (err) {
            rejectWorker(new Error(`invalid worker output ${stdout}: ${String(err)}`))
          }
        })
      })

    const results = await Promise.all([runWorker(), runWorker(), runWorker(), runWorker()])
    const first = results[0]!
    assert.ok(first.hash.length === 24 && first.len > 0 && first.chunks.length > 0)
    for (const r of results) {
      assert.equal(r.hash, first.hash)
      assert.equal(r.len, first.len)
      assert.deepEqual(r.chunks, first.chunks)
    }

    const files = readdirSync(stagingDir)
    assert.ok(
      !files.some((f) => f.endsWith('.compile.lock') || f.endsWith('.tmp')),
      `stagingDir must not retain lock or temp files: ${files.join(', ')}`,
    )
    assert.ok(existsSync(join(stagingDir, `${baseName}.deps.json`)))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('mermaid-loader: renderMermaidSvg 串行化并发 mermaid.render 调用且仅在主题变化时调用 initialize', { timeout: 60_000 }, async () => {
  const { createMermaidLoader: makeLoader, renderMermaidSvg } = await import('../src/mermaid/client/mermaid-loader.js')
  const initThemes: string[] = []
  let activeRenders = 0
  let maxConcurrentRenders = 0
  const gates = [deferred(), deferred(), deferred()]
  let callIndex = 0

  const loader = makeLoader(async () => ({
    default: {
      initialize(cfg: Record<string, unknown>) {
        initThemes.push(String(cfg['theme']))
      },
      async render(id: string, code: string) {
        const idx = callIndex++
        activeRenders += 1
        maxConcurrentRenders = Math.max(maxConcurrentRenders, activeRenders)
        await gates[idx]!.promise
        activeRenders -= 1
        return { svg: `<svg id="${id}">${code}</svg>` }
      },
    } as never,
  }))
  loader.reset()

  const p1 = renderMermaidSvg({ id: 'r1', code: 'graph TD; A-->B', theme: 'dark', loader })
  const p2 = renderMermaidSvg({ id: 'r2', code: 'graph TD; B-->C', theme: 'dark', loader })
  const p3 = renderMermaidSvg({ id: 'r3', code: 'graph TD; C-->D', theme: 'light', loader })

  await new Promise((r) => setImmediate(r))
  gates[0]!.resolve()
  assert.equal(await p1, '<svg id="r1">graph TD; A-->B</svg>')
  await new Promise((r) => setImmediate(r))
  gates[1]!.resolve()
  assert.equal(await p2, '<svg id="r2">graph TD; B-->C</svg>')
  await new Promise((r) => setImmediate(r))
  gates[2]!.resolve()
  assert.equal(await p3, '<svg id="r3">graph TD; C-->D</svg>')

  assert.equal(maxConcurrentRenders, 1, 'mermaid.render 必须严格串行执行，避免全局 DOM/状态互踩')
  assert.deepEqual(initThemes, ['dark', 'neutral'], '同主题连续渲染不重复 initialize，仅在 dark->light 切换时重初始化')
})
