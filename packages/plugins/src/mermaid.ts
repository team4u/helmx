/** builtin:mermaid: registers the ```mermaid markdown.codeBlock renderer with build-time mermaid bundling. */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmxError, type PluginDefinition } from '@helmx/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'

const MERMAID_PLUGIN_ID = 'builtin:mermaid'

function resolvePluginsPackageRoot(): string {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  for (;;) {
    if (existsSync(join(root, 'node_modules', 'mermaid', 'package.json'))) return root
    const parent = dirname(root)
    if (parent === root) break
    root = parent
  }
  throw new HelmxError('mermaid_dependency_missing', 'the built-in Mermaid plugin runtime dependency is not installed', 500)
}

export function createMermaidPlugin(): PluginDefinition {
  const assets = resolvePluginClientAssets(MERMAID_PLUGIN_ID, 'mermaid', 'mermaid_client_missing')
  return {
    id: MERMAID_PLUGIN_ID,
    name: { en: 'Mermaid Diagrams', 'zh-CN': 'Mermaid 图表' },
    description: {
      en: 'Chat ```mermaid code-block rendering: renders Mermaid text into flowcharts/sequence diagrams/Gantt charts and other vector diagrams.',
      'zh-CN': '聊天 ```mermaid 代码块渲染：把 Mermaid 文本渲染为流程图/时序图/甘特图等矢量图表。',
    },
    icon: 'git-branch',
    version: '0.1.0',
    ...assets,
    // Prebuilt dist-client bundles mermaid into static chunks; runtime npmDependencies is only needed in source-compile mode.
    ...(assets.prebuiltClientDir === undefined ? { npmDependencies: { 'mermaid/dist/mermaid.esm.min.mjs': resolvePluginsPackageRoot() } } : {}),
    definePlugin(ctx) {
      ctx.ui.markdownCodeBlock({
        id: 'mermaid-diagram',
        languages: ['mermaid'],
        client: { module: 'index.tsx', export: 'MermaidCodeBlock' },
      })
    },
  }
}
