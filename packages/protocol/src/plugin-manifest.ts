/**
 * Read-only plugin extension contract projection DTOs and strict boundary validators
 * (zero `node:*`, zero `@earendil-works/pi-*`, zero live callbacks or secret values).
 *
 * Exported jointly by `@helmx/protocol` and `@helmx/protocol/browser`.
 */

import type { ConversationScope } from './conversation.js'
import { HelmxError } from './error.js'
import { parseNonEmptyLocalizedText, type LocalizedText } from './locale.js'
import {
  PLUGIN_HOOK_NAMES,
  type ActionManifest,
  type HookName,
  type JsonSchema,
  type PluginDiagnosticError,
  type PluginPromptFields,
  type PluginStatus,
} from './plugin-dto.js'
import { KNOWN_PLUGIN_UI_SURFACES } from './ui.js'
import { isJsonObject, isPlainObject } from './utils.js'

export interface PluginManifestAction extends ActionManifest {
  /** Provider-safe tool alias when `exposeAsTool === true` (omitted otherwise). */
  toolName?: string
}

export interface PluginManifestTool extends PluginPromptFields {
  name: string
  description: string
  inputSchema: JsonSchema
  structuredOutputSchema?: JsonSchema
  presentationMetaSchema?: JsonSchema
  replay?: 'safe' | 'unsafe'
  scope?: ConversationScope
  sourceKind: 'tool' | 'action'
  /** Fully-qualified `pluginId.actionId` when `sourceKind === 'action'`. */
  qualifiedId?: string
}

export interface PluginManifestUiItem {
  surface: string
  id: string
  spec: Record<string, unknown>
}

export type PluginManifestRouteMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface PluginManifestRoute {
  method: PluginManifestRouteMethod
  path: string
  public: boolean
}

export interface PluginManifestDoc {
  name: string
  kind: 'doc' | 'sessionDoc'
  public: true
  durable: boolean
}

export interface PluginManifestConfigField {
  key: string
  type: 'string' | 'number' | 'boolean'
  secret: boolean
  required: boolean
  format?: 'model' | 'node' | 'profile'
  label?: LocalizedText
  description?: LocalizedText
  /** Non-secret default value only; strictly omitted when `secret === true`. */
  default?: string | number | boolean
  minimum?: number
  maximum?: number
  integer?: boolean
}

export interface PluginManifestProvider {
  id: string
  name: string
}

export interface PluginManifestClientModule {
  module: string
  contentHash?: string
}

/**
 * Stably ordered, read-only, JSON-safe projection of a plugin's declared capabilities.
 * Never carries live handlers, runtime config values, secrets, private docs, or provider auth.
 */
export interface PluginManifestProjection {
  id: string
  name: LocalizedText
  description?: LocalizedText
  icon?: string
  version?: string
  locked: boolean
  enabled: boolean
  status: PluginStatus
  error?: PluginDiagnosticError
  dependencies: string[]
  hooks: HookName[]
  actions: PluginManifestAction[]
  tools: PluginManifestTool[]
  ui: PluginManifestUiItem[]
  routes: PluginManifestRoute[]
  /** Public document/sessionDoc descriptors only; private docs and runtime values are omitted. */
  docs: PluginManifestDoc[]
  configFields: PluginManifestConfigField[]
  providers: PluginManifestProvider[]
  services: string[]
  clientModules: PluginManifestClientModule[]
}

/** Deterministic UTF-16 code-unit string comparator (locale-independent). */
export function compareCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

const HOOK_INDEX = new Map<string, number>(PLUGIN_HOOK_NAMES.map((name, idx) => [name, idx]))
const KNOWN_UI_SURFACE_SET = new Set<string>(KNOWN_PLUGIN_UI_SURFACES)
const ROUTE_METHODS = new Set<string>(['GET', 'POST', 'PUT', 'DELETE'])
const PLUGIN_STATUSES = new Set<string>(['active', 'disabled', 'failed'])
const ERROR_STAGES = new Set<string>(['scan', 'load', 'define', 'enable'])
const CONFIG_TYPES = new Set<string>(['string', 'number', 'boolean'])
const CONFIG_FORMATS = new Set<string>(['model', 'node', 'profile'])
const UNSAFE_IDENTIFIER_KEYS = new Set<string>(['__proto__', 'constructor', 'prototype'])

function invalidManifest(reason: string, details?: Record<string, unknown>): HelmxError {
  return new HelmxError('invalid_plugin_manifest', `Invalid plugin manifest projection: ${reason}`, 400, details)
}

function assertJsonSafe(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidManifest(`${path} contains non-finite number`)
    return
  }
  if (typeof value !== 'object') {
    throw invalidManifest(`${path} contains non-JSON value (${typeof value})`)
  }
  if (seen.has(value)) throw invalidManifest(`${path} contains circular reference`)
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i)) throw invalidManifest(`${path}[${i}] is sparse`)
        assertJsonSafe(value[i], `${path}[${i}]`, seen)
      }
      return
    }
    if (!isPlainObject(value)) {
      throw invalidManifest(`${path} must be a plain JSON object`)
    }
    if (Object.hasOwn(value, '__proto__') || Object.prototype.propertyIsEnumerable.call(value, '__proto__')) {
      throw invalidManifest(`${path} contains forbidden __proto__ key`)
    }
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) throw invalidManifest(`${path}.${k} must not be undefined`)
      assertJsonSafe(v, `${path}.${k}`, seen)
    }
  } finally {
    seen.delete(value)
  }
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidManifest(`${label} must be a non-empty string`)
  }
  return value
}

function assertSafeIdentifier(value: unknown, label: string): string {
  const s = assertNonEmptyString(value, label)
  if (UNSAFE_IDENTIFIER_KEYS.has(s)) {
    throw invalidManifest(`${label} uses forbidden key "${s}"`)
  }
  return s
}

function assertPromptFields(obj: Record<string, unknown>, label: string): void {
  if (obj['promptSnippet'] !== undefined) {
    if (typeof obj['promptSnippet'] !== 'string' || obj['promptSnippet'].trim().length === 0) {
      throw invalidManifest(`${label}.promptSnippet must be a non-empty non-whitespace string`)
    }
  }
  if (obj['promptGuidelines'] !== undefined) {
    const guidelines = obj['promptGuidelines']
    if (
      !Array.isArray(guidelines) ||
      guidelines.length === 0 ||
      guidelines.some((item) => typeof item !== 'string' || item.trim().length === 0)
    ) {
      throw invalidManifest(`${label}.promptGuidelines must be a non-empty array of non-whitespace strings`)
    }
  }
}

function assertManifestScope(scope: unknown, label: string): void {
  if (!isPlainObject(scope)) {
    throw invalidManifest(`${label} must be a plain object`)
  }
  assertAllowedKeys(scope, SCOPE_KEYS, label)
  if (scope['conversationIds'] !== undefined) {
    const ids = scope['conversationIds']
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'number' || !Number.isInteger(id) || id < 1)) {
      throw invalidManifest(`${label}.conversationIds must be an array of positive integers`)
    }
  }
  for (const field of ['tags', 'profileIds', 'modelProviders'] as const) {
    if (scope[field] !== undefined) {
      const list = scope[field]
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.length === 0)) {
        throw invalidManifest(`${label}.${field} must be an array of non-empty strings`)
      }
    }
  }
}

function assertActionCliSpec(cli: unknown, label: string): void {
  if (!isPlainObject(cli)) {
    throw invalidManifest(`${label} must be a plain object`)
  }
  assertAllowedKeys(cli, CLI_SPEC_KEYS, label)
  if (cli['command'] !== undefined) {
    const cmd = cli['command']
    if (!Array.isArray(cmd) || cmd.length === 0 || cmd.some((seg) => typeof seg !== 'string' || seg.length === 0)) {
      throw invalidManifest(`${label}.command must be a non-empty array of non-empty strings`)
    }
  }
  if (cli['description'] !== undefined && typeof cli['description'] !== 'string') {
    throw invalidManifest(`${label}.description must be a string`)
  }
  if (cli['hidden'] !== undefined && typeof cli['hidden'] !== 'boolean') {
    throw invalidManifest(`${label}.hidden must be a boolean`)
  }
  if (cli['timeoutMs'] !== undefined) {
    if (typeof cli['timeoutMs'] !== 'number' || !Number.isFinite(cli['timeoutMs']) || cli['timeoutMs'] < 0) {
      throw invalidManifest(`${label}.timeoutMs must be a finite number >= 0`)
    }
  }
  if (cli['positional'] !== undefined) {
    const posList = cli['positional']
    if (!Array.isArray(posList)) {
      throw invalidManifest(`${label}.positional must be an array`)
    }
    for (let i = 0; i < posList.length; i += 1) {
      const pos = posList[i]
      if (!isPlainObject(pos)) throw invalidManifest(`${label}.positional[${i}] must be a plain object`)
      assertAllowedKeys(pos, CLI_POSITIONAL_KEYS, `${label}.positional[${i}]`)
      assertSafeIdentifier(pos['field'], `${label}.positional[${i}].field`)
      if (pos['required'] !== undefined && typeof pos['required'] !== 'boolean') {
        throw invalidManifest(`${label}.positional[${i}].required must be a boolean`)
      }
      if (pos['readFileInto'] !== undefined) {
        assertSafeIdentifier(pos['readFileInto'], `${label}.positional[${i}].readFileInto`)
      }
    }
  }
}

function assertStrictlySortedUnique<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  compare: (a: T, b: T) => number,
  label: string,
): void {
  const seen = new Set<string>()
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!
    const key = keyOf(item)
    if (seen.has(key)) throw invalidManifest(`${label} contains duplicate entry "${key}"`)
    seen.add(key)
    if (i > 0 && compare(items[i - 1]!, item) >= 0) {
      throw invalidManifest(`${label} is not deterministically sorted`)
    }
  }
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw invalidManifest(`${label} contains unexpected key "${key}"`)
    }
  }
}

const ROOT_KEYS = new Set([
  'id',
  'name',
  'description',
  'icon',
  'version',
  'locked',
  'enabled',
  'status',
  'error',
  'dependencies',
  'hooks',
  'actions',
  'tools',
  'ui',
  'routes',
  'docs',
  'configFields',
  'providers',
  'services',
  'clientModules',
])

const ERROR_KEYS = new Set(['code', 'message', 'stage', 'details'])
const SCOPE_KEYS = new Set(['conversationIds', 'tags', 'profileIds', 'modelProviders'])
const CLI_SPEC_KEYS = new Set(['command', 'description', 'hidden', 'positional', 'timeoutMs'])
const CLI_POSITIONAL_KEYS = new Set(['field', 'required', 'readFileInto'])
const ACTION_KEYS = new Set([
  'pluginId',
  'id',
  'description',
  'inputSchema',
  'outputSchema',
  'exposeAsTool',
  'presentationMetaSchema',
  'exposeToPrompt',
  'idempotent',
  'cli',
  'scope',
  'promptSnippet',
  'promptGuidelines',
  'toolName',
])
const TOOL_KEYS = new Set([
  'name',
  'description',
  'inputSchema',
  'structuredOutputSchema',
  'presentationMetaSchema',
  'replay',
  'scope',
  'promptSnippet',
  'promptGuidelines',
  'sourceKind',
  'qualifiedId',
])
const UI_ITEM_KEYS = new Set(['surface', 'id', 'spec'])
const ROUTE_KEYS = new Set(['method', 'path', 'public'])
const DOC_KEYS = new Set(['name', 'kind', 'public', 'durable'])
const PROVIDER_KEYS = new Set(['id', 'name'])
const CLIENT_MODULE_KEYS = new Set(['module', 'contentHash'])
const CONFIG_FIELD_KEYS = new Set([
  'key',
  'type',
  'secret',
  'required',
  'format',
  'label',
  'description',
  'default',
  'minimum',
  'maximum',
  'integer',
])

/**
 * Validates that an unknown value is a strictly sorted, JSON-safe, leak-free `PluginManifestProjection`.
 */
export function assertPluginManifestProjection(value: unknown): PluginManifestProjection {
  if (!isPlainObject(value)) throw invalidManifest('root must be a plain object')
  assertJsonSafe(value, 'manifest')
  assertAllowedKeys(value, ROOT_KEYS, 'manifest')

  const id = assertSafeIdentifier(value['id'], 'manifest.id')
  if (parseNonEmptyLocalizedText(value['name']) === undefined) {
    throw invalidManifest('manifest.name must be valid non-empty LocalizedText')
  }
  if (value['description'] !== undefined && parseNonEmptyLocalizedText(value['description']) === undefined) {
    throw invalidManifest('manifest.description must be valid non-empty LocalizedText when present')
  }
  if (value['icon'] !== undefined) assertNonEmptyString(value['icon'], 'manifest.icon')
  if (value['version'] !== undefined && typeof value['version'] !== 'string') {
    throw invalidManifest('manifest.version must be a string when present')
  }
  if (typeof value['locked'] !== 'boolean') throw invalidManifest('manifest.locked must be a boolean')
  if (typeof value['enabled'] !== 'boolean') throw invalidManifest('manifest.enabled must be a boolean')
  if (typeof value['status'] !== 'string' || !PLUGIN_STATUSES.has(value['status'])) {
    throw invalidManifest('manifest.status must be active | disabled | failed')
  }

  if (value['error'] !== undefined) {
    const err = value['error']
    if (!isPlainObject(err)) throw invalidManifest('manifest.error must be a plain object')
    assertAllowedKeys(err, ERROR_KEYS, 'manifest.error')
    assertNonEmptyString(err['code'], 'manifest.error.code')
    if (typeof err['message'] !== 'string') throw invalidManifest('manifest.error.message must be a string')
    if (typeof err['stage'] !== 'string' || !ERROR_STAGES.has(err['stage'])) {
      throw invalidManifest('manifest.error.stage must be scan | load | define | enable')
    }
    if (err['details'] !== undefined && !isPlainObject(err['details'])) {
      throw invalidManifest('manifest.error.details must be a plain object when present')
    }
  }

  if (value['status'] === 'active') {
    if (value['enabled'] !== true || value['error'] !== undefined) {
      throw invalidManifest('manifest status active requires enabled=true and error=undefined')
    }
  } else if (value['status'] === 'disabled') {
    if (value['error'] !== undefined) {
      // During transient activating/deactivating windows `enabled` may be true while `status` is 'disabled'.
      throw invalidManifest('manifest status disabled requires error=undefined')
    }
  } else if (value['error'] === undefined) {
    // status === 'failed' may occur with enabled=false (register/enable failure) or
    // enabled=true (runtime dependency forced-disable failure), and must always carry `error`.
    throw invalidManifest('manifest status failed requires error')
  }

  for (const arrayField of [
    'dependencies',
    'hooks',
    'actions',
    'tools',
    'ui',
    'routes',
    'docs',
    'configFields',
    'providers',
    'services',
    'clientModules',
  ] as const) {
    if (!Array.isArray(value[arrayField])) {
      throw invalidManifest(`manifest.${arrayField} must be an array`)
    }
  }

  const dependencies = value['dependencies'] as unknown[]
  for (let i = 0; i < dependencies.length; i += 1) {
    assertSafeIdentifier(dependencies[i], `manifest.dependencies[${i}]`)
  }
  assertStrictlySortedUnique(
    dependencies as string[],
    (d) => d,
    compareCodeUnit,
    'manifest.dependencies',
  )

  const hooks = value['hooks'] as unknown[]
  for (let i = 0; i < hooks.length; i += 1) {
    const h = hooks[i]
    if (typeof h !== 'string' || !HOOK_INDEX.has(h)) {
      throw invalidManifest(`manifest.hooks[${i}] is not a valid HookName`)
    }
  }
  assertStrictlySortedUnique(
    hooks as HookName[],
    (h) => h,
    (a, b) => (HOOK_INDEX.get(a) ?? -1) - (HOOK_INDEX.get(b) ?? -1),
    'manifest.hooks',
  )

  const actions = value['actions'] as unknown[]
  for (let i = 0; i < actions.length; i += 1) {
    const a = actions[i]
    const label = `manifest.actions[${i}]`
    if (!isPlainObject(a)) throw invalidManifest(`${label} must be a plain object`)
    assertAllowedKeys(a, ACTION_KEYS, label)
    if (a['pluginId'] !== id) {
      throw invalidManifest(`${label}.pluginId must match manifest.id (${id})`)
    }
    assertSafeIdentifier(a['id'], `${label}.id`)
    assertNonEmptyString(a['description'], `${label}.description`)
    if (!isJsonObject(a['inputSchema'])) throw invalidManifest(`${label}.inputSchema must be an object`)
    if (!isJsonObject(a['outputSchema'])) throw invalidManifest(`${label}.outputSchema must be an object`)
    for (const boolField of ['exposeAsTool', 'exposeToPrompt', 'idempotent'] as const) {
      if (a[boolField] !== undefined && typeof a[boolField] !== 'boolean') {
        throw invalidManifest(`${label}.${boolField} must be a boolean`)
      }
    }
    if (a['cli'] !== undefined) assertActionCliSpec(a['cli'], `${label}.cli`)
    if (a['scope'] !== undefined) assertManifestScope(a['scope'], `${label}.scope`)
    assertPromptFields(a, label)
    if (a['exposeAsTool'] === true) {
      assertSafeIdentifier(a['toolName'], `${label}.toolName`)
      if (a['presentationMetaSchema'] !== undefined && !isJsonObject(a['presentationMetaSchema'])) {
        throw invalidManifest(`${label}.presentationMetaSchema must be an object`)
      }
    } else {
      if (a['toolName'] !== undefined) {
        throw invalidManifest(`${label}.toolName must be omitted unless exposeAsTool is true`)
      }
      if (a['presentationMetaSchema'] !== undefined) {
        throw invalidManifest(`${label}.presentationMetaSchema must be omitted unless exposeAsTool is true`)
      }
    }
  }
  assertStrictlySortedUnique(
    actions as PluginManifestAction[],
    (a) => a.id,
    (a, b) => compareCodeUnit(a.id, b.id),
    'manifest.actions',
  )

  const tools = value['tools'] as unknown[]
  for (let i = 0; i < tools.length; i += 1) {
    const t = tools[i]
    const label = `manifest.tools[${i}]`
    if (!isPlainObject(t)) throw invalidManifest(`${label} must be a plain object`)
    assertAllowedKeys(t, TOOL_KEYS, label)
    assertSafeIdentifier(t['name'], `${label}.name`)
    assertNonEmptyString(t['description'], `${label}.description`)
    if (!isJsonObject(t['inputSchema'])) throw invalidManifest(`${label}.inputSchema must be an object`)
    if (t['structuredOutputSchema'] !== undefined && !isJsonObject(t['structuredOutputSchema'])) {
      throw invalidManifest(`${label}.structuredOutputSchema must be an object`)
    }
    if (t['presentationMetaSchema'] !== undefined && !isJsonObject(t['presentationMetaSchema'])) {
      throw invalidManifest(`${label}.presentationMetaSchema must be an object`)
    }
    if (t['replay'] !== undefined && t['replay'] !== 'safe' && t['replay'] !== 'unsafe') {
      throw invalidManifest(`${label}.replay must be safe | unsafe`)
    }
    if (t['scope'] !== undefined) assertManifestScope(t['scope'], `${label}.scope`)
    assertPromptFields(t, label)
    if (t['sourceKind'] !== 'tool' && t['sourceKind'] !== 'action') {
      throw invalidManifest(`${label}.sourceKind must be tool | action`)
    }
    if (t['sourceKind'] === 'action') {
      assertNonEmptyString(t['qualifiedId'], `${label}.qualifiedId`)
    } else if (t['qualifiedId'] !== undefined) {
      throw invalidManifest(`${label}.qualifiedId must be omitted when sourceKind is tool`)
    }
  }
  assertStrictlySortedUnique(
    tools as PluginManifestTool[],
    (t) => t.name,
    (a, b) => compareCodeUnit(a.name, b.name),
    'manifest.tools',
  )

  const ui = value['ui'] as unknown[]
  for (let i = 0; i < ui.length; i += 1) {
    const u = ui[i]
    const label = `manifest.ui[${i}]`
    if (!isPlainObject(u)) throw invalidManifest(`${label} must be a plain object`)
    assertAllowedKeys(u, UI_ITEM_KEYS, label)
    const surface = assertSafeIdentifier(u['surface'], `${label}.surface`)
    if (!KNOWN_UI_SURFACE_SET.has(surface)) {
      throw invalidManifest(`${label}.surface "${surface}" is not a known plugin UI surface`)
    }
    const itemId = assertNonEmptyString(u['id'], `${label}.id`)
    if (!isPlainObject(u['spec'])) throw invalidManifest(`${label}.spec must be a plain object`)
    if (u['spec']['id'] !== itemId) {
      throw invalidManifest(`${label}.spec.id must match ${label}.id`)
    }
  }
  assertStrictlySortedUnique(
    ui as PluginManifestUiItem[],
    (u) => `${u.surface}\u0000${u.id}`,
    (a, b) => compareCodeUnit(a.surface, b.surface) || compareCodeUnit(a.id, b.id),
    'manifest.ui',
  )

  const routes = value['routes'] as unknown[]
  for (let i = 0; i < routes.length; i += 1) {
    const r = routes[i]
    if (!isPlainObject(r)) throw invalidManifest(`manifest.routes[${i}] must be a plain object`)
    assertAllowedKeys(r, ROUTE_KEYS, `manifest.routes[${i}]`)
    if (typeof r['method'] !== 'string' || !ROUTE_METHODS.has(r['method'])) {
      throw invalidManifest(`manifest.routes[${i}].method must be GET | POST | PUT | DELETE`)
    }
    assertNonEmptyString(r['path'], `manifest.routes[${i}].path`)
    if (typeof r['public'] !== 'boolean') {
      throw invalidManifest(`manifest.routes[${i}].public must be a boolean`)
    }
  }
  assertStrictlySortedUnique(
    routes as PluginManifestRoute[],
    (r) => `${r.method}\u0000${r.path}`,
    (a, b) => compareCodeUnit(a.path, b.path) || compareCodeUnit(a.method, b.method),
    'manifest.routes',
  )

  const docs = value['docs'] as unknown[]
  for (let i = 0; i < docs.length; i += 1) {
    const d = docs[i]
    if (!isPlainObject(d)) throw invalidManifest(`manifest.docs[${i}] must be a plain object`)
    assertAllowedKeys(d, DOC_KEYS, `manifest.docs[${i}]`)
    assertSafeIdentifier(d['name'], `manifest.docs[${i}].name`)
    if (d['kind'] !== 'doc' && d['kind'] !== 'sessionDoc') {
      throw invalidManifest(`manifest.docs[${i}].kind must be doc | sessionDoc`)
    }
    if (d['public'] !== true) {
      throw invalidManifest(`manifest.docs[${i}].public must be true (private docs must not be projected)`)
    }
    if (typeof d['durable'] !== 'boolean') {
      throw invalidManifest(`manifest.docs[${i}].durable must be a boolean`)
    }
  }
  assertStrictlySortedUnique(
    docs as PluginManifestDoc[],
    (d) => `${d.kind}\u0000${d.name}`,
    (a, b) => compareCodeUnit(a.kind, b.kind) || compareCodeUnit(a.name, b.name),
    'manifest.docs',
  )

  const configFields = value['configFields'] as unknown[]
  for (let i = 0; i < configFields.length; i += 1) {
    const f = configFields[i]
    const label = `manifest.configFields[${i}]`
    if (!isPlainObject(f)) throw invalidManifest(`${label} must be a plain object`)
    assertAllowedKeys(f, CONFIG_FIELD_KEYS, label)
    assertSafeIdentifier(f['key'], `${label}.key`)
    if (typeof f['type'] !== 'string' || !CONFIG_TYPES.has(f['type'])) {
      throw invalidManifest(`${label}.type must be string | number | boolean`)
    }
    if (typeof f['secret'] !== 'boolean') throw invalidManifest(`${label}.secret must be boolean`)
    if (typeof f['required'] !== 'boolean') throw invalidManifest(`${label}.required must be boolean`)
    if (f['label'] !== undefined && parseNonEmptyLocalizedText(f['label']) === undefined) {
      throw invalidManifest(`${label}.label must be valid non-empty LocalizedText when present`)
    }
    if (f['description'] !== undefined && parseNonEmptyLocalizedText(f['description']) === undefined) {
      throw invalidManifest(`${label}.description must be valid non-empty LocalizedText when present`)
    }
    if (f['secret'] === true && Object.hasOwn(f, 'default')) {
      throw invalidManifest(`${label} secret field must not expose default`)
    }
    if (f['default'] !== undefined) {
      if (typeof f['default'] !== f['type'] || (typeof f['default'] === 'number' && !Number.isFinite(f['default']))) {
        throw invalidManifest(`${label}.default must match field type ${f['type']}`)
      }
    }
    if (f['format'] !== undefined) {
      if (f['type'] !== 'string' || typeof f['format'] !== 'string' || !CONFIG_FORMATS.has(f['format'])) {
        throw invalidManifest(`${label}.format is invalid`)
      }
    }
    for (const bound of ['minimum', 'maximum'] as const) {
      if (f[bound] !== undefined) {
        if (f['type'] !== 'number' || typeof f[bound] !== 'number' || !Number.isFinite(f[bound])) {
          throw invalidManifest(`${label}.${bound} must be a finite number on number fields`)
        }
      }
    }
    if (f['integer'] !== undefined) {
      if (f['type'] !== 'number' || typeof f['integer'] !== 'boolean') {
        throw invalidManifest(`${label}.integer must be a boolean on number fields`)
      }
    }
  }
  assertStrictlySortedUnique(
    configFields as PluginManifestConfigField[],
    (f) => f.key,
    (a, b) => compareCodeUnit(a.key, b.key),
    'manifest.configFields',
  )

  const providers = value['providers'] as unknown[]
  for (let i = 0; i < providers.length; i += 1) {
    const p = providers[i]
    if (!isPlainObject(p)) throw invalidManifest(`manifest.providers[${i}] must be a plain object`)
    assertAllowedKeys(p, PROVIDER_KEYS, `manifest.providers[${i}]`)
    assertSafeIdentifier(p['id'], `manifest.providers[${i}].id`)
    assertNonEmptyString(p['name'], `manifest.providers[${i}].name`)
  }
  assertStrictlySortedUnique(
    providers as PluginManifestProvider[],
    (p) => p.id,
    (a, b) => compareCodeUnit(a.id, b.id),
    'manifest.providers',
  )

  const services = value['services'] as unknown[]
  for (let i = 0; i < services.length; i += 1) {
    assertSafeIdentifier(services[i], `manifest.services[${i}]`)
  }
  assertStrictlySortedUnique(services as string[], (s) => s, compareCodeUnit, 'manifest.services')

  const clientModules = value['clientModules'] as unknown[]
  for (let i = 0; i < clientModules.length; i += 1) {
    const c = clientModules[i]
    if (!isPlainObject(c)) throw invalidManifest(`manifest.clientModules[${i}] must be a plain object`)
    assertAllowedKeys(c, CLIENT_MODULE_KEYS, `manifest.clientModules[${i}]`)
    assertNonEmptyString(c['module'], `manifest.clientModules[${i}].module`)
    if (c['contentHash'] !== undefined) assertNonEmptyString(c['contentHash'], `manifest.clientModules[${i}].contentHash`)
  }
  assertStrictlySortedUnique(
    clientModules as PluginManifestClientModule[],
    (c) => c.module,
    (a, b) => compareCodeUnit(a.module, b.module),
    'manifest.clientModules',
  )

  return value as unknown as PluginManifestProjection
}
