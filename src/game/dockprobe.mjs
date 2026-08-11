#!/usr/bin/env node
/**
 * DOCK PROBE — is there a boat on the three rivers, and can Carson use it?
 *
 *   node src/game/dockprobe.mjs
 *   node src/game/dockprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 * Carson's arc is eight chapters on the water and the game contained no boat a
 * player could reach. The only boat spawn anywhere in `src/` was his CH 1
 * delivery hull, which `MissionRunner.cleanup` force-despawns at the end of the
 * chapter; CH 2 is a land fight and CH 3 is a car race, so by CH 4 it was long
 * gone. `freeroam._seedAirportVehicles` parked a plane and a helicopter at each
 * airfield and seeded NOTHING at the three docks, while `src/ui/data.js` drew a
 * BOAT DOCK blip over each empty slip. CH 4 'Salvage Rights' is a 150 s water
 * collect and `collect.init` — alone among deliver / chase / escort / escape /
 * race / boss-driver, every one of which does `if (!g.wq.playerVehicle())
 * g.spawnVehicle(...)` — spawned nothing to travel in. Swim speed is 2.1 m/s
 * (3.4 sprinting), against six crates scattered in a 60-520 m annulus across
 * three rivers: the chapter could not be finished, and the campaign stopped at
 * 4 of 8.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS MEASURES, AND WHY IT IS NOT CIRCULAR
 * ---------------------------------------------------------------------------
 * Nothing here asks the mission or free-roam layer where it THINKS it put
 * something. Every assertion is made on the emitted handles and on a world
 * neither of them computed:
 *
 *   the boat       the `vehicles` handle's own position, class and mission tag,
 *                  read off the spawn list rather than off `_dockVehicles`.
 *   dry / wet      `Terrain.isWater` at those coordinates, and a radial scan
 *                  for the shore written out in this file — not `WorldQuery`'s
 *                  `_shoreWithin`, which is the predicate the placement used.
 *   the crates     the `PickupPool`'s own records (the real pool, not a stub).
 *   the reach      a nearest-neighbour tour over those emitted positions,
 *                  priced at 60% of a top speed DERIVED FROM THE SHIPPED SPEC
 *                  (`VEHICLE_SPECS.boat.hull`) rather than from a number typed
 *                  into this file.
 *   the survival   the same handles, re-read after a chapter has been started
 *                  and torn down.
 *
 * THE STUBS, stated where the next reader will see them. There is no `physics`
 * and no `vehicles` subsystem in node, so a boat here is a pose and a class id
 * with no hydrodynamics — this probe never claims a boat HANDLES, only that one
 * exists, floats where it was put and is close enough to walk to. And the top
 * speed is the 1-D steady state of `stepBoat`'s own longitudinal terms (thrust
 * against `dragLong`, fully wetted and planing), which is an upper bound on the
 * water; 60% of it is the travel budget, so a boat that never quite reaches its
 * terminal speed is inside the number this gate asserts. Everything else —
 * `FreeRoam`, `MissionRunner`, the `collect` track, `WorldQuery`, `PickupPool`
 * and the authored tables — is production code, unmodified.
 *
 * SEEDS. The rivers are the analytic terrain and are seed-free, so where a boat
 * MAY float does not vary; what varies is the rng each scatter draws from. One
 * emitted road graph is built (the mission layer needs one) and the six seeds
 * are spent where they buy something: on the mooring and crate draws.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS
 * ---------------------------------------------------------------------------
 *  1. SEEDING OFF. `freeroam.debugNoDockBoats` holds the fleet back — the world
 *     that shipped before this change. Every slip must read as empty, or this
 *     probe is not watching the seam it claims to.
 *  2. THE OLD SPREAD, PRICED. The same tour re-measured at the authored 520 m
 *     must not fit the clock. "Six crates are reachable" is free on a scatter
 *     that was always reachable.
 *  3. A PLAYER WHO ALREADY HAS A HULL is handed no second boat, or the track is
 *     not testing what the player is in — it is spawning unconditionally.
 */

import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { generateCity } from '../world/netgen.js';
import { Router } from '../world/route.js';
import { Rng } from '../core/rng.js';
import { MissionRunner } from './mission.js';
import { HostilePool } from './hostiles.js';
import { FreeRoam } from './freeroam.js';
import { PickupPool } from './pickups.js';
import { WorldQuery } from './util.js';
import { BOYZ, DOCKS, DIFFS, MARK_GREEN } from './data.js';
import { VEHICLE_SPECS } from '../vehicles/specs.js';
import { blankSave } from './save.js';

const VERBOSE = process.argv.includes('--verbose');
const SEED = 0x5eed1234;
/** The mooring and scatter draws must hold on all of these. */
const SEEDS = [0x5eed1234, 0x600d, 0xdeadbeef, 1337, 42, 0xabcdef];

let pass = 0, fail = 0;
const rows = [];
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  rows.push({ ok: !!ok, name, detail: String(detail ?? '') });
};

/** Frame step. Free roam seeds its fleet on the first one. */
const DT = 1 / 60;
/**
 * How far a moored boat may be from the PIER HEAD a `DOCKS` record names. The
 * blip is drawn on the pier, so a hull further out than this is a hull the
 * player has no reason to swim towards.
 */
const DOCK_REACH = 40;
/**
 * How far dry land may be from a boat or a crate. `WorldQuery`'s own
 * `nearShore` reach is 22 m; this is the independent reading of the same
 * promise, with a metre of slack for the radial scan's coarseness.
 */
const SHORE_REACH = 24;
/** Fraction of top speed a player actually holds through turns and pickups. */
const CRUISE = 0.6;

/* ========================================================================== */
/* the world                                                                  */
/* ========================================================================== */

const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
const graph = generateCity(terrain, new Rng(SEED).fork().fork()).graph;

/**
 * Top speed of the Riverjack, from the spec the game ships.
 *
 * The 1-D steady state of `stepBoat`: at full throttle in a straight line the
 * hull is fully wetted and planing, so thrust `hull.thrust * (0.35 + 0.65 * 1)`
 * balances `hull.dragLong * v^2 * 1 * (1 - 0.55 * 1)`. No hero multiplier —
 * Carson's 1.25 prop would only make the budget below more generous.
 */
const HULL = VEHICLE_SPECS.boat.hull;
const BOAT_TOP = Math.sqrt(HULL.thrust / (HULL.dragLong * (1 - 0.55)));
const BOAT_CRUISE = BOAT_TOP * CRUISE;

/** Is there dry land within `r`? A radial scan, written out here on purpose. */
function shoreDist(x, z, r = SHORE_REACH) {
  for (let d = 2; d <= r; d += 2) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      if (!terrain.isWater(x + Math.cos(a) * d, z + Math.sin(a) * d)) return d;
    }
  }
  return Infinity;
}

/** Nearest-neighbour tour from a start through every point, in metres. */
function tour(sx, sz, pts) {
  const left = pts.slice();
  let x = sx, z = sz, total = 0;
  while (left.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < left.length; i++) {
      const d = Math.hypot(left[i].x - x, left[i].z - z);
      if (d < bd) { bd = d; bi = i; }
    }
    total += bd;
    x = left[bi].x;
    z = left[bi].z;
    left.splice(bi, 1);
  }
  return total;
}

function makeWorld() {
  const router = new Router(graph);
  return {
    CITY_SIZE: 3584,
    roads: graph,
    heightAt: (x, z) => terrain.heightAt(x, z),
    walkableHeightAt: (x, z) => terrain.heightAt(x, z),
    isWater: (x, z) => terrain.isWater(x, z),
    surfaceAt: (x, z) => (terrain.isWater(x, z) ? 'water' : 'asphalt'),
    waterLevelAt: () => 0,
    isOpen: () => true,
    routeTo: (fx, fz, tx, tz, opts) => router.routeTo(fx, fz, tx, tz, opts),
  };
}

/* ========================================================================== */
/* the fleet — the stub, see the header                                       */
/* ========================================================================== */

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function makeVehicles() {
  const sys = {
    live: [],
    spawned: 0,
    spawn(type, pos, yaw = 0, opts) {
      const v = {
        type,
        // `vehicles` gives every handle its class spec; `tracks.waterCapable`
        // and `freeroam.isPolice` both read it, so the stub carries one too.
        spec: { id: type, kind: VEHICLE_SPECS[type]?.kind ?? 'car', name: VEHICLE_SPECS[type]?.name ?? type },
        name: VEHICLE_SPECS[type]?.name ?? type,
        position: new THREE.Vector3(pos.x, pos.y, pos.z),
        quaternion: new THREE.Quaternion().setFromEuler(_euler.set(0, yaw, 0, 'YXZ')),
        yaw,
        speed: 0,
        forwardSpeed: 0,
        health: 900,
        maxHealth: 900,
        destroyed: false,
        despawned: false,
        _marked: 0,
        tag: opts?.tag ?? null,
      };
      sys.live.push(v);
      sys.spawned++;
      return v;
    },
    nearest: () => null,
    setInput() {},
    damage() {},
    despawn(v, opts) {
      // The real guard: a live mission tag survives every cull but the
      // authorised teardown (`vehicles.despawn`, guard (b)).
      const force = opts === true || opts?.force === true || opts?.hard === true;
      if (!force && v?.isMission === true) return;
      const i = sys.live.indexOf(v);
      if (i >= 0) sys.live.splice(i, 1);
      if (v) v.despawned = true;
    },
    waterHeightAt: () => 0,
  };
  return sys;
}

/** Every live boat, read off the spawn list rather than off `_dockVehicles`. */
function boats(s) {
  return s.vehicles.live.filter((v) => v.spec.kind === 'boat' && !v.despawned);
}

/** The boat nearest this dock's pier head, and how far out it is moored. */
function moored(s, d) {
  let best = null, bd = Infinity;
  for (const v of boats(s)) {
    const dist = Math.hypot(v.position.x - d.x, v.position.z - d.z);
    if (dist < bd) { bd = dist; best = v; }
  }
  return { v: best, dist: bd };
}

/* ========================================================================== */
/* the rest of the harness                                                    */
/* ========================================================================== */

function bus() {
  const map = new Map();
  return {
    on(k, fn) { (map.get(k) ?? map.set(k, new Set()).get(k)).add(fn); return () => map.get(k)?.delete(fn); },
    off(k, fn) { map.get(k)?.delete(fn); },
    emit(k, p) { for (const fn of [...(map.get(k) ?? [])]) fn(p); },
  };
}

function fakePeds() {
  return {
    spawned: [],
    hostiles: { onKill: null, live: [], aliveCount: 0 },
    spawnHostile(v, opts) {
      const h = { position: { x: v.x, y: v.y, z: v.z }, yaw: 0, health: opts?.hp ?? 100, maxHealth: opts?.hp ?? 100, dead: false, active: true };
      this.spawned.push(h);
      return h;
    },
    despawnHostile(h) { if (h) h.active = false; },
    clearHostiles() { for (const h of this.spawned) h.active = false; },
    hurtHostile: () => false,
  };
}

/**
 * One free-roam session on the emitted city, with the real `FreeRoam`,
 * `MissionRunner`, `PickupPool` and `WorldQuery`.
 */
function scene({ seed = SEED, noBoats = false, difficulty = 'normal' } = {}) {
  const save = blankSave();
  save.difficulty = difficulty;
  const events = bus();
  const world = makeWorld();
  const vehicles = makeVehicles();
  const peds = fakePeds();
  const time = { raw: 0, elapsed: 0, dt: DT, scale: 1, frame: 0 };
  const player = {
    position: new THREE.Vector3(0, 0, 0),
    inVehicle: false, vehicle: null, dead: false,
    addTrauma() {}, applyDamage() {},
  };
  const bag = { world, vehicles, peds, player };
  const ctx = {
    rng: new Rng(seed).fork(), events, time,
    camera: { position: new THREE.Vector3() },
    scene: new THREE.Scene(),
    peek: (i) => bag[i] ?? null, get: (i) => bag[i] ?? null, has: (i) => i in bag,
  };
  const wq = new WorldQuery(ctx).init();
  const economy = {
    cash: 0, respect: 0, char: (who = 'carson') => save.chars[who],
    addCash: () => true, addRespect: () => [], unlockWeapon: () => false,
    hasUnlock: () => false, canAfford: () => true,
    priceRefill: () => ({ rounds: 0, cost: 0 }),
  };
  const heat = { wanted: 0, authoritative: false, raise() {}, clear() {}, heat() {}, setPursuitEnabled() {} };
  const pickups = new PickupPool(ctx, wq).init();
  const hostiles = new HostilePool(ctx, wq).init();
  const missions = new MissionRunner(ctx, { wq, economy, heat, hostiles, pickups, save });
  const freeroam = new FreeRoam(ctx, { wq, economy, heat, pickups, missions, save });
  freeroam.boy = BOYZ.carson;
  freeroam.debugNoDockBoats = noBoats;
  bag.game = { missions, pickups, freeroam };
  const fails = [];
  const wins = [];
  events.on('mission:fail', (p) => fails.push({ ...p }));
  events.on('mission:complete', (p) => wins.push({ ...p }));
  return { save, wq, events, world, vehicles, pickups, ctx, missions, freeroam, time, player, fails, wins };
}

/** Run free roam for `n` frames, exactly as `game._update` does. */
function roam(s, n = 4) {
  for (let i = 0; i < n; i++) {
    s.time.raw += DT;
    s.time.elapsed += DT;
    s.time.frame++;
    s.freeroam.update(DT);
  }
}

/** Stand the player on a point, on foot. */
function stand(s, x, z) {
  s.player.position.set(x, terrain.heightAt(x, z), z);
  s.player.inVehicle = false;
  s.player.vehicle = null;
}

/** Carson CH 4, from a cold start on the bank at the anchor it names. */
function startSalvage(s, { spread = null } = {}) {
  const boy = BOYZ.carson;
  const idx = boy.story.findIndex((c) => c.track === 'collect' && c.water);
  const c = boy.story[idx];
  const poi = s.wq.poi(c.at);
  stand(s, poi.x, poi.z);
  if (spread !== null) {
    // The counterfactual runs the authored 520 through the same code path.
    const def = { ...c, spread };
    s.missions.startCustom(boy, def, `carson:salvage:${spread}`);
  } else {
    s.missions.start(boy, idx);
  }
  s.missions.forceBegin();
  return { boy, idx, c, poi };
}

/** The mission crates, off the real pool. */
function crates(s) {
  return s.pickups.live.filter((p) => p.mission && !p.taken).map((p) => ({ x: p.x, z: p.z }));
}

/* ========================================================================== */
/* 1 — a boat is moored at every slip, at the free-roam seed                  */
/* ========================================================================== */

const moor = { worst: 0, worstShore: 0, perDock: new Map() };

{
  for (const seed of SEEDS) {
    const s = scene({ seed });
    stand(s, 632, -464); // the body shop, a kilometre from any river
    roam(s);
    for (const d of DOCKS) {
      const m = moored(s, d);
      const rec = moor.perDock.get(d.id) ?? { far: 0, near: Infinity, shore: 0, misses: 0, wet: 0 };
      if (!m.v || m.dist > DOCK_REACH) rec.misses++;
      else {
        rec.far = Math.max(rec.far, m.dist);
        rec.near = Math.min(rec.near, m.dist);
        rec.shore = Math.max(rec.shore, shoreDist(m.v.position.x, m.v.position.z));
        if (terrain.isWater(m.v.position.x, m.v.position.z)) rec.wet++;
        moor.worst = Math.max(moor.worst, m.dist);
        moor.worstShore = Math.max(moor.worstShore, rec.shore);
      }
      moor.perDock.set(d.id, rec);
    }
  }

  let misses = 0, dry = 0, unreachable = 0;
  for (const [, r] of moor.perDock) {
    misses += r.misses;
    dry += SEEDS.length - r.wet - r.misses;
    if (r.shore > SHORE_REACH) unreachable++;
  }

  check('every DOCKS slip has a boat moored within 40 m of its pier head, on all six seeds',
    misses === 0,
    [...moor.perDock].map(([id, r]) =>
      `${id} ${r.near === Infinity ? 'NONE' : `${r.near.toFixed(0)}-${r.far.toFixed(0)} m`}`).join(', ') +
    ` (${SEEDS.length * DOCKS.length} placements, ${misses} missing)`);

  check('and every one of them is FLOATING, not parked on the bank',
    dry === 0, `${SEEDS.length * DOCKS.length - dry} of ${SEEDS.length * DOCKS.length} on water by Terrain.isWater`);

  check('...with dry land inside a walkable reach of the hull',
    unreachable === 0,
    `worst shore distance ${moor.worstShore.toFixed(0)} m of ${SHORE_REACH} m — ` +
    `swimming out to one at 2.1 m/s is ${(moor.worstShore / 2.1).toFixed(0)} s at worst`);
}

/* ========================================================================== */
/* 2 — nothing in the game takes them away again                              */
/* ========================================================================== */

{
  const s = scene();
  stand(s, 632, -464);
  roam(s);
  const before = boats(s).slice();
  const seeded = s.vehicles.spawned;

  // Idempotent: a hundred more frames must not moor a second fleet.
  roam(s, 100);
  check('the fleet is seeded ONCE, not once a frame',
    boats(s).length === before.length && s.vehicles.spawned === seeded,
    `${before.length} boats after 4 frames, ${boats(s).length} after 104 (${s.vehicles.spawned} total spawns)`);

  check('NEG CONTROL: none of them carries a mission tag',
    before.every((v) => v.isMission !== true && v.tag == null),
    `tags ${JSON.stringify(before.map((v) => v.tag))}`);

  // The one authorised force-despawner in the game runs at the end of every
  // chapter. Start one, tear it down, and count the hulls that are left.
  startSalvage(s);
  const missionBoats = s.missions.M.spawnedVehicles.filter((v) => v.spec.kind === 'boat');
  s.missions.abort();
  const survivors = boats(s);

  check('a chapter starting and being torn down leaves every moored boat where it was',
    survivors.length === before.length && before.every((v) => survivors.includes(v)),
    `${survivors.length} of ${before.length} survive cleanup, which force-despawned ` +
    `${missionBoats.length} mission hull(s)`);
}

/* ========================================================================== */
/* 3 — Carson CH 4 hands a cold-start player a marked boat                    */
/* ========================================================================== */

const cold = { dist: 0, shore: 0, mark: 0, crates: 0 };

{
  for (const seed of SEEDS) {
    const s = scene({ seed });
    // No dock fleet at all: the chapter must stand on its own, because the
    // player may have sunk, sold or stranded every boat in the city.
    s.freeroam.debugNoDockBoats = true;
    const { poi } = startSalvage(s);
    const M = s.missions.M;
    const v = M.veh;
    if (!v) { cold.dist = Infinity; break; }
    cold.dist = Math.max(cold.dist, Math.hypot(v.position.x - poi.x, v.position.z - poi.z));
    cold.shore = Math.max(cold.shore, shoreDist(v.position.x, v.position.z));
    cold.mark = v._marked;
    cold.crates = crates(s).length;

    if (seed === SEED) {
      check('Carson CH 4 from a cold start spawns a WATER-CAPABLE hull',
        v.spec.kind === 'boat' && terrain.isWater(v.position.x, v.position.z),
        `${v.name} at (${v.position.x.toFixed(0)}, ${v.position.z.toFixed(0)}), ` +
        `${Math.hypot(v.position.x - poi.x, v.position.z - poi.z).toFixed(0)} m off ${poi.name}, ` +
        `on water ${terrain.isWater(v.position.x, v.position.z)}`);

      check('...marked GREEN, the fetch-it colour every other track uses',
        v._marked === MARK_GREEN, `_marked 0x${(v._marked ?? 0).toString(16)} (MARK_GREEN 0x${MARK_GREEN.toString(16)})`);

      check('...and the chapter still scatters its six crates',
        crates(s).length === 6, `${crates(s).length} mission crates in the pool`);
    }
  }

  check('the courtesy boat is moored within walking distance of the anchor, on all six seeds',
    cold.dist <= 110 && cold.shore <= SHORE_REACH,
    `worst ${cold.dist.toFixed(0)} m from The Point, worst shore ${cold.shore.toFixed(0)} m`);
}

{
  // NEG CONTROL 3: a player who arrived in a boat is handed nothing.
  const s = scene();
  s.freeroam.debugNoDockBoats = true;
  const poi = s.wq.poi('lm_point');
  stand(s, poi.x, poi.z);
  const own = s.vehicles.spawn('boat', { x: poi.x + 30, y: 0, z: poi.z + 30 }, 0);
  s.player.inVehicle = true;
  s.player.vehicle = own;
  const boy = BOYZ.carson;
  const idx = boy.story.findIndex((c) => c.track === 'collect' && c.water);
  s.missions.start(boy, idx);
  s.missions.forceBegin();

  check('NEG CONTROL: a player already in a boat is handed no second one',
    s.missions.M.veh == null && boats(s).length === 1,
    `${boats(s).length} boat(s) in the world, M.veh ${s.missions.M.veh ? 'spawned' : 'null'}`);
}

/* ========================================================================== */
/* 4 — six crates inside the clock, at 60% of the hull's top speed            */
/* ========================================================================== */

const reach = { worst: 0, worstLen: 0, best: Infinity, steel: 0, old: { worst: 0, worstLen: 0 } };

{
  reach.steel = 150 * DIFFS.steel.timerMul;

  for (const seed of SEEDS) {
    const s = scene({ seed, difficulty: 'steel' });
    s.freeroam.debugNoDockBoats = true;
    startSalvage(s);
    const M = s.missions.M;
    const v = M.veh;
    const pts = crates(s);
    const len = tour(v.position.x, v.position.z, pts);
    const secs = len / BOAT_CRUISE;
    reach.worstLen = Math.max(reach.worstLen, len);
    reach.worst = Math.max(reach.worst, secs);
    reach.best = Math.min(reach.best, secs);
    if (VERBOSE) {
      console.log(`    seed ${seed.toString(16).padStart(8)}: ${pts.length} crates, tour ${len.toFixed(0)} m, ` +
        `${secs.toFixed(0)} s of ${M.timer.toFixed(0)} s armed`);
    }
    // Every crate must also be somewhere a boat can float up to.
    const stranded = pts.filter((p) => !terrain.isWater(p.x, p.z) || shoreDist(p.x, p.z) > SHORE_REACH);
    if (seed === SEED) {
      check('every crate is on the water with a bank inside reach of it',
        stranded.length === 0, `${pts.length - stranded.length} of ${pts.length} reachable`);
    }
  }

  check('the six-crate tour fits the STEEL clock at 60% of the hull\'s top speed',
    reach.worst <= reach.steel,
    `worst ${reach.worstLen.toFixed(0)} m = ${reach.worst.toFixed(0)} s, best ${reach.best.toFixed(0)} s, ` +
    `against ${reach.steel.toFixed(0)} s (150 s x ${DIFFS.steel.timerMul}) — ` +
    `${(BOAT_TOP).toFixed(1)} m/s top, ${BOAT_CRUISE.toFixed(1)} m/s budgeted`);
}

{
  // NEG CONTROL 2: the authored 520 m spread, through the same code path.
  for (const seed of SEEDS) {
    const s = scene({ seed, difficulty: 'steel' });
    s.freeroam.debugNoDockBoats = true;
    startSalvage(s, { spread: 520 });
    const M = s.missions.M;
    const len = tour(M.veh.position.x, M.veh.position.z, crates(s));
    reach.old.worstLen = Math.max(reach.old.worstLen, len);
    reach.old.worst = Math.max(reach.old.worst, len / BOAT_CRUISE);
  }

  check('NEG CONTROL: at the authored 520 m spread the same tour does NOT fit',
    reach.old.worst > reach.steel,
    `${reach.old.worstLen.toFixed(0)} m = ${reach.old.worst.toFixed(0)} s against ${reach.steel.toFixed(0)} s — ` +
    `and swimming it at 2.1 m/s is ${(reach.old.worstLen / 2.1 / 60).toFixed(0)} min`);
}

/* ========================================================================== */
/* 5 — NEGATIVE CONTROL: seeding off, and the slips are empty                 */
/* ========================================================================== */

{
  const s = scene({ noBoats: true });
  stand(s, 632, -464);
  roam(s, 60);
  const found = DOCKS.map((d) => moored(s, d)).filter((m) => m.v && m.dist <= DOCK_REACH);

  check('NEG CONTROL: with the dock fleet held back every slip reads as empty',
    found.length === 0 && boats(s).length === 0,
    `${boats(s).length} boats in the whole city after 60 frames of free roam — ` +
    `the world as it shipped before this change`);
}

/* ========================================================================== */

for (const r of rows) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(78)}${r.detail}`);
}
console.log('');
console.log(`dock (the three slips + Carson CH 4, headless on the emitted city, ${SEEDS.length} seeds):  ${pass}/${pass + fail}`);
console.log(`  moored: worst ${moor.worst.toFixed(0)} m off the pier of ${DOCK_REACH} m, ` +
  `worst shore ${moor.worstShore.toFixed(0)} m`);
console.log(`  salvage: courtesy boat ${cold.dist.toFixed(0)} m off the anchor, ${cold.crates} crates, ` +
  `tour ${reach.worstLen.toFixed(0)} m = ${reach.worst.toFixed(0)} s of the ${reach.steel.toFixed(0)} s steel clock`);
console.log(`  control: spread 520 -> ${reach.old.worstLen.toFixed(0)} m = ${reach.old.worst.toFixed(0)} s, ` +
  `seeding off -> 0 boats`);

process.exit(fail ? 1 : 0);
