import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { FullScreenPass, makeRT } from '../gfx/FullScreenPass.js';
import { OCEAN_SAMPLE_GLSL } from '../ocean/OceanSampleGLSL.js';

/**
 * GPU wave height field → CPU sampling.
 *
 * The FFT cascades live on the GPU, so boat physics cannot evaluate the surface
 * directly. Once per frame this renders the *actual* shader surface height
 * (all three cascades plus every live disaster field) into a small grid
 * centred on a focus point, reads it back through alternating pixel buffers,
 * and serves bilinear height + slope lookups to any number of boats.
 *
 * The previous frame's grid is kept so a sample also yields the surface's
 * vertical velocity (dh/dt): buoyancy damping then acts on the hull's motion
 * *relative to the water*, which is what stops a rising wave from swallowing
 * a hull that is merely standing still.
 *
 * Latency is one frame, which the physics never notices. Outside the grid the
 * lookup falls back to the analytic mean surface.
 */
const PROBE = /* glsl */ `
${OCEAN_SAMPLE_GLSL}
uniform float uTime;
uniform vec2 uOrigin;
uniform float uSpan;
uniform float uCells;
uniform float uEps;
in vec2 vUv;
layout(location=0) out vec4 outColor;
void main(){
  // Texel centres map to grid nodes so the CPU can index them exactly.
  vec2 p = uOrigin + (vUv * uCells - 0.5) / (uCells - 1.0) * uSpan;
  float e = uEps;
  float h  = surfaceHeightAt(p, uTime);
  float hx = surfaceHeightAt(p + vec2(e, 0.0), uTime);
  float hz = surfaceHeightAt(p + vec2(0.0, e), uTime);
  outColor = vec4(h, (hx - h) / e, (hz - h) / e, 1.0);
}
`;

export class WaveField {
  constructor(app, { cells = 48, span = 200 } = {}) {
    this.app = app;
    this.cells = cells;
    this.span = span;
    this.origin = new THREE.Vector2();          // world xz of grid corner (cell 0,0)
    this.prevOrigin = new THREE.Vector2();
    this.pendingOrigin = new THREE.Vector2();
    this.focus = new THREE.Vector2();
    this.data = new Float32Array(cells * cells * 4);
    this.prevData = new Float32Array(cells * cells * 4);
    this.dataTime = 0;
    this.prevTime = 0;
    this.ready = false;
    this.lastDhdt = 0;
    const cell = span / (cells - 1);
    this.target = makeRT(cells, cells, { type: THREE.FloatType, name: 'wave-field', minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.pass = new FullScreenPass(PROBE, app.ocean.bind({
      ...U,
      uOrigin: { value: new THREE.Vector2() },
      uSpan: { value: span },
      uCells: { value: cells },
      // Slope probe step scales with the cell so fine grids see fine slopes.
      uEps: { value: Math.max(0.15, Math.min(0.75, cell * 0.25)) },
    }), { name: 'wave-field-probe' });

    const gl = app.renderer.getContext();
    this.gl = gl;
    // Two pixel-pack buffers, alternated: this frame's readPixels goes into
    // one while last frame's result is fetched from the other. A frame of
    // latency is all the GPU needs to finish, so the fetch rarely stalls, and
    // each buffer is always read before it is written again (no fences, which
    // ANGLE turns into shadow-copy warnings).
    this.async = typeof gl.PIXEL_PACK_BUFFER === 'number';
    this._pbo = [];
    this._pending = [];
    if (this.async) {
      for (let i = 0; i < 2; i++) {
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, this.data.byteLength, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this._pbo.push(buf);
        this._pending.push(null);
      }
      this._slot = 0;
    }
    this.stats = { readbacks: 0, fallbacks: 0 };
  }

  /** Move the grid so it is centred on (x, z). Call before update(). */
  setFocus(x, z) { this.focus.set(x, z); }

  /** True when (x, z) lies inside the last collected grid. */
  contains(x, z) {
    if (!this.ready) return false;
    const fx = x - this.origin.x, fz = z - this.origin.y;
    return fx >= 0 && fz >= 0 && fx <= this.span && fz <= this.span;
  }

  /**
   * Render this frame's field and collect the previous frame's readback.
   * Runs inside the frame, before physics.
   */
  update() {
    const r = this.app.renderer, gl = this.gl;
    // Collect finished readbacks first so physics sees the freshest data.
    if (this.async) this._collect();

    const half = this.span * 0.5;
    this.pendingOrigin.set(this.focus.x - half, this.focus.y - half);
    this.pass.uniforms.uOrigin.value.copy(this.pendingOrigin);
    this.pass.render(r, this.target);

    if (this.async) {
      const slot = this._slot;
      const fb = r.properties.get(this.target).__webglFramebuffer;
      if (!fb) return;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo[slot]);
      gl.readPixels(0, 0, this.cells, this.cells, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._pending[slot] = { origin: this.pendingOrigin.clone(), time: U.uTime.value };
      this._slot = (slot + 1) % this._pbo.length;
      r.state.reset();
    } else {
      this._rotate(this.pendingOrigin, U.uTime.value);
      r.readRenderTargetPixels(this.target, 0, 0, this.cells, this.cells, this.data);
    }
  }

  _rotate(origin, time) {
    // Current grid becomes the previous one; the buffers swap so no copy is needed.
    const t = this.prevData; this.prevData = this.data; this.data = t;
    this.prevOrigin.copy(this.origin);
    this.prevTime = this.dataTime;
    this.origin.copy(origin);
    this.dataTime = time;
    this.ready = true;
    this.stats.readbacks++;
  }

  _collect() {
    // The slot written last frame is the one we are about to overwrite: fetch it now.
    const gl = this.gl, slot = this._slot;
    const job = this._pending[slot];
    if (!job) return;
    this._rotate(job.origin, job.time);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo[slot]);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.data);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this._pending[slot] = null;
  }

  /** Analytic mean surface (sea level + disaster fields), used outside the grid. */
  meanHeight(x, z) {
    return U.uSeaLevel.value + (this.app.director?.eventHeight(x, z) || 0);
  }

  /** Bilinear read of one grid; returns false when (x, z) is outside it. */
  _read(d, origin, x, z, out) {
    const n = this.cells, s = (n - 1) / this.span;
    const fx = (x - origin.x) * s, fz = (z - origin.y) * s;
    if (fx < 0 || fz < 0 || fx > n - 1 || fz > n - 1) return false;
    const ix = Math.min(n - 2, Math.floor(fx)), iz = Math.min(n - 2, Math.floor(fz));
    const tx = fx - ix, tz = fz - iz;
    const i00 = (iz * n + ix) * 4, i10 = i00 + 4, i01 = i00 + n * 4, i11 = i01 + 4;
    const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
    const h = d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
    if (!Number.isFinite(h)) return false;
    out.set(h,
      d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11,
      d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11);
    return true;
  }

  /**
   * Height and slope of the surface at world (x, z); also sets `lastDhdt`, the
   * surface's vertical velocity there (m/s), when the previous grid covers it.
   * @param {THREE.Vector3} [out] receives (height, dh/dx, dh/dz)
   */
  sample(x, z, out = _tmp) {
    this.lastDhdt = 0;
    if (!this.ready || !this._read(this.data, this.origin, x, z, out)) {
      this.stats.fallbacks++;
      out.set(this.meanHeight(x, z), 0, 0);
      return out;
    }
    const dt = this.dataTime - this.prevTime;
    if (dt > 1e-4 && dt < 0.25 && this._read(this.prevData, this.prevOrigin, x, z, _prev)) {
      this.lastDhdt = THREE.MathUtils.clamp((out.x - _prev.x) / dt, -12, 12);
    }
    return out;
  }

  heightAt(x, z) { return this.sample(x, z, _tmp).x; }

  /** Surface normal at (x, z). */
  normalAt(x, z, out = new THREE.Vector3()) {
    const s = this.sample(x, z, _tmp);
    return out.set(-s.y, 1, -s.z).normalize();
  }

  dispose() {
    this.target.dispose(); this.pass.dispose();
    for (const b of this._pbo) this.gl.deleteBuffer(b);
  }
}

/**
 * Two-level sea: a wide coarse grid for everything (AI boats, gates, wakes)
 * and a small fine grid riding with the player, so the hull that is actually
 * on screen floats on the sea at sub-metre resolution.
 */
export class Sea {
  constructor(app, { coarse = { cells: 64, span: 200 }, fine = { cells: 40, span: 30 } } = {}) {
    this.app = app;
    this.coarse = new WaveField(app, coarse);
    this.fine = new WaveField(app, fine);
    this.lastDhdt = 0;
    this.stats = this.coarse.stats;
  }

  /** Coarse grid centre (the player); the fine grid follows the same point. */
  setFocus(x, z) { this.coarse.setFocus(x, z); this.fine.setFocus(x, z); }
  /** Optionally centre the fine grid elsewhere (e.g. the camera's boat). */
  setFineFocus(x, z) { this.fine.setFocus(x, z); }

  update() { this.coarse.update(); this.fine.update(); }

  meanHeight(x, z) { return this.coarse.meanHeight(x, z); }

  sample(x, z, out = _tmp) {
    // The fine grid's edge cells blend toward the coarse answer so a hull
    // straddling the boundary never sees a step.
    if (this.fine.contains(x, z)) {
      const f = this.fine, half = f.span * 0.5;
      const cx = f.origin.x + half, cz = f.origin.y + half;
      const edge = Math.max(Math.abs(x - cx), Math.abs(z - cz)) / half;   // 0 centre .. 1 edge
      f.sample(x, z, out);
      const dhdt = f.lastDhdt;
      if (edge > 0.8) {
        const t = (edge - 0.8) / 0.2;
        this.coarse.sample(x, z, _blend);
        out.lerp(_blend, t);
        this.lastDhdt = THREE.MathUtils.lerp(dhdt, this.coarse.lastDhdt, t);
      } else this.lastDhdt = dhdt;
      return out;
    }
    this.coarse.sample(x, z, out);
    this.lastDhdt = this.coarse.lastDhdt;
    return out;
  }

  heightAt(x, z) { return this.sample(x, z, _tmp).x; }

  normalAt(x, z, out = new THREE.Vector3()) {
    const s = this.sample(x, z, _tmp);
    return out.set(-s.y, 1, -s.z).normalize();
  }

  dispose() { this.coarse.dispose(); this.fine.dispose(); }
}

const _tmp = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _blend = new THREE.Vector3();
