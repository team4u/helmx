/**
 * builtin:swarm 纯模型与 UI 注册契约测试（无 DOM / Happy-DOM / esbuild 依赖，归入 pure 池）。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  COMPOSER_DOCK_SLOT,
  parseNonEmptyLocalizedText,
  type HelmxPluginContext,
  type LocalizedText,
} from '@helmx/protocol'
import {
  boardProgressOf,
  isMemberDelivered,
  parseBoardPost,
  parseBoardReadPosts,
  parseBoardView,
  postDigestLine,
} from '../../plugins/src/swarm/client/board-model.js'
import { linkifyPostRefs } from '../../plugins/src/swarm/client/model-post-nav.js'
import {
  resolveGroupTimingView,
  resolvePanelMemberTimingView,
  resolvePostTimeDisplay,
  resolveTrayMemberTimingView,
} from '../../plugins/src/swarm/client/model-timing.js'
import { SWARM_WORKBENCH_PANEL_ID } from '../../plugins/src/swarm/client/models.js'
import { registerSwarmUi } from '../../plugins/src/swarm/ui.js'

const EMOJI_RE = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/u

function boardViewFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    group: {
      id: 'grp-live',
      title: '协同审改组',
      objective: '零回归完成鉴权改造',
      coordinatorConversationId: 50,
      status: 'active',
      activeWorkerCount: 2,
      headSeq: 3,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
    },
    headline: {
      text: 'author handoff #2 awaiting verifier',
      tone: 'info',
      kind: 'normal',
    },
    members: [
      {
        name: 'author',
        conversationId: 51,
        profileId: 'coder',
        access: 'readwrite',
        isolation: 'worktree',
        nodeId: 'local',
        cwd: '/repo-wt/author',
        worktreeId: 'wt-author-1',
        lifecycle: 'active',
        readCursorSeq: 1,
        pendingWakeupSeq: 1,
        lastPostSeq: 2,
        createdAt: 1000,
        liveState: 'done',
        model: 'openai/gpt-5',
      },
      {
        name: 'verifier',
        conversationId: 52,
        profileId: 'reviewer',
        access: 'readonly',
        isolation: 'inherit',
        nodeId: 'local',
        cwd: '/repo',
        lifecycle: 'active',
        readCursorSeq: 1,
        pendingWakeupSeq: 2,
        createdAt: 1000,
        liveState: 'working',
        model: 'anthropic/claude-sonnet-4-5',
      },
    ],
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
        body: 'Token refresh implemented, ready for review.',
        worktreeSnapshot: {
          worktreeId: 'wt-author-1',
          branch: 'helmx/author',
          commitsAhead: 2,
          dirtyCount: 1,
          changedFilesPreview: ['src/auth.ts'],
        },
        createdAt: 1500,
      },
    ],
    activeWorkingMembers: ['verifier'],
    ...overrides,
  }
}

describe('swarm-client-model', () => {
  test('UI 注册契约：toolView/slot/workbenchPanel/回执/补全源，零 screen 与顶栏 action，双语文案非空且无 Emoji', { timeout: 60_000 }, () => {
    const recorded: Array<{ method: string; spec: Record<string, unknown> }> = []
    const uiProxy = new Proxy(
      {},
      {
        get(_target, prop: string) {
          return (spec: Record<string, unknown>) => {
            recorded.push({ method: prop, spec })
          }
        },
      },
    )
    registerSwarmUi({ ui: uiProxy } as unknown as HelmxPluginContext)

    const toolViews = recorded.filter((r) => r.method === 'toolView')
    assert.equal(toolViews.length, 1, '仅注册一个统一 toolView')
    const toolViewSpec = toolViews[0]!.spec
    assert.equal(toolViewSpec['replaceRow'], true, '必须整行替换默认工具轨迹行')
    assert.deepEqual(
      [...(toolViewSpec['toolNames'] as string[])].sort(),
      [
        'swarm_abort_worker',
        'swarm_archive_worker',
        'swarm_board_post',
        'swarm_board_read',
        'swarm_board_status',
        'swarm_close_group',
        'swarm_create_group',
        'swarm_dispatch_worker',
        'swarm_inspect_worker',
        'swarm_switch_worker_model',
        'swarm_update_group',
      ],
      '覆盖当前全部 swarm_* 模型工具',
    )

    const slots = recorded.filter((r) => r.method === 'slot')
    assert.deepEqual(
      slots.map((s) => ({ target: s.spec['target'], scope: s.spec['scope'] })),
      [{ target: COMPOSER_DOCK_SLOT, scope: { tags: ['swarm-coordinator'] } }],
      'COMPOSER_DOCK_SLOT 活动托盘仅对主控会话挂载',
    )

    const panels = recorded.filter((r) => r.method === 'workbenchPanel').map((r) => r.spec)
    assert.equal(panels.length, 1, '仅注册一个会话作用域工作台面板')
    assert.equal(panels[0]!['id'], 'groups')
    assert.deepEqual(
      panels[0]!['scope'],
      { tags: ['swarm-coordinator', 'swarm-coordinator-archived', 'swarm-worker', 'swarm-worker-archived'] },
      '普通会话不出现该 Tab；结单历史主控与已归档成员仍可访问历史编组',
    )
    assert.deepEqual(panels[0]!['badge'], { doc: 'board-badges', byConversationField: 'byConversation' })
    assert.equal(SWARM_WORKBENCH_PANEL_ID, 'groups', '客户端短面板 ID 与注册 id 锁定一致')

    assert.equal(recorded.filter((r) => r.method === 'screen').length, 0, '删除独立全屏 Board 控制台')
    assert.equal(recorded.filter((r) => r.method === 'action').length, 0, '删除顶栏独立 board action 入口')
    assert.equal(recorded.filter((r) => r.method === 'sidebarItem').length, 0, '不注册侧边栏入口')
    assert.equal(recorded.filter((r) => r.method === 'command').length, 0, '不注册 ui.command')

    const renderers = recorded
      .filter((r) => r.method === 'timelineRenderer')
      .map((r) => (r.spec['matchMeta'] as { renderer: string }).renderer)
    assert.deepEqual(renderers, ['swarm:board-report', 'swarm:board-wakeup'], '后端仍写入的回执行保留极简渲染器')

    const completers = recorded.filter((r) => r.method === 'composerCompleter').map((r) => ({
      id: r.spec['id'],
      trigger: r.spec['trigger'],
      source: r.spec['source'],
    }))
    assert.deepEqual(completers, [
      { id: 'swarm-board-members', trigger: '@', source: { kind: 'action', actionId: 'complete_board_members' } },
    ])

    for (const { method, spec } of recorded) {
      for (const field of ['label', 'title', 'description'] as const) {
        if (spec[field] !== undefined) {
          const parsed = parseNonEmptyLocalizedText(spec[field] as LocalizedText)
          assert.notEqual(parsed, undefined, `${method}#${String(spec['id'])}.${field} 必须是非空双语 LocalizedText`)
          const map = spec[field] as Record<string, string>
          assert.ok((map['en'] ?? '').trim().length > 0)
          assert.ok((map['zh-CN'] ?? '').trim().length > 0)
          assert.equal(EMOJI_RE.test(map['en'] ?? ''), false)
          assert.equal(EMOJI_RE.test(map['zh-CN'] ?? ''), false)
        }
      }
    }
  })

  test('纯模型抽查：严格边界解析与正交交付进度', { timeout: 60_000 }, () => {
    const validView = parseBoardView(boardViewFixture())
    assert.ok(validView !== undefined)
    assert.equal(postDigestLine('line one\nline two', 10), 'line one')
    assert.equal(postDigestLine('   \n second  line ', 40), 'second line', '空白折叠取首行')
    assert.equal(parseBoardView({ group: null }), undefined, '非法结构显式拒绝')
    assert.equal(parseBoardView(undefined), undefined)

    const badStatus = boardViewFixture()
    ;(badStatus.group as { status: string }).status = 'weird'
    assert.equal(parseBoardView(badStatus), undefined)

    const badKindPost = (boardViewFixture().posts as Array<Record<string, unknown>>)[0]!
    assert.equal(parseBoardPost({ ...badKindPost, kind: 'invented' }), undefined)
    assert.equal(parseBoardPost({ ...badKindPost, from: '' }), undefined)
    assert.equal(parseBoardReadPosts({ posts: [{ ...badKindPost, kind: 'bad' }] }), undefined)

    const baseMember = validView!.members[0]!
    assert.equal(
      isMemberDelivered({
        ...baseMember,
        liveState: 'idle',
        lastOutboundEdge: { seq: 2, to: ['verifier'], kind: 'handoff' },
      }),
      true,
    )
    assert.equal(
      isMemberDelivered({
        ...baseMember,
        liveState: 'idle',
        lastOutboundEdge: undefined,
      }),
      false,
    )
    assert.deepEqual(
      boardProgressOf([
        { ...baseMember, liveState: 'idle', lastOutboundEdge: { seq: 2, to: ['coordinator'], kind: 'done' } },
        { ...validView!.members[1]!, liveState: 'working' },
      ]),
      { done: 1, total: 2 },
    )
  })

  test('linkifyPostRefs 保留代码块、行内代码与既有链接，仅转正文引用并跳过自身 seq', { timeout: 60_000 }, () => {
    assert.equal(
      linkifyPostRefs(
        '见 #12 与（#5），忽略 `#9` 与 [已链接 #8](https://example.com) 与自身 #20。\n```\n#7 in fence\n```',
        20,
      ),
      '见 [#12](#swarm-post-12) 与（[#5](#swarm-post-5)），忽略 `#9` 与 [已链接 #8](https://example.com) 与自身 #20。\n```\n#7 in fence\n```',
    )
  })

  test('时间观测纯模型与边界解析：宽松解析成员耗时、结单冻结总耗时、首轮去重/多轮累计/阻塞等待与黑板时间偏移', { timeout: 60_000 }, () => {
    const T0 = 1_700_000_000_000
    const NOW = T0 + 185_000 // +3m05s

    const rawWithMixedTiming = boardViewFixture({
      group: {
        id: 'grp-time',
        title: '耗时观测组',
        coordinatorConversationId: 50,
        status: 'active',
        activeWorkerCount: 2,
        headSeq: 2,
        createdAt: T0,
        updatedAt: T0 + 60_000,
      },
      members: [
        {
          ...(boardViewFixture().members as Array<Record<string, unknown>>)[0]!,
          liveState: 'done',
          runDurationMs: 42_500,
          turnCount: 3,
          runStartedAt: -10,
          pendingAskSince: 'bad',
        },
        {
          ...(boardViewFixture().members as Array<Record<string, unknown>>)[1]!,
          liveState: 'working',
          runDurationMs: 45_000,
          runStartedAt: NOW - 12_000,
          turnCount: 1.5,
        },
      ],
    })
    const parsed = parseBoardView(rawWithMixedTiming)
    assert.ok(parsed !== undefined, '非法可选耗时字段不得导致整张看板被拒')
    assert.equal(parsed!.members[0]!.runDurationMs, 42_500)
    assert.equal(parsed!.members[0]!.turnCount, 3)
    assert.equal(parsed!.members[0]!.runStartedAt, undefined)
    assert.equal(parsed!.members[0]!.pendingAskSince, undefined)
    assert.equal(parsed!.members[1]!.runDurationMs, 45_000)
    assert.equal(parsed!.members[1]!.runStartedAt, NOW - 12_000)
    assert.equal(parsed!.members[1]!.turnCount, undefined)

    const activeGroupTiming = resolveGroupTimingView(parsed!, [], NOW, 'zh-CN')
    assert.ok(activeGroupTiming !== undefined)
    assert.equal(activeGroupTiming!.label, '3m05s')
    assert.match(activeGroupTiming!.tooltip, /端到端总耗时：3m05s/)
    assert.match(activeGroupTiming!.tooltip, /全员累计运行：1m39s/)
    assert.match(activeGroupTiming!.tooltip, /创建时间：/)
    assert.doesNotMatch(activeGroupTiming!.tooltip, /结单时间：/)

    const closedBoard = parseBoardView(
      boardViewFixture({
        group: {
          id: 'grp-closed',
          title: '已结单组',
          coordinatorConversationId: 50,
          status: 'closed',
          activeWorkerCount: 0,
          headSeq: 2,
          createdAt: T0,
          updatedAt: T0 + 125_000,
          closedAt: T0 + 125_000,
        },
        members: [
          {
            ...(boardViewFixture().members as Array<Record<string, unknown>>)[0]!,
            lifecycle: 'archived',
            archivedAt: T0 + 120_000,
            liveState: 'missing',
            runDurationMs: 42_500,
            turnCount: 2,
          },
          {
            ...(boardViewFixture().members as Array<Record<string, unknown>>)[1]!,
            lifecycle: 'archived',
            archivedAt: T0 + 125_000,
            liveState: 'missing',
            runDurationMs: 25_000,
            turnCount: 1,
          },
        ],
        activeWorkingMembers: [],
      }),
    )!
    const closedGroupTiming = resolveGroupTimingView(closedBoard, [], undefined, 'zh-CN')
    assert.ok(closedGroupTiming !== undefined, '结单组必须继续冻结展示总耗时，不再消失')
    assert.equal(closedGroupTiming!.label, '2m5s')
    assert.match(closedGroupTiming!.tooltip, /端到端总耗时：2m5s/)
    assert.match(closedGroupTiming!.tooltip, /全员累计运行：1m8s/)
    assert.match(closedGroupTiming!.tooltip, /创建时间：/)
    assert.match(closedGroupTiming!.tooltip, /结单时间：/)

    const firstTurn = resolvePanelMemberTimingView(
      { liveState: 'working', lifecycle: 'active', runDurationMs: 0, runStartedAt: NOW - 12_000, turnCount: 0, createdAt: T0 },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(firstTurn?.label, '12s', '首轮 working 去重仅显示本轮秒表')
    assert.equal(firstTurn?.tone, 'live')

    const multiTurn = resolvePanelMemberTimingView(
      { liveState: 'working', lifecycle: 'active', runDurationMs: 45_000, runStartedAt: NOW - 12_000, turnCount: 2, createdAt: T0 },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(multiTurn?.label, '本轮 12s · 累计 57s')
    assert.match(multiTurn?.tooltip ?? '', /累计运行：57s/)
    assert.match(multiTurn?.tooltip ?? '', /本轮运行：12s/)
    assert.match(multiTurn?.tooltip ?? '', /已完成轮次：2/)
    assert.match(multiTurn?.tooltip ?? '', /加入时间：/)

    const blockedWithTotal = resolvePanelMemberTimingView(
      {
        liveState: 'blocked',
        lifecycle: 'active',
        runDurationMs: 60_000,
        runStartedAt: NOW - 30_000,
        pendingAskSince: NOW - 25_000,
        turnCount: 1,
        createdAt: T0,
      },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(blockedWithTotal?.label, '等待审批 25s · 累计 1m30s')
    assert.equal(blockedWithTotal?.tone, 'warn')

    const blockedNoPriorRun = resolvePanelMemberTimingView(
      { liveState: 'blocked', lifecycle: 'active', runDurationMs: 0, pendingAskSince: NOW - 18_000, createdAt: T0 },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(blockedNoPriorRun?.label, '等待审批 18s')
    assert.equal(blockedNoPriorRun?.tone, 'warn')

    const settledDone = resolvePanelMemberTimingView(
      { liveState: 'done', lifecycle: 'active', runDurationMs: 42_500, turnCount: 2, createdAt: T0 },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(settledDone?.label, '42.5s')
    assert.equal(settledDone?.tone, 'settled')

    const idleZero = resolvePanelMemberTimingView(
      { liveState: 'idle', lifecycle: 'active', runDurationMs: 0, createdAt: T0 },
      'active',
      NOW,
      'zh-CN',
    )
    assert.equal(idleZero, undefined, '空闲且累计为 0 时诚实省略')

    const trayBlocked = resolveTrayMemberTimingView(
      { liveState: 'blocked', runDurationMs: 30_000, runStartedAt: NOW - 25_000, pendingAskSince: NOW - 20_000, turnCount: 1 },
      NOW,
      'zh-CN',
    )
    assert.equal(trayBlocked?.label, '等待审批 20s')
    assert.equal(trayBlocked?.isWarn, true)
    assert.match(trayBlocked?.tooltip ?? '', /本轮运行：25s/)
    assert.match(trayBlocked?.tooltip ?? '', /累计运行：55s/)
    assert.match(trayBlocked?.tooltip ?? '', /已完成轮次：1/)

    const trayWorking = resolveTrayMemberTimingView(
      { liveState: 'working', runDurationMs: 0, runStartedAt: NOW - 9_000, turnCount: 0 },
      NOW,
      'en',
    )
    assert.equal(trayWorking?.label, '9s')
    assert.equal(trayWorking?.isWarn, false)

    const postOffset = resolvePostTimeDisplay(T0 + 15_000, T0)
    assert.equal(postOffset?.label, '+00:15')
    assert.match(postOffset?.fullTimestamp ?? '', /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)

    const postHourOffset = resolvePostTimeDisplay(T0 + 3_735_000, T0)
    assert.equal(postHourOffset?.label, '+1:02:15')

    const postNegativeFallback = resolvePostTimeDisplay(T0 - 5_000, T0)
    assert.equal(postNegativeFallback?.label, postNegativeFallback?.fullTimestamp, '负偏移回退紧凑时刻')
  })
})
