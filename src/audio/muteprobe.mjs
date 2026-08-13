#!/usr/bin/env node
/**
 * AUDIO / MUTE + VOLUME + SIREN GATE
 *
 * You cannot screenshot silence, so this is the gate for the global audio
 * controls. It renders the REAL synthesis graph offline through
 * `src/audio/bench.js` in headless Chromium, applies the SAME Mixer calls the
 * pause menu makes (`setMasterVolume`, `setBusVolume` — see src/ui/menu.js), and
 * measures the EMITTED buffer, not the gain values it set (rule 12).
 *
 * For a siren, an engine, a weapon and the radio it asserts:
 *   - MUTE (master -> 0) drives the rendered output to silence.
 *   - the relevant slider at 0 (Effects for SFX, Music for the radio) drives the
 *     rendered output to silence too.
 *
 * The bug this exists for: the reverb send used to be PRE-fader, so a source's
 * wet tail bypassed its bus volume and a siren stayed audible with Effects at 0.
 * The mute path (master) always worked; the slider path did not. The negative
 * control restores the pre-fader send (`preFaderSend`) and proves the slider
 * assertions go RED — a gate that stays green there is measuring nothing.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * AND THE SIRENS, which is the second half of this file
 * ───────────────────────────────────────────────────────────────────────────
 * "Police sirens are annoying and make it distracting to play when they fade in
 * and out" — the owner, playing. Three emitted properties gate that, each with
 * its own negative control, all of them measured on rendered PCM:
 *
 *   1. THE ENVELOPE. `sirenFlyby` drives one cruiser past the listener through
 *      an occlusion and a six-frame dropout; the gate is the maximum rate of
 *      change of its level (see `slopeDbPerSec`). Control: `legacySiren`, which
 *      flips PoliceAudio's live `smooth` switch and restores every step the fix
 *      removed.
 *   2. DENSITY. `sirenPack` renders the same junction with one cruiser and with
 *      four; four must not be four times as loud. Same control.
 *   3. THE PIERCING BAND. The share of power in 2.5-4 kHz on the steady scene.
 *
 * Browser probe (Web Audio needs a real AudioContext), MEASURED 20 s end to end
 * with the siren sections in, deterministic — two consecutive runs agree to
 * every printed digit. NOT gate-tier (it boots a browser), so it stays in
 * `handoff` and `soak` (`npm run mute`). Run it when you touch src/audio.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, join, normalize } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };

const PAGE = `<!doctype html><meta charset=utf8><title>mute gate</title>
<body><script type="module">
  import * as bench from '/src/audio/bench.js';
  window.__BENCH__ = bench;
  window.__READY__ = true;
</script></body>`;

const server = createServer(async (req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return;
  }
  const path = join(ROOT, normalize(url).replace(/^(\.\.[/\\])+/, ''));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
const PORT = await new Promise((d) => server.listen(0, '127.0.0.1', () => d(server.address().port)));

/** Interleaved int16 base64 -> mono Float64 at `sampleRate`. */
function decode(r) {
  const raw = Buffer.from(r.pcm, 'base64');
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const n = pcm.length / 2;
  const mono = new Float64Array(n);
  for (let i = 0; i < n; i++) mono[i] = (pcm[i * 2] + pcm[i * 2 + 1]) / 65536;
  return mono;
}

/** RMS in dBFS over a tail window [startFrac, endFrac) of the interleaved PCM. */
function tailDbfs(r, startFrac = 0.4, endFrac = 0.98) {
  const raw = Buffer.from(r.pcm, 'base64');
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  const frames = pcm.length / 2;
  const a = Math.floor(frames * startFrac);
  const b = Math.floor(frames * endFrac);
  let sumSq = 0;
  for (let i = a; i < b; i++) {
    const l = pcm[i * 2] / 32768, rr = pcm[i * 2 + 1] / 32768;
    sumSq += l * l + rr * rr;
  }
  const n = Math.max(1, (b - a) * 2);
  const rms = Math.sqrt(sumSq / n);
  return 20 * Math.log10(Math.max(rms, 1e-9));
}

const SR = 48000;

/**
 * HOW FAST DOES THE SIREN BUS MOVE? The whole "fade in and out" report in one
 * number: the level envelope of the emitted buffer, differentiated.
 *
 * 20 ms hops of 60 ms RMS (a siren's fundamental is ~1 kHz, so 60 ms is dozens
 * of cycles and the envelope is not measuring the waveform), converted to dB,
 * MEDIAN FILTERED over 500 ms, then the slope across a 100 ms span.
 *
 * THE MEDIAN IS THE WHOLE MEASUREMENT, and the first version of this without it
 * measured nothing. A siren is an amplitude modulator by construction: its tone
 * sweeps under two FIXED horn resonances, so the level swings several dB every
 * sweep — 3.6 Hz on a yelp, 1.9 Hz on a hi-lo. Differentiated raw, that is over
 * 100 dB/s of perfectly correct siren, and it buried the defect completely:
 * MEASURED, the fixed arm scored 34.3 dB/s and the pre-fix control 34.2, i.e.
 * the gate could not tell them apart at all. A median over a window longer than
 * the modulation period removes symmetric ripple and PRESERVES A STEP EDGE,
 * which is exactly the discrimination wanted: a hard cut stays a cliff, a swept
 * tone stops being one.
 *
 * The floor is RELATIVE to the scene's own p95 level, not an absolute dBFS:
 * decibels are unbounded as a signal approaches silence, so any fade-out can be
 * made to score arbitrarily badly by measuring far enough down its tail — and a
 * source 30 dB under the pursuit around it is not what anybody means by "fades
 * in and out". Windows with either end below that are skipped.
 */
function slopeDbPerSec(mono, from, to, floorUnderP95 = 30) {
  const hop = Math.floor(SR * 0.02);
  const win = Math.floor(SR * 0.06);
  const i0 = Math.floor(from * SR), i1 = Math.min(mono.length, Math.floor(to * SR));
  const raw = [];
  for (let s = i0; s + win <= i1; s += hop) {
    let e = 0;
    for (let i = 0; i < win; i++) e += mono[s + i] * mono[s + i];
    raw.push(20 * Math.log10(Math.max(Math.sqrt(e / win), 1e-9)));
  }
  const R = 12;                          // +-12 hops = a 500 ms median window
  const db = [];
  const scratch = [];
  for (let i = 0; i < raw.length; i++) {
    scratch.length = 0;
    for (let j = Math.max(0, i - R); j <= Math.min(raw.length - 1, i + R); j++) scratch.push(raw[j]);
    scratch.sort((a, b) => a - b);
    db.push(scratch[scratch.length >> 1]);
  }
  const lvl = db.slice().sort((a, b) => a - b);
  const floorDb = lvl[Math.floor(lvl.length * 0.95)] - floorUnderP95;
  const span = 5;                        // 5 hops = 100 ms
  const rates = [];
  for (let i = 0; i + span < db.length; i++) {
    if (db[i] < floorDb || db[i + span] < floorDb) continue;
    rates.push(Math.abs(db[i + span] - db[i]) / (span * 0.02));
  }
  if (!rates.length) return { max: 0, p95: 0, n: 0, floorDb };
  const s = rates.slice().sort((a, b) => a - b);
  return { max: s[s.length - 1], p95: s[Math.floor(s.length * 0.95)], n: rates.length, floorDb };
}

/** Fraction of power in [lo, hi) Hz over the whole audible band. */
function bandFraction(mono, lo, hi) {
  const N = 4096;
  const re = new Float64Array(N), im = new Float64Array(N);
  const acc = new Float64Array(N / 2);
  let frames = 0;
  for (let s = 0; s + N <= mono.length; s += N) {
    let e = 0;
    for (let i = 0; i < N; i++) e += mono[s + i] * mono[s + i];
    if (Math.sqrt(e / N) < 0.0006) continue;
    for (let i = 0; i < N; i++) {
      re[i] = mono[s + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (!frames) return 0;
  const binHz = SR / N;
  let band = 0, tot = 0;
  for (let k = Math.ceil(120 / binHz); k < N / 2; k++) {
    const f = k * binHz;
    tot += acc[k];
    if (f >= lo && f < hi) band += acc[k];
  }
  return tot > 0 ? band / tot : 0;
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

const browser = await chromium.launch({
  headless: true,
  args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));

let pass = 0, fail = 0;
const say = (ok, msg) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${msg}`); ok ? pass++ : fail++; };

try {
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 30000 });

  const render = async (name, opts, startFrac = 0.4) =>
    tailDbfs(await page.evaluate(([n, o]) => window.__BENCH__.renderScene(n, o), [name, opts]), startFrac);

  // Every audible source, with the slider that must scale it. `base` is merged
  // into every render for that source. The siren scene is soloed onto the
  // `sirens` bus because PoliceAudio ALSO emits the pursuit tension layer on the
  // MUSIC bus — that is music, correctly untouched by the Effects slider, and it
  // would otherwise mask the siren's own path.
  const SOURCES = [
    { scene: 'sirenStatic', label: 'siren', slider: 'sfx', base: { solo: 'sirens' } },
    { scene: 'engineSteady', label: 'engine', slider: 'sfx', base: {} },
    { scene: 'weaponLoop', label: 'weapon', slider: 'sfx', base: {} },
    { scene: 'radio:furnace', label: 'radio', slider: 'music', base: {} },
  ];

  // Thresholds are RATCHETs: the fix drives every source far past them (see the
  // measured drops printed below). Lower them if you improve; never raise one to
  // go green (rule 13). A muted/zeroed source must also be quiet in absolute
  // terms, not merely relatively.
  const MUTE_DROP_DB = 30;      // measured worst ~37 dB (weapon); siren ~78
  const SLIDER_DROP_DB = 24;    // measured worst ~26 dB (radio); siren/engine >40
  const SILENT_DBFS = -60;      // absolute ceiling for a silenced source
  /* Siren RATCHETs. Every one is set from a measurement with its live negative
     control beside it, so the ceiling itself fails the pre-fix build — that is
     what stops these being decoration. Lower them when the mix improves; never
     raise one to make a run go green (rule 13).

       envelope, flyby     fixed max 21.3 dB/s, p95 8.3   legacy 142.4 / 44.3
       density, 4 vs 1     fixed -0.3 dB                  legacy +5.9 dB
       2.5-4 kHz share     fixed 6.5%                     pre-fix horn 9.0%

     The 21 dB/s is by design and not slack: the level envelope may move 12 dB/s
     while the emitter's own gain slew moves 11 dB/s, and an occlusion is both
     at once. */
  const SLOPE_MAX_DB_S = 24;
  const SLOPE_P95_DB_S = 10;
  const SLOPE_NC_MARGIN = 40;
  const PACK_MAX_DB = 3;        // four cruisers over one
  const PACK_NC_MARGIN = 2.5;
  const PIERCE_MAX = 0.075;     // share of power in 2.5-4 kHz

  console.log('\n=== controls reach the emitted buffer (tail-window dBFS RMS) ===\n');
  const off = (s) => (s.slider === 'sfx' ? { sfx: 0 } : { music: 0 });
  const sirenFull = {};

  for (const s of SOURCES) {
    const full = await render(s.scene, { ...s.base });
    const muted = await render(s.scene, { ...s.base, mute: true });
    const sliderOff = await render(s.scene, { ...s.base, ...off(s) });
    if (s.label === 'siren') { sirenFull.full = full; sirenFull.sliderOff = sliderOff; }
    const muteDrop = full - muted;
    const sliderDrop = full - sliderOff;
    console.log(`${s.label.padEnd(7)} full ${full.toFixed(1)}  mute ${muted.toFixed(1)} (Δ${muteDrop.toFixed(1)})  ${s.slider}=0 ${sliderOff.toFixed(1)} (Δ${sliderDrop.toFixed(1)})`);

    say(muteDrop >= MUTE_DROP_DB && muted <= SILENT_DBFS,
      `${s.label}: MUTE silences it (drop ${muteDrop.toFixed(1)} dB >= ${MUTE_DROP_DB}, floor ${muted.toFixed(1)} <= ${SILENT_DBFS})`);
    say(sliderDrop >= SLIDER_DROP_DB && sliderOff <= SILENT_DBFS,
      `${s.label}: ${s.slider}=0 silences it (drop ${sliderDrop.toFixed(1)} dB >= ${SLIDER_DROP_DB}, floor ${sliderOff.toFixed(1)} <= ${SILENT_DBFS})`);
  }

  // Halved slider must roughly halve the source (scales, not just on/off).
  const halfSiren = await render('sirenStatic', { solo: 'sirens', sfx: 0.5 });
  const halfDrop = sirenFull.full - halfSiren;
  console.log(`\nsiren sfx=0.5 -> ${halfSiren.toFixed(1)} dBFS (Δ${halfDrop.toFixed(1)} from full ${sirenFull.full.toFixed(1)})`);
  say(halfDrop >= 3 && halfDrop <= 12, `siren scales with the slider (Δ${halfDrop.toFixed(1)} dB in [3,12])`);

  // --- NEGATIVE CONTROL: pre-fader send restored; the slider must FAIL ---
  console.log('\n=== negative control: pre-fader send restored ===\n');
  const ncFull = await render('sirenStatic', { solo: 'sirens', preFaderSend: true });
  const ncOff = await render('sirenStatic', { solo: 'sirens', sfx: 0, preFaderSend: true });
  const ncDrop = ncFull - ncOff;
  console.log(`siren (pre-fader) full ${ncFull.toFixed(1)}  sfx=0 ${ncOff.toFixed(1)} (Δ${ncDrop.toFixed(1)})`);
  say(ncDrop < SLIDER_DROP_DB && ncOff > SILENT_DBFS,
    `pre-fader siren stays audible under sfx=0 (Δ${ncDrop.toFixed(1)} dB < ${SLIDER_DROP_DB}, floor ${ncOff.toFixed(1)} > ${SILENT_DBFS}) — gate has teeth`);

  /* =================================================================== */
  /* SIREN ENVELOPE: a pursuit has to be bearable at minute ten           */
  /* =================================================================== */
  console.log('\n=== siren envelope smoothness (emitted sirens bus, scripted flyby) ===\n');
  const renderMono = async (name, opts) =>
    decode(await page.evaluate(([n, o]) => window.__BENCH__.renderScene(n, o), [name, opts]));

  // Both arms are the SAME scene through the SAME code: `legacySiren` flips
  // PoliceAudio's live `smooth` switch, which is the only difference between
  // them. The window starts at 3 s so the scene's own arrival — a deliberate
  // two-second fade-in, not a defect — is not scored.
  const fly = await renderMono('sirenFlyby', { solo: 'sirens' });
  const flyNc = await renderMono('sirenFlyby', { solo: 'sirens', legacySiren: true });
  const sm = slopeDbPerSec(fly, 3.0, 11.6);
  const nc = slopeDbPerSec(flyNc, 3.0, 11.6);
  console.log(`fixed   max ${sm.max.toFixed(1)} dB/s   p95 ${sm.p95.toFixed(1)} dB/s  (${sm.n} windows over ${sm.floorDb.toFixed(0)} dBFS)`);
  console.log(`legacy  max ${nc.max.toFixed(1)} dB/s   p95 ${nc.p95.toFixed(1)} dB/s  (${nc.n} windows over ${nc.floorDb.toFixed(0)} dBFS)`);

  say(sm.max <= SLOPE_MAX_DB_S,
    `the siren never lurches through an occlusion or a dropout (max ${sm.max.toFixed(1)} dB/s <= ${SLOPE_MAX_DB_S})`);
  say(sm.p95 <= SLOPE_P95_DB_S,
    `and is smooth almost everywhere (p95 ${sm.p95.toFixed(1)} dB/s <= ${SLOPE_P95_DB_S})`);
  say(nc.max - sm.max >= SLOPE_NC_MARGIN,
    `NEGATIVE CONTROL smooth:false lurches ${nc.max.toFixed(1)} dB/s, ` +
    `${(nc.max - sm.max).toFixed(1)} dB/s worse (>= ${SLOPE_NC_MARGIN}) — the gate has teeth`);

  /* ---- density: three cruisers must not be three cruisers loud ------ */
  const one = await render('sirenPack', { solo: 'sirens', packUnits: 1 }, 0.5);
  const four = await render('sirenPack', { solo: 'sirens', packUnits: 4 }, 0.5);
  const oneNc = await render('sirenPack', { solo: 'sirens', packUnits: 1, legacySiren: true }, 0.5);
  const fourNc = await render('sirenPack', { solo: 'sirens', packUnits: 4, legacySiren: true }, 0.5);
  console.log(`\npack   1 unit ${one.toFixed(1)}  4 units ${four.toFixed(1)} dBFS (Δ${(four - one).toFixed(1)})`);
  console.log(`legacy 1 unit ${oneNc.toFixed(1)}  4 units ${fourNc.toFixed(1)} dBFS (Δ${(fourNc - oneNc).toFixed(1)})`);
  say(four - one <= PACK_MAX_DB,
    `four cruisers are not four cruisers loud (+${(four - one).toFixed(1)} dB <= ${PACK_MAX_DB})`);
  say((fourNc - oneNc) - (four - one) >= PACK_NC_MARGIN,
    `NEGATIVE CONTROL without the shared cap they pile up to +${(fourNc - oneNc).toFixed(1)} dB ` +
    `(${((fourNc - oneNc) - (four - one)).toFixed(1)} dB more, >= ${PACK_NC_MARGIN})`);

  // The piercing band, on the steady scene so the number is not a moving
  // target. This one has no live control; the value before the horn's second
  // resonance came down is recorded in sirens.js beside the filter.
  const steady = await renderMono('sirenStatic', { solo: 'sirens' });
  const pierce = bandFraction(steady, 2500, 4000);
  console.log(`\n2.5-4 kHz share of the siren ${(pierce * 100).toFixed(1)}%`);
  say(pierce <= PIERCE_MAX,
    `the piercing band is held down (${(pierce * 100).toFixed(1)}% <= ${(PIERCE_MAX * 100).toFixed(0)}%)`);

  if (pageErrors.length) {
    console.log('\npage errors:'); for (const e of pageErrors.slice(0, 5)) console.log('  ', e);
  }
} catch (err) {
  console.error('mutegate crashed:', err?.message ?? err);
  fail++;
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass}/${pass + fail} checks`);
process.exit(fail === 0 ? 0 : 1);
