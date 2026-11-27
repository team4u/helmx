/** Dedicated lightweight settings-panel entrypoint for builtin:tiers (`TiersSettingsPanel`). */
import { useMemo, type ReactNode } from 'react'
import { Button, KvGrid, LoadingState, Stack } from '@helmx/ui'
import { usePluginContext, usePluginDoc, usePluginTranslator } from '@helmx/plugin-client'
import { TIERS_PLUGIN_ID, TIERS_SCREEN_ID, TIERS_STATE_DOC, parseTiersStateDoc } from './models.ts'
import { TIERS_COPY as C } from './copy.ts'
import './styles.css'

export function TiersSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const rawDoc = usePluginDoc(TIERS_STATE_DOC)
  const parsed = useMemo(() => parseTiersStateDoc(rawDoc), [rawDoc])
  if (rawDoc === undefined) {
    return <LoadingState label={t(C.loading)} />
  }
  const activeTemplate = parsed.templates.find((tpl) => tpl.id === parsed.activeTemplate)
  return (
    <Stack gap="md">
      <p className="text-muted">{t(C.settingsHint)}</p>
      <KvGrid
        items={[
          { key: t(C.settingsKvActive), value: String(Object.keys(parsed.tiers).length) },
          { key: t(C.settingsKvTemplates), value: String(parsed.templates.length) },
          { key: t(C.settingsKvTemplate), value: activeTemplate ? activeTemplate.name : t(C.settingsNone) },
        ]}
      />
      <div>
        <Button variant="secondary" size="sm" icon="layers" onClick={() => ctx.openScreen(`screen:${TIERS_PLUGIN_ID}/${TIERS_SCREEN_ID}`)}>
          {t(C.settingsOpen)}
        </Button>
      </div>
    </Stack>
  )
}
