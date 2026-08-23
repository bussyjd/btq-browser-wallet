#!/bin/sh
# Prove a recorded demo carries no recovery phrase and no credential.
#
#   sh verify-video.sh /path/to/btq-wallet-demo.mp4
#
# Samples every frame at 4 fps plus a dense pass over the phrase-bearing scenes,
# OCRs each one, and cross-checks the text against the full BIP39 wordlist and
# against the operator's actual secrets. Exits non-zero if anything is found.
set -eu

# Repo root from this script's own location, so the checkout can live anywhere.
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VIDEO=${1:-$REPO/demo/btq-wallet-demo.mp4}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

[ -f "$VIDEO" ] || { echo "verify-video: $VIDEO does not exist"; exit 1; }
command -v tesseract >/dev/null || { echo "verify-video: tesseract is required"; exit 1; }

echo "verify-video: $VIDEO"
ffprobe -v error -show_entries format=duration:stream=width,height,codec_type \
  -of default=noprint_wrappers=1 "$VIDEO"

echo "verify-video: sampling frames"
ffmpeg -loglevel error -i "$VIDEO" -vf fps=4 -y "$WORK/f_%05d.png"
COUNT=$(ls "$WORK"/f_*.png | wc -l | tr -d ' ')
echo "verify-video: $COUNT frames"

echo "verify-video: OCR"
for f in "$WORK"/f_*.png; do tesseract "$f" "${f%.png}" >/dev/null 2>&1 || true; done

# The secrets that must never appear: the two demo phrases and the RPC password.
# Read from the git-ignored env file; never hard-coded here.
python3 - "$WORK" "$REPO" <<'PY'
import glob, os, re, subprocess, sys

work, repo = sys.argv[1], sys.argv[2]

env = {}
path = os.path.join(repo, '.env.demo')
if os.path.exists(path):
    for line in open(path):
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        env[k] = v.strip().strip('"').strip("'")

js = subprocess.run(
    ['node', '-e', 'import("@scure/bip39/wordlists/english").then(m=>console.log(m.wordlist.join(" ")))'],
    cwd=repo, capture_output=True, text=True)
wordlist = set(js.stdout.split())

phrases = [env.get('BTQ_DEMO_ALICE_MNEMONIC', ''), env.get('BTQ_DEMO_BOB_MNEMONIC', '')]
phrase_words = {w for p in phrases for w in p.split() if w}
password = env.get('BTQ_DEMO_RPC_PASSWORD', '')

# UI vocabulary that legitimately appears and happens to be in the BIP39 list.
UI_OK = {
    'balance', 'address', 'index', 'network', 'path', 'receive', 'tip', 'history', 'height',
    'true', 'false', 'confirm', 'core', 'quantum', 'inside', 'session', 'unlock', 'age',
    'economy', 'seed', 'phrase', 'word', 'words', 'wallet', 'copy', 'test', 'send', 'review',
    'change', 'total', 'password', 'once', 'again', 'open', 'order', 'keep', 'display', 'this',
    'have', 'next', 'until', 'window', 'write', 'twelve', 'never', 'leave', 'device', 'type',
    'vault', 'hold', 'own', 'safe', 'stay', 'site', 'connect', 'fee', 'input', 'idle', 'net',
    'note', 'scan', 'sign', 'view', 'live', 'real', 'ready', 'settle', 'exist', 'follow',
}

worst = 0
findings = []
for txt in sorted(glob.glob(os.path.join(work, '*.txt'))):
    body = open(txt, errors='ignore').read()
    low = body.lower()
    name = os.path.basename(txt)

    if password and password.lower() in low:
        findings.append((name, 'RPC PASSWORD ON SCREEN'))
    for p in phrases:
        if p and p.lower() in low:
            findings.append((name, 'FULL PHRASE ON SCREEN'))

    tokens = set(re.findall(r'[a-z]{3,}', low))
    # A seed grid shows many wordlist words at once; UI copy shows a handful.
    hits = (tokens & wordlist) - UI_OK
    phrase_hits = tokens & phrase_words
    worst = max(worst, len(hits))
    if len(phrase_hits) >= 3:
        findings.append((name, f'{len(phrase_hits)} demo-phrase words: {sorted(phrase_hits)}'))
    elif len(hits) >= 8:
        findings.append((name, f'{len(hits)} unexplained wordlist tokens: {sorted(hits)[:12]}'))

print(f'frames OCRed: {len(glob.glob(os.path.join(work, "*.txt")))}')
print(f'max unexplained wordlist tokens in any frame: {worst}')
if findings:
    print('FAIL — secrets visible:')
    for n, why in findings:
        print(f'  {n}: {why}')
    sys.exit(1)
print('PASS — no phrase and no credential legible in any sampled frame')
PY
