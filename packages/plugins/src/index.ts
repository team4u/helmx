/**
 * @helmx/plugins 聚合出口：十六个内置插件的生产者侧工厂与公开契约。
 *
 * 消费方向（包拓扑铁律）：本包只依赖 @helmx/protocol 与外部 SDK，绝不依赖
 * @helmx/kernel 实现；产品组合（注册顺序与缺省启停）由 @helmx/hub 负责。
 * 每个插件另提供 `@helmx/plugins/<name>` 子路径出口，供按需引用。
 */
export { createProfilePlugin } from './profile.js';
export { createMemoryPlugin, MEMORY_PLUGIN_ID } from './memory.js';
export { createWorkflowPlugin, WORKFLOW_PLUGIN_ID } from './workflow.js';
export { createWorktreePlugin, WORKTREE_PLUGIN_ID } from './worktree.js';
export { createChangesPlugin, CHANGES_PLUGIN_ID, CHANGES_SCREEN_ID, CHANGES_PANEL_ID } from './changes.js';
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
  TIERS_BORROW_KV,
  TIERS_BORROW_SESSION_DOC,
  TIERS_SWITCH_MODEL_TOOL,
  TIERS_INPUT_META_KEY,
  TIERS_BORROW_ELIGIBLE_SCOPE,
  TIER_BORROW_SESSION_VIEW_SCHEMA,
  SWITCH_MODEL_META_SCHEMA,
  type TierTemplate,
  type TiersStateDoc,
  type TiersPluginConfig,
  type TierThinkingLevel,
  type TierBorrowPhase,
  type TierBorrowSource,
  type TierBorrowRecord,
  type TierBorrowSessionView,
  type SwitchModelPresentationMeta,
  type ClearBorrowResult,
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
export {
  createPlanPlugin,
  PLAN_PLUGIN_ID,
  PLAN_SESSION_DOC,
  PLAN_BADGES_DOC,
  PLAN_PANEL_ID,
  PLAN_COMMAND_ID,
  PLAN_COMMAND_SLASH,
  PLAN_TOOL_SAVE,
  PLAN_TOOL_PROPOSE,
  PLAN_INPUT_META_KEY,
  hasPlanModeInputMeta,
  type PlanMode,
  type PlanDraftSummary,
  type PlanApprovedInfo,
  type PlanSessionView,
  type PlanBadgeEntry,
  type PlanBadgesDoc,
  type PlanToolPresentationMeta,
  type PlanPluginConfig,
  type PlanPluginOptions,
} from './plan.js';
export {
  createStepsPlugin,
  STEPS_PLUGIN_ID,
  STEPS_KV_NAMESPACE,
  STEPS_SESSION_DOC,
  STEPS_TOOL_UPDATE,
  STEPS_MAX_ITEMS,
  STEPS_TITLE_MAX_CHARS,
  STEP_STATUSES,
  STEPS_ELIGIBLE_SCOPE,
  type StepStatus,
  type StepsSettledOutcome,
  type StepItem,
  type StepsConversationRecord,
  type StepsSessionView,
  type StepsToolPresentationMeta,
  type StepsPluginClientAssets,
  type StepsPluginOptions,
} from './steps.js';
export {
  createPortForwardPlugin,
  MAX_PORT_FORWARD_RULES,
  PORT_FORWARD_PLUGIN_ID,
  PORT_FORWARD_RULES_DOC,
  PORT_FORWARD_RUNTIME_DOC,
  PORT_FORWARD_SCREEN_ID,
  RESERVED_HUB_PORTS,
  type PortForwardListenerState,
  type PortForwardPluginConfig,
  type PortForwardRule,
  type PortForwardRulesDoc,
  type PortForwardRuntimeDoc,
  type PortForwardRuntimeEntry,
  type PortForwardViewItem,
} from './port-forward.js';
