/**
 * builtin:profile 自举的系统级内置技能资产（三层渐进式披露的 Layer 1/2）。
 *
 * Layer 1（SKILL.md）：helmx CLI 黄金法则、核心命令全景与 references 下钻索引，
 * 由 SkillService.ensureSkill 在插件启动时同步为源码版本（受管覆盖，常规接口只读）。
 * Layer 2（references/*.md）：技能/插件自举开发、client.tsx 代码分割两个专题手册，
 * 模型经 load_skill({ skillId, path }) 按需读取，正文不常驻。
 * 生成式 UI（```ui 代码块）手册由 builtin:json-render 插件自举的
 * generative-ui 技能提供，随插件启停进入/离开可用技能目录。
 */
import {
  PLUGIN_UI_METHOD_NAMES,
  RESERVED_SLASH_COMMANDS,
  PLUGIN_HOOK_NAMES,
  type PluginSkillAsset,
} from '@helmx/protocol'
import { loadManagedSkillAsset, renderSkillTemplate } from '../asset-paths.js'

/** 托管本技能资产与自举 Profile 的插件 ID（SKILL.md frontmatter managedByPlugin 值）。 */
export const PROFILE_MANAGED_BY = 'builtin:profile'

/** 系统级内置技能 ID（SYSTEM.md Layer 0 指引的 load_skill 目标）。 */
export const HELMX_CLI_SKILL_ID = 'helmx-cli'

/** 全栈微应用开发受管技能 ID（由常驻 builtin:profile 自举，面向标准 Screen 外部插件）。 */
export const APP_BUILDER_SKILL_ID = 'app-builder'

export { renderSkillTemplate }

const skillVars: Record<string, string> = {
  SKILL_ID: HELMX_CLI_SKILL_ID,
  MANAGED_BY: PROFILE_MANAGED_BY,
  HOOK_COUNT: String(PLUGIN_HOOK_NAMES.length),
  HOOK_NAMES: PLUGIN_HOOK_NAMES.join('、'),
  UI_METHOD_COUNT: String(PLUGIN_UI_METHOD_NAMES.length),
  RESERVED_SLASH_COMMANDS: RESERVED_SLASH_COMMANDS.join('/'),
}

/** 汇总资产：id + SKILL.md + 2 个 references。SkillService.ensureSkill 受管覆盖同步。 */
export const HELMX_CLI_SKILL_ASSET: PluginSkillAsset = loadManagedSkillAsset({
  pluginId: PROFILE_MANAGED_BY,
  skillId: HELMX_CLI_SKILL_ID,
  relativeDir: 'profile/skill',
  missingErrorCode: 'profile_skill_asset_missing',
  references: ['skill-and-plugin-dev.md', 'plugin-client-code-splitting.md'],
  transform: (raw) => renderSkillTemplate(raw, skillVars),
})

const appBuilderSkillVars: Record<string, string> = {
  SKILL_ID: APP_BUILDER_SKILL_ID,
  MANAGED_BY: PROFILE_MANAGED_BY,
}

/** 全栈微应用开发技能资产：id + SKILL.md + fullstack-template.md，由 builtin:profile 自举。 */
export const APP_BUILDER_SKILL_ASSET: PluginSkillAsset = loadManagedSkillAsset({
  pluginId: PROFILE_MANAGED_BY,
  skillId: APP_BUILDER_SKILL_ID,
  relativeDir: 'profile/assets/app-builder',
  missingErrorCode: 'profile_app_builder_skill_missing',
  references: ['fullstack-template.md'],
  transform: (raw) => renderSkillTemplate(raw, appBuilderSkillVars),
})

export const HELMX_CLI_SKILL_MD = HELMX_CLI_SKILL_ASSET.skillMd

export const HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD = HELMX_CLI_SKILL_ASSET.references!['skill-and-plugin-dev.md']!

export const APP_BUILDER_SKILL_MD = APP_BUILDER_SKILL_ASSET.skillMd
