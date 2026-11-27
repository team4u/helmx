import type * as ts from 'typescript'

export type UiHygieneRule = 'no-native-select' | 'no-search-input' | 'no-ui-emoji' | 'no-raw-control-class'

export interface UiHygieneViolation {
  file: string
  line: number
  rule: UiHygieneRule
  message: string
}

export interface UiHygieneReport {
  violations: UiHygieneViolation[]
}

export declare const UI_EMOJI_PATTERN: RegExp

export declare function analyzeUiSource(
  tsModule: typeof ts,
  filePath: string,
  source: string,
  existingSourceFile?: ts.SourceFile,
): UiHygieneReport

export declare function collectSourceUiFiles(repoRoot: string): string[]
