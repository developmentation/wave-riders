// Emulates a phone and taps through title -> garage -> hub with real touch taps.
// node tools/mobile-tap-test.mjs [--url http://localhost:5173/]
import puppeteer from 'puppeteer';
const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const url = getArg('url', 'http://localhost:5173/');
const browser = await puppeteer.launch({ headless: false, args: ['--ignore-gpu-blocklist', '--use-angle=d3d11', '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--window-size=900,500'],
  defaultViewport: { width: 844, height: 390, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (let i = 0; i < 80 && !(await page.evaluate(() => window.__game && window.__game.state !== 'boot').catch(() => false)); i++) await sleep(500);
const state = () => page.evaluate(() => window.__game?.state);
async function tap(sel) {
  const box = await page.evaluate((s) => { const el = document.querySelector(s); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; }, sel);
  if (!box || box.w < 1) throw new Error(`no visible element ${sel}`);
  await page.touchscreen.tap(box.x, box.y);
  await sleep(700);
}
console.log('state after boot:', await state());
await tap('[data-act="play"]');
console.log('after tapping PLAY:', await state());
await tap('[data-act="go"]');
await sleep(1500);
console.log('after tapping GO:', await state());
const touchShown = await page.evaluate(() => getComputedStyle(document.querySelector('.wr-touch')).display !== 'none' && document.getElementById('hud').classList.contains('wr-touch-mode'));
console.log('touch controls shown:', touchShown);
await page.screenshot({ path: 'tools/shots/mobile-tap.png' });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
const ok = (await Promise.resolve(touchShown)) && errors.length === 0;
process.exit(ok ? 0 : 1);
