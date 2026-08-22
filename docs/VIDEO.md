# Demo video — storyboard and shot list

Target: **3–4 minutes**, one continuous take per journey, no slides. It has to
show, in this order: **create → import on a second profile → receive → send →
site-connect**. Everything below is real: testnet, the built `dist/`, the
extension signing with its own keys.

Two ways to get it, and they compose:

| | |
|---|---|
| **Recorded by the suite** | `npm run demo:video` → `demo/btq-wallet-demo.mp4`. No hands, no staging: Playwright drives the built extension and records the popup. Silent, 360×600. |
| **Narrated capture** | Screen-record the popup by hand, following the shot list, with the voice-over lines. Slower, but it can show the browser chrome, the toolbar icon and the dapp page in one frame. |

The recommended cut is the narrated capture using the shot list, with the
suite's recording as the B-roll for the send and restore shots — those are the
two places where "the tests did this, not me" is worth showing.

## Before you record

```sh
npm ci
npm run build                     # dist/ — load it at chrome://extensions (Developer mode → Load unpacked)
npm run test:all                  # green suite in a terminal makes a good closing shot
python3 -m http.server 8080 -d tests/e2e/fixtures   # the demo dapp, for the site-connect shot
```

The wallet talks to `https://explorer.bitcoinquantum.com` by default. For the
send shot it also needs a BTQ Core **v0.5.0-testnet** node synced to the
explorer's chain (Settings → Testnet → node URL/user/password): the public
explorer has no broadcast route, so the node is what pushes the transaction. Fund
the receive address from that node before you start; a wallet with a balance is
the difference between a demo and a tour.

Set the OS zoom / capture to the popup at 360×600 and keep it there — the popup
is the product, and a full-screen 4K capture of a 360-pixel-wide panel looks
like a mistake.

## Shot list

Times are cumulative and approximate; 3:45 is a comfortable landing.

| # | ~time | On screen | Say |
|---|---|---|---|
| 0 | 0:00–0:10 | Chrome toolbar, BTQ icon, click it → Welcome | "A browser wallet for BTQ testnet. Post-quantum keys — ML-DSA-44 — signing P2MR taproot outputs, in the extension." |
| 1 | 0:10–0:35 | **Create**: **Create a wallet** → password + confirm → the 12 words appear | "New wallet: the password seals the vault first, then the phrase is shown — once. It is never written to storage, and it never leaves the service worker." |
| 2 | 0:35–0:55 | Confirm-three-words screen → **Seal the vault** → the wallet home with a balance of 0 | "You type three of the words back, and the vault is sealed with PBKDF2 + AES-GCM. From here on the phrase exists only in your head." |
| 3 | 0:55–1:05 | `chrome://extensions` → service worker → Application → Storage, showing `vault` as one hex blob | "This is everything the extension stores: a sealed blob and some metadata. No phrase, no seed, no password." |
| 4 | 1:05–1:30 | **Receive** tab: address `tbtq1z…`, path `m/0'/0'/0'`, QR, **Copy address** | "Receive gives the next unused address, with its derivation path and a QR of that exact string. Copy — that is the address, checked character for character in the tests." |
| 5 | 1:30–1:50 | Pay it from the node / faucet, hit Refresh: balance rises, Activity shows **Pending** then **confirmed**; Receive has moved to `m/0'/0'/1'` | "Balance and history come from the public explorer — summed from the unspent outputs, never from the indexer's balance field, which goes negative on busy addresses. Once an address is paid, Receive moves on." |
| 6 | 1:50–2:00 | Lock → wrong password → "Incorrect password." → unlock | "Lock drops the keys from memory. A wrong password gets you nothing — no partial unlock, no timing tell." |
| 7 | 2:00–2:15 | **Settings**: explorer URL, node URL/user/password, **Test connection** → chain + height, **Save** → pill reads `Testnet · node` | "The explorer has no broadcast route, so signing and broadcasting are split: read from the explorer, push through your own node. Test tells you if the node is on a different chain than the explorer." |
| 8 | 2:15–2:50 | **Send**: paste destination, amount, fee preset (1 / 2 / 5 sat/vB), Review — to, amount, fee, vsize, inputs, change | "Review shows the fee in satoshis and the size it is paying for, computed with btq-core's scale-16 arithmetic — a Dilithium input is about 2.4 KB of witness, so fees here are nothing like Bitcoin's." |
| 9 | 2:50–3:05 | Password field → **Sign and broadcast** → result card: txid, **Broadcast via node**, explorer link; Activity row Pending → confirmed | "The password is asked again, the transaction is signed **before** any network call, and the raw hex is kept even if the broadcast fails. Nothing signs without the leaf committing to the witness program." |
| 10 | 3:05–3:25 | **Second Chrome profile**, load the same `dist/`, **I already have a seed** → **Use a seed phrase** → paste the 12 words → new password → the same balance and history come back | "Import on a clean profile: same phrase, different password, and the scan walks the gap limit — it finds coins on addresses this wallet had never displayed." |
| 11 | 3:25–3:45 | `localhost:8080/dapp.html` → **Connect wallet** → the approval window naming the origin → **Connect** → the account appears on the page; then Settings → Connected sites → Revoke | "Site-connect works like MetaMask: the page sees `window.btq`, asks, and gets nothing until you approve — per origin, revocable, and a denial comes back as 4001." |
| 12 | 3:45–3:55 | Terminal: `npm run test:all` green | "Unit, security and end-to-end suites — the end-to-end one drives this build in a real Chromium and re-verifies every signature it produces against an independent implementation." |

Cut ruthlessly if it runs long: shots 3 and 6 are the ones to shorten. Send and
import are the two nobody should have to take on trust — leave them whole.

## What the auto-generated recording gives you

`npm run demo:video` runs `RECORD_VIDEO=1 playwright test tests/e2e/smoke.spec.ts`
and then `scripts/stitch-demo.sh`, which concatenates the clips with ffmpeg in
the order the pages were opened (`demo/raw/order.txt`) into
`demo/btq-wallet-demo.mp4`:

| Clip directory | Shots it covers |
|---|---|
| `demo/raw/01-device-a-create-receive-send` | 1, 2, 4, 5, 6, 7, 8, 9 — create through send, including the node accepting the signed bytes |
| `demo/raw/02-device-b-import` | 10 — restore from the phrase on a second profile |
| `demo/raw/03-device-c-bad-imports` | (no shot) — refused seeds; useful B-roll for "a bad seed never seals a vault" |

Site-connect is in `connect.spec.ts`, which `demo:video` does not run. To record
the whole set, including the approval window and the dapp page:

```sh
RECORD_VIDEO=1 npm run test:e2e     # adds 04-device-connect and 05-device-negative
sh scripts/stitch-demo.sh           # -> demo/btq-wallet-demo.mp4
```

Then `04-device-connect` covers shot 11 and `05-device-negative` is B-roll for
the refusals (wrong password, bad destination, a backend that fails after
signing).

Caveats worth knowing before you build a cut around it:

- **Silent.** Playwright records video only. Add voice-over or captions in an editor.
- **Popup only** — 360×600, no browser chrome, no cursor. The frame is the panel.
- **Machine-paced.** It moves faster than a person and pauses where the assertions
  wait. Good for proof, weak for narration; slow it with
  `-vf setpts=1.6*PTS` if you use a segment straight.
- The clips are per *page*, so a journey that opens a second popup appears as a
  second clip; `order.txt` keeps them in the order they were opened.
- `demo/raw/` is git-ignored; only the stitched `demo/btq-wallet-demo.mp4` is committed.

## Stitching a narrated cut

`scripts/stitch-demo.sh` is a plain ffmpeg concat, so a hand cut can reuse it:
drop your own clips into numbered directories under `demo/raw/`, delete
`demo/raw/order.txt`, and the script falls back to directory order, oldest file
first within each directory. Output is H.264 / yuv420p at 25 fps, which every
browser and every desktop media player will open.
