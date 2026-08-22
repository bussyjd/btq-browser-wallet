import { useEffect, useRef } from 'react';

/**
 * Errors live next to the action that caused them, never in a toast. A popup is
 * only ~560 px tall, so an error under a button can land below the fold —
 * bring it into view when it appears.
 */
export function InlineError({ message, testId = 'error' }: { message: string | null; testId?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (message) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [message]);

  if (!message) return null;
  return (
    <p className="error" role="alert" data-testid={testId} ref={ref}>
      {message}
    </p>
  );
}
