//! Horizon's browser build (docs/web.md): std's no-threads read-write lock,
//! where a coroutine thread (sys/horizon_web.rs) waits for a lock another holds.
use crate::cell::Cell;
use crate::sys::horizon_web;

pub struct RwLock {
    // > 0: that many readers; -1: a writer.
    mode: Cell<isize>,
}

unsafe impl Send for RwLock {}
unsafe impl Sync for RwLock {} // one thread runs at a time

impl RwLock {
    #[inline]
    pub const fn new() -> RwLock {
        RwLock { mode: Cell::new(0) }
    }

    #[inline]
    pub fn read(&self) {
        while !self.try_read() {
            horizon_web::wait_for_lock();
        }
    }

    #[inline]
    pub fn try_read(&self) -> bool {
        let m = self.mode.get();
        if m >= 0 && m < isize::MAX {
            self.mode.set(m + 1);
            true
        } else {
            false
        }
    }

    #[inline]
    pub fn write(&self) {
        while !self.try_write() {
            horizon_web::wait_for_lock();
        }
    }

    #[inline]
    pub fn try_write(&self) -> bool {
        if self.mode.get() == 0 {
            self.mode.set(-1);
            true
        } else {
            false
        }
    }

    #[inline]
    pub unsafe fn read_unlock(&self) {
        assert!(self.mode.replace(self.mode.get() - 1) > 0, "rwlock has not been locked for reading");
        horizon_web::lock_freed();
    }

    #[inline]
    pub unsafe fn write_unlock(&self) {
        assert_eq!(self.mode.replace(0), -1, "rwlock has not been locked for writing");
        horizon_web::lock_freed();
    }

    #[inline]
    pub unsafe fn downgrade(&self) {
        assert_eq!(self.mode.replace(1), -1, "rwlock has not been locked for writing");
        horizon_web::lock_freed();
    }
}
