import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BUILTIN_NAMESPACE_PREFIX,
  CORE_NAMESPACE_PREFIX,
  CORE_OWNER_ID_PATTERN,
  isBuiltinNamespace,
  isCoreNamespace,
  isReservedPluginNamespace,
  isSkillAvailable,
  isSkillOwnerActive,
  isValidCoreOwnerId,
  stripBuiltinNamespace,
  type SkillSummary,
} from '@helmx/protocol'

const ordinary: SkillSummary = { id: 'review', name: 'Review', references: [] }
const managed: SkillSummary = { ...ordinary, managedByPlugin: 'community:review' }
const coreManaged: SkillSummary = { id: 'helmx-cli', name: 'Helmx CLI', references: [], managedByPlugin: 'core:host' }
const malformedCoreManaged: SkillSummary = { id: 'bad-core', name: 'Bad Core', references: [], managedByPlugin: 'core:' }

test('skill policy: default allows all, empty array disables all, explicit lists match by ID only', { timeout: 60_000 }, () => {
  const enabled = new Set<string>()
  assert.equal(isSkillAvailable(ordinary, {}, enabled), true)
  assert.equal(isSkillAvailable(ordinary, { skills: [] }, enabled), false)
  assert.equal(isSkillAvailable(ordinary, { skills: ['review'] }, enabled), true)
  assert.equal(isSkillAvailable(ordinary, { skills: ['other'] }, enabled), false)
})

test('skill policy: managed skills of disabled or unregistered plugins are unavailable even when allowlisted', { timeout: 60_000 }, () => {
  assert.equal(isSkillAvailable(managed, {}, new Set()), false)
  assert.equal(isSkillAvailable(managed, { skills: ['review'] }, new Set()), false)
  const enabled = new Set(['community:review'])
  assert.equal(isSkillAvailable(managed, {}, enabled), true)
  assert.equal(isSkillAvailable(managed, { skills: ['review'] }, enabled), true)
  assert.equal(isSkillAvailable(managed, { skills: [] }, enabled), false)
})

test('skill policy: core:* managed skills are always active regardless of enabledPluginIds, while still respecting profile allowlist', { timeout: 60_000 }, () => {
  const emptyEnabled = new Set<string>()
  assert.equal(isSkillOwnerActive(undefined, emptyEnabled), true)
  assert.equal(isSkillOwnerActive('core:host', emptyEnabled), true)
  assert.equal(isSkillOwnerActive('core:conversations', emptyEnabled), true)
  assert.equal(isSkillOwnerActive('core:profiles', emptyEnabled), true)
  assert.equal(isSkillOwnerActive('core:plugins', emptyEnabled), true)
  assert.equal(isSkillOwnerActive('builtin:profile', emptyEnabled), false)
  assert.equal(isSkillOwnerActive('builtin:profile', new Set(['builtin:profile'])), true)

  assert.equal(isSkillAvailable(coreManaged, {}, emptyEnabled), true)
  assert.equal(isSkillAvailable(coreManaged, { skills: ['helmx-cli'] }, emptyEnabled), true)
  assert.equal(isSkillAvailable(coreManaged, { skills: [] }, emptyEnabled), false)
  assert.equal(isSkillAvailable(coreManaged, { skills: ['other'] }, emptyEnabled), false)

  // Malformed core:* owner IDs must never bypass plugin activation checks
  assert.equal(isSkillOwnerActive('core:', emptyEnabled), false)
  assert.equal(isSkillOwnerActive('core:bad.id', emptyEnabled), false)
  assert.equal(isSkillAvailable(malformedCoreManaged, {}, emptyEnabled), false)
})

test('namespace predicates: core: and builtin: detection, validation, and prefix stripping', { timeout: 60_000 }, () => {
  assert.equal(CORE_NAMESPACE_PREFIX, 'core:')
  assert.equal(BUILTIN_NAMESPACE_PREFIX, 'builtin:')
  assert.ok(CORE_OWNER_ID_PATTERN.test('core:conversations'))

  assert.equal(isCoreNamespace('core:host'), true)
  assert.equal(isCoreNamespace('core:'), true)
  assert.equal(isCoreNamespace('builtin:profile'), false)
  assert.equal(isCoreNamespace('my-plugin'), false)

  assert.equal(isValidCoreOwnerId('core:host'), true)
  assert.equal(isValidCoreOwnerId('core:node_v2-beta'), true)
  assert.equal(isValidCoreOwnerId('core:'), false)
  assert.equal(isValidCoreOwnerId('core:bad.name'), false)
  assert.equal(isValidCoreOwnerId('core:a:b'), false)
  assert.equal(isValidCoreOwnerId('builtin:host'), false)

  assert.equal(isBuiltinNamespace('builtin:profile'), true)
  assert.equal(isBuiltinNamespace('core:host'), false)
  assert.equal(isBuiltinNamespace('custom'), false)

  assert.equal(isReservedPluginNamespace('core:conversations'), true)
  assert.equal(isReservedPluginNamespace('builtin:profile'), true)
  assert.equal(isReservedPluginNamespace('community-plugin'), false)

  assert.equal(stripBuiltinNamespace('builtin:workflow'), 'workflow')
  assert.equal(stripBuiltinNamespace('core:conversations'), 'core:conversations')
  assert.equal(stripBuiltinNamespace('community-plugin'), 'community-plugin')
})
