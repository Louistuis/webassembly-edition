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
