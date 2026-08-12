#!/usr/bin/env node
/**
 * WORLD — the far-field gate: what the horizon is actually standing on.
 *
 * Everything past the stream radius is drawn against the CLIPMAP, and the
 * clipmap is not the heightfield. Levels 4 and 5 point-sample `heightAt` at 32
 * and 64 m, so the surface that reaches the screen runs several metres away
 * from the field every other subsystem places on — MEASURED at 2.5 km on the
 * `farlod` pose: drawn 46.3 against 39.8 analytic, and 17.2 against 10.9. Any
 * gate that asks `heightAt` whether something is on the ground is therefore
 * asking the wrong surface, and worse, it is asking the SAME surface the
 * placement code already asked (ARCHITECTURE.md rule 12: a gate must not re-use
 * the code's own inputs). `skyprobe.mjs` seats impostors against `heightAt` and
 * then checks them against `heightAt`.
 *
 * This probe reads the DRAWN geometry instead — the clipmap's own position and
 * INDEX buffers, so even the triangulation comes from the emitted triangles and
 * not from a rule copied out of `terrainmesh.js`:
 *
 *   covered   every visible skyline impostor has drawn clipmap ground under
 *             every point of its own footprint. No ground = slabs over nothing.
 *   seated    no impostor's base plane stands clear of the HIGHEST drawn ground
 *             under that footprint. This is the "detached slab with sky under
 *             it" report, stated so that it can fail.
 *   valley    a river that leaves the map must leave through a VALLEY. From
 *             every river mouth on the map edge, out to `VALLEY_RUN` metres,
 *             some point across the corridor must still be within `WALL_MAX` of
 *             the pool. The rim used to close over the Ohio at 195 m and that
 *             wall photographed as the pale "iceberg shelf" on the western
 *             horizon in `DESIGN.md`'s own money shot.
 *
 * NEGATIVE CONTROL — `--control` runs the same three checks with the defects
 * put back: `?owNoRimNotch=1` restores the dam (see `terrain.js`), and every
 * sampled base is lifted by `CONTROL_LIFT` before it is tested. All three must
 * go RED. A control that comes back green means this file measures nothing, and
 * the run fails on that instead.
 *
 * Usage
 *   node src/world/farprobe.mjs
 *   node src/world/farprobe.mjs --control
 *   node src/world/farprobe.mjs --json=/tmp/far.json
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const CONTROL = args.control === true;

/**
 * The two poses the defect was reported from: downtown from the north-east at
 * 250 m, and the Point looking west down the Ohio. Inline shots, so this file
 * does not depend on a name in `src/dev/shots.js` staying put.
 */
const SHOTS = [
  '{"pos":[-672,250,356],"look":[-600,0,-30],"fov":56,"time":6.9,"weather":"clear","hud":false,"viewmodel":false}',
  '{"pos":[-300,130,130],"look":[-660,24,0],"fov":52,"time":6.9,"weather":"clear","hud":false,"viewmodel":false}',
];

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 300; i++) {
    const p = 5900 + Math.floor(Math.random() * 900);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = await freePort();
const root = resolve(import.meta.dirname, '../..');
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, OW_NO_HMR: '1' },
});
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (await portOpen(PORT)) break;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--js-flags=--max-old-space-size=4096'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

const reports = [];
let failure = null;
try {
  const extra = CONTROL ? '&owNoRimNotch=1' : '';
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&shot=hero${extra}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });

  for (const shot of SHOTS) {
    await page.evaluate((s) => window.__APPLY_SHOT__?.(s, { grabFrame: 90 }), shot);
    await page.evaluate(
      () =>
        new Promise((done) => {
          let i = 0;
          const tick = () => {
            if (window.__SETTLED__?.() === true) return done();
            if (++i >= 1500) return done();
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        })
    );
    reports.push(await page.evaluate(runProbe, { shot, lift: CONTROL ? 12 : 0 }));
  }
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  server.kill();
}

if (failure) {
  console.error(`[farprobe] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 8).join('\n'));
  process.exit(1);
}

if (args.json) {
  mkdirSync(dirname(resolve(String(args.json))), { recursive: true });
  writeFileSync(resolve(String(args.json)), JSON.stringify(reports, null, 2));
}

let bad = 0;
let controlBroken = 0;
for (const R of reports) {
  console.log(`\n=== ${R.pos.map((v) => v.toFixed(0)).join(',')} ===`);
  console.log(`  impostors visible ${R.visible}  clipmap levels ${R.levels}  river mouths ${R.mouths}`);
  const line = (ok, name, detail) => {
    if (!ok) bad++;
    console.log(`  ${ok ? ' ok ' : 'FAIL'} ${name.padEnd(30)} ${detail}`);
  };
  line(
    R.covered.n === 0,
    'ground under every impostor',
    `${R.covered.n}/${R.visible} have a footprint point with no drawn clipmap under it` +
      (R.covered.list.length ? `\n         ` + R.covered.list.map((f) => JSON.stringify(f)).join('\n         ') : '')
  );
  line(
    R.seated.n === 0,
    'no impostor clear of the ground',
    `${R.seated.n}/${R.visible} stand more than ${R.tol} m above the highest DRAWN ground under ` +
      `their own footprint; worst ${R.seated.worst.toFixed(1)} m` +
      (R.seated.list.length ? `\n         ` + R.seated.list.map((f) => JSON.stringify(f)).join('\n         ') : '')
  );
  line(
    R.valley.n === 0,
    'no river dammed at the map edge',
    `${R.valley.n}/${R.valley.tested} sampled steps out of a river mouth are walled off ` +
      `(nothing within +-${R.valley.halfWidth} m of the corridor under ${R.valley.wallMax} m); ` +
      `worst corridor floor ${R.valley.worst.toFixed(1)} m` +
      (R.valley.list.length ? `\n         ` + R.valley.list.map((f) => JSON.stringify(f)).join('\n         ') : '')
  );
  if (CONTROL) {
    // NOT counted into `bad`: this one is red when it PASSES, so it gets its
    // own tally. `bad` is the count the control needs to be non-zero.
    const ok = R.covered.controlNulls === 16;
    if (!ok) controlBroken++;
    console.log(
      `  ${ok ? ' ok ' : 'FAIL'} ${'coverage branch can fire'.padEnd(30)} ` +
        `${R.covered.controlNulls}/16 samples 5 km off camera are outside every clipmap level`
    );
  }
}

if (CONTROL) {
  // The control asserts the OPPOSITE: every check must have gone red.
  const ok = bad >= 3 && controlBroken === 0;
  console.log(
    ok
      ? `\nFAR-FIELD CONTROL RED as required (${bad} checks failed with the defects put back)`
      : `\nFAR-FIELD CONTROL GREEN — this gate measures nothing ` +
          `(${bad} checks failed, wanted 3+; ${controlBroken} coverage-branch checks broken)`
  );
  process.exit(ok ? 0 : 1);
}
console.log(bad === 0 ? '\nFAR-FIELD GATE PASSED' : `\nFAR-FIELD GATE FAILED (${bad} checks)`);
process.exit(bad === 0 ? 0 : 1);

// ---------------------------------------------------------------- in page --
function runProbe({ shot, lift }) {
  const E = window.__ENGINE__;
  const W = E.ctx.peek('world');
  const B = E.ctx.peek('buildings');
  const cam = E.camera;
  const tm = W.terrainMesh;

  /** Metres of daylight allowed under a base plane before it is a floating slab. */
  const TOL = 2;
  /** How far past the map edge a river must still have a valley. */
  const VALLEY_RUN = 800;
  const VALLEY_STEP = 50;
  /** Half the corridor the search looks across: a river leaves at an angle to
   *  the map edge, so the channel drifts sideways from the outward normal. */
  const VALLEY_HALF = 700;
  const WALL_MAX = 45;

  // ---- the DRAWN surface, straight out of the clipmap's buffers -----------
  //
  // The triangulation is read from the INDEX buffer rather than re-derived, so
  // nothing here is a copy of `terrainmesh.js`'s own diagonal rule.
  const N = Math.round(Math.sqrt(tm.levels[0].position.count));
  const flips = tm.levels.map((lv) => {
    const m = new Map();
    for (const layer of lv.layers) {
      const idx = layer.index.array;
      for (let k = 0; k < layer.n; k += 3) {
        const a = idx[k];
        const d1 = idx[k + 1] - a;
        const d2 = idx[k + 2] - a;
        if (d1 !== N) continue; // not the first triangle of a quad at `a`
        if (d2 === N + 1) m.set(a, 1);
        else if (d2 === 1) m.set(a, 0);
      }
    }
    return m;
  });

  const M = (N - 1) / 2;
  function drawnY(x, z) {
    for (let l = 0; l < tm.levels.length; l++) {
      const lv = tm.levels[l];
      if (!Number.isFinite(lv.cx)) continue;
      const s = lv.spacing;
      const fi = (x - (lv.cx - M * s)) / s;
      const fj = (z - (lv.cz - M * s)) / s;
      if (!(fi >= 0) || !(fj >= 0) || fi >= N - 1 || fj >= N - 1) continue;
      const i = Math.floor(fi);
      const j = Math.floor(fj);
      const a = j * N + i;
      const flip = flips[l].get(a);
      if (flip === undefined) continue; // this quad was never emitted (the hole)
      const p = lv.position.array;
      const ya = p[a * 3 + 1];
      const yb = p[(a + 1) * 3 + 1];
      const yc = p[(a + N) * 3 + 1];
      const yd = p[(a + N + 1) * 3 + 1];
      const u = fi - i;
      const v = fj - j;
      let y;
      if (flip) y = v >= u ? ya + (yc - ya) * (v - u) + (yd - ya) * u : ya + (yd - ya) * v + (yb - ya) * (u - v);
      else y = u + v <= 1 ? ya + (yc - ya) * v + (yb - ya) * u : yd + (yb - yd) * (1 - v) + (yc - yd) * (1 - u);
      return { y, level: l };
    }
    return null;
  }

  const out = {
    shot,
    pos: [cam.position.x, cam.position.y, cam.position.z],
    tol: TOL,
    levels: tm.levels.length,
    visible: 0,
    mouths: 0,
    covered: { n: 0, list: [] },
    seated: { n: 0, worst: -1e9, list: [] },
    valley: { n: 0, tested: 0, worst: -1e9, wallMax: WALL_MAX, halfWidth: VALLEY_HALF, list: [] },
  };

  // ---- 1 + 2. the impostor field against the drawn surface ----------------
  const sky = B?.skyline;
  for (let mi = 0; sky?.meshes && mi < sky.meshes.length; mi++) {
    const ent = sky.meshes[mi];
    const geo = ent.im.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const arr = ent.im.instanceMatrix.array;
    for (let i = 0; i < ent.list.length; i++) {
      const te = arr.subarray(i * 16, i * 16 + 16);
      const sx = Math.hypot(te[0], te[2]);
      const sy = Math.abs(te[5]);
      if (sx < 1e-4 || sy < 1e-4) continue; // collapsed under a streamed tile
      out.visible++;
      const baseY = te[13] + bb.min.y * sy + lift;
      let dMax = -1e9;
      let miss = 0;
      // A 7x7 grid over the ROTATED footprint. Deliberately not the grid the
      // placement code samples, and deliberately not `heightAt`.
      const S = 6;
      for (let a = 0; a <= S; a++) {
        for (let b = 0; b <= S; b++) {
          const lx = bb.min.x + ((bb.max.x - bb.min.x) * a) / S;
          const lz = bb.min.z + ((bb.max.z - bb.min.z) * b) / S;
          const d = drawnY(te[0] * lx + te[8] * lz + te[12], te[2] * lx + te[10] * lz + te[14]);
          if (!d) miss++;
          else if (d.y > dMax) dMax = d.y;
        }
      }
      const rec = {
        mesh: ent.im.name,
        i,
        x: +te[12].toFixed(0),
        z: +te[14].toFixed(0),
        dist: +Math.hypot(te[12] - cam.position.x, te[14] - cam.position.z).toFixed(0),
        baseY: +baseY.toFixed(1),
        drawnMax: dMax > -1e8 ? +dMax.toFixed(1) : null,
        miss,
      };
      if (miss) {
        out.covered.n++;
        if (out.covered.list.length < 6) out.covered.list.push(rec);
      }
      if (dMax > -1e8) {
        const over = baseY - dMax;
        if (over > out.seated.worst) out.seated.worst = over;
        if (over > TOL) {
          out.seated.n++;
          if (out.seated.list.length < 6) out.seated.list.push({ ...rec, over: +over.toFixed(1) });
        }
      }
    }
  }
  if (out.seated.worst < -1e8) out.seated.worst = 0;

  // `covered` can only fire on `drawnY` returning null, and nothing in a
  // healthy world does that — so the control proves the branch instead of the
  // symptom: a ring 5 km off the camera is outside every level by construction.
  if (lift) {
    out.covered.controlNulls = 0;
    for (let a = 0; a < 16; a++) {
      const th = (a / 16) * Math.PI * 2;
      if (!drawnY(cam.position.x + Math.cos(th) * 5000, cam.position.z + Math.sin(th) * 5000)) {
        out.covered.controlNulls++;
      }
    }
  }

  // ---- 3. every river mouth must open onto a valley ----------------------
  //
  // The mouths are FOUND, not authored here: walk the map edge and ask the
  // published `isWater`. Nothing in this check knows where a river is.
  const HALF = (W.CITY_SIZE ?? 3000) / 2;
  const pool = (x, z) => (typeof W.waterLevelAt === 'function' ? W.waterLevelAt(x, z) : 0) || 0;
  const faces = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  for (const [nx, nz] of faces) {
    // Contiguous wet runs along this face, at 20 m.
    let run = null;
    const runs = [];
    for (let t = -HALF; t <= HALF; t += 20) {
      const x = nx !== 0 ? nx * HALF : t;
      const z = nz !== 0 ? nz * HALF : t;
      if (W.isWater?.(x, z) === true) run = run ?? { a: t, b: t };
      else if (run) {
        run.b = t - 20;
        runs.push(run);
        run = null;
      }
      if (run) run.b = t;
    }
    if (run) runs.push(run);
    for (const r of runs) {
      if (r.b - r.a < 40) continue; // a puddle on the edge, not a river mouth
      out.mouths++;
      const mid = (r.a + r.b) * 0.5;
      const mx = nx !== 0 ? nx * HALF : mid;
      const mz = nz !== 0 ? nz * HALF : mid;
      const py = pool(mx, mz);
      for (let d = VALLEY_STEP; d <= VALLEY_RUN; d += VALLEY_STEP) {
        // Lowest drawn ground anywhere across the corridor at this range.
        let lo = 1e9;
        let at = null;
        for (let o = -VALLEY_HALF; o <= VALLEY_HALF; o += VALLEY_STEP) {
          // `d` runs out along the face normal, `o` along the face itself.
          const ox = mx + nx * d - nz * o;
          const oz = mz + nz * d + nx * o;
          const g = drawnY(ox, oz);
          if (g && g.y < lo) {
            lo = g.y;
            at = [Math.round(ox), Math.round(oz)];
          }
        }
        if (lo > 1e8) continue; // outside the clipmap from this camera: nothing drawn
        out.valley.tested++;
        const rise = lo - py;
        if (rise > out.valley.worst) out.valley.worst = rise;
        if (rise > WALL_MAX) {
          out.valley.n++;
          if (out.valley.list.length < 6) {
            out.valley.list.push({ mouth: [Math.round(mx), Math.round(mz)], out: d, floor: +lo.toFixed(1), at });
          }
        }
      }
    }
  }
  if (out.valley.worst < -1e8) out.valley.worst = 0;
  return out;
}
