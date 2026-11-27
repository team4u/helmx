/** `core:skills`: human HTTP/CLI skill listing and bounded reference-file reading. */
import { HelmxError, SKILL_CORE_OPERATIONS } from '@helmx/protocol'
import { isSafeRelativePath } from '../../http/validate.js'
import type { CoreActionsRuntimeHost } from '../runtime-types.js'
import { registerCoreActionsFromOperations } from './from-operations.js'
import type { CoreActionRegistrar } from './shared.js'

export function registerSkillCoreActions(runtime: CoreActionsRuntimeHost, pluginHost: CoreActionRegistrar): void {
  registerCoreActionsFromOperations(pluginHost, SKILL_CORE_OPERATIONS, {
    'skills.list': async () => runtime.skills.list(),

    'skills.read': async (input) => {
      const id = input.id as string
      const path = input.path as string | undefined
      if (path !== undefined && !isSafeRelativePath(path)) {
        throw new HelmxError('path_traversal', `skill file path out of bounds: ${id}/${path}`, 400)
      }
      const text = await runtime.skills.readFile(id, path)
      return { text }
    },
  })
}
