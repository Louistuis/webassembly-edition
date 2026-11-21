#!/bin/sh
# Publishes the WebSim copy (docs/web.md) in two parts:
#
#   page   the start screen, the game code and the gzipped wasm: no Mojang
#          files, synced to the WebSim project.
#   files  the packed game files (Mojang's): on the locked file host, a
#          Cloudflare Worker (web/files-worker) that serves them only with the
#          access key and only to websim.com pages. Never on a public page.
#
# Both stages live on Louis-RAID, never in this repository. The access key is
# made once, in .local/websim-access-key (git-ignored).
#
#   web/publish.sh PROJECT_ID "revision message"
#   web/publish.sh - ""            # stage only (tests: the page reads ./pack/)
set -eu
cd "$(dirname "$0")/.."
REPO=$PWD
RAID=${RAID:-/Volumes/Louis-RAID/Horizon-Web-Dev}
STAGE=$RAID/websim
PROJECT=${1:?project id, or - to stage only}
MESSAGE=${2:-update}
WORKER=wasm-edition-files
FILES_URL=${FILES_URL:-https://wasm-edition-files.nc-status.workers.dev/}

rm -rf "$STAGE"
mkdir -p "$STAGE/page" "$STAGE/files"
cp -R web/page/. "$STAGE/page/"
cp web/dist/horizon.js "$STAGE/page/"
gzip -9 -c web/dist/horizon_bg.wasm > "$STAGE/page/horizon_bg.wasm.gz"
cp "$RAID"/pack/core-*.bin "$STAGE/files/"
# Sounds are not published yet (no audio in the browser build); the index
# keeps their entries so the game still sees the files exist.
python3 - "$RAID/pack/index.json" "$STAGE/files/index.json" <<'PY'
import json, sys
index = json.load(open(sys.argv[1]))
index["chunks"]["sound"] = []
index["wasm"] = "horizon_bg.wasm.gz"
json.dump(index, open(sys.argv[2], "w"), separators=(",", ":"))
PY
du -sh "$STAGE/page" "$STAGE/files"

if [ "$PROJECT" = "-" ]; then
  # Tests serve the page with the files beside it, unlocked.
  ln -s ../files "$STAGE/page/pack"
  exit 0
fi

# The page learns where the files are.
python3 - "$STAGE/page/index.html" "$FILES_URL" <<'PY'
import sys
path, url = sys.argv[1], sys.argv[2]
html = open(path).read()
tag = f'<script>globalThis.HORIZON_FILES = "{url}";</script>\n'
html = html.replace('<script type="importmap">', tag + '<script type="importmap">', 1)
open(path, "w").write(html)
PY

# The locked file host.
KEY_FILE=$REPO/.local/websim-access-key
if [ ! -s "$KEY_FILE" ]; then
  mkdir -p "$REPO/.local"
  python3 -c 'import secrets; print(secrets.token_urlsafe(18))' > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  NEW_KEY=1
fi
cat > "$STAGE/files-worker.jsonc" <<JSON
{
  "name": "$WORKER",
  "main": "$REPO/web/files-worker/worker.js",
  "compatibility_date": "2026-11-01",
  "workers_dev": true,
  "assets": { "directory": "$STAGE/files", "binding": "ASSETS", "run_worker_first": true }
}
JSON
(cd "$STAGE" && npx -y wrangler@4 deploy -c files-worker.jsonc)
if [ "${NEW_KEY:-0}" = 1 ]; then
  (cd "$STAGE" && tr -d '\n' < "$KEY_FILE" | npx -y wrangler@4 secret put ACCESS_KEY -c files-worker.jsonc)
fi

cd "$STAGE/page"
websim-cli projects sync "$PROJECT" --no-open -m "$MESSAGE"
