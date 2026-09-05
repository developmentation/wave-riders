// Headless boat-physics check: full throttle for 5 s, then full right lock. Prints speed, heading, yaw rate and bank per second.
// node tools/physics-sim.mjs [hull,hull,...]
import { BoatPhysics, HULLS } from '../src/game/BoatPhysics.js';
import * as THREE from 'three';
const sea = { lastDhdt: 0, sample(x, z, out) { return out.set(0, 0, 0); }, heightAt() { return 0; } };
for (const name of (process.argv[2] ? process.argv[2].split(',') : ['speedboat', 'jetski', 'fishing', 'tug', 'airboat', 'towboat', 'rowboat'])) {
  const b = new BoatPhysics(HULLS[name], sea);
  b.setPose(0, 0, 0, 0);
  const dt = 1 / 60; let t = 0, last = 0;
  const log = [];
  for (let i = 0; i < 60 * 12; i++) {
    b.throttle = 1; b.steer = t > 5 ? 1 : 0;
    b.update(dt, null); t += dt;
    if (t - last >= 1) { last = t; log.push(`${t.toFixed(0)}s v=${b.speedKmh.toFixed(0)} hdg=${b.heading.toFixed(2)} yaw=${b.angular.y.toFixed(2)} roll=${(Math.asin(b.right.y)*57.3).toFixed(0)}deg sub=${b.submersion.toFixed(2)}`); }
  }
  console.log(name); console.log(log.join('\n'));
}
