/**
 * Kernel `load_skill` tool: reads a skill's SKILL.md or nested reference files on demand,
 * enforcing the conversation Profile's `skills` whitelist, live plugin enablement, and Hub > node priority.
 */
import type { Context } from '@earendil-works/chord/context'
import { defineTool, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable'
import { obj, opt, str } from '@earendil-works/pi-schema'
import { HelmxError } from '@helmx/protocol'
import { throwIfToolAborted, type HelmxToolDeps } from '../tool-deps.js'

export const LOAD_SKILL_TOOL_NAME = 'load_skill' as const

const loadSkillParameters = obj({
  skillId: str({ minLength: 1, description: 'Skill ID to read' }),
  path: opt(str({ minLength: 1, description: 'Optional relative path inside the skill directory (e.g. references/guide.md)' })),
})

/** Construct the foundational `load_skill` kernel tool. */
export function createLoadSkillTool(
  deps: Pick<HelmxToolDeps, 'redact' | 'loadSkillForConversation'>,
): ToolRegistration<typeof loadSkillParameters> {
  return defineTool({
    name: LOAD_SKILL_TOOL_NAME,
    description:
      "Read a skill's SKILL.md, or reference files inside the skill directory on demand. Example path: references/guide.md.",
    parameters: loadSkillParameters,
    async execute(args, api: ToolExecutionApi, context: Context) {
      if (deps.loadSkillForConversation === undefined) {
        return {
          output: [{ type: 'text', text: 'load_skill_failed: ScopedSkillService is not configured.' }],
          isError: true,
        }
      }
      throwIfToolAborted(context.abortSignal)
      try {
        const result = await deps.loadSkillForConversation(api.conversationId, {
          skillId: args.skillId,
          ...(args.path !== undefined ? { path: args.path } : {}),
        })
        throwIfToolAborted(context.abortSignal)
        return {
          output: [{ type: 'text', text: deps.redact(result.text) }],
        }
      } catch (error) {
        throwIfToolAborted(context.abortSignal)
        const code = error instanceof HelmxError ? error.code : 'load_skill_failed'
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: [{ type: 'text', text: `${code}: ${deps.redact(message)}` }],
          isError: true,
        }
      }
    },
  })
}
