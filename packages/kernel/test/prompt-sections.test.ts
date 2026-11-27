import assert from 'node:assert/strict'
import test from 'node:test'
import { getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import { systemSectionsOf, withSections, withToolDeclarations } from '../src/runtime/hook-projection.js'

test('final sections replacement clears trailing system patches so deactivated action references cannot leak back via fallback', { timeout: 60_000 }, () => {
  const history = { role: 'user', content: 'continue' }
  const messages = [
    { role: 'system', content: 'host', sections: { 'profile.system': 'SYS', 'prompt.actions': 'stale catalog' } },
    history,
    {
      role: 'system',
      content: 'plugin message',
      sections: { 'prompt.actions': 'later stale catalog', 'plugin.context': 'keep context' },
      toolsRemoved: ['old_tool'],
    },
  ]
  const desired = [
    { id: 'profile.system', text: 'SYS' },
    { id: 'plugin.context', text: 'keep context' },
  ]
  const original = JSON.stringify(messages)
  const cleared = withSections(messages, desired)
  assert.deepEqual(systemSectionsOf(cleared), desired)
  assert.equal(cleared[1], history, 'user history preserves object reference')
  assert.equal(cleared[2]!['content'], 'plugin message')
  assert.deepEqual(cleared[2]!['toolsRemoved'], ['old_tool'], 'other system fields remain preserved')
  assert.equal(JSON.stringify(messages), original, 'does not mutate original messages')

  const updated = [...desired, { id: 'prompt.actions', text: 'fresh catalog' }]
  assert.deepEqual(systemSectionsOf(withSections(messages, updated)), updated, 'new catalog is not overwritten by trailing stale patches')
})

test('withToolDeclarations clears trailing system tool deltas so mid-transcript SDK reorders cannot resurrect stripped tools', { timeout: 60_000 }, () => {
  const readTool = { name: 'read', description: 'Read file', parameters: {} as never }
  const writeTool = { name: 'write', description: 'Write file', parameters: {} as never }
  const planSaveTool = { name: 'plan_save', description: 'Save plan', parameters: {} as never }
  const history = { role: 'user', content: 'plan this task' }
  const messages = [
    {
      role: 'system',
      content: 'host',
      sections: { 'profile.system': 'SYS' },
      toolsAdded: [readTool, planSaveTool],
    },
    history,
    {
      role: 'system',
      content: 'reorder delta',
      sections: { 'plan.mode': 'keep section' },
      toolsRemoved: [readTool, planSaveTool],
      toolsAdded: [readTool, writeTool, planSaveTool],
    },
  ]
  const original = JSON.stringify(messages)
  const runtimeTools = getCurrentTools(messages as never)
  assert.deepEqual(runtimeTools.map((t) => t.name).sort(), ['plan_save', 'read', 'write'])

  const rewritten = withToolDeclarations(messages, new Set(['read', 'plan_save']), runtimeTools)
  assert.deepEqual(
    getCurrentTools(rewritten as never).map((t) => t.name).sort(),
    ['plan_save', 'read'],
  )
  assert.equal(rewritten[1], history, 'non-system history preserves object reference')
  assert.equal(rewritten[2]!['content'], 'reorder delta')
  assert.deepEqual(rewritten[2]!['sections'], { 'plan.mode': 'keep section' }, 'trailing system sections remain preserved')
  assert.equal(rewritten[2]!['toolsAdded'], undefined)
  assert.equal(rewritten[2]!['toolsRemoved'], undefined)
  assert.equal(JSON.stringify(messages), original, 'does not mutate original messages')
})
