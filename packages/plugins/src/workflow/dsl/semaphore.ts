/**
 * dsl/semaphore.ts — Counting semaphore bounding concurrent host-side calls of one workflow run.
 */
export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    this.available = Math.max(1, permits)
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next !== undefined) next()
    else this.available++
  }

  drain(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift()
      if (next !== undefined) next()
    }
  }
}
