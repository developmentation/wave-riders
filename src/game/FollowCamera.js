import * as THREE from 'three';

const _v = new THREE.Vector3(), _look = new THREE.Vector3(), _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);

/**
 * Chase camera that plugs into CinematicCamera as its `diveController`.
 *
 * Sits behind and above the boat, pulls back and widens as speed builds, looks
 * a little ahead of the bow so turns read early, and never dips into a wave:
 * the sampled sea surface under the lens sets a hard floor. Position is
 * critically damped; orientation follows the boat's heading with a little lag
 * so wave-slaps do not shake the view.
 */
export const VIEWS = [
  { name: 'chase', dist: 1.9, height: 0.75, lookAhead: 1.6, lookUp: 0.35, fov: 52 },
  { name: 'close', dist: 1.25, height: 0.55, lookAhead: 2.0, lookUp: 0.2, fov: 60 },
  { name: 'high', dist: 2.8, height: 1.7, lookAhead: 1.2, lookUp: 0.0, fov: 46 },
];

export class FollowCamera {
  constructor(app, sea) {
    this.app = app;
    this.camera = app.camera;
    this.sea = sea;
    this.boat = null;
    this.viewIndex = 0;
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.headingSmooth = 0;
    this.fov = 52;
    this.shake = 0;
    this._first = true;
    this.enabled = true;
    this.orbit = null; // {angle, dist, height} for garage / title
  }

  follow(boat) { this.boat = boat; this._first = true; }
  nextView() { this.viewIndex = (this.viewIndex + 1) % VIEWS.length; }
  impulse(a) { this.shake = Math.min(1.5, this.shake + a); }

  /** Called by CinematicCamera each frame (diveController protocol). */
  updateCamera(dt, time) {
    if (!this.boat || !this.enabled) return;
    const cam = this.camera, b = this.boat;
    const L = b.hull.length;

    if (this.orbit) {
      const o = this.orbit;
      o.angle += dt * (o.speed ?? 0.25);
      _v.set(Math.sin(o.angle) * L * o.dist, L * o.height, Math.cos(o.angle) * L * o.dist).add(b.position);
      const floor = this.sea.heightAt(_v.x, _v.z) + 1.0;
      if (_v.y < floor) _v.y = floor;
      this.pos.lerp(_v, this._first ? 1 : 1 - Math.exp(-dt * 3));
      _look.copy(b.position); _look.y += L * 0.12;
      this.look.lerp(_look, this._first ? 1 : 1 - Math.exp(-dt * 4));
      this._apply(dt, o.fov ?? 40);
      return;
    }

    const view = VIEWS[this.viewIndex];
    // Heading lags the hull so wave yaw does not whip the camera.
    let dh = b.heading - this.headingSmooth;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.headingSmooth += dh * (this._first ? 1 : 1 - Math.exp(-dt * 3.5));
    const speedK = THREE.MathUtils.clamp(b.speed / b.hull.maxSpeed, 0, 1.2);
    // Big seas need a higher, longer view or the boat vanishes behind every crest.
    const hs = this.app.ocean?.significantWaveHeight || 0;
    const dist = L * view.dist * (1 + speedK * 0.35) + hs * 0.9;
    const height = L * view.height * (1 + speedK * 0.15) + 0.6 + hs * 0.75;

    const fx = Math.sin(this.headingSmooth), fz = Math.cos(this.headingSmooth);
    _v.set(b.position.x - fx * dist, b.position.y + height, b.position.z - fz * dist);
    // Keep the lens clear of the sea whatever the swell is doing.
    const surf = this.sea.heightAt(_v.x, _v.z);
    const minY = surf + 1.4 + hs * 0.45;
    if (_v.y < minY) _v.y = minY;

    const k = this._first ? 1 : 1 - Math.exp(-dt * 6);
    this.pos.lerp(_v, k);
    // Vertical follows a bit slower so the boat bobs in frame rather than the frame bobbing.
    _look.set(b.position.x + fx * L * view.lookAhead, b.position.y + L * view.lookUp + 0.3, b.position.z + fz * L * view.lookAhead);
    this.look.lerp(_look, this._first ? 1 : 1 - Math.exp(-dt * 8));

    const fov = view.fov + speedK * 8;
    this._apply(dt, fov);
  }

  _apply(dt, fovTarget) {
    const cam = this.camera;
    this.fov += (fovTarget - this.fov) * (this._first ? 1 : 1 - Math.exp(-dt * 3));
    // Landing shake
    const s = this.shake;
    cam.position.copy(this.pos);
    if (s > 0.001) {
      cam.position.x += Math.sin(performance.now() * 0.031) * s * 0.12;
      cam.position.y += Math.sin(performance.now() * 0.047) * s * 0.10;
      this.shake *= Math.exp(-dt * 5);
    }
    _m.lookAt(cam.position, this.look, _up);
    cam.quaternion.setFromRotationMatrix(_m);
    cam.fov = this.fov;
    cam.updateProjectionMatrix();
    this.app.cine.focusDistance = cam.position.distanceTo(this.look);
    this._first = false;
  }

  // CinematicCamera calls these when in free mode; we never are, but keep the protocol.
  constrain() {}
  applyFlow() {}
}
