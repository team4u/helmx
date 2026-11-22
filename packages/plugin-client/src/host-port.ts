/**
 * Host capability port: the single injection surface between the SDK and the host web app.
 *
 * The SDK package never depends on any host implementation (store / API /
 * navigation / markdown rendering / plugin slot rendering); all host
 * capabilities are injected as a reference-stable typed port handle via
 * <PluginClientHostContext.Provider>. The host (@helmx/web) constructs this
 * handle once per store inside HelmxStoreProvider; reactive SDK hooks subscribe
 * to fine-grained domain or per-key slices via `useSyncExternalStore`, so
 * high-frequency streaming frames (`conversationLives` token deltas) never
 * cascade context re-renders into unrelated plugins or SDK UI controls.
 *
 * Types and context only in this file (no component exports, Fast Refresh friendly).
 */
import { createContext, useContext } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type {
  AskSpec,
  ComposerController,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  HelmxLocale,
  HostModelsSlice,
  LocaleTranslator,
  PluginSlotContributionSpec,
  ScreenLocationSnapshot,
  UsePluginsResult,
  WhenBusy,
} from '@helmx/protocol/browser'

/** Conversation-scoped plugin doc subscription tuple (key for the host ref-counted shared SSE stream). */
export interface PluginSessionDocKey {
  pluginId: string
  docName: string
  conversationId: number
}

/** Session doc subscription snapshot (consistent with the host session-docs cache; empty state when unsubscribed). */
export interface PluginSessionDocState {
  value?: unknown
  hasValue: boolean
  deleted: boolean
  error?: string
  connected: boolean
}

/** Sub-slot contribution item (matched + ordered by the host; spec is a protocol type, no host-private types). */
export interface PluginSlotPortItem {
  pluginId: string
  contributionId: string
  spec: PluginSlotContributionSpec
}

/** One conversation's background in-flight entry (same verdict as the host sidebar ring). */
export interface ConversationBackgroundEntry {
  /** A background task is in flight (workbench badge tone = 'accent', or context compaction). */
  active: boolean
  /** Run summary copy (badge footerText / compaction copy, deduplicated; may be empty). */
  summary: string
}

/**
 * Host-standard conversation background snapshot: the per-conversation
 * in-flight index plus an honest unknown gate — while any needed badge doc has
 * not produced its first load, background facts are unknowable and consumers
 * must render "unknown", never "no background work".
 */
export interface ConversationBackgroundSnapshot {
  /** true while needed badge docs are still loading (or the host provides no aggregation): facts are unknown. */
  unknown: boolean
  /** Per-conversation in-flight index (key: conversationId). */
  byConversation: ReadonlyMap<number, ConversationBackgroundEntry>
}

/** SDK MarkdownViewProps (the props contract the host MarkdownView implementation must satisfy). */
export interface MarkdownViewProps {
  text: string
  conversationId?: number
  /** true = streaming body: completed prefix blocks freeze their parsed form for reuse, only the trailing mutable block is re-parsed. */
  streaming?: boolean
  /** true = render single newlines as hard line breaks (user-authored bodies keep their typed line structure). */
  breaks?: boolean
  /** Relative POSIX directory within the workspace (e.g. 'docs') used as base dir when resolving relative links/images in nested Markdown previews. */
  workspaceBaseDir?: string
}

/** SDK CodeBlockViewProps (host syntax-highlighted code block props contract). */
export interface CodeBlockViewProps {
  code: string
  language: string
}

/**
 * Reference-stable capability handle injected by the host.
 *
 * Every member is a stable function or static capability descriptor (never raw
 * per-frame state fields): SDK hooks subscribe to domain or keyed slices via
 * `useSyncExternalStore` so `conversationLives` token frames only notify
 * subscribers of that exact conversation's live stream, while keeping three-state
 * `loaded / auth / error` honesty across all slices.
 */
export interface PluginClientHostPort {
  // ---- Auth & UI preferences (low-frequency domains) ----
  /** One-shot read of authentication readiness (decides whether public docs may issue the first GET). */
  getAuthenticated(): boolean
  /** Subscribe to authentication state transitions. */
  subscribeAuthenticated(listener: () => void): () => void

  /** One-shot read of the active host UI theme. */
  getTheme(): 'light' | 'dark'
  /**
   * One-shot read of the active host UI locale (normalized via HELMX_LOCALES / normalizeLocaleTag).
   * Optional so hosts can adopt it additively: when absent, the SDK falls back to
   * DEFAULT_HELMX_LOCALE ('en').
   */
  getLocale?(): HelmxLocale
  /**
   * Minimal translator for the current locale (resolves LocalizedText display copy).
   * Optional; when absent, derived from getLocale() via createLocaleTranslator.
   */
  getTranslate?(): LocaleTranslator
  /** Subscribe to theme or locale revisions. */
  subscribePrefs(listener: () => void): () => void

  // ---- Server-aligned wall clock (optional capability) ----
  /**
   * One-shot read of the Hub-calibrated wall clock (`Date.now()` adjusted by the clock skew
   * observed from SSE `snapshot` / `resumed` `serverTime`). Optional so isolated hosts and
   * standalone tests can omit it; `useSharedNowMs` silently falls back to `Date.now()`.
   */
  getServerNow?(): number

  // ---- Conversations & keyed per-conversation slices (SSE driven) ----
  /** One-shot read of all conversation summaries (referentially stable when unchanged). */
  getConversations(): ConversationSummary[]
  /** Subscribe to conversation summary list revisions (never fired on conversationLives token frames). */
  subscribeConversations(listener: () => void): () => void

  /** Keyed read of one conversation's summary (undefined until SSE pushes it). */
  getConversationSummary(conversationId: number): ConversationSummary | undefined
  /** Subscribe to revisions of a single conversation's summary. */
  subscribeConversationSummary(conversationId: number, listener: () => void): () => void

  /** Keyed read of one conversation's loaded detail (undefined when unloaded). */
  getConversationDetail(conversationId: number): ConversationDetail | undefined
  /** Subscribe to revisions of a single conversation's detail. */
  subscribeConversationDetail(conversationId: number, listener: () => void): () => void

  /** Keyed read of one conversation's streaming live view (undefined when not streaming). */
  getConversationLive(conversationId: number): ConversationLive | undefined
  /** Subscribe to streaming live frames of a single conversation (other conversations never notify). */
  subscribeConversationLive(conversationId: number, listener: () => void): () => void

  /** Keyed read of one conversation's pending approvals (referentially stable array per revision). */
  getConversationPendingAsks(conversationId: number): AskSpec[]
  /** Subscribe to pending-approval revisions of a single conversation. */
  subscribeConversationPendingAsks(conversationId: number, listener: () => void): () => void

  /** Keyed read of a host load error (e.g. `conversation:<id>`; undefined when none). */
  getLoadError(key: string): string | undefined
  /** Subscribe to revisions of a single load-error key. */
  subscribeLoadError(key: string, listener: () => void): () => void

  // ---- Plugin registry & Screen contributions ----
  /**
   * One-shot read of the host plugin summaries and enabled Screen contributions
   * (returns the same UsePluginsResult reference while neither changes; disabled
   * plugin contributions are removed immediately).
   */
  getPluginsSnapshot(): UsePluginsResult
  /** Subscribe to plugin registry / UI contribution revisions. */
  subscribePlugins(listener: () => void): () => void

  // ---- Conversation background in-flight activity (optional centralized derived slice) ----
  /**
   * One-shot read of the host-standard conversation background in-flight snapshot
   * (`{ unknown, byConversation }`: workbench panel per-conversation badges with
   * tone = 'accent' plus context compaction). Absent method or `unknown: true`
   * while needed badge docs are still loading = background facts are unknown,
   * never fabricated as "no work".
   */
  getConversationBackground?(): ConversationBackgroundSnapshot
  /** Subscribe to semantic revisions of the conversation background snapshot. */
  subscribeConversationBackground?(listener: () => void): () => void

  // ---- Model catalog (optional capability; all members reference-stable across renders) ----
  /**
   * One-shot read of the host model catalog slice (normalized entries plus
   * the global default chain). `undefined` = the capability is not injected
   * OR the catalog has not finished its first load (gated on assetsLoaded — a
   * pre-load empty array never leaks out as "no models" truth); a slice with
   * `models: []` = loaded and genuinely empty.
   */
  getModels?(): HostModelsSlice | undefined
  /** Subscribe to catalog revisions (listener fired after getModels() would return a new reference). */
  subscribeModels?(listener: () => void): () => void
  /**
   * Dynamic model catalog refresh. An absent method means the host offers no
   * refresh capability — UI hides the entry and never fakes a successful
   * refresh; per-provider refresh errors surface verbatim in `errors`.
   */
  refreshModels?(): Promise<{ errors?: Record<string, string> }>

  // ---- Navigation location (optional capability; URL hash single source of truth) ----
  /**
   * One-shot read of the host navigation location (primary/split pane as
   * structured screen facts — undefined members are truth, not loading state).
   * `undefined` = the host has not wired the capability. Reactive reads go
   * through the useScreenLocation shared hook; writing params stays with
   * ScreenProps.setParams of the owning screen.
   */
  getScreenLocation?(): ScreenLocationSnapshot | undefined
  /** Subscribe to location revisions (listener fired after getScreenLocation() would return a new reference). */
  subscribeScreenLocation?(listener: () => void): () => void

  // ---- Plugin docs ----
  /** Keyed read of a plugin public doc (`${pluginId}/${docName}`; undefined when absent). */
  getPluginDocValue(docKey: string): unknown
  /** Subscribe to revisions of a single `${pluginId}/${docName}` public doc. */
  subscribePluginDoc(docKey: string, listener: () => void): () => void
  ensurePluginDoc(pluginId: string, docName: string): Promise<unknown>
  getPluginSessionDoc(pluginId: string, docName: string, conversationId: number): Promise<unknown>
  subscribeSessionDoc(key: PluginSessionDocKey, listener: () => void): () => void
  getSessionDocState(key: PluginSessionDocKey): PluginSessionDocState

  // ---- Actions & input ----
  invokePluginAction(pluginId: string, actionId: string, input: unknown, conversationId?: number): Promise<unknown>
  submitConversationInput(
    conversationId: number,
    input: { text: string; origin: 'human' | 'agent' | 'trigger'; whenBusy?: WhenBusy },
  ): Promise<void>

  // ---- Navigation & notifications ----
  openTarget(target: string, options?: { split?: boolean }): void
  openConversationDrawer(conversationId: number): void
  openArtifactPreview(artifactId: string, conversationId?: number): void
  setWorkbenchOpen(open: boolean): void
  setWorkbenchTab(tab: string): void
  notify(message: string, tone: 'info' | 'warning' | 'error', conversationId?: number): void

  // ---- Detail loading ----
  loadConversationDetail(conversationId: number, force?: boolean): Promise<ConversationDetail | undefined> | void

  // ---- Sub-slots (matching/ordering done by the host; cycle guard and depth limit by the SDK component) ----
  slots: {
    /** Contribution items matching the current conversation scope (priority descending, order ascending, stable sort). */
    collectItems(qualifiedName: string, conversationId: number | undefined): ReadonlyArray<PluginSlotPortItem>
    /** Render a single contribution item (host PluginUiView: the sub context's pluginId is the contributing plugin). */
    renderItem(
      item: PluginSlotPortItem,
      options: {
        slotProps?: Record<string, unknown>
        conversationId?: number
        composer?: ComposerController
        label: string
      },
    ): ReactNode
  }

  // ---- Markdown rendering (host standard implementation: artifact links, code block extensions, streaming chunks) ----
  markdown: {
    view: ComponentType<MarkdownViewProps>
    codeBlock: ComponentType<CodeBlockViewProps>
  }
}

export const PluginClientHostContext = createContext<PluginClientHostPort | null>(null)

/** Read the host port; explicitly errors outside the host Provider (never silently returns a degraded implementation). */
export function usePluginClientHost(): PluginClientHostPort {
  const port = useContext(PluginClientHostContext)
  if (port === null) {
    throw new Error('usePluginClientHost must be called inside <PluginClientHostContext.Provider> (injected by the host HelmxStoreProvider)')
  }
  return port
}

/**
 * Capability-handle slice of the host port (Pick keeps it automatically in sync
 * with the main interface — no second signature to maintain). Mounted alongside
 * the stable host port so handle-only consumers (ModelPickerControl,
 * useHostModels, useScreenLocation) can also mount in isolated handle-only
 * environments while adopting capabilities additively.
 */
export type PluginClientHostHandles = Pick<
  PluginClientHostPort,
  'getModels' | 'subscribeModels' | 'refreshModels' | 'getScreenLocation' | 'subscribeScreenLocation'
>

/** Stable host capability handles context (null outside the host Provider, same honesty rule as the main port). */
export const PluginClientHostHandlesContext = createContext<PluginClientHostHandles | null>(null)
