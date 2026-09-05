import * as THREE from 'three';

/**
 * Small-craft rigid body on a sampled sea.
 *
 * The hull is a handful of buoyancy points. Each one that sits below the
 * sampled surface pushes up with a spring-damper proportional to its
 * submersion, so waves genuinely lift, drop, roll and pitch the boat. Thrust
 * is applied at the stern and rotates with the steering angle like an
 * outboard, so steering authority grows with throttle and a boat coasting
 * with the engine off turns slowly — the way real boats behave. Lateral drag
 * acts below the centre of mass, which is what leans a planing hull *into* a
 * turn. A gentle upright assist and a roll clamp keep it forgiving for kids.
 *
 * Units: metres, seconds, kilograms. +Z is the hull's forward axis in local
 * space (the Kenney models point +Z too, so the catalog uses yaw 0).
 */
const G = 9.81;
const WATER_RHO = 1000;
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _f = new THREE.Vector3();
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _up = new THREE.Vector3(0, 1, 0);
const _sample = new THREE.Vector3();

export const HULLS = {
  jetski: {
    length: 3.3, width: 1.25, mass: 380, draft: 0.32,
    thrust: 5200, maxSpeed: 22, steerTorque: 1.15, rudderLift: 0.9,
    dragLong: 0.055, dragLat: 1.2, planing: 0.85, roll: 1.6, bounce: 1.3,
    // Point height = -draft/1.35 puts the body origin at the resting waterline.
    buoyancyPoints: [[0, -0.24, 1.35], [-0.5, -0.24, -0.2], [0.5, -0.24, -0.2], [-0.45, -0.24, -1.4], [0.45, -0.24, -1.4]],
    label: 'Jet Ski',
  },
  speedboat: {
    length: 6.4, width: 2.3, mass: 1500, draft: 0.5,
    thrust: 18000, maxSpeed: 28, steerTorque: 0.75, rudderLift: 0.7,
    dragLong: 0.05, dragLat: 1.4, planing: 0.8, roll: 1.1, bounce: 1.0,
    buoyancyPoints: [[0, -0.37, 2.8], [-0.9, -0.37, 1.0], [0.9, -0.37, 1.0], [-1.0, -0.37, -1.2], [1.0, -0.37, -1.2], [0, -0.37, -2.8]],
    label: 'Speedboat',
  },
  sailboat: {
    length: 8.0, width: 2.6, mass: 2600, draft: 0.6,
    thrust: 14000, maxSpeed: 12, steerTorque: 0.55, rudderLift: 1.0,
    dragLong: 0.08, dragLat: 2.2, planing: 0.0, roll: 0.55, bounce: 0.7, sail: true,
    buoyancyPoints: [[0, -0.45, 3.6], [-1.1, -0.45, 1.2], [1.1, -0.45, 1.2], [-1.15, -0.45, -1.6], [1.15, -0.45, -1.6], [0, -0.45, -3.7]],
    label: 'Sailboat',
  },
  pontoon: {
    length: 7.0, width: 2.6, mass: 1900, draft: 0.35,
    thrust: 14000, maxSpeed: 14, steerTorque: 0.6, rudderLift: 0.6,
    dragLong: 0.09, dragLat: 1.6, planing: 0.1, roll: 0.3, bounce: 0.6,
    buoyancyPoints: [[-1.0, -0.26, 3.2], [1.0, -0.26, 3.2], [-1.0, -0.26, 0], [1.0, -0.26, 0], [-1.0, -0.26, -3.2], [1.0, -0.26, -3.2]],
    label: 'Pontoon',
  },
};

export class BoatPhysics {
  /**
   * @param {object} hull one of HULLS
   * @param {WaveField} sea
   */
  constructor(hull, sea) {
    this.hull = hull;
    this.sea = sea;
    this.position = new THREE.Vector3(0, 0, 0);
    this.quaternion = new THREE.Quaternion();
    this.velocity = new THREE.Vector3();
    this.angular = new THREE.Vector3();      // world-space angular velocity (rad/s)
    this.forward = new THREE.Vector3(0, 0, 1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.up = new THREE.Vector3(0, 1, 0);
    // input
    this.throttle = 0;   // -0.5 .. 1
    this.steer = 0;      // -1 .. 1 (positive = turn right)
    this.boost = 0;      // 0..1
    // derived, for camera / audio / fx
    this.speed = 0;
    this.speedKmh = 0;
    this.submersion = 0;   // 0 = airborne, 1 = fully settled
    this.airborne = false;
    this.slapImpulse = 0;  // set on hard landings, decays; audio/spray listen to it
    this.wakeStrength = 0;
    this.heading = 0;
    this.groundFn = null;  // (x,z) => terrain height, for island collision
    this.contacts = [];

    const m = hull.mass, L = hull.length, W = hull.width, H = Math.max(0.6, W * 0.5);
    // Box inertia, then a small boost so the hull does not spin like a top.
    this.inertia = new THREE.Vector3(
      m * (W * W + H * H) / 12 * 1.4,
      m * (L * L + W * W) / 12 * 1.6,
      m * (L * L + H * H) / 12 * 1.4);
    // Spring per point so the total displaced volume at nominal draft carries
    // the weight; a stiffer spring reads as a hard, slappy hull.
    this.pointCount = hull.buoyancyPoints.length;
    this.springK = (m * G) / (hull.draft * this.pointCount) * 1.35;
    this.damping = 2 * Math.sqrt(this.springK * m / this.pointCount) * 0.55;
    this._localPoints = hull.buoyancyPoints.map(p => new THREE.Vector3(...p));
    this._sinkTimer = 0;
  }

  setPose(x, y, z, headingRad) {
    this.position.set(x, y, z);
    this.quaternion.setFromAxisAngle(_up, headingRad);
    this.velocity.set(0, 0, 0);
    this.angular.set(0, 0, 0);
    this.heading = headingRad;
    this._syncAxes();
  }

  /** Put the boat back upright at its current spot (kids' panic button). */
  reset() {
    const h = this.sea.heightAt(this.position.x, this.position.z);
    this.setPose(this.position.x, h + 0.2, this.position.z, this.heading);
  }

  _syncAxes() {
    this.forward.set(0, 0, 1).applyQuaternion(this.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.heading = Math.atan2(this.forward.x, this.forward.z);
  }

  /** Advance with fixed substeps. */
  update(dt, wind = null) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) this._step(h, wind);
    this.speed = this.velocity.length();
    this.speedKmh = this.speed * 3.6;
    this.slapImpulse *= Math.exp(-dt * 4);
  }

  _step(dt, wind) {
    const hull = this.hull, m = hull.mass;
    const force = _f.set(0, -m * G, 0);
    const torque = _w.set(0, 0, 0);
    this._syncAxes();

    // ------------------------------------------------------------ buoyancy
    let wet = 0, sumDepth = 0;
    const fwdSpeed = this.velocity.dot(this.forward);
    const planing = hull.planing * THREE.MathUtils.smoothstep(Math.abs(fwdSpeed), 4, hull.maxSpeed * 0.7);
    for (let i = 0; i < this.pointCount; i++) {
      const lp = this._localPoints[i];
      _p.copy(lp).applyQuaternion(this.quaternion).add(this.position);
      const s = this.sea.sample(_p.x, _p.z, _sample);
      const depth = s.x - _p.y;
      if (depth <= 0) continue;
      wet++;
      sumDepth += depth;
      // velocity of this point (v + ω × r)
      _v.copy(_p).sub(this.position);
      const rx = _v.x, ry = _v.y, rz = _v.z;
      _v.set(this.angular.y * rz - this.angular.z * ry,
             this.angular.z * rx - this.angular.x * rz,
             this.angular.x * ry - this.angular.y * rx).add(this.velocity);
      // Planing lift: at speed the hull rides on the water rather than in it,
      // so the springs ease off and the boat lifts and levels out.
      const k = this.springK * (1 - planing * 0.45);
      let fy = k * Math.min(depth, hull.draft * 2.5) - this.damping * _v.y * (1 + planing * 0.6);
      if (fy < 0) fy *= 0.35; // water does not pull the hull down
      const lift = fy + m * G / this.pointCount * planing * 0.5 * (lp.z > 0 ? 1.25 : 0.75);
      // Along the wave normal: a face slope shoves the hull sideways as well as up.
      _v.set(-s.y, 1, -s.z).normalize().multiplyScalar(lift);
      force.add(_v);
      _p.sub(this.position);
      torque.add(_w2.copy(_p).cross(_v));
    }
    this.submersion = wet / this.pointCount;
    this.airborne = wet === 0;
    const meanDepth = wet ? sumDepth / wet : 0;

    // Hard landing: a lot of hull entering the water fast.
    if (wet >= 2 && this.velocity.y < -2.2 && this._prevWet < 2) {
      this.slapImpulse = Math.min(1, -this.velocity.y / 6) * hull.bounce;
    }
    this._prevWet = wet;

    if (wet > 0) {
      // ------------------------------------------------------------ thrust
      const throttle = THREE.MathUtils.clamp(this.throttle, -0.5, 1);
      const boost = 1 + this.boost * 0.35;
      let thrustN = hull.thrust * throttle * boost;
      if (hull.sail && wind) {
        // Point of sail: fastest across the wind, nothing head-to-wind.
        const rel = Math.cos(wind.angle - this.heading);
        const eff = THREE.MathUtils.clamp(0.45 + 0.55 * Math.sin(Math.acos(THREE.MathUtils.clamp(rel, -1, 1))), 0, 1) * (0.7 + 0.3 * Math.min(1, wind.speed / 12));
        thrustN = hull.thrust * Math.max(throttle, 0) * eff * boost + hull.thrust * 0.25 * Math.min(0, throttle);
        this.sailEfficiency = eff;
      }
      // Speed governor: thrust fades as the boat approaches its top speed so the
      // drag coefficients can stay physically small.
      // Full thrust until three quarters of top speed, then a taper to the cap.
      const speedRatio = Math.abs(fwdSpeed) / (hull.maxSpeed * boost);
      thrustN *= THREE.MathUtils.clamp((1.0 - speedRatio) * 4, 0, 1);
      const steerAngle = this.steer * 0.55;
      // Outboard: thrust vector rotates with the steering, applied at the stern.
      _v.copy(this.forward).applyAxisAngle(this.up, -steerAngle);
      _v.y = 0; _v.normalize().multiplyScalar(thrustN * this.submersion);
      force.add(_v);
      _p.copy(this.forward).multiplyScalar(-hull.length * 0.45).addScaledVector(this.up, -0.25);
      torque.add(_w2.copy(_p).cross(_v).multiplyScalar(hull.steerTorque));

      // Rudder lift: a coasting boat still answers the helm, more so at speed.
      const rudder = this.steer * hull.rudderLift * fwdSpeed * Math.abs(fwdSpeed) * m * 0.02 * this.submersion;
      torque.y += rudder;

      // ------------------------------------------------------- hydrodynamics
      const vLong = this.velocity.dot(this.forward);
      const vLat = this.velocity.dot(this.right);
      const area = hull.length * hull.width;
      const fLong = -0.5 * WATER_RHO * hull.dragLong * area * 0.08 * vLong * Math.abs(vLong) * this.submersion;
      const fLat = -0.5 * WATER_RHO * hull.dragLat * area * 0.08 * vLat * Math.abs(vLat) * this.submersion
                 - m * 1.8 * vLat * this.submersion;
      _v.copy(this.forward).multiplyScalar(fLong);
      force.add(_v);
      _v.copy(this.right).multiplyScalar(fLat);
      force.add(_v);
      // Lateral resistance acts on the keel, below the centre of mass: the hull
      // leans into the turn like a real planing boat.
      _p.copy(this.up).multiplyScalar(-hull.draft * 1.2 * hull.roll);
      torque.add(_w2.copy(_p).cross(_v));
      // Reverse gets a low ceiling.
      if (vLong < -4) force.addScaledVector(this.forward, -(vLong + 4) * m * 2);

      // Angular damping in water (yaw a bit less so slides feel alive).
      const wx = this.angular.dot(this.right), wy = this.angular.dot(this.up), wz = this.angular.dot(this.forward);
      // Heavier roll/pitch damping than a bare hull would have: the buoyancy
      // springs are stiff, and an under-damped hull jitters at rest under TAA.
      torque.addScaledVector(this.right, -wx * this.inertia.x * 4.5 * this.submersion);
      torque.addScaledVector(this.up, -wy * this.inertia.y * 2.2 * this.submersion);
      torque.addScaledVector(this.forward, -wz * this.inertia.z * 4.5 * this.submersion);

      // Upright assist: kids should never be stuck upside down.
      const tilt = _v.copy(this.up).cross(_up); // axis to rotate toward upright
      torque.addScaledVector(tilt, m * G * hull.width * 0.25);
    } else {
      // In the air: light drag and a little damping so flips stay controlled.
      force.addScaledVector(this.velocity, -0.8);
      torque.addScaledVector(this.angular, -this.inertia.x * 0.6);
    }

    // ------------------------------------------------------------- terrain
    if (this.groundFn) this._collideGround(force, dt);

    // ------------------------------------------------------------ integrate
    this.velocity.addScaledVector(force, dt / m);
    // torque → angular acceleration in the body frame (diagonal inertia)
    const tx = torque.dot(this.right) / this.inertia.x;
    const ty = torque.dot(this.up) / this.inertia.y;
    const tz = torque.dot(this.forward) / this.inertia.z;
    this.angular.addScaledVector(this.right, tx * dt).addScaledVector(this.up, ty * dt).addScaledVector(this.forward, tz * dt);
    // Clamp spin so a wave cannot flip the boat into a barrel roll.
    const maxSpin = 2.6;
    if (this.angular.lengthSq() > maxSpin * maxSpin) this.angular.setLength(maxSpin);

    this.position.addScaledVector(this.velocity, dt);
    const angle = this.angular.length() * dt;
    if (angle > 1e-7) {
      _q.setFromAxisAngle(_v.copy(this.angular).normalize(), angle);
      this.quaternion.premultiply(_q).normalize();
    }

    // Never let the hull settle far below the surface even in a freak wave.
    const surf = this.sea.heightAt(this.position.x, this.position.z);
    if (this.position.y < surf - hull.draft * 3) {
      this.position.y = surf - hull.draft * 3;
      if (this.velocity.y < 0) this.velocity.y *= -0.2;
    }
    this._syncAxes();
    this.wakeStrength = THREE.MathUtils.clamp(Math.abs(fwdSpeed) / hull.maxSpeed, 0, 1) * this.submersion;
  }

  _collideGround(force, dt) {
    const hull = this.hull;
    // Sample bow, stern and both beams; push away from land and kill the
    // velocity into it. The terrain height under the hull is compared with
    // the keel, so a sloping beach slows you down before it stops you.
    this.contacts.length = 0;
    for (let i = 0; i < this.pointCount; i++) {
      _p.copy(this._localPoints[i]).applyQuaternion(this.quaternion).add(this.position);
      const ground = this.groundFn(_p.x, _p.z);
      const keel = _p.y - hull.draft;
      const pen = ground - keel;
      if (pen <= 0) continue;
      const g = this.groundFn;
      const e = 1.0;
      const nx = g(_p.x - e, _p.z) - g(_p.x + e, _p.z);
      const nz = g(_p.x, _p.z - e) - g(_p.x, _p.z + e);
      _v.set(nx, 2 * e, nz).normalize();
      const vn = this.velocity.dot(_v);
      const scale = Math.min(pen, 1.5);
      // Hard bump: a stiff spring plus a strong damper against inward motion.
      _v.multiplyScalar(hull.mass * (G * 4 * scale + Math.max(0, -vn) * 8));
      force.add(_v);
      this.contacts.push(pen);
      // friction / scrape slows the boat down a lot
      force.addScaledVector(this.velocity, -hull.mass * 2.5 * Math.min(1, scale));
    }
  }
}

const _w2 = new THREE.Vector3();
