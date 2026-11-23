/**
 * Baseline test fixture for PluginHostBackend (current contract: zero-arg `isClosing`,
 * plus required ports for `profiles`, `skills`, `secrets`, `getConversationDetail`, etc.).
 *
 * Conventions:
 * - Only provides two shared defaults: `isClosing` always returns `false`, and `redact` is identity;
 * - All unused host operations throw explicit `unsupported` (501) rather than faking empty success;
 * - Use `profile-file-host` to override ports when real profile/skill filesystem behavior is needed;
 * - Class fixtures inherit `PluginHostBackendFixtureBase` (constructor must call `super()`);
 *   object literal fixtures spread `createPluginHostBackendFixture()` and override needed methods
 *   (all returned members are own enumerable properties so object spread never drops methods).
 * - Method signatures derive from `Parameters`/`ReturnType` of `PluginHostBackend` directly so
 *   subclass overrides (including narrower return types) remain compatible without manual narrowing.
 */
import { HelmxError, type PluginSkillAsset } from '@helmx/protocol'
import type { PluginHostBackend } from '../../src/plugins/index.js'

function unsupported(what: string): never {
  throw new HelmxError('unsupported', `test fixture does not implement host capability: ${what} (override in concrete fixture)`, 501)
}

type Port<K extends keyof PluginHostBackend> = PluginHostBackend[K]

/**
 * Class fixture base: implements all default methods on the prototype (never shadows subclass overrides).
 * Any un-overridden operation invoked in tests fails explicitly with `unsupported` (501).
 */
export class PluginHostBackendFixtureBase implements PluginHostBackend {
  readonly ensuredSkills: PluginSkillAsset[] = []

  isClosing(): boolean {
    return false
  }

  redact(text: string): string {
    return text
  }

  profiles: Port<'profiles'> = {
    list: () => unsupported('host.profiles.list'),
    get: () => unsupported('host.profiles.get'),
    getSystem: () => unsupported('host.profiles.getSystem'),
    save: () => unsupported('host.profiles.save'),
    directory: () => unsupported('host.profiles.directory'),
  }

  skills: Port<'skills'> = {
    list: () => unsupported('host.skills.list'),
    readFile: () => unsupported('host.skills.readFile'),
    ensureSkill: async (asset) => {
      this.ensuredSkills.push(structuredClone(asset))
    },
  }

  secrets: Port<'secrets'> = {
    get: () => unsupported('host.secrets.get'),
    set: () => unsupported('host.secrets.set'),
    delete: () => unsupported('host.secrets.delete'),
    addRedaction: () => unsupported('host.secrets.addRedaction'),
  }

  dispatchTrigger(...args: Parameters<Port<'dispatchTrigger'>>): ReturnType<Port<'dispatchTrigger'>> {
    void args
    unsupported('host.dispatchTrigger')
  }

  submitInput(...args: Parameters<Port<'submitInput'>>): ReturnType<Port<'submitInput'>> {
    void args
    unsupported('host.submitInput')
  }

  createConversation(
    ...args: Parameters<Port<'createConversation'>>
  ): ReturnType<Port<'createConversation'>> {
    void args
    unsupported('host.createConversation')
  }

  forkConversation(
    ...args: Parameters<Port<'forkConversation'>>
  ): ReturnType<Port<'forkConversation'>> {
    void args
    unsupported('host.forkConversation')
  }

  listConversations(
    ...args: Parameters<Port<'listConversations'>>
  ): ReturnType<Port<'listConversations'>> {
    void args
    unsupported('host.listConversations')
  }

  getConversation(...args: Parameters<Port<'getConversation'>>): ReturnType<Port<'getConversation'>> {
    void args
    unsupported('host.getConversation')
  }

  getConversationDetail(
    ...args: Parameters<Port<'getConversationDetail'>>
  ): ReturnType<Port<'getConversationDetail'>> {
    void args
    unsupported('host.getConversationDetail')
  }

  getConversationSubmission(
    ...args: Parameters<NonNullable<Port<'getConversationSubmission'>>>
  ): ReturnType<NonNullable<Port<'getConversationSubmission'>>> {
    void args
    unsupported('host.getConversationSubmission')
  }

  updateConversation(
    ...args: Parameters<Port<'updateConversation'>>
  ): ReturnType<Port<'updateConversation'>> {
    void args
    unsupported('host.updateConversation')
  }

  abortConversation(
    ...args: Parameters<Port<'abortConversation'>>
  ): ReturnType<Port<'abortConversation'>> {
    void args
    unsupported('host.abortConversation')
  }

  abortConversationGuarded(
    ...args: Parameters<NonNullable<Port<'abortConversationGuarded'>>>
  ): ReturnType<NonNullable<Port<'abortConversationGuarded'>>> {
    void args
    unsupported('host.abortConversationGuarded')
  }

  resetConversation(
    ...args: Parameters<NonNullable<Port<'resetConversation'>>>
  ): ReturnType<NonNullable<Port<'resetConversation'>>> {
    void args
    unsupported('host.resetConversation')
  }

  resetConversationGuarded(
    ...args: Parameters<NonNullable<Port<'resetConversationGuarded'>>>
  ): ReturnType<NonNullable<Port<'resetConversationGuarded'>>> {
    void args
    unsupported('host.resetConversationGuarded')
  }

  compactConversation(
    ...args: Parameters<NonNullable<Port<'compactConversation'>>>
  ): ReturnType<NonNullable<Port<'compactConversation'>>> {
    void args
    unsupported('host.compactConversation')
  }

  compactConversationGuarded(
    ...args: Parameters<NonNullable<Port<'compactConversationGuarded'>>>
  ): ReturnType<NonNullable<Port<'compactConversationGuarded'>>> {
    void args
    unsupported('host.compactConversationGuarded')
  }

  submitInputGuarded(
    ...args: Parameters<NonNullable<Port<'submitInputGuarded'>>>
  ): ReturnType<NonNullable<Port<'submitInputGuarded'>>> {
    void args
    unsupported('host.submitInputGuarded')
  }

  getConversationOwnership(
    ...args: Parameters<Port<'getConversationOwnership'>>
  ): ReturnType<Port<'getConversationOwnership'>> {
    void args
    unsupported('host.getConversationOwnership')
  }

  listArtifacts(...args: Parameters<Port<'listArtifacts'>>): ReturnType<Port<'listArtifacts'>> {
    void args
    unsupported('host.listArtifacts')
  }

  createArtifact(
    ...args: Parameters<NonNullable<Port<'createArtifact'>>>
  ): ReturnType<NonNullable<Port<'createArtifact'>>> {
    void args
    unsupported('host.createArtifact')
  }

  readArtifact(
    ...args: Parameters<NonNullable<Port<'readArtifact'>>>
  ): ReturnType<NonNullable<Port<'readArtifact'>>> {
    void args
    unsupported('host.readArtifact')
  }

  completeText(...args: Parameters<Port<'completeText'>>): ReturnType<Port<'completeText'>> {
    void args
    unsupported('host.completeText')
  }

  executionEnv(...args: Parameters<Port<'executionEnv'>>): ReturnType<Port<'executionEnv'>> {
    void args
    unsupported('host.executionEnv')
  }

  withFileLock<T>(
    _path: string,
    _fn: () => Promise<T>,
    _opts?: { signal?: AbortSignal },
  ): Promise<T> {
    unsupported('host.withFileLock')
  }

  atomicWriteFile(
    ...args: Parameters<Port<'atomicWriteFile'>>
  ): ReturnType<Port<'atomicWriteFile'>> {
    void args
    unsupported('host.atomicWriteFile')
  }

  manageConversation(
    ...args: Parameters<Port<'manageConversation'>>
  ): ReturnType<Port<'manageConversation'>> {
    void args
    unsupported('host.manageConversation')
  }

  markConversationOwnership(
    ...args: Parameters<Port<'markConversationOwnership'>>
  ): ReturnType<Port<'markConversationOwnership'>> {
    void args
    unsupported('host.markConversationOwnership')
  }

  spawnAgent(...args: Parameters<Port<'spawnAgent'>>): ReturnType<Port<'spawnAgent'>> {
    void args
    unsupported('host.spawnAgent')
  }

  runGate(...args: Parameters<Port<'runGate'>>): ReturnType<Port<'runGate'>> {
    void args
    unsupported('host.runGate')
  }

  execEnv(...args: Parameters<Port<'execEnv'>>): ReturnType<Port<'execEnv'>> {
    void args
    throw new HelmxError('unsupported', 'this fixture does not execute node commands', 501)
  }

  resolveSpawnTarget(
    ...args: Parameters<Port<'resolveSpawnTarget'>>
  ): ReturnType<Port<'resolveSpawnTarget'>> {
    void args
    unsupported('host.resolveSpawnTarget')
  }

  listActiveSpawnExecutions(
    ...args: Parameters<Port<'listActiveSpawnExecutions'>>
  ): ReturnType<Port<'listActiveSpawnExecutions'>> {
    void args
    unsupported('host.listActiveSpawnExecutions')
  }

  inspectNodePathUsage(
    ...args: Parameters<Port<'inspectNodePathUsage'>>
  ): ReturnType<Port<'inspectNodePathUsage'>> {
    void args
    unsupported('host.inspectNodePathUsage')
  }

  refreshModels(...args: Parameters<Port<'refreshModels'>>): ReturnType<Port<'refreshModels'>> {
    void args
    unsupported('host.refreshModels')
  }

  listModels(...args: Parameters<NonNullable<Port<'listModels'>>>): ReturnType<NonNullable<Port<'listModels'>>> {
    void args
    unsupported('host.listModels')
  }

  createAsk(...args: Parameters<Port<'createAsk'>>): ReturnType<Port<'createAsk'>> {
    void args
    unsupported('host.createAsk')
  }

  cancelAsk(...args: Parameters<Port<'cancelAsk'>>): ReturnType<Port<'cancelAsk'>> {
    void args
    unsupported('host.cancelAsk')
  }

  onEvent(...args: Parameters<Port<'onEvent'>>): ReturnType<Port<'onEvent'>> {
    void args
    unsupported('host.onEvent')
  }

  emitEvent(...args: Parameters<Port<'emitEvent'>>): ReturnType<Port<'emitEvent'>> {
    void args
    unsupported('host.emitEvent')
  }
}

/**
 * Object-literal default backend fixture: shares the same default semantics as `PluginHostBackendFixtureBase`,
 * with every member as an own enumerable property so callers can spread and selectively override.
 */
export function createPluginHostBackendFixture(): PluginHostBackend {
  const d = new PluginHostBackendFixtureBase()
  const f = <A extends unknown[], R>(fn: (...a: A) => R) => (...a: A): R => fn(...a)
  return {
    isClosing: () => d.isClosing(),
    redact: (text: string) => d.redact(text),
    profiles: {
      list: d.profiles.list,
      get: d.profiles.get,
      getSystem: d.profiles.getSystem,
      save: d.profiles.save,
      directory: d.profiles.directory,
    },
    skills: {
      list: d.skills.list,
      readFile: d.skills.readFile,
      ensureSkill: d.skills.ensureSkill,
    },
    secrets: {
      get: d.secrets.get,
      set: d.secrets.set,
      delete: d.secrets.delete,
      addRedaction: d.secrets.addRedaction,
    },
    dispatchTrigger: f(d.dispatchTrigger),
    submitInput: f(d.submitInput),
    submitInputGuarded: f(d.submitInputGuarded),
    createConversation: f(d.createConversation),
    forkConversation: f(d.forkConversation),
    listConversations: f(d.listConversations),
    getConversation: f(d.getConversation),
    getConversationDetail: f(d.getConversationDetail),
    getConversationSubmission: f(d.getConversationSubmission),
    updateConversation: f(d.updateConversation),
    abortConversation: f(d.abortConversation),
    abortConversationGuarded: f(d.abortConversationGuarded),
    resetConversation: f(d.resetConversation),
    resetConversationGuarded: f(d.resetConversationGuarded),
    compactConversation: f(d.compactConversation),
    compactConversationGuarded: f(d.compactConversationGuarded),
    getConversationOwnership: f(d.getConversationOwnership),
    listArtifacts: f(d.listArtifacts),
    createArtifact: f(d.createArtifact),
    readArtifact: f(d.readArtifact),
    completeText: f(d.completeText),
    executionEnv: f(d.executionEnv),
    withFileLock: <T,>(...args: Parameters<PluginHostBackend['withFileLock']>) =>
      d.withFileLock(...(args as [string, () => Promise<T>, { signal?: AbortSignal }?])) as Promise<T>,
    atomicWriteFile: f(d.atomicWriteFile),
    manageConversation: f(d.manageConversation),
    markConversationOwnership: f(d.markConversationOwnership),
    spawnAgent: f(d.spawnAgent),
    runGate: f(d.runGate),
    execEnv: f(d.execEnv),
    resolveSpawnTarget: f(d.resolveSpawnTarget),
    listActiveSpawnExecutions: f(d.listActiveSpawnExecutions),
    inspectNodePathUsage: f(d.inspectNodePathUsage),
    refreshModels: f(d.refreshModels),
    listModels: f(d.listModels),
    createAsk: f(d.createAsk),
    cancelAsk: f(d.cancelAsk),
    onEvent: f(d.onEvent),
    emitEvent: f(d.emitEvent),
  }
}
