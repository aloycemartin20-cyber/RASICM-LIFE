#!/usr/bin/env node
/**
 * CAMERA FEEL TEST — the six behaviours of the camera's feel package, measured
 * on the EMITTED TRANSFORMS and nothing else.
 *
 *   node src/player/camtest.mjs
 *   node src/player/camtest.mjs --verbose
 *   node src/player/camtest.mjs --control=align     (run one negative control)
 *
 * WHY IT MEASURES WHAT IT MEASURES (hard rule 12)
 *
 * Every camera number below comes out of `cam.position` / `cam.quaternion` —
 * the two things the engine copies onto the real camera — compared either
 * against the vehicle's own emitted pose or against an IDENTICAL rig that was
 * not given the event. The attitude family reads the WORLD MATRICES OF THE REAL
 * SKELETON, built by the shipping character mesh and driven by the real
 * `Animator`. Nothing asserts on `manualYaw`, `trauma`, `alignRate`,
 * `frameClass`, `_seatTilt` or any other flag the production code set on
 * itself, because a gate that reads the code's own input compares a number to
 * itself and always passes.
 *
 * Concretely, what would make each family fail:
 *
 *   align    — the align rate not varying with speed (the half-life gate is a
 *              ranking across four speeds, so a constant rate is red however
 *              fast it is), or the align running while the look control is live.
 *   framing  — a class falling through to the car framing, or the class number
 *              being paid for twice by also taking the per-metre size gain. The
 *              target is a fixed ratio (22/18, 24/18) written into this file, so
 *              it cannot be satisfied by agreeing with whatever `tuning.js`
 *              currently says.
 *   flight   — a fixed-wing framed like a hatchback (which every one of them
 *              was), a boom that stares at the ground from 400 m, an aircraft
 *              that walks out of frame in a climb, a boom cast that snaps onto
 *              the tailplane at altitude, or a yaw filter no looser than a car's.
 *   attitude — a seated body that does not wear the car's roll and pitch, one
 *              that wears the chatter as well as the bank, one whose facing the
 *              tilt has rotated, or a tilt that leaks onto a man on foot.
 *   recoil   — a kick channel that moves `viewKick` without moving the emitted
 *              quaternion. This is exactly the state the chase solver was in.
 *   shake    — no listener, the wrong severity, or a decay that never lands.
 *
 * And every family has a NEGATIVE CONTROL that reverts the behaviour and
 * asserts the named gates go red. `--controls` (on by default) runs all seven.
 * A gate that has never failed is not evidence of anything.
 */

import * as THREE from 'three';
import {
  VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP, WET_SENS, wetGrip,
} from '../vehicles/specs.js';
import { Vehicle } from '../vehicles/dynamics.js';
import { VehicleSystem } from '../vehicles/index.js';
import { Movement } from './movement.js';
import { VehicleHandler } from './vehicle.js';
import { CameraRig, EXTRA_FRAMES, FLIGHT } from './camera.js';
import { CAMERA, CHASE, STANCE } from './tuning.js';
import { Animator } from './anim/animator.js';
import { buildCharacter } from './character/mesh.js';
import { BROTHERS } from './brothers.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

const PDT = 1 / 120;
const FDT = 1 / 60;
const SURFACE = 'asphalt';

/* ====================================================================== */
/* A flat world — same construction as src/player/drivetest.mjs           */
/* ====================================================================== */

const HIT = {
  hit: true,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
  distance: 0,
  surface: SURFACE,
  object: null,
};

const fakePhysics = {
  MASK: { WORLD: 3, CHARACTER: 3 },
  staticWorld: null,
  raycast(origin, dir, maxDist) {
    const denom = dir.y;
    if (denom >= -1e-6) { HIT.hit = false; return HIT; }
    const t = -origin.y / denom;
    if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
    HIT.hit = true;
    HIT.distance = t;
    HIT.point.set(origin.x + dir.x * t, 0, origin.z + dir.z * t);
    HIT.normal.set(0, 1, 0);
    HIT.surface = SURFACE;
    return HIT;
  },
  groundHeight: () => 0,
  checkCapsule: () => true,
  /** Open sky: the boom never collides, so framing is the solver's own answer. */
  sphereCast: () => ({ hit: false, distance: Infinity }),
};

const GRIP = {};
for (const k in SURFACE_GRIP) {
  const base = SURFACE_GRIP[k];
  const sens = WET_SENS[k] ?? 0.6;
  GRIP[k] = { ...base, mu: wetGrip(base.mu, 0 * sens), skid: base.skid, roll: base.roll, drag: base.drag };
}

const fakeSys = {
  physics: fakePhysics,
  lodOf: () => 0,
  surfaceAt: () => SURFACE,
  waterHeightAt: () => null,
  reportCollision: () => {},
  gripOf: (name) => GRIP[name] ?? GRIP.asphalt,
  _world: () => null,
};

const stubModel = { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {} };

function makeInput() {
  const held = new Set();
  return {
    held,
    press: (k) => held.add(k),
    release: (k) => held.delete(k),
    clear: () => held.clear(),
    moveVector(out = { x: 0, y: 0 }) {
      out.x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
      out.y = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0);
      return out;
    },
    action: (name) => held.has(name),
  };
}

function makeVehicleSystem(ctx, v, player) {
  return {
    ctx,
    vehicles: [v],
    _isPlayerActor: (a) => a === player,
    setHorn: VehicleSystem.prototype.setHorn,
    onFuelState: () => {},
    nearest: VehicleSystem.prototype.nearest,
    setInput: VehicleSystem.prototype.setInput,
    seatAnchor: VehicleSystem.prototype.seatAnchor,
    setDriver: VehicleSystem.prototype.setDriver,
    clearDriver: VehicleSystem.prototype.clearDriver,
    setDoor: () => {},
  };
}

/** One player, one car, one camera, one clock. */
function makeRig(type = 'sports') {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(fakeSys, spec, stubModel, {});
  v.setPose(new THREE.Vector3(0, spec.comY, 0), 0);
  v.damage = null;
  v.occupants = [];
  v.driver = null;

  const time = { dt: FDT, elapsed: 0, alpha: 1, frame: 0 };
  const listeners = new Map();
  const events = {
    emit(name, payload) { for (const f of (listeners.get(name) ?? []).slice()) f(payload); },
    on(name, f) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(f);
      return () => {
        const a = listeners.get(name);
        const i = a.indexOf(f);
        if (i >= 0) a.splice(i, 1);
      };
    },
  };
  const input = makeInput();
  const registry = { physics: fakePhysics };
  const ctx = { time, events, input, config: { fov: 65 }, peek: (k) => registry[k] ?? null };

  const player = { controlEnabled: true, health: { dead: false } };
  const m = new Movement(ctx, player);
  m.grounded = true;
  player.movement = m;

  const vehicles = makeVehicleSystem(ctx, v, player);
  registry.vehicles = vehicles;

  const handler = new VehicleHandler(ctx, player);
  player.vehicles = handler;

  const cam = new CameraRig(ctx);
  const health = { fraction: 1, suppression: 0 };

  return { spec, v, m, ctx, input, handler, player, time, vehicles, cam, health };
}

function frame(rig) {
  rig.time.frame++;
  rig.time.elapsed += FDT;
  rig.handler.update(FDT, rig.m);
  rig.cam.setVehicle(rig.handler.seated ? rig.handler.vehicle : null);
  rig.cam.update(FDT, rig.m, rig.health);
  rig.v.fixedStep(PDT, rig.ctx);
  rig.v.fixedStep(PDT, rig.ctx);
}

function frames(rig, n, sample) {
  for (let i = 0; i < n; i++) {
    frame(rig);
    if (sample) sample(i, rig);
  }
}

function seatThePlayer(rig) {
  const a = rig.vehicles.seatAnchor(rig.v, 0);
  rig.m.position.set(a.enter.x, 0, a.enter.z);
  rig.m.prevPosition.copy(rig.m.position);
  rig.m.grounded = true;
  frame(rig);
  if (!rig.handler.tryEnter(rig.m)) return false;
  for (let i = 0; i < 240 && rig.handler.phase !== 'drive'; i++) frame(rig);
  return rig.handler.phase === 'drive';
}

/**
 * A camera with no car: enough of the rig to point the chase solver at a
 * duck-typed vehicle. The bus and helicopter classes may not have landed in
 * `vehicles` yet, so the framing law has to be gateable before they exist —
 * and once they DO exist the same test runs against the real spec instead
 * (see `framingSubject`).
 */
function makeCamRig(phys = fakePhysics) {
  const time = { dt: FDT, elapsed: 0, alpha: 1, frame: 0 };
  const listeners = new Map();
  const events = {
    emit(name, p) { for (const f of (listeners.get(name) ?? []).slice()) f(p); },
    on(name, f) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(f);
      return () => {};
    },
  };
  const registry = { physics: phys };
  const ctx = {
    time, events, input: makeInput(), config: { fov: 65 },
    peek: (k) => registry[k] ?? null,
  };
  const player = { controlEnabled: true, health: { dead: false } };
  const m = new Movement(ctx, player);
  m.position.set(0, 0, 0);
  m.prevPosition.copy(m.position);
  m.grounded = true;
  const cam = new CameraRig(ctx);
  const health = { fraction: 1, suppression: 0 };
  return { ctx, m, cam, health, time };
}

function camFrames(rig, n) {
  for (let i = 0; i < n; i++) {
    rig.time.frame++;
    rig.time.elapsed += FDT;
    rig.cam.update(FDT, rig.m, rig.health);
  }
}

/* ====================================================================== */
/* Geometry read off the EMITTED transforms                               */
/* ====================================================================== */

const _nose = new THREE.Vector3();
const _toCar = new THREE.Vector3();

/** A vehicle's nose is +Z. A camera's basis is -Z. These are not the same. */
function noseOf(v, out = _nose) {
  return out.set(0, 0, 1).applyQuaternion(v.quaternion);
}

/**
 * The angle, in degrees, between "the direction from the camera to the car" and
 * "the way the car is pointing", flattened to the ground plane. Zero means the
 * camera is directly behind the car looking up its boot.
 */
function alignErrDeg(cam, v) {
  _toCar.set(v.position.x - cam.position.x, 0, v.position.z - cam.position.z);
  const l = _toCar.length();
  if (l < 1e-5) return 0;
  _toCar.multiplyScalar(1 / l);
  noseOf(v);
  _nose.y = 0;
  const nl = _nose.length();
  if (nl < 1e-5) return 0;
  _nose.multiplyScalar(1 / nl);
  return Math.acos(Math.min(1, Math.max(-1, _toCar.dot(_nose)))) * RAD;
}

/**
 * `tools/playprobe.mjs`'s invariant: car->camera dotted with the nose. -1 is
 * directly behind, +1 is parked in front of the windscreen. It asserts < -0.5
 * and this file must never be the reason that stops being true.
 */
function camDotNose(cam, v) {
  _toCar.set(cam.position.x - v.position.x, cam.position.y - v.position.y, cam.position.z - v.position.z);
  const l = _toCar.length();
  if (l < 1e-5) return -1;
  _toCar.multiplyScalar(1 / l);
  return _toCar.dot(noseOf(v));
}

/** Cruise control, so a measurement happens at the speed it says it does. */
function holdSpeed(rig, target) {
  if (rig.v.forwardSpeed < target) rig.input.press('forward');
  else rig.input.release('forward');
}

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

/* ====================================================================== */
/* Results                                                                */
/* ====================================================================== */

let OUT = [];
const rec = (id, area, name, ok, detail) => OUT.push({ id, area, name, ok, detail });
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));
const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : String(n));

/* ====================================================================== */
/* 1. SPEED-PROPORTIONAL AUTO-ALIGN                                       */
/* ====================================================================== */

/**
 * Drive at a held speed, shove the camera 50 degrees off-axis with a real
 * `addLook`, then either let go or keep dragging, and watch the EMITTED
 * camera-to-nose angle come home (or not).
 */
function alignRun({ speed, drag = false, steer = null, seconds = 3.0, type = 'sports' }) {
  const rig = makeRig(type);
  if (!seatThePlayer(rig)) return null;
  // Get up to speed and let the chase camera settle behind the car first.
  for (let i = 0; i < 60 * 12; i++) {
    holdSpeed(rig, speed);
    if (steer) rig.input.press(steer);
    frame(rig);
    if (i > 60 * 6 && Math.abs(rig.v.forwardSpeed - speed) < 0.35) break;
  }
  for (let i = 0; i < 90; i++) { holdSpeed(rig, speed); frame(rig); }

  const settled = alignErrDeg(rig.cam, rig.v);
  rig.cam.addLook(50 * DEG, 0);

  const series = [];
  let worstDot = -1;
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    holdSpeed(rig, speed);
    // "Actively dragging the look control": a live input every frame. The
    // delta is small enough (1e-5 rad/frame, 0.01 deg over the whole run) that
    // it cannot be what holds the camera off-axis.
    if (drag) rig.cam.addLook(1e-5, 0);
    frame(rig);
    series.push({ t: (i + 1) / 60, err: alignErrDeg(rig.cam, rig.v), spd: rig.v.forwardSpeed });
    const d = camDotNose(rig.cam, rig.v);
    if (d > worstDot) worstDot = d;
  }
  const err0 = series[0].err;
  const half = err0 * 0.5;
  const hit = series.find((s) => s.err <= half);
  const sorted = series.map((s) => s.err).slice().sort((a, b) => a - b);
  return {
    settled,
    err0,
    series,
    halfLife: hit ? hit.t : Infinity,
    at25: series[Math.min(series.length - 1, Math.round(2.5 * 60) - 1)].err,
    end: series[series.length - 1].err,
    p50: pct(sorted, 0.5),
    p90: pct(sorted, 0.9),
    speed: series[series.length - 1].spd,
    worstDot,
  };
}

const ALIGN_SPEEDS = [5, 12, 22, 32];

function testAlign() {
  const runs = ALIGN_SPEEDS.map((s) => ({ s, r: alignRun({ speed: s }) }));
  if (runs.some((x) => !x.r)) {
    rec('align.seat', 'align', 'player reaches the seat', false, 'never got to phase drive');
    return null;
  }

  /* --- the whole claim: faster car, faster align ------------------------ */
  const halves = runs.map((x) => x.r.halfLife);
  let monotone = true;
  for (let i = 1; i < halves.length; i++) if (!(halves[i] < halves[i - 1] * 0.92)) monotone = false;
  rec('align.monotone', 'align', 'align half-life SHORTENS with speed', monotone,
    runs.map((x) => `${x.s}m/s:${f2(x.r.halfLife)}s`).join('  ') +
    '  (each must beat the slower one by >8%)');

  /* --- and the two ends of it ------------------------------------------- */
  const fast = runs[runs.length - 1].r;
  const slow = runs[0].r;
  rec('align.fast', 'align', 'at speed the camera comes home on its own', fast.at25 < 8,
    `${f2(fast.speed)} m/s: 50deg -> ${f2(fast.at25)}deg after 2.5 s (want < 8)`);
  rec('align.slow', 'align', 'at a crawl it does NOT snatch the view back', slow.at25 > 18,
    `${f2(slow.speed)} m/s: 50deg -> ${f2(slow.at25)}deg after 2.5 s (want > 18)`);

  /* --- suppressed while the look control is live ------------------------ */
  const drag = alignRun({ speed: 32, drag: true });
  // "Suppressed outright" is a claim about the DERIVATIVE, not the value: the
  // offset must not move at all while the look is live. Half-life Infinity is
  // the strong half — the error never even reaches 50% of where it started.
  const dragHalf = drag ? drag.at25 / drag.err0 : 0;
  rec('align.drag', 'align', 'a live look input suppresses the align outright',
    drag && drag.halfLife === Infinity && dragHalf > 0.98,
    drag ? `dragging at ${f2(drag.speed)} m/s: ${f2(drag.err0)}deg -> ${f2(drag.at25)}deg ` +
      `(${f3(dragHalf)} of where it started; released at the same speed went to ` +
      `${f2(fast.at25)}deg = ${f3(fast.at25 / fast.err0)})` : 'run failed');

  /* --- through a turn ---------------------------------------------------- */
  const turn = alignRun({ speed: 20, steer: 'left', seconds: 3.5 });
  rec('align.turn', 'align', 'converges through a sustained turn too',
    turn && turn.end < 16,
    turn ? `${f2(turn.err0)}deg -> ${f2(turn.end)}deg over 3.5 s in a left-hander (want < 16)` : 'run failed');

  /* --- and never in front of the windscreen ----------------------------- */
  const worst = Math.max(...runs.map((x) => x.r.worstDot), turn ? turn.worstDot : -1);
  rec('align.behind', 'align', 'camera stays BEHIND the car throughout (playprobe invariant)',
    worst < -0.5,
    `worst car->cam . nose = ${f3(worst)} over ${runs.length + 1} runs (want < -0.5; +1 = in front)`);

  return { runs, drag, turn };
}

/* ====================================================================== */
/* 2. PER-STATE FRAMING  (foot 16, car 18, bus 22, heli 24)               */
/* ====================================================================== */

/**
 * The subject for one framing class. If `vehicles` has landed a real spec for
 * it, use that; otherwise a duck-typed stand-in with identical dimensions, so
 * the ONLY difference between the three measurements is the class the camera
 * resolved. Identical dimensions is the point: it takes the size gain out of
 * the comparison, which is what makes the ratio a statement about the framing
 * law rather than about a bus being long.
 */
function framingSubject(cls) {
  const realId = Object.keys(VEHICLE_SPECS).find((id) => {
    const s = VEHICLE_SPECS[id];
    const tag = `${s.kind ?? ''} ${s.id ?? ''}`.toLowerCase();
    if (cls === 'bus') return /bus|coach|transit/.test(tag);
    if (cls === 'heli') return s.fly === true || /heli|chopper|rotor/.test(tag);
    return false;
  });
  const spec = cls === 'car'
    ? { kind: 'car', id: 'sedan', half: { x: 0.95, y: 0.7, z: 2.25 } }
    : { kind: cls, id: cls, half: { x: 0.95, y: 0.7, z: 2.25 } };
  return {
    real: realId ?? null,
    vehicle: {
      position: new THREE.Vector3(0, 0.6, 0),
      quaternion: new THREE.Quaternion(),
      velocity: new THREE.Vector3(),
      // Neutral dimensions: exactly the size at which the per-metre gain and
      // the pivot lift are both zero.
      length: 4.5,
      height: 1.4,
      spec,
    },
  };
}

/** Emitted camera-to-subject distance once every filter has settled. */
function framingDistance(subject) {
  const rig = makeCamRig();
  rig.cam.setVehicle(subject);
  camFrames(rig, 60 * 6);
  return {
    dist: rig.cam.position.distanceTo(subject.position),
    cls: rig.cam.frameClass,
  };
}

function footFramingDistance() {
  const rig = makeCamRig();
  camFrames(rig, 60 * 6);
  return rig.cam.position.distanceTo(rig.m.position);
}

function testFraming() {
  const car = framingSubject('car');
  const bus = framingSubject('bus');
  const heli = framingSubject('heli');

  const dCar = framingDistance(car.vehicle);
  const dBus = framingDistance(bus.vehicle);
  const dHeli = framingDistance(heli.vehicle);
  const dFoot = footFramingDistance();

  rec('frame.resolve', 'framing', 'each subject resolves to its own framing class',
    dCar.cls === 'car' && dBus.cls === 'bus' && dHeli.cls === 'heli',
    `car->${dCar.cls} bus->${dBus.cls} heli->${dHeli.cls}` +
    `  (real specs: bus=${bus.real ?? 'not landed yet'} heli=${heli.real ?? 'not landed yet'})`);

  rec('frame.foot', 'framing', 'on foot frames closer than in a car',
    dFoot < dCar.dist,
    `foot ${f2(dFoot)} m vs car ${f2(dCar.dist)} m (expected 16 vs 18)`);

  rec('frame.order', 'framing', 'car < bus < heli',
    dCar.dist < dBus.dist && dBus.dist < dHeli.dist,
    `${f2(dCar.dist)} / ${f2(dBus.dist)} / ${f2(dHeli.dist)} m`);

  // The targets are fixed ratios written here, not this repo's numbers.
  const rBus = dBus.dist / dCar.dist;
  const rHeli = dHeli.dist / dCar.dist;
  const okBus = Math.abs(rBus / (22 / 18) - 1) < 0.08;
  const okHeli = Math.abs(rHeli / (24 / 18) - 1) < 0.08;
  rec('frame.bus', 'framing', 'bus framing matches the expected ratio', okBus,
    `bus/car = ${f3(rBus)} (expected 22/18 = ${f3(22 / 18)}, tol 8%)`);
  rec('frame.heli', 'framing', 'helicopter framing matches the expected ratio', okHeli,
    `heli/car = ${f3(rHeli)} (expected 24/18 = ${f3(24 / 18)}, tol 8%)`);

  // Graceful degradation: an unknown class must not throw and must not move.
  const unknown = framingSubject('car');
  unknown.vehicle.spec = { kind: 'hovercraft', id: 'zephyr', half: { x: 0.95, y: 0.7, z: 2.25 } };
  const dUnknown = framingDistance(unknown.vehicle);
  rec('frame.unknown', 'framing', 'an unrecognised class degrades to the car framing',
    dUnknown.cls === 'car' && Math.abs(dUnknown.dist - dCar.dist) < 0.01,
    `hovercraft -> ${dUnknown.cls}, ${f2(dUnknown.dist)} m vs car ${f2(dCar.dist)} m`);

  // ...and a big vehicle that is NOT a framing class still gets the size gain,
  // which is what keeps a pickup framed wider than a hatchback.
  const big = framingSubject('car');
  big.vehicle.length = 9.5;
  const dBig = framingDistance(big.vehicle);
  rec('frame.sizegain', 'framing', 'the per-metre size gain still works for plain cars',
    dBig.dist > dCar.dist + 1.4,
    `9.5 m car ${f2(dBig.dist)} m vs 4.5 m car ${f2(dCar.dist)} m`);

  return { dFoot, dCar: dCar.dist, dBus: dBus.dist, dHeli: dHeli.dist };
}

/**
 * ...and the same measurement against the SHIPPING specs, dimensions and all.
 * The stub test above isolates the framing law; this one is what the player
 * actually gets, and it is the only place the size terms are exercised on a
 * real `Vehicle` (whose only dimension field is `spec.half`).
 */
function realFraming(id) {
  const spec = finalizeSpec(VEHICLE_SPECS[id]);
  const v = new Vehicle(fakeSys, spec, stubModel, {});
  v.setPose(new THREE.Vector3(0, spec.comY, 0), 0);
  const rig = makeCamRig();
  rig.cam.setVehicle(v);
  camFrames(rig, 60 * 6);
  return { id, dist: rig.cam.position.distanceTo(v.position), cls: rig.cam.frameClass, spec };
}

function testFramingReal() {
  const ids = ['bike', 'sports', 'sedan', 'police', 'van', 'truck', 'bus', 'heli', 'plane', 'jet']
    .filter((id) => VEHICLE_SPECS[id]);
  const got = ids.map(realFraming);
  const by = Object.fromEntries(got.map((g) => [g.id, g]));

  rec('real.classes', 'framing', 'the shipping bus and helicopter resolve to their classes',
    by.bus?.cls === 'bus' && by.heli?.cls === 'heli',
    got.map((g) => `${g.id}->${g.cls} ${f2(g.dist)}m`).join('  '));

  rec('real.order', 'framing', 'shipping framing orders sedan < bus < helicopter',
    by.sedan && by.bus && by.heli &&
    by.sedan.dist < by.bus.dist && by.bus.dist < by.heli.dist,
    by.sedan && by.bus && by.heli
      ? `${f2(by.sedan.dist)} / ${f2(by.bus.dist)} / ${f2(by.heli.dist)} m` : 'missing a spec');

  /**
   * The size terms read `spec.half` and nothing else, so this is the gate that
   * would have caught them being inert: a 7.2 m truck must not be framed like
   * a 4.6 m sports car.
   */
  rec('real.size', 'framing', 'a truck frames wider than a sports car',
    by.truck && by.sports && by.truck.dist > by.sports.dist + 0.6,
    by.truck && by.sports
      ? `truck (7.2 m body) ${f2(by.truck.dist)} m vs sports (4.6 m) ${f2(by.sports.dist)} m` : 'missing a spec');

  return got;
}

/* ====================================================================== */
/* 2b. THE FLIGHT CHASE — fixed-wing framing, lag, climb and the boom cast */
/* ====================================================================== */

/**
 * A duck-typed aircraft with the same neutral dimensions the framing subjects
 * use, so a comparison between classes is a statement about the CLASS and not
 * about a wingspan. `alt` and a climbing velocity are what `plane.js` publishes
 * (`v.altitude`, `v.velocity`) and are the only two channels the flight camera
 * reads beyond the pose.
 *
 * `altitude` is HELD while the position climbs, deliberately: the altitude term
 * and the climb term are separate laws and a run that moved both would not say
 * which one produced the number. A real Skylark re-publishes AGL every step.
 */
function flyer(kind, { alt = 0, speed = 60, climb = 0, yaw = 0 } = {}) {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return {
    position: new THREE.Vector3(0, 40 + alt, 0),
    quaternion: q,
    velocity: new THREE.Vector3(fwd.x * speed, climb, fwd.z * speed),
    altitude: alt,
    length: 4.5,
    height: 1.4,
    spec: { kind, id: kind, half: { x: 0.95, y: 0.7, z: 2.25 } },
  };
}

/**
 * Step an already-built rig for `secs`, re-scripting the subject each frame.
 *
 * THE SUBJECT MOVES. It has to: a chase camera's pivot is a filtered follow, so
 * an aircraft nailed to one point produces a converged camera and no lag of any
 * kind — which reads as every framing being perfect at everything. A climb is a
 * POSITION going up, not a velocity field.
 */
function flySteps(rig, subject, secs, steer = null, t0 = 0) {
  const n = Math.round(secs * 60);
  for (let i = 0; i < n; i++) {
    if (steer) steer(t0 + i / 60, subject);
    subject.position.addScaledVector(subject.velocity, FDT);
    rig.time.frame++;
    rig.time.elapsed += FDT;
    rig.cam.update(FDT, rig.m, rig.health);
  }
  return t0 + n / 60;
}

/** Fly a subject for `secs` and return the emitted camera geometry. */
function flightRun(subject, { secs = 6, phys = fakePhysics, steer = null } = {}) {
  const rig = makeCamRig(phys);
  rig.cam.setVehicle(subject);
  flySteps(rig, subject, secs, steer);
  return {
    cls: rig.cam.frameClass,
    dist: rig.cam.position.distanceTo(subject.position),
    /** Where the subject sits relative to the view axis, in degrees. */
    offAxis: offAxisDeg(rig.cam, subject.position),
    /** How far the camera is looking below level, in degrees. */
    lookDown: -Math.asin(clampN(rig.cam.forward.y, -1, 1)) * RAD,
    rig,
  };
}

const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const _off = new THREE.Vector3();

/** Angle between the camera's forward and the direction to a point. */
function offAxisDeg(cam, at) {
  _off.copy(at).sub(cam.position);
  const l = _off.length();
  if (l < 1e-5) return 0;
  _off.multiplyScalar(1 / l);
  return Math.acos(clampN(_off.dot(cam.forward), -1, 1)) * RAD;
}

/** A physics stub that reports a blocker at `d` metres down every boom. */
function blockingPhysics(d) {
  const hit = { hit: true, distance: d, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0) };
  return { ...fakePhysics, sphereCast: () => hit };
}

function testFlight() {
  /* ---- 1. framing: the fixed-wing has its own, and the heli keeps his ---- */
  // At rest, like every other framing subject — the speed gain is a separate
  // term and mixing it in would make this a statement about airspeed.
  const car = framingSubject('car').vehicle;
  const dCar = framingDistance(car);
  const dHeli = framingDistance(framingSubject('heli').vehicle);
  const plane = flightRun(flyer('plane', { speed: 0 }), { secs: 6 });
  const rPlane = plane.dist / dCar.dist;

  rec('flight.frame', 'flight', 'a fixed-wing gets the flight framing, not the car one',
    Math.abs(rPlane / (30 / 18) - 1) < 0.08,
    `plane/car = ${f3(rPlane)} (expected 30/18 = ${f3(30 / 18)}, tol 8%) — ` +
    `plane ${f2(plane.dist)} m vs car ${f2(dCar.dist)} m`);

  rec('flight.order', 'flight', 'car < heli < plane, and the heli is untouched',
    dCar.dist < dHeli.dist && dHeli.dist < plane.dist &&
    Math.abs((dHeli.dist / dCar.dist) / (24 / 18) - 1) < 0.08,
    `${f2(dCar.dist)} / ${f2(dHeli.dist)} / ${f2(plane.dist)} m ` +
    `(heli/car ${f3(dHeli.dist / dCar.dist)}, still 24/18)`);

  /**
   * ...and every fixed-wing `vehicles` ships resolves to it, measured on the
   * emitted distance rather than on `frameClass`: each aeroplane must frame
   * WIDER than the shipping helicopter, which no car-class vehicle in the game
   * does. This is the check that the old `/heli|chopper|rotor|aircraft/` tag
   * test fails — every one of them fell through to `car`.
   */
  const wings = ['plane', 'sportplane', 'bushplane', 'twinplane', 'jet'].filter((id) => VEHICLE_SPECS[id]);
  const shipHeli = realFraming('heli').dist;
  const shipWings = wings.map((id) => ({ id, d: realFraming(id).dist }));
  rec('flight.shipping', 'flight', 'every shipping fixed-wing frames wider than the helicopter',
    shipWings.length >= 4 && shipWings.every((w) => w.d > shipHeli),
    shipWings.map((w) => `${w.id} ${f2(w.d)}`).join('  ') + `  vs heli ${f2(shipHeli)} m`);

  /* ---- 2. altitude-aware pitch ---- */
  const low = flightRun(flyer('plane', { alt: 0 }));
  const high = flightRun(flyer('plane', { alt: 400 }));
  rec('flight.altitude', 'flight', 'the boom stops staring at the ground once it is 400 m away',
    low.lookDown - high.lookDown > 5,
    `looking down ${f2(low.lookDown)} deg on the runway, ${f2(high.lookDown)} deg at 400 m`);

  /* ---- 3. the climb stays where level flight put it in frame ---- */
  /**
   * The measurement is a SHIFT: how far the subject moves in the frame between
   * level flight and a 22 m/s climb, for each framing. An absolute off-axis
   * angle would be measuring the boom's height-over-distance ratio (13-odd
   * degrees for every chase camera in the game, on foot included) rather than
   * anything to do with climbing.
   */
  const level = flightRun(flyer('plane', { alt: 300, climb: 0 }));
  const carLevel = flightRun(flyer('sedan', { alt: 300, climb: 0 }));
  // THREE rates, one of them a dive. `pitchClimb` was tuned against the 22 m/s
  // case; a single rate would not tell anyone whether it generalises or was
  // simply fitted to the one number in the gate.
  const RATES = [22, 10, -15];
  const shifts = RATES.map((c) => ({
    c,
    flight: Math.abs(flightRun(flyer('plane', { alt: 300, climb: c })).offAxis - level.offAxis),
    car: Math.abs(flightRun(flyer('sedan', { alt: 300, climb: c })).offAxis - carLevel.offAxis),
  }));
  const worstFlight = Math.max(...shifts.map((s) => s.flight));
  const worstRatio = Math.min(...shifts.map((s) => s.car / Math.max(1e-4, s.flight)));
  rec('flight.climb', 'flight', 'a climb or a dive barely moves the aeroplane in frame',
    worstFlight < 1.2,
    shifts.map((s) => `${s.c > 0 ? '+' : ''}${s.c} m/s: ${f2(s.flight)} deg`).join('  ') +
    `  (level framing ${f2(level.offAxis)} deg off axis)`);
  rec('flight.climbgain', 'flight', '...where the car framing lets it drift',
    worstRatio > 2.5,
    shifts.map((s) => `${s.c > 0 ? '+' : ''}${s.c}: car ${f2(s.car)} vs flight ` +
      `${f2(s.flight)} deg`).join('  ') + `  (worst ratio ${f3(worstRatio)}x)`);

  /* ---- 4. no ground snap at altitude ---- */
  const NEAR = 1.4;
  const blocked = blockingPhysics(NEAR);
  const grounded = flightRun(flyer('plane', { alt: 0 }), { phys: blocked });
  const aloft = flightRun(flyer('plane', { alt: 300 }), { phys: blocked });
  const clear = flightRun(flyer('plane', { alt: 300 }));
  rec('flight.nosnap', 'flight', 'the boom ignores a blocker reported at altitude',
    Math.abs(aloft.dist - clear.dist) < 0.05,
    `${f2(aloft.dist)} m with a blocker at ${f2(NEAR)} m, ${f2(clear.dist)} m with open sky`);
  rec('flight.snapsonground', 'flight', '...and still obeys one on the runway',
    grounded.dist < clear.dist - 2,
    `${f2(grounded.dist)} m on the ground vs ${f2(clear.dist)} m aloft`);

  /* ---- 5. wider lag ---- */
  /**
   * A step in travel direction, held, AFTER the camera has settled behind the
   * subject. Settling first is not optional: from a cold start the yaw filter
   * is still travelling half a turn, and a looser filter is FURTHER from home
   * when the step lands — which reads as the flight camera being tighter and is
   * a measurement of the initial transient, not of the lag.
   *
   * The emitted camera-to-nose angle 0.5 s after the step is how far behind the
   * camera still is. Bigger is looser, and looser is the point.
   */
  const turn = (t, s) => {
    const yaw = t < 4 ? 0 : 1.2;
    s.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const f = new THREE.Vector3(0, 0, 1).applyQuaternion(s.quaternion);
    s.velocity.set(f.x * 60, 0, f.z * 60);
  };
  const lagOf = (kind) => {
    const s = flyer(kind, { alt: 300 });
    const rig = makeCamRig();
    rig.cam.setVehicle(s);
    const settled = flySteps(rig, s, 4.0, turn);
    const before = alignErrDeg(rig.cam, s);
    flySteps(rig, s, 0.5, turn, settled);
    return { before, after: alignErrDeg(rig.cam, s) };
  };
  const lagPlane = lagOf('plane');
  const lagCar = lagOf('sedan');
  rec('flight.lag', 'flight', 'the flight chase lags a hard turn more than the car chase',
    lagPlane.before < 1 && lagCar.before < 1 && lagPlane.after > lagCar.after * 1.25,
    `0.5 s after a 69 deg step: ${f2(lagPlane.after)} deg still to catch up vs ` +
    `${f2(lagCar.after)} deg for the car (ratio ` +
    `${f3(lagPlane.after / Math.max(1e-4, lagCar.after))}; both settled to ` +
    `${f2(lagPlane.before)} / ${f2(lagCar.before)} deg first)`);

  return { rPlane, plane, low, high, shifts, aloft, clear, lagPlane, lagCar };
}

/* ====================================================================== */
/* 2c. THE SEATED BODY WEARS THE CAR'S ATTITUDE                           */
/* ====================================================================== */

/**
 * `setSeatTransform` carries a position and a YAW SCALAR, and the animator
 * writes the root from that yaw alone — so the driver stood bolt upright in
 * world space whatever the car was doing, through the roof on any slope and
 * out of the side of a banked bike. `drivetest`'s facing check already carried
 * the gap in prose and gave bikes a 12-degree tolerance to hide it.
 *
 * MEASURED ON THE REAL EMITTED SKELETON (hard rule 12): this section builds the
 * shipping character mesh (`character/mesh.js`) and drives the real `Animator`,
 * then reads the WORLD matrices of the hips and head bones that three.js will
 * skin the frame from. Nothing asserts on `_seatTilt`, `seatYaw` or any other
 * value the production code set on itself.
 *
 * Every number is DIFFERENTIAL — the same run with the car level minus the same
 * run with the car banked — so it cannot be produced by the seated pose, the
 * bind skeleton or the harness, only by the attitude.
 *
 * The car's transform is SCRIPTED here rather than driven, because the point is
 * a controlled attitude: a flat test track cannot bank a car 14 degrees, and a
 * hill built to do it would make the input a property of the hill.
 */

/** Set false by `--control=tilt`; see CONTROLS. */
let TILT_ON = true;

const _bodyUp = new THREE.Vector3();
const _bodyFwd = new THREE.Vector3();
const _hips = new THREE.Vector3();
const _head = new THREE.Vector3();
const _carUp = new THREE.Vector3();
const _local = new THREE.Vector3();
const _qi = new THREE.Quaternion();

function makeBodyRig() {
  const spec = Object.values(BROTHERS)[0];
  const built = buildCharacter(spec.build, null);
  const rig = {
    root: built.root, bones: built.bones, boneList: built.boneList,
    skeleton: built.skeleton, bindPositions: built.bindPositions, scale: 1, side: 1,
  };
  return { rig, built };
}

/** The pose request `PlayerSystem._buildPose` fills, for a seated driver. */
function seatedPose() {
  return {
    x: 0, y: 0, z: 0, faceYaw: 0, aimYaw: 0, aimPitch: 0,
    speed: 0, grounded: true, crouch: false, aim: 0, swim: false, driving: true,
    stumble: 0, turning: 0, strafe: 0, forwardSign: 1, verticalVel: 0,
    landImpulse: 0, steer: 0, lateral: 0, surface: 'concrete', groundDist: 0,
    swing: 0, swingSide: 1, swingWeight: 0, submerged: 0, dead: 0, guard: 0,
    topSpeed: 6.4, sprinting: false,
  };
}

/**
 * Seat a driver, script the car's attitude, and sample the EMITTED skeleton.
 *
 * `attitude(t)` returns { roll, pitch } in radians. Returns per-frame samples of
 * the world-space hips->head axis, the head's position expressed in the CAR's
 * own frame, and the body's ground-plane facing.
 */
function tiltRun(attitude, { secs = 2.5, type = 'sedan', drive = true } = {}) {
  const rig = makeRig(type);
  if (drive && !seatThePlayer(rig)) return null;
  const { rig: body } = makeBodyRig();
  const ctx = {
    time: rig.time, peek: () => null,
    events: { emit() {}, on() { return () => {}; } },
  };
  const anim = new Animator(ctx, body);
  const pose = seatedPose();
  rig.handler.debugSeatTilt = TILT_ON;

  const v = rig.v;
  const yaw = 0.6;                       // an arbitrary heading, held
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const samples = [];
  const n = Math.round(secs * 60);
  for (let i = 0; i < n; i++) {
    const t = i / 60;
    const a = attitude(t);
    e.set(a.pitch, yaw, a.roll);
    q.setFromEuler(e);
    v.quaternion.copy(q);
    if (v.prevQuaternion) v.prevQuaternion.copy(q);
    if (v.prevPosition) v.prevPosition.copy(v.position);

    rig.time.frame++;
    rig.time.elapsed += FDT;
    rig.handler.update(FDT, rig.m);

    pose.x = rig.m.position.x; pose.y = rig.m.position.y; pose.z = rig.m.position.z;
    pose.faceYaw = rig.m.faceYaw;
    pose.aimYaw = rig.m.faceYaw;
    pose.driving = rig.handler.seated;
    anim.update(FDT, pose);
    rig.handler.applySeatAttitude(body.root);

    // ---- read the EMITTED skeleton ----
    body.bones.hips.updateWorldMatrix(true, false);
    body.bones.head.updateWorldMatrix(true, false);
    _hips.setFromMatrixPosition(body.bones.hips.matrixWorld);
    _head.setFromMatrixPosition(body.bones.head.matrixWorld);
    _bodyUp.copy(_head).sub(_hips).normalize();
    _bodyFwd.set(0, 0, -1).applyQuaternion(body.root.quaternion);
    _carUp.set(0, 1, 0).applyQuaternion(q);
    // The head in the CAR's frame — is he still in the cabin?
    _local.copy(_head).sub(v.position).applyQuaternion(_qi.copy(q).invert());
    samples.push({
      t,
      up: _bodyUp.clone(),
      carUp: _carUp.clone(),
      headLocal: _local.clone(),
      fwdYaw: Math.atan2(-_bodyFwd.x, -_bodyFwd.z),
      carYaw: yaw,
    });
  }
  return { samples, rig };
}

/** Angle between the emitted body axis and the car's up, in degrees. */
const upErrDeg = (s) => Math.acos(clampN(s.up.dot(s.carUp), -1, 1)) * RAD;
const _rollTmp = new THREE.Vector3();
const _rollQ = new THREE.Quaternion();
const _yAxis = new THREE.Vector3(0, 1, 0);
/**
 * Signed roll of the emitted body axis, IN THE CAR'S YAW FRAME. Measuring it
 * against world X instead reads a fraction of the roll set by the heading —
 * 12.41 degrees for a 14-degree bank at a yaw of 0.6 rad — and looks exactly
 * like a filter that is losing the bank.
 */
const rollOf = (s) => {
  _rollTmp.copy(s.up).applyQuaternion(_rollQ.setFromAxisAngle(_yAxis, -s.carYaw));
  return Math.atan2(_rollTmp.x, _rollTmp.y) * RAD;
};

function testTilt() {
  const LEVEL = () => ({ roll: 0, pitch: 0 });
  const BANK = 14 * DEG;
  const NOSE = 12 * DEG;

  const level = tiltRun(LEVEL);
  const bank = tiltRun(() => ({ roll: BANK, pitch: 0 }));
  const nose = tiltRun(() => ({ roll: 0, pitch: NOSE }));
  if (!level || !bank || !nose) {
    rec('tilt.seated', 'attitude', 'the driver could be seated at all', false, 'seating failed');
    return null;
  }
  const last = (r) => r.samples[r.samples.length - 1];

  /**
   * 1. THE BODY IS SQUARE TO THE CAR. Differential: the emitted hips->head axis
   *    tilts by the same angle the car did. `level` carries the seated pose's
   *    own forward lean, and subtracting it is what makes this a statement
   *    about the attitude rather than about the pose.
   */
  const errLevel = upErrDeg(last(level));
  const errBank = upErrDeg(last(bank));
  const errNose = upErrDeg(last(nose));
  rec('tilt.bank', 'attitude', 'the body banks with the car',
    Math.abs(errBank - errLevel) < 1.5,
    `body-to-car-up ${f2(errBank)} deg at ${f2(BANK * RAD)} deg of bank, ` +
    `${f2(errLevel)} deg level (the seated pose's own lean)`);
  rec('tilt.pitch', 'attitude', 'the body pitches with the car',
    Math.abs(errNose - errLevel) < 1.5,
    `body-to-car-up ${f2(errNose)} deg at ${f2(NOSE * RAD)} deg nose-up, ` +
    `${f2(errLevel)} deg level`);

  /**
   * 2. AND THEREFORE HE IS STILL IN THE CABIN. The head expressed in the car's
   *    own frame is what "through the sheet metal" means: a body that does not
   *    bank walks its head sideways out of the roof by the bank angle times the
   *    seat height.
   */
  const dHead = last(bank).headLocal.distanceTo(last(level).headLocal);
  rec('tilt.cabin', 'attitude', 'the head stays where the seat is, in the car\'s frame',
    dHead < 0.03,
    `head moves ${f3(dHead)} m in the car's frame between level and ` +
    `${f2(BANK * RAD)} deg of bank`);

  /**
   * 3. COBBLES DO NOT SHAKE THE HEAD. An 8 Hz, 2-degree chatter on top of a
   *    14-degree bank — a chassis quaternion over tram rails. The filter has to
   *    hold the bank and lose the chatter.
   */
  const CH_HZ = 8, CH_AMP = 2 * DEG;
  const cobble = tiltRun((t) => ({ roll: BANK + Math.sin(t * CH_HZ * Math.PI * 2) * CH_AMP, pitch: 0 }));
  const tail = cobble.samples.filter((s) => s.t > 1.2);
  const rolls = tail.map(rollOf);
  const bodyPP = Math.max(...rolls) - Math.min(...rolls);
  const carPP = 2 * CH_AMP * RAD;
  const mean = rolls.reduce((a, b) => a + b, 0) / rolls.length;
  rec('tilt.cobbles', 'attitude', 'chassis chatter is filtered out of the head',
    bodyPP < carPP * 0.45,
    `${f2(bodyPP)} deg peak-to-peak in the body against ${f2(carPP)} deg in the ` +
    `chassis (${(100 * bodyPP / carPP).toFixed(0)}% through, want < 45%)`);
  rec('tilt.holds', 'attitude', '...without losing the bank underneath it',
    Math.abs(Math.abs(mean) - BANK * RAD) < 1.0,
    `mean body roll ${f2(Math.abs(mean))} deg against a ${f2(BANK * RAD)} deg bank`);

  /**
   * 4. THE YAW IS UNTOUCHED. The tilt is applied in body space precisely so it
   *    cannot rotate the facing — which is what `drivetest`'s "body faces the
   *    way the car faces" gates rest on.
   */
  let worstYaw = 0;
  for (const s of cobble.samples) {
    let d = s.fwdYaw - (s.carYaw + Math.PI);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    worstYaw = Math.max(worstYaw, Math.abs(d) * RAD);
  }
  rec('tilt.yaw', 'attitude', 'banking never rotates the body\'s facing',
    worstYaw < 0.5,
    `worst ${f3(worstYaw)} deg from the car's heading over ${cobble.samples.length} frames`);

  /**
   * 5. IT NEVER LEAKS ONTO A MAN ON FOOT. Same scripted 14-degree bank, nobody
   *    in the car — and compared against the SAME run beside a level car, not
   *    against the seated baseline: a standing body has its own lean and
   *    subtracting the wrong one would report it as leakage.
   */
  const upWorld = new THREE.Vector3(0, 1, 0);
  const footBank = tiltRun(() => ({ roll: BANK, pitch: 0 }), { drive: false });
  const footLevel = tiltRun(LEVEL, { drive: false });
  const footErr = Math.acos(clampN(last(footBank).up.dot(upWorld), -1, 1)) * RAD;
  const footRef = Math.acos(clampN(last(footLevel).up.dot(upWorld), -1, 1)) * RAD;
  rec('tilt.onfoot', 'attitude', 'a man who is not in the car stays upright',
    Math.abs(footErr - footRef) < 0.05,
    `${f3(footErr)} deg off world up beside a car banked ${f2(BANK * RAD)} deg, ` +
    `${f3(footRef)} deg beside a level one (the standing pose's own lean)`);

  return { errLevel, errBank, errNose, dHead, bodyPP, carPP, worstYaw };
}

/* ====================================================================== */
/* 3 + 4. RECOIL AND SHAKE — measured against an identical un-poked rig    */
/* ====================================================================== */

/**
 * Run two rigs in lockstep. One gets the impulse (or the event); the other gets
 * nothing. Every reported number is the DIFFERENCE between the two emitted
 * transforms, so it cannot be produced by anything except the impulse itself.
 */
const QUANT_ROT = 1e-7;
const QUANT_POS = 1e-9;

function impulseRun({ inVehicle, poke, seconds = 3.0, type = 'sports' }) {
  const a = makeRig(type);
  const b = makeRig(type);
  if (inVehicle) {
    if (!seatThePlayer(a) || !seatThePlayer(b)) return null;
    a.input.press('forward'); b.input.press('forward');
    frames(a, 60 * 4); frames(b, 60 * 4);
  } else {
    frames(a, 60 * 2); frames(b, 60 * 2);
  }
  // Prove the pair is lockstep BEFORE the poke, or every later delta is noise.
  const drift = a.cam.position.distanceTo(b.cam.position) +
    a.cam.quaternion.angleTo(b.cam.quaternion);

  poke(a);

  let rot = 0, pos = 0, peakRot = 0, peakPos = 0, tail = 0;
  const n = Math.round(seconds * 60);
  const tailFrom = Math.round(1.5 * 60);
  for (let i = 0; i < n; i++) {
    frame(a); frame(b);
    let dr = a.cam.quaternion.angleTo(b.cam.quaternion);
    let dp = a.cam.position.distanceTo(b.cam.position);
    // `angleTo` is 2*acos(|dot|), and for two BIT-IDENTICAL unit quaternions
    // the dot falls an ulp short of 1, so it floors at ~1.4e-8 rad rather than
    // at zero. Quantise below that: 1e-7 rad is 6e-6 degrees, four orders
    // under the smallest real signal here (the cop ram, 4.7e-4 rad) and one
    // order over the noise. `kick.lockstep` is what proves both bounds.
    if (dr < QUANT_ROT) dr = 0;
    if (dp < QUANT_POS) dp = 0;
    rot += dr * FDT;
    pos += dp * FDT;
    if (dr > peakRot) peakRot = dr;
    if (dp > peakPos) peakPos = dp;
    if (i >= tailFrom) tail += dr * FDT;
  }
  return { drift, rot, pos, peakRot, peakPos, tail, head: rot - tail };
}

/**
 * The three shots are `src/weapons/lib.js`'s OWN numbers, composed the way
 * `weapons/index.js` composes them for the player:
 *
 *   p.addRecoil(pitch * body, yaw * body, roll * 0.35, punch)
 *
 * Using real values rather than round invented ones matters: the per-shot
 * camera climb in this game is a quarter of a degree for a pistol, and a gate
 * written around a made-up 2.4 degrees would pass on a build where the real
 * path had been scaled to nothing.
 */
const SHOTS = {
  pistol: { pitch: 0.0062, yaw: 0.0021, roll: 0.02, punch: 0.22, body: 0.7 },
  smg: { pitch: 0.0072, yaw: 0.0031, roll: 0.02, punch: 0.26, body: 0.85 },
  shotgun: { pitch: 0.016, yaw: 0.004, roll: 0.02, punch: 0.55, body: 1.35 },
};
const fire = (s) => (r) =>
  r.cam.addRecoil(s.pitch * s.body, s.yaw * s.body, s.roll * 0.35, s.punch);
/** The angle the weapon actually asked the camera to climb, radians. */
const askedPitch = (s) => s.pitch * s.body;

function crashPayload(rig, { hitVehicle, impulse, at = null }) {
  const other = hitVehicle
    ? { velocity: new THREE.Vector3(), spec: { id: 'sedan' }, mass: 1400 }
    : { geometry: {}, isMesh: true };
  return {
    vehicle: rig.v,
    other,
    point: at ?? rig.v.position.clone(),
    normal: new THREE.Vector3(0, 0, -1),
    impulse,
    speed: rig.v.speed,
    damage: 20,
  };
}

function testRecoil() {
  /* --- the harness's own control: two untouched rigs must not diverge --- */
  const nul = impulseRun({ inVehicle: true, poke: () => {} });
  rec('kick.lockstep', 'recoil', 'the paired rigs are bit-identical without a poke',
    nul && nul.drift < 1e-9 && nul.rot === 0 && nul.pos === 0,
    nul ? `pre-drift ${nul.drift.toExponential(1)}, integral ${nul.rot.toExponential(1)} rad.s` : 'run failed');

  /**
   * The bar is a RELATION, not a round number: the emitted camera must climb by
   * most of the angle the weapon asked for. A gate written as "> 1.8 degrees"
   * would have been satisfied by any large-enough kick and blind to the real
   * per-shot value being a quarter of a degree.
   */
  const want = askedPitch(SHOTS.shotgun) * 0.6;

  /* --- on foot. This path already worked; the gate is here so it cannot ---
   * stop working silently. */
  const foot = impulseRun({ inVehicle: false, poke: fire(SHOTS.shotgun) });
  rec('kick.foot', 'recoil', 'a shot rotates the emitted on-foot camera',
    foot && foot.peakRot > want,
    foot ? `peak ${f3(foot.peakRot * RAD)}deg of ${f3(askedPitch(SHOTS.shotgun) * RAD)}deg asked ` +
      `(want > 60%), integral ${f3(foot.rot * RAD)}deg.s` : 'run failed');

  /* --- in a car --------------------------------------------------------- */
  const car = impulseRun({ inVehicle: true, poke: fire(SHOTS.shotgun) });
  rec('kick.chase', 'recoil', 'a shot rotates the emitted chase camera too',
    car && car.peakRot > want,
    car ? `peak ${f3(car.peakRot * RAD)}deg of ${f3(askedPitch(SHOTS.shotgun) * RAD)}deg asked ` +
      `(want > 60%), integral ${f3(car.rot * RAD)}deg.s` : 'run failed');
  rec('kick.punch', 'recoil', 'the punch shoves the chase boom, not just the boom on foot',
    car && car.peakPos > 0.01,
    car ? `peak ${f3(car.peakPos * 100)} cm of boom travel on a 0.55 punch (want > 1 cm)` : 'run failed');

  /**
   * THE ONE THAT WAS ACTUALLY BROKEN. `addKick` with no pitch component: the
   * chase solver used to compose `kickPitch` only, so a pure yaw/roll kick —
   * a melee stagger, a shotgun's roll — moved the published `viewKick` and
   * left the emitted camera exactly where it was.
   */
  const yawOnly = impulseRun({
    inVehicle: true,
    poke: (r) => r.cam.addKick(0, 1.6 * DEG, 1.6 * DEG),
  });
  rec('kick.yawroll', 'recoil', 'a pitch-free kick still moves the chase camera',
    yawOnly && yawOnly.peakRot * RAD > 0.9,
    yawOnly ? `peak ${f2(yawOnly.peakRot * RAD)}deg (want > 0.9; the old chase composition gave 0)` : 'run failed');

  /* --- decays ----------------------------------------------------------- */
  rec('kick.decay', 'recoil', 'recoil decays away rather than parking the camera',
    car && car.tail < car.head * 0.02,
    car ? `after 1.5 s: ${f3(car.tail * RAD)}deg.s vs ${f3(car.head * RAD)}deg.s before (want < 2%)` : 'run failed');

  /* --- and orders by magnitude, with margin ----------------------------- */
  const order = ['pistol', 'smg', 'shotgun'];
  const mags = order.map((id) => impulseRun({
    inVehicle: false, seconds: 2.0, poke: fire(SHOTS[id]),
  }));
  const ok = mags.every(Boolean) &&
    mags[1].rot > mags[0].rot * 1.06 && mags[2].rot > mags[1].rot * 1.06;
  rec('kick.order', 'recoil', 'bigger recoil = bigger emitted camera travel (>6% each step)', ok,
    mags.every(Boolean)
      ? mags.map((m, i) => `${order[i]}:${f3(m.rot * RAD)}`).join('  ') + ' deg.s'
      : 'run failed');

  return { foot, car, yawOnly };
}

function testShake() {
  // `police.applyRam` puts the contact point on the quarry's near flank, so the
  // payload position travels with the car — it is not a fixed world point.
  const ram = impulseRun({
    inVehicle: true,
    poke: (r) => r.ctx.events.emit('camera:shake',
      { amount: 0.25, position: r.v.position.clone() }),
  });
  const bld = impulseRun({
    inVehicle: true,
    poke: (r) => r.ctx.events.emit('vehicle:collision',
      crashPayload(r, { hitVehicle: false, impulse: r.v.mass * 6 })),
  });
  const veh = impulseRun({
    inVehicle: true,
    poke: (r) => r.ctx.events.emit('vehicle:collision',
      crashPayload(r, { hitVehicle: true, impulse: r.v.mass * 6 })),
  });

  const shakes = (r) => r && r.peakRot * RAD > 0.04 && r.peakPos > 5e-4;
  const shown = (r) => r
    ? `peak ${f3(r.peakRot * RAD)}deg / ${f2(r.peakPos * 1000)} mm, ` +
      `integral ${f3(r.rot * RAD)}deg.s`
    : 'run failed';
  rec('shake.ram', 'shake', 'the scripted cop ram now shakes the camera', shakes(ram), shown(ram));
  rec('shake.building', 'shake', 'hitting a building shakes the camera', shakes(bld), shown(bld));
  rec('shake.vehicle', 'shake', 'hitting another vehicle shakes the camera', shakes(veh), shown(veh));

  /* --- the authored ordering: building .3 > ram .25 > vehicle .2 -------- */
  const ordered = bld && ram && veh &&
    bld.rot > ram.rot * 1.06 && ram.rot > veh.rot * 1.06;
  rec('shake.order', 'shake', 'building > ram > vehicle, by more than 6%', !!ordered,
    bld && ram && veh
      ? `building ${f3(bld.rot * RAD)}  ram ${f3(ram.rot * RAD)}  vehicle ${f3(veh.rot * RAD)} deg.s ` +
        `(trauma .30 / .25 / .20)`
      : 'run failed');

  /* --- severity: a scrape is not a crash -------------------------------- */
  const scrape = impulseRun({
    inVehicle: true,
    seconds: 1.0,
    poke: (r) => r.ctx.events.emit('vehicle:collision',
      crashPayload(r, { hitVehicle: false, impulse: r.v.mass * 0.8 })),
  });
  rec('shake.severity', 'shake', 'a sub-threshold nudge produces no shake at all',
    scrape && scrape.rot === 0 && scrape.pos === 0,
    scrape ? `dv 0.8 m/s -> ${scrape.rot.toExponential(1)} rad.s (want exactly 0)` : 'run failed');

  /* --- somebody else's crash, across the street ------------------------- */
  const remote = impulseRun({
    inVehicle: true,
    seconds: 1.0,
    poke: (r) => {
      const other = makeRig('sedan');
      r.ctx.events.emit('vehicle:collision', {
        vehicle: other.v,
        other: { geometry: {}, isMesh: true },
        point: new THREE.Vector3(0, 1, 400),
        normal: new THREE.Vector3(0, 0, -1),
        impulse: other.v.mass * 6,
        speed: 20,
        damage: 20,
      });
    },
  });
  rec('shake.remote', 'shake', 'a crash 400 m away does not shake your camera',
    remote && remote.rot === 0,
    remote ? `${remote.rot.toExponential(1)} rad.s (want exactly 0)` : 'run failed');

  /**
   * ...and one you are standing next to. `other` is null when a car hits city
   * geometry with no mesh behind it, and on foot `this.vehicle` is null too, so
   * the "don't count a shunt twice" guard has to be careful not to read
   * `null === null` as "that was this rig's own collision".
   */
  const onFoot = impulseRun({
    inVehicle: false,
    seconds: 1.5,
    poke: (r) => {
      const other = makeRig('sedan');
      other.v.setPose(new THREE.Vector3(0, 0.6, 6), 0);
      r.ctx.events.emit('vehicle:collision', {
        vehicle: other.v,
        other: null,
        point: new THREE.Vector3(0, 1, 6),
        normal: new THREE.Vector3(0, 0, -1),
        impulse: other.v.mass * 6,
        speed: 20,
        damage: 20,
      });
    },
  });
  rec('shake.onfoot', 'shake', 'a car piling into a wall six metres away shakes you on foot',
    onFoot && onFoot.peakRot * RAD > 0.02,
    onFoot ? `peak ${f3(onFoot.peakRot * RAD)}deg, integral ${f3(onFoot.rot * RAD)}deg.s` : 'run failed');

  /* --- decay ------------------------------------------------------------ */
  rec('shake.decay', 'shake', 'trauma decays to nothing well inside 1.5 s',
    bld && bld.tail === 0,
    bld ? `integral after 1.5 s = ${bld.tail.toExponential(1)} rad.s (want exactly 0)` : 'run failed');

  /* --- and you can still aim through it --------------------------------- */
  const worstPeak = Math.max(...[ram, bld, veh].filter(Boolean).map((x) => x.peakRot)) * RAD;
  rec('shake.aimable', 'shake', 'the worst crash shake never moves the reticle far enough to miss',
    worstPeak < 1.5,
    `worst peak ${f3(worstPeak)}deg (want < 1.5; a torso at 20 m subtends ~1.4deg)`);

  return { ram, bld, veh };
}

/* ====================================================================== */
/* LOOK — how far up a man on foot can put the reticle, and what it costs  */
/* ====================================================================== */

/**
 * "cannot shoot at police helicopter while on foot — the view range is limited
 * and cannot aim that high."
 *
 * The heli orbits at 40-80 m, i.e. 50-70 degrees above the horizon at the
 * ranges you fight it from, and the ceiling was +34 deg. `weapons` fires down
 * the CAMERA axis (`weapons/index.js`, "aim: camera forward + the spread
 * cone"), so the reticle and the rounds hit the same wall at the same angle:
 * raising the clamp is the whole of the fire-direction fix, and the tuck in
 * `CAMERA.highLook` is what makes the raised clamp survivable.
 *
 * WHAT IS MEASURED (rule 12). Every number below comes off `cam.position` and
 * `cam.quaternion` after the rig has been driven through `addLook` — the same
 * entry point a mouse uses — and off a ground plane the boom can really be
 * stopped by. Nothing reads `pitchTarget`, `highLookT`, `distIdeal` or any
 * other value the solver assigned itself; the elevation is `asin(forward.y)`
 * of the emitted quaternion and the clearance is an angle between two emitted
 * vectors. A build that clamped the pitch and then lied about it in
 * `pitchTarget` would fail every row here.
 *
 * What would make each fail:
 *   look.reach   the ceiling back under a heli's elevation (the shipped +34).
 *   look.clear   the character's head inside the reticle's cone — the failure
 *                mode of raising the clamp WITHOUT the tuck, and the reason
 *                +34 was chosen in the first place.
 *   look.ground  the boom digging into the pavement at any angle.
 *   look.noflip  the rig inverting, or the emitted elevation not tracking the
 *                request monotonically.
 *   look.body    the lens ending up inside the character's head.
 *   look.inert   ANY framing under the knee moving by a micron. This is the
 *                claim that the change cannot regress a shot the game already
 *                takes, and it is checked against the emitted position of a
 *                second rig with the fix switched off.
 */

/** Flipped by `--control=look`; the rigs below read it when they are built. */
let HIGH_LOOK = true;

/**
 * The camtest world is open sky (`fakePhysics.sphereCast` never hits), which is
 * right for framing and wrong here — half of what the ceiling protects is the
 * boom hitting the ground. This is the same flat plane the rest of the file
 * uses for the raycast, given to the sphere cast.
 */
const groundPhysics = {
  ...fakePhysics,
  sphereCast(origin, dir, radius, maxDist) {
    if (dir.y >= -1e-6) return { hit: false, distance: Infinity };
    const t = (origin.y - radius) / -dir.y;
    if (t < 0 || t > maxDist) return { hit: false, distance: Infinity };
    return { hit: true, distance: t };
  },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const _lookFwd = new THREE.Vector3();
const _lookUp = new THREE.Vector3();
const _lookHead = new THREE.Vector3();
const _lookToHead = new THREE.Vector3();

/**
 * Drive the orbit up to `deg` through the real look path and read the pose.
 *
 * `head` is the top of the skull relative to the pivot the camera actually
 * uses: `STANCE.stand.anchor` is the base of the neck and the crown sits about
 * 0.2 m above it (`UNITS.playerHeight` 1.78 against a 1.44 anchor leaves 0.34;
 * 0.2 is the conservative half of that, so the clearance gate is measured
 * against a point higher than the head really reaches).
 */
function lookAt(deg, { view = 0, aim = false, high = null } = {}) {
  const rig = makeCamRig(groundPhysics);
  rig.cam.highLook = high === null ? HIGH_LOOK : high;
  if (view) rig.cam.setView(view);
  if (aim) { rig.m.adsAmount = 1; rig.m.aiming = true; }
  camFrames(rig, 90);
  // A mouse delta at a time, exactly as `player._updateLook` feeds it.
  for (let i = 0; i < 500; i++) {
    rig.cam.addLook(0, 0.02);
    camFrames(rig, 1);
    if (rig.cam.pitch * RAD >= deg - 0.05) break;
  }
  camFrames(rig, 120); // let every filtered channel settle
  const p = rig.cam.position;
  _lookFwd.set(0, 0, -1).applyQuaternion(rig.cam.quaternion);
  _lookUp.set(0, 1, 0).applyQuaternion(rig.cam.quaternion);
  _lookHead.set(rig.m.position.x, rig.m.position.y + STANCE.stand.anchor + 0.2, rig.m.position.z);
  _lookToHead.subVectors(_lookHead, p);
  const dHead = _lookToHead.length();
  _lookToHead.multiplyScalar(1 / Math.max(1e-6, dHead));
  return {
    ask: deg,
    /** The orbit angle the rig settled on — used to prove two runs match. */
    pitch: rig.cam.pitch * RAD,
    elev: Math.asin(clamp(_lookFwd.y, -1, 1)) * RAD,
    camY: p.y,
    dHead,
    offAxis: Math.acos(clamp(_lookToHead.dot(_lookFwd), -1, 1)) * RAD,
    upY: _lookUp.y,
    pos: p.clone(),
  };
}

/**
 * A police helicopter's elevation from a man standing under it. The orbit
 * radius and altitude are the police system's business; these are the two ends
 * of the band it flies, and the shallowest of them is what the ceiling has to
 * clear.
 */
const HELI_ELEV = 60;

function testLook() {
  const SWEEP = [0, 10, 20, 30, 34, 40, 45, 50, 55, 60, 66, 70, 74];
  const chase = SWEEP.map((d) => lookAt(d));
  const far = SWEEP.map((d) => lookAt(d, { view: 2 }));
  const ads = SWEEP.map((d) => lookAt(d, { aim: true }));

  const top = (rows) => rows[rows.length - 1];
  const ceil = { chase: top(chase), close: top(SWEEP.slice(-1).map((d) => lookAt(d, { view: 1 }))), far: top(far) };

  /* --- 1. can the reticle reach a helicopter at all? -------------------- */
  const reach = ceil.chase.elev >= HELI_ELEV && ceil.close.elev >= HELI_ELEV &&
    ceil.far.elev >= HELI_ELEV - 6;
  rec('look.reach', 'look',
    `on foot the reticle reaches ${HELI_ELEV} deg — a police heli is targetable`,
    reach,
    `emitted elevation at the ceiling: chase ${f2(ceil.chase.elev)}, close ${f2(ceil.close.elev)}, ` +
    `far ${f2(ceil.far.elev)} deg (want >= ${HELI_ELEV}, far >= ${HELI_ELEV - 6})`);

  /* --- 2. ...with the reticle on sky rather than on your own skull ------ */
  const above = chase.filter((r) => r.ask >= 34);
  const clearAtTop = ceil.chase.offAxis;
  let monotone = true;
  for (let i = 1; i < above.length; i++) if (above[i].offAxis < above[i - 1].offAxis - 0.5) monotone = false;
  rec('look.clear', 'look',
    'the character never comes within 25 deg of the reticle, and clears it further the higher you look',
    clearAtTop >= 25 && monotone && ceil.far.offAxis >= 25,
    `head-to-reticle at the ceiling: chase ${f2(clearAtTop)} deg, far ${f2(ceil.far.offAxis)} deg; ` +
    `above the knee ${above.map((r) => f2(r.offAxis)).join(' -> ')} deg` +
    (monotone ? '' : ' — NOT monotone'));

  /* --- 3. the boom does not dig -------------------------------------- */
  /* The floor is compared against THE SHIPPED BUILD'S OWN FLOOR rather than
   * against a number somebody liked: the boom already skims the pavement in the
   * 20-34 deg band (the far view bottoms out at 0.33 m and always has), so an
   * absolute bar here would either be a pass by construction or a red for a
   * behaviour this change did not introduce. What must be true is that the
   * angles the fix ADDS never dig deeper than the angles the game already had. */
  const all = [...chase, ...far, ...ads];
  const lowest = all.reduce((a, b) => (b.camY < a.camY ? b : a));
  const shippedFloor = [0, 10, 20, 30, 34]
    .flatMap((d) => [lookAt(d, { high: false }), lookAt(d, { view: 2, high: false })])
    .reduce((a, b) => Math.min(a, b.camY), Infinity);
  const climbs = ceil.chase.camY >= 1.0 && ceil.far.camY >= 0.8;
  rec('look.ground', 'look',
    'the extra elevation never puts the boom lower than the shipped build already does, and it climbs back to chest height at the ceiling',
    lowest.camY >= shippedFloor - 1e-6 && climbs,
    `lowest emitted camera ${f2(lowest.camY)} m (at ${lowest.ask} deg) against the shipped ` +
    `floor ${f2(shippedFloor)} m · at the ceiling chase ${f2(ceil.chase.camY)} m, far ${f2(ceil.far.camY)} m`);

  /* --- 4. no inversion, and the lens tracks the request ----------------- */
  const upright = all.every((r) => r.upY > 0.05);
  let tracks = true;
  // 0.25 deg of slack: the two rows past the ceiling both settle ON the clamp
  // and differ by the last hundredth of the orbit filter, not by a direction.
  for (let i = 1; i < chase.length; i++) if (chase[i].elev < chase[i - 1].elev - 0.25) tracks = false;
  rec('look.noflip', 'look',
    'the rig never inverts and the emitted elevation never goes backwards',
    upright && tracks,
    `min emitted up.y ${f3(Math.min(...all.map((r) => r.upY)))} (want > 0.05) · ` +
    `chase elevation ${chase.map((r) => f2(r.elev)).join(' -> ')} deg`);

  /* --- 5. and never ends up inside him --------------------------------- */
  const nearest = all.reduce((a, b) => (b.dHead < a.dHead ? b : a));
  rec('look.body', 'look',
    'the lens never ends up inside the character, in any view, aiming or not',
    nearest.dHead >= 0.6,
    `closest emitted approach to the crown ${f2(nearest.dHead)} m (want >= 0.6; ` +
    `the character fades out under ${f2(CAMERA.collide.fadeEnd)} m)`);

  /* --- 6. INERT below the knee ----------------------------------------- */
  /* The strongest thing this family asserts: every framing the game already
   * ships is under 34 deg, so with the fix ON and OFF the emitted camera has to
   * be the same point to the micron. Both rigs are built with an explicit flag
   * so `--control=look` cannot make this row pass by turning the fix off. */
  let worst = 0;
  let worstAt = 0;
  let sameOrbit = true;
  // Asks, not emitted angles: the orbit filter overshoots the ask by about
  // 2 deg, so 30 is the highest request that still settles under the 34 the
  // reverted rig would clamp at (measured 32.08).
  for (const d of [0, 10, 20, 30]) {
    const on = lookAt(d, { high: true });
    const off = lookAt(d, { high: false });
    // Both rigs must have taken the SAME orbit angle, or the comparison is
    // between two different shots. (Ask for 34 and they do not: the reverted
    // rig clamps at 34.00 while the fixed one settles at 35.53, which is the
    // fix working rather than a framing moving.)
    if (Math.abs(on.pitch - off.pitch) > 1e-9) sameOrbit = false;
    const e = on.pos.distanceTo(off.pos);
    if (e > worst) { worst = e; worstAt = d; }
  }
  rec('look.inert', 'look',
    'below the knee the change moves the camera by nothing at all',
    worst < 1e-6 && sameOrbit,
    `worst emitted position difference with the fix on vs off, 0-33 deg: ` +
    `${worst.toExponential(1)} m at ${worstAt} deg (want < 1e-6)` +
    (sameOrbit ? '' : ' — THE TWO RIGS TOOK DIFFERENT ORBIT ANGLES'));

  return { chase, far, ads, ceil };
}

/* ====================================================================== */
/* NEGATIVE CONTROLS — revert the behaviour, confirm the gates go red      */
/* ====================================================================== */

/**
 * Each control restores the code to its state before this change and names the
 * gates that must fail. If a gate stays green with its behaviour reverted, the
 * gate is decorative and the number it prints means nothing.
 */
const CONTROLS = {
  align: {
    what: 'constant-rate re-centre (the old flat 0.45 s approach after a 1.1 s hold)',
    expect: ['align.monotone', 'align.slow'],
    run: testAlign,
    apply() {
      const A = CHASE.align;
      const s = { ...A };
      A.perSpeed = 0;
      A.floor = 1 / 0.45;
      A.rateMax = 1 / 0.45;
      A.suppress = 1.1;
      A.ease = 1e-4;
      return () => Object.assign(A, s);
    },
  },
  suppress: {
    what: 'no suppression while the look control is live',
    expect: ['align.drag'],
    run: testAlign,
    apply() {
      const A = CHASE.align;
      const s = { suppress: A.suppress, ease: A.ease };
      A.suppress = 0;
      A.ease = 1e-4;
      return () => Object.assign(A, s);
    },
  },
  frame: {
    what: 'one framing for every vehicle class',
    expect: ['frame.order', 'frame.bus', 'frame.heli'],
    run: testFraming,
    apply() {
      const F = CHASE.classFrame;
      const s = { bus: { ...F.bus }, heli: { ...F.heli } };
      F.bus = { ...F.car };
      F.heli = { ...F.car };
      return () => { F.bus = s.bus; F.heli = s.heli; };
    },
  },
  flight: {
    what: 'every fixed-wing on the car chase camera again (the old tag test)',
    expect: [
      'flight.frame', 'flight.order', 'flight.shipping',
      'flight.altitude', 'flight.climbgain', 'flight.nosnap', 'flight.lag',
    ],
    run: testFlight,
    apply() {
      const s = { ...EXTRA_FRAMES.plane };
      // Exactly what `_resolveFrame` did before: no `plane` class at all, so
      // the lookup falls through to the car framing and `flight` is never set.
      delete EXTRA_FRAMES.plane;
      return () => { EXTRA_FRAMES.plane = s; };
    },
  },
  tilt: {
    what: 'the seated body upright in world space whatever the car is doing',
    expect: ['tilt.bank', 'tilt.pitch', 'tilt.cabin', 'tilt.holds'],
    run: testTilt,
    apply() {
      TILT_ON = false;
      return () => { TILT_ON = true; };
    },
  },
  kick: {
    what: 'the old partial chase composition (kickPitch only, no rotational shake)',
    expect: ['kick.yawroll', 'kick.punch', 'shake.ram', 'shake.building', 'shake.vehicle'],
    run: () => { testRecoil(); testShake(); },
    apply() {
      const s = CHASE.fullKick;
      CHASE.fullKick = false;
      return () => { CHASE.fullKick = s; };
    },
  },
  look: {
    what: 'the +34 deg third-person ceiling and the untucked boom (the build that could not aim at a heli)',
    expect: ['look.reach', 'look.clear'],
    run: testLook,
    apply() {
      HIGH_LOOK = false;
      return () => { HIGH_LOOK = true; };
    },
  },
  shake: {
    what: 'no crash trauma at all (nothing listening, as before)',
    expect: ['shake.ram', 'shake.building', 'shake.vehicle', 'shake.order', 'shake.onfoot'],
    run: testShake,
    apply() {
      const C = CAMERA.crash;
      const s = { building: C.building, vehicle: C.vehicle, shakeScale: C.shakeScale };
      C.building = 0;
      C.vehicle = 0;
      C.shakeScale = 0;
      return () => Object.assign(C, s);
    },
  },
};

function runControl(name) {
  const c = CONTROLS[name];
  const restore = c.apply();
  const saved = OUT;
  OUT = [];
  try { c.run(); } finally { restore(); }
  const got = OUT;
  OUT = saved;
  const red = new Set(got.filter((r) => !r.ok).map((r) => r.id));
  const missed = c.expect.filter((id) => !red.has(id));
  return { name, c, got, red, missed, ok: missed.length === 0 };
}

/* ====================================================================== */
/* main                                                                   */
/* ====================================================================== */

function report(rows) {
  let pass = 0;
  let area = null;
  for (const r of rows) {
    if (r.area !== area) { area = r.area; console.log(`\n  ${area.toUpperCase()}`); }
    if (r.ok) pass++;
    console.log(`  ${r.ok ? ' ok ' : 'FAIL'}  ${r.name}\n          ${r.detail}`);
  }
  return pass;
}

function main() {
  if (args.control) {
    const c = CONTROLS[args.control];
    if (!c) { console.error(`unknown control "${args.control}"`); process.exit(2); }
    const res = runControl(args.control);
    console.log(`\nNEGATIVE CONTROL "${args.control}" — ${c.what}`);
    report(res.got);
    console.log(res.ok
      ? `\n  control OK: ${c.expect.join(', ')} all went red.\n`
      : `\n  CONTROL FAILED: still green with the fix reverted -> ${res.missed.join(', ')}\n`);
    process.exit(res.ok ? 0 : 1);
  }

  console.log('\nCAMERA FEEL TEST — every assertion reads the emitted camera transform\n');
  const align = testAlign();
  testFraming();
  const real = testFramingReal();
  testFlight();
  testTilt();
  testRecoil();
  testShake();
  const look = testLook();

  const pass = report(OUT);

  if (align && (VERBOSE || true)) {
    console.log('\n  ALIGN CONVERGENCE DISTRIBUTION (50 deg offset, look released at t=0)');
    console.log('   speed    err@0.5s  err@1.0s  err@2.0s  err@2.5s   t(half)   p50    p90');
    const at = (r, t) => r.series[Math.min(r.series.length - 1, Math.round(t * 60) - 1)].err;
    for (const { s, r } of align.runs) {
      console.log(
        `   ${String(s).padStart(2)} m/s  ` +
        `${f2(at(r, 0.5)).padStart(8)}  ${f2(at(r, 1.0)).padStart(8)}  ` +
        `${f2(at(r, 2.0)).padStart(8)}  ${f2(at(r, 2.5)).padStart(8)}  ` +
        `${f2(r.halfLife).padStart(7)}  ${f2(r.p50).padStart(5)}  ${f2(r.p90).padStart(5)}`
      );
    }
    if (align.drag) {
      const r = align.drag;
      console.log(
        '   DRAG   ' +
        `${f2(at(r, 0.5)).padStart(8)}  ${f2(at(r, 1.0)).padStart(8)}  ` +
        `${f2(at(r, 2.0)).padStart(8)}  ${f2(at(r, 2.5)).padStart(8)}  ` +
        `${f2(r.halfLife).padStart(7)}  ${f2(r.p50).padStart(5)}  ${f2(r.p90).padStart(5)}` +
        '   <- look held down throughout'
      );
    }
  }

  console.log('\n  ON-FOOT ELEVATION (chase view, over a flat pavement)');
  console.log('   asked   emitted    camera Y   head off   boom-to-head');
  for (const r of look.chase) {
    console.log(
      `   ${String(r.ask).padStart(3)}deg  ${f2(r.elev).padStart(7)}deg  ` +
      `${f2(r.camY).padStart(8)} m  ${f2(r.offAxis).padStart(7)}deg  ${f2(r.dHead).padStart(9)} m`
    );
  }

  console.log('\n  SHIPPING FRAMING (camera-to-vehicle distance, at rest, open sky)');
  for (const g of real) {
    const h = g.spec.half;
    console.log(`   ${g.id.padEnd(7)} ${f2(g.dist).padStart(6)} m   class ${g.cls.padEnd(5)}` +
      `  body ${f2(h.z * 2)} x ${f2(h.y * 2)} m`);
  }

  let ctlOk = true;
  if (!args.nocontrols) {
    console.log('\n  NEGATIVE CONTROLS');
    for (const name of Object.keys(CONTROLS)) {
      const res = runControl(name);
      if (!res.ok) ctlOk = false;
      console.log(`  ${res.ok ? ' ok ' : 'FAIL'}  --control=${name}: ${res.c.what}`);
      console.log(`          expected red: ${res.c.expect.join(', ')}` +
        (res.ok ? ' — all red' : ` — STILL GREEN: ${res.missed.join(', ')}`));
    }
  }

  console.log(`\n  ${pass}/${OUT.length} camera gates` +
    (ctlOk ? ' · all negative controls went red\n' : ' · A NEGATIVE CONTROL DID NOT GO RED\n'));
  process.exit(pass === OUT.length && ctlOk ? 0 : 1);
}

main();
