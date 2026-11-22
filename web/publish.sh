#!/bin/sh
# Publishes the WebSim copy (docs/web.md) in two parts:
#
#   page   the start screen, the game code and the gzipped wasm: no Mojang
#          files, synced to the WebSim project.
#   files  the packed game files (Mojang's): on the locked file host, a
#          Cloudflare Worker (web/files-worker) that serves them only with the
#          access key and only to the page's two copies. Never on a public page.
#   site   the same page on Louis's own domain (SITE_DOMAIN, default
#          minecraft.lou15.com; - to skip), a Worker of static assets.
#   cloud  cloud saves (web/cloud/server.js). On WebSim it is the project's own
#          server, synced with the page. For the site it runs on nc2
#          (CLOUD_URL; web/cloud/deploy-nc2.sh installs it), which also gets
#          the game files (NC2=- to skip).
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
CLOUD_URL=${CLOUD_URL:-https://mc-cloud.lou15.com}

rm -rf "$STAGE"
mkdir -p "$STAGE/page" "$STAGE/files"
cp -R web/page/. "$STAGE/page/"
cp web/dist/horizon.js "$STAGE/page/"
gzip -9 -c web/dist/horizon_bg.wasm > "$STAGE/page/horizon_bg.wasm.gz"
# The sound chunks too: the page fetches them when a sound first plays. Hard
# links where the stage shares the pack's disk (they are 380 MB).
for chunk in "$RAID"/pack/core-*.bin "$RAID"/pack/sound-*.bin; do
  ln "$chunk" "$STAGE/files/" 2>/dev/null || cp "$chunk" "$STAGE/files/"
done
python3 - "$RAID/pack/index.json" "$STAGE/files/index.json" <<'PY'
import json, sys
index = json.load(open(sys.argv[1]))
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
python3 - "$STAGE/page/index.html" "$FILES_URL" "$CLOUD_URL" <<'PY'
import sys
path, url, cloud = sys.argv[1], sys.argv[2], sys.argv[3]
html = open(path).read()
tag = f'<script>globalThis.HORIZON_FILES = "{url}"; globalThis.HORIZON_CLOUD = "{cloud}";</script>\n'
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

# Louis's machine gets the same files, for his own site.
if [ "${NC2:-nc2}" != "-" ]; then
  HOST=${NC2:-nc2} "$REPO/web/cloud/deploy-nc2.sh" files || echo "nc2 did not take the game files: the site uses the locked host"
fi

# WebSim runs server.js beside the page as the project's server (cloud saves).
cp "$REPO/web/cloud/server.js" "$STAGE/page/server.js"
cd "$STAGE/page"
websim-cli projects sync "$PROJECT" --no-open -m "$MESSAGE"
rm "$STAGE/page/server.js"

# The same page on Louis's own site (its plain WASM Edition brand: the page
# picks it from the host), a Worker of static assets only.
SITE_DOMAIN=${SITE_DOMAIN:-minecraft.lou15.com}
if [ "$SITE_DOMAIN" != "-" ]; then
  cat > "$STAGE/site-worker.jsonc" <<JSON
{
  "name": "wasm-edition-site",
  "compatibility_date": "2026-11-01",
  "workers_dev": false,
  "routes": [{ "pattern": "$SITE_DOMAIN", "custom_domain": true }],
  "assets": { "directory": "$STAGE/page", "not_found_handling": "404-page" }
}
JSON
  (cd "$STAGE" && npx -y wrangler@4 deploy -c site-worker.jsonc)
fi
