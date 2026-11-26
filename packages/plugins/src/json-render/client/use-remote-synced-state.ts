/**
 * Remote-value-driven state hook for declarative inputs:
 * - preserves uncommitted local input across unrelated parent re-renders while `remote` stays unchanged;
 * - re-syncs whenever `remote` changes (including after prior local edits when fresh SSE state arrives).
 */
import { useEffect, useRef, useState } from 'react'

export function useRemoteSyncedState<T>(
  remote: T,
  areEqual: (a: T, b: T) => boolean,
): [T, (next: T) => void] {
  const [local, setLocal] = useState<T>(remote)
  const prevRemoteRef = useRef<T>(remote)

  useEffect(() => {
    if (!areEqual(prevRemoteRef.current, remote)) {
      prevRemoteRef.current = remote
      setLocal(remote)
    }
  }, [remote, areEqual])

  return [local, setLocal]
}
