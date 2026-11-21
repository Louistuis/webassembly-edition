// Sound in the browser build (docs/web.md): opens a world, plays a short sound
// and a record with /playsound, and prints what the page's output did: buffers
// scheduled, the loudest sample, what the browser decoded, which sound chunks
// were fetched. The record's chunk comes when the game asks for it.
//   node test/sound.mjs DIST OUT [seconds]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [dist, out, seconds = '240'] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.ttf': 'font/ttf' };
const fetched = [];
const server = http.createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (/sound-/.test(file)) fetched.push(path.basename(file));
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
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('pageerror', e.message.slice(0, 300)));
const warnings = [];
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text().split('\n')[0].slice(0, 200)); });
await page.goto(`http://127.0.0.1:${port}/?args=${encodeURIComponent('--world S --creative --render-distance 2 --name Ears')}`);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + Number(seconds) * 1000;
const look = () => page.evaluate(() => ({
  last: globalThis.horizon?.lines?.at(-1) ?? '',
  errors: globalThis.horizon?.errors ?? [],
  audioLines: (globalThis.horizon?.lines ?? []).filter((l) => /audio|sound/i.test(l)).slice(-8),
  stats: { ...globalThis.horizonAudio?.stats },
  wasmMB: globalThis.horizon?.state?.memory ? Math.round(globalThis.horizon.state.memory.buffer.byteLength / 1048576) : 0,
})).catch((e) => ({ e: String(e) }));
const command = (line) => page.evaluate((l) => globalThis.horizon.command(l), line);
const quiet = () => page.evaluate(() => { globalThis.horizonAudio.stats.peak = 0; });

let g = {};
while (Date.now() < deadline) {
  await wait(5000);
  g = await look();
  if (g.errors?.length || /eye Some/.test(g.last)) break;
}
console.log('in the world:', /eye Some/.test(g.last), JSON.stringify(g.stats), g.audioLines);
const result = { world: /eye Some/.test(g.last), opened: g.stats?.state };

// A short sound whose chunk is not here yet is skipped and its chunk fetched:
// play it, wait for the chunk, play it again and listen.
await quiet();
await command('chat /playsound minecraft:entity.pig.ambient master @s ~ ~ ~ 1 1');
await wait(8000);
result.first = (await look()).stats;
await quiet();
await command('chat /playsound minecraft:entity.pig.ambient master @s ~ ~ ~ 1 1');
await wait(8000);
result.short = (await look()).stats;
console.log('short sound:', JSON.stringify(result.first), JSON.stringify(result.short));

// A record is a stream: its own chunk, decoded by the browser.
await quiet();
await command('chat /playsound minecraft:music_disc.cat record @s ~ ~ ~ 1 1');
let record = {};
for (let i = 0; i < 12 && Date.now() < deadline; i++) {
  await wait(5000);
  record = await look();
  if (record.stats?.decoded && record.stats.peak > 0.001) break;
}
result.record = record.stats;
console.log('record:', JSON.stringify(record.stats));

g = await look();
result.errors = g.errors;
result.wasmMB = g.wasmMB;
result.fetched = fetched;
result.warnings = warnings.slice(-12);
result.audioLines = g.audioLines;
result.ok = result.world && result.opened === 'running' && result.short?.peak > 0.001
  && result.record?.decoded >= 1 && result.record?.peak > 0.001 && !g.errors?.length;
console.log(JSON.stringify(result, null, 1));
if (out) fs.writeFileSync(`${out}.json`, JSON.stringify(result, null, 1));
await browser.close();
server.close();
process.exit(result.ok ? 0 : 1);
