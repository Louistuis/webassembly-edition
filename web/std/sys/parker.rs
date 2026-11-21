//! Horizon's browser build (docs/web.md): thread parking for the coroutine
//! threads (sys/horizon_web.rs). The page's own thread cannot wait for another.
use crate::cell::Cell;
use crate::pin::Pin;
use crate::sys::horizon_web;
use crate::time::Duration;

pub struct Parker {
    notified: Cell<bool>,
    /// The coroutine parked here, if any.
    waiter: Cell<u32>,
}

unsafe impl Send for Parker {}
unsafe impl Sync for Parker {} // one thread runs at a time

impl Parker {
    pub unsafe fn new_in_place(parker: *mut Parker) {
        unsafe { parker.write(Parker { notified: Cell::new(false), waiter: Cell::new(0) }) }
    }

    pub unsafe fn park(self: Pin<&Self>) {
        if self.notified.replace(false) {
            return;
        }
        let me = horizon_web::running();
        if me == 0 {
            panic!("Horizon web: this waits for another thread, which the page's own thread cannot do");
        }
        self.waiter.set(me);
        while !self.notified.replace(false) {
            horizon_web::pause(-1.0);
        }
        self.waiter.set(0);
    }

    pub unsafe fn park_timeout(self: Pin<&Self>, dur: Duration) {
        if self.notified.replace(false) {
            return;
        }
        let me = horizon_web::running();
        if me == 0 {
            return;
        }
        self.waiter.set(me);
        horizon_web::pause(dur.as_secs_f64() * 1000.0);
        self.notified.set(false);
        self.waiter.set(0);
    }

    pub fn unpark(self: Pin<&Self>) {
        self.notified.set(true);
        let waiter = self.waiter.get();
        if waiter != 0 {
            horizon_web::wake(waiter);
        }
    }
}
