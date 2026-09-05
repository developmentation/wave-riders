/**
 * Unified input: keyboard, gamepad, and whatever the touch HUD feeds in via
 * setVirtual(). Output is a normalised intent — throttle, steer, brake, boost,
 * plus edge-triggered actions — so the boat physics never knows about devices.
 */
export class Controls {
  constructor() {
    this.throttle = 0;   // -0.5 .. 1 (negative = reverse)
    this.steer = 0;      // -1 .. 1 (positive = right)
    this.boost = false;
    this.dive = 0;       // -1..1, +up (submarine mode)
    this.horn = false;
    this.actions = new Set();       // one-frame events: 'reset', 'camera', 'pause', 'horn'
    this._keys = new Set();
    this._virtual = { throttle: 0, steer: 0, brake: 0, boost: false, dive: 0, active: false };
    this._tilt = { enabled: false, value: 0 };
    this._steerSmooth = 0;
    this._throttleSmooth = 0;
    this.gamepadIndex = -1;
    this.lastDevice = 'keyboard';
    this._pending = new Set();
    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (e.target?.matches?.('input,select,textarea')) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this._keys.add(e.code);
      this.lastDevice = 'keyboard';
      const map = { KeyR: 'reset', KeyC: 'camera', Escape: 'pause', KeyP: 'pause', KeyH: 'horn', Enter: 'confirm', KeyM: 'mute' };
      if (map[e.code]) this._pending.add(map[e.code]);
    });
    window.addEventListener('keyup', (e) => this._keys.delete(e.code));
    window.addEventListener('blur', () => this._keys.clear());
    window.addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    window.addEventListener('gamepaddisconnected', () => { this.gamepadIndex = -1; });
  }

  /** Touch HUD writes here every frame it is active. */
  setVirtual(v) { Object.assign(this._virtual, v); }

  /** Device orientation steering, -1..1. */
  setTilt(value) { this._tilt.value = value; this._tilt.enabled = true; }
  clearTilt() { this._tilt.enabled = false; }

  trigger(action) { this._pending.add(action); }

  update(dt) {
    const k = this._keys;
    let throttle = 0, steer = 0, brake = 0, boost = false, dive = 0;
    let any = false;

    if (k.has('KeyW') || k.has('ArrowUp')) { throttle += 1; any = true; }
    if (k.has('KeyS') || k.has('ArrowDown')) { brake = 1; any = true; }
    if (k.has('KeyA') || k.has('ArrowLeft')) { steer -= 1; any = true; }
    if (k.has('KeyD') || k.has('ArrowRight')) { steer += 1; any = true; }
    if (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('Space')) boost = true;
    if (k.has('KeyQ')) { dive -= 1; any = true; }
    if (k.has('KeyE')) { dive += 1; any = true; }

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && (pads[this.gamepadIndex] || Array.from(pads).find(Boolean));
    if (gp) {
      const dz = (v) => Math.abs(v) < 0.12 ? 0 : v;
      const gs = dz(gp.axes[0] || 0);
      const rt = gp.buttons[7]?.value || 0, lt = gp.buttons[6]?.value || 0;
      const a = gp.buttons[0]?.pressed;
      if (gs || rt || lt || a) { any = true; this.lastDevice = 'gamepad'; }
      steer += gs;
      throttle += rt + (a ? 1 : 0);
      brake = Math.max(brake, lt);
      if (gp.buttons[1]?.pressed) boost = true;
      if (gp.buttons[4]?.pressed) dive -= 1;   // LB down
      if (gp.buttons[5]?.pressed) dive += 1;   // RB up
      if (gp.buttons[3]?.pressed && !this._gpY) this._pending.add('reset');
      this._gpY = gp.buttons[3]?.pressed;
      if (gp.buttons[2]?.pressed && !this._gpX) this._pending.add('camera');
      this._gpX = gp.buttons[2]?.pressed;
      if (gp.buttons[9]?.pressed && !this._gpStart) this._pending.add('pause');
      this._gpStart = gp.buttons[9]?.pressed;
    }

    // touch HUD
    const v = this._virtual;
    if (v.active) {
      this.lastDevice = 'touch';
      throttle += v.throttle;
      brake = Math.max(brake, v.brake);
      steer += v.steer;
      boost = boost || v.boost;
      dive += v.dive || 0;
      any = true;
    }
    if (this._tilt.enabled) steer += this._tilt.value;

    steer = Math.max(-1, Math.min(1, steer));
    throttle = Math.max(0, Math.min(1, throttle));
    // Brake: slows, and once nearly stopped becomes reverse.
    let out = throttle - brake * (throttle > 0 ? 1 : 0.5);
    out = Math.max(-0.5, Math.min(1, out));

    // Smooth like a real helm and throttle lever: quick to respond, not instant.
    const sk = 1 - Math.exp(-dt * (any ? 10 : 6));
    this._steerSmooth += (steer - this._steerSmooth) * sk;
    const tk = 1 - Math.exp(-dt * 4);
    this._throttleSmooth += (out - this._throttleSmooth) * tk;
    this.steer = Math.abs(this._steerSmooth) < 0.005 ? 0 : this._steerSmooth;
    this.throttle = Math.abs(this._throttleSmooth) < 0.005 ? 0 : this._throttleSmooth;
    this.brake = brake;
    this.boost = boost;
    const dk = 1 - Math.exp(-dt * 6);
    this._diveSmooth = (this._diveSmooth || 0) + (Math.max(-1, Math.min(1, dive)) - (this._diveSmooth || 0)) * dk;
    this.dive = Math.abs(this._diveSmooth) < 0.005 ? 0 : this._diveSmooth;
    this.active = any;

    this.actions = this._pending;
    this._pending = new Set();
  }

  has(action) { return this.actions.has(action); }
}
