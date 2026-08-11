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
 * plausible — a tyre's yaw moment acts about the CONTACT NORMAL — but the A/B
 * does not reproduce and the claim should not be repeated. MEASURED, this
 * bench, both axes, muscle, on the flat and on 8 / 14 / 20 degree slopes, with
 * and without a 1.5 rad/s kerb strike: 16 runs, the arms agree within 1 degree
 * everywhere (9/9, 11/11, 15/15, 14/14, 20/20, 19/19, 25/25, 25/25). The
 * rollover is a ROLL-axis problem and is fixed on the roll axis.
 *
 * `debugGroundYaw` is the live hook for re-running that A/B with no edit, and
 * section 7 is where the axis question was finally settled. `dynamics.js`
 * ships the BODY axis: below the friction limit the two are indistinguishable,
 * and above it the contact normal is a chaotic reshuffle rather than a fix.
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

/* ------------------------------------------------------------------ */
/* A CROWNED STREET THAT RUNS ONTO A GRADE — "connected roads".        */
/* ------------------------------------------------------------------ */
/**
 * The plane above is one surface and every wheel is on it, which is the one
 * case the ground reference is never wrong about. The report is about the
 * other case: a crowned street running onto a Mt Washington grade, where the
 * front wheels are still on the flat while the rears are on the hill, where
 * the car goes light over the lip, and where it comes back down on ONE tyre.
 *
 * `H(x, z)` is the road: a 2.5% fall either side of the centreline — the |x|
 * is deliberate, so the two sides carry genuinely different normals — and a
 * smooth `deg` grade winding in over `ramp` metres from z = `at`. The normal
 * is the field's own gradient, so the wheels disagree exactly as much as the
 * road actually bends, and the raycast is bisected rather than solved because
 * the field is not a plane. Same one-sided discipline as `makeWorld`: a ray
 * that starts under the surface finds nothing.
 */
const CROWN = 0.025;
function makeStreet(deg, { at = 60, ramp = 12, surface = 'asphalt' } = {}) {
  const g = Math.tan((deg * Math.PI) / 180);
  const H = (x, z) => {
    const t = Math.max(0, Math.min(1, (z - at) / ramp));
    const s = t * t * (3 - 2 * t);
    const climb = z <= at ? 0
      : z >= at + ramp ? (z - at - ramp * 0.5) * g
      : (z - at) * s * g;
    return -CROWN * Math.abs(x) + climb;
  };
  const EPS = 0.05;
  const nAt = (x, z, out) => out.set(
    -(H(x + EPS, z) - H(x - EPS, z)) / (2 * EPS),
    1,
    -(H(x, z + EPS) - H(x, z - EPS)) / (2 * EPS)
  ).normalize();

  const HIT = {
    hit: true, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: 0, surface, object: null,
  };
  const grip = {};
  for (const k in SURFACE_GRIP) grip[k] = { ...SURFACE_GRIP[k] };
  const contacts = {
    depth: new Float32Array(1),
    nx: new Float32Array(1), ny: new Float32Array(1), nz: new Float32Array(1),
    px: new Float32Array(1), py: new Float32Array(1), pz: new Float32Array(1),
    tri: new Int32Array(1),
  };
  const _cn = new THREE.Vector3();
  const staticWorld = {
    contacts,
    objectOf: () => null,
    overlapCapsule(x0, y0, z0, x1, y1, z1, r) {
      nAt(x0, z0, _cn);
      const d = (y0 - H(x0, z0)) * _cn.y;
      if (d >= r) return 0;
      contacts.depth[0] = r - d;
      contacts.nx[0] = _cn.x; contacts.ny[0] = _cn.y; contacts.nz[0] = _cn.z;
      contacts.px[0] = x0 - _cn.x * d;
      contacts.py[0] = y0 - _cn.y * d;
      contacts.pz[0] = z0 - _cn.z * d;
      contacts.tri[0] = 0;
      return 1;
    },
  };
  return {
    slope: 0,
    cross: 0,
    H,
    physics: {
      MASK: { WORLD: 3 },
      staticWorld,
      raycast(o, d, maxDist) {
        const f = (t) => (o.y + d.y * t) - H(o.x + d.x * t, o.z + d.z * t);
        if (f(0) < 0 || f(maxDist) > 0) { HIT.hit = false; return HIT; }
        let lo = 0;
        let hi = maxDist;
        for (let i = 0; i < 40; i++) {
          const mid = (lo + hi) * 0.5;
          if (f(mid) > 0) lo = mid; else hi = mid;
        }
        const t = (lo + hi) * 0.5;
        HIT.hit = true;
        HIT.distance = t;
        HIT.point.set(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
        nAt(HIT.point.x, HIT.point.z, HIT.normal);
        HIT.surface = surface;
        return HIT;
      },
      groundHeight: (x, z) => H(x, z),
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
  if (opts.debugRawRef) v.debugRawRef = true;
  if (opts.debugGroundYaw) v.debugGroundYaw = true;
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
/* 5. CONNECTED ROADS — a crown, a hill onset, and the landing         */
/* ================================================================== */
/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS SECTION EXISTS FOR
 * ────────────────────────────────────────────────────────────────────────────
 * Reported as "driving on hills or connected roads was difficult — the car
 * spun out and was making squealing noises while turning". Everything above
 * this line is measured on ONE plane, where every wheel reports the same
 * normal and the mean of them cannot be wrong. A street is not one plane.
 *
 * MEASURED on the build before `_groundRef`, an Ironside holding a lock through
 * the 30 degree hill onset below: over the lip the car goes light, comes down
 * on a SINGLE tyre, and the reference — that one tyre's normal — reads 65
 * degrees of bank on a body only 36 degrees off vertical. `_rollAssist` then
 * held FULL authority, 13 rad/s^2, for 0.55 s of that, and the body slip it
 * left behind climbed to 24 degrees against 9 on the same run with the assist
 * disarmed. Across the transition itself the grounded wheels disagreed by 22.8
 * degrees, so even with four wheels down the mean was a surface none of them
 * was on.
 *
 * WHAT IS ASSERTED, and none of it is a gain or an input:
 *
 *   THIN      the emitted `rollAssist` sampled at every step where the emitted
 *             `grounded` count is under two. One contact does not determine a
 *             plane, so any engagement there is authority spent on a reading
 *             the car has no grounds for. This must be exactly zero.
 *   LANDING   the same engagement in the first tenth of a second after the
 *             wheels come back down. A car that is still landing is not a car
 *             that is tipping, and the authority has to RAMP rather than snap
 *             — the raw reference committed all 13 rad/s^2 on the first frame
 *             a tyre touched.
 *   SLIP      peak body slip, taken from the EMITTED velocity against the
 *             EMITTED heading — the spin-out — and the fraction of the run
 *             with a tyre past its friction circle, which is the squeal.
 *
 * The NEGATIVE CONTROL is `debugRawRef`: the raw instantaneous mean, trusted
 * outright, and the un-floored yaw lever that went with it — the whole of the
 * behaviour this replaced, on a live vehicle with no edit.
 */
/** Onsets the city actually has. Mt Washington is 30. */
const ONSETS = [8, 14, 20, 30];
/** Entry speed for the street bench, km/h — ordinary road speed. */
const STREET_KMH = 50;
/**
 * How long after touching down the engagement is still a landing rather than a
 * measurement, seconds, and the most of its authority it may have spent by
 * then. The arm in `dynamics.js` ramps over 0.25 s, so a tenth of a second in
 * it is at 0.4 — the limit is that plus room, and the point of the check is
 * that the number is a RAMP and not a 1.
 */
const LAND_WINDOW = 0.1;
const LAND_LIMIT = 0.5;

function drive(type, deg, steer, { seconds = 6, x0 = 1.6, ...opts } = {}) {
  const sys = makeStreet(deg);
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(sys, spec, STUB, {});
  v.damage = null;
  v.autoReverse = true;
  if (opts.debugRawRef) v.debugRawRef = true;
  if (opts.debugNoRollAssist) v.debugNoRollAssist = true;
  v.setPose(new THREE.Vector3(x0, sys.H(x0, 0) + spec.comY, 0), 0);

  for (let i = 0; i < 240; i++) step(v, { brake: 1 });
  v.drivetrain.reset();
  let n = 0;
  while (v.forwardSpeed * 3.6 < STREET_KMH && n < 120 * 40) { step(v, { throttle: 1 }); n++; }
  const h0 = headingOf(v);

  let thin = 0;
  let landing = 0;
  let maxBeta = 0;
  let skid = 0;
  let minUp = 1;
  let air = 999;
  const N = Math.round(120 * seconds);
  for (let i = 0; i < N; i++) {
    step(v, { throttle: 0.45, steer });
    const a = v.rollAssist;
    if (v.grounded < 2 && a > thin) thin = a;
    if (v.grounded === 0) air = 0; else air += DT;
    if (air < LAND_WINDOW && a > landing) landing = a;
    // Body slip off the EMITTED pose and velocity: the angle between where the
    // car is pointing and where it is actually going.
    basis(v);
    const along = v.velocity.dot(_fwd);
    const across = v.velocity.dot(_right);
    if (v.speed > 3) maxBeta = Math.max(maxBeta, Math.abs(Math.atan2(across, along)));
    for (const w of v.wheels) if (w.skidding) { skid++; break; }
    const u = upOf(v);
    if (u < minUp) minUp = u;
  }
  let dh = headingOf(v) - h0;
  while (dh > Math.PI) dh -= Math.PI * 2;
  while (dh < -Math.PI) dh += Math.PI * 2;
  return {
    thin, landing, minUp, skid: skid / N,
    maxBeta: maxBeta * DEG, turned: Math.abs(dh) * DEG,
  };
}

function testStreet() {
  for (const type of ['muscle', 'sedan', 'suv', 'van']) {
    let thin = 0;
    let landing = 0;
    const detail = [];
    for (const deg of ONSETS) {
      for (const s of [-0.35, 0.35]) {
        const r = drive(type, deg, s);
        thin = Math.max(thin, r.thin);
        landing = Math.max(landing, r.landing);
        if (s < 0) detail.push(`${deg}deg beta ${r.maxBeta.toFixed(0)}`);
      }
    }
    check('road', `${type}: the roll assist never fires on a single contact`,
      thin === 0,
      `peak engagement with under two wheels down ${thin.toFixed(2)}; ${detail.join(', ')}`);
    check('road', `${type}: nor at full authority while the car is still landing`,
      landing < LAND_LIMIT,
      `peak engagement within ${LAND_WINDOW} s of touching down ${landing.toFixed(2)}`);
  }

  // ...AND THE CORNER IS STILL A CORNER. A gate that never opens would satisfy
  // both of the above, so the same runs have to turn, stay on their wheels and
  // keep their tyres inside the friction circle for most of the corner.
  for (const type of ['sedan', 'suv']) {
    let worstBeta = 0;
    let worstSkid = 0;
    let turned = 180;
    let minUp = 1;
    for (const deg of ONSETS) {
      const r = drive(type, deg, -0.35);
      worstBeta = Math.max(worstBeta, r.maxBeta);
      worstSkid = Math.max(worstSkid, r.skid);
      turned = Math.min(turned, r.turned);
      minUp = Math.min(minUp, r.minUp);
    }
    check('road', `${type}: it tracks the corner across every onset without sliding`,
      worstBeta < 15 && worstSkid < 0.2 && turned > 45 && minUp > 0.6,
      `worst body slip ${worstBeta.toFixed(1)} deg, worst ${(worstSkid * 100).toFixed(0)}% of the corner skidding, least heading swing ${turned.toFixed(0)} deg, worst up.y ${minUp.toFixed(3)}`);
  }

  // NEGATIVE CONTROL. The raw reference has to put the engagement straight back
  // onto contacts that never determined anything, or the two checks above are
  // measuring the bench.
  let rawThin = 0;
  let rawLanding = 0;
  const detail = [];
  for (const deg of ONSETS) {
    const r = drive('muscle', deg, -0.35, { debugRawRef: true });
    rawThin = Math.max(rawThin, r.thin);
    rawLanding = Math.max(rawLanding, r.landing);
    detail.push(`${deg}deg ${r.thin.toFixed(2)}`);
  }
  check('road', 'NEGATIVE CONTROL — the raw reference fires at full authority on one wheel',
    rawThin > 0.9,
    `peak engagement with under two wheels down ${rawThin.toFixed(2)}: ${detail.join(', ')}`);
  check('road', 'NEGATIVE CONTROL — and commits all of it on the frame the tyre touches',
    rawLanding > LAND_LIMIT,
    `peak engagement within ${LAND_WINDOW} s of touching down ${rawLanding.toFixed(2)}, against a ${LAND_LIMIT} limit`);
}

/* ================================================================== */
/* 6. THE SHUNT — "running into another car spun mine on its axis"     */
/* ================================================================== */
/**
 * A collision leaves a car with a yaw rate AND a lean, arriving together —
 * "running into another car made my car spin around on its axis". The
 * disturbance is injected as angular velocity rather than by staging a second
 * car, because a rate about a named axis is the thing under test and a second
 * body would put the collision solver's own tuning in the middle of it.
 *
 * Two things are asserted:
 *
 *   CAUGHT    the emitted heading stops moving, and the car is still on its
 *             wheels when it does. MEASURED against main over the same 30
 *             runs: main ends 20 of them past 90 degrees of bank with `up.y`
 *             negative — on its roof — and its worst run is still turning when
 *             the window closes at 7.99 s. This build's worst is 5.27 s and
 *             nothing goes over.
 *   AXIS      ORDINARY cornering cannot tell the two yaw axes apart at all —
 *             see the axis block in `dynamics.js`. That is the whole reason
 *             the body axis is shipped: everything the contact normal changes
 *             lives at the friction limit, where it was measured at 7 corners
 *             worse than main and 28 better, which is chaos and not a fix.
 *             This is the check that says so, and it is deliberately taken on
 *             a corner the car is comfortably inside, because at the limit
 *             there is nothing stable for a gate to assert.
 */
function shunt(type, yaw, roll, cross, opts = {}) {
  const sys = makeWorld('asphalt', cross);
  const v = spawn(type, sys, opts);
  for (let i = 0; i < 240; i++) step(v, { brake: 1 });
  v.drivetrain.reset();
  let n = 0;
  while (v.forwardSpeed * 3.6 < 60 && n < 120 * 40) { step(v, { throttle: 1 }); n++; }

  basis(v);
  v.angularVelocity.addScaledVector(_up, yaw);
  v.angularVelocity.addScaledVector(_fwd, roll);
  const h0 = headingOf(v);

  let settle = 0;
  let minUp = 1;
  let dev = 0;
  const N = 120 * SHUNT_WINDOW;
  for (let i = 0; i < N; i++) {
    step(v, {});
    if (Math.abs(v.angularVelocity.y) >= 0.15) settle = i / 120;
    if (upOf(v) < minUp) minUp = upOf(v);
    let d = headingOf(v) - h0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    dev = Math.max(dev, Math.abs(d) * DEG);
  }
  return { settle, dev: dev, minUp };
}

/** Yaw and roll rates a shunt leaves behind, rad/s. */
const SHUNTS = [[3, 2.5], [4, 3.5], [5, 5]];
/**
 * How long the car is watched and how long the spin may last, seconds. The
 * window has to be clear of the bound or a run that never settles reads as one
 * that settled exactly at the end — main's heaviest classes are still turning
 * at 7.99 s, which is the window and not a measurement.
 */
const SHUNT_WINDOW = 8;
const SHUNT_SETTLE = 6;

function testShunt() {
  for (const type of ['sedan', 'muscle', 'suv', 'van', 'truck']) {
    let worst = 0;
    let minUp = 1;
    let swung = 0;
    for (const [yaw, roll] of SHUNTS) {
      for (const cross of [0, 20]) {
        const r = shunt(type, yaw, roll, cross);
        worst = Math.max(worst, r.settle);
        minUp = Math.min(minUp, r.minUp);
        swung = Math.max(swung, r.dev);
      }
    }
    check('shunt', `${type}: a spin arriving with a lean is caught, on its wheels`,
      worst < SHUNT_SETTLE && minUp > 0.7 && swung > 45,
      `emitted heading still moving after ${worst.toFixed(2)} s at worst, up.y min ${minUp.toFixed(3)}, swung up to ${swung.toFixed(0)} deg`);
  }

}

/* ================================================================== */
/* 7. THE YAW AXIS — invisible below the limit, chaos above it         */
/* ================================================================== */
/** A corner the car is comfortably inside: steer, and the speed to hold it. */
const GENTLE = [[0.3, 40], [0.25, 60], [0.2, 80]];
/** Emitted heading the two axes may differ by over such a corner, degrees. */
const AXIS_GAP = 0.05;

function gentle(type, steer, kmh, opts = {}) {
  const sys = makeWorld('asphalt', 0);
  const v = spawn(type, sys, opts);
  for (let i = 0; i < 300; i++) step(v, { brake: 1 });
  v.drivetrain.reset();
  let n = 0;
  while (v.forwardSpeed * 3.6 < kmh && n < 120 * 60) { step(v, { throttle: 1 }); n++; }
  const h0 = headingOf(v);
  let maxRoll = 0;
  for (let i = 0; i < 120 * 4; i++) {
    step(v, { throttle: 0.3, steer });
    maxRoll = Math.max(maxRoll, Math.abs(bankOf(v)));
  }
  let d = headingOf(v) - h0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return { turned: d * DEG, maxRoll: maxRoll * DEG };
}

function testAxis() {
  for (const type of FLEET) {
    let gap = 0;
    let turned = 180;
    let roll = 0;
    for (const [steer, kmh] of GENTLE) {
      const b = gentle(type, steer, kmh);
      const g = gentle(type, steer, kmh, { debugGroundYaw: true });
      gap = Math.max(gap, Math.abs(b.turned - g.turned));
      turned = Math.min(turned, Math.abs(b.turned));
      roll = Math.max(roll, b.maxRoll);
    }
    check('axis', `${type}: ordinary cornering cannot tell the two yaw axes apart`,
      gap < AXIS_GAP && turned > 20,
      `emitted heading differs by ${gap.toFixed(3)} deg at worst over turns of at least ${turned.toFixed(0)} deg, body roll up to ${roll.toFixed(1)} deg`);
  }
}

/* ================================================================== */
testCorner();
testSlope();
testControl();
testRight();
testStreet();
testShunt();
testAxis();

console.log(`\nrollprobe: ${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('FAILURES:');
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
