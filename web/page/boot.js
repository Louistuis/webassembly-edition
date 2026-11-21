// Starts Horizon in the page (docs/web.md): fetches the packed game files,
// restores the player's saved files from the browser's storage, then hands
// both to the game through std's file system (std.js) and starts it.
import init, { horizon_start } from './horizon.js';
import { state } from './std.js';

const RESOURCES = '/horizon/.local/horizon-client/26.3/';
const PACK = new URL(globalThis.HORIZON_PACK || './pack/', import.meta.url);
const screen = document.getElementById('boot');
const bar = document.getElementById('boot-bar');
const status = document.getElementById('boot-status');

// The first errors, compact (message and the Rust frames that led to it), for debugging.
const errors = [];
const consoleError = console.error.bind(console);
console.error = (...args) => {
  if (errors.length < 8) {
    const text = args.map(String).join(' ');
    const frames = text.split('\n').filter((l) => l.includes('.wasm.'))
      .map((l) => l.replace(/^\s*at \S+\.wasm\./, '').replace(/ \(http.*$/, '').replace(/\[[0-9a-f]{16}\]/g, ''))
      .filter((l) => !/panic|backtrace|console_error_panic_hook|rust_begin_unwind|__rust|wbg_new/.test(l));
    errors.push({ message: text.split('\n').slice(0, 3).join(' | '), frames: frames.slice(0, 25) });
  }
  consoleError(...args);
};
// Shader compile errors from the page's WebGPU, with the offending line.
const shaderErrors = [];
if (globalThis.GPUDevice) {
  const create = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (descriptor) {
    const module = create.call(this, descriptor);
    module.getCompilationInfo?.().then((info) => {
      for (const m of info.messages) {
        if (m.type !== 'error' || shaderErrors.length >= 20) continue;
        const line = descriptor.code.split('\n')[m.lineNum - 1] ?? '';
        shaderErrors.push({ label: descriptor.label, line: m.lineNum, message: m.message, code: line.trim().slice(0, 160) });
      }
    });
    return module;
  };
}
globalThis.horizon = {
  errors,
  shaderErrors,
  fail(message) {
    screen.hidden = false;
    screen.classList.add('failed');
    status.textContent = message;
  },
  log(line) {
    if (!screen.hidden && !screen.classList.contains('failed')) status.textContent = line.replace(/^\[\w+\] /, '');
  },
  state,
};

// ---- the player's own files (saves, options), kept between visits ----
const KEPT = (path) => path.startsWith('/horizon/') && !path.startsWith(RESOURCES)
  && !path.startsWith('/horizon/.horizon-cache/') && !path.startsWith('/horizon/logs/');

function openStore() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('horizon-web', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const tx = (db, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction('files', mode);
  const out = fn(t.objectStore('files'));
  t.oncomplete = () => resolve(out?.result);
  t.onerror = () => reject(t.error);
});

async function restore(db) {
  const keys = await tx(db, 'readonly', (s) => s.getAllKeys());
  const values = await tx(db, 'readonly', (s) => s.getAll());
  keys.forEach((path, i) => {
    if (path.endsWith('/')) state.folders.add(path);
    else state.files.set(path, values[i]);
  });
  return keys.length;
}

function keep(db) {
  // Writes are batched: a save writes many files at once.
  const queue = new Map();
  let timer = 0;
  const flush = () => {
    timer = 0;
    const batch = [...queue];
    queue.clear();
    tx(db, 'readwrite', (s) => {
      for (const [path, value] of batch) {
        if (value === undefined) {
          s.delete(IDBKeyRange.bound(path, path + '/￿'));
        } else s.put(value, path);
      }
    }).catch((e) => console.error('Horizon: could not keep files', e));
  };
  const later = () => { if (!timer) timer = setTimeout(flush, 250); };
  state.onPersist = (path, bytes) => {
    if (!KEPT(path)) return;
    queue.set(path, bytes ?? new Uint8Array(0));
    later();
  };
  state.onForget = (path) => {
    if (!KEPT(path)) return;
    for (const key of [...queue.keys()]) if (key === path || key.startsWith(path + '/')) queue.delete(key);
    queue.set(path, undefined);
    later();
  };
  addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); flush(); } });
}

// ---- the game's files ----
async function fetchChunk(chunk, onBytes) {
  const response = await fetch(new URL(chunk.name, PACK));
  if (!response.ok) throw new Error(`${chunk.name}: ${response.status}`);
  let body = response.body;
  if (onBytes) {
    body = body.pipeThrough(new TransformStream({
      transform(part, controller) { onBytes(part.length); controller.enqueue(part); },
    }));
  }
  const raw = body.pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(raw).arrayBuffer());
}

async function loadResources() {
  const index = await (await fetch(new URL('index.json', PACK))).json();
  const core = index.chunks.core;
  const total = core.reduce((n, c) => n + c.size, 0);
  let done = 0;
  const progress = (n) => {
    done += n;
    bar.style.width = `${Math.min(100, (100 * done) / total).toFixed(1)}%`;
    status.textContent = `Loading game files: ${(done / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`;
  };
  const chunks = await Promise.all(core.map((c) => fetchChunk(c, progress)));
  const sounds = new Map();
  for (const [rel, [group, chunk, offset, length]] of Object.entries(index.files)) {
    const loader = group === 'core'
      ? () => chunks[chunk].subarray(offset, offset + length)
      : () => sounds.get(chunk)?.subarray(offset, offset + length);
    state.files.set(RESOURCES + rel, Object.assign(loader, { size: length }));
  }
  return { index, sounds };
}

async function main() {
  if (!navigator.gpu) {
    throw new Error('This browser has no WebGPU. Use a current Chrome, Edge or Safari.');
  }
  let db = null;
  try {
    db = await openStore();
    const kept = await restore(db);
    if (kept) console.log(`Horizon: restored ${kept} saved files`);
    keep(db);
  } catch (e) {
    console.warn('Horizon: no browser storage, worlds will not be kept', e);
  }
  await loadResources();
  status.textContent = 'Starting Horizon';
  state.args = (globalThis.HORIZON_ARGS || []).slice();
  const wasm = await init({ module_or_path: new URL('horizon_bg.wasm', import.meta.url) });
  state.memory = wasm.memory;
  // The loading screen gives way once the game's canvas is on the page.
  new MutationObserver((_, observer) => {
    if (document.querySelector('body > canvas')) {
      observer.disconnect();
      setTimeout(() => { if (!screen.classList.contains('failed')) screen.hidden = true; }, 300);
    }
  }).observe(document.body, { childList: true });
  horizon_start();
}

main().catch((e) => {
  console.error(e);
  globalThis.horizon.fail(e.message || String(e));
});
