/**
 * dsl/boundary-safe.ts — Leaf boundary-safety primitives shared by `meta.ts` and `boundary.ts`
 * (breaks the `meta.ts <-> boundary.ts` ESM cycle).
 */

export class WorkflowRuntimeError extends Error {}

function boundaryError(what: string, path: string): WorkflowRuntimeError {
  return new WorkflowRuntimeError(`Cannot pass ${what} across the workflow VM boundary (at ${path}).`)
}

function walkBoundary(
  value: unknown,
  path: string,
  seen: Set<object>,
  allowRootUndefined: boolean,
): void {
  if (value === null) return
  const kind = typeof value
  if (kind === 'string' || kind === 'boolean') return
  if (kind === 'number') {
    if (!Number.isFinite(value)) throw boundaryError('a non-finite number', path)
    return
  }
  if (kind === 'undefined') {
    if (allowRootUndefined) return
    throw boundaryError('undefined', path)
  }
  if (kind === 'bigint') throw boundaryError('a BigInt', path)
  if (kind === 'symbol') throw boundaryError('a symbol', path)
  if (kind === 'function') throw boundaryError('a function', path)
  if (kind !== 'object') throw boundaryError(`a ${kind}`, path)

  const object = value as object
  if (seen.has(object)) throw boundaryError('a circular structure', path)
  seen.add(object)

  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw boundaryError('an object with symbol keys', path)
  }

  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      if (!Object.hasOwn(object, i)) throw boundaryError('a sparse array', `${path}[${i}]`)
      walkBoundary(object[i], `${path}[${i}]`, seen, false)
    }
    seen.delete(object)
    return
  }

  const prototype = Object.getPrototypeOf(object)
  if (prototype !== null && prototype !== Object.prototype) {
    throw boundaryError('a non-plain object', path)
  }
  for (const [key, entry] of Object.entries(object)) {
    walkBoundary(entry, `${path}.${key}`, seen, false)
  }
  seen.delete(object)
}

export function assertBoundarySafe(
  value: unknown,
  path: string,
  allowRootUndefined = path === 'args',
): void {
  walkBoundary(value, path, new Set(), allowRootUndefined)
}
