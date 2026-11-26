/**
 * Host adapter for the shared SDK ModelPickerControl: localized control copy
 * (built from web i18n; the control itself ships English defaults and reads no
 * locale context) plus a refresh-notice channel bound to the host notice
 * pipeline. Hooks + pure builders only (no components, Fast Refresh rule).
 */
import { useCallback, useMemo } from 'react'
import type { ModelPickerControlCopy } from '@helmx/plugin-client'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useOptionalStoreActions } from '../lib/store-context.js'

/** Build the localized control copy from the web translator. */
export function buildModelPickerControlCopy(t: WebMessageTranslator): ModelPickerControlCopy {
  return {
    buttonAria: t('composer.model.buttonAria'),
    levelSuffix: t('composer.model.levelSuffix'),
    defaultLabel: t('composer.model.defaultLabel'),
    defaultModeLabel: t('composer.model.defaultModeLabel'),
    modeBarAria: t('composer.model.modeBarAria'),
    catalogUnavailable: t('composer.model.catalogUnavailable'),
    searchAria: t('composer.model.searchAria'),
    searchPlaceholder: t('composer.model.searchPlaceholder'),
    refreshCatalog: t('composer.model.refreshCatalog'),
    tiersHeader: t('composer.model.tiersHeader'),
    tierRowTitle: t('composer.model.tierRowTitle'),
    listHeader: t('composer.model.listHeader'),
    navHint: t('composer.kbd.navConfirm'),
    emptyCatalog: t('composer.model.emptyCatalog'),
    openModelsCenter: t('composer.model.openModelsCenter'),
    noMatches: t('composer.model.noMatches'),
    thinkingHeader: t('composer.model.thinkingHeader'),
    rowDefaultTitle: t('composer.model.rowDefaultTitle'),
    levelChipTitle: t('composer.model.levelChipTitle'),
    catalogPartialFailure: t('composer.model.catalogPartialFailure'),
    catalogRefreshed: t('composer.model.catalogRefreshed'),
    catalogRefreshFailed: t('composer.model.catalogRefreshFailed'),
  }
}

/**
 * Props bundle for ModelPickerControl host consumers (copy + refresh notices).
 * Provider-optional by design (the plugin config form renders standalone in
 * tests): outside <HelmxStoreProvider> the notice channel is simply absent —
 * refresh outcomes then surface through their own copy, never a fake toast.
 */
export function useModelPickerControlAdapter(conversationId?: number): {
  copy: ModelPickerControlCopy
  onNotice: ((message: string, tone: 'info' | 'warning' | 'error') => void) | undefined
  onOpenModelsCenter: (() => void) | undefined
} {
  const { t } = useWebLocale()
  const actions = useOptionalStoreActions()
  const copy = useMemo(() => buildModelPickerControlCopy(t), [t])
  const onNotice = useCallback(
    (message: string, tone: 'info' | 'warning' | 'error') => {
      actions?.pushNotice({
        type: 'notification',
        level: tone,
        title: message,
        ...(conversationId !== undefined ? { conversationId } : {}),
      })
    },
    [actions, conversationId],
  )
  const onOpenModelsCenter = useMemo(
    () => (actions ? () => actions.openTarget({ kind: 'models' }) : undefined),
    [actions],
  )
  return { copy, onNotice, onOpenModelsCenter }
}
