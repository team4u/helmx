/** Pure state parsing, card synthesis, filtering, validation, and starter preset builders for builtin:tiers client. */
import type { HelmxLocale, HostModelEntry, ModelTierSpec } from '@helmx/protocol/browser'

export const TIERS_PLUGIN_ID = 'builtin:tiers' as const
export const TIERS_STATE_DOC = 'state' as const
export const TIERS_SCREEN_ID = 'main' as const
const TIER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/
const TIER_TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/

export type TiersManagerTab = 'tiers' | 'templates'
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
  status: TierAvailabilityStatus
}

export interface StarterTierPreset {
  id: string
  suggestedThinkingLevel: string
  description: string
}

export interface TierFormDraft {
  id: string
  model: string
  thinkingLevel: string
  suggestedThinkingLevel: string
  description: string
}

export interface SetTierActionInput {
  id: string
  model: string
  thinkingLevel?: string
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
      tiers[id] = {
        model: rawSpec.model,
        ...(typeof rawSpec.thinkingLevel === 'string' && rawSpec.thinkingLevel ? { thinkingLevel: rawSpec.thinkingLevel } : {}),
        ...(typeof rawSpec.description === 'string' && rawSpec.description ? { description: rawSpec.description } : {}),
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
    model: '',
    thinkingLevel: '',
    suggestedThinkingLevel: preset?.suggestedThinkingLevel ?? '',
    description: preset?.description ?? '',
  }
}

export function tierSpecToDraft(id: string, spec: ModelTierSpec): TierFormDraft {
  return {
    id,
    model: spec.model,
    thinkingLevel: spec.thinkingLevel ?? '',
    suggestedThinkingLevel: '',
    description: spec.description ?? '',
  }
}

export function isTierDraftDirty(
  draft: TierFormDraft,
  savedId: string | undefined,
  savedSpec: ModelTierSpec | undefined,
): boolean {
  if (savedId === undefined || savedSpec === undefined) return true
  return (
    draft.id.trim() !== savedId ||
    draft.model.trim() !== savedSpec.model ||
    draft.thinkingLevel.trim() !== (savedSpec.thinkingLevel ?? '') ||
    draft.description.trim() !== (savedSpec.description ?? '')
  )
}

export type TierDraftValidationError =
  | 'id_required'
  | 'duplicate_id'
  | 'model_required'

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
  return {
    ok: true,
    payload: {
      id,
      model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
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

export function resolveTierRowStatus(
  modelRef: string,
  models: ReadonlyArray<HostModelEntry>,
): 'draft' | TierAvailabilityStatus {
  const trimmed = modelRef.trim()
  if (!trimmed) return 'draft'
  const entry = models.find((m) => m.id === trimmed)
  if (!entry) return 'unavailable'
  if (entry.disabled === true) return 'disabled'
  return entry.available ? 'available' : 'unavailable'
}

export function synthesizeTierItems(
  tiers: Readonly<Record<string, ModelTierSpec>>,
  models: ReadonlyArray<HostModelEntry>,
): TierItemView[] {
  return Object.entries(tiers).map(([id, spec]) => {
    const rawStatus = resolveTierRowStatus(spec.model, models)
    return {
      id,
      spec,
      status: rawStatus === 'draft' ? 'unavailable' : rawStatus,
    }
  })
}

export function filterTierItems(
  items: ReadonlyArray<TierItemView>,
  opts: { query: string },
): TierItemView[] {
  const queryLower = opts.query.trim().toLowerCase()
  if (queryLower === '') return [...items]
  return items.filter(
    (item) =>
      `tier/${item.id}`.toLowerCase().includes(queryLower) ||
      item.id.toLowerCase().includes(queryLower) ||
      item.spec.model.toLowerCase().includes(queryLower) ||
      (item.spec.description?.toLowerCase().includes(queryLower) ?? false),
  )
}
