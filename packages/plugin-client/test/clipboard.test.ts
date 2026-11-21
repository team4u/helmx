import test from 'node:test'
import assert from 'node:assert/strict'
import { copyToClipboard } from '../src/clipboard.js'

function restoreGlobalProperty(key: 'navigator' | 'document', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor !== undefined) {
    Object.defineProperty(globalThis, key, descriptor)
  } else {
    delete (globalThis as Record<string, unknown>)[key]
  }
}

// The copied payloads below intentionally keep non-ASCII (CJK) text: they
// double as Unicode transport coverage through the clipboard pipeline, so the
// exact byte-for-byte passthrough can be asserted.
test('copyToClipboard: prefers navigator.clipboard.writeText when available and returns true', { timeout: 60_000 }, async () => {
  let copiedText = ''
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        clipboard: {
          writeText: async (text: string) => {
            copiedText = text
          },
        },
      },
      configurable: true,
      writable: true,
    })

    const ok = await copyToClipboard('测试内容 123')
    assert.equal(ok, true)
    assert.equal(copiedText, '测试内容 123')
  } finally {
    restoreGlobalProperty('navigator', originalNavigator)
    restoreGlobalProperty('document', originalDocument)
  }
})

test('copyToClipboard: falls back to execCommand in a non-secure context (navigator.clipboard undefined, e.g. HTTP access)', { timeout: 60_000 }, async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

  let appendedValue = ''
  let execCommandCalled = false

  try {
    // Simulate an insecure HTTP environment: navigator.clipboard is undefined
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    })

    const fakeBody = {
      appendChild: (el: any) => {
        appendedValue = el.value
      },
      removeChild: (_el: any) => {},
    }

    Object.defineProperty(globalThis, 'document', {
      value: {
        body: fakeBody,
        createElement: (tag: string) => {
          if (tag === 'textarea') {
            return {
              value: '',
              style: {},
              setAttribute: () => {},
              focus: () => {},
              select: () => {},
              setSelectionRange: () => {},
            }
          }
          return {}
        },
        execCommand: (command: string) => {
          if (command === 'copy') {
            execCommandCalled = true
            return true
          }
          return false
        },
      },
      configurable: true,
      writable: true,
    })

    const ok = await copyToClipboard('HTTP 环境降级复制')
    assert.equal(ok, true)
    assert.equal(execCommandCalled, true)
    assert.equal(appendedValue, 'HTTP 环境降级复制')
  } finally {
    restoreGlobalProperty('navigator', originalNavigator)
    restoreGlobalProperty('document', originalDocument)
  }
})

test('copyToClipboard: safely returns false without throwing when both the modern API and the fallback fail', { timeout: 60_000 }, async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    })
    Object.defineProperty(globalThis, 'document', {
      value: undefined,
      configurable: true,
      writable: true,
    })

    const ok = await copyToClipboard('no environment')
    assert.equal(ok, false)
  } finally {
    restoreGlobalProperty('navigator', originalNavigator)
    restoreGlobalProperty('document', originalDocument)
  }
})
