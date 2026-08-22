import { useId, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  /** Validation line rendered under the input. */
  note?: { ok: boolean; text: string } | null;
  mono?: boolean;
}

export function Field({ label, hint, note, mono, className, id, ...rest }: FieldProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const classes = ['input'];
  if (mono) classes.push('input-mono');
  if (className) classes.push(className);
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <input id={inputId} className={classes.join(' ')} {...rest} />
      {hint ? <p className="hint">{hint}</p> : null}
      {note ? (
        <p className={note.ok ? 'hint note-ok' : 'hint note-warn'} role={note.ok ? undefined : 'status'}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}

interface AreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
  mono?: boolean;
}

export function TextAreaField({ label, hint, mono, className, id, ...rest }: AreaProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const classes = ['input'];
  if (mono) classes.push('input-mono');
  if (className) classes.push(className);
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <textarea id={inputId} className={classes.join(' ')} {...rest} />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

interface PasswordProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  hint?: string;
}

/**
 * Password input with a show/hide toggle. The value only ever lives in the
 * caller's component state and dies with the screen.
 */
export function PasswordField({ label, hint, id, className, ...rest }: PasswordProps) {
  const auto = useId();
  const inputId = id ?? auto;
  const [shown, setShown] = useState(false);
  const classes = ['input'];
  if (className) classes.push(className);
  return (
    <div className="field">
      <label htmlFor={inputId}>{label}</label>
      <div className="pw-wrap">
        <input id={inputId} type={shown ? 'text' : 'password'} className={classes.join(' ')} {...rest} />
        <button
          type="button"
          className="pw-toggle"
          aria-pressed={shown}
          aria-label={shown ? 'Hide password' : 'Show password'}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
