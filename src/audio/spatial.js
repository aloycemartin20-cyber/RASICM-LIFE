/**
 * AUDIO / SPATIALISATION
 *
 * A pool of reusable 3D emitter chains. Each chain is:
 *
 *   input ─► occlusionLP ─► airLP ─► distanceGain ─┬─► panner (HRTF) ─► bus
 *                                                  └─► sendGain ─► reverb send
 *
 * Notes on the design decisions, because they are not the obvious ones:
 *
 *  - The PannerNode's own distance model is switched OFF (rolloffFactor 0) and
 *    attenuation is applied by `distanceGain` instead. That is what lets the
 *    reverb send be *post* distance attenuation but *pre* panning, which is how
 *    a far source correctly ends up wetter than a near one.
 *  - `airLP` is air absorption, `occlusionLP` is geometry. They are separate so
 *    a distant *and* occluded source stacks both losses, as it should.
 *  - The whole chain is built once and only the panner→bus edge is connected
 *    while the emitter is in use; a free emitter is detached from the graph so
 *    the (expensive) HRTF convolution is not evaluated for silence.
 *  - Propagation delay is not a DelayNode: every voice is *scheduled* at
 *    `now + dist/343`, which is sample-accurate and free.
 */

import { airCutoff, clamp, doppler, gain, biquad } from './dsp.js';

const MAX_EMITTERS = 52;

/** Reference distance for the attenuation curve, in metres. */
const REF = 2.0;

/*
 * SMOOTHING FOR CONTINUOUS SOURCES — opt-in, and off for everything else.
 *
 * A one-shot wants its attenuation applied instantly: a gunshot 80 m away is
 * 80 m away at the sample it starts. A source that SUSTAINS for a minute while
 * the geometry between it and the player changes is a different problem, and
 * the shipped chain treated them the same way. The owner's report was "police
 * sirens are annoying ... when they fade in and out", and there are three
 * separate mechanisms behind it, all of them here:
 *
 *   1. OCCLUSION IS A STEP. `refresh` round-robins two emitters a frame and
 *      writes whatever the two rays came back with. Behind a bus: -8.4 dB of
 *      gain, the lowpass down to 420 Hz and a -26 dB shelf, in ~0.12 s. Out
 *      from behind it: all of that back. A cruiser weaving through traffic
 *      does that twice a second.
 *   2. A RE-ACQUIRED EMITTER SNAPS. `acquire` writes the gain with
 *      `setValueAtTime`, so a source that lost its slot for one frame comes
 *      back at full level in one sample.
 *   3. NOTHING BOUNDS THE RATE. Distance alone is well behaved, but distance
 *      plus occlusion plus a re-acquire is not, and the sum is what a listener
 *      hears as pumping.
 *
 * So a `smooth` emitter glides its occlusion instead of stepping it, and
 * rate-limits its gain in dB/s — asymmetric, because arriving late is worse
 * than leaving late. The numbers are set so a genuine pass-by is untouched: a
 * cruiser crossing at 25 m/s with a 12 m closest approach moves the level about
 * 8 dB/s at its fastest, well inside both limits, while an occlusion step or a
 * re-acquire is the thing that gets held back.
 */
/** dB per second a `smooth` emitter's distance gain may move. */
const SLEW_UP_DB = 22;
const SLEW_DOWN_DB = 11;
/** How far below the target a `smooth` emitter may start: caps the fade-in. */
const SLEW_FLOOR = 0.06;              // -24 dB, so at most ~1.1 s to arrive
/**
 * Seconds for a `smooth` emitter's occlusion to travel the whole 0..1 range.
 *
 * MEASURED rather than chosen: full occlusion is about 28 dB of level once the
 * -8.4 dB of gain, the lowpass down to 420 Hz and the -26 dB shelf are all in,
 * so anything under about 1.4 s here still reads as a gate rather than a duck.
 * At 0.9 s the emitted flyby recovered at 51 dB/s and sounded switched on.
 */
const OCC_GLIDE = 1.5;

class Emitter {
  constructor(actx, mixer) {
    this.actx = actx;
    this.mixer = mixer;
    this.input = gain(actx, 1);
    this.occLP = biquad(actx, 'lowpass', 20000, 0.4);
    this.occHS = biquad(actx, 'highshelf', 2200, 0.7, 0);
    this.airLP = biquad(actx, 'lowpass', 20000, 0.5);
    this.distGain = gain(actx, 1);
    this.sendGain = gain(actx, 0);

    const p = actx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 1;
    p.rolloffFactor = 0; // attenuation handled by distGain
    p.maxDistance = 10000;
    p.coneInnerAngle = 360;
    this.panner = p;

    this.input.connect(this.occLP);
    this.occLP.connect(this.occHS);
    this.occHS.connect(this.airLP);
    this.airLP.connect(this.distGain);
    this.distGain.connect(this.panner);
    this.distGain.connect(this.sendGain);

    this.free = true;
    this.endTime = 0;
    this.priority = 0;
    this.busName = 'foley';
    this.attached = null;
    this.tracked = false;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.occ = 0;
    /** Where `occ` is heading. Only a `smooth` emitter is ever behind it. */
    this.occTarget = 0;
    /** 0 = step (one-shots), 1 = glide + slew (continuous sources). */
    this.smooth = 0;
    /** The distance gain last APPLIED, which is what the slew works from. */
    this._g = 0;
    this.hrtf = true;
    this._hasPrev = false;
    this._connected = false;
    this._sendConnected = false;
  }

  /**
   * HRTF is a per-source convolution. It is worth it for anything you are
   * meant to localise; a lorry two streets away only needs to be on the right
   * side of the field, so distant/LOD sources drop to equal-power panning.
   */
  setHrtf(on) {
    if (this.hrtf === !!on) return;
    this.hrtf = !!on;
    this.panner.panningModel = on ? 'HRTF' : 'equalpower';
  }

  _setPos(x, y, z, when) {
    const p = this.panner;
    if (p.positionX) {
      p.positionX.setValueAtTime(x, when);
      p.positionY.setValueAtTime(y, when);
      p.positionZ.setValueAtTime(z, when);
    } else {
      p.setPosition(x, y, z);
    }
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
  }

  /** Smoothly move a long-lived emitter (ambience beds, voices, loops). */
  moveTo(x, y, z, smooth = 0.06) {
    const p = this.panner;
    const t = this.actx.currentTime;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, t, smooth);
      p.positionY.setTargetAtTime(y, t, smooth);
      p.positionZ.setTargetAtTime(z, t, smooth);
    } else {
      p.setPosition(x, y, z);
    }
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
  }

  connectOut(busNode, sendNode) {
    if (!this._connected) {
      this.panner.connect(busNode);
      this._connected = busNode;
    }
    if (!this._sendConnected && sendNode) {
      this.sendGain.connect(sendNode);
      this._sendConnected = sendNode;
    }
  }

  detach() {
    if (this._connected) {
      try { this.panner.disconnect(this._connected); } catch { /* noop */ }
      this._connected = false;
    }
    if (this._sendConnected) {
      try { this.sendGain.disconnect(this._sendConnected); } catch { /* noop */ }
      this._sendConnected = false;
    }
    if (this.attached) {
      try { this.attached.disconnect(); } catch { /* noop */ }
      this.attached = null;
    }
    this.tracked = false;
    this.free = true;
  }

  dispose() {
    this.detach();
    this.input.disconnect();
    this.occLP.disconnect();
    this.occHS.disconnect();
    this.airLP.disconnect();
    this.distGain.disconnect();
    this.sendGain.disconnect();
    this.panner.disconnect();
  }
}

export class SpatialField {
  /**
   * @param {BaseAudioContext} actx
   * @param {import('./mixer.js').Mixer} mixer
   * @param {object} ctx engine context (for physics raycasts); may be null
   */
  constructor(actx, mixer, ctx) {
    this.actx = actx;
    this.mixer = mixer;
    this.ctx = ctx;
    this.emitters = [];
    for (let i = 0; i < MAX_EMITTERS; i++) this.emitters.push(new Emitter(actx, mixer));

    // Preallocated scratch — update() must never allocate.
    this._lp = { x: 0, y: 1.6, z: 0 };
    this._lv = { x: 0, y: 0, z: 0 };
    this._lprev = { x: 0, y: 1.6, z: 0 };
    this._hasListenerPrev = false;
    this._occOrigin = { x: 0, y: 0, z: 0 };
    this._occDir = { x: 0, y: 0, z: 0 };
    this._trackCursor = 0;
    this.stats = { active: 0, tracked: 0, stolen: 0, dropped: 0, occlusionRays: 0 };
    this.occlusionEnabled = true;
  }

  /** Listener velocity, m/s. Fed from setListener via finite difference. */
  get listenerVel() {
    return this._lv;
  }

  /** Feed the AudioListener from the render camera. Called once per frame. */
  setListener(px, py, pz, fx, fy, fz, ux, uy, uz, dt = 0) {
    const l = this.actx.listener;
    const t = this.actx.currentTime;

    // Listener velocity for doppler. Heavily smoothed and clamped: a camera cut
    // teleports kilometres and must not chirp the whole city.
    if (dt > 1e-4) {
      if (this._hasListenerPrev) {
        const k = clamp(dt * 9, 0, 1);
        const vx = clamp((px - this._lprev.x) / dt, -140, 140);
        const vy = clamp((py - this._lprev.y) / dt, -140, 140);
        const vz = clamp((pz - this._lprev.z) / dt, -140, 140);
        const jump = Math.abs(px - this._lprev.x) + Math.abs(pz - this._lprev.z) > 12;
        if (jump) {
          this._lv.x = 0; this._lv.y = 0; this._lv.z = 0;
        } else {
          this._lv.x += (vx - this._lv.x) * k;
          this._lv.y += (vy - this._lv.y) * k;
          this._lv.z += (vz - this._lv.z) * k;
        }
      }
      this._lprev.x = px; this._lprev.y = py; this._lprev.z = pz;
      this._hasListenerPrev = true;
    }

    this._lp.x = px; this._lp.y = py; this._lp.z = pz;
    if (l.positionX) {
      // setTargetAtTime rather than a hard set: the doppler-free smoothing kills
      // the zipper noise you otherwise get from a 60 Hz position update.
      l.positionX.setTargetAtTime(px, t, 0.02);
      l.positionY.setTargetAtTime(py, t, 0.02);
      l.positionZ.setTargetAtTime(pz, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setTargetAtTime(fy, t, 0.02);
      l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.setTargetAtTime(ux, t, 0.05);
      l.upY.setTargetAtTime(uy, t, 0.05);
      l.upZ.setTargetAtTime(uz, t, 0.05);
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  get listenerPos() {
    return this._lp;
  }

  distanceTo(x, y, z) {
    const l = this._lp;
    return Math.hypot(x - l.x, y - l.y, z - l.z);
  }

  /**
   * Attenuation curve. Deliberately gentler than 1/r beyond ~40 m: real
   * gunfire at 150 m is still clearly audible, and pure inverse-distance makes
   * a level feel dead. Below 40 m it is very close to physical.
   */
  attenuation(dist) {
    const near = REF / (REF + 0.85 * Math.max(0, dist - REF));
    const far = 0.055 * Math.pow(60 / Math.max(dist, 60), 0.55);
    return clamp(Math.max(near, dist > 45 ? far : 0), 0.0, 1);
  }

  /**
   * Occlusion test: how much geometry is between the listener and a point.
   * Returns 0 (clear) .. 1 (thick wall). Two rays — ear height and a raised
   * one — so a low crate does not fully mute a source behind it.
   */
  occlusionAt(x, y, z) {
    if (!this.occlusionEnabled) return 0;
    const phys = this.ctx?.peek?.('physics');
    if (!phys?.raycast) return 0;
    const l = this._lp;
    const dx = x - l.x, dy = y - l.y, dz = z - l.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.8) return 0;
    const mask = phys.MASK?.SIGHT ?? undefined;
    let blocked = 0;
    const o = this._occOrigin, dir = this._occDir;
    for (let i = 0; i < 2; i++) {
      const lift = i === 0 ? 0 : 0.55;
      o.x = l.x; o.y = l.y + lift; o.z = l.z;
      dir.x = x - o.x; dir.y = y + lift * 0.5 - o.y; dir.z = z - o.z;
      const len = Math.hypot(dir.x, dir.y, dir.z);
      if (len < 1e-4) continue;
      this.stats.occlusionRays++;
      const hit = phys.raycast(o, dir, len - 0.25, mask);
      if (hit?.hit) {
        // A thin partition muffles less than a bunker wall: use how far past the
        // first hit the ray continued as a crude thickness proxy.
        blocked += hit.distance < len * 0.9 ? 1 : 0.5;
      }
    }
    return clamp(blocked / 2, 0, 1);
  }

  /**
   * Grab an emitter. Returns null when the budget is full and the new sound is
   * less important than everything already playing.
   *
   * opts: { x,y,z, bus, send, priority, endTime, occlusion, dist, atten, smooth }
   */
  acquire(opts) {
    const now = this.actx.currentTime;
    let em = null;
    for (let i = 0; i < this.emitters.length; i++) {
      const e = this.emitters[i];
      if (e.free) { em = e; break; }
    }
    if (!em) {
      // Steal the least important voice that is closest to finishing.
      let worst = null, worstScore = Infinity;
      const pri = opts.priority ?? 0.5;
      for (let i = 0; i < this.emitters.length; i++) {
        const e = this.emitters[i];
        if (e.tracked) continue; // never steal a bed/loop
        const score = e.priority * 4 + Math.max(0, e.endTime - now);
        if (score < worstScore) { worstScore = score; worst = e; }
      }
      if (!worst || worst.priority > pri + 0.25) {
        this.stats.dropped++;
        return null;
      }
      worst.detach();
      this.stats.stolen++;
      em = worst;
    }

    const t = opts.when ?? now;
    const dist = opts.dist ?? this.distanceTo(opts.x, opts.y, opts.z);
    const occ = opts.occlusion !== undefined ? opts.occlusion : this.occlusionAt(opts.x, opts.y, opts.z);
    const atten = (opts.atten ?? this.attenuation(dist)) * (1 - 0.62 * occ);

    em.free = false;
    em.priority = opts.priority ?? 0.5;
    em.endTime = opts.endTime ?? now + 1;
    em.busName = opts.bus ?? 'foley';
    em.tracked = !!opts.tracked;
    em.userGain = opts.gain ?? 1;
    em.userSend = opts.send ?? 0.25;
    em.wantHrtf = opts.hrtf !== false;
    em.occ = occ;
    em.occTarget = occ;
    em.smooth = opts.smooth ? 1 : 0;
    em._setPos(opts.x, opts.y, opts.z, t);

    // Air absorption + occlusion filtering.
    em.airLP.frequency.setValueAtTime(airCutoff(dist), t);
    const occCut = 20000 * Math.pow(0.021, occ); // 1.0 -> ~420 Hz
    em.occLP.frequency.setValueAtTime(clamp(occCut, 300, 20000), t);
    em.occHS.gain.setValueAtTime(-26 * occ, t);
    // A `smooth` source ARRIVES rather than switching on: seeded 24 dB under
    // its target, `motion` slews it up over about a second. That is the fix for
    // mechanism 2 above — a siren that lost its slot for one frame used to come
    // back at full level in one sample.
    const g0 = clamp(atten * (opts.gain ?? 1), 0, 4);
    em._g = em.smooth ? g0 * SLEW_FLOOR : g0;
    em.distGain.gain.setValueAtTime(em._g, t);

    // Farther and more occluded => proportionally wetter.
    const send = (opts.send ?? 0.25) * (0.5 + Math.min(dist, 90) * 0.022) * (1 + occ * 0.7);
    em.sendGain.gain.setValueAtTime(clamp(send, 0, 3), t);

    em.connectOut(this.mixer.bus(em.busName), this.mixer.busSend(em.busName));
    return em;
  }

  /**
   * Claim a long-lived emitter for a continuous source (an engine, a siren, a
   * bed). Tracked emitters are never stolen by one-shots and are moved with
   * `motion()` every frame. Returns null only when everything is busy.
   *
   * `smooth: true` additionally glides the occlusion and rate-limits the gain
   * (see the block above `SLEW_UP_DB`). It is only correct for a source whose
   * owner calls `motion()` EVERY FRAME — that is where the glide is stepped —
   * so a bed that relies on the `refresh` round-robin alone must not ask for
   * it. Sirens use it; nothing else does yet.
   */
  acquireTracked(opts) {
    const em = this.acquire({ ...opts, tracked: true, endTime: Infinity, occlusion: 0 });
    if (em) {
      em._hasPrev = false;
      em.occ = 0;
      em.setHrtf(opts.hrtf !== false);
    }
    return em;
  }

  /** Hand a continuous voice's output to a tracked emitter. */
  attach(em, node) {
    node.connect(em.input);
    em.attached = node;
  }

  /** Release a tracked emitter without disconnecting the voice that owns it. */
  releaseTracked(em) {
    if (!em || em.free) return;
    em.attached = null;   // the voice owns its own nodes and outlives the emitter
    em.detach();
  }

  /**
   * Move a tracked emitter and return the doppler ratio its voice should apply
   * to every partial it generates.
   *
   * Doppler is NOT done with a delay line: everything continuous in this
   * subsystem synthesizes its own pitch, so shifting it is one multiply and it
   * is exact, glitch-free and free of the artefacts a varispeed delay produces
   * when a car passes within a metre of the camera.
   */
  motion(em, x, y, z, dt) {
    if (!em || em.free) return 1;
    const t = this.actx.currentTime;
    const p = em.pos;

    /* ---- velocity ------------------------------------------------- */
    if (dt > 1e-4 && em._hasPrev) {
      const k = clamp(dt * 12, 0, 1);
      const jump = Math.abs(x - p.x) + Math.abs(y - p.y) + Math.abs(z - p.z) > 20;
      if (jump) {
        em.vel.x = 0; em.vel.y = 0; em.vel.z = 0;
      } else {
        em.vel.x += (clamp((x - p.x) / dt, -160, 160) - em.vel.x) * k;
        em.vel.y += (clamp((y - p.y) / dt, -160, 160) - em.vel.y) * k;
        em.vel.z += (clamp((z - p.z) / dt, -160, 160) - em.vel.z) * k;
      }
    }
    em._hasPrev = true;

    /* ---- geometry -------------------------------------------------- */
    const l = this._lp;
    let dx = x - l.x, dy = y - l.y, dz = z - l.z;
    const dist = Math.hypot(dx, dy, dz);
    // Radial components: positive = the gap is opening.
    let ratio = 1;
    if (dist > 0.25) {
      const inv = 1 / dist;
      dx *= inv; dy *= inv; dz *= inv;
      const srcRadial = em.vel.x * dx + em.vel.y * dy + em.vel.z * dz;
      const lisRadial = this._lv.x * dx + this._lv.y * dy + this._lv.z * dz;
      ratio = doppler(srcRadial, lisRadial);
      // Fade the shift out at very close range: crossing the listener flips the
      // sign in one frame and a hard flip reads as a click, not a pass-by.
      if (dist < 4) ratio = 1 + (ratio - 1) * (dist / 4);
    }

    /* ---- position, attenuation, air -------------------------------- */
    em.moveTo(x, y, z, 0.035);
    if (em.smooth) this._glideOcc(em, dt, t);
    const atten = this.attenuation(dist) * (1 - 0.62 * em.occ);
    em.airLP.frequency.setTargetAtTime(airCutoff(dist), t, 0.09);
    const want = clamp(atten * (em.userGain ?? 1), 0, 4);
    if (em.smooth) em.distGain.gain.setTargetAtTime(this._slew(em, want, dt), t, 0.08);
    else em.distGain.gain.setTargetAtTime(want, t, 0.05);
    // Far sources are wetter, and HRTF is wasted on them.
    em.sendGain.gain.setTargetAtTime(
      clamp((em.userSend ?? 0.25) * (0.5 + Math.min(dist, 90) * 0.02) * (1 + em.occ * 0.7), 0, 3), t, 0.15);
    if (dist > 42 && em.hrtf) em.setHrtf(false);
    else if (dist < 34 && !em.hrtf && em.wantHrtf !== false) em.setHrtf(true);
    return ratio;
  }

  /**
   * Rate-limit a `smooth` emitter's distance gain, in dB per second. Returns
   * the value to write. Works in dB rather than in linear gain because the same
   * emitter has to behave the same way at -6 dBFS and at -40: a linear rate
   * limit is a different musical speed at every distance.
   */
  _slew(em, want, dt) {
    const tgt = Math.max(want, 1e-6);
    const cur = Math.max(em._g, tgt * SLEW_FLOOR, 1e-6);
    const step = 20 * Math.log10(tgt / cur);
    const lim = clamp(step, -SLEW_DOWN_DB * dt, SLEW_UP_DB * dt);
    em._g = cur * Math.pow(10, lim / 20);
    return em._g;
  }

  /**
   * Walk a `smooth` emitter's occlusion toward what the rays last saw, and move
   * the filters with it. Everything derived from `occ` therefore travels
   * together — gain, lowpass and shelf — which matters: gliding the gain while
   * the lowpass still snapped would leave the step perfectly audible.
   */
  _glideOcc(em, dt, t) {
    const d = em.occTarget - em.occ;
    if (Math.abs(d) < 1e-4) return;
    em.occ = clamp(em.occ + clamp(d, -dt / OCC_GLIDE, dt / OCC_GLIDE), 0, 1);
    em.occLP.frequency.setTargetAtTime(
      clamp(20000 * Math.pow(0.021, em.occ), 300, 20000), t, 0.08);
    em.occHS.gain.setTargetAtTime(-26 * em.occ, t, 0.08);
  }

  /** Update an in-flight tracked emitter's occlusion/distance (beds, voices). */
  refresh(em) {
    if (em.free) return;
    const t = this.actx.currentTime;
    const p = em.pos;
    const dist = this.distanceTo(p.x, p.y, p.z);
    const occ = this.occlusionAt(p.x, p.y, p.z);
    em.occTarget = occ;
    // A `smooth` emitter is driven by `motion` every frame and owns its own
    // glide and slew. Writing the raw ray result here as well would step over
    // the very ramp that stops it pumping — this round-robin IS the step.
    if (em.smooth) return;
    em.occ = occ;
    const atten = this.attenuation(dist) * (1 - 0.62 * occ);
    em.airLP.frequency.setTargetAtTime(airCutoff(dist), t, 0.12);
    em.occLP.frequency.setTargetAtTime(clamp(20000 * Math.pow(0.021, occ), 300, 20000), t, 0.12);
    em.occHS.gain.setTargetAtTime(-26 * occ, t, 0.12);
    em.distGain.gain.setTargetAtTime(clamp(atten * (em.userGain ?? 1), 0, 4), t, 0.1);
  }

  /** Hand a voice's top node to an emitter and set its teardown time. */
  hold(em, node, endTime) {
    node.connect(em.input);
    em.attached = node;
    em.endTime = endTime;
  }

  update(dt) {
    const now = this.actx.currentTime;
    let active = 0, tracked = 0;
    for (let i = 0; i < this.emitters.length; i++) {
      const e = this.emitters[i];
      if (e.free) continue;
      if (!e.tracked && now > e.endTime) {
        e.detach();
        continue;
      }
      if (e.tracked) tracked++;
      active++;
    }
    this.stats.active = active;
    this.stats.tracked = tracked;

    // Occlusion is the only per-source raycast left (position and distance are
    // updated every frame by motion()), so it is round-robined: two tracked
    // emitters per frame is 4 raycasts, and with ~16 live sources every one is
    // re-tested about 8 times a second — fast enough that walking behind a
    // pillar is instant, cheap enough to be free.
    if (this.emitters.length) {
      let done = 0;
      for (let n = 0; n < this.emitters.length && done < 2; n++) {
        this._trackCursor = (this._trackCursor + 1) % this.emitters.length;
        const e = this.emitters[this._trackCursor];
        if (!e.free && e.tracked) {
          this.refresh(e);
          done++;
        }
      }
    }
  }

  dispose() {
    for (const e of this.emitters) e.dispose();
    this.emitters.length = 0;
  }
}
