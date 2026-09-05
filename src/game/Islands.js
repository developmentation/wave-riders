import * as THREE from 'three';
import { PropMaterial, trackMotion } from './PropMaterial.js';

/**
 * Procedural toy islands.
 *
 * Every island is a seeded heightfield: a cone or plateau silhouette (or a
 * crescent ridge bent along an arc), its coastline warped by low-frequency
 * noise, fbm bumps on the land, a gentle sand terrace at the waterline and a
 * shallow sandy shelf under it that drops to the deep floor a few radii out.
 *
 * The field is sampled once into a grid; the mesh is built from that grid and
 * `sample(x, z)` interpolates the same grid across the same triangle split, so
 * the hull collides with exactly the surface the player sees. Terrain and
 * details are flat-shaded, face-coloured, non-indexed geometry rendered with
 * one shared vertex-colour PropMaterial.
 *
 * Nothing in this file touches the DOM or WebGL until buildIslands() is
 * called, so tools/check-worlds.mjs can import the field maths in node.
 */
export const DEEP = -50;           // metres; far-field sea floor
const CULL_DEPTH = -3.0;           // triangles wholly below this are not drawn
const MAX_TRIS = 8000;             // per terrain mesh
export const MAX_PALMS = 40;
export const ISLAND_RENDER_ORDER = -1;   // sky is -1000, ocean 0

// ------------------------------------------------------------------ noise
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix, iz, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Value noise in [-1, 1] with a quintic fade. */
function vnoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  let fx = x - ix, fz = z - iz;
  fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  fz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz) * 2 - 1;
}

/** Rotated fbm in roughly [-1, 1]. */
export function fbm(x, z, seed, octaves = 4) {
  let sum = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += vnoise(x, z, seed + i * 131) * amp;
    norm += amp;
    const nx = x * 1.92 + z * 0.62 + 13.7, nz = -x * 0.62 + z * 1.92 + 7.1;
    x = nx; z = nz; amp *= 0.5;
  }
  return sum / norm;
}

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
const smoothstep = (a, b, t) => { t = clamp01((t - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ------------------------------------------------------------- the field
/**
 * Analytic island profile in metres above mean sea level.
 * def: { x, z, radius, height, seed, shape: 'cone'|'plateau'|'crescent', warp, detail,
 *        arc: { r, a0, a1, thick } (crescent only; angles in radians measured atan2(z, x)),
 *        shelf (default 1; < 1 = a steeper, shorter sandy shelf and an earlier drop-off,
 *        so big seas do not ground boats or expose the seabed far from the beach) }
 */
export function islandProfile(def, x, z) {
  const px = x - def.x, pz = z - def.z;
  let d, hmul = 1, scale = def.radius;
  if (def.shape === 'crescent') {
    const arc = def.arc;
    const mid = (arc.a0 + arc.a1) * 0.5;
    const ang = mid + wrapPi(Math.atan2(pz, px) - mid);
    const rad = Math.hypot(px, pz);
    const ta = (ang - arc.a0) / (arc.a1 - arc.a0);
    let dist;
    if (ta >= 0 && ta <= 1) dist = Math.abs(rad - arc.r);
    else {
      const ae = ta < 0 ? arc.a0 : arc.a1;
      dist = Math.hypot(px - arc.r * Math.cos(ae), pz - arc.r * Math.sin(ae));
    }
    d = dist / arc.thick;
    scale = arc.thick;
    // the ridge tapers toward both horns
    hmul = 0.35 + 0.65 * Math.sqrt(Math.sin(Math.PI * clamp01(ta)));
  } else {
    d = Math.hypot(px, pz) / def.radius;
  }
  // coastline warp: a few noise cells across the island
  const wf = 1.6 / scale;
  d *= 1 + (def.warp ?? 0.26) * fbm(px * wf + def.seed * 0.37, pz * wf, def.seed, 3);
  const core = 1 - d;
  let h;
  if (core > 0) {
    let s;
    if (def.shape === 'plateau') s = smoothstep(0, 0.72, core) * (0.85 + 0.15 * core);
    else s = Math.pow(core, 1.35) * 0.78 + 0.22 * smoothstep(0.45, 0.95, core);
    h = def.height * s * hmul;
    const df = 4.5 / scale;
    h += def.height * (def.detail ?? 0.16) * fbm(px * df, pz * df, def.seed + 7, 4) * Math.min(1, core * 3) * hmul;
  } else {
    // sandy shelf: 16% grade to -6 m, then the drop-off (both scaled by def.shelf)
    const shelf = def.shelf ?? 1;
    h = Math.max(core * scale * 0.16 / shelf, -6);
    const t = smoothstep(1 + 0.7 * shelf, 1 + 1.6 * shelf, d);
    h = h * (1 - t) + DEEP * t;
  }
  // beach terrace: flatten the slope through the waterline
  const bw = 1.5;
  h -= 0.7 * bw * Math.tanh(h / bw);
  return h;
}

function squareParam(def) {
  const half = def.radius * 1.4;
  const x0 = def.x - half, z0 = def.z - half, size = half * 2;
  return {
    kind: 'square', half, size, cx: def.x, cz: def.z, boundR: half * Math.SQRT2, aspect: 1,
    toWorld(u, v, out) { out[0] = x0 + u * size; out[1] = z0 + v * size; return out; },
    toParam(x, z, out) { out[0] = (x - x0) / size; out[1] = (z - z0) / size; return out; },
  };
}

function arcParam(def) {
  const arc = def.arc;
  const cap = 1.6 * arc.thick / arc.r;
  const u0 = arc.a0 - cap, u1 = arc.a1 + cap, du = u1 - u0;
  const vHalf = 1.5 * arc.thick;
  const mid = (u0 + u1) * 0.5;
  return {
    kind: 'arc', cx: def.x, cz: def.z, boundR: arc.r + vHalf,
    aspect: (arc.r * du) / (2 * vHalf),
    toWorld(u, v, out) {
      const a = u0 + u * du, rad = arc.r + (v - 0.5) * 2 * vHalf;
      out[0] = def.x + rad * Math.cos(a); out[1] = def.z + rad * Math.sin(a); return out;
    },
    toParam(x, z, out) {
      const px = x - def.x, pz = z - def.z;
      const a = mid + wrapPi(Math.atan2(pz, px) - mid);
      out[0] = (a - u0) / du; out[1] = (Math.hypot(px, pz) - arc.r) / (2 * vHalf) + 0.5; return out;
    },
  };
}

/**
 * Sample the island into a grid whose visible triangle count fits the budget.
 * Returns { def, param, grid, nu, nv, tris, sample(x,z), inBounds(x,z), analytic(x,z) }.
 */
export function createIslandField(defIn) {
  const def = { shape: 'cone', warp: 0.26, detail: 0.16, palms: 0, ...defIn };
  const param = def.shape === 'crescent' ? arcParam(def) : squareParam(def);
  const analytic = (x, z) => islandProfile(def, x, z);
  const tmp = [0, 0];

  let target = Math.sqrt(MAX_TRIS / 2 * 1.35);   // verts per side if nothing were culled
  let nu, nv, grid, tris;
  for (let iter = 0; iter < 4; iter++) {
    nu = Math.max(12, Math.round(target * Math.sqrt(param.aspect))) + 1;
    nv = Math.max(12, Math.round(target / Math.sqrt(param.aspect))) + 1;
    grid = new Float32Array(nu * nv);
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      param.toWorld(i / (nu - 1), j / (nv - 1), tmp);
      grid[j * nu + i] = analytic(tmp[0], tmp[1]);
    }
    tris = 0;
    for (let j = 0; j < nv - 1; j++) for (let i = 0; i < nu - 1; i++) {
      const a = grid[j * nu + i], b = grid[j * nu + i + 1], c = grid[(j + 1) * nu + i], d = grid[(j + 1) * nu + i + 1];
      if (!(a < CULL_DEPTH && c < CULL_DEPTH && d < CULL_DEPTH)) tris++;
      if (!(a < CULL_DEPTH && d < CULL_DEPTH && b < CULL_DEPTH)) tris++;
    }
    if (tris <= MAX_TRIS) break;
    target *= Math.sqrt(MAX_TRIS / tris) * 0.985;
  }

  const field = {
    def, param, grid, nu, nv, tris, analytic,
    inBounds(x, z) {
      param.toParam(x, z, tmp);
      return tmp[0] >= 0 && tmp[0] <= 1 && tmp[1] >= 0 && tmp[1] <= 1;
    },
    /** Height at (x, z): grid interpolation across the mesh's own triangles. */
    sample(x, z) {
      const dx = x - param.cx, dz = z - param.cz;
      if (dx * dx + dz * dz > (param.boundR + 60) * (param.boundR + 60)) return DEEP;
      param.toParam(x, z, tmp);
      const u = tmp[0], v = tmp[1];
      if (u < 0 || u > 1 || v < 0 || v > 1) return analytic(x, z);
      const fu0 = u * (nu - 1), fv0 = v * (nv - 1);
      const i = Math.min(nu - 2, Math.floor(fu0)), j = Math.min(nv - 2, Math.floor(fv0));
      const fu = fu0 - i, fv = fv0 - j;
      const a = grid[j * nu + i], b = grid[j * nu + i + 1], c = grid[(j + 1) * nu + i], d = grid[(j + 1) * nu + i + 1];
      // split along the a-d diagonal, same as the mesh
      return fv > fu ? a + (c - a) * fv + (d - c) * fu : a + (b - a) * fu + (d - b) * fv;
    },
    slope(x, z, e = 1.5) {
      const hx = field.sample(x + e, z) - field.sample(x - e, z);
      const hz = field.sample(x, z + e) - field.sample(x, z - e);
      return Math.hypot(hx, hz) / (2 * e);
    },
  };
  return field;
}

/**
 * Collision shaping for BoatPhysics.groundFn. The hull collider pushes along
 * the terrain normal, so a real 1:15 beach reads as a ramp and a boat under
 * power simply drives up it. Raising everything above the waterline by a few
 * metres over the last quarter metre of shallows turns the shoreline into a
 * soft wall: the shallows still scrape and slow the hull exactly where the
 * player sees sand under the water, then the beach bumps it back to sea.
 */
export const SHORE_WALL = 8;
export function collisionHeight(h) {
  return h + SHORE_WALL * smoothstep(-0.25, 0.0, h);
}

/** Max over a list of fields; DEEP far from everything. */
export function fieldsHeight(fields, x, z) {
  let h = DEEP;
  for (let i = 0; i < fields.length; i++) {
    const v = fields[i].sample(x, z);
    if (v > h) h = v;
  }
  return h;
}

// ------------------------------------------------------- geometry builder
/** Flat-shaded, face-coloured, non-indexed triangle soup (world-space). */
export class Soup {
  constructor() { this.pos = []; this.nrm = []; this.col = []; }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, c) {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b);
  }
  quad(a, b, c, d, col) { // a,b,c,d as [x,y,z] going round the face
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col);
    this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], col);
  }
  get triangles() { return this.pos.length / 9; }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Palette (sRGB hex, stored linear). Saturated and warm: toy islands, not survey data.
const C = (hex) => new THREE.Color(hex);
const PAL = {
  sandWet: C(0xd9c184), sand: C(0xf7e3a4), grassA: C(0x5fc23a), grassB: C(0x8ddb46),
  grassHigh: C(0x2f9440), rock: C(0xb09a80), rockDark: C(0x8a7562), crown: C(0x3d6f3a),
  trunk: C(0x9a6b3c), trunkDark: C(0x7a5230), frond: C(0x2f9e3d), frondTip: C(0x7fd24a), coconut: C(0x6b4a2b),
  white: C(0xf8f8f4), red: C(0xe8402f), glass: C(0xbfe9ff), roof: C(0xd9382a), grey: C(0x6a7079),
  wall: C(0xf4d58a), wood: C(0x9c6a3e), woodDark: C(0x7e5330), rope: C(0xe8dcb8),
};
const _c = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color();

function terrainColor(h, slope, n, def) {
  const H = def.height;
  const c = _c;
  // sand, wetter as it goes under
  c.copy(PAL.sandWet).lerp(PAL.sand, smoothstep(-1.6, 0.2, h));
  // grass: two greens picked by noise
  const g = smoothstep(1.35, 2.3, h);
  const grass = _c2.copy(PAL.grassA).lerp(PAL.grassB, clamp01(0.5 + n * 0.9));
  c.lerp(grass, g);
  // highland: darker
  c.lerp(PAL.grassHigh, smoothstep(0.45 * H, 0.85 * H, h) * 0.75);
  c.lerp(PAL.crown, smoothstep(0.85 * H, H * 1.05, h) * 0.6);
  // rock only on genuinely steep faces (slope is rise/run; 1.0 = 45 deg)
  const rk = smoothstep(1.15, 1.8, slope) * smoothstep(1.5, 3, h);
  c.lerp(_c3.copy(PAL.rock).lerp(PAL.rockDark, clamp01(0.5 + n * 0.6)), rk);
  return c;
}

function buildTerrain(field, soup) {
  const { grid, nu, nv, param, def } = field;
  const P = [[0, 0], [0, 0], [0, 0], [0, 0]];
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0];
  const emit = (p, q, r) => {
    if (p[1] < CULL_DEPTH && q[1] < CULL_DEPTH && r[1] < CULL_DEPTH) return;
    // face normal for slope + face colour at the centroid
    const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    const slope = Math.hypot(nx, nz) / Math.max(Math.abs(ny), 1e-3);
    const mx = (p[0] + q[0] + r[0]) / 3, mh = (p[1] + q[1] + r[1]) / 3, mz = (p[2] + q[2] + r[2]) / 3;
    const n = fbm(mx * 0.08, mz * 0.08, def.seed + 99, 2);
    const col = terrainColor(mh, slope, n, def);
    if (ny / l >= 0) soup.tri(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], col);
    else soup.tri(p[0], p[1], p[2], r[0], r[1], r[2], q[0], q[1], q[2], col);
  };
  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      param.toWorld(i / (nu - 1), j / (nv - 1), P[0]);
      param.toWorld((i + 1) / (nu - 1), j / (nv - 1), P[1]);
      param.toWorld(i / (nu - 1), (j + 1) / (nv - 1), P[2]);
      param.toWorld((i + 1) / (nu - 1), (j + 1) / (nv - 1), P[3]);
      a[0] = P[0][0]; a[1] = grid[j * nu + i]; a[2] = P[0][1];
      b[0] = P[1][0]; b[1] = grid[j * nu + i + 1]; b[2] = P[1][1];
      c[0] = P[2][0]; c[1] = grid[(j + 1) * nu + i]; c[2] = P[2][1];
      d[0] = P[3][0]; d[1] = grid[(j + 1) * nu + i + 1]; d[2] = P[3][1];
      emit(a, c, d);
      emit(a, d, b);
    }
  }
}

// ------------------------------------------------------------- details
function ring(cx, cy, cz, r, sides, phase = 0) {
  const pts = [];
  for (let k = 0; k < sides; k++) {
    const a = phase + (k / sides) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cy, cz + Math.sin(a) * r]);
  }
  return pts;
}
function tube(soup, r0, r1, col) {
  const n = r0.length;
  for (let k = 0; k < n; k++) soup.quad(r0[k], r1[k], r1[(k + 1) % n], r0[(k + 1) % n], col);
}
function cap(soup, rg, cx, cy, cz, col, down = false) {
  const n = rg.length;
  for (let k = 0; k < n; k++) {
    const p = rg[k], q = rg[(k + 1) % n];
    if (down) soup.tri(cx, cy, cz, p[0], p[1], p[2], q[0], q[1], q[2], col);
    else soup.tri(cx, cy, cz, q[0], q[1], q[2], p[0], p[1], p[2], col);
  }
}
function cone(soup, rg, cx, cy, cz, col) { cap(soup, rg, cx, cy, cz, col, false); }
export function cylinder(soup, cx, y0, y1, r0, r1, sides, col, caps = true) {
  const a = ring(cx[0], y0, cx[1], r0, sides), b = ring(cx[0], y1, cx[1], r1, sides);
  tube(soup, a, b, col);
  if (caps) { cap(soup, b, cx[0], y1, cx[1], col); cap(soup, a, cx[0], y0, cx[1], col, true); }
}
export function box(soup, cx, cy, cz, sx, sy, sz, rotY, col, colTop = col) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  const P = (x, y, z) => [cx + x * c + z * s, cy + y, cz - x * s + z * c];
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const p000 = P(-hx, -hy, -hz), p100 = P(hx, -hy, -hz), p010 = P(-hx, hy, -hz), p110 = P(hx, hy, -hz);
  const p001 = P(-hx, -hy, hz), p101 = P(hx, -hy, hz), p011 = P(-hx, hy, hz), p111 = P(hx, hy, hz);
  soup.quad(p010, p011, p111, p110, colTop);   // top
  soup.quad(p000, p100, p101, p001, col);      // bottom
  soup.quad(p000, p010, p110, p100, col);      // -z
  soup.quad(p101, p111, p011, p001, col);      // +z
  soup.quad(p001, p011, p010, p000, col);      // -x
  soup.quad(p100, p110, p111, p101, col);      // +x
}

export function addPalm(soup, x, y, z, rng) {
  const s = 0.8 + rng() * 0.55;
  const H = 5.2 * s;
  const la = rng() * Math.PI * 2, lean = (0.6 + rng() * 1.8) * s;
  const lx = Math.cos(la) * lean, lz = Math.sin(la) * lean;
  const segs = 4, sides = 5;
  let prev = null;
  const trunkCol = _c.copy(PAL.trunk).lerp(PAL.trunkDark, rng() * 0.5).clone();
  for (let k = 0; k <= segs; k++) {
    const t = k / segs;
    const r = (0.30 - 0.14 * t) * s;
    const rg = ring(x + lx * t * t, y - 0.3 + H * t, z + lz * t * t, r, sides, t * 0.4);
    if (prev) tube(soup, prev, rg, trunkCol);
    prev = rg;
  }
  const tx = x + lx, ty = y - 0.3 + H, tz = z + lz;
  // fronds
  const n = 6 + (rng() < 0.5 ? 1 : 0);
  const rot = rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2 + (rng() - 0.5) * 0.35;
    const dx = Math.cos(a), dz = Math.sin(a);
    const L = (2.6 + rng() * 1.0) * s;
    const px = -dz, pz = dx;
    const steps = 3;
    let prevL = null, prevR = null;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const lift = (0.85 * t - 1.55 * t * t) * s;
      const w = (k === 0 ? 0.12 : 0.55 * (1 - t * 0.8)) * s;
      const cx0 = tx + dx * L * t, cy0 = ty + lift, cz0 = tz + dz * L * t;
      const Lp = [cx0 + px * w, cy0, cz0 + pz * w], Rp = [cx0 - px * w, cy0, cz0 - pz * w];
      if (prevL) {
        const col = _c.copy(PAL.frond).lerp(PAL.frondTip, t * 0.85).clone();
        soup.quad(prevL, Lp, Rp, prevR, col);      // top
        soup.quad(prevR, Rp, Lp, prevL, col);      // underside
      }
      prevL = Lp; prevR = Rp;
    }
  }
  // a couple of coconuts
  for (let i = 0; i < 2; i++) {
    const a = rng() * Math.PI * 2;
    cylinder(soup, [tx + Math.cos(a) * 0.28 * s, tz + Math.sin(a) * 0.28 * s], ty - 0.55 * s, ty - 0.2 * s, 0.13 * s, 0.13 * s, 4, PAL.coconut);
  }
}

export function addLighthouse(soup, x, y, z) {
  const bands = [PAL.white, PAL.red, PAL.white, PAL.red, PAL.white];
  const h = 3.0;
  for (let i = 0; i < bands.length; i++) {
    const r0 = 2.7 - i * 0.22, r1 = 2.7 - (i + 1) * 0.22;
    cylinder(soup, [x, z], y + i * h, y + (i + 1) * h, r0, r1, 10, bands[i], false);
  }
  const top = y + bands.length * h;
  cylinder(soup, [x, z], y - 1.5, y + 0.4, 3.4, 3.4, 10, PAL.grey);       // plinth
  cylinder(soup, [x, z], top, top + 0.5, 2.4, 2.4, 10, PAL.grey);         // gallery
  cylinder(soup, [x, z], top + 0.5, top + 3.0, 1.5, 1.5, 8, PAL.glass, false);   // lantern
  const rg = ring(x, top + 3.0, z, 2.1, 8);
  cylinder(soup, [x, z], top + 2.8, top + 3.0, 2.1, 2.1, 8, PAL.roof);
  cone(soup, rg, x, top + 5.6, z, PAL.roof);
  cylinder(soup, [x, z], top + 5.5, top + 6.3, 0.2, 0.2, 4, PAL.grey);
}

export function addHut(soup, x, y, z, rot) {
  box(soup, x, y + 1.3, z, 4.2, 2.6, 4.2, rot, PAL.wall);
  box(soup, x, y + 0.2, z, 5.6, 0.4, 5.6, rot, PAL.woodDark, PAL.wood);
  const rg = ring(x, y + 2.55, z, 3.6, 4, rot + Math.PI / 4);
  cone(soup, rg, x, y + 4.9, z, PAL.roof);
  // door
  const c = Math.cos(rot), s = Math.sin(rot);
  box(soup, x + s * 2.12, y + 1.0, z + c * 2.12, 1.0, 1.9, 0.12, rot, PAL.woodDark);
}

/** Pier: deck planks on posts, running `length` metres from (x, z) along `heading`. */
export function addPier(soup, p) {
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  const w = p.width ?? 4, deckY = p.deckY ?? 1.2;
  const cx = p.x + fx * p.length / 2, cz = p.z + fz * p.length / 2;
  box(soup, cx, deckY - 0.15, cz, w, 0.3, p.length, p.heading, PAL.woodDark, PAL.wood);
  // rails
  box(soup, cx - fz * (w / 2 - 0.1), deckY + 0.55, cz + fx * (w / 2 - 0.1), 0.12, 0.08, p.length, p.heading, PAL.rope);
  box(soup, cx + fz * (w / 2 - 0.1), deckY + 0.55, cz - fx * (w / 2 - 0.1), 0.12, 0.08, p.length, p.heading, PAL.rope);
  for (let s = 0; s <= p.length; s += 6) {
    const px = p.x + fx * s, pz = p.z + fz * s;
    for (const side of [-1, 1]) {
      const ox = -fz * side * (w / 2 - 0.1), oz = fx * side * (w / 2 - 0.1);
      box(soup, px + ox, deckY - 1.2, pz + oz, 0.36, 4.4, 0.36, p.heading, PAL.woodDark);
      box(soup, px + ox, deckY + 0.55, pz + oz, 0.16, 1.1, 0.16, p.heading, PAL.woodDark);
    }
  }
  // a couple of bollards at the sea end
  const ex = p.x + fx * (p.length - 1.2), ez = p.z + fz * (p.length - 1.2);
  cylinder(soup, [ex - fz * 1.2, ez + fx * 1.2], deckY, deckY + 0.7, 0.22, 0.2, 6, PAL.red);
  cylinder(soup, [ex + fz * 1.2, ez - fx * 1.2], deckY, deckY + 0.7, 0.22, 0.2, 6, PAL.red);
}

/** Terrain height contribution of a pier so hulls bump into it instead of passing through. */
export function pierHeight(p, x, z) {
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
  const dx = x - p.x, dz = z - p.z;
  const along = dx * fx + dz * fz, across = -dx * fz + dz * fx;
  const hw = (p.width ?? 4) / 2 + 0.4;
  const edge = Math.min(along, p.length - along, hw - Math.abs(across));
  if (edge < -3) return DEEP;
  return mix(-3, 1.0, clamp01((edge + 3) / 3.5));
}

/** Scatter palms on grass above 2 m. */
function scatterPalms(field, soup, rng) {
  const count = Math.min(MAX_PALMS, field.def.palms | 0);
  if (count <= 0) return 0;
  const placed = [];
  const tmp = [0, 0];
  const H = field.def.height;
  for (let tries = 0; tries < 600 && placed.length < count; tries++) {
    field.param.toWorld(rng(), rng(), tmp);
    const x = tmp[0], z = tmp[1];
    const h = field.sample(x, z);
    if (h < 2.2 || h > Math.max(4, H * (field.def.shape === 'plateau' ? 0.98 : 0.72))) continue;
    if (field.slope(x, z) > 0.42) continue;
    let ok = true;
    for (const q of placed) if ((q[0] - x) ** 2 + (q[1] - z) ** 2 < 4.5 * 4.5) { ok = false; break; }
    if (!ok) continue;
    placed.push([x, z]);
    addPalm(soup, x, h, z, rng);
  }
  return placed.length;
}

// -------------------------------------------------------------- building
export const ISLAND_MATERIAL_OPTS = { vertexColors: true, roughness: 0.9 };

/**
 * Build every island of a world.
 * @param {Array} defs island defs (see islandProfile) — extras: palms, lighthouse: {x,z}|true, hut: {x,z}|true
 * @param {Atmosphere} atmosphere
 * @param {object} [opts] { piers: [{ x, z, heading, length, width }], material }
 * @returns {{ group, fields, meshes, material, terrainAt, heightAt, triangles, palms, dispose }}
 *   terrainAt = true surface height (what the mesh shows); heightAt = collision-shaped (see collisionHeight)
 */
export function buildIslands(defs, atmosphere, opts = {}) {
  const group = new THREE.Group();
  group.name = 'islands';
  const material = opts.material || new PropMaterial(ISLAND_MATERIAL_OPTS, atmosphere);
  const fields = [], meshes = [];
  const piers = opts.piers || [];
  let triangles = 0, palms = 0;
  const detail = new Soup();

  for (const def of defs) {
    const field = createIslandField(def);
    fields.push(field);
    const soup = new Soup();
    buildTerrain(field, soup);
    const mesh = new THREE.Mesh(soup.geometry(), material);
    mesh.name = `island-${def.seed}`;
    mesh.frustumCulled = true;
    // Drawn after the sky but before the sea, so the (far heavier) ocean
    // shader fails the depth test behind every island instead of shading it.
    mesh.renderOrder = ISLAND_RENDER_ORDER;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    trackMotion(mesh);
    group.add(mesh);
    meshes.push(mesh);
    triangles += soup.triangles;
    field.triangles = soup.triangles;

    // per-island details go in one shared soup per island so a big island
    // with 40 palms still costs one draw call
    const rng = mulberry32(def.seed * 7919 + 17);
    const dsoup = new Soup();
    palms += scatterPalms(field, dsoup, rng);
    const pick = (spec, minH) => {
      if (!spec) return null;
      if (spec === true) {
        // highest grid point that is not too steep
        let best = null;
        const tmp = [0, 0];
        for (let tries = 0; tries < 400; tries++) {
          field.param.toWorld(0.2 + rng() * 0.6, 0.2 + rng() * 0.6, tmp);
          const h = field.sample(tmp[0], tmp[1]);
          if (h < minH || field.slope(tmp[0], tmp[1], 4) > 0.3) continue;
          if (!best || h > best.h) best = { x: tmp[0], z: tmp[1], h };
        }
        return best;
      }
      return { x: spec.x, z: spec.z, h: field.sample(spec.x, spec.z) };
    };
    const lh = pick(def.lighthouse, 4);
    if (lh) addLighthouse(dsoup, lh.x, lh.h - 0.4, lh.z);
    const hut = pick(def.hut, 2.2);
    if (hut) addHut(dsoup, hut.x, hut.h - 0.2, hut.z, rng() * Math.PI * 2);
    if (dsoup.triangles) {
      const dm = new THREE.Mesh(dsoup.geometry(), material);
      dm.name = `island-${def.seed}-details`;
      dm.renderOrder = ISLAND_RENDER_ORDER;
      dm.matrixAutoUpdate = false; dm.updateMatrix();
      trackMotion(dm);
      group.add(dm);
      meshes.push(dm);
      triangles += dsoup.triangles;
      field.detailTriangles = dsoup.triangles;
    }
  }

  for (const p of piers) addPier(detail, p);
  if (detail.triangles) {
    const pm = new THREE.Mesh(detail.geometry(), material);
    pm.name = 'piers';
    pm.renderOrder = ISLAND_RENDER_ORDER;
    pm.matrixAutoUpdate = false; pm.updateMatrix();
    trackMotion(pm);
    group.add(pm);
    meshes.push(pm);
    triangles += detail.triangles;
  }

  const heightAt = (x, z) => {
    let h = fieldsHeight(fields, x, z);
    for (let i = 0; i < piers.length; i++) {
      const v = pierHeight(piers[i], x, z);
      if (v > h) h = v;
    }
    return h;
  };

  return {
    group, fields, meshes, material, triangles, palms,
    terrainAt: heightAt,
    heightAt: (x, z) => collisionHeight(heightAt(x, z)),
    dispose() {
      for (const m of meshes) { m.geometry.dispose(); m.removeFromParent(); }
      if (!opts.material) material.dispose();
      meshes.length = 0;
    },
  };
}
