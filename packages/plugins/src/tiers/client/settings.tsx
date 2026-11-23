/** Dedicated lightweight settings-panel entrypoint for builtin:tiers (`TiersSettingsPanel`). */
import { useMemo, type ReactNode } from 'react'
import { HelmxIcon, KvGrid, usePluginContext, usePluginDoc, usePluginTranslator } from '@helmx/plugin-client'
import { TIERS_PLUGIN_ID, TIERS_SCREEN_ID, TIERS_STATE_DOC, parseTiersStateDoc } from './models.ts'
import { TIERS_COPY as C } from './copy.ts'
import './styles.css'

export function TiersSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const rawDoc = usePluginDoc(TIERS_STATE_DOC)
  const parsed = useMemo(() => parseTiersStateDoc(rawDoc), [rawDoc])
  if (rawDoc === undefined) {
    return <div className="loading-state" role="status"><HelmxIcon name="loader" size={12} className="spin-slow" /><span>{t(C.loading)}</span></div>
  }
  const activeTemplate = parsed.templates.find((tpl) => tpl.id === parsed.activeTemplate)
  return (
    <div className="tiers-settings-body">
      <p className="text-muted">{t(C.settingsHint)}</p>
      <KvGrid
        items={[
          { key: t(C.settingsKvActive), value: String(Object.keys(parsed.tiers).length) },
          { key: t(C.settingsKvTemplates), value: String(parsed.templates.length) },
          { key: t(C.settingsKvTemplate), value: activeTemplate ? activeTemplate.name : t(C.settingsNone) },
        ]}
      />
      <div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => ctx.openScreen(`screen:${TIERS_PLUGIN_ID}/${TIERS_SCREEN_ID}`)}>
          <HelmxIcon name="layers" size={13} /><span>{t(C.settingsOpen)}</span>
        </button>
      </div>
    </div>
  )
}
