import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { ATMO_COMMON } from '../sky/AtmosphereGLSL.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';

/**
 * Boat wakes: a foam ribbon laid along each stern's path plus one pooled
 * spray system per boat (bow sheets, wave-slap bursts and a planing-hull
 * rooster tail).
 *
 * The ribbon is a strip of N rows. A row is dropped every few tenths of a
 * metre of travel and remembers where the stern was, which way was starboard,
 * how hard the boat was working and how far it had travelled. Each frame the
 * rows are re-widened along the Kelvin half-angle (19.47 deg) from the distance
 * the boat has since covered, snapped onto the sampled sea so the foam rides
 * the waves, and faded over ~4 s. Two draw calls per boat, no per-frame
 * allocation; the CPU cost is ~100 bilinear height lookups per boat.
 *
 * Both shaders write the two MRT outputs. Alpha blending is used so the
 * velocity attachment is lerped toward (camera motion, viewDistance, 1).
 */
const ROWS = 48;                       // stored stern samples
const LIFE = 4.0;                      // seconds a row stays visible
const MIN_SPACING = 0.6;               // metres of travel between rows
const KELVIN = Math.tan(19.47 * Math.PI / 180);
const SPRAY_MAX = 360;                 // pooled sprites per boat
const G = 9.81;
const ROOSTER_KMH = 40;
const SURF_LIFT = 0.10;                // ribbon sits this far above the sampled sea
const SKIRT_SEG = 24;                  // outline samples around the hull
const SKIRT_RINGS = 3;                 // under the hull, on the outline, outer edge
const SKIRT_LIFT = 0.10;               // skirt sits this far above the sampled sea at Hs 0 (+0.09 m per metre of Hs)
const SKIRT_V = [0, 0.4, 1];           // across-coordinate of each ring for the shader

// ------------------------------------------------------------------ shaders
// Lighting is evaluated per vertex: the sun transmittance LUT and the nine-tap
// sky irradiance probe are far too expensive to run per foam pixel, and a
// ribbon row or a spray sprite is small enough that the vertex value is exact.
const LIGHT_GLSL = /* glsl */ `
uniform sampler2D uTransmittanceLUT;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform sampler2D uEnvMap;
uniform float uEnvMaxLod;
/** Radiance of sunlit white water at sea level. */
vec3 foamRadiance(out vec3 skyAmb){
  vec3 tluPos = vec3(0.0, groundRadiusMM + 0.2 * 1e-6, 0.0);
  vec3 sunTrans = getValFromTLUT(uTransmittanceLUT, tluPos, uSunDir);
  vec3 sun = uSunColor * sunTrans * uSunIntensity;
  skyAmb = skyIrradiance(uEnvMap, uEnvMaxLod);
  // Same mat the sea uses for its whitecaps (OceanMesh foam mat), evaluated
  // for an upward-facing raft, so the wake matches the breakers around it in
  // every weather instead of reading as a differently lit sticker.
  vec3 foamAlbedo = vec3(0.93, 0.96, 0.985);
  float wrapNoL = clamp((uSunDir.y + 0.45) / 1.45, 0.0, 1.0);
  vec3 c = foamAlbedo * (sun * wrapNoL * 0.30 + skyAmb * 0.95);
  // fresh aerated water is brighter than a windrow: never let it drop under
  // roughly 2.6x the sky ambient on a grey day (luminance only, so a low sun
  // keeps its warm tint instead of turning the foam lavender)
  float floorLum = luminance(skyAmb) * 2.6;
  return c * max(1.0, floorLum / max(luminance(c), 1e-3));
}
`;

const HAZE_GLSL = /* glsl */ `
uniform float uFogDensity;
uniform vec3 uCamPos;
vec3 applyHaze(vec3 color, vec3 skyAmb, float dist){
  float fog = 1.0 - exp(-dist * uFogDensity * 0.0025);
  return mix(color, skyAmb * 2.2, fog * 0.8);
}
`;

const RIBBON_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
${ATMO_COMMON}
${SHADING_GLSL}
${LIGHT_GLSL}
in vec3 position;
in vec4 aData;        // u (-1..1 across), age01, strength, w0/halfWidth
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 uViewProjNJ;
uniform mat4 uPrevViewProjNJ;
out vec3 vWorld;
out vec4 vData;
out vec3 vWhite;
out vec3 vSkyAmb;
out vec4 vClipNJ;
out vec4 vPrevClipNJ;
void main(){
  vWorld = position;
  vData = aData;
  vWhite = foamRadiance(vSkyAmb);
  vec4 wp = vec4(position, 1.0);
  vClipNJ = uViewProjNJ * wp;
  vPrevClipNJ = uPrevViewProjNJ * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const RIBBON_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
${HAZE_GLSL}
uniform sampler2D uFoamTex;
uniform float uTime;
in vec3 vWorld;
in vec4 vData;
in vec3 vWhite;
in vec3 vSkyAmb;
in vec4 vClipNJ;
in vec4 vPrevClipNJ;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main(){
  float u = abs(vData.x);
  float age = vData.y;
  float strength = vData.z;
  float core = vData.w;              // fraction of the half-width the hull churn occupies
  float ageFade = 1.0 - age;

  // Kelvin arms: two diverging foam lines near the strip edges; they lose
  // their foam within a couple of seconds while the hull churn lingers.
  float arms = smoothstep(0.64, 0.82, u) * (1.0 - smoothstep(0.90, 1.0, u)) * pow(ageFade, 2.2) * 0.95;
  // Hull churn: the aerated stripe behind the transom, hull-wide.
  float churn = (1.0 - smoothstep(core * 0.55, core * 1.25, u)) * pow(ageFade, 0.7);
  // Fresh sheet between them right behind the boat so the V has a root.
  float sheet = (1.0 - smoothstep(0.0, 0.9, u)) * 0.2 * pow(ageFade, 3.0);
  float density = (churn + arms + sheet) * strength;
  // most of the strip between the arms is open water: leave before the texture taps
  if (density < 0.19) discard;

  // Foam texture in world space so it stays put while the boat moves on.
  vec4 fx = texture(uFoamTex, vWorld.xz * 0.16 + vec2(uTime * 0.004, -uTime * 0.003));
  vec4 fx2 = texture(uFoamTex, vWorld.xz * 0.55 - vec2(uTime * 0.012, uTime * 0.009));
  float clusters = fx.r * 0.6 + fx2.r * 0.4;
  float bubbles = fx2.g * 0.6 + fx.g * 0.4;
  float dissolve = fx.a * 0.6 + fx2.a * 0.4;

  // Same recipe as the sea's own whitecaps: the deposited density is carved by
  // the raft texture and the survival threshold rises with age, so old foam
  // breaks into scattered rafts rather than fading as a flat sheet.
  float noise = smoothstep(0.22, 0.80, dissolve * 0.5 + clusters * 0.5);
  float carved = density * (0.25 + noise * 1.15);
  float onset = 0.26 + age * 0.40;
  float foam = smoothstep(onset, onset + 0.30, carved);
  // bubble rafts: the fine texture breaks the churn into froth instead of paint
  foam *= mix(0.35, 1.0, bubbles);
  if (foam < 0.004) discard;

  float dist = length(vWorld - uCamPos);
  // the dense heart of fresh churn is a touch brighter than a thinning raft
  vec3 col = vWhite * (1.0 + 0.3 * churn * ageFade + 0.25 * bubbles);
  col = applyHaze(col, vSkyAmb, dist);

  oColor = vec4(col, clamp(foam, 0.0, 1.0) * 0.96);
  vec2 cur = vClipNJ.xy / max(vClipNJ.w, 1e-6);
  vec2 prv = vPrevClipNJ.xy / max(vPrevClipNJ.w, 1e-6);
  oVelocity = vec4((cur - prv) * 0.5, dist, 1.0);
}
`;

const SPRAY_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
${ATMO_COMMON}
${SHADING_GLSL}
${LIGHT_GLSL}
in vec3 position;
in vec4 aData;        // size (m), age01, seed, kind
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 uViewProjNJ;
uniform mat4 uPrevViewProjNJ;
uniform vec3 uCamPos;
uniform vec2 uResolution;
out vec3 vWorld;
out vec4 vData;
out vec3 vWhite;
out vec3 vSkyAmb;
out vec4 vClipNJ;
out vec4 vPrevClipNJ;
void main(){
  vWorld = position;
  vData = aData;
  vec3 white = foamRadiance(vSkyAmb);
  // Airborne droplets are a forward-scattering mist, not a lit surface: they
  // take the colour of the sky behind them (never darker than it, or a low sun
  // turns them into grey dirt on the glow) and flare when the sun is behind.
  vec3 look = normalize(position - uCamPos);
  vec3 skyDir = vec3(look.x, max(look.y, 0.0) * 0.6 + 0.10, look.z);
  vec3 behind = textureLod(uEnvMap, dirToEquirect(skyDir), uEnvMaxLod * 0.5).rgb;
  float mu = dot(look, uSunDir);
  vec3 tlu = vec3(0.0, groundRadiusMM + 0.2 * 1e-6, 0.0);
  vec3 sun = uSunColor * getValFromTLUT(uTransmittanceLUT, tlu, uSunDir) * uSunIntensity;
  vec3 mist = behind * 1.1 + white * 0.35 + sun * henyeyGreenstein(mu, 0.6) * 0.3;
  vWhite = max(mist, behind * 1.05);
  vec4 wp = vec4(position, 1.0);
  float dist = max(length(uCamPos - position), 0.5);
  // grow a little with age: a sheet of droplets disperses as it flies
  float size = aData.x * (1.0 + aData.y * 0.9);
  float px = size * projectionMatrix[1][1] * uResolution.y * 0.5 / dist;
  // cap in screen terms (40 px at 720p) so close sprites cannot swamp the fill budget
  gl_PointSize = clamp(px, 1.5, 40.0 * uResolution.y / 720.0);
  vClipNJ = uViewProjNJ * wp;
  vPrevClipNJ = uPrevViewProjNJ * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SPRAY_FRAG = /* glsl */ `
precision highp float;
${HAZE_GLSL}
in vec3 vWorld;
in vec4 vData;
in vec3 vWhite;
in vec3 vSkyAmb;
in vec4 vClipNJ;
in vec4 vPrevClipNJ;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  // slightly irregular blob so a cloud of them does not read as bubbles
  float d = length(q + 0.18 * vec2(sin(vData.z * 31.0), cos(vData.z * 17.0)));
  if (d > 1.0) discard;
  float age = vData.y;
  float shape = pow(1.0 - d * d, 1.9);
  float fade = smoothstep(0.0, 0.08, age) * pow(1.0 - age, 1.1);
  float a = shape * fade * mix(0.40, 0.26, vData.w);

  float dist = length(vWorld - uCamPos);
  vec3 col = applyHaze(vWhite, vSkyAmb, dist);

  oColor = vec4(col, clamp(a, 0.0, 1.0));
  vec2 cur = vClipNJ.xy / max(vClipNJ.w, 1e-6);
  vec2 prv = vPrevClipNJ.xy / max(vPrevClipNJ.w, 1e-6);
  oVelocity = vec4((cur - prv) * 0.5, dist, 1.0);
}
`;

// Hull foam skirt: three concentric rings of the hull outline (one tucked
// under the hull, one on the outline, one SKIRT_W outward) laid on the sampled
// sea. It paints over the hard hull/water intersection the way the aerated
// boundary layer around a moving hull does, so a wave face never reads as a
// clean cut through the boat.
const SKIRT_VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
${ATMO_COMMON}
${SHADING_GLSL}
${LIGHT_GLSL}
in vec3 position;
in vec4 aData;        // v (0 inner .. 1 outer edge), around01 (0 bow, 0.5 stern), strength, pulse
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 uViewProjNJ;
uniform mat4 uPrevViewProjNJ;
out vec3 vWorld;
out vec4 vData;
out vec3 vWhite;
out vec3 vSkyAmb;
out vec4 vClipNJ;
out vec4 vPrevClipNJ;
void main(){
  vWorld = position;
  vData = aData;
  vWhite = foamRadiance(vSkyAmb);
  vec4 wp = vec4(position, 1.0);
  vClipNJ = uViewProjNJ * wp;
  vPrevClipNJ = uPrevViewProjNJ * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SKIRT_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
${HAZE_GLSL}
uniform sampler2D uFoamTex;
uniform float uTime;
in vec3 vWorld;
in vec4 vData;
in vec3 vWhite;
in vec3 vSkyAmb;
in vec4 vClipNJ;
in vec4 vPrevClipNJ;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main(){
  float v = vData.x;
  float strength = vData.z;
  float pulse = vData.w;
  float around = cos(vData.y * 6.2831853);      // 1 at the stem, -1 at the transom
  // Solid where it tucks under the hull, dissolving outward. The bow quarter
  // throws the most water at speed; the transom churn is always there.
  float body = 1.0 - smoothstep(0.40, 1.0, v);
  float bow = smoothstep(0.2, 1.0, around) * (0.08 + 0.30 * strength);
  float stern = smoothstep(0.3, 1.0, -around) * (0.10 + 0.20 * strength);
  float density = body * (0.28 + 0.60 * strength + bow + stern + pulse * 0.6);
  if (density < 0.08) discard;

  // World-space taps: the foam stays in the water and streams aft as the hull
  // drives through it, and the transom end joins the wake ribbon seamlessly.
  vec4 fx = texture(uFoamTex, vWorld.xz * 0.30 + vec2(uTime * 0.02, -uTime * 0.015));
  vec4 fx2 = texture(uFoamTex, vWorld.xz * 0.95 - vec2(uTime * 0.05, uTime * 0.035));
  float clusters = fx.r * 0.55 + fx2.r * 0.45;
  float bubbles = fx2.g * 0.6 + fx.g * 0.4;
  float dissolve = fx.a * 0.5 + fx2.a * 0.5;

  float noise = smoothstep(0.14, 0.78, dissolve * 0.5 + clusters * 0.5);
  // Carve hard: the raft texture must open holes through the sheet or the
  // skirt reads as a white cut-out around the hull instead of froth on water.
  float carved = density * (0.18 + noise * 1.25);
  // survival threshold rises outward: a ragged, lacy outer edge instead of a ring
  float onset = 0.24 + v * 0.42;
  float foam = smoothstep(onset, onset + 0.30, carved);
  foam *= mix(0.30, 1.0, bubbles);
  // wet edge: a thin aerated veil hugging the hull that never fully clears,
  // broken up by the fine texture so it is froth rather than a painted line
  float veil = (1.0 - smoothstep(0.22, 0.60, v)) * (0.20 + 0.35 * strength) * (0.35 + 0.65 * noise);
  float a = max(foam, veil);
  if (a < 0.004) discard;

  float dist = length(vWorld - uCamPos);
  vec3 col = vWhite * (1.0 + 0.25 * bubbles + 0.25 * pulse + 0.15 * bow);
  col = applyHaze(col, vSkyAmb, dist);

  oColor = vec4(col, clamp(a, 0.0, 1.0) * 0.86);
  vec2 cur = vClipNJ.xy / max(vClipNJ.w, 1e-6);
  vec2 prv = vPrevClipNJ.xy / max(vPrevClipNJ.w, 1e-6);
  oVelocity = vec4((cur - prv) * 0.5, dist, 1.0);
}
`;

const SHARED_KEYS = ['uTime', 'uCamPos', 'uResolution', 'uViewProjNJ', 'uPrevViewProjNJ', 'uSunDir', 'uSunColor',
  'uSunIntensity', 'uEnvMap', 'uEnvMaxLod', 'uFogDensity', 'uFoamTex', 'uAtmoTurbidity', 'uAtmoMieG', 'uAtmoGroundAlbedo'];

/** Shared by ShoreFoam.js so every foam surface in the game is lit the same way. */
export const FOAM_LIGHT_GLSL = LIGHT_GLSL;
export const FOAM_HAZE_GLSL = HAZE_GLSL;
export { makeMaterial as makeFoamMaterial };

function makeMaterial(name, vert, frag, atmosphere) {
  const uniforms = {};
  atmosphere?.bind(uniforms);
  for (const k of SHARED_KEYS) uniforms[k] = U[k];
  return new THREE.RawShaderMaterial({
    name, glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag, uniforms,
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending, side: THREE.DoubleSide,
  });
}

// -------------------------------------------------------------------- wake
const _f = new THREE.Vector3(), _r = new THREE.Vector3(), _s = new THREE.Vector3(), _v = new THREE.Vector3();

class BoatWake {
  constructor(boat, wake) {
    this.boat = boat;
    this.body = boat.body;
    this.sea = wake.sea;
    const hull = this.body.hull;
    this.w0 = hull.width * 0.55;
    this.planing = (hull.planing ?? 0) >= 0.8;

    // ---- ribbon rows (ring buffer, oldest first)
    this.rows = ROWS;
    this.rx = new Float32Array(ROWS); this.rz = new Float32Array(ROWS);
    this.rrx = new Float32Array(ROWS); this.rrz = new Float32Array(ROWS);
    this.rdist = new Float32Array(ROWS); this.rtime = new Float32Array(ROWS); this.rstr = new Float32Array(ROWS);
    this.head = 0; this.count = 0;
    this.dist = 0; this.lastLay = -1e9; this.time = 0;

    const verts = (ROWS + 1) * 3;
    const rg = new THREE.BufferGeometry();
    this.rPos = new THREE.BufferAttribute(new Float32Array(verts * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.rData = new THREE.BufferAttribute(new Float32Array(verts * 4), 4).setUsage(THREE.DynamicDrawUsage);
    rg.setAttribute('position', this.rPos);
    rg.setAttribute('aData', this.rData);
    // three vertices per row (port, centre, starboard) so the churn stripe in
    // the middle of a wide row still rides the sea instead of a chord under it
    const idx = new Uint16Array(ROWS * 12);
    for (let i = 0; i < ROWS; i++) {
      const a = i * 3, o = i * 12;
      idx[o] = a; idx[o + 1] = a + 3; idx[o + 2] = a + 1; idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 4;
      idx[o + 6] = a + 1; idx[o + 7] = a + 4; idx[o + 8] = a + 2; idx[o + 9] = a + 2; idx[o + 10] = a + 4; idx[o + 11] = a + 5;
    }
    rg.setIndex(new THREE.BufferAttribute(idx, 1));
    rg.setDrawRange(0, 0);
    rg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.ribbon = new THREE.Mesh(rg, wake.ribbonMaterial);
    this.ribbon.frustumCulled = false;
    this.ribbon.renderOrder = 1;

    // ---- spray pool
    this.px = new Float32Array(SPRAY_MAX); this.py = new Float32Array(SPRAY_MAX); this.pz = new Float32Array(SPRAY_MAX);
    this.vx = new Float32Array(SPRAY_MAX); this.vy = new Float32Array(SPRAY_MAX); this.vz = new Float32Array(SPRAY_MAX);
    this.age = new Float32Array(SPRAY_MAX); this.life = new Float32Array(SPRAY_MAX);
    this.size = new Float32Array(SPRAY_MAX); this.seed = new Float32Array(SPRAY_MAX); this.kind = new Float32Array(SPRAY_MAX);
    this.alive = new Uint8Array(SPRAY_MAX);
    this.free = new Int32Array(SPRAY_MAX);
    for (let i = 0; i < SPRAY_MAX; i++) this.free[i] = SPRAY_MAX - 1 - i;
    this.freeCount = SPRAY_MAX;
    this.emitAcc = 0; this.roosterAcc = 0; this.prevSlap = 0;

    const sg = new THREE.BufferGeometry();
    this.sPos = new THREE.BufferAttribute(new Float32Array(SPRAY_MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.sData = new THREE.BufferAttribute(new Float32Array(SPRAY_MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    sg.setAttribute('position', this.sPos);
    sg.setAttribute('aData', this.sData);
    sg.setDrawRange(0, 0);
    sg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.spray = new THREE.Points(sg, wake.sprayMaterial);
    this.spray.frustumCulled = false;
    this.spray.renderOrder = 2;

    // ---- hull foam skirt: a static outline in hull space, re-laid on the sea each frame
    // Superellipse outline: pointier forward (n = 1.6) than aft (n = 3.0) so
    // the ring reads as a boat, not a pill. (lx, lz) is the waterline point,
    // (nx, nz) its outward direction in hull space (+z forward, +x starboard).
    this.oLx = new Float32Array(SKIRT_SEG); this.oLz = new Float32Array(SKIRT_SEG);
    this.oNx = new Float32Array(SKIRT_SEG); this.oNz = new Float32Array(SKIRT_SEG);
    const halfW = hull.width * 0.5, halfL = hull.length * 0.5;
    for (let s = 0; s < SKIRT_SEG; s++) {
      const th = (s / SKIRT_SEG) * Math.PI * 2, c = Math.cos(th), sn = Math.sin(th);
      const n = c > 0 ? 1.6 : 3.0, e = 2 / n;
      const lx = halfW * Math.sign(sn) * Math.pow(Math.abs(sn), e);
      const lz = halfL * Math.sign(c) * Math.pow(Math.abs(c), e);
      let nx = lx / (halfW * halfW), nz = lz / (halfL * halfL);
      const len = Math.hypot(nx, nz) || 1; nx /= len; nz /= len;
      this.oLx[s] = lx; this.oLz[s] = lz; this.oNx[s] = nx; this.oNz[s] = nz;
    }
    this.skirtBase = 0.40 + 0.30 * hull.width;   // metres outward at rest
    this.skirtStr = 0; this.pulse = 0; this.chineAcc = 0;

    const kg = new THREE.BufferGeometry();
    const kv = SKIRT_SEG * SKIRT_RINGS;
    this.kPos = new THREE.BufferAttribute(new Float32Array(kv * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.kData = new THREE.BufferAttribute(new Float32Array(kv * 4), 4).setUsage(THREE.DynamicDrawUsage);
    kg.setAttribute('position', this.kPos);
    kg.setAttribute('aData', this.kData);
    const kidx = new Uint16Array(SKIRT_SEG * (SKIRT_RINGS - 1) * 6);
    let o = 0;
    for (let r = 0; r < SKIRT_RINGS - 1; r++) {
      for (let s = 0; s < SKIRT_SEG; s++) {
        const s1 = (s + 1) % SKIRT_SEG;
        const a = r * SKIRT_SEG + s, b = r * SKIRT_SEG + s1, c = (r + 1) * SKIRT_SEG + s, d = (r + 1) * SKIRT_SEG + s1;
        kidx[o++] = a; kidx[o++] = c; kidx[o++] = b; kidx[o++] = b; kidx[o++] = c; kidx[o++] = d;
      }
    }
    kg.setIndex(new THREE.BufferAttribute(kidx, 1));
    kg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.skirt = new THREE.Mesh(kg, wake.skirtMaterial);
    this.skirt.frustumCulled = false;
    this.skirt.renderOrder = 1.5;        // after the ribbon it grows out of, before the airborne spray
  }

  _lay(x, z, rxv, rzv, strength) {
    const i = (this.head + this.count) % ROWS;
    if (this.count === ROWS) this.head = (this.head + 1) % ROWS; else this.count++;
    this.rx[i] = x; this.rz[i] = z; this.rrx[i] = rxv; this.rrz[i] = rzv;
    this.rdist[i] = this.dist; this.rtime[i] = this.time; this.rstr[i] = strength;
  }

  update(dt) {
    const b = this.body, hull = b.hull;
    this.time += dt;
    const speed = b.speed;
    this.dist += speed * dt;
    _f.copy(b.forward); _f.y = 0; if (_f.lengthSq() < 1e-6) _f.set(0, 0, 1); _f.normalize();
    _r.set(_f.z, 0, -_f.x);            // starboard
    // stern on the waterline
    _s.copy(b.position).addScaledVector(_f, -hull.length * 0.5);

    // ---- lay a new row every MIN_SPACING m, coarser at speed so 48 rows span LIFE seconds
    const spacing = Math.max(MIN_SPACING, speed * LIFE / ROWS);
    const strength = THREE.MathUtils.clamp(b.wakeStrength * 1.6 + THREE.MathUtils.smoothstep(speed, 0.8, 4) * 0.35, 0, 1) * (b.submersion > 0 ? 1 : 0);
    if (this.dist - this.lastLay >= spacing && speed > 0.6 && strength > 0.03) {
      this._lay(_s.x, _s.z, _r.x, _r.z, strength);
      this.lastLay = this.dist;
    }
    // drop rows that have faded or fallen off the sea probe's grid (its arms would sample the flat fallback)
    while (this.count > 0 && (this.time - this.rtime[this.head] >= LIFE || this.dist - this.rdist[this.head] > 90)) { this.head = (this.head + 1) % ROWS; this.count--; }

    // ---- rebuild ribbon vertices: stored rows oldest -> newest, then the live stern
    const P = this.rPos.array, D = this.rData.array;
    let v = 0;
    const sea = this.sea;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head + k) % ROWS;
      const age = (this.time - this.rtime[i]) / LIFE;
      const behind = this.dist - this.rdist[i];
      const half = this.w0 + behind * KELVIN;
      const core = Math.min(1, this.w0 * 1.25 / half);
      const cx = this.rx[i], cz = this.rz[i], ex = this.rrx[i] * half, ez = this.rrz[i] * half;
      for (let side = -1; side <= 1; side++) {
        const x = cx + ex * side, z = cz + ez * side;
        P[v * 3] = x; P[v * 3 + 1] = sea.heightAt(x, z) + SURF_LIFT; P[v * 3 + 2] = z;
        D[v * 4] = side; D[v * 4 + 1] = age; D[v * 4 + 2] = this.rstr[i]; D[v * 4 + 3] = core; v++;
      }
    }
    if (this.count > 0 && b.submersion > 0) {
      // live head at the transom so the wake is glued to the hull; while the
      // hull is airborne the ribbon ends at the last row it laid in the water
      for (let side = -1; side <= 1; side++) {
        const x = _s.x + _r.x * this.w0 * side, z = _s.z + _r.z * this.w0 * side;
        P[v * 3] = x; P[v * 3 + 1] = sea.heightAt(x, z) + SURF_LIFT; P[v * 3 + 2] = z;
        D[v * 4] = side; D[v * 4 + 1] = 0; D[v * 4 + 2] = strength; D[v * 4 + 3] = 1; v++;
      }
    }
    const rows = v / 3;
    this.ribbon.geometry.setDrawRange(0, Math.max(0, rows - 1) * 12);
    this.ribbon.visible = rows > 1;
    if (rows > 1) {
      this.rPos.needsUpdate = true; this.rData.needsUpdate = true;
      this.rPos.updateRanges.length = 0; this.rData.updateRanges.length = 0;
      this.rPos.addUpdateRange(0, v * 3); this.rData.addUpdateRange(0, v * 4);
    }

    // ---- hull foam skirt
    // strength eases in and out so a hull skipping off a crest does not flicker
    const wet = b.submersion > 0 ? 1 : 0;
    const strTarget = wet * THREE.MathUtils.clamp(0.22 + b.wakeStrength * 0.9 + THREE.MathUtils.smoothstep(speed, 1, 9) * 0.5, 0, 1);
    this.skirtStr += (strTarget - this.skirtStr) * Math.min(1, dt * (strTarget < this.skirtStr ? 5 : 8));
    this.pulse = Math.max(this.pulse * Math.exp(-dt * 3), b.slapImpulse);
    const kStr = this.skirtStr, kPulse = Math.min(1, this.pulse);
    this.skirt.visible = kStr > 0.02;
    if (this.skirt.visible) {
      const KP = this.kPos.array, KD = this.kData.array;
      const outer = this.skirtBase * (0.7 + 0.55 * kStr + 0.8 * kPulse);
      // The probe grid smooths the short cascades, so in a big sea the drawn
      // surface stands above the sampled one: lift the skirt with Hs or it z-fails.
      const lift = Math.min(0.45, SKIRT_LIFT + 0.09 * (this.hs || 0));
      // planing bow rides clear of the water: pull the forward part of the ring aft with pitch
      const bowUp = THREE.MathUtils.clamp(b.forward.y, 0, 0.4);
      const px = b.position.x, pz = b.position.z;
      let k = 0;
      for (let r = 0; r < SKIRT_RINGS; r++) {
        const vv = SKIRT_V[r];
        // ring 0 is tucked under the hull so the paint straddles the intersection line
        const scale = r === 0 ? 0.68 : 1.02;
        const out = r === SKIRT_RINGS - 1 ? outer : 0;
        for (let s = 0; s < SKIRT_SEG; s++) {
          let lz = this.oLz[s] * scale + this.oNz[s] * out;
          const lx = this.oLx[s] * scale + this.oNx[s] * out;
          if (lz > 0) lz *= 1 - bowUp * 0.9;
          const x = px + _r.x * lx + _f.x * lz, z = pz + _r.z * lx + _f.z * lz;
          KP[k * 3] = x; KP[k * 3 + 1] = sea.heightAt(x, z) + lift; KP[k * 3 + 2] = z;
          KD[k * 4] = vv; KD[k * 4 + 1] = s / SKIRT_SEG; KD[k * 4 + 2] = kStr; KD[k * 4 + 3] = kPulse;
          k++;
        }
      }
      this.kPos.needsUpdate = true; this.kData.needsUpdate = true;
    }

    // ---- spray emission
    const kmh = b.speedKmh;
    const bowRate = 75 * THREE.MathUtils.smoothstep(speed, 3, 13) * (0.5 + 0.5 * b.wakeStrength) * wet;
    this.emitAcc += bowRate * dt;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      // a sheet peels off the chine from the stem back to midships
      for (let side = -1; side <= 1; side += 2) this._emitBow(side, speed, hull, 0.0, Math.random() * 0.8);
    }
    // low, wide sheets skimming off both chines: these wrap the hull edges in white at speed
    this.chineAcc += 80 * THREE.MathUtils.smoothstep(speed, 3.5, 14) * (0.6 + 0.4 * b.wakeStrength) * wet * dt;
    while (this.chineAcc >= 1) {
      this.chineAcc -= 1;
      for (let side = -1; side <= 1; side += 2) this._emitChine(side, speed, hull);
    }
    if (this.planing && kmh > ROOSTER_KMH && b.submersion > 0) {
      this.roosterAcc += 45 * THREE.MathUtils.smoothstep(kmh, ROOSTER_KMH, ROOSTER_KMH + 35) * dt;
      while (this.roosterAcc >= 1) { this.roosterAcc -= 1; this._emitRooster(speed, hull); }
    }
    if (b.slapImpulse > this.prevSlap + 0.15) {
      const n = Math.min(60, Math.round(28 * b.slapImpulse + 10));
      for (let i = 0; i < n; i++) this._emitBow(i & 1 ? 1 : -1, Math.max(speed, 4), hull, 1.0, (i / n) * 1.6 - 0.8);
    }
    this.prevSlap = b.slapImpulse;

    // ---- spray integrate + pack
    const SP = this.sPos.array, SD = this.sData.array;
    let n = 0;
    const drag = Math.exp(-dt * 0.9);
    for (let i = 0; i < SPRAY_MAX; i++) {
      if (!this.alive[i]) continue;
      const age = (this.age[i] += dt);
      if (age >= this.life[i]) { this.alive[i] = 0; this.free[this.freeCount++] = i; continue; }
      this.vy[i] -= G * dt;
      this.vx[i] *= drag; this.vz[i] *= drag;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      SP[n * 3] = this.px[i]; SP[n * 3 + 1] = this.py[i]; SP[n * 3 + 2] = this.pz[i];
      SD[n * 4] = this.size[i]; SD[n * 4 + 1] = age / this.life[i]; SD[n * 4 + 2] = this.seed[i]; SD[n * 4 + 3] = this.kind[i];
      n++;
    }
    this.spray.geometry.setDrawRange(0, n);
    this.spray.visible = n > 0;
    if (n > 0) {
      this.sPos.needsUpdate = true; this.sData.needsUpdate = true;
      this.sPos.updateRanges.length = 0; this.sData.updateRanges.length = 0;
      this.sPos.addUpdateRange(0, n * 3); this.sData.addUpdateRange(0, n * 4);
    }
  }

  _spawn(x, y, z, vx, vy, vz, life, size, kind) {
    if (this.freeCount === 0) return;
    const i = this.free[--this.freeCount];
    this.alive[i] = 1;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life; this.size[i] = size; this.seed[i] = Math.random(); this.kind[i] = kind;
  }

  /**
   * Spray peeling off one side of the hull. `along` (0 = stem, 1 = stern)
   * slides the emitter down the chine; the sheet is thrown highest at the stem.
   */
  _emitBow(side, speed, hull, kind, along = 0) {
    const b = this.body;
    const L = hull.length, W = hull.width;
    const a = THREE.MathUtils.clamp(along, -0.5, 1);
    const fwd = L * (0.42 - a * 0.9);
    const beam = W * (a < 0.15 ? 0.25 + a * 1.2 : 0.43);
    _v.copy(b.position).addScaledVector(_f, fwd).addScaledVector(_r, side * beam);
    _v.y = this.sea.heightAt(_v.x, _v.z) + 0.05;
    const r1 = Math.random(), r2 = Math.random(), r3 = Math.random();
    const stem = 1.0 - Math.max(a, 0) * 0.6;
    const out = (1.4 + speed * 0.17) * (0.6 + r1 * 0.8) * (1 + kind * 0.8);
    const up = (1.2 + speed * 0.16) * (0.5 + r2 * 0.9) * stem * (1 + kind * 1.2);
    const along_ = speed * (0.5 + r3 * 0.25) * (1 - kind * 0.3);
    this._spawn(_v.x, _v.y, _v.z,
      _f.x * along_ + _r.x * side * out + (r2 - 0.5) * 0.8,
      up,
      _f.z * along_ + _r.z * side * out + (r1 - 0.5) * 0.8,
      0.5 + r3 * 0.5 + kind * 0.3, (0.34 + r1 * 0.42) * (1 + kind * 0.6) * Math.sqrt(W / 2.3), kind);
  }

  /**
   * Chine spray: a flat sheet skimming sideways off the hull between the stem
   * and midships. Low and short-lived, so it stays glued to the waterline and
   * broadens the hull's white edge rather than flying.
   */
  _emitChine(side, speed, hull) {
    const b = this.body;
    const L = hull.length, W = hull.width;
    const r1 = Math.random(), r2 = Math.random(), r3 = Math.random();
    const a = 0.05 + r3 * 0.55;                         // 0 = stem .. 1 = stern
    const fwd = L * (0.42 - a * 0.9);
    const beam = W * (a < 0.15 ? 0.30 + a * 1.0 : 0.46);
    _v.copy(b.position).addScaledVector(_f, fwd).addScaledVector(_r, side * beam);
    _v.y = this.sea.heightAt(_v.x, _v.z) + 0.03;
    const out = (0.9 + speed * 0.11) * (0.6 + r1 * 0.7);
    const up = (0.35 + speed * 0.045) * (0.4 + r2 * 0.8);
    const along = speed * (0.55 + r2 * 0.2);
    this._spawn(_v.x, _v.y, _v.z,
      _f.x * along + _r.x * side * out + (r2 - 0.5) * 0.5,
      up,
      _f.z * along + _r.z * side * out + (r1 - 0.5) * 0.5,
      0.28 + r3 * 0.30, (0.28 + r1 * 0.34) * Math.sqrt(W / 2.3), 0.5);
  }

  /** Rooster tail: a narrow column thrown up behind the transom by the drive. */
  _emitRooster(speed, hull) {
    const b = this.body;
    _v.copy(b.position).addScaledVector(_f, -hull.length * 0.52);
    _v.y = this.sea.heightAt(_v.x, _v.z) + 0.1;
    const r1 = Math.random(), r2 = Math.random(), r3 = Math.random();
    const along = speed * (0.30 + r1 * 0.2);
    const up = 3.0 + speed * 0.20 * (0.5 + r2);
    const side = (r3 - 0.5) * 1.6;
    this._spawn(_v.x, _v.y, _v.z,
      _f.x * along + _r.x * side, up, _f.z * along + _r.z * side,
      0.6 + r2 * 0.4, 0.3 + r1 * 0.35, 1.0);
  }

  dispose() {
    this.ribbon.geometry.dispose();
    this.spray.geometry.dispose();
    this.skirt.geometry.dispose();
  }
}

export class Wake {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;
    this.sea = game.sea;
    this.wakes = new Map();
    this.ribbonMaterial = makeMaterial('WakeRibbon', RIBBON_VERT, RIBBON_FRAG, game.app.atmosphere);
    this.sprayMaterial = makeMaterial('WakeSpray', SPRAY_VERT, SPRAY_FRAG, game.app.atmosphere);
    this.sprayMaterial.side = THREE.FrontSide;
    this.skirtMaterial = makeMaterial('WakeSkirt', SKIRT_VERT, SKIRT_FRAG, game.app.atmosphere);
  }

  /** @param {{ body: import('./BoatPhysics.js').BoatPhysics, group: THREE.Group }} boat */
  attach(boat) {
    if (!boat?.body || this.wakes.has(boat)) return;
    const w = new BoatWake(boat, this);
    this.scene.add(w.ribbon, w.spray, w.skirt);
    this.wakes.set(boat, w);
  }

  detach(boat) {
    const w = this.wakes.get(boat);
    if (!w) return;
    this.scene.remove(w.ribbon, w.spray, w.skirt);
    w.dispose();
    this.wakes.delete(boat);
  }

  update(dt) {
    if (dt <= 0) return;
    const hs = this.game.app.ocean?.significantWaveHeight || 0;
    for (const w of this.wakes.values()) { w.hs = hs; w.update(dt); }
  }

  dispose() {
    for (const boat of [...this.wakes.keys()]) this.detach(boat);
    this.ribbonMaterial.dispose();
    this.sprayMaterial.dispose();
    this.skirtMaterial.dispose();
  }
}

/** Standalone test: wake on the player's boat. */
export function devInstall(game) {
  if (game.wake) { game.wake.attach(game.player); return game.wake; }
  const wake = new Wake(game);
  wake.attach(game.player);
  const update = game.update.bind(game);
  game.update = (dt, rawDt) => { update(dt, rawDt); wake.update(dt); };
  game.devWake = wake;
  return wake;
}
