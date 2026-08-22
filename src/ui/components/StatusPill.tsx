import type { ReactNode } from 'react';

export type PillTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

export function StatusPill({
  tone = 'neutral',
  children,
  testId,
}: {
  tone?: PillTone;
  children: ReactNode;
  testId?: string;
}) {
  const classes = ['status-pill'];
  if (tone !== 'neutral') classes.push(`is-${tone}`);
  return (
    <span className={classes.join(' ')} data-testid={testId}>
      {children}
    </span>
  );
}
