/**
 * Audio module test: boots the game with ?mods=Audio, fakes a user gesture,
 * checks the AudioContext is running, then measures the output through the
 * module's render-thread tap (__audio.debugCapture) to assert that every boat
 * type's engine produces audible, non-clipping sound, that each one-shot is
 * audible over the idle engine, that ambient layers and music start/stop, and
 * that mute is silent. Fails on any console error from the audio module or the
 * page.
 *
 * The dev server does a full-page reload whenever a teammate saves a file, so
 * every step re-checks the page is booted and unlocked, and a step during which
 * a reload landed is discarded and retried.
 *
 *   node tools/audio-test.mjs            # headless (swiftshader)
 *   node tools/audio-test.mjs --gpu      # visible window, real GPU
 *   node tools/audio-test.mjs --url "http://localhost:5173/?mods=Audio&boat=jetski"
 */
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const url = getArg('url', 'http://localhost:5173/?mods=Audio');
const gpu = has('gpu');
const width = 960, height = 540;

const gpuArgs = ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11', '--disable-gpu-vsync'];
const swArgs = ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'];
const browser = await puppeteer.launch({
  headless: !gpu,
  args: [...(gpu ? gpuArgs : swArgs), '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required',
    `--window-size=${width},${height + 90}`],
  defaultViewport: { width, height, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const logs = [];
let reloads = 0;
page.on('console', (m) => logs.push({ type: m.type(), text: m.text() }));
page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: e.stack || String(e) }));
page.on('framenavigated', (f) => { if (f === page.mainFrame()) reloads++; });
page.on('error', (e) => { logs.push({ type: 'crash', text: String(e) }); console.log(`  (browser tab crashed: ${e})`); });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0;
const commit = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const fmt = (c) => `rms ${c.rms.toFixed(3)} peak ${c.peak.toFixed(3)} maxRms ${c.maxRms.toFixed(3)} over ${c.seconds.toFixed(1)} s`;

/** Wait for boot + Audio install, fake a gesture, wait for the audio clock to start. */
async function ensureReady() {
  const isReady = () => page.evaluate(() => !!(window.__game && window.__game.state !== 'boot' && window.__app?.running
    && window.__audio?.ctx?.state === 'running' && window.__audio.ctx.currentTime > 0.3)).catch(() => false);
  if (await isReady()) return true;
  for (let round = 0; round < 2; round++) {
    let booted = false;
    for (let i = 0; i < 90 && !booted; i++) {
      await sleep(500);
      booted = await page.evaluate(() => !!(window.__game && window.__game.state !== 'boot' && window.__app?.running && window.__audio)).catch(() => false);
    }
    if (booted) {
      await page.mouse.click(width / 2, height / 2);     // synthetic user gesture -> unlock()
      for (let i = 0; i < 60; i++) { if (await isReady()) break; await sleep(250); }   // fake audio sink may take seconds to start
      // Measurements want the engine alone unless a step asks for music.
      await page.evaluate(() => window.__audio.music(false)).catch(() => {});
      if (await isReady()) return true;
    }
    const why = await page.evaluate(() => ({
      state: window.__game?.state, running: !!window.__app?.running, audio: !!window.__audio, ctx: window.__audio?.ctx?.state,
      t: window.__audio?.ctx?.currentTime, bootErr: (document.getElementById('booterr')?.textContent || '').slice(0, 300),
    })).catch((e) => ({ error: String(e).slice(0, 200) }));
    console.log(`  (page not ready: ${JSON.stringify(why)}${round === 0 ? '; reloading' : ''})`);
    if (round === 0) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  return false;
}

/**
 * Run a step; its checks are buffered and only committed if no reload landed
 * while it ran (otherwise the step is retried, up to 3 attempts).
 */
async function step(name, fn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await ensureReady())) { commit(false, `${name}: page never became ready`); return; }
    const before = reloads, buffered = [];
    const check = (ok, msg) => buffered.push([ok, msg]);
    try { await fn(check); } catch (e) {
      if (attempt < 2 && (reloads !== before || /context was destroyed|navigation|detached|undefined/i.test(String(e)))) { console.log(`  (page reloaded during "${name}", retrying)`); continue; }
      commit(false, `${name}: ${String(e).slice(0, 300)}`); return;
    }
    if (reloads !== before && attempt < 2) { console.log(`  (page reloaded during "${name}", retrying)`); continue; }
    for (const [ok, msg] of buffered) commit(ok, msg);
    return;
  }
}

const capture = (s) => page.evaluate((sec) => window.__audio.debugCapture(sec), s);
const evalAudio = (code) => page.evaluate((c) => new Function('a', c)(window.__audio), code);
const duckEngine = (on) => evalAudio(`a.engineBus.gain.value = ${on ? 0.02 : 0.5}`);

console.log(`> ${url} (gpu=${gpu})`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
reloads = 0;

await step('unlock', async (check) => {
  const s = await page.evaluate(() => ({ state: window.__audio.ctx.state, t: window.__audio.ctx.currentTime, shared: window.__audio === window.__game.audio }));
  check(s.state === 'running', `AudioContext state is 'running' after a synthetic click (clock at ${s.t.toFixed(2)} s)`);
  check(s.shared, 'devInstall reuses the GameAudio owned by Game.js (single context)');
});

// Engine under a real held throttle (the player's speedboat, driven by Game.js).
await step('engine speedboat (KeyW)', async (check) => {
  await evalAudio('a.devEngineType = null; a.devEngineOverride = null');
  await duckEngine(false);
  await page.keyboard.down('KeyW');
  await sleep(2500);
  const c = await capture(2);
  const kmh = await page.evaluate(() => window.__game.player.body.speedKmh);
  await page.keyboard.up('KeyW');
  check(c.rms >= 0.02 && c.rms <= 0.6, `speedboat engine, W held (${kmh.toFixed(0)} km/h): ${fmt(c)} -> RMS in [0.02, 0.6]`);
  check(c.peak < 0.98, `speedboat engine not clipping (peak ${c.peak.toFixed(3)})`);
});
// The other rigs at a defined fast cruise, so the check does not depend on how
// far the physics boat got in a slow headless frame budget.
for (const type of ['jetski', 'pontoon', 'sailboat']) {
  await step(`engine ${type}`, async (check) => {
    await evalAudio(`a.devEngineType = '${type}'; a.devEngineOverride = { rpm: 0.9, load: 1, speed: 0.8, submersion: 0.8, airborne: false }`);
    await duckEngine(false);
    await sleep(1500);
    const c = await capture(2);
    check(c.rms >= 0.02 && c.rms <= 0.6, `${type} engine at rpm 0.9 / speed 0.8: ${fmt(c)} -> RMS in [0.02, 0.6]`);
    check(c.peak < 0.98, `${type} engine not clipping (peak ${c.peak.toFixed(3)})`);
  });
}
let idlePeak = 0.15;
await step('engine idle', async (check) => {
  await evalAudio("a.devEngineType = 'speedboat'; a.devEngineOverride = null");
  await duckEngine(false);
  await sleep(2500);
  const c = await capture(1);
  idlePeak = c.peak;
  check(c.rms > 0.005 && c.rms < 0.15, `speedboat idle is present but moderate: ${fmt(c)}`);
});

// One-shots: duck the engine bus so the baseline is near-silent, then every
// one-shot must lift the level and also beat the un-ducked idle-engine peak.
const shots = [
  ['gate()', 0.9], ['wrongGate()', 0.6], ['splash(1)', 0.8], ['countdown(3)', 0.5], ['countdown(0)', 0.9],
  ['horn("jetski")', 0.6], ['horn("speedboat")', 1.0], ['horn("pontoon")', 1.1], ['horn("sailboat")', 1.2],
  ['star()', 0.8], ['click()', 0.4], ['finish(1)', 2.6], ['finish(2)', 1.6], ['finish(4)', 1.6],
  ['portal()', 2.3], ['lightning(0)', 3.5],
];
for (const [call, tail] of shots) {
  await step(call, async (check) => {
    await evalAudio("a.devEngineType = 'speedboat'; a.devEngineOverride = null");
    await duckEngine(true);
    await sleep(400);
    const base = await capture(0.6);
    const shot = await page.evaluate((c, t) => { new Function('a', `a.${c}`)(window.__audio); return window.__audio.debugCapture(Math.min(1.2, t)); }, call, tail);
    const lifted = (shot.peak - base.peak) > 0.04 || (shot.maxRms - base.maxRms) > 0.012;
    check(lifted, `${call.padEnd(18)} peak ${base.peak.toFixed(3)} -> ${shot.peak.toFixed(3)}, maxRms ${base.maxRms.toFixed(3)} -> ${shot.maxRms.toFixed(3)}`);
    check(shot.peak > idlePeak * 1.1, `${call.padEnd(18)} audible over the idle engine (peak ${shot.peak.toFixed(3)} > ${(idlePeak * 1.1).toFixed(3)})`);
    check(shot.peak < 0.98, `${call.padEnd(18)} not clipping`);
    await sleep(Math.max(0, tail * 1000 - 1200) + 300);
  });
}

// Ambient layers, end to end: Game.js feeds rain()/wind() from the weather
// state every frame, so switch the game's weather (engine ducked so the layer
// itself is measured).
await step('ambient', async (check) => {
  await duckEngine(true);
  await page.evaluate(() => window.__game.setWeather('clear', true));
  await sleep(1500);
  const base = await capture(0.6);
  await page.evaluate(() => window.__game.setWeather('storm', true));
  await sleep(2500);
  const levels = await evalAudio('return { rain: a._rainLevel, wind: a._windLevel }');
  const amb = await capture(1);
  check(levels.rain > 0.3 && levels.wind > 0.3, `storm weather drives rain ${levels.rain.toFixed(2)} / wind ${levels.wind.toFixed(2)} through Game.js`);
  check(amb.rms > base.rms + 0.02, `storm rain+wind audible: rms ${base.rms.toFixed(3)} -> ${amb.rms.toFixed(3)}`);
  check(amb.peak < 0.98, `rain+wind not clipping (peak ${amb.peak.toFixed(3)})`);
  await page.evaluate(() => window.__game.setWeather('clear', true));
  await sleep(3000);
  const off = await capture(0.6);
  check(off.rms < amb.rms * 0.5, `rain+wind fade back out on clear weather (rms ${off.rms.toFixed(3)})`);
});

// Music on/off and mood switching: audible (but quiet), stops cleanly.
await step('music', async (check) => {
  await duckEngine(true);
  await sleep(400);
  const base = await capture(0.6);
  await evalAudio('a.music(true)');
  await sleep(1200);
  const on = await capture(2);
  check(on.rms > base.rms + 0.012 && on.rms < 0.2, `music plays quietly: rms ${base.rms.toFixed(3)} -> ${on.rms.toFixed(3)}`);
  check(on.peak < 0.98, `music not clipping (peak ${on.peak.toFixed(3)})`);
  await evalAudio("a.setMusicMood('race')");
  await sleep(1500);
  const race = await capture(1);
  check(race.rms > base.rms + 0.008, `race mood still playing (rms ${race.rms.toFixed(3)})`);
  await evalAudio("a.setMusicMood('storm')");
  await sleep(1000);
  await evalAudio('a.music(false)');
  await sleep(1200);
  const off = await capture(0.6);
  const live = await evalAudio('return a._m ? a._m.live.size : 0');
  check(off.rms < on.rms * 0.35 && live === 0, `music stops cleanly: rms ${on.rms.toFixed(3)} -> ${off.rms.toFixed(3)}, live voices ${live}`);
  await duckEngine(false);
});

// Mute / volume.
await step('mute', async (check) => {
  await duckEngine(false);
  await evalAudio('a.mute(true)');
  await sleep(700);
  const muted = await capture(0.6);
  check(muted.rms < 0.002, `mute silences output (rms ${muted.rms.toFixed(4)})`);
  await evalAudio('a.mute(false); a.setVolume(0.5)');
  await sleep(700);
  const half = await capture(0.6);
  check(half.rms > 0.003, `setVolume(0.5) restores output (rms ${half.rms.toFixed(3)})`);
  await evalAudio('a.setVolume(0.8)');
});

// Console hygiene: errors from this module or uncaught page errors fail the run;
// 404s for sibling modules other teammates are still writing are reported only.
const isEnv = (l) => /Failed to load resource|Race\.js|Wake\.js|Hud\.js|Worlds\.js|Boats\.js|Portals\.js|Islands\.js/.test(l.text) && !/Audio/.test(l.text);
const errors = logs.filter(l => (l.type === 'error' || l.type === 'pageerror' || l.type === 'crash') && !l.text.includes('favicon'));
const own = errors.filter(l => !isEnv(l)), env = errors.filter(isEnv);
commit(own.length === 0, `zero console errors from the page/audio module (${own.length}; ${env.length} environment 404s from sibling modules; ${reloads} dev-server reload(s))`);
for (const e of own) console.log(`  [${e.type}] ${e.text.slice(0, 600)}`);
for (const e of env.slice(0, 4)) console.log(`  (env) ${e.text.slice(0, 200)}`);
const warnings = logs.filter(l => l.type === 'warning' && !/performance warning|GL Driver Message|\[game\] module/.test(l.text));
if (warnings.length) { console.log(`> ${warnings.length} other warnings:`); for (const w of warnings.slice(0, 8)) console.log(`  ${w.text.slice(0, 300)}`); }

console.log(`\n> ${failures} failure(s)`);
await browser.close();
process.exit(failures ? 1 : 0);
