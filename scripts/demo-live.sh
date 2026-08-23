#!/bin/sh
# Record the live demo: the built extension against the real explorer and a real
# BTQ Core node, paced for a human and captioned.
#
#   npm run demo:live            # -> demo/btq-wallet-demo.mp4
#
# The operator's credentials come from a git-ignored ./.env.demo (or from the
# environment). Nothing here has a default password, and nothing here prints one:
#
#   BTQ_DEMO_RPC_PASSWORD=…      the node's RPC password        (required)
#   BTQ_DEMO_ALICE_MNEMONIC=…    the funded wallet's phrase     (required)
#   BTQ_DEMO_BOB_MNEMONIC=…      the receiving wallet's phrase  (required)
#   BTQ_DEMO_NODE_URL=…          default http://127.0.0.1:18432
#   BTQ_DEMO_NODE_USER=…         default btqwallet
#   BTQ_DEMO_AMOUNT=…            default 0.02 (tBTQ)
#   BTQ_DEMO_REVEAL=0            record without the reveal scene
#   BTQ_DEMO_SCENES=1,2,3        record only these scenes
#   BTQ_DEMO_CONFIRM_TIMEOUT_MS  default 420000 — raise it on a quiet testnet
#
# `set -eu` is the safety rail: a refused preflight or a failed take never
# reaches the stitcher, so a broken run cannot overwrite a good video.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

if [ -f ./.env.demo ]; then
  echo "demo:live — reading ./.env.demo"
  set -a
  . ./.env.demo
  set +a
fi

BTQ_LIVE=1
RECORD_VIDEO=1
export BTQ_LIVE RECORD_VIDEO

# Before the build: a dead node or an empty wallet costs three seconds, not ninety.
echo "demo:live — preflight"
npx tsx scripts/demo-preflight.ts

# global-setup builds dist/ for this run. SKIP_BUILD is deliberately never set:
# the one thing worse than no video is a video of yesterday's build.
echo "demo:live — recording"
npx playwright test tests/e2e/live.spec.ts

sh scripts/stitch-demo.sh demo/btq-wallet-demo.mp4
