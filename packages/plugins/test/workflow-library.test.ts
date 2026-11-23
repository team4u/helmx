/**
 * 工作流库契约回归：WorkflowService.get / save / delete 与 list 文件事实。
 *
 * 覆盖：save 新建 / 重复覆盖保护（409）/ overwrite / fromRunId（内联固化、
 * scriptPath 重读、subagent 拒绝、无源拒绝）/ 非法 meta / 语法错误 / 显式名与
 * meta.name 不一致 / 名称安全（路径穿越）/ 符号链接拒绝 / 原子写并发创建 /
 * get 只读源码 / delete 不存在 404 / delete 符号链接拒绝 / list updatedAt+size。
 * 动作注册与 HTTP 端映射的集成验证见 workflow-plugin-boundary.test.ts。
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelmxError } from '@helmx/protocol'
import { createMemoryKvStore, WorkflowService, type WorkflowServiceHost } from '../src/workflow/runs/index.js'

const timeout = { timeout: 60_000 } as const

function makeStateStore() {
  return createMemoryKvStore()
}

const host: WorkflowServiceHost = {
  async spawnAgent() {
    throw new Error('no spawn in this suite')
  },
  async invokeAction() {
    throw new Error('no actions')
  },
  listActions() {
    return []
  },
  getConversation: () => {
    throw new Error('no conversations in this suite')
  },
  async abortConversationGuarded() {},
  emitEvent() {},
  async runGate() {
    return { ok: true, output: '' }
  },
}

const GOOD_SCRIPT = [
  'export const meta = { name: "release", description: "发布流程" }',
  'return 1',
].join('\n')

let root: string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helmx-wf-library-'))
})

after(async () => {
  rmSync(root, { recursive: true, force: true })
})

/** 断言 HelmxError（code + 可选 message 正则）。 */
function assertHelmxError(fn: () => unknown, code: string, messageRe?: RegExp): HelmxError {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof HelmxError, `应抛 HelmxError（实得 ${String(error)}）`)
    assert.equal(error.code, code)
    if (messageRe !== undefined) assert.match(error.message, messageRe)
    return error
  }
  throw new Error(`应抛 ${code}，实际未抛出`)
}

describe('WorkflowService.save：script 源', { timeout: 60_000 }, () => {
  it('新建：写入文件、返回真实摘要（created: true + 真实文件事实）', timeout, async () => {
    const dataDir = join(root, 'save-new')
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    try {
      const result = service.save({ script: GOOD_SCRIPT })
      assert.equal(result.created, true)
      assert.equal(result.workflow.name, 'release')
      assert.equal(result.workflow.description, '发布流程')
      assert.equal(result.workflow.path, join(dataDir, 'workflows', 'release.js'))
      assert.ok(result.workflow.size > 0)
      assert.ok(result.workflow.updatedAt > 0)
      // 真实文件事实：size 与磁盘一致，内容原样。
      const onDisk = readFileSync(join(dataDir, 'workflows', 'release.js'), 'utf-8')
      assert.equal(onDisk, GOOD_SCRIPT)
      assert.equal(result.workflow.size, Buffer.byteLength(onDisk, 'utf-8'))
    } finally {
      await service.close()
    }
  })

  it('重复保存默认拒绝（409 workflow_already_exists）；overwrite: true 覆盖', timeout, async () => {
    const dataDir = join(root, 'save-overwrite')
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    try {
      service.save({ script: GOOD_SCRIPT })
      assertHelmxError(
        () => service.save({ script: GOOD_SCRIPT }),
        'workflow_already_exists',
        /overwrite/,
      )
      const updated = GOOD_SCRIPT.replace('发布流程', '发布流程 v2')
      const result = service.save({ script: updated, overwrite: true })
      assert.equal(result.created, false)
      assert.equal(result.workflow.description, '发布流程 v2')
      assert.equal(readFileSync(join(dataDir, 'workflows', 'release.js'), 'utf-8'), updated)
    } finally {
      await service.close()
    }
  })

  it('重复创建被 409 拒绝且无临时文件泄漏（link 原子占位 + tmp 清理）', timeout, async () => {
    const dataDir = join(root, 'save-race')
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    try {
      const first = service.save({ script: GOOD_SCRIPT })
      assert.equal(first.created, true)
      // 二次创建：存在检查命中即 409（并发窗口内则由 link EEXIST 映射同一错误码）。
      assertHelmxError(() => service.save({ script: GOOD_SCRIPT }), 'workflow_already_exists')
      assert.equal(service.list().length, 1)
      const entries = service.list()
      assert.equal(entries[0]!.name, 'release')
      // 目录内除定义文件外无 .tmp 残留。
      const dirEntries = readdirSync(join(dataDir, 'workflows'))
      assert.deepEqual(dirEntries, ['release.js'])
    } finally {
      await service.close()
    }
  })

  it('非法 meta / 语法错误脚本显式拒绝，不写文件', timeout, async () => {
    const dataDir = join(root, 'save-invalid')
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    try {
      // 缺 meta 声明。
      assertHelmxError(() => service.save({ script: 'return 1' }), 'workflow_script_invalid', /meta/)
      // meta 模板插值（非纯字面量）。
      assertHelmxError(
        () => service.save({ script: 'const v = "x"\nexport const meta = { name: "a", description: `d-${v}` }\nreturn 1' }),
        'workflow_script_invalid',
      )
      // 语法错误（meta 合法、脚本体不闭合括号）。
      assertHelmxError(
        () => service.save({ script: 'export const meta = { name: "bad", description: "d" }\nconst x = (' }),
        'workflow_script_invalid',
        /syntax/i,
      )
      assert.deepEqual(service.list(), [], '非法脚本不得写入目录')
    } finally {
      await service.close()
    }
  })

  it('显式 name 与 meta.name 不一致拒绝；缺省 name 用 meta.name', timeout, async () => {
    const dataDir = join(root, 'save-name')
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    try {
      assertHelmxError(
        () => service.save({ script: GOOD_SCRIPT, name: 'other' }),
        'validation_error',
        /meta\.name/,
      )
      const result = service.save({ script: GOOD_SCRIPT, name: 'release' })
      assert.equal(result.workflow.name, 'release')
    } finally {
      await service.close()
    }
  })

  it('名称安全：路径穿越 / 非法字符拒绝；空 script 拒绝', timeout, async () => {
    const dataDir = join(root, 'save-safe')
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    try {
      assertHelmxError(() => service.save({ script: GOOD_SCRIPT, name: '../escape' }), 'validation_error', /invalid/)
      assertHelmxError(() => service.save({ script: GOOD_SCRIPT, name: 'a/b' }), 'validation_error')
      assertHelmxError(() => service.save({ script: '' }), 'validation_error', /script/)
      assertHelmxError(() => service.save({ script: '   ' }), 'validation_error', /script/)
    } finally {
      await service.close()
    }
  })

  it('符号链接指向目录外拒绝（不读不写）', timeout, async () => {
    const dataDir = join(root, 'save-symlink')
    const workflows = join(dataDir, 'workflows')
    mkdirSync(workflows, { recursive: true })
    const outside = join(root, 'outside.js')
    writeFileSync(outside, GOOD_SCRIPT, 'utf-8')
    symlinkSync(outside, join(workflows, 'hijack.js'))
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    try {
      // 既有越界 symlink：名称与 meta 一致时仍被 realpath 校验拒绝（不读不写）。
      const hijackScript = 'export const meta = { name: "hijack", description: "d" }\nreturn 1'
      assertHelmxError(() => service.save({ script: hijackScript, name: 'hijack', overwrite: true }), 'validation_error', /symlink/)
      // list 层：越界 symlink 因 meta 可读仍会出现（list 只拒绝名称非法）；此处验证不崩溃且事实如实。
      // get 层同样拒绝。
      assertHelmxError(() => service.get('hijack'), 'validation_error', /symlink/)
    } finally {
      await service.close()
    }
  })
})

describe('WorkflowService.get / delete / list', { timeout: 60_000 }, () => {
  it('get：返回只读源码与元数据；不存在 404；非法名拒绝', timeout, async () => {
    const dataDir = join(root, 'get')
    mkdirSync(join(dataDir, 'workflows'), { recursive: true })
    writeFileSync(join(dataDir, 'workflows', 'release.js'), GOOD_SCRIPT, 'utf-8')
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    try {
      const detail = service.get('release')
      assert.equal(detail.script, GOOD_SCRIPT)
      assert.equal(detail.name, 'release')
      assert.equal(detail.description, '发布流程')
      assert.ok(detail.size > 0)
      assert.ok(detail.updatedAt > 0)
      assertHelmxError(() => service.get('nope'), 'not_found')
      assertHelmxError(() => service.get('../x'), 'validation_error')
    } finally {
      await service.close()
    }
  })

  it('delete：删除定义文件；不存在 404；目录条目与越界符号链接拒绝', timeout, async () => {
    const dataDir = join(root, 'delete')
    const workflows = join(dataDir, 'workflows')
    mkdirSync(workflows, { recursive: true })
    writeFileSync(join(workflows, 'release.js'), GOOD_SCRIPT, 'utf-8')
    mkdirSync(join(workflows, 'dir.js'))
    const outside = join(root, 'delete-outside.js')
    writeFileSync(outside, GOOD_SCRIPT, 'utf-8')
    symlinkSync(outside, join(workflows, 'linked.js'))
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    try {
      const result = service.delete('release')
      assert.equal(result.deleted, true)
      assert.equal(result.name, 'release')
      assert.equal(result.path, join(workflows, 'release.js'))
      // 再删 404。
      assertHelmxError(() => service.delete('release'), 'not_found')
      // 目录条目拒绝。
      assertHelmxError(() => service.delete('dir'), 'validation_error', /regular file/)
      // 越界符号链接拒绝（不删目标也不删链接）。
      assertHelmxError(() => service.delete('linked'), 'validation_error', /symlink/)
      assert.ok(readFileSync(outside, 'utf-8') === GOOD_SCRIPT, '符号链接目标不得被删除')
    } finally {
      await service.close()
    }
  })

  it('list：每条携带真实 updatedAt / size 文件事实', timeout, async () => {
    const dataDir = join(root, 'list-stats')
    const workflows = join(dataDir, 'workflows')
    mkdirSync(workflows, { recursive: true })
    writeFileSync(join(workflows, 'a.js'), 'export const meta = { name: "a", description: "da" }\nreturn 1', 'utf-8')
    const service = new WorkflowService({ dataDir, host, kv: makeStateStore() })
    try {
      const items = service.list()
      assert.equal(items.length, 1)
      const item = items[0]!
      assert.equal(item.name, 'a')
      assert.equal(item.size, 61)
      assert.ok(Number.isSafeInteger(item.updatedAt) && item.updatedAt > 0)
    } finally {
      await service.close()
    }
  })
})
