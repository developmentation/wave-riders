import * as THREE from 'three';
import { U } from '../core/SharedUniforms.js';
import { ATMO_COMMON } from '../sky/AtmosphereGLSL.js';
import { AERIAL_GLSL } from '../sky/Atmosphere.js';
import { SHADING_GLSL } from '../gfx/ShadingGLSL.js';

/**
 * Lit material for boats, islands, gates and portals inside the ocean's HDR
 * pipeline.
 *
 * The main pass renders into a two-attachment target: colour plus a
 * (velocity.xy, viewDistance, 1) buffer that TAA, depth of field and the
 * waterline compositor all read. Stock three.js materials write only the
 * first, which leaves garbage in the second and smears every prop. So props
 * take the same sun (through the atmospheric transmittance LUT), the same sky
 * irradiance probe and the same aerial perspective the sea uses, and write
 * both outputs. Exposure is handled by the post stack, so radiances here are
 * in the scene's physical scale.
 */
const VERT = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position;
in vec3 normal;
in vec2 uv;
#ifdef USE_VCOLOR
in vec3 color;
#endif
uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 uPrevModelMatrix;
uniform mat4 uViewProjNJ;
uniform mat4 uPrevViewProjNJ;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uWave;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vUv;
out vec3 vColor;
out vec4 vClipNJ;
out vec4 vPrevClipNJ;
void main(){
  vec3 p = position;
  #ifdef FLAG_WAVE
  // Cloth flutter for flags and sails: only vertices flagged by uv.y.
  p.x += sin(uTime * 6.0 + position.z * 3.0 + position.y * 2.0) * 0.08 * uWave * uv.y;
  #endif
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vec4 pwp = uPrevModelMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vUv = uv;
  #ifdef USE_VCOLOR
  vColor = color;
  #else
  vColor = vec3(1.0);
  #endif
  vClipNJ = uViewProjNJ * wp;
  vPrevClipNJ = uPrevViewProjNJ * pwp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
${ATMO_COMMON}
${SHADING_GLSL}
${AERIAL_GLSL}
uniform sampler2D uTransmittanceLUT;
uniform vec3 uCamPos;
uniform vec2 uResolution;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform sampler2D uEnvMap;
uniform float uEnvMaxLod;
uniform sampler2D uMap;
uniform float uHasMap;
uniform vec3 uColor;
uniform vec3 uEmissive;
uniform float uRoughness;
uniform float uMetal;
uniform float uOpacity;
uniform vec4 uLightning0, uLightning1;
uniform vec3 uLightningColor;
uniform float uAmbientFlash;
uniform float uFogDensity;
uniform float uSeaLevel;
in vec3 vWorld;
in vec3 vNormal;
in vec2 vUv;
in vec3 vColor;
in vec4 vClipNJ;
in vec4 vPrevClipNJ;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main(){
  vec3 albedo = uColor * vColor;
  if (uHasMap > 0.5) {
    vec4 t = texture(uMap, vUv);
    albedo *= t.rgb;
    if (t.a < 0.4) discard;
  }
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  if (dot(N, V) < 0.0) N = -N;
  vec3 L = normalize(uSunDir);
  float NoL = max(dot(N, L), 0.0);
  float NoV = max(dot(N, V), 1e-4);

  vec3 tluPos = vec3(0.0, groundRadiusMM + max(uCamPos.y, 0.2) * 1e-6, 0.0);
  vec3 sunTrans = getValFromTLUT(uTransmittanceLUT, tluPos, uSunDir);
  vec3 sun = uSunColor * sunTrans * uSunIntensity;
  vec3 skyAmb = skyIrradiance(uEnvMap, uEnvMaxLod);
  // Hulls near the water pick up a little bounce from the sea below.
  float below = clamp(1.0 - N.y, 0.0, 1.0);
  vec3 ambient = skyAmb * mix(1.0, 0.55, below);

  // Wrap the diffuse a touch so the shadow side of a toy boat is never black.
  float wrap = (dot(N, L) + 0.25) / 1.25;
  vec3 diffuse = albedo * (sun * max(wrap, 0.0) / PI_S * (1.0 - uMetal) + ambient * (1.0 - uMetal * 0.7));

  vec3 H = normalize(L + V);
  float NoH = max(dot(N, H), 0.0);
  float a = max(uRoughness * uRoughness, 0.02);
  float f0 = mix(0.04, 0.9, uMetal);
  float D = ggxD(NoH, a);
  float Vis = smithGGXCorrelated(NoV, max(NoL, 1e-3), a);
  float F = schlick(max(dot(H, V), 0.0), f0);
  vec3 spec = sun * D * Vis * F * NoL;
  // sky reflection
  vec3 R = reflect(-V, N);
  float envLod = uRoughness * uEnvMaxLod;
  vec3 env = textureLod(uEnvMap, dirToEquirect(R), envLod).rgb;
  float Fenv = schlick(NoV, f0) * (1.0 - uRoughness * 0.6);
  spec += env * Fenv * mix(vec3(1.0), albedo, uMetal);

  vec3 color = diffuse + spec + uEmissive;
  color += lightningContribution(vWorld, N, V, uLightning0, uLightning1, uLightningColor) * 0.6;
  color += uAmbientFlash * uLightningColor * 0.02 * albedo;

  float dist = length(vWorld - uCamPos);
  vec2 screenUv = gl_FragCoord.xy / uResolution;
  vec4 ap = sampleAerial(screenUv, dist);
  vec3 tr = pow(vec3(clamp(ap.a, 0.0, 1.0)), vec3(1.0, 1.06, 1.16));
  color = color * tr + ap.rgb * uSunIntensity;
  // Storm haze
  float fog = 1.0 - exp(-dist * uFogDensity * 0.0025);
  color = mix(color, skyAmb * 2.2, fog * 0.8);

  oColor = vec4(color, uOpacity);
  vec2 cur = vClipNJ.xy / max(vClipNJ.w, 1e-6);
  vec2 prv = vPrevClipNJ.xy / max(vPrevClipNJ.w, 1e-6);
  oVelocity = vec4((cur - prv) * 0.5, dist, 1.0);
}
`;

export class PropMaterial extends THREE.RawShaderMaterial {
  /**
   * @param {object} opts { map, color, emissive, roughness, metal, vertexColors, flagWave, opacity, transparent }
   * @param {import('../sky/Atmosphere.js').Atmosphere} atmosphere
   */
  constructor(opts = {}, atmosphere) {
    const uniforms = {
      uPrevModelMatrix: { value: new THREE.Matrix4() },
      uMap: { value: opts.map || null },
      uHasMap: { value: opts.map ? 1 : 0 },
      uColor: { value: new THREE.Color(opts.color ?? 0xffffff) },
      uEmissive: { value: new THREE.Color(opts.emissive ?? 0x000000) },
      uRoughness: { value: opts.roughness ?? 0.55 },
      uMetal: { value: opts.metal ?? 0.0 },
      uOpacity: { value: opts.opacity ?? 1.0 },
      uWave: { value: opts.flagWave ?? 0 },
    };
    if (atmosphere) atmosphere.bind(uniforms);
    // Shared frame/lighting uniforms win over the private copies bind() created.
    for (const k of ['uTime', 'uCamPos', 'uResolution', 'uViewProjNJ', 'uPrevViewProjNJ', 'uSunDir', 'uSunColor',
      'uSunIntensity', 'uEnvMap', 'uEnvMaxLod', 'uLightning0', 'uLightning1', 'uLightningColor', 'uAmbientFlash',
      'uFogDensity', 'uSeaLevel']) uniforms[k] = U[k];
    super({
      name: 'Prop',
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms,
      defines: { ...(opts.vertexColors ? { USE_VCOLOR: 1 } : {}), ...(opts.flagWave ? { FLAG_WAVE: 1 } : {}) },
      side: opts.side ?? THREE.FrontSide,
      transparent: !!opts.transparent,
      depthWrite: opts.depthWrite ?? true,
      depthTest: true,
    });
  }

  get color() { return this.uniforms.uColor.value; }
  get emissive() { return this.uniforms.uEmissive.value; }
  set map(t) { this.uniforms.uMap.value = t; this.uniforms.uHasMap.value = t ? 1 : 0; }
  get map() { return this.uniforms.uMap.value; }
}

/**
 * Keep per-object previous model matrices so moving props get correct motion
 * vectors. Call once after building a mesh; it hooks onBeforeRender.
 */
export function trackMotion(mesh) {
  mesh.userData.prevMatrix = mesh.matrixWorld.clone();
  mesh.onBeforeRender = function (r, s, c, g, material) {
    const u = material.uniforms?.uPrevModelMatrix;
    if (u) u.value.copy(this.userData.prevMatrix);
  };
  mesh.onAfterRender = function () { this.userData.prevMatrix.copy(this.matrixWorld); };
  return mesh;
}

/**
 * Replace every material in a loaded glTF scene with PropMaterial while keeping
 * its texture and colour, and register motion tracking on each mesh.
 */
export function convertToProps(root, atmosphere, overrides = {}) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    let mat = cache.get(src);
    if (!mat) {
      const map = src.map || null;
      if (map) { map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 4; }
      mat = new PropMaterial({
        map, color: src.color ? src.color.getHex() : 0xffffff,
        roughness: overrides.roughness ?? 0.5, metal: overrides.metal ?? 0.0,
        vertexColors: !!src.vertexColors && !!o.geometry.attributes.color,
      }, atmosphere);
      cache.set(src, mat);
    }
    o.material = mat;
    o.frustumCulled = true;
    trackMotion(o);
  });
  return root;
}
