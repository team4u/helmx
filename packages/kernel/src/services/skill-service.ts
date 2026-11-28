/**
 * SkillService: manages `skills/<id>/` bundles and read-only machine-level shared skill roots (`~/.agents/skills`),
 * enforcing traversal/symlink escape defense and managed built-in plugin skill asset synchronization.
 */

// Skill id / in-bundle path / frontmatter validity rules are the cross-package contract in
// @helmx/protocol skill-contract.ts (single source of truth, shared with @helmx/plugins node skills).

import { lstat, mkdir, readdir, readFile, realpath, rmdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import {
  HelmxError,
  assertSkillId,
  assertSafeSkillRelativePath,
  parseSkillFrontmatter,
  type SkillSummary,
} from '@helmx/protocol'
import {
  FileNotFoundError,
  atomicWriteFile,
  readTextFile,
} from './atomic-file.js'

export type { SkillSummary }

// Re-export the shared skill contract so the kernel services entry keeps exposing it
// (existing in-repo consumers import from '../services/index.js').
export { assertSkillId, assertSafeSkillRelativePath, parseSkillFrontmatter } from '@helmx/protocol'

/** Real-path containment check: child === parent or child sits underneath parent (both must already be realpathed). */
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent + sep)
}

/** Managed skill bundle asset bootstrapped by the kernel (`core:*`) or a plugin: SKILL.md + references files. */
export interface BuiltinSkillAsset {
  id: string
  skillMd: string
  references: Record<string, string>
}

export interface EnsureSkillOptions {
  /**
   * When true, defer sweeping retired same-owner skill directories until the caller invokes
   * `reconcileManagedOwners(...)` after a batch bootstrap finishes (prevents delete+recreate
   * churn when one owner registers multiple skills in sequence).
   */
  deferOwnerReconcile?: boolean
}

/** Recursively collect relative paths of regular files in a skill bundle. Skips hidden files/dirs starting with `.`
 * (.git/.gitignore, etc.), dependency/build artifact dirs (node_modules/__pycache__/dist, which would bloat the catalog
 * on engineering-style skill bundles), and symlinks (closing escape vectors).
 * Only collects paths passing assertSafeSkillRelativePath—sharing the exact same validity contract with load_skill
 * so every listed reference is guaranteed readable (paths with spaces/?/# are omitted for consistency). */
async function collectFiles(root: string, rel = ''): Promise<string[]> {
  const dir = rel === '' ? root : join(root, rel)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return []
    throw err
  }
  const out: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const relPath = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === 'dist') continue
      out.push(...(await collectFiles(root, relPath)))
    } else if (entry.isFile() && entry.name !== 'SKILL.md') {
      try {
        out.push(assertSafeSkillRelativePath(relPath))
      } catch {
        // Invalid relative paths (spaces / special chars) cannot be read via load_skill; exclude from catalog.
      }
    }
  }
  return out.sort()
}

/**
 * Machine-level shared skills root (pi ecosystem skill library, `~/.agents/skills`): SkillService scans and loads
 * it read-only as an external source and never writes to it via writeFile/ensureSkill.
 * This is not a filesystem permission or tool sandbox; bash/read/write/edit still follow OS permissions.
 * Independent of HELMX_DATA_DIR; injected by production kernel assembly, excluded from SkillService by default.
 */
export function defaultExternalSkillRoots(): string[] {
  return [join(homedir(), '.agents', 'skills')]
}

/** Determine whether a single-entry error under an external root should be skipped: schema/validation errors (plain Error without Node
 * errno code) and ENOENT (missing SKILL.md or directory) skip the entry; real IO errors (EACCES/EIO, etc.)
 * are rethrown rather than silently ignored. */
function isSkippableExternalEntryError(err: unknown): boolean {
  if (err instanceof FileNotFoundError) return true
  const code = (err as { code?: unknown }).code
  if (code === undefined) return true
  return code === 'ENOENT'
}

export class SkillService {
  /** Managed skill IDs bootstrapped via ensureSkill (in-process; normal write endpoints return 403). */
  private readonly managedSkillIds = new Set<string>()

  /** Owner-indexed skill IDs ensured this process: the in-memory declared set used to sweep retired same-owner skill
   * dirs (rename/retire residue). Accumulates across ensureSkill calls, so a rename performed only via live plugin
   * reload keeps the retired id until the next process start reconciles it; plugins with multiple services that
   * ensure skills sequentially see delete+recreate churn at most (source content is rewritten identically). */
  private readonly managedIdsByOwner = new Map<string, Set<string>>()

  private readonly dataDir: string

  /** External sources scanned and loaded read-only by SkillService and load_skill (ordered after dataDir). */
  private readonly externalRoots: readonly string[]

  /** External roots are omitted by default: this service deterministically scans the given directories,
   * and production kernel assembly injects machine-level shared roots via defaultExternalSkillRoots() (tests stay isolated). */
  constructor(dataDir: string, options?: { externalRoots?: readonly string[] }) {
    this.dataDir = dataDir
    this.externalRoots = options?.externalRoots ?? []
  }

  /** All skill summaries (merged from dataDir root + external shared roots, injected into load_skill catalog).
   * dataDir root keeps strict semantics: invalid IDs are skipped, broken frontmatter throws. Missing external root
   * ENOENT is treated as empty; malformed external entries (third-party content Helmx does not own) are skipped rather than
   * breaking the entire catalog. Deduplicated by id: dataDir always wins (managed skills can never be shadowed by external ones,
   * while placing a same-named skill in dataDir creates a local override); otherwise first declared root wins. Sorted stably by id. */
  async list(): Promise<SkillSummary[]> {
    const byId = new Map<string, SkillSummary>()
    const dataRoot = join(this.dataDir, 'skills')
    let dataEntries: string[]
    try {
      dataEntries = await readdir(dataRoot)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') dataEntries = []
      else throw err
    }
    if (dataEntries.length > 0) {
      // readdir succeeded so the root exists; normalize via realpath (for macOS /var symlink prefixes) before containment checks.
      const dataRootReal = await realpath(dataRoot)
      for (const entry of dataEntries) {
        try {
          assertSkillId(entry)
        } catch {
          continue
        }
        const summary = await this.summarizeInRoot(dataRootReal, entry)
        if (summary !== undefined) byId.set(entry, summary)
      }
    }
    for (const extRoot of this.externalRoots) {
      let extEntries: string[]
      try {
        extEntries = await readdir(extRoot)
      } catch (err) {
        // Missing shared root is treated as empty (pi skill library not installed), not an error.
        if ((err as { code?: string }).code === 'ENOENT') continue
        throw err
      }
      if (extEntries.length === 0) continue
      const extRootReal = await realpath(extRoot)
      for (const entry of extEntries) {
        if (byId.has(entry)) continue // dataDir (or earlier external root) entry takes precedence
        try {
          assertSkillId(entry)
          const summary = await this.summarizeInRoot(extRootReal, entry, 'agents')
          if (summary !== undefined) byId.set(entry, summary)
        } catch (err) {
          if (isSkippableExternalEntryError(err)) continue
          throw err
        }
      }
    }
    const skills = [...byId.values()]
    skills.sort((a, b) => a.id.localeCompare(b.id))
    return skills
  }

  /** Safely read a file inside a skill bundle (defaults to SKILL.md); strictly blocks absolute paths, `..`, and symlink escapes.
   * Resolution order: dataDir -> each external shared root. If the skill dir is absent in one root, tries the next;
   * if missing across all roots, preserves FileNotFoundError (HTTP 404). Security check rejections
   * (symlink/escape/non-regular file) throw immediately from the matching root without falling back across roots.
   * Every root enforces identical three-layer defense: (1) reject symlinked skill dir itself;
   * (2) two-layer realpath containment check (skillDir realpath must stay inside its skills root);
   * (3) per-segment lstat rejecting symlinks and verifying target realpath stays inside skillDir. */
  async readFile(skillId: string, path = 'SKILL.md'): Promise<string> {
    assertSkillId(skillId)
    const rel = assertSafeSkillRelativePath(path)
    for (const skillsRoot of await this.resolveReadableRoots()) {
      const content = await this.readFileInRoot(skillsRoot, skillId, rel)
      if (content !== undefined) return content
    }
    throw new FileNotFoundError(join(this.dataDir, 'skills', skillId))
  }

  /** Resolve and read within a single root: returns file contents, or undefined if the skill directory does not exist in this root
   * (so lookup continues to the next root); if the skill exists here but the target file is missing, throws FileNotFoundError
   * (this root owns the skill and never falls back to another root). */
  private async readFileInRoot(skillsRoot: string, skillId: string, rel: string): Promise<string | undefined> {
    const root = join(skillsRoot, skillId)
    // Reject if the skill directory itself is a symlink (even if its target resolves inside skillsRoot).
    const rootStat = await lstat(root).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (rootStat === undefined) return undefined
    if (rootStat.isSymbolicLink()) {
      throw new Error(`skill directory is a symlink; refusing to read: ${skillId}`)
    }
    // Two-layer realpath containment check: skillDir realpath must stay within skillsRoot (prevents intermediate symlink escapes).
    const rootReal = await realpath(root)
    if (!isWithin(rootReal, skillsRoot)) {
      throw new Error(`skill directory out of bounds (symlink points outside skills root): ${skillId}`)
    }
    const target = join(root, rel)
    // Per-segment lstat: reject any symlink along the path (symlinks could escape the skill directory).
    let current = root
    for (const seg of rel.split('/')) {
      current = join(current, seg)
      const s = await lstat(current).catch((err: unknown) => {
        if ((err as { code?: string }).code === 'ENOENT') {
          throw new FileNotFoundError(target)
        }
        throw err
      })
      if (s.isSymbolicLink()) {
        throw new Error(`refusing to read symlink (out-of-bounds protection): ${rel}`)
      }
    }
    const finalStat = await lstat(target)
    if (!finalStat.isFile()) throw new Error(`not a regular file: ${rel}`)
    // Final target realpath must remain inside skillDir (protects against TOCTOU directory-to-symlink swaps mid-read).
    const targetReal = await realpath(target)
    if (!isWithin(targetReal, rootReal)) {
      throw new Error(`target escapes skill directory (realpath outside skillDir): ${rel}`)
    }
    return readTextFile(target)
  }

  /** Resolve readable roots (normalized with realpath): dataDir skills root first, followed by external shared roots;
   * ENOENT is skipped (missing dataDir skills root no longer throws globally, so readFile uniformly surfaces FileNotFoundError);
   * dangling symlinks and other realpath errors are rethrown. */
  private async resolveReadableRoots(): Promise<string[]> {
    const roots: string[] = []
    for (const raw of [join(this.dataDir, 'skills'), ...this.externalRoots]) {
      const real = await realpath(raw).catch((err: unknown) => {
        if ((err as { code?: string }).code === 'ENOENT') return undefined
        throw err
      })
      if (real !== undefined) roots.push(real)
    }
    return roots
  }

  /** Create or overwrite a skill file (programmatic write entry, enforcing the same security checks).
   * Managed skills (built-in system assets registered by ensureSkill) are uniformly rejected at the service boundary.
   * Only writes to dataDir: calling writeFile for a skill name from an external shared root writes a dataDir copy
   * that shadows the external entry as a local override. This is not a filesystem write permission boundary;
   * generic tools such as bash/write/edit can still write arbitrary paths per OS permissions. */
  async writeFile(skillId: string, path: string, content: string): Promise<void> {
    assertSkillId(skillId)
    this.assertSkillMutable(skillId)
    const rel = assertSafeSkillRelativePath(path)
    const skillsRoot = await this.requireSkillsRoot()
    const root = join(skillsRoot, skillId)
    const rootReal = await realpath(root).catch(() => undefined)
    if (rootReal !== undefined && !isWithin(rootReal, skillsRoot)) {
      throw new Error(`skill directory out of bounds (symlink points outside skills root): ${skillId}`)
    }
    const target = join(root, rel)
    const existing = await lstat(target).catch(() => undefined)
    if (existing !== undefined && existing.isSymbolicLink()) {
      throw new Error(`refusing to overwrite symlink: ${rel}`)
    }
    await atomicWriteFile(target, content)
  }

  /**
   * Managed skill bootstrapper (used by kernel `core:*` skills and plugins): `skills/<id>/SKILL.md` and
   * `references/*` are managed system assets; on every startup they are overwritten file-by-file from the source
   * declarations (reverting stale files and manual disk edits back to source) and missing files are added. Files
   * whose byte contents already match are skipped (by byte comparison, not mtime, avoiding atomic rename churn in
   * AssetWatcher hot reload).
   *
   * Source-of-authority reconciliation (no phantom residue): reference files no longer declared by the asset are
   * pruned from the references tree, and skill dirs whose SKILL.md still claims this asset's managedByPlugin owner
   * but whose id the owner no longer declares this session (rename/retire residue, e.g. swarm-collab -> swarm) are
   * removed—otherwise retired content keeps serving stale manuals via load_skill forever. Active owners that now
   * declare zero skills are reconciled explicitly via `reconcileManagedOwners(activeOwners)`; disabled plugins are
   * excluded from `activeOwners` so their on-disk skill directories remain intact while hidden from the active catalog.
   *
   * Security boundary unchanged: validate skill ID, frontmatter, and all reference paths up front (invalid assets
   * write nothing); verify every directory segment along skills/<id>, references, and nested reference dirs is not a
   * symlink, resolving the skills root via realpath just like readFile; existing targets must be regular files
   * (rejecting symlinks/directories); errors other than ENOENT are rethrown. Deletions walk with lstat semantics only
   * (symlinks are unlinked, never followed) and are confined to the verified skill dir / skills root by construction.
   * Once added to managedSkillIds, normal write endpoints reject with 403.
   */
  async ensureSkill(asset: BuiltinSkillAsset, options?: EnsureSkillOptions): Promise<void> {
    assertSkillId(asset.id)
    // Validate frontmatter and references up front before creating directories or writing files.
    const owner = parseSkillFrontmatter(asset.skillMd).managedByPlugin
    const references = Object.entries(asset.references).map(([name, content]) => ({
      rel: assertSafeSkillRelativePath(`references/${name}`),
      content,
    }))
    const skillsRoot = join(this.dataDir, 'skills')
    // Create skills root if missing (initial bootstrap); if it is a dangling symlink, realpath throws ENOENT
    // and mkdir fails with EEXIST, which propagates honestly without silently bypassing.
    let rootReal: string
    try {
      rootReal = await realpath(skillsRoot)
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err
      await mkdir(skillsRoot, { recursive: true })
      rootReal = await realpath(skillsRoot)
    }
    const dir = join(rootReal, asset.id)
    // Verify before mkdir that skills/<id>, references, and nested subdirectories contain no symlinks (prevents writing
    // outside skills root); a missing segment implies nothing exists underneath it yet.
    await assertRealDirs(rootReal, join(dir, 'references'))
    for (const { rel } of references) {
      await assertRealDirs(rootReal, dirname(join(dir, rel)))
    }
    await mkdir(join(dir, 'references'), { recursive: true })
    for (const { rel } of references) {
      await mkdir(dirname(join(dir, rel)), { recursive: true })
    }
    await writeManagedFile(join(dir, 'SKILL.md'), asset.skillMd)
    for (const { rel, content } of references) {
      await writeManagedFile(join(dir, rel), content)
    }
    // Reconcile to the declared asset (see method JSDoc): prune retired references, sweep retired same-owner dirs.
    await pruneUndeclaredReferenceFiles(join(dir, 'references'), new Set(references.map((r) => r.rel)))
    if (owner !== undefined) {
      const declared = this.managedIdsByOwner.get(owner) ?? new Set<string>()
      declared.add(asset.id)
      this.managedIdsByOwner.set(owner, declared)
      if (!options?.deferOwnerReconcile) {
        await removeRetiredManagedSkillDirsForOwners(rootReal, new Set([owner]), this.managedIdsByOwner)
      }
    }
    this.managedSkillIds.add(asset.id)
  }

  /**
   * Reconcile on-disk managed skill directories for the given active owners: any skill directory whose
   * `SKILL.md` frontmatter claims `managedByPlugin` matching one of `activeOwners` that was not declared via
   * `ensureSkill` in this process (including active owners that declared zero skills).
   *
   * Owners NOT included in `activeOwners` (e.g. disabled or failed-to-start plugins), user-authored skills without
   * `managedByPlugin`, symlinked directories/SKILL.md files, and unparseable frontmatter are left untouched.
   */
  async reconcileManagedOwners(activeOwners: Iterable<string>): Promise<void> {
    const owners = new Set<string>()
    for (const owner of activeOwners) {
      if (typeof owner === 'string' && owner.trim() !== '') {
        owners.add(owner)
      }
    }
    if (owners.size === 0) return
    const skillsRoot = join(this.dataDir, 'skills')
    const rootReal = await realpath(skillsRoot).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (rootReal === undefined) return
    await removeRetiredManagedSkillDirsForOwners(rootReal, owners, this.managedIdsByOwner)
  }

  /** Read-only guard for managed skills (403 managed_skill_readonly): source version at startup is the sole
   * authority. Tracked in memory—rebuilt by ensureSkill on each startup without DB persistence
   * (user-created skills do not go through ensureSkill and are unaffected). */
  private assertSkillMutable(skillId: string): void {
    if (this.managedSkillIds.has(skillId)) {
      throw new HelmxError(
        'managed_skill_readonly',
        `skill '${skillId}' is a managed system skill asset and cannot be written or deleted via normal APIs (synced from source at startup)`,
        403,
        { skillId },
      )
    }
  }

  /** Resolve the real path of the skills root (throws if missing; never lenient). */
  private async requireSkillsRoot(): Promise<string> {
    const skillsRoot = join(this.dataDir, 'skills')
    try {
      return await realpath(skillsRoot)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        throw new FileNotFoundError(skillsRoot)
      }
      throw err
    }
  }

  /** Summarize within a single root: returns undefined if the skill directory is missing (entry skipped in catalog)
   * or SKILL.md is missing (FileNotFoundError); malformed frontmatter is rethrown (callers decide strict throw for dataDir
   * vs skip policy for external roots). External roots forcibly strip managedByPlugin—shared roots may only host normal
   * shared skills and never let third-party files masquerade as host-managed plugin skills. */
  private async summarizeInRoot(skillsRoot: string, id: string, source?: 'agents'): Promise<SkillSummary | undefined> {
    const skillMd = await this.readFileInRoot(skillsRoot, id, 'SKILL.md').catch((err: unknown) => {
      if (err instanceof FileNotFoundError) return undefined
      throw err
    })
    if (skillMd === undefined) return undefined
    const { name, description, managedByPlugin } = parseSkillFrontmatter(skillMd)
    const references = await collectFiles(join(skillsRoot, id))
    return {
      id,
      name: name || id,
      ...(description !== '' ? { description } : {}),
      ...(source === undefined && managedByPlugin !== undefined ? { managedByPlugin } : {}),
      references,
      ...(source !== undefined ? { source } : {}),
    }
  }
}

/**
 * Verify layer-by-layer that every existing segment from ancestor down to dir is a real directory (not a symlink);
 * a missing segment means nothing can exist under it yet, so stop and treat it as pending creation.
 * Prevents bootstrapping into targets outside the skills root when skills/<id> or references (including nested subdirs) is a symlink.
 */
async function assertRealDirs(ancestor: string, dir: string): Promise<void> {
  let current = ancestor
  for (const seg of relative(ancestor, dir).split(sep)) {
    if (seg === '') continue
    current = join(current, seg)
    const st = await lstat(current).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (st === undefined) return
    if (st.isSymbolicLink()) {
      throw new Error(`refusing to write through symlink directory: ${current}`)
    }
    if (!st.isDirectory()) {
      throw new Error(`path segment is not a directory; refusing bootstrap: ${current}`)
    }
  }
}

/** Managed overwrite write: writes atomically if missing; if present, must be a regular file (symlinks/directories
 * are rejected). Skips writing when contents match the declaration (avoids atomic rename jitter in AssetWatcher),
 * otherwise atomically overwrites with the source version; rethrows any other IO errors. */
async function writeManagedFile(path: string, content: string): Promise<void> {
  const existing = await lstat(path).catch((err: unknown) => {
    if ((err as { code?: string }).code === 'ENOENT') return undefined
    throw err
  })
  if (existing === undefined) {
    await atomicWriteFile(path, content)
    return
  }
  if (!existing.isFile()) {
    throw new Error(`target already exists and is not a regular file; refusing write: ${path}`)
  }
  const current = await readFile(path, 'utf8').catch((err: unknown) => {
    if ((err as { code?: string }).code === 'ENOENT') return undefined
    throw err
  })
  if (current === content) return
  await atomicWriteFile(path, content)
}

/** Prune reference files under a managed skill's (already symlink-verified) references tree that the asset no longer
 * declares: retired references would otherwise linger forever and keep serving stale content through load_skill.
 * Dirents carry lstat semantics, so symlinks (file or directory) are unlinked directly and never followed; nested
 * directories left empty are pruned bottom-up, while the references root itself is kept (ensureSkill owns its
 * creation). Deletion stays inside the verified tree by construction (readdir names cannot be absolute or `..`). */
async function pruneUndeclaredReferenceFiles(referencesDir: string, declared: ReadonlySet<string>): Promise<void> {
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (entries === undefined) return
    for (const entry of entries) {
      const rel = `${prefix}/${entry.name}`
      const target = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(target, rel)
        await rmdir(target).catch((err: unknown) => {
          const code = (err as { code?: string }).code
          if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw err
        })
        continue
      }
      if (!declared.has(rel)) await rm(target, { force: true })
    }
  }
  // Paths are skill-dir-relative ('references/<name>'), matching the asset's declared reference keys.
  await walk(referencesDir, 'references')
}

/** Remove skill dirs whose `SKILL.md` frontmatter claims `managedByPlugin` for any owner in `owners`, when the dir's
 * skill id is not in that owner's declared set for this session (rename/retire residue, including active owners that
 * now declare zero skills). Symlinked dirs, symlinked `SKILL.md` files, and dirs without attributable frontmatter
 * (missing SKILL.md, owners outside `owners`, unparseable frontmatter) are skipped—only unambiguous residue of active
 * reconciled owners is deleted. `fs.rm` with recursive+force unlinks nested symlinks without following, keeping
 * deletion lstat-safe. */
async function removeRetiredManagedSkillDirsForOwners(
  skillsRoot: string,
  owners: ReadonlySet<string>,
  declaredByOwner: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<void> {
  if (owners.size === 0) return
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch((err: unknown) => {
    if ((err as { code?: string }).code === 'ENOENT') return undefined
    throw err
  })
  if (entries === undefined) return
  for (const entry of entries) {
    // Dirent.isDirectory() is lstat-based: symlinked dirs (and files) fall through here and are never touched.
    if (!entry.isDirectory()) continue
    const skillMdPath = join(skillsRoot, entry.name, 'SKILL.md')
    const skillMdStat = await lstat(skillMdPath).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    // Refuse to follow symlinked SKILL.md files during retirement scanning.
    if (skillMdStat === undefined || !skillMdStat.isFile()) continue
    const skillMd = await readFile(skillMdPath, 'utf8').catch((err: unknown) => {
      if ((err as { code?: string }).code === 'ENOENT') return undefined
      throw err
    })
    if (skillMd === undefined) continue
    let claimed: string | undefined
    try {
      claimed = parseSkillFrontmatter(skillMd).managedByPlugin
    } catch {
      continue // unattributable frontmatter is not ours to delete
    }
    if (claimed === undefined || !owners.has(claimed)) continue
    const declared = declaredByOwner.get(claimed)
    if (declared !== undefined && declared.has(entry.name)) continue
    await rm(join(skillsRoot, entry.name), { recursive: true, force: true })
  }
}
