/** On-demand Mermaid runtime loader & serialized render queue: deduplicates concurrent loads, serializes `mermaid.render`, and skips redundant `mermaid.initialize` calls when theme is unchanged. */
import type { Mermaid } from 'mermaid'
import { getMermaidConfig } from './mermaid-theme.ts'

type MermaidImporter = () => Promise<{ default?: Mermaid } | Mermaid>

export interface MermaidLoader {
  load: () => Promise<Mermaid>
  reset: () => void
}

interface MermaidRenderQueueState {
  chain: Promise<unknown>
  initializedTheme: 'light' | 'dark' | null
  initializedInstance: Mermaid | null
}

const MERMAID_RENDER_QUEUE_KEY = Symbol.for('helmx:builtin:mermaid:render-queue')

function getRenderQueueState(): MermaidRenderQueueState {
  const g = globalThis as Record<PropertyKey, unknown>
  let state = g[MERMAID_RENDER_QUEUE_KEY] as MermaidRenderQueueState | undefined
  if (state === undefined) {
    state = { chain: Promise.resolve(), initializedTheme: null, initializedInstance: null }
    g[MERMAID_RENDER_QUEUE_KEY] = state
  }
  return state
}

const importDefaultMermaid: MermaidImporter = () => import('mermaid/dist/mermaid.esm.min.mjs')

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

  return {
    load,
    reset: () => {
      currentAttempt = null
      const state = getRenderQueueState()
      state.initializedTheme = null
      state.initializedInstance = null
    },
  }
}

const defaultMermaidLoader = createMermaidLoader()

export function loadMermaid(): Promise<Mermaid> {
  return defaultMermaidLoader.load()
}

export function renderMermaidSvg(options: {
  theme: 'light' | 'dark'
  id: string
  code: string
  isStale?: () => boolean
  loader?: MermaidLoader
}): Promise<string> {
  const state = getRenderQueueState()
  const run = async (): Promise<string> => {
    if (options.isStale?.()) return ''
    const mermaid = await (options.loader ?? defaultMermaidLoader).load()
    if (options.isStale?.()) return ''
    if (state.initializedInstance !== mermaid || state.initializedTheme !== options.theme) {
      mermaid.initialize(getMermaidConfig(options.theme))
      state.initializedInstance = mermaid
      state.initializedTheme = options.theme
    }
    const { svg } = await mermaid.render(options.id, options.code)
    return svg
  }
  const task = state.chain.then(run, run)
  state.chain = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}
