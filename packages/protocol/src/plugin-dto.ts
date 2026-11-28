/**
 * Cross-end serializable plugin DTOs and constants (zero `node:*`, zero
 * `@earendil-works/pi-*` dependencies).
 *
 * This file is exported jointly by `@helmx/protocol` and `@helmx/protocol/browser`:
 * the web frontend, browser SDK, CLI and kernel can all safely consume it via
 * `@helmx/protocol/browser` without pulling in any Node stream or backend
 * runtime dependency.
 */

import type { WhenBusy } from './conversation.js'
import type { AgentNamespacedMeta } from './meta.js'
import type { LocalizedText } from './locale.js'
import type {
  HookName,
  PluginConfigFieldSchema,
  PluginDiagnosticError,
  PluginStatus,
} from './plugin-contract-types.js'
import type { PluginManifestProjection } from './plugin-manifest.js'

export * from './plugin-contract-types.js'

export type MaybePromise<T> = T | Promise<T>

// ---------------------------------------------------------------------------
// External trigger envelope
// ---------------------------------------------------------------------------

/**
 * External inbound event envelope (cron / webhook, delivered after defang
 * anti-escape wrapping).
 */
export interface ExternalTriggerEnvelope {
  id: string
  /** Event source identifier, e.g. 'cron', 'webhook:<id>'. */
  source: string
  /** Wrapped (defanged) payload text. */
  text: string
  /** Optional targeted conversation; the default target is resolved by the kernel from the current assistant entry. */
  targetConversationId?: number
  /** Optional busy policy when submitting into the target conversation (defaults to 'steer' when omitted). */
  whenBusy?: WhenBusy
  metadata?: Record<string, unknown>
  createdAt: number
}

// ---------------------------------------------------------------------------
// Sub-agent execution metadata and gate results (agent-exec shared cross-end)
// ---------------------------------------------------------------------------

/**
 * Actual execution environment metadata of a sub-agent (returned via onResolved).
 * The native path returns at least conversationId; external runtimes (e.g.
 * herdr) return at least executionId. Worktree / control references and other
 * business extensions travel via the meta namespace (see meta.ts): the kernel
 * only validates the envelope and never interprets any namespace internals
 * (shapes are validated at the owning plugin's boundary).
 */
export interface AgentExecutionInfo {
  /** Actual execution node, reported by the executor; never guessed from the parent conversation. */
  nodeId?: string
  conversationId?: number
  /** Identifier of the execution inside the external runtime (e.g. Herdr pane/tab ID). */
  executionId?: string
  /** Absolute path of the actually effective working directory. */
  effectiveCwd?: string
  /**
   * Namespaced business extensions (mechanism side): isomorphic to
   * AgentSpawnRequest.meta (e.g. managed worktree descriptors or external
   * control action references — shapes defined and validated by the owning
   * plugin). The kernel envelope only guarantees JSON-safety and boundedness;
   * it passes them through without interpretation.
   */
  meta?: AgentNamespacedMeta
}

/** gate command execution result; output is the command output shown to the user on failure. */
export interface AgentGateResult {
  ok: boolean
  output: string
  /** Command exit code; null when timed out, force-killed (no exit code available) or unable to execute. */
  exitCode?: number | null
  /** true when the command timed out and was force-terminated (process group SIGTERM -> SIGKILL). */
  timedOut?: boolean
}

// ---------------------------------------------------------------------------
// Doc / Config / Guard DTO
// ---------------------------------------------------------------------------

/** Registration options for `ctx.doc` and `ctx.sessionDoc`. */
export interface PluginDocOptions {
  /** When true, projects into public snapshots and SSE doc update events; defaults to false (private). */
  public?: boolean
  /**
   * When false, stores values only in process memory without SQLite persistence (still subject
   * to the 2 MiB size cap and public SSE publishing; released on plugin disable, conversation
   * deletion, or restart); defaults to true.
   */
  durable?: boolean
}

/** Session docs never enter the global snapshot; they are published only via the dedicated doc subscription stream. delete carries the initial value. */
export interface PublicPluginSessionDoc {
  pluginId: string
  name: string
  conversationId: number
  value: unknown
  deleted?: boolean
}

/** Plugin public doc snapshot (cross-end readable; published after per-value JSON validation/redaction, not public by default). */
export interface PublicPluginDoc {
  pluginId: string
  name: string
  value: unknown
}

/** Static persistent resource occupancy items declared by plugin services (used by the pre-disable inUse check). */
export interface PluginInUseItem {
  /** Occupied resource category identifier (e.g. 'cron_job', 'webhook_endpoint', 'profile_runtime', 'profile_model'). */
  kind: string
  /** Resource unique identifier. */
  id: string
  /** Human-readable occupancy description. */
  label: string
}

/** Plugin config field source: configured (explicit persisted user override), default (falls back to schema.default), unset (not configured and no default). */
export type PluginConfigFieldSource = 'configured' | 'default' | 'unset'

/** GET /api/plugins/:id/config response body. */
export interface PluginConfigResponse {
  values: Record<string, unknown>
  schema: Record<string, PluginConfigFieldSchema>
  sources?: Record<string, PluginConfigFieldSource>
}

/**
 * Automation change guard expectations (guarded mutation): the caller carries
 * the facts at authorization time (probe ownedBy / stateChangeSeq); the kernel
 * re-checks synchronously inside the conversation's serial domain before the
 * first irreversible action (SDK abort/submit/reset/compact call); a failed
 * re-check throws 409/404 and never executes the mutation (kernel execution-layer
 * enforcement of the Watchdog human-owned red line).
 */
export interface GuardedMutationExpectation {
  /**
   * Ownership at authorization time (probe fact). The kernel requires current
   * ownership to belong to the automation domain ('helmx'; 'human' is always rejected).
   */
  expectedOwnership?: 'helmx'
  /** Authoritative watermark at authorization time (stateChangeSeq); when provided, the current value must be equal (CAS). */
  expectedStateSeq?: number
}

// ---------------------------------------------------------------------------
// Serializable manifests (GET /api/plugins and GET /api/actions)
// ---------------------------------------------------------------------------

export interface PluginSummary {
  id: string
  /**
   * Display name (display copy): a plain string or a per-locale map, resolved
   * by the consuming UI via its active locale (CLI human output resolves with
   * 'en'; --json keeps the raw localized shape). Passed through as declared.
   */
  name: LocalizedText
  /**
   * Short plugin description (display copy, same resolution rules as `name`).
   * From the plugin definition, displayed directly by the frontend, no ID
   * special-casing.
   */
  description?: LocalizedText
  /**
   * Linear vector icon name of the plugin (maps to a HelmxIcon name, optional).
   * The frontend falls back to the default icon placeholder
   * (DEFAULT_PLUGIN_ICON: 'puzzle') when absent.
   */
  icon?: string
  version?: string
  /** Other plugin IDs this plugin depends on (deduplicated at the registration boundary; all must be enabled before enabling). */
  dependencies?: string[]
  enabled: boolean
  /** Current plugin status: active | disabled | failed. */
  status?: PluginStatus
  /** Structured diagnostics carried when status === 'failed'. */
  error?: PluginDiagnosticError
  hooks: HookName[]
  actions: string[]
  tools: string[]
  /**
   * Managed package install metadata (additive, optional): exists only when
   * the plugin came from the package installer (plugins install/update);
   * absent for hand-dropped directories. Built-in plugins (builtin:*) never
   * carry it.
   */
  managed?: PluginManagedMeta
  /**
   * Client module content hash map (`moduleRef -> contentHash`, where `moduleRef`
   * matches `ClientComponentRef.module`, e.g. `'index.tsx'`). Optional; carried
   * for enabled plugins with compiled client UI modules to enable O(1) memory
   * cache hits, per-plugin diff invalidation, and `client.mjs?hash=...` immutable caching.
   */
  clientHashes?: Record<string, string>
  /**
   * Non-secret effective configuration projected from `configSchema` (excludes
   * all `secret: true` fields). Read in browser UIs via `usePluginConfig()`.
   */
  publicConfig?: Record<string, unknown>
}

/** Minimal slice of `PluginSummary` required to judge whether a plugin is actively running. */
export type PluginActivityLike = Pick<PluginSummary, 'enabled' | 'status' | 'error'>

/**
 * Unified active-plugin predicate across kernel, plugins, and browser UI:
 * active iff `enabled === true`, `status` is omitted or `'active'`, and no failure `error` is present.
 * Notably, `enabled: true` with `status: 'failed'` (e.g. after a dependency is force-disabled) is NOT active.
 */
export function isPluginSummaryActive(plugin: PluginActivityLike): boolean {
  return plugin.enabled && (plugin.status === undefined || plugin.status === 'active') && plugin.error === undefined
}

/** Managed plugin package metadata (shape of PluginSummary.managed; additive optional field). */
export interface PluginManagedMeta {
  /** Install source (normalized shape; includes the raw source string for echo). */
  source: PluginPackageSource
  /** Install record ID (identical to PluginPackageRecord.id). */
  installId: string
  /** Installed version (from the package manifest version; empty string when unreadable). */
  installedVersion: string
  /** Completion time of the most recent install/update (epoch milliseconds). */
  installedAt: number
}

/** Text content block inside a tool result envelope (`output`). */
export interface PluginToolTextBlock {
  type: 'text'
  text: string
}

/**
 * Post-tool round control directives passed through `PluginToolResultEnvelope.control`
 * (excludes SDK-internal `addTools`).
 */
export interface PluginToolControl {
  handoff?: string
  terminate?: boolean
}

/**
 * Explicit tool result envelope separating the outbound tool channels:
 * - `output`: text delivered to the model (32 KiB spill boundary);
 * - `structuredOutput`: machine-readable value for programmatic/nested callers (validated against
 *   `structuredOutputSchema`; never auto-mirrored into persisted `details`);
 * - `presentationMeta`: bounded, redacted plain JSON object persisted to `pi.tool-result.model[0].details`
 *   for UI/timeline replay (validated against `presentationMetaSchema` + 64 KiB / depth 12 / 2000 nodes;
 *   never enters model prompt or context usage);
 * - `isError`: explicit error flag;
 * - `control`: optional post-tool round control directives (`handoff`, `terminate`; disallowed with `isError: true`).
 */
export interface PluginToolResultEnvelope {
  output?: string | PluginToolTextBlock[]
  structuredOutput?: unknown
  presentationMeta?: Record<string, unknown>
  isError?: boolean
  control?: PluginToolControl
}

// ---------------------------------------------------------------------------
// External plugin ecosystem DX loop (doctor / reload / rescan;
// helmx plugins init is a CLI-local command)
// ---------------------------------------------------------------------------

/** Single doctor check result. */
export interface PluginDoctorCheck {
  /** Check item identifier: manifest / backend / register / client. */
  id: string
  /** Human-readable check title. */
  label: string
  /** Omitted when ok; structured diagnostics on failure (code / message / details). */
  error?: { code: string; message: string; details?: unknown }
}

/** Static self-check report of external plugin sources (POST /api/plugins/doctor). */
export interface PluginDoctorReport {
  /** Absolute path of the inspected directory (given by the requester or resolved via plugin id). */
  dir: string
  /** Request target: the resolved source directory in id mode; identical to dir in path/dir mode. */
  requestedId?: string
  /** Plugin id derived from the real manifest/entry of the directory (absent when the definition export is not reached). */
  pluginId?: string
  ok: boolean
  /** Per-check results (in execution order): manifest -> backend -> register -> client. */
  checks: PluginDoctorCheck[]
  /** Capability summary obtained after doctor loads the real registration (present when register passes). */
  summary?: PluginSummary
  /**
   * View ids declared via ctx.ui.screen during the real registration phase
   * that passed raw registration validation (present when register passes;
   * additive optional field). Lets callers (CLI/tooling/micro-app workflows)
   * verify that a screen-bearing plugin declares at least one Screen before
   * install. Records only real calls — no static scanning or approximate
   * derivation.
   */
  screens?: string[]
  /**
   * Read-only, stably sorted capability manifest captured from the real
   * registration dry-run before teardown (present when register passes).
   */
  manifest?: PluginManifestProjection
}

/** Controlled hot-reload result (POST /api/plugins/:id/reload). */
export interface PluginReloadResult {
  pluginId: string
  /** Enabled state before the reload (the reload preserves it). */
  wasEnabled: boolean
  /** Module generation number used by this reload (for diagnostics, monotonically increasing). */
  generation: number
  /** Current manifest of the plugin after a successful reload. */
  summary: PluginSummary
}

/** External plugin directory rescan result (POST /api/plugins/rescan). */
export interface PluginRescanResult {
  /** External plugin ids successfully registered by this scan (disabled by default). */
  registered: string[]
  /** Number of skipped pure-data directories / already-registered plugin directories (for diagnostics). */
  skipped: number
  /** Current manifests of all plugins. */
  plugins: PluginSummary[]
}

// ---------------------------------------------------------------------------
// External plugin package management (source grammar / install records /
// install / update / remove). Serializable types only; the concrete parser
// (source string -> normalized shape) and install execution live in the
// kernel; protocol carries no runtime.
// ---------------------------------------------------------------------------

/** npm registry source: `npm:<spec>` (spec is any valid npm dependency specifier). */
export interface PluginSourceNpm {
  kind: 'npm'
  /** Raw source string (canonical echo, e.g. `npm:helmx-plugin-foo@^1.2.0`). */
  raw: string
  /** npm dependency specifier (part after the `npm:` prefix, e.g. `helmx-plugin-foo@^1.2.0`). */
  spec: string
}

/** Git source: `git:<repo>@<ref>` or an HTTPS Git URL (`https://...git[#<ref>]`). */
export interface PluginSourceGit {
  kind: 'git'
  /** Raw source string (canonical echo). */
  raw: string
  /** Git repository address (e.g. `https://github.com/user/helmx-plugin-foo.git` or the repo part of `git@host:path`). */
  repo: string
  /** Checked-out Git ref (branch/tag/commit; defaults to the installer's choice, usually the repository default branch). */
  ref?: string
  /** Sub-directory inside the repository (monorepo layout; defaults to the repository root). */
  subdirectory?: string
}

/** Local path source: absolute path, or a path relative to the Hub cwd / plugin root. */
export interface PluginSourceLocal {
  kind: 'local'
  /** Raw source string (canonical echo, user spelling preserved). */
  raw: string
  /** Resolved absolute path (normalized by the installer; absolute on Windows too). */
  path: string
}

/** Normalized plugin package source (discriminated union, kind discriminates). */
export type PluginPackageSource = PluginSourceNpm | PluginSourceGit | PluginSourceLocal

/** Managed plugin package install record (persisted in the installer's private storage; not part of global first-frame/SSE payloads). */
export interface PluginPackageRecord {
  /** Install record ID (idempotent stable identifier; repeated installs of the same plugin reuse the original ID and update the record). */
  id: string
  /** Target plugin id (declared by the package manifest, e.g. `my-plugin`). */
  pluginId: string
  /** Normalized install source. */
  source: PluginPackageSource
  /** Absolute on-disk install path (<dataDir>/installed-plugins/<pluginId>). */
  installPath: string
  /** Version declared by the package manifest; empty string when unreadable (never fabricated). */
  version: string
  /** First install completion time (epoch milliseconds). */
  installedAt: number
  /** Most recent update completion time (epoch milliseconds); identical to installedAt when never updated. */
  updatedAt: number
  /** Enabled state is managed by the plugin system itself, not recorded here (avoiding dual sources). */
}

/** Install result (POST /api/plugins/install). */
export interface PluginInstallResult {
  /** Install record (persisted). */
  record: PluginPackageRecord
  /** Plugin manifest after install (install registers it, disabled by default, same semantics as rescan). */
  summary: PluginSummary
  /**
   * Structured diagnostics when enable: true was requested but enabling failed
   * (additive optional): the install and record are kept (no rollback); the
   * enable failure is surfaced truthfully for the caller to retry enable.
   */
  enableError?: { code: string; message: string }
}

/** Update result (POST /api/plugins/:id/update). */
export interface PluginUpdateResult {
  /** Updated install record (version / updatedAt advanced). */
  record: PluginPackageRecord
  /** Plugin manifest after update-and-reload (or re-registration). */
  summary: PluginSummary
  /** Whether this update actually changed anything (false when the source is unchanged — idempotent semantics reported truthfully). */
  changed: boolean
  /** Version before the update (for diagnostics; empty string when unreadable). */
  previousVersion: string
}

/** Remove result (POST /api/plugins/:id/remove). */
export interface PluginRemoveResult {
  /** Removed plugin id. */
  pluginId: string
  /** Absolute path of the cleaned-up install directory. */
  installPath: string
  /** Whether the plugin was enabled before removal (an enabled plugin must be disabled first; reported as fact). */
  wasEnabled: boolean
  /** Removed install record ID. */
  installId: string
}
