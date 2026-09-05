import * as THREE from 'three';
import { ATMO_COMMON } from '../sky/AtmosphereGLSL.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';
import { FOAM_LIGHT_GLSL, FOAM_HAZE_GLSL, makeFoamMaterial } from './Wake.js';

/**
 * Shore foam: the white swash line where the sea meets every beach.
 *
 * At build time each island's waterline is traced by marching rays through
 * `world.terrainAt` (radially for round islands, across the ridge for a
 * crescent) to the radius where the sand crosses WATERLINE. A band of ROWS
 * vertex rows straddles that line, from a couple of metres up the beach to
 * SEAWARD metres out. Every world's bands share one geometry and one
 * material: one draw call.
 *
 * Each frame a round-robin subset of islands re-lays its vertices on
 * max(sand, sampled sea), so the band rides the swell where the wave probe
 * covers it and rests on the mean surface beyond. The shader animates a
 * surging swash line plus foam pulses travelling shoreward, carves both with
 * the engine's foam texture, and fades everything out past ~600 m.
 *
 * Writes both MRT outputs (colour, velocity) like every material in the
 * ocean pipeline.
 */
const RAYS = 96;                    // waterline samples per island (per side for a crescent)
const ROWS = 4;                     // vertex rows across the band
const ROW_T = [0, 0.22, 0.58, 1];   // across-coordinate of each row (0 beach .. 1 sea)
const BEACH = 2.0;                  // metres the band reaches up the sand
const SEAWARD = 8.0;                // metres out to sea at Hs 0; grows with the swell
const WATERLINE = -0.1;             // terrain height that defines the shoreline
const LIFT = 0.14;                  // band sits this far above the sampled sea (+ a share of Hs, see _layIsland)
const SAND_LIFT = 0.15;             // and this far above exposed sand (the terrain mesh is a grid; it can sit above the analytic profile)
const FADE_NEAR = 520, FADE_FAR = 720;

const VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
${ATMO_COMMON}
${SHADING_GLSL}
${FOAM_LIGHT_GLSL}
in vec3 position;
in vec4 aData;        // t across (0 beach .. 1 sea), island seed, outward normal xz
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 uViewProjNJ;
uniform mat4 uPrevViewProjNJ;
uniform vec3 uCamPos;
out vec3 vWorld;
out vec4 vData;
out vec3 vWhite;
out vec3 vSkyAmb;
out vec4 vClipNJ;
out vec4 vPrevClipNJ;
out float vFade;
out float vFar;
void main(){
  vWorld = position;
  vData = aData;
  vWhite = foamRadiance(vSkyAmb);
  float dist = length(position - uCamPos);
  vFade = 1.0 - smoothstep(${FADE_NEAR.toFixed(1)}, ${FADE_FAR.toFixed(1)}, dist);
  // a 10 m band is a pixel wide at 300 m: broaden the swash with distance so
  // the surf line stays legible on a far beach instead of dithering away
  vFar = smoothstep(60.0, 350.0, dist);
  vec4 wp = vec4(position, 1.0);
  vClipNJ = uViewProjNJ * wp;
  vPrevClipNJ = uPrevViewProjNJ * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
${FOAM_HAZE_GLSL}
uniform sampler2D uFoamTex;
uniform float uTime;
uniform float uSurf;          // 1 = calm lagoon .. ~1.8 = storm surf
in vec3 vWorld;
in vec4 vData;
in vec3 vWhite;
in vec3 vSkyAmb;
in vec4 vClipNJ;
in vec4 vPrevClipNJ;
in float vFade;
in float vFar;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main(){
  if (vFade < 0.01) discard;
  float t = vData.x;
  float seed = vData.y;
  vec2 n = vData.zw;
  // along-shore phase from world position: no seam where a loop closes
  float along = vWorld.x * 0.71 + vWorld.z * 0.43 + seed * 13.7;

  // Swash: the standing foam line at the waterline, surging up and down the
  // beach with two incommensurate periods so it never loops visibly.
  float surge = sin(uTime * 0.75 + along * 0.045) * 0.6 + sin(uTime * 0.31 - along * 0.021) * 0.4;
  float line = 0.24 + surge * 0.09 * uSurf;
  float swash = exp(-pow((t - line) / (0.22 * uSurf * (1.0 + vFar)), 2.0)) * (1.1 + 0.2 * surge + 0.5 * vFar);

  // Breakers: a foam pulse born at the seaward edge every ~6.5 s that runs up
  // the shelf, whitens as it breaks and dies on the sand.
  float ph = fract(uTime / 6.5 + along * 0.0035 + sin(along * 0.11) * 0.06 + seed * 0.37);
  float tw = mix(1.0, 0.24, ph);
  float pulse = exp(-pow((t - tw) / 0.15, 2.0)) * smoothstep(0.0, 0.35, ph) * (1.0 - smoothstep(0.72, 1.0, ph)) * (0.8 + 0.6 * uSurf);
  // second, offset train so the surf line is never empty between pulses
  float ph2 = fract(ph + 0.5 + sin(along * 0.05) * 0.1);
  float tw2 = mix(1.0, 0.24, ph2);
  pulse += exp(-pow((t - tw2) / 0.12, 2.0)) * smoothstep(0.0, 0.35, ph2) * (1.0 - smoothstep(0.72, 1.0, ph2)) * 0.6 * uSurf;

  // thinning streaks of spent foam drifting seaward
  float fringe = (1.0 - smoothstep(0.30, 1.0, t)) * 0.30;
  float density = (swash + pulse + fringe) * smoothstep(0.0, 0.10, t) * (1.0 - smoothstep(0.78, 1.0, t));
  if (density < 0.06) discard;

  // Foam texture in world space, drifting shoreward (against the normal).
  vec4 fx = texture(uFoamTex, vWorld.xz * 0.11 - n * uTime * 0.055 + vec2(uTime * 0.004, 0.0));
  vec4 fx2 = texture(uFoamTex, vWorld.xz * 0.42 - n * uTime * 0.11);
  float clusters = fx.r * 0.55 + fx2.r * 0.45;
  float bubbles = fx2.g * 0.6 + fx.g * 0.4;
  float dissolve = fx.a * 0.5 + fx2.a * 0.5;

  float noise = smoothstep(0.18, 0.80, dissolve * 0.5 + clusters * 0.5);
  float carved = density * (0.30 + noise * 1.15 + 0.5 * vFar);
  float onset = 0.20 + t * 0.30;
  float foam = smoothstep(onset, onset + 0.30, carved);
  foam *= mix(0.45, 1.0, bubbles);
  if (foam < 0.004) discard;

  float dist = length(vWorld - uCamPos);
  vec3 col = vWhite * (1.0 + 0.25 * bubbles + 0.2 * pulse);
  col = applyHaze(col, vSkyAmb, dist);

  oColor = vec4(col, clamp(foam, 0.0, 1.0) * 0.92 * vFade);
  vec2 cur = vClipNJ.xy / max(vClipNJ.w, 1e-6);
  vec2 prv = vPrevClipNJ.xy / max(vPrevClipNJ.w, 1e-6);
  oVelocity = vec4((cur - prv) * 0.5, dist, 1.0);
}
`;

// ------------------------------------------------------------ waterline trace
/**
 * Walk outward from (x0, z0) along (dx, dz) from r0 to r1 and return the first
 * radius where the terrain drops below WATERLINE, refined by bisection.
 * Returns -1 when the ray never leaves land or never starts on it.
 */
function crossing(terrainAt, x0, z0, dx, dz, r0, r1, step) {
  let prev = r0, hPrev = terrainAt(x0 + dx * r0, z0 + dz * r0);
  if (hPrev < WATERLINE) return -1;
  for (let r = r0 + step; r <= r1 + 1e-6; r += step) {
    const h = terrainAt(x0 + dx * r, z0 + dz * r);
    if (h < WATERLINE) {
      let a = prev, b = r;
      for (let i = 0; i < 7; i++) {
        const m = (a + b) * 0.5;
        if (terrainAt(x0 + dx * m, z0 + dz * m) < WATERLINE) b = m; else a = m;
      }
      return (a + b) * 0.5;
    }
    prev = r; hPrev = h;
  }
  return -1;
}

/** Radial trace for a cone / plateau island. Returns [{ x, z, nx, nz }]. */
function traceRound(def, terrainAt) {
  const pts = [];
  const rMin = def.radius * 0.3, rMax = def.radius * 1.9;
  for (let i = 0; i < RAYS; i++) {
    const a = (i / RAYS) * Math.PI * 2, dx = Math.cos(a), dz = Math.sin(a);
    const r = crossing(terrainAt, def.x, def.z, dx, dz, rMin, rMax, 2.5);
    if (r < 0) continue;
    pts.push({ x: def.x + dx * r, z: def.z + dz * r, nx: dx, nz: dz });
  }
  return pts;
}

/**
 * Crescent: the ridge runs along an arc, so the coast is two lines (outer and
 * inner) joined at the horns. Walk the arc, find both crossings per angle and
 * chain them into one closed loop: outer a0 -> a1, inner a1 -> a0.
 */
function traceArc(def, terrainAt) {
  const arc = def.arc;
  const cap = 1.6 * arc.thick / arc.r;
  const u0 = arc.a0 - cap, u1 = arc.a1 + cap;
  const outer = [], inner = [];
  const reach = Math.min(arc.thick * 2.2, arc.r - 1);
  for (let i = 0; i <= RAYS; i++) {
    const a = u0 + (u1 - u0) * (i / RAYS), dx = Math.cos(a), dz = Math.sin(a);
    // both marches start on the ridge and walk away from it: outward, then inward
    const rx = def.x + dx * arc.r, rz = def.z + dz * arc.r;
    const ro = crossing(terrainAt, rx, rz, dx, dz, 0, reach, 2.5);
    const ri = crossing(terrainAt, rx, rz, -dx, -dz, 0, reach, 2.5);
    if (ro < 0 || ri < 0) continue;
    outer.push({ x: rx + dx * ro, z: rz + dz * ro, nx: dx, nz: dz });
    inner.push({ x: rx - dx * ri, z: rz - dz * ri, nx: -dx, nz: -dz });
  }
  inner.reverse();
  return outer.concat(inner);
}

// ------------------------------------------------------------------ class
export class ShoreFoam {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.sea = game.sea;
    this.material = makeFoamMaterial('ShoreFoam', VERT, FRAG, game.app.atmosphere);
    this.material.uniforms.uSurf = { value: 1 };
    this.mesh = null;
    this.islands = [];        // { start, count, pts, terrain: Float32Array, far: bool, cx, cz, r }
    this.seaward = SEAWARD;
    this.frame = 0;
  }

  /** Build the foam bands for a world (disposes the previous world's). */
  build(world) {
    this._clear();
    const defs = world?.def?.islands;
    const terrainAt = world?.terrainAt;
    if (!defs?.length || typeof terrainAt !== 'function') return;

    const hs = world.def.weather?.patch?.swellHs ?? 0.5;
    this.seaward = SEAWARD + hs * 2.5;
    this.material.uniforms.uSurf.value = THREE.MathUtils.clamp(0.9 + hs * 0.4, 0.9, 1.8);
    this.offsets = ROW_T.map(t => -BEACH + t * (BEACH + this.seaward));

    const islands = [];
    let total = 0;
    for (const def of defs) {
      const pts = def.shape === 'crescent' && def.arc ? traceArc(def, terrainAt) : traceRound(def, terrainAt);
      if (pts.length < 3) continue;
      // sand height under every vertex is static: sample it once
      const terrain = new Float32Array(pts.length * ROWS);
      let cx = 0, cz = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        cx += p.x; cz += p.z;
        for (let k = 0; k < ROWS; k++) {
          const o = this.offsets[k];
          terrain[i * ROWS + k] = terrainAt(p.x + p.nx * o, p.z + p.nz * o);
        }
      }
      cx /= pts.length; cz /= pts.length;
      let r = 0;
      for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.z - cz));
      islands.push({ start: total, count: pts.length, pts, terrain, seed: islands.length, cx, cz, r: r + this.seaward, far: true, dirty: true });
      total += pts.length;
    }
    if (!total) return;

    const nv = total * ROWS;
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const data = new Float32Array(nv * 4);
    const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(total * (ROWS - 1) * 6);
    let o = 0;
    for (const isl of islands) {
      for (let i = 0; i < isl.count; i++) {
        const p = isl.pts[i];
        const i1 = (i + 1) % isl.count;
        for (let k = 0; k < ROWS; k++) {
          const v = (isl.start + i) * ROWS + k;
          data[v * 4] = ROW_T[k]; data[v * 4 + 1] = isl.seed; data[v * 4 + 2] = p.nx; data[v * 4 + 3] = p.nz;
          if (k < ROWS - 1) {
            const a = v, b = (isl.start + i1) * ROWS + k, c = v + 1, d = b + 1;
            idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = c; idx[o++] = b; idx[o++] = d;
          }
        }
      }
    }
    geo.setAttribute('position', this.pos);
    geo.setAttribute('aData', new THREE.BufferAttribute(data, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = 'shore-foam';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.islands = islands;
    // first lay-out: every island, flat sea
    for (const isl of islands) this._layIsland(isl, false);
    this.pos.needsUpdate = true;
    this.scene.add(this.mesh);
    this.vertices = nv;
    this.triangles = total * (ROWS - 1) * 2;
  }

  /**
   * The wide wave grid: `game.sea` is the two-level Sea (coarse + fine) but a
   * bare WaveField works too. Points off the grid take the mean surface
   * directly instead of going through heightAt, so the probe's fallback
   * counter in the debug HUD stays a physics diagnostic.
   */
  get grid() { return this.sea.coarse || this.sea; }

  _layIsland(isl, near) {
    const P = this.pos.array, sea = this.sea, grid = this.grid;
    const useGrid = near && grid.ready;
    // The coarse grid smooths the short cascades, and beyond it the band rests
    // on the mean surface, so lift by a share of Hs or the drawn crests hide
    // it. Seen from a boat at a grazing angle the offset reads as height of
    // the surf, not as foam hovering; up close on a storm beach it does show.
    const hs = this.game.app.ocean?.significantWaveHeight || 0;
    // Off-grid islands are 100 m+ away, where a 10 m band is edge-on and
    // sub-pixel: an extra half metre gives the far surf line a pixel of height.
    const lift = useGrid ? LIFT + hs * 0.25 : LIFT + 0.5 + hs * 0.40;
    for (let i = 0; i < isl.count; i++) {
      const p = isl.pts[i];
      for (let k = 0; k < ROWS; k++) {
        const o = this.offsets[k];
        const x = p.x + p.nx * o, z = p.z + p.nz * o;
        const h = (useGrid && grid.contains(x, z) ? sea.heightAt(x, z) : sea.meanHeight(x, z)) + lift;
        const v = (isl.start + i) * ROWS + k;
        P[v * 3] = x; P[v * 3 + 1] = Math.max(isl.terrain[i * ROWS + k] + SAND_LIFT, h); P[v * 3 + 2] = z;
      }
    }
  }

  update(dt) {
    if (!this.mesh || dt <= 0) return;
    const grid = this.grid;
    const f = this.frame++;
    const gx = grid.origin.x + grid.span * 0.5, gz = grid.origin.y + grid.span * 0.5, half = grid.span * 0.5;
    this.pos.updateRanges.length = 0;
    let any = false;
    for (let i = 0; i < this.islands.length; i++) {
      const isl = this.islands[i];
      // near = the band overlaps the wave probe's grid: ride the waves, refresh every other frame
      const near = Math.abs(isl.cx - gx) < half + isl.r && Math.abs(isl.cz - gz) < half + isl.r;
      const due = near ? (f & 1) === (i & 1) : (f % 24) === (i % 24) || isl.far !== near;
      if (!due) continue;
      isl.far = !near;
      this._layIsland(isl, near);
      this.pos.addUpdateRange(isl.start * ROWS * 3, isl.count * ROWS * 3);
      any = true;
    }
    if (any) this.pos.needsUpdate = true;
  }

  _clear() {
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      this.mesh = null;
    }
    this.islands = [];
    this.pos = null;
  }

  dispose() {
    this._clear();
    this.material.dispose();
  }
}

/**
 * Standalone test (`?mods=ShoreFoam`): builds for the current world, rebuilds
 * on every world load and updates after the game. `?skip=<world>` is honoured
 * once the hub has settled, since the mods hook forces the hub first.
 */
export function devInstall(game) {
  if (game.shoreFoam) return game.shoreFoam;
  const sf = new ShoreFoam(game);
  sf.build(game.world);
  const load = game.loadWorld.bind(game);
  game.loadWorld = async (id, immediate) => { await load(id, immediate); sf.build(game.world); };
  const update = game.update.bind(game);
  const skip = game.params?.get('skip');
  let jumped = false;
  game.update = (dt, rawDt) => {
    update(dt, rawDt);
    sf.update(dt);
    if (!jumped && skip && skip !== 'title' && game.state === 'hub' && !game._transitioning && game.world?.id !== skip
      && game.mods?.Worlds?.WORLDS?.[skip]) { jumped = true; game.enterWorld(skip); }
  };
  game.devShoreFoam = sf;
  console.log(`[ShoreFoam] ${sf.islands.length} islands, ${sf.triangles || 0} triangles`);
  return sf;
}
