/**
 * Embedded SDK TypeScript declaration snapshot payload (`@helmx/protocol`,
 * `@helmx/protocol/browser`, `@helmx/plugin-client`, and minimal offline shims).
 *
 * - In built artifacts (`packages/cli/dist/` and the single-file `@helmx/cli` release bundle),
 *   `packages/cli/scripts/generate-sdk-types.mjs` overwrites `dist/sdk-types-snapshot.js` at
 *   build time with the pre-compressed base64 string — zero runtime `node_modules` or workspace
 *   lookup required.
 * - In source-execution mode (`tsx packages/cli/src/index.ts` during dev/unit tests before
 *   `dist/` exists), this stub exports `null` so `plugins-types.ts` loads the snapshot via the
 *   workspace generator script.
 */
export const EMBEDDED_SDK_TYPES_PAYLOAD: string | null = null
