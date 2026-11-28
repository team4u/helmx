import { useMemo, type ReactNode } from 'react'
import { Badge, Button, Callout, HelperText, KvGrid, Stack, StatusLight, type StatusLightTone } from '@helmx/ui'
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

const STATUS_TONE: Readonly<Record<DuoRecipeAvailability, StatusLightTone>> = {
  available: 'done',
  disabled: 'blocked',
  unavailable: 'aborted',
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

  return (
    <Stack gap="sm">
      {!enabled && <Callout tone="warn">{t(DUO_COPY.settingsDisabledAlert)}</Callout>}
      <HelperText>{t(DUO_COPY.settingsSummary)}</HelperText>
      <KvGrid
        items={[
          { key: t(DUO_COPY.settingsKvRecipes), value: String(items.length) },
          { key: t(DUO_COPY.settingsKvReady), value: String(readyCount) },
        ]}
      />
      {items.length > 0 && (
        <div className="duo-settings-list">
          {items.slice(0, 6).map((item) => (
            <div key={item.recipe.id} className="duo-settings-row">
              <div className="duo-settings-row-main">
                <StatusLight tone={STATUS_TONE[item.status]} label={item.recipe.name} />
                <span>{item.recipe.name}</span>
                <Badge tone="neutral" mono>
                  tier/{item.recipe.id}
                </Badge>
              </div>
              <span className="duo-settings-row-pair">
                {formatModelShortName(item.resolvedPlannerModel ?? item.recipe.plannerModel)} →{' '}
                {formatModelShortName(item.resolvedExecutorModel ?? item.recipe.executorModel)}
              </span>
            </div>
          ))}
        </div>
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
