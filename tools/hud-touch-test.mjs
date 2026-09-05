/**
 * Multi-touch HUD test: one finger holds the throttle pedal for ~4 s while a
 * second finger presses the right steering arrow. Asserts through
 * window.__game.stats() that the boat sped up (> 20 km/h) and its heading
 * changed. Exits non-zero on failure or on any console error.
 *
 *   node tools/hud-touch-test.mjs --gpu [--url http://localhost:5173/?mods=Hud&touch=1] [--shot]
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const url = getArg('url', 'http://localhost:5173/?mods=Hud&touch=1');
const gpu = has('gpu');
const hold = parseFloat(getArg('hold', '5'));
const width = 1180, height = 820;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gpuArgs = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11', '--disable-gpu-vsync', '--disable-frame-rate-limit'];
const swArgs = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'];
const browser = await puppeteer.launch({
  headless: !gpu,
  args: [...(gpu ? gpuArgs : swArgs), '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', `--window-size=${width},${height + 90}`, '--window-position=40,40'],
  defaultViewport: { width, height, hasTouch: true, isMobile: true, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
const errors = [];
const isShaderNoise = (t) => /X3595|X3577|Program Info Log/.test(t);
page.on('console', (m) => { if (m.type() === 'error' && !isShaderNoise(m.text()) && !/favicon|404/.test(m.text())) errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.stack || String(e)));

const fail = async (msg) => { console.error('FAIL:', msg); if (errors.length) console.error(errors.join('\n')); await browser.close(); process.exit(1); };

console.log(`> ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
async function waitBoot() {
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const ok = await page.evaluate(() => !!(window.__game && window.__game.state !== 'boot' && window.__app?.running && window.__game.hud)).catch(() => false);
    if (ok) return true;
  }
  return false;
}
if (!await waitBoot()) await fail('game did not boot');
await sleep(2000);
// A Vite full reload (someone saving a module while the test runs) destroys the
// page context; wait for the game to boot again and retry once.
const rawEvaluate = page.evaluate.bind(page);
page.evaluate = async (...a) => {
  try { return await rawEvaluate(...a); }
  catch (e) {
    if (!/context was destroyed|Cannot find context|detached/i.test(String(e))) throw e;
    console.log('> page reloaded under us, waiting for it to boot again');
    if (!await waitBoot()) throw e;
    await sleep(1500);
    return rawEvaluate(...a);
  }
};

const rect = (sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return null;
  const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, visible: r.width > 0 && getComputedStyle(e).visibility !== 'hidden' };
}, sel);

const throttle = await rect('.wr-touch.is-on .wr-throttle');
const right = await rect('.wr-touch.is-on .wr-arrow-r');
const wheel = await rect('.wr-touch.is-on .wr-wheel');
if (!throttle?.visible || !right?.visible || !wheel?.visible) await fail(`touch controls not visible: ${JSON.stringify({ throttle, right, wheel })}`);
if (throttle.w < 64 || throttle.h < 64 || right.w < 64 || right.h < 64) await fail(`touch targets under 64px: ${JSON.stringify({ throttle, right })}`);
console.log(`> throttle at ${throttle.x | 0},${throttle.y | 0} (${throttle.w | 0}x${throttle.h | 0}), right arrow at ${right.x | 0},${right.y | 0}`);

const stats = () => page.evaluate(() => window.__game.stats());
const s0 = await stats();
console.log(`> start: ${s0.speedKmh} km/h, heading ${s0.heading}`);

// Finger 1: hold throttle. Finger 2: press the right arrow a second later.
const f1 = await page.touchscreen.touchStart(throttle.x, throttle.y);
await sleep(1000);
const f2 = await page.touchscreen.touchStart(right.x, right.y);
const t0 = Date.now();
let peak = 0;
while (Date.now() - t0 < (hold - 1) * 1000) {
  await sleep(400);
  const s = await stats();
  peak = Math.max(peak, s.speedKmh);
  const v = await page.evaluate(() => ({ ...window.__game.controls._virtual }));
  process.stdout.write(`  t+${((Date.now() - t0) / 1000).toFixed(1)}s ${String(s.speedKmh).padStart(5)} km/h  heading ${s.heading}  virtual thr=${v.throttle} steer=${v.steer} active=${v.active}\n`);
}
const mid = await stats();
peak = Math.max(peak, mid.speedKmh);
const virt = await page.evaluate(() => ({ ...window.__game.controls._virtual }));
if (has('shot')) { fs.mkdirSync('tools/shots', { recursive: true }); await page.screenshot({ path: path.resolve('tools/shots/hud-touch-hold.png') }); }
await f2.end();
await f1.end();
await sleep(300);
const after = await page.evaluate(() => ({ ...window.__game.controls._virtual, down: document.querySelectorAll('.wr-touch .is-down').length }));

// Phase 2: drag the steering wheel a quarter turn anticlockwise; steer must go negative
// and the wheel must spring back to centre after release.
const wr = await rect('.wr-touch.is-on .wr-wheel');
const r = wr.w * 0.36;
const fw = await page.touchscreen.touchStart(wr.x, wr.y - r);
for (let i = 1; i <= 8; i++) {
  const a = -Math.PI / 2 - (Math.PI / 2) * (i / 8);
  await fw.move(wr.x + r * Math.cos(a), wr.y + r * Math.sin(a));
  await sleep(40);
}
await sleep(200);
const wheelVirt = await page.evaluate(() => ({ ...window.__game.controls._virtual, deg: window.__game.hud._wheel.angle }));
await fw.end();
await sleep(700);
const wheelAfter = await page.evaluate(() => ({ ...window.__game.controls._virtual, deg: window.__game.hud._wheel.angle }));
console.log(`> wheel drag: steer ${wheelVirt.steer.toFixed(2)} at ${wheelVirt.deg.toFixed(0)} deg; after release steer ${wheelAfter.steer} at ${wheelAfter.deg} deg`);

const dHeading = Math.abs(Math.atan2(Math.sin(mid.heading - s0.heading), Math.cos(mid.heading - s0.heading)));
console.log(`> after hold: ${mid.speedKmh} km/h (peak ${peak}), heading change ${dHeading.toFixed(3)} rad; virtual during hold ${JSON.stringify(virt)}`);
console.log(`> after release: virtual ${JSON.stringify(after)}`);

const problems = [];
if (!(virt.throttle === 1 && virt.steer > 0.9 && virt.active)) problems.push('virtual controls did not reflect both fingers (throttle=1, steer=+1, active)');
if (!(peak > 20)) problems.push(`speed did not exceed 20 km/h (peak ${peak})`);
if (!(dHeading > 0.05)) problems.push(`heading barely changed (${dHeading.toFixed(3)} rad)`);
if (after.throttle !== 0 || after.steer !== 0 || after.active || after.down !== 0) problems.push('controls did not release after fingers lifted');
if (!(wheelVirt.steer < -0.5 && wheelVirt.active)) problems.push(`wheel drag did not steer left (steer ${wheelVirt.steer})`);
if (!(wheelAfter.steer === 0 && !wheelAfter.active)) problems.push('wheel did not spring back after release');
if (errors.length) problems.push(`${errors.length} console error(s)`);

if (problems.length) await fail(problems.join('; '));
console.log('PASS: multi-touch throttle + steer drove the boat, wheel drag steers and springs back, controls released cleanly, no console errors');
await browser.close();
process.exit(0);
