/**
 * Maps plugin IDs to cross-platform on-disk directory names and defines the physical separation
 * between per-plugin runtime data (`<dataDir>/plugins/<id>`) and external plugin code packages
 * (`<dataDir>/installed-plugins/<dir>`).
 *
 * Background: plugin IDs allow `:` (`/^[A-Za-z0-9:_-]+$/`), whereas Windows filenames forbid `:`
 * (interpreted as an NTFS alternate data stream, causing `mkdir builtin:profile` to fail with ENOENT).
 * Escapes `:` to `%3A` while preserving all other characters so IDs without `:` keep identical layouts.
 *
 * Single source of truth for `<dataDir>/plugins/<...>` (`ctx.dataDir`) and
 * `<dataDir>/installed-plugins/` (external plugin code root).
 */
import { join } from 'node:path';

const COLON = /:/g;

/** Subdirectory under `<dataDir>` for per-plugin runtime data (`ctx.dataDir`). Never scanned for code. */
export const PLUGIN_DATA_DIR_NAME = 'plugins';

/** Subdirectory under `<dataDir>` for external plugin code packages (physically separate from `ctx.dataDir`). */
export const EXTERNAL_PLUGINS_DIR_NAME = 'installed-plugins';

/** Returns the external plugin code root `<dataDir>/installed-plugins`. */
export function externalPluginsDir(dataDir: string): string {
  return join(dataDir, EXTERNAL_PLUGINS_DIR_NAME);
}

/** Returns the on-disk directory name under `<dataDir>/plugins/` for `pluginId`. */
export function pluginDataDirName(pluginId: string): string {
  return pluginId.replace(COLON, '%3A');
}

/** Returns whether a directory name belongs to a built-in plugin data directory (`builtin:` or escaped form). */
export function isBuiltinPluginDataDirName(dirName: string): boolean {
  return dirName.startsWith('builtin:') || dirName.startsWith('builtin%3A');
}
