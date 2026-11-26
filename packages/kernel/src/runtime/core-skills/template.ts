/**
 * Strict `{{KEY}}` template interpolation for kernel-owned core skill markdown assets.
 *
 * Throws `HelmxError('unreplaced_skill_placeholder')` on undefined keys or leftover
 * `{{...}}` placeholders so broken templates fail fast at module load / test time
 * instead of leaking raw placeholders into model prompts.
 */
import { HelmxError } from '@helmx/protocol'

export function renderSkillTemplate(
  template: string,
  vars: Readonly<Record<string, string>>,
): string {
  const rendered = template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const val = vars[key]
    if (val === undefined) {
      throw new HelmxError(
        'unreplaced_skill_placeholder',
        `Skill template has undefined placeholder: {{${key}}}`,
        500,
        { key },
      )
    }
    return val
  })

  const remaining = rendered.match(/\{\{[^}]*\}\}/)
  if (remaining !== null) {
    throw new HelmxError(
      'unreplaced_skill_placeholder',
      `Skill template still contains unreplaced placeholder after rendering: ${remaining[0]}`,
      500,
      { placeholder: remaining[0] },
    )
  }

  return rendered
}
