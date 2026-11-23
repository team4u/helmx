/**
 * builtin:triggers: the cron and webhook inbound connector.
 *
 * Responsibilities:
 * - Assemble the shared delivery helper (`delivery.ts`: isolated/dedicated automated `helmx`-owned
 *   conversations or explicit conversation injection with `followUp`, plus guarded retention pruning);
 * - Register the webhook connector (`webhook.ts`) and cron scheduler (`cron.ts`, with active-run overlap skip);
 * - Listen to `turn_settled` to prune excess settled isolated runs beyond `keepLast` cleanly via
 *   `ctx.host.deleteConversationGuarded` (never touching active, blocked, errored, or human conversations);
 * - Provide the client.tsx management UI (`TriggersManagerScreen` + `TriggersSettingsPanel`).
 */
import type { PluginDefinition } from '@helmx/protocol'
import { loadManagedSkillAsset, resolvePluginClientAssets } from './asset-paths.js'
import {
  DEFAULT_TRIGGER_KEEP_LAST,
  TRIGGERS_PLUGIN_ID,
  TRIGGERS_SKILL_ID,
  TRIGGER_TAG,
  parseTriggerSourceTag,
} from './triggers/contracts.js'
import {
  createDeliveryDispatch,
  findActiveTriggerRun,
  pruneIsolatedRuns,
} from './triggers/delivery.js'
import { registerWebhook } from './triggers/webhook.js'
import { registerCron } from './triggers/cron.js'

const TRIGGERS_SCREEN_ID = 'manager'
export { TRIGGERS_PLUGIN_ID, TRIGGERS_SKILL_ID }

function readTriggersSkillAsset() {
  return loadManagedSkillAsset({
    pluginId: TRIGGERS_PLUGIN_ID,
    skillId: TRIGGERS_SKILL_ID,
    relativeDir: 'triggers/skill',
    missingErrorCode: 'triggers_skill_missing',
  })
}

export function createTriggersPlugin(): PluginDefinition {
  return {
    id: TRIGGERS_PLUGIN_ID,
    name: { en: 'Triggers (cron + webhook)', 'zh-CN': '触发器（cron + webhook）' },
    description: {
      en: 'Inbound connector: cron timers and webhook inbound triggers, running in isolated or dedicated automated sessions (or explicit conversations) via escape-proof envelopes.',
      'zh-CN': '入站连接器：cron 定时与 webhook 入站触发，默认在隔离或专用自动化会话中运行（或显式投递到指定会话），经防逃逸信封投递。',
    },
    icon: 'webhook',
    version: '0.1.0',
    ...resolvePluginClientAssets(TRIGGERS_PLUGIN_ID, 'triggers', 'triggers_plugin_client_missing'),
    definePlugin(ctx) {
      const dispatch = createDeliveryDispatch({
        host: ctx.host,
        profiles: ctx.host.profiles,
        isClosing: () => ctx.host.isClosing,
      })

      const webhooks = registerWebhook(ctx, { dispatch })

      const crons = registerCron(ctx, {
        dispatchTrigger: dispatch,
        findActiveRun: (jobId) => findActiveTriggerRun(ctx.host, 'cron', jobId),
        profiles: ctx.host.profiles,
      })

      // Post-turn retention hook: when a settled automated isolated run finishes cleanly,
      // prune older settled runs beyond the trigger's keepLast cap via guarded deletion.
      ctx.hook.onTurnSettled(async (payload) => {
        if (payload.outcome !== 'completed' || ctx.host.isClosing) return
        const conv = payload.conversation
        if (
          conv.parentConversationId !== undefined ||
          (conv.ownedBy ?? 'human') !== 'helmx' ||
          !conv.tags.includes(TRIGGER_TAG)
        ) {
          return
        }
        const parsed = parseTriggerSourceTag(conv.tags)
        if (parsed === undefined) return
        let keepLast: number | undefined
        try {
          if (parsed.kind === 'cron') {
            const job = crons.getJob(parsed.id)
            if (job?.mode === 'isolated') keepLast = job.keepLast ?? DEFAULT_TRIGGER_KEEP_LAST
          } else {
            const hook = webhooks.getWebhook(parsed.id)
            if (hook?.mode === 'isolated') keepLast = hook.keepLast ?? DEFAULT_TRIGGER_KEEP_LAST
          }
        } catch {
          return
        }
        if (keepLast === undefined) return
        await pruneIsolatedRuns(ctx.host, parsed.kind, parsed.id, keepLast)
      })

      // ---- Managed skill: triggers (cron/webhook usage & security boundaries) ----
      ctx.service({
        id: 'triggers-skill',
        async start() {
          await ctx.host.skills.ensureSkill(readTriggersSkillAsset())
        },
        async stop() {},
      })

      // ---- Management UI (client.tsx React track; no Emoji) ----
      ctx.ui.sidebarItem({
        id: 'triggers-manager',
        label: { en: 'Trigger Manager', 'zh-CN': '触发器管理' },
        icon: 'clock',
        target: `screen:${TRIGGERS_PLUGIN_ID}/${TRIGGERS_SCREEN_ID}`,
        order: 15,
      })
      ctx.ui.screen({
        id: TRIGGERS_SCREEN_ID,
        label: { en: 'Trigger Manager', 'zh-CN': '触发器管理' },
        icon: 'clock',
        client: { module: 'manager.tsx', export: 'TriggersManagerScreen' },
      })
      ctx.ui.settingsPanel({
        id: 'triggers-settings',
        label: { en: 'Triggers', 'zh-CN': '触发器' },
        order: 40,
        client: { module: 'settings.tsx', export: 'TriggersSettingsPanel' },
      })
    },
  }
}
