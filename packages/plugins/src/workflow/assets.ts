/** builtin:workflow managed skill asset loader. */
import type { PluginSkillAsset } from '@helmx/protocol'
import { loadManagedSkillAsset } from '../asset-paths.js'
import { WORKFLOW_PLUGIN_ID, WORKFLOW_SKILL_ID } from '../contracts.js'

export function readWorkflowSkillAsset(): PluginSkillAsset {
  return loadManagedSkillAsset({
    pluginId: WORKFLOW_PLUGIN_ID,
    skillId: WORKFLOW_SKILL_ID,
    relativeDir: 'workflow/skill',
    missingErrorCode: 'workflow_skill_asset_missing',
    references: ['dsl.md', 'subagents.md'],
  })
}
