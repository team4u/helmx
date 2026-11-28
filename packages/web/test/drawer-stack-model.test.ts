/**
 * drawer-stack-model 纯函数单元测试（pure 池）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getRememberedConversationDrawer,
  isDrawerFrameKeepAlive,
  MAX_DRAWER_STACK_DEPTH,
  pruneConversationFromDrawerMemory,
  pushDrawerFrame,
  removeConversationFromDrawerStack,
  resolveDrawerWorkbenchConversationId,
  setRememberedConversationDrawer,
} from '../src/lib/drawer-stack-model.js'
import type { DrawerFrame } from '../src/lib/types.js'

test('drawer-stack-model 纯函数契约：去重截断、深度上限 5、工作台归属推导与删除清理', { timeout: 60_000 }, () => {
  let stack: DrawerFrame[] = []
  for (let id = 1; id <= MAX_DRAWER_STACK_DEPTH + 2; id += 1) {
    stack = pushDrawerFrame(stack, { kind: 'conversation', conversationId: id })
  }
  assert.equal(stack.length, MAX_DRAWER_STACK_DEPTH, '超限时丢弃最底层')
  assert.deepEqual(
    stack.map((f) => f.conversationId),
    [3, 4, 5, 6, 7],
  )
  assert.equal(isDrawerFrameKeepAlive(stack.length, 0), false)
  assert.equal(isDrawerFrameKeepAlive(stack.length, 1), false)
  assert.equal(isDrawerFrameKeepAlive(stack.length, 2), true)
  assert.equal(isDrawerFrameKeepAlive(stack.length, 4), true)

  stack = pushDrawerFrame(stack, { kind: 'conversation', conversationId: 4 })
  assert.deepEqual(stack.map((f) => f.conversationId), [3, 4])

  const mixed: DrawerFrame[] = [
    { kind: 'workbench', tab: 'artifacts' },
    { kind: 'conversation', conversationId: 67 },
    { kind: 'workbench', tab: 'artifacts' },
    { kind: 'workbench', conversationId: 88, tab: 'artifacts' },
  ]
  assert.equal(resolveDrawerWorkbenchConversationId(mixed, 0, 10), 10)
  assert.equal(resolveDrawerWorkbenchConversationId(mixed, 2, 10), 67)
  assert.equal(resolveDrawerWorkbenchConversationId(mixed, 3, 10), 88)

  const pruned = removeConversationFromDrawerStack(
    [
      { kind: 'workbench', tab: 'artifacts' },
      { kind: 'conversation', conversationId: 67 },
      { kind: 'workbench', conversationId: 67, tab: 'artifacts' },
    ],
    67,
  )
  assert.deepEqual(pruned, [{ kind: 'workbench', tab: 'artifacts' }])
})

test('drawer-stack-model 按会话记忆纯函数契约：LRU 淘汰、浅拷贝隔离、空栈清理与删除级联裁剪', { timeout: 60_000 }, () => {
  const memory = new Map<number, DrawerFrame[]>()
  setRememberedConversationDrawer(memory, 1, [{ kind: 'workbench', tab: ' artifacts ' }], 2)
  setRememberedConversationDrawer(memory, 2, [{ kind: 'conversation', conversationId: 22 }], 2)

  const copy1 = getRememberedConversationDrawer(memory, 1)
  assert.deepEqual(copy1, [{ kind: 'workbench', tab: 'artifacts' }])
  copy1!.push({ kind: 'conversation', conversationId: 999 })
  assert.deepEqual(getRememberedConversationDrawer(memory, 1), [{ kind: 'workbench', tab: 'artifacts' }])

  setRememberedConversationDrawer(memory, 3, [{ kind: 'workbench', tab: 'changes' }, { kind: 'conversation', conversationId: 33 }], 2)
  assert.equal(getRememberedConversationDrawer(memory, 2), undefined)
  assert.deepEqual(getRememberedConversationDrawer(memory, 1), [{ kind: 'workbench', tab: 'artifacts' }])

  setRememberedConversationDrawer(memory, 1, [], 2)
  assert.equal(getRememberedConversationDrawer(memory, 1), undefined)

  setRememberedConversationDrawer(memory, 10, [
    { kind: 'workbench', tab: 'artifacts' },
    { kind: 'conversation', conversationId: 33 },
    { kind: 'workbench', conversationId: 33, tab: 'changes' },
  ], 10)
  setRememberedConversationDrawer(memory, 20, [
    { kind: 'conversation', conversationId: 33 },
  ], 10)
  pruneConversationFromDrawerMemory(memory, 33)
  assert.equal(getRememberedConversationDrawer(memory, 33), undefined)
  assert.deepEqual(getRememberedConversationDrawer(memory, 10), [{ kind: 'workbench', tab: 'artifacts' }])
  assert.equal(getRememberedConversationDrawer(memory, 20), undefined)
})
