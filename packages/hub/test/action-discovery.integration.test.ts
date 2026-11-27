/**
 * 动作发现运行时集成验证（真实 createHelmx 组合 + faux provider 最终模型请求断言，共享单实例减少冷启动）。
 */
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import type { ConversationEntry, PluginDefinition } from '@helmx/protocol'
import { initGitRepo } from '@helmx/test-kit/git'
import { useTempDir } from '@helmx/test-kit/node'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openHubTestEnv, type HubTestEnv } from './helpers/hub-test-env.js'

interface CapturedRequest {
  toolNames: string[]
  sectionsById: Record<string, string | null>
}

let env: HubTestEnv
const requests: CapturedRequest[] = []

before(async () => {
  env = await openHubTestEnv({ prefix: 'helmx-action-discovery-' })
}, { timeout: 60_000 })

after(async () => {
  await env?.close()
}, { timeout: 60_000 })

function capture(): FauxResponseStep {
  return (context) => {
    const sectionsById: Record<string, string | null> = {}
    for (const message of context.messages as unknown as Array<Record<string, unknown>>) {
      if (message['role'] !== 'system') continue
      const sections = message['sections'] as Record<string, string | null> | undefined
      if (sections === undefined) continue
      for (const [key, value] of Object.entries(sections)) sectionsById[key] = value
    }
    requests.push({
      toolNames: getCurrentTools(context.messages as never).map((tool) => tool.name),
      sectionsById,
    })
    return fauxAssistantMessage('already catch request')
  }
}

function toolCallStep(name: string, input: Record<string, unknown>): FauxResponseStep {
  return () => fauxAssistantMessage([fauxToolCall(name, input as Record<string, never>)], { stopReason: 'toolUse' })
}

async function submitAndWait(convId: number, text: string): Promise<void> {
  await env.kernel.conversations.submitInput(convId, text)
  await env.kernel.conversations.waitForIdle(convId)
}

function actionsSection(request: CapturedRequest): string | null | undefined {
  return request.sectionsById['prompt.actions']
}

function toolResultTexts(entries: ConversationEntry[]): string {
  return entries
    .filter((entry) => entry.kind === 'pi.tool-result')
    .flatMap((entry) => (entry.model ?? []) as Array<Record<string, unknown>>)
    .map((message) => JSON.stringify(message))
    .join('\n')
}

test('动作目录生命周期：普通插件启用即进目录、XML 转义与紧凑签名正确、停用后下一回合清空无残留', { timeout: 60_000 }, async () => {
  const conv = await env.kernel.conversations.createConversation({ title: 'plain-action' })
  const host = env.kernel.plugins
  await host.register({
    id: 'demo:plain',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'greet',
        description: 'many row description one row\nsecond row contains <xml> and & symbol',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            times: { type: 'number' },
            config: { type: 'object', properties: { deep: { type: 'string' } } },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['name'],
        },
        outputSchema: { type: 'object' },
        handler: () => ({ ok: true }),
      })
    },
  }, { enabled: true })

  try {
    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(conv.id, 'one turn')
    const section = actionsSection(requests[0]!)!
    assert.ok(section.includes('<available_actions>') && section.includes('demo:plain.greet'))
    assert.ok(!section.includes('\nsecond row'))
    assert.ok(section.includes('&lt;xml&gt;') && section.includes('&amp;'))
    assert.ok(section.includes('name: string(required)') && section.includes('times: number(optional)'))
    assert.ok(section.includes('config: object(embed set)(describe query)(optional)'))
    assert.ok(section.includes('tags: string[](optional)'))
    assert.ok(section.includes('CLI: helmx demo:plain greet'))
    assert.ok(section.includes('describe: true') && section.includes('not via bash'))
    assert.ok(!section.includes('helmx actions list --json'))

    await host.disable('demo:plain')
    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(conv.id, 'second turn')
    assert.ok(!(actionsSection(requests[0]!) ?? '').includes('demo:plain'))
    for (const [id, text] of Object.entries(requests[0]!.sectionsById)) {
      if (id !== 'prompt.actions') assert.ok(!(text ?? '').includes('demo:plain.greet'))
    }

    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(conv.id, 'third turn')
    assert.ok(!(actionsSection(requests[0]!) ?? '').includes('&lt;xml&gt;'))
  } finally {
    await host.disable('demo:plain').catch(() => {})
  }
})

test('磁盘外部插件：rescan 后默认隐藏，启用即自动进入目录，停用即清理', { timeout: 60_000 }, async () => {
  const conv = await env.kernel.conversations.createConversation({ title: 'ext-notice' })
  const host = env.kernel.plugins
  const pluginDir = join(env.dataDir, 'installed-plugins', 'external-notice')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
    id: 'external-notice', name: 'external notify', version: '1.0.0', main: 'index.mjs',
  }))
  writeFileSync(join(pluginDir, 'index.mjs'), `export default {
    id: 'external-notice',
    definePlugin(ctx) {
      ctx.action({
        id: 'send', description: 'from disk external plugin notify action',
        promptGuidelines: ['EXTERNAL_NOTICE_GUIDE core for piece person and notify content'],
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { delivered: { type: 'boolean' } }, required: ['delivered'] },
        handler() { return { delivered: true } },
      })
    },
  }`)

  try {
    const rescanned = await host.rescanExternalPlugins()
    assert.ok(rescanned.registered.includes('external-notice'))
    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(conv.id, 'before enable')
    assert.ok(!actionsSection(requests.at(-1)!)?.includes('external-notice'))

    await host.enable('external-notice')
    env.faux.setResponses([capture()])
    await submitAndWait(conv.id, 'after enable')
    const section = actionsSection(requests.at(-1)!)!
    assert.ok(section.includes('external-notice.send') && section.includes('EXTERNAL_NOTICE_GUIDE'))
    assert.ok(section.includes('CLI: helmx external-notice send'))

    await host.disable('external-notice')
    env.faux.setResponses([capture()])
    await submitAndWait(conv.id, 'after disable')
    assert.ok(!actionsSection(requests.at(-1)!)?.includes('external-notice'))
    assert.ok(!JSON.stringify(requests.at(-1)!.sectionsById).includes('EXTERNAL_NOTICE_GUIDE'))
  } finally {
    await host.disable('external-notice').catch(() => {})
  }
})

test('作用域裁剪与 before_turn 剥离：不匹配会话不进目录不泄漏工具；剥离 run_action 时目录清空且直投不借道复现', { timeout: 60_000 }, async () => {
  const host = env.kernel.plugins
  const plainConv = await env.kernel.conversations.createConversation({ title: 'plain-scope' })
  const alphaConv = await env.kernel.conversations.createConversation({ title: 'alpha-scope', tags: ['alpha'] })

  await host.register({
    id: 'demo:scoped',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'plain_scoped',
        description: 'only alpha conversation available',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        scope: { tags: ['alpha'] },
        handler: () => ({ ok: true }),
      })
      ctx.action({
        id: 'direct_scoped',
        description: 'only alpha direct tool',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        exposeAsTool: true,
        scope: { tags: ['alpha'] },
        handler: () => ({ ok: true }),
      })
    },
  }, { enabled: true })

  try {
    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(plainConv.id, 'outside scope')
    const outside = requests[0]!
    assert.ok(!(actionsSection(outside) ?? '').includes('demo:scoped'))
    assert.equal(outside.toolNames.find((n) => n.includes('direct_scoped')), undefined)
    assert.ok(outside.toolNames.includes('run_action'))

    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(alphaConv.id, 'inside scope')
    const inside = requests[0]!
    assert.ok(actionsSection(inside)?.includes('demo:scoped.plain_scoped'))
    assert.ok(!actionsSection(inside)!.includes('demo:scoped.direct_scoped'))
    assert.ok(inside.toolNames.some((n) => n.includes('direct_scoped')))
  } finally {
    await host.disable('demo:scoped')
  }

  // before_turn 剥离 run_action 与直投工具
  await host.register({
    id: 'demo:reach',
    definePlugin: (ctx) => {
      ctx.action({ id: 'probe', description: 'probe', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, handler: () => ({ ok: true }) })
      ctx.action({ id: 'direct_one', description: 'direct', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, exposeAsTool: true, handler: () => ({ ok: true }) })
    },
  }, { enabled: true })
  await host.register({
    id: 'demo:stripper',
    definePlugin: (ctx) => {
      ctx.hook.onBeforeTurn((turn) => {
        const targets = ['run_action', ...turn.tools.map((t) => t.name).filter((n) => n.includes('direct_one'))]
        return { action: 'transform', value: { ...turn, tools: turn.tools.filter((t) => !targets.includes(t.name)) } }
      }, { priority: 100 })
    },
  }, { enabled: true })

  try {
    const stripConv = await env.kernel.conversations.createConversation({ title: 'strip-scope' })
    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(stripConv.id, 'strip turn')
    const stripped = requests[0]!
    assert.equal(actionsSection(stripped), undefined)
    assert.ok(!stripped.toolNames.includes('run_action') && !stripped.toolNames.some((n) => n.includes('direct_one')))
    assert.ok(!Object.values(stripped.sectionsById).join('\n').includes('demo:reach.direct_one'))

    await host.disable('demo:stripper')
    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(stripConv.id, 'restore turn')
    assert.ok(requests[0]!.toolNames.includes('run_action'))
    assert.ok(actionsSection(requests[0]!)?.includes('demo:reach.probe'))
    assert.ok(requests[0]!.toolNames.some((n) => n.includes('direct_one')))
  } finally {
    await host.disable('demo:stripper').catch(() => {})
    await host.disable('demo:reach').catch(() => {})
  }
})

test('指引单次注入、CLI 覆写/隐藏与插件重载元数据更新', { timeout: 60_000 }, async () => {
  const host = env.kernel.plugins
  const conv = await env.kernel.conversations.createConversation({ title: 'guide-cli-refresh' })

  await host.register({
    id: 'demo:guide-cli',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'direct_guided',
        description: 'direct guided',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        exposeAsTool: true,
        promptSnippet: 'DIRECT_SNIPPET_MARKER direct throw',
        promptGuidelines: ['DIRECT_GUIDELINE_MARKER want point'],
        handler: () => ({ ok: true }),
      })
      ctx.action({
        id: 'plain_guided',
        description: 'plain guided',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        promptSnippet: 'PLAIN_SNIPPET_MARKER ordinary\nsecond row',
        promptGuidelines: ['PLAIN_GUIDELINE_MARKER want point'],
        cli: { command: ['team', 'report', 'make'] },
        handler: () => ({ ok: true }),
      })
      ctx.action({
        id: 'secret_cmd',
        description: 'hide CLI action',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        cli: { hidden: true },
        handler: () => ({ ok: true }),
      })
    },
  }, { enabled: true })

  try {
    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(conv.id, 'guide and cli turn')
    const req = requests[0]!
    const section = actionsSection(req)!
    const directToolSection = Object.entries(req.sectionsById)
      .filter(([id]) => id.startsWith('prompt.tools.'))
      .map(([, text]) => text ?? '')
      .join('\n')

    assert.ok(directToolSection.includes('DIRECT_SNIPPET_MARKER') && directToolSection.includes('DIRECT_GUIDELINE_MARKER'))
    assert.ok(!section.includes('DIRECT_SNIPPET_MARKER') && !section.includes('DIRECT_GUIDELINE_MARKER'))
    assert.ok(section.includes('PLAIN_SNIPPET_MARKER') && section.includes('PLAIN_GUIDELINE_MARKER'))
    assert.ok(section.includes('refer quote (demo:guide-cli.plain_guided)') && section.includes('note (demo:guide-cli.plain_guided)'))
    assert.ok(!directToolSection.includes('PLAIN_SNIPPET_MARKER'))
    assert.ok(section.includes('CLI: helmx team report make'))
    const secretIdx = section.indexOf('demo:guide-cli.secret_cmd')
    const nextIdx = section.indexOf('- demo:', secretIdx + 1)
    assert.ok(!section.slice(secretIdx, nextIdx === -1 ? section.length : nextIdx).includes('CLI:'))
  } finally {
    await host.disable('demo:guide-cli')
  }

  // 元数据热更新无旧描述残留
  let description = 'old description text OLD_DESC_MARKER'
  const makeRefreshDef = (): PluginDefinition => ({
    id: 'demo:refresh',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'evolve',
        description,
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        outputSchema: { type: 'object' },
        handler: () => ({ ok: true }),
      })
    },
  })
  await host.register(makeRefreshDef(), { enabled: true })
  try {
    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(conv.id, 'before refresh')
    assert.ok(actionsSection(requests[0]!)!.includes('OLD_DESC_MARKER'))

    description = 'new description text NEW_DESC_MARKER'
    await host.disable('demo:refresh')
    await host.unregister('demo:refresh')
    await host.register(makeRefreshDef())
    await host.enable('demo:refresh')

    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(conv.id, 'after refresh')
    const refreshed = actionsSection(requests[0]!)!
    assert.ok(refreshed.includes('NEW_DESC_MARKER') && !refreshed.includes('OLD_DESC_MARKER'))
  } finally {
    await host.disable('demo:refresh').catch(() => {})
  }
})

test('describe 模式：真实 run_action 返回完整嵌套 Schema 且不执行 handler；停用与作用域外显式拒绝', { timeout: 60_000 }, async () => {
  const host = env.kernel.plugins
  const conv = await env.kernel.conversations.createConversation({ title: 'describe-mode' })
  let handlerRuns = 0
  await host.register({
    id: 'demo:describe',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'nested',
        description: 'embed set Schema action',
        inputSchema: {
          type: 'object',
          properties: {
            payload: { type: 'object', properties: { deep: { type: 'string' }, list: { type: 'array', items: { type: 'number' } } } },
          },
          required: ['payload'],
        },
        outputSchema: { type: 'object', properties: { echoed: { type: 'boolean' } } },
        handler: () => {
          handlerRuns += 1
          return { echoed: true }
        },
      })
      ctx.action({
        id: 'alpha_only',
        description: 'only alpha conversation',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        scope: { tags: ['alpha'] },
        handler: () => ({ ok: true }),
      })
    },
  }, { enabled: true })

  try {
    env.faux.setResponses([toolCallStep('run_action', { actionId: 'demo:describe.nested', describe: true }), capture()])
    await submitAndWait(conv.id, 'query schema')
    assert.equal(handlerRuns, 0)
    const describeTexts = toolResultTexts((await env.kernel.conversations.getConversationDetail(conv.id)).entries)
    assert.ok(describeTexts.includes('demo:describe') && describeTexts.includes('nested'))
    assert.ok(describeTexts.includes('payload') && describeTexts.includes('deep') && describeTexts.includes('outputSchema'))

    env.faux.setResponses([
      toolCallStep('run_action', { actionId: 'demo:describe.nested', input: { payload: { deep: 'x' } } }),
      capture(),
    ])
    await submitAndWait(conv.id, 'real execute')
    assert.equal(handlerRuns, 1)

    const scopedConv = await env.kernel.conversations.createConversation({ title: 'describe-scoped' })
    env.faux.setResponses([toolCallStep('run_action', { actionId: 'demo:describe.alpha_only', describe: true }), capture()])
    await submitAndWait(scopedConv.id, 'outside scope query')
    assert.ok(toolResultTexts((await env.kernel.conversations.getConversationDetail(scopedConv.id)).entries).includes('scope'))

    await host.disable('demo:describe')
    const disabledConv = await env.kernel.conversations.createConversation({ title: 'describe-disabled' })
    env.faux.setResponses([toolCallStep('run_action', { actionId: 'demo:describe.nested', describe: true }), capture()])
    await submitAndWait(disabledConv.id, 'disabled query')
    assert.ok(toolResultTexts((await env.kernel.conversations.getConversationDetail(disabledConv.id)).entries).includes('does not declare action'))
  } finally {
    await host.disable('demo:describe').catch(() => {})
  }
})

test('Skill-First 内置插件零默认 <available_actions>；internal/ui 403 硬拦截；cleanup_worktree 按活跃 worktree 条件暴露', { timeout: 60_000 }, async (t) => {
  const conv = await env.kernel.conversations.createConversation({ title: 'worktree-actions-directory' })
  requests.length = 0
  env.faux.setResponses([capture()])
  await submitAndWait(conv.id, 'show actions')
  const req = requests[0]!

  // 1) Skill-First 不变量：仅启用内置插件时，无任何动作常驻 <available_actions>（prompt.actions 缺席）。
  assert.equal(actionsSection(req), undefined, '仅启用内置插件时不应渲染 <available_actions>')
  // 状态门控直投工具：无活跃 worktree 时省略 cleanup_worktree，无活跃子代理时省略 workflow_steer_*。
  assert.ok(!req.toolNames.includes('cleanup_worktree'), '0 个活跃 worktree 时 before_turn 应省略 cleanup_worktree')
  assert.ok(!req.toolNames.some((name) => name.startsWith('workflow_steer_')), '0 个活跃子代理时 before_turn 应省略 workflow_steer')
  // cleanup_worktree 仍在 PluginHost 工具表中声明为 exposeAsTool。
  assert.ok(env.kernel.plugins.listTools().some((tool) => tool.name === 'cleanup_worktree'))
  // 全部请求段均不得泄漏内部动作名（防跨段残留）。
  for (const [id, text] of Object.entries(req.sectionsById)) {
    assert.ok(!(text ?? '').includes('acquire_worktree'), `段 ${id} 不得泄漏 acquire_worktree`)
    assert.ok(!(text ?? '').includes('release_worktree_hold'), `段 ${id} 不得泄漏 release_worktree_hold`)
    assert.ok(!(text ?? '').includes('builtin:tiers.replace'), `段 ${id} 不得泄漏 tiers.replace`)
  }

  // 2) Skill-First 隐藏的公开内置动作仍可经 run_action describe 与执行；internal/ui 动作仍硬拒 403 action_visibility_forbidden。
  const guardConv = await env.kernel.conversations.createConversation({ title: 'visibility-guard-run-action' })
  env.faux.setResponses([
    toolCallStep('run_action', { actionId: 'builtin:worktree.list_worktrees', input: {} }),
    toolCallStep('run_action', { actionId: 'builtin:tiers.list', describe: true }),
    toolCallStep('run_action', { actionId: 'builtin:worktree.acquire_worktree', describe: true }),
    toolCallStep('run_action', {
      actionId: 'builtin:worktree.acquire_worktree',
      input: { conversationId: guardConv.id, parentConversationId: 1, hold: { holdId: 'x', label: 'y' } },
    }),
    toolCallStep('run_action', { actionId: 'builtin:worktree.release_worktree_hold', input: { worktreeId: 'local:/x', holdId: 'h' } }),
    toolCallStep('run_action', { actionId: 'builtin:tiers.replace', describe: true }),
    toolCallStep('run_action', { actionId: 'builtin:tiers.replace', input: { tiers: {} } }),
    capture(),
  ])
  await submitAndWait(guardConv.id, 'probe public and forbidden actions')
  const resultTexts = toolResultTexts((await env.kernel.conversations.getConversationDetail(guardConv.id)).entries)
  assert.ok(resultTexts.includes('\\"worktrees\\":[]'), `Skill-First 公开动作 list_worktrees 应仍可经 run_action 执行：${resultTexts}`)
  assert.ok(resultTexts.includes('\\"pluginId\\": \\"builtin:tiers\\"') && resultTexts.includes('\\"id\\": \\"list\\"'), `Skill-First 公开动作 tiers.list 应仍可经 run_action describe：${resultTexts}`)
  assert.ok(resultTexts.includes("visibility 'internal'"), `run_action 应拒绝 internal 动作：${resultTexts}`)
  assert.ok(resultTexts.includes("visibility 'ui'"), `run_action 应拒绝 ui 动作：${resultTexts}`)
  assert.ok(!resultTexts.includes('parentConversationId'), 'describe 拒绝 internal 时不得泄漏 inputSchema')

  // 3) 一旦存在活跃受管 worktree，cleanup_worktree 立即进入回合工具面；清理后再次省略。
  const repoDir = useTempDir(t, 'helmx-action-discovery-wt-')
  initGitRepo(repoDir)
  const wtParent = await env.kernel.conversations.createConversation({ title: 'wt-gate-parent', cwd: repoDir })
  const wtChild = await env.kernel.conversations.createConversation({ title: 'wt-gate-child', cwd: repoDir })
  const pluginCaller = { surface: 'plugin' as const, callerPluginId: 'test:wt-gate' }
  const acquired = (await env.kernel.plugins.invokeAction(
    'builtin:worktree',
    'acquire_worktree',
    {
      conversationId: wtChild.id,
      parentConversationId: wtParent.id,
      hold: { holdId: 'h1', label: 'gate test' },
    },
    {},
    pluginCaller,
  )) as { worktreeId: string }

  try {
    requests.length = 0
    env.faux.setResponses([capture()])
    await submitAndWait(wtParent.id, 'active worktree turn')
    assert.ok(requests[0]!.toolNames.includes('cleanup_worktree'), '存在活跃 worktree 时应暴露 cleanup_worktree')
    assert.equal(actionsSection(requests[0]!), undefined, 'cleanup_worktree 直投工具后仍不进入 <available_actions>')
  } finally {
    await env.kernel.plugins.invokeAction(
      'builtin:worktree',
      'release_worktree_hold',
      { worktreeId: acquired.worktreeId, holdId: 'h1' },
      {},
      pluginCaller,
    )
    await env.kernel.plugins.invokeAction('builtin:worktree', 'cleanup_worktree', {
      worktreeId: acquired.worktreeId,
      deleteBranch: true,
      force: true,
    })
  }

  requests.length = 0
  env.faux.setResponses([capture()])
  await submitAndWait(wtParent.id, 'after cleanup turn')
  assert.ok(!requests[0]!.toolNames.includes('cleanup_worktree'), '清理完最后一个活跃 worktree 后应再次省略 cleanup_worktree')
})
