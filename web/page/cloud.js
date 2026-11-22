// Cloud saves (docs/web.md, web/cloud/server.js): the player's worlds and
// their profile (options, packs, mods) kept on a server as well as in this
// browser, so they are there on any device, and worlds can be shared.
//
// On WebSim the server is the project's own and the player is their WebSim
// account. On Louis's site it is his machine, and the player is a cloud code
// this browser made (type the same code into another browser to link it).
//
// The browser's storage stays the working copy. A bundle is one world's
// folder, or the profile (every kept file outside saves/):
//
//   pull   when the page starts, before the game reads its files: a bundle
//          that is newer in the cloud is brought here, changed files only.
//   push   while the game runs: boot.js says which files it wrote; once it has
//          been quiet for a moment the changed files are hashed and sent in
//          chunks, then the bundle's new file list in one request.
//
// A world changed both here and in the cloud is a conflict: nothing is
// overwritten until the player picks one (the panel asks). The profile just
// follows whoever saved last.
import { state } from './std.js';
import { KEPT, session, openStore, getFile, putFiles, tx } from './store.js';

const SAVES = '/horizon/saves/';
const ROOT = '/horizon/';
const STATE_KEY = '~cloud/state'; // beside the files in the store; not a path
const AUTO_PULL = 150 << 20; // worlds new to this device come by themselves up to this much
const QUIET = 20000; // push after the game has not written for this long,
const LATEST = 180000; // or this long after the first change,
const GAP = 90000; // and not more often than this
const CODE = 'horizon.cloud.code';

let base = '';
let headers = {};
let chunkSize = 2 << 20;
let local = { bundles: {} }; // id -> { kind, folder, name, rev, manifest, dirty, ignored, conflict, gone, following }
let server = []; // the cloud's own list, as of the last look
const live = new Map(); // id -> { touched: Map(path -> seq), first, last, timer, busy, again, progress, error, synced }
const listeners = new Set();
let seq = 0;
let began = false;

export const cloud = { status: 'off', me: null, quota: null, websim: true, message: '' };

const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const bytesOf = (value) => (value instanceof Uint8Array ? value : (value ? new Uint8Array(value) : null));
const newId = () => hex(crypto.getRandomValues(new Uint8Array(12)));
const emit = () => listeners.forEach((f) => { try { f(); } catch { /* a closed panel */ } });
const runtime = (id) => { if (!live.has(id)) live.set(id, { touched: new Map(), first: 0, last: 0, timer: 0, busy: false, synced: 0 }); return live.get(id); };

async function api(method, path, body) {
  const init = { method, headers: { ...headers } };
  if (body instanceof Uint8Array) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  let response;
  try {
    response = await fetch(`${base}/api/cloud/${path}`, init);
  } catch {
    throw Object.assign(new Error('The cloud is not answering right now. Your worlds are safe in this browser and will save when it is back.'), { status: 0, code: 'away' });
  }
  let data = null;
  try { data = await response.json(); } catch { /* not ours */ }
  if (!response.ok || !data) {
    throw Object.assign(new Error(data?.error || 'The cloud did not answer.'), { status: response.status, code: data?.code || 'off', data });
  }
  return data;
}

async function save() {
  try {
    const db = await openStore();
    await tx(db, 'readwrite', (s) => s.put(JSON.parse(JSON.stringify(local)), STATE_KEY));
  } catch (e) { console.warn('Horizon: could not keep the cloud state', e); }
}

// ---- which bundle a file belongs to ----
const worlds = () => Object.entries(local.bundles).filter(([, b]) => b.kind === 'world' && !b.ignored);
const profileId = () => Object.keys(local.bundles).find((id) => local.bundles[id].kind === 'profile');
const prefix = (b) => (b.kind === 'world' ? `${SAVES}${b.folder}/` : ROOT);
const inProfile = (path) => KEPT(path) && !path.startsWith(SAVES) && !path.endsWith('/');

function bundleOf(path, create) {
  if (path.startsWith(SAVES)) {
    const folder = path.slice(SAVES.length).split('/')[0];
    if (!folder || path === `${SAVES}${folder}`) return null;
    let id = worlds().find(([, b]) => b.folder === folder)?.[0];
    if (!id && create) {
      id = newId();
      local.bundles[id] = { kind: 'world', folder, name: folder, rev: 0, manifest: null, dirty: true };
    }
    return id || null;
  }
  if (!inProfile(path)) return null;
  let id = profileId();
  if (!id && create) {
    id = newId();
    local.bundles[id] = { kind: 'profile', name: 'Profile', rev: 0, manifest: null, dirty: true };
  }
  return id || null;
}

async function keysOf(db, b) {
  const start = prefix(b);
  const keys = await tx(db, 'readonly', (s) => s.getAllKeys(IDBKeyRange.bound(start, `${start}￿`)));
  return keys.filter((k) => typeof k === 'string' && !k.endsWith('/') && (b.kind === 'world' || inProfile(k)));
}

// ---- push ----
function plan(id) {
  const r = runtime(id);
  if (!began || r.busy || cloud.status !== 'ready') return;
  const b = local.bundles[id];
  if (!b || !b.dirty || b.ignored || b.conflict || b.full) return;
  clearTimeout(r.timer);
  const now = Date.now();
  const due = Math.max(Math.min((r.last || now) + QUIET, (r.first || now) + LATEST), r.synced + GAP);
  r.timer = setTimeout(() => push(id), Math.max(0, due - now));
}

/// boot.js: the game wrote (or removed) this kept file.
export function touched(path) {
  if (cloud.status === 'off') return;
  const id = bundleOf(path, true);
  if (!id) return;
  const b = local.bundles[id];
  const r = runtime(id);
  r.touched.set(path, ++seq);
  r.last = Date.now();
  r.first ||= r.last;
  if (!b.dirty) { b.dirty = true; save(); emit(); }
  plan(id);
}

/// boot.js: the game removed this file or folder.
export function forgot(path) {
  if (cloud.status === 'off') return;
  const world = path.startsWith(SAVES) && !path.slice(SAVES.length).replace(/\/$/, '').includes('/');
  if (world) {
    // A deleted world stays in the cloud until the player deletes it there.
    const folder = path.slice(SAVES.length).replace(/\/$/, '');
    for (const [id, b] of worlds()) {
      if (b.folder !== folder) continue;
      if (b.rev) { b.ignored = true; b.dirty = false; } else delete local.bundles[id];
      clearTimeout(runtime(id).timer);
    }
    save();
    emit();
    return;
  }
  touched(path);
}

async function hashes(bytes) {
  const out = [];
  for (let at = 0; at < bytes.length; at += chunkSize) out.push(hex(await crypto.subtle.digest('SHA-256', bytes.subarray(at, at + chunkSize))));
  return out;
}

async function inParallel(items, n, work) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await work(items[next++]);
  }));
}

async function push(id, { force = false } = {}) {
  const b = local.bundles[id];
  const r = runtime(id);
  if (!b || b.ignored || cloud.status !== 'ready') return;
  if (r.busy) { r.again = true; return; }
  clearTimeout(r.timer);
  r.busy = true;
  r.error = '';
  r.progress = 0;
  emit();
  try {
    const db = await openStore();
    const keys = await keysOf(db, b);
    if (b.kind === 'world' && !keys.includes(`${prefix(b)}level.dat`)) throw Object.assign(new Error('not a world yet'), { code: 'early' });
    // After a restart nobody knows which files changed: hash them all.
    const everything = !b.manifest || !r.touched.size;
    const seen = new Map(r.touched);
    const start = prefix(b);
    const manifest = {};
    const sources = new Map(); // hash -> [path, chunk index]
    for (const path of keys) {
      const rel = path.slice(start.length);
      const old = b.manifest?.[rel];
      if (old && !everything && !seen.has(path)) { manifest[rel] = old; continue; }
      const bytes = bytesOf(await getFile(db, path));
      if (!bytes) continue;
      const list = await hashes(bytes);
      manifest[rel] = [bytes.length, list];
      list.forEach((hash, i) => sources.set(hash, [path, i]));
    }
    const had = new Set(Object.values(b.manifest || {}).flatMap((entry) => entry[1]));
    const fresh = [...sources.keys()].filter((hash) => !had.has(hash));
    const send = async (list) => {
      let done = 0;
      await inParallel(list, 3, async (hash) => {
        const [path, i] = sources.get(hash) || [];
        const bytes = path && bytesOf(await getFile(db, path));
        const part = bytes?.subarray(i * chunkSize, (i + 1) * chunkSize);
        // The game wrote the file again meanwhile: next time.
        if (!part?.length || hex(await crypto.subtle.digest('SHA-256', part)) !== hash) throw Object.assign(new Error('changed while saving'), { code: 'early' });
        await api('PUT', `chunk/${hash}`, part.slice());
        r.progress = ++done / list.length;
        emit();
      });
    };
    let missing = [];
    for (let i = 0; i < fresh.length; i += 2000) missing.push(...(await api('POST', 'have', { hashes: fresh.slice(i, i + 2000) })).missing);
    await send(missing);
    const body = { kind: b.kind, name: b.name || b.folder || 'World', folder: b.folder || '', base_rev: b.rev || 0, manifest, force: force || b.kind === 'profile' };
    let result;
    try {
      result = await api('PUT', `bundle/${id}`, body);
    } catch (e) {
      if (e.code !== 'missing' || !Array.isArray(e.data?.missing)) throw e;
      // The cloud lost a piece it once had: send it and ask once more.
      for (const hash of e.data.missing) {
        if (sources.has(hash)) continue;
        const rel = Object.keys(manifest).find((p) => manifest[p][1].includes(hash));
        if (rel) sources.set(hash, [start + rel, manifest[rel][1].indexOf(hash)]);
      }
      await send(e.data.missing);
      result = await api('PUT', `bundle/${id}`, body);
    }
    b.rev = result.rev;
    b.size = result.size;
    b.manifest = manifest;
    b.updated_at = result.updated_at;
    delete b.conflict;
    delete b.gone;
    delete b.full;
    for (const [path, at] of seen) if (r.touched.get(path) === at) r.touched.delete(path);
    b.dirty = r.touched.size > 0;
    r.first = b.dirty ? Date.now() : 0;
    r.synced = Date.now();
  } catch (e) {
    if (e.code === 'conflict') b.conflict = { rev: e.data?.rev, by: e.data?.updated_by, at: e.data?.updated_at };
    else if (e.code === 'quota') { b.full = true; r.error = e.message; } else if (e.code === 'owner' || (e.status === 404 && b.rev)) {
      // Not this player's any more (another cloud code, or deleted there): a save of their own.
      delete local.bundles[id];
      live.delete(id);
      const fresh = newId();
      local.bundles[fresh] = { ...b, rev: 0, manifest: null, dirty: true, following: false, conflict: undefined, gone: undefined };
      await save();
      emit();
      if (began) setTimeout(() => push(fresh), 1000);
      return;
    } else if (e.code !== 'early') {
      r.error = e.message || String(e);
      console.warn('Horizon: cloud save failed', e);
    }
    r.synced = Date.now();
  } finally {
    r.busy = false;
    r.progress = 0;
    await save();
    emit();
    if (r.again) { r.again = false; r.last = Date.now(); }
    plan(id);
  }
}

// ---- pull ----
async function freeFolder(db, wanted) {
  const clean = String(wanted || 'World').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^\.+/, '_').trim().slice(0, 60) || 'World';
  const taken = new Set(worlds().map(([, b]) => b.folder.toLowerCase()));
  const keys = await tx(db, 'readonly', (s) => s.getAllKeys(IDBKeyRange.bound(SAVES, `${SAVES}￿`)));
  for (const key of keys) taken.add(String(key).slice(SAVES.length).split('/')[0].toLowerCase());
  let folder = clean;
  for (let n = 2; taken.has(folder.toLowerCase()); n++) folder = `${clean} (${n})`;
  return folder;
}

async function pull(id, say) {
  const remote = await api('GET', `bundle/${id}`);
  const db = await openStore();
  let b = local.bundles[id];
  if (!b || b.ignored) {
    b = { kind: remote.kind, name: remote.name, rev: 0, manifest: null, following: !remote.mine };
    if (b.kind === 'world') b.folder = await freeFolder(db, remote.folder || remote.name);
  }
  const start = prefix(b);
  // Files changed here since the last sync give way too: the cloud's copy, whole.
  const whole = !b.manifest || b.dirty;
  const old = whole ? {} : b.manifest;
  const same = (a, c) => a && c && a[0] === c[0] && a[1].length === c[1].length && a[1].every((hash, i) => hash === c[1][i]);
  const changed = Object.keys(remote.manifest).filter((rel) => !same(old[rel], remote.manifest[rel]));
  let gone = Object.keys(old).filter((rel) => !(rel in remote.manifest));
  // A world is exactly the cloud's files; a profile keeps what only this browser has.
  if (whole && b.kind === 'world') gone = (await keysOf(db, b)).map((key) => key.slice(start.length)).filter((rel) => !(rel in remote.manifest));
  const total = changed.reduce((n, rel) => n + remote.manifest[rel][0], 0);
  let done = 0;
  const fetchChunk = async (hash) => {
    const response = await fetch(`${base}/api/cloud/chunk/${hash}`, { headers }).catch(() => null);
    if (!response?.ok) throw new Error(response?.status === 404 ? 'A piece of this save is missing from the cloud.' : 'A piece of this save did not arrive. Try again in a moment.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== hash) throw new Error('A piece of this save arrived damaged.');
    return bytes;
  };
  await inParallel(changed, 4, async (rel) => {
    const [size, list] = remote.manifest[rel];
    const bytes = new Uint8Array(size);
    for (let i = 0; i < list.length; i++) bytes.set(await fetchChunk(list[i]), i * chunkSize);
    await putFiles(db, [[start + rel, bytes]]);
    if (!session.started) state.files.set(start + rel, bytes);
    done += size;
    say?.(done, total, b);
  });
  if (gone.length) {
    await tx(db, 'readwrite', (s) => { for (const rel of gone) s.delete(start + rel); });
    if (!session.started) for (const rel of gone) state.files.delete(start + rel);
  }
  Object.assign(b, { rev: remote.rev, manifest: remote.manifest, name: remote.name, size: remote.size, updated_at: remote.updated_at, dirty: false, ignored: false });
  delete b.conflict;
  delete b.gone;
  local.bundles[id] = b;
  runtime(id).touched.clear();
  // The running game still has the old world: what it writes there is dropped until it restarts.
  if (session.started && b.kind === 'world') session.blocked.add(start);
  await save();
  emit();
  return b;
}

// ---- start ----
function identify({ key, websim, name }) {
  cloud.websim = websim;
  // WebSim's server is the project's own (this origin); the site's is Louis's machine.
  base = websim ? '' : String(globalThis.HORIZON_CLOUD || '').replace(/\/$/, '');
  headers = { 'x-access-key': key || '' };
  if (!websim) {
    let code = null;
    try { code = localStorage.getItem(CODE); } catch { /* private window */ }
    if (!code || !/^[A-Za-z0-9_-]{20,80}$/.test(code)) {
      code = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      try { localStorage.setItem(CODE, code); } catch { /* private window */ }
    }
    cloud.code = code;
    headers['x-cloud-code'] = code;
    headers['x-cloud-name'] = name || 'Player';
  }
}

async function look() {
  const s = await api('GET', 'state');
  cloud.me = s.me;
  cloud.quota = s.quota;
  chunkSize = s.chunk || chunkSize;
  server = s.bundles;
  cloud.status = 'ready';
  cloud.message = '';
  // Saves the cloud no longer has (deleted from another device, or unshared).
  const ids = new Set(server.map((x) => x.id));
  for (const [id, b] of Object.entries(local.bundles)) {
    if (b.rev && !ids.has(id) && !b.gone) { b.gone = true; b.dirty = false; }
  }
  return s;
}

/// boot.js, before the game reads its files: who the player is, what the cloud
/// has, and anything newer brought here. `say(text)` tells the start screen.
export async function start({ key, websim, name, say }) {
  identify({ key, websim, name });
  let db;
  try {
    db = await openStore();
    const kept = await getFile(db, STATE_KEY);
    if (kept?.bundles) local = kept;
  } catch {
    cloud.status = 'off';
    cloud.message = 'This browser is not keeping files, so there is nothing to sync.';
    return;
  }
  try {
    await Promise.race([look(), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('The cloud is slow to answer.'), { code: 'slow' })), 6000))]);
  } catch (e) {
    cloud.status = e.code === 'guest' ? 'guest' : (e.code === 'key' ? 'key' : (e.code === 'off' ? 'off' : 'error'));
    cloud.message = e.code === 'off' ? '' : e.message;
    emit();
    return;
  }
  // Worlds made before the cloud, or while it was away.
  for (const key of await tx(db, 'readonly', (s) => s.getAllKeys(IDBKeyRange.bound(SAVES, `${SAVES}￿`)))) bundleOf(String(key), true);
  const mine = server.find((x) => x.kind === 'profile' && x.mine);
  if (mine && !local.bundles[mine.id]) {
    // One profile per player: this browser's own, if it made one, gives way.
    const own = profileId();
    if (own) delete local.bundles[own];
  } else if (!mine) bundleOf(`${ROOT}options.txt`, true);

  let budget = AUTO_PULL;
  for (const remote of server) {
    const b = local.bundles[remote.id];
    if (b?.ignored) continue;
    if (!b && !remote.mine) continue; // someone's shared world: the panel offers it
    if (b && remote.rev <= b.rev) {
      // The cloud went back (an old version restored there): send ours again.
      if (remote.rev < b.rev) { b.rev = remote.rev; b.manifest = null; b.dirty = true; }
      continue;
    }
    if (b && b.dirty && b.kind === 'world' && b.rev) {
      b.conflict = { rev: remote.rev, by: remote.updated_by, at: remote.updated_at };
      continue;
    }
    if (!b && remote.kind === 'world') {
      if (remote.size > budget) continue; // a big one: the panel offers it
      budget -= remote.size;
    }
    try {
      await pull(remote.id, (done, total, bundle) => say?.(`Getting ${bundle.kind === 'world' ? `"${bundle.name}"` : 'your settings'} from the cloud: ${(done / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`));
    } catch (e) {
      console.warn('Horizon: could not get a cloud save', e);
      cloud.message = e.message || String(e);
    }
  }
  await save();
  emit();
}

/// boot.js, once the game runs: saves start going up.
export function begin() {
  began = true;
  for (const id of Object.keys(local.bundles)) {
    const r = runtime(id);
    r.first = r.last = Date.now() - QUIET + 8000; // the first push a few seconds in
    plan(id);
  }
}

export function setName(name) { if (headers['x-cloud-name']) headers['x-cloud-name'] = name || 'Player'; }

// ---- for the panel (edition.js) ----
export function on(listener) { listeners.add(listener); return () => listeners.delete(listener); }

/// Every world the player can see: on this device, in their cloud, or shared.
export function view() {
  const items = [];
  const listed = new Set();
  for (const [id, b] of Object.entries(local.bundles)) {
    if (b.kind !== 'world') continue;
    const remote = server.find((x) => x.id === id);
    const r = runtime(id);
    listed.add(id);
    if (b.ignored && !remote) continue; // deleted here, and gone from the cloud too
    let status = 'synced';
    if (b.ignored) status = 'cloud';
    else if (r.busy) status = 'saving';
    else if (b.conflict) status = 'conflict';
    else if (b.full) status = 'full';
    else if (r.error) status = 'error';
    else if (b.gone) status = 'gone';
    else if (b.dirty || !b.rev) status = 'waiting';
    items.push({
      id, folder: b.ignored ? null : b.folder, name: remote?.name || b.name || b.folder, status, progress: r.progress || 0, error: r.error || '',
      conflict: b.conflict || null, rev: b.rev, size: remote?.size ?? b.size ?? 0, updated_at: remote?.updated_at ?? b.updated_at ?? 0,
      updated_by: remote?.updated_by || '', shared: !!remote?.shared, mine: remote ? remote.mine : !b.following, owner: remote?.owner || '', inCloud: !!remote,
    });
  }
  for (const remote of server) {
    if (remote.kind !== 'world' || listed.has(remote.id)) continue;
    items.push({ id: remote.id, folder: null, name: remote.name, status: 'cloud', progress: 0, error: '', conflict: null, rev: remote.rev, size: remote.size,
      updated_at: remote.updated_at, updated_by: remote.updated_by, shared: remote.shared, mine: remote.mine, owner: remote.owner, inCloud: true });
  }
  return { status: cloud.status, message: cloud.message, me: cloud.me, quota: cloud.quota, websim: cloud.websim, code: cloud.code || '', items };
}

export async function refresh() {
  if (cloud.status === 'off') return;
  try { await look(); } catch (e) { cloud.message = e.message; }
  emit();
}

/// The panel changed the store itself (an imported or deleted world).
export function changedFolder(folder, removed) {
  if (removed) forgot(`${SAVES}${folder}`);
  else {
    const id = bundleOf(`${SAVES}${folder}/level.dat`, true);
    if (id) { local.bundles[id].dirty = true; local.bundles[id].manifest = null; save(); emit(); if (began) push(id); else plan(id); }
  }
}

export const syncNow = (id) => push(id);
export const keepMine = (id) => { const b = local.bundles[id]; if (b) delete b.conflict; return push(id, { force: true }); };
/// Brings a cloud world here (a new one, or over this device's copy). The game
/// plays it after a restart.
export const fetchWorld = (id, say) => pull(id, say);
export async function share(id, shared) {
  await api('POST', `bundle/${id}/share`, { shared });
  await refresh();
}
export async function removeFromCloud(id) {
  await api('DELETE', `bundle/${id}`);
  const b = local.bundles[id];
  if (b?.ignored) delete local.bundles[id];
  else if (b) { b.rev = 0; b.manifest = null; b.gone = true; b.dirty = false; }
  await save();
  await refresh();
}
/// Puts a world that is only here (deleted from the cloud elsewhere) back up.
export function upload(id) {
  const b = local.bundles[id];
  if (!b) return null;
  delete b.gone;
  b.rev = 0;
  b.manifest = null;
  b.dirty = true;
  return push(id);
}
/// The panel wiped this browser: worlds already in the cloud stay there (to get
/// back or delete), and the profile starts over.
export async function wiped() {
  for (const [id, b] of Object.entries(local.bundles)) {
    clearTimeout(runtime(id).timer);
    live.delete(id);
    if (b.kind === 'world' && b.rev && !b.gone) local.bundles[id] = { kind: 'world', name: b.name, folder: b.folder, rev: b.rev, ignored: true };
    else if (b.kind === 'profile' && b.rev) local.bundles[id] = { kind: 'profile', name: b.name, rev: b.rev, manifest: null, dirty: false };
    else delete local.bundles[id];
  }
  await save();
  emit();
}

/// Links this browser to another one's cloud (the plain site): its code.
export async function useCode(code) {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(code)) throw new Error('That is not a cloud code.');
  try { localStorage.setItem(CODE, code); } catch { throw new Error('This browser cannot keep the code.'); }
  // This browser's worlds go up as new ones in that cloud; that cloud's come here.
  local = { bundles: {} };
  await save();
}
