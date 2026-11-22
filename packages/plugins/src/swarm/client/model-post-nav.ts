/**
 * Pure navigation state transitions & Markdown `#seq` linkification for Swarm board post references.
 */

export const MAX_POST_PEEK_DEPTH = 20
export const MAX_POST_JUMP_BACK_DEPTH = 20
export const SWARM_POST_HREF_PREFIX = '#swarm-post-'

export interface PostPeekState {
  originSeq: number
  trail: number[]
}

export const openPostPeek = (originSeq: number, targetSeq: number): PostPeekState => ({ originSeq, trail: [targetSeq] })

export function pushPostPeek(state: PostPeekState, targetSeq: number, maxDepth = MAX_POST_PEEK_DEPTH): PostPeekState {
  const idx = state.trail.indexOf(targetSeq)
  if (idx !== -1) return idx === state.trail.length - 1 ? state : { ...state, trail: state.trail.slice(0, idx + 1) }
  const appended = [...state.trail, targetSeq]
  return { ...state, trail: appended.length > maxDepth ? appended.slice(-maxDepth) : appended }
}

export const popPostPeek = (state: PostPeekState): PostPeekState | undefined =>
  state.trail.length <= 1 ? undefined : { ...state, trail: state.trail.slice(0, -1) }

export const currentPeekSeq = (state: PostPeekState): number => state.trail[state.trail.length - 1]!
export const previousPeekSeq = (state: PostPeekState): number | undefined =>
  state.trail.length >= 2 ? state.trail[state.trail.length - 2] : undefined

export function pushJumpBack(
  stack: readonly number[],
  originSeq: number,
  targetSeq: number,
  maxDepth = MAX_POST_JUMP_BACK_DEPTH,
): number[] {
  if (originSeq === targetSeq || stack[stack.length - 1] === originSeq) return stack as number[]
  const next = [...stack, originSeq]
  return next.length > maxDepth ? next.slice(-maxDepth) : next
}

export const popJumpBack = (stack: readonly number[]): { targetSeq: number | undefined; nextStack: number[] } =>
  stack.length === 0 ? { targetSeq: undefined, nextStack: [] } : { targetSeq: stack[stack.length - 1], nextStack: stack.slice(0, -1) }

export function parseSwarmPostHref(href: string): number | undefined {
  if (!href.startsWith(SWARM_POST_HREF_PREFIX)) return undefined
  const raw = href.slice(SWARM_POST_HREF_PREFIX.length)
  if (!/^[1-9]\d*$/.test(raw)) return undefined
  const num = Number(raw)
  return Number.isSafeInteger(num) && num > 0 ? num : undefined
}

const POST_REF_TOKEN_RE = /(^|[\s(\[（【，。：；、·])#([1-9]\d*)\b/g
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/

function linkifyPlain(segment: string, selfSeq: number | undefined): string {
  return segment.replace(POST_REF_TOKEN_RE, (full, prefix: string, digits: string) => {
    const seq = Number(digits)
    return Number.isSafeInteger(seq) && seq > 0 && seq !== selfSeq
      ? `${prefix}[#${digits}](${SWARM_POST_HREF_PREFIX}${digits})`
      : full
  })
}

function linkifyLine(line: string, selfSeq: number | undefined): string {
  let out = ''
  let plainStart = 0
  let i = 0
  const flush = (end: number): void => {
    if (end > plainStart) out += linkifyPlain(line.slice(plainStart, end), selfSeq)
  }

  while (i < line.length) {
    const ch = line[i]
    if (ch === '`') {
      let ticks = 1
      while (line[i + ticks] === '`') ticks += 1
      const closeIdx = line.indexOf('`'.repeat(ticks), i + ticks)
      if (closeIdx !== -1) {
        flush(i)
        const end = closeIdx + ticks
        out += line.slice(i, end)
        i = plainStart = end
        continue
      }
      i += ticks
      continue
    }
    if (ch === '[') {
      const closeBracket = line.indexOf(']', i + 1)
      if (closeBracket !== -1 && line[closeBracket + 1] === '(') {
        const closeParen = line.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          flush(i)
          const end = closeParen + 1
          out += line.slice(i, end)
          i = plainStart = end
          continue
        }
      }
    }
    i += 1
  }
  flush(line.length)
  return out
}

export function linkifyPostRefs(markdown: string, selfSeq?: number): string {
  let fenceChar: string | null = null
  let fenceLen = 0
  return markdown
    .split('\n')
    .map((line) => {
      const m = FENCE_LINE_RE.exec(line)
      if (fenceChar !== null) {
        if (m && m[1]![0] === fenceChar && m[1]!.length >= fenceLen && line.slice(m[0].length).trim() === '') {
          fenceChar = null
          fenceLen = 0
        }
        return line
      }
      if (m) {
        fenceChar = m[1]![0]!
        fenceLen = m[1]!.length
        return line
      }
      return linkifyLine(line, selfSeq)
    })
    .join('\n')
}
