/**
 * In-process A/B cost of the submarine world: profiler zones with The Deep Run
 * visible and the underwater look on, then the same frame with the world hidden
 * and the surface look (world.devHold), then on again. Same process, so machine
 * load cancels out.
 *   node tools/sub-ab.mjs [--shot name] [--settle 6] [--rounds 3] [--mode all|look|world] [--url ...]
 */
import puppeteer from 'puppeteer';
const args = process.argv.slice(2);
const get = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const url = get('url', 'http://localhost:5173/?mods=SubmarineWorld&debug=1&profile=1&adaptive=0&preset=game');
const shot = get('shot', '');
const settle = parseFloat(get('settle', '6'));
const browser = await puppeteer.launch({ headless: false, args: ['--ignore-gpu-blocklist', '--use-angle=d3d11', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--no-sandbox', '--window-size=1280,810', '--window-position=40,40'], defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 } });
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { const t = m.text(); if (t.includes('[SubmarineWorld]') || m.type() === 'error') logs.push(`[${m.type()}] ${t}`); });
page.on('pageerror', (e) => logs.push('[pageerror] ' + (e.stack || e)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 120; i++) { await sleep(500); const ok = await page.evaluate(() => !!(window.__game && window.__game.state !== 'boot' && window.__app?.running)).catch(() => false); if (ok) break; }
await sleep(1500);
const zones = async (label) => {
  await page.evaluate(() => window.__app.profiler.reset());
  await sleep(settle * 1000);
  const r = await page.evaluate(() => ({ z: window.__app.profiler.report().zones, ms: window.__app.quality.averageMs, res: `${window.__app.renderWidth}x${window.__app.renderHeight}` }));
  console.log(`--- ${label} (${r.res}, frame ${r.ms.toFixed(1)} ms)`);
  for (const z of r.z) console.log(`  ${z.name.padEnd(12)} ${String(z.ms).padStart(8)} ms`);
  return r;
};
if (shot) { await sleep(1000); await page.screenshot({ path: `tools/shots/${shot}.png` }); console.log('> screenshot tools/shots/' + shot + '.png'); }
const rounds = parseInt(get('rounds', '3'), 10);
const mode = get('mode', 'all');   // all | look (post/sky uniforms only) | world (geometry only)
const A = [], B = [];
for (let k = 0; k < rounds; k++) {
  await page.evaluate(() => { window.__subWorld.devHold = false; window.__subWorld.devHoldLook = false; window.__subWorld.devWorldOff = false; }); await sleep(800);
  A.push(await zones(`A${k}: deep world, submerged`));
  await page.evaluate((m) => {
    const w = window.__subWorld;
    if (m === 'look') w.devHoldLook = true; else if (m === 'world') w.devWorldOff = true; else w.devHold = true;
  }, mode);
  await sleep(800);
  B.push(await zones(`B${k}: ${mode === 'look' ? 'world visible, surface look' : mode === 'world' ? 'world hidden, underwater look' : 'world hidden, surface look'}`));
}
const med = (arr) => { const s = [...arr].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const d = (n) => { const g = (rs) => rs.map(r => r.z.find(z => z.name === n)?.ms ?? 0); const f = (rs) => med(g(rs)), mn = (rs) => Math.min(...g(rs)); return `${n.padEnd(8)} median A ${f(A).toFixed(2)} / B ${f(B).toFixed(2)} => +${(f(A) - f(B)).toFixed(2)} ms   min A ${mn(A).toFixed(2)} / B ${mn(B).toFixed(2)} => +${(mn(A) - mn(B)).toFixed(2)} ms`; };
console.log('DELTA (medians over rounds)'); for (const n of ['scene', 'post', 'clouds', 'oceanFFT']) console.log(d(n));
console.log('\nLOGS'); for (const l of logs) console.log(l);
await browser.close();
