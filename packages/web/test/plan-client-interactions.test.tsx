/**
 * builtin:plan client module (compiled TSX via @helmx/plugin-build) interactive DOM & contract tests (T9):
 * - Fast Refresh & strict clientRoot containment invariants (compiled bundle exports only PascalCase components + CSS);
 * - PlanToolbarButton: standby pre-arm toggle via draftMeta/setDraftMeta with zero subscriptions;
 *   null on standby without setDraftMeta / subagent / non-human conversations;
 *   clickable toggle between normal / planning / awaitingApproval states on persisted conversations;
 * - PlanActiveTray: null (0px) in normal mode and when planning with no draft & not awaitingApproval;
 *   compact DockTray + expandable DockTrayRow when draft exists or awaitingApproval;
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
  ComposerMenuSlotProps,
  ComposerScopeProps,
  ComposerToolbarSlotProps,
  ConversationSummary,
  PluginClientContext as PluginClientContextType,
  ToolViewProps,
  WorkbenchPanelProps,
} from '@helmx/protocol'
import type { CodeBlockViewProps, MarkdownViewProps, PluginClientHostPort, PluginSessionDocKey, PluginSessionDocState } from '@helmx/plugin-client'
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
  planDiffSkippedLabel,
  planDiffTabLabel,
  planOutcomeLabel,
  planSaveStatsLabel,
} from '../../plugins/src/plan/client/copy.ts'
import {
  MAX_PLAN_DIFF_DP_CELLS,
  MAX_PLAN_DIFF_LINES,
  PLAN_DIFF_CONTEXT_LINES,
  computePlanDraftDiff,
} from '../../plugins/src/plan/client/diff.ts'
import {
  isPlanEligibleConversation,
  parsePlanSessionView,
  parsePlanToolPresentationMeta,
} from '../../plugins/src/plan/client/models.ts'
import { ensureHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()

const { createRoot } = await import('react-dom/client')
const HelmxUi = await import('@helmx/ui')
const HelmxPluginClient = await import('@helmx/plugin-client')
const { DropdownMenuContent, DropdownMenuRoot, resolveLocalizedText } = HelmxUi
const {
  ComposerCommandContext,
  MarkdownText,
  PluginClientContext,
  PluginClientHostContext,
  createComposerCommandRegistry,
} = HelmxPluginClient
const { importCompiledPluginClient, mountPluginNamespaceGlobals } = await import('./helpers/plugin-namespace.js')

const e = React.createElement
const PLAN_CLIENT_ROOT = fileURLToPath(new URL('../../plugins/src/plan/client', import.meta.url))
const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

interface PlanClientComponents {
  PlanMenuItem: (p: ComposerMenuSlotProps) => React.ReactElement | null
  PlanToolbarButton: (p: ComposerToolbarSlotProps) => React.ReactElement | null
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
      PlanMenuItem: mod['PlanMenuItem'] as PlanClientComponents['PlanMenuItem'],
      PlanToolbarButton: mod['PlanToolbarButton'] as PlanClientComponents['PlanToolbarButton'],
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
      markdown: {
        view: ({ text, className, onLinkClick, conversationId }: MarkdownViewProps) =>
          e(
            'div',
            {
              className: className ? `msg-ai-body ${className}` : 'msg-ai-body',
              ...(conversationId !== undefined ? { 'data-md-conv-id': String(conversationId) } : {}),
            },
            e(MarkdownText, { text, onLinkClick }),
          ),
        codeBlock: ({ code }: CodeBlockViewProps) => e('pre', null, code),
      },
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
    rerender: (nextElement: React.ReactElement) => Promise<void>
    unmount: () => Promise<void>
  }> {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const renderElement = async (nextEl: React.ReactElement): Promise<void> => {
      await act(async () => {
        root.render(
          e(
            PluginClientHostContext.Provider,
            { value: harness.hostPort },
            e(PluginClientContext.Provider, { value: ctx }, nextEl),
          ),
        )
      })
    }
    await renderElement(element)
    return {
      host,
      harness,
      rerender: renderElement,
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
    assert.deepEqual(exportNames, [
      'PlanActiveTray',
      'PlanMenuItem',
      'PlanToolRow',
      'PlanToolbarButton',
      'PlanWorkbenchPanel',
    ])
    for (const name of exportNames) {
      assert.match(name, /^[A-Z]/)
      assert.equal(typeof rawModule[name], 'function')
    }
    const cssText = rawModule['__helmxClientCss']
    assert.equal(typeof cssText, 'string')
    assert.match(cssText as string, /\.plan-toolbar-btn/)
    assert.match(cssText as string, /\.plan-workbench/)
    assert.match(cssText as string, /\.plan-tray-preview/)
    assert.match(cssText as string, /\.plan-editor/)

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
        awaitingApproval: false,
        draft: { title: 'Auth Plan', markdown: '# Steps', version: 2, updatedAt: 1000 },
        previousDraft: { title: 'Auth Plan v1', markdown: '# Initial', version: 1, updatedAt: 900 },
      }),
      {
        mode: 'planning',
        awaitingApproval: false,
        draft: { title: 'Auth Plan', markdown: '# Steps', version: 2, updatedAt: 1000 },
        previousDraft: { title: 'Auth Plan v1', markdown: '# Initial', version: 1, updatedAt: 900 },
      },
    )
    // Suppresses previousDraft when version matches draft.version or draft is missing
    assert.deepEqual(
      parsePlanSessionView({
        mode: 'planning',
        awaitingApproval: false,
        draft: { title: 'Auth Plan', markdown: '# Steps', version: 2, updatedAt: 1000 },
        previousDraft: { title: 'Same Version', markdown: '# Initial', version: 2, updatedAt: 900 },
      }),
      {
        mode: 'planning',
        awaitingApproval: false,
        draft: { title: 'Auth Plan', markdown: '# Steps', version: 2, updatedAt: 1000 },
      },
    )
    assert.deepEqual(
      parsePlanSessionView({
        mode: 'normal',
        awaitingApproval: false,
        previousDraft: { title: 'Orphan', markdown: '# Old', version: 1, updatedAt: 900 },
      }),
      { mode: 'normal', awaitingApproval: false },
    )

    assert.equal(planDiffTabLabel(2, 'en'), 'Diff v2')
    assert.equal(planDiffTabLabel(2, 'zh-CN'), '对比 v2')
    assert.equal(planDiffSkippedLabel(1, 'en'), '… 1 unchanged line omitted …')
    assert.equal(planDiffSkippedLabel(4, 'en'), '… 4 unchanged lines omitted …')
    assert.equal(planDiffSkippedLabel(4, 'zh-CN'), '… 省略 4 行未改动内容 …')
    assert.equal(planDiffTabLabel(1, 'zh-CN').includes('规划'), false)
    assert.equal(planDiffSkippedLabel(2, 'zh-CN').includes('规划'), false)

    assert.equal(parsePlanToolPresentationMeta(undefined), undefined)
    assert.equal(parsePlanToolPresentationMeta({ kind: 'propose', title: 'X', version: 1, outcome: 'bogus' }), undefined)
    assert.deepEqual(
      parsePlanToolPresentationMeta({ kind: 'save', title: 'Auth Plan', version: 1, lineCount: 10, charCount: 250 }),
      { kind: 'save', title: 'Auth Plan', version: 1, lineCount: 10, charCount: 250 },
    )

    // Zero Emoji, non-empty bilingual, and unified zh-CN terminology ("计划", never "规划") across PLAN_COPY
    for (const [key, entry] of Object.entries(PLAN_COPY)) {
      assert.ok(entry.en.trim().length > 0, `PLAN_COPY.${key}.en must be non-empty`)
      assert.ok(entry['zh-CN'].trim().length > 0, `PLAN_COPY.${key}['zh-CN'] must be non-empty`)
      assert.equal(EMOJI_RE.test(entry.en), false, `PLAN_COPY.${key}.en must contain no Emoji`)
      assert.equal(EMOJI_RE.test(entry['zh-CN']), false, `PLAN_COPY.${key}['zh-CN'] must contain no Emoji`)
      assert.equal(entry['zh-CN'].includes('规划'), false, `PLAN_COPY.${key}['zh-CN'] must use 计划, never 规划`)
    }
    assert.equal(planOutcomeLabel('approved', 'zh-CN'), '已批准')
    assert.equal(planOutcomeLabel('approved_handoff', 'zh-CN'), '已批准 · 新上下文')
    assert.equal(planSaveStatsLabel(1, 42, 'en'), '1 line · 42 chars')
  })

  test('PlanToolbarButton: active-only compact pill (hidden shortcut anchor in normal/unarmed state, Ctrl+. still active, sleek pill + exit when active)', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 10 })

    // 1. Standby draft without setDraftMeta -> null, zero subscriptions
    const standbyReadOnlyHarness = createSessionDocHarness()
    const standbyReadOnlyMount = await mountWithSessionHost(
      spy,
      e(components.PlanToolbarButton, { effectiveModel: 'openai/gpt-5', profileId: 'assistant' }),
      standbyReadOnlyHarness,
    )
    try {
      assert.equal(standbyReadOnlyMount.host.textContent ?? '', '')
      assert.ok(standbyReadOnlyMount.host.querySelector('button') === null)
      assert.equal(standbyReadOnlyHarness.subscribedKeys.length, 0)
    } finally {
      await standbyReadOnlyMount.unmount()
    }

    // 1b. Standby draft WITH setDraftMeta -> unarmed renders hidden shortcut anchor (no visible button), Ctrl+. still arms, armed renders sleek pill + close icon
    const standbyHarness = createSessionDocHarness()
    const metaWrites: Array<{ key: string; value: unknown }> = []
    const standbyMount = await mountWithSessionHost(
      spy,
      e(components.PlanToolbarButton, {
        effectiveModel: 'openai/gpt-5',
        profileId: 'assistant',
        draftMeta: undefined,
        setDraftMeta: (key, value) => metaWrites.push({ key, value }),
      }),
      standbyHarness,
    )
    try {
      assert.ok(
        standbyMount.host.querySelector('button.plan-toolbar-btn') === null,
        'unarmed standby draft must not render a toolbar button',
      )
      const anchor = standbyMount.host.querySelector<HTMLElement>('.plan-shortcut-anchor')
      assert.ok(anchor !== null, 'expected hidden shortcut anchor while unarmed')
      assert.equal(anchor.hidden, true)
      assert.equal(anchor.getAttribute('data-plan-mode'), 'normal')
      assert.equal(standbyHarness.subscribedKeys.length, 0, 'standby draft must not open sessionDoc subscription')

      // Ctrl+. shortcut toggles standby draft even when unarmed/hidden; mismatched panel ('split') is ignored
      await act(async () => {
        window.dispatchEvent(
          new window.CustomEvent('helmx:shortcut', { detail: { action: 'toggle-plan-mode', panel: 'split' } }),
        )
      })
      assert.equal(metaWrites.length, 0)
      await act(async () => {
        window.dispatchEvent(
          new window.CustomEvent('helmx:shortcut', { detail: { action: 'toggle-plan-mode', panel: 'primary' } }),
        )
      })
      assert.deepEqual(metaWrites[0], { key: 'builtin:plan', value: { mode: 'planning' } })

      // Re-render armed state -> compact active pill renders with exit icon
      await standbyMount.rerender(
        e(components.PlanToolbarButton, {
          effectiveModel: 'openai/gpt-5',
          profileId: 'assistant',
          draftMeta: { [PLAN_PLUGIN_ID]: { mode: 'planning' } },
          setDraftMeta: (key, value) => metaWrites.push({ key, value }),
        }),
      )
      const armedBtn = standbyMount.host.querySelector<HTMLButtonElement>('button.plan-toolbar-btn')
      assert.ok(armedBtn !== null, 'expected compact active pill when standby is armed')
      assert.equal(armedBtn.getAttribute('aria-pressed'), 'true')
      assert.equal(armedBtn.getAttribute('data-plan-mode'), 'planning')
      assert.ok(armedBtn.classList.contains('plan-toolbar-btn--planning'))
      assert.ok(armedBtn.querySelector('.plan-toolbar-btn-close') !== null)
      assert.match(armedBtn.textContent ?? '', /Plan/)
      assert.match(armedBtn.getAttribute('title') ?? '', /\(Ctrl\+\.\)/)
      assert.equal(EMOJI_RE.test(armedBtn.textContent ?? ''), false)

      await act(async () => {
        armedBtn.click()
      })
      assert.deepEqual(metaWrites[1], { key: 'builtin:plan', value: undefined })

      // Disabled prop propagates cleanly when active
      await standbyMount.rerender(
        e(components.PlanToolbarButton, {
          effectiveModel: 'openai/gpt-5',
          profileId: 'assistant',
          draftMeta: { [PLAN_PLUGIN_ID]: { mode: 'planning' } },
          setDraftMeta: (key, value) => metaWrites.push({ key, value }),
          disabled: true,
        }),
      )
      assert.equal(standbyMount.host.querySelector<HTMLButtonElement>('button.plan-toolbar-btn')?.disabled, true)
    } finally {
      await standbyMount.unmount()
    }

    // 2. Subagent conversation (parentConversationId !== undefined)
    const subHarness = createSessionDocHarness()
    const subMount = await mountWithSessionHost(
      spy,
      e(components.PlanToolbarButton, { conversation: makeConv(11, { parentConversationId: 10 }) }),
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
      e(components.PlanToolbarButton, { conversation: makeConv(12, { ownedBy: 'helmx' }) }),
      helmxHarness,
    )
    try {
      assert.equal(helmxMount.host.textContent ?? '', '')
      assert.equal(helmxHarness.subscribedKeys.length, 0, 'helmx-owned conversation must not open sessionDoc subscription')
    } finally {
      await helmxMount.unmount()
    }

    // 4. Eligible top-level human conversation: normal hidden anchor + Ctrl+. -> planning pill -> awaitingApproval
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
      e(components.PlanToolbarButton, { conversation: makeConv(10) }),
      liveHarness,
    )
    try {
      assert.ok(
        liveMount.host.querySelector('button.plan-toolbar-btn') === null,
        'normal persisted conversation must render zero visible toolbar button',
      )
      const anchor = liveMount.host.querySelector<HTMLElement>('.plan-shortcut-anchor')
      assert.ok(anchor !== null && anchor.hidden)

      await act(async () => {
        window.dispatchEvent(
          new window.CustomEvent('helmx:shortcut', { detail: { action: 'toggle-plan-mode', panel: 'primary' } }),
        )
      })
      assert.equal(spy.actionCalls.length, 1)
      assert.deepEqual(spy.actionCalls[0], {
        actionId: 'toggle',
        input: { conversationId: 10 },
        options: { conversationId: 10 },
      })

      // Push planning sessionDoc update -> active compact pill appears and clicking exits
      await act(async () => {
        liveHarness.setDocValue(10, { mode: 'planning', awaitingApproval: false })
      })
      const btn = liveMount.host.querySelector<HTMLButtonElement>('button.plan-toolbar-btn')
      assert.ok(btn !== null, 'expected PlanToolbarButton pill when planning is active')
      assert.equal(btn.getAttribute('aria-pressed'), 'true')
      assert.equal(btn.getAttribute('data-plan-mode'), 'planning')
      assert.ok(btn.classList.contains('plan-toolbar-btn--planning'))
      assert.ok(btn.querySelector('.plan-toolbar-btn-close') !== null)
      assert.match(btn.textContent ?? '', /Plan/)
      assert.match(btn.getAttribute('title') ?? '', /\(Ctrl\+\.\)/)
      assert.equal(EMOJI_RE.test(btn.textContent ?? ''), false)

      await act(async () => {
        btn.click()
      })
      assert.equal(spy.actionCalls.length, 2)
      assert.deepEqual(spy.actionCalls[1], {
        actionId: 'toggle',
        input: { conversationId: 10 },
        options: { conversationId: 10 },
      })

      // Push awaitingApproval sessionDoc update
      await act(async () => {
        liveHarness.setDocValue(10, { mode: 'planning', awaitingApproval: true })
      })
      assert.equal(btn.getAttribute('data-plan-awaiting'), 'true')
      assert.ok(btn.classList.contains('plan-toolbar-btn--awaiting'))
      assert.match(btn.textContent ?? '', /Awaiting approval/)
      const light = btn.querySelector('.helmx-status-light')
      assert.ok(light !== null)
      assert.equal(light.getAttribute('data-tone'), 'blocked')
    } finally {
      await liveMount.unmount()
    }
  })

  test('PlanToolbarButton: useComposerCommand registers local toggle handler across standby and eligible conversations only', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 10 })
    const registry = createComposerCommandRegistry()
    const metaWrites: Array<{ key: string; value: unknown }> = []

    const mountWithRegistry = async (element: React.ReactElement, harness = createSessionDocHarness()) => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const renderElement = async (nextEl: React.ReactElement): Promise<void> => {
        await act(async () => {
          root.render(
            e(
              ComposerCommandContext.Provider,
              { value: registry },
              e(
                PluginClientHostContext.Provider,
                { value: harness.hostPort },
                e(PluginClientContext.Provider, { value: spy }, nextEl),
              ),
            ),
          )
        })
      }
      await renderElement(element)
      return {
        host,
        rerender: renderElement,
        unmount: async () => {
          await act(async () => {
            root.unmount()
          })
          host.remove()
        },
      }
    }

    // 1. Standby draft: unarmed & armed register under builtin:plan/toggle-plan, disabled guards invocation
    const standbyMount = await mountWithRegistry(
      e(components.PlanToolbarButton, {
        effectiveModel: 'openai/gpt-5',
        profileId: 'assistant',
        draftMeta: undefined,
        setDraftMeta: (key, value) => metaWrites.push({ key, value }),
      }),
    )
    try {
      assert.equal(registry.has(PLAN_PLUGIN_ID, PLAN_COMMAND_ID), true)
      const armRes = registry.invoke(PLAN_PLUGIN_ID, PLAN_COMMAND_ID)
      assert.equal(armRes.handled, true)
      assert.deepEqual(metaWrites[0], { key: 'builtin:plan', value: { mode: 'planning' } })

      await standbyMount.rerender(
        e(components.PlanToolbarButton, {
          effectiveModel: 'openai/gpt-5',
          profileId: 'assistant',
          draftMeta: { [PLAN_PLUGIN_ID]: { mode: 'planning' } },
          setDraftMeta: (key, value) => metaWrites.push({ key, value }),
        }),
      )
      assert.equal(registry.has(PLAN_PLUGIN_ID, PLAN_COMMAND_ID), true)
      registry.invoke(PLAN_PLUGIN_ID, PLAN_COMMAND_ID)
      assert.deepEqual(metaWrites[1], { key: 'builtin:plan', value: undefined })

      await standbyMount.rerender(
        e(components.PlanToolbarButton, {
          effectiveModel: 'openai/gpt-5',
          profileId: 'assistant',
          draftMeta: { [PLAN_PLUGIN_ID]: { mode: 'planning' } },
          setDraftMeta: (key, value) => metaWrites.push({ key, value }),
          disabled: true,
        }),
      )
      registry.invoke(PLAN_PLUGIN_ID, PLAN_COMMAND_ID)
      assert.equal(metaWrites.length, 2, 'disabled standby button must ignore command invoke')
    } finally {
      await standbyMount.unmount()
    }
    assert.equal(registry.has(PLAN_PLUGIN_ID, PLAN_COMMAND_ID), false)

    // 2. Eligible top-level human conversation invokes toggle action cleanly
    const convMount = await mountWithRegistry(
      e(components.PlanToolbarButton, { conversation: makeConv(10) }),
    )
    try {
      assert.equal(registry.has(PLAN_PLUGIN_ID, PLAN_COMMAND_ID), true)
      const convRes = registry.invoke(PLAN_PLUGIN_ID, PLAN_COMMAND_ID)
      assert.equal(convRes.handled, true)
      assert.equal(spy.actionCalls.length, 1)
      assert.deepEqual(spy.actionCalls[0], {
        actionId: 'toggle',
        input: { conversationId: 10 },
        options: { conversationId: 10 },
      })
    } finally {
      await convMount.unmount()
    }
    assert.equal(registry.has(PLAN_PLUGIN_ID, PLAN_COMMAND_ID), false)

    // 3. Subagent & helmx-owned conversations never register a command handler
    const subMount = await mountWithRegistry(
      e(components.PlanToolbarButton, { conversation: makeConv(11, { parentConversationId: 10 }) }),
    )
    try {
      assert.equal(registry.has(PLAN_PLUGIN_ID, PLAN_COMMAND_ID), false)
    } finally {
      await subMount.unmount()
    }

    const helmxMount = await mountWithRegistry(
      e(components.PlanToolbarButton, { conversation: makeConv(12, { ownedBy: 'helmx' }) }),
    )
    try {
      assert.equal(registry.has(PLAN_PLUGIN_ID, PLAN_COMMAND_ID), false)
    } finally {
      await helmxMount.unmount()
    }
  })

  test('PlanMenuItem: toggles standby inputMeta & persisted conversation cleanly inside Radix DropdownMenu and returns null on ineligible targets', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 10 })

    // 1. Read-only standby / subagent / helmx-owned return null with zero subscriptions
    for (const [label, menuProps] of [
      ['read-only standby', { effectiveModel: 'openai/gpt-5', profileId: 'assistant' }],
      ['subagent', { conversation: makeConv(11, { parentConversationId: 10 }) }],
      ['helmx-owned', { conversation: makeConv(12, { ownedBy: 'helmx' }) }],
    ] as Array<[string, ComposerMenuSlotProps]>) {
      const h = createSessionDocHarness()
      const m = await mountWithSessionHost(
        spy,
        e(
          DropdownMenuRoot,
          { open: true },
          e(DropdownMenuContent, { inline: true }, e(components.PlanMenuItem, menuProps)),
        ),
        h,
      )
      try {
        assert.ok(m.host.querySelector('[role="menuitem"]') === null, `${label} must render no menu item`)
        assert.equal(h.subscribedKeys.length, 0, `${label} must not subscribe`)
      } finally {
        await m.unmount()
      }
    }

    // 2. Standby draft with setDraftMeta: shows Plan mode, checkmark when armed, and invokes onCloseMenu
    const metaWrites: Array<{ key: string; value: unknown }> = []
    let closeCount = 0
    const standbyHarness = createSessionDocHarness()
    const standbyMount = await mountWithSessionHost(
      spy,
      e(
        DropdownMenuRoot,
        { open: true },
        e(
          DropdownMenuContent,
          { inline: true },
          e(components.PlanMenuItem, {
            effectiveModel: 'openai/gpt-5',
            profileId: 'assistant',
            draftMeta: undefined,
            setDraftMeta: (k, v) => metaWrites.push({ key: k, value: v }),
            onCloseMenu: () => { closeCount += 1 },
          }),
        ),
      ),
      standbyHarness,
    )
    try {
      const item = standbyMount.host.querySelector<HTMLElement>('.plan-menu-item')
      assert.ok(item !== null)
      assert.match(item.textContent ?? '', /Plan mode/)
      assert.match(item.textContent ?? '', /Ctrl\+\./)
      assert.ok(item.querySelector('.helmx-dropdown-item-check') === null)

      await act(async () => {
        item.click()
      })
      assert.deepEqual(metaWrites[0], { key: 'builtin:plan', value: { mode: 'planning' } })
      assert.equal(closeCount, 1)

      await standbyMount.rerender(
        e(
          DropdownMenuRoot,
          { open: true },
          e(
            DropdownMenuContent,
            { inline: true },
            e(components.PlanMenuItem, {
              effectiveModel: 'openai/gpt-5',
              profileId: 'assistant',
              draftMeta: { [PLAN_PLUGIN_ID]: { mode: 'planning' } },
              setDraftMeta: (k, v) => metaWrites.push({ key: k, value: v }),
              onCloseMenu: () => { closeCount += 1 },
            }),
          ),
        ),
      )
      const armedItem = standbyMount.host.querySelector<HTMLElement>('.plan-menu-item')
      assert.ok(armedItem?.classList.contains('plan-menu-item--active'))
      assert.ok(armedItem?.querySelector('.helmx-dropdown-item-check') !== null)
    } finally {
      await standbyMount.unmount()
    }

    // 3. Persisted top-level human conversation: calls toggle and shows checkmark in planning mode
    const liveHarness = createSessionDocHarness({
      [`${PLAN_PLUGIN_ID}/${PLAN_SESSION_DOC}/10`]: {
        hasValue: true,
        deleted: false,
        connected: true,
        value: { mode: 'planning', awaitingApproval: false },
      },
    })
    const liveMount = await mountWithSessionHost(
      spy,
      e(
        DropdownMenuRoot,
        { open: true },
        e(
          DropdownMenuContent,
          { inline: true },
          e(components.PlanMenuItem, { conversation: makeConv(10) }),
        ),
      ),
      liveHarness,
    )
    try {
      const item = liveMount.host.querySelector<HTMLElement>('.plan-menu-item')
      assert.ok(item !== null && item.classList.contains('plan-menu-item--active'))
      assert.ok(item.querySelector('.helmx-dropdown-item-check') !== null)
      await act(async () => {
        item.click()
      })
      assert.equal(spy.actionCalls.length, 1)
      assert.deepEqual(spy.actionCalls[0], {
        actionId: 'toggle',
        input: { conversationId: 10 },
        options: { conversationId: 10 },
      })
    } finally {
      await liveMount.unmount()
    }
  })

  test('PlanActiveTray: renders on draft/awaiting states, includes inline markdown preview, auto-opens workbench on desktop transition only', { timeout: 60_000 }, async () => {
    const spy = makeSpyCtx({ conversationId: 20 })
    const harness = createSessionDocHarness({
      [`${PLAN_PLUGIN_ID}/${PLAN_SESSION_DOC}/20`]: {
        hasValue: true,
        deleted: false,
        connected: true,
        value: { mode: 'normal', awaitingApproval: false },
      },
    })
    const origInnerWidthDesc = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const setViewportWidth = (width: number): void => {
      Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true })
    }
    setViewportWidth(1280)

    const mounted = await mountWithSessionHost(
      spy,
      e(components.PlanActiveTray, { conversation: makeConv(20) }),
      harness,
    )
    try {
      // 1. Normal mode -> zero-height null
      assert.equal(mounted.host.textContent ?? '', '')
      assert.ok(mounted.host.querySelector('.dock-tray') === null)

      // 1b. Planning mode BEFORE any draft or pending ask -> zero-height null (toolbar button is the state indicator)
      await act(async () => {
        harness.setDocValue(20, {
          mode: 'planning',
          awaitingApproval: false,
        })
      })
      assert.equal(mounted.host.textContent ?? '', '')
      assert.ok(mounted.host.querySelector('.dock-tray') === null, 'pre-draft planning mode must suppress redundant DockTray')

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

      // Expand DockTray to inspect DockTrayRow + scrollable inline Markdown preview
      const toggleBtn = mounted.host.querySelector<HTMLButtonElement>('.dock-tray-bar-toggle')
      assert.ok(toggleBtn !== null)
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false')
      await act(async () => {
        toggleBtn.click()
      })
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true')
      assert.equal(mounted.host.querySelector('.plan-tray-preview h1')?.textContent, 'Plan')
      const rowMain = mounted.host.querySelector<HTMLButtonElement>('.dock-tray-row-main')
      assert.ok(rowMain !== null, 'expected DockTrayRow when expanded')
      assert.match(rowMain.textContent ?? '', /Migrate Auth Pipeline/)
      assert.match(rowMain.textContent ?? '', /v2/)
      await act(async () => {
        rowMain.click()
      })
      assert.equal(spy.workbenchCalls.length, 2)
      assert.deepEqual(spy.workbenchCalls[1], { panelId: 'plan', params: undefined })

      // 3. awaitingApproval false -> true transition on desktop auto-opens workbench
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
      assert.equal(spy.workbenchCalls.length, 3, 'desktop transition into awaitingApproval auto-opens workbench')

      // Narrow viewport (<= 900px) transition must NOT auto-open workbench
      setViewportWidth(600)
      await act(async () => {
        harness.setDocValue(20, { mode: 'planning', awaitingApproval: false })
      })
      await act(async () => {
        harness.setDocValue(20, { mode: 'planning', awaitingApproval: true })
      })
      assert.equal(spy.workbenchCalls.length, 3)

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
      if (origInnerWidthDesc) {
        Object.defineProperty(window, 'innerWidth', origInnerWidthDesc)
      }
    }

    // Fresh mount already settled at awaitingApproval: true on desktop must NOT auto-open workbench
    setViewportWidth(1280)
    const spyInitial = makeSpyCtx({ conversationId: 21 })
    const initialAwaitingHarness = createSessionDocHarness({
      [`${PLAN_PLUGIN_ID}/${PLAN_SESSION_DOC}/21`]: {
        hasValue: true,
        deleted: false,
        connected: true,
        value: { mode: 'planning', awaitingApproval: true },
      },
    })
    const initialMount = await mountWithSessionHost(
      spyInitial,
      e(components.PlanActiveTray, { conversation: makeConv(21) }),
      initialAwaitingHarness,
    )
    try {
      assert.equal(spyInitial.workbenchCalls.length, 0)
    } finally {
      await initialMount.unmount()
      if (origInnerWidthDesc) {
        Object.defineProperty(window, 'innerWidth', origInnerWidthDesc)
      }
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
        (b.textContent ?? '').includes('Enter plan mode'),
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
      assert.match(mounted.host.textContent ?? '', /Exit plan mode/)
      assert.ok(mounted.host.querySelector('.plan-markdown h1') !== null, 'markdown headings must render structurally')
      assert.ok(mounted.host.querySelector('.plan-markdown li') !== null, 'markdown lists must render structurally')
      assert.ok(mounted.host.querySelector('.plan-markdown script') === null, 'raw HTML script tags must never be injected')

      // Inline draft editing: external drift warning + Load latest + Save calls update_draft with CAS expectedVersion
      const editBtn = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        (b.textContent ?? '').trim() === 'Edit',
      )
      assert.ok(editBtn !== undefined, 'expected Edit draft button')
      await act(async () => {
        editBtn.click()
      })
      const editorForm = mounted.host.querySelector<HTMLFormElement>('form.plan-editor')
      assert.ok(editorForm !== null, 'clicking Edit should open inline editor')

      // External draft update v5 while human is editing v4 -> shows stale warning & Load latest action
      await act(async () => {
        harness.setDocValue(30, {
          mode: 'planning',
          awaitingApproval: false,
          draft: {
            title: 'Refactor Session State v5',
            markdown: '# Latest v5 body',
            version: 5,
            updatedAt: 1_700_000_000_500,
          },
        })
      })
      assert.match(editorForm.textContent ?? '', /v5/)
      const loadLatestBtn = Array.from(editorForm.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        (b.textContent ?? '').includes('Load latest'),
      )
      assert.ok(loadLatestBtn !== undefined, 'expected Load latest button on version drift')
      await act(async () => {
        loadLatestBtn.click()
      })
      const titleInput = editorForm.querySelector<HTMLInputElement>('input')
      const mdTextarea = editorForm.querySelector<HTMLTextAreaElement>('textarea.plan-editor-textarea')
      assert.equal(titleInput?.value, 'Refactor Session State v5')
      assert.equal(mdTextarea?.value, '# Latest v5 body')

      await act(async () => {
        if (titleInput) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          setter?.call(titleInput, 'Human Edited Title')
          titleInput.dispatchEvent(new Event('input', { bubbles: true }))
        }
        if (mdTextarea) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
          setter?.call(mdTextarea, '# Edited by human')
          mdTextarea.dispatchEvent(new Event('input', { bubbles: true }))
        }
      })
      const saveBtn = editorForm.querySelector<HTMLButtonElement>('button[type="submit"]')
      assert.ok(saveBtn !== null && !saveBtn.disabled)
      await act(async () => {
        editorForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      assert.deepEqual(spy.actionCalls[1], {
        actionId: 'update_draft',
        input: {
          conversationId: 30,
          title: 'Human Edited Title',
          markdown: '# Edited by human',
          expectedVersion: 5,
        },
        options: { conversationId: 30 },
      })

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
      assert.match(panelText, /Fresh context/)
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
      assert.match(sameSessionText, /Same context/)
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

  test('computePlanDraftDiff & PlanWorkbenchPanel: revision diff switcher, hunk folding, oversized guard, and viewMode resets', { timeout: 60_000 }, async () => {
    // 1. Pure computePlanDraftDiff: identical body with title change
    const titleOnly = computePlanDraftDiff(
      { title: 'Old Title', markdown: 'Line 1\r\nLine 2' },
      { title: 'New Title', markdown: 'Line 1\nLine 2' },
    )
    assert.equal(titleOnly.kind, 'diff')
    if (titleOnly.kind === 'diff') {
      assert.equal(titleOnly.titleChanged, true)
      assert.equal(titleOnly.addedLines, 0)
      assert.equal(titleOnly.removedLines, 0)
      assert.equal(titleOnly.hasChanges, true)
      assert.deepEqual(titleOnly.hunks, [])
      assert.equal(titleOnly.trailingSkipped, 0)
    }

    // Identical title and markdown -> hasChanges: false
    const noChanges = computePlanDraftDiff(
      { title: 'Same', markdown: 'A\nB' },
      { title: 'Same', markdown: 'A\nB' },
    )
    assert.equal(noChanges.kind, 'diff')
    if (noChanges.kind === 'diff') {
      assert.equal(noChanges.hasChanges, false)
      assert.deepEqual(noChanges.hunks, [])
      assert.equal(noChanges.trailingSkipped, 0)
    }

    // Context folding with PLAN_DIFF_CONTEXT_LINES = 3
    assert.equal(PLAN_DIFF_CONTEXT_LINES, 3)
    const manyPrev = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`)
    const manyNext = [...manyPrev]
    manyNext[5] = 'line 6 updated'
    manyNext[15] = 'line 16 updated'
    manyNext.splice(16, 0, 'line 16b added')
    const folded = computePlanDraftDiff(
      { title: 'Plan', markdown: manyPrev.join('\n') },
      { title: 'Plan', markdown: manyNext.join('\n') },
    )
    assert.equal(folded.kind, 'diff')
    if (folded.kind === 'diff') {
      assert.equal(folded.addedLines, 3)
      assert.equal(folded.removedLines, 2)
      assert.equal(folded.hunks.length, 2)
      assert.equal(folded.hunks[0]!.skippedBefore, 2)
      assert.equal(folded.hunks[1]!.skippedBefore, 3)
      assert.equal(folded.trailingSkipped, 1)
    }

    // Budget exceeded -> too_large; huge doc with tiny middle edit still succeeds via prefix/suffix trim
    const largePrev = Array.from({ length: MAX_PLAN_DIFF_LINES + 10 }, (_, i) => `old-${i}`).join('\n')
    const largeNext = Array.from({ length: MAX_PLAN_DIFF_LINES + 10 }, (_, i) => `new-${i}`).join('\n')
    assert.deepEqual(computePlanDraftDiff({ title: 'A', markdown: largePrev }, { title: 'B', markdown: largeNext }), {
      kind: 'too_large',
      prevLineCount: MAX_PLAN_DIFF_LINES + 10,
      nextLineCount: MAX_PLAN_DIFF_LINES + 10,
    })
    assert.ok(MAX_PLAN_DIFF_DP_CELLS === 2_500_000)

    const trimmedPrev = Array.from({ length: 2000 }, (_, i) => `shared-${i}`)
    const trimmedNext = [...trimmedPrev]
    trimmedNext[1000] = 'edited-1000'
    const trimmedRes = computePlanDraftDiff(
      { title: 'A', markdown: trimmedPrev.join('\n') },
      { title: 'A', markdown: trimmedNext.join('\n') },
    )
    assert.equal(trimmedRes.kind, 'diff')

    // 2. PlanWorkbenchPanel DOM integration
    const spy = makeSpyCtx({ conversationId: 50 })
    const harness = createSessionDocHarness({
      [`${PLAN_PLUGIN_ID}/${PLAN_SESSION_DOC}/50`]: {
        hasValue: true,
        deleted: false,
        connected: true,
        value: {
          mode: 'planning',
          awaitingApproval: false,
          draft: {
            title: 'Plan v1',
            markdown: '# First',
            version: 1,
            updatedAt: 1_700_000_000_000,
          },
        },
      },
      [`${PLAN_PLUGIN_ID}/${PLAN_SESSION_DOC}/51`]: {
        hasValue: true,
        deleted: false,
        connected: true,
        value: {
          mode: 'planning',
          awaitingApproval: false,
          draft: {
            title: 'Conv 51 Plan',
            markdown: '# Conv 51 Preview',
            version: 2,
            updatedAt: 1_700_000_000_100,
          },
          previousDraft: {
            title: 'Conv 51 Plan Old',
            markdown: '# Conv 51 Old',
            version: 1,
            updatedAt: 1_700_000_000_000,
          },
        },
      },
    })

    const mounted = await mountWithSessionHost(
      spy,
      e(components.PlanWorkbenchPanel, { conversation: makeConv(50) }),
      harness,
    )
    try {
      // No previousDraft -> zero SegmentedControl
      assert.ok(mounted.host.querySelector('.plan-view-bar') === null)

      // Push v3 with previousDraft v1 -> view bar renders inside card body (NOT inside Card.actions)
      const prevLines = Array.from({ length: 16 }, (_, i) => `Item ${i + 1}`)
      const nextLines = [...prevLines]
      nextLines[2] = 'Item 3 revised'
      nextLines[13] = 'Item 14 revised'
      nextLines.push('Item 17 added')
      await act(async () => {
        harness.setDocValue(50, {
          mode: 'planning',
          awaitingApproval: false,
          draft: {
            title: 'Plan v3 Updated',
            markdown: nextLines.join('\n'),
            version: 3,
            updatedAt: 1_700_000_000_500,
          },
          previousDraft: {
            title: 'Plan v1',
            markdown: prevLines.join('\n'),
            version: 1,
            updatedAt: 1_700_000_000_000,
          },
        })
      })

      const cardActions = mounted.host.querySelector('.helmx-card-actions')
      assert.ok(cardActions !== null)
      assert.ok(cardActions.querySelector('[role="tablist"]') === null, 'SegmentedControl must stay out of Card.actions')

      const viewBar = mounted.host.querySelector('.plan-view-bar')
      assert.ok(viewBar !== null)
      assert.equal(viewBar.querySelector('.plan-diff-stat-add')?.textContent, '+3')
      assert.equal(viewBar.querySelector('.plan-diff-stat-del')?.textContent, '-2')

      const tabs = Array.from(viewBar.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      assert.equal(tabs.length, 2)
      assert.equal(tabs[0]!.textContent, 'Preview')
      assert.equal(tabs[1]!.textContent, 'Diff v1')
      assert.ok(mounted.host.querySelector('.plan-markdown') !== null, 'Preview is active by default')

      // Switch to Diff v1
      await act(async () => {
        tabs[1]!.click()
      })
      assert.ok(mounted.host.querySelector('.plan-markdown') === null)
      const titleChange = mounted.host.querySelector('.plan-diff-title-change')
      assert.ok(titleChange !== null)
      assert.match(titleChange.textContent ?? '', /Plan v1/)
      assert.match(titleChange.textContent ?? '', /Plan v3 Updated/)
      const diffView = mounted.host.querySelector('.plan-diff-view')
      assert.ok(diffView !== null)
      assert.ok(diffView.querySelectorAll('.plan-diff-hunk-gap').length >= 1)
      assert.equal(diffView.querySelectorAll('.plan-diff-row--add').length, 3)
      assert.equal(diffView.querySelectorAll('.plan-diff-row--remove').length, 2)
      assert.equal(EMOJI_RE.test(mounted.host.textContent ?? ''), false)

      // Entering Edit mode and cancelling resets viewMode back to Preview
      const editBtn = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        (b.textContent ?? '').trim() === 'Edit',
      )
      assert.ok(editBtn !== undefined)
      await act(async () => {
        editBtn.click()
      })
      const cancelBtn = Array.from(mounted.host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
        (b.textContent ?? '').trim() === 'Cancel',
      )
      assert.ok(cancelBtn !== undefined)
      await act(async () => {
        cancelBtn.click()
      })
      assert.ok(mounted.host.querySelector('.plan-markdown') !== null, 'cancelling Edit must restore Preview mode')

      // Switch to Diff again, then switch conversationId -> resets viewMode to Preview
      await act(async () => {
        mounted.host.querySelectorAll<HTMLButtonElement>('.plan-view-bar [role="tab"]')[1]!.click()
      })
      assert.ok(mounted.host.querySelector('.plan-diff-view') !== null)
      await mounted.rerender(e(components.PlanWorkbenchPanel, { conversation: makeConv(51) }))
      assert.ok(mounted.host.querySelector('.plan-markdown') !== null, 'switching conversation must reset viewMode to Preview')
      assert.match(mounted.host.querySelector('.plan-markdown')?.textContent ?? '', /Conv 51 Preview/)

      // Dropping previousDraft while in diff mode resets viewMode cleanly and oversized diff shows info callout
      await act(async () => {
        mounted.host.querySelectorAll<HTMLButtonElement>('.plan-view-bar [role="tab"]')[1]!.click()
      })
      assert.ok(mounted.host.querySelector('.plan-diff-view') !== null)
      await act(async () => {
        harness.setDocValue(51, {
          mode: 'planning',
          awaitingApproval: false,
          draft: { title: 'Reset v1', markdown: '# Reset body', version: 1, updatedAt: 1_700_000_000_200 },
        })
      })
      assert.ok(mounted.host.querySelector('.plan-view-bar') === null)
      assert.ok(mounted.host.querySelector('.plan-markdown') !== null)

      // Oversized diff fallback
      await act(async () => {
        harness.setDocValue(51, {
          mode: 'planning',
          awaitingApproval: false,
          draft: { title: 'Huge v2', markdown: largeNext, version: 2, updatedAt: 1_700_000_000_300 },
          previousDraft: { title: 'Huge v1', markdown: largePrev, version: 1, updatedAt: 1_700_000_000_200 },
        })
      })
      await act(async () => {
        mounted.host.querySelectorAll<HTMLButtonElement>('.plan-view-bar [role="tab"]')[1]!.click()
      })
      const callout = mounted.host.querySelector('.callout')
      assert.ok(callout !== null)
      assert.match(callout.textContent ?? '', /Diff is too large/)
    } finally {
      await mounted.unmount()
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
      // 右侧只放 external-link 跳转提示（行点击打开工作台），不再出现折叠 chevron
      const right = rowBtn.querySelector('.trace-row-right')
      assert.ok(right?.querySelector('.trace-row-link.lucide-external-link') !== null, '右侧为 external-link 跳转提示')
      assert.ok(right?.querySelector('.trace-row-chevron') === null, '右侧不出现 chevron')
      assert.equal(rowBtn.getAttribute('aria-expanded'), null, '跳转行不声明折叠语义')
      await act(async () => {
        rowBtn.click()
      })
      assert.deepEqual(spy.workbenchCalls, [{ panelId: 'plan', params: undefined }])
    } finally {
      await saveMount.unmount()
    }

    // 2. plan_propose approved_handoff & approved with executionModel
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
      assert.match(text, /Approved · Fresh context/)
      const light = proposeMount.host.querySelector('.helmx-status-light')
      assert.ok(light !== null)
      assert.equal(light.getAttribute('data-tone'), 'done')
    } finally {
      await proposeMount.unmount()
    }

    const sameModelMount = await mountWithSessionHost(
      spy,
      e(components.PlanToolRow, {
        callId: 'call-prop-same-model',
        toolName: PLAN_TOOL_PROPOSE,
        status: 'done',
        conversationId: 40,
        presentationMeta: {
          kind: 'propose',
          title: 'Same Context Model Override',
          version: 4,
          outcome: 'approved',
          artifactId: 'art_2',
          artifactName: 'plan-v4.md',
          executionModel: 'tier/coder',
        },
      }),
    )
    try {
      const text = sameModelMount.host.textContent ?? ''
      assert.match(text, /Same Context Model Override/)
      assert.match(text, /tier\/coder/)
      assert.match(text, /Approved/)
    } finally {
      await sameModelMount.unmount()
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
