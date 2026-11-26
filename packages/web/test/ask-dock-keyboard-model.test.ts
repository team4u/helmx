/**
 * AskCard 纯键盘处理器（ask-dock-keyboard-model.ts）单测：每个处理器只消费自己
 * 负责的按键族并如实报告事件是否已被接管，卡片状态只经 bridge 回调改动。
 * 覆盖 Ctrl/Cmd+Enter、Escape 回焦 Cancel、步进导航、数字键选预设 / 开 Other、
 * 箭头键在选项间移动、Enter 推进提交与 1/2 回焦确认按钮。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { AskAnswers, AskFieldSpec, AskSpec } from '@helmx/protocol'
import {
  focusConfirmButtonByDigit,
  handleArrowKeys,
  handleEnterAdvance,
  handleEscapeToCancel,
  handleModifierEnter,
  handleStepNavigationKeys,
  selectChoiceByDigit,
  type AskCardKeyboardBridge,
  type AskKeyEvent,
  type AskKeyboardChoiceTarget,
} from '../src/conversation/ask-dock/ask-dock-keyboard-model.js'

type Mods = { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean }

function keyEvent(key: string, mods: Mods = {}): AskKeyEvent {
  return new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    shiftKey: mods.shift === true,
    altKey: mods.alt === true,
    ctrlKey: mods.ctrl === true,
    metaKey: mods.meta === true,
  })
}

function choiceField(name: string, opts: { multiple?: boolean; allowCustom?: boolean } = {}): AskFieldSpec {
  return {
    name,
    label: name,
    type: 'choice',
    required: true,
    options: [
      { value: `${name}-a`, label: 'A' },
      { value: `${name}-b`, label: 'B' },
    ],
    ...(opts.multiple !== undefined ? { multiple: opts.multiple } : {}),
    ...(opts.allowCustom !== undefined ? { allowCustom: opts.allowCustom } : {}),
  }
}

function textField(name: string): AskFieldSpec {
  return { name, label: name, type: 'text', required: true }
}

function askOf(fields: AskFieldSpec[]): AskSpec {
  return { id: 'ask-kb', conversationId: 1, title: 't', fields, status: 'pending', createdAt: 0 }
}

interface BridgeLog {
  submits: AskAnswers[]
  patches: Array<[number, AskAnswers, { fromPresetClick?: boolean } | undefined]>
  steps: number[]
  focusedSteps: number[]
  optionFocus: Array<[string, number]>
  customFocus: string[]
  advances: Array<[number, AskAnswers]>
}

function makeBridge(overrides: Partial<AskCardKeyboardBridge> = {}): { kb: AskCardKeyboardBridge; log: BridgeLog } {
  const log: BridgeLog = { submits: [], patches: [], steps: [], focusedSteps: [], optionFocus: [], customFocus: [], advances: [] }
  const kb: AskCardKeyboardBridge = {
    ask: askOf([]),
    isStepper: false,
    isSingleConfirm: false,
    lastStepIndex: 0,
    formEl: document.createElement('form'),
    targetEl: null,
    sourceOrigin: 'form',
    curStep: 0,
    curAnswers: {},
    choiceTarget: undefined,
    cancelBtnRef: { current: null },
    setActiveStep: (update) => {
      log.steps.push(typeof update === 'function' ? update(kb.curStep) : update)
    },
    focusStepPrimaryControl: (stepIndex) => {
      log.focusedSteps.push(stepIndex)
      return true
    },
    submitAnswers: async (payload) => {
      log.submits.push(payload)
    },
    applyFieldPatch: (fieldIndex, patch, meta) => {
      log.patches.push([fieldIndex, patch, meta])
      return { ...kb.curAnswers, ...patch }
    },
    advanceOrSubmitFromStep: (fieldIndex, candidate) => {
      log.advances.push([fieldIndex, candidate])
    },
    requestOptionFocus: (fieldName, index) => {
      log.optionFocus.push([fieldName, index])
    },
    requestCustomFocus: (fieldName) => {
      log.customFocus.push(fieldName)
    },
    ...overrides,
  }
  return { kb, log }
}

function stepperNav(key: string, mods: Mods = {}): { consumed: boolean; steps: number[] } {
  const { kb, log } = makeBridge({ isStepper: true, lastStepIndex: 3, curStep: 2 })
  const consumed = handleStepNavigationKeys(kb, keyEvent(key, mods))
  return { consumed, steps: log.steps }
}

describe('ask-dock keyboard model', () => {
  test('Ctrl/Cmd+Enter submits a complete card, advances an incomplete stepper, and never submits a single-confirm', { timeout: 60_000 }, async () => {
    const complete = makeBridge({ ask: askOf([textField('q')]), curAnswers: { q: 'x' } })
    const ctrlEnter = keyEvent('Enter', { ctrl: true })
    assert.equal(handleModifierEnter(complete.kb, ctrlEnter), true, 'event consumed')
    assert.equal(ctrlEnter.defaultPrevented, true, 'default prevented')
    assert.deepEqual(complete.log.submits, [{ q: 'x' }], 'submits current answers')
    assert.deepEqual(complete.log.advances, [], 'no stepper advance when complete')

    const cmdEnter = keyEvent('Enter', { meta: true })
    assert.equal(handleModifierEnter(complete.kb, cmdEnter), true, 'Cmd+Enter behaves like Ctrl+Enter')

    const incomplete = makeBridge({
      ask: askOf([textField('q'), textField('r')]),
      isStepper: true,
      curStep: 1,
      curAnswers: { q: 'x' },
    })
    assert.equal(handleModifierEnter(incomplete.kb, keyEvent('Enter', { ctrl: true })), true)
    assert.deepEqual(incomplete.log.submits, [], 'incomplete card is not submitted')
    assert.equal(incomplete.log.advances.length, 1, 'incomplete stepper advances from the current step')
    assert.equal(incomplete.log.advances[0]?.[0], 1)

    const singleConfirm = makeBridge({ ask: askOf([{ name: 'c', label: 'c', type: 'confirm' }]), isSingleConfirm: true, curAnswers: { c: 'true' } })
    assert.equal(handleModifierEnter(singleConfirm.kb, keyEvent('Enter', { ctrl: true })), true)
    assert.deepEqual(singleConfirm.log.submits, [], 'single-confirm is never submitted by keyboard')
    assert.deepEqual(singleConfirm.log.advances, [], 'single-confirm is not a stepper')

    const altEnter = keyEvent('Enter', { ctrl: true, alt: true })
    assert.equal(handleModifierEnter(complete.kb, altEnter), false, 'Alt modified Enter is left alone')
    assert.equal(altEnter.defaultPrevented, false)
    assert.equal(handleModifierEnter(complete.kb, keyEvent('Enter')), false, 'plain Enter belongs to other handlers')
    assert.equal(handleModifierEnter(complete.kb, keyEvent('a', { ctrl: true })), false)
  })

  test('stepper navigation keys step back/forward with clamping and leave Shift+Arrow alone', { timeout: 60_000 }, () => {
    const flat = makeBridge()
    assert.equal(handleStepNavigationKeys(flat.kb, keyEvent('ArrowRight')), false, 'non-stepper ignores navigation')
    assert.deepEqual(flat.log.steps, [])

    for (const [key, expected, label] of [
      ['ArrowLeft', 1, 'ArrowLeft steps back'],
      ['PageUp', 1, 'PageUp steps back'],
      ['[', 1, "'[' steps back"],
      ['ArrowRight', 3, 'ArrowRight steps forward'],
      ['PageDown', 3, 'PageDown steps forward'],
      [']', 3, "']' steps forward"],
    ] as const) {
      const { consumed, steps } = stepperNav(key)
      assert.equal(consumed, true, label)
      assert.deepEqual(steps, [expected], label)
    }
    const shifted = stepperNav('ArrowRight', { shift: true })
    assert.equal(shifted.consumed, false, 'Shift+Arrow is not step navigation')
    assert.deepEqual(shifted.steps, [])
  })

  test('stepper navigation clamps at both ends', { timeout: 60_000 }, () => {
    const first = makeBridge({ isStepper: true, lastStepIndex: 2, curStep: 0 })
    handleStepNavigationKeys(first.kb, keyEvent('ArrowLeft'))
    assert.deepEqual(first.log.steps, [0], 'stays on the first step')
    const last = makeBridge({ isStepper: true, lastStepIndex: 2, curStep: 2 })
    handleStepNavigationKeys(last.kb, keyEvent('ArrowRight'))
    assert.deepEqual(last.log.steps, [2], 'stays on the last step')
  })

  test('Escape inside the form moves focus to an enabled Cancel/Skip button unless focus is already there', { timeout: 60_000 }, () => {
    const cancelBtn = document.createElement('button')
    cancelBtn.className = 'ask-dock-cancel'
    document.body.appendChild(cancelBtn)
    try {
      const elsewhere = makeBridge({ sourceOrigin: 'form', targetEl: document.body, cancelBtnRef: { current: cancelBtn } })
      const escape = keyEvent('Escape')
      assert.equal(handleEscapeToCancel(elsewhere.kb, escape), true)
      assert.equal(escape.defaultPrevented, true, 'swallows the first Escape so it never reaches the global abort')
      assert.ok(document.activeElement === cancelBtn, 'focus lands on Cancel/Skip')

      const onCancel = makeBridge({ sourceOrigin: 'form', targetEl: cancelBtn, cancelBtnRef: { current: cancelBtn } })
      const secondEscape = keyEvent('Escape')
      assert.equal(handleEscapeToCancel(onCancel.kb, secondEscape), true)
      assert.equal(secondEscape.defaultPrevented, false, 'second Escape yields to the global abort')

      cancelBtn.disabled = true
      const disabled = makeBridge({ sourceOrigin: 'form', targetEl: document.body, cancelBtnRef: { current: cancelBtn } })
      const disabledEscape = keyEvent('Escape')
      assert.equal(handleEscapeToCancel(disabled.kb, disabledEscape), true)
      assert.equal(disabledEscape.defaultPrevented, false, 'disabled button is not focused nor guarded')

      const fromWindow = makeBridge({ sourceOrigin: 'window', targetEl: null, cancelBtnRef: { current: cancelBtn } })
      assert.equal(handleEscapeToCancel(fromWindow.kb, keyEvent('Escape')), false, 'window chain never owns Escape')
      assert.equal(handleEscapeToCancel(elsewhere.kb, keyEvent('Escape', { shift: true })), false, 'Shift+Escape is left alone')
    } finally {
      cancelBtn.remove()
    }
  })

  test('digits pick or toggle presets, keep focus on the picked option only when the step does not move, and open Other one past the last preset', { timeout: 60_000 }, () => {
    const field = choiceField('q', { allowCustom: true })
    const ask = askOf([field])
    const target: AskKeyboardChoiceTarget = { field, fieldIndex: 0 }

    const single = makeBridge({ ask, choiceTarget: target, curAnswers: {} })
    const one = keyEvent('1')
    assert.equal(selectChoiceByDigit(single.kb, one), true)
    assert.equal(one.defaultPrevented, true)
    assert.deepEqual(single.log.patches, [[0, { q: 'q-a' }, { fromPresetClick: false }]], 'flat card patches without auto-advance')
    assert.deepEqual(single.log.optionFocus, [['q', 0]], 'focus stays on the picked option')

    const stepper = makeBridge({ ask: askOf([field, textField('r')]), isStepper: true, choiceTarget: target, curAnswers: {} })
    assert.equal(selectChoiceByDigit(stepper.kb, keyEvent('1')), true)
    assert.deepEqual(stepper.log.patches, [[0, { q: 'q-a' }, { fromPresetClick: true }]], 'stepper asks for auto-advance')
    assert.deepEqual(stepper.log.optionFocus, [], 'another step is still unanswered, so focus is not pulled back')
    const stepperLast = makeBridge({ ask, isStepper: true, choiceTarget: target, curAnswers: {} })
    assert.equal(selectChoiceByDigit(stepperLast.kb, keyEvent('2')), true)
    assert.deepEqual(stepperLast.log.optionFocus, [['q', 1]], 'last step keeps focus on the picked option')

    const custom = makeBridge({ ask, choiceTarget: target, curAnswers: {} })
    const three = keyEvent('3')
    assert.equal(selectChoiceByDigit(custom.kb, three), true)
    assert.equal(three.defaultPrevented, true)
    assert.deepEqual(custom.log.patches, [], 'Other digit does not patch answers')
    assert.deepEqual(custom.log.customFocus, ['q'], 'opens and focuses the custom input')

    const strict = choiceField('s')
    const noCustom = makeBridge({ ask, choiceTarget: { field: strict, fieldIndex: 0 }, curAnswers: {} })
    assert.equal(selectChoiceByDigit(noCustom.kb, keyEvent('3')), false, 'without allowCustom the digit falls through')
    assert.equal(selectChoiceByDigit(single.kb, keyEvent('4')), false, 'out of range digit falls through')
    assert.equal(selectChoiceByDigit(single.kb, keyEvent('1', { shift: true })), false, 'Shift+digit is left alone')
    assert.equal(selectChoiceByDigit(makeBridge({ ask, choiceTarget: undefined }).kb, keyEvent('1')), false, 'no choice target')

    const multiField = choiceField('m', { multiple: true })
    const multi = makeBridge({ ask, choiceTarget: { field: multiField, fieldIndex: 0 }, curAnswers: { m: ['m-a', 'free text'] } })
    assert.equal(selectChoiceByDigit(multi.kb, keyEvent('1')), true)
    assert.deepEqual(multi.log.patches, [[0, { m: ['free text'] }, undefined]], 'toggling a selected preset off keeps the custom entry')
    assert.equal(selectChoiceByDigit(multi.kb, keyEvent('2')), true)
    assert.deepEqual(multi.log.patches[1], [0, { m: ['m-a', 'm-b', 'free text'] }, undefined], 'toggling adds the preset in option order')
    assert.deepEqual(multi.log.optionFocus, [['m', 0], ['m', 1]])
  })

  test('ArrowDown/ArrowUp move through the active choice field or enter the current step control from card/window, but never from inside a radio/checkbox', { timeout: 60_000 }, () => {
    const field = choiceField('q', { allowCustom: true })
    const ask = askOf([field])
    const target: AskKeyboardChoiceTarget = { field, fieldIndex: 0 }

    const radio = document.createElement('button')
    radio.setAttribute('role', 'radio')
    const insideRadio = makeBridge({ ask, choiceTarget: target, targetEl: radio })
    assert.equal(handleArrowKeys(insideRadio.kb, keyEvent('ArrowDown')), false, 'roving tabindex inside the group handles its own arrows')
    assert.equal(handleArrowKeys(makeBridge({ ask, choiceTarget: target }).kb, keyEvent('Enter')), false, 'other keys are ignored')

    const down = makeBridge({ ask, choiceTarget: target, curAnswers: {} })
    const downEvent = keyEvent('ArrowDown')
    assert.equal(handleArrowKeys(down.kb, downEvent), true)
    assert.equal(downEvent.defaultPrevented, true)
    assert.deepEqual(down.log.patches, [[0, { q: 'q-a' }, { fromPresetClick: false }]], 'ArrowDown from empty picks the first preset')
    assert.deepEqual(down.log.optionFocus, [['q', 0]])

    const wrapToCustom = makeBridge({ ask, choiceTarget: target, curAnswers: { q: 'q-b' } })
    assert.equal(handleArrowKeys(wrapToCustom.kb, keyEvent('ArrowDown')), true)
    assert.deepEqual(wrapToCustom.log.patches, [], 'the slot after the last preset is Other, not a preset')
    assert.deepEqual(wrapToCustom.log.customFocus, ['q'], 'focus moves into the custom input')

    const upFromEmpty = makeBridge({ ask, choiceTarget: target, curAnswers: {} })
    assert.equal(handleArrowKeys(upFromEmpty.kb, keyEvent('ArrowUp')), true)
    assert.deepEqual(upFromEmpty.log.customFocus, ['q'], 'ArrowUp from empty wraps to the last slot (Other)')

    const upNoCustom = makeBridge({ ask, choiceTarget: { field: choiceField('q'), fieldIndex: 0 }, curAnswers: { q: 'q-a' } })
    assert.equal(handleArrowKeys(upNoCustom.kb, keyEvent('ArrowUp')), true)
    assert.deepEqual(upNoCustom.log.patches[0]?.[1], { q: 'q-b' }, 'ArrowUp wraps around to the last preset without Other')

    const multiField = choiceField('m', { multiple: true })
    const multi = makeBridge({ ask, choiceTarget: { field: multiField, fieldIndex: 0 }, curAnswers: {} })
    assert.equal(handleArrowKeys(multi.kb, keyEvent('ArrowDown')), true)
    assert.equal(handleArrowKeys(multi.kb, keyEvent('ArrowUp')), true)
    assert.deepEqual(multi.log.patches, [], 'multi-select arrows only move focus, never toggle')
    assert.deepEqual(multi.log.optionFocus, [['m', 0], ['m', 1]])

    const fromWindow = makeBridge({ ask, choiceTarget: undefined, sourceOrigin: 'window', curStep: 2 })
    const windowEvent = keyEvent('ArrowDown')
    assert.equal(handleArrowKeys(fromWindow.kb, windowEvent), true)
    assert.equal(windowEvent.defaultPrevented, true)
    assert.deepEqual(fromWindow.log.focusedSteps, [2], 'enters the active step control from the window')

    const form = document.createElement('form')
    const onForm = makeBridge({ ask, choiceTarget: undefined, sourceOrigin: 'form', formEl: form, targetEl: form, curStep: 1 })
    handleArrowKeys(onForm.kb, keyEvent('ArrowUp'))
    assert.deepEqual(onForm.log.focusedSteps, [1], 'enters the active step control from the card itself')

    const onChild = makeBridge({ ask, choiceTarget: undefined, sourceOrigin: 'form', formEl: form, targetEl: document.createElement('span'), curStep: 1 })
    const childEvent = keyEvent('ArrowDown')
    assert.equal(handleArrowKeys(onChild.kb, childEvent), true, 'arrow is still consumed')
    assert.equal(childEvent.defaultPrevented, false)
    assert.deepEqual(onChild.log.focusedSteps, [], 'focus inside a non-choice control is left where it is')
  })

  test('Enter advances or submits from a non-interactive target and keeps native activation for buttons and links', { timeout: 60_000 }, () => {
    const plain = makeBridge({ curStep: 1, curAnswers: { q: 'x' } })
    const enter = keyEvent('Enter')
    assert.equal(handleEnterAdvance(plain.kb, enter), true)
    assert.equal(enter.defaultPrevented, true)
    assert.deepEqual(plain.log.advances, [[1, { q: 'x' }]])

    const link = document.createElement('a')
    assert.equal(handleEnterAdvance(makeBridge({ targetEl: link }).kb, keyEvent('Enter')), false, 'links keep native Enter')
    const roleButton = document.createElement('div')
    roleButton.setAttribute('role', 'button')
    const nested = document.createElement('span')
    roleButton.appendChild(nested)
    assert.equal(handleEnterAdvance(makeBridge({ targetEl: nested }).kb, keyEvent('Enter')), false, 'targets inside an interactive element keep native Enter')
    assert.equal(handleEnterAdvance(plain.kb, keyEvent('Enter', { shift: true })), false, 'Shift+Enter is left alone')
    assert.equal(handleEnterAdvance(plain.kb, keyEvent('a')), false)
  })

  test('digits 1/2 focus the enabled confirm buttons of the sole confirm step when no choice field owns digits', { timeout: 60_000 }, () => {
    const form = document.createElement('form')
    form.innerHTML =
      '<div class="ask-dock-step-panel"><div class="ask-dock-confirm-actions">' +
      '<button disabled>Reject</button><button>Approve</button><button>Other</button>' +
      '</div></div>'
    const confirmAsk = askOf([{ name: 'c', label: 'c', type: 'confirm' }])
    // happy-dom only focuses elements attached to the document.
    document.body.appendChild(form)
    const buttons = [...form.querySelectorAll<HTMLButtonElement>('.ask-dock-confirm-actions button:not(:disabled)')]
    const kb = makeBridge({ ask: confirmAsk, formEl: form, choiceTarget: undefined }).kb

    const one = keyEvent('1')
    assert.equal(focusConfirmButtonByDigit(kb, one), true)
    assert.equal(one.defaultPrevented, true)
    assert.ok(document.activeElement === buttons[0], '1 focuses the first enabled confirm button (Approve)')
    const two = keyEvent('2')
    assert.equal(focusConfirmButtonByDigit(kb, two), true)
    assert.ok(document.activeElement === buttons[1], '2 focuses the second enabled confirm button')

    assert.equal(focusConfirmButtonByDigit(makeBridge({ ask: confirmAsk, formEl: form, choiceTarget: { field: choiceField('q'), fieldIndex: 0 } }).kb, keyEvent('1')), false, 'a choice target owns digits')
    assert.equal(focusConfirmButtonByDigit(kb, keyEvent('1', { shift: true })), false)
    assert.equal(focusConfirmButtonByDigit(kb, keyEvent('3')), false, 'only 1/2 map to confirm buttons')
    const twoConfirms = askOf([{ name: 'c1', label: 'c1', type: 'confirm' }, { name: 'c2', label: 'c2', type: 'confirm' }])
    assert.equal(focusConfirmButtonByDigit(makeBridge({ ask: twoConfirms, formEl: form }).kb, keyEvent('1')), false, 'ambiguous confirm steps are skipped on a flat card')
    const stepperOnText = makeBridge({ ask: confirmAsk, formEl: form, isStepper: true, curStep: 1 }).kb
    assert.equal(focusConfirmButtonByDigit(stepperOnText, keyEvent('1')), false, 'stepper only maps the active confirm step')
  })
})
