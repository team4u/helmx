/**
 * Core Operation Contract barrel (server/CLI-only; re-exported from `@helmx/protocol`, never `/browser`).
 */
export type {
  CoreActionOperationKey,
  CoreActionOperations,
  CoreOperationActionSpec,
  CoreOperationBodyMode,
  CoreOperationCliSpec,
  CoreOperationHttpMethod,
  CoreOperationHttpSpec,
  CoreOperationKey,
  CoreOperationParamValidator,
  CoreOperationPositionalSpec,
  CoreOperationSpec,
} from './types.js'
export {
  NODE_CORE_OPERATIONS,
  type NodeCoreOperation,
  type NodeCoreOperationKey,
} from './nodes.js'
export {
  PLUGIN_CORE_OPERATIONS,
  type PluginCoreOperation,
  type PluginCoreOperationKey,
} from './plugins.js'
export {
  SKILL_CORE_OPERATIONS,
  type SkillCoreOperation,
  type SkillCoreOperationKey,
} from './skills.js'

import { NODE_CORE_OPERATIONS } from './nodes.js'
import { PLUGIN_CORE_OPERATIONS } from './plugins.js'
import { SKILL_CORE_OPERATIONS } from './skills.js'
import type { CoreOperationSpec } from './types.js'

export const CORE_OPERATIONS = [
  ...NODE_CORE_OPERATIONS,
  ...PLUGIN_CORE_OPERATIONS,
  ...SKILL_CORE_OPERATIONS,
] as const satisfies readonly CoreOperationSpec[]
