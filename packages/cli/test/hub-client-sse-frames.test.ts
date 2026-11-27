/**
 * HubClient.streamSse 帧装配的 CR 跨块边界契约（帧解析抽成 SseFrameAssembler 后锁定行为不变）：
 * - 块尾的 `\r` 先挂起，等下一块到来再判定是 `\r\n` 还是孤立 `\r`；仅含 `\r` 的块不追加任何文本；
 * - 流结束时挂起的 `\r` 原样并入尾部；未以空行终止的尾帧按 SSE 语义丢弃，不派发。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HubClient } from '../src/hub-client.js'

type Frame = { event: string; data: string }

function makeIo(fetchImpl: typeof fetch) {
  return { env: {}, out: () => {}, err: () => {}, stdin: { isTTY: false, readAll: async () => '' }, fetchImpl }
}

/** Hub SSE response whose body arrives as the given text chunks (one stream read per chunk). */
function sseClient(chunks: Uint8Array[]): HubClient {
  return new HubClient(
    { baseUrl: 'http://127.0.0.1:3202', token: 'tok' },
    makeIo((async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk)
            controller.close()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )) as typeof fetch),
    5_000,
  )
}

async function collect(chunks: string[]): Promise<Frame[]> {
  const encoder = new TextEncoder()
  const frames: Frame[] = []
  await sseClient(chunks.map((chunk) => encoder.encode(chunk))).streamSse('/api/events', {
    onFrame: (frame) => frames.push(frame),
  })
  return frames
}

test('streamSse holds a chunk-trailing CR until the next chunk: CRLF split anywhere never splits or duplicates a frame', { timeout: 60_000 }, async () => {
  // Frame terminator "\r\n\r\n" split as "data: one\r" | "\n" | "\n"
  assert.deepEqual(await collect(['data: one\r', '\n', '\n']), [{ event: 'message', data: 'one' }])
  // A chunk that is only "\r" appends nothing and keeps the CR pending; the next chunks complete "\r\n\r\n"
  assert.deepEqual(await collect(['\r', '\n\r', '\ndata: two\r\n\r\n']), [{ event: 'message', data: 'two' }])
  // CR held at the chunk boundary is released as the "\r\n" line ending inside one event block
  assert.deepEqual(await collect(['event: tick\r', '\ndata: a\r\n\r\n']), [{ event: 'tick', data: 'a' }])
})

test('streamSse end of stream: a held CR is emitted as-is and an unterminated final frame is discarded (SSE semantics)', { timeout: 60_000 }, async () => {
  assert.deepEqual(await collect(['data: three\n\ndata: tail\r']), [{ event: 'message', data: 'three' }])
  assert.deepEqual(await collect(['data: x\n\n\r']), [{ event: 'message', data: 'x' }])
})
