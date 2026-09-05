import * as THREE from 'three';
import { CONDITIONS } from '../ui/Sandbox.js';
import { PropMaterial, trackMotion } from './PropMaterial.js';
import { buildIslands, Soup, box, cylinder } from './Islands.js';

/**
 * World definitions: weather preset + patch, water colour, islands, course,
 * portals. Every world is built around the origin; the race courses are
 * parametric loops sampled at equal arc length so gate spacing is even.
 *
 * Coordinates: metres, +Z is heading 0, +X is heading +PI/2
 * (heading = atan2(dx, dz), matching BoatPhysics).
 */
const DEG = Math.PI / 180;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Sample a closed parametric loop fn(t)->[x,z], t in [0,1), and place n gates
 * at equal arc length. Gate 0 sits half a spacing past t=0 so the start line
 * (t=0) is between the last gate and the first. `avoid` = [{x,z,r}] regions
 * a gate may not sit in (a figure-8 crossing); such gates slide forward.
 */
function loopGates(fn, n, width, { avoid = [] } = {}) {
  const M = 4000;
  const pts = [], cum = [0];
  for (let i = 0; i <= M; i++) pts.push(fn(i / M));
  for (let i = 1; i <= M; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const L = cum[M];
  const at = (s) => {
    s = ((s % L) + L) % L;
    let lo = 0, hi = M;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const f = (s - cum[lo]) / Math.max(cum[hi] - cum[lo], 1e-9);
    const x = pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, z = pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f;
    const p2 = at.raw((s + 2) % L), p1 = at.raw((s - 2 + L) % L);
    return { x, z, heading: Math.atan2(p2[0] - p1[0], p2[1] - p1[1]) };
  };
  at.raw = (s) => {
    let lo = 0, hi = M;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
    const f = (s - cum[lo]) / Math.max(cum[hi] - cum[lo], 1e-9);
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
  };
  const gates = [];
  const spacing = L / n;
  for (let k = 0; k < n; k++) {
    let s = (k + 0.5) * spacing;
    let g = at(s);
    for (let guard = 0; guard < 40; guard++) {
      const bad = avoid.find(a => Math.hypot(g.x - a.x, g.z - a.z) < a.r);
      if (!bad) break;
      s += 6; g = at(s);
    }
    gates.push({ x: +g.x.toFixed(1), z: +g.z.toFixed(1), heading: +g.heading.toFixed(3), width });
  }
  const s0 = at(0);
  return { gates, length: Math.round(L), start: { x: +s0.x.toFixed(1), z: +s0.z.toFixed(1), heading: +s0.heading.toFixed(3) } };
}

const ellipse = (cx, cz, a, b) => (t) => { const th = -Math.PI / 2 + t * Math.PI * 2; return [cx + a * Math.cos(th), cz + b * Math.sin(th)]; };
// Lemniscate of Gerono: a figure-8, lobes left and right of (cx, cz), crossing at the centre.
const figure8 = (cx, cz, a, b) => (t) => { const th = t * Math.PI * 2; return [cx + a * Math.cos(th), cz + b * Math.sin(th) * Math.cos(th)]; };
// Move the start (t = 0) along a loop.
const shift = (fn, t0) => (t) => fn((t + t0) % 1);

// --------------------------------------------------------------- worlds
const lagoonLoop = loopGates(ellipse(0, 0, 270, 175), 8, 52);
// 12 gates at phase 0.5 keep every gate ~90 m clear of the crossing at t = 0.25 / 0.75
// Start on the right lobe just before the crossing, so the first thing the
// player sees is the left island straight ahead through the crossing.
const swellLoop = loopGates(shift(figure8(0, 0, 335, 350), 0.167), 12, 42, { avoid: [{ x: 0, z: 0, r: 60 }] });
const stormLoop = loopGates(ellipse(0, 60, 205, 125), 7, 36);
// Titan Swell: a 16 s swell is ~400 m crest to crest, so the oval is huge and
// the gates sit a full spacing apart (390 m) — one gate per roller, roughly.
const giantLoop = loopGates(ellipse(0, 0, 600, 380), 8, 32);
// Perfect Storm: a tight bay loop tucked under the crescent's lee.
const tempestLoop = loopGates(ellipse(0, 40, 250, 150), 6, 36);

// Hub portals: six rings on an arc 135 m out. The two easy worlds sit dead
// ahead of the start line; the rings get harder toward both ends of the arc.
const HUB_PORTAL_R = 135;
const hubPortal = (deg, dest) => ({
  x: +(HUB_PORTAL_R * Math.sin(deg * DEG)).toFixed(1), z: +(HUB_PORTAL_R * Math.cos(deg * DEG)).toFixed(1),
  heading: deg * DEG, dest,
});

const hub = {
  id: 'hub', name: 'Harbour', icon: 'anchor',
  weather: {
    key: 'golden',
    patch: {
      windSpeed: 3.2, gustiness: 0.1, swellHs: 0.3, swellPeriod: 9.0, choppiness: 1.0, spread: 0.5,
      rain: 0, storm: 0, fog: 0.03, spray: 0, lightningRate: 0,
      sunElevation: 0.17, sunAzimuth: 0.8, sunIntensity: 22, turbidity: 4.5,
      cloudCoverage: 0.32, cloudDensity: 0.55, cloudBottom: 1300, cloudTop: 4200, cloudAnvil: 0.1,
      foamStrength: 0.35, starIntensity: 0.1,
    },
  },
  water: { scatter: [0.016, 0.066, 0.088], absorb: [0.004, 0.020, 0.036] },
  islands: [
    { x: 0, z: -205, radius: 95, height: 24, seed: 11, shape: 'plateau', palms: 26, hut: true },
    { x: -330, z: 250, radius: 70, height: 22, seed: 12, palms: 18 },
    { x: 340, z: 190, radius: 58, height: 18, seed: 13, palms: 14 },
    { x: 70, z: 520, radius: 120, height: 42, seed: 14, palms: 36, lighthouse: true },
    { x: -180, z: -420, radius: 55, height: 16, seed: 15, palms: 10 },
  ],
  piers: [{ x: 0, z: -110, heading: 0, length: 84, width: 4.5 }],
  start: { x: 0, z: 0, heading: 0 },
  gates: [],
  laps: 0,
  portals: [
    hubPortal(-75, 'storm'),
    hubPortal(-45, 'swell'),
    hubPortal(-15, 'lagoon'),
    hubPortal(15, 'giant'),
    hubPortal(45, 'tempest'),
    hubPortal(75, 'deep'),
  ],
  bounds: 750,
};

const lagoon = {
  id: 'lagoon', name: 'Sunny Lagoon', icon: 'sun',
  weather: {
    key: 'clear',
    patch: {
      windSpeed: 3.6, gustiness: 0.1, swellHs: 0.45, swellPeriod: 8.5, choppiness: 1.0, spread: 0.6,
      rain: 0, storm: 0, fog: 0, spray: 0, lightningRate: 0,
      sunElevation: 1.0, sunAzimuth: 3.7, sunIntensity: 26, turbidity: 1.8,
      cloudCoverage: 0.14, cloudDensity: 0.35, cloudBottom: 1600, cloudTop: 2700, cloudAnvil: 0,
      foamStrength: 0.35,
    },
  },
  // green pushed up level with blue: turquoise enamel
  water: { scatter: [0.050, 0.200, 0.200], absorb: [0.010, 0.042, 0.050] },
  islands: [
    { x: -112, z: 4, radius: 60, height: 26, seed: 21, palms: 26 },
    { x: 112, z: -18, radius: 56, height: 22, seed: 22, shape: 'plateau', palms: 34, hut: true },
    { x: -5, z: 82, radius: 34, height: 13, seed: 23, palms: 12 },
    // scenery outside the loop: something to look at from the start line and the horizon
    { x: 390, z: -310, radius: 48, height: 17, seed: 24, palms: 14, scenery: true },
    { x: -470, z: 330, radius: 60, height: 21, seed: 25, palms: 16, scenery: true },
    { x: 620, z: -110, radius: 72, height: 26, seed: 26, palms: 20, scenery: true },
  ],
  start: lagoonLoop.start,
  gates: lagoonLoop.gates,
  lapLength: lagoonLoop.length,
  laps: 3,
  portals: [{ x: -70, z: -250, heading: Math.PI, dest: 'hub' }],
  bounds: 900,
};

const swell = {
  id: 'swell', name: 'Rolling Swell', icon: 'wave',
  weather: {
    key: 'trade',
    patch: {
      windSpeed: 6.5, gustiness: 0.25, swellHs: 1.7, swellPeriod: 13.0, choppiness: 1.15, spread: 0.55,
      rain: 0, storm: 0.05, fog: 0.03, spray: 0.15, lightningRate: 0,
      sunElevation: 0.72, sunAzimuth: 3.4, sunIntensity: 24, turbidity: 2.4,
      cloudCoverage: 0.30, cloudDensity: 0.9, cloudBottom: 1200, cloudTop: 2800, cloudAnvil: 0.0,
      foamStrength: 1.0,
    },
  },
  water: { scatter: [0.014, 0.062, 0.100], absorb: [0.004, 0.020, 0.040] },
  islands: [
    { x: -185, z: 0, radius: 76, height: 44, seed: 31, palms: 30 },
    { x: 185, z: 0, radius: 68, height: 38, seed: 32, shape: 'plateau', palms: 28, lighthouse: true },
  ],
  start: swellLoop.start,
  gates: swellLoop.gates,
  lapLength: swellLoop.length,
  laps: 2,
  portals: [{ x: 235, z: 235, heading: Math.PI / 4, dest: 'hub' }],
  bounds: 1000,
};

const storm = {
  id: 'storm', name: 'Storm Run', icon: 'lightning',
  weather: {
    key: 'squall',
    patch: {
      windSpeed: 10, gustiness: 0.5, swellHs: 2.2, swellPeriod: 9.5, choppiness: 1.3, spread: 0.8,
      rain: 0.9, storm: 0.85, fog: 0.18, spray: 0.9, lightningRate: 0.6,
      sunElevation: 0.2, sunAzimuth: 3.0, sunIntensity: 14, turbidity: 6.0,
      cloudCoverage: 0.76, cloudDensity: 1.15, cloudBottom: 600, cloudTop: 5200, cloudAnvil: 0.6,
      foamStrength: 1.5,
    },
  },
  // Auto-exposure would lift an overcast sky to flat grey; hold it down so the squall reads dark.
  exposure: 0.7,
  water: { scatter: [0.010, 0.042, 0.052], absorb: [0.003, 0.012, 0.022] },
  islands: [
    // one big crescent wrapping the far side of the bay
    { x: 0, z: 60, radius: 100, height: 58, seed: 41, shape: 'crescent', palms: 40, warp: 0.2, detail: 0.1,
      arc: { r: 315, a0: 22 * DEG, a1: 158 * DEG, thick: 72 } },
    { x: -340, z: -130, radius: 48, height: 15, seed: 42, palms: 8 },
    { x: 350, z: -140, radius: 44, height: 13, seed: 43, palms: 6 },
  ],
  start: stormLoop.start,
  gates: stormLoop.gates,
  lapLength: stormLoop.length,
  laps: 2,
  portals: [{ x: -95, z: -150, heading: Math.PI, dest: 'hub' }],
  bounds: 800,
};

const giant = {
  id: 'giant', name: 'Titan Swell', icon: 'giantwave',
  weather: {
    key: 'clear',
    patch: {
      // Glassy between the rollers: almost no wind sea, one enormous long-period
      // swell. Integrates to Hs ~15 m (50 ft) with a ~400 m wavelength.
      windSpeed: 5.5, gustiness: 0.1, swellHs: 15, swellPeriod: 16, choppiness: 0.85, spread: 0.35,
      rain: 0, storm: 0, fog: 0.02, spray: 0.25, lightningRate: 0,
      sunElevation: 0.9, sunAzimuth: 3.9, sunIntensity: 26, turbidity: 1.6,
      cloudCoverage: 0.18, cloudDensity: 0.4, cloudBottom: 1800, cloudTop: 3000, cloudAnvil: 0,
      foamStrength: 0.8,
    },
  },
  // saturated deep blue: open-ocean scattering with the green held back
  water: { scatter: [0.010, 0.050, 0.112], absorb: [0.003, 0.016, 0.034] },
  islands: [
    // one tall spire in the middle of the oval, two big landmarks far outside it;
    // every gate is >= 300 m from any shore so a 400 m roller never breaks on one
    { x: 0, z: 0, radius: 70, height: 78, seed: 51, palms: 22, hut: true },
    { x: -1000, z: 300, radius: 115, height: 92, seed: 52, palms: 34, lighthouse: true },
    { x: 1000, z: -300, radius: 105, height: 84, seed: 53, shape: 'plateau', palms: 30 },
  ],
  start: giantLoop.start,
  gates: giantLoop.gates,
  gateSpacing: [300, 450],
  lapLength: giantLoop.length,
  laps: 2,
  portals: [{ x: -130, z: -480, heading: Math.PI, dest: 'hub' }],
  probeSpan: 400,
  bounds: 1400,
};

const tempest = {
  id: 'tempest', name: 'The Perfect Storm', icon: 'tempest',
  weather: {
    key: 'storm',
    patch: {
      // Beaufort 11 base; wind sea trimmed so the total integrates to Hs ~8 m
      windSpeed: 23, gustiness: 0.6, swellHs: 4.2, swellPeriod: 11.5, choppiness: 1.4, spread: 0.9,
      rain: 1.0, storm: 1.0, fog: 0.5, spray: 1.4, lightningRate: 1.5,
      // sun just under the horizon: no sunset band to face, the sky is lit by
      // the deck's own glow and the lightning
      sunElevation: -0.12, sunAzimuth: 2.9, sunIntensity: 6, turbidity: 7.0,
      cloudCoverage: 0.8, cloudDensity: 1.2, cloudBottom: 480, cloudTop: 5600, cloudAnvil: 0.8,
      foamStrength: 1.1, starIntensity: 0.35,
    },
  },
  // Auto-exposure would lift a black squall to flat grey; hold it well down so it
  // reads as night-dark while the boat and gates stay legible.
  exposure: 0.6,
  // thunder purple: red lifted level with green so the water goes violet-black
  water: { scatter: [0.014, 0.018, 0.050], absorb: [0.004, 0.011, 0.020] },
  islands: [
    // a huge crescent wrapping the whole north side of the bay: the back straight
    // runs in its lee, the front straight is out in the open sea. Steep shelf
    // (shelf 0.6): an 8 m trough over a long sandy shelf grounds boats.
    { x: 0, z: 80, radius: 120, height: 82, seed: 61, shape: 'crescent', palms: 40, warp: 0.18, detail: 0.1, shelf: 0.6,
      arc: { r: 470, a0: 20 * DEG, a1: 160 * DEG, thick: 90 } },
    { x: -430, z: -230, radius: 50, height: 17, seed: 62, palms: 8 },
    { x: 440, z: -270, radius: 46, height: 15, seed: 63, palms: 6 },
  ],
  start: tempestLoop.start,
  gates: tempestLoop.gates,
  lapLength: tempestLoop.length,
  laps: 2,
  portals: [{ x: -110, z: -230, heading: Math.PI, dest: 'hub' }],
  probeSpan: 300,
  bounds: 850,
  // Periodic drama, driven by updateWorldEvents() below. Times in seconds.
  events: {
    rogue: { first: 18, every: [35, 50], height: 14, radius: 200, wavelength: 320, distance: 420 },
    spout: { first: 30, every: [75, 110], strength: 20, distance: [520, 720], minStartDist: 400 },
    lightning: { first: 4, every: [9, 16], count: [4, 8], radius: 1500 },
  },
};

export const WORLDS = { hub, lagoon, swell, storm, giant, tempest };

// --------------------------------------------------------------- events
/**
 * Per-world scripted drama (rogue waves, distant waterspouts, lightning
 * bursts) on top of the weather director's ambient state. Game.js calls
 * `updateWorldEvents(app, def, dt)` every frame with the current world def;
 * state lives here keyed by def.id and is reset whenever the world is rebuilt.
 *
 * def.events = {
 *   rogue:     { first, every: [min, max], height, radius, wavelength, distance },
 *   spout:     { first, every: [min, max], strength, distance: [min, max], minStartDist },
 *   lightning: { first, every: [min, max], count: [min, max], radius },   // radius: how close the bolts land
 * }
 * `?eventRate=N` (dev) runs every timer N times faster.
 */
const eventState = new Map();
const _camVel = new THREE.Vector3();
const GRAVITY = 9.81;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (v) => (Array.isArray(v) ? rand(v[0], v[1]) : v);

let eventRate = 1;
if (typeof location !== 'undefined') {
  const r = parseFloat(new URLSearchParams(location.search).get('eventRate') || '1');
  if (Number.isFinite(r) && r > 0) eventRate = r;
}

export function resetWorldEvents(id) {
  if (id === undefined) eventState.clear();
  else eventState.delete(id);
}

export function updateWorldEvents(app, def, dt) {
  const ev = def?.events;
  const director = app?.director;
  if (!ev || !director || !(dt > 0)) return;
  let st = eventState.get(def.id);
  if (!st) {
    st = { time: 0, next: {} };
    for (const k of Object.keys(ev)) st.next[k] = (ev[k].first ?? pick(ev[k].every)) / eventRate;
    eventState.set(def.id, st);
  }
  st.time += dt;
  const cam = app.camera.position;
  const w = app.weather?.state;
  // Smoothed camera velocity: rogue waves are aimed at where the boat is going.
  if (!st.prev) { st.prev = cam.clone(); st.vel = new THREE.Vector3(); }
  _camVel.copy(cam).sub(st.prev).divideScalar(dt);
  if (_camVel.lengthSq() < 60 * 60) st.vel.lerp(_camVel, 1 - Math.exp(-dt * 2));   // ignore teleports
  st.prev.copy(cam);
  for (const k of Object.keys(ev)) {
    if (st.time < st.next[k]) continue;
    const e = ev[k];
    st.next[k] = st.time + pick(e.every) / eventRate;
    if (k === 'rogue') {
      // Form the group upwind-ish of the player and send it through where the
      // boat will be when it arrives (half the travel time of prediction).
      const base = w?.swellAngle ?? w?.windAngle ?? 1.0;
      const ang = base + rand(-0.9, 0.9);
      const dist = e.distance ?? 420;
      const wavelength = e.wavelength ?? 320;
      const speed = Math.sqrt(GRAVITY * wavelength / (2 * Math.PI));
      const lead = Math.min(dist / speed * 0.5, 10);
      const tx = cam.x + st.vel.x * lead, tz = cam.z + st.vel.z * lead;
      director.spawnRogue({
        x: tx - Math.cos(ang) * dist, z: tz - Math.sin(ang) * dist,
        angle: ang, height: e.height ?? 14, radius: e.radius ?? 200, wavelength, speed,
      });
    } else if (k === 'spout') {
      // A distant funnel: well away from the player and from the start line.
      const s = def.start || { x: 0, z: 0 };
      let x = 0, z = 0;
      for (let tries = 0; tries < 8; tries++) {
        const ang = Math.random() * Math.PI * 2, d = pick(e.distance ?? [520, 720]);
        x = cam.x + Math.cos(ang) * d; z = cam.z + Math.sin(ang) * d;
        if (Math.hypot(x - s.x, z - s.z) >= (e.minStartDist ?? 400)) break;
      }
      director.spawnWaterspout(x, z, e.strength ?? 20);
    } else if (k === 'lightning') {
      const n = Math.round(pick(e.count ?? 6));
      // closer than the director's ambient bursts so the bolts land in frame
      if (app.lightning?.burst && e.radius) app.lightning.burst(n, { cloudBase: w?.cloudBottom ?? 600, radius: e.radius, window: 2.5 });
      else director.lightningBurst(n);
    }
  }
}

// -------------------------------------------------------------- weather
/** Full weather record for a world: preset + patch + water colour. */
export function worldWeather(def) {
  const base = CONDITIONS[def.weather.key]?.w || CONDITIONS.clear.w;
  const w = { ...base, ...def.weather.patch };
  if (def.water) {
    w.waterScatter = new THREE.Vector3().fromArray(def.water.scatter);
    w.waterAbsorb = new THREE.Vector3().fromArray(def.water.absorb);
  }
  return w;
}

export function applyWorldWeather(app, def, immediate = false) {
  app.weather.set(worldWeather(def), immediate);
  // Per-world exposure bias (post stack); most worlds leave it at 1.
  if (app.post?.settings && 'exposureBias' in app.post.settings) app.post.settings.exposureBias = def.exposure ?? 1.0;
}

// -------------------------------------------------------------- building
/**
 * @param {string} id world id
 * @param {{ app, atmosphere, scene }} ctx
 * @returns {{ id, def, group, heightAt(x,z), terrainAt(x,z), triangles, dispose() }}
 */
export function buildWorld(id, ctx) {
  const def = WORLDS[id];
  if (!def) throw new Error(`unknown world '${id}'`);
  const atmosphere = ctx.atmosphere || ctx.app?.atmosphere;
  resetWorldEvents(id);
  const group = new THREE.Group();
  group.name = `world-${id}`;
  const islands = buildIslands(def.islands, atmosphere, { piers: def.piers || [] });
  group.add(islands.group);
  const world = {
    id, def, group,
    islands,
    // heightAt is what BoatPhysics.groundFn wants: true seabed in the water,
    // a soft wall from the shoreline up (see Islands.collisionHeight).
    // terrainAt is the surface the mesh actually shows.
    heightAt: islands.heightAt,
    terrainAt: islands.terrainAt,
    triangles: islands.triangles,
    dispose() {
      islands.dispose();
      group.removeFromParent();
    },
  };
  return world;
}

// ------------------------------------------------------------- dev hook
/**
 * ?mods=Worlds&world=lagoon[&view=high|close][&at=x,z,headingDeg]
 * Free-drive test of one world: loads it through game.loadWorld when the game
 * exposes it (so portals, race and weather all see the same world), otherwise
 * builds it directly; applies its weather, gives every boat the terrain
 * collider, parks the player on the start line and marks gates (green) and
 * portals (magenta) with tall pillars so the layout can be checked in game.
 * The race is not started: this is a layout/visual check, not a race test.
 */
export async function devInstall(game) {
  const params = new URLSearchParams(location.search);
  const id = WORLDS[params.get('world')] ? params.get('world') : 'lagoon';
  let world;
  if (typeof game.loadWorld === 'function') {
    await game.loadWorld(id, true);
    world = game.world;
  } else {
    world = buildWorld(id, { app: game.app, atmosphere: game.app.atmosphere, scene: game.scene });
    game.scene.add(world.group);
    game.world = world;
    applyWorldWeather(game.app, world.def, true);
    game.weatherKey = world.def.weather.key;
  }
  for (const b of game.boats) b.body.groundFn = world.heightAt;
  const at = (params.get('at') || '').split(',').map(Number);
  const s = at.length >= 2 && at.every(Number.isFinite)
    ? { x: at[0], z: at[1], heading: (at[2] || 0) * Math.PI / 180 }
    : world.def.start;
  const place = () => {
    const y = game.sea.heightAt(s.x, s.z) + 0.3;
    game.player.body.setPose(s.x, y, s.z, s.heading);
    game.sea.setFocus?.(s.x, s.z);
    game.camera.orbit = null;
    game.camera.follow(game.player.body);
    const view = params.get('view');
    if (view === 'high') game.camera.viewIndex = 2;
    else if (view === 'close') game.camera.viewIndex = 1;
  };
  if (game.player) place();
  // Free drive in this world instead of the normal title -> hub flow.
  game.start = () => {
    if (game.player) place();
    game.state = 'hub';
    game.hud?.show?.('hub');
  };

  // debug markers: baked into world space (one mesh per colour) so the shared
  // material's motion vectors stay exact and TAA does not ghost them
  const markers = new THREE.Group();
  markers.name = 'world-markers';
  const white = new THREE.Color(1, 1, 1);
  const marker = (emissive, build) => {
    const soup = new Soup();
    build(soup);
    if (!soup.triangles) return;
    const mat = new PropMaterial({ color: 0x202020, roughness: 0.6 }, game.app.atmosphere);
    mat.emissive.setRGB(...emissive);
    const m = new THREE.Mesh(soup.geometry(), mat);
    m.matrixAutoUpdate = false; m.updateMatrix();
    trackMotion(m);
    markers.add(m);
  };
  marker([0.4, 6.0, 1.2], (sp) => {
    world.def.gates.forEach((g, i) => {
      cylinder(sp, [g.x, g.z], -2, 26, 0.5, 0.5, 8, white);
      // crossbar shows width and orientation; nubs on top count the gate index
      box(sp, g.x, 6, g.z, g.width, 0.3, 0.3, g.heading, white);
      for (let k = 0; k <= i; k++) box(sp, g.x, 27 + k * 1.2, g.z, 2.4, 0.6, 0.6, 0, white);
    });
  });
  marker([6.0, 0.6, 6.0], (sp) => {
    for (const p of world.def.portals) {
      cylinder(sp, [p.x, p.z], -2, 26, 0.7, 0.7, 8, white);
      box(sp, p.x, 4, p.z, 12, 0.5, 0.5, p.heading, white);
    }
  });
  marker([6.0, 5.0, 0.6], (sp) => {
    const fx = Math.sin(s.heading), fz = Math.cos(s.heading);
    for (const side of [-1, 1]) cylinder(sp, [s.x + fz * side * 12, s.z - fx * side * 12], -2, 6, 0.4, 0.4, 6, white);
  });
  game.scene.add(markers);
  world.markers = markers;
  window.__world = world;
  console.log(`[Worlds] ${id}: ${world.triangles} triangles, ${world.def.gates.length} gates, lap ${world.def.lapLength || 0} m`);
  return world;
}
