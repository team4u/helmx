/**
 * Strict SemVer and npm dist-tag entry points for the update engine.
 *
 * SemVer parsing and precedence comparison live only in `@helmx/protocol` (the repo's single
 * implementation); this module keeps the update-specific rejection envelope (`UpgradeRejectedError`)
 * and single-source dist-tag validation shared by Node, CLI launcher, Hub updater, and payload handoff.
 */
import { compareStrictSemver, isStrictSemver, stripSemverVPrefix } from '@helmx/protocol';
import { UpgradeRejectedError } from './errors.js';

export { compareStrictSemver, isStrictSemver };

/** Legal npm dist-tag segment: one path-safe segment (version-shaped tags are rejected). */
const DIST_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Validate strict SemVer (`x.y.z[-pre][+build]`, no leading `v`); throws `UpgradeRejectedError`. */
export function assertStrictSemver(input: string, label = 'version'): string {
  if (!isStrictSemver(input)) {
    throw new UpgradeRejectedError(
      `invalid SemVer version (${label}): "${input}" (expected strict x.y.z[-pre][+build] without v prefix)`,
    );
  }
  return input;
}

/** Strict SemVer comparison; throws `UpgradeRejectedError` on invalid input. */
export function compareSemver(a: string, b: string): number {
  assertStrictSemver(a, 'a');
  assertStrictSemver(b, 'b');
  return compareStrictSemver(a, b);
}

/** Trim whitespace, strip an optional leading `v`/`V`, and validate strict SemVer. */
export function normalizeTargetVersion(input: string): string {
  const trimmed = stripSemverVPrefix(input);
  return assertStrictSemver(trimmed, 'targetVersion');
}

/**
 * Validate an npm dist-tag segment (`latest`, `beta`, etc.). Rejects path traversal, whitespace,
 * and version-shaped strings (which resolve exact-version documents instead of dist-tags).
 */
export function assertDistTag(tag: string, label = 'dist-tag'): string {
  if (!DIST_TAG_PATTERN.test(tag)) {
    throw new UpgradeRejectedError(
      `invalid ${label}: "${tag}" (expected a single npm dist-tag segment such as "latest" or "beta")`,
    );
  }
  if (isStrictSemver(tag)) {
    throw new UpgradeRejectedError(
      `invalid ${label}: "${tag}" looks like a version, not a dist-tag (request the exact version instead)`,
    );
  }
  return tag;
}
