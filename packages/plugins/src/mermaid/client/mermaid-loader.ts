/** On-demand Mermaid runtime loader: deduplicates concurrent loads and clears failed attempts for retry. */
import type { Mermaid } from 'mermaid'

type MermaidImporter = () => Promise<{ default?: Mermaid } | Mermaid>

interface MermaidLoader {
  load: () => Promise<Mermaid>
  reset: () => void
}

const importDefaultMermaid: MermaidImporter = () => import('mermaid')

export function createMermaidLoader(importer: MermaidImporter = importDefaultMermaid): MermaidLoader {
  let currentAttempt: Promise<Mermaid> | null = null

  const load = (): Promise<Mermaid> => {
    if (currentAttempt !== null) return currentAttempt
    const attempt = (async () => {
      const mod = await importer()
      const instance =
        mod !== null && typeof mod === 'object' && 'default' in mod && mod.default !== undefined
          ? mod.default
          : (mod as Mermaid)
      if (!instance || typeof instance.initialize !== 'function' || typeof instance.render !== 'function') {
        throw new Error('Loaded mermaid module is missing initialize/render')
      }
      return instance
    })().catch((err: unknown) => {
      if (currentAttempt === attempt) currentAttempt = null
      throw err
    })
    currentAttempt = attempt
    return attempt
  }

  return { load, reset: () => { currentAttempt = null } }
}

const defaultMermaidLoader = createMermaidLoader()

export function loadMermaid(): Promise<Mermaid> {
  return defaultMermaidLoader.load()
}
