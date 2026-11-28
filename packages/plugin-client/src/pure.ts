/**
 * Radix-free pure sub-entry of `@helmx/plugin-client`.
 *
 * Exposes only pure model-picker thinking-level resolution helpers without
 * evaluating React DOM or `@helmx/ui` Radix portals before happy-dom
 * registration in test helpers. Pure status-light and timing helpers live in
 * `@helmx/ui`.
 */
export { resolveDefaultChainThinkingLevel, resolveEffectiveThinkingLevel } from './ui/model-picker-model.js'
export type { DefaultThinkingLevelChain } from './ui/model-picker-model.js'
