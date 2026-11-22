// The cloud save server on Louis's own machine (nc2), for minecraft.lou15.com
// (docs/web.md): runs web/cloud/server.js, the same code WebSim runs, over
// SQLite and a folder of chunks. It also hands out the packed game files, to
// holders of the access key only, as the locked file host does.
//
//   DATA=/tank/... ACCESS_KEY_FILE=/etc/... PACK=/tank/.../pack PORT=8830 \
//   ORIGINS=https://minecraft.lou15.com node serve.mjs
//
// Who is asking: there are no accounts on the site. A browser makes a cloud
// code once (a long random secret) and sends it with every request; the same
// code typed into another browser is the same player. Every request must also
// carry the access key.
//
// Tests: STATIC=dir also serves the page from the same origin, and
// IDENTITY=websim takes the player from a `testuser` cookie, as WebSim would
// from its own sign-in.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import server, { schema, CHUNK } from './server.js';

const PORT = Number(process.env.PORT) || 8830;
const HOST = process.env.HOST || '127.0.0.1';
const DATA = process.env.DATA || './cloud-data';
const PACK = process.env.PACK || '';
const STATIC = process.env.STATIC || '';
const WEBSIM = process.env.IDENTITY === 'websim';
const ORIGINS = new Set((process.env.ORIGINS || 'https://minecraft.lou15.com').split(',').map((o) => o.trim()).filter(Boolean));
const ACCESS_KEY = process.env.ACCESS_KEY_FILE ? fs.readFileSync(process.env.ACCESS_KEY_FILE, 'utf8').trim() : (process.env.ACCESS_KEY || '');
if (!ACCESS_KEY) throw new Error('no access key: set ACCESS_KEY_FILE');

fs.mkdirSync(path.join(DATA, 'chunks'), { recursive: true });
const db = new DatabaseSync(path.join(DATA, 'cloud.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
db.exec(schema);

// ---- the database and storage, as server.js expects them ----
const changes = (result) => ({ meta: { changes: Number(result.changes) } });
const statement = (sql, args = []) => ({
  bind: (...values) => statement(sql, values),
  first: async (column) => { const r = db.prepare(sql).get(...args); return r === undefined ? null : (column ? r[column] : r); },
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  run: async () => changes(db.prepare(sql).run(...args)),
  now: () => changes(db.prepare(sql).run(...args)),
});
const env = {
  DB: {
    prepare: (sql) => statement(sql),
    async batch(list) {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => s.now());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  },
  BLOB: {
    file: (name) => path.join(DATA, 'chunks', name.slice(6, 8), name),
    async put(name, data) {
      const file = this.file(name);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await fs.promises.writeFile(temp, data);
      await fs.promises.rename(temp, file);
      return { url: `local:${name}` };
    },
    get(name) { return fs.promises.readFile(this.file(name)).catch(() => null); },
  },
  CLOUD_QUOTA: process.env.QUOTA || String(1 << 30),
  // The key is checked on every request here (below), before server.js.
  CLOUD_VERIFY: async () => true,
};

const sha = (text) => crypto.createHash('sha256').update(text).digest();
const keyMatches = (given) => crypto.timingSafeEqual(sha(given), sha(ACCESS_KEY));
const cookie = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];

function cors(req) {
  const origin = req.headers.origin || '';
  if (!ORIGINS.has(origin)) return { vary: 'origin' };
  return {
    vary: 'origin',
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'x-access-key, x-cloud-code, x-cloud-name, content-type',
    'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'access-control-max-age': '86400',
  };
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.gz': 'application/gzip' };
function sendFile(req, res, file, headers) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404, headers); res.end(); return; }
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const out = { ...headers, etag, 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, out); res.end(); return; }
    res.writeHead(200, { ...out, 'content-length': stat.size });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

function body(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', (part) => {
      size += part.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); } else parts.push(part);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  const headers = cors(req);
  try {
    const url = new URL(req.url, 'http://local');
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }

    const api = url.pathname.startsWith('/api/cloud/');
    const files = PACK && url.pathname.startsWith('/files/');
    if (api || files) {
      if (!keyMatches(String(req.headers['x-access-key'] || ''))) {
        res.writeHead(401, { ...headers, 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'The cloud needs your access key.', code: 'key' }));
        return;
      }
    }
    // ---- the game's files ----
    if (files) {
      const name = url.pathname.slice(7);
      if ((req.method !== 'GET' && req.method !== 'HEAD') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { res.writeHead(404, headers); res.end(); return; }
      const hashed = /-[0-9a-f]{10}\.bin$/.test(name);
      sendFile(req, res, path.join(PACK, name), { ...headers, 'cache-control': hashed ? 'private, max-age=31536000, immutable' : 'private, no-cache' });
      return;
    }
    // ---- cloud saves ----
    if (api) {
      const forward = new Headers();
      for (const name of ['content-type', 'x-access-key']) if (req.headers[name]) forward.set(name, req.headers[name]);
      if (WEBSIM) {
        const user = cookie(req, 'testuser');
        if (user) { forward.set('x-websim-user-id', `id-${user}`); forward.set('x-websim-username', user); }
      } else {
        const code = String(req.headers['x-cloud-code'] || '');
        if (/^[A-Za-z0-9_-]{20,80}$/.test(code)) {
          forward.set('x-websim-user-id', `c-${sha(`cloud-code\n${code}`).toString('hex').slice(0, 32)}`);
          forward.set('x-websim-username', String(req.headers['x-cloud-name'] || 'Player').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16) || 'Player');
        }
      }
      const data = req.method === 'GET' || req.method === 'HEAD' ? undefined : await body(req, CHUNK + 4096 + (1 << 22));
      const response = await server.fetch(new Request(`http://local${url.pathname}${url.search}`, { method: req.method, headers: forward, body: data }), env);
      const out = { ...headers };
      response.headers.forEach((value, name) => { out[name] = value; });
      res.writeHead(response.status, out);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    // ---- tests: the page itself ----
    if (STATIC && (req.method === 'GET' || req.method === 'HEAD')) {
      const file = path.join(STATIC, path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));
      sendFile(req, res, file.endsWith('/') || file === STATIC ? path.join(file, 'index.html') : file, { 'cache-control': 'no-store' });
      return;
    }
    res.writeHead(404, headers);
    res.end();
  } catch (e) {
    console.error(new Date().toISOString(), req.method, req.url, e?.message || e);
    if (!res.headersSent) res.writeHead(e?.message === 'too large' ? 413 : 500, { ...headers, 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'The cloud had a problem. Try again in a moment.', code: 'server' }));
  }
}).listen(PORT, HOST, () => console.log(`cloud saves on ${HOST}:${PORT}, data in ${DATA}${PACK ? `, game files from ${PACK}` : ''}`));
