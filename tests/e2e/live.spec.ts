/**
 * Tier 3 — the recorded journey, with nothing mocked.
 *
 * The built extension, the public BTQ explorer and a real btqd on this machine.
 * Alice's coins are real testnet coins, the transaction is a real transaction,
 * and the confirmation is a real block. Every number on screen is asserted
 * against something read independently in Node before it is dwelt on, because
 * the whole point of this file is to produce a recording that can be believed.
 *
 *   npm run demo:preflight     # will this run? (no browser, ~3 s)
 *   npm run demo:live          # preflight, build, record, stitch
 *
 * Without `BTQ_LIVE=1` every test here skips with a reason and the file costs a
 * CI run nothing — `playwright.config.ts` is not touched and the mocked suite
 * does not know this file exists.
 *
 * Pacing lives in `fixtures/scene.ts`; the chain reads and the waiters live in
 * `fixtures/live.ts`. Rule for both: a live run that cannot prove what it is
 * showing must throw, not degrade.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  POPUP_VIEWPORT,
  confirmSeed,
  importMnemonic,
  launchDevice,
  leaveSettings,
  openSettings,
  receiveAddress,
  unlock,
  waitForApprovalPage,
  waitForSendResult,
  type Device,
} from './fixtures/extension.js';
import { videoDir } from './fixtures/video.js';
import { SEED_WORDS, expectRedacted } from './fixtures/redact.js';
import { dwell, expectCaptions, expectNoSecret, note, scene, typeInto, type Secret } from './fixtures/scene.js';
import {
  firstAddress,
  formatPreflight,
  liveFromEnv,
  preflight,
  shortAddress,
  waitForConfirmation,
  waitForExplorerTx,
  waitForExplorerUtxo,
  waitForLiveScan,
  waitForReview,
} from './fixtures/live.js';
import { startStaticDapp, type StaticDapp } from './fixtures/static-dapp.js';
import { addressFromHdSeed } from '../../src/core/wallet/derive.js';
import { decodeAddress } from '../../src/core/script/address.js';
import { bytesToHex } from '../../src/core/util/hex.js';
import { mnemonicToHdSeed } from '../../src/core/crypto/mnemonic.js';
import { formatSats, parseBtqAmount } from '../../src/core/wallet/format.js';
import { GAP_LIMIT } from '../../src/core/wallet/gap.js';

test.describe.configure({ mode: 'serial' });
// These tests build their own contexts with `launchPersistentContext`, so the
// `trace` fixture never attaches to them anyway. Saying so is a statement of
// intent: nothing in this run may leave a replayable artifact holding a
// credential or a phrase.
test.use({ trace: 'off' });

const cfg = liveFromEnv();

/**
 * One canvas for the whole cut. The popup pages set themselves back to the
 * toolbar geometry; Playwright scales and letterboxes each clip into this size,
 * so 360×600 popup clips and 960×640 tab clips concatenate without ffmpeg ever
 * seeing a resolution change and `stitch-demo.sh` needs no argument for it.
 */
const CANVAS = { width: 960, height: 640 };
/** A beat between gestures, so a viewer can follow the pointer. */
const SLOW_MO = 180;
/** The create-a-wallet scene throws its wallet away; this never guards coins. */
const CREATE_PASSWORD = 'demo-create-pass';

let deviceCreate: Device | undefined;
let deviceAlice: Device | undefined;
let deviceBob: Device | undefined;
let dapp: StaticDapp | undefined;
/** The Alice popup the middle scenes share; closed after the broadcast. */
let alicePopup: Page | undefined;

let bobAddress = '';
let sentTxid = '';
let balanceBefore = 0n;
let feePaid = 0n;

/** The values that must never reach a frame, named so a failure can say which. */
function secrets(): Secret[] {
  if (!cfg) return [];
  return [
    { label: 'BTQ_DEMO_RPC_PASSWORD', value: cfg.node.password },
    { label: "Alice's wallet password", value: cfg.alice.password },
    { label: 'BTQ_DEMO_ALICE_MNEMONIC', value: cfg.alice.mnemonic },
    { label: 'BTQ_DEMO_BOB_MNEMONIC', value: cfg.bob.mnemonic },
  ];
}

/** Skip reason when the operator did not ask for a live run. */
const NOT_LIVE = 'set BTQ_LIVE=1 and the BTQ_DEMO_* variables to record the live demo';

function inCut(n: number): boolean {
  return cfg === null || cfg.scenes === null || cfg.scenes.has(n);
}

/** A popup can come up locked: the vault seals itself after five idle minutes. */
async function ensureUnlocked(page: Page, password: string): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await page.getByTestId('unlock-pw').count()) > 0) return 'locked';
        if ((await page.getByTestId('balance').count()) > 0) return 'open';
        return 'waiting';
      },
      { timeout: 30_000, message: 'the popup showed neither the unlock screen nor a balance' },
    )
    .not.toBe('waiting');
  if ((await page.getByTestId('unlock-pw').count()) > 0) {
    await unlock(page, password);
    await expect(page.getByTestId('balance')).toBeVisible({ timeout: 30_000 });
  }
}

/** Every address either chain of a phrase can produce inside the gap window. */
function derivedAddresses(mnemonic: string, chain: 'external' | 'internal'): string[] {
  const hdSeed = mnemonicToHdSeed(mnemonic);
  return Array.from(
    { length: GAP_LIMIT },
    (_, i) => addressFromHdSeed(hdSeed, chain, i, 'testnet').address,
  );
}

test.beforeAll(async () => {
  if (!cfg) return;
  // The same gate `scripts/demo-live.sh` runs before the build, run again here
  // so a bare `npx playwright test tests/e2e/live.spec.ts` refuses too — and
  // this time with `checkDist`, because by now there is a dist/ to judge.
  const report = await preflight(cfg, { checkDist: true });
  console.log(formatPreflight(cfg, report));
  if (!report.ok) throw new Error(`\n${report.refusals.join('\n')}`);

  bobAddress = firstAddress(cfg.bob.mnemonic);
});

test.afterAll(async () => {
  await deviceBob?.close();
  await deviceAlice?.close();
  await deviceCreate?.close();
  await dapp?.close();
});

// --------------------------------------------------------------- 1 · create

test('scene 1 · a wallet is created and scans an empty chain', async () => {
  test.skip(cfg === null, NOT_LIVE);
  test.skip(!inCut(1), 'scene 1 is not in BTQ_DEMO_SCENES');
  if (!cfg) return;
  test.setTimeout(240_000);

  deviceCreate = await launchDevice({
    name: 'create',
    reach: 'live',
    backend: 'none',
    captions: true,
    slowMo: SLOW_MO,
    viewport: CANVAS,
    videoSize: CANVAS,
    videoDir: videoDir(10, 'create'),
  });
  const popup = await deviceCreate.popup();
  await expectCaptions(popup);
  await scene(popup, 1, 'Create a wallet', {
    sub: 'Twelve words, once. The vault is sealed with a password that never leaves this machine.',
  });

  await popup.getByTestId('welcome-create').click();
  await typeInto(popup, 'pw', CREATE_PASSWORD);
  await typeInto(popup, 'pw2', CREATE_PASSWORD);
  await popup.getByTestId('pw-continue').click();

  await expect(popup.getByTestId('seed-word-1')).toBeVisible({ timeout: 60_000 });
  // The bars are the recording's, not the wallet's: the DOM still holds the
  // real words, which is how the confirmation below can type them back.
  await expectRedacted(popup, SEED_WORDS, 12);
  const words: string[] = [];
  for (let i = 1; i <= 12; i++) {
    words.push(((await popup.getByTestId(`seed-word-${i}`).textContent()) ?? '').trim());
  }
  expect(words.filter((w) => /^[a-z]{3,8}$/.test(w))).toHaveLength(12);
  await note(popup, 'Covered for the recording — the wallet shows them in the clear.');
  await dwell(popup, 2600);
  await popup.getByTestId('seed-continue').click();

  await confirmSeed(popup, words);

  await note(popup, `A real gap scan: ${GAP_LIMIT} addresses on the public explorer.`);
  await waitForLiveScan(popup, 150_000);
  await expect(popup.getByTestId('balance')).toHaveText('0');
  await dwell(popup, 2200);

  await popup.close();
  await deviceCreate.close();
  deviceCreate = undefined;
});

// ---------------------------------------------------------------- 2 · Alice

test("scene 2 · Alice's phrase restores her coins from the public explorer", async () => {
  test.skip(cfg === null, NOT_LIVE);
  if (!cfg) return;
  test.setTimeout(300_000);

  deviceAlice = await launchDevice({
    name: 'alice',
    reach: 'live',
    backend: 'none',
    captions: true,
    slowMo: SLOW_MO,
    viewport: CANVAS,
    videoSize: CANVAS,
    videoDir: videoDir(11, 'alice'),
  });
  const popup = await deviceAlice.popup();
  alicePopup = popup;
  await expectCaptions(popup);
  await scene(popup, 2, 'Restore from a phrase', {
    sub: 'The same twelve words on a new device find the same coins.',
  });

  await importMnemonic(popup, cfg.alice.mnemonic, cfg.alice.password);
  await note(popup, `Reading ${cfg.explorer} — no mock, no fixture.`, 3000);
  await waitForLiveScan(popup, 150_000);

  const shown = (await popup.getByTestId('balance').innerText()).trim();
  balanceBefore = parseBtqAmount(shown);
  expect(
    balanceBefore >= cfg.amountSats,
    `the wallet shows ${shown} tBTQ, which will not cover the ${cfg.amountBtq} tBTQ this take sends`,
  ).toBe(true);
  await expect(popup.locator('.app-body')).toContainText(/addresses in use/);
  await dwell(popup, 2600);
});

// -------------------------------------------------------------- 3 · receive

test('scene 3 · the receive address is the one the seed derives', async () => {
  test.skip(cfg === null, NOT_LIVE);
  if (!cfg) return;
  test.setTimeout(180_000);
  const popup = alicePopup as Page;

  await scene(popup, 3, 'Receive', { sub: 'Address, path, QR — derived here, checked in the test.' });
  await popup.getByTestId('tab-receive').click();
  await expect(popup.getByTestId('receive-address')).toBeVisible();

  const path = ((await popup.getByTestId('receive-path').textContent()) ?? '').trim();
  const index = Number(/m\/0'\/0'\/(\d+)'/.exec(path)?.[1] ?? NaN);
  expect(Number.isInteger(index), `receive-path did not read as an external path: "${path}"`).toBe(true);
  const expected = addressFromHdSeed(
    mnemonicToHdSeed(cfg.alice.mnemonic),
    'external',
    index,
    'testnet',
  ).address;
  expect(await receiveAddress(popup)).toBe(expected);
  await expect(popup.getByTestId('receive-qr')).toBeVisible();
  await dwell(popup, 2600);

  await popup.getByTestId('copy-address').click();
  await expect(popup.getByTestId('toast')).toHaveText('Address copied');
  expect(await popup.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  await dwell(popup, 1600);
});

// --------------------------------------------------------------- 4 · a node

test('scene 4 · the wallet is pointed at a real BTQ Core node', async () => {
  test.skip(cfg === null, NOT_LIVE);
  if (!cfg) return;
  test.setTimeout(180_000);
  const popup = alicePopup as Page;

  await scene(popup, 4, 'Broadcast through your own node', {
    sub: 'The explorer has no push route. Signed bytes go out over your node’s JSON-RPC.',
  });
  await openSettings(popup);
  await typeInto(popup, 'node-url', cfg.node.url);
  await typeInto(popup, 'node-user', cfg.node.user);
  // Not typed character by character: the fewer frames a credential spends
  // anywhere near the compositor the better, masked or not.
  await popup.getByTestId('node-pw').fill(cfg.node.password);
  await expectNoSecret(popup, secrets());

  await popup.getByTestId('backend-test').click();
  await expect(popup.getByTestId('backend-note')).toContainText('node chain test', {
    timeout: 60_000,
  });
  await expectNoSecret(popup, secrets());
  await dwell(popup, 2600);

  await popup.getByTestId('backend-save').click();
  await expect(popup.getByTestId('toast')).toHaveText('Settings saved');
  await expect(popup.getByTestId('network-pill')).toHaveText('Testnet · node');
  await expectNoSecret(popup, secrets());
  await dwell(popup, 1400);

  await leaveSettings(popup);
  await waitForLiveScan(popup, 150_000);
  balanceBefore = parseBtqAmount((await popup.getByTestId('balance').innerText()).trim());
});

// ----------------------------------------------------------------- 5 · send

test('scene 5 · a real payment is signed and broadcast', async () => {
  test.skip(cfg === null, NOT_LIVE);
  if (!cfg) return;
  test.setTimeout(300_000);
  const popup = alicePopup as Page;

  await scene(popup, 5, 'Send', { sub: `${cfg.amountBtq} tBTQ to ${shortAddress(bobAddress)}` });
  await popup.getByTestId('tab-send').click();
  // 62 characters at 45 ms would be half a minute of watching an address appear.
  await typeInto(popup, 'send-to', bobAddress, { delay: 12 });
  await typeInto(popup, 'send-amount', cfg.amountBtq);
  await popup.getByTestId('fee-normal').click();
  await popup.getByTestId('send-review').click();
  await waitForReview(popup, 60_000);

  await expect(popup.getByTestId('review-to')).toHaveText(bobAddress);
  await expect(popup.getByTestId('review-amount')).toHaveText(`${formatSats(cfg.amountSats)} tBTQ`);
  const feeText = ((await popup.getByTestId('review-fee').textContent()) ?? '').replace(' tBTQ', '');
  feePaid = parseBtqAmount(feeText.trim());
  expect(feePaid > 0n, 'the review card quoted a zero fee').toBe(true);
  // The change output has to pay this wallet back, or the difference is burnt.
  await expect(popup.getByTestId('review-change')).toHaveText(
    `${formatSats(balanceBefore - cfg.amountSats - feePaid)} tBTQ`,
  );
  await dwell(popup, 3400);

  await popup.getByTestId('send-pw').fill(cfg.alice.password);
  await expectNoSecret(popup, secrets());
  await popup.getByTestId('send-confirm').click();
  await waitForSendResult(popup, 120_000);

  // The two outcomes read "Broadcast via node" and "Signed, not broadcast": a
  // success that differs from a failure only by a capital letter is not an
  // assertion worth making, so the whole string is the assertion.
  await expect(popup.getByTestId('result-status')).toHaveText('Broadcast via node');
  await expect(popup.getByTestId('result-error')).toHaveCount(0);
  sentTxid = (await popup.getByTestId('result-txid').getAttribute('data-txid')) ?? '';
  expect(sentTxid).toMatch(/^[0-9a-f]{64}$/);
  await note(popup, 'The node accepted it and relayed it to the network.', 3000);
  await dwell(popup, 2600);

  await popup.getByTestId('tab-activity').click();
  const row = popup.locator(`[data-testid="activity-row"][data-txid="${sentTxid}"]`);
  await expect(row).toContainText('Pending');
  await dwell(popup, 2200);
  await expectNoSecret(popup, secrets());

  // Everything from here to the confirmation happens with no page open, so the
  // recording cuts straight from "Broadcast via node" to a confirmed row.
  await popup.close();
  alicePopup = undefined;
});

test('— one confirmation, and the indexer catches up (no clip) —', async () => {
  test.skip(cfg === null, NOT_LIVE);
  if (!cfg) return;
  test.setTimeout(cfg.confirmTimeoutMs + 600_000);

  const confirmations = await waitForConfirmation(cfg, sentTxid);
  expect(confirmations).toBeGreaterThanOrEqual(1);
  await waitForExplorerTx(cfg, sentTxid);
  // Bob's device must not launch until the indexer can answer for his address,
  // or his clip records a zero that is the explorer's fault and reads as the
  // wallet's.
  await waitForExplorerUtxo(cfg, bobAddress, sentTxid);
});

// ------------------------------------------------------------- 6 · explorer

test('scene 6 · the transaction on the public explorer', async () => {
  test.skip(cfg === null, NOT_LIVE);
  test.skip(!inCut(6), 'scene 6 is not in BTQ_DEMO_SCENES');
  if (!cfg) return;
  test.setTimeout(180_000);

  const tab = await deviceAlice!.tab(`${cfg.explorer}/tx/${sentTxid}`);
  await scene(tab, 6, 'The same transaction, on the public explorer', {
    sub: 'Nothing about this page is ours.',
  });
  // Fail on a blank tab rather than dwell on one: the page must actually name
  // the transaction and both of its outputs before it is worth showing.
  //
  // It prints the txid in full, but it renders each output as its witness
  // program shortened to `head…tail` and never shows the bech32 address, so
  // that is what we look for — derived here from the two addresses this test
  // computed itself, which ties the outputs on screen to our own keys more
  // tightly than an address string would.
  const shortened = (address: string): string => {
    const hex = bytesToHex(decodeAddress(address, 'testnet').merkleRoot);
    return `${hex.slice(0, 20)}...${hex.slice(-20)}`;
  };
  const change = derivedAddresses(cfg.alice.mnemonic, 'internal');
  let missing = 'the page never rendered';
  await expect
    .poll(
      async () => {
        const text = await tab.evaluate(() => document.body?.innerText ?? '');
        const hasTxid = text.includes(sentTxid);
        const hasPayee = text.includes(shortened(bobAddress));
        const hasChange = change.some((a) => text.includes(shortened(a)));
        missing = [
          hasTxid ? null : 'the txid',
          hasPayee ? null : `the payee output (${shortened(bobAddress)})`,
          hasChange ? null : 'the change output',
        ]
          .filter(Boolean)
          .join(', ');
        return hasTxid && hasPayee && hasChange;
      },
      {
        timeout: 60_000,
        message: `${cfg.explorer}/tx/${sentTxid} never showed ${missing}`,
      },
    )
    .toBe(true);
  await dwell(tab, 4200);
  await tab.close();
});

// ------------------------------------------------------ 7 · Alice confirmed

test('scene 7 · Alice sees the payment confirmed', async () => {
  test.skip(cfg === null, NOT_LIVE);
  test.skip(!inCut(7), 'scene 7 is not in BTQ_DEMO_SCENES');
  if (!cfg) return;
  test.setTimeout(300_000);

  const popup = await deviceAlice!.popup();
  await ensureUnlocked(popup, cfg.alice.password);
  await scene(popup, 7, 'Confirmed', { sub: 'A block later, from the same wallet.' });
  await note(popup, 'A couple of minutes later — one confirmation.', 3000);
  await waitForLiveScan(popup, 150_000);

  const after = parseBtqAmount((await popup.getByTestId('balance').innerText()).trim());
  expect(
    balanceBefore - after,
    'the balance did not fall by exactly the amount plus the fee that was quoted on the review card',
  ).toBe(cfg.amountSats + feePaid);
  await dwell(popup, 2600);

  await popup.getByTestId('tab-activity').click();
  const row = popup.locator(`[data-testid="activity-row"][data-txid="${sentTxid}"]`);
  await expect(row).toContainText(/conf/i);
  await dwell(popup, 2600);
  await popup.close();
});

// ------------------------------------------------------------------ 8 · Bob

test('scene 8 · Bob restores his own wallet and finds the payment', async () => {
  test.skip(cfg === null, NOT_LIVE);
  if (!cfg) return;
  test.setTimeout(300_000);

  deviceBob = await launchDevice({
    name: 'bob',
    reach: 'live',
    backend: 'none',
    captions: true,
    slowMo: SLOW_MO,
    viewport: CANVAS,
    videoSize: CANVAS,
    videoDir: videoDir(14, 'bob'),
  });
  const popup = await deviceBob.popup();
  await expectCaptions(popup);
  await scene(popup, 8, 'The other side', {
    sub: 'A different device, a different phrase, the same transaction.',
  });

  await importMnemonic(popup, cfg.bob.mnemonic, cfg.bob.password);
  await waitForLiveScan(popup, 150_000);
  const balance = parseBtqAmount((await popup.getByTestId('balance').innerText()).trim());
  expect(balance >= cfg.amountSats, "Bob's balance does not cover the payment Alice just made").toBe(
    true,
  );
  await dwell(popup, 2600);

  await popup.getByTestId('tab-activity').click();
  const row = popup.locator(`[data-testid="activity-row"][data-txid="${sentTxid}"]`);
  await expect(row).toContainText(`+${formatSats(cfg.amountSats)} tBTQ`);
  await expect(row).toContainText(/conf/i);
  await dwell(popup, 3000);

  await popup.close();
  await deviceBob.close();
  deviceBob = undefined;
});

// --------------------------------------------------------------- 9 · reveal

test('scene 9 · the recovery phrase can be read back with the password', async () => {
  test.skip(cfg === null, NOT_LIVE);
  test.skip(cfg !== null && !cfg.reveal, 'BTQ_DEMO_REVEAL=0 — this cut has no reveal scene');
  test.skip(!inCut(9), 'scene 9 is not in BTQ_DEMO_SCENES');
  if (!cfg) return;
  test.setTimeout(180_000);

  const popup = await deviceAlice!.popup();
  await ensureUnlocked(popup, cfg.alice.password);
  await scene(popup, 9, 'Show the recovery phrase', {
    sub: 'Behind the password, and only from this screen.',
  });
  await openSettings(popup);
  await popup.getByTestId('reveal-phrase').click();
  await popup.getByTestId('reveal-pw').fill(cfg.alice.password);
  await expectNoSecret(popup, secrets());
  await popup.getByTestId('reveal-submit').click();

  await expect(popup.getByTestId('seed-word-1')).toBeVisible({ timeout: 60_000 });
  // If this fails, the recording — not the wallet — is what is broken, and it
  // is broken in the one way that must never ship.
  await expectRedacted(popup, SEED_WORDS, 12);
  await note(popup, 'Covered for the recording. On your own screen these are legible.', 3000);
  await dwell(popup, 2600);

  await popup.getByTestId('reveal-hide').click();
  await popup.close();
});

// -------------------------------------------------------------- 10 · connect

test('scene 10 · a site asks for an address, and the grant can be taken back', async () => {
  test.skip(cfg === null, NOT_LIVE);
  test.skip(!inCut(10), 'scene 10 is not in BTQ_DEMO_SCENES');
  if (!cfg) return;
  test.setTimeout(300_000);

  dapp = await startStaticDapp();
  const site = await deviceAlice!.tab(dapp.url);
  await scene(site, 10, 'Connect a site', {
    sub: 'The page can ask. Only the wallet can answer.',
  });
  await expect(site.getByTestId('dapp-out')).toHaveText('provider: window.btq detected');
  await dwell(site, 1600);
  await site.getByTestId('dapp-connect').click();

  const approval = await waitForApprovalPage(deviceAlice!.context, 60_000);
  // The approval window is opened by the service worker, so it inherits the
  // *context* viewport rather than the popup's.
  await approval.setViewportSize(POPUP_VIEWPORT);
  await expect(approval.getByTestId('connect-origin')).toHaveText(dapp.origin);
  await dwell(approval, 2600);
  await approval.getByTestId('connect-approve').click();

  const external = derivedAddresses(cfg.alice.mnemonic, 'external');
  await expect
    .poll(
      async () => {
        const text = ((await site.getByTestId('dapp-out').textContent()) ?? '').trim();
        return external.some((a) => text.includes(a));
      },
      { timeout: 30_000, message: 'the page never printed an address this wallet derives' },
    )
    .toBe(true);
  await dwell(site, 2600);
  await site.close();

  const popup = await deviceAlice!.popup();
  await ensureUnlocked(popup, cfg.alice.password);
  await openSettings(popup);
  await expect(popup.getByTestId('site-row')).toHaveCount(1);
  await expect(popup.getByTestId('site-row')).toContainText(dapp.origin);
  await expectNoSecret(popup, secrets(), { expectsPasswordField: true });
  await dwell(popup, 2200);
  await popup.getByTestId('site-revoke').click();
  await expect(popup.getByTestId('site-row')).toHaveCount(0);
  await dwell(popup, 1600);
  await popup.close();

  const after = await deviceAlice!.tab(dapp.url);
  await after.getByTestId('dapp-accounts').click();
  await expect(after.getByTestId('dapp-out')).toHaveText('[]', { timeout: 30_000 });
  await dwell(after, 2600);
  await after.close();
});
