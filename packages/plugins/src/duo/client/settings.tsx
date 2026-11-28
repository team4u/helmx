/** Dedicated lightweight settings-panel entrypoint for builtin:duo (`DuoSettingsPanel`). */
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
import { DUO_COPY } from './copy.ts'
import {
  DUO_PLUGIN_ID,
  DUO_SCREEN_ID,
  DUO_STATE_DOC,
  parseDuoStateDoc,
  synthesizeDuoRecipeItems,
  type DuoRecipeAvailability,
} from './models.ts'
import './styles.css'

const STATUS_META: Readonly<Record<DuoRecipeAvailability, { tone: StatusLightTone; copy: LocalizedText }>> = {
  available: { tone: 'done', copy: DUO_COPY.statusAvailable },
  disabled: { tone: 'blocked', copy: DUO_COPY.statusDisabled },
  unavailable: { tone: 'aborted', copy: DUO_COPY.statusUnavailable },
}

export function DuoSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const { plugins } = usePlugins()
  const hostModels = useHostModels()
  const rawDoc = usePluginDoc(DUO_STATE_DOC)
  const stateDoc = useMemo(() => parseDuoStateDoc(rawDoc), [rawDoc])

  const enabled = useMemo(
    () => plugins.find((p) => p.id === DUO_PLUGIN_ID)?.enabled !== false,
    [plugins],
  )
  const items = useMemo(
    () => synthesizeDuoRecipeItems(stateDoc.recipes, hostModels),
    [stateDoc.recipes, hostModels],
  )
  const readyCount = useMemo(
    () => items.filter((item) => item.status === 'available').length,
    [items],
  )

  if (rawDoc === undefined) {
    return <LoadingState label={t(DUO_COPY.loading)} />
  }

  return (
    <Stack gap="md">
      {!enabled && <Callout tone="warn">{t(DUO_COPY.settingsDisabledAlert)}</Callout>}
      <HelperText>{t(DUO_COPY.settingsSummary)}</HelperText>
      <KvGrid
        items={[
          { key: t(DUO_COPY.settingsKvTotal), value: String(items.length) },
          { key: t(DUO_COPY.settingsKvReady), value: String(readyCount) },
        ]}
      />
      {items.length > 0 && (
        <List density="compact" label={t(DUO_COPY.screenTitle)}>
          {items.slice(0, 6).map((item) => {
            const statusMeta = STATUS_META[item.status]
            const plannerShort = formatModelShortName(item.resolvedPlannerModel ?? item.recipe.plannerModel)
            const executorShort = formatModelShortName(item.resolvedExecutorModel ?? item.recipe.executorModel)
            return (
              <ListRow
                key={item.recipe.id}
                leading={<StatusLight tone={statusMeta.tone} label={t(statusMeta.copy)} />}
                title={<span>{item.recipe.name}</span>}
                meta={
                  <>
                    <code className="mono duo-id-code">
                      <span className="duo-prefix">tier/</span>
                      {item.recipe.id}
                    </code>
                    <span className="duo-model-endpoint">
                      <code className="duo-model-name">{plannerShort}</code>
                    </span>
                    <HelmxIcon name="arrow-right" size={11} className="duo-model-arrow" />
                    <span className="duo-model-endpoint">
                      <code className="duo-model-name">{executorShort}</code>
                    </span>
                  </>
                }
                onSelect={() =>
                  ctx.openScreen(
                    `screen:${DUO_PLUGIN_ID}/${DUO_SCREEN_ID}?edit=${encodeURIComponent(item.recipe.id)}`,
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
          onClick={() => ctx.openScreen(`screen:${DUO_PLUGIN_ID}/${DUO_SCREEN_ID}`)}
        >
          {t(DUO_COPY.settingsOpenManager)}
        </Button>
      </div>
    </Stack>
  )
}
