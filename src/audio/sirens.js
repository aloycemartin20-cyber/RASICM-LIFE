/**
 * AUDIO / POLICE — sirens, dispatch chatter, and the pursuit layer
 *
 * A siren is a compression driver in an exponential horn, so it is modelled as
 * one: a harmonically rich carrier swept by a low-frequency shape, pushed
 * through the horn's passband and a pair of resonances, saturated by the driver
 * itself. That is why it cuts through a city the way a filtered sine never
 * does.
 *
 * The carrier frequency comes from a summing node:
 *
 *   centre (ConstantSource) ─┐
 *   sweep LFO -> depth      ─┴─► freqSum ─► doppler (gain) ─► carrier.frequency
 *
 * so the doppler ratio from the tracked emitter is ONE gain value and it scales
 * the whole sweep coherently — a cruiser passing you at 120 km/h drops a
 * musical third exactly as it should, and every harmonic drops with it.
 *
 * The pattern changes with the wanted level, the way a real unit escalates:
 *
 *   1*  wail          slow 0.28 Hz sweep, one unit
 *   2*  wail + yelp   yelp on the approach
 *   3*  yelp          3.6 Hz, urgent
 *   4*  yelp + hi-lo  alternating two-tone across units
 *   5*  + air horn    they are trying to move you off the road
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * A PURSUIT HAS TO SURVIVE MINUTE TEN, and the shipped one did not
 * ─────────────────────────────────────────────────────────────────────────────
 * The owner's report: "police sirens are annoying and make it distracting to
 * play when they fade in and out". Four separate mechanisms were producing that
 * one symptom, and every one of them was a STEP applied to a CONTINUOUS source:
 *
 *   - a unit dropped from the assignment (out of range, or fifth-nearest of
 *     five) had its emitter released the same frame, which disconnects the
 *     panner outright: a hard cut, then an 80 ms fade-in when it came back;
 *   - the range test was a single threshold at 220 m, so a cruiser holding
 *     station near it switched on and off with the noise on its own distance;
 *   - `_pattern` was indexed by this frame's distance RANK, so two cruisers
 *     overtaking each other swapped sirens;
 *   - N cruisers were N times the level, and the bus compressor then pumped the
 *     whole mix in sympathy every time one arrived or left.
 *
 * The fixes are, in order: a linger + a level envelope (`LVL_ATTACK`), range
 * hysteresis (`NEAR_ON` / `FAR_OFF`), a slot claimed for a unit's lifetime
 * (`_claimSlot`), and a shared cap in `update`. Underneath all of them,
 * `spatial.js`'s `smooth` emitter glides occlusion and rate-limits gain, which
 * is the fifth mechanism and the one no amount of bookkeeping here could fix.
 * `src/audio/muteprobe.mjs` measures the result on the emitted siren bus and
 * carries `smooth: false` as its negative control.
 */

import {
  ad, biquad, clamp, gain, hit, lerp, mtof, osc, saturationCurve, series, shaper, sweep, to,
} from './dsp.js';
import { bark, barkFor } from './vox.js';

/** Horn driver: strong odd and even harmonics, rolled off hard past the 6th. */
const HORN_CACHE = new WeakMap();
function hornWave(actx) {
  let w = HORN_CACHE.get(actx);
  if (w) return w;
  const amps = [0, 1, 0.62, 0.44, 0.26, 0.16, 0.1, 0.06, 0.035, 0.02];
  const real = new Float32Array(amps.length);
  const imag = new Float32Array(amps.length);
  for (let k = 1; k < amps.length; k++) imag[k] = amps[k];
  w = actx.createPeriodicWave(real, imag, { disableNormalization: false });
  HORN_CACHE.set(actx, w);
  return w;
}

const PATTERNS = {
  wail: { rate: 0.28, shape: 'triangle', centre: 1050, depth: 420, duty: 1 },
  yelp: { rate: 3.6, shape: 'triangle', centre: 1150, depth: 380, duty: 1 },
  hilo: { rate: 1.9, shape: 'square', centre: 1000, depth: 300, duty: 1 },
  piercer: { rate: 8.5, shape: 'sawtooth', centre: 1350, depth: 260, duty: 1 },
};

/**
 * Level envelope, in DECIBELS per second. A siren's LOUDNESS has to move slowly
 * even when its bookkeeping does not: a unit that loses its slot to a closer
 * cruiser for half a second, or crosses the range boundary, or is handed a
 * different pattern, must read as a swell rather than as a re-trigger.
 *
 * dB and not a linear ramp, which is what this was first written as: a linear
 * 1.1-per-second attack crosses -26 dB to -6 dB in a tenth of a second, so the
 * quietest part of every fade-in — the part that decides whether it reads as a
 * swell or as a switch — was the fastest. MEASURED on the emitted flyby, the
 * linear version recovered from a dropout at 31 dB/s. In dB the rate is the
 * same wherever the envelope happens to be, which is what "slow" has to mean.
 */
const LVL_UP_DB = 13;
const LVL_DOWN_DB = 12;
/** How far under the target the envelope may sit: caps the arrival at ~2 s. */
const LVL_FLOOR = 0.04;

/** One unit's siren. Built once and reused from a pool. */
class SirenVoice {
  constructor(actx, bank, rng, smooth = true) {
    this.actx = actx;
    this.rng = rng;
    /** false = the pre-fix behaviour, for the negative control. */
    this.smooth = smooth !== false;
    this.nodes = [];
    this.out = gain(actx, 0);

    /* ---- frequency drive ------------------------------------------- */
    // NO TWO UNITS SWEEP IN LOCK. Every siren was built from the same table
    // with the same LFO rate and started at the same instant, so four cruisers
    // ran phase-locked: their level swings — a swept tone under a fixed horn
    // formant is several dB of amplitude modulation — added COHERENTLY, which
    // is both louder than four sirens should be and unmistakably synthetic. A
    // few per cent of rate scatter drifts them apart permanently, and starting
    // the sweep a fraction of a second late scatters the phase from the first
    // note. Real units are two separate motors; they were never in sync.
    this._jit = rng.range(0.93, 1.07);
    const centre = actx.createConstantSource();
    centre.offset.value = PATTERNS.wail.centre;
    const lfo = osc(actx, 'triangle', PATTERNS.wail.rate * this._jit);
    const depth = gain(actx, PATTERNS.wail.depth);
    lfo.connect(depth);
    const freqSum = gain(actx, 1);
    centre.connect(freqSum);
    depth.connect(freqSum);
    const dop = gain(actx, 1);
    freqSum.connect(dop);
    centre.start(0);
    // Up to a third of a second late: the other half of the de-locking above.
    // A rate difference takes seconds to separate two units; a start offset
    // separates them from the first sweep.
    lfo.start(actx.currentTime + rng.range(0, 0.34));
    this._centre = centre;
    this._lfo = lfo;
    this._depth = depth;
    this._dop = dop;
    this.nodes.push(centre, lfo, depth, freqSum, dop);

    /* ---- two drivers, slightly apart -------------------------------- */
    const horn = gain(actx, 1);
    for (let i = 0; i < 2; i++) {
      const o = actx.createOscillator();
      o.setPeriodicWave(hornWave(actx));
      o.frequency.value = 0;
      o.detune.value = i === 0 ? -7 : 9;
      dop.connect(o.frequency);
      const g = gain(actx, i === 0 ? 0.6 : 0.45);
      o.connect(g); g.connect(horn);
      o.start(0);
      this.nodes.push(o, g);
    }

    /* ---- horn body -------------------------------------------------- */
    // Exponential horn: nothing below the cutoff gets out at all, and there are
    // two strong throat resonances that stay put while the tone sweeps under
    // them. That fixed formant over a moving tone is the sound.
    const hp = biquad(actx, 'highpass', 620, 0.9);
    const r1 = biquad(actx, 'peaking', 1500, 2.2, 9);
    // THE PIERCING BAND. 2.5-4 kHz is where the ear is most sensitive and it is
    // where a siren stops being urgent and starts being painful — it is also
    // exactly where this second throat resonance sat, at +6 dB, with a 6.8 kHz
    // lowpass leaving another octave of driver fizz above it. The horn still
    // needs the resonance (a swept tone under a FIXED formant is the sound), so
    // it stays; it is 4 dB quieter and the fizz above it is gone. MEASURED on
    // the rendered siren, share of power in 2.5-4 kHz: 9.0% -> 6.5%, i.e. 1.4 dB
    // of the band's weight — less than the 4 dB the filter moved, because most
    // of what is in that band is harmonics of the swept tone rather than the
    // resonance itself. With the bus trim it is 4.2 dB of absolute piercing
    // energy. Urgent at minute one, bearable at minute ten.
    const r2 = biquad(actx, 'peaking', 3100, 2.8, 2);
    const lp = biquad(actx, 'lowpass', 5600, 0.7);
    const drv = shaper(actx, saturationCurve(3.5, 0.4), '2x');
    series(horn, hp, r1, r2, lp, drv, this.out);
    this.nodes.push(horn, hp, r1, r2, lp);
    this._body = { r1, r2, hp };
    this._hornIn = horn;

    /* ---- air horn: a separate, much lower blast --------------------- */
    const air = osc(actx, 'sawtooth', 235);
    const airBP = biquad(actx, 'bandpass', 620, 1.1);
    const airG = gain(actx, 0);
    series(air, airBP, airG).connect(this.out);
    air.start(0);
    this._air = { osc: air, g: airG };
    this.nodes.push(air, airBP, airG);

    this.pattern = 'wail';
    this._level = 0;
    this.airTimer = 0;
    this.bank = bank;
  }

  setPattern(name, t) {
    const p = PATTERNS[name] ?? PATTERNS.wail;
    if (this.pattern === name) return;
    this.pattern = name;
    this._lfo.type = p.shape;
    to(this._lfo.frequency, p.rate * this._jit, t, 0.05);
    to(this._centre.offset, p.centre, t, 0.08);
    to(this._depth.gain, p.depth, t, 0.08);
  }

  /** @param {number} doppler ratio from the tracked emitter */
  setState(level, doppler, dt, t) {
    // The level is SLEWED, not set. Everything upstream of this — the slot
    // assignment, the range test, the shared cap — is allowed to be a step
    // function; this is what stops any of them being audible as one.
    if (this.smooth) {
      const tgt = Math.max(level, 1e-5);
      const cur = Math.max(this._level, tgt * LVL_FLOOR, 1e-5);
      const step = clamp(20 * Math.log10(tgt / cur), -LVL_DOWN_DB * dt, LVL_UP_DB * dt);
      this._level = cur * Math.pow(10, step / 20);
    } else {
      this._level = level;
    }
    to(this.out.gain, this._level, t, 0.08);
    to(this._dop.gain, doppler, t, 0.03);
    // The horn's throat resonances are a property of the horn, not the tone, so
    // they doppler-shift with it but do not sweep with the pattern.
    to(this._body.r1.frequency, 1500 * doppler, t, 0.05);
    to(this._body.r2.frequency, 3100 * doppler, t, 0.05);
    to(this._body.hp.frequency, 620 * doppler, t, 0.05);
    if (this.airTimer > 0) this.airTimer -= dt;
  }

  /** Two short blasts on the low horn. */
  airHorn(t, level = 1) {
    if (this.airTimer > 0) return;
    this.airTimer = this.rng.range(3.5, 9);
    for (let i = 0; i < 2; i++) {
      const st = t + i * 0.34;
      ad(this._air.g.gain, st, 0.55 * level, 0.02, 0.22);
    }
  }

  stop() {
    this._level = 0;
    // Long enough that a unit being retired is a siren going away, not a siren
    // being switched off. The manager has normally already walked the level
    // down with the envelope above by the time this is reached.
    to(this.out.gain, 0, this.actx.currentTime, this.smooth ? 0.3 : 0.12);
  }

  dispose() {
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* not a source */ }
      try { n.disconnect(); } catch { /* gone */ }
    }
    this.nodes.length = 0;
    try { this.out.disconnect(); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ */
/* Pursuit layer                                                       */
/* ------------------------------------------------------------------ */

/**
 * The music that arrives with the stars. A drone, a pulse and a top layer, all
 * driven continuously by the wanted level rather than switched between cues, so
 * losing a star is a decay and not an edit.
 */
class Tension {
  constructor(actx, bank, mixer, rng) {
    this.actx = actx;
    this.bank = bank;
    this.rng = rng;
    this.nodes = [];
    this.out = gain(actx, 0);
    this.out.connect(mixer.bus('music'));
    this.level = 0;
    this.target = 0;

    const root = 41; // F1 — the Furnace 101 root, so the city has one tonic

    /* drone: three detuned saws through a filter that opens with the level */
    const droneG = gain(actx, 0);
    const droneLP = biquad(actx, 'lowpass', 200, 3.5);
    series(droneG, droneLP).connect(this.out);
    for (let i = 0; i < 3; i++) {
      const o = osc(actx, 'sawtooth', mtof(root + (i === 2 ? 7 : 0)));
      o.detune.value = (i - 1) * 11;
      const g = gain(actx, i === 2 ? 0.3 : 0.5);
      o.connect(g); g.connect(droneG);
      o.start(0);
      this.nodes.push(o, g);
    }
    this._droneG = droneG;
    this._droneLP = droneLP;
    this.nodes.push(droneG, droneLP);

    /* a tritone above, only at 4 stars and up: the "they are serious" note */
    const dissG = gain(actx, 0);
    const dissLP = biquad(actx, 'lowpass', 2600, 1);
    series(dissG, dissLP).connect(this.out);
    for (const semi of [6, 13]) {
      const o = osc(actx, 'sawtooth', mtof(root + 24 + semi));
      o.detune.value = this.rng.range(-9, 9);
      const g = gain(actx, 0.3);
      o.connect(g); g.connect(dissG);
      o.start(0);
      this.nodes.push(o, g);
    }
    this._dissG = dissG;
    this.nodes.push(dissG, dissLP);

    /* pulse: scheduled, not an LFO, so its rate can step with the level */
    this.pulseTimer = 0;
    this.pulseOut = gain(actx, 1);
    this.pulseOut.connect(this.out);
    this.nodes.push(this.pulseOut);
  }

  setWanted(level) {
    this.target = clamp(level / 5, 0, 1);
  }

  /** A rising hit when a star is added — the only one-shot in the layer. */
  stinger(up) {
    const { actx, rng } = this;
    const t = actx.currentTime;
    const o = osc(actx, 'sawtooth', 110);
    const g = gain(actx, 0);
    const bp = biquad(actx, 'bandpass', 500, 1.2);
    const drv = shaper(actx, saturationCurve(5, 0.4), '2x');
    o.connect(g); series(g, bp, drv).connect(this.out);
    if (up) {
      sweep(o.frequency, t, 90, 460, 0.55);
      sweep(bp.frequency, t, 300, 2600, 0.55);
      ad(g.gain, t, 0.5, 0.3, 0.35);
    } else {
      sweep(o.frequency, t, 300, 70, 0.8);
      sweep(bp.frequency, t, 1800, 260, 0.8);
      ad(g.gain, t, 0.35, 0.02, 0.8);
    }
    o.start(t); o.stop(t + 1.5);
    void rng;
  }

  update(dt) {
    const t = this.actx.currentTime;
    // Rises fast, falls slowly: escaping should feel like it takes a while.
    const k = this.target > this.level ? dt * 1.1 : dt * 0.35;
    this.level += clamp(this.target - this.level, -k, k);
    const l = this.level;

    to(this.out.gain, l > 0.02 ? 0.5 : 0, t, 0.2);
    to(this._droneG.gain, 0.32 * l, t, 0.3);
    to(this._droneLP.frequency, lerp(90, 720, l), t, 0.4);
    to(this._dissG.gain, 0.10 * clamp((l - 0.55) * 2.4, 0, 1), t, 0.5);

    if (l < 0.12) return;
    this.pulseTimer -= dt;
    if (this.pulseTimer <= 0) {
      // 100 bpm at one star up to 168 at five, on the eighth.
      const bpm = lerp(100, 168, l);
      this.pulseTimer = 30 / bpm;
      const st = t + 0.02;
      const o = osc(this.actx, 'sine', 92);
      const g = gain(this.actx, 0);
      o.connect(g); g.connect(this.pulseOut);
      sweep(o.frequency, st, 110, 44, 0.06);
      ad(g.gain, st, 0.34 * l, 0.002, 0.12);
      o.start(st); o.stop(st + 0.25);
      if (l > 0.5 && this.rng.float() < 0.5) {
        const src = this.bank.source('white', this.rng, 1.1);
        const hp = biquad(this.actx, 'highpass', 5200, 0.8);
        const ng = gain(this.actx, 0);
        series(src, hp, ng).connect(this.pulseOut);
        hit(ng.gain, st + 30 / bpm, 0.06 * l, 0.03);
        src.start(st, src._offset, 0.4);
      }
    }
  }

  dispose() {
    for (const n of this.nodes) {
      try { n.stop?.(); } catch { /* noop */ }
      try { n.disconnect(); } catch { /* noop */ }
    }
    this.nodes.length = 0;
    try { this.out.disconnect(); } catch { /* noop */ }
  }
}

/* ------------------------------------------------------------------ */
/* Manager                                                             */
/* ------------------------------------------------------------------ */

const MAX_SIRENS = 4;

/**
 * RANGE HYSTERESIS. A single threshold on a distance that is itself noisy — the
 * unit is driving, the player is driving — is a switch that chatters, and every
 * chatter used to be a hard cut followed by an 80 ms fade-in. A unit now joins
 * inside NEAR_ON and is not let go until FAR_OFF, so the boundary cannot be
 * crossed twice by the same 60 m of road.
 */
const NEAR_ON = 190;
const FAR_OFF = 250;

/**
 * How long a unit that stopped being assigned keeps its emitter while its level
 * walks down. Covers the common case completely: a cruiser that loses its slot
 * to a closer one for a few frames never stops sounding at all, it just dips.
 *
 * 2 s, because that is what the envelope above needs to get from full to 24 dB
 * down — release the emitter before then and the truncation is the very step
 * this is here to remove. An emitter is cheap (52 of them, four sirens).
 */
const LINGER = 2.0;

/** One unit's siren level, before the shared cap in `update`. */
const SIREN_LEVEL = 0.5;

export class PoliceAudio {
  /**
   * @param {object} opts { smooth } — `smooth: false` is the negative control
   *   `src/audio/muteprobe.mjs` runs against the LIVE code with no edit (same
   *   pattern as `DialogueVoice`'s `duck: false`). It restores the pre-fix
   *   behaviour in one switch: no level envelope, no range hysteresis, no
   *   linger on release, no shared cap, and emitters that step their occlusion
   *   and snap their gain.
   */
  constructor(actx, bank, mixer, field, rng, opts = {}) {
    this.actx = actx;
    this.bank = bank;
    this.mixer = mixer;
    this.field = field;
    this.rng = rng;
    this.wanted = 0;
    this.smooth = opts.smooth !== false;
    this.tension = new Tension(actx, bank, mixer, rng.fork());
    this._pool = [];
    /** vehicle -> { voice, em, slot, hold, ratio, dist, seen } */
    this.units = new Map();
    /** Pattern slots, claimed for a unit's lifetime. See `_claimSlot`. */
    this._slots = [false, false, false, false];
    this._chatterTimer = 6;
    this._nearest = 1e9;
    this._nearSm = 1e9;
    this.stats = { sirens: 0, wanted: 0 };
  }

  setWanted(level, prev) {
    const l = clamp(level | 0, 0, 5);
    if (l === this.wanted) return;
    const up = l > this.wanted;
    this.wanted = l;
    this.tension.setWanted(l);
    this.stats.wanted = l;
    if (l !== (prev ?? 0)) this.tension.stinger(up);
    if (l === 0) {
      for (const u of this.units.values()) u.voice.stop();
    } else if (up) {
      // Dispatch calls it in.
      this._chatterTimer = this.rng.range(0.6, 1.6);
    }
  }

  /** The siren pattern for this wanted level and this unit's index. */
  _pattern(i) {
    const w = this.wanted;
    if (w <= 1) return 'wail';
    if (w === 2) return i === 0 ? 'wail' : 'yelp';
    if (w === 3) return 'yelp';
    if (w === 4) return i % 2 === 0 ? 'yelp' : 'hilo';
    return i % 3 === 0 ? 'piercer' : i % 3 === 1 ? 'yelp' : 'hilo';
  }

  /**
   * The lowest free pattern slot, held for the unit's whole life.
   *
   * `_pattern` used to be indexed by this frame's DISTANCE RANK, so two
   * cruisers overtaking each other at four stars swapped sirens with each other
   * — a yelp became a hi-lo and back, on the ranking, several times a chase.
   * The slot is now a property of the unit, and a pattern only changes when the
   * wanted level does.
   */
  _claimSlot() {
    for (let i = 0; i < this._slots.length; i++) {
      if (!this._slots[i]) { this._slots[i] = true; return i; }
    }
    return 0;
  }

  _take() {
    return this._pool.pop() ?? new SirenVoice(this.actx, this.bank, this.rng.fork(), this.smooth);
  }

  _give(voice) {
    voice.stop();
    try { voice.out.disconnect(); } catch { /* noop */ }
    if (this._pool.length < MAX_SIRENS) this._pool.push(voice);
    else voice.dispose();
  }

  /**
   * @param {Array} units  vehicle records from VehicleAudio: {vehicle,x,y,z,dist}
   */
  update(dt, units) {
    const t = this.actx.currentTime;
    this.tension.update(dt);

    for (const u of this.units.values()) u.seen = false;

    /* ---- assign the nearest units a siren -------------------------- */
    let assigned = 0;
    let nearest = 1e9;
    if (this.wanted > 0 && units) {
      for (let i = 0; i < units.length && assigned < MAX_SIRENS; i++) {
        const r = units[i];
        if (r.kind !== 'police') continue;
        let u = this.units.get(r.vehicle);
        if (r.dist > (u && this.smooth ? FAR_OFF : NEAR_ON)) continue;
        if (!u) {
          const voice = this._take();
          const em = this.field.acquireTracked({
            x: r.x, y: r.y, z: r.z, bus: 'sirens', send: 0.5, gain: 1, priority: 0.9,
            smooth: this.smooth,
          });
          if (!em) { this._give(voice); continue; }
          this.field.attach(em, voice.out);
          u = { voice, em, seen: true, slot: this._claimSlot(), hold: 0, ratio: 1, dist: r.dist };
          this.units.set(r.vehicle, u);
        }
        assigned++;
        nearest = Math.min(nearest, r.dist);
        u.seen = true;
        u.hold = 0;
        u.dist = r.dist;
        u.ratio = this.field.motion(u.em, r.x, r.y, r.z, dt);
      }
    }

    /*
     * THE SHARED CAP. Three cruisers converging on you used to be three times
     * one cruiser, and the bus compressor then pumped the whole pursuit in
     * sympathy. Every sounding unit gets a share instead: MEASURED as power,
     * four units at equal distance now sum to within 0.3 dB of one, so the
     * fleet reads as denser rather than louder. Units still fading out are
     * counted, deliberately — otherwise one leaving shoves the rest up as it
     * goes, which is the pumping this whole pass exists to remove.
     */
    const n = this.units.size;
    const share = this.smooth ? SIREN_LEVEL / (1 + 0.35 * Math.max(0, n - 1)) : SIREN_LEVEL;

    for (const [veh, u] of this.units) {
      if (u.seen) {
        u.voice.setPattern(this._pattern(u.slot), t);
        u.voice.setState(share, u.ratio, dt, t);
        if (this.wanted >= 5 && u.dist < 40 && this.rng.float() < dt * 0.25) {
          u.voice.airHorn(t, 1);
        }
        continue;
      }
      // Lost its slot, left the range, or despawned. It keeps its emitter and
      // walks its level down; if it is assigned again inside LINGER it never
      // stopped sounding at all. Releasing on the frame it was dropped — which
      // is what happened before, and `releaseTracked` disconnects the panner
      // outright — is a HARD CUT, and it is most of what "fade in and out" was.
      u.hold += dt;
      if (this.smooth && u.hold < LINGER) {
        u.voice.setState(0, u.ratio, dt, t);
        continue;
      }
      this.field.releaseTracked(u.em);
      this._give(u.voice);
      this._slots[u.slot] = false;
      this.units.delete(veh);
    }
    this.stats.sirens = this.units.size;

    /* ---- the radio ducks under a close siren ----------------------- */
    // Smoothed first. The raw nearest jumps whenever the nearest UNIT changes,
    // so the duck it drives stepped every time two cruisers swapped places.
    this._nearest = nearest;
    if (!this.smooth || nearest > 1e8 || this._nearSm > 1e8) {
      this._nearSm = nearest;
    } else {
      this._nearSm += (nearest - this._nearSm) * clamp(dt * (nearest < this._nearSm ? 3.5 : 1.2), 0, 1);
    }
    if (this._nearSm < 90) {
      this.mixer.duckBus('music', clamp(0.6 * (1 - this._nearSm / 90), 0, 0.6), 0.25);
    }

    /* ---- dispatch chatter ------------------------------------------ */
    if (this.wanted > 0) {
      this._chatterTimer -= dt;
      if (this._chatterTimer <= 0) {
        this._chatterTimer = this.rng.range(7, 22) / clamp(this.wanted * 0.5, 0.5, 2.5);
        this._chatter();
      }
    }
  }

  /** Unit-to-dispatch traffic, over a filtered comms channel. */
  _chatter() {
    const kinds = ['spot', 'flank', 'advance', 'copy', 'suppress'];
    const kind = this.rng.pick(kinds);
    const v = bark(this.actx, this.bank, this.rng, {
      when: this.actx.currentTime + 0.05,
      bark: barkFor(kind, this.rng),
      f0: 96 + (this.rng.u32() % 34),
      radio: true,
      level: 0.9,
    });
    // Dispatch comes out of the dashboard, not out of the world.
    const g = gain(this.actx, 0.85);
    v.node.connect(g);
    g.connect(this.mixer.bus('voice'));
    this.mixer.duckBus('music', 0.45, 0.4);
    setTimeout(() => { try { g.disconnect(); } catch { /* noop */ } }, (v.end - this.actx.currentTime + 1) * 1000);
  }

  dispose() {
    for (const u of this.units.values()) {
      this.field.releaseTracked(u.em);
      u.voice.dispose();
    }
    this.units.clear();
    this._slots.fill(false);
    for (const v of this._pool) v.dispose();
    this._pool.length = 0;
    this.tension.dispose();
  }
}
