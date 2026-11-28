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
import {
  HELMX_SEARCH_CAPABILITY_ID,
  type PluginDefinition,
  type PluginSearchItem,
  type PluginSearchProvider,
} from '@helmx/protocol'
import { loadManagedSkillAsset, resolvePluginClientAssets } from './asset-paths.js'
import { compactOneLine, rankSearchCandidates } from './search-utils.js'
import {
  DEFAULT_TRIGGER_KEEP_LAST,
  TRIGGERS_PLUGIN_ID,
  TRIGGERS_SKILL_ID,
  TRIGGER_TAG,
  parseTriggerSourceTag,
  type WebhookMeta,
} from './triggers/contracts.js'
import {
  createDeliveryDispatch,
  findActiveTriggerRun,
  pruneIsolatedRuns,
} from './triggers/delivery.js'
import { registerWebhook } from './triggers/webhook.js'
import { registerCron, type CronJob } from './triggers/cron.js'

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

      // ---- Dynamic Omnibox search (`helmx.search`; metadata only, zero secrets) ----
      type TriggerSearchCandidate =
        | { kind: 'cron'; job: CronJob; description?: string; text?: string }
        | { kind: 'webhook'; hook: WebhookMeta; description?: string; endpointPath: string }

      ctx.provide<PluginSearchProvider>(HELMX_SEARCH_CAPABILITY_ID, {
        search(input, signal) {
          if (signal.aborted) return []
          const candidates: TriggerSearchCandidate[] = []
          for (const job of crons.listJobs()) {
            if (signal.aborted) return []
            const description =
              job.description !== undefined ? compactOneLine(ctx.host.redact(job.description)) : undefined
            const text = compactOneLine(ctx.host.redact(job.text))
            candidates.push({ kind: 'cron', job, description, text })
          }
          for (const hook of webhooks.listWebhooks().webhooks) {
            if (signal.aborted) return []
            const description =
              hook.description !== undefined ? compactOneLine(ctx.host.redact(hook.description)) : undefined
            candidates.push({
              kind: 'webhook',
              hook,
              description,
              endpointPath: `/webhook/${hook.id}`,
            })
          }
          return rankSearchCandidates<TriggerSearchCandidate, PluginSearchItem>({
            query: input.query,
            limit: input.limit,
            signal,
            items: candidates,
            fields: (entry) =>
              entry.kind === 'cron'
                ? {
                    primary: [entry.job.id],
                    secondary: [
                      entry.description,
                      entry.job.schedule,
                      entry.job.timezone,
                      entry.job.profileId,
                      entry.text,
                    ],
                    keywords: ['cron', 'schedule', 'timer', 'trigger', '定时', '触发器'],
                  }
                : {
                    primary: [entry.hook.id],
                    secondary: [
                      entry.description,
                      entry.endpointPath,
                      entry.hook.profileId,
                      entry.hook.mode,
                    ],
                    keywords: ['webhook', 'webhooks', 'hook', 'trigger', 'inbound', '触发器', '端点'],
                  },
            tieBreaker: (entry) => `${entry.kind}:${entry.kind === 'cron' ? entry.job.id : entry.hook.id}`,
            toResult: (entry, score) => {
              if (entry.kind === 'cron') {
                const { job, description, text } = entry
                const summary = description ?? text
                const subtitle = summary !== undefined ? compactOneLine(`${job.schedule} · ${summary}`) : job.schedule
                return {
                  id: `cron:${job.id}`,
                  kind: 'resource',
                  title: job.id,
                  ...(subtitle !== undefined ? { subtitle } : {}),
                  breadcrumb: [
                    { en: 'Trigger Manager', 'zh-CN': '触发器管理' },
                    { en: 'Cron jobs', 'zh-CN': 'Cron 定时任务' },
                  ],
                  icon: 'clock',
                  badge: job.enabled
                    ? { en: 'Enabled', 'zh-CN': '启用' }
                    : { en: 'Disabled', 'zh-CN': '停用' },
                  target: `screen:${TRIGGERS_PLUGIN_ID}/${TRIGGERS_SCREEN_ID}?tab=cron&trigger=${encodeURIComponent(`cron:${job.id}`)}`,
                  score,
                }
              }
              const { hook, description, endpointPath } = entry
              const subtitle =
                description !== undefined
                  ? compactOneLine(`${description} · ${endpointPath}`)
                  : `POST ${endpointPath}`
              return {
                id: `webhook:${hook.id}`,
                kind: 'resource',
                title: hook.id,
                ...(subtitle !== undefined ? { subtitle } : {}),
                breadcrumb: [
                  { en: 'Trigger Manager', 'zh-CN': '触发器管理' },
                  { en: 'Webhook endpoints', 'zh-CN': 'Webhook 端点' },
                ],
                icon: 'webhook',
                badge: { en: 'Webhook', 'zh-CN': 'Webhook' },
                target: `screen:${TRIGGERS_PLUGIN_ID}/${TRIGGERS_SCREEN_ID}?tab=webhook&trigger=${encodeURIComponent(`webhook:${hook.id}`)}`,
                score,
              }
            },
          })
        },
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
        description: {
          en: 'Inspect and manage cron schedules, inbound webhooks, and recent automated runs.',
          'zh-CN': '查看与管理 Cron 定时任务、入站 Webhook 端点与近期自动化运行记录。',
        },
        keywords: ['trigger', 'triggers', 'cron', 'schedule', 'timer', 'webhook', 'hook', '定时', '触发器', '计划任务'],
        icon: 'clock',
        client: { module: 'manager.tsx', export: 'TriggersManagerScreen' },
      })
      ctx.ui.settingsPanel({
        id: 'triggers-settings',
        label: { en: 'Triggers', 'zh-CN': '触发器' },
        description: {
          en: 'Overview of configured cron jobs and webhook endpoints with quick entry to the manager.',
          'zh-CN': '查看已配置的定时任务与 Webhook 端点概览，并快速进入触发器管理页。',
        },
        keywords: ['trigger', 'triggers', 'cron', 'schedule', 'webhook', '定时', '触发器'],
        order: 40,
        client: { module: 'settings.tsx', export: 'TriggersSettingsPanel' },
      })
      ctx.ui.command({
        id: 'triggers-open-webhooks',
        title: { en: 'Open Webhook Endpoints', 'zh-CN': '打开 Webhook 端点管理' },
        description: {
          en: 'Jump directly to the Webhook endpoints tab in Trigger Manager.',
          'zh-CN': '直接跳转到触发器管理页面的 Webhook 端点标签页。',
        },
        icon: 'webhook',
        target: `screen:${TRIGGERS_PLUGIN_ID}/${TRIGGERS_SCREEN_ID}?tab=webhook`,
        keywords: ['webhook', 'webhooks', 'hook', 'trigger', 'inbound', '触发器', '入站', '端点'],
      })
    },
  }
}
