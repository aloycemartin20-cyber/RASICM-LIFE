#!/usr/bin/env node
/**
 * ROLL PROBE — "the car flipped over on a corner", as a number.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS EXISTS FOR
 * ────────────────────────────────────────────────────────────────────────────
 * Holding W and A at road speed rolled the car onto its roof. Not on a kerb,
 * not off a jump — on FLAT ASPHALT, with nothing but the throttle and the
 * steering. MEASURED here on the build before `_rollAssist`, peak absolute
 * bank over a 6 s turn entered at 110 km/h, full lock held:
 *
 *     suv 108   pickup 105   van 97   truck 96   degrees
 *
 * — every one of them past 90, i.e. on its roof. A SEDAN took 111 degrees from
 * the same corner plus a single 1 rad/s roll disturbance, which is what a kerb
 * strike mid-corner is. Once the inside pair lifts, an unloaded spring pushes
 * with zero force and gravity's restoring arm SHRINKS as the bank grows, so
 * the divergence is one-way and nothing in the model opposes it.
 *
 * `_rollAssist` in `dynamics.js` is the fix and this file is its bench.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THE YAW AXIS WAS AND WAS NOT WORTH — read this before re-litigating it
 * ────────────────────────────────────────────────────────────────────────────
 * The rollover was reported as a consequence of `_stepWheels`'s yaw stabiliser
 * and spin recovery building their torque about the BODY's up axis, with a
 * claimed 158 -> 12 degrees from projecting it onto the vertical. The axis was
 * indeed wrong — a tyre's yaw moment acts about the CONTACT NORMAL, and
 * `dynamics.js` now builds both torques about that — but the A/B does not
 * reproduce and the claim should not be repeated. MEASURED, this bench, both
 * axes, muscle, on the flat and on 8 / 14 / 20 degree slopes, with and without
 * a 1.5 rad/s kerb strike: 16 runs, the two arms agree to within 1 degree
 * everywhere (9/9, 11/11, 15/15, 14/14, 20/20, 19/19, 25/25, 25/25). The
 * rollover is a ROLL-axis problem and is fixed on the roll axis.
 *
 * `debugBodyYaw` is the live hook for re-running that A/B with no edit.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS ASSERTED, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 * ────────────────────────────────────────────────────────────────────────────
 * Every number below is read off the EMITTED body quaternion — the pose the
 * renderer draws — never off a torque, a gain, a steer angle or an input:
 *
 *   BANK      `atan2(right.y, up.y)` of the emitted basis, sampled every one
 *             of the 720 steps of the turn, peak absolute value.
 *   UP        the emitted `up.y`. A car that has been on its roof at any point
 *             in the run has had `up.y < 0`, whatever it does afterwards.
 *   HEADING   the stabiliser still has to WORK: the same run must produce a
 *             real change of emitted heading, or "it does not roll" would be
 *             satisfied by a car that does not turn.
 *   RIGHTING  the emitted `up.y` of a vehicle dropped on its roof, after a
 *             fixed number of seconds of nothing but `_rightSelf`.
 *
 * NEGATIVE CONTROLS, both against the LIVE code with no edit —
 * `debugNoRollAssist` disarms the roll stability and `debugNoRight` the
 * righting. If either arm stayed green the assertion above it would be
 * measuring the harness, not the fix.
 *
 * The CROSS-SLOPE section is the other half of the roll assist's claim: a car
 * driving along a 20 degree side slope is banked 20 degrees with respect to
 * the world and is not tipping over at all. A world-referenced assist would
 * fight it — Pittsburgh is hills — so the angle is taken against the wheels'
 * own contact normals, and this section is what says so.
 *
 *   node src/vehicles/rollprobe.mjs
 *   node src/vehicles/rollprobe.mjs --verbose
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP } from './specs.js';
import { Vehicle } from './dynamics.js';

const DT = 1 / 120;
const DEG = 180 / Math.PI;
const VERBOSE = process.argv.includes('--verbose');

/** The classes the report named, plus the rest of the road fleet. */
const CORNERING = ['muscle', 'police', 'sports'];
const FLEET = ['muscle', 'police', 'sports', 'sedan', 'suv', 'pickup', 'van', 'truck'];
/** Entry speed for the cornering bench, km/h — the speed the report named. */
const ENTRY_KMH = 110;
/** Peak bank a flat-ground corner may reach, degrees. */
const BANK_LIMIT = 25;

let pass = 0;
let fail = 0;
const fails = [];
function check(section, label, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(`${section}: ${label} — ${detail}`); }
  if (!ok || VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  [${section}] ${label}  (${detail})`);
}

/* ------------------------------------------------------------------ */
/* A flat plane of one surface — the same shape drivetest uses.        */
/* ------------------------------------------------------------------ */
/**
 * The plane is ONE-SIDED and it carries a real `staticWorld`, and both of those
 * are load-bearing for what this file measures:
 *
 *   ONE-SIDED   a two-sided plane catches an inverted car's wheel rays FROM
 *               UNDERNEATH — the ray is cast along the body's own -up, which
 *               points at the sky when the car is on its roof — so a car that
 *               had fallen through the floor hung off it by four wheels and
 *               "righted itself" with no code doing anything at all. Every
 *               righting number taken on a two-sided plane is that artefact.
 *   staticWorld the chassis probe ring in `_collide` is what a leaning car
 *               actually lands ON, and the impulse it takes there is part of
 *               whether a lean becomes a roll. Without it a car past 45 deg of
 *               bank simply pivots in mid-air about its outer tyres.
 */
function makeWorld(surface = 'asphalt', crossDeg = 0) {
  // A CROSS slope: the fall line runs along x, so a car driving along z is
  // banked `crossDeg` with respect to the WORLD while sitting square on the
  // surface. That is the case that separates a ground-referenced roll assist
  // from a world-referenced one.
  const a = (crossDeg * Math.PI) / 180;
  const N = new THREE.Vector3(Math.sin(a), Math.cos(a), 0).normalize();
  const HIT = {
    hit: true, point: new THREE.Vector3(), normal: N.clone(),
    distance: 0, surface, object: null,
  };
  const grip = {};
  for (const k in SURFACE_GRIP) grip[k] = { ...SURFACE_GRIP[k] };
  // The contact block `_collide` reads, in the shape `physics.staticWorld`
  // publishes it. One sphere probe can only be in one half-space, so one slot
  // is all it ever needs.
  const contacts = {
    depth: new Float32Array(1),
    nx: new Float32Array(1), ny: new Float32Array(1), nz: new Float32Array(1),
    px: new Float32Array(1), py: new Float32Array(1), pz: new Float32Array(1),
    tri: new Int32Array(1),
  };
  const staticWorld = {
    contacts,
    objectOf: () => null,
    overlapCapsule(x0, y0, z0, x1, y1, z1, r) {
      const d = N.x * x0 + N.y * y0 + N.z * z0;
      if (d - r >= 0) return 0;
      contacts.depth[0] = r - d;
      contacts.nx[0] = N.x; contacts.ny[0] = N.y; contacts.nz[0] = N.z;
      contacts.px[0] = x0 - N.x * d; contacts.py[0] = y0 - N.y * d; contacts.pz[0] = z0 - N.z * d;
      contacts.tri[0] = 0;
      return 1;
    },
  };
  return {
    slope: 0,
    cross: a,
    physics: {
      MASK: { WORLD: 3 },
      staticWorld,
      raycast(o, d, maxDist) {
        const den = N.dot(d);
        // One-sided: a ray that starts under the surface finds nothing.
        if (Math.abs(den) < 1e-6 || N.dot(o) < 0) { HIT.hit = false; return HIT; }
        const t = -N.dot(o) / den;
        if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
        HIT.hit = true;
        HIT.distance = t;
        HIT.point.set(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
        HIT.normal.copy(N);
        HIT.surface = surface;
        return HIT;
      },
      groundHeight: (x) => -(N.x * x) / N.y,
    },
    lodOf: () => 0,
    surfaceAt: () => surface,
    waterHeightAt: () => null,
    reportCollision: () => {},
    gripOf: (n) => grip[n] ?? grip.asphalt,
    _world: () => null,
  };
}

const STUB = { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {} };
const CTX = { events: { emit() {} }, peek: () => null, time: { elapsed: 0 } };

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
function basis(v) {
  _fwd.set(0, 0, 1).applyQuaternion(v.quaternion);
  _right.set(1, 0, 0).applyQuaternion(v.quaternion);
  _up.set(0, 1, 0).applyQuaternion(v.quaternion);
}
const bankOf = (v) => { basis(v); return Math.atan2(_right.y, _up.y); };
const upOf = (v) => { basis(v); return _up.y; };
const headingOf = (v) => { basis(v); return Math.atan2(_fwd.x, _fwd.z); };

/** A player at the wheel: `autoReverse` is what makes A/D the human axis. */
function spawn(type, sys, opts = {}) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(sys, spec, STUB, {});
  v.damage = null;
  v.setPose(new THREE.Vector3(0, spec.comY, 0), 0);
  v.autoReverse = true;
  if (opts.debugBodyYaw) v.debugBodyYaw = true;
  if (opts.debugNoRight) v.debugNoRight = true;
  if (opts.debugNoRollAssist) v.debugNoRollAssist = true;
  if (opts.destroy) v.destroyed = true;
  // Sat square on the surface it is standing on, whatever that surface is.
  if (sys.cross) {
    v.quaternion.setFromEuler(new THREE.Euler(0, 0, -sys.cross, 'YXZ'));
    v.prevQuaternion.copy(v.quaternion);
    v.position.y = spec.comY / Math.cos(sys.cross);
  }
  return v;
}

function step(v, input) {
  v.input.throttle = input.throttle ?? 0;
  v.input.brake = input.brake ?? 0;
  v.input.steer = input.steer ?? 0;
  v.input.reverse = input.reverse ?? 0;
  v.input.handbrake = !!input.handbrake;
  v.input.boost = input.boost ?? 0;
  v.fixedStep(DT, CTX);
}

/**
 * THE BENCH. Settle, accelerate to `ENTRY_KMH` in a straight line, then hold
 * throttle and full lock for `seconds` — the run the player made.
 *
 * `steer` is the raw player axis: -1 is A (left), +1 is D (right).
 */
function corner(type, steer, { seconds = 6, surface = 'asphalt', cross = 0, kick = 0, ...opts } = {}) {
  const sys = makeWorld(surface, cross);
  const v = spawn(type, sys, opts);
  for (let i = 0; i < 300; i++) step(v, { brake: 1 });
  v.drivetrain.reset();

  let n = 0;
  while (v.forwardSpeed * 3.6 < ENTRY_KMH && n < 120 * 60) { step(v, { throttle: 1 }); n++; }
  const entry = v.forwardSpeed * 3.6;
  const h0 = headingOf(v);

  let maxBank = 0;
  let minUp = 1;
  let maxAssist = 0;
  for (let i = 0; i < Math.round(120 * seconds); i++) {
    // A KERB STRIKE half a second in: a roll rate about the car's own nose
    // axis, which is what a wheel dropping off a lip mid-corner leaves behind.
    if (kick && i === 60) {
      basis(v);
      v.angularVelocity.addScaledVector(_fwd, kick);
    }
    step(v, { throttle: 1, steer });
    const b = Math.abs(bankOf(v));
    if (b > maxBank) maxBank = b;
    const u = upOf(v);
    if (u < minUp) minUp = u;
    if (v.rollAssist > maxAssist) maxAssist = v.rollAssist;
  }
  // Unwrapped heading change — the turn has to have HAPPENED.
  let dh = headingOf(v) - h0;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  return {
    entry, maxBank: maxBank * DEG, minUp, maxAssist,
    turned: Math.abs(dh) * DEG, exit: v.forwardSpeed * 3.6,
  };
}

/* ================================================================== */
/* 1. THE BENCH — W + A at 110 km/h must not put the car on its roof  */
/* ================================================================== */
function testCorner() {
  for (const type of CORNERING) {
    const a = corner(type, -1);
    check('bank', `${type}: W+A at ${ENTRY_KMH} km/h stays under ${BANK_LIMIT} deg of bank`,
      a.entry > ENTRY_KMH - 1 && a.maxBank < BANK_LIMIT && a.minUp > 0.9,
      `entry ${a.entry.toFixed(1)} km/h, peak bank ${a.maxBank.toFixed(1)} deg, up.y min ${a.minUp.toFixed(3)}`);
    // The same corner the other way: a fix that only holds for one sign is a
    // sign error waiting to be found by a player turning right.
    const d = corner(type, 1);
    check('bank', `${type}: W+D at ${ENTRY_KMH} km/h stays under ${BANK_LIMIT} deg of bank`,
      d.maxBank < BANK_LIMIT && d.minUp > 0.9,
      `peak bank ${d.maxBank.toFixed(1)} deg, up.y min ${d.minUp.toFixed(3)}`);
    // ...AND IT STILL TURNS. "Never rolls" is trivially satisfied by a car
    // that goes straight on, so the heading has to move.
    check('bank', `${type}: the same corner still changes the heading`,
      a.turned > 45 && d.turned > 45,
      `A swung ${a.turned.toFixed(0)} deg, D swung ${d.turned.toFixed(0)} deg of heading`);
  }

  // The rest of the road fleet, both ways: nothing in it may roll either.
  for (const type of FLEET) {
    let worst = 0;
    let worstUp = 1;
    for (const s of [-1, 1]) {
      const r = corner(type, s);
      if (r.maxBank > worst) worst = r.maxBank;
      if (r.minUp < worstUp) worstUp = r.minUp;
    }
    check('fleet', `${type}: neither lock rolls it on flat ground`,
      worst < BANK_LIMIT && worstUp > 0.9,
      `worst bank ${worst.toFixed(1)} deg, worst up.y ${worstUp.toFixed(3)}`);
  }

  // Loose surfaces have less grip and so less roll moment, but they are also
  // where a car steps out — the spin recovery lives there.
  for (const surface of ['dirt', 'grass', 'gravel']) {
    const r = corner('muscle', -1, { surface });
    check('surface', `muscle on ${surface}: W+A does not roll it`,
      r.maxBank < BANK_LIMIT && r.minUp > 0.9,
      `peak bank ${r.maxBank.toFixed(1)} deg, up.y min ${r.minUp.toFixed(3)}`);
  }

  // THE KERB STRIKE. A roll rate arriving mid-corner is what actually put a
  // sedan on its roof (111 deg before the assist), and it is the disturbance
  // the city is full of.
  for (const type of ['sedan', 'muscle', 'van']) {
    const r = corner(type, -1, { kick: 1.5 });
    check('kerb', `${type}: a 1.5 rad/s roll strike mid-corner does not put it over`,
      r.maxBank < 45 && r.minUp > 0.6,
      `peak bank ${r.maxBank.toFixed(1)} deg, up.y min ${r.minUp.toFixed(3)}`);
  }
}

/* ================================================================== */
/* 2. THE CROSS SLOPE — the assist is referenced to the GROUND         */
/* ================================================================== */
/**
 * A car on a 20 degree side slope is banked 20 degrees with respect to the
 * world and is not tipping over at all. Two things are asserted, and the
 * second is the one that says which reference frame the code uses:
 *
 *   - it corners on the slope without going over;
 *   - the EMITTED engagement (`rollAssist`) stays at zero while it drives
 *     straight along the slope. Referenced to world up the bank would read
 *     20 degrees, which is past the 13 degree onset, and the assist would be
 *     pulling on a car that is doing nothing wrong.
 */
function testSlope() {
  const sys = makeWorld('asphalt', 20);
  const v = spawn('sedan', sys);
  for (let i = 0; i < 300; i++) step(v, { brake: 1 });
  v.drivetrain.reset();
  let maxAssist = 0;
  let minUp = 1;
  for (let i = 0; i < 120 * 6; i++) {
    step(v, { throttle: 0.6 });
    if (v.rollAssist > maxAssist) maxAssist = v.rollAssist;
    const u = upOf(v);
    if (u < minUp) minUp = u;
  }
  check('slope', 'driving along a 20 deg side slope never engages the roll assist',
    maxAssist === 0 && v.grounded >= 3,
    `peak engagement ${maxAssist.toFixed(3)}, ${v.grounded} wheels down, up.y ${upOf(v).toFixed(3)} (level with the slope is 0.940)`);
  check('slope', 'and it stays on its wheels while it does',
    minUp > 0.85,
    `worst up.y ${minUp.toFixed(3)}`);

  const turn = corner('sedan', -1, { cross: 20, seconds: 4 });
  check('slope', 'cornering across a 20 deg side slope does not roll it',
    turn.minUp > 0.6,
    `peak bank ${turn.maxBank.toFixed(1)} deg (the slope is 20), up.y min ${turn.minUp.toFixed(3)}`);
}

/* ================================================================== */
/* 3. NEGATIVE CONTROL — disarm the roll stability                     */
/* ================================================================== */
/**
 * `debugNoRollAssist` is a live hook in `_rollAssist` (off on every shipped
 * path) that disarms it and changes nothing else. The tall classes must go
 * straight back onto their roofs, or the bench above is measuring the harness.
 */
function testControl() {
  let rolled = 0;
  const detail = [];
  const arms = ['suv', 'pickup', 'van', 'truck'];
  for (const type of arms) {
    const r = corner(type, -1, { debugNoRollAssist: true });
    detail.push(`${type} ${r.maxBank.toFixed(0)}`);
    if (r.maxBank > 90 && r.minUp < 0) rolled++;
  }
  check('control', 'NEGATIVE CONTROL — with the roll assist disarmed they end up on their roofs',
    rolled === arms.length,
    `${rolled}/${arms.length} arms past 90 deg with up.y negative: ${detail.join(', ')} deg`);

  // ...and the same hook must not be able to explain the CARS that never
  // rolled: the assist is not what is holding a muscle car down at 9 degrees.
  const m = corner('muscle', -1, { debugNoRollAssist: true });
  check('control', 'the low classes are stable WITHOUT the assist (it is not propping them up)',
    m.maxBank < BANK_LIMIT && m.minUp > 0.9,
    `muscle disarmed: peak bank ${m.maxBank.toFixed(1)} deg`);
}

/* ================================================================== */
/* 3. RIGHTING — a car on its roof rocks back onto its wheels          */
/* ================================================================== */
/**
 * Dropped inverted on flat ground with no input at all. The emitted `up.y` has
 * to come back positive, and the NEGATIVE CONTROL (`debugNoRight`) has to stay
 * on its roof — otherwise this is measuring the collision solver bouncing it
 * over, which is not a feature anyone can rely on.
 */
function invert(type, { seconds = 12, roll = 180, ...opts } = {}) {
  const sys = makeWorld();
  const v = spawn(type, sys, opts);
  const spec = v.spec;
  // Rolled about the nose axis and dropped on whatever that leaves underneath:
  // the roofline at 180, the flank at 90.
  const drop = roll > 135
    ? spec.style.roofY - spec.comY + 0.02
    : spec.half.x - spec.comY + 0.02;
  v.setPose(new THREE.Vector3(0, Math.max(0.2, drop), 0), 0);
  v.quaternion.setFromEuler(new THREE.Euler(0, 0, (roll * Math.PI) / 180, 'YXZ'));
  v.prevQuaternion.copy(v.quaternion);
  let uMin = 1;
  let righted = -1;
  const n = Math.round(120 * seconds);
  for (let i = 0; i < n; i++) {
    step(v, {});
    const u = upOf(v);
    if (u < uMin) uMin = u;
    if (righted < 0 && u > 0.7) righted = i / 120;
  }
  return { up: upOf(v), uMin, righted, speed: v.speed };
}

function testRight() {
  for (const type of ['muscle', 'sedan', 'police', 'suv']) {
    const r = invert(type);
    check('right', `${type}: on its roof, it rocks back onto its wheels`,
      r.up > 0.85 && r.righted >= 0,
      `up.y ${r.up.toFixed(3)} after 12 s, upright at ${r.righted >= 0 ? r.righted.toFixed(1) + ' s' : 'never'}`);
  }
  // ON ITS FLANK is the same defect and needs the same answer: the wheel rays
  // are cast along the body's own -up, so on its side they point at a wall and
  // the car is exactly as stranded as it is on its roof.
  for (const type of ['sedan', 'van']) {
    const r = invert(type, { roll: 95 });
    check('right', `${type}: on its side, it comes back down onto its wheels`,
      r.up > 0.85 && r.righted >= 0,
      `up.y ${r.up.toFixed(3)} after 12 s, upright at ${r.righted >= 0 ? r.righted.toFixed(1) + ' s' : 'never'}`);
  }

  const ctrl = invert('muscle', { debugNoRight: true });
  check('right', 'NEGATIVE CONTROL — with the righting disarmed it stays on its roof',
    ctrl.up < -0.7,
    `up.y ${ctrl.up.toFixed(3)} after 12 s`);

  // A WRECK IS LEFT WHERE IT LIES. A burnt-out shell heaving itself back onto
  // its wheels is a physics engine showing its workings.
  const dead = invert('sedan', { destroy: true });
  check('right', 'a destroyed vehicle is NOT righted',
    dead.up < -0.7,
    `up.y ${dead.up.toFixed(3)} after 12 s`);

  // It must not fire on a car that is merely leaning: an upright car left
  // alone has to sit still, or "righting" is a permanent shove.
  const sys = makeWorld();
  const v = spawn('sedan', sys);
  for (let i = 0; i < 120 * 6; i++) step(v, {});
  check('right', 'an upright parked car is never touched by the righting',
    Math.abs(bankOf(v)) < 0.02 && v.speed < 0.05,
    `bank ${(bankOf(v) * DEG).toFixed(2)} deg, speed ${v.speed.toFixed(3)} m/s`);
}

/* ================================================================== */
testCorner();
testSlope();
testControl();
testRight();

console.log(`\nrollprobe: ${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('FAILURES:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
