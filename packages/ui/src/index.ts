/**
 * Public entry of `@helmx/ui` — standalone Quiet Surface Design System package.
 *
 * Two consumers share the same module instance (never a second React bundle):
 * 1. the host (`@helmx/web`) and `@helmx/plugin-client`: import primitives,
 *    tokens, and stylesheets directly, and `@helmx/web` mounts
 *    `globalThis.__helmx_shared_ui = HelmxUi` inside `HelmxStoreProvider`;
 * 2. plugin build artifacts: source code uses `import { ... } from '@helmx/ui'`;
 *    `@helmx/plugin-build` virtualizes that specifier into
 *    `globalThis.__helmx_shared_ui`.
 *
 * ZERO dependency on plugin runtime contexts (`PluginClientContext`,
 * `PluginClientHostContext`, store, or routing). Plugin-facing runtime symbols
 * are locked bi-directionally against `UI_SHARED_EXPORTS` in `@helmx/protocol`.
 */

// ---- Scope, locale & screen-host contexts ----
export { UiScopeContext, useUiScopeId } from './ui-scope-context.js'
export { UiScope } from './UiScope.js'
export type { UiScopeProps } from './UiScope.js'
export {
  UiLocaleContext,
  useUiLocale,
  useUiTranslator,
  HELMX_LOCALES,
  DEFAULT_HELMX_LOCALE,
  isHelmxLocale,
  normalizeLocaleTag,
  parseLocalizedText,
  resolveLocalizedText,
  createLocaleTranslator,
} from './ui-locale-context.js'
export type {
  UiLocaleStore,
  HelmxLocale,
  LocalizedText,
  ExecutionText,
  LocaleTranslator,
} from './ui-locale-context.js'
export { UiLocaleProvider } from './UiLocaleProvider.js'
export type { UiLocaleProviderProps } from './UiLocaleProvider.js'
export { ScreenHostContext, useScreenHost } from './screen-host.js'
export type { ScreenHostState } from './screen-host.js'
export {
  FieldContext,
  useFieldContext,
  useFieldControlProps,
  mergeAriaDescribedBy,
} from './primitives/field-context.js'
export type {
  FieldContextValue,
  FieldControlOverrides,
  FieldControlProps,
} from './primitives/field-context.js'

// ---- Accessibility & overlay primitives (Radix wrappers) ----
export { Switch } from './primitives/Switch.js'
export type { SwitchProps } from './primitives/Switch.js'
export { Checkbox } from './primitives/Checkbox.js'
export type { CheckboxProps } from './primitives/Checkbox.js'
export { Select, MultiSelect } from './primitives/Select.js'
export type {
  SelectProps,
  SelectOption,
  SelectChangeEvent,
  MultiSelectChangeEvent,
  BaseSelectProps,
  SingleSelectProps,
  MultiSelectProps,
} from './primitives/Select.js'
export { Tabs, TabsList, TabsTrigger, TabsContent, TabCount, SegmentedControl } from './primitives/Tabs.js'
export type {
  TabsProps,
  TabsListProps,
  TabsTriggerProps,
  TabsContentProps,
  TabCountProps,
  TabsVariant,
  TabsSize,
  SegmentedControlItem,
  SegmentedControlProps,
} from './primitives/Tabs.js'
export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogTrigger,
} from './primitives/Dialog.js'
export type {
  DialogProps,
  DialogPortalProps,
  DialogOverlayProps,
  DialogContentProps,
  DialogTitleProps,
  DialogDescriptionProps,
  DialogCloseProps,
  DialogTriggerProps,
} from './primitives/Dialog.js'
export { ModalDialog } from './primitives/ModalDialog.js'
export type { ModalDialogProps, ModalDialogSize } from './primitives/ModalDialog.js'
export {
  Popover,
  PopoverRoot,
  PopoverTrigger,
  PopoverAnchor,
  PopoverPortal,
  PopoverClose,
  PopoverContent,
  PopoverHeader,
  PopoverItem,
} from './primitives/Popover.js'
export type {
  PopoverPortalProps,
  PopoverContentProps,
  PopoverArrowProps,
  PopoverHeaderProps,
  PopoverItemProps,
} from './primitives/Popover.js'
export { useListKeyboardNav } from './primitives/use-list-keyboard-nav.js'
export type {
  UseListKeyboardNavKeyEvent,
  UseListKeyboardNavOptions,
  UseListKeyboardNavResult,
} from './primitives/use-list-keyboard-nav.js'
export {
  Tooltip,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
  TooltipContent,
} from './primitives/Tooltip.js'
export type {
  TooltipProps,
  TooltipProviderProps,
  TooltipContentProps,
} from './primitives/Tooltip.js'
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
} from './primitives/DropdownMenu.js'
export type {
  DropdownMenuPortalProps,
  DropdownMenuContentProps,
  DropdownMenuItemProps,
  DropdownMenuSeparatorProps,
  DropdownMenuLabelProps,
} from './primitives/DropdownMenu.js'
export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogContent,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogTrigger,
  ConfirmDialog,
} from './primitives/AlertDialog.js'
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
} from './primitives/AlertDialog.js'

// ---- Core form, feedback, card, list & layout primitives ----
export { ViewBoundary } from './primitives/ViewBoundary.js'
export type { ViewBoundaryProps } from './primitives/ViewBoundary.js'
export { StatusLight } from './primitives/StatusLight.js'
export type { StatusLightProps } from './primitives/StatusLight.js'
export {
  STATUS_LIGHT_TONES,
  normalizeStatusLightTone,
  isKnownStatusLightStatus,
} from './primitives/status-light-model.js'
export type { StatusLightTone } from './primitives/status-light-model.js'
export { Button, IconButton } from './primitives/Button.js'
export type { ButtonProps, ButtonSize, ButtonVariant, IconButtonProps } from './primitives/Button.js'
export { Badge } from './primitives/Badge.js'
export type { BadgeProps, BadgeTone } from './primitives/Badge.js'
export { Kbd } from './primitives/Kbd.js'
export type { KbdProps, KbdSize } from './primitives/Kbd.js'
export { Stack } from './primitives/Stack.js'
export type { StackAlign, StackDirection, StackGap, StackJustify, StackProps } from './primitives/Stack.js'
export { Input, Textarea } from './primitives/Input.js'
export type { InputProps, InputSize, TextareaProps } from './primitives/Input.js'
export { Field, HelperText, ErrorText } from './primitives/Field.js'
export type { ErrorTextProps, FieldLayout, FieldProps, HelperTextProps } from './primitives/Field.js'
export { Card, SelectCard, CardGrid } from './primitives/Card.js'
export type {
  CardGridGap,
  CardGridMinWidth,
  CardGridProps,
  CardProps,
  CardTone,
  CardVariant,
  SelectCardProps,
} from './primitives/Card.js'
export { List, ListRow } from './primitives/List.js'
export type { ListDensity, ListProps, ListRowProps, ListRowTone } from './primitives/List.js'
export { MonoId } from './primitives/MonoId.js'
export type { MonoIdProps } from './primitives/MonoId.js'
export { SearchBox } from './primitives/SearchBox.js'
export type { SearchBoxProps, SearchBoxSize, SearchBoxSurface, SearchBoxVariant } from './primitives/SearchBox.js'
export { EmptyState } from './primitives/EmptyState.js'
export type { EmptyStateProps } from './primitives/EmptyState.js'
export { LoadingState } from './primitives/LoadingState.js'
export type { LoadingStateProps } from './primitives/LoadingState.js'
export { Screen, ScreenSection, ScreenToolbar, DataTable, KvGrid } from './primitives.js'
export type {
  ScreenLayout,
  ScreenProps,
  ScreenSectionProps,
  ScreenToolbarProps,
  DataTableProps,
  KvGridProps,
} from './primitives.js'
export { MasterDetail } from './primitives/MasterDetail.js'
export type { MasterDetailMobilePane, MasterDetailProps } from './primitives/MasterDetail.js'
export { BatchBar } from './primitives/BatchBar.js'
export type { BatchBarProps } from './primitives/BatchBar.js'
export { Callout } from './callout.js'
export type { CalloutProps } from './callout.js'
export { DetailDrawer } from './primitives/DetailDrawer.js'
export type { DetailDrawerProps } from './primitives/DetailDrawer.js'
export { DockTray, DockTrayRow } from './primitives/DockTray.js'
export type { DockTrayProps, DockTrayRowProps } from './primitives/DockTray.js'

// ---- Clipboard, icons & pure formatting ----
export { CopyButton } from './copy-button.js'
export { copyToClipboard } from './clipboard.js'
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
