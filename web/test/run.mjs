// Drives the browser build headless (docs/web.md): serves DIST (with its pack/),
// opens the page with ?args=..., waits, and writes a screenshot and a JSON report
// (the game's last log lines, panics, shader errors, memory). Meant for nc2, inside
//   systemd-run --scope -p MemoryMax=3G node web/test/run.mjs DIST OUT "ARGS" SECONDS
// so a runaway tab is killed by the kernel, never the machine.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const [dist, out, args = '', seconds = '60'] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
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
const port = server.address().port;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME || undefined,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader',
    '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
    '--disable-vulkan-surface', '--disable-audio-output', '--js-flags=--max-old-space-size=1024'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const consoleTail = [];
page.on('console', (m) => { consoleTail.push(`[${m.type()}] ${m.text().split('\n')[0]}`); if (consoleTail.length > 80) consoleTail.shift(); });
page.on('pageerror', (e) => consoleTail.push(`[pageerror] ${e.message}`));
const started = Date.now();
await page.goto(`http://127.0.0.1:${port}/?args=${encodeURIComponent(args)}`);
const deadline = started + Number(seconds) * 1000;
let report = {};
while (Date.now() < deadline) {
  await page.waitForTimeout(5000);
  report = await page.evaluate(() => ({
    t: Math.round(performance.now() / 1000),
    status: document.getElementById('boot-status')?.textContent,
    lines: globalThis.horizon?.lines?.slice(-40) ?? [],
    errors: globalThis.horizon?.errors ?? [],
    shaderErrors: globalThis.horizon?.shaderErrors ?? [],
    wasmMB: globalThis.horizon?.state?.memory ? Math.round(globalThis.horizon.state.memory.buffer.byteLength / 1048576) : 0,
  })).catch((e) => ({ evalError: String(e) }));
  console.log(`t=${report.t}s wasm=${report.wasmMB}MB errors=${report.errors?.length} last=${(report.lines?.at(-1) || '').slice(0, 120)}`);
  if (report.errors?.length) break;
}
await page.screenshot({ path: `${out}.png` }).catch(() => {});
// Headless screenshots miss the WebGPU canvas: copy the canvas itself, right
// after a frame, through a 2D canvas.
const shot = await page.evaluate(() => Promise.race([
  globalThis.horizon.snapshot(),
  new Promise((resolve) => setTimeout(() => resolve('no frame in 30 s'), 30000)),
])).catch((e) => String(e));
if (shot?.startsWith('data:image/png;base64,')) {
  fs.writeFileSync(`${out}-canvas.png`, Buffer.from(shot.slice(22), 'base64'));
} else console.log('canvas copy:', shot, JSON.stringify(await page.evaluate(() => globalThis.horizon.snapshotState?.())));
fs.writeFileSync(`${out}.json`, JSON.stringify({ ...report, consoleTail }, null, 1));
await browser.close();
server.close();
