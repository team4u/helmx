export interface HoverGateViolation {
  line: number
  selector: string
}

export declare function findUngatedHoverRules(css: string): HoverGateViolation[]
export declare function collectSourceCssFiles(repoRoot: string): string[]
