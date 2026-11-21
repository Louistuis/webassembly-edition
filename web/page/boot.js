// Starts Horizon in the page (docs/web.md): fetches the packed game files,
// restores the player's saved files from the browser's storage, then hands
// both to the game through std's file system (std.js) and starts it.
import init, { horizon_start } from './horizon.js';
import * as game from './horizon.js';
import { startNet } from './net.js';
import { state, lines, useExports, counters } from './std.js';
import { RESOURCES, KEPT, session, isBlocked, openStore, readAll, tx } from './store.js';
// The game files: beside the page in tests, or on the locked file host that
// publish.sh names (HORIZON_FILES), which wants the player's access key.
const PACK = new URL(globalThis.HORIZON_FILES || './pack/', import.meta.url);
const LOCKED = Boolean(globalThis.HORIZON_FILES);
const screen = document.getElementById('boot');
const bar = document.getElementById('boot-bar');
const status = document.getElementById('boot-status');

// The first errors, compact (message and the Rust frames that led to it), for debugging.
const errors = [];
const consoleError = console.error.bind(console);
console.error = (...args) => {
  // A panic stops the game for good: say so instead of a frozen picture.
  const first = String(args[0] ?? '');
  if (first.startsWith('panicked at') && !screen.classList.contains('failed')) {
    queueMicrotask(() => globalThis.horizon?.fail?.(`The game stopped because of an error:\n${first.split('\n').slice(0, 2).join(' ')}`));
  }
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
// The game's first frame (the start screen crossfades to it).
let firstFrame = null;
const framed = new Promise((resolve) => { firstFrame = resolve; });
if (globalThis.GPUCanvasContext) {
  const configure = GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure = function (config) {
    return configure.call(this, { ...config, usage: (config.usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.COPY_SRC });
  };
  const current = GPUCanvasContext.prototype.getCurrentTexture;
  GPUCanvasContext.prototype.getCurrentTexture = function () {
    frameTexture = current.call(this);
    firstFrame?.();
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
  counters,
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
    document.documentElement.classList.remove('auto');
    status.textContent = message;
    const shown = document.getElementById('fail-message');
    if (shown) shown.textContent = message;
  },
  log(line) {
    if (screen.classList.contains('playing') && !screen.classList.contains('failed')) {
      status.textContent = line.replace(/^\[\w+\] /, '');
    }
  },
  state,
};

// ---- the player's own files (saves, options), kept between visits (store.js) ----
async function restore(db) {
  const { keys, values } = await readAll(db);
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
    if (!KEPT(path) || isBlocked(path)) return;
    queue.set(path, bytes ?? new Uint8Array(0));
    later();
  };
  state.onForget = (path) => {
    if (!KEPT(path) || isBlocked(path)) return;
    for (const key of [...queue.keys()]) if (key === path || key.startsWith(path + '/')) queue.delete(key);
    queue.set(path, undefined);
    later();
  };
  addEventListener('pagehide', () => { if (timer) { clearTimeout(timer); flush(); } });
}

// ---- the game's files ----
let accessKey = null;
const fetchFile = (name) => fetch(new URL(name, PACK), LOCKED ? { headers: { 'x-access-key': accessKey ?? '' } } : {});

async function fetchChunk(chunk, onBytes) {
  const response = await fetchFile(chunk.name);
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
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } },
};
document.getElementById('fail-retry')?.addEventListener('click', () => location.reload());

// The player's name, as the game allows it: letters, digits and _, 3 to 16.
const cleanName = (text) => String(text).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16).padEnd(3, '_');
const WEBSIM = globalThis.wasmEdition?.websim !== false;

// Inside WebSim: their WebSim name. Elsewhere (plain brand): the name field,
// remembered in this browser. Returns a function read when Play is pressed.
async function player() {
  if (!WEBSIM) {
    const input = document.getElementById('name-input');
    let saved = store.get('horizon.name');
    // A new player gets a suggestion; it is kept once they press Play.
    if (!saved || !/^[A-Za-z0-9_]{3,16}$/.test(saved)) saved = `Player${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
    input.value = saved;
    input.addEventListener('input', () => {
      const clean = input.value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
      if (clean !== input.value) input.value = clean;
      if (clean.length >= 3) store.set('horizon.name', clean);
    });
    input.addEventListener('blur', () => {
      if (input.value.length < 3) input.value = store.get('horizon.name') || saved;
    });
    return () => {
      const name = cleanName(input.value.length >= 3 ? input.value : (store.get('horizon.name') || saved));
      store.set('horizon.name', name);
      return name;
    };
  }
  try {
    const user = await globalThis.websim?.getCurrentUser?.();
    if (user?.username) {
      const name = cleanName(user.username);
      document.getElementById('who-name').textContent = name;
      const avatar = user.avatar_url || user.avatarUrl;
      if (typeof avatar === 'string' && /^https:\/\/[^"'()\\\s]+$/.test(avatar)) {
        document.getElementById('who-avatar').style.backgroundImage = `url("${avatar}")`;
      }
      document.getElementById('who').hidden = false;
      return () => name;
    }
  } catch { /* outside WebSim */ }
  return () => null;
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

// The index, asking for the access key until the file host takes it.
async function fetchIndex() {
  const form = document.getElementById('key');
  const input = document.getElementById('key-input');
  accessKey = store.get('horizon.key');
  for (;;) {
    if (!LOCKED || accessKey) {
      const response = await fetchFile('index.json');
      if (response.ok) {
        if (LOCKED) store.set('horizon.key', accessKey);
        form.hidden = true;
        screen.classList.remove('locked');
        return response.json();
      }
      if (!LOCKED || (response.status !== 401 && response.status !== 403)) {
        throw new Error(`Could not get the game files (${response.status}).`);
      }
      if (!form.hidden) input.setCustomValidity('That key did not work.');
    }
    form.hidden = false;
    screen.classList.add('locked');
    document.documentElement.classList.remove('auto'); // the splash makes room for the key form
    input.reportValidity();
    accessKey = await new Promise((resolve) => form.addEventListener('submit', (e) => {
      e.preventDefault();
      input.setCustomValidity('');
      resolve(input.value.trim());
    }, { once: true }));
  }
}

async function prepare() {
  if (!navigator.gpu) {
    throw new Error('This browser has no WebGPU. Use a current Chrome, Edge or Safari.');
  }
  const index = await fetchIndex();
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
  status.textContent = 'Starting the game';
  return module;
}

async function main() {
  // Everything that does not need the click starts at once, so Play is quick.
  const ready = prepare();
  const nameOf = await player();
  const urlArgs = new URLSearchParams(location.search).get('args');
  // Auto-start (index.html decides; inside WebSim it also needs the WebSim user).
  let auto = urlArgs === null && globalThis.wasmEdition?.autoStart === true;
  if (auto && WEBSIM && !nameOf()) auto = false;
  if (!auto) document.documentElement.classList.remove('auto');
  if (urlArgs === null && !auto) {
    await new Promise((resolve) => playButton.addEventListener('click', resolve, { once: true }));
  }
  try { sessionStorage.removeItem('wasmEdition.menu'); } catch { /* private window */ }
  screen.classList.add('playing');
  const module = await ready;
  if (urlArgs !== null) {
    // Tests: `?args=--world T --creative` replaces the page's own arguments.
    state.args = urlArgs.split(' ').filter(Boolean);
  } else {
    // A distance picked in the edition panel applies once, at this start; after
    // that the game's own Options slider rules. A first start gets 6.
    const picked = Number(store.get('horizon.viewDistance'));
    const options = state.files.get(OPTIONS);
    const known = options instanceof Uint8Array && /^renderDistance:/m.test(new TextDecoder().decode(options));
    if (picked) setViewDistance(picked);
    else if (!known) setViewDistance(6);
    try { localStorage.removeItem('horizon.viewDistance'); } catch { /* private window */ }
    const name = nameOf();
    state.args = name ? ['--name', name] : [];
  }
  // From here the game owns its file list: the edition panel's changes wait for a restart.
  session.started = true;
  const wasm = await init({ module_or_path: module });
  state.memory = wasm.memory;
  useExports(wasm);
  startNet(game, accessKey);
  // Tests drive the game with its agent-control commands (docs/agent-control.md);
  // only test runs (`?args=`) get them, so nothing else on the page can.
  if (urlArgs !== null) {
    globalThis.horizon.command = game.horizon_command;
    globalThis.horizon.replies = game.horizon_replies;
  }
  // The start screen crossfades to the game once its canvas is on the page and
  // has drawn (a couple of frames in, so the first picture is complete).
  new MutationObserver((_, observer) => {
    const canvas = document.querySelector('body > canvas');
    if (!canvas) return;
    observer.disconnect();
    const ready = Promise.race([framed, new Promise((resolve) => setTimeout(resolve, 6000))]);
    ready.then(() => new Promise((resolve) => setTimeout(resolve, 250))).then(() => {
      if (screen.classList.contains('failed')) return;
      screen.classList.add('gone');
      setTimeout(() => { if (!screen.classList.contains('failed')) screen.hidden = true; }, 900);
      canvas.focus();
    });
  }).observe(document.body, { childList: true });
  horizon_start();
}

main().catch((e) => {
  console.error(e);
  globalThis.horizon.fail(e.message || String(e));
});
