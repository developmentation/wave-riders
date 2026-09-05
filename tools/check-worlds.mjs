/**
 * Validates every world in src/game/Worlds.js against its island heightfield
 * and draws a top-down map of each to tools/shots/map-<world>.png.
 *
 *   node tools/check-worlds.mjs            # all worlds
 *   node tools/check-worlds.mjs storm      # one world
 *
 * Rules: gates in open water (never touching land, incl. the corridor to the
 * next gate), spaced 120-250 m (or def.gateSpacing), no turn over 100 deg between consecutive
 * gates, start and portals in open water, portals clear of gates, <= 40 palms
 * per island, <= 8000 terrain triangles per island mesh.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { WORLDS } from '../src/game/Worlds.js';
import { createIslandField, fieldsHeight, pierHeight, DEEP } from '../src/game/Islands.js';

// Portal destinations that live outside Worlds.js (the submarine world) are
// valid when their module exists; until then they are accepted with a note.
const EXTERNAL_DESTS = new Set(['deep']);
let subWorlds = null;
try { subWorlds = (await import('../src/game/SubmarineWorld.js')).SUB_WORLDS || null; } catch (_) { /* not built yet */ }

const only = process.argv[2];
const OPEN_WATER = -1.5;      // metres of seabed under the keel counts as open water
const MIN_GAP = 120, MAX_GAP = 250, MAX_TURN = 100;
const outDir = path.resolve('tools/shots');
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const fail = (w, msg) => { failures++; console.log(`  FAIL [${w}] ${msg}`); };
const ok = (msg) => console.log(`  ok   ${msg}`);
const deg = (r) => r * 180 / Math.PI;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

for (const [id, def] of Object.entries(WORLDS)) {
  if (only && only !== id) continue;
  console.log(`\n== ${id} (${def.name}) ==`);
  const fields = def.islands.map(createIslandField);
  const piers = def.piers || [];
  const heightAt = (x, z) => {
    let h = fieldsHeight(fields, x, z);
    for (const p of piers) h = Math.max(h, pierHeight(p, x, z));
    return h;
  };
  const clear = (x, z, r, step = 2) => {
    let worst = -Infinity;
    for (let dx = -r; dx <= r; dx += step) for (let dz = -r; dz <= r; dz += step) {
      if (dx * dx + dz * dz > r * r) continue;
      worst = Math.max(worst, heightAt(x + dx, z + dz));
    }
    return worst;
  };

  // islands
  for (const f of fields) {
    const t = f.tris;
    if (t > 8000) fail(id, `island seed ${f.def.seed}: ${t} terrain triangles (> 8000)`);
    if ((f.def.palms | 0) > 40) fail(id, `island seed ${f.def.seed}: ${f.def.palms} palms (> 40)`);
    const peak = f.sample(f.def.x, f.def.z);
    console.log(`  island seed ${f.def.seed} ${f.def.shape || 'cone'} R${f.def.radius} h${f.def.height}: grid ${f.nu}x${f.nv}, ${t} tris, palms ${f.def.palms | 0}, centre h ${peak.toFixed(1)}`);
  }

  // start
  const s = def.start;
  const sh = clear(s.x, s.z, 14);
  if (sh > OPEN_WATER) fail(id, `start at (${s.x},${s.z}) is not in open water (terrain ${sh.toFixed(2)} m)`);
  else ok(`start (${s.x}, ${s.z}) heading ${deg(s.heading).toFixed(0)} deg, seabed ${sh.toFixed(1)} m`);

  // gates
  const G = def.gates;
  let lap = 0;
  for (let i = 0; i < G.length; i++) {
    const g = G[i], n = G[(i + 1) % G.length];
    const fx = Math.sin(g.heading), fz = Math.cos(g.heading);
    // the gate line itself, with a 12 m margin each side
    let worst = -Infinity;
    for (let t = -g.width / 2 - 12; t <= g.width / 2 + 12; t += 2) {
      worst = Math.max(worst, heightAt(g.x - fz * t, g.z + fx * t));
    }
    if (worst > OPEN_WATER) fail(id, `gate ${i} at (${g.x},${g.z}) touches land (terrain ${worst.toFixed(2)} m along the gate line)`);
    if (G.length < 2) continue;
    // spacing to the next gate
    const dx = n.x - g.x, dz = n.z - g.z, dist = Math.hypot(dx, dz);
    lap += dist;
    // a world may widen the spacing band (giant swell: one gate per roller)
    const [minGap, maxGap] = def.gateSpacing || [MIN_GAP, MAX_GAP];
    if (dist < minGap || dist > maxGap) fail(id, `gate ${i} -> ${(i + 1) % G.length}: spacing ${dist.toFixed(0)} m (want ${minGap}-${maxGap})`);
    // turn: heading change, and bearing to the next gate vs both headings
    const bearing = Math.atan2(dx, dz);
    const turn = Math.abs(deg(wrap(n.heading - g.heading)));
    const off1 = Math.abs(deg(wrap(bearing - g.heading)));
    const off2 = Math.abs(deg(wrap(n.heading - bearing)));
    if (turn > MAX_TURN) fail(id, `gate ${i} -> ${(i + 1) % G.length}: heading change ${turn.toFixed(0)} deg (> ${MAX_TURN})`);
    if (off1 > MAX_TURN * 0.7 || off2 > MAX_TURN * 0.7) fail(id, `gate ${i} -> ${(i + 1) % G.length}: next gate is ${off1.toFixed(0)}/${off2.toFixed(0)} deg off axis`);
    // corridor: straight chord between the gates, as wide as the gate
    let cw = -Infinity;
    const steps = Math.ceil(dist / 4);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps, cx = g.x + dx * t, cz = g.z + dz * t;
      const px = -dz / dist, pz = dx / dist;
      const w = (g.width * (1 - t) + n.width * t) / 2;
      for (let o = -w; o <= w; o += w / 2) cw = Math.max(cw, heightAt(cx + px * o, cz + pz * o));
    }
    if (cw > OPEN_WATER) fail(id, `corridor gate ${i} -> ${(i + 1) % G.length} crosses land (terrain ${cw.toFixed(2)} m)`);
  }
  if (G.length) {
    ok(`${G.length} gates, lap ${lap.toFixed(0)} m by chords (${def.lapLength || '?'} m along the curve), laps ${def.laps}`);
    const gaps = G.map((g, i) => { const n = G[(i + 1) % G.length]; return Math.hypot(n.x - g.x, n.z - g.z); });
    console.log(`  spacing min ${Math.min(...gaps).toFixed(0)} max ${Math.max(...gaps).toFixed(0)} m`);
    const turns = G.map((g, i) => Math.abs(deg(wrap(G[(i + 1) % G.length].heading - g.heading))));
    console.log(`  turn max ${Math.max(...turns).toFixed(0)} deg`);
    // the start line should sit between the last and the first gate
    const first = G[0];
    const dS = Math.hypot(first.x - s.x, first.z - s.z);
    if (dS < 40 || dS > 260) fail(id, `first gate is ${dS.toFixed(0)} m from the start`);
  }

  // portals
  for (const p of def.portals) {
    const ph = clear(p.x, p.z, 10);
    if (ph > OPEN_WATER) fail(id, `portal -> ${p.dest} at (${p.x},${p.z}) is not in open water (terrain ${ph.toFixed(2)} m)`);
    for (let i = 0; i < G.length; i++) {
      const d = Math.hypot(G[i].x - p.x, G[i].z - p.z);
      if (d < 45) fail(id, `portal -> ${p.dest} is ${d.toFixed(0)} m from gate ${i}`);
    }
    if (!WORLDS[p.dest] && !subWorlds?.[p.dest]) {
      if (EXTERNAL_DESTS.has(p.dest)) console.log(`  note portal dest '${p.dest}' is an external world (SubmarineWorld.js not present yet)`);
      else fail(id, `portal dest '${p.dest}' is not a world`);
    }
    const d0 = Math.hypot(p.x - s.x, p.z - s.z);
    if (id !== 'hub' && (d0 < 40 || d0 > 200)) fail(id, `return portal is ${d0.toFixed(0)} m from the start (want 40-200)`);
  }
  ok(`${def.portals.length} portal(s)`);

  // weather sanity
  const w = def.weather;
  if (!w?.key) fail(id, 'weather.key missing');
  if (!def.water?.scatter || !def.water?.absorb) fail(id, 'water scatter/absorb missing');

  drawMap(id, def, heightAt, fields);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall worlds pass');
process.exit(failures ? 1 : 0);

// -------------------------------------------------------------- map PNG
function drawMap(id, def, heightAt, fields) {
  const W = 720, H = 720;
  const R = def.bounds * 1.05;
  const px = new Uint8Array(W * H * 3);
  const put = (i, j, r, g, b) => { if (i < 0 || j < 0 || i >= W || j >= H) return; const k = (j * W + i) * 3; px[k] = r; px[k + 1] = g; px[k + 2] = b; };
  const toPx = (x, z) => [Math.round((x / R + 1) * 0.5 * (W - 1)), Math.round((1 - (z / R + 1) * 0.5) * (H - 1))];
  const toWorld = (i, j) => [(i / (W - 1) * 2 - 1) * R, (1 - j / (H - 1) * 2) * R];
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const [x, z] = toWorld(i, j);
    const h = heightAt(x, z);
    let r, g, b;
    if (h <= OPEN_WATER) {
      const t = Math.min(1, Math.max(0, (h - DEEP) / (OPEN_WATER - DEEP)));   // 0 deep .. 1 shallow
      r = 10 + 60 * t; g = 60 + 140 * t; b = 120 + 110 * t;
    } else if (h <= 1.4) { r = 240; g = 222; b = 160; }
    else {
      const t = Math.min(1, h / 45);
      r = 70 - 30 * t; g = 180 - 90 * t; b = 60 - 20 * t;
    }
    put(i, j, r, g, b);
  }
  const line = (x0, z0, x1, z1, c) => {
    const [a, b] = toPx(x0, z0), [c2, d] = toPx(x1, z1);
    const n = Math.max(Math.abs(c2 - a), Math.abs(d - b), 1);
    for (let k = 0; k <= n; k++) put(Math.round(a + (c2 - a) * k / n), Math.round(b + (d - b) * k / n), ...c);
  };
  const disc = (x, z, r, c) => { const [a, b] = toPx(x, z); for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) if (i * i + j * j <= r * r) put(a + i, b + j, ...c); };
  // grid rings every 250 m
  for (let rr = 250; rr < R; rr += 250) for (let a = 0; a < 720; a++) { const [i, j] = toPx(Math.cos(a / 720 * Math.PI * 2) * rr, Math.sin(a / 720 * Math.PI * 2) * rr); put(i, j, 255, 255, 255); }
  const G = def.gates;
  for (let i = 0; i < G.length; i++) {
    const g = G[i], n = G[(i + 1) % G.length];
    line(g.x, g.z, n.x, n.z, [255, 255, 255]);
  }
  for (let i = 0; i < G.length; i++) {
    const g = G[i];
    const fx = Math.sin(g.heading), fz = Math.cos(g.heading);
    line(g.x - fz * g.width / 2, g.z + fx * g.width / 2, g.x + fz * g.width / 2, g.z - fx * g.width / 2, [40, 255, 80]);
    line(g.x, g.z, g.x + fx * 30, g.z + fz * 30, [40, 255, 80]);
    disc(g.x, g.z, i === 0 ? 5 : 3, [40, 255, 80]);
  }
  for (const p of def.portals) {
    disc(p.x, p.z, 6, [255, 60, 255]);
    line(p.x, p.z, p.x + Math.sin(p.heading) * 40, p.z + Math.cos(p.heading) * 40, [255, 60, 255]);
  }
  const s = def.start;
  disc(s.x, s.z, 5, [255, 230, 40]);
  line(s.x, s.z, s.x + Math.sin(s.heading) * 45, s.z + Math.cos(s.heading) * 45, [255, 230, 40]);
  for (const f of fields) disc(f.def.x, f.def.z, 2, [0, 0, 0]);
  const file = path.join(outDir, `map-${id}.png`);
  fs.writeFileSync(file, encodePNG(W, H, px));
  console.log(`  map -> ${file}  (${R.toFixed(0)} m half-width, rings every 250 m)`);
}

function encodePNG(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => { raw[y * (w * 3 + 1) + 1 + i] = v; }); }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function crcTable() {
  if (crcTable.t) return crcTable.t;
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (crcTable.t = t);
}
function crc32(buf) {
  const T = crcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
