/**
 * @json-render standard primitive dispatcher (21 built-in components, Fast Refresh compliant).
 */
import type { ReactNode } from 'react'
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

/** Render one normalized node with distinct per-component fibers so React hook counts remain stable. */
function SpecNodeView({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }): ReactNode {
  switch (node.component) {
    case 'Stack': return <StackImpl node={node} ctx={ctx} />
    case 'Card': return <CardImpl node={node} ctx={ctx} />
    case 'Text': return <TextImpl node={node} ctx={ctx} />
    case 'Badge': return <BadgeImpl node={node} ctx={ctx} />
    case 'Markdown': return <MarkdownImpl node={node} ctx={ctx} />
    case 'MetricGrid': return <MetricGridImpl node={node} ctx={ctx} />
    case 'MetricCard': return <MetricCardImpl node={node} ctx={ctx} />
    case 'KeyValueList': return <KeyValueListImpl node={node} ctx={ctx} />
    case 'Callout': return <CalloutImpl node={node} ctx={ctx} />
    case 'Steps': return <StepsImpl node={node} ctx={ctx} />
    case 'BarList': return <BarListImpl node={node} ctx={ctx} />
    case 'Table': return <TableImpl node={node} ctx={ctx} />
    case 'Accordion': return <AccordionImpl node={node} ctx={ctx} />
    case 'TextInput': return <TextInputImpl node={node} ctx={ctx} />
    case 'Select': return <SelectImpl node={node} ctx={ctx} />
    case 'Switch': return <SwitchImpl node={node} ctx={ctx} />
    case 'CheckboxGroup': return <CheckboxGroupImpl node={node} ctx={ctx} />
    case 'Button': return <ButtonImpl node={node} ctx={ctx} />
    case 'ActionBar': return <ActionBarImpl node={node} ctx={ctx} />
    case 'Tabs': return <TabsImpl node={node} ctx={ctx} />
    case 'Slot': return <SlotImpl node={node} ctx={ctx} />
    default:
      return (
        <Callout tone="warn">
          <span>{jsonRenderUnknownComponent(node.component, ctx.locale)}</span>
        </Callout>
      )
  }
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
