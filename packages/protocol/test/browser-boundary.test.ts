import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as browserExports from '../src/browser.js'
import * as rootExports from '../src/index.js'
import {
  KNOWN_PLUGIN_UI_SURFACES,
  parsePluginUiContribution,
  type KnownPluginUiContribution,
  type PluginUiContribution,
} from '../src/browser.js'

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('@helmx/protocol/browser: export declarations aligned with the root entry\'s pure cross-runtime surface', { timeout: 60_000 }, async () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
    exports?: Record<string, { types?: string; default?: string }>
  }
  assert.deepEqual(pkg.exports?.['./browser'], {
    types: './dist/browser.d.ts',
    default: './dist/browser.js',
  })

  const pkgBrowser = (await import('@helmx/protocol/browser')) as Record<string, unknown>

  const requiredRuntimeExports = [
    'HelmxError',
    'PLUGIN_HOOK_NAMES',
    'PLUGIN_CONFIG_FIELD_TYPES',
    'PLUGIN_CONFIG_FIELD_FORMATS',
    'PLUGIN_CLIENT_SHARED_EXPORTS',
    'PLUGIN_UI_METHOD_NAMES',
    'KNOWN_PLUGIN_UI_SURFACES',
    'SIDEBAR_BADGE_TONES',
    'SIDEBAR_ITEM_BADGE_FIELDS',
    'WORKBENCH_PANEL_BADGE_FIELDS',
    'COMPOSER_COMPLETER_TRIGGERS',
    'COMPOSER_COMPLETER_DOC_KINDS',
    'parsePluginUiContribution',
    'RESERVED_SLASH_COMMANDS',
    'PLUGIN_CLIENT_CSS_EXPORT',
    'PROFILE_DETAIL_SECTION_SLOT',
    'NODE_DETAIL_SECTION_SLOT',
    'COMPOSER_STATUS_SLOT',
    'COMPOSER_DOCK_SLOT',
    'OVERVIEW_CARD_META_SLOT',
    'HOST_SLOT_TARGETS',
    'HOST_SLOT_CATALOG',
    'matchesConversationScope',
    'isPluginSummaryActive',
    'isSkillAvailable',
    'assertSchemaCompilable',
    'validateOrThrow',
    'NODE_ID_PATTERN',
    'NODE_ID_REGEX',
    'isValidNodeId',
    'isAbsoluteAgentPath',
    'sanitizeAgentExecutionInfo',
    'sanitizeAgentGateResult',
    'agentGateResultMissingError',
    'isAbsoluteTargetPath',
    'safeResultText',
    'redactJsonValue',
    'isArtifactKind',
    'ARTIFACT_KINDS',
    'compareStrictSemver',
    'HELMX_LOCALES',
    'DEFAULT_HELMX_LOCALE',
    'isHelmxLocale',
    'normalizeLocaleTag',
    'parseLocalizedText',
    'resolveLocalizedText',
    'createLocaleTranslator',
    'encodeSessionDocSubParam',
    'parseSessionDocSubParam',
    'TOOL_PRESENTATION_META_MAX_BYTES',
    'TOOL_PRESENTATION_META_MAX_DEPTH',
    'TOOL_PRESENTATION_META_MAX_NODES',
    'assertBoundedPresentationMeta',
    'EDIT_TOOL_RESULT_SCHEMA',
    'READ_TOOL_META_SCHEMA',
    'WRITE_TOOL_META_SCHEMA',
    'BASH_TOOL_META_SCHEMA',
    'ARTIFACT_REGISTER_META_SCHEMA',
    'ARTIFACT_READ_META_SCHEMA',
    'KERNEL_TOOL_PRESENTATION_META_SCHEMAS',
  ] as const

  /** Server-only contract validators and TypeBox UI schemas that must NOT bloat `@helmx/protocol/browser`. */
  const serverOnlyRuntimeExports = [
    'UI_SPEC_PATTERNS',
    'UI_SPEC_SCHEMAS',
    'compareCodeUnit',
    'validatePluginConfigFieldSchema',
    'validatePluginConfigFieldValue',
  ] as const

  const browserRecord = browserExports as Record<string, unknown>
  const rootRecord = rootExports as Record<string, unknown>
  const browserKeys = Object.keys(browserRecord)
  const expectedRootKeys = [...browserKeys, ...serverOnlyRuntimeExports].sort()
  assert.deepEqual(expectedRootKeys, Object.keys(rootRecord).sort())
  for (const key of browserKeys) {
    assert.equal(browserRecord[key], rootRecord[key], `browser.ts export ${key} must stay identical to index.ts`)
    assert.ok(key in pkgBrowser, `@helmx/protocol/browser package entry is missing export ${key}`)
  }
  for (const key of serverOnlyRuntimeExports) {
    assert.ok(key in rootRecord, `index.ts is missing server-only runtime export ${key}`)
    assert.equal(key in browserRecord, false, `browser.ts must not export server-only runtime symbol ${key}`)
    assert.equal(key in pkgBrowser, false, `@helmx/protocol/browser must not export server-only runtime symbol ${key}`)
  }
  for (const key of requiredRuntimeExports) {
    assert.ok(key in browserRecord, `browser.ts is missing runtime export ${key}`)
    assert.equal(browserRecord[key], rootRecord[key], `browser.ts and index.ts export ${key} must point to the same instance`)
  }
})

test('parsePluginUiContribution: covers every known surface and rejects invalid contributions correctly', { timeout: 60_000 }, () => {
  for (const surface of KNOWN_PLUGIN_UI_SURFACES) {
    const item: PluginUiContribution = {
      pluginId: 'demo:plugin',
      surface,
      spec: { id: `spec-${surface}`, label: surface },
    }
    const parsed = parsePluginUiContribution(item)
    assert.ok(parsed !== undefined, `known surface "${surface}" should narrow successfully`)
    assert.equal(parsed.pluginId, 'demo:plugin')
    assert.equal(parsed.surface, surface)
    // Verify the discriminated union narrows by surface
    const narrowed: KnownPluginUiContribution = parsed
    assert.equal(narrowed.spec.id, `spec-${surface}`)
  }

  const invalidCases: Array<{ label: string; value: PluginUiContribution }> = [
    { label: 'unknown surface', value: { pluginId: 'demo:plugin', surface: 'unknown.surface', spec: { id: 'x' } } },
    { label: 'empty surface', value: { pluginId: 'demo:plugin', surface: '', spec: { id: 'x' } } },
    { label: 'prototype-pollution surface', value: { pluginId: 'demo:plugin', surface: '__proto__', spec: { id: 'x' } } },
    { label: 'null spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: null } },
    { label: 'undefined spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: undefined } },
    { label: 'array spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: [] } },
    { label: 'primitive spec', value: { pluginId: 'demo:plugin', surface: 'screen', spec: 'bad' } },
  ]
  for (const c of invalidCases) {
    assert.equal(parsePluginUiContribution(c.value), undefined, `${c.label} must return undefined`)
  }
})

test('isPluginSummaryActive: unified truth table across enabled/status/error combinations', { timeout: 60_000 }, () => {
  const err = { code: 'plugin_enable_failed', message: 'boom', stage: 'enable' as const }
  assert.equal(browserExports.isPluginSummaryActive({ enabled: true }), true)
  assert.equal(browserExports.isPluginSummaryActive({ enabled: true, status: 'active' }), true)
  assert.equal(browserExports.isPluginSummaryActive({ enabled: false }), false)
  assert.equal(browserExports.isPluginSummaryActive({ enabled: false, status: 'active' }), false)
  assert.equal(browserExports.isPluginSummaryActive({ enabled: false, status: 'disabled' }), false)
  assert.equal(browserExports.isPluginSummaryActive({ enabled: true, status: 'disabled' }), false)
  assert.equal(browserExports.isPluginSummaryActive({ enabled: true, status: 'failed' }), false)
  assert.equal(browserExports.isPluginSummaryActive({ enabled: true, status: 'failed', error: err }), false)
  assert.equal(browserExports.isPluginSummaryActive({ enabled: true, status: 'active', error: err }), false)
  assert.equal(browserExports.isPluginSummaryActive({ enabled: true, error: err }), false)
  assert.equal(browserExports.isPluginSummaryActive({ enabled: false, status: 'failed', error: err }), false)
})

test('validatePluginConfigFieldSchema and validatePluginConfigFieldValue enforce enum and string[] contracts', { timeout: 60_000 }, () => {
  const { validatePluginConfigFieldSchema, validatePluginConfigFieldValue } = rootExports
  const declOpts = { allowSecretDefault: true, requireBooleanFlags: false } as const

  // Valid enum and string[] declarations
  assert.equal(
    validatePluginConfigFieldSchema({ type: 'string', enum: ['fast', 'balanced'], default: 'fast' }, declOpts),
    undefined,
  )
  assert.equal(
    validatePluginConfigFieldSchema({ type: 'number', enum: [1, 2, 4], integer: true, minimum: 1, maximum: 4, default: 2 }, declOpts),
    undefined,
  )
  assert.equal(
    validatePluginConfigFieldSchema({ type: 'string[]', default: ['a', 'b'] }, declOpts),
    undefined,
  )
  assert.equal(
    validatePluginConfigFieldSchema({ type: 'string[]', enum: ['cron', 'webhook', 'manual'], default: ['cron'] }, declOpts),
    undefined,
  )

  // Invalid declarations
  const badSchemas: Array<[string, unknown]> = [
    ['empty enum', { type: 'string', enum: [] }],
    ['duplicate string enum', { type: 'string', enum: ['a', 'a'] }],
    ['wrong element type in string enum', { type: 'string', enum: ['a', 1] }],
    ['wrong element type in number enum', { type: 'number', enum: [1, '2'] }],
    ['non-finite number enum', { type: 'number', enum: [1, Number.POSITIVE_INFINITY] }],
    ['number enum violating integer', { type: 'number', integer: true, enum: [1, 1.5] }],
    ['number enum violating minimum', { type: 'number', minimum: 2, enum: [1, 2] }],
    ['boolean with enum', { type: 'boolean', enum: ['true'] }],
    ['secret with enum', { type: 'string', secret: true, enum: ['a'] }],
    ['secret with string[]', { type: 'string[]', secret: true }],
    ['format with enum', { type: 'string', format: 'model', enum: ['m1'] }],
    ['format on string[]', { type: 'string[]', format: 'node' }],
    ['minimum > maximum', { type: 'number', minimum: 10, maximum: 5 }],
    ['string default not in enum', { type: 'string', enum: ['a', 'b'], default: 'c' }],
    ['string[] default not array', { type: 'string[]', default: 'a' }],
    ['string[] default with non-string item', { type: 'string[]', default: ['a', 2] }],
    ['string[] default item outside enum', { type: 'string[]', enum: ['a', 'b'], default: ['a', 'c'] }],
  ]
  for (const [label, schema] of badSchemas) {
    assert.ok(
      validatePluginConfigFieldSchema(schema, declOpts) !== undefined,
      `expected rejection for ${label}`,
    )
  }

  // Runtime value checks
  const enumTags = { type: 'string[]' as const, enum: ['alpha', 'beta'] }
  assert.equal(validatePluginConfigFieldValue(enumTags, []), undefined)
  assert.equal(validatePluginConfigFieldValue(enumTags, ['alpha', 'beta']), undefined)
  assert.ok(validatePluginConfigFieldValue(enumTags, ['alpha', 'gamma']) !== undefined)
  assert.ok(validatePluginConfigFieldValue(enumTags, 'alpha') !== undefined)
  const sparse: unknown[] = []
  sparse[1] = 'alpha'
  assert.ok(validatePluginConfigFieldValue(enumTags, sparse) !== undefined)
})
