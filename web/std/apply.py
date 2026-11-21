#!/usr/bin/env python3
"""Builds the browser build's standard library sources (docs/web.md).

wasm32-unknown-unknown's std has no clock, files, console or environment.
This copies the toolchain's library sources (rust-src) to DEST and swaps in
the page-backed versions from web/std/sys/, which the build then compiles
with -Zbuild-std (web/build.sh). Native builds never see any of it.

    python3 web/std/apply.py [DEST]   # default: $HORIZON_WEB_STD or /Volumes/Louis-RAID/Horizon-Web-Dev/std
"""
import os
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
TOOLCHAIN = os.environ.get("HORIZON_WEB_TOOLCHAIN", "1.99.1")


def main():
    dest = pathlib.Path(
        sys.argv[1] if len(sys.argv) > 1
        else os.environ.get("HORIZON_WEB_STD", "/Volumes/Louis-RAID/Horizon-Web-Dev/std")
    )
    sysroot = subprocess.check_output(
        ["rustc", f"+{TOOLCHAIN}", "--print", "sysroot"], text=True
    ).strip()
    src = pathlib.Path(sysroot) / "lib/rustlib/src/rust/library"
    if not src.is_dir():
        sys.exit(f"no rust-src for {TOOLCHAIN}: rustup component add rust-src --toolchain {TOOLCHAIN}")
    lib = dest / "library"
    if lib.exists():
        shutil.rmtree(lib)
    shutil.copytree(src, lib, symlinks=True)
    sysdir = lib / "std/src/sys"

    # The page's imports, then the four replaced platform pieces.
    shutil.copy(HERE / "sys/horizon_web.rs", sysdir / "horizon_web.rs")
    edit(sysdir / "mod.rs", "pub mod args;",
         '#[cfg(all(target_family = "wasm", target_os = "unknown"))]\npub mod horizon_web;\npub mod args;')
    shutil.copy(HERE / "sys/time.rs", sysdir / "time/unsupported.rs")
    shutil.copy(HERE / "sys/env.rs", sysdir / "env/unsupported.rs")
    shutil.copy(HERE / "sys/fs.rs", sysdir / "fs/unsupported.rs")
    shutil.copy(HERE / "sys/args.rs", sysdir / "args/unsupported.rs")

    # stdout and stderr: whole lines to the page's console.
    edit(sysdir / "stdio/unsupported.rs",
         """impl io::Write for Stdout {
    #[inline]
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        Ok(buf.len())
    }

    #[inline]
    fn write_vectored(&mut self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
        let total_len = bufs.iter().map(|b| b.len()).sum();
        Ok(total_len)
    }""",
         """static LINE: crate::sync::Mutex<crate::vec::Vec<u8>> =
    crate::sync::Mutex::new(crate::vec::Vec::new());

impl io::Write for Stdout {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut line = LINE.lock().unwrap_or_else(|e| e.into_inner());
        for &b in buf {
            if b == b'\\n' {
                crate::sys::horizon_web::log(1, &line);
                line.clear();
            } else {
                line.push(b);
            }
        }
        Ok(buf.len())
    }

    fn write_vectored(&mut self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
        let mut total_len = 0;
        for b in bufs {
            total_len += self.write(b)?;
        }
        Ok(total_len)
    }""")

    edit(sysdir / "stdio/unsupported.rs",
         """    #[inline]
    fn write_all(&mut self, _buf: &[u8]) -> io::Result<()> {
        Ok(())
    }

    #[inline]
    fn write_all_vectored(&mut self, _bufs: &mut [IoSlice<'_>]) -> io::Result<()> {
        Ok(())
    }""",
         """    fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
        self.write(buf).map(|_| ())
    }

    fn write_all_vectored(&mut self, bufs: &mut [IoSlice<'_>]) -> io::Result<()> {
        self.write_vectored(bufs).map(|_| ())
    }""")

    # Threads: inline, coroutines (JSPI) or refused (sys/horizon_web.rs), and
    # the locks, condition variables and parking the coroutines wait in.
    shutil.copy(HERE / "sys/thread.rs", sysdir / "thread/unsupported.rs")
    shutil.copy(HERE / "sys/mutex.rs", sysdir / "sync/mutex/no_threads.rs")
    shutil.copy(HERE / "sys/rwlock.rs", sysdir / "sync/rwlock/no_threads.rs")
    shutil.copy(HERE / "sys/condvar.rs", sysdir / "sync/condvar/no_threads.rs")
    shutil.copy(HERE / "sys/parker.rs", sysdir / "sync/thread_parking/unsupported.rs")
    # Each coroutine has its own current thread: swapped in and out.
    edit(lib / "std/src/thread/current.rs",
         """            pub(super) fn set(id: ThreadId) {
                ID.set(Some(id))
            }
""",
         """            pub(super) fn set(id: ThreadId) {
                ID.set(Some(id))
            }

            /// Horizon's browser build: trade the id for a coroutine's (as two halves).
            pub(super) fn horizon_swap_id(saved: &mut [*mut (); 2]) {
                let old = ID.get().map_or(0, |id| id.as_u64().get());
                let new = (saved[0].addr() as u64) | ((saved[1].addr() as u64) << 32);
                ID.set(ThreadId::from_u64(new));
                *saved = [
                    ptr::without_provenance_mut(old as u32 as usize),
                    ptr::without_provenance_mut((old >> 32) as usize),
                ];
            }
""")
    edit(lib / "std/src/thread/current.rs",
         "pub(super) fn set_current(thread: Thread) -> Result<(), Thread> {",
         """/// Horizon's browser build (docs/web.md): trade the current thread's state
/// for a coroutine thread's (sys/horizon_web.rs).
#[cfg(all(target_family = "wasm", target_os = "unknown", not(target_feature = "atomics")))]
pub(crate) fn horizon_swap(saved: &mut [*mut (); 3]) {
    let current = CURRENT.get();
    CURRENT.set(saved[0]);
    saved[0] = current;
    let mut id = [saved[1], saved[2]];
    self::id::horizon_swap_id(&mut id);
    saved[1] = id[0];
    saved[2] = id[1];
}

pub(super) fn set_current(thread: Thread) -> Result<(), Thread> {""")
    edit(lib / "std/src/thread/mod.rs",
         "pub(crate) use current::{current_or_unnamed, current_os_id, drop_current, with_current_name};",
         """pub(crate) use current::{current_or_unnamed, current_os_id, drop_current, with_current_name};
#[cfg(all(target_family = "wasm", target_os = "unknown", not(target_feature = "atomics")))]
pub(crate) use current::horizon_swap;""")
    edit(lib / "std/src/thread/lifecycle.rs",
         "    let init = Box::new(ThreadInit { handle: thread.clone(), rust_start });\n",
         """    let init = Box::new(ThreadInit { handle: thread.clone(), rust_start });

    // Horizon's browser build: no OS threads. Work the caller waits for runs
    // here, now; the network's threads run as coroutines; the game's other
    // long-running loops fail to start (sys/horizon_web.rs, `spawn_mode`).
    #[cfg(all(target_family = "wasm", target_os = "unknown", not(target_feature = "atomics")))]
    match crate::sys::horizon_web::spawn_mode(my_packet.scope.is_some(), thread.name()) {
        crate::sys::horizon_web::Spawn::Inline => {
            let ThreadInit { rust_start, .. } = *init;
            rust_start();
            return Ok(JoinInner { native: imp::Thread::finished(), thread, packet: my_packet });
        }
        crate::sys::horizon_web::Spawn::Coroutine => {
            let native = imp::Thread::coroutine(init, stack_size);
            return Ok(JoinInner { native, thread, packet: my_packet });
        }
        crate::sys::horizon_web::Spawn::Refuse => {}
    }
""")


    # A process id: the page's, fixed for its lifetime (some ids and seeds mix it in).
    edit(sysdir / "process/unsupported.rs",
         'pub fn getpid() -> u32 {\n    panic!("no pids on this platform")\n}',
         'pub fn getpid() -> u32 {\n'
         '    static PID: crate::sync::OnceLock<u32> = crate::sync::OnceLock::new();\n'
         '    *PID.get_or_init(|| (crate::sys::horizon_web::epoch() as u64 % 4_000_000_000) as u32 | 1)\n'
         '}')

    # The working directory the in-memory file system resolves relative paths against.
    edit(sysdir / "paths/unsupported.rs",
         "pub fn getcwd() -> io::Result<PathBuf> {\n    unsupported()\n}",
         "pub fn getcwd() -> io::Result<PathBuf> {\n    Ok(PathBuf::from(crate::sys::fs::CWD))\n}")
    edit(sysdir / "paths/unsupported.rs",
         "pub fn current_exe() -> io::Result<PathBuf> {\n    unsupported()\n}",
         'pub fn current_exe() -> io::Result<PathBuf> {\n    Ok(PathBuf::from("/horizon/horizon-client"))\n}')
    edit(sysdir / "paths/unsupported.rs",
         'pub fn temp_dir() -> PathBuf {\n    panic!("no filesystem on this platform")\n}',
         'pub fn temp_dir() -> PathBuf {\n    PathBuf::from("/tmp")\n}')
    edit(sysdir / "paths/unsupported.rs",
         "pub fn home_dir() -> Option<PathBuf> {\n    None\n}",
         'pub fn home_dir() -> Option<PathBuf> {\n    Some(PathBuf::from(crate::sys::fs::CWD))\n}')
    edit(sysdir / "fs/mod.rs",
         "    _ => {\n        mod unsupported;\n        use unsupported as imp;\n    }",
         "    _ => {\n        mod unsupported;\n        use unsupported as imp;\n        pub use unsupported::CWD;\n    }")
    print(lib)


def edit(path, old, new):
    text = path.read_text()
    if old not in text:
        sys.exit(f"{path}: the text to replace has changed in this toolchain:\n{old}")
    path.write_text(text.replace(old, new, 1))


if __name__ == "__main__":
    main()
