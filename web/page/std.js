// The page's side of std for the browser build (web/std/sys/horizon_web.rs):
// the clock, the console, the command line and the game's files.
//
// Files: `files` maps an absolute path to its bytes (Uint8Array) or to a
// loader for them. The game sees every listed path at once (the manifest) and
// takes a file's bytes the first time it opens it. What the game writes under
// a kept folder comes back through `fs_persist` / `fs_forget` (boot.js keeps it).

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const state = {
  memory: null,          // the wasm memory, set by boot.js once the module is up
  args: [],              // the game's command line, after the program name
  files: new Map(),      // path -> Uint8Array | () => Uint8Array (synchronous)
  folders: new Set(),    // kept empty folders, "path/"
  onPersist: null,       // (path, bytes) => void
  onForget: null,        // (path) => void
  pending: null,         // bytes measured by the last fs_load / args / manifest call
};

const bytes = (ptr, len) => new Uint8Array(state.memory.buffer, ptr, len);
const text = (ptr, len) => decoder.decode(bytes(ptr, len));
const stage = (data) => { state.pending = data; return data.length; };
const copy = (dst) => { bytes(dst, state.pending.length).set(state.pending); state.pending = null; };

const t0 = Date.now() - performance.now();

export function now_ms() { return performance.now(); }
export function epoch_ms() { return t0 + performance.now(); }

let lastLine = '';
export const lines = [];
export function console(level, ptr, len) {
  state.consoleCalls = (state.consoleCalls || 0) + 1;
  const line = text(ptr, len);
  lastLine = line;
  lines.push(line);
  if (lines.length > 1500) lines.shift();
  (level === 2 ? globalThis.console.error : globalThis.console.log)(line);
  globalThis.horizon?.log?.(line);
}
export function lastConsoleLine() { return lastLine; }

export function args_len() { return stage(encoder.encode(state.args.join('\0'))); }
export function args_copy(dst) { copy(dst); }

export function fs_manifest_len() {
  let out = '';
  for (const [path, value] of state.files) {
    const size = value instanceof Uint8Array ? value.length : (value.size ?? 0);
    out += `${path}\t${size}\n`;
  }
  for (const folder of state.folders) out += `${folder}\t0\n`;
  return stage(encoder.encode(out));
}
export function fs_manifest_copy(dst) { copy(dst); }

export function fs_load(ptr, len) {
  const path = text(ptr, len);
  let value = state.files.get(path);
  if (value === undefined) return -1;
  if (!(value instanceof Uint8Array)) {
    try { value = value(); } catch (e) { globalThis.console.error('Horizon: could not load', path, e); return -1; }
    if (!(value instanceof Uint8Array)) return -1;
    // The game keeps its own copy from now on: drop the page's.
    state.files.set(path, Object.assign(() => undefined, { size: value.length }));
  }
  return stage(value);
}
export function fs_load_copy(dst) { copy(dst); }

export function fs_persist(ptr, len, data, dataLen) {
  const path = text(ptr, len);
  if (path.endsWith('/')) {
    state.folders.add(path);
    state.onPersist?.(path, null);
  } else {
    // Copied out: the wasm memory may move.
    const contents = bytes(data, dataLen).slice();
    state.onPersist?.(path, contents);
  }
}
export function fs_forget(ptr, len) {
  const path = text(ptr, len);
  for (const folder of [...state.folders]) {
    if (folder === path + '/' || folder.startsWith(path + '/')) state.folders.delete(folder);
  }
  state.onForget?.(path);
}

// ---- coroutine threads (web/std/sys/horizon_web.rs) ----
// With JSPI a call into the game can pause and resume later on its own engine
// stack. Each coroutine runs `horizon_thread_main` through
// WebAssembly.promising, on its own shadow stack (`__stack_pointer`, switched
// here); `thread_suspend` pauses it until `thread_wake` or a timeout.
// Coroutines start and resume only from an empty stack (timers and promise
// jobs), where the shadow stack pointer is at its base.
const JSPI = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
const coroutines = new Map();
let stackPointer = null;
let stackBase = 0;
let runThread = null;

// boot.js, once the module is up.
export function useExports(exports) {
  if (!JSPI || !exports.__stack_pointer || !exports.horizon_thread_main) return;
  stackPointer = exports.__stack_pointer;
  stackBase = stackPointer.value;
  runThread = WebAssembly.promising(exports.horizon_thread_main);
}

export function thread_support() { return JSPI ? 1 : 0; }

export function thread_spawn(id, stackTop) {
  coroutines.set(id, { sp: stackTop, woken: false, wake: null, timer: 0 });
  setTimeout(() => {
    stackPointer.value = coroutines.get(id).sp;
    let running;
    try {
      running = runThread(id);
    } finally {
      stackPointer.value = stackBase;
    }
    running.catch((e) => globalThis.console.error(`Horizon: thread ${id} failed`, e));
  }, 0);
}

async function suspend(id, timeout) {
  const co = coroutines.get(id);
  co.sp = stackPointer.value;
  stackPointer.value = stackBase;
  if (timeout === -2) {
    // Finished: never resumes; its stack goes with the promise.
    coroutines.delete(id);
    return new Promise(() => {});
  }
  let woken;
  if (co.woken) {
    co.woken = false;
    woken = await 1;
  } else {
    woken = await new Promise((resolve) => {
      co.wake = resolve;
      if (timeout >= 0) co.timer = setTimeout(() => resolve(0), timeout);
    });
  }
  clearTimeout(co.timer);
  co.wake = null;
  stackPointer.value = co.sp;
  return woken;
}
export const thread_suspend = JSPI ? new WebAssembly.Suspending(suspend) : () => 0;

export function thread_wake(id) {
  const co = coroutines.get(id);
  if (!co) return;
  if (co.wake) {
    const wake = co.wake;
    co.wake = null;
    wake(1);
  } else co.woken = true;
}
