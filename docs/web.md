# WebAssembly Edition: the browser build

The game client compiled to `wasm32-unknown-unknown`, rendering with WebGPU, played in a browser tab.
It runs the same code as the native client; the differences below are all behind
`cfg(target_arch = "wasm32")` or in `web/`.

## How it fits in a page

| Piece | Where |
|---|---|
| Start screen, boot, browser storage | `web/page/` (`index.html`, `start.css`, `boot.js`) |
| std for the page: clock, console, files, arguments | `web/std/` (`apply.py` patches the toolchain's library sources, `sys/*.rs` replace four platform modules), `web/page/std.js` (the page's side) |
| Build | `web/build.sh fast` (cargo `-Zbuild-std`, then `wasm-bindgen --target web`) into `web/dist/` |
| Game files | `web/pack.py PREPARED OUT` packs a prepared `.local/horizon-client/26.3` into gzip chunks + `index.json` |
| Tests | `web/test/` (Playwright, headless Chrome with SwiftShader) |
| Publish to WebSim | `web/publish.sh PROJECT "message"`; `web/files-worker/` is the locked file host |

## What is different in the browser

- **No OS threads.** A WebSim page cannot be cross-origin isolated, so there is no shared memory. The
  game runs single player in-frame (`server_thread = false`). The page's std decides per spawn
  (`horizon_web::spawn_mode`): work the caller waits for (scoped threads, one-shot helpers) runs on the
  calling thread at spawn; the network's threads (`COROUTINES`) run as **coroutine threads** on JSPI,
  each on its own shadow stack, giving way where they wait (locks, condition variables, parking,
  sleeping, joining; `web/std/sys/{thread,mutex,rwlock,condvar,parker}.rs`, `web/page/std.js`); the
  other long-running loops (`LONG_RUNNING`) fail to spawn and each site goes on without them. The
  page's own thread never waits: where it would, std panics saying so, and the page shows the error.
- **Saving** writes region files on the game's thread (`save.rs`, no writer thread); far terrain is off.
- **Chunk work** runs on an inline worker between frames (`streaming.rs`, `HORIZON_WEB_PUMP_MS`, 12 ms).
- **Files** are an in-memory file system under `/horizon` (the working directory). The packed game files
  are listed up front and read the first time the game opens them. What the game writes outside the
  resources (worlds, `options.txt`) is kept in IndexedDB and restored on the next visit.
- **GPU:** the page opens the device before the game starts (it cannot block), error scopes are polled
  once instead of waited on, every shader gets `diagnostic(off, derivative_uniformity)` (the native
  compiler does not apply that rule), sprite arrays respect the device's texture layer limit, and one
  frame is in flight at a time so frames never pile up on a slow GPU.
- **Memory** is capped at 2 GiB (`.cargo/config.toml`); the start screen offers view distance 4 to 10.
- **Multiplayer** goes through a WebSim room (`web/page/net.js`, `crates/horizon-client/src/web_net.rs`).
  Open to LAN announces the world in the room's presence; every player's Multiplayer screen lists the
  room's worlds (as LAN worlds, address `websim:<member>`); joining connects over the room. The bytes
  are Horizon's own protocol over in-memory pipes, base64 in ordered room messages. `?room=local` uses a
  BroadcastChannel room between tabs instead (tests: `web/test/duo.mjs`).
- **No sound yet.**
- The title screen reads "WASM EDITION" and "WebAssembly Edition 26.3".

## Build and test

```sh
rustup toolchain install 1.99.1 --component rust-src
cargo install wasm-bindgen-cli --version 0.2.130
web/build.sh fast
python3 web/pack.py .local/horizon-client/26.3 "$RAID/pack"   # once per prepared version
```

Test headless, away from your own machine's GPU if it is small (a runaway tab can take a 16 GB Mac
down): `node web/test/run.mjs DIST OUT "--world T --creative" 60` writes `OUT.json` (log lines, errors,
memory) and `OUT-canvas.png` (the frame, read back through WebGPU: plain headless screenshots of a
WebGPU canvas are blank). `start-screen.mjs` shoots the start screen, `live.mjs` the published copy,
`duo.mjs` a host and a guest, `freeze.mjs` plays until the game stops and prints why (the stuck stack,
or the panic). The page takes agent-control commands: `horizon.command('lan open')`, `horizon.replies()`.
Run them under a memory limit, for example `systemd-run --scope -p MemoryMax=3G`.

## Mojang's files

The packed game files are Mojang's. They never go into this repository or onto a public page: the
WebSim project holds only the page and the code, and the files come from a Cloudflare Worker that
serves them only with an access key and only to websim.com pages.
