/**
 * Public SDK entry of `@helmx/plugin-client` — pure plugin runtime, host-port
 * hooks, inter-plugin slots, CSS scoping, and host-coupled widgets.
 *
 * Generic UI primitives, icons, layout shells, formatting, and clipboard helpers
 * live in `@helmx/ui` (ZERO re-exports here).
 *
 * Two consumers share the same module instance (never a second React bundle):
 * 1. the host (`@helmx/web`): mounts `globalThis.__helmx_shared_plugin_client`
 *    inside `HelmxStoreProvider`;
 * 2. plugin build artifacts: source code uses
 *    `import { ... } from '@helmx/plugin-client'`; `@helmx/plugin-build`
 *    virtualizes that specifier into `globalThis.__helmx_shared_plugin_client`.
 *
 * The single source of truth of plugin-facing runtime symbols is
 * `PLUGIN_CLIENT_SHARED_EXPORTS` in `@helmx/protocol`.
 */

// ---- Host port (injection surface) ----
export { PluginClientHostContext, usePluginClientHost } from './host-port.js'
export type {
  PluginClientHostPort,
  PluginSessionDocKey,
  PluginSessionDocState,
  PluginSlotPortItem,
} from './host-port.js'
export type { HostModelEntry, HostModelsSlice, HostNodesSlice, HostProfilesSlice } from '@helmx/protocol/browser'

// ---- Plugin context (usePluginContext) and factory ----
export {
  PluginClientContext,
  assertValidPluginRoutePath,
  createPluginClientContext,
  resolveWorkbenchPanelTabId,
  usePluginContext,
} from './plugin-context.js'
export { ScreenParamsContext, useScreenParams } from './screen-params.js'
export type { ScreenParamsScope } from '@helmx/protocol/browser'

// ---- Plugin-scoped i18n hooks + protocol locale helpers ----
export { usePluginLocale, usePluginTranslator } from './i18n.js'
export {
  HELMX_LOCALES,
  DEFAULT_HELMX_LOCALE,
  isHelmxLocale,
  normalizeLocaleTag,
  parseLocalizedText,
  resolveLocalizedText,
  createLocaleTranslator,
} from './i18n.js'
export type { HelmxLocale, LocalizedText, ExecutionText, LocaleTranslator } from './i18n.js'

// ---- Hooks: docs, conversations, plugins, catalogs, tool activity, composer ----
export {
  usePluginDoc,
  usePluginDocState,
  usePluginDocValue,
  usePluginDocValueState,
  usePluginSessionDoc,
  usePluginSessionDocDiagnostics,
  usePluginSessionDocState,
  usePluginSessionDocValue,
} from './docs.js'
export type { PluginDocLoadStatus, PluginDocState, PluginSessionDocOptions } from './docs.js'
export type { ConversationHookOptions, ConversationHookResult } from './conversation-hooks.js'
export {
  useConversation,
  useConversations,
  useHostModels,
  useHostNodes,
  useHostProfiles,
  usePluginConfig,
  usePlugins,
  useSharedNowMs,
} from './conversation-hooks.js'
export { ToolActivityContext, useToolActivity } from './tool-activity.js'
export type { ToolActivityRegistry } from './tool-activity.js'
export {
  TimelineToolCallsContext,
  createTimelineToolCallsStore,
  useTimelineToolCalls,
} from './timeline-tool-calls.js'
export type {
  TimelineToolCallsStore,
  TimelineToolCallsStoreController,
  TimelineToolCallsInput,
} from './timeline-tool-calls.js'
export type { TimelineToolCallStatus, TimelineToolCallSummary } from '@helmx/protocol/browser'
export {
  ComposerCommandContext,
  createComposerCommandRegistry,
  useComposerCommand,
} from './composer-commands.js'
export type {
  ComposerCommandHandler,
  ComposerCommandInvokeResult,
  ComposerCommandRegistry,
} from './composer-commands.js'
export { usePluginAction } from './ui/use-plugin-action.js'
export type {
  UsePluginActionOptions,
  RunPluginActionOptions,
  UsePluginActionResult,
} from './ui/use-plugin-action.js'
export { useScreenDrawer } from './ui/use-screen-drawer.js'
export type {
  ScreenDrawerMode,
  UseScreenDrawerOptions,
  UseScreenDrawerResult,
} from './ui/use-screen-drawer.js'

// ---- Host-coupled widgets: ModelPickerControl, Markdown, ToolCallDetails ----
export { ModelPickerControl } from './ui/ModelPicker.js'
export type {
  ModelPickerControlProps,
  ModelPickerInitialMode,
  ModelPickerNextTurnMode,
  ModelPickerSize,
  ModelPickerVariant,
} from './ui/ModelPicker.js'
export {
  formatModelShortName,
  initialModelActiveIndex,
  resolveDefaultChainThinkingLevel,
  resolveEffectiveThinkingLevel,
  stepActiveIndex,
  usePanelShortcut,
} from './ui/model-picker-model.js'
export type {
  DefaultThinkingLevelChain,
  HelmxPanel,
  HelmxShortcutEventDetail,
  ModelPickerControlCopy,
} from './ui/model-picker-model.js'
export { MarkdownText } from './markdown.js'
export type { MarkdownTextProps } from './markdown.js'
export { MarkdownView, CodeBlockView } from './markdown-host.js'
export type { MarkdownViewProps, CodeBlockViewProps } from './markdown-host.js'
export { ToolCallDetails } from './tool-details.js'
export type { ToolCallDetailsProps } from './tool-details.js'
export { parseArtifactUrl } from './artifact-url.js'

// ---- Inter-plugin sub-slots & plugin CSS scoping ----
export { PluginSlot } from './plugin-slot.js'
export type { PluginSlotProps } from './plugin-slot.js'
export { PluginScope } from './ui/PluginScope.js'
export type { PluginScopeProps } from './ui/PluginScope.js'
export { scopePluginCss } from './ui/plugin-css-scope.js'
