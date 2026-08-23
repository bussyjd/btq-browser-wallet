/**
 * The recovery phrase, rendered as a numbered grid. The **only** place in the
 * popup that renders a `seed-word-N` test id, and the only place that should.
 *
 * That is mandatory rather than stylistic. The demo recording redacts phrase
 * surfaces by the selector `[data-testid^="seed-word-"]` and nothing else, so a
 * second grid with its own ids would paint a legible recovery phrase into a
 * video shipped in this repository. `tests/unit/testids.test.ts` keys on the
 * same prefix when it expands template ids, so such a grid would also satisfy
 * the selector contract while doing it.
 *
 * No copy button — not here and not in any caller. The clipboard is readable by
 * anything else running on this machine, and a phrase that reaches it outlives
 * the screen that showed it. This is not an omission to be improved.
 */
export function SeedGrid({ words }: { words: string[] }) {
  return (
    <ol className="seed-grid">
      {words.map((w, i) => (
        <li key={i}>
          <span className="n">{i + 1}</span>
          <span data-testid={`seed-word-${i + 1}`}>{w}</span>
        </li>
      ))}
    </ol>
  );
}
