import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parseScreenTargetQuery } from '../src/lib/types.js'
import {
  formatLocationHash,
  hashHasPrimaryTarget,
  isSameLocationState,
  parseLocationHash,
  serializeHash,
  shouldPushLocationHistory,
  type WorkspaceLocationState,
} from '../src/lib/url-hash-model.js'
import { isSameResolvedTarget, resolveTargetString } from '../src/lib/types.js'

const conversation = (conversationId: number): WorkspaceLocationState => ({
  primaryTarget: { kind: 'conversation', conversationId },
  splitTarget: null,
  drawerStack: [],
  activeModal: null,
})

const roundtrip = (state: WorkspaceLocationState): WorkspaceLocationState =>
  parseLocationHash(formatLocationHash(state))

// ---------------------------------------------------------------------------
// parseLocationHash：主屏、分屏、工作台与弹窗
// ---------------------------------------------------------------------------

test('parse: 会话主屏（#/c/<id>）与空 Hash 默认角色中心', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/c/42')
  assert.deepEqual(parsed.primaryTarget, { kind: 'conversation', conversationId: 42 })
  assert.equal(parsed.splitTarget, null)
  assert.deepEqual(parsed.drawerStack, [])
  assert.equal(parsed.activeModal, null)
  // "" / "#" / "#/" 均解析为默认角色中心（无会话依赖，零会话可用）
  for (const raw of ['', '#', '#/']) {
    const empty = parseLocationHash(raw)
    assert.deepEqual(empty.primaryTarget, { kind: 'profiles' })
    assert.equal(empty.splitTarget, null)
    assert.deepEqual(empty.drawerStack, [])
    assert.equal(empty.activeModal, null)
  }
})

test('parse: 插件全屏视图（#/views/<pluginId>/<screenId>，pluginId 含冒号保持可读）', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/views/builtin:herdr/overview')
  assert.deepEqual(parsed.primaryTarget, { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' })
  // 百分号编码形式同样可解析（与 resolveTargetString 的 lastIndexOf 切分语义一致）
  const encoded = parseLocationHash('#/views/builtin%3Aherdr/overview')
  assert.deepEqual(encoded.primaryTarget, { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' })
})

test('parse: 分屏参数 split（会话与插件视图、编码形式）', { timeout: 60_000 }, () => {
  const convSplit = parseLocationHash('#/c/1?split=c/42')
  assert.deepEqual(convSplit.splitTarget, { kind: 'conversation', conversationId: 42 })
  const screenSplit = parseLocationHash('#/c/1?split=views/builtin:herdr/overview')
  assert.deepEqual(screenSplit.splitTarget, { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' })
  const encodedSplit = parseLocationHash('#/c/1?split=views%2Fbuiltin%3Aherdr%2Foverview')
  assert.deepEqual(encodedSplit.splitTarget, { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' })
})

test('parse: 模型中心全局默认 Tab（#/settings/models/defaults）与组合子路径', { timeout: 60_000 }, () => {
  // defaults 是保留段：直达全局默认 Tab
  assert.deepEqual(parseLocationHash('#/settings/models/defaults').primaryTarget, {
    kind: 'models',
    tab: 'defaults',
  })
  // providerId 子段：供应商抽屉深链
  assert.deepEqual(parseLocationHash('#/settings/models/anthropic').primaryTarget, {
    kind: 'models',
    providerId: 'anthropic',
  })
  // 抽屉 + Tab 组合（分屏打开供应商时保留当前 Tab）
  assert.deepEqual(parseLocationHash('#/settings/models/anthropic/defaults').primaryTarget, {
    kind: 'models',
    providerId: 'anthropic',
    tab: 'defaults',
  })
  // defaults 保留段之后不允许再挂段；非 defaults 尾段判非法
  assert.deepEqual(parseLocationHash('#/settings/models/defaults/x').primaryTarget, { kind: 'profiles' })
  assert.deepEqual(parseLocationHash('#/settings/models/anthropic/providers').primaryTarget, { kind: 'profiles' })
  // 分屏目标同样使用路径段
  const split = parseLocationHash('#/c/1?split=settings%2Fmodels%2Fdefaults')
  assert.deepEqual(split.splitTarget, { kind: 'models', tab: 'defaults' })
})

test('format: 模型中心路径段序列化与往返无损；providers 缺省 Tab 不序列化', { timeout: 60_000 }, () => {
  assert.equal(
    formatLocationHash({ ...conversation(1), primaryTarget: { kind: 'models', tab: 'defaults' } }),
    '#/settings/models/defaults',
  )
  assert.equal(
    formatLocationHash({ ...conversation(1), primaryTarget: { kind: 'models', tab: 'providers' } }),
    '#/settings/models',
  )
  // providerId 抽屉与组合
  assert.equal(
    formatLocationHash({ ...conversation(1), primaryTarget: { kind: 'models', providerId: 'anthropic' } }),
    '#/settings/models/anthropic',
  )
  assert.equal(
    formatLocationHash({
      ...conversation(1),
      primaryTarget: { kind: 'models', providerId: 'anthropic', tab: 'defaults' },
    }),
    '#/settings/models/anthropic/defaults',
  )
  // 往返无损
  const state: WorkspaceLocationState = {
    ...conversation(1),
    primaryTarget: { kind: 'models', providerId: 'anthropic', tab: 'defaults' },
  }
  assert.deepEqual(roundtrip(state), state)
  // tab 差异参与位置比较；同中心切 Tab 不入历史栈（replace）
  const providersState: WorkspaceLocationState = { ...conversation(1), primaryTarget: { kind: 'models' } }
  const defaultsState: WorkspaceLocationState = {
    ...conversation(1),
    primaryTarget: { kind: 'models', tab: 'defaults' },
  }
  assert.equal(isSameLocationState(providersState, defaultsState), false)
  assert.equal(shouldPushLocationHistory(providersState, defaultsState), false)
  assert.equal(shouldPushLocationHistory(defaultsState, providersState), false)
})

test('parse: 抽屉栈参数 drawer（工作台、绑定会话工作台、多层子会话、非法项丢弃与深度截断）', { timeout: 60_000 }, () => {
  const wbOnly = parseLocationHash('#/c/1?drawer=wb/artifacts')
  assert.deepEqual(wbOnly.drawerStack, [{ kind: 'workbench', tab: 'artifacts' }])

  const closed = parseLocationHash('#/c/1')
  assert.deepEqual(closed.drawerStack, [])

  const multiLayer = parseLocationHash(
    '#/c/10?drawer=wb%2Fplugin%3Abuiltin%3Aswarm%2Fgroups&drawer=c%2F67&drawer=wb%4067%2Fartifacts&drawer=c%2F89',
  )
  assert.deepEqual(multiLayer.drawerStack, [
    { kind: 'workbench', tab: 'plugin:builtin:swarm/groups' },
    { kind: 'conversation', conversationId: 67 },
    { kind: 'workbench', conversationId: 67, tab: 'artifacts' },
    { kind: 'conversation', conversationId: 89 },
  ])

  // 非法项静默丢弃；重复帧截断去重；超过 5 层丢弃最底层
  const dirtyAndDeep = parseLocationHash(
    '#/c/1?drawer=bad&drawer=c/0&drawer=wb/&drawer=wb@abc/x&drawer=c/10&drawer=c/11&drawer=c/12&drawer=c/13&drawer=c/14&drawer=c/15',
  )
  assert.deepEqual(dirtyAndDeep.drawerStack, [
    { kind: 'conversation', conversationId: 11 },
    { kind: 'conversation', conversationId: 12 },
    { kind: 'conversation', conversationId: 13 },
    { kind: 'conversation', conversationId: 14 },
    { kind: 'conversation', conversationId: 15 },
  ])

  const dedup = parseLocationHash('#/c/1?drawer=wb/artifacts&drawer=c/11&drawer=c/22&drawer=c/11')
  assert.deepEqual(dedup.drawerStack, [
    { kind: 'workbench', tab: 'artifacts' },
    { kind: 'conversation', conversationId: 11 },
  ])
})

test('parse: 现役弹窗还原子项 ID，旧列表与旧 drawer modal key 静默忽略为 null', { timeout: 60_000 }, () => {
  // 开发阶段不兼容：legacy modal key 解析结果为无 modal，无迁移提示。
  for (const legacyKey of ['profiles', 'providers', 'skills', 'plugins', 'nodes', 'drawer']) {
    assert.equal(parseLocationHash(`#/c/1?modal=${legacyKey}`).activeModal, null, legacyKey)
    assert.equal(parseLocationHash(`#/c/1?modal=${legacyKey}&id=42`).activeModal, null, legacyKey)
  }
  assert.deepEqual(parseLocationHash('#/c/1?modal=artifact&id=art-123&conv=42').activeModal, {
    kind: 'artifact-preview',
    artifactId: 'art-123',
    conversationId: 42,
  })
})

// ---------------------------------------------------------------------------
// formatLocationHash：规范形式与往返
// ---------------------------------------------------------------------------

test('format: 会话目标输出规范 #/c/<id>', { timeout: 60_000 }, () => {
  assert.equal(formatLocationHash(conversation(1)), '#/c/1')
})

test('format: command-palette 与 shortcuts 是瞬态弹窗，不序列化进 URL', { timeout: 60_000 }, () => {
  const paletteState: WorkspaceLocationState = { ...conversation(1), activeModal: { kind: 'command-palette' } }
  assert.equal(formatLocationHash(paletteState), '#/c/1')

  const shortcutsState: WorkspaceLocationState = { ...conversation(1), activeModal: { kind: 'shortcuts' } }
  assert.equal(formatLocationHash(shortcutsState), '#/c/1')
  assert.equal(parseLocationHash('#/c/1?modal=shortcuts').activeModal, null)
  assert.equal(isSameLocationState(conversation(1), shortcutsState), true)
  assert.equal(shouldPushLocationHistory(conversation(1), shortcutsState), false)
  assert.equal(shouldPushLocationHistory(shortcutsState, conversation(1)), false)
})

test('format: 组合状态（视图主屏 + 会话分屏 + 多层抽屉栈 + 弹窗子项，URLSearchParams 规范编码）', { timeout: 60_000 }, () => {
  const state: WorkspaceLocationState = {
    primaryTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
    splitTarget: { kind: 'conversation', conversationId: 42 },
    drawerStack: [
      { kind: 'workbench', tab: 'plugin:builtin:herdr/panel-x' },
      { kind: 'conversation', conversationId: 11 },
    ],
    activeModal: { kind: 'artifact-preview', artifactId: 'art-1', conversationId: 42 },
  }
  const hash = formatLocationHash(state)
  const query = new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
  assert.equal(query.get('split'), 'c/42')
  assert.deepEqual(query.getAll('drawer'), ['wb/plugin:builtin:herdr/panel-x', 'c/11'])
  assert.equal(query.get('modal'), 'artifact')
  assert.equal(query.get('id'), 'art-1')
  assert.equal(query.get('conv'), '42')
  assert.deepEqual(roundtrip(state), state)
})

test('roundtrip: 全部位置形态双向往返无损', { timeout: 60_000 }, () => {
  const states: WorkspaceLocationState[] = [
    conversation(1),
    conversation(777),
    {
      primaryTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
      splitTarget: { kind: 'screen', pluginId: 'builtin:superagent', screenId: 'router' },
      drawerStack: [],
      activeModal: null,
    },
    { ...conversation(1), splitTarget: { kind: 'conversation', conversationId: 42 } },
    { ...conversation(1), splitTarget: { kind: 'plugins', pluginId: 'builtin:herdr' } },
    { ...conversation(1), primaryTarget: { kind: 'profiles', profileId: 'watchdog' } },
    { ...conversation(1), primaryTarget: { kind: 'models', providerId: 'anthropic', tab: 'defaults' } },
    { ...conversation(1), drawerStack: [{ kind: 'workbench', tab: 'artifacts' }] },
    {
      ...conversation(1),
      drawerStack: [
        { kind: 'workbench', tab: 'plugin:builtin:swarm/groups' },
        { kind: 'conversation', conversationId: 11 },
        { kind: 'workbench', conversationId: 11, tab: 'artifacts' },
      ],
    },
    { ...conversation(1), activeModal: { kind: 'artifact-preview', artifactId: 'art-9' } },
    { ...conversation(1), activeModal: { kind: 'artifact-preview', artifactId: 'art-9', conversationId: 42 } },
    { ...conversation(1), activeModal: { kind: 'workspace-file', conversationId: 1, path: 'README.md', startLine: 3, endLine: 5 } },
    {
      ...conversation(1),
      drawerStack: [{ kind: 'conversation', conversationId: 11 }],
      activeModal: { kind: 'workspace-file', conversationId: 11, path: 'src/app.ts', startLine: 10 },
    },
  ]
  for (const state of states) {
    const back = roundtrip(state)
    assert.equal(isSameLocationState(back, state), true, `roundtrip failed: ${JSON.stringify(state)}`)
  }
})

// ---------------------------------------------------------------------------
// 边界防御：非法 / 脏 Hash 输入
// ---------------------------------------------------------------------------

test('parse: 非法主屏路径回退默认角色中心（无 NaN / 空段 / 多余层级）', { timeout: 60_000 }, () => {
  for (const raw of [
    '#/c/abc', '#/c/0', '#/c/-5', '#/c/1.5', '#/c/ 1', '#/c/9999999999999999999999',
    '#/unknown',
    '#/views/onlyone', '#/views//x', '#/views/x/', '#/views/a/b/c',
    '#/settings', '#/settings/', '#/settings/unknown', '#/settings//profiles',
    '#/settings/profiles/a/b', '#/settings/profiles/%E0%A4%A',
  ]) {
    const parsed = parseLocationHash(raw)
    assert.deepEqual(parsed.primaryTarget, { kind: 'profiles' }, raw)
  }
})

test('parse: 非法分屏值忽略为 null', { timeout: 60_000 }, () => {
  for (const raw of ['#/c/1?split=bad', '#/c/1?split=', '#/c/1?split=c/0', '#/c/1?split=c/abc', '#/c/1?split=views/only-plugin', '#/c/1?split=x/1', '#/c/1?split=settings/profiles/a/b', '#/c/1?split=settings/profiles/']) {
    assert.equal(parseLocationHash(raw).splitTarget, null, raw)
  }
})

test('parse: 未知 modal 值与 artifact 缺 id 均丢弃为 null', { timeout: 60_000 }, () => {
  assert.equal(parseLocationHash('#/c/1?modal=unknown').activeModal, null)
  assert.equal(parseLocationHash('#/c/1?modal=command-palette').activeModal, null)
  assert.equal(parseLocationHash('#/c/1?modal=artifact').activeModal, null)
  assert.equal(parseLocationHash('#/c/1?modal=artifact&id=').activeModal, null)
  // artifact 携带非法 conv（非正整数）时保留弹窗但丢弃 conversationId
  const badConv = parseLocationHash('#/c/1?modal=artifact&id=a1&conv=abc')
  assert.deepEqual(badConv.activeModal, { kind: 'artifact-preview', artifactId: 'a1' })
})

test('parse: 非法百分号序列不抛出（decode 失败按无效段回退默认）', { timeout: 60_000 }, () => {
  assert.deepEqual(parseLocationHash('#/views/%E0%A4%A/x').primaryTarget, { kind: 'profiles' })
  assert.deepEqual(parseLocationHash('#/settings/skills/%E0%A4%A').primaryTarget, { kind: 'profiles' })
})

// ---------------------------------------------------------------------------
// 设置中心层级路径、旧路径回退与 sidebar 参数移除（开发阶段不保留兼容层）
// ---------------------------------------------------------------------------

test('parse/format: 设置中心层级路径（子项路径段 + 分段编码，往返无损）', { timeout: 60_000 }, () => {
  assert.deepEqual(parseLocationHash('#/settings/profiles').primaryTarget, { kind: 'profiles' })
  assert.deepEqual(parseLocationHash('#/settings/profiles/watchdog').primaryTarget, { kind: 'profiles', profileId: 'watchdog' })
  assert.deepEqual(parseLocationHash('#/settings/skills/git-commit').primaryTarget, { kind: 'skills', skillId: 'git-commit' })
  assert.deepEqual(parseLocationHash('#/settings/nodes/gpu-server').primaryTarget, { kind: 'nodes', nodeId: 'gpu-server' })
  assert.deepEqual(parseLocationHash('#/settings/plugins/builtin:herdr').primaryTarget, { kind: 'plugins', pluginId: 'builtin:herdr' })
  // 子项含斜杠/空格/中文：分段编码后不破坏层级，往返无损
  for (const id of ['team/alpha', 'hello world', '中文', 'builtin:herdr']) {
    const state: WorkspaceLocationState = { ...conversation(1), primaryTarget: { kind: 'profiles', profileId: id } }
    assert.deepEqual(roundtrip(state), state, id)
  }
  // 百分号编码形式同样可解析（冒号保持可读）
  assert.deepEqual(parseLocationHash('#/settings/plugins/builtin%3Aherdr').primaryTarget, { kind: 'plugins', pluginId: 'builtin:herdr' })
  assert.deepEqual(parseLocationHash('#/settings/profiles/team%2Falpha').primaryTarget, { kind: 'profiles', profileId: 'team/alpha' })
  // serializeHash 直接收中心目标
  assert.equal(serializeHash({ kind: 'skills' }), '#/settings/skills')
  assert.equal(serializeHash({ kind: 'plugins', pluginId: 'builtin:herdr' }), '#/settings/plugins/builtin:herdr')
  assert.equal(serializeHash({ kind: 'profiles', profileId: 'watchdog' }), '#/settings/profiles/watchdog')
})

test('parse: 旧路径与旧查询参数一律回退默认（不保留兼容层）', { timeout: 60_000 }, () => {
  for (const raw of [
    '#/profiles', '#/profiles?id=watchdog',
    '#/models', '#/models?tab=defaults', '#/models?id=anthropic',
    '#/skills?id=git-commit', '#/nodes', '#/plugins?p=builtin:herdr',
    '#/providers',
    '#/s/builtin:herdr/overview', '#/s/p/main',
  ]) {
    assert.deepEqual(parseLocationHash(raw).primaryTarget, { kind: 'profiles' }, raw)
  }
  // split 内旧 id/p/tab 查询与旧路径同样失效（子项走路径段）
  assert.equal(parseLocationHash('#/c/1?split=profiles%3Fid%3Dwatchdog').splitTarget, null)
  assert.equal(parseLocationHash('#/c/1?split=plugins%3Fp%3Dbuiltin%3Aherdr').splitTarget, null)
  assert.equal(parseLocationHash('#/c/1?split=s%2Fp%2Fmain').splitTarget, null)
  // split 内 settings 层级子项正常解析
  assert.deepEqual(parseLocationHash('#/c/1?split=settings%2Fplugins%2Fbuiltin%3Aherdr').splitTarget, {
    kind: 'plugins', pluginId: 'builtin:herdr',
  })
})

test('parse/format: sidebar 参数不再属于位置契约（解析忽略、序列化丢弃）', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/c/5?sidebar=settings')
  assert.deepEqual(parsed.primaryTarget, { kind: 'conversation', conversationId: 5 })
  assert.equal((parsed as unknown as Record<string, unknown>).sidebarSpace, undefined)
  // 整体往返后 sidebar 参数消失
  assert.equal(formatLocationHash(parseLocationHash('#/c/5?sidebar=settings')), '#/c/5')
  assert.equal(
    formatLocationHash(parseLocationHash('#/views/p/main?sidebar=settings&drawer=wb/artifacts')),
    '#/views/p/main?drawer=wb%2Fartifacts',
  )
})

// ---------------------------------------------------------------------------
// isSameLocationState 与 shouldPushLocationHistory
// ---------------------------------------------------------------------------

test('isSameLocationState: 四字段逐一比较；command-palette 等价于 null', { timeout: 60_000 }, () => {
  const base = conversation(1)
  assert.equal(isSameLocationState(base, conversation(1)), true)
  assert.equal(isSameLocationState(base, conversation(2)), false)
  assert.equal(isSameLocationState(base, { ...base, splitTarget: { kind: 'conversation', conversationId: 1 } }), false)
  assert.equal(isSameLocationState(base, { ...base, drawerStack: [{ kind: 'workbench', tab: 'artifacts' }] }), false)
  const openA = { ...base, drawerStack: [{ kind: 'workbench' as const, tab: 'artifacts' }] }
  const openB = { ...base, drawerStack: [{ kind: 'workbench' as const, tab: 'plugin:example/queue' }] }
  assert.equal(isSameLocationState(openA, openB), false)
  assert.equal(isSameLocationState(base, { ...base, activeModal: { kind: 'command-palette' } }), true)
  assert.equal(isSameLocationState(base, { ...base, drawerStack: [{ kind: 'conversation', conversationId: 1 }] }), false)
  assert.equal(
    isSameLocationState(
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a1' } },
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a2' } },
    ),
    false,
  )
})

test('shouldPushLocationHistory: 主屏/分屏/抽屉栈加深/弹窗开关走 push', { timeout: 60_000 }, () => {
  const base = conversation(1)
  const wb = { ...base, drawerStack: [{ kind: 'workbench' as const, tab: 'artifacts' }] }
  const wbAndConv = {
    ...base,
    drawerStack: [
      { kind: 'workbench' as const, tab: 'artifacts' },
      { kind: 'conversation' as const, conversationId: 11 },
    ],
  }
  assert.equal(shouldPushLocationHistory(base, conversation(2)), true)
  assert.equal(shouldPushLocationHistory(base, { ...base, primaryTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' } }), true)
  assert.equal(shouldPushLocationHistory(base, { ...base, splitTarget: { kind: 'conversation', conversationId: 2 } }), true)
  assert.equal(shouldPushLocationHistory(base, wb), true)
  assert.equal(shouldPushLocationHistory(wb, wbAndConv), true, '抽屉压栈走 push，浏览器后退可剥一层')
  // 抽屉退层或关闭走 replace，避免残留死历史项
  assert.equal(shouldPushLocationHistory(wbAndConv, wb), false)
  assert.equal(shouldPushLocationHistory(wbAndConv, base), false)
  // 弹窗打开/关闭与类型切换走 push
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a1' } },
      { ...base, activeModal: { kind: 'workspace-file', conversationId: 1, path: 'README.md' } },
    ),
    true,
  )
  // 产物预览切换不同 artifactId / conversationId 是 push
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a1' } },
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a2' } },
    ),
    true,
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a1', conversationId: 1 } },
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a1', conversationId: 2 } },
    ),
    true,
  )
})

test('shouldPushLocationHistory: 工作台内切 Tab 与等价态走 replace', { timeout: 60_000 }, () => {
  const base = conversation(1)
  assert.equal(
    shouldPushLocationHistory(
      { ...base, drawerStack: [{ kind: 'workbench', tab: 'artifacts' }] },
      { ...base, drawerStack: [{ kind: 'workbench', tab: 'plugin:builtin:herdr/panel-x' }] },
    ),
    false,
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, drawerStack: [{ kind: 'workbench', tab: 'artifacts' }] },
      { ...base, drawerStack: [{ kind: 'workbench', tab: 'artifacts' }] },
    ),
    false,
  )
  // command-palette 是瞬态弹窗，开关不产生历史条目（等价于无弹窗）
  assert.equal(
    shouldPushLocationHistory(base, { ...base, activeModal: { kind: 'command-palette' } }),
    false,
  )
  // 同一 artifact 预览原地不变不产生历史条目
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a1' } },
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a1' } },
    ),
    false,
  )
})

// ---------------------------------------------------------------------------
// 源码契约断言
// ---------------------------------------------------------------------------

const readSource = (relative: string): Promise<string> =>
  readFile(new URL(relative, import.meta.url), 'utf8')

test('契约: HelmxStoreProvider 初始状态取自 Hash、监听外部变更、认证后才写回', { timeout: 60_000 }, async () => {
  const source = await readSource('../src/lib/HelmxStoreProvider.tsx')
  const urlHashModelSource = await readSource('../src/lib/url-hash-model.ts')
  // 初始状态从 window.location.hash 解析（含 SSR 安全守卫；readBootLocation 内
  // 先取 rawHash 再 parseLocationHash，同源产出初始位置与首页落地判定）
  assert.match(source, /useState<StoreBootLocation>\(readBootLocation\)/)
  assert.match(urlHashModelSource, /const rawHash = typeof window !== 'undefined' \? window\.location\.hash : ''/)
  assert.match(urlHashModelSource, /parseLocationHash\(rawHash\)/)
  // Listen for external URL changes (forward/back/manual hash edit)
  assert.match(source, /addEventListener\('hashchange'/)
  assert.match(source, /addEventListener\('popstate'/)
  // Write-back only after authentication: the AuthGate phase must not overwrite
  // a user-pasted deep link with the default state. Anchor on the stable code
  // semantics of the single write-back effect (comment text may be translated;
  // slice ends at the final sync statement covering the full push/replace branches).
  const writeBackStart = source.indexOf('const nextHash = formatLocationHash(locationState)')
  const writeBackEnd = source.indexOf('store.lastSyncedLocation = locationState', source.indexOf('store.lastSyncedLocation = locationState', writeBackStart) + 1)
  const writeBack = source.slice(writeBackStart, writeBackEnd)
  assert.ok(writeBack.length > 0, 'write-back effect must exist with a stable code anchor')
  assert.ok(writeBack.includes('nextHash === window.location.hash'), 'compare against the address bar before writing back')
  assert.ok(writeBack.includes('pushState') && writeBack.includes('replaceState'), '写回须区分 push/replace')
  // setParams push 标记与 openTarget history 选项经唯一写回 effect 消费，组件不直接操作 history
  assert.ok(writeBack.includes('store.pendingHistoryMode'), '显式历史标记须由唯一写回 effect 消费')
  const navActionsSource = await readSource('../src/lib/store/nav-actions.ts')
  assert.ok(!navActionsSource.includes('history.'), 'nav-actions (含 setScreenParams) 不得直接操作浏览器历史')
  // logout 用 replaceState 复位地址栏，不污染历史栈（默认角色中心的规范路径）
  const logoutBody = source.slice(source.indexOf('const logout'), source.indexOf('useEffect', source.indexOf('const logout')))
  assert.match(logoutBody, /replaceState\(null, '', '#\/settings\/profiles'\)/)
  // 诚实性纪律：snapshot 到达时不得静默重置 primaryTarget（仅保留 conversation.deleted 实时事件处理）
  assert.ok(!/applySnapshot[\s\S]{0,400}setPrimaryTarget/.test(source), 'snapshot 处理不得触碰 primaryTarget')
})

// ---------------------------------------------------------------------------
// Screen 路由参数（sp.* / ssp.* 命名空间）
// ---------------------------------------------------------------------------

test('screen params: sp.* 归主屏、ssp.* 归分屏，同一 screen 双开参数互不串扰', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/views/builtin:workflow/runs?sp.runId=wf_1&split=views/builtin:herdr/overview&ssp.node=local&ssp.status=blocked')
  assert.deepEqual(parsed.primaryTarget, {
    kind: 'screen', pluginId: 'builtin:workflow', screenId: 'runs', params: { runId: 'wf_1' },
  })
  assert.deepEqual(parsed.splitTarget, {
    kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview', params: { node: 'local', status: 'blocked' },
  })
  // 同一 screen 双开：两套命名空间各自编码，往返无损
  const state: WorkspaceLocationState = {
    primaryTarget: { kind: 'screen', pluginId: 'p', screenId: 'main', params: { tab: 'a', filter: 'x' } },
    splitTarget: { kind: 'screen', pluginId: 'p', screenId: 'main', params: { tab: 'b' } },
    drawerStack: [],
    activeModal: null,
  }
  assert.deepEqual(roundtrip(state), state)
})

test('screen params: 无参数时目标形状保持无 params 字段；切回会话自动丢弃命名空间参数', { timeout: 60_000 }, () => {
  assert.deepEqual(parseLocationHash('#/views/p/main').primaryTarget, { kind: 'screen', pluginId: 'p', screenId: 'main' })
  // 主屏切回 c/<id>：sp.* 无处可挂，自然丢弃；ssp.* 仍属分屏保留
  const parsed = parseLocationHash('#/c/1?sp.k=v&split=views/p/main&ssp.k2=v2')
  assert.deepEqual(parsed.primaryTarget, { kind: 'conversation', conversationId: 1 })
  assert.deepEqual(parsed.splitTarget, { kind: 'screen', pluginId: 'p', screenId: 'main', params: { k2: 'v2' } })
  // 关闭分屏后 format 不再输出 ssp.*（状态里已无分屏目标）
  const closed: WorkspaceLocationState = { ...parsed, splitTarget: null }
  assert.equal(formatLocationHash(closed), '#/c/1')
})

test('screen params: 字典序稳定序列化，与其它查询参数共存', { timeout: 60_000 }, () => {
  const state: WorkspaceLocationState = {
    primaryTarget: { kind: 'screen', pluginId: 'p', screenId: 'main', params: { zeta: '1', alpha: '2', mid: '3' } },
    splitTarget: null,
    drawerStack: [{ kind: 'workbench', tab: 'tasks' }],
    activeModal: null,
  }
  assert.equal(formatLocationHash(state), '#/views/p/main?sp.alpha=2&sp.mid=3&sp.zeta=1&drawer=wb%2Ftasks')
})

test('screen params: 非法键 / 空值 / 非法编码 / 未知前缀全部丢弃，不产生半损参数', { timeout: 60_000 }, () => {
  // 键不匹配 ^[A-Za-z0-9._-]+$（含空格、%、中文、括号）或空键：丢弃
  for (const raw of [
    '#/views/p/main?sp.=v',
    '#/views/p/main?sp.a%20b=v',
    '#/views/p/main?sp.a%28b%29=v',
    '#/views/p/main?sp.%E4%B8%AD=v',
    '#/views/p/main?sp.a=',
    '#/views/p/main?sp.%E0%A4%A=v',
  ]) {
    assert.deepEqual(parseLocationHash(raw).primaryTarget, { kind: 'screen', pluginId: 'p', screenId: 'main' }, raw)
  }
  // 原型键不挂上对象
  const proto = parseLocationHash('#/views/p/main?sp.__proto__=x&sp.constructor=y')
  assert.equal((proto.primaryTarget as { params?: Record<string, string> }).params, undefined)
  // 值里的特殊字符经 URLSearchParams 编码往返无损（空格、&、=、?、#）
  const weird = parseLocationHash(formatLocationHash({
    primaryTarget: { kind: 'screen', pluginId: 'p', screenId: 'main', params: { q: "a b&c=d?e#f", path: '/x/y' } },
    splitTarget: null, drawerStack: [], activeModal: null,
  }))
  const weirdParams = weird.primaryTarget.kind === 'screen' ? weird.primaryTarget.params : undefined
  assert.deepEqual(weirdParams, { q: "a b&c=d?e#f", path: '/x/y' })
  // 非 sp./ssp. 前缀的键不属于任何 screen，不误吞
  const noPrefix = parseLocationHash('#/views/p/main?runId=wf_1').primaryTarget
  assert.equal(noPrefix.kind === 'screen' ? noPrefix.params : undefined, undefined)
})

// isSameResolvedTarget / resolveTargetString / parseScreenTargetQuery 已在文件头部统一导入。

test('screen params: isSameResolvedTarget 浅比较 params，仅 params 变化不入历史栈', { timeout: 60_000 }, () => {  const base = conversation(1)
  const screen = (params: Record<string, string> | undefined) => ({
    ...(params === undefined ? {} : { params }),
    kind: 'screen' as const,
    pluginId: 'p',
    screenId: 'main',
  })
  // 同目标不同 params 不等价；params 与无 params 也不等价
  assert.equal(isSameResolvedTarget(screen({ a: '1' }), screen({ a: '2' })), false)
  assert.equal(isSameResolvedTarget(screen({ a: '1' }), screen(undefined)), false)
  assert.equal(isSameResolvedTarget(screen({ a: '1' }), screen({ a: '1' })), true)
  assert.equal(isSameResolvedTarget(screen({ a: '1', b: '2' }), screen({ b: '2', a: '1' })), true)
  // 仅 params 变化：replace（不污染后退栈）
  const withParams = { ...base, primaryTarget: screen({ runId: 'wf_1' }) }
  const changedParams = { ...base, primaryTarget: screen({ runId: 'wf_2' }) }
  assert.equal(shouldPushLocationHistory(withParams, changedParams), false)
  // 跨 screen 坐标或会话切换仍 push；同坐标删除全部参数属参数变化仍 replace
  const otherScreen: typeof withParams = { ...base, primaryTarget: { kind: 'screen', pluginId: 'p', screenId: 'other' } }
  assert.equal(shouldPushLocationHistory(withParams, otherScreen), true)
  assert.equal(shouldPushLocationHistory(withParams, { ...base, primaryTarget: screen(undefined) }), false)
  assert.equal(shouldPushLocationHistory(withParams, conversation(2)), true)
  // isSameLocationState 整体感知 params 差异
  assert.equal(isSameLocationState(withParams, changedParams), false)
})

// ---------------------------------------------------------------------------
// skills 目标节点选择：顶层 node 查询参数（主屏顶层、分屏在 split 值内编码）
// ---------------------------------------------------------------------------

test('skills scope env: 顶层 node 归主屏技能中心，split 值内编码归分屏，忽略 cwd 往返无损', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/settings/skills?node=remote-1')
  assert.deepEqual(parsed.primaryTarget, {
    kind: 'skills', nodeId: 'remote-1',
  })
  // 详情子项与节点选择共存（打开节点技能详情的深链形态）
  const withDetail = parseLocationHash('#/settings/skills/deploy-runbook?node=code2')
  assert.deepEqual(withDetail.primaryTarget, {
    kind: 'skills', skillId: 'deploy-runbook', nodeId: 'code2',
  })
  assert.deepEqual(roundtrip(withDetail), withDetail)

  // 分屏技能中心：节点参数编码在 split 值内部，与主屏顶层命名空间互不串扰
  const splitParsed = parseLocationHash('#/settings/skills?node=code2&split=settings%2Fskills%2Fdetail%3Fnode%3Dremote-1')
  assert.deepEqual(splitParsed.primaryTarget, { kind: 'skills', nodeId: 'code2' })
  assert.deepEqual(splitParsed.splitTarget, { kind: 'skills', skillId: 'detail', nodeId: 'remote-1' })
  assert.deepEqual(roundtrip(splitParsed), splitParsed)

  // 无参数保持字段稳定；skills 不携带 cwd；切回会话顶层 node 无处可挂自然丢弃
  assert.deepEqual(parseLocationHash('#/settings/skills').primaryTarget, { kind: 'skills' })
  assert.deepEqual(parseLocationHash('#/settings/skills?node=code2&cwd=%2Fignored').primaryTarget, {
    kind: 'skills', nodeId: 'code2',
  })
  const away = parseLocationHash('#/c/1?node=local&cwd=%2Fa')
  assert.deepEqual(away.primaryTarget, { kind: 'conversation', conversationId: 1 })
})

test('skills scope env: 节点切换 push 入栈（数据源级变化）；isSameResolvedTarget 比较 nodeId', { timeout: 60_000 }, () => {
  const base = conversation(1)
  const skillsTarget = (nodeId?: string, skillId?: string) => ({
    kind: 'skills' as const,
    ...(skillId !== undefined ? { skillId } : {}),
    ...(nodeId !== undefined ? { nodeId } : {}),
  })
  const scoped = { ...base, primaryTarget: skillsTarget('code2') }
  const otherScope = { ...base, primaryTarget: skillsTarget('lx') }
  const hubScope = { ...base, primaryTarget: skillsTarget() }
  // 节点变化是数据源级切换：push（返回键回上一节点而非退出技能中心）
  assert.equal(shouldPushLocationHistory(scoped, otherScope), true)
  assert.equal(shouldPushLocationHistory(scoped, hubScope), true)
  // isSameResolvedTarget 感知 nodeId 差异
  assert.equal(isSameResolvedTarget(scoped.primaryTarget, otherScope.primaryTarget), false)
  assert.equal(isSameResolvedTarget(scoped.primaryTarget, hubScope.primaryTarget), false)
  assert.equal(isSameResolvedTarget(scoped.primaryTarget, skillsTarget('code2')), true)
  // 列表开抽屉（无 id -> 有 id）仍 push；带节点开详情再关详情保留 nodeId
  assert.equal(shouldPushLocationHistory(hubScope, { ...base, primaryTarget: skillsTarget(undefined, 'x') }), true)
  assert.equal(shouldPushLocationHistory(scoped, { ...base, primaryTarget: skillsTarget('code2', 'x') }), true)
})

// ---------------------------------------------------------------------------
// resolveTargetString：screen:<pluginId>/<screenId>?k=v 严格解析
// ---------------------------------------------------------------------------

// resolveTargetString 直携参数解析（sidebar target / helmx:open 真实入口）

test('resolveTargetString: screen 查询串解析进 params（helmx:open / sidebar target 直携参数）', { timeout: 60_000 }, () => {
  assert.deepEqual(
    resolveTargetString('screen:builtin:workflow/runs?runId=wf_1&tab=all', []),
    { kind: 'screen', pluginId: 'builtin:workflow', screenId: 'runs', params: { runId: 'wf_1', tab: 'all' } },
  )
  // 无查询串：保持无 params 字段（与既有形状兼容）
  assert.deepEqual(resolveTargetString('screen:p/main', []), { kind: 'screen', pluginId: 'p', screenId: 'main' })
  // 值可含编码后的特殊字符
  assert.deepEqual(
    resolveTargetString('screen:p/main?q=a%20b%26c', []),
    { kind: 'screen', pluginId: 'p', screenId: 'main', params: { q: 'a b&c' } },
  )
})

test('resolveTargetString: 非法查询串整体判无效（重复键 / 空键值 / 非法键 / 非法编码 / 无等号）', { timeout: 60_000 }, () => {
  for (const raw of [
    'screen:p/main?k=v&k=v2',       // 重复键
    'screen:p/main?=v',              // 空键
    'screen:p/main?k=',              // 空值
    'screen:p/main?k',               // 无等号
    'screen:p/main?a b=v',           // 键含空格
    'screen:p/main?__proto__=x',     // 原型键
    'screen:p/main?constructor=x',   // 原型键
    'screen:p/main?k=%E0%A4%A',      // 非法百分号编码
    'screen:p/main?&',               // 空片段
  ]) {
    assert.equal(resolveTargetString(raw, []), null, raw)
  }
  // 空查询串（尾部孤立 ?）视为无参数，目标仍合法
  assert.deepEqual(resolveTargetString('screen:p/main?', []), { kind: 'screen', pluginId: 'p', screenId: 'main' })
  // parseScreenTargetQuery 直接验证三态
  assert.equal(parseScreenTargetQuery(''), undefined)
  assert.equal(parseScreenTargetQuery('k=%E0%A4%A'), null)
  assert.deepEqual(parseScreenTargetQuery('b=2&a=1'), { a: '1', b: '2' })
})

test('resolveTargetString: overview 与全部五中心子目标完整解析与哈希往返', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetString('overview', []), { kind: 'overview' })
  assert.deepEqual(resolveTargetString('overview?', []), { kind: 'overview' })
  assert.deepEqual(resolveTargetString('overview?bucket=archived', []), {
    kind: 'overview',
    params: { bucket: 'archived' },
  })
  assert.deepEqual(resolveTargetString('overview?bucket=needs_attention&q=deploy', []), {
    kind: 'overview',
    params: { bucket: 'needs_attention', q: 'deploy' },
  })
  assert.equal(resolveTargetString('overview?bad', []), null)
  assert.equal(resolveTargetString('overview?__proto__=1', []), null)

  // 五中心子目标与 agent / conversation 目标统一往返
  const targets = [
    resolveTargetString('overview?bucket=archived', []),
    resolveTargetString('models:defaults', []),
    resolveTargetString('models:anthropic', []),
    resolveTargetString('profiles:coder', []),
    resolveTargetString('skills:helmx-cli', []),
    resolveTargetString('nodes:local', []),
    resolveTargetString('plugins:builtin:workflow', []),
    resolveTargetString('plugins:core', []),
    resolveTargetString('plugins:core/core:host/info', []),
    resolveTargetString('screen:builtin:workflow/runs?tab=active', []),
    resolveTargetString('agent:coder', []),
    resolveTargetString('conversation:42', []),
  ]
  for (const target of targets) {
    assert.ok(target !== null)
    const state: WorkspaceLocationState = {
      primaryTarget: target,
      splitTarget: null,
      drawerStack: [],
      activeModal: null,
    }
    assert.deepEqual(roundtrip(state).primaryTarget, target)
  }
})

// ---------------------------------------------------------------------------
// agent 待命目标（#/a/<profileId>，草稿环境 node/cwd 主/分屏往返）
// ---------------------------------------------------------------------------

test('parse: agent 待命目标路径与非法形式', { timeout: 60_000 }, () => {
  assert.deepEqual(parseLocationHash('#/a/assistant').primaryTarget, { kind: 'agent', profileId: 'assistant' })
  // profileId 含冒号保持可读；百分号编码形式同样可解析
  assert.deepEqual(parseLocationHash('#/a/builtin:herdr').primaryTarget, { kind: 'agent', profileId: 'builtin:herdr' })
  assert.deepEqual(parseLocationHash('#/a/builtin%3Aherdr').primaryTarget, { kind: 'agent', profileId: 'builtin:herdr' })
  // profileId 含斜杠必须编码；裸斜杠/空段/孤立 a 判非法回退默认
  assert.deepEqual(parseLocationHash('#/a/team%2Falpha').primaryTarget, { kind: 'agent', profileId: 'team/alpha' })
  for (const raw of ['#/a/', '#/a', '#/a/foo/bar', '#/a/%E0%A4%A']) {
    assert.deepEqual(parseLocationHash(raw).primaryTarget, { kind: 'profiles' }, raw)
  }
})

test('parse/format: agent 草稿环境 node/cwd 主屏与分屏各自往返', { timeout: 60_000 }, () => {
  // 主屏：node 与 cwd 为顶层查询参数；cwd 斜杠由 URLSearchParams 编码
  const primary = parseLocationHash('#/a/assistant?node=remote-1&cwd=%2Fremote%2Fwork')
  assert.deepEqual(primary.primaryTarget, { kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })
  assert.equal(
    formatLocationHash({ ...conversation(1), primaryTarget: primary.primaryTarget }),
    '#/a/assistant?node=remote-1&cwd=%2Fremote%2Fwork',
  )
  assert.deepEqual(roundtrip({ ...conversation(1), primaryTarget: primary.primaryTarget }).primaryTarget, primary.primaryTarget)

  // 只带 node 或只带 cwd 同样合法
  assert.deepEqual(parseLocationHash('#/a/assistant?node=remote-1').primaryTarget, {
    kind: 'agent', profileId: 'assistant', nodeId: 'remote-1',
  })
  assert.deepEqual(parseLocationHash('#/a/assistant?cwd=%2Fw').primaryTarget, {
    kind: 'agent', profileId: 'assistant', cwd: '/w',
  })
  // 空串参数视为未设置
  assert.deepEqual(parseLocationHash('#/a/assistant?node=&cwd=').primaryTarget, { kind: 'agent', profileId: 'assistant' })

  // 分屏：agent 环境编码在 split 值内部，与主屏同名参数互不串扰
  const splitHash = formatLocationHash({
    ...conversation(1),
    primaryTarget: { kind: 'agent', profileId: 'assistant', nodeId: 'main-node', cwd: '/main' },
    splitTarget: { kind: 'agent', profileId: 'coder', nodeId: 'remote-1', cwd: '/remote/work' },
  })
  // split 值由 URLSearchParams 整体转义（内层 cwd 的 / 二次编码为 %252F）
  assert.equal(splitHash, '#/a/assistant?node=main-node&cwd=%2Fmain&split=a%2Fcoder%3Fnode%3Dremote-1%26cwd%3D%252Fremote%252Fwork')
  const parsedSplit = parseLocationHash(splitHash)
  assert.deepEqual(parsedSplit.primaryTarget, { kind: 'agent', profileId: 'assistant', nodeId: 'main-node', cwd: '/main' })
  assert.deepEqual(parsedSplit.splitTarget, { kind: 'agent', profileId: 'coder', nodeId: 'remote-1', cwd: '/remote/work' })
  // 整体往返无损
  assert.deepEqual(roundtrip(parseLocationHash(splitHash)), parseLocationHash(splitHash))

  // 手写深链：split 内嵌查询串也能解析
  const handWritten = parseLocationHash(`#/c/1?split=${encodeURIComponent('a/coder?cwd=/srv')}`)
  assert.deepEqual(handWritten.splitTarget, { kind: 'agent', profileId: 'coder', cwd: '/srv' })
})

test('历史策略: agent 坐标级变化 push，仅草稿环境变化 replace', { timeout: 60_000 }, () => {
  const base: WorkspaceLocationState = { ...conversation(1), primaryTarget: { kind: 'agent', profileId: 'assistant' } }
  const envChanged: WorkspaceLocationState = {
    ...base,
    primaryTarget: { kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/r' },
  }
  // 同 profileId 仅环境变化：位置不同但 replace（不污染后退栈）
  assert.equal(isSameLocationState(base, envChanged), false)
  assert.equal(shouldPushLocationHistory(base, envChanged), false)
  assert.equal(shouldPushLocationHistory(envChanged, base), false)
  // 会话 <-> 待命 / 不同智能体待命：坐标级变化 push
  assert.equal(shouldPushLocationHistory(conversation(1), base), true)
  assert.equal(shouldPushLocationHistory(base, conversation(1)), true)
  const otherAgent: WorkspaceLocationState = { ...base, primaryTarget: { kind: 'agent', profileId: 'coder' } }
  assert.equal(shouldPushLocationHistory(base, otherAgent), true)
  // agent 与角色中心（profiles）互为坐标级变化
  const profilesState: WorkspaceLocationState = { ...conversation(1), primaryTarget: { kind: 'profiles' } }
  assert.equal(shouldPushLocationHistory(base, profilesState), true)
  // serializeHash 直接接收 agent 目标
  assert.equal(serializeHash({ kind: 'agent', profileId: 'assistant', nodeId: 'r', cwd: '/w' }), '#/a/assistant?node=r&cwd=%2Fw')
})

test('parse: 空缺 conversation:profile 仍返回 null（不静默降级到待命页）', { timeout: 60_000 }, () => {
  // conversation:profile:<id> 保持常驻会话查找语义（插件 singleton 不受 agent 目标影响）
  assert.equal(resolveTargetString('conversation:profile:none', []), null)
  // agent:<id> 声明式目标进入待命态；空 id 判无效
  assert.deepEqual(resolveTargetString('agent:assistant', []), { kind: 'agent', profileId: 'assistant' })
  assert.equal(resolveTargetString('agent:', []), null)
  assert.equal(resolveTargetString('agent', []), null)
})

test('isSameResolvedTarget: agent 目标按 profileId/nodeId/cwd 比较', { timeout: 60_000 }, () => {
  const a = { kind: 'agent', profileId: 'p' } as const
  assert.equal(isSameResolvedTarget(a, { kind: 'agent', profileId: 'p' }), true)
  assert.equal(isSameResolvedTarget(a, { kind: 'agent', profileId: 'q' }), false)
  assert.equal(isSameResolvedTarget({ kind: 'agent', profileId: 'p', nodeId: 'r' }, { kind: 'agent', profileId: 'p' }), false)
  assert.equal(
    isSameResolvedTarget({ kind: 'agent', profileId: 'p', nodeId: 'r', cwd: '/w' }, { kind: 'agent', profileId: 'p', nodeId: 'r', cwd: '/w' }),
    true,
  )
  assert.equal(isSameResolvedTarget(a, { kind: 'profiles', profileId: 'p' }), false)
})

// ---------------------------------------------------------------------------
// hashHasPrimaryTarget：首页落地判定（无显式主屏目标的入口才触发产品层落地）
// ---------------------------------------------------------------------------

test('hashHasPrimaryTarget: 空/纯查询/非法路径为 false，显式主屏目标为 true', { timeout: 60_000 }, () => {
  // 无显式主屏目标：空 Hash、裸 #、裸 #/、纯查询串、非法路径——解析虽回退角色中心，
  // 但那是缺省而非显式意图，入口应被视为「首页进入」交由产品层落地。
  for (const raw of ['', '#', '#/', '#/?wb=artifacts', '#/xyz']) {
    assert.equal(hashHasPrimaryTarget(raw), false, `${JSON.stringify(raw)} 不含显式主屏目标`)
  }
  // 显式主屏目标：会话（携带分屏参数仍是显式主屏）、各中心与 agent / views 目标。
  for (const raw of ['#/c/1?split=a/x', '#/settings/profiles', '#/a/assistant', '#/views/p/q']) {
    assert.equal(hashHasPrimaryTarget(raw), true, `${JSON.stringify(raw)} 含显式主屏目标`)
  }
})

test('workspace-file 模态：往返编解码、行号范围与非法路径拦截', { timeout: 60_000 }, () => {
  const fileState: WorkspaceLocationState = {
    ...conversation(7),
    activeModal: {
      kind: 'workspace-file',
      conversationId: 7,
      path: 'src/conversation/MarkdownView.tsx',
      startLine: 12,
      endLine: 34,
    },
  }
  const encoded = formatLocationHash(fileState)
  assert.equal(
    encoded,
    '#/c/7?modal=file&conv=7&path=src%2Fconversation%2FMarkdownView.tsx&line=12-34',
  )
  assert.deepEqual(roundtrip(fileState), fileState)

  const singleLine: WorkspaceLocationState = {
    ...conversation(7),
    activeModal: { kind: 'workspace-file', conversationId: 7, path: 'README.md', startLine: 5 },
  }
  assert.deepEqual(roundtrip(singleLine), singleLine)

  const noLine: WorkspaceLocationState = {
    ...conversation(7),
    activeModal: { kind: 'workspace-file', conversationId: 7, path: 'docs/guide.md' },
  }
  assert.deepEqual(roundtrip(noLine), noLine)

  // 非法参数：缺 conv、缺 path、路径越界或绝对路径均拒绝（activeModal 为 null）
  assert.equal(parseLocationHash('#/c/7?modal=file&path=README.md').activeModal, null)
  assert.equal(parseLocationHash('#/c/7?modal=file&conv=0&path=README.md').activeModal, null)
  assert.equal(parseLocationHash('#/c/7?modal=file&conv=7').activeModal, null)
  assert.equal(parseLocationHash('#/c/7?modal=file&conv=7&path=../../etc/passwd').activeModal, null)
  assert.equal(parseLocationHash('#/c/7?modal=file&conv=7&path=/etc/passwd').activeModal, null)
  assert.equal(parseLocationHash('#/c/7?modal=file&conv=7&path=.').activeModal, null)

  // 非法 line 忽略但保留文件预览
  assert.deepEqual(parseLocationHash('#/c/7?modal=file&conv=7&path=README.md&line=abc').activeModal, {
    kind: 'workspace-file',
    conversationId: 7,
    path: 'README.md',
  })

  // 比较与历史策略：同会话不同文件/行号 push，相同则不 push
  assert.equal(isSameLocationState(fileState, roundtrip(fileState)), true)
  assert.equal(isSameLocationState(fileState, singleLine), false)
  assert.equal(shouldPushLocationHistory(fileState, singleLine), true)
  assert.equal(shouldPushLocationHistory(fileState, roundtrip(fileState)), false)
})

test('parse/format: 插件中心 core 页签（#/settings/plugins/core[/<owner>[/<action>]]）往返与历史策略', { timeout: 60_000 }, () => {
  assert.deepEqual(parseLocationHash('#/settings/plugins/core').primaryTarget, {
    kind: 'plugins',
    tab: 'core',
  })
  assert.deepEqual(parseLocationHash('#/settings/plugins/core/core:conversations').primaryTarget, {
    kind: 'plugins',
    tab: 'core',
    coreOwner: 'core:conversations',
  })
  assert.deepEqual(parseLocationHash('#/settings/plugins/core/core:conversations/search').primaryTarget, {
    kind: 'plugins',
    tab: 'core',
    coreOwner: 'core:conversations',
    coreAction: 'search',
  })
  // 非法多余路径段与保留段保护
  assert.deepEqual(parseLocationHash('#/settings/plugins/core/a/b/c').primaryTarget, { kind: 'profiles' })
  assert.deepEqual(parseLocationHash('#/settings/plugins/builtin:workflow/extra').primaryTarget, { kind: 'profiles' })
  assert.equal(
    formatLocationHash({ ...conversation(1), primaryTarget: { kind: 'plugins', tab: 'plugins' } }),
    '#/settings/plugins',
  )
  assert.equal(
    formatLocationHash({ ...conversation(1), primaryTarget: { kind: 'plugins', pluginId: 'core' } }),
    '#/settings/plugins',
  )

  const state: WorkspaceLocationState = {
    ...conversation(1),
    primaryTarget: {
      kind: 'plugins',
      tab: 'core',
      coreOwner: 'core:conversations',
      coreAction: 'search',
    },
    splitTarget: { kind: 'skills', skillId: 'helmx-cli' },
  }
  assert.deepEqual(roundtrip(state), state)
})
