/** builtin:tiers managed skill asset loader (compatible with both src and compiled dist). */
import type { PluginSkillAsset } from '@helmx/protocol'
import { loadManagedSkillAsset } from '../asset-paths.js'
import { MODEL_TIERS_SKILL_ID, TIERS_PLUGIN_ID } from './contracts.js'

export function readTiersSkillAsset(): PluginSkillAsset {
  return loadManagedSkillAsset({
    pluginId: TIERS_PLUGIN_ID,
    skillId: MODEL_TIERS_SKILL_ID,
    relativeDir: 'tiers/skill',
    missingErrorCode: 'tiers_skill_asset_missing',
  })
}
