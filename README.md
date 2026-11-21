<p align="center">
  <img src="web/page/logo.png" alt="websim" width="420">
</p>

<h1 align="center">Minecraft WebSim WASM Edition</h1>

<p align="center">
  The full block game, compiled to WebAssembly and drawn with WebGPU, running in a browser tab.<br>
  Made by <a href="https://websim.com/@Louis">Louis</a>, built with Claude, on top of the open-source <a href="https://github.com/horizon-rust/horizon">Horizon</a> client.
</p>

<p align="center">
  <a href="https://websim.com/p/yzqcgy6cbgonxa00ekyx"><b>Play on WebSim</b></a> ·
  <a href="https://minecraft.lou15.com"><b>minecraft.lou15.com</b></a> ·
  <a href="docs/web.md"><b>How it works</b></a> ·
  <a href="ROADMAP.md"><b>What's next</b></a> ·
  <a href="#credits"><b>Credits</b></a>
</p>

> Not an official Minecraft product. Not approved by or associated with Mojang, Microsoft or WebSim.
> This repository holds no Mojang code, assets or data.

## What it is

A complete game client, not a remake of a few blocks: worlds generate, render, save and load the way the Java
game does, in survival or creative, with mobs, redstone, crafting, the inventory and the options screens you
know. It is the Horizon client (a Rust rewrite of the game) compiled to `wasm32` and taught to live in a page:

- **Instant play.** Open the page, press Play. Worlds are kept in your browser.
- **Sound.** Effects, ambience, music and records, fetched as they are needed so nobody waits for them.
- **Multiplayer through WebSim.** Open your world to LAN from the pause menu and everyone on the WebSim page
  sees it in their Multiplayer list. The host checks guests the way a server does: reach, flying, speed,
  chat spam, packet floods, and names pinned to WebSim accounts.
- **Your own worlds, mods and packs.** Download a world as a zip, import one, add resource packs, and (beta)
  shader packs and content mods (new blocks, items and recipes) from the WASM Edition panel.
- **Two homes.** On WebSim it is the *Minecraft WebSim WASM Edition*; on minecraft.lou15.com the same page
  calls itself *Minecraft WASM Edition*.

The game's files belong to Mojang and are never public: both pages load them from a locked file host that
only answers with an access key. The page is invite only for that reason.

## Not there yet

Mods with code (only content mods load). Far terrain. Joining real servers (a browser tab opens no
sockets: multiplayer is the WebSim room). The full list is in [ROADMAP.md](ROADMAP.md).

## How it works

The short version: one thread, no shared memory (a WebSim page can't be cross-origin isolated), so the
standard library is patched for the page. Work the game waits for runs where it is asked for; the network's
threads run as coroutines on JSPI, each on its own stack; files are an in-memory tree that the browser's
storage keeps; one GPU frame is in flight at a time. Multiplayer carries the game's own protocol, byte for
byte, through WebSim room messages. All of it is in [docs/web.md](docs/web.md); the browser-only code lives
in `web/` and behind `cfg(target_arch = "wasm32")`.

## Build

```sh
rustup toolchain install 1.99.1 --component rust-src
cargo install wasm-bindgen-cli --version 0.2.130
web/build.sh fast                     # the game, into web/dist/
web/publish.sh - ""                   # stage the page for tests
```

You need the game files prepared from your own copy of the game (see docs/web.md) to run it. Tests run
headless (`web/test/`), away from a small machine's GPU.

## Credits

- **Louis**: the WASM Edition, its design and its direction.
- **Claude** (Anthropic): wrote the browser port with Louis.
- **[Horizon](https://github.com/horizon-rust/horizon)** by Ludovic Marie and the Horizon contributors: the game
  client underneath all of it, MIT licensed. Everything outside `web/` and the `wasm32` paths is theirs; their
  own documentation is still in `docs/`.
- Fonts: Pixelify Sans and Comic Neue (SIL Open Font License); third-party code in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

MIT licensed, see [LICENSE](LICENSE).
