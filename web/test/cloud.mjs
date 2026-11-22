// Cloud saves end to end (docs/web.md): the real page against the real server
// (web/cloud/serve.mjs, which also serves the page here).
//
//   1. A browser makes a world, stands somewhere odd, saves: the world goes up.
//   2. A second browser with the same cloud code starts: the world comes down
//      before the game reads its files, and opens where the first one stood.
//      It saves: revision 2.
//   3. The first shares the world; a third browser, someone else, sees it
//      under shared worlds and gets it.
//   4. The WebSim way in: the player is who the platform says (a cookie here).
//
//   node test/cloud.mjs STAGE OUT [seconds]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [stage, out, seconds = '900'] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + Number(seconds) * 1000;
const result = { checks: [] };
const check = (name, ok, detail = '') => { result.checks.push({ name, ok: Boolean(ok), detail: ok ? '' : String(detail).slice(0, 400) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${String(detail).slice(0, 400)}`}`); };

const servers = [];
// Whatever happens to the test, its servers go with it.
process.on('exit', () => { for (const s of servers) { try { s.child.kill(); } catch { /* gone */ } } });
async function serve(identity) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-test-'));
  const port = 19000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, [path.join(here, '../cloud/serve.mjs')], {
    env: { ...process.env, PORT: String(port), DATA: data, ACCESS_KEY: 'test-key', STATIC: path.resolve(stage), IDENTITY: identity, NODE_NO_WARNINGS: '1' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  servers.push({ child, data });
  for (let i = 0; i < 50; i++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) break;
    await wait(100);
  }
  return `http://127.0.0.1:${port}`;
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan',
    '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-vulkan-surface', '--disable-audio-output',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
// A browser of its own: storage, and (given) a cloud code or a WebSim name.
async function device(origin, query, { code, user, name } = {}) {
  const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
  if (user) await context.addCookies([{ name: 'testuser', value: user, url: origin }]);
  await context.addInitScript(([cloudCode, player]) => {
    localStorage.setItem('horizon.key', 'test-key');
    if (cloudCode) localStorage.setItem('horizon.cloud.code', cloudCode);
    if (player) localStorage.setItem('horizon.name', player);
  }, [code || '', name || '']);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)));
  await page.goto(`${origin}/?${query}`);
  return { context, page };
}
const look = (page) => page.evaluate(() => ({
  last: globalThis.horizon?.lines?.at(-1) ?? '',
  errors: globalThis.horizon?.errors ?? [],
  cloud: globalThis.horizon?.cloud?.view?.() ?? null,
  code: localStorage.getItem('horizon.cloud.code'),
})).catch((e) => ({ e: String(e), last: '' }));
const until = async (page, done, every = 5000) => {
  let g = {};
  while (Date.now() < deadline) {
    await wait(every);
    g = await look(page);
    if (g.errors?.length || done(g)) break;
  }
  return g;
};
const inWorld = (g) => /eye Some/.test(g.last) && /chunks [1-9]/.test(g.last);
const command = (page, line) => page.evaluate((l) => globalThis.horizon.command(l), line);
const world = (g, name) => g.cloud?.items?.find((i) => i.name === name || i.folder === name);
const args = (line) => `brand=plain&args=${encodeURIComponent(line)}`;

let g = {};
const site = await serve('code');
// ONLY=websim: just the last parts.
if (process.env.ONLY !== 'websim') {
// ---- 1. a world goes up ----
const a = await device(site, args('--world Cloudy --creative --render-distance 2 --name Ann'), { name: 'Ann' });
g = await until(a.page, inWorld);
check('the first browser is in its world', inWorld(g), g.last);
check('the cloud knows the player', g.cloud?.status === 'ready', JSON.stringify(g.cloud).slice(0, 300));
await command(a.page, 'tp 1234 120 -777');
await wait(8000);
await command(a.page, 'save');
await wait(12000);
await a.page.evaluate(() => { const c = globalThis.horizon.cloud; return Promise.all(c.view().items.map((i) => c.syncNow(i.id))); });
g = await until(a.page, (x) => world(x, 'Cloudy')?.status === 'synced' && world(x, 'Cloudy').rev >= 1, 3000);
check('the world is saved to the cloud', world(g, 'Cloudy')?.status === 'synced', JSON.stringify(world(g, 'Cloudy')));
const first = world(g, 'Cloudy') || {};
const code = g.code;
result.first = first;

// ---- 3 (early, while the owner is here). the owner shares it ----
await a.page.evaluate((id) => globalThis.horizon.cloud.share(id, true), first.id).catch((e) => console.log('share', String(e)));
g = await look(a.page);
check('the owner shares the world', world(g, 'Cloudy')?.shared === true, JSON.stringify(world(g, 'Cloudy')));
await a.context.close();

// ---- 2. it comes down on another browser, and opens ----
const b = await device(site, args('--world Cloudy --creative --render-distance 2 --name Ann'), { code, name: 'Ann' });
g = await until(b.page, inWorld);
check('the second browser is in the world', inWorld(g), g.last);
const eye = /eye Some\(\[?\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)/.exec(g.last);
result.eye = eye?.slice(1, 4).map(Number);
check('it is the same world: the player stands where the first one saved', eye && Math.abs(Number(eye[1]) - 1234) < 8 && Math.abs(Number(eye[3]) + 777) < 8, g.last);
check('it came from the cloud', world(g, 'Cloudy')?.id === first.id, JSON.stringify(world(g, 'Cloudy')));
await command(b.page, 'tp 1300 120 -777');
await wait(8000);
await command(b.page, 'save');
await wait(12000);
await b.page.evaluate((id) => globalThis.horizon.cloud.syncNow(id), first.id);
g = await until(b.page, (x) => world(x, 'Cloudy')?.status === 'synced' && world(x, 'Cloudy').rev > first.rev, 3000);
check('the second browser saves on top', world(g, 'Cloudy')?.rev > first.rev, JSON.stringify(world(g, 'Cloudy')));
await b.context.close();

// ---- 3. someone else gets the shared world ----
const c = await device(site, args('--name Bob'), { name: 'Bob' });
g = await until(c.page, (x) => /title true/.test(x.last) && x.cloud?.status === 'ready');
const shared = world(g, 'Cloudy');
check('someone else sees it shared, not theirs', shared && shared.mine === false && shared.status === 'cloud' && shared.owner === 'Ann', JSON.stringify(g.cloud?.items));
const got = await c.page.evaluate(async (id) => {
  await globalThis.horizon.cloud.fetchWorld(id);
  const db = await new Promise((resolve, reject) => { const r = indexedDB.open('horizon-web', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const keys = await new Promise((resolve) => { const r = db.transaction('files').objectStore('files').getAllKeys(); r.onsuccess = () => resolve(r.result); });
  return keys.filter((k) => String(k).startsWith('/horizon/saves/Cloudy/')).length;
}, shared?.id).catch((e) => String(e));
check('they get its files', got > 3, got);
g = await look(c.page);
check('it is among their worlds now', world(g, 'Cloudy')?.folder === 'Cloudy' && world(g, 'Cloudy').mine === false, JSON.stringify(world(g, 'Cloudy')));
await c.context.close();

}

// ---- 4. the WebSim way in ----
const websim = await serve('websim');
const d = await device(websim, `brand=websim&args=${encodeURIComponent('--name louis')}`, { user: 'louis' });
g = await until(d.page, (x) => /title true/.test(x.last) && x.cloud?.status === 'ready');
check('on WebSim the player is their account', g.cloud?.status === 'ready' && g.cloud.me?.name === 'louis' && g.cloud.websim === true, JSON.stringify(g.cloud).slice(0, 300));
check('no cloud code is made there', !g.code, g.code);
await d.context.close();
const e = await device(websim, `brand=websim&args=${encodeURIComponent('--name guest')}`);
g = await until(e.page, (x) => /title true/.test(x.last) && x.cloud && x.cloud.status !== 'off');
check('not signed in: the game still starts, no cloud', /title true/.test(g.last) && g.cloud?.status === 'guest', JSON.stringify(g.cloud).slice(0, 200));
await e.context.close();

// ---- 5. the Worlds panel says it ----
const panel = async (page, name) => {
  await page.evaluate(() => globalThis.wasmEdition.open('worlds', false));
  await wait(2500);
  if (out) await page.screenshot({ path: `${out}-${name}.png` });
  return page.evaluate(() => document.querySelector('#ed-panel-worlds')?.innerText ?? '');
};
const f = await device(websim, `brand=websim&args=${encodeURIComponent('--name louis')}`, { user: 'louis' });
await until(f.page, (x) => /title true/.test(x.last) && x.cloud?.status === 'ready');
let words = await panel(f.page, 'panel-websim');
check('the panel on WebSim names the account', /Cloud saves/.test(words) && /Signed in as louis/.test(words), words.slice(0, 400));
await f.context.close();
const h = await device(site, args('--name Cara'), { name: 'Cara' });
await until(h.page, (x) => /title true/.test(x.last) && x.cloud?.status === 'ready');
words = await panel(h.page, 'panel-site');
check('the panel on the site offers the cloud code', /Cloud saves/.test(words) && /Copy my cloud code/.test(words), words.slice(0, 400));
if (process.env.ONLY !== 'websim') check('and lists the shared world', /Shared worlds/.test(words) && /Cloudy/.test(words) && /Add to my worlds/.test(words), words.slice(0, 600));
await h.context.close();

await browser.close();
for (const s of servers) { s.child.kill(); fs.rmSync(s.data, { recursive: true, force: true }); }
result.ok = result.checks.every((x) => x.ok);
if (out) fs.writeFileSync(`${out}.json`, JSON.stringify(result, null, 1));
console.log(result.ok ? 'all passed' : `${result.checks.filter((x) => !x.ok).length} failed`);
process.exit(result.ok ? 0 : 1);
