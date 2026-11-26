/**
 * builtin:magpie: the Magpie gateway integration plugin (model catalog / quotas).
 */
import { COMPOSER_STATUS_SLOT, HelmxError, type HelmxPluginContext, type JsonSchema, type PluginDefinition, type TurnSettledPayload } from '@helmx/protocol'
import { loadManagedSkillAsset, resolvePluginClientAssets } from './asset-paths.js'
import { errorMessageOf } from './shared-helpers.js'
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

type MagpieProviderHandle = ReturnType<typeof createMagpieProvider>

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

const STATUS_OUTPUT_SCHEMA: JsonSchema = {
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
}

const REFRESH_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['refreshed', 'modelCount', 'reachable'],
  properties: {
    refreshed: { type: 'boolean' },
    modelCount: { type: 'number' },
    reachable: { type: 'boolean' },
    lastError: { type: 'string' },
  },
  additionalProperties: false,
}

const QUOTA_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['quotas', 'local'],
  properties: {
    quotas: { type: 'array', items: { type: 'object', additionalProperties: true } },
    local: { type: 'boolean' },
    note: { type: 'string' },
  },
  additionalProperties: false,
}

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

/** Error-text redaction: strip Bearer-header shapes and pass through SecretStash redactor. */
function sanitizeErrorText(error: unknown, redact?: (text: string) => string): string {
  const stripped = errorMessageOf(error).replace(/Bearer\s+\S+/g, 'Bearer ***')
  return (redact ? redact(stripped) : stripped).slice(0, 300)
}

function directProviderOf(modelId: string): string | undefined {
  const slash = modelId.indexOf('/')
  if (slash <= 0) return undefined
  const prefix = modelId.slice(0, slash).trim()
  if (!prefix || prefix === 'group' || prefix === 'auto') return undefined
  return prefix
}

function modelOwnersOf(models: readonly PiMagpieModel[]): Record<string, string> {
  const owners: Record<string, string> = {}
  for (const model of models) {
    const owner = model.magpieOwnedBy?.trim() || directProviderOf(model.id)
    if (owner) owners[model.id] = owner
  }
  return owners
}

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

const gatewayChangedError = (): HelmxError =>
  new HelmxError('magpie_gateway_changed', '网关配置已变化，刷新结果未采用，请重新刷新目录', 409)

const gatewayUnreachableError = (
  actionLabel: string,
  snapshot: MagpieGatewayRef,
  message: string,
  includeConfiguredRoot = true,
): HelmxError =>
  new HelmxError(
    'magpie_gateway_unreachable',
    `Magpie gateway ${snapshot.root} ${actionLabel} failed: ${message}`,
    502,
    {
      gatewayUrl: snapshot.root,
      ...(includeConfiguredRoot ? { configuredRoot: snapshot.configuredRoot } : {}),
    },
  )

const summaryTextOf = (reachable: boolean, modelCount: number): string =>
  reachable ? `Magpie · ${modelCount} models` : 'Magpie · not connected'

interface MagpieRuntime {
  setStopping(stopping: boolean): void
  beginRequest(): { controller: AbortController; done: () => void }
  abortActiveRequests(): void
  readGateway(): MagpieGatewayRef
  readDoc(): MagpieStatusDoc
  setInitialStatus(snapshot: MagpieGatewayRef): void
  modelsForSnapshot(snapshot: MagpieGatewayRef): PiMagpieModel[]
  isCurrentGateway(snapshot: MagpieGatewayRef): boolean
  publishCatalogStatus(
    snapshot: MagpieGatewayRef,
    reachable: boolean,
    error?: unknown,
    options?: { clearLastError?: boolean; skipIfUnchanged?: boolean },
  ): void
  runCatalogRefresh(snapshot: MagpieGatewayRef, handle: MagpieProviderHandle): Promise<void>
  fetchAndPublishQuotas(
    snapshot: MagpieGatewayRef,
    options: { kept: boolean; throwOnError?: boolean; preserveQuotasOnError?: boolean; skipIfUnchanged?: boolean },
  ): Promise<MagpieStatusDoc['quotas']>
  sanitizeError(error: unknown): string
  handle(): MagpieProviderHandle
}

function createMagpieRuntime(ctx: HelmxPluginContext, fetchImpl: typeof fetch): MagpieRuntime {
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
  const redactText = (text: string): string => ctx.host.redact(text)
  const sanitizeError = (error: unknown): string => sanitizeErrorText(error, redactText)
  const status = ctx.doc<MagpieStatusDoc>(MAGPIE_STATUS_DOC, emptyStatus(DEFAULT_MAGPIE_ROOT), {
    public: true,
    durable: false,
  })

  let stopping = false
  const activeControllers = new Set<AbortController>()

  const isCurrentGateway = (snapshot: MagpieGatewayRef): boolean => {
    try {
      return sameGateway(snapshot, gateway())
    } catch {
      return false
    }
  }

  let handle!: MagpieProviderHandle
  const modelsForSnapshot = (snapshot: MagpieGatewayRef): PiMagpieModel[] =>
    handle.models().filter((model) => servedByRoot(model, snapshot.root))

  const beginRequest = () => {
    const controller = new AbortController()
    activeControllers.add(controller)
    return { controller, done: () => void activeControllers.delete(controller) }
  }

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
    if (options?.clearLastError) delete base.lastError
    if (options?.clearQuotasError) delete base.quotasError
    const next: MagpieStatusDoc = {
      ...base,
      ...patch,
      gatewayUrl: currentGateway.root,
      configuredRoot: currentGateway.configuredRoot,
      local: currentGateway.local,
    }
    if (
      options?.skipIfUnchanged &&
      sameRoot &&
      (prev.quotasRefreshedAt !== undefined || next.quotasRefreshedAt === undefined) &&
      statusContentEqual(prev, next)
    ) {
      return
    }
    status.set(next)
  }

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
      return
    }
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

  handle = createMagpieProvider({
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

  return {
    setStopping: (value) => {
      stopping = value
    },
    beginRequest,
    abortActiveRequests: () => {
      for (const controller of [...activeControllers]) {
        controller.abort(new Error('magpie plugin stopping'))
      }
      activeControllers.clear()
    },
    readGateway: gateway,
    readDoc: () => status.get(),
    setInitialStatus: (snapshot) => {
      const cachedModels = modelsForSnapshot(snapshot)
      status.set({
        ...emptyStatus(snapshot.root),
        configuredRoot: snapshot.configuredRoot,
        local: snapshot.local,
        modelCount: cachedModels.length,
        modelOwners: modelOwnersOf(cachedModels),
        summaryText: summaryTextOf(false, cachedModels.length),
      })
    },
    modelsForSnapshot,
    isCurrentGateway,
    publishCatalogStatus,
    sanitizeError,
    handle: () => handle,

    async runCatalogRefresh(snapshot, targetHandle) {
      const result = await ctx.host.refreshModels({ providers: [MAGPIE_PROVIDER_ID], allowNetwork: true, force: true })
      if (!isCurrentGateway(snapshot)) throw gatewayChangedError()
      const idleError = targetHandle.lastIdleError()
      const error = result.errors['magpie'] ?? (idleError?.root === snapshot.root ? idleError.error : undefined)
      publishCatalogStatus(snapshot, error === undefined, error)
      if (error !== undefined) {
        throw gatewayUnreachableError('refresh', snapshot, sanitizeError(error))
      }
    },

    async fetchAndPublishQuotas(snapshot, options) {
      if (stopping || (!options.throwOnError && !isCurrentGateway(snapshot))) return []
      const { controller, done } = beginRequest()
      try {
        const prev = status.get()
        const sameRoot = prev.gatewayUrl === snapshot.root
        const diagnostics: string[] =
          options.throwOnError && sameRoot
            ? prev.diagnostics.filter((item) => !item.startsWith('quotas unavailable:'))
            : []
        let quotas: MagpieStatusDoc['quotas'] = []
        let quotaOk = false
        let quotaErr: string | undefined
        try {
          const entries = await fetchQuotas(snapshot.root, snapshot.token, controller.signal, fetchImpl, {
            kept: options.kept,
          })
          quotas = quotaRows(entries, Date.now(), redactText).map((row) => ({ ...row }))
          quotaOk = true
        } catch (error) {
          quotaErr = sanitizeError(error)
          if (options.throwOnError) {
            writeStatus(snapshot, { quotasError: quotaErr })
            throw gatewayUnreachableError('quota read', snapshot, quotaErr, false)
          }
          quotas = options.preserveQuotasOnError && sameRoot ? prev.quotas : []
          diagnostics.push(`quotas unavailable: ${quotaErr}`)
        }
        if (stopping || controller.signal.aborted || !isCurrentGateway(snapshot)) return quotas
        const now = Date.now()
        writeStatus(
          snapshot,
          {
            quotas,
            diagnostics,
            modelOwners: modelOwnersOf(modelsForSnapshot(snapshot)),
            ...(quotaOk ? { quotasUpdatedAt: now } : {}),
            ...(quotaOk && !options.kept ? { quotasRefreshedAt: now } : {}),
            ...(quotaErr !== undefined ? { quotasError: quotaErr } : {}),
          },
          { clearQuotasError: quotaOk, skipIfUnchanged: options.skipIfUnchanged },
        )
        return quotas
      } finally {
        done()
      }
    },
  }
}

function registerMagpieActionsAndUi(ctx: HelmxPluginContext, runtime: MagpieRuntime, fetchImpl: typeof fetch): void {
  ctx.action({
    id: 'status',
    description: 'Magpie gateway status snapshot (reachability, model count, quotas)',
    exposeToPrompt: false,
    idempotent: true,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: STATUS_OUTPUT_SCHEMA,
    handler: () => {
      const snapshot = runtime.readGateway()
      const doc = runtime.readDoc()
      const currentModels = runtime.modelsForSnapshot(snapshot)
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
      const snapshot = runtime.readGateway()
      const onlyIfChanged = input?.onlyIfChanged === true
      const handle = runtime.handle()
      if (onlyIfChanged) {
        const { controller, done } = runtime.beginRequest()
        let entries
        try {
          entries = await fetchCatalog(snapshot.root, snapshot.token, controller.signal, fetchImpl)
        } catch (error) {
          if (!runtime.isCurrentGateway(snapshot)) throw gatewayChangedError()
          const message = runtime.sanitizeError(error)
          runtime.publishCatalogStatus(snapshot, false, message, { skipIfUnchanged: true })
          throw gatewayUnreachableError('refresh', snapshot, message)
        } finally {
          done()
        }
        if (!runtime.isCurrentGateway(snapshot)) throw gatewayChangedError()
        const candidate = toPiModels(entries, snapshot.root)
        const currentModels = runtime.modelsForSnapshot(snapshot)
        const changed = !handle.synced(snapshot) || catalogFingerprint(candidate) !== catalogFingerprint(currentModels)
        if (changed) {
          handle.primePrefetchedCatalog(snapshot, entries)
          await runtime.runCatalogRefresh(snapshot, handle)
        } else {
          runtime.publishCatalogStatus(snapshot, true, undefined, { skipIfUnchanged: true })
        }
        if (!runtime.isCurrentGateway(snapshot)) throw gatewayChangedError()
        await runtime.fetchAndPublishQuotas(snapshot, {
          kept: false,
          preserveQuotasOnError: true,
          skipIfUnchanged: true,
        })
      } else {
        await runtime.runCatalogRefresh(snapshot, handle)
        await runtime.fetchAndPublishQuotas(snapshot, { kept: false })
      }
      if (!runtime.isCurrentGateway(snapshot)) throw gatewayChangedError()
      return { refreshed: true, modelCount: runtime.readDoc().modelCount, reachable: true }
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
      const snapshot = runtime.readGateway()
      const allRows = await runtime.fetchAndPublishQuotas(snapshot, { kept: false, throwOnError: true })
      let rows = allRows
      if (input.model !== undefined && input.model !== '') {
        const bareModel = input.model.startsWith(`${MAGPIE_PROVIDER_ID}/`)
          ? input.model.slice(MAGPIE_PROVIDER_ID.length + 1)
          : input.model
        const owners = modelOwnersOf(runtime.modelsForSnapshot(snapshot))
        const primaryOwner = owners[bareModel] ?? directProviderOf(bareModel)
        if (primaryOwner) rows = rows.filter((row) => row.provider === primaryOwner)
      }
      return {
        quotas: rows,
        local: snapshot.local,
        ...(snapshot.local ? {} : { note: 'non-local gateway: only quotas reported by that gateway itself are readable' }),
      }
    },
  })

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
    definePlugin(ctx) {
      ctx.configSchema({
        gatewayUrl: {
          type: 'string',
          label: { en: 'Magpie gateway address', 'zh-CN': 'Magpie 网关地址' },
          description: {
            en: 'Defaults to the local http://127.0.0.1:3425 (you may set http://host:3425)',
            'zh-CN': '缺省为本地 http://127.0.0.1:3425（可设 http://host:3425）',
          },
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

      const runtime = createMagpieRuntime(ctx, fetchImpl)
      let stopping = false

      ctx.service({
        id: 'magpie-gateway',
        async start() {
          stopping = false
          runtime.setStopping(false)
          await ctx.host.skills.ensureSkill(readMagpieSkillAsset())
          if (stopping) return
          const { controller, done } = runtime.beginRequest()
          const snapshot = runtime.readGateway()
          runtime.setInitialStatus(snapshot)
          void (async () => {
            try {
              if (stopping || controller.signal.aborted) return
              const snapshotInner = runtime.readGateway()
              const result = await ctx.host.refreshModels({ providers: [MAGPIE_PROVIDER_ID], allowNetwork: true, force: true })
              if (stopping || controller.signal.aborted || !runtime.isCurrentGateway(snapshotInner)) return
              const error = result.errors['magpie']
              if (error !== undefined) {
                runtime.publishCatalogStatus(snapshotInner, false, error)
                return
              }
              const idleError = runtime.handle().lastIdleError()
              if (idleError !== undefined && idleError.root === snapshotInner.root) {
                runtime.publishCatalogStatus(snapshotInner, false, undefined, { clearLastError: true })
                return
              }
              runtime.publishCatalogStatus(snapshotInner, true)
              if (stopping || controller.signal.aborted || !runtime.isCurrentGateway(snapshotInner)) return
              await runtime.fetchAndPublishQuotas(snapshotInner, { kept: true })
            } catch (error) {
              if (stopping || controller.signal.aborted) return
              try {
                runtime.publishCatalogStatus(runtime.readGateway(), false, error)
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
          runtime.setStopping(true)
          runtime.abortActiveRequests()
        },
      })

      ctx.hook.onTurnSettled((payload: TurnSettledPayload) => {
        if (stopping || !payload.conversation.model.startsWith(`${MAGPIE_PROVIDER_ID}/`)) return
        let snapshot: MagpieGatewayRef
        try {
          snapshot = runtime.readGateway()
        } catch {
          return
        }
        void runtime.fetchAndPublishQuotas(snapshot, { kept: true, skipIfUnchanged: true }).catch((error) => {
          if (stopping) return
          ctx.host.emitEvent('notification', {
            level: 'warning',
            title: 'Magpie status read failed',
            body: runtime.sanitizeError(error),
          })
        })
      })

      registerMagpieActionsAndUi(ctx, runtime, fetchImpl)
    },
  }
}
