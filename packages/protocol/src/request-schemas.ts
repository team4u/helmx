/**
 * Single source of truth for server-side HTTP request TypeBox schemas and shared validation regexes.
 *
 * Exported ONLY from `@helmx/protocol` (never from `@helmx/protocol/browser`) so browser bundles
 * do not pull in server-side TypeBox schema builders. Consumed by `packages/kernel/src/http/validate.ts`
 * and HTTP domain route handlers via `assertBodySchema` / `parseBodyWithSchema`.
 */
import { Type, type Static } from 'typebox'
import { NODE_ID_PATTERN, NODE_ID_REGEX } from './agent-exec.js'
import type { ProfileStarterPrompt, ProviderConfig } from './assets.js'
import { MODEL_THINKING_LEVELS, type ConversationListFilter } from './conversation.js'
import { ENV_EXEC_MAX_TIMEOUT_MS, type EnvExecRequest, type NodeUpgradeInput } from './env-rpc.js'
import type { ConversationSearchOptions } from './http.js'
import type { PluginConfigFieldValue } from './plugin-dto.js'
import { SKILL_ID_PATTERN } from './skill-contract.js'
import { ENV_NAME_REGEX } from './utils.js'

/** Maximum safe JS integer (`Number.MAX_SAFE_INTEGER`) shared with kernel boundary checks. */
const MAX_SAFE_INTEGER = 9007199254740991

/** Single source of truth for reusable HTTP request field validation regex patterns. */
export const REQUEST_SCHEMA_PATTERNS = Object.freeze({
  id: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  nodeId: NODE_ID_REGEX,
  skillId: SKILL_ID_PATTERN,
  modelRef: /^[^/\s]+\/[^\s]+$/,
  httpUrlPrefix: /^https?:\/\//,
  nonWhitespace: /\S/,
  host: /^[^\s\x00-\x1f\x7f]+$/,
  envName: ENV_NAME_REGEX,
  noNulByte: /^[^\u0000]*$/,
})

/** Reusable TypeBox schema primitives (valid JSON Schema consumed by `@helmx/protocol`'s `validateOrThrow` cache). */
const IdString = Type.String({ pattern: REQUEST_SCHEMA_PATTERNS.id.source })
const NodeIdString = Type.String({ pattern: NODE_ID_PATTERN })
const NonEmptyString = Type.String({ minLength: 1 })
const NonWhitespaceString = Type.String({ pattern: REQUEST_SCHEMA_PATTERNS.nonWhitespace.source })
const SafePositiveInt = Type.Integer({ minimum: 1, maximum: MAX_SAFE_INTEGER })
const SafeNonNegativeInt = Type.Integer({ minimum: 0, maximum: MAX_SAFE_INTEGER })
const ThinkingLevelSchema = Type.Enum(['', ...MODEL_THINKING_LEVELS] as const)
const HostString = Type.String({ minLength: 1, pattern: REQUEST_SCHEMA_PATTERNS.host.source })
const PortInt = Type.Integer({ minimum: 1, maximum: 65535 })

const CONVERSATION_COMMON_PROPS = {
  title: Type.Optional(NonEmptyString),
  profileId: Type.Optional(IdString),
  tags: Type.Optional(Type.Array(NonEmptyString)),
  nodeId: Type.Optional(NodeIdString),
  cwd: Type.Optional(Type.String()),
}

const ConversationInitSchema = Type.Object(
  {
    ...CONVERSATION_COMMON_PROPS,
    parentConversationId: Type.Optional(SafePositiveInt),
    model: Type.Optional(Type.String({ pattern: REQUEST_SCHEMA_PATTERNS.modelRef.source })),
  },
  { additionalProperties: false },
)

const ConversationPatchSchema = Type.Object(
  {
    ...CONVERSATION_COMMON_PROPS,
    model: Type.Optional(Type.String()),
    thinkingLevel: Type.Optional(ThinkingLevelSchema),
    unread: Type.Optional(Type.Boolean()),
    pinned: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

const ConversationInputSchema = Type.Object(
  {
    text: Type.String(),
    whenBusy: Type.Optional(Type.Enum(['steer', 'followUp', 'reject'] as const)),
    whenPendingAsk: Type.Optional(Type.Enum(['supersede', 'reject'] as const)),
    origin: Type.Optional(Type.Enum(['human', 'agent', 'trigger'] as const)),
    meta: Type.Optional(Type.Object({}, { additionalProperties: true })),
    attachments: Type.Optional(Type.Array(IdString)),
    replaceFromEntryId: Type.Optional(SafePositiveInt),
  },
  { additionalProperties: false },
)

const AskAnswerValueSchema = Type.Union([
  Type.String(),
  Type.Array(NonEmptyString, { maxItems: 32 }),
])

const AskAnswerSchema = Type.Object(
  {
    answers: Type.Object({}, { additionalProperties: AskAnswerValueSchema }),
    expectedStateSeq: Type.Optional(SafeNonNegativeInt),
  },
  { additionalProperties: false },
)

const ConversationResetSchema = Type.Object(
  { handoff: Type.Optional(Type.String()) },
  { additionalProperties: false },
)

const ConversationCompactSchema = Type.Object(
  { instructions: Type.Optional(Type.String()) },
  { additionalProperties: false },
)

const ConversationForkSchema = Type.Object(
  {
    entryId: Type.Optional(SafePositiveInt),
    title: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
)

const ConversationWithdrawSchema = Type.Object(
  { submissionId: SafePositiveInt },
  { additionalProperties: false },
)

const ConversationBulkDeleteSchema = Type.Object(
  { ids: Type.Array(SafePositiveInt, { minItems: 1, maxItems: 1000 }) },
  { additionalProperties: false },
)

const ConversationSearchQuerySchema = Type.Object(
  {
    q: NonWhitespaceString,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    maxPerConversation: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    profileId: Type.Optional(NonWhitespaceString),
    ownedBy: Type.Optional(Type.Enum(['human', 'helmx'] as const)),
    topLevelOnly: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

const ConversationListQuerySchema = Type.Object(
  {
    profileId: Type.Optional(NonWhitespaceString),
    status: Type.Optional(Type.Enum(['working', 'blocked', 'done', 'idle', 'error'] as const)),
    tag: Type.Optional(NonEmptyString),
    ownedBy: Type.Optional(Type.Enum(['human', 'helmx'] as const)),
    parentConversationId: Type.Optional(SafePositiveInt),
    topLevelOnly: Type.Optional(Type.Boolean()),
    all: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

const ProfileStarterSchema = Type.Object(
  {
    label: Type.String(),
    prompt: Type.String(),
  },
  { additionalProperties: false },
)

const PROFILE_COMMON_PROPS = {
  name: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  thinkingLevel: Type.Optional(ThinkingLevelSchema),
  nodeId: Type.Optional(NodeIdString),
  cwd: Type.Optional(NonEmptyString),
  tags: Type.Optional(Type.Array(NonEmptyString)),
  skills: Type.Optional(Type.Array(Type.String({ pattern: REQUEST_SCHEMA_PATTERNS.skillId.source }))),
  starters: Type.Optional(Type.Array(ProfileStarterSchema)),
  managedByPlugin: Type.Optional(Type.String()),
  restrictToCwd: Type.Optional(Type.Boolean()),
  system: Type.Optional(Type.String()),
}

const ProfileCreateSchema = Type.Object(
  { id: IdString, ...PROFILE_COMMON_PROPS },
  { additionalProperties: false },
)

const ProfileUpdateSchema = Type.Object(
  { id: Type.Optional(IdString), ...PROFILE_COMMON_PROPS },
  { additionalProperties: false },
)

const ProviderItemSchema = Type.Object(
  {
    id: IdString,
    protocol: Type.Enum(['openai', 'anthropic'] as const),
    baseUrl: Type.String({ pattern: REQUEST_SCHEMA_PATTERNS.httpUrlPrefix.source }),
    models: Type.Array(Type.String()),
    label: Type.Optional(Type.String()),
    enabled: Type.Boolean(),
  },
  { additionalProperties: false },
)

const ProvidersPutSchema = Type.Object(
  { providers: Type.Array(ProviderItemSchema) },
  { additionalProperties: false },
)

const CredentialPutSchema = Type.Object(
  { value: NonEmptyString },
  { additionalProperties: false },
)

const ActionInvokeSchema = Type.Object(
  {
    // input can be any JSON value (including null); only key presence is required.
    input: Type.Unknown(),
    conversationId: Type.Optional(SafePositiveInt),
  },
  { additionalProperties: false },
)

const PluginConfigValueSchema = Type.Union([
  Type.String(),
  Type.Number(),
  Type.Boolean(),
  Type.Array(Type.String()),
  Type.Null(),
])

const PluginConfigPutSchema = Type.Object(
  {
    values: Type.Object(
      {},
      { additionalProperties: PluginConfigValueSchema },
    ),
  },
  { additionalProperties: false },
)

const PluginInstallSchema = Type.Object(
  {
    source: NonWhitespaceString,
    enable: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

const PluginDisableSchema = Type.Object(
  { force: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
)

const PluginUpdateSchema = Type.Object(
  { source: Type.Optional(NonWhitespaceString) },
  { additionalProperties: false },
)

const PluginDoctorSchema = Type.Object(
  {
    path: Type.Optional(NonWhitespaceString),
    id: Type.Optional(NonWhitespaceString),
  },
  { additionalProperties: false },
)

// At least one of model, thinkingLevel, compactionModel, compactionThinkingLevel, or the per-model pair
// (modelThinking + modelThinkingLevel together) is required (anyOf); empty string clears the matching override.
const ModelsDefaultPutSchema = Type.Object(
  {
    model: Type.Optional(Type.String()),
    thinkingLevel: Type.Optional(Type.String()),
    compactionModel: Type.Optional(Type.String()),
    compactionThinkingLevel: Type.Optional(Type.String()),
    modelThinking: Type.Optional(Type.String()),
    modelThinkingLevel: Type.Optional(Type.String()),
    modelThinkingLevels: Type.Optional(Type.Object({}, { additionalProperties: Type.String() })),
  },
  {
    additionalProperties: false,
    anyOf: [
      { required: ['model'] },
      { required: ['thinkingLevel'] },
      { required: ['compactionModel'] },
      { required: ['compactionThinkingLevel'] },
      { required: ['modelThinking', 'modelThinkingLevel'] },
      { required: ['modelThinkingLevels'] },
    ],
  },
)

const ModelsFilterPutSchema = Type.Object(
  {
    provider: Type.Optional(Type.String()),
    disabledModels: Type.Array(Type.String()),
  },
  { additionalProperties: false },
)

// Note: provider/providers non-emptiness uses `=== ''` semantics (historically allows whitespace strings);
// do not add a `\S` pattern to avoid tightening behavior.
const ModelsRefreshSchema = Type.Object(
  {
    provider: Type.Optional(NonEmptyString),
    providers: Type.Optional(Type.Array(NonEmptyString)),
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

// Enforce strict password payload shape without unknown extra properties.
const AuthPasswordSchema = Type.Object(
  { password: NonEmptyString },
  { additionalProperties: false },
)

const NodeIssueSchema = Type.Object(
  { nodeId: NonEmptyString },
  { additionalProperties: false },
)

// targetVersion also requires strict SemVer validation (pure ASCII, consistent length bounds);
// registryUrl must be parseable and include a hostname.
const NodeUpgradeSchema = Type.Object(
  {
    targetVersion: Type.Optional(Type.String({ maxLength: 64 })),
    registryUrl: Type.Optional(Type.String()),
    force: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

const NodeForwardSchema = Type.Object(
  {
    listenHost: HostString,
    listenPort: PortInt,
    targetHost: Type.Optional(HostString),
    targetPort: PortInt,
  },
  { additionalProperties: false },
)

const EnvExecSchema = Type.Object(
  {
    command: Type.Union([
      NonWhitespaceString,
      Type.Array(Type.String(), { minItems: 1 }),
    ]),
    nodeId: Type.Optional(NodeIdString),
    // Cross-platform cwd absoluteness (POSIX/drive/UNC) is a semantic rule validated explicitly in the handler.
    cwd: Type.Optional(Type.String()),
    conversationId: Type.Optional(SafePositiveInt),
    env: Type.Optional(
      Type.Object(
        {},
        {
          propertyNames: { pattern: REQUEST_SCHEMA_PATTERNS.envName.source },
          additionalProperties: Type.String({ pattern: REQUEST_SCHEMA_PATTERNS.noNulByte.source }),
        },
      ),
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: ENV_EXEC_MAX_TIMEOUT_MS })),
    stream: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
)

/** Single source of truth for validated HTTP request TypeBox schemas across kernel routes and boundary parsers. */
export const REQUEST_SCHEMAS = Object.freeze({
  conversationInit: ConversationInitSchema,
  conversationPatch: ConversationPatchSchema,
  conversationInput: ConversationInputSchema,
  askAnswer: AskAnswerSchema,
  conversationReset: ConversationResetSchema,
  conversationCompact: ConversationCompactSchema,
  conversationFork: ConversationForkSchema,
  conversationWithdraw: ConversationWithdrawSchema,
  conversationBulkDelete: ConversationBulkDeleteSchema,
  conversationSearchQuery: ConversationSearchQuerySchema,
  conversationListQuery: ConversationListQuerySchema,
  profileStarter: ProfileStarterSchema,
  profileCreate: ProfileCreateSchema,
  profileUpdate: ProfileUpdateSchema,
  providersPut: ProvidersPutSchema,
  credentialPut: CredentialPutSchema,
  actionInvoke: ActionInvokeSchema,
  pluginConfigPut: PluginConfigPutSchema,
  pluginInstall: PluginInstallSchema,
  pluginDisable: PluginDisableSchema,
  pluginUpdate: PluginUpdateSchema,
  pluginDoctor: PluginDoctorSchema,
  modelsDefaultPut: ModelsDefaultPutSchema,
  modelsFilterPut: ModelsFilterPutSchema,
  modelsRefresh: ModelsRefreshSchema,
  authPassword: AuthPasswordSchema,
  nodeIssue: NodeIssueSchema,
  nodeUpgrade: NodeUpgradeSchema,
  nodeForward: NodeForwardSchema,
  envExec: EnvExecSchema,
})

// ---------------------------------------------------------------------------
// Bi-directional compile-time locks against protocol DTO interfaces
// ---------------------------------------------------------------------------

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never

const _requestSchemaParityLocks: [
  AssertExact<Static<typeof ProfileStarterSchema>, ProfileStarterPrompt>,
  AssertExact<Static<typeof ProviderItemSchema>, ProviderConfig>,
  AssertExact<Static<typeof ConversationResetSchema>, { handoff?: string }>,
  AssertExact<Static<typeof ConversationCompactSchema>, { instructions?: string }>,
  AssertExact<Static<typeof ConversationForkSchema>, { entryId?: number; title?: string }>,
  AssertExact<Static<typeof ConversationWithdrawSchema>, { submissionId: number }>,
  AssertExact<Static<typeof ConversationBulkDeleteSchema>, { ids: number[] }>,
  AssertExact<Static<typeof ConversationSearchQuerySchema>, { q: string } & ConversationSearchOptions>,
  AssertExact<Static<typeof ConversationListQuerySchema>, ConversationListFilter & { all?: boolean }>,
  AssertExact<Static<typeof NodeUpgradeSchema>, NodeUpgradeInput>,
  AssertExact<Static<typeof EnvExecSchema>['command'], EnvExecRequest['command']>,
  AssertExact<Static<typeof EnvExecSchema>['nodeId'], EnvExecRequest['nodeId']>,
  AssertExact<Static<typeof EnvExecSchema>['cwd'], EnvExecRequest['cwd']>,
  AssertExact<Static<typeof EnvExecSchema>['conversationId'], EnvExecRequest['conversationId']>,
  AssertExact<Static<typeof EnvExecSchema>['timeoutMs'], EnvExecRequest['timeoutMs']>,
  AssertExact<Static<typeof EnvExecSchema>['stream'], EnvExecRequest['stream']>,
  AssertExact<Static<typeof PluginConfigValueSchema>, PluginConfigFieldValue | null>,
] = [
  true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true, true,
]
void _requestSchemaParityLocks
