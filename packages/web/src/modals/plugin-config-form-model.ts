/**
 * Pure data model for the plugin config form (consumed by PluginDetailDrawer
 * / PluginCenter).
 *
 * Server contract for secret fields: GET config only returns the '******'
 * mask (configured) or an empty string (unconfigured); plaintext never leaves
 * the server. The form side therefore obeys two hard rules:
 * 1. The mask must never be poured into the form as a real value — one
 *    unchanged save would write six asterisks into credentials.json,
 *    overwriting the real key;
 * 2. On save, an empty secret string means "unchanged, keep the stored key";
 *    the field is only submitted when the user types a new value.
 */

import type {
  NodeInfo,
  PluginConfigFieldSchema,
  PluginConfigFieldSource,
  PluginConfigFieldValue,
  Profile,
} from '@helmx/protocol/browser'
import type { SelectOption } from '@helmx/ui'
import type { WebMessageTranslator } from '../i18n/catalog.js'

export type ConfigValue = PluginConfigFieldValue

/** Parse multiline textarea text into trimmed non-empty string[] entries. */
export function parseStringArrayInput(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** Format string[] entries for multiline textarea display (one item per line). */
export function formatStringArrayInput(value: ConfigValue | undefined): string {
  if (Array.isArray(value)) return value.join('\n')
  return value === undefined ? '' : String(value)
}

/** Initial form values: secrets always empty; non-secrets echo the server value or the schema default. */
export function configFieldInitialValue(
  schemaField: Pick<PluginConfigFieldSchema, 'default' | 'type' | 'secret'>,
  raw: unknown,
): ConfigValue {
  if (schemaField.secret === true) return ''
  if (schemaField.type === 'string[]') {
    if (Array.isArray(raw)) {
      return raw.map((item) => (typeof item === 'string' ? item : String(item)))
    }
    if (Array.isArray(schemaField.default)) return [...schemaField.default]
    return []
  }
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw
    return String(raw)
  }
  if (schemaField.default !== undefined) {
    return Array.isArray(schemaField.default) ? [...schemaField.default] : schemaField.default
  }
  return schemaField.type === 'boolean' ? false : schemaField.type === 'number' ? 0 : ''
}

/** Server-side mask ('******'): the fixed GET config echo for a configured secret. */
export const SECRET_MASK = '******'
export function secretConfigured(raw: unknown): boolean {
  return typeof raw === 'string' && raw.length > 0
}

/**
 * Save payload: non-secret fields are submitted in full (existing merge
 * semantics preserved); secret fields are submitted only when the user typed
 * a non-empty new value. Masks and empty strings never enter the payload.
 */
export function buildPluginConfigPayload(
  schema: Record<string, PluginConfigFieldSchema>,
  values: Record<string, ConfigValue>,
): Record<string, ConfigValue> {
  const payload: Record<string, ConfigValue> = {}
  for (const [key, field] of Object.entries(schema)) {
    const value = values[key]
    if (field.secret === true) {
      // Mask and blank both count as "unchanged": even if an abnormal path
      // poured the mask into the form, it must never reach the credential store.
      const trimmed = typeof value === 'string' ? value.trim() : ''
      if (trimmed.length > 0 && trimmed !== SECRET_MASK) payload[key] = trimmed
      continue
    }
    if (value === undefined) continue
    if (field.type === 'string[]') {
      if (Array.isArray(value)) {
        payload[key] =
          field.enum !== undefined
            ? [...value]
            : value.map((item) => item.trim()).filter((item) => item.length > 0)
      } else {
        payload[key] = parseStringArrayInput(String(value))
      }
      continue
    }
    payload[key] = value
  }
  return payload
}

/**
 * Whether a single field can be reset:
 * - source === 'configured': an explicit user override key exists on disk;
 *   sending null clears it;
 * - without sources (older kernels), a configured secret field (mask echo
 *   non-empty) is also resettable so credentials can be revoked.
 */
export function canResetConfigField(
  fieldSchema: PluginConfigFieldSchema,
  source?: PluginConfigFieldSource,
  rawValue?: unknown,
): boolean {
  if (source === 'configured') return true
  if (source !== undefined) return false
  return fieldSchema.secret === true && secretConfigured(rawValue)
}

/** Reset payload for a single field: send { [key]: null } to clear the explicit override and fall back to schema.default. */
export function buildResetFieldPayload(key: string): Record<string, null> {
  return { [key]: null }
}

/**
 * Select options for configSchema `format: 'node'`: the host node registry
 * snapshot (online nodes labeled by id, offline ones called out honestly).
 * Empty value = not set; a persisted id missing from the registry stays
 * selectable as "(not found)" instead of being silently dropped.
 */
export function buildNodeConfigOptions(
  nodes: readonly NodeInfo[],
  currentNode: string | undefined,
  t: WebMessageTranslator,
): SelectOption<string>[] {
  const list: SelectOption<string>[] = [{ value: '', label: t('plugins.config.unsetOption') }]
  for (const node of nodes) {
    list.push({
      value: node.id,
      label: node.online ? node.id : t('plugins.config.nodeOffline', { node: node.id }),
    })
  }
  appendMissingReference(list, currentNode, t)
  return list
}

/**
 * Select options for configSchema `format: 'profile'`: the host Profile list.
 * Empty value = not set; a persisted id missing from the list stays selectable
 * as "(not found)" instead of being silently dropped.
 */
export function buildProfileConfigOptions(
  profiles: readonly Profile[],
  currentProfile: string | undefined,
  t: WebMessageTranslator,
): SelectOption<string>[] {
  const list: SelectOption<string>[] = [{ value: '', label: t('plugins.config.unsetOption') }]
  for (const profile of profiles) {
    list.push({
      value: profile.id,
      label: profile.name !== undefined && profile.name !== '' ? `${profile.name} (${profile.id})` : profile.id,
    })
  }
  appendMissingReference(list, currentProfile, t)
  return list
}

/**
 * Select / MultiSelect options for configSchema `enum` declarations.
 * Preserves any persisted-but-unlisted value honestly instead of silently dropping it.
 */
export function buildEnumConfigOptions(
  enumValues: readonly (string | number)[],
  currentValues: readonly (string | number)[] = [],
  t: WebMessageTranslator,
): SelectOption<string>[] {
  const list: SelectOption<string>[] = enumValues.map((entry) => {
    const value = String(entry)
    return { value, label: value }
  })
  for (const current of currentValues) {
    appendMissingReference(list, String(current), t)
  }
  return list
}

/** Keep a configured-but-unlisted reference visible: honest fallback, never silently rewritten. */
function appendMissingReference(
  list: SelectOption<string>[],
  current: string | undefined,
  tt: WebMessageTranslator,
): void {
  const trimmed = current?.trim() ?? ''
  if (trimmed !== '' && !list.some((o) => o.value === trimmed)) {
    list.push({ value: trimmed, label: tt('plugins.config.referenceNotFound', { value: trimmed }) })
  }
}
