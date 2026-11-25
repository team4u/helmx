/**
 * Artifact kind contract and host-reserved slot protocol constant lock tests.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ARTIFACT_KINDS,
  COMPOSER_DOCK_SLOT,
  COMPOSER_MENU_SLOT,
  COMPOSER_STATUS_SLOT,
  COMPOSER_TOOLBAR_SLOT,
  HOST_SLOT_CATALOG,
  HOST_SLOT_TARGETS,
  NODE_DETAIL_SECTION_SLOT,
  OVERVIEW_CARD_META_SLOT,
  PROFILE_DETAIL_SECTION_SLOT,
  isArtifactKind,
  type ArtifactKind,
  type ArtifactMetadata,
  type PluginSlotContributionSpec,
} from '../src/index.js'

test('COMPOSER_DOCK_SLOT, COMPOSER_MENU_SLOT, COMPOSER_STATUS_SLOT, and COMPOSER_TOOLBAR_SLOT are exported and follow the builtin:composer/* namespace', { timeout: 60_000 }, () => {
  assert.equal(COMPOSER_STATUS_SLOT, 'builtin:composer/status')
  assert.equal(COMPOSER_TOOLBAR_SLOT, 'builtin:composer/toolbar')
  assert.equal(COMPOSER_MENU_SLOT, 'builtin:composer/menu')
  assert.equal(COMPOSER_DOCK_SLOT, 'builtin:composer/dock')
})

test('OVERVIEW_CARD_META_SLOT is exported and follows the builtin:overview/* namespace', { timeout: 60_000 }, () => {
  assert.equal(OVERVIEW_CARD_META_SLOT, 'builtin:overview/card-meta')
})

test('HOST_SLOT_CATALOG: single read-only catalog covers exactly the 7 real host slots', { timeout: 60_000 }, () => {
  assert.deepEqual(HOST_SLOT_TARGETS, [
    PROFILE_DETAIL_SECTION_SLOT,
    NODE_DETAIL_SECTION_SLOT,
    COMPOSER_STATUS_SLOT,
    COMPOSER_TOOLBAR_SLOT,
    COMPOSER_MENU_SLOT,
    COMPOSER_DOCK_SLOT,
    OVERVIEW_CARD_META_SLOT,
  ])
  assert.equal(HOST_SLOT_CATALOG.length, 7)
  assert.equal(Object.isFrozen(HOST_SLOT_CATALOG), true)
  const seen = new Set<string>()
  for (const entry of HOST_SLOT_CATALOG) {
    assert.equal(Object.isFrozen(entry), true)
    assert.equal(seen.has(entry.target), false)
    seen.add(entry.target)
    assert.equal(entry.target, `${entry.ownerPluginId}/${entry.slotName}`)
    assert.equal(entry.mode, 'list')
    assert.ok(entry.propsType.length > 0)
    assert.ok(entry.description.length > 0)
    assert.ok(['none', 'optional', 'required'].includes(entry.conversationContext))
  }
  assert.deepEqual([...seen], [...HOST_SLOT_TARGETS])
})

test('PluginSlotContributionSpec: client component reference is required', { timeout: 60_000 }, () => {
  const validSpec: PluginSlotContributionSpec = {
    id: 'slot-ok',
    target: COMPOSER_STATUS_SLOT,
    client: { module: 'index.tsx', export: 'StatusBadge' },
  }
  assert.equal(validSpec.client.export, 'StatusBadge')

  // @ts-expect-error client is required on PluginSlotContributionSpec
  const missingClient: PluginSlotContributionSpec = {
    id: 'slot-missing-client',
    target: COMPOSER_STATUS_SLOT,
  }
  assert.ok(missingClient)
})

test('ArtifactKind / isArtifactKind / ArtifactMetadata.kind required-field contract', { timeout: 60_000 }, () => {
  assert.deepEqual([...ARTIFACT_KINDS], ['upload', 'registered', 'spill'])
  for (const kind of ['upload', 'registered', 'spill'] as const satisfies readonly ArtifactKind[]) {
    assert.equal(isArtifactKind(kind), true)
  }
  for (const bad of [undefined, null, '', 'other', 'UPLOAD', 1, {}, '__proto__']) {
    assert.equal(isArtifactKind(bad), false, `invalid kind ${String(bad)} must be rejected`)
  }
  const meta: ArtifactMetadata = {
    id: 'art-1',
    conversationId: 1,
    kind: 'upload',
    name: 'demo.txt',
    path: 'artifacts/1/demo.txt',
    mimeType: 'text/plain',
    size: 5,
    createdAt: 1000,
  }
  assert.equal(meta.kind, 'upload')
  // @ts-expect-error kind is a required field and cannot be omitted
  const missingKind: ArtifactMetadata = {
    id: 'art-2',
    conversationId: 1,
    name: 'demo.txt',
    path: 'artifacts/1/demo.txt',
    mimeType: 'text/plain',
    size: 5,
    createdAt: 1000,
  }
  assert.ok(missingKind)
})
