/**
 * Pure bilingual extraction and text helpers shared across Omnibox catalog sources.
 */
import { HELMX_LOCALES, resolveLocalizedText, type HelmxLocale, type LocalizedText } from '@helmx/protocol/browser'

/** Extracts every non-empty localized variant from a `LocalizedText` for bilingual indexing. */
export function extractLocalizedStrings(text: LocalizedText | undefined): string[] {
  if (text === undefined) return []
  if (typeof text === 'string') {
    const trimmed = text.trim()
    return trimmed !== '' ? [trimmed] : []
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const loc of HELMX_LOCALES) {
    const val = text[loc]
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (trimmed !== '' && !seen.has(trimmed)) {
        seen.add(trimmed)
        out.push(trimmed)
      }
    }
  }
  for (const val of Object.values(text)) {
    if (typeof val === 'string') {
      const trimmed = val.trim()
      if (trimmed !== '' && !seen.has(trimmed)) {
        seen.add(trimmed)
        out.push(trimmed)
      }
    }
  }
  return out
}

export function resolveOptionalLocalizedText(
  text: LocalizedText | undefined,
  locale: HelmxLocale,
): string | undefined {
  if (text === undefined) return undefined
  const resolved = resolveLocalizedText(text, locale).trim()
  return resolved !== '' ? resolved : undefined
}

export function dedupeStrings(values: ReadonlyArray<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed === '') continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}
