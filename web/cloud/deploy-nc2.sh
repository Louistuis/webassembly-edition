#!/bin/sh
# Installs or updates the cloud save server on nc2 (docs/web.md): the code, the
# unit, the access key and the packed game files it hands out to key holders.
# The tunnel's ingress (mc-cloud.lou15.com -> 127.0.0.1:8830) and its DNS name
# are set once, by hand.
#
#   web/cloud/deploy-nc2.sh           # code + game files
#   web/cloud/deploy-nc2.sh files     # game files only (web/publish.sh)
set -eu
cd "$(dirname "$0")/../.."
HOST=${HOST:-nc2}
RAID=${RAID:-/Volumes/Louis-RAID/Horizon-Web-Dev}
DATA=/tank/nordcore-data/wasm-edition
ONLY=${1:-all}

# Mojang's files: only ever on the locked hosts.
ssh "$HOST" "mkdir -p $DATA/pack"
rsync -a --delete --chown=root:wasmedition --chmod=D750,F640 "$RAID/websim/files/" "$HOST:$DATA/pack/"
[ "$ONLY" = files ] && exit 0

ssh "$HOST" "mkdir -p /opt/wasm-edition-cloud /etc/wasm-edition $DATA/pack $DATA/chunks"
rsync -a web/cloud/server.js web/cloud/serve.mjs "$HOST:/opt/wasm-edition-cloud/"
rsync -a web/cloud/wasm-edition-cloud.service "$HOST:/etc/systemd/system/"
ssh "$HOST" 'umask 077; tr -d "\n" > /etc/wasm-edition/access-key' < .local/websim-access-key
ssh "$HOST" "set -e
  id wasmedition >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin wasmedition
  chown root:wasmedition /etc/wasm-edition/access-key && chmod 640 /etc/wasm-edition/access-key
  chown wasmedition:wasmedition $DATA $DATA/chunks
  [ -f $DATA/cloud.sqlite ] && chown wasmedition:wasmedition $DATA/cloud.sqlite* || true
  systemctl daemon-reload
  systemctl enable wasm-edition-cloud >/dev/null 2>&1
  systemctl restart wasm-edition-cloud
  for i in 1 2 3 4 5 6 7 8; do sleep 1; curl -fsS http://127.0.0.1:8830/health 2>/dev/null && break; done; echo ' (cloud saves)'"
