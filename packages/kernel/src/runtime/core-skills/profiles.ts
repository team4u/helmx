/**
 * Kernel-owned `profiles` managed skill (`managedByPlugin: core:profiles`).
 *
 * Split out of the former `builtin:profile` combined `profile` skill so Profile (role)
 * CRUD, persona, and guardrail guidance lives under the `core:profiles` domain.
 */
import type { BuiltinSkillAsset } from '../../services/skill-service.js'
import { renderSkillTemplate } from './template.js'

export const PROFILES_SKILL_ID = 'profiles'
export const PROFILES_SKILL_OWNER = 'core:profiles'

const PROFILES_SKILL_TEMPLATE = `---
name: {{SKILL_ID}}
description: "角色（Profile）检索、创建、配置与删除管理；优先通过结构化 core:profiles.* Action（而非 shell CLI）维护 SYSTEM.md、模型偏好、工作目录护栏（restrictToCwd）、技能白名单与开场提示词。Use when inspecting, creating, configuring, or deleting Profiles (roles)."
managedByPlugin: {{MANAGED_BY}}
---

# Profile (Role) Management

Use this skill whenever the user asks to inspect, create, update, or delete roles (Profiles), adjust a role's \`SYSTEM.md\` persona, model/thinking defaults, workspace restriction (\`restrictToCwd\`), skill allowlist, or starter prompts. For searching past conversations across roles or managing conversation lifecycle, load the \`conversations\` skill (\`core:conversations.*\`).

## Golden Rule: Prefer Structured \`run_action\` Over Shell CLI

Inside Agent turns, call structured internal actions via \`run_action\` instead of shelling out to \`helmx\` in \`bash\`:
- \`run_action\` enforces strict JSON Schema validation and returns structured JSON directly.
- Discover all reachable Profile actions live: \`run_action({ list: true, pluginId: "core:profiles" })\` (or \`pluginId: "core:"\` for all core domains).
- Inspect the exact \`inputSchema\` / \`outputSchema\` of any action without side effects: \`run_action({ actionId: "core:profiles.<id>", describe: true })\`.

## Profile Management Actions (\`core:profiles.*\`)

Manage roles (Profiles) via \`run_action({ actionId: "core:profiles.<id>", input })\`:

- **\`core:profiles.list\`**: \`{}\` — list all configured Profiles.
- **\`core:profiles.get\`**: \`{ id }\` — retrieve one Profile including its \`SYSTEM.md\` (\`system\`).
- **\`core:profiles.create\`**: \`{ id, name?, model?, thinkingLevel?, nodeId?, cwd?, restrictToCwd?, tags?, skills?, starters?, system? }\` — create a new Profile (\`managedByPlugin\` is rejected on create; \`restrictToCwd: true\` constrains file tools and subagent \`cwd\` to the conversation working directory as a model guardrail).
- **\`core:profiles.update\`**: \`{ id, name?, model?, thinkingLevel?, nodeId?, cwd?, restrictToCwd?, tags?, skills?, starters?, system? }\` — partial merge preserving untouched fields; \`managedByPlugin\` is immutable and cannot be modified or stripped.
- **\`core:profiles.delete\`**: \`{ id }\` — delete an unused, non-managed Profile (fails if still bound to any conversation, or if plugin-managed / default \`assistant\`).

## Guardrails & Invariants (Enforced by the Kernel)

- **\`managedByPlugin\` Protection**: \`managedByPlugin\` is reserved for plugin bootstrap metadata — spoofing it on \`create\` is rejected, and \`update\` never modifies or removes an existing \`managedByPlugin\` marker.
- **\`restrictToCwd\` Workspace Guardrail**: Setting \`restrictToCwd: true\` restricts model-facing file tools (\`read\`/\`write\`/\`edit\`/\`register_artifact\`) and explicit subagent \`cwd\` to the conversation's working directory (\`path_outside_workspace\` on escape). It is a model-level guardrail, not an OS sandbox (\`bash\` still follows OS permissions).
- **\`skills\` Tri-State Allowlist**:
  - Omitted (\`undefined\`): all currently available skills are loadable.
  - Empty array (\`[]\`): disables all skills for this Profile.
  - Non-empty string array: only listed skill IDs are available (disabled plugins' managed skills remain unavailable regardless of allowlist).
- **Model Validation**: Explicit \`model\` overrides are validated against available enabled models; disabled models are rejected.
- **Deletion Protection**: Default \`assistant\`, plugin-managed Profiles, and Profiles still bound to any conversation cannot be deleted.
`

const profilesSkillVars: Record<string, string> = {
  SKILL_ID: PROFILES_SKILL_ID,
  MANAGED_BY: PROFILES_SKILL_OWNER,
}

export const PROFILES_SKILL_MD: string = renderSkillTemplate(
  PROFILES_SKILL_TEMPLATE,
  profilesSkillVars,
)

export const PROFILES_SKILL_ASSET: BuiltinSkillAsset = {
  id: PROFILES_SKILL_ID,
  skillMd: PROFILES_SKILL_MD,
  references: {},
}
