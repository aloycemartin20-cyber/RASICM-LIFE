#!/usr/bin/env node
/**
 * COLOR PARK — the "nothing to fall through" gate.
 *
 *   node src/props/colorparkprobe.mjs
 *   node src/props/colorparkprobe.mjs --flat      THE NEGATIVE CONTROL
 *   node src/props/colorparkprobe.mjs --json
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE REPORT THIS EXISTS FOR
 * ────────────────────────────────────────────────────────────────────────────
 * "color park is glitchy (panels laying everywhere, player falls through the
 * ground)".
 *
 * The park stood on a bank that falls 3.5 m across the site and every piece of
 * it was a BOX SEATED ON ONE GROUND SAMPLE. MEASURED on the shipped terrain,
 * over the band the apron covered: 8.5 m of ground at v = 0 against 4.9 m at
 * v = -10.8, so the far edge of a 21.6 m-deep slab hung 2.6 m in the air. It
 * carried no collider, so a player walked onto something visibly solid and
 * dropped through it to the terrain.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT MEASURES, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 * ────────────────────────────────────────────────────────────────────────────
 * Nothing here asks `colorpark.js` how it thinks it seated a piece. It runs
 * the SHIPPED emitter into a stub batch, takes the vertex buffers that come
 * out — the positions the renderer would draw — and asks the TERRAIN, one
 * vertex at a time, how far above the ground each one is. The two producers
 * are independent: the paint comes from the emitter, the ground comes from
 * `world/terrain.js`, and a disagreement is the defect.
 *
 * Three assertions:
 *
 *   HUG        no drawn vertex of the painted ground stands more than
 *              MAX_GAP above the terrain, and none is below it. This is the
 *              fall-through, stated as a number.
 *   NO FLOOR   the emitter adds no collision proxy at all. The ground at
 *              Color Park is the terrain that was already there, so a collider
 *              from this layer would be a floor by definition — and a floor is
 *              what a player falls through when it disagrees with the ground.
 *   PAINT      the park is actually painted: at least MIN_CANS distinct
 *              aerosol surfaces and MIN_TRIS triangles of paint, so a run that
 *              emitted an empty park cannot pass the two assertions above by
 *              having nothing to measure.
 *
 * `--flat` is the NEGATIVE CONTROL: it seats every piece on ONE sample, which
 * is what shipped, and HUG must go red. The run exits 0 only if it does.
 */
import { Terrain } from '../world/terrain.js';
import { LANDMARKS } from '../world/plan.js';
import { paintColorPark } from './colorpark.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const FLAT = !!args.flat;
const JSON_OUT = !!args.json;
const log = (...a) => { if (!JSON_OUT) console.log(...a); };

/**
 * THE BAR, and where it comes from.
 *
 * The tarmac skin is authored 0.12 m proud of `heightAt` and the topmost layer
 * of paint 0.23 m proud of the terrain (the lift is measured — see the note on
 * `TARMAC_LIFT`: the drawn ground carries a detail displacement `heightAt`
 * does not, and at 0.05 it came through the skin). `world/terrainmesh.js` draws the near
 * ground at 2 m and this layer samples at 1.5 m, so the drawn ground between
 * two of our samples can differ from `heightAt` by a little — 0.35 m is that
 * plus the authored lift plus margin, and it is still a tenth of the 2.6 m the
 * shipped park hung by. NEVER RAISE IT (rule 13): a bigger number is a bigger
 * step for a player to fall down.
 */
const MAX_GAP = 0.32;
/** Nothing may be UNDER the ground either — that is paint buried in a bank. */
const MIN_GAP = -0.02;
const MIN_CANS = 6;
const MIN_TRIS = 2000;

const terrain = new Terrain({ cell: 8, extent: 1792 });
terrain.bake();
const lm = LANDMARKS.find((l) => l.id === 'lm_colorpark');
if (!lm) {
  console.log('FAIL  lm_colorpark is not in the published landmark table');
  process.exit(1);
}

/** The world API `colorpark.js` is allowed to use, and nothing else. */
const world = { heightAt: (x, z) => terrain.heightAt(x, z) };

/**
 * The site frame, re-derived here from the published entry — the same three
 * expressions `props/colorpark.js` and `buildings/landmarks.js` both use, so
 * a site that turns takes this classification with it.
 */
const COS = Math.cos(lm.site?.yaw ?? 0.489);
const SIN = Math.sin(lm.site?.yaw ?? 0.489);
const WALL_V = (lm.site?.hz ?? 16) - 3.0;

/**
 * A stub `TileBatch` that keeps what it is handed. `add` is the whole-geometry
 * path this layer uses; `put` and `box` are recorded so the NO FLOOR assertion
 * has something to assert on rather than assuming they were never called.
 */
class StubBatch {
  constructor() {
    this.geo = [];
    this.puts = [];
    this.boxes = [];
  }

  add(surface, geo) {
    this.geo.push({ surface, geo });
    return this;
  }

  put(id) { this.puts.push(id); return this; }

  place(id) { this.puts.push(id); return this; }

  box(tag, x, y, z, w, h, d) { this.boxes.push({ tag, x, y, z, w, h, d }); return this; }
}

/** One tile big enough for the whole park, so nothing is gated out. */
const bx = { x0: lm.x - 400, x1: lm.x + 400, z0: lm.z - 400, z1: lm.z + 400 };
const B = new StubBatch();
const t0 = Date.now();
paintColorPark(B, bx, lm, world, 0xc01021, { flat: FLAT });
const ms = Date.now() - t0;

let tris = 0;
let paintTris = 0;
const cans = new Set();
let worstHigh = { d: -Infinity };
let worstLow = { d: Infinity };
let verts = 0;
let above = 0;
for (const { surface, geo } of B.geo) {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  tris += (idx ? idx.count : pos.count) / 3;
  if (surface !== 'cp_tarmac') {
    paintTris += (idx ? idx.count : pos.count) / 3;
    cans.add(surface);
  }
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    /**
     * THE MURALS ARE ON A WALL AND ARE NOT MEASURED HERE. They are authored
     * 0.15-3.0 m up the retaining wall's face, so "how far above the ground"
     * is the wrong question of them and asserting it would be asserting
     * something false.
     *
     * They are sorted out by the vertex's own SITE-LOCAL v — geometry, not a
     * name the emitter chose — because height cannot do it: the foot tags run
     * down to 0.24 m up the wall and a height threshold classified those as
     * ground paint and then measured them against a terrain they are 0.3 m
     * behind. Anything at or past the wall face is wall; everything in front
     * of it is ground and must lie on the ground.
     */
    const v = -(x - lm.x) * SIN + (z - lm.z) * COS;
    if (v > WALL_V - 0.5) { above++; continue; }
    const d = y - terrain.heightAt(x, z);
    verts++;
    if (d > worstHigh.d) worstHigh = { d, x, z, surface };
    if (d < worstLow.d) worstLow = { d, x, z, surface };
  }
}

const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
};

log(`\ncolor park — ${B.geo.length} merged surfaces, ${Math.round(tris)} triangles in ${ms} ms` +
    `${FLAT ? '  [--flat: the shipped seating, NEGATIVE CONTROL]' : ''}`);
log(`  ${verts} ground vertices measured against the terrain, ${above} on the wall face (excluded)`);

rec('HUG      the painted ground lies on the terrain',
  worstHigh.d <= MAX_GAP && worstLow.d >= MIN_GAP,
  `worst gap ${worstHigh.d.toFixed(3)} m (bar ${MAX_GAP}) at (${worstHigh.x?.toFixed(0)}, ${worstHigh.z?.toFixed(0)}) on ${worstHigh.surface}; ` +
  `deepest ${worstLow.d.toFixed(3)} m (bar ${MIN_GAP})`);

rec('NO FLOOR the paint layer adds no collision at all',
  B.boxes.length === 0,
  `${B.boxes.length} collision proxy(ies) — the ground here must be the terrain and nothing else`);

rec('PAINT    the park is actually painted',
  cans.size >= MIN_CANS && paintTris >= MIN_TRIS,
  `${cans.size} aerosol surfaces (bar ${MIN_CANS}), ${Math.round(paintTris)} triangles of paint (bar ${MIN_TRIS})`);

const failed = results.filter((r) => !r.ok);
log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (JSON_OUT) console.log(JSON.stringify({ flat: FLAT, tris, paintTris, cans: [...cans], results }, null, 2));

let exitCode = failed.length ? 1 : 0;
if (FLAT) {
  const broke = results.some((r) => !r.ok && r.name.startsWith('HUG'));
  log(broke
    ? '  negative control OK: seated on one sample, the park leaves the ground'
    : '  NEGATIVE CONTROL DID NOT REPRODUCE — this gate is not measuring anything');
  exitCode = broke ? 0 : 1;
}
process.exit(exitCode);
