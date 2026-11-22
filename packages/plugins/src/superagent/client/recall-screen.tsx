/**
 * Dedicated RecallGraph fullscreen surface entrypoint for builtin:superagent
 * (`SuperAgentRecallScreen`). Loaded lazily only when opened.
 */
import { useMemo } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol'
import {
  DataTable,
  HelmxIcon,
  Screen,
  ScreenSection,
  formatTime,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  buildConversationMap,
  outcomeLabel,
  outcomeTone,
  parseRecallNodes,
  parseSubscriptions,
  type RecallGraphDoc,
  type ThreadSubscriptionDoc,
} from './models.ts'
import {
  SA_ACTION_OPEN_CONVERSATION,
  SA_ACTION_OPEN_WORKER,
  SA_COL_ACTIONS,
  SA_COL_CONVERSATION,
  SA_COL_CREATED,
  SA_COL_OUTCOME,
  SA_COL_SUMMARY,
  SA_LOADING_GRAPH,
  SA_LOADING_SUBSCRIPTIONS,
  SA_NO_DATA,
  SA_RECALL_TITLE,
  SA_SUBSCRIPTIONS_TITLE,
  saRecallSubtitle,
} from './copy.ts'
import { ConversationCell, RowAction } from './shared.tsx'

export function SuperAgentRecallScreen(props: ScreenProps): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const conversations = useConversations()
  const conversationsById = useMemo(() => buildConversationMap(conversations), [conversations])
  const recall = usePluginDoc<RecallGraphDoc>('recall-graph')
  const subscriptions = usePluginDoc<ThreadSubscriptionDoc>('subscriptions')
  const nodes = parseRecallNodes(recall)
  const subs = parseSubscriptions(subscriptions)

  return (
    <Screen
      title={
        <>
          <HelmxIcon name="git-fork" size={15} />
          <span>{t(SA_RECALL_TITLE)}</span>
        </>
      }
      subtitle={saRecallSubtitle(nodes.length, subs.length, props.isSplit, locale)}
    >
      <ScreenSection>
        <DataTable
          columns={5}
          loading={recall === undefined && nodes.length === 0}
          loadingLabel={t(SA_LOADING_GRAPH)}
          empty={nodes.length === 0}
          emptyLabel={t(SA_NO_DATA)}
        >
          <thead>
            <tr>
              <th>{t(SA_COL_CONVERSATION)}</th>
              <th>Profile</th>
              <th>{t(SA_COL_OUTCOME)}</th>
              <th>{t(SA_COL_SUMMARY)}</th>
              <th className="cell-actions">{t(SA_COL_ACTIONS)}</th>
            </tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.id}>
                <ConversationCell conversationId={n.conversationId} conversationsById={conversationsById} />
                <td>{n.profileId}</td>
                <td>
                  <span className={`badge badge-${outcomeTone(n.outcome)}`}>
                    {outcomeLabel(n.outcome, locale)}
                  </span>
                </td>
                <td className="sa-summary-cell">{n.summary}</td>
                <td className="cell-actions">
                  <div className="row-actions-group">
                    <RowAction
                      label={t(SA_ACTION_OPEN_CONVERSATION)}
                      iconName="external-link"
                      onClick={() => ctx.openScreen(`conversation:${n.conversationId}`)}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </ScreenSection>

      <ScreenSection
        title={
          <>
            <HelmxIcon name="network" size={13} />
            <span>{t(SA_SUBSCRIPTIONS_TITLE)}</span>
          </>
        }
      >
        <DataTable
          columns={4}
          loading={subscriptions === undefined && subs.length === 0}
          loadingLabel={t(SA_LOADING_SUBSCRIPTIONS)}
          empty={subs.length === 0}
          emptyLabel={t(SA_NO_DATA)}
        >
          <thead>
            <tr>
              <th>ThreadKey</th>
              <th>Worker</th>
              <th>{t(SA_COL_CREATED)}</th>
              <th className="cell-actions">{t(SA_COL_ACTIONS)}</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => (
              <tr key={s.threadKey}>
                <td>{s.threadKey}</td>
                <ConversationCell conversationId={s.workerConversationId} conversationsById={conversationsById} />
                <td>{formatTime(s.createdAt)}</td>
                <td className="cell-actions">
                  <div className="row-actions-group">
                    <RowAction
                      label={t(SA_ACTION_OPEN_WORKER)}
                      iconName="external-link"
                      onClick={() => ctx.openScreen(`conversation:${s.workerConversationId}`)}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </ScreenSection>
    </Screen>
  )
}
