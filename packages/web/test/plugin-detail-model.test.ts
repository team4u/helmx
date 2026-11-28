/**
 * 插件详情抽屉拆分后的纯模型契约测试：
 * - plugin-detail-model：标题兜底、仅活跃插件暴露 Screen 快捷入口、受管技能过滤；
 * - plugin-config-form-model：初值 secret 恒空、可重置裁决（必填无 default / 来源 / 掩码）、字段 id 与标题解析。
 */
import './helpers/register-happy-dom.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PluginSummary } from '@helmx/protocol'
import { createWebTranslator } from '../src/i18n/catalog.js'
import { groupUiContributions, type GroupedUiSpecs } from '../src/lib/types.js'
import {
  canResetPluginConfigField,
  initialPluginConfigValues,
  pluginConfigFieldId,
  resolveConfigFieldTitle,
} from '../src/plugins/plugin-detail/plugin-config-form-model.js'
import {
  pluginDrawerScreens,
  pluginDrawerTitle,
  pluginDrawerVersionLabel,
  pluginManagedSkills,
} from '../src/plugins/plugin-detail/plugin-detail-model.js'
import type { PluginConfigResponse } from '../src/lib/api.js'

const enT = createWebTranslator('en')

function makePlugin(partial: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'builtin:workflow',
    name: '工作流引擎',
    version: 'v1.2.0',
    enabled: true,
    status: 'active',
    hooks: [],
    actions: [],
    tools: [],
    ...partial,
  } as PluginSummary
}

test('pluginDrawerTitle / pluginDrawerVersionLabel：名称本地化、ID 与兜底文案依次回落', { timeout: 60_000 }, () => {
  assert.equal(pluginDrawerTitle(makePlugin(), 'zh-CN', enT), '工作流引擎')
  assert.equal(pluginDrawerVersionLabel(makePlugin()), 'v1.2.0')
  assert.equal(pluginDrawerVersionLabel(makePlugin({ version: '1.2.0' })), 'v1.2.0')
  assert.equal(pluginDrawerVersionLabel(makePlugin({ version: undefined })), null)
  assert.equal(pluginDrawerTitle(null, 'en', enT), 'Plugin details')
})

test('pluginDrawerScreens：仅活跃运行态且有 Screen 贡献时返回可打开入口，failed/disabled 不暴露', { timeout: 60_000 }, () => {
  const grouped: GroupedUiSpecs = groupUiContributions([
    {
      pluginId: 'builtin:workflow',
      surface: 'screen',
      spec: { id: 'runs', label: 'Runs', client: { module: 'index.tsx', export: 'Runs' } },
    },
  ] as import('../src/lib/types.js').HelmxStoreValue['uiContributions'])
  const active = makePlugin()
  assert.deepEqual(
    pluginDrawerScreens(active, grouped).map((s) => s.screenId),
    ['runs'],
  )
  const failed = makePlugin({ status: 'failed' })
  assert.deepEqual(pluginDrawerScreens(failed, grouped), [])
  const disabled = makePlugin({ enabled: false, status: 'disabled' })
  assert.deepEqual(pluginDrawerScreens(disabled, grouped), [])
  assert.deepEqual(pluginDrawerScreens(active, undefined), [])
})

test('pluginManagedSkills：仅保留该插件受管且非 agents / node 来源的技能', { timeout: 60_000 }, () => {
  const skills = [
    { id: 'a', name: 'A', source: 'plugin', managedByPlugin: 'builtin:workflow' },
    { id: 'b', name: 'B', source: 'agents', managedByPlugin: 'builtin:workflow' },
    { id: 'c', name: 'C', source: 'plugin', managedByPlugin: 'builtin:other' },
    { id: 'd', name: 'D', source: 'hub' },
  ] as never
  assert.deepEqual(
    pluginManagedSkills(skills, 'builtin:workflow').map((s) => s.id),
    ['a'],
  )
  assert.deepEqual(pluginManagedSkills(undefined, 'builtin:workflow'), [])
})

test('initialPluginConfigValues：secret 恒为空串，其余按服务端值 / default / 类型零值回填', { timeout: 60_000 }, () => {
  const config: PluginConfigResponse = {
    pluginId: 'builtin:workflow',
    schema: {
      token: { type: 'string', secret: true },
      limit: { type: 'number', default: 5 },
      tags: { type: 'string[]', default: ['x'] },
      enabled: { type: 'boolean' },
      mode: { type: 'string', enum: ['a', 'b'] },
    },
    values: { token: '******', limit: 9 },
    sources: { token: 'configured' },
  } as PluginConfigResponse
  const values = initialPluginConfigValues(config)
  assert.equal(values.token, '')
  assert.equal(values.limit, 9)
  assert.deepEqual(values.tags, ['x'])
  assert.equal(values.enabled, false)
  assert.equal(values.mode, '')
})

test('canResetPluginConfigField：必填且无 default 禁止重置；来源 configured 可重置；仅掩码回显的 secret 可重置', { timeout: 60_000 }, () => {
  const requiredNoDefault = { type: 'string', required: true } as never
  const secret = { type: 'string', secret: true } as never
  const plain = { type: 'string', default: 'x' } as never
  assert.equal(canResetPluginConfigField(requiredNoDefault, 'configured', 'v'), false)
  assert.equal(canResetPluginConfigField(plain, 'configured', 'v'), true)
  assert.equal(canResetPluginConfigField(plain, 'default', 'v'), false)
  assert.equal(canResetPluginConfigField(secret, undefined, '******'), true)
  assert.equal(canResetPluginConfigField(secret, undefined, ''), false)
})

test('pluginConfigFieldId / resolveConfigFieldTitle：字段 id 含插件与字段 key，标题按 locale 解析并回落 key', { timeout: 60_000 }, () => {
  assert.equal(pluginConfigFieldId('builtin:workflow', 'limit'), 'helmx-plugin-config-builtin:workflow-limit')
  const schema = { type: 'string', label: { 'zh-CN': '上限', en: 'Limit' } } as never
  assert.equal(resolveConfigFieldTitle(schema, 'limit', 'zh-CN'), '上限')
  assert.equal(resolveConfigFieldTitle(schema, 'limit', 'en'), 'Limit')
  assert.equal(resolveConfigFieldTitle({ type: 'string' } as never, 'limit', 'en'), 'limit')
})
