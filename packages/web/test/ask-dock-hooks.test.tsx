/**
 * AskCard 自定义 hook 装配测试（createRoot + act，happy-dom）：
 * - useAskCardAnswers：patch 同步镜像进 answersRef、stepper 单选点击自动跳到下一未答步骤、
 *   推进 / 提交 / 聚焦首个缺失字段、单确认与单快选即答即提交、表单提交守卫；
 * - useAskCardSubmission：answer 携带 expectedStateSeq CAS 水位、cancel 走原 API、
 *   在途锁定、错误就地呈现、仅最后一张卡且焦点未被他处持有时归还焦点。
 * 焦点归属与共享键盘链由 ask-dock.test.tsx 端到端覆盖，此处不重复。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { describe, afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { AskAnswers, AskFieldSpec, AskSpec } from '@helmx/protocol'
import { ensureHappyDom, resetHappyDom } from './helpers/dom-harness.js'

ensureHappyDom()
const { createRoot } = await import('react-dom/client')
const e = React.createElement

import { useAskCardAnswers, type AskCardAnswers } from '../src/conversation/ask-dock/use-ask-card-answers.js'
import {
  useAskCardSubmission,
  type AskCardSubmission,
  type AskSubmitting,
} from '../src/conversation/ask-dock/use-ask-card-submission.js'

type Submitting = AskSubmitting

const originalFetch = globalThis.fetch
let root: Root | undefined
let host: HTMLElement | undefined
let posts: Array<{ url: string; body: Record<string, unknown> }> = []
let respond: () => Promise<Response> = async () => jsonResponse(200, { ok: true })

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

/** 记录 POST 请求体并由测试决定何时 / 如何响应，便于观察在途锁定态。 */
function installFetch(responder: () => Promise<Response> = () => Promise.resolve(jsonResponse(200, { ok: true }))): void {
  posts = []
  respond = responder
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if ((init?.method ?? 'GET') === 'POST') {
      const raw = typeof init?.body === 'string' ? init.body : '{}'
      posts.push({ url, body: JSON.parse(raw) as Record<string, unknown> })
      return respond()
    }
    return jsonResponse(200, [])
  }) as typeof fetch
}

async function mount(element: React.ReactElement): Promise<void> {
  // 同一测试内多次挂载时先卸载上一棵树，避免残留 DOM 与 hook 实例。
  if (root !== undefined) act(() => root?.unmount())
  host?.remove()
  host = document.createElement('div')
  document.body.appendChild(host)
  await act(async () => {
    root = createRoot(host!)
    root.render(element)
  })
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  resetHappyDom()
  globalThis.fetch = originalFetch
}, { timeout: 60_000 })

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

function askOf(id: string, fields: AskFieldSpec[], expectedStateSeq?: number): AskSpec {
  return {
    id,
    conversationId: 1,
    title: id,
    kind: 'question',
    fields,
    status: 'pending',
    createdAt: 0,
    ...(expectedStateSeq !== undefined ? { expectedStateSeq } : {}),
  }
}

// ---------------------------------------------------------------------------
// useAskCardAnswers
// ---------------------------------------------------------------------------

interface AnswersHarnessProps {
  ask: AskSpec
  isStepper: boolean
  isSingleConfirm: boolean
  isSingleQuickChoice: boolean
  submitting: Submitting
  submitAnswers: (payload: AskAnswers) => Promise<void>
  focusStepPrimaryControl: (stepIndex: number) => boolean
  onApi: (api: AskCardAnswers & { activeStep: number }) => void
}

function AnswersHarness(props: AnswersHarnessProps): null {
  const [activeStep, setActiveStep] = React.useState(0)
  const submittingRef = React.useRef<Submitting>(props.submitting)
  submittingRef.current = props.submitting
  const api = useAskCardAnswers({
    ask: props.ask,
    isStepper: props.isStepper,
    isSingleConfirm: props.isSingleConfirm,
    isSingleQuickChoice: props.isSingleQuickChoice,
    lastStepIndex: Math.max(0, props.ask.fields.length - 1),
    submittingRef,
    submitAnswers: props.submitAnswers,
    focusStepPrimaryControl: props.focusStepPrimaryControl,
    setActiveStep,
  })
  props.onApi({ ...api, activeStep })
  return null
}

interface AnswersProbe {
  api: AskCardAnswers & { activeStep: number }
  submits: AskAnswers[]
  focusedSteps: number[]
}

async function mountAnswers(options: {
  ask: AskSpec
  isStepper?: boolean
  isSingleConfirm?: boolean
  isSingleQuickChoice?: boolean
}): Promise<AnswersProbe> {
  const probe: AnswersProbe = { api: undefined as unknown as AnswersProbe['api'], submits: [], focusedSteps: [] }
  await mount(
    e(AnswersHarness, {
      ask: options.ask,
      isStepper: options.isStepper ?? false,
      isSingleConfirm: options.isSingleConfirm ?? false,
      isSingleQuickChoice: options.isSingleQuickChoice ?? false,
      submitting: null,
      submitAnswers: async (payload) => {
        probe.submits.push(payload)
      },
      focusStepPrimaryControl: (stepIndex) => {
        probe.focusedSteps.push(stepIndex)
        return true
      },
      onApi: (api) => {
        probe.api = api
      },
    }),
  )
  return probe
}

describe('useAskCardAnswers', () => {
  test('applyFieldPatch mirrors the patch into answersRef synchronously and pre-fills defaults', { timeout: 60_000 }, async () => {
    const probe = await mountAnswers({
      ask: askOf('ask-1', [
        { ...textField('q'), defaultValue: 'prefilled' },
        { ...choiceField('m', { multiple: true }), defaultValue: ['m-b'] },
      ]),
    })
    assert.deepEqual(probe.api.answers, { q: 'prefilled', m: ['m-b'] }, 'string and multi defaults become initial answers')
    let returned: AskAnswers = {}
    act(() => {
      returned = probe.api.applyFieldPatch(0, { q: 'typed' })
    })
    assert.deepEqual(returned, { q: 'typed', m: ['m-b'] }, 'returns the merged answers')
    assert.deepEqual(probe.api.answersRef.current, { q: 'typed', m: ['m-b'] }, 'ref is updated before the re-render commits')
    assert.deepEqual(probe.api.answers, { q: 'typed', m: ['m-b'] }, 'state catches up after the re-render')
    assert.deepEqual(probe.submits, [], 'a plain patch on a multi-field question never submits')
  })

  test('stepper single-select preset click jumps to the next unanswered step; non-preset patches stay put', { timeout: 60_000 }, async () => {
    const probe = await mountAnswers({ ask: askOf('ask-2', [choiceField('q'), textField('r')]), isStepper: true })
    act(() => {
      probe.api.applyFieldPatch(0, { q: 'q-a' })
    })
    assert.equal(probe.api.activeStep, 0, 'typing / non-preset changes keep the step')
    act(() => {
      probe.api.applyFieldPatch(0, { q: 'q-b' }, { fromPresetClick: true })
    })
    assert.equal(probe.api.activeStep, 1, 'auto-advances to the unanswered step')
    act(() => {
      probe.api.applyFieldPatch(1, { r: 'x' }, { fromPresetClick: true })
    })
    assert.equal(probe.api.activeStep, 1, 'with every step answered the card stays on the last step')
  })

  test('advanceOrSubmitFromStep walks unanswered steps, submits once complete, and never moves while a request is in flight', { timeout: 60_000 }, async () => {
    const probe = await mountAnswers({ ask: askOf('ask-3', [choiceField('q'), textField('r')]), isStepper: true })
    act(() => {
      probe.api.applyFieldPatch(0, { q: 'q-a' })
      probe.api.advanceOrSubmitFromStep(0, probe.api.answersRef.current)
    })
    assert.equal(probe.api.activeStep, 1, 'moves to the unanswered step')
    assert.deepEqual(probe.submits, [])
    act(() => {
      probe.api.applyFieldPatch(1, { r: 'x' })
      probe.api.advanceOrSubmitFromStep(1, probe.api.answersRef.current)
    })
    assert.deepEqual(probe.submits, [{ q: 'q-a', r: 'x' }], 'submits the complete answers')
  })

  test('non-stepper advance focuses the first missing required field instead of submitting', { timeout: 60_000 }, async () => {
    const probe = await mountAnswers({ ask: askOf('ask-4', [textField('t1'), textField('t2')]) })
    act(() => {
      probe.api.applyFieldPatch(0, { t1: 'x' })
      probe.api.advanceOrSubmitFromStep(0, probe.api.answersRef.current)
    })
    assert.deepEqual(probe.focusedSteps, [1], 'focus jumps to the missing field')
    assert.deepEqual(probe.submits, [])
    act(() => {
      probe.api.applyFieldPatch(1, { t2: 'y' })
      probe.api.enterNextOrSubmit(1)
    })
    assert.deepEqual(probe.submits, [{ t1: 'x', t2: 'y' }], 'Enter on the last field submits via the ref answers')
  })

  test('submitSingleOption picks the option then advances or submits in one go', { timeout: 60_000 }, async () => {
    const probe = await mountAnswers({ ask: askOf('ask-5', [choiceField('q')]) })
    act(() => {
      probe.api.submitSingleOption(0, 'q', 'q-b')
    })
    assert.deepEqual(probe.submits, [{ q: 'q-b' }], 'single-select Enter on the only field submits immediately')
    assert.deepEqual(probe.api.answers, { q: 'q-b' })
  })

  test('single-confirm submits the confirm patch alone; single quick-choice submits only on a preset click', { timeout: 60_000 }, async () => {
    const confirm = await mountAnswers({
      ask: askOf('ask-6', [{ name: 'c', label: 'c', type: 'confirm' }]),
      isSingleConfirm: true,
    })
    act(() => {
      confirm.api.applyFieldPatch(0, { c: 'true' })
    })
    assert.deepEqual(confirm.submits, [{ c: 'true' }], 'confirm forwards just the confirm value')
    act(() => {
      confirm.api.submitForm()
      confirm.api.advanceOrSubmitFromStep(0, { c: 'true' })
    })
    assert.equal(confirm.submits.length, 1, 'form submit and advance are no-ops for a single confirm')

    const quick = await mountAnswers({ ask: askOf('ask-7', [{ ...choiceField('q'), allowCustom: true }]), isSingleQuickChoice: true })
    act(() => {
      quick.api.applyFieldPatch(0, { q: 'free text' })
    })
    assert.deepEqual(quick.submits, [], 'typing a custom answer does not submit')
    act(() => {
      quick.api.applyFieldPatch(0, { q: 'q-a' }, { fromPresetClick: true })
    })
    assert.deepEqual(quick.submits, [{ q: 'q-a' }], 'preset click submits immediately')
  })

  test('submitForm is guarded by in-flight requests and missing required fields', { timeout: 60_000 }, async () => {
    const ask = askOf('ask-8', [textField('t1'), textField('t2')])
    let busy: AnswersProbe = await mountAnswers({ ask })
    act(() => {
      busy.api.applyFieldPatch(0, { t1: 'x' })
      void busy.api.submitForm()
    })
    assert.deepEqual(busy.submits, [], 'missing required field blocks submit')

    const inflight: AnswersProbe = { api: undefined as unknown as AnswersProbe['api'], submits: [], focusedSteps: [] }
    await mount(
      e(AnswersHarness, {
        ask,
        isStepper: false,
        isSingleConfirm: false,
        isSingleQuickChoice: false,
        submitting: 'answer',
        submitAnswers: async (payload) => {
          inflight.submits.push(payload)
        },
        focusStepPrimaryControl: () => true,
        onApi: (api) => {
          inflight.api = api
        },
      }),
    )
    act(() => {
      void inflight.api.submitForm()
      inflight.api.advanceOrSubmitFromStep(0, { t1: 'x', t2: 'y' })
    })
    assert.deepEqual(inflight.submits, [], 'an in-flight answer locks both submit paths')

    act(() => {
      busy.api.applyFieldPatch(1, { t2: 'y' })
      void busy.api.submitForm()
    })
    assert.deepEqual(busy.submits, [{ t1: 'x', t2: 'y' }], 'complete answers submit')
  })
})

// ---------------------------------------------------------------------------
// useAskCardSubmission
// ---------------------------------------------------------------------------

interface SubmissionHarnessProps {
  ask: AskSpec
  hasNextPendingAsk: boolean
  onFocusReturn?: () => void
  onApi: (api: AskCardSubmission, formRef: React.RefObject<HTMLFormElement | null>) => void
}

function SubmissionHarness(props: SubmissionHarnessProps): React.ReactElement {
  const formRef = React.useRef<HTMLFormElement | null>(null)
  const api = useAskCardSubmission({
    ask: props.ask,
    formRef,
    hasNextPendingAsk: props.hasNextPendingAsk,
    onFocusReturn: props.onFocusReturn,
  })
  props.onApi(api, formRef)
  return e(
    'form',
    { ref: formRef, className: 'ask-dock', tabIndex: -1 },
    e('input', { className: 'ask-dock-input' }),
  )
}

interface SubmissionProbe {
  api: AskCardSubmission
  formRef: React.RefObject<HTMLFormElement | null>
  focusReturns: number[]
}

async function mountSubmission(options: { hasNextPendingAsk?: boolean } = {}): Promise<SubmissionProbe> {
  const probe: SubmissionProbe = {
    api: undefined as unknown as AskCardSubmission,
    formRef: { current: null },
    focusReturns: [],
  }
  await mount(
    e(SubmissionHarness, {
      ask: askOf('ask-1', [textField('t')], 7),
      hasNextPendingAsk: options.hasNextPendingAsk ?? false,
      onFocusReturn: () => {
        probe.focusReturns.push(1)
      },
      onApi: (api, formRef) => {
        probe.api = api
        probe.formRef = formRef
      },
    }),
  )
  return probe
}

describe('useAskCardSubmission', () => {
  test('answer posts the payload with the expectedStateSeq CAS watermark, locks while in flight, and returns focus for the last card', { timeout: 60_000 }, async () => {
    let release: (() => void) | undefined
    installFetch(() => new Promise<Response>((resolve) => { release = () => resolve(jsonResponse(200, { ok: true })) }))
    const probe = await mountSubmission()
    probe.formRef.current?.focus()
    assert.ok(document.activeElement === probe.formRef.current, 'focus starts inside the card')
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = probe.api.submitAnswers({ t: 'x' })
    })
    assert.deepEqual(
      posts,
      [{ url: '/api/asks/ask-1/answer', body: { answers: { t: 'x' }, expectedStateSeq: 7 } }],
      'goes through the original asksApi with the CAS watermark',
    )
    assert.equal(probe.api.submittingRef.current, 'answer', 'ref is locked synchronously')
    await settle()
    assert.equal(probe.api.submitting, 'answer', 'state reflects the in-flight lock')
    assert.deepEqual(probe.focusReturns, [], 'focus is not returned before the request settles')
    await act(async () => {
      release?.()
      await pending
    })
    assert.equal(probe.api.submitting, null, 'lock is released')
    assert.equal(probe.api.submittingRef.current, null)
    assert.equal(probe.api.error, null)
    assert.deepEqual(probe.focusReturns, [1], 'last card hands focus back to the composer')
  })

  test('a rejected request surfaces its message in place, releases the lock, and keeps focus', { timeout: 60_000 }, async () => {
    installFetch(() => Promise.resolve(jsonResponse(409, { error: { code: 'ask_state_conflict', message: 'state moved on' } })))
    const probe = await mountSubmission()
    probe.formRef.current?.focus()
    await act(async () => {
      await probe.api.submitAnswers({ t: 'x' })
    })
    assert.equal(probe.api.error, 'state moved on', 'error message is rendered from the API error')
    assert.equal(probe.api.submitting, null, 'lock is released after failure')
    assert.deepEqual(probe.focusReturns, [], 'a failed answer never returns focus')
    await act(async () => {
      await probe.api.submitAnswers({ t: 'x' })
    })
    assert.equal(probe.api.error, 'state moved on', 'error persists until the next attempt clears it')
    assert.equal(posts.length, 2, 'the user can retry')
  })

  test('cancel goes through the cancel endpoint, tracks its own in-flight kind, and clears a previous error', { timeout: 60_000 }, async () => {
    installFetch(() => Promise.resolve(jsonResponse(409, { error: { code: 'ask_state_conflict', message: 'state moved on' } })))
    const probe = await mountSubmission()
    await act(async () => {
      await probe.api.submitAnswers({ t: 'x' })
    })
    assert.notEqual(probe.api.error, null)
    installFetch()
    let pending: Promise<void> = Promise.resolve()
    act(() => {
      pending = probe.api.cancel()
    })
    assert.equal(probe.api.submittingRef.current, 'cancel', 'cancel locks with its own kind')
    assert.equal(probe.api.error, null, 'a new request clears the stale error')
    await act(async () => {
      await pending
    })
    assert.deepEqual(posts, [{ url: '/api/asks/ask-1/cancel', body: {} }], 'cancel carries no answers and no watermark')
    assert.equal(probe.api.submitting, null)
    assert.deepEqual(probe.focusReturns, [1], 'focus was inside the card, so the last card returns it')
  })

  test('focus is returned only for the last pending card and only when focus is neutral or inside the card', { timeout: 60_000 }, async () => {
    installFetch()
    const stacked = await mountSubmission({ hasNextPendingAsk: true })
    stacked.formRef.current?.focus()
    await act(async () => {
      await stacked.api.submitAnswers({ t: 'x' })
    })
    assert.deepEqual(stacked.focusReturns, [], 'another card is still waiting, so focus stays')

    const outside = document.createElement('input')
    document.body.appendChild(outside)
    try {
      outside.focus()
      const held = await mountSubmission()
      assert.ok(document.activeElement === outside, 'focus is held by an unrelated control before the request')
      await act(async () => {
        await held.api.submitAnswers({ t: 'x' })
      })
      assert.deepEqual(held.focusReturns, [], 'focus held elsewhere is never pulled back')
    } finally {
      outside.remove()
    }
  })
})
