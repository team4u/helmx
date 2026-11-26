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
import type { ComponentType, MouseEvent, ReactNode } from 'react'
import type {
  AskSpec,
  ComposerController,
  ConversationDetail,
  ConversationLive,
  ConversationSummary,
  HelmxLocale,
  HostModelsSlice,
  HostNodesSlice,
  HostProfilesSlice,
  LocaleTranslator,
  PluginSlotContributionSpec,
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
  /** Extra CSS class merged onto the host root `.msg-ai-body` element. */
  className?: string
  /** Optional click interceptor for non-workspace / non-artifact links (call event.preventDefault() to handle in-app). */
  onLinkClick?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void
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

  // ---- Compute nodes catalog (optional capability; all members reference-stable across renders) ----
  /**
   * One-shot read of the host compute node list slice (`GET /api/nodes` /
   * SSE `snapshot.nodes` + `node.changed`; never exposes node access tokens).
   * `undefined` = the capability is not injected OR initial load has not
   * completed (gated on `nodesLoaded` — a pre-load empty array never leaks out
   * as "no nodes" truth); `[]` = loaded and genuinely empty.
   */
  getNodes?(): HostNodesSlice | undefined
  /** Subscribe to node list revisions (listener fired after getNodes() would return a new reference). */
  subscribeNodes?(listener: () => void): () => void

  // ---- Profile catalog (optional capability; all members reference-stable across renders) ----
  /**
   * One-shot read of the host Profile catalog slice (`GET /api/profiles` /
   * SSE `profile.changed`; excludes `SYSTEM.md` bodies).
   * `undefined` = the capability is not injected OR initial load has not
   * completed (gated on `profilesLoaded` — a pre-load empty array never leaks
   * out as "no profiles" truth); `[]` = loaded and genuinely empty.
   */
  getProfiles?(): HostProfilesSlice | undefined
  /** Subscribe to profile catalog revisions (listener fired after getProfiles() would return a new reference). */
  subscribeProfiles?(listener: () => void): () => void

  // ---- Plugin docs ----
  /** Keyed read of a plugin public doc (`${pluginId}/${docName}`; undefined when absent). */
  getPluginDocValue(docKey: string): unknown
  /** Optional existence check for a cached public doc (distinguishes unloaded from loaded). */
  hasPluginDoc?(docKey: string): boolean
  /** Subscribe to revisions of a single `${pluginId}/${docName}` public doc. */
  subscribePluginDoc(docKey: string, listener: () => void): () => void
  ensurePluginDoc(pluginId: string, docName: string): Promise<unknown>
  /** Explicit manual retry for a failed/stale public doc (clears retry cooldown and refetches immediately). */
  retryPluginDoc?(pluginId: string, docName: string): Promise<unknown>
  getPluginSessionDoc(pluginId: string, docName: string, conversationId: number): Promise<unknown>
  subscribeSessionDoc(key: PluginSessionDocKey, listener: () => void): () => void
  getSessionDocState(key: PluginSessionDocKey): PluginSessionDocState
  /** Explicit manual reconnect for a conversation-scoped session doc subscription. */
  retrySessionDoc?(key: PluginSessionDocKey): void

  // ---- Actions, routes & input ----
  invokePluginAction(pluginId: string, actionId: string, input: unknown, conversationId?: number): Promise<unknown>
  /**
   * Authenticated HTTP fetch scoped to `/api/plugins/<encodeURIComponent(pluginId)>/routes<path>`.
   * The host injects Bearer auth without exposing the raw token to plugins and returns the raw
   * `Response` untouched (preserving binary streams, FormData, SSE bodies, status codes, headers).
   * Optional so minimal/custom hosts can omit it (`ctx.fetchRoute` rejects explicitly when unwired).
   */
  fetchPluginRoute?(pluginId: string, path: string, init?: RequestInit): Promise<Response>
  submitConversationInput(
    conversationId: number,
    input: { text: string; origin: 'human' | 'agent' | 'trigger'; whenBusy?: WhenBusy },
  ): Promise<void>

  // ---- Navigation & notifications ----
  openTarget(target: string, options?: { split?: boolean }): void
  openConversationDrawer(conversationId: number): void
  openArtifactPreview(artifactId: string, conversationId?: number): void
  /** Atomic workbench open + tab selection + optional transient focus params. */
  openWorkbench?(options?: { tab?: string; conversationId?: number; params?: Record<string, unknown> }): void
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
