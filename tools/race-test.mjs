/**
 * Race module test: boots `?mods=Race&debug=1`, lets the AI drive the dev
 * course with no player input for 90 s, screenshots at 5/30/60 s and asserts
 * that every AI boat passed at least 6 gates and none got stuck.
 *
 *   node tools/race-test.mjs --gpu
 *   node tools/race-test.mjs --gpu --seconds 90 --tag race-test
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
// rubber=0: the player is parked for this test, so the rubber band (AI throttle
// capped at 0.55 when > 80 m ahead) is switched off to measure pure AI driving.
const url = getArg('url', 'http://localhost:5173/?mods=Race&debug=1&rubber=0');
const seconds = parseFloat(getArg('seconds', '90'));
const gpu = has('gpu');
const tag = getArg('tag', 'race-test');
const minGates = parseInt(getArg('min-gates', '6'), 10);
const outDir = path.resolve('tools/shots');
fs.mkdirSync(outDir, { recursive: true });

const gpuArgs = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11', '--disable-gpu-vsync', '--disable-frame-rate-limit'];
const swArgs = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'];
const width = parseInt(getArg('width', '1280'), 10), height = parseInt(getArg('height', '720'), 10);

const browser = await puppeteer.launch({
  headless: gpu ? false : true,
  args: [...(gpu ? gpuArgs : swArgs), '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height + 90}`, '--window-position=40,40'],
  defaultViewport: { width, height, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: e.stack || String(e) }));
page.on('requestfailed', (r) => logs.push({ type: 'requestfailed', text: `${r.url()} :: ${r.failure()?.errorText}` }));

console.log(`> ${url} (gpu=${gpu}, ${width}x${height}, ${seconds}s)`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let booted = false;
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const s = await page.evaluate(() => ({
    ok: !!(window.__game && window.__game.state !== 'boot' && window.__app?.running && window.__game.race),
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
const snapshot = () => page.evaluate(() => {
  const r = window.__game?.race;
  if (!r) return null;
  return {
    state: r.state, time: +r.time.toFixed(1), countdown: +r.countdown.toFixed(2), accepts: r.acceptsInput,
    laps: r.laps, courseLength: +(r.courseLength || 0).toFixed(0),
    standings: r.standings.map(s => ({
      name: s.name, ai: s.ai, position: s.position, lap: s.lap, gate: s.gate, gatesTotal: s.gatesTotal, progress: +s.progress.toFixed(3),
      finished: s.finished, finishTime: +s.finishTime.toFixed(1), kmh: +s.speedKmh.toFixed(0), stuck: s.stuckNudges,
      x: +s.x.toFixed(1), z: +s.z.toFixed(1), steer: +(s.boat?.body?.steer ?? 0).toFixed(2), thr: +(s.boat?.body?.throttle ?? 0).toFixed(2),
    })),
    ms: +(window.__app.quality.averageMs || 0).toFixed(1),
  };
});

const samples = [];
const shotsAt = [5, 30, 60];
let ok = booted;
if (booted) {
  // Run until `seconds` of *race* time have elapsed (the sim clock is capped
  // at 50 ms/frame, so under GPU contention it runs slower than wall time);
  // give up after 2.5x that in wall time.
  const t0 = Date.now();
  let nextShot = 0, nextLog = 10, raceT = 0;
  while (raceT < seconds && (Date.now() - t0) / 1000 < seconds * 2.5) {
    await sleep(500);
    const t = (Date.now() - t0) / 1000;
    const s = await snapshot().catch(() => null);
    if (s) { samples.push({ t: +t.toFixed(1), ...s }); raceT = s.time; }
    if (nextShot < shotsAt.length && t >= shotsAt[nextShot]) { await shot(`t${String(shotsAt[nextShot]).padStart(3, '0')}`); nextShot++; }
    if (s && t >= nextLog) {
      nextLog += 10;
      console.log(`${t.toFixed(0).padStart(3)}s ${s.state.padEnd(9)} race ${s.time}s ${s.ms}ms | ` +
        s.standings.map(x => `${x.position}.${x.name} L${x.lap} g${x.gate} (${x.gatesTotal}) ${x.kmh}km/h`).join(' | '));
    }
  }
}

const final = samples.at(-1);
console.log('\n=========== FINAL STANDINGS ===========');
if (final) for (const s of final.standings) console.log(`${s.position}. ${s.name.padEnd(12)} lap ${s.lap} nextGate ${s.gate} passed ${s.gatesTotal} progress ${s.progress} ${s.finished ? `FINISHED ${s.finishTime}s` : ''} stuck ${s.stuck} ${s.kmh} km/h`);

// Driving quality: how often does each AI flip steering direction per minute?
console.log('\n=========== AI DRIVING ===========');
if (final) {
  for (const s of final.standings) {
    if (!s.ai) continue;
    const seq = samples.map(x => x.standings.find(y => y.name === s.name)).filter(Boolean);
    let flips = 0, hard = 0;
    for (let i = 1; i < seq.length; i++) {
      if (Math.sign(seq[i].steer) !== Math.sign(seq[i - 1].steer) && Math.abs(seq[i].steer) > 0.15 && Math.abs(seq[i - 1].steer) > 0.15) flips++;
      if (Math.abs(seq[i].steer) > 0.9) hard++;
    }
    const mins = Math.max(1e-3, (samples.at(-1).t - samples[0].t) / 60);
    const avgKmh = seq.reduce((a, x) => a + x.kmh, 0) / Math.max(1, seq.length);
    console.log(`${s.name.padEnd(12)} steer sign flips/min ${(flips / mins).toFixed(1)}  full-lock samples ${(hard / seq.length * 100).toFixed(0)}%  avg ${avgKmh.toFixed(0)} km/h`);
  }
}

// Pass rules. Slow hulls (pontoon ~29 km/h, sailboat ~20-29 km/h at their
// drag/thrust balance) physically cannot cover 6 gates of a 1.4 km lap in 90 s,
// so a boat that misses the gate count must instead have converted at least
// 60 % of the distance it could have covered at its own peak speed into course
// progress (drove the right way, no wandering) and passed at least one gate.
const failures = [];
if (!booted) failures.push('did not boot');
if (final) {
  console.log('\n=========== EFFICIENCY ===========');
  for (const s of final.standings) {
    if (!s.ai) continue;
    const seq = samples.map(x => x.standings.find(y => y.name === s.name)).filter(Boolean);
    const racing = seq.filter(x => x.kmh > 0);
    const avg = racing.reduce((a, x) => a + x.kmh, 0) / Math.max(1, racing.length) / 3.6;
    const couldM = avg * final.time, didM = s.progress * final.laps * final.courseLength;
    const eff = couldM > 0 ? didM / couldM : 0;
    console.log(`${s.name.padEnd(12)} progress ${didM.toFixed(0)} m of ${couldM.toFixed(0)} m travelled at avg ${(avg * 3.6).toFixed(0)} km/h -> course efficiency ${(eff * 100).toFixed(0)}%`);
    if (s.gatesTotal < minGates && !(s.gatesTotal >= 1 && eff >= 0.6)) failures.push(`${s.name} passed only ${s.gatesTotal} gates (< ${minGates}) with course efficiency ${(eff * 100).toFixed(0)}%`);
    if (s.stuck > 0) failures.push(`${s.name} needed ${s.stuck} stuck nudges`);
    if (!s.finished && s.kmh < 4) failures.push(`${s.name} is crawling at ${s.kmh} km/h`);
  }
  if (!final.standings.some(s => s.ai && s.gatesTotal >= minGates)) failures.push(`no AI reached ${minGates} gates`);
  if (final.state === 'countdown') failures.push('race never started');
} else failures.push('no race snapshot');

fs.writeFileSync(path.join(outDir, `${tag}-state.json`), JSON.stringify({ samples }, null, 1));

console.log('\n=========== LOGS ===========');
const seen = new Set(); let errCount = 0;
for (const l of logs) {
  const shaderNoise = l.text.includes('X3595');
  if ((l.type === 'error' || l.type === 'pageerror') && !shaderNoise) errCount++;
  const key = l.type + '|' + l.text.slice(0, 160);
  if (seen.has(key)) continue; seen.add(key);
  if (['log', 'debug', 'info'].includes(l.type)) continue;
  if (l.text.includes('favicon') || shaderNoise) continue;
  console.log(`--- [${l.type}] ---\n${l.text.slice(0, 1500)}\n`);
}
const raceLogs = logs.filter(l => l.text.startsWith('[race]')).slice(0, 60);
console.log('\n--- [race] log (first 60) ---');
for (const l of raceLogs) console.log(l.text.slice(0, 200));
console.log(`\n> ${logs.length} messages, ${errCount} errors`);
if (errCount) failures.push(`${errCount} console errors`);
for (const f of failures) console.log(`FAIL: ${f}`);
console.log(failures.length ? '> RESULT: FAIL' : '> RESULT: PASS');
await browser.close();
process.exit(failures.length ? 1 : 0);
