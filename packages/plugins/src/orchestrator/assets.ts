/**
 * Asset helper for loading the `orchestrator` plugin skill from source or compiled dist layout.
 */
import type { PluginSkillAsset } from '@helmx/protocol'
import { loadManagedSkillAsset, resolvePluginAssetDir } from '../asset-paths.js'
import { ORCHESTRATOR_PLUGIN_ID, ORCHESTRATOR_SKILL_ID } from './contracts.js'

export function resolveOrchestratorSkillDir(): string {
  return resolvePluginAssetDir(ORCHESTRATOR_PLUGIN_ID, 'orchestrator/skill', 'orchestrator_skill_asset_missing')
}

export function readOrchestratorSkillAsset(): PluginSkillAsset {
  return loadManagedSkillAsset({
    pluginId: ORCHESTRATOR_PLUGIN_ID,
    skillId: ORCHESTRATOR_SKILL_ID,
    relativeDir: 'orchestrator/skill',
    missingErrorCode: 'orchestrator_skill_asset_missing',
  })
}
