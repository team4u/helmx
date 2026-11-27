/**
 * usePluginAction (synchronous mutex + error formatting + notifyError) SDK tests.
 */
import './helpers/register-happy-dom.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { usePluginAction } = await import('../src/ui/use-plugin-action.js')
const { PluginClientContext } = await import('../src/plugin-context.js')

const e = React.createElement

test('usePluginAction DOM: synchronous mutex prevents double submit, exposes pendingKey/error/clearError, and forwards notifyError + options', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const calls: Array<{ actionId: string; input: unknown; options: unknown }> = []
  const notices: Array<{ msg: string; tone: string | undefined }> = []
  let resolveFirst: ((val: unknown) => void) | undefined
  let shouldFail = false

  const pluginCtx = {
    pluginId: 'builtin:act-demo',
    callAction: async (actionId: string, input: unknown, options?: unknown) => {
      calls.push({ actionId, input, options })
      if (shouldFail) throw new Error('boom from server')
      return await new Promise((resolve) => {
        resolveFirst = resolve
      })
    },
    fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: (msg: string, tone?: string) => {
      notices.push({ msg, tone })
    },
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark' as const,
    locale: 'en' as const,
    translate: (text: unknown) => (typeof text === 'string' ? text : ''),
  }

  let api: ReturnType<typeof usePluginAction> | undefined
  function Harness() {
    api = usePluginAction({
      notifyError: true,
      formatError: (err, id) => `${id}: ${err instanceof Error ? err.message : String(err)}`,
    })
    return e('div', { 'data-pending': String(api.pending), 'data-key': api.pendingKey ?? '', 'data-err': api.error ?? '' })
  }

  await act(async () => {
    root.render(e(PluginClientContext.Provider, { value: pluginCtx }, e(Harness)))
  })

  let p1: Promise<unknown> | undefined
  let p2: Promise<unknown> | undefined
  await act(async () => {
    p1 = api!.run('refresh', { force: true }, { key: 'row:1', pluginId: 'ext:other', conversationId: 42 })
    p2 = api!.run('refresh', { force: true }, { key: 'row:2' })
  })
  assert.equal(calls.length, 1, 'second concurrent run call must be dropped by synchronous mutex')
  assert.deepEqual(calls[0], { actionId: 'refresh', input: { force: true }, options: { pluginId: 'ext:other', conversationId: 42 } })
  assert.equal(await p2, undefined)
  assert.equal(container.querySelector('div')?.getAttribute('data-pending'), 'true')
  assert.equal(container.querySelector('div')?.getAttribute('data-key'), 'row:1')

  await act(async () => {
    resolveFirst?.({ ok: true })
    await p1
  })
  assert.equal(container.querySelector('div')?.getAttribute('data-pending'), 'false')
  assert.equal(container.querySelector('div')?.getAttribute('data-key'), '')

  shouldFail = true
  await act(async () => {
    const res = await api!.run('remove', { id: 'x' })
    assert.equal(res, undefined)
  })
  assert.equal(container.querySelector('div')?.getAttribute('data-err'), 'remove: boom from server')
  assert.deepEqual(notices, [{ msg: 'remove: boom from server', tone: 'error' }])

  await act(async () => {
    api!.clearError()
  })
  assert.equal(container.querySelector('div')?.getAttribute('data-err'), '')

  await act(async () => {
    root.unmount()
  })
  container.remove()
})

test('usePluginAction DOM: exception inside onSuccess does not report server success as request failure or wedge mutex', { timeout: 60_000 }, async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const notices: Array<{ msg: string; tone: string | undefined }> = []
  const hookErrors: string[] = []
  const callErrors: string[] = []
  let throwInHookSuccess = false
  let callCount = 0

  const pluginCtx = {
    pluginId: 'builtin:act-demo',
    callAction: async (actionId: string) => {
      callCount += 1
      return { ok: true, actionId, seq: callCount }
    },
    fetchRoute: async () => { throw new Error('fetchRoute not implemented in test stub') },
    submitInput: async () => {},
    openScreen: () => {},
    openSplitScreen: () => {},
    openConversationDrawer: () => {},
    openArtifact: () => {},
    openWorkbench: () => {},
    closeWorkbench: () => {},
    notify: (msg: string, tone?: string) => {
      notices.push({ msg, tone })
    },
    getPluginDoc: async () => undefined,
    getPluginSessionDoc: async () => undefined,
    theme: 'dark' as const,
    locale: 'en' as const,
    translate: (text: unknown) => (typeof text === 'string' ? text : ''),
  }

  let api: ReturnType<typeof usePluginAction> | undefined
  function Harness() {
    api = usePluginAction({
      notifyError: true,
      onSuccess: () => {
        if (throwInHookSuccess) throw new Error('hook callback bug')
      },
      onError: (msg) => {
        hookErrors.push(msg)
      },
    })
    return e('div', { 'data-pending': String(api.pending), 'data-key': api.pendingKey ?? '', 'data-err': api.error ?? '' })
  }

  try {
    await act(async () => {
      root.render(e(PluginClientContext.Provider, { value: pluginCtx }, e(Harness)))
    })

    let caughtCallErr: unknown
    await act(async () => {
      try {
        await api!.run('save', { id: 1 }, {
          onSuccess: () => {
            throw new Error('per-call callback bug')
          },
          onError: (msg) => {
            callErrors.push(msg)
          },
        })
      } catch (err) {
        caughtCallErr = err
      }
    })
    assert.ok(caughtCallErr instanceof Error && caughtCallErr.message === 'per-call callback bug')
    assert.equal(container.querySelector('div')?.getAttribute('data-err'), '')
    assert.equal(container.querySelector('div')?.getAttribute('data-pending'), 'false')
    assert.equal(container.querySelector('div')?.getAttribute('data-key'), '')
    assert.deepEqual(notices, [])
    assert.deepEqual(callErrors, [])
    assert.deepEqual(hookErrors, [])

    throwInHookSuccess = true
    let caughtHookErr: unknown
    await act(async () => {
      try {
        await api!.run('save', { id: 2 })
      } catch (err) {
        caughtHookErr = err
      }
    })
    assert.ok(caughtHookErr instanceof Error && caughtHookErr.message === 'hook callback bug')
    assert.equal(container.querySelector('div')?.getAttribute('data-err'), '')
    assert.equal(container.querySelector('div')?.getAttribute('data-pending'), 'false')
    assert.deepEqual(notices, [])
    assert.deepEqual(hookErrors, [])

    throwInHookSuccess = false
    let thirdResult: unknown
    await act(async () => {
      thirdResult = await api!.run('save', { id: 3 })
    })
    assert.deepEqual(thirdResult, { ok: true, actionId: 'save', seq: 3 })
    assert.equal(callCount, 3)
  } finally {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
})
