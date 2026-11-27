import React, { useEffect, useMemo, useState } from 'react'
import { DEFAULT_HELMX_LOCALE, type PluginDoctorReport } from '@helmx/protocol/browser'
import { pluginsApi } from '../lib/api.js'
import { createWebTranslator } from '../i18n/catalog.js'
import { useOptionalLocale } from '../lib/store-context.js'
import {
  Button,
  Callout,
  Field,
  Input,
  ModalDialog,
  Stack,
  Switch,
} from '@helmx/ui'
import {
  detectPluginSourceKind,
  extractDoctorReport,
  isInstallSourceSubmittable,
  pluginPackageErrorText,
} from './plugin-package-model.js'
import { PluginDoctorChecks } from './PluginDoctorChecks.js'

export interface PluginInstallModalProps {
  open: boolean
  onClose: () => void
  /** 安装成功（服务端已注册插件）后回调；携带新插件 id 供导航进详情抽屉与启用诊断。 */
  onInstalled: (pluginId: string, enableError?: { code: string; message: string }) => void
  /** 显式指定是否内联渲染（便于测试与 SSR 统一断言） */
  inline?: boolean
}

/**
 * 插件中心「安装插件」轻量模态：
 * - 接受 npm / git / 本地路径三类来源，输入旁即时识别来源类别；
 * - 如实告知安全边界：插件在 Hub 进程内运行、拥有宿主权限，不是沙箱；
 * - 安装中禁重复提交；失败时展示结构化 doctor 检查结果或错误诊断；
 * - 成功后刷新插件列表并导航至新插件详情抽屉（由父级完成）。
 */
export function PluginInstallModal({
  open,
  onClose,
  onInstalled,
  inline = false,
}: PluginInstallModalProps): React.JSX.Element {
  const storeLocale = useOptionalLocale()
  const locale = storeLocale ?? DEFAULT_HELMX_LOCALE
  const t = useMemo(() => createWebTranslator(locale), [locale])
  const [source, setSource] = useState('')
  const [enableAfterInstall, setEnableAfterInstall] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [doctorReport, setDoctorReport] = useState<PluginDoctorReport | null>(null)
  const [errorText, setErrorText] = useState<string | null>(null)

  const trimmed = source.trim()
  const hint = detectPluginSourceKind(trimmed, t)
  const submittable = !installing && trimmed !== '' && isInstallSourceSubmittable(trimmed)

  // 打开时重置草稿与历史诊断；关闭期间不保留上次输入（草稿不进 URL/hash）。
  useEffect(() => {
    if (open) {
      setSource('')
      setEnableAfterInstall(false)
      setInstalling(false)
      setDoctorReport(null)
      setErrorText(null)
    }
  }, [open])

  const handleInstall = async () => {
    if (!submittable) return
    setInstalling(true)
    setErrorText(null)
    setDoctorReport(null)
    try {
      const result = await pluginsApi.install(trimmed, enableAfterInstall)
      // 安装成功：交由父级刷新列表并导航至新插件详情抽屉；启用失败仍如实向父级传递。
      onInstalled(result.summary.id, result.enableError)
      onClose()
    } catch (err) {
      // 安装失败时如实展示错误；doctor 报告（真实 Hub 在 details.report，经形状校验）逐项渲染。
      setErrorText(pluginPackageErrorText(err, t('plugins.package.action.install'), t))
      const report = extractDoctorReport(err)
      if (report) setDoctorReport(report)
    } finally {
      setInstalling(false)
    }
  }

  return (
    <ModalDialog
      open={open}
      onClose={onClose}
      size="md"
      icon="download"
      title={t('plugins.installPlugin')}
      description={t('plugins.install.description')}
      closeDisabled={installing}
      closeLabel={t('common.close')}
      inline={inline}
      className="plugin-install-modal"
      footer={
        <>
          <Button variant="ghost" size="sm" disabled={installing} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon="download"
            pending={installing}
            disabled={!submittable}
            onClick={() => void handleInstall()}
          >
            {installing ? t('plugins.install.installing') : t('plugins.install.submit')}
          </Button>
        </>
      }
    >
      <Stack direction="vertical" gap="md">
        <Field
          label={t('plugins.install.sourceLabel')}
          htmlFor="plugin-install-source"
        >
          <Input
            mono
            type="text"
            placeholder="npm:pkg@1.0.0 / git:repo@ref / https://…git / /abs/path"
            value={source}
            invalid={trimmed !== '' && hint.kind === 'unknown'}
            spellCheck={false}
            autoComplete="off"
            disabled={installing}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && submittable) {
                e.preventDefault()
                void handleInstall()
              }
            }}
          />
          {trimmed !== '' && (
            <span
              className={`plugin-source-hint${hint.kind === 'unknown' ? ' is-unknown' : ''}`}
              data-source-kind={hint.kind}
            >
              {hint.label}
            </span>
          )}
        </Field>

        <Field
          label={t('plugins.install.enableAfterInstall')}
          htmlFor={false}
        >
          <Switch
            checked={enableAfterInstall}
            onChange={setEnableAfterInstall}
            disabled={installing}
            label={enableAfterInstall ? t('plugins.install.enableNow') : t('plugins.install.keepDisabled')}
          />
        </Field>

        <Callout tone="warn">
          <span className="callout-text plugin-install-security" role="note">
            {t('plugins.install.securityWarning')}
          </span>
        </Callout>

        {errorText && (
          <Callout tone="err">
            <span className="callout-text selectable" role="alert">{errorText}</span>
          </Callout>
        )}

        {doctorReport && <PluginDoctorChecks report={doctorReport} />}
      </Stack>
    </ModalDialog>
  )
}
