#!/usr/bin/env node
/**
 * TRACTION PROBE — "the cars don't have enough traction", as numbers.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE REPORT THIS EXISTS FOR
 * ────────────────────────────────────────────────────────────────────────────
 * The owner played and filed two complaints:
 *
 *   "the cars don't have enough traction - at full throttle tires seem to spin
 *    and movement is like driving on hubcaps"
 *   "driving off roads by accident makes it difficult to drive back onto the
 *    road (slippery and not grippy enough)"
 *
 * Both reproduced here, on the real `Vehicle` at the real 120 Hz step, before
 * anything was changed:
 *
 *   ON TARMAC   a standing start did NOT slide much — peak driven slip ratio
 *               0.145 (muscle) and 0.149 (sedan), well inside the 0.25 bar —
 *               but the traction controller's own setpoint was 1.35x the
 *               tyre's peak slip, and `_stepWheels` flags a wheel as SKIDDING
 *               at `combined > 1.02`. So the launch was a by-design skid:
 *               `combined` peaked at 1.058 / 1.106, the sedan's driven tyres
 *               were flagged skidding for 0.53 s of a 4.0 s run to 50 km/h,
 *               and tyre heat — which costs `tyre.fade` = 16% of mu — started
 *               building. That is the squeal, the smoke and the mushy pedal
 *               the report describes, and NOT a slip-ratio number.
 *   OFF IT      grass and dirt were a different order of failure. The
 *               integrator limit-cycled at ~5 Hz between slip 0.02 and 0.56,
 *               peak driven slip ratio reached 1.60 (muscle, grass) and 1.15
 *               (sedan), the driven tyres were flagged skidding for 2.2-2.6 s
 *               of a 4 s launch, heat SATURATED at 1.000 and stayed there, and
 *               a sedan pointed up a 14.5 degree grass bank moved 1 cm in five
 *               seconds. Lateral capability on grass was 0.58-0.63x the same
 *               car's asphalt figure.
 *
 * The fixes are `_capLaunch` + the `TC_TARGET` setpoint in `dynamics.js` and
 * the offroad band of `SURFACE_GRIP` in `specs.js`. Both are gated here.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS ASSERTED, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 * ────────────────────────────────────────────────────────────────────────────
 * Nothing below reads a torque, a gain, a `traction` level, a setpoint or an
 * input. Every number is taken off the EMITTED state:
 *
 *   SLIP RATIO   rebuilt from the wheel's own emitted `omega` and the emitted
 *                contact-patch speed `vLong`, normalised the way `tyre.js`
 *                normalises it. Deliberately NOT `w.slipRatio`, which is the
 *                intermediate the tyre model already computed.
 *   SKID         `w.skidding` — the flag `fx` and the audio subscribe to, i.e.
 *                whether the game thinks the tyre is sliding — and `w.heat`,
 *                the state that takes mu away.
 *   SPEED        the emitted `forwardSpeed` and the emitted world position.
 *   LATERAL      the sum of the emitted per-wheel `fy` over the car's weight,
 *                in a real steady-state corner.
 *   KERB         the emitted world position: past the face, at footway height.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROLS
 * ────────────────────────────────────────────────────────────────────────────
 * Two, both against the LIVE build with no edit, one per fix:
 *
 *   `debugOldTraction`   per-vehicle hatch in `dynamics.js`: restores the
 *                        past-the-peak setpoint and disarms `_capLaunch`.
 *   LEGACY GRIP TABLE    the pre-fix offroad mus, handed in through the same
 *                        `sys.gripOf` seam the wetness model already uses — so
 *                        the vehicle reads them exactly as it reads the real
 *                        ones, in the tyre model AND in the steering cap.
 *
 * Every control arm must go RED. A control that stays green means the
 * assertion above it is measuring the harness.
 *
 *   node src/vehicles/tracprobe.mjs
 *   node src/vehicles/tracprobe.mjs --verbose
 */

import * as THREE from 'three';
import { VEHICLE_SPECS, finalizeSpec, SURFACE_GRIP } from './specs.js';
import { Vehicle } from './dynamics.js';

const DT = 1 / 120;
const VERBOSE = process.argv.includes('--verbose');

/** The road fleet the report was filed against. */
const FLEET = ['muscle', 'sedan', 'sports', 'pickup', 'suv'];

/**
 * ---- the measured targets ----
 *
 * `LAUNCH_KMH` / `LAUNCH_SLIP` are the report's own terms: a full-throttle
 * standing start must REACH 50 km/h with the driven tyres never past a quarter
 * of a slip ratio. `LAUNCH_SECS` is a RATCHET, not a target — it records that
 * the fleet currently does it in 2.14-4.02 s, so 5.5 s is headroom against a
 * regression rather than a bar anybody aimed at. Lower it when you improve it;
 * never raise it to make a run go green.
 */
const LAUNCH_KMH = 50;
const LAUNCH_SLIP = 0.25;
const LAUNCH_SECS = 5.5;
/** Grass lateral capability, as a fraction of the same car's asphalt figure. */
const OFFROAD_LAT = 0.75;
/** Kerb the city builds, metres, and the approach the report describes. */
const KERB_H = 0.15;
const KERB_ENTRY_KMH = 20;

/** The offroad band as it was when the report was filed. */
const LEGACY_OFFROAD = {
  gravel: 0.62, dirt: 0.66, grass: 0.58, foliage: 0.55, sand: 0.5, mud: 0.45,
};

let pass = 0;
let fail = 0;
const fails = [];
function check(section, name, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(`${section}: ${name} — ${detail}`); }
  if (VERBOSE || !ok) console.log(`${ok ? 'ok  ' : 'FAIL'} ${section} ${name}  ${detail}`);
}

/* ------------------------------------------------------------------ */
/* Worlds                                                              */
/* ------------------------------------------------------------------ */

/** The grip table a run sees. `legacy` restores the pre-fix offroad band. */
function gripTable(legacy) {
  const t = {};
  for (const k in SURFACE_GRIP) {
    t[k] = legacy && LEGACY_OFFROAD[k] !== undefined
      ? { ...SURFACE_GRIP[k], mu: LEGACY_OFFROAD[k] }
      : SURFACE_GRIP[k];
  }
  return t;
}

/**
 * A tiltable plane with a surface tag — same shape as `drivetest.mjs`'s, and
 * for the same reason: analytic, deterministic, no browser and no dependence
 * on what the city happens to have built today.
 *
 * @param slopeDeg ground falls toward +Z, so a car at yaw 0 points DOWNHILL
 */
function makeWorld(surface, slopeDeg = 0, legacy = false) {
  const a = (slopeDeg * Math.PI) / 180;
  const N = new THREE.Vector3(0, Math.cos(a), Math.sin(a)).normalize();
  const HIT = {
    hit: true, point: new THREE.Vector3(), normal: N.clone(),
    distance: 0, surface, object: null,
  };
  const grip = gripTable(legacy);
  const physics = {
    MASK: { WORLD: 3 },
    staticWorld: null,
    raycast(origin, dir, maxDist) {
      const denom = N.dot(dir);
      if (Math.abs(denom) < 1e-6) { HIT.hit = false; return HIT; }
      const t = -N.dot(origin) / denom;
      if (t < 0 || t > maxDist) { HIT.hit = false; return HIT; }
      HIT.hit = true;
      HIT.distance = t;
      HIT.point.set(origin.x + dir.x * t, origin.y + dir.y * t, origin.z + dir.z * t);
      HIT.normal.copy(N);
      HIT.surface = surface;
      return HIT;
    },
    groundHeight: (x, z) => -(N.z * z) / N.y,
  };
  return {
    slope: a,
    physics,
    lodOf: () => 0,
    surfaceAt: () => surface,
    waterHeightAt: () => null,
    reportCollision: () => {},
    gripOf: (n) => grip[n] ?? grip.asphalt,
    _world: () => null,
  };
}

/**
 * THE VERGE AND THE ROAD IT HAS TO GET BACK ONTO. Two half-open boxes that
 * tile the ground with no gap, exactly as `drivetest.mjs` builds its kerb:
 *
 *   verge  { x <= 0, y <= 0 }   tagged `low` (grass)
 *   road   { x >= 0, y <= H }   tagged `high` (asphalt), with a vertical face
 *
 * The surface tag is taken from the HIT POINT rather than being one constant
 * for the whole world, which is the only way to ask the question the report
 * asks: the car is on the loose stuff, the grip it needs is on the sealed
 * stuff, and the kerb is between them.
 */
const _BIG = 1e6;
function makeVergeWorld(H, low, high, legacy = false) {
  const boxes = [
    { lo: [-_BIG, -_BIG, -_BIG], hi: [0, 0, _BIG] },
    { lo: [0, -_BIG, -_BIG], hi: [_BIG, H, _BIG] },
  ];
  const HIT = {
    hit: false, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0),
    distance: 0, surface: low, object: null,
  };
  /** Slab test; returns entry distance and writes the entry face normal. */
  function rayBox(ox, oy, oz, dx, dy, dz, maxDist, box, n) {
    let tmin = 0;
    let tmax = maxDist;
    let axis = -1;
    let sign = 1;
    const o = [ox, oy, oz];
    const d = [dx, dy, dz];
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (o[a] < box.lo[a] || o[a] > box.hi[a]) return -1;
        continue;
      }
      const inv = 1 / d[a];
      let t1 = (box.lo[a] - o[a]) * inv;
      let t2 = (box.hi[a] - o[a]) * inv;
      let s = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (axis < 0) return -1; // started inside
    n.set(0, 0, 0);
    n.setComponent(axis, sign);
    return tmin;
  }
  const _n = new THREE.Vector3();
  const _bn = new THREE.Vector3();
  const grip = gripTable(legacy);
  const contacts = {
    depth: new Float32Array(8), nx: new Float32Array(8), ny: new Float32Array(8),
    nz: new Float32Array(8), px: new Float32Array(8), py: new Float32Array(8),
    pz: new Float32Array(8), tri: new Int32Array(8),
  };
  const physics = {
    MASK: { WORLD: 3 },
    raycast(origin, dir, maxDist) {
      let best = Infinity;
      HIT.hit = false;
      for (const box of boxes) {
        const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist, box, _n);
        if (t >= 0 && t < best) { best = t; _bn.copy(_n); }
      }
      if (!(best <= maxDist)) return HIT;
      HIT.hit = true;
      HIT.distance = best;
      HIT.point.set(origin.x + dir.x * best, origin.y + dir.y * best, origin.z + dir.z * best);
      HIT.normal.copy(_bn);
      // The tag follows the ground, not the world: verge on the low side,
      // road on the footway and on the kerb face itself.
      HIT.surface = HIT.point.x > 1e-4 ? high : low;
      return HIT;
    },
    groundHeight: (x) => (x > 0 ? H : 0),
    staticWorld: {
      contacts,
      objectOf: () => null,
      surfaceOf: () => 0,
      /** Sphere (p0 === p1 for a vehicle probe) against the two boxes. */
      overlapCapsule(x0, y0, z0, x1, y1, z1, r) {
        let n = 0;
        for (const box of boxes) {
          const qx = Math.min(box.hi[0], Math.max(box.lo[0], x0));
          const qy = Math.min(box.hi[1], Math.max(box.lo[1], y0));
          const qz = Math.min(box.hi[2], Math.max(box.lo[2], z0));
          let nx = x0 - qx, ny = y0 - qy, nz = z0 - qz;
          const d2 = nx * nx + ny * ny + nz * nz;
          let depth;
          if (d2 > 1e-12) {
            const d = Math.sqrt(d2);
            if (d >= r) continue;
            depth = r - d;
            nx /= d; ny /= d; nz /= d;
          } else {
            const ex = x0 - box.lo[0], exh = box.hi[0] - x0;
            const ey = y0 - box.lo[1], eyh = box.hi[1] - y0;
            const ez = z0 - box.lo[2], ezh = box.hi[2] - z0;
            const cand = [[ex, -1, 0, 0], [exh, 1, 0, 0], [ey, 0, -1, 0],
              [eyh, 0, 1, 0], [ez, 0, 0, -1], [ezh, 0, 0, 1]];
            let bd = Infinity, bi = 3;
            for (let i = 0; i < cand.length; i++) if (cand[i][0] < bd) { bd = cand[i][0]; bi = i; }
            depth = r + bd;
            nx = cand[bi][1]; ny = cand[bi][2]; nz = cand[bi][3];
          }
          if (n >= contacts.depth.length) break;
          contacts.depth[n] = depth;
          contacts.nx[n] = nx; contacts.ny[n] = ny; contacts.nz[n] = nz;
          contacts.px[n] = x0 - nx * (r - depth);
          contacts.py[n] = y0 - ny * (r - depth);
          contacts.pz[n] = z0 - nz * (r - depth);
          contacts.tri[n] = 0;
          n++;
        }
        return n;
      },
    },
  };
  return {
    kerbH: H,
    physics,
    lodOf: () => 0,
    surfaceAt: (x) => (x > 0 ? high : low),
    waterHeightAt: () => null,
    reportCollision: () => {},
    gripOf: (n) => grip[n] ?? grip.asphalt,
    _world: () => null,
  };
}

/* ------------------------------------------------------------------ */
/* Driving                                                             */
/* ------------------------------------------------------------------ */

const STUB_MODEL = { root: null, wheels: [], panels: [], glassMeshes: [], lampMats: {} };
const CTX = { events: { emit() {} }, peek: () => null, time: { elapsed: 0 } };
const _euler = new THREE.Euler();

function spawn(type, sys, { x = 0, z = 0, yaw = 0, old = false } = {}) {
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const v = new Vehicle(sys, spec, STUB_MODEL, {});
  v.damage = null;
  v.setPose(new THREE.Vector3(x, spec.comY, z), yaw);
  // `drivetest.mjs`'s lesson: `setPose` only takes a yaw, so a car spawned on a
  // slope starts level, half its wheels under the ground, and tumbles off
  // before the test begins.
  if (sys.slope) {
    v.quaternion.setFromEuler(_euler.set(sys.slope, 0, 0, 'YXZ'));
    v.prevQuaternion.copy(v.quaternion);
  }
  if (old) v.debugOldTraction = true;
  return v;
}

function drive(v, input, n, probe) {
  for (let i = 0; i < n; i++) {
    v.input.throttle = input.throttle ?? 0;
    v.input.brake = input.brake ?? 0;
    v.input.steer = input.steer ?? 0;
    v.input.reverse = input.reverse ?? 0;
    v.input.handbrake = !!input.handbrake;
    v.input.boost = 0;
    v.fixedStep(DT, CTX);
    if (probe) probe(v, i);
  }
  return v;
}

/** Settle onto the ground with the brakes on, without arming reverse. */
function settle(v) {
  const ar = v.autoReverse;
  v.autoReverse = false;
  drive(v, { brake: 1 }, 300);
  v.autoReverse = ar;
  v.drivetrain.reset();
  return v;
}

/**
 * The slip ratio of the worst DRIVEN wheel, rebuilt from emitted state.
 *
 * Not `w.slipRatio`: that is the intermediate the tyre model computed on its
 * way to a force, and re-reading it would be reading this harness's own input.
 * `omega` is the wheel speed the renderer spins the wheel at and `vLong` is
 * the contact-patch speed the body actually has.
 */
function drivenSlip(v) {
  let worst = 0;
  for (let k = 0; k < v._driven.length; k++) {
    const w = v.wheels[v._driven[k]];
    if (!w.grounded) continue;
    const s = (w.omega * w.hp.radius - w.vLong) / Math.max(2.2, Math.abs(w.vLong));
    if (s > worst) worst = s;
  }
  return worst;
}

/** Full throttle from rest. Everything reported is emitted state. */
function standingStart(type, surface, { slope = 0, legacy = false, old = false, secs = 12 } = {}) {
  const sys = makeWorld(surface, slope, legacy);
  const v = spawn(type, sys, { old });
  settle(v);
  const y0 = v.position.y;
  const out = { peakSlip: 0, armedSlip: 0, skid: 0, heat: 0, secs: -1, speed: 0, rise: 0 };
  const target = LAUNCH_KMH / 3.6;
  /**
   * The slip, skid and heat windows are the WHOLE run, not the part of it
   * before 50 km/h. Closing them at the target speed would have quietly
   * excluded everything above 14 m/s, which is exactly where the controllers
   * hand back authority — i.e. the window would have been drawn around the
   * part that is easy to keep clean.
   */
  drive(v, { throttle: 1 }, Math.round(120 * secs), (veh, i) => {
    const s = drivenSlip(veh);
    if (s > out.peakSlip) out.peakSlip = s;
    // ...and the same thing over the window where the controllers hold FULL
    // authority (`_hookUp` fades it out from 6 m/s and it is gone by 14). Both
    // windows are reported, because they answer different questions: this one
    // is "does it launch", the one above is "does it ever spin".
    if (Math.abs(veh.forwardSpeed) <= 6 && s > out.armedSlip) out.armedSlip = s;
    for (let k = 0; k < veh._driven.length; k++) {
      const w = veh.wheels[veh._driven[k]];
      if (w.skidding) out.skid += DT / veh._driven.length;
      if (w.heat > out.heat) out.heat = w.heat;
    }
    if (out.secs < 0 && veh.forwardSpeed >= target) out.secs = (i + 1) * DT;
  });
  out.speed = v.forwardSpeed;
  out.rise = v.position.y - y0;
  return out;
}

/**
 * Peak lateral capability: the emitted tyre force across the wheels, over the
 * car's own weight, in a steady 40 km/h corner. The steering cap in
 * `_updateSteering` reads the live surface mu, so this is the whole cornering
 * chain — grip AND the lock the car is allowed — not a table lookup.
 *
 * SWEPT over steering inputs, and the best kept. Full lock is not the most
 * lateral force a car can make on a loose surface: it is past the front axle's
 * limit and the car simply pushes or spins. Reading one input would have
 * measured how far past the limit that class's lock happens to be — the pickup
 * makes 0.879 g on grass at 70% lock and 0.814 at full lock.
 *
 * GUARDED on body slip, and the guard is one that can actually fire: samples
 * taken past `LAT_BETA` are thrown away, because a number read off a car that
 * is 69 degrees sideways is a number read off a spin, not a corner. (That is
 * `bench.mjs`'s old steady-state defect and it is worth not repeating.) The
 * guard clips at exactly 15 degrees on the pickup and the sports car and never
 * binds at all on the others, which is how it is known to be live.
 */
const LAT_BETA = 0.26;
const LAT_STEER = [0.5, 0.7, 1.0];
function lateralG(type, surface, legacy = false) {
  let best = 0;
  for (const steer of LAT_STEER) {
    const sys = makeWorld(surface, 0, legacy);
    const v = spawn(type, sys);
    settle(v);
    const target = 40 / 3.6;
    for (let i = 0; i < 120 * 30 && v.forwardSpeed < target; i++) drive(v, { throttle: 1 }, 1);
    for (let i = 0; i < 120 * 5; i++) {
      const e = target - v.forwardSpeed;
      drive(v, { throttle: Math.max(0, Math.min(1, e * 0.5)), steer }, 1);
      if (i < 120 * 2) continue; // let the corner settle
      if (Math.abs(v.slipAngle) > LAT_BETA) continue;
      let fy = 0;
      for (const w of v.wheels) if (w.grounded) fy += Math.abs(w.fy);
      const g = fy / (v.mass * 9.81);
      if (g > best) best = g;
    }
  }
  return best;
}

/**
 * Drive at the kerb from the verge and report whether the car got onto the
 * road. Signed and absolute: the face is the plane x = 0, so "cleared" is the
 * whole car past it and sitting at footway height.
 */
function kerbClimb(type, { yawDeg, entryKmh, legacy = false, old = false, secs = 6 }) {
  const sys = makeVergeWorld(KERB_H, 'grass', 'asphalt', legacy);
  const spec = finalizeSpec(VEHICLE_SPECS[type]);
  const yaw = (yawDeg * Math.PI) / 180;
  const startX = -(spec.half.z + 3.5);
  const v = spawn(type, sys, { x: startX, z: 0, yaw, old });
  settle(v);
  // Run up to the entry speed on the verge before the face is reached.
  const entry = entryKmh / 3.6;
  for (let i = 0; i < 120 * 20 && v.forwardSpeed < entry && v.position.x < -1.2; i++) {
    drive(v, { throttle: 1 }, 1);
  }
  const wantX = spec.half.z + 0.2;
  const wantY = KERB_H * 0.6;
  let cleared = false;
  let at = -1;
  /**
   * The speed the car ACTUALLY arrives at the face with, taken when its
   * leading corner crosses x = 0 — not the speed the run-up was aiming for.
   * Asking the harness what it intended is how a crawl gets scored as a 20
   * km/h approach.
   */
  let face = -1;
  drive(v, { throttle: 1 }, Math.round(120 * secs), (veh, i) => {
    if (face < 0 && veh.position.x + spec.half.z >= 0) face = Math.abs(veh.forwardSpeed);
    if (cleared) return;
    if (veh.position.x > wantX && veh.position.y - spec.comY > wantY) {
      cleared = true;
      at = (i + 1) * DT;
    }
  });
  return { cleared, at, x: v.position.x, y: v.position.y - spec.comY, wantX, wantY, entry: face };
}

/* ------------------------------------------------------------------ */
/* 1. LAUNCH — full throttle from rest on tarmac.                      */
/* ------------------------------------------------------------------ */

console.log('--- 1. launch on asphalt ---');
for (const type of FLEET) {
  const r = standingStart(type, 'asphalt');
  const d = `0-${LAUNCH_KMH} in ${r.secs < 0 ? 'NEVER' : `${r.secs.toFixed(2)} s`}, ` +
    `peak slip ${r.peakSlip.toFixed(3)}, skid ${r.skid.toFixed(2)} s, heat ${r.heat.toFixed(3)}`;
  check('launch', `${type} reaches ${LAUNCH_KMH} km/h`,
    r.secs >= 0 && r.secs <= LAUNCH_SECS, `${d} (RATCHET ${LAUNCH_SECS} s)`);
  check('launch', `${type} does not spin up`,
    r.peakSlip < LAUNCH_SLIP, `${d} (want < ${LAUNCH_SLIP})`);
  /**
   * The half the slip ratio does not say. A tyre held past its own peak is
   * flagged skidding, squeals, smokes, and cooks: `heat` costs `tyre.fade` of
   * mu, which is the "driving on hubcaps" half of the report. Both were
   * non-zero on the reported build with the slip ratio already inside its bar.
   */
  check('launch', `${type} launches without sliding the tyres`,
    r.skid < 0.05 && r.heat < 0.05, d);
}

/* ------------------------------------------------------------------ */
/* 2. OFFROAD LAUNCH — the verge, from rest.                           */
/* ------------------------------------------------------------------ */

/**
 * Loose-surface floors, m/s after four seconds of full throttle from rest.
 * RATCHET: it records that the fleet now manages 12.9-24.1 m/s on grass and
 * 13.1-24.6 on dirt, with about 15% held back. The reported build managed 7.1
 * (sedan) to 12.2 (suv) on grass and could not get a sedan up a bank at all.
 * Lower these when you improve them; never raise one to make a run go green.
 */
const OFFROAD_FLOOR = { grass: 11.0, dirt: 11.5 };
/**
 * How far a loose surface may break traction, and how hot the tyre may get
 * doing it. TWO WINDOWS, because they are two different claims:
 *
 *   ARMED    the launch itself, everything under 6 m/s, where `_hookUp` has
 *            full authority. This is the claim the fix makes and it is tight:
 *            the worst in the fleet is the muscle car at 0.254 on grass, and
 *            the reported build ran 1.60 there.
 *   WHOLE    the entire four seconds, which for the muscle car ends at
 *            75.6 km/h. Authority is faded out from 6 m/s and gone by 14, on
 *            purpose — a 320 kW rear-drive car lighting up its tyres on a
 *            field at 70 km/h is a driver's decision, not a defect — so the
 *            bar here is loose and only says the car is not in a burnout.
 *            MEASURED worst: slip 0.401, heat 0.275, both the muscle car.
 *
 * Do not "tidy" this into one window. Closing the whole-run window at the
 * target speed was tried, and it silently excluded the entire range where the
 * controllers hand authority back — a window drawn around the easy part.
 */
const OFFROAD_ARMED_SLIP = 0.35;
const OFFROAD_SLIP = 0.55;
const OFFROAD_HEAT = 0.40;

console.log('--- 2. launch off the road ---');
for (const type of FLEET) {
  for (const surface of ['grass', 'dirt']) {
    const r = standingStart(type, surface, { secs: 4 });
    const d = `4 s -> ${(r.speed * 3.6).toFixed(1)} km/h, peak slip ${r.peakSlip.toFixed(3)} ` +
      `(${r.armedSlip.toFixed(3)} under 6 m/s), skid ${r.skid.toFixed(2)} s, heat ${r.heat.toFixed(3)}`;
    check('offroad', `${type} pulls away on ${surface}`,
      r.speed >= OFFROAD_FLOOR[surface],
      `${d} (RATCHET ${OFFROAD_FLOOR[surface]} m/s)`);
    check('offroad', `${type} hooks up off the line on ${surface}`,
      r.armedSlip < OFFROAD_ARMED_SLIP, `${d} (want < ${OFFROAD_ARMED_SLIP} under 6 m/s)`);
    check('offroad', `${type} is not in a burnout on ${surface}`,
      r.peakSlip < OFFROAD_SLIP, `${d} (want < ${OFFROAD_SLIP})`);
    check('offroad', `${type} does not cook its tyres on ${surface}`,
      r.heat < OFFROAD_HEAT, `${d} (want < ${OFFROAD_HEAT})`);
  }
}

/* ------------------------------------------------------------------ */
/* 3. OFFROAD LATERAL — can you steer on the stuff you landed on?      */
/* ------------------------------------------------------------------ */

console.log('--- 3. lateral capability off the road ---');
for (const type of FLEET) {
  const road = lateralG(type, 'asphalt');
  for (const surface of ['grass', 'dirt']) {
    const off = lateralG(type, surface);
    const ratio = off / road;
    check('lateral', `${type} keeps ${Math.round(OFFROAD_LAT * 100)}% of its grip on ${surface}`,
      ratio >= OFFROAD_LAT,
      `${off.toFixed(3)} g vs ${road.toFixed(3)} g on asphalt = ${ratio.toFixed(2)}x ` +
      `(want >= ${OFFROAD_LAT}x)`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. CLIMB BACK — the bank between the verge and the road.            */
/* ------------------------------------------------------------------ */

/**
 * The site `tools/playprobe.mjs` finds when a drive test runs long enough to
 * leave the road: a 14.5 degree bank. The car is pointed UP it (the plane
 * falls toward +Z and the nose is +Z, so the slope is negative) at full
 * throttle from rest, and it has to actually go somewhere.
 */
console.log('--- 4. climbing back up a bank ---');
for (const type of FLEET) {
  for (const surface of ['grass', 'dirt']) {
    const r = standingStart(type, surface, { slope: -14.5, secs: 5 });
    check('climb', `${type} climbs a 14.5 deg ${surface} bank`,
      r.rise > 1.5,
      `risen ${r.rise.toFixed(2)} m in 5 s at ${r.speed.toFixed(2)} m/s (want > 1.5 m)`);
  }
}

/* ------------------------------------------------------------------ */
/* 5. KERB — from the verge back onto the carriageway.                 */
/* ------------------------------------------------------------------ */

/**
 * The report's exact manoeuvre: you are on the grass, the road is 15 cm up
 * behind a kerb face, and you are not arriving at it square. 90 degrees is
 * head-on; 60 is the 30 degree approach the target names; 45 is a glance.
 *
 * HONEST NOTE, because a green section is worth nothing without it: this one
 * was ALREADY green on the reported build. `_rideKerbs` and `_unstick` are the
 * work of an earlier wave and they hold — a sedan on the legacy grip band with
 * `debugOldTraction` set still mounts this kerb at a 30 degree approach in
 * 0.81 s. So no kerb constant was touched, and these are a REGRESSION GUARD on
 * the traction work rather than a fix of their own: the run-up now happens on
 * a much grippier verge and arrives faster, and a car that clears a kerb only
 * because it is carrying more speed would be a different bug waiting.
 */
console.log('--- 5. back over the kerb ---');
for (const type of FLEET) {
  for (const yawDeg of [90, 60, 45]) {
    const r = kerbClimb(type, { yawDeg, entryKmh: KERB_ENTRY_KMH });
    const d = `entered at ${(r.entry * 3.6).toFixed(1)} km/h`;
    check('kerb', `${type} climbs the kerb at ${90 - yawDeg} deg off square, ${KERB_ENTRY_KMH} km/h`,
      r.cleared,
      r.cleared
        ? `over in ${r.at.toFixed(2)} s, ${d}`
        : `stopped at x ${r.x.toFixed(2)} (want > ${r.wantX.toFixed(2)}), ` +
          `risen ${r.y.toFixed(3)} (want > ${r.wantY.toFixed(3)}), ${d}`);
    /**
     * ...and the run-up has to have HAPPENED. Without this the section would
     * pass just as well on a car that crawled at the kerb from a standstill,
     * which is a much easier test wearing this one's name.
     */
    check('kerb', `${type} reaches the kerb at speed (${90 - yawDeg} deg)`,
      r.entry >= (KERB_ENTRY_KMH / 3.6) * 0.85, `${d} (want >= ${(KERB_ENTRY_KMH * 0.85).toFixed(1)})`);
  }
}

/* ------------------------------------------------------------------ */
/* 6. NEGATIVE CONTROLS — every arm must go RED.                       */
/* ------------------------------------------------------------------ */

console.log('--- 6. negative controls (each must FAIL) ---');
let controls = 0;
let controlsRed = 0;
function control(name, wentRed, detail) {
  controls++;
  if (wentRed) controlsRed++;
  else { fail++; fails.push(`control: ${name} stayed GREEN — ${detail}`); }
  if (VERBOSE || !wentRed) {
    console.log(`${wentRed ? 'red ' : 'GREEN'} control ${name}  ${detail}`);
  }
}

// (a) `debugOldTraction` — the past-the-peak setpoint, no launch clamp.
for (const type of ['muscle', 'sedan']) {
  const r = standingStart(type, 'asphalt', { old: true });
  control(`${type} asphalt launch with debugOldTraction`,
    r.skid >= 0.05 || r.heat >= 0.05 || r.peakSlip >= LAUNCH_SLIP,
    `peak slip ${r.peakSlip.toFixed(3)}, skid ${r.skid.toFixed(2)} s, heat ${r.heat.toFixed(3)}`);
  const g = standingStart(type, 'grass', { old: true, secs: 4 });
  control(`${type} grass launch with debugOldTraction`,
    g.armedSlip >= OFFROAD_ARMED_SLIP || g.peakSlip >= OFFROAD_SLIP || g.heat >= OFFROAD_HEAT || g.speed < OFFROAD_FLOOR.grass,
    `4 s -> ${(g.speed * 3.6).toFixed(1)} km/h, peak slip ${g.peakSlip.toFixed(3)}, ` +
    `heat ${g.heat.toFixed(3)}`);
  /**
   * The bank is controlled against the REPORTED BUILD — both hatches — and
   * not against the launch clamp alone, because the two fixes overlap there
   * and the honest arm is the one that says so: with the new offroad band
   * under it, a muscle car still drags itself up a 14.5 degree grass slope
   * (4.16 m in 5 s) while its tyres are spinning. Grip alone is enough for a
   * 320 kW car; it was not enough for the sedan, which is the class the
   * report's site was measured on.
   */
  const c = standingStart(type, 'grass', { old: true, legacy: true, slope: -14.5, secs: 5 });
  control(`${type} grass bank climb on the reported build`,
    c.rise <= 1.5, `risen ${c.rise.toFixed(2)} m in 5 s`);
}

// (b) the legacy offroad grip band, through the live `gripOf` seam.
for (const type of ['sedan', 'suv', 'muscle']) {
  const road = lateralG(type, 'asphalt', true);
  const off = lateralG(type, 'grass', true);
  control(`${type} grass lateral on the legacy band`,
    off / road < OFFROAD_LAT,
    `${off.toFixed(3)} g vs ${road.toFixed(3)} g = ${(off / road).toFixed(2)}x`);
}

// (c) both together — the build the report was filed against.
{
  const r = standingStart('sedan', 'grass', { old: true, legacy: true, secs: 4 });
  control('sedan pulling away on grass on the reported build',
    r.speed < OFFROAD_FLOOR.grass || r.armedSlip >= OFFROAD_ARMED_SLIP || r.peakSlip >= OFFROAD_SLIP,
    `4 s -> ${(r.speed * 3.6).toFixed(1)} km/h, peak slip ${r.peakSlip.toFixed(3)}`);
}

/* ------------------------------------------------------------------ */

console.log('');
for (const f of fails) console.log(`FAIL ${f}`);
console.log(`tracprobe: ${pass}/${pass + fail} checks passed, ` +
  `${controlsRed}/${controls} negative controls red`);
process.exit(fail === 0 ? 0 : 1);
