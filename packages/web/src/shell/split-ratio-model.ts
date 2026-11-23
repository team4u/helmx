/**
 * Pure persistence and clamping model for the desktop split-pane divider ratio.
 * Ratio represents the primary pane's fraction of `.helmx-panes` width (0.28..0.72).
 */
export const SPLIT_RATIO_STORAGE_KEY = 'helmx:split-ratio'
export const DEFAULT_SPLIT_RATIO = 0.5
export const MIN_SPLIT_RATIO = 0.28
export const MAX_SPLIT_RATIO = 0.72
export const SPLIT_RATIO_STEP = 0.05

/** Clamps a raw split ratio into `[MIN_SPLIT_RATIO, MAX_SPLIT_RATIO]`; non-finite inputs fall back to 0.5. */
export function clampSplitRatio(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_SPLIT_RATIO
  const clamped = Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, raw))
  return Math.round(clamped * 10_000) / 10_000
}

/** Adjusts the current ratio by `delta`, clamped to safe bounds. */
export function stepSplitRatio(current: number, delta: number): number {
  return clampSplitRatio(current + delta)
}

/** Reads the persisted desktop split ratio safely (SSR / private-mode tolerant). */
export function loadSplitRatio(storage?: Pick<Storage, 'getItem'> | null): number {
  try {
    const store = storage === undefined
      ? (typeof window !== 'undefined' ? window.localStorage : null)
      : storage
    if (!store) return DEFAULT_SPLIT_RATIO
    const raw = store.getItem(SPLIT_RATIO_STORAGE_KEY)
    if (raw === null || raw.trim() === '') return DEFAULT_SPLIT_RATIO
    return clampSplitRatio(Number(raw))
  } catch {
    return DEFAULT_SPLIT_RATIO
  }
}

/** Clamps and persists the desktop split ratio safely. */
export function saveSplitRatio(ratio: number, storage?: Pick<Storage, 'setItem'> | null): number {
  const clamped = clampSplitRatio(ratio)
  try {
    const store = storage === undefined
      ? (typeof window !== 'undefined' ? window.localStorage : null)
      : storage
    store?.setItem(SPLIT_RATIO_STORAGE_KEY, String(clamped))
  } catch {
    // Ignore storage quota or private-mode access errors.
  }
  return clamped
}
