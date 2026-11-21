/**
 * builtin:magpie shared contracts: constants, dependency ports, and the public status-doc shape.
 *
 * Design essentials (honesty discipline in practice):
 * - Gateway config snapshot (MagpieGatewayRef): all model-catalog / quota reads execute
 *   against the "root+token frozen at read time", verifying before publishing that the snapshot is
 *   still the effective config; after a config switch, the old gateway's caches or request results
 *   are never published under the new gateway's name;
 * - provider.refreshModels network failures always throw (never swallowed): the generic catalog
 *   refresh (models.refresh / POST /api/models/refresh) must surface magpie failures explicitly in
 *   errors -- never popping a "refresh succeeded" because a provider swallowed the error;
 */

export const MAGPIE_PLUGIN_ID = 'builtin:magpie'

/** The pi-ai Provider id (the model-id prefix namespace). */
export const MAGPIE_PROVIDER_ID = 'magpie'

/** The local Magpie gateway's default root address. */
export const DEFAULT_MAGPIE_ROOT = 'http://127.0.0.1:3425'

/** The local loopback gateway's default token (loopback accepts any token). */
export const DEFAULT_MAGPIE_TOKEN = 'magpie'

/** Magpie's own environment variable: the gateway root address (MAGPIE_ADDR second). */
export const MAGPIE_ROOT_ENV = 'MAGPIE_GW_URL'
export const MAGPIE_ADDR_ENV = 'MAGPIE_ADDR'

/** Default foreground auto-refresh interval in seconds (0 disables auto-refresh). */
export const DEFAULT_MAGPIE_REFRESH_INTERVAL_SEC = 5
export const MAX_MAGPIE_REFRESH_INTERVAL_SEC = 3600

/** Whether quota UI (composer status bar + settings quota table) is shown by default. */
export const DEFAULT_MAGPIE_SHOW_QUOTA_STATUS = true

/** The plugin config (the effective view after merging config.json + credentials.json secret). */
export interface MagpiePluginConfig {
  gatewayUrl?: string
  apiKey?: string
  refreshIntervalSec?: number
  showQuotaStatus?: boolean
}

/** Public (non-secret) subset of plugin config projected to client.tsx via usePluginConfig(). */
export interface MagpiePublicConfig {
  gatewayUrl?: string
  refreshIntervalSec?: number
  showQuotaStatus?: boolean
}

/**
 * The gateway config snapshot frozen at read time. Once taken, this round's data reads and
 * publishing all happen on it; before publishing, confirm the snapshot is still the effective
 */
export interface MagpieGatewayRef {
  /** The normalized gateway root address (no trailing slash, no trailing /v1). */
  root: string
  /** The Bearer token; loopback defaults to 'magpie'. */
  token: string
  /** Whether the user explicitly configured a non-default address (vs. the default loopback fallback). */
  configuredRoot: boolean
  /** Whether the root is the local loopback (decides CLI data-source and quota-read semantics). */
  local: boolean
}

/** Same-snapshot check: a change of either root or token counts as a config switch. */
export function sameGateway(a: MagpieGatewayRef, b: MagpieGatewayRef): boolean {
  return a.root === b.root && a.token === b.token
}

// ---------------------------------------------------------------------------
// Public status doc (shared by composer status slot / settings.panel / the helmx magpie status CLI)
// ---------------------------------------------------------------------------

/** One quota display row (one row per window of each subscription/plan/key). remainingPercent -1 means no percentage reading. */
export interface MagpieStatusQuota {
  provider: string
  account?: string
  remainingPercent: number
  resetText?: string
  resetsAt?: string
  windowLabel?: string
  displayText?: string
  unlimited?: boolean
  pool?: string
  last?: boolean
  lastServedAt?: string
  readAt?: string
  error?: string
}

export interface MagpieStatusDoc {
  gatewayUrl: string
  /** Whether explicitly configured by the user rather than the default loopback address. */
  configuredRoot: boolean
  local: boolean
  /** Whether the most recent network catalog refresh succeeded; when false, modelCount is a cached count, not a live result. */
  reachable: boolean
  modelCount: number
  /** The most recent successful network catalog refresh time; advances only on catalog refresh success. */
  lastRefreshedAt?: number
  /** The most recent failure reason (redacted: no token). */
  lastError?: string
  /** The most recent successful live vendor quota refresh time (GET /v1/magpie/quotas without kept=1). */
  quotasRefreshedAt?: number
  /** The most recent quota snapshot update time (including silent kept=1 sidecar syncs). */
  quotasUpdatedAt?: number
  /** The most recent live quota refresh error (redacted; cleared on the next successful quota read). */
  quotasError?: string
  /** For settings.panel and status summaries to bind and display directly (no Emoji). */
  summaryText: string
  /** Current gateway catalog modelId -> owning Magpie provider id (used by composer status slot to match quotas to the active model). */
  modelOwners: Record<string, string>
  quotas: MagpieStatusQuota[]
  /** Business-side diagnostics (redacted): reasons quotas are unavailable etc.; an empty array means none. */
  diagnostics: string[]
}

/** The public status doc name. */
export const MAGPIE_STATUS_DOC = 'status'

// ---------------------------------------------------------------------------
// ctx.provider contract
// ---------------------------------------------------------------------------

// The real host (@helmx/protocol HelmxPluginContext) ships ctx.provider registration natively;
// ctx.host.refreshModels is the host's generic catalog-refresh port (delivered by kernel-host).
