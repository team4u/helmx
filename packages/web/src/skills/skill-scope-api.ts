/**
 * Web adapter for coordinate-scoped skill catalog and node skill reading (`core:skills.catalog` / `core:skills.read`).
 *
 * Contract:
 * - `GET /api/skills/scoped/catalog?nodeId=...&cwd=...` -> `{ nodeId, cwd?, skills, shadowedNodeSkillIds, nodeUnavailable? }`
 * - `GET /api/skills/:id?path=...&nodeId=...&cwd=...` -> `{ text }`
 *
 * Validates response shapes strictly at the boundary; malformed outputs throw explicitly without fallback.
 */
import type { SkillSummary } from '@helmx/protocol/browser'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { assetsApi } from '../lib/api.js'
import type { SkillScope } from './skill-scope-model.js'

/** Injectable scoped-skill transport (defaults to `assetsApi`; tests may inject a stub). */
export interface ScopedSkillTransport {
  listCatalog(scope: { nodeId: string; cwd?: string }): Promise<unknown>
  readFile(id: string, path?: string, opts?: { nodeId?: string; cwd?: string }): Promise<unknown>
}

const DEFAULT_SCOPED_SKILL_TRANSPORT: ScopedSkillTransport = {
  listCatalog: (scope) => assetsApi.getScopedSkillCatalog(scope),
  readFile: (id, path, opts) => assetsApi.readSkill(id, path, opts),
}

export interface ScopedSkillCatalog {
  skills: SkillSummary[]
  shadowedNodeSkillIds: string[]
  nodeUnavailable?: string
}

const SKILL_SOURCE_VALUES = new Set(['data', 'agents', 'node'])

function catalogError(t: WebMessageTranslator, detail: string): Error {
  return new Error(t('skills.scopeApi.catalogInvalid', { detail }))
}

function parseSkillSummaryEntry(raw: unknown, index: number, t: WebMessageTranslator): SkillSummary {
  if (typeof raw !== 'object' || raw === null) {
    throw catalogError(t, t('skills.scopeApi.skillEntryNotObject', { index }))
  }
  const record = raw as Record<string, unknown>
  const { id, name, references, managedByPlugin, source } = record
  if (typeof id !== 'string' || id.trim() === '') {
    throw catalogError(t, t('skills.scopeApi.skillIdRequired', { index }))
  }
  if (typeof name !== 'string') {
    throw catalogError(t, t('skills.scopeApi.skillNameRequired', { index }))
  }
  if (!Array.isArray(references) || references.some((ref) => typeof ref !== 'string')) {
    throw catalogError(t, t('skills.scopeApi.skillRefsInvalid', { index }))
  }
  if (managedByPlugin !== undefined && typeof managedByPlugin !== 'string') {
    throw catalogError(t, t('skills.scopeApi.skillPluginInvalid', { index }))
  }
  if (source !== undefined && (typeof source !== 'string' || !SKILL_SOURCE_VALUES.has(source))) {
    throw catalogError(t, t('skills.scopeApi.skillSourceInvalid', { index }))
  }
  if (record.description !== undefined && typeof record.description !== 'string') {
    throw catalogError(t, t('skills.scopeApi.skillDescInvalid', { index }))
  }
  return {
    id,
    name,
    references: references as string[],
    ...(managedByPlugin !== undefined ? { managedByPlugin } : {}),
    ...(source !== undefined ? { source: source as SkillSummary['source'] } : {}),
    ...(record.description !== undefined ? { description: record.description as string } : {}),
  }
}

export function parseSkillCatalogResult(raw: unknown, t: WebMessageTranslator): ScopedSkillCatalog {
  if (typeof raw !== 'object' || raw === null) {
    throw catalogError(t, t('skills.scopeApi.notObject'))
  }
  const record = raw as Record<string, unknown>
  if (typeof record.nodeId !== 'string' || record.nodeId.trim() === '') {
    throw catalogError(t, t('skills.scopeApi.nodeIdRequired'))
  }
  if (record.cwd !== undefined && (typeof record.cwd !== 'string' || record.cwd.trim() === '')) {
    throw catalogError(t, t('skills.scopeApi.cwdInvalid'))
  }
  if (!Array.isArray(record.skills)) {
    throw catalogError(t, t('skills.scopeApi.skillsArrayRequired'))
  }
  const skills = record.skills.map((entry, index) => parseSkillSummaryEntry(entry, index, t))
  if (
    record.shadowedNodeSkillIds !== undefined &&
    (
      !Array.isArray(record.shadowedNodeSkillIds) ||
      record.shadowedNodeSkillIds.some((id) => typeof id !== 'string')
    )
  ) {
    throw catalogError(t, t('skills.scopeApi.shadowedInvalid'))
  }
  if (record.nodeUnavailable !== undefined && typeof record.nodeUnavailable !== 'string') {
    throw catalogError(t, t('skills.scopeApi.nodeUnavailableInvalid'))
  }
  return {
    skills,
    shadowedNodeSkillIds: (record.shadowedNodeSkillIds as string[] | undefined) ?? [],
    ...(record.nodeUnavailable !== undefined
      ? { nodeUnavailable: record.nodeUnavailable as string }
      : {}),
  }
}

export function parseSkillReadResult(raw: unknown, t: WebMessageTranslator): { text: string } {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(t('skills.scopeApi.readNotObject'))
  }
  const text = (raw as Record<string, unknown>).text
  if (typeof text !== 'string') {
    throw new Error(t('skills.scopeApi.readTextInvalid'))
  }
  return { text }
}

/** Fetch merged skill catalog for a target node (and optional workspace cwd). */
export function fetchScopedSkillCatalog(
  scope: SkillScope,
  t: WebMessageTranslator,
  transport: Pick<ScopedSkillTransport, 'listCatalog'> = DEFAULT_SCOPED_SKILL_TRANSPORT,
): Promise<ScopedSkillCatalog> {
  return transport
    .listCatalog({
      nodeId: scope.nodeId,
      ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
    })
    .then((raw) => parseSkillCatalogResult(raw, t))
}

/** Read a node-sourced skill file (path defaults to SKILL.md on the server). */
export function readScopedSkillFile(
  scope: SkillScope,
  skillId: string,
  path: string | undefined,
  t: WebMessageTranslator,
  transport: Pick<ScopedSkillTransport, 'readFile'> = DEFAULT_SCOPED_SKILL_TRANSPORT,
): Promise<{ text: string }> {
  return transport
    .readFile(skillId, path !== undefined && path !== '' ? path : undefined, {
      nodeId: scope.nodeId,
      ...(scope.cwd !== undefined && scope.cwd !== '' ? { cwd: scope.cwd } : {}),
    })
    .then((raw) => parseSkillReadResult(raw, t))
}
