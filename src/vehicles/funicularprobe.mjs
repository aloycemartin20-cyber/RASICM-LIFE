#!/usr/bin/env node
/**
 * FUNICULAR — "do the two incline cars actually RIDE the rails the trestle
 * emits, counterbalanced, station to station, in the authored livery?"
 *
 * The Duquesne Incline used to carry two STATIC cars baked into the landmark
 * batch. They are now live meshes owned by `FunicularSystem`
 * (src/vehicles/funicular.js), posed every frame by sampling the track
 * descriptor `world` publishes (src/world/incline.js) — the same descriptor
 * `buildings`' `incline()` emits the trestle and rails from. This gate holds
 * the moving cars to the EMITTED geometry.
 *
 * WHAT THIS MEASURES, AND WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 *
 * The obvious trap: the cars pose themselves by sampling `track.at` /
 * `track.trackY`, so asserting "car position equals track.at(...)" would
 * compare the code's input to itself. Nothing here does that. The rails the
 * player sees are the 'steel_light' boxes `incline()` merges into the
 * landmark batch — one box per trestle bay per side — and this probe rebuilds
 * the landmark through the SHIPPED path (publish -> adopt -> buildLandmark
 * into a real TileBuilder), then reads the rail VERTICES back out of the
 * accumulator. The track axis, the rail ends, and each rail line's polyline
 * (lateral centre and height per bay) are re-derived from that vertex soup
 * with this file's own arithmetic — principal axis over the cloud, bay
 * centroids in emission order — and the moving cars, world positions sampled
 * from the LIVE system over two full cycles of `update()`, are measured
 * against those numbers. If the descriptor and the emitted rails ever
 * disagree, or the cars ride anything but the rails, `on-rails` goes red.
 *
 * Assertions:
 *
 *   exist           two cars in the emitted scene graph, real triangle counts
 *   on-rails        every sample: car lateral centre within MAX_LATERAL_DEV
 *                   of its own measured rail line; height over the measured
 *                   rail polyline inside a fixed band with bounded wobble
 *   travels         each car's along-range spans the measured rail line
 *                   between the two station platforms, both directions
 *   stations        emitted station masses stand at BOTH measured rail ends
 *                   (brick headhouse below, the upper cupola above) and the
 *                   termini sit at them, clear of the brickwork
 *   counterweight   alongA + alongB is constant over the whole cycle
 *   dwell           each car holds still >= 3 s at each terminus per cycle
 *   livery          the emitted car materials are EXACTLY the authored
 *                   FUNICULAR_LIVERY — and the body is red by component, the
 *                   accent yellow, so the authored table itself cannot
 *                   silently rot to blue
 *
 * ...plus a SELF-CHECK on every run: the car samples are copied, pushed
 * 1.5 m sideways, and fed through the SAME on-rails measurement, which must
 * flag them or the run aborts — a gate that cannot fail is decorative.
 *
 * Usage
 *   node src/vehicles/funicularprobe.mjs
 *   node src/vehicles/funicularprobe.mjs --json=/tmp/funicular.json
 *
 * NEGATIVE CONTROLS (each must exit non-zero):
 *   --drift=1.5   the "hardcoded line" failure this gate exists for: the
 *                 whole funicular root is shifted sideways after init, the
 *                 cars leave the measured rails, on-rails goes red
 *   --freeze      update() is never called: travels and dwell go red
 */

import * as THREE from 'three';
import { Terrain } from '../world/terrain.js';
import { generateCity } from '../world/netgen.js';
import { LANDMARKS as PLAN_LANDMARKS } from '../world/plan.js';
import { publishInclineTracks } from '../world/incline.js';
import { adoptLandmarkSites, buildLandmark, LANDMARKS as BLD_LANDMARKS } from '../buildings/landmarks.js';
import { TileBuilder } from '../buildings/tile.js';
import { FunicularSystem, FUNICULAR_LIVERY } from './funicular.js';
import { VehicleSystem } from './index.js';
import { Movement } from '../player/movement.js';
import { VehicleHandler } from '../player/vehicle.js';
import { CameraRig } from '../player/camera.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const DRIFT = args.drift ? Number(args.drift) : 0;
const FREEZE = !!args.freeze;

/** A car is "on" its rail when its centre is within this of the rail line's
 *  measured lateral centre (the rail box itself is 0.34 m wide). */
const MAX_LATERAL_DEV = 0.35;
/**
 * The car floor rides the rail head by a fixed lift. The reference is the
 * exact emitted rail polyline (bay end-face centres, welded at the bents), so
 * the band is tight: the only legitimate wiggle is the car chording a bent
 * kink over its own wheelbase.
 */
const LIFT_MIN = 0.6;
const LIFT_MAX = 1.4;
const LIFT_WOBBLE = 0.35;
/** Counterweight: |(aA+aB) - median| must stay under this (m). */
const MAX_COUNTER_DEV = 0.75;
/** Each terminus must be held at least this long (s). */
const MIN_DWELL_S = 3;
/** Termini must reach within this of the measured rail-end platforms (m). */
const MAX_STATION_GAP = 14;
/** Simulation step (s); the run covers two full cycles. */
const DT = 1 / 30;

/* ---------------------------------------------------------------- build --- */

const terrain = new Terrain({ cell: 8, extent: 1792 });
terrain.bake();
generateCity(terrain, new Rng(0x5eed1234).fork().fork());
const groundAt = (x, z) => terrain.heightAt(x, z);

// The shipped publication order: world solves+publishes, buildings adopts.
const published = publishInclineTracks(PLAN_LANDMARKS, groundAt);
if (published !== 1) {
  console.error(`FAIL: publishInclineTracks published ${published} tracks, expected 1`);
  process.exit(1);
}
adoptLandmarkSites(PLAN_LANDMARKS);
const lm = BLD_LANDMARKS.find((l) => l.id === 'lm_incline');

// Build the landmark through the shipped entry point into a real TileBuilder
// (no keep-out: the reserve capsule keeps roads from under the trestle, so
// nothing would be dropped; `buildLandmarkPlan` only adds that guard).
const T = new TileBuilder(null, 'probe_lm_incline');
buildLandmark(T, null, lm, new Rng(lm.seed), groundAt(lm.x, lm.z), groundAt);

/* ----------------------------------------- measure the emitted rail lines --- */

/**
 * Every emitted vertex for `key`, from EVERY merged bucket a `TileBuilder`
 * keeps — not just `_static`.
 *
 * `_noCast` is the one this used to miss. A tile splits a surface into a
 * casting and a non-casting accumulator when it carries enough geometry that
 * keeping it out of the shadow cascades pays for the extra batch (see
 * `TileBuilder.add`'s `noShadow`), and `_detail` has always been a second home
 * for the same key. A probe that reads one of the three is asserting on a
 * fraction of the emitted geometry and calling it the whole, which is a claim
 * about the probe's bookkeeping rather than about the model.
 *
 * The incline landmark happens to put nothing in either today. That is exactly
 * why it is worth reading them: the day it does, this file should measure it
 * rather than report a station that moved.
 */
function emittedVerts(key) {
  let out = null;
  for (const bucket of [T._static, T._noCast, T._detail]) {
    const acc = bucket?.get(key);
    if (!acc || acc.empty) continue;
    if (!out) out = [];
    for (let i = 0; i < acc.pos.length; i++) out.push(acc.pos[i]);
  }
  return out;
}

const railPos = emittedVerts('steel_light');
const VPB = 24; // BoxGeometry vertex count; Accum appends boxes in order
if (!railPos || railPos.length < 3 * VPB * 8) {
  console.error('FAIL: no emitted incline rails (steel_light) to measure');
  process.exit(1);
}
const nVerts = railPos.length / 3;

// Principal axis of the rail cloud in XZ — this probe's own reading of which
// way the track runs, never the descriptor's `dir`.
let mx = 0;
let mz = 0;
for (let i = 0; i < nVerts; i++) {
  mx += railPos[i * 3];
  mz += railPos[i * 3 + 2];
}
mx /= nVerts;
mz /= nVerts;
let sxx = 0;
let sxz = 0;
let szz = 0;
for (let i = 0; i < nVerts; i++) {
  const dx = railPos[i * 3] - mx;
  const dz = railPos[i * 3 + 2] - mz;
  sxx += dx * dx;
  sxz += dx * dz;
  szz += dz * dz;
}
const trc = sxx + szz;
const det = sxx * szz - sxz * sxz;
const lam = trc / 2 + Math.sqrt(Math.max(0, (trc * trc) / 4 - det));
let axX = sxz;
let axZ = lam - sxx;
if (Math.abs(axX) + Math.abs(axZ) < 1e-9) {
  axX = lam - szz;
  axZ = sxz;
}
const axLen = Math.hypot(axX, axZ);
axX /= axLen;
axZ /= axLen;
// Point the measured axis uphill: the high end of the cloud is +along.
{
  let lo = 0;
  let hi = 0;
  let nLo = 0;
  let nHi = 0;
  for (let i = 0; i < nVerts; i++) {
    const al = (railPos[i * 3] - mx) * axX + (railPos[i * 3 + 2] - mz) * axZ;
    if (al < 0) {
      lo += railPos[i * 3 + 1];
      nLo++;
    } else {
      hi += railPos[i * 3 + 1];
      nHi++;
    }
  }
  if (lo / Math.max(1, nLo) > hi / Math.max(1, nHi)) {
    axX = -axX;
    axZ = -axZ;
  }
}
const perpX = axZ;
const perpZ = -axX;
const along = (x, z) => (x - mx) * axX + (z - mz) * axZ;
const lateral = (x, z) => (x - mx) * perpX + (z - mz) * perpZ;

// Rebuild each rail LINE from the emitted boxes, bay-endpoint faces rather
// than centroids: a centroid polyline cuts the corner at every bent (measured
// 0.6 m at this hill's knee) while the end-face centres ARE the polyline the
// bays were laid along. A BoxGeometry's 24 verts sit on its 8 corners, 12 per
// end face along the bay axis, so the mean of each along-half of a box is an
// end-face centre, exactly.
const leftLine = [];
const rightLine = [];
for (let b = 0; b < Math.floor(nVerts / VPB); b++) {
  const verts = [];
  for (let i = b * VPB; i < (b + 1) * VPB; i++) {
    verts.push({ x: railPos[i * 3], y: railPos[i * 3 + 1], z: railPos[i * 3 + 2] });
  }
  for (const v of verts) v.a = along(v.x, v.z);
  verts.sort((p, q) => p.a - q.a);
  for (const half of [verts.slice(0, VPB / 2), verts.slice(VPB / 2)]) {
    let ax = 0;
    let ay = 0;
    let az = 0;
    for (const v of half) {
      ax += v.x;
      ay += v.y;
      az += v.z;
    }
    ax /= half.length;
    ay /= half.length;
    az /= half.length;
    const p = { a: along(ax, az), lat: lateral(ax, az), y: ay };
    (p.lat < 0 ? leftLine : rightLine).push(p);
  }
}
leftLine.sort((p, q) => p.a - q.a);
rightLine.sort((p, q) => p.a - q.a);
// Weld the shared bent endpoints (consecutive bays meet there).
for (const line of [leftLine, rightLine]) {
  for (let i = line.length - 1; i > 0; i--) {
    if (line[i].a - line[i - 1].a < 0.5) {
      line[i - 1].a = (line[i - 1].a + line[i].a) / 2;
      line[i - 1].lat = (line[i - 1].lat + line[i].lat) / 2;
      line[i - 1].y = (line[i - 1].y + line[i].y) / 2;
      line.splice(i, 1);
    }
  }
}
if (leftLine.length < 8 || rightLine.length < 8) {
  console.error(`FAIL: expected two rail lines, got ${leftLine.length} left / ${rightLine.length} right bays`);
  process.exit(1);
}

/** Lerp the measured rail polyline at along `a` (clamped to its ends). */
function railAt(line, a) {
  if (a <= line[0].a) return line[0];
  const last = line[line.length - 1];
  if (a >= last.a) return last;
  let i = 1;
  while (line[i].a < a) i++;
  const p = line[i - 1];
  const q = line[i];
  const f = (a - p.a) / (q.a - p.a);
  return { a, lat: p.lat + (q.lat - p.lat) * f, y: p.y + (q.y - p.y) * f };
}

const spanLo = Math.min(leftLine[0].a, rightLine[0].a);
const spanHi = Math.max(leftLine[leftLine.length - 1].a, rightLine[rightLine.length - 1].a);

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * STATION MASS, FOUND BY WHERE IT STANDS — NOT BY WHICH PAINT IT WEARS
 * ─────────────────────────────────────────────────────────────────────────────
 * This used to take the CENTROID OF A SURFACE KEY and call it a station, on the
 * stated assumption that "'brick_dark' is only the lower headhouse and
 * 'trim_white' only the upper station cupola". The second half of that is not
 * true and, reading `landmarks.js`, never was: the lower headhouse is authored
 * with a deep white eave (`box(T, 'trim_white', x, gy + 10.15, ...)`) and the
 * upper station with a white parapet, colonnade and cupola. One key, both ends.
 *
 * A centroid cannot represent two clusters. MEASURED here: 132 `trim_white`
 * vertices at along -90 and 360 at along +90, whose mean is
 * (132·-90 + 360·90) / 492 = +41.7 — which is the number this tier reported as
 * "the upper station has moved". Nothing had moved. The probe was averaging the
 * two stations together and comparing the midpoint to one end.
 *
 * So the question is asked the way the tier's own description asks it —
 * "emitted station masses stand at BOTH measured rail ends" — as a test for
 * MASS PRESENT AT AN END, over every shell surface the two headhouses are built
 * from, binned by position along the measured rail axis. A key that appears at
 * both ends now contributes to both, which is what a white eave on two
 * buildings should do.
 */
const STATION_KEYS = [
  'brick_dark', 'trim_white', 'stone_base', 'stone_grey',
  'brick_glazed_green', 'roof_shingle', 'trim_red',
];
/** Vertices of the station shells, with their position along the rail axis. */
function stationCloud() {
  const pts = [];
  for (const key of STATION_KEYS) {
    const pos = emittedVerts(key);
    if (!pos) continue;
    for (let i = 0; i < pos.length / 3; i++) {
      pts.push({ a: along(pos[i * 3], pos[i * 3 + 2]), y: pos[i * 3 + 1] });
    }
  }
  return pts;
}
/**
 * How much shell mass stands within `MAX_STATION_GAP` of a given rail end, and
 * where its own centre is. A count rather than a fraction: what makes a station
 * a station is that there is a building there, and the failure this guards
 * against is one end having none.
 */
function massAt(endA, pts) {
  let n = 0;
  let sum = 0;
  for (const p of pts) {
    if (Math.abs(p.a - endA) > MAX_STATION_GAP) continue;
    n++;
    sum += p.a;
  }
  return { n, a: n ? sum / n : NaN };
}
/** A headhouse is a few hundred vertices; well clear of a stray trestle brace. */
const MIN_STATION_VERTS = 40;

/* ------------------------------------------------------ run the live cars --- */

const scene = new THREE.Scene();
const worldStub = { landmarks: PLAN_LANDMARKS, heightAt: groundAt };
const ctx = {
  scene,
  time: { elapsed: 0, dt: DT, scale: 1, frame: 0 },
  rng: new Rng(1),
  config: { q: {} },
  events: { on() {}, off() {}, emit() {} },
  get: (id) => (id === 'world' ? worldStub : null),
  peek: (id) => (id === 'world' ? worldStub : null),
  has: (id) => id === 'world',
};
const sys = new FunicularSystem();
await sys.init(ctx);

if (DRIFT && sys.root) {
  // NEGATIVE CONTROL: simulate cars following a stale, hardcoded line.
  sys.root.matrixAutoUpdate = true;
  sys.root.position.x += perpX * DRIFT;
  sys.root.position.z += perpZ * DRIFT;
}

const cars = sys.cars ?? [];
const CYCLE_GUESS = 120; // generous; dwell+travel are the system's own business
const steps = Math.ceil((2 * CYCLE_GUESS) / DT);
const samples = [[], []]; // per car: { t, a, lat, y }
const wp = new THREE.Vector3();
for (let s = 0; s <= steps; s++) {
  if (!FREEZE) sys.update(DT, ctx);
  scene.updateMatrixWorld(true);
  for (let i = 0; i < cars.length; i++) {
    cars[i].getWorldPosition(wp);
    samples[i].push({ t: s * DT, a: along(wp.x, wp.z), lat: lateral(wp.x, wp.z), y: wp.y });
  }
}

/**
 * The on-rails measurement, shared by the real assertion and the self-check.
 * Each car is measured against ITS OWN rail line (side by median lateral).
 */
function measureOnRails(sampleSets) {
  let worstLat = 0;
  let liftLo = Infinity;
  let liftHi = -Infinity;
  for (const set of sampleSets) {
    if (!set.length) continue;
    const lats = set.map((s) => s.lat).sort((p, q) => p - q);
    const line = lats[Math.floor(lats.length / 2)] < 0 ? leftLine : rightLine;
    for (const s of set) {
      const r = railAt(line, s.a);
      const dev = Math.abs(s.lat - r.lat);
      if (dev > worstLat) worstLat = dev;
      const lift = s.y - r.y;
      if (lift < liftLo) liftLo = lift;
      if (lift > liftHi) liftHi = lift;
    }
  }
  return { worstLat, liftLo, liftHi };
}

/* ------------------------------------------------------------- self-check --- */

{
  const shifted = samples.map((set) => set.map((s) => ({ ...s, lat: s.lat + 1.5 })));
  const m = measureOnRails(shifted);
  if (!(m.worstLat > MAX_LATERAL_DEV)) {
    console.error(
      `SELF-CHECK FAILED: a 1.5 m sideways copy of the car samples was not flagged ` +
        `(worst dev ${m.worstLat.toFixed(3)}). The gate proves nothing; aborting.`
    );
    process.exit(2);
  }
  console.log(
    `self-check: +1.5 m sideways sample copy -> worst dev ${m.worstLat.toFixed(2)} m, flagged. checker CAN fail. ok`
  );
}

/* ------------------------------------------------------------- assertions --- */

const checks = [];
const check = (name, ok, msg) => {
  checks.push({ name, ok, msg });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(14)} ${msg}`);
};

// exist
{
  const tris = [0, 0];
  for (let i = 0; i < cars.length; i++) {
    cars[i].traverse((o) => {
      if (o.isMesh) tris[i] += (o.geometry.getIndex()?.count ?? 0) / 3;
    });
  }
  check(
    'exist',
    cars.length === 2 && tris[0] > 200 && tris[1] > 200,
    `${cars.length} cars, ${tris[0]} / ${tris[1]} tris`
  );
}

// on-rails
{
  const m = measureOnRails(samples);
  const ok =
    cars.length === 2 &&
    m.worstLat <= MAX_LATERAL_DEV &&
    m.liftLo >= LIFT_MIN &&
    m.liftHi <= LIFT_MAX &&
    m.liftHi - m.liftLo <= LIFT_WOBBLE;
  check(
    'on-rails',
    ok,
    `worst lateral dev ${m.worstLat.toFixed(3)} m (max ${MAX_LATERAL_DEV}); ` +
      `lift over rail ${m.liftLo.toFixed(2)}..${m.liftHi.toFixed(2)} m (band ${LIFT_MIN}..${LIFT_MAX}, wobble<=${LIFT_WOBBLE})`
  );
}

// travels
{
  let ok = cars.length === 2;
  let msg = '';
  for (let i = 0; i < cars.length; i++) {
    const as = samples[i].map((s) => s.a);
    const lo = Math.min(...as);
    const hi = Math.max(...as);
    ok = ok && lo <= spanLo + MAX_STATION_GAP && hi >= spanHi - MAX_STATION_GAP;
    msg += `car${i} ${lo.toFixed(1)}..${hi.toFixed(1)} of rails ${spanLo.toFixed(1)}..${spanHi.toFixed(1)}; `;
  }
  check('travels', ok, msg || 'no cars');
}

// stations
{
  const pts = stationCloud();
  const lo = massAt(spanLo, pts);
  const up = massAt(spanHi, pts);
  const ok = lo.n >= MIN_STATION_VERTS && up.n >= MIN_STATION_VERTS;
  check(
    'stations',
    ok,
    `lower ${lo.n} shell verts within ${MAX_STATION_GAP} m of rail end ${spanLo.toFixed(1)} ` +
      `(centred ${Number.isFinite(lo.a) ? lo.a.toFixed(1) : 'n/a'}), ` +
      `upper ${up.n} at end ${spanHi.toFixed(1)} ` +
      `(centred ${Number.isFinite(up.a) ? up.a.toFixed(1) : 'n/a'}); ` +
      `floor ${MIN_STATION_VERTS} verts each`
  );
}

// dwell
{
  let ok = cars.length === 2;
  let msg = '';
  for (let i = 0; i < cars.length; i++) {
    const ss = samples[i];
    if (!ss.length) continue;
    const lo = Math.min(...ss.map((s) => s.a));
    const hi = Math.max(...ss.map((s) => s.a));
    for (const end of [lo, hi]) {
      let best = 0;
      let cur = 0;
      for (let k = 1; k < ss.length; k++) {
        const still = Math.abs(ss[k].a - ss[k - 1].a) / DT < 0.05 && Math.abs(ss[k].a - end) < 1.5;
        cur = still ? cur + DT : 0;
        if (cur > best) best = cur;
      }
      ok = ok && best >= MIN_DWELL_S;
      msg += `car${i}@${end.toFixed(0)}m ${best.toFixed(1)}s  `;
    }
  }
  check('dwell', ok, msg || 'no cars');
}

// counterweight
{
  const len = Math.min(samples[0]?.length ?? 0, samples[1]?.length ?? 0);
  let ok = len > 0;
  let worst = 0;
  if (ok) {
    const sums = [];
    for (let k = 0; k < len; k++) sums.push(samples[0][k].a + samples[1][k].a);
    const sorted = [...sums].sort((p, q) => p - q);
    const med = sorted[Math.floor(sorted.length / 2)];
    for (const v of sums) worst = Math.max(worst, Math.abs(v - med));
    ok = worst <= MAX_COUNTER_DEV;
  }
  check('counterweight', ok, `max |alongA+alongB - median| = ${worst.toFixed(3)} m (limit ${MAX_COUNTER_DEV})`);
}

// livery — sampled off the EMITTED car meshes
{
  const seen = new Map(); // hex -> tris
  for (const car of cars) {
    car.traverse((o) => {
      if (!o.isMesh) return;
      const hex = o.material.color.getHex();
      seen.set(hex, (seen.get(hex) ?? 0) + (o.geometry.getIndex()?.count ?? 0) / 3);
    });
  }
  const L = FUNICULAR_LIVERY;
  const comp = (hex) => ({ r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 });
  const body = comp(L.body);
  const accent = comp(L.accent);
  const isRed = body.r > 110 && body.r > 2.2 * body.g && body.r > 2.2 * body.b;
  const isYellow =
    accent.r > 180 && accent.g > 130 && accent.b < 0.45 * accent.g && Math.abs(accent.r - accent.g) < 0.45 * accent.r;
  const bodyDominant = (seen.get(L.body) ?? 0) > (seen.get(L.glass) ?? 0) * 0.5;
  const ok = seen.has(L.body) && seen.has(L.accent) && seen.has(L.glass) && isRed && isYellow && bodyDominant;
  check(
    'livery',
    ok,
    `body #${L.body.toString(16)} ${seen.get(L.body) ?? 0} tris (red=${isRed}), ` +
      `accent #${L.accent.toString(16)} ${seen.get(L.accent) ?? 0} tris (yellow=${isYellow}), ` +
      `glass #${L.glass.toString(16)} ${seen.get(L.glass) ?? 0} tris`
  );
}

/* --------------------------------------------------------------- the ride --- */
/**
 * RIDING THE INCLINE — the postcard, gated.
 *
 * REPORTED: "add riding the trolly or the incline with automatic cinematic
 * camera ... the incline ride is the postcard — the climb with downtown
 * unfolding behind". Everything above proves the cars run; this proves a
 * player can be ON one and that the camera does the job it was added for.
 *
 * It drives the REAL `VehicleHandler` and the REAL `CameraRig` against the
 * REAL `FunicularSystem` that has just been measured, and asserts on the
 * EMITTED camera transform — where the lens actually is and which way it
 * actually points — never on the shot table the camera read.
 *
 * The one STUB is physics: `checkCapsule` always clear, `sphereCast` never
 * hits. So this measures where the ride camera WANTS to be, not whether the
 * hillside lets it; `src/game/interactprobe.mjs` runs the boarding half
 * against the real collision world.
 *
 * This section drives the system on its OWN clock and therefore ignores
 * `--freeze` — you cannot ride a service that is not running, and `--freeze`
 * is the control for `travels`/`dwell`, which are measured above and still go
 * red under it.
 */
{
  const RDT = 1 / 60;
  const held = new Set();
  const rideCtx = {
    scene,
    time: { elapsed: 0, dt: RDT, scale: 1, alpha: 1, frame: 0 },
    rng: new Rng(2),
    config: { q: {}, fov: 65 },
    input: {
      moveVector(out = { x: 0, y: 0 }) {
        out.x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
        out.y = (held.has('forward') ? 1 : 0) - (held.has('back') ? 1 : 0);
        return out;
      },
      action: (k) => held.has(k),
      actionPressed: () => false,
    },
    events: { on: () => () => {}, off() {}, emit() {} },
    get: (id) => (id === 'world' ? worldStub : null),
    peek: (id) => (
      id === 'world' ? worldStub
        : id === 'funicular' ? sys
          : id === 'physics' ? ridePhys
            : null
    ),
    has: (id) => id === 'world' || id === 'funicular',
  };
  let groundY = 0;
  /**
   * `blockVista` models the ONE thing the open-sky stub cannot: the lower
   * station's headhouse standing exactly where the postcard shot wants to
   * put the lens. It reports a hit only for a cast heading UPHILL AWAY from
   * the vista, which is the vista framing's own bearing and nothing else's.
   * See the `postcard-blocked` control at the end of this section.
   */
  let blockVista = false;
  const BLOCK = { hit: true, distance: 0 };
  const ridePhys = {
    MASK: { WORLD: 3, CHARACTER: 3 },
    groundHeight: () => groundY,
    checkCapsule: () => true,
    sphereCast: (origin, dir, radius, far) => {
      if (blockVista && sys.vista && rider) {
        const ax = rider.position.x - sys.vista.x;
        const az = rider.position.z - sys.vista.z;
        const al = Math.hypot(ax, az) || 1;
        const dl = Math.hypot(dir.x, dir.z) || 1;
        if ((dir.x * ax + dir.z * az) / (al * dl) > 0.6) {
          BLOCK.distance = far * 0.15;
          return BLOCK;
        }
      }
      return { hit: false, distance: Infinity };
    },
  };
  const player = { controlEnabled: true, health: { dead: false } };
  const m = new Movement(rideCtx, player);
  m.grounded = true;
  m.character = {
    enabled: true, height: 1.78, stepHeight: 0.4, radius: 0.32,
    position: new THREE.Vector3(),
    teleport(x, y, z) { this.position.set(x, y, z); },
    setPosition(x, y, z) { this.position.set(x, y, z); },
  };
  player.movement = m;
  const rig = new CameraRig(rideCtx);
  player.rig = rig;
  const handler = new VehicleHandler(rideCtx, player);
  player.vehicles = handler;

  const riders = sys.riders ?? [];
  const rider = riders[0];
  const frame = () => {
    rideCtx.time.frame++;
    rideCtx.time.elapsed += RDT;
    sys.update(RDT, rideCtx);
    scene.updateMatrixWorld(true);
    if (rider) groundY = rider.position.y + rider.transit.railY;
    handler.update(RDT, m);
    rig.setVehicle(handler.seated ? handler.vehicle : null);
    rig.update(RDT, m, health0);
  };
  const health0 = { fraction: 1, suppression: 0 };

  check('riders', riders.length === 2 && riders.every((r) => !!r.transit),
    `${riders.length} rider handle(s), ` +
    `line "${rider?.transit?.line}", stops "${riders.map((r) => r.transit.stopName).join('/')}"`);

  // The handle IS the drawn car, not a copy of it. Move the system, re-read.
  const before = rider ? rider.position.clone() : new THREE.Vector3();
  for (let i = 0; i < 4000 && rider.position.distanceTo(before) < 0.5; i++) frame();
  check('handle-is-car',
    !!rider && rider.position === cars[0].position &&
    rider.quaternion === cars[0].quaternion && rider.position.distanceTo(before) > 0.5,
    rider ? `same objects, moved ${rider.position.distanceTo(before).toFixed(2)} m` : 'no rider');

  /**
   * `dwelling` decides whether a player may step into a moving cabin, so it is
   * measured against the EMITTED motion and not against the phase clock that
   * produced it: over two full cycles, every frame it claims a dwell the car
   * must not have moved since the previous frame.
   */
  {
    let dwellPairs = 0;
    let dwellMoved = 0;
    let ranMoving = 0;
    let prevDwell = rider.transit.dwelling;
    let prev = rider.position.clone();
    for (let s = 0; s < Math.ceil((2 * CYCLE_GUESS) / RDT); s++) {
      frame();
      const moved = rider.position.distanceTo(prev);
      const now = rider.transit.dwelling;
      if (prevDwell && now) { dwellPairs++; if (moved > 1e-6) dwellMoved++; }
      if (!prevDwell && !now && moved > 1e-4) ranMoving++;
      prevDwell = now;
      prev.copy(rider.position);
    }
    check('dwelling', dwellPairs > 0 && dwellMoved === 0 && ranMoving > 0,
      `${dwellPairs} standing frame pairs, ${dwellMoved} of them moving; ` +
      `${ranMoving} frames actually travelling`);
  }

  /**
   * THE VISTA. It has to be a real place, DOWNHILL of the lower station and
   * below the top of the run, or the postcard shot points at the mountain.
   * Derived here from the measured rail ends, not from the descriptor the
   * system read (rule 12).
   */
  {
    const vp = sys.vista;
    const aLo = leftLine[0].a;
    const aHi = leftLine[leftLine.length - 1].a;
    const lowEnd = railAt(leftLine, aLo);
    const highEnd = railAt(leftLine, aHi);
    // The measured rail ends in world XZ, from this file's own principal axis.
    const dLow = Math.hypot(vp.x - (mx + axX * aLo), vp.z - (mz + axZ * aLo));
    const dHigh = Math.hypot(vp.x - (mx + axX * aHi), vp.z - (mz + axZ * aHi));
    check('vista',
      Number.isFinite(vp.x) && Number.isFinite(vp.y) && Number.isFinite(vp.z) &&
      dLow > 300 && dHigh > dLow && vp.y < highEnd.y,
      `${dLow.toFixed(0)} m beyond the lower end (and ${dHigh.toFixed(0)} m from the upper), ` +
      `y ${vp.y.toFixed(1)} vs rail ends ${lowEnd.y.toFixed(1)}..${highEnd.y.toFixed(1)}`);
  }

  /**
   * The HUD reads `player.vehicle` whatever it is and dereferences
   * `v.drivetrain.rpm` unguarded, so this calls the REAL
   * `VehicleSystem.getHudState` on the handle. A handle that is not
   * HUD-shaped throws sixty times a second for the length of a ride, and that
   * is a crash a camera gate would never see.
   */
  {
    let hud = null;
    let threw = null;
    try {
      hud = VehicleSystem.prototype.getHudState.call({
        ctx: { peek: (k) => (k === 'player' ? { vehicle: rider } : null) },
        _playerVehicle: VehicleSystem.prototype._playerVehicle,
      });
    } catch (e) { threw = e.message; }
    check('hud-safe',
      !threw && hud && hud.inVehicle === true && hud.noFuel === true &&
      Number.isFinite(hud.speedKmh),
      threw ? `threw: ${threw}` : `${hud?.name} · ${hud?.speedKmh} km/h · noFuel ${hud?.noFuel}`);
  }

  /**
   * THE ONE THAT ACTUALLY BROKE THE RIDE, and the reason this section runs
   * production `VehicleSystem` methods rather than describing them.
   *
   * `_pollHorn` runs EVERY FRAME on `player.vehicle`, whatever it is, and
   * `setHorn` writes `v.input.horn`. A handle with no `input` therefore threw
   * sixty times a second — and since `funicular` is registered after
   * `vehicles`, the throw took the incline's own `update` with it: MEASURED in
   * a live capture, the car sat frozen at the lower station for the whole
   * "ride" and the reel never cut, with one page error as the only symptom.
   * Every stub in this file would have gone on passing.
   */
  {
    let threw = null;
    let fired = 0;
    const sysStub = {
      ctx: {
        peek: (k) => (k === 'player' ? { vehicle: rider } : null),
        input: { frozen: false, enabled: true, action: (a) => a === 'horn' },
        events: { emit: () => { fired++; } },
      },
      _hornVehicle: null,
      setHorn: VehicleSystem.prototype.setHorn,
      _playerVehicle: VehicleSystem.prototype._playerVehicle,
    };
    try {
      VehicleSystem.prototype._pollHorn.call(sysStub, sysStub.ctx);
      VehicleSystem.prototype._pollHorn.call(sysStub, sysStub.ctx);
    } catch (e) { threw = e.message; }
    check('horn-safe',
      !threw && rider.input.horn === true && rider.horn === true && fired === 1,
      threw ? `threw: ${threw}` : `input.horn ${rider.input.horn}, ${fired} edge(s) emitted`);
    rider.input.horn = false;
    rider.horn = false;
  }

  /* ---- board at the platform and watch the reel --------------------- */
  let guard = 0;
  while (!rider.transit.dwelling && guard++ < 20000) frame();
  {
    const off = new THREE.Vector3(2.1, rider.transit.railY, -2.4)
      .applyQuaternion(rider.quaternion);
    m.position.copy(rider.position).add(off);
    m.prevPosition.copy(m.position);
    m.grounded = true;
  }
  frame();
  const boarded = handler.tryEnter(m);
  guard = 0;
  while (handler.phase !== 'drive' && guard++ < 600) frame();
  check('board',
    boarded && handler.phase === 'drive' && handler.passenger === true &&
    rig.cinematicActive === true,
    `boarded ${boarded}, phase ${handler.phase}, passenger ${handler.passenger}, ` +
    `opening shot "${rig.cinematicShot}"`);

  const shots = new Set();
  let vistaN = 0;
  let vistaBad = 0;
  let vistaBehind = 0;
  let fovLo = Infinity;
  let worstCar = 0;
  let worstVis = 0;
  let fovHi = 0;
  const fwd = new THREE.Vector3();
  const toCar = new THREE.Vector3();
  const toVista = new THREE.Vector3();
  const vp = sys.vista;
  guard = 0;
  // Ride the whole climb: out of this dwell, up the hill, into the next one.
  while (rider.transit.dwelling && guard++ < 4000) { frame(); shots.add(rig.cinematicShot); }
  guard = 0;
  while (!rider.transit.dwelling && guard++ < 20000) {
    frame();
    shots.add(rig.cinematicShot);
    if (rig.cinematicShot !== 'vista') continue;
    vistaN++;
    toCar.subVectors(rider.position, rig.position).normalize();
    toVista.set(vp.x - rig.position.x, vp.y - rig.position.y, vp.z - rig.position.z).normalize();
    fwd.set(0, 0, -1).applyQuaternion(rig.quaternion);
    /**
     * BOTH SUBJECTS INSIDE THE EMITTED FRUSTUM — the car AND the city, which
     * is the whole claim the shot makes.
     *
     * The tolerance is not a taste number and is deliberately not a RATCHET:
     * it is the lens's OWN vertical half-angle, read off `rig.fov` (which is
     * what `applyTo` writes onto the camera), less a 10% margin for the frame
     * edge. A shot that widened its lens to cheat this check would be widening
     * the actual picture, and a shot that narrowed it would go red.
     */
    const halfFov = (rig.fov * 0.5 * 0.9) * (Math.PI / 180);
    fovLo = Math.min(fovLo, rig.fov);
    fovHi = Math.max(fovHi, rig.fov);
    const aCar = Math.acos(Math.min(1, Math.max(-1, fwd.dot(toCar)))) * 180 / Math.PI;
    const aVis = Math.acos(Math.min(1, Math.max(-1, fwd.dot(toVista)))) * 180 / Math.PI;
    worstCar = Math.max(worstCar, aCar);
    worstVis = Math.max(worstVis, aVis);
    if (fwd.dot(toCar) < Math.cos(halfFov) || fwd.dot(toVista) < Math.cos(halfFov)) vistaBad++;
    // ...and the lens is on the FAR side of the car from the vista, which is
    // what puts downtown BEHIND the climb rather than in front of it.
    const dCam = Math.hypot(vp.x - rig.position.x, vp.z - rig.position.z);
    const dCar = Math.hypot(vp.x - rider.position.x, vp.z - rider.position.z);
    if (dCam > dCar) vistaBehind++;
  }
  check('reel', shots.size >= 3 && shots.has('vista'),
    `${shots.size} shots over the climb: ${[...shots].join(', ')}`);
  check('postcard',
    vistaN > 60 && vistaBad === 0 && vistaBehind === vistaN,
    `${vistaN} vista frames at ${fovLo.toFixed(0)}-${fovHi.toFixed(0)} deg vertical fov, ` +
    `${vistaBad} out of frame (worst car ${worstCar.toFixed(0)} deg, city ${worstVis.toFixed(0)} deg), ` +
    `${vistaBehind} with the lens uphill of the car`);

  /**
   * NEGATIVE CONTROL for the shot rejection, run on the LIVE camera with no
   * source edit: stand the headhouse where the postcard wants the lens.
   *
   * MEASURED before the rejection existed: the reel cut to `vista` anyway, the
   * boom's own pull-in dragged the lens to its 1.4 m floor, and the frame was
   * brickwork — that capture is what this control was written from. The reel
   * must now refuse the framing and spend its seconds on one that exists.
   */
  {
    blockVista = true;
    const blocked = new Set();
    for (let i = 0; i < 3600; i++) { frame(); blocked.add(rig.cinematicShot); }
    blockVista = false;
    const open = new Set();
    for (let i = 0; i < 3600; i++) { frame(); open.add(rig.cinematicShot); }
    // The blocker's cone is wide (+/-53 deg off the anti-vista bearing) and
    // legitimately catches whichever of `reveal` / `orbit` happens to be
    // pointing into it as well, so the bar is "the reel refuses the postcard
    // and goes on working", not a shot count.
    check('postcard-blocked',
      !blocked.has('vista') && blocked.size >= 2 && open.has('vista'),
      `blocked: ${[...blocked].join(', ')} · clear again: ${[...open].join(', ')}`);
  }

  /* ---- get off at the top ------------------------------------------- */
  const rang = handler.tryExit(m);
  guard = 0;
  while (handler.phase !== 'none' && guard++ < 20000) frame();
  const lateralOff = Math.hypot(m.position.x - rider.position.x, m.position.z - rider.position.z);
  check('alight',
    rang === true && handler.phase === 'none' && handler.passenger === false &&
    rig.cinematicActive === false && rider.transit.dwelling === true &&
    lateralOff > rider.spec.half.x && lateralOff < 8,
    `rang ${rang}, phase ${handler.phase}, put down ${lateralOff.toFixed(2)} m off the car ` +
    `at the ${rider.transit.stopName}`);

  /* ---- NEGATIVE CONTROL: boarding a moving cabin --------------------- */
  guard = 0;
  while (rider.transit.dwelling && guard++ < 4000) frame();
  for (let i = 0; i < 120; i++) frame();
  {
    const off = new THREE.Vector3(2.1, rider.transit.railY, -2.4)
      .applyQuaternion(rider.quaternion);
    m.position.copy(rider.position).add(off);
    m.prevPosition.copy(m.position);
    m.grounded = true;
  }
  frame();
  const promptMoving = handler.prompt ? handler.prompt.text : null;
  handler.candidate = rider;
  const boardedMoving = handler.tryEnter(m);
  check('no-board-moving',
    boardedMoving === false && handler.phase === 'none' && promptMoving === null,
    `tryEnter -> ${boardedMoving}, phase ${handler.phase}, prompt ${promptMoving ?? 'none'} ` +
    `at ${rider.transit.speed.toFixed(2)} m/s`);
}

/* ----------------------------------------------------------------- report --- */

const failed = checks.filter((c) => !c.ok);
if (args.json) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(String(args.json), JSON.stringify({ checks, drift: DRIFT, freeze: FREEZE }, null, 2));
}
if (failed.length) {
  console.error(
    `\nfunicularprobe: ${failed.length}/${checks.length} checks FAILED${DRIFT || FREEZE ? ' (negative-control arm)' : ''}`
  );
  process.exit(1);
}
console.log(
  `\nfunicularprobe: all ${checks.length} checks green — two counterweighted cars riding the emitted rails in the authored livery`
);
