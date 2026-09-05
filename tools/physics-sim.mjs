// Headless physics checks.
//   node tools/physics-sim.mjs [hull,hull,...]   boats: full throttle for 5 s, then full right lock; prints speed, heading, yaw rate, bank per second
//   node tools/physics-sim.mjs sub               submarine: dive/hold/surface/yaw/roll/wall tests (exit 1 on failure)
//   node tools/physics-sim.mjs                   both
import { BoatPhysics, HULLS } from '../src/game/BoatPhysics.js';
import { SubPhysics } from '../src/game/Submarine.js';
import * as THREE from 'three';

const arg = process.argv[2];
const sea = { lastDhdt: 0, sample(x, z, out) { return out.set(0, 0, 0); }, heightAt() { return 0; } };

if (arg !== 'sub') {
  for (const name of (arg ? arg.split(',') : ['speedboat', 'jetski', 'fishing', 'tug', 'airboat', 'towboat', 'rowboat'])) {
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
}

if (!arg || arg === 'sub') {
  let failures = 0;
  const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };
  const deg = (r) => r * 57.2958;
  const dt = 1 / 60;
  const run = (s, seconds, input, every = null) => {
    let maxRoll = 0;
    for (let i = 0, n = Math.round(seconds / dt); i < n; i++) {
      input(s, i * dt);
      s.update(dt);
      maxRoll = Math.max(maxRoll, Math.abs(deg(s.roll)));
      if (every && i % 60 === 59) every(s, (i + 1) * dt);
    }
    return maxRoll;
  };
  const flat = { groundFn: () => -60, ceilingFn: () => 0 };

  console.log('\nsubmarine');
  // 1. Float at the surface with no input: the hull top sits at the waterline and stays there.
  let s = new SubPhysics(flat);
  s.setPose(0, -0.5, 0, 0);
  run(s, 6, (b) => { b.throttle = 0; b.dive = 0; });
  console.log(`  surfaced rest: y=${s.position.y.toFixed(2)} depth=${s.depth.toFixed(2)} submersion=${s.submersion.toFixed(2)} ballast=${s.ballast.toFixed(2)}`);
  check(s.position.y > -0.9 && s.position.y < -0.2 && Math.abs(s.velocity.y) < 0.05, 'floats at the surface with the hull top out of the water');

  // 2. Surfaced driving: a slow boat, ~20 km/h.
  run(s, 10, (b) => { b.throttle = 1; b.dive = 0; });
  console.log(`  surfaced cruise: ${s.speedKmh.toFixed(1)} km/h depth=${s.depth.toFixed(2)}`);
  check(s.speedKmh > 17 && s.speedKmh < 23, 'surfaced top speed ~20 km/h');
  check(s.depth < 1.5, 'stays surfaced while driving with the stick centred');

  // 3. Dive to 30 m at full throttle, then centre the stick and hold for 10 s.
  let tDive = null, maxDiveRoll = 0, minPitch = 0;
  maxDiveRoll = run(s, 40, (b, t) => { b.throttle = 1; b.dive = b.depth < 30 ? -1 : 0; if (b.depth >= 30 && tDive === null) tDive = t; minPitch = Math.min(minPitch, deg(b.pitch)); }, null);
  // The last step of `run` above may already be holding; re-run a clean hold from here.
  const holdRef = s.depth;
  const log = [];
  let minD = Infinity, maxD = -Infinity;
  run(s, 10, (b) => { b.throttle = 1; b.dive = 0; }, (b, t) => { log.push(`${t.toFixed(0)}s depth=${b.depth.toFixed(2)} pitch=${deg(b.pitch).toFixed(1)} v=${b.speedKmh.toFixed(1)}`); if (t > 2) { minD = Math.min(minD, b.depth); maxD = Math.max(maxD, b.depth); } });
  console.log(`  dive: nose down to ${minPitch.toFixed(1)} deg, reached 30 m at t=${tDive?.toFixed(1)} s; hold from ${holdRef.toFixed(2)} m -> [${minD.toFixed(2)}, ${maxD.toFixed(2)}] cruise ${s.speedKmh.toFixed(1)} km/h`);
  console.log('    ' + log.join(' | '));
  check(tDive !== null && tDive < 20, 'reaches 30 m within 20 s');
  check(minPitch < -15 && minPitch > -25, 'planes pitch the nose down ~20 deg while diving');
  check(maxD - minD < 2 && Math.abs(s.depth - holdRef) < 1.0 + Math.abs(holdRef - 30) , 'holds depth within +-1 m at cruise');
  check(s.speedKmh > 27 && s.speedKmh < 33, 'submerged top speed ~30 km/h');

  // 4. Full-lock yaw at cruise: 0.5..0.9 rad/s, roll never past 15 deg.
  let yawSum = 0, yawN = 0;
  const maxRollTurn = run(s, 6, (b, t) => { b.throttle = 1; b.steer = 1; b.dive = 0; if (t > 2) { yawSum += -b.angular.dot(b.up); yawN++; } });
  const yawRate = yawSum / yawN;
  console.log(`  full lock: yaw rate ${yawRate.toFixed(2)} rad/s (positive = bow toward -X = right), max roll ${maxRollTurn.toFixed(1)} deg, depth ${s.depth.toFixed(2)}`);
  check(yawRate > 0.5 && yawRate < 0.9, 'full-lock yaw rate 0.5..0.9 rad/s');
  check(maxRollTurn < 15 && maxDiveRoll < 15, 'roll never exceeds 15 deg');
  // Turning at stop (bow thruster).
  run(s, 6, (b) => { b.throttle = 0; b.steer = 0; });
  yawSum = 0; yawN = 0;
  run(s, 5, (b, t) => { b.throttle = 0; b.steer = 1; if (t > 2) { yawSum += -b.angular.dot(b.up); yawN++; } });
  console.log(`  stopped, full lock: yaw rate ${(yawSum / yawN).toFixed(2)} rad/s`);
  check(yawSum / yawN > 0.2, 'turns on the spot with the thruster');

  // 5. Surface and float.
  let tSurf = null;
  run(s, 40, (b, t) => { b.throttle = 0.5; b.steer = 0; b.dive = b.depth > 1.2 ? 1 : 0; if (b.depth <= 1.2 && tSurf === null) tSurf = t; });
  run(s, 6, (b) => { b.throttle = 0; b.dive = 0; });
  console.log(`  surfaced at t=${tSurf?.toFixed(1)} s; rest y=${s.position.y.toFixed(2)} vy=${s.velocity.y.toFixed(3)} pitch=${deg(s.pitch).toFixed(1)}`);
  check(tSurf !== null && s.position.y > -0.9 && s.position.y < -0.2 && Math.abs(s.velocity.y) < 0.05, 'surfaces and floats again');

  // 6. Canyon wall at 30 km/h: a vertical step from -60 to 0 at x = 40. Never tunnels.
  s = new SubPhysics({ groundFn: (x) => (x > 40 ? 0 : -60), ceilingFn: () => 0 });
  s.setPose(0, -12, 0, Math.PI / 2);   // heading +X
  let maxX = -Infinity;
  run(s, 12, (b) => { b.throttle = 1; b.dive = 0; b.steer = 0; maxX = Math.max(maxX, b.position.x); });
  console.log(`  wall: max x ${maxX.toFixed(2)} (wall at 40, hull half length 3), final speed ${s.speedKmh.toFixed(1)} km/h, y=${s.position.y.toFixed(1)}`);
  check(maxX < 40, 'never passes through a canyon wall at full speed');
  // 7. Sloping seabed: driving into a 30 deg slope rides up and scrapes, no explosion.
  s = new SubPhysics({ groundFn: (x) => Math.max(-60, -30 + x * 0.6), ceilingFn: () => 0 });
  s.setPose(-40, -25, 0, Math.PI / 2);
  let ok = true;
  run(s, 12, (b) => { b.throttle = 1; b.dive = -1; if (!Number.isFinite(b.position.y) || b.speed > 15) ok = false; });
  console.log(`  slope: final x=${s.position.x.toFixed(1)} y=${s.position.y.toFixed(1)} ground=${s.groundFn(s.position.x, s.position.z).toFixed(1)} speed=${s.speedKmh.toFixed(1)}`);
  check(ok && s.position.y - 0.95 >= s.groundFn(s.position.x, s.position.z) - 0.7, 'rides a slope without sinking into it');
  // 8. Rescue from inside terrain.
  s.setPose(60, -20, 0, 0);
  s.rescue();
  console.log(`  rescue -> x=${s.position.x.toFixed(1)} y=${s.position.y.toFixed(1)} ground=${s.groundFn(s.position.x, s.position.z).toFixed(1)}`);
  check(s.position.y - 0.95 > s.groundFn(s.position.x, s.position.z) + 1, 'rescue finds open water');

  console.log(failures ? `\n${failures} sub check(s) FAILED` : '\nall sub checks passed');
  if (failures) process.exit(1);
}
