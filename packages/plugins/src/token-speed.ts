/** builtin:token-speed: real-time decoding speed (tok/s) read-only composer status plugin. */
import { COMPOSER_STATUS_SLOT, HelmxError, type PluginDefinition } from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  CONTEXT_INVALIDATION_ENTRY_KINDS, DEFAULT_SLIDING_WINDOW_MS, DOC_WRITE_INTERVAL_MS, MAX_SLIDING_WINDOW_MS,
  MIN_SLIDING_WINDOW_MS, TOKEN_SPEED_DOC, TOKEN_SPEED_PLUGIN_ID, asAssistantCompletion,
  asConversationDeletedId, asConversationEntryEnvelope, asConversationLiveFrame, type TokenSpeedStatus,
} from './token-speed/contracts.js'
import { ConversationTokenSpeedTracker } from './token-speed/tracker.js'

export { TOKEN_SPEED_PLUGIN_ID }

interface ConvState {
  tracker: ConversationTokenSpeedTracker
  lastWriteAt?: number
  timer?: ReturnType<typeof setTimeout>
  pending?: TokenSpeedStatus
  settled: boolean
}

export function createTokenSpeedPlugin(options?: { now?: () => number }): PluginDefinition {
  return {
    id: TOKEN_SPEED_PLUGIN_ID,
    name: { en: 'Token Speed', 'zh-CN': '解码速率' },
    description: {
      en: 'Real-time decoding speed (tok/s) in the composer status line: streaming-observed speed, first-token latency, and terminal reconciliation.',
      'zh-CN': '输入区状态栏实时解码速率（tok/s）：流式观测速率、首 token 延迟与终态对账。',
    },
    icon: 'gauge',
    version: '0.1.0',
    ...resolvePluginClientAssets(TOKEN_SPEED_PLUGIN_ID, 'token-speed', 'token_speed_plugin_client_missing'),
    definePlugin(ctx) {
      const clock = options?.now ?? Date.now
      ctx.configSchema({
        slidingWindowMs: {
          type: 'number',
          label: { en: 'Sliding window (ms)', 'zh-CN': '滑动窗口（毫秒）' },
          description: { en: 'Time window for real-time speed (3000-15000 recommended for slow servers)', 'zh-CN': '实时速率时间窗口（慢服务器建议 3000-15000）' },
          default: DEFAULT_SLIDING_WINDOW_MS, minimum: MIN_SLIDING_WINDOW_MS, maximum: MAX_SLIDING_WINDOW_MS, integer: true,
        },
      })

      const speedDoc = ctx.sessionDoc<TokenSpeedStatus | null>(TOKEN_SPEED_DOC, null, { public: true, durable: false })
      const states = new Map<number, ConvState>()
      let active = true

      const nowOf = (v: number): number => (Number.isFinite(v) && v > 0 ? v : clock())
      const windowMsOf = (): number => {
        const raw = (ctx.getConfig() as { slidingWindowMs?: unknown }).slidingWindowMs
        return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(MAX_SLIDING_WINDOW_MS, Math.max(MIN_SLIDING_WINDOW_MS, Math.round(raw))) : DEFAULT_SLIDING_WINDOW_MS
      }
      const stateOf = (id: number): ConvState => {
        let s = states.get(id)
        if (!s) {
          s = { tracker: new ConversationTokenSpeedTracker({ windowMs: windowMsOf(), minSpanMs: MIN_SLIDING_WINDOW_MS }), settled: false }
          states.set(id, s)
        }
        return s
      }
      const cancelTimer = (s: ConvState): void => { if (s.timer !== undefined) clearTimeout(s.timer); s.timer = undefined; s.pending = undefined }
      const ignoreNotFound = (fn: () => void): void => { try { fn() } catch (err) { if (!(err instanceof HelmxError && err.status === 404)) throw err } }

      const publish = (id: number, status: TokenSpeedStatus | null, force: boolean, now: number): void => {
        const s = states.get(id)
        const prev = speedDoc.get(id)
        const throttle =
          !force && s && status && prev && prev.phase === status.phase &&
          !(prev.tps === undefined && status.tps !== undefined) &&
          s.lastWriteAt !== undefined && now >= s.lastWriteAt && now - s.lastWriteAt < DOC_WRITE_INTERVAL_MS
        if (throttle) {
          s.pending = status
          if (s.timer === undefined) {
            const timer = setTimeout(() => {
              s.timer = undefined
              const pending = s.pending
              s.pending = undefined
              if (!active || pending === undefined) return
              s.lastWriteAt = nowOf(clock())
              ignoreNotFound(() => speedDoc.set(id, pending))
            }, Math.max(1, DOC_WRITE_INTERVAL_MS - (now - s.lastWriteAt!)))
            timer.unref?.()
            s.timer = timer
          }
          return
        }
        if (s) { cancelTimer(s); s.lastWriteAt = now }
        ignoreNotFound(() => speedDoc.set(id, status))
      }

      const clearConversation = (id: number): void => {
        const s = states.get(id)
        if (s) { cancelTimer(s); states.delete(id) }
        ignoreNotFound(() => speedDoc.delete(id))
      }

      ctx.host.onEvent('conversation.live', (raw) => {
        const frame = asConversationLiveFrame(raw)
        if (!frame) return
        const now = nowOf(frame.updatedAt)
        const existing = states.get(frame.conversationId)
        if (existing?.settled) {
          if (!frame.generation) return
          existing.settled = false
          existing.tracker.resetChain()
        }
        const s = existing ?? stateOf(frame.conversationId)
        s.tracker.observeFrame(now, frame)
        const status = s.tracker.liveStatus(now)
        if (status) publish(frame.conversationId, status, false, now)
      })

      ctx.host.onEvent('conversation.entry', (raw) => {
        const env = asConversationEntryEnvelope(raw)
        if (!env) return
        if (CONTEXT_INVALIDATION_ENTRY_KINDS.has(env.kind)) { clearConversation(env.conversationId); return }
        if (env.kind !== 'pi.assistant') return
        const completion = asAssistantCompletion(raw)
        const s = completion ? states.get(env.conversationId) : undefined
        if (!completion || !s) return
        const now = nowOf(clock())
        s.tracker.noteCompletion(completion, now)
        if (!s.settled) {
          const status = s.tracker.liveStatus(now)
          if (status) publish(env.conversationId, status, false, now)
        }
      })

      ctx.hook.onTurnSettled((payload) => {
        const id = payload.conversation.id
        if (payload.outcome === 'failed' || payload.outcome === 'aborted') { clearConversation(id); return }
        if (payload.conversation.status === 'working') return
        const s = states.get(id)
        if (!s) return
        s.settled = true
        const now = nowOf(payload.settledAt)
        publish(id, s.tracker.settle(now) ?? null, true, now)
      })

      ctx.host.onEvent('conversation.deleted', (raw) => {
        const id = asConversationDeletedId(raw)
        if (id !== undefined) clearConversation(id)
      })

      ctx.service({
        id: 'speed-lifecycle',
        start: () => { active = true },
        stop: () => { active = false; for (const s of states.values()) cancelTimer(s); states.clear() },
      })

      ctx.ui.slot({ id: 'token-speed-status', target: COMPOSER_STATUS_SLOT, order: 10, client: { module: 'index.tsx', export: 'TokenSpeedStatusBadge' } })
    },
  }
}
