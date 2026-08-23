#!/bin/sh
# Stitch the videos the end-to-end suite recorded into one demo.
#
#   RECORD_VIDEO=1 npm run test:e2e     # records demo/raw/<NN-device>/*.webm
#   sh scripts/stitch-demo.sh           # -> demo/btq-wallet-demo.mp4
#   sh scripts/stitch-demo.sh demo/btq-wallet-suite.mp4    # ... or somewhere else
#
# `npm run demo:video` does both. Device directories are numbered so the
# journeys (create/receive/send, then import, then site-connect) concatenate in
# the order the spec walks them.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
RAW="$ROOT/demo/raw"
# Optional first argument: where to write. Two recordings share this script —
# the mocked suite (demo/btq-wallet-suite.mp4) and the live demo — so the
# argument-less invocation stays exactly what it always was.
OUT=${1:-demo/btq-wallet-demo.mp4}
case "$OUT" in
  /*) ;;
  *) OUT="$ROOT/$OUT" ;;
esac

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "stitch-demo: ffmpeg is not installed — install it, or record the screen by hand." >&2
  exit 1
fi
if [ ! -d "$RAW" ]; then
  echo "stitch-demo: no recordings in $RAW — run 'RECORD_VIDEO=1 npm run test:e2e' first." >&2
  exit 1
fi

LIST=$(mktemp)
trap 'rm -f "$LIST"' EXIT

if [ -f "$RAW/order.txt" ]; then
  # The suite records the order its pages were opened; that is the journey order,
  # and it leaves out the context's initial blank page.
  sort -n "$RAW/order.txt" | cut -f2- | while IFS= read -r clip; do
    [ -f "$clip" ] || continue
    printf "file '%s'\n" "$clip" >>"$LIST"
  done
else
  for dir in "$RAW"/*/; do
    [ -d "$dir" ] || continue
    for clip in $(ls -1tr "$dir" | grep '\.webm$' || true); do
      printf "file '%s'\n" "$dir$clip" >>"$LIST"
    done
  done
fi

if [ ! -s "$LIST" ]; then
  echo "stitch-demo: $RAW holds no .webm files — was RECORD_VIDEO=1 set?" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
ffmpeg -y -hide_banner -loglevel error \
  -f concat -safe 0 -i "$LIST" \
  -vf "fps=25,scale=trunc(iw/2)*2:trunc(ih/2)*2" \
  -c:v libx264 -preset veryfast -crf 24 -pix_fmt yuv420p \
  "$OUT"

echo "stitch-demo: wrote $OUT"
