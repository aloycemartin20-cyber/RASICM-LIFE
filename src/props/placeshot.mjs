#!/usr/bin/env node
/**
 * PLACE SHOT — point the lens at an arbitrary world coordinate and take the
 * picture, on the live engine.
 *
 *   node src/props/placeshot.mjs --x=306 --z=654 --dx=-40 --dz=40 --eye=6 --out=shots/cp.png
 *   node src/props/placeshot.mjs --at=fountain          a named place from PLACES
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT EXISTS AND WHY IT IS NOT A `shots.js` ENTRY
 * ────────────────────────────────────────────────────────────────────────────
 * `tools/capture.mjs` photographs a NAMED shot and the shot table lives in
 * `src/dev/shots.js`, which this directory does not own. Placement work — is
 * this lot inside a landmark, is this stop furniture on the pavement or on the
 * carriageway, does the painted ground read as paint — is judged by standing
 * at a COORDINATE the probe just computed, and a coordinate is exactly what a
 * fixed shot table cannot express. Same reasoning, and the same lens plumbing,
 * as `src/vehicles/clippershot.mjs`; that one has to spawn a hull first, this
 * one photographs whatever the city already built there.
 *
 * It is a LOOK, not a gate: it asserts only that the page booted clean and
 * that the world finished streaming before the shutter. Everything else is a
 * judgement for the eye. Kept out of every chain on cost — it boots vite.
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

/**
 * The places this wave is about, so a reviewer can re-shoot one by name. Each
 * is `{ x, z, dx, dz, eye, aim }`: the subject, the lens offset from it, the
 * eye height above the ground UNDER THE SUBJECT and the height it aims at.
 * Coordinates come from `world/plan.js`'s landmark table and from the stop
 * marks `vehicles/tram.js` plans; nothing here is eyeballed.
 */
const PLACES = {
  fountain: { x: -452, z: 46, dx: 66, dz: 74, eye: 26, aim: 6 },
  fountain_close: { x: -452, z: 46, dx: 30, dz: 34, eye: 6, aim: 4 },
  colorpark: { x: 306, z: 654, dx: 34, dz: -44, eye: 9, aim: 2.4 },
  colorpark_low: { x: 330, z: 662, dx: 26, dz: -20, eye: 2.6, aim: 1.8 },
  stop_butler: { x: 454.6, z: -386.2, dx: 22, dz: 20, eye: 7, aim: 2.2 },
  stop_foundry: { x: 754.6, z: -543.8, dx: 20, dz: 18, eye: 6.5, aim: 2.2 },
  stop_triangle: { x: -150.7, z: -83.8, dx: 20, dz: 18, eye: 6.5, aim: 2.2 },
  stop_strip: { x: 156.7, z: -227.5, dx: 20, dz: 18, eye: 6.5, aim: 2.2 },
};

const P = PLACES[opts.at] ?? {};
const AT = { x: Number(opts.x ?? P.x ?? 0), z: Number(opts.z ?? P.z ?? 0) };
const LENS = {
  dx: Number(opts.dx ?? P.dx ?? 20),
  dz: Number(opts.dz ?? P.dz ?? 20),
  eye: Number(opts.eye ?? P.eye ?? 6),
  aim: Number(opts.aim ?? P.aim ?? 2),
};
const OUT = resolve(opts.out ?? `shots/place_${opts.at ?? 'xz'}.png`);
const W = Number(opts.w ?? 1600);
const H = Number(opts.h ?? 900);
const TIME = Number(opts.time ?? 16.6);
const HUD = opts.hud === true || opts.hud === '1';

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
  const hatch = opts.hatch ? `&${encodeURIComponent(String(opts.hatch))}=1` : '';
  await page.goto(`http://127.0.0.1:${port}/?capture=1&lockstep=1${hatch}`,
    { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 240000 });

  const info = await page.evaluate(({ at, lens, time, hud }) => {
    const e = window.__ENGINE__;
    const sky = e.ctx.peek('sky');
    sky?.setTime?.(time);
    sky?.setTimeRate?.(0);
    if (!hud) e.ctx.peek('ui')?.setHudVisible?.(false);
    // LOD0 whatever the camera does — see the note in clippershot.mjs.
    e.ctx.config.q.lodBias = 0.05;
    const w = e.ctx.peek('world');
    const gy = w?.heightAt?.(at.x, at.z);
    const base = Number.isFinite(gy) ? gy : 0;
    const cam = e.ctx.camera;
    const pose = () => {
      cam.position.set(at.x + lens.dx, base + lens.eye, at.z + lens.dz);
      cam.lookAt(at.x, base + lens.aim, at.z);
    };
    pose();
    // The player is teleported ONTO the lens (every shot in this engine does),
    // which is what keeps him out of his own photograph and, more importantly,
    // is what makes the streamer resident around the subject.
    e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
    pose();
    e.__shotCam = {
      px: cam.position.x, py: cam.position.y, pz: cam.position.z,
      tx: at.x, ty: base + lens.aim, tz: at.z,
    };
    window.__HOLD__ = { at, base, lens };
    return { base: +base.toFixed(2) };
  }, { at: AT, lens: LENS, time: TIME, hud: HUD });

  let settled = false;
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => window.__SETTLED__?.() === true)) { settled = true; break; }
    await pump(20);
  }
  await pump(180);

  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const h = window.__HOLD__;
    if (e.ctx.time) e.ctx.time.scale = 0;
    e.scene.traverse((o) => {
      if (typeof o.name === 'string' && o.name.startsWith('player')) o.visible = false;
    });
    e.ctx.camera.position.set(h.at.x + h.lens.dx, h.base + h.lens.eye, h.at.z + h.lens.dz);
    e.ctx.camera.lookAt(h.at.x, h.base + h.lens.aim, h.at.z);
  });
  await pump(4);

  mkdirSync(dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT });

  const ok = (n, c, d) => { if (!c) bad++; console.log(`${c ? 'PASS' : 'FAIL'}  ${n}  ${d}`); };
  console.log(`placeshot -> ${OUT}  at (${AT.x}, ${AT.z}) ground ${info.base} m`);
  ok('the world finished streaming before the shutter', settled, `settled=${settled}`);
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
