import { useCallback, useRef, useState } from 'react';
import { errMessage } from '../rpc.js';

/**
 * One in-flight mutating action with its own inline error, so a failure shows up
 * beside the button that caused it. A second submit while one is in flight (a
 * double Enter, a double click) is dropped rather than sending twice.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async (fn: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, error, setError, run };
}
