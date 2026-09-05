# WAVE RIDERS — design brief and quality bar

Kids' boat-racing game (ages 5–8) built on the ABYSSAL ocean engine (Three.js, WebGL2, FFT waves,
volumetric sky). Touch-first: tablets and laptops. Runs from `index.html`; the original ocean
explorer is kept at `explore.html`.

## Non-negotiables

1. **60 fps on an Intel UHD iGPU at 1280×720 in the `game` quality profile.** Verified with
   `node tools/game-smoke.mjs`. Anything that costs more than ~1 ms/frame must justify itself.
2. **A 5-year-old can drive it in 10 seconds without reading.** Icons before words. Big targets
   (≥ 64 px). No menus deeper than two taps. Nothing punishes: you can't sink, capsize or lose
   permanently. Falling behind gets gentle rubber-banding, not a game-over.
3. **Controls feel like a real boat, simplified.** Throttle builds speed over ~2 s. Steering
   authority scales with speed. The hull leans into turns (bank), pitches up on throttle, planes at
   speed, slaps down on waves, and slides (yaw ≠ velocity heading) so you feel the water. Waves
   physically lift and drop the boat — buoyancy from the real FFT surface, not a fake bob.
4. **Every screen looks like the reference shots in `docs/reference/`:** saturated turquoise water,
   bright sun, big readable HUD (position, lap, timer, speed), checkpoint gates you can't miss,
   visible touch controls (steering wheel / arrows on the left, throttle + brake pedals on the right).
5. **No external art except the CC0 Kenney Watercraft Kit** in `public/models/kenney-watercraft/`
   (license file kept alongside). Everything else is generated in code. No downloaded audio;
   all sound is synthesized with WebAudio.

## The fantasy

You pick a boat at a sunny harbour hub. Glowing portal rings float in the water around you.
Drive through one and the ocean changes around you — calm lagoon, rolling swell, thunderstorm —
and a race course of gates appears around islands. Beat the other boats, collect stars,
drive back through the portal to the hub and try another.

## Boats (Kenney GLBs, ~1.8 m wide models scaled to real size)

| Boat | Source | Top speed | Handling | Personality |
| --- | --- | --- | --- | --- |
| Jet ski | Procedural (no CC0 model exists) styled to match Kenney palette | fast | very nimble, bouncy | leans hard, throws spray, jumps waves |
| Speedboat | `boat-speed-*` (several colour variants) | fastest | medium | planes, long wake |
| Sailboat | `boat-sail-a/b` | medium | heels in wind, slower turns | speed depends on wind angle (simplified: fastest across the wind) |
| Pontoon | Procedural, Kenney palette | slow | very stable | barely rocks, party boat, fun horn |

Scale: Kenney models are ~1.8 units wide. Real boats: jet ski 3.3 m long, speedboat 6–7 m,
sailboat 8 m, pontoon 7 m. Scale each model so the hull length matches real size.

## Worlds (each is a weather preset + island layout + course)

| World | Weather | Sea | Course |
| --- | --- | --- | --- |
| Harbour hub | golden-hour, calm | Hs 0.4 m | portals in a ring, free play, no timer |
| Sunny Lagoon | clear day | Hs 0.6 m | wide gates, gentle 3-lap loop around 3 islands |
| Rolling Swell | trade wind | Hs 2 m, long period | gates on big swell, figure-8 around 2 islands |
| Storm Run | squall, lightning, rain | Hs 4 m | tighter course in a bay sheltered by a big island |

Portals: 12 m glowing rings standing in the water (torus + animated shader + particles), with a
coloured light column and a floating icon (sun / wave / lightning). Driving through one triggers
a 1.5 s white-out transition, teleports the boat to the destination world's start line and
crossfades weather.

## Racing rules (kept simple)

- Gates in order; next gate is highlighted green, the one after is grey, a big 3D arrow
  points at the next one; missing a gate just re-targets it, no penalty.
- 3 laps by default. Countdown 3-2-1-GO with sounds.
- 3 AI boats with rubber-banding (never more than ~80 m ahead of the player).
- Finishing awards 1–3 stars (by position). Stars are stored in localStorage.
- Timer, lap, position always on screen (see reference HUD).

## HUD and input (see reference images)

- Top-left: position "2/4" with a flag icon; top-right: timer and lap "Lap 1/3".
- Bottom-centre: round speedometer (km/h) in the reference style.
- Bottom-left: steering (a wheel you drag, plus ◀ ▶ buttons); bottom-right: throttle and brake
  pedals. Device tilt as optional steering.
- Keyboard: WASD / arrows, Space = boost/horn, R = reset upright, C = camera, Esc = pause.
- Gamepad supported (left stick steer, right trigger throttle).
- All text ≥ 18 px, rounded bold sans-serif, high contrast outlines.

## Performance profile (`game` quality)

- Render scale ≤ 1.0 at DPR 1; adaptive down to 0.6.
- Clouds: enabled but low steps (≤ 24 march, 3 light), quarter-res; falls back to cheaper 2D
  cloud layer if still over budget.
- No depth of field, no motion blur; TAA on (kills shimmer on the water).
- FFT 128, ocean grid 160×100.
- Underwater world: not built in game mode (surface only). If the camera dips under a wave the
  water interface pass still handles it using a flat colour fallback.
- Spray/rain counts cut to 1/4.

## Code layout

```
src/game/
  main.js          game entry (boots App in game mode, installs Game)
  Game.js          state machine: title → garage → hub → race → results
  WaveField.js     GPU height-field probe → CPU sampling (height + normal at any xz)
  BoatPhysics.js   hull with N buoyancy points, thrust, drag, steering, planing, collisions
  Boats.js         boat catalog, GLB loading, procedural jetski + pontoon, materials
  FollowCamera.js  chase camera with speed-based distance, look-ahead, wave-safe height
  Controls.js      keyboard + touch + gamepad + tilt → {throttle, steer, brake, boost}
  Islands.js       procedural islands (heightfield + palms + beach ring) and collision
  Portals.js       portal rings, hit test, transition
  Race.js          gates, laps, positions, AI drivers, countdown, results
  Worlds.js        world definitions (weather, islands, course, portals)
  Hud.js           DOM HUD + touch controls
  Audio.js         WebAudio synth: engine, spray, gate chime, portal whoosh, horn
  Wake.js          boat wake ribbon + spray particles
  game.css
tools/game-smoke.mjs   boots the game headlessly, drives the boat, measures fps, screenshots
```

## Definition of done for every module

- No console errors or warnings in `game-smoke`.
- Screenshot reviewed side-by-side with `docs/reference/`; if it looks worse, it's not done.
- Frame cost measured; documented in the PR message.
- Works with mouse, keyboard and simulated touch (puppeteer `page.touchscreen`).

## Module interfaces (contract between modules)

All modules live in `src/game/`. `Game.js` is the integration point and is owned by the lead;
other modules export a clean API plus an optional `devInstall(game)` for standalone testing via
`http://localhost:5173/?mods=Islands,Portals` (comma-separated module file names).

```js
// Worlds.js
export const WORLDS = { hub, lagoon, swell, storm };   // see world schema below
export function buildWorld(id, ctx)  // ctx = { app, atmosphere, scene } → { id, def, group, heightAt(x,z), dispose() }
// world def: { id, name, icon, weather: { key: 'clear'|..., patch: {...weather fields} },
//   water: { scatter: [r,g,b], absorb: [r,g,b] },   // kid-friendly turquoise tuning
//   islands: [{ x, z, radius, height, seed, palms }],
//   start: { x, z, heading },                      // player start (AI fan out behind)
//   gates: [{ x, z, heading, width }],             // in order; heading = direction of travel through the gate
//   laps: 3, portals: [{ x, z, heading, dest }],   // dest = world id
//   bounds: 900 }                                  // soft radius; beyond it the boat is nudged back
// Every world is built around the origin; entering a world disposes the previous one.

// Boats.js
export const BOAT_CATALOG;  // { jetski, speedboat, sailboat, pontoon } → { label, hull: HULLS key, colors: [...], ... }
export async function buildBoatVisual(id, { atmosphere, loader, colorIndex })  // → THREE.Group with .update(dt, body)

// Race.js
new Race(game, world, { laps, aiCount }) ; race.start() ; race.update(dt) ; race.dispose()
race.state ('countdown'|'racing'|'finished'), race.countdown (s), race.time (s)
race.player → { lap, nextGate, position, finished, finishTime }, race.standings → [{ boat, lap, gate, position }]
race.gates → gate meshes + .test(body) ; race.nextGatePos(out) for HUD arrow

// Portals.js
new Portals(game) ; portals.build(defs) ; portals.update(dt) ; portals.test(body) → dest|null ; portals.transition(async cb) ; portals.dispose()

// Wake.js
new Wake(game) ; wake.attach(boat) ; wake.update(dt) ; wake.dispose()

// Hud.js
new Hud(game) ; hud.show('title'|'garage'|'hub'|'race'|'results'|'paused') ; hud.update(frameData) ; hud.on(event, cb)
// frameData = { speedKmh, lap, laps, position, racers, time, countdown, nextGateDir (rad, relative), state, stars }
// events: 'selectBoat'(id), 'start', 'pause', 'resume', 'camera', 'reset', 'mute', 'exit', 'horn'
// Touch controls call game.controls.setVirtual({ steer, throttle, brake, boost, active })

// Audio.js
new GameAudio() ; unlock() ; setEngine(type, { rpm, load, speed }) ; splash(i) ; gate() ; portal() ; countdown(n) ; horn(type) ; music(on) ; mute(bool)
```

## Expansion 2: giant swell, perfect storm, submarine

New surface worlds (Worlds.js): `giant` ("Titan Swell": 15 m / 50 ft swell, period ~17 s, broadly
spaced, sunny) and `tempest` ("The Perfect Storm": Beaufort 11, night-dark, rain 1.0, lightning
rate high, Hs ~8 m, periodic rogue waves via `app.director`). Hub gets six portals: lagoon, swell,
storm, giant, tempest, deep. World defs may set `probeSpan` (coarse wave grid width in metres; giant
uses 400) so gates and AI ride the real waves.

Underwater world (`deep`, "The Deep Run") — a submarine mode:

```js
// SubmarineWorld.js
export const SUB_WORLDS = { deep };
// def: { id, name, icon: 'submarine', underwater: true, weather: { key, patch },
//   fog: { color: [r,g,b], density },                 // underwater look
//   start: { x, y, z, heading },                       // y negative = depth
//   gates: [{ x, y, z, heading, width }], laps,        // hoops at depth, in order
//   portals: [{ x, z, heading, dest: 'hub' }],         // at the surface, near start
//   bounds }
export function buildSubWorld(id, ctx)  // ctx = { app, atmosphere, scene, game } → { id, def, group, heightAt(x,z) /* seabed y */, dispose(), update(dt, camera) }
export function setSubmerged(app, on, fog)  // toggles the sky/ocean/post underwater look; cheap

// Submarine.js
export class SubPhysics { position, quaternion, velocity, forward, right, up, heading, pitch, depth, speed, speedKmh,
  throttle (-0.5..1), steer (-1..1, +right), dive (-1..1, +up), boost, submersion (1 when under), isSub = true,
  groundFn (seabed), ceilingFn (sea surface height), hull: { length, width, maxSpeed, ... }
  update(dt); setPose(x, y, z, heading); reset(); rescue() }
export async function buildSubVisual({ atmosphere, colorIndex }) → THREE.Group with update(dt, body)

// SubRace.js — same surface as Race.js (setup/start/update/dispose, state, countdown, time, laps,
// player {lap,nextGate,position,finished,finishTime,progress}, standings, acceptsInput, nextGatePos,
// nextGateDir() (yaw, +right) plus nextGatePitch() (rad, +up), onGate/onLap/onFinish/onCountdown)
// but gates are 3D hoops and AI drivers are submarines spawned with game.spawnSub(x, y, z, heading).

// Controls.js: controls.dive (-1..1, +up) from Q/E keys, gamepad LB/RB, touch ▲▼ via setVirtual({ dive }).
// Hud.js: when frameData.submerged is true show a depth gauge and touch dive buttons; frameData.nextGatePitch.
// FollowCamera: camera.mode = 'sub' follows in 3D and stays below the surface while submerged.
```
