import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PluginConfigFieldSchema, Profile } from '@helmx/protocol'
import {
  buildPluginConfigPayload,
  configFieldInitialValue,
  secretConfigured,
} from '../src/modals/plugin-config-form-model.js'
import {
  argsTextToArgs,
  argsToText,
  buildProfileSavePayload,
  normalizeRuntime,
} from '../src/profiles/profile-center-model.js'

// ---------------------------------------------------------------------------
// Plugin config form: the secret mask must never overwrite the real key
// ---------------------------------------------------------------------------

const SECRET_SCHEMA: Record<string, PluginConfigFieldSchema> = {
  apiKey: { type: 'string', secret: true, required: true, label: 'API Key' },
  baseUrl: { type: 'string', default: 'https://api.example.com' },
  retries: { type: 'number', default: 3 },
  verbose: { type: 'boolean', default: false },
}

test('secret field initial values are always the empty string: the server mask ****** never pours into the form', { timeout: 60_000 }, () => {
  // GET config returns '******' for a configured secret (see the kernel redactConfigValues)
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.apiKey!, '******'), '')
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.apiKey!, ''), '')
  assert.equal(configFieldInitialValue({ type: 'string', secret: true }, '真实密钥也不会回显'), '') // real keys never echo back either (zh fixture)
  assert.equal(configFieldInitialValue({ type: 'string', secret: true, default: 'secret-default' }, undefined), '')
})

test('non-secret field initial values echo the server value or the schema default', { timeout: 60_000 }, () => {
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.baseUrl!, 'https://override.example.com'), 'https://override.example.com')
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.baseUrl!, undefined), 'https://api.example.com')
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.retries!, 7), 7)
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.retries!, undefined), 3)
  assert.equal(configFieldInitialValue(SECRET_SCHEMA.verbose!, true), true)
  assert.equal(configFieldInitialValue({ type: 'boolean' }, undefined), false)
  assert.equal(configFieldInitialValue({ type: 'number' }, undefined), 0)
  assert.equal(configFieldInitialValue({ type: 'string' }, undefined), '')
})

test('unchanged secrets are omitted from the save payload: neither six asterisks nor empty strings enter the payload', { timeout: 60_000 }, () => {
  // The user opens the form (secret starts empty) and saves without touching any secret
  const values = {
    apiKey: '', // secret unchanged
    baseUrl: 'https://override.example.com',
    retries: 3,
    verbose: true,
  }
  const payload = buildPluginConfigPayload(SECRET_SCHEMA, values)
  assert.equal('apiKey' in payload, false, 'unchanged secrets must be omitted so the server keeps the stored key')
  assert.deepEqual(payload, { baseUrl: 'https://override.example.com', retries: 3, verbose: true })
})

test('modified secrets enter the save payload with the new value; whitespace-only input counts as unchanged', { timeout: 60_000 }, () => {
  const payload = buildPluginConfigPayload(SECRET_SCHEMA, {
    apiKey: 'sk-new-value',
    baseUrl: 'https://api.example.com',
    retries: 3,
    verbose: false,
  })
  assert.equal(payload.apiKey, 'sk-new-value')

  const blank = buildPluginConfigPayload(SECRET_SCHEMA, {
    apiKey: '   ',
    baseUrl: 'https://api.example.com',
    retries: 3,
    verbose: false,
  })
  assert.equal('apiKey' in blank, false, 'whitespace-only input counts as unchanged')
})

test('the mask itself is never submitted as a new key', { timeout: 60_000 }, () => {
  // Even if an abnormal path poured the mask into the form values, payload construction must drop it
  const payload = buildPluginConfigPayload(SECRET_SCHEMA, {
    apiKey: '******',
    baseUrl: 'x',
    retries: 1,
    verbose: false,
  })
  assert.equal('apiKey' in payload, false)
})

test('secretConfigured decides the placeholder hint purely from the raw server value', { timeout: 60_000 }, () => {
  assert.equal(secretConfigured('******'), true)
  assert.equal(secretConfigured(''), false)
  assert.equal(secretConfigured(undefined), false)
  assert.equal(secretConfigured(123), false)
})

// ---------------------------------------------------------------------------
// ProfileDetailDrawer：PUT 整体替换语义的完整基础配置 + system 按需提交
//（真实链路：profile-routes.ts PUT /profiles/:id → profiles.save → 整体重写 profile.json；
//  省 system 表示不动 SYSTEM.md；MEMORY.md 由 builtin:memory 自治，见 profile-binding 组合测试）
// ---------------------------------------------------------------------------

function baseProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: 'coder',
    name: '代码工人',
    model: 'zhipu/glm-4.6',
    nodeId: 'gpu-node',
    cwd: '/srv/work',
    tags: ['worker'],
    runtime: { kind: 'herdr', agent: 'agy', nodeId: 'ops-box', workspace: '/srv/herdr' },
    system: '# SYSTEM\n基础提示词',
    ...overrides,
  }
}

function payloadFromProfile(
  profile: Profile,
  overrides: Partial<Parameters<typeof buildProfileSavePayload>[0]> = {},
) {
  return buildProfileSavePayload({
    id: profile.id,
    name: profile.name,
    model: profile.model,
    thinkingLevel: profile.thinkingLevel,
    nodeId: profile.nodeId,
    cwd: profile.cwd,
    restrictToCwd: profile.restrictToCwd,
    system: profile.system,
    skills: profile.skills,
    runtime: profile.runtime,
    source: profile,
    isNew: false,
    ...overrides,
  })
}

test('仅改展示名：载荷仍携带完整基础配置，不丢节点/目录/运行时；system 省略', { timeout: 60_000 }, () => {
  const payload = payloadFromProfile(baseProfile(), { name: '重构工人' })
  assert.equal(payload.name, '重构工人')
  assert.equal(payload.model, 'zhipu/glm-4.6', 'PUT 整体替换：未改的 model 必须随载荷保留')
  assert.equal(payload.nodeId, 'gpu-node', '只改名不丢执行节点')
  assert.equal(payload.cwd, '/srv/work', '只改名不丢工作目录')
  assert.deepEqual(payload.tags, ['worker'])
  assert.deepEqual(payload.runtime, { kind: 'herdr', agent: 'agy', nodeId: 'ops-box', workspace: '/srv/herdr' }, '只改名不丢外部运行时')
  assert.equal('system' in payload, false, '未编辑 system 时必须省略')
})

test('未做任何修改：载荷为完整规范化基础配置', { timeout: 60_000 }, () => {
  const payload = payloadFromProfile(baseProfile())
  assert.deepEqual(payload, {
    id: 'coder',
    name: '代码工人',
    model: 'zhipu/glm-4.6',
    nodeId: 'gpu-node',
    cwd: '/srv/work',
    tags: ['worker'],
    runtime: { kind: 'herdr', agent: 'agy', nodeId: 'ops-box', workspace: '/srv/herdr' },
  })
})

test('基线无可选字段：载荷仍提交骨架（tags 空数组），不携带 undefined 键', { timeout: 60_000 }, () => {
  const payload = payloadFromProfile({ id: 'bare', tags: undefined })
  assert.deepEqual(payload, { id: 'bare', tags: [] })
  assert.equal('nodeId' in payload, false)
  assert.equal('cwd' in payload, false)
  assert.equal('runtime' in payload, false)
  assert.equal('system' in payload, false)
  assert.equal('memory' in payload, false)
})

test('载荷永不携带 memory 且不泄漏 UI 扩展字段', { timeout: 60_000 }, () => {
  const enriched = baseProfile({ description: 'ui desc', defaultModel: 'zhipu/glm-4.6', isSystem: false })
  const payload = payloadFromProfile(enriched)
  assert.equal('memory' in payload, false)
  assert.equal('description' in payload, false)
  assert.equal('defaultModel' in payload, false)
  assert.equal('isSystem' in payload, false)
  const payload2 = payloadFromProfile(enriched, { system: '# SYSTEM\n新提示词', includeSystem: true })
  assert.equal(payload2.system, '# SYSTEM\n新提示词')
  assert.equal('memory' in payload2, false)
})

test('新建 Profile：提交完整基础配置 + 当前 system 全文', { timeout: 60_000 }, () => {
  const payload = payloadFromProfile(
    { ...baseProfile(), id: 'reviewer', system: '# 新提示词' },
    { isNew: true, source: null },
  )
  assert.equal(payload.id, 'reviewer')
  assert.equal(payload.name, '代码工人')
  assert.equal(payload.model, 'zhipu/glm-4.6')
  assert.equal(payload.nodeId, 'gpu-node')
  assert.equal(payload.cwd, '/srv/work')
  assert.equal('tags' in payload, false)
  assert.deepEqual(payload.runtime, { kind: 'herdr', agent: 'agy', nodeId: 'ops-box', workspace: '/srv/herdr' })
  assert.equal(payload.system, '# 新提示词')
  assert.equal('memory' in payload, false)
})

// ---------------------------------------------------------------------------
// runtime.args：每行一个参数，带空格参数保真
// ---------------------------------------------------------------------------

test('argsTextToArgs 每行一个参数且保留参数内部空格', { timeout: 60_000 }, () => {
  assert.deepEqual(argsTextToArgs('--model\nglm-4.6'), ['--model', 'glm-4.6'])
  assert.deepEqual(argsTextToArgs('--title\n周报 草稿 v2'), ['--title', '周报 草稿 v2'])
  assert.deepEqual(argsTextToArgs('  --trim  \n\n  --keep inner  \n'), ['--trim', '--keep inner'])
  assert.deepEqual(argsTextToArgs(''), [])
})

test('argsToText 与 argsTextToArgs 往返保真（不按空格拆分）', { timeout: 60_000 }, () => {
  const args = ['--prompt', 'fix the bug now', '--title', '周报 草稿']
  assert.deepEqual(argsTextToArgs(argsToText(args)), args)
})

test('normalizeRuntime：空 nodeId/workspace/env/args 省略，参数仅 trim 边界', { timeout: 60_000 }, () => {
  const normalized = normalizeRuntime({
    kind: 'herdr',
    agent: 'agy',
    nodeId: '   ',
    workspace: '',
    args: ['  --keep inner  ', ''],
    env: { EMPTY_KEY: '' },
  })
  assert.deepEqual(normalized, { kind: 'herdr', agent: 'agy', args: ['--keep inner'], env: { EMPTY_KEY: '' } })
  assert.equal('nodeId' in normalized, false)
  assert.equal('workspace' in normalized, false)
})

test('normalizeRuntime：runtime 整体可被清空（关闭 Herdr 运行时）', { timeout: 60_000 }, () => {
  assert.equal(normalizeRuntime(undefined), undefined)
})

test('runtime 随载荷完整规范化提交；关闭（undefined）时才省略', { timeout: 60_000 }, () => {
  const base = baseProfile({ runtime: { kind: 'herdr', agent: 'agy', nodeId: '  ' } })
  // 未修改的 runtime 也随完整载荷提交（规范化后空白 nodeId 省略）。
  const unchanged = payloadFromProfile(base)
  assert.deepEqual(unchanged.runtime, { kind: 'herdr', agent: 'agy' })

  const payload = payloadFromProfile(base, {
    runtime: { kind: 'herdr', agent: 'agy', nodeId: '  ', args: ['--title', '周报 草稿'] },
  })
  assert.deepEqual(payload.runtime, { kind: 'herdr', agent: 'agy', args: ['--title', '周报 草稿'] })
})

test('关闭外部运行时：载荷省略 runtime 键，整体替换即删除', { timeout: 60_000 }, () => {
  const payload = payloadFromProfile(baseProfile(), { runtime: undefined })
  assert.equal('runtime' in payload, false)
  assert.equal(payload.nodeId, 'gpu-node', '关闭 runtime 不影响顶层执行节点')
})

// ---------------------------------------------------------------------------
// Profile 顶层 nodeId / cwd（普通会话执行默认节点与工作目录，与 runtime.nodeId 不同层级）
// ---------------------------------------------------------------------------

test('顶层 nodeId / cwd 修改进入载荷；清空归一为省略（删除覆盖，回退 local）', { timeout: 60_000 }, () => {
  const base = baseProfile()
  const payload = payloadFromProfile(base, { nodeId: 'gpu-node-2', cwd: '/srv/work2' })
  assert.equal(payload.nodeId, 'gpu-node-2')
  assert.equal(payload.cwd, '/srv/work2')
  assert.equal(payload.model, 'zhipu/glm-4.6')

  // 清空（空白归一为省略）：整体替换语义下删除覆盖，节点回退本机 local。
  const blankPayload = payloadFromProfile(base, { nodeId: '  ', cwd: '' })
  assert.equal('nodeId' in blankPayload, false, '清空 nodeId 即从 profile.json 删除该键')
  assert.equal('cwd' in blankPayload, false, '清空 cwd 即从 profile.json 删除该键')
  assert.equal(blankPayload.name, '代码工人', '清空节点不影响其他字段')
})

// ---------------------------------------------------------------------------
// tags：普通标签编辑，不涉及生命周期语义
// ---------------------------------------------------------------------------

test('tags 修改随完整载荷提交；清空时提交空数组（整体替换语义可清空）', { timeout: 60_000 }, () => {
  const base = baseProfile()
  const payload = payloadFromProfile(base, { tags: ['worker', 'coder'] })
  assert.deepEqual(payload.tags, ['worker', 'coder'])

  const clearedPayload = payloadFromProfile(base, { tags: [] })
  assert.deepEqual(clearedPayload.tags, [], 'PUT 整体替换：空数组即从磁盘清空 tags')
  assert.equal(clearedPayload.name, '代码工人')
})

test('model 清空与修改：trim 后空串归一为省略（删除覆盖，回退默认模型）', { timeout: 60_000 }, () => {
  const base = baseProfile({ model: 'zhipu/glm-4.6' })
  const cleared = payloadFromProfile(base, { model: '  ' })
  assert.equal('model' in cleared, false)

  const changed = payloadFromProfile(base, { model: 'zhipu/glm-5' })
  assert.equal(changed.model, 'zhipu/glm-5')
})

test('载荷永不携带未编辑的 system 大文本快照（防 Object.assign 泄漏）', { timeout: 60_000 }, () => {
  const base = baseProfile()
  const payload = payloadFromProfile(base)
  assert.equal('system' in payload, false)
  // 编辑其他字段也不会把大文本带出。
  const editedPayload = payloadFromProfile(base, { name: '重构工人' })
  assert.equal('system' in editedPayload, false)
})
