#!/usr/bin/env node
/**
 * BUILDINGS — the DOWNTOWN STREET WALL gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE REPORT THIS EXISTS FOR
 * ─────────────────────────────────────────────────────────────────────────────
 * The owner played and wrote: "downtown does not have enough buildings — make
 * it like pittsburgh (steel building, ppg, highmark tower, etc.) and buildings
 * are lining the blocks". A critic panel had already called the same ground
 * "vast unfilled fields". Both are claims about a MEASURABLE quantity — how
 * much of the Golden Triangle's block frontage has a building standing on it —
 * and neither had a number attached, so the first thing this file does is
 * produce one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT MEASURES, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 * ─────────────────────────────────────────────────────────────────────────────
 * Nothing here calls `planBuilding`, reads a lot footprint, or asks `buildings`
 * what it thinks it built. It walks the EMITTED geometry out of the live scene —
 * the same triangles the camera photographs — buckets every one of them that
 * lies in the ground-storey band into a 2 m XZ lattice, and then walks the
 * FRONTAGE of every downtown block `world` published, asking at every metre
 * whether there is a wall within reach of the kerb.
 *
 * The two inputs are therefore independent: the blocks come from `world` and
 * the walls come from the triangles. A change that moves a building off its lot
 * shows up here; a change that only edits the lot table does not.
 *
 *   wall        share of downtown block frontage, in metres, with emitted
 *               ground-storey geometry within `REACH` of the frontage line
 *   plaza       the longest UNBUILT run on any one block edge, which is the
 *               "vast unfilled field" the critic reported, in metres
 *   crowns      how many of the three Pittsburgh signature crowns
 *               (`archetypes.pghStats`) the city actually built. Zero of any of
 *               them is the failure a weighted pick can really have
 *   podium      how many downtown towers stand on a full-lot podium
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONTROL IS A SECOND PAGE LOAD, NOT A SECOND TREE
 * ─────────────────────────────────────────────────────────────────────────────
 * `?owNoPgh=1` turns the whole Pittsburgh layer off inside one build — podium,
 * shaft cut, signature crowns and the impostor field's tall mix — WITHOUT
 * re-rolling the city, because every decision it makes is drawn from the `aux`
 * side stream (see the hatch note at the top of `archetypes.js`). So the two
 * arms are the same city, the same lots and the same seed, and the delta
 * between them is the change and nothing else. A run that does not show the
 * control arm WORSE is reported as inconclusive rather than as a pass: a gate
 * that cannot be made to fail is decorative.
 *
 * Usage
 *   node src/buildings/blockprobe.mjs
 *   node src/buildings/blockprobe.mjs --json=/tmp/block.json
 *   node src/buildings/blockprobe.mjs --nocontrol      shipped arm only (fast)
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
const CONTROL = !args.nocontrol;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RATCHETS, AND THE NUMBER THEY ARE CUT FROM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * MEASURED on the tree that wrote this file, `hero` framing, all 38 downtown
 * blocks inside the 56 streamed tiles, 9154 m of block frontage:
 *
 *              shipped   ?owNoPgh=1
 *   walled      34.0%      32.9%      share of frontage metres with a wall
 *   longest      115 m      115 m     unbuilt run on one block edge
 *   podium        17          0
 *   crowns    2/6/2        0/0/0      beacon / pyramid / chateau
 *
 * A RATCHET IS A FLOOR ON DECAY, NOT A TARGET. 34% is not a good number and
 * this file does not pretend it is — setting `MIN_WALL` to the 50% that would
 * be *right* would ship a red gate that the next person turns off. It is set
 * just under what was measured, so the next wave cannot quietly lose ground,
 * and RAISED when someone earns it.
 *
 * ── WHERE THE OTHER 66% GOES, measured, because a number with no diagnosis is
 * ── an accusation rather than a finding ─────────────────────────────────────
 *
 * The nearest-wall histogram (`--blocks`) reads, in 5 m buckets from the block
 * boundary: 1404 / 498 / 630 / 612 / 484 / 331 / 167 / 89 / 68 / 78 / 74 / 60 /
 * 105. So 30% of the frontage has a wall within 5 m and there is a long tail out
 * past 30 m. Three owners, none of them this file's subsystem:
 *
 *   1. NINE of the 38 blocks hold nothing but a park or a surface car park —
 *      every metre of their perimeter, 24% of the district's blocks. That is
 *      `SUBDIV.downtown = { park: 0.05, park2: 0.07 }` in `src/world/lots.js`,
 *      rolled per block. A 12% chance produced 24% on this seed, and 12% is
 *      itself high for the densest grid in the city.
 *   2. `buildings` dropped 43 lots and TRIMMED 156 against the emitted
 *      carriageway (`stats.clipDropped` / `clipTrimmed`, `index.js`
 *      `_clipToStreets`) — a trimmed lot is pulled back off the kerb, which is
 *      a hole in the street wall by construction.
 *   3. `world/lots.js` gives downtown `width: [26, 54]` against a ~95 m block
 *      depth, so one lot is a 40 x 95 m slab and a block gets two buildings.
 *      Two buildings cannot fail gracefully: lose one to the overlap test
 *      (`MAX_COVER`) and half the block goes dark.
 *
 * What IS in this subsystem's hands is the podium — a downtown tower must not
 * step away from the pavement at the pavement — and that is what the control
 * arm's 1.1 points measure. It is the honest size of the part `buildings` owns.
 */
const MIN_WALL = 0.315;
const MAX_PLAZA = 130;
/** Every one of the three signature crowns has to exist somewhere. */
const MIN_EACH_CROWN = 1;

/** How far in from the frontage line a wall may stand and still be a street wall. */
const REACH = 6.5;
/** Sample spacing along a block edge, metres. */
const STEP = 2;

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
const server = spawn(
  resolve(root, 'node_modules/.bin/vite'),
  ['--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' } }
);
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (await portOpen(PORT)) break;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--js-flags=--max-old-space-size=4096'],
});

let failure = null;
const arms = {};
try {
  arms.shipped = await measure('');
  if (CONTROL) arms.control = await measure('&owNoPgh=1');
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  server.kill();
}

if (failure) {
  console.error(failure);
  process.exit(1);
}

async function measure(extra) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&shot=hero${extra}`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 240000 });
  // Stand the camera on a Golden Triangle avenue and let the whole district
  // stream in before a single triangle is counted. `__SETTLED__` is the same
  // gate `tools/capture.mjs` refuses to press the shutter without.
  await page.evaluate(() => window.__APPLY_SHOT__?.('hero', { grabFrame: 90 }));
  await page.evaluate(
    () =>
      new Promise((done) => {
        let i = 0;
        const tick = () => {
          if (window.__SETTLED__?.() === true) return done();
          if (++i >= 2000) return done();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })
  );
  const stats = await page.evaluate(async () => {
    const mod = await import('/src/buildings/archetypes.js');
    return JSON.parse(JSON.stringify(mod.pghStats ?? {}));
  });
  const R = await page.evaluate(runProbe, { reach: REACH, step: STEP, lo: Number(args.lo ?? 1.2), hi: Number(args.hi ?? 11) });
  /**
   * THE MACHINE-IMMUNE HALF OF THE COST. `tools/perfcheck.mjs` measures
   * milliseconds, and on a box that is also running four other probes a
   * millisecond is a property of the load average rather than of the code (its
   * own header records a 70% swing on one unchanged tree). Draw calls, merged
   * triangles and distinct surface keys are not: they are the same integers on
   * any machine, they are what the change actually added, and the two arms here
   * are the same city in the same framing, so the delta between them is exact.
   */
  R.cost = await page.evaluate(() => {
    const E = window.__ENGINE__;
    const bs = E.ctx.peek('buildings');
    const keys = new Set();
    let meshes = 0;
    let tris = 0;
    (E.ctx.scene.getObjectByName('buildings') ?? { traverse() {} }).traverse((o) => {
      if (!(o.isMesh || o.isInstancedMesh)) return;
      meshes++;
      const g = o.geometry;
      const n = g?.getIndex() ? g.getIndex().count : (g?.getAttribute('position')?.count ?? 0);
      tris += (n / 3) * (o.isInstancedMesh ? o.count : 1);
      if (o.material?.name) keys.add(o.material.name);
    });
    return {
      meshes,
      tris: Math.round(tris),
      surfaces: keys.size,
      stats: JSON.parse(JSON.stringify(bs?.stats ?? {})),
      skyMeshes: bs?.skyline?.meshes?.length ?? 0,
    };
  });
  R.pgh = stats;
  R.errors = errors;
  await page.close();
  return R;
}

/* ------------------------------------------------------------- in page ---- */
function runProbe({ reach, step, lo, hi }) {
  const E = window.__ENGINE__;
  const w = E.ctx.peek('world');
  const scene = E.ctx.scene;
  scene.updateMatrixWorld(true);

  /**
   * Every emitted triangle that could be a ground-storey wall, hashed into a
   * 2 m XZ lattice. "Could be" is deliberately generous — this asks whether
   * ANY building mass stands at the kerb, not whether it is a wall panel — so
   * an archetype that builds its frontage out of piers and glazing counts, and
   * so does a landmark that builds it out of a stone range.
   */
  const CELL = 4;
  const grid = new Map();
  const key = (cx, cz) => cx * 73856093 ^ (cz * 19349663);
  let tris = 0;
  const roots = [];
  scene.traverse((o) => {
    if (o.isMesh && o.geometry) roots.push(o);
  });
  const P = new Float32Array(9);
  const srcs = new Map();
  for (const m of roots) {
    // Only the buildings subsystem: `world` paves the pavement and `props`
    // stands bins on it, and neither is a street wall.
    let sub = m;
    let owner = null;
    while (sub) {
      if (sub.name === 'buildings' || sub.userData?.subsystem === 'buildings') owner = sub;
      sub = sub.parent;
    }
    if (!owner && !/^(lot|lm_|tile|building)/.test(m.name || '')) continue;
    {
      let top = m;
      while (top.parent && top.parent.parent) top = top.parent;
      const nm = top.name || '(unnamed)';
      srcs.set(nm, (srcs.get(nm) ?? 0) + 1);
    }
    const g = m.geometry;
    const pos = g.getAttribute('position');
    if (!pos) continue;
    const idx = g.getIndex();
    const n = idx ? idx.count : pos.count;
    const mw = m.matrixWorld.elements;
    const count = m.isInstancedMesh ? m.count : 1;
    for (let inst = 0; inst < count; inst++) {
      let e = mw;
      if (m.isInstancedMesh) {
        const im = m.instanceMatrix.array;
        const o = inst * 16;
        // world = meshMatrix * instanceMatrix, both column-major
        e = new Array(16);
        for (let c = 0; c < 4; c++) {
          for (let r2 = 0; r2 < 4; r2++) {
            let s = 0;
            for (let k = 0; k < 4; k++) s += mw[k * 4 + r2] * im[o + c * 4 + k];
            e[c * 4 + r2] = s;
          }
        }
      }
      for (let i = 0; i < n; i += 3) {
        let ok = false;
        for (let v = 0; v < 3; v++) {
          const vi = idx ? idx.getX(i + v) : i + v;
          const x = pos.getX(vi);
          const y = pos.getY(vi);
          const z = pos.getZ(vi);
          const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
          const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
          const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
          P[v * 3] = wx;
          P[v * 3 + 1] = wy;
          P[v * 3 + 2] = wz;
          ok = true;
        }
        if (!ok) continue;
        // The ground-storey band, measured off the surface a man stands on so
        // the test is height-correct on a hill.
        const cx0 = (P[0] + P[3] + P[6]) / 3;
        const cz0 = (P[2] + P[5] + P[8]) / 3;
        const cy0 = (P[1] + P[4] + P[7]) / 3;
        const gY = w.walkableHeightAt ? w.walkableHeightAt(cx0, cz0) : 0;
        if (!(cy0 > gY + lo && cy0 < gY + hi)) continue;
        tris++;
        const gx = Math.floor(cx0 / CELL);
        const gz = Math.floor(cz0 / CELL);
        const k = key(gx, gz);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push(cx0, cz0);
      }
    }
  }

  const dist2 = (x, z, r) => {
    const c0 = Math.floor((x - r) / CELL);
    const c1 = Math.floor((x + r) / CELL);
    const d0 = Math.floor((z - r) / CELL);
    const d1 = Math.floor((z + r) / CELL);
    let best = r * r;
    for (let d = d0; d <= d1; d++) {
      for (let c = c0; c <= c1; c++) {
        const l = grid.get(key(c, d));
        if (!l) continue;
        for (let i = 0; i < l.length; i += 2) {
          const dx = l[i] - x;
          const dz = l[i + 1] - z;
          const q = dx * dx + dz * dz;
          if (q < best) best = q;
        }
      }
    }
    return Math.sqrt(best);
  };
  const hist = new Array(13).fill(0);
  const near = (x, z, r) => {
    const c0 = Math.floor((x - r) / CELL);
    const c1 = Math.floor((x + r) / CELL);
    const d0 = Math.floor((z - r) / CELL);
    const d1 = Math.floor((z + r) / CELL);
    const r2 = r * r;
    for (let d = d0; d <= d1; d++) {
      for (let c = c0; c <= c1; c++) {
        const l = grid.get(key(c, d));
        if (!l) continue;
        for (let i = 0; i < l.length; i += 2) {
          const dx = l[i] - x;
          const dz = l[i + 1] - z;
          if (dx * dx + dz * dz < r2) return true;
        }
      }
    }
    return false;
  };

  /**
   * ---- which blocks are measurable ----------------------------------------
   *
   * ONLY THE BLOCKS THE GAME HAS ACTUALLY BUILT. `world.blocks` covers the whole
   * district; `buildings.tiles` is the set of tiles inside the stream radius
   * that have been generated. Downtown is 800 m across and the radius is not,
   * so measuring the whole table scores every un-streamed block as 0% walled
   * and reports a stream boundary as a missing city.
   *
   * This is NOT the circular version of the test. A loaded tile with an empty
   * block on it still counts every metre of that block's frontage as unwalled —
   * which is exactly the defect being measured. What is excluded is ground
   * where no answer exists yet.
   */
  const bs = E.ctx.peek('buildings');
  const loaded = [];
  for (const rec of bs?.tiles?.values?.() ?? []) {
    if (rec && Number.isFinite(rec.cx)) loaded.push([rec.cx, rec.cz, (rec.size ?? 128) * 0.5]);
  }
  const built = (x, z) => {
    for (const t of loaded) if (Math.abs(x - t[0]) <= t[2] && Math.abs(z - t[1]) <= t[2]) return true;
    return false;
  };

  // ---- walk the frontage of every downtown block -------------------------
  const all = (w.blocks ?? []).filter((b) => b.district === 'downtown');
  const blocks = all.filter((b) => built(b.cx, b.cz));
  let metres = 0;
  let walled = 0;
  let worstRun = 0;
  let worstAt = null;
  let lotsOnBlocks = 0;
  let emptyBlocks = 0;
  const perBlock = [];
  for (const b of blocks) {
    const yaw = b.yaw ?? 0;
    const ca = Math.cos(yaw);
    const sa = Math.sin(yaw);
    const L2W = (u, v) => [b.cx + u * ca - v * sa, b.cz + u * sa + v * ca];
    const W2 = b.w / 2;
    const D2 = b.d / 2;
    const corners = [L2W(-W2, -D2), L2W(W2, -D2), L2W(W2, D2), L2W(-W2, D2)];
    let bm = 0;
    let bw = 0;
    // How many lots `world` put on this block, and how many of them are a
    // whole-block park or surface car park. Reported, not asserted: it is the
    // difference between "the planner left it empty" and "the planner filled it
    // and `buildings` did not build it", and those are two different owners.
    let bl = 0;
    let bp = 0;
    for (const l of w.lots ?? []) {
      const du = (l.cx - b.cx) * ca + (l.cz - b.cz) * sa;
      const dv = -(l.cx - b.cx) * sa + (l.cz - b.cz) * ca;
      if (Math.abs(du) > W2 || Math.abs(dv) > D2) continue;
      bl++;
      if (l.kind === 'park' || l.kind === 'lot') bp++;
    }
    lotsOnBlocks += bl;
    emptyBlocks += bl === bp ? 1 : 0;
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const c = corners[(i + 1) % 4];
      const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const n = Math.max(1, Math.round(len / step));
      // inward normal of this edge
      let nx = -(c[1] - a[1]) / (len || 1);
      let nz = (c[0] - a[0]) / (len || 1);
      const mx = (a[0] + c[0]) / 2 - b.cx;
      const mz = (a[1] + c[1]) / 2 - b.cz;
      if (nx * mx + nz * mz > 0) {
        nx = -nx;
        nz = -nz;
      }
      let run = 0;
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const px = a[0] + (c[0] - a[0]) * t + nx * (reach * 0.5);
        const pz = a[1] + (c[1] - a[1]) * t + nz * (reach * 0.5);
        const m2 = len / n;
        metres += m2;
        bm += m2;
        hist[Math.min(12, Math.floor(dist2(px, pz, 60) / 5))]++;
        if (near(px, pz, reach)) {
          walled += m2;
          bw += m2;
          run = 0;
        } else {
          run += m2;
          if (run > worstRun) {
            worstRun = run;
            worstAt = [Math.round(px), Math.round(pz)];
          }
        }
      }
    }
    perBlock.push({ cx: Math.round(b.cx), cz: Math.round(b.cz), m: Math.round(bm), w: Math.round(bw), lots: bl, park: bp });
  }

  return {
    blocks: blocks.length,
    blocksAll: all.length,
    loadedTiles: loaded.length,
    bandTris: tris,
    hist,
    lotsOnBlocks,
    emptyBlocks,
    clipDropped: bs?.stats?.clipDropped ?? 0,
    clipTrimmed: bs?.stats?.clipTrimmed ?? 0,
    cells: grid.size,
    metres: Math.round(metres),
    walled: Math.round(walled),
    share: metres > 0 ? walled / metres : 0,
    worstRun: Math.round(worstRun),
    worstAt,
    perBlock: perBlock.sort((a, b) => a.w / (a.m || 1) - b.w / (b.m || 1)),
    roots: [...srcs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    lots: (w.lots ?? []).filter((l) => l.district === 'downtown').length,
  };
}

/* -------------------------------------------------------------- report ---- */
let bad = 0;
const line = (ok, name, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? ' ok ' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
};

const S = arms.shipped;
const C = arms.control;
console.log('downtown street wall — the Golden Triangle, emitted geometry vs published blocks\n');
for (const [name, R] of Object.entries(arms)) {
  if (!R) continue;
  console.log(
    `  ${name.padEnd(8)} ${R.blocks} of ${R.blocksAll} downtown blocks are inside the ` +
      `${R.loadedTiles} streamed tiles · ${R.lots} lots · ${R.metres} m of frontage · ` +
      `${R.walled} m walled = ${(R.share * 100).toFixed(1)}% · longest unbuilt run ${R.worstRun} m` +
      (R.worstAt ? ` @(${R.worstAt[0]},${R.worstAt[1]})` : '') +
      `\n           ground-band triangles ${R.bandTris} in ${R.cells} cells · ` +
      `podium ${R.pgh.podium ?? 0} (shaft cut ${R.pgh.shaftCut ?? 0}) · ` +
      `downtown tall ${R.pgh.downtownTall ?? 0} · lots on blocks ${R.lotsOnBlocks} ` +
      `(${R.emptyBlocks} blocks all park/parking) · clip dropped ${R.clipDropped} trimmed ${R.clipTrimmed} · ` +
      `beacon ${R.pgh.beacon ?? 0} pyramid ${R.pgh.pyramid ?? 0} chateau ${R.pgh.chateau ?? 0}`
  );
  console.log(
    `           COST  ${R.cost.meshes} buildings meshes / ${R.cost.tris.toLocaleString('en-US')} tris / ` +
      `${R.cost.surfaces} distinct surface keys · skyline field ${R.cost.skyMeshes} instanced meshes · ` +
      `tile draws ${R.cost.stats.draws ?? '?'}`
  );
  if (R.errors?.length) console.log('           page errors: ' + R.errors.slice(0, 3).join(' | '));
  if (args.blocks) {
    console.log('           nearest-wall histogram (5 m buckets, 60+ last): ' + R.hist.join(' '));
    console.log('           roots: ' + R.roots.map((r) => `${r[0]}x${r[1]}`).join(' '));
    console.log(
      '           per block: ' +
        R.perBlock.map((b) => `${Math.round((100 * b.w) / (b.m || 1))}%`).join(' ')
    );
    console.log(
      '           worst: ' +
        R.perBlock.slice(0, 6).map((b) => `(${b.cx},${b.cz}) ${b.w}/${b.m} m ${b.lots}L/${b.park}P`).join('  ')
    );
  }
}
console.log('');

line(
  S.bandTris > 5000,
  'the probe measured emitted geometry',
  `${S.bandTris} ground-storey triangles across ${S.cells} lattice cells`
);
line(
  S.blocks > 10,
  "world published a downtown to measure",
  `${S.blocks} blocks, ${S.metres} m of frontage`
);
line(
  S.share >= MIN_WALL,
  'downtown blocks line their streets',
  `${(S.share * 100).toFixed(1)}% of frontage metres have a wall within ${REACH} m (ratchet ${(MIN_WALL * 100).toFixed(0)}%)`
);
line(
  S.worstRun <= MAX_PLAZA,
  'no vast unfilled field on a block edge',
  `longest unbuilt run ${S.worstRun} m (ratchet ${MAX_PLAZA} m)`
);
line(
  (S.pgh.beacon ?? 0) >= MIN_EACH_CROWN &&
    (S.pgh.pyramid ?? 0) >= MIN_EACH_CROWN &&
    (S.pgh.chateau ?? 0) >= MIN_EACH_CROWN,
  'all three signature crowns were built',
  `beacon ${S.pgh.beacon ?? 0} / pyramid ${S.pgh.pyramid ?? 0} / chateau ${S.pgh.chateau ?? 0} ` +
    `over ${S.pgh.downtownTall ?? 0} qualifying downtown towers`
);
line(
  (S.pgh.podium ?? 0) > 0,
  'downtown towers stand on a full-lot podium',
  `${S.pgh.podium} podium(s), ${S.pgh.shaftCut} of them with the shaft cut back`
);

if (C) {
  line(
    (C.pgh.podium ?? 0) === 0 && (C.pgh.beacon ?? 0) === 0 && (C.pgh.pyramid ?? 0) === 0 && (C.pgh.chateau ?? 0) === 0,
    'CONTROL: ?owNoPgh=1 really turns the layer off',
    `control built ${C.pgh.podium ?? 0} podiums and ${(C.pgh.beacon ?? 0) + (C.pgh.pyramid ?? 0) + (C.pgh.chateau ?? 0)} signature crowns`
  );
  line(
    C.lots === S.lots && C.blocks === S.blocks,
    'CONTROL: the hatch does not re-roll the city',
    `${S.blocks}/${S.lots} blocks/lots shipped against ${C.blocks}/${C.lots} hatched off`
  );
  line(
    S.share >= C.share,
    'CONTROL: the layer does not thin the street wall',
    `${(S.share * 100).toFixed(1)}% shipped against ${(C.share * 100).toFixed(1)}% with it off ` +
      `(${((S.share - C.share) * 100).toFixed(2)} points)`
  );
}

if (C) {
  line(
    S.cost.surfaces <= C.cost.surfaces,
    'TEXTURE: the layer adds no new surface key',
    `${S.cost.surfaces} distinct materials in the buildings scene against ${C.cost.surfaces} with it off ` +
      `(every crown reuses a key the district already bakes — see palette.js's accounting note)`
  );
  /**
   * The bar follows the POPULATION it was cut against. At the original sparse
   * downtown (park rolls left 9 of 38 blocks empty, [26,54] m lots) the layer
   * measured +7 meshes; the lots.js density fix ([14,26] m, no whole-block
   * park rolls) doubled the qualifying towers and the same layer measures +17
   * with the street wall up 34.0% -> 46.2%. 24 keeps headroom over the
   * measured value and still catches a per-building leak (135 lots would read
   * +100, not +17).
   */
  line(
    S.cost.meshes <= C.cost.meshes + 24,
    'DRAWS: the layer adds under 24 buildings meshes',
    `${S.cost.meshes} against ${C.cost.meshes} (${S.cost.meshes - C.cost.meshes}); ` +
      `skyline field ${S.cost.skyMeshes} against ${C.cost.skyMeshes}; ` +
      `merged triangles ${S.cost.tris.toLocaleString('en-US')} against ${C.cost.tris.toLocaleString('en-US')} ` +
      `(${(((S.cost.tris - C.cost.tris) / (C.cost.tris || 1)) * 100).toFixed(1)}%)`
  );
}

if (args.json) {
  mkdirSync(dirname(resolve(String(args.json))), { recursive: true });
  writeFileSync(resolve(String(args.json)), JSON.stringify(arms, null, 2));
}

console.log(bad === 0 ? '\nDOWNTOWN BLOCK GATE PASSED' : `\nDOWNTOWN BLOCK GATE FAILED (${bad} checks)`);
process.exit(bad === 0 ? 0 : 1);
