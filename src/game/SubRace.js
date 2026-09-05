import * as THREE from 'three';
import { PropMaterial, trackMotion } from './PropMaterial.js';
import { SubPhysics, buildSubVisual, devInstall as installSub } from './Submarine.js';

/**
 * SubRace: the underwater race — same public surface as Race.js, with 3D hoops
 * instead of arches and submarines instead of boats.
 *
 * A hoop is a torus standing vertical at (x, y, z), its axis along `heading`
 * (direction of travel, BoatPhysics convention: heading 0 = +Z, growing toward
 * +X). A sub passes a hoop when its centre crosses the hoop's plane going
 * forwards inside the ring radius (plus half the hull width). Hoops must be
 * taken in order; a missed hoop stays the target, nothing punishes.
 *
 * The player's next hoop glows green, the one after white, passed hoops go
 * dim; the next and the following hoop carry a slowly turning ring of sparkle
 * beads. A yellow arrow floats above the player pointing at the next hoop in
 * 3D. AI subs steer and dive toward the next hoop with a look-ahead to the
 * following one, probe the seabed ahead / below and the surface above, and
 * rubber-band against the player.
 */
const DEFAULT_WIDTH = 14;
const DEFAULT_Y = -15;
const HOOP_TUBE = 0.55;
const BEADS = 10;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _m = new THREE.Matrix4(), _up = new THREE.Vector3(0, 1, 0);

const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
const smooth = (x, e0, e1) => THREE.MathUtils.smoothstep(x, e0, e1);
const clamp = THREE.MathUtils.clamp;
const bearing = (fx, fz, tx, tz) => Math.atan2(tx - fx, tz - fz);

function checkerTexture(cols, rows, a = '#ffffff', b = '#111111', px = 16) {
  const c = document.createElement('canvas');
  c.width = cols * px; c.height = rows * px;
  const ctx = c.getContext('2d');
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    ctx.fillStyle = (x + y) & 1 ? b : a;
    ctx.fillRect(x * px, y * px, px, px);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

// Per-AI flavour so the pack does not fly in lock-step. laneY = preferred vertical offset in the hoop.
const PERSONALITIES = [
  { gain: 2.2, damp: 1.1, aggression: 0.97, lane: -0.25, laneY: 0.15, wobble: 0.03, wobbleHz: 0.35, brake: 1.0 },
  { gain: 1.8, damp: 1.3, aggression: 0.93, lane: 0.28, laneY: -0.2, wobble: 0.045, wobbleHz: 0.22, brake: 1.15 },
  { gain: 2.5, damp: 1.0, aggression: 1.0, lane: 0.05, laneY: 0.3, wobble: 0.025, wobbleHz: 0.5, brake: 0.9 },
  { gain: 2.0, damp: 1.2, aggression: 0.95, lane: -0.12, laneY: -0.1, wobble: 0.04, wobbleHz: 0.3, brake: 1.05 },
];

// Start grid slots relative to the start pose: [lateral (+right), back, vertical].
const GRID = [[7, -9, -1.5], [-7, -9, -1.5], [0, -18, -3], [12, -18, -1], [-12, -18, -1], [0, -27, -2]];

export class SubRace {
  /**
   * @param {import('./Game.js').Game} game
   * @param {object} worldDef { start: {x,y,z,heading}, gates: [{x,y,z,heading,width}], laps, heightAt? }
   */
  constructor(game, worldDef, { laps = worldDef.laps ?? 3, aiCount = 3, rubberBand = true } = {}) {
    this.game = game;
    this.worldDef = worldDef;
    this.laps = Math.max(1, laps | 0);
    this.aiCount = Math.max(0, Math.min(aiCount | 0, GRID.length));
    this.rubberBand = rubberBand;
    this.state = 'setup';        // setup | countdown | racing | finished | disposed
    this.countdown = 0;
    this.time = 0;
    this.acceptsInput = false;
    this.gates = [];
    this.racers = [];
    this.standings = [];
    this.player = null;
    this.aiRacers = [];
    this.onGate = null; this.onLap = null; this.onFinish = null; this.onCountdown = null;
    this._group = new THREE.Group();
    this._group.name = 'subrace';
    this._arrow = null;
    this._arrowDir = new THREE.Vector3(0, 0, 1);
    this._finishedCount = 0;
    this._updates = 0;
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
    const ceilingFn = (x, z) => game.sea.heightAt(x, z);
    const startY = start.y ?? (game.sea.heightAt(start.x, start.z) - 0.5);
    const clearY = (x, y, z) => groundFn ? Math.max(y, groundFn(x, z) + 4) : y;

    const pb = game.player?.body;
    if (pb) {
      pb.groundFn = groundFn;
      if (pb.isSub) pb.ceilingFn = pb.ceilingFn || ceilingFn;
      pb.setPose(start.x, pb.isSub ? clearY(start.x, startY, start.z) : game.sea.heightAt(start.x, start.z) + 0.3, start.z, h);
      game.player.group?.position.copy(pb.position);
      game.player.group?.quaternion.copy(pb.quaternion);
    }

    this.aiRacers = [];
    for (let i = 0; i < this.aiCount; i++) {
      const [lat, back, dy] = GRID[i];
      const x = start.x + rx * lat + fx * back, z = start.z + rz * lat + fz * back;
      const y = clearY(x, Math.min(startY + dy, ceilingFn(x, z) - 0.5), z);
      const sub = await this._spawnSub(x, y, z, h, i + 1, groundFn, ceilingFn);
      sub.ai = true;
      sub.label = sub.label || `Sub ${i + 1}`;
      this.aiRacers.push(sub);
    }

    this.racers = [];
    if (game.player) this.player = this._makeRacer(game.player, null);
    this.aiRacers.forEach((b, i) => this._makeRacer(b, { ...PERSONALITIES[i % PERSONALITIES.length], phase: i * 1.7, stuck: 0 }));
    for (const r of this.racers) { r.body.groundFn = groundFn; if (r.body.isSub && !r.body.ceilingFn) r.body.ceilingFn = ceilingFn; }

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

  async _spawnSub(x, y, z, heading, colorIndex, groundFn, ceilingFn) {
    const game = this.game;
    if (typeof game.spawnSub === 'function') return game.spawnSub(x, y, z, heading, colorIndex);
    // Older Game.js: build the sub here and register it like any boat.
    const body = new SubPhysics({ groundFn, ceilingFn });
    const visual = await buildSubVisual({ atmosphere: game.app.atmosphere, colorIndex });
    const group = new THREE.Group();
    group.add(visual);
    game.scene.add(group);
    body.setPose(x, y, z, heading);
    group.position.copy(body.position);
    group.quaternion.copy(body.quaternion);
    const sub = { name: 'sub', hull: body.hull, body, group, visual, colorIndex, isSub: true };
    game.boats.push(sub);
    return sub;
  }

  _makeRacer(boat, ai) {
    const r = {
      boat, body: boat.body, isPlayer: !ai, ai,
      lap: 1, nextGate: 0, gatesTotal: 0, prevS: 0,
      finished: false, finishTime: 0, place: 0, position: 0,
      progress: 0, lapProgress: 0, distNext: 0, stuckT: 0, steer: 0, dive: 0,
    };
    this.racers.push(r);
    return r;
  }

  // ------------------------------------------------------------- lifecycle
  start() {
    if (this.state === 'disposed') return;
    this.state = 'countdown';
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
      boat.visual?.dispose?.();
    }
    this.aiRacers = [];
    this.gates.length = 0;
    this._arrow = null;
  }

  // ------------------------------------------------------------------ HUD
  /** Length of one lap along the hoop polyline (3D), metres. */
  get courseLength() { return this._courseLength; }

  /** World position of the player's next hoop centre. */
  nextGatePos(out = new THREE.Vector3()) {
    const gate = this.gates[this.player?.nextGate ?? 0];
    if (!gate) return out.set(0, 0, 0);
    return out.copy(gate.pos);
  }

  /** Yaw to the next hoop relative to the player's heading (rad, +right). */
  nextGateDir() {
    const p = this.player, gate = this.gates[p?.nextGate ?? 0];
    if (!p || !gate) return 0;
    // heading grows toward +X, which is the boat's visual LEFT; negate for "+right".
    return -wrapAngle(bearing(p.body.position.x, p.body.position.z, gate.x, gate.z) - p.body.heading);
  }

  /** Elevation of the next hoop relative to the player's pitch (rad, +up). */
  nextGatePitch() {
    const p = this.player, gate = this.gates[p?.nextGate ?? 0];
    if (!p || !gate) return 0;
    const b = p.body;
    const dh = Math.hypot(gate.x - b.position.x, gate.z - b.position.z);
    return Math.atan2(gate.y - b.position.y, Math.max(dh, 1)) - (b.pitch || 0);
  }

  // -------------------------------------------------------------- course
  _buildGates() {
    const defs = this.worldDef.gates || [];
    this.gates = defs.map((d, i) => {
      const heading = d.heading || 0;
      const y = d.y ?? DEFAULT_Y;
      const width = d.width || DEFAULT_WIDTH;
      const gate = {
        index: i, x: d.x, y, z: d.z, heading, width, radius: width * 0.5,
        pos: new THREE.Vector3(d.x, y, d.z),
        dir: new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading)),
        right: new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading)),
        isFinish: i === 0, state: 'far', group: null, ring: null, beads: null,
        /** True while `body` is within the hoop's plane band and inside the ring. */
        test: (body) => {
          const dx = body.position.x - gate.x, dy = body.position.y - gate.y, dz = body.position.z - gate.z;
          const s = dx * gate.dir.x + dz * gate.dir.z;
          const l = dx * gate.right.x + dz * gate.right.z;
          return Math.abs(s) < 1.5 && Math.hypot(l, dy) <= gate.radius;
        },
      };
      return gate;
    });
    const n = this.gates.length;
    this._courseLength = 0;
    for (let i = 0; i < n; i++) {
      const a = this.gates[i], b = this.gates[(i + 1) % n];
      a.segLen = Math.max(1, a.pos.distanceTo(b.pos));
      this._courseLength += a.segLen;
    }
    this._buildMaterials();
    for (const gate of this.gates) this._buildGateVisual(gate);
  }

  _buildMaterials() {
    const atmo = this.game.app.atmosphere;
    const checker = checkerTexture(24, 2, '#ffffff', '#101418');
    this._tex.push(checker);
    const mk = (o) => new PropMaterial(o, atmo);
    const em = (r, g, b) => new THREE.Color(r, g, b);
    // Underwater is dim: hoops carry a strong emissive so they read from a long way off.
    this._mats = {
      plainNext: mk({ color: 0x3aff62, emissive: em(0.5, 6.0, 0.9), roughness: 0.4 }),
      plainAfter: mk({ color: 0xf6f6f6, emissive: em(1.4, 1.4, 1.5), roughness: 0.45 }),
      plainFar: mk({ color: 0xc9d0d6, emissive: em(0.5, 0.55, 0.65), roughness: 0.5 }),
      plainDim: mk({ color: 0x5a636c, emissive: em(0.08, 0.1, 0.14), roughness: 0.6 }),
      finishNext: mk({ map: checker, color: 0xa8ffb8, emissive: em(0.3, 3.2, 0.6), roughness: 0.4 }),
      finishAfter: mk({ map: checker, color: 0xffffff, emissive: em(1.0, 1.0, 1.0), roughness: 0.45 }),
      finishFar: mk({ map: checker, color: 0xd8dde2, emissive: em(0.45, 0.45, 0.5), roughness: 0.5 }),
      finishDim: mk({ map: checker, color: 0x6a727a, emissive: em(0.08, 0.08, 0.1), roughness: 0.6 }),
      bead: mk({ color: 0xffffff, emissive: em(6.0, 6.0, 5.0), roughness: 0.3 }),
      beadNext: mk({ color: 0xd8ffe0, emissive: em(2.5, 8.0, 3.0), roughness: 0.3 }),
      arrow: mk({ color: 0xffd21f, emissive: em(3.2, 2.4, 0.3), roughness: 0.45 }),
    };
  }

  _buildGateVisual(gate) {
    const group = new THREE.Group();
    group.position.copy(gate.pos);
    group.rotation.y = gate.heading;
    // Torus in the local XY plane: a ring standing vertical, axis along the travel direction.
    const ringGeo = this._geoCache(`ring${gate.width}`, () => new THREE.TorusGeometry(gate.radius, HOOP_TUBE, 8, 36));
    const ring = new THREE.Mesh(ringGeo, this._mats.plainFar);
    group.add(trackMotion(ring));
    gate.ring = ring;
    // Sparkle beads riding the ring, one merged mesh, turned slowly in _updateVisuals.
    const beadGeo = this._geoCache(`beads${gate.width}`, () => {
      const pos = [];
      const oct = new THREE.OctahedronGeometry(0.42, 0);
      const src = oct.attributes.position;
      for (let k = 0; k < BEADS; k++) {
        const a = k / BEADS * Math.PI * 2, cx = Math.cos(a) * gate.radius, cy = Math.sin(a) * gate.radius;
        for (let v = 0; v < src.count; v++) pos.push(src.getX(v) + cx, src.getY(v) + cy, src.getZ(v));
      }
      oct.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.computeVertexNormals();
      return g;
    });
    const beads = new THREE.Mesh(beadGeo, this._mats.bead);
    beads.visible = false;
    group.add(trackMotion(beads));
    gate.beads = beads;
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
      const off = Math.hypot(lateral, p.y - gate.y);
      const tol = gate.radius + Math.max(1, b.hull.width * 0.5);
      const forwards = b.velocity.x * gate.dir.x + b.velocity.z * gate.dir.z > 0;
      if (off <= tol && forwards) this._passGate(r, gate);
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
        if (r.isPlayer) this.state = 'finished';
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
    r.distNext = r.body.position.distanceTo(gate.pos);
    const prev = this.gates[(r.nextGate - 1 + n) % n];
    const frac = clamp(1 - r.distNext / prev.segLen, 0, 1);
    const legIndex = r.nextGate === 0 ? n : r.nextGate;
    r.lapProgress = clamp((legIndex - 1 + frac) / n, 0, 1);
    if (r.gatesTotal === 0 && this._startBehind) r.lapProgress = 0;
    r.raw = r.lap - 1 + r.lapProgress;
    r.progress = r.finished ? 1 : clamp(r.raw / this.laps, 0, 1);
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
      x: r.body.position.x, y: r.body.position.y, z: r.body.position.z,
    }));
  }

  _freezeAll() {
    for (const r of this.racers) { const b = r.body; b.throttle = 0; b.steer = 0; b.boost = 0; if (b.isSub) b.dive = 0; }
  }

  // ---------------------------------------------------------------- AI
  _drive(r, dt) {
    const b = r.body, ai = r.ai, hull = b.hull, n = this.gates.length;
    const gate = this.gates[r.nextGate], after = this.gates[(r.nextGate + 1) % n];
    const p = b.position, speed = Math.max(0, b.velocity.dot(b.forward));
    const speedK = clamp(speed / hull.maxSpeed, 0, 1.2);
    const distH = Math.hypot(gate.x - p.x, gate.z - p.z);
    const dist = r.distNext;
    const rad = gate.radius;

    // Aim point inside the hoop: cut toward the side the following hoop is on,
    // plus this driver's lane, never closer than 40 % to the rim.
    const toAfterLat = (after.x - gate.x) * gate.right.x + (after.z - gate.z) * gate.right.z;
    let offset = clamp(toAfterLat * 0.25, -rad * 0.4, rad * 0.4) + ai.lane * rad;
    offset = clamp(offset, -rad * 0.6, rad * 0.6);
    const ax = gate.x + gate.right.x * offset, az = gate.z + gate.right.z * offset;
    let aimY = gate.y + clamp((after.y - gate.y) * 0.2, -rad * 0.35, rad * 0.35) + ai.laneY * rad;
    let desired = bearing(p.x, p.z, ax, az);
    desired = lerpAngle(desired, gate.heading, smooth(-distH, -10, -3));
    const turnAhead = wrapAngle(bearing(gate.x, gate.z, after.x, after.z) - gate.heading);
    const lookW = smooth(-distH, -28, -6) * 0.45;
    desired = lerpAngle(desired, bearing(p.x, p.z, after.x, after.z), lookW);
    aimY = THREE.MathUtils.lerp(aimY, after.y, lookW * 0.6);
    desired += Math.sin(this._t * ai.wobbleHz * Math.PI * 2 + ai.phase) * ai.wobble;

    // Terrain: probe the seabed ahead (three fan probes) and directly below, the surface above.
    let avoid = 0, blocked = 0, climb = 0;
    const ground = b.groundFn;
    const surface = b.surfaceY ?? (b.ceilingFn ? b.ceilingFn(p.x, p.z) : 0);
    if (ground) {
      const reach = clamp(speed * 3.0, 18, 40);
      const h = b.heading;
      let hitL = false, hitC = false, hitR = false;
      for (let side = -1; side <= 1; side++) {
        const a = h + side * 0.45;
        const gx = p.x + Math.sin(a) * reach, gz = p.z + Math.cos(a) * reach;
        const far = ground(gx, gz), near = ground(p.x + Math.sin(a) * reach * 0.5, p.z + Math.cos(a) * reach * 0.5);
        const clear = p.y - Math.max(far, near);   // vertical clearance over the terrain ahead
        const hit = clear < 6;
        if (side < 0) hitL = hit; else if (side > 0) hitR = hit; else { hitC = hit; if (hit) climb = Math.max(climb, (6 - clear) * 0.25); }
      }
      if (hitL) { avoid += 0.7; blocked += 0.5; }
      if (hitR) { avoid -= 0.7; blocked += 0.5; }
      if (hitC) {
        blocked += 1;
        if (hitL && !hitR) avoid += 0.9;
        else if (hitR && !hitL) avoid -= 0.9;
        else avoid += turnAhead >= 0 ? 0.9 : -0.9;
      }
      const below = p.y - ground(p.x, p.z);
      if (below < 4) climb = Math.max(climb, (4 - below) * 0.4);
      // Never aim the sub into the seabed or through the surface.
      aimY = Math.max(aimY, ground(ax, az) + 5);
    }
    aimY = Math.min(aimY, Math.max(gate.y, surface - 2.5));

    // Keep clear of other subs just ahead.
    let crowd = 0, crowdY = 0;
    for (const o of this.game.boats) {
      if (o === r.boat) continue;
      _a.subVectors(o.body.position, p);
      const d = _a.length();
      if (d > 12 || d < 1e-3) continue;
      const fwd = _a.dot(b.forward), lat = _a.dot(b.right), vert = _a.dot(b.up);
      if (fwd < 0) continue;
      crowd += (lat >= 0 ? -1 : 1) * (1 - d / 12) * 0.35;
      crowdY += (vert >= 0 ? -1 : 1) * (1 - d / 12) * 0.5;
    }
    desired += avoid * 0.7 + crowd;

    // Yaw: proportional on heading error, damped by yaw rate. Positive error =
    // target toward +X = visual left = negative steer.
    const err = wrapAngle(desired - b.heading);
    const kp = ai.gain * clamp(1.35 - 0.55 * speedK, 0.75, 1.35);
    const yawRate = b.angular.dot(b.up);
    const steer = -clamp(kp * err - ai.damp * yawRate, -1, 1);
    r.steer += (steer - r.steer) * (1 - Math.exp(-dt * 7));
    b.steer = r.steer;

    // Dive: proportional on the height error with vertical-speed damping, plus terrain climb.
    const dy = aimY - p.y;
    let dive = clamp(dy * 0.35 - b.velocity.y * 0.3, -1, 1) + climb + crowdY;
    dive = clamp(dive, -1, 1);
    r.dive += (dive - r.dive) * (1 - Math.exp(-dt * 5));
    b.dive = r.dive;

    // Throttle: ease off for a big corner ahead, when far off heading, when a
    // steep climb/dive is needed (the ballast does more at low speed) or when blocked.
    let throttle = ai.aggression;
    const absErr = Math.abs(err);
    const braking = smooth(-distH, -70, -25) * (1 - smooth(-distH, -18, -6)) * smooth(Math.abs(turnAhead), 0.4, 1.2) * smooth(speedK, 0.45, 0.8);
    throttle *= 1 - braking * 0.6 * ai.brake;
    throttle *= 1 - smooth(absErr, 1.4, 2.6) * 0.4;
    const slope = Math.abs(dy) / Math.max(distH, 6);
    throttle *= 1 - smooth(slope, 0.35, 0.7) * 0.45;
    if (blocked > 0) throttle *= 0.7;
    throttle = Math.max(throttle, 0.4);

    // Rubber band against the player, by track distance in metres.
    let boost = 0;
    const pl = this.player;
    if (this.rubberBand && pl && !pl.finished && !r.finished) {
      const gapM = (r.raw - pl.raw) * this._courseLength;
      if (gapM > 0) {
        let cap = THREE.MathUtils.lerp(1, 0.55, smooth(gapM, 55, 95));
        cap = THREE.MathUtils.lerp(cap, 0.3, smooth(gapM, 150, 240));
        throttle = Math.min(throttle, Math.max(cap, smooth(absErr, 0.3, 0.9)));
      } else boost = 0.72 * smooth(-gapM, 95, 135) + 0.28 * smooth(-gapM, 200, 320);
    } else if (r.finished) {
      throttle = Math.min(throttle, 0.8);
    }
    b.throttle = throttle;
    b.boost = boost;

    // Stuck: barely moving for 4 s while racing. Point at the hoop, clear of the bottom, and shove.
    if (b.speed < 1 && this.state !== 'countdown') r.stuckT += dt; else r.stuckT = 0;
    if (r.stuckT > 4) {
      r.stuckT = 0;
      ai.stuck++;
      const hd = bearing(p.x, p.z, gate.x, gate.z);
      const y = Math.min(ground ? Math.max(p.y, ground(p.x, p.z) + 4) : p.y, surface - 0.5);
      b.setPose(p.x, y, p.z, hd);
      b.velocity.set(Math.sin(hd) * 4, 0, Math.cos(hd) * 4);
      r.steer = 0; r.dive = 0;
    }
  }

  // ------------------------------------------------------------- visuals
  _updateVisuals(dt) {
    const n = this.gates.length;
    const pl = this.player;
    const next = pl?.nextGate ?? 0, after = (next + 1) % n;
    for (const gate of this.gates) {
      const i = gate.index;
      let state = 'far';
      if (i === next) state = 'next';
      else if (i === after && n > 2) state = 'after';
      else if (pl && this._passedThisLap(pl, i)) state = 'dim';
      if (state !== gate.state) {
        gate.state = state;
        const key = (gate.isFinish ? 'finish' : 'plain') + state[0].toUpperCase() + state.slice(1);
        gate.ring.material = this._mats[key];
        gate.beads.visible = state === 'next' || state === 'after';
        gate.beads.material = state === 'next' ? this._mats.beadNext : this._mats.bead;
      }
      if (gate.beads.visible) gate.beads.rotation.z += dt * (state === 'next' ? 0.9 : 0.45);
    }
    // Arrow floats above the player, pointing at the next hoop in 3D.
    const arrow = this._arrow;
    if (arrow && pl) {
      const gate = this.gates[next], b = pl.body, p = b.position;
      const hide = pl.finished || this.state === 'disposed';
      arrow.visible = !hide;
      if (!hide) {
        _a.subVectors(gate.pos, p);
        if (_a.lengthSq() > 1e-4) _a.normalize(); else _a.copy(b.forward);
        if (dt > 0) this._arrowDir.lerp(_a, 1 - Math.exp(-dt * 5)).normalize(); else this._arrowDir.copy(_a);
        const H = 3.4 + Math.sin(this._t * 2.2) * 0.3;
        _b.set(p.x + b.forward.x * 1.5, p.y + H, p.z + b.forward.z * 1.5);
        arrow.position.copy(_b);
        _c.addVectors(_b, this._arrowDir);
        _m.lookAt(_c, _b, _up);   // +Z of the arrow toward the hoop
        arrow.quaternion.setFromRotationMatrix(_m);
      }
    }
  }

  _passedThisLap(r, i) {
    if (r.gatesTotal === 0) return false;
    if (r.nextGate === 0) return i !== 0;
    return i < r.nextGate;
  }
}

// ----------------------------------------------------------------- dev
/**
 * Standalone harness: `?mods=Submarine,SubRace&debug=1[&rubber=0]`.
 *
 * Lays 8 hoops in a descending spiral (surface → -40 m) around the origin,
 * makes the player a sub if it is not one already, spawns 2 AI subs and races
 * 3 laps, logging hoop passes, laps, finishes and standings to the console.
 */
export async function devInstall(game) {
  const params = new URLSearchParams(location.search);
  const rubberBand = params.get('rubber') !== '0';
  if (!game.player?.body?.isSub) await installSub(game);
  const ground = game.world?.heightAt || (() => -60);

  const N = 8, R = +(params.get('spiralR') || 110);
  // The spiral wants 40 m of water under every hoop and no portal in the way.
  // Around the origin when the world allows (bare sea); in the harbour hub the
  // island and pier are in the way, so try a few centres and take the first clear one.
  const portals = game.world?.def?.portals || [];
  // Score a centre by the shallowest seabed under its hoops (portals count as land).
  const shallowest = (cx, cz) => {
    let worst = -Infinity;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2, x = cx + Math.sin(a) * R, z = cz + Math.cos(a) * R;
      worst = Math.max(worst, ground(x, z));
      for (const p of portals) if (Math.hypot(p.x - x, p.z - z) < 40) worst = Math.max(worst, 0);
    }
    return worst;
  };
  let centre = params.get('center')?.split(',').map(Number);
  if (!centre || centre.length !== 2 || centre.some(Number.isNaN)) {
    centre = [0, 0];
    if (shallowest(0, 0) > -46) {
      // Grid search out to 500 m; nearest of the deep-enough centres, else the deepest found.
      let best = null;
      for (let cz = -500; cz <= 500; cz += 100) for (let cx = -500; cx <= 500; cx += 100) {
        const w = shallowest(cx, cz), d = Math.hypot(cx, cz);
        const ok = w <= -46;
        if (!best || (ok && !best.ok) || (ok === best.ok && (ok ? d < best.d : w < best.w))) best = { cx, cz, w, d, ok };
      }
      centre = [best.cx, best.cz];
    }
  }
  const [CX, CZ] = centre;
  const gates = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const x = CX + Math.sin(a) * R, z = CZ + Math.cos(a) * R;
    // Travel direction is the circle's tangent (counter-clockwise seen from above, heading grows toward +X).
    const heading = Math.atan2(Math.cos(a), -Math.sin(a));
    let y = -2 - 38 * (i / (N - 1));
    y = Math.min(Math.max(y, ground(x, z) + 8), -2);
    gates.push({ x: +x.toFixed(1), y: +y.toFixed(1), z: +z.toFixed(1), heading, width: 14 });
  }
  const g0 = gates[0];
  const start = { x: g0.x - Math.sin(g0.heading) * 16, y: game.sea.heightAt(g0.x, g0.z) - 0.5, z: g0.z - Math.cos(g0.heading) * 16, heading: g0.heading };
  const worldDef = { id: 'devspiral', name: 'Test Spiral', start, gates, laps: 3, bounds: 900 };
  console.log(`[subrace] dev course centred at ${CX},${CZ} (radius ${R}, shallowest seabed ${shallowest(CX, CZ).toFixed(1)} m)`, worldDef);

  const race = new SubRace(game, worldDef, { laps: 3, aiCount: 2, rubberBand });
  game.race = race;
  if (game.audio) race.onCountdown = (n) => game.audio.countdown?.(n);
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
      if (!race.acceptsInput && game.player) { const b = game.player.body; b.throttle = 0; b.steer = 0; b.boost = 0; b.dive = 0; }
    }
  };
  const prevStats = game.stats.bind(game);
  game.stats = () => {
    const st = prevStats();
    st.ai = race.standings.filter(s => s.ai).map(s => ({ name: s.name, gate: s.gate, lap: s.lap, gates: s.gatesTotal, y: +s.y.toFixed(1), kmh: +s.speedKmh.toFixed(0), stuck: s.stuckNudges }));
    return st;
  };
  return race;
}

function devLog(game, race) {
  const chain = (key, fn) => { const prev = race[key]; race[key] = (...a) => { prev?.(...a); fn(...a); }; };
  const label = (boat) => boat.label || boat.name;
  chain('onCountdown', (n) => console.log(`[subrace] countdown ${n || 'GO!'}`));
  chain('onGate', (boat, i) => console.log(`[subrace] ${label(boat)} passed hoop ${i}  t=${race.time.toFixed(1)}  y=${boat.body.position.y.toFixed(1)}`));
  chain('onLap', (boat, lap) => console.log(`[subrace] ${label(boat)} starts lap ${lap}  t=${race.time.toFixed(1)}`));
  chain('onFinish', (boat, place, time) => console.log(`[subrace] ${label(boat)} FINISHED place ${place} time ${time.toFixed(1)}`));
  let lastOrder = '';
  const prevUpdate = race.update.bind(race);
  race.update = (dt) => {
    prevUpdate(dt);
    const order = race.standings.map(s => `${s.position}:${s.name}(L${s.lap} g${s.gate})`).join(' ');
    if (order !== lastOrder) { lastOrder = order; console.log('[subrace] standings', order); }
  };
}
