// The WASM Edition panel: Settings, Mods & packs, Worlds and Credits, over the
// start screen or over the game. The game opens it from its own buttons:
//
//   wasmEdition.open(tab, inWorld)  tab: 'settings' | 'packs' | 'packs:mods' |
//                                   'packs:resourcepacks' | 'packs:shaderpacks' |
//                                   'worlds' | 'credits'; inWorld: a world is open
//   wasmEdition.close()
//   wasmEdition.isOpen()
//   wasmEdition.quit()               back to the start card (no auto-start)
//   wasmEdition.websim / wasmEdition.isWebSim()   (set by index.html)
//
// Files live in the browser's storage (store.js). The game reads its file list
// once, at start: before that, changes also go straight into std's file system
// (std.js); after it, they wait for a restart.
import { state } from './std.js';
import {
  KEPT, session, openStore, sizes, readAll, getFile, putFiles, removeTree, clearAll,
} from './store.js';

const edition = (globalThis.wasmEdition ??= {});
const WEBSIM = edition.websim !== false;
if (typeof edition.isWebSim !== 'function') edition.isWebSim = () => WEBSIM;

const MB = 1024 * 1024;
const MAX_PACK = 64 * MB;
const MAX_WORLD = 512 * MB;
const SAVES = '/horizon/saves/';
const SECTIONS = {
  mods: { dir: '/horizon/horizon-mods/', exts: ['.hmod'], title: 'Mods', icon: 'mods', color: 'blue', experimental: true },
  resourcepacks: { dir: '/horizon/resourcepacks/', exts: ['.zip'], title: 'Resource packs', icon: 'paint', color: 'green' },
  shaderpacks: { dir: '/horizon/shaderpacks/', exts: ['.zip', '.hshader'], title: 'Shader packs', icon: 'sun', color: 'yellow', experimental: true },
};

// ---- pixel icons (12x12 maps, '#' = filled) ----
const PIXELS = {
  play: ['..##........', '..####......', '..######....', '..########..', '..##########', '..##########', '..########..', '..######....', '..####......', '..##........'],
  packs: ['............', '############', '############', '............', '.##########.', '.###....###.', '.##########.', '.##########.', '.##########.', '.##########.', '............'],
  worlds: ['.........##.', '........####', '.........##.', '............', '....#.......', '...###......', '..#####..#..', '.#######.##.', '############', '############', '............'],
  settings: ['.....##.....', '..#.####.#..', '.##########.', '..###..###..', '.###....###.', '####....####', '####....####', '.###....###.', '..###..###..', '.##########.', '..#.####.#..', '.....##.....'],
  credits: ['............', '.###....###.', '#####..#####', '############', '############', '############', '.##########.', '..########..', '...######...', '....####....', '.....##.....', '............'],
  close: ['##......##', '###....###', '.###..###.', '..######..', '...####...', '...####...', '..######..', '.###..###.', '###....###', '##......##'],
  upload: ['.....##.....', '....####....', '...######...', '..########..', '.....##.....', '.....##.....', '.....##.....', '.....##.....', '............', '##........##', '############', '############'],
  download: ['.....##.....', '.....##.....', '.....##.....', '.....##.....', '..########..', '...######...', '....####....', '.....##.....', '............', '##........##', '############', '############'],
  trash: ['....####....', '############', '............', '.##########.', '.##.#..#.##.', '.##.#..#.##.', '.##.#..#.##.', '.##.#..#.##.', '.##.#..#.##.', '.##########.', '..########..'],
  mods: ['...##..##...', '...##..##...', '.##########.', '.##########.', '.##......##.', '.##.####.##.', '.##.####.##.', '.##......##.', '.##########.', '.##########.', '...##..##...', '...##..##...'],
  paint: ['.......####.', '......#####.', '.....#####..', '....#####...', '...#####....', '..#####.....', '.#####......', '.####.......', '#####.......', '####........', '###.........', '............'],
  sun: ['.....##.....', '.#...##...#.', '..#......#..', '....####....', '...######...', '##.######.##', '##.######.##', '...######...', '....####....', '..#......#..', '.#...##...#.', '.....##.....'],
  restart: ['....####....', '..########..', '.###....###.', '.##......##.', '##.........#', '##..........', '##......####', '##.......###', '.##......##.', '.###....###.', '..########..', '....####....'],
  key: ['............', '..####......', '.##..##.....', '##....######', '##....######', '.##..##.##.#', '..####..##.#', '............'],
  storage: ['.##########.', '############', '##........##', '############', '.##########.', '............', '.##########.', '############', '##........##', '############', '.##########.'],
  people: ['...##...##..', '..####.####.', '..####.####.', '...##...##..', '............', '.####.#####.', '############', '############', '############'],
  spark: ['.....##.....', '.....##.....', '.....##.....', '....####....', '...######...', '############', '############', '...######...', '....####....', '.....##.....', '.....##.....', '.....##.....'],
  type: ['....####....', '...######...', '..###..###..', '..##....##..', '.###....###.', '.##########.', '.##########.', '###......###', '##........##'],
  eye: ['............', '....####....', '..########..', '.###.##.###.', '###.####.###', '###.####.###', '.###.##.###.', '..########..', '....####....'],
};
export function icon(name) {
  const rows = PIXELS[name];
  if (!rows) return '';
  const w = Math.max(...rows.map((r) => r.length));
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length;) {
      if (row[x] !== '#') { x++; continue; }
      let n = 0;
      while (row[x + n] === '#') n++;
      d += `M${x} ${y}h${n}v1h-${n}z`;
      x += n;
    }
  });
  const pad = (w - rows.length) / 2;
  return `<svg viewBox="0 ${-pad} ${w} ${w}" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`;
}

// ---- small helpers ----
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v; // only ever our own markup
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const button = (label, { kind = 'ghost', size = 'tiny', icon: ic, ...attrs } = {}) => h('button', { type: 'button', class: `btn ${kind} ${size}`, ...attrs, html: `${ic ? icon(ic) : ''}<span></span>` });
const withLabel = (btn, label) => { btn.querySelector('span:last-child').textContent = label; return btn; };
const btn = (label, opts) => withLabel(button(label, opts), label);

export function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * MB) return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
  return `${(bytes / 1024 / MB).toFixed(1)} GB`;
}
const cleanName = (name) => String(name).normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 120) || 'file';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
function when(ms) {
  if (!ms) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days < 1 && date.getDate() === new Date().getDate()) return `today at ${time}`;
  if (days < 2) return `yesterday at ${time}`;
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

// Two-step buttons instead of window.confirm (WebSim's frame may block it).
function confirmButton(label, sure, onConfirm, opts = {}) {
  const b = btn(label, { kind: 'ghost', icon: 'trash', ...opts });
  let armed = 0;
  b.addEventListener('click', async () => {
    if (b.disabled) return;
    if (!armed) {
      withLabel(b, sure);
      b.classList.replace('ghost', 'red');
      armed = setTimeout(() => { armed = 0; withLabel(b, label); b.classList.replace('red', 'ghost'); }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    b.disabled = true;
    await onConfirm();
  });
  return b;
}

// ---- the store, and the game's file system before it starts ----
async function db() {
  try {
    return await openStore();
  } catch {
    throw new Error('This browser is not keeping files for this page (a private window, or storage is blocked).');
  }
}
let dirty = false;
function changed() {
  if (session.started) { dirty = true; showRestart(); }
}
async function writeFiles(entries) {
  await putFiles(await db(), entries);
  if (!session.started) for (const [path, bytes] of entries) state.files.set(path, bytes);
  changed();
}
async function removePath(path, { world = false } = {}) {
  await removeTree(await db(), path);
  if (!session.started) {
    for (const key of [...state.files.keys()]) if (key === path || key.startsWith(`${path}/`)) state.files.delete(key);
    for (const folder of [...state.folders]) if (folder.startsWith(`${path}/`)) state.folders.delete(folder);
  } else if (world) {
    // The game still knows this world until it restarts: what it would write there is dropped.
    session.blocked.add(`${path}/`);
  }
  changed();
}
// Every path a new file or folder could collide with: the store and the game's list.
async function takenNames(dir) {
  const names = new Set();
  const add = (path) => { if (path.startsWith(dir)) names.add(path.slice(dir.length).split('/')[0].toLowerCase()); };
  try { (await sizes(await db(), dir)).forEach((f) => add(f.path)); } catch { /* no store */ }
  for (const key of state.files.keys()) add(key);
  for (const folder of state.folders) add(folder);
  return names;
}

// ---- the panel ----
const TABS = [
  { id: 'settings', label: 'Settings', icon: 'settings', color: 'yellow' },
  { id: 'packs', label: 'Mods & Packs', icon: 'packs', color: 'blue' },
  { id: 'worlds', label: 'Worlds', icon: 'worlds', color: 'green' },
  { id: 'credits', label: 'Credits', icon: 'credits', color: 'red' },
];
const brandMark = () => `<span class="ed-game">Minecraft</span>${WEBSIM
  ? '<img class="ed-logo" src="./logo.png" alt="websim" width="1024" height="256"><span class="ed-edition">WASM Edition</span>'
  : '<span class="ed-edition ed-edition-plain">WASM Edition</span>'}`;

// A screen in the game's own style: a title, a row of tab buttons, the content
// in a dark band between two light lines, and Done at the bottom.
const dialog = h('dialog', { class: 'ed', id: 'wasm-edition', 'aria-labelledby': 'ed-title', tabindex: '-1' });
dialog.innerHTML = `
  <div class="ed-frame">
    <h2 class="ed-title" id="ed-title">WASM Edition</h2>
    <nav class="ed-tabs" role="tablist" aria-label="WASM Edition">
      ${TABS.map((t) => `<button class="btn ed-tab" role="tab" type="button" id="ed-tab-${t.id}" data-tab="${t.id}" aria-controls="ed-panel-${t.id}" aria-selected="false" tabindex="-1">${t.label.replace('&', '&amp;')}</button>`).join('')}
    </nav>
    <div class="ed-body">
      ${TABS.map((t) => `<section class="ed-panel" role="tabpanel" id="ed-panel-${t.id}" aria-labelledby="ed-tab-${t.id}" tabindex="0" hidden></section>`).join('')}
    </div>
    <footer class="ed-foot">
      <div class="ed-restart" id="ed-restart" role="status" hidden></div>
      <button class="btn ed-done" type="button">Done</button>
    </footer>
  </div>`;
const body = dialog.querySelector('.ed-body');
const panels = Object.fromEntries(TABS.map((t) => [t.id, dialog.querySelector(`#ed-panel-${t.id}`)]));
const tabButtons = [...dialog.querySelectorAll('.ed-tab')];
const restartBar = dialog.querySelector('#ed-restart');
const titleEl = dialog.querySelector('#ed-title');
const TITLES = { settings: 'WASM Edition Settings', packs: 'Mods & Packs', worlds: 'Worlds', credits: 'Credits' };
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let inWorld = false;
let current = 'settings';
let returnFocus = null;
let escapeHeld = false;

function select(tab, focusTab = false) {
  current = tab;
  for (const b of tabButtons) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focusTab) b.focus();
  }
  for (const [id, p] of Object.entries(panels)) p.hidden = id !== tab;
  titleEl.textContent = TITLES[tab];
  body.scrollTop = 0;
  return render(tab);
}

function open(tab = 'settings', world = false) {
  const [main, sub] = String(tab || 'settings').split(':');
  const target = TABS.some((t) => t.id === main) ? main : 'settings';
  inWorld = Boolean(world);
  try { document.exitPointerLock?.(); } catch { /* not locked */ }
  clearTimeout(leaving);
  dialog.classList.remove('leaving');
  if (!dialog.open) {
    returnFocus = document.activeElement;
    document.body.append(dialog);
    dialog.showModal();
  }
  showRestart();
  const done = select(target, true);
  if (sub && target === 'packs') {
    done.then(() => {
      const section = panels.packs.querySelector(`[data-section="${sub}"]`);
      if (section) {
        section.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
        section.classList.add('flash');
        setTimeout(() => section.classList.remove('flash'), 1200);
      }
    });
  }
}
// Closing fades out (the game shows through again), then the dialog really closes.
let leaving = 0;
function close() {
  if (!dialog.open || dialog.classList.contains('leaving')) return;
  if (reducedMotion()) { dialog.close(); return; }
  dialog.classList.add('leaving');
  leaving = setTimeout(() => { dialog.classList.remove('leaving'); dialog.close(); }, 180);
}
dialog.addEventListener('close', () => {
  const target = returnFocus;
  returnFocus = null;
  const restore = () => { if (target?.isConnected) target.focus?.({ preventScroll: true }); };
  // Let go of Escape before the game gets focus back, so it never sees half a key press.
  if (escapeHeld) {
    const up = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); removeEventListener('keyup', up, true); escapeHeld = false; restore(); } };
    addEventListener('keyup', up, true);
    setTimeout(() => { if (escapeHeld) { removeEventListener('keyup', up, true); escapeHeld = false; restore(); } }, 600);
  } else restore();
});
dialog.querySelector('.ed-done').addEventListener('click', close);

// While open, the panel takes the keyboard and the mouse: nothing reaches the game.
for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove', 'wheel', 'contextmenu', 'touchstart', 'touchmove', 'touchend']) {
  dialog.addEventListener(type, (e) => e.stopPropagation());
}
for (const type of ['keydown', 'keyup', 'keypress']) {
  addEventListener(type, (e) => {
    if (!dialog.open || dialog.contains(e.target)) return;
    e.stopImmediatePropagation();
    if (type === 'keydown') {
      if (e.key === 'Escape') { escapeHeld = true; close(); } else dialog.focus();
    }
  }, true);
}
dialog.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { escapeHeld = true; e.preventDefault(); close(); return; }
  const i = tabButtons.indexOf(document.activeElement);
  if (i < 0) return;
  const next = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
  if (next) { e.preventDefault(); select(tabButtons[(i + next + tabButtons.length) % tabButtons.length].dataset.tab, true); }
  if (e.key === 'Home') { e.preventDefault(); select(tabButtons[0].dataset.tab, true); }
  if (e.key === 'End') { e.preventDefault(); select(tabButtons.at(-1).dataset.tab, true); }
});
dialog.addEventListener('cancel', (e) => { e.preventDefault(); escapeHeld = true; close(); });
for (const b of tabButtons) b.addEventListener('click', () => select(b.dataset.tab));
// Files dropped anywhere on the panel never navigate the page away.
dialog.addEventListener('dragover', (e) => e.preventDefault());
dialog.addEventListener('drop', (e) => e.preventDefault());

function restartButton() {
  const b = btn('Restart', { kind: 'blue', size: 'small', icon: 'restart', onclick: () => location.reload() });
  if (inWorld) { b.disabled = true; b.title = 'Save and quit to the title screen first.'; }
  return b;
}
function showRestart() {
  restartBar.hidden = !(session.started && dirty);
  if (restartBar.hidden) return;
  restartBar.replaceChildren(
    h('span', { class: 'ed-restart-text' },
      h('strong', {}, 'Restart to apply.'), ' ',
      inWorld ? 'Save and quit to the title screen first.' : 'New mods, packs and worlds load when the game starts.'),
    restartButton(),
  );
}

async function render(tab) {
  const panel = panels[tab];
  try {
    if (tab === 'settings') await renderSettings(panel);
    else if (tab === 'packs') await renderPacks(panel);
    else if (tab === 'worlds') await renderWorlds(panel);
    else if (!panel.firstChild) renderCredits(panel);
  } catch (e) {
    console.warn('WASM Edition panel:', e);
    panel.replaceChildren(h('p', { class: 'ed-error' }, e.message || String(e)));
  }
}

// The screen's title names the tab; each tab opens with one grey line.
const heading = (title, sub) => h('p', { class: 'ed-lead' }, sub);
const card = (attrs, ...children) => h('section', { class: 'ed-card', ...attrs }, ...children);
const cardTitle = (title, ic, color, extra) => h('h3', { class: 'ed-card-title' }, h('span', {}, title), extra);
const chip = (text, kind = 'yellow') => h('span', { class: `ed-chip ${kind}` }, text);
const note = (text) => h('p', { class: 'ed-note' }, text);

// ---- Settings ----
const local = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private window */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* private window */ } },
};

// The game's current render distance, from its saved options.txt.
async function savedDistance() {
  try {
    const bytes = await getFile(await db(), '/horizon/options.txt');
    const m = bytes && new TextDecoder().decode(bytes).match(/^renderDistance:(\d+)/m);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}

async function renderSettings(panel) {
  const pending = Number(local.get('horizon.viewDistance'));
  const distance = pending || (await savedDistance()) || 6;
  const segs = h('div', { class: 'segments', role: 'radiogroup', 'aria-label': 'View distance' },
    [4, 6, 8, 10].map((v) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v === distance), 'data-v': v,
      onclick: () => {
        local.set('horizon.viewDistance', String(v));
        for (const b of segs.children) b.setAttribute('aria-checked', String(Number(b.dataset.v) === v));
        dispatchEvent(new CustomEvent('wasmedition:distance', { detail: v }));
        if (session.started) distanceNote.textContent = 'Saved. It applies the next time the game starts.';
      },
    }, String(v))));
  const distanceNote = note(session.started ? 'Applies the next time the game starts.' : 'How far you can see, in chunks. Lower is smoother on small devices.');

  // Multiplayer.
  const net = globalThis.horizonNet;
  const multiplayer = card({}, cardTitle('Multiplayer', 'people', 'blue'));
  if (!WEBSIM && !net?.id) {
    multiplayer.append(note('Multiplayer works on the WebSim page.'));
  } else {
    const people = net?.people?.() || 0;
    multiplayer.append(
      h('dl', { class: 'ed-facts' },
        h('div', {}, h('dt', {}, 'Your room id'), h('dd', {}, net?.id ? h('code', {}, net.id) : h('span', { class: 'ed-muted' }, 'Appears once the game starts'))),
        h('div', {}, h('dt', {}, 'In the room'), h('dd', {}, net?.id ? plural(people || 1, 'person', 'people') : h('span', { class: 'ed-muted' }, '-')))),
      note('Open your world to LAN from the pause menu; friends on this page see it under Multiplayer.'),
    );
  }

  // Storage.
  const used = h('span', { class: 'ed-muted' }, 'Measuring...');
  const meter = h('div', { class: 'ed-meter' }, h('i'));
  navigator.storage?.estimate?.().then(({ usage = 0, quota = 0 }) => {
    used.textContent = quota ? `${formatSize(usage)} of ${formatSize(quota)} used` : `${formatSize(usage)} used`;
    used.classList.remove('ed-muted');
    meter.firstChild.style.width = `${quota ? Math.max(1.5, Math.min(100, (100 * usage) / quota)) : 0}%`;
  }).catch(() => { used.textContent = 'Not available in this browser'; });
  const wipeBox = h('div', { class: 'ed-confirm', hidden: true });
  const wipe = btn('Delete all saved data', { kind: 'ghost', icon: 'trash', onclick: () => { wipeBox.hidden = false; wipe.hidden = true; wipeBox.querySelector('button')?.focus(); } });
  if (inWorld) { wipe.disabled = true; wipe.title = 'Save and quit to the title screen first.'; }
  wipeBox.append(
    h('p', {}, h('strong', {}, 'Delete everything?'), ' Every world, setting, mod and pack saved in this browser goes away for good. This cannot be undone.'),
    h('div', { class: 'ed-row' },
      btn('Delete everything', { kind: 'red', icon: 'trash', onclick: async (e) => {
        e.currentTarget.disabled = true;
        await wipeAll();
        wipeBox.replaceChildren(h('p', {}, h('strong', {}, 'All saved data is gone.'), session.started ? ' Restart to start fresh.' : ''));
        if (session.started) wipeBox.append(h('div', { class: 'ed-row' }, restartButton()));
        storageAgain();
      } }),
      btn('Cancel', { kind: 'ghost', onclick: () => { wipeBox.hidden = true; wipe.hidden = false; wipe.focus(); } })),
  );
  const storageAgain = () => navigator.storage?.estimate?.().then(({ usage = 0, quota = 0 }) => {
    used.textContent = quota ? `${formatSize(usage)} of ${formatSize(quota)} used` : `${formatSize(usage)} used`;
    meter.firstChild.style.width = `${quota ? Math.max(1.5, Math.min(100, (100 * usage) / quota)) : 0}%`;
  }).catch(() => {});

  // The access key.
  const hasKey = Boolean(local.get('horizon.key'));
  const keyNote = note(hasKey ? 'This browser remembers your access key.' : 'No access key is saved in this browser.');
  const forget = btn('Forget access key', { kind: 'ghost', icon: 'key', disabled: !hasKey, onclick: () => {
    local.remove('horizon.key');
    forget.disabled = true;
    keyNote.textContent = 'Forgotten. You will be asked for it next time.';
  } });

  panel.replaceChildren(
    heading('Settings', 'Saved in this browser.'),
    card({}, cardTitle('View distance', 'eye', 'green'), h('div', { class: 'ed-row spread' }, h('span', { class: 'ed-label' }, 'Chunks'), segs), distanceNote),
    multiplayer,
    card({}, cardTitle('Storage', 'storage', 'yellow'), h('div', { class: 'ed-row spread' }, h('span', { class: 'ed-label' }, 'This page'), used), meter,
      note('Worlds, settings, mods and packs are kept in this browser only. Download a world to keep a copy.'),
      h('div', { class: 'ed-row' }, wipe), wipeBox),
    card({}, cardTitle('Access key', 'key', 'red'), keyNote, h('div', { class: 'ed-row' }, forget)),
    card({}, cardTitle('Restart', 'restart', 'blue'),
      note(inWorld ? 'Save and quit to the title screen first.' : session.started ? 'Starts the game again and picks up your changes.' : 'Nothing to restart yet: the game has not started.'),
      h('div', { class: 'ed-row' }, restartButton())),
  );
}

async function wipeAll() {
  const store = await db();
  if (session.started) session.blocked.add('/horizon/'); // the running game saves nothing more
  await clearAll(store);
  for (const key of ['horizon.viewDistance', 'horizon.name']) local.remove(key);
  dispatchEvent(new CustomEvent('wasmedition:distance', { detail: 6 }));
  if (!session.started) {
    for (const key of [...state.files.keys()]) if (KEPT(key)) state.files.delete(key);
    state.folders.clear();
  }
  changed();
}

// ---- Mods & packs ----
async function listDir(dir) {
  const files = await sizes(await db(), dir);
  const byName = new Map();
  for (const f of files) {
    const name = f.path.slice(dir.length).split('/')[0];
    if (!name) continue;
    const entry = byName.get(name) || { name, size: 0, folder: f.path.slice(dir.length).includes('/') };
    entry.size += f.size;
    byName.set(name, entry);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function renderPacks(panel) {
  const sections = [];
  for (const [id, s] of Object.entries(SECTIONS)) sections.push(await packSection(id, s));
  panel.replaceChildren(
    heading('Mods & packs', 'Add files here, then restart the game to use them.'),
    ...sections,
  );
}

const PACK_TEXT = {
  mods: ['Content mods (new blocks, items, recipes) work. Mods with code don\'t run in the browser yet.', 'After a restart they appear in Options > WASM Edition Settings > Mods, where you turn them on.'],
  resourcepacks: ['Textures, sounds and models that change how the game looks.', 'Choose them in Options > Resource Packs.'],
  shaderpacks: ['Lighting and shadow effects. Some packs won\'t compile for WebGPU.', 'Choose them in Options > WASM Edition Settings > Shader Packs.'],
};

async function packSection(id, s) {
  const entries = await listDir(s.dir);
  const status = h('p', { class: 'ed-status', role: 'status', 'aria-live': 'polite' });
  const input = h('input', { type: 'file', multiple: true, accept: s.exts.join(','), hidden: true });
  const pick = btn('Add files', { kind: s.color === 'yellow' ? 'yellow' : s.color, size: 'small', icon: 'upload', onclick: () => input.click() });
  const section = card({ 'data-section': id, class: 'ed-card ed-drop' },
    cardTitle(s.title, s.icon, s.color, s.experimental ? chip('Experimental') : null),
    note(PACK_TEXT[id][0]),
    h('p', { class: 'ed-where' }, PACK_TEXT[id][1]),
  );
  const list = h('ul', { class: 'ed-files' });
  if (!entries.length) {
    list.append(h('li', { class: 'ed-empty' }, h('span', { class: 'ed-empty-art', html: icon('upload') }),
      h('span', {}, `Nothing here yet. Drop ${s.exts.join(' or ')} files here, or use Add files.`)));
  }
  for (const e of entries) {
    list.append(h('li', {},
      h('span', { class: `ic ${s.color} small`, html: icon(s.icon) }),
      h('span', { class: 'ed-file-name', title: e.name }, e.name),
      h('span', { class: 'ed-file-size' }, formatSize(e.size)),
      confirmButton('Remove', 'Sure?', async () => {
        await removePath(s.dir + e.name);
        await rerenderPacks(`Removed ${e.name}.`, id);
      }, { 'aria-label': `Remove ${e.name}` })));
  }
  const add = async (files) => {
    const good = [];
    const problems = [];
    for (const file of files) {
      const lower = file.name.toLowerCase();
      if (!s.exts.some((x) => lower.endsWith(x))) problems.push(`${file.name} is not a ${s.exts.join(' or ')} file.`);
      else if (file.size > MAX_PACK) problems.push(`${file.name} is over 64 MB.`);
      else good.push(file);
    }
    if (good.length) {
      status.textContent = `Adding ${plural(good.length, 'file')}...`;
      try {
        const entries = [];
        for (const file of good) entries.push([s.dir + cleanName(file.name), new Uint8Array(await file.arrayBuffer())]);
        await writeFiles(entries);
      } catch (e) {
        problems.unshift(`Could not save: ${e.message || e}`);
        good.length = 0;
      }
    }
    const done = good.length ? `Added ${good.length === 1 ? cleanName(good[0].name) : plural(good.length, 'file')}.${session.started ? ' Restart to use it.' : ''}` : '';
    await rerenderPacks([done, ...problems].filter(Boolean).join(' '), id, problems.length > 0);
  };
  input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
  dropTarget(section, add);
  section.append(list, h('div', { class: 'ed-row' }, pick, h('span', { class: 'ed-hint' }, `${s.exts.join(', ')} up to 64 MB`)), input, status);
  return section;
}

async function rerenderPacks(message, id, problem = false) {
  await renderPacks(panels.packs);
  const section = panels.packs.querySelector(`[data-section="${id}"]`);
  const status = section?.querySelector('.ed-status');
  if (status) {
    status.textContent = message;
    status.classList.toggle('bad', problem);
  }
  section?.querySelector('.btn.small')?.focus({ preventScroll: true });
}

function dropTarget(el, onFiles) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; el.classList.add('over'); } });
  el.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) el.classList.remove('over'); });
  el.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    el.classList.remove('over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files);
  });
}

// ---- Worlds ----
// Reads LevelName and LastPlayed out of a level.dat (gzipped NBT) without a full NBT reader.
async function levelInfo(bytes) {
  try {
    let raw = bytes;
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      raw = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    const find = (type, name) => {
      const tag = [type, 0, name.length, ...new TextEncoder().encode(name)];
      outer: for (let i = 0; i + tag.length < raw.length; i++) {
        for (let j = 0; j < tag.length; j++) if (raw[i + j] !== tag[j]) continue outer;
        return i + tag.length;
      }
      return -1;
    };
    const info = {};
    let at = find(8, 'LevelName');
    if (at > 0) {
      const len = (raw[at] << 8) | raw[at + 1];
      info.name = new TextDecoder().decode(raw.subarray(at + 2, at + 2 + Math.min(len, 200)));
    }
    at = find(4, 'LastPlayed');
    if (at > 0) info.lastPlayed = Number(new DataView(raw.buffer, raw.byteOffset + at, 8).getBigInt64(0));
    return info;
  } catch {
    return {};
  }
}

const worldUrls = [];
async function listWorlds() {
  const store = await db();
  const files = await sizes(store, SAVES);
  const worlds = new Map();
  for (const f of files) {
    const folder = f.path.slice(SAVES.length).split('/')[0];
    if (!folder) continue;
    const w = worlds.get(folder) || { folder, size: 0, files: 0, hasLevel: false, hasIcon: false };
    w.size += f.size;
    if (!f.path.endsWith('/')) w.files++;
    if (f.path === `${SAVES}${folder}/level.dat`) w.hasLevel = true;
    if (f.path === `${SAVES}${folder}/icon.png`) w.hasIcon = true;
    worlds.set(folder, w);
  }
  const out = [...worlds.values()];
  await Promise.all(out.map(async (w) => {
    if (w.hasLevel) Object.assign(w, await levelInfo(await getFile(store, `${SAVES}${w.folder}/level.dat`)));
    if (w.hasIcon) {
      const png = await getFile(store, `${SAVES}${w.folder}/icon.png`);
      if (png) { w.icon = URL.createObjectURL(new Blob([png], { type: 'image/png' })); worldUrls.push(w.icon); }
    }
  }));
  return out.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.folder.localeCompare(b.folder));
}

async function renderWorlds(panel, message = '', problem = false) {
  worldUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const worlds = await listWorlds();
  const status = h('p', { class: 'ed-status', role: 'status', 'aria-live': 'polite' }, message);
  status.classList.toggle('bad', problem);
  const input = h('input', { type: 'file', accept: '.zip,application/zip', hidden: true });
  const importBtn = btn('Import a world', { kind: 'green', size: 'small', icon: 'upload', onclick: () => input.click() });
  if (inWorld) { importBtn.disabled = true; importBtn.title = 'Save and quit to the title screen first.'; }
  const doImport = async (files) => {
    if (inWorld) return;
    const file = files[0];
    if (!file) return;
    importBtn.disabled = true;
    status.classList.remove('bad');
    status.textContent = `Reading ${file.name}...`;
    try {
      const name = await importWorld(file);
      await renderWorlds(panel, `Imported "${name}".${session.started ? ' Restart to play it.' : ''}`);
    } catch (e) {
      await renderWorlds(panel, e.message || String(e), true);
    }
  };
  input.addEventListener('change', () => { doImport([...input.files]); input.value = ''; });

  const list = h('ul', { class: 'ed-worlds' });
  if (!worlds.length) {
    list.append(h('li', { class: 'ed-empty' }, h('span', { class: 'ed-empty-art', html: icon('worlds') }),
      h('span', {}, 'No worlds yet. Create one in Singleplayer, or import a world .zip.')));
  }
  for (const w of worlds) {
    const thumb = w.icon
      ? h('img', { class: 'ed-thumb', src: w.icon, alt: '', width: 64, height: 64 })
      : h('span', { class: 'ed-thumb ed-thumb-blank', html: icon('worlds') });
    const title = w.name && w.name !== w.folder ? w.name : w.folder;
    const meta = [w.name && w.name !== w.folder ? w.folder : null, formatSize(w.size), w.lastPlayed ? `played ${when(w.lastPlayed)}` : null].filter(Boolean).join(' · ');
    const download = btn('Download', { kind: 'ghost', icon: 'download', 'aria-label': `Download ${title}`, onclick: async () => {
      download.disabled = true;
      status.classList.remove('bad');
      status.textContent = `Packing ${title}...`;
      try {
        await downloadWorld(w.folder);
        status.textContent = `Downloaded ${w.folder}.zip.`;
      } catch (e) {
        status.textContent = `Could not download: ${e.message || e}`;
        status.classList.add('bad');
      }
      download.disabled = false;
    } });
    const del = confirmButton('Delete', 'Delete forever?', async () => {
      await removePath(`${SAVES}${w.folder}`, { world: true });
      await renderWorlds(panel, `Deleted "${title}".${session.started ? ' The game forgets it when it restarts.' : ''}`);
    }, { 'aria-label': `Delete ${title}` });
    if (inWorld) { del.disabled = true; del.title = 'Save and quit to the title screen first.'; }
    list.append(h('li', {}, thumb,
      h('div', { class: 'ed-world-text' }, h('strong', { title }, title), h('span', {}, meta), !w.hasLevel ? h('span', { class: 'ed-warn' }, 'No level.dat: this may not open.') : null),
      h('div', { class: 'ed-world-actions' }, download, del)));
  }
  const drop = card({ class: 'ed-card ed-drop' },
    cardTitle('Your worlds', 'worlds', 'green', worlds.length ? chip(String(worlds.length), 'plain') : null),
    list,
    h('div', { class: 'ed-row' }, importBtn, h('span', { class: 'ed-hint' }, inWorld ? 'Save and quit to the title screen to import or delete.' : 'A .zip with level.dat inside, up to 512 MB')),
    input, status);
  if (!inWorld) dropTarget(drop, doImport);
  panel.replaceChildren(heading('Worlds', 'Kept in this browser. Download a world to back it up or move it.'), drop);
}

async function downloadWorld(folder) {
  const { keys, values } = await readAll(await db(), `${SAVES}${folder}/`);
  const entries = [];
  keys.forEach((key, i) => {
    const rel = key.slice(SAVES.length);
    if (key.endsWith('/')) entries.push([rel, new Uint8Array(0)]);
    else entries.push([rel, values[i] instanceof Uint8Array ? values[i] : new Uint8Array(values[i] || [])]);
  });
  if (!entries.length) throw new Error('That world has no files.');
  const blob = zip(entries);
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `${folder}.zip`, hidden: true });
  dialog.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function importWorld(file) {
  if (!file.name.toLowerCase().endsWith('.zip')) throw new Error(`${file.name} is not a .zip file.`);
  if (file.size > MAX_WORLD) throw new Error(`${file.name} is over 512 MB.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = readZip(bytes).filter((e) => !e.name.startsWith('__MACOSX/') && !/(^|\/)\._/.test(e.name) && !/(^|\/)\.DS_Store$/.test(e.name));
  // The world's folder: where the shallowest level.dat sits.
  const levels = entries.filter((e) => /(^|\/)level\.dat$/.test(e.name)).sort((a, b) => a.name.split('/').length - b.name.split('/').length);
  if (!levels.length) throw new Error('That .zip has no level.dat, so it is not a world.');
  const root = levels[0].name.slice(0, -'level.dat'.length);
  const base = cleanName((root ? root.slice(0, -1).split('/').pop() : file.name.replace(/\.zip$/i, '')) || 'Imported world').slice(0, 60);
  const taken = await takenNames(SAVES);
  let folder = base;
  for (let n = 2; taken.has(folder.toLowerCase()); n++) folder = `${base} (${n})`;
  const out = [];
  for (const e of entries) {
    if (!e.name.startsWith(root) || e.name.endsWith('/')) continue;
    const rel = e.name.slice(root.length);
    if (!rel || rel.split('/').some((part) => !part || part === '..' || part === '.')) continue;
    out.push([`${SAVES}${folder}/${rel}`, await unzipEntry(bytes, e)]);
  }
  await writeFiles(out);
  return folder;
}

// ---- zip: a store-only writer and a reader (stored or deflated entries) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    parts.push(local, nameBytes, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, data.length, true);
    dir.setUint16(28, nameBytes.length, true);
    dir.setUint32(38, name.endsWith('/') ? 0x10 : 0, true);
    dir.setUint32(42, offset, true);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('That file is not a readable .zip.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new Error('That .zip is too big to read here (zip64).');
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new Error('That .zip looks damaged.');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen)).replace(/\\/g, '/');
    entries.push({ name, method, compressed, size, local });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function unzipEntry(bytes, e) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(e.local, true) !== 0x04034b50) throw new Error(`${e.name}: damaged entry.`);
  const start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
  const data = bytes.subarray(start, start + e.compressed);
  if (e.method === 0) return data.slice();
  if (e.method !== 8) throw new Error(`${e.name} uses a compression this page cannot read.`);
  const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer();
  return new Uint8Array(out);
}

// ---- Credits ----
const MIT = `MIT License

Copyright (c) 2026 Ludovic Marie and the Horizon contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

function renderCredits(panel) {
  // Centred, like the game's own credits: a grey kicker, a white name, grey text.
  const credit = (kicker, title, text, extra) => h('article', { class: 'ed-credit' },
    h('p', { class: 'ed-kicker' }, kicker), h('h3', {}, title), h('p', {}, text), extra);
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const fonts = WEBSIM ? 'Pixelify Sans, and Comic Neue for the websim wordmark. Both under the SIL Open Font License.' : 'Pixelify Sans, under the SIL Open Font License.';
  panel.replaceChildren(
    h('div', { class: 'ed-hero', html: `<div class="ed-hero-mark">${brandMark()}</div>` }),
    h('p', { class: 'ed-hero-line' }, 'A whole block game, compiled to WebAssembly.'),
    credit('Made by', 'Louis', WEBSIM ? 'Designed and put together this edition. Say hi on WebSim: @Louis.' : 'Designed and put together this edition.'),
    credit('Built with', 'Claude', 'Anthropic\'s AI. Claude wrote the browser port together with Louis.'),
    credit('Based on', 'Horizon', 'The open-source game client written in Rust by the horizon-rust contributors. MIT License.',
      h('p', { class: 'ed-link' }, link('https://github.com/horizon-rust/horizon', 'github.com/horizon-rust/horizon'))),
    credit('Fonts', 'Pixel type', fonts),
    h('details', { class: 'ed-license' },
      h('summary', {}, 'Horizon\'s MIT License'),
      // The license's own words; its hard line breaks reflow to the panel's width.
      h('pre', {}, MIT.split('\n\n').map((para) => para.replace(/\n/g, ' ')).join('\n\n'))),
    h('p', { class: 'ed-mojang' }, `Minecraft is a trademark of Mojang. Game files belong to Mojang and are loaded only with an access key. ${WEBSIM ? 'Not affiliated with Mojang, Microsoft or WebSim.' : 'Not affiliated with Mojang or Microsoft.'}`),
  );
}

// ---- wiring ----
Object.assign(edition, {
  open,
  close,
  isOpen: () => dialog.open && !dialog.classList.contains('leaving'),
});
// Pixel icons in the start screen's markup.
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
// The start screen's buttons.
document.addEventListener('click', (e) => {
  const opener = e.target.closest?.('[data-edition]');
  if (opener && !dialog.contains(opener)) open(opener.dataset.edition, false);
});
