# What's next

Where Minecraft WebSim WASM Edition stands and what comes after. The engine's own roadmap (Horizon's) is in
[docs/horizon/ROADMAP.md](docs/horizon/ROADMAP.md).

## Works now

- Singleplayer: worlds generate, render, save and load in the browser, kept in its storage.
- Multiplayer through the WebSim room (Open to LAN), with the host checking its guests: reach, flying,
  speed, chat spam, packet floods, names pinned to WebSim accounts.
- The WASM Edition panel: settings, worlds (download and import as zip), mods and packs, credits.
- Resource packs. Shader packs and content mods (beta).
- Sound: effects, ambience, music and records, with the game's own Music & Sounds sliders. Sound files come
  as they are needed (a sound's very first play can be silent while its files arrive).
- Two homes: WebSim, and minecraft.lou15.com with its own plain brand.

## Next

- **Mods with code.** They are WebAssembly components; the page would run them with the browser's own
  engine instead of wasmtime.
- **Far terrain** and the other background workers, once they can run as coroutines between frames.
- **Multiplayer outside WebSim** (minecraft.lou15.com): a relay of its own.
- **Private room traffic.** Room messages reach every member; guests' bytes could be encrypted to the host.
