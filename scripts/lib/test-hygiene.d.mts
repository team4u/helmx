import type path from 'node:path'
import type * as ts from 'typescript'

export interface HygieneViolation {
  file: string
  line: number
  rule: 'timeout-missing' | 'skip-without-reason' | 'suite-timeout-env' | 'unsafe-dom-assert' | 'hook-timeout-missing'
  message: string
}

export interface HygieneReport {
  violations: HygieneViolation[]
  stats: { testCalls: number; skipCalls: number; todoCalls: number; subtestCalls: number; hookCalls: number }
}

export declare function parseTestSourceFile(tsModule: typeof ts, filePath: string, source: string): ts.SourceFile
export declare function analyzeTestSource(
  tsModule: typeof ts,
  filePath: string,
  source: string,
  existingSourceFile?: ts.SourceFile,
): HygieneReport
export declare function collectAllTestFiles(repoRoot: string): string[]
export declare function toPosixPath(filePath: string): string
export declare function resolveInRepoRelativePath(
  repoRoot: string,
  filePath: string,
  cwd?: string,
  pathImpl?: Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute'>,
): string | null
export declare function packageOfTestPath(rel: string): string | null
export declare function isCrossPackageTestHelperImport(rel: string, specifier: string): boolean
export declare function isTestFilePath(file: string): boolean
