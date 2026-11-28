/**
 * Asset helper for loading the `duo` plugin skill from source or compiled dist layout.
 */
import type { PluginSkillAsset } from '@helmx/protocol'
import { loadManagedSkillAsset, resolvePluginAssetDir } from '../asset-paths.js'
import { DUO_PLUGIN_ID, DUO_SKILL_ID } from './contracts.js'

export function resolveDuoSkillDir(): string {
  return resolvePluginAssetDir(DUO_PLUGIN_ID, 'duo/skill', 'duo_skill_asset_missing')
}

export function readDuoSkillAsset(): PluginSkillAsset {
  return loadManagedSkillAsset({
    pluginId: DUO_PLUGIN_ID,
    skillId: DUO_SKILL_ID,
    relativeDir: 'duo/skill',
    missingErrorCode: 'duo_skill_asset_missing',
  })
}
