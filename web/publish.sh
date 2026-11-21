#!/bin/sh
# Stages the browser build for WebSim (docs/web.md) and syncs it to the
# PRIVATE project. The stage holds Mojang's files (the pack): it lives on
# Louis-RAID, never in this repository, and only ever goes to a private project.
#
#   web/publish.sh PROJECT_ID "revision message"
#   web/publish.sh - ""            # stage only (tests)
set -eu
cd "$(dirname "$0")/.."
RAID=${RAID:-/Volumes/Louis-RAID/Horizon-Web-Dev}
STAGE=$RAID/websim
PROJECT=${1:?project id}
MESSAGE=${2:-update}

rm -rf "$STAGE"
mkdir -p "$STAGE/pack"
cp -R web/page/. "$STAGE/"
cp web/dist/horizon.js "$STAGE/"
gzip -9 -c web/dist/horizon_bg.wasm > "$STAGE/horizon_bg.wasm.gz"
cp "$RAID"/pack/core-*.bin "$STAGE/pack/"
# Sounds are not published yet (no audio in the browser build); the index
# keeps their entries so the game still sees the files exist.
python3 - "$RAID/pack/index.json" "$STAGE/pack/index.json" <<'PY'
import json, sys
index = json.load(open(sys.argv[1]))
index["chunks"]["sound"] = []
index["wasm"] = "horizon_bg.wasm.gz"
json.dump(index, open(sys.argv[2], "w"), separators=(",", ":"))
PY
du -sh "$STAGE"
[ "$PROJECT" = "-" ] && exit 0
cd "$STAGE"
websim-cli projects sync "$PROJECT" --no-open -m "$MESSAGE"
