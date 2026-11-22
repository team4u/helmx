/** Pure state parsing, draft editing, and starter draft builders for builtin:tiers client. */
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

export function tiersRecordToDraftRows(tiers: Readonly<Record<string, ModelTierSpec>>): TierDraftRow[] {
  return Object.entries(tiers).map(([id, spec], index) => ({
    key: `saved:${index}:${id}`,
    id,
    model: spec.model,
    thinkingLevel: spec.thinkingLevel ?? '',
    description: spec.description ?? '',
  }))
}

const STARTER_TIERS: ReadonlyArray<readonly [string, string, string, string]> = [
  ['scout', '', '仓库摸底、大范围代码与日志检索、文档汇总及轻量机械任务；高吞吐低成本，禁止用于架构拍板或复杂改写', 'Codebase reconnaissance, broad search, log scanning, and lightweight synthesis; fast/high-quota, avoid complex edits or architecture decisions'],
  ['coder', 'high', '方案明确的功能开发、模块改写、测试编写与常规排错；日常主力实现首选', 'Well-scoped feature implementation, test writing, refactoring, and routine debugging; default engineering workhorse'],
  ['senior', 'xhigh', '跨模块复杂实现、高难度重构，或 coder 失败后的第一级升级攻坚；次主力强档', 'Complex cross-module implementation, hard refactoring, or first-step escalation after coder gate failures'],
  ['architect', 'high', '核心架构设计、关键契约拍板、fork 专家会诊与终极疑难定性；高成本顶配档，常规检索与普通编码勿用', 'Core architecture design, critical contract trade-offs, fork expert consultation, and toughest root-cause diagnosis; flagship cost, high-leverage only'],
  ['reviewer', 'xhigh', '高标准独立 Code Review、并发与边界漏洞挑刺、合入前验收把关；成本高但审查极强，仅在验收节点调用', 'Independent high-bar code review, concurrency/edge-case hunting, and pre-merge verification; use selectively at review gates'],
]

export function buildStarterDraftRows(locale: HelmxLocale): TierDraftRow[] {
  const zh = locale === 'zh-CN'
  return STARTER_TIERS.map(([id, thinkingLevel, zhDesc, enDesc], idx) => ({
    key: `starter:${idx}:${id}`,
    id,
    model: '',
    thinkingLevel,
    description: zh ? zhDesc : enDesc,
  }))
}

export function isDraftDirty(draft: ReadonlyArray<TierDraftRow>, saved: Readonly<Record<string, ModelTierSpec>>): boolean {
  const savedEntries = Object.entries(saved)
  if (draft.length !== savedEntries.length) return true
  return draft.some((row, i) => {
    const [savedId, s] = savedEntries[i]!
    return (
      row.id.trim() !== savedId ||
      row.model.trim() !== s.model ||
      row.thinkingLevel.trim() !== (s.thinkingLevel ?? '') ||
      row.description.trim() !== (s.description ?? '')
    )
  })
}

export function validateDraftRows(
  draft: ReadonlyArray<TierDraftRow>,
): { ok: true; tiers: Record<string, ModelTierSpec> } | { ok: false; code: 'id_required' | 'duplicate_id' | 'model_required' } {
  const tiers: Record<string, ModelTierSpec> = {}
  for (const row of draft) {
    const id = row.id.trim()
    if (!TIER_ID_PATTERN.test(id)) return { ok: false, code: 'id_required' }
    if (Object.hasOwn(tiers, id)) return { ok: false, code: 'duplicate_id' }
    const model = row.model.trim()
    if (!model.includes('/')) return { ok: false, code: 'model_required' }
    const thinkingLevel = row.thinkingLevel.trim()
    const description = row.description.trim()
    tiers[id] = { model, ...(thinkingLevel ? { thinkingLevel } : {}), ...(description ? { description } : {}) }
  }
  return { ok: true, tiers }
}

export function resolveTierRowStatus(modelRef: string, models: ReadonlyArray<HostModelEntry>): 'draft' | 'available' | 'disabled' | 'unavailable' {
  const trimmed = modelRef.trim()
  if (!trimmed) return 'draft'
  const entry = models.find((m) => m.id === trimmed)
  if (!entry) return 'unavailable'
  if (entry.disabled === true) return 'disabled'
  return entry.available ? 'available' : 'unavailable'
}
