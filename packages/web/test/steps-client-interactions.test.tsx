/**
 * builtin:steps compiled client TSX interactive DOM & contract tests:
 * - Fast Refresh & strict clientRoot containment invariants (exports only PascalCase React components + CSS);
 * - StepsActiveTray:
 *   - hidden (null) on standby (`conversationId === undefined`), ineligible (`helmx`-owned / subagent),
 *     absent/empty steps, or dismissed state;
 *   - desktop (`innerWidth > 680`) defaults expanded when in progress, auto-collapses when transitioning
 *     to `allTerminal`, and auto-expands on fresh in-progress list after completed list;
 *   - mobile (`innerWidth <= 680`) defaults collapsed to the 32px summary bar;
 *   - paused/interrupted visual state when `conversation.status !== 'working'` (stopped spinning dot + warning/paused tag);
 *   - manual expand/collapse toggle preserved across step progress updates;
 *   - clicking dismiss button calls `dismiss` action and hides tray optimistically until next version;
 *   - zero Emoji anywhere in rendered text or copy dictionaries.
 * - StepsToolRow:
 *   - compact 26px `.trace-row` rendering strictly from `presentationMeta` (never `JSON.parse(result)`)
 *     across running, in-progress, completed, cleared, error, and missing-meta states.
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as React from 'react'
import { act } from 'react'
import type {
  CallActionOptions,
  ComposerScopeProps,
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  ToolViewProps,
} from '@helmx/protocol'
import type {
  PluginClientHostPort,
  PluginSessionDocKey,
  PluginSessionDocState,
} from '@helmx/plugin-client'
import {
  STEPS_COPY,
  stepsToolRowSummary,
} from '../../plugins/src/steps/client/copy.ts'
import {
  deriveStepsTraySummary,
  isStepsEligibleConversation,
  parseStepsSessionView,
  parseStepsToolPresentationMeta,
} from '../../plugins/src/steps/client/models.ts'
import {
  STEPS_PLUGIN_ID,
  STEPS_SESSION_DOC,
  STEPS_TOOL_UPDATE,
  type StepsSessionView,
} from '../../plugins/src/steps/client/types.ts'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const { createRoot } = await import('react-dom/client')
const HelmxUi = await import('@helmx/ui')
const HelmxPluginClient = await import('@helmx/plugin-client')
const { resolveLocalizedText } = HelmxUi
const { PluginClientContext, PluginClientHostContext } = HelmxPluginClient
const { importCompiledPluginClient, mountPluginNamespaceGlobals } = await import('./helpers/plugin-namespace.js')

const e = React.createElement
const STEPS_CLIENT_ROOT = fileURLToPath(new URL('../../plugins/src/steps/client', import.meta.url))
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

interface StepsClientComponents {
  StepsActiveTray: (p: Partial<ComposerScopeProps>) => React.ReactElement | null
  StepsToolRow: (p: ToolViewProps) => React.ReactElement
}

let rawModule: Record<string, unknown>
let components: StepsClientComponents

describe('steps-client-interactions', () => {
  before(
    async () => {
      mountPluginNamespaceGlobals({ ...HelmxPluginClient })
      const mod = await importCompiledPluginClient(STEPS_PLUGIN_ID, STEPS_CLIENT_ROOT, 'index.tsx')
      rawModule = mod
      components = {
        StepsActiveTray: mod['StepsActiveTray'] as StepsClientComponents['StepsActiveTray'],
        StepsToolRow: mod['StepsToolRow'] as StepsClientComponents['StepsToolRow'],
      }
    },
    { timeout: 60_000 },
  )

  interface ActionCallRecord {
    actionId: string
    input: unknown
    options?: CallActionOptions
  }

  interface SpyCtx extends PluginClientContextType {
    actionCalls: ActionCallRecord[]
  }

  function makeSpyCtx(overrides: Partial<SpyCtx> & Partial<PluginClientContextType> = {}): SpyCtx {
    const actionCalls: ActionCallRecord[] = []
    const locale = overrides.locale ?? 'en'
    const base: PluginClientContextType = {
      pluginId: STEPS_PLUGIN_ID,
      callAction: async (actionId, input, options) => {
        actionCalls.push({ actionId, input, ...(options !== undefined ? { options } : {}) })
        return {
          steps: [{ title: 'Step 1', status: 'in_progress' }],
          version: 1,
          updatedAt: 1000,
          dismissed: true,
          allTerminal: false,
        } satisfies StepsSessionView
      },
      fetchRoute: async () => {
        throw new Error('fetchRoute not used')
      },
      submitInput: async () => {},
      openScreen: () => {},
      openSplitScreen: () => {},
      openConversationDrawer: () => {},
      openArtifact: () => {},
      openWorkbench: () => {},
      closeWorkbench: () => {},
      notify: () => {},
      getPluginDoc: async () => undefined,
      getPluginSessionDoc: async () => undefined,
      conversationId: 10,
      theme: 'dark',
      locale,
      translate: (text) => resolveLocalizedText(text, locale),
    }
    return Object.assign(base, {
      actionCalls,
      ...overrides,
    })
  }

  function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
    return {
      id,
      title: `Conv #${id}`,
      profileId: 'assistant',
      tags: [],
      cwd: '/repo',
      model: 'openai/gpt-5',
      thinkingLevel: '',
      status: 'working',
      stateChangeSeq: 1,
      completionSeq: 0,
      unread: false,
      pinned: false,
      pendingAskCount: 0,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      ...overrides,
    }
  }

  function createSessionDocHarness(initial: Record<string, PluginSessionDocState> = {}) {
    const states = new Map<string, PluginSessionDocState>(Object.entries(initial))
    const listeners = new Map<string, Set<() => void>>()
    const EMPTY: PluginSessionDocState = { hasValue: false, deleted: false, connected: false }
    const keyStr = (key: PluginSessionDocKey): string => `${key.pluginId}/${key.docName}/${key.conversationId}`

    const emit = (k: string): void => {
      const set = listeners.get(k)
      if (!set) return
      for (const listener of [...set]) listener()
    }

    const setDocValue = (conversationId: number, value: unknown): void => {
      const k = `${STEPS_PLUGIN_ID}/${STEPS_SESSION_DOC}/${conversationId}`
      states.set(k, { value, hasValue: true, deleted: false, connected: true })
      emit(k)
    }

    const noopUnsub = (): void => {}
    const hostPort = {
      getAuthenticated: () => true,
      subscribeAuthenticated: () => noopUnsub,
      getTheme: () => 'dark',
      subscribePrefs: () => noopUnsub,
      getConversations: () => [],
      subscribeConversations: () => noopUnsub,
      getConversationSummary: () => undefined,
      subscribeConversationSummary: () => noopUnsub,
      getConversationDetail: () => undefined,
      subscribeConversationDetail: () => noopUnsub,
      getConversationLive: () => undefined,
      subscribeConversationLive: () => noopUnsub,
      getConversationPendingAsks: () => [],
      subscribeConversationPendingAsks: () => noopUnsub,
      getLoadError: () => undefined,
      subscribeLoadError: () => noopUnsub,
      getPluginDocValue: () => undefined,
      subscribePluginDoc: () => noopUnsub,
      ensurePluginDoc: async () => undefined,
      subscribeSessionDoc: (key: PluginSessionDocKey, listener: () => void) => {
        const k = keyStr(key)
        let set = listeners.get(k)
        if (!set) {
          set = new Set()
          listeners.set(k, set)
        }
        set.add(listener)
        return () => {
          set?.delete(listener)
        }
      },
      getSessionDocState: (key: PluginSessionDocKey) => states.get(keyStr(key)) ?? EMPTY,
      retrySessionDoc: () => {},
      loadConversationDetail: async () => {},
    } as unknown as PluginClientHostPort

    return { hostPort, setDocValue }
  }

  async function mountWithHost(
    ctx: PluginClientContextType,
    element: React.ReactElement,
    harness = createSessionDocHarness(),
  ) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const renderEl = async (next: React.ReactElement): Promise<void> => {
      await act(async () => {
        root.render(
          e(
            PluginClientHostContext.Provider,
            { value: harness.hostPort },
            e(PluginClientContext.Provider, { value: ctx }, next),
          ),
        )
      })
    }
    await renderEl(element)
    return {
      host,
      harness,
      rerender: renderEl,
      unmount: async () => {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      },
    }
  }

  function withWindowWidth<T>(width: number, fn: () => Promise<T>): Promise<T> {
    const prev = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
    return fn().finally(() => {
      Object.defineProperty(window, 'innerWidth', { value: prev, configurable: true })
    })
  }

  test('locked shared contracts, Fast Refresh exports, CSS, parsers, and zero-Emoji copy', { timeout: 60_000 }, () => {
    assert.equal(STEPS_PLUGIN_ID, 'builtin:steps')
    assert.equal(STEPS_SESSION_DOC, 'steps')
    assert.equal(STEPS_TOOL_UPDATE, 'update_steps')

    const exportNames = Object.keys(rawModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(exportNames, ['StepsActiveTray', 'StepsToolRow'])
    for (const name of exportNames) {
      assert.match(name, /^[A-Z]/)
      assert.equal(typeof rawModule[name], 'function')
    }
    const cssText = rawModule['__helmxClientCss'] as string
    assert.equal(typeof cssText, 'string')
    assert.match(cssText, /\.steps-tray-row/)
    assert.match(cssText, /\.steps-trace-row/)

    assert.equal(isStepsEligibleConversation(undefined), false)
    assert.equal(isStepsEligibleConversation(makeConv(1)), true)
    assert.equal(isStepsEligibleConversation(makeConv(2, { ownedBy: 'helmx' })), false)
    assert.equal(isStepsEligibleConversation(makeConv(3, { parentConversationId: 1 })), false)

    assert.equal(parseStepsSessionView(null), undefined)
    assert.equal(
      parseStepsToolPresentationMeta({ version: 1, steps: [{ title: 'X', status: 'bad' }] }),
      undefined,
    )

    const summary = deriveStepsTraySummary(
      {
        steps: [
          { title: 'Step 1', status: 'done' },
          { title: 'Step 2', status: 'in_progress' },
        ],
        version: 1,
        updatedAt: 1000,
        dismissed: false,
        allTerminal: false,
      },
      'idle',
    )
    assert.equal(summary.phase, 'paused')
    assert.equal(summary.warn, true)
    assert.equal(summary.activeTitle, 'Step 2')

    for (const [key, entry] of Object.entries(STEPS_COPY)) {
      assert.ok(entry.en.trim().length > 0, `STEPS_COPY.${key}.en must be non-empty`)
      assert.ok(entry['zh-CN'].trim().length > 0, `STEPS_COPY.${key}['zh-CN'] must be non-empty`)
      assert.equal(EMOJI_RE.test(entry.en), false, `STEPS_COPY.${key}.en must not contain Emoji`)
      assert.equal(EMOJI_RE.test(entry['zh-CN']), false, `STEPS_COPY.${key}['zh-CN'] must not contain Emoji`)
    }
  })

  test('StepsActiveTray: hidden on standby/ineligible/empty, desktop auto-expand & auto-collapse, mobile collapsed', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx({ conversationId: undefined })
    const mStandby = await mountWithHost(ctx, e(components.StepsActiveTray, {}))
    try {
      assert.equal(mStandby.host.textContent, '')
    } finally {
      await mStandby.unmount()
    }

    const harness = createSessionDocHarness()
    const convCtx = makeSpyCtx({ conversationId: 10, locale: 'zh-CN' })
    harness.setDocValue(10, {
      steps: [
        { title: '阅读现有代码', status: 'done' },
        { title: '实现核心逻辑', status: 'in_progress' },
        { title: '执行全量验收', status: 'pending' },
      ],
      version: 1,
      updatedAt: 1000,
      dismissed: false,
      allTerminal: false,
    } satisfies StepsSessionView)

    // Ineligible (helmx-owned) stays null even if sessionDoc exists
    const mIneligible = await mountWithHost(
      convCtx,
      e(components.StepsActiveTray, { conversation: makeConv(10, { ownedBy: 'helmx' }) }),
      harness,
    )
    try {
      assert.equal(mIneligible.host.textContent, '')
    } finally {
      await mIneligible.unmount()
    }

    // Desktop (> 680px) defaults expanded while in progress, then auto-collapses when allTerminal becomes true
    await withWindowWidth(1280, async () => {
      const mount = await mountWithHost(
        convCtx,
        e(components.StepsActiveTray, { conversation: makeConv(10, { status: 'working' }) }),
        harness,
      )
      try {
        const listBefore = mount.host.querySelector('.dock-tray-list')
        assert.ok(listBefore !== null, 'Desktop must expand list by default while in progress')
        assert.ok(mount.host.textContent?.includes('阅读现有代码'))
        assert.ok(mount.host.textContent?.includes('实现核心逻辑'))
        assert.equal(EMOJI_RE.test(mount.host.textContent ?? ''), false)

        // Manual collapse is preserved across in-progress step update
        const toggleBtn = mount.host.querySelector('.dock-tray-bar-toggle') as HTMLButtonElement
        await act(async () => {
          toggleBtn.click()
        })
        assert.ok(mount.host.querySelector('.dock-tray-list') === null, 'Manual collapse hides list')
        await act(async () => {
          harness.setDocValue(10, {
            steps: [
              { title: '阅读现有代码', status: 'done' },
              { title: '实现核心逻辑', status: 'done' },
              { title: '执行全量验收', status: 'in_progress' },
            ],
            version: 2,
            updatedAt: 2000,
            dismissed: false,
            allTerminal: false,
          } satisfies StepsSessionView)
        })
        assert.ok(mount.host.querySelector('.dock-tray-list') === null, 'Must respect manual collapse mid-task')

        // User re-expands; transitioning to allTerminal auto-collapses to compact summary bar
        await act(async () => {
          toggleBtn.click()
        })
        assert.ok(mount.host.querySelector('.dock-tray-list') !== null)
        await act(async () => {
          harness.setDocValue(10, {
            steps: [
              { title: '阅读现有代码', status: 'done' },
              { title: '实现核心逻辑', status: 'done' },
              { title: '执行全量验收', status: 'done' },
            ],
            version: 3,
            updatedAt: 3000,
            dismissed: false,
            allTerminal: true,
          } satisfies StepsSessionView)
        })
        assert.ok(mount.host.querySelector('.dock-tray-list') === null, 'Must auto-collapse when all steps terminal')
        assert.ok(mount.host.textContent?.includes('3/3'))
        assert.ok(mount.host.textContent?.includes('已完成 3/3 步'))

        // Fresh in-progress checklist re-expands on desktop
        await act(async () => {
          harness.setDocValue(10, {
            steps: [{ title: '下一阶段任务', status: 'in_progress' }],
            version: 4,
            updatedAt: 4000,
            dismissed: false,
            allTerminal: false,
          } satisfies StepsSessionView)
        })
        assert.ok(mount.host.querySelector('.dock-tray-list') !== null)
      } finally {
        await mount.unmount()
      }
    })

    // Mobile (<= 680px) defaults collapsed even while in progress
    await withWindowWidth(390, async () => {
      const mMobile = await mountWithHost(
        convCtx,
        e(components.StepsActiveTray, { conversation: makeConv(10, { status: 'working' }) }),
        harness,
      )
      try {
        assert.ok(mMobile.host.querySelector('.dock-tray-list') === null, 'Mobile must default to collapsed 32px bar')
        assert.ok(mMobile.host.textContent?.includes('下一阶段任务'))
      } finally {
        await mMobile.unmount()
      }
    })
  })

  test('StepsActiveTray: paused state on idle/aborted & optimistic dismiss reset on next version', { timeout: 60_000 }, async () => {
    const harness = createSessionDocHarness()
    let returnedView: StepsSessionView = {
      steps: [{ title: 'Patch auth', status: 'in_progress' }],
      version: 2,
      updatedAt: 2000,
      dismissed: true,
      allTerminal: false,
      settledOutcome: 'aborted',
    }
    const ctx = makeSpyCtx({
      conversationId: 10,
      callAction: async (actionId, input, options) => {
        ctx.actionCalls.push({ actionId, input, ...(options !== undefined ? { options } : {}) })
        return returnedView
      },
    })
    harness.setDocValue(10, {
      steps: [
        { title: 'Inspect config', status: 'done' },
        { title: 'Patch auth', status: 'in_progress' },
        { title: 'Skip cleanup', status: 'skipped' },
        { title: 'Deploy', status: 'failed' },
      ],
      version: 2,
      updatedAt: 2000,
      dismissed: false,
      allTerminal: false,
      settledOutcome: 'aborted',
    } satisfies StepsSessionView)

    await withWindowWidth(1280, async () => {
      const mount = await mountWithHost(
        ctx,
        e(components.StepsActiveTray, { conversation: makeConv(10, { status: 'idle' }) }),
        harness,
      )
      try {
        assert.ok(mount.host.querySelector('.dock-tray-warn') !== null, 'Paused/failed checklist should highlight warn border')
        assert.ok(mount.host.querySelector('.helmx-status-light-aborted') !== null, 'Aborted in_progress renders aborted status light instead of spinning working')
        assert.ok(mount.host.querySelector('.helmx-status-light-working') === null, 'Paused tray must not spin working dot')
        assert.ok(mount.host.textContent?.includes('Skipped'))
        assert.ok(mount.host.textContent?.includes('Failed'))

        const dismissBtn = mount.host.querySelector('.steps-tray-dismiss-btn') as HTMLButtonElement
        assert.ok(dismissBtn !== null)
        await act(async () => {
          dismissBtn.click()
        })
        assert.equal(ctx.actionCalls.length, 1)
        assert.equal(ctx.actionCalls[0]?.actionId, 'dismiss')
        assert.deepEqual(ctx.actionCalls[0]?.input, { conversationId: 10 })
        assert.equal(mount.host.textContent, '', 'Tray must optimistically hide on dismiss')

        // Next update_steps version unhides automatically
        returnedView = { ...returnedView, version: 3, dismissed: false }
        await act(async () => {
          harness.setDocValue(10, {
            steps: [{ title: 'Resume auth patch', status: 'in_progress' }],
            version: 3,
            updatedAt: 3000,
            dismissed: false,
            allTerminal: false,
          } satisfies StepsSessionView)
        })
        assert.ok(mount.host.textContent?.includes('Resume auth patch'))
      } finally {
        await mount.unmount()
      }
    })
  })

  test('StepsToolRow: renders running, completed, cleared, error, and fallback states strictly from presentationMeta', { timeout: 60_000 }, async () => {
    const ctx = makeSpyCtx({ locale: 'en' })
    const mount = await mountWithHost(
      ctx,
      e(components.StepsToolRow, {
        conversationId: 10,
        callId: 'c1',
        toolName: STEPS_TOOL_UPDATE,
        status: 'running',
      }),
    )
    try {
      assert.ok(mount.host.textContent?.includes('Update steps'))
      assert.ok(mount.host.querySelector('.helmx-status-light-working') !== null)

      // Done state consumes presentationMeta (never JSON.parse(result))
      await mount.rerender(
        e(components.StepsToolRow, {
          conversationId: 10,
          callId: 'c2',
          toolName: STEPS_TOOL_UPDATE,
          status: 'done',
          result: 'Updated steps: 2/3 done, current: Run verify.',
          durationMs: 42,
          presentationMeta: {
            version: 2,
            total: 3,
            done: 2,
            inProgressCount: 1,
            failedCount: 0,
            skippedCount: 0,
            allTerminal: false,
            cleared: false,
            inProgressTitle: 'Run verify',
            steps: [
              { title: 'A', status: 'done' },
              { title: 'B', status: 'done' },
              { title: 'Run verify', status: 'in_progress' },
            ],
          },
        }),
      )
      assert.ok(mount.host.textContent?.includes('Run verify'))
      assert.ok(mount.host.textContent?.includes('2/3'))
      assert.ok(mount.host.querySelector('.helmx-status-light-done') !== null)
      assert.equal(
        stepsToolRowSummary(
          parseStepsToolPresentationMeta({
            version: 3,
            steps: [],
          })!,
          'en',
        ),
        'Cleared checklist',
      )

      // Error state
      await mount.rerender(
        e(components.StepsToolRow, {
          conversationId: 10,
          callId: 'c3',
          toolName: STEPS_TOOL_UPDATE,
          status: 'error',
          isError: true,
          result: 'steps may contain at most 12 items',
        }),
      )
      assert.ok(mount.host.querySelector('.trace-row-error') !== null)
      assert.ok(mount.host.textContent?.includes('steps may contain at most 12 items'))
    } finally {
      await mount.unmount()
    }
  })
})
