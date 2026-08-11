#!/usr/bin/env node
/**
 * GAME — "can the player actually stand where the story says he does?"
 *
 * SYMPTOM. Mission geometry is authored by hand in `src/game/data.js` and was
 * never checked against the world the generator emits, so several chapters
 * staged themselves in the middle of a river. Measured on the live generator
 * before the fix: THE TRIANGLE's checkpoints 1, 5 and 6 sat 8.7-11.0 m under
 * the Monongahela and the Allegheny, SOUTH RUN's 3 and 5 sat 6.6 and 9.3 m
 * under the Mon — and SOUTH RUN is Dylan CH 1, the first chapter of a whole
 * campaign. `dock_south`, the anchor for Carson CH 6, was 8.8 m under the Mon
 * with no dry ground anywhere in the 5-12 m annulus the track stages in, and
 * the Harbormaster's arena — Carson CH 7 — was 8.3 m under the Ohio.
 *
 * WHAT THIS MEASURES, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 *
 * Two INDEPENDENTLY AUTHORED tables are compared against each other. On one
 * side, `src/game/data.js`: hand-written coordinates, edited by whoever writes
 * the chapters. On the other, the EMITTED world — a real `Terrain` that has
 * been `bake()`d exactly as `world/index.js` bakes it, and the real road graph
 * `generateCity` produces, after every transform that moves a road: corridor
 * reservation, dedupe, the planar solve, the 7 m node weld, the height relax,
 * the grade limit and `closeNetwork`. Neither side computed the other, and
 * nothing here re-reads a number the mission layer already holds.
 *
 * It does not use `roads.nearestEdge` either. The segment-distance search below
 * is written out in this file so the answer is an independent reading of the
 * emitted node positions rather than an echo of the graph's own spatial index —
 * the same discipline `world/lmsweep.mjs` applies to the site field.
 *
 * SEEDS. `world` builds its city from `ctx.rng.fork()`, and how many times
 * `ctx.rng` has been forked before `world.init()` is a property of the
 * subsystem graph, not of this file — so no node-side reproduction is THE
 * shipped city. Every assertion is therefore made against several seeds and
 * must hold on all of them. The terrain is seed-free (it is one analytic
 * field), so every water and height reading is exact for the shipped build;
 * only road distance varies, and it varies by metres.
 *
 * Assertions:
 *
 *   race        every checkpoint of every circuit in `RACE_TRACKS` has a
 *               drivable edge within `R.checkpoint` — the gate is a flat 2D
 *               radius, so a gate further than that from any lane is a gate no
 *               car can pass — and that edge is on the main drivable
 *               component. The checkpoint must be dry, UNLESS the road it sits
 *               on is a bridge deck: a gate mid-span is a gate over water and
 *               is exactly right
 *   staging     every POI a chapter names in `at` / `from` / `dest` resolves,
 *               and its STAGING point (`stage` where the record has one — a
 *               dock's pier is over water on purpose, the apron behind it is
 *               not) is dry, reachable and on the main component
 *   arenas      every `BOSSES[].arena` centre is dry and reachable. `boss.js`
 *               stages a brute with `findGroundSpot` around this point and
 *               teleports the player to another one 25-60 m away
 *   services    every entry in `SHOPS` and `GAS_STATIONS` — see below
 *
 * SERVICES, AND WHY THEY ARE SWEPT AT ALL. The staging sweep above walks the
 * POIs a CHAPTER NAMES, and no chapter names a fuel pump. So Rustbelt Respray
 * shipped at (-336, 176), which is 10.9 m under the Monongahela — the one hard
 * heat reset in the game, the thing every `escape` chapter is about reaching,
 * on the riverbed — and this gate stayed green throughout, because the shop
 * tables were simply not in it. A drive-in service is a staging point in every
 * sense that matters: `freeroam._respray`, `_bodyShop` and `_gas` each need a
 * CAR STOPPED within `R.service` of the authored coordinate, and `police` runs
 * a respray ring off the same table.
 *
 * They are held to a STRICTER rule than a race gate, and the difference IS the
 * defect. A checkpoint mid-span is correct — you drive over it at 40 m/s. A
 * FORECOURT mid-span is not a forecourt. So `onDeck` is not an excuse here, it
 * is a violation on its own: the old respray coordinate reads as road-adjacent
 * to anything that only asks which carriageway is nearest, because the Fort
 * Pitt deck passes 3.2 m away and twenty metres overhead. A service sweep that
 * inherited the race gate's deck exemption would score the riverbed as a
 * forecourt, which is exactly the bug it is here to catch — so the second
 * negative control below is that coordinate, and it must fire THROUGH the deck.
 *
 * ...plus a NEGATIVE CONTROL that runs before any of them: the five race
 * coordinates this gate was written for are re-measured as they were authored,
 * and the run aborts unless every one of them is still reported as a
 * violation. A gate that cannot be made to fail is decorative, and this one
 * proves it can with the real defect rather than a synthetic one.
 *
 * Usage
 *   node src/game/groundtruthprobe.mjs
 *   node src/game/groundtruthprobe.mjs --seeds=6
 *   node src/game/groundtruthprobe.mjs --json=/tmp/gt.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Terrain } from '../world/terrain.js';
import { generateCity } from '../world/netgen.js';
import { Rng } from '../core/rng.js';
import { RACE_TRACKS, POI, BOSSES, BOYZ, SHOPS, GAS_STATIONS, R } from './data.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/**
 * The seeds every assertion must hold on. The first is the capture pin
 * (`config.deterministic`); the rest are arbitrary and chosen only to be
 * unrelated to it.
 */
const ALL_SEEDS = [0x5eed1234, 0x600d, 0xdeadbeef, 1337, 42, 0xabcdef];
const SEEDS = ALL_SEEDS.slice(0, Math.max(1, Math.min(ALL_SEEDS.length, Number(args.seeds ?? 6))));

/**
 * RATCHET (ARCHITECTURE.md rule 13). How far a STAGING point may be from the
 * nearest lane.
 *
 * The goal is `R.poi` (14 m) — walk out of the car and you are there. The bar
 * is where the authored table actually is: the landmarks are the binding case
 * and they are far by DESIGN, because `netgen.reserveLandmarks` keeps every
 * carriageway 24 m clear of a site and lays a ring road outside that. The
 * Steel Bowl is the worst at 115.2 m from its ring, which is a stadium car
 * park, not a defect. LOWER THIS WHEN A LANDMARK GETS A CLOSER APPROACH; never
 * raise it to make a moved coordinate pass.
 */
const STAGE_ROAD_MAX = 120;

/**
 * RATCHET (rule 13). How far a DRIVE-IN SERVICE may be from the nearest lane.
 *
 * The goal is `R.service` (11 m): the forecourt is the thing you pull onto, so
 * a pump 50 m off the carriageway is a pump you reach by driving over a kerb
 * and a verge. The bar is where the authored table actually is, MEASURED here
 * over all six seeds — worst `shop_ammo2` (Row Hardware) 49.8 m, worst pump
 * `gas_south` (Carson St Gas) 49.1 m, and every other entry inside 24 m.
 * LOWER THIS WHEN A SERVICE GETS A CLOSER APPROACH; never raise it to make a
 * moved coordinate pass.
 */
const SERVICE_ROAD_MAX = 50;

/** The five gates this gate was written for, as they were authored. */
const REVERTED = [
  { id: 'triangle cp1', x: -224, z: 208 },
  { id: 'triangle cp5', x: -368, z: -152 },
  { id: 'triangle cp6', x: -552, z: 96 },
  { id: 'southrun cp3', x: 528, z: 720 },
  { id: 'southrun cp5', x: -16, z: 384 },
];

/**
 * Rustbelt Respray where DESIGN.md put it — (-84, 44) on the legacy 700 m map,
 * which is (-336, 176) at K = 4. 10.9 m under the Monongahela, 60 m from the
 * nearest bank, with the Fort Pitt deck 3.2 m away and twenty metres up.
 */
const REVERTED_SERVICE = { id: 'shop_spray AS AUTHORED', x: -336, z: 176 };

/* ----------------------------------------------------------- the world --- */

const worlds = SEEDS.map((seed) => {
  const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
  const graph = generateCity(terrain, new Rng(seed).fork().fork()).graph;
  return { seed, terrain, graph };
});

/**
 * Nearest DRIVABLE edge to (x, z), by brute force over the emitted node
 * positions. Rail is excluded: a respray whose approach is a railway is a
 * respray you cannot reach, and a checkpoint on a trolley line is not a gate.
 */
function nearestDrivable(graph, x, z) {
  let best = null;
  let bd = Infinity;
  for (let i = 0; i < graph.edges.length; i++) {
    const e = graph.edges[i];
    if (e.rail) continue;
    const a = graph.nodes[e.a];
    const b = graph.nodes[e.b];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const l2 = dx * dx + dz * dz || 1;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(a.x + dx * t - x, a.z + dz * t - z);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return { dist: bd, edge: best };
}

/**
 * One reading of one authored point against one emitted world.
 *
 * `wet` is the terrain's own answer. `onDeck` is the one case where standing
 * over water is correct — a checkpoint mid-span is a checkpoint on a bridge
 * deck 17 m above the river — and it is deliberately NOT "a bridge is the
 * nearest road". `dock_south` sits 11 m to the side of the Smithfield deck and
 * 8.4 m under the Monongahela: the deck is up there, the point is in the
 * river, and a test that only asked which edge was nearest scored it as
 * standable. The carriageway has to be OVER the point, and above the pool.
 */
function read(world, x, z, reach) {
  const { terrain, graph } = world;
  const hit = nearestDrivable(graph, x, z);
  const e = hit.edge;
  const onDeck = !!e?.bridge &&
    hit.dist <= (e.width ?? 8) * 0.5 &&
    Math.min(graph.nodes[e.a].y, graph.nodes[e.b].y) > 0;
  const node = e ? graph.nodes[e.a] : null;
  return {
    seed: world.seed,
    h: terrain.heightAt(x, z),
    wet: terrain.isWater(x, z),
    road: hit.dist,
    corridor: e?.corridor ?? null,
    onDeck,
    onMain: !!node && node.component === graph.driveMain,
  };
}

/** Worst reading across every seed, plus why it failed. */
function check(label, x, z, reach) {
  const rows = worlds.map((w) => read(w, x, z, reach));
  const worstRoad = rows.reduce((m, r) => (r.road > m.road ? r : m));
  const fails = [];
  if (worstRoad.road > reach) {
    fails.push(`nearest lane ${worstRoad.road.toFixed(1)} m > ${reach} m (seed ${worstRoad.seed.toString(16)})`);
  }
  for (const r of rows) {
    if (r.wet && !r.onDeck) {
      fails.push(`in the water (h ${r.h.toFixed(2)} m, no deck over it)`);
      break;
    }
  }
  for (const r of rows) {
    if (r.road <= reach && !r.onMain) {
      fails.push(`its road is off the main drivable component (seed ${r.seed.toString(16)})`);
      break;
    }
  }
  return {
    label,
    x,
    z,
    reach,
    h: +rows[0].h.toFixed(2),
    wet: rows[0].wet,
    onDeck: rows.every((r) => r.onDeck),
    road: +worstRoad.road.toFixed(1),
    corridor: worstRoad.corridor,
    fails,
  };
}

/**
 * A SERVICE, which is a stricter question than a staging point.
 *
 * Three differences from `check`, and each of them is a defect this sweep
 * exists for:
 *
 *   1. WET IS ALWAYS FATAL. `check` forgives water under a bridge deck because
 *      a race gate mid-span is a race gate you drive through. A forecourt has
 *      to be ground you can stop a car on, so there is no deck exemption — and
 *      without this the authored respray passes, because a deck really does run
 *      3.2 m from it.
 *   2. A DECK IS ITSELF A FAIL. If the only carriageway within reach is a
 *      bridge span, the "approach" is twenty metres of air.
 *   3. The reach is `SERVICE_ROAD_MAX`, not the landmark ratchet: nothing
 *      reserves a corridor away from a shop the way `reserveLandmarks` does.
 */
function checkService(label, x, z) {
  const rows = worlds.map((w) => read(w, x, z, SERVICE_ROAD_MAX));
  const worstRoad = rows.reduce((m, r) => (r.road > m.road ? r : m));
  const fails = [];
  if (worstRoad.road > SERVICE_ROAD_MAX) {
    fails.push(`nearest lane ${worstRoad.road.toFixed(1)} m > ${SERVICE_ROAD_MAX} m (seed ${worstRoad.seed.toString(16)})`);
  }
  const wet = rows.find((r) => r.wet);
  if (wet) fails.push(`in the water (h ${wet.h.toFixed(2)} m) — a forecourt cannot be a river`);
  const deck = rows.find((r) => r.onDeck);
  if (deck) fails.push(`its only carriageway is a BRIDGE DECK overhead, not an approach (seed ${deck.seed.toString(16)})`);
  const off = rows.find((r) => r.road <= SERVICE_ROAD_MAX && !r.onMain);
  if (off) fails.push(`its road is off the main drivable component (seed ${off.seed.toString(16)})`);
  return {
    label,
    x,
    z,
    reach: SERVICE_ROAD_MAX,
    h: +rows[0].h.toFixed(2),
    wet: rows[0].wet,
    onDeck: rows.every((r) => r.onDeck),
    road: +worstRoad.road.toFixed(1),
    corridor: worstRoad.corridor,
    fails,
  };
}

/* -------------------------------------------------------- the assertions -- */

const report = {
  seeds: SEEDS.map((s) => s.toString(16)),
  control: [], race: [], staging: [], arenas: [], services: [],
};

/* ---- NEGATIVE CONTROL: the authored defect must still read as one -------- */
for (const p of REVERTED) {
  const c = check(`${p.id} AS AUTHORED`, p.x, p.z, R.checkpoint);
  report.control.push({ ...c, caught: c.fails.length > 0 });
}
{
  const c = checkService(REVERTED_SERVICE.id, REVERTED_SERVICE.x, REVERTED_SERVICE.z);
  report.control.push({ ...c, caught: c.fails.length > 0 });
  // ...and the same point through the RACE gate's rule, which forgives a deck.
  // Printed as evidence: if this one is not caught while the one above is, the
  // deck exemption is exactly what the service sweep had to drop.
  const lenient = check(`${REVERTED_SERVICE.id} (race rule)`, REVERTED_SERVICE.x, REVERTED_SERVICE.z, SERVICE_ROAD_MAX);
  report.lenient = { ...lenient, caught: lenient.fails.length > 0 };
}

/* ---- 1. race gates ------------------------------------------------------ */
for (const t of Object.values(RACE_TRACKS)) {
  t.points.forEach((p, i) => report.race.push(check(`${t.id} cp${i + 1}`, p.x, p.z, R.checkpoint)));
}

/* ---- 2. every POI a chapter names --------------------------------------- */
{
  const named = new Map();
  for (const boy of Object.values(BOYZ)) {
    for (const c of boy.story) {
      for (const key of ['at', 'from', 'dest']) {
        if (c[key]) named.set(c[key], `${boy.id} ${c.no} ${key}`);
      }
    }
  }
  for (const [id, why] of named) {
    const p = POI.get(id);
    if (!p) {
      report.staging.push({ label: `${id} (${why})`, fails: [`names no POI in data.js`], road: 0, x: 0, z: 0 });
      continue;
    }
    // A dock's own coordinate is the pier head and is over water on purpose;
    // `stage` is the dry apron the chapter is played on, and that is the point
    // `tracks.anchor()` and `MissionRunner._start` use.
    const s = p.stage ?? p;
    report.staging.push(check(`${id} (${why})`, s.x, s.z, STAGE_ROAD_MAX));
  }
}

/* ---- 3. boss arenas ----------------------------------------------------- */
for (const b of Object.values(BOSSES)) {
  report.arenas.push(check(`${b.id} arena`, b.arena.x, b.arena.z, STAGE_ROAD_MAX));
}

/* ---- 4. every service the player drives or walks into -------------------- */
// The whole of both tables, not just the drive-ins: `shop_ammo` and `shop_food`
// are counters (`R.poi`, on foot), but a counter in a river is no more usable
// than a pump in one, and the failure that put this sweep here was a table
// nobody was checking rather than a kind of shop nobody was checking.
for (const s of SHOPS) report.services.push(checkService(`${s.id} (${s.kind})`, s.x, s.z));
for (const g of GAS_STATIONS) report.services.push(checkService(`${g.id} (fuel)`, g.x, g.z));

/* -------------------------------------------------------------- output --- */

if (args.json) {
  mkdirSync(dirname(resolve(String(args.json))), { recursive: true });
  writeFileSync(resolve(String(args.json)), JSON.stringify(report, null, 2));
}

const row = (c) =>
  '    ' + c.label.padEnd(30) +
  `(${String(Math.round(c.x)).padStart(6)},${String(Math.round(c.z)).padStart(6)})` +
  ` h${String((c.h ?? 0).toFixed(1)).padStart(7)}` +
  (c.wet ? (c.onDeck ? '  deck ' : '  WATER') : '   dry ') +
  ` lane${String((c.road ?? 0).toFixed(1)).padStart(7)} m` +
  (c.corridor ? `  ${c.corridor}` : '') +
  (c.fails.length ? `\n        FAIL: ${c.fails.join('; ')}` : '');

console.log(`game ground-truth — authored coordinates against the emitted world`);
console.log(`  seeds: ${report.seeds.join(' ')}   race reach ${R.checkpoint} m, staging reach ${STAGE_ROAD_MAX} m (RATCHET)`);
console.log('');
console.log('  NEGATIVE CONTROLS — every historical defect below must still read as a violation');
for (const c of report.control) console.log(row(c) + (c.caught ? '' : '   <-- NOT CAUGHT'));
console.log('    the same respray point under the RACE gate\'s deck-forgiving rule, for contrast:');
console.log(row(report.lenient) + (report.lenient.caught ? '' : '   <-- passes, which is why services drop the deck exemption'));
console.log('');
console.log('  RACE GATES');
for (const c of report.race) console.log(row(c));
console.log('');
console.log('  CHAPTER STAGING POINTS');
for (const c of report.staging) console.log(row(c));
console.log('');
console.log('  BOSS ARENAS');
for (const c of report.arenas) console.log(row(c));
console.log('');
console.log(`  SERVICES — SHOPS + GAS_STATIONS, reach ${SERVICE_ROAD_MAX} m (RATCHET), no bridge-deck exemption`);
for (const c of report.services) console.log(row(c));

const uncaught = report.control.filter((c) => !c.caught);
const broken = [...report.race, ...report.staging, ...report.arenas, ...report.services]
  .filter((c) => c.fails.length);

console.log('');
if (uncaught.length) {
  console.log(`GROUND TRUTH GATE FAILED — the negative control did not fire on ` +
    `${uncaught.map((c) => c.label).join(', ')}: this gate is decorative`);
  process.exit(1);
}
if (broken.length) {
  console.log(`GROUND TRUTH GATE FAILED — ${broken.length} authored coordinate(s) the player cannot use:`);
  for (const c of broken) console.log(`  ${c.label}: ${c.fails.join('; ')}`);
  process.exit(1);
}
console.log(`GROUND TRUTH GATE PASSED — ${report.race.length} race gates, ${report.staging.length} chapter ` +
  `staging points, ${report.arenas.length} boss arenas and ${report.services.length} services are all on ` +
  `ground a car can reach, across ${SEEDS.length} seeds, and all ${report.control.length} authored ` +
  `river coordinates still read as violations.`);
