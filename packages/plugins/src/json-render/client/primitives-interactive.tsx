/**
 * Form, interaction, tabs, and slot primitives (8 components) for builtin:json-render (Fast Refresh compliant).
 */
import { useId, useMemo, useState } from 'react'
import {
  Button,
  Callout,
  Checkbox,
  Field,
  HelmxIcon,
  Input,
  PluginSlot,
  Select,
  Stack,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  type ButtonVariant,
} from '@helmx/plugin-client'
import {
  JSON_RENDER_ACTION_LABEL_FALLBACK,
  JSON_RENDER_BUTTON_LABEL_FALLBACK,
  JSON_RENDER_INPUT_SUBMIT,
  JSON_RENDER_INPUT_SUBMITTED,
  JSON_RENDER_INPUT_SUBMITTING,
  JSON_RENDER_SECRET_TAG,
  JSON_RENDER_SLOT_MISSING_NAME,
  JSON_RENDER_SLOT_NO_HOST,
  JSON_RENDER_SUBMITTING_HINT,
  jsonRenderTabFallbackTitle,
} from './copy.ts'
import { formatSpecText, normalizeSpec, type NormalizedSpecNode } from './spec-normalize.ts'
import { asPlainObject, bool, evalIn, ownProp, setsEqual, str, strictEquals, tr, type SpecRenderContext } from './primitive-context.ts'
import { useRemoteSyncedState } from './use-remote-synced-state.ts'

export function TextInputImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const placeholder = str(evalIn(node.props['placeholder'], ctx.scope))
  const secret = bool(evalIn(node.props['secret'], ctx.scope))
  const evaluatedValue = evalIn<unknown>(node.props['value'], ctx.scope)
  const remote = typeof evaluatedValue === 'string' ? evaluatedValue : ''
  const [text, setText] = useRemoteSyncedState(remote, strictEquals)
  const pendingKey = useId()
  const pending = ctx.isPending(pendingKey)
  const succeeded = ctx.isSucceeded?.(pendingKey) === true
  const fieldLabel =
    label !== '' ? (
      <>
        {label}
        {secret && <span className="jr-secret-tag">{tr(ctx, JSON_RENDER_SECRET_TAG)}</span>}
      </>
    ) : undefined
  return (
    <Field label={fieldLabel}>
      <Stack direction="horizontal" gap="xs" align="center">
        <Input
          size="sm"
          className="jr-input-grow"
          type={secret ? 'password' : 'text'}
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
        {node.props['action'] !== undefined && (
          <Button
            variant="secondary"
            size="sm"
            pending={pending}
            icon={succeeded ? 'check' : undefined}
            onClick={() => ctx.runAction(node.props['action'], { ...ctx.scope, $value: text }, pendingKey)}
          >
            {pending
              ? tr(ctx, JSON_RENDER_INPUT_SUBMITTING)
              : succeeded
                ? tr(ctx, JSON_RENDER_INPUT_SUBMITTED)
                : tr(ctx, JSON_RENDER_INPUT_SUBMIT)}
          </Button>
        )}
      </Stack>
    </Field>
  )
}

export function SelectImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const evaluatedValue = evalIn<unknown>(node.props['value'], ctx.scope)
  const remote = typeof evaluatedValue === 'string' ? evaluatedValue : formatSpecText(evaluatedValue)
  const [selected, setSelected] = useRemoteSyncedState(remote, strictEquals)
  const pendingKey = useId()
  const rawOptions = evalIn<unknown>(node.props['options'], ctx.scope)
  const options = Array.isArray(rawOptions)
    ? (rawOptions as Array<Record<string, unknown>>).map((o) => ({
        label: str(o['label']),
        value: str(o['value']),
      }))
    : []
  return (
    <Field label={label !== '' ? label : undefined}>
      <Select
        size="sm"
        value={selected}
        options={options}
        onChange={(e) => {
          setSelected(e.target.value)
          if (node.props['action'] !== undefined) {
            ctx.runAction(node.props['action'], { ...ctx.scope, $value: e.target.value }, pendingKey)
          }
        }}
      />
    </Field>
  )
}

export function SwitchImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const evaluated = evalIn<unknown>(node.props['value'], ctx.scope)
  const checked = typeof evaluated === 'boolean' ? evaluated : bool(evaluated)
  const pendingKey = useId()
  const pending = ctx.isPending(pendingKey)
  const toggle = () => {
    ctx.runAction(node.props['action'], { ...ctx.scope, $value: !checked }, pendingKey)
  }
  const labelContent =
    pending || label !== '' ? (
      <Stack direction="horizontal" gap="xs" align="center" inline>
        {pending && <HelmxIcon name="loader" size={12} className="spin-slow" />}
        {label !== '' ? <span>{label}</span> : null}
      </Stack>
    ) : undefined
  return (
    <Switch
      checked={checked}
      disabled={pending || node.props['action'] === undefined}
      onChange={() => toggle()}
      label={labelContent}
      aria-label={label !== '' ? label : 'Toggle'}
    />
  )
}

export function CheckboxGroupImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const rawOptions = evalIn<unknown>(node.props['options'], ctx.scope)
  const options = Array.isArray(rawOptions)
    ? (rawOptions as Array<Record<string, unknown>>).map((o) => ({
        label: str(o['label']),
        value: str(o['value']),
      }))
    : []
  const evaluatedValue = evalIn<unknown>(node.props['value'], ctx.scope)
  const remoteKey = Array.isArray(evaluatedValue)
    ? JSON.stringify([...new Set((evaluatedValue as unknown[]).map((v) => String(v)))].sort())
    : '[]'
  const remote = useMemo(() => new Set<string>(JSON.parse(remoteKey) as string[]), [remoteKey])
  const [selected, setSelected] = useRemoteSyncedState(remote, setsEqual)
  const pendingKey = useId()
  const pending = ctx.isPending(pendingKey)
  return (
    <Field label={label !== '' ? label : undefined} htmlFor={false}>
      <Stack gap="xs">
        {options.map((o) => (
          <Checkbox
            key={o.value}
            checked={selected.has(o.value)}
            label={o.label}
            onChange={(checked) => {
              const next = new Set(selected)
              if (checked) next.add(o.value)
              else next.delete(o.value)
              setSelected(next)
              if (node.props['action'] !== undefined) {
                ctx.runAction(node.props['action'], { ...ctx.scope, $value: Array.from(next) }, pendingKey)
              }
            }}
          />
        ))}
      </Stack>
      {pending && (
        <span className="jr-submitting-hint">
          <HelmxIcon name="loader" size={11} className="spin-slow" />
          {tr(ctx, JSON_RENDER_SUBMITTING_HINT)}
        </span>
      )}
    </Field>
  )
}

const VALID_BUTTON_VARIANTS: Readonly<Record<string, ButtonVariant>> = {
  primary: 'primary',
  secondary: 'secondary',
  danger: 'danger',
  ghost: 'ghost',
}

export function ButtonImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(
    evalIn(node.props['label'] ?? node.props['text'], ctx.scope),
    tr(ctx, JSON_RENDER_BUTTON_LABEL_FALLBACK),
  )
  const icon = str(evalIn(node.props['icon'], ctx.scope))
  const variant = str(evalIn(node.props['variant'], ctx.scope))
  const pendingKey = useId()
  const pending = ctx.isPending(pendingKey)
  const succeeded = ctx.isSucceeded?.(pendingKey) === true
  const resolvedVariant: ButtonVariant = ownProp(VALID_BUTTON_VARIANTS, variant) ?? 'secondary'
  return (
    <Button
      variant={resolvedVariant}
      size="sm"
      pending={pending}
      disabled={node.props['action'] === undefined}
      icon={succeeded ? 'check' : icon !== '' ? icon : undefined}
      onClick={() => ctx.runAction(node.props['action'], ctx.scope, pendingKey)}
    >
      {label}
    </Button>
  )
}

export function ActionBarImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  // Keep inline action descriptors raw so `a['action']` resolves lazily via `resolveSpecAction`.
  const actionsProp = node.props['actions']
  const rawActions = typeof actionsProp === 'string' ? evalIn<unknown>(actionsProp, ctx.scope) : actionsProp
  const actionBarId = useId()
  const actions = Array.isArray(rawActions)
    ? rawActions.map(asPlainObject).filter((a): a is Record<string, unknown> => a !== null)
    : []
  if (actions.length > 0) {
    return (
      <Stack direction="horizontal" gap="xs" wrap align="center">
        {actions.map((a, i) => {
          const label = str(evalIn(a['label'], ctx.scope), tr(ctx, JSON_RENDER_ACTION_LABEL_FALLBACK))
          const icon = str(evalIn(a['icon'], ctx.scope))
          const variant = str(evalIn(a['variant'], ctx.scope))
          const pendingKey = `${actionBarId}-${i}`
          const pending = ctx.isPending(pendingKey)
          const succeeded = ctx.isSucceeded?.(pendingKey) === true
          const resolvedVariant: ButtonVariant = ownProp(VALID_BUTTON_VARIANTS, variant) ?? 'secondary'
          return (
            <Button
              key={i}
              variant={resolvedVariant}
              size="sm"
              pending={pending}
              icon={succeeded ? 'check' : icon !== '' ? icon : undefined}
              onClick={() => ctx.runAction(a['action'], ctx.scope, pendingKey)}
            >
              {label}
            </Button>
          )
        })}
      </Stack>
    )
  }
  return <Stack direction="horizontal" gap="xs" wrap align="center">{ctx.renderChildren(node.children)}</Stack>
}

export function TabsImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  // Keep inline tab entries raw until each tab renders so `$row`/`$value` templates remain intact.
  const tabsProp = node.props['tabs']
  const rawTabs = typeof tabsProp === 'string' ? evalIn<unknown>(tabsProp, ctx.scope) : tabsProp
  const tabs = Array.isArray(rawTabs)
    ? rawTabs
        .map((entry, i) => {
          const t = asPlainObject(entry)
          if (t === null) return null
          return {
            id: str(evalIn(t['id'], ctx.scope), `tab-${i}`),
            label: str(evalIn(t['label'] ?? t['title'], ctx.scope), jsonRenderTabFallbackTitle(i + 1, ctx.locale)),
            childrenRaw: t['children'],
          }
        })
        .filter((t): t is { id: string; label: string; childrenRaw: unknown } => t !== null)
    : []
  const [activeId, setActiveId] = useState(tabs[0]?.id)
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  return (
    <Tabs value={active?.id} onValueChange={(val) => setActiveId(val)} variant="underline" size="sm" className="jr-tabs">
      <TabsList scrollable>
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {active !== undefined && (
        <div className="jr-tabs-panel">
          <TabChildren key={active.id} childrenRaw={active.childrenRaw} ctx={ctx} />
        </div>
      )}
    </Tabs>
  )
}

function TabChildren({ childrenRaw, ctx }: { childrenRaw: unknown; ctx: SpecRenderContext }) {
  const normalized = useMemo(
    () => (Array.isArray(childrenRaw) ? normalizeSpec({ component: 'Stack', children: childrenRaw }, ctx.locale) : null),
    [childrenRaw, ctx.locale],
  )
  if (normalized === null || normalized.root === null) return null
  return <>{ctx.renderChildren(normalized.root.children)}</>
}

export function SlotImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const name = str(evalIn(node.props['name'], ctx.scope))
  const modeRaw = str(evalIn(node.props['mode'], ctx.scope), 'list')
  const mode = modeRaw === 'single' ? 'single' : 'list'
  const fallback = node.children.length > 0 ? <>{ctx.renderChildren(node.children)}</> : undefined
  if (name === '') {
    return (
      <Callout tone="warn">
        <span>{tr(ctx, JSON_RENDER_SLOT_MISSING_NAME)}</span>
      </Callout>
    )
  }
  if (ctx.pluginId === undefined) {
    return (
      <Callout tone="warn">
        <span>{tr(ctx, JSON_RENDER_SLOT_NO_HOST)}</span>
      </Callout>
    )
  }
  return (
    <PluginSlot
      name={name}
      mode={mode}
      fallback={fallback}
      slotProps={{ ...(ctx.scope['$data'] as Record<string, unknown> | undefined) }}
      conversationId={ctx.conversationId}
      ownerPluginId={ctx.pluginId}
    />
  )
}
