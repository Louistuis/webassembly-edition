//! Horizon's browser build (docs/web.md): a condition variable for the
//! coroutine threads (sys/horizon_web.rs). The page's own thread cannot wait.
use crate::cell::UnsafeCell;
use crate::sys::horizon_web;
use crate::sys::sync::Mutex;
use crate::thread::sleep;
use crate::time::Duration;

pub struct Condvar {
    waiters: UnsafeCell<crate::vec::Vec<u32>>,
}

unsafe impl Send for Condvar {}
unsafe impl Sync for Condvar {} // one thread runs at a time

impl Condvar {
    #[inline]
    pub const fn new() -> Condvar {
        Condvar { waiters: UnsafeCell::new(crate::vec::Vec::new()) }
    }

    fn waiters(&self) -> &mut crate::vec::Vec<u32> {
        unsafe { &mut *self.waiters.get() }
    }

    pub fn notify_one(&self) {
        let waiters = self.waiters();
        if !waiters.is_empty() {
            horizon_web::wake(waiters.remove(0));
        }
    }

    pub fn notify_all(&self) {
        for id in crate::mem::take(self.waiters()) {
            horizon_web::wake(id);
        }
    }

    /// Whether `me` was still waiting (nobody notified it): then no longer.
    fn forget(&self, me: u32) -> bool {
        let waiters = self.waiters();
        match waiters.iter().position(|&w| w == me) {
            Some(i) => {
                waiters.remove(i);
                true
            }
            None => false,
        }
    }

    pub unsafe fn wait(&self, mutex: &Mutex) {
        let me = horizon_web::running();
        if me == 0 {
            panic!("Horizon web: the page's own thread waits on a condition variable");
        }
        self.waiters().push(me);
        unsafe { mutex.unlock() };
        horizon_web::pause(-1.0);
        self.forget(me);
        mutex.lock();
    }

    pub unsafe fn wait_timeout(&self, mutex: &Mutex, dur: Duration) -> bool {
        let me = horizon_web::running();
        if me == 0 {
            sleep(dur);
            return false;
        }
        self.waiters().push(me);
        unsafe { mutex.unlock() };
        horizon_web::pause(dur.as_secs_f64() * 1000.0);
        let timed_out = self.forget(me);
        mutex.lock();
        !timed_out
    }
}
