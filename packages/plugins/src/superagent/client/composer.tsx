/**
 * Dedicated composer surface entrypoint for builtin:superagent
 * (`SuperAgentComposerWidget` and `SuperAgentRouterModePill`).
 */
import { useMemo } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ComposerScopeProps } from '@helmx/protocol'
import {
  HelmxIcon,
  LoadingState,
  Switch,
  useConversations,
  usePluginAction,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  buildConversationMap,
  parseRouterMode,
  parseSubscriptions,
  parseWorkers,
  type RouterModeDoc,
  type SuperAgentIndexDoc,
  type ThreadSubscriptionDoc,
} from './models.ts'
import {
  SA_ACTION_ARCHIVE,
  SA_ACTION_OPEN,
  SA_COL_ACTIONS,
  SA_LOADING,
  SA_LOADING_STATUS,
  SA_NO_DATA,
  SA_ROUTER_PILL_ARIA,
  SA_ROUTER_PILL_LABEL,
  SA_WIDGET_TITLE,
  saWidgetSummary,
} from './copy.ts'
import { ActionError, ConversationCell, RowAction } from './shared.tsx'

/** Hub status widget: live counts and the active-worker center table (open + archive). */
export function SuperAgentComposerWidget(_props: ComposerScopeProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const conversations = useConversations()
  const conversationsById = useMemo(() => buildConversationMap(conversations), [conversations])
  const index = usePluginDoc<SuperAgentIndexDoc>('index')
  const subscriptions = usePluginDoc<ThreadSubscriptionDoc>('subscriptions')
  const workers = parseWorkers(index)
  const subs = parseSubscriptions(subscriptions)
  const loading = index === undefined || subscriptions === undefined
  const archiveAction = usePluginAction()

  return (
    <div className="section-flat sa-widget">
      <div className="sa-widget-title">
        <HelmxIcon name="network" size={13} />
        <span>{t(SA_WIDGET_TITLE)}</span>
      </div>
      {loading ? (
        <LoadingState label={t(SA_LOADING_STATUS)} />
      ) : (
        <>
          <div className="sa-widget-muted">{saWidgetSummary(workers.length, subs.length, locale)}</div>
          {archiveAction.error !== undefined ? <ActionError message={archiveAction.error} /> : null}
          <div className="helmx-table-wrap">
            <table className="helmx-table">
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Profile</th>
                  <th className="cell-actions">{t(SA_COL_ACTIONS)}</th>
                </tr>
              </thead>
              <tbody>
                {workers.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="table-empty">
                      {t(SA_NO_DATA)}
                    </td>
                  </tr>
                ) : (
                  workers.map((w) => (
                    <tr key={w.conversationId}>
                      <ConversationCell conversationId={w.conversationId} conversationsById={conversationsById} />
                      <td>{w.profileId}</td>
                      <td className="cell-actions">
                        <div className="row-actions-group">
                          <RowAction
                            label={t(SA_ACTION_OPEN)}
                            iconName="external-link"
                            disabled={archiveAction.pending}
                            onClick={() => ctx.openScreen(`conversation:${w.conversationId}`)}
                          />
                          <RowAction
                            label={t(SA_ACTION_ARCHIVE)}
                            iconName="boxes"
                            disabled={archiveAction.pending}
                            danger
                            onClick={() =>
                              void archiveAction.run('archive_worker', { workerConversationId: w.conversationId })
                            }
                          />
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

/** Hub router convergence-mode pill (routing mirror doc; set_router_mode writes the real config). */
export function SuperAgentRouterModePill(_props: ComposerScopeProps): ReactNode {
  const t = usePluginTranslator()
  const routing = usePluginDoc<RouterModeDoc>('routing')
  const mode = parseRouterMode(routing)
  const toggleAction = usePluginAction()

  return (
    <span className="sa-pill">
      <Switch
        checked={mode === true}
        onChange={(next) => void toggleAction.run('set_router_mode', { enabled: next })}
        disabled={toggleAction.pending || mode === undefined}
        label={t(SA_ROUTER_PILL_LABEL)}
        aria-label={t(SA_ROUTER_PILL_ARIA)}
      />
      {mode === undefined ? <span className="text-subtle">{t(SA_LOADING)}</span> : null}
      {toggleAction.error !== undefined ? <ActionError message={toggleAction.error} /> : null}
    </span>
  )
}
