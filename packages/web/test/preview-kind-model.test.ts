/**
 * 产物 / 工作区文件预览共用模块契约测试（拆分自 ArtifactPreviewModal / WorkspaceFilePreviewModal）：
 * - deriveFilePreviewKind：按 MIME / 文件名推导媒体类型、文本解码与高亮语言；
 * - usePreviewBlobLoad：loading → loaded（创建 ObjectURL）/ error 显式落错；目标切换与卸载回收 ObjectURL 并 abort。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { ensureHappyDom, flushMicrotasks, resetHappyDom } from './helpers/dom-harness.js'
import { deriveFilePreviewKind } from '../src/conversation/preview-modal/preview-kind-model.js'
import { usePreviewBlobLoad } from '../src/conversation/preview-modal/use-preview-blob-load.js'
import type { FilePreviewLoadState } from '../src/conversation/use-file-preview.js'

ensureHappyDom()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')

test('deriveFilePreviewKind：媒体 / PDF 不按文本解码，Markdown 固定 markdown 高亮，文本按后缀推导语言', { timeout: 60_000 }, () => {
  const image = deriveFilePreviewKind('a.png', 'image/png')
  assert.equal(image.isImage, true)
  assert.equal(image.isTextLike, false)
  assert.equal(deriveFilePreviewKind('a.mp4', 'video/mp4').isVideo, true)
  assert.equal(deriveFilePreviewKind('doc.pdf', 'application/pdf').isPdf, true)

  const markdown = deriveFilePreviewKind('README.md', 'text/markdown')
  assert.equal(markdown.markdown, true)
  assert.equal(markdown.language, 'markdown')
  assert.equal(markdown.isTextLike, true)

  const code = deriveFilePreviewKind('index.ts', 'application/octet-stream')
  assert.equal(code.isTextLike, true, 'octet-stream 按已知文本后缀回退解码')
  assert.equal(code.language, 'typescript')

  const unknown = deriveFilePreviewKind('blob', '')
  assert.equal(unknown.isTextLike, false, '名称与 MIME 都未知时不猜测解码')
  assert.equal(unknown.language, '')
})

interface Probe {
  state: FilePreviewLoadState | null
}

test('usePreviewBlobLoad：加载成功创建 ObjectURL；切换目标与卸载回收旧 ObjectURL 并 abort 在途请求', { timeout: 60_000 }, async () => {
  resetHappyDom()
  const created: string[] = []
  const revoked: string[] = []
  let urlSeq = 0
  URL.createObjectURL = ((blob: Blob) => {
    urlSeq += 1
    const url = `blob:test-${urlSeq}-${blob.size}`
    created.push(url)
    return url
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url)
  }) as typeof URL.revokeObjectURL

  const abortedSignals: AbortSignal[] = []
  const load = (signal: AbortSignal): Promise<Blob> =>
    new Promise<Blob>((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      abortedSignals.push(signal)
      setTimeout(() => resolve(new Blob(['hello'], { type: 'text/plain' })), 0)
    })

  const probe: Probe = { state: null }
  // 每次渲染记录阶段，断言目标切换时经过 loading 再到 loaded（不依赖计时器时序）
  const phases: string[] = []
  function ProbeComponent({ target }: { target: string }): null {
    probe.state = usePreviewBlobLoad(target, load)
    phases.push(probe.state.phase)
    return null
  }
  const distinctPhases = (): string[] => phases.filter((phase, idx) => idx === 0 || phase !== phases[idx - 1])

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(React.createElement(ProbeComponent, { target: 'a' }))
    })
    assert.ok(probe.state !== null)
    await flushMicrotasks()
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    })
    assert.ok(probe.state !== null && probe.state.phase === 'loaded')
    assert.equal(probe.state.blobUrl, created[0])
    assert.equal(created.length, 1)

    // 切换目标：旧 ObjectURL 被回收，旧请求被 abort，新请求进入 loading
    await act(async () => {
      root.render(React.createElement(ProbeComponent, { target: 'b' }))
    })
    assert.deepEqual(revoked, [created[0]])
    assert.equal(abortedSignals.length, 2)
    assert.equal(abortedSignals[0]?.aborted, true)
    assert.ok(probe.state !== null)

    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
    })
    assert.ok(probe.state !== null && probe.state.phase === 'loaded')
    assert.equal(probe.state.blobUrl, created[1])
    assert.equal(created.length, 2)
    assert.deepEqual(revoked, [created[0]])
    assert.deepEqual(distinctPhases(), ['loading', 'loaded', 'loading', 'loaded'])

    await act(async () => {
      root.unmount()
    })
    assert.deepEqual(revoked, created, '卸载后回收全部 ObjectURL')
  } finally {
    act(() => { root.unmount() })
    host.remove()
  }
})

test('usePreviewBlobLoad：加载失败显式落 error 并透出消息，不编造内容', { timeout: 60_000 }, async () => {
  resetHappyDom()
  const probe: Probe = { state: null }
  const phases2: string[] = []
  function ProbeComponent(): null {
    probe.state = usePreviewBlobLoad('x', async () => {
      throw new Error('boom')
    })
    phases2.push(probe.state.phase)
    return null
  }
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(React.createElement(ProbeComponent))
    })
    await flushMicrotasks()
    assert.ok(probe.state !== null)
    assert.equal(probe.state.phase, 'error')
    assert.equal(probe.state.phase === 'error' ? probe.state.message : '', 'boom')
    assert.deepEqual(phases2, ['loading', 'loading', 'error'], '失败显式落 error，不经 loaded')
  } finally {
    act(() => { root.unmount() })
    host.remove()
  }
})
