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

/// The threads that run as coroutines (below) where the browser can pause a
/// call (JSPI): the network's, which spend their time waiting for bytes.
const COROUTINES: &[&str] = &[
    "horizon-net",
    "horizon-local-conn",
    "horizon-lan-accept",
    "horizon-lan-conn",
    "horizon-web-",
];

/// How a new thread runs in the page.
pub enum Spawn {
    /// Now, on the calling thread: work the caller waits for.
    Inline,
    /// As a coroutine thread.
    Coroutine,
    /// Not at all: the spawn fails, as on a platform without threads.
    Refuse,
}

pub fn spawn_mode(scoped: bool, name: Option<&str>) -> Spawn {
    let name = name.unwrap_or("");
    if supported() && (running() != 0 || COROUTINES.iter().any(|c| name.starts_with(c))) {
        // A coroutine's own helpers (a connection's reader and writer) are
        // coroutines too: they wait as much as it does.
        Spawn::Coroutine
    } else if scoped || !LONG_RUNNING.iter().any(|loop_name| name.starts_with(loop_name)) {
        Spawn::Inline
    } else {
        Spawn::Refuse
    }
}

// ---- coroutine threads ----
//
// With JSPI (WebAssembly.Suspending / WebAssembly.promising) a call into the
// game can pause where it waits and resume later, on its own engine stack,
// while the page's thread goes on. Each such thread gets its own shadow stack
// (std.js switches `__stack_pointer`) and its own std thread state (the
// current thread, swapped in and out here). They take turns: one runs at a
// time, and only gives way where it waits (locks, condition variables,
// parking, sleeping, joining). The page's own thread never pauses: where it
// would have to wait for a coroutine, that is a bug, and it panics saying so.

#[link(wasm_import_module = "horizon_std")]
unsafe extern "C" {
    /// 1 when the browser can pause a call (JSPI).
    fn thread_support() -> u32;
    /// Start coroutine `id` soon, with its shadow stack's top at `stack_top`.
    fn thread_spawn(id: u32, stack_top: usize);
    /// Pause coroutine `id` (a JSPI import) until woken or `timeout_ms` passed
    /// (negative: no timeout; -2: never again, the thread finished). 1 when woken.
    fn thread_suspend(id: u32, timeout_ms: f64) -> u32;
    /// Wake coroutine `id` (or have its next pause return at once).
    fn thread_wake(id: u32);
}

struct Coroutine {
    init: Option<crate::boxed::Box<crate::thread::ThreadInit>>,
    /// The thread state of the side not running (see `swap`).
    state: [*mut (); 3],
    /// The shadow stack; freed once the coroutine finished.
    stack: crate::vec::Vec<u8>,
    finished: bool,
    /// A coroutine waiting in `join` for this one.
    joiner: u32,
}

struct Shared<T>(crate::cell::UnsafeCell<T>);
unsafe impl<T> Sync for Shared<T> {}
impl<T> Shared<T> {
    #[allow(clippy::mut_from_ref)]
    fn get(&self) -> &mut T {
        // One thread at a time, and no reference is kept across a pause.
        unsafe { &mut *self.0.get() }
    }
}

static TABLE: Shared<crate::vec::Vec<*mut Coroutine>> = Shared(crate::cell::UnsafeCell::new(crate::vec::Vec::new()));
static RUNNING: Shared<u32> = Shared(crate::cell::UnsafeCell::new(0));
static SUPPORT: Shared<u8> = Shared(crate::cell::UnsafeCell::new(2));
/// Coroutines waiting for a lock to come free.
static LOCK_WAITERS: Shared<crate::vec::Vec<u32>> = Shared(crate::cell::UnsafeCell::new(crate::vec::Vec::new()));

pub fn supported() -> bool {
    let s = SUPPORT.get();
    if *s == 2 {
        *s = unsafe { thread_support() } as u8;
    }
    *s == 1
}

/// The coroutine running now; 0 for the page's own thread.
pub fn running() -> u32 {
    *RUNNING.get()
}

fn coroutine(id: u32) -> &'static mut Coroutine {
    unsafe { &mut *TABLE.get()[id as usize - 1] }
}

/// The bottom of each shadow stack holds this pattern. wasm has no guard page:
/// a thread that runs past its stack would write over the heap below it, so
/// the pattern is checked every time the thread pauses or ends, and a thread
/// that overwrote it stops the game (better than running on with bad memory).
const GUARD: usize = 4096;
const GUARD_BYTE: u8 = 0xA5;

fn check_guard(id: u32) {
    let stack = &coroutine(id).stack;
    if stack.len() >= GUARD && stack[..GUARD].iter().any(|&b| b != GUARD_BYTE) {
        panic!("Horizon web: thread {id} ran past its stack");
    }
}

pub fn spawn(init: crate::boxed::Box<crate::thread::ThreadInit>, stack_size: usize) -> u32 {
    // Finished coroutines never run again (each paused for good where it
    // ended, before anything else ran): their stacks can go.
    for &co in TABLE.get().iter() {
        let co = unsafe { &mut *co };
        if co.finished && !co.stack.is_empty() {
            co.stack = crate::vec::Vec::new();
        }
    }
    let size = stack_size.max(2 << 20);
    let mut stack = crate::vec::Vec::new();
    stack.resize(size, 0u8);
    stack[..GUARD].fill(GUARD_BYTE);
    let top = (stack.as_ptr() as usize + size) & !15;
    let co = crate::boxed::Box::new(Coroutine {
        init: Some(init),
        state: [crate::ptr::null_mut(); 3],
        stack,
        finished: false,
        joiner: 0,
    });
    let table = TABLE.get();
    table.push(crate::boxed::Box::into_raw(co));
    let id = table.len() as u32;
    unsafe { thread_spawn(id, top) };
    id
}

/// The page starts coroutine `id` here (std.js), on its own stack, through
/// the game's `horizon_thread_main` export (std's own symbols are not exported).
#[unsafe(no_mangle)]
pub extern "C" fn horizon_std_thread_main(id: u32) {
    let co = coroutine(id);
    let init = co.init.take().expect("a coroutine starts once");
    *RUNNING.get() = id;
    // In with no thread state of its own; `init` sets the current thread.
    crate::thread::horizon_swap(&mut co.state);
    let start = init.init();
    start();
    check_guard(id);
    let co = coroutine(id);
    co.finished = true;
    if co.joiner != 0 {
        wake(co.joiner);
    }
    crate::thread::horizon_swap(&mut co.state);
    *RUNNING.get() = 0;
    unsafe { thread_suspend(id, -2.0) };
    unreachable!("a finished coroutine resumed");
}

/// Pause the running coroutine until woken or `timeout_ms` passed (negative:
/// no timeout). Whether it was woken.
pub fn pause(timeout_ms: f64) -> bool {
    let id = running();
    assert!(id != 0, "Horizon web: the page's own thread cannot wait");
    check_guard(id);
    crate::thread::horizon_swap(&mut coroutine(id).state);
    *RUNNING.get() = 0;
    let woken = unsafe { thread_suspend(id, timeout_ms) } != 0;
    *RUNNING.get() = id;
    crate::thread::horizon_swap(&mut coroutine(id).state);
    woken
}

pub fn wake(id: u32) {
    unsafe { thread_wake(id) }
}

/// Wait until coroutine `id` finished.
pub fn join(id: u32) {
    if coroutine(id).finished {
        return;
    }
    let me = running();
    assert!(me != 0, "Horizon web: the page's own thread joins a thread that is still running");
    coroutine(id).joiner = me;
    while !coroutine(id).finished {
        pause(-1.0);
    }
}

pub fn finished(id: u32) -> bool {
    coroutine(id).finished
}

/// A lock is held by someone else: the running coroutine waits for it to
/// come free (the page's own thread cannot).
pub fn wait_for_lock() {
    if running() == 0 {
        panic!("Horizon web: the page's own thread needs a lock that a paused thread holds");
    }
    LOCK_WAITERS.get().push(running());
    pause(-1.0);
}

/// A lock came free: the coroutines waiting for one try again.
#[inline]
pub fn lock_freed() {
    let waiters = LOCK_WAITERS.get();
    if !waiters.is_empty() {
        for id in crate::mem::take(waiters) {
            wake(id);
        }
    }
}
