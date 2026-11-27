/**
 * Git repository fixture acceleration helper (`@helmx/test-kit/git`).
 * Initialize a template repository once, then use `cpSync` to quickly replicate independent Git
 * repositories, avoiding the process overhead of spawning `git init / add / commit` per test case.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

function cleanGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env['GIT_DIR']
  delete env['GIT_WORK_TREE']
  delete env['GIT_INDEX_FILE']
  delete env['GIT_OBJECT_DIRECTORY']
  delete env['GIT_ALTERNATE_OBJECT_DIRECTORIES']
  return env
}

function runGit(dir: string, args: string[]): void {
  execFileSync('git', args, {
    cwd: dir,
    env: cleanGitEnv(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/**
 * Initialize a real Git repository at the given directory (`main` branch, isolated config, an
 * initial commit, and background maintenance disabled). Writes `README.md` by default; customize
 * the initial working tree file set via `files`.
 */
export function initGitRepo(
  dir: string,
  files: Record<string, string> = { 'README.md': '# repo\n' },
): string {
  mkdirSync(dir, { recursive: true })
  runGit(dir, ['init', '-q', '-b', 'main'])
  // `git commit` 派生分离的 `git maintenance run --auto`，它即使无事可做也会在 `.git/objects/` 下创建并释放
  // `maintenance.lock`；该锁文件与 `cloneTo` 的 `cpSync` 目录遍历竞争导致 ENOENT（CI 高并发下偶发）。
  // 关闭后不再派生后台进程；本配置写入 `.git/config`，模板 `setup` 回调中的后续 commit 与 `cloneTo`
  // 副本一并覆盖。
  runGit(dir, ['config', 'maintenance.auto', 'false'])
  runGit(dir, ['config', 'user.email', 'test@helmx.local'])
  runGit(dir, ['config', 'user.name', 'helmx-test'])
  const entries = Object.entries(files)
  for (const [relPath, content] of entries) {
    const absPath = join(dir, relPath)
    mkdirSync(dirname(absPath), { recursive: true })
    writeFileSync(absPath, content, 'utf8')
  }
  if (entries.length > 0) {
    runGit(dir, ['add', '-A'])
    runGit(dir, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
  } else {
    runGit(dir, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'init'])
  }
  return dir
}

/** Handle to a pre-initialized Git template. */
export interface GitTemplate {
  templateDir: string
  /** Instantiate the template into an independent directory via a full filesystem tree copy. */
  cloneTo: (targetDir: string) => string
  /** Remove the template temp directory. */
  cleanup: () => void
}

/**
 * Create a reusable initialized Git template repository; the optional `setup` appends custom
 * commits or files after the initial commit. Initialize once at suite level, then materialize
 * per-case repositories in milliseconds with `cloneTo`.
 */
export function createGitTemplate(
  prefix = 'helmx-git-template-',
  setup?: (dir: string) => void,
): GitTemplate {
  const templateDir = mkdtempSync(join(tmpdir(), prefix))
  try {
    initGitRepo(templateDir)
    if (setup) {
      setup(templateDir)
    }
  } catch (error) {
    rmSync(templateDir, { recursive: true, force: true })
    throw error
  }
  return {
    templateDir,
    cloneTo: (targetDir: string): string => {
      mkdirSync(dirname(targetDir), { recursive: true })
      cpSync(templateDir, targetDir, { recursive: true })
      return targetDir
    },
    cleanup: (): void => {
      rmSync(templateDir, { recursive: true, force: true })
    },
  }
}
