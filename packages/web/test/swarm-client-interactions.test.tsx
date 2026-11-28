/**
 * builtin:swarm 插件 client 组件 DOM 测试（SwarmToolView / SwarmActiveTray / SwarmBoardReportCard / SwarmBoardWakeupCard）：
 * - 纯模型与 UI 注册测试已拆至 swarm-client-model.test.ts；
 * - SwarmWorkbenchPanel / PeekPopover / 时间观测 DOM 测试已拆至 swarm-client-panel-interactions.test.tsx。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import { ensureHappyDom } from './helpers/dom-harness.js'
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

describe('swarm-client-interactions', () => {
  before(async () => {
    h = await createSwarmDomHarness()
  }, { timeout: 60_000 })

  after(() => {
    h?.dispose()
  }, { timeout: 60_000 })

  test('client 入口模块导出契约：除 __helmxClientCss 外全部为 PascalCase 组件函数', { timeout: 60_000 }, () => {
    for (const [exportName, value] of Object.entries(h.rawModule)) {
      if (exportName === '__helmxClientCss') continue
      assert.match(exportName, /^[A-Z]/, `client 入口导出必须为 PascalCase 组件：${exportName}`)
      assert.equal(typeof value, 'function', `导出 ${exportName} 必须为组件函数`)
    }
  })

  test('SwarmToolView：dispatch 完成态点击打开成员会话抽屉，黑板发布行打开工作台面板，有目标行右侧 external-link，无目标行不可点', { timeout: 60_000 }, async () => {
    const spy = h.makeSpyCtx({ conversationId: 50 })

    const dispatchMount = await h.mount(
      spy,
      e(h.components.SwarmToolView, toolViewProps({
        toolName: 'swarm_dispatch_worker',
        input: { name: 'author', prompt: 'Implement token refresh in isolated worktree and post handoff when done' },
        result: 'Dispatched @author (#51) in group grp-live, brief=#1.',
        presentationMeta: { workerConversationId: 51, groupId: 'grp-live', memberName: 'author', seq: 1 },
        durationMs: 4200,
      })),
    )
    try {
      const text = dispatchMount.host.textContent ?? ''
      assert.match(text, /Dispatch member/, '自然语言工具名')
      assert.match(text, /@author/, '成员名摘要')
      assert.match(text, /#1/, 'presentationMeta.seq 徽标')
      assert.match(text, /Implement token refresh/, '派工任务摘要')
      assert.equal(dispatchMount.host.querySelector('button.sw-trace-row-btn') !== null, true)
      const dispatchLink = dispatchMount.host.querySelector('.trace-row-right .trace-row-link')
      assert.ok(dispatchLink?.classList.contains('lucide-external-link') === true, '成员目标行右侧为 external-link 跳转提示')
      assert.ok(dispatchMount.host.querySelector('.trace-row-right .trace-row-chevron') === null, '右侧不再出现 chevron')
      await act(async () => {
        dispatchMount.host.querySelector<HTMLButtonElement>('button.sw-trace-row-btn')!.click()
      })
      assert.deepEqual(spy.drawerCalls, [51], '点击打开成员会话抽屉')
      assert.equal(spy.workbenchCalls.length, 0, '成员行不打开工作台')
    } finally {
      dispatchMount.unmount()
    }

    const jsonOnlyMount = await h.mount(
      spy,
      e(h.components.SwarmToolView, toolViewProps({
        callId: 'call-json-only',
        toolName: 'swarm_dispatch_worker',
        input: { name: 'author', prompt: 'Implement auth' },
        result: JSON.stringify({ workerConversationId: 99, groupId: 'grp-json', name: 'author', postSeq: 8 }),
      })),
    )
    try {
      assert.doesNotMatch(jsonOnlyMount.host.textContent ?? '', /#8/, '无 presentationMeta 时不解析 result 中的 postSeq')
      const staticRow = jsonOnlyMount.host.querySelector<HTMLElement>('.trace-row.sw-trace-row')
      assert.ok(staticRow !== null, '无目标行仍渲染 26px .trace-row')
      assert.equal(staticRow!.tagName, 'DIV', '无目标行是非交互元素，不是 button')
      assert.equal(staticRow!.getAttribute('role'), null, '无目标行不声明 role=button')
      assert.equal(staticRow!.getAttribute('aria-expanded'), null, '无目标行不声明 aria-expanded')
      assert.equal(staticRow!.getAttribute('aria-controls'), null, '无目标行不声明 aria-controls')
      assert.ok(staticRow!.querySelector('.trace-row-link') === null, '无目标行右侧无跳转提示')
      assert.ok(jsonOnlyMount.host.querySelector('.trace-row-chevron') === null, '插件行自身不渲染折叠 chevron（由宿主行首提供）')
      assert.ok(jsonOnlyMount.host.querySelector('details.tool-call-details') === null, '不再内嵌 ToolCallDetails 展开块')
      await act(async () => {
        staticRow!.click()
      })
      assert.deepEqual(spy.drawerCalls, [51], '点击不可点行绝不解析 result.workerConversationId #99 并打开抽屉')
      assert.ok(jsonOnlyMount.host.querySelector('details.tool-call-details') === null, '点击后也不伪造展开体')
    } finally {
      jsonOnlyMount.unmount()
    }

    for (const [props, expected] of [
      [
        toolViewProps({
          callId: 'call-read0',
          toolName: 'swarm_board_read',
          presentationMeta: { groupId: 'grp-live', seq: 0, postCount: 0 },
        }),
        /0 posts/,
      ],
      [
        toolViewProps({
          callId: 'call-abort-noop',
          toolName: 'swarm_abort_worker',
          presentationMeta: { workerConversationId: 51, memberName: 'author', aborted: false },
        }),
        /not running/,
      ],
      [
        toolViewProps({
          callId: 'call-close-retained',
          toolName: 'swarm_close_group',
          presentationMeta: { groupId: 'grp-live', retainedCount: 2 },
        }),
        /2 branches kept for merge/,
      ],
    ] as const) {
      const m = await h.mount(spy, e(h.components.SwarmToolView, props))
      try {
        assert.match(m.host.textContent ?? '', expected)
      } finally {
        m.unmount()
      }
    }

    const postMount = await h.mount(
      spy,
      e(h.components.SwarmToolView, toolViewProps({
        callId: 'call-2',
        toolName: 'swarm_board_post',
        input: { to: ['verifier'], kind: 'handoff', body: 'Token refresh implemented, ready for review.' },
        result: 'Posted #2 [handoff] -> verifier (wake=true).',
        presentationMeta: { groupId: 'grp-live', postKind: 'handoff', seq: 2 },
      })),
    )
    try {
      const text = postMount.host.textContent ?? ''
      assert.match(text, /Handoff/, 'kind 映射为自然语言动词')
      assert.match(text, /-> @verifier/, '目标自然化')
      assert.match(text, /ready for review/, '正文摘要')
      assert.match(text, /#2/, '#seq 仅作辅助信息')
      assert.ok(postMount.host.querySelector('.trace-row-right .trace-row-link.lucide-external-link') !== null, '编组目标行右侧同样为 external-link')
      await act(async () => {
        postMount.host.querySelector<HTMLButtonElement>('button.sw-trace-row-btn')!.click()
      })
      assert.deepEqual(spy.workbenchCalls, ['groups'], '编组级行打开协同工作台面板（短本地 panelId）')
      assert.deepEqual(spy.workbenchParamCalls, [{ groupId: 'grp-live', postSeq: 2 }], '携带聚焦参数 groupId/postSeq')
    } finally {
      postMount.unmount()
    }

    const runningMount = await h.mount(
      spy,
      e(h.components.SwarmToolView, toolViewProps({
        callId: 'call-3',
        toolName: 'swarm_abort_worker',
        input: { groupId: 'grp-live', name: 'someone-new' },
        status: 'running',
        startedAt: 1000,
      })),
    )
    try {
      const staticRow = runningMount.host.querySelector<HTMLElement>('.trace-row.sw-trace-row')
      assert.ok(staticRow !== null && staticRow!.tagName === 'DIV', '未知目标行渲染为非交互 div')
      assert.equal(staticRow!.getAttribute('aria-expanded'), null, '不声明折叠语义')
      assert.match(runningMount.host.textContent ?? '', /Abort member/, '标题与摘要照常展示')
      assert.ok(runningMount.host.querySelector('button.trace-row') === null, '整行不存在可点按钮')
      await act(async () => {
        staticRow!.click()
      })
      assert.ok(runningMount.host.querySelector('details.tool-call-details') === null, '点击不展开任何内嵌详情（入口由宿主行首 chevron 提供）')
      assert.deepEqual(spy.drawerCalls, [51], '未新增抽屉调用（未伪造目标）')
      assert.equal(spy.workbenchCalls.length, 1, '未新增工作台调用')
    } finally {
      runningMount.unmount()
    }

    assert.deepEqual(
      spy.actionCalls.map((c) => c.actionId),
      [],
      '纯展示行不触发任何动作',
    )
  })

  test('SwarmToolView：错误态如实展示错误首行与状态灯，zh-CN 显示自然中文摘要', { timeout: 60_000 }, async () => {
    const spy = h.makeSpyCtx({ conversationId: 50 })
    const errMount = await h.mount(
      spy,
      e(h.components.SwarmToolView, toolViewProps({
        callId: 'call-e1',
        toolName: 'swarm_close_group',
        input: { groupId: 'grp-live' },
        status: 'error',
        result: 'swarm_worktree_unmerged: author worktree has 3 unmerged commits\nresolve or keepWorktree',
      })),
    )
    try {
      const text = errMount.host.textContent ?? ''
      assert.match(text, /Close swarm group/)
      assert.match(text, /swarm_worktree_unmerged: author worktree has 3 unmerged commits/, '错误首行原样呈现')
      assert.equal(errMount.host.querySelector('.trace-row-error') !== null, true, '错误行样式')
      assert.equal(errMount.host.querySelectorAll('.helmx-status-light').length, 1, '主状态灯唯一')
    } finally {
      errMount.unmount()
    }

    const zhSpy = h.makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const zhMount = await h.mount(
      zhSpy,
      e(h.components.SwarmToolView, toolViewProps({
        callId: 'call-e2',
        toolName: 'swarm_board_post',
        input: { to: ['coordinator'], kind: 'blocker', body: '集成环境不可用，等待基础设施恢复。' },
      })),
      DEFAULT_SWARM_CONVERSATIONS,
    )
    try {
      const text = zhMount.host.textContent ?? ''
      assert.match(text, /黑板发布/, 'zh-CN 工具名')
      assert.match(text, /受阻/, 'kind 自然语言动词')
    } finally {
      zhMount.unmount()
    }
  })

  test('SwarmToolView/ActiveTray/Panel DOM 抽查：按组过滤 @member、消费 live.tools 与已归档成员回退', { timeout: 60_000 }, async () => {
    h.setStubState({
      docs: {
        index: {
          workers: [
            { conversationId: 901, coordinatorConversationId: 900, profileId: 'coder', groupId: 'grp-other', name: 'author', createdAt: 1 },
            { conversationId: 51, coordinatorConversationId: 50, profileId: 'coder', groupId: 'grp-live', name: 'author', createdAt: 2 },
          ],
          groups: [],
        },
        'board-badges': { byConversation: {} },
      },
    })
    const tvSpy = h.makeSpyCtx({ conversationId: 50 })
    const tvMount = await h.mount(
      tvSpy,
      e(h.components.SwarmToolView, toolViewProps({
        toolName: 'swarm_inspect_worker',
        input: { groupId: 'grp-live', name: 'author' },
        result: 'Member @author (#51)',
        presentationMeta: { groupId: 'grp-live', workerConversationId: 51, memberName: 'author' },
      })),
    )
    try {
      const btn = tvMount.host.querySelector<HTMLButtonElement>('.sw-trace-row-btn')!
      assert.ok(btn.classList.contains('trace-row'), '必须挂载宿主 .trace-row 基础类')
      await act(async () => {
        btn.click()
      })
      assert.deepEqual(tvSpy.drawerCalls, [51], '按当前组过滤同短名成员，绝不跳到并发他组 #901')
    } finally {
      tvMount.unmount()
    }

    const scopedLookupSpy = h.makeSpyCtx({ conversationId: 50 })
    const scopedLookupMount = await h.mount(
      scopedLookupSpy,
      e(h.components.SwarmToolView, toolViewProps({
        toolName: 'swarm_inspect_worker',
        input: { groupId: 'grp-live', name: 'author' },
        status: 'running',
        presentationMeta: { groupId: 'grp-live', memberName: 'author' },
      })),
    )
    try {
      const btn = scopedLookupMount.host.querySelector<HTMLButtonElement>('.sw-trace-row-btn')!
      await act(async () => {
        btn.click()
      })
      assert.deepEqual(scopedLookupSpy.drawerCalls, [51], '省略 workerConversationId 时按当前组查找 #51，不误命中他组 #901')
    } finally {
      scopedLookupMount.unmount()
    }

    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': boardViewFixture() },
      conversationLives: {
        52: {
          conversationId: 52,
          text: '',
          tools: [{ callId: 'c1', toolName: 'bash', input: { command: 'pnpm test:unit' }, status: 'running' }],
          updatedAt: Date.now(),
        },
      },
    })
    const liveTraySpy = h.makeSpyCtx({ conversationId: 50 })
    const liveTray = await h.mount(
      liveTraySpy,
      e(h.components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      assert.match(liveTray.host.textContent ?? '', /pnpm test:unit/)
      await act(async () => {
        liveTray.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!.click()
      })
      assert.match(liveTray.host.querySelector('.sw-tray-row-live')?.textContent ?? '', /bash: pnpm test:unit/)
    } finally {
      liveTray.unmount()
    }

    const evictedBoard = boardViewFixture()
    ;(evictedBoard.group as { id: string; status: string }).id = 'grp-evicted'
    ;(evictedBoard.group as { status: string }).status = 'closed'
    h.setStubState({ docs: { index: { workers: [], groups: [] }, 'board-badges': { byConversation: {} } }, sessionDocs: {} })
    const calls: Array<{ actionId: string; input: unknown }> = []
    const archWorkerSpy = h.makeSpyCtx({
      conversationId: 52,
      callAction: async (actionId: string, input: unknown) => {
        calls.push({ actionId, input })
        if (actionId === 'board_status') return evictedBoard
        if (actionId === 'board_read') return { groupId: 'grp-evicted', headSeq: 3, posts: evictedBoard.posts }
        return {}
      },
    })
    const archWorkerPanel = await h.mount(
      archWorkerSpy,
      e(h.components.SwarmWorkbenchPanel, {
        conversation: convSummary(52, 'verifier archived', { tags: ['swarm-worker-archived'] }),
      }),
    )
    try {
      assert.match(archWorkerPanel.host.textContent ?? '', /Completed/)
      assert.match(archWorkerPanel.host.textContent ?? '', /helmx\/author/)
      assert.deepEqual(calls, [{ actionId: 'board_status', input: {} }])
      await act(async () => {
        archWorkerPanel.host.querySelector<HTMLButtonElement>('.sw-panel-history-toggle')!.click()
      })
      assert.deepEqual(calls[1], { actionId: 'board_read', input: { groupId: 'grp-evicted', limit: 200 } })
    } finally {
      archWorkerPanel.unmount()
    }
    h.resetDefaultStubs()
  })

  test('SwarmActiveTray：无活跃事项返回 null；working/blocked 成员渲染 HUD 与可展开行，主控视角对两者均可中止', { timeout: 60_000 }, async () => {
    h.setStubState({ docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } } })
    const idleSpy = h.makeSpyCtx({ conversationId: 50 })
    const idleMount = await h.mount(idleSpy, e(h.components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }))
    try {
      assert.equal(idleMount.host.textContent ?? '', '', '无实时投影时返回 null')
    } finally {
      idleMount.unmount()
    }

    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': boardViewFixture() },
    })

    const coordSpy = h.makeSpyCtx({ conversationId: 50 })
    const coordMount = await h.mount(
      coordSpy,
      e(h.components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const text = coordMount.host.textContent ?? ''
      assert.match(text, /1 working/, 'working 计数')
      assert.match(text, /1\/2 delivered/, '进度')
      assert.match(text, /handoff/i, '自然语言动态')
      const toggle = coordMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
      assert.equal(toggle.getAttribute('aria-expanded'), 'false')
      await act(async () => {
        toggle.click()
      })
      const row = coordMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-main')!
      assert.match(coordMount.host.textContent ?? '', /@verifier/, '展开显示在途成员')
      assert.match(coordMount.host.textContent ?? '', /#52/, '会话编号辅助信息')
      await act(async () => {
        row.click()
      })
      assert.deepEqual(coordSpy.drawerCalls, [52], '成员行打开 ConversationDrawer')
      const abortBtn = coordMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-actions .dock-tray-row-abort')
      assert.ok(abortBtn !== null, '主控视角对运行中成员提供真实中止动作')
      assert.equal(abortBtn.getAttribute('aria-label'), 'Abort')
      await act(async () => {
        abortBtn.click()
      })
      assert.deepEqual(
        coordSpy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
        [{ actionId: 'abort_worker', input: { groupId: 'grp-live', name: 'verifier' } }],
        '中止走 abort_worker 动作',
      )
    } finally {
      coordMount.unmount()
    }

    const workerSpy = h.makeSpyCtx({ conversationId: 51 })
    const workerMount = await h.mount(
      workerSpy,
      e(h.components.SwarmActiveTray, { conversation: convSummary(51, 'author', { tags: ['swarm-worker'] }) }),
    )
    try {
      assert.equal(workerMount.host.textContent ?? '', '', 'Worker 会话直接挂载返回 null（0px 占位）')
      assert.ok(workerMount.host.querySelector('.sw-tray') === null, 'Worker 会话不渲染组级 HUD')
      assert.ok(workerMount.host.querySelector('.sw-tray-workbench') === null, 'Worker 会话不渲染托盘工作台入口')
      assert.deepEqual(workerMount.subscribedSessionKeys, [], 'Worker 会话直接挂载不建立任何 board-view sessionDoc 订阅')
    } finally {
      workerMount.unmount()
    }

    const blockedFixture = boardViewFixture()
    ;(blockedFixture.members as Array<{ liveState: string }>)[1]!.liveState = 'blocked'
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': blockedFixture },
    })
    const blockedSpy = h.makeSpyCtx({ conversationId: 50 })
    const blockedMount = await h.mount(
      blockedSpy,
      e(h.components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
    )
    try {
      const blockedText = blockedMount.host.textContent ?? ''
      assert.match(blockedText, /1 blocked/, 'blocked 计数')
      const toggle = blockedMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
      await act(async () => {
        toggle.click()
      })
      const abortBtn = blockedMount.host.querySelector<HTMLButtonElement>('.sw-tray-row-actions .dock-tray-row-abort')
      assert.ok(abortBtn !== null, '主控视角对 blocked 成员同样提供中止动作')
      assert.equal(abortBtn.getAttribute('aria-label'), 'Abort')
      await act(async () => {
        abortBtn.click()
      })
      assert.deepEqual(
        blockedSpy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
        [{ actionId: 'abort_worker', input: { groupId: 'grp-live', name: 'verifier' } }],
        'blocked 成员中止同样走 abort_worker',
      )
    } finally {
      blockedMount.unmount()
    }

    const quietFixture = boardViewFixture()
    for (const m of (quietFixture.members as Array<{ liveState: string }>).slice(1)) m.liveState = 'idle'
    ;(quietFixture.members as Array<{ liveState: string }>)[0]!.liveState = 'idle'
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': quietFixture },
    })
    const quietSpy = h.makeSpyCtx({ conversationId: 50 })
    const quietMount = await h.mount(quietSpy, e(h.components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }))
    try {
      assert.equal(quietMount.host.textContent ?? '', '', '无在途成员时返回 null')
    } finally {
      quietMount.unmount()
    }

    const closedFixture = boardViewFixture()
    ;(closedFixture.group as { status: string }).status = 'closed'
    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': closedFixture },
    })
    const closedSpy = h.makeSpyCtx({ conversationId: 50 })
    const closedMount = await h.mount(closedSpy, e(h.components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }))
    try {
      assert.equal(closedMount.host.textContent ?? '', '', '结单组不渲染托盘')
    } finally {
      closedMount.unmount()
    }

    h.resetDefaultStubs()
  })

  test('SwarmActiveTray：12 名并发成员展开后全量渲染、耗时右置且第 12 名成员可跳转与中止', { timeout: 60_000 }, async () => {
    const T0 = 1_700_000_000_000
    const NOW = T0 + 95_000
    const members = Array.from({ length: 12 }, (_, idx) => {
      const n = String(idx + 1).padStart(2, '0')
      const isBlocked = idx === 0
      return {
        name: `worker-${n}`,
        conversationId: 101 + idx,
        profileId: 'coder',
        access: 'readwrite',
        isolation: 'worktree',
        nodeId: 'local',
        cwd: `/repo-wt/worker-${n}`,
        worktreeId: `local:/repo-wt/worker-${n}`,
        lifecycle: 'active',
        readCursorSeq: 1,
        pendingWakeupSeq: 1,
        createdAt: T0 + idx * 1_000,
        liveState: isBlocked ? 'blocked' : 'working',
        runStartedAt: NOW - (idx + 5) * 1_000,
        ...(isBlocked ? { pendingAskSince: NOW - 15_000 } : {}),
        turnCount: 0,
      }
    })
    const conversations = [
      convSummary(50, '主控', { tags: ['swarm-coordinator'] }),
      ...members.map((m, idx) =>
        convSummary(m.conversationId, m.name, {
          tags: ['swarm-worker'],
          status: idx === 0 ? 'blocked' : 'working',
          doing: `handling slice ${idx + 1}`,
          runStartedAt: m.runStartedAt,
          ...(idx === 0 ? { pendingAskCount: 1, pendingAskSince: NOW - 15_000 } : {}),
        }),
      ),
    ]
    const twelveBoard = boardViewFixture({
      group: {
        id: 'grp-live',
        title: '12 并发协同组',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 12,
        headSeq: 1,
        createdAt: T0,
        updatedAt: NOW,
      },
      members,
      posts: [],
      activeWorkingMembers: members.map((m) => m.name),
    })

    h.setStubState({
      docs: { index: coordinatorIndexFixture(), 'board-badges': { byConversation: {} } },
      sessionDocs: { 'builtin:swarm/board-view/50': twelveBoard },
    })

    const traySpy = h.makeSpyCtx({ conversationId: 50 })
    const trayMount = await h.mount(
      traySpy,
      e(h.components.SwarmActiveTray, { conversation: convSummary(50, '主控', { tags: ['swarm-coordinator'] }) }),
      conversations,
      { serverNowMs: NOW },
    )
    try {
      const toggle = trayMount.host.querySelector<HTMLButtonElement>('.sw-tray-bar-toggle')!
      await act(async () => {
        toggle.click()
      })

      const rows = [...trayMount.host.querySelectorAll<HTMLElement>('.sw-tray-row')]
      assert.equal(rows.length, 12, '展开后应渲染全部 12 名并发成员')

      for (const row of rows) {
        const main = row.querySelector<HTMLElement>('.sw-tray-row-main')
        const liveEl = main?.querySelector<HTMLElement>('.sw-tray-row-live') ?? null
        const elapsedEl = main?.querySelector<HTMLElement>('.sw-tray-row-elapsed') ?? null
        const abortBtn = row.querySelector<HTMLButtonElement>('.sw-tray-row-actions .dock-tray-row-abort')
        assert.ok(main !== null, '每行均渲染 .sw-tray-row-main')
        assert.ok(liveEl !== null, '每行均渲染 .sw-tray-row-live')
        assert.ok(elapsedEl !== null, '每行均渲染 .sw-tray-row-elapsed')
        assert.ok(abortBtn !== null, '每行均渲染轻量中止图标按钮')
        const children = [...main.children]
        const liveIdx = children.findIndex((el) => el.classList.contains('sw-tray-row-live'))
        const elapsedIdx = children.findIndex((el) => el.classList.contains('sw-tray-row-elapsed'))
        assert.ok(liveIdx >= 0 && elapsedIdx > liveIdx, '耗时元素必须位于实时动态之后')
      }

      const twelfthRow = rows[11]!
      assert.match(twelfthRow.textContent ?? '', /@worker-12/, '第 12 行为 worker-12')
      await act(async () => {
        twelfthRow.querySelector<HTMLButtonElement>('.sw-tray-row-main')!.click()
      })
      assert.deepEqual(traySpy.drawerCalls, [112], '点击第 12 行应打开对应子会话抽屉')

      const twelfthAbort = twelfthRow.querySelector<HTMLButtonElement>('.sw-tray-row-actions .dock-tray-row-abort')!
      assert.equal(twelfthAbort.getAttribute('aria-label'), 'Abort')
      await act(async () => {
        twelfthAbort.click()
      })
      assert.deepEqual(
        traySpy.actionCalls.map((c) => ({ actionId: c.actionId, input: c.input })),
        [{ actionId: 'abort_worker', input: { groupId: 'grp-live', name: 'worker-12' } }],
        '点击第 12 行中止图标应触发 worker-12 的 abort_worker',
      )
    } finally {
      trayMount.unmount()
      h.resetDefaultStubs()
    }
  })

  test('SwarmBoardReportCard：26px 单行轨迹与左侧 chevron 原地折叠展开、MarkdownView 渲染、活跃成员页脚与右侧跳转工作台', { timeout: 60_000 }, async () => {
    const spy = h.makeSpyCtx({ conversationId: 50 })
    const reportMount = await h.mount(
      spy,
      e(h.components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-10',
          kind: 'helmx.input',
          data: {
            createdAt: 1_700_000_010_000,
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-live',
              fromSeq: 5,
              toSeq: 5,
              postCount: 1,
              activeWorkingMembers: ['slow'],
              posts: [
                {
                  seq: 5,
                  from: 'fast',
                  to: ['coordinator'],
                  kind: 'done',
                  wake: true,
                  refs: [2],
                  body: '**Fast slice** ready with `auth.ts` patch.',
                  worktreeSnapshot: {
                    worktreeId: 'wt-fast',
                    branch: 'helmx/fast',
                    commitsAhead: 1,
                    dirtyCount: 0,
                    changedFilesPreview: ['src/auth.ts'],
                  },
                  createdAt: 1_700_000_009_000,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      const headerText = reportMount.host.textContent ?? ''
      assert.match(headerText, /Board message/, '使用标准看板消息标题')
      assert.doesNotMatch(headerText, /Swarm report|协同汇总/, '淘汰旧协同汇总文案')
      assert.match(headerText, /Delivered/, '展示触发帖 kind 徽章')
      assert.match(headerText, /@fast/, '展示发帖人')
      assert.match(headerText, /Fast slice/, '展示首行摘要')
      assert.match(headerText, /#5/, '展示序号徽章')
      assert.doesNotMatch(headerText, /Still working/, '折叠态不展示活跃成员页脚')
      assert.ok(reportMount.host.querySelector('.sw-receipt-pill') === null, '已淘汰旧 .sw-receipt-pill')
      assert.ok(reportMount.host.querySelector('.trace-entry-error') === null, 'done 卡片不挂错误态')

      const toggleBtn = reportMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!
      assert.ok(toggleBtn !== null, '左侧存在折叠按钮')
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'false', '默认折叠')
      const firstSvg = toggleBtn.firstElementChild
      assert.ok(firstSvg !== null && firstSvg.classList.contains('trace-row-chevron') && firstSvg.classList.contains('lucide-chevron-right'), '行首左侧首位为 chevron-right')

      const bodyId = toggleBtn.getAttribute('aria-controls')!
      assert.ok(bodyId.length > 0)
      const bodyWrap = reportMount.host.querySelector<HTMLElement>(`#${CSS.escape(bodyId)}`)!
      assert.ok(bodyWrap.hasAttribute('hidden'), '折叠态 body 容器带 hidden')
      assert.ok(reportMount.host.querySelector('.sw-receipt-expanded') === null, '折叠态不挂载展开内容')

      await act(async () => {
        toggleBtn.click()
      })
      assert.equal(toggleBtn.getAttribute('aria-expanded'), 'true', '点击左侧按钮原地展开')
      assert.ok(toggleBtn.firstElementChild?.classList.contains('lucide-chevron-down') === true, '展开后切换为 chevron-down')
      assert.equal(bodyWrap.hasAttribute('hidden'), false, '展开后移除 hidden')

      const expanded = reportMount.host.querySelector<HTMLElement>('.sw-receipt-expanded')!
      assert.ok(expanded !== null)
      const mdBody = expanded.querySelector<HTMLElement>('.sw-receipt-post-md')!
      assert.ok(mdBody !== null, '展开态经宿主 MarkdownView 渲染正文')
      assert.ok(mdBody.querySelector('strong')?.textContent === 'Fast slice', 'Markdown 加粗真实渲染')
      assert.ok(mdBody.querySelector('code')?.textContent === 'auth.ts', 'Markdown 行内代码真实渲染')
      assert.match(expanded.querySelector('.sw-panel-post-worktree')?.textContent ?? '', /helmx\/fast/, '展示 worktree 快照')
      assert.match(expanded.querySelector('.sw-receipt-post-refs')?.textContent ?? '', /#2/, '展示 refs')
      assert.match(expanded.querySelector('.sw-receipt-active-footer')?.textContent ?? '', /Still working: @slow/, '展开态底部展示仍在执行成员')
      assert.doesNotMatch(expanded.textContent ?? '', /No wake|Woke/, '默认 wake=true 的 done 不渲染多余 wake 标签')

      const openBtn = reportMount.host.querySelector<HTMLButtonElement>('.sw-receipt-open-btn')!
      assert.ok(openBtn !== null && openBtn.querySelector('.lucide-external-link') !== null, '右侧存在 external-link 工作台按钮')
      await act(async () => {
        openBtn.click()
      })
      assert.deepEqual(spy.workbenchCalls, ['groups'], '点击右侧按钮打开协同工作台面板')
      assert.deepEqual(spy.workbenchParamCalls, [{ groupId: 'grp-live', postSeq: 5 }], '携带 groupId 与 postSeq 参数')
    } finally {
      reportMount.unmount()
    }

    const zhSpy = h.makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const zhMount = await h.mount(
      zhSpy,
      e(h.components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-10-zh',
          kind: 'helmx.input',
          data: {
            createdAt: 1_700_000_010_000,
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-live',
              fromSeq: 5,
              toSeq: 5,
              postCount: 1,
              activeWorkingMembers: ['slow'],
              posts: [
                {
                  seq: 5,
                  from: 'fast',
                  to: ['coordinator'],
                  kind: 'review',
                  wake: true,
                  refs: [],
                  body: '请主控确认接口签名。',
                  createdAt: 1_700_000_009_000,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      const text = zhMount.host.textContent ?? ''
      assert.match(text, /看板消息/, 'zh-CN 标题为看板消息')
      assert.doesNotMatch(text, /协同汇总/, 'zh-CN 淘汰旧协同汇总')
      assert.match(text, /审阅/, 'zh-CN review 徽章')
      await act(async () => {
        zhMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!.click()
      })
      assert.match(zhMount.host.querySelector('.sw-receipt-active-footer')?.textContent ?? '', /仍在执行：@slow/)
    } finally {
      zhMount.unmount()
    }
  })

  test('SwarmBoardReportCard：blocker/stall 默认展开与错误样式、多条合并截断、idleCatchup 与空回执回退', { timeout: 60_000 }, async () => {
    const blockerMount = await h.mount(
      h.makeSpyCtx({ conversationId: 50, locale: 'zh-CN' }),
      e(h.components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-blk',
          kind: 'helmx.input',
          data: {
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-live',
              fromSeq: 4,
              toSeq: 5,
              postCount: 2,
              activeWorkingMembers: [],
              posts: [
                {
                  seq: 4,
                  from: 'author',
                  to: ['coordinator'],
                  kind: 'blocker',
                  wake: true,
                  refs: [],
                  body: 'Integration DB unreachable.',
                  createdAt: 1000,
                },
                {
                  seq: 5,
                  from: 'verifier',
                  to: ['coordinator'],
                  kind: 'comment',
                  wake: false,
                  refs: [],
                  body: 'Standing by.',
                  createdAt: 1100,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      assert.ok(blockerMount.host.querySelector('.trace-entry-error') !== null, 'blocker 挂 .trace-entry-error')
      assert.ok(blockerMount.host.querySelector('.trace-row-error') !== null, 'blocker 挂 .trace-row-error')
      const toggle = blockerMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!
      assert.equal(toggle.getAttribute('aria-expanded'), 'true', 'blocker 默认展开')
      assert.match(toggle.textContent ?? '', /受阻/, '主帖优先挑选 blocker')
      assert.match(toggle.textContent ?? '', /@author/, '主帖发帖人不被后续 comment 覆盖')
      assert.match(blockerMount.host.textContent ?? '', /2 条/, '多条消息显示紧凑计数')
      assert.match(blockerMount.host.querySelector('.sw-receipt-expanded')?.textContent ?? '', /Integration DB unreachable\./)
    } finally {
      blockerMount.unmount()
    }

    const stallMount = await h.mount(
      h.makeSpyCtx({ conversationId: 50 }),
      e(h.components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-stall',
          kind: 'helmx.input',
          data: {
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-live',
              fromSeq: 6,
              toSeq: 6,
              postCount: 1,
              posts: [
                {
                  seq: 6,
                  from: 'system',
                  to: ['coordinator'],
                  kind: 'stall',
                  wake: true,
                  refs: [5],
                  body: 'All workers idle without wake.',
                  createdAt: 1200,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      assert.equal(stallMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')?.getAttribute('aria-expanded'), 'true', 'stall 默认展开')
      assert.ok(stallMount.host.querySelector('.trace-row-error') === null, 'stall 不挂错误红态')
    } finally {
      stallMount.unmount()
    }

    const truncSpy = h.makeSpyCtx({ conversationId: 50, locale: 'zh-CN' })
    const truncMount = await h.mount(
      truncSpy,
      e(h.components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-trunc',
          kind: 'helmx.input',
          data: {
            createdAt: 1_700_000_020_000,
            meta: {
              renderer: 'swarm:board-report',
              groupId: 'grp-live',
              fromSeq: 1,
              toSeq: 22,
              postCount: 22,
              truncatedPostsCount: 2,
              idleCatchup: true,
              posts: [
                {
                  seq: 22,
                  from: 'slow',
                  to: ['coordinator'],
                  kind: 'done',
                  wake: false,
                  refs: [],
                  body: 'Long truncated content…',
                  bodyTruncated: true,
                  createdAt: 1_700_000_019_000,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      const headerText = truncMount.host.textContent ?? ''
      assert.match(headerText, /全员空闲/, 'idleCatchup 使用全员空闲标题')
      assert.match(headerText, /#1\.\.#22/, '区间范围展示')
      assert.match(headerText, /22 条/, '展示总条数')
      await act(async () => {
        truncMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!.click()
      })
      const expText = truncMount.host.querySelector('.sw-receipt-expanded')?.textContent ?? ''
      assert.match(expText, /已省略更早的 2 条消息，可打开工作台查看完整记录/)
      assert.match(expText, /正文已截断，可打开工作台查看全文/)
      assert.match(expText, /未唤醒/, 'done(wake=false) 显示未唤醒徽章')
    } finally {
      truncMount.unmount()
    }

    const emptyMount = await h.mount(
      h.makeSpyCtx({ conversationId: 50 }),
      e(h.components.SwarmBoardReportCard, {
        conversationId: 50,
        entry: {
          id: 'e-empty',
          kind: 'helmx.input',
          data: { meta: { renderer: 'swarm:board-report', groupId: 'grp-live', fromSeq: 8, toSeq: 8, postCount: 1 } },
        },
      }),
    )
    try {
      await act(async () => {
        emptyMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!.click()
      })
      assert.match(emptyMount.host.querySelector('.sw-receipt-expanded')?.textContent ?? '', /No board post details recorded\./)
    } finally {
      emptyMount.unmount()
    }
  })

  test('SwarmBoardWakeupCard：成员唤醒折叠轨迹卡原地展开交接正文并支持跳转工作台', { timeout: 60_000 }, async () => {
    const wakeupSpy = h.makeSpyCtx({ conversationId: 52 })
    const wakeupMount = await h.mount(
      wakeupSpy,
      e(h.components.SwarmBoardWakeupCard, {
        conversationId: 52,
        entry: {
          id: 'e-w1',
          kind: 'helmx.input',
          data: {
            createdAt: 1_700_000_030_000,
            meta: {
              renderer: 'swarm:board-wakeup',
              groupId: 'grp-live',
              workerName: 'verifier',
              fromSeq: 2,
              toSeq: 3,
              postCount: 2,
              posts: [
                {
                  seq: 2,
                  from: 'author',
                  to: ['verifier'],
                  kind: 'handoff',
                  wake: true,
                  refs: [1],
                  body: 'Ready for verification on **auth refresh**.',
                  worktreeSnapshot: {
                    worktreeId: 'wt-author',
                    branch: 'helmx/author',
                    commitsAhead: 2,
                    dirtyCount: 0,
                    changedFilesPreview: ['src/auth.ts'],
                  },
                  createdAt: 1_700_000_028_000,
                },
                {
                  seq: 3,
                  from: 'author',
                  to: ['verifier'],
                  kind: 'comment',
                  wake: true,
                  refs: [2],
                  body: 'Please also check edge timeout.',
                  createdAt: 1_700_000_029_000,
                },
              ],
            },
          },
        },
      }),
    )
    try {
      const headerText = wakeupMount.host.textContent ?? ''
      assert.match(headerText, /Swarm wakeup/)
      assert.match(headerText, /@author -> @verifier/, '头部展示路由方向')
      assert.match(headerText, /#2\.\.#3/)
      assert.match(headerText, /2 posts/)
      assert.ok(wakeupMount.host.querySelector('.sw-receipt-pill') === null)
      const toggle = wakeupMount.host.querySelector<HTMLButtonElement>('.sw-receipt-toggle')!
      assert.equal(toggle.getAttribute('aria-expanded'), 'false')
      await act(async () => {
        toggle.click()
      })
      assert.equal(toggle.getAttribute('aria-expanded'), 'true')
      const expanded = wakeupMount.host.querySelector<HTMLElement>('.sw-receipt-expanded')!
      assert.ok(expanded !== null)
      const postEls = expanded.querySelectorAll('.sw-receipt-post')
      assert.equal(postEls.length, 2, '展开态逐条渲染合并消息')
      assert.match(postEls[0]!.querySelector('.sw-receipt-post-md')?.textContent ?? '', /Ready for verification on auth refresh\./)
      assert.doesNotMatch(postEls[0]!.querySelector('.sw-receipt-post-head')?.textContent ?? '', /Woke|No wake/, '默认 handoff(wake=true) 不显多余标签')
      assert.match(postEls[0]!.querySelector('.sw-panel-post-worktree')?.textContent ?? '', /helmx\/author/)
      assert.match(postEls[1]!.querySelector('.sw-receipt-post-head')?.textContent ?? '', /Woke/, 'comment(wake=true) 显示 Woke 偏离徽章')

      await act(async () => {
        wakeupMount.host.querySelector<HTMLButtonElement>('.sw-receipt-open-btn')!.click()
      })
      assert.deepEqual(wakeupSpy.workbenchCalls, ['groups'])
      assert.deepEqual(wakeupSpy.workbenchParamCalls, [{ groupId: 'grp-live', postSeq: 3 }])
    } finally {
      wakeupMount.unmount()
    }
  })
})
