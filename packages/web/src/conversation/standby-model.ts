/**
 * Agent standby pane pure logic and draft storage:
 * - the standby state is a true draft: no fabricated ConversationSummary, no
 *   pre-created conversation, no uploaded attachments;
 * - drafts live in memory only (a module-level Map, isolated per
 *   `panel:profileId` coordinate so primary/split never cross), surviving
 *   component unmounts / target switches (in-flight first sends and retries
 *   all reference the same record);
 * - the first-send pipeline (create -> patch thinkingLevel -> upload
 *   attachments -> submitInput) guards double-click/Enter concurrency with a
 *   synchronous sending flag; after create succeeds, any later failure keeps
 *   the real conversation id and uploaded attachments for reuse on retry —
 *   never duplicating creation or auto-deleting to mask a failure.
 * This module exports no components; the only React binding is the single
 * useSyncExternalStore hook.
 */
import { useSyncExternalStore } from 'react'
import type { ArtifactMetadata, ConversationInit, ConversationSummary, Profile } from '@helmx/protocol/browser'
import { resolveEffectiveThinkingLevel } from '@helmx/plugin-client/pure'
import type { WebMessageTranslator } from '../i18n/catalog.js'
import { isElementVisibleInDocument } from '../lib/dom-visibility.js'
import { resolveFocusedPanel } from '../lib/panel-focus.js'
import type { ActiveModal, FocusedPanel, ResolvedTarget } from '../lib/types.js'
import { hasDialogOpen } from '../shell/shortcuts-model.js'
import { isTextInputElement } from '../shell/version-watch-model.js'
import { envDraftError, parseCompactSlashCommand, type EnvDraft } from './composer-model.js'

/** Attachments staged locally before sending (no conversation created, nothing uploaded). */
export interface StandbyLocalFile {
  key: string
  file: File
  name: string
  size: number
  mimeType: string
}

/** Uploaded attachments (reused on retry after a partial first-send failure;
 * never re-uploaded). */
export interface StandbyUploadedAttachment {
  artifactId: string
  name: string
  size: number
  mimeType: string
}

/** Full standby draft state (an immutable record in module-level storage,
 * wholly replaced on each update). */
export interface StandbyDraftState {
  text: string
  localFiles: StandbyLocalFile[]
  uploaded: StandbyUploadedAttachment[]
  /** Explicit model selection; undefined = follow the Profile/global default
   * (resolved by the server, never fabricated). */
  model: string | undefined
  /** Explicit thinking level; undefined = no patch (patchable only after creation). */
  thinkingLevel: string | undefined
  /** Optional staged one-turn model override carried only on the first `submitInput`. */
  nextTurnModel: string | undefined
  /** Optional staged one-turn thinking-level override carried only on the first `submitInput`. */
  nextTurnThinkingLevel: string | undefined
  /** Whether the environment was explicitly customized (URL inheritance or
   * user edit); false means create carries no nodeId/cwd. */
  envCustomized: boolean
  envNodeId: string | undefined
  envCwd: string | undefined
  /** Resume anchor after a partial first-send failure: the real created
   * conversation id (retry skips create). */
  conversationId: number | undefined
  /** Per-draft input metadata carried into the first `submitInput` payload (does not mark draft dirty). */
  inputMeta: Readonly<Record<string, unknown>> | undefined
  /** Synchronous debounce flag: set to true synchronously when the first-send
   * task starts; double-click / repeated Enter are ignored outright. */
  sending: boolean
  /** User-readable error of the most recent first-send failure (shown until retried). */
  error: string | null
}

export const EMPTY_STANDBY_DRAFT: StandbyDraftState = {
  text: '',
  localFiles: [],
  uploaded: [],
  model: undefined,
  thinkingLevel: undefined,
  nextTurnModel: undefined,
  nextTurnThinkingLevel: undefined,
  envCustomized: false,
  envNodeId: undefined,
  envCwd: undefined,
  conversationId: undefined,
  inputMeta: undefined,
  sending: false,
  error: null,
}

/** Attachment size cap, identical to the existing Composer (15 MiB). */
export const STANDBY_FILE_MAX_BYTES = 15 * 1024 * 1024

/**
 * Accept only real Blob/File objects (Blob-branded instances that must be
 * arrayBuffer-readable and carry name/size): plain objects riding synthetic
 * events (fake Files with only name/size) are rejected at the admission
 * boundary. Otherwise they would sneak into the draft and render as normal
 * chips until the first send's uploadArtifact call throws a synchronous
 * TypeError at file.arrayBuffer(), cutting the anchored send chain in half
 * (verified in a browser: after create succeeds — zero uploads, zero input,
 * zero navigation, only a failure toast).
 */
function isReadableFileLike(file: unknown): file is File {
  if (file === null || typeof file !== 'object' || typeof Blob === 'undefined') return false
  if (!(file instanceof Blob)) return false
  const candidate = file as Partial<Blob> & { name?: unknown }
  return typeof candidate.arrayBuffer === 'function' && typeof candidate.size === 'number' && typeof candidate.name === 'string'
}

export interface StandbyFocusRequest {
  readonly seq: number
  readonly panel: 'primary' | 'split'
  readonly profileId: string
  readonly explicit: boolean
}

type DraftListener = () => void

const drafts = new Map<string, StandbyDraftState>()
const listeners = new Set<DraftListener>()
const focusListeners = new Set<DraftListener>()
let pendingStandbyFocus: StandbyFocusRequest | null = null
let standbyFocusSeq = 0
let localFileSeq = 0
export const EMPTY_STANDBY_DIRTY_KEYS: ReadonlyArray<string> = []
let dirtyKeysCache: ReadonlyArray<string> = EMPTY_STANDBY_DIRTY_KEYS
/** Draft lifecycle epoch: bumped on full resets such as logout; in-flight
 * first-send tasks verify the epoch after every await and discard their
 * responses when it changed (no reviving text/attachments, no further
 * upload/send, no notices, no navigation). */
let draftEpoch = 0

function notifyFocusListeners(): void {
  for (const listener of focusListeners) listener()
}

function subscribeStandbyFocus(listener: DraftListener): () => void {
  focusListeners.add(listener)
  return () => {
    focusListeners.delete(listener)
  }
}

/** Issue an explicit request to focus the target standby textarea on next commit/effect. */
export function requestStandbyFocus(input: {
  panel: 'primary' | 'split'
  profileId: string
  explicit?: boolean
}): number {
  standbyFocusSeq += 1
  pendingStandbyFocus = {
    seq: standbyFocusSeq,
    panel: input.panel,
    profileId: input.profileId,
    explicit: input.explicit !== false,
  }
  notifyFocusListeners()
  return standbyFocusSeq
}

/** Current pending standby focus request, or null when idle/consumed. */
export function getStandbyFocusRequest(): StandbyFocusRequest | null {
  return pendingStandbyFocus
}

/** Clear the pending standby focus request (optionally matching a specific ticket seq). */
export function clearStandbyFocusRequest(seq?: number): void {
  if (pendingStandbyFocus === null) return
  if (seq !== undefined && pendingStandbyFocus.seq !== seq) return
  pendingStandbyFocus = null
  notifyFocusListeners()
}

/** React subscription for pending explicit standby focus requests. */
export function useStandbyFocusRequest(): StandbyFocusRequest | null {
  return useSyncExternalStore(subscribeStandbyFocus, getStandbyFocusRequest, () => null)
}

function isStandbyDraftDirtyRecord(draft: StandbyDraftState): boolean {
  return (
    draft.text.trim() !== '' ||
    draft.localFiles.length > 0 ||
    draft.uploaded.length > 0 ||
    draft.sending
  )
}

function syncDirtyKeysCache(): void {
  const keys: string[] = []
  for (const [key, draft] of drafts.entries()) {
    if (isStandbyDraftDirtyRecord(draft)) keys.push(key)
  }
  keys.sort()
  if (keys.length === dirtyKeysCache.length && keys.every((k, i) => k === dirtyKeysCache[i])) return
  dirtyKeysCache = keys.length === 0 ? EMPTY_STANDBY_DIRTY_KEYS : keys
}

function notifyListeners(): void {
  syncDirtyKeysCache()
  for (const listener of listeners) listener()
}

/** Subscribe to draft-store changes (for read-only consumers like the version
 * auto-refresh pending check). */
export function subscribeStandbyDrafts(listener: DraftListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Referentially stable list of dirty standby draft keys (for useSyncExternalStore).
 */
export function standbyDirtyDraftKeys(): ReadonlyArray<string> {
  return dirtyKeysCache
}

/**
 * Whether any standby draft at any coordinate carries unsubmitted local state
 * (non-empty text / staged or uploaded attachments / a first send in flight).
 * Consumed when the version auto-refresh treats unsubmitted browser-local
 * content as the pending condition; text and attachments stay un-persisted
 * until the first send succeeds, and a sending failure anchor (conversationId)
 * counts as local state too.
 */
export function standbyDraftsDirty(): boolean {
  return dirtyKeysCache.length > 0
}

/** Draft entry coordinate: panel + Profile + inherited environment. The same
 * Profile at different remote coordinates yields two independent drafts so an
 * environment inherited from an earlier navigation never leaks into the next
 * first send as if the user had edited it. */
export interface StandbyCoordinate {
  panel: 'primary' | 'split'
  profileId: string
  nodeId?: string
  cwd?: string
}

/** Draft storage key: normalized JSON (fixed field order, empty values
 * omitted) — unambiguous per entry coordinate. */
export function standbyDraftKey(coordinate: StandbyCoordinate): string {
  const normalized: Record<string, string> = {
    panel: coordinate.panel,
    profileId: coordinate.profileId,
  }
  if (coordinate.nodeId !== undefined && coordinate.nodeId !== '') normalized.nodeId = coordinate.nodeId
  if (coordinate.cwd !== undefined && coordinate.cwd !== '') normalized.cwd = coordinate.cwd
  return JSON.stringify(normalized)
}

export function getStandbyDraft(key: string): StandbyDraftState {
  return drafts.get(key) ?? EMPTY_STANDBY_DRAFT
}

/** Update a draft (created from the empty record when absent). */
export function updateStandbyDraft(key: string, patch: Partial<StandbyDraftState>): StandbyDraftState {
  const next: StandbyDraftState = { ...getStandbyDraft(key), ...patch }
  drafts.set(key, next)
  notifyListeners()
  return next
}

const FORBIDDEN_META_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Update or delete one entry in a standby draft's `inputMeta` map (isolated per draftKey; does not mark draft dirty). */
export function setStandbyDraftInputMeta(key: string, metaKey: string, value: unknown): void {
  if (metaKey === '' || FORBIDDEN_META_KEYS.has(metaKey)) return
  const current = getStandbyDraft(key)
  const next: Record<string, unknown> = current.inputMeta !== undefined ? { ...current.inputMeta } : {}
  if (value === undefined) {
    if (!Object.hasOwn(next, metaKey)) return
    delete next[metaKey]
  } else {
    next[metaKey] = value
  }
  updateStandbyDraft(key, {
    inputMeta: Object.keys(next).length > 0 ? next : undefined,
  })
}

/** Update only while the record still exists (after a fully successful send
 * clears the draft, the trailing sending reset must not revive an empty
 * record). */
export function patchStandbyDraftIfPresent(key: string, patch: Partial<StandbyDraftState>): void {
  if (!drafts.has(key)) return
  const current = drafts.get(key)!
  drafts.set(key, { ...current, ...patch })
  notifyListeners()
}

/** Clear the draft after the whole first-send chain succeeds (text lives in
 * memory only; no cross-refresh restore needed). */
export function clearStandbyDraft(key: string): void {
  if (!drafts.delete(key)) return
  notifyListeners()
}

/** Clear all standby drafts and bump the epoch (logout release / test
 * isolation): every in-flight task response is voided. */
export function resetStandbyDrafts(): void {
  draftEpoch++
  drafts.clear()
  clearStandbyFocusRequest()
  notifyListeners()
}

/** Current draft epoch (for in-flight task snapshot comparison). */
export function currentStandbyDraftEpoch(): number {
  return draftEpoch
}

/** On "restore defaults", reset the environment fields; when the target
 * coordinate already holds a draft it is not overwritten (returning false lets
 * the caller report explicitly). */
export function resetEnvStandbyDraft(from: string, to: string): boolean {
  if (!drafts.has(from)) return false
  if (from !== to && drafts.has(to)) return false
  const record = drafts.get(from)!
  drafts.set(to, { ...record, envCustomized: false, envNodeId: undefined, envCwd: undefined })
  if (from !== to) drafts.delete(from)
  notifyListeners()
  return true
}

export type StandbyDraftTransferResult = 'none' | 'moved' | 'target-occupied'

/**
 * Non-destructively migrate unsent standby draft content (`text`, `localFiles`,
 * `inputMeta`) when switching profiles in the same panel. Locked (`sending` or
 * conversation-anchored) sources are never moved; occupied targets are never
 * overwritten; profile-bound settings (`model`, `thinkingLevel`, environment,
 * `uploaded`, `conversationId`, `error`) never leak across profiles.
 */
export function transferStandbyDraftOnProfileSwitch(
  fromKey: string,
  toKey: string,
): StandbyDraftTransferResult {
  if (fromKey === toKey) return 'none'
  const from = drafts.get(fromKey)
  if (from === undefined) return 'none'
  if (from.sending || from.conversationId !== undefined) return 'none'
  const hasTransferableMeta = from.inputMeta !== undefined && Object.keys(from.inputMeta).length > 0
  if (from.text.trim() === '' && from.localFiles.length === 0 && !hasTransferableMeta) {
    return 'none'
  }
  const target = drafts.get(toKey)
  if (
    target !== undefined &&
    (target.text.trim() !== '' ||
      target.localFiles.length > 0 ||
      target.uploaded.length > 0 ||
      target.sending ||
      target.conversationId !== undefined)
  ) {
    return 'target-occupied'
  }
  drafts.set(toKey, {
    ...EMPTY_STANDBY_DRAFT,
    text: from.text,
    localFiles: from.localFiles,
    inputMeta: hasTransferableMeta ? from.inputMeta : undefined,
  })
  drafts.delete(fromKey)
  notifyListeners()
  return 'moved'
}

const COARSE_TOUCH_MEDIA_QUERY = '(hover: none) and (pointer: coarse)'

/** Whether the viewport is a coarse-pointer, no-hover touch device. */
export function isCoarseTouchViewport(
  matchMediaFn?: (query: string) => { matches: boolean },
): boolean {
  const mm =
    matchMediaFn ??
    (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? (query: string) => window.matchMedia(query)
      : undefined)
  if (mm === undefined) return false
  try {
    return mm(COARSE_TOUCH_MEDIA_QUERY).matches === true
  } catch {
    return false
  }
}

export interface StandbyAutoFocusInput {
  panel: 'primary' | 'split'
  focusedPanel: FocusedPanel
  splitTarget: ResolvedTarget | null
  activeModal: ActiveModal
  drawerStackLength: number
  isMobile: boolean
  /** True only when triggered by an explicit user action (e.g. clicking New Topic); allows mobile focus inside user gesture. */
  explicitFocus?: boolean
  textarea?: Element | null
  paneEl?: Element | null
  /** Optional overrides for pure unit tests (default to live browser globals). */
  hasOpenDialog?: boolean
  activeElement?: Element | null
  matchMedia?: (query: string) => { matches: boolean }
}

function isEditableFocusTarget(el: Element | null): boolean {
  if (el === null) return false
  if (isTextInputElement(el)) return true
  const attr = typeof el.getAttribute === 'function' ? el.getAttribute('contenteditable') : null
  if (attr !== null) {
    return attr.trim().toLowerCase() !== 'false'
  }
  if ((el as Partial<HTMLElement>).isContentEditable === true) return true
  if (typeof el.closest === 'function') {
    const host = el.closest('[contenteditable]')
    if (host !== null) {
      const hostAttr = host.getAttribute('contenteditable')
      if (hostAttr !== null && hostAttr.trim().toLowerCase() !== 'false') return true
    }
  }
  return false
}

/**
 * Four-guard auto-focus gate for the standby composer textarea:
 * 1. Panel matches the resolved focused panel (never steal focus across split panes,
 *    where App.tsx's onFocusCapture would flip focusedPanel);
 * 2. No modal, drawer stack frame, or DOM dialog/alertdialog is open;
 * 3. On mobile / coarse-only touch viewports, skip passive mount auto-focus
 *    (so cold loads / Back-Forward never pop the keyboard), while allowing
 *    explicit user-initiated New Topic gestures (`explicitFocus: true`);
 * 4. Only block for another visible editable control when it belongs to THIS
 *    standby pane (e.g. its cwd input) or to the OPPOSITE visible split panel.
 *    Hidden `<Activity mode="hidden">` textareas or external search inputs must
 *    not block focusing a newly opened standby composer.
 */
export function shouldAutoFocusStandbyTextarea(input: StandbyAutoFocusInput): boolean {
  if (input.panel !== resolveFocusedPanel(input.focusedPanel, input.splitTarget)) {
    return false
  }
  if (input.activeModal !== null || input.drawerStackLength > 0) {
    return false
  }
  const dialogOpen = input.hasOpenDialog !== undefined ? input.hasOpenDialog : hasDialogOpen()
  if (dialogOpen) {
    return false
  }
  if (!input.explicitFocus && (input.isMobile || isCoarseTouchViewport(input.matchMedia))) {
    return false
  }
  const activeEl =
    input.activeElement !== undefined
      ? input.activeElement
      : typeof document !== 'undefined'
        ? document.activeElement
        : null
  if (
    activeEl !== null &&
    activeEl !== input.textarea &&
    isElementVisibleInDocument(activeEl) &&
    isEditableFocusTarget(activeEl)
  ) {
    if (input.paneEl !== undefined && input.paneEl !== null && input.paneEl.contains(activeEl)) {
      return false
    }
    if (input.splitTarget !== null && typeof activeEl.closest === 'function') {
      const activePanel = activeEl.closest('[data-helmx-panel]')?.getAttribute('data-helmx-panel')
      if ((activePanel === 'primary' || activePanel === 'split') && activePanel !== input.panel) {
        return false
      }
    }
  }
  return true
}

/** React binding: draft record identity is stable (wholly replaced per
 * update), for useSyncExternalStore consumption. */
export function useStandbyDraft(key: string): StandbyDraftState {
  return useSyncExternalStore(subscribeStandbyDrafts, () => getStandbyDraft(key), () => EMPTY_STANDBY_DRAFT)
}

// ---------------------------------------------------------------------------
// Pure functions: environment draft, attachments and create input
// ---------------------------------------------------------------------------

/** Environment inherited from an agent target (delete-navigation / new-topic
 * inheritance); absent values stay undefined for the server to resolve. */
export function inheritedEnvOf(target: { nodeId?: string; cwd?: string }): { nodeId?: string; cwd?: string } {
  return {
    ...(target.nodeId !== undefined && target.nodeId !== '' ? { nodeId: target.nodeId } : {}),
    ...(target.cwd !== undefined && target.cwd !== '' ? { cwd: target.cwd } : {}),
  }
}

/** Disposition of conversation-management commands hit on the standby pane:
 * /new clears the draft; /clear and /compact require an existing conversation
 * and are never sent as plain input. */
export type StandbyManageAction =
  | { kind: 'clear-draft' }
  | { kind: 'needs-conversation'; command: string }
  | null

export function standbyManageAction(payload: string): StandbyManageAction {
  const cmd = payload.trim()
  if (cmd === '/new') return { kind: 'clear-draft' }
  if (cmd === '/clear' || parseCompactSlashCommand(cmd) !== null) {
    return { kind: 'needs-conversation', command: cmd === '/clear' ? '/clear' : '/compact' }
  }
  return null
}

/**
 * Resolve the standby pane's effective model: explicit draft override >
 * Profile binding > global default model. All empty -> undefined (the button
 * shows "Default model"; the submitted create carries no model field).
 */
export function resolveStandbyEffectiveModel(
  draftModel: string | undefined,
  profileModel: string | undefined,
  globalDefaultModel: string | undefined,
): string | undefined {
  if (draftModel !== undefined && draftModel !== '') return draftModel
  if (profileModel !== undefined && profileModel !== '') return profileModel
  if (globalDefaultModel !== undefined && globalDefaultModel !== '') return globalDefaultModel
  return undefined
}

/**
 * Resolve the standby pane's effective thinking level: explicit draft
 * override > per-model default for the effective model > Profile binding >
 * global default level, converged into the current model's supported list
 * (falling back to off or the first supported level when unsupported).
 */
export function resolveStandbyThinkingLevel(
  levels: ReadonlyArray<string>,
  draftLevel: string | undefined,
  perModelDefaultLevel: string | undefined,
  profileLevel: string | undefined,
  globalDefaultLevel: string | undefined,
): string {
  const raw =
    draftLevel !== undefined && draftLevel !== ''
      ? draftLevel
      : perModelDefaultLevel !== undefined && perModelDefaultLevel !== ''
        ? perModelDefaultLevel
        : profileLevel !== undefined && profileLevel !== ''
          ? profileLevel
          : globalDefaultLevel !== undefined && globalDefaultLevel !== ''
            ? globalDefaultLevel
            : ''
  return resolveEffectiveThinkingLevel(levels, raw)
}

/** Post-customization validation (reuses the conversation environment bar's
 * rule: the directory is required and must be an absolute path). Always passes
 * while not customized. */
export function standbyEnvError(draft: Pick<StandbyDraftState, 'envCustomized' | 'envNodeId' | 'envCwd'>, t: WebMessageTranslator): string | null {
  if (!draft.envCustomized) return null
  return envDraftError({ nodeId: draft.envNodeId || 'local', cwd: draft.envCwd ?? '' } satisfies EnvDraft, t)
}

/** Local attachment admission (real Blob/File boundary validation + 15 MiB
 * cap; returns rejected items with user-readable reasons). */
export function admitStandbyFiles(
  draft: Pick<StandbyDraftState, 'localFiles'>,
  files: ReadonlyArray<File>,
  t: WebMessageTranslator,
): { draft: Pick<StandbyDraftState, 'localFiles'>; accepted: File[]; rejected: Array<{ file: File; reason: string }> } {
  const next = [...draft.localFiles]
  const accepted: File[] = []
  const rejected: Array<{ file: File; reason: string }> = []
  for (const file of files) {
    if (!isReadableFileLike(file)) {
      rejected.push({ file, reason: t('composer.attach.unsupportedSource') })
      continue
    }
    if (file.size > STANDBY_FILE_MAX_BYTES) {
      rejected.push({ file, reason: t('composer.attach.tooLarge') })
      continue
    }
    next.push({
      key: `standby-file-${++localFileSeq}`,
      file,
      name: file.name || 'attachment.bin',
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
    })
    accepted.push(file)
  }
  return { draft: { localFiles: next }, accepted, rejected }
}

/** Assemble the create input: the environment rides along only when
 * explicitly customized; the model only when explicitly selected (defaults
 * are resolved by the server). */
export function buildStandbyCreateInit(
  profileId: string,
  draft: Pick<StandbyDraftState, 'envCustomized' | 'envNodeId' | 'envCwd' | 'model'>,
): ConversationInit {
  return {
    profileId,
    ...(draft.envCustomized
      ? { nodeId: draft.envNodeId || 'local', cwd: (draft.envCwd ?? '').trim() }
      : {}),
    ...(draft.model !== undefined && draft.model !== '' ? { model: draft.model } : {}),
  }
}

// ---------------------------------------------------------------------------
// First-send pipeline (dependency-injected; the UI layer passes real APIs and
// navigation callbacks)
// ---------------------------------------------------------------------------

export interface StandbySendDeps {
  create: (init: ConversationInit) => Promise<ConversationSummary>
  patchThinkingLevel: (conversationId: number, thinkingLevel: string) => Promise<unknown>
  upload: (conversationId: number, file: File) => Promise<ArtifactMetadata>
  submit: (
    conversationId: number,
    payload: {
      text: string
      origin: 'human'
      model?: string
      thinkingLevel?: string
      meta?: Record<string, unknown>
      attachments?: string[]
    },
  ) => Promise<unknown>
  notifyError: (title: string, err: unknown, conversationId?: number) => void
  /** When the whole chain succeeded but the standby target is no longer in
   * view, guide the user back to the new conversation with a clickable
   * notice. */
  notifySentInBackground: (conversationId: number) => void
  /** When the whole chain succeeded while the standby target is still in
   * view, navigate (replace) to the real conversation. */
  navigateToConversation: (conversationId: number) => void
  isStillViewing: () => boolean
}

export type StandbySendResult = 'sent' | 'invalid' | 'busy' | 'failed' | 'stale'

/**
 * Execute the first send. Checks and claims the sending flag synchronously
 * (a second double-click/Enter returns busy immediately), then advances
 * create -> patch -> upload -> submit; any failure keeps the draft, the
 * created conversation id and the uploaded attachments and returns failed for
 * the user to retry explicitly (reusing the anchor).
 */
export async function executeStandbySend(
  key: string,
  profileId: string,
  deps: StandbySendDeps,
  t: WebMessageTranslator,
): Promise<StandbySendResult> {
  const record = getStandbyDraft(key)
  const payload = record.text.trim()
  if (payload === '') return 'invalid'
  if (record.sending) return 'busy'
  const envError = standbyEnvError(record, t)
  if (envError !== null) {
    deps.notifyError(t('composer.standby.fixEnvFirst'), envError)
    return 'invalid'
  }
  // Claim synchronously: later double-clicks/Enter are rejected before any await.
  updateStandbyDraft(key, { sending: true, error: null })
  // Epoch snapshot: after logout/full reset, no old-task response may touch
  // storage or send anything outward again.
  const epoch = currentStandbyDraftEpoch()
  const stale = (): boolean => epoch !== currentStandbyDraftEpoch()
  let conversationId = record.conversationId
  try {
    if (conversationId === undefined) {
      const created = await deps.create(buildStandbyCreateInit(profileId, record))
      if (stale()) return 'stale'
      conversationId = created.id
      // Persist the anchor immediately: on any later failure, retry skips create.
      updateStandbyDraft(key, { conversationId })
    }
    if (record.thinkingLevel !== undefined && record.thinkingLevel !== '') {
      await deps.patchThinkingLevel(conversationId, record.thinkingLevel)
      if (stale()) return 'stale'
    }
    for (const local of record.localFiles) {
      const meta = await deps.upload(conversationId, local.file)
      if (stale()) return 'stale'
      // Uploaded counts as final: failed retries never re-upload the file.
      const current = getStandbyDraft(key)
      updateStandbyDraft(key, {
        localFiles: current.localFiles.filter((item) => item.key !== local.key),
        uploaded: [...current.uploaded, { artifactId: meta.id, name: meta.name, size: meta.size, mimeType: meta.mimeType }],
      })
    }
    const latestDraft = getStandbyDraft(key)
    const attachments = latestDraft.uploaded.map((item) => item.artifactId)
    const liveMeta = latestDraft.inputMeta
    const nextTurnModel = latestDraft.nextTurnModel?.trim()
    const nextTurnThinkingLevel = latestDraft.nextTurnThinkingLevel?.trim()
    await deps.submit(conversationId, {
      text: payload,
      origin: 'human',
      ...(nextTurnModel !== undefined && nextTurnModel !== '' ? { model: nextTurnModel } : {}),
      ...(nextTurnThinkingLevel !== undefined && nextTurnThinkingLevel !== ''
        ? { thinkingLevel: nextTurnThinkingLevel }
        : {}),
      ...(liveMeta !== undefined && Object.keys(liveMeta).length > 0 ? { meta: { ...liveMeta } } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    if (stale()) return 'stale'
    clearStandbyDraft(key)
    if (deps.isStillViewing()) deps.navigateToConversation(conversationId)
    else deps.notifySentInBackground(conversationId)
    return 'sent'
  } catch (err) {
    if (stale()) return 'stale'
    patchStandbyDraftIfPresent(key, { error: err instanceof Error ? err.message : String(err) })
    deps.notifyError(
      conversationId !== undefined ? t('composer.standby.sendFailedRetryTitle') : t('composer.standby.createFailedTitle'),
      err,
      conversationId,
    )
    return 'failed'
  } finally {
    // Never reset when the epoch changed: the new epoch may already hold a new
    // draft under the same key; the old task's cleanup must not overwrite its
    // sending state.
    if (!stale()) patchStandbyDraftIfPresent(key, { sending: false })
  }
}

// ---------------------------------------------------------------------------
// Standby profile picker pure helpers (search threshold, options, meta, keys)
// ---------------------------------------------------------------------------

/** Show search bar in StandbyProfilePicker once selectable candidates exceed this count (6+). */
export const STANDBY_PROFILE_SEARCH_THRESHOLD = 5

export interface StandbyProfileOption {
  profileId: string
  label: string
  remoteNodeId: string | null
  cwd?: string
  boundModel?: string
  boundModelShort?: string
  tags: ReadonlyArray<string>
}

export function formatStandbyBoundModelShort(model: string | undefined): string | undefined {
  if (model === undefined) return undefined
  const trimmed = model.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('tier/') && trimmed.length > 5) {
    return trimmed
  }
  const slashIdx = trimmed.lastIndexOf('/')
  if (slashIdx >= 0 && slashIdx < trimmed.length - 1) {
    return trimmed.slice(slashIdx + 1)
  }
  return trimmed
}

export function buildStandbyProfileOptions(
  candidates: ReadonlyArray<{
    profileId: string
    label: string
    primaryConversation: { nodeId?: string } | null
  }>,
  profiles: ReadonlyArray<Profile>,
): StandbyProfileOption[] {
  const profileById = new Map(profiles.map((p) => [p.id, p] as const))
  return candidates.map((candidate) => {
    const profile = profileById.get(candidate.profileId)
    const rawNodeId =
      profile?.nodeId !== undefined && profile.nodeId !== '' && profile.nodeId !== 'local'
        ? profile.nodeId
        : candidate.primaryConversation?.nodeId
    const remoteNodeId =
      rawNodeId !== undefined && rawNodeId !== '' && rawNodeId !== 'local' ? rawNodeId : null
    const cwd = profile?.cwd?.trim() || undefined
    const boundModel = profile?.model?.trim() || undefined
    const boundModelShort = formatStandbyBoundModelShort(boundModel)
    return {
      profileId: candidate.profileId,
      label: candidate.label,
      remoteNodeId,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(boundModel !== undefined ? { boundModel } : {}),
      ...(boundModelShort !== undefined ? { boundModelShort } : {}),
      tags: profile?.tags ?? [],
    }
  })
}

export function filterStandbyProfileOptions(
  options: ReadonlyArray<StandbyProfileOption>,
  query: string,
): StandbyProfileOption[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...options]
  return options.filter(
    (opt) =>
      opt.label.toLowerCase().includes(q) ||
      opt.profileId.toLowerCase().includes(q) ||
      (opt.remoteNodeId !== null && opt.remoteNodeId.toLowerCase().includes(q)) ||
      (opt.cwd !== undefined && opt.cwd.toLowerCase().includes(q)) ||
      (opt.boundModel !== undefined && opt.boundModel.toLowerCase().includes(q)) ||
      (opt.boundModelShort !== undefined && opt.boundModelShort.toLowerCase().includes(q)) ||
      opt.tags.some((tag) => tag.toLowerCase().includes(q)),
  )
}

export function formatStandbyProfileMeta(
  option: Pick<StandbyProfileOption, 'profileId' | 'label' | 'cwd' | 'boundModelShort'>,
): string {
  const parts: string[] = []
  if (option.label.trim().toLowerCase() !== option.profileId.trim().toLowerCase()) {
    parts.push(option.profileId)
  }
  if (option.cwd !== undefined && option.cwd !== '') {
    parts.push(option.cwd)
  }
  if (option.boundModelShort !== undefined && option.boundModelShort !== '') {
    parts.push(option.boundModelShort)
  }
  return parts.join(' · ')
}

export function stepStandbyProfileIndex(current: number, length: number, delta: 1 | -1): number {
  if (length <= 0) return -1
  if (current < 0 || current >= length) return delta > 0 ? 0 : length - 1
  return (current + delta + length) % length
}

export function initialStandbyProfileActiveIndex(
  options: ReadonlyArray<Pick<StandbyProfileOption, 'profileId'>>,
  currentProfileId: string,
  query: string,
): number {
  if (options.length === 0) return -1
  if (query.trim() !== '') return 0
  const idx = options.findIndex((opt) => opt.profileId === currentProfileId)
  return idx >= 0 ? idx : 0
}
