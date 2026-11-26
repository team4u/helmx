/**
 * Release notes assembly, shared by two consumers:
 * - release.yml's notes job: `node scripts/lib/release-notes.mjs --tag v0.1.2 --out <file>` with
 *   the three honest artifact status lines from the npm-publish job passed via
 *   HELMX_RELEASE_{PAYLOAD,CLI,NODE}_STATUS env vars;
 * - scripts/release.mjs (local orchestration): imports commitSubjectsSince()/resolvePreviousTag()
 *   and curated-changelog helpers to preview/write CHANGELOG.md before tagging.
 *
 * Honesty constraints: the artifact status section renders the npm-publish job's actual outputs
 * verbatim (published / skipped-as-placeholder / did-not-complete); this module never fabricates
 * a publish result. For the changelog section, when CHANGELOG.md already carries a curated section
 * matching the release tag (`## vX.Y.Z (YYYY-MM-DD)`), that exact section is reused so GitHub
 * Release notes and the in-app offline changelog stay aligned; otherwise it falls back to commit
 * subjects between the previous tag and the release commit (with chore(release) and merge
 * commits filtered out).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// merge 提交由 `git log --no-merges` 按结构排除：英文默认标题、中文 `merge:` / `merge(x):`、
// 以及 `fix:` / `feat:` 等普通标题的真 merge 一并覆盖，不依赖标题约定；
// chore(release) 是普通提交、没有结构特征，只能按标题识别。
const FILTERED_SUBJECT = [/^chore\(release\):/];
const CHANGELOG_SECTION_PATTERN = /^## v(\d+\.\d+\.\d+(?:[-+][\w.-]+)?) \((\d{4}-\d{2}-\d{2})\)\s*$/;

/** Run git in the current working directory, returning stdout; throws with stderr on failure. */
function runGit(args) {
  const res = spawnSync('git', args, { encoding: 'utf-8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${res.status}): ${res.stderr?.trim() || '(no stderr)'}`);
  }
  return res.stdout;
}

/** Best-effort previous tag reachable from revSpec (null when none exists yet). */
export function resolvePreviousTag(revSpec) {
  const res = spawnSync('git', ['describe', '--tags', '--abbrev=0', revSpec], { encoding: 'utf-8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

/** Commit subjects in baseRef..HEAD as markdown list items; noise commits filtered out. */
export function commitSubjectsSince(baseRef) {
  const subjects = runGit(['log', '--no-merges', `${baseRef}..HEAD`, '--pretty=format:%s'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((subject) => !FILTERED_SUBJECT.some((re) => re.test(subject)));
  return subjects.map((subject) => `- ${subject}`).join('\n');
}

/**
 * Extract one version's section from CHANGELOG.md markdown using the exact heading contract
 * shared with Hub's offline changelog parser (`## vX.Y.Z (YYYY-MM-DD)`).
 */
export function extractChangelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const match = CHANGELOG_SECTION_PATTERN.exec(line);
    if (match !== null) {
      if (current !== null && current.version === version) {
        return { version: current.version, date: current.date, body: current.body.join('\n').trim() };
      }
      current = { version: match[1], date: match[2], body: [] };
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  if (current !== null && current.version === version) {
    return { version: current.version, date: current.date, body: current.body.join('\n').trim() };
  }
  return null;
}

/** Read and extract one version's section from disk; returns null when the file or section is absent. */
export function readChangelogSection(changelogPath, version) {
  if (!changelogPath || !existsSync(changelogPath)) return null;
  return extractChangelogSection(readFileSync(changelogPath, 'utf8'), version);
}

/**
 * Validate and normalize curated release notes input (e.g. from `--notes-file`):
 * allows an optional leading `## v<targetVersion> (YYYY-MM-DD)` heading (stripped so
 * `prependChangelogSection` writes a single heading), rejects mismatched or nested version
 * headings, and refuses empty bodies.
 */
export function normalizeReleaseNotesInput(raw, targetVersion) {
  const normalized = raw.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    throw new Error('release notes 内容为空，拒绝写入空的变更日志');
  }
  const lines = normalized.split('\n');
  const firstMatch = CHANGELOG_SECTION_PATTERN.exec(lines[0]);
  let bodyLines = lines;
  if (firstMatch !== null) {
    if (firstMatch[1] !== targetVersion) {
      throw new Error(`notes 文件标题版本 v${firstMatch[1]} 与目标版本 v${targetVersion} 不一致`);
    }
    bodyLines = lines.slice(1);
  }
  for (const line of bodyLines) {
    if (CHANGELOG_SECTION_PATTERN.test(line)) {
      throw new Error(`notes 正文不得包含额外版本标题行: ${line}`);
    }
  }
  const body = bodyLines.join('\n').trim();
  if (!body) {
    throw new Error('release notes 标题后正文为空，拒绝写入空的变更日志');
  }
  return body;
}

/**
 * Assemble the full release notes body. When CHANGELOG.md already has a curated section for
 * `tag`, reuse its body verbatim; otherwise fall back to commit subjects since `prevTag`
 * (or state first release when `prevTag` is null). Pass `changelogPath: null` to bypass
 * CHANGELOG.md lookup explicitly.
 */
export function assembleReleaseNotes({ tag, prevTag, payloadStatus, cliStatus, nodeStatus, changelogPath }) {
  if (!/^v\d+\.\d+\.\d+/.test(tag)) {
    throw new Error(`tag must look like v<semver>, got: ${tag}`);
  }
  for (const [label, value] of [
    ['payload', payloadStatus],
    ['cli', cliStatus],
    ['node', nodeStatus],
  ]) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`missing ${label} artifact status line (HELMX_RELEASE_${label.toUpperCase()}_STATUS) — refusing to assemble notes without the npm-publish job's actual outputs`);
    }
  }
  const version = tag.slice(1);
  const resolvedChangelogPath = changelogPath === undefined ? path.resolve(process.cwd(), 'CHANGELOG.md') : changelogPath;
  const curated = resolvedChangelogPath ? readChangelogSection(resolvedChangelogPath, version) : null;
  let changelogSection;
  if (curated && curated.body.trim() !== '') {
    changelogSection = curated.body;
  } else {
    const changelog = prevTag ? commitSubjectsSince(prevTag) : '';
    changelogSection = prevTag
      ? changelog || '-（上一版本以来无可列出的提交）'
      : '-（首次发布）';
  }
  return [
    `## 变更明细（${prevTag ? `${prevTag}..${tag}` : '首次发布'}）`,
    '',
    changelogSection,
    '',
    '## 制品发布状态',
    '',
    '> 由本次 release.yml 各作业实际输出渲染（绝不伪称已发布）。',
    '',
    `- Hub payload：${payloadStatus.trim()}`,
    `- CLI：${cliStatus.trim()}`,
    `- 节点守护进程：${nodeStatus.trim()}`,
    '',
  ].join('\n');
}

/**
 * Prepend one version section to the repo's CHANGELOG.md (the shipped installed-version
 * changelog): `## vX.Y.Z (date)` + curated markdown or the filtered commit list.
 * Creates the file (with its header) when absent; refuses to prepend a duplicate version.
 */
export function prependChangelogSection({ version, date, subjects, changelogPath }) {
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`version must look like semver, got: ${version}`);
  }
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`date must be YYYY-MM-DD, got: ${date}`);
  }
  const body = subjects.trim() !== '' ? subjects.trim() : '-（无可列出的提交）';
  const heading = `## v${version} (${date})`;
  const existing = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '# Changelog\n\n';
  if (!existing.startsWith('# Changelog')) {
    throw new Error(`${changelogPath} does not start with the "# Changelog" header; refusing to prepend`);
  }
  if (extractChangelogSection(existing, version) !== null) {
    throw new Error(`CHANGELOG.md already has a section for v${version}; refusing to prepend a duplicate`);
  }
  const rest = existing.slice('# Changelog\n'.length).replace(/^\s+/, '');
  const next = `# Changelog\n\n${heading}\n\n${body}\n\n${rest}`;
  writeFileSync(changelogPath, next.endsWith('\n') ? next : `${next}\n`);
}

function printHelp() {
  console.log(`
用法: node scripts/lib/release-notes.mjs --tag <v版本号> --out <文件路径>

环境变量（必填，来自 release.yml notes 作业注入的 npm-publish 作业输出）:
  HELMX_RELEASE_PAYLOAD_STATUS  Hub payload 制品的发布状态行
  HELMX_RELEASE_CLI_STATUS      CLI 制品的发布状态行
  HELMX_RELEASE_NODE_STATUS     节点守护进程制品的发布状态行

说明: 变更明细取上一 tag 至本次 tag 的提交列表（过滤 chore(release) 与 merge 提交），
制品状态行原样渲染 npm-publish 作业的真实输出，不编造发布结果。
`);
}

function main() {
  const args = process.argv.slice(2);
  let tag = '';
  let out = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag' && args[i + 1]) tag = args[++i];
    else if (args[i] === '--out' && args[i + 1]) out = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      printHelp();
      process.exit(0);
    } else {
      console.error(`未知参数: ${args[i]}（--help 查看用法）`);
      process.exit(1);
    }
  }
  if (!tag || !out) {
    console.error('需要 --tag <v版本号> 与 --out <文件路径>（--help 查看用法）');
    process.exit(1);
  }
  // The workflow checks out the tagged commit, so the previous tag resolves from its parent;
  // a failure here (first release) degrades to the "first release" changelog section.
  const prevTag = resolvePreviousTag('HEAD^');
  const notes = assembleReleaseNotes({
    tag,
    prevTag,
    payloadStatus: process.env.HELMX_RELEASE_PAYLOAD_STATUS,
    cliStatus: process.env.HELMX_RELEASE_CLI_STATUS,
    nodeStatus: process.env.HELMX_RELEASE_NODE_STATUS,
  });
  writeFileSync(path.resolve(process.cwd(), out), notes);
  console.log(`[release-notes] assembled ${out} (${prevTag ? `${prevTag}..${tag}` : '首次发布'}, ${notes.length} bytes)`);
}

// CLI entry only when invoked directly; the functions above stay importable for scripts/release.mjs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`[release-notes] 装配失败: ${err.message}`);
    process.exit(1);
  }
}
