#!/usr/bin/env node
/**
 * AIMHIGHPROBE — can a man on foot put a round on something 50 m above him?
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT
 * ---------------------------------------------------------------------------
 * "cannot shoot at police helicopter while on foot - the view range is limited
 * and cannot aim that high."
 *
 * The police heli orbits at 40-80 m, which is 50-70 degrees above the horizon
 * at the ranges you fight it from. The third-person camera clamped at **+34
 * deg** (`VIEWS[].pitchMax`), and `weapons` fires down the CAMERA axis — it
 * casts from the lens for the convergence point and aims the muzzle at what
 * that cast found — so the clamp was not merely a framing limit. It was the
 * elevation limit of every gun in the game. There was no input a player could
 * make that sent a round 55 degrees up.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES (hard rule 12: the EMITTED artefact)
 * ---------------------------------------------------------------------------
 * A 6 m box — a helicopter is about 9 m long, so this is the conservative half
 * of one — is registered into the REAL collision world 50 m above the player
 * and 30 m in front of him, an elevation of 59 deg from the eye. Then:
 *
 *   1. The aim is driven through `rig.addLook(dYaw, dPitch)`, the same entry
 *      point `player._updateLook` hands mouse deltas to, in a CLOSED LOOP on
 *      the emitted camera quaternion — never on `pitchTarget`, which is the
 *      value the solver assigned itself and which a clamped build would happily
 *      keep reporting. The loop stops when the emitted forward is on the box or
 *      when it stops improving, so a clamp shows up as a residual angle.
 *   2. The trigger is pulled for real (`weapons.tryFire`), and the gate is an
 *      emitted `bullet:impact` landing ON THE BOX. Not a ray, not the aim
 *      vector, not `_dir` — the round's own terminal event, four subsystems
 *      downstream of the clamp this file is about.
 *   3. The emitted camera position is sampled through the whole sweep, because
 *      the other half of raising a third-person clamp is the boom swinging
 *      into the pavement (see `CAMERA.highLook`). A build that could aim at the
 *      heli from underground would fail here.
 *
 * ---------------------------------------------------------------------------
 * THE NEGATIVE CONTROL IS IN EVERY RUN
 * ---------------------------------------------------------------------------
 * The same aim and the same shot are taken twice, once with `rig.highLook`
 * false — which restores the +34 deg ceiling AND the untucked boom, i.e. the
 * build that was reported. That arm MUST stall short of the target and MUST
 * miss; if it hits, this file is measuring something other than the fix and its
 * green means nothing. `--nc=clamp` additionally disables the fix for the live
 * arm, so an operator can watch the whole probe go red.
 *
 *     node src/player/aimhighprobe.mjs
 *     node src/player/aimhighprobe.mjs --nc=clamp   # everything red, on purpose
 *     node src/player/aimhighprobe.mjs --json
 *
 * `?capture=1&q=high` is the seed, for the reason `src/weapons/tracerprobe.mjs`
 * and `src/vehicles/groundprobe.mjs` both record: `world.rng` is a fork of a
 * `Math.random()` seed unless `config.deterministic` is set, so an unseeded boot
 * regenerates the road graph and the terrain and this probe's "flat, open" site
 * would be a different piece of ground on every run.
 */
import { chromium } from 'playwright';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=?(.*)$/);
    return m ? [m[1], m[2] === '' ? true : m[2]] : [a, true];
  })
);
const NC = String(args.nc ?? '');
const JSON_OUT = !!args.json;

/** Target geometry, metres. Elevation from the eye is atan(50/30) = 59 deg. */
const UP = 50;
const OUT_ = 30;
/** Half-extent of the box. A heli is ~9 m long; 3 m half is the modest half. */
const HALF = 3;
/**
 * An impact this close to the box centre is ON the box (the box's own corner is
 * 5.2 m from its centre, so this cannot be satisfied by a near miss).
 */
const HIT_TOL = 4.2;
/** The emitted aim must get within this of the line to the target. */
const AIM_TOL_DEG = 2.0;

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });

const pump = (n) => page.evaluate(
  (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
  n
);

let report;
try {
  await page.goto(`http://127.0.0.1:${port}/?capture=1&q=high`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 420000 });
  await pump(120);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true; e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);
  });
  await pump(30);

  const out = await page.evaluate(async ({ up, out: lateral, half, nc }) => {
    const e = window.__ENGINE__;
    const wp = e.ctx.peek('weapons');
    const pl = e.ctx.peek('player');
    const phys = e.ctx.peek('physics');
    const w = e.ctx.peek('world');
    const cam = e.camera;
    const frames = (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); });

    /* Quiet, flat and open — the same firing site tracerprobe uses. */
    const RP = { x: -60, z: 250 };
    const gy = w?.walkableHeightAt?.(RP.x, RP.z) ?? 1;
    pl.teleport({ x: RP.x, y: gy + 1.2, z: RP.z }, 0);
    e.ctx.peek('police')?.clearWanted?.('probe');
    wp.unlockEverything();
    await frames(30);

    /** Axis-aligned box straight into the collision world (as feeltest does). */
    const addBox = (cx, cy, cz, h, name) => {
      const v = [
        [cx - h, cy - h, cz - h], [cx + h, cy - h, cz - h],
        [cx + h, cy + h, cz - h], [cx - h, cy + h, cz - h],
        [cx - h, cy - h, cz + h], [cx + h, cy - h, cz + h],
        [cx + h, cy + h, cz + h], [cx - h, cy + h, cz + h],
      ];
      const q = [
        [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7],
        [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0],
      ];
      const tris = new Float32Array(q.length * 2 * 9);
      let o = 0;
      for (const [a, b, c, d] of q) {
        for (const i of [a, b, c, a, c, d]) {
          tris[o++] = v[i][0]; tris[o++] = v[i][1]; tris[o++] = v[i][2];
        }
      }
      const id = phys.staticWorld.addTriangles(tris, q.length * 2, 'concrete', phys.LAYER.STATIC, name);
      phys.rebuildStatic();
      return id;
    };

    const feet = { x: pl.position.x, y: pl.position.y, z: pl.position.z };
    const yaw = pl.yaw ?? 0;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const target = {
      x: feet.x + fx * lateral,
      y: feet.y + up,
      z: feet.z + fz * lateral,
    };
    const boxId = addBox(target.x, target.y, target.z, half, 'aimhigh:target');

    const len = (a) => Math.hypot(a[0], a[1], a[2]);
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const nrm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const RAD = 180 / Math.PI;

    const camPose = () => {
      cam.updateMatrixWorld();
      const m = cam.matrixWorld.elements;
      return {
        pos: [m[12], m[13], m[14]],
        fwd: nrm([-m[8], -m[9], -m[10]]),
      };
    };

    /**
     * Drive the orbit at the target through the REAL look path, closing the
     * loop on the emitted quaternion. Returns the residual angle and the worst
     * (lowest) camera the sweep produced.
     */
    const aimAt = async (pt) => {
      let lowest = Infinity;
      let residual = Infinity;
      let elev = 0;
      for (let i = 0; i < 90; i++) {
        const { pos, fwd } = camPose();
        const want = nrm(sub([pt.x, pt.y, pt.z], pos));
        const dPitch = Math.asin(Math.max(-1, Math.min(1, want[1]))) -
          Math.asin(Math.max(-1, Math.min(1, fwd[1])));
        const dYaw = Math.atan2(-want[0], -want[2]) - Math.atan2(-fwd[0], -fwd[2]);
        const wrap = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
        // Quarter steps: `addLook` writes a TARGET the orbit filter chases, so
        // feeding the whole error every frame overshoots and rings.
        pl.rig.addLook(wrap * 0.25, dPitch * 0.25);
        await frames(2);
        const now = camPose();
        lowest = Math.min(lowest, now.pos[1]);
        residual = Math.acos(Math.max(-1, Math.min(1,
          dot(now.fwd, nrm(sub([pt.x, pt.y, pt.z], now.pos)))))) * RAD;
        elev = Math.asin(Math.max(-1, Math.min(1, now.fwd[1]))) * RAD;
        if (residual < 0.3) break;
      }
      await frames(20);
      const settled = camPose();
      lowest = Math.min(lowest, settled.pos[1]);
      return {
        residual: +residual.toFixed(2),
        elev: +elev.toFixed(2),
        lowestCamY: +(lowest - feet.y).toFixed(2),
        camY: +(settled.pos[1] - feet.y).toFixed(2),
      };
    };

    /** Aim, then pull the trigger for real and report where the rounds landed. */
    const arm = async (highLook) => {
      pl.rig.highLook = highLook;
      // Level off and give every filtered channel a clean start between arms.
      for (let i = 0; i < 60; i++) { pl.rig.addLook(0, -0.05); await frames(1); }
      await frames(40);

      pl.setAimLock?.(1);   // ADS: the tight cone, standing still
      await frames(40);
      const aim = await aimAt(target);

      const impacts = [];
      const off = e.events.on('bullet:impact', (p) => {
        if (p.exit) return;
        impacts.push([p.point.x, p.point.y, p.point.z]);
      });
      let fired = 0;
      for (let shot = 0; shot < 8; shot++) {
        for (const id of ['rifle', 'smg', 'pistol']) {
          if (wp.states.has(id)) { wp.setWeaponImmediate(id); break; }
        }
        wp.refillAll();
        await frames(3);
        wp._fireTimer = 0;
        if (wp.tryFire()) fired++;
        await frames(10);
      }
      await frames(30);
      off();
      pl.setAimLock?.(null);
      pl.rig.highLook = true;

      let best = Infinity;
      let bestPt = null;
      for (const q of impacts) {
        const d = len(sub(q, [target.x, target.y, target.z]));
        if (d < best) { best = d; bestPt = q; }
      }
      return {
        ...aim,
        fired,
        weapon: wp.current?.id ?? null,
        impacts: impacts.length,
        nearest: Number.isFinite(best) ? +best.toFixed(2) : null,
        nearestPt: bestPt ? bestPt.map((x) => +x.toFixed(1)) : null,
      };
    };

    const live = await arm(nc !== 'clamp');
    const control = await arm(false);

    phys.removeStatic?.(boxId);
    phys.rebuildStatic?.();

    return {
      site: [+feet.x.toFixed(1), +feet.y.toFixed(2), +feet.z.toFixed(1)],
      target: [+target.x.toFixed(1), +target.y.toFixed(1), +target.z.toFixed(1)],
      /** Elevation of the target from the eye, which is what a player sees. */
      elevFromEye: +(Math.atan2(up - 1.66, lateral) * RAD).toFixed(1),
      live, control,
    };
  }, { up: UP, out: OUT_, half: HALF, nc: NC });

  const rows = [];
  const gate = (name, ok, detail) => rows.push({ name, ok, detail });

  gate('the reticle reaches the target',
    out.live.residual <= AIM_TOL_DEG,
    `emitted aim is ${out.live.residual} deg off the box (want <= ${AIM_TOL_DEG}); ` +
    `emitted camera elevation ${out.live.elev} deg, target sits ${out.elevFromEye} deg above the eye`);
  gate('a round fired at it HITS it',
    out.live.nearest !== null && out.live.nearest <= HIT_TOL,
    out.live.nearest === null
      ? `${out.live.fired} rounds fired with the ${out.live.weapon}, no impact anywhere`
      : `nearest emitted bullet:impact ${out.live.nearest} m from the box centre ` +
        `(want <= ${HIT_TOL}; the box is ${HALF * 2} m across), ${out.live.impacts} impacts from ` +
        `${out.live.fired} rounds at ${out.live.nearestPt}`);
  gate('the boom never goes under the pavement getting there',
    out.live.lowestCamY > -0.25,
    `lowest emitted camera through the whole sweep ${out.live.lowestCamY} m above the feet ` +
    `(want > -0.25); at the target ${out.live.camY} m`);
  gate('NEG CONTROL: with the +34 deg ceiling back, the aim stalls short',
    out.control.residual > AIM_TOL_DEG * 2 && out.control.elev < 40,
    `reverted arm: emitted elevation ${out.control.elev} deg, ${out.control.residual} deg off the box ` +
    `(want elevation < 40 and residual > ${AIM_TOL_DEG * 2})`);
  gate('NEG CONTROL: ...and the shot misses',
    out.control.nearest === null || out.control.nearest > HIT_TOL,
    out.control.nearest === null
      ? `reverted arm: ${out.control.fired} rounds, no impact within reach of the box`
      : `reverted arm: nearest impact ${out.control.nearest} m from the box centre (want > ${HIT_TOL})`);

  report = {
    nc: NC || null,
    ...out,
    rows,
    pass: rows.every((r) => r.ok),
    errors: [...new Set(errs)].slice(0, 6),
  };
} catch (err) {
  report = { pass: false, error: String(err).slice(0, 400), errors: [...new Set(errs)].slice(0, 6) };
} finally {
  await browser.close();
  stopServer(server);
}

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else if (report.error) {
  console.log(`\nAIM ELEVATION — harness error: ${report.error}`);
} else {
  console.log(`\nAIM ELEVATION — a ${HALF * 2} m target ${UP} m up and ${OUT_} m out ` +
    `(${report.elevFromEye} deg above the eye)`);
  console.log(`  site ${report.site.join(', ')} · target ${report.target.join(', ')}` +
    (report.nc ? ` · NC=${report.nc}` : ''));
  for (const r of report.rows) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n          ${r.detail}`);
  console.log(`\n  ${report.rows.filter((r) => r.ok).length}/${report.rows.length} ` +
    `${report.pass ? '— on foot, a helicopter is a target' : '— NOT TARGETABLE'}\n`);
}
if (report.errors?.length) console.log('  page errors:', report.errors.join(' | '));
process.exit(report.pass ? 0 : 1);
