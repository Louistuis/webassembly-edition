//! Horizon: native Rust client for Minecraft Java Edition 26.3 gameplay.
// The browser build exports its start function (wasm-bindgen generates the export).
#![cfg_attr(not(target_arch = "wasm32"), forbid(unsafe_code))]
mod game;

#[cfg(not(target_arch = "wasm32"))]
use horizon_client::{crash, logging};

/// The mod API level this game serves, kept in the program for the launcher
/// to read without running it (`horizon_mods::api_level::MARK`). `main`
/// reads it, so the linker keeps it.
static MOD_API_LEVEL: [u8; 27] = horizon_mods::api_level::MARK;

/// The browser build (docs/web.md): the page calls `horizon_start` once its
/// files and the wasm memory are in place; wasm-bindgen runs `main` earlier,
/// while the module is still being set up, so it does nothing there.
#[cfg(target_arch = "wasm32")]
fn main() {
    let _ = &MOD_API_LEVEL;
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
extern "C" {
    /// The page's error screen (web/page/boot.js).
    #[wasm_bindgen(js_namespace = horizon, js_name = fail)]
    fn page_fail(message: &str);
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_start() {
    horizon_client::web::init();
    wasm_bindgen_futures::spawn_local(async {
        if let Err(error) = game::run_web().await {
            log::error!("Horizon: {error}");
            page_fail(&error.to_string());
        }
    });
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    std::hint::black_box(&MOD_API_LEVEL);
    horizon_client::telemetry::mark_start();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let game_args = args.iter().take_while(|a| *a != "--dedicated");
    let help = game_args.clone().any(|a| a == "--help" || a == "-h");
    // The dedicated server logs in its own folder, as vanilla's does; the game in its home.
    let (home, side, thread) = if args.iter().any(|a| a == "--dedicated") {
        (std::path::PathBuf::from("."), "server", "Server thread")
    } else {
        (logging::game_home(), "client", "Render thread")
    };
    if !help {
        logging::init(&home, thread);
        // The log's first line names the build, so a bug report that carries the log says which one it was.
        log::info!("Horizon {}", crash::version());
        crash::install(home.clone(), side);
    }
    if let Err(error) = game::run() {
        log::error!("Horizon: {error}");
        if !help {
            crash::report_error(&home, side, &*error);
        }
        // Started from Explorer, the console window closes with the game:
        // keep the message on screen until it is read.
        #[cfg(windows)]
        if std::io::IsTerminal::is_terminal(&std::io::stdin()) {
            eprintln!("Press Enter to close.");
            let _ = std::io::stdin().read_line(&mut String::new());
        }
        std::process::exit(1);
    }
    logging::flush();
}
