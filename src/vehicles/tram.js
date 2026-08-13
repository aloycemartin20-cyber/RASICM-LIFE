/**
 * THE MONONGAHELA — the Steel City trolley, and the rail service that runs it.
 *
 * The player asked for "the subway (trolley with windows) onto train tracks".
 * `railsweep` proves the Strip -> Lawrenceville mill line ('rail_strip') is one
 * continuous 1082 m polyline, so this file puts a PCC-style interurban car on
 * it: a long boxy carriage with a rounded roof crown, a full-length WINDOW BAND
 * down both flanks (lit from inside at night), folding doors both sides, a
 * pantograph, in an ore-red livery over a dark roof — Pittsburgh Railways ran
 * red cars, and the fleet palette already owns the colour.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * "I DON'T SEE ANY TROLLYS" — WHY, AND WHAT CHANGED
 * ────────────────────────────────────────────────────────────────────────────
 * The trolley existed and `tramprobe` was green the whole time. It was simply
 * never THERE. MEASURED off the emitted service, one car shuttling the whole
 * 1085 m line at the 9 m/s cap:
 *
 *   one-way trip     ~125 s      round trip incl. dwells  ~260 s
 *   headway at any point on the line   ~130 s, and the car is IN SHOT for
 *                                      about two of those 130 seconds
 *
 * Two minutes of empty track between sightings, on a line whose near terminus
 * is 167 m from the Golden Triangle. A player who walks the Strip for five
 * minutes has a coin-flip chance of ever seeing the thing.
 *
 * So the service is now a FLEET on a SECTIONED line, which is also how you run
 * more than one car on single track without a passing loop — there is exactly
 * one drawn track (`roadmesh._rail` lays one ballast bed, one pair of railheads
 * at +/-0.7175 m per rail edge), so two cars meeting head-on is not a timetable
 * problem, it is two carriages in the same cubic metre. Each car owns one
 * SECTION between two stops and short-turns on it, the way a real short-worked
 * street railway does:
 *
 *   stops       4, at the two termini and at two intermediate marks snapped to
 *               ROAD CROSSINGS where one is within SNAP_M — so a stop is where
 *               a street meets the line, which is where a player is;
 *   cars        3, one per section, each dwelling DWELL s at both its marks;
 *   clearance   each car's marks are held CLEAR m inside its section, so two
 *               cars sharing an interchange stop stand 2*CLEAR apart at
 *               opposite ends of the same platform and can never overlap;
 *   headway     MEASURED on the emitted positions, worst case over every point
 *               on the line: see `tramprobe`'s `headway` check.
 *
 * The union of the sections is the whole line, so every crossing the old single
 * car served is still served — three times as often, by a car that is never
 * more than a section away.
 *
 * `?owOneTram=1` (or `OW_ONE_TRAM=1` headless) restores the single car running
 * the full line. That is the A/B arm for `perfcheck` and the negative control
 * for the fleet assertions in `tramprobe`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * RIDING IT. Each car publishes a `transit` record on its `Vehicle`, which is
 * the whole contract `src/player/vehicle.js` boards a PASSENGER through: is it
 * standing at a stop right now, where is the seat, where is the platform, what
 * is this line called. Nothing in this file knows the player exists.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE TRAM IS KINEMATIC AND NOT A CAR WITH INVISIBLE WHEELS
 * ────────────────────────────────────────────────────────────────────────────
 * A rail vehicle's whole character is that it CANNOT deviate: no slip angle,
 * no steering, no suspension wander — the track is the trajectory. Driving the
 * Pacejka tyre model along a ballast strip would spend the entire budget
 * fighting the thing the rails give for free, and any residual would read as a
 * derailment. So `TramService` poses the rigid body directly from a
 * `RailMover` arc position, two bogie samples apart, and
 * `VehicleSystem.fixedUpdate` skips `fixedStep` for anything flagged
 * `kinematic`. The tram still IS a `Vehicle` in `vehicles.vehicles`, which is
 * what buys the living-city half for free:
 *
 *   - traffic's grid sees it, so AI drivers brake for it at the crossings;
 *   - `_vehicleCollisions` resolves cars against it — at 19.5 t against a
 *     1.5 t sedan the split goes ~93% to the car, so cars are SHOVED and the
 *     tram holds its line, exactly how the bus behaves when something noses it;
 *   - `blocksPeds` stays true, so the capsule push keeps people out of it;
 *   - lamps, LOD, ground shadow and damage all run the standard paths.
 *
 * The service writes `prevPosition`/`prevQuaternion` alongside the pose, so
 * `syncTransforms` interpolation is exact, and it writes the REAL velocity so
 * a car struck at a crossing takes a physical impulse rather than a teleport.
 *
 * Pause: `update(dt)` receives the SCALED dt, so a stopped clock stops the
 * timetable with no extra gate — the mover treats dt <= 0 as a no-op.
 *
 * The gate is `src/vehicles/tramprobe.mjs` (`npm run tram`): it runs THIS
 * service against the emitted graph and asserts the EMITTED positions against
 * rail geometry it extracts independently (rule 12), with a negative control.
 */

import * as THREE from 'three';
import { roundedBox, transform, tubeBetween, mergeAll } from './geom.js';
import { extractRailLine, RailMover, RAIL_TOP } from '../world/railmover.js';

/* ====================================================================== */
/* Geometry — the carriage                                                */
/* ====================================================================== */

/** Per-LOD segment budgets, same shape the heli uses. */
const SEG = [
  { box: 3, tube: 8 },
  { box: 2, tube: 6 },
  { box: 2, tube: 4 },
  { box: 1, tube: 4 },
];

/**
 * The carriage. Returns the same material-group shape `buildCarBody` does.
 * Silhouette priorities at 60 m: the LONG BOX, the rounded roof crown, the
 * continuous window band, the skirt. Everything else is detail.
 *
 * All heights are above the WHEEL-CONTACT PLANE (the rail head), because
 * `buildVehicleModel` hangs the body at `-spec.comY` and `TramService` puts
 * the CoM at railTop + comY — same convention as every other class.
 */
export function buildTramBody(spec, lod = 0) {
  const s = spec.style;
  const seg = SEG[Math.min(SEG.length - 1, lod)];
  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [],
    lamps: {}, plate: [], disc: [], doors: [], rotors: [], anchors: {},
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);

  const hw = s.hwMax;              // 1.30
  const skirtY = s.skirtY;         // 0.30 — bottom of bodywork
  const beltY = s.beltY;           // 1.45 — window sill
  const winTopY = s.winTopY;       // 2.30 — window head
  const cantY = s.cantY;           // 2.62 — top of the letterboard
  const halfL = spec.dims.L / 2;   // 7.0
  const mainHL = halfL - 1.15;     // straight body half-length (5.85)

  /* ---- body shell: below the band, above the band, tapered ends ------- */
  // Lower body: sill to belt.
  const lower = roundedBox(hw * 2, beltY - skirtY, mainHL * 2, 0.08, seg.box);
  transform(lower, { pos: [0, (skirtY + beltY) / 2, 0] });
  out.paint.push(lower);
  // Letterboard: window head to cant rail.
  const cant = roundedBox(hw * 2, cantY - winTopY, mainHL * 2, 0.06, seg.box);
  transform(cant, { pos: [0, (winTopY + cantY) / 2, 0] });
  out.paint.push(cant);
  // Tapered ends: full height, streamlined in plan, closing the window band.
  // Face lands exactly at +/- L/2; everything ON the face (screen, lamps,
  // sign) is placed PROUD of it below — a lens sealed inside its own housing
  // photographs as a blank panel (see shapeprobe's tail-lamp section).
  for (const end of [-1, 1]) {
    const nose = roundedBox(hw * 2, cantY - skirtY, 2.3, 0.42, seg.box);
    transform(nose, {
      pos: [0, (skirtY + cantY) / 2, end * (halfL - 1.15)],
      scale: [0.86, 1, 1],
    });
    out.paint.push(nose);
  }

  /* ---- roof crown ------------------------------------------------------ */
  // The rounded roof that says "trolley" from any distance. Dark, like the
  // canvas roofs the real cars carried.
  const roof = roundedBox(hw * 2 * 0.90, (s.roofY - cantY) * 2, (halfL - 0.65) * 2, 0.34, seg.box);
  transform(roof, { pos: [0, cantY, 0] }); // half sunk into the letterboard
  out.trim.push(roof);

  /* ---- the window band ------------------------------------------------- */
  if (lod < 3) {
    const bandL = mainHL * 2 - 0.3;
    for (const side of [-1, 1]) {
      const pane = roundedBox(0.05, winTopY - beltY, bandL, 0.015, 1);
      transform(pane, { pos: [side * (hw - 0.045), (beltY + winTopY) / 2, 0] });
      out.glass.push(pane);
    }
    // End screens: thick enough to cut through the nose's rounded face and
    // stand a few cm proud across their whole width, raked back a touch.
    for (const end of [-1, 1]) {
      const screen = roundedBox(1.35, 0.80, 0.22, 0.03, 1);
      transform(screen, {
        pos: [0, (beltY + winTopY) / 2 + 0.06, end * (halfL - 0.10)],
        rot: [end * -0.10, 0, 0],
      });
      out.glass.push(screen);
    }
    /**
     * THE LIT CABIN. An emissive strip INSET behind the glass, in the `drl`
     * lamp slot: `_updateLamps` runs drl at 0.9 by day and ~3.1 at night, which
     * is a fluorescent saloon reading through the glazing after dark — the
     * "windows lit at night" the request names — with zero new material kinds
     * and zero per-frame work in this file. `build.js` keeps the tram's drl
     * cluster OUT of the red brake merge at far LODs for exactly this strip.
     */
    // Segmented per window bay, not one slab: a continuous 11 m emissive strip
    // reads as a white-hot band in daylight; nine lit windows read as a tram.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        const z = -5.0 + i * 1.25;
        const glow = new THREE.BoxGeometry(0.02, winTopY - beltY - 0.24, 0.92);
        transform(glow, { pos: [side * (hw - 0.20), (beltY + winTopY) / 2 - 0.03, z] });
        lamp('drl', glow);
      }
    }
  }

  /* ---- window pillars (over the glass, so the band reads as windows) --- */
  if (lod < 2) {
    const nPil = 7;
    for (let i = 0; i < nPil; i++) {
      const z = -4.8 + (i * 9.6) / (nPil - 1);
      for (const side of [-1, 1]) {
        const pil = roundedBox(0.055, winTopY - beltY + 0.06, 0.16, 0.01, 1);
        transform(pil, { pos: [side * (hw - 0.02), (beltY + winTopY) / 2, z] });
        out.paint.push(pil);
      }
    }
  }

  /* ---- doors: double-leaf folding, both flanks, both ends -------------- */
  // A double-ended interurban loads from either side depending on the terminus,
  // and the symmetry is what lets the service run the return leg tail-first
  // without the body ever turning around.
  if (lod < 2) {
    for (const side of [-1, 1]) {
      for (const zc of [4.35, -4.35]) {
        // dark reveal
        const rev = new THREE.BoxGeometry(0.03, cantY - 0.36 - skirtY, 1.34);
        transform(rev, { pos: [side * (hw + 0.004), (skirtY + cantY - 0.36) / 2, zc] });
        out.cavity.push(rev);
        // two leaves, slightly proud, each with a small light in the top half
        for (const lz of [-0.33, 0.33]) {
          const leaf = roundedBox(0.035, cantY - 0.42 - skirtY, 0.60, 0.012, 1);
          transform(leaf, { pos: [side * (hw + 0.018), (skirtY + cantY - 0.42) / 2, zc + lz] });
          out.paint.push(leaf);
          const dg = new THREE.BoxGeometry(0.02, 0.62, 0.42);
          transform(dg, { pos: [side * (hw + 0.030), winTopY - 0.44, zc + lz] });
          out.glass.push(dg);
        }
      }
    }
  }

  /* ---- skirt + underframe ---------------------------------------------- */
  const skirt = roundedBox(hw * 2 - 0.16, 0.34, (halfL - 0.55) * 2, 0.05, 1);
  transform(skirt, { pos: [0, skirtY + 0.03, 0] });
  out.cavity.push(skirt);

  /* ---- bogies + wheels -------------------------------------------------- */
  if (lod < 2) {
    for (const bz of [s.bogieZ, -s.bogieZ]) {
      const frame = roundedBox(1.9, 0.42, 2.5, 0.08, 1);
      transform(frame, { pos: [0, 0.38, bz] });
      out.cavity.push(frame);
      for (const wz of [-0.85, 0.85]) {
        for (const side of [-1, 1]) {
          const wheel = new THREE.CylinderGeometry(s.wheelR, s.wheelR, 0.09, 12);
          transform(wheel, { pos: [side * 0.7175, s.wheelR, bz + wz], rot: [0, 0, Math.PI / 2] });
          out.trim.push(wheel);
        }
      }
    }
  }

  /* ---- roof gear: pantograph + vents ------------------------------------ */
  if (lod < 2) {
    const roofTop = s.roofY - 0.02; // sink the gear a shade into the crown
    // insulator feet
    for (const z of [-0.42, 0.42]) {
      const foot = new THREE.CylinderGeometry(0.05, 0.07, 0.12, 8);
      transform(foot, { pos: [0, roofTop + 0.06, z] });
      out.trim.push(foot);
    }
    // single-arm pantograph: lower arm aft, upper arm forward, shoe across.
    const kneeY = roofTop + 0.62;
    const shoeY = roofTop + 0.98;
    out.chrome.push(tubeBetween(
      new THREE.Vector3(0, roofTop + 0.10, 0.42),
      new THREE.Vector3(0, kneeY, -0.30), 0.030, seg.tube));
    out.chrome.push(tubeBetween(
      new THREE.Vector3(0, kneeY, -0.30),
      new THREE.Vector3(0, shoeY, 0.35), 0.024, seg.tube));
    const shoe = roundedBox(1.35, 0.045, 0.10, 0.02, 1);
    transform(shoe, { pos: [0, shoeY + 0.02, 0.35] });
    out.trim.push(shoe);
    // roof vents, half-sunk into the crown so they ride its curve
    for (const z of [-3.4, -1.7, 1.7, 3.4]) {
      const vent = roundedBox(0.62, 0.09, 0.5, 0.03, 1);
      transform(vent, { pos: [0, s.roofY - 0.01, z] });
      out.trim.push(vent);
    }
  }

  /* ---- lamps: both ends, because both ends lead ------------------------- */
  // Every fixture is thick and centred ON the face plane, so it stands proud
  // of the rounded nose everywhere instead of sealing itself inside it.
  for (const end of [-1, 1]) {
    const zFace = end * halfL;
    // the single centred headlamp every PCC carries
    lamp('head', transform(
      new THREE.SphereGeometry(0.115, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.55),
      { pos: [0, 1.06, zFace - end * 0.02], rot: [end * Math.PI * 0.5, 0, 0] }));
    // marker/tail pair low on the corners
    for (const side of [-1, 1]) {
      lamp('tail', transform(new THREE.BoxGeometry(0.16, 0.10, 0.10),
        { pos: [side * 0.68, 0.82, zFace] }));
    }
    if (lod < 3) {
      // lit destination box above the screen
      lamp('drl', transform(new THREE.BoxGeometry(0.72, 0.17, 0.14),
        { pos: [0, winTopY + 0.14, zFace - end * 0.10] }));
    }
  }

  out.anchors = { floorY: s.floorY };
  out.surface = null;
  return out;
}

/* ====================================================================== */
/* The service                                                            */
/* ====================================================================== */

/** Distance from the body centre to each bogie pivot, m. The body is posed on
 *  the CHORD between the two bogie contact points, which is how a real
 *  carriage negotiates a curve — the overhang swings, the bogies stay on the
 *  rail. */
const BOGIE_HALF = 3.8;

/** The corridor the service runs — the line `railsweep` certifies. */
const LINE_ID = 'rail_strip';

/** What the line is called on the side of the car and in the ride prompt. */
export const LINE_NAME = 'THE MONONGAHELA';

/**
 * Cars on the line, and therefore SECTIONS. Three is what turns a ~130 s
 * headway into a ~53 s one on this line's length; see the header.
 */
const CARS = 3;

/** Seconds a car stands at each of its two marks, doors open. */
const DWELL = 8.0;

/**
 * How far inside its section each car's mark sits (m). A car is 14 m long, so
 * two cars sharing an interchange stop stand 2*CLEAR = 20 m apart nose to nose
 * — clear of each other by a full car length whatever the timetable does.
 */
const CLEAR = 10.0;

/** An intermediate stop snaps to a road crossing within this distance (m). */
const SNAP_M = 60;

/** Shortest section the sectioning is allowed to produce (m). */
const MIN_SECTION = 180;

/**
 * Stop names, termini first and last. DESIGN.md vocabulary: Butler St is
 * Lawrenceville's spine and the Strip Market is the landmark at (352, -224),
 * both of which the emitted marks land beside (MEASURED: the s=364 mark is
 * 94 m from THE STRIP's centre, the s=727 mark is on a street crossing in
 * Lawrenceville). If the sectioning ever produces a different count the names
 * fall back to fleet-speak rather than lying about where you are.
 */
const STOP_NAMES = ['TRIANGLE YARD', 'STRIP MARKET', 'BUTLER STREET', 'FOUNDRY TERMINUS'];

/* ══════════════════════════════════════════════════════════════════════════
 * STOP FURNITURE — the shelter, the platform and the name board
 * ══════════════════════════════════════════════════════════════════════════
 *
 * THE REPORT: "trolly station facade is in the middle of the street".
 *
 * A STOP MARK IS NOT A PLACE TO STAND, and the whole defect is in that one
 * sentence. `planStops` deliberately SNAPS every interior mark onto a ROAD
 * CROSSING — that is the fix for "I never see the trolley", because the
 * player is on the streets — so a stop is by construction the point where a
 * rail line and a carriageway intersect. MEASURED on the shipped graph, the
 * four marks against the nearest drivable centreline:
 *
 *   TRIANGLE YARD      5.07 m from a 7.2 m street
 *   STRIP MARKET      18.53 m from a 6.0 m alley
 *   BUTLER STREET      1.52 m from a 15.2 m arterial   <- inside the lanes
 *   FOUNDRY TERMINUS   0.32 m from a 7.2 m street      <- inside the lanes
 *
 * Anything built AT the mark therefore stands on the carriageway at two of the
 * four stops, and at Butler Street it stands in the middle of a four-lane
 * road. So the furniture is not built at the mark: it is built on the
 * PAVEMENT SIDE of the rail, which is what a platform is.
 *
 * WHICH SIDE, AND HOW FAR, ARE BOTH SOLVED RATHER THAN AUTHORED. The rail runs
 * down a street, so both sides of it are candidates; the pavement is whichever
 * one has room. Each candidate is pushed out along the rail's normal until it
 * clears BOTH envelopes — the tram's own (a 2.6 m body plus its sway) and
 * every carriageway within reach (each road's own emitted `width`, so a
 * four-lane arterial pushes further than an alley) — and the side that clears
 * by more wins. A stop that cannot clear both at any offset gets no furniture
 * at all rather than furniture in the road.
 *
 * `src/vehicles/tramprobe.mjs` gates it: CLEARANCE measures the emitted
 * anchors against the emitted graph with its own carriageway arithmetic.
 */

/**
 * Half-width of the tram's swept envelope, metres. The body is 2.6 m across
 * (`makeTransit.hw` = 1.30) and a bogie-steered carriage swings past that on a
 * curve, so the platform edge stands off 2.2 m from the rail centreline and
 * the furniture behind it further again.
 */
const RAIL_HALF = 2.2;

/** Metres of clear ground between the furniture and any carriageway edge. */
const KERB_CLEAR = 1.0;

/**
 * Offsets from the rail centreline to try, nearest first. The first is a
 * platform hard against the tram — the doors open onto it — and the rest are
 * for a stop where the rail runs IN the carriageway, which is what a
 * street-running trolley does and what Butler Street is: the rail is 1.5 m off
 * the centreline of a 15.2 m arterial, so the nearest ground that is not
 * tarmac is 9 m away and the stop is a KERBSIDE one, the way it was in the
 * city this is a portrait of. Anything under 4.2 m is inside the tram's own
 * envelope and is not offered.
 */
const PLATFORM_OFF = [4.2, 6.0, 8.0, 10.5, 13.0, 15.5];

/** The platform slab, metres: along the rail, across it, and its lift. */
const PLATFORM = { len: 11.0, wide: 2.6, rise: 0.16 };

/**
 * A/B hatch, same shape as `legacyPave` in `src/world/roadmesh.js`:
 * `?owOneTram=1` / `OW_ONE_TRAM=1` puts the single car back on the full line.
 * It is the reference arm for `perfcheck --ab` and the negative control for
 * `tramprobe`'s fleet, headway and separation checks. Never reachable in play.
 */
let _oneTram = null;
function oneTram() {
  if (_oneTram !== null) return _oneTram;
  _oneTram = false;
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('owOneTram') === '1') {
      _oneTram = true;
    }
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.OW_ONE_TRAM === '1') _oneTram = true;
  } catch { /* no process */ }
  if (_oneTram) console.warn('[vehicles] LEGACY tram: one car on the whole line, pre-fleet');
  return _oneTram;
}

/* ---------------------------------------------------------------- line -- */

/** The point at arc `s` on an extracted line, written into `out`. */
function pointAt(line, s, out) {
  const { pts, cum } = line;
  const n = pts.length;
  const sc = s < 0 ? 0 : s > cum[n - 1] ? cum[n - 1] : s;
  let i = 0;
  while (i < n - 2 && cum[i + 1] < sc) i++;
  const span = cum[i + 1] - cum[i];
  const t = span > 1e-9 ? (sc - cum[i]) / span : 0;
  const a = pts[i];
  const b = pts[i + 1];
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/**
 * The stretch of `line` between arcs `s0` and `s1`, as a line in its own right
 * whose arc origin is `s0`.
 *
 * This is what lets a car run a SECTION without `RailMover` knowing sections
 * exist: `src/world/railmover.js` is a `world` module and a pure function
 * library, and it is not this change's file to edit. A slice is the same shape
 * of object it already consumes, so the mover's own end-to-end logic — brake
 * into the mark, dwell, reverse — becomes short-turn behaviour untouched.
 */
function sliceLine(line, s0, s1) {
  const a = { x: 0, y: 0, z: 0 };
  const b = { x: 0, y: 0, z: 0 };
  pointAt(line, s0, a);
  pointAt(line, s1, b);
  const pts = [{ x: a.x, y: a.y, z: a.z }];
  for (let i = 0; i < line.pts.length; i++) {
    if (line.cum[i] > s0 + 1e-3 && line.cum[i] < s1 - 1e-3) {
      pts.push({ x: line.pts[i].x, y: line.pts[i].y, z: line.pts[i].z });
    }
  }
  pts.push({ x: b.x, y: b.y, z: b.z });
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1];
    const q = pts[i];
    cum[i] = cum[i - 1] + Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
  }
  return { pts, cum, length: cum[cum.length - 1] };
}

/**
 * Arc positions where a DRIVABLE street crosses the line.
 *
 * Read off the same emitted graph the line itself came from, and only the
 * non-rail edges — a rail-on-rail crossing is a junction, not a street. These
 * are where a stop belongs: the whole complaint was that the trolley was never
 * anywhere the player was, and the player is on the streets.
 */
function roadCrossings(roads, line) {
  const out = [];
  const segs = line.pts;
  for (const e of roads.edges) {
    if (!e || e.rail) continue;
    const na = roads.nodes[e.a];
    const nb = roads.nodes[e.b];
    if (!na || !nb) continue;
    for (let i = 0; i < segs.length - 1; i++) {
      const p = segs[i];
      const q = segs[i + 1];
      const d = (q.x - p.x) * (nb.z - na.z) - (q.z - p.z) * (nb.x - na.x);
      if (Math.abs(d) < 1e-9) continue;
      const t = ((na.x - p.x) * (nb.z - na.z) - (na.z - p.z) * (nb.x - na.x)) / d;
      const u = ((na.x - p.x) * (q.z - p.z) - (na.z - p.z) * (q.x - p.x)) / d;
      if (t <= 0 || t >= 1 || u <= 0 || u >= 1) continue;
      out.push(line.cum[i] + t * (line.cum[i + 1] - line.cum[i]));
      break;
    }
  }
  out.sort((x, y) => x - y);
  return out;
}

/**
 * Where the cars stand. Even splits of the usable run, with every INTERIOR
 * mark pulled onto a road crossing when one is within `SNAP_M` and the pull
 * does not starve a neighbouring section.
 */
function planStops(line, roads, cars) {
  const s0 = CLEAR;
  const s1 = Math.max(s0 + MIN_SECTION, line.length - CLEAR);
  const marks = [];
  for (let i = 0; i <= cars; i++) marks.push(s0 + ((s1 - s0) * i) / cars);
  const crossings = roads ? roadCrossings(roads, line) : [];
  for (let i = 1; i < cars; i++) {
    let best = -1;
    let bestD = SNAP_M;
    for (const c of crossings) {
      const d = Math.abs(c - marks[i]);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best < 0) continue;
    if (best - marks[i - 1] < MIN_SECTION || marks[i + 1] - best < MIN_SECTION) continue;
    marks[i] = best;
  }
  const p = { x: 0, y: 0, z: 0 };
  return marks.map((s, i) => {
    pointAt(line, s, p);
    return {
      index: i,
      s,
      x: p.x,
      y: p.y,
      z: p.z,
      name: marks.length === STOP_NAMES.length
        ? STOP_NAMES[i]
        : `${LINE_NAME} STOP ${i + 1}`,
    };
  });
}

/**
 * Unit tangent of `line` at arc `s`, in XZ.
 */
function tangentAt(line, s, out) {
  let i = 0;
  while (i < line.cum.length - 2 && line.cum[i + 1] < s) i++;
  const a = line.pts[i];
  const b = line.pts[Math.min(i + 1, line.pts.length - 1)];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  out.x = dx / l;
  out.z = dz / l;
  return out;
}

/**
 * Distance from (x, z) to the nearest DRIVABLE carriageway EDGE — negative
 * when the point is on the tarmac. Each edge is measured against its own
 * emitted `width`, so an alley and a six-lane parkway are not treated alike.
 */
function carriagewayDist(roads, x, z) {
  let best = Infinity;
  const edges = roads?.edges;
  if (!edges) return best;
  for (let k = 0; k < edges.length; k++) {
    const e = edges[k];
    if (!e || e.rail) continue;
    const na = roads.nodes[e.a];
    const nb = roads.nodes[e.b];
    if (!na || !nb) continue;
    const dx = nb.x - na.x;
    const dz = nb.z - na.z;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 1e-9 ? ((x - na.x) * dx + (z - na.z) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (na.x + dx * t), z - (na.z + dz * t)) - (e.width ?? 7) * 0.5;
    if (d < best) best = d;
  }
  return best;
}

/**
 * Solve the platform side and offset for every stop. Writes `stop.platform` =
 * `{ x, y, z, nx, nz, side, off, clear }`, or leaves it null when neither side
 * of the rail has room — see the block comment over `RAIL_HALF`.
 */
function planPlatforms(line, roads, stops, world) {
  const tan = { x: 0, z: 0 };
  const at = { x: 0, y: 0, z: 0 };
  for (const st of stops) {
    let best = null;
    /**
     * SEARCHED ALONG THE LINE AS WELL AS ACROSS IT, and the reason is a real
     * stop rather than a tidier loop. MEASURED on the shipped graph: at BUTLER
     * STREET the rail runs PARALLEL to a 15.2 m arterial for its whole reach,
     * so stepping sideways off the mark gains 0.35 m of clearance per 2.5 m of
     * offset and never gets off the tarmac — the nearest clear ground square to
     * the mark is over 30 m away, which is not a stop, it is a field. Sliding
     * up the LINE instead finds the point where the road diverges, and a shelter
     * a dozen metres up the platform from where the doors open is what a tram
     * stop looks like anyway. Nearest to the mark wins.
     */
    for (const ds of [0, 12, -12, 24, -24, 36, -36]) {
      const s = st.s + ds;
      if (s < 0 || s > line.length) continue;
      pointAt(line, s, at);
      tangentAt(line, s, tan);
      // The rail's normal, in XZ. Both signs are candidates: a trolley street
      // has a pavement on each side and only the graph knows which one is free.
      const nx = -tan.z;
      const nz = tan.x;
      for (const side of [1, -1]) {
        for (const off of PLATFORM_OFF) {
          const x = at.x + nx * side * off;
          const z = at.z + nz * side * off;
          if (world?.isWater?.(x, z)) continue;
          const y = world?.heightAt?.(x, z);
          if (!Number.isFinite(y)) continue;
          // The platform slab reaches PLATFORM.wide/2 either side of the
          // anchor, so both its EDGES have to clear both envelopes — the
          // centre clearing them is not the question.
          const nearRail = off - PLATFORM.wide * 0.5;
          const road = carriagewayDist(roads, x, z) - PLATFORM.wide * 0.5;
          if (nearRail < RAIL_HALF || road < KERB_CLEAR) continue;
          const clear = Math.min(nearRail - RAIL_HALF, road - KERB_CLEAR);
          // Nearest offset that qualifies wins on each side; between the two
          // sides, the one with more room round it.
          if (!best || clear > best.clear) {
            best = { x, y, z, nx: nx * side, nz: nz * side, side, off, ds, clear,
              yaw: Math.atan2(tan.x, tan.z) };
          }
          break;
        }
      }
      if (best) break;
    }
    st.platform = best;
  }
  return stops;
}

/**
 * The furniture itself: a platform slab, a shelter on four posts with a glazed
 * back, and the line's name board. One merged group per stop, added to the
 * vehicle system's root and registered with physics as a static — a canopy a
 * player walks through is the same defect as a floor he falls through.
 */
function buildStopFurniture(sys, stop, group) {
  const p = stop.platform;
  if (!p) return;
  const mats = sys.mats;
  if (!mats) return;
  const steel = mats.paint(0x2f3a3c, { finish: 'satin', flake: 0.4, clearcoat: 0.2, wear: 0.5 });
  const deck = mats.paint(0x8f8d86, { finish: 'matte', flake: 0.2, clearcoat: 0, wear: 0.8 });
  const pane = mats.glass({ tint: 0x9aa6b4, opacity: 0.32 });
  const add = (geo, mat, x, y, z, ry) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.y = ry;
    m.castShadow = true;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    group.add(m);
    return m;
  };
  const yaw = p.yaw;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  // Local (along the rail, across it) -> world.
  const X = (a, b) => p.x + a * s + b * p.nx;
  const Z = (a, b) => p.z + a * c + b * p.nz;

  // The platform: a kerbed slab the doors open onto.
  add(new THREE.BoxGeometry(PLATFORM.wide, PLATFORM.rise, PLATFORM.len), deck,
    p.x, p.y + PLATFORM.rise * 0.5, p.z, Math.atan2(p.nx, p.nz));
  // A tactile edge strip on the rail side, because every platform has one.
  add(new THREE.BoxGeometry(0.34, 0.02, PLATFORM.len), steel,
    X(0, -PLATFORM.wide * 0.5 + 0.22), p.y + PLATFORM.rise + 0.01,
    Z(0, -PLATFORM.wide * 0.5 + 0.22), Math.atan2(p.nx, p.nz));

  // The shelter: four posts, a canopy and a glazed back to the weather.
  const post = new THREE.CylinderGeometry(0.055, 0.065, 2.45, 8);
  for (const a of [-1.55, 1.55]) {
    for (const b of [-0.62, 0.62]) {
      add(post, steel, X(a, b), p.y + PLATFORM.rise + 1.225, Z(a, b), 0);
    }
  }
  add(new THREE.BoxGeometry(1.72, 0.09, 3.7), steel,
    X(0, 0.06), p.y + PLATFORM.rise + 2.49, Z(0, 0.06), Math.atan2(p.nx, p.nz));
  add(new THREE.BoxGeometry(0.03, 1.85, 3.3), pane,
    X(0, 0.66), p.y + PLATFORM.rise + 1.32, Z(0, 0.66), Math.atan2(p.nx, p.nz));
  // The bench inside it.
  add(new THREE.BoxGeometry(0.42, 0.06, 2.4), steel,
    X(0, 0.44), p.y + PLATFORM.rise + 0.46, Z(0, 0.44), Math.atan2(p.nx, p.nz));

  // The name board, on its own post at the up-line end.
  add(new THREE.CylinderGeometry(0.045, 0.05, 2.9, 8), steel,
    X(2.6, 0.2), p.y + PLATFORM.rise + 1.45, Z(2.6, 0.2), 0);
  add(new THREE.BoxGeometry(0.06, 0.46, 1.5), mats.plate(stop.name.slice(0, 12)),
    X(2.6, 0.2), p.y + PLATFORM.rise + 2.62, Z(2.6, 0.2), Math.atan2(p.nx, p.nz));
}

/* ------------------------------------------------------------- service -- */

/**
 * Owns the trolley fleet: finds the emitted rail line, plans the stops, slices
 * it into one section per car, spawns the carriages and poses them
 * kinematically every frame. Created and driven by `VehicleSystem.update` (see
 * the wiring note there); everything it touches outside `vehicles` goes through
 * `ctx.peek` (hard rule 2).
 */
export class TramService {
  /**
   * @param {object} sys   the vehicle system (needs `.spawn`).
   * @param {object} [opts] `paralysed: true` freezes the timetable — the cars
   *        spawn on the rail and never advance. `cars` overrides the fleet
   *        size. Both PROBE-ONLY: the negative controls in `tramprobe.mjs` run
   *        against the live code with no edit (same pattern as
   *        `debugIgnorePause` in freeroam/weapons).
   */
  constructor(sys, opts = {}) {
    this.sys = sys;
    this.opts = opts;
    /** One record per car: { vehicle, mover, section, transit, stops }. */
    this.cars = [];
    /** The stop marks, in order along the line. */
    this.stops = [];
    this.line = null;
    /** The stop furniture group, once built, and its collider handles. */
    this.furniture = null;
    this._furnitureCol = null;
    /** Car 0's handles, kept so every existing reader still works unchanged. */
    this.vehicle = null;
    this.mover = null;
    /** true once we know the map has no usable line — stop asking. */
    this.dead = false;
    // Preallocated scratch (hard rule 5).
    this._f = { x: 0, y: 0, z: 0 };
    this._r = { x: 0, y: 0, z: 0 };
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
  }

  /** Once per frame, with the SCALED dt. Safe to call before world is ready. */
  update(dt, ctx) {
    if (this.dead) return;
    if (!this.cars.length && !this._init(ctx)) return;
    for (let i = 0; i < this.cars.length; i++) this._step(this.cars[i], dt);
  }

  /** Pose one car from its own mover. Was the whole of `update` before. */
  _step(c, dt) {
    const v = c.vehicle;
    if (!v) return;

    // A wrecked tram stops where it was wrecked; its section is blocked. That
    // is a consequence, not a bug — and it must not keep gliding while on fire.
    if (!v.destroyed && !this.opts.paralysed) c.mover.step(dt);

    const m = c.mover;
    m.sampleAt(m.s + BOGIE_HALF, this._f);
    m.sampleAt(m.s - BOGIE_HALF, this._r);
    const dx = this._f.x - this._r.x;
    const dy = this._f.y - this._r.y;
    const dz = this._f.z - this._r.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const yaw = Math.atan2(dx, dz);
    const pitch = -Math.asin(dy / len);

    this._p.set(
      (this._f.x + this._r.x) * 0.5,
      (this._f.y + this._r.y) * 0.5 + v.spec.comY,
      (this._f.z + this._r.z) * 0.5
    );
    v.position.copy(this._p);
    v.prevPosition.copy(this._p);
    v.quaternion.setFromEuler(this._e.set(pitch, yaw, 0, 'YXZ'));
    v.prevQuaternion.copy(v.quaternion);
    // Real velocity, so a car struck at a crossing takes a physical impulse
    // (19.5 t at 9 m/s) instead of meeting a stationary wall that teleports.
    const vs = (m.v * m.dir) / len;
    v.velocity.set(dx * vs, dy * vs, dz * vs);
    v.angularVelocity.set(0, 0, 0);
    // Never let the sleep latch or the pair resolver bank a stale pose.
    v.sleeping = false;
    v._sleepTimer = 0;
    // Brake lamps while it slows for (or stands at) a stop.
    v.control.brake = m.braking ? 1 : 0;
    v.speed = Math.abs(m.v);
    v.forwardSpeed = m.v * m.dir;
  }

  _init(ctx) {
    // `?.` throughout: headless benches drive `VehicleSystem.update` with
    // stub contexts that may have no `peek` and no world. No world, no tram —
    // never a throw.
    const world = ctx?.peek?.('world');
    const roads = world?.roads;
    if (!roads?.edges?.length) return false; // world still building — retry
    const line = extractRailLine(roads, LINE_ID);
    if (!line) {
      // No usable line on this map. Say so once; never retry per-frame.
      console.warn('[vehicles] tram: no continuous ' + LINE_ID + ' rail line emitted');
      this.dead = true;
      return false;
    }
    this.line = line;
    const want = Math.max(1, Math.round(
      this.opts.cars ?? (oneTram() ? 1 : CARS)
    ));
    // A short line cannot hold three sections; the fleet shrinks rather than
    // parking cars on top of each other.
    const fits = Math.max(1, Math.floor((line.length - 2 * CLEAR) / MIN_SECTION));
    const cars = Math.min(want, fits);
    this.stops = planStops(line, roads, cars);
    /**
     * The furniture stands on the PAVEMENT SIDE of the rail, not on the mark.
     * See the block over `RAIL_HALF` for the measurement that forced it. The
     * anchors are solved even when the geometry is not built (a headless bench
     * has no material system), because `tramprobe.mjs` gates the ANCHORS.
     */
    planPlatforms(line, roads, this.stops, world);
    this._buildFurniture(ctx);

    const spec = this.sys.specOf ? this.sys.specOf('tram') : null;
    const comY = spec?.comY ?? 1.15;
    for (let i = 0; i < cars; i++) {
      const a = this.stops[i];
      const b = this.stops[i + 1];
      const section = sliceLine(line, a.s, b.s);
      /**
       * Stagger the start phases so the whole line does not pulse in unison —
       * deterministic (a fixed fraction of the section per car), never `rng`,
       * because a capture has to photograph the same city twice.
       */
      const mover = new RailMover(section, {
        dwell: DWELL,
        margin: CLEAR,
        s0: CLEAR + (section.length - 2 * CLEAR) * ((i * 0.37) % 1),
        ...this.opts.mover,
      });
      mover.sampleAt(mover.s + BOGIE_HALF, this._f);
      mover.sampleAt(mover.s - BOGIE_HALF, this._r);
      const yaw = Math.atan2(this._f.x - this._r.x, this._f.z - this._r.z);
      this._p.set(
        (this._f.x + this._r.x) * 0.5,
        (this._f.y + this._r.y) * 0.5 + comY,
        (this._f.z + this._r.z) * 0.5
      );
      // Ore red, tone 1, gloss, worked-in wear, and ONE plate string for the
      // whole fleet: an exact member of the pre-warmed VARIANTS set, and
      // `PaintShop.plate` caches per string, so three cars compile nothing and
      // cost no extra texture memory over the one that shipped before.
      const v = this.sys.spawn('tram', this._p, yaw, {
        paint: 0x6d1f1c, finish: 'gloss', flake: 0.5, wear: 0.5,
        plate: 'PRT 1713',
      });
      if (!v) continue;
      v.kinematic = true;   // VehicleSystem.fixedUpdate: never integrated
      v.burnsFuel = false;
      v.engineOn = true;
      /**
       * NOT TAKEABLE — RIDEABLE. `game.freeroam`'s walk-up verb is
       * `TAKEABLE(v) = !v.destroyed && v.enterable !== false`, and with the
       * flag unset it happily offered TAKE THE MONONGAHELA at a carriage doing
       * 9 m/s, then silently did nothing when the press reached
       * `player.vehicles.tryEnter` and was refused. `specs.js` has said "not
       * enterable" in prose since the tram landed; this makes it true. The
       * RIDE prompt comes from `src/player/vehicle.js`, which knows about the
       * dwell and can therefore only offer a verb that works.
       */
      v.enterable = false;
      const car = { index: i, vehicle: v, mover, section, from: a, to: b };
      car.transit = makeTransit(car, comY);
      v.transit = car.transit;
      this.cars.push(car);
    }
    if (!this.cars.length) { this.dead = true; return false; }
    this.vehicle = this.cars[0].vehicle;
    this.mover = this.cars[0].mover;
    return true;
  }

  /**
   * One group for every stop's furniture, added once. Registered with physics
   * as a static: a canopy a player walks through is the same defect as a floor
   * he falls through, and this system already owns the only geometry in
   * `vehicles` that never moves.
   *
   * No-ops without a material system, which is what every headless bench has —
   * the anchors are still solved, so the gate still has something to measure.
   */
  _buildFurniture(ctx) {
    if (this.opts.noFurniture || this.furniture || !this.sys.mats) return;
    const g = new THREE.Group();
    g.name = 'tram_stops';
    for (const st of this.stops) buildStopFurniture(this.sys, st, g);
    if (!g.children.length) return;
    (this.sys.root ?? ctx?.scene)?.add(g);
    this.furniture = g;
    this._furnitureCol = this.sys.physics?.addStaticGroup?.(g, 'metal') ?? null;
  }

  dispose() {
    if (this.furniture) {
      if (this._furnitureCol) {
        for (const h of this._furnitureCol) this.sys.physics?.removeStatic?.(h);
      }
      this.furniture.parent?.remove(this.furniture);
      this.furniture.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
      this.furniture = null;
      this._furnitureCol = null;
    }
    // The vehicles themselves are despawned by VehicleSystem.dispose's sweep.
    for (const c of this.cars) { if (c.vehicle) c.vehicle.transit = null; }
    this.cars.length = 0;
    this.stops.length = 0;
    this.vehicle = null;
    this.mover = null;
    this.line = null;
  }
}

/* ------------------------------------------------------------- transit -- */

/**
 * THE RIDE CONTRACT, published on the `Vehicle` as `v.transit`.
 *
 * `src/player/vehicle.js` boards a passenger through exactly this and nothing
 * else — it never imports this module and never reaches into `TramService`.
 * Every field is either a constant or a getter over the mover's own state, so
 * reading it allocates nothing.
 *
 * Local frame note: the tram's model hangs at `-spec.comY`, so vehicle-local
 * y = 0 is the CoM and the wheel-contact plane is at `-comY`. `floorY` (0.90
 * above the rail head, from the spec's style) therefore lands at `0.90 - comY`,
 * and the seat anchor is the SEATED HEAD over it — the same convention
 * `vehicles.seatAnchor()` publishes, which is what `_resolveAnchors` subtracts
 * `GAIT.seat.headHeight` from.
 */
function makeTransit(car, comY) {
  const floorLocalY = 0.90 - comY;
  return {
    kind: 'tram',
    line: LINE_NAME,
    /** Half width of the body, for the platform stand-off. */
    hw: 1.30,
    /** The wheel-contact plane in vehicle-local y. */
    railY: -comY,
    /** Doors are at +/-4.35 in the carriage; board by whichever is nearer. */
    doorZ: [4.35, -4.35],
    /** Seat anchor: the passenger's HEAD, at a window place aft of centre. */
    seat: { x: 0.62, y: floorLocalY + 0.768, z: -1.5 },
    /** The postcard direction, if this service has one. The trolley's is the
     *  street it is running down, so it has none and the camera uses travel. */
    vista: null,
    /** Standing at a stop with the doors open — the only time you may board. */
    get dwelling() {
      return car.mover.wait > 0 && Math.abs(car.mover.v) < 1e-6 && !car.vehicle.destroyed;
    },
    get speed() { return Math.abs(car.mover.v); },
    /** Which mark it is at (or heading for), by name. */
    get stopName() {
      const m = car.mover;
      const nearFrom = m.s - m.sMin < m.sMax - m.s;
      if (m.wait > 0) return (nearFrom ? car.from : car.to).name;
      return (m.dir > 0 ? car.to : car.from).name;
    },
  };
}

export { RAIL_TOP, BOGIE_HALF, CARS, DWELL, CLEAR };
