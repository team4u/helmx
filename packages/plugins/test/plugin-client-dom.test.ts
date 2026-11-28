/**
 * Happy-DOM / client-bundle execution tests split from `plugin-client.test.ts` so `plugin-client.test.ts`
 * can run in `node-shared` while DOM & `__helmx_shared_*` / `mermaid` rendering runs in `dom-shared`.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { PluginHost, type PluginHostBackend } from '@helmx/kernel'
import { createPluginBuildProvider, installNodeChunkBridge, resolveDefaultBuiltinClientCacheDir } from '@helmx/plugin-build'
import { HelmxError, type ConversationSummary } from '@helmx/protocol'
import { createMermaidPlugin } from '../src/mermaid.js'
import { MemoryDocStore, deferred, makeConversationSummary, waitFor } from './helpers/plugin-test-env.js'

let dataDir: string
let clientRoot: string
let pluginHost: PluginHost

const makeConversation = (id: number): ConversationSummary => makeConversationSummary({ id, profileId: 'default' })

function makeStubBackend(): PluginHostBackend {
  return {
    getCapability: () => undefined,
    listSkills: async () => [],
    listProviders: () => [],
    listModels: () => [],
    listProfiles: async () => [],
    getProfile: async () => undefined,
    saveProfile: async () => {},
    deleteProfile: async () => {},
    registerDispatchTools: () => () => {},
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
    execEnv: async () => {
      throw new HelmxError('unsupported', '本 fixture 不执行节点命令', 501)
    },
    emitEvent: () => {},
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init: { title?: string }) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id: number) => makeConversation(id),
    updateConversation: async (id: number) => makeConversation(id),
    listNodeInfos: async () => [],
    redactText: (t: string) => t,
    isClosing: () => false,
    getDataDir: () => dataDir,
    registerTool: () => () => {},
    registerHook: () => () => {},
  } as unknown as PluginHostBackend
}

interface VirtualNode {
  type: unknown
  props: Record<string, unknown>
}

function collectNodes(node: unknown, predicate: (v: VirtualNode) => boolean, out: VirtualNode[] = []): VirtualNode[] {
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, predicate, out)
    return out
  }
  if (node !== null && typeof node === 'object' && 'props' in node && 'type' in node) {
    const vnode = node as VirtualNode
    if (predicate(vnode)) out.push(vnode)
    if (vnode.props && 'children' in vnode.props) {
      collectNodes(vnode.props.children, predicate, out)
    }
  }
  return out
}

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  if (node !== null && typeof node === 'object' && 'props' in node) {
    const props = (node as VirtualNode).props
    return collectText(props?.children)
  }
  return ''
}

function createComponentHarness<P>(initialProps: P) {
  const states: unknown[] = []
  const refs: Array<{ current: unknown }> = []
  const memoSlots: Array<{ deps?: unknown[]; value: unknown }> = []
  const effectSlots: Array<{ deps?: unknown[]; cleanup?: () => void }> = []
  const pendingEffects: Array<{ slot: number; fn: () => void | (() => void); deps?: unknown[] }> = []
  let currentProps = initialProps
  let stateUpdates = 0

  const g = globalThis as Record<string, unknown>
  const prevReact = g.__helmx_shared_react
  const prevJsx = g.__helmx_shared_react_jsx_runtime
  const prevUi = g.__helmx_shared_ui
  const prevClient = g.__helmx_shared_plugin_client

  const depsChanged = (a?: unknown[], b?: unknown[]): boolean => {
    if (!a || !b || a.length !== b.length) return true
    return a.some((v, i) => !Object.is(v, b[i]))
  }

  let stateIdx = 0
  let refIdx = 0
  let memoIdx = 0
  let effectIdx = 0

  g.__helmx_shared_react = {
    useState: (init: unknown) => {
      const idx = stateIdx++
      if (idx >= states.length) {
        states.push(typeof init === 'function' ? (init as () => unknown)() : init)
      }
      const setState = (next: unknown) => {
        const prev = states[idx]
        const resolved = typeof next === 'function' ? (next as (p: unknown) => unknown)(prev) : next
        if (!Object.is(prev, resolved)) {
          states[idx] = resolved
          stateUpdates += 1
        }
      }
      return [states[idx], setState]
    },
    useRef: (init: unknown) => {
      const idx = refIdx++
      if (idx >= refs.length) refs.push({ current: init })
      return refs[idx]
    },
    useCallback: (fn: unknown, deps?: unknown[]) => {
      const idx = memoIdx++
      const slot = memoSlots[idx]
      if (!slot || depsChanged(slot.deps, deps)) {
        memoSlots[idx] = { deps, value: fn }
      }
      return memoSlots[idx]!.value
    },
    useMemo: (factory: () => unknown, deps?: unknown[]) => {
      const idx = memoIdx++
      const slot = memoSlots[idx]
      if (!slot || depsChanged(slot.deps, deps)) {
        memoSlots[idx] = { deps, value: factory() }
      }
      return memoSlots[idx]!.value
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const idx = effectIdx++
      const slot = effectSlots[idx]
      if (!slot || depsChanged(slot.deps, deps)) {
        pendingEffects.push({ slot: idx, fn, deps })
      }
    },
  }
  const makeEl = (type: unknown, props: Record<string, unknown>) => ({ type, props })
  const ui = {
    HelmxIcon: (props: Record<string, unknown>) => ({ type: 'HelmxIcon', props }),
    CopyButton: (props: Record<string, unknown>) => ({ type: 'CopyButton', props }),
    Callout: (props: Record<string, unknown>) => ({ type: 'Callout', props }),
    Button: (props: Record<string, unknown>) => ({ type: 'Button', props }),
    IconButton: (props: Record<string, unknown>) => ({ type: 'IconButton', props }),
    Badge: (props: Record<string, unknown>) => ({ type: 'Badge', props }),
    LoadingState: (props: Record<string, unknown>) => ({ type: 'LoadingState', props }),
    SegmentedControl: (props: Record<string, unknown>) => ({ type: 'SegmentedControl', props }),
    ModalDialog: (props: Record<string, unknown>) => ({ type: 'ModalDialog', props }),
    Dialog: (props: Record<string, unknown>) => ({ type: 'Dialog', props }),
    DialogPortal: (props: Record<string, unknown>) => ({ type: 'DialogPortal', props }),
    DialogOverlay: (props: Record<string, unknown>) => ({ type: 'DialogOverlay', props }),
    DialogContent: (props: Record<string, unknown>) => ({ type: 'DialogContent', props }),
    DialogTitle: (props: Record<string, unknown>) => ({ type: 'DialogTitle', props }),
    DialogClose: (props: Record<string, unknown>) => ({ type: 'DialogClose', props }),
  }
  g.__helmx_shared_react_jsx_runtime = { jsx: makeEl, jsxs: makeEl }
  g.__helmx_shared_ui = {
    resolveLocalizedText: (lt: Record<string, string>, locale: string) => lt[locale] ?? lt.en ?? '',
    ...ui,
  }
  g.__helmx_shared_plugin_client = {
    usePluginContext: () => ({ theme: 'dark' }),
    usePluginLocale: () => 'en',
    usePluginTranslator: () => (lt: Record<string, string>) => lt.en ?? '',
  }

  const render = (Component: (props: P) => unknown, nextProps: P = currentProps): unknown => {
    currentProps = nextProps
    stateIdx = 0
    refIdx = 0
    memoIdx = 0
    effectIdx = 0
    const tree = Component(currentProps)
    const toRun = pendingEffects.splice(0, pendingEffects.length)
    for (const eff of toRun) {
      effectSlots[eff.slot]?.cleanup?.()
      const cleanup = eff.fn()
      effectSlots[eff.slot] = {
        deps: eff.deps,
        cleanup: typeof cleanup === 'function' ? cleanup : undefined,
      }
    }
    return tree
  }

  const unmount = (): void => {
    for (const slot of effectSlots) {
      slot?.cleanup?.()
    }
    effectSlots.length = 0
  }

  const restore = (): void => {
    unmount()
    g.__helmx_shared_react = prevReact
    g.__helmx_shared_react_jsx_runtime = prevJsx
    g.__helmx_shared_ui = prevUi
    g.__helmx_shared_plugin_client = prevClient
  }

  return {
    render,
    unmount,
    restore,
    ui,
    getStateUpdates: () => stateUpdates,
  }
}

before(async () => {
  if (typeof globalThis.document === 'undefined') {
    GlobalRegistrator.register()
  }
  dataDir = await mkdtemp(join(tmpdir(), 'helmx-plugin-client-dom-'))
  clientRoot = join(dataDir, 'fixture-plugin-src')
  await mkdir(clientRoot, { recursive: true })
  await writeFile(
    join(clientRoot, 'client.tsx'),
    'export function Panel() { return "ok" }\n',
  )
  pluginHost = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: makeStubBackend(),
    docs: new MemoryDocStore(),
  })
  await pluginHost.register({
    id: 'test:client-dom-fixture',
    name: 'client DOM 夹具插件',
    clientRoot,
    definePlugin(ctx) {
      ctx.ui.screen({ id: 'panel', label: '夹具面板', client: { module: 'client.tsx', export: 'Panel' } })
    },
  })
  await pluginHost.register(createMermaidPlugin())
  await Promise.all([
    pluginHost.getClientModule('builtin:mermaid', 'mermaid-loader.ts'),
    pluginHost.getClientModule('builtin:mermaid', 'MermaidPreviewModal.tsx'),
  ])
}, { timeout: 60_000 })

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
}, { timeout: 60_000 })

test('default+named / as 别名 import：共享 shim 生成合法 ESM 绑定（非正则改写）', { timeout: 60_000 }, async () => {
  await writeFile(
    join(clientRoot, 'alias.tsx'),
    [
      "import ReactDef, { useState as state, useMemo } from 'react'",
      "import * as Lucide from 'lucide-react'",
      "import { Button as UiButton } from '@helmx/ui'",
      "import { usePluginContext } from '@helmx/plugin-client'",
      'export function AliasPanel() {',
      '  const [n] = state(1)',
      '  const doubled = useMemo(() => n * 2, [n])',
      "  if (typeof usePluginContext !== 'function' || typeof UiButton !== 'function') return null",
      "  return ReactDef.createElement('div', null, `alias:${doubled}:${typeof Lucide.Save}`)",
      '}',
      'export const reactDefaultIsObject = typeof ReactDef.createElement',
      'export const memoKind = typeof useMemo',
    ].join('\n'),
  )
  const g2 = globalThis as unknown as Record<string, unknown>
  const prevReact = g2.__helmx_shared_react
  const prevLucide = g2.__helmx_shared_lucide_react
  const prevUi = g2.__helmx_shared_ui
  const prevClient = g2.__helmx_shared_plugin_client
  try {
    const result = await pluginHost.getClientModule('test:client-dom-fixture', 'alias.tsx')
    assert.doesNotMatch(result.code, /const\s*\{\s*useState\s+as\s+state\s*\}/)
    const fakeReact = {
      createElement: (tag: string, _props: unknown, ...children: unknown[]) => ({ tag, children }),
      useState: (v: number) => [v, () => {}],
      useMemo: <T,>(fn: () => T) => fn(),
    }
    g2.__helmx_shared_react = fakeReact
    g2.__helmx_shared_lucide_react = { Save: () => null, Activity: () => null }
    g2.__helmx_shared_ui = { Button: () => null }
    g2.__helmx_shared_plugin_client = { usePluginContext: () => null, usePluginDoc: () => undefined }
    const url = `data:text/javascript;base64,${Buffer.from(result.code, 'utf8').toString('base64')}`
    const mod = (await import(url)) as Record<string, unknown>
    assert.equal(typeof mod.AliasPanel, 'function')
    assert.equal(mod.reactDefaultIsObject, 'function')
    assert.equal(mod.memoKind, 'function')
    const element = (mod.AliasPanel as () => { tag: string; children: unknown[] })()
    assert.equal(String(element.children), 'alias:2:function')
  } finally {
    g2.__helmx_shared_react = prevReact
    g2.__helmx_shared_lucide_react = prevLucide
    g2.__helmx_shared_ui = prevUi
    g2.__helmx_shared_plugin_client = prevClient
    await rm(join(clientRoot, 'alias.tsx'), { force: true })
  }
})

test('端到端执行：编译产物在 Node 环境通过 __helmx_import_chunk 按需加载 mermaid 核心与图表并渲染有效 SVG', { timeout: 60_000 }, async () => {
  const g = globalThis as Record<string, unknown>
  const prevImportChunk = g.__helmx_import_chunk
  try {
    const indexResult = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
    const loaderResult = await pluginHost.getClientModule('builtin:mermaid', 'mermaid-loader.ts')
    assert.ok(indexResult.code.length > 0)
    assert.ok(loaderResult.code.length > 0)

    const builtinCacheDir = resolveDefaultBuiltinClientCacheDir()
    installNodeChunkBridge(builtinCacheDir !== undefined ? [dataDir, builtinCacheDir] : [dataDir])
    const realImportChunk = g.__helmx_import_chunk as (...args: unknown[]) => Promise<unknown>
    const loadedChunks: string[] = []
    g.__helmx_import_chunk = (...args: unknown[]) => {
      loadedChunks.push(String(args[3] ?? ''))
      return realImportChunk(...args)
    }

    const indexModUrl = `data:text/javascript;base64,${Buffer.from(indexResult.code, 'utf8').toString('base64')}`
    const indexMod = (await import(indexModUrl)) as {
      MermaidCodeBlock: unknown
      mermaid?: unknown
    }
    assert.equal(typeof indexMod.MermaidCodeBlock, 'function', '必须导出 MermaidCodeBlock 组件')
    assert.equal(indexMod.mermaid, undefined, 'index.tsx 不得静态导出 mermaid 实例')
    assert.equal(loadedChunks.length, 0, '模块导入阶段不得触发 mermaid chunk 加载')

    const loaderModUrl = `data:text/javascript;base64,${Buffer.from(loaderResult.code, 'utf8').toString('base64')}`
    const loaderMod = (await import(loaderModUrl)) as {
      loadMermaid: () => Promise<typeof import('mermaid').default>
    }
    assert.equal(typeof loaderMod.loadMermaid, 'function', 'mermaid-loader.ts 必须导出 loadMermaid')
    assert.equal(loadedChunks.length, 0, '导入 mermaid-loader 不得提前触发 chunk 加载')

    const mermaid = await loaderMod.loadMermaid()
    assert.ok(loadedChunks.some((name) => name.includes('mermaid.esm.min')), 'loadMermaid 必须按需触发 mermaid.esm.min chunk 加载')

    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })

    const flowResult = await mermaid.render('test-flow-render', 'graph TD;\nA-->B;')
    assert.ok(flowResult.svg.includes('<svg'), 'Flowchart 渲染结果必须包含 <svg')

    const pieResult = await mermaid.render('test-pie-render', 'pie title Pets\n"Dogs" : 386\n"Cats" : 85')
    assert.ok(pieResult.svg.includes('<svg'), 'Pie 图表渲染结果必须包含 <svg')
  } finally {
    g.__helmx_import_chunk = prevImportChunk
  }
})

test('MermaidCodeBlock 编译产物交互状态：加载态、chunk 失败后展示可恢复重试并成功恢复及 unmount stale 守卫', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
  const g = globalThis as Record<string, unknown>
  const prevImportChunk = g.__helmx_import_chunk

  let chunkCalls = 0
  let mode: 'fail' | 'succeed' | 'hang' = 'fail'
  let hangDeferred = deferred<{ default: unknown }>()
  let callDeferred = deferred<void>()

  g.__helmx_import_chunk = async () => {
    chunkCalls += 1
    const cur = callDeferred
    if (mode === 'fail') {
      queueMicrotask(() => cur.resolve())
      throw new Error('chunk offline')
    }
    if (mode === 'hang') {
      cur.resolve()
      return await hangDeferred.promise
    }
    queueMicrotask(() => cur.resolve())
    return {
      default: {
        initialize() {},
        async render() {
          return { svg: '<svg data-ok="inline"></svg>' }
        },
      },
    }
  }

  const harness = createComponentHarness({
    language: 'mermaid',
    code: 'graph TD;\nRETRY-->TEST;',
  })
  try {
    const modUrl = `data:text/javascript;base64,${Buffer.from(result.code, 'utf8').toString('base64')}#${Math.random()}`
    const mod = (await import(modUrl)) as {
      MermaidCodeBlock: (props: { language: string; code: string }) => unknown
    }

    let tree = harness.render(mod.MermaidCodeBlock)
    const loadingStates = collectNodes(tree, (n) => n.type === harness.ui.LoadingState)
    assert.ok(loadingStates.length > 0, '加载期间应显示 LoadingState')
    assert.match(String(loadingStates[0]?.props.label ?? ''), /Rendering Mermaid diagram/)

    await callDeferred.promise
    await waitFor(() => harness.getStateUpdates() >= 1)
    assert.equal(chunkCalls, 1)

    tree = harness.render(mod.MermaidCodeBlock)
    const errorCallouts = collectNodes(tree, (n) => n.type === harness.ui.Callout && n.props.tone === 'err')
    assert.equal(errorCallouts.length, 1, '加载失败必须显式显示错误 Callout')
    assert.match(collectText(tree), /chunk offline/)

    const retryBtn = collectNodes(
      tree,
      (n) => (n.type === 'button' || n.type === harness.ui.Button) && collectText(n).includes('Retry'),
    )[0]
    assert.ok(retryBtn && typeof retryBtn.props.onClick === 'function', '失败态必须提供 Retry 按钮')

    mode = 'succeed'
    callDeferred = deferred<void>()
    ;(retryBtn.props.onClick as () => void)()

    tree = harness.render(mod.MermaidCodeBlock)
    const retryLoading = collectNodes(tree, (n) => n.type === harness.ui.LoadingState)
    assert.ok(retryLoading.length > 0, '点击重试后应立即回到加载态')
    assert.match(String(retryLoading[0]?.props.label ?? ''), /Rendering Mermaid diagram/, '点击重试后应立即回到加载态')
    const updatesAfterRetryStart = harness.getStateUpdates()

    await callDeferred.promise
    await waitFor(() => harness.getStateUpdates() > updatesAfterRetryStart)
    assert.equal(chunkCalls, 2, '失败清除缓存后点击重试必须再次调用 __helmx_import_chunk')

    tree = harness.render(mod.MermaidCodeBlock)
    const svgHost = collectNodes(
      tree,
      (n) => n.type === 'div' && n.props.className === 'mermaid-svg-host',
    )[0]
    assert.ok(svgHost, '重试成功后应渲染 SVG 宿主节点')
    assert.equal(
      (svgHost.props.dangerouslySetInnerHTML as { __html?: string })?.__html,
      '<svg data-ok="inline"></svg>',
    )

    const staleHarness = createComponentHarness({
      language: 'mermaid',
      code: 'graph TD;\nUNMOUNT-->GUARD;',
    })
    try {
      const staleModUrl = `data:text/javascript;base64,${Buffer.from(result.code, 'utf8').toString('base64')}#${Math.random()}`
      const staleMod = (await import(staleModUrl)) as {
        MermaidCodeBlock: (props: { language: string; code: string }) => unknown
      }
      mode = 'hang'
      hangDeferred = deferred<{ default: unknown }>()
      callDeferred = deferred<void>()
      staleHarness.render(staleMod.MermaidCodeBlock)
      await callDeferred.promise

      const updatesBeforeUnmount = staleHarness.getStateUpdates()
      staleHarness.unmount()
      hangDeferred.resolve({
        default: {
          initialize() {},
          async render() {
            return { svg: '<svg data-stale="1"></svg>' }
          },
        },
      })
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(staleHarness.getStateUpdates(), updatesBeforeUnmount, 'unmount 后迟到解析不得回写组件状态')
    } finally {
      staleHarness.restore()
    }
  } finally {
    harness.restore()
    g.__helmx_import_chunk = prevImportChunk
  }
})

test('MermaidPreviewModal 编译产物状态：独立按需加载 mermaid，失败可重试且 unmount 守卫生效', { timeout: 60_000 }, async () => {
  const g = globalThis as Record<string, unknown>
  const prevImportChunk = g.__helmx_import_chunk

  try {
    const modalResult = await pluginHost.getClientModule('builtin:mermaid', 'MermaidPreviewModal.tsx')
    assert.doesNotMatch(modalResult.code, /mermaidAPI|getRegisteredDiagramsMetadata/, '预览弹窗不得内联 mermaid 核心库')
    assert.match(modalResult.code, /__helmx_import_chunk/)

    let chunkCalls = 0
    let mode: 'fail' | 'succeed' | 'hang' = 'fail'
    let hangDeferred = deferred<{ default: unknown }>()
    let callDeferred = deferred<void>()

    g.__helmx_import_chunk = async () => {
      chunkCalls += 1
      const cur = callDeferred
      if (mode === 'fail') {
        queueMicrotask(() => cur.resolve())
        throw new Error('modal chunk failed')
      }
      if (mode === 'hang') {
        cur.resolve()
        return await hangDeferred.promise
      }
      queueMicrotask(() => cur.resolve())
      return {
        default: {
          initialize() {},
          async render() {
            return { svg: '<svg viewBox="0 0 120 80"></svg>' }
          },
        },
      }
    }

    const harness = createComponentHarness({
      code: 'graph TD;\nM1-->M2;',
      svg: null as string | null,
      onClose: () => {},
    })
    try {
      const modUrl = `data:text/javascript;base64,${Buffer.from(modalResult.code, 'utf8').toString('base64')}#${Math.random()}`
      const mod = (await import(modUrl)) as {
        MermaidPreviewModal: (props: { code: string; svg?: string | null; onClose: () => void }) => unknown
      }

      let tree = harness.render(mod.MermaidPreviewModal)
      const modalNodes = collectNodes(tree, (n) => n.type === harness.ui.ModalDialog)
      assert.equal(modalNodes.length, 1, '弹窗必须使用统一 ModalDialog')
      assert.equal(modalNodes[0]?.props.size, 'fullscreen')
      assert.equal(modalNodes[0]?.props.flushBody, true)
      const initialLoading = collectNodes(tree, (n) => n.type === harness.ui.LoadingState)
      assert.ok(initialLoading.length > 0, '弹窗无 svg 时应展示 LoadingState')
      assert.match(String(initialLoading[0]?.props.label ?? ''), /Rendering/, '弹窗无 svg 时应展示加载提示')

      await callDeferred.promise
      await waitFor(() => harness.getStateUpdates() >= 1)
      assert.equal(chunkCalls, 1)

      tree = harness.render(mod.MermaidPreviewModal)
      const errCallout = collectNodes(tree, (n) => n.type === harness.ui.Callout && n.props.tone === 'err')
      assert.equal(errCallout.length, 1, '弹窗加载失败应展示错误 Callout')
      assert.match(collectText(tree), /modal chunk failed/)

      const retryBtn = collectNodes(
        tree,
        (n) => (n.type === 'button' || n.type === harness.ui.Button) && collectText(n).includes('Retry'),
      )[0]
      assert.ok(retryBtn && typeof retryBtn.props.onClick === 'function', '弹窗错误态应提供 Retry 按钮')

      mode = 'succeed'
      callDeferred = deferred<void>()
      ;(retryBtn.props.onClick as () => void)()
      tree = harness.render(mod.MermaidPreviewModal)
      const retryLoading = collectNodes(tree, (n) => n.type === harness.ui.LoadingState)
      assert.ok(retryLoading.length > 0, '点击弹窗重试后应回到 LoadingState')
      assert.match(String(retryLoading[0]?.props.label ?? ''), /Rendering/, '点击弹窗重试后应回到加载态')
      const updatesAfterRetryStart = harness.getStateUpdates()

      await callDeferred.promise
      await waitFor(() => harness.getStateUpdates() > updatesAfterRetryStart)
      assert.equal(chunkCalls, 2)

      tree = harness.render(mod.MermaidPreviewModal)
      const svgLayer = collectNodes(
        tree,
        (n) => n.type === 'div' && n.props.className === 'mermaid-svg-layer',
      )[0]
      assert.ok(svgLayer, '弹窗重试成功后应渲染 SVG 图层')

      const settledModal = collectNodes(tree, (n) => n.type === harness.ui.ModalDialog)[0]
      assert.ok(settledModal, '应渲染 ModalDialog 节点')
      const headerSegCtrl = collectNodes(
        settledModal.props.headerActions,
        (n) => n.type === harness.ui.SegmentedControl,
      )[0]
      assert.ok(headerSegCtrl, 'headerActions 内应渲染 SegmentedControl')
      assert.equal(headerSegCtrl.props.size, 'sm')
      assert.equal(headerSegCtrl.props.value, 'diagram')
      const headerCopyBtn = collectNodes(
        settledModal.props.headerActions,
        (n) => n.type === harness.ui.CopyButton,
      )[0]
      assert.ok(headerCopyBtn, 'headerActions 内应渲染 CopyButton')
      assert.equal(headerCopyBtn.props.className, 'btn btn-secondary btn-sm')

      assert.equal(typeof headerSegCtrl.props.onValueChange, 'function')
      ;(headerSegCtrl.props.onValueChange as (v: 'diagram' | 'source') => void)('source')
      tree = harness.render(mod.MermaidPreviewModal)
      const sourcePre = collectNodes(
        tree,
        (n) => n.type === 'pre' && String(n.props.className ?? '').includes('mermaid-source-pre'),
      )[0]
      assert.ok(sourcePre, '切换到 source 后应展示 .mermaid-source-pre 源码块')
      const sourceModal = collectNodes(tree, (n) => n.type === harness.ui.ModalDialog)[0]
      const sourceSegCtrl = collectNodes(
        sourceModal?.props.headerActions,
        (n) => n.type === harness.ui.SegmentedControl,
      )[0]
      assert.equal(sourceSegCtrl?.props.value, 'source')

      const staleHarness = createComponentHarness({
        code: 'graph TD;\nM1-->M3;',
        svg: null as string | null,
        onClose: () => {},
      })
      try {
        const staleModUrl = `data:text/javascript;base64,${Buffer.from(modalResult.code, 'utf8').toString('base64')}#${Math.random()}`
        const staleMod = (await import(staleModUrl)) as {
          MermaidPreviewModal: (props: { code: string; svg?: string | null; onClose: () => void }) => unknown
        }
        mode = 'hang'
        hangDeferred = deferred<{ default: unknown }>()
        callDeferred = deferred<void>()
        staleHarness.render(staleMod.MermaidPreviewModal)
        await callDeferred.promise
        const updatesBeforeUnmount = staleHarness.getStateUpdates()
        staleHarness.unmount()
        hangDeferred.resolve({
          default: {
            initialize() {},
            async render() {
              return { svg: '<svg viewBox="0 0 10 10"></svg>' }
            },
          },
        })
        await Promise.resolve()
        await Promise.resolve()
        assert.equal(staleHarness.getStateUpdates(), updatesBeforeUnmount, '弹窗 unmount 后迟到解析不得更新状态')
      } finally {
        staleHarness.restore()
      }
    } finally {
      harness.restore()
    }
  } finally {
    g.__helmx_import_chunk = prevImportChunk
  }
})
