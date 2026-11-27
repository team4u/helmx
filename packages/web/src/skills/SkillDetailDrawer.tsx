import React, { useEffect, useMemo, useRef, useState } from 'react'
import { resolveLocalizedText, type SkillSummary } from '@helmx/protocol/browser'
import {
  Badge,
  Button,
  Callout,
  copyToClipboard,
  DetailDrawer,
  EmptyState,
  HelmxIcon,
  LoadingState,
  MonoId,
  SegmentedControl,
  Select,
  Stack,
  type BadgeTone,
  type SelectOption,
} from '@helmx/plugin-client'
import { CodeBlockView, MarkdownView } from '../conversation/MarkdownView.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useOptionalStoreActions } from '../lib/store-context.js'
import type { ResolvedTarget } from '../lib/types.js'
import {
  getSkillSourceBadge,
  resolveSkillOwnerTarget,
  skillsApi,
} from './skill-center-model.js'
import {
  buildSkillFileList,
  isSkillMarkdownFile,
  renderSkillDocMarkdown,
  skillFileLanguage,
} from './skill-reader-model.js'
import type { SkillScope } from './skill-scope-model.js'

export interface SkillDetailDrawerProps {
  skill: SkillSummary | null
  open: boolean
  onClose: () => void
  /** Whether the parent SkillCenter is mounted in the split pane (keeps owner navigation pane-aware). */
  isSplit?: boolean
  /** Optional pane-aware owner navigation callback (defaults to store openTarget honoring `isSplit`). */
  onOpenOwner?: (target: Extract<ResolvedTarget, { kind: 'plugins' }>) => void
  /** Render inline explicitly (for tests and unified SSR assertions). */
  inline?: boolean
  /** Initial content injection (mainly for SSR tests asserting the doc area). */
  initialContent?: string
  /** Custom file reading implementation; defaults to skillsApi.read. */
  readSkill?: (id: string, path?: string) => Promise<{ text: string }>
  /** Physical coordinates of the current scope: node-sourced skills display
   * their node workspace provenance (and are read via the caller's reader). */
  nodeScope?: SkillScope
}

/** Reading mode for Markdown files: rich rendering or monospace source. */
type SkillViewMode = 'rich' | 'source'

/**
 * Skill center detail drawer with a compact file reader:
 * - built on the Radix UI Dialog wrapper, 520px-560px right slide-over;
 * - header shows the icon, name, source badge (built-in / shared / workspace /
 *   plugin), skill ID and the close button;
 * - below the header is a single-row compact file toolbar, then one scrolling
 *   reader area filling the rest of the viewport;
 * - multiple files switch through the common Select dropdown (short file name
 *   + directory hint); a single file shows its name directly, no file tab
 *   wall;
 * - Markdown files support rich-text / source dual-mode reading, unified
 *   across desktop and mobile: rich mode converts the leading YAML
 *   frontmatter into a "skill metadata" Markdown table inside the single
 *   .skill-reader-doc content flow (no mobile-specific metadata layout, no
 *   standalone description block between toolbar and body); source mode keeps
 *   the raw YAML unconverted; code files use CodeBlockView with
 *   suffix-derived highlighting;
 * - async reads go through skillsApi.read with algebraic race protection
 *   (loadGenerationRef) so interleaved loads never overwrite each other;
 * - follows the zero-emoji rule and Fast Refresh conventions strictly.
 */
export function SkillDetailDrawer({
  skill,
  open,
  onClose,
  isSplit = false,
  onOpenOwner,
  inline = false,
  initialContent,
  readSkill,
  nodeScope,
}: SkillDetailDrawerProps): React.JSX.Element {
  const { locale, t } = useWebLocale()
  const actions = useOptionalStoreActions()
  const [loading, setLoading] = useState(false)
  const [content, setContent] = useState<string>(() => initialContent ?? '')
  const [error, setError] = useState<string | null>(null)
  const [activePath, setActivePath] = useState<string>('')
  const [viewMode, setViewMode] = useState<SkillViewMode>('rich')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  const loadGenerationRef = useRef(0)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    }
  }, [])

  const handleCopyContent = async (): Promise<void> => {
    const ok = await copyToClipboard(content)
    if (!mountedRef.current) return
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
    setCopyStatus(ok ? 'copied' : 'failed')
    copyTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setCopyStatus('idle')
    }, ok ? 1500 : 2000)
  }

  const copyButtonLabel =
    copyStatus === 'copied'
      ? t('skills.card.copied')
      : copyStatus === 'failed'
        ? resolveLocalizedText({ en: 'Copy failed', 'zh-CN': '复制失败' }, locale)
        : t('skills.drawer.copy')

  const files = useMemo(() => buildSkillFileList(skill?.references, t), [skill?.references, t])
  const activeIndex = Math.max(
    0,
    files.findIndex((f) => f.path === activePath),
  )
  const activeFile = files[activeIndex]
  const activeDisplayPath = activeFile?.displayPath ?? 'SKILL.md'
  const isMarkdown = isSkillMarkdownFile(activePath)
  const richText = isMarkdown && viewMode === 'rich'

  // Switching skills resets to the root SKILL.md and rich-text mode
  useEffect(() => {
    setActivePath('')
    setViewMode('rich')
  }, [skill?.id])

  // Async load of the skill file content with strict race protection
  useEffect(() => {
    if (!skill || !open) {
      if (initialContent === undefined) {
        setContent('')
      }
      setError(null)
      setLoading(false)
      return
    }

    const gen = ++loadGenerationRef.current
    setLoading(true)
    setError(null)

    const reader = readSkill ?? skillsApi.read
    reader(skill.id, activePath || undefined)
      .then((res) => {
        if (loadGenerationRef.current === gen) {
          setContent(res.text ?? '')
          setLoading(false)
        }
      })
      .catch((err) => {
        if (loadGenerationRef.current === gen) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })
  }, [skill?.id, activePath, open, readSkill, initialContent])

  const sourceBadge = skill ? getSkillSourceBadge(skill, t) : null
  const badgeTone: BadgeTone =
    sourceBadge?.variant === 'agents' || sourceBadge?.variant === 'node' || sourceBadge?.variant === 'core'
      ? 'accent'
      : 'neutral'
  const isDiscoveryRoot = skill?.source === 'agents' || skill?.source === 'node'
  const ownerTarget = skill !== null && !isDiscoveryRoot ? resolveSkillOwnerTarget(skill.managedByPlugin) : null

  const fileOptions: Array<SelectOption<string>> = files.map((f) => ({
    value: f.path,
    label: f.fileName,
    meta: f.meta,
  }))

  const displayText = richText ? renderSkillDocMarkdown(content, t) : content
  const sourceLanguage = skillFileLanguage(activePath)
  const lineCount = content === '' ? 0 : content.split('\n').length

  return (
    <DetailDrawer
      open={open}
      inline={inline}
      onClose={onClose}
      overlayClassName="skill-drawer-backdrop"
      className="skill-drawer-content"
      title={skill?.name || skill?.id || t('skills.drawer.detailsFallback')}
      titleClassName="break-word"
      titleExtra={
        sourceBadge ? (
          <Badge
            tone={badgeTone}
            mono={sourceBadge.variant === 'plugin'}
            title={t('skills.card.sourceTitle', { label: sourceBadge.label })}
          >
            {sourceBadge.label}
          </Badge>
        ) : undefined
      }
      meta={skill ? <MonoId value={skill.id} /> : undefined}
      metaClassName="text-subtle break-word"
      belowTitle={
        <>
          {skill?.source === 'agents' && (
            <div className="text-subtle">{t('skills.drawer.machineSharedRoot')}</div>
          )}
          {skill?.source === 'node' && nodeScope !== undefined && (
            <div
              className="text-subtle break-word"
              title={nodeScope.cwd ? `${nodeScope.nodeId} ${nodeScope.cwd}` : nodeScope.nodeId}
            >
              {nodeScope.cwd
                ? t('skills.drawer.nodeWorkspaceSource', { node: nodeScope.nodeId, cwd: nodeScope.cwd })
                : t('skills.drawer.nodeSource', { node: nodeScope.nodeId })}
            </div>
          )}
          {ownerTarget !== null && skill?.managedByPlugin && (
            <Stack direction="horizontal" gap="xs" align="center" wrap className="text-subtle">
              <span>{t('skills.drawer.managedByOwner', { owner: skill.managedByPlugin })}</span>
              {(onOpenOwner !== undefined || actions !== null) && (
                <Button
                  variant="ghost"
                  size="xs"
                  icon="arrow-up-right"
                  onClick={() => {
                    if (onOpenOwner !== undefined) onOpenOwner(ownerTarget)
                    else actions?.openTarget(ownerTarget, isSplit ? { split: true } : undefined)
                  }}
                >
                  {ownerTarget.tab === 'core'
                    ? t('skills.drawer.openCoreOwner')
                    : t('skills.drawer.openPluginOwner')}
                </Button>
              )}
            </Stack>
          )}
        </>
      }
      aria-label={
        skill
          ? t('skills.drawer.detailsTitle', { name: skill.name || skill.id })
          : t('skills.drawer.detailsFallback')
      }
      closeLabel={t('common.close')}
    >
            {!skill ? (
              <EmptyState compact title={t('skills.drawer.noSkillSelected')} />
            ) : (
              <>
                {/* Compact file reader: single toolbar row + single scrollable reader */}
                <div className="skill-reader">
                  <div className="skill-reader-toolbar" role="group" aria-label={t('skills.drawer.toolbarLabel')}>
                    <div className="skill-reader-file">
                      {files.length > 1 ? (
                        <Select
                          className="skill-file-select"
                          size="sm"
                          inline={inline}
                          value={activePath}
                          options={fileOptions}
                          onChange={(ev) => setActivePath(ev.target.value)}
                          aria-label={t('skills.drawer.chooseFile')}
                          prefixIcon="file-text"
                        />
                      ) : (
                        <span className="skill-reader-file-label mono" title={activeDisplayPath}>
                          <HelmxIcon name={isMarkdown ? 'file-text' : 'file-code'} size={13} />
                          <span>{activeDisplayPath}</span>
                        </span>
                      )}
                    </div>

                    <div className="skill-reader-toolbar-meta">
                      {loading && (
                        <LoadingState className="skill-reader-loading" label={t('common.loading')} />
                      )}
                      {isMarkdown && (
                        <SegmentedControl
                          size="sm"
                          className="skill-reader-mode"
                          aria-label={t('skills.drawer.readingMode')}
                          value={viewMode}
                          onValueChange={(nextValue) => setViewMode(nextValue === 'source' ? 'source' : 'rich')}
                          items={[
                            {
                              value: 'rich',
                              icon: <HelmxIcon name="eye" size={12} />,
                              label: <span>{t('skills.drawer.richMode')}</span>,
                              title: t('skills.drawer.richTitle'),
                            },
                            {
                              value: 'source',
                              icon: <HelmxIcon name="code" size={12} />,
                              label: <span>{t('skills.drawer.sourceMode')}</span>,
                              title: t('skills.drawer.sourceTitle'),
                            },
                          ]}
                        />
                      )}
                      <Badge
                        tone="neutral"
                        className="tabular-nums skill-reader-index"
                        title={t('skills.drawer.fileIndexTitle', { index: activeIndex + 1, total: files.length })}
                      >
                        {`${activeIndex + 1}/${files.length}`}
                      </Badge>
                      <span
                        className="skill-reader-lines tabular-nums"
                        title={t('skills.drawer.linesTitle', { file: activeDisplayPath })}
                      >
                        {lineCount > 0 ? t('skills.drawer.linesCount', { count: lineCount }) : '--'}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={copyStatus === 'copied' ? 'check' : copyStatus === 'failed' ? 'alert-circle' : 'copy'}
                        className="skill-reader-copy"
                        title={copyButtonLabel}
                        aria-label={copyButtonLabel}
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleCopyContent()
                        }}
                      >
                        <span>{copyButtonLabel}</span>
                      </Button>
                    </div>
                  </div>

                  {/* Single scrollable reader: metadata table and body share one content flow */}
                  <div className="skill-reader-scroll">
                    {/* Body reading area */}
                    <div className="skill-reader-body" data-mode={richText ? 'rich' : 'source'}>
                      {error ? (
                        <Callout tone="err">
                          <span className="callout-text" role="alert">
                            {t('skills.drawer.readFailed', { error })}
                          </span>
                        </Callout>
                      ) : loading && content === '' ? (
                        <LoadingState
                          className="skill-reader-placeholder"
                          iconSize={13}
                          label={t('skills.drawer.readingContent')}
                        />
                      ) : content === '' ? (
                        <EmptyState
                          compact
                          icon="file-text"
                          className="skill-reader-placeholder"
                          title={t('skills.drawer.fileEmpty')}
                        />
                      ) : richText ? (
                        <div className="skill-reader-doc selectable">
                          <MarkdownView text={displayText} />
                        </div>
                      ) : (
                        <div className="skill-reader-code">
                          <CodeBlockView code={content} language={sourceLanguage} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
    </DetailDrawer>
  )
}
