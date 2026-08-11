#!/usr/bin/env node
/**
 * SLOTPROBE — a transient weapon light must not black out the scene, measured
 * on EMITTED PIXELS.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 * A player fired the flare gun at night and "part of the screen went dark for
 * a moment". The renderer has a FIXED pool of `q.lightSlots` punctual lights
 * (the count is a shader permutation key, so it can never vary at runtime) and
 * `submitLight()` scores every per-frame candidate into them. Two defects in
 * `_assignLightSlots` turned one extra candidate into a scene-wide dropout:
 *
 *   1. RANK-INDEXED SLOTS. Winner ranked i was copied into pool slot i. A new
 *      high-scoring transient (the flare, near the muzzle, beats everything in
 *      its priority band) inserts at rank 0 and SHIFTS EVERY OTHER WINNER DOWN
 *      ONE SLOT. Each shifted slot sees a key change, runs its fade-out-then-
 *      adopt path, and every established practical in frame dims to black and
 *      back — even when a completely FREE slot existed for the flare.
 *   2. STRING KEYS DISCARDED. `key >= 0` is false for the string keys the
 *      callers actually pass ('flare0', 'motor3', 'emp', 'wfire2'), so those
 *      emitters fell back to a hash of their POSITION — which for a moving
 *      projectile is a NEW key every frame. The flare's own slot could never
 *      finish a crossfade, so the flare stayed dark too: the scene light was
 *      evicted and replaced by nothing.
 *
 * The fix makes slot assignment KEY-STABLE (a winner keeps the slot it already
 * holds; newcomers take free slots first) and honours string keys, so the only
 * time an established light fades is a genuine eviction by a HIGHER PRIORITY
 * band. Within a band, an incumbent cannot be evicted by a newcomer at all —
 * a contended flare falls back to its emissive shell + bloom, which is the
 * documented budget answer for every other lamp in the city.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT, AND WHY IT IS NOT CIRCULAR (rule 12)
 * ---------------------------------------------------------------------------
 * Everything asserted here is computed from PNGs of the composited frame.
 * Nothing asserts on `_pool[i].level` or any other internal the fix itself
 * writes — those are the code's own outputs and would agree with any bug.
 * The probe boots the real night shot, plants an "established practical"
 * (priority 2, the sodium-lamp band) in view, fills the remaining slots, lets
 * the crossfades converge, then injects a flying flare light through the SAME
 * public `submitLight` call ballistics uses — string key, moving position,
 * intensity 190, range 22, priority 2 — and photographs every third frame of
 * the flare's two-second life. The metric is the mean luminance of the pixel
 * region under the practical, relative to its own pre-flare baseline.
 *
 * Internal pool state IS logged per frame, but only as a diagnostic so a
 * failure names the evicted key instead of just a number.
 *
 * What input would make it fail? `?owNoSlotKeep=1` restores the rank-indexed
 * assignment and the position-hash keys exactly as shipped. The luminance
 * floor must collapse in that arm or the metric is measuring nothing.
 *
 * ---------------------------------------------------------------------------
 * THE SECOND THING THIS GATES: THE COUNT CANNOT MOVE WHILE YOU DRIVE
 * ---------------------------------------------------------------------------
 * The flare bug above is what happens when the ARBITRATION inside a fixed pool
 * is wrong. `--drive` gates the layer under it: that the pool is fixed at all.
 *
 * Both counts three bakes into every program are checked, and the SPOT count
 * is the one that had no defence. `render._enforceLightCount` pins
 * `numPointLights` with ballast; nothing pinned `numSpotLights`, and a wave
 * that promoted vehicle headlights from one host to three took it 2 -> 6 in
 * silence. MEASURED on the `night` shot at q=high, seven interleaved 90-frame
 * windows, 6 visible spot lights vs 2: p50 45.6 -> 33.5 ms. Not a compile —
 * three unrolls the spot loop over every lit fragment in the frame whatever
 * the intensities are, so it is a bill on the whole screen, every frame. The
 * owner reported it as "serious lag, main does not have this".
 *
 * So `--drive` boots the night city, puts the player in a car, drives it down
 * the road graph on an autopilot, and counts the VISIBLE punctual lights with
 * its own `traverseVisible` over the same scene three's `projectObject` walks
 * — not `render.stats`, which is the code's own bookkeeping and on the build
 * this was written to catch did not carry the spot count at all. Plus
 * `renderer.info.programs.length`, which is the emitted consequence: zero
 * programs compiled after the warm-up.
 *
 * The ceiling of 2 spot lights is the PROBE'S number, not the code's: it is
 * `main`'s shipped count, and the per-light cost above is why it may not grow.
 * Reading `vehicles.headlights.length` instead would agree with any build.
 *
 * Negative control: `?owHeadlightUnstable=1` parks an unused headlight with
 * `visible = false` instead of `intensity = 0` AND stops the player's car
 * taking the pair — the obvious implementation of both halves, and the whole
 * failure class. MEASURED on this drive: the fixed arm holds 2 for all 900
 * frames and compiles nothing, the control lands on 1 and compiles a program
 * mid-drive. Only the first half was in the first cut of this control, and it
 * could not fail: with the player always pairing, both lights are always posed
 * whatever the parking does. A control that cannot fail is the same defect as
 * a gate that cannot fail.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node src/render/slotprobe.mjs                 # measure current code
 *   node src/render/slotprobe.mjs --params=owNoSlotKeep=1   # legacy arm
 *   node src/render/slotprobe.mjs --gate          # fixed arm + negative control
 *   node src/render/slotprobe.mjs --drive         # the drive phase alone
 *   node src/render/slotprobe.mjs --json          # machine-readable series
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const DIR = resolve(args.dir ?? '/tmp/slotprobe');
const W = 960;
const H = 540;
const TIMEOUT = Number(args.timeout ?? 120000);

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Mean luminance of a PNG buffer (the screenshots are pre-clipped). */
function meanLum(buf) {
  const png = PNG.sync.read(buf);
  const { width: w, height: h, data: d } = png;
  let s = 0;
  for (let i = 0; i < w * h; i++) s += lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);
  return s / (w * h);
}

/**
 * One full run of the scenario against a live page. Returns the series and the
 * summary numbers. `extra` is appended to the URL, so the negative-control arm
 * is the same code path with one switch flipped (rule 12's control).
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
    // Freeze the sim exactly like tools/capture.mjs, so the only thing moving
    // in the two-second series is the light arbitration under test.
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
    const setup = await page.evaluate(() => {
      const e = window.__ENGINE__;
      const ctx = e.ctx;
      const r = ctx.get('render');
      const cam = ctx.camera;
      cam.updateMatrixWorld();
      const me = cam.matrixWorld.elements;
      const camP = { x: me[12], y: me[13], z: me[14] };
      const fl = Math.hypot(me[8], me[10]) || 1;
      // camera forward, flattened to XZ (camera looks down its local -Z)
      const fx = -me[8] / fl;
      const fz = -me[10] / fl;
      const rl = Math.hypot(me[0], me[2]) || 1;
      const rx = me[0] / rl;
      const rz = me[2] / rl;
      // The night shot rig is 5.0 m above the road (`onRoad.eye`).
      const groundY = camP.y - 5.0;

      // THE VICTIM: an established practical in the sodium-lamp band,
      // 16 m ahead of camera, lamp-head height. Its pool on the road is the
      // measured region.
      const A = { x: camP.x + fx * 16, y: groundY + 4.0, z: camP.z + fz * 16 };
      // Fillers occupy every remaining slot so the flare has to contend.
      const n = r.lightSlots;
      const fillers = [];
      for (let i = 0; i < Math.max(0, n - 1); i++) {
        const side = (i % 2 === 0 ? 1 : -1) * (5 + 2.5 * i);
        fillers.push({
          x: camP.x + fx * 10 + rx * side,
          y: groundY + 4.0,
          z: camP.z + fz * 10 + rz * side,
        });
      }

      const st = { flare: null, poolLog: [], victimKey: 424242 };
      const orig = r._assignLightSlots.bind(r);
      r._assignLightSlots = (dt) => {
        r.submitLight(A.x, A.y, A.z, 0xffb066, 80, 26, 2, st.victimKey);
        for (let i = 0; i < fillers.length; i++) {
          const f = fillers[i];
          r.submitLight(f.x, f.y, f.z, 0xffb066, 44, 24, 2, 5001 + i);
        }
        if (st.flare) {
          const p = st.flare;
          // EXACTLY the ballistics call: src/weapons/ballistics.js line ~622.
          r.submitLight(p.x, p.y, p.z, 0xff8a2b, 190, 22, 2, 'flare' + 0);
          const h = 1 / 60;
          p.x += p.vx * h;
          p.y += p.vy * h;
          p.z += p.vz * h;
          p.vy -= 9.8 * h;
          p.life -= h;
          if (p.life <= 0) st.flare = null;
        }
        orig(dt);
        st.poolLog.push(
          r._pool.map((s) => `${String(s.key)}:${s.light.intensity.toFixed(0)}`).join(' ')
        );
        if (st.poolLog.length > 600) st.poolLog.shift();
      };
      window.__SLOT_ST__ = st;
      window.__SLOT_FIRE__ = () => {
        st.flare = {
          x: camP.x + fx * 1.2,
          y: camP.y - 0.2,
          z: camP.z + fz * 1.2,
          vx: fx * 30,
          vy: 8,
          vz: fz * 30,
          life: 2.0,
        };
      };
      window.__SLOT_VICTIM__ = () => {
        for (let i = 0; i < r._pool.length; i++)
          if (r._pool[i].key === st.victimKey)
            return { slot: i, intensity: +r._pool[i].light.intensity.toFixed(2) };
        return null;
      };
      // Project the victim's road pool to screen for the measurement clip.
      const v = r._camPos.clone();
      v.set(A.x, groundY + 0.05, A.z);
      v.project(cam);
      return {
        slots: n,
        px: (v.x + 1) / 2,
        py: (1 - v.y) / 2,
      };
    });

    // The measured region: the road under the victim lamp.
    const cw = Math.round(W * 0.2);
    const ch = Math.round(H * 0.18);
    const clip = {
      x: Math.max(0, Math.min(W - cw, Math.round(setup.px * W - cw / 2))),
      y: Math.max(0, Math.min(H - ch, Math.round(setup.py * H - ch / 2))),
      width: cw,
      height: ch,
    };

    // Let the injected practicals win their slots and their fades converge.
    await pump(60);

    const shotL = async () => meanLum(await page.screenshot({ type: 'png', clip }));

    // Baseline: three samples, averaged.
    let base = 0;
    for (let i = 0; i < 3; i++) {
      base += await shotL();
      await pump(4);
    }
    base /= 3;
    const victimBefore = await page.evaluate(() => window.__SLOT_VICTIM__());
    if (args.save) {
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: `${DIR}/baseline${extra ? '-ctl' : ''}.png`, type: 'png' });
    }

    // Fire, then photograph every 3rd frame of the flare's 2 s life.
    await page.evaluate(() => window.__SLOT_FIRE__());
    const series = [];
    let minL = Infinity;
    let minAt = -1;
    let victimAtMin = null;
    let poolAtMin = '';
    for (let f = 0; f < 126; f += 3) {
      await pump(3);
      const L = await shotL();
      series.push(+L.toFixed(2));
      if (L < minL) {
        minL = L;
        minAt = f + 3;
        victimAtMin = await page.evaluate(() => window.__SLOT_VICTIM__());
        poolAtMin = await page.evaluate(
          () => window.__SLOT_ST__.poolLog[window.__SLOT_ST__.poolLog.length - 1]
        );
        if (args.save) {
          mkdirSync(DIR, { recursive: true });
          await page.screenshot({ path: `${DIR}/min${extra ? '-ctl' : ''}.png`, type: 'png' });
        }
      }
    }
    // Recovery: the flare is dead; the practical must come back.
    await pump(60);
    const after = await shotL();

    return {
      slots: setup.slots,
      clip,
      base: +base.toFixed(2),
      minL: +minL.toFixed(2),
      minAt,
      floor: +(minL / base).toFixed(3),
      after: +after.toFixed(2),
      recovery: +(after / base).toFixed(3),
      victimBefore,
      victimAtMin,
      poolAtMin,
      series,
    };
  } catch (e) {
    console.error(logs.slice(-40).join('\n'));
    throw e;
  } finally {
    await browser.close();
    stopServer(server);
  }
}

/** Frames of the measured drive. 900 at the fixed step is fifteen seconds. */
const DRIVE_FRAMES = Number(args.driveFrames ?? 900);
/** Frames driven BEFORE the window opens, so a lazy compile lands outside it. */
const DRIVE_WARM = 240;

/**
 * THE DRIVE PHASE. Boots the night city in lockstep, boards a car, drives it
 * down the road graph, and reports the two permutation keys and the program
 * count per frame.
 *
 * Everything per-frame runs INSIDE the page, wrapped around `engine.step`, so
 * one `__PUMP__` call covers the whole drive: sampling over the debug protocol
 * frame by frame would take longer than the drive and would let the harness's
 * own latency decide how much city got built.
 */
async function runDrive(extra) {
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
    await page.evaluate(() => window.__APPLY_SHOT__?.('night', { grabFrame: 60 }));
    let frames = 0;
    while (frames < 1200) {
      if (await page.evaluate(() => window.__SETTLED__?.() === true)) break;
      await pump(20);
      frames += 20;
    }
    await pump(60);

    // ---- put the player in a car on a lane centre -------------------------
    // Same placement `tools/playprobe.mjs` uses, and for its reasons: a car
    // spawned at yaw 0 drives into a facade, and a car taken from ambient
    // traffic is as likely to be a wreck against a kerb as a runway.
    const placed = await page.evaluate(() => {
      const e = window.__ENGINE__;
      // The shot froze input and took the camera. Give both back — this phase
      // is about a moving player, not a photograph.
      e.input.frozen = false;
      e.input.enabled = true;
      const pl = e.ctx.peek('player');
      pl?.setControlEnabled?.(true);
      const veh = e.ctx.peek('vehicles');
      const w = e.ctx.peek('world');
      const roads = w?.roads;
      const pos = pl.position;
      const hit = roads?.nearestEdge?.(pos.x, pos.z, 400);
      if (!hit?.edge) return null;
      const V = Object.getPrototypeOf(pos).constructor;
      const id = hit.edge.id ?? hit.edge;
      const lane = hit.lane ?? 0;
      const t0 = Math.min(0.5, hit.t ?? 0.5);
      const a = new V();
      const ahead = new V();
      roads.laneCenter(id, lane, t0, a);
      roads.laneCenter(id, lane, Math.min(0.9, t0 + 0.06), ahead);
      const yaw = Math.atan2(ahead.x - a.x, ahead.z - a.z);
      for (const o of veh?.vehicles ?? []) {
        if (!o?.position) continue;
        const dx = o.position.x - a.x;
        const dz = o.position.z - a.z;
        if (dx * dx + dz * dz < 18 * 18) veh.despawn(o);
      }
      const car = veh?.spawn?.('sports', { x: a.x, y: a.y + 0.6, z: a.z }, yaw, {});
      if (!car) return null;
      pl.teleport?.(
        { x: a.x + Math.cos(yaw) * 2.4, y: a.y + 1.0, z: a.z - Math.sin(yaw) * 2.4 },
        { x: 0, y: 0, z: 0 }
      );
      return [+a.x.toFixed(1), +a.z.toFixed(1)];
    });
    await pump(30);
    await page.evaluate(() => window.__ENGINE__.input._pendingDown.add('KeyF'));
    await pump(6);
    await page.evaluate(() => window.__ENGINE__.input._pendingUp.add('KeyF'));
    await pump(150);

    // ---- autopilot + per-frame sampler ------------------------------------
    const boarded = await page.evaluate(() => {
      const e = window.__ENGINE__;
      const pl = e.ctx.peek('player');
      const w = e.ctx.peek('world');
      const r = e.ctx.peek('render');
      const gl = r.renderer;
      const st = { spot: [], point: [], prog: [], speed: 0, dist: 0, last: null, on: false, fill: 0, culled: 0, pools: 0, n: 0 };
      window.__DRIVE__ = st;
      const step = e.step.bind(e);
      e.step = (now) => {
        const v = pl?.vehicle ?? pl?.currentVehicle ?? null;
        const inp = e.input;
        // Throttle held every frame: `input` consumes its pending sets per step.
        inp._pendingUp.delete('KeyW');
        inp._pendingDown.add('KeyW');
        if (v) {
          // Steer toward the lane centre a little way ahead. Without this the
          // car is into a facade in four seconds and the drive measures a
          // parked car, which cannot move a light count.
          const roads = w?.roads;
          const hit = roads?.nearestEdge?.(v.position.x, v.position.z, 120);
          if (hit?.edge) {
            const V = Object.getPrototypeOf(v.position).constructor;
            const a = st.a ?? (st.a = new V());
            roads.laneCenter(hit.edge.id ?? hit.edge, hit.lane ?? 0, Math.min(0.98, (hit.t ?? 0) + 0.1), a);
            const q = v.quaternion;
            const fx = 2 * (q.x * q.z + q.w * q.y);
            const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
            const cross = fx * (a.z - v.position.z) - fz * (a.x - v.position.x);
            inp.down.delete('KeyA');
            inp.down.delete('KeyD');
            if (cross > 1.2) inp._pendingDown.add('KeyA');
            else if (cross < -1.2) inp._pendingDown.add('KeyD');
          }
          st.speed = Math.max(st.speed, v.speed ?? 0);
          if (st.last) st.dist += Math.hypot(v.position.x - st.last[0], v.position.z - st.last[1]);
          st.last = [v.position.x, v.position.z];
        }
        const out = step(now);
        if (st.on) {
          st.prog.push(gl.info.programs.length);
          // COUNT THE SCENE, not `render.stats`.
          //
          // `stats.spotLightCount` exists and is the same number, but reading
          // it would make this gate agree with any build whose bookkeeping is
          // wrong or absent — and on the tree this was written against the
          // field did not exist at all, so `?? -1` scored a silent PASS on
          // exactly the build the gate was written to catch (rule 12). This is
          // `traverseVisible` over the same scene three's `projectObject` is
          // about to walk, which is the artefact: the lights three will bake
          // into the program key. Every tenth frame, because it is a second
          // scene walk and a count that moves stays moved.
          if (st.n++ % 10 === 0) {
            let spot = 0;
            let point = 0;
            // BALLAST IS COUNTED. `render._visit` excludes it, correctly — it
            // is topping the count UP to the lock and must not chase its own
            // tail. Three has no such distinction: a zero-intensity ballast
            // light is a visible point light and goes in the program key like
            // any other. Excluding it here made this read the number the
            // ballast is compensating FOR, which varies by design (measured
            // [12,13,14] over one drive on a build whose total never moved).
            e.scene.traverseVisible((o) => {
              if (o.isSpotLight === true) spot++;
              else if (o.isPointLight === true) point++;
            });
            st.spot.push(spot);
            st.point.push(point);
          }
          // Ground-pool fill, in whole frames, so the area budget in `render`
          // has a number off a real drive rather than off a forced worst case.
          const b = r.poolBudget;
          if (b) {
            st.fill = Math.max(st.fill, b.fill ?? 0);
            st.culled = Math.max(st.culled, b.culled ?? 0);
            st.pools = Math.max(st.pools, b.drawn ?? 0);
          }
        }
        return out;
      };
      return !!(pl?.vehicle ?? pl?.currentVehicle);
    });

    await pump(DRIVE_WARM);
    await page.evaluate(() => { window.__DRIVE__.on = true; });
    await pump(DRIVE_FRAMES);

    const d = await page.evaluate(() => {
      const st = window.__DRIVE__;
      const uniq = (a) => Array.from(new Set(a)).sort((x, y) => x - y);
      return {
        frames: st.prog.length,
        lightSamples: st.spot.length,
        spot: uniq(st.spot),
        point: uniq(st.point),
        progFirst: st.prog[0],
        progLast: st.prog[st.prog.length - 1],
        progSteps: st.prog.reduce((n, v, i) => n + (i && v !== st.prog[i - 1] ? 1 : 0), 0),
        distM: +st.dist.toFixed(0),
        maxKph: +((st.speed ?? 0) * 3.6).toFixed(0),
        poolFill: +st.fill.toFixed(2),
        poolsDrawn: st.pools,
        poolsCulled: st.culled,
      };
    });
    return { ...d, placed, boarded };
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
    `${name.padEnd(14)} slots=${r.slots} baseline=${r.base} min=${r.minL} (frame ${r.minAt}) ` +
      `floor=${r.floor} recovery=${r.recovery}`
  );
  console.log(`${''.padEnd(14)} victim slot before: ${JSON.stringify(r.victimBefore)}`);
  console.log(`${''.padEnd(14)} victim slot at min: ${JSON.stringify(r.victimAtMin)}`);
  console.log(`${''.padEnd(14)} pool at min: ${r.poolAtMin}`);
  console.log(`${''.padEnd(14)} series: ${r.series.join(' ')}`);
}

/**
 * ---------------------------------------------------------------------------
 * THE GATE
 * ---------------------------------------------------------------------------
 * RATCHETS (rule 13) — measured values beside each limit; move them DOWN
 * (tighter) when the behaviour improves, never up.
 *
 *   floor    >= 0.85   measured 0.97 fixed / 0.20 legacy. The practical's
 *                      pool holds its brightness while the flare flies.
 *   recovery >= 0.85   measured ~1.0 both arms — a dropout that heals is
 *                      still a dropout, so this alone is not the gate, but a
 *                      fix that never gives the light back must go red.
 *
 * Negative control: `owNoSlotKeep=1` restores rank-indexed assignment +
 * position-hash keys. Its floor must sit BELOW the pass limit or the metric
 * no longer measures the eviction and cannot be trusted.
 *
 * THE DRIVE PHASE adds three more, and they are COUNTS rather than times on
 * purpose: a frame-time gate on a machine shared with other agents' browser
 * probes fails for their reasons, while the count of visible lights three
 * bakes into a program is the same integer on any machine.
 *
 *   spot count   one value for the whole drive, and <= SPOT_MAX. `main` ships
 *                two; the wave that made it six cost 12.1 ms of a 17.6 ms
 *                night frame. This is the probe's ceiling, not the code's —
 *                reading `vehicles.headlights.length` would agree with any
 *                build (rule 12).
 *   point count  one value for the whole drive. `_enforceLightCount` already
 *                pins this; the assertion is here so the two keys are gated
 *                by the same probe and neither can be fixed alone.
 *   programs     zero compiled during the measured window. This is the EMITTED
 *                consequence — `renderer.info.programs.length` — rather than
 *                the counts that cause it.
 */
const FLOOR_MIN = 0.85;
const CTL_FLOOR_MAX = 0.55;
/**
 * RATCHET (rule 13). `main`'s shipped visible spot-light count, and the number
 * the fixed pool in `src/vehicles/` is sized to. Lower it if headlights ever
 * stop needing a real pair; NEVER raise it to make a run go green — at ~1.5 ms
 * per light on a 17.6 ms night frame, raising it by one is an 8 % regression
 * that this gate exists to refuse.
 */
const SPOT_MAX = 2;

function reportDrive(name, d) {
  console.log(
    `${name.padEnd(14)} frames=${d.frames} boarded=${d.boarded} drove=${d.distM} m ` +
      `peak=${d.maxKph} km/h spot=[${d.spot.join(',')}] point=[${d.point.join(',')}] ` +
      `programs ${d.progFirst}->${d.progLast} (${d.progSteps} step${d.progSteps === 1 ? '' : 's'}) ` +
      `pools<=${d.poolsDrawn} fill<=${d.poolFill} screens culled<=${d.poolsCulled}`
  );
}

if (args.gate || args.drive) {
  let bad = 0;
  const check = (ok, what) => {
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  };

  if (args.gate) {
    const fixed = await run(args.params || '');
    report('fixed', fixed);
    const legacy = await run(`owNoSlotKeep=1${args.params ? '&' + args.params : ''}`);
    report('CONTROL', legacy);
    check(
      fixed.floor >= FLOOR_MIN,
      `floor ${fixed.floor} >= ${FLOOR_MIN} — practical's pool must not drop while the flare lives`
    );
    check(
      fixed.recovery >= 0.85,
      `recovery ${fixed.recovery} >= 0.85 — the practical is back after the flare dies`
    );
    check(
      legacy.floor < CTL_FLOOR_MAX,
      `control floor ${legacy.floor} < ${CTL_FLOOR_MAX} — legacy eviction must crater the same region`
    );
  }

  const drive = await runDrive(args.params || '');
  reportDrive('drive', drive);
  check(drive.boarded === true && drive.distM > 30, `the player really drove — ${drive.distM} m covered, ${drive.maxKph} km/h peak`);
  check(drive.spot.length === 1, `visible spot lights constant across the drive — saw [${drive.spot.join(',')}]`);
  check(drive.spot[drive.spot.length - 1] <= SPOT_MAX, `visible spot lights ${drive.spot[drive.spot.length - 1]} <= ${SPOT_MAX}`);
  check(drive.point.length === 1, `visible point lights constant across the drive — saw [${drive.point.join(',')}]`);
  check(drive.progSteps === 0, `zero shader programs compiled during the drive — ${drive.progFirst} -> ${drive.progLast}`);

  // The control has to break the thing the four checks above assert, or they
  // are asserting about a build that could not have failed them.
  const ctl = await runDrive(`owHeadlightUnstable=1${args.params ? '&' + args.params : ''}`);
  reportDrive('CONTROL', ctl);
  check(
    ctl.spot.length > 1 || ctl.progSteps > 0 || ctl.spot[0] !== drive.spot[0],
    `control moves a permutation key — spot [${ctl.spot.join(',')}] vs [${drive.spot.join(',')}], ` +
      `${ctl.progSteps} program step(s)`
  );

  console.log(bad === 0 ? '\nslotprobe: OK' : `\nslotprobe: ${bad} FAILING`);
  process.exit(bad === 0 ? 0 : 1);
}

const r = await run(args.params || '');
if (args.json) console.log(JSON.stringify(r));
else report(args.params ? `[${args.params}]` : 'current', r);
