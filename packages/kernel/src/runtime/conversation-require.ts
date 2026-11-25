/**
 * Centralized 404 existence guard for conversation records (shared across runtime services).
 */
import { HelmxError } from '@helmx/protocol'
import type { HelmxStore } from './store.js'

/** `store.getConv` + 404 check (centralized helper replacing 15+ inline checks). */
export function requireConv(store: HelmxStore, id: number): NonNullable<ReturnType<HelmxStore['getConv']>> {
  const meta = store.getConv(id)
  if (!meta) throw new HelmxError('not_found', `Conversation not found: ${id}`, 404)
  return meta
}
