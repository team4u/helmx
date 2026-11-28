/**
 * builtin:swarm 插件 SwarmWorkbenchPanel & SwarmPostPeekPopover DOM 交互测试：
 * 从 swarm-client-interactions.test.tsx 拆分以与 ToolView/Tray/回执卡用例并行运行。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { ensureHappyDom, flushMacrotask } from './helpers/dom-harness.js'
import {
  DEFAULT_SWARM_CONVERSATIONS,
  boardViewFixture,
  convSummary,
  coordinatorIndexFixture,
  createSwarmDomHarness,
  toolViewProps,
  type SwarmDomHarness,
} from './helpers/swarm-client-harness.js'

ensureHappyDom()

const e = React.createElement
let h: SwarmDomHarness

describe('swarm-client-panel-interactions', () => {
  before(async () => {
    h = await createSwarmDomHarness()
  }, { timeout: 60_000 })

  after(() => {
    h?.dispose()
  }, { timeout: 60_000 })

  test('SwarmWorkbenchPanel：实时 board-view 编排卡（成员行开抽屉、自然 kind、worktree 事实），Worker 会话同视图', { timeout: 60_000 }, async () => {
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': boardViewFixture() },
    })
    const spy = h.makeSpyCtx({ conversationId: 50 })
    const mountPanel = await h.mount(
      spy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const text = mountPanel.host.textContent ?? ''
      assert.match(text, /协同审改组/, '编组标题')
      assert.match(text, /零回归完成鉴权改造/, '协同目标')
      assert.match(text, /In progress/, '自然状态标签')
      assert.match(text, /Handoff/, '动态 kind 自然语言')
      assert.match(text, /helmx\/author/, 'worktree 分支事实')
      assert.match(text, /#2/, '#seq 辅助信息')
      assert.equal(mountPanel.host.querySelector('.sw-panel-fallback-note') !== null, false, '实时模式不标注快照来源')

      assert.ok(mountPanel.host.querySelector('.sw-panel-members.helmx-list.helmx-list-compact') !== null, '成员列表复用 compact List 原语')
      const memberRow = mountPanel.host.querySelector<HTMLButtonElement>('.sw-panel-member-item .helmx-list-row-trigger')!
      await act(async () => {
        memberRow.click()
      })
      assert.deepEqual(spy.drawerCalls, [52], '排序后首个成员（verifier 排前）点击打开抽屉')
      assert.deepEqual(spy.actionCalls, [], '纯实时投影不触发动作调用')
    } finally {
      mountPanel.unmount()
    }

    const workerSpy = h.makeSpyCtx({ conversationId: 51 })
    const workerPanel = await h.mount(
      workerSpy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(51, 'author', { tags: ['swarm-worker'] }) }),
    )
    try {
      assert.match(workerPanel.host.textContent ?? '', /协同审改组/, 'Worker 看到所属编组同一视图')
    } finally {
      workerPanel.unmount()
    }

    const closedIndex2 = coordinatorIndexFixture()
    ;((closedIndex2.groups as Array<{ status: string }>)[0]!).status = 'closed'
    const closedBoard2 = boardViewFixture()
    ;(closedBoard2.group as { status: string }).status = 'closed'
    h.setStubState({ docs: { index: closedIndex2, 'board-badges': { byConversation: {} } }, sessionDocs: {} })
    const archivedSpy = h.makeSpyCtx({
      conversationId: 50,
      callAction: async (actionId: string) => {
        if (actionId === 'board_status') return closedBoard2
        return {}
      },
    })
    const archivedPanel = await h.mount(
      archivedSpy,
      e(h.components.SwarmWorkbenchPanel, {
        conversation: convSummary(50, '主控（已结单）', { tags: ['swarm-coordinator-archived'] }),
      }),
    )
    try {
      const text = archivedPanel.host.textContent ?? ''
      assert.match(text, /Completed/, '历史主控看到已完成编排卡')
      assert.match(text, /协同审改组/)
    } finally {
      archivedPanel.unmount()
    }
    h.resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel：看板帖子正文按 Markdown 渲染，长帖折叠预览切片同样渲染且展开显示全文', { timeout: 60_000 }, async () => {
    const board = boardViewFixture()
    const posts = board.posts as Array<{ body: string }>
    posts[0]!.body = 'Implement **token refresh** in `src/auth.ts`.'
    posts[1]!.body = [
      'Token refresh **implemented**, see `src/auth.ts`:',
      '',
      '- 刷新令牌轮转',
      '- 过期容错与重试',
      '- 审计日志补齐',
      '- 并发场景回归',
      'TAIL_MARKER_UNCOLLAPSED_ONLY',
      '- 文档同步',
      '- 变更摘要归档',
      'END_OF_LONG_POST',
    ].join('\n')
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': board },
    })
    const spy = h.makeSpyCtx({ conversationId: 50 })
    const panel = await h.mount(
      spy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const bodyHosts = [...panel.host.querySelectorAll<HTMLElement>('.sw-panel-post-text')]
      assert.ok(bodyHosts.length === 2, '两个帖子的正文容器')

      const shortBody = bodyHosts[0]!
      assert.ok(shortBody.querySelector('strong') !== null, '粗体渲染为 strong 元素')
      assert.ok(shortBody.querySelector('code') !== null, '行内代码渲染为 code 元素')
      assert.ok((shortBody.textContent ?? '').includes('**') === false, '正文无字面 ** 语法残留')

      const longBody = bodyHosts[1]!
      assert.ok(longBody.querySelector('strong') !== null, '折叠预览切片同样按 Markdown 渲染')
      assert.ok(longBody.querySelector('code') !== null, '折叠预览切片渲染行内代码')
      assert.ok((longBody.textContent ?? '').includes('TAIL_MARKER_UNCOLLAPSED_ONLY') === false, '折叠态不显示尾部内容')
      assert.ok((longBody.textContent ?? '').includes('END_OF_LONG_POST') === false, '折叠态不显示末行')

      const toggle = panel.host.querySelector<HTMLButtonElement>('.sw-panel-post-toggle')
      assert.ok(toggle !== null, '长帖存在收展按钮')
      assert.ok(toggle.getAttribute('aria-expanded') === 'false', '初始折叠')
      await act(async () => {
        toggle.click()
      })
      assert.ok(toggle.getAttribute('aria-expanded') === 'true', '点击后展开')
      assert.ok((longBody.textContent ?? '').includes('TAIL_MARKER_UNCOLLAPSED_ONLY') === true, '展开后显示尾部内容')
      assert.ok((longBody.textContent ?? '').includes('END_OF_LONG_POST') === true, '展开后显示末行')
    } finally {
      panel.unmount()
    }
    h.resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel：无实时投影时显式 board_status 回退（含错误重试与完整记录 board_read），空态只读引导', { timeout: 60_000 }, async () => {
    const closedIndex = coordinatorIndexFixture()
    ;((closedIndex.groups as Array<{ status: string }>)[0]!).status = 'closed'
    const closedBoard = boardViewFixture()
    ;((closedBoard.group as { status: string })).status = 'closed'
    ;(closedBoard.group as { retainedWorktrees?: unknown[] }).retainedWorktrees = [
      { memberName: 'author', nodeId: 'local', worktreeId: 'wt-author-1', branch: 'helmx/author', path: '/repo-wt/author', commitsAhead: 2 },
    ]
    h.setStubState({ docs: { index: closedIndex, 'board-badges': { byConversation: {} } } })

    const actionLog: string[] = []
    const spy = h.makeSpyCtx({
      conversationId: 50,
      callAction: async (actionId: string) => {
        actionLog.push(actionId)
        if (actionId === 'board_status') return closedBoard
        if (actionId === 'board_read') {
          return { groupId: 'grp-live', headSeq: 3, posts: (closedBoard as { posts: unknown[] }).posts }
        }
        return {}
      },
    })
    const panel = await h.mount(
      spy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const text = panel.host.textContent ?? ''
      assert.match(text, /Completed/, '结单自然状态')
      assert.match(text, /snapshot/i, '标注一次性快照来源')
      assert.match(text, /helmx\/author/, '保留待合入分支清单')
      assert.deepEqual(
        spy.actionCalls.map((c) => c.actionId).concat(actionLog),
        ['board_status'],
        '回退仅调用一次 board_status',
      )

      const historyToggle = panel.host.querySelector<HTMLButtonElement>('.sw-panel-history-toggle')!
      await act(async () => {
        historyToggle.click()
      })
      assert.deepEqual(
        actionLog,
        ['board_status', 'board_read'],
        '展开完整记录按需 board_read',
      )
    } finally {
      panel.unmount()
    }

    const failSpy = h.makeSpyCtx({
      conversationId: 50,
      callAction: async (actionId: string) => {
        if (actionId === 'board_status') throw new Error('group store offline')
        return {}
      },
    })
    const failPanel = await h.mount(
      failSpy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const text = failPanel.host.textContent ?? ''
      assert.match(text, /Failed to load swarm group status/)
      assert.match(text, /group store offline/, '错误原文如实')
      assert.equal(failPanel.host.textContent?.includes('In progress'), false, '不伪造运行中')
      const retryBtn = failPanel.host.querySelector<HTMLButtonElement>('.sw-panel .btn')
      assert.ok(retryBtn !== null, '提供重试')
    } finally {
      failPanel.unmount()
    }

    const emptySpy = h.makeSpyCtx({ conversationId: 99 })
    const emptyPanel = await h.mount(
      emptySpy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(99, '普通会话') }),
    )
    try {
      const text = emptyPanel.host.textContent ?? ''
      assert.match(text, /No swarm group in this conversation/)
      assert.match(text, /\/skill:swarm/)
    } finally {
      emptyPanel.unmount()
    }
    h.resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel & SwarmPostPeekPopover：帖子头对偏离默认 wake 展示轻标签，默认 wake 不显示多余标签', { timeout: 60_000 }, async () => {
    const wakeBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '协同审改组',
        objective: '验证 wake 偏离标识',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 4,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_004_000,
      },
      posts: [
        {
          seq: 1,
          groupId: 'grp-live',
          from: 'author',
          to: ['coordinator'],
          resolvedTargets: ['coordinator'],
          wake: false,
          kind: 'done',
          refs: [],
          body: 'Passive done post.',
          createdAt: 1_700_000_001_000,
        },
        {
          seq: 2,
          groupId: 'grp-live',
          from: 'verifier',
          to: ['author'],
          resolvedTargets: ['author'],
          wake: true,
          kind: 'comment',
          refs: [1],
          body: 'Urgent comment citing #1.',
          createdAt: 1_700_000_002_000,
        },
        {
          seq: 3,
          groupId: 'grp-live',
          from: 'author',
          to: ['verifier'],
          resolvedTargets: ['verifier'],
          wake: true,
          kind: 'handoff',
          refs: [],
          body: 'Default wake handoff.',
          createdAt: 1_700_000_003_000,
        },
        {
          seq: 4,
          groupId: 'grp-live',
          from: 'verifier',
          to: ['coordinator'],
          resolvedTargets: ['coordinator'],
          wake: false,
          kind: 'comment',
          refs: [],
          body: 'Default silent comment.',
          createdAt: 1_700_000_004_000,
        },
      ],
    })
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': wakeBoard },
    })

    const spy = h.makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const panel = await h.mount(
      spy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const head1 = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="1"] .sw-panel-post-head')!
      const head2 = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="2"] .sw-panel-post-head')!
      const head3 = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="3"] .sw-panel-post-head')!
      const head4 = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="4"] .sw-panel-post-head')!
      assert.match(head1.textContent ?? '', /未唤醒/, 'done(wake=false) 显示未唤醒')
      assert.match(head2.textContent ?? '', /已唤醒/, 'comment(wake=true) 显示已唤醒')
      assert.doesNotMatch(head3.textContent ?? '', /未唤醒|已唤醒/, '默认 handoff(wake=true) 不显多余标签')
      assert.doesNotMatch(head4.textContent ?? '', /未唤醒|已唤醒/, '默认 comment(wake=false) 不显多余标签')

      const ref1 = panel.host.querySelector<HTMLButtonElement>('.sw-panel-post[data-post-seq="2"] .sw-panel-post-ref')!
      await act(async () => {
        ref1.click()
      })
      const peekHead = panel.host.querySelector<HTMLElement>('.sw-peek-popover .sw-peek-head')!
      assert.match(peekHead.textContent ?? '', /未唤醒/, '速览浮卡帖子头同样展示偏离默认的未唤醒轻标签')
    } finally {
      panel.unmount()
    }
    h.resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel & SwarmToolView：中文态势本地化、成员短模型徽章、可点击 #seq 引用与主控兜底操作（中止/结单弹窗）', { timeout: 60_000 }, async () => {
    const tvSpy = h.makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const swMount = await h.mount(
      tvSpy,
      e(h.components.SwarmToolView, toolViewProps({
        callId: 'call-sw-1',
        toolName: 'swarm_switch_worker_model',
        input: { name: 'author', model: 'openai/gpt-5', prompt: 'Resume now' },
        result: 'Switched @author (#51) model to openai/gpt-5 and woke with brief #9.',
        presentationMeta: { workerConversationId: 51, memberName: 'author', model: 'openai/gpt-5', seq: 9 },
      })),
    )
    try {
      const text = swMount.host.textContent ?? ''
      assert.match(text, /切换成员模型/)
      assert.match(text, /@author/)
      assert.match(text, /#9/)
    } finally {
      swMount.unmount()
    }

    const singleBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '协同审改组',
        objective: '零回归完成鉴权改造',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 2,
        createdAt: Date.now() - 60_000,
        updatedAt: 2000,
      },
      headline: {
        text: 'Active: @verifier',
        tone: 'info',
        kind: 'normal',
        targetMember: 'verifier',
      },
      posts: [
        {
          seq: 1,
          groupId: 'grp-live',
          from: 'coordinator',
          to: ['author'],
          resolvedTargets: ['author'],
          wake: true,
          kind: 'brief',
          refs: [],
          body: 'Implement token refresh in isolated worktree.',
          createdAt: 1100,
        },
        {
          seq: 2,
          groupId: 'grp-live',
          from: 'author',
          to: ['verifier'],
          resolvedTargets: ['verifier'],
          wake: true,
          kind: 'handoff',
          refs: [1],
          body: 'Review note referencing #1 on main board.',
          createdAt: 1500,
        },
      ],
    })
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': singleBoard },
    })

    const coordSpy = h.makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const coordPanel = await h.mount(
      coordSpy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const text = coordPanel.host.textContent ?? ''
      assert.match(text, /执行中：@verifier/, 'zh-CN 本地化合成态势标题')
      assert.match(text, /gpt-5/, '展示成员短模型名')
      assert.match(text, /claude-sonnet-4-5/, '展示审阅成员短模型名')
      assert.ok(coordPanel.host.querySelector('.sw-panel-channels') === null, '单黑板不渲染频道筛选栏')

      const refBtn = coordPanel.host.querySelector<HTMLButtonElement>('.sw-panel-post-ref')!
      assert.ok(refBtn !== null, '渲染可点击 #seq 引用芯片')
      assert.equal(refBtn.textContent, '#1')
      await act(async () => {
        refBtn.click()
      })
      const peek = coordPanel.host.querySelector<HTMLElement>('.sw-peek-popover')
      assert.ok(peek !== null, '点击引用芯片应原地弹出速览浮卡')
      assert.match(peek.textContent ?? '', /#1/, '浮卡标题展示目标序号')

      const locateBtn = peek.querySelector<HTMLButtonElement>('.sw-peek-locate-btn')!
      assert.ok(locateBtn !== null, '浮卡提供定位到列表入口')
      await act(async () => {
        locateBtn.click()
      })
      assert.ok(coordPanel.host.querySelector('.sw-peek-popover') === null, '定位后收起浮卡')
      const highlighted = coordPanel.host.querySelector<HTMLElement>('.sw-panel-post-highlighted')
      assert.ok(highlighted !== null, '定位后高亮目标帖子')
      assert.equal(highlighted.getAttribute('data-post-seq'), '1')
      const jumpBackBtn = coordPanel.host.querySelector<HTMLButtonElement>('.sw-panel-jump-back-btn')
      assert.ok(jumpBackBtn !== null, '列表跳转后挂出返回原留言胶囊')
      assert.match(jumpBackBtn.textContent ?? '', /返回 #2/)

      await act(async () => {
        jumpBackBtn.click()
      })
      assert.equal(
        coordPanel.host.querySelector<HTMLElement>('.sw-panel-post-highlighted')?.getAttribute('data-post-seq'),
        '2',
        '点击回跳胶囊返回原留言 #2',
      )
      assert.ok(coordPanel.host.querySelector('.sw-panel-jump-back') === null, '退空后自动隐藏回跳条')

      const abortBtn = coordPanel.host.querySelector<HTMLButtonElement>('.sw-panel-member-abort')
      assert.ok(abortBtn !== null, '主控面板为在途成员提供中止按钮')
      await act(async () => {
        abortBtn.click()
      })
      assert.deepEqual(
        coordSpy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
        [{ actionId: 'abort_worker', input: { groupId: 'grp-live', name: 'verifier' } }],
      )

      const closeBtn = coordPanel.host.querySelector<HTMLButtonElement>('.sw-panel-close-btn')
      assert.ok(closeBtn !== null, '主控面板提供结单按钮')
      await act(async () => {
        closeBtn.click()
      })
      const confirmBtn = document.body.querySelector<HTMLButtonElement>('.sw-close-dialog-confirm')
      assert.ok(confirmBtn !== null, '结单确认对话框渲染')
      await act(async () => {
        confirmBtn.click()
      })
      const closeCall = coordSpy.actionCalls.find((c) => c.actionId === 'close_group')
      assert.ok(closeCall !== undefined, '确认结单调用 close_group 动作')
      assert.deepEqual(closeCall.input, { groupId: 'grp-live', keepWorktree: true, abortRunning: true })
    } finally {
      coordPanel.unmount()
    }

    const workerSpy = h.makeSpyCtx({ conversationId: 51, locale: 'zh-CN' })
    const workerPanel = await h.mount(
      workerSpy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(51, 'author', { tags: ['swarm-worker'] }) }),
    )
    try {
      assert.ok(workerPanel.host.querySelector('.sw-panel-member-abort') === null, 'Worker 视角不渲染中止按钮')
      assert.ok(workerPanel.host.querySelector('.sw-panel-close-btn') === null, 'Worker 视角不渲染结单按钮')
    } finally {
      workerPanel.unmount()
    }
    h.resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel：正文内联 #seq 速览、浮卡内多层引用前进/后退、早期截断帖按需 board_read 与缺帖如实提示', { timeout: 60_000 }, async () => {
    const longEarlyBody = Array.from({ length: 12 }, (_, i) => `Early constraint line ${i + 1}`).join('\n')
    const truncatedBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '协同审改组',
        objective: '零回归完成鉴权改造',
        status: 'active',
        coordinatorConversationId: 50,
        activeWorkerCount: 2,
        headSeq: 20,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_020_000,
      },
      posts: [
        {
          seq: 12,
          groupId: 'grp-live',
          from: 'author',
          to: ['verifier'],
          resolvedTargets: ['verifier'],
          wake: true,
          kind: 'handoff',
          body: 'Implemented per #2 and bogus #999.',
          refs: [2, 999],
          createdAt: 1_700_000_012_000,
        },
        {
          seq: 20,
          groupId: 'grp-live',
          from: 'verifier',
          to: ['author'],
          resolvedTargets: ['author'],
          wake: true,
          kind: 'review',
          body: 'Checked #12 thoroughly; inline `#77` stays code.',
          refs: [12],
          createdAt: 1_700_000_020_000,
        },
      ],
    })
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': truncatedBoard },
    })

    let boardReadAttempts = 0
    const boardReadInputs: unknown[] = []
    let failNextRead = true
    const spy = h.makeSpyCtx({
      conversationId: 50,
      locale: 'zh-CN',
      callAction: async (actionId, input) => {
        if (actionId === 'board_read') {
          boardReadAttempts += 1
          boardReadInputs.push(input)
          if (failNextRead) {
            failNextRead = false
            throw new Error('temporary read failure')
          }
          return {
            posts: [
              {
                seq: 2,
                groupId: 'grp-live',
                from: 'coordinator',
                to: ['all'],
                resolvedTargets: ['author', 'verifier'],
                wake: true,
                kind: 'brief',
                body: longEarlyBody,
                refs: [],
                createdAt: 1_700_000_002_000,
              },
            ],
          }
        }
        return {}
      },
    })

    const panel = await h.mount(
      spy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const inlineLink = panel.host.querySelector<HTMLAnchorElement>('.sw-panel-post[data-post-seq="20"] a[href="#swarm-post-12"]')
      assert.ok(inlineLink !== null, '正文 #12 应渲染为可点击内联引用链接')
      assert.ok(panel.host.querySelector('a[href="#swarm-post-77"]') === null, '行内代码中的 #77 不得转为链接')
      await act(async () => { inlineLink.click() })

      let peek = panel.host.querySelector<HTMLElement>('.sw-peek-popover')
      assert.ok(peek !== null, '点击正文内联 #12 应打开速览浮卡')
      assert.match(peek.textContent ?? '', /Implemented per #2/)
      assert.equal(boardReadAttempts, 0, '已缓存的 #12 不应触发额外 board_read')

      const nestedRef2 = peek.querySelector<HTMLAnchorElement>('a[href="#swarm-post-2"]')
      assert.ok(nestedRef2 !== null, '浮卡内引用同样可点击')
      await act(async () => { nestedRef2.click() })
      await flushMacrotask(0)

      peek = panel.host.querySelector<HTMLElement>('.sw-peek-popover')!
      assert.equal(boardReadAttempts, 1, '早期未缓存帖 #2 必须触发按需 board_read')
      assert.deepEqual(boardReadInputs[0], { groupId: 'grp-live', seqs: [2] }, '浮卡缺失引用必须按 seqs 精确补拉')
      assert.match(peek.textContent ?? '', /temporary read failure/, '读取失败如实呈现原文')
      const retryBtn = [...peek.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        (b.textContent ?? '').includes('重试'),
      )
      assert.ok(retryBtn !== null, '失败浮卡提供重试按钮')
      await act(async () => { retryBtn!.click() })
      await flushMacrotask(0)

      peek = panel.host.querySelector<HTMLElement>('.sw-peek-popover')!
      assert.equal(boardReadAttempts, 2)
      assert.match(peek.textContent ?? '', /Early constraint line 12/, '浮卡内长帖默认展示完整全文')
      assert.ok(peek.querySelector('.sw-panel-post-toggle') === null, '浮卡内不再二次折叠正文')

      const backBtn = peek.querySelector<HTMLButtonElement>('.sw-peek-back-btn')
      assert.ok(backBtn !== null, '多层浮卡显示返回 #12 按钮')
      assert.match(backBtn.textContent ?? '', /#12/)
      await act(async () => { backBtn.click() })
      peek = panel.host.querySelector<HTMLElement>('.sw-peek-popover')!
      assert.match(peek.textContent ?? '', /Implemented per #2/, '浮卡退回 #12')

      const ref999 = peek.querySelector<HTMLAnchorElement>('a[href="#swarm-post-999"]')
      assert.ok(ref999 !== null)
      await act(async () => { ref999.click() })
      peek = panel.host.querySelector<HTMLElement>('.sw-peek-popover')!
      assert.match(peek.textContent ?? '', /未找到记录 #999/, '不存在的序号如实提示未找到')
    } finally {
      panel.unmount()
    }

    const emptyMembersBoard = boardViewFixture({
      group: {
        id: 'grp-empty',
        title: '新建待派工编组',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 0,
        headSeq: 0,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
      },
      headline: { text: 'Group ready — dispatch peer roles to start collaboration', tone: 'info', kind: 'normal' },
      members: [],
      posts: [],
      activeWorkingMembers: [],
    })
    h.setStubState({
      docs: {
        index: {
          workers: [],
          groups: [emptyMembersBoard.group],
        },
        'board-badges': { byConversation: {} },
      },
      sessionDocs: { 'builtin:swarm/board-view/50': emptyMembersBoard },
    })
    const emptyPanel = await h.mount(
      h.makeSpyCtx({ conversationId: 50, locale: 'zh-CN' }),
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const emptyText = emptyPanel.host.textContent ?? ''
      assert.match(emptyText, /尚未派工成员。/, '空成员区必须显示成员空文案而非帖子空文案')
      assert.match(emptyText, /编组已就绪/, '无正则结构字段推导就绪标题')
    } finally {
      emptyPanel.unmount()
    }

    const makeStubPost = (seq: number, body = `Post #${seq}`) => ({
      seq,
      groupId: 'grp-long',
      from: 'author',
      to: ['verifier'],
      resolvedTargets: ['verifier'],
      wake: true,
      kind: 'handoff',
      refs: seq === 250 ? [12] : [],
      body,
      createdAt: 1_700_000_000_000 + seq * 1000,
    })
    const longBoard = boardViewFixture({
      group: {
        id: 'grp-long',
        title: '长协同组',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 250,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_250_000,
      },
      posts: Array.from({ length: 10 }, (_, i) => makeStubPost(241 + i, i === 9 ? 'Final check citing #12.' : `Recent #${241 + i}`)),
    })
    h.setStubState({
      docs: { index: { workers: [], groups: [longBoard.group] }, 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': longBoard },
    })
    const longReadCalls: unknown[] = []
    const longSpy = h.makeSpyCtx({
      conversationId: 50,
      locale: 'zh-CN',
      callAction: async (actionId, input) => {
        if (actionId !== 'board_read') return {}
        longReadCalls.push(input)
        const inp = input as { seqs?: number[]; sinceSeq?: number; limit?: number }
        if (Array.isArray(inp.seqs)) {
          return { posts: inp.seqs.map((s) => makeStubPost(s, `Early exact post #${s}`)) }
        }
        if (typeof inp.sinceSeq === 'number') {
          const count = inp.limit ?? 50
          return { posts: Array.from({ length: count }, (_, i) => makeStubPost(inp.sinceSeq! + 1 + i)) }
        }
        return { posts: Array.from({ length: 200 }, (_, i) => makeStubPost(51 + i)) }
      },
    })
    const longPanel = await h.mount(
      longSpy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const seqEl = longPanel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="250"] .sw-panel-post-seq')
      assert.equal(seqEl?.getAttribute('title'), null, '#seq 徽章不得把整段正文塞入原生 title')

      const ref12 = longPanel.host.querySelector<HTMLAnchorElement>('.sw-panel-post[data-post-seq="250"] a[href="#swarm-post-12"]')!
      await act(async () => { ref12.click() })
      await flushMacrotask(0)
      assert.deepEqual(longReadCalls[0], { groupId: 'grp-long', seqs: [12] })
      const locateBtn = longPanel.host.querySelector<HTMLButtonElement>('.sw-peek-locate-btn')!
      assert.ok(locateBtn !== null)
      await act(async () => { locateBtn.click() })
      await flushMacrotask(0)
      assert.ok(
        longPanel.host.querySelector('.sw-panel-post-highlighted[data-post-seq="12"]') !== null,
        '定位早期帖 #12 时即使已加载最新 200 条也不得被 slice(0, 200) 截掉',
      )

      const loadEarlierBtn = longPanel.host.querySelector<HTMLButtonElement>('.sw-panel-load-earlier')
      assert.ok(loadEarlierBtn !== null, '超过 200 条记录时展示加载更早记录按钮')
      await act(async () => { loadEarlierBtn.click() })
      await flushMacrotask(0)
      assert.deepEqual(longReadCalls.at(-1), { groupId: 'grp-long', sinceSeq: 0, limit: 50 })
      assert.ok(longPanel.host.querySelector('.sw-panel-load-earlier') === null, '加载至 #1 后隐藏更早记录按钮')
      assert.ok(longPanel.host.querySelector('.sw-panel-post[data-post-seq="1"]') !== null, '早期 #1 成功合入列表')
    } finally {
      longPanel.unmount()
    }
    h.resetDefaultStubs()
  })

  test('SwarmActiveTray & SwarmWorkbenchPanel 时间观测 DOM 渲染：共享时钟、阻塞 warn、首轮去重、多轮累计、黑板偏移与结单冻结', { timeout: 60_000 }, async () => {
    const T0 = 1_700_000_000_000
    const NOW = T0 + 185_000

    const timedBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '耗时协同组',
        objective: '验证实时与结单耗时渲染',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 4,
        headSeq: 3,
        createdAt: T0,
        updatedAt: T0 + 120_000,
      },
      members: [
        {
          name: 'blocker-w',
          conversationId: 61,
          profileId: 'coder',
          access: 'readwrite',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'active',
          readCursorSeq: 1,
          pendingWakeupSeq: 1,
          createdAt: T0 + 1_000,
          liveState: 'blocked',
          runDurationMs: 60_000,
          runStartedAt: NOW - 30_000,
          pendingAskSince: NOW - 25_000,
          turnCount: 1,
        },
        {
          name: 'first-turn',
          conversationId: 62,
          profileId: 'coder',
          access: 'readwrite',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'active',
          readCursorSeq: 1,
          pendingWakeupSeq: 1,
          createdAt: T0 + 2_000,
          liveState: 'working',
          runDurationMs: 0,
          runStartedAt: NOW - 12_000,
          turnCount: 0,
        },
        {
          name: 'multi-turn',
          conversationId: 63,
          profileId: 'coder',
          access: 'readwrite',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'active',
          readCursorSeq: 1,
          pendingWakeupSeq: 1,
          createdAt: T0 + 3_000,
          liveState: 'working',
          runDurationMs: 45_000,
          runStartedAt: NOW - 12_000,
          turnCount: 2,
        },
        {
          name: 'done-w',
          conversationId: 64,
          profileId: 'reviewer',
          access: 'readonly',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'active',
          readCursorSeq: 2,
          pendingWakeupSeq: 1,
          lastPostSeq: 2,
          createdAt: T0 + 4_000,
          liveState: 'done',
          runDurationMs: 42_500,
          turnCount: 2,
        },
        {
          name: 'idle-zero',
          conversationId: 65,
          profileId: 'reviewer',
          access: 'readonly',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'active',
          readCursorSeq: 1,
          pendingWakeupSeq: 1,
          createdAt: T0 + 5_000,
          liveState: 'idle',
          runDurationMs: 0,
          turnCount: 0,
        },
      ],
      posts: [
        {
          seq: 1,
          groupId: 'grp-live',
          from: 'coordinator',
          to: ['blocker-w'],
          resolvedTargets: ['blocker-w'],
          wake: true,
          kind: 'brief',
          refs: [],
          body: 'Initial task',
          createdAt: T0 + 15_000,
        },
        {
          seq: 2,
          groupId: 'grp-live',
          from: 'done-w',
          to: ['coordinator'],
          resolvedTargets: ['coordinator'],
          wake: true,
          kind: 'done',
          refs: [1],
          body: 'Completed check',
          createdAt: T0 + 3_735_000,
        },
      ],
      activeWorkingMembers: ['blocker-w', 'first-turn', 'multi-turn'],
    })

    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': timedBoard },
    })

    const traySpy = h.makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const trayMount = await h.mount(
      traySpy,
      e(h.components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
      DEFAULT_SWARM_CONVERSATIONS,
      { serverNowMs: NOW },
    )
    try {
      const hudElapsed = trayMount.host.querySelector<HTMLElement>('.sw-tray-bar-toggle .sw-tray-elapsed')
      assert.equal(hudElapsed?.textContent, '3m05s', '托盘顶部显示整秒秒表')
      const toggleBtn = trayMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
      assert.match(toggleBtn.getAttribute('title') ?? '', /端到端总耗时：3m05s/, '托盘切换提示附组耗时拆解')

      await act(async () => {
        toggleBtn.click()
      })
      const rowTimings = [...trayMount.host.querySelectorAll<HTMLElement>('.sw-tray-row-elapsed')]
      assert.equal(rowTimings.length, 3, '三个在途成员均渲染实时耗时')
      assert.equal(rowTimings[0]!.textContent, '等待审批 25s')
      assert.equal(rowTimings[0]!.classList.contains('sw-tray-row-elapsed-warn'), true, 'blocked 行使用 warn 色')
      assert.equal(rowTimings[1]!.textContent, '12s')
      assert.equal(rowTimings[1]!.classList.contains('sw-tray-row-elapsed-warn'), false)
      assert.equal(rowTimings[2]!.textContent, '12s')

      await act(async () => {
        trayMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-main')!.click()
      })
      assert.deepEqual(traySpy.drawerCalls, [61])
    } finally {
      trayMount.unmount()
    }

    const panelSpy = h.makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const panelMount = await h.mount(
      panelSpy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
      DEFAULT_SWARM_CONVERSATIONS,
      { serverNowMs: NOW },
    )
    try {
      const groupElapsed = panelMount.host.querySelector<HTMLElement>('.sw-panel-elapsed')
      assert.equal(groupElapsed?.textContent, '3m05s')

      const memberItems = [...panelMount.host.querySelectorAll<HTMLElement>('.sw-panel-member-item')]
      const elapsedByName = new Map<string, HTMLElement | null>()
      for (const item of memberItems) {
        const name = item.querySelector('.sw-panel-member-name')?.textContent ?? ''
        elapsedByName.set(name, item.querySelector<HTMLElement>('.sw-panel-member-elapsed'))
      }
      assert.equal(elapsedByName.get('@blocker-w')?.textContent, '等待审批 25s · 累计 1m30s')
      assert.equal(elapsedByName.get('@blocker-w')?.classList.contains('sw-panel-member-elapsed-warn'), true)
      assert.equal(elapsedByName.get('@first-turn')?.textContent, '12s', '首轮去重不重复显示本轮与累计')
      assert.equal(elapsedByName.get('@multi-turn')?.textContent, '本轮 12s · 累计 57s')
      assert.equal(elapsedByName.get('@done-w')?.textContent, '42.5s')
      assert.equal(elapsedByName.get('@idle-zero'), null, '空闲且累计为 0 的成员诚实省略耗时')

      assert.equal(panelMount.host.querySelectorAll('progress, [role="progressbar"]').length, 0)

      const post1 = panelMount.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="1"]')!
      const post2 = panelMount.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="2"]')!
      const time1 = post1.querySelector<HTMLElement>('.sw-panel-post-time')
      const time2 = post2.querySelector<HTMLElement>('.sw-panel-post-time')
      assert.equal(time1?.textContent, '+00:15')
      assert.match(time1?.getAttribute('aria-label') ?? '', /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      assert.equal(time2?.textContent, '+1:02:15')
      assert.equal(post1.querySelector('.sw-panel-post-seq')?.getAttribute('title'), null)
    } finally {
      panelMount.unmount()
    }

    const closedBoard = boardViewFixture({
      group: {
        id: 'grp-closed',
        title: '已结单耗时组',
        coordinatorConversationId: 50,
        status: 'closed',
        activeWorkerCount: 0,
        headSeq: 1,
        createdAt: T0,
        updatedAt: T0 + 125_000,
        closedAt: T0 + 125_000,
      },
      members: [
        {
          name: 'author',
          conversationId: 901,
          profileId: 'coder',
          access: 'readwrite',
          isolation: 'inherit',
          nodeId: 'local',
          cwd: '/repo',
          lifecycle: 'archived',
          archivedAt: T0 + 120_000,
          readCursorSeq: 1,
          pendingWakeupSeq: 1,
          createdAt: T0 + 1_000,
          liveState: 'missing',
          runDurationMs: 65_000,
          turnCount: 3,
        },
      ],
      posts: [
        {
          seq: 1,
          groupId: 'grp-closed',
          from: 'author',
          to: ['coordinator'],
          resolvedTargets: ['coordinator'],
          wake: true,
          kind: 'done',
          refs: [],
          body: 'Archived result',
          createdAt: T0 + 120_000,
        },
      ],
      activeWorkingMembers: [],
    })
    h.setStubState({
      docs: { index: { workers: [], groups: [closedBoard.group] }, 'board-badges': { byConversation: {} } },
      sessionDocs: {},
    })
    const closedSpy = h.makeSpyCtx({
      conversationId: 50,
      locale: 'zh-CN',
      callAction: async (actionId: string) => (actionId === 'board_status' ? closedBoard : {}),
    })
    const closedPanel = await h.mount(
      closedSpy,
      e(h.components.SwarmWorkbenchPanel, {
        conversation: convSummary(50, '主控（已结单）', { tags: ['swarm-coordinator-archived'] }),
      }),
      [convSummary(50, '主控（已结单）', { tags: ['swarm-coordinator-archived'] })],
    )
    try {
      const frozenGroupElapsed = closedPanel.host.querySelector<HTMLElement>('.sw-panel-elapsed')
      assert.equal(frozenGroupElapsed?.textContent, '2m5s', '结单后组总耗时冻结展示，不再消失')
      const archivedMemberElapsed = closedPanel.host.querySelector<HTMLElement>('.sw-panel-member-elapsed')
      assert.equal(archivedMemberElapsed?.textContent, '1m5s', '会话缺失的已归档成员仍展示固化运行耗时')
      assert.equal(closedPanel.host.querySelector('.sw-panel-post-time')?.textContent, '+02:00')
    } finally {
      closedPanel.unmount()
    }
    h.resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel：接收 openWorkbench params.postSeq 时自动高亮对应黑板帖并在超出折叠尾窗时展开历史', { timeout: 60_000 }, async () => {
    const eightPosts = Array.from({ length: 8 }, (_, idx) => ({
      seq: idx + 1,
      groupId: 'grp-live',
      from: idx === 0 ? 'coordinator' : 'author',
      to: ['verifier'],
      resolvedTargets: ['verifier'],
      wake: true,
      kind: idx === 0 ? 'brief' : 'comment',
      refs: [],
      body: `Post body #${idx + 1}`,
      createdAt: 1000 + idx * 1000,
    }))
    const longBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '协同审改组',
        objective: '验证 postSeq 深链定位',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 8,
        createdAt: 1000,
        updatedAt: 9000,
      },
      posts: eightPosts,
    })
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': longBoard },
    })

    const spy = h.makeSpyCtx({ conversationId: 50 })
    const mounted = await h.mount(
      spy,
      e(h.components.SwarmWorkbenchPanel, {
        conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }),
        params: { groupId: 'grp-live', postSeq: 2 },
      }),
    )
    try {
      const targetPost = mounted.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="2"]')
      assert.ok(targetPost !== null, '超出最近 6 条折叠窗口的 #2 自动展开历史后可见')
      assert.ok(targetPost.classList.contains('sw-panel-post-highlighted'), '目标帖 #2 获得高亮类')
      const otherPost = mounted.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="8"]')
      assert.ok(otherPost !== null && !otherPost.classList.contains('sw-panel-post-highlighted'), '非目标帖不高亮')
    } finally {
      mounted.unmount()
    }
    h.resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel：close_group 返回 uncleanedWorktrees 时关闭弹窗并触发 warning 通知', { timeout: 60_000 }, async () => {
    const board = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '协同审改组',
        objective: '验证非 Linux 结单提示',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 1,
        headSeq: 1,
        createdAt: 1000,
        updatedAt: 2000,
      },
      activeWorkingMembers: [],
      posts: [
        {
          seq: 1,
          groupId: 'grp-live',
          from: 'coordinator',
          to: ['author'],
          resolvedTargets: ['author'],
          wake: true,
          kind: 'brief',
          refs: [],
          body: 'Work in worktree.',
          createdAt: 1000,
        },
      ],
    })
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': board },
    })

    const spy = h.makeSpyCtx({
      conversationId: 50,
      locale: 'zh-CN',
      callAction: async (actionId, input, options) => {
        spy.actionCalls.push({ actionId, input, ...(options !== undefined ? { options } : {}) })
        if (actionId === 'close_group') {
          return {
            closed: true,
            groupId: 'grp-live',
            retainedWorktrees: [],
            uncleanedWorktrees: [
              {
                memberName: 'author',
                nodeId: 'local',
                worktreeId: 'local:D:\\wt\\a',
                branch: 'helmx/spawn-1',
                path: 'D:\\wt\\a',
                reason: 'usage_unverifiable',
              },
            ],
          }
        }
        return {}
      },
    })
    const panel = await h.mount(
      spy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const closeBtn = panel.host.querySelector<HTMLButtonElement>('.sw-panel-close-btn')
      assert.ok(closeBtn !== null)
      await act(async () => {
        closeBtn.click()
      })
      const confirmBtn = document.body.querySelector<HTMLButtonElement>('.sw-close-dialog-confirm')
      assert.ok(confirmBtn !== null)
      await act(async () => {
        confirmBtn.click()
      })
      assert.ok(document.body.querySelector('.sw-close-dialog-confirm') === null, '结单成功后弹窗关闭')
      assert.equal(spy.notifyCalls.length, 1)
      assert.equal(spy.notifyCalls[0]!.tone, 'warning')
      assert.match(spy.notifyCalls[0]!.message, /--allow-unverified-usage/)
    } finally {
      panel.unmount()
    }
    h.resetDefaultStubs()
  })

  test('SwarmWorkbenchPanel 与 SwarmPostPeekPopover 向 MarkdownView 传入发帖者 conversationId（worker 传成员会话、coordinator 传主控会话）并保留 #seq 预览', { timeout: 60_000 }, async () => {
    const board = boardViewFixture()
    const posts = board.posts as Array<Record<string, unknown>>
    posts[0]!['body'] = 'Coordinator brief referencing #2 and [file](/repo/README.md).'
    posts[1]!['body'] = 'Worker finding at [conversations.ts:137](/repo-wt/author/conversations.ts:137), see #1.'
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': board },
    })
    const spy = h.makeSpyCtx({ conversationId: 50 })
    const panel = await h.mount(
      spy,
      e(h.components.SwarmWorkbenchPanel, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const seq1Body = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="1"] .sw-panel-post-text')
      const seq2Body = panel.host.querySelector<HTMLElement>('.sw-panel-post[data-post-seq="2"] .sw-panel-post-text')
      assert.ok(seq1Body !== null && seq2Body !== null)
      assert.equal(seq1Body.getAttribute('data-md-conv-id'), '50', 'coordinator 帖传主控会话 ID')
      assert.equal(seq2Body.getAttribute('data-md-conv-id'), '51', 'worker 帖传作者成员会话 ID')

      const ref1 = seq2Body.querySelector<HTMLAnchorElement>('a[href="#swarm-post-1"]')
      assert.ok(ref1 !== null)
      await act(async () => {
        ref1.click()
      })
      const peekBody = panel.host.querySelector<HTMLElement>('.sw-peek-popover .sw-panel-post-text')
      assert.ok(peekBody !== null, '点击 #1 展开 peek 浮卡')
      assert.equal(peekBody.getAttribute('data-md-conv-id'), '50', 'peek 浮卡按被预览帖发帖者传 conversationId')
    } finally {
      panel.unmount()
    }
    h.resetDefaultStubs()
  })
})
