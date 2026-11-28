import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import * as browserExports from '../src/browser.js'
import * as rootExports from '../src/index.js'
import type { CoreOperationSpec } from '../src/index.js'
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
    'UI_SHARED_EXPORTS',
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
    'COMPOSER_TOOLBAR_SLOT',
    'COMPOSER_MENU_SLOT',
    'COMPOSER_DOCK_SLOT',
    'OVERVIEW_CARD_META_SLOT',
    'HOST_SLOT_TARGETS',
    'HOST_SLOT_CATALOG',
    'matchesConversationScope',
    'isPluginSummaryActive',
    'isSkillOwnerActive',
    'isSkillAvailable',
    'CORE_NAMESPACE_PREFIX',
    'BUILTIN_NAMESPACE_PREFIX',
    'CORE_OWNER_ID_PATTERN',
    'isCoreNamespace',
    'isValidCoreOwnerId',
    'isBuiltinNamespace',
    'isReservedPluginNamespace',
    'stripBuiltinNamespace',
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
    'validateEditToolResult',
    'EDIT_TOOL_RESULT_SCHEMA',
    'READ_TOOL_TRUNCATION_SCHEMA',
    'READ_TOOL_META_SCHEMA',
    'WRITE_TOOL_META_SCHEMA',
    'BASH_TOOL_META_SCHEMA',
    'ARTIFACT_REGISTER_META_SCHEMA',
    'ARTIFACT_READ_META_SCHEMA',
    'ASK_USER_TOOL_META_SCHEMA',
    'KERNEL_TOOL_NAMES',
    'KERNEL_TOOL_PRESENTATION_META_SCHEMAS',
    'MODEL_THINKING_LEVELS',
    'assertJsonSafe',
    'resolveConversationTiming',
    'compareCodeUnit',
    'isLoopbackHubUrl',
    'formatHubListenSummary',
    'resolveDefaultHubUrl',
    'buildNodeConnectGuide',
    'HELMX_SEARCH_CAPABILITY_ID',
    'PLUGIN_SEARCH_ITEM_KINDS',
  ] as const

  /** Server-only contract validators and TypeBox UI/request schemas that must NOT bloat `@helmx/protocol/browser`. */
  const serverOnlyRuntimeExports = [
    'UI_SPEC_PATTERNS',
    'UI_SPEC_SCHEMAS',
    'REQUEST_SCHEMA_PATTERNS',
    'REQUEST_SCHEMAS',
    'assertBoundedPresentationMeta',
    'assertSchemaCompilable',
    'validateOrThrow',
    'validatePluginConfigFieldSchema',
    'validatePluginConfigFieldValue',
    'NODE_CORE_OPERATIONS',
    'CONVERSATION_CORE_OPERATIONS',
    'ASK_CORE_OPERATIONS',
    'PROFILE_CORE_OPERATIONS',
    'MODEL_CORE_OPERATIONS',
    'PROVIDER_CORE_OPERATIONS',
    'CREDENTIAL_CORE_OPERATIONS',
    'AUTH_CORE_OPERATIONS',
    'PLUGIN_CORE_OPERATIONS',
    'SKILL_CORE_OPERATIONS',
    'OMNIBOX_CORE_OPERATIONS',
    'CORE_OPERATIONS',
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

  // Command shortcut parsing: trims non-empty strings <= 32 chars, strips invalid/blank/overlong values
  const clean = parsePluginUiContribution({
    pluginId: 'demo:plugin',
    surface: 'commandPalette',
    spec: { id: 'c1', title: 'Toggle', shortcut: 'Ctrl+.' },
  })
  assert.ok(clean !== undefined && clean.surface === 'commandPalette')
  assert.equal(clean.spec.shortcut, 'Ctrl+.')

  const trimmed = parsePluginUiContribution({
    pluginId: 'demo:plugin',
    surface: 'commandPalette',
    spec: { id: 'c2', title: 'Toggle', shortcut: '  Ctrl+.  ' },
  })
  assert.ok(trimmed !== undefined && trimmed.surface === 'commandPalette')
  assert.equal(trimmed.spec.shortcut, 'Ctrl+.')

  const maxBoundary = 'A'.repeat(32)
  const boundaryParsed = parsePluginUiContribution({
    pluginId: 'demo:plugin',
    surface: 'commandPalette',
    spec: { id: 'c3', title: 'Toggle', shortcut: maxBoundary },
  })
  assert.ok(boundaryParsed !== undefined && boundaryParsed.surface === 'commandPalette')
  assert.equal(boundaryParsed.spec.shortcut, maxBoundary)

  for (const badShortcut of ['', '   ', 'A'.repeat(33), 42, null, undefined]) {
    const stripped = parsePluginUiContribution({
      pluginId: 'demo:plugin',
      surface: 'commandPalette',
      spec: { id: 'c4', title: 'Toggle', shortcut: badShortcut },
    })
    assert.ok(stripped !== undefined && stripped.surface === 'commandPalette')
    assert.equal(stripped.spec.shortcut, undefined)
    assert.equal(Object.hasOwn(stripped.spec, 'shortcut'), false)
  }

  // Command target parsing: trims non-empty single-line strings <= 512 chars, strips invalid values
  const targetClean = parsePluginUiContribution({
    pluginId: 'demo:plugin',
    surface: 'commandPalette',
    spec: { id: 'c5', title: 'Open', target: '  screen:demo:plugin/main?create=1  ' },
  })
  assert.ok(targetClean !== undefined && targetClean.surface === 'commandPalette')
  assert.equal(targetClean.spec.target, 'screen:demo:plugin/main?create=1')

  const targetBoundary = parsePluginUiContribution({
    pluginId: 'demo:plugin',
    surface: 'commandPalette',
    spec: { id: 'c6', title: 'Open', target: 'a'.repeat(512) },
  })
  assert.ok(targetBoundary !== undefined && targetBoundary.surface === 'commandPalette')
  assert.equal(targetBoundary.spec.target, 'a'.repeat(512))

  for (const badTarget of ['', '   ', 'a\nb', 'a'.repeat(513), 42, null, undefined]) {
    const stripped = parsePluginUiContribution({
      pluginId: 'demo:plugin',
      surface: 'commandPalette',
      spec: { id: 'c7', title: 'Open', target: badTarget },
    })
    assert.ok(stripped !== undefined && stripped.surface === 'commandPalette')
    assert.equal(stripped.spec.target, undefined)
    assert.equal(Object.hasOwn(stripped.spec, 'target'), false)
  }

  // Legacy 'command' alias is retired and rejected as unknown surface
  assert.equal(
    parsePluginUiContribution({
      pluginId: 'demo:plugin',
      surface: 'command',
      spec: { id: 'legacy', title: 'Toggle' },
    }),
    undefined,
  )
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
    ['secret with format', { type: 'string', secret: true, format: 'model' }],
    ['secret with string[]', { type: 'string[]', secret: true }],
    ['unknown schema key at declaration', { type: 'string', extraField: true }],
    ['manifest key property rejected at declaration', { key: 'apiKey', type: 'string' }],
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
  assert.equal(
    validatePluginConfigFieldSchema({ key: 'model', type: 'string', secret: false, required: true, format: 'model' }, { allowSecretDefault: false, requireBooleanFlags: true }),
    undefined,
  )
  assert.ok(
    validatePluginConfigFieldSchema({ key: 'model', type: 'string', secret: false, required: true, bogus: 1 }, { allowSecretDefault: false, requireBooleanFlags: true }) !== undefined,
  )

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

test('core-ops/plugins & skills: declarative specs stay structurally valid and security-compliant', { timeout: 60_000 }, () => {
  const {
    CORE_CLI_COMMAND_PATHS,
    CORE_OPERATIONS,
    PLUGIN_CORE_OPERATIONS,
    SKILL_CORE_OPERATIONS,
    assertSchemaCompilable,
  } = rootExports

  assert.equal(PLUGIN_CORE_OPERATIONS.length, 14)
  assert.equal(SKILL_CORE_OPERATIONS.length, 3)
  assert.ok(CORE_OPERATIONS.length >= PLUGIN_CORE_OPERATIONS.length + SKILL_CORE_OPERATIONS.length)

  const seenKeys = new Set<string>()
  const seenHttpRoutes = new Set<string>()
  const cliPathSet = new Set<string>(CORE_CLI_COMMAND_PATHS)

  const ops: readonly CoreOperationSpec[] = CORE_OPERATIONS
  const pluginOps: readonly CoreOperationSpec[] = PLUGIN_CORE_OPERATIONS
  const skillOps: readonly CoreOperationSpec[] = SKILL_CORE_OPERATIONS

  for (const op of ops) {
    assert.ok(!seenKeys.has(op.key), `duplicate core operation key: ${op.key}`)
    seenKeys.add(op.key)

    const httpRoute = `${op.http.method} ${op.http.path}`
    assert.ok(!seenHttpRoutes.has(httpRoute), `duplicate core HTTP route: ${httpRoute}`)
    seenHttpRoutes.add(httpRoute)

    assertSchemaCompilable(op.inputSchema)
    assertSchemaCompilable(op.outputSchema)
    if (op.http.bodySchema !== undefined) assertSchemaCompilable(op.http.bodySchema)
    if (op.action !== false && op.action.inputSchema !== undefined) {
      assertSchemaCompilable(op.action.inputSchema)
    }
    assert.ok(cliPathSet.has(op.cli.command.join(' ')), `CLI command missing in CORE_CLI_COMMAND_PATHS: ${op.cli.command.join(' ')}`)
  }

  for (const key of ['plugins.install', 'plugins.update', 'plugins.remove'] as const) {
    const op = pluginOps.find((item) => item.key === key)
    assert.ok(op, `missing plugin operation: ${key}`)
    assert.equal(op.action, false, `${key} must remain excluded from core:* actions`)
  }
  for (const key of ['plugins.config_set', 'plugins.enable', 'plugins.disable', 'plugins.reload', 'plugins.rescan'] as const) {
    const op = pluginOps.find((item) => item.key === key)
    assert.ok(op && op.action !== false, `missing actionable plugin operation: ${key}`)
    assert.deepEqual(op.action.scope, { topLevelOnly: true, ownedBy: 'human' })
  }
  for (const op of skillOps) {
    assert.ok(op.action !== false)
    assert.deepEqual(op.action.scope, { conversationIds: [] })
  }
})
