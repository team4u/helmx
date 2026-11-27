/**
 * Node detail drawer section slot for `builtin:port-forward` (`NODE_DETAIL_SECTION_SLOT`).
 * Fast Refresh compliant: exports only React components and TypeScript types.
 */
import { useMemo, type ReactNode } from 'react'
import './styles.css'
import type { NodeDetailSlotProps } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Card,
  HelmxIcon,
  List,
  ListRow,
  StatusLight,
} from '@helmx/ui'
import {
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  PF_RULES_DOC,
  PF_RUNTIME_DOC,
  buildScreenTarget,
  parseRulesDoc,
  parseRuntimeDoc,
  synthesizeMappingRow,
} from './models.ts'
import {
  PF_NODE_SLOT_EMPTY,
  PF_NODE_SLOT_MANAGE,
  PF_NODE_SLOT_NEW,
  PF_NODE_SLOT_TITLE,
  pfStatusLabel,
} from './copy.ts'

export function NodePortForwardsSection(props: NodeDetailSlotProps): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const rawRules = usePluginDoc(PF_RULES_DOC)
  const rawRuntime = usePluginDoc(PF_RUNTIME_DOC)

  const nodeRows = useMemo(() => {
    const rules = parseRulesDoc(rawRules).filter((r) => r.nodeId === props.nodeId)
    const runtimeById = parseRuntimeDoc(rawRuntime)
    const stubNodes = [
      {
        id: props.nodeId,
        kind: props.isLocal ? ('local' as const) : ('byom' as const),
        online: props.isOnline,
      },
    ]
    return rules.map((r) => synthesizeMappingRow(r, runtimeById, stubNodes))
  }, [rawRules, rawRuntime, props.nodeId, props.isLocal, props.isOnline])

  return (
    <Card
      variant="subtle"
      title={
        <span className="pf-status-cell">
          <HelmxIcon name="network" size={13} />
          <span>{t(PF_NODE_SLOT_TITLE)}</span>
        </span>
      }
      actions={
        <div className="row-actions-group">
          <Button
            variant="secondary"
            size="xs"
            icon="plus"
            onClick={() => ctx.openScreen(buildScreenTarget({ node: props.nodeId, create: true }))}
          >
            {t(PF_NODE_SLOT_NEW)}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon="external-link"
            onClick={() => ctx.openScreen(buildScreenTarget({ node: props.nodeId }))}
          >
            {t(PF_NODE_SLOT_MANAGE)}
          </Button>
        </div>
      }
    >
      {nodeRows.length === 0 ? (
        <span className="text-muted">{t(PF_NODE_SLOT_EMPTY)}</span>
      ) : (
        <List density="compact" label={t(PF_NODE_SLOT_TITLE)}>
          {nodeRows.map((row) => {
            const label = pfStatusLabel(row.statusKind, locale)
            return (
              <ListRow
                key={row.id}
                tone={
                  row.statusKind === 'error'
                    ? 'danger'
                    : row.statusKind === 'waiting_node'
                      ? 'warn'
                      : 'default'
                }
                leading={<StatusLight tone={row.displayTone} label={label} />}
                title={row.name}
                meta={
                  <span className="mono">
                    {row.listenAddr} → {row.targetAddr}
                  </span>
                }
                trailing={
                  <Badge tone="neutral" mono>
                    {row.activeConnections > 0 ? String(row.activeConnections) : label}
                  </Badge>
                }
                onSelect={() =>
                  ctx.openScreen(buildScreenTarget({ node: props.nodeId, edit: row.id }))
                }
              />
            )
          })}
        </List>
      )}
    </Card>
  )
}
