import * as THREE from 'three';
import { Assembly } from '../geometry.js';
import {
  box, blob, latheZ, tubeZ, rodZ, extrude, ring, knurlBand,
  weldBead, tapeWrap, popRivet, scavengedGrip, rodGuard, wireTrigger, dent,
} from './kit.js';

/**
 * FIREARMS — the two REAL guns in an arsenal of scavenged tools.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE NOT IN `light.js` OR `precise.js`
 * ---------------------------------------------------------------------------
 * Every other model in this directory is a tool doing a job it was not built
 * for: a framing nailer, a paint pot, a marine flare pistol, a stove pipe with
 * a motor in it. The read on all fourteen of them is TOOL, and the whole
 * `mats_improvised` palette — safety yellow, zinc, duct tape, hose — exists to
 * sell that.
 *
 * The playtest report is the reason these two exist: *"the guns need to be more
 * like GTA — replace harpoon and flare guns with real guns like pistol and
 * shotgun"*. A real gun cannot be modelled out of the same vocabulary, because
 * the thing a player recognises about a pistol at 2.5 m over the shoulder is
 * exactly the three shapes a tool does not have:
 *
 *   1. a SLIDE — a squared-off mass sitting on a frame, with a straight parting
 *      line between the two and cocking serrations at its rear,
 *   2. a raked GRIP with a magazine floorplate closing the bottom of it, and
 *   3. a TRIGGER GUARD you can see daylight through.
 *
 * So they get their own file and their own restraint: blued steel, polymer,
 * bare wood and brass, no safety yellow, no hose, one wrap of tape at most.
 * They are still Steel City guns — a pawned .38 off the South Side wharves and
 * a duck gun with the choke cut off — but they are guns.
 *
 * ---------------------------------------------------------------------------
 * SILHOUETTE BRIEF (the bar is "tell it apart at 60 px")
 * ---------------------------------------------------------------------------
 *   Pistol   the smallest object in the arsenal. A stepped L: slide over frame,
 *            grip raked 18 deg back, nothing forward of the muzzle at all.
 *   Shotgun  the only weapon in the game with a BUTTSTOCK and a second tube
 *            under the barrel. One long horizontal line broken by the forend.
 *
 * Convention, as everywhere in `models/`: +X right, +Y up, **-Z toward the
 * muzzle**, origin at the web of the shooting hand.
 *
 * ---------------------------------------------------------------------------
 * MOVING PARTS AND THE SEAT RULE
 * ---------------------------------------------------------------------------
 * `models/build.js` seats a sub-assembly at `nodes[<name>Seat].pos`, but
 * `rig.js:_poseParts` then ASSIGNS `position` outright for `mag`, `bolt` and
 * `pump` every frame. A non-zero seat on one of those three is therefore
 * silently discarded on the first frame and the part jumps by the seat vector.
 * So: `slide`/`pump`/`mag` geometry is authored in full weapon space with a
 * zero seat, and only `trigger` (which the rig rotates about its seat, leaving
 * the position alone) is authored relative to one.
 */

/* ========================================================================== */
/*  PISTOL — "DOCK .38"                                                       */
/* ========================================================================== */

/**
 * A compact blued semi-auto that has been in a tackle box for nine years.
 *
 * Dimensions off a real compact 9 mm: 172 mm slide, 25 mm across, a 100 mm
 * grip raked 18 degrees, a 12-round magazine whose floorplate closes the butt,
 * and a bore sitting 32 mm above the web of the hand. That last number is the
 * one that makes it read as a pistol rather than as a small SMG — on a service
 * auto the barrel is barely a thumb's width above your knuckles, and every
 * improvised weapon in this arsenal carries its bore 52-62 mm up.
 *
 * The wear story is the point of difference from a game-store pistol: the
 * bluing has gone silver on the slide's high corners and along the muzzle
 * crown (the curvature mask does that for free — see `models/build.js`), the
 * grip has one wrap of black tape where the left panel screw is missing, and
 * the magazine floorplate has been filed.
 */
export function buildPistol(rng) {
  /* Bore height above the grip web. */
  const bore = 0.032;
  const zMuzzle = -0.128;
  const body = new Assembly('pistol');

  /* ---- frame: the part the hand holds ---------------------------------- */
  /* Dust cover forward of the trigger guard, then the frame rails under the
   * slide, then the backstrap. Modelled as one extruded side profile so the
   * parting line with the slide above it is a single straight edge. */
  /**
   * TWO-TONE, and not for decoration. The frame and the slide share a straight
   * parting line and nothing else, so rendering both in the same blued
   * `imp_grease` merged them into one slab and the pistol read as a machine
   * pistol — the single most important shape on the weapon was invisible. A
   * parkerised frame under a blued slide is also what a pawned service auto
   * actually looks like.
   *
   * The dust cover stops at z = -0.075 rather than running out to the muzzle
   * with the slide: on a real compact the last 50 mm of slide overhangs
   * nothing, and that overhang is the second thing that separates the masses.
   */
  /* The profile runs anticlockwise from the front of the dust cover: over the
   * top under the slide, up into the BEAVERTAIL behind it, down the backstrap,
   * forward along the underside, and up the front wall of the trigger opening.
   * The opening's floor is the `rodGuard` bow below, which is why the underside
   * sits at y = 0.012 through the trigger region instead of at the grip line. */
  const frame = extrude(
    [
      [-0.075, 0.012],   // front of the dust cover, well short of the muzzle
      [-0.075, 0.030],
      [0.046, 0.030],    // top rear of the frame, under the slide
      [0.062, 0.036],    // beavertail, up behind the slide
      [0.068, 0.028],
      [0.052, 0.016],
      [0.050, 0.000],
      [0.030, -0.004],
      [-0.012, 0.008],
      [-0.030, 0.012],
    ],
    0.026,
    { bevel: 0.0016, bevelSegments: 2 }
  );
  body.add(frame, 'imp_steel', { y: bore - 0.030, z: 0, ry: -Math.PI / 2 });
  frame.dispose();

  /* The rail slot the slide runs in: a real gap, both sides, so the two masses
   * read as two parts rather than as one lump. */
  for (const sx of [1, -1]) {
    const slot = box(0.0024, 0.0042, 0.150, 0.0004, 1);
    body.add(slot, 'cavity', { x: sx * 0.0126, y: bore - 0.0025, z: -0.036 });
    slot.dispose();
  }

  /* Serial-number panel and the takedown pin — the two details that say
   * "manufactured", which is the whole contrast with the rest of the set. */
  const panel = box(0.0012, 0.008, 0.030, 0.0002, 1);
  body.add(panel, 'imp_steel', { x: 0.0132, y: bore - 0.020, z: -0.010 });
  panel.dispose();
  const pin = rodZ(0.0026, 0.0026, 0.028, 10, 0.0004);
  body.add(pin, 'imp_chrome', { y: bore - 0.020, z: -0.044, ry: Math.PI / 2 });
  pin.dispose();

  /* ---- slide: the read ------------------------------------------------- */
  const slide = new Assembly('pistol-slide');
  const sl = extrude(
    [
      [-0.128, 0.000],
      [-0.128, 0.021],
      [-0.120, 0.0245],
      [0.036, 0.0245],
      [0.044, 0.021],
      [0.044, 0.000],
    ],
    0.0248,
    { bevel: 0.0018, bevelSegments: 2 }
  );
  dent(sl, rng, { count: 3, radius: 0.016, depth: 0.0006 });
  slide.add(sl, 'imp_grease', { y: bore, z: 0, ry: -Math.PI / 2 });
  sl.dispose();

  /* Cocking serrations, both flanks, at the rear third — the single detail
   * that most says "slide" at viewmodel distance. `geometry.serrations` lays
   * its ribs out along X or Y; these run along Z on a flank that faces X, so
   * they are seven explicit ribs rather than one call. */
  for (const sx of [1, -1]) {
    for (let i = 0; i < 7; i++) {
      const ser = box(0.0018, 0.019, 0.0032, 0.0004, 1);
      slide.add(ser, 'imp_grease', { x: sx * 0.0126, y: bore + 0.001, z: 0.006 + i * 0.0056 });
      ser.dispose();
    }
  }

  /**
   * The bore, the crown and the recoil-spring plug under it.
   *
   * `bore` is the top of the GRIP WEB in this model, not the barrel axis — the
   * slide sits on it and is 24.5 mm deep, so the barrel runs 11 mm up inside
   * that. The first pass put the muzzle on `bore` itself, which is the slide's
   * BOTTOM edge: the crown and the spring plug hung in the air underneath the
   * front of the slide and the flash would have spawned below the gun.
   */
  const axis = bore + 0.011;
  const boreHole = tubeZ(0.0048, 0.0032, 0.030, 12, 0.0003);
  slide.add(boreHole, 'cavity', { y: axis, z: zMuzzle + 0.014 });
  boreHole.dispose();
  const crown = tubeZ(0.0074, 0.0048, 0.0035, 14, 0.0005);
  slide.add(crown, 'imp_chrome', { y: axis, z: zMuzzle + 0.002 });
  crown.dispose();
  const plug = latheZ([[0, 0], [0, 0.0058], [0.004, 0.0062], [0.010, 0.0062], [0.010, 0]], 12);
  slide.add(plug, 'imp_chrome', { y: bore + 0.006, z: zMuzzle + 0.001 });
  plug.dispose();

  /* Ejection port: cut through the right flank, with a bevelled lower lip. */
  const port = box(0.014, 0.014, 0.048, 0.0008, 1);
  slide.add(port, 'cavity', { x: 0.008, y: bore + 0.008, z: -0.024 });
  port.dispose();
  const lip = extrude(
    [[-0.024, -0.007], [0.024, -0.007], [0.024, 0.007], [-0.024, 0.007]],
    0.0016,
    { bevel: 0.0004 }
  );
  slide.add(lip, 'imp_grease', { x: 0.0126, y: bore + 0.008, z: -0.024, ry: Math.PI / 2 });
  lip.dispose();
  /* A chambered round showing through the port — brass is the only warm colour
   * on the whole weapon and it lands exactly where the eye goes. */
  const case_ = latheZ([[0, 0], [0, 0.0048], [0.019, 0.0048], [0.019, 0]], 10);
  slide.add(case_, 'imp_brass', { x: 0.004, y: axis, z: -0.020 });
  case_.dispose();

  /* Sights: a squared blade up front, a notch at the back. Both are the
   * silhouette's only vertical breaks along the top line. */
  const fs = extrude([[-0.0035, 0], [0.0035, 0], [0.0028, 0.0058], [-0.0028, 0.0058]], 0.0032, { bevel: 0.0004 });
  slide.add(fs, 'imp_grease', { y: bore + 0.0245, z: -0.118 });
  fs.dispose();
  const rs = extrude(
    [[-0.010, 0], [0.010, 0], [0.010, 0.0062], [0.002, 0.0062], [0.002, 0.0026],
      [-0.002, 0.0026], [-0.002, 0.0062], [-0.010, 0.0062]],
    0.0038,
    { bevel: 0.0004 }
  );
  slide.add(rs, 'imp_grease', { y: bore + 0.0245, z: 0.030 });
  rs.dispose();
  /* The extractor claw, proud of the slide's right flank. */
  const claw = box(0.0022, 0.0048, 0.016, 0.0004, 1);
  slide.add(claw, 'imp_steel', { x: 0.0128, y: bore + 0.0135, z: 0.002 });
  claw.dispose();

  /* ---- grip: raked back 18 degrees, with the mag closing the butt ------- */
  const RAKE = 0.315; // 18 deg
  const grip = scavengedGrip('tool', { len: 0.100, w: 0.033, d: 0.040 });
  body.add(grip, 'imp_plastic', { y: -0.050, z: 0.030, rx: Math.PI / 2 - RAKE });
  grip.dispose();
  /* Moulded chequering: two panels of shallow ribs, not a texture. */
  for (const sx of [1, -1]) {
    for (let i = 0; i < 6; i++) {
      const r = box(0.0014, 0.0022, 0.036, 0.0003, 1);
      body.add(r, 'imp_plastic', {
        x: sx * 0.0166, y: -0.022 - i * 0.0125, z: 0.020 + i * 0.0042, rx: -RAKE,
      });
      r.dispose();
    }
  }
  /* One wrap of tape where the left grip screw went missing. */
  const wrap = tapeWrap(0.019, 0.030, rng, { band: 0.014, thick: 0.0009, seg: 12, tail: false });
  body.add(wrap, 'imp_tape_black', { y: -0.062, z: 0.034, rx: Math.PI / 2 - RAKE, sx: 1.05, sy: 1.15 });
  wrap.dispose();
  /* The beavertail is part of the FRAME profile above, not a separate piece.
   * Bolted on as its own extrude it read as a flag pinned behind the gun with
   * daylight between it and everything else, which is what any small part
   * authored to float near a silhouette rather than to grow out of one does. */

  /* ---- magazine: it drops on a reload, so it is its own assembly -------- */
  const mag = new Assembly('pistol-mag');
  const magBody = extrude(
    [[-0.0098, 0.0135], [0.0098, 0.0135], [0.0098, -0.0135], [-0.0098, -0.0135]],
    0.092,
    { bevel: 0.0009 }
  );
  mag.add(magBody, 'imp_steel', { y: -0.060, z: 0.028, rx: Math.PI / 2 - RAKE });
  magBody.dispose();
  /* Witness holes down the spine — a real magazine has them and they are the
   * cheapest thing that stops the box reading as a primitive. */
  for (let i = 0; i < 4; i++) {
    const h = tubeZ(0.0018, 0.0011, 0.004, 8, 0.0002);
    mag.add(h, 'cavity', {
      x: 0.0098, y: -0.036 - i * 0.017, z: 0.020 + i * 0.0056, ry: Math.PI / 2,
    });
    h.dispose();
  }
  const plate = box(0.024, 0.0055, 0.030, 0.0008, 1);
  mag.add(plate, 'imp_steel', { y: -0.108, z: 0.046, rx: -RAKE });
  plate.dispose();

  /* ---- trigger, guard, controls ----------------------------------------
   * `kit.rodGuard` bends its bar in the XY plane, i.e. ACROSS the weapon; every
   * improvised model in this directory adds it unrotated, which puts the bow
   * around the width of the gun instead of around the trigger. On a tool that
   * is a detail nobody looks at. On a pistol the trigger guard is one of the
   * three shapes that make it read as a pistol at all, so this one is turned
   * into the ZY plane where a guard belongs. */
  const guard = rodGuard(0.054, 0.032, 0.0030);
  body.add(guard, 'imp_steel', { y: bore - 0.018, z: -0.020, ry: -Math.PI / 2 });
  guard.dispose();
  const trigger = new Assembly('pistol-trigger');
  const trg = wireTrigger({ thick: 0.0055 });
  trigger.add(trg, 'imp_steel', {});
  trg.dispose();

  /* Slide stop and the magazine release, left side, where they belong. */
  const stop = box(0.0028, 0.0062, 0.026, 0.0005, 1);
  body.add(stop, 'imp_steel', { x: -0.0138, y: bore - 0.012, z: -0.004 });
  stop.dispose();
  const rel = latheZ([[0, 0], [0, 0.0052], [0.0035, 0.0052], [0.0035, 0]], 10);
  body.add(rel, 'imp_steel', { x: -0.0134, y: bore - 0.026, z: -0.024, ry: -Math.PI / 2 });
  rel.dispose();
  /* Hammer spur, sitting on the beavertail the frame profile now carries. */
  const spur = extrude([[-0.006, 0], [0.006, 0], [0.005, 0.014], [-0.007, 0.014]], 0.010, { bevel: 0.0006 });
  body.add(spur, 'imp_steel', { y: bore + 0.006, z: 0.052, ry: -Math.PI / 2, rx: 0.22 });
  spur.dispose();
  /* Lanyard loop through the butt — this one lived on a boat. */
  const loop = ring(0.0055, 0.0012, 10, 5);
  body.add(loop, 'imp_chrome', { y: -0.100, z: 0.048, rx: 0.3 });
  loop.dispose();

  return {
    id: 'pistol',
    label: 'Pistol',
    body,
    moving: { trigger, slide, mag },
    nodes: {
      triggerSeat: { pos: [0, bore - 0.020, -0.022], rot: [0, 0, 0] },
      triggerPull: -0.30,
      /* The rig drives `bolt` for the reciprocating mass; on a pistol that mass
       * is the SLIDE, so it answers to the same channel under its own name via
       * `boltTravel` (see the alias in `rig.js:_poseParts`). */
      slideSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      slideTravel: [0, 0, 0.030],
      magSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      magDrop: [0.01, -0.34, 0.11],
      muzzle: [0, bore + 0.011, zMuzzle],
      eject: [0.014, bore + 0.014, -0.020],
      ejectDir: [0.86, 0.48, 0.18],
      /* A two-handed pistol grip: the support hand wraps UNDER the shooting
       * hand rather than reaching down a forend there is none of. */
      gripL: [-0.020, -0.040, 0.022],
      hand: { pos: [0.010, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.10, -0.09, 0.07], rot: [0, 0.25, 0.16] },
    },
    span: 0.19,
  };
}

/* ========================================================================== */
/*  SHOTGUN — "RIVER 12"                                                      */
/* ========================================================================== */

/**
 * A 12-gauge pump with the barrel cut back to the magazine tube.
 *
 * A duck gun off the Allegheny flats, shortened in somebody's shop: 470 mm of
 * barrel, a six-round tube under it, a beech forend worn pale where the hand
 * lives, and a butt pad with the rubber perished off one corner. The receiver
 * is the only flat-sided mass in the arsenal that has a LOADING PORT and a
 * shell lifter in it, and both are modelled, because the pump and the port are
 * the two things a player reads as "shotgun" before the barrel registers.
 *
 * THE FOREND IS A MOVING PART. `rig.js` strokes `pump` once per shot off
 * `def.pump`, and on a pump gun that stroke IS the fire cycle: 0.78 s between
 * rounds with a 78 mm rearward travel that the player watches complete before
 * the next shell chambers. The Paint Cannon already used that channel for its
 * pressure handle; this is the weapon it was written for.
 */
export function buildPumpShotgun(rng) {
  const bore = 0.058;
  const zMuzzle = -0.615;
  /* The magazine tube sits 34 mm under the bore, as it does on a real gun. */
  const tube = bore - 0.034;
  const body = new Assembly('shotgun');

  /* ---- receiver: milled steel, squared, with the port cut in it -------- */
  const recLen = 0.190;
  const rec = extrude(
    [
      [-0.095, -0.030],
      [-0.095, 0.026],
      [-0.080, 0.032],
      [0.070, 0.032],
      [0.095, 0.022],
      [0.095, -0.026],
      [0.060, -0.034],
      [-0.070, -0.034],
    ],
    0.040,
    { bevel: 0.0022, bevelSegments: 2 }
  );
  dent(rec, rng, { count: 4, radius: 0.024, depth: 0.0011 });
  body.add(rec, 'imp_steel', { y: bore, z: -0.030, ry: -Math.PI / 2 });
  rec.dispose();

  /* Loading port, underside, with the shell lifter showing through it. */
  const portCut = box(0.026, 0.016, 0.078, 0.0010, 1);
  body.add(portCut, 'cavity', { y: bore - 0.030, z: -0.020 });
  portCut.dispose();
  const lifter = extrude(
    [[-0.034, 0], [0.034, 0], [0.032, 0.010], [-0.032, 0.010]],
    0.024,
    { bevel: 0.0008 }
  );
  body.add(lifter, 'imp_chrome', { y: bore - 0.032, z: -0.020, ry: Math.PI / 2, rx: 0.12 });
  lifter.dispose();
  /* Two brass shell heads visible in the tube through the port. */
  for (const z of [-0.004, -0.034]) {
    const head = latheZ([[0, 0], [0, 0.0092], [0.004, 0.0092], [0.004, 0.0082], [0.026, 0.0082], [0.026, 0]], 12);
    body.add(head, 'imp_brass', { y: tube + 0.002, z, ry: Math.PI });
    head.dispose();
  }

  /* Ejection port, right flank, and the bolt face inside it. */
  const eport = box(0.014, 0.026, 0.062, 0.0010, 1);
  body.add(eport, 'cavity', { x: 0.016, y: bore + 0.004, z: -0.040 });
  eport.dispose();
  const eLip = extrude(
    [[-0.031, -0.013], [0.031, -0.013], [0.031, 0.013], [-0.031, 0.013]],
    0.0018,
    { bevel: 0.0005 }
  );
  body.add(eLip, 'imp_steel', { x: 0.0202, y: bore + 0.004, z: -0.040, ry: Math.PI / 2 });
  eLip.dispose();

  /* Rollmark panel and the safety cross-bolt behind the trigger. */
  const roll = box(0.0012, 0.014, 0.052, 0.0002, 1);
  body.add(roll, 'imp_grease', { x: -0.0206, y: bore + 0.004, z: -0.030 });
  roll.dispose();
  const safety = rodZ(0.0042, 0.0042, 0.030, 10, 0.0006);
  body.add(safety, 'imp_chrome', { y: bore - 0.026, z: 0.052, ry: Math.PI / 2 });
  safety.dispose();

  /* ---- barrel + magazine tube ------------------------------------------ */
  const brl = latheZ(
    [
      [0.100, 0], [0.100, 0.0158],
      [0.070, 0.0142],
      [-0.400, 0.0132],
      [-0.446, 0.0138],
      [-0.450, 0.0126], [-0.450, 0],
    ],
    20
  );
  body.add(brl, 'imp_grease', { y: bore, z: -0.165 });
  brl.dispose();
  const boreHole = tubeZ(0.0092, 0.0072, 0.070, 14, 0.0004);
  body.add(boreHole, 'cavity', { y: bore, z: zMuzzle + 0.032 });
  boreHole.dispose();
  /* The cut is fresh: bright steel at the crown, and a bead on a stub. */
  const cut = tubeZ(0.0132, 0.0092, 0.0035, 18, 0.0006);
  body.add(cut, 'imp_chrome', { y: bore, z: zMuzzle + 0.002 });
  cut.dispose();
  const beadPost = rodZ(0.0016, 0.0014, 0.007, 6, 0.0002);
  body.add(beadPost, 'imp_steel', { y: bore + 0.017, z: zMuzzle + 0.020, rx: Math.PI / 2 });
  beadPost.dispose();
  const bead = new THREE.SphereGeometry(0.0024, 8, 6);
  body.add(bead, 'imp_brass', { y: bore + 0.021, z: zMuzzle + 0.020 });
  bead.dispose();

  const magTube = latheZ(
    [[0.040, 0], [0.040, 0.0118], [-0.300, 0.0118], [-0.306, 0.0104], [-0.306, 0]],
    16
  );
  body.add(magTube, 'imp_grease', { y: tube, z: -0.180 });
  magTube.dispose();
  /* The end cap: knurled, with the sling swivel hanging off it. */
  const cap = latheZ(
    [[0, 0], [0, 0.0128], [0.006, 0.0134], [0.026, 0.0134], [0.030, 0.0118], [0.030, 0]],
    14
  );
  body.add(cap, 'imp_zinc', { y: tube, z: -0.500, ry: Math.PI });
  cap.dispose();
  const capKnurl = knurlBand(0.0136, 0.020, 16, 0.0004, 3);
  body.add(capKnurl, 'imp_zinc', { y: tube, z: -0.486, ry: Math.PI / 2 });
  capKnurl.dispose();
  const swivel = ring(0.0072, 0.0016, 12, 6);
  body.add(swivel, 'imp_zinc', { y: tube - 0.017, z: -0.492, ry: Math.PI / 2 });
  swivel.dispose();
  /* Barrel-to-tube band, brazed, halfway along. */
  const band = tubeZ(0.0168, 0.0150, 0.010, 16, 0.0004);
  body.add(band, 'imp_steel', { y: bore, z: -0.330 });
  band.dispose();
  const bandWeld = weldBead(0.030, rng, { radius: 0.0016 });
  body.add(bandWeld, 'imp_steel', { y: bore - 0.017, z: -0.330, rz: Math.PI / 2 });
  bandWeld.dispose();

  /* ---- FOREND: the pump. Its own assembly; the rig strokes it. --------- */
  const pump = new Assembly('shotgun-pump');
  const fore = latheZ(
    [
      [0.098, 0], [0.098, 0.0182],
      [0.086, 0.0216],
      [0.020, 0.0246],
      [-0.050, 0.0246],
      [-0.092, 0.0208],
      [-0.100, 0.0180], [-0.100, 0],
    ],
    18
  );
  dent(fore, rng, { count: 5, radius: 0.020, depth: 0.0012 });
  pump.add(fore, 'imp_wood', { y: tube, z: -0.290 });
  fore.dispose();
  /* LENGTHWISE flutes, not rings. The first pass wrapped seven `ring()`s round
   * the forend and they read as a spring coiled onto the gun rather than as
   * anything a hand would hold — a raised band and a cut groove are opposite
   * shapes, and there is no CSG here to cut with. Sixteen shallow ribs running
   * ALONG the forend is the corncob pattern a real pump wears, it is the right
   * shape rather than the inverse of it, and it costs a third of the triangles. */
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const flute = box(0.0042, 0.0016, 0.132, 0.0005, 1);
    flute.rotateZ(a);
    pump.add(flute, 'imp_wood', {
      x: Math.cos(a + Math.PI / 2) * 0.0242,
      y: tube + Math.sin(a + Math.PI / 2) * 0.0242,
      z: -0.292,
    });
    flute.dispose();
  }
  /* The action bars: two flats running back from the forend into the receiver,
   * which is what makes the stroke read as MECHANISM and not as a sliding
   * decoration. */
  for (const sx of [1, -1]) {
    const bar = box(0.0034, 0.0092, 0.150, 0.0005, 1);
    pump.add(bar, 'imp_chrome', { x: sx * 0.0116, y: tube + 0.004, z: -0.148 });
    bar.dispose();
  }
  const collar = tubeZ(0.0186, 0.0166, 0.012, 16, 0.0005);
  pump.add(collar, 'imp_zinc', { y: tube, z: -0.196 });
  collar.dispose();

  /* ---- trigger group --------------------------------------------------- */
  /**
   * NO SEPARATE PISTOL GRIP. The first pass bolted a `scavengedGrip('wood')`
   * under the receiver as well as a buttstock, and it read as exactly what it
   * was: a paddle hanging in space behind the trigger with a rifle stock above
   * it. A field gun has ONE piece of wood back there and the shooting hand
   * holds the WRIST of it — so the wrist is authored to arrive at the origin,
   * which is the web of that hand, and the swell below is the palm's seat.
   *
   * The guard hangs under the receiver, whose underside is at `bore - 0.034`;
   * anything at or above that line is buried inside it, which is where the
   * first version put both the guard and the trigger.
   */
  /**
   * A BENT BAR, NOT A BOX WITH A BLACK RECTANGLE ON IT.
   *
   * The first pass extruded the guard as a solid slab and painted the opening
   * in `cavity`. There is no CSG here, so `cavity` is a very dark MATERIAL and
   * not a hole: what it produced was a box under the receiver with a black
   * panel on its side, which reads as a magazine well. `rodGuard` is a real
   * bent bar with real daylight through it and it costs fewer triangles; it
   * only has to be turned into the ZY plane first (see the pistol).
   */
  const guardY = bore - 0.032;
  const guard = rodGuard(0.076, 0.036, 0.0034);
  body.add(guard, 'imp_zinc', { y: guardY, z: -0.014, ry: -Math.PI / 2 });
  guard.dispose();
  /* The trigger plate the bar is pinned into, flush under the receiver. */
  const plate = box(0.026, 0.008, 0.090, 0.0010, 1);
  body.add(plate, 'imp_zinc', { y: guardY + 0.001, z: -0.014 });
  plate.dispose();
  const trigger = new Assembly('shotgun-trigger');
  const trg = wireTrigger({ thick: 0.0068 });
  trigger.add(trg, 'imp_chrome', {});
  trg.dispose();
  /* The trigger-group pins — two of them, exactly as on the real gun. */
  for (const z of [-0.006, 0.036]) {
    const p = popRivet(0.0032);
    body.add(p, 'imp_zinc', { x: 0.0206, y: bore - 0.026, z, ry: Math.PI / 2 });
    p.dispose();
  }

  /* ---- buttstock: the only one in the game ----------------------------- */
  /* One lathe from wrist to butt, dropped 0.17 rad so the heel falls away from
   * the bore the way a shotgun's does. Local z = -0.034 is the wrist and lands
   * just behind the receiver; z = +0.246 is the butt. */
  const stock = latheZ(
    [
      [-0.034, 0], [-0.034, 0.019],
      [0.010, 0.0195],
      [0.062, 0.026],
      [0.132, 0.038],
      [0.200, 0.050],
      [0.246, 0.055], [0.246, 0],
    ],
    16
  );
  dent(stock, rng, { count: 6, radius: 0.030, depth: 0.0016 });
  body.add(stock, 'imp_wood', { y: 0.020, z: 0.096, rx: 0.17 });
  stock.dispose();
  /* Palm swell at the wrist: the hand's actual seat, and the thing that stops
   * the stock reading as one long cone. */
  const swell = blob(0.038, 0.044, 0.070, 0.010, 3);
  body.add(swell, 'imp_wood', { y: 0.016, z: 0.078, rx: 0.17 });
  swell.dispose();
  /* Comb: the cheek rides here. It has to sit ON the stock's own top line —
   * authored at a flat height it floated above the drop as a separate plank. */
  const comb = blob(0.034, 0.026, 0.132, 0.009, 3);
  body.add(comb, 'imp_wood', { y: 0.030, z: 0.192, rx: 0.17 });
  comb.dispose();
  /* Rubber recoil pad, perished at one corner. */
  const pad = latheZ(
    [[0, 0], [0, 0.055], [0.006, 0.057], [0.018, 0.054], [0.020, 0]],
    16
  );
  body.add(pad, 'imp_plastic', { y: -0.038, z: 0.338, rx: 0.17, sx: 0.86 });
  pad.dispose();
  const padLine = ring(0.051, 0.0018, 16, 6);
  body.add(padLine, 'imp_zinc', { y: -0.036, z: 0.334, rz: Math.PI / 2, sx: 0.88 });
  padLine.dispose();
  /* Sling swivel through the toe of the stock. */
  const rearSwivel = ring(0.0072, 0.0016, 12, 6);
  body.add(rearSwivel, 'imp_zinc', { y: -0.062, z: 0.262, ry: Math.PI / 2 });
  rearSwivel.dispose();
  /* Two pop rivets where somebody repaired a split through the wrist. */
  for (const z of [0.118, 0.142]) {
    const r = popRivet(0.0026);
    body.add(r, 'imp_zinc', { x: 0.019, y: 0.006, z, ry: Math.PI / 2 });
    r.dispose();
  }
  const wristTape = tapeWrap(0.026, 0.040, rng, { band: 0.016, thick: 0.0011, seg: 12, tail: true });
  body.add(wristTape, 'imp_tape_black', { y: 0.008, z: 0.126, rx: Math.PI / 2 + 0.17, sx: 1.1 });
  wristTape.dispose();

  /* Shell loops on the left of the stock — five spare 12-gauge, brass up. */
  for (let i = 0; i < 5; i++) {
    const y = 0.006 - i * 0.0034;
    const z = 0.166 + i * 0.021;
    const sh = latheZ([[0, 0], [0, 0.0088], [0.008, 0.0088], [0.008, 0]], 10);
    body.add(sh, 'imp_brass', { x: -0.030, y, z, ry: Math.PI / 2 });
    sh.dispose();
    const hull = tubeZ(0.0086, 0.0074, 0.040, 10, 0.0003);
    body.add(hull, 'imp_paint_red', { x: -0.030, y, z, ry: Math.PI / 2 });
    hull.dispose();
  }
  const loopStrap = box(0.0022, 0.030, 0.118, 0.0004, 1);
  body.add(loopStrap, 'imp_leather', { x: -0.024, y: -0.002, z: 0.208, rx: 0.17 });
  loopStrap.dispose();

  return {
    id: 'shotgun',
    label: 'Shotgun',
    body,
    moving: { trigger, pump },
    nodes: {
      triggerSeat: { pos: [0, bore - 0.048, -0.014], rot: [0, 0, 0] },
      triggerPull: -0.30,
      /* Zero seat on purpose — `rig.js` assigns `pump.position` outright. */
      pumpSeat: { pos: [0, 0, 0], rot: [0, 0, 0] },
      /* 78 mm of rearward travel. A real 12-gauge action bar runs about 90 mm;
       * 78 keeps the forend clear of the trigger guard at full stroke. */
      pumpTravel: [0, 0, 0.078],
      muzzle: [0, bore, zMuzzle],
      eject: [0.024, bore + 0.008, -0.040],
      ejectDir: [0.92, 0.36, 0.14],
      gripL: [0, tube - 0.006, -0.290],
      hand: { pos: [0.012, -0.004, 0.006], rot: [0, 0, 0] },
      holster: { pos: [-0.16, -0.02, 0.12], rot: [0, 0.32, 0.30] },
    },
    span: 1.02,
  };
}
