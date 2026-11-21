//! WASM Edition: what the browser build shows of its own (docs/web.md).
//!
//! On WebSim it is "Minecraft WebSim WASM Edition": the title screen draws the
//! game's own logo, then the "websim" wordmark (`web/page/logo.png`, made by
//! `web/brand/logo.py`, built into the game) beside the pixel "WASM EDITION"
//! banner. Anywhere else (Louis's own site) it is "Minecraft WASM Edition",
//! the logo over the banner alone. Either way it says its own
//! splashes and hands its own pages (settings, mods and packs, worlds, credits)
//! to the page: `wasmEdition.open` in `web/page/edition.js` shows them over the
//! game.
use wasm_bindgen::prelude::wasm_bindgen;

/// The edition's name, as the title screen's corner shows it.
pub fn name() -> &'static str {
    if websim() {
        "Minecraft WebSim WASM Edition"
    } else {
        "Minecraft WASM Edition"
    }
}
/// The logo's atlas sprite.
pub const LOGO: &str = "wasm/logo";
const LOGO_PNG: &[u8] = include_bytes!("../../../web/page/logo.png");

/// The title screen's splashes: the edition's own, not the resources' list
/// (`WEBSIM_SPLASHES` too on WebSim).
pub const SPLASHES: &str = "\
Now in your browser!
Compiled to WebAssembly!
Rust inside!
Built with Claude!
Brought to you by Louis!
WebGPU powered!
No download needed!
Bring a friend!
Runs in a tab!
One frame at a time!
Coroutines on JSPI!
Zero installs!
Saved in your browser!
Shader packs, experimentally!
Wasm all the way down!";
pub const WEBSIM_SPLASHES: &str = "\
Made on WebSim!
Open to LAN, open to the room!
Also try Comic Sans!";

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = wasmEdition, js_name = open, catch)]
    fn js_open(tab: &str, in_world: bool) -> Result<(), wasm_bindgen::JsValue>;
    #[wasm_bindgen(js_namespace = wasmEdition, js_name = isWebSim, catch)]
    fn js_is_websim() -> Result<bool, wasm_bindgen::JsValue>;
    #[wasm_bindgen(js_namespace = wasmEdition, js_name = quit, catch)]
    fn js_quit() -> Result<(), wasm_bindgen::JsValue>;
}

/// Whether this copy runs on WebSim (its branding), asked of the page once.
pub fn websim() -> bool {
    static WEBSIM: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *WEBSIM.get_or_init(|| js_is_websim().unwrap_or(true))
}

/// The splashes this copy says.
pub fn splashes() -> String {
    if websim() {
        format!("{SPLASHES}\n{WEBSIM_SPLASHES}")
    } else {
        SPLASHES.to_owned()
    }
}

/// Show the page's `tab` ('settings', 'packs', 'packs:mods',
/// 'packs:resourcepacks', 'packs:shaderpacks', 'worlds', 'credits') over the
/// game; `in_world` while a world is open (no restarting then).
pub fn open(tab: &str, in_world: bool) {
    if let Err(e) = js_open(tab, in_world) {
        log::warn!("WASM Edition: the page could not open {tab}: {e:?}");
    }
}

/// The logo as an atlas image: name, width, height, RGBA.
pub fn logo() -> Option<(String, u32, u32, Vec<u8>)> {
    let (w, h, rgba) = crate::hud::decode_bytes(LOGO_PNG).ok()?;
    Some((LOGO.to_owned(), w, h, rgba))
}

/// The title screen's Quit Game: back to the page's start screen.
pub fn quit() {
    if let Err(e) = js_quit() {
        log::warn!("WASM Edition: the page could not quit: {e:?}");
    }
}
