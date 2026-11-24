/**
 * Inline raw tool-call details block for conversation-embedded tool traces
 * (shared SDK primitive, exported by @helmx/plugin-client): a collapsible
 * <details> rendering the raw call input / output as read-only code blocks
 * plus an optional "open full artifact" button (ctx.openArtifact forwards to
 * the host artifact previewer). Pure presentation — zero data derivation and
 * zero business policy; callers pass raw tool input / result as-is.
 *
 * Styling reuses the host public trace vocabulary (.tool-call-details /
 * .trace-expanded-body / .trace-section-label / .code-block-pre); click and
 * keydown stop propagation so the block never activates the surrounding trace
 * row button. Component & type exports only (Fast Refresh compliant).
 */
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { usePluginContext } from './plugin-context.js'
import { usePluginTranslator } from './i18n.js'
import { uiCopy } from './ui-copy.js'
import { Button } from './ui/Button.js'

export interface ToolCallDetailsProps {
  /** Raw input of the tool call (strings pass through, objects are pretty-printed as JSON). */
  input?: unknown
  /** Raw output of the tool call (strings pass through, objects are pretty-printed). */
  result?: unknown
  /** Artifact reference detected in the output (kernel spill marker / art_ prefix); empty string renders no button. */
  artifactRef?: string
  /** Whether the collapsible `<details>` block starts expanded (defaults to false). */
  defaultOpen?: boolean
}

/** Strings pass through; objects pretty-print as JSON; unserializable values fall back to String(). */
function stringifyPretty(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function ToolCallDetails({ input, result, artifactRef, defaultOpen = false }: ToolCallDetailsProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const [open, setOpen] = useState(defaultOpen)
  const inputJson = useMemo(() => stringifyPretty(input), [input])
  const resultText = useMemo(() => stringifyPretty(result), [result])

  return (
    <details
      className="tool-call-details"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <summary>{t(uiCopy.callDetails)}</summary>
      <div className="trace-expanded-body selectable">
        {inputJson !== undefined ? (
          <div>
            <div className="trace-section-label">{t(uiCopy.detailsInput)}</div>
            <pre className="code-block-pre"><code>{inputJson}</code></pre>
          </div>
        ) : null}
        {resultText !== undefined ? (
          <div>
            <div className="trace-section-label">{t(uiCopy.detailsOutput)}</div>
            <pre className="code-block-pre"><code>{resultText}</code></pre>
          </div>
        ) : null}
        {artifactRef !== undefined && artifactRef !== '' ? (
          <Button size="xs" onClick={() => ctx.openArtifact(artifactRef)}>
            {t(uiCopy.openFullArtifact)} #{artifactRef}
          </Button>
        ) : null}
      </div>
    </details>
  )
}
