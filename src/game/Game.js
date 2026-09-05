import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { CONDITIONS } from '../ui/Sandbox.js';
import { Sea } from './WaveField.js';
import { BoatPhysics, HULLS } from './BoatPhysics.js';
import { Controls } from './Controls.js';
import { FollowCamera } from './FollowCamera.js';
import { PropMaterial, convertToProps, trackMotion } from './PropMaterial.js';

/**
 * Game controller. Owns the sea probe, the boats, the camera and the input, and
 * runs the simulation inside the engine's frame (before the ocean steps, so
 * the camera that frames this frame's boat is the one the renderer uses).
 *
 * Flow: title → garage → hub (portals) → race world → results → hub.
 * Every optional module (HUD, audio, worlds, race, portals, wake, boats) is
 * imported dynamically and guarded, so the core drive loop always works even
 * while a module is missing or broken.
 */
const MODEL_BASE = './models/kenney-watercraft/';
const _ca = new THREE.Vector3(), _cb = new THREE.Vector3(), _cn = new THREE.Vector3(), _cv = new THREE.Vector3();
const STARS_KEY = 'waveriders.stars.v1';

// Fallback visuals if Boats.js is unavailable.
const FALLBACK_MODELS = {
  speedboat: { file: 'boat-speed-a.glb', length: 3.37, yaw: 0, lift: 0.0 },
  sailboat: { file: 'boat-sail-a.glb', length: 3.77, yaw: 0, lift: 0.0 },
};

async function optional(path) {
  try { return await import(path); }
  catch (e) { console.warn(`[game] module ${path} unavailable:`, e?.message || e); return null; }
}

export class Game {
  constructor(app) {
    this.app = app;
    this.scene = app.scene;
    this.params = new URLSearchParams(location.search);
    this.sea = new Sea(app, { coarse: { cells: 64, span: 200 }, fine: { cells: 40, span: 30 } });
    this.controls = new Controls();
    this.camera = new FollowCamera(app, this.sea);
    this.loader = new GLTFLoader();
    this.boats = [];
    this.player = null;
    this.state = 'boot';          // boot | title | garage | hub | race | results | paused
    this.time = 0;
    this.wind = { angle: 0, speed: 5 };
    this._modelCache = new Map();
    this.debug = this.params.get('debug') === '1';
    this.mods = {};
    this.world = null;
    this.race = null;
    this.portals = null;
    this.wake = null;
    this.hud = null;
    this.audio = null;
    this.selectedBoat = this.params.get('boat') || 'speedboat';
    this.selectedColor = 0;
    this.stars = this._loadStars();
    this._pausedState = null;
    this._frameData = { speedKmh: 0, lap: 0, laps: 0, position: 0, racers: 0, time: 0, countdown: 0, nextGateDir: 0, state: 'boot', stars: 0, world: 'hub' };
  }

  // ------------------------------------------------------------------ boot
  async init() {
    const app = this.app;
    app.cine.diveController = this.camera;
    app.cine.setFree(false);
    app.cine.shot = null;
    // Hold 60: the adaptive loop tolerates +25 %, so aim a little under 16.7.
    app.quality.targetMs = 15;
    // Resolution floor in absolute pixels, not a fraction of the window: a
    // 1440p or high-DPI screen must be allowed to drop as far as a 720p one.
    const floor = () => { app.quality.minScale = THREE.MathUtils.clamp(440 / (window.innerHeight * Math.min(window.devicePixelRatio || 1, app.quality.maxPixelRatio)), 0.3, 0.75); };
    floor();
    window.addEventListener('resize', floor);
    app.quality.canUpgrade = true;
    // First seconds are shader compiles, not steady state: do not shed tiers on them.
    app.quality._cooldown = 6.0;
    // Bloom at strength 0.055 is invisible on the water and costs half a millisecond.
    app.post.settings.bloom = false;
    // Fill any gap between wave rows with water-coloured sky (no submerged pass in game mode).
    if (app.surfaceOnly) app.sky.bgMaterial.uniforms.uSeaFill.value = 1;
    let matte = this.params.get('matte');
    if (matte === null) { try { matte = localStorage.getItem('waveriders.matte'); } catch (_) { matte = null; } }
    if (matte && matte !== '0') this.setMatte(true);

    const [Boats, Worlds, Hud, Audio, Race, Portals, Wake, ShoreFoam, SubmarineWorld, Submarine, SubRace] = await Promise.all([
      optional('./Boats.js'), optional('./Worlds.js'), optional('./Hud.js'), optional('./Audio.js'),
      optional('./Race.js'), optional('./Portals.js'), optional('./Wake.js'), optional('./ShoreFoam.js'),
      optional('./SubmarineWorld.js'), optional('./Submarine.js'), optional('./SubRace.js'),
    ]);
    this.mods = { Boats, Worlds, Hud, Audio, Race, Portals, Wake, ShoreFoam, SubmarineWorld, Submarine, SubRace };
    if (ShoreFoam?.ShoreFoam) this.shoreFoam = new ShoreFoam.ShoreFoam(this);

    if (Audio?.GameAudio) {
      this.audio = new Audio.GameAudio();
      const unlock = () => { this.audio.unlock?.(); };
      window.addEventListener('pointerdown', unlock, { passive: true });
      window.addEventListener('keydown', unlock);
    }
    if (Wake?.Wake) this.wake = new Wake.Wake(this);
    // Thunder: every lightning strike reports its distance to the player.
    if (this.audio?.lightning && app.lightning?.strike) {
      const strike = app.lightning.strike.bind(app.lightning);
      app.lightning.strike = (x, z, top) => {
        strike(x, z, top);
        const p = this.player?.body.position;
        if (p) this.audio.lightning(Math.hypot(x - p.x, z - p.z));
      };
    }
    if (Portals?.Portals) this.portals = new Portals.Portals(this);

    // The harbour hub is where everything starts.
    await this.loadWorld('hub');
    const start = this.world?.def?.start || { x: 0, z: 0, heading: 0 };
    this.player = await this.spawnBoat(this.selectedBoat, start.x, start.z, start.heading, this.selectedColor);
    this.camera.follow(this.player.body);
    this.wake?.attach?.(this.player);

    if (Hud?.Hud) {
      this.hud = new Hud.Hud(this);
      this._wireHud();
      if (Boats?.BOAT_CATALOG) this.hud.setBoats?.(Object.values(Boats.BOAT_CATALOG));
      this.hud.setStars?.(this.stars);
    }

    const before = app.beforeUpdate;
    app.beforeUpdate = (scaled, dt) => { before?.(scaled, dt); this.update(scaled, dt); };

    // Dev hook: ?mods=Islands,Portals dynamically imports src/game/<Name>.js and
    // calls its devInstall(game) so a module can be exercised before it is
    // wired into the game flow.
    const mods = this.params.get('mods');
    if (mods) {
      for (const m of mods.split(',').filter(Boolean)) {
        try {
          const mod = await import(`./${m}.js`);
          await mod.devInstall?.(this);
          console.log('[mods] installed', m);
        } catch (e) { console.error('[mods] failed', m, e); }
      }
    }

    if (this.debug) {
      this.devEl = document.createElement('div');
      this.devEl.className = 'dev';
      document.getElementById('hud').appendChild(this.devEl);
    }
  }

  start() {
    const skip = this.params.get('skip'); // skip=title → straight into the hub; skip=race → straight into a race world
    if (this.params.get('mods') || skip === 'title' || !this.hud) { this.enterHub(); }
    else if (skip && (this.mods.Worlds?.WORLDS?.[skip] || this.mods.SubmarineWorld?.SUB_WORLDS?.[skip])) { this.enterWorld(skip); }
    else this.showTitle();
  }

  // ----------------------------------------------------------------- screens
  showTitle() {
    this.state = 'title';
    this.camera.orbit = { angle: 0.6, dist: 1.6, height: 0.5, speed: 0.15, fov: 42 };
    this.hud?.show('title');
    this.audio?.setMusicMood?.('hub');
    this.audio?.music?.(true);
  }

  showGarage() {
    this.state = 'garage';
    this.camera.orbit = { angle: this.camera.orbit?.angle ?? 0.6, dist: 1.7, height: 0.45, speed: 0.35, fov: 40 };
    this.hud?.show('garage');
  }

  async selectBoat(id, colorIndex = 0) {
    if (!HULLS[id] && !this.mods.Boats?.BOAT_CATALOG?.[id]) return;
    this.selectedBoat = id;
    this.selectedColor = colorIndex | 0;
    const b = this.player.body;
    const old = this.player;
    const boat = await this.spawnBoat(id, b.position.x, b.position.z, b.heading, this.selectedColor);
    this.removeBoat(old);
    this.player = boat;
    this.camera.follow(boat.body);
    this.wake?.attach?.(boat);
    this.audio?.click?.();
  }

  enterHub() {
    if (this.world?.id !== 'hub') { this.enterWorld('hub'); return; }
    this.state = 'hub';
    this.camera.orbit = null;
    this.hud?.show('hub');
    this.audio?.setMusicMood?.('hub');
    this.audio?.music?.(true);
  }

  _wireHud() {
    const h = this.hud;
    if (!h?.on) return;
    h.on('start', () => { if (this.state === 'title') this.showGarage(); else if (this.state === 'garage') this.enterHub(); });
    h.on('selectBoat', (id, color) => this.selectBoat(id, color));
    h.on('pause', () => this.pause());
    h.on('resume', () => this.resume());
    h.on('camera', () => this.camera.nextView());
    h.on('reset', () => this.player?.body.reset());
    h.on('mute', () => this.toggleMute());
    h.on('horn', () => this.audio?.horn?.(this.player?.name));
    h.on('exit', () => { this.resume(true); this.enterWorld('hub'); });
    h.on('raceAgain', () => { if (this.world) this.enterWorld(this.world.id); });
    h.on('matte', () => this.setMatte(!this.matte));
    h.on('garage', () => { this.resume(true); this.enterWorld('hub').then(() => this.showGarage()); });
  }

  pause() {
    if (this.state === 'paused' || this.state === 'title' || this.state === 'garage') return;
    this._pausedState = this.state;
    this.state = 'paused';
    this.app.paused = true;
    this.hud?.show('paused');
    this.audio?.suspend?.();
  }

  resume(silent = false) {
    if (this.state !== 'paused') return;
    this.state = this._pausedState || 'hub';
    this.app.paused = false;
    if (!silent) this.hud?.show(this.state === 'race' ? 'race' : 'hub');
    this.audio?.resume?.();
  }

  /** Water look: shiny (default) or matte grey topography, remembered per browser. */
  setMatte(on) {
    this.matte = !!on;
    this.app.oceanMesh.setMatte(this.matte ? (this.params.get('matte') === '2' ? 2 : 1) : 0);
    this.hud?.root?.classList.toggle('wr-matte', this.matte);
    try { localStorage.setItem('waveriders.matte', this.matte ? '1' : '0'); } catch (_) { /* ignore */ }
  }

  toggleMute() {
    this.muted = !this.muted;
    this.audio?.mute?.(this.muted);
    try { localStorage.setItem('waveriders.muted', this.muted ? '1' : '0'); } catch (_) { /* private mode */ }
  }

  // ----------------------------------------------------------------- worlds
  setWeather(key, immediate = false) {
    const c = CONDITIONS[key];
    if (!c) return;
    this.app.weather.set(c.w, immediate);
    this.weatherKey = key;
  }

  async loadWorld(id, immediate = true) {
    const W = this.mods.Worlds, SW = this.mods.SubmarineWorld;
    this.world?.dispose?.();
    this.world = null;
    this.app.director?.clearEvents?.();
    this._setSubmerged(false);
    if (SW?.buildSubWorld && SW.SUB_WORLDS?.[id]) {
      this.world = SW.buildSubWorld(id, { app: this.app, atmosphere: this.app.atmosphere, scene: this.scene, game: this });
      if (this.world.group && !this.world.group.parent) this.scene.add(this.world.group);
      this.app.discardNextFrameTiming = true;
      const wk = this.world.def?.weather;
      if (W?.applyWorldWeather && wk) W.applyWorldWeather(this.app, this.world.def, immediate);
      else { this.setWeather(wk?.key || 'clear', immediate); if (wk?.patch) this.app.weather.set(wk.patch, immediate); }
    } else if (W?.buildWorld && W.WORLDS?.[id]) {
      this.world = W.buildWorld(id, { app: this.app, atmosphere: this.app.atmosphere, scene: this.scene, game: this });
      if (this.world.group && !this.world.group.parent) this.scene.add(this.world.group);
      if (W.applyWorldWeather) W.applyWorldWeather(this.app, this.world.def, immediate);
      else this.setWeather(this.world.def?.weather?.key || 'clear', immediate);
    } else {
      // No worlds module yet: bare sea with a sensible weather per id.
      const fallback = {
        hub: ['golden', { windSpeed: 3.5, swellHs: 0.35, swellPeriod: 9, choppiness: 1.0, foamStrength: 0.4 }],
        lagoon: ['clear', { windSpeed: 4.0, swellHs: 0.5, swellPeriod: 8, foamStrength: 0.5 }],
        swell: ['trade', { windSpeed: 8.0, swellHs: 1.8, swellPeriod: 12 }],
        storm: ['squall', { windSpeed: 17, swellHs: 3.0, swellPeriod: 10 }],
      }[id] || ['clear', {}];
      this.setWeather(fallback[0], immediate);
      this.app.weather.set(fallback[1], immediate);
      this.world = { id, def: { id, start: { x: 0, z: 0, heading: 0 }, portals: [], gates: [] }, heightAt: () => -50, dispose() {} };
    }
    this.world.id = id;
    this.sea.setSpan?.(this.world.def?.probeSpan || 200);
    this.shoreFoam?.build?.(this.world);
    for (const b of this.boats) b.body.groundFn = this.world.heightAt || null;
    this.portals?.build?.(this.world.def?.portals || []);
    this.weatherKey = this.world.def?.weather?.key || this.weatherKey;
  }

  /** Portal jump: white-out, rebuild the world around the origin, race or hub. */
  async enterWorld(id) {
    if (this._transitioning) return;
    this._transitioning = true;
    const doSwitch = async () => {
      this.race?.dispose?.();
      this.race = null;
      // Keep only the player's boat.
      for (const b of [...this.boats]) if (b !== this.player) this.removeBoat(b);
      // The white-out hides the switch, so the new sky and sea arrive fully formed.
      await this.loadWorld(id, true);
      const def = this.world.def || {};
      const s = def.start || { x: 0, z: 0, heading: 0 };
      // Submarine worlds swap the player's boat for a sub; surface worlds swap it back.
      const wantSub = !!def.underwater && !!this.mods.Submarine?.SubPhysics;
      if (wantSub !== !!this.player.body.isSub) {
        const old = this.player;
        this.player = wantSub ? await this.spawnSub(s.x, s.y ?? 0, s.z, s.heading || 0)
          : await this.spawnBoat(this.selectedBoat, s.x, s.z, s.heading || 0, this.selectedColor);
        this.removeBoat(old);
        if (!wantSub) this.wake?.attach?.(this.player);
      }
      this.camera.mode = wantSub ? 'sub' : 'boat';
      if (wantSub) setTimeout(() => this.hud?.toast?.(this.hud?.touch ? '▼ dive  ▲ rise' : 'Q dive · E rise'), 1200);
      const y = wantSub ? (s.y ?? this.sea.meanHeight(s.x, s.z)) : this.sea.meanHeight(s.x, s.z) + 0.3;
      this.player.body.setPose(s.x, y, s.z, s.heading || 0);
      this.camera.orbit = null;
      this.camera.follow(this.player.body);
      this.sea.setFocus(s.x, s.z);
      const RaceClass = wantSub ? this.mods.SubRace?.SubRace : this.mods.Race?.Race;
      if (def.gates?.length && RaceClass) {
        this.race = new RaceClass(this, def, { laps: def.laps ?? 3 });
        this._wireRace(this.race);
        await this.race.setup?.();
        for (const b of this.boats) { b.body.groundFn = this.world.heightAt || null; if (b !== this.player) this.wake?.attach?.(b); }
        this.state = 'race';
        this.hud?.show('race');
        this.audio?.setMusicMood?.(id === 'storm' || id === 'tempest' ? 'storm' : 'race');
        this.audio?.music?.(true);
        this.race.start?.();
      } else {
        this.state = 'hub';
        this.hud?.show('hub');
        this.audio?.setMusicMood?.('hub');
      }
      this.app.post.reset = true;
    };
    try {
      if (this.portals?.transition) await this.portals.transition(doSwitch);
      else await doSwitch();
    } catch (e) {
      console.error('[game] world switch failed', e);
      this.state = 'hub';
    } finally { this._transitioning = false; }
  }

  _wireRace(race) {
    race.onCountdown = (n) => { this.audio?.countdown?.(n); };
    race.onGate = (boat, i) => { if (boat === this.player) { this.audio?.gate?.(); } };
    // Lap toasts come from the HUD itself (it watches frameData.lap); audio only here.
    race.onLap = (boat) => { if (boat === this.player) this.audio?.star?.(); };
    race.onFinish = (boat, place, time) => {
      if (boat !== this.player) return;
      const stars = place === 1 ? 3 : place === 2 ? 2 : 1;
      const id = this.world.id;
      const prev = this.stars[id] || { stars: 0, best: Infinity };
      this.stars[id] = { stars: Math.max(prev.stars, stars), best: Math.min(prev.best ?? Infinity, time) };
      this._saveStars();
      this.hud?.setStars?.(this.stars);
      this.audio?.finish?.(place);
      this.state = 'results';
      this.hud?.show('results', { place, time, stars, best: this.stars[id].best, racers: this.boats.length, world: id });
    };
  }

  _loadStars() { try { return JSON.parse(localStorage.getItem(STARS_KEY) || '{}'); } catch (_) { return {}; } }
  _saveStars() { try { localStorage.setItem(STARS_KEY, JSON.stringify(this.stars)); } catch (_) { /* ignore */ } }

  // ------------------------------------------------------------------ boats
  async loadModel(file) {
    if (this._modelCache.has(file)) return this._modelCache.get(file).clone(true);
    const gltf = await this.loader.loadAsync(MODEL_BASE + file);
    this._modelCache.set(file, gltf.scene);
    return gltf.scene.clone(true);
  }

  /** Create a boat: physics body + visual group, placed on the water. */
  async spawnBoat(id, x, z, heading = 0, colorIndex = 0) {
    const cat = this.mods.Boats?.BOAT_CATALOG?.[id];
    const hull = HULLS[cat?.hull || id] || HULLS.speedboat;
    const body = new BoatPhysics(hull, this.sea);
    body.groundFn = this.world?.heightAt || null;
    const group = new THREE.Group();
    let visual = null;
    if (this.mods.Boats?.buildBoatVisual) {
      try { visual = await this.mods.Boats.buildBoatVisual(id, { atmosphere: this.app.atmosphere, loader: this.loader, colorIndex, game: this }); }
      catch (e) { console.warn('[game] boat visual failed, using fallback', e); }
    }
    if (!visual) {
      const spec = FALLBACK_MODELS[id];
      if (spec) {
        try {
          visual = await this.loadModel(spec.file);
          convertToProps(visual, this.app.atmosphere, { roughness: 0.45 });
          visual.scale.setScalar(hull.length / spec.length);
          visual.rotation.y = spec.yaw;
          visual.position.y = -hull.draft * 0.35 + spec.lift;
        } catch (e) { console.warn('[game] model failed, using placeholder', e); visual = null; }
      }
    }
    if (!visual) visual = this.placeholderHull(hull);
    group.add(visual);
    this.scene.add(group);
    const y = this.sea.heightAt(x, z) + 0.3;
    body.setPose(x, y, z, heading);
    group.position.copy(body.position);
    group.quaternion.copy(body.quaternion);
    const boat = { name: id, hull, body, group, visual, colorIndex };
    this.boats.push(boat);
    return boat;
  }

  /** Create a submarine (player or AI) at a 3D position. */
  async spawnSub(x, y, z, heading = 0, colorIndex = 0) {
    const S = this.mods.Submarine;
    const body = new S.SubPhysics();
    body.groundFn = this.world?.heightAt || null;
    body.ceilingFn = (px, pz) => this.sea.heightAt(px, pz);
    const group = new THREE.Group();
    let visual = null;
    try { visual = await S.buildSubVisual({ atmosphere: this.app.atmosphere, colorIndex, game: this }); }
    catch (e) { console.warn('[game] sub visual failed', e); }
    if (!visual) visual = this.placeholderHull({ width: 1.6, length: 6 });
    group.add(visual);
    this.scene.add(group);
    body.setPose(x, y, z, heading);
    group.position.copy(body.position);
    group.quaternion.copy(body.quaternion);
    const sub = { name: 'sub', hull: body.hull, body, group, visual, colorIndex, isSub: true };
    this.boats.push(sub);
    return sub;
  }

  /** Underwater look on/off (only meaningful in submarine worlds). */
  _setSubmerged(on) {
    if (this._submerged === on) return;
    this._submerged = on;
    this.mods.SubmarineWorld?.setSubmerged?.(this.app, on, this.world?.def?.fog);
  }

  removeBoat(boat) {
    if (!boat) return;
    this.scene.remove(boat.group);
    this.wake?.detach?.(boat);
    boat.group.traverse((o) => { if (o.isMesh) o.geometry?.dispose?.(); });
    const i = this.boats.indexOf(boat);
    if (i >= 0) this.boats.splice(i, 1);
  }

  placeholderHull(hull) {
    hull = { width: 2, length: 6, ...hull };
    const g = new THREE.BoxGeometry(hull.width, hull.width * 0.45, hull.length);
    const m = new PropMaterial({ color: 0xff7a1a, roughness: 0.4 }, this.app.atmosphere);
    const mesh = new THREE.Mesh(g, m);
    mesh.position.y = hull.width * 0.1;
    trackMotion(mesh);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(hull.width * 0.5, hull.length * 0.35, 4), m);
    bow.rotation.x = Math.PI / 2; bow.rotation.y = Math.PI / 4;
    bow.position.set(0, hull.width * 0.1, hull.length * 0.5 + hull.length * 0.17);
    trackMotion(bow);
    const grp = new THREE.Group(); grp.add(mesh, bow);
    return grp;
  }

  // ------------------------------------------------------------------- loop
  get driving() { return this.state === 'hub' || this.state === 'race' || this.state === 'results'; }

  update(dt, rawDt) {
    this.time += dt;
    this.controls.update(rawDt);
    const ws = this.app.weather.state;
    this.wind.angle = ws.windAngle; this.wind.speed = ws.windSpeed;

    if (this.player) this.sea.setFocus(this.player.body.position.x, this.player.body.position.z);
    this.sea.update();
    if (this.app.surfaceOnly) {
      const sc = ws.waterScatter, len = Math.hypot(sc.x, sc.y, sc.z) || 1;
      this.app.sky.bgMaterial.uniforms.uSeaFillTint.value.set(sc.x / len, sc.y / len, sc.z / len).multiplyScalar(0.42);
    }

    const c = this.controls;
    if (c.has('pause')) { if (this.state === 'paused') this.resume(); else this.pause(); }
    if (this.state === 'paused') return;
    if (c.has('mute')) this.toggleMute();
    if (c.has('confirm') && (this.state === 'title' || this.state === 'garage')) this.hud ? null : this.enterHub();

    if (this.player) {
      const b = this.player.body;
      const canDrive = this.driving && (!this.race || this.race.acceptsInput !== false);
      if (canDrive) {
        b.throttle = c.throttle;
        b.steer = c.steer;
        b.boost = c.boost ? 1 : 0;
        if (b.isSub) b.dive = c.dive;
      } else { b.throttle = 0; b.steer = 0; b.boost = 0; if (b.isSub) b.dive = 0; }
      if (c.has('reset')) b.reset();
      if (c.has('camera')) this.camera.nextView();
      if (c.has('horn')) this.audio?.horn?.(this.player.name);
    }

    // Soft world bounds: nudge back toward the origin far out at sea.
    const bounds = this.world?.def?.bounds || 900;
    for (const boat of this.boats) {
      const b = boat.body;
      const before = b.slapImpulse;
      b.update(dt, this.wind);
      const r = Math.hypot(b.position.x, b.position.z);
      if (r > bounds) b.velocity.addScaledVector(new THREE.Vector3(-b.position.x / r, 0, -b.position.z / r), dt * 6 * Math.min(3, (r - bounds) / 40));
      if ((b.beachedTime || 0) > 1.5) { b.rescue(); if (boat === this.player) this.hud?.toast?.('Back to the water!'); }
      if (b.slapImpulse > before + 0.2) {
        if (boat === this.player) { this.camera.impulse(b.slapImpulse * 0.6); }
        this.audio?.splash?.(b.slapImpulse);
      }
      boat.group.position.copy(b.position);
      boat.group.quaternion.copy(b.quaternion);
      boat.visual?.update?.(dt, b, this.wind);
    }

    this._collideBoats(dt);
    this.race?.update?.(dt);
    this.mods.Worlds?.updateWorldEvents?.(this.app, this.world?.def, dt);
    this.world?.update?.(dt, this.app.camera);
    if (this.world?.def?.underwater) {
      const cam = this.app.camera.position;
      this._setSubmerged(this.sea.heightAt(cam.x, cam.z) - cam.y > 0.3);
    }
    this.portals?.update?.(dt);
    if (this.portals?.test && this.driving && this.player && !this._transitioning) {
      const dest = this.portals.test(this.player.body);
      if (dest) this.enterWorld(dest);
    }
    this.wake?.update?.(dt);
    this.shoreFoam?.update?.(dt);

    // Audio
    if (this.audio?.setEngine && this.player) {
      const b = this.player.body;
      this.audio.setEngine(this.player.name, {
        rpm: THREE.MathUtils.clamp(Math.abs(b.throttle) * 0.7 + b.speed / b.hull.maxSpeed * 0.5, 0, 1),
        load: Math.max(0, b.throttle), speed: b.speed / b.hull.maxSpeed, submersion: b.submersion, airborne: b.airborne,
      });
      this.audio.rain?.(ws.rain || 0);
      this.audio.wind?.(THREE.MathUtils.clamp((ws.windSpeed - 4) / 25, 0, 1));
    }

    // HUD
    if (this.hud?.update && this.player) {
      const f = this._frameData, b = this.player.body, r = this.race;
      f.speedKmh = b.speedKmh;
      f.state = this.state;
      f.world = this.world?.id;
      f.lap = r?.player?.lap ?? 0;
      f.laps = r?.laps ?? 0;
      f.position = r?.player?.position ?? 0;
      f.racers = r ? this.boats.length : 0;
      f.time = r?.time ?? 0;
      f.countdown = r?.countdown ?? 0;
      f.nextGateDir = r?.nextGateDir?.() ?? 0;
      f.progress = r?.player?.progress ?? 0;
      f.finished = !!r?.player?.finished;
      f.submerged = !!b.isSub;
      f.depth = b.isSub ? Math.max(0, b.depth || 0) : 0;
      f.nextGatePitch = r?.nextGatePitch?.() ?? 0;
      this.hud.update(f);
    }

    if (this.devEl && this.player) {
      const b = this.player.body;
      this.devEl.textContent =
        `${b.hull.label}  ${b.speedKmh.toFixed(0)} km/h  thr ${b.throttle.toFixed(2)} steer ${b.steer.toFixed(2)}  [${this.state}/${this.world?.id}]\n` +
        `pos ${b.position.x.toFixed(1)} ${b.position.y.toFixed(2)} ${b.position.z.toFixed(1)}  sub ${b.submersion.toFixed(2)}${b.airborne ? ' AIR' : ''}\n` +
        `sea ${this.sea.heightAt(b.position.x, b.position.z).toFixed(2)}  Hs ${(this.app.ocean.significantWaveHeight || 0).toFixed(2)}  readbacks ${this.sea.stats.readbacks} fb ${this.sea.stats.fallbacks}\n` +
        `${this.app.quality.presetName} ${(this.app.quality.averageMs || 0).toFixed(1)} ms  ${this.app.renderWidth}x${this.app.renderHeight}  ${c.lastDevice}`;
    }
  }

  /**
   * Boat-vs-boat contact: each hull is two spheres along its length (radius =
   * half the beam). Overlapping pairs are pushed apart mass-weighted, exchange
   * a little normal velocity and get a yaw kick, so boats bump and slide off
   * each other instead of passing through. O(n²) over ≤ 5 boats, no allocations.
   */
  _collideBoats(dt) {
    const boats = this.boats, n = boats.length;
    if (n < 2) return;
    for (let i = 0; i < n; i++) {
      const A = boats[i].body, ha = A.hull;
      const ra = Math.max(0.6, (ha.width || 2) * 0.5), la = (ha.length || 6) * 0.25;
      for (let j = i + 1; j < n; j++) {
        const B = boats[j].body, hb = B.hull;
        const rb = Math.max(0.6, (hb.width || 2) * 0.5), lb = (hb.length || 6) * 0.25;
        // Broad phase: centre distance vs summed half-lengths.
        if (A.position.distanceToSquared(B.position) > (la * 2 + lb * 2 + ra + rb) ** 2) continue;
        for (let sa = -1; sa <= 1; sa += 2) {
          _ca.copy(A.position).addScaledVector(A.forward, sa * la);
          for (let sb = -1; sb <= 1; sb += 2) {
            _cb.copy(B.position).addScaledVector(B.forward, sb * lb);
            _cn.subVectors(_cb, _ca);
            const d = _cn.length(), minD = ra + rb;
            if (d >= minD || d < 1e-4) continue;
            _cn.divideScalar(d);
            const pen = minD - d;
            const ma = ha.mass || 1000, mb = hb.mass || 1000, wa = mb / (ma + mb), wb = ma / (ma + mb);
            A.position.addScaledVector(_cn, -pen * wa * 0.5);
            B.position.addScaledVector(_cn, pen * wb * 0.5);
            _cv.subVectors(B.velocity, A.velocity);
            const vn = _cv.dot(_cn);
            if (vn < 0) {
              // Closing: exchange normal velocity with mild restitution.
              const jn = -(1 + 0.35) * vn / (1 / ma + 1 / mb);
              A.velocity.addScaledVector(_cn, -jn / ma);
              B.velocity.addScaledVector(_cn, jn / mb);
              const bump = Math.min(1, -vn / 6);
              A.angular.y += sa * bump * 0.35 * (_cn.dot(A.right) > 0 ? 1 : -1);
              B.angular.y += sb * bump * 0.35 * (_cn.dot(B.right) > 0 ? -1 : 1);
              if (bump > 0.15 && (boats[i] === this.player || boats[j] === this.player)) {
                this.camera.impulse(bump * 0.5);
                this.audio?.splash?.(bump);
              }
            }
          }
        }
      }
    }
  }

  /** Diagnostics for tools/game-smoke.mjs. */
  stats() {
    const b = this.player?.body;
    return {
      state: this.state,
      world: this.world?.id,
      boat: this.player?.name,
      boats: this.boats.length,
      speedKmh: b ? +b.speedKmh.toFixed(1) : 0,
      pos: b ? [b.position.x, b.position.y, b.position.z].map(v => +v.toFixed(2)) : null,
      heading: b ? +b.heading.toFixed(3) : 0,
      submersion: b ? +b.submersion.toFixed(2) : 0,
      seaHeight: b ? +this.sea.heightAt(b.position.x, b.position.z).toFixed(2) : 0,
      readbacks: this.sea.stats.readbacks,
      fallbacks: this.sea.stats.fallbacks,
      weather: this.weatherKey,
      race: this.race ? { state: this.race.state, lap: this.race.player?.lap, gate: this.race.player?.nextGate, position: this.race.player?.position, time: +(this.race.time || 0).toFixed(1) } : null,
      ms: +(this.app.quality.averageMs || 0).toFixed(2),
      preset: this.app.quality.presetName,
      res: `${this.app.renderWidth}x${this.app.renderHeight}`,
    };
  }
}
