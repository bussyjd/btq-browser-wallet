import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'link';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  small?: boolean;
  children: ReactNode;
}

export function Button({ variant = 'primary', small, className, type = 'button', ...rest }: Props) {
  const classes = ['btn', `btn-${variant}`];
  if (small) classes.push('btn-small');
  if (className) classes.push(className);
  return <button type={type} className={classes.join(' ')} {...rest} />;
}
