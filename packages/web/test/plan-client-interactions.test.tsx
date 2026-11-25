/**
 * builtin:plan client module (compiled TSX via @helmx/plugin-build) interactive DOM & contract tests (T9):
 * - Fast Refresh & strict clientRoot containment invariants (compiled bundle exports only PascalCase components + CSS);
 * - PlanStatusBadge: null on standby / subagent / non-human conversations (zero subscriptions);
 *   clickable toggle between normal / planning / awaitingApproval states;
 * - PlanActiveTray: null (0px) in normal mode; compact DockTray + expandable DockTrayRow in planning/awaitingApproval,
 *   showing draft title + vN, open workbench 'plan', and exit via set_mode -> 'normal';
 * - PlanWorkbenchPanel: loading / error+retry / empty / draft markdown / approved artifact metadata + openArtifact /
 *   mode toggle action;
 * - PlanToolRow: 26px .trace-row for plan_save & plan_propose consuming presentationMeta ONLY (never JSON.parse(result)),
 *   click opening 'plan' workbench, and honest fallback when presentationMeta is missing or isError is true.
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
  ComposerStatusSlotProps,
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  ToolViewProps,
  WorkbenchPanelProps,
} from '@helmx/protocol'
import type { PluginClientHostPort, PluginSessionDocKey, PluginSessionDocState } from '@helmx/plugin-client'
import {
  PLAN_BADGES_DOC,
  PLAN_COMMAND_ID,
  PLAN_COMMAND_SLASH,
  PLAN_PANEL_ID,
  PLAN_PLUGIN_ID,
  PLAN_SESSION_DOC,
  PLAN_TOOL_PROPOSE,
  PLAN_TOOL_SAVE,
} from '../../plugins/src/plan/client/types.ts'
import {
  PLAN_COPY,
  planOutcomeLabel,
  planSaveStatsLabel,
} from '../../plugins/src/plan/client/copy.ts'
import {
  isPlanEligibleConversation,
  parsePlanSessionView,
  parsePlanToolPresentationMeta,
} from '../../plugins/src/plan/client/models.ts'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const { createRoot } = await import('react-dom/client')
const HelmxPluginClient = await import('@helmx/plugin-client')
const { PluginClientContext, PluginClientHostContext, resolveLocalizedText } = HelmxPluginClient
const { importCompiledPluginClient, mountPluginNamespaceGlobals } = await import('./helpers/plugin-namespace.js')

const e = React.createElement
const PLAN_CLIENT_ROOT = fileURLToPath(new URL('../../plugins/src/plan/client', import.meta.url))
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

interface PlanClientComponents {
  PlanStatusBadge: (p: ComposerStatusSlotProps) => React.ReactElement | null
  PlanActiveTray: (p: Partial<ComposerScopeProps>) => React.ReactElement | null
  PlanWorkbenchPanel: (p: Partial<WorkbenchPanelProps>) => React.ReactElement
  PlanToolRow: (p: ToolViewProps) => React.ReactElement
}

let rawModule: Record<string, unknown>
let components: PlanClientComponents

describe('plan-client-interactions', () => {
  before(async () => {
    mountPluginNamespaceGlobals({ ...HelmxPluginClient })
    const mod = await importCompiledPluginClient(PLAN_PLUGIN_ID, PLAN_CLIENT_ROOT, 'index.tsx')
    rawModule = mod
    components = {
      PlanStatusBadge: mod['PlanStatusBadge'] as PlanClientComponents['PlanStatusBadge'],
      PlanActiveTray: mod['PlanActiveTray'] as PlanClientComponents['PlanActiveTray'],
      PlanWorkbenchPanel: mod['PlanWorkbenchPanel'] as PlanClientComponents['PlanWorkbenchPanel'],
      PlanToolRow: mod['PlanToolRow'] as PlanClientComponents['PlanToolRow'],
    }
  }, { timeout: 60_000 })

  interface ActionCallRecord {
    actionId: string
    input: unknown
    options?: CallActionOptions
  }

  interface SpyCtx extends PluginClientContextType {
    actionCalls: ActionCallRecord[]
    workbenchCalls: Array<{ panelId: string | undefined; params: Record<string, unknown> | undefined }>
    artifactCalls: string[]
    notifyCalls: Array<{ message: string; tone?: string }>
  }

  function makeSpyCtx(overrides: Partial<SpyCtx> & Partial<PluginClientContextType> = {}): SpyCtx {
    const actionCalls: ActionCallRecord[] = []
    const workbenchCalls: Array<{ panelId: string | undefined; params: Record<string, unknown> | undefined }> = []
    const artifactCalls: string[] = []
    const notifyCalls: Array<{ message: string; tone?: string }> = []
    const locale = overrides.locale ?? 'en'
    const base: PluginClientContextType = {
      pluginId: PLAN_PLUGIN_ID,
      callAction: async (actionId, input, options) => {
        actionCalls.push({ actionId, input, ...(options !== undefined ? { options } : {}) })
        return {}
      },
      fetchRoute: async () => {
        throw new Error('fetchRoute not implemented in test stub')
      },
      submitInput: async () => {},
      openScreen: () => {},
      openSplitScreen: () => {},
      openConversationDrawer: () => {},
      openArtifact: (artifactId) => {
        artifactCalls.push(artifactId)
      },
      openWorkbench: (panelId, params) => {
        workbenchCalls.push({ panelId, params })
      },
      closeWorkbench: () => {},
      notify: (message, tone) => {
        notifyCalls.push({ message, tone })
      },
      getPluginDoc: async () => undefined,
      getPluginSessionDoc: async () => undefined,
      conversationId: 10,
      theme: 'dark',
      locale,
      translate: (text) => resolveLocalizedText(text, locale),
    }
    return Object.assign(base, {
      actionCalls,
      workbenchCalls,
      artifactCalls,
      notifyCalls,
      ...overrides,
    })
  }

  function makeConv(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
    return {
      id,
      title: `Conversation #${id}`,
      profileId: 'assistant',
      tags: [],
      cwd: '/repo',
      model: 'openai/gpt-5',
      thinkingLevel: '',
      status: 'idle',
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
    const subscribedKeys: PluginSessionDocKey[] = []
    const retriedKeys: PluginSessionDocKey[] = []

    const keyStr = (key: PluginSessionDocKey): string => `${key.pluginId}/${key.docName}/${key.conversationId}`
    const EMPTY: PluginSessionDocState = { hasValue: false, deleted: false, connected: false }

    const emit = (k: string): void => {
      const set = listeners.get(k)
      if (!set) return
      for (const listener of [...set]) listener()
    }

    const setDocValue = (conversationId: number, value: unknown): void => {
      const k = `${PLAN_PLUGIN_ID}/${PLAN_SESSION_DOC}/${conversationId}`
      states.set(k, { value, hasValue: true, deleted: false, connected: true })
      emit(k)
    }

    const setDocError = (conversationId: number, error: string): void => {
      const k = `${PLAN_PLUGIN_ID}/${PLAN_SESSION_DOC}/${conversationId}`
      states.set(k, { hasValue: false, deleted: false, connected: false, error })
      emit(k)
    }

    const noopUnsub = (): void => {}
    const hostPort = {
      getAuthenticated: () => false,
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
        subscribedKeys.push(key)
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
      retrySessionDoc: (key: PluginSessionDocKey) => {
        retriedKeys.push(key)
      },
      loadConversationDetail: async () => {},
    } as unknown as PluginClientHostPort

    return { hostPort, subscribedKeys, retriedKeys, setDocValue, setDocError }
  }

  async function mountWithSessionHost(
    ctx: PluginClientContextType,
    element: React.ReactElement,
    harness = createSessionDocHarness(),
  ): Promise<{
    host: HTMLElement
    harness: ReturnType<typeof createSessionDocHarness>
    unmount: () => Promise<void>
  }> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        e(
          PluginClientHostContext.Provider,
          { value: harness.hostPort },
          e(PluginClientContext.Provider, { value: ctx }, element),
        ),
      )
    })
    return {
      host,
      harness,
      unmount: async () => {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      },
    }
  }

  test('locked shared contract constants, Fast Refresh exports, CSS output, and pure parsers', { timeout: 60_000 }, () => {
    assert.equal(PLAN_PLUGIN_ID, 'builtin:plan')
    assert.equal(PLAN_SESSION_DOC, 'plan')
    assert.equal(PLAN_BADGES_DOC, 'plan-badges')
    assert.equal(PLAN_PANEL_ID, 'plan')
    assert.equal(PLAN_COMMAND_ID, 'toggle-plan')
    assert.equal(PLAN_COMMAND_SLASH, 'plan')
    assert.equal(PLAN_TOOL_SAVE, 'plan_save')
    assert.equal(PLAN_TOOL_PROPOSE, 'plan_propose')

    const exportNames = Object.keys(rawModule).filter((k) => k !== '__helmxClientCss').sort()
    assert.deepEqual(exportNames, ['PlanActiveTray', 'PlanStatusBadge', 'PlanToolRow', 'PlanWorkbenchPanel'])
    for (const name of exportNames) {
      assert.match(name, /^[A-Z]/)
      assert.equal(typeof rawModule[name], 'function')
    }
    const cssText = rawModule['__helmxClientCss']
    assert.equal(typeof cssText, 'string')
    assert.match(cssText as string, /\.plan-status-btn/)
    assert.match(cssText as string, /\.plan-workbench/)

    assert.equal(isPlanEligibleConversation(undefined), false)
    assert.equal(isPlanEligibleConversation(makeConv(1)), true)
    assert.equal(isPlanEligibleConversation(makeConv(2, { ownedBy: 'human' })), true)
    assert.equal(isPlanEligibleConversation(makeConv(3, { ownedBy: 'helmx' })), false)
    assert.equal(isPlanEligibleConversation(makeConv(4, { parentConversationId: 1 })), false)

    assert.equal(parsePlanSessionView(null), undefined)
    assert.equal(parsePlanSessionView({ mode: 'invalid' }), undefined)
    assert.deepEqual(
      parsePlanSessionView({
        mode: 'planning',
        awaitingApproval: true,
        draft: { title: 'Auth Plan', markdown: '# Steps', version: 2, updatedAt: 1000 },
      }),
      {
        mode: 'planning',
        awaitingApproval: true,
        draft: { title: 'Auth Plan', markdown: '# Steps', version: 2, updatedAt: 1000 },
      },
    )

    assert.equal(parsePlanToolPresentationMeta(undefined), undefined)
    assert.equal(parsePlanToolPresentationMeta({ kind: 'propose', title: 'X', version: 1, outcome: 'bogus' }), undefined)
    assert.deepEqual(
      parsePlanToolPresentationMeta({ kind: 'save', title: 'Auth Plan', version: 1, lineCount: 10, charCount: 250 }),
      { kind: 'save', title: 'Auth Plan', version: 1, lineCount: 10, charCount: 250 },
    )

    // Zero Emoji & non-empty bilingual check across PLAN_COPY
    for (const [key, entry] of Object.entries(PLAN_COPY)) {
      assert.ok(entry.en.trim().length > 0, `PLAN_COPY.${key}.en must be non-empty`)
      assert.ok(entry['zh-CN'].trim().length > 0, `PLAN_COPY.${key}['zh-CN'] must be non-empty`)
      assert.equal(EMOJI_RE.test(entry.en), false, `PLAN_COPY.${key}.en must contain no Emoji`)
      assert.equal(EMOJI_RE.test(entry['zh-CN']), false, `PLAN_COPY.${key}['zh-CN'] must contain no Emoji`)
    }
    assert.equal(planOutcomeLabel('approved', 'zh-CN'), '已批准')
    assert.equal(planSaveStatsLabel(1, 42, 'en'), '1 line · 42 chars')
  })

  test('PlanStatusBadge: returns null on standby/subagent/non-human without subscribing; toggles and reflects planning & awaitingApproval', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 10 })

    // 1. Standby draft (conversation === undefined)
    const standbyHarness = createSessionDocHarness()
    const standbyMount = await mountWithSessionHost(
      spy,
      e(components.PlanStatusBadge, { effectiveModel: 'openai/gpt-5', profileId: 'assistant' }),
      standbyHarness,
    )
    try {
      assert.equal(standbyMount.host.textContent ?? '', '')
      assert.ok(standbyMount.host.querySelector('button') === null)
      assert.equal(standbyHarness.subscribedKeys.length, 0, 'standby draft must not open sessionDoc subscription')
    } finally {
      await standbyMount.unmount()
    }

    // 2. Subagent conversation (parentConversationId !== undefined)
    const subHarness = createSessionDocHarness()
    const subMount = await mountWithSessionHost(
      spy,
      e(components.PlanStatusBadge, { conversation: makeConv(11, { parentConversationId: 10 }) }),
      subHarness,
    )
    try {
      assert.equal(subMount.host.textContent ?? '', '')
      assert.equal(subHarness.subscribedKeys.length, 0, 'subagent must not open sessionDoc subscription')
    } finally {
      await subMount.unmount()
    }

    // 3. Non-human conversation (ownedBy === 'helmx')
    const helmxHarness = createSessionDocHarness()
    const helmxMount = await mountWithSessionHost(
      spy,
      e(components.PlanStatusBadge, { conversation: makeConv(12, { ownedBy: 'helmx' }) }),
      helmxHarness,
    )
    try {
      assert.equal(helmxMount.host.textContent ?? '', '')
      assert.equal(helmxHarness.subscribedKeys.length, 0, 'helmx-owned conversation must not open sessionDoc subscription')
    } finally {
      await helmxMount.unmount()
    }

    // 4. Eligible top-level human conversation: normal -> click toggle -> planning -> awaitingApproval
    const liveHarness = createSessionDocHarness({
      [`${PLAN_PLUGIN_ID}/${PLAN_SESSION_DOC}/10`]: {
        hasValue: true,
        deleted: false,
        connected: true,
        value: { mode: 'normal', awaitingApproval: false },
      },
    })
    const liveMount = await mountWithSessionHost(
      spy,
      e(components.PlanStatusBadge, { conversation: makeConv(10) }),
      liveHarness,
    )
    try {
      const btn = liveMount.host.querySelector<HTMLButtonElement>('button.plan-status-btn')
      assert.ok(btn !== null, 'expected PlanStatusBadge button on top-level human conversation')
      assert.equal(btn.getAttribute('aria-pressed'), 'false')
      assert.equal(btn.getAttribute('data-plan-mode'), 'normal')
      assert.ok(btn.classList.contains('plan-status-btn--normal'))
      assert.match(btn.textContent ?? '', /^Plan$/)
      assert.equal(EMOJI_RE.test(btn.textContent ?? ''), false)

      await act(async () => {
        btn.click()
      })
      assert.equal(spy.actionCalls.length, 1)
      assert.deepEqual(spy.actionCalls[0], {
        actionId: 'toggle',
        input: { conversationId: 10 },
        options: { conversationId: 10 },
      })

      // Push planning sessionDoc update
      await act(async () => {
        liveHarness.setDocValue(10, { mode: 'planning', awaitingApproval: false })
      })
      assert.equal(btn.getAttribute('aria-pressed'), 'true')
      assert.equal(btn.getAttribute('data-plan-mode'), 'planning')
      assert.ok(btn.classList.contains('plan-status-btn--planning'))
      assert.match(btn.textContent ?? '', /Planning/)

      // Push awaitingApproval sessionDoc update
      await act(async () => {
        liveHarness.setDocValue(10, { mode: 'planning', awaitingApproval: true })
      })
      assert.equal(btn.getAttribute('data-plan-awaiting'), 'true')
      assert.ok(btn.classList.contains('plan-status-btn--awaiting'))
      assert.match(btn.textContent ?? '', /Awaiting approval/)
      const light = btn.querySelector('.helmx-status-light')
      assert.ok(light !== null)
      assert.equal(light.getAttribute('data-tone'), 'blocked')
    } finally {
      await liveMount.unmount()
    }
  })

  test('PlanActiveTray: null in normal mode; renders compact DockTray/DockTrayRow in planning & awaitingApproval, opens workbench & exits via set_mode', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 20 })
    const harness = createSessionDocHarness({
      [`${PLAN_PLUGIN_ID}/${PLAN_SESSION_DOC}/20`]: {
        hasValue: true,
        deleted: false,
        connected: true,
        value: { mode: 'normal', awaitingApproval: false },
      },
    })

    const mounted = await mountWithSessionHost(
      spy,
      e(components.PlanActiveTray, { conversation: makeConv(20) }),
      harness,
    )
    try {
      // 1. Normal mode -> zero-height null
      assert.equal(mounted.host.textContent ?? '', '')
      assert.ok(mounted.host.querySelector('.dock-tray') === null)

      // 2. Planning mode with saved draft
      await act(async () => {
        harness.setDocValue(20, {
          mode: 'planning',
          awaitingApproval: false,
          draft: {
            title: 'Migrate Auth Pipeline',
            markdown: '# Plan\n1. Step one',
            version: 2,
            updatedAt: 1_700_000_000_000,
          },
        })
      })
      const tray = mounted.host.querySelector('.dock-tray')
      assert.ok(tray !== null, 'planning mode must render DockTray')
      assert.equal(tray.classList.contains('dock-tray-warn'), false)
      assert.match(tray.textContent ?? '', /Planning/)
      assert.match(tray.textContent ?? '', /Migrate Auth Pipeline/)
      assert.match(tray.textContent ?? '', /v2/)
      assert.equal(EMOJI_RE.test(tray.textContent ?? ''), false)

      // Click View plan button -> opens workbench 'plan'
      const viewBtn = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        (b.textContent ?? '').includes('View plan'),
      )
      assert.ok(viewBtn !== undefined, 'expected View plan button')
      await act(async () => {
        viewBtn.click()
      })
      assert.deepEqual(spy.workbenchCalls, [{ panelId: 'plan', params: undefined }])

      // Expand DockTray to inspect DockTrayRow
      const toggleBtn = mounted.host.querySelector<HTMLButtonElement>('.dock-tray-bar-toggle')
      assert.ok(toggleBtn !== null)
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false')
      await act(async () => {
        toggleBtn.click()
      })
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true')
      const rowMain = mounted.host.querySelector<HTMLButtonElement>('.dock-tray-row-main')
      assert.ok(rowMain !== null, 'expected DockTrayRow when expanded')
      assert.match(rowMain.textContent ?? '', /Migrate Auth Pipeline/)
      assert.match(rowMain.textContent ?? '', /v2/)
      await act(async () => {
        rowMain.click()
      })
      assert.equal(spy.workbenchCalls.length, 2)
      assert.deepEqual(spy.workbenchCalls[1], { panelId: 'plan', params: undefined })

      // 3. awaitingApproval -> warn DockTray
      await act(async () => {
        harness.setDocValue(20, {
          mode: 'planning',
          awaitingApproval: true,
          draft: {
            title: 'Migrate Auth Pipeline',
            markdown: '# Plan\n1. Step one',
            version: 3,
            updatedAt: 1_700_000_000_500,
          },
        })
      })
      assert.equal(tray.classList.contains('dock-tray-warn'), true)
      assert.match(tray.textContent ?? '', /Awaiting approval/)
      assert.match(tray.textContent ?? '', /v3/)

      // 4. Click Exit button -> calls set_mode -> 'normal'
      const exitBtn = mounted.host.querySelector<HTMLButtonElement>('.plan-tray-exit-btn')
      assert.ok(exitBtn !== null, 'expected Exit planning button')
      await act(async () => {
        exitBtn.click()
      })
      assert.deepEqual(spy.actionCalls[0], {
        actionId: 'set_mode',
        input: { conversationId: 20, mode: 'normal' },
        options: { conversationId: 20 },
      })

      // SessionDoc transitions back to normal -> tray disappears
      await act(async () => {
        harness.setDocValue(20, { mode: 'normal', awaitingApproval: false })
      })
      assert.equal(mounted.host.textContent ?? '', '')
      assert.ok(mounted.host.querySelector('.dock-tray') === null)
    } finally {
      await mounted.unmount()
    }
  })

  test('PlanWorkbenchPanel: loading, error+retry, empty state, formatted draft markdown, approved artifact metadata, and mode toggle', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 30 })

    // 1. Loading & Error + Retry
    const errHarness = createSessionDocHarness()
    const errMount = await mountWithSessionHost(
      spy,
      e(components.PlanWorkbenchPanel, { conversation: makeConv(30) }),
      errHarness,
    )
    try {
      assert.match(errMount.host.textContent ?? '', /Loading plan/)
      await act(async () => {
        errHarness.setDocError(30, 'session doc unavailable')
      })
      assert.match(errMount.host.textContent ?? '', /session doc unavailable/)
      const retryBtn = Array.from(errMount.host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        (b.textContent ?? '').includes('Retry'),
      )
      assert.ok(retryBtn !== undefined)
      await act(async () => {
        retryBtn.click()
      })
      assert.equal(errHarness.retriedKeys.length, 1)
      assert.deepEqual(errHarness.retriedKeys[0], {
        pluginId: PLAN_PLUGIN_ID,
        docName: PLAN_SESSION_DOC,
        conversationId: 30,
      })
    } finally {
      await errMount.unmount()
    }

    // 2. Empty state -> Draft state -> Approved state
    const harness = createSessionDocHarness({
      [`${PLAN_PLUGIN_ID}/${PLAN_SESSION_DOC}/30`]: {
        hasValue: true,
        deleted: false,
        connected: true,
        value: { mode: 'normal', awaitingApproval: false },
      },
    })
    const mounted = await mountWithSessionHost(
      spy,
      e(components.PlanWorkbenchPanel, { conversation: makeConv(30) }),
      harness,
    )
    try {
      assert.match(mounted.host.textContent ?? '', /Normal/)
      assert.match(mounted.host.textContent ?? '', /No plan draft yet/)
      assert.ok(mounted.host.querySelector('.empty-state') !== null)

      // Toggle mode from workbench button
      const enterBtn = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        (b.textContent ?? '').includes('Enter planning'),
      )
      assert.ok(enterBtn !== undefined)
      await act(async () => {
        enterBtn.click()
      })
      assert.deepEqual(spy.actionCalls[0], {
        actionId: 'toggle',
        input: { conversationId: 30 },
        options: { conversationId: 30 },
      })

      // Draft populated with Markdown + raw HTML probe
      await act(async () => {
        harness.setDocValue(30, {
          mode: 'planning',
          awaitingApproval: false,
          draft: {
            title: 'Refactor Session State',
            markdown: '# Overview\n\n- Update `hooks.ts`\n- Add tests\n\n<script>window.__xss=1</script>',
            version: 4,
            updatedAt: 1_700_000_000_000,
          },
        })
      })
      assert.match(mounted.host.textContent ?? '', /Planning/)
      assert.match(mounted.host.textContent ?? '', /Refactor Session State/)
      assert.match(mounted.host.textContent ?? '', /v4/)
      assert.match(mounted.host.textContent ?? '', /Updated /)
      assert.match(mounted.host.textContent ?? '', /Exit planning/)
      assert.ok(mounted.host.querySelector('.plan-markdown h1') !== null, 'markdown headings must render structurally')
      assert.ok(mounted.host.querySelector('.plan-markdown li') !== null, 'markdown lists must render structurally')
      assert.ok(mounted.host.querySelector('.plan-markdown script') === null, 'raw HTML script tags must never be injected')

      // Approved artifact info populated
      await act(async () => {
        harness.setDocValue(30, {
          mode: 'normal',
          awaitingApproval: false,
          draft: {
            title: 'Refactor Session State',
            markdown: '# Overview\n\n- Done',
            version: 4,
            updatedAt: 1_700_000_000_000,
          },
          approved: {
            title: 'Refactor Session State',
            version: 4,
            artifactId: 'art_plan_123',
            artifactName: 'refactor-session-state-v4.md',
            approvedAt: 1_700_000_001_000,
            handoffUsed: true,
            executionModel: 'anthropic/claude-sonnet-4-6',
          },
        })
      })
      const panelText = mounted.host.textContent ?? ''
      assert.match(panelText, /Latest Approved Plan/)
      assert.match(panelText, /refactor-session-state-v4\.md/)
      assert.match(panelText, /art_plan_123/)
      assert.match(panelText, /Yes \(switched on approval\)/)
      assert.match(panelText, /anthropic\/claude-sonnet-4-6/)
      assert.equal(EMOJI_RE.test(panelText), false)

      const artifactBtn = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        (b.textContent ?? '').includes('refactor-session-state-v4.md'),
      )
      assert.ok(artifactBtn !== undefined)
      await act(async () => {
        artifactBtn.click()
      })
      assert.deepEqual(spy.artifactCalls, ['art_plan_123'])

      // Same-session approval (handoffUsed: false, awaitingApproval: true transition check)
      await act(async () => {
        harness.setDocValue(30, {
          mode: 'planning',
          awaitingApproval: true,
          approved: {
            title: 'Earlier Plan',
            version: 1,
            artifactId: 'art_old',
            artifactName: 'earlier-v1.md',
            approvedAt: 1_700_000_000_000,
            handoffUsed: false,
          },
        })
      })
      const sameSessionText = mounted.host.textContent ?? ''
      assert.match(sameSessionText, /Awaiting approval/)
      assert.match(sameSessionText, /No plan draft yet/)
      assert.match(sameSessionText, /No \(same session\)/)
      assert.match(sameSessionText, /earlier-v1\.md/)
    } finally {
      await mounted.unmount()
    }

    // 3. Missing conversationId renders clean EmptyState
    const noConvMount = await mountWithSessionHost(
      makeSpyCtx({ conversationId: undefined }),
      e(components.PlanWorkbenchPanel, {}),
    )
    try {
      assert.ok(noConvMount.host.querySelector('.empty-state') !== null)
      assert.match(noConvMount.host.textContent ?? '', /Select a conversation/)
    } finally {
      await noConvMount.unmount()
    }
  })

  test('PlanToolRow: renders plan_save & plan_propose from presentationMeta only (never JSON.parse(result)), handles error & missing meta honestly', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 40 })

    // 1. plan_save with valid presentationMeta
    const saveMount = await mountWithSessionHost(
      spy,
      e(components.PlanToolRow, {
        callId: 'call-save-1',
        toolName: PLAN_TOOL_SAVE,
        status: 'done',
        conversationId: 40,
        durationMs: 120,
        presentationMeta: {
          kind: 'save',
          title: 'Database Migration Plan',
          version: 3,
          lineCount: 28,
          charCount: 940,
        },
        result: '{"title":"IGNORED_FROM_RESULT","version":999}',
      }),
    )
    try {
      const text = saveMount.host.textContent ?? ''
      assert.match(text, /Save plan/)
      assert.match(text, /Database Migration Plan/)
      assert.match(text, /28 lines · 940 chars/)
      assert.match(text, /v3/)
      assert.match(text, /120ms/)
      assert.doesNotMatch(text, /IGNORED_FROM_RESULT/)
      assert.doesNotMatch(text, /999/)
      assert.equal(EMOJI_RE.test(text), false)

      const rowBtn = saveMount.host.querySelector<HTMLButtonElement>('button.trace-row')
      assert.ok(rowBtn !== null)
      await act(async () => {
        rowBtn.click()
      })
      assert.deepEqual(spy.workbenchCalls, [{ panelId: 'plan', params: undefined }])
    } finally {
      await saveMount.unmount()
    }

    // 2. plan_propose approved_handoff
    const proposeMount = await mountWithSessionHost(
      spy,
      e(components.PlanToolRow, {
        callId: 'call-prop-1',
        toolName: PLAN_TOOL_PROPOSE,
        status: 'done',
        conversationId: 40,
        durationMs: 2500,
        presentationMeta: {
          kind: 'propose',
          title: 'Database Migration Plan',
          version: 3,
          outcome: 'approved_handoff',
          artifactId: 'art_1',
          artifactName: 'plan.md',
          executionModel: 'openai/gpt-5',
        },
      }),
    )
    try {
      const text = proposeMount.host.textContent ?? ''
      assert.match(text, /Propose plan/)
      assert.match(text, /Database Migration Plan/)
      assert.match(text, /openai\/gpt-5/)
      assert.match(text, /v3/)
      assert.match(text, /Approved · Handoff/)
      const light = proposeMount.host.querySelector('.helmx-status-light')
      assert.ok(light !== null)
      assert.equal(light.getAttribute('data-tone'), 'done')
    } finally {
      await proposeMount.unmount()
    }

    // 3. plan_propose revised & cancelled outcomes
    const revisedMount = await mountWithSessionHost(
      spy,
      e(components.PlanToolRow, {
        callId: 'call-prop-2',
        toolName: PLAN_TOOL_PROPOSE,
        status: 'done',
        conversationId: 40,
        presentationMeta: {
          kind: 'propose',
          title: 'Retry Backoff Plan',
          version: 1,
          outcome: 'revised',
        },
      }),
    )
    try {
      assert.match(revisedMount.host.textContent ?? '', /Revision requested/)
      const light = revisedMount.host.querySelector('.helmx-status-light')
      assert.ok(light !== null)
      assert.equal(light.getAttribute('data-tone'), 'pending')
    } finally {
      await revisedMount.unmount()
    }

    // 4. Missing presentationMeta when done: MUST NOT JSON.parse(props.result)!
    const missingMetaMount = await mountWithSessionHost(
      spy,
      e(components.PlanToolRow, {
        callId: 'call-missing-meta',
        toolName: PLAN_TOOL_SAVE,
        status: 'done',
        conversationId: 40,
        input: { title: 'Input Only Title' },
        result: '{"title":"FORBIDDEN_PARSE","version":77}',
      }),
    )
    try {
      const text = missingMetaMount.host.textContent ?? ''
      assert.match(text, /Input Only Title/)
      assert.match(text, /Details unavailable/)
      assert.doesNotMatch(text, /FORBIDDEN_PARSE/)
      assert.doesNotMatch(text, /v77/)
    } finally {
      await missingMetaMount.unmount()
    }

    // 5. isError fallback & zh-CN locale
    const errMount = await mountWithSessionHost(
      makeSpyCtx({ conversationId: 40, locale: 'zh-CN' }),
      e(components.PlanToolRow, {
        callId: 'call-err-1',
        toolName: PLAN_TOOL_PROPOSE,
        status: 'error',
        isError: true,
        conversationId: 40,
        result: 'plan_draft_missing: call plan_save first\nstack trace line 2',
      }),
    )
    try {
      const row = errMount.host.querySelector('.trace-row')
      assert.ok(row !== null)
      assert.equal(row.classList.contains('trace-row-error'), true)
      const text = errMount.host.textContent ?? ''
      assert.match(text, /提交计划审批/)
      assert.match(text, /plan_draft_missing: call plan_save first/)
      assert.doesNotMatch(text, /stack trace line 2/)
      const light = errMount.host.querySelector('.helmx-status-light')
      assert.ok(light !== null)
      assert.equal(light.getAttribute('data-tone'), 'failed')
    } finally {
      await errMount.unmount()
    }

    // 6. Running & cancelled states
    const runningMount = await mountWithSessionHost(
      spy,
      e(components.PlanToolRow, {
        callId: 'call-run-1',
        toolName: PLAN_TOOL_SAVE,
        status: 'running',
        conversationId: 40,
        input: { title: 'Streaming Draft' },
      }),
    )
    try {
      const text = runningMount.host.textContent ?? ''
      assert.match(text, /Save plan/)
      assert.match(text, /Streaming Draft/)
      const light = runningMount.host.querySelector('.helmx-status-light')
      assert.ok(light !== null)
      assert.equal(light.getAttribute('data-tone'), 'working')
    } finally {
      await runningMount.unmount()
    }

    const cancelledMount = await mountWithSessionHost(
      spy,
      e(components.PlanToolRow, {
        callId: 'call-cancel-1',
        toolName: PLAN_TOOL_PROPOSE,
        status: 'done',
        conversationId: 40,
        presentationMeta: {
          kind: 'propose',
          title: 'Cancelled Draft',
          version: 2,
          outcome: 'cancelled',
        },
      }),
    )
    try {
      assert.match(cancelledMount.host.textContent ?? '', /Cancelled/)
      const light = cancelledMount.host.querySelector('.helmx-status-light')
      assert.ok(light !== null)
      assert.equal(light.getAttribute('data-tone'), 'aborted')
    } finally {
      await cancelledMount.unmount()
    }
  })
})
