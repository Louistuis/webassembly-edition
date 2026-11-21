#!/bin/sh
# The browser build (docs/web.md): the game as wasm, then wasm-bindgen's glue,
# into web/dist/ beside the page (web/page/). The game files themselves are packed
# separately (web/pack.py) and never go in this repository.
#
#   web/build.sh [profile]      # default: fast (release without LTO); "release" for the shipped one
set -eu
cd "$(dirname "$0")/.."
PROFILE="${1:-fast}"
RAID=/Volumes/Louis-RAID/Horizon-Web-Dev
export HORIZON_WEB_STD="${HORIZON_WEB_STD:-$RAID/std}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$RAID/target-std}"
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-1.99.1}"
# Cargo treats the standard library as an outside package and never notices a
# change to it: rebuild it whenever web/std changes.
STAMP=$(cat web/std/apply.py web/std/sys/*.rs | shasum | cut -c1-16)
if [ "$(cat "$HORIZON_WEB_STD/stamp" 2>/dev/null)" != "$STAMP" ]; then
  python3 web/std/apply.py "$HORIZON_WEB_STD"
  for p in fast release dev; do
    rm -rf "$CARGO_TARGET_DIR/wasm32-unknown-unknown/$p/.fingerprint/std-"* \
           "$CARGO_TARGET_DIR/wasm32-unknown-unknown/$p/deps/libstd-"*
  done
  echo "$STAMP" > "$HORIZON_WEB_STD/stamp"
fi
RUSTC_BOOTSTRAP=1 __CARGO_TESTS_ONLY_SRC_ROOT="$HORIZON_WEB_STD/library" \
  cargo build -Zbuild-std=std,panic_abort --profile "$PROFILE" \
  -p horizon-client --bin horizon-client --target wasm32-unknown-unknown --no-default-features
mkdir -p web/dist
wasm-bindgen --target web --no-typescript --out-dir web/dist --out-name horizon \
  "$CARGO_TARGET_DIR/wasm32-unknown-unknown/$PROFILE/horizon-client.wasm"
cp web/page/* web/dist/
ls -la web/dist
