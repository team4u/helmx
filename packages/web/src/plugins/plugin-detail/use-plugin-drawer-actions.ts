/**
 * 插件详情抽屉的操作状态机（启停 / 受管包更新卸载 / 409 占用确认）：
 * 所有异步操作共享一条 actionGeneration 代数，切插件、开关抽屉或同插件新操作都会让迟到响应失效。
 */
import { useEffect, useRef, useState } from 'react'
import { resolveLocalizedText, type HelmxLocale, type PluginDoctorReport, type PluginSummary } from '@helmx/protocol/browser'
import { ApiClientError, pluginsApi } from '../../lib/api.js'
import type { HelmxStoreActions } from '../../lib/helmx-store.js'
import type { WebMessageTranslator } from '../../i18n/catalog.js'
import { extractPluginUsages, type PluginUsageItem } from '../plugin-card-model.js'
import {
  extractDoctorReport,
  formatUpdateResultDetail,
  isInstallSourceSubmittable,
  pluginPackageErrorText,
} from '../plugin-package-model.js'

export type PluginPackageOp = 'idle' | 'updating' | 'removing'

export interface PluginInUseConfirm {
  plugin: PluginSummary
  usages: PluginUsageItem[]
}

export interface PluginDrawerActionsOptions {
  open: boolean
  plugin: PluginSummary | null
  toggling: boolean
  externalUpdating: boolean
  actions: HelmxStoreActions | null
  locale: HelmxLocale
  t: WebMessageTranslator
  onToggleEnabled: (
    plugin: PluginSummary,
    targetEnabled?: boolean,
    options?: { force?: boolean },
  ) => Promise<void>
  onPackageChanged?: () => void
  onRemoved?: () => void
}

export function usePluginDrawerActions({
  open,
  plugin,
  toggling,
  externalUpdating,
  actions,
  locale,
  t,
  onToggleEnabled,
  onPackageChanged,
  onRemoved,
}: PluginDrawerActionsOptions) {
  const [actionError, setActionError] = useState<string | null>(null)
  // 包管理互斥状态：idle | updating | removing（与启停 toggling 独立）
  const [packageOp, setPackageOp] = useState<PluginPackageOp>('idle')
  const [editingSource, setEditingSource] = useState(false)
  const [sourceDraft, setSourceDraft] = useState('')
  const [updateDoctorReport, setUpdateDoctorReport] = useState<PluginDoctorReport | null>(null)
  const [confirmRemoveOpen, setConfirmRemoveOpen] = useState(false)
  // 409 plugin_in_use 占用确认：保存待确认的占用清单与目标插件
  const [inUseConfirm, setInUseConfirm] = useState<PluginInUseConfirm | null>(null)

  const mountedRef = useRef(true)
  const actionGeneration = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      actionGeneration.current += 1
    }
  }, [])

  // 切换插件或开关抽屉时清空全部操作态（迟到响应经代数失效）。
  useEffect(() => {
    actionGeneration.current += 1
    setActionError(null)
    setPackageOp('idle')
    setEditingSource(false)
    setSourceDraft('')
    setUpdateDoctorReport(null)
    setConfirmRemoveOpen(false)
    setInUseConfirm(null)
  }, [open, plugin?.id])

  const isCurrentAction = (generation: number): boolean =>
    mountedRef.current && actionGeneration.current === generation

  const handleToggle = async (
    targetPlugin: PluginSummary,
    targetEnabled?: boolean,
    options?: { force?: boolean },
  ) => {
    if (targetPlugin.locked || toggling) return
    const generation = ++actionGeneration.current
    setActionError(null)
    setInUseConfirm(null)
    try {
      await onToggleEnabled(targetPlugin, targetEnabled, options)
    } catch (err) {
      if (!isCurrentAction(generation)) return
      if (err instanceof ApiClientError && err.status === 409 && err.code === 'plugin_in_use') {
        // 持久资源占用：展示占用清单供用户知情后选择强制停用（固定原始 targetPlugin）
        const usages = extractPluginUsages(err.details)
        if (usages.length > 0) {
          setInUseConfirm({ plugin: targetPlugin, usages })
        } else {
          setActionError(t('plugins.drawer.disableInUseError'))
        }
      } else if (err instanceof ApiClientError && err.status === 409) {
        setActionError(t('plugins.drawer.disableLiveTasksError', { code: err.code }))
      } else {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    }
  }

  // 受管插件包：重新拉取安装来源最新版本并重载（源未变化时 changed=false，如实回显）；展开换源时携带新来源。
  const handleUpdatePackage = async () => {
    if (!plugin?.managed || packageOp !== 'idle' || externalUpdating) return
    const nextSource = editingSource ? sourceDraft.trim() : undefined
    if (editingSource && (nextSource === undefined || !isInstallSourceSubmittable(nextSource))) return
    const targetPlugin = plugin
    const generation = ++actionGeneration.current
    setPackageOp('updating')
    setActionError(null)
    setUpdateDoctorReport(null)
    try {
      const result =
        nextSource !== undefined
          ? await pluginsApi.update(targetPlugin.id, { source: nextSource })
          : await pluginsApi.update(targetPlugin.id)
      const noticeBody = formatUpdateResultDetail(result, t)
      actions?.pushNotice({
        type: 'notification',
        level: 'info',
        title: t('plugins.package.updateNoticeTitle'),
        body: t('plugins.package.updateNoticeBody', {
          name: resolveLocalizedText(targetPlugin.name, locale) || targetPlugin.id,
          detail: noticeBody,
        }),
      })
      if (isCurrentAction(generation)) {
        setEditingSource(false)
        setSourceDraft('')
      }
      onPackageChanged?.()
    } catch (err) {
      if (isCurrentAction(generation)) {
        setActionError(pluginPackageErrorText(err, t('plugins.package.action.update'), t))
        setUpdateDoctorReport(extractDoctorReport(err))
      }
    } finally {
      if (isCurrentAction(generation)) {
        setPackageOp('idle')
      }
    }
  }

  // 受管插件包卸载：确认后清理安装目录与注册记录；成功后关闭抽屉并刷新列表。
  const handleRemovePackage = async () => {
    if (!plugin?.managed || packageOp !== 'idle') return
    const targetPlugin = plugin
    const generation = ++actionGeneration.current
    setPackageOp('removing')
    setActionError(null)
    try {
      await pluginsApi.remove(targetPlugin.id)
      actions?.pushNotice({
        type: 'notification',
        level: 'info',
        title: t('plugins.package.removeNoticeTitle'),
        body: t('plugins.package.removeNoticeBody', {
          name: resolveLocalizedText(targetPlugin.name, locale) || targetPlugin.id,
          id: targetPlugin.id,
        }),
      })
      if (isCurrentAction(generation)) {
        setConfirmRemoveOpen(false)
        onRemoved?.()
      }
      onPackageChanged?.()
    } catch (err) {
      if (isCurrentAction(generation)) {
        setActionError(pluginPackageErrorText(err, t('plugins.package.action.uninstall'), t))
        setConfirmRemoveOpen(false)
      }
    } finally {
      if (isCurrentAction(generation)) {
        setPackageOp('idle')
      }
    }
  }

  const handleForceDisable = async () => {
    const pending = inUseConfirm
    if (!pending) return
    setInUseConfirm(null)
    await handleToggle(pending.plugin, false, { force: true })
  }

  return {
    actionError,
    inUseConfirm,
    packageOp,
    editingSource,
    sourceDraft,
    updateDoctorReport,
    confirmRemoveOpen,
    setEditingSource,
    setSourceDraft,
    setConfirmRemoveOpen,
    setInUseConfirm,
    handleToggle,
    handleUpdatePackage,
    handleRemovePackage,
    handleForceDisable,
  }
}

export type PluginDrawerActions = ReturnType<typeof usePluginDrawerActions>
