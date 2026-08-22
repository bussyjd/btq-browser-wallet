import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

interface Props extends HTMLAttributes<HTMLDivElement> {
  tone?: 'default' | 'warn' | 'quiet';
  children: ReactNode;
}

export const Card = forwardRef<HTMLDivElement, Props>(function Card(
  { tone = 'default', className, children, ...rest },
  ref,
) {
  const classes = ['card'];
  if (tone === 'warn') classes.push('card-warn');
  if (tone === 'quiet') classes.push('card-quiet');
  if (className) classes.push(className);
  return (
    <div ref={ref} className={classes.join(' ')} {...rest}>
      {children}
    </div>
  );
});
