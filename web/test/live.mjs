// The published copy end to end: opens URL, enters the access key (ACCESS_KEY
// env) when asked, presses Play if the page asks, waits for the game, saves
// OUT-canvas.png. Then clicks the game once (a browser opens sound only after
// that) and waits for the title music: prints what the page's output did.
//   node test/live.mjs URL OUT [seconds]
import { chromium } from 'playwright';
import fs from 'node:fs';

const [url, out, seconds = '90'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  args: ['--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-webgpu-adapter=swiftshader', '--enable-features=Vulkan',
    '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--disable-vulkan-surface', '--disable-audio-output'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const log = [];
page.on('console', (m) => log.push(m.text()));
await page.goto(url);
await page.waitForTimeout(4000);
const frame = page.frames().find((f) => f.url().includes('websim.com') && f !== page.mainFrame()) || page.mainFrame();
console.log('frame', frame.url());
if (await frame.locator('#key-input').isVisible().catch(() => false)) {
  await frame.fill('#key-input', process.env.ACCESS_KEY || '');
  await frame.click('#key button');
  console.log('key entered');
}
// The page starts the game by itself when it needs nothing more; otherwise Play.
for (let i = 0; i < 30; i++) {
  if (await frame.evaluate(() => Boolean(globalThis.horizon?.lines?.length)).catch(() => false)) break;
  if (await frame.locator('#play').isVisible().catch(() => false)) {
    await frame.click('#play');
    console.log('pressed Play');
    break;
  }
  await page.waitForTimeout(1000);
}
const deadline = Date.now() + Number(seconds) * 1000;
let state = {};
while (Date.now() < deadline) {
  await page.waitForTimeout(5000);
  state = await frame.evaluate(() => ({ status: document.getElementById('boot-status')?.textContent, last: globalThis.horizon?.lines?.at(-1), errors: globalThis.horizon?.errors })).catch((e) => ({ e: String(e) }));
  console.log(JSON.stringify(state).slice(0, 220));
  if (state.last?.includes('title true') || state.errors?.length) break;
}
// Sound, as a player gets it: one click, then the menu music's own chunk is
// fetched from the file host, decoded and played.
const canvas = frame.locator('body > canvas');
if (await canvas.count()) {
  await canvas.click({ position: { x: 6, y: 6 }, force: true }).catch((e) => console.log('click', String(e).slice(0, 120)));
  let sound = {};
  for (let i = 0; i < 24 && Date.now() < deadline + 120000; i++) {
    await page.waitForTimeout(5000);
    sound = await frame.evaluate(() => ({ ...globalThis.horizonAudio?.stats })).catch((e) => ({ e: String(e) }));
    if (sound.decoded && sound.peak > 0.001) break;
  }
  console.log('sound', JSON.stringify(sound), sound.state === 'running' && sound.decoded >= 1 && sound.peak > 0.001 ? 'OK' : 'SILENT');
}
const shot = await frame.evaluate(() => Promise.race([globalThis.horizon.snapshot(), new Promise((r) => setTimeout(() => r('none'), 30000))])).catch((e) => String(e));
if (shot?.startsWith('data:image/png;base64,')) fs.writeFileSync(`${out}-canvas.png`, Buffer.from(shot.slice(22), 'base64'));
await page.screenshot({ path: `${out}.png` });
fs.writeFileSync(`${out}.log`, log.join('\n'));
await browser.close();
