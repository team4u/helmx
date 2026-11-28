/**
 * 归属权实时投射、受管自举资产与既有用户自定义资产保护集成验证（共享主实例 + 用户既有资产独立实例）。
 */
import { type HelmxEventFrame, type PluginDefinition } from '@helmx/protocol'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openHubTestEnv, type HubTestEnv } from './helpers/hub-test-env.js'

const ROOT_CONVERSATION_ID = 1 as const
const TEST_MANAGED_PLUGIN_ID = 'test:managed-assets'

let env: HubTestEnv

function makeManagedAssetsPlugin(dataDir: string, onStarted?: (ids: { routerId: number; helperId: number }) => void): PluginDefinition {
  return {
    id: TEST_MANAGED_PLUGIN_ID,
    name: 'Test Managed Assets',
    definePlugin(ctx) {
      let releases: Array<() => void> = []
      ctx.service({
        id: 'managed-assets-bootstrap',
        async start() {
          // 仅对缺失的 Profile 写入托管定义，避免覆盖既有用户自定义 Profile（逐文件幂等补齐）
          const ensureProfile = async (
            id: string,
            name: string,
            skills: string[],
            system: string,
          ) => {
            const dir = await ctx.host.profiles.directory(id)
            if (!existsSync(join(dir, 'profile.json'))) {
              await ctx.host.profiles.save({
                id,
                name,
                tags: [id],
                skills,
                managedByPlugin: TEST_MANAGED_PLUGIN_ID,
                system,
              })
            } else if (!existsSync(join(dir, 'SYSTEM.md'))) {
              mkdirSync(dir, { recursive: true })
              writeFileSync(join(dir, 'SYSTEM.md'), system)
            }
          }

          await ensureProfile('managed-hub', 'Managed Hub', [], '# Managed Hub\n')
          await ensureProfile('managed-helper', 'Managed Helper', ['managed-playbooks'], '# Managed Helper\n')

          // 技能目录同理：未自定义 SKILL.md 时走 ensureSkill，否则仅补齐缺失 references
          const skillDir = join(dataDir, 'skills', 'managed-playbooks')
          if (!existsSync(join(skillDir, 'SKILL.md'))) {
            await ctx.host.skills.ensureSkill({
              id: 'managed-playbooks',
              skillMd: [
                '---',
                'name: managed-playbooks',
                'description: Managed playbooks for integration test',
                `managedByPlugin: ${TEST_MANAGED_PLUGIN_ID}`,
                '---',
                '',
                '# Managed Playbooks',
                '',
              ].join('\n'),
              references: {
                'recovery.md': '# Recovery Reference\n',
              },
            })
          } else {
            const refPath = join(skillDir, 'references', 'recovery.md')
            if (!existsSync(refPath)) {
              mkdirSync(join(skillDir, 'references'), { recursive: true })
              writeFileSync(refPath, '# Recovery Reference\n')
            }
          }

          const router = await ctx.host.createConversation({
            title: 'Managed Hub',
            profileId: 'managed-hub',
          })
          ctx.host.markConversationOwnership(router.id, 'helmx')
          const helper = await ctx.host.createConversation({
            title: 'Managed Helper',
            profileId: 'managed-helper',
          })
          ctx.host.markConversationOwnership(helper.id, 'helmx')
          releases = [
            ctx.host.manageConversation(router.id),
            ctx.host.manageConversation(helper.id),
          ]
          onStarted?.({ routerId: router.id, helperId: helper.id })
        },
        async stop() {
          for (const release of releases) release()
          releases = []
        },
      })
    },
  }
}

before(async () => {
  env = await openHubTestEnv({ prefix: 'helmx-ownership-' })
}, { timeout: 60_000 })

after(async () => {
  await env?.close()
}, { timeout: 60_000 })

test('ownedBy 实时投射与事件广播及插件受管 Profile/Skill 自举标记', { timeout: 60_000 }, async () => {
  const { kernel } = env

  // 1. 普通会话与初始 #1 恒为 human；markOwnership 幂等与变更广播
  assert.equal(kernel.conversations.getConversation(ROOT_CONVERSATION_ID).ownedBy, 'human')
  const human = await kernel.conversations.createConversation({ title: 'human conversation', profileId: 'assistant' })
  assert.equal(human.ownedBy, 'human')

  const frames: HelmxEventFrame[] = []
  const off = kernel.events.subscribe((frame) => frames.push(frame))
  try {
    frames.length = 0
    kernel.ownership.markOwnership(human.id, 'human')
    assert.equal(frames.filter((f) => f.event.type === 'conversation.upsert').length, 0)

    kernel.ownership.markOwnership(human.id, 'helmx')
    const upsert = frames.find(
      (f) => f.event.type === 'conversation.upsert' && (f.event as { conversation?: { id?: number } }).conversation?.id === human.id,
    )
    assert.equal((upsert?.event as { conversation?: { ownedBy?: string } })?.conversation?.ownedBy, 'helmx')
    assert.equal(kernel.conversations.getConversation(human.id).ownedBy, 'helmx')

    frames.length = 0
    kernel.ownership.markOwnership(human.id, 'human')
    const revert = frames.find(
      (f) => f.event.type === 'conversation.upsert' && (f.event as { conversation?: { id?: number } }).conversation?.id === human.id,
    )
    assert.equal((revert?.event as { conversation?: { ownedBy?: string } })?.conversation?.ownedBy, 'human')
  } finally {
    off()
  }

  // 2. 启用受管资产插件：受管会话归属 helmx，自举 Profile/Skill 携带 managedByPlugin
  let createdIds: { routerId: number; helperId: number } | undefined
  await kernel.plugins.register(makeManagedAssetsPlugin(env.dataDir, (ids) => { createdIds = ids }), { enabled: false })
  await kernel.plugins.enable(TEST_MANAGED_PLUGIN_ID)
  try {
    assert.ok(createdIds)
    assert.equal(kernel.conversations.getConversation(createdIds.routerId).ownedBy, 'helmx')
    assert.equal(kernel.conversations.getConversation(createdIds.helperId).ownedBy, 'helmx')
    const listed = new Map(kernel.conversations.listConversations().map((s) => [s.id, s.ownedBy]))
    assert.equal(listed.get(createdIds.routerId), 'helmx')
    assert.equal(listed.get(createdIds.helperId), 'helmx')
    assert.equal(listed.get(ROOT_CONVERSATION_ID), 'human')

    const hubJson = JSON.parse(
      readFileSync(join(env.dataDir, 'profiles', 'managed-hub', 'profile.json'), 'utf8'),
    ) as { managedByPlugin?: string; skills?: string[] }
    assert.equal(hubJson.managedByPlugin, TEST_MANAGED_PLUGIN_ID)
    assert.deepEqual(hubJson.skills, [])

    const helperJson = JSON.parse(
      readFileSync(join(env.dataDir, 'profiles', 'managed-helper', 'profile.json'), 'utf8'),
    ) as { managedByPlugin?: string; skills?: string[] }
    assert.equal(helperJson.managedByPlugin, TEST_MANAGED_PLUGIN_ID)
    assert.deepEqual(helperJson.skills, ['managed-playbooks'])

    const profiles = await kernel.profiles.list()
    assert.equal(profiles.find((p) => p.id === 'assistant')?.managedByPlugin, 'core:profiles')
    assert.match(
      readFileSync(join(env.dataDir, 'skills', 'managed-playbooks', 'SKILL.md'), 'utf8'),
      new RegExp(`^managedByPlugin: ${TEST_MANAGED_PLUGIN_ID}$`, 'm'),
    )
    assert.equal((await kernel.skills.list()).find((s) => s.id === 'managed-playbooks')?.managedByPlugin, TEST_MANAGED_PLUGIN_ID)
  } finally {
    await kernel.plugins.disable(TEST_MANAGED_PLUGIN_ID)
  }
})

test('既有自定义 Profile/Skill 逐字节保持且仅补齐缺失文件（partial-start 幂等，零迁移回填）', { timeout: 60_000 }, async () => {
  const custom = await openHubTestEnv({ prefix: 'helmx-ownership-custom-' })
  try {
    const profileJsonRaw = JSON.stringify({ id: 'managed-hub', name: 'I custom hub', model: 'faux/faux-1' }, null, 2) + '\n'
    const systemMdRaw = '# I custom hub hint\n'
    const memoryMdRaw = '# Memory\n\nuser memory\n'
    const skillMdRaw = ['---', 'name: managed-playbooks', 'description: I self define manual', '---', '', '# I manual body text', ''].join('\n')

    mkdirSync(join(custom.dataDir, 'profiles', 'managed-hub'), { recursive: true })
    writeFileSync(join(custom.dataDir, 'profiles', 'managed-hub', 'profile.json'), profileJsonRaw)
    writeFileSync(join(custom.dataDir, 'profiles', 'managed-hub', 'SYSTEM.md'), systemMdRaw)
    writeFileSync(join(custom.dataDir, 'profiles', 'managed-hub', 'MEMORY.md'), memoryMdRaw)
    mkdirSync(join(custom.dataDir, 'skills', 'managed-playbooks'), { recursive: true })
    writeFileSync(join(custom.dataDir, 'skills', 'managed-playbooks', 'SKILL.md'), skillMdRaw)

    await custom.kernel.plugins.register(makeManagedAssetsPlugin(custom.dataDir), { enabled: false })
    await custom.kernel.plugins.enable(TEST_MANAGED_PLUGIN_ID)
    assert.equal(readFileSync(join(custom.dataDir, 'profiles', 'managed-hub', 'profile.json'), 'utf8'), profileJsonRaw)
    assert.equal(readFileSync(join(custom.dataDir, 'profiles', 'managed-hub', 'SYSTEM.md'), 'utf8'), systemMdRaw)
    assert.equal(readFileSync(join(custom.dataDir, 'profiles', 'managed-hub', 'MEMORY.md'), 'utf8'), memoryMdRaw)
    assert.equal(readFileSync(join(custom.dataDir, 'skills', 'managed-playbooks', 'SKILL.md'), 'utf8'), skillMdRaw)

    const userP = (await custom.kernel.profiles.list()).find((p) => p.id === 'managed-hub')
    assert.equal(userP?.managedByPlugin, undefined)
    assert.equal(userP?.name, 'I custom hub')
    assert.equal((await custom.kernel.skills.list()).find((s) => s.id === 'managed-playbooks')?.managedByPlugin, undefined)

    assert.match(
      readFileSync(join(custom.dataDir, 'skills', 'managed-playbooks', 'references', 'recovery.md'), 'utf8'),
      /Recovery Reference/,
    )
    const helperJson = JSON.parse(readFileSync(join(custom.dataDir, 'profiles', 'managed-helper', 'profile.json'), 'utf8')) as {
      managedByPlugin?: string
    }
    assert.equal(helperJson.managedByPlugin, TEST_MANAGED_PLUGIN_ID)

    await custom.kernel.plugins.disable(TEST_MANAGED_PLUGIN_ID)
    await custom.kernel.plugins.enable(TEST_MANAGED_PLUGIN_ID)
    assert.equal(readFileSync(join(custom.dataDir, 'profiles', 'managed-hub', 'profile.json'), 'utf8'), profileJsonRaw)
    assert.equal(readFileSync(join(custom.dataDir, 'skills', 'managed-playbooks', 'SKILL.md'), 'utf8'), skillMdRaw)
  } finally {
    await custom.close()
  }
})
