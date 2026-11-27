/**
 * Settings panel summary entrypoint for `builtin:port-forward` (`PortForwardSettingsPanel`).
 * Fast Refresh compliant: exports only React components and TypeScript types.
 */
import { useMemo, type ReactNode } from 'react'
import './styles.css'
import {
  Button,
  HelmxIcon,
  KvGrid,
  LoadingState,
  ScreenSection,
  Stack,
} from '@helmx/ui'
import {
  usePluginConfig,
  usePluginContext,
  usePluginDoc,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  PF_RULES_DOC,
  PF_RUNTIME_DOC,
  buildScreenTarget,
  parseRulesDoc,
  parseRuntimeDoc,
} from './models.ts'
import {
  PF_KV_ACTIVE_CONNS,
  PF_KV_LISTENING,
  PF_KV_TOTAL_RULES,
  PF_LOADING,
  PF_OPEN_MANAGER,
  PF_SCREEN_TITLE,
  PF_SETTINGS_ALLOWED,
  PF_SETTINGS_ALLOW_PUBLIC,
  PF_SETTINGS_DENIED,
  PF_SETTINGS_NOTE,
} from './copy.ts'

export function PortForwardSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const rawRules = usePluginDoc(PF_RULES_DOC)
  const rawRuntime = usePluginDoc(PF_RUNTIME_DOC)
  const config = usePluginConfig<{ allowPublicBind?: boolean }>()
  const allowPublicBind = config.allowPublicBind === true

  const rules = useMemo(() => parseRulesDoc(rawRules), [rawRules])
  const runtimeById = useMemo(() => parseRuntimeDoc(rawRuntime), [rawRuntime])

  const listeningCount = rules.filter((r) => runtimeById[r.id]?.listenerState === 'listening').length
  const activeConns = rules.reduce((sum, r) => sum + (runtimeById[r.id]?.activeConnections ?? 0), 0)

  return (
    <ScreenSection
      title={
        <span className="pf-status-cell">
          <HelmxIcon name="network" size={13} />
          <span>{t(PF_SCREEN_TITLE)}</span>
        </span>
      }
    >
      <Stack gap="md">
        {rawRules === undefined ? (
          <LoadingState label={t(PF_LOADING)} />
        ) : (
          <KvGrid
            items={[
              { key: t(PF_KV_TOTAL_RULES), value: rules.length },
              { key: t(PF_KV_LISTENING), value: listeningCount },
              { key: t(PF_KV_ACTIVE_CONNS), value: activeConns },
              {
                key: t(PF_SETTINGS_ALLOW_PUBLIC),
                value: allowPublicBind ? t(PF_SETTINGS_ALLOWED) : t(PF_SETTINGS_DENIED),
              },
            ]}
          />
        )}
        <p className="text-muted">{t(PF_SETTINGS_NOTE)}</p>
        <div>
          <Button
            size="sm"
            variant="secondary"
            icon="external-link"
            onClick={() => ctx.openScreen(buildScreenTarget({}))}
          >
            {t(PF_OPEN_MANAGER)}
          </Button>
        </div>
      </Stack>
    </ScreenSection>
  )
}
