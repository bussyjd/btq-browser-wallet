/** The extension mark without its background tile — ring, tail and quantum dot. */
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="22 17 90 92"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="62" cy="60" r="30" fill="none" stroke="currentColor" strokeWidth="11" />
      <path d="M80 78 L101 99" stroke="currentColor" strokeWidth="11" strokeLinecap="round" />
      <circle cx="99" cy="29" r="7" fill="currentColor" opacity="0.7" />
    </svg>
  );
}
