/**
 * THE BULWARK — a tracked main battle tank: hull geometry, the articulated
 * turret, and the shell it fires.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE DRIVING IS THE CAR MODEL AND ONLY THE TURRET IS NEW
 * ────────────────────────────────────────────────────────────────────────────
 * A tank hull is a rigid body on sprung contacts, which is exactly what
 * `dynamics.js` already integrates. `kind: 'tank'` therefore takes the WHEEL
 * path of `Vehicle.fixedStep` — the four hardpoints stand in for the road-wheel
 * stations — and reads tracked through TUNING, not through a second simulator:
 * 45 t of mass, a top speed geared to ~14 m/s, track-pad grip far past any
 * tyre's, near-critical damping and monster anti-roll so the hull stays flat,
 * and a crumple coefficient so low that collisions cost it almost nothing
 * (`DamageModel.impact` prices a hit as `impulse / mass`, so the mass is
 * armour twice over). `milprobe.mjs` measures all of that on the emitted
 * motion; `drivetest.mjs` deliberately excludes `kind: 'tank'` from its car
 * sweep the same way it excludes the tram — a machine whose whole point is to
 * fail "accelerates like a car" assertions does not belong in them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TURRET IS KINEMATIC STATE, STEPPED EVEN WHILE THE HULL SLEEPS
 * ────────────────────────────────────────────────────────────────────────────
 * `turretYaw` / `gunPitch` live on the Vehicle and slew toward `aimTurret()`'s
 * point at the bounded rates in `spec.turret`. The step runs from
 * `VehicleSystem.fixedUpdate` OUTSIDE the physics-sleep gate, deliberately: an
 * AI emplacement is a PARKED tank — asleep by the solver's definition within
 * 1.2 s of standing still — and a turret that only slews while the hull is
 * integrating would freeze mid-traverse the moment the hull settled. Slewing
 * is not a force; it does not need the integrator awake.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * `fireShell` SPEAKS THE ROCKET'S EVENT VOCABULARY — NO PARALLEL DAMAGE PATH
 * ────────────────────────────────────────────────────────────────────────────
 * The Scrap Rocket detonates by emitting the canonical `explosion`
 * `{ position, radius, damage }` (`weapons/ballistics.js _detonate`), and
 * `physics`, `vehicles`, `peds`, `fx`, `police` and `ui` all already listen.
 * The shell does exactly the same: a ballistic point integrated at 120 Hz,
 * raycast against the static world each step, proximity-tested against the
 * live fleet, and ONE `explosion` event at the impact point. Damage to a
 * vehicle then flows through `_explosionDamage` -> `damage()` like every other
 * blast in the game — this file never touches a health number itself. The
 * muzzle emits the canonical `weapon:fire` `{ weapon, origin, dir, seed }`,
 * which is the event `fx` draws muzzle flashes from and `police`/`peds` price
 * and panic off — a tank shot is heard, seen and booked like any other shot.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NOBODY IN IT, NOBODY SHOOTING — THE CREW GATE
 * ────────────────────────────────────────────────────────────────────────────
 * REPORTED, from play: "exiting a tank the tank starts shooting at you right
 * away, which is not realistic (all vehicles should only operate with someone
 * in them)". It was true, and the reason is worth writing down because it is
 * the shape of every occupancy bug: the encounter director decided an
 * emplacement was LIVE because the tank was ITS tank and was not the car the
 * player is currently sitting in (`airbase.js`, `v === playerVeh`), which is a
 * statement about OWNERSHIP, not about whether anybody is aboard. Step out and
 * the second half of the test flips while the first half does not, so the gun
 * you were just firing turns round and fires at you.
 *
 * The invariant belongs HERE, at the firing site, not only in whichever
 * director happens to pull the trigger — a rule enforced by one caller is a
 * rule the next caller does not have. `fireShell` therefore refuses outright
 * unless `crewOf(v)` finds a LIVE operator aboard:
 *
 *   - `v.driver`      the seat: the player, a `Ped`, an AI marker
 *   - `v.occupants`   anyone else riding it
 *   - `v.aiCrew`      a garrison gun crew — an emplacement that is manned but
 *                     has nobody in the DRIVER's seat. Whoever seats them owns
 *                     the field (`game/airbase.js` does); it is read here and
 *                     written nowhere in `src/vehicles/`.
 *
 * A record whose `alive` or `active` has gone false does not count, so an
 * emplacement falls silent when its crew is killed rather than when some
 * separate bookkeeping notices. `v.debugNoCrewGate = true` restores the old
 * behaviour on a live build — the negative control `milprobe` runs.
 *
 * `v.afterburner` has a sibling note in `plane.js`; the visual hooks published
 * here are `v.turretYaw`, `v.gunPitch`, `v.gunCool` (seconds of reload left)
 * and the `model.turrets` pivots that `syncTransforms` drives.
 *
 * Gate: `src/vehicles/milprobe.mjs` (see its header for the numbers).
 */

import * as THREE from 'three';
import { roundedBox, transform, mergeAll, tubeBetween, VEH_DETAIL } from './geom.js';

const GRAVITY = 9.81;

/* ====================================================================== */
/* Geometry                                                               */
/* ====================================================================== */

/** Per-LOD segment budgets. */
const SEG = [
  { ring: 12, wheel: 12 },
  { ring: 8, wheel: 8 },
  { ring: 6, wheel: 6 },
  { ring: 4, wheel: 5 },
];

/**
 * The hull. Same material-group contract as `buildPlaneBody`, plus a `turret`
 * entry `build.js` turns into two articulated pivots (traverse and elevation)
 * so the gun can track a target independently of the hull.
 *
 * Reads from sixty metres in this order: the TRACKS (a dark band low down the
 * whole length), the sloped GLACIS, the flat skirted hull, and the TURRET with
 * its long gun. Everything is sized off `spec.style` so the silhouette checks
 * in `milprobe.mjs` can run negative controls by mutating the style block.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * "TOO BOXY AND FLOATING HEADLIGHTS" — REPORTED FROM PLAY, AND BOTH WERE REAL
 * ────────────────────────────────────────────────────────────────────────────
 * THE LAMPS. They were `SphereGeometry` placed at a hand-written
 * `(hull.w * 0.36, headlight.y, glacis.z1 - 0.12)`. The glacis is a SLOPE, so
 * the armour at that z is at `hull.y1 - drop * (z - hull.z1)/(glacis.z1 -
 * hull.z1)` = 0.66 m — and the lamp sat at 1.28 m. MEASURED: two white spheres
 * hanging 62 cm in front of the nose plate with nothing under them, which is
 * exactly what the report says and what `mkt_tanks` photographed. A lamp is
 * never positioned in hull space on a sloped plate; it is positioned ON THE
 * PLATE, by `glacisY(z)`, inside a housing that is itself paint, behind a
 * brush guard. Fixing the mount is the fix — moving the sphere down would have
 * left an unattached sphere.
 *
 * THE BOX. Four separate things were flat:
 *   - the upper hull's SIDES were vertical (`hullTaper` now leans them in),
 *   - the turret was a slab with a token top taper and no CHEEKS (its front
 *     third now narrows, which is the wedge that makes armour read as armour),
 *   - there were no FENDERS, so the tracks met the hull at a bare corner and
 *     the road wheels stood in open air,
 *   - and there was no stowage at all: no bins, no spare track, no tow cable,
 *     no hatch lids. A tank with nothing strapped to it is a shed whatever its
 *     section is.
 */
export function buildTankBody(spec, lod = 0) {
  const s = spec.style;
  const seg = SEG[Math.min(SEG.length - 1, lod)];
  const out = {
    paint: [], trim: [], chrome: [], cavity: [], glass: [],
    lamps: {}, plate: [], disc: [], doors: [], rotors: [], anchors: {},
  };
  const lamp = (k, g) => (out.lamps[k] = out.lamps[k] ?? []).push(g);

  // Everything this wave added is gated on `near`, which is the LOD test AND
  // the `?owNoVehDetail=1` A/B hatch (see geom.js). The hull, glacis, skirts,
  // tracks and turret shell are NOT — they are the machine.
  const near = lod < 2 && VEH_DETAIL;
  const hull = s.hull;      // { y0, y1, z0, z1, w }  upper hull box
  const skirt = s.skirt;    // { y0, y1, x0, x1, z0, z1 }
  const track = s.track;    // { y0, y1, x0, x1, wheelR, wheels }

  /* ---- upper hull ----------------------------------------------------- */
  const hullH = hull.y1 - hull.y0;
  const hullL = hull.z1 - hull.z0;
  const deck = roundedBox(hull.w, hullH, hullL, 0.06, 2);
  {
    /**
     * THE UPPER SIDE PLATES LEAN IN. A vertical flank is a container; armour
     * over the sponson is angled so a round arrives off the perpendicular, and
     * that lean is most of what separates "tank" from "box" in a silhouette.
     * `hullTaper` is the fraction of half-width lost between the sponson line
     * and the deck — authorable so `milprobe` can drive it from the style block.
     */
    const taper = s.hullTaper ?? 0.13;
    const p = deck.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = Math.max(0, Math.min(1, p.getY(i) / hullH + 0.5));
      p.setX(i, p.getX(i) * (1 - taper * t));
    }
    deck.computeVertexNormals();
  }
  transform(deck, { pos: [0, (hull.y0 + hull.y1) * 0.5, (hull.z0 + hull.z1) * 0.5] });
  out.paint.push(deck);

  /* ---- sloped glacis --------------------------------------------------- */
  // The nose plate: a slab leaned back from the low bow lip up to the deck
  // line. The slope IS the feature — milprobe measures the emitted angle.
  const g = s.glacis;     // { z1 (bow tip), drop }
  const glacisRun = g.z1 - hull.z1;
  const glacisAng = Math.atan2(g.drop, glacisRun);
  /**
   * The armour surface height at a given z on the nose plate. EVERYTHING
   * mounted on the glacis goes through this — lights, spare track, tow eyes —
   * because a hand-written y on a sloped plate is how the headlights ended up
   * floating 62 cm in front of the tank.
   */
  const glacisY = (z) => hull.y1 - g.drop * Math.max(0, Math.min(1, (z - hull.z1) / glacisRun));
  {
    const len = Math.hypot(glacisRun, g.drop);
    const plate = roundedBox(hull.w * 0.98, 0.16, len + 0.2, 0.04, 2);
    transform(plate, {
      pos: [0, hull.y1 - g.drop * 0.5 - 0.06, hull.z1 + glacisRun * 0.5],
      rot: [glacisAng, 0, 0],
    });
    out.paint.push(plate);
    // The bow lip closes the wedge underneath.
    const lip = roundedBox(hull.w * 0.96, hull.y1 - g.drop - hull.y0 + 0.2, 0.5, 0.05, 1);
    transform(lip, { pos: [0, (hull.y0 + hull.y1 - g.drop) * 0.5, g.z1 - 0.28] });
    out.paint.push(lip);
    // Rear plate, leaned the other way.
    const tail = roundedBox(hull.w * 0.96, 0.14, hullH + 0.3, 0.04, 1);
    transform(tail, { pos: [0, (hull.y0 + hull.y1) * 0.5, hull.z0 - 0.1], rot: [Math.PI * 0.5 - 0.35, 0, 0] });
    out.paint.push(tail);
  }

  /* ---- track skirts and fenders ---------------------------------------- */
  const skX = (skirt.x0 + skirt.x1) * 0.5;
  const skZ = (skirt.z0 + skirt.z1) * 0.5;
  const skLen = skirt.z1 - skirt.z0;
  for (const side of [-1, 1]) {
    const sk = roundedBox(skirt.x1 - skirt.x0, skirt.y1 - skirt.y0, skLen, 0.04, 1);
    transform(sk, { pos: [side * skX, (skirt.y0 + skirt.y1) * 0.5, skZ] });
    out.paint.push(sk);
    /**
     * SEGMENTED SIDE SKIRTS. The skirt is the single largest flat surface on the
     * machine — 7.4 m by 0.6 m of unbroken plate down each flank — and a flat
     * plate that size is most of what survives of the "too boxy" read once the
     * fenders and the stowage are on. Real skirts are BOLTED-ON PLATES in
     * sections so a mine can take one off without taking the rest; six per side,
     * standing 2 cm proud with a gap between them, puts five vertical shadow
     * lines down the flank and costs almost nothing.
     */
    if (near) {
      const nS = 6;
      const segW = (skLen - 0.2) / nS;
      for (let i = 0; i < nS; i++) {
        const z = skirt.z0 + 0.1 + segW * (i + 0.5);
        const plate = roundedBox(0.05, skirt.y1 - skirt.y0 - 0.10, segW - 0.07, 0.015, 1);
        transform(plate, { pos: [side * (skirt.x1 + 0.01), (skirt.y0 + skirt.y1) * 0.5, z] });
        out.paint.push(plate);
      }
    }

    /**
     * THE FENDER. A horizontal shelf over the track, overhanging the skirt
     * outboard, running the length of the running gear — the single detail that
     * turns a slab flank plus a band of wheels into a tracked vehicle, because
     * it puts a hard shadow line the whole length of the machine and gives the
     * stowage somewhere to sit. Front and rear flaps hang off its ends.
     */
    const fw = skirt.x1 - skirt.x0 + 0.16;
    const fy = skirt.y1 + 0.03;
    const fender = roundedBox(fw, 0.06, skLen + 0.1, 0.02, 1);
    transform(fender, { pos: [side * (skX + 0.06), fy, skZ] });
    out.paint.push(fender);
    // Fender edge rail, so the shelf has a lip rather than a knife edge.
    const railF = roundedBox(0.05, 0.09, skLen + 0.1, 0.018, 1);
    transform(railF, { pos: [side * (skX + 0.06 + fw * 0.5), fy + 0.03, skZ] });
    out.paint.push(railF);
    if (near) {
      for (const [z, ang] of [[skirt.z1 + 0.02, -0.34], [skirt.z0 - 0.02, 0.34]]) {
        const flap = roundedBox(fw * 0.92, 0.34, 0.05, 0.015, 1);
        transform(flap, { pos: [side * (skX + 0.06), fy - 0.16, z], rot: [ang, 0, 0] });
        out.trim.push(flap);
      }
    }
  }

  /* ---- tracks and road wheels ------------------------------------------ */
  // The dark running gear under the skirts: a full-length track band per side,
  // and a row of road wheels visible under the skirt's lower edge.
  for (const side of [-1, 1]) {
    const tx = side * (track.x0 + track.x1) * 0.5;
    const tw = track.x1 - track.x0;
    const band = roundedBox(tw, track.y1 - track.y0, skirt.z1 - skirt.z0 - 0.2, 0.08, 1);
    transform(band, { pos: [tx, (track.y0 + track.y1) * 0.5, (skirt.z0 + skirt.z1) * 0.5] });
    out.trim.push(band);
    if (lod < 3) {
      const n = Math.max(3, track.wheels | 0);
      const z0 = skirt.z0 + 0.55;
      const z1 = skirt.z1 - 0.55;
      /**
       * A ROAD WHEEL IS RUBBER WITH A HUB IN IT, NOT A DISC.
       *
       * It used to be one `trim` cylinder at the full rolling radius, and under
       * a low sun that photographed as a row of pale hexagons pasted on the
       * flank — six of the brightest shapes on the whole machine, and half of
       * why it read as a toy (see `mkt_tanks` before this). The tyre is now the
       * full-radius solid in `cavity`, which is the near-black material, and the
       * `trim` cylinder is a HUB at 45% of the radius standing proud of it. Same
       * two primitives per wheel, and `milprobe`'s "road wheels visible below
       * the skirt line" still reads the hubs.
       */
      for (let i = 0; i < n; i++) {
        const z = z0 + ((z1 - z0) * i) / (n - 1);
        const y = track.y0 + track.wheelR;
        if (lod < 2) {
          const tyre = new THREE.CylinderGeometry(track.wheelR, track.wheelR, tw + 0.04, seg.wheel);
          transform(tyre, { pos: [tx, y, z], rot: [0, 0, Math.PI * 0.5] });
          out.cavity.push(tyre);
          const hub = new THREE.CylinderGeometry(track.wheelR * 0.46, track.wheelR * 0.46, tw + 0.10, seg.wheel);
          transform(hub, { pos: [tx, y, z], rot: [0, 0, Math.PI * 0.5] });
          out.trim.push(hub);
        } else {
          const wheel = new THREE.CylinderGeometry(track.wheelR, track.wheelR, tw + 0.06, seg.wheel);
          transform(wheel, { pos: [tx, y, z], rot: [0, 0, Math.PI * 0.5] });
          out.trim.push(wheel);
        }
      }
      // Drive sprocket aft and idler forward, both proud of the wheel line —
      // the ends of a track run are never the same disc as its middle.
      if (near) {
        for (const [z, r] of [[skirt.z0 + 0.30, track.wheelR * 0.86], [skirt.z1 - 0.30, track.wheelR * 0.80]]) {
          const hubW = new THREE.CylinderGeometry(r, r, tw + 0.10, seg.wheel);
          transform(hubW, { pos: [tx, track.y0 + track.wheelR, z], rot: [0, 0, Math.PI * 0.5] });
          out.trim.push(hubW);
        }
        // Return rollers along the top run, under the fender.
        for (let i = 0; i < 3; i++) {
          const z = skirt.z0 + 1.1 + ((skLen - 2.2) * i) / 2;
          const rr = new THREE.CylinderGeometry(0.13, 0.13, tw * 0.5, 8);
          transform(rr, { pos: [tx, skirt.y1 - 0.12, z], rot: [0, 0, Math.PI * 0.5] });
          out.trim.push(rr);
        }
      }
    }
  }

  /* ---- deck furniture -------------------------------------------------- */
  if (lod < 2) {
    // Engine deck grilles aft, a driver's hatch forward.
    const grille = roundedBox(hull.w * 0.6, 0.05, 1.1, 0.02, 1);
    transform(grille, { pos: [0, hull.y1 + 0.02, hull.z0 + 0.85] });
    out.cavity.push(grille);
    // Louvre bars across the grille, so the engine deck is a LOUVRE and not a
    // dark rectangle painted on the roof.
    for (let i = 0; i < 5; i++) {
      const bar = roundedBox(hull.w * 0.58, 0.045, 0.10, 0.015, 1);
      transform(bar, { pos: [0, hull.y1 + 0.05, hull.z0 + 0.85 - 0.44 + i * 0.22], rot: [0.5, 0, 0] });
      out.trim.push(bar);
    }
    const hatch = new THREE.CylinderGeometry(0.3, 0.32, 0.08, seg.ring);
    transform(hatch, { pos: [0.62, hull.y1 + 0.04, hull.z1 - 0.55] });
    out.paint.push(hatch);
    // Its raised rim and grab handle — a hatch with no ring is a painted circle.
    const rim = new THREE.CylinderGeometry(0.35, 0.35, 0.05, seg.ring, 1, true);
    transform(rim, { pos: [0.62, hull.y1 + 0.02, hull.z1 - 0.55] });
    out.trim.push(rim);
    out.chrome.push(tubeBetween(
      new THREE.Vector3(0.46, hull.y1 + 0.12, hull.z1 - 0.55),
      new THREE.Vector3(0.78, hull.y1 + 0.12, hull.z1 - 0.55), 0.018, 6
    ));
    // Driver's periscopes, on the deck lip ahead of the hatch.
    for (const dx of [0.46, 0.78]) {
      const scope = roundedBox(0.11, 0.07, 0.09, 0.02, 1);
      transform(scope, { pos: [dx, hull.y1 + 0.06, hull.z1 - 0.20] });
      out.cavity.push(scope);
    }
  }

  /* ---- stowage --------------------------------------------------------- */
  /**
   * Bins on the fenders, spare track links on the glacis, a tow cable down each
   * flank. Nothing here is structural and all of it is the reason a real hull
   * never reads as a smooth box: it breaks the two longest straight lines on
   * the machine (the fender shelf and the nose plate) at irregular intervals.
   */
  if (near) {
    const fy = skirt.y1 + 0.06;
    for (const side of [-1, 1]) {
      for (const [z, len, h] of [[skirt.z0 + 1.05, 1.20, 0.34], [skirt.z0 + 2.55, 0.85, 0.28]]) {
        const bin = roundedBox(skirt.x1 - skirt.x0 + 0.04, h, len, 0.03, 1);
        transform(bin, { pos: [side * (skX + 0.04), fy + h * 0.5, z] });
        out.paint.push(bin);
        const lid = roundedBox(skirt.x1 - skirt.x0 + 0.10, 0.04, len + 0.05, 0.015, 1);
        transform(lid, { pos: [side * (skX + 0.04), fy + h + 0.02, z] });
        out.trim.push(lid);
      }
      // Tow cable: a slack run along the upper flank, in two straight legs.
      const cy = hull.y1 - 0.30;
      out.trim.push(tubeBetween(
        new THREE.Vector3(side * (hull.w * 0.5 - 0.10), cy + 0.10, hull.z0 + 0.9),
        new THREE.Vector3(side * (hull.w * 0.5 - 0.10), cy - 0.06, hull.z0 + 2.6), 0.045, 6
      ));
      out.trim.push(tubeBetween(
        new THREE.Vector3(side * (hull.w * 0.5 - 0.10), cy - 0.06, hull.z0 + 2.6),
        new THREE.Vector3(side * (hull.w * 0.5 - 0.10), cy + 0.08, hull.z1 - 0.3), 0.045, 6
      ));
    }
    // Spare track links bolted flat to the glacis, in two short rows either
    // side of the centreline. `glacisY` puts them ON the plate.
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        const z = hull.z1 + 0.26 + i * 0.18;
        const link = roundedBox(0.34, 0.05, 0.16, 0.02, 1);
        transform(link, {
          pos: [side * 0.62, glacisY(z) + 0.06, z],
          rot: [glacisAng, 0, 0],
        });
        out.trim.push(link);
      }
    }
  }

  /* ---- lamps, IN CLUSTERS THAT ARE BOLTED TO SOMETHING ------------------ */
  /**
   * See the header note. The housing is paint, the lens sits in its face, and a
   * brush guard stands over it — which is what an armoured vehicle's light
   * actually is and, incidentally, the only way a 9 cm lamp survives being
   * looked at from eight metres.
   */
  const hl = s.headlight;
  /**
   * ON THE FENDER, at its forward end — which is where a real tracked vehicle
   * carries its lights, and which also keeps them clear of the CENTRE STRIP
   * `milprobe`'s glacis detector reads. That gate takes the top line of
   * |x| <= 0.4 * hull width precisely so flanking hardware cannot mask the nose
   * plate; MEASURED with a 26 cm housing on the glacis at x = 0.87 m, the
   * detector reported the bow at 1.13 m instead of the armour's 0.43 and went
   * red. A gate you satisfy by NOT building the detail has stopped measuring
   * the detail — so the detail moved to where it belongs instead.
   */
  const lampY = skirt.y1 + 0.06;
  const lampZ = skirt.z1 - 0.30;
  for (const side of [-1, 1]) {
    const hx = side * (skX + 0.06);
    const box = roundedBox(hl.w * 3.2, hl.w * 2.8, hl.w * 2.4, hl.w * 0.5, 2);
    transform(box, { pos: [hx, lampY + hl.w * 1.4, lampZ] });
    out.paint.push(box);
    // The stalk that carries it off the fender shelf.
    const stalk = roundedBox(hl.w * 1.2, hl.w * 1.4, hl.w * 1.2, hl.w * 0.3, 1);
    transform(stalk, { pos: [hx, lampY + hl.w * 0.4, lampZ] });
    out.trim.push(stalk);
    lamp('head', transform(new THREE.SphereGeometry(hl.w, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.55),
      { pos: [hx, lampY + hl.w * 1.4, lampZ + hl.w * 1.25], rot: [Math.PI * 0.5, 0, 0] }));
    if (near) {
      // Brush guard: two uprights and three bars across the face.
      const y0 = lampY + hl.w * 0.1;
      const y1 = lampY + hl.w * 2.9;
      const zf = lampZ + hl.w * 1.6;
      for (const dx of [-hl.w * 1.5, hl.w * 1.5]) {
        out.trim.push(tubeBetween(
          new THREE.Vector3(hx + dx, y0, lampZ),
          new THREE.Vector3(hx + dx, y1, zf), 0.018, 5
        ));
      }
      for (let i = 0; i < 3; i++) {
        const y = y0 + ((y1 - y0) * (i + 0.5)) / 3;
        out.trim.push(tubeBetween(
          new THREE.Vector3(hx - hl.w * 1.5, y, zf - hl.w * 0.35),
          new THREE.Vector3(hx + hl.w * 1.5, y, zf - hl.w * 0.35), 0.014, 5
        ));
      }
    }
    // Convoy/tail cluster, recessed into a housing on the rear plate.
    const tw2 = s.taillight.w;
    const tz = hull.z0 - 0.10;
    const shell = roundedBox(tw2 * 4, tw2 * 3.4, tw2 * 2.0, tw2 * 0.6, 1);
    transform(shell, { pos: [side * hull.w * 0.38, s.taillight.y, tz - tw2] });
    out.cavity.push(shell);
    lamp('brake', transform(new THREE.SphereGeometry(tw2, 8, 6),
      { pos: [side * hull.w * 0.38, s.taillight.y, tz - tw2 * 2.1] }));
  }

  /* ---- the turret — its own articulated node ---------------------------- */
  // Geometry is built about the TRAVERSE PIVOT (s.turret.x/y/z), so `build.js`
  // can hang it off a rotating group and share the geometry across instances.
  {
    const t = s.turret;   // { y, z, w, h, l, bustle }
    const parts = [];
    const dark = [];
    /**
     * The shell: a low frustum with SLOPED CHEEKS. Two deformations, and the
     * second one is what the critique was about.
     *
     * TOP TAPER — every face leans in going up, so the turret roof is narrower
     * than its ring. That was already here (at 0.42 over the upper half only,
     * i.e. a vertical lower half); it now runs the whole height, from a shade
     * proud at the ring to `cheekTop` in at the roof.
     *
     * CHEEK WEDGE — the FRONT third narrows in plan. A turret whose sides are
     * parallel from mantlet to bustle is a shoebox with a pipe in it; the wedge
     * is the shape that reads as a turret from any angle, and it is the single
     * biggest contributor to the "too boxy" report on this machine.
     */
    const shell = roundedBox(t.w, t.h, t.l, 0.10, 2);
    {
      const cheekTop = t.cheekTop ?? 0.30;    // half-width lost at the roof
      const cheekNose = t.cheekNose ?? 0.26;  // half-width lost at the muzzle end
      const p = shell.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const u = Math.max(0, Math.min(1, p.getY(i) / t.h + 0.5)); // 0 ring, 1 roof
        const zn = Math.max(0, p.getZ(i) / (t.l * 0.5));           // 0 aft, 1 nose
        const f = (1.03 - cheekTop * u) * (1 - Math.pow(zn, 1.5) * cheekNose);
        p.setX(i, p.getX(i) * f);
        p.setZ(i, p.getZ(i) * (1 - Math.max(0, p.getY(i) / t.h) * 0.16));
      }
      shell.computeVertexNormals();
    }
    transform(shell, { pos: [0, t.h * 0.5, -t.l * 0.12] });
    parts.push(shell);
    // Bustle rack aft.
    const bustle = roundedBox(t.w * 0.8, t.h * 0.5, t.bustle, 0.05, 1);
    transform(bustle, { pos: [0, t.h * 0.35, -t.l * 0.62 - t.bustle * 0.3] });
    parts.push(bustle);
    // Commander's cupola.
    if (lod < 3) {
      const cup = new THREE.CylinderGeometry(0.26, 0.3, 0.16, seg.ring);
      transform(cup, { pos: [-t.w * 0.22, t.h + 0.07, -t.l * 0.18] });
      parts.push(cup);
    }
    // Mantlet at the trunnion.
    const g = s.gun;      // { y, z, len, r } — pivot relative to the turret pivot
    const mant = roundedBox(0.6, 0.5, 0.5, 0.08, 2);
    transform(mant, { pos: [0, g.y, g.z + 0.1] });
    parts.push(mant);

    if (near) {
      // Cupola lid, hinged open a crack, and its vision blocks.
      const lid = new THREE.CylinderGeometry(0.27, 0.27, 0.05, seg.ring);
      transform(lid, { pos: [-t.w * 0.22 - 0.06, t.h + 0.19, -t.l * 0.18 - 0.10], rot: [0.32, 0, 0] });
      parts.push(lid);
      for (let i = 0; i < 5; i++) {
        const a = -0.9 + (i / 4) * 1.8;
        const blk = roundedBox(0.10, 0.06, 0.05, 0.015, 1);
        transform(blk, {
          pos: [-t.w * 0.22 + Math.sin(a) * 0.30, t.h + 0.09, -t.l * 0.18 + Math.cos(a) * 0.30],
          rot: [0, a, 0],
        });
        dark.push(blk);
      }
      // Loader's hatch on the other shoulder.
      const lh = new THREE.CylinderGeometry(0.23, 0.25, 0.07, seg.ring);
      transform(lh, { pos: [t.w * 0.24, t.h + 0.03, -t.l * 0.24] });
      parts.push(lh);
      /**
       * SMOKE DISCHARGERS on the cheeks — four tubes a side, angled out and up.
       * Cheap, instantly military, and they sit exactly where the eye lands when
       * the wedge turns the corner.
       */
      for (const side of [-1, 1]) {
        for (let i = 0; i < 4; i++) {
          const tube = new THREE.CylinderGeometry(0.055, 0.055, 0.22, 8, 1, true);
          transform(tube, {
            pos: [side * (t.w * 0.40 - i * 0.015), t.h * 0.72, t.l * 0.16 - i * 0.15],
            rot: [-0.5, side * 0.5, 0],
          });
          dark.push(tube);
        }
      }
      // Coaxial machine gun, in the mantlet beside the main gun.
      const coax = new THREE.CylinderGeometry(0.035, 0.035, 0.7, 8, 1, true);
      transform(coax, { pos: [0.22, g.y - 0.06, g.z + 0.42], rot: [Math.PI * 0.5, 0, 0] });
      dark.push(coax);
      // Bustle stowage: a basket of bars with a rolled tarpaulin in it.
      const bz = -t.l * 0.62 - t.bustle * 0.3;
      for (const side of [-1, 1]) {
        dark.push(tubeBetween(
          new THREE.Vector3(side * t.w * 0.40, t.h * 0.58, bz + t.bustle * 0.5),
          new THREE.Vector3(side * t.w * 0.40, t.h * 0.58, bz - t.bustle * 0.6), 0.022, 5
        ));
      }
      dark.push(tubeBetween(
        new THREE.Vector3(-t.w * 0.40, t.h * 0.58, bz - t.bustle * 0.6),
        new THREE.Vector3(t.w * 0.40, t.h * 0.58, bz - t.bustle * 0.6), 0.022, 5
      ));
      const roll = new THREE.CylinderGeometry(0.16, 0.16, t.w * 0.66, 8);
      transform(roll, { pos: [0, t.h * 0.60, bz - t.bustle * 0.2], rot: [0, 0, Math.PI * 0.5] });
      dark.push(roll);
      // Lifting eyes on the roof — small, and the thing a turret is never without.
      for (const side of [-1, 1]) {
        dark.push(tubeBetween(
          new THREE.Vector3(side * t.w * 0.30, t.h + 0.01, t.l * 0.10),
          new THREE.Vector3(side * t.w * 0.30, t.h + 0.11, t.l * 0.02), 0.018, 5
        ));
      }
    }

    // The gun: a long tube from the trunnion, built about ITS OWN pivot so it
    // can elevate. Thermal sleeve step and muzzle collar so it reads as a gun.
    const gunParts = [];
    const barrel = new THREE.CylinderGeometry(g.r, g.r * 1.15, g.len, seg.ring);
    transform(barrel, { pos: [0, 0, g.len * 0.5], rot: [Math.PI * 0.5, 0, 0] });
    gunParts.push(barrel);
    const sleeve = new THREE.CylinderGeometry(g.r * 1.5, g.r * 1.6, g.len * 0.3, seg.ring);
    transform(sleeve, { pos: [0, 0, g.len * 0.3], rot: [Math.PI * 0.5, 0, 0] });
    gunParts.push(sleeve);
    const muzzle = new THREE.CylinderGeometry(g.r * 1.5, g.r * 1.5, 0.34, seg.ring);
    transform(muzzle, { pos: [0, 0, g.len - 0.2], rot: [Math.PI * 0.5, 0, 0] });
    gunParts.push(muzzle);

    /**
     * `trim` is a SECOND mesh inside the traverse ring (see `build.js`), not a
     * fourth material group on the hull: the turret rotates, so anything welded
     * to it has to live inside the pivot, and the vision blocks, dischargers,
     * coax and bustle basket cannot be drawn in body paint without becoming
     * olive-drab pipes. One extra draw call, on one class, at LOD < 2.
     */
    out.turret = {
      pos: [t.x ?? 0, t.y, t.z],
      geo: mergeAll(parts),
      trim: dark.length ? mergeAll(dark) : null,
      gun: { pos: [0, g.y, g.z], geo: mergeAll(gunParts) },
    };
  }

  out.anchors = {};
  out.surface = null;
  return out;
}

/* ====================================================================== */
/* Turret state and slew                                                  */
/* ====================================================================== */

const _q = new THREE.Quaternion();
const _qy = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const _X = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _mp = new THREE.Vector3();
const _md = new THREE.Vector3();

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Preallocate the turret's per-vehicle state. Called from the constructor. */
export function initTurret(v) {
  v.turretYaw = 0;
  v.gunPitch = 0;
  v.gunCool = 0;
  v.turretAim = new THREE.Vector3();
  v.turretAimActive = false;
}

/**
 * Command the turret at a WORLD point. The barrel does not snap — it slews at
 * `spec.turret.yawRate` / `pitchRate` in `stepTurret`, so an emplacement
 * tracks a runner visibly and a fast crossing target can outpace it.
 */
export function aimTurret(v, worldPoint) {
  if (!v?.spec?.turret || !worldPoint) return false;
  v.turretAim.set(
    worldPoint.x ?? worldPoint[0] ?? 0,
    worldPoint.y ?? worldPoint[1] ?? 0,
    worldPoint.z ?? worldPoint[2] ?? 0
  );
  v.turretAimActive = true;
  return true;
}

/**
 * One slew step. Runs from `VehicleSystem.fixedUpdate` for every vehicle with
 * a `spec.turret`, OUTSIDE the sleep gate (see the header). Also ticks the
 * reload clock, so `fireShell` needs no timer of its own.
 */
export function stepTurret(v, dt) {
  const T = v.spec.turret;
  if (!T) return;
  if (v.gunCool > 0) v.gunCool = Math.max(0, v.gunCool - dt);
  if (!v.turretAimActive || v.destroyed) return;

  // The aim point in body frame, about the traverse pivot.
  const st = v.spec.style;
  _v.set(st.turret.x ?? 0, st.turret.y + (st.gun?.y ?? 0.3) - v.spec.comY, st.turret.z)
    .applyQuaternion(v.quaternion).add(v.position);
  _d.copy(v.turretAim).sub(_v).applyQuaternion(_q.copy(v.quaternion).invert());

  const wantYaw = Math.atan2(_d.x, _d.z);
  const horiz = Math.hypot(_d.x, _d.z);
  /**
   * SUPERELEVATION — the fire-control half of "the explosion lands at the aim
   * point". A 105 m/s shell aimed straight down the line of sight falls
   * 4.9 t^2 below it and landed a MEASURED 21 m short at 65 m. Real fire
   * control solves the lob; the flat-fire solution is
   * `0.5 * asin(g d / v^2)` above the direct line, which brings the same
   * shot inside a couple of metres (milprobe gates it on the emitted event).
   */
  const S = T.shell;
  const dist = Math.hypot(horiz, _d.y);
  const sup = S ? 0.5 * Math.asin(clamp((GRAVITY * dist) / (S.speed * S.speed), -1, 1)) : 0;
  const wantPitch = clamp(
    Math.atan2(_d.y, Math.max(horiz, 0.5)) + sup, T.pitchMin, T.pitchMax);

  const dy = wrapPi(wantYaw - v.turretYaw);
  const stepY = T.yawRate * dt;
  v.turretYaw = wrapPi(v.turretYaw + clamp(dy, -stepY, stepY));
  const dp = wantPitch - v.gunPitch;
  const stepP = T.pitchRate * dt;
  v.gunPitch = clamp(v.gunPitch + clamp(dp, -stepP, stepP), T.pitchMin, T.pitchMax);
}

/**
 * The EMITTED muzzle pose — position and direction in world space, composed
 * from the same pivot chain `syncTransforms` drives, so the shell leaves the
 * end of the drawn barrel, not a bookkeeping point.
 */
export function muzzleWorld(v, outPos, outDir) {
  const st = v.spec.style;
  const g = st.gun;
  _qy.setFromAxisAngle(_Y, v.turretYaw ?? 0);
  _qp.setFromAxisAngle(_X, -(v.gunPitch ?? 0));
  // Gun-frame forward, into body frame.
  outDir.set(0, 0, 1).applyQuaternion(_qp).applyQuaternion(_qy).applyQuaternion(v.quaternion);
  // Muzzle: turret pivot + yawed (gun pivot + pitched barrel tip).
  outPos.set(0, 0, g.len).applyQuaternion(_qp)
    .add(_v.set(0, g.y, g.z))
    .applyQuaternion(_qy)
    .add(_d.set(st.turret.x ?? 0, st.turret.y - v.spec.comY, st.turret.z))
    .applyQuaternion(v.quaternion)
    .add(v.position);
  return outPos;
}

/* ====================================================================== */
/* The shell                                                              */
/* ====================================================================== */

/**
 * IS ANYBODY ABOARD? Returns the live operator, or null.
 *
 * Duck-typed on purpose: the seat holds a `Ped`, the player system, a pooled
 * AI marker or a garrison crew record depending on who put them there, and
 * none of those share a base class. `alive`/`active` are honoured WHEN PRESENT
 * — an actor that carries neither (the player system) is aboard by virtue of
 * being in the seat, and one that carries them and has set them false is not.
 *
 * See the crew-gate note in this file's header for why this lives at the
 * firing site rather than in the encounter that pulls the trigger.
 */
export function crewOf(v) {
  if (!v) return null;
  const aboard = (a) => !!a && a.alive !== false && a.active !== false;
  if (aboard(v.driver)) return v.driver;
  const occ = v.occupants;
  if (Array.isArray(occ)) {
    for (let i = 0; i < occ.length; i++) if (aboard(occ[i])) return occ[i];
  }
  if (aboard(v.aiCrew)) return v.aiCrew;
  return null;
}

/**
 * Fire the main gun. `sys` is the VehicleSystem (or a probe's stub carrying
 * `ctx.events`, `physics` and `vehicles`). Returns the live shell, or null
 * while reloading / wrecked / UNCREWED. `target` is an optional convenience
 * that also commands the turret — but the shell leaves along the barrel's
 * CURRENT emitted direction, never along a snap to the target.
 */
export function fireShell(sys, v, target = null) {
  const T = v?.spec?.turret;
  if (!T || v.destroyed) return null;
  // THE CREW GATE, above the aim command as well as the trigger: an abandoned
  // machine neither shoots nor slews itself onto you. See the header.
  if (!v.debugNoCrewGate && !crewOf(v)) return null;
  if (target) aimTurret(v, target);
  if (v.gunCool > 0) return null;
  v.gunCool = T.reload;

  muzzleWorld(v, _mp, _md);

  // The canonical muzzle event: fx draws the flash, audio plays the report,
  // police price the shot, peds panic. Allocation is fine at 0.25 Hz.
  sys?.ctx?.events?.emit('weapon:fire', {
    weapon: 'tankgun',
    origin: _mp.clone(),
    dir: _md.clone(),
    seed: ((sys?.rng?.u32?.() ?? (Math.abs(_mp.x * 7919 + _mp.z * 104729) | 0)) >>> 0),
    flashScale: T.recoil?.flash ?? 2.4,
    light: 2,
  });

  // Recoil: the hull takes the opposite impulse, plus a nose-up pitch kick
  // about the gun's right axis. Visible, felt, and it wakes the solver.
  const R = T.recoil ?? {};
  v.wake?.();
  v.velocity.addScaledVector(_md, -(R.kick ?? 0.8));
  _v.set(1, 0, 0).applyQuaternion(v.quaternion);
  v.angularVelocity.addScaledVector(_v, -(R.pitch ?? 0.4));

  const S = T.shell;
  const shell = {
    pos: _mp.clone().addScaledVector(_md, 0.2),
    prev: _mp.clone(),
    vel: _md.clone().multiplyScalar(S.speed),
    owner: v,
    life: S.life ?? 6,
    radius: S.radius,
    damage: S.damage,
  };
  (sys._shells ?? (sys._shells = [])).push(shell);
  return shell;
}

const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();
/** Reused payload, the same shape `ballistics.js` emits. */
const _boom = { position: new THREE.Vector3(), radius: 6, damage: 100, source: 'tankshell' };

/**
 * Integrate every live shell one fixed step and detonate the ones that land.
 * World geometry via `physics.raycast` (which falls back to the analytic
 * ground city-wide), vehicles via a segment-vs-bounding-sphere test — the
 * fleet is not in the static BVH.
 */
export function stepShells(sys, dt) {
  const shells = sys._shells;
  if (!shells || shells.length === 0) return;
  const phys = sys.physics;
  for (let i = shells.length - 1; i >= 0; i--) {
    const s = shells[i];
    s.prev.copy(s.pos);
    s.vel.y -= GRAVITY * dt;
    s.pos.addScaledVector(s.vel, dt);
    s.life -= dt;

    _seg.copy(s.pos).sub(s.prev);
    const len = _seg.length();
    let hit = null;
    if (len > 1e-6 && phys?.raycast) {
      _seg.multiplyScalar(1 / len);
      const h = phys.raycast(s.prev, _seg, len, phys.MASK?.WORLD ?? 0);
      if (h?.hit) hit = h.point;
    }
    if (!hit) {
      // The fleet. Never the tank that fired — a muzzle 5.3 m out on the
      // barrel still overlaps a 4 m hull's bounding sphere at fire time.
      const list = sys.vehicles;
      if (list) {
        for (let j = 0; j < list.length; j++) {
          const t = list[j];
          if (t === s.owner || t.destroyed || t._staged) continue;
          _rel.copy(t.position).sub(s.prev);
          const along = clamp(_rel.dot(_seg), 0, len);
          const d2 = _rel.addScaledVector(_seg, -along).lengthSq();
          const r = (t.boundingRadius ?? 2) * 0.85;
          if (d2 < r * r) {
            hit = _v.copy(s.prev).addScaledVector(_seg, along);
            break;
          }
        }
      }
    }
    if (!hit && s.life > 0) continue;

    // THE detonation — the same event, the same payload shape, the same
    // listeners as the Scrap Rocket. Nothing else applies damage.
    _boom.position.copy(hit ?? s.pos);
    _boom.radius = s.radius;
    _boom.damage = s.damage;
    sys?.ctx?.events?.emit('explosion', _boom);
    shells.splice(i, 1);
  }
}
