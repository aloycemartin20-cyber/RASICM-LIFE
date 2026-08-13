#!/usr/bin/env node
/**
 * ESCORT PROBE — Aidan CH 5 ("The Long Haul"), headless, on the real city.
 *
 *   node src/game/escortprobe.mjs
 *   node src/game/escortprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 * The chapter escorts a truck from `sh_aidan` (632, -464) to `sh_dylan`
 * (-504, 432). Every mission actor in the game was steered by one pure-pursuit
 * function against a raw (x, z) with no road graph, so the truck drove the
 * STRAIGHT LINE between those two points — and that line crosses the
 * Monongahela channel: sampling it, t = 0.75 (-220, 208) and t = 0.80
 * (-277, 253) are both open water. A land vehicle in water loses 6% of max
 * health a second against the truck's 520 HP, so the chapter failed
 * deterministically at about seventeen seconds.
 *
 * Two independent blockers sat in the same forty lines. The ambush spawner
 * reset its timer unconditionally with no concurrency cap and no despawn, so a
 * muscle car arrived every 11 s for the whole run, never left (mission
 * vehicles are exempt from the streaming cull), and every survivor rammed for
 * 34 HP/s — four converging was 136 HP/s. And there was no stuck watchdog and
 * no chapter clock, so a truck wedged on a bollard neither won nor failed.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS MEASURES, AND WHY IT IS NOT CIRCULAR
 * ---------------------------------------------------------------------------
 * Nothing here calls `driveRoute`, reads `world.routeTo`'s answer, or asks the
 * mission layer where it thinks the truck is. Every assertion is made on the
 * EMITTED TRAJECTORY — the sequence of positions the truck's own integration
 * produced — read against a world neither the route solver nor the track
 * computed:
 *
 *   wet          `Terrain.isWater` at the truck's own coordinates, minus the
 *                one case where being over water is correct (a bridge DECK
 *                over the point, above the pool). The deck test is written out
 *                in this file as a brute-force scan of the emitted node
 *                positions rather than `roads.nearestEdge`, so it is an
 *                independent reading of the graph and not an echo of the
 *                spatial index the router used to plan.
 *   on the road  the same brute-force scan's distance to the nearest drivable
 *                carriageway, sampled along the whole run.
 *   the cap      a count of `isAmbush && !destroyed` entries in the runner's
 *                own `M.spawnedVehicles`, taken every step.
 *   the ram      the truck's HEALTH, before and after a fixed second of three
 *                cars in contact. Not the constant, not the call count.
 *   the wedge    the truck's POSITION and the runner's phase/result card.
 *
 * THE ONE STUB, stated where the next reader will see it (ARCHITECTURE.md
 * rule 12's lesson about stubs): there is no `physics` and no `vehicles`
 * subsystem in node, so this file carries a bicycle-model car — throttle,
 * brake, a speed-scaled yaw rate, forward integration — and lifts each car's
 * HEIGHT off the emitted road graph, because a car on the Fort Pitt deck is
 * seventeen metres above the terrain under it. That stub asserts that nothing
 * about tyre grip, suspension or collision can be wrong here, which is true of
 * what this probe is for and false in general: the drivetrain gates live in
 * `src/vehicles/`. Everything it steers with — `driveRoute`, `driveToward`,
 * `WorldQuery`, `Router`, `MissionRunner` and the real `escort` track — is
 * production code, unmodified.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS
 * ---------------------------------------------------------------------------
 *  1. ROUTING OFF. The same run with `world.routeTo` removed — the exact
 *     fallback `driveRoute` documents for a bench with no road graph, and
 *     exactly what shipped before this change. The truck must go WET, or this
 *     probe is not watching the seam it claims to.
 *  2. THE RAM, PRICED. The same three-car second is re-measured with the ram
 *     forced back to its old 34 HP/s, and must take visibly more hull off. A
 *     probe that only asserts "the truck survived" passes on a build where the
 *     ambushers do nothing at all.
 *  3. THE CAP IS DOING WORK. The run must ATTEMPT more ambush spawns than the
 *     cap allows. "Never more than three alive" is free on a run that only
 *     ever spawned two.
 */

import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { generateCity } from '../world/netgen.js';
import { Router } from '../world/route.js';
import { Rng } from '../core/rng.js';
import { MissionRunner } from './mission.js';
import { HostilePool } from './hostiles.js';
import { WorldQuery } from './util.js';
import { BOYZ, R } from './data.js';
import { blankSave } from './save.js';

const VERBOSE = process.argv.includes('--verbose');
const SEED = 0x5eed1234;

let pass = 0, fail = 0;
const rows = [];
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  rows.push({ ok: !!ok, name, detail: String(detail ?? '') });
};

/** Simulation step. 20 Hz — the truck covers 0.7 m per step at cruise. */
const DT = 0.05;
/** Hard ceiling on a run, well past the chapter's own 360 s clock. */
const MAX_STEPS = Math.ceil(500 / DT);
/** How often the trajectory is scored against the terrain. */
const SAMPLE_EVERY = 10;
/**
 * How far off a lane the truck may stray and still count as on the road.
 * Half the widest carriageway plus a verge — a truck cornering wide is on the
 * road, a truck across a car park is not.
 */
const ON_ROAD = 14;

/* ========================================================================== */
/* the world                                                                  */
/* ========================================================================== */

const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
const graph = generateCity(terrain, new Rng(SEED).fork().fork()).graph;

/**
 * Nearest DRIVABLE edge to a point, by brute force over the emitted node
 * positions. Deliberately NOT `roads.nearestEdge`: the router plans with that
 * index, and a gate that scores the plan with the planner's own index is
 * reading its own input.
 */
const _near = { dist: Infinity, edge: null, t: 0 };
function nearestDrivable(x, z) {
  _near.dist = Infinity;
  _near.edge = null;
  _near.t = 0;
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
    if (d < _near.dist) { _near.dist = d; _near.edge = e; _near.t = t; }
  }
  return _near;
}

/**
 * Is this point in the river? Being over water on a BRIDGE DECK is not — the
 * carriageway has to be over the point and above the pool, which is the same
 * test `groundtruthprobe` applies to an authored coordinate.
 */
function inTheRiver(x, z) {
  if (!terrain.isWater(x, z)) return false;
  const hit = nearestDrivable(x, z);
  const e = hit.edge;
  if (!e || !e.bridge) return true;
  const na = graph.nodes[e.a];
  const nb = graph.nodes[e.b];
  return !(hit.dist <= (e.width ?? 8) * 0.5 && Math.min(na.y, nb.y) > 0);
}

/** The height a car at (x, z) rides at — the deck if it is on one. HARNESS. */
function carY(x, z) {
  const hit = graph.nearestEdge(x, z, 40);
  const e = hit.edge;
  if (!e) return terrain.heightAt(x, z);
  const na = graph.nodes[e.a];
  const nb = graph.nodes[e.b];
  if (hit.dist > (e.width ?? 8) * 0.5 + 3) return terrain.heightAt(x, z);
  return na.y + (nb.y - na.y) * (typeof hit.t === 'number' ? hit.t : 0.5);
}

function makeWorld(routing = true) {
  const router = new Router(graph);
  const w = {
    CITY_SIZE: 3584,
    roads: graph,
    heightAt: (x, z) => terrain.heightAt(x, z),
    walkableHeightAt: (x, z) => terrain.heightAt(x, z),
    isWater: (x, z) => terrain.isWater(x, z),
    surfaceAt: (x, z) => (terrain.isWater(x, z) ? 'water' : 'asphalt'),
    waterLevelAt: () => 0,
    isOpen: () => true,
  };
  // The negative control simply does not publish the method, which is exactly
  // the shape `driveRoute` falls back for: a bench with no road routing.
  if (routing) w.routeTo = (fx, fz, tx, tz, opts) => router.routeTo(fx, fz, tx, tz, opts);
  return w;
}

/* ========================================================================== */
/* the cars — the one stub, see the header                                    */
/* ========================================================================== */

/** Top speed / acceleration / yaw authority, per `vehicles` class id. */
const CARS = {
  truck: { top: 22, accel: 5.0, brake: 9, turn: 0.95, hp: 900 },
  muscle: { top: 34, accel: 8.5, brake: 12, turn: 1.35, hp: 900 },
  sports: { top: 38, accel: 9.5, brake: 13, turn: 1.5, hp: 900 },
  sedan: { top: 30, accel: 7.0, brake: 11, turn: 1.2, hp: 900 },
  police: { top: 36, accel: 9.0, brake: 12, turn: 1.4, hp: 900 },
};

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function makeCar(type, x, y, z, yaw) {
  const spec = CARS[type] ?? CARS.sedan;
  const v = {
    type, spec,
    position: new THREE.Vector3(x, y, z),
    quaternion: new THREE.Quaternion(),
    yaw,
    speed: 0,
    forwardSpeed: 0,
    health: spec.hp,
    maxHealth: spec.hp,
    destroyed: false,
    despawned: false,
    pinned: false,
    inp: { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false },
    driven: false,
    setPose(pos, y2) {
      this.position.copy(pos);
      this.yaw = y2;
      this.speed = 0;
      this.forwardSpeed = 0;
      this.quaternion.setFromEuler(_euler.set(0, y2, 0, 'YXZ'));
    },
  };
  v.quaternion.setFromEuler(_euler.set(0, yaw, 0, 'YXZ'));
  return v;
}

function stepCar(v, dt) {
  if (v.destroyed || v.despawned) return;
  const i = v.inp;
  const s = v.spec;
  if (!v.driven) { i.throttle = 0; i.brake = 0.25; i.steer = 0; }
  const drag = 0.06 * v.speed + 0.004 * v.speed * v.speed;
  v.speed += (i.throttle * s.accel * (i.boost ? 1.25 : 1) - i.brake * s.brake - drag) * dt;
  if (v.speed < 0) v.speed = 0;
  const top = s.top * (i.boost ? 1.15 : 1);
  if (v.speed > top) v.speed = top;
  // Yaw authority scales with speed: a stopped car does not turn on the spot.
  v.yaw += i.steer * s.turn * Math.min(1, v.speed / 7) * dt;
  if (!v.pinned) {
    v.position.x += Math.sin(v.yaw) * v.speed * dt;
    v.position.z += Math.cos(v.yaw) * v.speed * dt;
  } else {
    v.speed = 0;
  }
  v.position.y = carY(v.position.x, v.position.z) + 0.6;
  v.forwardSpeed = v.speed;
  v.quaternion.setFromEuler(_euler.set(0, v.yaw, 0, 'YXZ'));
  v.driven = false;
}

function makeVehicles() {
  const sys = {
    live: [],
    spawn(type, pos, yaw = 0) {
      const v = makeCar(type, pos.x, pos.y, pos.z, yaw);
      sys.live.push(v);
      return v;
    },
    setInput(v, inp) {
      const i = v.inp;
      i.throttle = inp.throttle;
      i.brake = inp.brake;
      i.steer = inp.steer;
      i.handbrake = !!inp.handbrake;
      i.boost = !!inp.boost;
      v.driven = true;
    },
    damage(v, amount) {
      if (!v || v.destroyed) return;
      v.health -= amount;
      if (v.health <= 0) { v.health = 0; v.destroyed = true; }
    },
    despawn(v) {
      const i = sys.live.indexOf(v);
      if (i >= 0) sys.live.splice(i, 1);
      if (v) v.despawned = true;
    },
    waterHeightAt: () => 0,
  };
  return sys;
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

/**
 * `ui`, INCLUDING THE HALF OF IT THAT LIVES ON THE BUS.
 *
 * The result card is not something `game` hands to `ui` — it is something `ui`
 * raises for ITSELF off `mission:complete` / `mission:fail`
 * (`src/ui/index.js:874` and `:881`, each calling `this.card(...)`). A stand-in
 * that implements only the `card()` method models half the subsystem, and the
 * missing half is not inert: it is a SECOND card and a second `mission_pass` /
 * `mission_fail` sting on every mission end in the shipped game, which this
 * probe scored as one for as long as it only counted direct calls.
 *
 * Rule 12's stub lesson, exactly — a stub is an assertion that nothing
 * downstream of it can be wrong. So `wire()` subscribes the same two handlers
 * the real file does, and `cards` therefore counts EVERY card the player would
 * see, whichever side raised it. `s.ui.cards.length === 1` at an end is then a
 * claim about the screen rather than about one call site.
 */
function fakeUi() {
  return {
    cards: [], lines: [],
    notify() {}, card(kind, sub) { this.cards.push({ kind, sub }); },
    say(who, line) { this.lines.push({ who, line }); },
    setCharacter() {}, setMoney() {}, setStation() {}, setWaypoint() {},
    setObjectives() {}, clearObjective() {}, titleCard() {},
    /**
     * `src/ui/index.js`'s own two mission listeners, PLUS the `carded` guard
     * `mission.js:_finish` publishes for them (see the note there — the two
     * lines are not landed in `ui` yet, and this is what gates the contract in
     * the meantime). An emitter that drew its own card stands the fallback
     * down; `jobs._endLite`, which draws none, is unaffected.
     */
    wire(events) {
      events.on('mission:complete', (e) => {
        this.clearObjective();
        if (e?.carded) return;
        this.card('passed', e?.name ?? '');
      });
      events.on('mission:fail', (e) => {
        this.clearObjective();
        if (e?.carded) return;
        this.card('failed', e?.reason ?? '');
      });
      return this;
    },
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

function scene({ routing = true } = {}) {
  const save = blankSave();
  const events = bus();
  const ui = fakeUi().wire(events);
  const world = makeWorld(routing);
  const vehicles = makeVehicles();
  const peds = fakePeds();
  const time = { raw: 0, elapsed: 0, dt: DT, scale: 1, frame: 0 };
  const player = {
    position: new THREE.Vector3(0, 0, 0),
    inVehicle: false, vehicle: null, dead: false,
    addTrauma() {}, applyDamage() {},
  };
  const bag = { world, vehicles, peds, player, ui };
  const ctx = {
    rng: new Rng(SEED).fork(), events, time,
    camera: { position: new THREE.Vector3() },
    scene: new THREE.Scene(),
    peek: (i) => bag[i] ?? null, get: (i) => bag[i] ?? null, has: (i) => i in bag,
  };
  const wq = new WorldQuery(ctx).init();
  const economy = {
    cash: 0, respect: 0, char: (who = 'aidan') => save.chars[who],
    /** Every credit the runner actually moved, so a payout can be read back. */
    paid: [],
    addCash(n) { this.paid.push(n); }, addRespect: () => [], unlockWeapon: () => false,
  };
  const heat = { wanted: 0, raise() {}, clear() {}, heat() {}, setPursuitEnabled() {} };
  const pickups = { spawn: () => null, despawn() {}, clearMission() {}, countMission: () => 0, nearestMission: () => null };
  const hostiles = new HostilePool(ctx, wq).init();
  const missions = new MissionRunner(ctx, { wq, economy, heat, hostiles, pickups, save });
  bag.game = { missions, pickups };
  const fails = [];
  const wins = [];
  events.on('mission:fail', (p) => fails.push({ ...p }));
  events.on('mission:complete', (p) => wins.push({ ...p }));
  return { save, ui, wq, events, world, vehicles, ctx, missions, time, player, fails, wins, economy };
}

/** Start Aidan CH 5 and walk it out of the intro into the run phase. */
function startEscort(s) {
  const boy = BOYZ.aidan;
  const idx = boy.story.findIndex((c) => c.track === 'escort');
  const from = boy.story[idx].from;
  // Stand him on the staging POI so the runner skips its `travel` phase.
  const poi = s.wq.poi(from);
  s.player.position.set(poi.x, 0, poi.z);
  s.missions.start(boy, idx);
  for (let i = 0; i < 8 && s.missions.M.phase === 'intro'; i++) s.missions.update(1);
  return { boy, idx, poi };
}

/**
 * Step the whole sim until the chapter ends or the ceiling is hit.
 *
 * `onStep` runs AFTER the cars have moved, so what it reads is the emitted
 * trajectory rather than the inputs that produced it.
 */
function drive(s, onStep, maxSteps = MAX_STEPS) {
  let steps = 0;
  while (steps < maxSteps && s.missions.M && s.missions.M.phase !== 'over') {
    s.time.raw += DT;
    s.time.elapsed += DT;
    s.time.frame++;
    s.missions.update(DT);
    for (const v of s.vehicles.live) stepCar(v, DT);
    steps++;
    onStep?.(steps);
  }
  return steps;
}

/**
 * A point near (x, z) that is genuinely OFF the network — a yard or a lot, not
 * the next street over. Steel City's grid is dense enough that a fixed offset
 * usually lands on another carriageway, which is not the case the stuck
 * watchdog exists for.
 */
function offRoadSpotNear(x, z) {
  for (let r = 20; r <= 90; r += 6) {
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const px = x + Math.cos(ang) * r;
      const pz = z + Math.sin(ang) * r;
      if (terrain.isWater(px, pz)) continue;
      if (nearestDrivable(px, pz).dist > 22) return { x: px, z: pz };
    }
  }
  return { x, z };
}

/** Live ambush cars the runner is holding, counted off its own array. */
function liveAmbush(M) {
  let n = 0;
  for (const v of M.spawnedVehicles) if (v.isAmbush && !v.destroyed) n++;
  return n;
}

/* ========================================================================== */
/* 1 — the truck crosses Steel City by road and arrives dry                   */
/* ========================================================================== */

const main = { steps: 0, wet: 0, samples: 0, offRoad: 0, worstRoad: 0, maxAmbush: 0, spawns: 0, hull: 1 };

{
  const s = scene();
  const { poi } = startEscort(s);
  const M = s.missions.M;
  const ally = M.ally;
  const dest = M.dest;
  const straight = Math.hypot(dest.x - poi.x, dest.z - poi.z);

  check('Aidan CH 5 is live with a truck on the road at the body shop',
    !!ally && s.missions.running === true && M.track === 'escort',
    `${M.def?.no} ${M.def?.name}, truck at (${ally?.position.x.toFixed(0)}, ${ally?.position.z.toFixed(0)}), ` +
    `dest ${dest.name} (${dest.x}, ${dest.z}), ${straight.toFixed(0)} m as the crow flies`);

  // The wet band's t-position moves whenever either safehouse is re-sited
  // (sh_dylan moved off the cliff in the R3 spawn work), so the precondition
  // scans the WHOLE line rather than pinning two historical t-values. What it
  // guards is unchanged: this chapter must remain a hard river-crossing case,
  // or the routed/control arms below stop testing anything.
  let wetT = -1;
  let wetRun = 0;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    if (inTheRiver(poi.x + (dest.x - poi.x) * t, poi.z + (dest.z - poi.z) * t)) {
      wetRun++;
      if (wetRun >= 3 && wetT < 0) wetT = t;
    } else wetRun = 0;
  }
  check('THE PRE-FIX BLOCKER: the straight line between the two safehouses is in the Monongahela',
    wetT >= 0,
    wetT >= 0
      ? `a >=3-sample wet band starts at t=${wetT.toFixed(2)} ` +
        `(${(poi.x + (dest.x - poi.x) * wetT).toFixed(0)}, ${(poi.z + (dest.z - poi.z) * wetT).toFixed(0)})`
      : 'no wet band found — this route no longer crosses a river and the probe tests nothing');

  check('the chapter now carries a hard clock', M.hasTimer === true && M.timer > 60,
    `${M.timer.toFixed(0)} s armed`);

  const seen = new Set();
  let closest = Infinity;
  main.steps = drive(s, (n) => {
    const live = liveAmbush(M);
    if (live > main.maxAmbush) main.maxAmbush = live;
    for (const v of M.spawnedVehicles) if (v.isAmbush && !seen.has(v)) { seen.add(v); main.spawns++; }
    if (M.state === 'run') {
      const dd = Math.hypot(ally.position.x - dest.x, ally.position.z - dest.z);
      if (dd < closest) closest = dd;
    }
    if (n % SAMPLE_EVERY) return;
    main.samples++;
    if (inTheRiver(ally.position.x, ally.position.z)) main.wet++;
    const d = nearestDrivable(ally.position.x, ally.position.z).dist;
    if (d > main.worstRoad) main.worstRoad = d;
    if (d > ON_ROAD) main.offRoad++;
  });
  main.hull = ally.health / ally.maxHealth;

  // The load-bearing evidence for "it arrived" is the EMITTED `mission:complete`
  // plus the dry, on-lane trajectory below; the radius clause only reports how
  // close it actually got, and shares the track's own number.
  const won = s.wins.length === 1 && s.fails.length === 0;
  check('the truck ARRIVES at the drop',
    won && closest < R.dropoff,
    `${(main.steps * DT).toFixed(0)} s of sim, closed to ${closest.toFixed(1)} m of ${dest.name} ` +
    `(drop radius ${R.dropoff} m), hull ${(main.hull * 100).toFixed(0)}%, ` +
    `${won ? 'JOB DONE' : (s.fails[0]?.reason ?? 'still running')}`);

  check('and it never touches the water on the way',
    main.wet === 0 && main.samples > 200,
    `${main.wet} of ${main.samples} sampled positions in a river (bridge decks excluded)`);

  /**
   * THE ANTI-HANG CLOCK IS NOT A PAYOUT. `win` prices
   * `max(0, timer) * TIME_BONUS * rate` for anything carrying `hasTimer`, and
   * this chapter authors no `baseTimer` at all — so arming a watchdog to stop
   * a wedged truck hanging the chapter quietly handed the player hundreds of
   * unauthored dollars on top of a 2900 purse, scaled by how fast the TRUCK
   * drove itself. Read off the money that actually moved (`economy.addCash`)
   * and off the emitted payload the card prints, never off `M.bonus`.
   */
  const paid = s.economy.paid.reduce((a, b) => a + b, 0);
  check('the anti-hang clock pays no time bonus',
    won && s.wins[0].bonus === 0 && paid === M.def.cash,
    `bonus ${s.wins[0]?.bonus}, $${paid} paid against an authored purse of $${M.def.cash}, ` +
    `with ${Math.max(0, M.timer).toFixed(0)} s still on the clock`);

  // RATCHET (ARCHITECTURE.md rule 13). MEASURED at 4.0% on the run this was
  // written against; the goal is ~0, and what is left is cornering overshoot
  // where `driveToward` aims 22 m ahead through a tight junction. LOWER THIS
  // when the follower improves; never raise it to make a run go green.
  check('it stays on the carriageway rather than cutting across lots',
    main.offRoad <= main.samples * 0.08,
    `${main.offRoad}/${main.samples} (${(100 * main.offRoad / Math.max(1, main.samples)).toFixed(1)}%) ` +
    `samples more than ${ON_ROAD} m from a lane, worst ${main.worstRoad.toFixed(1)} m — RATCHET 8%`);

  check('THE CAP: never more than three ambushers alive at once',
    main.maxAmbush <= 3, `peak ${main.maxAmbush} concurrent`);

  check('NEG CONTROL: the cap was actually doing work — more were spawned than it allows',
    main.spawns > 3, `${main.spawns} ambush cars spawned over the run`);

  check('and the run finished inside the chapter clock rather than the harness ceiling',
    main.steps < MAX_STEPS, `${main.steps} of ${MAX_STEPS} steps`);

  if (VERBOSE) {
    console.log(`    route: ${(main.steps * DT).toFixed(0)} s, peak ${main.maxAmbush} ambushers, ` +
      `${main.spawns} spawned, hull ${(main.hull * 100).toFixed(0)}%`);
  }
}

/* ---- the watchdog clock, against difficulty and against the purse -------- */

/**
 * A bound the CODE invented to stop a hang must cost the player nothing and
 * pay him nothing. Squeezed by `timerMul` it was 259 s on steel against a
 * ~210 s measured run — a chapter that could be lost on time where the author
 * gave it no clock at all — and paid as a time bonus it was a raise nobody
 * wrote. Both halves are read off a live chapter, one difficulty apart.
 */
{
  /** Arm the chapter at `diff` and report the clock it ends up carrying. */
  const clockAt = (diff) => {
    const s = scene();
    s.missions.difficulty = diff;
    startEscort(s);
    return s.missions.M.timer;
  };
  const normal = clockAt('normal');
  const steel = clockAt('steel');
  check('the watchdog clock is the same bound at every difficulty',
    normal === steel && normal > 300,
    `${normal.toFixed(0)} s on normal, ${steel.toFixed(0)} s on steel ` +
    `(timerMul 0.72 used to make it ${(normal * 0.72).toFixed(0)} s)`);

  /** Win the chapter on the spot, with the watchdog flag as given. */
  const winWith = (watchdog) => {
    const s = scene();
    startEscort(s);
    const M = s.missions.M;
    M.timerIsWatchdog = watchdog;
    // Into the drop ring; the track's own arrival test is what wins it. Then
    // run the outro out, because the payload the card prints is published by
    // `_finish` rather than by `win` — the cash moves several seconds before
    // the event that reports it does.
    M.ally.position.set(M.dest.x, M.ally.position.y, M.dest.z);
    drive(s, null, Math.ceil(30 / DT));
    return { bonus: s.wins[0]?.bonus ?? -1, paid: s.economy.paid.reduce((a, b) => a + b, 0) };
  };
  const watchdog = winWith(true);
  const priced = winWith(false);
  check('NEG CONTROL: the same win with the flag cleared DOES pay a time bonus',
    watchdog.bonus === 0 && priced.bonus > 500 && priced.paid > watchdog.paid,
    `watchdog $${watchdog.paid} with $${watchdog.bonus} bonus against ` +
    `$${priced.paid} with $${priced.bonus} — the counter can tell them apart`);
}

/* ========================================================================== */
/* 2 — the ambush, priced on the truck's own hull                             */
/* ========================================================================== */

let ramNew = 0, ramOld = 0;

{
  /** Park `n` cars in contact with the truck for `secs` and read the hull. */
  const ramFor = (n, secs, scale) => {
    const s = scene();
    startEscort(s);
    const M = s.missions.M;
    const a = M.ally;
    // Freeze the truck where it is so the only thing moving the hull is the
    // ram: a truck that drove away mid-measurement would read as tougher.
    a.pinned = true;
    const cars = [];
    for (let i = 0; i < n; i++) {
      const v = s.vehicles.spawn('muscle', { x: a.position.x + 3, y: a.position.y, z: a.position.z + 3 }, 0);
      v.isAmbush = true;
      v.isMission = true;
      v.pinned = true;
      M.spawnedVehicles.push(v);
      cars.push(v);
    }
    const before = a.health;
    const steps = Math.round(secs / DT);
    for (let i = 0; i < steps; i++) {
      // Hold them on the truck's flank — this measures the ram tariff, not
      // whether three AI drivers can all reach one bumper at once.
      for (const v of cars) v.position.set(a.position.x + 3, a.position.y, a.position.z + 3);
      s.time.raw += DT;
      s.time.elapsed += DT;
      s.missions.update(DT);
      if (scale) for (const v of cars) s.vehicles.damage(a, (scale - 1) * 18 * DT, v.position);
    }
    return (before - a.health) / secs;
  };

  ramNew = ramFor(3, 1.5, 0);
  ramOld = ramFor(3, 1.5, 34 / 18);
  const idle = ramFor(0, 1.5, 0);

  // The load-bearing reading: the TRUCK'S OWN HEALTH says each car costs 18
  // HP/s, and the capped three together are well under the 34-per-car the
  // chapter shipped with. Nothing here reads `AMBUSH_RAM`.
  check('the ram tariff measured on the truck reads 18 HP/s per car, not 34',
    Math.abs(ramNew / 3 - 18) < 0.5,
    `${ramNew.toFixed(1)} HP/s from three cars = ${(ramNew / 3).toFixed(1)} each; ` +
    `a 520 HP truck survives ${(520 / ramNew).toFixed(1)} s of all three in contact`);

  check('NEG CONTROL: with no car in contact the hull does not move at all',
    idle < 0.5, `${idle.toFixed(2)} HP/s with the truck alone — the rig invents no damage`);

  // COUNTERFACTUAL, not a control: the probe adds the missing 16 HP/s per car
  // itself, so the ratio is arithmetic. It is here to price the change in the
  // units the chapter is played in — seconds of survival.
  check('COUNTERFACTUAL: at the pre-fix 34 HP/s the same three cars kill it twice as fast',
    ramOld > ramNew * 1.6,
    `${ramOld.toFixed(1)} HP/s vs ${ramNew.toFixed(1)} — ${(ramOld / ramNew).toFixed(2)}x, ` +
    `${(520 / ramOld).toFixed(1)} s to kill against ${(520 / ramNew).toFixed(1)} s`);
}

/* ========================================================================== */
/* 3 — an ambusher that falls behind is retired, not accumulated              */
/* ========================================================================== */

{
  const s = scene();
  startEscort(s);
  const M = s.missions.M;
  const a = M.ally;
  drive(s, null, 400);
  // Manufacture the case the despawn rule exists for: a car left behind.
  const v = s.vehicles.spawn('muscle', { x: a.position.x + 400, y: 0, z: a.position.z + 400 }, 0);
  v.isAmbush = true;
  v.isMission = true;
  M.spawnedVehicles.push(v);
  const held = M.spawnedVehicles.length;
  s.missions.update(DT);

  check('an ambusher more than 250 m from the truck is despawned and dropped from the mission list',
    !M.spawnedVehicles.includes(v) && v.despawned === true && M.spawnedVehicles.length === held - 1,
    `${Math.hypot(400, 400).toFixed(0)} m behind: in list ${M.spawnedVehicles.includes(v)}, despawned ${v.despawned}`);

  // ...and one that is still in the fight is NOT — the rule must have an edge.
  const near = s.vehicles.spawn('muscle', { x: a.position.x + 60, y: 0, z: a.position.z + 60 }, 0);
  near.isAmbush = true;
  near.isMission = true;
  M.spawnedVehicles.push(near);
  s.missions.update(DT);
  check('NEG CONTROL: one still on the truck is kept',
    M.spawnedVehicles.includes(near) && near.despawned === false,
    `${Math.hypot(60, 60).toFixed(0)} m out: still held`);
}

/* ========================================================================== */
/* 4 — the wedged truck recovers, and if it cannot, it FAILS                  */
/* ========================================================================== */

{
  const s = scene();
  startEscort(s);
  const M = s.missions.M;
  const a = M.ally;
  drive(s, null, 200);
  // Wedge it: the engine turns, the wheels do not. Shove it into a yard first,
  // so the recovery has to find the road rather than already being on one —
  // the street grid is dense enough that a fixed perpendicular offset lands on
  // the next carriageway, which is not the case this rule exists for.
  a.pinned = true;
  const from = offRoadSpotNear(a.position.x, a.position.z);
  a.position.set(from.x, a.position.y, from.z);
  let moved = 0;
  let steps = 0;
  while (steps < Math.ceil(30 / DT) && !moved) {
    s.time.raw += DT;
    s.time.elapsed += DT;
    s.missions.update(DT);
    for (const v of s.vehicles.live) stepCar(v, DT);
    steps++;
    if (Math.hypot(a.position.x - from.x, a.position.z - from.z) > 3) moved = steps;
  }

  check('NEG CONTROL: it was genuinely off the road before the snap',
    nearestDrivable(from.x, from.z).dist > 20,
    `wedged ${nearestDrivable(from.x, from.z).dist.toFixed(1)} m from the nearest lane`);

  check('a truck that has not moved in 8 s is snapped back onto a lane',
    moved > 0 && M.unwedged >= 1 && nearestDrivable(a.position.x, a.position.z).dist < ON_ROAD,
    `recovered after ${(moved * DT).toFixed(1)} s, ${M.unwedged} snap(s), ` +
    `now ${nearestDrivable(a.position.x, a.position.z).dist.toFixed(1)} m from a lane`);

  // Still pinned: it re-wedges every 8 s for ever. The chapter must END.
  const ran = drive(s, null, MAX_STEPS);
  const M2 = s.missions.M;
  check('a truck that never recovers fails the chapter cleanly instead of hanging',
    M2.phase === 'over' && M2.state === 'lost' && s.fails.length === 1 &&
    ran + steps < MAX_STEPS,
    `${((ran + steps) * DT).toFixed(0)} s: "${s.fails[0]?.reason ?? '(never ended)'}" ` +
    `after ${M2.unwedged} snap attempt(s)`);

  check('and it fails with the ordinary retry card, not a special case',
    s.ui.cards.length === 1 && s.ui.cards[0].kind === 'failed',
    `card ${JSON.stringify(s.ui.cards[0] ?? null)}`);
}

/* ========================================================================== */
/* 4b — THE HARD CLOCK, with nothing else able to end the chapter             */
/* ========================================================================== */

{
  const s = scene();
  startEscort(s);
  const M = s.missions.M;
  const a = M.ally;
  // Pin it upright where no lane is within `nearestLane`'s reach, so the
  // recovery cannot rescue it, and hold the ambush off so the ONLY thing that
  // can end this chapter is the clock the fix armed.
  a.pinned = true;
  a.position.set(1500, 0, 1500);
  const armed = M.timer;
  const steps = drive(s, () => {
    M.attackT = 1e6;
    for (let i = M.spawnedVehicles.length - 1; i >= 0; i--) {
      if (M.spawnedVehicles[i].isAmbush) M.spawnedVehicles.splice(i, 1);
    }
    a.position.set(1500, 0, 1500);
    a.quaternion.identity();
    a.forwardSpeed = 0;
  });

  check('THE HARD CLOCK: an unrecoverable truck runs out of time instead of hanging',
    s.fails.length === 1 && s.fails[0].reason === 'Out of time' && steps < MAX_STEPS,
    `${(steps * DT).toFixed(0)} s of ${armed.toFixed(0)} s armed: "${s.fails[0]?.reason ?? '(never ended)'}"`);
}

/* ========================================================================== */
/* 5 — a destroyed / inverted mission vehicle ends its chapter                */
/* ========================================================================== */

{
  // DESTROYED — an aircraft hitting terrain raises `vehicle:destroyed`, and
  // this is the path that reaches.
  const s = scene();
  startEscort(s);
  const M = s.missions.M;
  M.ally.destroyed = true;
  s.missions.update(DT);
  check('a destroyed escort truck fails the chapter',
    s.fails.length === 1 && /destroyed/i.test(s.fails[0].reason),
    `"${s.fails[0]?.reason}"`);
}

{
  // ON ITS ROOF — silent before this change: full health, nothing fails,
  // nothing can ever complete.
  const s = scene();
  startEscort(s);
  const M = s.missions.M;
  const a = M.ally;
  // Put it upside down somewhere no lane can be reached, so the recovery
  // cannot rescue it and the fault has to surface as a fail.
  a.pinned = true;
  a.position.set(1500, 0, 1500);
  const flip = new THREE.Euler(Math.PI, 0, 0, 'YXZ');
  let steps = 0;
  while (steps < Math.ceil(20 / DT) && s.missions.M.phase !== 'over') {
    a.quaternion.setFromEuler(flip);
    a.forwardSpeed = 0;
    s.time.raw += DT;
    s.time.elapsed += DT;
    s.missions.update(DT);
    steps++;
  }
  check('an escort truck on its roof with nowhere to be put back fails inside ~8 s',
    s.fails.length === 1 && /roof/i.test(s.fails[0]?.reason ?? '') && steps * DT < 12,
    `${(steps * DT).toFixed(1)} s: "${s.fails[0]?.reason ?? '(never ended)'}"`);

  check('NEG CONTROL: an UPRIGHT stationary truck is not scored as wedged',
    (() => {
      const t = scene();
      startEscort(t);
      const b = t.missions.M.ally;
      b.pinned = true;
      for (let i = 0; i < Math.ceil(6 / DT); i++) { t.time.raw += DT; t.missions.update(DT); }
      return t.fails.length === 0;
    })(), 'six seconds stationary and upright: still running');
}

/* ========================================================================== */
/* 6 — NEGATIVE CONTROL: routing off, and the truck goes in the river         */
/* ========================================================================== */

const ctrl = { wet: 0, samples: 0, hull: 1, reason: '' };

{
  const s = scene({ routing: false });
  startEscort(s);
  const M = s.missions.M;
  const a = M.ally;
  drive(s, (n) => {
    if (n % SAMPLE_EVERY) return;
    ctrl.samples++;
    if (inTheRiver(a.position.x, a.position.z)) ctrl.wet++;
  }, Math.ceil(200 / DT));
  ctrl.hull = a.health / a.maxHealth;
  ctrl.reason = s.fails[0]?.reason ?? (s.wins.length ? 'arrived' : 'still running');

  check('NEG CONTROL: with routing off the truck drives into the Monongahela',
    ctrl.wet > 0,
    `${ctrl.wet} of ${ctrl.samples} sampled positions in open water (routed run: ${main.wet})`);
}

/* ========================================================================== */

for (const r of rows) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(74)}${r.detail}`);
}
console.log('');
console.log(`escort (Aidan CH 5, headless on the emitted city, seed ${SEED.toString(16)}):  ${pass}/${pass + fail}`);
console.log(`  routed: ${(main.steps * DT).toFixed(0)} s to the drop, ${main.wet}/${main.samples} wet samples, ` +
  `peak ${main.maxAmbush} ambushers of ${main.spawns} spawned, hull ${(main.hull * 100).toFixed(0)}%`);
console.log(`  control: routing off -> ${ctrl.wet}/${ctrl.samples} wet, hull ${(ctrl.hull * 100).toFixed(0)}%, ${ctrl.reason}`);
console.log(`  ram: ${ramNew.toFixed(1)} HP/s at the tuned 18, ${ramOld.toFixed(1)} HP/s at the old 34`);

process.exit(fail ? 1 : 0);
