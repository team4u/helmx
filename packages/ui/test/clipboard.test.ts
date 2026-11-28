import test from 'node:test'
import assert from 'node:assert/strict'
import { copyToClipboard } from '../src/clipboard.js'

// The copied payloads below intentionally keep non-ASCII (CJK) text: they
// double as Unicode transport coverage through the clipboard pipeline, so the
// exact byte-for-byte passthrough can be asserted.
test('copyToClipboard: prefers navigator.clipboard.writeText when available and returns true', { timeout: 60_000 }, async () => {
  let copiedText = ''
  const ok = await copyToClipboard('测试内容 123', {
    navigator: {
      clipboard: {
        writeText: async (text: string) => {
          copiedText = text
        },
      },
    },
  })
  assert.equal(ok, true)
  assert.equal(copiedText, '测试内容 123')
})

test('copyToClipboard: falls back to execCommand in a non-secure context (navigator.clipboard undefined, e.g. HTTP access)', { timeout: 60_000 }, async () => {
  let appendedValue = ''
  let execCommandCalled = false

  const fakeBody = {
    appendChild: (el: { value: string }) => {
      appendedValue = el.value
    },
    removeChild: (_el: unknown) => {},
  }

  const ok = await copyToClipboard('HTTP 环境降级复制', {
    navigator: {},
    document: {
      body: fakeBody as unknown as HTMLElement,
      createElement: (tag: string) => {
        if (tag === 'textarea') {
          return {
            value: '',
            style: {},
            setAttribute: () => {},
            focus: () => {},
            select: () => {},
            setSelectionRange: () => {},
          } as unknown as HTMLElement
        }
        return {} as unknown as HTMLElement
      },
      execCommand: (command: string) => {
        if (command === 'copy') {
          execCommandCalled = true
          return true
        }
        return false
      },
    } as unknown as Pick<Document, 'body' | 'createElement' | 'execCommand'>,
  })
  assert.equal(ok, true)
  assert.equal(execCommandCalled, true)
  assert.equal(appendedValue, 'HTTP 环境降级复制')
})

test('copyToClipboard: safely returns false without throwing when both the modern API and the fallback fail', { timeout: 60_000 }, async () => {
  const ok = await copyToClipboard('no environment', {
    navigator: {},
    document: undefined,
  })
  assert.equal(ok, false)
})
