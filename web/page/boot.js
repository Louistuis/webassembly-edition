// Starts Horizon in the page (docs/web.md): fetches the packed game files,
// restores the player's saved files from the browser's storage, then hands
// both to the game through std's file system (std.js) and starts it.
import init, { horizon_start } from './horizon.js';
import { state, lines } from './std.js';

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
// Horizon's shaders are written for the native compiler, which does not apply
// WGSL's derivative-uniformity rule; the browser does. Every module gets the
// standard switch that turns that rule off (the same behaviour as native).
// Compile errors are kept, with the offending line, for debugging.
const UNIFORMITY_OFF = 'diagnostic(off, derivative_uniformity);\n';
const shaderErrors = [];
const shaderSources = {};
if (globalThis.GPUDevice) {
  const create = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (descriptor) {
    if (typeof descriptor.code === 'string' && !descriptor.code.includes('derivative_uniformity')) {
      descriptor = { ...descriptor, code: UNIFORMITY_OFF + descriptor.code };
    }
    shaderSources[descriptor.label ?? ''] = descriptor.code;
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
// `horizon.snapshot()`: the game's picture as a PNG data URL (tests; headless
// screenshots and canvas copies miss WebGPU canvases). The frame's texture is
// copied out through WebGPU itself, just after the game submits it.
let snapshotWaiting = null;
const snapshotDebug = [];
let frameTexture = null;
if (globalThis.GPUCanvasContext) {
  const configure = GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure = function (config) {
    return configure.call(this, { ...config, usage: (config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC });
  };
  const current = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    frameTexture = current.call(this);
    return frameTexture;
  };
}
async function copyFrame(device, texture) {
  const { width, height, format } = texture;
  const row = Math.ceil((width * 4) / 256) * 256;
  const buffer = device.createBuffer({ size: row * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  snapshotDebug.push(`copy ${width}x${height} ${format} usage ${texture.usage}`);
  device.pushErrorScope('validation');
  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: row }, { width, height });
  device.queue.submit([encoder.finish()]);
  device.popErrorScope().then((e) => snapshotDebug.push(`scope: ${e?.message ?? 'ok'}`));
  await buffer.mapAsync(GPUMapMode.READ);
  snapshotDebug.push('mapped');
  const src = new Uint8Array(buffer.getMappedRange());
  const pixels = new Uint8ClampedArray(width * height * 4);
  const bgra = format.startsWith('bgra');
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * row + x * 4, o = (y * width + x) * 4;
      pixels[o] = src[i + (bgra ? 2 : 0)];
      pixels[o + 1] = src[i + 1];
      pixels[o + 2] = src[i + (bgra ? 0 : 2)];
      pixels[o + 3] = 255;
    }
  }
  buffer.unmap();
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas.toDataURL('image/png');
}
let gameDevice = null;
if (globalThis.GPUQueue) {
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (buffers) {
    const out = submit.call(this, buffers);
    if (snapshotWaiting && !snapshotWaiting.queued && frameTexture && gameDevice) {
      snapshotWaiting.queued = true;
      const texture = frameTexture;
      queueMicrotask(() => {
        const { resolve } = snapshotWaiting;
        snapshotWaiting = null;
        copyFrame(gameDevice, texture).then(resolve, (e) => resolve(String(e)));
      });
    }
    return out;
  };
  const createEncoder = GPUDevice.prototype.createCommandEncoder;
  GPUDevice.prototype.createCommandEncoder = function (d) {
    gameDevice = this;
    return createEncoder.call(this, d);
  };
}
globalThis.horizon = {
  snapshotState: () => ({ texture: !!frameTexture, device: !!gameDevice, waiting: !!snapshotWaiting, snapshotDebug }),
  snapshot() {
    return new Promise((resolve) => { snapshotWaiting = { resolve, queued: false }; });
  },
  errors,
  shaderErrors,
  shaderSources,
  lines,
  fail(message) {
    screen.hidden = false;
    screen.classList.remove('gone');
    screen.classList.add('failed');
    status.textContent = message;
  },
  log(line) {
    if (screen.classList.contains('playing') && !screen.classList.contains('failed')) {
      status.textContent = line.replace(/^\[\w+\] /, '');
    }
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

async function loadResources(index) {
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

// ---- the start screen ----
const playButton = document.getElementById('play');
const distance = document.getElementById('distance');
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } },
};
let viewDistance = Number(store.get('horizon.viewDistance')) || 6;
function showDistance() {
  for (const b of distance.querySelectorAll('button')) {
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(Number(b.dataset.v) === viewDistance));
  }
}
distance.addEventListener('click', (e) => {
  const v = Number(e.target?.dataset?.v);
  if (!v) return;
  viewDistance = v;
  store.set('horizon.viewDistance', String(v));
  showDistance();
});
showDistance();

// The player's name: their WebSim name inside WebSim (letters, digits and _ only, as the game allows).
async function player() {
  try {
    const user = await globalThis.websim?.getCurrentUser?.();
    if (user?.username) {
      const name = user.username.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16).padEnd(3, '_');
      document.getElementById('who-name').textContent = name;
      const avatar = user.avatar_url || user.avatarUrl;
      if (avatar) document.getElementById('who-avatar').style.backgroundImage = `url("${avatar}")`;
      document.getElementById('who').hidden = false;
      return name;
    }
  } catch { /* outside WebSim */ }
  return null;
}

// The chosen view distance goes into the game's own options.txt, the file its
// Options screen reads and writes.
const OPTIONS = '/horizon/options.txt';
function setViewDistance(v) {
  const old = state.files.get(OPTIONS);
  let text = old instanceof Uint8Array ? new TextDecoder().decode(old) : '';
  for (const key of ['renderDistance', 'simulationDistance']) {
    const line = `${key}:${key === 'simulationDistance' ? Math.min(v, 8) : v}`;
    text = new RegExp(`^${key}:.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}:.*$`, 'm'), line) : `${text}${line}\n`;
  }
  state.files.set(OPTIONS, new TextEncoder().encode(text));
}

async function prepare() {
  if (!navigator.gpu) {
    throw new Error('This browser has no WebGPU. Use a current Chrome, Edge or Safari.');
  }
  const index = await (await fetch(new URL('index.json', PACK))).json();
  // The game's code compiles while the files load. Published copies keep it
  // gzipped (`wasm` in the index, web/publish.sh).
  const module = (async () => {
    if (!index.wasm) return WebAssembly.compileStreaming(fetch(new URL('horizon_bg.wasm', import.meta.url)));
    const response = await fetch(new URL(index.wasm, import.meta.url));
    if (!response.ok) throw new Error(`${index.wasm}: ${response.status}`);
    const body = response.body.pipeThrough(new DecompressionStream('gzip'));
    return WebAssembly.compileStreaming(new Response(body, { headers: { 'content-type': 'application/wasm' } }));
  })();
  module.catch(() => {});
  let db = null;
  try {
    db = await openStore();
    const kept = await restore(db);
    if (kept) console.log(`Horizon: restored ${kept} saved files`);
    keep(db);
  } catch (e) {
    console.warn('Horizon: no browser storage, worlds will not be kept', e);
  }
  await loadResources(index);
  status.textContent = 'Starting Horizon';
  return module;
}

async function main() {
  // Everything that does not need the click starts at once, so Play is quick.
  const ready = prepare();
  const name = await player();
  const urlArgs = new URLSearchParams(location.search).get('args');
  if (urlArgs === null) {
    await new Promise((resolve) => playButton.addEventListener('click', resolve, { once: true }));
  }
  screen.classList.add('playing');
  const module = await ready;
  if (urlArgs !== null) {
    // Tests: `?args=--world T --creative` replaces the page's own arguments.
    state.args = urlArgs.split(' ').filter(Boolean);
  } else {
    setViewDistance(viewDistance);
    state.args = name ? ['--name', name] : [];
  }
  const wasm = await init({ module_or_path: module });
  state.memory = wasm.memory;
  // The start screen gives way once the game's canvas is on the page.
  new MutationObserver((_, observer) => {
    if (document.querySelector('body > canvas')) {
      observer.disconnect();
      setTimeout(() => {
        if (screen.classList.contains('failed')) return;
        screen.classList.add('gone');
        setTimeout(() => { if (!screen.classList.contains('failed')) screen.hidden = true; }, 400);
        document.querySelector('body > canvas').focus();
      }, 300);
    }
  }).observe(document.body, { childList: true });
  horizon_start();
}

main().catch((e) => {
  console.error(e);
  globalThis.horizon.fail(e.message || String(e));
});
