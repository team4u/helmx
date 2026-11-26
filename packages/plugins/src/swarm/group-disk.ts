/**
 * builtin:swarm WAL persistence and disk recovery helpers (`meta.json` + `board.jsonl`).
 */
import { mkdir, open, readFile, stat, truncate } from 'node:fs/promises'
import type { HelmxPluginContext } from '@helmx/protocol'
import { errorMessageOf } from '../shared-helpers.js'
import {
  assertCollabGroupRecord,
  assertGroupId,
  groupNotFoundError,
  isEnoent,
  swarmError,
  type BoardPost,
  type CollabGroupRecord,
} from './contracts.js'
import { inspectBoardWalLines } from './recovery.js'

export interface SwarmDiskPorts {
  readonly ctx: HelmxPluginContext
  readonly groupDirOf: (groupId: string) => string
  readonly metaPathOf: (groupId: string) => string
  readonly boardPathOf: (groupId: string) => string
  readonly runGroupLocked: <T>(groupId: string, fn: () => Promise<T>) => Promise<T>
  readonly persistMeta: (record: CollabGroupRecord) => Promise<CollabGroupRecord>
  readonly logDiagnostic: (message: string) => void
}

/**
 * Read `board.jsonl`, validate against `expectedHeadSeq`, and atomically truncate any uncommitted
 * WAL tail entry left behind by a partial crash.
 */
export async function readAndHealBoardPostsLocked(
  ports: Pick<SwarmDiskPorts, 'ctx' | 'boardPathOf' | 'logDiagnostic'>,
  groupId: string,
  expectedHeadSeq: number,
): Promise<BoardPost[]> {
  let rawBoard = ''
  try {
    rawBoard = await readFile(ports.boardPathOf(groupId), 'utf8')
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  const wal = inspectBoardWalLines(rawBoard, groupId, expectedHeadSeq)
  if (wal.trimmed) {
    ports.logDiagnostic(
      `协作组 '${groupId}' 检测到未提交的 board.jsonl 尾行（${wal.trimReason}），已按 meta.headSeq=${expectedHeadSeq} 回滚截断`,
    )
    await ports.ctx.host.atomicWriteFile(
      ports.boardPathOf(groupId),
      wal.posts.length > 0 ? `${wal.posts.map((p) => JSON.stringify(p)).join('\n')}\n` : '',
    )
  }
  return wal.posts
}

/**
 * WAL write order: append + datasync `board.jsonl` BEFORE committing `meta.json`,
 * truncating `board.jsonl` back to `priorByteLength` if metadata commit fails.
 */
export async function appendPostAndPersistMetaLocked(
  ports: Pick<SwarmDiskPorts, 'groupDirOf' | 'boardPathOf' | 'persistMeta' | 'logDiagnostic'>,
  groupId: string,
  post: BoardPost,
  next: CollabGroupRecord,
): Promise<CollabGroupRecord> {
  await mkdir(ports.groupDirOf(groupId), { recursive: true })
  const boardPath = ports.boardPathOf(groupId)
  let priorByteLength = 0
  try {
    priorByteLength = (await stat(boardPath)).size
  } catch (err) {
    if (!isEnoent(err)) throw err
  }
  const handle = await open(boardPath, 'a')
  try {
    await handle.writeFile(`${JSON.stringify(post)}\n`, 'utf8')
    await handle.datasync()
  } catch (writeErr) {
    await handle.truncate(priorByteLength).catch(() => {})
    throw writeErr
  } finally {
    await handle.close()
  }
  try {
    return await ports.persistMeta(next)
  } catch (metaErr) {
    await truncate(boardPath, priorByteLength).catch((truncErr) => {
      ports.logDiagnostic(`回滚截断协作组 '${groupId}' board.jsonl 失败：${errorMessageOf(truncErr)}`)
    })
    throw metaErr
  }
}

/** Load and validate one persisted swarm group (`meta.json` + active WAL recovery) under its group lock. */
export function loadGroupFromDisk(
  ports: SwarmDiskPorts & { readonly isCoordinatorMissing: (conversationId: number) => boolean },
  groupId: string,
): Promise<{ record: CollabGroupRecord; posts: BoardPost[] | undefined }> {
  return ports.runGroupLocked(groupId, async () => {
    let rawMetaText: string
    try {
      rawMetaText = await readFile(ports.metaPathOf(groupId), 'utf8')
    } catch (err) {
      throw swarmError('swarm_doc_corrupt', `协作组 '${groupId}' 缺少或无法读取 meta.json：${errorMessageOf(err)}`, 500, {
        groupId,
      })
    }
    let parsedMeta: unknown
    try {
      parsedMeta = JSON.parse(rawMetaText)
    } catch (err) {
      throw swarmError(
        'swarm_doc_corrupt',
        `协作组 '${groupId}' meta.json JSON 解析失败：${errorMessageOf(err)}`,
        500,
        { groupId },
      )
    }
    let record = assertCollabGroupRecord(parsedMeta)
    if (record.id !== groupId) {
      throw swarmError('swarm_doc_corrupt', `协作组目录 '${groupId}' 与 meta.json.id '${record.id}' 不一致`, 500, {
        groupId,
      })
    }

    let posts: BoardPost[] | undefined
    if (record.status === 'active') {
      posts = await readAndHealBoardPostsLocked(ports, groupId, record.headSeq)
      if (!record.coordinatorDetached && ports.isCoordinatorMissing(record.coordinatorConversationId)) {
        record = await ports.persistMeta({ ...record, coordinatorDetached: true, updatedAt: Date.now() })
      }
    }
    return { record, posts }
  })
}

/** Ensure posts for a group are loaded (serving cached active posts or loading from `board.jsonl` on demand). */
export async function ensureGroupPostsLoaded(
  ports: Pick<SwarmDiskPorts, 'ctx' | 'boardPathOf' | 'runGroupLocked' | 'logDiagnostic'> & {
    readonly getGroup: (groupId: string) => CollabGroupRecord | undefined
    readonly getPosts: (groupId: string) => readonly BoardPost[] | undefined
    readonly setPostsCache: (groupId: string, posts: BoardPost[]) => void
  },
  groupId: string,
): Promise<readonly BoardPost[]> {
  const validId = assertGroupId(groupId)
  const cached = ports.getPosts(validId)
  if (cached !== undefined) return cached
  return ports.runGroupLocked(validId, async () => {
    const again = ports.getPosts(validId)
    if (again !== undefined) return again
    const current = ports.getGroup(validId)
    if (!current) throw groupNotFoundError(validId)
    const parsed = await readAndHealBoardPostsLocked(ports, validId, current.headSeq)
    if (current.status === 'active') ports.setPostsCache(validId, parsed)
    return parsed
  })
}
