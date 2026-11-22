/**
 * Radix-free pure sub-entry of @helmx/plugin-client.
 *
 * Web pure model modules (standby-model.ts) sit in the static import closure
 * of test helpers that must load BEFORE the happy-dom registration (see web
 * test helpers/store.ts); pulling the SDK barrel there would evaluate the
 * Radix dependency graph too early and break interactive portals in tests.
 * This sub-entry exposes only the actively consumed pure helper with zero
 * Radix and zero component imports.
 */
export { resolveEffectiveThinkingLevel } from './ui/model-picker-model.js'
