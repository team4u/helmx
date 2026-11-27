/**
 * Layout and display primitives (13 components) for builtin:json-render (Fast Refresh compliant).
 */
import { useId, useState } from 'react'
import {
  Badge,
  Button,
  Callout,
  Card,
  HelmxIcon,
  KvGrid,
  MarkdownText,
  Stack,
  type BadgeTone,
  type ButtonVariant,
  type CalloutProps,
} from '@helmx/plugin-client'
import { evaluateSpecValue, type EvalScope } from './evaluator.ts'
import {
  JSON_RENDER_ACTION_LABEL_FALLBACK,
  JSON_RENDER_TABLE_ACTIONS_HEADER,
  JSON_RENDER_TABLE_EMPTY,
  jsonRenderStepFallbackTitle,
} from './copy.ts'
import { formatSpecText, resolveKeyValueItems, type NormalizedSpecNode } from './spec-normalize.ts'
import { asPlainObject, bool, evalIn, ownProp, str, tr, type SpecRenderContext } from './primitive-context.ts'

export function StackImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const direction = str(evalIn(node.props['direction'], ctx.scope), 'vertical')
  const gap = evalIn<unknown>(node.props['gap'], ctx.scope)
  const style = typeof gap === 'number' && Number.isFinite(gap) ? { gap } : undefined
  return (
    <Stack direction={direction === 'horizontal' ? 'horizontal' : 'vertical'} gap="md" style={style}>
      {ctx.renderChildren(node.children)}
    </Stack>
  )
}

export function CardImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const title = str(evalIn(node.props['title'], ctx.scope))
  const subtitle = str(evalIn(node.props['subtitle'], ctx.scope))
  return (
    <Card title={title !== '' ? title : undefined} subtitle={subtitle !== '' ? subtitle : undefined}>
      {ctx.renderChildren(node.children)}
    </Card>
  )
}

const TEXT_VARIANT_CLASS: Readonly<Record<string, string>> = {
  body: '',
  title: 'jr-text-title',
  muted: 'jr-text-muted',
  mono: 'jr-text-mono',
}

export function TextImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const variant = str(evalIn(node.props['variant'], ctx.scope), 'body')
  const rawText = evalIn<unknown>(node.props['text'] ?? node.props['content'], ctx.scope)
  const lineClamp = evalIn<unknown>(node.props['lineClamp'], ctx.scope)
  const text = typeof rawText === 'string' ? rawText : formatSpecText(rawText)
  const variantClass = ownProp(TEXT_VARIANT_CLASS, variant) ?? ''
  const hasClamp = typeof lineClamp === 'number' && lineClamp > 0
  const className = [variantClass, hasClamp ? 'jr-text-clamp' : ''].filter(Boolean).join(' ')
  return (
    <div
      className={className || undefined}
      style={hasClamp ? { WebkitLineClamp: lineClamp } : undefined}
    >
      {text}
    </div>
  )
}

const VALID_BADGE_TONES: Readonly<Record<string, BadgeTone>> = {
  neutral: 'neutral',
  accent: 'accent',
  ok: 'ok',
  warn: 'warn',
  err: 'err',
}

export function BadgeImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const tone = str(evalIn(node.props['tone'], ctx.scope), 'neutral')
  const icon = str(evalIn(node.props['icon'], ctx.scope))
  const rawText = evalIn<unknown>(node.props['text'] ?? node.props['label'], ctx.scope)
  const validTone: BadgeTone = ownProp(VALID_BADGE_TONES, tone) ?? 'neutral'
  return (
    <Badge tone={validTone} icon={icon !== '' ? icon : undefined}>
      {formatSpecText(rawText)}
    </Badge>
  )
}

export function MarkdownImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const rawText = evalIn<unknown>(node.props['text'] ?? node.props['content'], ctx.scope)
  const text = typeof rawText === 'string' ? rawText : formatSpecText(rawText)
  return (
    <div className="jr-markdown msg-ai-body">
      <MarkdownText text={text} />
    </div>
  )
}

export function MetricGridImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const cols = evalIn<unknown>(node.props['cols'], ctx.scope)
  const style =
    typeof cols === 'number' && cols > 0
      ? { gridTemplateColumns: `repeat(${Math.min(6, Math.floor(cols))}, minmax(0, 1fr))` }
      : undefined
  return (
    <div className="jr-metric-grid" style={style}>
      {ctx.renderChildren(node.children)}
    </div>
  )
}

const METRIC_TONE_CLASS: Readonly<Record<string, string>> = {
  ok: 'jr-metric-tone-ok',
  warn: 'jr-metric-tone-warn',
  err: 'jr-metric-tone-err',
  accent: 'jr-metric-tone-accent',
}

export function MetricCardImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const rawValue = evalIn<unknown>(node.props['value'], ctx.scope)
  const hint = str(evalIn(node.props['hint'], ctx.scope))
  const tone = str(evalIn(node.props['tone'], ctx.scope))
  const toneClass = ownProp(METRIC_TONE_CLASS, tone)
  return (
    <div className="jr-metric-card">
      <div className="jr-metric-label">{label}</div>
      <div className={toneClass !== undefined ? `jr-metric-value ${toneClass}` : 'jr-metric-value'}>
        {formatSpecText(rawValue)}
      </div>
      {hint !== '' && <div className="jr-metric-label">{hint}</div>}
    </div>
  )
}

export function KeyValueListImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  // Keep pointer keys ('/$docs/...') as raw templates until resolution here.
  const items = resolveKeyValueItems(node.props['items'], (expr) => evaluateSpecValue(expr, ctx.scope))
  return <KvGrid items={items.map((item) => ({ key: item.label, value: item.value }))} />
}

const VALID_CALLOUT_TONES: Readonly<Record<string, NonNullable<CalloutProps['tone']>>> = {
  info: 'info',
  warn: 'warn',
  err: 'err',
  ok: 'ok',
}

export function CalloutImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const tone = str(evalIn(node.props['tone'], ctx.scope), 'info')
  const title = str(evalIn(node.props['title'], ctx.scope))
  const text = str(evalIn(node.props['text'], ctx.scope))
  const validTone = ownProp(VALID_CALLOUT_TONES, tone) ?? 'info'
  return (
    <Callout tone={validTone} title={title !== '' ? title : undefined}>
      {text !== '' && <div>{text}</div>}
      {ctx.renderChildren(node.children)}
    </Callout>
  )
}

const STEP_STATUS_META: Record<string, { icon: string; tone: BadgeTone }> = {
  pending: { icon: 'circle', tone: 'neutral' },
  running: { icon: 'loader', tone: 'accent' },
  done: { icon: 'check', tone: 'ok' },
  failed: { icon: 'x', tone: 'err' },
}

export function StepsImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const rawItems = evalIn<unknown>(node.props['items'] ?? node.props['steps'], ctx.scope)
  const items = Array.isArray(rawItems)
    ? (rawItems as Array<Record<string, unknown>>).map((raw, i) => ({
        title: str(raw['title'] ?? raw['label'], jsonRenderStepFallbackTitle(i + 1, ctx.locale)),
        detail: str(raw['detail']),
        status: str(raw['status'], 'pending'),
      }))
    : []
  return (
    <div className="list">
      {items.map((item, i) => {
        const meta = ownProp(STEP_STATUS_META, item.status) ?? STEP_STATUS_META['pending']!
        return (
          <div key={i} className="row">
            <div className="jr-step-main">
              <Badge
                tone={meta.tone}
                icon={<HelmxIcon name={meta.icon} size={10} className={item.status === 'running' ? 'spin-slow' : undefined} />}
              />
              <div className="jr-step-text">
                <span className="jr-step-title">{item.title}</span>
                {item.detail !== '' && <span className="jr-step-detail">{item.detail}</span>}
              </div>
            </div>
            <span className="jr-metric-label tabular-nums">
              {i + 1}/{items.length}
            </span>
          </div>
        )
      })}
    </div>
  )
}

export function BarListImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const rawItems = evalIn<unknown>(node.props['items'], ctx.scope)
  const items = Array.isArray(rawItems)
    ? (rawItems as Array<Record<string, unknown>>).map((raw) => ({
        label: str(raw['label'] ?? raw['name']),
        value: Number(raw['value'] ?? 0),
        max: raw['max'] !== undefined ? Number(raw['max']) : undefined,
      }))
    : []
  const globalMax = Math.max(1, ...items.map((it) => it.max ?? it.value))
  return (
    <Stack gap="xs" className="jr-bar-list">
      {items.map((item, i) => {
        const ratio = Math.max(0, Math.min(1, item.value / globalMax))
        return (
          <div key={i} className="jr-bar-row">
            <span className="jr-bar-label">{item.label}</span>
            <div className="jr-bar-track">
              <div className="jr-bar-fill" style={{ width: `${ratio * 100}%` }} />
            </div>
            <span className="jr-bar-value tabular-nums mono">{item.value}</span>
          </div>
        )
      })}
    </Stack>
  )
}

export function TableImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const tableId = useId()
  const rawColumns = evalIn<unknown>(node.props['columns'], ctx.scope)
  const columns = Array.isArray(rawColumns)
    ? (rawColumns as Array<Record<string, unknown>>).map((c) => ({
        key: str(c['key']),
        label: str(c['label'] ?? c['key']),
      }))
    : []
  const rawRows = evalIn<unknown>(node.props['rows'], ctx.scope)
  const rows: Array<Record<string, unknown>> = Array.isArray(rawRows)
    ? rawRows.map(asPlainObject).filter((r): r is Record<string, unknown> => r !== null)
    : []
  // Preserve raw rowActions templates so {$row.xxx} binds per row at render/click time.
  const rawRowActions = node.props['rowActions']
  const rowActions = Array.isArray(rawRowActions)
    ? rawRowActions.map(asPlainObject).filter((ra): ra is Record<string, unknown> => ra !== null)
    : []
  const empty = str(evalIn(node.props['empty'], ctx.scope))

  const columnKeys = columns.length > 0 ? columns.map((c) => c.key) : rows[0] !== undefined ? Object.keys(rows[0]!) : []
  const headerLabels = columns.length > 0 ? columns.map((c) => c.label) : columnKeys
  const colSpan = Math.max(1, columnKeys.length + (rowActions.length > 0 ? 1 : 0))

  return (
    <div className="helmx-table-wrap">
      <table className="helmx-table jr-table jr-table-selectable">
        {headerLabels.length > 0 && (
          <thead>
            <tr>
              {headerLabels.map((label, i) => (
                <th key={i}>{label}</th>
              ))}
              {rowActions.length > 0 && (
                <th className="jr-table-actions-col">{tr(ctx, JSON_RENDER_TABLE_ACTIONS_HEADER)}</th>
              )}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={colSpan} className="jr-table-empty">
                {empty !== '' ? empty : tr(ctx, JSON_RENDER_TABLE_EMPTY)}
              </td>
            </tr>
          )}
          {rows.map((row, i) => {
            const rowScope: EvalScope = { ...ctx.scope, $row: row }
            const pendingKey = `${tableId}-row-${i}`
            return (
              <tr key={i}>
                {columnKeys.map((key, j) => (
                  <td key={j}>{formatSpecText(ownProp(row, key))}</td>
                ))}
                {rowActions.length > 0 && (
                  <td className="jr-table-actions-cell">
                    <Stack direction="horizontal" gap="sm" justify="end">
                      {rowActions.map((ra, k) => (
                        <RowActionButton
                          key={k}
                          label={str(evalIn(ra['label'], rowScope), tr(ctx, JSON_RENDER_ACTION_LABEL_FALLBACK))}
                          tone={str(evalIn(ra['tone'], rowScope))}
                          pending={ctx.isPending(`${pendingKey}-${k}`)}
                          succeeded={ctx.isSucceeded?.(`${pendingKey}-${k}`) === true}
                          onClick={() => ctx.runAction(ra['action'], rowScope, `${pendingKey}-${k}`)}
                        />
                      ))}
                    </Stack>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

const VALID_ROW_ACTION_VARIANTS: Readonly<Record<string, ButtonVariant>> = {
  primary: 'primary',
  secondary: 'secondary',
  danger: 'danger',
  err: 'danger',
  accent: 'primary',
  ghost: 'ghost',
}

function RowActionButton({
  label,
  tone,
  pending,
  succeeded,
  onClick,
}: {
  label: string
  tone: string
  pending: boolean
  succeeded: boolean
  onClick: () => void
}) {
  const variant = ownProp(VALID_ROW_ACTION_VARIANTS, tone) ?? 'secondary'
  return (
    <Button variant={variant} size="sm" pending={pending} icon={succeeded ? 'check' : undefined} onClick={onClick}>
      {label}
    </Button>
  )
}

export function AccordionImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const defaultOpenRaw = node.props['defaultOpen']
  const [open, setOpen] = useState(defaultOpenRaw === undefined ? true : bool(evalIn(defaultOpenRaw, ctx.scope)))
  const title = str(evalIn(node.props['title'], ctx.scope))
  return (
    <Card className="jr-accordion">
      <button type="button" className="jr-accordion-trigger" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <HelmxIcon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        {title}
      </button>
      {open && <div className="jr-accordion-body">{ctx.renderChildren(node.children)}</div>}
    </Card>
  )
}
