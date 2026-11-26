/**
 * Pure state, validation, navigation, and formatting helpers for AskDock & ResolvedAskRow
 * (zero React/DOM dependencies; Fast Refresh compliant).
 */
import {
  resolveLocalizedText,
  type AskAnswers,
  type AskAnswerValue,
  type AskFieldSpec,
  type AskKind,
  type AskSpec,
  type HelmxLocale,
} from '@helmx/protocol/browser'

export interface TerminalSnapshot {
  source: 'context' | 'description'
  text: string
  prefix?: string
}

function lastLines(text: string, max: number): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.length <= max ? lines.join('\n') : lines.slice(-max).join('\n')
}

/**
 * Extract the terminal snapshot (last 40 lines) from the ask extension field
 * `terminalSnapshot` or from a fenced block in resolved `descriptionText`.
 */
export function extractTerminalSnapshot(ask: AskSpec, descriptionText: string): TerminalSnapshot | undefined {
  const extra = ask as AskSpec & { context?: { terminalSnapshot?: unknown } }
  const fromContext = extra.context?.terminalSnapshot
  if (typeof fromContext === 'string' && fromContext.trim() !== '') {
    return { source: 'context', text: lastLines(fromContext, 40) }
  }
  const marker = descriptionText.indexOf('```')
  if (marker !== -1) {
    const prefix = descriptionText.slice(0, marker).trim()
    let body = descriptionText.slice(marker + 3)
    const firstNewline = body.indexOf('\n')
    if (firstNewline !== -1) {
      body = body.slice(firstNewline + 1)
    }
    const closing = body.lastIndexOf('```')
    if (closing !== -1) {
      body = body.slice(0, closing)
    }
    if (body.trim() !== '') {
      return { source: 'description', text: lastLines(body, 40), ...(prefix !== '' ? { prefix } : {}) }
    }
  }
  return undefined
}

export function resolveAskKind(ask: Pick<AskSpec, 'kind'>): AskKind {
  return ask.kind === 'question' ? 'question' : 'approval'
}

export function isMultiChoiceField(field: AskFieldSpec): boolean {
  return field.type === 'choice' && field.multiple === true
}

export function shouldUseQuestionStepper(ask: Pick<AskSpec, 'kind' | 'fields'>): boolean {
  return resolveAskKind(ask) === 'question' && ask.fields.length >= 2
}

export function initialAskAnswers(fields: ReadonlyArray<AskFieldSpec>): AskAnswers {
  const initial: AskAnswers = {}
  for (const field of fields) {
    if (isMultiChoiceField(field)) {
      if (Array.isArray(field.defaultValue) && field.defaultValue.length > 0) {
        initial[field.name] = [...field.defaultValue]
      }
    } else if (typeof field.defaultValue === 'string' && field.defaultValue !== '') {
      initial[field.name] = field.defaultValue
    }
  }
  return initial
}

export function isFieldAnswered(field: AskFieldSpec, answers: AskAnswers): boolean {
  const val = answers[field.name]
  if (isMultiChoiceField(field)) {
    return Array.isArray(val) && val.some((item) => item.trim() !== '')
  }
  return typeof val === 'string' && val.trim() !== ''
}

export function missingRequiredFields(ask: Pick<AskSpec, 'fields'>, answers: AskAnswers): AskFieldSpec[] {
  return ask.fields.filter((f) => f.required === true && !isFieldAnswered(f, answers))
}

/** Find the next unanswered step index after `fromIndex` (wrapping around), or `-1` if all steps are answered. */
export function findNextUnansweredStep(
  ask: Pick<AskSpec, 'fields'>,
  answers: AskAnswers,
  fromIndex: number,
): number {
  const total = ask.fields.length
  if (total === 0) return -1
  for (let offset = 1; offset < total; offset++) {
    const idx = (fromIndex + offset) % total
    const field = ask.fields[idx]
    if (field !== undefined && !isFieldAnswered(field, answers)) {
      return idx
    }
  }
  return -1
}

export function isSingleRequiredConfirm(ask: Pick<AskSpec, 'fields'>): boolean {
  return ask.fields.length === 1 && ask.fields[0]?.type === 'confirm' && ask.fields[0].required !== false
}

export function isPresetOptionValue(field: AskFieldSpec, value: string): boolean {
  return (field.options ?? []).some((o) => o.value === value)
}

/** Build the ordered multi-select array from preset selections and an optional custom text entry. */
export function composeMultiChoiceValues(
  field: AskFieldSpec,
  selectedPresets: ReadonlyArray<string>,
  customText: string | undefined,
): string[] {
  const presetOrder = new Set<string>()
  const out: string[] = []
  for (const val of selectedPresets) {
    if (isPresetOptionValue(field, val) && !presetOrder.has(val)) {
      presetOrder.add(val)
      out.push(val)
    }
  }
  const trimmedCustom = customText?.trim() ?? ''
  if (trimmedCustom !== '' && !presetOrder.has(trimmedCustom)) {
    out.push(trimmedCustom)
  }
  return out
}

export function formatAskAnswerSummary(
  field: AskFieldSpec,
  value: AskAnswerValue | undefined,
  locale: HelmxLocale,
  labels: { skipped: string; yes: string; no: string },
): string {
  if (isMultiChoiceField(field)) {
    const list = Array.isArray(value) ? value.map((item) => item.trim()).filter((item) => item !== '') : []
    if (list.length === 0) return labels.skipped
    return list
      .map((item) => {
        const match = (field.options ?? []).find((o) => o.value === item)
        return match !== undefined ? resolveLocalizedText(match.label, locale) : item
      })
      .join(', ')
  }

  const str = typeof value === 'string' ? value.trim() : ''
  if (str === '') return labels.skipped

  if (field.type === 'choice' || field.type === 'select') {
    const match = (field.options ?? []).find((o) => o.value === str)
    return match !== undefined ? resolveLocalizedText(match.label, locale) : str
  }
  if (field.type === 'confirm') {
    if (str === 'true') {
      return field.confirmLabel !== undefined ? resolveLocalizedText(field.confirmLabel, locale) : labels.yes
    }
    if (str === 'false') {
      return field.rejectLabel !== undefined ? resolveLocalizedText(field.rejectLabel, locale) : labels.no
    }
  }
  return str
}
