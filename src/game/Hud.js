/**
 * Wave Riders HUD: every screen the player sees over the ocean, plus the
 * touch controls that drive the boat. Pure DOM/CSS/SVG (styles in game.css).
 *
 *   const hud = new Hud(game);
 *   hud.setBoats(list);                 // optional, garage catalog
 *   hud.show('title' | 'garage' | 'hub' | 'race' | 'results' | 'paused', data?);
 *   hud.update(frameData);              // every frame; cheap, only touches DOM on change
 *   hud.on('start', ({ from, boat, colorIndex }) => ...);
 *
 * frameData = { speedKmh, lap, laps, position, racers, time, countdown,
 *               nextGateDir (rad, relative, +right), state, stars, bestTime }
 * Events: 'selectBoat'(id, colorIndex), 'start'({from,boat,colorIndex}), 'pause',
 *   'resume', 'camera', 'reset', 'mute'(muted), 'exit', 'horn', 'raceAgain',
 *   'garage' (change boat from pause), 'tilt'(enabled), 'fullscreen'.
 * Touch controls write game.controls.setVirtual({ steer, throttle, brake, boost, active })
 * every frame while the race/hub screens are up.
 */

const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Baloo+2:wght@800&family=Nunito:wght@800;900&display=swap';
const SCREENS = ['title', 'garage', 'hub', 'race', 'results', 'paused'];
const PLAY_SCREENS = new Set(['race', 'hub']);
const SPEEDO_MAX = 120;
const WHEEL_MAX_DEG = 100;

export const DEFAULT_BOATS = [
  { id: 'jetski', label: 'Jet Ski', icon: '🏄', description: 'Zippy and bouncy!', colors: ['#ff5d5d', '#ffd84d', '#46e07a', '#4dc3ff'], stats: { speed: 0.8, turning: 1.0, steady: 0.3 } },
  { id: 'speedboat', label: 'Speedboat', icon: '🚤', description: 'The fastest boat!', colors: ['#ff9f1a', '#ff5d5d', '#4dc3ff', '#f4f4f4'], stats: { speed: 1.0, turning: 0.6, steady: 0.55 } },
  { id: 'sailboat', label: 'Sailboat', icon: '⛵', description: 'Rides the wind.', colors: ['#f4f4f4', '#ffd84d', '#46e07a', '#c58cff'], stats: { speed: 0.45, turning: 0.4, steady: 0.7 } },
  { id: 'pontoon', label: 'Pontoon', icon: '🛥️', description: 'Steady party boat!', colors: ['#4dc3ff', '#ff9f1a', '#46e07a', '#ff8fd0'], stats: { speed: 0.35, turning: 0.35, steady: 1.0 } },
  { id: 'fishing', label: 'Fishing Boat', icon: '🎣', description: 'Steady as a rock!', colors: ['#5a8fdd', '#d84c48', '#49c687', '#ffc236'], stats: { speed: 0.4, turning: 0.45, steady: 0.9 } },
  { id: 'tug', label: 'Tugboat', icon: '🚢', description: 'Big and strong!', colors: ['#d84c48', '#49c687', '#ffc236'], stats: { speed: 0.3, turning: 0.4, steady: 1.0 } },
  { id: 'airboat', label: 'Airboat', icon: '🌀', description: 'Fast and slidey!', colors: ['#49c687', '#ff7a3d', '#9d6cf0', '#a9d9fb'], stats: { speed: 0.85, turning: 0.75, steady: 0.35 } },
  { id: 'towboat', label: 'Tow Boat', icon: '⛴️', description: 'Twin smokestacks!', colors: ['#9d6cf0', '#ff7a3d'], stats: { speed: 0.95, turning: 0.55, steady: 0.6 } },
  { id: 'rowboat', label: 'Rowboat', icon: '🚣', description: 'Row, row, row!', colors: ['#d84c48', '#ffc236', '#49c687', '#9d6cf0'], stats: { speed: 0.15, turning: 0.9, steady: 0.5 } },
];

/** Catalog colours may be numeric hex (Kenney palette); CSS wants strings. */
const cssColor = (c) => (typeof c === 'number' ? `#${c.toString(16).padStart(6, '0')}` : c);

// Same left-to-right order as the portal arc in the harbour (Worlds.js hub).
const WORLD_ICONS = [
  { id: 'storm', icon: '⛈️', label: 'Storm Run' },
  { id: 'swell', icon: '🌊', label: 'Rolling Swell' },
  { id: 'lagoon', icon: '☀️', label: 'Sunny Lagoon' },
  { id: 'giant', icon: '🏔️', label: 'Titan Swell' },
  { id: 'tempest', icon: '🌩️', label: 'The Perfect Storm' },
  { id: 'deep', icon: '🤿', label: 'The Deep Run' },
];

/* ---------------------------------------------------------------- icons -- */
const svg = (body, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON = {
  flag: svg('<path d="M4 2v20" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M5 3h14l-2.5 4.5L19 12H5z" fill="#fff"/><path d="M5 3h3.5v3H5zM12 3h3.5v3H12zM8.5 6H12v3H8.5zM15.5 6H19v3h-3.5zM5 9h3.5v3H5zM12 9h3.5v3H12z" fill="#05324f"/>'),
  lap: svg('<path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M21 4v6h-6z" fill="#fff"/>'),
  clock: svg('<circle cx="12" cy="13" r="8.5" fill="none" stroke="#fff" stroke-width="3"/><path d="M12 8v5l3.5 2" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 2h6" stroke="#fff" stroke-width="3" stroke-linecap="round"/>'),
  chevron: svg('<path d="M50 4 90 48H66v46H34V48H10z" fill="currentColor" stroke="#05324f" stroke-width="7" stroke-linejoin="round"/>', '0 0 100 100'),
  camera: svg('<path d="M4 8h4l2-3h4l2 3h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" fill="currentColor"/><circle cx="12" cy="14" r="3.5" fill="#05324f"/><circle cx="12" cy="14" r="1.6" fill="currentColor"/>'),
  pause: svg('<rect x="5" y="4" width="5" height="16" rx="1.5" fill="currentColor"/><rect x="14" y="4" width="5" height="16" rx="1.5" fill="currentColor"/>'),
  home: svg('<path d="M3 11.5 12 4l9 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 10.5V20h12v-9.5" fill="currentColor"/><rect x="10" y="14" width="4" height="6" fill="#05324f"/>'),
  play: svg('<path d="M7 4.5v15l13-7.5z" fill="currentColor"/>'),
  reset: svg('<path d="M20 12a8 8 0 1 1-2.4-5.7" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/><path d="M20 3v6h-6z" fill="currentColor"/>'),
  sound: svg('<path d="M3 9v6h4l5 4V5L7 9z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'),
  muted: svg('<path d="M3 9v6h4l5 4V5L7 9z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/>'),
  full: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'),
  bolt: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="currentColor" stroke="#05324f" stroke-width="1.6" stroke-linejoin="round"/>'),
  horn: svg('<path d="M3 10v4a1 1 0 0 0 1 1h3l9 4V5L7 9H4a1 1 0 0 0-1 1z" fill="currentColor"/><path d="M19 9.5a4 4 0 0 1 0 5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M6 15v5a1.5 1.5 0 0 0 3 0v-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  left: svg('<path d="M66 12 30 50l36 38" fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>', '0 0 100 100'),
  right: svg('<path d="M34 12l36 38-36 38" fill="none" stroke="currentColor" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>', '0 0 100 100'),
  star: svg('<path d="M50 6l13.5 27.6L94 38 72 59.4 77.2 90 50 75.5 22.8 90 28 59.4 6 38l30.5-4.4z" fill="currentColor" stroke="#05324f" stroke-width="6" stroke-linejoin="round"/>', '0 0 100 100'),
  tilt: svg('<rect x="4" y="3" width="12" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="2.4" transform="rotate(-14 10 12)"/><path d="M17 8a6 6 0 0 1 3 6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  wheel: svg(
    '<circle cx="50" cy="50" r="42" fill="none" stroke="#05324f" stroke-width="16"/>' +
    '<circle cx="50" cy="50" r="42" fill="none" stroke="#ffd84d" stroke-width="10"/>' +
    '<path d="M50 50V18M50 50 22 66M50 50l28 16" stroke="#05324f" stroke-width="12" stroke-linecap="round"/>' +
    '<path d="M50 50V18M50 50 22 66M50 50l28 16" stroke="#ffb42e" stroke-width="6" stroke-linecap="round"/>' +
    '<circle cx="50" cy="50" r="13" fill="#05324f"/><circle cx="50" cy="50" r="8" fill="#ff9f1a"/>' +
    '<circle cx="50" cy="13" r="4.5" fill="#fff" stroke="#05324f" stroke-width="2"/>', '0 0 100 100'),
  pedal: svg(
    '<rect x="10" y="6" width="60" height="128" rx="16" fill="rgba(0,0,0,.28)"/>' +
    '<g fill="rgba(255,255,255,.55)"><rect x="22" y="22" width="36" height="8" rx="4"/><rect x="22" y="42" width="36" height="8" rx="4"/>' +
    '<rect x="22" y="62" width="36" height="8" rx="4"/><rect x="22" y="82" width="36" height="8" rx="4"/><rect x="22" y="102" width="36" height="8" rx="4"/></g>', '0 0 80 140'),
};

/* ---------------------------------------------------------------- utils -- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ORD = ['th', 'st', 'nd', 'rd'];
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ORD[n % 10] || 'th');
function fmtTime(t) {
  if (!(t >= 0)) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60), d = Math.floor((t * 10) % 10);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${d}`;
}
function polar(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
let fontInjected = false;
function injectFont() {
  if (fontInjected || typeof document === 'undefined') return;
  fontInjected = true;
  if (document.querySelector('link[data-wr-font]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = FONT_HREF; link.dataset.wrFont = '1';
  link.onerror = () => link.remove();      // system fallback stack does the job
  document.head.appendChild(link);
}

/* ------------------------------------------------------------ speedometer -- */
function speedoSvg() {
  const cx = 100, cy = 100, sweep = 240, start = -120;
  const angle = (v) => start + sweep * (v / SPEEDO_MAX);
  let ticks = '', labels = '';
  for (let v = 0; v <= SPEEDO_MAX; v += 10) {
    const major = v % 20 === 0, a = angle(v);
    const [x0, y0] = polar(cx, cy, major ? 66 : 70, a), [x1, y1] = polar(cx, cy, 78, a);
    ticks += `<line x1="${x0.toFixed(1)}" y1="${y0.toFixed(1)}" x2="${x1.toFixed(1)}" y2="${y1.toFixed(1)}" stroke="${major ? '#fff' : 'rgba(255,255,255,.55)'}" stroke-width="${major ? 3.5 : 2}" stroke-linecap="round"/>`;
    if (major) {
      const [lx, ly] = polar(cx, cy, 53, a);
      labels += `<text x="${lx.toFixed(1)}" y="${(ly + 4.5).toFixed(1)}" text-anchor="middle">${v}</text>`;
    }
  }
  return `<svg class="wr-speedo-svg" viewBox="0 0 200 200" aria-hidden="true">
    <defs><radialGradient id="wrDialBg" cx="50%" cy="42%" r="62%"><stop offset="0" stop-color="#0d4f86"/><stop offset="1" stop-color="#041e35"/></radialGradient></defs>
    <circle cx="100" cy="100" r="96" fill="url(#wrDialBg)" stroke="#fff" stroke-width="5"/>
    <circle cx="100" cy="100" r="88" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="1.5"/>
    <path d="${arcPath(cx, cy, 84, angle(0), angle(70))}" fill="none" stroke="#3ec7ff" stroke-width="9" stroke-linecap="round"/>
    <path d="${arcPath(cx, cy, 84, angle(70), angle(100))}" fill="none" stroke="#ffd84d" stroke-width="9"/>
    <path d="${arcPath(cx, cy, 84, angle(100), angle(SPEEDO_MAX))}" fill="none" stroke="#ff5d5d" stroke-width="9" stroke-linecap="round"/>
    <g>${ticks}</g><g class="wr-speedo-labels">${labels}</g>
    <text class="wr-speedo-unit" x="100" y="172" text-anchor="middle">km/h</text>
  </svg>
  <svg class="wr-needle" viewBox="0 0 200 200" aria-hidden="true"><path d="M96 104 100 22l4 82z" fill="#ff5d5d" stroke="#05324f" stroke-width="2.5" stroke-linejoin="round"/><circle cx="100" cy="100" r="11" fill="#05324f"/><circle cx="100" cy="100" r="6" fill="#ffd84d"/></svg>
  <div class="wr-speedo-digit wr-txt">0</div>`;
}

/* ------------------------------------------------------------------- Hud -- */
export class Hud {
  constructor(game, opts = {}) {
    this.game = game;
    // Game.js already turns controls actions into camera/reset/horn; the HUD
    // only emits events unless asked to also trigger controls actions.
    this.opts = { triggerActions: false, ...opts };
    const params = new URLSearchParams(location.search);
    this.touch = opts.touch ?? (navigator.maxTouchPoints > 0 || params.get('touch') === '1');
    this.root = document.getElementById('hud') || document.body.appendChild(el('div', '', ''));
    this.root.id = 'hud';
    this.root.classList.add('wr');
    this.root.classList.toggle('wr-touch-mode', this.touch);
    this._listeners = new Map();
    this._c = {};                                   // per-frame DOM cache
    this.screen = null;
    this.muted = false;
    this.tilt = false;
    this.boats = DEFAULT_BOATS.slice();
    this.selectedBoat = this.boats[1].id;
    this.colorIndex = 0;
    this.stars = {};
    this.last = null;                               // last frameData
    this.virtual = { steer: 0, throttle: 0, brake: 0, boost: false, active: false };
    this._ptr = new Map();                          // pointerId -> { ctl, el }
    this._wheel = { angle: 0, dragging: false, lastA: 0 };
    this._held = { left: false, right: false, throttle: false, brake: false, boost: false, horn: false, up: false, down: false };
    this._wrongT = 0;
    this._hintShown = false;
    this._toastQ = [];
    this._prevT = performance.now();
    injectFont();
    this._build();
    this._bind();
  }

  /* ---- events ---- */
  on(ev, cb) { (this._listeners.get(ev) || this._listeners.set(ev, new Set()).get(ev)).add(cb); return () => this.off(ev, cb); }
  off(ev, cb) { this._listeners.get(ev)?.delete(cb); }
  emit(ev, ...args) { this._listeners.get(ev)?.forEach((cb) => { try { cb(...args); } catch (e) { console.error('[hud]', ev, e); } }); }
  _action(name) {
    this.emit(name);
    if (this.opts.triggerActions) this.game?.controls?.trigger?.(name);
  }

  /* ---- build ---- */
  _build() {
    const r = this.root;
    r.innerHTML = '';
    this.el = {};

    // Title
    const title = el('section', 'wr-screen wr-title', `
      <div class="wr-title-sky"></div>
      <div class="wr-logo"><span class="wr-logo-top">WAVE</span><span class="wr-logo-bot">RIDERS</span>
        <div class="wr-wavestripe"><svg viewBox="0 0 456 40" preserveAspectRatio="none"><path d="M0 18c12-14 26-14 38 0s26 14 38 0 26-14 38 0 26 14 38 0 26-14 38 0 26 14 38 0 26-14 38 0 26 14 38 0 26-14 38 0 26 14 38 0 26-14 38 0V40H0z" fill="#3ec7ff"/><path d="M0 26c12-14 26-14 38 0s26 14 38 0 26-14 38 0 26 14 38 0 26-14 38 0 26 14 38 0 26-14 38 0 26 14 38 0 26-14 38 0 26 14 38 0 26-14 38 0V40H0z" fill="#fff" opacity=".9"/></svg></div>
      </div>
      <div class="wr-title-boats" aria-hidden="true"><span>🚤</span><span>⛵</span><span>🏄</span></div>
      <button class="wr-big wr-play" data-act="play">${ICON.play}<span>PLAY</span></button>
      <div class="wr-title-tap">tap anywhere to start</div>
      <div class="wr-corner-btns">
        <button class="wr-sysbtn" data-act="mute" aria-label="Sound">${ICON.sound}</button>
        <button class="wr-sysbtn" data-act="fullscreen" aria-label="Fullscreen">${ICON.full}</button>
      </div>`);
    title.dataset.screen = 'title';

    // Garage
    const garage = el('section', 'wr-screen wr-garage', `
      <h2 class="wr-h wr-txt">Choose your boat</h2>
      <div class="wr-garage-row">
        <button class="wr-cycle wr-cycle-l" data-act="prevBoat" aria-label="Previous boat">${ICON.left}</button>
        <div class="wr-cards"></div>
        <button class="wr-cycle wr-cycle-r" data-act="nextBoat" aria-label="Next boat">${ICON.right}</button>
      </div>
      <div class="wr-garage-foot">
        <div class="wr-swatches" role="radiogroup" aria-label="Boat colour"></div>
        <button class="wr-big wr-go" data-act="go"><span>GO!</span></button>
      </div>`);
    garage.dataset.screen = 'garage';

    // Hub
    const hub = el('section', 'wr-screen wr-hub', `
      <div class="wr-hint">
        <div class="wr-hint-text wr-txt">Drive through a portal!</div>
        <div class="wr-worlds">${WORLD_ICONS.map((w) => `<div class="wr-world" data-world="${w.id}" title="${w.label}"><span class="wr-world-icon">${w.icon}</span><span class="wr-world-stars"></span></div>`).join('')}</div>
      </div>`);
    hub.dataset.screen = 'hub';

    // Race
    const race = el('section', 'wr-screen wr-race', `
      <div class="wr-top">
        <div class="wr-badge wr-pos"><span class="wr-tile">${ICON.flag}</span><span class="wr-val wr-txt"><b class="wr-pos-n">1</b><small class="wr-pos-of">/4</small></span></div>
        <div class="wr-mid">
          <div class="wr-badge wr-lap"><span class="wr-tile">${ICON.lap}</span><span class="wr-val wr-txt">LAP <b class="wr-lap-n">1</b><small class="wr-lap-of">/3</small></span></div>
          <div class="wr-gate">${ICON.chevron}</div>
          <div class="wr-wrongway wr-txt">WRONG WAY!</div>
        </div>
        <div class="wr-badge wr-timer"><span class="wr-tile">${ICON.clock}</span><span class="wr-val wr-txt wr-timer-t">00:00.0</span></div>
      </div>
      <div class="wr-speedo">${speedoSvg()}</div>
      <div class="wr-depth wr-badge"><span class="wr-tile">🤿</span><span class="wr-val wr-txt"><b class="wr-depth-val">0</b> <small>m deep</small></span></div>
      <div class="wr-countdown"><div class="wr-count-n wr-txt"></div></div>`);
    race.dataset.screen = 'race';

    // Results
    const results = el('section', 'wr-screen wr-results', `
      <div class="wr-confetti" aria-hidden="true"></div>
      <div class="wr-card wr-results-card">
        <div class="wr-results-title wr-txt">You finished <b class="wr-results-place">1st</b>!</div>
        <div class="wr-stars">${[0, 1, 2].map((i) => `<span class="wr-star" style="--i:${i}">${ICON.star}</span>`).join('')}</div>
        <div class="wr-results-times">
          <div><span class="wr-lbl">Time</span><b class="wr-results-time wr-txt">00:00.0</b></div>
          <div><span class="wr-lbl">Best</span><b class="wr-results-best wr-txt">--:--.-</b></div>
        </div>
        <div class="wr-btnrow">
          <button class="wr-big wr-yellow" data-act="raceAgain">${ICON.reset}<span>Race again</span></button>
          <button class="wr-big wr-blue" data-act="exit"><span>⚓</span><span>Back to harbour</span></button>
        </div>
      </div>`);
    results.dataset.screen = 'results';

    // Paused
    const paused = el('section', 'wr-screen wr-paused', `
      <div class="wr-card wr-pause-card">
        <div class="wr-h wr-txt">Paused</div>
        <button class="wr-big wr-green" data-act="resume">${ICON.play}<span>Resume</span></button>
        <button class="wr-big wr-yellow" data-act="garage"><span>🚤</span><span>Change boat</span></button>
        <button class="wr-big wr-blue" data-act="exit"><span>⚓</span><span>Back to harbour</span></button>
        <div class="wr-pause-row">
          <button class="wr-sysbtn" data-act="mute" aria-label="Sound">${ICON.sound}</button>
          <button class="wr-sysbtn wr-tiltbtn" data-act="tilt" aria-label="Tilt steering">${ICON.tilt}</button>
          <button class="wr-sysbtn" data-act="fullscreen" aria-label="Fullscreen">${ICON.full}</button>
        </div>
      </div>`);
    paused.dataset.screen = 'paused';

    // Always-on layers
    const sys = el('div', 'wr-sys', `
      <button class="wr-sysbtn" data-act="camera" aria-label="Camera">${ICON.camera}</button>
      <button class="wr-sysbtn" data-act="reset" aria-label="Reset boat">${ICON.reset}</button>
      <button class="wr-sysbtn" data-act="mute" aria-label="Sound">${ICON.sound}</button>
      <button class="wr-sysbtn wr-pausebtn" data-act="pause" aria-label="Pause">${ICON.pause}</button>
      <button class="wr-sysbtn wr-homebtn" data-act="exit" aria-label="Back to the harbour">${ICON.home}</button>`);
    const touch = el('div', 'wr-touch', `
      <div class="wr-left">
        <div class="wr-wheel" data-ctl="wheel" role="slider" aria-label="Steering wheel">${ICON.wheel}</div>
        <div class="wr-arrows">
          <button class="wr-arrowbtn wr-dive-up wr-divebtn" data-ctl="up" aria-label="Rise">${ICON.left}</button>
          <button class="wr-arrowbtn wr-arrow-l" data-ctl="left" aria-label="Steer left">${ICON.left}</button>
          <button class="wr-arrowbtn wr-arrow-r" data-ctl="right" aria-label="Steer right">${ICON.right}</button>
          <button class="wr-arrowbtn wr-dive-down wr-divebtn" data-ctl="down" aria-label="Dive">${ICON.left}</button>
        </div>
      </div>
      <div class="wr-right">
        <button class="wr-round wr-horn" data-ctl="horn" aria-label="Horn">${ICON.horn}</button>
        <button class="wr-round wr-boost" data-ctl="boost" aria-label="Boost">${ICON.bolt}</button>
        <button class="wr-pedal wr-brake" data-ctl="brake" aria-label="Brake / reverse">${ICON.pedal}<span>STOP</span></button>
        <button class="wr-pedal wr-throttle" data-ctl="throttle" aria-label="Throttle">${ICON.pedal}<span>GO</span></button>
      </div>`);
    const hints = el('div', 'wr-keys', `
      <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or arrows to drive</span>
      <span><kbd>Space</kbd> boost</span><span class="wr-subkeys"><kbd>Q</kbd> dive <kbd>E</kbd> rise</span><span><kbd>C</kbd> camera</span><span><kbd>R</kbd> reset</span><span><kbd>Esc</kbd> pause</span>`);
    const toasts = el('div', 'wr-toasts');
    const rotate = el('div', 'wr-rotate', `<div class="wr-rotate-icon">📱</div><div class="wr-txt">Turn your tablet sideways!</div>`);

    r.append(title, garage, hub, race, results, paused, sys, touch, hints, toasts, rotate);

    const q = (s) => r.querySelector(s);
    Object.assign(this.el, {
      title, garage, hub, race, results, paused, sys, touch, hints, toasts,
      cards: q('.wr-cards'), swatches: q('.wr-swatches'),
      posN: q('.wr-pos-n'), posOf: q('.wr-pos-of'), lapN: q('.wr-lap-n'), lapOf: q('.wr-lap-of'), timer: q('.wr-timer-t'),
      gate: q('.wr-gate'), wrong: q('.wr-wrongway'), needle: q('.wr-needle'), digit: q('.wr-speedo-digit'),
      depthVal: q('.wr-depth-val'),
      countdown: q('.wr-countdown'), countN: q('.wr-count-n'),
      resultsPlace: q('.wr-results-place'), resultsTime: q('.wr-results-time'), resultsBest: q('.wr-results-best'),
      stars: [...r.querySelectorAll('.wr-star')], confetti: q('.wr-confetti'),
      wheel: q('.wr-wheel'), wheelSvg: q('.wr-wheel svg'),
      worlds: [...r.querySelectorAll('.wr-world')],
      muteBtns: [...r.querySelectorAll('[data-act="mute"]')],
    });
    this._buildConfetti();
    this._renderCards();
    this._renderWorldStars();
    if (!document.fullscreenEnabled) r.querySelectorAll('[data-act="fullscreen"]').forEach((b) => b.remove());
    if (!('DeviceOrientationEvent' in window) || !this.touch) r.querySelector('.wr-tiltbtn')?.remove();
  }

  _buildConfetti() {
    const box = this.el.confetti;
    const colors = ['#ffd84d', '#ff9f1a', '#46e07a', '#3ec7ff', '#ff5d5d', '#ff8fd0', '#ffffff'];
    let html = '';
    for (let i = 0; i < 70; i++) {
      const x = (Math.random() * 100).toFixed(1), d = (Math.random() * 2.5).toFixed(2), dur = (2.8 + Math.random() * 2.2).toFixed(2);
      const rot = Math.round(Math.random() * 720 - 360), w = 8 + Math.round(Math.random() * 8), h = 10 + Math.round(Math.random() * 12);
      html += `<i style="left:${x}%;--d:${d}s;--dur:${dur}s;--r:${rot}deg;width:${w}px;height:${h}px;background:${colors[i % colors.length]}"></i>`;
    }
    box.innerHTML = html;
  }

  _renderCards() {
    const box = this.el.cards;
    box.innerHTML = this.boats.map((b) => `
      <button class="wr-boat${b.id === this.selectedBoat ? ' is-sel' : ''}" data-boat="${b.id}" style="--boat-color:${(b.colors || ['#ff9f1a'])[0]}">
        <span class="wr-boat-icon">${b.icon || '🚤'}</span>
        <span class="wr-boat-name wr-txt">${b.label || b.id}</span>
        <span class="wr-boat-desc">${b.description || ''}</span>
        <span class="wr-stats">
          ${['speed', 'turning', 'steady'].map((k) => `<span class="wr-stat"><i>${k === 'speed' ? '🚀' : k === 'turning' ? '↩️' : '⚖️'}</i><span class="wr-stat-lbl">${k}</span><span class="wr-bar"><b style="width:${Math.round(100 * clamp((b.stats || {})[k] ?? 0.5, 0.08, 1))}%"></b></span></span>`).join('')}
        </span>
      </button>`).join('');
    this._renderSwatches();
  }

  _renderSwatches() {
    const b = this.boats.find((x) => x.id === this.selectedBoat) || this.boats[0];
    const cols = b?.colors || ['#ff9f1a'];
    if (this.colorIndex >= cols.length) this.colorIndex = 0;
    this.el.swatches.innerHTML = cols.map((c, i) =>
      `<button class="wr-swatch${i === this.colorIndex ? ' is-sel' : ''}" data-color="${i}" role="radio" aria-checked="${i === this.colorIndex}" style="--c:${c}" aria-label="Colour ${i + 1}"></button>`).join('');
    const sel = this.el.cards.querySelector('.is-sel');
    if (sel) sel.style.setProperty('--boat-color', cols[this.colorIndex]);
  }

  _renderWorldStars() {
    for (const w of this.el.worlds) {
      const n = this.stars[w.dataset.world] | 0;
      w.querySelector('.wr-world-stars').innerHTML = [0, 1, 2].map((i) => `<span class="${i < n ? 'lit' : ''}">★</span>`).join('');
    }
  }

  /* ---- binding ---- */
  _bind() {
    const r = this.root;
    // Clicks on buttons with data-act (any screen).
    r.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) { e.stopPropagation(); this._act(btn.dataset.act, btn); return; }
      const boat = e.target.closest('[data-boat]');
      if (boat) { this._pickBoat(boat.dataset.boat); return; }
      const sw = e.target.closest('[data-color]');
      if (sw) { this.colorIndex = +sw.dataset.color; this._renderSwatches(); this.emit('selectBoat', this.selectedBoat, this.colorIndex); return; }
      if (this.screen === 'title' && e.target.closest('.wr-title')) this._act('play');
    });
    r.addEventListener('keydown', (e) => {
      if (this.screen === 'garage') {
        if (e.code === 'ArrowLeft') this._cycle(-1);
        if (e.code === 'ArrowRight') this._cycle(1);
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Enter' || e.code === 'Space') {
        if (this.screen === 'title') { e.preventDefault(); this._act('play'); }
        else if (this.screen === 'garage' && e.code === 'Enter') this._act('go');
        else if (this.screen === 'results' && e.code === 'Enter') this._act('raceAgain');
      }
      if (this.screen === 'garage' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) this._cycle(e.code === 'ArrowLeft' ? -1 : 1);
    });

    // Touch controls: pointer events with capture so thumbs can slide off.
    const t = this.el.touch;
    const opts = { passive: false };
    t.addEventListener('pointerdown', (e) => this._pointerDown(e));
    t.addEventListener('pointermove', (e) => this._pointerMove(e));
    t.addEventListener('pointerup', (e) => this._pointerUp(e));
    t.addEventListener('pointercancel', (e) => this._pointerUp(e));
    t.addEventListener('lostpointercapture', (e) => this._pointerUp(e));
    for (const ev of ['touchstart', 'touchmove', 'touchend']) r.addEventListener(ev, (e) => { if (e.cancelable && e.target.closest('.wr-touch, .wr-screen')) e.preventDefault(); }, opts);
    r.addEventListener('contextmenu', (e) => e.preventDefault());
    r.addEventListener('dblclick', (e) => e.preventDefault());
    document.addEventListener('gesturestart', (e) => e.preventDefault(), opts);
    window.addEventListener('blur', () => this._releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this._releaseAll(); });
  }

  _act(name, btn) {
    switch (name) {
      case 'play': this.emit('start', { from: 'title', boat: this.selectedBoat, colorIndex: this.colorIndex }); break;
      case 'go': this.emit('selectBoat', this.selectedBoat, this.colorIndex); this.emit('start', { from: 'garage', boat: this.selectedBoat, colorIndex: this.colorIndex }); break;
      case 'prevBoat': this._cycle(-1); break;
      case 'nextBoat': this._cycle(1); break;
      case 'pause': this._action('pause'); break;
      case 'resume': this.emit('resume'); break;
      case 'camera': this._action('camera'); break;
      case 'reset': this._action('reset'); break;
      case 'exit': this.emit('exit'); break;
      case 'raceAgain': this.emit('raceAgain'); break;
      case 'garage': this.emit('garage'); break;
      case 'mute': this.setMuted(!this.muted); this.emit('mute', this.muted); break;
      case 'tilt': this.setTilt(!this.tilt); break;
      case 'fullscreen': this._fullscreen(); this.emit('fullscreen'); break;
      default: this.emit(name, btn);
    }
  }

  _fullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })?.catch?.(() => {});
    } catch { /* not available */ }
  }

  _cycle(dir) {
    const i = this.boats.findIndex((b) => b.id === this.selectedBoat);
    const n = this.boats.length;
    this._pickBoat(this.boats[(i + dir + n) % n].id);
  }

  _pickBoat(id) {
    if (!this.boats.some((b) => b.id === id)) return;
    this.selectedBoat = id;
    this.colorIndex = 0;
    for (const c of this.el.cards.children) {
      const sel = c.dataset.boat === id;
      c.classList.toggle('is-sel', sel);
      if (sel) c.scrollIntoView?.({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }
    this._renderSwatches();
    this.emit('selectBoat', id, this.colorIndex);
  }

  /* ---- public API ---- */
  setBoats(list) {
    if (Array.isArray(list) && list.length) {
      this.boats = list.map((b) => ({ ...DEFAULT_BOATS.find((d) => d.id === b.id), ...b }));
    } else if (list && typeof list === 'object') {
      this.boats = Object.entries(list).map(([id, b]) => ({ ...DEFAULT_BOATS.find((d) => d.id === id), id, ...b }));
    }
    for (const b of this.boats) if (Array.isArray(b.colors)) b.colors = b.colors.map(cssColor);
    if (!this.boats.some((b) => b.id === this.selectedBoat)) this.selectedBoat = this.boats[0].id;
    this._renderCards();
  }

  /** map = { worldId: 3 } or { worldId: { stars: 3, best: 81.2 } } */
  setStars(map) {
    this.stars = {};
    for (const [k, v] of Object.entries(map || {})) this.stars[k] = typeof v === 'number' ? v : (v?.stars | 0);
    this._renderWorldStars();
  }

  setMuted(m) {
    this.muted = !!m;
    for (const b of this.el.muteBtns) { b.innerHTML = this.muted ? ICON.muted : ICON.sound; b.classList.toggle('is-off', this.muted); }
  }

  setTilt(on) {
    const enable = () => {
      this.tilt = true;
      this.root.querySelector('.wr-tiltbtn')?.classList.add('is-on');
      if (!this._tiltFn) {
        this._tiltFn = (e) => {
          const ang = (screen.orientation?.angle ?? window.orientation ?? 0);
          let v;
          if (ang === 90) v = (e.beta || 0);
          else if (ang === 270 || ang === -90) v = -(e.beta || 0);
          else v = (e.gamma || 0);
          this.game?.controls?.setTilt?.(clamp(v / 28, -1, 1));
        };
      }
      window.addEventListener('deviceorientation', this._tiltFn);
      this.emit('tilt', true);
    };
    if (!on) {
      this.tilt = false;
      this.root.querySelector('.wr-tiltbtn')?.classList.remove('is-on');
      if (this._tiltFn) window.removeEventListener('deviceorientation', this._tiltFn);
      this.game?.controls?.clearTilt?.();
      this.emit('tilt', false);
      return;
    }
    const DOE = window.DeviceOrientationEvent;
    if (DOE?.requestPermission) DOE.requestPermission().then((s) => { if (s === 'granted') enable(); }).catch(() => {});
    else enable();
  }

  toast(text, cls = '') {
    const t = el('div', `wr-toast wr-txt ${cls}`, text);
    this.el.toasts.appendChild(t);
    setTimeout(() => t.remove(), 1900);
  }

  show(name, data) {
    if (!SCREENS.includes(name)) { console.warn('[hud] unknown screen', name); return; }
    const prev = this.screen;
    this.screen = name;
    this.root.dataset.screen = name;
    for (const s of SCREENS) this.el[s].classList.toggle('is-on', s === name);
    const play = PLAY_SCREENS.has(name);
    this.el.sys.classList.toggle('is-on', play);
    this.el.touch.classList.toggle('is-on', play && this.touch);
    if (!(play && this.touch)) this._releaseAll();
    if (play && !this.touch && !this._hintShown) {
      this._hintShown = true;
      this.el.hints.classList.add('is-on');
      setTimeout(() => this.el.hints.classList.remove('is-on'), 7000);
    }
    if (name === 'race' && prev !== 'race' && prev !== 'paused') {
      this._c = {};                                      // force a fresh paint of all readouts
      this._wrongT = 0;
      this.el.countN.textContent = '';
      this.el.countdown.classList.remove('is-on');
      this.el.wrong.classList.remove('is-on');
    }
    if (name === 'results') this._showResults(data || {});
    if (name === 'garage') {
      this._renderSwatches();
      // The card strip scrolls once there are more boats than fit; bring the chosen one into view.
      this.el.cards.querySelector('.is-sel')?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
    }
    if (name === 'paused') this.emit('paused');
  }

  _showResults(d) {
    const f = this.last || {};
    const position = d.place ?? d.position ?? f.position ?? 1;
    const stars = clamp(d.stars ?? (typeof f.stars === 'number' ? f.stars : Math.max(1, 4 - position)), 0, 3);
    const time = d.time ?? f.time ?? 0;
    const best = d.best ?? d.bestTime ?? f.bestTime;
    this.el.resultsPlace.textContent = ordinal(position);
    this.el.resultsTime.textContent = fmtTime(time);
    this.el.resultsBest.textContent = best > 0 ? fmtTime(best) : fmtTime(time);
    this.el.stars.forEach((s, i) => { s.classList.remove('lit'); void s.offsetWidth; if (i < stars) s.classList.add('lit'); });
    this.el.results.classList.toggle('is-win', position === 1);
  }

  /** Called every frame by Game.js. Only touches the DOM when a value changes. */
  update(f) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._prevT) / 1000);
    this._prevT = now;
    if (f) this.last = f;
    this._tickTouch(dt);
    if (this.screen !== 'race' || !f) return;
    const c = this._c, e = this.el;

    const pos = f.position | 0, racers = f.racers | 0;
    if (pos !== c.pos) { c.pos = pos; e.posN.textContent = pos || '-'; }
    if (racers !== c.racers) { c.racers = racers; e.posOf.textContent = racers ? `/${racers}` : ''; }

    const lap = f.lap | 0, laps = f.laps | 0;
    if (laps !== c.laps) { c.laps = laps; e.lapOf.textContent = laps ? `/${laps}` : ''; }
    if (lap !== c.lap) {
      const prev = c.lap;
      c.lap = lap;
      e.lapN.textContent = Math.max(1, lap);
      if (prev !== undefined && lap > prev && lap > 1) this.toast(lap >= laps && laps > 0 ? 'FINAL LAP!' : `LAP ${lap}!`, lap >= laps ? 'wr-toast-final' : '');
    }

    const t = fmtTime(f.time);
    if (t !== c.time) { c.time = t; e.timer.textContent = t; }

    // Submarine mode: depth gauge + dive buttons.
    const sub = !!f.submerged;
    if (sub !== this._c.sub) { this._c.sub = sub; this.root.classList.toggle('wr-sub', sub); }
    if (sub) {
      const d = Math.round(f.depth || 0);
      if (d !== this._c.depth) { this._c.depth = d; if (this.el.depthVal) this.el.depthVal.textContent = String(d); }
    }
    const kmh = Math.round(f.speedKmh || 0);
    if (kmh !== c.kmh) {
      c.kmh = kmh;
      e.digit.textContent = kmh;
      const a = -120 + 240 * clamp(kmh / SPEEDO_MAX, 0, 1.03);
      e.needle.style.transform = `rotate(${a.toFixed(1)}deg)`;
    }

    // Next gate arrow: rotate with direction, pulse when the gate is off-screen.
    let dir = f.nextGateDir;
    if (typeof dir === 'number' && !Number.isNaN(dir)) {
      dir = Math.atan2(Math.sin(dir), Math.cos(dir));
      const deg = Math.round(dir * 180 / Math.PI);
      if (deg !== c.deg) { c.deg = deg; e.gate.style.transform = `rotate(${deg}deg)`; }
      const off = Math.abs(dir) > 0.75;
      if (off !== c.off) { c.off = off; e.gate.classList.toggle('is-off', off); }
      if (c.gateHidden) { c.gateHidden = false; e.gate.classList.remove('is-hidden'); }
      this._wrongT = Math.abs(dir) > 2.35 && (f.speedKmh || 0) > 4 ? this._wrongT + dt : 0;
    } else {
      if (!c.gateHidden) { c.gateHidden = true; e.gate.classList.add('is-hidden'); }
      this._wrongT = 0;
    }
    const wrong = this._wrongT > 2;
    if (wrong !== c.wrong) { c.wrong = wrong; e.wrong.classList.toggle('is-on', wrong); }

    // Countdown 3 · 2 · 1 · GO!
    const cd = f.countdown > 0 ? Math.ceil(f.countdown) : 0;
    if (cd !== c.cd) {
      const prev = c.cd;
      c.cd = cd;
      if (cd > 0) this._countShow(String(cd), false);
      else if (prev > 0) { this._countShow('GO!', true); this._goTimer = setTimeout(() => { if (this._c.cd === 0) this.el.countdown.classList.remove('is-on'); }, 1100); }
      else this.el.countdown.classList.remove('is-on');
    }
  }

  _countShow(txt, go) {
    const n = this.el.countN;
    n.classList.remove('wr-pop'); void n.offsetWidth;
    n.textContent = txt;
    n.classList.toggle('is-go', go);
    n.classList.add('wr-pop');
    this.el.countdown.classList.add('is-on');
  }

  /* ---- touch controls ---- */
  _pointerDown(e) {
    const target = e.target.closest('[data-ctl]');
    if (!target) return;
    e.preventDefault();
    const ctl = target.dataset.ctl;
    try { target.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    this._ptr.set(e.pointerId, { ctl, el: target });
    target.classList.add('is-down');
    if (ctl === 'wheel') {
      const r = target.getBoundingClientRect();
      this._wheel.cx = r.left + r.width / 2; this._wheel.cy = r.top + r.height / 2;
      this._wheel.lastA = Math.atan2(e.clientY - this._wheel.cy, e.clientX - this._wheel.cx);
      this._wheel.dragging = true;
    } else if (ctl === 'horn') {
      this._held.horn = true;
      this._action('horn');
    } else if (ctl in this._held) {
      this._held[ctl] = true;
    }
    this._pushVirtual();
  }

  _pointerMove(e) {
    const p = this._ptr.get(e.pointerId);
    if (!p || p.ctl !== 'wheel') return;
    e.preventDefault();
    const w = this._wheel;
    const a = Math.atan2(e.clientY - w.cy, e.clientX - w.cx);
    let d = a - w.lastA;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    w.lastA = a;
    w.angle = clamp(w.angle + d * 180 / Math.PI, -WHEEL_MAX_DEG, WHEEL_MAX_DEG);
    this._paintWheel();
    this._pushVirtual();
  }

  _pointerUp(e) {
    const p = this._ptr.get(e.pointerId);
    if (!p) return;
    this._ptr.delete(e.pointerId);
    // The same control may still be held by another finger.
    let stillHeld = false;
    for (const o of this._ptr.values()) if (o.ctl === p.ctl) stillHeld = true;
    if (stillHeld) return;
    p.el.classList.remove('is-down');
    if (p.ctl === 'wheel') this._wheel.dragging = false;
    else if (p.ctl in this._held) this._held[p.ctl] = false;
    this._pushVirtual();
  }

  _releaseAll() {
    for (const p of this._ptr.values()) p.el.classList.remove('is-down');
    this._ptr.clear();
    for (const k in this._held) this._held[k] = false;
    this._wheel.dragging = false;
    this._pushVirtual();
  }

  _paintWheel() {
    const a = Math.round(this._wheel.angle * 10) / 10;
    if (a !== this._c.wheelDeg) { this._c.wheelDeg = a; this.el.wheelSvg.style.transform = `rotate(${a}deg)`; }
  }

  _pushVirtual() {
    const h = this._held, v = this.virtual;
    const wheelSteer = this._wheel.angle / WHEEL_MAX_DEG;
    v.steer = clamp(wheelSteer + (h.right ? 1 : 0) - (h.left ? 1 : 0), -1, 1);
    v.throttle = h.throttle ? 1 : 0;
    v.brake = h.brake ? 1 : 0;
    v.boost = h.boost;
    v.dive = (h.up ? 1 : 0) - (h.down ? 1 : 0);
    v.active = h.throttle || h.brake || h.boost || h.left || h.right || h.up || h.down || this._wheel.dragging || Math.abs(wheelSteer) > 0.02;
    this.game?.controls?.setVirtual?.(v);
  }

  _tickTouch(dt) {
    if (!this.touch) return;
    const w = this._wheel;
    if (!w.dragging && w.angle !== 0) {
      w.angle *= Math.exp(-dt * 9);
      if (Math.abs(w.angle) < 0.3) w.angle = 0;
      this._paintWheel();
    }
    if (this.el.touch.classList.contains('is-on')) this._pushVirtual();
  }

  destroy() {
    this._releaseAll();
    this.setTilt(false);
    this.root.innerHTML = '';
    this.root.classList.remove('wr', 'wr-touch-mode');
  }
}

/* ------------------------------------------------------------ devInstall -- */
/**
 * Standalone preview: ?mods=Hud[&screen=title|garage|hub|results|paused][&touch=1]
 * Reuses the HUD Game.js built (or builds one), forces the requested screen,
 * and feeds fake, animating race data while no real race is running. The
 * touch controls drive the real boat through game.controls.
 */
export function devInstall(game) {
  const params = new URLSearchParams(location.search);
  const screen = params.get('screen') || 'race';
  const hud = game.hud instanceof Hud ? game.hud : new Hud(game);
  game.hud = hud;
  if (!hud.boats?.length) hud.setBoats(DEFAULT_BOATS);
  if (!Object.keys(hud.stars).length) hud.setStars({ lagoon: { stars: 3, best: 79.9 }, swell: { stars: 1, best: 130.2 } });

  const fake = { t: 0, lap: 1, countdown: 3.2 };
  const preview = { position: 2, racers: 4, time: 83.4, best: 79.9, stars: 2 };
  const reset = () => { fake.t = 0; fake.lap = 1; fake.countdown = 3.2; };

  // Game.start() shows the hub a moment after boot; the first show() call becomes
  // the previewed screen, and while no real race exists the hub maps to the race
  // preview so pause/resume round-trips keep it up.
  const origShow = hud.show.bind(hud);
  let first = true;
  hud.show = (name, data) => {
    if (first) { first = false; reset(); return origShow(screen, screen === 'results' ? preview : data); }
    if (name === 'hub' && !game.race && screen === 'race') { reset(); name = 'race'; }
    return origShow(name, data);
  };
  setTimeout(() => { if (first) hud.show(screen); }, 1500);

  // Title/garage flow without a real state machine behind it.
  hud.on('start', (info) => { if (game.race) return; if (info.from === 'title') origShow('garage'); else { reset(); origShow('race'); } });
  hud.on('selectBoat', (id, ci) => console.log('[hud] selectBoat', id, ci));

  const origUpdate = hud.update.bind(hud);
  let last = performance.now();
  hud.update = (f) => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!game.race && f) {
      if (hud.screen === 'race') {
        if (fake.countdown > 0) fake.countdown -= dt;
        else { fake.t += dt; fake.lap = Math.min(3, 1 + Math.floor(fake.t / 25)); }
      }
      f.lap = fake.lap; f.laps = 3; f.position = 2; f.racers = 4;
      f.time = fake.t; f.countdown = fake.countdown; f.bestTime = 79.9; f.stars = 2;
      const a = game.time * 0.35;
      f.nextGateDir = Math.atan2(Math.sin(a), Math.cos(a));
    }
    origUpdate(f);
  };
  return hud;
}
