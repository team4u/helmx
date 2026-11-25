/**
 * builtin:magpie: the Magpie gateway integration plugin (model catalog / quotas).
 *
 * Responsibilities:
 * - Register the pi-ai dynamic-catalog Provider via ctx.provider (mounted by the host before
 *   service.start, unregistered after service.stop -- never hand-mounted around the host inside the plugin);
 * - The public status doc drives the composer status slot / settings.panel / commandPalette and
 *   the `helmx magpie status` CLI; the action bus provides status / refresh / quota;
 * - After turn_settled, silently refresh quotas in the background (?kept=1; asks no vendor, blocks no turn);
 * - Foreground Composer status slot refreshes models and quotas on the configurable `refreshIntervalSec`
 *   cadence (default 5s, 0 disables; catalog persistence and `models.changed` broadcast only fire when
 *   the catalog actually changed, preventing idle disk/SSE amplification), gated by `showQuotaStatus` (default true).
 *
 * Honesty discipline:
 * - All gateway reads execute against a snapshot frozen at read time, and verify the snapshot is
 *   still the effective config before publishing: after a config switch, old gateway data is never
 *   published under the new gateway's name;
 * - provider.refreshModels network failures always throw (visible as errors['magpie'] in generic
 *   catalog refreshes); this plugin's service.start background-refresh failures only update
 *   reachable:false / lastError, never blocking enablement or kernel startup; the manual refresh action throws magpie_gateway_unreachable explicitly;
 * - With reachable:false, modelCount is the cached count, never posing as a live refresh success;
 * - apiKey never enters the doc / action outputs / error text.
 * - Zero-arg factory: catalog refresh goes through ctx.host.refreshModels({ providers: ['magpie'] })
 *   and network reads use global fetch (no injection backdoors; tests use global fetch mocks).
 */
import { COMPOSER_STATUS_SLOT, HelmxError, type PluginDefinition, type TurnSettledPayload } from '@helmx/protocol'
import { loadManagedSkillAsset, resolvePluginClientAssets } from './asset-paths.js'
import { servedByRoot, toPiModels, type PiMagpieModel } from './magpie/catalog.js'
import {
  DEFAULT_MAGPIE_REFRESH_INTERVAL_SEC,
  DEFAULT_MAGPIE_ROOT,
  DEFAULT_MAGPIE_SHOW_QUOTA_STATUS,
  MAGPIE_PLUGIN_ID,
  MAGPIE_PROVIDER_ID,
  MAGPIE_STATUS_DOC,
  MAX_MAGPIE_REFRESH_INTERVAL_SEC,
  sameGateway,
  type MagpieGatewayRef,
  type MagpiePluginConfig,
  type MagpieStatusDoc,
} from './magpie/contracts.js'
import { fetchCatalog, fetchQuotas, resolveGateway } from './magpie/gateway.js'
import { quotaRows } from './magpie/quota.js'
import { createMagpieProvider } from './magpie/provider.js'

export const MAGPIE_SKILL_ID = 'magpie' as const
export { MAGPIE_PLUGIN_ID }

function readMagpieSkillAsset() {
  return loadManagedSkillAsset({
    pluginId: MAGPIE_PLUGIN_ID,
    skillId: MAGPIE_SKILL_ID,
    relativeDir: 'magpie/skill',
    missingErrorCode: 'magpie_skill_missing',
  })
}

const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  required: [
    'gatewayUrl',
    'configuredRoot',
    'local',
    'reachable',
    'modelCount',
    'summaryText',
    'modelOwners',
    'quotas',
    'diagnostics',
  ],
  properties: {
    gatewayUrl: { type: 'string' },
    configuredRoot: { type: 'boolean' },
    local: { type: 'boolean' },
    reachable: { type: 'boolean' },
    modelCount: { type: 'number' },
    lastRefreshedAt: { type: 'number' },
    lastError: { type: 'string' },
    quotasRefreshedAt: { type: 'number' },
    quotasUpdatedAt: { type: 'number' },
    quotasError: { type: 'string' },
    summaryText: { type: 'string' },
    modelOwners: { type: 'object', additionalProperties: { type: 'string' } },
    quotas: { type: 'array', items: { type: 'object', additionalProperties: true } },
    diagnostics: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const

const REFRESH_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['refreshed', 'modelCount', 'reachable'],
  properties: {
    refreshed: { type: 'boolean' },
    modelCount: { type: 'number' },
    reachable: { type: 'boolean' },
    lastError: { type: 'string' },
  },
  additionalProperties: false,
} as const

// Note: on refresh-action failure, throw HelmxError explicitly (no degraded result returned); on success,
// reasons why quotas are unavailable live in the status doc diagnostics, readable via the status action.

const QUOTA_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['quotas', 'local'],
  properties: {
    quotas: { type: 'array', items: { type: 'object', additionalProperties: true } },
    local: { type: 'boolean' },
    note: { type: 'string' },
  },
  additionalProperties: false,
} as const

const emptyStatus = (gatewayUrl: string): MagpieStatusDoc => ({
  gatewayUrl,
  configuredRoot: false,
  local: true,
  reachable: false,
  modelCount: 0,
  summaryText: 'Magpie · not connected',
  modelOwners: {},
  quotas: [],
  diagnostics: [],
})

/** Error-text redaction: strip Bearer-header shapes and pass through SecretStash redactor (gateway error pages may echo secrets). */
function sanitizeErrorText(error: unknown, redact?: (text: string) => string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const stripped = raw.replace(/Bearer\s+\S+/g, 'Bearer ***')
  return (redact ? redact(stripped) : stripped).slice(0, 300)
}

/** Extract provider prefix from a `provider/model` ref, ignoring routing group namespaces (`group/*`, `auto/*`). */
function directProviderOf(modelId: string): string | undefined {
  const slash = modelId.indexOf('/')
  if (slash <= 0) return undefined
  const prefix = modelId.slice(0, slash).trim()
  if (!prefix || prefix === 'group' || prefix === 'auto') return undefined
  return prefix
}

/** Build `modelId -> owning provider` map for models under the current gateway snapshot. */
function modelOwnersOf(models: readonly PiMagpieModel[]): Record<string, string> {
  const owners: Record<string, string> = {}
  for (const model of models) {
    const owner = model.magpieOwnedBy?.trim() || directProviderOf(model.id)
    if (owner) owners[model.id] = owner
  }
  return owners
}

/** Deterministic catalog fingerprint so foreground polling skips redundant persistence and global asset reloads. */
function catalogFingerprint(models: readonly PiMagpieModel[]): string {
  const normalized = [...models]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((model) => ({
      id: model.id,
      name: model.name,
      api: model.api,
      baseUrl: model.baseUrl,
      reasoning: model.reasoning,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      magpieOwnedBy: model.magpieOwnedBy,
      helmxContextWindowKnown: model.helmxContextWindowKnown,
      thinkingLevelMap: model.thinkingLevelMap,
      compat: 'compat' in model ? model.compat : undefined,
    }))
  return JSON.stringify(normalized)
}

/** Semantic comparison excluding volatile timestamps and derived countdown `resetText` so identical 5s polls do not amplify global SSE traffic. */
function statusContentEqual(a: MagpieStatusDoc, b: MagpieStatusDoc): boolean {
  const stripVolatile = (doc: MagpieStatusDoc) => ({
    gatewayUrl: doc.gatewayUrl,
    configuredRoot: doc.configuredRoot,
    local: doc.local,
    reachable: doc.reachable,
    modelCount: doc.modelCount,
    lastError: doc.lastError,
    quotasError: doc.quotasError,
    summaryText: doc.summaryText,
    modelOwners: doc.modelOwners,
    quotas: doc.quotas.map(({ resetText: _r, ...rest }) => rest),
    diagnostics: doc.diagnostics,
  })
  return JSON.stringify(stripVolatile(a)) === JSON.stringify(stripVolatile(b))
}

export function createMagpiePlugin(): PluginDefinition {
  const fetchImpl: typeof fetch = fetch

  return {
    id: MAGPIE_PLUGIN_ID,
    name: { en: 'Magpie Gateway', 'zh-CN': 'Magpie 网关' },
    description: {
      en: 'Magpie model gateway integration: dynamic model catalog and quotas, with silent refresh and a status panel.',
      'zh-CN': 'Magpie 模型网关集成：动态模型目录与配额，静默刷新与状态面板。',
    },
    icon: 'globe',
    version: '0.1.0',
    ...resolvePluginClientAssets(MAGPIE_PLUGIN_ID, 'magpie', 'magpie_plugin_client_missing'),
    definePlugin(rawCtx) {
      const ctx = rawCtx

      // ---- Config and gateway snapshot -------------------------------------------------
      ctx.configSchema({
        gatewayUrl: {
          type: 'string',
          label: { en: 'Magpie gateway address', 'zh-CN': 'Magpie 网关地址' },
          description: {
            en: 'Defaults to the local http://127.0.0.1:3425 (you may set http://host:3425)',
            'zh-CN': '缺省为本地 http://127.0.0.1:3425（可设 http://host:3425）',
          },
          // Omit schema `default` so ctx.getConfig() distinguishes an unset override (falling
          // through to MAGPIE_GW_URL/MAGPIE_ADDR or silent default loopback) from an explicit URL.
        },
        apiKey: {
          type: 'string',
          label: { en: 'Magpie API Key', 'zh-CN': 'Magpie API 密钥' },
          description: {
            en: 'Defaults to magpie on the local loopback; fill in the matching key for a remote gateway',
            'zh-CN': '缺省使用本地回环上的 magpie；远端网关填写对应密钥',
          },
          secret: true,
        },
        showQuotaStatus: {
          type: 'boolean',
          label: { en: 'Show quota information', 'zh-CN': '显示配额信息' },
          description: {
            en: 'Display Magpie model quotas in the composer status bar and settings panel (enabled by default; disabling also pauses foreground quota polling)',
            'zh-CN': '在输入框状态栏与设置面板中展示 Magpie 配额信息（默认开启；关闭后同时停止前台配额轮询）',
          },
          default: DEFAULT_MAGPIE_SHOW_QUOTA_STATUS,
        },
        refreshIntervalSec: {
          type: 'number',
          label: { en: 'Auto-refresh interval (seconds)', 'zh-CN': '自动刷新间隔（秒）' },
          description: {
            en: 'Interval to refresh Magpie models and quotas while a Magpie model is open in the foreground (0 disables auto-refresh; default 5 seconds)',
            'zh-CN': '前台使用 Magpie 模型时自动刷新模型目录与配额的间隔秒数（0 表示关闭自动刷新，默认 5 秒）',
          },
          default: DEFAULT_MAGPIE_REFRESH_INTERVAL_SEC,
          minimum: 0,
          maximum: MAX_MAGPIE_REFRESH_INTERVAL_SEC,
          integer: true,
        },
      })

      /** The currently effective config (a config-store view; unconfigured fields fall back to gateway-resolution defaults). */
      const effectiveConfig = (): MagpiePluginConfig => {
        const raw = ctx.getConfig() as Partial<MagpiePluginConfig>
        return {
          ...(typeof raw.gatewayUrl === 'string' && raw.gatewayUrl.trim() !== '' ? { gatewayUrl: raw.gatewayUrl } : {}),
          ...(typeof raw.apiKey === 'string' && raw.apiKey.trim() !== '' ? { apiKey: raw.apiKey } : {}),
          ...(typeof raw.showQuotaStatus === 'boolean' ? { showQuotaStatus: raw.showQuotaStatus } : {}),
          ...(typeof raw.refreshIntervalSec === 'number' && Number.isFinite(raw.refreshIntervalSec)
            ? { refreshIntervalSec: raw.refreshIntervalSec }
            : {}),
        }
      }

      const gateway = (): MagpieGatewayRef => resolveGateway(effectiveConfig())

      // ---- provider and the public status doc --------------------------------------
      /**
       * Network catalog-refresh results -> the status doc (the onCatalogChange port): when the generic
       * HTTP models.refresh refreshes the Provider, plugin state updates in sync, no longer diverging;
       * cache-only recovery does not notify (not a network success; never disguised). Publishing passes the
       * sameGateway guard too: conclusions from a fetch during which the gateway switched are never written under the new gateway.
       */
      const handle = createMagpieProvider({
        gateway,
        fetchImpl,
        onCatalogChange(change) {
          publishCatalogStatus(
            change.gateway,
            change.ok,
            change.ok || change.idle ? undefined : change.error,
            { clearLastError: change.idle === true },
          )
        },
      })
      ctx.provider(handle.provider)

      const redactText = (text: string): string => ctx.host.redact(text)
      const sanitizeError = (error: unknown): string => sanitizeErrorText(error, redactText)

      const status = ctx.doc<MagpieStatusDoc>(MAGPIE_STATUS_DOC, emptyStatus(DEFAULT_MAGPIE_ROOT), {
        public: true,
        durable: false,
      })

      /** Service stop signal and in-flight abort controllers: no doc writes after disable. */
      let stopping = false
      const activeControllers = new Set<AbortController>()

      const beginRequest = (): { controller: AbortController; done: () => void } => {
        const controller = new AbortController()
        activeControllers.add(controller)
        return {
          controller,
          done: () => {
            activeControllers.delete(controller)
          },
        }
      }

      const isCurrentGateway = (snapshot: MagpieGatewayRef): boolean => {
        try {
          return sameGateway(snapshot, gateway())
        } catch {
          return false
        }
      }

      const gatewayChangedError = (): HelmxError =>
        new HelmxError('magpie_gateway_changed', '网关配置已变化，刷新结果未采用，请重新刷新目录', 409)

      const modelsForSnapshot = (snapshot: MagpieGatewayRef): PiMagpieModel[] =>
        handle.models().filter((model) => servedByRoot(model, snapshot.root))

      /** Pre-publish guard: write into the doc only while the snapshot is still the effective config. */
      const writeStatus = (
        snapshot: MagpieGatewayRef,
        patch: Partial<MagpieStatusDoc>,
        options?: { clearLastError?: boolean; clearQuotasError?: boolean; skipIfUnchanged?: boolean },
      ): void => {
        if (stopping) return
        let currentGateway: MagpieGatewayRef
        try {
          currentGateway = gateway()
        } catch {
          return
        }
        if (!sameGateway(snapshot, currentGateway)) return
        const prev = status.get()
        const sameRoot = prev.gatewayUrl === snapshot.root
        const base: MagpieStatusDoc = sameRoot
          ? { ...prev }
          : {
              ...emptyStatus(currentGateway.root),
              configuredRoot: currentGateway.configuredRoot,
              local: currentGateway.local,
            }
        if (options?.clearLastError && base.lastError !== undefined) {
          delete base.lastError
        }
        if (options?.clearQuotasError && base.quotasError !== undefined) {
          delete base.quotasError
        }
        const next: MagpieStatusDoc = {
          ...base,
          ...patch,
          gatewayUrl: currentGateway.root,
          configuredRoot: currentGateway.configuredRoot,
          local: currentGateway.local,
        }
        if (
          options?.skipIfUnchanged
          && sameRoot
          && (prev.quotasRefreshedAt !== undefined || next.quotasRefreshedAt === undefined)
          && statusContentEqual(prev, next)
        ) {
          return
        }
        status.set(next)
      }

      const summaryTextOf = (reachable: boolean, modelCount: number): string =>
        reachable ? `Magpie · ${modelCount} models` : 'Magpie · not connected'

      /**
       * Read quotas and update the doc (executed on the snapshot; kept=true asks no vendor).
       * Honesty: quota read failures are not swallowed -- the reason goes into diagnostics
       * (for background/startup sync, clears old quotas and records unavailability; for preserveQuotasOnError
       * foreground polling, preserves the last known snapshot alongside quotasError so the status bar
       * discloses staleness rather than vanishing).
       */
      const refreshSidecar = async (
        snapshot: MagpieGatewayRef,
        kept: boolean,
        options?: { preserveQuotasOnError?: boolean; skipIfUnchanged?: boolean },
      ): Promise<void> => {
        if (stopping || !isCurrentGateway(snapshot)) return
        const { controller, done } = beginRequest()
        try {
          const prev = status.get()
          const sameRoot = prev.gatewayUrl === snapshot.root
          const diagnostics: string[] = []
          let quotas: MagpieStatusDoc['quotas'] = []
          let quotaOk = false
          let quotaErr: string | undefined
          try {
            const entries = await fetchQuotas(snapshot.root, snapshot.token, controller.signal, fetchImpl, { kept })
            quotas = quotaRows(entries, Date.now(), redactText).map((row) => ({ ...row }))
            quotaOk = true
          } catch (error) {
            quotaErr = sanitizeError(error)
            quotas = options?.preserveQuotasOnError && sameRoot ? prev.quotas : []
            diagnostics.push(`quotas unavailable: ${quotaErr}`)
          }
          if (stopping || controller.signal.aborted || !isCurrentGateway(snapshot)) return
          const now = Date.now()
          writeStatus(
            snapshot,
            {
              quotas,
              diagnostics,
              modelOwners: modelOwnersOf(modelsForSnapshot(snapshot)),
              ...(quotaOk ? { quotasUpdatedAt: now } : {}),
              ...(quotaOk && !kept ? { quotasRefreshedAt: now } : {}),
              ...(quotaErr !== undefined ? { quotasError: quotaErr } : {}),
            },
            {
              clearQuotasError: quotaOk,
              skipIfUnchanged: options?.skipIfUnchanged,
            },
          )
        } finally {
          done()
        }
      }

      /** Status publishing after a catalog refresh (snapshot guard + reachable semantics). */
      const publishCatalogStatus = (
        snapshot: MagpieGatewayRef,
        reachable: boolean,
        error?: unknown,
        options?: { clearLastError?: boolean; skipIfUnchanged?: boolean },
      ): void => {
        if (stopping) return
        const currentModels = modelsForSnapshot(snapshot)
        const modelCount = currentModels.length
        const modelOwners = modelOwnersOf(currentModels)
        if (reachable) {
          // Success clears old errors: the previous round's failure conclusion must not linger as the
          // latest state (jsonClone rejects undefined values; delete keys explicitly instead of assigning undefined)
          writeStatus(
            snapshot,
            {
              reachable: true,
              modelCount,
              modelOwners,
              summaryText: summaryTextOf(true, modelCount),
              lastRefreshedAt: Date.now(),
            },
            { clearLastError: true, skipIfUnchanged: options?.skipIfUnchanged },
          )
        } else {
          writeStatus(
            snapshot,
            {
              reachable: false,
              modelCount,
              modelOwners,
              summaryText: summaryTextOf(false, modelCount),
              ...(error !== undefined ? { lastError: sanitizeError(error) } : {}),
            },
            { clearLastError: options?.clearLastError, skipIfUnchanged: options?.skipIfUnchanged },
          )
        }
      }

      // ---- service lifecycle ------------------------------------------------
      ctx.service({
        id: 'magpie-gateway',
        async start() {
          stopping = false
          await ctx.host.skills.ensureSkill(readMagpieSkillAsset())
          if (stopping) return
          const { controller, done } = beginRequest()
          const snapshot = gateway()
          // Initialization: first honestly show the recovered cache (the catalog count restored by
          // refreshModels's first phase), then let the background network refresh advance reachable / lastError.
          const cachedModels = modelsForSnapshot(snapshot)
          status.set({
            ...emptyStatus(snapshot.root),
            configuredRoot: snapshot.configuredRoot,
            local: snapshot.local,
            modelCount: cachedModels.length,
            modelOwners: modelOwnersOf(cachedModels),
            summaryText: summaryTextOf(false, cachedModels.length),
          })
          // Non-blocking background refresh: configured failures record reachable:false / lastError;
          // unconfigured default loopback connection refusal stays idle (reachable:false, no error noise).
          void (async () => {
            try {
              if (stopping || controller.signal.aborted) return
              const snapshotInner = gateway()
              const result = await ctx.host.refreshModels({ providers: [MAGPIE_PROVIDER_ID], allowNetwork: true, force: true })
              if (stopping || controller.signal.aborted || !isCurrentGateway(snapshotInner)) return
              const error = result.errors['magpie']
              if (error !== undefined) {
                publishCatalogStatus(snapshotInner, false, error)
                return
              }
              const idleError = handle.lastIdleError()
              if (idleError !== undefined && idleError.root === snapshotInner.root) {
                publishCatalogStatus(snapshotInner, false, undefined, { clearLastError: true })
                return
              }
              publishCatalogStatus(snapshotInner, true)
              if (stopping || controller.signal.aborted || !isCurrentGateway(snapshotInner)) return
              await refreshSidecar(snapshotInner, true)
            } catch (error) {
              if (stopping || controller.signal.aborted) return
              // Composition-layer port exception (not a gateway diagnostic): record honestly, do not block startup
              try {
                publishCatalogStatus(gateway(), false, error)
              } catch {
                /* invalid gateway config surfaces on explicit actions */
              }
            } finally {
              done()
            }
          })()
        },
        async stop() {
          stopping = true
          for (const controller of [...activeControllers]) {
            controller.abort(new Error('magpie plugin stopping'))
          }
          activeControllers.clear()
        },
      })

      // ---- turn_settled: background silent quota refresh (never blocking turn settlement) ------------
      // Only conversations using magpie models matter: other conversations (other Providers) settling
      // trigger no gateway reads (the conversation's current model is taken live from payload.conversation; no guessing).
      ctx.hook.onTurnSettled((payload: TurnSettledPayload) => {
        if (stopping) return
        const model = payload.conversation.model
        if (!model.startsWith(`${MAGPIE_PROVIDER_ID}/`)) return
        let snapshot: MagpieGatewayRef
        try {
          snapshot = gateway()
        } catch {
          return
        }
        // No await: never blocks turn_settled; failures only enter diagnostics, retried at the next settled
        void refreshSidecar(snapshot, true, { skipIfUnchanged: true }).catch((error) => {
          if (stopping) return
          ctx.host.emitEvent('notification', {
            level: 'warning', title: 'Magpie status read failed', body: sanitizeError(error),
          })
        })
      })

      // ---- Action bus (HTTP / helmx magpie <action> / run_action / Workflow) ----
      ctx.action({
        id: 'status',
        description: 'Magpie gateway status snapshot (reachability, model count, quotas)',
        exposeToPrompt: false,
        idempotent: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: STATUS_OUTPUT_SCHEMA,
        handler: () => {
          // Project the currently effective gateway at read time: after a config switch, the doc's gatewayUrl
          // leaves no stale root; when the doc still points at the old root, catalog / reachability conclusions
          // hold only for that root -- the new root has no conclusions yet and none are faked (reachable stays false pending the first refresh).
          const snapshot = gateway()
          const doc = status.get()
          const currentModels = modelsForSnapshot(snapshot)
          if (doc.gatewayUrl !== snapshot.root) {
            return {
              ...doc,
              gatewayUrl: snapshot.root,
              configuredRoot: snapshot.configuredRoot,
              local: snapshot.local,
              reachable: false,
              modelCount: 0,
              modelOwners: {},
            }
          }
          return {
            ...doc,
            configuredRoot: snapshot.configuredRoot,
            local: snapshot.local,
            // The model count and owner map count only the catalog under the current root (old-root caches do not pose)
            modelCount: currentModels.length,
            modelOwners: modelOwnersOf(currentModels),
          }
        },
      })

      ctx.action({
        id: 'refresh',
        description: 'Force-refresh the Magpie model catalog and quota state (failures error explicitly)',
        exposeToPrompt: false,
        inputSchema: {
          type: 'object',
          properties: {
            onlyIfChanged: {
              type: 'boolean',
              description: 'Skip rewriting the persisted catalog and broadcasting models.changed when /v1/models is unchanged (used by periodic foreground polling)',
            },
          },
          additionalProperties: false,
        },
        outputSchema: REFRESH_OUTPUT_SCHEMA,
        handler: async (input?: { onlyIfChanged?: boolean }) => {
          const snapshot = gateway()
          const onlyIfChanged = input?.onlyIfChanged === true
          if (onlyIfChanged) {
            const { controller, done } = beginRequest()
            let entries
            try {
              entries = await fetchCatalog(snapshot.root, snapshot.token, controller.signal, fetchImpl)
            } catch (error) {
              if (!isCurrentGateway(snapshot)) throw gatewayChangedError()
              const message = sanitizeError(error)
              publishCatalogStatus(snapshot, false, message, { skipIfUnchanged: true })
              throw new HelmxError(
                'magpie_gateway_unreachable',
                `Magpie gateway ${snapshot.root} refresh failed: ${message}`,
                502,
                { gatewayUrl: snapshot.root, configuredRoot: snapshot.configuredRoot },
              )
            } finally {
              done()
            }
            if (!isCurrentGateway(snapshot)) throw gatewayChangedError()
            const candidate = toPiModels(entries, snapshot.root)
            const currentModels = modelsForSnapshot(snapshot)
            const changed = !handle.synced(snapshot) || catalogFingerprint(candidate) !== catalogFingerprint(currentModels)
            if (changed) {
              handle.primePrefetchedCatalog(snapshot, entries)
              const result = await ctx.host.refreshModels({ providers: [MAGPIE_PROVIDER_ID], allowNetwork: true, force: true })
              if (!isCurrentGateway(snapshot)) throw gatewayChangedError()
              const idleError = handle.lastIdleError()
              const error = result.errors['magpie'] ?? (idleError?.root === snapshot.root ? idleError.error : undefined)
              publishCatalogStatus(snapshot, error === undefined, error)
              if (error !== undefined) {
                throw new HelmxError(
                  'magpie_gateway_unreachable',
                  `Magpie gateway ${snapshot.root} refresh failed: ${sanitizeError(error)}`,
                  502,
                  { gatewayUrl: snapshot.root, configuredRoot: snapshot.configuredRoot },
                )
              }
            } else {
              publishCatalogStatus(snapshot, true, undefined, { skipIfUnchanged: true })
            }
            if (!isCurrentGateway(snapshot)) throw gatewayChangedError()
            await refreshSidecar(snapshot, false, { preserveQuotasOnError: true, skipIfUnchanged: true })
            if (!isCurrentGateway(snapshot)) throw gatewayChangedError()
            const doc = status.get()
            return { refreshed: true, modelCount: doc.modelCount, reachable: true }
          }

          const result = await ctx.host.refreshModels({ providers: [MAGPIE_PROVIDER_ID], allowNetwork: true, force: true })
          if (!isCurrentGateway(snapshot)) throw gatewayChangedError()
          const idleError = handle.lastIdleError()
          const error = result.errors['magpie'] ?? (idleError?.root === snapshot.root ? idleError.error : undefined)
          publishCatalogStatus(snapshot, error === undefined, error)
          if (error !== undefined) {
            throw new HelmxError(
              'magpie_gateway_unreachable',
              `Magpie gateway ${snapshot.root} refresh failed: ${sanitizeError(error)}`,
              502,
              { gatewayUrl: snapshot.root, configuredRoot: snapshot.configuredRoot },
            )
          }
          await refreshSidecar(snapshot, false)
          if (!isCurrentGateway(snapshot)) throw gatewayChangedError()
          const doc = status.get()
          return { refreshed: true, modelCount: doc.modelCount, reachable: true }
        },
      })

      ctx.action({
        id: 'quota',
        description: 'Query Magpie quotas live (GET /v1/magpie/quotas)',
        exposeToPrompt: false,
        idempotent: true,
        inputSchema: {
          type: 'object',
          properties: { model: { type: 'string', description: 'Filter by the model-owning provider (optional)' } },
          additionalProperties: false,
        },
        outputSchema: QUOTA_OUTPUT_SCHEMA,
        handler: async (input: { model?: string }) => {
          const snapshot = gateway()
          const { controller, done } = beginRequest()
          try {
            const entries = await fetchQuotas(snapshot.root, snapshot.token, controller.signal, fetchImpl)
            const allRows = quotaRows(entries, Date.now(), redactText).map((row) => ({ ...row }))
            const now = Date.now()
            const prev = status.get()
            const nextDiagnostics =
              prev.gatewayUrl === snapshot.root
                ? prev.diagnostics.filter((item) => !item.startsWith('quotas unavailable:'))
                : []
            writeStatus(
              snapshot,
              {
                quotas: allRows,
                quotasRefreshedAt: now,
                quotasUpdatedAt: now,
                diagnostics: nextDiagnostics,
                modelOwners: modelOwnersOf(modelsForSnapshot(snapshot)),
              },
              { clearQuotasError: true },
            )
            let rows = allRows
            if (input.model !== undefined && input.model !== '') {
              const bareModel = input.model.startsWith(`${MAGPIE_PROVIDER_ID}/`)
                ? input.model.slice(MAGPIE_PROVIDER_ID.length + 1)
                : input.model
              const owners = modelOwnersOf(modelsForSnapshot(snapshot))
              const primaryOwner = owners[bareModel] ?? directProviderOf(bareModel)
              if (primaryOwner) rows = rows.filter((row) => row.provider === primaryOwner)
            }
            return {
              quotas: rows,
              local: snapshot.local,
              ...(snapshot.local ? {} : { note: 'non-local gateway: only quotas reported by that gateway itself are readable' }),
            }
          } catch (error) {
            const message = sanitizeError(error)
            writeStatus(snapshot, { quotasError: message })
            throw new HelmxError(
              'magpie_gateway_unreachable',
              `Magpie gateway ${snapshot.root} quota read failed: ${message}`,
              502,
              { gatewayUrl: snapshot.root },
            )
          } finally {
            done()
          }
        },
      })

      // ---- Declarative UI (client.tsx React track; no Emoji, lucide line icons) --------
      ctx.ui.slot({
        id: 'magpie-composer-quota',
        target: COMPOSER_STATUS_SLOT,
        order: 20,
        client: { module: 'composer-quota.tsx', export: 'MagpieComposerQuotaStatus' },
      })

      ctx.ui.settingsPanel({
        id: 'magpie-panel',
        label: { en: 'Magpie Gateway', 'zh-CN': 'Magpie 网关' },
        order: 25,
        client: { module: 'settings.tsx', export: 'MagpieSettingsPanel' },
      })

      ctx.ui.command({
        id: 'magpie-refresh',
        title: { en: 'Refresh the Magpie model catalog', 'zh-CN': '刷新 Magpie 模型目录' },
        actionId: 'refresh',
        input: {},
        keywords: ['magpie', 'models', 'refresh'],
      })
    },
  }
}
