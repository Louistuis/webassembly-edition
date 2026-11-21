//! Horizon's browser build (horizon-web/docs/web.md): what std needs from
//! the page. wasm32-unknown-unknown has no clock, console or files, so the
//! page provides them as the `horizon_std` import module (web/page/std.js).
#![allow(dead_code)]

#[link(wasm_import_module = "horizon_std")]
unsafe extern "C" {
    /// `performance.now()`: milliseconds since the page started, monotonic.
    fn now_ms() -> f64;
    /// `Date.now()` with `performance.now()`'s fraction: Unix milliseconds.
    fn epoch_ms() -> f64;
    /// One line of stdout (`level` 1) or stderr (2) for the console.
    fn console(level: u32, ptr: *const u8, len: usize);
    /// The game's command line, arguments separated by NUL: its length.
    fn args_len() -> usize;
    /// Copies the command line into `dst`.
    fn args_copy(dst: *mut u8);
    /// The game files the page holds, as `path\tsize\n` lines: their length.
    fn fs_manifest_len() -> usize;
    /// Copies the manifest into `dst`.
    fn fs_manifest_copy(dst: *mut u8);
    /// A listed file's bytes: their length, or -1 when the page cannot give them.
    fn fs_load(path: *const u8, path_len: usize) -> isize;
    /// Copies the bytes `fs_load` just measured into `dst`.
    fn fs_load_copy(dst: *mut u8);
    /// A file under a persisted folder changed (`data` is its whole content).
    fn fs_persist(path: *const u8, path_len: usize, data: *const u8, data_len: usize);
    /// A file or folder under a persisted folder was removed.
    fn fs_forget(path: *const u8, path_len: usize);
}

pub fn now() -> f64 {
    unsafe { now_ms() }
}
pub fn epoch() -> f64 {
    unsafe { epoch_ms() }
}
pub fn log(level: u32, text: &[u8]) {
    unsafe { console(level, text.as_ptr(), text.len()) }
}
pub fn args() -> crate::vec::Vec<crate::string::String> {
    let len = unsafe { args_len() };
    let mut out = crate::vec::Vec::with_capacity(len);
    unsafe {
        args_copy(out.as_mut_ptr());
        out.set_len(len);
    }
    out.split(|b| *b == 0)
        .filter(|a| !a.is_empty())
        .map(|a| crate::string::String::from_utf8_lossy(a).into_owned())
        .collect()
}
pub fn manifest() -> crate::vec::Vec<u8> {
    let len = unsafe { fs_manifest_len() };
    let mut out = crate::vec::Vec::with_capacity(len);
    unsafe {
        fs_manifest_copy(out.as_mut_ptr());
        out.set_len(len);
    }
    out
}
pub fn load(path: &str) -> Option<crate::vec::Vec<u8>> {
    let len = unsafe { fs_load(path.as_ptr(), path.len()) };
    if len < 0 {
        return None;
    }
    let len = len as usize;
    let mut out = crate::vec::Vec::with_capacity(len);
    unsafe {
        fs_load_copy(out.as_mut_ptr());
        out.set_len(len);
    }
    Some(out)
}
pub fn persist(path: &str, data: &[u8]) {
    unsafe { fs_persist(path.as_ptr(), path.len(), data.as_ptr(), data.len()) }
}
pub fn forget(path: &str) {
    unsafe { fs_forget(path.as_ptr(), path.len()) }
}

/// The game's long-running threads: loops that serve the game for as long as
/// it runs (network, servers, background workers). The browser build has one
/// thread, so these fail to start, as on any platform without threads, and the
/// game goes on without them (each site handles it). Every other thread is a
/// piece of work the caller waits for, and runs at once, on the calling thread.
const LONG_RUNNING: &[&str] = &[
    "Server thread",
    "Server console handler",
    "horizon-net",
    "horizon-local-conn",
    "horizon-lan-",
    "horizon-control",
    "horizon-ping",
    "horizon-region-writer",
    "horizon-benchmark",
    "Log writer",
    "Heartbeat",
    "Discord presence",
    "Services keys",
    "Chunk decoder",
    "Far terrain",
    "Far sampling",
    "Far decoration",
    "Ring search",
    "occlusion",
    "sound decoder",
    "download-queue",
];

pub fn runs_inline(name: Option<&str>) -> bool {
    match name {
        Some(name) => !LONG_RUNNING.iter().any(|loop_name| name.starts_with(loop_name)),
        None => true,
    }
}
