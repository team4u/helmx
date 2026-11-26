/**
 * Structural host interfaces for `KernelRuntime` consumers (`runtime-services`, `runtime-host-backend`,
 * `core-actions`). Extracting these interfaces into a leaf module eliminates type-only cycles against
 * `runtime.ts` without changing runtime behavior.
 */
import type { MaybePromise, PluginSkillAsset } from '@helmx/protocol'
import type { EnvFabric } from '../env/index.js'
import type { NodeForwardService } from '../env/forward.js'
import type { PluginHost } from '../plugins/index.js'
import type {
  ArtifactService as SvcArtifactService,
  CredentialService,
  ProfileService,
  SecretStash,
  SkillService,
} from '../services/index.js'
import type { AskService } from './asks.js'
import type { ConversationService } from './conversation-service.js'
import type { ModelRegistry } from './model-registry.js'
import type { NodeManager } from './node-manager.js'
import type { RuntimeAgentSpawn } from './runtime-agent-spawn.js'
import type { RuntimeOwnershipManager } from './runtime-ownership.js'
import type { RuntimeTriggerDispatcher } from './runtime-triggers.js'

/** Minimal runtime surface required by `assembleRuntimeServices` (`runtime-services.ts`). */
export interface RuntimeServicesHost {
  readonly hubUrl: string
  readonly isClosing: boolean
  readonly started: boolean
  readonly processToken: string | undefined
  readonly plugins: PluginHost
}

/** Structural runtime surface required by `registerCoreActions` (`core-actions.ts`). */
export interface CoreActionsRuntimeHost {
  readonly asks: AskService
  readonly conversations: ConversationService
  readonly models: ModelRegistry
  readonly nodeForward: NodeForwardService
  readonly nodes: NodeManager
  readonly ownership: RuntimeOwnershipManager
  readonly profiles: ProfileService
  readonly skills: SkillService
  readonly stash: SecretStash
}

/** Structural runtime surface required by `createPluginHostBackend` (`runtime-host-backend.ts`). */
export interface RuntimeHostBackendSource {
  readonly isClosing: boolean
  readonly dataDir: string
  readonly profiles: ProfileService
  readonly skills: SkillService
  readonly credentials: CredentialService
  readonly stash: SecretStash
  readonly envFabric: EnvFabric
  readonly nodes: NodeManager
  readonly triggers: RuntimeTriggerDispatcher
  readonly conversations: ConversationService
  readonly ownership: RuntimeOwnershipManager
  readonly artifacts: SvcArtifactService
  readonly models: ModelRegistry
  readonly agentSpawn: RuntimeAgentSpawn
  readonly asks: AskService
  ensurePluginSkill(asset: PluginSkillAsset, pluginId: string): Promise<void>
  onEvent(type: string, listener: (payload: unknown) => MaybePromise<void>): () => void
  emitHostEvent(type: string, payload: unknown, options?: { broadcast?: boolean }): MaybePromise<void>
}
