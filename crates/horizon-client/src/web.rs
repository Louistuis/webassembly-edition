//! The browser build (docs/web.md): what the page's start-up needs from the
//! client library. The game itself is the same; std's platform layer
//! (web/std) gives it the page's clock, files and console.

/// Log lines go to the page's console (std's stderr there), formatted as the
/// log file's are.
struct Console;

impl log::Log for Console {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        meta.level() <= log::Level::Info
            && (meta.target().starts_with("horizon") || meta.level() <= log::Level::Warn)
    }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            eprintln!("[{}] {}", record.level(), record.args());
        }
    }
    fn flush(&self) {}
}

static CONSOLE: Console = Console;

/// Logging and panics to the page's console.
pub fn init() {
    console_error_panic_hook::set_once();
    if log::set_logger(&CONSOLE).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }
}

/// Agent-control commands from the page (`horizon.command(line)`, tests): the
/// game answers them between frames as it answers its control socket's.
pub static COMMANDS: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
/// Their replies (JSON), oldest first, for `horizon_replies`.
pub static REPLIES: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_command(line: &str) {
    COMMANDS.lock().unwrap().push(line.to_owned());
}

/// The replies since the last call, one per line.
#[wasm_bindgen::prelude::wasm_bindgen]
pub fn horizon_replies() -> String {
    std::mem::take(&mut *REPLIES.lock().unwrap()).join("\n")
}
