import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { commonMessages } from './src/i18n/resources/common.js'
import { composerMessages } from './src/i18n/resources/composer.js'
import { conversationMessages } from './src/i18n/resources/conversation.js'
import { modalsMessages } from './src/i18n/resources/modals.js'
import { modelsMessages } from './src/i18n/resources/models.js'
import { nodesMessages } from './src/i18n/resources/nodes.js'
import { pluginsMessages } from './src/i18n/resources/plugins.js'
import { profilesMessages } from './src/i18n/resources/profiles.js'
import { shellMessages } from './src/i18n/resources/shell.js'
import { skillsMessages } from './src/i18n/resources/skills.js'
import { uiMessages } from './src/i18n/resources/ui.js'

const hubPort = process.env.HELMX_PORT ?? '3202'
const hubTarget = `http://127.0.0.1:${hubPort}`

function splitWebLocalesPlugin(): Plugin {
  const merged = {
    ...commonMessages,
    ...conversationMessages,
    ...composerMessages,
    ...shellMessages,
    ...uiMessages,
    ...modelsMessages,
    ...nodesMessages,
    ...pluginsMessages,
    ...profilesMessages,
    ...skillsMessages,
    ...modalsMessages,
  }
  const enDict: Record<string, string> = {}
  const zhDict: Record<string, string> = {}
  for (const [key, entry] of Object.entries(merged)) {
    enDict[key] = entry.en
    zhDict[key] = entry['zh-CN']
  }

  let catalogTsPath = ''
  let catalogBrowserPath = ''

  return {
    name: 'helmx-split-web-locales',
    enforce: 'pre',
    configResolved(config) {
      catalogTsPath = path.resolve(config.root, 'src/i18n/catalog.ts').replaceAll('\\', '/')
      catalogBrowserPath = path.resolve(config.root, 'src/i18n/catalog.browser.ts').replaceAll('\\', '/')
    },
    async resolveId(source, importer, options) {
      if (source === 'virtual:helmx-i18n-en') return '\0virtual:helmx-i18n-en'
      if (source === 'virtual:helmx-i18n-zh-CN') return '\0virtual:helmx-i18n-zh-CN'
      if (importer === undefined) return null
      const normalizedImporter = importer.replaceAll('\\', '/')
      if (normalizedImporter === catalogBrowserPath) return null
      if (source.endsWith('i18n/catalog.js') || source.endsWith('i18n/catalog.ts') || source === './catalog.js' || source === './catalog.ts') {
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
        if (resolved !== null && resolved.id.replaceAll('\\', '/') === catalogTsPath) {
          return catalogBrowserPath
        }
      }
      return null
    },
    load(id) {
      if (id === '\0virtual:helmx-i18n-en') return `export default ${JSON.stringify(enDict)};`
      if (id === '\0virtual:helmx-i18n-zh-CN') return `export default ${JSON.stringify(zhDict)};`
      return null
    },
  }
}

function packageNameFromId(id: string): string | null {
  const normalized = id.replaceAll('\\', '/')
  const marker = '/node_modules/'
  const idx = normalized.lastIndexOf(marker)
  if (idx === -1) return null
  const rest = normalized.slice(idx + marker.length)
  if (rest.startsWith('.pnpm/')) return null
  if (rest.startsWith('@')) {
    const parts = rest.split('/')
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null
  }
  return rest.split('/', 1)[0] ?? null
}

const REACT_PKGS = new Set(['react', 'react-dom', 'scheduler'])
const MARKDOWN_PKGS = new Set([
  'react-markdown',
  'remark-gfm',
  'remark-parse',
  'remark-rehype',
  'unified',
])

export default defineConfig({
  clearScreen: false,
  plugins: [splitWebLocalesPlugin(), react()],
  resolve: {
    alias: [
      { find: '@helmx/protocol/browser', replacement: fileURLToPath(new URL('../protocol/src/browser.ts', import.meta.url)) },
      { find: /^@helmx\/protocol$/, replacement: fileURLToPath(new URL('../protocol/src/index.ts', import.meta.url)) },
    ],
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: process.env.VITE_HOST ?? '0.0.0.0',
    port: 3201,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': {
        target: hubTarget,
        changeOrigin: true,
      },
      '/ws': {
        target: hubTarget,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id === '\0virtual:helmx-i18n-en') return 'i18n-en'
          if (id === '\0virtual:helmx-i18n-zh-CN') return 'i18n-zh-CN'
          const pkg = packageNameFromId(id)
          if (pkg === null) return undefined
          if (REACT_PKGS.has(pkg)) return 'vendor-react'
          if (pkg.startsWith('@radix-ui/')) return 'vendor-radix'
          if (MARKDOWN_PKGS.has(pkg) || pkg.startsWith('mdast-') || pkg.startsWith('hast-') || pkg.startsWith('micromark') || pkg.startsWith('unist-')) {
            return 'vendor-markdown'
          }
          if (pkg === 'ajv') return 'vendor-ajv'
          return undefined
        },
      },
    },
  },
})
