/**
 * Host capability port: the single injection surface between the SDK and the host web app.
 *
 * The SDK package never depends on any host implementation (store / API /
 * navigation / markdown rendering / plugin slot rendering); all host
 * capabilities are injected as a typed port object via
 * <PluginClientHostContext.Provider>. The host (@helmx/web) implements this
 * port with the real store inside HelmxStoreProvider; plugins and the host
 * share the same React / context instance (the compiler virtualizes
 * '@helmx/plugin-client' into the __helmx_shared_plugin_client global
 * namespace).
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
  LocaleTranslator,
  PluginSlotContributionSpec,
  PluginSummary,
  ScreenSpec,
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
 * Normalized per-model view of the host model catalog: the exact shape the
 * host derives from `GET /api/models` (single implementation of the
 * normalization stays in the host; the SDK forwards the same reference, never
 * a copy or a mock). Contract single source of this shape — web may alias its
 * legacy descriptor to it, parallel field sets are forbidden.
 */
export interface HostModelEntry {
  /** Full `'provider/modelId'` reference (the value stored in configs / overrides). */
  id: string
  provider: string
  modelId: string
  /** false = listed in the catalog but currently unusable (render dimmed), not "removed". */
  available: boolean
  /** Host-side model disable-filter annotation (independent from `available`). */
  disabled?: boolean
  /** Display label (defaults to modelId). */
  label?: string
  /** Capability table of thinking levels in display order; carries no profile-effective values. */
  thinkingLevels: readonly string[]
  /** Real known model context window (tokens); omitted when unknown. */
  contextWindow?: number
}

/**
 * The complete capability port injected by the host. Data slices are reactive
 * snapshots (reference changes drive re-renders, at the same cadence as the
 * host store); every method is a real host implementation, no mocks.
 *
 * Streaming-churning slices (conversations / details / lives) live here by
 * legacy design; new low-frequency catalog capabilities must instead expose
 * stable handle members (see Model catalog above) and be read reactively
 * through PluginClientHostHandlesContext, so unrelated host port revisions
 * never re-render their consumers.
 */
export interface PluginClientHostPort {
  /** Passed authentication (decides whether public docs may issue the first GET). */
  authenticated: boolean
  theme: 'light' | 'dark'
  /**
   * Current host UI locale (normalized via HELMX_LOCALES / normalizeLocaleTag).
   * Optional so hosts can adopt it additively: when absent, the plugin client
   * context factory falls back to DEFAULT_HELMX_LOCALE ('en') — a locale always
   * has a well-defined default, so no silent degradation of data fidelity is
   * involved.
   */
  locale?: HelmxLocale
  /**
   * Minimal translator for the current locale (resolves LocalizedText display
   * copy). Optional for the same additive reason: when absent, the context
   * factory derives one from locale via createLocaleTranslator. When both are
   * provided, keep them bound to the same locale.
   */
  translate?: LocaleTranslator

  // ---- Conversations & plugin realtime snapshots (SSE driven) ----
  conversations: ConversationSummary[]
  conversationDetails: Record<number, ConversationDetail>
  conversationLives: Record<number, ConversationLive>
  pendingAsks: AskSpec[]
  loadErrors: Record<string, string>
  plugins: PluginSummary[]
  /** Screen contributions registered by enabled plugins (disabled plugin contributions are removed immediately). */
  screens: Array<{ pluginId: string; spec: ScreenSpec }>
  /**
   * Host-standard conversation background in-flight snapshot (the same
   * aggregation the host sidebar ring consumes: workbench panel per-
   * conversation badges with tone = 'accent' plus context compaction), shared
   * so plugin views never re-aggregate the same docs per tree. Optional and
   * additive: an absent host reports `unknown: true` (background facts are
   * unknown, never fabricated as "no work").
   */
  conversationBackground?: ConversationBackgroundSnapshot

  // ---- Model catalog (optional capability; implementers must keep all three members reference-stable across renders) ----
  /**
   * One-shot read of the normalized host model catalog. `undefined` = the
   * capability is not injected OR the catalog has not finished its first load
   * (the host must gate on its loaded flag — a pre-load empty array must never
   * leak out as "no models" truth); `[]` = loaded and genuinely empty. For
   * reactive reads use the useHostModels shared hook (stable-handle context,
   * isolated from host port value churn); these port members also serve
   * imperative calls inside event callbacks.
   */
  getModels?(): ReadonlyArray<HostModelEntry> | undefined
  /** Subscribe to catalog revisions (listener fired after getModels() would return a new reference). */
  subscribeModels?(listener: () => void): () => void
  /**
   * Dynamic model catalog refresh. An absent method means the host offers no
   * refresh capability — UI hides the entry and never fakes a successful
   * refresh; per-provider refresh errors surface verbatim in `errors`.
   */
  refreshModels?(): Promise<{ errors?: Record<string, string> }>

  // ---- Plugin docs ----
  /** key: `${pluginId}/${docName}`. */
  pluginDocs: Record<string, unknown>
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
 * Stable-handle slice of the host port (Pick keeps it automatically in sync
 * with the main interface — no second signature to maintain). The host mounts
 * it as a second, churn-free context whose value is built once per store
 * (never rebuilt on streaming frames), so handle-driven hooks such as
 * useHostModels stay isolated from unrelated host port value revisions.
 */
export type PluginClientHostHandles = Pick<PluginClientHostPort, 'getModels' | 'subscribeModels' | 'refreshModels'>

/** Stable host capability handles context (null outside the host Provider, same honesty rule as the main port). */
export const PluginClientHostHandlesContext = createContext<PluginClientHostHandles | null>(null)
