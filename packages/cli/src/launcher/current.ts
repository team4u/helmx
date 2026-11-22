/**
 * Access to the engine-owned `current.json` from the launcher side: the shared update-engine
 * record in `@helmx/env-io` ({version, updatedAt, entries}) is the single source of truth; the Hub launcher's only
 * contract on top is the `entryPath` entry (absolute path to the committed payload `start.mjs`).
 */
import { readCurrentRelease, requireReleaseEntry, type CurrentReleaseRecord } from '@helmx/env-io';
import { UsageError } from './io.js';

export interface HubCurrentRelease {
  version: string;
  entryPath: string;
  /** Verbatim engine record (used for verbatim rollback restore). */
  record: CurrentReleaseRecord;
}

export async function readCurrentEntry(root: string): Promise<HubCurrentRelease> {
  const record = await readCurrentRelease(root);
  if (record === null) {
    throw new UsageError(
      `no hub release installed under ${root}; run helmx update first`,
      'no_release_installed',
    );
  }
  const entryPath = requireReleaseEntry(record, 'entryPath');
  return { version: record.version, entryPath, record };
}
