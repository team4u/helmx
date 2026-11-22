/** Pure display model and copy for the builtin:token-speed badge (Fast Refresh friendly). */
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText, type HelmxLocale, type LocalizedText } from '@helmx/plugin-client'

const SOURCE_LABELS: Record<string, LocalizedText> = {
  provider: { en: 'provider usage', 'zh-CN': '供应商 usage' },
  mixed: { en: 'provider usage + char estimate mixed', 'zh-CN': '供应商 usage + 字符估算混合' },
  estimate: { en: 'char estimate (chars/4)', 'zh-CN': '字符估算（chars/4）' },
}

const loc = (en: string, zh: string, locale: HelmxLocale): string => resolveLocalizedText({ en, 'zh-CN': zh }, locale)
const secLabel = (ms: number): string => (ms / 1000 < 10 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`)

export function tokenSpeedLabelOf(
  status: { phase: 'decoding' | 'tools' | 'settled'; tps?: number; outputTokens: number; decodeMs: number; source: string; ttftMs?: number; windowMs: number },
  locale: HelmxLocale = DEFAULT_HELMX_LOCALE,
): { text: string; title: string } | null {
  const tps = status.tps
  if (typeof tps !== 'number' || !Number.isFinite(tps) || tps <= 0) return null
  const tpsText = String(Math.max(1, Math.round(tps)))
  const tokens = Math.max(1, Math.round(status.outputTokens))
  const decode = secLabel(status.decodeMs)
  const source = resolveLocalizedText(SOURCE_LABELS[status.source] ?? SOURCE_LABELS.estimate!, locale)
  const ttft =
    typeof status.ttftMs === 'number' && Number.isFinite(status.ttftMs) && status.ttftMs >= 0
      ? loc(`; TTFT ${Math.round(status.ttftMs)}ms (first observed by the plugin, not the exact request start)`, `；首字延迟 ${Math.round(status.ttftMs)}ms（起点为插件首次观测，非请求精确起点）`, locale)
      : ''
  const text = `${tpsText} tok/s`
  if (status.phase === 'settled') {
    return {
      text,
      title: loc(
        `Last turn decode ${tpsText} tok/s (settled total ${tokens} tok, observed net decode time ${decode}, basis ${source}; rate only counts responses whose token counts and durations can be paired; time is a throttled-frame approximation, not exact server decode time; excludes TTFT and tool execution${ttft})`,
        `最近回合解码 ${tpsText} tok/s（对账累计 ${tokens} tok，观测解码净耗时 ${decode}，口径 ${source}；速率仅统计计数与时长可配对的响应；时间为节流帧观测近似，非服务器精确解码时间；不含首字延迟与工具执行${ttft}）`,
        locale,
      ),
    }
  }
  if (status.phase === 'tools') {
    return {
      text,
      title: loc(
        `Timer paused during tools · latest decode ${tpsText} tok/s (basis ${source}; tool execution time is not counted as decode time; ${tokens} tok generated / ${decode} observed decode${ttft})`,
        `工具执行暂停计时 · 最近解码 ${tpsText} tok/s（口径 ${source}；工具执行耗时不计入解码时间；已生成 ${tokens} tok / 观测解码 ${decode}${ttft}）`,
        locale,
      ),
    }
  }
  const winSec = status.windowMs / 1000
  const win = winSec.toFixed(winSec < 10 ? 1 : 0)
  return {
    text,
    title: loc(
      `Live decode ${tpsText} tok/s (${win}s sliding-window streaming rate, basis ${source}; time is a throttled-frame approximation, not exact server decode time; excludes TTFT and tool execution; ${tokens} tok generated / ${decode} observed decode${ttft})`,
      `实时解码 ${tpsText} tok/s（${win}s 滑动窗口流式观测速率，口径 ${source}；时间为节流帧观测近似，非服务器精确解码时间；不含首字延迟与工具执行；已生成 ${tokens} tok / 观测解码 ${decode}${ttft}）`,
      locale,
    ),
  }
}
