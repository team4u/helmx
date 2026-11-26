/**
 * @json-render standard primitive dispatcher (21 built-in components, Fast Refresh compliant).
 */
import type { ComponentType, ReactNode } from 'react'
import { Callout } from '@helmx/plugin-client'
import { jsonRenderUnknownComponent } from './copy.ts'
import type { NormalizedSpecNode } from './spec-normalize.ts'
import type { SpecRenderContext } from './primitive-context.ts'
import {
  AccordionImpl,
  BadgeImpl,
  BarListImpl,
  CalloutImpl,
  CardImpl,
  KeyValueListImpl,
  MarkdownImpl,
  MetricCardImpl,
  MetricGridImpl,
  StackImpl,
  StepsImpl,
  TableImpl,
  TextImpl,
} from './primitives-display.tsx'
import {
  ActionBarImpl,
  ButtonImpl,
  CheckboxGroupImpl,
  SelectImpl,
  SlotImpl,
  SwitchImpl,
  TabsImpl,
  TextInputImpl,
} from './primitives-interactive.tsx'

export type { SpecRenderContext } from './primitive-context.ts'

interface SpecImplProps {
  node: NormalizedSpecNode
  ctx: SpecRenderContext
}

/**
 * 组件名 → 实现组件的分发表（表驱动，替代逐组件 switch）。
 * 查表用 `Object.hasOwn` 守卫：`constructor` / `toString` 等原型链键必须按未登记组件降级，绝不命中继承属性。
 * 每个条目是独立的组件类型，保证 React fiber 与 Hook 数量按组件稳定。
 */
const SPEC_IMPLS: Readonly<Record<string, ComponentType<SpecImplProps>>> = {
  Stack: StackImpl,
  Card: CardImpl,
  Text: TextImpl,
  Badge: BadgeImpl,
  Markdown: MarkdownImpl,
  MetricGrid: MetricGridImpl,
  MetricCard: MetricCardImpl,
  KeyValueList: KeyValueListImpl,
  Callout: CalloutImpl,
  Steps: StepsImpl,
  BarList: BarListImpl,
  Table: TableImpl,
  Accordion: AccordionImpl,
  TextInput: TextInputImpl,
  Select: SelectImpl,
  Switch: SwitchImpl,
  CheckboxGroup: CheckboxGroupImpl,
  Button: ButtonImpl,
  ActionBar: ActionBarImpl,
  Tabs: TabsImpl,
  Slot: SlotImpl,
}

/** Render one normalized node with distinct per-component fibers so React hook counts remain stable. */
function SpecNodeView({ node, ctx }: SpecImplProps): ReactNode {
  if (!Object.hasOwn(SPEC_IMPLS, node.component)) {
    return (
      <Callout tone="warn">
        <span>{jsonRenderUnknownComponent(node.component, ctx.locale)}</span>
      </Callout>
    )
  }
  const Impl = SPEC_IMPLS[node.component]!
  return <Impl node={node} ctx={ctx} />
}

/** Render a list of normalized nodes. */
export function SpecNodeList({ nodes, ctx }: { nodes: NormalizedSpecNode[]; ctx: SpecRenderContext }): ReactNode {
  return (
    <>
      {nodes.map((child, i) => (
        <SpecNodeView key={i} node={child} ctx={ctx} />
      ))}
    </>
  )
}
