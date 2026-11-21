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

    # One thread; sleeping waits on the clock (rare: the game never sleeps on the page's thread).
    edit(sysdir / "thread/unsupported.rs",
         "    Err(io::Error::UNKNOWN_THREAD_COUNT)",
         "    Ok(NonZero::new(1).unwrap())")
    edit(sysdir / "thread/unsupported.rs",
         'pub fn sleep(_dur: Duration) {\n    panic!("can\'t sleep");\n}',
         """pub fn sleep(dur: Duration) {
    let end = crate::sys::horizon_web::now() + dur.as_secs_f64() * 1000.0;
    while crate::sys::horizon_web::now() < end {}
}""")

    # Scoped threads (parallel work the caller waits for) run on the calling
    # thread, at spawn; plain threads still fail to spawn (the game handles each).
    edit(sysdir / "thread/unsupported.rs",
         "pub struct Thread(!);",
         "pub struct Thread(());\n\nimpl Thread {\n    /// A scoped thread that already ran on the calling thread.\n    pub fn finished() -> Thread {\n        Thread(())\n    }\n}")
    edit(sysdir / "thread/unsupported.rs",
         "    pub fn join(self) {\n        self.0\n    }",
         "    pub fn join(self) {}")
    edit(lib / "std/src/thread/lifecycle.rs",
         "    let init = Box::new(ThreadInit { handle: thread.clone(), rust_start });\n",
         """    let init = Box::new(ThreadInit { handle: thread.clone(), rust_start });

    // Horizon's browser build: no threads, so a scoped thread's work runs
    // here, now; the scope then finds it finished.
    #[cfg(all(target_family = "wasm", target_os = "unknown", not(target_feature = "atomics")))]
    if my_packet.scope.is_some() {
        let ThreadInit { rust_start, .. } = *init;
        rust_start();
        return Ok(JoinInner { native: imp::Thread::finished(), thread, packet: my_packet });
    }
""")

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
