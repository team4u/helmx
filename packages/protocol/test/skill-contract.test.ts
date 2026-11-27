/**
 * Skill bundle frontmatter contract: parseSkillFrontmatterLines is the single value-syntax reader shared by the
 * kernel catalog (parseSkillFrontmatter) and the Web skill reader, so its ordering, duplicate-key, block-scalar
 * and fence-bounding rules are pinned here at the protocol level.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseSkillFrontmatter, parseSkillFrontmatterLines } from '../src/index.js'

test('parseSkillFrontmatterLines: keeps YAML order and duplicate keys, skips comments and blank lines, strips symmetric quotes', { timeout: 60_000 }, () => {
  assert.deepEqual(
    parseSkillFrontmatterLines(['# comment', '', 'license: MIT', 'name: "quoted name"', "description: 'It''s fine'", 'name: dup', 'note: a"b']),
    [
      { key: 'license', value: 'MIT' },
      { key: 'name', value: 'quoted name' },
      { key: 'description', value: "It's fine" },
      { key: 'name', value: 'dup' },
      { key: 'note', value: 'a"b' },
    ],
  )
  assert.deepEqual(parseSkillFrontmatterLines([]), [])
})

test('parseSkillFrontmatterLines: folded and literal block scalars end at the first shallower line and never run past the given lines', { timeout: 60_000 }, () => {
  // Folded: trimmed lines joined by spaces; a blank line inside the block is a separator, trailing blanks are dropped.
  assert.deepEqual(parseSkillFrontmatterLines(['description: >-', '  A', '', '  B', 'name: x']), [
    { key: 'description', value: 'A B' },
    { key: 'name', value: 'x' },
  ])
  // Literal: common indent removed, newlines kept.
  assert.deepEqual(parseSkillFrontmatterLines(['description: |', '  A', '  B', '', 'name: x']), [
    { key: 'description', value: 'A\nB' },
    { key: 'name', value: 'x' },
  ])
  // An unindented closing fence left in the lines ends the block instead of becoming part of the value.
  assert.deepEqual(parseSkillFrontmatterLines(['description: >', '  only', '---']), [{ key: 'description', value: 'only' }])
  // A block reaching the end of the given lines is complete (callers bound lines to the fence body).
  assert.deepEqual(parseSkillFrontmatterLines(['description: >', '  first', '  second']), [
    { key: 'description', value: 'first second' },
  ])
})

test('parseSkillFrontmatter: last duplicate key wins, missing fence yields empty fields, empty managedByPlugin throws', { timeout: 60_000 }, () => {
  assert.deepEqual(parseSkillFrontmatter('---\nname: a\ndescription: >\n  first\n  second\nname: b\n---\nbody'), {
    name: 'b',
    description: 'first second',
  })
  assert.deepEqual(parseSkillFrontmatter('# no frontmatter\n'), { name: '', description: '' })
  assert.throws(() => parseSkillFrontmatter('---\nmanagedByPlugin:\n---\n'), /managedByPlugin value is empty/)
})
