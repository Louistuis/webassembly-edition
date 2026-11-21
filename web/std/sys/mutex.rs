//! Horizon's browser build (docs/web.md): std's no-threads mutex, where a
//! coroutine thread (sys/horizon_web.rs) waits for a lock another holds.
use crate::cell::Cell;
use crate::sys::horizon_web;

pub struct Mutex {
    locked: Cell<bool>,
}

unsafe impl Send for Mutex {}
unsafe impl Sync for Mutex {} // one thread runs at a time

impl Mutex {
    #[inline]
    pub const fn new() -> Mutex {
        Mutex { locked: Cell::new(false) }
    }

    #[inline]
    pub fn lock(&self) {
        while self.locked.replace(true) {
            horizon_web::wait_for_lock();
        }
    }

    #[inline]
    pub unsafe fn unlock(&self) {
        self.locked.set(false);
        horizon_web::lock_freed();
    }

    #[inline]
    pub fn try_lock(&self) -> bool {
        !self.locked.replace(true)
    }
}
