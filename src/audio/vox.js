/**
 * AUDIO / VOICE — formant synthesis for enemy barks AND story dialogue
 *
 * No speech samples, so barks are built the way a vocal tract works:
 *
 *   glottal pulse train (PeriodicWave, 1/n^1.15 harmonics)
 *     + aspiration noise
 *     ─► three parallel band-passes at the formant frequencies F1..F3
 *     ─► chest/throat shaping, presence peak, mild saturation (shouting)
 *     + separately mixed consonant bursts (plosives and fricatives)
 *
 * The formant centres are ramped between vowels, the f0 follows a per-syllable
 * pitch contour, and both are jittered every ~25 ms. That jitter is the single
 * most important ingredient: without it the result is a Speak&Spell, with it a
 * player reads it as a human shouting a word they cannot quite make out — which
 * is exactly the goal for enemy chatter at 30 m.
 *
 * The bottom half of this file is `DialogueVoice`: the same tract, driven from
 * an AUTHORED LINE OF TEXT rather than a canned bark script, at a much quieter
 * and warmer register — see the header above `voiceLine`, which explains why it
 * deliberately does NOT try to pronounce the words.
 */

import {
  ad, adsr, biquad, clamp, gain, hit, saturationCurve, series, shaper, sweep, to,
} from './dsp.js';

/** F1, F2, F3 (Hz) and their bandwidths, adult male, shouted register. */
const VOWELS = {
  a: [730, 1090, 2440, 110, 130, 180],  // "father"
  e: [530, 1840, 2480, 90, 120, 170],   // "bed"
  i: [300, 2290, 3010, 70, 130, 190],   // "see"
  o: [570, 840, 2410, 90, 110, 170],    // "law"
  u: [325, 700, 2530, 70, 100, 170],    // "boot"
  ah: [640, 1200, 2500, 110, 140, 190],
  ehr: [490, 1350, 1690, 100, 130, 180], // "her"
  ohh: [450, 900, 2300, 95, 115, 175],
};

/**
 * Bark scripts. Each syllable: v vowel, d duration, a amplitude, p pitch
 * multiplier, on onset consonant ('p' plosive, 'f' fricative, 'n' nasal),
 * g gap after the syllable.
 */
export const BARKS = {
  /* "CONTACT!" */
  contact: {
    f0: 1.18, drive: 1.25, syl: [
      { v: 'o', d: 0.13, a: 1.0, p: 1.06, on: 'p', g: 0.012 },
      { v: 'a', d: 0.19, a: 1.0, p: 1.16, on: 'p', g: 0 },
    ],
  },
  /* "ENEMY SPOTTED" */
  spotted: {
    f0: 1.1, drive: 1.1, syl: [
      { v: 'e', d: 0.1, a: 0.9, p: 1.05, g: 0.01 },
      { v: 'a', d: 0.08, a: 0.7, p: 1.0, on: 'n', g: 0.01 },
      { v: 'i', d: 0.1, a: 0.8, p: 0.95, g: 0.06 },
      { v: 'a', d: 0.12, a: 1.0, p: 1.1, on: 'f', g: 0.02 },
      { v: 'e', d: 0.13, a: 0.75, p: 0.9, on: 'p', g: 0 },
    ],
  },
  /* "RELOADING!" */
  reloading: {
    f0: 1.05, drive: 1.0, syl: [
      { v: 'i', d: 0.09, a: 0.8, p: 1.0, g: 0.01 },
      { v: 'ohh', d: 0.16, a: 1.0, p: 1.12, g: 0.015 },
      { v: 'i', d: 0.13, a: 0.7, p: 0.9, on: 'p', g: 0 },
    ],
  },
  /* "GRENADE!" — panicked, pitch climbs hard */
  grenade: {
    f0: 1.3, drive: 1.5, syl: [
      { v: 'e', d: 0.1, a: 0.9, p: 1.0, on: 'p', g: 0.012 },
      { v: 'a', d: 0.26, a: 1.15, p: 1.35, on: 'n', g: 0 },
    ],
  },
  /* "FLANKING!" */
  flanking: {
    f0: 1.12, drive: 1.2, syl: [
      { v: 'a', d: 0.16, a: 1.0, p: 1.1, on: 'f', g: 0.015 },
      { v: 'i', d: 0.13, a: 0.8, p: 0.95, on: 'n', g: 0 },
    ],
  },
  /* "SUPPRESSING FIRE!" */
  suppressing: {
    f0: 1.08, drive: 1.15, syl: [
      { v: 'u', d: 0.09, a: 0.75, p: 0.98, on: 'f', g: 0.01 },
      { v: 'e', d: 0.14, a: 1.0, p: 1.12, on: 'p', g: 0.02 },
      { v: 'i', d: 0.1, a: 0.7, p: 0.9, g: 0.05 },
      { v: 'a', d: 0.18, a: 0.95, p: 1.05, on: 'f', g: 0 },
    ],
  },
  /* "MOVE UP!" */
  moveup: {
    f0: 1.1, drive: 1.2, syl: [
      { v: 'u', d: 0.16, a: 1.0, p: 1.08, on: 'n', g: 0.03 },
      { v: 'a', d: 0.14, a: 0.9, p: 1.0, g: 0 },
    ],
  },
  /* wordless taking-fire grunt */
  hit: {
    f0: 1.25, drive: 1.6, breath: 0.5, syl: [
      { v: 'ah', d: 0.16, a: 1.1, p: 1.2, on: 'p', g: 0 },
    ],
  },
  /* pain, longer, wavering */
  pain: {
    f0: 1.15, drive: 1.3, breath: 0.65, tremolo: 14, syl: [
      { v: 'ah', d: 0.34, a: 0.95, p: 1.0, g: 0 },
    ],
  },
  /* death: pitch collapses, breath takes over, ends in an exhale */
  death: {
    f0: 1.05, drive: 1.4, breath: 1.0, tremolo: 22, dying: true, syl: [
      { v: 'ah', d: 0.3, a: 1.0, p: 1.15, g: 0.02 },
      { v: 'ehr', d: 0.42, a: 0.6, p: 0.62, g: 0 },
    ],
  },
  /* short affirmative, for squad chatter */
  copy: {
    f0: 1.0, drive: 0.9, syl: [
      { v: 'a', d: 0.1, a: 0.85, p: 1.0, on: 'p', g: 0.02 },
      { v: 'i', d: 0.12, a: 0.7, p: 0.88, on: 'p', g: 0 },
    ],
  },
};

const WAVE_CACHE = new WeakMap();

/**
 * Glottal-ish pulse, with an EFFORT-DEPENDENT spectral tilt.
 *
 * A 1/n^1.15 rolloff kept a lot of energy on the high harmonics, and a hard
 * periodic source that bright is exactly the buzzy, "Speak&Spell" edge that
 * reads as alien. A real glottal flow falls off steeper — but by how much
 * depends on vocal EFFORT: a relaxed chest voice has a steep source (little
 * high-harmonic energy, warm), a shout drives the folds harder and the source
 * flattens (more high harmonics, brighter, carries at distance). Real speech
 * modulates this "spectral tilt" with loudness, and doing it at the SOURCE is
 * more honest than only brightening the output filter.
 *
 * So the rolloff exponent `tilt` is chosen by the caller from the bark's drive:
 * ~1.85 for calm squad talk (warm), ~1.45 for a panicked yell (bright). Waves
 * are cached per exponent bucket. The even harmonics are pulled down a little
 * (a rounder pulse, less reedy) at every tilt.
 */
function glottalWave(actx, tilt = 1.6) {
  let byCtx = WAVE_CACHE.get(actx);
  if (!byCtx) WAVE_CACHE.set(actx, (byCtx = new Map()));
  const bucket = Math.round(tilt * 20) / 20; // 0.05 resolution keeps the cache small
  let w = byCtx.get(bucket);
  if (w) return w;
  const N = 48; // reach ~4.8 kHz at f0=100 so F4 has harmonics to excite
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  for (let n = 1; n < N; n++) {
    imag[n] = (1 / Math.pow(n, bucket)) * (n % 2 === 0 ? -0.6 : 1);
  }
  w = actx.createPeriodicWave(real, imag, { disableNormalization: false });
  byCtx.set(bucket, w);
  return w;
}

/**
 * Synthesize a bark.
 *
 * @param {object} o { when, bark, f0 (base Hz), tract (0.9..1.1), level,
 *                     radio (bool), distance }
 */
export function bark(actx, bank, rng, o = {}) {
  const t0 = o.when ?? actx.currentTime;
  const spec = BARKS[o.bark] ?? BARKS.contact;
  const tract = o.tract ?? rng.range(0.94, 1.07);
  const f0 = (o.f0 ?? rng.range(96, 132)) * spec.f0;
  const level = o.level ?? 1;
  const out = gain(actx, 0.2); // VOICE TRIM

  // Vocal effort. Calm squad chatter sits ~0.9, a panicked yell ~1.5. It drives
  // three things at once — the source spectral tilt (here), the formant
  // sharpness, and the presence/saturation downstream — so the whole voice
  // brightens together as it gets louder, which is what a real one does.
  const dr = spec.drive ?? 1;
  // Straddle the old fixed 1.55: calm talk warmer (~1.75), a yell brighter.
  const tiltExp = clamp(1.7 - 0.5 * (dr - 1), 1.45, 1.9);
  // Formant Q: sharpen the calm voice for clear vowels; leave the shout broad
  // and rough (it needs to carry, not to be pretty). Never below ~0.9 so a yell
  // stays intelligible.
  const qScale = clamp(1.35 - 0.6 * (dr - 0.9), 0.9, 1.35);

  const total = spec.syl.reduce((s, x) => s + x.d + (x.g ?? 0), 0);

  /* ---- source ---------------------------------------------------- */
  const src = actx.createOscillator();
  src.setPeriodicWave(glottalWave(actx, tiltExp));
  const srcGain = gain(actx, 0);
  src.connect(srcGain);

  // Humanise the pitch. A formant voice on a dead-steady fundamental is the
  // single biggest "alien / robot" tell; a real larynx never holds a note
  // perfectly. Two slow, incommensurate LFOs sum into the frequency param on
  // TOP of the scheduled syllable contour: a ~5 Hz vibrato and a slower drift,
  // together under ~2% so it warms rather than warbles. Skip on the death line,
  // where the pitch is meant to collapse cleanly.
  if (!spec.dying) {
    const lfoEnd = t0 + total + 0.5;
    const vibHz = rng.range(4.6, 5.8);
    const vib = actx.createOscillator();
    vib.type = 'sine'; vib.frequency.value = vibHz;
    const vg = gain(actx, f0 * 0.010);
    vib.connect(vg); vg.connect(src.frequency);
    const drift = actx.createOscillator();
    drift.type = 'sine'; drift.frequency.value = rng.range(0.7, 1.3);
    const dg = gain(actx, f0 * 0.012);
    drift.connect(dg); dg.connect(src.frequency);
    // Fast flutter (~9-12 Hz). A real larynx has a fine cycle-to-cycle jitter
    // above the vibrato band; the reference synth builds it from 7.1 + 12.7 Hz
    // components. Adding this third, faster, shallow term is what stops the
    // pitch reading as a clean sine-modulated tone and pushes it toward a
    // living voice. Kept tiny (~0.4%) so it textures rather than warbles.
    const flut = actx.createOscillator();
    flut.type = 'sine'; flut.frequency.value = rng.range(8.5, 12.5);
    const fg = gain(actx, f0 * 0.004);
    flut.connect(fg); fg.connect(src.frequency);
    vib.start(t0); vib.stop(lfoEnd);
    drift.start(t0); drift.stop(lfoEnd);
    flut.start(t0); flut.stop(lfoEnd);
  }

  // Aspiration: always a little, a lot when hurt or dying.
  const breathLevel = (spec.breath ?? 0.16) * rng.range(0.8, 1.25);
  const noise = bank.source('white', rng, rng.range(0.9, 1.2));
  const noiseBP = biquad(actx, 'bandpass', 1400, 0.6);
  const noiseGain = gain(actx, 0);
  series(noise, noiseBP, noiseGain);

  const excite = gain(actx, 1);
  srcGain.connect(excite);
  noiseGain.connect(excite);

  /* ---- formant bank ---------------------------------------------- */
  const first = VOWELS[spec.syl[0].v] ?? VOWELS.a;
  const fs = [];
  for (let i = 0; i < 3; i++) {
    const f = first[i] * tract;
    const bw = first[i + 3];
    const bp = biquad(actx, 'bandpass', f, clamp((f / bw) * qScale, 1.5, 14));
    const g = gain(actx, [1.0, 0.55, 0.24][i]);
    excite.connect(bp);
    bp.connect(g);
    fs.push({ bp, g });
  }
  // F4 — a fixed high resonance. Real adult voices carry a 4th (and 5th)
  // formant clustered around 3.3-3.7 kHz; the 3-formant model has none, which
  // is a large part of why a pure source+F1F2F3 vowel reads thin and slightly
  // synthetic. F4 barely moves across vowels, so it is built once and held for
  // the whole bark (the per-vowel glide loop below only touches fs[0..2]). It
  // is pushed into `fs` only so it feeds `throat` with the others.
  {
    const f4Hz = clamp(3350 * tract, 2600, 4200);
    // A parallel bank (unlike a cascade) does not inherit the lower formants'
    // energy, so a high formant fed a source that already rolls off steeply
    // comes out near-silent without makeup gain — the same compensation
    // struckResonator() applies to its high-Q partials. 0.34 puts F4 at a
    // believable "ring" level next to F3 (0.24). Its EXCITATION still scales
    // with vocal effort for free: the calm voice's steep source barely lights
    // it, a bright yell lights it fully — so F4 adds cut to a shout and only a
    // little air to talk, which is exactly right.
    const bp = biquad(actx, 'bandpass', f4Hz, f4Hz / 360);
    const g = gain(actx, 0.34);
    excite.connect(bp);
    bp.connect(g);
    fs.push({ bp, g });
  }

  /* ---- vocal tract output shaping -------------------------------- */
  // The presence peak and the saturation are what separate "someone talking"
  // from "a robot shouting". Both now scale with the bark's own drive: a calm
  // squad line (drive ~0.9) gets a gentle 2.2 dB presence and light saturation
  // so it reads as a person; a panicked enemy yell (drive ~1.5) keeps a bright,
  // cutting 4.0 dB peak and more grit so it still punches through at 30 m.
  const throat = biquad(actx, 'peaking', 470, 1.0, 4.2);          // chest warmth
  const presence = biquad(actx, 'peaking', 2550, 1.2, clamp(dr * 3.0 - 0.5, 1.6, 5)); // presence
  const hp = biquad(actx, 'highpass', 140, 0.7);
  const lp = biquad(actx, 'lowpass', 5000, 0.7);
  const drv = shaper(actx, saturationCurve(1.25 * dr, 0.32), '2x');
  const bodyGain = gain(actx, 1.5 * level);
  for (const f of fs) f.g.connect(throat);
  series(throat, presence, hp, lp, drv, bodyGain).connect(out);

  /* ---- tremolo (pain / death gargle) ----------------------------- */
  let trem = null;
  if (spec.tremolo) {
    trem = actx.createOscillator();
    trem.type = 'sine';
    trem.frequency.value = spec.tremolo * rng.range(0.85, 1.15);
    const tg = gain(actx, 0.35);
    trem.connect(tg);
    tg.connect(bodyGain.gain);
    trem.start(t0);
    trem.stop(t0 + total + 0.4);
  }

  /* ---- per-syllable automation ----------------------------------- */
  // Declination: across a spoken phrase the pitch drifts gently DOWN, and a
  // voice that holds a flat baseline across syllables is a classic robot tell.
  // Applied only where it won't fight the authored contour — skip it when the
  // bark is meant to climb (a panicked yell), is a single syllable, or is the
  // death line (which collapses on its own).
  const nSyl = spec.syl.length;
  const rising = spec.syl[nSyl - 1].p >= spec.syl[0].p;
  const declines = !spec.dying && !rising && nSyl > 1;
  const declAt = (i) => (declines ? 1 - 0.07 * (i / (nSyl - 1)) : 1);

  let t = t0;
  src.frequency.setValueAtTime(f0 * spec.syl[0].p * declAt(0), t0);
  for (let i = 0; i < spec.syl.length; i++) {
    const s = spec.syl[i];
    const v = VOWELS[s.v] ?? VOWELS.a;
    const amp = s.a * 0.5;

    /* onset consonant, mixed straight to the output */
    if (s.on) {
      // Onsets lead the vowel; never let that run off the start of the timeline.
      const ct = Math.max(t - (s.on === 'f' ? 0.055 : 0.018), 0);
      const cs = bank.source('white', rng, rng.range(0.9, 1.3));
      const cbp = biquad(actx, s.on === 'f' ? 'bandpass' : 'highpass',
        s.on === 'f' ? rng.range(3800, 6500) : rng.range(1400, 2600),
        s.on === 'f' ? 1.1 : 0.7);
      const cg = gain(actx, 0);
      series(cs, cbp, cg).connect(out);
      if (s.on === 'f') {
        ad(cg.gain, ct, 0.1 * level, 0.012, 0.05);
        cs.start(ct, cs._offset, 0.12);
      } else if (s.on === 'n') {
        // Nasal: hum through a low formant instead of a burst.
        ad(cg.gain, ct, 0.02 * level, 0.01, 0.04);
        cs.start(ct, cs._offset, 0.08);
        fs[0].bp.frequency.setValueAtTime(260 * tract, ct);
      } else {
        hit(cg.gain, ct, 0.16 * level, 0.014);
        cs.start(ct, cs._offset, 0.05);
      }
    }

    /* formant glide into this vowel — 35 ms transition reads as articulation */
    for (let k = 0; k < 3; k++) {
      const f = v[k] * tract * (1 + rng.range(-0.02, 0.02));
      const bw = v[k + 3];
      fs[k].bp.frequency.setTargetAtTime(f, Math.max(t - 0.03, t0), 0.014);
      fs[k].bp.Q.setTargetAtTime(clamp((f / bw) * qScale, 1.5, 14), Math.max(t - 0.03, t0), 0.02);
    }

    /* pitch contour: rise into the stressed syllable, sag at the end */
    const pTarget = f0 * s.p * declAt(i);
    src.frequency.setTargetAtTime(pTarget, t, 0.03);
    if (spec.dying && i === spec.syl.length - 1) {
      sweep(src.frequency, t + 0.05, pTarget, pTarget * 0.45, s.d);
    } else {
      src.frequency.setTargetAtTime(pTarget * 0.94, t + s.d * 0.6, 0.06);
    }

    /* amplitude: fast onset, held, quick release; last syllable decays longer */
    const last = i === spec.syl.length - 1;
    const rel = last ? (spec.dying ? s.d * 0.9 : 0.055) : 0.028;
    adsr(srcGain.gain, t, amp * level, 0.014, s.d * 0.22, s.d * 0.5, 0.72, rel);
    ad(noiseGain.gain, t, amp * breathLevel * level, 0.02, s.d + rel);

    t += s.d + (s.g ?? 0);
  }

  /* ---- dying exhale ---------------------------------------------- */
  if (spec.dying) {
    const et = t + 0.05;
    const es = bank.source('white', rng, rng.range(0.6, 0.9));
    const ebp = biquad(actx, 'bandpass', 700, 0.55);
    const eg = gain(actx, 0);
    series(es, ebp, eg).connect(out);
    sweep(ebp.frequency, et, 900, 380, 0.6);
    ad(eg.gain, et, 0.16 * level, 0.08, 0.6);
    es.start(et, es._offset, 0.9);
    t = et + 0.7;
  }

  const end = t + 0.35;
  const srcStart = Math.max(t0 - 0.01, 0);
  src.start(srcStart);
  src.stop(end);
  noise.start(srcStart, noise._offset, end - srcStart + 0.05);

  /* ---- radio treatment (squad comms) ----------------------------- */
  if (o.radio) {
    const rbp1 = biquad(actx, 'highpass', 420, 0.8);
    const rbp2 = biquad(actx, 'lowpass', 3200, 0.9);
    const rdrv = shaper(actx, saturationCurve(7, 0.3), '2x');
    const rg = gain(actx, 1.1);
    const radioOut = gain(actx, 1);
    series(out, rbp1, rbp2, rdrv, rg).connect(radioOut);
    // Squelch click at both ends of the transmission.
    for (const st of [Math.max(t0 - 0.05, 0), end - 0.2]) {
      const cs = bank.source('white', rng, 1.1);
      const cbp = biquad(actx, 'bandpass', 2600, 1.6);
      const cg = gain(actx, 0);
      series(cs, cbp, cg).connect(radioOut);
      hit(cg.gain, st, 0.09, 0.03);
      cs.start(st, cs._offset, 0.06);
    }
    return { node: radioOut, end: end + 0.1, send: 0.05 };
  }

  return { node: out, end: end + 0.1, send: 0.45 };
}

/** Pick a plausible bark for an AI event without the ai agent knowing our list. */
export function barkFor(kind, rng) {
  switch (kind) {
    case 'spot': return rng.float() < 0.5 ? 'contact' : 'spotted';
    case 'reload': return 'reloading';
    case 'grenade': return 'grenade';
    case 'flank': return 'flanking';
    case 'suppress': return 'suppressing';
    case 'advance': return 'moveup';
    case 'hurt': return rng.float() < 0.5 ? 'hit' : 'pain';
    case 'death': return 'death';
    case 'copy': return 'copy';
    default: return 'contact';
  }
}

/* ===================================================================== */
/* STORY DIALOGUE                                                        */
/* ===================================================================== */

/**
 * THE DECISION THIS SECTION IS BUILT AROUND, because it is the difference
 * between a game that sounds better and one that sounds worse.
 *
 * Twenty-four chapters of authored dialogue play as typed text. There are two
 * ways to put a voice under it with a formant synth and no speech samples:
 *
 *   1. TRY TO PRONOUNCE THE LINE. Articulate every consonant, hold every vowel,
 *      and sit the result up in the mix where a voice-over belongs. This is the
 *      uncanny-valley option: it PROMISES words and delivers a phoneme salad,
 *      and the brain — which is already reading the real words off the screen —
 *      spends the whole scene noticing the mismatch. Speak&Spell reciting
 *      Chekhov. A player would rather have silence.
 *   2. VOCALISE IT. The same tract, the same per-speaker larynx, the syllable
 *      COUNT and STRESS PATTERN of the real line, but soft consonants, a warm
 *      source and a level that sits under the writing rather than over it. This
 *      is the register every open-world game uses for radio chatter and crowd
 *      talk, and the one the Sims/Animal Crossing lineage made a genre of: the
 *      listener hears "a person is speaking, and that is Carson", never "that
 *      word was wrong".
 *
 * This is (2), and every parameter below is chosen to keep it there:
 *   - ARTICULATION is a scalar, not a switch. It was set to a THIRD of a bark's
 *     on the theory that quiet consonants stop the ear trying to parse the
 *     syllables into words. THE OWNER PLAYED IT AND COULD NOT TELL IT WAS
 *     SPEECH AT ALL — "muffled, cannot understand speech" — which is the
 *     failure mode on the other side of (1), and a worse one: a vowel bed with
 *     no syllable edges is not "a person talking indistinctly", it is a hum.
 *     Consonant onsets carry the RHYTHM, and the rhythm is the half of speech
 *     this register exists to deliver. They are now mixed near a bark's, and
 *     that does NOT push the read toward (1): the vowels are untouched, so
 *     there is still no word to get wrong — only an edge on every syllable.
 *     Measured on the emitted read (duckprobe 2c, onset energy ratio): -21.1 dB
 *     before, -15.3 dB after. See ARTICULATION below.
 *   - The source tilt is the WARMEST bucket and the presence peak is a fifth of
 *     the shout's, so it reads as talk in a room, not a PA announcement.
 *   - It is paced at a human speaking rate (~4.5 syllables/s) and DROPS weak
 *     syllables rather than gabbling when the line is long. A read that gabbles
 *     to keep up with the typewriter is the tell that gives the whole trick
 *     away.
 *   - Level sits above the ducked bed and below the typing.
 *
 * What it still buys, which silence does not: the scene has a voice, the three
 * brothers are audibly three different people, the boss is audibly bigger than
 * they are, and `cop` / `radio` come through a speaker. Those are the four
 * things the writing needed and did not have.
 */

/** Vowel + r: the r-coloured nucleus you actually hear ("her", "far"). */
const R_COLOUR = { ar: 'ah', er: 'ehr', ir: 'ehr', or: 'ohh', ur: 'ehr' };
/** Two-letter vowel groups worth distinguishing. */
const V2 = {
  ee: 'i', ea: 'i', ie: 'i', ei: 'e', ey: 'e', ay: 'e', ai: 'e',
  oo: 'u', ou: 'ohh', ow: 'ohh', oa: 'ohh', oi: 'o', oy: 'o',
  au: 'ah', aw: 'ah', ue: 'u', ui: 'u', eu: 'u', ya: 'a',
};
const V1 = { a: 'a', e: 'e', i: 'i', o: 'o', u: 'u', y: 'i' };
/** Consonant letter -> the onset class `bark`'s syllable player understands. */
const ONSET = {
  b: 'p', p: 'p', t: 'p', d: 'p', k: 'p', g: 'p', c: 'p', q: 'p', j: 'p', x: 'p',
  f: 'f', s: 'f', h: 'f', v: 'f', z: 'f',
  m: 'n', n: 'n', l: 'n', r: 'n', w: 'n', y: 'n',
};
/** Function words: never stressed, and the first to be dropped from a long line. */
const WEAK = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'at', 'and', 'or', 'is', 'it', 'its',
  'was', 'are', 'be', 'for', 'with', 'that', 'this', 'you', 'your', 'we', 'he',
  'she', 'they', 'i', 'me', 'my', 'him', 'her', 'them', 'as', 'so', 'if', 'do',
  'did', 'from', 'by', 'has', 'have', 'had', 'am', 'been', 'were', 'our', 'us',
]);

const isVowelLetter = (c) => c === 'a' || c === 'e' || c === 'i' || c === 'o' || c === 'u' || c === 'y';
/** Hoisted: a literal inside the scan loop builds a RegExp per character. */
const WORD_CH = /[a-z']/;

/**
 * An authored line -> the syllable spine a vocal tract can play.
 *
 * Deliberately NOT a pronunciation dictionary: it recovers the NUMBER of
 * syllables, their vowel colour, their onset class and which of them carry
 * stress, which is everything the register above needs and nothing it does not.
 * Two different lines therefore sound different (same speaker, different shape),
 * which is the property a generic murmur loop cannot have.
 *
 * Writes into `out` and returns it — one array per DialogueVoice, reused per
 * line, so a scene of twenty lines allocates one array and not twenty.
 */
export function syllabify(text, out = []) {
  out.length = 0;
  const s = String(text ?? '').toLowerCase();
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    /* punctuation: a breath, and the terminal intonation for the last one */
    if (ch === ',' || ch === ';' || ch === ':' || ch === '-' || ch === '—') {
      if (out.length) out[out.length - 1].gap = Math.max(out[out.length - 1].gap, 0.17);
      i++;
      continue;
    }
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…') {
      if (out.length) {
        const last = out[out.length - 1];
        last.gap = Math.max(last.gap, 0.3);
        last.rise = ch === '?';
      }
      i++;
      continue;
    }
    if (!WORD_CH.test(ch)) { i++; continue; }

    /* one word */
    let j = i;
    while (j < s.length && WORD_CH.test(s[j])) j++;
    const w = s.slice(i, j).replace(/'/g, '');
    i = j;
    const first = out.length;
    let onset = '';
    let k = 0;
    while (k < w.length) {
      const c = w[k];
      if (!isVowelLetter(c)) {
        // The LAST consonant before the nucleus is the one you hear on it.
        const cls = ONSET[c];
        if (cls) onset = cls;
        k++;
        continue;
      }
      let e = k + 1;
      if (e < w.length && isVowelLetter(w[e])) e++;
      let key = null;
      if (e - k === 1 && w[e] === 'r' && (e + 1 >= w.length || !isVowelLetter(w[e + 1]))) {
        key = R_COLOUR[c + 'r'];
        if (key) e++;
      }
      if (!key && e - k === 2) key = V2[w.slice(k, e)];
      if (!key) { key = V1[c]; e = k + 1; }
      // Silent terminal 'e' ("stone", "made") is not a syllable — unless it is
      // the word's only vowel ("the", "we"), where it is the whole word.
      const silentE = e === w.length && e - k === 1 && c === 'e' && out.length > first;
      if (!silentE) {
        out.push({ v: key, on: onset, stress: 0, gap: 0, rise: false, keep: true });
        onset = '';
      }
      k = e;
    }
    if (out.length === first) continue;         // a word with no vowel at all
    // English stress is overwhelmingly word-initial, and a function word carries
    // none: that pattern alone is most of what makes a read scan as a sentence.
    if (!WEAK.has(w)) out[first].stress = 1;
    out[out.length - 1].gap = Math.max(out[out.length - 1].gap, 0.055);
  }
  return out;
}

/**
 * Per-speaker larynx. The named cast is AUTHORED — the three brothers have to be
 * three audibly different men in the order the game presents them (Carson
 * eldest and lowest, Dylan youngest and highest), the boss has to be bigger than
 * any of them, and `cop` / `radio` arrive through a speaker. Anyone else is
 * hashed from their id, so an unknown speaker is still stable across a replay
 * and still not a clone of the last one.
 *
 * `rate` is syllables per second, which is the other half of a character: Carson
 * is slow, Dylan talks fast, the boss takes his time.
 */
export const VOICES = {
  carson: { f0: 92, tract: 1.06, drive: 0.86, breath: 0.22, rate: 4.0 },
  aidan: { f0: 116, tract: 0.99, drive: 1.02, breath: 0.17, rate: 4.9 },
  dylan: { f0: 132, tract: 0.94, drive: 0.94, breath: 0.20, rate: 5.3 },
  gabby: { f0: 186, tract: 0.86, drive: 0.88, breath: 0.26, rate: 4.7 },
  boss: { f0: 84, tract: 1.10, drive: 1.14, breath: 0.14, rate: 3.6 },
  cop: { f0: 124, tract: 1.00, drive: 1.00, breath: 0.16, rate: 5.0, radio: true },
  radio: { f0: 128, tract: 0.97, drive: 0.92, breath: 0.18, rate: 5.4, radio: true },
};

/** FNV-1a over the id — a stable voice for a speaker nobody authored. */
function hashId(id) {
  let h = 0x811c9dc5;
  const s = String(id ?? '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The voice for a speaker id. Never null; deterministic for any string. */
export function voiceFor(id) {
  const key = String(id ?? '').trim().toLowerCase();
  const named = VOICES[key];
  if (named) return named;
  const h = hashId(key);
  return {
    f0: 96 + (h % 56),                       // 96..151 Hz
    tract: 0.92 + ((h >>> 8) % 17) / 100,    // 0.92..1.08
    drive: 0.88 + ((h >>> 16) % 25) / 100,   // 0.88..1.12
    breath: 0.15 + ((h >>> 20) % 12) / 100,
    rate: 4.2 + ((h >>> 24) % 13) / 10,      // 4.2..5.4 syllables/s
  };
}

/** Never gabble: past this the read stops sounding like a person talking. */
const MAX_SYL_RATE = 6.2;
/**
 * Consonant bursts, relative to a bark's. See the register note above.
 *
 * 0.34 was the shipped value and it is what "muffled" meant: MEASURED on the
 * rendered read (duckprobe's onset energy ratio — the consonant burst against
 * the vowel bed masking it), the shipped line scored -21.1 dB. At 0.9 the same
 * measurement is -15.3 dB, and the 5.8 dB is the difference between a burst you
 * hear as a /t/ and one that disappears into the vowel it opens.
 *
 * RATCHET (rule 13) in the other direction from most: this is a floor on
 * intelligibility, not a ceiling on loudness. If a later pass finds a way to
 * make the onsets clearer at a LOWER burst level — sharper bursts, a shorter
 * closure — take this down and lower duckprobe's ONSET_RATIO_MIN with it. Do
 * not push it up chasing the metric: past about 1.2 the bursts start reading as
 * a separate percussion track running alongside the voice.
 */
const ARTICULATION = 0.9;
/**
 * Output trim, MEASURED on the rendered mix rather than chosen (duckprobe arms
 * 2 and 2b). A dialogue line has to sit ABOVE the bed it is ducking, or the
 * duck was pointless: at 0.30 the read came out at -40.2 dBFS against a ducked
 * radio at -25.4 — 15 dB UNDER the thing it had just pushed down.
 *
 * THE CEILING IS NOT THE LIMITER, IT IS THE VOICE BUS COMPRESSOR, and that is
 * the whole reason this number is 7 and not 16. Measured across a sweep:
 *
 *     trim   read dBFS   modulation depth   voiced
 *      5.6     -24.0          14.9 dB         81%
 *      7.0     -23.1          14.4 dB         84%
 *     16.0     -19.5          12.4 dB         91%   <- squashed back into a drone
 *
 * `voice` compresses at -18 dBFS, ratio 3, release 0.22 s, and there is no
 * makeup gain — so past about 8 the extra trim buys 1 dB of level and spends 2
 * dB of the speech dynamics that make it sound like a person at all. The right
 * lever for "louder than the bed" is therefore the DUCK, not the voice: see
 * DIALOGUE_DUCK. At 7.0 the read is -23.1 dBFS peak 0.32, 8.2 dB over the
 * ducked bed, and still modulating 14.4 dB.
 *
 * 7.0 WAS TOO LOUD IN THE ROOM. The owner: "louder and more prominent than
 * before". 8.2 dB over a bed that has itself just been pushed down 12.4 dB is
 * not "audible over the bed", it is the only thing in the mix — and every dB of
 * that was being spent making an unintelligible read more prominent, which is
 * the worst possible trade. The margin to aim at is the one a film mix uses for
 * dialogue over score: a few dB, not a decade. 5.5 here, with the voice bus
 * trim down from 0.85 to 0.65 (`mixer.js`) doing the other half, lands the read
 * about 4.5 dB over the ducked bed — still comfortably clear of duckprobe's
 * VOICE_OVER_BED_DB floor of 3, and no longer shouting.
 *
 * Note which lever moved and which did not: the DUCK is unchanged, so the bed
 * still gets out of the way by the same 12.4 dB. What changed is that the read
 * no longer fills the hole it makes.
 */
const LINE_TRIM = 5.5;

/**
 * Synthesize a spoken read of `o.text` in `o.voice`'s larynx.
 *
 * @param {object} o { when, text, voice, dur, level, id }
 * @returns {?{node, end, send, sources}} null if the line has no syllables.
 *   `sources` is every started node, so the caller can cut the read short — a
 *   skipped line has to stop MID-WORD, which is the one thing a fire-and-forget
 *   one-shot cannot do.
 */
export function voiceLine(actx, bank, rng, o = {}) {
  const t0 = Math.max(o.when ?? actx.currentTime, 0);
  const V = o.voice ?? voiceFor(o.id);
  const syl = o.syllables ?? syllabify(o.text);
  if (!syl.length) return null;

  /* ---- pacing ------------------------------------------------------- */
  /*
   * `rate` is SYLLABLES PER SECOND AS HEARD — nuclei divided by the wall clock
   * of the whole read, gaps and all. That is the number a listener perceives as
   * "he talks fast", and it is the one the probe recovers from the emitted
   * envelope, so the two cannot drift apart. It is NOT a per-syllable duration:
   * treating it as one made Carson's 4.0 come out at 3.0 as heard, because the
   * word gaps and the stress weighting are half a second of the line.
   */
  const rate = clamp(o.rate ?? V.rate ?? 4.6, 3.0, 6.5);
  let n = syl.length;
  for (let i = 0; i < n; i++) syl[i].keep = true;
  const budget = Number.isFinite(o.dur) && o.dur > 0.5 ? o.dur : Infinity;
  let kept = 0;
  const count = () => {
    kept = 0;
    for (let i = 0; i < n; i++) if (syl[i].keep) kept++;
    return kept;
  };
  // A line longer than its slot loses its WEAK syllables first — an elision, the
  // thing a real speaker does under time pressure — and only then gets cut off.
  // Speeding past MAX_SYL_RATE instead is what turns a read into a gabble.
  for (let pass = 0; pass < 3 && count() / MAX_SYL_RATE > budget; pass++) {
    for (let i = 1; i < n; i += 2) if (!syl[i].stress) syl[i].keep = false;
    for (let i = 2; i < n; i += 3) if (!syl[i].stress) syl[i].keep = false;
    if (pass === 2) for (let i = 0; i < n; i++) if (!syl[i].stress) syl[i].keep = false;
  }
  // Still over: truncate. A read that stops is a person interrupted; a read that
  // runs under the next line is two people talking over each other.
  if (count() / MAX_SYL_RATE > budget) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (!syl[i].keep) continue;
      acc += 1 / MAX_SYL_RATE;
      if (acc > budget) { n = i; break; }
    }
  }
  if (!count()) return null;
  // Seconds per unit of syllable weight, solved so the read lands exactly on
  // `kept / effRate` seconds with the punctuation gaps taken out of the middle.
  const effRate = Number.isFinite(budget)
    ? clamp(kept / budget, rate, MAX_SYL_RATE) : rate;
  let weight = 0, gaps = 0;
  for (let i = 0; i < n; i++) {
    if (!syl[i].keep) continue;
    weight += syl[i].stress ? 1.28 : 0.88;
    gaps += syl[i].gap;
  }
  const unit = Math.max((kept / effRate - gaps) / Math.max(weight, 1e-3), 0.055);

  /* ---- source ------------------------------------------------------- */
  const dr = V.drive ?? 1;
  const tract = V.tract ?? 1;
  const f0 = V.f0 ?? 110;
  const level = o.level ?? 1;
  // `o.articulation` exists for one caller only: duckprobe's negative control,
  // which renders the pre-fix consonant level through this same code path so
  // section 2c's metric is shown to move with the thing it claims to measure.
  const art = Number.isFinite(o.articulation) ? o.articulation : ARTICULATION;
  const out = gain(actx, LINE_TRIM);
  const sources = [];

  const src = actx.createOscillator();
  // The warm end of the tilt range on purpose: talk, never a shout. `bark`
  // straddles 1.45-1.9 with effort; a spoken line lives at the top of that.
  src.setPeriodicWave(glottalWave(actx, clamp(1.88 - 0.22 * (dr - 1), 1.62, 1.92)));
  const srcGain = gain(actx, 0.0001);
  src.connect(srcGain);
  sources.push(src);

  // Same three-LFO larynx as a bark: without it the pitch is a held note and
  // the whole thing collapses back into a synthesiser.
  const lfoEnd = t0 + kept / effRate + 1.0;
  for (const [hz, depth] of [[rng.range(4.4, 5.6), 0.011], [rng.range(0.6, 1.2), 0.013],
    [rng.range(8.5, 12.5), 0.004]]) {
    const l = actx.createOscillator();
    l.type = 'sine';
    l.frequency.value = hz;
    const lg = gain(actx, f0 * depth);
    l.connect(lg);
    lg.connect(src.frequency);
    l.start(t0);
    l.stop(lfoEnd);
    sources.push(l);
  }

  const breath = (V.breath ?? 0.18) * rng.range(0.85, 1.2);
  // LOOPED, unlike the bark's: a chapter line runs past the noise bank's 2.4 s
  // buffer, and a one-shot source simply stops breathing halfway through.
  const noise = bank.source('white', rng, rng.range(0.9, 1.15), true);
  const noiseBP = biquad(actx, 'bandpass', 1500, 0.55);
  const noiseGain = gain(actx, 0.0001);
  series(noise, noiseBP, noiseGain);
  sources.push(noise);

  const excite = gain(actx, 1);
  srcGain.connect(excite);
  noiseGain.connect(excite);

  /* ---- formant bank -------------------------------------------------- */
  const first = VOWELS[syl[0].v] ?? VOWELS.a;
  const fs = [];
  for (let i = 0; i < 3; i++) {
    const f = first[i] * tract;
    // Sharper than the shout: a quiet voice has clear vowels, and clarity is
    // what keeps a low-level read intelligible as a VOICE without raising it.
    const bp = biquad(actx, 'bandpass', f, clamp((f / first[i + 3]) * 1.35, 1.5, 14));
    const g = gain(actx, [1.0, 0.52, 0.22][i]);
    excite.connect(bp);
    bp.connect(g);
    fs.push({ bp, g });
  }
  {
    const f4 = clamp(3350 * tract, 2600, 4200);
    const bp = biquad(actx, 'bandpass', f4, f4 / 360);
    const g = gain(actx, 0.26);
    excite.connect(bp);
    bp.connect(g);
    fs.push({ bp, g });
  }

  /* ---- tract output -------------------------------------------------- */
  /*
   * THE EQ IS AN INTELLIGIBILITY CHAIN, not a warmth chain, and it used to be
   * the other way round. Shipped: +4.4 dB of chest at 450 Hz, +0.9 dB of
   * presence, a 115 Hz high-pass and a 4.3 kHz lowpass — a curve that piles
   * energy exactly where speech is masked (the 300-500 Hz mud) and takes it out
   * of the two bands consonants live in. Every move below is the same move a
   * dialogue engineer makes to a boom track:
   *
   *   high-pass 115 -> 180 Hz   nothing under the first formant is speech; it
   *                             is chest rumble, and it is what makes a read
   *                             sound like it is coming through a wall.
   *   throat 4.4 -> 1.8 dB      the low-mid mud. Carson still reads as Carson —
   *                             the larynx (f0 92 Hz, tract 1.06) is what makes
   *                             him him, not a peaking filter at 450 Hz.
   *   presence 2450 -> 2900 Hz, +0.9 -> +3.6 dB   the consonant band. A shout's
   *                             is 4-5 dB at 2.55 kHz and reads as a tannoy at
   *                             a metre; this is under that and it is what
   *                             makes the bursts above legible rather than
   *                             merely present.
   *   lowpass 4300 -> 5600 Hz   a fricative is 4-6 kHz. Rolling it off at 4.3k
   *                             removed the top half of every /s/ and /f/ in
   *                             the line.
   */
  const throat = biquad(actx, 'peaking', 450, 1.0, 1.8);
  const presence = biquad(actx, 'peaking', 2900, 1.0, clamp(dr * 2.4 + 1.5, 2.6, 4.6));
  const hp = biquad(actx, 'highpass', 180, 0.7);
  const lp = biquad(actx, 'lowpass', 5600, 0.7);
  const drv = shaper(actx, saturationCurve(0.85 * dr, 0.22), '2x');
  const body = gain(actx, 1.5 * level);
  for (const f of fs) f.g.connect(throat);
  series(throat, presence, hp, lp, drv, body).connect(out);

  /* ---- the read ------------------------------------------------------ */
  const rising = syl[n - 1]?.rise === true;
  let t = t0;
  let idx = 0;
  src.frequency.setValueAtTime(f0, t0);
  for (let i = 0; i < n; i++) {
    const s = syl[i];
    if (!s.keep) continue;
    const v = VOWELS[s.v] ?? VOWELS.a;
    const d = (s.stress ? 1.28 : 0.88) * unit;
    const amp = (s.stress ? 0.46 : 0.29) * level;
    const u = kept > 1 ? idx / (kept - 1) : 0;
    // Declination: a phrase drifts DOWN. A flat baseline across a sentence is
    // the single loudest robot tell there is.
    const decl = 1 - 0.13 * u;
    const term = i === n - 1 ? (rising ? 1.14 : 0.86) : 1;
    const pitch = f0 * decl * (s.stress ? 1.07 : 0.97) * term;

    if (s.on) {
      const ct = Math.max(t - (s.on === 'f' ? 0.045 : 0.014), 0);
      const cs = bank.source('white', rng, rng.range(0.9, 1.25));
      const cbp = biquad(actx, s.on === 'f' ? 'bandpass' : 'highpass',
        s.on === 'f' ? rng.range(3600, 6000) : rng.range(1300, 2400),
        s.on === 'f' ? 1.1 : 0.7);
      const cg = gain(actx, 0);
      series(cs, cbp, cg).connect(out);
      sources.push(cs);
      const a = art * level;
      if (s.on === 'f') { ad(cg.gain, ct, 0.1 * a, 0.012, 0.05); cs.start(ct, cs._offset, 0.12); }
      else if (s.on === 'n') { ad(cg.gain, ct, 0.02 * a, 0.01, 0.04); cs.start(ct, cs._offset, 0.08); }
      else { hit(cg.gain, ct, 0.16 * a, 0.014); cs.start(ct, cs._offset, 0.05); }
    }

    for (let k = 0; k < 3; k++) {
      const f = v[k] * tract * (1 + rng.range(-0.018, 0.018));
      fs[k].bp.frequency.setTargetAtTime(f, Math.max(t - 0.035, t0), 0.018);
      fs[k].bp.Q.setTargetAtTime(clamp((f / v[k + 3]) * 1.35, 1.5, 14), Math.max(t - 0.035, t0), 0.024);
    }
    src.frequency.setTargetAtTime(pitch, t, 0.035);
    src.frequency.setTargetAtTime(pitch * 0.95, t + d * 0.62, 0.06);

    /*
     * THE ENVELOPE IS THE RHYTHM, and the rhythm is what makes a listener hear
     * a person rather than a hum. MEASURED on the rendered read (the modulation
     * spectrum of the amplitude envelope, which is the standard speech
     * signature): a 0.55 inter-syllable dip with no stop closures gave 10 dB of
     * modulation depth and 93% of the read voiced — a legato drone with slow
     * swells. Real speech modulates 15-25 dB and is ~70-85% voiced, because
     * every /p/, /t/ and /k/ is a SILENCE before a burst. So: a deeper dip
     * inside the word, a real closure before a plosive, and a proper stop at a
     * word boundary. None of it makes the read more word-like — the vowels are
     * unchanged — it only makes the rhythm human, which is the half of speech
     * this register is actually trying to deliver.
     */
    to(srcGain.gain, amp, t, 0.02);
    to(noiseGain.gain, amp * breath, t, 0.02);
    to(srcGain.gain, amp * 0.34, t + d * 0.62, 0.03);
    if (s.gap > 0.05) {
      to(srcGain.gain, 0.0001, t + d, 0.016);
      to(noiseGain.gain, 0.0001, t + d, 0.024);
    }
    // The stop closure for the NEXT syllable, if it opens on a plosive and
    // there is room for it without eating this vowel.
    const next = i + 1 < n ? syl[i + 1] : null;
    const shut = t + d + s.gap - 0.035;
    if (next && next.keep && next.on === 'p' && shut > t + d * 0.5) {
      to(srcGain.gain, 0.0001, shut, 0.010);
      to(noiseGain.gain, 0.0001, shut, 0.012);
    }
    t += d + s.gap;
    idx++;
  }
  to(srcGain.gain, 0.0001, t, 0.05);
  to(noiseGain.gain, 0.0001, t, 0.05);

  const end = t + 0.28;
  const start = Math.max(t0 - 0.01, 0);
  src.start(start);
  src.stop(end);
  noise.start(start, noise._offset);
  noise.stop(end);

  /* ---- speaker treatment (dispatch, a voice on the radio) ------------ */
  if (o.radio ?? V.radio) {
    const rout = gain(actx, 1);
    const rhp = biquad(actx, 'highpass', 440, 0.8);
    const rlp = biquad(actx, 'lowpass', 3000, 0.9);
    const rdrv = shaper(actx, saturationCurve(5, 0.28), '2x');
    series(out, rhp, rlp, rdrv, gain(actx, 1.15)).connect(rout);
    // A dispatch voice arrives out of a speaker in the car with you. It has no
    // business having a street on it at all; 0.02 is a hint of the cabin.
    return { node: rout, end: end + 0.1, send: 0.02, sources };
  }
  /*
   * DRY. Not nearly dry — DRY — and this is the single largest quality lever in
   * the whole read. A bark is a shout across a street and wants the room (0.45);
   * a story line is a man talking to you.
   *
   * MEASURED, envelope modulation depth of the rendered line — the property that
   * separates "a person talking" from "a hum with swells", and the thing the
   * shared 2.8 s street/open convolution destroys by filling every stop closure:
   *
   *     send 0.15 -> 10.3 dB modulation, 89% of the line voiced
   *     send 0.06 -> 13.2 dB,            85%
   *     send 0.035-> 15.9 dB,            80%   <- real speech is 15-25 dB, 70-85%
   *     dry (0)   -> 21.6 dB,            76%
   *
   * The rhythm work in the envelope above was worth 0 dB until this came down:
   * the closures were all there and the room was filling them back in.
   *
   * IT WENT ALL THE WAY DOWN when the owner played it: "the voices are muffled
   * and ECHO — cannot understand speech". 0.035 is a small number and it was
   * still a 2.8 s convolution smeared across every stop closure and every
   * consonant burst in the line, i.e. across exactly the events section 2c of
   * duckprobe now measures. The table above already said what to do and the
   * previous pass stopped one row short of it. A voice in a cutscene does not
   * need a room: the character is talking to the player, not shouting down a
   * street, and the ROOM the player is standing in is already on every other
   * bus. Nothing else in this subsystem is fully dry, and that is the point.
   */
  return { node: out, end: end + 0.1, send: 0, sources };
}

/**
 * How far each bus is pushed down while a story line is sounding, as a fraction
 * of gain reduction. This — not the voice's own trim — is the lever that makes
 * a line audible, because the voice bus compressor caps how loud a read can get
 * before it stops sounding like speech (see LINE_TRIM).
 *
 * ASKED FOR AND HEARD ARE NOT THE SAME NUMBER, and the gap is the point of
 * measuring the emitted radio rather than the gain: the music bus has its own
 * compressor (-15 dBFS, 2.6:1, 0.3 s release), which gives back gain as soon as
 * the duck takes it away. Asking for -9 dB (0.645) produced a MEASURED 6.6 dB
 * drop at the output; 0.82 asks for -14.9 dB and produces a measured 12.4 dB,
 * which is what puts the read 8.2 dB clear of the bed. The rest are scaled from
 * it so the whole bed moves together rather than the radio alone stepping down.
 */
export const DIALOGUE_DUCK = { music: 0.82, ambience: 0.70, foley: 0.45, vehicles: 0.38 };
/** The line stops over this long on a skip, a pause or a replacement. */
const CUT_FADE = 0.07;

/**
 * ONE story line at a time, its side-chain, and its teardown.
 *
 * Split out of `AudioSystem` so the whole of it — voicing, ducking, stopping,
 * the start/end callbacks — can be driven against a real `Mixer` on an
 * OfflineAudioContext and MEASURED (`src/audio/duckprobe.mjs`). What stays in
 * `src/audio/index.js` is only the glue: where the line comes from and which
 * event it raises. That boundary is named in the probe's header, because a stub
 * is an assertion that nothing downstream of it can be wrong.
 *
 * THE DUCK IS RE-ASSERTED EVERY FRAME rather than held. `Mixer.duckBus` only
 * ever deepens a duck and `Mixer.update` is the only thing that releases one, so
 * "hold it down for exactly this long" is not expressible; "keep asking while
 * the line sounds, stop asking the instant it does not" is, and it releases on
 * the mixer's own 400 ms recovery whether the line ended, was skipped, or was
 * cut off by a pause. Call order matters and is the caller's job: `mixer.update`
 * first, then this — the re-assert has to land after the decay, or the bed
 * ripples at frame rate.
 */
export class DialogueVoice {
  /**
   * @param {object} opts { duck } — `duck: false` is the negative control the
   *   probe runs against the LIVE code with no edit, same pattern as the pause
   *   gates' `debugIgnorePause`.
   */
  constructor(actx, bank, mixer, rng, opts = {}) {
    this.actx = actx;
    this.bank = bank;
    this.mixer = mixer;
    this.rng = rng;
    this.duckEnabled = opts.duck !== false;
    this.bus = opts.bus ?? 'voice';
    /** Called with the reused records below — read them, never retain them. */
    this.onStart = null;
    this.onEnd = null;

    this.out = gain(actx, 1);
    this.out.connect(mixer.bus(this.bus));
    this._send = gain(actx, 0);
    this.out.connect(this._send);
    this._send.connect(mixer.busSend(this.bus));

    /** The live line. `gate` is its own fader so a skip can cut it mid-word. */
    this._live = null;
    this._gate = null;
    this._sources = null;
    this._end = 0;
    this._kill = 0;
    this._syl = [];
    /** Retired graphs still fading out. Drained in `update`, never in `stop`. */
    this._dead = [];
    this.id = '';
    this.lines = 0;

    /* Reused payloads — `update` runs every frame and allocates nothing. */
    this._startRec = { id: '', text: '', dur: 0, syllables: 0, source: '' };
    this._endRec = { id: '', reason: '' };
  }

  /** Is a line making sound right now? `bark` yields on this. */
  sounding(now = this.actx.currentTime) {
    return !!this._live && now < this._kill;
  }

  /**
   * Speak one line. Replaces whatever was speaking — one voice at a time is the
   * whole budget, and two overlapping reads is the failure mode that makes a
   * synthesised voice unlistenable.
   *
   * @param {string} id speaker id (see VOICES)
   * @param {string} text the authored line
   * @param {number} dur seconds the line is on screen; 0 = pace it naturally
   */
  speak(id, text, dur = 0, opts = {}) {
    const t = String(text ?? '');
    if (!t.trim()) return false;
    if (this._live) this.stop('replaced');
    const actx = this.actx;
    const when = actx.currentTime + 0.02;
    // Deterministic per line: a replayed chapter must sound the same, and rule 4
    // is about capture reproducibility, not just about Math.random.
    this.rng.seed?.(hashId(id + '|' + t));
    syllabify(t, this._syl);
    const v = voiceLine(actx, this.bank, this.rng, {
      when, text: t, id, voice: opts.voice, dur, level: opts.level ?? 1,
      syllables: this._syl, radio: opts.radio, articulation: opts.articulation,
    });
    if (!v) return false;

    this._gate = gain(actx, 1);
    v.node.connect(this._gate);
    this._gate.connect(this.out);
    this._send.gain.setValueAtTime(v.send ?? 0.2, actx.currentTime);
    this._live = v.node;
    this._sources = v.sources;
    this._end = v.end;
    this._kill = v.end;
    this.id = String(id ?? '');
    this.lines++;

    const r = this._startRec;
    r.id = this.id;
    r.text = t;
    r.dur = v.end - when;
    r.syllables = this._syl.length;
    r.source = opts.source ?? '';
    this.onStart?.(r);
    return true;
  }

  /**
   * Cut the line. Fades rather than disconnecting, because a hard stop on a
   * voiced vowel is a click, and a click is louder than the line was.
   */
  stop(reason = 'stopped') {
    if (!this._live) return false;
    const t = this.actx.currentTime;
    const off = t + CUT_FADE;
    try {
      this._gate.gain.cancelScheduledValues(t);
      this._gate.gain.setTargetAtTime(0.0001, t, CUT_FADE * 0.35);
      for (const s of this._sources) {
        try { s.stop(off); } catch { /* already stopped, or never started */ }
      }
    } catch { /* the graph is going away anyway */ }
    this._kill = Math.min(this._kill, off);
    this._end = Math.min(this._end, off);
    const r = this._endRec;
    r.id = this.id;
    r.reason = reason;
    // Detach BEFORE the callback: a listener may start the next line, and it
    // must not find this one still live and stop it recursively.
    this._retire(off);
    this.onEnd?.(r);
    return true;
  }

  /**
   * Hand the graph to the teardown pass, keeping it audible until `off`.
   * QUEUED rather than replaced: disconnecting a graph that is still fading is
   * a click, and two lines replaced inside one fade is exactly when it happens.
   */
  _retire(off) {
    if (this._live) this._dead.push({ node: this._live, gate: this._gate, at: off + 0.05 });
    this._live = null;
    this._gate = null;
    this._sources = null;
  }

  /**
   * Per frame. Allocates nothing.
   * @param {number} now `actx.currentTime` — the ONLY clock this runs on. A
   *   cutscene stops `time.scale`, and a story line has to play through it.
   */
  update(now = this.actx.currentTime) {
    while (this._dead.length && now >= this._dead[0].at) {
      const d = this._dead.shift();
      try { d.node.disconnect(); } catch { /* gone */ }
      try { d.gate.disconnect(); } catch { /* gone */ }
    }
    if (this._live && now >= this._end) {
      const r = this._endRec;
      r.id = this.id;
      r.reason = 'done';
      this._retire(now);
      this.onEnd?.(r);
    }
    if (!this.duckEnabled || !this.sounding(now)) return;
    const m = this.mixer;
    // hold 0: the mixer starts recovering the instant this stops being called.
    m.duckBus('music', DIALOGUE_DUCK.music, 0);
    m.duckBus('ambience', DIALOGUE_DUCK.ambience, 0);
    m.duckBus('foley', DIALOGUE_DUCK.foley, 0);
    m.duckBus('vehicles', DIALOGUE_DUCK.vehicles, 0);
  }

  dispose() {
    this.stop('dispose');
    for (const d of this._dead) {
      try { d.node.disconnect(); } catch { /* gone */ }
      try { d.gate.disconnect(); } catch { /* gone */ }
    }
    this._dead.length = 0;
    try { this.out.disconnect(); } catch { /* gone */ }
    try { this._send.disconnect(); } catch { /* gone */ }
    this.onStart = null;
    this.onEnd = null;
  }
}
