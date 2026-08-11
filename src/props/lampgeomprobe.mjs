#!/usr/bin/env node
/**
 * LAMPGEOMPROBE — can you READ THE ROAD under a street lamp at night?
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 * The pool of light under a sodium lamp was a horizontal disc placed 2 cm above
 * the lamp's own footing, drawn additively with the depth test on. The ground
 * it is supposed to be painting is not that plane and never was: the road is
 * cambered, the kerb stands 15 cm proud, and `props/layout.js` leans every
 * column by up to 0.0175 rad, which is another 9 cm across a 5.4 m disc. So the
 * depth test cut the disc along the line where the road crossed it and left two
 * saturated ribbons in the gutters with a black crown between them — a
 * razor-straight silhouette that no amount of shading could have fixed, because
 * it was a plane in the wrong place.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT, AND WHY IT IS NOT CIRCULAR (rule 12)
 * ---------------------------------------------------------------------------
 * The gated number is DISPLAY LUMINANCE OF THE ROAD CROWN, read off a PNG of
 * the composited frame. Nothing asserts on the disc's vertex colours, its
 * height, the material opacity or the light pool — those are the code's own
 * inputs and would agree with any bug, including the one above, which shipped
 * for as long as it did precisely because every internal number about it was
 * correct.
 *
 * The crown is found from the WORLD, not from the lamp: walk out from each lamp
 * along its mast arm over the carriageway, sample `walkableHeightAt` where
 * `surfaceAt` says asphalt, and take the highest point. That is the ridge the
 * disc used to be cut by, so it is the exact place the defect was worst, and it
 * is chosen by the terrain rather than by anything the lighting code decided.
 *
 * The geometric burial figure is also printed — how far the ground stands above
 * the old disc plane — but it is a DIAGNOSTIC, so a red run says "the crown
 * under lamp 3 is buried 0.31 m" instead of only a luminance.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node src/props/lampgeomprobe.mjs            # measure + gate
 *   node src/props/lampgeomprobe.mjs --json
 *   node src/props/lampgeomprobe.mjs --save=/tmp/lamp.png
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const TIMEOUT = Number(args.timeout ?? 120000);
const W = 1280;
const H = 720;

/**
 * RATCHET (rule 13) — the review's acceptance target, not the ceiling.
 *
 * "You can read the road, the kerb and the lane lines ahead of you during a
 * night pursuit" was specified as a crown reading above 40/255. MEASURED on
 * `night`: 23.2 mean / 13.4 p50 before the fix, and the crown boxes under
 * individual lamps ran 11-27. Raise the bar when the lighting improves; never
 * lower it to make a run go green.
 */
const CROWN_MIN = 40;

/**
 * Metres of mount height above which a lamp is CARRIAGEWAY lighting.
 *
 * The `night` shot's near lamps are a mix: 8.9 m cobra heads on 2.1 m mast
 * arms, which exist to light the road, and 3.2-4.3 m heritage and park globes
 * on the pavement, which do not and never did. Asking a 3.2 m park globe to put
 * 40/255 on the middle of a 9 m carriageway is asking for a bug — the fix for
 * it would be to make a garden lamp throw like a highway mast, which is worse
 * than the defect. They are still measured and printed, because a park lamp
 * that has gone DARK is a real regression and the number would show it; they
 * are just not judged against a carriageway target.
 */
const CARRIAGEWAY_MOUNT = 6;

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function boxLum(png, x, y, w, h) {
  const { width, data } = png;
  let s = 0;
  let n = 0;
  for (let j = Math.max(0, y); j < Math.min(png.height, y + h); j++) {
    for (let i = Math.max(0, x); i < Math.min(width, x + w); i++) {
      const o = (j * width + i) * 4;
      s += lum(data[o], data[o + 1], data[o + 2]);
      n++;
    }
  }
  return n ? s / n : -1;
}

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

let bad = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/?capture=1&shot=night&lockstep=1`, {
    waitUntil: 'domcontentloaded', timeout: TIMEOUT,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: TIMEOUT });
  await page.evaluate(() => window.__APPLY_SHOT__?.('night', { grabFrame: 90 }));
  let f = 0;
  while (f < 1200) {
    if (await page.evaluate(() => window.__SETTLED__?.() === true)) break;
    await pump(20);
    f += 20;
  }
  await pump(90);
  if (await page.evaluate(() => window.__PRESHUTTER__?.() ?? 0)) await pump(20);
  await pump(30);

  const sites = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const ctx = e.ctx;
    const props = ctx.peek('props');
    const world = ctx.peek('world');
    const cam = ctx.camera;
    cam.updateMatrixWorld();
    const cx = cam.matrixWorld.elements[12];
    const cz = cam.matrixWorld.elements[14];
    const V = new (Object.getPrototypeOf(cam.position).constructor)();
    const out = [];
    for (const rec of props.tiles.values()) {
      if (rec.lod !== 0 || !rec.lamps) continue;
      for (let j = 0; j < rec.lamps.length; j++) {
        const l = rec.lamps[j];
        const d = Math.hypot(l.x - cx, l.z - cz);
        if (d > 44) continue;
        const baseY = world.walkableHeightAt(l.x, l.z, l.y);
        // THE CROWN IS THE ROAD'S CENTRELINE, and `world` is the authority on
        // where that is. Deliberately not "the highest ground near the lamp"
        // (a hillside beats a 2 % camber and the search returns the top of the
        // street) and deliberately not "along the mast arm" — which way an arm
        // points is a decision the LIGHTING code made, and a gate that reuses
        // it is asking the code where its own light went (rule 12).
        const ne = world.roads?.nearestEdge?.(l.x, l.z);
        const eg = ne && (typeof ne.edge === 'number' ? world.roads.edges[ne.edge] : ne.edge);
        if (!eg) continue;
        const A = world.roads.nodes[eg.a];
        const B = world.roads.nodes[eg.b];
        if (!A || !B) continue;
        const ex = B.x - A.x;
        const ez = B.z - A.z;
        const el2 = ex * ex + ez * ez;
        if (!(el2 > 1e-3)) continue;
        const tt = Math.max(0, Math.min(1, ((l.x - A.x) * ex + (l.z - A.z) * ez) / el2));
        const gx = A.x + ex * tt;
        const gz = A.z + ez * tt;
        if (world.surfaceAt(gx, gz) !== 'asphalt') continue;
        const best = {
          x: gx,
          z: gz,
          y: world.walkableHeightAt(gx, gz, baseY + 3),
          r: +Math.hypot(gx - l.x, gz - l.z).toFixed(2),
        };
        if (best.r > 16) continue;
        V.set(best.x, best.y + 0.02, best.z).project(cam);
        if (!(V.z > -1 && V.z < 1)) continue;
        const px = (V.x + 1) / 2;
        const py = (1 - V.y) / 2;
        // The measured box has to fit on screen and stay off the HUD corners.
        if (px < 0.05 || px > 0.95 || py < 0.30 || py > 0.95) continue;
        out.push({
          id: `${rec.key}:${j}`,
          d: +d.toFixed(1),
          // Mount height above the lamp's own footing. A cobra head on an
          // 8-9 m column is CARRIAGEWAY lighting; a 3-4 m heritage globe is
          // pavement lighting and was never meant to reach the middle of a
          // 9 m road. See the selection note at CROWN_MIN.
          mount: +(l.y - baseY).toFixed(1),
          r: best.r,
          bury: +(best.y - (baseY + 0.02)).toFixed(3),
          px,
          py,
        });
      }
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, 12);
  });
  if (sites.length < 3) throw new Error(`only ${sites.length} measurable crown sites`);

  const buf = await page.screenshot({ type: 'png' });
  if (args.save) writeFileSync(String(args.save), buf);
  const png = PNG.sync.read(buf);
  const bw = Math.round(W * 0.045);
  const bh = Math.round(H * 0.045);
  for (const s of sites) {
    s.lum = +boxLum(png, Math.round(s.px * W - bw / 2), Math.round(s.py * H - bh / 2), bw, bh).toFixed(1);
  }
  const judged = sites.filter((s) => s.mount >= CARRIAGEWAY_MOUNT);
  if (judged.length < 2) throw new Error(`only ${judged.length} carriageway lamps in frame`);
  const lums = judged.map((s) => s.lum).sort((a, b) => a - b);
  const mean = +(lums.reduce((a, b) => a + b, 0) / lums.length).toFixed(1);
  const median = lums[lums.length >> 1];
  const worst = lums[0];
  const buried = sites.filter((s) => s.bury > 0).length;

  const report = { sites, mean, median, worst, buried, n: judged.length };
  if (args.json) console.log(JSON.stringify(report));
  else {
    console.log('lamp            dist  mount  crownR  groundAboveOldDisc  crownLum  judged');
    for (const s of sites) {
      console.log(
        `${s.id.padEnd(15)} ${String(s.d).padStart(4)} ${String(s.mount).padStart(6)} ` +
          `${String(s.r).padStart(7)}  ${String(s.bury).padStart(17)}  ${String(s.lum).padStart(8)}` +
          `  ${s.mount >= CARRIAGEWAY_MOUNT ? 'yes' : 'no (pavement lamp)'}`
      );
    }
    console.log(
      `\ncrown luminance over ${judged.length} carriageway lamps of ${sites.length} measured: ` +
        `mean ${mean} median ${median} worst ${worst}` +
        `   (${buried}/${sites.length} crowns stand above the old disc plane)`
    );
  }

  const check = (ok, what) => {
    if (!ok) bad++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}`);
  };
  check(median >= CROWN_MIN, `median crown luminance ${median} >= ${CROWN_MIN}/255 — the road is readable under a lamp`);
  check(mean >= CROWN_MIN, `mean crown luminance ${mean} >= ${CROWN_MIN}/255`);
  console.log(bad === 0 ? '\nlampgeomprobe: OK' : `\nlampgeomprobe: ${bad} FAILING`);
} catch (err) {
  console.error(logs.slice(-30).join('\n'));
  throw err;
} finally {
  await browser.close();
  stopServer(server);
}
process.exit(bad === 0 ? 0 : 1);
