/** Dedicated lightweight settings-panel entrypoint for builtin:orchestrator (`OrchestratorSettingsPanel`). */
import { useMemo, type ReactNode } from 'react'
import {
  Button,
  Callout,
  HelmxIcon,
  HelperText,
  KvGrid,
  List,
  ListRow,
  LoadingState,
  Stack,
  StatusLight,
  type LocalizedText,
  type StatusLightTone,
} from '@helmx/ui'
import {
  formatModelShortName,
  useHostModels,
  usePluginContext,
  usePluginDoc,
  usePluginTranslator,
  usePlugins,
} from '@helmx/plugin-client'
import { ORCHESTRATOR_COPY } from './copy.ts'
import {
  ORCHESTRATOR_PLUGIN_ID,
  ORCHESTRATOR_SCREEN_ID,
  ORCHESTRATOR_STATE_DOC,
  parseOrchestratorStateDoc,
  synthesizeOrchestratorItems,
  type OrchestratorAvailability,
} from './models.ts'
import './styles.css'

const STATUS_META: Readonly<Record<OrchestratorAvailability, { tone: StatusLightTone; copy: LocalizedText }>> = {
  available: { tone: 'done', copy: ORCHESTRATOR_COPY.statusAvailable },
  disabled: { tone: 'blocked', copy: ORCHESTRATOR_COPY.statusDisabled },
  unavailable: { tone: 'aborted', copy: ORCHESTRATOR_COPY.statusUnavailable },
}

export function OrchestratorSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const { plugins } = usePlugins()
  const hostModels = useHostModels()
  const rawDoc = usePluginDoc(ORCHESTRATOR_STATE_DOC)
  const stateDoc = useMemo(() => parseOrchestratorStateDoc(rawDoc), [rawDoc])

  const enabled = useMemo(
    () => plugins.find((p) => p.id === ORCHESTRATOR_PLUGIN_ID)?.enabled !== false,
    [plugins],
  )
  const items = useMemo(
    () => synthesizeOrchestratorItems(stateDoc.items, hostModels),
    [stateDoc.items, hostModels],
  )
  const readyCount = useMemo(
    () => items.filter((entry) => entry.status === 'available').length,
    [items],
  )

  if (rawDoc === undefined) {
    return <LoadingState label={t(ORCHESTRATOR_COPY.loading)} />
  }

  return (
    <Stack gap="md">
      {!enabled && <Callout tone="warn">{t(ORCHESTRATOR_COPY.settingsDisabledAlert)}</Callout>}
      <HelperText>{t(ORCHESTRATOR_COPY.settingsSummary)}</HelperText>
      <KvGrid
        items={[
          { key: t(ORCHESTRATOR_COPY.settingsKvTotal), value: String(items.length) },
          { key: t(ORCHESTRATOR_COPY.settingsKvReady), value: String(readyCount) },
        ]}
      />
      {items.length > 0 && (
        <List density="compact" label={t(ORCHESTRATOR_COPY.screenTitle)}>
          {items.slice(0, 6).map((entry) => {
            const statusMeta = STATUS_META[entry.status]
            const plannerShort = formatModelShortName(entry.resolvedPlannerModel ?? entry.item.plannerModel)
            const executorShort = formatModelShortName(entry.resolvedExecutorModel ?? entry.item.executorModel)
            return (
              <ListRow
                key={entry.item.id}
                leading={<StatusLight tone={statusMeta.tone} label={t(statusMeta.copy)} />}
                title={<span>{entry.item.name}</span>}
                meta={
                  <>
                    <code className="mono orch-id-code">
                      <span className="orch-prefix">tier/</span>
                      {entry.item.id}
                    </code>
                    <span className="orch-model-endpoint">
                      <code className="orch-model-name">{plannerShort}</code>
                    </span>
                    <HelmxIcon name="arrow-right" size={11} className="orch-model-arrow" />
                    <span className="orch-model-endpoint">
                      <code className="orch-model-name">{executorShort}</code>
                    </span>
                  </>
                }
                onSelect={() =>
                  ctx.openScreen(
                    `screen:${ORCHESTRATOR_PLUGIN_ID}/${ORCHESTRATOR_SCREEN_ID}?edit=${encodeURIComponent(entry.item.id)}`,
                  )
                }
              />
            )
          })}
        </List>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          icon="git-pull-request"
          onClick={() => ctx.openScreen(`screen:${ORCHESTRATOR_PLUGIN_ID}/${ORCHESTRATOR_SCREEN_ID}`)}
        >
          {t(ORCHESTRATOR_COPY.settingsOpenManager)}
        </Button>
      </div>
    </Stack>
  )
}
