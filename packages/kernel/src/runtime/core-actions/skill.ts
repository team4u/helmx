/** `core:skills`: human HTTP/CLI skill listing, scoped catalog discovery, and bounded reference-file reading. */
import { SKILL_CORE_OPERATIONS } from '@helmx/protocol'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import { readSkillForOperation } from '../scoped-skills.js'
import { registerCoreActionsFromOperations } from './from-operations.js'
import type { CoreActionRegistrar } from './shared.js'

export function registerSkillCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  registerCoreActionsFromOperations(pluginHost, SKILL_CORE_OPERATIONS, {
    'skills.list': async () => runtime.skills.list(),

    'skills.catalog': (input) =>
      runtime.scopedSkills.listCatalog({
        nodeId: input.nodeId as string,
        ...(input.cwd !== undefined ? { cwd: input.cwd as string } : {}),
      }),

    'skills.read': (input) =>
      readSkillForOperation(runtime.skills, runtime.scopedSkills, {
        id: input.id as string,
        ...(input.path !== undefined ? { path: input.path as string } : {}),
        ...(input.nodeId !== undefined ? { nodeId: input.nodeId as string } : {}),
        ...(input.cwd !== undefined ? { cwd: input.cwd as string } : {}),
      }),
  })
}
