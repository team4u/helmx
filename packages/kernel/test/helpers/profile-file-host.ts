import { join } from 'node:path'
import { HelmxError, assertProfileId, type HelmxHostApi } from '@helmx/protocol'
import { atomicWriteFile, FileNotFoundError } from '../../src/services/atomic-file.js'
import { withFileLock } from '../../src/services/file-lock.js'
import { ProfileService } from '../../src/services/profile-service.js'
import { SkillService } from '../../src/services/skill-service.js'

function validateId(id: string): void {
  try {
    assertProfileId(id)
  } catch (error) {
    throw new HelmxError('validation_error', error instanceof Error ? error.message : String(error), 400, { profileId: id })
  }
}

/** Adapts the real file service to the public plugin port so tests never inject private kernel objects into plugins. */
export function createProfileFileHost(
  dataDir: string,
  profiles = new ProfileService(dataDir),
): Pick<HelmxHostApi, 'profiles' | 'skills' | 'atomicWriteFile' | 'withFileLock'> {
  const skills = new SkillService(dataDir)
  return {
    profiles: {
      list: () => profiles.list(),
      async get(id) {
        validateId(id)
        return profiles.get(id)
      },
      save: (profile) => profiles.save(profile),
      async getSystem(id) {
        try {
          return await profiles.getSystem(id)
        } catch (error) {
          if (error instanceof FileNotFoundError) {
            throw new HelmxError('not_found', error.message, 404)
          }
          throw error
        }
      },
      async directory(id) {
        validateId(id)
        return join(dataDir, 'profiles', id)
      },
    },
    skills: {
      list: () => skills.list(),
      readFile: (id, path) => skills.readFile(id, path),
      ensureSkill: (asset) => skills.ensureSkill(asset),
    },
    atomicWriteFile,
    withFileLock: (path, fn, opts) => withFileLock(path, () => {
      opts?.signal?.throwIfAborted()
      return fn()
    }),
  }
}
