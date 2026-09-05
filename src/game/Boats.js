import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { HULLS, BoatPhysics } from './BoatPhysics.js';
import { PropMaterial, convertToProps, trackMotion } from './PropMaterial.js';

/**
 * Boat catalog and visuals.
 *
 * Every visual is a THREE.Group whose local +Z is the hull's forward axis
 * (what BoatPhysics integrates), origin at the body's centre of mass, keel at
 * the depth that puts the hull's waterline on the still-water surface once the
 * buoyancy springs have settled. Speedboat and sailboat are the CC0 Kenney
 * GLBs; jet ski and pontoon are built here from primitives in the same
 * chunky flat-colour toy style. Each group carries `update(dt, body, wind)`
 * for propeller spin, sail trim, flag flutter and the kid at the helm.
 */
const MODEL_BASE = './models/kenney-watercraft/';

/** Kenney colormap palette, matched by eye to Textures/colormap.png. */
export const PALETTE = {
  white: 0xf4f4f8, cream: 0xffe6c4, sand: 0xe6c79c,
  red: 0xd84c48, orange: 0xff7a3d, yellow: 0xffc236, green: 0x49c687,
  blue: 0x5a8fdd, navy: 0x4f52c6, sky: 0xa9d9fb, purple: 0x9d6cf0,
  dark: 0x33343b, slate: 0x585d70, steel: 0xb7bccb, glass: 0xc6ecff,
  skin: 0xf3b98e, tan: 0xd39a6e, brown: 0xa35c3a,
};

export const BOAT_CATALOG = {
  jetski: {
    id: 'jetski', label: 'Jet Ski', hull: 'jetski', kind: 'procedural', file: null,
    modelLength: 3.3, yaw: 0, lift: 0, waterline: 0.24,
    colors: [PALETTE.yellow, PALETTE.orange, PALETTE.green, PALETTE.purple],
    description: 'Zippy and bouncy — jump the waves!', icon: '🏄',
  },
  speedboat: {
    id: 'speedboat', label: 'Speedboat', hull: 'speedboat', kind: 'glb',
    file: 'boat-speed-a.glb', modelLength: 3.37, yaw: 0, lift: 0, waterline: 0.36,
    // Colour variants are different Kenney hulls (index → variants[i]).
    variants: [
      { file: 'boat-speed-a.glb', length: 3.37 },
      { file: 'boat-speed-b.glb', length: 3.29 },
      { file: 'boat-speed-c.glb', length: 3.17 },
      { file: 'boat-speed-g.glb', length: 3.81 },
      { file: 'boat-speed-i.glb', length: 3.87 },
      { file: 'boat-speed-j.glb', length: 4.27 },
    ],
    colors: [PALETTE.red, PALETTE.blue, PALETTE.green, PALETTE.yellow, PALETTE.orange, PALETTE.purple],
    description: 'The fastest boat on the water!', icon: '🚤',
  },
  sailboat: {
    id: 'sailboat', label: 'Sailboat', hull: 'sailboat', kind: 'glb',
    file: 'boat-sail-a.glb', modelLength: 3.77, yaw: 0, lift: 0, waterline: 0.55,
    variants: [
      { file: 'boat-sail-a.glb', length: 3.77 },
      { file: 'boat-sail-b.glb', length: 4.07 },
    ],
    colors: [PALETTE.white, PALETTE.red],
    description: 'Catch the wind and glide!', icon: '⛵',
  },
  pontoon: {
    id: 'pontoon', label: 'Pontoon', hull: 'pontoon', kind: 'procedural', file: null,
    modelLength: 7.0, yaw: 0, lift: 0, waterline: 0.3,
    colors: [PALETTE.blue, PALETTE.red, PALETTE.green, PALETTE.purple],
    description: 'Slow and steady party boat — toot the horn!', icon: '🛥️',
  },
};

// ------------------------------------------------------------------ helpers
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();
const gltfCache = new Map();

/**
 * Body-origin height above still water once the springs carry the weight
 * (negative: the origin sits below the surface). BoatPhysics sizes each
 * spring so the points settle at depth draft / 1.35.
 */
function restHeight(hull) {
  const pts = hull.buoyancyPoints;
  const meanY = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return -hull.draft / 1.35 - meanY;
}

/** Vertical position of the keel (model y = 0) in body space. */
function keelY(spec) {
  const hull = HULLS[spec.hull];
  return -(restHeight(hull) + spec.waterline) + spec.lift;
}

/**
 * Collects geometry per material and merges it into one mesh per material
 * so a procedural boat costs a handful of draw calls. Animated parts ask for
 * their own mesh with `mesh()`.
 */
class Builder {
  constructor(atmosphere) {
    this.atmosphere = atmosphere;
    this.mats = new Map();
    this.bins = new Map();
    this.tris = 0;
  }

  /** @param {number|string} color palette key or hex */
  mat(color, opts = {}) {
    const hex = typeof color === 'string' ? PALETTE[color] : color;
    const key = `${hex}|${opts.roughness ?? 0.5}|${opts.metal ?? 0}|${opts.side ?? 0}|${opts.flagWave ?? 0}`;
    let m = this.mats.get(key);
    if (!m) {
      m = new PropMaterial({ color: hex, roughness: opts.roughness ?? 0.5, metal: opts.metal ?? 0, side: opts.side, flagWave: opts.flagWave }, this.atmosphere);
      this.mats.set(key, m);
    }
    return m;
  }

  /** Queue a geometry for merging. `place` = [x, y, z] or a Matrix4. */
  add(geo, color, place, opts) {
    if (place) {
      if (place.isMatrix4) geo.applyMatrix4(place);
      else geo.translate(place[0], place[1], place[2]);
    }
    const m = this.mat(color, opts);
    if (!this.bins.has(m)) this.bins.set(m, []);
    this.bins.get(m).push(geo.index ? geo.toNonIndexed() : geo);
    return geo;
  }

  /** Standalone mesh for parts that move on their own. */
  mesh(geo, color, opts) {
    const mesh = new THREE.Mesh(geo, this.mat(color, opts));
    this.tris += triCount(geo);
    return trackMotion(mesh);
  }

  /** Merge queued geometry into `parent`, one mesh per material. */
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

function triCount(g) { return (g.index ? g.index.count : g.attributes.position.count) / 3; }
function countTris(root) { let n = 0; root.traverse(o => { if (o.isMesh) n += triCount(o.geometry); }); return n; }

function box(w, h, d) { return new THREE.BoxGeometry(w, h, d); }
function rbox(w, h, d, r) { return new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w / 2, h / 2, d / 2)); }
function cyl(rTop, rBot, h, seg = 12) { return new THREE.CylinderGeometry(rTop, rBot, h, seg); }
function sphere(r, w = 10, h = 7) { return new THREE.SphereGeometry(r, w, h); }
/** Cylinder lying along +z (bow-ward), centred. */
function tube(r, len, seg = 12) { return cyl(r, r, len, seg).rotateX(Math.PI / 2); }
/** Cylinder lying along x (athwartships). */
function bar(r, len, seg = 8) { return cyl(r, r, len, seg).rotateZ(Math.PI / 2); }

function mat4(x, y, z, rx = 0, ry = 0, rz = 0, s = 1) {
  const m = new THREE.Matrix4();
  m.makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
  m.scale(new THREE.Vector3(s, s, s));
  m.setPosition(x, y, z);
  return m;
}

/**
 * Plan-view hull outline extruded upward. `profile` is [[z, halfWidth], ...]
 * from stern to bow. With a bevel the body swells by `bevel` and the total
 * height stays `height`, base at y0.
 */
function hullSlab(profile, y0, height, bevel = 0, scaleW = 1) {
  const shape = new THREE.Shape();
  const pts = profile.map(([z, w]) => [z, Math.max(0.01, w * scaleW - bevel)]);
  // ExtrudeGeometry extrudes along +z; rotateX(-PI/2) maps shape (x, y) → (x, -z), so shape y = -z.
  pts.forEach(([z, w], i) => (i ? shape.lineTo(w, -z) : shape.moveTo(w, -z)));
  for (let i = pts.length - 1; i >= 0; i--) shape.lineTo(-pts[i][1], -pts[i][0]);
  shape.closePath();
  const depth = Math.max(0.01, height - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 3,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0 + bevel, 0);
  g.computeVertexNormals();
  return g;
}

/** A fluttering pennant hanging off a pole tip at (0,0,0), trailing aft (-z). */
function flag(B, color, len = 0.55, h = 0.3) {
  const g = new THREE.PlaneGeometry(h, len, 1, 6);
  // uv.y is 0 on the pole edge and 1 at the free end: that is the shader's flutter weight.
  g.rotateX(-Math.PI / 2).rotateZ(Math.PI / 2).translate(0, -h / 2, -len / 2);
  const m = B.mesh(g, color, { side: THREE.DoubleSide, flagWave: 1, roughness: 0.7 });
  return m;
}

// ------------------------------------------------------------------- driver
/**
 * Procedural kid at the helm: big round head, helmet or hair, life vest,
 * arms reaching the given hand targets (figure-local, metres before scale).
 * `update(dt, steer, speedK, accelK)` leans the torso into turns and pulls
 * it back under acceleration.
 */
function buildDriver(B, { scale = 1, vest = 'orange', shirt = 'white', helmet = 'red', hair = false, skin = 'skin', shorts = 'navy',
  hands = [[-0.26, 0.3, 0.45], [0.26, 0.3, 0.45]], pitch = 0, legs = 'seated' } = {}) {
  const root = new THREE.Group();
  root.scale.setScalar(scale);
  const torso = new THREE.Group();
  root.add(torso);
  const head = new THREE.Group();
  head.position.set(0, 0.52, 0);
  torso.add(head);

  // body: shirt under a chunky life vest with a white zip panel
  torso.add(B.mesh(box(0.32, 0.42, 0.22).translate(0, 0.22, 0), shirt, { roughness: 0.6 }));
  torso.add(B.mesh(rbox(0.38, 0.34, 0.3, 0.08).translate(0, 0.24, 0), vest, { roughness: 0.6 }));
  torso.add(B.mesh(box(0.08, 0.26, 0.04).translate(0, 0.24, 0.15), 'white', { roughness: 0.6 }));
  torso.add(B.mesh(cyl(0.06, 0.06, 0.1, 6).translate(0, 0.46, 0), skin, { roughness: 0.7 })); // neck
  // big round kid head
  head.add(B.mesh(sphere(0.19, 10, 7), skin, { roughness: 0.7 }));
  if (hair) {
    head.add(B.mesh(new THREE.SphereGeometry(0.2, 10, 4, 0, Math.PI * 2, 0, Math.PI * 0.5).translate(0, 0.02, -0.02), helmet, { roughness: 0.8 }));
  } else {
    head.add(B.mesh(new THREE.SphereGeometry(0.215, 10, 5, 0, Math.PI * 2, 0, Math.PI * 0.55).translate(0, 0.02, 0), helmet, { roughness: 0.35 }));
    head.add(B.mesh(box(0.3, 0.035, 0.14).translate(0, -0.005, 0.2), 'dark', { roughness: 0.4 })); // visor peak
  }
  // eyes: two dots read as a face from a long way off
  const eyes = mergeGeometries([sphere(0.028, 5, 3).translate(-0.07, 0.0, 0.175), sphere(0.028, 5, 3).translate(0.07, 0.0, 0.175)].map(g => g.toNonIndexed()), false);
  head.add(B.mesh(eyes, 'dark', { roughness: 0.3 }));

  // arms: from shoulders to the hand targets
  const shoulders = [[-0.2, 0.38, 0.02], [0.2, 0.38, 0.02]];
  for (let i = 0; i < 2; i++) {
    const sh = new THREE.Vector3(...shoulders[i]), h = new THREE.Vector3(...hands[i]);
    const dir = h.clone().sub(sh), len = dir.length();
    const arm = cyl(0.05, 0.042, len, 6).translate(0, len / 2, 0);
    _q.setFromUnitVectors(_up, dir.normalize());
    arm.applyQuaternion(_q).translate(sh.x, sh.y, sh.z);
    torso.add(B.mesh(arm, shirt, { roughness: 0.6 }));
    torso.add(B.mesh(sphere(0.06, 5, 4).translate(h.x, h.y, h.z), skin, { roughness: 0.7 }));
  }
  // legs
  if (legs === 'seated') {
    root.add(B.mesh(mergeGeometries([box(0.15, 0.13, 0.4).translate(-0.1, -0.05, 0.2), box(0.15, 0.13, 0.4).translate(0.1, -0.05, 0.2)], false), shorts, { roughness: 0.7 }));
    root.add(B.mesh(mergeGeometries([box(0.13, 0.36, 0.13).translate(-0.1, -0.28, 0.4), box(0.13, 0.36, 0.13).translate(0.1, -0.28, 0.4)], false), skin, { roughness: 0.7 }));
    root.add(B.mesh(mergeGeometries([box(0.14, 0.09, 0.22).translate(-0.1, -0.48, 0.45), box(0.14, 0.09, 0.22).translate(0.1, -0.48, 0.45)], false), 'white', { roughness: 0.6 }));
  } else if (legs === 'standing') {
    root.add(B.mesh(mergeGeometries([box(0.15, 0.62, 0.15).translate(-0.1, -0.31, 0), box(0.15, 0.62, 0.15).translate(0.1, -0.31, 0)], false), shorts, { roughness: 0.7 }));
    root.add(B.mesh(mergeGeometries([box(0.14, 0.09, 0.24).translate(-0.1, -0.64, 0.04), box(0.14, 0.09, 0.24).translate(0.1, -0.64, 0.04)], false), 'white', { roughness: 0.6 }));
  }

  const state = { lean: 0, pitch: 0 };
  root.update = (dt, steer, speedK, accelK) => {
    const k = 1 - Math.exp(-dt * 5);
    state.lean += ((-steer * 0.3) * (0.4 + 0.6 * speedK) - state.lean) * k;
    state.pitch += ((pitch - accelK * 0.14 + speedK * 0.06) - state.pitch) * k;
    torso.rotation.z = state.lean;
    torso.rotation.x = state.pitch;
    head.rotation.z = state.lean * 0.7;
    head.rotation.y = -state.lean * 0.8;   // glances into the turn
  };
  return root;
}

// ------------------------------------------------------------------ jet ski
function buildJetski(B, color) {
  const g = new THREE.Group();
  // Plan outline (stern → bow), half widths.
  const outline = [[-1.62, 0.5], [-1.3, 0.6], [-0.4, 0.62], [0.45, 0.6], [0.95, 0.5], [1.35, 0.3], [1.6, 0.08]];
  // stepped V hull: white keel step, white main hull, coloured deck, hood
  B.add(hullSlab(outline, 0.0, 0.2, 0.05, 0.62), 'white', null, { roughness: 0.35 });
  B.add(hullSlab(outline, 0.12, 0.3, 0.06, 0.96), 'white', null, { roughness: 0.35 });
  B.add(hullSlab(outline, 0.36, 0.08, 0.02, 1.02), 'dark', null, { roughness: 0.85 });    // rubber rub rail
  B.add(hullSlab(outline, 0.42, 0.2, 0.07, 0.97), color, null, { roughness: 0.4 });          // deck
  const hood = [[0.05, 0.5], [0.5, 0.5], [0.95, 0.42], [1.3, 0.22], [1.5, 0.05]];
  B.add(hullSlab(hood, 0.6, 0.26, 0.09, 0.9), color, null, { roughness: 0.4 });              // hood
  B.add(hullSlab([[0.1, 0.38], [0.6, 0.35], [1.1, 0.22]], 0.84, 0.05, 0.02), 'white', null, { roughness: 0.4 }); // hood stripe
  // footwell rubber mats
  B.add(box(0.22, 0.04, 1.35), 'dark', [-0.44, 0.62, -0.55], { roughness: 0.9 });
  B.add(box(0.22, 0.04, 1.35), 'dark', [0.44, 0.62, -0.55], { roughness: 0.9 });
  // seat: dark base, coloured saddle stripe, white piping
  B.add(rbox(0.46, 0.22, 1.45, 0.08), 'dark', [0, 0.74, -0.6], { roughness: 0.75 });
  B.add(box(0.34, 0.06, 1.2), 'white', [0, 0.85, -0.6], { roughness: 0.7 });
  B.add(box(0.22, 0.05, 1.05), color, [0, 0.885, -0.62], { roughness: 0.7 });
  // rear grab handle + boarding step
  B.add(box(0.6, 0.05, 0.3), 'dark', [0, 0.5, -1.55], { roughness: 0.85 });
  B.add(bar(0.03, 0.4, 8), 'steel', [0, 0.72, -1.36], { roughness: 0.3, metal: 0.7 });
  // console pod + handlebar
  B.add(rbox(0.36, 0.3, 0.42, 0.06), 'dark', [0, 0.98, 0.42], { roughness: 0.6 });
  B.add(box(0.16, 0.1, 0.05), 'sky', [0, 1.06, 0.62], { roughness: 0.2 });          // dash display
  const bars = new THREE.Group();
  bars.position.set(0, 1.14, 0.38);
  const barGeo = mergeGeometries([
    bar(0.03, 0.74, 8).toNonIndexed(),
    cyl(0.03, 0.03, 0.12, 8).translate(0, -0.06, 0).toNonIndexed(),
  ], false);
  bars.add(B.mesh(barGeo, 'steel', { roughness: 0.3, metal: 0.7 }));
  bars.add(B.mesh(mergeGeometries([bar(0.045, 0.16, 8).translate(-0.33, 0, 0).toNonIndexed(), bar(0.045, 0.16, 8).translate(0.33, 0, 0).toNonIndexed()], false), 'dark', { roughness: 0.9 }));
  g.add(bars);
  // windshield
  B.add(box(0.5, 0.26, 0.03), 'glass', mat4(0, 1.1, 0.72, -0.5), { roughness: 0.12 });
  // mirrors
  B.add(box(0.1, 0.07, 0.05), 'dark', [-0.36, 1.08, 0.66], { roughness: 0.6 });
  B.add(box(0.1, 0.07, 0.05), 'dark', [0.36, 1.08, 0.66], { roughness: 0.6 });
  // intake grate
  B.add(box(0.3, 0.03, 0.8), 'dark', [0, 0.005, -0.7], { roughness: 0.9 });
  const nozzle = new THREE.Group();
  nozzle.position.set(0, 0.16, -1.66);
  nozzle.add(B.mesh(cyl(0.1, 0.13, 0.26, 12).rotateX(Math.PI / 2).translate(0, 0, -0.12), 'dark', { roughness: 0.7 }));
  nozzle.add(B.mesh(cyl(0.07, 0.07, 0.02, 12).rotateX(Math.PI / 2).translate(0, 0, -0.25), 'steel', { roughness: 0.3, metal: 0.7 }));
  g.add(nozzle);
  B.flush(g);

  // rider: sits forward on the saddle, leaning at the bars
  const driver = buildDriver(B, {
    scale: 0.92, vest: 'orange', shirt: PALETTE.white, helmet: color === PALETTE.orange ? PALETTE.navy : PALETTE.red, shorts: 'navy',
    hands: [[-0.36, 0.3, 0.6], [0.36, 0.3, 0.6]], pitch: 0.22,
  });
  driver.position.set(0, 0.86, -0.42);
  g.add(driver);

  const st = { steer: 0 };
  g.update = (dt, body) => {
    const speedK = Math.min(1, body.speed / body.hull.maxSpeed);
    const k = 1 - Math.exp(-dt * 8);
    st.steer += (body.steer - st.steer) * k;
    nozzle.rotation.y = -st.steer * 0.45;
    bars.rotation.y = -st.steer * 0.3;
    driver.update(dt, body.steer, speedK, Math.max(0, body.throttle) * (1 - speedK));
  };
  return g;
}

// ------------------------------------------------------------------ pontoon
function buildPontoon(B, color) {
  const g = new THREE.Group();
  const L = 6.6, deckY = 0.68;
  // twin aluminium tubes with tapered noses
  for (const x of [-1.0, 1.0]) {
    B.add(tube(0.33, L - 0.9, 12), 'steel', [x, 0.33, -0.15], { roughness: 0.3, metal: 0.75 });
    B.add(cyl(0.1, 0.33, 0.9, 12).rotateX(-Math.PI / 2), 'steel', [x, 0.33, L / 2 - 0.6], { roughness: 0.3, metal: 0.75 });
    B.add(cyl(0.33, 0.28, 0.2, 12).rotateX(Math.PI / 2), 'steel', [x, 0.33, -L / 2 + 0.2], { roughness: 0.3, metal: 0.75 });
    B.add(box(0.7, 0.14, L - 1.0), 'slate', [x, 0.62, -0.1], { roughness: 0.6 });  // tube brackets
  }
  // cross beams + deck
  B.add(box(2.4, 0.1, L - 0.6), 'slate', [0, 0.62, -0.05], { roughness: 0.6 });
  B.add(box(2.6, 0.12, L), 'sand', [0, deckY, 0], { roughness: 0.8 });
  B.add(box(2.66, 0.05, L + 0.06), 'white', [0, deckY - 0.06, 0], { roughness: 0.5 });   // deck trim
  // fence: coloured panels with white top rails and steel posts, gate at the bow
  const railY = deckY + 0.06;
  const panelH = 0.62;
  const panels = [
    // side panels
    [-1.27, -L / 2 + 0.05, -1.27, L / 2 - 0.9],
    [1.27, -L / 2 + 0.05, 1.27, L / 2 - 0.9],
    // stern panel
    [-1.27, -L / 2 + 0.05, 1.27, -L / 2 + 0.05],
    // bow panels with a gate gap in the middle
    [-1.27, L / 2 - 0.9, -0.45, L / 2 - 0.9],
    [0.45, L / 2 - 0.9, 1.27, L / 2 - 0.9],
  ];
  for (const [x0, z0, x1, z1] of panels) {
    const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz), ang = Math.atan2(dx, dz);
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    B.add(box(0.05, panelH * 0.6, len), color, mat4(cx, railY + panelH * 0.3 + 0.08, cz, 0, ang), { roughness: 0.5 });
    B.add(box(0.06, 0.08, len), 'white', mat4(cx, railY + panelH * 0.42 + 0.08, cz, 0, ang), { roughness: 0.5 });
    B.add(box(0.06, 0.05, len), 'white', mat4(cx, railY + 0.06, cz, 0, ang), { roughness: 0.5 });
    B.add(tube(0.035, len, 6), 'white', mat4(cx, railY + panelH + 0.05, cz, 0, ang), { roughness: 0.4 });
    for (const t of [0, 1]) {
      B.add(cyl(0.035, 0.035, panelH + 0.08, 6), 'steel', [x0 + dx * t, railY + panelH / 2 + 0.04, z0 + dz * t], { roughness: 0.3, metal: 0.7 });
    }
  }
  // bimini canopy over the helm and rear bench
  const canopyY = deckY + 2.25;
  for (const x of [-1.15, 1.15]) for (const z of [-2.5, 0.35]) {
    B.add(cyl(0.035, 0.035, canopyY - deckY, 6), 'steel', [x, (canopyY + deckY) / 2, z], { roughness: 0.3, metal: 0.7 });
  }
  B.add(rbox(2.7, 0.1, 3.3, 0.05), color, [0, canopyY + 0.02, -1.05], { roughness: 0.6 });
  B.add(box(2.72, 0.04, 0.5), 'white', [0, canopyY + 0.06, -1.05], { roughness: 0.6 });   // centre stripe
  B.add(box(2.7, 0.06, 3.3), 'white', [0, canopyY - 0.03, -1.05], { roughness: 0.6 });            // underside
  // helm console (starboard) with windshield and wheel
  const consoleX = 0.62, consoleZ = 0.1;
  B.add(rbox(0.8, 0.95, 0.55, 0.06), 'white', [consoleX, deckY + 0.06 + 0.475, consoleZ], { roughness: 0.4 });
  B.add(box(0.6, 0.08, 0.35), color, [consoleX, deckY + 1.0, consoleZ + 0.02], { roughness: 0.5 });
  B.add(box(0.78, 0.45, 0.03), 'glass', mat4(consoleX, deckY + 1.2, consoleZ + 0.2, -0.35), { roughness: 0.12 });
  B.add(box(0.2, 0.12, 0.05), 'sky', [consoleX, deckY + 0.86, consoleZ - 0.27], { roughness: 0.2 });
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.03, 6, 14), B.mat('dark', { roughness: 0.6 }));
  wheel.rotation.x = -0.35;
  wheel.position.set(consoleX, deckY + 0.95, consoleZ - 0.36);
  trackMotion(wheel); B.tris += triCount(wheel.geometry);
  const spokes = B.mesh(mergeGeometries([bar(0.02, 0.36, 6).toNonIndexed(), cyl(0.02, 0.02, 0.36, 6).toNonIndexed(), sphere(0.045, 8, 6).toNonIndexed()], false), 'dark', { roughness: 0.6 });
  wheel.add(spokes);
  g.add(wheel);
  B.add(cyl(0.05, 0.06, 0.18, 8).rotateX(-0.35), 'steel', [consoleX, deckY + 0.88, consoleZ - 0.28], { roughness: 0.3, metal: 0.7 });
  // captain's pedestal seat
  B.add(cyl(0.06, 0.06, 0.4, 8), 'steel', [consoleX, deckY + 0.26, consoleZ - 0.95], { roughness: 0.3, metal: 0.7 });
  B.add(box(0.6, 0.12, 0.55), 'white', [consoleX, deckY + 0.5, consoleZ - 0.95], { roughness: 0.6 });
  B.add(box(0.6, 0.55, 0.12), 'white', [consoleX, deckY + 0.8, consoleZ - 1.22], { roughness: 0.6 });
  B.add(rbox(0.48, 0.4, 0.06, 0.03), color, [consoleX, deckY + 0.8, consoleZ - 1.15], { roughness: 0.7 });
  // benches: stern L-bench and bow lounge, white bases with coloured cushions
  const bench = (x, z, w, d) => {
    B.add(box(w, 0.38, d), 'white', [x, deckY + 0.06 + 0.19, z], { roughness: 0.5 });
    B.add(rbox(w - 0.08, 0.12, d - 0.08, 0.05), color, [x, deckY + 0.06 + 0.44, z], { roughness: 0.75 });
  };
  bench(0, -2.85, 2.35, 0.6);         // stern bench
  bench(-0.95, -1.6, 0.55, 1.9);      // port side bench
  bench(-0.95, 1.4, 0.55, 1.6);       // port bow lounge
  bench(0.95, 1.6, 0.55, 1.2);        // starboard bow lounge
  // backrests along the fence for the stern bench
  B.add(rbox(2.3, 0.3, 0.1, 0.04), color, [0, deckY + 0.85, -3.15], { roughness: 0.75 });
  // cooler + tube: party boat props
  B.add(box(0.5, 0.36, 0.34), 'sky', [0.35, deckY + 0.24, 2.0], { roughness: 0.4 });
  B.add(box(0.52, 0.06, 0.36), 'white', [0.35, deckY + 0.44, 2.0], { roughness: 0.4 });
  // stern boarding ladder
  B.add(mergeGeometries([cyl(0.02, 0.02, 0.9, 6).translate(-0.7, 0.3, -3.42).toNonIndexed(), cyl(0.02, 0.02, 0.9, 6).translate(-0.4, 0.3, -3.42).toNonIndexed(),
    bar(0.02, 0.3, 6).translate(-0.55, 0.15, -3.42).toNonIndexed(), bar(0.02, 0.3, 6).translate(-0.55, 0.45, -3.42).toNonIndexed()], false), 'steel', null, { roughness: 0.3, metal: 0.7 });
  // flag pole at the stern quarter
  B.add(cyl(0.02, 0.025, 1.6, 6), 'white', [1.15, deckY + 0.7 + 0.8, -3.2], { roughness: 0.5 });
  B.flush(g);
  const pennant = flag(B, 'yellow', 0.7, 0.36);
  pennant.position.set(1.15, deckY + 2.28, -3.2);
  g.add(pennant);

  // outboard: pivots with the steering, propeller spins with throttle
  const motor = new THREE.Group();
  motor.position.set(0, deckY - 0.1, -L / 2 - 0.1);
  motor.add(B.mesh(rbox(0.56, 0.5, 0.7, 0.1).translate(0, 0.6, -0.2), 'dark', { roughness: 0.55 }));
  motor.add(B.mesh(box(0.5, 0.12, 0.55).translate(0, 0.9, -0.2), color, { roughness: 0.5 }));
  motor.add(B.mesh(box(0.3, 0.05, 0.4).translate(0, 0.6, -0.55), 'steel', { roughness: 0.3, metal: 0.7 }));
  motor.add(B.mesh(box(0.16, 1.05, 0.34).translate(0, -0.05, -0.2), 'dark', { roughness: 0.55 }));
  motor.add(B.mesh(tube(0.11, 0.6, 10).translate(0, -0.55, -0.15), 'dark', { roughness: 0.55 }));
  const prop = new THREE.Group();
  prop.position.set(0, -0.55, -0.5);
  const blades = [];
  for (let i = 0; i < 3; i++) {
    const b = box(0.1, 0.3, 0.03).translate(0, 0.17, 0);
    b.rotateY(0.6).rotateZ((i / 3) * Math.PI * 2);
    blades.push(b);
  }
  blades.push(cyl(0.05, 0.05, 0.1, 8).rotateX(Math.PI / 2));
  prop.add(B.mesh(mergeGeometries(blades.map(b => b.toNonIndexed()), false), 'steel', { roughness: 0.3, metal: 0.8 }));
  motor.add(prop);
  g.add(motor);

  // captain at the helm, passenger on the stern bench
  const captain = buildDriver(B, {
    scale: 1.15, vest: 'orange', shirt: PALETTE.white, helmet: PALETTE.yellow, hair: true, shorts: color === PALETTE.blue ? 'red' : 'navy',
    hands: [[-0.16, 0.32, 0.49], [0.16, 0.32, 0.49]], pitch: 0.05,
  });
  captain.position.set(consoleX, deckY + 0.58, consoleZ - 0.95);
  g.add(captain);
  const passenger = buildDriver(B, {
    scale: 1.05, vest: 'red', shirt: PALETTE.green, helmet: PALETTE.brown, hair: true, shorts: 'sky',
    hands: [[-0.42, 0.62, 0.15], [0.42, 0.62, 0.15]], pitch: -0.05,
  });
  passenger.position.set(0.6, deckY + 0.58, -2.75);
  g.add(passenger);

  const st = { steer: 0, spin: 0 };
  g.update = (dt, body, wind) => {
    const speedK = Math.min(1, body.speed / body.hull.maxSpeed);
    const k = 1 - Math.exp(-dt * 6);
    st.steer += (body.steer - st.steer) * k;
    motor.rotation.y = -st.steer * 0.5;
    wheel.rotation.z = -st.steer * 1.6;
    st.spin += dt * (0.6 + Math.abs(body.throttle) * 34);
    prop.rotation.z = st.spin;
    pennant.material.uniforms.uWave.value = 0.5 + Math.min(1.5, ((wind?.speed ?? 5) + body.speed) * 0.08);
    captain.update(dt, body.steer, speedK, Math.max(0, body.throttle) * (1 - speedK));
    passenger.update(dt, body.steer * 0.5, speedK, 0);
  };
  return g;
}

// ------------------------------------------------------------- GLB boats
async function loadKenney(loader, file) {
  if (!gltfCache.has(file)) gltfCache.set(file, loader.loadAsync(MODEL_BASE + file).then(g => g.scene));
  const scene = await gltfCache.get(file);
  return scene.clone(true);
}

async function buildSpeedboat(B, spec, ctx, colorIndex) {
  const g = new THREE.Group();
  const variant = spec.variants[colorIndex % spec.variants.length];
  const hull = HULLS[spec.hull];
  const s = hull.length / variant.length;
  const model = await loadKenney(ctx.loader, variant.file);
  convertToProps(model, ctx.atmosphere, { roughness: 0.4 });
  B.tris += countTris(model);
  model.scale.setScalar(s);
  model.rotation.y = spec.yaw;
  model.position.y = keelY(spec);
  g.add(model);
  // rig in metres, same frame as the model
  const rig = new THREE.Group();
  rig.rotation.y = spec.yaw;
  rig.position.y = keelY(spec);
  g.add(rig);
  const K = (x, y, z) => [x * s, y * s, z * s];    // Kenney units → metres
  // steering wheel ahead of the seat
  const wheelPos = K(0, 1.02, -0.45);
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 6, 14), B.mat('dark', { roughness: 0.6 }));
  wheel.add(B.mesh(mergeGeometries([bar(0.02, 0.38, 6).toNonIndexed(), cyl(0.02, 0.02, 0.38, 6).toNonIndexed(), sphere(0.05, 8, 6).toNonIndexed()], false), 'dark', { roughness: 0.6 }));
  wheel.rotation.x = -0.45;
  wheel.position.set(...wheelPos);
  trackMotion(wheel); B.tris += triCount(wheel.geometry);
  rig.add(wheel);
  B.add(cyl(0.04, 0.05, 0.3, 8).rotateX(-0.45), 'steel', [wheelPos[0], wheelPos[1] - 0.05, wheelPos[2] + 0.12], { roughness: 0.3, metal: 0.7 });
  // pennant on the stern
  const polePos = K(0.72, 0.85, -1.4);
  B.add(cyl(0.02, 0.025, 1.1, 6), 'white', [polePos[0], polePos[1] + 0.55, polePos[2]], { roughness: 0.5 });
  B.flush(rig);
  const pennant = flag(B, spec.colors[colorIndex % spec.colors.length], 0.6, 0.32);
  pennant.position.set(polePos[0], polePos[1] + 1.08, polePos[2]);
  rig.add(pennant);
  // driver seated behind the wheel
  const seat = K(0, 0.92, -0.98);
  const ds = 1.2;
  const reach = [(wheelPos[0] - seat[0]) / ds, (wheelPos[1] - seat[1]) / ds, (wheelPos[2] - seat[2] + 0.05) / ds];
  const driver = buildDriver(B, {
    scale: ds, vest: 'orange', shirt: PALETTE.white, helmet: spec.colors[colorIndex % spec.colors.length], shorts: 'navy',
    hands: [[reach[0] - 0.18, reach[1], reach[2]], [reach[0] + 0.18, reach[1], reach[2]]], pitch: 0.08,
  });
  driver.position.set(...seat);
  rig.add(driver);

  const st = { steer: 0 };
  g.update = (dt, body, wind) => {
    const speedK = Math.min(1, body.speed / body.hull.maxSpeed);
    st.steer += (body.steer - st.steer) * (1 - Math.exp(-dt * 6));
    wheel.rotation.z = -st.steer * 1.8;
    pennant.material.uniforms.uWave.value = 0.5 + Math.min(1.5, ((wind?.speed ?? 5) + body.speed) * 0.08);
    driver.update(dt, body.steer, speedK, Math.max(0, body.throttle) * (1 - speedK));
  };
  return g;
}

async function buildSailboat(B, spec, ctx, colorIndex) {
  const g = new THREE.Group();
  const variant = spec.variants[colorIndex % spec.variants.length];
  const hull = HULLS[spec.hull];
  const s = hull.length / variant.length;
  const model = await loadKenney(ctx.loader, variant.file);
  convertToProps(model, ctx.atmosphere, { roughness: 0.45 });
  B.tris += countTris(model);
  // heel pivot: the model swings about the body origin
  const heelGroup = new THREE.Group();
  g.add(heelGroup);
  model.scale.setScalar(s);
  model.rotation.y = spec.yaw;
  model.position.y = keelY(spec);
  heelGroup.add(model);
  let sail = null;
  model.traverse(o => { if (o.name === 'sail') sail = o; });
  const rig = new THREE.Group();
  rig.rotation.y = spec.yaw;
  rig.position.y = keelY(spec);
  heelGroup.add(rig);
  const K = (x, y, z) => [x * s, y * s, z * s];
  // masthead pennant
  const top = K(0, 4.7, 0.58);
  if (variant.file === 'boat-sail-b.glb') { const t = K(0, 4.45, -0.3); top[0] = t[0]; top[1] = t[1]; top[2] = t[2]; }
  B.add(cyl(0.02, 0.02, 0.5, 6), 'white', [top[0], top[1] + 0.2, top[2]], { roughness: 0.5 });
  B.flush(rig);
  const pennant = flag(B, 'red', 0.7, 0.34);
  pennant.position.set(top[0], top[1] + 0.42, top[2]);
  rig.add(pennant);
  // helm: the kid steers a tiller from the cockpit
  const seat = K(0.0, 0.95, -1.15);
  const driver = buildDriver(B, {
    scale: 1.2, vest: 'yellow', shirt: PALETTE.white, helmet: PALETTE.red, hair: true, shorts: 'navy',
    hands: [[-0.15, 0.25, 0.42], [0.15, 0.25, 0.42]], pitch: 0.0,
  });
  driver.position.set(...seat);
  rig.add(driver);
  const tiller = B.mesh(cyl(0.025, 0.035, 1.0, 8).rotateX(Math.PI / 2 - 0.25).translate(0, 0.1, 0.5), 'brown', { roughness: 0.6 });
  tiller.position.set(seat[0], seat[1] + 0.12, seat[2] - 0.55);
  rig.add(tiller);

  const st = { sheet: 0, heel: 0, steer: 0 };
  g.update = (dt, body, wind) => {
    const speedK = Math.min(1, body.speed / body.hull.maxSpeed);
    const k = 1 - Math.exp(-dt * 2.5);
    // apparent wind in the boat frame (wind blows toward (cos a, sin a))
    const ws = wind?.speed ?? 5, wa = wind?.angle ?? 0;
    const awx = Math.cos(wa) * ws - body.velocity.x, awz = Math.sin(wa) * ws - body.velocity.z;
    const h = body.heading, ch = Math.cos(h), sh = Math.sin(h);
    const lx = awx * ch - awz * sh, lz = awx * sh + awz * ch;
    const rel = Math.atan2(lx, lz);              // 0 = wind from astern (running)
    const strength = Math.min(1, Math.hypot(lx, lz) / 10);
    const mag = 0.12 + 1.15 * (1 + Math.cos(rel)) * 0.5;
    const side = Math.abs(Math.sin(rel)) < 0.05 ? (st.sheet < 0 ? -1 : 1) : Math.sign(Math.sin(rel));
    st.sheet += (-side * mag - st.sheet) * k;
    if (sail) sail.rotation.y = st.sheet;
    // heel to leeward, more when the wind is on the beam
    const heelTarget = -Math.sin(rel) * strength * 0.22 * (0.4 + 0.6 * speedK);
    st.heel += (heelTarget - st.heel) * k;
    heelGroup.rotation.z = st.heel;
    st.steer += (body.steer - st.steer) * (1 - Math.exp(-dt * 6));
    tiller.rotation.y = st.steer * 0.5;
    pennant.material.uniforms.uWave.value = 0.5 + Math.min(1.5, (ws + body.speed) * 0.08);
    driver.update(dt, body.steer, speedK, 0);
  };
  return g;
}

// --------------------------------------------------------------- public API
/**
 * Build the visual for a catalog boat.
 * @param {string} id key of BOAT_CATALOG
 * @param {{ atmosphere: object, loader: GLTFLoader, colorIndex?: number }} ctx
 * @returns {Promise<THREE.Group>} group with .update(dt, body, wind), .spec, .triangles
 */
export async function buildBoatVisual(id, { atmosphere, loader, colorIndex = 0 } = {}) {
  const spec = BOAT_CATALOG[id];
  if (!spec) throw new Error(`unknown boat '${id}'`);
  const B = new Builder(atmosphere);
  const color = spec.colors[colorIndex % spec.colors.length];
  let g;
  if (id === 'jetski') {
    g = buildJetski(B, color);
    g.children.forEach(c => { c.position.y += keelY(spec); });
  } else if (id === 'pontoon') {
    g = buildPontoon(B, color);
    g.children.forEach(c => { c.position.y += keelY(spec); });
  } else if (id === 'speedboat') {
    g = await buildSpeedboat(B, spec, { atmosphere, loader }, colorIndex);
  } else if (id === 'sailboat') {
    g = await buildSailboat(B, spec, { atmosphere, loader }, colorIndex);
  }
  g.name = `boat-${id}`;
  g.spec = spec;
  g.colorIndex = colorIndex;
  g.triangles = Math.round(B.tris);
  if (!g.update) g.update = () => {};
  return g;
}

/**
 * Dev harness: `?mods=Boats&boat=jetski` swaps the player's visual for the
 * catalog one, and a lineup of all four boats floats ahead of the player on
 * real physics bodies. `?lineup=0` hides it, `?lineup=variants` shows every
 * Kenney colour variant, `?lineupYaw=<deg>` turns them, `?lineupZ=`,
 * `?lineupDx=` reposition the row.
 */
export async function devInstall(game) {
  const params = new URLSearchParams(location.search);
  const ctx = { atmosphere: game.app.atmosphere, loader: game.loader };

  // Game.spawnBoat already builds catalog visuals when it can see this module;
  // only swap the player's visual if it is still a fallback.
  const pid = params.get('boat');
  const color = +(params.get('color') || 0);
  if (pid && BOAT_CATALOG[pid] && game.player && (!game.player.visual?.spec || game.player.visual.colorIndex !== color)) {
    const vis = await buildBoatVisual(pid, { ...ctx, colorIndex: color });
    game.player.group.remove(game.player.visual);
    game.player.visual = vis;
    game.player.group.add(vis);
  }
  if (game.player?.visual?.spec) console.log(`[Boats] player ${game.player.visual.name}: ${game.player.visual.triangles} tris`);

  const lineup = params.get('lineup') ?? '1';
  if (lineup !== '0') {
    const yaw = THREE.MathUtils.degToRad(+(params.get('lineupYaw') ?? 150));
    const z0 = +(params.get('lineupZ') ?? 20), dx = +(params.get('lineupDx') ?? 12);
    let list;
    if (lineup === 'variants') {
      list = [];
      BOAT_CATALOG.speedboat.variants.forEach((v, i) => list.push(['speedboat', i]));
      BOAT_CATALOG.sailboat.variants.forEach((v, i) => list.push(['sailboat', i]));
    } else if (lineup === '1') {
      list = [['jetski', 0], ['speedboat', 0], ['sailboat', 0], ['pontoon', 0]];
    } else {
      list = lineup.split(',').map(t => { const [id, c] = t.split(':'); return [id, +(c || 0)]; });
    }
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const [id, ci] = list[i];
      if (!BOAT_CATALOG[id]) continue;
      const spec = BOAT_CATALOG[id];
      const hull = HULLS[spec.hull];
      const vis = await buildBoatVisual(id, { ...ctx, colorIndex: ci });
      const body = new BoatPhysics(hull, game.sea);
      body.groundFn = game.world?.heightAt || null;
      const group = new THREE.Group();
      group.add(vis);
      game.scene.add(group);
      const x = (i - (n - 1) / 2) * dx;
      body.setPose(x, game.sea.heightAt(x, z0) + restHeight(hull), z0, yaw);
      body.throttle = +(params.get('lineupThrottle') ?? 0);
      // Game.update integrates and poses every entry in game.boats and calls visual.update().
      game.boats.push({ name: id, hull, body, group, visual: vis, colorIndex: ci });
      console.log(`[Boats] lineup ${id}#${ci}: ${vis.triangles} tris, predicted rest height ${restHeight(hull).toFixed(2)} m`);
    }
  }

  // ?probe=1: red marker balls riding the sampled sea surface around the
  // player, to check the physics probe against the rendered water.
  if (params.get('probe') === '1' && game.player) {
    const B = new Builder(ctx.atmosphere);
    const markers = [];
    for (let i = 0; i < 8; i++) {
      const m = B.mesh(sphere(0.15, 8, 6), 'red', { roughness: 0.4 });
      game.scene.add(m);
      markers.push(m);
    }
    const prevUpdate = game.update.bind(game);
    game.update = (dt, rawDt) => {
      prevUpdate(dt, rawDt);
      const b = game.player.body;
      for (let i = 0; i < markers.length; i++) {
        const a = i / markers.length * Math.PI * 2, r = i % 2 ? 2.5 : 4.5;
        const x = b.position.x + Math.cos(a) * r, z = b.position.z + Math.sin(a) * r;
        markers[i].position.set(x, game.sea.heightAt(x, z), z);
      }
    };
  }

  // Float check for tools/game-smoke.mjs: game.stats().boats reports how high
  // each hull rides against the prediction, plus triangle counts.
  const prevStats = game.stats.bind(game);
  game.stats = () => {
    const st = prevStats();
    st.boats = game.boats.map(({ name, body: b, visual }) => ({
      name, tris: visual?.triangles ?? 0,
      float: +(b.position.y - game.sea.heightAt(b.position.x, b.position.z)).toFixed(2),
      predicted: +restHeight(b.hull).toFixed(2),
    }));
    return st;
  };
}
