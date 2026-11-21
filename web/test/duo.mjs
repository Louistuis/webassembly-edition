// Two players: a host tab opens a world to LAN (through the room), a guest tab
// joins it. One browser, a local room (?room=local). Writes OUT-host/guest.json
// and OUT-host/guest-canvas.png.
//   node test/duo.mjs DIST OUT [seconds]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [dist, out, seconds = '150'] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan',
    '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-vulkan-surface', '--disable-audio-output',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
const open = async (args) => {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)));
  await page.goto(`http://127.0.0.1:${port}/?room=local&args=${encodeURIComponent(args)}`);
  return page;
};
const look = (page) => page.evaluate(() => ({
  last: globalThis.horizon?.lines?.at(-1) ?? '',
  lines: globalThis.horizon?.lines?.slice(-60) ?? [],
  errors: globalThis.horizon?.errors ?? [],
  wasmMB: globalThis.horizon?.state?.memory ? Math.round(globalThis.horizon.state.memory.buffer.byteLength / 1048576) : 0,
  room: globalThis.horizonNet?.id,
  games: globalThis.horizonNet?.games?.(),
})).catch((e) => ({ e: String(e) }));
const command = (page, line) => page.evaluate((l) => globalThis.horizon.command(l), line);
const replies = (page) => page.evaluate(() => globalThis.horizon.replies());
const started = Date.now();
const deadline = started + Number(seconds) * 1000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const host = await open('--world H --creative --render-distance 3 --name Host');
let h = {};
while (Date.now() < deadline) {
  await wait(5000);
  h = await look(host);
  console.log(`host t=${Math.round((Date.now() - started) / 1000)} ${h.wasmMB}MB ${h.last.slice(0, 150)}`);
  if (h.errors?.length || /eye Some/.test(h.last)) break;
}
await command(host, 'lan open');
await wait(3000);
console.log('host lan:', await replies(host), 'room', h.room);
const guest = await open(`--server websim:${h.room} --render-distance 3 --name Guest`);
let g = {};
while (Date.now() < deadline) {
  await wait(5000);
  g = await look(guest);
  h = await look(host);
  console.log(`guest ${g.wasmMB}MB ${g.last.slice(0, 160)}`);
  console.log(`host  ${h.last.slice(0, 120)}`);
  if (g.errors?.length || h.errors?.length || /eye Some/.test(g.last) && /chunks [1-9]/.test(g.last)) break;
}
await command(host, 'lan status');
await wait(2000);
console.log('host lan status:', (await replies(host)).slice(0, 400));
for (const [name, page] of [['host', host], ['guest', guest]]) {
  const shot = await page.evaluate(() => Promise.race([globalThis.horizon.snapshot(), new Promise((r) => setTimeout(() => r('none'), 20000))])).catch((e) => String(e));
  if (shot?.startsWith('data:image/png;base64,')) fs.writeFileSync(`${out}-${name}-canvas.png`, Buffer.from(shot.slice(22), 'base64'));
  fs.writeFileSync(`${out}-${name}.json`, JSON.stringify(await look(page), null, 1));
}
await browser.close();
server.close();
