/** builtin:tiers managed skill asset loader (compatible with both src and compiled dist). */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HelmxError, type PluginSkillAsset } from '@helmx/protocol'
import { MODEL_TIERS_SKILL_ID, TIERS_PLUGIN_ID } from './contracts.js'

export function resolveTiersSkillDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'skill')
  if (existsSync(local)) return local

  const pkgRoot = resolve(here, '../..')
  const source = join(pkgRoot, 'src', 'tiers', 'skill')
  if (existsSync(source)) return source

  throw new HelmxError(
    'tiers_skill_asset_missing',
    `Built-in plugin ${TIERS_PLUGIN_ID} cannot find its skill asset directory (tried: "${local}", "${source}")`,
    500,
    { pluginId: TIERS_PLUGIN_ID, paths: [local, source] },
  )
}

export function readTiersSkillAsset(): PluginSkillAsset {
  const dir = resolveTiersSkillDir()
  return {
    id: MODEL_TIERS_SKILL_ID,
    skillMd: readFileSync(join(dir, 'SKILL.md'), 'utf-8'),
    references: {},
  }
}
