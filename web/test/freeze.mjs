// Plays a new world until the page stops answering, then pauses it in the
// debugger and prints where the page's thread is stuck.
//   node test/freeze.mjs DIST "args" [seconds]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [dist, args, seconds = '300'] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => {
  const file = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(0);
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan',
    '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-vulkan-surface', '--disable-audio-output'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Debugger.enable');
await page.goto(`http://127.0.0.1:${server.address().port}/?args=${encodeURIComponent(args)}`);
const started = Date.now();
let last = '';
let playing = false;
let same = 0;
while (Date.now() - started < Number(seconds) * 1000) {
  const answer = await Promise.race([
    page.evaluate(() => globalThis.horizon?.lines?.at(-1) ?? ''),
    new Promise((r) => setTimeout(() => r(null), playing ? 20000 : 120000)),
  ]).catch((e) => String(e));
  if (answer === null) {
    console.log(`frozen at t=${Math.round((Date.now() - started) / 1000)}s; last line: ${last}`);
    const paused = new Promise((r) => cdp.once('Debugger.paused', r));
    await cdp.send('Debugger.pause');
    const event = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 20000))]);
    if (!event) console.log('could not pause');
    else for (const f of event.callFrames.slice(0, 60)) console.log('  ', f.functionName || '(anonymous)', f.url.split('/').pop(), f.location.lineNumber);
    break;
  }
  same = answer.slice(0, 200) === last ? same + 1 : 0;
  if (playing && same >= 6) {
    const dump = await page.evaluate(() => ({ errors: globalThis.horizon.errors, lines: globalThis.horizon.lines.slice(-25), shader: globalThis.horizon.shaderErrors })).catch((e) => String(e));
    console.log('stalled:', JSON.stringify(dump, null, 1).slice(0, 6000));
    break;
  }
  last = answer.slice(0, 200);
  if (/eye Some/.test(answer)) playing = true;
  console.log(`t=${Math.round((Date.now() - started) / 1000)}s ${last}`);
  await new Promise((r) => setTimeout(r, 5000));
}
await browser.close().catch(() => {});
server.close();
process.exit(0);
