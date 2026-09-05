import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { U } from '../core/SharedUniforms.js';
import { PropMaterial, trackMotion } from './PropMaterial.js';
import { PALETTE } from './Boats.js';

/**
 * Submarine: a small two-seat kids' sub for "The Deep Run".
 *
 * SubPhysics is a rigid body in the same frame as BoatPhysics (+Z forward,
 * heading = atan2(forward.x, forward.z), so positive steer swings the bow
 * toward -X which is the visual right). The hull is neutrally buoyant when
 * submerged; the `dive` input pumps ballast (net buoyancy ±30 %) and, once the
 * boat has way on, pitches the nose up to ±20° with the stern planes, so the
 * thrust itself carries the sub up or down. At the surface the submerged
 * fraction of the hull is what gives buoyancy, so the hull top stops at the
 * waterline and the sub bobs and drives like a slow boat. The seabed is a
 * heightfield (`groundFn`): contact points are pushed out along the local
 * terrain normal, scraped, and probed one step ahead along the velocity so a
 * canyon wall at full speed is a bump, never a tunnel.
 *
 * buildSubVisual() is a chunky flat-colour toy sub (PropMaterial) with a kid
 * under a glass bubble, spinning prop, tilting planes, two headlight cones and
 * a pooled bubble trail (GLSL3 points writing both HDR outputs).
 */
const G = 9.81;
const DEG = Math.PI / 180;
const _v = new THREE.Vector3(), _p = new THREE.Vector3(), _n = new THREE.Vector3(), _push = new THREE.Vector3();
const _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);

export const SUB_HULL = {
  label: 'Submarine', length: 6.0, width: 2.2, mass: 4000, draft: 0.95, radius: 0.95,
  maxSpeed: 30 / 3.6, surfaceSpeed: 20 / 3.6, thrust: 20000, maxYaw: 0.75, maxPitch: 20 * DEG,
  planing: 0, isSub: true,
};

// Collision probes in hull space: [x, y, z, radius]. The keel of each probe is y - radius.
const PROBES = [[0, 0, 0, 0.95], [0, 0, 2.5, 0.5], [0, 0, -2.5, 0.5], [0.85, 0, 0.3, 0.35], [-0.85, 0, 0.3, 0.35]];
const clamp = THREE.MathUtils.clamp, smooth = THREE.MathUtils.smoothstep;

export class SubPhysics {
  /**
   * @param {object} [opts] { hull, groundFn(x,z) → seabed y, ceilingFn(x,z) → sea surface y }
   */
  constructor(opts = {}) {
    this.hull = opts.hull || SUB_HULL;
    this.isSub = true;
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angular = new THREE.Vector3();     // world-space angular velocity (rad/s)
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    // input
    this.throttle = 0;   // -0.5 .. 1
    this.steer = 0;      // -1 .. 1, + = right
    this.dive = 0;       // -1 .. 1, + = up
    this.boost = 0;      // 0..1
    // derived
    this.heading = 0;
    this.pitch = 0;      // rad, + = nose up
    this.roll = 0;       // rad
    this.depth = 0;      // metres below the surface (>= 0)
    this.submersion = 0; // 0 surfaced .. 1 hull fully under
    this.ballast = 1;    // -1 heavy .. 1 light (tanks blown = floats)
    this.speed = 0;
    this.speedKmh = 0;
    this.surfaceY = 0;
    this.scrape = 0;     // 0..1, terrain contact strength this frame (audio / fx)
    // BoatPhysics-compatible fields read by Game / Wake / Audio
    this.airborne = false;
    this.slapImpulse = 0;
    this.wakeStrength = 0;
    this.beachedTime = 0;
    this.contacts = [];
    this.groundFn = opts.groundFn || null;
    this.ceilingFn = opts.ceilingFn || null;
    this._prevSurface = null;
  }

  setPose(x, y, z, headingRad) {
    this.position.set(x, y, z);
    this.quaternion.setFromAxisAngle(_up, headingRad);
    this.velocity.set(0, 0, 0);
    this.angular.set(0, 0, 0);
    this._syncAxes();
    const s = this._surface(x, z);
    this.surfaceY = s;
    this.depth = Math.max(0, s - y);
    // Near the surface the tanks are blown (floats like a boat); at depth, neutral.
    this.ballast = this.depth < 2.5 ? 1 : 0;
    this._prevSurface = null;
  }

  /** Upright at the current spot, clear of the seabed. */
  reset() {
    const p = this.position;
    let y = p.y;
    if (this.groundFn) y = Math.max(y, this.groundFn(p.x, p.z) + this.hull.radius + 2.0);
    y = Math.min(y, this._surface(p.x, p.z) - 0.5);
    this.setPose(p.x, y, p.z, this.heading);
  }

  /** Move back to the nearest open water (clear of terrain), keeping depth where possible. */
  rescue() {
    const g = this.groundFn;
    const x0 = this.position.x, z0 = this.position.z;
    const s = this._surface(x0, z0);
    if (!g) { this.setPose(x0, Math.min(this.position.y, s - 0.5), z0, this.heading); return; }
    const wantY = Math.min(this.position.y, s - 0.5);
    const clearAt = (x, z, y) => g(x, z) < y - 5 && g(x + 4, z) < y - 4 && g(x - 4, z) < y - 4 && g(x, z + 4) < y - 4 && g(x, z - 4) < y - 4;
    if (clearAt(x0, z0, wantY)) { this.setPose(x0, wantY, z0, this.heading); return; }
    for (let r = 6; r <= 150; r += 6) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
        const x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r;
        if (clearAt(x, z, wantY)) { this.setPose(x, wantY, z, Math.atan2(Math.cos(a), Math.sin(a))); return; }
      }
    }
    // Nothing open at this depth: rise to the surface here.
    this.setPose(x0, s - 0.5, z0, this.heading);
  }

  _surface(x, z) { return this.ceilingFn ? this.ceilingFn(x, z) : 0; }

  _syncAxes() {
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.heading = Math.atan2(this.forward.x, this.forward.z);
    this.pitch = Math.asin(clamp(this.forward.y, -1, 1));
    this.roll = Math.asin(clamp(this.right.y, -1, 1));
  }

  /** Advance with fixed 1/120 s substeps. The second argument (wind) is accepted for Game.update compatibility. */
  update(dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    this.scrape = 0;
    for (let i = 0; i < steps; i++) this._step(h);
    this.speed = this.velocity.length();
    this.speedKmh = this.speed * 3.6;
    this.slapImpulse *= Math.exp(-dt * 4);
  }

  _step(dt) {
    const hull = this.hull, m = hull.mass, R = hull.radius;
    const pos = this.position, vel = this.velocity;
    this._syncAxes();

    // ------------------------------------------------------------- water
    const s = this._surface(pos.x, pos.z);
    this.surfaceY = s;
    const waterVy = this._prevSurface === null ? 0 : clamp((s - this._prevSurface) / dt, -6, 6);
    this._prevSurface = s;
    // Submerged fraction of the hull, linear from the keel to the hull top.
    const wet = clamp((s - (pos.y - R)) / (2 * R), 0, 1);
    this.depth = Math.max(0, s - pos.y);
    this.submersion = clamp(1 + (s - 0.6 - (pos.y + R)) / 1.2, 0, 1);
    const sub = this.submersion;

    // Ballast: follow the dive input; with the stick centred a surfaced sub
    // stays light (keeps floating) and a submerged one goes neutral.
    const dive = clamp(this.dive, -1, 1);
    let target = dive;
    if (Math.abs(dive) < 0.05) target = (this.ballast > 0.2 && this.depth < 2.5) ? 1 : 0;
    this.ballast += (target - this.ballast) * (1 - Math.exp(-dt * 2.0));

    const F = _v.set(0, -m * G, 0);
    // Buoyancy of the wetted hull; neutral at ballast 0 when fully under.
    F.y += wet * m * G * (1 + 0.3 * this.ballast);
    // Vertical damping against the water (follows the swell when surfaced).
    F.y -= (vel.y - waterVy * (1 - sub)) * m * 0.9 * (0.4 + 0.6 * wet);

    // ------------------------------------------------------------ thrust
    const vLong = vel.dot(this.forward), vLat = vel.dot(this.right), vUp = vel.dot(this.up);
    const throttle = clamp(this.throttle, -0.5, 1);
    const boostK = 1 + 0.3 * clamp(this.boost, 0, 1);
    const maxV = THREE.MathUtils.lerp(hull.surfaceSpeed, hull.maxSpeed, sub) * boostK;
    let thrustN = hull.thrust * throttle * boostK * (0.5 + 0.5 * wet);
    // Governor: full thrust to three quarters of top speed, then a taper to the cap.
    const ratio = throttle >= 0 ? vLong / maxV : -vLong / (maxV * 0.5);
    thrustN *= clamp((1 - ratio) * 6, 0, 1);
    F.addScaledVector(this.forward, thrustN);

    // -------------------------------------------------------------- drag
    const wetK = 0.5 + 0.5 * wet;
    F.addScaledVector(this.forward, -(55 * vLong * Math.abs(vLong) + m * 0.05 * vLong) * wetK);
    F.addScaledVector(this.right, -(4500 * vLat * Math.abs(vLat) + m * 1.2 * vLat) * wetK);
    F.addScaledVector(this.up, -(4500 * vUp * Math.abs(vUp) + m * 0.6 * vUp) * wetK);

    // ------------------------------------------------------------ terrain
    this.contacts.length = 0;
    if (this.groundFn) this._collideGround(F, dt);

    // -------------------------------------------------------- orientation
    // Attitude is driven by three damped trackers (planes, rudder + bow
    // thruster, hydrostatic roll righting) expressed as body-frame angular
    // accelerations. Signs: +rotation about `right` pitches the nose DOWN,
    // +rotation about `up` yaws the bow toward +X (heading grows, visual left),
    // +rotation about `forward` lifts the +X side (roll grows).
    const speedF = Math.abs(vLong);
    const wR = this.angular.dot(this.right), wU = this.angular.dot(this.up), wF = this.angular.dot(this.forward);
    // Planes: authority grows with way on; at the surface follow the swell slope instead.
    const planeAuth = smooth(speedF, 0.3, 4.0);
    let pitchTarget = dive * hull.maxPitch * planeAuth;
    if (wet < 0.999) {
      const sBow = this._surface(pos.x + this.forward.x * 2.6, pos.z + this.forward.z * 2.6);
      const sStern = this._surface(pos.x - this.forward.x * 2.6, pos.z - this.forward.z * 2.6);
      const slope = Math.atan2(sBow - sStern, 5.2);
      pitchTarget = THREE.MathUtils.lerp(slope, pitchTarget, clamp(sub * 2, 0, 1));
    }
    const aPitchUp = 5.0 * (pitchTarget - this.pitch) + 4.5 * wR;   // + wR: nose-down rate opposes nose-up error
    // Yaw: rudder authority with speed plus a low-speed thruster so it turns when stopped.
    const yawAuth = 0.4 + 0.6 * smooth(speedF, 0, 4.0);
    const yawTarget = -clamp(this.steer, -1, 1) * hull.maxYaw * yawAuth;
    const aYaw = (yawTarget - wU) * 3.5;
    // Roll: strong righting, a small bank into the turn (positive steer lifts the +X side).
    const rollTarget = clamp(this.steer, -1, 1) * 0.14 * smooth(speedF, 1, 5);
    const aRoll = 10 * (rollTarget - this.roll) - 6.5 * wF;

    // ---------------------------------------------------------- integrate
    vel.addScaledVector(F, dt / m);
    this.angular.addScaledVector(this.right, -aPitchUp * dt).addScaledVector(this.up, aYaw * dt).addScaledVector(this.forward, aRoll * dt);
    if (this.angular.lengthSq() > 4) this.angular.setLength(2);
    pos.addScaledVector(vel, dt);
    const ang = this.angular.length() * dt;
    if (ang > 1e-7) {
      _q.setFromAxisAngle(_p.copy(this.angular).normalize(), ang);
      this.quaternion.premultiply(_q).normalize();
    }
    this._syncAxes();
    this.wakeStrength = clamp(Math.abs(vLong) / hull.surfaceSpeed, 0, 1) * (1 - sub);
  }

  _collideGround(F, dt) {
    const g = this.groundFn, m = this.hull.mass, vel = this.velocity;
    const e = 1.0;
    let bestPush = 0;
    _push.set(0, 0, 0);
    for (let i = 0; i < PROBES.length; i++) {
      const pr = PROBES[i];
      _p.set(pr[0], pr[1], pr[2]).applyQuaternion(this.quaternion).add(this.position);
      const r = pr[3];
      let pen = g(_p.x, _p.z) - (_p.y - r);
      if (pen <= 0) {
        // Look ahead along the velocity (two substeps plus the probe's own radius, since a
        // heightfield test only sees what is under the probe centre): kill the approach
        // speed before contact so a canyon wall is met at the hull's leading edge.
        const sp = vel.length();
        if (sp < 1e-3) continue;
        _p.addScaledVector(vel, dt * 2 + r / sp);
        const penN = g(_p.x, _p.z) - (_p.y - r);
        if (penN <= 0) continue;
        _n.set(g(_p.x - e, _p.z) - g(_p.x + e, _p.z), 2 * e, g(_p.x, _p.z - e) - g(_p.x, _p.z + e)).normalize();
        const vn = vel.dot(_n);
        if (vn < 0) vel.addScaledVector(_n, -vn);
        continue;
      }
      _n.set(g(_p.x - e, _p.z) - g(_p.x + e, _p.z), 2 * e, g(_p.x, _p.z - e) - g(_p.x, _p.z + e)).normalize();
      // Hard stop: the perpendicular distance out of the surface is pen * n.y.
      const d = Math.min(pen * _n.y, 0.6);
      if (d > bestPush) { bestPush = d; _push.copy(_n).multiplyScalar(d); }
      const vn = vel.dot(_n);
      if (vn < 0) vel.addScaledVector(_n, -vn * 1.15);
      // Spring so a resting hull settles onto the bottom, and scrape friction.
      const scale = Math.min(pen, 1.5);
      F.addScaledVector(_n, m * G * 2.0 * scale);
      F.addScaledVector(vel, -m * 2.5 * Math.min(1, scale));
      this.contacts.push(pen);
      this.scrape = Math.max(this.scrape, clamp(vel.length() / 4, 0, 1));
    }
    if (bestPush > 0) this.position.add(_push);
  }
}

// ------------------------------------------------------------------ visual
const SUB_COLORS = [PALETTE.yellow, PALETTE.orange, 0x6ee7c2];
const HELMETS = [PALETTE.red, PALETTE.navy, PALETTE.purple];
const BUBBLES = 150;
const BUBBLE_LIFE = 3.2;

function box(w, h, d) { return new THREE.BoxGeometry(w, h, d); }
function rbox(w, h, d, r) { return new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w / 2, h / 2, d / 2)); }
function cyl(rTop, rBot, h, seg = 12) { return new THREE.CylinderGeometry(rTop, rBot, h, seg); }
function sphere(r, w = 10, h = 7) { return new THREE.SphereGeometry(r, w, h); }
function triCount(g) { return (g.index ? g.index.count : g.attributes.position.count) / 3; }

/** Merges geometry per material (one draw per colour); animated parts get their own mesh. */
class Builder {
  constructor(atmosphere) { this.atmosphere = atmosphere; this.mats = new Map(); this.bins = new Map(); this.tris = 0; this.all = []; }
  mat(color, opts = {}) {
    const hex = typeof color === 'string' ? PALETTE[color] : color;
    const key = `${hex}|${opts.roughness ?? 0.5}|${opts.metal ?? 0}|${opts.emissive ?? ''}|${opts.opacity ?? 1}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new PropMaterial({
        color: hex, roughness: opts.roughness ?? 0.5, metal: opts.metal ?? 0, emissive: opts.emissive,
        transparent: opts.opacity !== undefined && opts.opacity < 1, opacity: opts.opacity, depthWrite: opts.opacity === undefined || opts.opacity >= 1,
        side: opts.side,
      }, this.atmosphere);
      this.mats.set(key, m);
      this.all.push(m);
    }
    return m;
  }
  add(geo, color, place, opts) {
    if (place) geo.translate(place[0], place[1], place[2]);
    const m = this.mat(color, opts);
    if (!this.bins.has(m)) this.bins.set(m, []);
    this.bins.get(m).push(geo.index ? geo.toNonIndexed() : geo);
    return geo;
  }
  mesh(geo, color, opts) {
    const mesh = new THREE.Mesh(geo, this.mat(color, opts));
    this.tris += triCount(geo);
    return trackMotion(mesh);
  }
  flush(parent) {
    for (const [m, geos] of this.bins) {
      const merged = mergeGeometries(geos, false);
      for (const g of geos) g.dispose();
      const mesh = new THREE.Mesh(merged, m);
      this.tris += triCount(merged);
      parent.add(trackMotion(mesh));
    }
    this.bins.clear();
  }
}

/** Kid pilot: big round head, helmet, life vest, hands on a small wheel. `update(dt, steer, speedK)` leans into turns. */
function buildKid(B, { helmet, vest = 'orange', shirt = 'white' }) {
  const root = new THREE.Group();
  const torso = new THREE.Group();
  root.add(torso);
  const head = new THREE.Group();
  head.position.set(0, 0.52, 0);
  torso.add(head);
  torso.add(B.mesh(box(0.32, 0.42, 0.22).translate(0, 0.22, 0), shirt, { roughness: 0.6 }));
  torso.add(B.mesh(box(0.38, 0.34, 0.3).translate(0, 0.24, 0), vest, { roughness: 0.6 }));
  torso.add(B.mesh(box(0.08, 0.26, 0.04).translate(0, 0.24, 0.15), 'white', { roughness: 0.6 }));
  torso.add(B.mesh(cyl(0.06, 0.06, 0.1, 6).translate(0, 0.46, 0), 'skin', { roughness: 0.7 }));
  head.add(B.mesh(sphere(0.19, 9, 6), 'skin', { roughness: 0.7 }));
  head.add(B.mesh(new THREE.SphereGeometry(0.215, 9, 4, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 0.02, 0), helmet, { roughness: 0.35 }));
  head.add(B.mesh(box(0.3, 0.035, 0.14).translate(0, -0.005, 0.2), 'dark', { roughness: 0.4 }));
  const eyes = mergeGeometries([sphere(0.03, 5, 3).translate(-0.07, 0, 0.175), sphere(0.03, 5, 3).translate(0.07, 0, 0.175)].map(g => g.toNonIndexed()), false);
  head.add(B.mesh(eyes, 'dark', { roughness: 0.3 }));
  // arms to the wheel
  const hands = [[-0.17, 0.3, 0.3], [0.17, 0.3, 0.3]], shoulders = [[-0.2, 0.38, 0.02], [0.2, 0.38, 0.02]];
  for (let i = 0; i < 2; i++) {
    const sh = new THREE.Vector3(...shoulders[i]), h = new THREE.Vector3(...hands[i]);
    const dir = h.clone().sub(sh), len = dir.length();
    const arm = cyl(0.05, 0.042, len, 6).translate(0, len / 2, 0);
    _q.setFromUnitVectors(_up, dir.normalize());
    arm.applyQuaternion(_q).translate(sh.x, sh.y, sh.z);
    torso.add(B.mesh(arm, shirt, { roughness: 0.6 }));
    torso.add(B.mesh(sphere(0.06, 5, 3).translate(h.x, h.y, h.z), 'skin', { roughness: 0.7 }));
  }
  const wheel = B.mesh(new THREE.TorusGeometry(0.15, 0.025, 5, 12).rotateX(-0.4), 'dark', { roughness: 0.5 });
  wheel.position.set(0, 0.3, 0.34);
  root.add(wheel);
  const st = { lean: 0 };
  root.update = (dt, steer, speedK) => {
    st.lean += ((-steer * 0.25) * (0.4 + 0.6 * speedK) - st.lean) * (1 - Math.exp(-dt * 5));
    torso.rotation.z = st.lean;
    head.rotation.z = st.lean * 0.7;
    head.rotation.y = -st.lean * 0.8;
  };
  return root;
}

// Bubble trail: positions are world space (the shader ignores modelMatrix);
// each point rises from its spawn point on its own clock so nothing is
// touched per frame except the slots that were just emitted.
const BUBBLE_VERT = /* glsl */ `
precision highp float;
in vec3 position;
in vec4 aData;   // birth, seed, size, spread
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 uViewProjNJ;
uniform mat4 uPrevViewProjNJ;
uniform vec3 uCamPos;
uniform vec2 uResolution;
uniform float uTime;
uniform float uSurface;
uniform float uLife;
out float vFade;
out float vSeed;
out vec3 vWorld;
out vec4 vClipNJ;
out vec4 vPrevClipNJ;
void main(){
  float age = uTime - aData.x;
  float seed = aData.y;
  if (age < 0.0 || age > uLife) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vFade = 0.0; vSeed = 0.0; vWorld = position; vClipNJ = gl_Position; vPrevClipNJ = gl_Position; return; }
  float rise = age * mix(0.55, 1.1, seed) + age * age * 0.12;
  vec3 wp = position;
  wp.x += sin(age * 2.6 + seed * 21.0) * 0.12 * age * aData.w;
  wp.z += cos(age * 2.1 + seed * 13.0) * 0.12 * age * aData.w;
  wp.y += rise;
  float toSurf = uSurface - 0.15 - wp.y;
  wp.y = min(wp.y, uSurface - 0.15);
  vWorld = wp;
  vSeed = seed;
  float t = age / uLife;
  vFade = smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.75, 1.0, t)) * smoothstep(-0.2, 0.6, toSurf);
  float dist = length(uCamPos - wp);
  float px = aData.z * (1.0 + age * 0.35) * uResolution.y / max(dist, 1.0);
  gl_PointSize = clamp(px, 1.0, 14.0);
  vClipNJ = uViewProjNJ * vec4(wp, 1.0);
  vPrevClipNJ = uPrevViewProjNJ * vec4(wp, 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const BUBBLE_FRAG = /* glsl */ `
precision highp float;
uniform vec3 uCamPos;
uniform vec3 uTint;
in float vFade;
in float vSeed;
in vec3 vWorld;
in vec4 vClipNJ;
in vec4 vPrevClipNJ;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oVelocity;
void main(){
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float d = length(q);
  if (d > 1.0 || vFade <= 0.0) discard;
  // thin bright rim, faint fill, a highlight dot up-left
  float rim = smoothstep(0.55, 0.85, d) * (1.0 - smoothstep(0.88, 1.0, d));
  float fill = (1.0 - d) * 0.18;
  float hi = pow(max(0.0, 1.0 - length(q - vec2(-0.35, 0.35)) * 2.4), 2.0);
  float a = (rim * 0.55 + fill * 0.6 + hi * 0.8) * vFade;
  vec3 col = uTint * (1.0 + hi * 1.5);
  oColor = vec4(col, clamp(a, 0.0, 1.0));
  float dist = length(vWorld - uCamPos);
  vec2 cur = vClipNJ.xy / max(vClipNJ.w, 1e-6);
  vec2 prv = vPrevClipNJ.xy / max(vPrevClipNJ.w, 1e-6);
  oVelocity = vec4((cur - prv) * 0.5, dist, 1.0);
}
`;

function buildBubbles() {
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(BUBBLES * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const data = new THREE.BufferAttribute(new Float32Array(BUBBLES * 4), 4).setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < BUBBLES; i++) data.setX(i, -1e9);   // never born
  geo.setAttribute('position', pos);
  geo.setAttribute('aData', data);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
  const mat = new THREE.RawShaderMaterial({
    name: 'SubBubbles', glslVersion: THREE.GLSL3, vertexShader: BUBBLE_VERT, fragmentShader: BUBBLE_FRAG,
    uniforms: {
      uCamPos: U.uCamPos, uResolution: U.uResolution, uTime: U.uTime, uViewProjNJ: U.uViewProjNJ, uPrevViewProjNJ: U.uPrevViewProjNJ,
      uSurface: { value: 0 }, uLife: { value: BUBBLE_LIFE }, uTint: { value: new THREE.Color(0.75, 0.92, 1.0).multiplyScalar(3.5) },
    },
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  points.name = 'bubbles';
  return { points, pos, data, mat, head: 0, acc: 0 };
}

/**
 * Toy submarine visual. Group local +Z is forward, origin at the hull centre
 * (the physics position). `update(dt, body)` spins the prop with throttle,
 * tilts the planes with dive, swings the rudder, fades the headlight cones
 * in as the hull goes under and streams bubbles from the stern.
 * @param {{ atmosphere: object, colorIndex?: number }} ctx
 * @returns {Promise<THREE.Group>} with .update(dt, body), .triangles, .colorIndex
 */
export async function buildSubVisual({ atmosphere, colorIndex = 0 } = {}) {
  const B = new Builder(atmosphere);
  const ci = ((colorIndex | 0) % SUB_COLORS.length + SUB_COLORS.length) % SUB_COLORS.length;
  const color = SUB_COLORS[ci];
  const R = SUB_HULL.radius;
  const g = new THREE.Group();

  // Cigar hull along +Z, two white bands, a dark keel strip.
  B.add(new THREE.CapsuleGeometry(R, 4.1, 4, 14).rotateX(Math.PI / 2), color, null, { roughness: 0.4 });
  B.add(cyl(R + 0.03, R + 0.03, 0.3, 14).rotateX(Math.PI / 2), 'white', [0, 0, -1.25], { roughness: 0.45 });
  B.add(cyl(R + 0.03, R + 0.03, 0.3, 14).rotateX(Math.PI / 2), 'white', [0, 0, 0.9], { roughness: 0.45 });
  B.add(box(0.5, 0.14, 4.0), 'dark', [0, -R + 0.02, -0.2], { roughness: 0.8 });
  // Conning tower with a hatch, a window strip and a periscope.
  B.add(rbox(1.0, 0.9, 1.4, 0.22), color, [0, R + 0.35, -0.1], { roughness: 0.4 });
  B.add(cyl(0.32, 0.32, 0.08, 12), 'white', [0, R + 0.83, -0.25], { roughness: 0.5 });
  B.add(box(0.55, 0.2, 0.06), 'dark', [0, R + 0.55, 0.6], { roughness: 0.3 });
  B.add(cyl(0.06, 0.06, 0.95, 8), 'steel', [0.28, R + 1.25, -0.4], { roughness: 0.3, metal: 0.7 });
  B.add(box(0.13, 0.13, 0.4), 'steel', [0.28, R + 1.72, -0.25], { roughness: 0.3, metal: 0.7 });
  B.add(cyl(0.05, 0.05, 0.03, 8).rotateX(Math.PI / 2), 'glass', [0.28, R + 1.72, -0.04], { roughness: 0.15 });
  // Side portholes: white rim, deep-blue glass.
  for (const sx of [-1, 1]) {
    B.add(cyl(0.34, 0.34, 0.1, 10).rotateZ(Math.PI / 2), 'white', [sx * 0.9, 0.22, -0.5], { roughness: 0.5 });
    B.add(cyl(0.25, 0.25, 0.14, 10).rotateZ(Math.PI / 2), 0x1d3b6e, [sx * 0.9, 0.22, -0.5], { roughness: 0.15 });
  }
  // Cockpit bubble forward of the tower: white collar, glass dome, kid inside.
  const domeZ = 1.7, collarY = R - 0.05;
  B.add(cyl(0.7, 0.74, 0.5, 12), 'white', [0, collarY, domeZ], { roughness: 0.45 });
  B.add(cyl(0.6, 0.6, 0.06, 10), 'dark', [0, collarY + 0.25, domeZ], { roughness: 0.8 });  // cockpit floor
  // Stern planes (tilt with dive) and rudders; the upper rudder swings with steer.
  const planes = new THREE.Group();
  planes.position.set(0, 0, -2.5);
  planes.add(B.mesh(mergeGeometries([box(1.1, 0.07, 0.6).translate(-0.9, 0, 0), box(1.1, 0.07, 0.6).translate(0.9, 0, 0)], false), 'white', { roughness: 0.5 }));
  g.add(planes);
  B.add(box(0.07, 0.75, 0.6), 'white', [0, -0.95, -2.5], { roughness: 0.5 });
  const rudder = B.mesh(box(0.07, 0.8, 0.6).translate(0, 0, -0.2), 'white', { roughness: 0.5 });
  rudder.position.set(0, 1.0, -2.3);
  g.add(rudder);
  // Propeller in a shroud.
  const prop = new THREE.Group();
  prop.position.set(0, 0, -3.15);
  const blades = [cyl(0.12, 0.16, 0.3, 8).rotateX(Math.PI / 2).toNonIndexed()];
  for (let k = 0; k < 4; k++) {
    const bl = box(0.16, 0.5, 0.05).translate(0, 0.38, 0).rotateY(0.65).rotateZ(k * Math.PI / 2);
    blades.push(bl.toNonIndexed());
  }
  prop.add(B.mesh(mergeGeometries(blades, false), 'steel', { roughness: 0.3, metal: 0.75 }));
  g.add(prop);
  B.add(new THREE.TorusGeometry(0.66, 0.06, 5, 14), 'dark', [0, 0, -3.05], { roughness: 0.7 });
  B.add(mergeGeometries([box(0.05, 0.6, 0.08).translate(0, 0.35, 0), box(0.05, 0.6, 0.08).translate(0, -0.35, 0), box(0.6, 0.05, 0.08).translate(0.35, 0, 0), box(0.6, 0.05, 0.08).translate(-0.35, 0, 0)], false), 'dark', [0, 0, -3.05], { roughness: 0.7 });
  // Headlights: dark housing, bright emissive disc (own material so the glow can be hot).
  const lampOpts = { roughness: 0.3, emissive: 0xffffff };
  for (const sx of [-1, 1]) {
    B.add(cyl(0.23, 0.23, 0.1, 8).rotateX(Math.PI / 2), 'dark', [sx * 0.42, 0.3, 2.78], { roughness: 0.6 });
    B.add(cyl(0.17, 0.17, 0.06, 8).rotateX(Math.PI / 2), 'cream', [sx * 0.42, 0.3, 2.85], lampOpts);
  }
  B.mat('cream', lampOpts).emissive.setRGB(9.0, 8.2, 6.0);
  B.flush(g);

  // Glass dome (transparent, drawn after the kid) and its rim.
  const dome = B.mesh(new THREE.SphereGeometry(0.72, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.5), 'glass', { roughness: 0.08, opacity: 0.26, side: THREE.DoubleSide });
  dome.position.set(0, collarY + 0.25, domeZ);
  dome.renderOrder = 2;
  g.add(dome);
  const rim = B.mesh(new THREE.TorusGeometry(0.7, 0.06, 5, 16).rotateX(Math.PI / 2), 'white', { roughness: 0.45 });
  rim.position.set(0, collarY + 0.27, domeZ);
  g.add(rim);
  const kid = buildKid(B, { helmet: HELMETS[ci], vest: ci === 1 ? PALETTE.yellow : 'orange' });
  kid.position.set(0, collarY + 0.08, domeZ - 0.05);
  g.add(kid);

  // Headlight cones: soft translucent wedges that fade in under water.
  const coneMat = new PropMaterial({ color: PALETTE.cream, emissive: new THREE.Color(1.6, 1.5, 1.1), roughness: 1, transparent: true, opacity: 0.0, depthWrite: false, side: THREE.DoubleSide }, atmosphere);
  const coneGeo = new THREE.ConeGeometry(1.5, 9, 12, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 4.5);
  for (const sx of [-1, 1]) {
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.set(sx * 0.42, 0.3, 2.85);
    cone.rotation.y = -sx * 0.05;
    cone.renderOrder = 2;
    g.add(trackMotion(cone));
  }
  B.tris += triCount(coneGeo) * 2;

  const bubbles = buildBubbles();
  g.add(bubbles.points);

  const st = { spin: 0, dive: 0, steer: 0, throttle: 0 };
  g.update = (dt, body) => {
    const k = 1 - Math.exp(-dt * 6);
    st.dive += ((body.dive || 0) - st.dive) * k;
    st.steer += ((body.steer || 0) - st.steer) * k;
    st.throttle += ((body.throttle || 0) - st.throttle) * (1 - Math.exp(-dt * 3));
    st.spin += dt * (1.5 + 34 * Math.abs(st.throttle)) * (st.throttle >= 0 ? 1 : -1);
    prop.rotation.z = st.spin;
    planes.rotation.x = -st.dive * 0.5;
    rudder.rotation.y = st.steer * 0.55;
    const speedK = Math.min(1, (body.speed || 0) / body.hull.maxSpeed);
    kid.update(dt, body.steer || 0, speedK);
    const sub = body.submersion ?? 0;
    coneMat.uniforms.uOpacity.value = 0.16 * sub;
    // Bubbles from the stern while the prop is turning under water.
    const surface = body.surfaceY ?? 0;
    bubbles.mat.uniforms.uSurface.value = surface;
    const sternY = body.position.y - body.forward.y * 3.2;
    const rate = sternY < surface - 0.3 ? 40 * Math.abs(st.throttle) + 3 * sub : 0;
    bubbles.acc += rate * dt;
    if (bubbles.acc >= 1) {
      const t = U.uTime.value;
      let n = 0;
      while (bubbles.acc >= 1 && n < 6) {
        bubbles.acc -= 1; n++;
        const i = bubbles.head;
        bubbles.head = (i + 1) % BUBBLES;
        const sx = (Math.random() - 0.5) * 0.7, sy = (Math.random() - 0.5) * 0.7;
        bubbles.pos.setXYZ(i,
          body.position.x - body.forward.x * 3.3 + body.right.x * sx + body.up.x * sy,
          body.position.y - body.forward.y * 3.3 + body.right.y * sx + body.up.y * sy,
          body.position.z - body.forward.z * 3.3 + body.right.z * sx + body.up.z * sy);
        bubbles.data.setXYZW(i, t - Math.random() * 0.05, Math.random(), 0.022 + Math.random() * 0.035, 0.5 + Math.random());
      }
      bubbles.pos.needsUpdate = true;
      bubbles.data.needsUpdate = true;
    }
  };
  g.name = 'sub';
  g.colorIndex = ci;
  g.triangles = Math.round(B.tris);
  g.dispose = () => { for (const m of B.all) m.dispose(); coneMat.dispose(); bubbles.mat.dispose(); bubbles.points.geometry.dispose(); g.traverse(o => { if (o.isMesh) o.geometry.dispose(); }); };
  return g;
}

// --------------------------------------------------------------------- dev
/**
 * Standalone harness: `?mods=Submarine&debug=1` swaps the player's boat for a
 * sub at the start line (surfaced), wires the dive input and the 3D camera,
 * and reports depth/pitch in game.stats(). Combine with SubRace for hoops.
 */
export async function devInstall(game) {
  if (game.player?.body?.isSub) return game.player;
  const old = game.player;
  const b = old.body;
  const x = b.position.x, z = b.position.z, heading = b.heading;
  const s = game.sea.heightAt(x, z);
  let sub;
  if (typeof game.spawnSub === 'function') {
    sub = await game.spawnSub(x, s - 0.5, z, heading, 0);
  } else {
    const body = new SubPhysics({ groundFn: game.world?.heightAt || null, ceilingFn: (px, pz) => game.sea.heightAt(px, pz) });
    const visual = await buildSubVisual({ atmosphere: game.app.atmosphere, colorIndex: 0 });
    const group = new THREE.Group();
    group.add(visual);
    game.scene.add(group);
    body.setPose(x, s - 0.5, z, heading);
    group.position.copy(body.position);
    group.quaternion.copy(body.quaternion);
    sub = { name: 'sub', hull: body.hull, body, group, visual, colorIndex: 0, isSub: true };
    game.boats.push(sub);
  }
  sub.body.groundFn = sub.body.groundFn || game.world?.heightAt || null;
  sub.body.ceilingFn = sub.body.ceilingFn || ((px, pz) => game.sea.heightAt(px, pz));
  if (game.removeBoat) game.removeBoat(old);
  else { game.scene.remove(old.group); const i = game.boats.indexOf(old); if (i >= 0) game.boats.splice(i, 1); }
  game.player = sub;
  game.camera.follow(sub.body);
  const camHasSub = 'mode' in game.camera;
  if (camHasSub) game.camera.mode = 'sub';
  else game.camera.enabled = false;
  console.log(`[sub] player is a submarine (${sub.visual?.triangles ?? '?'} tris), camera ${camHasSub ? "mode 'sub'" : 'driven by the harness'}`);

  const SW = game.mods?.SubmarineWorld;
  let fogOn = false;
  const orig = game.update.bind(game);
  game.update = (dt, rawDt) => {
    const body = game.player?.body;
    if (body?.isSub) {
      const can = game.driving && (!game.race || game.race.acceptsInput !== false);
      body.dive = can ? (game.controls.dive || 0) : 0;
    }
    orig(dt, rawDt);
    if (!body?.isSub) return;
    if (!camHasSub) {
      // 12 m behind, 4 m above, looking along the sub's forward; under the surface while deep.
      const cam = game.app.camera, fwd = body.forward;
      _p.set(body.position.x - fwd.x * 12, body.position.y + 4, body.position.z - fwd.z * 12);
      const surf = game.sea.heightAt(_p.x, _p.z);
      if (body.depth > 3) { if (_p.y > surf - 1.5) _p.y = surf - 1.5; } else if (_p.y < surf + 1.5) _p.y = surf + 1.5;
      cam.position.lerp(_p, 1 - Math.exp(-dt * 5));
      _n.set(body.position.x + fwd.x * 6, body.position.y, body.position.z + fwd.z * 6);
      cam.lookAt(_n);
    }
    // Underwater look in worlds that are not submarine worlds (Game.js handles those itself).
    if (SW?.setSubmerged && !game.world?.def?.underwater) {
      const cam = game.app.camera.position;
      const under = game.sea.heightAt(cam.x, cam.z) - cam.y > 0.3;
      if (under !== fogOn) { fogOn = under; SW.setSubmerged(game.app, under, game.world?.def?.fog); }
    }
  };
  const prevStats = game.stats.bind(game);
  game.stats = () => {
    const st = prevStats();
    const body = game.player?.body;
    if (body?.isSub) { st.depth = +body.depth.toFixed(1); st.pitch = +(body.pitch / DEG).toFixed(0); st.ballast = +body.ballast.toFixed(2); st.dive = +body.dive.toFixed(2); }
    return st;
  };
  return sub;
}
