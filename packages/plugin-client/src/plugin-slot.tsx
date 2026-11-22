/**
 * <PluginSlot />: rendering primitive for inter-plugin child slots (plugin.slot contributions).
 *
 * - A name that is a short internal slot name of this plugin is automatically
 *   prefixed as `<ctx.pluginId>/<name>`; a name containing '/' is treated as an
 *   explicit fully qualified name ('<ownerPluginId>/<slotName>');
 * - Contribution matching/sorting and rendering of a single contribution (host
 *   PluginUiView) are injected via the host port; the pluginId of the child
 *   context is the contributing plugin, not the owner;
 * - Cycle protection runs inside this component: SlotAncestryContext records
 *   the (contributing plugin, contribution id) pairs along the render chain;
 *   when the same item reappears, an explicit cycle warning is rendered and
 *   recursion stops; a maximum nesting depth is also enforced.
 *
 * This file only exports components and TS types (same Fast Refresh contract).
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ComposerController } from '@helmx/protocol/browser'
import { usePluginTranslator } from './i18n.js'
import { HelmxIcon } from './icons.js'
import { usePluginClientHost, type PluginSlotPortItem } from './host-port.js'
import { PluginClientContext } from './plugin-context.js'

const NOOP_UNSUBSCRIBE = (): void => {}

export interface PluginSlotProps {
  /** Short internal slot name of this plugin (auto-prefixed with ctx.pluginId); containing '/' means an explicit fully qualified name. */
  name: string
  /** Context data passed to slot contributions (injected into child props and declarative $data). */
  slotProps?: Record<string, unknown>
  /** 'list' renders all matches (default); 'single' renders only the first item after sorting. */
  mode?: 'list' | 'single'
  /** Fallback content when no plugin contributes anything. */
  fallback?: ReactNode
  className?: string
  /** Render a <span> wrapper instead of <div> (useful in inline phrasing contexts). */
  inline?: boolean
  /** For scenarios without a PluginClientContext such as the declarative track: explicitly provide the owner plugin and conversation. */
  ownerPluginId?: string
  conversationId?: number
  /** Explicitly provided by the host when mounting the slot in the composer area (injected into child
   * usePluginContext().composer); inside plugin components, the composer of the surrounding context is used by default. */
  composer?: ComposerController
}

/** Ancestry record along the render chain: for cycle detection (the same contribution reappearing means a cycle). */
interface SlotAncestry {
  chain: ReadonlyArray<readonly [contributorPluginId: string, contributionId: string]>
  depth: number
}

const SlotAncestryContext = createContext<SlotAncestry>({ chain: [], depth: 0 })

/** Defensive maximum nesting depth (limits stack-blowing infinite nesting even when the contribution chain is not a cycle). */
const MAX_SLOT_DEPTH = 16

function isValidQualifiedSlotTarget(target: string): boolean {
  const slash = target.indexOf('/')
  if (slash <= 0 || slash >= target.length - 1 || target.indexOf('/', slash + 1) >= 0) {
    return false
  }
  const owner = target.slice(0, slash)
  const slotName = target.slice(slash + 1)
  return /^[A-Za-z0-9:_-]+$/.test(owner) && /^[A-Za-z0-9._-]+$/.test(slotName)
}

interface SlotContributionItemProps {
  item: PluginSlotPortItem
  qualified: string
  ancestry: SlotAncestry
  slotProps?: Record<string, unknown>
  conversationId?: number
  composer?: ComposerController
}

function SlotContributionItem({
  item,
  qualified,
  ancestry,
  slotProps,
  conversationId,
  composer,
}: SlotContributionItemProps): ReactNode {
  const host = usePluginClientHost()
  const nextAncestry = useMemo<SlotAncestry>(
    () => ({
      chain: [...ancestry.chain, [item.pluginId, item.contributionId] as const],
      depth: ancestry.depth + 1,
    }),
    [ancestry, item.pluginId, item.contributionId],
  )
  return (
    <SlotAncestryContext.Provider value={nextAncestry}>
      {host.slots.renderItem(item, {
        slotProps,
        conversationId,
        composer,
        label: `Slot ${qualified}/${item.contributionId}`,
      })}
    </SlotAncestryContext.Provider>
  )
}

export function PluginSlot(props: PluginSlotProps): ReactNode {
  const {
    name,
    slotProps,
    mode = 'list',
    fallback,
    className,
    inline = false,
    ownerPluginId,
    conversationId: explicitConversationId,
    composer: explicitComposer,
  } = props
  const t = usePluginTranslator()
  const clientCtx = useContext(PluginClientContext)
  const host = usePluginClientHost()
  const owner = ownerPluginId ?? clientCtx?.pluginId
  const conversationId = explicitConversationId ?? clientCtx?.conversationId
  const composer = explicitComposer ?? clientCtx?.composer
  const ancestry = useContext(SlotAncestryContext)

  // Subscribe to plugin UI revisions and, when scoped to a conversation, that
  // conversation's summary (falling back to detail only while summary is absent)
  // so disabling a plugin or changing conversation scope updates the slot while
  // streaming `conversationLives` token frames never re-render it.
  useSyncExternalStore(host.subscribePlugins, host.getPluginsSnapshot, host.getPluginsSnapshot)
  const subscribeSummary = useCallback(
    (listener: () => void): (() => void) =>
      conversationId !== undefined ? host.subscribeConversationSummary(conversationId, listener) : NOOP_UNSUBSCRIBE,
    [host, conversationId],
  )
  const getSummary = useCallback(
    () => (conversationId !== undefined ? host.getConversationSummary(conversationId) : undefined),
    [host, conversationId],
  )
  const summary = useSyncExternalStore(subscribeSummary, getSummary, getSummary)
  const subscribeDetailFallback = useCallback(
    (listener: () => void): (() => void) =>
      conversationId !== undefined && summary === undefined
        ? host.subscribeConversationDetail(conversationId, listener)
        : NOOP_UNSUBSCRIBE,
    [host, conversationId, summary],
  )
  const getDetailFallback = useCallback(
    () =>
      conversationId !== undefined && summary === undefined ? host.getConversationDetail(conversationId) : undefined,
    [host, conversationId, summary],
  )
  useSyncExternalStore(subscribeDetailFallback, getDetailFallback, getDetailFallback)

  if (owner === undefined || owner.trim().length === 0) {
    return (
      <div className="callout callout-warn" role="alert">
        <HelmxIcon name="alert-triangle" size={13} />
        <span>
          {t({
            en: 'PluginSlot has no host plugin context (use it inside PluginUiView or pass ownerPluginId explicitly)',
            'zh-CN': 'PluginSlot 缺少宿主插件上下文（请在 PluginUiView 内使用或显式传入 ownerPluginId）',
          })}
        </span>
      </div>
    )
  }

  const qualified = name.includes('/') ? name : `${owner}/${name}`
  if (!isValidQualifiedSlotTarget(qualified)) {
    return (
      <div className="callout callout-warn" role="alert">
        <HelmxIcon name="alert-triangle" size={13} />
        <span>
          {t({
            en: `PluginSlot target "${qualified}" is invalid (expected <slotName> or <ownerPluginId>/<slotName>)`,
            'zh-CN': `PluginSlot 目标「${qualified}」非法（应为 <slotName> 或 <ownerPluginId>/<slotName>）`,
          })}
        </span>
      </div>
    )
  }

  const items = host.slots.collectItems(qualified, conversationId)
  const visible = mode === 'single' ? items.slice(0, 1) : items

  if (visible.length === 0) return fallback !== undefined ? <>{fallback}</> : null

  if (ancestry.depth >= MAX_SLOT_DEPTH) {
    return (
      <div className="callout callout-warn" role="alert" data-helmx-slot={qualified}>
        <HelmxIcon name="alert-triangle" size={13} />
        <span>
          {t({
            en: `Plugin slot nesting exceeded the maximum depth of ${MAX_SLOT_DEPTH}; rendering aborted`,
            'zh-CN': `插件插槽嵌套超过最大深度 ${MAX_SLOT_DEPTH}，已中止渲染`,
          })}
        </span>
      </div>
    )
  }

  const Container = inline ? 'span' : 'div'
  const normalizedClassName = className !== undefined && className.trim().length > 0 ? className : undefined
  // Omit the wrapper layout box when the caller supplies no className so flex/grid
  // parents keep direct-child semantics while preserving a stable DOM anchor.
  const containerStyle = normalizedClassName === undefined ? { display: 'contents' as const } : undefined

  return (
    <Container className={normalizedClassName} style={containerStyle} data-helmx-slot={qualified}>
      {visible.map((item) => {
        const key = `${item.pluginId}/${item.contributionId}`
        if (ancestry.chain.some(([pid, cid]) => pid === item.pluginId && cid === item.contributionId)) {
          return (
            <div className="callout callout-warn" role="alert" key={key} data-helmx-slot-cycle={key}>
              <HelmxIcon name="alert-triangle" size={13} />
              <span>
                {t({
                  en: `Plugin slot cycle detected (${key}); recursion aborted`,
                  'zh-CN': `检测到插件插槽循环引用（${key}），已中止递归`,
                })}
              </span>
            </div>
          )
        }
        return (
          <SlotContributionItem
            key={key}
            item={item}
            qualified={qualified}
            ancestry={ancestry}
            slotProps={slotProps}
            conversationId={conversationId}
            composer={composer}
          />
        )
      })}
    </Container>
  )
}
