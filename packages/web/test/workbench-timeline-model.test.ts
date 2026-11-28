/**
 * timeline-model 与 workbench-model 纯函数测试（pure 池）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ArtifactMetadata, PluginUiContribution } from '@helmx/protocol'
import { buildTimelineItems, findLatestProcessTurnKey, type TimelineItem } from '../src/conversation/timeline-model.js'
import {
  artifactFormatLabel,
  artifactKindLabel,
  artifactMimeRedundant,
  buildWorkbenchFooter,
  buildWorkbenchTabs,
  countDeliverableArtifacts,
  partitionArtifactsByKind,
} from '../src/conversation/workbench-model.js'
import { createWebTranslator } from '../src/i18n/catalog.js'
import { groupUiContributions } from '../src/lib/types.js'

function makeArtifact(
  id: string,
  kind: ArtifactMetadata['kind'],
  name: string,
  mimeType = 'text/plain',
  size = 128,
): ArtifactMetadata {
  return {
    id,
    conversationId: 1,
    kind,
    name,
    path: `artifacts/1/${name}`,
    mimeType,
    size,
    createdAt: 1_700_000_000_000,
  }
}

test('timeline-model findLatestProcessTurnKey 选中最新一条含过程步骤的助手回合', { timeout: 60_000 }, () => {
  const items: TimelineItem[] = [
    {
      kind: 'assistant',
      key: 'model:turn:1',
      entryIds: ['model:1'],
      live: false,
      segments: [
        {
          kind: 'step-group',
          key: 'model:steps:1',
          stepCount: 1,
          steps: [{ kind: 'thinking', thinking: { key: 'model:think:1', text: 'early' } }],
        },
        { kind: 'text', key: 'model:txt:1', text: 'reply 1' },
      ],
    },
    {
      kind: 'assistant',
      key: 'model:turn:2',
      entryIds: ['model:2'],
      live: false,
      segments: [
        {
          kind: 'step-group',
          key: 'model:steps:2',
          stepCount: 1,
          steps: [{ kind: 'thinking', thinking: { key: 'model:think:2', text: 'latest' } }],
        },
        { kind: 'text', key: 'model:txt:2', text: 'reply 2' },
      ],
    },
    {
      kind: 'assistant',
      key: 'model:turn:3-plain',
      entryIds: ['model:3'],
      live: false,
      segments: [{ kind: 'text', key: 'model:txt:3', text: 'plain' }],
    },
  ]
  assert.equal(findLatestProcessTurnKey(items), 'model:turn:2')
  assert.equal(findLatestProcessTurnKey([items[2]!]), undefined)
  assert.equal(findLatestProcessTurnKey([]), undefined)
})

test('workbench-model 严格分离正式产物与 spill、去重计数并按 locale 解析插件页签标题', { timeout: 60_000 }, () => {
  const registered = makeArtifact('art-reg', 'registered', 'summary-report.md', 'text/markdown', 2048)
  const uploaded = makeArtifact('art-up', 'upload', 'diagram.png', 'image/png', 4096)
  const spill1 = makeArtifact('art-spill-1', 'spill', 'bash-stdout-001.log', 'text/plain', 65_536)
  const spill2 = makeArtifact('art-spill-2', 'spill', 'bash-stdout-002.log', 'text/plain', 32_768)

  const partitioned = partitionArtifactsByKind([registered, uploaded, spill1, spill2])
  assert.equal(partitioned.deliverables.length, 2)
  assert.equal(partitioned.spills.length, 2)
  assert.equal(countDeliverableArtifacts([registered, uploaded, spill1, spill2]), 2)
  assert.equal(countDeliverableArtifacts([spill1, spill2]), 0)

  const tabs = buildWorkbenchTabs({
    groupedUi: groupUiContributions([]),
    pluginDocs: {},
    artifactCount: countDeliverableArtifacts([registered, uploaded, spill1]),
    conversationId: 1,
    locale: 'en',
  })
  assert.equal(tabs[0]?.label, 'Artifacts')
  assert.equal(tabs[0]?.count, 2)
  assert.deepEqual(buildWorkbenchFooter(tabs), [])

  const localizedPanels: PluginUiContribution[] = [
    { pluginId: 'builtin:superagent', surface: 'workbench.panel', spec: { id: 'runs', label: { en: 'Workflow runs', 'zh-CN': '工作流运行' } } },
    { pluginId: 'community:logger', surface: 'workbench.panel', spec: { id: 'logs', label: 'Logger panels' } },
  ]
  assert.equal(
    buildWorkbenchTabs({ groupedUi: groupUiContributions(localizedPanels), pluginDocs: {}, artifactCount: 0, conversationId: undefined, locale: 'zh-CN' })
      .find((tab) => tab.id === 'plugin:builtin:superagent/runs')?.label,
    '工作流运行',
  )
  assert.equal(
    buildWorkbenchTabs({ groupedUi: groupUiContributions(localizedPanels), pluginDocs: {}, artifactCount: 0, conversationId: undefined, locale: 'en' })
      .find((tab) => tab.id === 'plugin:builtin:superagent/runs')?.label,
    'Workflow runs',
  )
  assert.equal(
    buildWorkbenchTabs({ groupedUi: groupUiContributions(localizedPanels), pluginDocs: {}, artifactCount: 0, conversationId: undefined, locale: 'zh-CN' })
      .find((tab) => tab.id === 'plugin:community:logger/logs')?.label,
    'Logger panels',
    '纯字符串 label 任意 locale 原样',
  )
  assert.deepEqual(buildTimelineItems([]), [])

  const zh = createWebTranslator('zh-CN')
  assert.equal(artifactKindLabel('registered', zh), '注册产物')
  assert.equal(artifactKindLabel('upload', zh), '上传附件')
  assert.equal(artifactKindLabel('spill', zh), '输出快照')
  assert.equal(artifactFormatLabel('image/png', 'diagram.png', zh), '图片')
  assert.equal(artifactFormatLabel('text/plain', 'notes.txt', zh), '文本')
  assert.equal(artifactFormatLabel('application/octet-stream', 'data', zh), '文件')
  assert.equal(artifactMimeRedundant('image/png', 'diagram.png'), true)
  assert.equal(artifactMimeRedundant('text/markdown', 'summary-report.md'), true)
  assert.equal(artifactMimeRedundant('application/pdf', 'doc.pdf'), true)
  assert.equal(artifactMimeRedundant('application/octet-stream', 'data.bin'), false)
  assert.equal(artifactMimeRedundant('application/x-custom', 'model-onnx'), false)

  const zhTabs = buildWorkbenchTabs({
    groupedUi: groupUiContributions([]),
    pluginDocs: {},
    artifactCount: 1,
    conversationId: 1,
    locale: 'zh-CN',
    t: zh,
  })
  assert.equal(zhTabs[0]?.label, '产物')
})
