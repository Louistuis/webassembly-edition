// Cloud saves for the WASM Edition (docs/web.md): a player's worlds and their
// profile (options, packs, mods) kept on a server, so they follow the player
// to any device, and worlds can be shared with everyone on the page.
//
// One server, two homes:
//   WebSim   this file is the project's server: `env.DB` is its database,
//            `env.BLOB` its file storage, and WebSim says who is asking
//            (x-websim-user-id). Synced with the page by web/publish.sh.
//   nc2      web/cloud/serve.mjs runs the same `fetch` for minecraft.lou15.com
//            over SQLite and a folder, and says who is asking from the
//            player's cloud code.
//
// Files are stored in chunks named by their SHA-256, so a save sends only what
// changed and identical data is kept once. A bundle (a world, or a profile) is
// a manifest: { "path": [size, [chunk hashes]] }, with a revision number that
// goes up by one with every save. The last few revisions are kept.
//
// Only players who hold the access key get in (checked once per player with
// the locked file host). Nothing of Mojang's is stored here: saves only.

export const schema = `
CREATE TABLE IF NOT EXISTS cloud_users (user_id TEXT PRIMARY KEY, username TEXT, verified_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_chunks (hash TEXT PRIMARY KEY, size INTEGER NOT NULL, url TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cloud_bundles (id TEXT PRIMARY KEY, kind TEXT NOT NULL, owner_id TEXT NOT NULL, owner_name TEXT, name TEXT, folder TEXT, rev INTEGER NOT NULL, manifest TEXT NOT NULL, size INTEGER NOT NULL, shared INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT);
CREATE INDEX IF NOT EXISTS cloud_bundles_owner ON cloud_bundles (owner_id);
CREATE INDEX IF NOT EXISTS cloud_bundles_shared ON cloud_bundles (shared, updated_at);
CREATE TABLE IF NOT EXISTS cloud_revs (bundle_id TEXT NOT NULL, rev INTEGER NOT NULL, manifest TEXT NOT NULL, size INTEGER NOT NULL, saved_at INTEGER NOT NULL, saved_by TEXT, PRIMARY KEY (bundle_id, rev));
CREATE TABLE IF NOT EXISTS cloud_uploads (user_id TEXT NOT NULL, day INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY (user_id, day));
`;

export const CHUNK = 2 << 20; // bytes per chunk
const QUOTA = 300 << 20; // per player: their own bundles, latest revisions
const DAILY = 4; // a player may upload this many quotas a day
const KEPT_REVS = 5;
const MAX_FILES = 20000;
const FILES_HOST = 'https://wasm-edition-files.nc-status.workers.dev/';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
const fail = (status, code, error, more = {}) => json({ error, code, ...more }, status);
const isHash = (h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h);
const isId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);
const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// A manifest as stored, or why it is refused. Returns [manifest, size, hashes].
function readManifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'The save has no file list.';
  const paths = Object.keys(input);
  if (paths.length > MAX_FILES) return 'The save has too many files.';
  const manifest = {};
  const hashes = new Map(); // hash -> the size its chunk must have
  let total = 0;
  for (const path of paths.sort()) {
    if (!path || path.length > 300 || path.startsWith('/') || path.endsWith('/') || path.includes('\\')
      || path.split('/').some((part) => part === '' || part === '.' || part === '..')) return 'The save names a file it may not.';
    const entry = input[path];
    if (!Array.isArray(entry) || entry.length !== 2) return 'The save is damaged.';
    const [size, chunks] = entry;
    if (!Number.isSafeInteger(size) || size < 0 || !Array.isArray(chunks) || chunks.length !== Math.ceil(size / CHUNK)) return 'The save is damaged.';
    for (let i = 0; i < chunks.length; i++) {
      if (!isHash(chunks[i])) return 'The save is damaged.';
      const expected = i === chunks.length - 1 ? size - CHUNK * i : CHUNK;
      // The same data may sit in two files, never under two sizes.
      if (hashes.has(chunks[i]) && hashes.get(chunks[i]) !== expected) return 'The save is damaged.';
      hashes.set(chunks[i], expected);
    }
    manifest[path] = [size, chunks];
    total += size;
  }
  return [manifest, total, hashes];
}

async function known(env, hashes) {
  const out = new Map();
  for (let i = 0; i < hashes.length; i += 80) {
    const part = hashes.slice(i, i + 80);
    const { results } = await env.DB.prepare(`SELECT hash, size, url FROM cloud_chunks WHERE hash IN (${part.map(() => '?').join(',')})`).bind(...part).all();
    for (const row of results) out.set(row.hash, row);
  }
  return out;
}

const row = (b, userId) => ({
  id: b.id, kind: b.kind, name: b.name, folder: b.folder, rev: b.rev, size: b.size, shared: !!b.shared,
  updated_at: b.updated_at, updated_by: b.updated_by, owner: b.owner_name, mine: b.owner_id === userId,
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const m = request.method;
    if (!p.startsWith('/api/cloud/')) return fail(404, 'not_found', 'Not found.');
    const userId = request.headers.get('x-websim-user-id');
    const username = text(request.headers.get('x-websim-username') || 'Player', 32);
    if (!userId || request.headers.get('x-websim-user-is-anonymous') === 'true') {
      return fail(401, 'guest', 'Sign in to keep your worlds in the cloud.');
    }
    const quota = Number(env.CLOUD_QUOTA) || QUOTA;
    const now = Date.now();

    // ---- the access key, once per player ----
    let user = await env.DB.prepare('SELECT user_id FROM cloud_users WHERE user_id = ?').bind(userId).first();
    if (!user) {
      const key = request.headers.get('x-access-key') || '';
      let holds = false;
      if (key) {
        if (typeof env.CLOUD_VERIFY === 'function') holds = await env.CLOUD_VERIFY(key);
        else {
          try {
            holds = (await fetch(`${FILES_HOST}index.json`, { method: 'HEAD', headers: { 'x-access-key': key } })).ok;
          } catch {
            return fail(502, 'upstream', 'Could not check your access key. Try again in a moment.');
          }
        }
      }
      if (!holds) return fail(403, 'key', 'The cloud needs your access key.');
      await env.DB.prepare('INSERT OR IGNORE INTO cloud_users (user_id, username, verified_at) VALUES (?, ?, ?)').bind(userId, username, now).run();
      user = { user_id: userId };
    }

    const used = async (exceptId) => (await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM cloud_bundles WHERE owner_id = ? AND id != ?').bind(userId, exceptId || '').first()).n;

    // ---- what the player has, and what is shared ----
    if (m === 'GET' && p === '/api/cloud/state') {
      const mine = await env.DB.prepare('SELECT * FROM cloud_bundles WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 200').bind(userId).all();
      const shared = await env.DB.prepare("SELECT * FROM cloud_bundles WHERE shared = 1 AND kind = 'world' AND owner_id != ? ORDER BY updated_at DESC LIMIT 100").bind(userId).all();
      return json({
        me: { id: userId, name: username },
        bundles: [...mine.results, ...shared.results].map((b) => row(b, userId)),
        quota: { used: await used(), max: quota },
        chunk: CHUNK,
      });
    }

    // ---- chunks ----
    if (m === 'POST' && p === '/api/cloud/have') {
      const body = await request.json().catch(() => null);
      const hashes = Array.isArray(body?.hashes) ? [...new Set(body.hashes.filter(isHash))].slice(0, 4000) : [];
      const have = await known(env, hashes);
      return json({ missing: hashes.filter((h) => !have.has(h)) });
    }
    const chunk = p.match(/^\/api\/cloud\/chunk\/([0-9a-f]{64})$/);
    if (chunk && m === 'PUT') {
      const data = new Uint8Array(await request.arrayBuffer());
      if (!data.length || data.length > CHUNK) return fail(413, 'size', 'That piece is too large.');
      if (hex(await crypto.subtle.digest('SHA-256', data)) !== chunk[1]) return fail(400, 'hash', 'That piece arrived damaged.');
      if (await env.DB.prepare('SELECT 1 FROM cloud_chunks WHERE hash = ?').bind(chunk[1]).first()) return json({ ok: true });
      const day = Math.floor(now / 86400000);
      const sent = (await env.DB.prepare('SELECT bytes FROM cloud_uploads WHERE user_id = ? AND day = ?').bind(userId, day).first())?.bytes || 0;
      if (sent + data.length > quota * DAILY) return fail(429, 'rate', 'That is a lot of saving for one day. Try again tomorrow.');
      const stored = await env.BLOB.put(`chunk-${chunk[1]}.bin`, data, { contentType: 'application/octet-stream' });
      await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO cloud_chunks (hash, size, url, created_at) VALUES (?, ?, ?, ?)').bind(chunk[1], data.length, stored.url, now),
        env.DB.prepare('INSERT INTO cloud_uploads (user_id, day, bytes) VALUES (?, ?, ?) ON CONFLICT (user_id, day) DO UPDATE SET bytes = bytes + excluded.bytes').bind(userId, day, data.length),
      ]);
      return json({ ok: true });
    }
    if (chunk && m === 'GET') {
      // The page always asks here, never the storage itself: a browser may not
      // be let into WebSim's storage from the page, the server is.
      let data = null;
      if (typeof env.BLOB.get === 'function') data = await env.BLOB.get(`chunk-${chunk[1]}.bin`);
      else {
        const stored = await env.DB.prepare('SELECT url FROM cloud_chunks WHERE hash = ?').bind(chunk[1]).first();
        if (stored) {
          const got = await fetch(stored.url).catch(() => null);
          if (got?.ok) data = await got.arrayBuffer();
          else if (got) return fail(502, 'upstream', 'That piece did not come out of storage. Try again in a moment.');
        }
      }
      if (!data) return fail(404, 'not_found', 'That piece is gone.');
      return new Response(data, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' } });
    }
    // Where to get chunks from: a link each (WebSim's storage), or this server.
    if (m === 'POST' && p === '/api/cloud/urls') {
      const body = await request.json().catch(() => null);
      const hashes = Array.isArray(body?.hashes) ? [...new Set(body.hashes.filter(isHash))].slice(0, 4000) : [];
      const have = await known(env, hashes);
      const urls = {};
      for (const [hash, c] of have) urls[hash] = c.url.startsWith('local:') ? `/api/cloud/chunk/${hash}` : c.url;
      return json({ urls });
    }

    // ---- bundles: a world, or the player's profile ----
    const bundle = p.match(/^\/api\/cloud\/bundle\/([A-Za-z0-9_-]{8,64})(\/share|\/revs|\/restore)?$/);
    if (!bundle) return fail(404, 'not_found', 'Not found.');
    const [, id, action] = bundle;
    if (!isId(id)) return fail(400, 'id', 'Not a save.');
    const existing = await env.DB.prepare('SELECT * FROM cloud_bundles WHERE id = ?').bind(id).first();
    const owns = existing?.owner_id === userId;
    const reads = owns || (existing?.shared && existing.kind === 'world');

    if (m === 'GET' && !action) {
      if (!existing || !reads) return fail(404, 'not_found', 'That save is not in the cloud.');
      return json({ ...row(existing, userId), manifest: JSON.parse(existing.manifest) });
    }
    if (m === 'GET' && action === '/revs') {
      if (!existing || !owns) return fail(404, 'not_found', 'That save is not in the cloud.');
      const { results } = await env.DB.prepare('SELECT rev, size, saved_at, saved_by FROM cloud_revs WHERE bundle_id = ? ORDER BY rev DESC').bind(id).all();
      return json({ revs: results });
    }
    if (m === 'POST' && action === '/share') {
      if (!existing || !owns || existing.kind !== 'world') return fail(404, 'not_found', 'That world is not yours to share.');
      const body = await request.json().catch(() => null);
      await env.DB.prepare('UPDATE cloud_bundles SET shared = ? WHERE id = ?').bind(body?.shared ? 1 : 0, id).run();
      return json({ ok: true, shared: !!body?.shared });
    }
    if (m === 'DELETE' && !action) {
      if (!existing) return json({ ok: true });
      if (!owns) return fail(403, 'owner', 'Only its owner can delete that save.');
      await env.DB.batch([
        env.DB.prepare('DELETE FROM cloud_bundles WHERE id = ?').bind(id),
        env.DB.prepare('DELETE FROM cloud_revs WHERE bundle_id = ?').bind(id),
      ]);
      return json({ ok: true });
    }

    // Save: a new revision on top of `base_rev`, or (`/restore`) an old one again.
    if ((m === 'PUT' && !action) || (m === 'POST' && action === '/restore')) {
      const body = await request.json().catch(() => null);
      if (!body) return fail(400, 'body', 'The save did not arrive.');
      let manifestText;
      let size;
      if (action === '/restore') {
        if (!existing || !owns) return fail(404, 'not_found', 'That save is not in the cloud.');
        const old = await env.DB.prepare('SELECT manifest, size FROM cloud_revs WHERE bundle_id = ? AND rev = ?').bind(id, Number(body.rev)).first();
        if (!old) return fail(404, 'rev', 'That version is no longer kept.');
        manifestText = old.manifest;
        size = old.size;
      } else {
        if (existing && !reads) return fail(403, 'owner', 'That save is not yours.');
        const read = readManifest(body.manifest);
        if (typeof read === 'string') return fail(400, 'manifest', read);
        const [manifest, total, hashes] = read;
        const have = await known(env, [...hashes.keys()]);
        for (const [hash, expected] of hashes) {
          const c = have.get(hash);
          if (!c) return fail(409, 'missing', 'A piece of the save has not arrived yet.', { missing: [...hashes.keys()].filter((h) => !have.has(h)).slice(0, 500) });
          if (c.size !== expected) return fail(400, 'manifest', 'The save is damaged.');
        }
        manifestText = JSON.stringify(manifest);
        size = total;
        const base = Number(body.base_rev) || 0;
        if (existing && base !== existing.rev && !body.force) {
          return fail(409, 'conflict', 'This save changed in the cloud since you last got it.', { rev: existing.rev, updated_at: existing.updated_at, updated_by: existing.updated_by });
        }
      }
      // The space is the owner's, whoever saves.
      const ownerId = existing ? existing.owner_id : userId;
      const taken = (await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS n FROM cloud_bundles WHERE owner_id = ? AND id != ?').bind(ownerId, id).first()).n;
      if (taken + size > quota) return fail(413, 'quota', 'The cloud is full. Delete a world from it to make room.', { used: taken, max: quota, need: size });
      const kind = existing ? existing.kind : (body.kind === 'profile' ? 'profile' : 'world');
      const name = text(body.name ?? existing?.name ?? 'World', 80) || 'World';
      const folder = text(body.folder ?? existing?.folder ?? '', 120);
      const rev = (existing?.rev || 0) + 1;
      let changed;
      if (existing) {
        // Only on top of the revision this request saw: two saves at once cannot both land.
        changed = await env.DB.prepare('UPDATE cloud_bundles SET name = ?, folder = ?, rev = ?, manifest = ?, size = ?, updated_at = ?, updated_by = ? WHERE id = ? AND rev = ?')
          .bind(name, folder, rev, manifestText, size, now, username, id, existing.rev).run();
      } else {
        changed = await env.DB.prepare('INSERT OR IGNORE INTO cloud_bundles (id, kind, owner_id, owner_name, name, folder, rev, manifest, size, shared, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)')
          .bind(id, kind, userId, username, name, folder, rev, manifestText, size, now, username).run();
      }
      if (!changed?.meta?.changes) return fail(409, 'conflict', 'This save changed in the cloud just now.', { rev: existing?.rev ?? 0 });
      await env.DB.batch([
        env.DB.prepare('INSERT OR REPLACE INTO cloud_revs (bundle_id, rev, manifest, size, saved_at, saved_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id, rev, manifestText, size, now, username),
        env.DB.prepare('DELETE FROM cloud_revs WHERE bundle_id = ? AND rev <= ?').bind(id, rev - KEPT_REVS),
      ]);
      return json({ ok: true, rev, size, updated_at: now });
    }
    return fail(405, 'method', 'Not allowed.');
  },
};
