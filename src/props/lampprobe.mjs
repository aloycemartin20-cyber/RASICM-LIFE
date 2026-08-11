#!/usr/bin/env node
/**
 * LAMPPROBE — driving past a row of street lamps must hand the light over by
 * CROSSFADE, not teleport, measured on EMITTED PIXELS.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 * `props._submitLamps` submits the 2-3 nearest lamps as real punctual lights.
 * It used to key them `9000 + i` where `i` is the lamp's RANK in the
 * distance-sorted pick — not an identity. The renderer's slot assignment is
 * key-stable (src/render/slotprobe.mjs is the write-up), so key 9000 keeps its
 * slot forever; but the moment the camera moves and the nearest-lamp ordering
 * flips, the POSITION under that key jumps from lamp A to lamp B in a single
 * frame. The slot never sees a key change, so the ~0.15 s crossfade that
 * exists precisely for handovers never runs: the sodium pool on the road
 * switches off at one lamp and on at the next between two frames — a teleport
 * dressed up as continuity.
 *
 * The fix keys each submission by the lamp's stable identity (tile key + index
 * in that tile's lamp list), so a handover is a genuine key change: the old
 * lamp's slot fades out, the new lamp fades in on a free slot, and the swap is
 * the documented crossfade.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT, AND WHY IT IS NOT CIRCULAR (rule 12)
 * ---------------------------------------------------------------------------
 * Everything asserted here is computed from PNGs of the composited frame.
 * Nothing asserts on `_pool[i]` or the pick list — those are the code's own
 * outputs and would agree with any bug. The probe boots the real night shot,
 * freezes the sim exactly like tools/capture.mjs, then TRANSLATES THE CAMERA
 * down the lane at 0.30 m/frame (~65 km/h) for ~55 m — past two or three lamp
 * pitches, which is several pick-set changes. Every frame it photographs the
 * whole frame and measures the mean luminance of a small road region UNDER
 * EACH LAMP the props system knows about, reprojected per frame so the region
 * tracks the world, not the screen.
 *
 * The camera glides at a constant step, so the luminance change IT causes in a
 * tracked region is near-linear across any three consecutive frames. The
 * metric is therefore the SECOND difference — how far a frame lands from
 * where the previous two were heading — normalised by the lamp's own full
 * swing over the traverse AND by the square of the camera step (`maxPopNorm`,
 * units 1/m^2), over lamps whose swing clears a noise floor and whose track is
 * long enough to establish one. Motion cancels out of it; a crossfade
 * contributes only the kink where its ~0.15 s fade starts; a teleport
 * contributes its whole height. (The plain first difference was measured first
 * and does NOT separate the arms — 0.33 vs 0.34 — because the motion term
 * dominates both.)
 *
 * THREE THINGS STAND BETWEEN THAT IDEA AND A NUMBER THAT MEANS ANYTHING, and
 * all three were found by this gate going decorative: it scored fixed 0.196 and
 * control 0.196 — the same headline, from the same 29-frame lamp, in the arm
 * with the light path WORKING and the arm with it BROKEN. See `MIN_TRACK` (a
 * short track is a lamp sweeping the frame edge, where the profile is steepest
 * and mostly foreground), `despike` (a one-frame occlusion is not a light
 * changing hands) and the `STEP_M^2` note beside the normaliser (a limit that
 * silently means something different at another `--step` is not a limit).
 *
 * Internal pool state IS logged per frame — how far each pool key's position
 * moved — but only as a diagnostic so a failure says "key 9001 jumped 27.4 m
 * at frame 63" instead of just a number.
 *
 * What input would make it fail? `?owLampRankKey=1` restores the rank-derived
 * keys exactly as shipped. The step metric must blow past the pass limit in
 * that arm or the metric is measuring nothing (rule 12's control).
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node src/props/lampprobe.mjs                       # measure current code
 *   node src/props/lampprobe.mjs --params=owLampRankKey=1   # legacy arm
 *   node src/props/lampprobe.mjs --gate                # fixed arm + control
 *   node src/props/lampprobe.mjs --json                # machine-readable
 *   node src/props/lampprobe.mjs --save --dir=/tmp/lampprobe  # keep frames
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const DIR = resolve(args.dir ?? '/tmp/lampprobe');
const W = 960;
const H = 540;
const TIMEOUT = Number(args.timeout ?? 120000);

/** The traverse: ~65 km/h past two-plus lamp pitches (21-29 m each). */
const STEP_M = Number(args.step ?? 0.3);
const FRAMES = Number(args.frames ?? 184);

/** Measured road region under a lamp, as a fraction of the frame. */
const CW = Math.round(W * 0.1);
const CH = Math.round(H * 0.11);
/** A region must sit fully inside this window to count (HUD kept out). */
const MARGIN = { x0: 0.05, x1: 0.95, y0: 0.28, y1: 0.88 };
/**
 * A lamp's full swing must clear this (code values) to be a real subject.
 * Measured on the night traverse: lamps that ever hold a punctual slot swing
 * 26-55; lamps that never do (emissive shell + bloom only) swing 5-8, which is
 * camera-motion noise — judging those measures nothing but the noise itself.
 */
const AMP_FLOOR = 15;
/**
 * A lamp must be tracked this many CONSECUTIVE-CAPABLE frames to be judged.
 *
 * A region is only sampled while its lamp is 4-38 m ahead and the whole box
 * sits inside `MARGIN`. A lamp that satisfies both for only a few dozen frames
 * is one sweeping past the edge of the frame or close under the camera, where
 * the pool's luminance profile is steepest and most of what crosses the box is
 * foreground — a bollard, a kerb line, a parked wing. MEASURED on the fixed
 * arm: the two shortest tracks (29 and 43 frames of 184) carried popNorm 0.196
 * and 0.057 while the four long ones sat at 0.025-0.034, and the 29-frame one
 * set the headline. It also set the CONTROL's headline, to three significant
 * figures — which is the proof that what it measures is not the light path at
 * all, because the control is the arm where the light path is broken.
 *
 * 60 frames is 18 m of travel at the default step, most of a lamp pitch.
 */
const MIN_TRACK = Number(args.track ?? 60);

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Median-of-three over the tracked series, which is the whole de-spiking of
 * this probe and is not a smoothing pass.
 *
 * A median filter has exactly the property this measurement needs: it deletes
 * an ISOLATED one-frame outlier and preserves a STEP. So a glint, or a pole
 * sweeping through the 96x59 px box for a frame, stops contributing its whole
 * height to the second difference, while a light that changes hands between
 * two frames still contributes all of its. MEASURED on the worst offender
 * (`lamp:-2,0:2`, a 5.79 spike-and-return over frames 64-68 present IDENTICALLY
 * in both arms): 5.79 -> 2.48.
 *
 * Only applied across samples that are consecutive in `t`; a tracking gap
 * leaves the sample alone rather than mixing two different moments.
 */
function despike(s) {
  const out = new Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const a = s[i - 1];
    const b = s[i];
    const c = s[i + 1];
    if (!a || !c || a.t !== b.t - 1 || c.t !== b.t + 1) { out[i] = b.L; continue; }
    out[i] = Math.max(Math.min(a.L, b.L), Math.min(Math.max(a.L, b.L), c.L));
  }
  return out;
}

/** Mean luminance of a box inside a decoded PNG. */
function boxLum(png, x, y, w, h) {
  const { width, data } = png;
  let s = 0;
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      const o = (j * width + i) * 4;
      s += lum(data[o], data[o + 1], data[o + 2]);
    }
  }
  return s / (w * h);
}

/**
 * One full run against a live page. `extra` is appended to the URL, so the
 * negative-control arm is the same code path with one switch flipped.
 */
async function run(extra) {
  const { port, server } = await startServer({ explicitPort: args.port });
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

  const pump = (n) => page.evaluate((k) => window.__PUMP__(k), n);

  try {
    const url = `http://127.0.0.1:${port}/?capture=1&shot=night&lockstep=1${extra ? `&${extra}` : ''}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });
    await page.evaluate(() => window.__APPLY_SHOT__?.('night', { grabFrame: 90 }));
    let frames = 0;
    while (frames < 1200) {
      if (await page.evaluate(() => window.__SETTLED__?.() === true)) break;
      await pump(20);
      frames += 20;
    }
    await pump(90);
    const cleaned = await page.evaluate(() => window.__PRESHUTTER__?.() ?? 0);
    if (cleaned) await pump(20);
    // Freeze the sim exactly like tools/capture.mjs. The engine still calls
    // every update with dt = 0 and the renderer's crossfade clamps its dt to
    // 1/60, so the only things moving during the traverse are the camera we
    // move and the light arbitration under test.
    await page.evaluate(() => {
      window.__PRESHUTTER__?.();
      const e = window.__ENGINE__;
      e.time.scale = 0;
      const shotDef = window.__SHOTS__?.night ?? null;
      if (shotDef?.time !== undefined) e.ctx.peek('sky')?.setTimeOfDay?.(shotDef.time);
      const taa = e.ctx.peek('render')?.taa;
      if (taa) { taa.index = 0; taa.reset?.(); }
    });
    await pump(32);

    // ---- install the scenario --------------------------------------------
    const setup = await page.evaluate(
      ({ stepM }) => {
        const e = window.__ENGINE__;
        const ctx = e.ctx;
        const props = ctx.peek('props');
        const r = ctx.peek('render');
        const world = ctx.peek('world');
        if (!props?.tiles) return { err: 'no props subsystem' };
        if (!(props._litMix >= 0.1)) return { err: `litMix ${props._litMix} — lamps unlit` };
        const cam = ctx.camera;
        cam.updateMatrixWorld();
        const me = cam.matrixWorld.elements;
        const P0 = { x: me[12], y: me[13], z: me[14] };
        const fl = Math.hypot(me[8], me[10]) || 1;
        // camera forward, flattened to XZ (camera looks down its local -Z)
        const f = { x: -me[8] / fl, z: -me[10] / fl };

        // Every lamp head the props system knows about near the path, with the
        // SAME arm-offset formula `_submitLamps` uses, plus the road point
        // under it — the centre of the sodium pool the traverse photographs.
        const lamps = [];
        for (const rec of props.tiles.values()) {
          if (rec.lod !== 0 || !rec.lamps) continue;
          for (let j = 0; j < rec.lamps.length; j++) {
            const l = rec.lamps[j];
            const hx = l.x + Math.cos(l.yaw) * l.r;
            const hz = l.z + Math.sin(l.yaw) * l.r;
            // distance from the START of the path segment, along and across
            const ax = hx - P0.x;
            const az = hz - P0.z;
            const along = ax * f.x + az * f.z;
            const across = Math.abs(ax * f.z - az * f.x);
            if (along < -10 || along > 90 || across > 30) continue;
            const gy = world?.heightAt?.(hx, hz) ?? P0.y - 5.0;
            // Same id `_submitLamps` keys its submission with, so the per-lamp
            // report lines up with the pool diagnostic below.
            lamps.push({ id: `lamp:${rec.key}:${j}`, x: hx, y: gy + 0.05, z: hz });
          }
        }

        const st = { P0, f, lamps, i: 0, stepM, poolJump: [], prevPool: null };
        window.__LAMP_ST__ = st;
        const V = new (Object.getPrototypeOf(cam.position).constructor)();

        /** Advance the camera one step and project every lamp's road point. */
        window.__LAMP_STEP__ = () => {
          st.i++;
          cam.position.set(
            st.P0.x + st.f.x * st.stepM * st.i,
            st.P0.y,
            st.P0.z + st.f.z * st.stepM * st.i
          );
          cam.updateMatrixWorld();
          const out = [];
          for (const L of st.lamps) {
            const dx = L.x - cam.position.x;
            const dz = L.z - cam.position.z;
            // Ahead of the camera and near enough that its pool can matter.
            if (dx * st.f.x + dz * st.f.z < 4) continue;
            if (dx * dx + dz * dz > 38 * 38) continue;
            V.set(L.x, L.y, L.z).project(cam);
            if (!(V.z > -1 && V.z < 1)) continue;
            out.push({ id: L.id, px: (V.x + 1) / 2, py: (1 - V.y) / 2 });
          }
          // DIAGNOSTIC ONLY (rule 12): how far each lit pool key's position
          // moved this frame. Never asserted on — it names the failure.
          const pool = r._pool.map((s) => ({
            k: String(s.key),
            i: s.light.intensity,
            x: s.light.position.x,
            z: s.light.position.z,
          }));
          if (st.prevPool) {
            for (const s of pool) {
              const p = st.prevPool.find((q) => q.k === s.k);
              if (p && s.i > 1 && p.i > 1) {
                const jump = Math.hypot(s.x - p.x, s.z - p.z);
                if (jump > 2) st.poolJump.push({ frame: st.i, key: s.k, jump: +jump.toFixed(1) });
              }
            }
          }
          st.prevPool = pool;
          return { cam: { x: cam.position.x, z: cam.position.z }, lamps: out };
        };
        return { slots: r.lightSlots, litMix: +props._litMix.toFixed(3), nLamps: lamps.length };
      },
      { stepM: STEP_M }
    );
    if (setup.err) throw new Error(`setup: ${setup.err}`);
    if (setup.nLamps < 4) throw new Error(`only ${setup.nLamps} lamps near the path`);

    // ---- the traverse ----------------------------------------------------
    // series: id -> array of {t, L}; consecutive t means a valid delta pair.
    const series = new Map();
    if (args.save) mkdirSync(DIR, { recursive: true });
    for (let t = 0; t < FRAMES; t++) {
      const vis = await page.evaluate(() => window.__LAMP_STEP__());
      await pump(1);
      const png = PNG.sync.read(await page.screenshot({ type: 'png' }));
      if (args.save && t % 20 === 0) {
        writeFileSync(`${DIR}/f${String(t).padStart(3, '0')}${extra ? '-ctl' : ''}.png`, PNG.sync.write(png));
      }
      for (const L of vis.lamps) {
        const x = Math.round(L.px * W - CW / 2);
        const y = Math.round(L.py * H - CH / 2);
        if (x < MARGIN.x0 * W || x + CW > MARGIN.x1 * W) continue;
        if (y < MARGIN.y0 * H || y + CH > MARGIN.y1 * H) continue;
        let s = series.get(L.id);
        if (!s) series.set(L.id, (s = []));
        s.push({ t, L: boxLum(png, x, y, CW, CH) });
      }
    }

    const poolJump = await page.evaluate(() => window.__LAMP_ST__.poolJump);

    // ---- the metric ------------------------------------------------------
    // Per lamp: largest single-frame step over its own full swing. Lamps whose
    // swing never clears the noise floor were never meaningfully lit and are
    // reported but not judged.
    const perLamp = [];
    for (const [id, s] of series) {
      if (s.length < 12) continue;
      const f = despike(s);
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of f) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const amp = hi - lo;
      let maxStep = 0;
      let maxAt = -1;
      // `pop` is the SECOND difference: how far this frame lands from where the
      // previous two frames were heading. The camera glides at a constant
      // 0.30 m/frame, so the luminance change it causes is near-linear across
      // any three frames and cancels here; a crossfade contributes at most its
      // ~0.15 s fade rate at the kink where it starts; a teleport contributes
      // its whole height. This is what separates the arms — the plain
      // first-difference is dominated by the motion term in both.
      let maxPop = 0;
      let popAt = -1;
      for (let i = 1; i < s.length; i++) {
        if (s[i].t !== s[i - 1].t + 1) continue; // tracking gap — no pair
        const d = Math.abs(f[i] - f[i - 1]);
        if (d > maxStep) {
          maxStep = d;
          maxAt = s[i].t;
        }
        if (i >= 2 && s[i - 1].t === s[i - 2].t + 1) {
          const p = Math.abs(f[i] - 2 * f[i - 1] + f[i - 2]);
          if (p > maxPop) {
            maxPop = p;
            popAt = s[i].t;
          }
        }
      }
      /**
       * `popNorm` is a CURVATURE PER METRE OF CAMERA TRAVEL SQUARED, not a bare
       * ratio, and dividing by `STEP_M^2` is what makes the thresholds below
       * mean the same thing at any `--step`.
       *
       * A smooth pool profile contributes a second difference of about
       * `step^2 * d2L/ds2`, so dividing it out leaves a property of the SCENE
       * that does not move when the sampling does. A teleport contributes its
       * whole height whatever the step, so its normalised value only grows as
       * the step shrinks. That asymmetry is the direction a gate wants:
       * sampling the traverse more finely can sharpen the failure and can never
       * soften it. Before this the limits were silently quoted at one step and
       * a `--step=0.15` run would have halved the fixed arm's number and left
       * the control's alone.
       */
      const norm = amp >= AMP_FLOOR && s.length >= MIN_TRACK
        ? +(maxPop / (amp * STEP_M * STEP_M)).toFixed(3)
        : null;
      perLamp.push({
        id,
        frames: s.length,
        amp: +amp.toFixed(2),
        maxStep: +maxStep.toFixed(2),
        maxAt,
        maxPop: +maxPop.toFixed(2),
        popAt,
        popNorm: norm,
        why: norm !== null ? '' : (amp < AMP_FLOOR ? 'under amp floor' : `track ${s.length} < ${MIN_TRACK}`),
        series: s.map((p) => [p.t, +p.L.toFixed(2)]),
      });
    }
    const judged = perLamp.filter((p) => p.popNorm !== null);
    if (judged.length < 3) {
      throw new Error(
        `only ${judged.length} lamp(s) cleared the amplitude floor and the ${MIN_TRACK}-frame ` +
        'track guard — too few to judge, so this run measured nothing'
      );
    }
    const worst = judged.reduce((a, b) => (b.popNorm > a.popNorm ? b : a));

    return {
      slots: setup.slots,
      litMix: setup.litMix,
      nLamps: setup.nLamps,
      tracked: perLamp.length,
      judged: judged.length,
      maxPopNorm: worst.popNorm,
      worst,
      perLamp,
      poolJump: poolJump.slice(0, 40),
    };
  } catch (e) {
    console.error(logs.slice(-40).join('\n'));
    throw e;
  } finally {
    await browser.close();
    stopServer(server);
  }
}

function report(name, r) {
  console.log(
    `${name.padEnd(14)} slots=${r.slots} litMix=${r.litMix} lamps=${r.nLamps} ` +
      `tracked=${r.tracked} judged=${r.judged} maxPopNorm=${r.maxPopNorm}`
  );
  console.log(
    `${''.padEnd(14)} worst: ${r.worst.id} pop ${r.worst.maxPop} of swing ${r.worst.amp} at frame ${r.worst.popAt}`
  );
  for (const p of r.perLamp) {
    console.log(
      `${''.padEnd(14)} ${p.id.padEnd(14)} frames=${String(p.frames).padStart(3)} ` +
        `amp=${String(p.amp).padStart(7)} maxStep=${String(p.maxStep).padStart(7)} ` +
        `maxPop=${String(p.maxPop).padStart(7)} popNorm=${p.popNorm ?? `(${p.why})`}`
    );
  }
  const jumps = r.poolJump.filter((j) => j.jump > 5);
  console.log(
    `${''.padEnd(14)} pool-key position jumps >5 m (diagnostic): ${jumps.length}` +
      (jumps.length ? ` — e.g. ${jumps.slice(0, 4).map((j) => `${j.key}@f${j.frame}:${j.jump}m`).join(' ')}` : '')
  );
}

/**
 * ---------------------------------------------------------------------------
 * THE GATE
 * ---------------------------------------------------------------------------
 * RATCHETS (rule 13) — measured values beside each limit; move them DOWN
 * (tighter) when the behaviour improves, never up.
 *
 * BOTH LIMITS WERE RE-DERIVED. The previous pair (0.20 / 0.25) were quoted
 * against a bare `maxPop / amp` on an unfiltered series with no track guard,
 * and on this tree they had stopped separating the arms AT ALL: fixed 0.196
 * and control 0.196, to three significant figures, because BOTH headlines were
 * set by the same 29-frame lamp whose pop is path curvature and a foreground
 * sweep. The control could not fail, so the gate was decorative — a passing
 * `maxPopNorm <= 0.20` said nothing about lamp handover. Everything that
 * changed is in `MIN_TRACK`, `despike` and the `STEP_M^2` normaliser above.
 *
 * MEASURED with those in place, one run, all values 1/m^2 of camera travel:
 *
 *   arm      judged lamps (popNorm)                 headline   pool jumps >5 m
 *   fixed    0.275 0.329 0.380 [0.902]              0.902      0
 *   control  0.275 0.923 1.445 [0.910]              1.445      40
 *
 *   maxPopNorm <= 1.10   fixed measured 0.902, and that headline is ONE lamp
 *                        (`lamp:-2,0:2`) whose 5.79 spike-and-return over five
 *                        frames the median filter reduces to 2.48 but cannot
 *                        remove, and which reads 0.910 in the CONTROL — i.e.
 *                        it is provably not the light path, because the arm
 *                        with the light path broken measures the same thing.
 *                        Every other judged lamp is 0.275-0.380. The honest
 *                        goal is that headline coming down to ~0.4, which
 *                        needs a region statistic robust to a foreground
 *                        object crossing the box (a percentile rather than a
 *                        mean), not a different light path.
 *   control >= 1.25      control measured 1.445, on the lamp the pool actually
 *                        hands over (`lamp:-2,0:15`, an 8.57 single-frame step
 *                        against 3.27 in the fixed arm).
 *
 * Negative control: `owLampRankKey=1` restores the rank-derived keys. Its
 * maxPopNorm must sit ABOVE `CTL_POP_MIN` or the metric no longer measures the
 * teleport and cannot be trusted. Its internal confirmation: the legacy arm
 * logs 40 pool-key position jumps over 5 m in one 55 m traverse; the fixed arm
 * logs zero.
 */
const POP_MAX = 1.1;
const CTL_POP_MIN = 1.25;

if (args.gate) {
  const fixed = await run(args.params || '');
  report('fixed', fixed);
  const legacy = await run(`owLampRankKey=1${args.params ? '&' + args.params : ''}`);
  report('CONTROL', legacy);
  let bad = 0;
  const check = (ok, what) => {
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  };
  check(
    fixed.maxPopNorm <= POP_MAX,
    `maxPopNorm ${fixed.maxPopNorm} <= ${POP_MAX} — a lamp handover must crossfade, not step`
  );
  check(
    legacy.maxPopNorm >= CTL_POP_MIN,
    `control maxPopNorm ${legacy.maxPopNorm} >= ${CTL_POP_MIN} — rank keys must teleport the pool`
  );
  console.log(bad === 0 ? '\nlampprobe: OK' : `\nlampprobe: ${bad} FAILING`);
  process.exit(bad === 0 ? 0 : 1);
}

const r = await run(args.params || '');
if (args.json) console.log(JSON.stringify(r));
else report(args.params ? `[${args.params}]` : 'current', r);
