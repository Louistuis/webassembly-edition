//! Horizon's browser build (docs/web.md): threads in the page. A thread runs
//! inline at spawn, as a coroutine (sys/horizon_web.rs), or not at all; see
//! `horizon_web::spawn_mode` and the spawn in thread/lifecycle.rs.
use crate::ffi::CStr;
use crate::io;
use crate::num::NonZero;
use crate::sys::horizon_web;
use crate::thread::ThreadInit;
use crate::time::Duration;

/// 0: ran inline, finished; else the coroutine's id.
pub struct Thread(u32);

impl Thread {
    /// A thread that already ran on the calling thread.
    pub fn finished() -> Thread {
        Thread(0)
    }

    pub fn coroutine(init: Box<ThreadInit>, stack: usize) -> Thread {
        Thread(horizon_web::spawn(init, stack))
    }
}

pub const DEFAULT_MIN_STACK_SIZE: usize = 64 * 1024;

impl Thread {
    // unsafe: see thread::Builder::spawn_unchecked for safety requirements
    pub unsafe fn new(_stack: usize, _init: Box<ThreadInit>) -> io::Result<Thread> {
        Err(io::Error::UNSUPPORTED_PLATFORM)
    }

    pub fn join(self) {
        if self.0 != 0 {
            horizon_web::join(self.0);
        }
    }
}

pub fn available_parallelism() -> io::Result<NonZero<usize>> {
    Ok(NonZero::new(1).unwrap())
}

pub fn current_os_id() -> Option<u64> {
    None
}

pub fn yield_now() {
    if horizon_web::running() != 0 {
        horizon_web::pause(0.0);
    }
}

pub fn set_name(_name: &CStr) {}

/// A coroutine gives way while it sleeps; the page's own thread can only wait
/// on the clock (rare: the game never sleeps there).
pub fn sleep(dur: Duration) {
    let end = horizon_web::now() + dur.as_secs_f64() * 1000.0;
    if horizon_web::running() != 0 {
        loop {
            let left = end - horizon_web::now();
            if left <= 0.0 {
                return;
            }
            horizon_web::pause(left);
        }
    }
    while horizon_web::now() < end {}
}
