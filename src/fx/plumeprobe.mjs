#!/usr/bin/env node
/**
 * PLUME PROBE — does anything in Steel City actually smoke, and does the smoke
 * come out of the top of a stack that exists?
 *
 *   node src/fx/plumeprobe.mjs
 *   node src/fx/plumeprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 * NOTHING EMITTED SMOKE OR STEAM. `src/fx/ambience.js` has carried a complete,
 * correct and documented contract since it was written — set
 * `userData.fxSmoke` on any Object3D and it starts smoking — and it had ZERO
 * producers, in a game whose design document opens with a dying mill economy
 * and "steam off grates and mill stacks". The signature industrial shot was
 * five cold chimneys.
 *
 * The tag route was never the problem. There is no NODE to hang a tag on:
 * `buildings` merges every landmark into a per-tile static batch, so the mill
 * leaves `TileBuilder.build()` as a handful of meshes at the world origin and
 * `_scan` has nothing to find.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES (rule 12), IN TWO PARTS
 * ---------------------------------------------------------------------------
 *  1. THE TWO TABLES AGREE. `fx` cannot import `buildings` (rule 2), so the
 *     flue positions are mirrored: `MILL_STACKS` / `MARKET_GRIDDLES` in
 *     `src/buildings/landmarks.js` are what the GEOMETRY is built from, and
 *     `PRODUCERS` in `src/fx/ambience.js` is what the SMOKE is built from.
 *     This file imports both — a probe may reach across subsystems, a
 *     subsystem may not — and fails if any anchor differs by over 5 cm. That
 *     is the mechanical guard on the one duplication in the feature, and it is
 *     why moving a stack cannot silently leave its plume behind.
 *
 *  2. THE PARTICLES COME OUT. The real `Ambience` is instantiated against a
 *     stub `fx` that records every `emitLit` call, handed a stub `world`
 *     publishing the real landmark coordinates, and stepped with the camera at
 *     the `mill` shot's own eye point. Every assertion below is then made on
 *     the SPAWN RECORDS the particle ring would have been given: how many,
 *     where they were born, how high the column reaches, and that they are
 *     carried downwind rather than hanging in dead air. Not on the emitter
 *     table, not on "did addSource get called".
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS
 * ---------------------------------------------------------------------------
 * Green is 19/19. Two reverts, applied for real and MEASURED, plus three that
 * run inside every green pass:
 *
 *   landmarks.js  one brick stack moved 3 m in z         -> 17/19, and the
 *                 mirror check names the offset and the stack
 *   ambience.js   `_producers` stops standing plumes up
 *                 — THE DEFECT, i.e. the tree as it was  -> 12/19, with the
 *                 summary line reading 0 spawn records
 *
 *   - A camera 900 m away must emit NOTHING, so "particles were emitted" is
 *     not a sentence true of every run, and the cull is real.
 *   - The prefill must not fire twice for one arrival, so a standing source
 *     cannot quietly cost 48 particles every frame.
 *   - A `world` that publishes no landmarks must produce no emitters at all
 *     rather than a plume at the origin.
 */

import { Ambience } from './ambience.js';
import { PRODUCERS } from './ambience.js';
import { MILL_STACKS, MARKET_GRIDDLES } from '../buildings/landmarks.js';

const VERBOSE = process.argv.includes('--verbose');
let pass = 0, fail = 0;
const rows = [];
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  rows.push({ ok: !!ok, name, detail: String(detail ?? '') });
};

/* -------------------------------------------------------------------------- */
/* harness                                                                    */
/* -------------------------------------------------------------------------- */

/** Deterministic rng with the shape `fx.rng` has (rule 4 — no Math.random). */
function rng() {
  let n = 0x2545f491;
  const f = () => {
    n ^= n << 13; n >>>= 0;
    n ^= n >> 17;
    n ^= n << 5; n >>>= 0;
    return n / 4294967296;
  };
  return {
    float: f,
    signed: () => f() * 2 - 1,
    range: (a, b) => a + f() * (b - a),
    u32: () => Math.floor(f() * 4294967296),
    pick: (a) => a[Math.floor(f() * a.length) % a.length],
    fork: () => rng(),
  };
}

/** The mill's authored site, as `world` publishes it. */
const MILL = { id: 'lm_mill', x: 872, z: 248 };
const MARKET = { id: 'lm_market', x: 352, z: -224 };
const GY = 7.5;

/**
 * Enough `fx` for `Ambience` to run, and nothing more. Every spawn record is
 * kept — this is the emitted artefact the assertions are made on.
 */
function stubFx(landmarks = [MILL, MARKET]) {
  const lit = [];
  const add = [];
  const hazes = [];
  const world = { landmarks, heightAt: () => GY };
  return {
    rng: rng(),
    ctx: { peek: (id) => (id === 'world' ? world : null) },
    emitLit(s) { lit.push({ ...s }); },
    emitAdd(s) { add.push({ ...s }); },
    emitMote() {},
    haze(x, y, z) { hazes.push({ x, y, z }); },
    physics: null,
    lit, add, hazes, world,
  };
}

/** A camera-shaped object: `Ambience.update` only reads position + direction. */
function cam(x, y, z) {
  return {
    position: { x, y, z },
    getWorldDirection(v) { v.x = 0.5; v.y = -0.2; v.z = -0.84; return v; },
  };
}

/**
 * Step the real `Ambience` for `seconds`. Motes and shimmer off — this file is
 * about producers, and 240 dust specks a frame would drown the sample.
 */
function run(fx, camera, seconds, dt = 1 / 60) {
  const a = new Ambience(fx, { motes: 0, shimmer: false });
  // The producers stand up on the same slow timer `_scan` uses; the first tick
  // is what this needs, so push the timer over on the first step.
  a._scanTimer = 2.01;
  let now = 0;
  for (let t = 0; t < seconds; t += dt) {
    now += dt;
    a.update(dt, now, camera, null);
  }
  return a;
}

/* ========================================================================== */
/* 1 — the two tables agree                                                  */
/* ========================================================================== */

{
  const mill = PRODUCERS.find((p) => p.landmark === 'lm_mill');
  const mkt = PRODUCERS.find((p) => p.landmark === 'lm_market');

  check('fx has a producer for the mill and one for the market',
    !!mill && !!mkt, `${PRODUCERS.map((p) => `${p.landmark}x${p.plumes.length}`).join(', ')}`);

  check('the mill publishes five stacks and fx smokes five',
    MILL_STACKS.length === 5 && mill?.plumes.length === 5,
    `buildings ${MILL_STACKS.length}, fx ${mill?.plumes.length}`);

  const worst = (a, b) => {
    let m = 0, which = '';
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const d = Math.max(
        Math.abs(a[i].dx - b[i].dx), Math.abs(a[i].dz - b[i].dz), Math.abs(a[i].top - b[i].top)
      );
      if (d > m) { m = d; which = `#${i}`; }
    }
    return { m, which };
  };
  const wm = worst(MILL_STACKS, mill?.plumes ?? []);
  check('THE MIRROR: every mill flue in fx sits on the stack buildings emitted',
    wm.m <= 0.05,
    `worst offset ${wm.m.toFixed(3)} m ${wm.which} across ${MILL_STACKS.length} stacks`);

  const wk = worst(MARKET_GRIDDLES, mkt?.plumes ?? []);
  check('...and every market griddle likewise',
    MARKET_GRIDDLES.length === (mkt?.plumes.length ?? -1) && wk.m <= 0.05,
    `${MARKET_GRIDDLES.length} griddles, worst offset ${wk.m.toFixed(3)} m ${wk.which}`);

  check('the kinds agree too — a stove vents steam, a stack smokes',
    MILL_STACKS.every((s, i) => s.kind === mill.plumes[i].kind),
    MILL_STACKS.map((s, i) => `${s.kind}/${mill.plumes[i].kind}`).join(' '));

  // The furnace crown has to read from across the river; a 140 m default would
  // put the mill's silhouette feature inside the mill's own car park.
  check('the tall stack outlives the short ones on distance',
    mill.plumes[0].cull >= 400 && mill.plumes.every((p) => p.cull <= 460),
    mill.plumes.map((p) => p.cull).join(', ') + ' m');
}

/* ========================================================================== */
/* 2 — particles actually come out, at the top of the stack                  */
/* ========================================================================== */

let millLit = 0;
{
  // The `mill` shot's own eye point (src/dev/shots.js): 90 m off the furnace.
  const fx = stubFx();
  run(fx, cam(820, 20, 320), 3);
  millLit = fx.lit.length;

  check('THE DEFECT: the mill emits particles at all',
    millLit > 0, `${millLit} spawn records in 3 s`);

  // Every record must be born at a flue, not at the landmark's feet.
  const nearFlue = fx.lit.filter((s) => {
    for (const p of MILL_STACKS) {
      const dx = s.x - (MILL.x + p.dx);
      const dz = s.z - (MILL.z + p.dz);
      const dy = s.y - (GY + p.top);
      // Spawn jitter is +-0.6r horizontally and 0..0.4r up (see `_puff`).
      if (Math.hypot(dx, dz) <= p.r * 0.9 && dy >= -0.1 && dy <= p.r * 0.6) return true;
    }
    return false;
  }).length;
  check('every puff is born at the top of a stack, not at its base',
    nearFlue === millLit,
    `${nearFlue}/${millLit} within a flue radius of a published stack top`);

  const highest = Math.max(...fx.lit.map((s) => s.y));
  check('the tall stack is the tall one',
    highest >= GY + 66 - 0.5 && highest <= GY + 66 + 2.1,
    `highest spawn ${highest.toFixed(2)} m, crown at ${(GY + 66).toFixed(2)} m`);

  // Steam and smoke are different materials, not one with a tint.
  const steam = fx.lit.filter((s) => s.gravity > 1.4).length;
  check('the stove vents STEAM and the stacks emit SMOKE',
    steam > 0 && steam < millLit,
    `${steam} steam / ${millLit - steam} smoke records`);

  // Wind-sheared: `s.wind` is the per-particle drag toward `uWind`. A plume at
  // zero means a column standing in dead air whatever the weather says.
  const sheared = fx.lit.filter((s) => s.wind >= 0.8).length;
  check('the plumes are carried by the global wind',
    sheared === millLit, `${sheared}/${millLit} records with wind >= 0.8`);

  // Long-lived, or a 200 m column cannot exist.
  const life = fx.lit.reduce((a, s) => a + s.life, 0) / Math.max(1, millLit);
  check('the puffs live long enough to make a column',
    life > 2.5, `mean life ${life.toFixed(2)} s`);

  if (VERBOSE) {
    console.log(`   ${millLit} records, highest ${highest.toFixed(1)} m, mean life ${life.toFixed(2)} s`);
  }
}

/* ========================================================================== */
/* 3 — the prefill: a column exists the frame you arrive                     */
/* ========================================================================== */

{
  const fx = stubFx();
  const a = new Ambience(fx, { motes: 0, shimmer: false });
  a._scanTimer = 2.01;
  // One step far away: the producers stand up, and nothing is spent.
  a.update(1 / 60, 1 / 60, cam(820, 20, 320 + 900), null);
  const far = fx.lit.length;
  check('NEG CONTROL: 900 m away, not one particle is spent',
    far === 0, `${far} records`);

  // One step at the shot's eye point: the backlog is paid at once.
  a.update(1 / 60, 2 / 60, cam(820, 20, 320), null);
  const arrival = fx.lit.length;
  check('arriving in range fills the column in ONE frame (no growing stub)',
    arrival >= 100, `${arrival} records on the first frame in range`);

  // Backdated births spread across a lifetime — that is what makes it a
  // column rather than a puff at the chimney.
  const spread = Math.max(...fx.lit.map((s) => -s.delay));
  check('their births are backdated across a full particle life',
    spread > 2.5, `oldest backdated ${spread.toFixed(2)} s`);

  const before = fx.lit.length;
  a.update(1 / 60, 3 / 60, cam(820, 20, 320), null);
  const step = fx.lit.length - before;
  check('NEG CONTROL: the prefill does not fire again on the next frame',
    step < 12, `${step} records on the following frame`);
}

/* ========================================================================== */
/* 4 — the market, and a world with nothing in it                            */
/* ========================================================================== */

{
  const fx = stubFx();
  run(fx, cam(MARKET.x + 14, 4, MARKET.z - 4), 3);
  const n = fx.lit.length;
  const onGriddle = fx.lit.filter((s) => {
    for (const g of MARKET_GRIDDLES) {
      if (Math.hypot(s.x - (MARKET.x + g.dx), s.z - (MARKET.z + g.dz)) <= 0.4
        && Math.abs(s.y - (GY + g.top)) <= 0.4) return true;
    }
    return false;
  }).length;
  check('the market griddles steam at head height',
    n > 0 && onGriddle === n, `${onGriddle}/${n} records on a griddle`);
  check('and it is steam, not smoke',
    fx.lit.every((s) => s.gravity > 1.4),
    `min gravity ${Math.min(...fx.lit.map((s) => s.gravity)).toFixed(2)}`);
}

{
  const fx = stubFx([]);
  run(fx, cam(872, 20, 248), 3);
  check('NEG CONTROL: a world with no landmarks makes no plume at the origin',
    fx.lit.length === 0, `${fx.lit.length} records`);
}

/* ========================================================================== */
/* 5 — the cast house shimmer survives a debug stage                         */
/* ========================================================================== */

{
  const fx = stubFx();
  const a = run(fx, cam(820, 20, 320), 3);
  const before = a.heat.length;
  check('the cast house runners shimmer (refraction, no particle cost)',
    before >= 1, `${before} heat source(s)`);

  /**
   * `FXSystem._clearStageVents` empties this array wholesale whenever a debug
   * stage is set up. The producers must notice and put theirs back, or one
   * dev keypress kills the mill's shimmer for the session.
   */
  a.heat.length = 0;
  a._scanTimer = 2.01;
  a.update(1 / 60, 4, cam(820, 20, 320), null);
  check('...and it comes back after something empties the heat pool',
    a.heat.length === before, `${a.heat.length} restored of ${before}`);
}

/* ========================================================================== */

for (const r of rows) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  if (!r.ok || VERBOSE) console.log(`       ${r.detail}`);
}
console.log(`\nplumes: ${pass}/${pass + fail}   (${millLit} mill spawn records in 3 s)`);
process.exit(fail ? 1 : 0);
