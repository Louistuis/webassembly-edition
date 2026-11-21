// Screenshots and checks of the start screen and the WASM Edition panel
// (web/page/edition.js), both brands, desktop and phone. The game itself does
// not start: its files and code are held back, the page is plain HTML here.
//   node test/edition.mjs STAGE OUT_PREFIX
// Writes OUT_PREFIX-<brand>-<size>-<state>.png and prints a summary; exits 1 on
// console errors or failed checks.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const [dist, out] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png', '.gz': 'application/gzip' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // A locked file host that refuses every key (the key form).
  if (url.pathname.startsWith('/locked/')) { res.writeHead(401); res.end(); return; }
  const file = path.join(dist, decodeURIComponent(url.pathname).replace(/\/$/, '/index.html'));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

// A small world: level.dat (gzipped NBT with LevelName and LastPlayed), a region file.
function nbtString(name, value) {
  const n = Buffer.from(name), v = Buffer.from(value);
  return Buffer.concat([Buffer.from([8, 0, n.length]), n, Buffer.from([v.length >> 8, v.length & 255]), v]);
}
function nbtLong(name, value) {
  const n = Buffer.from(name), v = Buffer.alloc(8);
  v.writeBigInt64BE(BigInt(value));
  return Buffer.concat([Buffer.from([4, 0, n.length]), n, v]);
}
const levelDat = zlib.gzipSync(Buffer.concat([
  Buffer.from([10, 0, 0]), Buffer.from([10, 0, 4]), Buffer.from('Data'),
  nbtString('LevelName', 'Sunny Island'), nbtLong('LastPlayed', Date.now() - 3 * 3600e3), Buffer.from([0, 0]),
]));
const seed = {
  '/horizon/saves/Sunny Island/level.dat': [...levelDat],
  '/horizon/saves/Sunny Island/region/r.0.0.mca': [...Buffer.alloc(180 * 1024, 7)],
  '/horizon/saves/Sunny Island/playerdata/': null,
  '/horizon/saves/Old Castle/level.dat': [...zlib.gzipSync(Buffer.concat([Buffer.from([10, 0, 0]), nbtString('LevelName', 'Old Castle'), nbtLong('LastPlayed', Date.now() - 9 * 86400e3), Buffer.from([0])]))],
  '/horizon/saves/Old Castle/region/r.0.0.mca': [...Buffer.alloc(2.4 * 1024 * 1024, 3)],
  '/horizon/resourcepacks/Faithful Pixels 32x.zip': [...Buffer.alloc(3.1 * 1024 * 1024, 1)],
};

const AVATAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#FBBC05"/><rect x="2" y="2" width="1" height="1" fill="#181626"/><rect x="5" y="2" width="1" height="1" fill="#181626"/><rect x="2" y="5" width="4" height="1" fill="#181626"/></svg>';

const browser = await chromium.launch({ executablePath: process.env.CHROME, args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--disable-audio-output'] });
const problems = [];
const shots = [];

async function run(brand, size, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, acceptDownloads: true });
  const page = await context.newPage();
  const tag = `${brand}-${size}`;
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  // The game's files and code never load in these runs (requests stay pending).
  await page.route(/\/pack\/core-|horizon_bg\.wasm/, () => {});
  await page.route('https://avatars.test/**', (route) => route.fulfill({ contentType: 'image/svg+xml', body: AVATAR }));
  if (brand === 'websim') {
    await page.addInitScript(() => {
      globalThis.websim = { getCurrentUser: async () => ({ username: 'Louis', avatar_url: 'https://avatars.test/louis.svg' }) };
    });
  }
  const shoot = async (name) => {
    const file = `${out}-${tag}-${name}.png`;
    await page.waitForTimeout(450);
    await page.screenshot({ path: file });
    shots.push(file);
  };
  const check = (ok, what) => { if (!ok) problems.push(`${tag}: ${what}`); };
  const overflow = () => page.evaluate(() => {
    const d = document.documentElement;
    const body = document.querySelector('.ed[open] .ed-body');
    return { page: d.scrollWidth - innerWidth, panel: body ? body.scrollWidth - body.clientWidth : 0 };
  });
  const noOverflow = async (what) => {
    const o = await overflow();
    check(o.page <= 0 && o.panel <= 0, `horizontal overflow ${JSON.stringify(o)} at ${what}`);
  };

  // Auto-start: with nothing to ask, the card is only a loading splash; Quit Game brings the full card back.
  await page.goto(`${base}/?brand=${brand}`);
  await page.waitForFunction(() => globalThis.wasmEdition?.open && document.fonts.status === 'loaded');
  await page.waitForTimeout(300);
  const splash = await page.evaluate(() => ({ auto: document.documentElement.classList.contains('auto'), playing: document.getElementById('boot').classList.contains('playing') }));
  // WebSim (a user is known) starts on its own; the plain brand's first visit asks for a name.
  check(splash.auto === (brand === 'websim') && splash.playing === (brand === 'websim'), `auto-start ${JSON.stringify(splash)}`);
  if (brand === 'websim') {
    await shoot('splash');
    await Promise.all([page.waitForEvent('load'), page.evaluate(() => wasmEdition.quit())]);
    await page.waitForFunction(() => globalThis.wasmEdition?.open);
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => ({ auto: document.documentElement.classList.contains('auto'), playing: document.getElementById('boot').classList.contains('playing'), flag: sessionStorage.getItem('wasmEdition.menu') }));
    check(!after.auto && !after.playing && after.flag === '1', `after quit ${JSON.stringify(after)}`);
    await page.evaluate(() => sessionStorage.removeItem('wasmEdition.menu'));
  }
  await page.goto(`${base}/?brand=${brand}&menu=1`);
  await page.waitForFunction(() => globalThis.wasmEdition?.open && document.fonts.status === 'loaded');
  check(await page.evaluate(() => typeof wasmEdition.isWebSim === 'function' && wasmEdition.isWebSim() === wasmEdition.websim), 'isWebSim()');
  check(await page.evaluate((b) => wasmEdition.websim === (b === 'websim'), brand), 'brand detection');
  const title = await page.title();
  check(title === (brand === 'websim' ? 'Minecraft WebSim WASM Edition' : 'Minecraft WASM Edition'), `title "${title}"`);
  // Seed the browser's storage.
  await page.evaluate(async (files) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('horizon-web', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await new Promise((resolve) => {
      const t = db.transaction('files', 'readwrite');
      for (const [k, v] of Object.entries(files)) t.objectStore('files').put(v ? new Uint8Array(v) : new Uint8Array(0), k);
      t.oncomplete = resolve;
    });
  }, seed);
  await page.waitForTimeout(800);
  await noOverflow('start');
  await shoot('start');
  const text = await page.evaluate(() => document.body.innerText);
  check(!/horizon/i.test(text), 'start screen names Horizon');
  check(/Not affiliated with Mojang/.test(text), 'disclaimer on the start screen');
  check(!text.includes('—'), 'em dash on the start screen');
  if (brand === 'plain') {
    check(!/websim/i.test(text), 'plain start screen mentions WebSim');
    check(!(await page.evaluate(() => [...document.images].some((i) => i.currentSrc.includes('logo.png') || i.src.includes('logo.png')))), 'plain brand loads logo.png');
    const name = await page.inputValue('#name-input');
    check(/^[A-Za-z0-9_]{3,16}$/.test(name), `player name "${name}"`);
    await page.fill('#name-input', 'Lou is!');
    check(await page.inputValue('#name-input') === 'Louis', 'name field cleans input');
    const again = await context.newPage();
    await again.route(/\/pack\/core-|horizon_bg\.wasm/, () => {});
    await again.goto(`${base}/?brand=plain`);
    await again.waitForTimeout(500);
    check(await again.evaluate(() => document.documentElement.classList.contains('auto')), 'plain brand with a saved name did not auto-start');
    const file = `${out}-${tag}-splash.png`;
    await again.screenshot({ path: file });
    shots.push(file);
    await again.close();
  }

  // The error screen.
  await page.evaluate(() => globalThis.horizon.fail('This browser has no WebGPU. Use a current Chrome, Edge or Safari.'));
  await shoot('error');
  check(await page.evaluate(() => getComputedStyle(document.getElementById('fail')).display !== 'none'), 'error dialog hidden');

  // The panel opens over the running game: a stand-in for the game's picture
  // (bright blocks, so the blur shows), the start screen gone.
  await page.evaluate(() => {
    document.getElementById('boot').hidden = true;
    const fake = document.createElement('div');
    fake.id = 'fake-game';
    fake.style.cssText = 'position:fixed;inset:0;z-index:1;background:' + [
      'linear-gradient(180deg,#79a6ff 0 45%,transparent 45%)',
      'repeating-linear-gradient(90deg,#5d9b3a 0 64px,#4f8a31 64px 128px)',
    ].join(',') + ';';
    fake.innerHTML = '<div style="position:absolute;left:10%;top:30%;width:120px;height:120px;background:#8b5a2b"></div>'
      + '<div style="position:absolute;left:60%;top:20%;width:160px;height:160px;background:#2f6b2a"></div>'
      + '<div style="position:absolute;left:40%;top:60%;width:200px;height:80px;background:#3f76e4"></div>'
      + '<div style="position:absolute;left:4%;top:4%;font:20px monospace;color:#fff">Fake game picture</div>';
    document.body.append(fake);
  });

  // Each tab.
  for (const tab of ['settings', 'packs', 'worlds', 'credits']) {
    await page.evaluate((t) => wasmEdition.open(t, false), tab);
    await page.waitForSelector(`#ed-panel-${tab}:not([hidden]) > *`);
    check(await page.evaluate(() => wasmEdition.isOpen()), `${tab} did not open`);
    await noOverflow(tab);
    await shoot(tab);
    const tabText = await page.evaluate(() => document.querySelector('.ed').innerText);
    check(!tabText.includes('—'), `em dash in ${tab}`);
    if (tab !== 'credits') check(!/horizon/i.test(tabText), `${tab} names Horizon`);
    if (brand === 'plain' && tab !== 'settings') check(!/websim/i.test(tabText), `plain ${tab} mentions WebSim`);
    if (tab === 'credits' || tab === 'settings') {
      await page.evaluate(() => { const b = document.querySelector('.ed-body'); b.scrollTop = b.scrollHeight; });
      if (tab === 'credits') await page.click('.ed-license summary');
      await page.evaluate(() => { const b = document.querySelector('.ed-body'); b.scrollTop = b.scrollHeight; });
      await shoot(`${tab}-end`);
    }
  }
  check(/MIT License/.test(await page.evaluate(() => document.querySelector('.ed-license pre').textContent)), 'license text');

  // Escape closes, and the panel opens on a pack section.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  check(!(await page.evaluate(() => wasmEdition.isOpen())), 'Escape did not close');
  await page.waitForTimeout(300);
  check(!(await page.evaluate(() => document.getElementById('wasm-edition').open)), 'panel did not finish closing');
  await page.evaluate(() => wasmEdition.open('packs:shaderpacks', false));
  await page.waitForSelector('[data-section="shaderpacks"]');
  await shoot('packs-shaderpacks');

  // Upload a mod and a file of the wrong kind.
  await page.setInputFiles('[data-section="mods"] input[type=file]', { name: 'more-ores.hmod', mimeType: 'application/octet-stream', buffer: Buffer.alloc(42 * 1024, 9) });
  await page.waitForFunction(() => document.querySelector('[data-section="mods"] .ed-file-name')?.textContent === 'more-ores.hmod');
  check(await page.evaluate(async () => {
    const { state } = await import('./std.js');
    return state.files.get('/horizon/horizon-mods/more-ores.hmod')?.length === 42 * 1024;
  }), 'upload before start did not reach the game files');
  await page.setInputFiles('[data-section="resourcepacks"] input[type=file]', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
  await page.waitForFunction(() => document.querySelector('[data-section="resourcepacks"] .ed-status.bad'));
  await page.evaluate(() => document.querySelector('[data-section="mods"]').scrollIntoView());
  await shoot('packs-uploaded');

  // Drag and drop onto the shader packs section.
  await page.evaluate(() => {
    const section = document.querySelector('[data-section="shaderpacks"]');
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(5000)], 'Soft Glow.hshader'));
    section.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
    section.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => [...document.querySelectorAll('[data-section="shaderpacks"] .ed-file-name')].some((e) => e.textContent === 'Soft Glow.hshader'));

  // Worlds: download one, import it back, delete the copy.
  await page.evaluate(() => wasmEdition.open('worlds', false));
  await page.waitForSelector('.ed-worlds li strong');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.ed-worlds li:has-text("Sunny Island") >> text=Download')]);
  const zipPath = `${out}-${tag}-world.zip`;
  await download.saveAs(zipPath);
  const zipBytes = fs.readFileSync(zipPath);
  check(download.suggestedFilename() === 'Sunny Island.zip', `download name ${download.suggestedFilename()}`);
  check(zipBytes.includes(Buffer.from('Sunny Island/level.dat')) && zipBytes.readUInt32LE(zipBytes.length - 22) === 0x06054b50, 'downloaded zip');
  await page.setInputFiles('#ed-panel-worlds input[type=file]', zipPath);
  await page.waitForFunction(() => [...document.querySelectorAll('.ed-worlds li span')].some((e) => e.textContent.includes('Sunny Island (2)')));
  check(await page.evaluate(async () => {
    const { state } = await import('./std.js');
    return state.files.get('/horizon/saves/Sunny Island (2)/region/r.0.0.mca')?.length === 180 * 1024;
  }), 'imported world did not reach the game files');
  await shoot('worlds-imported');
  const copy = page.locator('.ed-worlds li', { hasText: 'Sunny Island (2)' });
  await copy.locator('button', { hasText: 'Delete' }).click();
  await page.waitForTimeout(150);
  await shoot('worlds-confirm');
  await copy.locator('button', { hasText: 'Delete forever?' }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.ed-worlds li span')].some((e) => e.textContent.includes('Sunny Island (2)')));

  // A deflated zip (made here) imports too.
  const deflated = deflateZip([['My Build/level.dat', levelDat], ['My Build/region/r.0.0.mca', Buffer.alloc(30000, 5)]]);
  await page.setInputFiles('#ed-panel-worlds input[type=file]', { name: 'my-build.zip', mimeType: 'application/zip', buffer: deflated });
  await page.waitForFunction(() => [...document.querySelectorAll('.ed-worlds li span')].some((e) => e.textContent.startsWith('My Build ·')) || document.querySelector('.ed-status.bad'));
  check(!(await page.$('.ed-status.bad')), `deflated import: ${await page.evaluate(() => document.querySelector('.ed-status')?.textContent)}`);

  // In a world, after the game started: the restart bar, disabled actions.
  await page.evaluate(async () => {
    const { session } = await import('./store.js');
    session.started = true;
    wasmEdition.close();
    wasmEdition.open('packs:mods', true);
  });
  await page.setInputFiles('[data-section="mods"] input[type=file]', { name: 'tiny-tweaks.hmod', mimeType: 'application/octet-stream', buffer: Buffer.alloc(9000, 2) });
  await page.waitForSelector('#ed-restart:not([hidden])');
  check(await page.evaluate(() => document.querySelector('#ed-restart button').disabled), 'restart enabled in a world');
  await shoot('ingame-packs');
  await page.evaluate(() => wasmEdition.open('worlds', true));
  await page.waitForSelector('#ed-panel-worlds .btn.green:disabled');
  check(await page.evaluate(() => [...document.querySelectorAll('.ed-worlds button')].filter((b) => /Delete/.test(b.textContent)).every((b) => b.disabled)), 'delete enabled in a world');
  await shoot('ingame-worlds');
  await page.evaluate(() => wasmEdition.open('settings', false));
  await page.waitForSelector('#ed-panel-settings:not([hidden]) .ed-card');
  await page.click('text=Delete all saved data');
  await page.evaluate(() => document.querySelector('.ed-confirm').scrollIntoView({ block: 'center' }));
  await shoot('settings-wipe-confirm');
  await page.click('button:has-text("Delete everything")');
  await page.waitForFunction(() => document.querySelector('.ed-confirm')?.textContent.includes('All saved data is gone'));
  const left = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('horizon-web', 1);
    req.onsuccess = () => { const r = req.result.transaction('files').objectStore('files').count(); r.onsuccess = () => resolve(r.result); };
  }));
  check(left === 0, `wipe left ${left} files`);
  await page.keyboard.press('Escape');

  // The key form (a locked host that refuses the key).
  if (size === 'phone' || brand === 'websim') {
    const locked = await context.newPage();
    locked.on('console', (m) => { if (m.type() === 'error' && !/401/.test(m.text())) errors.push(`locked: ${m.text()}`); });
    await locked.route(/\/pack\/core-|horizon_bg\.wasm/, () => {});
    await locked.addInitScript(() => { globalThis.HORIZON_FILES = `${location.origin}/locked/`; });
    await locked.goto(`${base}/?brand=${brand}`);
    await locked.waitForSelector('#key:not([hidden])');
    await locked.waitForTimeout(600);
    const file = `${out}-${tag}-locked.png`;
    await locked.screenshot({ path: file });
    shots.push(file);
    await locked.close();
  }

  for (const e of errors) problems.push(`${tag}: console: ${e.slice(0, 200)}`);
  await context.close();
}

// A zip with deflated entries, as most zip tools make them.
function deflateZip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name), comp = zlib.deflateRawSync(data), c = crc(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(c, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    parts.push(local, n, comp);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(c, 16); dir.writeUInt32LE(comp.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(n.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

for (const brand of ['websim', 'plain']) {
  for (const [size, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    try {
      await run(brand, size, viewport);
    } catch (e) {
      problems.push(`${brand}-${size}: ${e.message.split('\n')[0]}`);
    }
  }
}
await browser.close();
server.close();
console.log(`${shots.length} screenshots`);
if (problems.length) {
  console.log(`PROBLEMS (${problems.length}):\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('all checks passed');
