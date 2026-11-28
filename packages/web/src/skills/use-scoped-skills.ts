/**
 * Coordinate-scoped merged skill catalog React hook (Fast Refresh safe; no component exports).
 *
 * - Hub scope (`scope === undefined`) issues no network request (`useSkills()` from store is authoritative);
 * - Node (and optional `cwd`) fetches `GET /api/skills/scoped/catalog` with generation-based race protection.
 */
import { useEffect, useRef, useState } from 'react'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import {
  fetchScopedSkillCatalog,
  type ScopedSkillCatalog,
  type ScopedSkillTransport,
} from './skill-scope-api.js'
import { type SkillScope } from './skill-scope-model.js'

export interface ScopedSkillCatalogState {
  loading: boolean
  catalog: ScopedSkillCatalog | null
  error: string | null
}

const IDLE_STATE: ScopedSkillCatalogState = { loading: false, catalog: null, error: null }

export function useScopedSkillCatalog(
  scope: SkillScope | undefined,
  t: WebMessageTranslator,
  reloadSeq: number = 0,
  transport?: Pick<ScopedSkillTransport, 'listCatalog'>,
): ScopedSkillCatalogState {
  const [state, setState] = useState<ScopedSkillCatalogState>(IDLE_STATE)
  const generationRef = useRef(0)
  const scopeNodeId = scope?.nodeId
  const scopeCwd = scope?.cwd

  useEffect(() => {
    if (scopeNodeId === undefined) {
      generationRef.current += 1
      setState(IDLE_STATE)
      return
    }
    const nextScope: SkillScope =
      scopeCwd !== undefined && scopeCwd !== ''
        ? { nodeId: scopeNodeId, cwd: scopeCwd }
        : { nodeId: scopeNodeId }
    const generation = ++generationRef.current
    setState((prev) =>
      prev.loading && prev.catalog === null && prev.error === null
        ? prev
        : { loading: true, catalog: null, error: null },
    )
    fetchScopedSkillCatalog(nextScope, t, transport)
      .then((catalog) => {
        if (generationRef.current !== generation) return
        setState({ loading: false, catalog, error: null })
      })
      .catch((err: unknown) => {
        if (generationRef.current !== generation) return
        setState({
          loading: false,
          catalog: null,
          error: err instanceof Error ? err.message : String(err),
        })
      })
  }, [scopeNodeId, scopeCwd, t, reloadSeq, transport])

  return state
}
