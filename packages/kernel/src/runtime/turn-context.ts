/**
 * Kernel per-turn Profile & Skills context assembler (`TurnContextAssembler`).
 *
 * Splits section injection into two idempotent phases inside `HookBridge.transformBeforeTurn`:
 * 1. Pre-hook managed sections (seeded before plugin `before_turn` hooks run):
 *    - `profile.system` / `profile.assets-missing` (with deduplicated missing-asset warning notifications)
 *    - `profile.agents` / `profile.agents-unavailable` (workspace AGENTS.md)
 *    - `profile.workspace-boundary` (when `Profile.restrictToCwd === true`)
 * 2. Post-hook managed sections (projected after plugin `before_turn` hooks settle tools):
 *    - `profile.skills` / `profile.node-skills-unavailable` (only when `load_skill` survives hook stripping;
 *      stripped turns leave zero phantom skill instructions).
 */
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { HelmxError, escapeXml, type ConversationSummary, type SkillSummary } from '@helmx/protocol'
import { FileNotFoundError, type ProfileService } from '../services/index.js'
import { computeAgentsMdSection } from './agents-md.js'
import { nodeSkillsUnavailableSection } from './node-skills.js'
import type { ScopedSkillService } from './scoped-skills.js'

export interface PromptSection {
  id: string
  text: string
}

export const PRE_HOOK_PROFILE_SECTION_IDS: ReadonlySet<string> = new Set([
  'profile.system',
  'profile.assets-missing',
  'profile.agents',
  'profile.agents-unavailable',
  'profile.workspace-boundary',
])

export const POST_HOOK_SKILL_SECTION_IDS: ReadonlySet<string> = new Set([
  'profile.skills',
  'profile.node-skills-unavailable',
])

/**
 * Idempotently project a managed slice of system sections: existing entries whose IDs are in
 * `managedIds` are updated in-place if present in `desired` or removed if absent; newly appearing
 * `desired` sections are appended in declaration order. Preserves original reference when unchanged.
 */
export function projectManagedSections(
  sections: ReadonlyArray<PromptSection>,
  managedIds: ReadonlySet<string>,
  desired: ReadonlyArray<PromptSection>,
): PromptSection[] {
  const desiredMap = new Map(desired.map((section) => [section.id, section.text] as const))
  let changed = false
  const out: PromptSection[] = []
  for (const section of sections) {
    if (managedIds.has(section.id)) {
      const next = desiredMap.get(section.id)
      if (next !== undefined) {
        out.push({ id: section.id, text: next })
        desiredMap.delete(section.id)
        if (next !== section.text) changed = true
      } else {
        changed = true
      }
      continue
    }
    out.push(section)
  }
  for (const [id, text] of desiredMap) {
    out.push({ id, text })
    changed = true
  }
  return changed ? out : (sections as PromptSection[])
}

export interface TurnContextAssemblerDeps {
  readonly profiles: Pick<ProfileService, 'get' | 'getSystem'>
  readonly scopedSkills: Pick<ScopedSkillService, 'listAvailableForConversation'>
  readonly executionEnv: (nodeId: string, cwd: string) => ExecutionEnv
  readonly isNodeOnline: (nodeId: string) => boolean
  readonly redact: (text: string) => string
  readonly notifyWarning: (notification: { title: string; body: string }) => void | Promise<void>
}

export interface PreparedTurnContext {
  readonly preSections: PromptSection[]
  resolvePostSections(loadSkillActive: boolean): PromptSection[]
}

export class TurnContextAssembler {
  private readonly missingNotified = new Set<string>()
  private readonly agentsHost

  constructor(private readonly deps: TurnContextAssemblerDeps) {
    this.agentsHost = {
      executionEnv: (nodeId: string, cwd: string) => this.deps.executionEnv(nodeId, cwd),
      redact: (text: string) => this.deps.redact(text),
      nodeIpc: { isOnline: (nodeId: string) => this.deps.isNodeOnline(nodeId) },
    }
  }

  private async readSystemOrEmpty(profileId: string): Promise<string> {
    try {
      const text = await this.deps.profiles.getSystem(profileId)
      this.missingNotified.delete(profileId)
      return text
    } catch (err) {
      if (err instanceof FileNotFoundError || (err instanceof HelmxError && err.code === 'not_found')) {
        if (!this.missingNotified.has(profileId)) {
          await this.deps.notifyWarning({
            title: `Profile asset file missing: ${profileId}/SYSTEM.md`,
            body: `Profile asset ${profileId}/SYSTEM.md does not exist (possibly deleted externally); this turn proceeds with empty content; writing the system prompt again self-heals it`,
          })
          this.missingNotified.add(profileId)
        }
        return ''
      }
      throw err
    }
  }

  async prepare(conversation: ConversationSummary): Promise<PreparedTurnContext> {
    const profileId = conversation.profileId
    const profilePromise = this.deps.profiles.get(profileId)
    const [rawSystem, skillCatalog, agentsMd, profileRecord] = await Promise.all([
      this.readSystemOrEmpty(profileId),
      this.deps.scopedSkills.listAvailableForConversation(profileId, conversation, profilePromise),
      computeAgentsMdSection(this.agentsHost, conversation.nodeId, conversation.cwd),
      profilePromise,
    ])

    const preSections: PromptSection[] = []
    if (rawSystem.trim()) {
      preSections.push({ id: 'profile.system', text: rawSystem })
    } else {
      preSections.push({
        id: 'profile.assets-missing',
        text: [
          '<profile_assets_missing>',
          `This turn lacks the SYSTEM.md of Profile '${profileId}' (file missing or empty).`,
          'You currently have no persona for this Profile: tell the user the asset is missing, answer carefully, and do not pretend to have a specific persona; it recovers automatically once the asset is written.',
          '</profile_assets_missing>',
        ].join('\n'),
      })
    }
    if (agentsMd.kind === 'section') {
      preSections.push({ id: agentsMd.id, text: agentsMd.text })
    }
    if (profileRecord?.restrictToCwd === true) {
      preSections.push({
        id: 'profile.workspace-boundary',
        text: [
          '<workspace_boundary>',
          `This conversation is restricted to its working directory: ${conversation.cwd}`,
          'File tools (read/write/edit/register_artifact) only accept paths inside that directory; relative paths, ../ traversals, and absolute paths outside it are rejected with path_outside_workspace.',
          'Stay inside the working directory; when a task genuinely needs outside paths, say so instead of attempting them.',
          '</workspace_boundary>',
        ].join('\n'),
      })
    }

    const postSections: PromptSection[] = []
    if (skillCatalog.nodeUnavailable !== undefined) {
      postSections.push(
        nodeSkillsUnavailableSection(conversation.nodeId, conversation.cwd, skillCatalog.nodeUnavailable),
      )
    }
    if (skillCatalog.available.length > 0) {
      postSections.push({
        id: 'profile.skills',
        text: renderAvailableSkillsSection(skillCatalog.available),
      })
    }

    return {
      preSections,
      resolvePostSections: (loadSkillActive) => (loadSkillActive ? postSections : []),
    }
  }

  applyPreSections(sections: ReadonlyArray<PromptSection>, preSections: ReadonlyArray<PromptSection>): PromptSection[] {
    return projectManagedSections(sections, PRE_HOOK_PROFILE_SECTION_IDS, preSections)
  }

  applyPostSections(sections: ReadonlyArray<PromptSection>, postSections: ReadonlyArray<PromptSection>): PromptSection[] {
    return projectManagedSections(sections, POST_HOOK_SKILL_SECTION_IDS, postSections)
  }
}

function renderAvailableSkillsSection(available: ReadonlyArray<SkillSummary>): string {
  const catalog = available
    .map(
      (skill) =>
        `<skill id="${escapeXml(skill.id)}"><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description ?? '')}</description><references>${skill.references.map(escapeXml).join(', ')}</references></skill>`,
    )
    .join('\n')
  return `<available_skills>\n${catalog}\n</available_skills>\nUse load_skill to read a skill before applying it. Read reference files only as needed.`
}
