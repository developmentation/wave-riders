/**
 * Wave Riders — procedural WebAudio.
 *
 * Everything here is synthesized: no samples, no downloads. One AudioContext,
 * one persistent graph for the continuous sounds (engine, spray, wind, rain,
 * music) and short-lived node chains for one-shots that disconnect themselves
 * when they end. Every continuous parameter moves through setTargetAtTime so
 * per-frame updates never zipper.
 *
 * Signal flow
 *   engineBus ─┐
 *   sfxBus    ─┤
 *   musicGain ─┼─► master (Gain) ─► limiter (DynamicsCompressor) ─► analyser ─► destination
 *   ambientBus─┘
 *
 * Tuned for small ears in a shared room: moderate engine, quiet music, soft
 * limiter, nothing shrill. Before `unlock()` every method is a silent no-op.
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const SEMI = (n) => 2 ** (n / 12);
const MIN_GAIN = 0.0001;

const MOODS = {
  hub:   { bpm: 112, root: 261.63, minor: false, cutoff: 2400, kicks: [0, 2], arpGain: 1.0 },
  race:  { bpm: 128, root: 293.66, minor: false, cutoff: 3800, kicks: [0, 1, 2, 3], arpGain: 1.0 },
  storm: { bpm: 100, root: 220.00, minor: true,  cutoff: 1300, kicks: [0, 2], arpGain: 0.8 },
};
// Chord tones as semitone offsets from the key root. Every tone sits inside
// the key's pentatonic scale so any ordering sounds friendly.
const PROG_MAJOR = [[0, 4, 7, 9], [9, 12, 16, 19], [2, 4, 7, 9], [7, 9, 14, 16]];   // I  vi  ii  V
const PROG_MINOR = [[0, 3, 7, 10], [3, 7, 10, 15], [5, 7, 10, 12], [7, 10, 14, 15]]; // i  III IV  v
const ARP_A = [0, 1, 2, 3, 2, 1, 0, 2];
const ARP_B = [0, 2, 1, 3, 1, 2, 3, 1];

// Audio-thread level tap for tests (debugCapture). Lives on the render thread
// so it keeps measuring while the main thread is busy with a heavy frame.
const TAP_SRC = `
class WrTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reset();
    this.port.onmessage = (e) => { if (e.data === 'reset') this.reset(); else if (e.data === 'read') this.port.postMessage(this.stats()); };
  }
  reset() { this.sumSq = 0; this.n = 0; this.peak = 0; this.maxRms = 0; this.blockSq = 0; this.blockN = 0; }
  stats() { return { rms: this.n ? Math.sqrt(this.sumSq / this.n) : 0, peak: this.peak, maxRms: this.maxRms, seconds: this.n / sampleRate }; }
  process(inputs) {
    const ch = inputs[0];
    if (!ch || !ch.length) return true;
    const d = ch[0];
    let s = 0;
    for (let i = 0; i < d.length; i++) { const v = d[i]; s += v * v; const a = v < 0 ? -v : v; if (a > this.peak) this.peak = a; }
    this.sumSq += s; this.n += d.length; this.blockSq += s; this.blockN += d.length;
    if (this.blockN >= 2048) { const r = Math.sqrt(this.blockSq / this.blockN); if (r > this.maxRms) this.maxRms = r; this.blockSq = 0; this.blockN = 0; }
    return true;
  }
}
registerProcessor('wr-tap', WrTap);`;

export class GameAudio {
  constructor({ volume = 0.8 } = {}) {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
    this.volume = volume;
    this._engine = null;          // current engine rig
    this.devEngineType = null;    // dev override: audition another engine regardless of the boat
    this.devEngineOverride = null; // dev override: fields merged over setEngine's params, e.g. { rpm: 0.9, speed: 0.8 }
    this._tap = null; this._tapPromise = null; this._tapWaiters = [];
    this._lastSplash = 0;
    this._musicWanted = false;
    this._m = null;               // music scheduler state
    this._mood = 'hub';
    this._rainLevel = 0;
    this._windLevel = 0;
    this._onVis = () => { if (document.hidden) this.suspend(); else this.resume(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this._onVis);
  }

  // ------------------------------------------------------------------ lifecycle

  /** Create/resume the context. Call from a user gesture; safe to call any time. */
  unlock() {
    if (typeof window === 'undefined') return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!this.ctx) {
      try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch { return; }
      this._buildGraph();
      this.ready = true;
      if (this._rainLevel) { this._rainApplied = false; this.rain(this._rainLevel); }
      if (this._windLevel) { this._windApplied = false; this.wind(this._windLevel); }
      if (this._musicWanted) this.music(true);
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  suspend() { if (this.ready && this.ctx.state === 'running') this.ctx.suspend().catch(() => {}); }
  resume() { if (this.ready && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }

  mute(on) { this.muted = !!on; this._applyMaster(); }
  setVolume(v) { this.volume = clamp(v, 0, 1); this._applyMaster(); }

  dispose() {
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this._onVis);
    this.music(false);
    this._teardownEngine();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null; this.ready = false;
  }

  _applyMaster() {
    if (!this.ready) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.03);
  }

  _buildGraph() {
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 12;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 32768;
    this._anaBuf = new Float32Array(this.analyser.fftSize);
    this.master.connect(this.limiter); this.limiter.connect(this.analyser); this.analyser.connect(c.destination);

    const bus = (g) => { const n = c.createGain(); n.gain.value = g; n.connect(this.master); return n; };
    this.engineBus = bus(0.5);
    this.sfxBus = bus(0.7);
    this.ambientBus = bus(0.5);
    this.musicGain = bus(0.16);
    this.musicFilter = c.createBiquadFilter();
    this.musicFilter.type = 'lowpass'; this.musicFilter.frequency.value = MOODS.hub.cutoff; this.musicFilter.Q.value = 0.5;
    this.musicFilter.connect(this.musicGain);

    // Shared looping white noise: feeds every continuous noise voice.
    const len = Math.floor(c.sampleRate * 2);
    this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = c.createBufferSource(); this.noise.buffer = this.noiseBuf; this.noise.loop = true; this.noise.start();

    // Water hiss / spray: band-passed noise scaled by speed and submersion.
    this.sprayBP = c.createBiquadFilter(); this.sprayBP.type = 'bandpass'; this.sprayBP.frequency.value = 1800; this.sprayBP.Q.value = 0.7;
    this.sprayGain = c.createGain(); this.sprayGain.gain.value = 0;
    this.noise.connect(this.sprayBP); this.sprayBP.connect(this.sprayGain); this.sprayGain.connect(this.engineBus);

    // Ambient weather: wind (wobbling band-pass) and rain (broadband patter).
    this.windBP = c.createBiquadFilter(); this.windBP.type = 'bandpass'; this.windBP.frequency.value = 380; this.windBP.Q.value = 1.1;
    this.windLFO = c.createOscillator(); this.windLFO.type = 'sine'; this.windLFO.frequency.value = 0.19;
    this.windLFOGain = c.createGain(); this.windLFOGain.gain.value = 140;
    this.windLFO.connect(this.windLFOGain); this.windLFOGain.connect(this.windBP.frequency); this.windLFO.start();
    this.windGain = c.createGain(); this.windGain.gain.value = 0;
    this.noise.connect(this.windBP); this.windBP.connect(this.windGain); this.windGain.connect(this.ambientBus);

    this.rainHP = c.createBiquadFilter(); this.rainHP.type = 'highpass'; this.rainHP.frequency.value = 500;
    this.rainLP = c.createBiquadFilter(); this.rainLP.type = 'lowpass'; this.rainLP.frequency.value = 4500;
    this.rainGain = c.createGain(); this.rainGain.gain.value = 0;
    this.noise.connect(this.rainHP); this.rainHP.connect(this.rainLP); this.rainLP.connect(this.rainGain); this.rainGain.connect(this.ambientBus);
  }

  // ------------------------------------------------------------------ engine

  /**
   * Continuous engine + spray. Call every frame.
   * @param {'jetski'|'speedboat'|'pontoon'|'sailboat'} type
   * @param {{rpm:number, load:number, speed:number, submersion?:number, airborne?:boolean}} p
   *   rpm 0..1.2 (1 = flat out), load 0..1 (throttle), speed 0..1 as a fraction of
   *   the hull's max speed (Game.js passes body.speed / hull.maxSpeed).
   */
  setEngine(type, p) {
    if (!this.ready) return;
    type = this.devEngineType || type;
    if (this.devEngineOverride) p = { ...p, ...this.devEngineOverride };
    if (!this._engine || this._engine.type !== type) this._buildEngine(type);
    const now = this.ctx.currentTime;
    const rpm = clamp(p.rpm ?? 0, 0, 1.2);
    const load = clamp(p.load ?? 0, 0, 1);
    const speedFrac = clamp(p.speed ?? 0, 0, 1.2);
    const sub = p.submersion ?? 1;
    const air = !!p.airborne;
    this._engine.update(now, rpm, load, speedFrac, sub, air);

    // Spray: rises with speed, thins when the hull leaves the water.
    const spray = smoothstep(0.04, 0.7, speedFrac) * 0.34 * (air ? 0.15 : 0.45 + 0.55 * sub);
    this.sprayGain.gain.setTargetAtTime(spray, now, 0.08);
    this.sprayBP.frequency.setTargetAtTime(1500 + 2200 * speedFrac, now, 0.15);
  }

  _teardownEngine() {
    const rig = this._engine;
    if (!rig) return;
    const now = this.ctx.currentTime;
    rig.amp.gain.setTargetAtTime(0, now, 0.04);
    setTimeout(() => {
      for (const o of rig.oscs) { try { o.stop(); } catch { /* already stopped */ } }
      for (const n of rig.nodes) n.disconnect();
    }, 250);
    this._engine = null;
  }

  _buildEngine(type) {
    this._teardownEngine();
    const c = this.ctx, now = c.currentTime;
    const nodes = [], oscs = [];
    const mk = (n) => { nodes.push(n); return n; };
    const osc = (t, f) => { const o = mk(c.createOscillator()); o.type = t; o.frequency.value = f; o.start(); oscs.push(o); return o; };
    const gain = (g) => { const n = mk(c.createGain()); n.gain.value = g; return n; };
    const filt = (t, f, q = 0.8) => { const n = mk(c.createBiquadFilter()); n.type = t; n.frequency.value = f; n.Q.value = q; return n; };
    const amp = gain(0);          // overall engine level, faded in
    const lp = filt('lowpass', 800, 0.9);
    lp.connect(amp); amp.connect(this.engineBus);
    const rig = { type, nodes, oscs, amp, lp, update: null, nextFlap: 0 };
    const S = (param, v, tc) => param.setTargetAtTime(v, rig.now, tc);

    if (type === 'jetski') {
      // 2-stroke buzz: saw at the fundamental, square an octave up, fast response.
      const o1 = osc('sawtooth', 120), o2 = osc('square', 240); o2.detune.value = 6;
      const g1 = gain(0.32), g2 = gain(0.16);
      o1.connect(g1); o2.connect(g2); g1.connect(lp); g2.connect(lp);
      rig.update = (now, rpm, load, spd, sub, air) => {
        rig.now = now;
        const f = 95 + 215 * rpm;
        S(o1.frequency, f, 0.06); S(o2.frequency, f * 2, 0.06);
        S(lp.frequency, 700 + 2600 * rpm, 0.08);
        S(amp.gain, 0.42 * (0.35 + 0.65 * rpm) * (air ? 1.15 : 1), 0.06);
      };
    } else if (type === 'speedboat') {
      // V8 burble: detuned saws, subharmonic on idle, firing-rate AM, exhaust crackle.
      const o1 = osc('sawtooth', 60), o2 = osc('sawtooth', 60), o3 = osc('square', 30), o4 = osc('triangle', 120);
      o2.detune.value = -9;
      const g1 = gain(0.28), g2 = gain(0.28), g3 = gain(0.3), g4 = gain(0.1);
      o1.connect(g1); o2.connect(g2); o3.connect(g3); o4.connect(g4);
      for (const g of [g1, g2, g3, g4]) g.connect(lp);
      const lfo = osc('square', 30), lfoG = gain(0.12); lfo.connect(lfoG); lfoG.connect(amp.gain);
      // Crackle: pulsed band-passed noise into the engine filter, opened on load drops.
      const crBP = filt('bandpass', 1400, 2.5), crPulse = gain(0.5), crG = gain(0);
      const crLFO = osc('square', 17), crLFOG = gain(0.5); crLFO.connect(crLFOG); crLFOG.connect(crPulse.gain);
      this.noise.connect(crBP); crBP.connect(crPulse); crPulse.connect(crG); crG.connect(lp);
      let prevLoad = 0;
      rig.update = (now, rpm, load, spd, sub, air) => {
        rig.now = now;
        const f = 38 + 96 * rpm;
        S(o1.frequency, f, 0.12); S(o2.frequency, f, 0.13); S(o3.frequency, f * 0.5, 0.12); S(o4.frequency, f * 2, 0.12);
        S(lfo.frequency, f * 0.5, 0.12);
        S(g3.gain, 0.1 + 0.28 * (1 - clamp(rpm, 0, 1)), 0.2);
        S(lfoG.gain, 0.14 - 0.1 * clamp(rpm, 0, 1), 0.2);
        S(lp.frequency, 200 + 1300 * rpm, 0.12);
        S(amp.gain, 0.7 * (0.3 + 0.7 * rpm) * (air ? 1.1 : 1), 0.1);
        const drop = prevLoad - load;
        if (drop > 0.04 && rpm > 0.35) {
          crG.gain.cancelScheduledValues(now);
          crG.gain.setValueAtTime(Math.min(0.5, crG.gain.value + drop * 1.4), now);
          crG.gain.setTargetAtTime(0, now + 0.05, 0.28);
        }
        prevLoad += (load - prevLoad) * 0.3;
      };
    } else if (type === 'pontoon') {
      // Outboard putter: low saw + square with a per-firing amplitude chug.
      const o1 = osc('sawtooth', 50), o2 = osc('square', 50); o2.detune.value = 4;
      const g1 = gain(0.34), g2 = gain(0.17);
      o1.connect(g1); o2.connect(g2); g1.connect(lp); g2.connect(lp);
      const lfo = osc('square', 50), lfoG = gain(0.2); lfo.connect(lfoG); lfoG.connect(amp.gain);
      rig.update = (now, rpm, load, spd, sub, air) => {
        rig.now = now;
        const f = 30 + 70 * rpm;
        S(o1.frequency, f, 0.2); S(o2.frequency, f, 0.22); S(lfo.frequency, f, 0.2);
        S(lp.frequency, 260 + 760 * rpm, 0.2);
        S(amp.gain, 0.5 * (0.45 + 0.55 * rpm), 0.15);
      };
    } else {
      // Sailboat: no engine. Wind whoosh in the rigging plus occasional sail flaps.
      const bp = filt('bandpass', 300, 0.6);
      this.noise.connect(bp); bp.connect(lp);
      lp.frequency.value = 3000;
      rig.update = (now, rpm, load, spd, sub, air) => {
        rig.now = now;
        S(bp.frequency, 220 + 900 * spd, 0.3);
        S(amp.gain, 0.1 + 0.5 * smoothstep(0, 1, spd), 0.25);
        if (spd > 0.1 && now > rig.nextFlap) {
          this._noiseHit(this.engineBus, now, { type: 'bandpass', f: 500 + Math.random() * 500, q: 1.2, dur: 0.045, gain: 0.1 + 0.12 * spd, a: 0.004 });
          rig.nextFlap = now + 0.22 + Math.random() * (1.8 - spd);
        }
      };
    }
    rig.now = now;
    this._engine = rig;
  }

  // ------------------------------------------------------------------ voice helpers

  /**
   * Oscillator voice with an attack/sustain/release envelope; disconnects on end.
   * f2/slide glide the pitch; lp adds a low-pass at that cutoff.
   */
  _tone(dest, t, { type = 'sine', f = 440, f2 = 0, slide = 0, dur = 0.2, a = 0.005, r = 0.08, gain = 0.2, lp = 0, q = 0.7, detune = 0 }) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + (slide || dur));
    if (detune) o.detune.value = detune;
    const g = c.createGain();
    const rel = Math.max(t + a, t + dur - r), end = Math.max(rel + 0.005, t + dur);
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.exponentialRampToValueAtTime(Math.max(gain, MIN_GAIN), t + a);
    g.gain.setValueAtTime(Math.max(gain, MIN_GAIN), rel);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
    let last = o;
    if (lp) { const fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = lp; fl.Q.value = q; o.connect(fl); last = fl; }
    last.connect(g); g.connect(dest);
    o.start(t); o.stop(end + 0.02);
    o.onended = () => { o.disconnect(); g.disconnect(); if (last !== o) last.disconnect(); };
    return o;
  }

  /** Filtered noise burst from the shared buffer; disconnects on end. */
  _noiseHit(dest, t, { type = 'bandpass', f = 1000, f2 = 0, q = 0.8, dur = 0.1, a = 0.003, r = 0, gain = 0.2 }) {
    const c = this.ctx;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
    if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    const g = c.createGain();
    const rel = Math.max(t + a, t + dur - (r || dur * 0.6)), end = Math.max(rel + 0.005, t + dur);
    g.gain.setValueAtTime(MIN_GAIN, t);
    g.gain.exponentialRampToValueAtTime(Math.max(gain, MIN_GAIN), t + a);
    g.gain.setValueAtTime(Math.max(gain, MIN_GAIN), rel);
    g.gain.exponentialRampToValueAtTime(MIN_GAIN, end);
    src.connect(fl); fl.connect(g); g.connect(dest);
    src.start(t, Math.random() * 1.5); src.stop(end + 0.02);
    src.onended = () => { src.disconnect(); fl.disconnect(); g.disconnect(); };
    return src;
  }

  // ------------------------------------------------------------------ one-shots

  /** Bow slap / landing splash, intensity 0..1. Rate-limited to avoid machine-gunning. */
  splash(i = 0.5) {
    if (!this.ready) return;
    const now = this.ctx.currentTime;
    if (now - this._lastSplash < 0.12) return;
    this._lastSplash = now;
    const k = clamp(i, 0.1, 1);
    this._noiseHit(this.sfxBus, now, { type: 'lowpass', f: 1000, f2: 180, q: 0.9, dur: 0.5, a: 0.006, gain: 0.5 * k });
    this._noiseHit(this.sfxBus, now + 0.02, { type: 'bandpass', f: 2800, q: 0.8, dur: 0.22, a: 0.01, gain: 0.22 * k });
    this._tone(this.sfxBus, now, { type: 'sine', f: 95, f2: 38, dur: 0.28, a: 0.004, r: 0.2, gain: 0.4 * k });
  }

  /** Bright two-note chime for passing a gate. */
  gate() {
    if (!this.ready) return;
    const t = this.ctx.currentTime, d = this.sfxBus;
    for (const [i, f] of [[0, 880], [0.1, 1318.5]]) {
      this._tone(d, t + i, { type: 'sine', f, dur: 0.55, a: 0.004, r: 0.45, gain: 0.22 });
      this._tone(d, t + i, { type: 'triangle', f: f * 2, dur: 0.22, a: 0.004, r: 0.18, gain: 0.05 });
    }
  }

  /** Soft bonk for a missed / wrong-way gate. */
  wrongGate() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._tone(this.sfxBus, t, { type: 'triangle', f: 240, f2: 165, dur: 0.3, a: 0.004, r: 0.22, gain: 0.34, lp: 900 });
    this._tone(this.sfxBus, t, { type: 'sine', f: 120, f2: 80, dur: 0.3, a: 0.004, r: 0.22, gain: 0.2 });
    this._noiseHit(this.sfxBus, t, { type: 'lowpass', f: 500, q: 0.7, dur: 0.08, gain: 0.18 });
  }

  /** Two-second rising shimmer/whoosh for a portal transition. */
  portal() {
    if (!this.ready) return;
    const t = this.ctx.currentTime, d = this.sfxBus;
    this._noiseHit(d, t, { type: 'bandpass', f: 250, f2: 3600, q: 4, dur: 2.0, a: 1.3, r: 0.6, gain: 0.5 });
    for (const [f, det] of [[220, -6], [330, 6], [440, -5], [660, 5]]) {
      this._tone(d, t, { type: 'triangle', f, f2: f * 2, slide: 2.0, dur: 2.0, a: 0.9, r: 0.7, gain: 0.08, detune: det, lp: 2600 });
    }
    for (const [i, f] of [[1.55, 1568], [1.65, 2093], [1.75, 2637]]) {
      this._tone(d, t + i, { type: 'sine', f, dur: 0.35, a: 0.004, r: 0.3, gain: 0.14 });
    }
  }

  /** Countdown beeps: 3, 2, 1 short; 0 = "GO!" higher and longer. */
  countdown(n) {
    if (!this.ready) return;
    const t = this.ctx.currentTime, d = this.sfxBus;
    if (n > 0) {
      this._tone(d, t, { type: 'triangle', f: 660, dur: 0.15, a: 0.005, r: 0.08, gain: 0.3, lp: 2400 });
      this._tone(d, t, { type: 'sine', f: 660, dur: 0.15, a: 0.005, r: 0.08, gain: 0.18 });
    } else {
      this._tone(d, t, { type: 'triangle', f: 990, dur: 0.6, a: 0.006, r: 0.35, gain: 0.34, lp: 3200 });
      this._tone(d, t, { type: 'sine', f: 1320, dur: 0.6, a: 0.006, r: 0.35, gain: 0.1 });
    }
  }

  /** Finish fanfare: 1st triumphant, 2nd/3rd happy, 4th+ encouraging. */
  finish(place = 1) {
    if (!this.ready) return;
    const t0 = this.ctx.currentTime, d = this.sfxBus, base = 523.25;
    const play = (steps, durs, opts) => {
      let t = t0;
      steps.forEach((s, i) => {
        const f = base * SEMI(s), dur = durs[i];
        this._tone(d, t, { ...opts, f, dur, r: dur * 0.5 });
        if (opts.octave) this._tone(d, t, { type: 'triangle', f: f * 2, dur, a: opts.a, r: dur * 0.5, gain: opts.gain * 0.25 });
        t += dur * 0.92;
      });
    };
    if (place <= 1) play([0, 4, 7, 12, 7, 12], [0.16, 0.16, 0.16, 0.5, 0.16, 0.9], { type: 'sawtooth', a: 0.01, gain: 0.26, lp: 1900, q: 0.8, octave: true });
    else if (place <= 3) play([0, 4, 7, 12], [0.16, 0.16, 0.16, 0.7], { type: 'triangle', a: 0.01, gain: 0.26, lp: 2600, octave: true });
    else play([0, 2, 4], [0.22, 0.22, 0.7], { type: 'sine', a: 0.02, gain: 0.3 });
  }

  /** Boat horn per type. */
  horn(type = 'speedboat') {
    if (!this.ready) return;
    const t = this.ctx.currentTime, d = this.sfxBus;
    if (type === 'jetski') {
      this._tone(d, t, { type: 'square', f: 640, f2: 600, dur: 0.22, a: 0.008, r: 0.06, gain: 0.26, lp: 1500 });
    } else if (type === 'pontoon') {
      this._tone(d, t, { type: 'sawtooth', f: 320, f2: 680, slide: 0.6, dur: 0.8, a: 0.03, r: 0.2, gain: 0.3, lp: 1700 });
      this._tone(d, t, { type: 'triangle', f: 640, f2: 1360, slide: 0.6, dur: 0.8, a: 0.03, r: 0.2, gain: 0.1 });
    } else if (type === 'sailboat') {
      const f0 = 660;
      [[1, 0.34, 1.9], [2.0, 0.18, 1.4], [2.98, 0.11, 1.0], [4.2, 0.06, 0.7], [5.4, 0.03, 0.5]]
        .forEach(([m, g, dur]) => this._tone(d, t, { type: 'sine', f: f0 * m, dur, a: 0.003, r: dur * 0.9, gain: g }));
    } else {
      for (const f of [196, 247]) {
        this._tone(d, t, { type: 'sawtooth', f, dur: 0.75, a: 0.04, r: 0.15, gain: 0.2, lp: 1100 });
        this._tone(d, t, { type: 'square', f: f * 0.5, dur: 0.75, a: 0.04, r: 0.15, gain: 0.08, lp: 700 });
      }
    }
  }

  /** Sparkle for collecting a star. */
  star() {
    if (!this.ready) return;
    const t = this.ctx.currentTime, d = this.sfxBus;
    [1568, 2093, 2637, 3136].forEach((f, i) => this._tone(d, t + i * 0.05, { type: 'sine', f, dur: 0.1, a: 0.003, r: 0.06, gain: 0.22 }));
    this._tone(d, t + 0.2, { type: 'triangle', f: 3136, dur: 0.45, a: 0.01, r: 0.4, gain: 0.08, detune: 6 });
    this._tone(d, t + 0.2, { type: 'sine', f: 3136, dur: 0.45, a: 0.01, r: 0.4, gain: 0.08, detune: -6 });
  }

  /** UI tap. */
  click() {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this._tone(this.sfxBus, t, { type: 'sine', f: 1800, f2: 1400, dur: 0.04, a: 0.002, r: 0.025, gain: 0.3 });
    this._noiseHit(this.sfxBus, t, { type: 'highpass', f: 3000, dur: 0.025, a: 0.001, gain: 0.18 });
  }

  /** Thunder, arriving distance/340 s after the flash. Louder and crackier when close. */
  lightning(distance = 600) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + Math.max(0, distance) / 340;
    const amp = clamp(1.25 - distance / 3000, 0.15, 1);
    const d = this.sfxBus;
    if (distance < 900) this._noiseHit(d, t, { type: 'highpass', f: 700, q: 0.7, dur: 0.09, a: 0.002, gain: 0.3 * amp });
    this._noiseHit(d, t + 0.03, { type: 'lowpass', f: 220, f2: 55, q: 1.3, dur: 3.2, a: 0.12, r: 2.6, gain: 0.55 * amp });
    this._noiseHit(d, t + 0.5, { type: 'lowpass', f: 140, f2: 45, q: 1.1, dur: 2.6, a: 0.35, r: 1.9, gain: 0.35 * amp });
  }

  /** Continuous rain level 0..1. */
  rain(level) {
    level = clamp(level, 0, 1);
    if (this.ready && Math.abs(level - this._rainLevel) < 0.005 && this._rainApplied) return;  // called per frame
    this._rainLevel = level;
    if (!this.ready) return;
    this._rainApplied = true;
    this.rainGain.gain.setTargetAtTime(this._rainLevel * 0.45, this.ctx.currentTime, 0.4);
  }

  /** Continuous wind level 0..1. */
  wind(level) {
    level = clamp(level, 0, 1);
    if (this.ready && Math.abs(level - this._windLevel) < 0.005 && this._windApplied) return;
    this._windLevel = level;
    if (!this.ready) return;
    this._windApplied = true;
    const now = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(this._windLevel * 0.5, now, 0.5);
    this.windBP.frequency.setTargetAtTime(300 + 500 * this._windLevel, now, 0.6);
  }

  // ------------------------------------------------------------------ music

  /** Start/stop the procedural loop. Safe before unlock (starts once unlocked). */
  music(on) {
    this._musicWanted = !!on;
    if (!this.ready) return;
    const c = this.ctx;
    if (on) {
      if (this._m) return;
      this.musicGain.gain.setTargetAtTime(0.16, c.currentTime, 0.2);
      this._m = { step: 0, next: c.currentTime + 0.1, live: new Set(), timer: 0 };
      this._m.timer = setInterval(() => this._musicTick(), 60);
      this._applyMood();
      this._musicTick();
    } else if (this._m) {
      const m = this._m; this._m = null;
      clearInterval(m.timer);
      const now = c.currentTime;
      this.musicGain.gain.setTargetAtTime(0, now, 0.05);
      for (const src of m.live) { try { src.stop(now + 0.2); } catch { /* not started */ } }
    }
  }

  setMusicMood(mood) {
    if (!MOODS[mood]) return;
    this._mood = mood;
    this._applyMood();
  }

  _applyMood() {
    if (!this.ready) return;
    const mood = MOODS[this._mood];
    this.musicFilter.frequency.setTargetAtTime(mood.cutoff, this.ctx.currentTime, 0.5);
  }

  _musicTick() {
    const m = this._m; if (!m) return;
    const c = this.ctx, mood = MOODS[this._mood];
    while (m.next < c.currentTime + 0.25) {
      this._musicStep(m.next, m.step, mood);
      m.step++;
      m.next += 60 / mood.bpm / 2;   // eighth notes
    }
  }

  _musicStep(t, step, mood) {
    const m = this._m, fd = this.musicFilter, dd = this.musicGain;
    const eighth = step % 8, beat = eighth >> 1, bar = Math.floor(step / 8);
    const prog = mood.minor ? PROG_MINOR : PROG_MAJOR;
    const chord = prog[Math.floor(bar / 4) % prog.length];
    const track = (o) => { m.live.add(o); const prev = o.onended; o.onended = () => { m.live.delete(o); prev?.(); }; };
    // Arpeggio (an octave above the key root).
    const idx = (bar % 2 ? ARP_B : ARP_A)[eighth];
    const f = mood.root * SEMI(chord[idx] + 12);
    track(this._tone(fd, t, { type: 'triangle', f, dur: 0.24, a: 0.008, r: 0.16, gain: 0.5 * mood.arpGain }));
    // Bass on beats 1 and 3.
    if (eighth === 0 || eighth === 4) {
      const bassOct = mood.root < 250 ? -12 : -24;
      track(this._tone(fd, t, { type: 'sine', f: mood.root * SEMI(chord[0] + bassOct), dur: 0.45, a: 0.01, r: 0.2, gain: 0.55 }));
    }
    // Drums from noise + a sine thump, straight to the bus (no filter).
    if ((eighth & 1) === 0 && mood.kicks.includes(beat)) {
      track(this._tone(dd, t, { type: 'sine', f: 150, f2: 45, slide: 0.09, dur: 0.18, a: 0.002, r: 0.12, gain: 0.7 }));
    }
    track(this._noiseHit(dd, t, { type: 'highpass', f: 6500, dur: eighth & 1 ? 0.07 : 0.035, a: 0.001, gain: eighth & 1 ? 0.16 : 0.1 }));
  }

  // ------------------------------------------------------------------ diagnostics

  /** RMS of the most recent output window (~0.7 s), 0 before unlock. */
  debugLevel() {
    if (!this.ready) return 0;
    this.analyser.getFloatTimeDomainData(this._anaBuf);
    let s = 0; const b = this._anaBuf;
    for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    return Math.sqrt(s / b.length);
  }

  /**
   * Measure the output for `seconds`; resolves { rms, peak, maxRms, seconds }.
   * Uses an AudioWorklet tap on the render thread when available (accurate even
   * when the main thread stalls), else polls the analyser.
   */
  async debugCapture(seconds = 1) {
    if (!this.ready) return { rms: 0, peak: 0, maxRms: 0, seconds: 0 };
    const tap = await this._ensureTap();
    if (tap) {
      const empty = { rms: 0, peak: 0, maxRms: 0, seconds: 0 };
      const read = () => new Promise((resolve) => {
        const timer = setTimeout(() => { const i = this._tapWaiters.indexOf(done); if (i >= 0) this._tapWaiters.splice(i, 1); resolve(empty); }, 1500);
        const done = (s) => { clearTimeout(timer); resolve(s); };
        this._tapWaiters.push(done); tap.port.postMessage('read');
      });
      // Wait for `seconds` of *rendered* audio: a headless/fake output device
      // advances the audio clock in bursts, so wall time is not a reliable proxy.
      tap.port.postMessage('reset');
      const t0 = performance.now(), cap = seconds * 4000 + 3000;
      let stats = empty;
      do { await new Promise(r => setTimeout(r, 100)); stats = await read(); } while (stats.seconds < seconds && performance.now() - t0 < cap);
      return stats;
    }
    return new Promise((resolve) => {
      const buf = this._anaBuf, ana = this.analyser;
      let sumSq = 0, n = 0, peak = 0, maxRms = 0, windows = 0;
      const t0 = performance.now();
      const tick = () => {
        ana.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) { const v = buf[i]; s += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
        sumSq += s; n += buf.length; windows++;
        maxRms = Math.max(maxRms, Math.sqrt(s / buf.length));
        if (performance.now() - t0 < seconds * 1000) setTimeout(tick, 120);
        else resolve({ rms: Math.sqrt(sumSq / n), peak, maxRms, seconds: (performance.now() - t0) / 1000, windows });
      };
      tick();
    });
  }

  /** Lazily install the worklet tap (limiter → tap → silent sink). Resolves null if unsupported. */
  _ensureTap() {
    if (this._tap) return Promise.resolve(this._tap);
    if (!this._tapPromise) {
      this._tapPromise = (async () => {
        const c = this.ctx;
        if (!c.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;
        const url = URL.createObjectURL(new Blob([TAP_SRC], { type: 'application/javascript' }));
        try { await c.audioWorklet.addModule(url); } catch { return null; } finally { URL.revokeObjectURL(url); }
        const node = new AudioWorkletNode(c, 'wr-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.onmessage = (e) => { const w = this._tapWaiters.shift(); w?.(e.data); };
        const sink = c.createGain(); sink.gain.value = 0;
        this.limiter.connect(node); node.connect(sink); sink.connect(c.destination);
        this._tap = node;
        return node;
      })();
    }
    return this._tapPromise;
  }
}

/**
 * Derive engine parameters from a BoatPhysics body. Game.js can call
 * `audio.setEngine(boat.name, engineParamsFromBody(boat.body))` every frame.
 */
export function engineParamsFromBody(body) {
  const thr = clamp(body.throttle, -0.5, 1);
  const load = Math.abs(thr);
  const speedFrac = clamp(body.speed / body.hull.maxSpeed, 0, 1);
  let rpm = 0.12 + 0.55 * load + 0.33 * speedFrac;
  if (body.airborne) rpm += 0.3 * load;      // prop out of the water: revs up
  if (body.boost > 0) rpm += 0.1 * body.boost;
  return { rpm: clamp(rpm, 0, 1.2), load, speed: speedFrac, submersion: body.submersion, airborne: body.airborne };
}

/**
 * Standalone dev harness: `?mods=Audio`. Unlocks on first gesture, drives the
 * engine from the player boat, starts music, and binds test keys
 * 1=gate 2=portal 3=countdown 4=finish(1) 5=horn 6=lightning 7=star.
 * Set `__audio.devEngineType = 'jetski'` to audition another engine.
 */
export function devInstall(game) {
  // Game.js may already own a GameAudio and drive it every frame; reuse it so
  // there is exactly one context and one engine. Otherwise drive it ourselves.
  // (Duck-typed: Vite HMR can hand Game.js and this dev import different module
  // instances of the same file, which breaks instanceof.)
  const owned = !!game.audio && typeof game.audio.setEngine === 'function' && typeof game.audio.debugCapture === 'function';
  const audio = owned ? game.audio : new GameAudio();
  window.__audio = audio;

  const unlock = () => {
    audio.unlock();
    audio.music(true);
    if (audio.ctx?.state === 'running') {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    }
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  if (!owned) {
    const update = game.update.bind(game);
    let lastSlap = 0;
    game.update = (dt, rawDt) => {
      update(dt, rawDt);
      const boat = game.player;
      if (!boat || !audio.ready) return;
      const b = boat.body;
      audio.setEngine(boat.name, engineParamsFromBody(b));
      if (b.slapImpulse > lastSlap + 0.15) audio.splash(b.slapImpulse);
      lastSlap = b.slapImpulse;
    };
  }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const type = audio.devEngineType || game.player?.name || 'speedboat';
    switch (e.code) {
      case 'Digit1': audio.gate(); break;
      case 'Digit2': audio.portal(); break;
      case 'Digit3': [3, 2, 1, 0].forEach((n, i) => setTimeout(() => audio.countdown(n), i * 1000)); break;
      case 'Digit4': audio.finish(1); break;
      case 'Digit5': audio.horn(type); break;
      case 'Digit6': audio.lightning(300); break;
      case 'Digit7': audio.star(); break;
      default: return;
    }
  });
  console.log('[Audio] dev harness: 1 gate, 2 portal, 3 countdown, 4 finish, 5 horn, 6 lightning, 7 star; window.__audio');
}
