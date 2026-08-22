/** One non-stacking confirmation line. Success only — errors stay inline. */
export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="toast" role="status" data-testid="toast">
      {message}
    </p>
  );
}
