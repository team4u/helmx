/**
 * Idempotent happy-dom preload and inter-file DOM reset helper for `dom-shared` test shards.
 *
 * Loaded via `NODE_OPTIONS=--import=...` ONLY for `dom-shared` worker shards (never for
 * `pure`, `node-shared`, or `isolated` processes):
 * - Wraps `GlobalRegistrator.register()` so calling it in multiple test files within the
 *   same shared process is a clean idempotent no-op instead of throwing
 *   "Happy DOM has already been globally registered."
 * - Captures the baseline `globalThis.fetch` after initial registration and exports
 *   `resetSharedHappyDom()` so `shard-worker.mjs` can restore clean DOM/storage/URL/fetch
 *   state between files.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const STATE_KEY = '__helmxDomShardPreloadState';

function getState() {
  const g = globalThis;
  if (!g[STATE_KEY]) {
    g[STATE_KEY] = {
      installed: false,
      registrator: null,
      baselineFetch: undefined,
      baselineFetchCaptured: false,
      baselineBlob: undefined,
      baselineSetInterval: undefined,
      baselineClearInterval: undefined,
      baselineGlobalsCaptured: false,
    };
  }
  return g[STATE_KEY];
}

function resolveGlobalRegistratorUrl() {
  const anchors = [
    path.join(repoRoot, 'packages', 'web', 'package.json'),
    path.join(repoRoot, 'packages', 'plugin-client', 'package.json'),
    path.join(repoRoot, 'package.json'),
  ];
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try {
      const req = createRequire(anchor);
      return pathToFileURL(req.resolve('@happy-dom/global-registrator')).href;
    } catch {
      // Try next workspace anchor
    }
  }
  return null;
}

export async function installDomShardPreload() {
  const state = getState();
  if (state.installed) return;
  state.installed = true;

  const url = resolveGlobalRegistratorUrl();
  if (!url) return;

  try {
    const mod = await import(url);
    const GlobalRegistrator = mod.GlobalRegistrator ?? mod.default;
    if (!GlobalRegistrator || typeof GlobalRegistrator.register !== 'function') return;
    state.registrator = GlobalRegistrator;

    const origRegister = GlobalRegistrator.register.bind(GlobalRegistrator);
    // Register happy-dom eagerly before ANY test module loads in a `dom-shared` worker so
    // packages like `@radix-ui/react-use-layout-effect` never cache `canUseDOM = false`
    // when an SSR-only React test happens to run ahead of interactive DOM tests in the shard.
    if (!GlobalRegistrator.isRegistered) {
      origRegister();
    }
    if (!state.baselineFetchCaptured) {
      state.baselineFetch = globalThis.fetch;
      state.baselineFetchCaptured = true;
    }
    if (!state.baselineGlobalsCaptured) {
      state.baselineBlob = globalThis.Blob;
      state.baselineSetInterval = globalThis.setInterval;
      state.baselineClearInterval = globalThis.clearInterval;
      state.baselineGlobalsCaptured = true;
    }

    GlobalRegistrator.register = function idempotentRegister(options) {
      if (GlobalRegistrator.isRegistered) {
        return;
      }
      const res = origRegister(options);
      if (!state.baselineFetchCaptured) {
        state.baselineFetch = globalThis.fetch;
        state.baselineFetchCaptured = true;
      }
      if (!state.baselineGlobalsCaptured) {
        state.baselineBlob = globalThis.Blob;
        state.baselineSetInterval = globalThis.setInterval;
        state.baselineClearInterval = globalThis.clearInterval;
        state.baselineGlobalsCaptured = true;
      }
      return res;
    };
  } catch {
    // If happy-dom is not installed in a minimal environment, fail open to native behavior.
  }
}

/**
 * Reset shared happy-dom state between sequential test files in a `dom-shared` worker.
 * Only touches globals when happy-dom has already been registered in this process.
 */
export function resetSharedHappyDom() {
  const state = getState();
  const isRegistered =
    Boolean(state.registrator?.isRegistered) ||
    (typeof globalThis.document !== 'undefined' && typeof globalThis.window !== 'undefined');
  if (!isRegistered) return;

  try {
    if (globalThis.document) {
      if (globalThis.document.body) {
        globalThis.document.body.innerHTML = '';
      }
      if (globalThis.document.head) {
        globalThis.document.head.innerHTML = '';
      }
      globalThis.document.title = '';
      const rootEl = globalThis.document.documentElement;
      if (rootEl && typeof rootEl.getAttributeNames === 'function') {
        for (const attr of rootEl.getAttributeNames()) {
          rootEl.removeAttribute(attr);
        }
      }
    }
  } catch {
    // Ignore DOM cleanup errors from custom test mocks
  }

  try {
    globalThis.localStorage?.clear();
  } catch {
    // Ignore unavailable storage
  }
  try {
    globalThis.sessionStorage?.clear();
  } catch {
    // Ignore unavailable storage
  }

  try {
    if (globalThis.window?.history && typeof globalThis.window.history.replaceState === 'function') {
      globalThis.window.history.replaceState(null, '', '/');
    }
    if (globalThis.window?.location && globalThis.window.location.hash) {
      globalThis.window.location.hash = '';
    }
  } catch {
    // Ignore history/location errors on opaque origins
  }

  if (state.baselineFetchCaptured && globalThis.fetch !== state.baselineFetch) {
    try {
      globalThis.fetch = state.baselineFetch;
    } catch {
      // Ignore read-only fetch
    }
  }
  if (state.baselineGlobalsCaptured) {
    for (const [prop, baseline] of [
      ['Blob', state.baselineBlob],
      ['setInterval', state.baselineSetInterval],
      ['clearInterval', state.baselineClearInterval],
    ]) {
      if (globalThis[prop] !== baseline) {
        try {
          globalThis[prop] = baseline;
        } catch {
          // Ignore read-only globals
        }
      }
    }
  }

  // Clear cross-bundle builtin plugin client buses stored on globalThis via Symbol.for('helmx:builtin:*')
  // (e.g. workflow workbench-focus, magpie auto-refresh) so sequential test files in one dom-shared
  // worker never inherit pending focus requests or dangling timers from an earlier file.
  try {
    for (const sym of Object.getOwnPropertySymbols(globalThis)) {
      const key = Symbol.keyFor(sym);
      if (typeof key !== 'string' || !key.startsWith('helmx:builtin:')) continue;
      const slot = globalThis[sym];
      if (slot && typeof slot === 'object' && 'timer' in slot && slot.timer !== undefined) {
        try {
          clearInterval(slot.timer);
        } catch {
          // Ignore invalid timer handles
        }
      }
      delete globalThis[sym];
    }
  } catch {
    // Ignore read-only global symbols
  }
}

await installDomShardPreload();
