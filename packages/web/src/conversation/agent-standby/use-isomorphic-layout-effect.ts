/**
 * Layout effect that degrades to a passive effect under SSR (no `window`): committing ref
 * state before paint where a DOM exists, without the SSR layout-effect warning elsewhere.
 */
import { useEffect, useLayoutEffect } from 'react'

export const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect
