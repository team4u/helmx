/**
 * Composer + ModelPicker one-turn model/thinking override & runtimeModelOverride DOM tests
 * (real mount + Radix Popover interaction in happy-dom).
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { ConversationSummary, ModelTierCatalogEntry } from '@helmx/protocol'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import { ensureHappyDom, resetHappyDom, typeIntoControl } from './helpers/dom-harness.js'

ensureHappyDom()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { createRoot } = await import('react-dom/client')
const { HostStoreProviders } = await import('./helpers/host-store.js')
const { makeTestStore } = await import('./helpers/store.js')
const { conversationsApi } = await import('../src/lib/api.js')
const { Composer } = await import('../src/conversation/Composer.js')

const e = React.createElement

type TestModelList = NonNullable<NonNullable<Parameters<typeof makeTestStore>[0]>['models']>

const BASE_MODELS: TestModelList = [
  { id: 'faux/glm-4.6', provider: 'faux', modelId: 'glm-4.6', available: true, thinkingLevels: ['off', 'low', 'high'] },
  { id: 'anthropic/claude-opus-4-6', provider: 'anthropic', modelId: 'claude-opus-4-6', available: true, thinkingLevels: ['off', 'medium', 'max'] },
  { id: 'anthropic/claude-3-7-sonnet', provider: 'anthropic', modelId: 'claude-3-7-sonnet', available: true, thinkingLevels: ['off', 'high'] },
]

const TEST_TIERS: ModelTierCatalogEntry[] = [
  { id: 'claude-auto', model: 'anthropic/claude-3-7-sonnet', available: true, thinkingLevel: 'high', thinkingLevels: ['off', 'high'], description: 'Auto' },
]

function makeConv(id: number, patch: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    title: `会话 ${id}`,
    profileId: 'assistant',
    tags: [],
    ownedBy: 'human',
    cwd: '/tmp',
    model: 'faux/glm-4.6',
    thinkingLevel: 'low',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

interface MountedHarness {
  host: HTMLElement
  store: HelmxExternalStore
  rerender: (nextConv: ConversationSummary, prefill?: React.ComponentProps<typeof Composer>['prefill']) => void
  ta: () => HTMLTextAreaElement
  unmount: () => void
}

function mountComposerApp(
  initialConv: ConversationSummary,
  extraTiers: ModelTierCatalogEntry[] = [],
): MountedHarness {
  const store = makeTestStore({
    conversations: [initialConv],
    models: BASE_MODELS,
    ...(extraTiers.length > 0 ? { modelDefaults: { modelTiers: extraTiers } } : {}),
    primaryTarget: { kind: 'conversation', conversationId: initialConv.id },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const render = (conv: ConversationSummary, prefill: React.ComponentProps<typeof Composer>['prefill'] = null): void => {
    act(() => {
      root.render(e(HostStoreProviders, { value: store }, e(Composer, { conversation: conv, prefill })))
    })
  }
  render(initialConv)
  return {
    host,
    store,
    rerender: (nextConv, prefill = null) => render(nextConv, prefill),
    ta: () => host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!,
    unmount: () => {
      act(() => root.unmount())
      host.remove()
    },
  }
}

function openModelPopover(host: HTMLElement): HTMLElement {
  const btn = host.querySelector<HTMLButtonElement>('button.composer-model-button')
  assert.ok(btn !== null, 'model picker trigger must exist')
  act(() => { btn.click() })
  const popover = document.body.querySelector<HTMLElement>('.composer-model-popover')
  assert.ok(popover !== null, 'model picker popover must open')
  return popover
}

function selectNextTurnTab(popover: HTMLElement): HTMLButtonElement {
  const tab = Array.from(popover.querySelectorAll<HTMLButtonElement>('[role="radio"], button'))
    .find((btn) => btn.textContent?.trim() === 'Next turn only')
  assert.ok(tab !== undefined, 'Next turn only mode tab must exist')
  act(() => { tab.click() })
  return tab
}

function findRow(popover: HTMLElement, canonicalModel: string): HTMLElement {
  const row = Array.from(popover.querySelectorAll<HTMLElement>('.composer-model-row'))
    .find((el) => el.querySelector<HTMLButtonElement>('.composer-model-row-main')?.title.includes(canonicalModel))
  assert.ok(row !== undefined, `model row must exist: ${canonicalModel}`)
  return row
}

function findLevelChip(row: HTMLElement, level: string): HTMLButtonElement {
  const chip = Array.from(row.querySelectorAll<HTMLButtonElement>('.composer-model-level-chip'))
    .find((btn) => btn.textContent?.trim() === level)
  assert.ok(chip !== undefined, `level chip must exist: ${level}`)
  return chip
}

function stubComposerApis(opts?: { submitError?: Error }): {
  submits: Array<{ id: number; body: Record<string, unknown> }>
  patches: Array<{ id: number; body: Record<string, unknown> }>
  restore: () => void
} {
  const originalSubmit = conversationsApi.submitInput
  const originalPatch = conversationsApi.patch
  const submits: Array<{ id: number; body: Record<string, unknown> }> = []
  const patches: Array<{ id: number; body: Record<string, unknown> }> = []
  conversationsApi.submitInput = (async (id: number, body: Record<string, unknown>) => {
    submits.push({ id, body })
    if (opts?.submitError !== undefined) throw opts.submitError
    return { submissionId: 'sub-1', status: 'dispatched' }
  }) as unknown as typeof conversationsApi.submitInput
  conversationsApi.patch = (async (id: number, body: Record<string, unknown>) => {
    patches.push({ id, body })
    return makeConv(id)
  }) as unknown as typeof conversationsApi.patch
  return {
    submits,
    patches,
    restore: () => {
      conversationsApi.submitInput = originalSubmit
      conversationsApi.patch = originalPatch
    },
  }
}

describe('Composer one-turn override & runtimeModelOverride', () => {
  afterEach(() => {
    resetHappyDom()
  }, { timeout: 60_000 })

  test('stages nextTurnMode in popover, allows X clear, forwards { model, thinkingLevel } on send, and clears on success', { timeout: 60_000 }, async () => {
    const api = stubComposerApis()
    const h = mountComposerApp(makeConv(1, { modelOverride: 'faux/glm-4.6' }))
    try {
      const popover = openModelPopover(h.host)
      selectNextTurnTab(popover)
      const opusRow = findRow(popover, 'anthropic/claude-opus-4-6')
      await act(async () => { findLevelChip(opusRow, 'max').click() })

      assert.equal(api.patches.length, 0, 'staging one-turn override must not call PATCH')
      assert.ok(h.host.querySelector('.composer-picker-root.composer-model-has-next-turn') !== null)
      assert.equal(h.host.querySelector('.composer-model-next-turn-badge')?.textContent?.trim(), 'Next turn')
      assert.equal(h.host.querySelector('.composer-model-label')?.textContent?.trim(), 'claude-opus-4-6')
      assert.equal(h.host.querySelector('.composer-model-level')?.textContent?.trim(), '· max')
      const triggerTitle = h.host.querySelector<HTMLButtonElement>('button.composer-model-button')?.title ?? ''
      assert.ok(triggerTitle.includes('anthropic/claude-opus-4-6'), 'title shows staged target model')
      assert.ok(triggerTitle.includes('faux/glm-4.6'), 'title keeps baseline model')

      // Clear via inline X button restores baseline without submitting
      const clearBtn = h.host.querySelector<HTMLButtonElement>('button.composer-model-next-turn-clear')
      assert.ok(clearBtn !== null, 'clear one-turn button renders when staged')
      await act(async () => { clearBtn.click() })
      assert.ok(h.host.querySelector('.composer-model-next-turn-badge') === null)
      assert.equal(h.host.querySelector('.composer-model-label')?.textContent?.trim(), 'glm-4.6')
      assert.equal(h.host.querySelector('.composer-model-level')?.textContent?.trim(), '· low')

      // Re-stage without explicit level (model row body click) and submit
      const popover2 = openModelPopover(h.host)
      selectNextTurnTab(popover2)
      const sonnetRow = findRow(popover2, 'anthropic/claude-3-7-sonnet')
      await act(async () => { sonnetRow.querySelector<HTMLButtonElement>('.composer-model-row-main')!.click() })

      act(() => { typeIntoControl(h.ta(), '一轮临时模型测试') })
      await act(async () => {
        h.ta().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(api.submits.length, 1)
      assert.deepEqual(api.submits[0]?.body, {
        text: '一轮临时模型测试',
        origin: 'human',
        model: 'anthropic/claude-3-7-sonnet',
      })
      assert.ok(h.host.querySelector('.composer-model-next-turn-badge') === null, 'staged badge clears after submit resolves')
      assert.equal(h.host.querySelector('.composer-model-label')?.textContent?.trim(), 'glm-4.6')
    } finally {
      api.restore()
      h.unmount()
    }
  })

  test('preserves staged override on submit failure and clears immediately when conversation.id changes', { timeout: 60_000 }, async () => {
    const opts: { submitError?: Error } = { submitError: new Error('network glitch') }
    const api = stubComposerApis(opts)
    const conv1 = makeConv(1)
    const h = mountComposerApp(conv1)
    try {
      const popover = openModelPopover(h.host)
      selectNextTurnTab(popover)
      const opusRow = findRow(popover, 'anthropic/claude-opus-4-6')
      await act(async () => { findLevelChip(opusRow, 'medium').click() })

      act(() => { typeIntoControl(h.ta(), '失败保留测试') })
      await act(async () => {
        h.ta().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(api.submits.length, 1)
      assert.equal(h.ta().value, '失败保留测试', 'draft rolls back on submit failure')
      assert.ok(h.host.querySelector('.composer-model-next-turn-badge') !== null, 'staged override survives submit failure')

      // Switching conversation on the same mounted Composer clears the staged override immediately
      h.rerender(makeConv(2))
      assert.ok(h.host.querySelector('.composer-model-next-turn-badge') === null, 'conversation switch clears staged override')
      assert.equal(h.host.querySelector('.composer-model-label')?.textContent?.trim(), 'glm-4.6')
    } finally {
      api.restore()
      h.unmount()
    }
  })

  test('disables and clears staged nextTurnMode when busy, blocked, compacting, pendingAsk, editing, or ownedBy=helmx', { timeout: 60_000 }, async () => {
    const api = stubComposerApis()
    const h = mountComposerApp(makeConv(1))
    try {
      // 1) Stage then transition to working -> clears staged override and disables Next turn tab
      const pop1 = openModelPopover(h.host)
      selectNextTurnTab(pop1)
      await act(async () => { findLevelChip(findRow(pop1, 'anthropic/claude-opus-4-6'), 'max').click() })
      assert.ok(h.host.querySelector('.composer-model-next-turn-badge') !== null)

      h.rerender(makeConv(1, { status: 'working' }))
      assert.ok(h.host.querySelector('.composer-model-next-turn-badge') === null, 'working clears staged badge')
      assert.ok(h.host.querySelector('.composer-model-next-turn-clear') === null)
      const busyPop = openModelPopover(h.host)
      const busyTab = Array.from(busyPop.querySelectorAll<HTMLButtonElement>('[role="radio"], button'))
        .find((btn) => btn.textContent?.trim() === 'Next turn only')
      assert.ok(busyTab !== undefined && busyTab.disabled, 'Next turn only tab disabled while working')
      act(() => {
        busyPop.querySelector('input[aria-label="Search models"]')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })

      // Sending steer while working never carries model/thinkingLevel
      act(() => { typeIntoControl(h.ta(), '忙时引导') })
      await act(async () => {
        h.ta().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(api.submits[0]?.body.model, undefined)
      assert.equal(api.submits[0]?.body.thinkingLevel, undefined)

      // 2) Return idle, re-stage, then enter history edit via prefill.entryId -> clears staged & omits on resend
      h.rerender(makeConv(1, { status: 'idle' }))
      const pop2 = openModelPopover(h.host)
      selectNextTurnTab(pop2)
      await act(async () => { findLevelChip(findRow(pop2, 'anthropic/claude-opus-4-6'), 'max').click() })
      assert.ok(h.host.querySelector('.composer-model-next-turn-badge') !== null)

      h.rerender(makeConv(1, { status: 'idle' }), { text: '重编历史', entryId: 99, tick: 1 })
      assert.ok(h.host.querySelector('.composer-model-next-turn-badge') === null, 'editing mode clears staged badge')
      await act(async () => {
        h.ta().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      assert.equal(api.submits[1]?.body.replaceFromEntryId, 99)
      assert.equal(api.submits[1]?.body.model, undefined)

      // 3) pendingAskCount > 0 and compacting disable Next turn tab
      h.rerender(makeConv(1, { pendingAskCount: 1 }), { text: '', tick: 2 })
      const askPop = openModelPopover(h.host)
      const askTab = Array.from(askPop.querySelectorAll<HTMLButtonElement>('[role="radio"], button'))
        .find((btn) => btn.textContent?.trim() === 'Next turn only')
      assert.ok(askTab !== undefined && askTab.disabled, 'pendingAskCount > 0 disables Next turn only tab')
      act(() => {
        askPop.querySelector('input[aria-label="Search models"]')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })

      h.rerender(makeConv(1, { contextUsage: { tokens: 1000, contextWindow: 8000, compacting: true } }))
      const compactPop = openModelPopover(h.host)
      const compactTab = Array.from(compactPop.querySelectorAll<HTMLButtonElement>('[role="radio"], button'))
        .find((btn) => btn.textContent?.trim() === 'Next turn only')
      assert.ok(compactTab !== undefined && compactTab.disabled, 'compacting disables Next turn only tab')
      act(() => {
        compactPop.querySelector('input[aria-label="Search models"]')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })

      // 4) Non-human conversation disables Next turn tab
      h.rerender(makeConv(1, { ownedBy: 'helmx' }))
      const managedPop = openModelPopover(h.host)
      const managedTab = Array.from(managedPop.querySelectorAll<HTMLButtonElement>('[role="radio"], button'))
        .find((btn) => btn.textContent?.trim() === 'Next turn only')
      assert.ok(managedTab !== undefined && managedTab.disabled, 'ownedBy=helmx disables Next turn only tab')
    } finally {
      api.restore()
      h.unmount()
    }
  })

  test('displays runtimeModelOverride indicator with baseline, handles profile/global baseline, promotes running model via full PATCH, and renders tier modelOverride', { timeout: 60_000 }, async () => {
    const api = stubComposerApis()
    const h = mountComposerApp(
      makeConv(1, {
        model: 'anthropic/claude-opus-4-6',
        modelOverride: 'faux/glm-4.6',
        runtimeModelOverride: true,
        thinkingLevel: 'max',
      }),
      TEST_TIERS,
    )
    try {
      const wrap = h.host.querySelector('.composer-model-runtime-wrap[data-runtime-override="true"]')
      assert.ok(wrap !== null, 'runtime override indicator wrapper renders')
      assert.equal(h.host.querySelector('.composer-model-runtime-badge')?.textContent?.trim(), 'Temp override')
      assert.ok(h.host.querySelector('.composer-model-runtime-baseline') === null, 'inline baseline text omitted for mobile cleanliness')
      assert.equal(h.host.querySelector('.composer-model-label')?.textContent?.trim(), 'claude-opus-4-6')
      assert.equal(h.host.querySelector('.composer-model-level')?.textContent?.trim(), '· max')

      const btn = h.host.querySelector<HTMLButtonElement>('button.composer-model-button')!
      assert.ok(btn.title.includes('anthropic/claude-opus-4-6') && btn.title.includes('faux/glm-4.6'))
      assert.ok((btn.getAttribute('aria-label') ?? '').includes('claude-opus-4-6') && (btn.getAttribute('aria-label') ?? '').includes('glm-4.6'))

      // Clicking the currently active temporary model in "Switch model" sends a full { model } patch (not thinkingLevel-only)
      const pop = openModelPopover(h.host)
      const opusMain = findRow(pop, 'anthropic/claude-opus-4-6').querySelector<HTMLButtonElement>('.composer-model-row-main')!
      await act(async () => { opusMain.click() })
      assert.deepEqual(api.patches, [{ id: 1, body: { model: 'anthropic/claude-opus-4-6' } }])

      // When baseline follows profile/global default (modelOverride omitted), baseline span omits and copy reflects profile/global default
      h.rerender(makeConv(1, {
        model: 'anthropic/claude-opus-4-6',
        runtimeModelOverride: true,
        thinkingLevel: 'max',
      }))
      assert.ok(h.host.querySelector('.composer-model-runtime-wrap') !== null)
      assert.ok(h.host.querySelector('.composer-model-runtime-baseline') === null)
      const defaultBtn = h.host.querySelector<HTMLButtonElement>('button.composer-model-button')!
      assert.ok(defaultBtn.title.includes('profile/global default'))

      // Tier baseline (no runtimeModelOverride): shows tier/claude-auto cleanly without referencing modelTier
      h.rerender(makeConv(1, {
        model: 'anthropic/claude-3-7-sonnet',
        modelOverride: 'tier/claude-auto',
        thinkingLevel: 'high',
      }))
      assert.ok(h.host.querySelector('.composer-model-runtime-wrap') === null)
      assert.equal(h.host.querySelector('.composer-model-label')?.textContent?.trim(), 'tier/claude-auto')
      assert.ok(h.host.querySelector<HTMLButtonElement>('button.composer-model-button')!.title.includes('tier/claude-auto (anthropic/claude-3-7-sonnet)'))
    } finally {
      api.restore()
      h.unmount()
    }
  })

  test('renders effectiveModelRef displayLabel, orchestrator group header, Next-turn eligibility filter & hides preserveRef tiers on child/helmx conversations', { timeout: 60_000 }, async () => {
    const richTiers: ModelTierCatalogEntry[] = [
      ...TEST_TIERS,
      {
        id: 'claude-orch',
        model: 'anthropic/claude-opus-4-6',
        available: true,
        thinkingLevel: 'medium',
        thinkingLevels: ['off', 'medium', 'max'],
        description: 'Plan then review',
        displayGroup: 'orchestrator',
        displayLabel: 'Claude 精修',
        displayDetail: 'opus → sonnet',
        preserveRef: true,
        singleTurnEligible: false,
      },
    ]
    const h = mountComposerApp(
      makeConv(1, {
        model: 'anthropic/claude-opus-4-6',
        effectiveModelRef: 'tier/claude-orch',
        thinkingLevel: 'medium',
      }),
      richTiers,
    )
    try {
      assert.equal(h.host.querySelector('.composer-model-label')?.textContent?.trim(), 'Claude 精修')
      assert.ok(h.host.querySelector('.composer-model-tier-trigger-icon') !== null)
      assert.ok(h.host.querySelector('.composer-model-level') === null)

      // During Orchestrator execution (runtimeModelOverride: true), trigger stays stable on displayLabel without Temp override badge
      h.rerender(
        makeConv(1, {
          model: 'anthropic/claude-3-7-sonnet',
          effectiveModelRef: 'tier/claude-orch',
          runtimeModelOverride: true,
          thinkingLevel: 'high',
        }),
      )
      assert.equal(h.host.querySelector('.composer-model-label')?.textContent?.trim(), 'Claude 精修')
      assert.ok(h.host.querySelector('.composer-model-level') === null)
      assert.ok(h.host.querySelector('.composer-model-runtime-wrap') === null)
      assert.ok(h.host.querySelector('.composer-model-runtime-badge') === null)

      const pop = openModelPopover(h.host)
      const headers = Array.from(pop.querySelectorAll('.popover-header')).map((el) => el.textContent?.trim())
      assert.deepEqual(headers, ['Orchestrator', 'Model tiers', 'Model list'])
      assert.match(pop.textContent ?? '', /Claude 精修/)
      assert.match(pop.textContent ?? '', /opus → sonnet/)

      // Next turn only hides singleTurnEligible: false tiers
      const nextTurnTab = Array.from(pop.querySelectorAll<HTMLButtonElement>('.composer-model-mode-bar [role="tab"]'))
        .find((btn) => (btn.textContent ?? '').includes('Next turn only'))!
      await act(async () => {
        nextTurnTab.click()
      })
      assert.doesNotMatch(pop.textContent ?? '', /Claude 精修/)
      assert.match(pop.textContent ?? '', /tier\/claude-auto/)

      // Close and rerender as child conversation -> preserveRef tiers hidden
      act(() => {
        pop.querySelector('input[aria-label="Search models"]')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      h.rerender(makeConv(1, { parentConversationId: 99, model: 'anthropic/claude-opus-4-6' }))
      const childPop = openModelPopover(h.host)
      assert.doesNotMatch(childPop.textContent ?? '', /Claude 精修/)
      assert.match(childPop.textContent ?? '', /tier\/claude-auto/)
    } finally {
      h.unmount()
    }
  })
})
