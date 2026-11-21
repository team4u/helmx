/**
 * builtin:magpie: the Magpie gateway integration plugin (model catalog / quotas / routing groups).
 *
 * Responsibilities:
 * - Register the pi-ai dynamic-catalog Provider via ctx.provider (mounted by the host before
 *   service.start, unregistered after service.stop -- never hand-mounted around the host inside the plugin);
 * - The public status doc drives the composer status slot / settings.panel / commandPalette and
 *   the `helmx magpie status` CLI; the action bus provides refresh / quota / groups / group;
 * - After turn_settled, silently refresh quotas and routing in the background (?kept=1; asks no vendor, blocks no turn);
 * - Foreground Composer status slot refreshes models and quotas on the configurable `refreshIntervalSec`
 *   cadence (default 5s, 0 disables; catalog persistence and `models.changed` broadcast only fire when
 *   the catalog actually changed, preventing idle disk/SSE amplification).
 *
 * Honesty discipline:
 * - All gateway reads execute against a snapshot frozen at read time, and verify the snapshot is
 *   still the effective config before publishing: after a config switch, old gateway data is never
 *   published under the new gateway's name;
 * - provider.refreshModels network failures always throw (visible as errors['magpie'] in generic
 *   catalog refreshes); this plugin's service.start background-refresh failures only update
 *   reachable:false / lastError, never blocking enablement or kernel startup; the manual refresh action throws magpie_gateway_unreachable explicitly;
 * - With reachable:false, modelCount is the cached count, never posing as a live refresh success;
 * - Non-loopback gateways never read the local magpie CLI data (that is another instance); only the
 *   chosen gateway's trace is used, with the source labeled; apiKey never enters the doc / action outputs / error text.
 * - Zero-arg factory: catalog refresh goes through ctx.host.refreshModels({ providers: ['magpie'] }),
 *   network reads use global fetch, and the local CLI goes through the public execFile port
 *   (no injection backdoors; tests use PATH fixtures / global fetch mocks).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { COMPOSER_STATUS_SLOT, HelmxError, type PluginDefinition, type TurnSettledPayload } from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import { toPiModels, type PiMagpieModel } from './magpie/catalog.js'
import {
  DEFAULT_MAGPIE_REFRESH_INTERVAL_SEC,
  DEFAULT_MAGPIE_ROOT,
  MAGPIE_PLUGIN_ID,
  MAGPIE_PROVIDER_ID,
  MAGPIE_STATUS_DOC,
  MAX_MAGPIE_REFRESH_INTERVAL_SEC,
  sameGateway,
  type MagpieGatewayRef,
  type MagpiePluginConfig,
  type MagpieStatusDoc,
} from './magpie/contracts.js'
import { fetchCatalog, fetchQuotas, fetchTrace, resolveGateway } from './magpie/gateway.js'
import { quotaRows } from './magpie/quota.js'
import {
  latestGroupRouteIn,
  parseGroupShow,
  parseGroupsList,
  traceRouteRows,
  type GroupListRow,
  type TraceRoute,
} from './magpie/routing.js'
import { createMagpieProvider } from './magpie/provider.js'

export { MAGPIE_PLUGIN_ID }

const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  required: [
    'gatewayUrl',
    'configuredRoot',
    'local',
    'reachable',
    'modelCount',
    'groupCount',
    'summaryText',
    'modelOwners',
    'quotas',
    'routes',
    'diagnostics',
  ],
  properties: {
    gatewayUrl: { type: 'string' },
    configuredRoot: { type: 'boolean' },
    local: { type: 'boolean' },
    reachable: { type: 'boolean' },
    modelCount: { type: 'number' },
    groupCount: { type: 'number' },
    lastRefreshedAt: { type: 'number' },
    lastError: { type: 'string' },
    quotasRefreshedAt: { type: 'number' },
    quotasUpdatedAt: { type: 'number' },
    quotasError: { type: 'string' },
    summaryText: { type: 'string' },
    modelOwners: { type: 'object', additionalProperties: { type: 'string' } },
    groupProviders: {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
    },
    quotas: { type: 'array', items: { type: 'object', additionalProperties: true } },
    routes: { type: 'array', items: { type: 'object', additionalProperties: true } },
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
// reasons why quotas / traces are unavailable live in the status doc diagnostics, readable via the status action.

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

const GROUPS_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['groups', 'local'],
  properties: {
    groups: { type: 'array', items: { type: 'object', additionalProperties: true } },
    local: { type: 'boolean' },
    note: { type: 'string' },
    cliError: { type: 'string' },
  },
  additionalProperties: false,
} as const

const GROUP_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['id', 'source'],
  properties: {
    id: { type: 'string' },
    definition: { type: 'object', additionalProperties: true },
    lastRoute: { type: 'object', additionalProperties: true },
    source: { type: 'string' },
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
  groupCount: 0,
  summaryText: 'Magpie · not connected',
  modelOwners: {},
  quotas: [],
  routes: [],
  diagnostics: [],
})

/** Error-text redaction: strip Bearer-header shapes and known token bodies (gateway error pages may echo them). */
function sanitizeErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/Bearer\s+\S+/g, 'Bearer ***').slice(0, 300)
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

function addGroupProviders(
  target: Map<string, string[]>,
  key: string | undefined,
  providers: readonly (string | undefined)[],
): void {
  const normalizedKey = key?.trim()
  if (!normalizedKey) return
  let list = target.get(normalizedKey)
  for (const raw of providers) {
    const provider = raw?.trim()
    if (!provider || provider === 'group' || provider === 'auto') continue
    if (list === undefined) {
      list = []
      target.set(normalizedKey, list)
    }
    if (!list.includes(provider)) list.push(provider)
  }
}

function collectGroupProvidersFromTrace(routes: readonly TraceRoute[]): Record<string, string[]> {
  const map = new Map<string, string[]>()
  for (const route of routes) {
    const memberProviders = [
      ...(route.group?.members ?? []).map((member) => directProviderOf(member)),
      route.provider,
      route.served ? directProviderOf(route.served) : undefined,
    ]
    const groupShort = route.group?.id?.trim().replace(/^group\//, '')
    if (groupShort) addGroupProviders(map, `group/${groupShort}`, memberProviders)
    if (route.model?.trim()) addGroupProviders(map, route.model.trim(), memberProviders)
  }
  return Object.fromEntries(map)
}

function collectGroupProvidersFromCli(groups: readonly GroupListRow[] | undefined): Record<string, string[]> {
  if (!groups || groups.length === 0) return {}
  const map = new Map<string, string[]>()
  for (const group of groups) {
    const memberProviders = group.members.map((member) => directProviderOf(member))
    addGroupProviders(map, group.id, memberProviders)
  }
  return Object.fromEntries(map)
}

function mergeGroupProviders(
  base: Record<string, string[]> | undefined,
  incoming: Record<string, string[]>,
): Record<string, string[]> | undefined {
  const map = new Map<string, string[]>()
  if (base) {
    for (const [key, list] of Object.entries(base)) {
      addGroupProviders(map, key, list)
    }
  }
  for (const [key, list] of Object.entries(incoming)) {
    addGroupProviders(map, key, list)
  }
  return map.size > 0 ? Object.fromEntries(map) : undefined
}

/** Semantic comparison excluding volatile timestamps so identical 5s polls do not amplify global SSE traffic. */
function statusContentEqual(a: MagpieStatusDoc, b: MagpieStatusDoc): boolean {
  const stripTimestamps = (doc: MagpieStatusDoc) => ({
    gatewayUrl: doc.gatewayUrl,
    configuredRoot: doc.configuredRoot,
    local: doc.local,
    reachable: doc.reachable,
    modelCount: doc.modelCount,
    groupCount: doc.groupCount,
    lastError: doc.lastError,
    quotasError: doc.quotasError,
    summaryText: doc.summaryText,
    modelOwners: doc.modelOwners,
    groupProviders: doc.groupProviders,
    quotas: doc.quotas,
    routes: doc.routes,
    diagnostics: doc.diagnostics,
  })
  return JSON.stringify(stripTimestamps(a)) === JSON.stringify(stripTimestamps(b))
}

const execFileAsync = promisify(execFile)

/** The local magpie CLI goes through execFile (PATH resolution, no hidden injection).
 * Failures return { ok:false, error }; timeout 10s; error text redacted and length-capped.
 */
function runMagpieCli(
  args: readonly string[],
  options?: { signal?: AbortSignal },
): Promise<{ ok: boolean; stdout?: string; error?: string }> {
  return execFileAsync('magpie', [...args], {
    signal: options?.signal,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    encoding: 'utf8',
  })
    .then(({ stdout }) => ({ ok: true, stdout }))
    .catch((error: unknown) => ({
      ok: false,
      error: sanitizeErrorText(error instanceof Error ? error : new Error(String(error))),
    }))
}

export function createMagpiePlugin(): PluginDefinition {
  const fetchImpl: typeof fetch = fetch

  return {
    id: MAGPIE_PLUGIN_ID,
    name: { en: 'Magpie Gateway', 'zh-CN': 'Magpie 网关' },
    description: {
      en: 'Magpie model gateway integration: dynamic model catalog, quotas, and routing groups, with silent refresh and a status panel.',
      'zh-CN': 'Magpie 模型网关集成：动态模型目录、配额与路由组，静默刷新与状态面板。',
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
          default: 'http://127.0.0.1:3425',
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
          publishCatalogStatus(change.gateway, change.ok, change.ok ? undefined : change.error)
        },
      })
      ctx.provider(handle.provider)

      const status = ctx.doc<MagpieStatusDoc>(MAGPIE_STATUS_DOC, emptyStatus(DEFAULT_MAGPIE_ROOT), {
        public: true,
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

      const modelsForSnapshot = (snapshot: MagpieGatewayRef): PiMagpieModel[] =>
        handle.models().filter((model) => model.baseUrl.startsWith(snapshot.root))

      /** Pre-publish guard: write into the doc only while the snapshot is still the effective config. */
      const writeStatus = (
        snapshot: MagpieGatewayRef,
        patch: Partial<MagpieStatusDoc>,
        options?: { clearLastError?: boolean; clearQuotasError?: boolean; skipIfUnchanged?: boolean },
      ): void => {
        if (stopping) return
        const currentGateway = gateway()
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
       * Read quotas + routing and update the doc (executed on the snapshot; kept=true asks no vendor).
       * Honesty: quota / trace read failures are not swallowed -- the reason goes into diagnostics
       * (for background/startup sync, clears old quotas and records unavailability; for preserveQuotasOnError
       * foreground polling, preserves the last known snapshot alongside quotasError so the status bar
       * discloses staleness rather than vanishing).
       */
      const refreshSidecar = async (
        snapshot: MagpieGatewayRef,
        kept: boolean,
        options?: { preserveQuotasOnError?: boolean; skipIfUnchanged?: boolean },
      ): Promise<void> => {
        if (stopping) return
        const { controller, done } = beginRequest()
        try {
          const prev = status.get()
          const sameRoot = prev.gatewayUrl === snapshot.root
          const diagnostics: string[] = []
          let quotas: MagpieStatusDoc['quotas'] = []
          let routes: MagpieStatusDoc['routes'] = []
          let quotaOk = false
          let quotaErr: string | undefined
          try {
            const entries = await fetchQuotas(snapshot.root, snapshot.token, controller.signal, fetchImpl, { kept })
            quotas = quotaRows(entries).map((row) => ({ ...row }))
            quotaOk = true
          } catch (error) {
            quotaErr = sanitizeErrorText(error)
            quotas = options?.preserveQuotasOnError && sameRoot ? prev.quotas : []
            diagnostics.push(`quotas unavailable: ${quotaErr}`)
          }
          if (stopping || controller.signal.aborted) return
          const trace = await fetchTrace(snapshot.root, snapshot.token, controller.signal, fetchImpl)
          if (stopping || controller.signal.aborted) return
          let traceGroupProviders: Record<string, string[]> = {}
          if ('routes' in trace) {
            routes = traceRouteRows(trace.routes)
            traceGroupProviders = collectGroupProvidersFromTrace(trace.routes)
          } else {
            routes = []
            diagnostics.push(`routing trace unavailable: ${sanitizeErrorText(trace.unavailable)}`)
          }
          const now = Date.now()
          const mergedGroupProviders = mergeGroupProviders(sameRoot ? prev.groupProviders : undefined, traceGroupProviders)
          writeStatus(
            snapshot,
            {
              quotas,
              routes,
              groupCount: routes.length,
              diagnostics,
              modelOwners: modelOwnersOf(modelsForSnapshot(snapshot)),
              ...(mergedGroupProviders !== undefined ? { groupProviders: mergedGroupProviders } : {}),
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
        options?: { skipIfUnchanged?: boolean },
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
              ...(error !== undefined ? { lastError: sanitizeErrorText(error) } : {}),
            },
            { skipIfUnchanged: options?.skipIfUnchanged },
          )
        }
      }

      // ---- service lifecycle ------------------------------------------------
      ctx.service({
        id: 'magpie-gateway',
        async start() {
          stopping = false
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
          // Non-blocking background refresh: failures only update reachable:false / lastError, never
          // blocking enablement or kernel startup (provider.refreshModels itself throws -- that is the
          // explicit signal for the generic catalog refresh; here we take the errors map from
          // ctx.host.refreshModels and do not reject).
          void (async () => {
            try {
              if (stopping || controller.signal.aborted) return
              const snapshotInner = gateway()
              const result = await ctx.host.refreshModels({ providers: [MAGPIE_PROVIDER_ID], allowNetwork: true, force: true })
              if (stopping || controller.signal.aborted) return
              const error = result.errors['magpie']
              if (error !== undefined) {
                publishCatalogStatus(snapshotInner, false, error)
                return
              }
              publishCatalogStatus(snapshotInner, true)
              if (stopping || controller.signal.aborted) return
              await refreshSidecar(snapshotInner, true)
            } catch (error) {
              if (stopping || controller.signal.aborted) return
              // Composition-layer port exception (not a gateway diagnostic): record honestly, do not block startup
              publishCatalogStatus(gateway(), false, error)
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

      // ---- turn_settled: background silent quota/routing refresh (never blocking turn settlement) ------------
      // Only conversations using magpie models matter: other conversations (other Providers) settling
      // trigger no gateway reads (the conversation's current model is taken live from payload.conversation; no guessing).
      ctx.hook.onTurnSettled((payload: TurnSettledPayload) => {
        if (stopping) return
        const model = payload.conversation.model
        if (!model.startsWith(`${MAGPIE_PROVIDER_ID}/`)) return
        const snapshot = gateway()
        // No await: never blocks turn_settled; failures only enter diagnostics, retried at the next settled
        void refreshSidecar(snapshot, true).catch((error) => {
          if (stopping) return
          ctx.host.emitEvent('notification', {
            level: 'warning', title: 'Magpie status read failed', body: sanitizeErrorText(error),
          })
        })
      })

      // ---- Action bus (HTTP / helmx magpie <action> / run_action / Workflow) ----
      ctx.action({
        id: 'status',
        description: 'Magpie gateway status snapshot (reachability, model count, quotas, routing traces)',
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
        description: 'Force-refresh the Magpie model catalog and quota/routing state (failures error explicitly)',
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
              const message = sanitizeErrorText(error)
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
            const candidate = toPiModels(entries, snapshot.root)
            const currentModels = modelsForSnapshot(snapshot)
            const changed = !handle.synced() || catalogFingerprint(candidate) !== catalogFingerprint(currentModels)
            if (changed) {
              const result = await ctx.host.refreshModels({ providers: [MAGPIE_PROVIDER_ID], allowNetwork: true, force: true })
              const error = result.errors['magpie']
              publishCatalogStatus(snapshot, error === undefined, error)
              if (error !== undefined) {
                throw new HelmxError(
                  'magpie_gateway_unreachable',
                  `Magpie gateway ${snapshot.root} refresh failed: ${sanitizeErrorText(error)}`,
                  502,
                  { gatewayUrl: snapshot.root, configuredRoot: snapshot.configuredRoot },
                )
              }
            } else {
              publishCatalogStatus(snapshot, true, undefined, { skipIfUnchanged: true })
            }
            await refreshSidecar(snapshot, false, { preserveQuotasOnError: true, skipIfUnchanged: true })
            const doc = status.get()
            return { refreshed: true, modelCount: doc.modelCount, reachable: true }
          }

          const result = await ctx.host.refreshModels({ providers: [MAGPIE_PROVIDER_ID], allowNetwork: true, force: true })
          const error = result.errors['magpie']
          publishCatalogStatus(snapshot, error === undefined, error)
          if (error !== undefined) {
            throw new HelmxError(
              'magpie_gateway_unreachable',
              `Magpie gateway ${snapshot.root} refresh failed: ${sanitizeErrorText(error)}`,
              502,
              { gatewayUrl: snapshot.root, configuredRoot: snapshot.configuredRoot },
            )
          }
          await refreshSidecar(snapshot, false)
          const doc = status.get()
          return { refreshed: true, modelCount: doc.modelCount, reachable: true }
        },
      })

      ctx.action({
        id: 'quota',
        description: 'Query Magpie quotas live (GET /v1/magpie/quotas)',
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
            const allRows = quotaRows(entries).map((row) => ({ ...row }))
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
              const groupProviders = status.get().groupProviders?.[bareModel] ?? []
              const matched = new Set<string>(groupProviders)
              const primaryOwner = owners[bareModel]
              if (primaryOwner) matched.add(primaryOwner)
              if (matched.size > 0) rows = rows.filter((row) => matched.has(row.provider))
            }
            return {
              quotas: rows,
              local: snapshot.local,
              ...(snapshot.local ? {} : { note: 'non-local gateway: only quotas reported by that gateway itself are readable' }),
            }
          } catch (error) {
            const message = sanitizeErrorText(error)
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

      ctx.action({
        id: 'groups',
        description: 'Routing group list with recent hits (local reads the magpie CLI + gateway trace; remote uses gateway trace only)',
        idempotent: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: GROUPS_OUTPUT_SCHEMA,
        handler: async () => {
          const snapshot = gateway()
          const { controller, done } = beginRequest()
          try {
            // Data-source isolation: the CLI describes only the local default instance; when another
            // loopback port is explicitly configured, the CLI cannot be proven to point at the same
            // instance (MAGPIE_GW_URL/MAGPIE_ADDR may point elsewhere) -- use only the chosen root's trace; never read other local instances.
            const cliTrusted = snapshot.root === DEFAULT_MAGPIE_ROOT
            let cliGroups: GroupListRow[] | undefined
            let cliError: string | undefined
            if (cliTrusted) {
              const run = await runMagpieCli(['groups'], { signal: controller.signal })
              if (run.ok) cliGroups = parseGroupsList(run.stdout ?? '')
              else cliError = run.error
            }
            const trace = await fetchTrace(snapshot.root, snapshot.token, controller.signal, fetchImpl)
            const traceRoutes = 'routes' in trace ? trace.routes : []
            const traceRows = traceRouteRows(traceRoutes)
            const byKey = new Map(traceRows.map((row) => [row.group, row]))
            const cliKeys = new Set((cliGroups ?? []).map((row) => row.id.replace(/^group\//, '')))
            const groups = [
              ...(cliGroups ?? []).map((row) => {
                const hit = byKey.get(row.id.replace(/^group\//, ''))
                return {
                  id: row.id,
                  ...(row.name !== undefined ? { name: row.name } : {}),
                  ...(row.routing !== undefined ? { routing: row.routing } : {}),
                  ...(row.members.length > 0 ? { members: row.members } : {}),
                  ...(hit ? { lastRoute: hit } : {}),
                  source: 'cli+trace' as const,
                }
              }),
              // Groups present in trace but not listed by the CLI (CLI failure or unlisted auto groups)
              ...traceRows
                .filter((row) => !cliKeys.has(row.group))
                .map((row) => ({
                  id: `group/${row.group}`,
                  ...(row.strategy !== undefined ? { routing: row.strategy } : {}),
                  lastRoute: row,
                  source: 'gateway-trace' as const,
                })),
            ]
            const prev = status.get()
            const fromTrace = collectGroupProvidersFromTrace(traceRoutes)
            const fromCli = collectGroupProvidersFromCli(cliGroups)
            const mergedGroupProviders = mergeGroupProviders(
              mergeGroupProviders(prev.gatewayUrl === snapshot.root ? prev.groupProviders : undefined, fromTrace),
              fromCli,
            )
            writeStatus(snapshot, {
              routes: traceRows,
              groupCount: groups.length,
              ...(mergedGroupProviders !== undefined ? { groupProviders: mergedGroupProviders } : {}),
            })
            const notes: string[] = []
            if (cliGroups === undefined) notes.push('Only routing traces of requests already seen by the selected gateway are shown; full group definitions are currently unavailable.')
            if ('unavailable' in trace) notes.push(`routing trace unavailable: ${sanitizeErrorText(trace.unavailable)}`)
            return {
              groups,
              local: snapshot.local,
              ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
              ...(cliError !== undefined ? { cliError: sanitizeErrorText(cliError) } : {}),
            }
          } finally {
            done()
          }
        },
      })

      ctx.action({
        id: 'group',
        description: 'A single routing group\'s definition and most recent routing decision',
        idempotent: true,
        inputSchema: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 128 } },
          additionalProperties: false,
        },
        outputSchema: GROUP_OUTPUT_SCHEMA,
        handler: async (input: { id: string }) => {
          const snapshot = gateway()
          const { controller, done } = beginRequest()
          try {
            const short = input.id.replace(/^group\//, '')
            // Definition: only the local default instance's CLI can provide it (another loopback port / a
            // remote CLI is another instance; without provable identity, do not ask).
            const cliTrusted = snapshot.root === DEFAULT_MAGPIE_ROOT
            let definition: ReturnType<typeof parseGroupShow> = undefined
            let definitionError: string | undefined
            if (cliTrusted) {
              const run = await runMagpieCli(['group', short], { signal: controller.signal })
              if (run.ok) {
                definition = parseGroupShow(run.stdout ?? '')
                if (definition === undefined) definitionError = 'magpie CLI output cannot be parsed into a group definition'
              } else {
                definitionError = run.error
              }
            }
            const trace = await fetchTrace(snapshot.root, snapshot.token, controller.signal, fetchImpl)
            const lastRoute = 'routes' in trace ? latestGroupRouteIn(trace.routes, short) : undefined
            // Honesty: never fabricate when a remote gateway has no definition source -- the source label says so.
            const source = definition !== undefined ? 'cli+trace' : 'gateway-trace'
            if (definition === undefined && lastRoute === undefined) {
              throw new HelmxError(
                'magpie_group_not_found',
                `routing group ${input.id} has no available information: ${
                  cliTrusted
                    ? definitionError !== undefined
                      ? `CLI failed (${sanitizeErrorText(definitionError)})`
                      : 'neither the CLI nor the gateway trace has this group'
                    : snapshot.local
                      ? 'local gateway on a non-default port provides trace only, and the trace has no record of this group'
                      : 'non-local gateway provides trace only, and the trace has no record of this group'
                }`,
                404,
                { id: input.id, gatewayUrl: snapshot.root, local: snapshot.local },
              )
            }
            return {
              id: input.id,
              ...(definition !== undefined ? { definition } : {}),
              ...(lastRoute !== undefined ? { lastRoute } : {}),
              source,
              ...(snapshot.local && !cliTrusted
                ? { note: 'local gateway on a non-default port: definitions need the local default instance\'s magpie CLI; only the selected gateway\'s trace here' }
                : snapshot.local
                  ? {}
                  : { note: 'non-local gateway: definitions need the local magpie CLI; only the gateway trace here' }),
            }
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
        client: { module: 'index.tsx', export: 'MagpieComposerQuotaStatus' },
      })

      ctx.ui.settingsPanel({
        id: 'magpie-panel',
        label: { en: 'Magpie Gateway', 'zh-CN': 'Magpie 网关' },
        order: 25,
        client: { module: 'index.tsx', export: 'MagpieSettingsPanel' },
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
