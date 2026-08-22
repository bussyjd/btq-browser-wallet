import { useCallback, useState } from 'react';
import { copyText } from '../format.js';

/** Copy with a visible outcome either way: toast on success, inline note on failure. */
export function useCopy(onToast: (message: string) => void) {
  const [copyError, setCopyError] = useState<string | null>(null);

  const copy = useCallback(
    async (text: string, confirmation: string) => {
      const ok = await copyText(text);
      if (ok) {
        setCopyError(null);
        onToast(confirmation);
      } else {
        setCopyError('Copy failed — select the text and copy it manually.');
      }
    },
    [onToast],
  );

  return { copyError, copy };
}
