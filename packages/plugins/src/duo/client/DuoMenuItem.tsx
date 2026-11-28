/**
 * Composer `+` menu item (`COMPOSER_MENU_SLOT`) for toggling `builtin:duo` on top-level
 * human conversations and standby drafts.
 * Exports only React components and TS types (Fast Refresh compliant).
 */
import { useMemo, useState, type ReactNode } from 'react'
import type { ComposerMenuSlotProps } from '@helmx/protocol/browser'
import { DropdownMenuItem, HelmxIcon } from '@helmx/ui'
import {
  usePluginAction,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginSessionDoc,
  usePluginTranslator,
} from '@helmx/plugin-client'
import { DUO_COPY as C, duoActionFailed } from './copy.ts'
import { DuoSetupDialog } from './DuoSetupDialog.tsx'
import {
  DUO_PLUGIN_ID,
  DUO_PROFILES_DOC,
  DUO_SESSION_DOC,
  isDuoEligibleConversation,
  parseDuoProfilesDoc,
  parseDuoSessionDoc,
  parseDuoStandbyMeta,
} from './models.ts'
import { duoSetupTargetKey, requestDuoSetup } from './setup-bus.ts'

function DuoMenuItemConversation({
  conversationId,
  profileId,
  disabled,
  onCloseMenu,
}: {
  conversationId: number
  profileId?: string
  disabled: boolean
  onCloseMenu?: () => void
}): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const locale = usePluginLocale()
  const rawSession = usePluginSessionDoc(DUO_SESSION_DOC, { conversationId })
  const rawProfiles = usePluginDoc(DUO_PROFILES_DOC)
  const session = useMemo(() => parseDuoSessionDoc(rawSession), [rawSession])
  const profiles = useMemo(() => parseDuoProfilesDoc(rawProfiles), [rawProfiles])
  const profileCfg = profileId ? profiles[profileId] : undefined

  const actions = usePluginAction({
    formatError: (err) => duoActionFailed(err, locale),
  })
  const [fallbackDialogOpen, setFallbackDialogOpen] = useState(false)

  const active = session?.enabled === true

  const handleSelect = (): void => {
    if (actions.pending || disabled) return
    if (active) {
      void (async () => {
        const res = profileCfg?.enabled
          ? await actions.run(
              'set_conversation',
              { conversationId, enabled: false },
              { conversationId },
            )
          : await actions.run('clear_conversation', { conversationId }, { conversationId })
        if (res === undefined && actions.error) ctx.notify(actions.error, 'error')
      })()
      onCloseMenu?.()
      return
    }

    if (profileCfg?.enabled) {
      void actions.run('clear_conversation', { conversationId }, { conversationId })
      onCloseMenu?.()
      return
    }
    if (profileCfg?.executorModel) {
      void actions.run(
        'set_conversation',
        {
          conversationId,
          enabled: true,
          executorModel: profileCfg.executorModel,
          ...(profileCfg.executorThinkingLevel
            ? { executorThinkingLevel: profileCfg.executorThinkingLevel }
            : {}),
          maxExecutionSteps: profileCfg.maxExecutionSteps,
        },
        { conversationId },
      )
      onCloseMenu?.()
      return
    }

    const handledByToolbar = requestDuoSetup(duoSetupTargetKey(conversationId, profileId))
    if (handledByToolbar) {
      onCloseMenu?.()
      return
    }
    setFallbackDialogOpen(true)
  }

  return (
    <>
      <DropdownMenuItem
        className={`duo-menu-item${active ? ' duo-menu-item--active' : ''}`}
        icon={actions.pending ? <HelmxIcon name="loader" size={14} className="spin-slow" /> : 'git-pull-request'}
        checked={active}
        disabled={disabled || actions.pending}
        data-duo-enabled={active ? 'true' : 'false'}
        onSelect={handleSelect}
      >
        {t(C.menuLabel)}
      </DropdownMenuItem>
      <DuoSetupDialog
        open={fallbackDialogOpen}
        pending={actions.pending}
        error={actions.error ?? null}
        onClose={() => setFallbackDialogOpen(false)}
        onConfirm={(cfg) => {
          void (async () => {
            const res = await actions.run(
              'set_conversation',
              {
                conversationId,
                enabled: true,
                ...cfg,
              },
              { conversationId },
            )
            if (res !== undefined) setFallbackDialogOpen(false)
          })()
        }}
      />
    </>
  )
}

function DuoMenuItemStandby({
  profileId,
  draftMeta,
  setDraftMeta,
  disabled,
  onCloseMenu,
}: {
  profileId: string
  draftMeta?: Readonly<Record<string, unknown>>
  setDraftMeta: (key: string, value: unknown) => void
  disabled: boolean
  onCloseMenu?: () => void
}): ReactNode {
  const t = usePluginTranslator()
  const rawProfiles = usePluginDoc(DUO_PROFILES_DOC)
  const profiles = useMemo(() => parseDuoProfilesDoc(rawProfiles), [rawProfiles])
  const profileCfg = profiles[profileId]
  const standby = parseDuoStandbyMeta(draftMeta)

  const [fallbackDialogOpen, setFallbackDialogOpen] = useState(false)

  const active = standby !== undefined ? standby.enabled : profileCfg?.enabled === true

  const handleSelect = (): void => {
    if (disabled) return
    if (active) {
      setDraftMeta(DUO_PLUGIN_ID, profileCfg?.enabled ? { enabled: false } : undefined)
      onCloseMenu?.()
      return
    }
    if (profileCfg?.enabled) {
      setDraftMeta(DUO_PLUGIN_ID, undefined)
      onCloseMenu?.()
      return
    }
    if (profileCfg?.executorModel) {
      setDraftMeta(DUO_PLUGIN_ID, {
        enabled: true,
        executorModel: profileCfg.executorModel,
        ...(profileCfg.executorThinkingLevel
          ? { executorThinkingLevel: profileCfg.executorThinkingLevel }
          : {}),
        maxExecutionSteps: profileCfg.maxExecutionSteps,
      })
      onCloseMenu?.()
      return
    }

    const handledByToolbar = requestDuoSetup(duoSetupTargetKey(undefined, profileId))
    if (handledByToolbar) {
      onCloseMenu?.()
      return
    }
    setFallbackDialogOpen(true)
  }

  return (
    <>
      <DropdownMenuItem
        className={`duo-menu-item${active ? ' duo-menu-item--active' : ''}`}
        icon="git-pull-request"
        checked={active}
        disabled={disabled}
        data-duo-enabled={active ? 'true' : 'false'}
        onSelect={handleSelect}
      >
        {t(C.menuLabel)}
      </DropdownMenuItem>
      <DuoSetupDialog
        open={fallbackDialogOpen}
        onClose={() => setFallbackDialogOpen(false)}
        onConfirm={(cfg) => {
          setDraftMeta(DUO_PLUGIN_ID, { enabled: true, ...cfg })
          setFallbackDialogOpen(false)
        }}
      />
    </>
  )
}

export function DuoMenuItem(props: ComposerMenuSlotProps): ReactNode {
  if (props.conversation !== undefined) {
    if (!isDuoEligibleConversation(props.conversation)) {
      return null
    }
    return (
      <DuoMenuItemConversation
        conversationId={props.conversation.id}
        profileId={props.conversation.profileId}
        disabled={props.disabled === true}
        onCloseMenu={props.onCloseMenu}
      />
    )
  }
  if (props.profileId === undefined || props.setDraftMeta === undefined) {
    return null
  }
  return (
    <DuoMenuItemStandby
      profileId={props.profileId}
      draftMeta={props.draftMeta}
      setDraftMeta={props.setDraftMeta}
      disabled={props.disabled === true}
      onCloseMenu={props.onCloseMenu}
    />
  )
}
