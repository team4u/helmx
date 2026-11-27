/**
 * Zero-dependency cleanup callback registry shared between `dom-harness.ts` and `store.ts`.
 * Kept free of production/React/Radix imports so `register-happy-dom.ts` never pulls in
 * `@helmx/plugin-client` before `ensureHappyDom()` registers global `window`/`document`.
 */
export const testResetCallbacks = new Set<() => void>()
