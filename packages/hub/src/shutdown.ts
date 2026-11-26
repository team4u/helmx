/**
 * Fault-tolerant sequential Hub shutdown coordinator (shared by `main.ts` signal/control paths
 * and isolated unit tests without triggering process-level boot side effects).
 */
export interface ShutdownStep {
  readonly name: string
  readonly run: () => Promise<void> | void
}

export interface HubShutdownTargets {
  stopHeartbeat(): Promise<void> | void
  closeHub(): Promise<void> | void
  closeApp(): Promise<void> | void
  stopUpdater?: () => Promise<void> | void
  closeControl?: () => Promise<void> | void
  onError?: (error: unknown, stepName: string) => void
  onFailure?: () => void
}

/**
 * Execute cleanup steps sequentially, continuing through failures and returning every error
 * without allowing later steps to mask earlier errors.
 */
export async function runSequentialShutdownSteps(
  steps: readonly ShutdownStep[],
  onStepError?: (error: unknown, stepName: string) => void,
): Promise<unknown[]> {
  const errors: unknown[] = []
  for (const step of steps) {
    try {
      await step.run()
    } catch (error) {
      errors.push(error)
      onStepError?.(error, step.name)
    }
  }
  return errors
}

/**
 * Create an idempotent single-flight shutdown runner for signal (`SIGINT`/`SIGTERM`) and
 * control-channel (`stop` RPC) paths. When initiated via `'control'`, `env-io`'s `runStopAndClose`
 * closes the control socket itself after `onStop` resolves, so `closeControl` is omitted on that path
 * instead of relying on mutable re-entrancy flags.
 */
export function createHubShutdownCoordinator(
  targets: HubShutdownTargets,
): (source: 'signal' | 'control') => Promise<void> {
  let activeShutdown: Promise<void> | undefined
  return (source: 'signal' | 'control'): Promise<void> => {
    if (activeShutdown !== undefined) return activeShutdown
    const steps: ShutdownStep[] = [
      { name: 'heartbeat', run: () => targets.stopHeartbeat() },
      { name: 'http-hub', run: () => targets.closeHub() },
      { name: 'app', run: () => targets.closeApp() },
    ]
    if (targets.stopUpdater !== undefined) {
      steps.push({ name: 'updater', run: targets.stopUpdater })
    }
    if (source === 'signal' && targets.closeControl !== undefined) {
      steps.push({ name: 'control', run: targets.closeControl })
    }
    activeShutdown = (async () => {
      const errors = await runSequentialShutdownSteps(steps, targets.onError)
      if (errors.length > 0) {
        targets.onFailure?.()
      }
    })()
    return activeShutdown
  }
}
