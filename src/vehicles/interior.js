/**
 * Cabin interior.
 *
 * The chase camera looks straight through the rear screen and out through the
 * windscreen, and the fourth view puts the lens INSIDE this, so an empty shell
 * is immediately obvious — it is the single cheapest tell that a car is a prop.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE BLACK VOID, AND WHY IT WAS TWO DEFECTS WEARING ONE COAT
 * ────────────────────────────────────────────────────────────────────────────
 * The review said "opaque black glass" and "gray untextured blobs inside a
 * black void cabin" as if they were separate complaints. They were one, and it
 * was measurable in two places.
 *
 * 1. THERE WAS NO ROOF ON THE INSIDE. The shell is single-sided, and nothing
 *    lined it: above the belt the cabin was open geometry with only the far
 *    flank behind it. The cockpit frame photographed its top third at
 *    23/28/33 — a hole, not a surface. A car has a HEADLINER, it is the
 *    brightest thing in the cabin, and it is what makes an interior read as
 *    lined rather than as a shell with furniture dropped in it.
 *
 * 2. THE FURNITURE WAS BLACK. `seat()` multiplies a `color` of 0x30333a
 *    (0.030 linear) by `makeFabric`, whose own value is ~0.085 linear. The
 *    product is 0.0026 — an order of magnitude under ARCHITECTURE.md's 0.02
 *    albedo floor, and far below any cloth that has ever been fitted to a car.
 *    The seats were not "untextured", they were unlit black at every exposure.
 *    Fixed in `paint.js`: the map carries the value, the colour only tints.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * BUILT ON THE SURFACE, NOT NEXT TO IT
 * ────────────────────────────────────────────────────────────────────────────
 * The headliner, the door cards and the rear parcel shelf are `loftPatch`es of
 * the car's OWN `BodySurface`, inset a couple of centimetres and flipped to
 * face inward. That is the same trick `geom.js` opens with — a shutline is a
 * strip lying on the surface, not a strip guessed at — and it is the only way a
 * lining matches a roof whose tumblehome, taper and rake are all lofted. A
 * headliner authored as a box is a box you can see the corners of.
 *
 * The steering wheel is the one part that does NOT get merged: it is built at
 * the origin about its own column axis and handed back for `build.js` to put
 * under a pivot, so it can turn with the front wheels. Same treatment as a
 * door or a rotor, and for the same reason.
 */

import * as THREE from 'three';
import {
  roundedBox, transform, mergeAll, mirrorX, tubeBetween, loftPatch,
} from './geom.js';
import { CP, colOf } from './body.js';

/**
 * WHICH SIDE THE WHEEL IS ON. It must be the side the DRIVER is on, and Steel
 * City is Pittsburgh, so that is the car's LEFT.
 *
 * A body whose nose is local +Z has its right along -X (see the derivation over
 * `DRIVER_SIDE` in `index.js`), so the car's left is +X. This file used to put
 * the wheel, the binnacle, its hood and the column at `-hwIn * 0.46` — the
 * car's RIGHT — and `seatAnchor` put the driver there too. The two agreed, so
 * the layout looked self-consistent from the inside and was simply right-hand
 * drive in an American city.
 *
 * Keep this equal to `DRIVER_SIDE` in `index.js`; `drivetest.mjs`'s `layout`
 * section asserts that the wheel and the seat are on the same side of the car
 * and that the side is the left, both against an independently derived right
 * vector.
 */
const WHEEL_SIDE = 1;

/**
 * COLUMN RAKE — how far the wheel lies back from vertical, radians.
 *
 * The old build rotated the rim by `Math.PI/2 - 0.36`, which puts the column
 * axis 69 degrees off the car's forward axis: the wheel lay nearly FLAT, like a
 * bus. Its own column tube ran forward 24 cm while dropping 10, i.e. a 22
 * degree rake — so the two halves of one part disagreed by 47 degrees and the
 * rim floated at an angle no column could reach it at. A car is 20-25 degrees;
 * a van or a truck, sitting over its front axle, is nearer 40.
 */
const RAKE_CAR = 0.36;
const RAKE_HIGH = 0.70;

function emptyInterior() {
  return {
    seat: [], leather: [], dash: [], trim: [], chrome: [], cavity: [], liner: [],
    wheel: null,
  };
}

export { emptyInterior };

/**
 * @param surface the class's own `BodySurface`, when it has one. Everything
 *   that lines a panel needs it; everything that stands on the floor does not,
 *   so a missing surface degrades to the boxed construction rather than
 *   throwing.
 */
export function buildInterior(spec, lod = 0, surface = null) {
  const s = spec.style;
  const out = emptyInterior();
  if (lod >= 2) return out;

  const floorY = s.groundY + Math.max(0.1, s.sillY - 0.16);
  const hip = floorY + 0.2;
  const hwIn = s.hwMax * 0.82;
  const zFront = s.cowlZ - (spec.kind === 'car' ? 0.95 : 0.6);
  const rows = spec.seats >= 4 ? 2 : 1;
  const rowZ = [zFront, zFront - 1.0];
  /**
   * The cabin of a 1.15 m wedge is not the cabin of a 2.3 m van. Size the seat
   * off the actual headroom, or the headrests come out through the roof — which
   * is exactly what they did.
   */
  const headroom = Math.max(0.42, s.roofY - hip - 0.14);
  const backH = Math.min(0.72, headroom * 0.62);
  const hrY = Math.min(s.roofY - 0.13, hip + 0.16 + backH + 0.07);
  const hrH = Math.min(0.18, Math.max(0.09, headroom * 0.2));
  const fine = lod === 0;

  // ---- floor pan ---------------------------------------------------------
  // Carpet, not a void: the pan is the biggest single surface in the cabin and
  // it sits directly under the fourth view's lens.
  const floor = roundedBox(hwIn * 2, 0.05, Math.abs(s.cowlZ - s.backlightBaseZ) + 0.5, 0.02, 1);
  transform(floor, { pos: [0, floorY, (s.cowlZ + s.backlightBaseZ) / 2] });
  out.seat.push(floor);

  // ---- headliner, pillar trim, header rail --------------------------------
  buildLining(spec, surface, out, { lod, hwIn, hip, fine });

  // ---- seats -------------------------------------------------------------
  for (let r = 0; r < rows; r++) {
    const z = rowZ[r];
    if (r === 1 && spec.seats >= 4) {
      // rear bench, one piece
      out.seat.push(seatBase(hwIn * 1.5, 0.5, hip, z - 0.05));
      out.seat.push(seatBack(hwIn * 1.5, backH * 0.94, hip, z - 0.32, 0.19));
      const hr = roundedBox(0.24, hrH * 0.86, 0.11, 0.05, 2);
      transform(hr, { pos: [-hwIn * 0.45, hrY - 0.04, z - 0.36] });
      out.seat.push(hr, mirrorX(hr.clone()));
    } else {
      for (const side of [-1, 1]) {
        const x = side * hwIn * 0.46;
        out.seat.push(transform(seatBase(0.5, 0.5, hip, z), { pos: [x, 0, 0] }));
        out.seat.push(transform(seatBack(0.5, backH, hip, z - 0.27, 0.19), { pos: [x, 0, 0] }));
        const hr = roundedBox(0.24, hrH, 0.12, 0.05, 2);
        transform(hr, { pos: [x, hrY, z - 0.28 - backH * 0.16] });
        out.seat.push(hr);
        // bolsters
        for (const b of [-1, 1]) {
          const bol = roundedBox(0.075, backH * 0.74, 0.14, 0.045, 2);
          transform(bol, { pos: [x + b * 0.21, hip + 0.16 + backH * 0.42, z - 0.24], rot: [0.19, 0, -b * 0.12] });
          out.seat.push(bol);
        }
      }
    }
  }

  // ---- dash --------------------------------------------------------------
  const dashZ = s.cowlZ - 0.24;
  const dashY = s.beltY - 0.02;
  const wheelX = WHEEL_SIDE * hwIn * 0.46;
  buildDash(spec, out, { dashZ, dashY, hwIn, hip, wheelX, fine });

  // ---- steering wheel ----------------------------------------------------
  /**
   * Handed back UNMERGED, geometry at the ORIGIN about +Z. `build.js` puts the
   * placement on the mesh's own transform and slaves its `rotation.z` to the
   * front wheel node the drivetrain already steers, so the rim turns with the
   * road wheels without a second source of truth for steering angle and
   * without a per-frame hook in any system.
   */
  const tall = spec.mass > 3000;
  const rimR = tall ? 0.24 : 0.185;
  const rake = tall ? RAKE_HIGH : RAKE_CAR;
  const wY = dashY + 0.03;
  const wZ = dashZ - 0.36;
  const rim = steeringWheel(rimR, fine);
  if (fine) {
    out.wheel = {
      geo: rim,
      pos: [wheelX, wY, wZ],
      rot: [rake, 0, 0],
      /** Radians of rim per radian of road wheel. A real rack is 12-16:1. */
      ratio: 5.2,
    };
  } else {
    /**
     * LOD1 MERGES IT AND GIVES UP THE ROTATION, and that is the right trade.
     * The separate mesh is what lets the rim turn, and a separate mesh is a
     * DRAW CALL — on the level that carries the whole traffic fleet between 22
     * and 52 m, where a 37 cm wheel behind tinted glass is a couple of pixels
     * and its steering angle is unresolvable. LOD1's budget is ~7 calls a car
     * and forty cars live there; paying one each for an invisible animation is
     * how a fleet eats a frame.
     */
    transform(rim, { pos: [wheelX, wY, wZ], rot: [rake, 0, 0] });
    out.leather.push(rim);
  }
  // The column follows the SAME rake, so the shaft actually arrives at the boss.
  const col = tubeBetween(
    new THREE.Vector3(wheelX, wY, wZ),
    new THREE.Vector3(wheelX, wY - Math.sin(rake) * 0.30, wZ + Math.cos(rake) * 0.30),
    0.034,
    8
  );
  out.leather.push(col);
  if (fine) {
    // Stalks either side of the column — indicators and wipers.
    for (const sx of [-1, 1]) {
      const stalk = tubeBetween(
        new THREE.Vector3(wheelX + sx * 0.045, wY - 0.055, wZ + 0.055),
        new THREE.Vector3(wheelX + sx * 0.155, wY - 0.075, wZ + 0.030),
        0.011,
        5
      );
      out.trim.push(stalk);
    }
  }

  // ---- console + gear lever ---------------------------------------------
  const con = roundedBox(0.26, 0.2, 0.86, 0.05, 2);
  transform(con, { pos: [0, hip - 0.02, dashZ - 0.66] });
  out.leather.push(con);
  const lever = tubeBetween(
    new THREE.Vector3(0, hip + 0.06, dashZ - 0.46),
    new THREE.Vector3(0, hip + 0.24, dashZ - 0.5),
    0.014,
    6
  );
  out.chrome.push(lever);
  const knob = new THREE.SphereGeometry(0.036, 10, 8);
  transform(knob, { pos: [0, hip + 0.26, dashZ - 0.5] });
  out.leather.push(knob);
  if (fine) {
    // Handbrake — the one lever a driver's eye expects next to the seat.
    const hb = tubeBetween(
      new THREE.Vector3(0, hip + 0.05, dashZ - 0.82),
      new THREE.Vector3(0, hip + 0.16, dashZ - 0.96),
      0.017,
      6
    );
    out.leather.push(hb);
  }

  // ---- door cards --------------------------------------------------------
  buildDoorCards(spec, surface, out, { dashZ, hwIn, hip, fine });

  // ---- parcel shelf ------------------------------------------------------
  if (!s.boxBody && spec.kind === 'car') {
    const shelf = roundedBox(hwIn * 1.8, 0.04, 0.42, 0.02, 1);
    transform(shelf, { pos: [0, s.beltY - 0.06, s.backlightBaseZ + 0.2] });
    out.seat.push(shelf);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* lining                                                              */
/* ------------------------------------------------------------------ */

/**
 * The cabin's FITTINGS: header rail, A-pillar trim, visors, grab handles and
 * the rear-view mirror. The roof lining itself comes from `body.js` — see the
 * note below and the split at `CP.ROOF_EDGE` over there.
 */
function buildLining(spec, surface, out, { lod, hwIn, hip, fine }) {
  const s = spec.style;
  const zHeader = s.windscreenTopZ ?? (s.cowlZ - 0.5);
  const zRear = s.boxBody
    ? (s.backlightBaseZ ?? -1.4) + 0.1
    : (s.roofRearZ ?? s.backlightBaseZ ?? -1.2);
  if (zHeader - zRear < 0.25) return;

  /**
   * THE ROOF PANEL ITSELF IS NOT BUILT HERE. `body.js` already lofts a lining
   * across the whole cabin off the same surface (see its note on the split at
   * `CP.ROOF_EDGE`) and hands the roof half over in `out.liner`. Building a
   * second patch under it would be two sheets 2 cm apart, and the outer one
   * would win at every grazing angle — which is precisely how this was found:
   * a raycast out of the driver's eye hit `veh_cavity` at 0.19 m with the new
   * headliner sitting uselessly behind it at 0.25 m.
   *
   * What is built here is what a lofted patch cannot be: the FITTINGS.
   */
  if (!surface) {
    // No lofted shell (nothing in the fleet, but a stub spec in a probe may):
    // a flat panel at the roofline still beats a hole.
    const panel = roundedBox(hwIn * 1.72, 0.03, Math.abs(zHeader - zRear), 0.02, 1);
    transform(panel, { pos: [0, s.roofY - 0.055, (zHeader + zRear) / 2] });
    out.liner.push(panel);
  }

  // Header rail across the top of the windscreen — the visors and the mirror
  // both hang off it, and it is what stops the liner ending in mid-air. Kept
  // BELOW the lining's own inset (5.2 cm) so it reads as a rail on it.
  const rail = roundedBox(hwIn * 1.62, 0.070, 0.10, 0.03, 2);
  transform(rail, { pos: [0, s.roofY - 0.100, zHeader + 0.03] });
  out.liner.push(rail);

  if (lod > 0) return;

  // A-pillar inner trim: cowl corner up to the roof corner, both sides.
  const yTop = s.roofY - 0.09;
  const yBase = Math.max(s.beltY, s.cowlY ?? s.beltY) - 0.02;
  for (const side of [-1, 1]) {
    const pil = tubeBetween(
      new THREE.Vector3(side * hwIn * 0.90, yBase, s.cowlZ - 0.05),
      new THREE.Vector3(side * hwIn * 0.80, yTop, zHeader + 0.02),
      0.036,
      6
    );
    out.liner.push(pil);
  }

  // Sun visors, folded up against the header.
  for (const side of [-1, 1]) {
    const vis = roundedBox(hwIn * 0.60, 0.018, 0.14, 0.012, 1);
    transform(vis, {
      pos: [side * hwIn * 0.42, s.roofY - 0.145, zHeader - 0.05],
      rot: [-0.22, 0, 0],
    });
    out.liner.push(vis);
  }

  // Rear-view mirror on a stalk. The face is `chrome`, which is the only
  // material in the set that actually returns the environment — a mirror that
  // does not reflect is a grey rectangle, and there is one in every review
  // frame that has ever had a cabin in it.
  const stalk = tubeBetween(
    new THREE.Vector3(0, s.roofY - 0.10, zHeader + 0.01),
    new THREE.Vector3(0, s.roofY - 0.165, zHeader - 0.07),
    0.014,
    6
  );
  out.trim.push(stalk);
  const shell = roundedBox(0.26, 0.075, 0.045, 0.018, 1);
  transform(shell, { pos: [0, s.roofY - 0.185, zHeader - 0.085], rot: [0.10, 0, 0] });
  out.trim.push(shell);
  const face = new THREE.PlaneGeometry(0.235, 0.058);
  transform(face, { pos: [0, s.roofY - 0.186, zHeader - 0.108], rot: [Math.PI + 0.10, 0, 0] });
  out.chrome.push(face);

  // Grab handles over the doors — small, and the thing that most cheaply says
  // "this cabin has fittings in it".
  if (fine && hip < s.roofY - 0.6) {
    for (const side of [-1, 1]) {
      const grab = roundedBox(0.035, 0.030, 0.19, 0.014, 1);
      transform(grab, { pos: [side * hwIn * 0.93, s.roofY - 0.145, s.cowlZ - 0.85] });
      out.trim.push(grab);
    }
  }
}

/* ------------------------------------------------------------------ */
/* dash                                                                */
/* ------------------------------------------------------------------ */

/**
 * The physical dash. The HUD cluster stays authoritative for what the numbers
 * SAY; this exists so the thing they are printed on reads as hardware — a roll
 * with a crown on it, a binnacle inside a hood, a vent row with surrounds, a
 * centre stack that stands proud of the fascia, and a knee bolster under it.
 * The old version was three boxes and two floating planes, and from the seat it
 * photographed as one grey slab.
 */
function buildDash(spec, out, { dashZ, dashY, hwIn, hip, wheelX, fine }) {
  // Upper roll: crowned, raked back towards the screen.
  const roll = roundedBox(hwIn * 1.92, 0.22, 0.46, 0.09, 3);
  transform(roll, { pos: [0, dashY - 0.05, dashZ], rot: [0.13, 0, 0] });
  out.leather.push(roll);

  // Fascia: the vertical face under the roll that everything is set into.
  const fascia = roundedBox(hwIn * 1.86, 0.30, 0.11, 0.035, 2);
  transform(fascia, { pos: [0, dashY - 0.20, dashZ - 0.20], rot: [-0.12, 0, 0] });
  out.leather.push(fascia);

  // Knee bolster / lower fascia, so the dash has a bottom edge instead of
  // stopping in space above the carpet.
  const bolster = roundedBox(hwIn * 1.70, 0.20, 0.22, 0.05, 2);
  transform(bolster, { pos: [0, dashY - 0.40, dashZ - 0.12], rot: [0.22, 0, 0] });
  out.trim.push(bolster);

  // Instrument binnacle: the gauge plane, hooded, and now RECESSED into a
  // surround rather than floating in front of the roll.
  const bin = new THREE.PlaneGeometry(0.44, 0.22);
  transform(bin, { pos: [wheelX, dashY + 0.005, dashZ - 0.245], rot: [-0.34, 0, 0] });
  out.dash.push(bin);
  const hood = roundedBox(0.52, 0.10, 0.22, 0.05, 2);
  transform(hood, { pos: [wheelX, dashY + 0.115, dashZ - 0.20], rot: [0.30, 0, 0] });
  out.leather.push(hood);
  if (fine) {
    // Binnacle surround — a shallow ring of dark trim round the gauge plane, so
    // the dials sit INSIDE something.
    for (const dx of [-0.245, 0.245]) {
      const cheek = roundedBox(0.035, 0.20, 0.10, 0.014, 1);
      transform(cheek, { pos: [wheelX + dx, dashY + 0.005, dashZ - 0.225], rot: [-0.34, 0, 0] });
      out.trim.push(cheek);
    }
  }

  // Centre stack, standing proud of the fascia, with the screen set into it.
  const stack = roundedBox(0.34, 0.36, 0.13, 0.03, 2);
  transform(stack, { pos: [0, dashY - 0.11, dashZ - 0.225], rot: [-0.15, 0, 0] });
  out.trim.push(stack);
  const screen = new THREE.PlaneGeometry(0.22, 0.13);
  transform(screen, { pos: [0, dashY - 0.025, dashZ - 0.288], rot: [-0.15, 0, 0] });
  out.dash.push(screen);

  if (!fine) return;

  // Vent row: four dark apertures with bright surrounds, spread across the
  // fascia. Cheap, and it is the detail that reads first from the seat.
  for (let i = 0; i < 4; i++) {
    const x = (i - 1.5) * hwIn * 0.52;
    const surround = roundedBox(0.115, 0.062, 0.045, 0.012, 1);
    transform(surround, { pos: [x, dashY - 0.135, dashZ - 0.245], rot: [-0.12, 0, 0] });
    out.chrome.push(surround);
    const mouth = roundedBox(0.088, 0.038, 0.030, 0.006, 1);
    transform(mouth, { pos: [x, dashY - 0.135, dashZ - 0.258], rot: [-0.12, 0, 0] });
    out.cavity.push(mouth);
  }
  // Switch bank under the screen.
  for (let i = 0; i < 3; i++) {
    const sw = roundedBox(0.052, 0.026, 0.018, 0.006, 1);
    transform(sw, { pos: [(i - 1) * 0.075, dashY - 0.205, dashZ - 0.276], rot: [-0.15, 0, 0] });
    out.chrome.push(sw);
  }
  // Glovebox seam on the passenger side — a shadow line, not a stripe.
  const seam = roundedBox(hwIn * 0.66, 0.008, 0.012, 0.003, 1);
  transform(seam, { pos: [-wheelX * 0.95, dashY - 0.245, dashZ - 0.252] });
  out.cavity.push(seam);
  // Pedal box, visible from the seat and from a swung-open door.
  for (let i = 0; i < 2; i++) {
    const ped = roundedBox(0.062, 0.13, 0.020, 0.006, 1);
    transform(ped, {
      pos: [wheelX + (i === 0 ? -0.085 : 0.055), hip - 0.155, dashZ + 0.02],
      rot: [0.34, 0, 0],
    });
    out.chrome.push(ped);
  }
}

/* ------------------------------------------------------------------ */
/* door cards                                                          */
/* ------------------------------------------------------------------ */

/**
 * The inner face of each door. Lofted off the shell between the belt line and
 * the sill so it follows the real tumblehome, then dressed: a cloth insert, a
 * leather armrest, a chrome pull and a dark speaker grille.
 *
 * It used to be a 5 cm slab of bumper plastic parked at a fixed half-width. In
 * the cockpit frame it was the largest object in shot and it photographed as a
 * block of concrete, which is most of what "gray untextured blobs" meant.
 */
function buildDoorCards(spec, surface, out, { dashZ, hwIn, hip, fine }) {
  const s = spec.style;
  const z0 = s.cowlZ - 0.10;
  const z1 = Math.min(s.backlightBaseZ + 0.20, z0 - 0.6);
  const beltY = s.beltY;

  if (surface) {
    const cBelt = colOf(CP.BELT, surface.perSeg);
    const cSill = colOf(CP.SILL, surface.perSeg);
    const card = loftPatch(surface, {
      c0: cBelt,
      c1: cSill,
      z0: z1,
      z1: z0,
      inset: 0.055,
      zSamples: fine ? 8 : 4,
      sides: [1, -1],
      flip: true,
    });
    if (card) out.trim.push(card);
  } else {
    const card = roundedBox(0.05, beltY - hip + 0.18, Math.abs(z1 - z0), 0.02, 1);
    transform(card, { pos: [-hwIn * 0.99, (beltY + hip) * 0.5 - 0.02, (z0 + z1) / 2] });
    out.trim.push(card, mirrorX(card.clone()));
  }

  if (!fine) return;

  const xCard = hwIn * 0.96;
  // Armrest with the pull cup under it.
  const arm = roundedBox(0.085, 0.085, 0.44, 0.03, 2);
  transform(arm, { pos: [-xCard, hip + 0.28, dashZ - 0.50] });
  out.leather.push(arm, mirrorX(arm.clone()));
  const pull = roundedBox(0.030, 0.030, 0.15, 0.010, 1);
  transform(pull, { pos: [-xCard + 0.035, hip + 0.29, dashZ - 0.34] });
  out.chrome.push(pull, mirrorX(pull.clone()));
  // Cloth insert — the panel a real door card breaks its plastic with.
  const insert = roundedBox(0.022, 0.16, 0.40, 0.012, 1);
  transform(insert, { pos: [-xCard + 0.012, hip + 0.10, dashZ - 0.52] });
  out.seat.push(insert, mirrorX(insert.clone()));
  // Speaker grille low in the card.
  const spk = roundedBox(0.016, 0.115, 0.115, 0.045, 2);
  transform(spk, { pos: [-xCard + 0.010, hip - 0.03, dashZ - 0.24] });
  out.cavity.push(spk, mirrorX(spk.clone()));
  // Window switch pack on the armrest.
  const sw = roundedBox(0.028, 0.014, 0.075, 0.005, 1);
  transform(sw, { pos: [-xCard + 0.048, hip + 0.322, dashZ - 0.55] });
  out.chrome.push(sw, mirrorX(sw.clone()));
}

/* ------------------------------------------------------------------ */
/* parts                                                               */
/* ------------------------------------------------------------------ */

/**
 * The rim, three spokes, the boss and the shroud, ALL AT THE ORIGIN with the
 * column along +Z. `build.js` puts the placement on the pivot, so a rotation
 * about local z is a rotation about the column and nothing else — build it in
 * place and the same rotation swings the wheel through the dashboard.
 */
function steeringWheel(rimR, fine) {
  const parts = [];
  const rim = new THREE.TorusGeometry(rimR, 0.021, fine ? 8 : 5, fine ? 24 : 12);
  parts.push(rim);
  for (let i = 0; i < 3; i++) {
    const a = Math.PI * 0.5 + (i / 3) * Math.PI * 2;
    const sp = roundedBox(0.038, rimR * 0.94, 0.020, 0.007, 1);
    transform(sp, {
      pos: [Math.cos(a) * rimR * 0.5, Math.sin(a) * rimR * 0.5, 0],
      rot: [0, 0, -a + Math.PI / 2],
    });
    parts.push(sp);
  }
  const boss = new THREE.CylinderGeometry(0.058, 0.052, 0.045, 12);
  transform(boss, { pos: [0, 0, 0.008], rot: [Math.PI / 2, 0, 0] });
  parts.push(boss);
  if (fine) {
    // Thumb grips at ten and two — the silhouette cue that says "wheel" at a
    // glance, and the reason a plain torus reads as a hoop.
    for (const sx of [-1, 1]) {
      const grip = roundedBox(0.030, 0.10, 0.030, 0.012, 1);
      transform(grip, { pos: [sx * rimR * 0.93, rimR * 0.30, -0.012] });
      parts.push(grip);
    }
  }
  return mergeAll(parts);
}

function seatBase(w, d, y, z) {
  const g = roundedBox(w, 0.16, d, 0.06, 2);
  transform(g, { pos: [0, y, z] });
  return g;
}

function seatBack(w, h, y, z, lean) {
  const g = roundedBox(w, h, 0.16, 0.06, 2);
  transform(g, { pos: [0, y + h * 0.5 + 0.04, z], rot: [lean, 0, 0] });
  return g;
}

/** Open helm for the boat: bench seats, a console and a wheel. */
export function buildBoatInterior(spec, lod = 0) {
  const s = spec.style;
  const out = emptyInterior();
  if (lod >= 2) return out;
  const deck = s.deckY;

  // The helm sits with the helmsman: `seatAnchor` puts the boat driver on
  // `DRIVER_SIDE` too, and a console on the other side of the deck from the
  // seat is the same defect as a right-hand-drive car.
  const hx = WHEEL_SIDE * 0.3;
  const console_ = roundedBox(0.72, 0.62, 0.5, 0.09, 3);
  transform(console_, { pos: [hx, deck + 0.31, s.consoleZ] });
  out.trim.push(console_);
  const face = new THREE.PlaneGeometry(0.4, 0.2);
  transform(face, { pos: [hx, deck + 0.5, s.consoleZ - 0.26], rot: [-0.3, 0, 0] });
  out.dash.push(face);
  // Same LOD rule as the car: its own mesh only where the rotation can be seen.
  const helm = steeringWheel(0.14, lod === 0);
  if (lod === 0) {
    out.wheel = {
      geo: helm,
      pos: [hx, deck + 0.56, s.consoleZ - 0.3],
      rot: [0.45, 0, 0],
      ratio: 3.0,
    };
  } else {
    transform(helm, { pos: [hx, deck + 0.56, s.consoleZ - 0.3], rot: [0.45, 0, 0] });
    out.leather.push(helm);
  }

  for (let i = 0; i < 2; i++) {
    const z = s.consoleZ - 0.6 - i * 0.8;
    const b = roundedBox(1.6, 0.16, 0.5, 0.05, 2);
    transform(b, { pos: [0, deck + 0.24, z] });
    out.seat.push(b);
    const back = roundedBox(1.6, 0.42, 0.14, 0.05, 2);
    transform(back, { pos: [0, deck + 0.5, z - 0.24], rot: [0.18, 0, 0] });
    out.seat.push(back);
  }
  return out;
}
