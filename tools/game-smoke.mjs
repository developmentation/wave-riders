/**
 * Boots the boat game in Chrome, drives the boat with the keyboard, samples
 * frame time and writes screenshots to tools/shots/.
 *
 *   node tools/game-smoke.mjs --gpu                      # default drive test
 *   node tools/game-smoke.mjs --gpu --seconds 20 --tag storm --url "http://localhost:5173/?boat=jetski"
 *   node tools/game-smoke.mjs --gpu --script "W:6,A:2,W:4"  # key presses (code:seconds)
 *   node tools/game-smoke.mjs --gpu --poke "game.setWeather('storm')"
 *   node tools/game-smoke.mjs --gpu --touch               # emulate a tablet (viewport + touch)
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const url = getArg('url', 'http://localhost:5173/');
const seconds = parseFloat(getArg('seconds', '14'));
const gpu = has('gpu');
const tag = getArg('tag', 'game');
const touch = has('touch');
const script = getArg('script', 'W:5,D:1.5,W:3,A:1.5,W:2');
const outDir = path.resolve('tools/shots');
fs.mkdirSync(outDir, { recursive: true });

const gpuArgs = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11', '--disable-gpu-vsync', '--disable-frame-rate-limit'];
const swArgs = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'];
const width = parseInt(getArg('width', touch ? '1180' : '1280'), 10), height = parseInt(getArg('height', touch ? '820' : '720'), 10);

const browser = await puppeteer.launch({
  headless: gpu ? false : true,
  args: [...(gpu ? gpuArgs : swArgs), '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height + 90}`, '--window-position=40,40'],
  defaultViewport: { width, height, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
if (touch) await page.setUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
const logs = [];
page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: e.stack || String(e) }));
page.on('requestfailed', (r) => logs.push({ type: 'requestfailed', text: `${r.url()} :: ${r.failure()?.errorText}` }));

console.log(`> ${url} (gpu=${gpu}, touch=${touch}, ${width}x${height})`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let booted = false;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const s = await page.evaluate(() => ({
    ok: !!(window.__game && window.__game.state !== 'boot' && window.__app?.running),
    err: document.getElementById('booterr')?.textContent || '',
  })).catch(() => ({ ok: false, err: '' }));
  if (s.err) { console.log('BOOT ERROR:\n' + s.err); break; }
  if (s.ok) { booted = true; console.log(`> booted after ${(i + 1) * 0.5}s`); break; }
}

async function shot(name) {
  const f = path.join(outDir, `${tag}-${name}.png`);
  await page.screenshot({ path: f });
  console.log(`> screenshot ${f}`);
}
const stats = () => page.evaluate(() => window.__game?.stats?.());

const poke = getArg('poke', '');
// --late "seconds:js" runs a second poke that many seconds into the drive script.
const late = getArg('late', '');
const lateAt = late ? parseFloat(late.split(':')[0]) : -1;
const lateJs = late ? late.slice(late.indexOf(':') + 1) : '';
let lateDone = false;
if (booted && poke) {
  await page.evaluate((p) => { new Function('app', 'game', `with(app){${p}}`)(window.__app, window.__game); }, poke);
  console.log(`> poke ${poke}`);
}

const samples = [];
if (booted) {
  await sleep(1500);
  await shot('start');
  let t = 0;
  const keyName = (k) => ({ W: 'KeyW', A: 'KeyA', S: 'KeyS', D: 'KeyD', SPACE: 'Space', R: 'KeyR', C: 'KeyC' })[k] || k;
  const steps = script.split(',').filter(Boolean).map(s => { const [k, d] = s.split(':'); return { key: keyName(k), dur: parseFloat(d || '1') }; });
  const held = new Set(['KeyW']);
  for (const st of steps) {
    if (t >= seconds) break;
    await page.keyboard.down(st.key);
    const dur = Math.min(st.dur, seconds - t);
    const t0 = Date.now();
    while (Date.now() - t0 < dur * 1000) {
      await sleep(500);
      const s = await stats();
      const now = t + (Date.now() - t0) / 1000;
      if (s) samples.push({ t: +now.toFixed(1), ...s });
      if (lateJs && !lateDone && now >= lateAt) {
        lateDone = true;
        await page.evaluate((p) => { new Function('app', 'game', `with(app){${p}}`)(window.__app, window.__game); }, lateJs).catch(e => console.log('late poke failed', e.message));
        console.log(`> late poke at ${now.toFixed(1)}s`);
      }
    }
    if (st.key !== 'KeyW') await page.keyboard.up(st.key);
    t += dur;
    await shot(`t${String(Math.round(t)).padStart(3, '0')}`);
  }
  for (const k of held) await page.keyboard.up(k);
}

const final = await page.evaluate(() => ({
  bootErr: (document.getElementById('booterr')?.textContent || '').slice(0, 2000),
  game: window.__game?.stats?.(),
  caps: window.__app?.caps?.renderer,
  gpu: window.__app?.profiler?.enabled ? window.__app.profiler.report() : null,
}));
console.log('\n=========== SAMPLES (t, ms, km/h, pos, sub) ===========');
for (const s of samples) console.log(`${String(s.t).padStart(5)}s  ${String(s.ms).padStart(6)} ms  ${String(s.speedKmh).padStart(5)} km/h  ${JSON.stringify(s.pos)}  sub ${s.submersion}  sea ${s.seaHeight}  fb ${s.fallbacks}`);
const steady = samples.filter(s => s.t > 4).map(s => s.ms).sort((a, b) => a - b);
if (steady.length) console.log(`\n> steady-state frame time: median ${steady[Math.floor(steady.length / 2)]} ms, best ${steady[0]} ms  (${final.game?.res}, ${final.game?.preset})`);
console.log(`> renderer: ${final.caps}`);
if (final.gpu?.zones?.length) { console.log('\n--- GPU passes ---'); for (const z of final.gpu.zones) console.log(`  ${z.name.padEnd(12)} ${String(z.ms).padStart(8)} ms`); }
fs.writeFileSync(path.join(outDir, `${tag}-state.json`), JSON.stringify({ final, samples }, null, 2));

console.log('\n=========== LOGS ===========');
const seen = new Set(); let errCount = 0;
for (const l of logs) {
  if (l.type === 'error' || l.type === 'pageerror') errCount++;
  const key = l.type + '|' + l.text.slice(0, 160);
  if (seen.has(key)) continue; seen.add(key);
  if (['log', 'debug', 'info'].includes(l.type)) continue;
  if (l.text.includes('favicon')) continue;
  console.log(`--- [${l.type}] ---\n${l.text.slice(0, 1500)}\n`);
}
console.log(`> ${logs.length} messages, ${errCount} errors`);
await browser.close();
process.exit(errCount > 0 || final.bootErr || !booted ? 1 : 0);
