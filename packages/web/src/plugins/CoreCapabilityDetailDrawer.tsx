import React, { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_HELMX_LOCALE, resolveLocalizedText } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  Card,
  copyToClipboard,
  DetailDrawer,
  EmptyState,
  HelperText,
  HelmxIcon,
  KvGrid,
  MonoId,
  Stack,
} from '@helmx/ui'
import { CodeBlockView } from '../conversation/MarkdownView.js'
import { createWebTranslator } from '../i18n/catalog.js'
import { useOptionalLocale } from '../lib/store-context.js'
import {
  formatCoreCliCommand,
  formatCoreSchemaJson,
  type CoreCapabilityOwner,
} from './core-capability-model.js'

export interface CoreCapabilityDetailDrawerProps {
  owner: CoreCapabilityOwner | null
  open: boolean
  selectedActionId?: string
  onClose: () => void
  onSelectAction?: (actionId: string | undefined) => void
  onOpenSkill?: (skillId: string) => void
  inline?: boolean
}

/**
 * Read-only detail drawer for a kernel-owned `core:*` capability namespace:
 * - Built on SDK DetailDrawer (Radix Dialog, 520-560px right slide-over);
 * - Displays read-only governance status, owned actions (with deep-linkable
 *   action contract inspection) and managed skills with one-click navigation
 *   to Skills Center.
 */
export function CoreCapabilityDetailDrawer({
  owner,
  open,
  selectedActionId,
  onClose,
  onSelectAction,
  onOpenSkill,
  inline = false,
}: CoreCapabilityDetailDrawerProps): React.JSX.Element {
  const storeLocale = useOptionalLocale()
  const locale = storeLocale ?? DEFAULT_HELMX_LOCALE
  const t = useMemo(() => createWebTranslator(locale), [locale])
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const handleCopyActionId = async (text: string): Promise<void> => {
    const ok = await copyToClipboard(text)
    if (!mountedRef.current) return
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    setCopyStatus(ok ? 'copied' : 'failed')
    copyTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setCopyStatus('idle')
    }, ok ? 1500 : 2000)
  }

  const copyActionLabel =
    copyStatus === 'copied'
      ? resolveLocalizedText({ en: 'Copied', 'zh-CN': '已复制' }, locale)
      : copyStatus === 'failed'
        ? resolveLocalizedText({ en: 'Copy failed', 'zh-CN': '复制失败' }, locale)
        : t('plugins.core.copyActionId')

  const selectedAction = useMemo(() => {
    if (!owner || !selectedActionId) return null
    return owner.actions.find((action) => action.id === selectedActionId) ?? null
  }, [owner, selectedActionId])

  const isMissingAction = Boolean(owner && selectedActionId && selectedAction === null)

  return (
    <DetailDrawer
      open={open}
      inline={inline}
      onClose={onClose}
      overlayClassName="plugin-drawer-backdrop"
      className="plugin-drawer-content"
      title={owner?.name ?? t('plugins.core.drawerTitleFallback')}
      titleExtra={
        owner ? (
          <>
            <Badge tone="accent" icon="shield" title={t('plugins.core.readOnlyHint')}>
              {t('plugins.core.badge')}
            </Badge>
            <Badge tone="neutral" icon="lock">
              {t('plugins.core.readOnly')}
            </Badge>
          </>
        ) : undefined
      }
      meta={owner ? <MonoId value={owner.id} /> : undefined}
      metaClassName="text-subtle break-word"
      belowTitle={
        owner ? <div className="plugin-drawer-desc">{owner.description}</div> : undefined
      }
      aria-label={
        owner
          ? t('plugins.core.drawerAriaSelected', { name: owner.name })
          : t('plugins.core.drawerTitleFallback')
      }
      closeLabel={t('common.close')}
    >
      {!owner ? (
        <EmptyState compact title={t('plugins.core.noSelection')} />
      ) : (
        <>
          <Card variant="subtle">
            <Stack direction="horizontal" gap="sm" align="center" justify="between" wrap>
              <Stack direction="horizontal" gap="sm" align="center">
                <Badge tone="ok" icon="check">
                  {t('plugins.core.alwaysActive')}
                </Badge>
                <span className="text-subtle">{t('plugins.core.readOnlyHint')}</span>
              </Stack>
            </Stack>
          </Card>

          <Card
            variant="subtle"
            title={
              <Stack direction="horizontal" gap="xs" align="center" inline>
                <HelmxIcon name="zap" size={13} />
                <span>{t('plugins.core.actionsSection', { count: owner.actions.length })}</span>
              </Stack>
            }
          >
            <Stack direction="vertical" gap="sm">
              {isMissingAction && selectedActionId && (
                <Callout tone="warn">
                  <span className="callout-text" role="alert">
                    {t('plugins.core.actionNotFound', { action: `${owner.id}.${selectedActionId}` })}
                  </span>
                </Callout>
              )}

              {owner.actions.length === 0 ? (
                <HelperText>{t('plugins.drawer.noActions')}</HelperText>
              ) : (
                <Stack direction="vertical" gap="xs">
                  {owner.actions.map((action) => {
                    const isSelected = selectedAction?.id === action.id
                    const cliCommand = formatCoreCliCommand(action)
                    return (
                      <Card
                        key={action.id}
                        variant="subtle"
                        className={isSelected ? 'border-accent' : undefined}
                        data-core-action-item={action.id}
                      >
                        <Stack direction="horizontal" align="center" justify="between" gap="sm" wrap>
                          <Button
                            variant={isSelected ? 'secondary' : 'ghost'}
                            size="xs"
                            icon={isSelected ? 'chevron-down' : 'chevron-right'}
                            aria-pressed={isSelected}
                            onClick={() => onSelectAction?.(isSelected ? undefined : action.id)}
                          >
                            <span className="mono">{action.id}</span>
                          </Button>
                          <Stack direction="horizontal" gap="xs" align="center" wrap>
                            {cliCommand && (
                              <Badge tone="neutral" mono>
                                {cliCommand}
                              </Badge>
                            )}
                            {action.idempotent && (
                              <Badge tone="ok">{t('plugins.core.idempotent')}</Badge>
                            )}
                            {action.visibility && action.visibility !== 'public' && (
                              <Badge tone="neutral">{action.visibility}</Badge>
                            )}
                          </Stack>
                        </Stack>
                        {action.description && (
                          <div className="text-muted break-word">{action.description}</div>
                        )}
                      </Card>
                    )
                  })}
                </Stack>
              )}

              {selectedAction && (
                <Card
                  variant="elevated"
                  data-core-action-detail={selectedAction.id}
                  title={
                    <span className="mono break-word">
                      {t('plugins.core.actionDetailTitle', {
                        id: `${owner.id}.${selectedAction.id}`,
                      })}
                    </span>
                  }
                  actions={
                    <Stack direction="horizontal" gap="xs" align="center">
                      <Button
                        variant="ghost"
                        size="xs"
                        icon={copyStatus === 'copied' ? 'check' : copyStatus === 'failed' ? 'alert-circle' : 'copy'}
                        title={copyActionLabel}
                        aria-label={copyActionLabel}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleCopyActionId(`${owner.id}.${selectedAction.id}`)
                        }}
                      >
                        <span>{copyActionLabel}</span>
                      </Button>
                      {onSelectAction && (
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => onSelectAction(undefined)}
                        >
                          {t('plugins.core.closeActionDetail')}
                        </Button>
                      )}
                    </Stack>
                  }
                >
                  <Stack direction="vertical" gap="sm">
                    {selectedAction.description && (
                      <div className="text-muted break-word selectable">
                        {selectedAction.description}
                      </div>
                    )}
                    <KvGrid
                      items={[
                        {
                          key: t('plugins.core.field.actionId'),
                          value: <MonoId value={`${owner.id}.${selectedAction.id}`} />,
                        },
                        ...(formatCoreCliCommand(selectedAction)
                          ? [
                              {
                                key: t('plugins.core.field.cliCommand'),
                                value: (
                                  <Stack direction="horizontal" gap="xs" align="center" wrap>
                                    <MonoId value={formatCoreCliCommand(selectedAction)!} />
                                    {selectedAction.cli?.hidden && (
                                      <Badge tone="neutral">{t('plugins.core.cliHidden')}</Badge>
                                    )}
                                  </Stack>
                                ),
                              },
                            ]
                          : []),
                        {
                          key: t('plugins.core.field.visibility'),
                          value: (
                            <Badge tone="neutral" mono>
                              {selectedAction.visibility ?? 'public'}
                            </Badge>
                          ),
                        },
                        {
                          key: t('plugins.core.field.idempotency'),
                          value: (
                            <Badge tone={selectedAction.idempotent ? 'ok' : 'neutral'}>
                              {selectedAction.idempotent
                                ? t('plugins.core.idempotent')
                                : t('plugins.core.nonIdempotent')}
                            </Badge>
                          ),
                        },
                        {
                          key: t('plugins.core.field.promptExposure'),
                          value:
                            selectedAction.exposeToPrompt === false
                              ? t('plugins.core.onDemandOnly')
                              : t('plugins.core.exposed'),
                        },
                        {
                          key: t('plugins.core.field.toolExposure'),
                          value: selectedAction.exposeAsTool
                            ? (selectedAction.toolName ?? t('plugins.core.exposed'))
                            : t('plugins.core.notExposed'),
                        },
                      ]}
                    />

                    <div className="flex-col-xs">
                      <span className="text-subtle">{t('plugins.core.inputSchema')}</span>
                      <CodeBlockView
                        code={formatCoreSchemaJson(selectedAction.inputSchema)}
                        language="json"
                      />
                    </div>
                    <div className="flex-col-xs">
                      <span className="text-subtle">{t('plugins.core.outputSchema')}</span>
                      <CodeBlockView
                        code={formatCoreSchemaJson(selectedAction.outputSchema)}
                        language="json"
                      />
                    </div>
                  </Stack>
                </Card>
              )}
            </Stack>
          </Card>

          <Card
            variant="subtle"
            title={
              <Stack direction="horizontal" gap="xs" align="center" inline>
                <HelmxIcon name="sparkles" size={13} />
                <span>{t('plugins.core.skillsSection', { count: owner.skills.length })}</span>
              </Stack>
            }
          >
            {owner.skills.length === 0 ? (
              <HelperText>{t('plugins.core.noManagedSkills')}</HelperText>
            ) : (
              <Stack direction="vertical" gap="xs">
                {owner.skills.map((skill) => (
                  <Card
                    key={skill.id}
                    variant="subtle"
                    data-core-managed-skill={skill.id}
                  >
                    <Stack direction="horizontal" align="center" justify="between" gap="sm" wrap>
                      <Stack direction="horizontal" gap="xs" align="center" wrap>
                        <strong className="helmx-card-title">{skill.name || skill.id}</strong>
                        <MonoId value={skill.id} />
                        {(skill.references?.length ?? 0) > 0 && (
                          <Badge tone="neutral" icon="file-text" className="tabular-nums">
                            {String(skill.references.length)}
                          </Badge>
                        )}
                      </Stack>
                      {onOpenSkill && (
                        <Button
                          variant="secondary"
                          size="xs"
                          icon="arrow-up-right"
                          data-core-open-skill={skill.id}
                          onClick={() => onOpenSkill(skill.id)}
                        >
                          {t('plugins.core.openSkill')}
                        </Button>
                      )}
                    </Stack>
                    {skill.description && (
                      <div className="text-muted break-word">{skill.description}</div>
                    )}
                  </Card>
                ))}
              </Stack>
            )}
          </Card>
        </>
      )}
    </DetailDrawer>
  )
}
