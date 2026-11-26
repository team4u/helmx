/** Display copy for the builtin:memory profile section (Fast Refresh friendly). */
import type { HelmxLocale, LocalizedText } from '@helmx/plugin-client'
import { resolveLocalizedText } from '@helmx/plugin-client'
import { MAX_MEMORY_CHARS } from './models.js'

export const MEMORY_COPY = {
  sectionTitle: { en: 'Long-term memory (MEMORY.md)', 'zh-CN': '长期记忆 (MEMORY.md)' },
  newProfileHint: {
    en: 'After saving and creating the profile, you can enable or disable its long-term memory here and edit MEMORY.md.',
    'zh-CN': '保存并创建角色后，可在此开启或关闭该角色的长期记忆并编辑 MEMORY.md。',
  },
  switchLabel: { en: 'Enable long-term memory', 'zh-CN': '启用长期记忆' },
  loading: { en: 'Loading memory…', 'zh-CN': '加载记忆中…' },
  notLoaded: { en: 'Memory state not loaded', 'zh-CN': '尚未加载记忆状态' },
  loadFailed: {
    en: 'Cannot read the memory state; the enable state of this profile was left unchanged.',
    'zh-CN': '无法读取记忆状态，未更改此 Profile 的启用状态。',
  },
  retry: { en: 'Retry', 'zh-CN': '重试' },
  disabledHint: {
    en: 'Long-term memory is disabled for this profile: MEMORY.md is not injected into conversations and the update_memory tool is not provided. The switch takes effect immediately; saved memory content stays on disk.',
    'zh-CN': '已为此角色关闭长期记忆：对话中不会注入 MEMORY.md，也不会提供 update_memory 工具。开关即时生效，已保存的记忆内容保留在磁盘上。',
  },
  placeholder: { en: 'Full long-term memory of this profile (Markdown supported)…', 'zh-CN': '该角色的长期记忆全文（支持 Markdown）…' },
  textareaLabel: { en: 'Long-term memory', 'zh-CN': '长期记忆' },
  saving: { en: 'Saving…', 'zh-CN': '保存中…' },
  save: { en: 'Save memory', 'zh-CN': '保存记忆' },
  savedNotice: { en: 'Long-term memory saved.', 'zh-CN': '长期记忆已保存。' },
  dirtyHint: {
    en: 'Unsaved changes (memory content is saved independently; it is not rolled back with "Cancel profile editing")',
    'zh-CN': '有未保存的修改（记忆内容独立保存，不随「取消角色编辑」回滚）',
  },
  dreamTitle: { en: 'Daily auto-organize (Dream)', 'zh-CN': '每日自动整理（Dream）' },
  dreamRun: { en: 'Organize now', 'zh-CN': '立即整理' },
  dreamRunning: { en: 'Organizing…', 'zh-CN': '整理中…' },
  dreamDraftKept: {
    en: 'Unsaved edits in the editor were kept (based on the pre-dream text); saving them will replace the organized memory.',
    'zh-CN': '已保留编辑区未保存的修改（基于整理前文本）；保存将覆盖整理后的记忆。',
  },
  dreamRefreshFailed: {
    en: 'The organized memory was applied, but the editor failed to reload it; the editor still shows the previous version.',
    'zh-CN': '整理后的记忆已写入，但编辑区正文刷新失败，编辑器仍显示旧版本。',
  },
  dreamPause: { en: 'Pause auto', 'zh-CN': '暂停自动' },
  dreamResume: { en: 'Resume auto', 'zh-CN': '恢复自动' },
  dreamPausedNotice: { en: 'Daily auto-organize paused.', 'zh-CN': '已暂停每日自动整理。' },
  dreamResumedNotice: { en: 'Daily auto-organize resumed.', 'zh-CN': '已恢复每日自动整理。' },
  dreamGlobalHint: {
    en: 'The schedule is global for all profiles; pausing stops the daily consolidation only (collection keeps running, manual "Organize now" still works).',
    'zh-CN': '调度为全角色共用；暂停仅停止每日自动整理（候选照常收集，可随时手动「立即整理」）。',
  },
  dreamLoadFailed: { en: 'Dream status unavailable; manual organizing still works.', 'zh-CN': '整理状态暂不可用；手动「立即整理」不受影响。' },
  dreamStatusLoading: { en: 'Loading dream status…', 'zh-CN': '整理状态加载中…' },
  dreamMalformed: { en: 'Dream status response is malformed.', 'zh-CN': '整理状态响应格式不正确。' },
} as const satisfies Record<string, LocalizedText>

const loc = (en: string, zh: string, locale: HelmxLocale): string => resolveLocalizedText({ en, 'zh-CN': zh }, locale)
const formatDreamTime = (ms: number, locale: HelmxLocale): string => (Number.isFinite(ms) ? new Date(ms).toLocaleString(locale) : String(ms))

export const memoryCharCount = (chars: number, locale: HelmxLocale): string =>
  loc(`${chars} / ${MAX_MEMORY_CHARS} chars`, `${chars} / ${MAX_MEMORY_CHARS} 字符`, locale)

export const memoryLineCount = (lines: number, locale: HelmxLocale): string => loc(` · ${lines} lines`, ` · ${lines} 行`, locale)

export function memoryDreamSchedule(config: { enabled: boolean; hour: number; timezone: string }, locale: HelmxLocale): string {
  if (!config.enabled) return loc('paused', '已暂停', locale)
  const hh = String(config.hour).padStart(2, '0')
  return `${loc(`daily ${hh}:00`, `每天 ${hh}:00`, locale)} · ${config.timezone}`
}

export const memoryDreamCandidates = (count: number, locale: HelmxLocale): string =>
  loc(`${count} pending candidate${count === 1 ? '' : 's'}`, `${count} 条待整理候选`, locale)

export const memoryDreamNextRun = (nextRunAt: number, locale: HelmxLocale): string =>
  `${loc('next run', '下次运行', locale)} ${formatDreamTime(nextRunAt, locale)}`

export const memoryDreamLastError = (error: string, locale: HelmxLocale): string =>
  `${loc('last error', '上次诊断', locale)}: ${error.length > 160 ? `${error.slice(0, 160)}…` : error}`

export function memoryDreamLastRun(
  record: { lastRunAt?: number; ran: boolean; applied?: boolean; conflict?: boolean; reason?: string; error?: string },
  locale: HelmxLocale,
): string {
  const prefix = loc('last run', '上次整理', locale)
  const head = record.lastRunAt !== undefined ? `${prefix} ${formatDreamTime(record.lastRunAt, locale)}` : prefix
  if (!record.ran) {
    if (record.reason === 'no_candidates') return `${head}: ${loc('skipped (no candidates)', '跳过（无候选）', locale)}`
    const reason =
      record.reason === 'no_conversation_for_model'
        ? loc('no conversation to resolve the model', '无会话可解析模型', locale)
        : record.reason === 'memory_missing'
          ? loc('MEMORY.md missing', 'MEMORY.md 缺失', locale)
          : record.reason
    return `${head}: ${loc('skipped', '跳过', locale)} (${reason})`
  }
  if (record.conflict) return `${head}: ${loc('abandoned (memory edited during the dream)', '放弃写回（整理期间记忆被修改）', locale)}`
  if (record.applied) return `${head}: ${loc('applied', '已应用', locale)}`
  return `${head}: ${loc('failed', '失败', locale)}`
}

export function memoryDreamRunResult(
  result: { ran: boolean; applied?: boolean; conflict?: boolean; reason?: string; consumed?: number },
  locale: HelmxLocale,
): string {
  if (!result.ran) {
    if (result.reason === 'no_candidates') return loc('No candidates to organize yet.', '暂无可整理的候选。', locale)
    if (result.reason === 'no_conversation_for_model') {
      return loc('No conversation of this profile exists to resolve the model; dream skipped.', '该角色暂无会话可解析生效模型，已跳过整理。', locale)
    }
    if (result.reason === 'memory_missing') return loc('MEMORY.md does not exist; dream skipped.', 'MEMORY.md 不存在，已跳过整理。', locale)
    return loc(`Skipped (${result.reason ?? 'unknown'}).`, `已跳过（${result.reason ?? '未知'}）。`, locale)
  }
  if (result.conflict) {
    return loc('Memory was edited while the dream ran; write-back abandoned, candidates kept.', '整理期间记忆被修改，已放弃写回，候选保留。', locale)
  }
  if (result.applied) {
    const n = result.consumed ?? 0
    return loc(`Dream applied (${n} candidate${n === 1 ? '' : 's'} merged).`, `整理完成（合并 ${n} 条候选）。`, locale)
  }
  return loc('Dream ran but nothing was applied.', '整理已运行但未应用改动。', locale)
}
