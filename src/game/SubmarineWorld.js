import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { PropMaterial, trackMotion } from './PropMaterial.js';
import { Soup, box, fbm, mulberry32 } from './Islands.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';

/**
 * The Deep Run: the submarine world.
 *
 * One analytic seabed — a sandy plain that shoals toward the start, a rock
 * table cut by a winding canyon (a spline path with a floor-depth and width
 * profile), a wide sandy basin with a wreck-like rock pile, and a few pillars —
 * sampled into flat-shaded, face-coloured heightfield tiles that share one
 * PropMaterial. `heightAt(x, z)` evaluates the same analytic function the tiles
 * were sampled from, so it is exact, allocation-free and well under a
 * microsecond.
 *
 * Cheap life: kelp strands merged into one mesh and swayed in the vertex
 * shader (PropMaterial's KELP_WAVE), and a marine-snow / bubble point cloud that
 * wraps around the camera.
 *
 * The underwater *look* is uniforms only — see setSubmerged(): the sky
 * background, the sea seen from below, PropMaterial's depth attenuation and the
 * post composite's distance fog all read U.uSubmerged / U.uSubFog / U.uSubAbsorb
 * and switch per frame with no shader recompiles.
 *
 * Coordinates: metres, +Z is heading 0, +X is heading +PI/2 (heading =
 * atan2(dx, dz), matching the boats). y negative = depth.
 */
// Table-driven value noise for the seabed: heightAt() is on the physics path
// for every submarine every frame, and Islands.fbm's integer-hash noise is
// several times slower than two permutation lookups. Build-time colouring
// still uses Islands.fbm.
const PERM = new Uint8Array(512), VAL = new Float32Array(512);
(() => {
  const rng = mulberry32(90210);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = (rng() * (i + 1)) | 0; const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) { PERM[i] = p[i & 255]; VAL[i] = rng() * 2 - 1; }
})();
function noise2(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const X = ix & 255, Z = iz & 255;
  const a = VAL[PERM[X] + Z], b = VAL[PERM[X + 1] + Z], c = VAL[PERM[X] + Z + 1], d = VAL[PERM[X + 1] + Z + 1];
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
/** Two rotated octaves in roughly [-1, 1]. `o` offsets the lattice so fields do not correlate. */
function fbm2(x, z, o) {
  const n0 = noise2(x + o, z + o * 0.37);
  const nx = x * 1.92 + z * 0.62 + 13.7, nz = -x * 0.62 + z * 1.92 + 7.1;
  return (n0 + 0.5 * noise2(nx + o, nz)) / 1.5;
}
// Pillars and the wreck as flat arrays: heightAt() is hot, and object property loads add up.
const PILLAR_X = new Float32Array(6), PILLAR_Z = new Float32Array(6), PILLAR_R = new Float32Array(6), PILLAR_R2 = new Float32Array(6),
  PILLAR_H = new Float32Array(6), PILLAR_BASE = new Float32Array(6);

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smoothstep = (a, b, t) => { t = clamp01((t - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

export const SUB_RENDER_ORDER = -1;      // with the islands: before the (far heavier) sea

// ------------------------------------------------------------------ course
// The hoop path as a closed Catmull-Rom loop through these points. The canyon
// is carved along points 2..7; the basin holds 8..11; 12..16 is the shallow
// return over the plain, rising back to the surface start.
const PATH = [
  [0, 0, 0],        // 0  start: surface, heading +z
  [6, -14, 90],     // 1  diving
  [22, -26, 170],   // 2  canyon mouth
  [58, -33, 250],   // 3  canyon
  [62, -41, 330],   // 4  canyon, tightest
  [22, -47, 400],   // 5  canyon
  [-26, -50, 470],  // 6  canyon, deepest
  [-8, -46, 540],   // 7  canyon exit
  [52, -42, 610],   // 8  into the basin
  [118, -40, 665],  // 9  basin
  [70, -38, 745],   // 10 basin, turning back
  [-55, -36, 735],  // 11 basin west
  [-160, -31, 655], // 12 return leg
  [-192, -26, 520], // 13
  [-172, -20, 380], // 14
  [-122, -14, 240], // 15
  [-58, -8, 110],   // 16 rising to the start
];
const N_PATH = PATH.length;
const GATE_IDX = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16];
const CANYON_T0 = 1.6 / N_PATH, CANYON_T1 = 7.4 / N_PATH;   // path params the carve runs between

/** Closed Catmull-Rom through PATH; t in [0, 1) maps one control point per 1/N. */
export function pathPoint(t, out = new THREE.Vector3()) {
  t = ((t % 1) + 1) % 1;
  const f = t * N_PATH, i = Math.floor(f), u = f - i;
  const p0 = PATH[(i - 1 + N_PATH) % N_PATH], p1 = PATH[i % N_PATH], p2 = PATH[(i + 1) % N_PATH], p3 = PATH[(i + 2) % N_PATH];
  const u2 = u * u, u3 = u2 * u;
  for (let k = 0; k < 3; k++) {
    const v = 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3);
    if (k === 0) out.x = v; else if (k === 1) out.y = v; else out.z = v;
  }
  return out;
}
const _pa = new THREE.Vector3(), _pb = new THREE.Vector3();
function pathHeading(t) {
  pathPoint(t - 0.002, _pa); pathPoint(t + 0.002, _pb);
  return Math.atan2(_pb.x - _pa.x, _pb.z - _pa.z);
}

// The canyon centreline: the spline between CANYON_T0..T1 resampled into a
// polyline with a floor depth and half-width per sample.
const CANYON_N = 28;
const CX = new Float32Array(CANYON_N), CZ = new Float32Array(CANYON_N), CY = new Float32Array(CANYON_N), CW = new Float32Array(CANYON_N);
const RIM_Y = -12;          // rock table top
const FLOOR_MIN = -60;
const TABLE_REACH = 150;    // metres from the centreline the rock table fades out over
const CBOX = { x0: 1e9, x1: -1e9, z0: 1e9, z1: -1e9 };   // canyon + table bounding box
(() => {
  for (let i = 0; i < CANYON_N; i++) {
    const s = i / (CANYON_N - 1);
    pathPoint(mix(CANYON_T0, CANYON_T1, s), _pa);
    CX[i] = _pa.x; CZ[i] = _pa.z;
    CY[i] = Math.max(_pa.y - 11, FLOOR_MIN);
    // wide mouth, 13 m half-width (26 m wall to wall) through the middle, wide exit
    CW[i] = mix(22, 24, s) - 10 * smoothstep(0.15, 0.45, s) * smoothstep(0.85, 0.55, s) + 1.5 * Math.sin(s * 23);
    CBOX.x0 = Math.min(CBOX.x0, _pa.x - TABLE_REACH); CBOX.x1 = Math.max(CBOX.x1, _pa.x + TABLE_REACH);
    CBOX.z0 = Math.min(CBOX.z0, _pa.z - TABLE_REACH); CBOX.z1 = Math.max(CBOX.z1, _pa.z + TABLE_REACH);
  }
})();

const _near = { d: 0, s: 0, floor: 0, w: 0 };
function nearestSegment(x, z, i0, i1, out) {
  let best = 1e9, bi = i0, bf = 0;
  for (let i = i0; i < i1; i++) {
    const ax = CX[i], az = CZ[i], bx = CX[i + 1] - ax, bz = CZ[i + 1] - az;
    let f = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const dx = ax + bx * f - x, dz = az + bz * f - z;
    const d = dx * dx + dz * dz;
    if (d < best) { best = d; bi = i; bf = f; }
  }
  out[0] = best; out[1] = bi; out[2] = bf;
  return out;
}
// Coarse lookup of the nearest canyon segment per 10 m cell over the bounding
// box, so a query tests that segment and its neighbours instead of all of them.
const NEAR_CELL = 10;
const NEAR_NX = Math.ceil((CBOX.x1 - CBOX.x0) / NEAR_CELL) + 1, NEAR_NZ = Math.ceil((CBOX.z1 - CBOX.z0) / NEAR_CELL) + 1;
const NEAR_IDX = new Uint8Array(NEAR_NX * NEAR_NZ);
(() => {
  const tmp = [0, 0, 0];
  for (let j = 0; j < NEAR_NZ; j++) for (let i = 0; i < NEAR_NX; i++) {
    nearestSegment(CBOX.x0 + (i + 0.5) * NEAR_CELL, CBOX.z0 + (j + 0.5) * NEAR_CELL, 0, CANYON_N - 1, tmp);
    NEAR_IDX[j * NEAR_NX + i] = tmp[1];
  }
})();
const _seg = [0, 0, 0];
/** Nearest point on the canyon polyline: distance, param (0..1), floor depth, half-width. Call inside CBOX. */
function nearestCanyon(x, z) {
  let ci = ((x - CBOX.x0) / NEAR_CELL) | 0, cj = ((z - CBOX.z0) / NEAR_CELL) | 0;
  ci = ci < 0 ? 0 : ci >= NEAR_NX ? NEAR_NX - 1 : ci;
  cj = cj < 0 ? 0 : cj >= NEAR_NZ ? NEAR_NZ - 1 : cj;
  const guess = NEAR_IDX[cj * NEAR_NX + ci];
  nearestSegment(x, z, Math.max(0, guess - 2), Math.min(CANYON_N - 1, guess + 3), _seg);
  const bi = _seg[1], bf = _seg[2];
  _near.d = Math.sqrt(_seg[0]);
  _near.s = (bi + bf) / (CANYON_N - 1);
  _near.floor = CY[bi] + (CY[bi + 1] - CY[bi]) * bf;
  _near.w = CW[bi] + (CW[bi + 1] - CW[bi]) * bf;
  return _near;
}

// ------------------------------------------------------------------ seabed
const PLAIN_Y = -44;
const BASIN = { x: 50, z: 690, r: 140, y: -54 };
const WRECK = { x: 40, z: 690, r: 22, h: 9 };
const PILLARS = [
  { x: -100, z: 600, r: 6, h: 22 }, { x: 150, z: 610, r: 5, h: 18 }, { x: -20, z: 790, r: 7, h: 26 },
  { x: -240, z: 450, r: 6, h: 20 }, { x: 120, z: 100, r: 5, h: 16 }, { x: -300, z: 250, r: 6, h: 18 },
];

/** The seabed without pillars or the wreck (their bases are sampled from this). */
function baseSeabed(x, z) {
  const n1 = fbm2(x * 0.012, z * 0.012, 17.3);        // ~80 m sand hills
  const n2 = noise2(x * 0.06 + 91.1, z * 0.06 + 33.7); // ripples and rubble (one octave: 1 m relief)
  // open plain, shoaling toward the surface start
  let h = PLAIN_Y + n1 * 6 + n2 * 1.2 + 14 * smoothstep(300, 40, Math.sqrt(x * x + z * z));   // (Math.hypot is ~100 ns in V8)
  // the basin: a wide flat sandy bowl
  const bx = x - BASIN.x, bz = z - BASIN.z;
  const basin = smoothstep(BASIN.r + 70, BASIN.r - 30, Math.sqrt(bx * bx + bz * bz));
  h = mix(h, BASIN.y + n2 * 0.8, basin);
  // Nothing of the canyon reaches past its bounding box: most of the plain skips the search.
  if (x < CBOX.x0 || x > CBOX.x1 || z < CBOX.z0 || z > CBOX.z1) return h;
  // the rock table the canyon cuts through, fading out at both ends of the cut
  const c = nearestCanyon(x, z);
  if (c.d > TABLE_REACH) return h;
  const along = smoothstep(0, 0.16, c.s) * smoothstep(1, 0.84, c.s);
  const table = smoothstep(TABLE_REACH, 80, c.d) * along * (1 - basin);
  h = mix(h, RIM_Y + n1 * 3 + n2 * 1.5, table);
  // carve: floor, then a steep craggy wall up to well above the table
  if (c.d > c.w + 30) return h;
  const dn = c.d + 5 * fbm2(x * 0.045, z * 0.045, 41.7);
  const carve = c.floor + n2 * 0.9 + (RIM_Y + 12 - c.floor) * smoothstep(c.w, c.w + 17, dn);
  return Math.min(h, carve);
}
for (let i = 0; i < PILLARS.length; i++) {
  const p = PILLARS[i];
  p.base = baseSeabed(p.x, p.z);
  PILLAR_X[i] = p.x; PILLAR_Z[i] = p.z; PILLAR_R[i] = p.r; PILLAR_R2[i] = p.r * p.r * 2.56; PILLAR_H[i] = p.h; PILLAR_BASE[i] = p.base;
}
WRECK.base = baseSeabed(WRECK.x, WRECK.z);
const WRECK_R2 = WRECK.r * WRECK.r;

/** Seabed height (m, negative) at world (x, z). Exact for the mesh's own source function. */
export function seabedAt(x, z) {
  let h = baseSeabed(x, z);
  for (let i = 0; i < 6; i++) {
    const dx = x - PILLAR_X[i], dz = z - PILLAR_Z[i], d2 = dx * dx + dz * dz;
    if (d2 < PILLAR_R2[i]) h = Math.max(h, PILLAR_BASE[i] + PILLAR_H[i] * smoothstep(PILLAR_R[i] * 1.6, PILLAR_R[i] * 0.5, Math.sqrt(d2)));
  }
  const wx = x - WRECK.x, wz = z - WRECK.z, wd2 = wx * wx + wz * wz;
  if (wd2 < WRECK_R2) h = Math.max(h, WRECK.base + WRECK.h * (1 - wd2 / WRECK_R2));
  return h;
}

// --------------------------------------------------------------- world def
const gates = GATE_IDX.map((i) => {
  const p = PATH[i];
  const inCanyon = i >= 3 && i <= 7;
  return { x: p[0], y: p[1], z: p[2], heading: +pathHeading(i / N_PATH).toFixed(3), width: inCanyon ? 14 : (i === 2 || i === 8) ? 16 : 18 };
});

const deep = {
  id: 'deep', name: 'The Deep Run', icon: 'submarine', underwater: true,
  weather: {
    key: 'clear',
    patch: {
      windSpeed: 4.0, gustiness: 0.1, swellHs: 0.6, swellPeriod: 8.0, choppiness: 1.0, spread: 0.6,
      rain: 0, storm: 0, fog: 0, spray: 0, lightningRate: 0,
      sunElevation: 1.05, sunAzimuth: 3.9, sunIntensity: 26, turbidity: 1.6,
      cloudCoverage: 0.10, cloudDensity: 0.3, cloudBottom: 1800, cloudTop: 2800, cloudAnvil: 0,
      foamStrength: 0.4,
    },
  },
  water: { scatter: [0.045, 0.190, 0.200], absorb: [0.010, 0.040, 0.050] },
  // Underwater look. color = fraction of the sky irradiance the water column
  // glows with at the surface; density per metre (~80 m visibility); absorb =
  // per-metre loss with depth (red first) that turns the turquoise deep blue.
  fog: { color: [0.09, 0.31, 0.37], density: 0.022, absorb: [0.045, 0.015, 0.006] },
  // Auto-exposure would lift the water column to pastel; hold it down so the blue stays deep.
  exposure: 0.85,
  start: { x: 0, y: 0, z: 0, heading: 0 },
  gates,
  laps: 1,
  portals: [{ x: 40, z: -70, heading: Math.PI, dest: 'hub' }],
  bounds: 900,
  // dev/tour helpers
  path: PATH,
};

export const SUB_WORLDS = { deep };

// ---------------------------------------------------------------- palette
const C = (hex) => new THREE.Color(hex);
const PAL = {
  sand: C(0xe9d9a6), sandDeep: C(0xb8b391), rock: C(0x66594d), rockDark: C(0x3a322b),
  algae: C(0x4f8a34), algaeLight: C(0x83b23c), kelp: C(0x3f6b1f), kelpTip: C(0x8fb83a), wreck: C(0x3b3a3d),
};
const _c = new THREE.Color(), _c2 = new THREE.Color();

function seabedColor(h, slope, n) {
  const c = _c.copy(PAL.sand).lerp(PAL.sandDeep, smoothstep(-25, -60, h));
  // algae on flat-ish ledges high up: the table top and the canyon rims
  const algae = smoothstep(-30, -14, h) * (1 - smoothstep(0.5, 0.9, slope)) * clamp01(0.55 + n * 1.2);
  c.lerp(_c2.copy(PAL.algae).lerp(PAL.algaeLight, clamp01(0.5 + n)), algae);
  // rock on steep faces (slope = rise/run; 1 = 45 deg)
  c.lerp(_c2.copy(PAL.rock).lerp(PAL.rockDark, clamp01(0.5 + n * 0.8)), smoothstep(0.5, 1.1, slope));
  return c;
}

// ------------------------------------------------------------- tile mesh
const TILE = 100;
const _grid = new Float32Array(64 * 64);
const _p = [0, 0, 0], _q = [0, 0, 0], _r = [0, 0, 0], _s = [0, 0, 0];

/** One heightfield tile with a skirt hanging from its edges (hides LOD seams). */
function buildTile(soup, x0, z0, cells) {
  const n = cells + 1, step = TILE / cells;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) _grid[j * n + i] = seabedAt(x0 + i * step, z0 + j * step);
  const emit = (p, q, r) => {
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const slope = Math.hypot(nx, nz) / Math.max(Math.abs(ny), 1e-3);
    const mx = (p[0] + q[0] + r[0]) / 3, mh = (p[1] + q[1] + r[1]) / 3, mz = (p[2] + q[2] + r[2]) / 3;
    const col = seabedColor(mh, slope, fbm(mx * 0.05, mz * 0.05, 511, 2));
    if (ny >= 0) soup.tri(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], col);
    else soup.tri(p[0], p[1], p[2], r[0], r[1], r[2], q[0], q[1], q[2], col);
  };
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      _p[0] = x0 + i * step; _p[1] = _grid[j * n + i]; _p[2] = z0 + j * step;
      _q[0] = _p[0] + step; _q[1] = _grid[j * n + i + 1]; _q[2] = _p[2];
      _r[0] = _p[0]; _r[1] = _grid[(j + 1) * n + i]; _r[2] = _p[2] + step;
      _s[0] = _q[0]; _s[1] = _grid[(j + 1) * n + i + 1]; _s[2] = _r[2];
      // alternate the diagonal so the sand does not show a bias
      if ((i + j) & 1) { emit(_p, _r, _s); emit(_p, _s, _q); } else { emit(_p, _r, _q); emit(_q, _r, _s); }
    }
  }
  // skirts: a wall dropping from each edge, coloured like deep rock
  const DROP = 12;
  const skirt = (ax, az, ah, bx, bz, bh) => {
    soup.quad([ax, ah, az], [bx, bh, bz], [bx, bh - DROP, bz], [ax, ah - DROP, az], PAL.rockDark);
    soup.quad([ax, ah - DROP, az], [bx, bh - DROP, bz], [bx, bh, bz], [ax, ah, az], PAL.rockDark);
  };
  for (let i = 0; i < cells; i++) {
    const xa = x0 + i * step, xb = xa + step, za = z0 + i * step, zb = za + step;
    skirt(xa, z0, _grid[i], xb, z0, _grid[i + 1]);
    skirt(xa, z0 + TILE, _grid[cells * n + i], xb, z0 + TILE, _grid[cells * n + i + 1]);
    skirt(x0, za, _grid[i * n], x0, zb, _grid[(i + 1) * n]);
    skirt(x0 + TILE, za, _grid[i * n + cells], x0 + TILE, zb, _grid[(i + 1) * n + cells]);
  }
}

/** Shortest distance from (x, z) to the hoop path's control polyline. */
function distToPath(x, z) {
  let best = 1e9;
  for (let i = 0; i < N_PATH; i++) {
    const a = PATH[i], b = PATH[(i + 1) % N_PATH];
    const bx = b[0] - a[0], bz = b[2] - a[2];
    let f = ((x - a[0]) * bx + (z - a[2]) * bz) / (bx * bx + bz * bz);
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const d = Math.hypot(a[0] + bx * f - x, a[2] + bz * f - z);
    if (d < best) best = d;
  }
  return best;
}

// ------------------------------------------------------------- details
function addPillar(soup, p, rng) {
  const sides = 7, segs = 5;
  let prev = null;
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    const y = p.base - 2 + (p.h + 2) * t;
    const r = p.r * (1.15 - 0.55 * t) * (0.85 + 0.3 * Math.sin(t * 9 + p.x));
    const ring = [];
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2 + t * 0.5;
      const rr = r * (0.8 + 0.4 * rng());
      ring.push([p.x + Math.cos(a) * rr, y, p.z + Math.sin(a) * rr]);
    }
    if (prev) {
      for (let s = 0; s < sides; s++) {
        const col = _c.copy(PAL.rock).lerp(PAL.rockDark, rng() * 0.7).clone();
        soup.quad(prev[s], ring[s], ring[(s + 1) % sides], prev[(s + 1) % sides], col);
      }
    } else {
      // no bottom cap needed: the base is buried
    }
    prev = ring;
    if (k === segs) {
      const col = _c.copy(PAL.algae).lerp(PAL.rock, 0.5).clone();
      for (let s = 0; s < sides; s++) soup.tri(p.x, y + 0.6, p.z, ring[(s + 1) % sides][0], ring[(s + 1) % sides][1], ring[(s + 1) % sides][2], ring[s][0], ring[s][1], ring[s][2], col);
    }
  }
}

/** Wreck-like rock pile: tilted slabs and a broken "keel" leaning on each other. */
function addWreck(soup, rng) {
  const y0 = WRECK.base;
  const slabs = 11;
  for (let i = 0; i < slabs; i++) {
    const a = (i / slabs) * Math.PI * 2 + rng() * 0.5;
    const r = 4 + rng() * 12;
    const x = WRECK.x + Math.cos(a) * r, z = WRECK.z + Math.sin(a) * r;
    const h = 3 + rng() * 7;
    const col = _c.copy(PAL.wreck).lerp(PAL.rockDark, rng() * 0.6).clone();
    box(soup, x, y0 + h * 0.35, z, 2 + rng() * 4, h, 6 + rng() * 9, rng() * Math.PI, col, _c2.copy(col).lerp(PAL.algae, 0.35).clone());
  }
  // the keel: one long slab across the middle, hull-ribs off it
  box(soup, WRECK.x, y0 + 5, WRECK.z, 3.5, 4, 30, 0.5, PAL.wreck, _c.copy(PAL.wreck).lerp(PAL.algae, 0.3).clone());
  for (let i = -2; i <= 2; i++) {
    const t = i * 5.5;
    box(soup, WRECK.x + Math.sin(0.5) * t, y0 + 8, WRECK.z + Math.cos(0.5) * t, 14, 1.2, 1.2, 0.5, PAL.wreck);
  }
}

/** An arch across the canyon: a row of boxes on a semi-ellipse from rim to rim. */
function addArch(soup, s, rng) {
  const i = Math.min(CANYON_N - 2, Math.floor(s * (CANYON_N - 1)));
  const tx = CX[i + 1] - CX[i], tz = CZ[i + 1] - CZ[i], tl = Math.hypot(tx, tz) || 1;
  const px = -tz / tl, pz = tx / tl;             // across the canyon
  const cx = CX[i], cz = CZ[i], floor = CY[i], half = CW[i] + 14;
  const apex = floor + 32, n = 9;
  const heading = Math.atan2(tx, tz);
  for (let k = 0; k < n; k++) {
    const u = -1 + (2 * (k + 0.5)) / n;
    const x = cx + px * half * u, z = cz + pz * half * u;
    const y = floor + (apex - floor) * Math.sqrt(Math.max(1 - u * u * 0.92, 0.04)) - 2;
    const col = _c.copy(PAL.rock).lerp(PAL.rockDark, 0.4 + rng() * 0.5).clone();
    box(soup, x, y, z, 2 * half / n + 1.5, 5 + rng() * 2, 6 + rng() * 3, heading, col, _c2.copy(col).lerp(PAL.algae, 0.3).clone());
  }
}

/** Kelp: ribbons with uv.x = phase, uv.y = height fraction (see PropMaterial KELP_WAVE). */
function buildKelp(rng, count) {
  const pos = [], nrm = [], col = [], uv = [];
  const strand = (x, y0, z) => {
    const H = 5 + rng() * 6, segs = 6, w0 = 0.7 + rng() * 0.4, phase = rng();
    const a = rng() * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);   // ribbon facing
    const lean = (rng() - 0.5) * 0.25;
    for (let k = 0; k < segs; k++) {
      const t0 = k / segs, t1 = (k + 1) / segs;
      const w0k = w0 * (1 - t0 * 0.6), w1k = w0 * (1 - t1 * 0.6);
      const x0 = x + lean * H * t0 * t0, x1 = x + lean * H * t1 * t1;
      const yA = y0 + H * t0, yB = y0 + H * t1;
      const c0 = _c.copy(PAL.kelp).lerp(PAL.kelpTip, t0), c1 = _c2.copy(PAL.kelp).lerp(PAL.kelpTip, t1);
      const quad = [
        [x0 - dx * w0k, yA, z - dz * w0k, t0, c0], [x0 + dx * w0k, yA, z + dz * w0k, t0, c0],
        [x1 + dx * w1k, yB, z + dz * w1k, t1, c1], [x1 - dx * w1k, yB, z - dz * w1k, t1, c1],
      ];
      const tri = (a, b, c) => {
        for (const v of [a, b, c]) {
          pos.push(v[0], v[1], v[2]); nrm.push(-dz, 0, dx); col.push(v[4].r, v[4].g, v[4].b); uv.push(phase, v[3]);
        }
      };
      tri(quad[0], quad[1], quad[2]); tri(quad[0], quad[2], quad[3]);
    }
  };
  let placed = 0;
  for (let tries = 0; tries < count * 12 && placed < count; tries++) {
    let x, z;
    if (rng() < 0.62) {
      // lining the canyon floor edges and the shallows either side of the path
      const t = rng();
      pathPoint(t, _pa);
      const side = rng() < 0.5 ? -1 : 1;
      const h = pathHeading(t);
      const off = 10 + rng() * 26;
      x = _pa.x + Math.cos(h) * side * off; z = _pa.z - Math.sin(h) * side * off;
    } else {
      const a = rng() * Math.PI * 2, r = rng() * BASIN.r;
      x = BASIN.x + Math.cos(a) * r; z = BASIN.z + Math.sin(a) * r;
    }
    const y = seabedAt(x, z);
    if (y < -61 || y > -8) continue;
    const slope = Math.hypot(seabedAt(x + 1.5, z) - seabedAt(x - 1.5, z), seabedAt(x, z + 1.5) - seabedAt(x, z - 1.5)) / 3;
    if (slope > 0.7) continue;
    if (distToPath(x, z) < 9) continue;
    strand(x, y - 0.3, z);
    placed++;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere(); g.computeBoundingBox();
  return { geometry: g, strands: placed, triangles: pos.length / 9 };
}

// ------------------------------------------------------------ marine snow
const SNOW_VERT = /* glsl */ `
precision highp float;
in vec3 position;   // random in [0,1)^3; position.x also seeds size, .y bubble-or-snow
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 uViewProjNJ;
uniform mat4 uPrevViewProjNJ;
uniform vec3 uCamPos;
uniform vec3 uPrevCamPos;
uniform vec2 uResolution;
uniform float uTime;
uniform float uDt;
uniform float uSeaLevel;
uniform sampler2D uEnvMap;
uniform float uEnvMaxLod;
uniform vec4 uSubFog;
uniform vec3 uSubAbsorb;
out vec3 vColor;
out float vFade;
out vec3 vWorld;
out vec4 vClipNJ;
out vec4 vPrevClipNJ;
${SHADING_GLSL}
const float SIZE = 56.0;
vec3 place(float t, vec3 cam) {
  float bubble = step(0.7, position.y);
  // snow sinks and drifts with a slow current; bubbles rise and wobble
  vec3 drift = mix(vec3(0.35 * t, -0.18 * t, 0.12 * t), vec3(0.4 * sin(t * 1.3 + position.z * 40.0), 0.9 * t, 0.0), bubble);
  vec3 p = position * SIZE + drift;
  vec3 rel = mod(p - cam, SIZE) - SIZE * 0.5;
  return cam + rel;
}
void main(){
  vWorld = place(uTime, uCamPos);
  vec3 prev = place(uTime - uDt, uPrevCamPos);
  vec3 rel = vWorld - uCamPos;
  float dist = length(rel);
  float bubble = step(0.7, position.y);
  vFade = (1.0 - smoothstep(SIZE * 0.32, SIZE * 0.48, dist)) * smoothstep(1.0, 4.0, dist);
  // a little brighter than the fog around it, so it reads as a mote in the light
  vec3 skyAmb = subAmbient(uEnvMap, uEnvMaxLod);
  vColor = skyAmb * uSubFog.rgb * exp(-uSubAbsorb * max(uSeaLevel - vWorld.y, 0.0)) * mix(3.2, 5.0, bubble);
  float size = mix(1.6, 2.6, fract(position.x * 37.0)) * mix(1.0, 1.35, bubble);
  gl_PointSize = clamp(uResolution.y * 0.011 * size / max(dist, 0.5), 1.0, 7.0);
  vClipNJ = uViewProjNJ * vec4(vWorld, 1.0);
  vPrevClipNJ = uPrevViewProjNJ * vec4(prev, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;
const SNOW_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uCamPos;
in vec3 vColor;
in float vFade;
in vec3 vWorld;
in vec4 vClipNJ;
in vec4 vPrevClipNJ;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main(){
  float r = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, r) * vFade * 0.6;
  if (a < 0.01) discard;
  oColor = vec4(vColor, a);
  vec2 cur = vClipNJ.xy / max(vClipNJ.w, 1e-6);
  vec2 prv = vPrevClipNJ.xy / max(vPrevClipNJ.w, 1e-6);
  oVelocity = vec4((cur - prv) * 0.5, length(vWorld - uCamPos), 1.0);
}
`;

function buildSnow(count, rng) {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i++) pos[i] = rng();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  return g;
}

// -------------------------------------------------------------- building
/**
 * @param {string} id
 * @param {{ app, atmosphere, scene, game }} ctx
 * @returns {{ id, def, group, heightAt(x,z), terrainAt(x,z), triangles, tiles, kelp, snow, update(dt, camera), dispose() }}
 */
export function buildSubWorld(id, ctx = {}) {
  const def = SUB_WORLDS[id];
  if (!def) throw new Error(`unknown submarine world '${id}'`);
  const atmosphere = ctx.atmosphere || ctx.app?.atmosphere;
  const group = new THREE.Group();
  group.name = `subworld-${id}`;
  const material = new PropMaterial({ vertexColors: true, roughness: 0.92 }, atmosphere);
  const rng = mulberry32(7331);
  let triangles = 0;
  const tiles = [];

  const place = (mesh, name) => {
    mesh.name = name;
    mesh.renderOrder = SUB_RENDER_ORDER;
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    trackMotion(mesh);
    group.add(mesh);
    return mesh;
  };

  // ---- seabed tiles: fine along the course, coarse out on the plain
  const X0 = -500, X1 = 500, Z0 = -350, Z1 = 950;
  for (let z0 = Z0; z0 < Z1; z0 += TILE) {
    for (let x0 = X0; x0 < X1; x0 += TILE) {
      const cx = x0 + TILE / 2, cz = z0 + TILE / 2;
      const d = distToPath(cx, cz);
      const cells = d < 150 ? 16 : d < 320 ? 8 : 4;    // 6.25 m cells along the course, 12.5 m nearby, 25 m out on the plain
      const soup = new Soup();
      buildTile(soup, x0, z0, cells);
      const mesh = place(new THREE.Mesh(soup.geometry(), material), `seabed-${x0}-${z0}`);
      tiles.push({ mesh, cx, cz });
      triangles += soup.triangles;
    }
  }

  // ---- rock details: pillars, the wreck pile, two arches over the canyon
  const detail = new Soup();
  for (const p of PILLARS) addPillar(detail, p, rng);
  addWreck(detail, rng);
  addArch(detail, 0.40, rng);
  addArch(detail, 0.66, rng);
  const details = place(new THREE.Mesh(detail.geometry(), material), 'seabed-details');
  triangles += detail.triangles;

  // ---- kelp (own material: swaying, double-sided)
  const kelpMat = new PropMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide, kelpWave: 0.9 }, atmosphere);
  const kelpBuild = buildKelp(rng, 280);
  const kelp = place(new THREE.Mesh(kelpBuild.geometry, kelpMat), 'kelp');
  triangles += kelpBuild.triangles;

  // ---- marine snow / bubbles around the camera
  const snowMat = new THREE.RawShaderMaterial({
    name: 'MarineSnow', glslVersion: THREE.GLSL3,
    vertexShader: SNOW_VERT,
    fragmentShader: SNOW_FRAG,
    uniforms: {
      uViewProjNJ: U.uViewProjNJ, uPrevViewProjNJ: U.uPrevViewProjNJ, uCamPos: U.uCamPos, uPrevCamPos: U.uPrevCamPos,
      uResolution: U.uResolution, uTime: U.uTime, uDt: U.uDt, uSeaLevel: U.uSeaLevel,
      uEnvMap: U.uEnvMap, uEnvMaxLod: U.uEnvMaxLod, uSubFog: U.uSubFog, uSubAbsorb: U.uSubAbsorb,
    },
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
  });
  const snow = new THREE.Points(buildSnow(520, rng), snowMat);
  snow.name = 'marine-snow';
  snow.frustumCulled = false;
  snow.renderOrder = 5;
  snow.visible = false;         // only while submerged (see update)
  group.add(snow);

  const world = {
    id, def, group, tiles, kelp, snow, details, material, kelpMat,
    triangles, kelpStrands: kelpBuild.strands,
    heightAt: seabedAt,
    terrainAt: seabedAt,
    /** Per frame: distance-cull tiles the fog hides, show the snow only under water. */
    update(dt, camera) {
      const cp = camera?.position || U.uCamPos.value;
      const under = U.uSubmerged.value > 0.5;
      // Nothing is visible past ~4 visibility lengths (exp(-0.022 * (260 - 71)) ~ 1.5% at a tile's near corner).
      const cut = under ? 260 : 420;
      const cut2 = cut * cut;
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        const dx = t.cx - cp.x, dz = t.cz - cp.z;
        t.mesh.visible = dx * dx + dz * dz < cut2;
      }
      snow.visible = under;
    },
    dispose() {
      for (const t of tiles) { t.mesh.geometry.dispose(); t.mesh.removeFromParent(); }
      tiles.length = 0;
      details.geometry.dispose();
      kelp.geometry.dispose();
      snow.geometry.dispose();
      material.dispose(); kelpMat.dispose(); snowMat.dispose();
      group.removeFromParent();
    },
  };
  return world;
}

// ------------------------------------------------------------ submerged
const DEFAULT_ABSORB = [0.045, 0.015, 0.006];
let _submergedWas = null;

/**
 * Toggle the underwater look: uniforms only, switchable every frame.
 *  - sky background pixels become the water colour (SkyRenderer uSubmerged)
 *  - the post composite fogs by view distance toward it (PostFX)
 *  - PropMaterial attenuates daylight with each prop's depth
 *  - the sea surface, seen from below, already shades as a ceiling whenever the
 *    lens is under it (OceanMesh uUnderwater, GAME_LITE)
 * `fog` = { color: [r,g,b], density, absorb?: [r,g,b] } from the world def.
 */
export function setSubmerged(app, on, fog) {
  on = !!on;
  if (fog) {
    const c = fog.color || [0.13, 0.40, 0.42];
    U.uSubFog.value.set(c[0], c[1], c[2], fog.density ?? 0.038);
    const a = fog.absorb || DEFAULT_ABSORB;
    U.uSubAbsorb.value.set(a[0], a[1], a[2]);
  }
  U.uSubmerged.value = on ? 1 : 0;
  // The TAA history holds the other side of the surface; do not smear it in.
  if (on !== _submergedWas && app?.post) { app.post.reset = true; _submergedWas = on; }
}

// ------------------------------------------------------------- dev hook
/**
 * ?mods=SubmarineWorld[&subT=0.15][&subSpeed=12][&subPitch=0]
 * Builds The Deep Run, switches the frame to the underwater look and flies the
 * camera slowly along the hoop path from 30 m down at the canyon mouth, so the
 * smoke tool's screenshots tour the course. Hoops are drawn as glowing rings
 * (dev only; SubRace owns the real ones).
 */
export async function devInstall(game) {
  const app = game.app;
  const params = new URLSearchParams(location.search);
  game.world?.dispose?.();
  const tBuild = performance.now();
  const world = buildSubWorld('deep', { app, atmosphere: app.atmosphere, scene: game.scene, game });
  const buildMs = performance.now() - tBuild;
  game.scene.add(world.group);
  game.world = world;
  for (const b of game.boats) b.body.groundFn = world.heightAt;
  const W = game.mods?.Worlds;
  if (W?.applyWorldWeather) W.applyWorldWeather(app, world.def, true);
  else game.setWeather?.(world.def.weather.key, true);
  setSubmerged(app, true, world.def.fog);
  // Free tour instead of the normal title -> hub flow.
  game.start = () => { game.state = 'hub'; game.hud?.show?.('hub'); };

  // hoop markers
  const rings = [];
  const ringMat = new PropMaterial({ color: 0x202020, roughness: 0.5 }, app.atmosphere);
  ringMat.emissive.setRGB(0.5, 6.0, 1.5);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
  for (const g of world.def.gates) {
    const geo = new THREE.TorusGeometry(g.width / 2, 0.35, 6, 28);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), g.heading);
    m4.compose(new THREE.Vector3(g.x, g.y, g.z), q, new THREE.Vector3(1, 1, 1));
    geo.applyMatrix4(m4);
    const mesh = new THREE.Mesh(geo, ringMat);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    trackMotion(mesh);
    world.group.add(mesh);
    rings.push(mesh);
  }

  // clearance report: every hoop's bottom must clear the seabed
  const clearances = world.def.gates.map((g) => +(g.y - g.width / 2 - world.heightAt(g.x, g.z)).toFixed(1));
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) world.heightAt((i % 200) * 5 - 500, ((i / 200) | 0) * 13 - 350);
  const usPerCall = (performance.now() - t0) / 20000 * 1000;
  console.log(`[SubmarineWorld] deep: ${world.triangles} triangles (${world.kelpStrands} kelp), ${world.def.gates.length} hoops, ` +
    `built in ${buildMs.toFixed(0)} ms, heightAt ${usPerCall.toFixed(2)} us/call, hoop clearance m: ${clearances.join(' ')}`);

  // camera tour along the hoop path
  game.camera.enabled = false;
  let s = parseFloat(params.get('subT') || String(2.55 / N_PATH));
  const speed = parseFloat(params.get('subSpeed') || '12');
  const pitchUp = parseFloat(params.get('subPitch') || '0');   // extra look-up, metres at the look point
  const cam = app.camera;
  const pos = new THREE.Vector3(), look = new THREE.Vector3(), ahead = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const lookM = new THREE.Matrix4();
  const orig = game.update.bind(game);
  game.update = (dt, rawDt) => {
    orig(dt, rawDt);
    // advance by arc length: step the param by speed / |dP/dt|
    pathPoint(s, pos); pathPoint(s + 1e-3, ahead);
    const dpdt = ahead.distanceTo(pos) / 1e-3;
    s += (speed * dt) / Math.max(dpdt, 1);
    pathPoint(s, pos); pathPoint(s + 0.018, look);
    cam.position.set(pos.x, pos.y + 3.5, pos.z);
    look.y += 1.5 + pitchUp;
    lookM.lookAt(cam.position, look, up);
    cam.quaternion.setFromRotationMatrix(lookM);
    cam.fov = 58; cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    app.cine.focusDistance = 40;
    // dev A/B: devHold hides the world and drops the underwater look; devHoldLook drops the look only.
    world.group.visible = !world.devHold && !world.devWorldOff;
    setSubmerged(app, !world.devHold && !world.devHoldLook && cam.position.y < game.sea.heightAt(cam.position.x, cam.position.z), world.def.fog);
    world.update(dt, cam);
  };
  window.__subWorld = world;
  return world;
}
