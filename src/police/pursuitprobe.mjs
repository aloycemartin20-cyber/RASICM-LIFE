#!/usr/bin/env node
/**
 * POLICE — the pursuit does not leave a scrapyard on the grass.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS EXISTS TO CATCH
 * ────────────────────────────────────────────────────────────────────────────
 * The owner played the R2 build and filed: "cars are all over the grass as if
 * they were driving and all crashed in a similar location" — a night shot of a
 * park beside the Smithfield Street Bridge approach with about a dozen
 * vehicles, several of them cruisers with their brake lights on, scattered and
 * wrecked around one spot during a five-star chase.
 *
 * `src/police/harness.mjs` could not have caught it. It asserts on the
 * PURSUIT — do they close, do they stack, is the roadblock ahead, does the
 * meter fall — and every one of those checks is happy while eight cruisers
 * drive across a park, because driving across a park closes distance very
 * effectively. What was never measured is the STATE OF THE WORLD the chase
 * leaves behind: how many dead cars are standing on ground no road goes to.
 *
 * So this scripts a five-star chase for three minutes and censuses the map:
 *
 *   grass wrecks    cars that were driving and are going nowhere now — written
 *                   off, abandoned by their driver, or simply stopped —
 *                   standing further from the nearest carriageway than their
 *                   own half width. Measured against the ROAD GRAPH, never
 *                   against what a driver believes (ARCHITECTURE.md rule 12),
 *                   with the same overhang arithmetic
 *                   `src/traffic/harness.mjs` uses so the two numbers mean the
 *                   same thing. Parked scenery is excluded BY NAME — see the
 *                   note on the census loop
 *   offroad units    live cruiser-samples spent off the carriageway, and how
 *                   many of those were in 'direct' mode — the mechanism
 *   pile            the tightest cluster of derelicts, because "all crashed in
 *                   a similar location" is a cluster, not a count
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROL
 * ────────────────────────────────────────────────────────────────────────────
 *   node src/police/pursuitprobe.mjs --control
 *
 * flips `police.debugNoRoadHold` and `police.debugNoWreckAge` on the LIVE
 * build — the road-corridor test in `Unit._directLegal` and the shell
 * collector in `PoliceSystem._ageWrecks`. Both checks below MUST go red under
 * it; a run where they do not is a run that measured nothing.
 *
 * Usage
 *   node src/police/pursuitprobe.mjs                  (5 stars, 3 min)
 *   node src/police/pursuitprobe.mjs --minutes=1 --level=4
 *   node src/police/pursuitprobe.mjs --control --json=/tmp/pp.json
 *
 * Exit code is the number of failed assertions.
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const MINUTES = Number(args.minutes ?? 3);
const LEVEL = Number(args.level ?? 5);
const QUALITY = args.q ?? 'high';
const CONTROL = args.control === true || args.control === '1';
/** Census rate. 1 Hz is plenty for a quantity that changes on a collision. */
const HZ = 1;

let fails = 0;
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`);
};

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

let census = [];
let started = null;
let staged = null;
let wreckAfter = null;

try {
  // `capture=1` is the determinism switch — same city, same chase, same
  // verdicts. See the long note in `src/police/harness.mjs`.
  await page.goto(`http://127.0.0.1:${port}/?q=${QUALITY}&capture=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 90000 });
  await pump(page, 120);

  started = await page.evaluate(({ level, control }) => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    if (!pol) return { ok: false, reason: 'no police system' };
    e.input.frozen = true;
    e.ctx.peek('player')?.setControlEnabled?.(false);
    // The crew shoots cruisers; two brothers writing off the fleet would make
    // this a measurement of the crew rather than of the pursuit.
    e.ctx.peek('peds')?.despawnCrew?.();
    pol.debugNoRoadHold = !!control;
    pol.debugNoWreckAge = !!control;
    return pol.debugChase({ level, follow: true, maxDist: 160 });
  }, { level: LEVEL, control: CONTROL });
  if (!started.ok) throw new Error(`debugChase failed: ${started.reason}`);
  console.log(`chase started at ${started.x}, ${started.z} (${started.type}) at ${LEVEL}*` +
    `${CONTROL ? '  [NEGATIVE CONTROL: no road hold, no wreck ageing]' : ''}\n`);

  census = await record(page, MINUTES * 60, HZ);

  /* -------------------------------------------------------------------- */
  /* PHASE 2 — the shells                                                  */
  /*                                                                       */
  /* THE CHASE CANNOT EXERCISE THE COLLECTOR, and pretending otherwise is  */
  /* how a green gate measures nothing: MEASURED across both arms of the   */
  /* three-minute run, `wrecked` is 0 at every one of 180 samples — eight  */
  /* cruisers crash into things constantly and not one is written off,     */
  /* because nothing in a scripted chase shoots at them and a 900 HP body  */
  /* survives kerbs. The wreck ager therefore never had a shell to collect */
  /* and its arm of the fix was untested by phase 1.                       */
  /*                                                                       */
  /* So stage the state the owner photographed, directly: put cruisers on  */
  /* the grass, write them off, take the camera away, and watch. The fixed */
  /* build must collect every one of them; the control (`debugNoWreckAge`) */
  /* must leave every one standing. Nothing here reads police's own belief */
  /* — the census is `vehicles.vehicles`, the world's own list.            */
  /* -------------------------------------------------------------------- */
  staged = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const veh = e.ctx.peek('vehicles');
    const roads = pol.roads;
    const q = pol.quarry?.position;
    const overOf = (x, z, half) => {
      const ne = roads.nearestEdge(x, z, 90);
      return ne?.edge ? ne.dist - ne.edge.width * 0.5 - half : 99;
    };
    // Somewhere genuinely off the carriageway near the chase: walk a ring out
    // from the quarry until the road graph says the point is lawn.
    const spots = [];
    for (let r = 24; r <= 90 && spots.length < 4; r += 6) {
      for (let k = 0; k < 12 && spots.length < 4; k++) {
        const a = (k / 12) * Math.PI * 2;
        const x = q.x + Math.cos(a) * r;
        const z = q.z + Math.sin(a) * r;
        if (overOf(x, z, 1.1) < 6) continue;
        if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 8)) continue;
        spots.push({ x, z });
      }
    }
    /**
     * PHASE 2a — THE ROUTING RULE, AS EMITTED, IN A GEOMETRY THAT CANNOT DRIFT.
     *
     * The aggregate "% of cruiser-samples off the carriageway in direct mode"
     * is the right quantity and the wrong gate: MEASURED across three control
     * runs of one unchanged build it read 2.04, 1.96 and 0.80 %, because the
     * engine free-runs its own frames between the driver's round trips and a
     * three-minute chase reshuffles wholesale (the same effect
     * `src/traffic/harness.mjs` records for its collision rate). A gate that
     * green-lights a third of its own negative controls is decorative.
     *
     * So put ONE cruiser on the lawn, 34-70 m from a quarry it can see, and read
     * back the mode it EMITS (`sample().units[].mode`, rule 12 — not the
     * predicate, and not this probe's restatement of it). The straight line
     * from a car standing on grass to anywhere begins on grass, so:
     *   fixed    'path'   — get back on the network and drive round
     *   control  'direct' — the pre-fix behaviour, straight across the park
     */
    let modeUnit = -1;
    const first = pol.units.find((u) => u.active && u.vehicle);
    /**
     * The spot for THIS test has one extra requirement the wreck spots do not:
     * the quarry has to be VISIBLE from it. Every direct-mode clause is gated
     * on `los`, so a lawn behind a wall tests nothing — MEASURED, two control
     * runs in a row reported `los=false` from a spot chosen only for being off
     * the carriageway, and the arm that is supposed to fail the check reported
     * itself inconclusive instead. Ask the engine's own occlusion ray, the one
     * `_sight` will use, before committing to the spot.
     */
    /**
     * ...and the geometry is BUILT rather than found where the chase happened
     * to stop. MEASURED: searching a ring around the quarry's end position
     * found no qualifying lawn on one roll in three and the check reported
     * `modeDist 0, mode 'none'` — a test that only runs when the dice agree is
     * not a gate.
     *
     * So take the quarry to the geometry: sample road poses across the map,
     * and for each look for open ground 34-70 m away with a clear line back.
     * 34 m is outside `TUNE.directFinal` (26 — inside it the rule allows
     * direct by design and the test would be trivially green) and 70 m is
     * inside both the CHASE and FLANK direct ranges (85 / 70), so a pre-fix
     * build must improvise across it.
     */
    let modeSpot = null;
    let quarryPose = null;
    for (let attempt = 0; attempt < 24 && !modeSpot; attempt++) {
      const cand = pol.roads.sampleSpawn(pol.rng, { x: q.x, y: 0, z: q.z }, 40, 900, (ed) => !ed.rail && !ed.bridge);
      if (!cand) break;
      const cy = pol.groundAt(cand.position.x, cand.position.z, cand.position.y + 20);
      const from = { x: cand.position.x, y: cy, z: cand.position.z };
      for (let r = 34; r <= 70 && !modeSpot; r += 4) {
        for (let k = 0; k < 16 && !modeSpot; k++) {
          const a = (k / 16) * Math.PI * 2;
          const x = from.x + Math.cos(a) * r;
          const z = from.z + Math.sin(a) * r;
          if (overOf(x, z, 1.1) < 6) continue;
          const y = pol.groundAt(x, z, from.y + 30);
          if (!pol.rayVisible({ x, y, z }, from, 1.0)) continue;
          modeSpot = { x, z };
          quarryPose = { x: from.x, y: from.y, z: from.z, yaw: cand.yaw };
        }
      }
    }
    // Put the quarry on that road pose, so `_sight` and `_chooseGoal` see the
    // staged geometry and not the one the chase left behind.
    const runner = pol._runners[0]?.vehicle;
    if (modeSpot && quarryPose && runner) {
      runner.setPose(
        { x: quarryPose.x, y: quarryPose.y + runner.spec.comY + 0.05, z: quarryPose.z },
        quarryPose.yaw
      );
      runner.velocity.set(0, 0, 0);
      runner.angularVelocity.set(0, 0, 0);
      pol.quarry.refresh(pol, 0);
    }
    if (first && modeSpot) {
      const s = modeSpot;
      const v = first.vehicle;
      v.setPose(
        { x: s.x, y: pol.groundAt(s.x, s.z, v.position.y + 30) + v.spec.comY + 0.05, z: s.z },
        Math.atan2(q.x - s.x, q.z - s.z)
      );
      v.velocity.set(0, 0, 0);
      first.role = 'chase';
      first.holdPose = null;
      first._directCool = 0;
      first.path.reset();
      modeUnit = first.id;
      window.__PPMODEPOSE__ = { x: v.position.x, y: v.position.y, z: v.position.z };
      /**
       * Freeze the QUARRY too, for the length of this one test.
       *
       * It is the `ROLE.FLEE` runner and it is still driving: MEASURED, the
       * first version of this loop pinned only the cruiser and the runner
       * simply drove out of its sight cone, so the control arm reported
       * `los=false` and the test was inconclusive in the arm that is supposed
       * to fail it. A test of "what does a beached car do about a quarry it
       * can see" needs the quarry to still be there.
       */
      const r = pol._runners[0]?.vehicle;
      if (r) {
        window.__PPQPOSE__ = { x: r.position.x, y: r.position.y, z: r.position.z, yaw: r._yaw ?? 0 };
      }
    }
    window.__PPMODEUNIT__ = modeUnit;
    return {
      spots: spots.length,
      modeUnit,
      modeDist: modeSpot ? +Math.hypot(modeSpot.x - q.x, modeSpot.z - q.z).toFixed(1) : 0,
    };
  });

  /**
   * ...AND IT ONLY COUNTS ON A TICK WHERE THE CRUISER CAN SEE THE QUARRY.
   *
   * Every direct-mode clause in `_chooseGoal` is `dist < range && this.los &&
   * ...`, so a cruiser that has lost sight emits 'path' whatever the road
   * rule says. MEASURED on the first version of this phase: the fixed arm read
   * `los=false, mode='path'` — the right answer for the wrong reason, and a
   * check that would stay green with the fix reverted.
   *
   * So hold the car on its spot, facing the quarry, STEP THE ENGINE, and only
   * then read. `diag.mode` is written by `Unit.update`, so a sample taken in
   * the same round trip that moved the car describes where the car USED TO BE
   * — MEASURED, that read the control arm as 'path' (green) from a cruiser
   * that had driven back onto the road during the previous pump.
   *
   * Repeat at ~3 Hz until the engine's OWN sight pass (`_sight`, 6 Hz, real
   * occlusion ray) says it has eyes on; the verdict is taken from that tick.
   * If sight never lands, the check reports itself inconclusive rather than
   * passing.
   */
  let modeSeen = null;
  const holdPose = () => page.evaluate(() => {
    const pol = window.__ENGINE__.ctx.peek('police');
    // Both ends are pinned — see the note where the poses were taken.
    const r = pol._runners[0]?.vehicle;
    const qp = window.__PPQPOSE__;
    if (r && qp) {
      r.setPose({ x: qp.x, y: qp.y, z: qp.z }, qp.yaw);
      r.velocity.set(0, 0, 0);
      r.angularVelocity.set(0, 0, 0);
    }
    const u = pol.units.find((x) => x.id === window.__PPMODEUNIT__);
    const q = pol.quarry?.position;
    if (u?.vehicle && q) {
      const p = window.__PPMODEPOSE__;
      u.vehicle.setPose({ x: p.x, y: p.y, z: p.z }, Math.atan2(q.x - p.x, q.z - p.z));
      u.vehicle.velocity.set(0, 0, 0);
      u.vehicle.angularVelocity.set(0, 0, 0);
      /**
       * PIN THE ROLE as well as the pose. `assignRoles` runs at 2.5 Hz and
       * will make this car a flanker, an interceptor or part of a block while
       * the test is holding it still — and each of those reads a DIFFERENT
       * goal (a hold pose, not the quarry), so the two arms end up answering
       * two different questions. MEASURED: one pair separated 'direct'
       * (control, role flank) against 'path' (fixed, role block), which is the
       * right verdict for a reason the test did not control.
       */
      u.role = 'chase';
      u.holdPose = null;
      u._directCool = 0;
    }
  });
  for (let k = 0; k < 12; k++) {
    await holdPose();
    await pump(page, 20);
    modeSeen = await page.evaluate(() => {
      const pol = window.__ENGINE__.ctx.peek('police');
      const s = pol.sample();
      const su = s.units.find((x) => x.id === window.__PPMODEUNIT__);
      return su ? { mode: su.mode, los: su.los, d: su.d, role: su.role } : null;
    });
    /**
     * A USABLE TICK is eyes-on AND in a role whose direct clause is live.
     *
     * `assignRoles` runs at 2.5 Hz and will make this car an interceptor or
     * part of a block while the test holds it still, and those roles drive at
     * a HOLD POSE rather than at the quarry — a different question with a
     * different answer. CHASE (`dist < 85`) and FLANK (`dist < 70`) both read
     * the quarry and both gate on `_directLegal` at this distance, so either
     * is a fair tick and nothing else is. MEASURED: one pair separated
     * 'direct' (control, flank) against 'path' (fixed, BLOCK), which is the
     * right verdict for a reason the test did not control.
     */
    if (modeSeen?.los && (modeSeen.role === 'chase' || modeSeen.role === 'flank')) break;
  }
  console.log(`\nbeached cruiser ${staged.modeDist} m from the quarry emits mode ` +
    `'${modeSeen?.mode ?? '?'}' (los ${modeSeen?.los}, role ${modeSeen?.role})`);

  const wreckStage = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const veh = e.ctx.peek('vehicles');
    const roads = pol.roads;
    const q = pol.quarry?.position;
    const overOf = (x, z, half) => {
      const ne = roads.nearestEdge(x, z, 90);
      return ne?.edge ? ne.dist - ne.edge.width * 0.5 - half : 99;
    };
    const spots = [];
    for (let r = 24; r <= 90 && spots.length < 4; r += 6) {
      for (let k = 0; k < 12 && spots.length < 4; k++) {
        const a = (k / 12) * Math.PI * 2;
        const x = q.x + Math.cos(a) * r;
        const z = q.z + Math.sin(a) * r;
        if (overOf(x, z, 1.1) < 6) continue;
        if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 8)) continue;
        spots.push({ x, z });
      }
    }
    const placed = [];
    const units = pol.units.filter((u) => u.active && u.vehicle).slice(0, spots.length);
    for (let i = 0; i < units.length; i++) {
      const v = units[i].vehicle;
      const s = spots[i];
      v.setPose({ x: s.x, y: pol.groundAt(s.x, s.z, v.position.y + 30) + v.spec.comY + 0.05, z: s.z }, 0);
      v.velocity.set(0, 0, 0);
      // Write it off through the vehicle system, so the real
      // `vehicle:destroyed` fires and police retires the unit the real way.
      veh.damage(v, v.health + 1000, v.position.clone());
      placed.push({ x: +s.x.toFixed(1), z: +s.z.toFixed(1), dead: !!v.destroyed });
    }
    /**
     * ...and take the VIEWER away, not just the camera object.
     *
     * The collector may never delete a shell in frame, so a staged test that
     * leaves the viewer on the pile measures the visibility guard rather than
     * the timer. Setting `ctx.camera` alone does not do it: `player` owns the
     * camera and puts it back behind the player on the very next frame.
     * MEASURED on the first version of this phase — three of four shells were
     * collected and the fourth, the one nearest the player's boot pose, was
     * held by the visibility guard exactly as designed, and the check read as
     * a collector bug. So move the PLAYER, then the camera follows.
     */
    const player = e.ctx.peek('player');
    let far = null;
    for (const [lo, hi] of [[900, 1400], [600, 1800], [400, 2400]]) {
      far = pol.roads.sampleSpawn(pol.rng, { x: q.x, y: 0, z: q.z }, lo, hi, (ed) => !ed.rail);
      if (far) break;
    }
    pol._debugFollow = false;
    if (far && player?.teleport) {
      player.teleport(
        { x: far.position.x, y: pol.groundAt(far.position.x, far.position.z, far.position.y + 20) + 1.7, z: far.position.z },
        far.yaw
      );
    }
    const cam = e.ctx.camera;
    const cx = far ? far.position.x : q.x + 900;
    const cz = far ? far.position.z : q.z + 900;
    cam.position.set(cx, pol.groundAt(cx, cz, 200) + 8, cz);
    cam.lookAt(cx + 30, 0, cz + 30);
    cam.updateMatrixWorld(true);
    return {
      spots: spots.length, placed, tracked: pol._wrecks.length,
      viewerAway: far ? +Math.hypot(cx - q.x, cz - q.z).toFixed(0) : 0,
    };
  });
  staged = { ...staged, ...wreckStage, mode: modeSeen };
  console.log(`staged ${staged.placed.length} written-off cruisers on the grass ` +
    `(${staged.tracked} tracked), viewer moved ${staged.viewerAway} m away`);
  // Well past `wreckLingerOff` (20 s) and the 2 Hz ager, well short of the
  // on-road clock, so the assertion is about the OFF-ROAD rule specifically.
  await pump(page, 60 * 45);
  wreckAfter = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const pol = e.ctx.peek('police');
    const veh = e.ctx.peek('vehicles');
    const cam = e.ctx.camera.getWorldPosition(e.ctx.camera.position.clone());
    let standing = 0;
    let nearest = Infinity;
    for (const v of veh.vehicles) {
      if (!v.destroyed || !v.wasPolice) continue;
      standing++;
      nearest = Math.min(nearest, cam.distanceTo(v.position));
    }
    // The viewer's distance is printed with the verdict: a shell that is still
    // there because somebody can see it is the guard working, not a leak.
    return { standing, tracked: pol._wrecks.length, camDist: Number.isFinite(nearest) ? Math.round(nearest) : -1 };
  });

  await page.evaluate(() => window.__ENGINE__.ctx.peek('police').debugChaseStop());
} catch (err) {
  console.error('PROBE ERROR', err);
  console.error(errors.slice(-6).join('\n'));
  fails++;
} finally {
  await browser.close();
  server?.kill();
}

/* ====================================================================== */
/* ASSERTIONS                                                             */
/* ====================================================================== */

if (census.length) {
  const last = census[census.length - 1];
  const peakGrass = Math.max(...census.map((s) => s.grassWrecks));
  const peakPile = Math.max(...census.map((s) => s.pile.n));
  const unitSamples = census.reduce((n, s) => n + s.units, 0);
  const offUnit = census.reduce((n, s) => n + s.unitsOff, 0);
  const offDirect = census.reduce((n, s) => n + s.unitsOffDirect, 0);

  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'none');

  /* --- the chase was real, or nothing below means anything ----------- */
  const peakUnits = Math.max(...census.map((s) => s.units));
  check('a five-star fleet actually turned out', peakUnits >= 4,
    `peak ${peakUnits} live cruisers, level ${Math.max(...census.map((s) => s.level))}*`);

  /**
   * THE ACCEPTANCE NUMBER: zero written-off cruisers left standing on the
   * grass, measured on the staged shells of phase 2 rather than on the chase.
   *
   * The chase is the wrong instrument for this and the numbers say so — see
   * the phase 2 banner: `wrecked` is 0 at all 180 samples of BOTH arms, so
   * there was never a shell for the collector to fail on. Phase 2 makes four,
   * on the lawn, out of frame, and asks the world's own vehicle list whether
   * they are still there 45 s later.
   */
  if (wreckAfter) {
    check('written-off cruisers do not stay on the grass', wreckAfter.standing === 0,
      `${wreckAfter.standing} of ${staged.placed.length} staged shells still standing ` +
      `45 s after they were written off, with the viewer ${staged.viewerAway} m away ` +
      `(${wreckAfter.tracked} still tracked, nearest survivor ${wreckAfter.camDist} m from the camera)`);
  } else {
    check('the staged-wreck phase ran', false, 'phase 2 did not complete');
  }

  /**
   * ...and the chase's own pile, REPORTED AND NOT GATED, deliberately.
   *
   * This is the closest number to the photograph — cars that were driving and
   * have now been stopped off the carriageway for eight seconds or more, and
   * how many of them are within 30 m of each other. It is also far too noisy
   * to accept or reject a change on: `src/traffic/harness.mjs` records that
   * any behavioural change reshuffles a three-minute roll wholesale, and
   * MEASURED here across the two arms of one such roll the peak cluster read 7
   * (control) against 10 (fixed) while the mechanism metric below moved the
   * right way by 40%. Gating on a quantity that noisy would either block a
   * real fix or bless a real regression, and printing it without gating is the
   * honest version until somebody runs the replicates to ratchet it.
   *
   * The pile's coordinates are the useful part: they are where to look.
   */
  check('pile-up census (REPORTED, not a gate)', true,
    `${last.grassWrecks} cars stopped off the carriageway at the end (peak ${peakGrass}), ` +
    `tightest cluster ${last.pile.n} within 30 m` +
    (last.pile.n > 1 ? ` at ${last.pile.x}, ${last.pile.z}` : '') +
    ` (peak cluster ${peakPile}); of ${last.derelicts} stopped cars anywhere, ` +
    `${last.wrecked} are write-offs and ${last.wrecks} are tracked cruiser shells`);

  /**
   * THE MECHANISM, asserted separately so a green collector cannot buy a pass
   * for a fleet that is still driving into the park — one hoovers up what the
   * other keeps producing, and only the pair of checks tells them apart.
   *
   * Read off the STAGED geometry rather than off the chase, for the variance
   * reason in the phase 2a banner. A cruiser standing on grass 45 m from a
   * quarry it can see either holds the road network or does not, and that is
   * a fact about one tick, not an average over a roll.
   */
  const modeRole = staged?.mode?.role;
  const modeUsable = staged?.mode?.los === true && (modeRole === 'chase' || modeRole === 'flank');
  check('a cruiser on the grass rejoins the road instead of charging',
    modeUsable && staged.mode.mode === 'path',
    `beached ${staged?.modeDist ?? '?'} m out with los=${staged?.mode?.los}, ` +
    `role ${modeRole}: emitted mode '${staged?.mode?.mode ?? 'none'}'` +
    (modeUsable ? '' : '  [INCONCLUSIVE: never a tick with eyes on in a pursuing role]'));

  /**
   * ...and the same quantity over the whole chase, REPORTED. Measured across
   * three control runs of one unchanged build: 2.04 / 1.96 / 0.80 %. It is the
   * number you want to watch move, and it is not one you can gate on.
   */
  const offDirectPct = unitSamples ? (offDirect / unitSamples) * 100 : 0;
  check('improvisation off the carriageway (REPORTED, not a gate)', true,
    `${offDirectPct.toFixed(2)}% of ${unitSamples} cruiser-samples were off the carriageway ` +
    `in direct mode; ${((offUnit / Math.max(1, unitSamples)) * 100).toFixed(2)}% off it at all`);
} else if (!fails) {
  check('the probe recorded a chase', false, 'no samples');
}

if (args.json) {
  writeFileSync(String(args.json),
    JSON.stringify({ started, control: CONTROL, results, staged, wreckAfter, census }, null, 1));
  console.log(`\nwrote ${args.json}`);
}

console.log(fails === 0 ? '\nALL CHECKS PASSED' : `\n${fails} CHECK(S) FAILED`);
process.exit(Math.min(120, fails));

/* ====================================================================== */

function pump(p, frames) {
  return p.evaluate(
    (n) => new Promise((done) => {
      let i = 0;
      const tick = () => (++i >= n ? done(true) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    }),
    frames
  );
}

async function record(p, seconds, hz) {
  const out = [];
  const steps = Math.round(seconds * hz);
  for (let i = 0; i < steps; i++) {
    // A three-minute five-star chase is several minutes of wall clock. Say
    // where it is: a silent run and a hung run look identical.
    if (i && i % 30 === 0) {
      const s = out[out.length - 1];
      process.stdout.write(
        `  ${Math.round((i / steps) * 100)}%  units=${s.units} grass=${s.grassWrecks} ` +
        `shells=${s.wrecks} pile=${s.pile.n}\n`
      );
    }
    out.push(await p.evaluate(() => {
      const e = window.__ENGINE__;
      const pol = e.ctx.peek('police');
      const veh = e.ctx.peek('vehicles');
      const roads = pol.roads;
      const s = pol.sample();

      /**
       * OFF THE CARRIAGEWAY, measured exactly as `src/traffic/harness.mjs`
       * measures it: nearest graph edge, minus its half width, minus the car's
       * own half width. Nothing here reads a driver's belief about where it is.
       */
      const overOf = (v) => {
        if (!roads?.nearestEdge) return -99;
        const ne = roads.nearestEdge(v.position.x, v.position.z, 60);
        if (!ne?.edge) return 99;
        return ne.dist - ne.edge.width * 0.5 - (v.spec?.half?.x ?? 1);
      };

      /**
       * "AS IF THEY WERE DRIVING AND ALL CRASHED" — the owner's own words, and
       * the predicate is exactly that: a car THIS RUN HAS SEEN MOVING that is
       * now going nowhere.
       *
       * Two wrong predicates were tried first, and both counted the city's own
       * scenery rather than the pursuit:
       *
       *   1. "stopped and driverless" — measured on the control arm at
       *      t = 2.1 s, before a single cruiser had been dispatched, it already
       *      reported 24 wrecks on the grass. Every one was a parked car:
       *      `props` dresses kerbs and lots with them and `traffic.parking`
       *      parks its own, all legitimately off the carriageway and there on
       *      purpose.
       *   2. "...minus anything flagged parked" — still 23, because the flags
       *      only cover those two owners. `game`'s free-roam dressing, the
       *      safehouse cars and the crew's own cars are static too and carry
       *      no such flag.
       *
       * Having been observed above `MOVED` m/s needs no flag from anybody and
       * cannot be wrong about scenery: scenery never moves. It is recorded in
       * a WeakSet that outlives the sample (`window.__PPMOVED__`), so a car
       * that drove at second 4 and died at second 90 still counts at 180.
       *
       * `wrecked` splits out the ones actually written off; the rest are the
       * live cars standing on the lawn with their brake lights on, which is
       * what most of the owner's screenshot is.
       *
       * The quarry, the player's car, rolling stock and mission vehicles are
       * never derelicts.
       */
      const MOVED = 2;
      /**
       * ...and it has to have been there A WHILE. `DWELL` consecutive samples
       * (1 Hz) stopped off the carriageway before it counts.
       *
       * A car that clips a kerb while braking for a light is off the
       * carriageway by this arithmetic for a second or two, and a driver that
       * beaches itself and recovers is the recovery logic WORKING. Neither is
       * a wreck on the grass, and counting them would make the acceptance
       * number impossible to reach for reasons that have nothing to do with
       * the pursuit. Eight seconds is well past `traffic`'s own off-lane
       * recovery, and far short of the wreck-ager clocks this wave adds.
       */
      const DWELL = 8;
      const seen = (window.__PPMOVED__ = window.__PPMOVED__ ?? new WeakSet());
      const dwell = (window.__PPDWELL__ = window.__PPDWELL__ ?? new WeakMap());
      const quarry = pol.quarry?.vehicle ?? null;
      const traffic = e.ctx.peek('traffic');
      const bailed = new Set((traffic?._abandoned ?? []).map((a) => a.v));
      let grass = 0;
      let derelicts = 0;
      let wrecked = 0;
      const pts = [];
      for (const v of veh.vehicles) {
        if (!v) continue;
        if ((v.speed ?? 0) > MOVED) seen.add(v);
        if (v === quarry || v.kinematic || v.isMission) continue;
        if (!seen.has(v)) continue;
        if (veh._playerAboard?.(v)) continue;
        const scrap = v.destroyed || v.wasPolice || bailed.has(v);
        const idle = scrap || (v.speed ?? 0) <= 0.5;
        const off = idle && overOf(v) > 0.5;
        const n = off ? (dwell.get(v) ?? 0) + 1 : 0;
        dwell.set(v, n);
        if (!idle) continue;
        derelicts++;
        if (scrap) wrecked++;
        if (n >= DWELL) {
          grass++;
          pts.push([v.position.x, v.position.z]);
        }
      }

      // The tightest cluster: how many off-road derelicts sit within 30 m of
      // one of them. "All crashed in a similar location" is this number.
      let pile = { n: 0, x: 0, z: 0 };
      for (const a of pts) {
        let n = 0;
        for (const b of pts) if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 30) n++;
        if (n > pile.n) pile = { n, x: +a[0].toFixed(0), z: +a[1].toFixed(0) };
      }

      let unitsOff = 0;
      let unitsOffDirect = 0;
      for (const u of pol.units) {
        if (!u.active || !u.vehicle) continue;
        if (overOf(u.vehicle) > 0.5) {
          unitsOff++;
          if (u.diag.mode === 'direct') unitsOffDirect++;
        }
      }

      return {
        t: s.t,
        level: s.level,
        units: s.units.length,
        unitsOff,
        unitsOffDirect,
        derelicts,
        wrecked,
        grassWrecks: grass,
        wrecks: (s.wrecks ?? []).length,
        wrecksOff: (s.wrecks ?? []).filter((w) => w.off).length,
        pile,
      };
    }));
    await pump(p, Math.round(60 / hz));
  }
  return out;
}
