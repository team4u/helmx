/**
 * Workspace AGENTS.md reader and turn-injection section computation.
 *
 * Honesty & safety discipline:
 * - Missing / directory / dangling-symlink / whitespace-only AGENTS.md is normal absence -> `{ kind: 'none' }`;
 * - Bounded TOCTOU-safe read via `ExecutionEnv` (`canonicalPath` -> `openBinaryReader({ noFollow: true })` ->
 *   size cap -> bounded positional read -> post-read metadata check);
 * - Offline remote nodes, special files, over-cap files, or IO/permission failures explicitly emit
 *   `<project_instructions_unavailable>` instead of silently degrading to absent;
 * - SecretStash redaction runs before character-limit truncation (`MAX_AGENTS_MD_CHARS`).
 */
import { HelmxError, escapeXml, pathRulesForShape, targetPathShape } from '@helmx/protocol'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import { readFileBounded, type BoundedReadFailure } from './bounded-file-reader.js'

/** Workspace project instructions filename (community convention, re-read live per turn). */
export const AGENTS_MD_FILENAME = 'AGENTS.md'

/** Character injection cap for AGENTS.md (explicitly annotated on truncation). */
export const MAX_AGENTS_MD_CHARS = 64_000

/** Pre-read byte limit (bounded guard; covers max chars UTF-8 with margin). */
export const MAX_AGENTS_MD_BYTES = 256 * 1024

const AGENTS_MD_TRUNCATION_NOTE = `\n[ helmx 提示：AGENTS.md 超过 ${MAX_AGENTS_MD_CHARS} 字符上限，以上为前 ${MAX_AGENTS_MD_CHARS} 字符 ]`
const AGENTS_MD_UTF8_DECODER = new TextDecoder('utf-8')

export type AgentsMdInjection =
  | { kind: 'none' }
  | { kind: 'section'; id: 'profile.agents' | 'profile.agents-unavailable'; text: string }

export interface AgentsMdHostPort {
  executionEnv(nodeId: string, cwd: string): ExecutionEnv
  redact(text: string): string
  nodeIpc: { isOnline(nodeId: string): boolean }
}

function errorMessageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errorCodeOf(err: unknown): string {
  return err instanceof HelmxError ? err.code : 'unknown'
}

function unavailableSection(agentsPath: string, nodeId: string, body: string): AgentsMdInjection {
  return {
    kind: 'section',
    id: 'profile.agents-unavailable',
    text: `<project_instructions_unavailable path="${escapeXml(agentsPath)}" node="${escapeXml(nodeId)}">\n${body}\n</project_instructions_unavailable>`,
  }
}

function readFailureBody(
  agentsPath: string,
  code: string,
  message: string,
  redact: (text: string) => string,
): string {
  return `读取工作区 ${escapeXml(agentsPath)} 失败（${escapeXml(code)}）：${escapeXml(redact(message))}`
}

function formatAgentsMdFailure(
  agentsPath: string,
  failure: BoundedReadFailure,
  redact: (text: string) => string,
): string {
  switch (failure.stage) {
    case 'canonical':
      return `解析工作区 ${escapeXml(agentsPath)} 真实路径失败（${escapeXml(failure.code)}）：${escapeXml(redact(failure.message))}`
    case 'outside_dir':
      return `工作区 ${escapeXml(agentsPath)} 解析到目录之外，拒绝读取`
    case 'open':
    case 'info':
    case 'read':
    case 'after_info':
      return readFailureBody(agentsPath, failure.code, failure.message, redact)
    case 'not_regular_file':
      return `工作区 ${escapeXml(agentsPath)} 在打开后不是普通文件（kind=${escapeXml(failure.fileKind)}），拒绝读取`
    case 'size_exceeded':
      return `工作区 ${escapeXml(agentsPath)} 为 ${failure.size} 字节，超过 ${failure.maxBytes} 字节读取上限，本回合未读取正文`
    case 'binary_file':
      return `工作区 ${escapeXml(agentsPath)} 为二进制文件（${failure.size} 字节），本回合不注入正文`
    case 'read_exceeded':
      return `工作区 ${escapeXml(agentsPath)} 读取到 ${failure.bytesRead} 字节，超过 ${failure.maxBytes} 字节读取上限，本回合不注入正文`
    case 'file_changed':
      return `工作区 ${escapeXml(agentsPath)} 读取期间文件发生变化（size ${failure.beforeSize} -> ${failure.afterSize}，mtime ${failure.beforeMtime} -> ${failure.afterMtime}），本回合不注入可能不完整的快照`
    case 'size_mismatch':
      return `工作区 ${escapeXml(agentsPath)} 读取到 ${failure.bytesRead} 字节与稳定大小 ${failure.stableSize} 不一致，本回合不注入可能不完整的快照`
  }
}

/**
 * Read AGENTS.md from the conversation's target workspace `(nodeId ?? 'local', cwd)` and compute
 * its pre-hook turn section. Empty `cwd` skips lookup cleanly.
 */
export async function computeAgentsMdSection(
  host: AgentsMdHostPort,
  nodeIdInput: string | undefined,
  cwd: string,
): Promise<AgentsMdInjection> {
  if (cwd === '') return { kind: 'none' }
  const nodeId = nodeIdInput ?? 'local'
  const agentsPath = pathRulesForShape(targetPathShape(cwd)).join(cwd, AGENTS_MD_FILENAME)
  const redact = (text: string): string => host.redact(text)

  if (nodeId !== 'local') {
    try {
      if (!host.nodeIpc.isOnline(nodeId)) {
        return unavailableSection(
          agentsPath,
          nodeId,
          `目标节点 ${escapeXml(nodeId)} 当前离线，本回合未能读取工作区 ${escapeXml(agentsPath)}。`,
        )
      }
    } catch (err) {
      return unavailableSection(
        agentsPath,
        nodeId,
        `检查目标节点 ${escapeXml(nodeId)} 在线状态失败（${escapeXml(errorCodeOf(err))}）：${escapeXml(redact(errorMessageOf(err)))}`,
      )
    }
  }

  let env: ExecutionEnv
  try {
    env = host.executionEnv(nodeId, cwd)
  } catch (err) {
    return unavailableSection(
      agentsPath,
      nodeId,
      readFailureBody(agentsPath, errorCodeOf(err), errorMessageOf(err), redact),
    )
  }

  try {
    const read = await readFileBounded(env, agentsPath, {
      maxBytes: MAX_AGENTS_MD_BYTES,
      decoder: AGENTS_MD_UTF8_DECODER,
    })
    if (read.kind === 'absent') return { kind: 'none' }
    if (read.kind === 'refused') return unavailableSection(agentsPath, nodeId, formatAgentsMdFailure(agentsPath, read.failure, redact))
    if (read.text.trim() === '') return { kind: 'none' }
    const redacted = host.redact(read.text)
    const content =
      redacted.length > MAX_AGENTS_MD_CHARS
        ? `${redacted.slice(0, MAX_AGENTS_MD_CHARS)}${AGENTS_MD_TRUNCATION_NOTE}`
        : redacted
    return {
      kind: 'section',
      id: 'profile.agents',
      text: `<project_instructions path="${escapeXml(agentsPath)}">\n${content}\n</project_instructions>`,
    }
  } catch (err) {
    return unavailableSection(
      agentsPath,
      nodeId,
      readFailureBody(agentsPath, errorCodeOf(err), errorMessageOf(err), redact),
    )
  }
}
