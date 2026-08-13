#!/usr/bin/env node
/**
 * CLIPPER SHOT — a river framing of the Three Rivers Clipper, on the live
 * engine, because a 26 m two-deck hull cannot be signed off from a triangle
 * count.
 *
 *   node src/vehicles/clippershot.mjs
 *   node src/vehicles/clippershot.mjs --out=shots/clipper.png --type=clipper
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS AND WHY IT IS NOT A `shots.js` ENTRY
 * ────────────────────────────────────────────────────────────────────────────
 * `tools/capture.mjs` photographs a NAMED shot, and the shot table lives in
 * `src/dev/shots.js`, which this directory does not own. The Clipper is also
 * seeded by `game/freeroam._seedDockVehicles`, which this directory does not
 * own either — so until the seeding lands there is no Clipper anywhere in the
 * world to photograph. This harness therefore does what the seeder will do:
 * boots the real engine, spawns the real class through `vehicles.spawn` at a
 * point on the Monongahela's own published centreline, holds it there
 * kinematically, freezes the clock and takes the picture.
 *
 * It is a LOOK, not a gate — it asserts only that the class spawned, that a
 * paddle class carries its turning pivot and that a boat floats level, and
 * otherwise leaves the judgement to the eye. Kept out of every chain on cost:
 * it boots vite.
 *
 * `--type` takes any class in `CLASS_IDS`, and `--x/--z/--dx/--dz/--eye/--aim`
 * put the lens anywhere, so it doubles as the way to photograph ANY vehicle in
 * its shipping paint on a real street — which the shot table cannot do, because
 * `mkt_boyzcars` deliberately repaints the brothers' cars in their owners'
 * colours and `car` is hard-wired to the Peregrine.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { startServer } from '../../tools/lib/server.mjs';

const opts = {};
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, '').split('=');
  opts[k] = v ?? true;
}
const TYPE = opts.type ?? 'clipper';
const OUT = resolve(opts.out ?? 'shots/clipper.png');
const W = Number(opts.w ?? 1600);
const H = Number(opts.h ?? 900);

/**
 * A point on the Monongahela off the South Side, and the lens on the city side
 * of it. Both read off DESIGN.md's own river polyline (map coords x4): the Mon
 * runs (-32, 344) -> (-336, 184) through this reach.
 */
const AT = { x: Number(opts.x ?? 120), z: Number(opts.z ?? 430) };
const YAW = Number(opts.yaw ?? 2.12);
/** Lens offset from the hull: right/back/up, and the height it aims at. */
const LENS = {
  dx: Number(opts.dx ?? 12), dz: Number(opts.dz ?? 26),
  eye: Number(opts.eye ?? 8.0), aim: Number(opts.aim ?? 4.4),
};

const { port, server } = await startServer({ explicitPort: opts.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 240)));
const pump = (n) =>
  page.evaluate(
    (k) => (window.__PUMP__ ? window.__PUMP__(k)
      : new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })),
    n
  );

let bad = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/?capture=1&lockstep=1`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 240000 });

  const info = await page.evaluate(({ type, at, yaw, lens }) => {
    const e = window.__ENGINE__;
    const veh = e.ctx.peek('vehicles');
    const sky = e.ctx.peek('sky');
    sky?.setTime?.(16.6);
    sky?.setTimeRate?.(0);
    e.ctx.peek('ui')?.setHudVisible?.(false);
    /**
     * LOD0, whatever the camera ends up doing. `_selectLod` divides its 22/52/
     * 130 m bands by `q.lodBias`, so a small bias pushes every boundary past
     * the horizon. MEASURED without it: a 26 m hull filling the frame was drawn
     * at LOD2 — no railings, no mullions, no stanchions — because the chase
     * camera had wandered before the shutter and the level had already latched.
     */
    e.ctx.config.q.lodBias = 0.05;
    const cam = e.ctx.camera;
    // Lens off the port quarter, above the water, looking back at the hull with
    // the downtown skyline beyond it.
    // Everything vertical is measured from the ground/water under the SUBJECT,
    // so the same lens numbers frame a boat on the Mon and a truck on a hill.
    const w0 = e.ctx.peek('world');
    const base = Number.isFinite(w0?.heightAt?.(at.x, at.z)) ? Math.max(0, w0.heightAt(at.x, at.z)) : 0;
    cam.position.set(at.x + lens.dx, base + lens.eye, at.z + lens.dz);
    cam.lookAt(at.x, base + lens.aim, at.z);
    // The player is teleported ONTO the lens (every shot in this engine does),
    // which is also what keeps him out of his own photograph.
    e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
    cam.position.set(at.x + lens.dx, base + lens.eye, at.z + lens.dz);
    cam.lookAt(at.x, base + lens.aim, at.z);
    // `engine.__shotCam` is the engine's own camera hold — the hook every
    // entry in `src/dev/shots.js` uses to stop the chase camera reclaiming the
    // lens between the pose and the shutter.
    e.__shotCam = {
      px: cam.position.x, py: cam.position.y, pz: cam.position.z,
      tx: at.x, ty: base + lens.aim, tz: at.z,
    };
    window.__HOLD__ = { cam: cam.position.clone(), at, aim: base + lens.aim };
    /**
     * On land, stand it on the ground the world actually reports; on water,
     * just above the surface and let the buoyancy solver settle it. A hard
     * y = 1.2 is right for the river and puts a car through the floor of a
     * street that is 5 m up a Pittsburgh hill.
     */
    const w = e.ctx.peek('world');
    const gy = w?.heightAt?.(at.x, at.z);
    const spec = veh.specOf?.(type);
    const dry = spec && spec.kind !== 'boat' && Number.isFinite(gy);
    const y = dry ? gy + (spec.comY ?? 0.6) + 0.25 : 1.2;
    const v = veh.spawn(type, { x: at.x, y, z: at.z }, yaw, {});
    if (!v) return { error: 'spawn returned null' };
    window.__V__ = v;
    return {
      spawned: true,
      klass: v.spec.id,
      kind: v.spec.kind,
      paddle: !!v.spec.style.paddle,
      dims: v.spec.dims,
      rotors: (v.model?.rotors ?? []).map((r) => r.axis),
    };
  }, { type: TYPE, at: AT, yaw: YAW, lens: LENS });
  if (info.error) throw new Error(info.error);

  // Let the tiles stream, then let the hull settle onto its own waterline.
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(() => window.__SETTLED__?.() === true)) break;
    await pump(20);
  }
  await pump(360);

  const state = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const v = window.__V__;
    const h = window.__HOLD__;
    const cam = e.ctx.camera;
    cam.position.copy(h.cam);
    cam.lookAt(h.at.x, h.aim, h.at.z);
    e.ctx.peek('ui')?.setHudVisible?.(false);
    /**
     * HIDE THE PLAYER, do not move him. Every shot in this engine teleports him
     * onto the lens, which works on LAND because he then stands inside the near
     * plane. Over water he sinks to the surface instead, and the settle frames
     * left him floating in the bottom third of the frame doing the
     * breaststroke. Moving him is worse than useless — the camera is slaved to
     * him and follows wherever he goes (MEASURED: 60 m up put the lens 60 m up
     * with him and photographed the skyline). So the subject stays put, the
     * lens stays put, and his scene node goes invisible.
     */
    const hidden = [];
    e.scene.traverse((o) => {
      if (typeof o.name === 'string' && o.name.startsWith('player') && o.visible) {
        o.visible = false;
        hidden.push(o.name);
      }
    });
    window.__HIDDEN__ = hidden;
    return {
      hidden,
      y: +v.position.y.toFixed(3),
      waterY: +(v.waterY ?? 0).toFixed(3),
      roll: +((Math.asin(Math.max(-1, Math.min(1, v.quaternion ? 2 * (v.quaternion.x * v.quaternion.y + v.quaternion.z * v.quaternion.w) : 0))) * 180) / Math.PI).toFixed(2),
      wetted: +(v.wetted ?? 0).toFixed(2),
      tailPhase: +(v.tailPhase ?? 0).toFixed(3),
      lod: v.model?.lod,
    };
  });
  await pump(4);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const h = window.__HOLD__;
    if (e.ctx.time) e.ctx.time.scale = 0;
    e.scene.traverse((o) => {
      if (typeof o.name === 'string' && o.name.startsWith('player')) o.visible = false;
    });
    e.ctx.camera.position.copy(h.cam);
    e.ctx.camera.lookAt(h.at.x, h.aim, h.at.z);
  });
  await pump(4);

  mkdirSync(dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT });

  const ok = (n, c, d) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}  ${d}`); };
  console.log(`clippershot -> ${OUT}`);
  ok('the class spawns as a real vehicle', !!info.spawned, `${info.klass} ${info.dims.L}x${info.dims.W}x${info.dims.H} m`);
  if (info.paddle) {
    ok('the paddle wheel is a turning pivot on the transverse axis',
      (info.rotors ?? []).includes('x'), `rotor axes [${(info.rotors ?? []).join(',')}]`);
  }
  if (info.kind === 'boat') {
    ok('she floats — the hull is wetted and level',
      state.wetted > 0.1 && Math.abs(state.roll) < 8, JSON.stringify(state));
  } else {
    ok('it settles upright', Math.abs(state.roll) < 8, JSON.stringify(state));
  }
  ok('no page errors', errs.length === 0, errs.join(' | ') || 'none');
} catch (e) {
  bad++;
  console.log(`FAIL  harness  ${e.message}`);
  if (errs.length) console.log(errs.join('\n'));
} finally {
  await b.close();
  server?.close?.();
}
process.exit(bad ? 1 : 0);
