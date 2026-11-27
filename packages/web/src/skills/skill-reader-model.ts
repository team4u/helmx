/**
 * Pure-function model for the skill file reader.
 *
 * Provides the compact file reader of SkillDetailDrawer with file list
 * building, Markdown detection, YAML frontmatter parsing, Markdown metadata
 * table conversion and syntax language derivation. Follows the web Fast
 * Refresh rule: pure functions and constants live here, never in components.
 */
import { parseSkillFrontmatterLines, type SkillFrontmatterField } from '@helmx/protocol/browser'
import { detectLanguage } from '../conversation/code-language.js'
import type { WebMessageTranslator } from '../i18n/catalog.js'

/** Main skill file name (read path convention is the empty string; displayed as SKILL.md). */
export const SKILL_MAIN_FILENAME = 'SKILL.md'

/** One skill file entry in the reader. */
export interface SkillFileEntry {
  /** Read path: the empty string means the main SKILL.md */
  path: string
  /** Short file name (basename) for dropdown options and the toolbar label */
  fileName: string
  /** Directory / origin hint (e.g. 'references/' or the main-file label) */
  meta: string
  /** Full relative path (title hints and single-file display) */
  displayPath: string
}

/** Take the path basename (query-string tolerant; an empty path returns ''). */
export function skillFileBasename(path: string): string {
  const normalized = (path ?? '').split('?')[0]?.split('#')[0] ?? ''
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

/**
 * Build the skill file list: the main SKILL.md first, then references in
 * their original order. Empty and non-string reference entries are filtered
 * so the list is always valid.
 */
export function buildSkillFileList(
  references: readonly string[] | null | undefined,
  t: WebMessageTranslator,
): SkillFileEntry[] {
  const refs = Array.isArray(references)
    ? references.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '')
    : []
  const main: SkillFileEntry = {
    path: '',
    fileName: SKILL_MAIN_FILENAME,
    meta: t('skills.reader.mainFile'),
    displayPath: SKILL_MAIN_FILENAME,
  }
  const rest = refs.map((ref) => {
    const fileName = skillFileBasename(ref) || ref
    const dir = ref.slice(0, ref.length - fileName.length)
    return { path: ref, fileName, meta: dir || './', displayPath: ref }
  })
  return [main, ...rest]
}

/** Whether the file renders as Markdown (the empty string means the main SKILL.md). */
export function isSkillMarkdownFile(path: string): boolean {
  const name = skillFileBasename(path ?? '') || SKILL_MAIN_FILENAME
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return ext === 'md' || ext === 'markdown'
}

/** Parsed top frontmatter of SKILL.md: the field sequence and the body after the fence. */
export interface SkillFrontmatterDoc {
  fields: SkillFrontmatterField[]
  body: string
}

/** Parse the top YAML frontmatter of SKILL.md (--- ... --- / ... fences) into a
 * field sequence and body. Field values come from the @helmx/protocol
 * parseSkillFrontmatterLines reader (the same rules as the kernel catalog),
 * bounded to the fence body so the closing fence never leaks into a value.
 * Returns null when the fence is missing or unclosed; callers fall back to the
 * raw text — the body is never truncated. */
export function extractSkillFrontmatter(text: string): SkillFrontmatterDoc | null {
  const lines = text.split(/\r?\n/)
  if (lines[0] === undefined || lines[0]!.trim() !== '---') return null
  const end = lines.findIndex((line, i) => i > 0 && (line.trim() === '---' || line.trim() === '...'))
  if (end === -1) return null
  const fields = parseSkillFrontmatterLines(lines.slice(1, end))
  const rest = lines.slice(end + 1)
  while (rest.length > 0 && rest[0]!.trim() === '') rest.shift()
  return { fields, body: rest.join('\n') }
}

/** Escape a Markdown table cell safely: backslashes and pipes are escaped to
 * keep the column structure intact, & and < become character references so
 * react-markdown does not swallow the value as raw HTML, and newlines fold
 * into spaces so a cell stays single-line (GFM table cells carry no block
 * line breaks). */
function escapeTableCellValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\r\n?|\n/g, ' ')
}

/** Convert the frontmatter field sequence into a Markdown table (with the
 * "skill metadata" heading row). Fields keep their original YAML order; an
 * empty field sequence returns '' (nothing to render). */
export function renderSkillFrontmatterTable(
  fields: readonly SkillFrontmatterField[],
  t: WebMessageTranslator,
): string {
  if (fields.length === 0) return ''
  const rows = fields.map(
    (f) => `| ${escapeTableCellValue(f.key)} | ${escapeTableCellValue(f.value)} |`,
  )
  return [
    `## ${t('skills.reader.metadataHeading')}`,
    '',
    `| ${t('skills.reader.fieldHeader')} | ${t('skills.reader.valueHeader')} |`,
    '| --- | --- |',
    ...rows,
  ].join('\n')
}

/** Unified document view for rich reading mode: converts the top YAML
 * frontmatter of SKILL.md into a Markdown metadata table with the body right
 * after it in the same content flow (desktop and mobile share the same DOM
 * and rendering logic). Without frontmatter the body returns verbatim; an
 * unclosed fence or a non-'---' first line falls back to the raw text — the
 * body is never truncated. Source mode bypasses this conversion. */
export function renderSkillDocMarkdown(text: string, t: WebMessageTranslator): string {
  const parsed = extractSkillFrontmatter(text)
  if (parsed === null) return text
  const table = renderSkillFrontmatterTable(parsed.fields, t)
  if (table === '') return parsed.body
  return parsed.body === '' ? table : `${table}\n\n${parsed.body}`
}

/**
 * Derive the syntax highlighting language of a skill file (consumed by source
 * mode and code files): derived from the file suffix, the main skill file
 * derives as markdown from SKILL.md; returns '' when unrecognized.
 */
export function skillFileLanguage(path: string): string {
  return detectLanguage(skillFileBasename(path ?? '') || SKILL_MAIN_FILENAME, undefined)
}
