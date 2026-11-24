/**
 * @helmx/plugins 聚合出口：十二个内置插件的生产者侧工厂与公开契约。
 *
 * 消费方向（包拓扑铁律）：本包只依赖 @helmx/protocol 与外部 SDK，绝不依赖
 * @helmx/kernel 实现；产品组合（注册顺序与缺省启停）由 @helmx/hub 负责。
 * 每个插件另提供 `@helmx/plugins/<name>` 子路径出口，供按需引用。
 */
export { createProfilePlugin, APP_BUILDER_SKILL_ID } from './profile.js';
export { createMemoryPlugin, MEMORY_PLUGIN_ID } from './memory.js';
export { createWorkflowPlugin, WORKFLOW_PLUGIN_ID } from './workflow.js';
export { createWorktreePlugin, WORKTREE_PLUGIN_ID } from './worktree.js';
export { WORKFLOW_SKILL_ID } from './contracts.js';
export { createSwarmPlugin, SWARM_PLUGIN_ID } from './swarm.js';
export { createTriggersPlugin, TRIGGERS_PLUGIN_ID, TRIGGERS_SKILL_ID } from './triggers.js';
export { createJsonRenderPlugin } from './json-render.js'
export { createMermaidPlugin } from './mermaid.js'
export { createMagpiePlugin, MAGPIE_PLUGIN_ID } from './magpie.js';
export { MAGPIE_PROVIDER_ID, type MagpiePluginConfig, type MagpieStatusDoc } from './magpie/contracts.js';
export { createTokenSpeedPlugin, TOKEN_SPEED_PLUGIN_ID } from './token-speed.js';
export { TOKEN_SPEED_DOC, type TokenSpeedStatus } from './token-speed/contracts.js';
export {
  createTiersPlugin,
  TIERS_PLUGIN_ID,
  TIERS_STATE_DOC,
  TIERS_SCREEN_ID,
  MODEL_TIERS_SKILL_ID,
  TIER_THINKING_LEVELS,
  type TierTemplate,
  type TiersStateDoc,
  type TiersPluginConfig,
} from './tiers.js';
export {
  createTitlePlugin,
  TITLE_PLUGIN_ID,
  TITLE_ACTION_GENERATE,
  TITLE_COMMAND_ID,
  TITLE_COMMAND_SLASH,
  type TitlePluginConfig,
  type TitleGenerateResult,
  type TitlePluginOptions,
} from './title.js';
