// A cheating guest: the host's strict movement and chat checks (docs/web.md).
// A host opens a world to LAN, a guest joins in survival and flies with the
// `fly` command (it moves the player whatever the server allows): too fast
// first, then hovering up. A second guest spams chat. Prints what the host
// logged and whether each guest was sent away.
//   node test/cheats.mjs DIST OUT [seconds]
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

const all = (page) => page.evaluate(() => globalThis.horizon?.lines ?? []).catch(() => []);
const status = async () => {
  await command(host, 'lan status');
  await wait(1500);
  const text = await replies(host);
  const line = (Array.isArray(text) ? text : String(text).split('\n')).filter((l) => l.includes('"guests"')).at(-1);
  try { return JSON.parse(line); } catch { return null; }
};
const join = async (name) => {
  const page = await open(`--server websim:${h.room} --render-distance 3 --name ${name}`);
  while (Date.now() < deadline) {
    await wait(5000);
    const g = await look(page);
    console.log(`${name} ${g.last.slice(0, 120)}`);
    if (g.errors?.length || /eye Some/.test(g.last) && /chunks [1-9]/.test(g.last)) break;
  }
  return page;
};

const host = await open('--world H --creative --render-distance 3 --name Host');
let h = {};
while (Date.now() < deadline) {
  await wait(5000);
  h = await look(host);
  if (h.errors?.length || /eye Some/.test(h.last)) break;
}
await command(host, 'lan open');
await wait(3000);
await replies(host);

// 1. Fly: survival, then far too fast sideways, then hovering upwards.
const flyer = await join('Flyer');
await command(host, 'chat /gamemode survival Flyer');
await wait(4000);
const before = (await status())?.guests?.find((g) => g.name === 'Flyer');
console.log('flyer before:', JSON.stringify(before?.position), 'mode', before?.game_mode);
const [x, y, z] = before.position;
await command(flyer, `fly ${x} ${y + 2} ${z} ${x + 200} ${y + 2} ${z} 4`);
await wait(12000);
const fast = (await status())?.guests?.find((g) => g.name === 'Flyer');
console.log('flyer after the dash:', JSON.stringify(fast?.position));
const [x2, y2, z2] = fast?.position ?? [x, y, z];
await command(flyer, `fly ${x2} ${y2 + 2} ${z2} ${x2} ${y2 + 8} ${z2} 12`);
await wait(25000);
const hovered = (await status())?.guests?.find((g) => g.name === 'Flyer');
console.log('flyer still in after hovering:', Boolean(hovered));

// 2. Chat spam from a second guest.
await flyer.close();
const spammer = await join('Spammer');
for (let i = 0; i < 15; i++) await command(spammer, `chat spam ${i}`);
await wait(8000);
const spammed = (await status())?.guests?.find((g) => g.name === 'Spammer');
console.log('spammer still in after 15 lines:', Boolean(spammed));

const lines = (await all(host)).filter((l) => /quickly|floating|wrongly|spam|left the game|lost connection|kick/i.test(l));
console.log('host log:\n ' + lines.slice(-20).join('\n '));
console.log('spammer log:', (await all(spammer)).filter((l) => /disconnect|kick|spam/i.test(l)).slice(-3));
fs.writeFileSync(`${out}-host.json`, JSON.stringify(await look(host), null, 1));
await browser.close();
server.close();
