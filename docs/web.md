# Minecraft WebSim WASM Edition: the browser build

The game client compiled to `wasm32-unknown-unknown`, rendering with WebGPU, played in a browser tab.
On WebSim it is *Minecraft WebSim WASM Edition*; on minecraft.lou15.com the same page is *Minecraft WASM
Edition* (the page picks the brand from its host: `wasmEdition.isWebSim()`, `?brand=plain|websim` to force).
It runs the same code as the native client; the differences below are all behind
`cfg(target_arch = "wasm32")` or in `web/`.

## How it fits in a page

| Piece | Where |
|---|---|
| Start screen, boot, browser storage | `web/page/` (`index.html`, `start.css`, `boot.js`, `store.js`) |
| The edition's own pages: settings, mods and packs, worlds, credits | `web/page/edition.js` (`wasmEdition.open(tab, inWorld)`), opened from the game's title screen and options (`crates/horizon-client/src/web_edition.rs`) |
| Logo | `web/page/logo.png`, rendered by `web/brand/logo.py` (only the word "websim" is Comic Sans; the rest is pixel lettering) |
| std for the page: clock, console, files, arguments | `web/std/` (`apply.py` patches the toolchain's library sources, `sys/*.rs` replace four platform modules), `web/page/std.js` (the page's side) |
| Build | `web/build.sh fast` (cargo `-Zbuild-std`, then `wasm-bindgen --target web`) into `web/dist/` |
| Game files | `web/pack.py PREPARED OUT` packs a prepared `.local/horizon-client/26.3` into gzip chunks + `index.json` |
| Tests | `web/test/` (Playwright, headless Chrome with SwiftShader) |
| Publish | `web/publish.sh PROJECT "message"`: WebSim, the locked file host (`web/files-worker/`) and the site Worker on minecraft.lou15.com |

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
- **Guests are not trusted.** Anyone who opens the page is in the room, so a host takes a guest only
  with a proof of the access key (SHA-256 of the key with both members' room ids), under the guest's
  own WebSim name (never the host's), with caps on connections, unread bytes and packets per second
  (500, bursts of 2000). On the host, digging and using items on blocks check reach as vanilla does,
  chat has vanilla's spam throttle and oversized creative stacks are ignored. Flight is not allowed
  (`Hub::strict_movement`): a guest floating in the air for 4 seconds without a way to fly is
  disconnected, as on a dedicated server with allow-flight off, and on foot a guest may cover at most
  1 block a tick (20% more per Speed level) with 60 blocks saved up, or is sent back.
  `web/test/cheats.mjs` flies, dashes and spams as a cheating guest would. Room messages still reach
  every member, so what players send each other is not private from others in the room.
- **The page looks like the game's menus** and gets out of the way: it starts the game by itself once
  the access key is stored and the player has a name (the WebSim user, or a saved name elsewhere), over a
  blurred backdrop of its own with a loading bar; the key, the name, Play (after Quit Game or `?menu=1`)
  and errors are game-style dialogs. The edition's pages open only from the game, blurred over it.
  `web/test/edition.mjs` shoots every state of both brands, `web/test/menu.mjs` clicks from the game into
  the page and back.
- **Menus** show what works in a tab: the title screen has WASM Edition... and Credits where Realms and
  Quit Game are, no Friends (no relay); Multiplayer lists only the room's worlds; Options has WASM Edition
  Settings (graphics, shader packs, mods, extras, controller, and the page's own pages), sound greyed out,
  and "open folder" buttons open the page's upload panel instead.
- **Mods and packs** (beta): files the player adds through the panel land in `horizon-mods/`,
  `resourcepacks/` and `shaderpacks/` and apply on the next start. Content mods load (their resource
  overlay is built from hard links, which the page's file system supports); mods with code don't run (no
  wasmtime in a tab). Horizon's own shader packs compile to WGSL through naga like on desktop.
- **No sound yet.**
- The title screen shows the game's logo, then "websim" (WebSim only) beside the pixel "WASM EDITION"
  banner, our own splashes, and "Minecraft WebSim WASM Edition 26.3" in the corner.

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
WebSim project and the site Worker hold only the page and the code, and the files come from a Cloudflare
Worker that serves them only with the access key and only to the page's two homes (websim.com and
minecraft.lou15.com). WebSim gives a page no proof of who is playing, so the key stays the gate.
