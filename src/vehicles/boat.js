/**
 * River hulls — the Riverjack, the Three Rivers Clipper — and hydrodynamics.
 *
 * Carson's whole arc is on the water and the three rivers are a third of the
 * map, so this is a real displacement/planing model, not a car with the wheels
 * turned off:
 *
 *   - buoyancy is sampled at twelve points spread over the hull, each
 *     contributing rho*g*V of the volume it has pushed under the local water
 *     surface. Twelve samples rather than one is what gives roll and pitch
 *     stiffness for free, and it is why the boat heels into a turn and squats
 *     when the throttle goes down.
 *   - at rest the boat floats bow-up on its transom; above the planing speed
 *     the dynamic lift on the after-body pulls the bow down and the hull climbs
 *     out of the water, which drops the wetted area and doubles the top speed.
 *   - lateral drag is 25x longitudinal, so it tracks straight and skids
 *     sideways in a hard turn like a real V-hull.
 *   - the rudder/outdrive only bites when there is thrust, so chopping the
 *     throttle mid-turn kills the steering exactly as it does on the water.
 */

import * as THREE from 'three';
import {
  BodySurface, loftBody, roundedBox, transform, mergeAll, mirrorX, tubeBetween, sweep, VEH_DETAIL,
} from './geom.js';
import { CP } from './body.js';

const PER_SEG = [3, 2, 1, 1];
const Z_SAMPLES = [90, 46, 22, 10];

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function hullStation(z, o) {
  const { hw, sheer, chineY, chineX, keel, deckIn, deckY, hard = false } = o;
  const ctrl = new Array(11);
  ctrl[CP.TOP] = { x: 0, y: deckY };
  ctrl[CP.ROOF_MID] = { x: deckIn * 0.55, y: deckY + 0.005 };
  ctrl[CP.ROOF_EDGE] = { x: deckIn, y: deckY + 0.01, hard: true };
  ctrl[CP.GLASS_MID] = { x: (deckIn + hw) * 0.5, y: (deckY + sheer) * 0.5 + 0.02 };
  ctrl[CP.BELT] = { x: hw * 0.99, y: sheer, hard: true };
  ctrl[CP.SHOULDER] = { x: hw, y: sheer - 0.1, hard: true };
  ctrl[CP.CREASE] = { x: chineX, y: chineY, hard: true }; // the chine
  ctrl[CP.LOWER] = { x: chineX * 0.7, y: chineY - (chineY - keel) * 0.34 };
  ctrl[CP.SILL] = { x: chineX * 0.36, y: chineY - (chineY - keel) * 0.72, hard: false };
  ctrl[CP.FLOOR_EDGE] = { x: chineX * 0.1, y: keel + 0.015 };
  ctrl[CP.FLOOR] = { x: 0, y: keel };
  return { z, ctrl, hard };
}

function boatStations(spec) {
  const s = spec.style;
  const hw = s.hwMax;
  const sheer = s.sheerY;
  const keel = s.keelY;
  const deck = s.deckY;
  const bow = s.bowZ;
  const stern = s.sternZ;
  const out = [];

  const at = (t) => bow + (stern - bow) * t;

  // Bow: fine entry, deep V, high sheer.
  out.push(hullStation(bow, {
    hw: hw * 0.1, sheer: sheer + 0.2, chineY: sheer - 0.02, chineX: hw * 0.08,
    keel: keel + 0.44, deckIn: hw * 0.06, deckY: sheer + 0.18, hard: true,
  }));
  out.push(hullStation(at(0.08), {
    hw: hw * 0.42, sheer: sheer + 0.13, chineY: sheer - 0.24, chineX: hw * 0.36,
    keel: keel + 0.3, deckIn: hw * 0.3, deckY: sheer + 0.08,
  }));
  out.push(hullStation(at(0.22), {
    hw: hw * 0.76, sheer: sheer + 0.06, chineY: sheer - 0.44, chineX: hw * 0.7,
    keel: keel + 0.14, deckIn: hw * 0.56, deckY: deck + 0.09,
  }));
  out.push(hullStation(at(0.38), {
    hw: hw * 0.94, sheer: sheer + 0.01, chineY: sheer - 0.56, chineX: hw * 0.9,
    keel: keel + 0.04, deckIn: hw * 0.72, deckY: deck + 0.03,
  }));
  out.push(hullStation(at(0.55), {
    hw, sheer, chineY: sheer - 0.62, chineX: hw * 0.97, keel,
    deckIn: hw * 0.78, deckY: deck,
  }));
  out.push(hullStation(at(0.75), {
    hw, sheer: sheer - 0.02, chineY: sheer - 0.64, chineX: hw * 0.99, keel: keel + 0.03,
    deckIn: hw * 0.8, deckY: deck,
  }));
  out.push(hullStation(at(0.94), {
    hw: hw * 0.98, sheer: sheer - 0.04, chineY: sheer - 0.64, chineX: hw * 0.97, keel: keel + 0.08,
    deckIn: hw * 0.8, deckY: deck - 0.01,
  }));
  // Transom: a flat, hard cut.
  out.push(hullStation(stern, {
    hw: hw * 0.96, sheer: sheer - 0.05, chineY: sheer - 0.63, chineX: hw * 0.95, keel: keel + 0.1,
    deckIn: hw * 0.78, deckY: deck - 0.02, hard: true,
  }));
  return out;
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE PACKET HULL — the Three Rivers Clipper's, and nothing else's
 * ────────────────────────────────────────────────────────────────────────────
 * A paddle steamer is the OPPOSITE of the Riverjack in every section. The
 * Riverjack is a deep-V planing hull: a fine entry, a hard chine, a keel 42 cm
 * under the waterline and a sheer that rises to the bow. A western-rivers
 * packet is a shallow-draft BOX — full-length parallel sides, a flat bottom
 * drawing under a metre so it can work a river that silts, and a long raked
 * "spoonbill" forefoot that lets it drive its own nose onto a bank. It cannot
 * be got by scaling the other one up: a 26 m deep-V would draw four metres and
 * would be a yacht, not a river boat.
 *
 * So it is its own station list, on the same eleven control points, and the
 * whole shape is four facts: the bottom is FLAT (`keel` constant, `chineX`
 * near full beam everywhere), the sides are VERTICAL (`hw` and `chineX` agree),
 * the forefoot RAKES up over the forward fifth, and the transom is square
 * because a paddle wheel has to hang off it.
 */
function clipperStations(spec) {
  const s = spec.style;
  const hw = s.hwMax;
  const sheer = s.sheerY;
  const keel = s.keelY;
  const deck = s.deckY;
  const bow = s.bowZ;
  const stern = s.sternZ;
  const out = [];
  const at = (t) => bow + (stern - bow) * t;

  /** One box station: vertical sides, flat bottom, at beam fraction `b`. */
  const box = (t, b, keelY, hard = false) => hullStation(at(t), {
    hw: hw * b,
    sheer,
    chineY: keelY + 0.10,
    chineX: hw * b * 0.985,
    keel: keelY,
    deckIn: hw * b * 0.9,
    deckY: deck,
    hard,
  });

  // The raked forefoot: the bottom lifts clear of the water and the beam comes
  // in, but the SIDES stay upright the whole way — that is the packet's blunt,
  // shouldered bow, not a yacht's fine entry.
  out.push(box(0.00, 0.30, keel + 1.25, true));
  out.push(box(0.045, 0.56, keel + 0.92));
  out.push(box(0.10, 0.80, keel + 0.52));
  out.push(box(0.16, 0.94, keel + 0.18));
  out.push(box(0.24, 1.00, keel + 0.02));
  // The long parallel middle body — most of the boat, and the reason it is
  // stable enough to carry two decks of passengers.
  out.push(box(0.45, 1.00, keel));
  out.push(box(0.70, 1.00, keel));
  out.push(box(0.90, 1.00, keel + 0.02));
  // Square transom: the paddle wheel hangs on it.
  out.push(box(1.00, 0.985, keel + 0.06, true));
  return out;
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE THREE RIVERS CLIPPER — a two-deck sternwheel river cruiser
 * ────────────────────────────────────────────────────────────────────────────
 * Steel City's excursion fleet, and the only vessel on the three rivers that
 * anybody in the city would recognise from the far bank. The read, in the order
 * a person picks it up from three hundred metres:
 *
 *   1. the RED PADDLE WHEEL turning on the transom. Nothing else on the water
 *      has one, so it identifies the class before any other feature resolves.
 *   2. a WHITE TWO-DECK BOX — two full-length houses with continuous window
 *      bands and railed promenades round both, which is a shape no other hull
 *      in the fleet has.
 *   3. the STACKS and the pilothouse standing above it.
 *
 * WHY THE WHEEL IS ITS OWN MATERIAL. It is painted steel, exactly like the
 * white hull beside it, so it cannot be `trim` (grey grained plastic) and it
 * cannot be `paint` (that is the hull's colour). `paint.js` grew an `accent`
 * group for it — see the note there — driven by `style.accent`.
 *
 * SIZE. 26 m over the hull with a 7.2 m beam, which is a genuine small
 * excursion packet and about four Riverjacks. The Monongahela is 136 m wide at
 * this scale and the Ohio 184, so she has room to turn; nothing smaller reads
 * as a cruise boat next to a bridge pier.
 */
function buildClipper(spec, lod = 0) {
  const s = spec.style;
  const perSeg = PER_SEG[lod];
  const surface = new BodySurface(clipperStations(spec), perSeg);
  const C = (cp) => cp * perSeg;
  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [], lamps: {}, plate: [],
    disc: [], accent: [], grilleMesh: [], rotors: [], surface, anchors: { exhaust: [] },
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);
  // `VEH_DETAIL` is the `?owNoVehDetail=1` A/B hatch — see geom.js.
  const near = lod < 2 && VEH_DETAIL;
  /**
   * Stanchions, mullions and guy wires are LOD0 only. They are 2 400 triangles
   * of thin tube — more than the entire second deck — and at the 22 m LOD1
   * threshold a 3 cm post on a boat that is usually a hundred metres away is
   * well under a pixel. The top rails stay to LOD1, because a continuous line
   * along a deck edge is a silhouette feature and does survive.
   */
  const close = lod < 1 && VEH_DETAIL;

  const hw = s.hwMax;
  const deck = s.deckY;
  const bow = s.bowZ;
  const stern = s.sternZ;
  const D = s.decks;   // { h1, h2, pilot } deck heights above `deckY`

  out.paint.push(loftBody(surface, { zSamples: Z_SAMPLES[lod], uvScale: 2.4 }));

  /**
   * The boot-top: a red band along the sheer, at the one height where the eye
   * reads a waterline. It is the only thing keeping a 26 m white slab from
   * being one unbroken value from bow to stern in overcast light.
   */
  {
    const n = lod < 1 ? 22 : 10;
    const rail = [];
    for (let i = 0; i < n; i++) {
      const z = bow + ((stern - bow) * i) / (n - 1);
      const prof = surface.profileAt(z);
      const ci = Math.max(0, Math.min(surface.cols - 1, C(CP.BELT)));
      rail.push(new THREE.Vector3(prof[ci].x + 0.02, prof[ci].y - 0.16, z));
    }
    const band = sweep(
      [{ x: 0.03, y: 0.16 }, { x: 0.05, y: 0 }, { x: 0.03, y: -0.16 },
        { x: -0.05, y: -0.16 }, { x: -0.05, y: 0.16 }],
      rail,
      { closed: true, caps: true, up: new THREE.Vector3(0, 1, 0) }
    );
    out.accent.push(band, mirrorX(band.clone()));
  }

  /**
   * A DECK is a slab plus its railing, and a HOUSE is a box with a continuous
   * window band cut into it. Both twice, so they are helpers — and the window
   * band is not decoration: a superstructure with no glazing line is a shipping
   * container, and the band is what says "people are standing in there".
   */
  const deckSlab = (y, halfW, z0, z1) => {
    const slab = roundedBox(halfW * 2, 0.14, z1 - z0, 0.03, 1);
    transform(slab, { pos: [0, y, (z0 + z1) * 0.5] });
    out.paint.push(slab);
    if (!near) return;
    // Rail: a top tube on stanchions, both sides, plus a return across the aft
    // end so the promenade is enclosed rather than open to the drop.
    const ry = y + 0.55;
    for (const side of [-1, 1]) {
      out.chrome.push(tubeBetween(
        new THREE.Vector3(side * halfW, ry, z1 - 0.1),
        new THREE.Vector3(side * halfW, ry, z0 + 0.1), 0.035, 6
      ));
      out.chrome.push(tubeBetween(
        new THREE.Vector3(side * halfW, y + 0.28, z1 - 0.1),
        new THREE.Vector3(side * halfW, y + 0.28, z0 + 0.1), 0.026, 5
      ));
      if (!close) continue;
      const nP = Math.max(4, Math.round((z1 - z0) / 1.5));
      for (let i = 0; i <= nP; i++) {
        const z = z0 + 0.1 + ((z1 - z0 - 0.2) * i) / nP;
        out.chrome.push(tubeBetween(
          new THREE.Vector3(side * halfW, y + 0.07, z),
          new THREE.Vector3(side * halfW, ry, z), 0.028, 5
        ));
      }
    }
    out.chrome.push(tubeBetween(
      new THREE.Vector3(-halfW, ry, z0 + 0.1),
      new THREE.Vector3(halfW, ry, z0 + 0.1), 0.035, 6
    ));
  };

  const house = (y0, y1, halfW, z0, z1) => {
    const h = y1 - y0;
    const box = roundedBox(halfW * 2, h, z1 - z0, 0.10, 2);
    transform(box, { pos: [0, (y0 + y1) * 0.5, (z0 + z1) * 0.5] });
    out.paint.push(box);
    if (!near) return;
    // The window band: a recessed dark channel with glass in it, all the way
    // round three sides.
    const wy = y1 - h * 0.42;
    const wh = h * 0.40;
    for (const side of [-1, 1]) {
      const rec = roundedBox(0.10, wh + 0.10, z1 - z0 - 0.5, 0.02, 1);
      transform(rec, { pos: [side * (halfW - 0.02), wy, (z0 + z1) * 0.5] });
      out.cavity.push(rec);
      const pane = roundedBox(0.05, wh, z1 - z0 - 0.62, 0.02, 1);
      transform(pane, { pos: [side * (halfW + 0.015), wy, (z0 + z1) * 0.5] });
      out.glass.push(pane);
      // Mullions, so the band is a row of windows and not one long slot.
      if (!close) continue;
      const nW = Math.max(4, Math.round((z1 - z0) / 2.0));
      for (let i = 1; i < nW; i++) {
        const mz = z0 + 0.31 + ((z1 - z0 - 0.62) * i) / nW;
        const mul = roundedBox(0.09, wh + 0.06, 0.10, 0.02, 1);
        transform(mul, { pos: [side * (halfW + 0.01), wy, mz] });
        out.paint.push(mul);
      }
    }
    // Forward face: a wide window over the bow.
    const fr = roundedBox(halfW * 1.5, wh + 0.10, 0.10, 0.02, 1);
    transform(fr, { pos: [0, wy, z1 - 0.02] });
    out.cavity.push(fr);
    const fg = roundedBox(halfW * 1.42, wh, 0.05, 0.02, 1);
    transform(fg, { pos: [0, wy, z1 + 0.015] });
    out.glass.push(fg);
  };

  const y1 = deck + D.h1;      // top of the main-deck house / promenade floor
  const y2 = y1 + 0.14 + D.h2; // top of the upper house / sun-deck floor

  // Main deck: the house sits on the hull, the promenade runs round it.
  deckSlab(deck, hw * 1.02, stern + 0.6, bow - 1.4);
  house(deck + 0.12, y1, hw * 0.86, stern + 1.6, bow - 3.2);
  // Second deck.
  deckSlab(y1 + 0.07, hw * 0.99, stern + 1.0, bow - 2.2);
  house(y1 + 0.14, y2, hw * 0.76, stern + 2.4, bow - 4.4);
  // Sun deck on top.
  deckSlab(y2 + 0.07, hw * 0.86, stern + 2.0, bow - 3.6);

  /* ---- pilothouse -------------------------------------------------------- */
  {
    const py = y2 + 0.14;
    const ph = D.pilot;
    const phw = hw * 0.44;
    const pz = bow - 6.2;
    const cab = roundedBox(phw * 2, ph, 3.0, 0.10, 2);
    transform(cab, { pos: [0, py + ph * 0.5, pz] });
    out.paint.push(cab);
    if (near) {
      // Glazed on all four sides — a wheelhouse is mostly window.
      for (const side of [-1, 1]) {
        const g = roundedBox(0.05, ph * 0.52, 2.5, 0.02, 1);
        transform(g, { pos: [side * (phw + 0.015), py + ph * 0.66, pz] });
        out.glass.push(g);
      }
      const gf = roundedBox(phw * 1.8, ph * 0.52, 0.05, 0.02, 1);
      transform(gf, { pos: [0, py + ph * 0.66, pz + 1.515] });
      out.glass.push(gf);
      // Roof cap and a searchlight on it — the packet's night eye.
      const cap = roundedBox(phw * 2.2, 0.10, 3.3, 0.03, 1);
      transform(cap, { pos: [0, py + ph + 0.05, pz] });
      out.paint.push(cap);
      const drum = new THREE.CylinderGeometry(0.22, 0.22, 0.30, 10);
      transform(drum, { pos: [0, py + ph + 0.26, pz + 1.0], rot: [Math.PI * 0.5, 0, 0] });
      out.chrome.push(drum);
      lamp('head', transform(new THREE.CircleGeometry(0.19, 12), { pos: [0, py + ph + 0.26, pz + 1.17] }));
      // Jackstaff on the bow and the mast light aft of the wheelhouse.
      out.chrome.push(tubeBetween(
        new THREE.Vector3(0, deck + 0.1, bow - 0.9),
        new THREE.Vector3(0, deck + 2.4, bow - 0.9), 0.05, 6
      ));
      out.chrome.push(tubeBetween(
        new THREE.Vector3(0, py + ph + 0.1, pz - 1.3),
        new THREE.Vector3(0, py + ph + 2.2, pz - 1.3), 0.05, 6
      ));
      lamp('drl', transform(new THREE.SphereGeometry(0.10, 8, 6), { pos: [0, py + ph + 2.3, pz - 1.3] }));
    }
  }

  /* ---- stacks ------------------------------------------------------------ */
  {
    const sy = y2 + 0.14;
    const sh = s.stackH ?? 3.2;
    for (const side of [-1, 1]) {
      const x = side * hw * 0.30;
      const z = bow - 9.6;
      const pipe = new THREE.CylinderGeometry(0.34, 0.40, sh, lod < 1 ? 12 : 8, 1, true);
      transform(pipe, { pos: [x, sy + sh * 0.5, z] });
      out.trim.push(pipe);
      // The crown band, in the house colour — every packet's stacks carry one.
      const crown = new THREE.CylinderGeometry(0.40, 0.40, 0.34, lod < 1 ? 12 : 8, 1, true);
      transform(crown, { pos: [x, sy + sh - 0.24, z] });
      out.accent.push(crown);
      // The mouth, so the top is a pipe and not a peg.
      const mouth = new THREE.CircleGeometry(0.33, lod < 1 ? 12 : 8);
      transform(mouth, { pos: [x, sy + sh - 0.01, z], rot: [Math.PI * 0.5, 0, 0] });
      out.cavity.push(mouth);
      out.anchors.exhaust.push(new THREE.Vector3(x, sy + sh + 0.1, z));
      if (close) {
        // Guy wires forward and aft — the tell that a stack is a stack.
        for (const dz of [2.4, -2.4]) {
          out.chrome.push(tubeBetween(
            new THREE.Vector3(x, sy + sh - 0.5, z),
            new THREE.Vector3(x, sy + 0.05, z + dz), 0.02, 4
          ));
        }
      }
    }
  }

  /* ---- THE PADDLE WHEEL -------------------------------------------------- */
  /**
   * A sternwheel, on the transom, in the accent colour. Two rims per side with
   * radial arms between them and a flat BUCKET across every arm pair — a wheel
   * built as a disc reads as a cable drum, and it is the buckets catching the
   * light at different angles that make it read as a paddle wheel even when it
   * is not turning.
   */
  {
    const w = s.paddle;   // { r, halfW, buckets, y, z }
    const wz = stern - w.z;
    const nB = Math.max(6, (lod < 1 ? w.buckets : Math.round(w.buckets * 0.6)) | 0);
    // Axle, through both hubs and out to the transom brackets.
    const axle = new THREE.CylinderGeometry(0.16, 0.16, w.halfW * 2.4, 8);
    transform(axle, { pos: [0, w.y, wz], rot: [0, 0, Math.PI * 0.5] });
    out.trim.push(axle);
    /**
     * THE WHEEL IS ITS OWN PIVOT, so it can TURN. Same contract as a
     * helicopter's rotor (`out.rotors`): geometry built about the hub, a pivot
     * group at the axle, and `Vehicle.syncTransforms` writing the phase. Axis
     * 'x' because the axle is transverse — which is also the axis three's
     * rotor sync drives from `tailPhase`, and `stepBoat` advances that phase
     * from the hull's own speed. A sternwheeler with a static wheel is a
     * postcard; the whole point of the class is the one moving part.
     *
     * The pivot geometry is authored at the ORIGIN and offset by `pivot.pos`,
     * or every revolution would swing the wheel round the boat.
     */
    const spin = [];
    for (const side of [-1, 1]) {
      for (const rf of [1.0, 0.62]) {
        const rim = new THREE.TorusGeometry(w.r * rf, 0.075, 6, lod < 1 ? 20 : 10);
        transform(rim, { pos: [side * w.halfW, 0, 0], rot: [0, Math.PI * 0.5, 0] });
        spin.push(rim);
      }
      const hub = new THREE.CylinderGeometry(0.30, 0.30, 0.24, 10);
      transform(hub, { pos: [side * w.halfW, 0, 0], rot: [0, 0, Math.PI * 0.5] });
      spin.push(hub);
    }
    for (let i = 0; i < nB; i++) {
      const a = (i / nB) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // The bucket: a flat board on the rim, tangential faces outward.
      const bucket = roundedBox(w.halfW * 2, 0.09, w.r * 0.34, 0.02, 1);
      transform(bucket, {
        pos: [0, sa * (w.r - 0.14), ca * (w.r - 0.14)],
        rot: [-a, 0, 0],
      });
      spin.push(bucket);
      if (near) {
        for (const side of [-1, 1]) {
          spin.push(tubeBetween(
            new THREE.Vector3(side * w.halfW, sa * w.r * 0.55, ca * w.r * 0.55),
            new THREE.Vector3(side * w.halfW, sa * w.r, ca * w.r), 0.05, 4
          ));
        }
      }
    }
    out.rotors.push({ pos: [0, w.y, wz], axis: 'x', mat: 'accent', geo: mergeAll(spin) });
    /**
     * THE FANTAIL — the deck carried aft OVER the wheel, which is what a
     * sternwheeler has and what makes the wheel read as being inside the boat
     * rather than towed behind it. A flat shelf level with the main deck, two
     * vertical hangers down to the axle, and a rail across the after end so the
     * shape closes.
     */
    const fanY = deck + 0.03;
    const guard = roundedBox(w.halfW * 2.5, 0.12, w.r * 1.5, 0.03, 1);
    transform(guard, { pos: [0, fanY, stern - w.r * 0.55] });
    out.paint.push(guard);
    for (const side of [-1, 1]) {
      const hang = roundedBox(0.16, fanY - w.y, w.r * 0.5, 0.03, 1);
      transform(hang, { pos: [side * w.halfW * 1.16, (fanY + w.y) * 0.5, wz] });
      out.paint.push(hang);
      if (near) {
        out.chrome.push(tubeBetween(
          new THREE.Vector3(side * w.halfW * 1.2, fanY + 0.55, stern + 0.2),
          new THREE.Vector3(side * w.halfW * 1.2, fanY + 0.55, stern - w.r * 1.25), 0.035, 6
        ));
      }
    }
    if (near) {
      out.chrome.push(tubeBetween(
        new THREE.Vector3(-w.halfW * 1.2, fanY + 0.55, stern - w.r * 1.25),
        new THREE.Vector3(w.halfW * 1.2, fanY + 0.55, stern - w.r * 1.25), 0.035, 6
      ));
    }
    out.anchors.prop = new THREE.Vector3(0, w.y - w.r * 0.6, wz);
  }

  /* ---- nav lights -------------------------------------------------------- */
  lamp('policeRed', transform(new THREE.SphereGeometry(0.10, 8, 6),
    { pos: [-hw * 0.94, deck + 0.5, bow - 2.6] }));
  lamp('drl', transform(new THREE.SphereGeometry(0.10, 8, 6),
    { pos: [hw * 0.94, deck + 0.5, bow - 2.6] }));
  lamp('brake', transform(new THREE.SphereGeometry(0.11, 8, 6),
    { pos: [0, deck + 0.6, stern + 0.4] }));

  return out;
}

export function buildBoatHull(spec, lod = 0) {
  const s = spec.style;
  if (s.shape === 'clipper') return buildClipper(spec, lod);
  const perSeg = PER_SEG[lod];
  const surface = new BodySurface(boatStations(spec), perSeg);
  const C = (cp) => cp * perSeg;
  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [], lamps: {}, plate: [],
    disc: [], grilleMesh: [], surface, anchors: { exhaust: [] },
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);

  const cuts = [];
  // Cockpit: cut the deck away between the console and the transom.
  const zC0 = s.sternZ + 0.35;
  const zC1 = s.consoleZ + 0.45;
  cuts.push({ kind: 'panel', c0: 0, c1: C(CP.ROOF_EDGE) - 0.5, z0: zC0, z1: zC1 });

  out.paint.push(loftBody(surface, { zSamples: Z_SAMPLES[lod], cuts, uvScale: 1.6 }));

  // Cockpit sole + inner liner so the cut does not look through the hull.
  if (lod < 2) {
    const sole = roundedBox(s.hwMax * 1.5, 0.06, zC1 - zC0, 0.02, 1);
    transform(sole, { pos: [0, s.deckY - 0.34, (zC0 + zC1) / 2] });
    out.trim.push(sole);
    for (const side of [-1, 1]) {
      const wall = roundedBox(0.06, 0.4, zC1 - zC0, 0.02, 1);
      transform(wall, { pos: [side * s.hwMax * 0.76, s.deckY - 0.14, (zC0 + zC1) / 2] });
      out.trim.push(wall);
    }
    const fwd = roundedBox(s.hwMax * 1.5, 0.4, 0.06, 0.02, 1);
    transform(fwd, { pos: [0, s.deckY - 0.14, zC1] });
    out.trim.push(fwd);
  }

  // ---- rubrail along the sheer ------------------------------------------
  const rail = [];
  const n = lod < 1 ? 26 : 12;
  for (let i = 0; i < n; i++) {
    const z = s.bowZ + ((s.sternZ - s.bowZ) * i) / (n - 1);
    const prof = surface.profileAt(z);
    const ci = Math.max(0, Math.min(surface.cols - 1, C(CP.BELT)));
    rail.push(new THREE.Vector3(prof[ci].x + 0.01, prof[ci].y, z));
  }
  const rr = sweep(
    [{ x: 0.02, y: 0.05 }, { x: 0.045, y: 0.0 }, { x: 0.02, y: -0.05 }, { x: -0.04, y: -0.05 }, { x: -0.04, y: 0.05 }],
    rail,
    { closed: true, caps: true, up: new THREE.Vector3(0, 1, 0) }
  );
  out.trim.push(rr, mirrorX(rr.clone()));

  // ---- windshield --------------------------------------------------------
  const wz = s.windshieldZ;
  const wsw = s.hwMax * 1.1;
  const frame = roundedBox(wsw + 0.06, s.windshieldH + 0.06, 0.05, 0.02, 1);
  transform(frame, { pos: [0, s.deckY + s.windshieldH * 0.5 + 0.06, wz], rot: [-0.22, 0, 0] });
  out.chrome.push(frame);
  const glassG = roundedBox(wsw, s.windshieldH, 0.02, 0.015, 1);
  transform(glassG, { pos: [0, s.deckY + s.windshieldH * 0.5 + 0.06, wz], rot: [-0.22, 0, 0] });
  out.glass.push(glassG);

  // ---- outboard ----------------------------------------------------------
  const mz = s.sternZ - 0.24;
  const cowl = roundedBox(0.42, 0.5, 0.46, 0.11, 3);
  transform(cowl, { pos: [0, s.deckY - 0.22, mz] });
  out.trim.push(cowl);
  const leg = roundedBox(0.16, 0.72, 0.2, 0.06, 2);
  transform(leg, { pos: [0, s.deckY - 0.72, mz] });
  out.trim.push(leg);
  const bullet = new THREE.CylinderGeometry(0.075, 0.055, 0.44, 12);
  transform(bullet, { pos: [0, s.deckY - 1.08, mz - 0.02], rot: [Math.PI / 2, 0, 0] });
  out.trim.push(bullet);
  for (let i = 0; i < 3; i++) {
    const blade = roundedBox(0.03, 0.17, 0.09, 0.012, 1);
    const a = (i / 3) * Math.PI * 2;
    transform(blade, { pos: [Math.sin(a) * 0.08, s.deckY - 1.08 + Math.cos(a) * 0.08, mz - 0.24], rot: [0, 0, a] });
    out.chrome.push(blade);
  }
  out.anchors.exhaust.push(new THREE.Vector3(0, s.deckY - 0.8, mz - 0.2));
  out.anchors.prop = new THREE.Vector3(0, s.deckY - 1.08, mz - 0.3);

  // ---- cleats, rails, nav lights ----------------------------------------
  if (lod < 2) {
    for (const zc of [s.bowZ - 0.5, s.consoleZ + 1.2, s.sternZ + 0.5]) {
      for (const side of [-1, 1]) {
        const prof = surface.profileAt(zc);
        const ci = Math.max(0, Math.min(surface.cols - 1, C(CP.ROOF_EDGE)));
        const cl = roundedBox(0.06, 0.05, 0.2, 0.02, 1);
        transform(cl, { pos: [side * prof[ci].x * 0.9, prof[CP.TOP * perSeg].y + 0.05, zc] });
        out.chrome.push(cl);
      }
    }
    const bowRail = tubeBetween(
      new THREE.Vector3(-0.5, s.sheerY + 0.32, s.bowZ - 1.1),
      new THREE.Vector3(0.5, s.sheerY + 0.32, s.bowZ - 1.1),
      0.018, 8
    );
    out.chrome.push(bowRail);
  }
  lamp('policeRed', transform(new THREE.SphereGeometry(0.045, 8, 6), { pos: [-s.hwMax * 0.85, s.sheerY + 0.06, s.bowZ - 1.0] }));
  lamp('drl', transform(new THREE.SphereGeometry(0.045, 8, 6), { pos: [s.hwMax * 0.85, s.sheerY + 0.06, s.bowZ - 1.0] }));
  // The stern light rides a staff off the transom coaming — the raised
  // all-round lamp is right for a workboat, but a sphere 0.5 m over the deck
  // with nothing under it photographs as a floating white dot from any
  // quarter (gallery QA, screenshots/boat.png).
  const sternStaff = tubeBetween(
    new THREE.Vector3(0, s.deckY + 0.02, s.sternZ + 0.2),
    new THREE.Vector3(0, s.deckY + 0.5, s.sternZ + 0.2),
    0.016, 8
  );
  out.chrome.push(sternStaff);
  lamp('reverse', transform(new THREE.SphereGeometry(0.05, 8, 6), { pos: [0, s.deckY + 0.5, s.sternZ + 0.2] }));

  return out;
}

/* ------------------------------------------------------------------ */
/* Hydrodynamics                                                       */
/* ------------------------------------------------------------------ */

const RHO_WATER = 1000;
const G = 9.81;

/** Hull sample points in local space: [x, y, z, volumeShare]. */
export function makeHullSamples(spec) {
  const s = spec.style;
  const hull = spec.hull;
  const pts = [];
  const nz = 6;
  for (let i = 0; i < nz; i++) {
    const t = (i + 0.5) / nz;
    const z = s.bowZ + (s.sternZ - s.bowZ) * t;
    // The forward sections are fine and carry little volume; the after body
    // carries most of it, which is what makes the boat float bow-up.
    const share = 0.25 + 1.75 * t;
    const halfBeam = s.hwMax * Math.min(1, 0.15 + t * 1.9);
    for (const side of [-1, 1]) {
      pts.push({
        x: side * halfBeam * 0.62,
        y: s.keelY + 0.12 + (1 - t) * 0.34,
        z,
        share: share * 0.5,
        t,
      });
    }
  }
  let total = 0;
  for (const p of pts) total += p.share;
  for (const p of pts) p.vol = (hull.buoyancy * p.share) / total;
  return pts;
}

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _t = new THREE.Vector3();

/**
 * One hydrodynamic step. `v` is the Vehicle (see dynamics.js) — this reads its
 * pose and accumulates forces/torques into it exactly like the wheel model does
 * for a car, so the same rigid-body integrator handles both.
 */
export function stepBoat(v, dt, ctx) {
  const spec = v.spec;
  const hull = spec.hull;
  const q = v.quaternion;
  _fwd.set(0, 0, 1).applyQuaternion(q);
  _right.set(1, 0, 0).applyQuaternion(q);
  _up.set(0, 1, 0).applyQuaternion(q);

  const world = v.sys._world();
  let submerged = 0;
  let wetted = 0;
  let waterY = 0;
  let anyWater = false;

  const speed = v.velocity.dot(_fwd);
  const absSpeed = Math.abs(speed);
  const planing = Math.max(0, Math.min(1, (absSpeed - hull.planeSpeed * 0.45) / hull.planeSpeed));

  for (let i = 0; i < v.hullSamples.length; i++) {
    const hp = v.hullSamples[i];
    _p.set(hp.x, hp.y, hp.z).applyQuaternion(q).add(v.position);
    const wy = v.sys.waterHeightAt(_p.x, _p.z, ctx);
    if (wy === null) continue;
    anyWater = true;
    waterY += wy;
    const depth = wy - _p.y;
    if (depth <= 0) continue;
    submerged++;
    const d = Math.min(depth, 0.55);
    // Buoyancy, ramped over the sample's own draft so it is continuous.
    const frac = d / 0.55;
    let fy = RHO_WATER * G * hp.vol * frac;

    // Vertical damping: water resists the hull moving through it.
    _r.set(hp.x, hp.y, hp.z).applyQuaternion(q);
    _vel.copy(v.angularVelocity).cross(_r).add(v.velocity);
    fy -= _vel.y * hull.dragVert * frac * (1 / v.hullSamples.length) * 4;

    // Planing lift: dynamic pressure on the after body lifts it and pulls the
    // bow down, which is the whole character of a fast small boat.
    if (planing > 0.01) {
      fy += hull.planing * absSpeed * absSpeed * planing * hp.t * hp.t * 0.02;
    }

    _f.set(0, fy, 0);
    v.addForceAtLocal(_f, _r);
    wetted += frac;
  }

  /**
   * THE PADDLE WHEEL TURNS WITH THE HULL, not with the engine.
   *
   * A sternwheel is geared to the water: at cruise the bucket tips move at
   * roughly the boat's own speed, so the shaft rate is `speed / radius` with a
   * little slip on top, and at rest it idles rather than stopping dead (a
   * moored packet keeps a bare turn on). Driving it off `rpm` instead would
   * have the wheel racing while the hull sat still, which is exactly the tell
   * that a moving part is decoration.
   *
   * `tailPhase` is the channel because `Vehicle.syncTransforms` routes
   * `axis: 'x'` rotors from it, and a paddle wheel's axle IS transverse. Only a
   * class that emits such a rotor is affected; every other boat leaves it at 0.
   */
  if (spec.style.paddle) {
    const w = spec.style.paddle;
    const rate = Math.max(0.35, (absSpeed / Math.max(0.5, w.r)) * 1.25);
    v.tailPhase = (v.tailPhase + rate * dt) % (Math.PI * 2);
  }

  if (!anyWater) return false;
  v.inWater = submerged > 0;
  v.waterY = waterY / v.hullSamples.length;
  v.wetted = wetted / v.hullSamples.length;
  if (submerged === 0) return true;

  const wet = v.wetted;

  // ---- hull drag ---------------------------------------------------------
  const vLong = v.velocity.dot(_fwd);
  const vLat = v.velocity.dot(_right);
  const dragScale = wet * (1 - 0.55 * planing); // planing halves the wetted area
  _f.copy(_fwd).multiplyScalar(-Math.sign(vLong) * hull.dragLong * vLong * vLong * dragScale);
  _t.copy(_right).multiplyScalar(-Math.sign(vLat) * hull.dragLat * vLat * vLat * dragScale);
  _f.add(_t);
  v.addForce(_f);

  // ---- thrust ------------------------------------------------------------
  const throttle = v.input.throttle - v.input.brake;
  /**
   * `boatSpeed` from DESIGN.md's stat table — 1.25 for Carson, 1.00 for Aidan,
   * 1.05 for Dylan — applied to the PROP, which is the only thing on a boat
   * that a driver could plausibly change. It was dead data everywhere in the
   * project until this pass; see the HERO block in `specs.js`. `v.hero` is the
   * identity for every AI and parked boat, so nothing but the player's changes.
   *
   * Aidan is already 1.00 in the table, so unlike the grip this needs no
   * centring: the boat as tuned and benched IS the all-rounder's boat.
   */
  const thrust = throttle * hull.thrust * (0.35 + 0.65 * wet) * (v.hero?.boat ?? 1);
  const steer = v.steerAngle;
  // The outdrive vectors the thrust: no throttle, no steering. Exactly right.
  _f.copy(_fwd).multiplyScalar(Math.cos(steer) * thrust);
  _t.copy(_right).multiplyScalar(-Math.sin(steer) * thrust);
  _f.add(_t);
  _r.set(0, spec.style.deckY - 0.7, spec.style.sternZ - 0.2).applyQuaternion(q);
  v.addForceAtLocal(_f, _r);
  v.propThrust = thrust;

  // ---- yaw damping + righting -------------------------------------------
  v.addTorque(_t.copy(_up).multiplyScalar(-v.angularVelocity.dot(_up) * hull.yawDamp * wet));

  // Righting moments: the metacentre is above the CoM, so the hull self-levels.
  const rollErr = Math.asin(Math.max(-1, Math.min(1, _right.y)));
  const pitchErr = Math.asin(Math.max(-1, Math.min(1, _fwd.y)));
  v.addTorque(
    _t.copy(_fwd).multiplyScalar(
      -rollErr * hull.rollStiff * wet - v.angularVelocity.dot(_fwd) * hull.rollDamp * wet
    )
  );
  // Planing trims the bow DOWN; at rest the transom squats.
  const trimTarget = -0.16 + 0.30 * planing;
  v.addTorque(
    _t.copy(_right).multiplyScalar(
      (pitchErr - trimTarget) * hull.pitchStiff * wet -
      v.angularVelocity.dot(_right) * hull.pitchDamp * wet
    )
  );

  v.planing = planing;
  return true;
}
