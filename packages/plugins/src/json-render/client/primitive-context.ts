/**
 * Shared render context and small value helpers for builtin:json-render primitives.
 */
import type { ReactNode } from 'react'
import { resolveLocalizedText, type HelmxLocale, type LocalizedText } from '@helmx/ui'
import { evaluateSpecValue, type EvalScope } from './evaluator.ts'
import type { NormalizedSpecNode } from './spec-normalize.ts'

export interface SpecRenderContext {
  /** Property evaluation scope ($docs / $sessionDocs / $data / $row / $value). */
  scope: EvalScope
  /** Active host UI locale for plugin chrome copy; spec-declared text passes through untranslated. */
  locale: HelmxLocale
  /** Current conversation context (`Slot` passes it to sub-slot contributions for scope filtering). */
  conversationId?: number
  /** Owning plugin of the current render view (`Slot` resolves short names into full slot names). */
  pluginId?: string
  /** Child-tree render entry (primitives compose with each other). */
  renderChildren(children: NormalizedSpecNode[]): ReactNode
  /** Execute one declarative action directive; buttons sharing a pendingKey enter loading. */
  runAction(rawAction: unknown, scope: EvalScope, pendingKey: string): void
  /** Whether the action for this pendingKey is executing (loading double-click guard). */
  isPending(pendingKey: string): boolean
  /** Whether the action for this pendingKey just succeeded (in-place confirmation state). */
  isSucceeded?(pendingKey: string): boolean
}

export function tr(ctx: SpecRenderContext, text: LocalizedText): string {
  return resolveLocalizedText(text, ctx.locale)
}

export function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

export function bool(value: unknown): boolean {
  return value === true
}

export function ownProp<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined
}

export function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Re-evaluate inside a primitive (e.g. $row injection for Table row actions). */
export function evalIn<T>(template: unknown, scope: EvalScope): T {
  return evaluateSpecValue<T>(template, scope)
}

export const strictEquals = (a: unknown, b: unknown): boolean => a === b

export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) {
    if (!b.has(v)) return false
  }
  return true
}
