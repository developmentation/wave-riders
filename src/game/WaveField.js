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
 * centred on a focus point, reads it back asynchronously through a pixel
 * buffer, and serves bilinear height + slope lookups to any number of boats.
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
in vec2 vUv;
layout(location=0) out vec4 outColor;
void main(){
  // Texel centres map to grid nodes so the CPU can index them exactly.
  vec2 p = uOrigin + (vUv * uCells - 0.5) / (uCells - 1.0) * uSpan;
  float e = 0.75;
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
    this.pendingOrigin = new THREE.Vector2();
    this.focus = new THREE.Vector2();
    this.data = new Float32Array(cells * cells * 4);
    this.ready = false;
    this.target = makeRT(cells, cells, { type: THREE.FloatType, name: 'wave-field', minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.pass = new FullScreenPass(PROBE, app.ocean.bind({
      ...U,
      uOrigin: { value: new THREE.Vector2() },
      uSpan: { value: span },
      uCells: { value: cells },
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
      this._pending[slot] = this.pendingOrigin.clone();
      this._slot = (slot + 1) % this._pbo.length;
      r.state.reset();
    } else {
      r.readRenderTargetPixels(this.target, 0, 0, this.cells, this.cells, this.data);
      this.origin.copy(this.pendingOrigin);
      this.ready = true;
      this.stats.readbacks++;
    }
  }

  _collect() {
    // The slot written last frame is the one we are about to overwrite: fetch it now.
    const gl = this.gl, slot = this._slot;
    const origin = this._pending[slot];
    if (!origin) return;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbo[slot]);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.data);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.origin.copy(origin);
    this._pending[slot] = null;
    this.ready = true;
    this.stats.readbacks++;
  }

  /** Analytic mean surface (sea level + disaster fields), used outside the grid. */
  meanHeight(x, z) {
    return U.uSeaLevel.value + (this.app.director?.eventHeight(x, z) || 0);
  }

  /**
   * Height and slope of the surface at world (x, z).
   * @param {THREE.Vector3} [out] receives (height, dh/dx, dh/dz)
   */
  sample(x, z, out = _tmp) {
    if (!this.ready) { out.set(this.meanHeight(x, z), 0, 0); return out; }
    const n = this.cells, s = (n - 1) / this.span;
    const fx = (x - this.origin.x) * s, fz = (z - this.origin.y) * s;
    if (fx < 0 || fz < 0 || fx > n - 1 || fz > n - 1) {
      this.stats.fallbacks++;
      out.set(this.meanHeight(x, z), 0, 0);
      return out;
    }
    const ix = Math.min(n - 2, Math.floor(fx)), iz = Math.min(n - 2, Math.floor(fz));
    const tx = fx - ix, tz = fz - iz;
    const d = this.data;
    const i00 = (iz * n + ix) * 4, i10 = i00 + 4, i01 = i00 + n * 4, i11 = i01 + 4;
    const w00 = (1 - tx) * (1 - tz), w10 = tx * (1 - tz), w01 = (1 - tx) * tz, w11 = tx * tz;
    const h = d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
    if (!Number.isFinite(h)) { out.set(this.meanHeight(x, z), 0, 0); return out; }
    out.set(h,
      d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11,
      d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11);
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

const _tmp = new THREE.Vector3();
