/**
 * Facade for the kernel-owned `core:*` actions (split by domain under `./core-actions/`).
 * Kept as the stable import path for `KernelRuntime`; the public entry is unchanged.
 */
export { registerCoreActions } from './core-actions/index.js'
