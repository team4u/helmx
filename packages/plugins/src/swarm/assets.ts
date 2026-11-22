/**
 * builtin:swarm 受管技能资产加载（兼容 tsx 源码、tsc 构建产物与 @helmx/payload 运行形态）。
 */
import type { PluginSkillAsset } from '@helmx/protocol'
import { loadManagedSkillAsset, resolvePluginAssetDir } from '../asset-paths.js'
import { SWARM_PLUGIN_ID, SWARM_SKILL_ID } from './contracts.js'

export function resolveSwarmAssetsDir(): string {
  return resolvePluginAssetDir(SWARM_PLUGIN_ID, 'swarm/assets', 'swarm_asset_missing')
}

export function readSwarmSkillAsset(): PluginSkillAsset {
  return loadManagedSkillAsset({
    pluginId: SWARM_PLUGIN_ID,
    skillId: SWARM_SKILL_ID,
    relativeDir: `swarm/assets/${SWARM_SKILL_ID}`,
    missingErrorCode: 'swarm_asset_missing',
  })
}
