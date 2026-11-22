// The cloud save server by itself (web/cloud/server.js through serve.mjs):
// keys, chunks, saving, conflicts, sharing, old versions, the quota.
//   node web/test/cloud-api.mjs [scratch dir]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const data = fs.mkdtempSync(path.join(process.argv[2] || os.tmpdir(), 'cloud-api-'));
const port = 18000 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, [path.join(here, '../cloud/serve.mjs')], {
  env: { ...process.env, PORT: String(port), DATA: data, ACCESS_KEY: 'test-key', QUOTA: String(5 << 20), ORIGINS: 'https://page.test', NODE_NO_WARNINGS: '1' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 50; i++) {
  if (await fetch(`${base}/health`).then((r) => r.ok, () => false)) break;
  await new Promise((r) => setTimeout(r, 100));
}

let failed = 0;
const check = (name, ok, detail = '') => { if (!ok) failed += 1; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`); };
const ask = (who, method, url, body, key = 'test-key') => fetch(`${base}/api/cloud/${url}`, {
  method,
  headers: { 'x-access-key': key, 'x-cloud-code': who.code, 'x-cloud-name': who.name, ...(body && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}) },
  body: body instanceof Uint8Array ? body : (body ? JSON.stringify(body) : undefined),
}).then(async (r) => ({ status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : new Uint8Array(await r.arrayBuffer()) }));
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const ann = { code: 'a'.repeat(24), name: 'Ann' };
const bob = { code: 'b'.repeat(24), name: 'Bob' };

check('no key is refused', (await ask(ann, 'GET', 'state', null, 'wrong')).status === 401);
check('no cloud code is a guest', (await ask({ code: 'short', name: 'x' }, 'GET', 'state')).status === 401);
const first = await ask(ann, 'GET', 'state');
check('an empty cloud', first.status === 200 && first.body.bundles.length === 0 && first.body.quota.max === 5 << 20, JSON.stringify(first.body));

const level = new Uint8Array(1000).fill(7);
const region = crypto.randomBytes((2 << 20) + 5000); // two chunks
const parts = [region.subarray(0, 2 << 20), region.subarray(2 << 20)];
const manifest = { 'level.dat': [level.length, [hash(level)]], 'region/r.0.0.mca': [region.length, parts.map(hash)], 'empty.txt': [0, []] };
const all = [hash(level), ...parts.map(hash)];
check('nothing is there yet', (await ask(ann, 'POST', 'have', { hashes: all })).body.missing.length === 3);
check('a save without its pieces is refused', (await ask(ann, 'PUT', 'bundle/world-one-1', { name: 'One', folder: 'One', base_rev: 0, manifest })).body.code === 'missing');
check('a damaged piece is refused', (await ask(ann, 'PUT', `chunk/${hash(level)}`, new Uint8Array(1000))).status === 400);
for (const bytes of [level, ...parts]) check('a piece is stored', (await ask(ann, 'PUT', `chunk/${hash(bytes)}`, new Uint8Array(bytes))).status === 200);
check('all pieces are there', (await ask(ann, 'POST', 'have', { hashes: all })).body.missing.length === 0);
check('a path outside the save is refused', (await ask(ann, 'PUT', 'bundle/world-one-1', { base_rev: 0, manifest: { '../x': [0, []] } })).status === 400);
const saved = await ask(ann, 'PUT', 'bundle/world-one-1', { name: 'One', folder: 'One', base_rev: 0, manifest });
check('the world is saved as revision 1', saved.status === 200 && saved.body.rev === 1, JSON.stringify(saved.body));
const got = await ask(ann, 'GET', 'bundle/world-one-1');
check('it reads back', got.body.rev === 1 && got.body.manifest['region/r.0.0.mca'][1].length === 2 && got.body.mine === true);
const urls = (await ask(ann, 'POST', 'urls', { hashes: all })).body.urls;
const back = await fetch(base + urls[hash(parts[1])], { headers: { 'x-access-key': 'test-key', 'x-cloud-code': ann.code } }).then((r) => r.arrayBuffer());
check('a piece comes back whole', hash(Buffer.from(back)) === hash(parts[1]));

check('a stale save is a conflict', (await ask(ann, 'PUT', 'bundle/world-one-1', { base_rev: 0, manifest })).body.code === 'conflict');
const second = await ask(ann, 'PUT', 'bundle/world-one-1', { base_rev: 1, manifest: { 'level.dat': manifest['level.dat'] } });
check('a save on top is revision 2', second.body.rev === 2 && second.body.size === 1000);
check('forcing wins a conflict', (await ask(ann, 'PUT', 'bundle/world-one-1', { base_rev: 1, force: true, manifest })).body.rev === 3);

check('someone else cannot read it', (await ask(bob, 'GET', 'bundle/world-one-1')).status === 404);
check('someone else cannot save over it', (await ask(bob, 'PUT', 'bundle/world-one-1', { base_rev: 3, manifest })).status === 403);
check('someone else cannot share it', (await ask(bob, 'POST', 'bundle/world-one-1/share', { shared: true })).status === 404);
check('the owner shares it', (await ask(ann, 'POST', 'bundle/world-one-1/share', { shared: true })).body.shared === true);
const seen = await ask(bob, 'GET', 'state');
check('a shared world shows for everyone', seen.body.bundles.length === 1 && seen.body.bundles[0].mine === false && seen.body.bundles[0].owner === 'Ann', JSON.stringify(seen.body.bundles));
check('a friend saves the shared world', (await ask(bob, 'PUT', 'bundle/world-one-1', { base_rev: 3, manifest: { 'level.dat': manifest['level.dat'] } })).body.rev === 4);
check('a friend cannot delete it', (await ask(bob, 'DELETE', 'bundle/world-one-1')).status === 403);

const revs = await ask(ann, 'GET', 'bundle/world-one-1/revs');
check('old versions are kept', revs.body.revs.length === 4 && revs.body.revs[0].saved_by === 'Bob', JSON.stringify(revs.body));
const restored = await ask(ann, 'POST', 'bundle/world-one-1/restore', { rev: 3 });
check('the owner brings an old version back', restored.body.rev === 5 && restored.body.size === 1000 + region.length);

const big = crypto.randomBytes(2 << 20);
await ask(ann, 'PUT', `chunk/${hash(big)}`, new Uint8Array(big));
const over = await ask(ann, 'PUT', 'bundle/world-two-22', { name: 'Two', base_rev: 0, manifest: { 'a.bin': [big.length, [hash(big)]], 'b.bin': [big.length, [hash(big)]] } });
check('the quota holds', over.status === 413 && over.body.code === 'quota', JSON.stringify(over.body));
const profile = await ask(ann, 'PUT', 'bundle/profile-ann-1', { kind: 'profile', name: 'Profile', base_rev: 0, manifest: { 'options.txt': manifest['level.dat'] } });
check('a profile saves', profile.body.rev === 1);
check('a profile is never shared', (await ask(ann, 'POST', 'bundle/profile-ann-1/share', { shared: true })).status === 404);
check('the owner deletes the world', (await ask(ann, 'DELETE', 'bundle/world-one-1')).body.ok === true);
check('it is gone for everyone', (await ask(bob, 'GET', 'state')).body.bundles.length === 0);

child.kill();
fs.rmSync(data, { recursive: true, force: true });
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
