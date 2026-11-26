/**
 * Per-key asynchronous mutex using a tail-chained promise queue.
 * Guarantees FIFO serialization per key while keeping distinct keys concurrent,
 * and cleans up completed tail entries when no newer operation is queued behind them.
 */
export interface KeyedMutex<K = string> {
  run<T>(key: K, fn: () => Promise<T>): Promise<T>
}

export function createKeyedMutex<K = string>(): KeyedMutex<K> {
  const tails = new Map<K, Promise<void>>()
  return {
    run<T>(key: K, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve()
      const next = prev.then(fn, fn)
      const tail = next.then(
        () => undefined,
        () => undefined,
      )
      tails.set(key, tail)
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key)
      })
      return next
    },
  }
}
