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

import type { NodeInfo, PluginConfigFieldSchema, PluginConfigFieldSource, Profile } from '@helmx/protocol/browser'
import type { SelectOption } from '@helmx/plugin-client'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

export type ConfigValue = string | number | boolean

/** Initial form values: secrets always empty; non-secrets echo the server value or the schema default. */
export function configFieldInitialValue(
  schemaField: Pick<PluginConfigFieldSchema, 'default' | 'type' | 'secret'>,
  raw: unknown,
): ConfigValue {
  if (schemaField.secret === true) return ''
  if (raw !== undefined && raw !== null) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw
    return String(raw)
  }
  if (schemaField.default !== undefined) return schemaField.default
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
    if (value !== undefined) payload[key] = value
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
  currentNode?: string,
  t?: WebMessageTranslator,
): SelectOption<string>[] {
  const tt = t ?? englishWebTranslator
  const list: SelectOption<string>[] = [{ value: '', label: tt('plugins.config.unsetOption') }]
  for (const node of nodes) {
    list.push({
      value: node.id,
      label: node.online ? node.id : tt('plugins.config.nodeOffline', { node: node.id }),
    })
  }
  appendMissingReference(list, currentNode, tt)
  return list
}

/**
 * Select options for configSchema `format: 'profile'`: the host Profile list.
 * Empty value = not set; a persisted id missing from the list stays selectable
 * as "(not found)" instead of being silently dropped.
 */
export function buildProfileConfigOptions(
  profiles: readonly Profile[],
  currentProfile?: string,
  t?: WebMessageTranslator,
): SelectOption<string>[] {
  const tt = t ?? englishWebTranslator
  const list: SelectOption<string>[] = [{ value: '', label: tt('plugins.config.unsetOption') }]
  for (const profile of profiles) {
    list.push({
      value: profile.id,
      label: profile.name !== undefined && profile.name !== '' ? `${profile.name} (${profile.id})` : profile.id,
    })
  }
  appendMissingReference(list, currentProfile, tt)
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
