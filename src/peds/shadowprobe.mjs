#!/usr/bin/env node
/**
 * PED GROUND-CONTACT SHADOW — pixel A/B.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MEASURES, AND WHY IT IS NOT A RESTATEMENT OF THE CODE
 * ────────────────────────────────────────────────────────────────────────────
 * The defect this exists for is that the ped's ground shadow rendered BRIGHTER
 * than the road under it. That is a claim about PIXELS, so nothing here reads a
 * material constant, an opacity or a blend factor — hard rule 12. It:
 *
 *   1. freezes one frame (the harness's own lockstep + `time.scale = 0`),
 *   2. photographs it four times, changing ONLY the blend mode between shots
 *      via `peds.ground.setMode`: `off`, `off` AGAIN (the measured noise floor
 *      every threshold below is set from), `lerp` (the historical defect) and
 *      `multiply` (the fix),
 *   3. derives the shadow's FOOTPRINT from the difference between arms rather
 *      than from where the code says it put the quads, and
 *   4. reports the road inside that footprint against the road immediately
 *      either side of it, on the same rows of the same frame.
 *
 * Point 3 is the part that matters. If the mask came from projecting the
 * instance transforms, the probe would be asking the code where its own
 * shadow is and would agree with it by construction — the `skyline` mistake in
 * ARCHITECTURE.md rule 12. Instead the mask is "every pixel that moved when the
 * pool was switched on", which is a fact about the framebuffer.
 *
 * WHAT INPUT WOULD MAKE THIS FAIL: any blend that raises a pixel it touches by
 * more than two identical captures of one arm differ by. The `lerp` arm is that
 * input, taken on every run rather than behind a flag, and it goes red loudly —
 * 17-77% of the footprint raised against a floor of +8 to +13.
 *
 * Usage:
 *   node src/peds/shadowprobe.mjs                    # street + crowd, both TODs
 *   node src/peds/shadowprobe.mjs --shot=crowd --time=12
 *   node src/peds/shadowprobe.mjs --nostage          # staging ablation, see STAGE
 *   node src/peds/shadowprobe.mjs --time=21.35 --keep=/tmp/arms
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import net from 'node:net';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const W = Number(args.w ?? 1920);
const H = Number(args.h ?? 1080);
const TIMEOUT = Number(args.timeout ?? 120000);
const SETTLE = Number(args.settle ?? 90);
const CONVERGE = Number(args.converge ?? 32);
const KEEP = args.keep ? resolve(String(args.keep)) : null;

/**
 * The two lighting conditions the defect has to be measured in. Midday is the
 * easy case; 21:21 overcast is the hard one, because a lerp towards a constant
 * does its worst damage exactly where the receiver is darkest, and an overcast
 * night road is the darkest receiver in the game.
 */
const CONDITIONS = [
  { id: 'midday', time: 12.0, weather: 'overcast' },
  { id: '2121', time: 21.35, weather: 'overcast' },
];

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THIS PROBE STAGES ITS OWN SCENE. IT DOES NOT BORROW A CAMERA.
 * ────────────────────────────────────────────────────────────────────────────
 * It used to run on `driving` and `character` and reported 4/4 UNMEASURED —
 * "NO CONDITION PRODUCED A MEASURABLE FOOTPRINT" — for its whole life. That was
 * never a fact about the shadow pool. It was a fact about the FRAMING:
 *
 *   - `driving` is shot over a car bonnet, and the pedestrians it can see are
 *     on the pavement past it, at 30 m and edge-on;
 *   - `character` composes an over-the-shoulder on a brother AT THE SHUTTER
 *     (`actorFrame` in `src/dev/shots.js`), so what fills the frame is a torso;
 *   - both cameras sit at eye height and look level, which is the worst
 *     possible attitude for a GROUND decal — a 0.6 m blob seen from 2.2 m up at
 *     30 m projects to about one pixel of height.
 *
 * Neither camera is owned by this file, both were changed by other agents mid
 * wave, and a gate whose subject can walk out of frame is not a gate. So the
 * scene is composed here: `peds.debugStage('crowd')` puts ~34 pedestrians in a
 * 4.5-30 m band in front of whatever camera the shot set, WITH bodies and with
 * their poses settled. The nearest of those is 4.5-8 m away, which is where a
 * contact mark is tens of thousands of pixels rather than tens.
 *
 * Two things were wrong and both are fixed here, so neither should be given the
 * other's credit: the FRAMING (this staging) and the CANDIDATE PICK (see the
 * note by `MIN_PX`, which took the first crop over the floor rather than the
 * best one). Ablated one at a time on this build: staged 4/4 conditions
 * measured at 1265-9766 px of footprint, unstaged 3/4.
 *
 * The base scene still matters for the RECEIVER — the probe reports the mark
 * against the open road either side of it, so the ground has to be ordinary
 * road and pavement rather than a plaza or a wharf. `street` and `crowd` are
 * both ordinary, and they are two different districts on two different road
 * kinds, so agreement between them is worth something.
 */
const SHOTS = args.shot ? [String(args.shot)] : ['street', 'crowd'];

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE PLAYER IS THE FIFTH ARM, AND HE IS A SEPARATE SWITCH.
 * ────────────────────────────────────────────────────────────────────────────
 * The brother had no contact mark at all until this wave: `GroundShadows` was
 * reachable only from `peds`, and every `street`, `crowd` and `character` frame
 * this project has shot has a man standing on a pavement with pedestrians three
 * metres behind him wearing a mark he does not have. He wears one now, out of
 * THE SAME POOL as the crowd: `peds` fills and CLOSES that pool inside its own
 * `lateUpdate` and the registry sorts `player` ahead of it, so the player
 * SUBMITS an actor record into a queue `GroundShadows.begin()` leaves alone and
 * `end()` drains (he ran a second instance of the whole class for this until
 * the queue existed — two draws and 32 KiB of duplicate bake).
 *
 * His submission is still its own switch, so it still gets its own arm: one
 * more capture of the same frozen frame with `player.groundShadow` off and
 * everything else — including the crowd's pool — untouched. Everything about
 * the measurement is the ped path's: the footprint is the set of pixels that
 * MOVED between the two arms rather than a projection of the pool's own
 * transforms, the crop is centred on the DRAWN body (the character root's world
 * position, which is not a quantity the shadow code computes), the exposure
 * drift is measured on open road either side and divided out, and the
 * assertion is the operator's own invariant: a transmittance may only multiply
 * DOWN.
 *
 * It carries the same two failure modes as the ped gate, and both are checked:
 * a mark that BRIGHTENS the road (the historical lerp defect, which this pool
 * would inherit wholesale because it inherits the material), and a mark that is
 * not in the picture at all — which is what "the player has no contact shadow"
 * measured as, and what a regression in the submit path would look like.
 *
 * `--noplayer` skips the extra capture.
 */
const PLAYER = !args.noplayer;

/**
 * `--nostage` is the ABLATION for the staging, not the gate's negative control.
 *
 * Said plainly because it is easy to overclaim here: the gate's negative
 * control is and remains the `lerp` ARM, which restores the historical blend on
 * the same frozen frame and goes red at 17-77% of the footprint raised against a
 * measured noise floor. That is what proves this file can fail.
 *
 * `--nostage` keeps the same two base shots and skips only `debugStage`, which
 * is what isolates the staging's contribution. MEASURED: staged 4/4 conditions,
 * footprints 1265-9766 px; unstaged 3/4, with `street @ midday` falling under
 * the 200 px floor and reporting UNMEASURED. So the staging is worth roughly the
 * difference between a gate that measures and one that sometimes does not — the
 * honest claim, and less than the 4/4-to-0/4 swing the old default suggested,
 * because the candidate fix below is doing part of the work.
 */
const STAGE = !args.nostage;
const TIMES = args.time !== undefined
  ? [{ id: String(args.time), time: Number(args.time), weather: String(args.weather ?? 'overcast') }]
  : CONDITIONS;

/* ------------------------------------------------------------------ */
/* server + browser, cloned from tools/capture.mjs                     */
/* ------------------------------------------------------------------ */

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 5200 + Math.floor(Math.random() * 700);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const root = resolve(import.meta.dirname, '../..');
const PORT = await freePort();
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, OW_NO_HMR: '1' },
});
let up = false;
for (let i = 0; i < 160 && !up; i++) {
  await new Promise((r) => setTimeout(r, 250));
  up = await portOpen(PORT);
}
if (!up) { server.kill(); throw new Error('vite failed to start'); }

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--enable-zero-copy', '--disable-frame-rate-limit', '--force-color-profile=srgb',
    '--force-device-scale-factor=1', '--hide-scrollbars', '--mute-audio',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const pump = (n) => page.evaluate((k) => window.__PUMP__(k), n);

/* ------------------------------------------------------------------ */
/* pixel helpers                                                       */
/* ------------------------------------------------------------------ */

/** Rec.709 luminance of an sRGB byte triple, still in 0..255 display units. */
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** sRGB byte -> linear, scaled x255 so it is comparable with the values the
 *  `vehicles` shadow measurements are quoted in (9.19 -> 5.00 and so on). */
function toLinear(v) {
  const c = v / 255;
  return 255 * (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
}

function stats(png, pixels) {
  if (!pixels.length) return null;
  let sSrgb = 0, sLin = 0, min = Infinity, max = -Infinity;
  for (const i of pixels) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    const L = lum(r, g, b);
    const Ln = lum(toLinear(r), toLinear(g), toLinear(b));
    sSrgb += L; sLin += Ln;
    if (Ln < min) min = Ln;
    if (Ln > max) max = Ln;
  }
  return {
    n: pixels.length,
    srgb: +(sSrgb / pixels.length).toFixed(2),
    linear: +(sLin / pixels.length).toFixed(3),
    min: +min.toFixed(4),
    max: +max.toFixed(3),
  };
}

/* ------------------------------------------------------------------ */
/* one condition                                                       */
/* ------------------------------------------------------------------ */

const results = [];

async function run(shot, cond) {
  const url = `http://127.0.0.1:${PORT}/?capture=1&shot=${encodeURIComponent(shot)}&lockstep=1`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });

  await page.evaluate(
    ({ s, settle }) => window.__APPLY_SHOT__(s, { grabFrame: settle }),
    { s: shot, settle: SETTLE }
  );

  // Override the lighting BEFORE the settle, so the IBL rebake, the exposure
  // adaptation and the shadow cascades all converge on the condition we are
  // actually measuring rather than on the shot's own clock.
  await page.evaluate(({ t, w }) => {
    const sky = window.__ENGINE__.ctx.peek('sky');
    sky?.setTimeOfDay?.(t);
    sky?.setWeather?.(w, { immediate: true });
  }, { t: cond.time, w: cond.weather });

  /*
   * COMPOSE THE SUBJECT. See the note on `SHOTS`.
   *
   * After `__APPLY_SHOT__` (which sets the camera) and before the settle, so
   * the streaming wait, the TAA convergence and the exposure adaptation below
   * all run on the scene that is actually photographed. `debugStage` gives
   * every staged pedestrian a body and runs 30 steps of its own pose settle, so
   * the shutter cannot catch the crowd mid-blend.
   */
  let stagedInfo = null;
  if (STAGE) {
    stagedInfo = await page.evaluate(() => {
      const peds = window.__ENGINE__.ctx.peek('peds');
      if (!peds?.debugStage) return { error: 'no peds.debugStage' };
      peds.debugStage('crowd');
      let active = 0;
      let withBody = 0;
      for (const p of peds.peds) {
        if (!p.active) continue;
        active++;
        if (p.body) withBody++;
      }
      return { active, withBody };
    });
  }

  for (let f = 0; f < 1200; f++) {
    if (await page.evaluate(() => window.__SETTLED__?.() === true)) break;
    await pump(20);
    f += 19;
  }
  await pump(SETTLE);

  // Freeze. Everything after this point differs between arms ONLY by the blend.
  const frozen = await page.evaluate(({ t, w }) => {
    window.__PRESHUTTER__?.();
    const e = window.__ENGINE__;
    e.time.scale = 0;
    const sky = e.ctx.peek('sky');
    sky?.setTimeOfDay?.(t);
    sky?.setWeather?.(w, { immediate: true });
    return { hour: sky?.hour ?? null, wetness: sky?.wetness ?? null };
  }, { t: cond.time, w: cond.weather });

  /*
   * Find something to look at. The ROI comes from the pool's own instance
   * transforms — that is a search hint, not the measurement: it decides WHERE
   * to point the camera crop, and the numbers inside the crop come from the
   * framebuffer and from the between-arm difference.
   */
  const roi = await page.evaluate(({ w, h }) => {
    const e = window.__ENGINE__;
    const peds = e.ctx.peek('peds');
    const cam = e.ctx.camera;
    if (!peds?.ground) return null;
    const mesh = peds.ground.feet.mesh.count > 0
      ? peds.ground.feet.mesh
      : peds.ground.body.mesh;
    const n = mesh.count;
    if (!n) return { error: 'no ground-shadow instances in this frame' };

    const arr = mesh.instanceMatrix.array;
    const el = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
    const px = (x, y, z) => {
      const cw = el[3] * x + el[7] * y + el[11] * z + el[15];
      if (cw <= 0) return null;
      const cx = (el[0] * x + el[4] * y + el[8] * z + el[12]) / cw;
      const cy = (el[1] * x + el[5] * y + el[9] * z + el[13]) / cw;
      return { x: (cx * 0.5 + 0.5) * w, y: (1 - (cy * 0.5 + 0.5)) * h };
    };

    const found = [];
    for (let i = 0; i < n; i++) {
      const o = i * 16;
      const x = arr[o + 12], y = arr[o + 13], z = arr[o + 14];
      const p = px(x, y, z);
      if (!p) continue;
      // Only a few pixels of margin. An earlier cut demanded 120 px and so
      // skipped the ped standing at the right-hand edge of the `driving`
      // frame — which is THE ped the defect shows on — and silently measured
      // a 30 m one instead, reporting a 52 px footprint as if that were the
      // subject. A probe that quietly picks a different subject is worse than
      // one that fails.
      if (p.x < 4 || p.x > w - 4 || p.y < 4 || p.y > h - 4) continue;
      const dx = x - cam.position.x, dy = y - cam.position.y, dz = z - cam.position.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < 1.2 || d > 45) continue;
      found.push({ x, y, z, px: p.x, py: p.y, d });
    }
    if (!found.length) return { error: 'no ground-shadow instance is on screen' };
    found.sort((a, b) => a.d - b.d);

    /*
     * SEVERAL candidates, not one. Projecting inside the frame is not the same
     * as being VISIBLE — on the `combat` shot the nearest instance sits behind
     * a foreground prop, so its mark is entirely occluded and the crop contains
     * no shadow at all. The arms are whole-frame screenshots and do not depend
     * on the crop, so the caller can try each candidate against the SAME three
     * images for free and take the first that actually contains a mark.
     */
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const R = 1.1;   // ~1 m square of ground: the mark plus a margin of open
                     // road, and not so wide that a second pedestrian's mark
                     // three metres away joins the population being averaged.
    const rois = found.slice(0, 8).map((b) => {
      let minX = b.px, maxX = b.px, minY = b.py, maxY = b.py;
      for (const [ox, oz] of [[R, 0], [-R, 0], [0, R], [0, -R], [R, R], [-R, -R], [R, -R], [-R, R]]) {
        const p = px(b.x + ox, b.y, b.z + oz);
        if (!p) continue;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      return {
        dist: +b.d.toFixed(2),
        x0: Math.round(clamp(minX - 25, 0, w - 2)),
        y0: Math.round(clamp(minY - 25, 0, h - 2)),
        x1: Math.round(clamp(maxX + 25, 1, w - 1)),
        y1: Math.round(clamp(maxY + 25, 1, h - 1)),
      };
    });
    return {
      instances: { body: peds.ground.body.mesh.count, feet: peds.ground.feet.mesh.count },
      candidates: rois,
    };
  }, { w: W, h: H });

  if (!roi || roi.error) {
    results.push({ shot, cond: cond.id, staged: stagedInfo, error: roi?.error ?? 'no peds subsystem' });
    return;
  }

  /*
   * FOUR arms, and the second one is the NOISE FLOOR.
   *
   * `repeat` is `off` again — same mode, same TAA reset, same convergence, same
   * shutter. Two captures that differ only by having been taken twice bound
   * what this harness can resolve, and every threshold below is set from that
   * rather than from a number somebody liked. Without it the probe was calling
   * a handful of pixels "raised" at +2.8/255 on the `street` midday crop, which
   * is a claim about the blend that the measurement could not actually support:
   * each arm re-converges TAA from a reset, and a high-contrast edge does not
   * land on the same subpixel twice.
   *
   * This is `src/render/aoprobe.mjs` group 0's discipline applied here — the
   * floor is measured, not assumed.
   */
  const arms = {};
  for (const [name, mode] of [['off', 'off'], ['repeat', 'off'], ['lerp', 'lerp'], ['multiply', 'multiply']]) {
    await page.evaluate((m) => {
      const g = window.__ENGINE__.ctx.peek('peds').ground;
      g.setMode(m);
      const taa = window.__ENGINE__.ctx.peek('render')?.taa;
      if (taa) { taa.index = 0; taa.reset?.(); }
    }, mode);
    await pump(CONVERGE);
    const buf = await page.screenshot({ type: 'png' });
    arms[name] = PNG.sync.read(buf);
    if (KEEP) {
      mkdirSync(KEEP, { recursive: true });
      writeFileSync(join(KEEP, `${shot}-${cond.id}-${name}.png`), buf);
    }
  }
  // leave the page in the shipped mode
  await page.evaluate(() => window.__ENGINE__.ctx.peek('peds').ground.setMode('multiply'));

  /*
   * THE PLAYER ARM. One more capture of the same frozen frame, differing from
   * `multiply` by exactly one switch: his own pool. The crowd's stays on, so
   * anything a pedestrian's mark contributes to this crop is identical in both
   * images and drops out of the difference by construction.
   */
  let player = null;
  if (PLAYER) {
    const has = await page.evaluate(() => {
      const p = window.__ENGINE__.ctx.peek('player');
      if (!p?.groundShadow?.setMode) return null;
      const cam = window.__ENGINE__.ctx.camera;
      const root = p.character3D;
      if (!root) return null;
      root.updateWorldMatrix(true, false);
      const m = root.matrixWorld.elements;
      // The DRAWN body's own origin — the character root is at his feet. Not
      // `player.position` (the capsule) and emphatically not the pool's
      // instance matrices, which is the reading that would agree with itself.
      const fx = m[12], fy = m[13], fz = m[14];
      const el = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse).elements;
      const px = (x, y, z) => {
        const cw = el[3] * x + el[7] * y + el[11] * z + el[15];
        if (cw <= 0) return null;
        return {
          x: ((el[0] * x + el[4] * y + el[8] * z + el[12]) / cw * 0.5 + 0.5),
          y: (1 - ((el[1] * x + el[5] * y + el[9] * z + el[13]) / cw * 0.5 + 0.5)),
        };
      };
      const c = px(fx, fy, fz);
      if (!c) return null;
      // ~1.2 m of ground around his feet: the body blob is 0.76 m across and
      // the foot patches sit inside it.
      const R = 1.2;
      const pts = [c];
      for (const [ox, oz] of [[R, 0], [-R, 0], [0, R], [0, -R], [R, R], [-R, -R], [R, -R], [-R, R]]) {
        const q = px(fx + ox, fy, fz + oz);
        if (q) pts.push(q);
      }
      const dx = fx - cam.position.x, dy = fy - cam.position.y, dz = fz - cam.position.z;
      return {
        dist: +Math.sqrt(dx * dx + dy * dy + dz * dz).toFixed(2),
        u0: Math.min(...pts.map((q) => q.x)), u1: Math.max(...pts.map((q) => q.x)),
        v0: Math.min(...pts.map((q) => q.y)), v1: Math.max(...pts.map((q) => q.y)),
        mode: p.groundShadow.mode,
        // He is IN the crowd's pool now, so there are no instance counts of his
        // own to report — the honest pair is "did this actor go into the pool
        // on the frame being photographed" and how full that pool is.
        submitted: p.groundShadow.submitted === true,
        instances: {
          body: p.groundShadow.pool?.body.mesh.count ?? 0,
          feet: p.groundShadow.pool?.feet.mesh.count ?? 0,
        },
      };
    });
    if (!has) {
      player = { error: 'no player.groundShadow, or the body is not in this frame' };
    } else {
      await page.evaluate(() => {
        window.__ENGINE__.ctx.peek('player').groundShadow.setMode('off');
        const taa = window.__ENGINE__.ctx.peek('render')?.taa;
        if (taa) { taa.index = 0; taa.reset?.(); }
      });
      await pump(CONVERGE);
      const buf = await page.screenshot({ type: 'png' });
      arms.playerOff = PNG.sync.read(buf);
      if (KEEP) writeFileSync(join(KEEP, `${shot}-${cond.id}-playerOff.png`), buf);
      await page.evaluate(() => {
        window.__ENGINE__.ctx.peek('player').groundShadow.setMode('multiply');
        const taa = window.__ENGINE__.ctx.peek('render')?.taa;
        if (taa) { taa.index = 0; taa.reset?.(); }
      });
      await pump(CONVERGE);
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const crop = {
        dist: has.dist,
        x0: Math.round(clamp(has.u0 * W - 25, 0, W - 2)),
        x1: Math.round(clamp(has.u1 * W + 25, 1, W - 1)),
        y0: Math.round(clamp(has.v0 * H - 25, 0, H - 2)),
        y1: Math.round(clamp(has.v1 * H + 25, 1, H - 1)),
      };
      player = measurePlayer(crop, has, arms);
    }
  }

  /*
   * Take the first candidate whose crop actually contains a mark. An earlier
   * cut took the nearest candidate unconditionally, found a 0 px footprint on
   * `combat` because the subject was behind a prop, skipped every arm — and
   * still printed PASS. A gate that passes on no evidence is precisely the
   * thing ARCHITECTURE.md rule 12 is about, so an unmeasurable condition is
   * now reported as unmeasured and can never be counted as a pass.
   */
  const MIN_PX = 200;
  let out = null;
  /*
   * EVERY candidate, and keep the LARGEST footprint — not the first one over
   * the floor. The candidates are sorted nearest-first, and "nearest" is not
   * "biggest": a ped 4.6 m away can be half behind a parked car while the one
   * at 12.9 m stands in the open. Taking the first acceptable crop measured a
   * 408 px mark on `street` when an 8652 px one was in the same three frames,
   * and a footprint twenty times larger is twenty times the evidence for the
   * same three screenshots — the arms are whole-frame, so this costs nothing
   * but the arithmetic.
   */
  for (const cand of roi.candidates) {
    const m = measure(shot, cond, cand, roi.instances, arms, frozen);
    if (!out || m.footprintPx > out.footprintPx) out = m;
  }
  if (out.footprintPx < MIN_PX) {
    out.unmeasured = `no candidate crop contains a mark (best ${out.footprintPx} px of ${MIN_PX}) — ` +
      'the pool is on screen but occluded, or too small at this range';
  }
  out.tried = roi.candidates.length;
  out.staged = stagedInfo;
  out.player = player;
  results.push(out);
}

/* ------------------------------------------------------------------ */
/* the measurement                                                     */
/* ------------------------------------------------------------------ */

/**
 * The player's mark: `multiply` (his pool on) against `playerOff` (his pool
 * off, everything else identical), inside a crop centred on his DRAWN body.
 *
 * Same three disciplines as the ped path, for the same three reasons:
 *   - the FOOTPRINT is the pixels that moved between the two arms, never a
 *     projection of the pool's own instance matrices (rule 12);
 *   - the exposure DRIFT is measured on the strips either side of the mark,
 *     which his pool cannot reach, and subtracted — a few thousand darkened
 *     pixels move the metered key and the adaptation answers everywhere;
 *   - the NOISE FLOOR is measured, from `off` vs `repeat` over this same crop.
 *     Those two arms differ only by having been taken twice, and his pool was
 *     on in both, so they bound what this harness can resolve here.
 */
function measurePlayer(crop, info, arms) {
  const live = arms.multiply, offArm = arms.playerOff, a1 = arms.off, a2 = arms.repeat;
  const rw = crop.x1 - crop.x0, rh = crop.y1 - crop.y0;
  const idx = (x, y) => (y * live.width + x) * 4;
  const TH = 3;
  const mask = new Uint8Array(rw * rh);
  const blob = [];
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = idx(crop.x0 + x, crop.y0 + y);
      const d = Math.max(
        Math.abs(live.data[i] - offArm.data[i]),
        Math.abs(live.data[i + 1] - offArm.data[i + 1]),
        Math.abs(live.data[i + 2] - offArm.data[i + 2])
      );
      if (d > TH) { mask[y * rw + x] = 1; blob.push(i); }
    }
  }
  // Reference road: the crop's own margin, minus anything the mark touched.
  const side = [];
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (!mask[y * rw + x] && (x < 12 || x >= rw - 12)) side.push(idx(crop.x0 + x, crop.y0 + y));
    }
  }
  const out = {
    dist: info.dist, crop, instances: info.instances, submitted: info.submitted,
    footprintPx: blob.length,
  };
  if (!blob.length || !side.length) return out;
  const meanOf = (png, list) => {
    let s = 0;
    for (const i of list) s += lum(png.data[i], png.data[i + 1], png.data[i + 2]);
    return s / list.length;
  };
  const driftOf = (png) => meanOf(png, side) - meanOf(offArm, side);
  let floorT = 1;
  if (a1 && a2) {
    const rd = meanOf(a2, side) - meanOf(a1, side);
    for (const i of blob) {
      const d = lum(a2.data[i], a2.data[i + 1], a2.data[i + 2]) -
                lum(a1.data[i], a1.data[i + 1], a1.data[i + 2]) - rd;
      if (d > floorT) floorT = d;
    }
  }
  const drift = driftOf(live);
  let raised = 0;
  let worst = 0;
  for (const i of blob) {
    const d = lum(live.data[i], live.data[i + 1], live.data[i + 2]) -
              lum(offArm.data[i], offArm.data[i + 1], offArm.data[i + 2]) - drift;
    if (d > floorT) raised++;
    if (d > worst) worst = d;
  }
  const b = stats(live, blob);
  const bOff = stats(offArm, blob);
  const s = stats(live, side);
  out.noiseFloor = +floorT.toFixed(2);
  out.drift = +drift.toFixed(3);
  out.under = b.linear;
  out.underOff = bOff.linear;
  out.side = s.linear;
  out.delta = +(b.linear - bOff.linear).toFixed(3);
  out.ratio = +(b.linear / Math.max(1e-6, s.linear)).toFixed(3);
  out.raised = raised;
  out.raisedPct = +((100 * raised) / blob.length).toFixed(1);
  out.worst = +worst.toFixed(1);
  return out;
}

function measure(shot, cond, roi, instances, arms, frozen) {
  const off = arms.off, lerp = arms.lerp, mul = arms.multiply, rep = arms.repeat;
  const rw = roi.x1 - roi.x0, rh = roi.y1 - roi.y0;
  const idx = (x, y) => (y * off.width + x) * 4;

  /*
   * THE FOOTPRINT, from the framebuffer.
   *
   * A pixel is "the shadow" if switching the pool on moved it by more than the
   * capture's own noise. The harness is lockstep over a frozen sim, so that
   * floor is tiny; 3/255 on any channel is comfortably above it and well below
   * anything the shadow does.
   */
  const TH = 3;
  const mask = new Uint8Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const i = idx(roi.x0 + x, roi.y0 + y);
      const dL = Math.max(
        Math.abs(lerp.data[i] - off.data[i]),
        Math.abs(lerp.data[i + 1] - off.data[i + 1]),
        Math.abs(lerp.data[i + 2] - off.data[i + 2])
      );
      const dM = Math.max(
        Math.abs(mul.data[i] - off.data[i]),
        Math.abs(mul.data[i + 1] - off.data[i + 1]),
        Math.abs(mul.data[i + 2] - off.data[i + 2])
      );
      if (dL > TH || dM > TH) mask[y * rw + x] = 1;
    }
  }

  const blob = [];
  const left = [];
  const right = [];
  const SIDE = 14;            // px of open road sampled either side, per row
  for (let y = 0; y < rh; y++) {
    let lo = -1, hi = -1;
    for (let x = 0; x < rw; x++) {
      if (!mask[y * rw + x]) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    if (lo < 0) continue;
    for (let x = lo; x <= hi; x++) if (mask[y * rw + x]) blob.push(idx(roi.x0 + x, roi.y0 + y));
    for (let x = Math.max(0, lo - SIDE); x < lo; x++) {
      if (!mask[y * rw + x]) left.push(idx(roi.x0 + x, roi.y0 + y));
    }
    for (let x = hi + 1; x < Math.min(rw, hi + 1 + SIDE); x++) {
      if (!mask[y * rw + x]) right.push(idx(roi.x0 + x, roi.y0 + y));
    }
  }

  const out = {
    shot, cond: cond.id, hour: frozen.hour, roi, instances,
    footprintPx: blob.length, arms: {},
  };
  /**
   * Exposure drift for one arm, measured on the reference strips either side of
   * the mark — pixels the pool cannot reach. See the note by its use below.
   */
  const driftOf = (png) => {
    let s = 0;
    let n = 0;
    for (const src of [left, right]) {
      for (const i of src) {
        s += lum(png.data[i], png.data[i + 1], png.data[i + 2]) -
             lum(off.data[i], off.data[i + 1], off.data[i + 2]);
        n++;
      }
    }
    return n ? s / n : 0;
  };

  /*
   * The bar a raise has to clear: whatever two identical captures of the SAME
   * arm differ by over this very footprint, floored at the 1/255 the report has
   * always used. Computed before the arms are walked so every arm is judged
   * against the same, measured number — and through the SAME drift correction
   * the arms get, or the floor would be measured in different units from the
   * thing it is bounding and the repeat arm would score raised pixels against
   * its own maximum.
   */
  let floorT = 1;
  if (rep) {
    const rd = driftOf(rep);
    for (const i of blob) {
      const d = lum(rep.data[i], rep.data[i + 1], rep.data[i + 2]) -
                lum(off.data[i], off.data[i + 1], off.data[i + 2]) - rd;
      if (d > floorT) floorT = d;
    }
  }
  out.noiseFloor = +floorT.toFixed(2);
  for (const [name, png] of [['off', off], ['repeat', rep], ['lerp', lerp], ['multiply', mul]]) {
    if (!png) continue;
    const b = stats(png, blob), l = stats(png, left), r = stats(png, right);
    if (!b || !l || !r) { out.arms[name] = { error: 'empty footprint' }; continue; }
    // The framing that matters: the mark against the open road either side of it,
    // in the same frame and on the same rows.
    const side = (l.linear * l.n + r.linear * r.n) / (l.n + r.n);
    /**
     * THE INVARIANT, and the only pass/fail here.
     *
     * "Brighter than the road around it" is a symptom of the operator, and
     * comparing two DIFFERENT patches of road can always be argued with —
     * asphalt varies, one side may catch more sky, a kerb may be in the strip.
     * The operator itself is not arguable: a transmittance can only multiply
     * DOWN, so no pixel it touches may end up above where it was with the pool
     * switched off. Count the ones that do.
     *
     * 1/255 of slack, because TAA resolves a frozen frame to within well under
     * that (repeat captures of one shot land at RMSE ~3e-05).
     */
    /**
     * ...MEASURED AGAINST THE FRAME'S OWN EXPOSURE, or it is not a measurement
     * of the blend.
     *
     * The three arms are one frozen frame differing only in the blend, but the
     * renderer's AUTO-EXPOSURE meters the frame it is given: darkening a few
     * thousand pixels lowers the metered key, the adaptation opens up, and
     * every OTHER pixel in the frame comes back brighter. That drift lands
     * inside the footprint too, and it is not the shadow.
     *
     * MEASURED on `street` at midday — the reference road either side of the
     * mark, which the pool never touches, still moved +0.128 linear between the
     * `off` and `multiply` arms, and the raw count called 1.2% of the footprint
     * "raised" on a max of +2/255 with it.
     *
     * So the drift is measured where the pool cannot reach — the same left and
     * right strips the report already prints — and subtracted. What is left is
     * the only thing this gate is entitled to assert: did the BLEND raise this
     * pixel, over and above what the whole frame did. The negative control is
     * unaffected and stays loud (lerp raises the footprint by +5 to +11 against
     * drifts of a tenth), which is the check that this is a correction and not
     * an excuse.
     */
    const drift = driftOf(png);

    let raised = 0, worst = 0;
    for (const i of blob) {
      const d = lum(png.data[i], png.data[i + 1], png.data[i + 2]) -
                lum(off.data[i], off.data[i + 1], off.data[i + 2]) - drift;
      if (d > floorT) raised++;
      if (d > worst) worst = d;
    }
    out.arms[name] = {
      under: b, left: l, right: r,
      side: +side.toFixed(3),
      ratio: +(b.linear / side).toFixed(3),
      delta: +(b.linear - stats(off, blob).linear).toFixed(3),
      drift: +drift.toFixed(3),
      raised, raisedPct: +((100 * raised) / blob.length).toFixed(1),
      worst: +worst.toFixed(1),
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */

/**
 * The URL switches are what the write-up tells the next person to use, so they
 * have to be proven to work rather than assumed. The arms above drive
 * `setMode` directly (that is the only way to keep one frozen frame across
 * three shots); this checks that the documented flags reach the same place.
 * One page load, no shot, no streaming wait.
 */
let flagCheck = null;
try {
  const read = async (q) => {
    await page.goto(`http://127.0.0.1:${PORT}/?capture=1&shot=hero&lockstep=1${q}`,
      { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });
    return page.evaluate(() => window.__ENGINE__.ctx.peek('peds')?.ground?.mode ?? 'no-peds');
  };
  flagCheck = {
    none: await read(''),
    lerp: await read('&owPedShadowLerp=1'),
    off: await read('&owNoPedShadow=1'),
  };
} catch (e) {
  flagCheck = { error: String(e.message ?? e) };
}

let code = 0;
try {
  for (const shot of SHOTS) {
    for (const cond of TIMES) {
      await run(shot, cond);
    }
  }
} catch (e) {
  console.error(e.stack ?? e.message);
  console.error(logs.slice(-20).join('\n'));
  code = 1;
} finally {
  await browser.close();
  server.kill();
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

const pad = (s, n) => String(s).padEnd(n);
let fails = 0;
let measured = 0;
let playerMeasured = 0;
let playerFails = 0;
/**
 * A contact mark under a man 8-11 m from the lens is thousands of pixels — the
 * ped path's own floor is 200 px for subjects out to 45 m, and the player is
 * always the nearest figure in these two shots because they stage him. 200 is
 * therefore generous and it is the same number, deliberately: a floor that
 * differs between two measurements of the same phenomenon invites the reader to
 * wonder which one is the real bar.
 */
const PLAYER_MIN_PX = 200;
console.log('');
console.log('PED GROUND-CONTACT SHADOW — measured on the emitted frame');
console.log('linear x255; "under" = pixels the pool moved, "side" = open road on the same rows');
console.log('');
for (const r of results) {
  if (r.error) { console.log(`  ${r.shot}/${r.cond}: UNMEASURED — ${r.error}`); continue; }
  if (r.unmeasured) {
    console.log(`  ${r.shot}/${r.cond}: UNMEASURED after ${r.tried} candidate crops — ${r.unmeasured}`);
    continue;
  }
  measured++;
  console.log(
    `  ${r.shot} @ ${r.cond} (hour ${Number(r.hour).toFixed(2)}) — subject ${r.roi.dist} m away, ` +
    `crop ${r.roi.x0},${r.roi.y0}..${r.roi.x1},${r.roi.y1}, ` +
    `${r.instances.body} body + ${r.instances.feet} foot instances, footprint ${r.footprintPx} px` +
    (r.staged ? `, staged ${r.staged.active} peds (${r.staged.withBody} with bodies)` : ', BORROWED framing')
  );
  console.log(`    ${pad('arm', 10)}${pad('under', 9)}${pad('left', 9)}${pad('right', 9)}${pad('vs OFF', 9)}${pad('drift', 8)}${pad('raised', 15)}verdict`);
  for (const k of ['off', 'repeat', 'lerp', 'multiply']) {
    const a = r.arms[k];
    if (!a || a.error) { console.log(`    ${pad(k, 10)}${a?.error ?? '-'}`); continue; }
    const brightens = a.raisedPct > 0.5;
    const verdict = k === 'off' ? 'reference (pool switched off)'
      : k === 'repeat' ? `noise floor — same arm twice, bar set to +${r.noiseFloor}`
      : brightens ? 'BRIGHTENS — a shadow that lights the road' : 'darkens only';
    if (k === 'multiply' && brightens) fails++;
    if (k === 'lerp' && !brightens) fails++;   // negative control must go red
    console.log(
      `    ${pad(k, 10)}${pad(a.under.linear, 9)}${pad(a.left.linear, 9)}${pad(a.right.linear, 9)}` +
      `${pad((a.delta > 0 ? '+' : '') + a.delta, 9)}` +
      `${pad((a.drift > 0 ? '+' : '') + a.drift, 8)}` +
      `${pad(`${a.raisedPct}% (max +${a.worst})`, 15)}${verdict}`
    );
  }
  /* ---- the player's own pool ---- */
  const p = r.player;
  if (PLAYER) {
    if (!p || p.error) {
      console.log(`    ${pad('PLAYER', 10)}UNMEASURED — ${p?.error ?? 'no arm captured'}`);
      fails++;
      playerFails++;
    } else if (p.footprintPx < PLAYER_MIN_PX) {
      // This is the defect the feature exists for: a brother standing on a
      // pavement with nothing under him. An absence has to be able to fail.
      console.log(
        `    ${pad('PLAYER', 10)}NO CONTACT MARK — ${p.footprintPx} px of ${PLAYER_MIN_PX} at ` +
        `${p.dist} m, crop ${p.crop.x0},${p.crop.y0}..${p.crop.x1},${p.crop.y1}, ` +
        `submitted ${p.submitted}, pool ${p.instances.body} body + ${p.instances.feet} foot instances`
      );
      fails++;
      playerFails++;
    } else {
      const brightens = p.raisedPct > 0.5;
      if (brightens) { fails++; playerFails++; }
      playerMeasured++;
      console.log(
        `    ${pad('PLAYER', 10)}${pad(p.under, 9)}${pad(p.side, 9)}${pad('-', 9)}` +
        `${pad((p.delta > 0 ? '+' : '') + p.delta, 9)}` +
        `${pad((p.drift > 0 ? '+' : '') + p.drift, 8)}` +
        `${pad(`${p.raisedPct}% (max +${p.worst})`, 15)}` +
        `${brightens ? 'BRIGHTENS — a shadow that lights the road' : 'darkens only'}` +
        ` · ${p.footprintPx} px at ${p.dist} m, bar +${p.noiseFloor}`
      );
    }
  }
  console.log('');
}
const flagOk = flagCheck && flagCheck.none === 'multiply' &&
  flagCheck.lerp === 'lerp' && flagCheck.off === 'off';
console.log(`  URL switches: default=${flagCheck?.none} ?owPedShadowLerp=1 -> ${flagCheck?.lerp} ` +
  `?owNoPedShadow=1 -> ${flagCheck?.off}  ${flagOk ? 'OK' : 'BROKEN'}`);
if (!flagOk) fails++;
console.log('');
if (measured === 0) {
  console.log('  NO CONDITION PRODUCED A MEASURABLE FOOTPRINT — this run proves nothing.');
  fails++;
}
if (PLAYER) {
  console.log(`  PLAYER pool: ${playerMeasured}/${results.length} condition(s) with a measurable ` +
    `contact mark under the brother${playerFails ? `, ${playerFails} red` : ''}`);
  if (playerMeasured === 0) {
    console.log('  THE PLAYER HAS NO CONTACT MARK IN ANY CONDITION — this is the defect, not a harness fault.');
  }
  console.log('');
}
console.log(fails === 0
  ? `PASS (${measured} condition${measured === 1 ? '' : 's'} measured) — the fixed blend only ever ` +
    'darkens, and the reverted blend is caught.'
  : `FAIL — ${fails} check(s)`);
process.exit(code || (fails ? 1 : 0));
