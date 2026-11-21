// The game's own menu reaching the page (docs/web.md): starts the game, clicks
// the title screen's "WASM Edition..." (the panel must open over the canvas),
// closes it, then clicks Quit Game (the page must come back with its Play
// dialog). Writes OUT-panel.png and OUT-quit.png.
//   node test/menu.mjs DIST OUT [brand]   (plain by default: it auto-starts with a saved name)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [dist, out, brand = 'plain'] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.ttf': 'font/ttf', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const target = file.endsWith('/') ? path.join(file, 'index.html') : file;
  fs.readFile(target, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const browser = await chromium.launch({
  executablePath: process.env.CHROME || undefined,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan',
    '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-vulkan-surface', '--disable-audio-output'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
// As a returning player on the plain brand: a saved name, so the page starts the game by itself.
await page.addInitScript(() => { try { localStorage.setItem('horizon.name', 'Tester'); } catch { /* no storage */ } });
await page.goto(`http://127.0.0.1:${server.address().port}/?brand=${brand}`);
console.log('auto-start:', await page.evaluate(() => globalThis.wasmEdition.autoStart));
const wait = (ms) => page.waitForTimeout(ms);
const title = async () => /title true/.test(await page.evaluate(() => globalThis.horizon?.lines?.at(-1) ?? ''));
for (let i = 0; i < 24 && !(await title()); i++) await wait(5000);
console.log('title screen up:', await title(), 'websim brand:', await page.evaluate(() => globalThis.wasmEdition.isWebSim()));
// GUI scale 2 at 960x540: the third button is 200x20 at (140, 163) GUI pixels.
const click = async (x, y) => { await page.mouse.move(x, y); await wait(1500); await page.mouse.down(); await wait(300); await page.mouse.up(); await wait(4000); };
await click(480, 346);
console.log('panel open after "WASM Edition...":', await page.evaluate(() => globalThis.wasmEdition.isOpen()));
await page.screenshot({ path: `${out}-panel.png` });
await page.keyboard.press('Escape');
await wait(1500);
console.log('panel closed by Escape:', !(await page.evaluate(() => globalThis.wasmEdition.isOpen())), 'still on title:', await title());
// Quit Game: the right half of the bottom row, (242, 211) GUI pixels.
await Promise.all([page.waitForNavigation({ timeout: 30000 }).catch(() => null), click(580, 442)]);
await wait(4000);
console.log('after Quit Game:', await page.evaluate(() => ({
  menuFlag: sessionStorage.getItem('wasmEdition.menu'),
  play: Boolean(document.getElementById('play')?.offsetParent),
  started: Boolean(globalThis.horizon?.lines?.length),
})));
await page.screenshot({ path: `${out}-quit.png` });
console.log('errors:', errors.filter((e) => !/404|pointer lock/.test(e)).slice(0, 5));
await browser.close();
server.close();
