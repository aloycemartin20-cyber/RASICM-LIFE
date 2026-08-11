#!/usr/bin/env node
/**
 * AUDIO / STORY-DIALOGUE + SIDE-CHAIN GATE
 *
 * Twenty-four chapters of authored dialogue used to play in silence with the
 * car radio at full level. This gates the fix, and it gates it on the EMITTED
 * BUFFER rather than on the gain values the code set (ARCHITECTURE.md rule 12):
 * every number below is an RMS taken out of an OfflineAudioContext render of the
 * real graph, in a named time window.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT IS REAL IN HERE, AND WHAT IS NOT — because a stub is an assertion that
 * nothing downstream of it can be wrong, and that assertion belongs in writing.
 * ───────────────────────────────────────────────────────────────────────────
 * REAL, unmodified production code, all of it inside one render:
 *   src/audio/mixer.js      the buses, the side-chain and its release
 *   src/audio/radio.js      a real station, scheduled by its own Radio.update
 *   src/audio/vox.js        DialogueVoice + voiceLine — the read itself
 *   src/audio/index.js      AudioSystem._pollDialogue — the line-identity logic
 *   src/ui/mission.js       the REAL Cutscene and Subtitles players drive it
 *
 * STUBBED, and only this:
 *   - `ui.isPaused()` — one boolean. The pause ARBITER is gated by
 *     `pausearbiterprobe`; what matters here is what audio does with its answer.
 *   - `ctx.camera` / `ctx.time` / `ctx.input` — duck-typed so `Cutscene` can
 *     seize and orbit. Nothing measured passes through them.
 *   - the frame pump is this file's, at a fixed 32 ms tick, in the SAME ORDER
 *     `AudioSystem.update` uses: mixer first, then poll, then the voice.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROLS (a gate that has never failed is not evidence)
 * ───────────────────────────────────────────────────────────────────────────
 *   1. `duck: false` on DialogueVoice — the live switch, no edit — must make
 *      the radio-drop assertions RED.
 *   2. the mixer fed a FROZEN clock during the pause (what it got before this
 *      change: `time.scale` is 0 behind a menu, so the scaled dt is 0) must
 *      make the "the bed comes back while paused" assertion RED.
 *   3. the voice rendered with the master muted must be silent, against the
 *      same render un-muted, which must not be.
 *
 *   node src/audio/duckprobe.mjs
 *   node src/audio/duckprobe.mjs --wav=/tmp/dcb   # dump WAVs to listen to
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join, normalize } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const WAV_DIR = args.wav ? String(args.wav) : null;
if (WAV_DIR) mkdirSync(WAV_DIR, { recursive: true });

const SR = 48000;

/* ------------------------------------------------------------------ */
/* analysis (node side)                                                */
/* ------------------------------------------------------------------ */

/** Interleaved int16 base64 -> {L, R, mono, frames}. */
function decode(b64) {
  const raw = Buffer.from(b64, 'base64');
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const frames = pcm.length / 2;
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = (pcm[i * 2] + pcm[i * 2 + 1]) / 65536;
  return { mono, frames };
}

/** RMS in dBFS over [a, b) seconds. */
function db(sig, a, b) {
  const i0 = Math.max(0, Math.floor(a * SR));
  const i1 = Math.min(sig.length, Math.floor(b * SR));
  let s = 0;
  for (let i = i0; i < i1; i++) s += sig[i] * sig[i];
  const n = Math.max(1, i1 - i0);
  return 20 * Math.log10(Math.max(Math.sqrt(s / n), 1e-9));
}

function peak(sig, a = 0, b = 1e9) {
  const i0 = Math.max(0, Math.floor(a * SR));
  const i1 = Math.min(sig.length, Math.floor(b * SR));
  let p = 0;
  for (let i = i0; i < i1; i++) p = Math.max(p, Math.abs(sig[i]));
  return p;
}

function anyNaN(sig) {
  for (let i = 0; i < sig.length; i++) if (!Number.isFinite(sig[i])) return true;
  return false;
}

/**
 * How many times a second does the envelope open and close? This is the
 * SYLLABLE RATE of the emitted read, recovered from the buffer rather than
 * counted off the syllable table — the whole "does it gabble" question in one
 * number, and it is only meaningful because it is measured downstream.
 */
function syllableRate(sig, a, b) {
  const ds = 400;                       // envelope sample rate
  const step = Math.floor(SR / ds);
  const i0 = Math.floor(a * SR), i1 = Math.min(sig.length, Math.floor(b * SR));
  const env = [];
  for (let s = i0; s + step <= i1; s += step) {
    let e = 0;
    for (let i = 0; i < step; i++) e += Math.abs(sig[s + i]);
    env.push(e / step);
  }
  if (env.length < 20) return 0;
  // Smooth, then count rising crossings of 45% of the mean — one per opening.
  const sm = env.slice();
  for (let p = 0; p < 3; p++) {
    for (let i = 1; i < sm.length - 1; i++) sm[i] = (sm[i - 1] + sm[i] + sm[i + 1]) / 3;
  }
  let mean = 0;
  for (const v of sm) mean += v;
  mean /= sm.length;
  const thr = mean * 0.45;
  let n = 0;
  for (let i = 1; i < sm.length; i++) if (sm[i - 1] <= thr && sm[i] > thr) n++;
  return n / ((b - a));
}

/** Amplitude envelope at 200 Hz over [a, b). */
function envelope(sig, a, b) {
  const step = Math.floor(SR / 200);
  const i0 = Math.floor(a * SR), i1 = Math.min(sig.length, Math.floor(b * SR));
  const e = [];
  for (let s = i0; s + step <= i1; s += step) {
    let v = 0;
    for (let i = 0; i < step; i++) v += Math.abs(sig[s + i]);
    e.push(v / step);
  }
  return e;
}

/**
 * ENVELOPE MODULATION DEPTH, dB. The property that separates a person talking
 * from a hum with swells: every stop consonant is a SILENCE, so speech swings
 * 15-25 dB between its loud and quiet moments inside a single utterance, while
 * a drone or a compressed music bed barely moves. p90 over p15 of the envelope.
 */
function modDepth(env) {
  const v = env.filter((x) => x > 0).sort((a, b) => a - b);
  if (v.length < 20) return 0;
  return 20 * Math.log10(v[Math.floor(v.length * 0.9)] / Math.max(v[Math.floor(v.length * 0.15)], 1e-9));
}

/** Fraction of the window above 12% of its peak — speech leaves real gaps. */
function voicedFraction(env) {
  let pk = 0;
  for (const v of env) pk = Math.max(pk, v);
  if (pk <= 0) return 0;
  let n = 0;
  for (const v of env) if (v > pk * 0.12) n++;
  return n / env.length;
}

/**
 * Peak of the envelope's modulation spectrum, Hz. Human speech peaks hard at
 * 3-6 Hz — that IS the syllable rate — and it is the most robust "this is
 * speech" signature there is. Searched from 2 Hz so the utterance's own
 * on/off shape cannot masquerade as the syllable rhythm.
 */
function modPeak(env, lo = 2, hi = 12) {
  const n = env.length;
  if (n < 40) return 0;
  let mean = 0;
  for (const v of env) mean += v;
  mean /= n;
  let best = 0, bestHz = 0;
  for (let hz = lo; hz <= hi; hz += 0.1) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      const ph = (2 * Math.PI * hz * i) / 200;
      re += (env[i] - mean) * w * Math.cos(ph);
      im += (env[i] - mean) * w * Math.sin(ph);
    }
    const m = Math.hypot(re, im);
    if (m > best) { best = m; bestHz = hz; }
  }
  return bestHz;
}

/** Spectral centroid over the loud frames — brightness, i.e. buzz. */
function centroid(sig, a, b) {
  const N = 2048;
  const i0 = Math.floor(a * SR), i1 = Math.min(sig.length, Math.floor(b * SR));
  const re = new Float64Array(N), im = new Float64Array(N);
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let s = i0; s + N <= i1; s += N) {
    let e = 0;
    for (let i = 0; i < N; i++) e += sig[s + i] * sig[s + i];
    if (Math.sqrt(e / N) < 0.004) continue;
    for (let i = 0; i < N; i++) {
      re[i] = sig[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (!frames) return 0;
  let num = 0, den = 0;
  for (let k = 1; k < N / 2; k++) {
    const p = (acc[k] / frames) ** 2;
    num += p * k * (SR / N);
    den += p;
  }
  return den > 1e-14 ? num / den : 0;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** Fundamental via autocorrelation over a voiced window. */
function f0(sig, a, b, loHz = 65, hiHz = 320) {
  const i0 = Math.floor(a * SR), i1 = Math.min(sig.length, Math.floor(b * SR));
  const loLag = Math.floor(SR / hiHz), hiLag = Math.ceil(SR / loHz);
  let best = 0, bestLag = 0;
  for (let lag = loLag; lag <= hiLag; lag++) {
    let s = 0;
    for (let i = i0 + hiLag; i < i1; i += 2) s += sig[i] * sig[i - lag];
    if (s > best) { best = s; bestLag = lag; }
  }
  return bestLag ? SR / bestLag : 0;
}

function writeWav(path, mono) {
  const pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i++) pcm[i] = Math.max(-1, Math.min(1, mono[i])) * 32767;
  const bytes = pcm.length * 2;
  const buf = Buffer.alloc(44 + bytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + bytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(bytes, 40);
  for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i], 44 + i * 2);
  writeFileSync(path, buf);
}

/* ------------------------------------------------------------------ */
/* in-page render                                                      */
/* ------------------------------------------------------------------ */

const PAGE = `window.__RENDER__ = async (opts) => {
  const { Rng } = await import('/src/core/rng.js');
  const { NoiseBank } = await import('/src/audio/dsp.js');
  const { Mixer } = await import('/src/audio/mixer.js');
  const { SpatialField } = await import('/src/audio/spatial.js');
  const { Radio } = await import('/src/audio/radio.js');
  const { DialogueVoice } = await import('/src/audio/vox.js');
  const { AudioSystem } = await import('/src/audio/index.js');
  const { Subtitles } = await import('/src/ui/mission.js');

  const SR = 48000;
  const seconds = opts.seconds ?? 10;
  const actx = new OfflineAudioContext(2, Math.ceil(SR * seconds), SR);
  const rng = new Rng(4242);
  const bank = new NoiseBank(actx, rng.fork(), 2.0);
  const mixer = new Mixer(actx, rng.fork(), {});
  mixer.buildReverbs();
  mixer.setSpace({ tight: 0, room: 0.1, street: 0.4, tunnel: 0, open: 0.3 }, 0.001);
  const field = new SpatialField(actx, mixer, null);
  field.occlusionEnabled = false;
  field.setListener(0, 1.6, 0, 0, 0, -1, 0, 1, 0, 0);

  let radio = null;
  if (opts.radio !== false) {
    radio = new Radio(actx, bank, mixer, field, rng.fork());
    radio.setRotation([opts.station ?? 'furnace']);
    radio.setCabin(1, 0.001);
    radio.tune(opts.station ?? 'furnace');
  }

  const vox = new DialogueVoice(actx, bank, mixer, rng.fork(), { duck: opts.duck !== false });

  /* ---- the real poller, over the real UI players -------------------- */
  const host = document.createElement('div');
  host.className = 'ow-hud';
  document.body.appendChild(host);
  const subs = new Subtitles(host);
  let paused = false;
  const events = [];
  const fakeUi = { subs, isPaused: () => paused, setHudVisible() {}, hudTarget: 1 };
  const camera = {
    fov: 60, position: { x: 0, y: 2, z: 8, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    lookAt() {}, updateProjectionMatrix() {}, updateMatrixWorld() {},
  };
  const fakeCtx = {
    camera,
    time: { scale: 1, raw: 0, dt: 0 },
    input: { enabled: true },
    events: { emit: (type, p) => events.push({ type, id: p.id, reason: p.reason, t: actx.currentTime }) },
    peek: (id) => (id === 'ui' ? fakeUi : null),
  };
  const sys = new AudioSystem();
  sys.ctx = fakeCtx;
  sys.actx = actx;
  sys.mixer = mixer;
  sys.field = field;
  sys.rng = rng.fork();
  sys.running = true;
  sys.vox = vox;
  vox.onStart = sys._onDlgStart;
  vox.onEnd = sys._onDlgEnd;

  if (opts.mute) mixer.setMasterVolume(0);
  if (opts.voiceOff) mixer.setBusVolume('voice', 0);

  /* ---- pump --------------------------------------------------------- */
  const TICK = (128 * 12) / SR;
  const steps = Math.floor(seconds / TICK);
  const pending = [];
  for (let i = 1; i < steps; i++) pending.push({ t: i * TICK, p: actx.suspend(i * TICK) });
  const script = (opts.script ?? []).map((s) => ({ ...s, done: false }));
  const barkYield = [];
  const rendered = actx.startRendering();
  for (const s of pending) {
    await s.p;
    const now = actx.currentTime;
    for (const a of script) {
      if (a.done || now < a.t) continue;
      a.done = true;
      if (a.cut) subs.cut.play(a.cut, { ctx: fakeCtx, ui: fakeUi, context: 'probe', onDone() {} });
      if (a.say) subs.push(a.say[0], a.say[1]);
      if (a.speak) vox.speak(a.speak[0], a.speak[1], a.speak[2] ?? 0, { source: 'probe' });
      if (a.pause !== undefined) paused = a.pause;
      if (a.skipAll) subs.cut.skipAll();
      if (a.bark) {
        const before = sys.stats.barksYielded;
        sys.bark('spot', null, {});
        barkYield.push({ t: now, yielded: sys.stats.barksYielded > before });
      }
    }
    subs.update(TICK);
    fakeCtx.time.raw += TICK;
    radio?.update(TICK);
    // The mixer's clock. Production feeds it the AUDIO clock; the negative
    // control feeds it the SCALED frame dt, which is 0 behind a pause.
    mixer.update(opts.frozenWhilePaused && paused ? 0 : TICK);
    sys._pollDialogue();
    vox.update(now);
    actx.resume();
  }
  const buf = await rendered;
  subs.dispose();
  host.remove();

  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const pcm = new Int16Array(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    pcm[i * 2] = Math.max(-1, Math.min(1, L[i])) * 32767;
    pcm[i * 2 + 1] = Math.max(-1, Math.min(1, R[i])) * 32767;
  }
  let bin = '';
  const bytes = new Uint8Array(pcm.buffer);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return { pcm: btoa(bin), events, barkYield, lines: vox.lines };
};
window.__READY__ = true;`;

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

// One 55-character line: 14 syllables, 3.5 s of read at Carson's 4.0 syl/s.
const LINE = 'Every time it rains in this town I think of the bridge.';
const T_SPEAK = 2.0;
/* Windows, in seconds of the render. DURING is inside the read and past the
   80 ms attack; BASE is before it. AFTER is derived from the EMITTED
   `dialogue:end` rather than written down — a window guessed from the line
   length silently overlapped the read's tail and measured the duck as a failure
   to recover, which is a probe bug that looks exactly like a mix bug. */
const DURING = [2.5, 4.5];
const BASE = [0.9, 1.9];
const afterOf = (r) => {
  const e = r.events.filter((x) => x.type === 'dialogue:end').pop();
  const t = e ? e.t : T_SPEAK + 4;
  return [t + 1.0, t + 2.4];
};

/* RATCHETs (rule 13) — measured values are printed by every run. Lower a floor
   when you improve the mix; never raise one to make a run go green. */
const DUCK_MIN_DB = 6.0;     // the radio must drop at least this far under a line
const RECOVER_MAX_DB = 1.2;  // and come back to within this of where it was
const VOICE_FLOOR_DB = -45;  // the read has to be audible at all
const VOICE_OVER_BED_DB = 3.0; // and sit this far above the ducked bed
const SILENT_DB = -60;       // muted / stopped means silent
const SYL_RATE_MAX = 6.2;    // a read faster than this is a gabble, not a person
const SYL_RATE_MIN = 2.0;
const CENTROID_MAX = 900;    // brighter than this is a tannoy, not talk
/* Does it sound like a PERSON? Three numbers off the emitted envelope, against
   the published range for real speech (15-25 dB, 70-85% voiced, 3-6 Hz). All
   three are RATCHETs recording where this got to: measured 15.9 dB / 80% /
   2.9-5.4 Hz. The version before the dry-send and stop-closure work measured
   9.9 dB and 92-93% voiced — a legato drone — which is the demonstrated red. */
const MOD_DEPTH_MIN = 13;
const VOICED_MAX = 0.88;
const MOD_HZ = [2.0, 8.0];

/*
 * A PLAIN STATIC SERVER over the repo, not the dev server, and a blank page
 * rather than `index.html`. Everything under src/audio, src/ui and src/core is
 * dependency-free relative ESM that a browser loads directly, so no bundler is
 * involved — and booting the actual game instead cost 15 s of engine start plus
 * a rendering city that starved the render pump: the same 125-step pump measured
 * 0.23 s here and 120 s behind a live main.js. Same reason src/audio/probe.mjs
 * serves dist/ rather than sharing a vite: a probe should not be racing whatever
 * else the machine is drawing.
 */
const ROOT = resolve(import.meta.dirname, '../..');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };
const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><meta charset=utf8><title>duck gate</title><body></body>');
    return;
  }
  const path = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
const port = await new Promise((d) => server.listen(0, '127.0.0.1', () => d(server.address().port)));
const stopServer = (s) => s.close();
const browser = await chromium.launch({
  headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

let pass = 0, fail = 0;
const say = (ok, msg) => { console.log(`  [${ok ? 'OK ' : 'RED'}] ${msg}`); ok ? pass++ : fail++; };

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ content: PAGE, type: 'module' });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 60000 });

  const render = async (opts) => {
    const r = await page.evaluate((o) => window.__RENDER__(o), opts);
    const { mono } = decode(r.pcm);
    return { ...r, sig: mono };
  };

  const speakScript = [{ t: T_SPEAK, speak: ['carson', LINE, 0] }];

  /* ================================================================= */
  console.log('\n=== 1. THE SIDE-CHAIN, measured on the emitted radio ===\n');
  // The voice bus is muted in both arms, so the ONLY thing in the buffer is the
  // radio: the number is the bed's own level, never the sum of bed and line.
  const base = await render({ voiceOff: true });
  const duck = await render({ voiceOff: true, script: speakScript });
  const nc1 = await render({ voiceOff: true, script: speakScript, duck: false });
  // Every arm uses the SAME window, taken from the ducked arm's own end event,
  // so the three numbers are comparable bar for bar of the same station.
  const AFTER = afterOf(duck);

  const row = (name, r) => {
    const b = db(r.sig, ...BASE), d = db(r.sig, ...DURING), a = db(r.sig, ...AFTER);
    console.log(`  ${name.padEnd(16)} before ${b.toFixed(1)}  during ${d.toFixed(1)}  after ${a.toFixed(1)} dBFS`);
    return { b, d, a };
  };
  console.log(`  windows: base ${BASE[0]}-${BASE[1]}s  during ${DURING[0]}-${DURING[1]}s  after ${AFTER[0].toFixed(1)}-${AFTER[1].toFixed(1)}s\n`);
  const rb = row('radio only', base);
  const rd = row('radio + line', duck);
  const rn = row('NC duck:false', nc1);

  const drop = rb.d - rd.d;
  const resid = Math.abs(rb.a - rd.a);
  const ncDrop = rb.d - rn.d;
  console.log('');
  say(drop >= DUCK_MIN_DB, `the radio drops under the line (${drop.toFixed(1)} dB >= ${DUCK_MIN_DB})`);
  say(resid <= RECOVER_MAX_DB, `and is back where it was 1 s later (${resid.toFixed(1)} dB <= ${RECOVER_MAX_DB})`);
  say(ncDrop < 2.0, `NEGATIVE CONTROL duck:false leaves it up (${ncDrop.toFixed(1)} dB < 2.0) — the gate has teeth`);
  if (WAV_DIR) writeWav(`${WAV_DIR}/duck_radio.wav`, duck.sig);

  /* ================================================================= */
  console.log('\n=== 2. THE READ ITSELF ===\n');
  const voice = await render({ radio: false, script: speakScript });
  const muted = await render({ radio: false, script: speakScript, mute: true });
  const vDb = db(voice.sig, ...DURING);
  const vPeak = peak(voice.sig);
  const rate = syllableRate(voice.sig, T_SPEAK, T_SPEAK + 3.2);
  const cen = centroid(voice.sig, T_SPEAK, T_SPEAK + 3.2);
  const pitch = f0(voice.sig, T_SPEAK + 0.3, T_SPEAK + 1.0);
  console.log(`  read      ${vDb.toFixed(1)} dBFS  peak ${vPeak.toFixed(3)}  ${rate.toFixed(1)} syl/s  centroid ${cen.toFixed(0)} Hz  f0 ${pitch.toFixed(0)} Hz`);
  console.log(`  muted     ${db(muted.sig, ...DURING).toFixed(1)} dBFS`);
  console.log(`  tail      ${db(voice.sig, ...AFTER).toFixed(1)} dBFS (the read is over)`);
  console.log('');
  say(!anyNaN(voice.sig), 'the read contains no NaN');
  say(vDb > VOICE_FLOOR_DB, `the read is audible (${vDb.toFixed(1)} dBFS > ${VOICE_FLOOR_DB})`);
  say(vPeak < 0.999, `and does not clip (peak ${vPeak.toFixed(3)} < 0.999)`);
  say(rate >= SYL_RATE_MIN && rate <= SYL_RATE_MAX,
    `it is paced like a person, not a gabble (${rate.toFixed(1)} syl/s in [${SYL_RATE_MIN}, ${SYL_RATE_MAX}])`);
  say(cen > 0 && cen < CENTROID_MAX, `and warm, not a tannoy (centroid ${cen.toFixed(0)} Hz < ${CENTROID_MAX})`);
  say(db(muted.sig, ...DURING) <= SILENT_DB,
    `MUTE kills it (${db(muted.sig, ...DURING).toFixed(1)} dBFS <= ${SILENT_DB}, against ${vDb.toFixed(1)} un-muted)`);
  const overBed = vDb - rd.d;
  say(overBed >= VOICE_OVER_BED_DB,
    `the line sits above the ducked bed (${overBed.toFixed(1)} dB >= ${VOICE_OVER_BED_DB})`);
  if (WAV_DIR) writeWav(`${WAV_DIR}/duck_voice.wav`, voice.sig);

  /* ================================================================= */
  console.log('\n=== 2b. DOES IT SOUND LIKE A PERSON? (emitted envelope) ===\n');
  const vEnd = afterOf(voice)[0] - 1.0;
  const vEnv = envelope(voice.sig, T_SPEAK + 0.05, vEnd - 0.35);
  const vDepth = modDepth(vEnv), vVoiced = voicedFraction(vEnv), vHz = modPeak(vEnv);
  // The SAME three numbers on the radio bed. Music is not speech, and a metric
  // that cannot tell them apart is measuring nothing — this is what makes the
  // three thresholds above mean something rather than merely pass.
  const mEnv = envelope(base.sig, ...DURING);
  const mDepth = modDepth(mEnv), mVoiced = voicedFraction(mEnv);
  console.log(`  the read   modulation ${vDepth.toFixed(1)} dB   voiced ${(vVoiced * 100).toFixed(0)}%   rhythm ${vHz.toFixed(1)} Hz`);
  console.log(`  the music  modulation ${mDepth.toFixed(1)} dB   voiced ${(mVoiced * 100).toFixed(0)}%`);
  console.log('  (real speech: 15-25 dB, 70-85% voiced, 3-6 Hz)\n');
  say(vDepth >= MOD_DEPTH_MIN,
    `the read has speech-shaped dynamics (${vDepth.toFixed(1)} dB >= ${MOD_DEPTH_MIN})`);
  say(vVoiced <= VOICED_MAX,
    `it leaves real gaps rather than droning (${(vVoiced * 100).toFixed(0)}% <= ${VOICED_MAX * 100}%)`);
  say(vHz >= MOD_HZ[0] && vHz <= MOD_HZ[1],
    `and a human syllable rhythm (${vHz.toFixed(1)} Hz in ${MOD_HZ[0]}-${MOD_HZ[1]})`);
  say(mDepth < MOD_DEPTH_MIN || mVoiced > VOICED_MAX,
    `NEGATIVE CONTROL the music bed fails the same test (${mDepth.toFixed(1)} dB, ${(mVoiced * 100).toFixed(0)}% voiced) — the metric discriminates`);

  /* ================================================================= */
  console.log('\n=== 3. PAUSE: the line stops, the bed comes back, nothing doubles ===\n');
  // The pause lands 1.2 s into a 3 s read, and is lifted 2 s later with the same
  // line still on screen — which is exactly the shape that produces a second
  // read if the poller resets its identity.
  const pauseScript = [
    { t: T_SPEAK, speak: ['carson', LINE, 0] },
    { t: T_SPEAK + 1.2, pause: true },
    { t: T_SPEAK + 3.2, pause: false },
  ];
  const paused = await render({ radio: false, script: pauseScript });
  const pausedBed = await render({ voiceOff: true, script: pauseScript });
  const ncFrozen = await render({ voiceOff: true, script: pauseScript, frozenWhilePaused: true });

  const cut = T_SPEAK + 1.2;
  const beforeCut = db(paused.sig, cut - 0.5, cut);
  const afterCut = db(paused.sig, cut + 0.3, cut + 1.0);
  // The read stops on a 70 ms fade, but its REVERB does not and must not — a
  // room cut off mid-tail is a louder artefact than the line was. So the stop is
  // proved twice: a hard drop immediately, and real silence once the tail dies.
  const tail = db(paused.sig, cut + 2.6, cut + 3.6);
  const bedPaused = db(pausedBed.sig, cut + 0.9, cut + 1.9);
  const bedFrozen = db(ncFrozen.sig, cut + 0.9, cut + 1.9);
  const bedRef = db(pausedBed.sig, ...BASE);
  console.log(`  read before the pause ${beforeCut.toFixed(1)} dBFS -> after ${afterCut.toFixed(1)} dBFS -> tail ${tail.toFixed(1)}`);
  console.log(`  bed while paused      ${bedPaused.toFixed(1)} dBFS (unducked reference ${bedRef.toFixed(1)})`);
  console.log(`  bed, NC frozen clock  ${bedFrozen.toFixed(1)} dBFS`);
  const starts = paused.events.filter((e) => e.type === 'dialogue:start');
  const ends = paused.events.filter((e) => e.type === 'dialogue:end');
  console.log(`  events: ${paused.events.map((e) => e.type.replace('dialogue:', '') + (e.reason ? ':' + e.reason : '')).join(' ')}`);
  console.log('');
  say(beforeCut - afterCut >= 20,
    `the pause cuts the read dead (${beforeCut.toFixed(1)} -> ${afterCut.toFixed(1)} dBFS, ${(beforeCut - afterCut).toFixed(1)} dB in 0.3 s)`);
  say(tail <= SILENT_DB, `and nothing is left sustaining it (${tail.toFixed(1)} dBFS <= ${SILENT_DB})`);
  say(Math.abs(bedPaused - bedRef) <= RECOVER_MAX_DB + 0.8,
    `the bed comes back WHILE paused (${bedPaused.toFixed(1)} vs ${bedRef.toFixed(1)} dBFS)`);
  say(bedRef - bedFrozen >= 3.0,
    `NEGATIVE CONTROL a frozen mixer clock leaves it ducked (${(bedRef - bedFrozen).toFixed(1)} dB down) — the audio clock is load-bearing`);
  say(starts.length === 1 && ends.length === 1,
    `one start, one end across pause and resume (${starts.length}/${ends.length}) — no doubling`);
  say(ends[0]?.reason === 'paused', `and it ended for the right reason (${ends[0]?.reason})`);

  /* ================================================================= */
  console.log('\n=== 4. A REAL CUTSCENE, through ui/mission.js ===\n');
  const SCENE = [
    { who: 'carson', text: 'The harbormaster wants the barge by dawn.' },
    { who: 'aidan', text: 'Then he can come down here and drive it himself.' },
    { who: 'dylan', text: 'I already moved it. You are both welcome.' },
    { who: 'boss', text: 'You touch my freight again and it is the last thing you touch.' },
  ];
  const scene = await render({
    seconds: 24, radio: false,
    script: [{ t: 1.0, cut: SCENE }, { t: 3.0, bark: true }, { t: 21.5, bark: true }],
  });
  const sStarts = scene.events.filter((e) => e.type === 'dialogue:start');
  const sEnds = scene.events.filter((e) => e.type === 'dialogue:end');
  console.log(`  ${sStarts.length} lines spoken: ${sStarts.map((e) => e.id + '@' + e.t.toFixed(1)).join(', ')}`);
  console.log(`  ends: ${sEnds.map((e) => e.reason).join(', ')}`);
  let overlap = 0;
  for (let i = 1; i < sStarts.length; i++) {
    const prevEnd = sEnds.filter((e) => e.t <= sStarts[i].t).pop();
    if (!prevEnd) overlap++;
  }
  const speakers = new Set(sStarts.map((e) => e.id));
  const yields = scene.barkYield;
  console.log(`  bark during a line: ${yields.map((y) => (y.yielded ? 'YIELDED' : 'played')).join(', ')}`);
  console.log('');
  say(sStarts.length === SCENE.length,
    `every authored line is spoken (${sStarts.length}/${SCENE.length})`);
  say(overlap === 0, 'no two lines ever sound at once (one voice, always)');
  say(speakers.size === 4, `four speakers, four voices (${[...speakers].join(', ')})`);
  say(yields[0]?.yielded === true, 'a bark during a story line YIELDS');
  say(yields[1]?.yielded === false, 'and does not once the scene is over');
  if (WAV_DIR) {
    writeWav(`${WAV_DIR}/duck_scene.wav`, scene.sig);
    const mixed = await render({ seconds: 12, script: [{ t: 1.2, cut: SCENE.slice(0, 3) }] });
    writeWav(`${WAV_DIR}/duck_mixed.wav`, mixed.sig);
    console.log(`  wrote WAVs to ${WAV_DIR}`);
  }
} catch (e) {
  console.error('duckprobe crashed:', e?.stack ?? e);
  fail++;
} finally {
  if (errs.length) { console.error('\npage errors:'); for (const e of errs.slice(0, 6)) console.error('  ', e); }
  await browser.close();
  stopServer(server);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`);
process.exit(fail === 0 ? 0 : 1);
