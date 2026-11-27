/**
 * Markdown 代码块扩展分派器（宿主机制，零业务特判）：
 * - 有插件注册命中当前语言（priority 裁决）→ 动态加载其 client 组件渲染
 *   （loading / 加载失败 / 渲染异常均显式展示并可复制源码，绝不静默空白）；
 * - 无命中（含插件停用后贡献消失）→ 回退宿主普通代码块；
 * - 不 import 任何具体语言实现（JSON / Mermaid 均为插件）。
 */
import type { ReactNode } from 'react'
import type { MarkdownCodeBlockProps } from '@helmx/protocol/browser'
import { Button, CopyButton, HelmxIcon, LoadingState, ViewBoundary } from '@helmx/ui'
import { PluginClientContext, PluginScope } from '@helmx/plugin-client'
import { isPluginSummaryActive } from '../lib/live-state.js'
import { usePluginsUi } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { getPluginClientCacheRevision } from '../lib/plugin-client.js'
import { usePluginClientComponent } from '../ui/use-plugin-client-component.js'
import { matchMarkdownCodeBlock } from './codeblock-registry-model.js'
import { StandardCodeBlock } from './StandardCodeBlock.js'

function CodeBlockError({ language, code, message, onRetry }: { language: string; code: string; message: string; onRetry: () => void }): ReactNode {
  const { t } = useWebLocale()
  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span>{language}</span>
        <CopyButton text={code} />
      </div>
      <div className="callout callout-error" role="alert">
        <HelmxIcon name="alert-triangle" size={13} />
        <div>
          <strong>{t('conv.codeblock.renderFailed')}</strong>
          <p className="selectable">{message}</p>
          <Button size="sm" onClick={onRetry}>{t('conv.codeblock.retryLoading')}</Button>
        </div>
      </div>
      <pre className="code-block-pre code-block-pre-flush selectable">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function CodeBlockRenderer({ language, code, conversationId }: { language: string; code: string; conversationId?: number }): ReactNode {
  const { uiContributions, plugins } = usePluginsUi()
  const match = matchMarkdownCodeBlock(uiContributions, language)

  if (match === null || match.spec.client === undefined) {
    return <StandardCodeBlock language={language} code={code} />
  }
  const plugin = plugins.find((p) => p.id === match.pluginId)
  const expectedHash =
    plugin !== undefined && isPluginSummaryActive(plugin)
      ? plugin.clientHashes?.[match.spec.client.module]
      : undefined
  return (
    <PluginCodeBlock
      key={`${match.pluginId}:${match.spec.id}:${language}:${getPluginClientCacheRevision(match.pluginId)}`}
      pluginId={match.pluginId}
      clientRef={match.spec.client}
      expectedHash={expectedHash}
      language={language}
      code={code}
      conversationId={conversationId}
    />
  )
}

function PluginCodeBlock(props: {
  pluginId: string
  clientRef: { module: string; export: string }
  expectedHash?: string
  language: string
  code: string
  conversationId?: number
}): ReactNode {
  const { pluginId, clientRef, expectedHash, language, code, conversationId } = props
  const { t } = useWebLocale()
  const { ctx, client, retryModule } = usePluginClientComponent<MarkdownCodeBlockProps>({
    pluginId,
    clientRef,
    expectedHash,
    conversationId,
  })

  if (client.phase === 'loading') {
    return (
      <div className="code-block-wrap">
        <div className="code-block-header">
          <span>{language}</span>
        </div>
        <LoadingState label={t('conv.codeblock.loadingRenderer', { language })} iconSize={13} className="callout code-block-loading" />
      </div>
    )
  }
  if (client.phase === 'error') {
    return (
      <CodeBlockError
        language={language}
        code={code}
        message={client.message}
        onRetry={retryModule}
      />
    )
  }

  const { Component } = client
  return (
    <ViewBoundary label={t('conv.codeblock.viewBoundary', { language })}>
      <PluginClientContext.Provider value={ctx}>
        <PluginScope>
          <Component language={language} code={code} conversationId={conversationId} />
        </PluginScope>
      </PluginClientContext.Provider>
    </ViewBoundary>
  )
}
