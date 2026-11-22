/**
 * Public SDK entry of @helmx/plugin-client.
 *
 * Two consumers share the same module instance (never a second React bundle):
 * 1. the host (@helmx/web): imports this package for shared primitives /
 *    context / hooks, and mounts __helmx_shared_plugin_client = this module
 *    namespace inside HelmxStoreProvider;
 * 2. plugin build artifacts: source code uses
 *    `import { ... } from '@helmx/plugin-client'`; the compiler virtualizes
 *    that specifier into globalThis.__helmx_shared_plugin_client.
 *
 * The single source of truth of plugin-facing runtime symbols is
 * PLUGIN_CLIENT_SHARED_EXPORTS in @helmx/protocol (bi-directionally locked by
 * services.test / this package's tests); host-facing symbols (host port,
 * context factory, explicitly-addressing hooks) are consumed only by the host
 * and tests, and are not part of the plugin contract list.
 */

// ---- Host port (injection surface) ----
export { PluginClientHostContext, usePluginClientHost } from './host-port.js'
export type {
  PluginClientHostPort,
  PluginSessionDocKey,
  PluginSessionDocState,
  PluginSlotPortItem,
} from './host-port.js'
export type { HostModelEntry, HostModelsSlice } from '@helmx/protocol/browser'

// ---- Plugin context (usePluginContext) and factory ----
export { PluginClientContext, createPluginClientContext, usePluginContext } from './plugin-context.js'
export { ScreenParamsContext, useScreenParams } from './screen-params.js'
export type { ScreenParamsScope } from '@helmx/protocol/browser'

// ---- i18n: locale & translation (plugin-consumable hooks + locale essentials) ----
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

// ---- hooks: doc subscriptions / conversations / plugin list / tool activity ----
export { usePluginDoc, usePluginDocValue, usePluginSessionDoc, usePluginSessionDocState, usePluginSessionDocValue } from './docs.js'
export type { ConversationHookOptions, ConversationHookResult } from './conversation-hooks.js'
export { useConversation, useConversations, useHostModels, usePluginConfig, usePlugins, useSharedNowMs } from './conversation-hooks.js'
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

// ---- Model picker (shared host/plugin model + thinking-level control) ----
export { ModelPickerControl } from './ui/ModelPicker.js'
export type { ModelPickerControlProps } from './ui/ModelPicker.js'
export {
  formatModelShortName,
  initialModelActiveIndex,
  resolveEffectiveThinkingLevel,
  stepActiveIndex,
} from './ui/model-picker-model.js'
export type { HelmxPanel, HelmxShortcutEventDetail, ModelPickerControlCopy } from './ui/model-picker-model.js'

// ---- Accessibility base components (Radix wrappers) ----
export { Switch } from './ui/Switch.js'
export type { SwitchProps } from './ui/Switch.js'
export { Checkbox } from './ui/Checkbox.js'
export type { CheckboxProps } from './ui/Checkbox.js'
export { Select } from './ui/Select.js'
export type { SelectProps, SelectOption, SelectChangeEvent, MultiSelectChangeEvent, BaseSelectProps, SingleSelectProps, MultiSelectProps } from './ui/Select.js'
export { MultiSelect } from './ui/Select.js'
export { Tabs, TabsList, TabsTrigger, TabsContent, SegmentedControl } from './ui/Tabs.js'
export type { TabsProps, TabsListProps, TabsTriggerProps, TabsContentProps, TabsVariant, TabsSize, SegmentedControlItem, SegmentedControlProps } from './ui/Tabs.js'
export { Dialog, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription, DialogClose, DialogTrigger } from './ui/Dialog.js'
export type { DialogProps, DialogPortalProps, DialogOverlayProps, DialogContentProps, DialogTitleProps, DialogDescriptionProps, DialogCloseProps, DialogTriggerProps } from './ui/Dialog.js'
export { Popover, PopoverRoot, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent } from './ui/Popover.js'
export {
  Tooltip,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipContent,
} from './ui/Tooltip.js'
export type {
  TooltipProps,
  TooltipProviderProps,
  TooltipContentProps,
} from './ui/Tooltip.js'
export {
  DropdownMenu,
  DropdownMenuRoot,
  DropdownMenuTrigger,
  DropdownMenuPortal,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuGroup,
} from './ui/DropdownMenu.js'
export type {
  DropdownMenuPortalProps,
  DropdownMenuContentProps,
  DropdownMenuItemProps,
  DropdownMenuSeparatorProps,
  DropdownMenuLabelProps,
} from './ui/DropdownMenu.js'
export { ViewBoundary } from './ui/ViewBoundary.js'
export { StatusLight } from './ui/StatusLight.js'
export type { StatusLightProps } from './ui/StatusLight.js'
export type { StatusLightTone } from './ui/status-light-model.js'
export { SearchBox } from './ui/SearchBox.js'
export type { SearchBoxProps } from './ui/SearchBox.js'
export { EmptyState } from './ui/EmptyState.js'
export type { EmptyStateProps } from './ui/EmptyState.js'
export { LoadingState } from './ui/LoadingState.js'
export type { LoadingStateProps } from './ui/LoadingState.js'
export { usePluginAction } from './ui/use-plugin-action.js'
export type {
  UsePluginActionOptions,
  RunPluginActionOptions,
  UsePluginActionResult,
} from './ui/use-plugin-action.js'
export { PluginScope } from './ui/PluginScope.js'
export type { PluginScopeProps } from './ui/PluginScope.js'
export { scopePluginCss } from './ui/plugin-css-scope.js'
export { AlertDialog, AlertDialogPortal, AlertDialogOverlay, AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogAction, AlertDialogCancel, AlertDialogTrigger } from './ui/AlertDialog.js'
export type {
  AlertDialogProps,
  AlertDialogPortalProps,
  AlertDialogOverlayProps,
  AlertDialogContentProps,
  AlertDialogTitleProps,
  AlertDialogDescriptionProps,
  AlertDialogActionProps,
  AlertDialogCancelProps,
  AlertDialogTriggerProps,
  ConfirmDialogProps,
} from './ui/AlertDialog.js'
export { ConfirmDialog } from './ui/AlertDialog.js'

// ---- Lightweight layout primitives and hints ----
export { Screen, ScreenSection, ScreenToolbar, DataTable, KvGrid } from './primitives.js'
export type { ScreenLayout, ScreenProps, ScreenSectionProps, ScreenToolbarProps, DataTableProps, KvGridProps } from './primitives.js'
export { Callout } from './callout.js'
export type { CalloutProps } from './callout.js'
export { DetailDrawer } from './ui/DetailDrawer.js'
export type { DetailDrawerProps } from './ui/DetailDrawer.js'
export { DockTray, DockTrayRow } from './ui/DockTray.js'
export type { DockTrayProps, DockTrayRowProps } from './ui/DockTray.js'

// ---- Content display ----
export { MarkdownText } from './markdown.js'
export type { MarkdownTextProps } from './markdown.js'
export { MarkdownView, CodeBlockView } from './markdown-host.js'
export type { MarkdownViewProps, CodeBlockViewProps } from './markdown-host.js'
export { ToolCallDetails } from './tool-details.js'
export type { ToolCallDetailsProps } from './tool-details.js'
export { CopyButton } from './copy-button.js'
export { parseArtifactUrl, markdownUrlTransform } from './artifact-url.js'
export { copyToClipboard } from './clipboard.js'

// ---- Inter-plugin sub-slots ----
export { PluginSlot } from './plugin-slot.js'
export type { PluginSlotProps } from './plugin-slot.js'

// ---- Icons and formatting pure functions ----
export { HelmxIcon } from './icons.js'
export type { HelmxIconName, HelmxIconProps } from './icons.js'
export {
  formatTime,
  formatCompactTimestamp,
  formatDurationMs,
  formatStopwatchMs,
  formatOffsetMs,
  formatBytes,
  resolveConversationTiming,
} from './format.js'
export type { ConversationTimingInput, ConversationTimingSnapshot } from './format.js'
