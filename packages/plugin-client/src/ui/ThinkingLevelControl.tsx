/**
 * Thinking level segmented control (host + plugin shared, presentational).
 *
 * Renders plain entity levels in a segmented control built on the package Tabs
 * primitive — no model semantics live here: the caller owns the level list
 * (from the model catalog), the effective value and what applying means. What
 * you see is what you get: an empty or invalid value falls back safely to a
 * level the list actually contains; an empty list renders nothing.
 *
 * Zero-Emoji rule applies; the default accessible name resolves from the
 * shared UI locale (an explicit aria-label prop wins). SSR safe (Tabs renders
 * inline, no portal).
 *
 * This file only exports components and TS types (Fast Refresh friendly).
 */
import type { ReactNode } from 'react'
import { usePluginTranslator } from '../i18n.js'
import { uiCopy } from '../ui-copy.js'
import { Tabs, TabsList, TabsTrigger } from './Tabs.js'

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

export interface ThinkingLevelControlProps {
  /** Selected value: the concrete level actually in effect. */
  value: string
  /** Thinking levels the target model supports (render nothing when empty). */
  levels: ReadonlyArray<string>
  /** Selected level change. */
  onPick: (level: string) => void
  disabled?: boolean
  /** Extra classes for the segmented control row (screen-local layout tweaks). */
  className?: string
  'aria-label'?: string
}

export function ThinkingLevelControl(props: ThinkingLevelControlProps): ReactNode {
  const t = usePluginTranslator()
  const {
    value,
    levels,
    onPick,
    disabled = false,
    className,
    'aria-label': ariaLabel,
  } = props
  if (levels.length === 0) return null
  const safeValue = levels.includes(value) ? value : (levels[0] ?? '')
  // Single pick channel: the Tabs root onValueChange (mouse clicks route
  // through the SDK trigger context; keyboard activation goes through the
  // root). A per-trigger onClick would double-fire onPick for every
  // value-changing click.
  return (
    <Tabs value={safeValue} onValueChange={onPick} variant="segmented" style={{ width: '100%' }}>
      <TabsList className={joinClass('segmented-control', className)} aria-label={ariaLabel ?? t(uiCopy.thinkingLevel)}>
        {levels.map((level) => (
          <TabsTrigger key={level} value={level} disabled={disabled}>
            {level}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}
