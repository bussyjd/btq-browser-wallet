/**
 * The HD seed as hex, in four-character clusters. The **only** place in the
 * popup that renders the `seed-hex` test id, and the only place that should.
 *
 * Length is whatever the vault holds and is deliberately not asserted here: a
 * raw-32 import seals 32 bytes, a wallet built from a phrase seals the 64-byte
 * BIP39 seed, and the golden vectors use 16. The redaction bar is one fixed
 * size for the same reason — it must not leak which of those this wallet is.
 *
 * That is mandatory rather than stylistic, for exactly the reason SeedGrid says
 * it: the demo recording redacts secret surfaces by selector
 * (`tests/e2e/fixtures/redact.ts`), and `seed-hex` is one of the four names on
 * that list. A second element rendering the seed under its own id would paint a
 * legible master secret into a video shipped in this repository.
 *
 * No copy button — not here and not in any caller, the same rule the phrase
 * grid keeps. The clipboard is readable by anything else running on this
 * machine, and 64 characters that reach it outlive the screen that showed them.
 * This is not an omission to be improved.
 *
 * `textContent` is the exact hex with no separators: the groups are separate
 * elements with no whitespace text nodes between them, so a test can read the
 * seed back and a user cannot copy a mangled one out of the selection.
 */
export function SeedHex({ seedHex }: { seedHex: string }) {
  const groups: string[] = [];
  for (let i = 0; i < seedHex.length; i += 4) groups.push(seedHex.slice(i, i + 4));
  return (
    <p className="seed-hex" data-testid="seed-hex">
      {groups.map((g, i) => (
        <span key={i} className="grp">
          {g}
        </span>
      ))}
    </p>
  );
}
