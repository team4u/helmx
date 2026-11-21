/**
 * Pure state parsing, draft editing, and starter draft builders for builtin:tiers client
 * (self-contained inside clientRoot; no React component exports; Fast Refresh compliant).
 */
import type { HelmxLocale, HostModelEntry, ModelTierSpec } from '@helmx/protocol/browser'

export const TIERS_PLUGIN_ID = 'builtin:tiers' as const
export const TIERS_STATE_DOC = 'state' as const
export const TIERS_SCREEN_ID = 'main' as const

const TIER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/

export interface TierTemplateView {
  id: string
  name: string
  description?: string
  tiers: Record<string, ModelTierSpec>
  updatedAt: number
}

export interface TierDraftRow {
  /** Stable React list key (distinct from editable `id`). */
  key: string
  id: string
  model: string
  thinkingLevel: string
  description: string
}

export interface ParsedTiersDoc {
  tiers: Record<string, ModelTierSpec>
  templates: TierTemplateView[]
  activeTemplate?: string
}

/** Parse the reactive `state` plugin doc safely without fabricating missing fields. */
export function parseTiersStateDoc(raw: unknown): ParsedTiersDoc {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { tiers: {}, templates: [] }
  }
  const obj = raw as {
    tiers?: unknown
    templates?: unknown
    activeTemplate?: unknown
  }
  const tiers: Record<string, ModelTierSpec> = {}
  if (obj.tiers !== undefined && obj.tiers !== null && typeof obj.tiers === 'object' && !Array.isArray(obj.tiers)) {
    for (const [id, rawSpec] of Object.entries(obj.tiers as Record<string, unknown>)) {
      if (rawSpec === null || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) continue
      const spec = rawSpec as Partial<ModelTierSpec>
      if (typeof spec.model !== 'string') continue
      tiers[id] = {
        model: spec.model,
        ...(typeof spec.thinkingLevel === 'string' && spec.thinkingLevel !== '' ? { thinkingLevel: spec.thinkingLevel } : {}),
        ...(typeof spec.description === 'string' && spec.description !== '' ? { description: spec.description } : {}),
      }
    }
  }
  const templates: TierTemplateView[] = []
  if (obj.templates !== undefined && obj.templates !== null && typeof obj.templates === 'object' && !Array.isArray(obj.templates)) {
    for (const rawTpl of Object.values(obj.templates as Record<string, unknown>)) {
      if (rawTpl === null || typeof rawTpl !== 'object' || Array.isArray(rawTpl)) continue
      const tpl = rawTpl as Partial<TierTemplateView>
      if (typeof tpl.id !== 'string' || typeof tpl.name !== 'string') continue
      templates.push({
        id: tpl.id,
        name: tpl.name,
        ...(typeof tpl.description === 'string' && tpl.description !== '' ? { description: tpl.description } : {}),
        tiers: tpl.tiers && typeof tpl.tiers === 'object' ? tpl.tiers : {},
        updatedAt: typeof tpl.updatedAt === 'number' && Number.isFinite(tpl.updatedAt) ? tpl.updatedAt : 0,
      })
    }
  }
  templates.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  return {
    tiers,
    templates,
    ...(typeof obj.activeTemplate === 'string' && obj.activeTemplate !== '' ? { activeTemplate: obj.activeTemplate } : {}),
  }
}

/** Convert persisted tier record into editable draft rows. */
export function tiersRecordToDraftRows(tiers: Readonly<Record<string, ModelTierSpec>>): TierDraftRow[] {
  return Object.entries(tiers).map(([id, spec], index) => ({
    key: `saved:${index}:${id}`,
    id,
    model: spec.model,
    thinkingLevel: spec.thinkingLevel ?? '',
    description: spec.description ?? '',
  }))
}

/** Recommended 5-tier starter draft (descriptions & suggested effort only; concrete model left for the user to pick). */
export function buildStarterDraftRows(locale: HelmxLocale): TierDraftRow[] {
  const zh = locale === 'zh-CN'
  const items: Array<{ id: string; thinkingLevel: string; zhDesc: string; enDesc: string }> = [
    {
      id: 'scout',
      thinkingLevel: '',
      zhDesc: '仓库摸底、大范围代码与日志检索、文档汇总及轻量机械任务；高吞吐低成本，禁止用于架构拍板或复杂改写',
      enDesc: 'Codebase reconnaissance, broad search, log scanning, and lightweight synthesis; fast/high-quota, avoid complex edits or architecture decisions',
    },
    {
      id: 'coder',
      thinkingLevel: 'high',
      zhDesc: '方案明确的功能开发、模块改写、测试编写与常规排错；日常主力实现首选',
      enDesc: 'Well-scoped feature implementation, test writing, refactoring, and routine debugging; default engineering workhorse',
    },
    {
      id: 'senior',
      thinkingLevel: 'xhigh',
      zhDesc: '跨模块复杂实现、高难度重构，或 coder 失败后的第一级升级攻坚；次主力强档',
      enDesc: 'Complex cross-module implementation, hard refactoring, or first-step escalation after coder gate failures',
    },
    {
      id: 'architect',
      thinkingLevel: 'high',
      zhDesc: '核心架构设计、关键契约拍板、fork 专家会诊与终极疑难定性；高成本顶配档，常规检索与普通编码勿用',
      enDesc: 'Core architecture design, critical contract trade-offs, fork expert consultation, and toughest root-cause diagnosis; flagship cost, high-leverage only',
    },
    {
      id: 'reviewer',
      thinkingLevel: 'xhigh',
      zhDesc: '高标准独立 Code Review、并发与边界漏洞挑刺、合入前验收把关；成本高但审查极强，仅在验收节点调用',
      enDesc: 'Independent high-bar code review, concurrency/edge-case hunting, and pre-merge verification; use selectively at review gates',
    },
  ]
  return items.map((item, idx) => ({
    key: `starter:${idx}:${item.id}`,
    id: item.id,
    model: '',
    thinkingLevel: item.thinkingLevel,
    description: zh ? item.zhDesc : item.enDesc,
  }))
}

/** Check whether draft rows differ from persisted tiers map. */
export function isDraftDirty(
  draft: ReadonlyArray<TierDraftRow>,
  saved: Readonly<Record<string, ModelTierSpec>>,
): boolean {
  const savedEntries = Object.entries(saved)
  if (draft.length !== savedEntries.length) return true
  for (let i = 0; i < draft.length; i += 1) {
    const row = draft[i]!
    const [savedId, savedSpec] = savedEntries[i]!
    if (
      row.id.trim() !== savedId ||
      row.model.trim() !== savedSpec.model ||
      row.thinkingLevel.trim() !== (savedSpec.thinkingLevel ?? '') ||
      row.description.trim() !== (savedSpec.description ?? '')
    ) {
      return true
    }
  }
  return false
}

/** Validate draft rows and build the `tiers` record for `replace` action. */
export function validateDraftRows(
  draft: ReadonlyArray<TierDraftRow>,
):
  | { ok: true; tiers: Record<string, ModelTierSpec> }
  | { ok: false; code: 'id_required' | 'duplicate_id' | 'model_required' } {
  const tiers: Record<string, ModelTierSpec> = {}
  for (const row of draft) {
    const id = row.id.trim()
    if (!TIER_ID_PATTERN.test(id)) return { ok: false, code: 'id_required' }
    if (Object.prototype.hasOwnProperty.call(tiers, id)) return { ok: false, code: 'duplicate_id' }
    const model = row.model.trim()
    if (model === '' || !model.includes('/')) return { ok: false, code: 'model_required' }
    const thinkingLevel = row.thinkingLevel.trim()
    const description = row.description.trim()
    tiers[id] = {
      model,
      ...(thinkingLevel !== '' ? { thinkingLevel } : {}),
      ...(description !== '' ? { description } : {}),
    }
  }
  return { ok: true, tiers }
}

/** Compute live availability status of a draft row against host model catalog entries. */
export function resolveTierRowStatus(
  modelRef: string,
  models: ReadonlyArray<HostModelEntry>,
): 'draft' | 'available' | 'disabled' | 'unavailable' {
  const trimmed = modelRef.trim()
  if (trimmed === '') return 'draft'
  const entry = models.find((m) => m.id === trimmed)
  if (entry === undefined) return 'unavailable'
  if (entry.disabled === true) return 'disabled'
  return entry.available ? 'available' : 'unavailable'
}
