import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { U } from '../core/SharedUniforms.js';
import { NOISE_GLSL } from '../gfx/NoiseGLSL.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';
import { PropMaterial, trackMotion } from './PropMaterial.js';

/**
 * Portal rings: 12 m glowing tori standing in the water, each filled with a
 * swirling disc of "liquid light", topped by a floating icon, wrapped in a soft
 * light column and a few rising sparkles. Driving through one fires `test()`
 * once; `transition()` runs the white-out that hides the world swap.
 *
 * Rendering notes. Everything writes both MRT outputs. The glow layers use
 * ordinary alpha blending rather than additive: with alpha blending the
 * velocity attachment is *lerped* toward (0, 0, viewDistance, 1), which is
 * exactly what TAA wants for a stationary emitter, whereas additive blending
 * would accumulate distance into it. Sparkles are animated entirely in the
 * vertex shader from a per-point seed, so the CPU does nothing per frame
 * beyond bobbing the ring on the sampled sea.
 */
const RING_RADIUS = 6.0;
const TUBE = 0.5;
const RING_Y = 4.6;               // torus centre above the (bobbing) sea
const ICON_Y = RING_Y + RING_RADIUS + TUBE + 3.4;
const COLUMN_H = 26;
const POOL_R = RING_RADIUS * 1.35;
const SPARKLES = 160;
const REENTRY_COOLDOWN = 3.0;

export const PORTAL_TINTS = {
  hub: { tint: 0xffe9a8, deep: 0xffb347, label: 'Harbour' },
  lagoon: { tint: 0xffd84d, deep: 0xff8a1a, label: 'Sunny Lagoon' },
  swell: { tint: 0x4ff0ff, deep: 0x1a6cff, label: 'Rolling Swell' },
  storm: { tint: 0xc07cff, deep: 0x6a2bff, label: 'Storm Run' },
};

// ----------------------------------------------------------------- shaders
const GLOW_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
${SHADING_GLSL}
in vec3 position;
in vec3 normal;
in vec2 uv;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 uViewProjNJ;
uniform mat4 uPrevViewProjNJ;
uniform sampler2D uEnvMap;
uniform float uEnvMaxLod;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out vec3 vLocal;
out vec3 vAmb;
out vec4 vClipNJ;
out vec4 vPrevClipNJ;
void main(){
  // sky ambient for the haze mix, once per vertex rather than nine taps per pixel
  vAmb = skyIrradiance(uEnvMap, uEnvMaxLod);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  vLocal = position;
  vClipNJ = uViewProjNJ * wp;
  vPrevClipNJ = uPrevViewProjNJ * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const GLOW_COMMON = /* glsl */ `
precision highp float;
${NOISE_GLSL}
uniform vec3 uCamPos;
uniform float uTime;
uniform vec3 uTint;
uniform vec3 uDeep;
uniform float uPhase;
uniform float uFogDensity;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in vec3 vLocal;
in vec3 vAmb;
in vec4 vClipNJ;
in vec4 vPrevClipNJ;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void writeOut(vec3 color, float alpha){
  float dist = length(vWorld - uCamPos);
  // storm haze, same falloff as the props so the portal sits in the weather
  float fog = 1.0 - exp(-dist * uFogDensity * 0.0025);
  color = mix(color, vAmb * 2.2, fog * 0.8);
  oColor = vec4(color, alpha);
  vec2 cur = vClipNJ.xy / max(vClipNJ.w, 1e-6);
  vec2 prv = vPrevClipNJ.xy / max(vPrevClipNJ.w, 1e-6);
  oVelocity = vec4((cur - prv) * 0.5, dist, 1.0);
}
`;

/** Liquid light: a translucent window whose swirling filaments brighten toward a soft rim. */
const DISC_FRAG = /* glsl */ `
${GLOW_COMMON}
void main(){
  vec2 p = vLocal.xy / ${RING_RADIUS.toFixed(1)};
  float r = length(p);
  if (r > 1.0) discard;
  float t = uTime * 0.8 + uPhase;
  float ang = atan(p.y, p.x);
  // domain-warped swirl: the angle advances with radius so the field twists
  float swirl = ang + r * 2.6 - t * 0.3;
  vec2 q = vec2(cos(swirl), sin(swirl)) * (0.6 + r * 2.2);
  float n1 = vnoise2(q * 1.7 + vec2(t * 0.25, -t * 0.2));
  // second octave as a swirl-warped sine: one value-noise per pixel is all the disc can afford
  float n2 = 0.5 + 0.5 * sin(swirl * 5.0 + r * 9.0 - t * 1.2 + n1 * 3.5);
  float fil = smoothstep(0.42, 0.62, n1 * 0.55 + n2 * 0.45);            // bright liquid filaments
  float rip = pow(sin(r * 14.0 - t * 2.4 + n1 * 3.0) * 0.5 + 0.5, 4.0);  // a few soft ripples
  float rim = smoothstep(0.60, 0.97, r);
  float rimCore = smoothstep(0.90, 0.99, r);
  vec3 col = mix(uDeep, uTint, clamp(r * 0.45 + fil * 0.7 - 0.1, 0.0, 1.0)) * (2.2 + fil * 6.5 + rip * 3.0);
  col += uTint * rim * 6.0 + vec3(1.0) * rimCore * 4.0;
  // see-through in the middle so the world behind shimmers through the light
  float alpha = 0.16 + fil * 0.42 + rip * 0.18 + rim * 0.45;
  alpha = clamp(alpha, 0.0, 0.85) * (1.0 - smoothstep(0.985, 1.0, r));
  writeOut(col, alpha);
}
`;

/** Glow pool: the ring's light spilling onto the water around it. */
const POOL_FRAG = /* glsl */ `
${GLOW_COMMON}
void main(){
  vec2 p = vLocal.xy / ${POOL_R.toFixed(2)};
  float r = length(p);
  if (r > 1.0) discard;
  float shimmer = vnoise2(vLocal.xy * 0.9 + vec2(uTime * 0.35, -uTime * 0.27) + uPhase) * 0.6 + 0.7;
  float fall = pow(1.0 - r, 2.2);
  vec3 col = mix(uDeep, uTint, 0.5 + 0.5 * fall) * 6.0 * shimmer;
  writeOut(col, fall * 0.6);
}
`;

/** Tapered light column: fades with height, thin at the silhouette, slow rising haze. */
const COLUMN_FRAG = /* glsl */ `
${GLOW_COMMON}
void main(){
  float h = clamp(vLocal.y / ${COLUMN_H.toFixed(1)} + 0.5, 0.0, 1.0);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 N = normalize(vNormal);
  // a cylinder of glowing haze is thickest through its middle
  float thick = pow(abs(dot(N, V)), 1.4);
  float ang = atan(vLocal.z, vLocal.x);
  float haze = vnoise2(vec2(ang * 1.5 + uPhase, h * 9.0 - uTime * 0.55));
  haze = 0.55 + 0.9 * haze;
  float fade = pow(1.0 - h, 1.8) * smoothstep(0.0, 0.08, h);
  float pulse = 0.9 + 0.1 * sin(uTime * 2.0 + uPhase);
  vec3 col = mix(uDeep, uTint, 0.6 + 0.4 * h) * 6.5 * haze * pulse;
  float alpha = fade * thick * 0.42 * haze;
  if (alpha < 0.01) discard;   // skip the MRT blend where the haze has thinned to nothing
  writeOut(col, alpha);
}
`;

const SPARK_VERT = /* glsl */ `
precision highp float;
in vec3 aSeed;
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 uViewProjNJ;
uniform mat4 uPrevViewProjNJ;
uniform vec3 uCamPos;
uniform vec2 uResolution;
uniform float uTime;
uniform float uPhase;
out float vFade;
out float vTwinkle;
out vec3 vWorld;
out vec4 vClipNJ;
out vec4 vPrevClipNJ;
void main(){
  // Each sparkle rises through the ring on its own loop; nothing is stored.
  float speed = mix(0.9, 1.9, aSeed.z);
  float life = fract(uTime * speed * 0.14 + aSeed.x * 7.0 + uPhase);
  float rad = ${RING_RADIUS.toFixed(1)} * 0.92 * sqrt(aSeed.x);
  float ang = aSeed.y * 6.2831853 + life * 2.2 + uTime * 0.15;
  vec3 local = vec3(cos(ang) * rad, mix(-1.5, ${(RING_RADIUS * 2 + 3).toFixed(1)}, life), (aSeed.z - 0.5) * 2.4);
  // pull them toward the ring's centre as they climb so the cloud reads as a fountain
  local.xz *= mix(1.0, 0.35, life * life);
  local.y += ${RING_Y.toFixed(1)} - ${RING_RADIUS.toFixed(1)};
  vec4 wp = modelMatrix * vec4(local, 1.0);
  vWorld = wp.xyz;
  vFade = smoothstep(0.0, 0.12, life) * (1.0 - smoothstep(0.7, 1.0, life));
  vTwinkle = 0.55 + 0.45 * sin(uTime * mix(5.0, 11.0, aSeed.y) + aSeed.x * 40.0);
  float dist = length(uCamPos - wp.xyz);
  float px = mix(0.16, 0.30, aSeed.y) * uResolution.y / max(dist, 1.0);
  gl_PointSize = clamp(px, 1.5, 18.0);
  vClipNJ = uViewProjNJ * wp;
  vPrevClipNJ = uPrevViewProjNJ * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SPARK_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uCamPos;
uniform vec3 uTint;
in float vFade;
in float vTwinkle;
in vec3 vWorld;
in vec4 vClipNJ;
in vec4 vPrevClipNJ;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = length(q);
  if (d > 1.0) discard;
  // soft core plus a four-point star
  float core = pow(1.0 - d, 2.2);
  // four tapering arms: bright at the centre, gone before the sprite edge
  float ax = pow(max(1.0 - abs(q.y), 0.0), 10.0) * pow(max(1.0 - abs(q.x), 0.0), 1.5);
  float ay = pow(max(1.0 - abs(q.x), 0.0), 10.0) * pow(max(1.0 - abs(q.y), 0.0), 1.5);
  float a = (core + max(ax, ay) * 0.6) * vFade * vTwinkle;
  vec3 col = mix(uTint, vec3(1.0), core * 0.7) * 16.0;
  oColor = vec4(col, clamp(a, 0.0, 1.0));
  float dist = length(vWorld - uCamPos);
  vec2 cur = vClipNJ.xy / max(vClipNJ.w, 1e-6);
  vec2 prv = vPrevClipNJ.xy / max(vPrevClipNJ.w, 1e-6);
  oVelocity = vec4((cur - prv) * 0.5, dist, 1.0);
}
`;

function glowMaterial(frag, tint, deep, phase, extra = {}) {
  return new THREE.RawShaderMaterial({
    name: 'PortalGlow',
    glslVersion: THREE.GLSL3,
    vertexShader: GLOW_VERT,
    fragmentShader: frag,
    uniforms: {
      uCamPos: U.uCamPos, uTime: U.uTime, uViewProjNJ: U.uViewProjNJ, uPrevViewProjNJ: U.uPrevViewProjNJ,
      uFogDensity: U.uFogDensity, uEnvMap: U.uEnvMap, uEnvMaxLod: U.uEnvMaxLod,
      uTint: { value: tint }, uDeep: { value: deep }, uPhase: { value: phase },
    },
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    ...extra,
  });
}

// ------------------------------------------------------------------- icons
const _color = new THREE.Color();
function paint(geom, hex) {
  const g = geom.index ? geom.toNonIndexed() : geom;
  const n = g.attributes.position.count;
  const c = new Float32Array(n * 3);
  _color.set(hex);
  for (let i = 0; i < n; i++) { c[i * 3] = _color.r; c[i * 3 + 1] = _color.g; c[i * 3 + 2] = _color.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (g !== geom) geom.dispose();
  return g;
}

function sunIcon() {
  const parts = [paint(new THREE.SphereGeometry(1.15, 20, 14), 0xffe14a)];
  for (let i = 0; i < 8; i++) {
    const ray = new THREE.BoxGeometry(0.34, 1.15, 0.34);
    ray.translate(0, 2.05, 0);
    ray.rotateZ(i * Math.PI / 4);
    parts.push(paint(ray, 0xff9a1a));
  }
  return [{ geom: mergeGeometries(parts, false) }];
}

function waveIcon() {
  // A wavy ribbon: sine top edge, offset bottom edge, extruded for thickness.
  const shape = new THREE.Shape();
  const steps = 28, span = 4.6, amp = 0.62, thick = 0.62;
  for (let i = 0; i <= steps; i++) {
    const x = -span / 2 + span * i / steps;
    const y = Math.sin(x * 2.2) * amp;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  for (let i = steps; i >= 0; i--) {
    const x = -span / 2 + span * i / steps;
    shape.lineTo(x, Math.sin(x * 2.2) * amp - thick);
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
  g.translate(0, thick * 0.5, -0.25);
  const crest = new THREE.SphereGeometry(0.42, 12, 8);
  crest.translate(-span / 2 + 0.55, Math.sin((-span / 2 + 0.55) * 2.2) * amp + 0.35, 0);
  return [{ geom: mergeGeometries([paint(g, 0x53e6ff), paint(crest, 0xffffff)], false) }];
}

function stormIcon() {
  const blobs = [[0, 0, 0, 1.0], [-1.1, -0.2, 0.1, 0.75], [1.05, -0.15, -0.1, 0.8], [0.25, 0.5, 0.25, 0.7]];
  const parts = blobs.map(([x, y, z, r]) => {
    const s = new THREE.SphereGeometry(r, 16, 12);
    s.translate(x, y + 1.4, z);
    return paint(s, 0xcbb6ff);
  });
  const bolt = new THREE.Shape();
  // a big fat bolt: kids must read "storm" from 100 m
  [[0.5, 0.3], [-0.7, -1.3], [0.15, -1.3], [-0.75, -3.1], [1.05, -1.05], [0.25, -1.05], [1.15, 0.3]]
    .forEach(([x, y], i) => (i === 0 ? bolt.moveTo(x, y) : bolt.lineTo(x, y)));
  bolt.closePath();
  const b = new THREE.ExtrudeGeometry(bolt, { depth: 0.45, bevelEnabled: false });
  b.translate(-0.2, 0.55, -0.22);
  // the bolt carries its own hot yellow emissive so it stays legible on the purple cloud
  return [{ geom: mergeGeometries(parts, false) }, { geom: paint(b, 0xfff36b), emissive: 0xffd040 }];
}

const ICON_BUILDERS = { lagoon: sunIcon, swell: waveIcon, storm: stormIcon, hub: sunIcon };

// ----------------------------------------------------------------- portals
const _p = new THREE.Vector3();

export class Portals {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.sea = game.sea;
    this.atmosphere = game.app.atmosphere;
    this.group = new THREE.Group();
    this.group.name = 'portals';
    this.scene.add(this.group);
    this.portals = [];
    this.transitioning = false;
    this.lastDest = undefined;
    this._overlay = null;
    this._geo = null;
  }

  _sharedGeometry() {
    if (this._geo) return this._geo;
    const disc = new THREE.CircleGeometry(RING_RADIUS, 56);
    const pool = new THREE.CircleGeometry(POOL_R, 40);
    const column = new THREE.CylinderGeometry(0.9, RING_RADIUS * 0.55, COLUMN_H, 20, 1, true);
    const seeds = new Float32Array(SPARKLES * 3);
    for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
    const sparkles = new THREE.BufferGeometry();
    sparkles.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKLES * 3), 3));
    sparkles.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));
    sparkles.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, RING_Y, 0), RING_RADIUS * 2.5);
    this._geo = {
      torus: new THREE.TorusGeometry(RING_RADIUS, TUBE, 12, 72),
      disc, column, pool, sparkles,
      icons: {},
    };
    return this._geo;
  }

  /** @param {Array<{x:number,z:number,heading:number,dest:string}>} defs */
  build(defs) {
    this.dispose(false);
    const geo = this._sharedGeometry();
    defs.forEach((def, i) => {
      const style = PORTAL_TINTS[def.dest] || PORTAL_TINTS.hub;
      const tint = new THREE.Color(style.tint), deep = new THREE.Color(style.deep);
      const phase = i * 2.39996;
      const root = new THREE.Group();
      root.position.set(def.x, this.sea.heightAt(def.x, def.z), def.z);
      root.rotation.y = def.heading;

      // Ring frame: lit prop with an emissive glow in the destination's colour.
      const ringMat = new PropMaterial({
        color: 0xfff6dc, emissive: tint.clone().multiplyScalar(1.8), roughness: 0.28, metal: 0.45,
      }, this.atmosphere);
      const ring = new THREE.Mesh(geo.torus, ringMat);
      ring.position.y = RING_Y;
      trackMotion(ring);

      const disc = new THREE.Mesh(geo.disc, glowMaterial(DISC_FRAG, tint, deep, phase));
      disc.position.y = RING_Y;
      disc.renderOrder = 3;

      const column = new THREE.Mesh(geo.column, glowMaterial(COLUMN_FRAG, tint, deep, phase, { side: THREE.FrontSide }));
      column.position.y = COLUMN_H * 0.5 - 1.5;
      column.renderOrder = 2;

      const pool = new THREE.Mesh(geo.pool, glowMaterial(POOL_FRAG, tint, deep, phase));
      pool.rotation.x = -Math.PI / 2;
      pool.position.y = 0.45;
      pool.renderOrder = 1;

      if (!geo.icons[def.dest]) geo.icons[def.dest] = (ICON_BUILDERS[def.dest] || sunIcon)();
      const icon = new THREE.Group();
      const iconMats = [];
      for (const part of geo.icons[def.dest]) {
        const mat = new PropMaterial({
          color: 0xffffff, roughness: 0.4, metal: 0.1, vertexColors: true,
          emissive: part.emissive !== undefined ? new THREE.Color(part.emissive).multiplyScalar(3.0) : tint.clone().multiplyScalar(2.6),
        }, this.atmosphere);
        iconMats.push(mat);
        icon.add(trackMotion(new THREE.Mesh(part.geom, mat)));
      }
      icon.position.y = ICON_Y;
      icon.scale.setScalar(1.7);

      const sparkMat = new THREE.RawShaderMaterial({
        name: 'PortalSparkles', glslVersion: THREE.GLSL3,
        vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
        uniforms: {
          uCamPos: U.uCamPos, uResolution: U.uResolution, uTime: U.uTime,
          uViewProjNJ: U.uViewProjNJ, uPrevViewProjNJ: U.uPrevViewProjNJ,
          uTint: { value: tint }, uPhase: { value: phase },
        },
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
      });
      const sparkles = new THREE.Points(geo.sparkles, sparkMat);
      sparkles.renderOrder = 4;

      root.add(ring, disc, column, pool, icon, sparkles);
      this.group.add(root);
      this.portals.push({
        def, dest: def.dest, root, ring, disc, column, icon, sparkles,
        normal: new THREE.Vector2(Math.sin(def.heading), Math.cos(def.heading)),
        right: new THREE.Vector2(Math.cos(def.heading), -Math.sin(def.heading)),
        side: 0, cooldown: 0, bobY: root.position.y, phase,
        materials: [ringMat, disc.material, column.material, pool.material, ...iconMats, sparkMat],
      });
    });
  }

  update(dt) {
    const t = this.game.time;
    for (const p of this.portals) {
      // Bob gently on the sampled sea; heavily damped so a storm swell does
      // not fling a 12 m ring around.
      const h = this.sea.heightAt(p.def.x, p.def.z) * 0.7;
      p.bobY += (h - p.bobY) * (1 - Math.exp(-dt * 1.6));
      p.root.position.y = p.bobY;
      p.icon.rotation.y += dt * 0.7;
      p.icon.position.y = ICON_Y + Math.sin(t * 1.1 + p.phase) * 0.35;
      p.ring.rotation.z = Math.sin(t * 0.5 + p.phase) * 0.02;
      if (p.cooldown > 0) p.cooldown -= dt;
    }
  }

  /**
   * Destination id when `body` crossed a ring's plane inside its radius this
   * frame, otherwise null. Fires once per crossing; re-entry within 3 s is
   * ignored so the boat can be teleported and coast through the far side.
   */
  test(body) {
    if (this.transitioning) return null;
    const pos = body.position;
    for (const p of this.portals) {
      const dx = pos.x - p.def.x, dz = pos.z - p.def.z;
      const d = dx * p.normal.x + dz * p.normal.y;       // signed distance to the ring plane
      const side = d > 0 ? 1 : -1;
      if (p.side === 0) { p.side = side; continue; }
      if (side === p.side) continue;
      p.side = side;
      if (p.cooldown > 0) continue;
      const lateral = Math.abs(dx * p.right.x + dz * p.right.y);
      // horizontal-only: boats live at the waterline, so height cannot miss
      if (lateral < RING_RADIUS - TUBE * 0.5 && Math.abs(d) < 12 && Math.abs(pos.y - p.root.position.y) < RING_RADIUS) {
        p.cooldown = REENTRY_COOLDOWN;
        this.lastDest = p.dest;
        return p.dest;
      }
    }
    return null;
  }

  /**
   * Full-screen white-out: an iris of warm light blooms from the centre
   * (0.6 s), `cb` swaps the world behind it, then it dissolves (0.8 s).
   * @param {() => Promise<void>|void} cb
   * @param {string} [dest] tints the light in the destination's colour (defaults to the portal last hit)
   */
  async transition(cb, dest = this.lastDest) {
    const style = PORTAL_TINTS[dest] || PORTAL_TINTS.hub;
    const el = this._ensureOverlay();
    this.transitioning = true;
    el.style.setProperty('--portal-tint', '#' + style.tint.toString(16).padStart(6, '0'));
    el.classList.remove('wr-portal-in');
    this.game.audio?.portal?.();
    // reflow so the class swap below animates from the closed state
    void el.offsetWidth;
    el.classList.add('wr-portal-out');
    await wait(620);
    try { await cb?.(); } catch (e) { console.error('[portals] transition callback failed', e); }
    el.classList.remove('wr-portal-out');
    el.classList.add('wr-portal-in');
    await wait(820);
    el.classList.remove('wr-portal-in');
    this.transitioning = false;
  }

  _ensureOverlay() {
    if (this._overlay) return this._overlay;
    if (!document.getElementById('wr-portal-style')) {
      const style = document.createElement('style');
      style.id = 'wr-portal-style';
      style.textContent = `
#hud .wr-portal { position: absolute; inset: 0; pointer-events: none; opacity: 0; --portal-tint: #ffd84d;
  background: radial-gradient(circle at 50% 50%, #ffffff 0%, #ffffff 28%, var(--portal-tint) 62%, #ffffff 100%);
  clip-path: circle(0% at 50% 50%); }
#hud .wr-portal.wr-portal-out { opacity: 1; clip-path: circle(80% at 50% 50%);
  transition: clip-path 0.6s cubic-bezier(0.2, 0.8, 0.3, 1), opacity 0.2s ease-out; }
#hud .wr-portal.wr-portal-in { opacity: 0; clip-path: circle(80% at 50% 50%); transition: opacity 0.8s ease-in-out; }
#hud .wr-portal .wr-portal-rings { position: absolute; inset: 0; opacity: 0; }
#hud .wr-portal.wr-portal-out .wr-portal-rings { opacity: 1; animation: wr-portal-rings 0.6s ease-out forwards; }
#hud .wr-portal .wr-portal-rings::before, #hud .wr-portal .wr-portal-rings::after { content: ''; position: absolute;
  left: 50%; top: 50%; width: 30vmax; height: 30vmax; margin: -15vmax 0 0 -15vmax; border-radius: 50%;
  border: 2.5vmax solid var(--portal-tint); opacity: 0.55; box-shadow: 0 0 6vmax var(--portal-tint) inset; }
#hud .wr-portal .wr-portal-rings::after { width: 60vmax; height: 60vmax; margin: -30vmax 0 0 -30vmax; border-width: 1vmax; opacity: 0.35; }
@keyframes wr-portal-rings { from { transform: scale(0.1); } to { transform: scale(2.4); } }`;
      document.head.appendChild(style);
    }
    const el = document.createElement('div');
    el.className = 'wr-portal';
    const rings = document.createElement('div');
    rings.className = 'wr-portal-rings';
    el.appendChild(rings);
    (document.getElementById('hud') || document.body).appendChild(el);
    this._overlay = el;
    return el;
  }

  /** @param {boolean} [full=true] also drop shared geometry and the overlay */
  dispose(full = true) {
    for (const p of this.portals) {
      this.group.remove(p.root);
      for (const m of p.materials) m.dispose();
    }
    this.portals.length = 0;
    if (!full) return;
    if (this._geo) {
      const g = this._geo;
      g.torus.dispose(); g.disc.dispose(); g.column.dispose(); g.pool.dispose(); g.sparkles.dispose();
      for (const k in g.icons) for (const part of g.icons[k]) part.geom.dispose();
      this._geo = null;
    }
    this.scene.remove(this.group);
    this._overlay?.remove();
    this._overlay = null;
  }
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Standalone test: three portals 40 m ahead of the player. */
export function devInstall(game) {
  const portals = new Portals(game);
  const b = game.player.body;
  const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
  const rx = Math.cos(b.heading), rz = -Math.sin(b.heading);
  const defs = [-20, 0, 20].map((o, i) => ({
    x: b.position.x + fx * 40 + rx * o, z: b.position.z + fz * 40 + rz * o,
    heading: b.heading, dest: ['lagoon', 'swell', 'storm'][i],
  }));
  portals.build(defs);
  const update = game.update.bind(game);
  game.update = (dt, rawDt) => {
    update(dt, rawDt);
    portals.update(dt);
    const dest = portals.test(game.player.body);
    if (dest) {
      console.log('[portals] entered', dest);
      portals.transition(async () => { console.log('[portals] swapping world ->', dest); }, dest);
    }
  };
  // Game.js owns game.portals (rebuilt on every world load); keep the dev set separate.
  game.devPortals = portals;
  return portals;
}
