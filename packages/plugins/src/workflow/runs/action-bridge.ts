/**
 * runs/action-bridge.ts — Action ID resolution, visibility enforcement, and built-in `env.exec` adapter.
 */
import {
  HelmxError,
  isAbsoluteTargetPath,
  isCoreNamespace,
  isValidNodeId,
  type EnvExecResponse,
} from '@helmx/protocol'
import type { ActiveRun, WorkflowServiceHost } from './types.js'

export const BUILTIN_ENV_EXEC_PLUGIN = 'env'
export const BUILTIN_ENV_EXEC_ACTION = 'exec'

export interface ValidatedEnvExecInput {
  command: string | string[]
  nodeId?: string
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  allowFailure?: boolean
}

export function resolveActionId(
  host: WorkflowServiceHost,
  qualified: string,
): { pluginId: string; actionId: string; builtin?: 'env.exec' } {
  if (qualified === `${BUILTIN_ENV_EXEC_PLUGIN}.${BUILTIN_ENV_EXEC_ACTION}`) {
    return { pluginId: BUILTIN_ENV_EXEC_PLUGIN, actionId: BUILTIN_ENV_EXEC_ACTION, builtin: 'env.exec' }
  }
  const manifests = host.listActions()
  // Kernel `core:*` actions must always be addressed by fully-qualified ID (`core:<domain>.<action>`);
  // exclude them from bare short-name resolution so they never shadow plugin actions or trigger false ambiguity.
  const pluginManifests = manifests.filter((m) => !isCoreNamespace(m.pluginId))
  if (qualified === BUILTIN_ENV_EXEC_ACTION) {
    const sameShort = pluginManifests.filter((m) => m.id === BUILTIN_ENV_EXEC_ACTION && (m.visibility ?? 'public') === 'public')
    if (sameShort.length === 0) {
      return { pluginId: BUILTIN_ENV_EXEC_PLUGIN, actionId: BUILTIN_ENV_EXEC_ACTION, builtin: 'env.exec' }
    }
    throw new HelmxError(
      'ambiguous_action',
      `动作短 id "${qualified}" 命中多个动作（含内建 env.exec），请用全限定 id：env.exec, ${sameShort.map((m) => `${m.pluginId}.${m.id}`).join(', ')}`,
      400,
      { qualified },
    )
  }
  for (const manifest of manifests) {
    if (`${manifest.pluginId}.${manifest.id}` === qualified) {
      if (manifest.visibility === 'ui' || manifest.visibility === 'internal') {
        throw new HelmxError(
          'action_visibility_forbidden',
          `动作 "${qualified}" 可见性为 '${manifest.visibility}'，禁止在工作流脚本中调用`,
          403,
          { pluginId: manifest.pluginId, actionId: manifest.id, visibility: manifest.visibility },
        )
      }
      return { pluginId: manifest.pluginId, actionId: manifest.id }
    }
  }
  const sameShort = pluginManifests.filter((m) => m.id === qualified)
  const publicShort = sameShort.filter((m) => (m.visibility ?? 'public') === 'public')
  if (publicShort.length === 1) return { pluginId: publicShort[0]!.pluginId, actionId: publicShort[0]!.id }
  if (publicShort.length > 1) {
    throw new HelmxError(
      'ambiguous_action',
      `动作短 id "${qualified}" 命中多个插件，请用全限定 id：${publicShort.map((m) => `${m.pluginId}.${m.id}`).join(', ')}`,
      400,
      { qualified },
    )
  }
  if (sameShort.length > 0) {
    const blocked = sameShort[0]!
    throw new HelmxError(
      'action_visibility_forbidden',
      `动作 "${blocked.pluginId}.${blocked.id}" 可见性为 '${blocked.visibility}'，禁止在工作流脚本中调用`,
      403,
      { pluginId: blocked.pluginId, actionId: blocked.id, visibility: blocked.visibility },
    )
  }
  const coreShort = manifests.filter(
    (m) => isCoreNamespace(m.pluginId) && m.id === qualified && (m.visibility ?? 'public') === 'public',
  )
  if (coreShort.length > 0) {
    const coreCandidates = coreShort.map((m) => `${m.pluginId}.${m.id}`)
    throw new HelmxError(
      'unknown_action',
      `未注册的插件动作短 id "${qualified}"（core:* 核心动作不支持短名解析，请使用全限定 id：${coreCandidates.join(', ')}）`,
      404,
      { qualified, coreCandidates },
    )
  }
  throw new HelmxError('unknown_action', `未注册的动作：${qualified}`, 404, { qualified })
}

const ENV_EXEC_KEYS = new Set(['command', 'nodeId', 'cwd', 'env', 'timeoutMs', 'allowFailure'])

export function validateEnvExecInput(host: WorkflowServiceHost, input: unknown): ValidatedEnvExecInput {
  if (host.execEnv === undefined) {
    throw new HelmxError('not_supported', '当前工作流宿主未配置 env.exec 命令执行端口', 501)
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new HelmxError('validation_error', 'env.exec 入参必须是 JSON 对象', 400)
  }
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!ENV_EXEC_KEYS.has(key)) throw new HelmxError('validation_error', `env.exec 发现未知选项 "${key}"`, 400)
  }

  let command: string | string[]
  if (typeof raw['command'] === 'string') {
    if (raw['command'].trim().length === 0) throw new HelmxError('validation_error', 'env.exec command 不能为空字符串', 400)
    command = raw['command']
  } else if (Array.isArray(raw['command'])) {
    if (
      raw['command'].length === 0 ||
      !raw['command'].every((i) => typeof i === 'string') ||
      (raw['command'][0] as string).trim().length === 0
    ) {
      throw new HelmxError('validation_error', 'env.exec command 数组必须非空且首项为非空字符串', 400)
    }
    command = raw['command'] as string[]
  } else {
    throw new HelmxError('validation_error', 'env.exec command 必须是非空字符串或非空字符串数组', 400)
  }

  if (raw['nodeId'] !== undefined && !isValidNodeId(raw['nodeId'])) {
    throw new HelmxError('validation_error', 'env.exec nodeId 需匹配 /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/', 400)
  }
  if (
    raw['cwd'] !== undefined &&
    (typeof raw['cwd'] !== 'string' || raw['cwd'].trim().length === 0 || !isAbsoluteTargetPath(raw['cwd']))
  ) {
    throw new HelmxError('validation_error', 'env.exec cwd 必须为跨平台绝对路径（POSIX/Windows/UNC）', 400)
  }
  if (raw['env'] !== undefined) {
    if (typeof raw['env'] !== 'object' || raw['env'] === null || Array.isArray(raw['env'])) {
      throw new HelmxError('validation_error', 'env.exec env 必须是键值对象', 400)
    }
    for (const [k, v] of Object.entries(raw['env'] as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new HelmxError('validation_error', `env.exec env.${k} 必须为字符串`, 400)
    }
  }
  if (
    raw['timeoutMs'] !== undefined &&
    (typeof raw['timeoutMs'] !== 'number' || !Number.isInteger(raw['timeoutMs']) || raw['timeoutMs'] < 1 || raw['timeoutMs'] > 600_000)
  ) {
    throw new HelmxError('validation_error', 'env.exec timeoutMs 必须是 1 到 600000 之间的整数', 400)
  }
  if (raw['allowFailure'] !== undefined && typeof raw['allowFailure'] !== 'boolean') {
    throw new HelmxError('validation_error', 'env.exec allowFailure 必须为 boolean', 400)
  }

  return {
    command,
    nodeId: raw['nodeId'] as string | undefined,
    cwd: raw['cwd'] as string | undefined,
    env: raw['env'] as Record<string, string> | undefined,
    timeoutMs: raw['timeoutMs'] as number | undefined,
    allowFailure: raw['allowFailure'] as boolean | undefined,
  }
}

export async function prepareEngineAction(
  host: WorkflowServiceHost,
  run: ActiveRun,
  actionId: string,
  input: unknown,
): Promise<{ pluginId: string; actionId: string; idempotent?: boolean }> {
  if (host.isHostClosing?.() === true) {
    run.abort.abort()
    throw new HelmxError('aborted', '宿主正在关停，中止动作调用', 409)
  }
  const resolved = resolveActionId(host, actionId)
  if (resolved.builtin === 'env.exec') {
    validateEnvExecInput(host, input)
    return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: false }
  }
  if (host.prepareAction !== undefined) {
    const prep = host.prepareAction(resolved.pluginId, resolved.actionId, input, { conversationId: run.conversationId })
    return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: prep?.idempotent }
  }
  const manifest = host.listActions().find((m) => m.pluginId === resolved.pluginId && m.id === resolved.actionId)
  return { pluginId: resolved.pluginId, actionId: resolved.actionId, idempotent: manifest?.idempotent }
}

export async function invokeEngineAction(
  host: WorkflowServiceHost,
  redact: (text: string) => string,
  run: ActiveRun,
  actionId: string,
  input: unknown,
  context: { index: number; signal?: AbortSignal },
): Promise<{ pluginId: string; actionId: string; result: unknown }> {
  const resolved = resolveActionId(host, actionId)
  if (resolved.builtin === 'env.exec') {
    const parsed = validateEnvExecInput(host, input)
    const execPromise = host.execEnv?.(
      {
        command: parsed.command,
        ...(parsed.nodeId !== undefined ? { nodeId: parsed.nodeId } : {}),
        ...(parsed.cwd !== undefined ? { cwd: parsed.cwd } : {}),
        ...(parsed.env !== undefined ? { env: parsed.env } : {}),
        ...(parsed.timeoutMs !== undefined ? { timeoutMs: parsed.timeoutMs } : {}),
        conversationId: run.conversationId,
      },
      context.signal,
    )
    if (execPromise === undefined) {
      throw new HelmxError('not_supported', '当前工作流宿主未配置 env.exec 命令执行端口', 501)
    }
    run.pendingExecs.add(execPromise)
    let res: EnvExecResponse
    try {
      res = await execPromise
    } finally {
      run.pendingExecs.delete(execPromise)
    }
    const redactedOutput = redact(res.output)
    const succeeded = res.ok && res.exitCode === 0 && !res.timedOut
    if (!succeeded && parsed.allowFailure !== true) {
      const tail = redactedOutput.length > 2000 ? redactedOutput.slice(-2000) : redactedOutput
      throw new HelmxError(
        'env_exec_failed',
        `命令执行失败${res.timedOut ? '（超时）' : ''}（exitCode=${String(res.exitCode)}）${tail ? ': ' + tail : ''}`,
        502,
        { exitCode: res.exitCode, timedOut: res.timedOut },
      )
    }
    return {
      pluginId: 'env',
      actionId: 'exec',
      result: { ok: succeeded, exitCode: res.exitCode, output: redactedOutput, timedOut: res.timedOut },
    }
  }
  const result = await host.invokeAction(resolved.pluginId, resolved.actionId, input, {
    conversationId: run.conversationId,
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  })
  return { pluginId: resolved.pluginId, actionId: resolved.actionId, result }
}
