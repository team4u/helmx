/**
 * Radix-free pure sub-entry of @helmx/plugin-client.
 *
 * Web pure model modules (keybindings-model / standby-model / ...) sit in the
 * static import closure of test helpers that must load BEFORE the happy-dom
 * registration (see web test helpers/store.ts); pulling the SDK barrel there
 * would evaluate the Radix dependency graph too early and break interactive
 * portals in tests. This sub-entry exposes the shared pure helpers (formatting,
 * thinking-level convergence, panel-shortcut listener) with zero Radix and
 * zero component imports, so host pure modules consume the single shared
 * implementation without dragging UI dependencies.
 */
export {
  formatModelRowDisplay,
  formatModelShortName,
  initialModelActiveIndex,
  resolveEffectiveThinkingLevel,
  stepActiveIndex,
  HELMX_SHORTCUT_EVENT,
  resolveElementPanel,
  isShortcutPanelMatch,
  usePanelShortcut,
} from './ui/model-picker-model.js'
export type { ModelRowDisplay, HelmxPanel, HelmxShortcutEventDetail } from './ui/model-picker-model.js'
