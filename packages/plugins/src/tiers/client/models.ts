/** Pure state parsing, card synthesis, filtering, validation, and starter preset builders for builtin:tiers client. */
import type { HelmxLocale, HostModelEntry, ModelTierSpec } from '@helmx/protocol/browser'

export const TIERS_PLUGIN_ID = 'builtin:tiers' as const
export const TIERS_STATE_DOC = 'state' as const
export const TIERS_SCREEN_ID = 'main' as const
const TIER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/
const TIER_TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/
export const ORCHESTRATOR_DEFAULT_MAX_STEPS = 30
export const ORCHESTRATOR_MAX_STEPS_LIMIT = 100

export type TiersManagerTab = 'tiers' | 'templates'
export type TierKindFilter = 'all' | 'single' | 'orchestrator'
export type TierAvailabilityStatus = 'available' | 'disabled' | 'unavailable'

export interface TierTemplateView {
  id: string
  name: string
  description?: string
  tiers: Record<string, ModelTierSpec>
  updatedAt: number
}

export interface TierItemView {
  id: string
  spec: ModelTierSpec
  kind: 'single' | 'orchestrator'
  status: TierAvailabilityStatus
}

export interface StarterTierPreset {
  id: string
  suggestedThinkingLevel: string
  description: string
}

export interface TierFormDraft {
  id: string
  kind: 'single' | 'orchestrator'
  model: string
  thinkingLevel: string
  suggestedThinkingLevel: string
  executorModel: string
  executorThinkingLevel: string
  maxExecutionSteps: string
  description: string
}

export interface SetTierActionInput {
  id: string
  kind: 'single' | 'orchestrator'
  model: string
  thinkingLevel?: string
  executorModel?: string
  executorThinkingLevel?: string
  maxExecutionSteps?: number
  description?: string
}

export interface ParsedTiersDoc {
  tiers: Record<string, ModelTierSpec>
  templates: TierTemplateView[]
  activeTemplate?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export function parseTiersStateDoc(raw: unknown): ParsedTiersDoc {
  if (!isRecord(raw)) return { tiers: {}, templates: [] }
  const tiers: Record<string, ModelTierSpec> = {}
  if (isRecord(raw.tiers)) {
    for (const [id, rawSpec] of Object.entries(raw.tiers)) {
      if (!isRecord(rawSpec) || typeof rawSpec.model !== 'string') continue
      const base: ModelTierSpec = {
        model: rawSpec.model,
        ...(typeof rawSpec.thinkingLevel === 'string' && rawSpec.thinkingLevel ? { thinkingLevel: rawSpec.thinkingLevel } : {}),
        ...(typeof rawSpec.description === 'string' && rawSpec.description ? { description: rawSpec.description } : {}),
      }
      if (rawSpec.kind === 'orchestrator' && typeof rawSpec.executorModel === 'string' && rawSpec.executorModel) {
        const steps =
          typeof rawSpec.maxExecutionSteps === 'number' &&
          Number.isInteger(rawSpec.maxExecutionSteps) &&
          rawSpec.maxExecutionSteps >= 0 &&
          rawSpec.maxExecutionSteps <= ORCHESTRATOR_MAX_STEPS_LIMIT
            ? rawSpec.maxExecutionSteps
            : ORCHESTRATOR_DEFAULT_MAX_STEPS
        tiers[id] = {
          ...base,
          kind: 'orchestrator',
          executorModel: rawSpec.executorModel,
          ...(typeof rawSpec.executorThinkingLevel === 'string' && rawSpec.executorThinkingLevel
            ? { executorThinkingLevel: rawSpec.executorThinkingLevel }
            : {}),
          maxExecutionSteps: steps,
        }
      } else {
        tiers[id] = base
      }
    }
  }
  const templates: TierTemplateView[] = []
  if (isRecord(raw.templates)) {
    for (const rawTpl of Object.values(raw.templates)) {
      if (!isRecord(rawTpl) || typeof rawTpl.id !== 'string' || typeof rawTpl.name !== 'string') continue
      templates.push({
        id: rawTpl.id,
        name: rawTpl.name,
        ...(typeof rawTpl.description === 'string' && rawTpl.description ? { description: rawTpl.description } : {}),
        tiers: isRecord(rawTpl.tiers) ? (rawTpl.tiers as Record<string, ModelTierSpec>) : {},
        updatedAt: typeof rawTpl.updatedAt === 'number' && Number.isFinite(rawTpl.updatedAt) ? rawTpl.updatedAt : 0,
      })
    }
  }
  templates.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  return {
    tiers,
    templates,
    ...(typeof raw.activeTemplate === 'string' && raw.activeTemplate ? { activeTemplate: raw.activeTemplate } : {}),
  }
}

const STARTER_TIERS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['scout', '', '仓库摸底、大范围代码与日志检索、文档汇总及轻量机械任务；高吞吐低成本，禁止用于架构拍板或复杂改写', 'Codebase reconnaissance, broad search, log scanning, and lightweight synthesis; fast/high-quota, avoid complex edits or architecture decisions'],
  ['coder', 'high', '方案明确的功能开发、模块改写、测试编写与常规排错；日常主力实现首选', 'Well-scoped feature implementation, test writing, refactoring, and routine debugging; default engineering workhorse'],
  ['senior', 'xhigh', '跨模块复杂实现、高难度重构，或 coder 失败后的第一级升级攻坚；次主力强档', 'Complex cross-module implementation, hard refactoring, or first-step escalation after coder gate failures'],
  ['architect', 'high', '核心架构设计、关键契约拍板、fork 专家会诊与终极疑难定性；高成本顶配档，常规检索与普通编码勿用', 'Core architecture design, critical contract trade-offs, fork expert consultation, and toughest root-cause diagnosis; flagship cost, high-leverage only'],
  ['reviewer', 'xhigh', '高标准独立 Code Review、并发与边界漏洞挑刺、合入前验收把关；成本高但审查极强，仅在验收节点调用', 'Independent high-bar code review, concurrency/edge-case hunting, and pre-merge verification; use selectively at review gates'],
]

export function getStarterTierPresets(locale: HelmxLocale): StarterTierPreset[] {
  const zh = locale === 'zh-CN'
  return STARTER_TIERS.map(([id, suggestedThinkingLevel, zhDesc, enDesc]) => ({
    id,
    suggestedThinkingLevel,
    description: zh ? zhDesc : enDesc,
  }))
}

export function createEmptyTierDraft(preset?: StarterTierPreset): TierFormDraft {
  return {
    id: preset?.id ?? '',
    kind: 'single',
    model: '',
    thinkingLevel: '',
    suggestedThinkingLevel: preset?.suggestedThinkingLevel ?? '',
    executorModel: '',
    executorThinkingLevel: '',
    maxExecutionSteps: String(ORCHESTRATOR_DEFAULT_MAX_STEPS),
    description: preset?.description ?? '',
  }
}

export function tierSpecToDraft(id: string, spec: ModelTierSpec): TierFormDraft {
  return {
    id,
    kind: spec.kind === 'orchestrator' ? 'orchestrator' : 'single',
    model: spec.model,
    thinkingLevel: spec.thinkingLevel ?? '',
    suggestedThinkingLevel: '',
    executorModel: spec.executorModel ?? '',
    executorThinkingLevel: spec.executorThinkingLevel ?? '',
    maxExecutionSteps: String(spec.maxExecutionSteps ?? ORCHESTRATOR_DEFAULT_MAX_STEPS),
    description: spec.description ?? '',
  }
}

export function isTierDraftDirty(
  draft: TierFormDraft,
  savedId: string | undefined,
  savedSpec: ModelTierSpec | undefined,
): boolean {
  if (savedId === undefined || savedSpec === undefined) return true
  const savedKind: 'single' | 'orchestrator' = savedSpec.kind === 'orchestrator' ? 'orchestrator' : 'single'
  if (
    draft.id.trim() !== savedId ||
    draft.kind !== savedKind ||
    draft.model.trim() !== savedSpec.model ||
    draft.thinkingLevel.trim() !== (savedSpec.thinkingLevel ?? '') ||
    draft.description.trim() !== (savedSpec.description ?? '')
  ) {
    return true
  }
  if (draft.kind === 'orchestrator') {
    const stepsRaw = draft.maxExecutionSteps.trim()
    const parsedSteps = stepsRaw === '' ? ORCHESTRATOR_DEFAULT_MAX_STEPS : Number.parseInt(stepsRaw, 10)
    return (
      draft.executorModel.trim() !== (savedSpec.executorModel ?? '') ||
      draft.executorThinkingLevel.trim() !== (savedSpec.executorThinkingLevel ?? '') ||
      parsedSteps !== (savedSpec.maxExecutionSteps ?? ORCHESTRATOR_DEFAULT_MAX_STEPS)
    )
  }
  return false
}

export type TierDraftValidationError =
  | 'id_required'
  | 'duplicate_id'
  | 'model_required'
  | 'executor_required'
  | 'max_steps_invalid'

export function validateTierDraft(
  draft: TierFormDraft,
  options: { mode: 'create' | 'edit'; existingIds: ReadonlySet<string> },
): { ok: true; payload: SetTierActionInput } | { ok: false; code: TierDraftValidationError } {
  const id = draft.id.trim()
  if (!TIER_ID_PATTERN.test(id)) return { ok: false, code: 'id_required' }
  if (options.mode === 'create' && options.existingIds.has(id)) {
    return { ok: false, code: 'duplicate_id' }
  }
  const model = draft.model.trim()
  if (!model.includes('/')) return { ok: false, code: 'model_required' }
  const thinkingLevel = draft.thinkingLevel.trim()
  const description = draft.description.trim()
  if (draft.kind === 'single') {
    return {
      ok: true,
      payload: {
        id,
        kind: 'single',
        model,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(description ? { description } : {}),
      },
    }
  }
  const executorModel = draft.executorModel.trim()
  if (!executorModel.includes('/')) return { ok: false, code: 'executor_required' }
  const executorThinkingLevel = draft.executorThinkingLevel.trim()
  const stepsRaw = draft.maxExecutionSteps.trim()
  let maxExecutionSteps = ORCHESTRATOR_DEFAULT_MAX_STEPS
  if (stepsRaw !== '') {
    if (!/^\d+$/.test(stepsRaw)) return { ok: false, code: 'max_steps_invalid' }
    const parsed = Number.parseInt(stepsRaw, 10)
    if (parsed < 0 || parsed > ORCHESTRATOR_MAX_STEPS_LIMIT) {
      return { ok: false, code: 'max_steps_invalid' }
    }
    maxExecutionSteps = parsed
  }
  return {
    ok: true,
    payload: {
      id,
      kind: 'orchestrator',
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
      executorModel,
      ...(executorThinkingLevel ? { executorThinkingLevel } : {}),
      maxExecutionSteps,
      ...(description ? { description } : {}),
    },
  }
}

export function validateTemplateForm(input: {
  id: string
  name: string
  description: string
}): { ok: true; payload: { id: string; name: string; description?: string } } | { ok: false; code: 'template_fields_required' | 'template_id_invalid' } {
  const id = input.id.trim()
  const name = input.name.trim()
  const description = input.description.trim()
  if (!id || !name) return { ok: false, code: 'template_fields_required' }
  if (!TIER_TEMPLATE_ID_PATTERN.test(id)) return { ok: false, code: 'template_id_invalid' }
  return { ok: true, payload: { id, name, ...(description ? { description } : {}) } }
}

function resolveSingleRefStatus(modelRef: string, models: ReadonlyArray<HostModelEntry>): 'draft' | TierAvailabilityStatus {
  const trimmed = modelRef.trim()
  if (!trimmed) return 'draft'
  const entry = models.find((m) => m.id === trimmed)
  if (!entry) return 'unavailable'
  if (entry.disabled === true) return 'disabled'
  return entry.available ? 'available' : 'unavailable'
}

export function resolveTierRowStatus(
  rowOrModel: string | { kind: 'single' | 'orchestrator'; model: string; executorModel: string },
  models: ReadonlyArray<HostModelEntry>,
): 'draft' | TierAvailabilityStatus {
  if (typeof rowOrModel === 'string') {
    return resolveSingleRefStatus(rowOrModel, models)
  }
  const primary = resolveSingleRefStatus(rowOrModel.model, models)
  if (rowOrModel.kind !== 'orchestrator') return primary
  const executor = resolveSingleRefStatus(rowOrModel.executorModel, models)
  if (primary === 'draft' || executor === 'draft') return 'draft'
  if (primary === 'disabled' || executor === 'disabled') return 'disabled'
  if (primary === 'unavailable' || executor === 'unavailable') return 'unavailable'
  return 'available'
}

export function synthesizeTierItems(
  tiers: Readonly<Record<string, ModelTierSpec>>,
  models: ReadonlyArray<HostModelEntry>,
): TierItemView[] {
  return Object.entries(tiers).map(([id, spec]) => {
    const kind: 'single' | 'orchestrator' = spec.kind === 'orchestrator' ? 'orchestrator' : 'single'
    const rawStatus = resolveTierRowStatus(
      { kind, model: spec.model, executorModel: spec.executorModel ?? '' },
      models,
    )
    return {
      id,
      spec,
      kind,
      status: rawStatus === 'draft' ? 'unavailable' : rawStatus,
    }
  })
}

export function countTierItemsByKind(items: ReadonlyArray<TierItemView>): {
  all: number
  single: number
  orchestrator: number
} {
  let single = 0
  let orchestrator = 0
  for (const item of items) {
    if (item.kind === 'orchestrator') orchestrator += 1
    else single += 1
  }
  return { all: items.length, single, orchestrator }
}

export function filterTierItems(
  items: ReadonlyArray<TierItemView>,
  opts: { query: string; kindFilter: TierKindFilter },
): TierItemView[] {
  const queryLower = opts.query.trim().toLowerCase()
  return items.filter((item) => {
    if (opts.kindFilter !== 'all' && item.kind !== opts.kindFilter) return false
    if (queryLower === '') return true
    return (
      `tier/${item.id}`.toLowerCase().includes(queryLower) ||
      item.id.toLowerCase().includes(queryLower) ||
      item.spec.model.toLowerCase().includes(queryLower) ||
      (item.spec.executorModel?.toLowerCase().includes(queryLower) ?? false) ||
      (item.spec.description?.toLowerCase().includes(queryLower) ?? false)
    )
  })
}
