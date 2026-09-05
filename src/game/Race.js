import * as THREE from 'three';
import { PropMaterial, trackMotion } from './PropMaterial.js';

/**
 * Race: checkpoint gates, lap counting, standings, countdown, AI drivers.
 *
 * A gate is a plane through (x, z) facing `heading` (the direction of travel,
 * same convention as BoatPhysics.heading: heading 0 points down +Z, heading
 * grows to the right). A boat passes a gate when it crosses that plane, going
 * forwards, within half the gate width of the centre. Gates must be taken in
 * order; a missed gate simply stays the target, so nothing ever punishes.
 *
 * Visuals are big toy-like arches: two striped buoy pillars, a torus arch,
 * lamp caps and a fluttering banner. The player's next gate glows green, the
 * one after is white, passed gates go dim. The start/finish gate is checkered.
 * A yellow arrow hovers over the player's boat pointing at the next gate.
 *
 * Every mesh uses PropMaterial (the HDR pipeline needs both render targets)
 * and is registered with trackMotion() so TAA gets proper motion vectors.
 */
const DEFAULT_WIDTH = 24;
const PILLAR_R = 1.0;
const PILLAR_H = 5.0;           // buoy pillar from 1.5 m below water to 3.5 m above
const PILLAR_BASE = -1.5;
const ARCH_TUBE = 0.7;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
const smooth = (x, e0, e1) => THREE.MathUtils.smoothstep(x, e0, e1);
const bearing = (fx, fz, tx, tz) => Math.atan2(tx - fx, tz - fz);

// Tiny procedural textures. PropMaterial samples uv directly (no uv transform),
// so the repeat count is baked into the canvas.
function canvasTexture(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}
function checkerTexture(cols, rows, a = '#ffffff', b = '#111111', px = 16) {
  return canvasTexture(cols * px, rows * px, (ctx, w, h) => {
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      ctx.fillStyle = (x + y) & 1 ? b : a;
      ctx.fillRect(x * px, y * px, px, px);
    }
  });
}
function stripeTexture(bands, a = '#ff6a00', b = '#ffffff') {
  return canvasTexture(8, bands * 16, (ctx, w, h) => {
    for (let i = 0; i < bands; i++) { ctx.fillStyle = i & 1 ? b : a; ctx.fillRect(0, i * 16, w, 16); }
  });
}

// Per-AI flavour so the pack does not drive in lock-step.
const PERSONALITIES = [
  { gain: 2.2, damp: 1.1, aggression: 0.97, lane: -0.28, wobble: 0.035, wobbleHz: 0.35, brake: 1.0 },
  { gain: 1.8, damp: 1.3, aggression: 0.93, lane: 0.30, wobble: 0.05, wobbleHz: 0.22, brake: 1.15 },
  { gain: 2.5, damp: 1.0, aggression: 1.0, lane: 0.05, wobble: 0.025, wobbleHz: 0.5, brake: 0.9 },
  { gain: 2.0, damp: 1.2, aggression: 0.95, lane: -0.12, wobble: 0.04, wobbleHz: 0.3, brake: 1.05 },
  { gain: 2.3, damp: 1.15, aggression: 0.9, lane: 0.18, wobble: 0.03, wobbleHz: 0.4, brake: 1.0 },
];

// Start grid slots relative to the start pose: [lateral (+right), back].
const GRID = [[6, -8], [-6, -8], [0, -16], [12, -16], [-12, -16], [0, -24], [6, -32], [-6, -32]];

export class Race {
  /**
   * @param {import('./Game.js').Game} game
   * @param {object} worldDef { start: {x,z,heading}, gates: [{x,z,heading,width}], laps, heightAt? }
   */
  constructor(game, worldDef, { laps = worldDef.laps ?? 3, aiCount = 3, aiBoats = ['jetski', 'sailboat', 'pontoon'], rubberBand = true, aiAssist = true } = {}) {
    this.game = game;
    this.worldDef = worldDef;
    this.laps = Math.max(1, laps | 0);
    this.aiCount = Math.max(0, Math.min(aiCount | 0, GRID.length));
    this.aiBoats = aiBoats;
    this.rubberBand = rubberBand;   // AI throttle cap when far ahead of the player, boost when far behind
    this.aiAssist = aiAssist;       // AI yaw-rate top-up (<= 0.35 rad/s) where the hull cannot turn on its own
    this.state = 'setup';        // setup | countdown | racing | finished | disposed
    this.countdown = 0;
    this.time = 0;
    this.acceptsInput = false;
    this.gates = [];
    this.racers = [];
    this.standings = [];
    this.player = null;          // racer record for the player (lap, nextGate, position, finished, finishTime, progress)
    this.aiRacers = [];
    this.onGate = null; this.onLap = null; this.onFinish = null; this.onCountdown = null;
    this._group = new THREE.Group();
    this._group.name = 'race';
    this._arrow = null;
    this._arrowYaw = 0;
    this._finishedCount = 0;
    this._updates = 0;
    this._frame = 0;
    this._geo = [];
    this._tex = [];
    this._mats = null;
    this._courseLength = 0;
    this._startBehind = true;
    this._t = 0;
    this._buildGates();
  }

  // ---------------------------------------------------------------- setup
  async setup() {
    const game = this.game, def = this.worldDef;
    const start = def.start || { x: 0, z: 0, heading: 0 };
    const h = start.heading || 0;
    const fx = Math.sin(h), fz = Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
    const groundFn = def.heightAt ?? game.world?.heightAt ?? null;

    // Player on the front row.
    const pb = game.player?.body;
    if (pb) {
      pb.setPose(start.x, game.sea.heightAt(start.x, start.z) + 0.3, start.z, h);
      game.player.group?.position.copy(pb.position);
      game.player.group?.quaternion.copy(pb.quaternion);
    }

    // AI behind and beside.
    this.aiRacers = [];
    for (let i = 0; i < this.aiCount; i++) {
      const [lat, back] = GRID[i];
      const x = start.x + rx * lat + fx * back, z = start.z + rz * lat + fz * back;
      const name = this.aiBoats[i % this.aiBoats.length];
      const boat = await game.spawnBoat(name, x, z, h, i + 1);
      boat.ai = true;
      boat.label = boat.label || `${name} ${i + 1}`;
      this.aiRacers.push(boat);
    }

    this.racers = [];
    if (game.player) this.player = this._makeRacer(game.player, null);
    this.aiRacers.forEach((b, i) => this._makeRacer(b, { ...PERSONALITIES[i % PERSONALITIES.length], phase: i * 1.7, stuck: 0 }));

    if (groundFn) for (const r of this.racers) r.body.groundFn = groundFn;

    // If the world puts the start ahead of gate 0, the first target is gate 1.
    const g0 = this.gates[0];
    const s0 = (start.x - g0.x) * g0.dir.x + (start.z - g0.z) * g0.dir.z;
    this._startBehind = s0 < -2;
    for (const r of this.racers) {
      r.nextGate = this._startBehind ? 0 : 1 % this.gates.length;
      r.prevS = this._sideOf(r.body.position, this.gates[r.nextGate]);
    }

    if (!this._group.parent) game.scene.add(this._group);
    this._buildArrow();
    this._updateStandings();
    this._updateVisuals(0);
    return this;
  }

  _makeRacer(boat, ai) {
    const r = {
      boat, body: boat.body, isPlayer: !ai, ai,
      lap: 1, nextGate: 0, gatesTotal: 0, prevS: 0,
      finished: false, finishTime: 0, place: 0, position: 0,
      progress: 0, lapProgress: 0, distNext: 0, stuckT: 0, steer: 0,
    };
    this.racers.push(r);
    return r;
  }

  // ------------------------------------------------------------- lifecycle
  start() {
    if (this.state === 'disposed') return;
    this.state = 'countdown';
    // Hud.js shows Math.ceil(countdown), so 3.0 reads "3" for a full second.
    this.countdown = 3.0;
    this._lastCount = 3;
    this.time = 0;
    this.acceptsInput = false;
    this._freezeAll();
    this.onCountdown?.(3);
  }

  update(dt) {
    if (this.state === 'disposed' || this.state === 'setup') return;
    this._updates++;
    this._frame++;
    this._t += dt;
    const g = this.game;

    if (this.state === 'countdown') {
      this.countdown -= dt;
      this._freezeAll();
      const n = Math.ceil(Math.max(this.countdown, 0));
      if (n !== this._lastCount) { this._lastCount = n; this.onCountdown?.(n); }
      if (this.countdown <= 0) {
        this.countdown = 0;
        this.state = 'racing';
        this.acceptsInput = true;
      }
    } else {
      this.time += dt;
    }

    const racing = this.state === 'racing' || this.state === 'finished';
    for (const r of this.racers) {
      // Boats that were removed from the game (world switch) drop out.
      if (!g.boats.includes(r.boat)) continue;
      if (racing) this._checkGate(r);
      this._progressOf(r);
    }
    this._updateStandings();

    if (racing) for (const r of this.racers) if (r.ai && g.boats.includes(r.boat)) this._drive(r, dt);

    this._updateVisuals(dt);
  }

  dispose() {
    const g = this.game;
    this.state = 'disposed';
    this.acceptsInput = true;
    if (this._group.parent) this._group.parent.remove(this._group);
    for (const geo of this._geo) geo.dispose();
    for (const t of this._tex) t.dispose();
    if (this._mats) for (const m of Object.values(this._mats)) m.dispose?.();
    for (const boat of this.aiRacers) {
      if (!g.boats.includes(boat)) continue;
      if (g.removeBoat) g.removeBoat(boat);
      else {
        g.scene.remove(boat.group);
        const i = g.boats.indexOf(boat);
        if (i >= 0) g.boats.splice(i, 1);
      }
    }
    this.aiRacers = [];
    this.gates.length = 0;
    this._arrow = null;
  }

  // ------------------------------------------------------------------ HUD
  /** Length of one lap along the gate polyline, metres. */
  get courseLength() { return this._courseLength; }

  /** World position of the player's next gate (arch centre). */
  nextGatePos(out = new THREE.Vector3()) {
    const gate = this.gates[this.player?.nextGate ?? 0];
    if (!gate) return out.set(0, 0, 0);
    return out.set(gate.x, gate.group.position.y + PILLAR_BASE + PILLAR_H + gate.width * 0.25, gate.z);
  }

  /** Direction to the next gate relative to the player's heading (rad, +right). */
  nextGateDir() {
    const p = this.player, gate = this.gates[p?.nextGate ?? 0];
    if (!p || !gate) return 0;
    return wrapAngle(bearing(p.body.position.x, p.body.position.z, gate.x, gate.z) - p.body.heading);
  }

  // -------------------------------------------------------------- course
  _buildGates() {
    const defs = this.worldDef.gates || [];
    this.gates = defs.map((d, i) => {
      const heading = d.heading || 0;
      const gate = {
        index: i, x: d.x, z: d.z, heading, width: d.width || DEFAULT_WIDTH,
        pos: new THREE.Vector3(d.x, 0, d.z),
        dir: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
        right: new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)),
        isFinish: i === 0, state: 'far', group: null, arch: null, caps: [], banner: null,
        /** True while `body` sits in the gate's plane band, inside the pillars. */
        test: (body) => {
          const dx = body.position.x - gate.x, dz = body.position.z - gate.z;
          const s = dx * gate.dir.x + dz * gate.dir.z, l = dx * gate.right.x + dz * gate.right.z;
          return Math.abs(s) < 1.5 && Math.abs(l) <= gate.width * 0.5;
        },
      };
      return gate;
    });
    const n = this.gates.length;
    this._courseLength = 0;
    for (let i = 0; i < n; i++) {
      const a = this.gates[i], b = this.gates[(i + 1) % n];
      a.segLen = Math.max(1, Math.hypot(b.x - a.x, b.z - a.z));   // length of the leg leaving gate i
      this._courseLength += a.segLen;
    }
    this._buildMaterials();
    for (const gate of this.gates) this._buildGateVisual(gate);
  }

  _buildMaterials() {
    const atmo = this.game.app.atmosphere;
    const checker = checkerTexture(32, 4, '#ffffff', '#101418');
    const stripes = stripeTexture(6, '#ff6a00', '#ffffff');
    const bannerChecker = checkerTexture(8, 3, '#ffffff', '#101418');
    this._tex.push(checker, stripes, bannerChecker);
    const mk = (o) => new PropMaterial(o, atmo);
    const em = (r, g, b) => new THREE.Color(r, g, b);
    this._mats = {
      pillar: mk({ map: stripes, color: 0xffffff, roughness: 0.55 }),
      bannerPlain: mk({ color: 0xff7a1a, emissive: em(0.5, 0.15, 0.0), roughness: 0.7, flagWave: 2.5, side: THREE.DoubleSide }),
      bannerFinish: mk({ map: bannerChecker, color: 0xffffff, emissive: em(0.2, 0.2, 0.2), roughness: 0.7, flagWave: 2.5, side: THREE.DoubleSide }),
      // Arch + lamp caps per state.
      plainNext: mk({ color: 0x3aff62, emissive: em(0.25, 3.0, 0.45), roughness: 0.4 }),
      plainAfter: mk({ color: 0xf6f6f6, emissive: em(0.5, 0.5, 0.5), roughness: 0.45 }),
      plainFar: mk({ color: 0xc9d0d6, emissive: em(0.22, 0.22, 0.22), roughness: 0.5 }),
      plainDim: mk({ color: 0x5a636c, emissive: em(0, 0, 0), roughness: 0.6 }),
      finishNext: mk({ map: checker, color: 0xa8ffb8, emissive: em(0.15, 1.6, 0.3), roughness: 0.4 }),
      finishAfter: mk({ map: checker, color: 0xffffff, emissive: em(0.4, 0.4, 0.4), roughness: 0.45 }),
      finishFar: mk({ map: checker, color: 0xd8dde2, emissive: em(0.2, 0.2, 0.2), roughness: 0.5 }),
      finishDim: mk({ map: checker, color: 0x6a727a, emissive: em(0, 0, 0), roughness: 0.6 }),
      arrow: mk({ color: 0xffd21f, emissive: em(2.8, 2.1, 0.2), roughness: 0.45 }),
    };
  }

  _buildGateVisual(gate) {
    const group = new THREE.Group();
    group.position.set(gate.x, 0, gate.z);
    group.rotation.y = gate.heading;
    const half = gate.width * 0.5;
    const top = PILLAR_BASE + PILLAR_H;
    const pillarGeo = this._geoCache('pillar', () => new THREE.CylinderGeometry(PILLAR_R, PILLAR_R * 1.15, PILLAR_H, 14, 1));
    const capGeo = this._geoCache('cap', () => new THREE.SphereGeometry(PILLAR_R * 1.25, 16, 12));
    const archGeo = this._geoCache(`arch${gate.width}`, () => new THREE.TorusGeometry(half, ARCH_TUBE, 10, 40, Math.PI));
    // FLAG_WAVE displaces geometry-local x, so the cloth lies in the local YZ
    // plane and the mesh is turned so that x becomes the gate's travel axis.
    const bannerGeo = this._geoCache('banner', () => new THREE.PlaneGeometry(6, 2.2, 8, 3).rotateY(Math.PI / 2));
    const poleGeo = this._geoCache('pole', () => new THREE.CylinderGeometry(0.12, 0.12, 3.2, 6, 1));

    for (const sx of [-1, 1]) {
      const pillar = new THREE.Mesh(pillarGeo, this._mats.pillar);
      pillar.position.set(sx * half, PILLAR_BASE + PILLAR_H * 0.5, 0);
      group.add(trackMotion(pillar));
      const cap = new THREE.Mesh(capGeo, this._mats.plainFar);
      cap.position.set(sx * half, top, 0);
      group.add(trackMotion(cap));
      gate.caps.push(cap);
    }
    // Torus lies in the XY plane and its half-arc (0..PI) is the upper half:
    // exactly the arch we want in the gate's local frame (x = across, y = up).
    const arch = new THREE.Mesh(archGeo, this._mats.plainFar);
    arch.position.set(0, top, 0);
    group.add(trackMotion(arch));
    gate.arch = arch;

    const pole = new THREE.Mesh(poleGeo, this._mats.pillar);
    pole.position.set(0, top + half + 1.4, 0);
    group.add(trackMotion(pole));
    // Banner hangs off the pole; uv.y = 1 at the top edge, which is the one that flutters.
    const banner = new THREE.Mesh(bannerGeo, gate.isFinish ? this._mats.bannerFinish : this._mats.bannerPlain);
    banner.position.set(3.0, top + half + 1.9, 0);
    banner.rotation.y = -Math.PI / 2;
    group.add(trackMotion(banner));
    gate.banner = banner;

    gate.group = group;
    this._group.add(group);
  }

  _geoCache(key, make) {
    this._geoMap = this._geoMap || new Map();
    let g = this._geoMap.get(key);
    if (!g) { g = make(); this._geoMap.set(key, g); this._geo.push(g); }
    return g;
  }

  _buildArrow() {
    if (this._arrow) return;
    const grp = new THREE.Group();
    // Flat, wide arrow (read from behind and above): a slab shaft and a big
    // pyramid head. The cone's orientation is baked so the tip points +z.
    const shaftGeo = this._geoCache('arrowShaft', () => new THREE.BoxGeometry(1.1, 0.35, 2.6));
    const headGeo = this._geoCache('arrowHead', () => new THREE.ConeGeometry(1.6, 2.0, 4).rotateY(Math.PI / 4).rotateX(Math.PI / 2).scale(1, 0.35, 1));
    const shaft = new THREE.Mesh(shaftGeo, this._mats.arrow);
    shaft.position.z = -0.6;
    const head = new THREE.Mesh(headGeo, this._mats.arrow);
    head.position.z = 1.7;
    grp.add(trackMotion(shaft), trackMotion(head));
    grp.visible = !!this.player;
    this._arrow = grp;
    this._group.add(grp);
  }

  // ------------------------------------------------------------ progress
  _sideOf(p, gate) { return (p.x - gate.x) * gate.dir.x + (p.z - gate.z) * gate.dir.z; }

  _checkGate(r) {
    const gate = this.gates[r.nextGate];
    if (!gate) return;
    const b = r.body, p = b.position;
    const s = this._sideOf(p, gate);
    if (r.prevS < 0 && s >= 0) {
      const lateral = (p.x - gate.x) * gate.right.x + (p.z - gate.z) * gate.right.z;
      const tol = gate.width * 0.5 + Math.max(1, b.hull.width * 0.5);
      const forwards = b.velocity.x * gate.dir.x + b.velocity.z * gate.dir.z > 0;
      if (Math.abs(lateral) <= tol && forwards) this._passGate(r, gate);
    }
    r.prevS = s;
  }

  _passGate(r, gate) {
    const n = this.gates.length;
    r.gatesTotal++;
    this.onGate?.(r.boat, gate.index);
    const firstStartCrossing = gate.index === 0 && this._startBehind && r.gatesTotal === 1;
    if (gate.index === 0 && !firstStartCrossing) {
      if (!r.finished && r.lap >= this.laps) {
        r.finished = true;
        r.finishTime = this.time;
        r.place = ++this._finishedCount;
        r.progress = 1;
        if (r.isPlayer) { this.state = 'finished'; }
        this.onFinish?.(r.boat, r.place, r.finishTime);
      } else {
        r.lap++;
        if (!r.finished) this.onLap?.(r.boat, r.lap);
      }
    }
    r.nextGate = (gate.index + 1) % n;
    r.prevS = this._sideOf(r.body.position, this.gates[r.nextGate]);
  }

  _progressOf(r) {
    const n = this.gates.length;
    const gate = this.gates[r.nextGate];
    if (!gate || !n) { r.progress = 0; return; }
    const p = r.body.position;
    r.distNext = Math.hypot(gate.x - p.x, gate.z - p.z);
    const prev = this.gates[(r.nextGate - 1 + n) % n];
    const frac = THREE.MathUtils.clamp(1 - r.distNext / prev.segLen, 0, 1);
    const legIndex = r.nextGate === 0 ? n : r.nextGate;   // legs completed this lap + 1
    r.lapProgress = THREE.MathUtils.clamp((legIndex - 1 + frac) / n, 0, 1);
    if (r.gatesTotal === 0 && this._startBehind) r.lapProgress = 0;   // still behind the start line
    r.raw = r.lap - 1 + r.lapProgress;                                 // in laps, unbounded for AI after finishing
    r.progress = r.finished ? 1 : THREE.MathUtils.clamp(r.raw / this.laps, 0, 1);
  }

  _updateStandings() {
    const list = this.racers.filter(r => this.game.boats.includes(r.boat));
    list.sort((a, b) => {
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.gatesTotal !== b.gatesTotal) return b.gatesTotal - a.gatesTotal;
      return a.distNext - b.distNext;
    });
    list.forEach((r, i) => { r.position = i + 1; });
    this.standings = list.map(r => ({
      boat: r.boat, name: r.boat.label || r.boat.name, lap: Math.min(r.lap, this.laps), gate: r.nextGate,
      position: r.position, progress: r.progress, finished: r.finished, finishTime: r.finishTime,
      gatesTotal: r.gatesTotal, ai: !!r.ai, speedKmh: r.body.speedKmh, stuckNudges: r.ai?.stuck ?? 0,
      x: r.body.position.x, z: r.body.position.z,
    }));
  }

  _freezeAll() {
    for (const r of this.racers) { r.body.throttle = 0; r.body.steer = 0; r.body.boost = 0; }
  }

  // ---------------------------------------------------------------- AI
  _drive(r, dt) {
    const b = r.body, ai = r.ai, hull = b.hull, n = this.gates.length;
    const gate = this.gates[r.nextGate], after = this.gates[(r.nextGate + 1) % n];
    const p = b.position, speed = Math.max(0, b.velocity.dot(b.forward));
    const speedK = THREE.MathUtils.clamp(speed / hull.maxSpeed, 0, 1.2);
    const dist = r.distNext;
    const half = gate.width * 0.5;

    // Aim point on the gate line: cut toward the side the following gate is on,
    // plus this driver's preferred lane, never closer than 40 % to a pillar.
    const toAfterLat = (after.x - gate.x) * gate.right.x + (after.z - gate.z) * gate.right.z;
    let offset = THREE.MathUtils.clamp(toAfterLat * 0.25, -half * 0.45, half * 0.45) + ai.lane * half;
    offset = THREE.MathUtils.clamp(offset, -half * 0.6, half * 0.6);
    const ax = gate.x + gate.right.x * offset, az = gate.z + gate.right.z * offset;
    let desired = bearing(p.x, p.z, ax, az);
    // Very close to the line the bearing gets twitchy: settle onto the gate heading.
    desired = lerpAngle(desired, gate.heading, smooth(-dist, -10, -3));
    // Look-ahead: start the turn toward the next leg before the gate.
    const turnAhead = wrapAngle(bearing(gate.x, gate.z, after.x, after.z) - gate.heading);
    const lookW = smooth(-dist, -28, -6) * 0.45;
    desired = lerpAngle(desired, bearing(p.x, p.z, after.x, after.z), lookW);
    // A little wobble so nobody drives on rails.
    desired += Math.sin(this._t * ai.wobbleHz * Math.PI * 2 + ai.phase) * ai.wobble;

    // Terrain avoidance: three probes fanned ahead; steer toward the clear side.
    let avoid = 0, blocked = 0;
    const ground = b.groundFn;
    if (ground) {
      const reach = THREE.MathUtils.clamp(speed * 2.2, 20, 40);
      const sea = this.game.sea.meanHeight ? this.game.sea.meanHeight(p.x, p.z) : 0;
      const h = b.heading;
      const hit = [-1, 0, 1].map((side) => {
        const a = h + side * 0.45;
        const far = ground(p.x + Math.sin(a) * reach, p.z + Math.cos(a) * reach) - sea;
        const near = ground(p.x + Math.sin(a) * reach * 0.5, p.z + Math.cos(a) * reach * 0.5) - sea;
        return Math.max(far, near) > -1.2;
      });
      const [left, centre, right] = hit;
      if (left) { avoid += 0.7; blocked += 0.5; }
      if (right) { avoid -= 0.7; blocked += 0.5; }
      if (centre) {
        blocked += 1;
        // Turn toward the open side; if both sides are open, toward the next leg.
        if (left && !right) avoid += 0.9;
        else if (right && !left) avoid -= 0.9;
        else avoid += turnAhead >= 0 ? 0.9 : -0.9;
      }
    }
    // Keep clear of other boats just ahead.
    let crowd = 0;
    for (const o of this.game.boats) {
      if (o === r.boat) continue;
      _a.subVectors(o.body.position, p);
      const d = _a.length();
      if (d > 12 || d < 1e-3) continue;
      const fwd = _a.dot(b.forward), lat = _a.dot(b.right);
      if (fwd < 0) continue;
      crowd += (lat >= 0 ? -1 : 1) * (1 - d / 12) * 0.35;
    }
    desired += avoid * 0.7 + crowd;

    // Proportional steering on heading error, damped by yaw rate. Gain eases
    // off at speed where the hull answers the helm more slowly but swings wide.
    const err = wrapAngle(desired - b.heading);
    const kp = ai.gain * THREE.MathUtils.clamp(1.35 - 0.55 * speedK, 0.75, 1.35);
    const yawRate = b.angular.y;
    let steer = THREE.MathUtils.clamp(kp * err - ai.damp * yawRate, -1, 1);
    r.steer += (steer - r.steer) * (1 - Math.exp(-dt * 7));
    b.steer = r.steer;

    // Steering assist (AI only). Yaw torque in this physics comes from the
    // outboard, so a sailboat off the wind or any hull at the governor's top
    // speed can barely turn. Ease the yaw rate toward the commanded turn, capped
    // at 0.35 rad/s (20 deg/s) so it still reads as a boat and never snaps.
    if (this.aiAssist && b.speed > 1.5 && !b.airborne && Math.abs(err) > 0.08) {
      const want = THREE.MathUtils.clamp(err * 0.9, -0.35, 0.35);
      const have = b.angular.y;
      if (have * Math.sign(want) < Math.abs(want)) b.angular.y += (want - have) * (1 - Math.exp(-dt * 1.2));
    }

    // Throttle. The outboard is the steering, so a turning boat keeps the power
    // on; speed is shed on the straight *before* a big corner (70..25 m out),
    // then it powers through. Only a boat pointing far off course eases off.
    let throttle = ai.aggression;
    const absErr = Math.abs(err);
    const braking = smooth(-dist, -70, -25) * (1 - smooth(-dist, -18, -6)) * smooth(Math.abs(turnAhead), 0.4, 1.2) * smooth(speedK, 0.45, 0.8);
    throttle *= 1 - braking * 0.6 * ai.brake;
    throttle *= 1 - smooth(absErr, 1.4, 2.6) * 0.4;
    if (blocked > 0) throttle *= 0.7;
    throttle = Math.max(throttle, 0.4);

    // Rubber band against the player, by track distance in metres. The cap is
    // lifted while the boat is off heading: it needs the thrust to turn.
    let boost = 0;
    const pl = this.player;
    if (this.rubberBand && pl && !pl.finished && !r.finished) {
      const gapM = (r.raw - pl.raw) * this._courseLength;   // + = AI ahead
      if (gapM > 0) {
        // ~0.55 beyond 80 m ahead, easing further toward 0.3 if the kid is a long way back.
        let cap = THREE.MathUtils.lerp(1, 0.55, smooth(gapM, 55, 95));
        cap = THREE.MathUtils.lerp(cap, 0.3, smooth(gapM, 150, 240));
        throttle = Math.min(throttle, Math.max(cap, smooth(absErr, 0.3, 0.9)));
      } else boost = 0.72 * smooth(-gapM, 95, 135) + 0.28 * smooth(-gapM, 200, 320);
    } else if (r.finished) {
      throttle = Math.min(throttle, 0.8);   // cruise after finishing
    }
    b.throttle = throttle;
    b.boost = boost;

    // Stuck: barely moving for 4 s while trying to race. Point at the gate and shove.
    if (b.speed < 1 && this.state !== 'countdown') r.stuckT += dt; else r.stuckT = 0;
    if (r.stuckT > 4) {
      r.stuckT = 0;
      ai.stuck++;
      const hd = bearing(p.x, p.z, gate.x, gate.z);
      b.setPose(p.x, this.game.sea.heightAt(p.x, p.z) + 0.3, p.z, hd);
      b.velocity.set(Math.sin(hd) * 4, 0, Math.cos(hd) * 4);
      r.steer = 0;
    }
  }

  // ------------------------------------------------------------- visuals
  _updateVisuals(dt) {
    const sea = this.game.sea, n = this.gates.length;
    const pl = this.player;
    const next = pl?.nextGate ?? 0, after = (next + 1) % n;
    const sampleAll = this._frame % 3 === 0;
    for (const gate of this.gates) {
      const i = gate.index;
      let state = 'far';
      if (i === next) state = 'next';
      else if (i === after && n > 2) state = 'after';
      else if (pl && this._passedThisLap(pl, i)) state = 'dim';
      if (state !== gate.state) {
        gate.state = state;
        const key = (gate.isFinish ? 'finish' : 'plain') + state[0].toUpperCase() + state.slice(1);
        const mat = this._mats[key];
        gate.arch.material = mat;
        for (const c of gate.caps) c.material = mat;
      }
      if (sampleAll || state === 'next') {
        const y = sea.heightAt(gate.x, gate.z);
        gate.group.position.y += (y - gate.group.position.y) * (dt > 0 ? 1 - Math.exp(-dt * 6) : 1);
      }
    }
    // Arrow hovers above the player, pointing at the next gate.
    const arrow = this._arrow;
    if (arrow && pl) {
      const gate = this.gates[next], p = pl.body.position;
      const hide = pl.finished || this.state === 'disposed';
      arrow.visible = !hide;
      if (!hide) {
        const yaw = bearing(p.x, p.z, gate.x, gate.z);
        this._arrowYaw = dt > 0 ? lerpAngle(this._arrowYaw, yaw, 1 - Math.exp(-dt * 5)) : yaw;
        const H = pl.body.hull.length < 4 ? 4 : 6;
        arrow.position.set(p.x, p.y + H + Math.sin(this._t * 2.2) * 0.35, p.z);
        arrow.rotation.set(0, this._arrowYaw, 0);
        // Nose down ~20 deg so the head is visible from the chase camera behind.
        arrow.rotateX(0.35);
      }
    }
  }

  _passedThisLap(r, i) {
    if (r.gatesTotal === 0) return false;
    if (r.nextGate === 0) return i !== 0;     // heading back to the start line: everything else is done
    return i < r.nextGate;
  }
}

// ----------------------------------------------------------------- dev
/**
 * Standalone harness: `?mods=Race&debug=1[&world=lagoon|swell|storm][&course=dev]`.
 *
 * With Worlds.js present the real flow runs: the game enters a race world
 * (default lagoon) and builds this Race itself, and the harness only logs.
 * Without it (or with `course=dev`) a rounded-rectangle loop of 8 gates is
 * laid around the origin on the bare sea and raced for 3 laps.
 */
export async function devInstall(game) {
  const params = new URLSearchParams(location.search);
  const worldId = params.get('world') || 'lagoon';
  const W = game.mods?.Worlds;
  const rubberBand = params.get('rubber') !== '0';   // rubber=0: AI race flat out (parked-player tests)
  if (params.get('course') !== 'dev' && W?.WORLDS?.[worldId]?.gates?.length && typeof game.enterWorld === 'function') {
    game.start = async () => {
      await game.enterWorld(worldId);
      if (game.race) { game.race.rubberBand = rubberBand; devLog(game, game.race); }
      else console.error('[race] game.enterWorld did not create a race');
    };
    console.log(`[race] dev harness: racing world '${worldId}' through Game.enterWorld`);
    return null;
  }
  if (game.world?.def?.islands?.length) console.warn('[race] dev loop laid over a world with islands; expect groundings');

  // Rounded rectangle 420 x 260 m with 80 m corners, sampled by arc length.
  const A = 420, B = 260, R = 80;
  const pts = [];
  const corners = [[A / 2 - R, B / 2 - R], [-(A / 2 - R), B / 2 - R], [-(A / 2 - R), -(B / 2 - R)], [A / 2 - R, -(B / 2 - R)]];
  for (let c = 0; c < 4; c++) {
    const [cx, cz] = corners[c];
    for (let k = 0; k <= 10; k++) {
      const a = (c * Math.PI / 2) + (k / 10) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * R, cz + Math.sin(a) * R]);
    }
  }
  const len = [0];
  for (let i = 1; i <= pts.length; i++) {
    const p = pts[i % pts.length], q = pts[i - 1];
    len.push(len[i - 1] + Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  const total = len[pts.length];
  const at = (s) => {
    s = ((s % total) + total) % total;
    let i = 0;
    while (i < pts.length - 1 && len[i + 1] < s) i++;
    const t = (s - len[i]) / Math.max(1e-6, len[i + 1] - len[i]);
    const p = pts[i], q = pts[(i + 1) % pts.length];
    return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  };
  const gates = [];
  const N = 8, s0 = len[32] + (A - 2 * R) * 0.5;   // middle of the -z straight (after corner 2)
  for (let i = 0; i < N; i++) {
    const s = s0 + (i / N) * total;
    const [x, z] = at(s), [x2, z2] = at(s + 2);
    gates.push({ x: +x.toFixed(1), z: +z.toFixed(1), heading: Math.atan2(x2 - x, z2 - z), width: 24 });
  }
  // Start 14 m behind gate 0.
  const g0 = gates[0];
  const start = { x: g0.x - Math.sin(g0.heading) * 14, z: g0.z - Math.cos(g0.heading) * 14, heading: g0.heading };
  const worldDef = { id: 'devcourse', name: 'Test Loop', start, gates, laps: 3, bounds: 900 };
  console.log('[race] dev course', worldDef);

  const race = new Race(game, worldDef, { laps: 3, rubberBand });
  game.race = race;
  game.audio && (race.onCountdown = (n) => game.audio.countdown?.(n));
  await race.setup();
  const startGame = game.start.bind(game);
  game.start = () => { startGame(); game.hud?.show?.('race'); race.start(); };
  devLog(game, race);

  // Game.update already drives race.update when game.race is set; the wrapper
  // covers an older Game.js that does not, and enforces the input freeze.
  const orig = game.update.bind(game);
  game.update = (dt, rawDt) => {
    const n = race._updates;
    orig(dt, rawDt);
    if (race._updates === n && race.state !== 'disposed' && race.state !== 'setup') {
      race.update(dt);
      if (!race.acceptsInput && game.player) { const b = game.player.body; b.throttle = 0; b.steer = 0; b.boost = 0; }
    }
  };
  return race;
}

/** Console logging of gate passes, laps, finishes and standings changes (chains existing callbacks). */
function devLog(game, race) {
  const chain = (key, fn) => { const prev = race[key]; race[key] = (...a) => { prev?.(...a); fn(...a); }; };
  const label = (boat) => boat.label || boat.name;
  chain('onCountdown', (n) => console.log(`[race] countdown ${n || 'GO!'}`));
  chain('onGate', (boat, i) => console.log(`[race] ${label(boat)} passed gate ${i}  t=${race.time.toFixed(1)}`));
  chain('onLap', (boat, lap) => console.log(`[race] ${label(boat)} starts lap ${lap}  t=${race.time.toFixed(1)}`));
  chain('onFinish', (boat, place, time) => console.log(`[race] ${label(boat)} FINISHED place ${place} time ${time.toFixed(1)}`));
  let lastOrder = '';
  const prevUpdate = race.update.bind(race);
  race.update = (dt) => {
    prevUpdate(dt);
    const order = race.standings.map(s => `${s.position}:${s.name}(L${s.lap} g${s.gate})`).join(' ');
    if (order !== lastOrder) { lastOrder = order; console.log('[race] standings', order); }
  };
}
