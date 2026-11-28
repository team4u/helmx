/**
 * ArtifactPreviewModal 插件预览器闭环测试（真实 DOM：createRoot + act，happy-dom）：
 * - client 轨插件组件收到协议标准 Props（真实会话上下文 / 真实 blobUrl / 真实 size）；
 * - 默认渲染保留，多命中下拉切换与手动切回默认；
 * - scope：无会话上下文不命中；插件停用（贡献移除）后有效回退默认；
 * - 切产物竞态：旧 blob/text/name 不混入新产物 + ObjectURL 及时回收；
 * - 文本超 1MiB：text=null 且显式超限说明；深链元数据异步到达后命中扩展名。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ArtifactMetadata, ConversationSummary } from '@helmx/protocol'
import { ArtifactPreviewModal } from '../src/conversation/ArtifactPreviewModal.js'
import { makeTestStore } from './helpers/store.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { readHostStyles } from './helpers/host-styles.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// 测试基建：真实 fetch/Blob/ObjectURL 替身（观察请求与 URL 生命周期）
// ---------------------------------------------------------------------------

interface TestArtifact {
  id: string
  name?: string
  mimeType?: string
  bytes: Uint8Array
}

function makeArtifact(id: string, bytes: Uint8Array, name?: string, mimeType?: string): TestArtifact {
  return { id, name, mimeType, bytes }
}

/** 真实产物 Blob 的 createObjectURL/revokeObjectURL 观察替身（URL 生命周期断言用）。 */
function installObjectUrlShim(): { active: () => string[]; created: () => string[] } {
  const created: string[] = []
  const live = new Set<string>()
  let seq = 0
  URL.createObjectURL = ((blob: Blob) => {
    seq += 1
    const url = `blob:helmx-test-${seq}`
    created.push(url)
    live.add(url)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    live.delete(url)
  }) as typeof URL.revokeObjectURL
  return {
    active: () => [...live],
    created: () => [...created],
  }
}

/** 用真实 Blob 响应真实 artifactsApi.fetch（fetch 拦截仅替换网络层）。 */
function installArtifactFetch(artifacts: TestArtifact[]): void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const raw = String(input)
    // 插件 client 模块：返回空体 + seeded hash，让真实 loadPluginClientModule 走
    // 缓存命中路径复用 seedPluginClientModule 已发布的模块命名空间（真实加载链路）。
    if (raw.startsWith('/api/plugins/')) {
      return new Response('', { status: 200, headers: { 'x-helmx-client-hash': 'seeded' } })
    }
    const match = /^\/api\/artifacts\/([^/]+)\/content/.exec(raw)
    if (match !== null) {
      const id = decodeURIComponent(match[1]!)
      const artifact = artifacts.find((a) => a.id === id)
      if (artifact === undefined) return new Response('not found', { status: 404 })
      const blob = artifact.mimeType !== undefined
        ? new Blob([artifact.bytes as BlobPart], { type: artifact.mimeType })
        : new Blob([artifact.bytes as BlobPart])
      return new Response(blob, { status: 200 })
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  test.after?.(() => { globalThis.fetch = originalFetch })
}

const artifactMeta = (a: TestArtifact, conversationId: number): ArtifactMetadata => ({
  id: a.id,
  conversationId,
  kind: 'upload',
  name: a.name ?? '',
  path: `artifacts/${conversationId}/${a.name ?? a.id}`,
  mimeType: a.mimeType ?? '',
  size: a.bytes.byteLength,
  createdAt: 1767225600000,
})

const convSummary = (id: number, over: Partial<ConversationSummary> = {}): ConversationSummary => ({
  id,
  title: `会话 ${id}`,
  profileId: 'assistant',
  tags: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
}) as ConversationSummary

function buildStore(over: {
  conversations?: ConversationSummary[]
  artifacts?: TestArtifact[]
  conversationId?: number
  asyncMeta?: boolean
}): HelmxExternalStore {
  const conversationId = over.conversationId ?? 7
  const metas = (over.artifacts ?? []).map((a) => artifactMeta(a, conversationId))
  const store = makeTestStore({
    uiContributions: [],
    conversations: over.conversations ?? [convSummary(conversationId)],
    // asyncMeta：模拟深链元数据尚未到达（load 为空操作，由测试稍后注入元数据）。
    conversationArtifacts: over.asyncMeta === true ? {} : { [conversationId]: metas },
  })
  return store
}

function mount(host: HTMLElement, store: HelmxExternalStore, artifactId: string, conversationId?: number): Root {
  let root: Root | undefined
  act(() => {
    root = createRoot(host)
    root.render(e(
      HostStoreProviders, { value: store },
      e(ArtifactPreviewModal, { artifactId, conversationId, onClose: () => {}, inline: true }),
    ))
  })
  return root!
}

/** 每用例后清理测试期残留在 body 的节点，避免跨用例 DOM 串扰。 */
function resetBody(): void {
  for (const node of [...document.body.children]) {
    if (node.tagName === 'SCRIPT' || node.tagName === 'STYLE') continue
    node.remove()
  }
}

/** 推进足够微任务批次让 fetch → blob → createObjectURL → setState 完成。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })
  }
}

/** 再渲染一次（触发 client 组件缓存快路径等渲染批次）。 */
async function rerender(root: Root, store: HelmxExternalStore, artifactId: string, conversationId?: number): Promise<void> {
  await act(async () => {
    root.render(e(
      HostStoreProviders, { value: store },
      e(ArtifactPreviewModal, { artifactId, conversationId, onClose: () => {}, inline: true }),
    ))
  })
}

function previewPanel(): HTMLElement | null {
  return document.querySelector('.artifact-plugin-view')
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

test('Markdown 富文本预览复用会话大纲：显示章节数量并精确滚动到标题', { timeout: 60_000 }, async () => {
  installObjectUrlShim()
  const markdown = makeArtifact(
    'art-outline',
    new TextEncoder().encode('# 总览\n\n正文\n\n## 安装\n\n安装步骤\n\n### 验证\n\n验证步骤'),
    'guide.md',
    'text/markdown',
  )
  installArtifactFetch([markdown])
  const store = buildStore({ artifacts: [markdown] })

  resetBody()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = mount(host, store, 'art-outline', 7)
  await flush()

  const seg = document.querySelector<HTMLElement>('.helmx-tabs-segmented.helmx-tabs-sm')
  assert.ok(
    seg !== null,
    'Markdown 产物预览视图切换器必须使用 size="sm"',
  )
  const trigger = document.querySelector<HTMLButtonElement>('.conversation-outline-trigger')
  assert.ok(trigger !== null, 'Markdown 预览应显示大纲按钮')
  assert.ok(
    (seg.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    '大纲按钮在 DOM 顺序中必须位于视图切换器之后',
  )
  assert.match(trigger.textContent ?? '', /3/, '大纲角标应显示章节数量')

  await act(async () => { trigger.click() })
  const options = [...document.querySelectorAll<HTMLButtonElement>('.conversation-outline-item')]
  assert.equal(options.length, 3, 'Markdown 大纲只显示 H1~H3 章节，不显示会话提问切换')
  const installOption = options.find((option) => (option.textContent ?? '').includes('安装'))
  assert.ok(installOption !== undefined, '大纲应包含安装章节')

  const scrolled: HTMLElement[] = []
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
  HTMLElement.prototype.scrollIntoView = function () {
    scrolled.push(this)
  }
  try {
    await act(async () => { installOption!.click() })
    const lastScrolled = scrolled.at(-1)
    assert.ok(lastScrolled !== undefined, '点击章节应触发滚动')
    assert.equal(lastScrolled.tagName.toLowerCase(), 'h2')
    assert.equal(lastScrolled.dataset.headingIndex, '1')

    const sourceTab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) =>
      el.textContent?.includes('Source'),
    )
    assert.ok(sourceTab !== undefined, 'Markdown 预览应提供源码切换按钮')
    await act(async () => {
      sourceTab.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }))
      sourceTab.click()
    })
    await flush()

    const sourceSeg = document.querySelector<HTMLElement>('.helmx-tabs-segmented')
    const sourceTrigger = document.querySelector<HTMLButtonElement>('.conversation-outline-trigger')
    assert.ok(sourceSeg !== null && sourceTrigger !== null, '切至源码视图后大纲按钮保持常驻')
    assert.ok(
      (sourceSeg.compareDocumentPosition(sourceTrigger) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      '源码视图下大纲按钮仍在视图切换器之后',
    )

    const line5 = document.querySelector<HTMLElement>('.code-line[data-line="5"]')
    assert.ok(line5 !== null, '源码视图应渲染行号容器 .code-line[data-line="5"]')

    await act(async () => { sourceTrigger.click() })
    await flush()
    const sourceInstallOption = [...document.querySelectorAll<HTMLButtonElement>('.conversation-outline-item')].find(
      (option) => (option.textContent ?? '').includes('安装'),
    )
    assert.ok(sourceInstallOption !== undefined, '源码视图大纲应包含安装章节')
    await act(async () => { sourceInstallOption.click() })
    await flush()

    const lastSourceScrolled = scrolled.at(-1)
    assert.ok(lastSourceScrolled === line5, '源码视图点击「安装」应滚动定位至 .code-line[data-line="5"]')
  } finally {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  }

  act(() => root.unmount())
  resetBody()
})

test('切产物竞态：旧 blob/text/name 不混入新产物 + ObjectURL 回收', { timeout: 60_000 }, async () => {
  const shim = installObjectUrlShim()
  const csv = makeArtifact('art-a', new TextEncoder().encode('a,b\n1,2'), 'a.csv', 'text/csv')
  const json = makeArtifact('art-b', new TextEncoder().encode('{"x":1}'), 'b.json', 'application/json')
  installArtifactFetch([csv, json])
  const store = buildStore({ artifacts: [csv, json] })

  resetBody()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = mount(host, store, 'art-a', 7)
  await flush()
  assert.match(document.body.textContent ?? '', /a\.csv/, '第一产物名称显示')

  // 切换到第二产物（同一挂载内）
  await rerender(root, store, 'art-b', 7)
  await flush()
  assert.match(document.body.textContent ?? '', /b\.json/, '新产物名称显示')
  assert.doesNotMatch(document.body.textContent ?? '', /a\.csv/, '旧产物名称不残留')
  assert.doesNotMatch(document.body.textContent ?? '', /a,b/, '旧 text 不混入')
  assert.ok(shim.created().length >= 2, '两个产物各自创建 ObjectURL')
  assert.equal(shim.active().length, 1, '仅当前产物 URL 存活，旧的已回收')

  act(() => { root.unmount() })
  assert.equal(shim.active().length, 0, '卸载后 ObjectURL 全部回收')
})

test('文本超 1MiB：默认渲染显式超限说明（不截断伪装）', { timeout: 60_000 }, async () => {
  installObjectUrlShim()
  const bigBytes = new Uint8Array(1024 * 1024 + 10)
  const big = makeArtifact('art-big', bigBytes, 'big.json', 'application/json')
  installArtifactFetch([big])
  const store = buildStore({ artifacts: [big] })

  resetBody()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = mount(host, store, 'art-big', 7)
  await flush()
  assert.match(document.body.textContent ?? '', /1\s*MiB|preview limit|过大/i, '显式超限说明呈现')

  act(() => { root.unmount() })
})

test('ArtifactPreviewModal switches UI copy between en and zh-CN', { timeout: 60_000 }, async () => {
  installObjectUrlShim()
  const markdown = makeArtifact('art-i18n', new TextEncoder().encode('# Hello\n\nBody'), 'notes.md', 'text/markdown')
  installArtifactFetch([markdown])
  const baseStore = buildStore({ artifacts: [markdown] })

  resetBody()
  const host = document.createElement('div')
  document.body.appendChild(host)
  baseStore.setLocale('zh-CN')
  const root = mount(host, baseStore, 'art-i18n', 7)
  await flush()

  const dialog = document.querySelector('[role="dialog"]')
  assert.ok(dialog !== null)
  assert.equal(dialog.getAttribute('aria-label'), '产物预览：notes.md')
  assert.ok(document.querySelector('button[aria-label="关闭预览"]') !== null, 'close button localized to zh-CN')
  assert.match(document.body.textContent ?? '', /富文本/)
  assert.match(document.body.textContent ?? '', /源码/)
  assert.match(document.body.textContent ?? '', /下载/)

  await act(async () => {
    baseStore.setLocale('en')
  })
  await rerender(root, baseStore, 'art-i18n', 7)
  await flush()
  assert.equal(document.querySelector('[role="dialog"]')?.getAttribute('aria-label'), 'Artifact preview: notes.md')
  assert.ok(document.querySelector('button[aria-label="Close preview"]') !== null, 'close button localized back to en')
  assert.match(document.body.textContent ?? '', /Rich text/)

  act(() => { root.unmount() })
  localStorage.removeItem('helmx:locale')
  resetBody()
})

test('Markdown 产物预览期间元数据对象引用刷新时不卸载 MarkdownView 且保留滚动位置；深链命名后到仍正常解码', { timeout: 60_000 }, async () => {
  installObjectUrlShim()
  const markdown = makeArtifact(
    'art-stable-scroll',
    new TextEncoder().encode('# 标题一\n\n第一段\n\n## 标题二\n\n第二段'),
    'doc.md',
    'text/markdown',
  )
  const extra = makeArtifact('art-extra', new TextEncoder().encode('other'), 'other.txt', 'text/plain')
  installArtifactFetch([markdown, extra])
  const store = buildStore({ artifacts: [markdown] })

  resetBody()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = mount(host, store, 'art-stable-scroll', 7)
  await flush()

  const modalBody = document.querySelector<HTMLElement>('.preview-modal-body')
  const previewBefore = document.querySelector<HTMLElement>('.artifact-markdown-preview')
  assert.ok(modalBody !== null && previewBefore !== null, 'Markdown 富文本预览已挂载')

  modalBody.scrollTop = 240
  assert.equal(modalBody.scrollTop, 240)

  // 模拟后台重拉 /artifacts 返回新数组与新 meta 对象引用（含新增其他产物）
  store.setConversationArtifacts({
    7: [artifactMeta(markdown, 7), artifactMeta(extra, 7)],
  })
  await rerender(root, store, 'art-stable-scroll', 7)
  await flush()

  const previewAfter = document.querySelector<HTMLElement>('.artifact-markdown-preview')
  assert.ok(previewAfter === previewBefore, '元数据对象引用刷新时不得卸载重建 MarkdownView')
  assert.equal(modalBody.scrollTop, 240, '滚动位置不得被重置到首行')
  assert.ok(document.querySelector('.preview-modal-code') === null, '不得短暂回退到源码/加载占位视图')

  act(() => { root.unmount() })
  resetBody()

  // 深链场景：Blob 返回 application/octet-stream，异步命名元数据到达后应从 binary 切到解码并渲染 Markdown
  const lateMd = makeArtifact(
    'art-late-md',
    new TextEncoder().encode('# 延迟识别\n\n内容'),
    'late.md',
    'application/octet-stream',
  )
  installArtifactFetch([lateMd])
  const lateStore = buildStore({ artifacts: [lateMd], asyncMeta: true })
  const lateHost = document.createElement('div')
  document.body.appendChild(lateHost)
  const lateRoot = mount(lateHost, lateStore, 'art-late-md', 7)
  await flush()
  assert.ok(document.querySelector('.artifact-markdown-preview') === null, '元数据未到时 octet-stream 不按 Markdown 解码')

  lateStore.setConversationArtifacts({ 7: [artifactMeta(lateMd, 7)] })
  await rerender(lateRoot, lateStore, 'art-late-md', 7)
  await flush()
  const latePreview = document.querySelector('.artifact-markdown-preview')
  assert.ok(latePreview !== null, '命名元数据到达后应正常解码并渲染 Markdown')
  assert.match(latePreview.textContent ?? '', /延迟识别/)

  act(() => { lateRoot.unmount() })
  resetBody()
})

test('产物 Markdown 预览复用会话回合同一套样式与字体计算契约', { timeout: 60_000 }, async () => {
  installObjectUrlShim()
  const markdown = makeArtifact(
    'art-style-parity',
    new TextEncoder().encode('# 标题一\n\n## 标题二\n\n正文与 `inline` 代码'),
    'parity.md',
    'text/markdown',
  )
  installArtifactFetch([markdown])
  const store = buildStore({ artifacts: [markdown] })

  resetBody()
  const styleEl = document.createElement('style')
  styleEl.textContent = readHostStyles()
  document.head.appendChild(styleEl)

  const convRef = document.createElement('div')
  convRef.className = 'msg-ai-block'
  convRef.innerHTML = '<div class="msg-ai-body"><h1>标题一</h1><h2>标题二</h2><p>正文与 <code>inline</code></p></div>'
  document.body.appendChild(convRef)

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = mount(host, store, 'art-style-parity', 7)
  await flush()

  try {
    const convBody = convRef.querySelector('.msg-ai-body')!
    const convH1 = convBody.querySelector('h1')!
    const convH2 = convBody.querySelector('h2')!
    const convCode = convBody.querySelector('code')!

    const previewBody = document.querySelector('.artifact-markdown-preview .msg-ai-body')!
    const previewH1 = previewBody.querySelector('h1')!
    const previewH2 = previewBody.querySelector('h2')!
    const previewCode = previewBody.querySelector('code')!

    assert.equal(getComputedStyle(previewBody).fontFamily, getComputedStyle(convBody).fontFamily)
    assert.equal(getComputedStyle(previewBody).fontSize, getComputedStyle(convBody).fontSize)
    assert.equal(getComputedStyle(previewBody).lineHeight, getComputedStyle(convBody).lineHeight)
    assert.equal(getComputedStyle(previewBody).fontSize, '15px')
    assert.equal(getComputedStyle(previewH1).fontSize, getComputedStyle(convH1).fontSize)
    assert.equal(getComputedStyle(previewH2).fontSize, getComputedStyle(convH2).fontSize)
    assert.equal(getComputedStyle(previewCode).fontSize, getComputedStyle(convCode).fontSize)
    assert.equal(getComputedStyle(previewCode).fontFamily, getComputedStyle(convCode).fontFamily)
  } finally {
    act(() => { root.unmount() })
    styleEl.remove()
    resetBody()
  }
})

test('FilePreviewBody：textState="binary"（含文本类文件解码失败回退）显示明确不支持在线预览提示而非卡在读取中', { timeout: 60_000 }, async () => {
  const { FilePreviewBody } = await import('../src/conversation/FilePreviewBody.js')
  const { HostStoreProviders } = await import('./helpers/host-store.js')
  const store = buildStore({ artifacts: [] })
  resetBody()

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const markdownPreviewRef = React.createRef<HTMLDivElement>()

  try {
    await act(async () => {
      root.render(
        React.createElement(
          HostStoreProviders,
          { value: store },
          React.createElement(FilePreviewBody, {
            name: 'corrupt.md',
            mime: 'text/markdown',
            blobUrl: 'blob:test-binary',
            text: null,
            textState: 'binary',
            isTextLike: true,
            markdown: true,
            view: 'rich',
            language: 'markdown',
            markdownPreviewRef,
          }),
        ),
      )
    })

    const callout = host.querySelector('.callout')
    assert.ok(callout !== null, 'binary textState must render an explicit .callout prompt')
    assert.match(callout.textContent ?? '', /no inline preview|暂不支持在线预览/i)
    assert.ok(host.querySelector('.preview-modal-code') === null, 'binary textState must not fall through to CodeBlockView readingText placeholder')
  } finally {
    act(() => { root.unmount() })
    resetBody()
  }

  // Also verify ArtifactPreviewModal when a text-like blob fails text() decoding -> transitions to binary callout
  installObjectUrlShim()
  const brokenBlob = new Blob([new Uint8Array([0xff, 0xfe, 0x00])], { type: 'text/plain' })
  brokenBlob.text = () => Promise.reject(new Error('decode failed'))
  const brokenMeta = artifactMeta(
    makeArtifact('art-broken-text', new Uint8Array([0xff, 0xfe, 0x00]), 'broken.txt', 'text/plain'),
    7,
  )
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/artifacts/art-broken-text')) {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/plain' }),
        blob: async () => brokenBlob,
      } as unknown as Response
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
  const brokenStore = buildStore({ artifacts: [] })
  brokenStore.setConversationArtifacts({ 7: [brokenMeta] })
  const modalHost = document.createElement('div')
  document.body.appendChild(modalHost)
  const modalRoot = mount(modalHost, brokenStore, 'art-broken-text', 7)
  try {
    await flush()
    const modalCallout = document.querySelector('.preview-modal-body .callout')
    assert.ok(modalCallout !== null, 'failed text decode must render explicit .callout notice')
    assert.match(modalCallout.textContent ?? '', /no inline preview|暂不支持在线预览/i)
    assert.ok(document.querySelector('.preview-modal-code') === null, 'must not stay stuck in CodeBlockView readingText')
  } finally {
    globalThis.fetch = origFetch
    act(() => { modalRoot.unmount() })
    resetBody()
  }
})
