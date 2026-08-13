#!/usr/bin/env node
/**
 * GAME — THE FAILURE EDGES OF THE FIXED TRACKS.
 *
 *   node src/game/flowprobe.mjs
 *   node src/game/flowprobe.mjs --verbose
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS EXISTS TO CATCH
 *
 * Every other game gate measures a chapter that GOES WELL. `escortprobe` drives
 * a truck to a drop, `bossbarprobe` prices a bearing, `playtest` walks the
 * story. Nothing measured the edges where a chapter is DECLARED LOST, and all
 * four of the defects below lived there — invisible to a happy path, and each
 * of them indistinguishable from a bug when it happened to a player:
 *
 *   1. `chase` failed on distance from frame one. The target spawns 180-320 m
 *      out and flees at full throttle; the courtesy car is 10-45 m away and the
 *      player is on foot at 1.72 m/s. The chapter could be lost before he
 *      reached the car it told him to take.
 *   2. `recover` failed the whole chapter the frame ANY marked car reported
 *      `destroyed` — from 600 m away, off camera, hit by traffic. A FAILED card
 *      for something the player never saw and could not have influenced.
 *   3. `timedDeliver`'s clock was a hand-authored `baseTimer` per chapter, and
 *      the two authored chapters disagree by a factor of six per metre of haul.
 *   4. EVERY mission end raised the result card TWICE and struck its sting
 *      twice, because `_finish` both emitted `mission:complete`/`mission:fail`
 *      AND called `ui.card` itself, while `src/ui/index.js`'s own two mission
 *      listeners raise a card off each of those events.
 *   5. `rideFault` watched the COURTESY CAR forever. Its guard asked whether
 *      the player was in another car right now, while the inverted-car clock
 *      latched — so the chapter failed on the first frame he was out of one,
 *      naming a car he had abandoned two minutes and a kilometre earlier.
 *   6. `recover` remembered ONE lost slot per frame but despawned every
 *      unwitnessed wreck it walked past, so two losses on one frame left the
 *      chapter a car short of `goal` with no fail path.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT ASSERTS WHAT IT ASSERTS  (ARCHITECTURE.md rule 12)
 *
 * The runner and the tracks are REAL — `MissionRunner` and `TRACKS` are the
 * shipped modules, driven through `WorldQuery` over the terrain and road graph
 * `generateCity` actually emits. What is mocked is the fleet and the HUD, and
 * both mocks are chosen so the thing under test still has to produce the
 * artefact:
 *
 *   · the verdict is read off the EMITTED `mission:fail` / `mission:complete`
 *     payloads on the bus and off the result card the fake `ui` receives —
 *     never off `M.state`, which is the runner reporting on itself;
 *   · the CARD COUNT includes the card `ui` raises for itself off the bus. A
 *     stand-in that implements only `card()` models half of `src/ui/index.js`,
 *     and the missing half IS the second card. `fakeUi().wire(events)`
 *     subscribes the same two handlers the real file does;
 *   · the timed-delivery rate is `M.timer` — the emitted clock — over a
 *     distance THIS FILE measures between the car's emitted position and the
 *     `POI` table's authored coordinate. `tracks.js` computes its own distance
 *     from the spawn spot; dividing its clock by its own distance would compare
 *     a number to itself and could not be anything but `DELIVER_RATE`.
 *
 * NEGATIVE CONTROLS, one per section, all of them real rather than synthetic:
 *
 *   1. the same chase staging with the arming latch forced on from frame one
 *      (which is what the track did before) must fail immediately;
 *   2. the same unwatched wreck, after the player has once been inside
 *      `RECOVER_SEEN` of the car, must fail;
 *   3. the two chapters' own authored `baseTimer` values, scored by the same
 *      fairness test, must be rejected;
 *   4. an extra `ui.card` call — which is exactly what `_finish` used to make
 *      alongside the event — must take the count to two, so a green "exactly
 *      one card" is a claim the counter can distinguish from a red one.
 */

import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { generateCity } from '../world/netgen.js';
import { Router } from '../world/route.js';
import { Rng } from '../core/rng.js';
import { MissionRunner } from './mission.js';
import { JobBoard } from './jobs.js';
import { StagingRings } from './freeroam.js';
import { HostilePool } from './hostiles.js';
import { WorldQuery } from './util.js';
import { BOYZ, POI, R, DIFFS, DOCKS } from './data.js';
import { blankSave } from './save.js';

const VERBOSE = process.argv.includes('--verbose');
const SEED = 0x5eed1234;

let pass = 0, fail = 0;
const rows = [];
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  rows.push({ ok: !!ok, name, detail: String(detail ?? '') });
};

/** Simulation step. 20 Hz, the same rate `escortprobe` drives at. */
const DT = 0.05;
const MAX_STEPS = Math.ceil(240 / DT);

/**
 * The two numbers `tracks.js` publishes and this file must NOT recompute from.
 * They are quoted for the failure text only; every assertion derives its own.
 */
const EXPECT_RATE = 0.14;   // s per crow-flight metre — `tracks.DELIVER_RATE`
/**
 * How far apart two chapters' seconds-per-metre may be and still count as the
 * same rate: 2%. Deliberately tight, because a shared formula makes them EQUAL
 * — the measured spread is 0.0% — and the defect it replaced was 78% apart. A
 * loose tolerance here would pass a per-chapter fudge factor.
 */
const RATE_TOL = 0.02;

/* ========================================================================== */
/* the world — the real one                                                   */
/* ========================================================================== */

const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
const graph = generateCity(terrain, new Rng(SEED).fork().fork()).graph;

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
/* the cars                                                                   */
/* ========================================================================== */

const CARS = {
  truck: { top: 22, accel: 5.0, turn: 0.95, hp: 900, half: 1.1, comY: 0.7 },
  van: { top: 26, accel: 6.0, turn: 1.0, hp: 900, half: 1.05, comY: 0.7 },
  muscle: { top: 34, accel: 8.5, turn: 1.35, hp: 900, half: 0.95, comY: 0.5 },
  sports: { top: 38, accel: 9.5, turn: 1.5, hp: 900, half: 0.92, comY: 0.45 },
  sedan: { top: 30, accel: 7.0, turn: 1.2, hp: 900, half: 0.95, comY: 0.5 },
};

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

function makeCar(type, x, y, z, yaw) {
  const spec = CARS[type] ?? CARS.sedan;
  const v = {
    type,
    spec: { ...spec, half: { x: spec.half }, comY: spec.comY },
    position: new THREE.Vector3(x, y, z),
    quaternion: new THREE.Quaternion(),
    yaw,
    speed: 0,
    forwardSpeed: 0,
    health: spec.hp,
    maxHealth: spec.hp,
    destroyed: false,
    despawned: false,
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
  const s = CARS[v.type] ?? CARS.sedan;
  if (!v.driven) { i.throttle = 0; i.brake = 0.25; i.steer = 0; }
  const drag = 0.06 * v.speed + 0.004 * v.speed * v.speed;
  v.speed += (i.throttle * s.accel * (i.boost ? 1.25 : 1) - i.brake * 10 - drag) * dt;
  if (v.speed < 0) v.speed = 0;
  const top = s.top * (i.boost ? 1.15 : 1);
  if (v.speed > top) v.speed = top;
  v.yaw += i.steer * s.turn * Math.min(1, v.speed / 7) * dt;
  v.position.x += Math.sin(v.yaw) * v.speed * dt;
  v.position.z += Math.cos(v.yaw) * v.speed * dt;
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
 * `ui`, INCLUDING THE HALF THAT LIVES ON THE BUS — see the header.
 *
 * `card()` also records the STING, because `src/ui/index.js:1081` plays
 * `mission_pass` / `mission_fail` on every call and that is where the audible
 * half of the double-fire was. `stings` therefore counts everything the player
 * would hear at an end: the card's own, plus anything the runner plays through
 * `wq.uiSfx` in the same frame.
 */
function fakeUi() {
  return {
    cards: [], stings: [], toasts: [],
    card(kind, sub) {
      this.cards.push({ kind, sub });
      this.stings.push(kind === 'passed' ? 'mission_pass' : 'mission_fail');
    },
    notify(text, value, tone) { this.toasts.push({ text, value, tone }); },
    say() {}, setCharacter() {}, setMoney() {}, setStation() {}, setWaypoint() {},
    setObjectives() {}, clearObjective() {}, titleCard() {}, playScene() {},
    /**
     * `src/ui/index.js`'s own two mission listeners, INCLUDING the `carded`
     * guard `mission.js:_finish` publishes for them — the same two handlers,
     * in the same order, as the shipped file. The negative control below is
     * what proves the mock is not just agreeing with itself: re-emit the
     * payload with `carded` deleted and the count goes to two, which is the
     * double the guard exists to stop.
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
      const h = {
        position: { x: v.x, y: v.y, z: v.z }, yaw: 0,
        health: opts?.hp ?? 100, maxHealth: opts?.hp ?? 100, dead: false, active: true,
      };
      this.spawned.push(h);
      return h;
    },
    despawnHostile(h) { if (h) h.active = false; },
    clearHostiles() { for (const h of this.spawned) h.active = false; },
    hurtHostile: () => false,
  };
}

function scene({ difficulty = 'normal' } = {}) {
  const save = blankSave();
  const events = bus();
  const ui = fakeUi().wire(events);
  const world = makeWorld();
  const vehicles = makeVehicles();
  const peds = fakePeds();
  const time = { raw: 0, elapsed: 0, dt: DT, scale: 1, frame: 0 };
  const player = {
    position: new THREE.Vector3(0, 0, 0),
    inVehicle: false, vehicle: null, dead: false,
    addTrauma() {}, applyDamage() {},
    vehicles: { abort() { player.inVehicle = false; player.vehicle = null; } },
    movement: {},
  };
  const bag = { world, vehicles, peds, player, ui };
  const ctx = {
    rng: new Rng(SEED).fork(), events, time,
    camera: { position: new THREE.Vector3() },
    scene: new THREE.Scene(),
    peek: (i) => bag[i] ?? null, get: (i) => bag[i] ?? null, has: (i) => i in bag,
  };
  const wq = new WorldQuery(ctx).init();
  // Every result sting the RUNNER plays, with the frame it played on, so a
  // second one landing beside the card's is visible as a second one.
  const sfx = [];
  const rawUiSfx = wq.uiSfx.bind(wq);
  wq.uiSfx = (id, gain) => { sfx.push({ id, frame: time.frame }); return rawUiSfx(id, gain); };
  const economy = {
    cash: 0, respect: 0, char: (who = 'aidan') => save.chars[who],
    paid: [], respected: [],
    addCash(n) { this.paid.push(n); }, addRespect(n) { this.respected.push(n); return []; },
    unlockWeapon: () => false,
  };
  const heat = { wanted: 0, raise() {}, clear() {}, heat() {}, setPursuitEnabled() {} };
  const pickups = {
    spawn: () => null, despawn() {}, clearMission() {},
    countMission: () => 0, nearestMission: () => null,
  };
  const hostiles = new HostilePool(ctx, wq).init();
  const missions = new MissionRunner(ctx, { wq, economy, heat, hostiles, pickups, save });
  missions.difficulty = difficulty;
  bag.game = { missions, pickups };
  const fails = [];
  const wins = [];
  events.on('mission:fail', (p) => fails.push({ ...p }));
  events.on('mission:complete', (p) => wins.push({ ...p }));
  return { save, ui, wq, events, world, vehicles, ctx, missions, time, player, fails, wins, sfx, economy };
}

/** Walk a chapter out of its intro. Returns the live mission record. */
function begin(s, boy, idx, at) {
  s.player.position.set(at.x, 0, at.z);
  s.missions.start(boy, idx);
  for (let i = 0; i < 8 && s.missions.M.phase === 'intro'; i++) s.missions.update(1);
  if (s.missions.M.phase === 'travel') s.missions.forceBegin();
  return s.missions.M;
}

/** Step the sim, cars and all, until the chapter ends or `steps` run out. */
function drive(s, steps, onStep) {
  let n = 0;
  while (n < steps && s.missions.M && s.missions.M.phase !== 'over') {
    s.time.raw += DT;
    s.time.elapsed += DT;
    s.time.frame++;
    s.missions.update(DT);
    for (const v of s.vehicles.live) stepCar(v, DT);
    n++;
    onStep?.(n);
  }
  return n;
}

/**
 * Move a player across the rings in steps no bigger than a car can travel.
 *
 * The step cap matters: `StagingRings` treats a jump past `RING_SWEEP_MAX`
 * (120 m) as a TELEPORT and refuses to sweep across it, so a harness that
 * relocated its player in one 400 m hop would be testing the teleport guard
 * every time instead of the entry test. 40 m is 144 km/h at this file's 20 Hz.
 *
 * @returns {?object} the first hit along the way, or null.
 */
function walk(rings, x0, z0, x1, z1, step = 40) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step));
  let hit = null;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    hit = rings.update(DT, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t) ?? hit;
  }
  return hit;
}

/** Put the player into `v` the way the game's own seat state reads. */
function board(s, v) {
  s.player.inVehicle = true;
  s.player.vehicle = v;
}

const chapterOf = (boyId, track) => {
  const boy = BOYZ[boyId];
  const idx = boy.story.findIndex((c) => c.track === track);
  return { boy, idx, c: boy.story[idx] };
};

/* ========================================================================== */
/* 1 — CHASE: the chapter cannot be lost before it can be played              */
/* ========================================================================== */

{
  const { boy, idx } = chapterOf('dylan', 'chase');
  const s = scene();
  const at = s.wq.poi(boy.story[idx].at) ?? { x: 0, z: 0 };
  const M = begin(s, boy, idx, at);
  const target = M.target;

  check('a chase chapter is live with a target on the road',
    !!target && s.missions.running === true && M.track === 'chase',
    `${M.def?.no} ${M.def?.name}, target at (${target?.position.x.toFixed(0)}, ${target?.position.z.toFixed(0)}), ` +
    `${Math.hypot(target.position.x - at.x, target.position.z - at.z).toFixed(0)} m from the staging POI`);

  // THE STAGING THE DEFECT NEEDS: put the target straight past `R.chaseLose`,
  // which is where a fleeing muscle car is within ~15 s of a player on foot.
  target.setPose({ x: at.x + R.chaseLose + 120, y: 0, z: at.z }, 0);
  const startFrame = s.time.frame;

  // ---- on foot, never boarding -----------------------------------------
  drive(s, Math.ceil(15 / DT));
  const alive15 = s.missions.M.phase !== 'over';
  check('on foot 15 s in, 740 m adrift, the chapter is still alive',
    alive15 && s.fails.length === 0,
    alive15 ? `still running, ${Math.round(dist2(s.player.position, target.position))} m adrift`
      : `FAILED: "${s.fails[0]?.reason}"`);

  // ---- he gets in a car; now the 2.5 s grace, and only then the verdict --
  const ride = s.missions.M.veh ?? s.vehicles.live.find((v) => v !== target);
  board(s, ride);
  const boardFrame = s.time.frame;
  drive(s, Math.ceil(2.0 / DT));
  const aliveGrace = s.missions.M.phase !== 'over';
  check('and for 2.0 s after he takes the wheel it is STILL alive (the grace)',
    aliveGrace && s.fails.length === 0,
    aliveGrace ? `${((s.time.frame - boardFrame) * DT).toFixed(1)} s aboard, still running`
      : `FAILED after ${((s.time.frame - boardFrame) * DT).toFixed(1)} s: "${s.fails[0]?.reason}"`);

  // ---- past the grace, still 740 m adrift: it is a loss, and it says so --
  drive(s, Math.ceil(6 / DT));
  const f = s.fails[0];
  check('past the grace and still adrift, the target IS scored as escaped',
    !!f && /got away/i.test(f.reason ?? ''),
    f ? `"${f.reason}" at ${((s.time.frame - boardFrame) * DT).toFixed(1)} s aboard` : 'never failed');
  check('...and the whole thing took longer than the walk to the car',
    (s.time.frame - startFrame) * DT > 15,
    `${((s.time.frame - startFrame) * DT).toFixed(1)} s from the first frame of the chapter`);
}

/* ---- NEGATIVE CONTROL: the track as it behaved before -------------------- */
{
  const { boy, idx } = chapterOf('dylan', 'chase');
  const s = scene();
  const at = s.wq.poi(boy.story[idx].at) ?? { x: 0, z: 0 };
  const M = begin(s, boy, idx, at);
  M.target.setPose({ x: at.x + R.chaseLose + 120, y: 0, z: at.z }, 0);
  // Exactly what the old code did: no latch, no grace — the distance test is
  // live on the first update.
  M.rolled = true;
  M.graceT = 0;
  drive(s, Math.ceil(1 / DT));
  const f = s.fails[0];
  check('NEG CONTROL: with the latch and grace disabled it fails on frame one',
    !!f && /got away/i.test(f.reason ?? ''),
    f ? `"${f.reason}" after ${(s.time.frame * DT).toFixed(2)} s` : 'did NOT fail — the staging is not adrift');
}

function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Scratch for rolling a harness car onto its roof. Declared before its use —
 *  `const` does not hoist and every section below runs at module load. */
const _flip = new THREE.Euler(0, 0, 0, 'YXZ');
/** Seconds `vehFault` has been holding against the courtesy car. */
function _faultOf(M) {
  return M._faultRide ?? 0;
}

/* ========================================================================== */
/* 1b — the COURTESY CAR is released the moment he adopts another one         */
/* ========================================================================== */

/**
 * `rideFault` fails `race` and `chase` when the car the track handed the
 * player ends up on its roof, because neither chapter can be finished without
 * something to drive. Its guard used to be a live test — "is he in another car
 * RIGHT NOW" — while `_faultRide` latched past `VEH_FAULT_T` and stayed there.
 * So the chapter did not fail while he drove the car he stole; it failed on the
 * first frame he was out of one, minutes and a kilometre later, naming a car he
 * had abandoned. This is that exact sequence.
 *
 * The chase's own two fail paths are held off deliberately — the target is
 * parked on the player each frame — so the ONLY thing that can end the chapter
 * here is the courtesy-car watchdog, which is the thing under test.
 */
{
  /** Roll `v` onto its roof and hold it there against `stepCar`'s pose write. */
  const invert = (v) => {
    v.quaternion.setFromEuler(_flip.set(Math.PI, v.yaw, 0, 'YXZ'));
    v.speed = 0;
    v.forwardSpeed = 0;
  };

  const { boy, idx } = chapterOf('dylan', 'chase');
  const s = scene();
  const at = s.wq.poi(boy.story[idx].at) ?? { x: 0, z: 0 };
  const M = begin(s, boy, idx, at);
  const courtesy = M.veh;
  const target = M.target;

  check('a chase chapter hands the player a courtesy car',
    !!courtesy && courtesy !== target,
    courtesy ? `a ${courtesy.type} at (${courtesy.position.x.toFixed(0)}, ${courtesy.position.z.toFixed(0)})`
      : 'no courtesy car spawned');

  // He steals better two streets away and drives off in it. The courtesy car
  // is left on its roof at the grid, exactly where he rolled it.
  const stolen = s.vehicles.spawn('muscle',
    { x: at.x + 40, y: courtesy.position.y, z: at.z + 40 }, 0);
  board(s, stolen);
  // A clock that has ALREADY latched past `VEH_FAULT_T` — the state the old
  // live guard left lying around while it suppressed the fail. The release has
  // to beat a latched fault, not merely stop one from starting.
  M._faultRide = 20;
  const holdChase = () => {
    // Park the target on him so `R.chaseLose` can never be the thing that ends
    // this, and keep the abandoned car inverted and still.
    target.setPose({ x: s.player.position.x + 8, y: target.position.y, z: s.player.position.z }, 0);
    target.health = target.maxHealth;
    invert(courtesy);
    s.player.position.set(stolen.position.x, 0, stolen.position.z);
  };
  invert(courtesy);
  drive(s, Math.ceil(14 / DT), holdChase);

  const released = M.rideReleased === true;
  check('driving a substitute RELEASES the courtesy car for good',
    released && s.missions.M?.phase !== 'over',
    `rideReleased ${released}, ${(_faultOf(M)).toFixed(1)} s on the inverted-car clock, ` +
    `chapter ${s.missions.M?.phase === 'over' ? `FAILED "${s.fails[0]?.reason}"` : 'still running'}`);

  // AND THE FRAME THAT USED TO KILL IT: the substitute is wrecked and he is on
  // foot. The old guard collapsed here and returned the latched fault.
  s.vehicles.damage(stolen, stolen.maxHealth * 2);
  s.player.inVehicle = false;
  s.player.vehicle = null;
  drive(s, Math.ceil(3 / DT), holdChase);

  check('...so losing the substitute does NOT fail him for the car he left',
    s.missions.M?.phase !== 'over' && s.fails.length === 0,
    s.fails.length ? `FAILED: "${s.fails[0]?.reason}"`
      : `on foot, substitute wrecked, chapter still running after ${(s.time.frame * DT).toFixed(0)} s`);
}

/* ---- NEGATIVE CONTROL: he never adopts anything -------------------------- */
{
  // The hang this watchdog exists for is still a fail: same inverted courtesy
  // car, same clock, but he walks away instead of taking another car.
  const { boy, idx } = chapterOf('dylan', 'chase');
  const s = scene();
  const at = s.wq.poi(boy.story[idx].at) ?? { x: 0, z: 0 };
  const M = begin(s, boy, idx, at);
  const courtesy = M.veh;
  const target = M.target;
  // Long enough to clear `CHASE_BOARD` (the chase does not arm, and so does not
  // watch the ride, until he has driven something or 20 s have passed) and then
  // `VEH_FAULT_T` on top of it.
  drive(s, Math.ceil(34 / DT), () => {
    target.setPose({ x: s.player.position.x + 8, y: target.position.y, z: s.player.position.z }, 0);
    target.health = target.maxHealth;
    courtesy.quaternion.setFromEuler(_flip.set(Math.PI, courtesy.yaw, 0, 'YXZ'));
    courtesy.speed = 0;
    courtesy.forwardSpeed = 0;
  });
  const f = s.fails[0];
  check('NEG CONTROL: on foot with no substitute, the roll DOES end the chapter',
    M.rideReleased === false && !!f && /roof/i.test(f.reason ?? ''),
    f ? `"${f.reason}" after ${(s.time.frame * DT).toFixed(1)} s`
      : `never failed — ${_faultOf(M).toFixed(1)} s on the clock`);
}

/* ========================================================================== */
/* 2 — RECOVER: a wreck he never saw is not a wreck he caused                 */
/* ========================================================================== */

/** The marked cars the runner is holding that are still in play. */
function markedAlive(M) {
  return M.spawnedVehicles.filter((v) => v._marked && !v.destroyed && !v.despawned);
}

{
  const { boy, idx } = chapterOf('aidan', 'recover');
  const s = scene();
  const at = s.wq.poi(boy.story[idx].at) ?? { x: 0, z: 0 };
  const M = begin(s, boy, idx, at);

  check('a recover chapter is live with its full set of marked cars',
    s.missions.running === true && markedAlive(M).length === M.goal,
    `${M.def?.no} ${M.def?.name}, ${markedAlive(M).length} marked of goal ${M.goal}`);

  // The FARTHEST one, and park the player on the drop so it is unambiguous
  // that he has never been anywhere near it.
  const cars = markedAlive(M);
  const victim = cars.reduce((m, v) =>
    (dist2(v.position, M.dest) > dist2(m.position, M.dest) ? v : m));
  s.player.position.set(M.dest.x, 0, M.dest.z);
  drive(s, 4);
  const away = dist2(s.player.position, victim.position);
  s.vehicles.damage(victim, victim.maxHealth * 2);
  drive(s, 6);

  const stillLive = s.missions.M && s.missions.M.phase !== 'over';
  check('a marked car wrecked 600 m away, unseen, does NOT fail the chapter',
    stillLive && s.fails.length === 0,
    stillLive ? `wrecked ${Math.round(away)} m away, chapter still running`
      : `FAILED: "${s.fails[0]?.reason}"`);
  check('...and it is REPLACED, so the goal is still reachable',
    markedAlive(s.missions.M).length === M.goal,
    `${markedAlive(s.missions.M).length} marked cars in play against goal ${M.goal}`);
  check('...and the replacement is a car he has not seen either',
    markedAlive(s.missions.M).every((v) => v.recoverSeen === false || dist2(s.player.position, v.position) <= 90),
    markedAlive(s.missions.M).map((v) => `${Math.round(dist2(s.player.position, v.position))}m/${v.recoverSeen}`).join(' '));
}

/* ---- NEGATIVE CONTROL: a car he HAS seen ------------------------------- */
{
  const { boy, idx } = chapterOf('aidan', 'recover');
  const s = scene();
  const at = s.wq.poi(boy.story[idx].at) ?? { x: 0, z: 0 };
  const M = begin(s, boy, idx, at);
  const victim = markedAlive(M)[0];

  // Walk him up to it — inside the witness radius — then all the way back to
  // the drop. The wreck happens just as far off as it did above; the ONLY
  // difference is that he has laid eyes on this one.
  s.player.position.set(victim.position.x + 20, 0, victim.position.z);
  drive(s, 4);
  const sawIt = victim.recoverSeen === true;
  s.player.position.set(M.dest.x, 0, M.dest.z);
  drive(s, 4);
  const away = dist2(s.player.position, victim.position);
  s.vehicles.damage(victim, victim.maxHealth * 2);
  drive(s, 6);

  const f = s.fails[0];
  check('NEG CONTROL: wrecking a car he HAS been up to fails the chapter',
    sawIt && !!f && /marked car was wrecked/i.test(f.reason ?? ''),
    `witnessed ${sawIt}, wrecked ${Math.round(away)} m away -> ${f ? `"${f.reason}"` : 'no fail'}`);
}

/* ---- TWO lost on ONE frame: every slot is replaced, not just the last ---- */

/**
 * The replacement walk despawned every unwitnessed wreck it found and put back
 * ONE, because the slot it remembered was a single variable each wreck
 * overwrote. Two cars lost on the same frame — a pursuit through a junction, an
 * explosion between two of them — therefore left the chapter permanently a car
 * short of `goal`, with nothing on the map to fetch and no fail path: only the
 * pause menu could end it.
 *
 * Read off the CARS THE WORLD HOLDS (`markedAlive`) and the slots they carry,
 * never off `M._lostSlots`, which is the fix reporting on itself.
 */
{
  const { boy, idx } = chapterOf('aidan', 'recover');
  const s = scene();
  const at = s.wq.poi(boy.story[idx].at) ?? { x: 0, z: 0 };
  const M = begin(s, boy, idx, at);
  // On the drop, so neither victim can ever have been witnessed.
  s.player.position.set(M.dest.x, 0, M.dest.z);
  drive(s, 4);

  const [a, b] = markedAlive(M);
  const slots = [a.recoverSlot, b.recoverSlot];
  const far = Math.min(dist2(s.player.position, a.position), dist2(s.player.position, b.position));
  s.vehicles.damage(a, a.maxHealth * 2);
  s.vehicles.damage(b, b.maxHealth * 2);
  const bothUnseen = a.recoverSeen === false && b.recoverSeen === false;
  drive(s, 6);

  const live = markedAlive(s.missions.M);
  check('two marked cars wrecked on ONE frame are BOTH replaced',
    bothUnseen && live.length === M.goal && s.fails.length === 0,
    `${live.length} marked cars in play against goal ${M.goal}, both unseen ${bothUnseen}, ` +
    `nearer wreck was ${Math.round(far)} m away`);
  check('...and the replacements cover both of the emptied slots',
    slots.every((k) => live.some((v) => v.recoverSlot === k)),
    `lost slots [${slots}] against slots in play [${live.map((v) => v.recoverSlot)}]`);
}

/* ---- NEGATIVE CONTROL: the pre-fix collector, on the same staging -------- */
{
  const { boy, idx } = chapterOf('aidan', 'recover');
  const s = scene();
  const at = s.wq.poi(boy.story[idx].at) ?? { x: 0, z: 0 };
  const M = begin(s, boy, idx, at);
  // `let lost = null`, exactly: a collector that keeps only the most recent
  // slot pushed into it. Nothing else about the track changes.
  const lastOnly = [];
  lastOnly.push = function (v) { this[0] = v; this.length = 1; return 1; };
  M._lostSlots = lastOnly;

  s.player.position.set(M.dest.x, 0, M.dest.z);
  drive(s, 4);
  const [a, b] = markedAlive(M);
  s.vehicles.damage(a, a.maxHealth * 2);
  s.vehicles.damage(b, b.maxHealth * 2);
  drive(s, 6);

  const live = markedAlive(s.missions.M);
  check('NEG CONTROL: with the old one-slot collector the chapter is left short',
    live.length === M.goal - 1 && s.fails.length === 0 && s.missions.M?.phase !== 'over',
    `${live.length} of goal ${M.goal} in play, chapter still running with no fail path — unwinnable`);
}

/* ========================================================================== */
/* 3 — timedDeliver: the same seconds per metre for both chapters             */
/* ========================================================================== */

/**
 * Run one authored `timedDeliver` chapter staged so the haul is roughly `want`
 * metres, and return the EMITTED clock beside a distance measured here.
 *
 * The staging point is chosen by walking out from the destination until the
 * crow-flight distance is close to `want` AND the point is dry — the chapter
 * anchors on the player, so where he stands IS the haul length. That is what
 * makes one authored `baseTimer` indefensible: the same chapter is a 300 m job
 * or a 2 km job depending on where you accept it.
 */
function haulRun(boyId, want) {
  const { boy, idx, c } = chapterOf(boyId, 'timedDeliver');
  const dest = POI.get(c.dest);
  const s = scene();
  let at = null;
  for (let a = 0; a < 64 && !at; a++) {
    const ang = (a / 64) * Math.PI * 2;
    const px = dest.x + Math.cos(ang) * want;
    const pz = dest.z + Math.sin(ang) * want;
    if (Math.abs(px) > 1500 || Math.abs(pz) > 1500) continue;
    if (terrain.isWater(px, pz)) continue;
    at = { x: px, z: pz };
  }
  if (!at) return null;
  const M = begin(s, boy, idx, at);
  const veh = M.veh;
  if (!veh) return null;
  // MEASURED HERE: the car the world actually holds, against the coordinate the
  // POI TABLE authors. `tracks.js` used neither of these two objects.
  const d = Math.hypot(veh.position.x - dest.x, veh.position.z - dest.z);
  return {
    id: `${boy.id} ${c.no} ${c.name}`,
    dest: c.dest,
    // The PRE-FIX authored seconds, kept HERE as history: data.js no longer
    // carries a dead baseTimer on the timedDeliver chapters (the haul-derived
    // clock overrides it), and the negative control needs the old numbers to
    // keep proving they were unfair. Keyed by destination — the two chapters
    // the defect was measured at.
    authored: c.baseTimer ?? AUTHORED_TIMED[c.dest],
    d,
    timer: M.timer,
    rate: M.timer / d,
    hasTimer: M.hasTimer,
  };
}

/** data.js's hand-authored timedDeliver seconds as shipped before the
 * haul-derived clock (aidan CH4 shop_ammo, dylan CH6 ap_east). */
const AUTHORED_TIMED = { shop_ammo: 88, ap_east: 96 };

{
  // The two hauls the defect was measured at: the short in-town run and the
  // cross-city airfield run.
  const shortRun = haulRun('aidan', 300);
  const longRun = haulRun('dylan', 1959) ?? haulRun('dylan', 1500);

  check('both authored timed deliveries stage and arm a clock',
    !!shortRun && !!longRun && shortRun.hasTimer && longRun.hasTimer,
    shortRun && longRun
      ? `${shortRun.id} ${shortRun.d.toFixed(0)} m -> ${shortRun.timer.toFixed(0)} s · ` +
        `${longRun.id} ${longRun.d.toFixed(0)} m -> ${longRun.timer.toFixed(0)} s`
      : 'one of them did not stage');

  if (shortRun && longRun) {
    const spread = Math.abs(shortRun.rate - longRun.rate) / Math.max(shortRun.rate, longRun.rate);
    check('the two chapters are clocked at the SAME seconds per metre',
      spread <= RATE_TOL,
      `${shortRun.rate.toFixed(4)} vs ${longRun.rate.toFixed(4)} s/m — ${(spread * 100).toFixed(1)}% apart ` +
      `(tolerance ${(RATE_TOL * 100).toFixed(0)}%)`);
    check('...and the rate is a real allowance, not a rounding of zero',
      shortRun.rate > 0.05 && shortRun.rate < 0.5,
      `${shortRun.rate.toFixed(4)} s/m ~ ${(1 / shortRun.rate).toFixed(1)} m/s of crow-flight progress ` +
      `(the file states ${EXPECT_RATE})`);

    // A THIRD point, so "the same rate" is not two points fitting any line.
    const midRun = haulRun('aidan', 900);
    check('a third haul on the same chapter lands on the same rate',
      !!midRun && Math.abs(midRun.rate - shortRun.rate) / shortRun.rate <= RATE_TOL,
      midRun ? `${midRun.d.toFixed(0)} m -> ${midRun.timer.toFixed(0)} s = ${midRun.rate.toFixed(4)} s/m`
        : 'the mid haul did not stage');

    /* ---- NEGATIVE CONTROL: the authored numbers, same test -------------- */
    const mul = DIFFS.normal.timerMul;
    const oldShort = (shortRun.authored * mul) / shortRun.d;
    const oldLong = (longRun.authored * mul) / longRun.d;
    const oldSpread = Math.abs(oldShort - oldLong) / Math.max(oldShort, oldLong);
    check('NEG CONTROL: the authored baseTimers fail the same fairness test',
      oldSpread > RATE_TOL,
      `authored ${shortRun.authored} s / ${longRun.authored} s -> ` +
      `${oldShort.toFixed(4)} vs ${oldLong.toFixed(4)} s/m — ${(oldSpread * 100).toFixed(0)}% apart`);
    check('NEG CONTROL: ...and the long haul was the unwinnable one',
      oldLong < oldShort / 2,
      `${(1 / oldLong).toFixed(1)} m/s demanded on the long run against ` +
      `${(1 / oldShort).toFixed(1)} m/s on the short one`);
  }
}

/* ========================================================================== */
/* 4 — ONE result card and ONE sting, per end, both directions               */
/* ========================================================================== */

/**
 * The cards and the stings raised across ONE end.
 *
 * `ui.cards` counts what the player sees whichever side raised it, because the
 * fake `ui` is on the bus. `sfx` counts what the RUNNER plays on top of the
 * card's own — `fail` used to add a `damage` hit in the same frame as
 * `mission_fail`.
 */
function endTally(s, sinceCards, sinceSfx, frame) {
  return {
    cards: s.ui.cards.length - sinceCards,
    runnerSfx: s.sfx.filter((e, i) => i >= sinceSfx && e.frame >= frame).length,
    stings: s.ui.stings.length - sinceCards,
  };
}

{
  // ---- a LOSS: the chase that got away ----------------------------------
  const { boy, idx } = chapterOf('dylan', 'chase');
  const s = scene();
  const at = s.wq.poi(boy.story[idx].at) ?? { x: 0, z: 0 };
  const M = begin(s, boy, idx, at);
  M.target.setPose({ x: at.x + R.chaseLose + 400, y: 0, z: at.z }, 0);
  M.rolled = true;
  M.graceT = 0;
  const c0 = s.ui.cards.length;
  const x0 = s.sfx.length;
  const f0 = s.time.frame;
  drive(s, Math.ceil(2 / DT));
  const lost = endTally(s, c0, x0, f0);

  check('a LOST chapter raises exactly ONE result card',
    lost.cards === 1 && s.ui.cards[c0]?.kind === 'failed',
    `${lost.cards} card(s): ${JSON.stringify(s.ui.cards.slice(c0))}`);
  check('...and exactly ONE sting under it',
    lost.stings + lost.runnerSfx === 1,
    `${lost.stings} from the card + ${lost.runnerSfx} from the runner ` +
    `(${s.sfx.slice(x0).map((e) => e.id).join(',') || 'none'})`);
  check('...and the fail event still went out for everyone else on the bus',
    s.fails.length === 1,
    `${s.fails.length} mission:fail — "${s.fails[0]?.reason}"`);
}

{
  // ---- a WIN: a delivery driven into the drop ring ----------------------
  const { boy, idx } = chapterOf('aidan', 'deliver');
  const s = scene();
  const at = s.wq.poi(boy.story[idx].at ?? boy.story[idx].dest) ?? { x: 0, z: 0 };
  const M = begin(s, boy, idx, at);
  const veh = M.veh;
  board(s, veh);
  // Put the car in the ring. The track's own arrival test is what wins it.
  veh.setPose({ x: M.dest.x, y: 0, z: M.dest.z }, 0);
  s.player.position.set(M.dest.x, 0, M.dest.z);
  const c0 = s.ui.cards.length;
  const x0 = s.sfx.length;
  const f0 = s.time.frame;
  drive(s, Math.ceil(20 / DT));
  const won = endTally(s, c0, x0, f0);

  check('a WON chapter raises exactly ONE result card',
    won.cards === 1 && s.ui.cards[c0]?.kind === 'passed',
    `${won.cards} card(s): ${JSON.stringify(s.ui.cards.slice(c0))}`);
  check('...and the win event carries the payout the card prints',
    s.wins.length === 1 && s.wins[0].cash > 0,
    `${s.wins.length} mission:complete, cash ${s.wins[0]?.cash}, respect ${s.wins[0]?.respect}`);

  /* ---- NEGATIVE CONTROL: the same end with `carded` stripped ----------
   * Re-publish the END PAYLOAD the runner just emitted, minus the one field
   * that stands the fallback down. That is precisely the shipped double, and
   * it is the pre-fix behaviour rather than a synthetic extra call — so a
   * green "exactly one card" above is a claim the counter can tell apart from
   * a red one. */
  const before = s.ui.cards.length;
  const bare = { ...s.wins[0] };
  delete bare.carded;
  s.events.emit('mission:complete', bare);
  check('NEG CONTROL: the same end without `carded` raises the second card',
    s.ui.cards.length - before === 1 && s.ui.cards.length - c0 === 2,
    `stripping carded takes the end from ${won.cards} card to ${s.ui.cards.length - c0}`);
}

/* ========================================================================== */
/* 5 — the replay purse                                                       */
/* ========================================================================== */

/**
 * A chapter the frontier has already passed pays a fraction, and SAYS so.
 * Read off `economy.addCash` — the money that actually moved — and off the
 * toast, not off `M.rate`.
 */
{
  const { boy, idx, c } = chapterOf('aidan', 'deliver');

  const firstTime = scene();
  {
    const at = firstTime.wq.poi(c.at ?? c.dest) ?? { x: 0, z: 0 };
    const M = begin(firstTime, boy, idx, at);
    board(firstTime, M.veh);
    M.veh.setPose({ x: M.dest.x, y: 0, z: M.dest.z }, 0);
    firstTime.player.position.set(M.dest.x, 0, M.dest.z);
    drive(firstTime, Math.ceil(20 / DT));
  }

  const replay = scene();
  // The frontier is already past this chapter — exactly the state
  // `completeStoryChapter` leaves behind, and the state the pause menu replays
  // an old chapter from.
  replay.save.chars[boy.id].chapter = idx + 2;
  {
    const at = replay.wq.poi(c.at ?? c.dest) ?? { x: 0, z: 0 };
    const M = begin(replay, boy, idx, at);
    board(replay, M.veh);
    M.veh.setPose({ x: M.dest.x, y: 0, z: M.dest.z }, 0);
    replay.player.position.set(M.dest.x, 0, M.dest.z);
    drive(replay, Math.ceil(20 / DT));
  }

  const paidFirst = firstTime.economy.paid.reduce((a, b) => a + b, 0);
  const paidAgain = replay.economy.paid.reduce((a, b) => a + b, 0);
  check('a first clear pays the authored purse',
    paidFirst >= c.cash,
    `${paidFirst} against an authored ${c.cash}`);
  check('a REPLAY of a cleared chapter pays a fraction of it',
    paidAgain > 0 && paidAgain < paidFirst * 0.5,
    `${paidAgain} on the replay against ${paidFirst} first time — ` +
    `${paidFirst ? ((paidAgain / paidFirst) * 100).toFixed(0) : '?'}%`);
  check('...and the player is TOLD, rather than quietly short-changed',
    replay.ui.toasts.some((t) => /replay/i.test(t.text ?? '')),
    replay.ui.toasts.map((t) => `${t.text} ${t.value ?? ''}`).join(' | ') || 'no toast');
  check('NEG CONTROL: the first clear is not toasted as a replay',
    !firstTime.ui.toasts.some((t) => /replay/i.test(t.text ?? '')),
    firstTime.ui.toasts.map((t) => t.text).join(' | ') || 'no toasts');
}

/* ========================================================================== */
/* 6 — a LITE side job can be put down                                       */
/* ========================================================================== */

/**
 * `abandonLite()` was the documented public abort and nothing called it.
 * `game/index.js:_abortRequest` — the K path — returns on its first line when
 * `missions.active` is false, and a lite job is not a `MissionRunner` mission.
 * None of `explore`, `speed` or `copwar` has a clock, a leash or a wreck to end
 * it, so an accepted one stayed on the HUD over free roam until the player took
 * a chapter or died.
 *
 * Driven through the REAL key edge — a `ctx.input` stand-in with the two
 * methods `src/core/input.js` publishes — and read off the EMITTED
 * `mission:fail` and the toast, never off `jobs.lite.active`.
 */
{
  const s = scene();
  const keys = new Set();
  const held = new Set();
  s.ctx.input = {
    enabled: true, frozen: false,
    pressed: (c) => keys.has(c),
    held: (c) => held.has(c),
  };
  const jobs = new JobBoard(s.ctx, {
    wq: s.wq, economy: s.economy, missions: s.missions, save: s.save,
  });
  jobs.boy = BOYZ.aidan;
  const tap = () => { keys.add('KeyK'); jobs.update(DT); keys.delete('KeyK'); };

  const L = jobs.start('explore');
  check('a LITE side job accepts and runs',
    !!L && jobs.lite.active === true && jobs.lite.track === 'explore',
    `${jobs.lite.name || 'none'} (${jobs.lite.track || '-'})`);

  const toastsBefore = s.ui.toasts.length;
  tap();
  check('K once does NOT drop it — it asks first',
    jobs.lite.active === true &&
    s.ui.toasts.slice(toastsBefore).some((t) => /drop the job/i.test(t.text ?? '')),
    `active ${jobs.lite.active}, said "${s.ui.toasts[s.ui.toasts.length - 1]?.text ?? 'nothing'}"`);

  s.ctx.time.raw += 1.0;              // inside the confirmation window
  const failsBefore = s.fails.length;
  tap();
  check('K again inside the window DROPS it',
    jobs.lite.active === false && s.fails.length === failsBefore + 1,
    `active ${jobs.lite.active}, mission:fail "${s.fails[s.fails.length - 1]?.reason ?? 'none'}"`);
  check('...and the screen says so, exactly once',
    s.ui.cards.filter((c) => c.kind === 'failed').length === 1,
    `${s.ui.cards.length} card(s): ${JSON.stringify(s.ui.cards)}`);
}

/* ---- NEGATIVE CONTROL: the window expires ------------------------------- */
{
  const s = scene();
  const keys = new Set();
  s.ctx.input = { enabled: true, frozen: false, pressed: (c) => keys.has(c), held: () => false };
  const jobs = new JobBoard(s.ctx, {
    wq: s.wq, economy: s.economy, missions: s.missions, save: s.save,
  });
  jobs.boy = BOYZ.aidan;
  const tap = () => { keys.add('KeyK'); jobs.update(DT); keys.delete('KeyK'); };
  jobs.start('explore');
  tap();
  s.ctx.time.raw += 30;               // long past the window
  tap();
  check('NEG CONTROL: a second K long after the question does NOT drop it',
    jobs.lite.active === true,
    `active ${jobs.lite.active} after a 30 s gap between presses`);
}

/* ========================================================================== */
/* 8 — THE STAGING RINGS: free roam is the default, the ring is the door       */
/* ========================================================================== */
/**
 * THE DESIGN THIS GATES, in the owner's words: "they should always be in
 * freeplay mode and start missions by going to a certain location or walking
 * onto a glowing ring to indicate there is something for them to do".
 *
 * `StagingRings` (`freeroam.js`) is deliberately gameplay-free — it answers
 * "did he enter one" and nothing else — which is what lets this section drive
 * it with the REAL terrain and road graph and no `GameSystem` at all.
 *
 * WHY IT IS NOT CIRCULAR (rule 12). Nothing below reads the ring's own idea of
 * where it is against the number that placed it:
 *
 *   · "never in the river" is asserted with `terrain.isWater` at the EMITTED
 *     ring coordinate, against an input this file chose to be over water (a
 *     `DOCKS` pier head, which is over the Monongahela by construction);
 *   · "the ring is the same door as J" compares the `mission:start` PAYLOAD
 *     from a ring entry with the payload from a direct `missions.start` on a
 *     second scene — two emitted events, field by field, not two return values;
 *   · the swept entry test is driven with a JUMP the probe measures itself
 *     (60 m in one step, which is 108 km/h at this file's 20 Hz), so a
 *     point-sample implementation fails it.
 *
 * NEGATIVE CONTROLS, both of them real rather than synthetic:
 *   1. `rings.enabled = false` — the `?owNoRings=1` arm — must produce NO hit
 *      for the identical motion. Without it "walking in started the chapter"
 *      is a claim about the harness, not the feature.
 *   2. A ring that APPEARS UNDER THE PLAYER must not fire until he has been
 *      `RING_REARM` away. That is not a nicety: `_announceNext` publishes the
 *      next chapter's ring on the frame the last one ends, and chapters stage
 *      at recurring POIs, so without the latch the player is fired straight
 *      into the next chapter and never sees free roam — the exact bug the
 *      whole feature exists to remove.
 */
{
  const s = scene();
  const rings = new StagingRings(s.ctx, s.wq);
  const starts = [];
  s.events.on('mission:start', (p) => starts.push({ ...p }));

  const { boy, idx, c } = chapterOf('carson', 'deliver');
  const poi = POI.get(c.at ?? c.from ?? '') ?? null;
  const staged = poi?.stage ?? poi;

  // ---- 1. the ring stands on the STAGED point ---------------------------
  rings.setChapter({ x: staged.x, z: staged.z, name: c.name }, idx);
  const slot = rings.slots[0];
  const offStage = Math.hypot(slot.x - staged.x, slot.z - staged.z);
  check('a ring stands at the next chapter\'s staged point',
    slot.on === true && offStage < 0.001 && !terrain.isWater(slot.x, slot.z),
    `${c.no} ${c.name} at (${slot.x.toFixed(0)}, ${slot.z.toFixed(0)}), ` +
    `${offStage.toFixed(3)} m off the staging point, water ${terrain.isWater(slot.x, slot.z)}`);
  check('...standing ON the surface, not under the river bed',
    Math.abs(slot.y - s.wq.surfaceY(slot.x, slot.z)) < 0.01 && slot.y > -1,
    `ring y ${slot.y.toFixed(2)}, surface ${s.wq.surfaceY(slot.x, slot.z).toFixed(2)}`);

  // ---- 2. a WET target is moved to dry land -----------------------------
  // A `DOCKS` record's x/z IS the pier head and is over water on purpose. A
  // ring there is a chapter nobody can start.
  const pier = DOCKS.find((d) => terrain.isWater(d.x, d.z)) ?? DOCKS[0];
  rings.setChapter({ x: pier.x, z: pier.z, name: pier.name }, 0);
  const wet = rings.slots[0];
  check('a ring is never left in the river (the pier head is)',
    terrain.isWater(pier.x, pier.z) === true && terrain.isWater(wet.x, wet.z) === false,
    `${pier.name} pier (${pier.x}, ${pier.z}) water ${terrain.isWater(pier.x, pier.z)} -> ` +
    `ring (${wet.x.toFixed(0)}, ${wet.z.toFixed(0)}) water ${terrain.isWater(wet.x, wet.z)}, ` +
    `moved ${Math.hypot(wet.x - pier.x, wet.z - pier.z).toFixed(0)} m`);

  // ---- 3. arm from a distance, then walk in ------------------------------
  rings.setChapter({ x: staged.x, z: staged.z, name: c.name }, idx);
  const far = walk(rings, staged.x + 400, staged.z, staged.x + 200, staged.z);
  check('NEG CONTROL: a new ring is not armed and does not fire from 400 m',
    far === null && rings.slots[0].armed === true,
    `hit ${far === null ? 'none' : far.kind}, armed ${rings.slots[0].armed}`);
  const walked = walk(rings, staged.x + 200, staged.z, staged.x + 2, staged.z + 2);
  check('walking into the ring fires exactly one chapter trigger',
    !!walked && walked.kind === 'chapter' && walked.index === idx,
    `hit ${walked ? `${walked.kind} #${walked.index}` : 'none'}`);
  const again = rings.update(DT, staged.x, staged.z);
  check('...and standing in it does not fire it again',
    again === null, `second frame in the ring: ${again === null ? 'no hit' : again.kind}`);

  // ---- 4. the swept test — 108 km/h straight through --------------------
  rings.setChapter({ x: staged.x, z: staged.z, name: c.name }, idx);
  walk(rings, staged.x - 400, staged.z, staged.x - 30, staged.z);  // arm, then close
  const swept = rings.update(DT, staged.x + 30, staged.z); // 60 m in one 50 ms step
  check('driving THROUGH at 108 km/h still counts (the test is swept)',
    !!swept && swept.kind === 'chapter',
    `60 m step across the centre: ${swept ? swept.kind : 'MISSED'}`);

  // ---- 4b. ...but a TELEPORT is not a drive ------------------------------
  /**
   * MEASURED, and it is why this check exists: a capture staged with
   * `game:"clean"` photographed the CH 1 intro cutscene instead of the free
   * roam it asked for, because `Director.unstick` teleports the player once
   * the city has streamed in and the swept segment ran straight through the
   * chapter ring. A ring must answer for movement the player made.
   */
  rings.setChapter({ x: staged.x, z: staged.z, name: c.name }, idx);
  walk(rings, staged.x - 400, staged.z, staged.x - 200, staged.z);   // armed, far off
  const ported = rings.update(DT, staged.x, staged.z);               // 200 m in one step
  check('NEG CONTROL: a TELEPORT into the ring does not start the chapter',
    ported === null && rings.slots[0].armed === false,
    `200 m in one 50 ms step: ${ported === null ? 'no hit' : ported.kind}`);

  // ---- 5. the ring is the SAME DOOR as J --------------------------------
  rings.setChapter({ x: staged.x, z: staged.z, name: c.name }, idx);
  const enter = walk(rings, staged.x - 400, staged.z, staged.x, staged.z);
  if (enter?.kind === 'chapter') {
    s.player.position.set(staged.x, 0, staged.z);
    s.missions.start(boy, enter.index);
  }
  const viaRing = starts[starts.length - 1] ?? null;
  // The J path, on its own scene, so neither run can see the other's state.
  const s2 = scene();
  const starts2 = [];
  s2.events.on('mission:start', (p) => starts2.push({ ...p }));
  s2.player.position.set(staged.x, 0, staged.z);
  s2.missions.start(boy, idx);
  const viaKey = starts2[starts2.length - 1] ?? null;
  check('starting via the ring emits the SAME mission:start as J does',
    !!viaRing && !!viaKey &&
    viaRing.chapter === viaKey.chapter && viaRing.name === viaKey.name &&
    viaRing.track === viaKey.track && viaRing.zone === viaKey.zone,
    `ring ${JSON.stringify(viaRing && { chapter: viaRing.chapter, track: viaRing.track })} · ` +
    `key ${JSON.stringify(viaKey && { chapter: viaKey.chapter, track: viaKey.track })}`);
}

/* ---- NEGATIVE CONTROL: the rings turned off -------------------------- */
{
  const s = scene();
  const rings = new StagingRings(s.ctx, s.wq);
  rings.enabled = false;                       // the `?owNoRings=1` arm
  const { idx, c } = chapterOf('carson', 'deliver');
  const poi = POI.get(c.at ?? c.from ?? '');
  const staged = poi?.stage ?? poi;
  rings.setChapter({ x: staged.x, z: staged.z, name: c.name }, idx);
  rings.update(DT, staged.x - 400, staged.z);
  const hit = rings.update(DT, staged.x, staged.z);
  check('NEG CONTROL: with the rings off the same walk starts nothing',
    hit === null, `hit ${hit === null ? 'none' : hit.kind}`);
}

/* ---- NEGATIVE CONTROL: a ring that appears under his feet ------------- */
{
  const s = scene();
  const rings = new StagingRings(s.ctx, s.wq);
  const { idx, c } = chapterOf('carson', 'deliver');
  const poi = POI.get(c.at ?? c.from ?? '');
  const staged = poi?.stage ?? poi;
  // The frame a chapter ends: he is standing on the point the NEXT one stages.
  rings.setChapter({ x: staged.x, z: staged.z, name: c.name }, idx);
  const onTop = rings.update(DT, staged.x, staged.z);
  const stillOn = rings.update(DT, staged.x + 1, staged.z);
  check('NEG CONTROL: a ring published under the player cannot fire on the spot',
    onTop === null && stillOn === null && rings.slots[0].armed === false,
    `frame 1 ${onTop === null ? 'no hit' : onTop.kind}, frame 2 ${stillOn === null ? 'no hit' : stillOn.kind}`);
  // ...and it works normally once he has actually been somewhere else.
  const back = walk(rings, staged.x, staged.z, staged.x + 400, staged.z) ??
    walk(rings, staged.x + 400, staged.z, staged.x, staged.z);
  check('...and it arms the moment he leaves, so the ring still works',
    !!back && back.kind === 'chapter', `after leaving and returning: ${back ? back.kind : 'no hit'}`);
}

/* ---- the side-job rings ----------------------------------------------- */
{
  const s = scene();
  const rings = new StagingRings(s.ctx, s.wq);
  const jobs = new JobBoard(s.ctx, {
    wq: s.wq, economy: s.economy, missions: s.missions, save: s.save,
  });
  jobs.boy = BOYZ.aidan;
  jobs.refresh(true);
  const list = jobs.list();
  rings.setJobs(list);
  const live = rings.slots.slice(1).filter((r) => r.on);
  check('every standing side job gets its own ring',
    live.length === list.length && list.length === 3,
    `${live.length} rings for ${list.length} offers: ${live.map((r) => r.id).join(', ')}`);
  check('...and none of them is in the water either',
    live.every((r) => !terrain.isWater(r.x, r.z)),
    live.map((r) => `${r.id}@(${r.x.toFixed(0)},${r.z.toFixed(0)})`).join(' '));
  const j = live[0];
  const took = walk(rings, j.x + 400, j.z + 400, j.x, j.z);
  check('driving into a job ring offers THAT job, by id',
    !!took && took.kind === 'job' && took.id === j.id,
    `hit ${took ? `${took.kind}:${took.id}` : 'none'} against ring ${j.id}`);
}

/* ========================================================================== */

console.log('\ngame flow — the failure edges of the fixed tracks, headless on the emitted city');
console.log(`  seed ${SEED.toString(16)}, ${DT * 1000} ms step, ceiling ${MAX_STEPS} steps\n`);
for (const r of rows) {
  if (!r.ok || VERBOSE) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(64)} ${r.detail}`);
  } else {
    console.log(`  ok    ${r.name.padEnd(64)} ${r.detail}`);
  }
}
console.log(`\nflow: ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
