import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type {
  ConversationEntry,
  ConversationSummary,
  PluginUiContribution,
} from '@helmx/protocol'
import { jsonResponse } from '@helmx/test-kit'
import { ensureHappyDom, waitForCondition } from './helpers/dom-harness.js'
import { makeTestStore } from './helpers/store.js'
import { createWebTranslator } from '../src/i18n/catalog.js'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import type { FoldableStep, TimelineItem, ToolTrace } from '../src/conversation/timeline-model.js'
import {
  isStepFailed,
  isStepRunning,
  resolveProcessInspection,
  resolveSelectedStepIndex,
  stepKeyOf,
  thinkingPreviewLine,
} from '../src/conversation/process-inspector-model.js'

ensureHappyDom()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { createRoot } = await import('react-dom/client')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')
const { DrawerStackShell } = await import('../src/conversation/DrawerStackShell.js')
const { ThinkingRow } = await import('../src/conversation/TimelineRows.js')
const { seedPluginClientModule, resetPluginClientCache } = await import('../src/lib/plugin-client.js')
const { resetSessionDocSubscriptions } = await import('../src/lib/session-docs.js')
const { useConversationDetail } = await import('../src/lib/store-context.js')

const e = React.createElement
const origFetch = globalThis.fetch
const origClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u

const roots: Array<{ root: Root; host: HTMLElement }> = []

function makeConversation(id: number, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `测试会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    nodeId: 'local',
    cwd: '/root/code/helm',
    model: 'faux/model',
    thinkingLevel: 'medium',
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

function makeToolStep(
  key: string,
  toolName: string,
  overrides: Partial<ToolTrace> = {},
): FoldableStep {
  return {
    kind: 'tool',
    tool: {
      key,
      toolName,
      status: 'done',
      isError: false,
      ...overrides,
    },
  }
}

function makeThinkingStep(
  key: string,
  text: string,
  extra: { active?: boolean; responseDurationMs?: number } = {},
): FoldableStep {
  return {
    kind: 'thinking',
    thinking: {
      key,
      text,
      ...extra,
    },
  }
}

function makeLineBlock(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, idx) => `${prefix} line ${idx + 1}`).join('\n')
}

function mountNode() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push({ root, host })
  return {
    host,
    render: async (store: HelmxExternalStore, node: React.ReactNode) => {
      await act(async () => {
        root.render(e(HostStoreProviders, { value: store }, node))
      })
    },
  }
}

describe('process-inspector-model & two-level ProcessInspectorDrawer', () => {
  afterEach(async () => {
    while (roots.length > 0) {
      const item = roots.pop()!
      await act(async () => {
        item.root.unmount()
      })
      item.host.remove()
    }
    document.body.innerHTML = ''
    globalThis.fetch = origFetch
    if (origClipboard !== undefined) {
      Object.defineProperty(navigator, 'clipboard', origClipboard)
    } else {
      delete (navigator as unknown as { clipboard?: unknown }).clipboard
    }
    localStorage.removeItem('helmx:locale')
    resetSessionDocSubscriptions()
    resetPluginClientCache()
  }, { timeout: 60_000 })

  test('pure domain model: keys, statuses, previews, selection, and target resolution', { timeout: 60_000 }, () => {
    const thinkStep = makeThinkingStep('think-1', '\n\n   First   non-empty   line  \nSecond line')
    const emptyThinkStep = makeThinkingStep('', '   ')
    const runningTool = makeToolStep('tool-run', 'bash', { status: 'running', input: { command: 'pnpm test' } })
    const failedTool = makeToolStep('tool-err', 'read', { status: 'error', isError: true, resultText: 'ENOENT' })
    const doneTool = makeToolStep('tool-done', 'bash', { status: 'done', resultText: 'ok' })

    assert.equal(stepKeyOf(thinkStep, 0), 'think-1')
    assert.equal(stepKeyOf(emptyThinkStep, 3), 'think:3')
    assert.equal(stepKeyOf(doneTool, 2), 'tool-done')

    assert.equal(isStepRunning(makeThinkingStep('t-live', 'hmm', { active: true })), true)
    assert.equal(isStepRunning(thinkStep), false)
    assert.equal(isStepRunning(runningTool), true)
    assert.equal(isStepFailed(failedTool), true)
    assert.equal(isStepFailed(doneTool), false)

    assert.equal(thinkingPreviewLine(thinkStep.kind === 'thinking' ? thinkStep.thinking.text : ''), 'First non-empty line')
    assert.equal(thinkingPreviewLine('   \n\t  '), '')
    const longLine = 'A'.repeat(100)
    assert.equal(thinkingPreviewLine(`  ${longLine}  \nSecond`), longLine)

    // resolveSelectedStepIndex: empty, followLive, key lookup, index fallback, active running scan
    const mixedSteps: FoldableStep[] = [doneTool, thinkStep, runningTool, makeThinkingStep('t-active', 'active', { active: true })]
    assert.equal(resolveSelectedStepIndex([], { followLive: true, active: true }), -1)
    assert.equal(
      resolveSelectedStepIndex(mixedSteps, { selectedStepKey: 'think-1', followLive: true, active: true }),
      3,
    )
    assert.equal(
      resolveSelectedStepIndex(mixedSteps, { selectedStepKey: 'think-1', followLive: false, active: true }),
      1,
    )
    assert.equal(
      resolveSelectedStepIndex(mixedSteps, { selectedStepKey: 'missing', selectedStepIndex: 99, followLive: false, active: false }),
      3,
    )
    assert.equal(
      resolveSelectedStepIndex([doneTool, runningTool], { active: true }),
      1,
    )
    assert.equal(
      resolveSelectedStepIndex([doneTool, failedTool], { active: false }),
      0,
    )

    // resolveProcessInspection across turns
    const soloTool: ToolTrace = {
      key: 'solo-1',
      toolName: 'dispatch_worker',
      status: 'done',
      isError: false,
    }
    const items: TimelineItem[] = [
      {
        kind: 'assistant',
        key: 'turn-1',
        entryIds: ['1'],
        live: false,
        segments: [
          {
            kind: 'step-group',
            key: 'seg-1',
            stepCount: 2,
            steps: [thinkStep, doneTool],
          },
          { kind: 'text', key: 'txt-1', text: 'Done 1' },
        ],
      },
      {
        kind: 'assistant',
        key: 'turn-2',
        entryIds: ['2'],
        live: true,
        segments: [
          { kind: 'tool', key: 'solo-1', tool: soloTool },
          {
            kind: 'step-group',
            key: 'seg-2',
            stepCount: 2,
            active: true,
            steps: [doneTool, runningTool],
          },
        ],
      },
    ]

    const resolvedGroup = resolveProcessInspection(items, {
      kind: 'step-group',
      turnKey: 'turn-2',
      segmentKey: 'seg-2',
      followLive: true,
    })
    assert.ok(resolvedGroup !== null)
    assert.equal(resolvedGroup.active, true)
    assert.equal(resolvedGroup.selectedIndex, 1)
    assert.equal(resolvedGroup.steps.length, 2)

    const resolvedSolo = resolveProcessInspection(items, {
      kind: 'standalone-tool',
      turnKey: 'turn-2',
      toolKey: 'solo-1',
      mode: 'raw',
    })
    assert.ok(resolvedSolo !== null)
    assert.equal(resolvedSolo.mode, 'raw')
    assert.equal(resolvedSolo.steps[0]?.kind, 'tool')
    assert.equal(resolveProcessInspection(items, { kind: 'step-group', turnKey: 'none', segmentKey: 'none' }), null)
  })

  test('two-level flow: Level 1 inline expand -> Level 2 single-column drawer, header switcher, scroll reset, non-hijacking keys, fullscreen & close', { timeout: 60_000 }, async () => {
    const conv = makeConversation(1)
    const store = makeTestStore({
      locale: 'zh-CN',
      conversations: [conv],
      conversationDetails: { 1: { ...conv, entries: [] } },
    })
    const items: TimelineItem[] = [
      {
        kind: 'assistant',
        key: 'turn:settled',
        entryIds: ['10'],
        live: false,
        modelDurationMs: 1200,
        toolDurationMs: 800,
        segments: [
          {
            kind: 'step-group',
            key: 'seg:settled',
            stepCount: 3,
            steps: [
              makeThinkingStep('s-think', 'First thought', { responseDurationMs: 500 }),
              makeToolStep('s-bash-1', 'bash', {
                input: { command: 'echo first' },
                status: 'done',
                resultText: makeLineBlock('alpha', 70),
              }),
              makeToolStep('s-bash-2', 'bash', {
                input: { command: 'echo second' },
                status: 'error',
                isError: true,
                resultText: makeLineBlock('beta-err', 70),
              }),
            ],
          },
          { kind: 'text', key: 'txt:settled', text: '回答完成' },
        ],
      },
    ]

    const ui = mountNode()
    await ui.render(
      store,
      e(ConversationTimeline, {
        conversation: conv,
        detailEntries: [],
        timelineItems: items,
        onRequestEdit: () => {},
      }),
    )

    // Level 1 collapsed initially
    const summaryBtn = ui.host.querySelector('button.trace-group-summary') as HTMLButtonElement | null
    assert.ok(summaryBtn !== null)
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'false')
    assert.ok(ui.host.querySelector('.trace-group-steps') === null)
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') === null)

    // Level 1 expand renders inline step stream WITHOUT popping open drawer
    await act(async () => {
      summaryBtn.click()
    })
    assert.equal(summaryBtn.getAttribute('aria-expanded'), 'true')
    const stepsContainer = ui.host.querySelector('.trace-group-steps') as HTMLElement | null
    assert.ok(stepsContainer !== null)
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') === null)

    // 组内已落定 ThinkingRow 与 TraceRow 同构对齐：展示 sparkles、首行摘要、耗时与右侧 chevron，且无左侧折叠箭头
    const thinkingGroupRow = stepsContainer.querySelector('.trace-row.trace-thinking-row') as HTMLElement | null
    assert.ok(thinkingGroupRow !== null)
    assert.ok(thinkingGroupRow.querySelector('.lucide-sparkles') !== null)
    assert.ok(thinkingGroupRow.querySelector('.trace-row-chevron') !== null)
    assert.equal(thinkingGroupRow.querySelector('.trace-thinking-title')?.textContent, '思考过程')
    assert.equal(thinkingGroupRow.querySelector('.trace-thinking-summary')?.textContent, 'First thought')
    assert.equal(thinkingGroupRow.querySelector('.trace-row-right')?.textContent, '500ms')

    // Click step 1 (bash echo first) -> opens clean single-column drawer (NO sidebar, NO duplicate second header)
    const stepToolRows = stepsContainer.querySelectorAll('.trace-row:not(.trace-thinking-row)')
    assert.equal(stepToolRows.length, 2)
    await act(async () => {
      ;(stepToolRows[0] as HTMLElement).click()
    })

    const drawer = document.querySelector('[role="dialog"].process-inspector-drawer') as HTMLElement | null
    assert.ok(drawer !== null)
    assert.ok(drawer.querySelector('.process-drawer-sidebar') === null, 'Single-column drawer must have no left sidebar')
    assert.ok(drawer.querySelector('.process-detail-head') === null, 'Unified single header must not duplicate title bar')
    assert.equal(drawer.querySelector('.process-drawer-title')?.textContent, 'bash')
    assert.ok((drawer.querySelector('.process-detail-subheader')?.textContent ?? '').includes('echo first'))
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('2 / 3'))

    // Simulate scrolling down inside step 1 AND expanding 70-line output
    const detailScroller = drawer.querySelector('.process-drawer-detail') as HTMLElement
    detailScroller.scrollTop = 240
    const detailBodyBefore = drawer.querySelector('.process-detail-body')!
    assert.ok((detailBodyBefore.textContent ?? '').includes('alpha line 70'))
    const expandAllStep1 = Array.from(detailBodyBefore.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('展开全部'),
    )
    assert.ok(expandAllStep1 !== undefined, 'Expected 展开全部 button for 70-line bash output')
    await act(async () => {
      expandAllStep1.click()
    })
    assert.ok((detailBodyBefore.textContent ?? '').includes('alpha line 1'))

    // Bare ArrowDown / ArrowUp MUST NOT hijack scrolling or switch steps
    await act(async () => {
      drawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('2 / 3'))

    // Next-step button switches to step 2 -> resets BOTH ToolExpandedBody state AND detail scrollTop to 0
    const nextBtn = drawer.querySelector('button[aria-label="下一步"]') as HTMLButtonElement | null
    assert.ok(nextBtn !== null)
    await act(async () => {
      nextBtn.click()
    })
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('3 / 3'))
    assert.equal(detailScroller.scrollTop, 0, 'Switching steps must reset detail scrollTop to 0')
    assert.ok((drawer.querySelector('.process-detail-subheader')?.textContent ?? '').includes('echo second'))
    const detailBodyAfter = drawer.querySelector('.process-detail-body')!
    assert.ok((detailBodyAfter.textContent ?? '').includes('beta-err line 70'))
    assert.ok(
      Array.from(detailBodyAfter.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('展开全部')),
      'Switching step must reset ToolExpandedBody expanded state',
    )

    // Keyboard step navigation: Alt+ArrowUp -> step 1, `]` -> step 2, `[` -> step 1
    await act(async () => {
      drawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }))
    })
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('2 / 3'))
    await act(async () => {
      drawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true }))
    })
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('3 / 3'))
    await act(async () => {
      drawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: '[', bubbles: true, cancelable: true }))
    })
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('2 / 3'))

    // Bracket shortcut ignored when focus is inside an input element inside drawer
    const dummyInput = document.createElement('input')
    drawer.appendChild(dummyInput)
    await act(async () => {
      dummyInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: ']', bubbles: true, cancelable: true }))
    })
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('2 / 3'))
    dummyInput.remove()

    // Header DropdownMenu step jumper: open N/M menu and pick step 0 (Thinking)
    const pickerTrigger = drawer.querySelector('.process-step-picker-trigger') as HTMLButtonElement
    await act(async () => {
      pickerTrigger.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1 }))
      pickerTrigger.click()
    })
    await waitForCondition(() => document.querySelectorAll('.process-step-menu-item').length === 3)
    const menuItems = Array.from(document.querySelectorAll('.process-step-menu-item')) as HTMLElement[]
    assert.ok(menuItems[2]!.classList.contains('is-error'))
    await act(async () => {
      menuItems[0]!.click()
    })
    await waitForCondition(() => (drawer.querySelector('.process-drawer-title')?.textContent ?? '') === '思考过程')
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('1 / 3'))
    assert.ok((drawer.querySelector('.process-thinking-body')?.textContent ?? '').includes('First thought'))

    // Desktop fullscreen toggle
    const fullscreenBtn = drawer.querySelector('button[aria-label="全屏展开抽屉"]') as HTMLButtonElement | null
    assert.ok(fullscreenBtn !== null)
    await act(async () => {
      fullscreenBtn.click()
    })
    assert.ok(drawer.classList.contains('process-inspector-drawer-fullscreen'))
    assert.ok(drawer.querySelector('button[aria-label="退出全屏"]') !== null)

    // Close via close button, then Esc, then backdrop
    const closeBtn = drawer.querySelector('.process-drawer-close-btn') as HTMLButtonElement
    await act(async () => {
      closeBtn.click()
    })
    await waitForCondition(() => document.querySelector('[role="dialog"].process-inspector-drawer') === null)

    await act(async () => {
      ;(stepToolRows[0] as HTMLElement).click()
    })
    await waitForCondition(() => document.querySelector('[role="dialog"].process-inspector-drawer') !== null)
    await act(async () => {
      document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await waitForCondition(() => document.querySelector('[role="dialog"].process-inspector-drawer') === null)

    await act(async () => {
      ;(stepToolRows[0] as HTMLElement).click()
    })
    await waitForCondition(() => document.querySelector('.process-inspector-backdrop') !== null)
    const backdrop = document.querySelector('.process-inspector-backdrop') as HTMLElement
    await act(async () => {
      backdrop.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerId: 1 }))
      backdrop.click()
    })
    await waitForCondition(() => document.querySelector('[role="dialog"].process-inspector-drawer') === null)
  })

  test('live execution (active=true): original inline streaming thinking box + full Level 1 stream + drawer follow toggle & settled continuity', { timeout: 60_000 }, async () => {
    const conv = makeConversation(2, { status: 'working' })
    const store = makeTestStore({
      locale: 'zh-CN',
      conversations: [conv],
      conversationDetails: { 2: { ...conv, entries: [] } },
    })

    const settledStep0 = makeToolStep('live-0', 'read', {
      status: 'done',
      input: { path: 'a.ts' },
      resultText: 'done-a',
    })
    const activeThinkStep = makeThinkingStep('live-think', 'line1\nline2\nline3\nline4\nline5\nline6', { active: true })
    const runningStep2 = makeToolStep('live-2', 'bash', {
      status: 'running',
      input: { command: 'pnpm build' },
    })

    const makeItems = (steps: FoldableStep[], active: boolean): TimelineItem[] => [
      {
        kind: 'assistant',
        key: 'turn:live',
        entryIds: ['20'],
        live: active,
        segments: [
          {
            kind: 'step-group',
            key: 'seg:live',
            stepCount: steps.length,
            active,
            steps,
          },
          ...(active ? [] : [{ kind: 'text' as const, key: 'txt:done', text: '完成答复' }]),
        ],
      },
    ]

    const ui = mountNode()
    await ui.render(
      store,
      e(ConversationTimeline, {
        conversation: conv,
        detailEntries: [],
        timelineItems: makeItems([settledStep0, activeThinkStep, runningStep2], true),
        onRequestEdit: () => {},
      }),
    )

    // Level 1 active stream shows ALL steps AND the original inline streaming thinking box
    const groupSteps = ui.host.querySelector('.trace-group-steps') as HTMLElement | null
    assert.ok(groupSteps !== null)
    assert.ok((groupSteps.textContent ?? '').includes('a.ts'))
    assert.ok((groupSteps.textContent ?? '').includes('pnpm build'))
    const activeInlineThinking = groupSteps.querySelector('.thinking-expanded-body') as HTMLElement | null
    assert.ok(activeInlineThinking !== null, 'Active thinking MUST preserve the original inline streaming Markdown box')
    assert.ok((activeInlineThinking.textContent ?? '').includes('line1'))
    assert.ok((activeInlineThinking.textContent ?? '').includes('line6'))

    // Click running step in Level 1 stream -> opens Level 2 drawer on running bash with blue .is-running icon
    const toolRows = groupSteps.querySelectorAll('.trace-row')
    assert.equal(toolRows.length, 2)
    await act(async () => {
      ;(toolRows[1] as HTMLElement).click()
    })
    const drawer = document.querySelector('[role="dialog"].process-inspector-drawer') as HTMLElement | null
    assert.ok(drawer !== null)
    assert.ok(drawer.querySelector('.process-drawer-status-icon.is-running') !== null)
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('3 / 3'))

    // Toggle Follow button: initially pause/follow off after clicking specific step -> shows "跟随最新"
    const followBtn = Array.from(drawer.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('跟随最新'),
    )
    assert.ok(followBtn !== undefined, 'Clicking a specific step starts unlocked ("跟随最新")')

    // Click Prev twice across renders to lock on step 0 (`1 / 3`), then append step 3 -> stays on `1 / 4`
    await act(async () => {
      ;(drawer.querySelector('button[aria-label="上一步"]') as HTMLButtonElement).click()
    })
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('2 / 3'))
    await act(async () => {
      ;(drawer.querySelector('button[aria-label="上一步"]') as HTMLButtonElement).click()
    })
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('1 / 3'))

    const runningStep3 = makeToolStep('live-3', 'edit', { status: 'running', input: { path: 'b.ts' } })
    await ui.render(
      store,
      e(ConversationTimeline, {
        conversation: conv,
        detailEntries: [],
        timelineItems: makeItems([settledStep0, activeThinkStep, runningStep2, runningStep3], true),
        onRequestEdit: () => {},
      }),
    )
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('1 / 4'))

    // Enable follow-live -> reads "实时跟随中" and jumps to step 4 / 4
    await act(async () => {
      followBtn.click()
    })
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('4 / 4'))
    assert.ok(
      Array.from(drawer.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('实时跟随中')),
    )

    // Append step 4 while followLive=true -> auto-advances to 5 / 5
    const runningStep4 = makeToolStep('live-4', 'write', { status: 'running', input: { path: 'c.ts' } })
    await ui.render(
      store,
      e(ConversationTimeline, {
        conversation: conv,
        detailEntries: [],
        timelineItems: makeItems([settledStep0, activeThinkStep, runningStep2, runningStep3, runningStep4], true),
        onRequestEdit: () => {},
      }),
    )
    assert.ok((drawer.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('5 / 5'))

    // Turn settles (active=false, live=false): Level 1 auto-collapses while open drawer stays open cleanly
    const settledConv = makeConversation(2, { status: 'idle' })
    const settledSteps: FoldableStep[] = [
      settledStep0,
      makeThinkingStep('live-think', 'line1\nline2\nline3\nline4\nline5\nline6', { active: false }),
      makeToolStep('live-2', 'bash', { status: 'done', input: { command: 'pnpm build' }, resultText: 'built' }),
      makeToolStep('live-3', 'edit', { status: 'done', input: { path: 'b.ts' }, resultText: 'edited' }),
      makeToolStep('live-4', 'write', { status: 'done', input: { path: 'c.ts' }, resultText: 'written' }),
    ]
    await ui.render(
      store,
      e(ConversationTimeline, {
        conversation: settledConv,
        detailEntries: [],
        timelineItems: makeItems(settledSteps, false),
        onRequestEdit: () => {},
      }),
    )
    assert.ok(ui.host.querySelector('.trace-group-steps') === null, 'Level 1 stream collapses cleanly on settle')
    const drawerAfterSettle = document.querySelector('[role="dialog"].process-inspector-drawer') as HTMLElement | null
    assert.ok(drawerAfterSettle !== null, 'Open drawer must remain open after turn settles')
    assert.ok((drawerAfterSettle.querySelector('.process-step-picker-trigger')?.textContent ?? '').includes('5 / 5'))
    assert.equal(drawerAfterSettle.querySelector('.process-drawer-title')?.textContent, 'write')
  })

  test('standalone ThinkingRow opens single-column drawer with MarkdownView & CopyButton in header', { timeout: 60_000 }, async () => {
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          copied.push(text)
        },
      },
    })

    const store = makeTestStore({ locale: 'zh-CN' })
    const ui = mountNode()
    await ui.render(
      store,
      e(ThinkingRow, {
        text: '# Reasoning\n\n- step alpha',
        conversationId: 1,
      }),
    )

    const trigger = ui.host.querySelector('button.trace-group-summary') as HTMLButtonElement | null
    assert.ok(trigger !== null)
    assert.ok(trigger.querySelector('.lucide-sparkles') !== null, 'Standalone settled ThinkingRow shows sparkles icon')
    assert.ok(trigger.querySelector('.trace-row-chevron') !== null, 'Standalone settled ThinkingRow shows right chevron cue')
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') === null)

    await act(async () => {
      trigger.click()
    })

    const drawer = document.querySelector('[role="dialog"].process-inspector-drawer') as HTMLElement | null
    assert.ok(drawer !== null)
    assert.ok(drawer.querySelector('.process-detail-head') === null)
    assert.ok(drawer.querySelector('.process-thinking-body h1') !== null)
    assert.ok((drawer.querySelector('.process-thinking-body')!.textContent ?? '').includes('step alpha'))

    const copyBtn = Array.from(drawer.querySelectorAll<HTMLButtonElement>('.process-drawer-header button')).find((b) =>
      (b.getAttribute('aria-label') ?? b.textContent ?? '').includes('复制思考'),
    )
    assert.ok(copyBtn !== undefined)
    await act(async () => {
      copyBtn.click()
    })
    assert.deepEqual(copied, ['# Reasoning\n\n- step alpha'])
  })

  test('replaceRow=true tool.view opens I/O drawer (mode=io) and completes server truncation backfill via fetch', { timeout: 60_000 }, async () => {
    seedPluginClientModule(
      'demo:cards',
      'index.tsx',
      {
        CardRow: () => e('div', { className: 'mock-spawn-card' }, 'Worker Spawn Card'),
      },
      'hash-io-1',
    )

    const pluginContribution: PluginUiContribution = {
      pluginId: 'demo:cards',
      surface: 'tool.view',
      spec: {
        id: 'spawn_agent',
        toolNames: ['spawn_agent'],
        replaceRow: true,
        client: { module: 'index.tsx', export: 'CardRow' },
      },
    }

    const conv = makeConversation(5)
    const truncatedEntry: ConversationEntry = {
      id: '99',
      kind: 'pi.tool-result',
      createdAt: 1_700_000_001_000,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call-99',
          toolName: 'spawn_agent',
          content: [{ type: 'text', text: 'truncated-preview-only' }],
          truncated: true,
          totalChars: 120,
          totalLines: 3,
        },
      ],
    } as unknown as ConversationEntry
    const entries: ConversationEntry[] = [
      {
        id: '98',
        kind: 'pi.assistant',
        createdAt: 1_700_000_000_500,
        model: [
          {
            role: 'assistant',
            content: [{ type: 'toolCall', id: 'call-99', name: 'spawn_agent', arguments: { goal: 'run audit' } }],
          },
        ],
      } as unknown as ConversationEntry,
      truncatedEntry,
    ]
    const fullEntry: ConversationEntry = {
      ...truncatedEntry,
      model: [
        {
          role: 'toolResult',
          toolCallId: 'call-99',
          toolName: 'spawn_agent',
          content: [{ type: 'text', text: 'FULL_RESULT_LINE_1\nFULL_RESULT_LINE_2\nFULL_RESULT_LINE_3' }],
        },
      ],
    } as unknown as ConversationEntry

    const requestedUrls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      requestedUrls.push(url)
      if (url.includes('/api/conversations/5/entries/99')) {
        return jsonResponse(fullEntry)
      }
      return jsonResponse({ error: 'unexpected url' }, 404)
    }) as typeof fetch

    const store = makeTestStore({
      locale: 'zh-CN',
      conversations: [conv],
      conversationDetails: { 5: { ...conv, entries } },
      plugins: [
        {
          id: 'demo:cards',
          name: 'Demo Cards',
          version: '1.0.0',
          enabled: true,
          locked: false,
          status: 'active',
          hooks: [],
          actions: [],
          tools: [],
          clientHashes: { 'index.tsx': 'hash-io-1' },
        },
      ],
      uiContributions: [pluginContribution],
    })

    function SubscribedTimeline() {
      const detail = useConversationDetail(5)
      return e(ConversationTimeline, {
        conversation: conv,
        detailEntries: detail?.entries ?? [],
        onRequestEdit: () => {},
      })
    }

    const ui = mountNode()
    await ui.render(store, e(SubscribedTimeline))

    await waitForCondition(() => ui.host.querySelector('.mock-spawn-card') !== null)
    const ioToggle = ui.host.querySelector('button.trace-io-toggle') as HTMLButtonElement | null
    assert.ok(ioToggle !== null)
    assert.equal(ioToggle.getAttribute('aria-expanded'), 'false')

    await act(async () => {
      ioToggle.click()
    })

    const drawer = document.querySelector('[role="dialog"].process-inspector-drawer') as HTMLElement | null
    assert.ok(drawer !== null)
    assert.equal(ioToggle.getAttribute('aria-expanded'), 'true')
    assert.ok((drawer.textContent ?? '').includes('truncated-preview-only'))

    const fetchBtn = Array.from(drawer.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('展开全文'),
    )
    assert.ok(fetchBtn !== undefined, 'Expected 展开全文 button for server-truncated result in I/O drawer')

    await act(async () => {
      fetchBtn.click()
    })

    await waitForCondition(() => (drawer.textContent ?? '').includes('FULL_RESULT_LINE_3'))
    assert.ok(requestedUrls.some((u) => u.includes('/api/conversations/5/entries/99')))
    assert.ok((drawer.textContent ?? '').includes('FULL_RESULT_LINE_1'))
  })

  test('staged={false} (keep-alive hidden) and conversation switch automatically close an open process drawer', { timeout: 60_000 }, async () => {
    const conv1 = makeConversation(10)
    const conv2 = makeConversation(11)
    const store = makeTestStore({
      locale: 'zh-CN',
      conversations: [conv1, conv2],
      conversationDetails: {
        10: { ...conv1, entries: [] },
        11: { ...conv2, entries: [] },
      },
    })

    const itemsFor = (turnKey: string): TimelineItem[] => [
      {
        kind: 'assistant',
        key: turnKey,
        entryIds: ['1'],
        live: false,
        segments: [
          {
            kind: 'step-group',
            key: `${turnKey}:seg`,
            stepCount: 2,
            steps: [makeThinkingStep(`${turnKey}:t`, 'thought'), makeToolStep(`${turnKey}:tool`, 'bash')],
          },
        ],
      },
    ]

    const openStepFromTimeline = async (container: HTMLElement) => {
      await act(async () => {
        ;(container.querySelector('button.trace-group-summary') as HTMLButtonElement).click()
      })
      await act(async () => {
        ;(container.querySelector('.trace-group-steps .trace-row') as HTMLElement).click()
      })
    }

    const ui = mountNode()
    await ui.render(
      store,
      e(ConversationTimeline, {
        conversation: conv1,
        detailEntries: [],
        timelineItems: itemsFor('c10'),
        staged: true,
        onRequestEdit: () => {},
      }),
    )

    await openStepFromTimeline(ui.host)
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') !== null)

    // Hiding pane via staged=false MUST dismiss the drawer immediately
    await ui.render(
      store,
      e(ConversationTimeline, {
        conversation: conv1,
        detailEntries: [],
        timelineItems: itemsFor('c10'),
        staged: false,
        onRequestEdit: () => {},
      }),
    )
    await waitForCondition(() => document.querySelector('[role="dialog"].process-inspector-drawer') === null)

    // Re-stage & re-open, then switch conversation -> MUST dismiss the drawer immediately
    await ui.render(
      store,
      e(ConversationTimeline, {
        conversation: conv1,
        detailEntries: [],
        timelineItems: itemsFor('c10'),
        staged: true,
        onRequestEdit: () => {},
      }),
    )
    await act(async () => {
      ;(ui.host.querySelector('.trace-group-steps .trace-row:not(.trace-thinking-row)') as HTMLElement).click()
    })
    assert.ok(document.querySelector('[role="dialog"].process-inspector-drawer') !== null)

    await ui.render(
      store,
      e(ConversationTimeline, {
        conversation: conv2,
        detailEntries: [],
        timelineItems: itemsFor('c11'),
        staged: true,
        onRequestEdit: () => {},
      }),
    )
    await waitForCondition(() => document.querySelector('[role="dialog"].process-inspector-drawer') === null)
  })

  test('nested inside DrawerStackShell: applies light nested backdrop and Esc dismisses only ProcessInspectorDrawer first', { timeout: 60_000 }, async () => {
    const conv = makeConversation(30)
    const entries: ConversationEntry[] = [
      {
        id: '301',
        kind: 'pi.assistant',
        createdAt: 1_700_000_001_000,
        model: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Inner drawer thought' },
              { type: 'toolCall', id: 'tc-inner', name: 'bash', arguments: { command: 'pwd' } },
            ],
          },
          {
            role: 'toolResult',
            toolCallId: 'tc-inner',
            toolName: 'bash',
            content: [{ type: 'text', text: '/root/code/helm' }],
          },
        ],
      } as unknown as ConversationEntry,
    ]
    const store = makeTestStore({
      locale: 'zh-CN',
      conversations: [conv],
      conversationDetails: { 30: { ...conv, entries } },
      drawerStack: [{ kind: 'conversation', conversationId: 30 }],
    })

    const ui = mountNode()
    await ui.render(store, e(DrawerStackShell, { activeConversationId: 1 }))

    await waitForCondition(() => document.querySelector('.drawer-stack-dialog button.trace-group-summary') !== null)
    const groupTrigger = document.querySelector('.drawer-stack-dialog button.trace-group-summary') as HTMLButtonElement
    await act(async () => {
      groupTrigger.click()
    })
    await waitForCondition(() => document.querySelector('.drawer-stack-dialog .trace-group-steps .trace-row') !== null)
    await act(async () => {
      ;(document.querySelector('.drawer-stack-dialog .trace-group-steps .trace-row') as HTMLElement).click()
    })

    await waitForCondition(() => document.querySelector('[role="dialog"].process-inspector-drawer') !== null)
    const innerDrawer = document.querySelector('[role="dialog"].process-inspector-drawer') as HTMLElement
    const outerDrawer = document.querySelector('[role="dialog"].drawer-stack-dialog') as HTMLElement
    assert.ok(innerDrawer !== null)
    assert.ok(outerDrawer !== null)
    assert.ok(document.querySelector('.process-inspector-backdrop-nested') !== null, 'Nested backdrop avoids double blur')

    // First Escape closes ONLY the inner ProcessInspectorDrawer
    await act(async () => {
      innerDrawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await waitForCondition(() => document.querySelector('[role="dialog"].process-inspector-drawer') === null)
    assert.ok(document.querySelector('[role="dialog"].drawer-stack-dialog') !== null, 'Outer DrawerStackShell must stay open')
    assert.equal(store.getDrawerStack().length, 1)

    // Second Escape pops the outer DrawerStackShell
    await act(async () => {
      outerDrawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    await waitForCondition(() => store.getDrawerStack().length === 0)
  })

  test('bilingual locale switching (zh-CN / en) and zero-Emoji contract', { timeout: 60_000 }, async () => {
    const zh = createWebTranslator('zh-CN')
    const en = createWebTranslator('en')
    const conv = makeConversation(40)
    const store = makeTestStore({
      locale: 'zh-CN',
      conversations: [conv],
      conversationDetails: { 40: { ...conv, entries: [] } },
    })
    const items: TimelineItem[] = [
      {
        kind: 'assistant',
        key: 'turn:i18n',
        entryIds: ['1'],
        live: false,
        segments: [
          {
            kind: 'step-group',
            key: 'seg:i18n',
            stepCount: 2,
            steps: [
              makeThinkingStep('t-i18n', 'Thinking note'),
              makeToolStep('tool-i18n', 'bash', { status: 'error', isError: true, resultText: 'fail' }),
            ],
          },
        ],
      },
    ]

    const ui = mountNode()
    await ui.render(
      store,
      e(ConversationTimeline, {
        conversation: conv,
        detailEntries: [],
        timelineItems: items,
        onRequestEdit: () => {},
      }),
    )

    const summaryBtn = ui.host.querySelector('button.trace-group-summary') as HTMLButtonElement
    assert.ok((summaryBtn.textContent ?? '').includes(zh('conv.thinking.exec', { count: 2 })))
    await act(async () => {
      summaryBtn.click()
    })
    await act(async () => {
      ;(ui.host.querySelector('.trace-group-steps .trace-row:not(.trace-thinking-row)') as HTMLElement).click()
    })

    const drawer = document.querySelector('[role="dialog"].process-inspector-drawer') as HTMLElement
    const zhDrawerText = drawer.textContent ?? ''
    assert.ok(zhDrawerText.includes(zh('conv.process.statusError')))
    assert.ok(zhDrawerText.includes(zh('conv.process.stepCounter', { current: 2, total: 2 })))
    assert.equal(EMOJI_RE.test(ui.host.textContent ?? ''), false)
    assert.equal(EMOJI_RE.test(zhDrawerText), false)

    await act(async () => {
      store.setLocale('en')
    })
    await waitForCondition(() => (summaryBtn.textContent ?? '').includes(en('conv.thinking.exec', { count: 2 })))
    const enDrawerText = drawer.textContent ?? ''
    assert.ok(enDrawerText.includes(en('conv.process.statusError')))
    assert.ok(enDrawerText.includes(en('conv.process.stepCounter', { current: 2, total: 2 })))
    assert.equal(EMOJI_RE.test(ui.host.textContent ?? ''), false)
    assert.equal(EMOJI_RE.test(enDrawerText), false)
  })
})
