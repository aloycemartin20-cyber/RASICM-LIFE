#!/usr/bin/env node
/**
 * TRAM PROBE — the trolley SERVICE runs the emitted rail line, and you can RIDE
 * it. Everything is gated on emitted motion and emitted transforms.
 *
 * The player asked for "the subway (trolley with windows) onto train tracks",
 * and then, having played it: "I don't see any trollys — add riding the trolly
 * or the incline with automatic cinematic camera". Both halves are gated here.
 * `railsweep` proves the track is one continuous line; this file proves a FLEET
 * runs on it often enough to be seen, and that a player can get on and off.
 *
 * It drives the REAL `TramService` (the object `VehicleSystem.update` owns in
 * the game) against the REAL emitted city graph — same generator, same seed as
 * `railsweep` — and asserts, on the positions the service emits into its
 * vehicle handles over simulated time:
 *
 *   fleet       more than one car is on the line, each with its own section;
 *   spawned     every car is standing ON the rail line;
 *   sweep       the UNION of the cars' arc coverage is the whole route, with
 *               no gap between neighbouring sections and no car parked;
 *   PRESENCE    sampled every 50 m along the line and at every instant, the
 *               distance to the NEAREST car. THIS is the check the report is
 *               about — "I don't see any trollys" is a presence complaint, not
 *               a wait-time one — and the single-car control fails it by a
 *               kilometre;
 *   interval    ...and the longest a player waits at a point for the next car,
 *               which the single-car control also fails;
 *   separation  one drawn track, so two carriages must never be in the same
 *               place — the closest approach over the whole run is measured;
 *   on-rails    lateral deviation from the drawn track stays ~0 for the WHOLE
 *               run (the body centre rides the chord between its two bogies,
 *               so the bound is small but not zero on curves — see RATCHET);
 *   height      the wheel plane follows the railhead over every grade;
 *   stops       it brakes INTO every mark and STANDS there long enough to be
 *               boarded, and `transit.dwelling` is true only while it stands;
 *   paused      dt <= 0 moves it by exactly nothing (the pause contract);
 *   RIDE        the real `VehicleHandler` + `CameraRig` + `Movement`: board at
 *               a stop, ride a segment under the cinematic camera, ring for
 *               the next stop, get put down on the platform.
 *
 * WHY THIS IS NOT CIRCULAR (ARCHITECTURE.md rule 12). The movers' own state
 * (`s`, `dir`, `v`) is never read. Every service assertion is on
 * `vehicle.position` sampled over time and compared against rail geometry this
 * file extracts ITSELF from `generateCity(...).graph` — endpoint-matched into a
 * chain by ITS OWN code, not by `extractRailLine` — so a mover that follows its
 * own wrong idea of the line goes red here even though it agrees with itself
 * perfectly. The railhead height offset (+0.17) is restated here from
 * `roadmesh._rail`'s emitted section (ballast +0.06, railhead +0.11), not
 * imported. The ride assertions are on the emitted camera quaternion, the
 * emitted body position expressed in the CAR'S OWN frame, and the emitted
 * refusal of a board — never on a flag the handler set for itself.
 *
 * WHAT CHANGED, AND WHY IT IS NOT RULE 13. "It sweeps the route end to end"
 * used to be asserted of THE car. The requirement changed with the fleet — one
 * drawn track means cars must short-turn on sections rather than meet head-on
 * — so the property is now asserted of the UNION at the same 900 m bound, plus
 * a per-car "not parked" check and a per-boundary "no gap" check. Nothing was
 * loosened to make a run go green; the same shape as the inverted assertion
 * documented in `src/ui/lockuxprobe.mjs`.
 *
 * NEGATIVE CONTROLS, run every time:
 *   paralysed   the same service with its timetable frozen (the live
 *               `paralysed` switch, no source edit): the sweep must go red —
 *               proving the positive arm's motion is what that check measures.
 *   one car     `{ cars: 1 }`, which is exactly what `?owOneTram=1` feeds — the
 *               build the report was written about. The PRESENCE and interval
 *               checks must both go red, or they are not measuring the fleet.
 *   offset      the positive arm's own recorded positions shifted 2.5 m off
 *               the track must trip the lateral check.
 *   moving      pressing F at a rolling carriage must do NOTHING — no prompt,
 *               no board, still on the pavement.
 *
 * Usage:  node src/vehicles/tramprobe.mjs [--verbose]
 */

import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { generateCity } from '../world/netgen.js';
import { Rng } from '../core/rng.js';
import { VEHICLE_SPECS, finalizeSpec } from './specs.js';
import { TramService } from './tram.js';
import { Movement } from '../player/movement.js';
import { VehicleHandler } from '../player/vehicle.js';
import { CameraRig } from '../player/camera.js';

const VERBOSE = process.argv.includes('--verbose');
const DT = 0.1;          // service is dt-agnostic; coarse steps keep this cheap
const RUN_S = 400;       // several section cycles (line ~1085 m, cycle ~106 s)
/** Railhead above a rail node's y — restated from roadmesh._rail (see header). */
const RAIL_HEAD = 0.06 + 0.11;

let pass = 0;
let fail = 0;
const fails = [];
function check(label, ok, detail) {
  if (ok) pass++;
  else { fail++; fails.push(`${label} — ${detail}`); }
  if (!ok || VERBOSE) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (${detail})`);
}

/* ================================================================== */
/* The emitted rail line, extracted INDEPENDENTLY of railmover.js      */
/* ================================================================== */

const terrain = new Terrain({ cell: 8, extent: 1792 });
const city = generateCity(terrain, new Rng(0x5eed1234).fork().fork());
const graph = city.graph;

/** Rail segments of the strip line, endpoints in world space (with y). */
const RAIL_SEGS = [];
for (const e of graph.edges) {
  if (!e.rail || !String(e.corridor ?? '').startsWith('rail_strip')) continue;
  const a = graph.nodes[e.a];
  const b = graph.nodes[e.b];
  RAIL_SEGS.push({ ax: a.x, ay: a.y ?? 0, az: a.z, bx: b.x, by: b.y ?? 0, bz: b.z });
}

/**
 * Chain the segments into an ordered polyline by greedy endpoint matching —
 * deliberately a different algorithm from railmover's weld-grid walk, so the
 * two cannot share a bug. O(n^2) on ~33 segments.
 */
function chainSegments(segs, eps = 1.6) {
  const eps2 = eps * eps;
  const d2 = (x1, z1, x2, z2) => (x1 - x2) ** 2 + (z1 - z2) ** 2;
  // Count how many segment-ends sit at each endpoint; degree-1 = an extremity.
  const ends = [];
  for (const s of segs) ends.push([s.ax, s.az], [s.bx, s.bz]);
  const degree = (x, z) => ends.reduce((n, e) => n + (d2(x, z, e[0], e[1]) < eps2 ? 1 : 0), 0);
  let start = null;
  for (const s of segs) {
    if (degree(s.ax, s.az) === 1) { start = { x: s.ax, y: s.ay, z: s.az }; break; }
    if (degree(s.bx, s.bz) === 1) { start = { x: s.bx, y: s.by, z: s.bz }; break; }
  }
  if (!start) return null;
  const used = new Array(segs.length).fill(false);
  const pts = [start];
  let cur = start;
  for (;;) {
    let found = -1;
    let flip = false;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      const s = segs[i];
      if (d2(cur.x, cur.z, s.ax, s.az) < eps2) { found = i; flip = false; break; }
      if (d2(cur.x, cur.z, s.bx, s.bz) < eps2) { found = i; flip = true; break; }
    }
    if (found < 0) break;
    used[found] = true;
    const s = segs[found];
    cur = flip ? { x: s.ax, y: s.ay, z: s.az } : { x: s.bx, y: s.by, z: s.bz };
    pts.push(cur);
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  }
  return { pts, cum, length: cum[cum.length - 1], segsUsed: used.filter(Boolean).length };
}

const LINE = chainSegments(RAIL_SEGS);

/** Project (x,z) onto the chained line: arc s, lateral distance, rail y. */
function project(line, x, z, out) {
  let best = Infinity;
  let bs = 0;
  let by = 0;
  for (let i = 0; i < line.pts.length - 1; i++) {
    const a = line.pts[i];
    const b = line.pts[i + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 1e-9 ? ((x - a.x) * dx + (z - a.z) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = a.x + dx * t;
    const pz = a.z + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      bs = line.cum[i] + Math.sqrt(L2) * t;
      by = a.y + (b.y - a.y) * t;
    }
  }
  out.s = bs;
  out.lat = best;
  out.railY = by;
  return out;
}

/* ================================================================== */
/* Harness: the REAL TramService on a stub vehicle system              */
/* ================================================================== */

/**
 * The `world` façade the service is allowed to see. `heightAt`/`isWater` are
 * here because the stop furniture has to stand on dry ground it can measure —
 * without them the platform solver has nothing to seat a platform on and the
 * CLEARANCE gate below would pass vacuously on four missing anchors.
 */
function makeCtx() {
  return {
    peek: (id) => (id === 'world' ? {
      roads: graph,
      heightAt: (x, z) => terrain.heightAt(x, z),
      isWater: (x, z) => terrain.isWater(x, z),
    } : null),
    events: { emit() {} },
    time: {},
  };
}

function makeVehicle(spec, type, pos, yaw, opts) {
  return {
    spec, type, opts, yaw0: yaw,
    position: new THREE.Vector3().copy(pos),
    prevPosition: new THREE.Vector3().copy(pos),
    quaternion: new THREE.Quaternion(),
    prevQuaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(),
    angularVelocity: new THREE.Vector3(),
    control: { throttle: 0, brake: 0, steer: 0 },
    input: {},
    destroyed: false,
    sleeping: true,   // the service must hold it awake itself
    _sleepTimer: 9,
    speed: 0,
    forwardSpeed: 0,
    model: { root: null },
    health: 3600, maxHealth: 3600,
    fuel: 100, maxFuel: 100, fuelDry: false,
    drivetrain: { rpm: 0, gearLabel: '1' },
    horn: false, altitude: 0, submerged: 0, drowned: false,
  };
}

function makeSys() {
  return {
    spawned: [],
    specOf(type) { return finalizeSpec(VEHICLE_SPECS[type]); },
    spawn(type, pos, yaw, opts) {
      const v = makeVehicle(finalizeSpec(VEHICLE_SPECS[type]), type, pos, yaw, opts);
      this.spawned.push(v);
      return v;
    },
  };
}

/**
 * Run a service for `seconds`, recording the EMITTED trajectory of EVERY car.
 *
 * `bogF`/`bogR` are where a vehicle's bogie pivots actually ARE, derived from
 * the emitted `position` + `quaternion` (the pose the renderer draws) — "do the
 * drawn wheels stand on the drawn rails" is asked of those, because the body
 * CENTRE of a carriage legitimately swings inside a curve on the chord between
 * its bogies.
 */
const _bog = new THREE.Vector3();
function bogieLat(v, sign, pr) {
  _bog.set(0, -v.spec.comY, sign * 3.8).applyQuaternion(v.quaternion).add(v.position);
  project(LINE, _bog.x, _bog.z, pr);
  return pr.lat;
}

/**
 * @returns {{ t: number[], cars: Array<Array<object>> }} one track per car,
 *          index-aligned with `service.cars`.
 */
function run(service, ctx, seconds) {
  const pr = { s: 0, lat: 0, railY: 0 };
  const steps = Math.round(seconds / DT);
  const out = { t: [], cars: [] };
  for (let i = 0; i < steps; i++) {
    service.update(DT, ctx);
    if (!service.cars.length) continue;
    while (out.cars.length < service.cars.length) out.cars.push([]);
    out.t.push(i * DT);
    for (let c = 0; c < service.cars.length; c++) {
      const v = service.cars[c].vehicle;
      project(LINE, v.position.x, v.position.z, pr);
      const rec = {
        t: i * DT,
        x: v.position.x, y: v.position.y, z: v.position.z,
        s: pr.s, lat: pr.lat, railY: pr.railY, bog: 0,
        dwelling: service.cars[c].transit.dwelling === true,
      };
      rec.bog = Math.max(bogieLat(v, 1, pr), bogieLat(v, -1, pr));
      out.cars[c].push(rec);
    }
  }
  return out;
}

/* ================================================================== */
/* Measurement helpers — all over EMITTED positions                    */
/* ================================================================== */

/**
 * "IS THERE A TROLLEY NEAR ME RIGHT NOW" — the worst answer over the run.
 *
 * This is the check the report is actually about. "I don't see any trollys" is
 * not a wait-time complaint, it is a PRESENCE complaint: with one car on 1085 m
 * of track, the nearest trolley to a player standing at the far end was over a
 * kilometre away for most of every cycle, so the line read as abandoned even
 * when the service was running perfectly.
 *
 * Returns the largest distance, over every sampled point and every sampled
 * instant, from that point to the NEAREST car — measured along the arc, which
 * is the direction you can actually see down a rail corridor.
 */
function worstNearest(tracks, points) {
  let worst = 0;
  let atS = 0;
  let atT = 0;
  const n = tracks[0].length;
  for (let i = 0; i < n; i++) {
    for (const sp of points) {
      let near = Infinity;
      for (let c = 0; c < tracks.length; c++) {
        const d = Math.abs(tracks[c][i].s - sp);
        if (d < near) near = d;
      }
      if (near > worst) { worst = near; atS = sp; atT = tracks[0][i].t; }
    }
  }
  return { worst, atS, atT };
}

/**
 * Service interval at one point on the line: the longest wait between one car
 * clearing the point and the next one arriving.
 *
 * A "passage" begins on the frame a car's projected arc first comes inside
 * `HEADWAY_WIN` of `sp` — the rising edge of occupancy across ALL cars, so a
 * stop served alternately by the cars either side of an interchange counts
 * both. Returns `Infinity` when the point is served fewer than twice in the
 * run, which is the honest answer for "how long do I wait" and is what makes
 * the one-car control go red rather than merely score badly.
 */
const HEADWAY_WIN = 12;
function headwayAt(tracks, sp) {
  const n = tracks[0].length;
  const edges = [];
  let was = false;
  for (let i = 0; i < n; i++) {
    let occ = false;
    for (let c = 0; c < tracks.length; c++) {
      if (Math.abs(tracks[c][i].s - sp) <= HEADWAY_WIN) { occ = true; break; }
    }
    if (occ && !was) edges.push(tracks[0][i].t);
    was = occ;
  }
  if (edges.length < 2) return { gap: Infinity, visits: edges.length };
  let gap = 0;
  for (let i = 1; i < edges.length; i++) gap = Math.max(gap, edges[i] - edges[i - 1]);
  return { gap, visits: edges.length };
}

/** Every span of consecutive frames a car spent at a standstill, in seconds. */
function standStills(track) {
  const out = [];
  let run0 = -1;
  for (let i = 1; i < track.length; i++) {
    const moved = Math.hypot(
      track[i].x - track[i - 1].x, track[i].y - track[i - 1].y, track[i].z - track[i - 1].z
    );
    const still = moved < 1e-6;
    if (still && run0 < 0) run0 = track[i - 1].t;
    if (!still && run0 >= 0) { out.push(track[i - 1].t - run0); run0 = -1; }
  }
  return out;
}

/* ================================================================== */
/* 0. The line itself (precondition, not the subject — railsweep owns it) */
/* ================================================================== */

check('emitted rail_strip line chains end to end',
  !!LINE && LINE.segsUsed === RAIL_SEGS.length && LINE.length > 1000,
  LINE ? `${LINE.segsUsed}/${RAIL_SEGS.length} segs, ${LINE.length.toFixed(0)} m` : 'no line');
if (!LINE) { report(); }

/* ================================================================== */
/* 1. The service, positive arm                                        */
/* ================================================================== */

const sys = makeSys();
const svc = new TramService(sys);
const T = run(svc, makeCtx(), RUN_S);
const tracks = T.cars;
const comY = finalizeSpec(VEHICLE_SPECS.tram).comY;

check('a FLEET runs the line, not one car',
  svc.cars.length >= 2 && sys.spawned.length === svc.cars.length,
  `${svc.cars.length} cars spawned, ${svc.stops.length} stops ` +
  `(${svc.stops.map((s) => s.s.toFixed(0)).join(' / ')} m)`);

check('every car is enterable only as a RIDE, never as a TAKE',
  svc.cars.every((c) => c.vehicle.enterable === false && !!c.vehicle.transit),
  svc.cars.map((c) => `${c.vehicle.enterable}`).join(','));

if (tracks.length) {
  check('every car spawned ON the rail line',
    tracks.every((tr) => tr[0].lat < 0.5),
    tracks.map((tr) => tr[0].lat.toFixed(2)).join(' / ') + ' m off the track');

  /* ---- the fleet covers the whole route ------------------------------ */
  let bogMax = 0;
  let chordMax = 0;
  let dyMax = 0;
  const spans = [];
  let unionMin = Infinity;
  let unionMax = -Infinity;
  for (const tr of tracks) {
    let sMin = Infinity;
    let sMax = -Infinity;
    for (const p of tr) {
      if (p.s < sMin) sMin = p.s;
      if (p.s > sMax) sMax = p.s;
      if (p.bog > bogMax) bogMax = p.bog;
      if (p.lat > chordMax) chordMax = p.lat;
      const dy = Math.abs(p.y - (p.railY + RAIL_HEAD + comY));
      if (dy > dyMax) dyMax = dy;
    }
    spans.push({ sMin, sMax });
    unionMin = Math.min(unionMin, sMin);
    unionMax = Math.max(unionMax, sMax);
  }
  /**
   * WHAT "SWEEPS THE ROUTE" MEANS NOW, AND WHY IT CHANGED.
   *
   * This used to assert that THE car swept > 900 m end to end, and it was the
   * right assertion for a service with one car on it. The requirement changed
   * with the fleet (see `tram.js`): each car now short-turns on its own
   * section, because there is one drawn track and two carriages meeting on it
   * is not a timetable problem. The property that must survive is the one the
   * old check was really protecting — EVERY PART OF THE LINE IS SERVED — so it
   * is asserted at the fleet level, plus a per-car check that no car is parked.
   *
   * That is the same shape as the inverted assertion in `src/ui/lockuxprobe.mjs`
   * and not rule 13: no bar was raised to make a run go green, and the union
   * bound (> 900 m) is the number the single car had to clear on its own.
   */
  check('the FLEET sweeps the route end to end', unionMax - unionMin > 900,
    `union arc span ${(unionMax - unionMin).toFixed(0)} m of ${LINE.length.toFixed(0)} ` +
    `over ${tracks.length} car(s)`);
  check('...and no section is a car parked on a siding',
    spans.every((s) => s.sMax - s.sMin > 200),
    spans.map((s) => `${(s.sMax - s.sMin).toFixed(0)}m`).join(' / '));
  check('...with no gap between neighbouring sections',
    spans.every((s, i) => i === 0 || s.sMin - spans[i - 1].sMax < 2 * 10 + 4),
    spans.map((s) => `${s.sMin.toFixed(0)}..${s.sMax.toFixed(0)}`).join(' | '));

  /**
   * RATCHET (rule 13), two bounds with two meanings:
   *
   *   bogies    where the WHEELS are, from the emitted pose. MEASURED 0.12 m
   *             worst (the residue of two independent weld reconstructions of
   *             the same emitted segments); the bar is ~3x that. This is the
   *             "stays ON the rails" assertion. LOWER it if the weld residue
   *             shrinks; never raise it to admit a wanderer.
   *   centre    the body centre rides the CHORD between bogies 7.6 m apart,
   *             so at the emitted line's sharpest junction jog (34.7 deg at
   *             s=225) it legitimately stands INSIDE the curve — that is how a
   *             carriage corners, not an error. MEASURED 1.01 m there; the
   *             bar says it can never be much more than its own geometry
   *             allows (chord sagitta at 35 deg), i.e. the body cannot leave
   *             the 5 m ballast bed.
   *
   * The offset control below proves the bogie check catches a vehicle 2.5 m
   * off the line.
   */
  check('every car\'s wheels stay on the rails all run', bogMax < 0.35,
    `worst bogie lateral ${bogMax.toFixed(2)} m (RATCHET < 0.35)`);
  check('no car\'s body leaves the ballast bed', chordMax < 1.4,
    `worst centre chord-swing ${chordMax.toFixed(2)} m (sharpest emitted jog allows ~1.0)`);
  check('every car\'s wheels follow the track height', dyMax < 0.45,
    `worst wheel-plane error ${dyMax.toFixed(2)} m over every grade`);

  /* ---- PRESENCE and SERVICE. These are the checks the report is about. */
  /**
   * "I DON'T SEE ANY TROLLYS."
   *
   * RATCHET (rule 13), and read the diagnosis before touching either bar.
   *
   * presence  the worst distance from any point on the line to the nearest
   *           car, at any instant. A car never leaves its own section, so the
   *           bound is structural: one section plus the marks' inset. MEASURED
   *           on the three-car fleet — printed below; the bar is 420 m, about
   *           one section. The single-car control reads a kilometre, which is
   *           the build the report was written about. LOWER this by adding
   *           cars; never raise it.
   * interval  how long a player standing at a POINT waits between cars. The
   *           worst point on a short-worked line is a TERMINUS, which a
   *           shuttle serves once per round trip by construction — MEASURED
   *           107 s there against 54 s mid-section and at the interchanges,
   *           where two cars serve. 115 s records where this pass got to, not
   *           where the bar belongs: the honest fix is a through-routed line,
   *           and that needs a PASSING LOOP the drawn single track does not
   *           have (`roadmesh._rail` lays one bed and one pair of railheads
   *           per edge). Lower it with a fourth car or a loop; never raise it.
   */
  const points = [];
  for (let sp = 30; sp <= LINE.length - 30; sp += 50) points.push(sp);
  const near = worstNearest(tracks, points);
  check('there is always a trolley somewhere near you on the line',
    near.worst < 420,
    `worst distance to the nearest car ${near.worst.toFixed(0)} m ` +
    `(at s=${near.atS} m, t=${near.atT.toFixed(0)} s; RATCHET < 420 m)`);

  let worstGap = 0;
  let worstAt = 0;
  let unserved = 0;
  let visitsMin = Infinity;
  for (const sp of points) {
    const h = headwayAt(tracks, sp);
    if (h.visits === 0) unserved++;
    visitsMin = Math.min(visitsMin, h.visits);
    if (h.gap > worstGap) { worstGap = h.gap; worstAt = sp; }
  }
  check('a trolley comes past every point on the line, often',
    worstGap < 115 && unserved === 0,
    `worst service interval ${worstGap === Infinity ? 'never' : worstGap.toFixed(0) + ' s'} ` +
    `(at s=${worstAt.toFixed(0)} m; RATCHET < 115 s), ${unserved} point(s) never served, ` +
    `min ${visitsMin} visits in ${RUN_S} s`);

  /* ---- two carriages, one track: they must never meet ---------------- */
  let sepMin = Infinity;
  let sepAt = 0;
  if (tracks.length > 1) {
    for (let i = 0; i < tracks[0].length; i++) {
      for (let a = 0; a < tracks.length; a++) {
        for (let b = a + 1; b < tracks.length; b++) {
          const p = tracks[a][i];
          const q = tracks[b][i];
          const d = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
          if (d < sepMin) { sepMin = d; sepAt = p.t; }
        }
      }
    }
  }
  check('no two cars ever occupy the same track',
    tracks.length < 2 || sepMin > 15,
    `closest approach ${sepMin === Infinity ? 'n/a' : sepMin.toFixed(1) + ' m'} ` +
    `at t=${sepAt.toFixed(0)} s (a car is 14 m long; RATCHET > 15 m)`);

  /* ---- speed profile, from EMITTED positions only -------------------- */
  let vPeak = 0;
  let vNearStop = 0;
  const marks = svc.stops.map((s) => s.s);
  for (const tr of tracks) {
    for (let i = 1; i < tr.length; i++) {
      const a = tr[i - 1];
      const b = tr[i];
      const sp = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / DT;
      if (sp > vPeak) vPeak = sp;
      let dMark = Infinity;
      for (const mk of marks) dMark = Math.min(dMark, Math.abs(b.s - mk));
      if (dMark < 16 && sp > vNearStop) vNearStop = sp;
    }
  }
  check('it cruises at tram pace', vPeak > 6 && vPeak < 12,
    `peak ${vPeak.toFixed(1)} m/s (measured 9.0 — the service cap)`);
  check('it brakes INTO every stop', vNearStop < 5.5,
    `fastest emitted speed within 16 m of a mark: ${vNearStop.toFixed(1)} m/s`);

  /* ---- it STANDS at its marks, long enough to be boarded -------------- */
  const stills = tracks.map(standStills);
  const shortest = Math.min(...stills.map((s) => (s.length ? Math.min(...s) : 0)));
  check('every car STANDS at its marks long enough to board',
    stills.every((s) => s.length >= 2) && shortest > 6,
    stills.map((s) => `${s.length} stops, shortest ${s.length ? Math.min(...s).toFixed(1) : 0} s`)
      .join(' · ') + ' (want >= 2 stops, > 6 s)');

  /**
   * THE BOARDING GATE, read off the same emitted trajectory: `transit.dwelling`
   * must be true when and only when the car is standing still. It is the one
   * boolean `src/player/vehicle.js` refuses a board on, so a service that
   * reported it while rolling would let a player step into a moving carriage.
   */
  let dwellMoving = 0;
  let dwellFrames = 0;
  for (const tr of tracks) {
    for (let i = 0; i < tr.length - 1; i++) {
      // Measured across a pair of CONSECUTIVE dwelling frames: the frame a car
      // ARRIVES is a dwelling frame that legitimately moved to get there, and
      // scoring that as a moving dwell would be the probe grading its own
      // sampling rather than the service.
      if (!tr[i].dwelling || !tr[i + 1].dwelling) continue;
      dwellFrames++;
      const moved = Math.hypot(
        tr[i + 1].x - tr[i].x, tr[i + 1].y - tr[i].y, tr[i + 1].z - tr[i].z
      );
      if (moved > 1e-6) dwellMoving++;
    }
  }
  check('"dwelling" means standing still, every frame it is true',
    dwellFrames > 0 && dwellMoving === 0,
    `${dwellFrames} dwelling frame pairs, ${dwellMoving} of them moving`);

  // ---- the pause contract -------------------------------------------------
  const frozen = tracks.map((_, i) => {
    const p = svc.cars[i].vehicle.position;
    return { x: p.x, y: p.y, z: p.z };
  });
  const ctx0 = makeCtx();
  for (let i = 0; i < 10; i++) svc.update(0, ctx0);
  let moved = 0;
  for (let i = 0; i < tracks.length; i++) {
    const p = svc.cars[i].vehicle.position;
    moved += Math.hypot(p.x - frozen[i].x, p.y - frozen[i].y, p.z - frozen[i].z);
  }
  check('a stopped clock stops the whole fleet (dt=0 moves it 0 m)', moved === 0,
    `${moved.toFixed(4)} m over ${tracks.length} car(s)`);

  // ---- collidable city furniture, not ghosts -----------------------------
  check('every car is kinematic and awake for the collision pass',
    svc.cars.every((c) => c.vehicle.kinematic === true && c.vehicle.sleeping === false),
    svc.cars.map((c) => `${c.vehicle.kinematic}/${c.vehicle.sleeping}`).join(' '));

  /* ---- STOP FURNITURE CLEARANCE --------------------------------------- */
  /**
   * THE REPORT: "trolly station facade is in the middle of the street".
   *
   * A stop mark is SNAPPED TO A ROAD CROSSING on purpose, so anything built at
   * the mark is on the carriageway by construction — MEASURED on this graph,
   * BUTLER STREET's mark is 1.52 m from the centreline of a 15.2 m arterial
   * and FOUNDRY TERMINUS's is 0.32 m from a 7.2 m street. The furniture is
   * therefore offset to the pavement side, and this is the gate on that.
   *
   * RULE 12. Nothing below calls `tram.js`'s `carriagewayDist`, reads
   * `PLATFORM_OFF` or asks the service whether it thinks it cleared anything.
   * It takes the EMITTED anchor off each stop and measures it against the
   * emitted graph with carriageway arithmetic written here — each edge against
   * its own `width`, the rail against the tram's own body from `transit.hw`.
   */
  const HALF_BODY = svc.cars[0]?.transit?.hw ?? 1.3;
  const SLAB = 1.3;              // half the platform slab, across the rail
  let worstRoad = Infinity;
  let worstRail = Infinity;
  let placed = 0;
  const rows = [];
  for (const st of svc.stops) {
    const p = st.platform;
    if (!p) { rows.push(`${st.name}: none`); continue; }
    placed++;
    // Into the carriageway of every drivable edge, its own width.
    let road = Infinity;
    for (const e of graph.edges) {
      if (!e || e.rail) continue;
      const na = graph.nodes[e.a];
      const nb = graph.nodes[e.b];
      if (!na || !nb) continue;
      const dx = nb.x - na.x;
      const dz = nb.z - na.z;
      const L2 = dx * dx + dz * dz;
      let t = L2 > 1e-9 ? ((p.x - na.x) * dx + (p.z - na.z) * dz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      road = Math.min(road,
        Math.hypot(p.x - (na.x + dx * t), p.z - (na.z + dz * t)) - (e.width ?? 7) * 0.5 - SLAB);
    }
    // ...and into the tram's own envelope, measured on the extracted LINE.
    const pr = { s: 0, lat: 0, railY: 0 };
    project(LINE, p.x, p.z, pr);
    const rail = pr.lat - SLAB - HALF_BODY;
    worstRoad = Math.min(worstRoad, road);
    worstRail = Math.min(worstRail, rail);
    rows.push(`${st.name}: ${road.toFixed(2)} m off tarmac, ${rail.toFixed(2)} m off the car`);
  }
  check('every stop gets furniture on ground it can stand on',
    placed === svc.stops.length, `${placed}/${svc.stops.length} — ${rows.join('; ')}`);
  check('CLEARANCE: no stop furniture stands on a carriageway',
    worstRoad > 0, `worst ${worstRoad.toFixed(2)} m clear of the nearest kerb face`);
  check('CLEARANCE: ...nor inside the tram\'s own envelope',
    worstRail > 0, `worst ${worstRail.toFixed(2)} m clear of the widest point of a car`);
  /**
   * THE NEGATIVE CONTROL, and it is the whole point of the two checks above:
   * the same measurement taken AT THE MARK — where the furniture used to go —
   * has to go red, or the gate is measuring the graph rather than the fix.
   */
  let markRoad = Infinity;
  for (const st of svc.stops) {
    for (const e of graph.edges) {
      if (!e || e.rail) continue;
      const na = graph.nodes[e.a];
      const nb = graph.nodes[e.b];
      if (!na || !nb) continue;
      const dx = nb.x - na.x;
      const dz = nb.z - na.z;
      const L2 = dx * dx + dz * dz;
      let t = L2 > 1e-9 ? ((st.x - na.x) * dx + (st.z - na.z) * dz) / L2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      markRoad = Math.min(markRoad,
        Math.hypot(st.x - (na.x + dx * t), st.z - (na.z + dz * t)) - (e.width ?? 7) * 0.5 - SLAB);
    }
  }
  check('CONTROL: furniture AT the mark would stand on the carriageway',
    markRoad < 0, `at the marks: ${markRoad.toFixed(2)} m — negative is inside the lanes`);
}

/* ================================================================== */
/* 2. NEGATIVE CONTROLS                                                */
/* ================================================================== */

{
  const sys2 = makeSys();
  const svc2 = new TramService(sys2, { paralysed: true });
  const T2 = run(svc2, makeCtx(), 60);
  /**
   * PER CAR, deliberately, not the union. A paralysed fleet still SPAWNS its
   * three cars spread across the line, so the union span is ~950 m with
   * nothing moving at all — which is exactly why the union check on its own is
   * not the motion assertion and the per-car "not parked on a siding" one is.
   * This control fails that check, and would fail it on a one-car build too.
   */
  let worstSpan = 0;
  for (const tr of T2.cars) {
    let s0 = Infinity;
    let s1 = -Infinity;
    for (const p of tr) { if (p.s < s0) s0 = p.s; if (p.s > s1) s1 = p.s; }
    worstSpan = Math.max(worstSpan, s1 - s0);
  }
  check('CONTROL: a paralysed fleet fails the "not parked" check', !(worstSpan > 200),
    `busiest car moved ${worstSpan.toFixed(2)} m in 60 s — the per-car sweep assertion goes red`);
  check('CONTROL: ...while still standing on the rail',
    T2.cars.length > 0 && T2.cars.every((tr) => tr[0].lat < 0.5),
    T2.cars.map((tr) => tr[0].lat.toFixed(2)).join('/') + ' m');
}

{
  /**
   * THE BUILD THE REPORT WAS WRITTEN ABOUT: one car, whole line. This is the
   * `?owOneTram=1` arm exactly — `opts.cars` is the same switch the hatch
   * feeds — and it must fail the headway check, or that check is measuring
   * something other than the fleet.
   */
  const sys3 = makeSys();
  const svc3 = new TramService(sys3, { cars: 1 });
  const T3 = run(svc3, makeCtx(), RUN_S);
  let worst = 0;
  const pts3 = [];
  for (let sp = 30; sp <= LINE.length - 30; sp += 50) {
    pts3.push(sp);
    const h = headwayAt(T3.cars, sp);
    if (h.gap > worst) worst = h.gap;
  }
  const near3 = worstNearest(T3.cars, pts3);
  check('CONTROL: one car on the whole line fails the presence check',
    svc3.cars.length === 1 && !(near3.worst < 420),
    `nearest trolley was ${near3.worst.toFixed(0)} m away at worst ` +
    '— the build the report was about');
  check('CONTROL: ...and its service interval too',
    !(worst < 115),
    `worst service interval ${worst === Infinity ? 'never' : worst.toFixed(0) + ' s'} ` +
    'with a single car');
}

/* ================================================================== */
/* 3. CHECKER SELF-CHECK — the on-rails test can fail                  */
/* ================================================================== */

{
  const pr = { s: 0, lat: 0, railY: 0 };
  let worst = 0;
  const tr = tracks[0] ?? [];
  for (let i = 0; i < tr.length; i += 25) {
    const p = tr[i];
    project(LINE, p.x + 2.5, p.z, pr);
    if (pr.lat > worst) worst = pr.lat;
  }
  check('CONTROL: a tram 2.5 m off the track trips the on-rails check', worst > 0.35,
    `offset trajectory reads ${worst.toFixed(2)} m worst lateral vs the 0.35 bogie bar`);
}

/* ================================================================== */
/* 4. THE RIDE — board as a passenger, cinematic camera, alight        */
/* ================================================================== */
/**
 * Everything above is about the SERVICE. This section is about being ON it,
 * and it drives the REAL `VehicleHandler`, the REAL `CameraRig` and the REAL
 * `Movement` against the REAL `TramService` — no reimplementation of the
 * boarding rules, and every assertion on an emitted transform or an emitted
 * refusal rather than on a flag the code set for itself.
 *
 * THE STUBS, AND WHAT EACH ONE IS AN ASSERTION ABOUT (rule 12's corollary: a
 * stub claims nothing downstream of it can be wrong, so say it out loud):
 *
 *   physics       `checkCapsule` always clear and `sphereCast` never hits, so
 *                 the exit placement and the ride camera solve their FIRST
 *                 choice. This section therefore measures WHERE the handler
 *                 wants to put the player and the lens, not whether the world
 *                 lets it — `interactprobe` runs the same sequence against the
 *                 real collision world.
 *   character     a point that teleports, standing in for
 *                 `physics.createCharacter`. It asserts nothing about capsule
 *                 resolution; `m.position` is read only to confirm the actor
 *                 was PUT DOWN beside the car rather than left in the seat.
 *   vehicles      `setInput` is REAL in the sense that matters: it counts. A
 *                 passenger forwarding a control is the defect this section
 *                 exists to catch, so the call is recorded, never stubbed out.
 */

const RIDE_DT = 1 / 60;

function stubCharacter() {
  return {
    enabled: true, height: 1.78, stepHeight: 0.4, radius: 0.32,
    position: new THREE.Vector3(),
    teleport(x, y, z) { this.position.set(x, y, z); },
    setPosition(x, y, z) { this.position.set(x, y, z); },
  };
}

function makeRideRig() {
  let groundY = 0;
  const phys = {
    MASK: { WORLD: 3, CHARACTER: 3 },
    groundHeight: () => groundY,
    checkCapsule: () => true,
    sphereCast: () => ({ hit: false, distance: Infinity }),
  };
  const held = new Set();
  const input = {
    held,
    moveVector(out = { x: 0, y: 0 }) {
      out.x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
      out.y = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0);
      return out;
    },
    action: (k) => held.has(k),
    actionPressed: () => false,
  };
  const listeners = new Map();
  const events = {
    emitted: [],
    emit(name, p) {
      events.emitted.push({ name, passenger: p?.passenger, vehicle: p?.vehicle });
      for (const f of (listeners.get(name) ?? []).slice()) f(p);
    },
    on(name, f) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(f);
      return () => {};
    },
  };
  const time = { dt: RIDE_DT, elapsed: 0, alpha: 1, frame: 0 };
  const sysR = makeSys();
  const inputCalls = { n: 0 };
  const registry = {
    physics: phys,
    vehicles: {
      get vehicles() { return sysR.spawned; },
      setInput() { inputCalls.n++; },
      setDoor() { inputCalls.n += 1000; }, // a transit door must never be swung
      setDriver() { inputCalls.n += 1000; },
      clearDriver() { inputCalls.n += 1000; },
      nearest: () => null,
    },
  };
  const ctx = {
    time, events, input, config: { fov: 65 },
    peek: (k) => registry[k] ?? null,
  };
  const player = { controlEnabled: true, health: { dead: false } };
  const m = new Movement(ctx, player);
  m.grounded = true;
  m.character = stubCharacter();
  player.movement = m;
  const rig = new CameraRig(ctx);
  player.rig = rig;
  const handler = new VehicleHandler(ctx, player);
  player.vehicles = handler;
  const svcR = new TramService(sysR);
  const health = { fraction: 1, suppression: 0 };

  const frame = () => {
    time.frame++;
    time.elapsed += RIDE_DT;
    svcR.update(RIDE_DT, makeCtx());
    if (svcR.cars.length) {
      const v = svcR.cars[0].vehicle;
      groundY = v.position.y - v.spec.comY;
    }
    handler.update(RIDE_DT, m);
    rig.setVehicle(handler.seated ? handler.vehicle : null);
    rig.update(RIDE_DT, m, health);
  };
  return { ctx, m, rig, handler, svc: svcR, frame, input, inputCalls, events, phys };
}

{
  const R = makeRideRig();
  R.frame();
  const car = R.svc.cars[0];
  const v = car.vehicle;

  /** Stand the player at the kerb beside the car, on the ballast. */
  const standBeside = () => {
    const off = new THREE.Vector3(2.0, -v.spec.comY, -4.35).applyQuaternion(v.quaternion);
    R.m.position.set(v.position.x + off.x, v.position.y + off.y, v.position.z + off.z);
    R.m.prevPosition.copy(R.m.position);
    R.m.grounded = true;
    R.m.swimming = false;
  };

  /* ---- the negative control FIRST, while it is rolling --------------- */
  let guard = 0;
  while (car.transit.dwelling && guard++ < 4000) R.frame();
  // ...and let it get properly rolling. The frame the dwell expires the car is
  // released at exactly 0 m/s, and refusing a board at 0 m/s would not tell
  // anyone whether the gate is the dwell or the speed.
  for (let i = 0; i < 90; i++) R.frame();
  standBeside();
  R.frame();
  const movingPrompt = R.handler.prompt ? R.handler.prompt.text : null;
  R.handler.candidate = v;                       // what `freeroam._board` does
  const boardedMoving = R.handler.tryEnter(R.m);
  check('CONTROL: you cannot board a moving trolley',
    boardedMoving === false && R.handler.phase === 'none' && movingPrompt === null,
    `tryEnter -> ${boardedMoving}, phase ${R.handler.phase}, prompt ${movingPrompt ?? 'none'} ` +
    `at ${car.transit.speed.toFixed(1)} m/s`);

  /* ---- ...and now at the stop ---------------------------------------- */
  guard = 0;
  while (!car.transit.dwelling && guard++ < 12000) R.frame();
  standBeside();
  R.frame();
  const stopPrompt = R.handler.prompt ? `${R.handler.prompt.text} · ${R.handler.prompt.sub}` : null;
  check('standing at a stop offers the RIDE',
    R.handler.prompt?.text === 'RIDE' && R.handler.candidate === v,
    stopPrompt ?? 'no prompt offered');

  const boarded = R.handler.tryEnter(R.m);
  guard = 0;
  while (R.handler.phase !== 'drive' && guard++ < 400) R.frame();
  check('F at the stop seats you as a PASSENGER',
    boarded && R.handler.phase === 'drive' && R.handler.passenger === true &&
    R.handler.transit === car.transit,
    `boarded ${boarded}, phase ${R.handler.phase}, passenger ${R.handler.passenger}`);
  check('...and the ride camera takes over',
    R.rig.cinematicActive === true && R.rig.cinematicShot !== null,
    `cinematic ${R.rig.cinematicActive}, opening shot "${R.rig.cinematicShot}"`);
  check('...announced as a PASSENGER, not as a driver',
    R.events.emitted.some((e) => e.name === 'vehicle:enter' && e.passenger === true),
    R.events.emitted.filter((e) => e.name.startsWith('vehicle:')).map((e) => e.name).join(','));

  /* ---- ride a whole segment ------------------------------------------ */
  const shots = new Set();
  let cuts = 0;
  let framedOff = 0;
  let framedN = 0;
  let insideOut = 0;
  let insideN = 0;
  let camMoved = 0;
  const camPrev = new THREE.Vector3().copy(R.rig.position);
  const toCar = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const seatErr = { min: Infinity, max: -Infinity };
  const seatLocal = new THREE.Vector3();
  const invQ = new THREE.Quaternion();
  // Sample from the moment the doors shut — the rest of THIS dwell plus the
  // whole of the next segment, which is what "ride one segment" means.
  let rideFrames = 0;
  function sample() {
    shots.add(R.rig.cinematicShot);
    if (R.rig.cine.cut) cuts++;
    camMoved += camPrev.distanceTo(R.rig.position);
    camPrev.copy(R.rig.position);
    // Is the car actually IN the picture? Angle between the lens axis and the
    // direction to the car, off the emitted quaternion.
    if (R.rig.cinematicShot === 'window') {
      // The INTERIOR shot's subject is not the carriage, it is the view out of
      // it — the lens is in the saloon and the body it would be "framing" is
      // all around it. So the assertion is the one that means something there:
      // the lens is INSIDE the car, in the car's own frame.
      insideN++;
      seatLocal.copy(R.rig.position).sub(v.position)
        .applyQuaternion(invQ.copy(v.quaternion).invert());
      const h = v.spec.half;
      if (Math.abs(seatLocal.x) > h.x || Math.abs(seatLocal.z) > h.z ||
          Math.abs(seatLocal.y) > h.y + 0.4) insideOut++;
    } else {
      toCar.subVectors(v.position, R.rig.position);
      if (toCar.lengthSq() > 1e-6) {
        toCar.normalize();
        fwd.set(0, 0, -1).applyQuaternion(R.rig.quaternion);
        framedN++;
        if (fwd.dot(toCar) < Math.cos(30 * Math.PI / 180)) framedOff++;
      }
    }
    // ...and is the body still in its seat, in the CAR's own frame?
    seatLocal.copy(R.m.position).sub(v.position)
      .applyQuaternion(invQ.copy(v.quaternion).invert());
    seatErr.min = Math.min(seatErr.min, seatLocal.z);
    seatErr.max = Math.max(seatErr.max, seatLocal.z);
    rideFrames++;
  }
  guard = 0;
  while (car.transit.dwelling && guard++ < 4000) { R.frame(); sample(); }
  guard = 0;
  while (!car.transit.dwelling && guard++ < 12000) { R.frame(); sample(); }
  const rideS = rideFrames * RIDE_DT;
  check('the reel CUTS between authored framings while you ride',
    shots.size >= 3 && cuts >= 2,
    `${shots.size} distinct shots over ${rideS.toFixed(0)} s: ${[...shots].join(', ')} · ${cuts} cuts`);
  check('...and every EXTERIOR one keeps the car in the picture',
    framedN > 0 && framedOff / framedN < 0.02,
    `${framedOff}/${framedN} exterior frames with the car more than 30 deg off the lens axis`);
  check('...and the interior one is actually inside the saloon',
    insideN > 0 && insideOut === 0,
    `${insideOut}/${insideN} over-shoulder frames with the lens outside the carriage`);
  check('...from a camera that is actually moving',
    camMoved > 20,
    `${camMoved.toFixed(0)} m of lens travel over the segment`);
  check('the passenger rides IN the car, not behind it',
    seatErr.max - seatErr.min < 0.05,
    `seat drift in the carriage's own frame: ${(seatErr.max - seatErr.min).toFixed(4)} m fore/aft`);
  check('a passenger forwards NO controls to the service',
    R.inputCalls.n === 0 &&
    R.handler.throttle === 0 && R.handler.brake === 0 && R.handler.steer === 0,
    `${R.inputCalls.n} setInput/setDoor/setDriver calls, ` +
    `throttle ${R.handler.throttle}, steer ${R.handler.steer}`);

  /* ---- a move key hands the camera back, without ending the ride ------ */
  R.input.held.add('forward');
  for (let i = 0; i < 12; i++) R.frame();
  R.input.held.delete('forward');
  check('a move key takes the camera back but you stay aboard',
    R.rig.cinematicActive === false && R.handler.phase === 'drive' &&
    R.handler.passenger === true,
    `cinematic ${R.rig.cinematicActive}, phase ${R.handler.phase}`);

  /* ---- F rings for the next stop and puts you on the platform -------- */
  guard = 0;
  while (car.transit.dwelling && guard++ < 4000) R.frame();
  const rang = R.handler.tryExit(R.m);
  check('F between stops rings for the next one instead of refusing',
    rang === true && R.handler.alightRequested === true && R.handler.phase === 'drive',
    `tryExit -> ${rang}, requested ${R.handler.alightRequested}, phase ${R.handler.phase}`);

  guard = 0;
  while (R.handler.phase !== 'none' && guard++ < 12000) R.frame();
  const off = new THREE.Vector3().subVectors(R.m.position, v.position);
  const half = v.spec.half;
  const lateral = Math.hypot(off.x, off.z);
  check('...and the next dwell puts you down on the platform',
    R.handler.phase === 'none' && R.handler.passenger === false &&
    R.m.driving === false && car.transit.dwelling === true &&
    lateral > half.x && lateral < half.z + 4,
    `phase ${R.handler.phase}, ${lateral.toFixed(2)} m from the car centre ` +
    `(body is ${(half.x * 2).toFixed(1)} x ${(half.z * 2).toFixed(1)} m), ` +
    `dwelling ${car.transit.dwelling}`);
  check('...with the ride camera handed back',
    R.rig.cinematicActive === false && R.handler.transit === null,
    `cinematic ${R.rig.cinematicActive}, transit ${R.handler.transit}`);
}

report();

function report() {
  console.log('');
  console.log(`${pass}/${pass + fail} tram assertions pass`);
  if (fail) {
    console.log('');
    for (const f of fails) console.log(`  - ${f}`);
  }
  process.exit(fail ? 1 : 0);
}
