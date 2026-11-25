/**
 * builtin:title real composition-root integration tests (`createHelmx` + `faux` provider):
 * 1. Default enabled: `/title` command registered with `scope: {}`, `generate` excluded from `<available_actions>`;
 * 2. Untitled conversation silently gets summarized title after first completed human turn;
 * 3. Manual `generate` after `/clear` (`resetConversation`) only reads post-reset conversation content;
 * 4. Plugin `model` config override (including `tier/<id>`) routes `completeText` to the configured model;
 * 5. Disabling `builtin:title` immediately removes `/title` command & stops auto-titling; re-enabling restores both.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { createHelmx } from '../../hub/src/app.js'
import { TIERS_PLUGIN_ID } from '../src/tiers/contracts.js'
import {
  TITLE_ACTION_GENERATE,
  TITLE_COMMAND_SLASH,
  TITLE_PLUGIN_ID,
  type TitleGenerateResult,
} from '../src/title.js'
import {
  cleanupDir,
  makeFauxProvider,
  makeTempDir,
  waitFor,
  type FauxProviderHandle,
} from './helpers/plugin-test-env.js'

interface IntegrationEnv {
  dataDir: string
  faux: FauxProviderHandle
  app: Awaited<ReturnType<typeof createHelmx>>
  close: () => Promise<void>
}

async function openTitleIntegrationEnv(): Promise<IntegrationEnv> {
  const dataDir = await makeTempDir('helmx-title-it-')
  const faux = makeFauxProvider({
    models: [{ id: 'faux-1' }, { id: 'fast', name: 'Fast' }],
  })
  const app = await createHelmx({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    providers: [faux.provider],
  })
  return {
    dataDir,
    faux,
    app,
    async close() {
      await app.close().catch(() => {})
      await cleanupDir(dataDir)
    },
  }
}

test('builtin:title integration: default enabled, silent first-turn titling, /clear cutoff, model override, and disable/enable', { timeout: 60_000 }, async () => {
  const env = await openTitleIntegrationEnv()
  try {
    const kernel = env.app.kernel

    // 1. Registered & enabled by default; command has scope:{} and generate stays out of <available_actions>.
    const summary = kernel.plugins.get(TITLE_PLUGIN_ID)
    assert.ok(summary && summary.enabled, 'builtin:title must be registered and enabled by default')
    const cmd = kernel.plugins
      .listUi()
      .find((u) => u.pluginId === TITLE_PLUGIN_ID && u.surface === 'commandPalette')
    assert.ok(cmd)
    assert.equal((cmd.spec as { slash?: unknown }).slash, TITLE_COMMAND_SLASH)
    assert.deepEqual((cmd.spec as { scope?: unknown }).scope, {})

    // 2. First turn on untitled conversation: main reply captures system sections, then background auto-title updates title.
    let capturedPromptActions = ''
    let autoTitleTranscript = ''
    env.faux.setResponses([
      (context) => {
        for (const msg of context.messages as unknown as Array<Record<string, unknown>>) {
          if (msg['role'] !== 'system') continue
          const sections = msg['sections'] as Record<string, string | null> | undefined
          if (sections?.['prompt.actions']) capturedPromptActions = sections['prompt.actions']
        }
        return fauxAssistantMessage('可以通过在 state.sqlite 增加覆盖索引并缩短锁持有时间来优化。')
      },
      (context, _opts, _state, model) => {
        assert.equal(model.id, 'faux-1')
        autoTitleTranscript = context.messages
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n')
        return fauxAssistantMessage('优化 SQLite 索引与锁性能')
      },
    ])

    const conv = await kernel.conversations.createConversation({ profileId: 'assistant' })
    assert.equal(conv.title, '')
    await kernel.conversations.submitInput(conv.id, '帮我分析为什么写入 state.sqlite 时偶发锁等待超时')
    await kernel.conversations.waitForIdle(conv.id)

    assert.equal(
      capturedPromptActions.includes('builtin:title.generate'),
      false,
      'generate action with exposeToPrompt: false must not enter <available_actions>',
    )

    await waitFor(() => kernel.conversations.getConversation(conv.id).title === '优化 SQLite 索引与锁性能')
    assert.ok(autoTitleTranscript.includes('为什么写入 state.sqlite'))

    // 3. After /clear (resetConversation), manual /title only summarizes entries after pi.reset.
    await kernel.conversations.resetConversation(conv.id)
    let resetTranscript = ''
    env.faux.setResponses([
      () => fauxAssistantMessage('已确认问题出在 WebSocket 重连退避没有加入随机抖动。'),
      (context) => {
        resetTranscript = context.messages
          .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
          .join('\n')
        return fauxAssistantMessage('添加 WebSocket 重连随机抖动')
      },
    ])
    await kernel.conversations.submitInput(conv.id, '排查远端节点重连风暴问题')
    await kernel.conversations.waitForIdle(conv.id)
    // Title must stay unchanged on post-reset turn (not auto-overwritten).
    assert.equal(kernel.conversations.getConversation(conv.id).title, '优化 SQLite 索引与锁性能')

    const refreshed = (await kernel.plugins.invokeAction(
      TITLE_PLUGIN_ID,
      TITLE_ACTION_GENERATE,
      {},
      { conversationId: conv.id },
    )) as TitleGenerateResult
    assert.deepEqual(refreshed, {
      conversationId: conv.id,
      previousTitle: '优化 SQLite 索引与锁性能',
      title: '添加 WebSocket 重连随机抖动',
      changed: true,
    })
    assert.equal(kernel.conversations.getConversation(conv.id).title, '添加 WebSocket 重连随机抖动')
    assert.ok(resetTranscript.includes('排查远端节点重连风暴问题'))
    assert.equal(resetTranscript.includes('state.sqlite'), false, 'entries before pi.reset must be excluded')

    // 4. Configured `model` override (via tier/fast) routes title completion to faux/fast.
    await kernel.plugins.invokeAction(TIERS_PLUGIN_ID, 'set', { id: 'fast', model: 'faux/fast' })
    await kernel.plugins.setConfig(TITLE_PLUGIN_ID, { model: 'tier/fast' })
    let seenOverrideModelId = ''
    env.faux.setResponses([
      (_context, _opts, _state, model) => {
        seenOverrideModelId = model.id
        return fauxAssistantMessage('节点重连退避与抖动修复')
      },
    ])
    const overridden = (await kernel.plugins.invokeAction(
      TITLE_PLUGIN_ID,
      TITLE_ACTION_GENERATE,
      { conversationId: conv.id },
    )) as TitleGenerateResult
    assert.equal(seenOverrideModelId, 'fast')
    assert.equal(overridden.title, '节点重连退避与抖动修复')

    // 5. Disable removes command & stops auto-titling; re-enable restores both.
    await kernel.plugins.disable(TITLE_PLUGIN_ID)
    assert.equal(
      kernel.plugins.listUi().some((u) => u.pluginId === TITLE_PLUGIN_ID),
      false,
      '/title command must disappear immediately when disabled',
    )
    const conv2 = await kernel.conversations.createConversation({ profileId: 'assistant' })
    env.faux.setResponses([fauxAssistantMessage('这是普通回答，不该消耗第二条标题响应')])
    await kernel.conversations.submitInput(conv2.id, '停用插件后的第一句话测试标题保持截取')
    await kernel.conversations.waitForIdle(conv2.id)
    assert.equal(kernel.conversations.getConversation(conv2.id).title, '停用插件后的第一句话测试标题保持截取')

    await kernel.plugins.enable(TITLE_PLUGIN_ID)
    assert.equal(
      kernel.plugins.listUi().some((u) => u.pluginId === TITLE_PLUGIN_ID && u.surface === 'commandPalette'),
      true,
      '/title command must return after re-enable',
    )
  } finally {
    await env.close()
  }
})
