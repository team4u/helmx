/**
 * Kernel-owned core managed skills (`managedByPlugin: core:*`) and startup bootstrapper.
 *
 * All four host/domain manuals live directly in `@helmx/kernel` rather than `builtin:profile`:
 * - `helmx-cli` -> `core:host`
 * - `app-builder` -> `core:plugins`
 * - `conversations` -> `core:conversations`
 * - `profiles` -> `core:profiles`
 *
 * Bootstrapped during `KernelRuntime.initialize()` before plugin activation so migrated skill
 * directories (`helmx-cli`, `app-builder`) already carry `core:*` ownership on disk before
 * active plugin owner reconciliation sweeps retired `builtin:profile` directories (e.g. `profile`).
 */
import { HelmxError, isValidCoreOwnerId, parseSkillFrontmatter } from '@helmx/protocol'
import type { BuiltinSkillAsset, SkillService } from '../../services/skill-service.js'
import {
  APP_BUILDER_FULLSTACK_TEMPLATE_MD,
  APP_BUILDER_SKILL_ASSET,
  APP_BUILDER_SKILL_ID,
  APP_BUILDER_SKILL_MD,
  APP_BUILDER_SKILL_OWNER,
} from './app-builder.js'
import {
  CONVERSATIONS_SKILL_ASSET,
  CONVERSATIONS_SKILL_ID,
  CONVERSATIONS_SKILL_MD,
  CONVERSATIONS_SKILL_OWNER,
} from './conversations.js'
import {
  HELMX_CLI_PLUGIN_CLIENT_CODE_SPLITTING_MD,
  HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD,
  HELMX_CLI_SKILL_ASSET,
  HELMX_CLI_SKILL_ID,
  HELMX_CLI_SKILL_MD,
  HELMX_CLI_SKILL_OWNER,
} from './helmx-cli.js'
import {
  PROFILES_SKILL_ASSET,
  PROFILES_SKILL_ID,
  PROFILES_SKILL_MD,
  PROFILES_SKILL_OWNER,
} from './profiles.js'

export { renderSkillTemplate } from './template.js'
export {
  HELMX_CLI_SKILL_ID,
  HELMX_CLI_SKILL_OWNER,
  HELMX_CLI_SKILL_ASSET,
  HELMX_CLI_SKILL_MD,
  HELMX_CLI_SKILL_AND_PLUGIN_DEV_MD,
  HELMX_CLI_PLUGIN_CLIENT_CODE_SPLITTING_MD,
  APP_BUILDER_SKILL_ID,
  APP_BUILDER_SKILL_OWNER,
  APP_BUILDER_SKILL_ASSET,
  APP_BUILDER_SKILL_MD,
  APP_BUILDER_FULLSTACK_TEMPLATE_MD,
  CONVERSATIONS_SKILL_ID,
  CONVERSATIONS_SKILL_OWNER,
  CONVERSATIONS_SKILL_ASSET,
  CONVERSATIONS_SKILL_MD,
  PROFILES_SKILL_ID,
  PROFILES_SKILL_OWNER,
  PROFILES_SKILL_ASSET,
  PROFILES_SKILL_MD,
}

export interface CoreManagedSkillEntry {
  readonly owner: string
  readonly asset: BuiltinSkillAsset
}

export const CORE_MANAGED_SKILLS: readonly CoreManagedSkillEntry[] = [
  { owner: HELMX_CLI_SKILL_OWNER, asset: HELMX_CLI_SKILL_ASSET },
  { owner: APP_BUILDER_SKILL_OWNER, asset: APP_BUILDER_SKILL_ASSET },
  { owner: CONVERSATIONS_SKILL_OWNER, asset: CONVERSATIONS_SKILL_ASSET },
  { owner: PROFILES_SKILL_OWNER, asset: PROFILES_SKILL_ASSET },
]

/**
 * All kernel-owned `core:*` domains reconciled on startup: because core domains are always
 * active, any on-disk skill directory still claiming one of these owners that is not declared
 * in `CORE_MANAGED_SKILLS` is retired cleanly at boot.
 */
export const CORE_SKILL_OWNERS: readonly string[] = [
  'core:host',
  'core:conversations',
  'core:profiles',
  'core:models',
  'core:nodes',
  'core:plugins',
  'core:asks',
  'core:skills',
]

/**
 * Sync all kernel-owned core managed skills into `skills/<id>/` and reconcile retired `core:*`
 * skill directories in a single pass.
 */
export async function bootstrapCoreSkills(skills: SkillService): Promise<void> {
  for (const entry of CORE_MANAGED_SKILLS) {
    if (!isValidCoreOwnerId(entry.owner)) {
      throw new HelmxError(
        'invalid_core_skill',
        `Core managed skill '${entry.asset.id}' must use a valid 'core:<domain>' owner (got: '${entry.owner}')`,
        500,
        { skillId: entry.asset.id, owner: entry.owner },
      )
    }
    let declaredOwner: string | undefined
    try {
      declaredOwner = parseSkillFrontmatter(entry.asset.skillMd).managedByPlugin
    } catch (error) {
      throw new HelmxError(
        'invalid_core_skill',
        `Core managed skill '${entry.asset.id}' has invalid SKILL.md frontmatter: ${error instanceof Error ? error.message : String(error)}`,
        500,
        { skillId: entry.asset.id, owner: entry.owner },
      )
    }
    if (declaredOwner !== entry.owner) {
      throw new HelmxError(
        'invalid_core_skill',
        `Core managed skill '${entry.asset.id}' must declare 'managedByPlugin: ${entry.owner}' in SKILL.md frontmatter (got: ${declaredOwner ?? 'missing'})`,
        500,
        { skillId: entry.asset.id, owner: entry.owner },
      )
    }
    await skills.ensureSkill(entry.asset, { deferOwnerReconcile: true })
  }
  await skills.reconcileManagedOwners(CORE_SKILL_OWNERS)
}
