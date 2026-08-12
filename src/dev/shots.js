import * as THREE from 'three';

/**
 * Named camera setups the screenshot harness can request. Each shot freezes
 * input, poses the camera, and optionally forces gameplay state so critics
 * always review the same framing across iterations.
 *
 * A shot is `{ pos:[x,y,z], look:[x,y,z], fov?, time?, apply?(engine) }`.
 * `time` is hour-of-day 0..24 handed to the sky system.
 */
/**
 * Stage the police helicopter and frame its searchlight, standing `stand`
 * metres off the beam's ground spot and aiming `aimUp` of the way up the shaft.
 *
 * FRAMED RELATIVE TO THE BEAM, never from authored world coordinates. The first
 * cut of these shots used fixed `pos`/`look` pairs and produced two identical
 * frames containing no helicopter and no beam at all — a shot called
 * `searchlight` that photographed an ordinary night street. The second cut put
 * the lens hard against a brick wall filling 40% of the frame, which is the same
 * mistake that once had a critic panel reviewing a stucco slab instead of the
 * city. Standing off the beam's own ground spot cannot do either, wherever the
 * staged aircraft happens to end up.
 *
 * Deterministic: `debugStage('air')` places the aircraft as a pure function of
 * the camera pose that preceded it, and every offset here derives from that.
 */
function frameBeam(e, { stand, aimUp }) {
  const police = e.ctx.peek('police');
  if (!police?.debugStage) return;
  police.debugStage('air');
  const h = police.heli;
  const cam = e.ctx.camera;
  if (!h?.position) return;

  // Move the aim off the camera so the shaft is not pointed straight down the
  // lens. The beam re-reads the wanted meter's last-known position every frame,
  // so the aim has to move THERE — setting `heli._target` alone is overwritten
  // on the next update.
  const ax = h.position.x + 30;
  const az = h.position.z + 24;
  const ay = police.groundAt?.(ax, az, h.position.y) ?? 0;
  police.meter?.known?.set?.(ax, ay, az);
  h._target?.set?.(ax, ay, az);

  // Perpendicular to the beam's ground projection = a true side-on view.
  const bx = h.position.x - ax, bz = h.position.z - az;
  const bl = Math.hypot(bx, bz) || 1;
  const cx = ax + (-bz / bl) * stand;
  const cz = az + (bx / bl) * stand;
  const cy = (police.groundAt?.(cx, cz, h.position.y) ?? 0) + 6;
  cam.position.set(cx, cy, cz);
  cam.lookAt(ax, ay + (h.position.y - ay) * aimUp, az);
  e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
  holdCamera(e, cam.position, { x: ax, y: ay + (h.position.y - ay) * aimUp, z: az });
}

/**
 * Frame the PLAYER, from wherever the player actually is.
 *
 * `character` used to be `pos:[2.4,1.6,3.0] look:[0,1.15,0]` — absolute
 * coordinates pointed at the world origin. The player is not at the world
 * origin, so the shot named "over-the-shoulder on a DeCarlo brother" was a
 * photograph of a blank concrete wall, and it stayed that way through an entire
 * adversarial review: four separate critics spent their pass judging it, one
 * noting only that a frame labelled `character` contained a wall.
 *
 * A shot that names its subject must derive its camera FROM that subject. This
 * is the third time absolute coordinates have produced a shot of the wrong
 * thing in this file (see also `frameBeam`), so it now has a helper.
 *
 * @param {number} dist   metres back from the actor
 * @param {number} height eye height of the camera
 * @param {number} side   metres to the actor's right (over-the-shoulder offset)
 * @param {number} aimY   height on the actor to aim at
 */
/*
 * Suppress the harness's OWN side effects before the shutter.
 *
 * An adversarial pass over 24 shots reported both of these, and was right about
 * both:
 *
 *   1. An "ENTERING GOLDEN TRIANGLE" banner was burned into 24 of 24 frames,
 *      while the minimap underneath read Lawrenceville, Steel Row, Mt.
 *      Washington, South Side, Hazelwood, The Point and North Shore. Every shot
 *      teleports the player, every teleport fires the zone toast, and the toast
 *      then sits there for its whole dwell — so every frame in the set carried a
 *      caption contradicting its own minimap.
 *   2. The first-person weapon viewmodel was composited into aerial and drone
 *      frames, which have no first-person subject at all.
 *
 * Neither is a renderer defect. Both are the capture rig photographing itself,
 * and together they polluted an entire four-lens review.
 *
 * MUST be called on BOTH apply paths. The `onRoad` branch returns early, and
 * something installed only after it silently misses `street`, `hero`, `night`,
 * `detail`, `rain` and `character` — a mistake already made once in this file
 * with `clearTraffic`.
 */
/**
 * Remember the camera a shot asked for, and put it back at the shutter.
 *
 * Setting `cam.position` inside `apply` is not enough. Several of these helpers
 * teleport the player so gameplay systems stay coherent, and the PLAYER RIG then
 * re-derives the camera from the player on the frames that follow — so the pose
 * you authored is quietly overridden before the shutter. MEASURED on the vehicle
 * beauty shot: `dist: 9.0` authored, 6.0 m at the shutter, with the framing
 * flipping from a rear three-quarter to a front one on small changes in where
 * the subject ended up.
 *
 * So record it and re-assert it in `shotChrome`, which runs at the shutter via
 * `__PRESHUTTER__`. Same lesson as freezing the sim and re-pinning the sky
 * clock: the last write before the photograph is the one that counts.
 */
function holdCamera(e, pos, target) {
  e.__shotCam = { px: pos.x, py: pos.y, pz: pos.z, tx: target.x, ty: target.y, tz: target.z };
}

function shotChrome(engine, shot) {
  // Anything the `pursuit` staging seated goes back to the crowd the moment a
  // different shot is applied — see `releaseStagedDrivers`. This runs on both
  // apply paths and at the shutter, so it cannot be missed the way
  // `clearTraffic` once was.
  if (shot !== SHOTS.pursuit && !shot.pursuitShot) releaseStagedDrivers(engine);
  /**
   * Everything the marketing set STAGES BY HAND goes back the moment a shot
   * that does not own it is applied — the aircraft parked in mid-air, the
   * brothers' cars stood on the body-shop forecourt, and the airbase's own
   * assault switch. Same contract and the same reason as
   * `releaseStagedDrivers` directly above: shots run back to back in one
   * browser session (`tools/shotset.mjs`, a review sweep), and the twin left
   * hanging over the Monongahela at 234 m would be photographed by every later
   * shot whose lens happens to point at the confluence.
   *
   * Both are keyed off flags the SHOT declares rather than off shot identity,
   * because there are now several shots on each side of the question.
   */
  if (!shot.stagesKinematic) releaseStagedKinematic(engine);
  if (!shot.stagesCars) releaseStagedCars(engine);
  if (!shot.airbase) airbaseInert(engine, false);
  engine.ctx.peek('ui')?.hideZoneToast?.();
  for (const n of document.querySelectorAll('.ow-zone, [class*="zone"]')) {
    n.style.display = 'none';
  }
  // On by default — first-person shots need it — off where the shot declares it
  // has no first-person subject.
  engine.viewScene.visible = shot.viewmodel !== false;

  /*
   * The THIRD-PERSON weapon is not parented to the character.
   *
   * `player._shotHide` hides the actor with `character.setOpacity(0)`, which
   * sets `character.root.visible = false`. But the held weapon lives under a
   * separate scene node, `weapons-thirdperson`, hung directly off the Scene —
   * so hiding the character leaves the weapon floating unsupported exactly
   * where his hands were. MEASURED in the `incline` shot: `shotHide true`,
   * `charRootVisible false`, and a fully lit pipe still in frame.
   *
   * This is not only a harness problem. The same fade runs in gameplay whenever
   * the camera is forced inside the player (tight alleys, a wall behind him),
   * so the weapon stays solid while its owner dissolves. Flagged to `weapons`;
   * hidden here so review frames are not judged on it in the meantime.
   */
  const tp = engine.scene.getObjectByName('weapons-thirdperson');
  if (tp) tp.visible = !(engine.ctx.peek('player')?._shotHide);

  /**
   * `noCrowd` — NOBODY WANDERS ONTO A RESTRICTED FLIGHTLINE.
   *
   * `peds` streams an ambient crowd around the player and every shot teleports
   * the player to its camera, so both Ridgeline frames drew a civilian in a
   * purple overcoat standing on the apron. Despawning them (the shot's
   * `shutter` hook) is the honest half of the fix and is NOT sufficient:
   * MEASURED at the shutter with zero active peds, two `ped_body` skinned
   * meshes were still parented into the live `peds` group 4.8 m from the lens.
   * `_despawn` -> `_releaseBody` -> `detachBody` returns the body to a free
   * pool and nothing hides it, so a body outlives its ped until something
   * happens to reuse it. Flagged; hidden here so a marketing frame is not
   * judged on it. Restored for every shot that does not ask for it.
   */
  const crowd = engine.scene.getObjectByName('peds');
  if (crowd) crowd.visible = shot.noCrowd !== true;

  // `hud: false` — marketing frames only. A screenshot in a README is a
  // photograph of a world, not of an interface. Review shots keep the HUD,
  // because a critic should be judging it too.
  engine.ctx.peek('ui')?.setHudVisible?.(shot.hud !== false);

  // Re-assert a held camera pose. See `holdCamera`.
  const c = engine.__shotCam;
  if (c) {
    engine.camera.position.set(c.px, c.py, c.pz);
    engine.camera.lookAt(c.tx, c.ty, c.tz);
  }

  /**
   * `actorFrame` — COMPOSE ON THE PLAYER AT THE SHUTTER, and only then.
   *
   * A shot whose subject is the player cannot compose from `apply`: the
   * `player:` block is honoured on `shot:applied`, which is emitted AFTER
   * `apply` returns, and the capsule then resolves against the world for the
   * whole settle. `character` did compose from `apply` — and photographed the
   * pre-staging position. MEASURED at the shutter with the staged block in
   * place: the subject's head projected to NDC x 2.85, i.e. nearly three screen
   * half-widths off the right edge, because `groundHeight` at the mark put him
   * 2.2 m under a raised plaza and the capsule then squirted 4.7 m sideways
   * over ~800 frames while resolving.
   *
   * Composing here reads where he ENDED UP. Same rule as `holdCamera` and the
   * re-pinned sky clock two files over: the last write before the photograph is
   * the one that counts.
   */
  if (shot.actorFrame) frameActor(engine, shot.actorFrame);

  /**
   * `hudFrame` — REPUBLISH A LIVE READOUT AT THE SHUTTER, same rule again.
   *
   * For a shot whose HUD is read off a system rather than authored (`pursuit`
   * takes its stars and its blips from `police`), `apply` is hundreds of frames
   * before the photograph and the tableau lives through all of them. Declared
   * as a function on the shot so the shot owns what it publishes; called here
   * so the last write before the shutter is the one in the picture.
   */
  if (shot.hudFrame) {
    try { shot.hudFrame(engine); } catch { /* a shot must never take the boot down */ }
  }

  /**
   * `shutter` — THE LAST WRITE BEFORE THE PHOTOGRAPH, for anything else.
   *
   * `hudFrame` is the same idea for a HUD readout and `clearTraffic` for cars;
   * this is the general form, and it exists because the airbase frames need
   * it. `peds` streams an ambient crowd around the player continuously, and
   * every shot teleports the player to its camera — so the first draft of
   * `mkt_tanks` photographed a woman in a purple overcoat standing on the
   * apron of a military airbase, ten metres in front of a Bulwark's main gun.
   * Clearing at APPLY time cannot fix that: the shot then settles for ~1300
   * frames and the crowd streams straight back in. Cleared here, the sim is
   * frozen two calls later and nothing can repopulate before the shutter.
   */
  if (shot.shutter) {
    try { shot.shutter(engine); } catch { /* a shot must never take the boot down */ }
  }
}

/**
 * ---------------------------------------------------------------------------
 * STAGING THE HUD ITSELF — the difference between MISSING and BROKEN
 * ---------------------------------------------------------------------------
 *
 * A critic reviewing `shots/wave5-final` reported the driving frames as having
 * no vehicle cluster, no GPS route and no objective panel, and the pursuit
 * frame as having no wanted stars and no cop blips. Every one of those widgets
 * WORKS — `gpsprobe`, `aircraftprobe` and `wardprobe` gate them — and the
 * frames were still right: the review set was photographing a HUD no player
 * ever sees.
 *
 * `driving` and `cockpit` staged a car with `vehicles.debugPose` and left the
 * player standing on the pavement beside it. `player.getHudState().inVehicle`
 * is therefore false, so `_pullState` hides the cluster, there is no route
 * because nobody set a destination, and the contextual prompt fires because he
 * is within reach of a door — which is why both frames carry `TAKE THE
 * ALLEGHENY 4DR` stamped across the middle of the picture. The critic scored an
 * on-foot HUD as a driving HUD and was told it was broken.
 *
 * `pursuit` had a second version of the same fault. `police.debugStage`
 * genuinely sets the meter to three stars and binds four cruisers, but
 * `__APPLY_SHOT__` pins `ui.debugState('clean')` on the way in, and `_pullState`
 * skips the police, game and player reads entirely while a debug scene is
 * pinned (`if (pol && !this._debug)`). So the live three stars and the four
 * real cruiser blips were computed, published, and then dropped on the floor.
 *
 * TWO FIXES, because they are two different problems:
 *
 *   driving / cockpit   `ui.debugState('combat')` — the authored fiction, the
 *                       path `hud` already uses and the only way a capture ever
 *                       photographs the cluster, since no producer is running
 *                       behind it. It sets `inVehicle`, which also turns the
 *                       centre-screen `TAKE THE ...` into the docked EXIT chip
 *                       a seated player actually gets. The objective is then
 *                       re-authored to a DRIVING one and a waypoint is dropped
 *                       on the far end of the scene's own route, so the ring's
 *                       route line has a destination on it rather than running
 *                       off the disc to nothing.
 *
 *   pursuit             the opposite — publish what `police` ACTUALLY has.
 *                       `setWanted` and `setBlips` are public, and both survive
 *                       a pinned debug scene (`_collectBlips` returns early
 *                       while one is set, and the `clean` scene declares no
 *                       blips of its own to re-arm over the top). So the stars
 *                       in the frame are the meter's, and every blip on the
 *                       ring is a cruiser that is in the photograph.
 *
 * `cockpit` IS A CAR, not an aircraft — first person from the driver's seat of
 * a staged muscle car, on a downtown street, which is what its `doc` promises
 * and what the frame shows. It gets the cluster's DRIVING face (speed, gear,
 * tach) accordingly. The flying face — altitude, climb, rotor — has no frame in
 * this set and cannot honestly be given one here: painting an altimeter over a
 * car dashboard would be the same class of defect this whole note is about.
 * A flying shot is worth adding; it is a shot, not a caption.
 */
/**
 * A destination the ROAD GRAPH can actually route to, `ahead` metres down the
 * street the lens is already pointed at.
 *
 * The first cut of this dropped the pin on the last leg of `debugState`'s own
 * synthetic route — a random 7-leg wander — and MEASURED the result: `game`'s
 * GPS solved it, `world.routeTo` came back with nothing (the wander ends in a
 * river, a rail cut or off the graph entirely), and `_gpsTick`'s failure branch
 * called `ui.setRoute(null)`. The frame lost the line it was staged to show.
 * Snapping to a lane centre is the same `nearestEdge` / `laneCenter` pair the
 * `onRoad` framing above uses, and for the same reason: a coordinate this file
 * made up is a coordinate the city has never heard of.
 */
function roadMark(e, ahead) {
  const cam = e.ctx.camera;
  cam.updateMatrixWorld();
  const m = cam.matrixWorld.elements;
  const fl = Math.hypot(m[8], m[10]) || 1;
  const x = cam.position.x - (m[8] / fl) * ahead;
  const z = cam.position.z - (m[10] / fl) * ahead;
  const roads = e.ctx.peek('world')?.roads;
  const hit = roads?.nearestEdge?.(x, z);
  if (hit?.edge != null && roads.laneCenter) {
    const a = new THREE.Vector3();
    roads.laneCenter(hit.edge.id ?? hit.edge, hit.lane ?? 0, 0.5, a);
    return { x: a.x, z: a.z };
  }
  return { x, z };
}

function driveHud(e, objective, ahead = 460) {
  const ui = e.ctx.peek('ui');
  if (!ui?.debugState) return null;
  // `combat` is the one scene that authors the vehicle cluster.
  const out = ui.debugState('combat');
  ui.setObjective(objective);
  /**
   * THE ROUTE IS SOLVED, NOT DRAWN FROM MEMORY.
   *
   * `ui:waypoint` is the published door — it is the event the pause map fires
   * when the player drops a pin — and `game._gpsTick` answers it by routing
   * over the real graph and calling `ui.setRoute` with the result. That is a
   * strictly better frame than the scene's authored polyline, and it is also
   * the only one that survives: `_gpsTick` is NOT gated on `ui._debug`, so a
   * settle long enough for its 1 Hz poll to come round clears any route the
   * debug scene put up. Give it a destination and it draws one instead.
   */
  const mark = roadMark(e, ahead);
  e.events.emit('ui:waypoint', mark);
  ui.setWaypoint(mark);
  return out;
}

/**
 * Re-assert the driving fiction AT THE SHUTTER — third instance of the rule.
 *
 * `debugState` sets `state.inVehicle`, and `player:state` takes it straight
 * back: that event carries `inVehicle: false` (the staged man is beside the
 * car, not in it) and `ui` consumes it on a listener that no debug pin gates.
 * It fires on any change to his stance, gait or grounded flag, so a settle of
 * hundreds of frames always contains at least one. MEASURED after apply on the
 * `driving` shot: cluster up, `inVehicle` false — which draws the on-foot
 * player glyph on the ring instead of the car, and offers the on-foot
 * contextual prompt across the middle of the picture instead of the docked
 * EXIT chip a seated player gets.
 *
 * Same fix as the viewmodel flag and the held camera pose: the last write
 * before the photograph is the one that counts.
 */
function driveFrame(e) {
  const s = e.ctx.peek('ui')?.state;
  if (!s) return;
  s.inVehicle = true;
  s.speed = 24;
}

/** Put `police`'s real meter and its real cruisers on the ring. */
function policeHud(e) {
  const ui = e.ctx.peek('ui');
  const hs = e.ctx.peek('police')?.getHudState?.();
  if (!ui?.setBlips || !hs) return 0;
  ui.setWanted(hs.wanted ?? 0, hs.cooldown ?? 1);
  const out = [];
  for (const c of hs.cops ?? []) {
    if (!c?.position) continue;
    out.push({ x: c.position.x, z: c.position.z, kind: c.kind ?? 'cop', heading: c.heading });
  }
  ui.setBlips(out);
  return out.length;
}

/**
 * Frame a STAGED VEHICLE, from the car itself.
 *
 * `vehicles.debugPose('beauty')` already does the hard part: it finds an empty
 * spot, nudges along the camera's forward ray until the subject has room, and
 * hides the traffic. What it cannot do is choose where you stand — and an
 * authored pos/look put a lamp post dead centre with the car behind it, which is
 * the FOURTH time absolute coordinates have photographed the wrong thing in this
 * file. So derive the camera from the car, like `frameBeam` and `frameActor`.
 *
 * Three-quarter front, low: the angle every press shot uses, because it shows a
 * flank and a face at once. A vehicle's nose is +Z (dynamics.js takes
 * forwardSpeed along +Z) — not -Z, which is a camera's basis.
 */
function frameVehicle(e, kind, { dist = 8.2, height = 1.25, swing = 0.62, aimY = 0.85 } = {}) {
  const veh = e.ctx.peek('vehicles');
  if (!veh?.debugPose) return;
  veh.debugPose('beauty', kind ? { type: kind } : {});
  const v = veh._debugSpawned?.[0] ?? null;
  const cam = e.ctx.camera;
  if (!v?.position) return;
  const q = v.quaternion;
  // The car's own nose and right, from its quaternion.
  const nx = 2 * (q.x * q.z + q.w * q.y), nz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const rx = 1 - 2 * (q.y * q.y + q.z * q.z), rz = 2 * (q.x * q.y - q.w * q.z);
  // Ahead of the nose and off to one side: a three-quarter view.
  const ox = nx * Math.cos(swing) + rx * Math.sin(swing);
  const oz = nz * Math.cos(swing) + rz * Math.sin(swing);
  cam.position.set(v.position.x + ox * dist, v.position.y + height, v.position.z + oz * dist);
  e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
  // Teleport FIRST, then aim — and record it, because the player rig re-derives
  // the camera from the player after a teleport. Authoring dist 9.0 and
  // MEASURING 6.0 m at the shutter is what that override looks like.
  cam.position.set(v.position.x + ox * dist, v.position.y + height, v.position.z + oz * dist);
  cam.lookAt(v.position.x, v.position.y + aimY, v.position.z);
  holdCamera(e, cam.position, { x: v.position.x, y: v.position.y + aimY, z: v.position.z });
}

/**
 * PUT SOMEBODY BEHIND EVERY WHEEL IN THE TABLEAU — without this the pursuit
 * shot photographs the exact defect it was added to disprove.
 *
 * `vehicles._updateHeadlights` skips any car that is neither the player's nor
 * has `v.driver` — correct, because a parked car must not burn its lamps, and
 * fatal for a staged still: `police._stagePursuit` spawns five cars and seats
 * nobody. MEASURED on the first cut of this shot at 22:00, three stars, five
 * cars in frame: `hosts [{has:false},{has:false},{has:false}]`, zero road
 * pools, and every headlight in the picture an emissive quad throwing nothing.
 * A reviewer would have scored the multi-host headlight work off a frame in
 * which it was switched off.
 *
 * Both calls are the published doors — `peds.attachDriver` is the ONE way a
 * body enters that system (`police/officer.js` uses the same one), and
 * `vehicles.setDriver` is what sets the field the headlight pass reads. It is
 * also the honest fiction: a pursuit has people in the cars.
 */
function seatStagedDrivers(e) {
  const peds = e.ctx.peek('peds');
  const veh = e.ctx.peek('vehicles');
  if (!peds?.attachDriver || !veh?.setDriver) return 0;
  releaseStagedDrivers(e);
  const seated = (e.__shotDrivers = []);
  let n = 0;
  for (const v of veh.vehicles ?? []) {
    // Only what `police` has just staged: `_stagedVehicles` is private, but a
    // frozen tableau is exactly the set of cars that are stopped with their
    // lightbars lit plus the quarry, and re-seating a car that already has a
    // driver would take a second body for nothing.
    if (v.driver || v.destroyed) continue;
    if (!(v.lightbarOn || v === e.ctx.peek('police')?.quarry?.vehicle)) continue;
    let ped = null;
    try {
      ped = peds.attachDriver(v, 0, { archetype: 'office' });
    } catch {
      ped = null;
    }
    if (!ped) continue;   // `peds` owns its own budget and may say no
    veh.setDriver(v, ped, 0);
    seated.push({ v, ped });
    n++;
  }
  return n;
}

/**
 * GIVE THE BODIES BACK — and this is not tidiness, it is a leak with teeth.
 *
 * `police._clearStage` despawns its tableau by calling `vehicles.despawn`,
 * which frees the CAR and says nothing to `peds`. A ped left in `STATE.DRIVING`
 * with a recycled vehicle stops updating its own position, stands frozen where
 * the car last was and holds a `q.pedBudget` slot until distance streaming
 * happens to notice it — `traffic._unseatPed` carries the same write-up. Seat
 * five and never release them and a batch session (`tools/shotset.mjs`,
 * `tools/screenshots.mjs`) starves the crowd a shot at a time.
 *
 * So: released before the tableau is re-staged, and released by `shotChrome`
 * the moment any OTHER shot is applied. Duck-typed down the same chain
 * `traffic` uses, because `peds` has no `detachDriver` yet.
 */
function releaseStagedDrivers(e) {
  const list = e.__shotDrivers;
  if (!list?.length) return;
  e.__shotDrivers = null;
  const peds = e.ctx.peek('peds');
  const veh = e.ctx.peek('vehicles');
  for (const { v, ped } of list) {
    try {
      veh?.clearDriver?.(v, ped);
      if (typeof peds?.detachDriver === 'function') peds.detachDriver(v);
      else if (typeof peds?.pullFromVehicle === 'function') {
        peds.pullFromVehicle(v, { x: v.position.x + 1.4, y: v.position.y, z: v.position.z });
      }
    } catch { /* a shot must never take the boot down */ }
  }
}

/**
 * Stage a three-star pursuit and frame it FROM THE CAR BEING CHASED.
 *
 * WHY THIS SHOT EXISTS. `vehicles` promoted the headlight pool from one host to
 * three and gave every other headlit car in range a projected road pool, and
 * `props` now spends up to five punctual slots on the nearest lamps — and NO
 * SHOT IN THIS SET SHOWS ANY OF IT. `chase` is the closest and it does not: at
 * 20:12 the night factor (`_updateHeadlights`, `1 - (alt+0.02)/0.14`) is barely
 * off zero, and it stages onto whatever road is nearest a riverside plaza. So
 * the one claim the night-lighting work is judged on — "you can read the road,
 * the kerb and the lane lines ahead of you during a 3-star night pursuit" —
 * had no frame in the review set at all. That is the same hole the searchlight
 * pair was added to close, and it shipped the same way: through a harness that
 * could not photograph the defect.
 *
 * FRAMED FROM THE STAGED QUARRY, not from authored coordinates — the fifth
 * time in this file, see `frameBeam` / `frameVehicle` / `frameActor`.
 * `police.debugStage('pursuit')` puts a fleeing car on the real road graph
 * 34 m in front of the lens facing it, and four cruisers with their bars lit
 * behind that — MEASURED at this anchor, 12 / 25 / 37 / 53 m back down the
 * lane. Standing off the QUARRY puts its face and its own headlights in the
 * near field with the cruisers' beams stacked up the avenue behind it;
 * standing where the shot was authored would frame whatever the road graph
 * happened to put 34 m away this generation.
 *
 * THE STANDOFF IS AN EXPOSURE DECISION, not a taste one, and the numbers are
 * worth keeping because they are also a FINDING about the headlight work. All
 * three spot pairs point back into the lens here, and the road they land on is
 * the brightest thing in the frame. MEASURED over the whole frame at 1280x720,
 * `tools/analyze.mjs`, at three standoffs:
 *
 *   dist 12.4   p99 249   0.94 % over 250   street patch L203
 *   dist  8.4   p99 247   0.55 % over 250   street patch L153
 *   dist  8.0, aimed higher (shipped)
 *               p99 245   0.46 % over 250   street patch L178
 *
 * `night`, for scale, is p99 189 and 0.03 % over 250. So a car park's worth of
 * headlights aimed at the camera does blow the near carriageway, and the
 * further INTO the beams the lens stands the worse it gets — 12.4 m is deep in
 * the hot spot, not clear of it. The shot is composed to show the falloff
 * rather than to hide the level; whether ~0.5 % of a night frame at full beam
 * is acceptable is a judgement for the reviewer, which is the point of having
 * the frame at all.
 *
 * THE AXIS IS THE PRE-STAGING CAMERA'S FORWARD, and it has to be: everything
 * `_stagePursuit` places is `_cam + _fwd * d` snapped to the nearest lane, so
 * that ray is the one line the whole tableau is strung along, and the quarry is
 * turned to face back down it. Two alternatives were tried and both frame an
 * empty street, for the same underlying reason — each car snaps to whatever
 * road edge is nearest ITS distance, so nothing derived from one car's pose
 * describes the queue:
 *
 *   the quarry's own quaternion   its lane can bend away from the line
 *   the nearest cruiser's position at a junction that cruiser is on the CROSS
 *                                 street, and the axis comes out ~90 degrees
 *                                 wrong — MEASURED, it put the lens on the
 *                                 quarry's flank with the queue behind camera
 *
 * `dist`/`side`/`eye` place the lens ahead of and beside the quarry, `aimAhead`
 * aims it back down the line so the receding cruisers are the depth in the
 * frame, and `markAlong`/`markSide` are where the brother goes — see the shot's
 * `player` block. `markSide` is a SIGNED offset from the pursuit axis rather
 * than from `side`, so he can be stood on either kerb.
 *
 * NO `clearTraffic` ON THIS SHOT, deliberately: the pre-shutter sweep despawns
 * anything nearby that is `destroyed || speed < 0.6` and skips only `v._staged`,
 * which `police._spawnAt` does not set. It would delete the entire tableau —
 * five frozen cars — between the last pumped frame and the photograph.
 */
/*
 * `shot` IS A PARAMETER, not `SHOTS.pursuit` read from inside.
 *
 * Two shots stage this tableau now — the review `pursuit` and the marketing
 * `mkt_chase` — and the helper writes the brother's resolved mark back onto
 * the shot it is composing (`shot.player.at`). Reading one shot by name from
 * inside would have `mkt_chase` filling in `pursuit`'s mark and then
 * photographing nobody, which is the same class of mistake as the absolute
 * coordinates this file has now made five times: the helper must be told what
 * it is framing.
 */
function framePursuit(e, { dist = 8.0, side = 3.2, eye = 1.7, aimAhead = 17, aimY = 3.4, markAlong = 1.0, markSide = 5.8 } = {}, shot = SHOTS.pursuit) {
  // A mark resolved from a PREVIOUS apply must never be photographed: shots run
  // back to back in one session and the staging can legitimately fail here.
  if (shot?.player) shot.player.at = null;
  const police = e.ctx.peek('police');
  if (!police?.debugStage) return;

  const cam = e.ctx.camera;
  cam.updateMatrixWorld();
  const me = cam.matrixWorld.elements;
  // Camera forward flattened to XZ — a camera looks down its own -Z.
  const fl = Math.hypot(me[8], me[10]) || 1;
  const ax = -me[8] / fl;
  const az = -me[10] / fl;

  police.debugStage('pursuit');
  const q = police.quarry?.vehicle;
  if (!q?.position) return;
  seatStagedDrivers(e);

  const rx = -az;
  const rz = ax;
  const g = (x, z) => police.groundAt?.(x, z, q.position.y + 6) ?? q.position.y - 0.6;

  // Ahead of the quarry — back toward where the lens already was — and off its
  // shoulder, low.
  const px = q.position.x - ax * dist + rx * side;
  const pz = q.position.z - az * dist + rz * side;
  // Aimed PAST the quarry at the cruiser on its tail (12 m behind it here), so
  // both are in frame and the rest of the queue recedes behind them. Pulled
  // part of the way back across the carriageway so the quarry sits off-centre,
  // and aimed HIGH enough that the blown near carriageway is not half the
  // picture — see the standoff table above.
  const tx = q.position.x + ax * aimAhead + rx * side * 0.35;
  const tz = q.position.z + az * aimAhead + rz * side * 0.35;
  const ty = g(tx, tz) + aimY;
  cam.position.set(px, g(px, pz) + eye, pz);
  cam.lookAt(tx, ty, tz);
  holdCamera(e, cam.position, { x: tx, y: ty, z: tz });

  // The brother, out of the car and back on the kerb the lens is standing at,
  // watching the queue come: the cruiser beams are his key light, he is clear
  // of the car's silhouette, and he is far enough off its door that the
  // contextual-action prompt does not fire and paint 'TAKE THE ...' across the
  // middle of the frame — MEASURED, 3.4 m off the flank still triggers it.
  // Resolved here and consumed at `shot:applied`; `player.at` is the only way
  // to place him against something `apply` has just staged.
  if (shot?.player) {
    const mx = q.position.x + ax * markAlong + rx * markSide;
    const mz = q.position.z + az * markAlong + rz * markSide;
    shot.player.at = [mx, g(mx, mz) + 0.2, mz];
    // Turned back to his own car, which is also where the pursuit is coming
    // from, so he reads three-quarter to the lens rather than as a back.
    // An actor looks down -Z, so facing `d` is `atan2(-d.x, -d.z)`.
    shot.player.yaw = Math.atan2(mx - q.position.x, mz - q.position.z);
  }
}

function frameActor(e, { dist = 3.0, height = 1.62, side = 0.55, aimY = 1.45 } = {}) {
  const pl = e.ctx.peek('player');
  const cam = e.ctx.camera;
  const p = pl?.position;
  if (!p) return false;
  // The actor's facing is -Z (animator.js builds forward as -sin/-cos of yaw);
  // a vehicle's nose is +Z. They are not interchangeable — see ARCHITECTURE.
  const yaw = pl.yaw ?? 0;
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  cam.position.set(p.x - fx * dist + rx * side, p.y + height, p.z - fz * dist + rz * side);
  cam.lookAt(p.x + rx * side * 0.35, p.y + aimY, p.z + rz * side * 0.35);
  return true;
}

/**
 * ---------------------------------------------------------------------------
 * `player:` — PUTTING THE PROTAGONIST IN THE PICTURE.
 * ---------------------------------------------------------------------------
 *
 * `src/player/` has published a full staging contract on `shot:applied` since
 * long before this comment (`PlayerSystem._onShotApplied`), and until now NOT
 * ONE shot in this file used it: `grep -c "player:" src/dev/shots.js` was 0. The
 * default branch of that handler is `this._shotHide = !req` — so with no block
 * the body is hidden outright, and every critic round this project has ever run
 * scored a third-person action game in frames with no protagonist anywhere in
 * them. Worse for `character`, whose whole job is to frame a brother: it derived
 * the camera from him with `frameActor` and then hid him.
 *
 * The block is read at `shot:applied`, which is emitted LAST on both apply
 * paths, so it composes against the final camera — including a pose an `apply`
 * helper has just re-derived. A shot that wants the reverse, a camera composed
 * on the STAGED man, declares `actorFrame` instead of calling `frameActor` from
 * `apply`; that runs at the shutter (see `shotChrome`) and is the only order
 * that survives the capsule settling.
 *
 *   dist      metres in front of the shot camera to drop him (default 4). He is
 *             then dropped onto `physics.groundHeight` at that x/z.
 *   at        [x,y,z] instead, for a shot that wants an exact mark
 *   yaw       world yaw; omitted, he turns to face the camera
 *   state     `player.debugState` name. Use ONLY a STATIONARY one — `idle` or
 *             `aim`. Every other state is a scripted input, and a shot settles
 *             for 240-1500 frames, so `jog` walks the subject out of frame
 *             before the shutter and does it by a different distance each run.
 *   shoulder  +1 / -1, which side the third-person camera sits on
 *   aim / brother / camera / camYaw / camPitch — see the handler.
 *
 * WHERE IT DOES NOT BELONG, deliberately: aerials (`point`), long sightlines
 * (`skyline`, `farview`), landmark elevations (`mill`, `incline`, `bridge`), the
 * macro material shots (`detail`), the searchlight pair (`frameBeam` stands the
 * camera on the player's own mark and holds it), and the vehicle shots (their
 * subject is the car, and `vehicles.debugPose` already seats or stages a
 * driver). A man 6 m from a 1.2 km lens is four pixels of noise.
 *
 * `dist` is chosen against the shot's own eye height and FOV, not by feel: the
 * subject's head sits `eye - 1.75` m below the lens, so the angle below the
 * optical axis is `atan((eye - 1.75) / dist)` and it has to stay well inside
 * `fov / 2`. That is why the raised establishing shots (`hero`, `night`,
 * `mkt_hero`, eye 5.0-5.5) stand him 15-18 m out while the eye-level ones
 * (`street`, `mkt_rain_street`) stand him at 7-8.
 */

export const SHOTS = {
  // ---- environment / lighting ----
  hero: {
    pos: [12, 1.75, 18],
    look: [-4, 2.2, -6],
    fov: 75,
    time: 16.5,
    doc: 'Wide establishing shot down the main street — reads overall art direction.',
  },
  interior: {
    pos: [-8.5, 1.7, 3.2],
    look: [2, 1.6, -2],
    fov: 70,
    time: 16.5,
    doc: 'Interior with light shafts through windows — bounce, AO, volumetrics.',
  },
  detail: {
    pos: [3.2, 1.35, 5.0],
    look: [1.4, 1.1, 2.2],
    fov: 45,
    time: 16.5,
    doc: 'Close-up on wall/prop materials — texel density, normal maps, grime.',
  },
  sunset: {
    pos: [16, 3.2, 22],
    look: [-10, 3.0, -14],
    fov: 65,
    time: 19.2,
    doc: 'Low sun — atmospheric scattering, long shadows, god rays, bloom.',
  },
  night: {
    pos: [12, 1.75, 18],
    look: [-4, 2.2, -6],
    fov: 75,
    time: 1.5,
    doc: 'Night — artificial lights, exposure adaptation, shadow quality in the dark.',
  },

  // ---- weapon / viewmodel ----
  weapon: {
    pos: [6, 1.7, 10],
    look: [-2, 1.8, -2],
    fov: 80,
    time: 16.5,
    apply: (e) => e.ctx.peek('weapons')?.debugPose?.('idle'),
    doc: 'Hip-fire viewmodel — weapon silhouette, materials, hand rig.',
  },
  ads: {
    pos: [6, 1.7, 10],
    look: [-2, 1.8, -2],
    fov: 58,
    time: 16.5,
    apply: (e) => e.ctx.peek('weapons')?.debugPose?.('ads'),
    doc: 'Aiming down sights — optic alignment, depth of field, reticle.',
  },
  muzzle: {
    pos: [6, 1.7, 10],
    look: [-2, 1.8, -2],
    fov: 80,
    time: 16.5,
    apply: (e, o) => e.ctx.peek('weapons')?.debugPose?.('fire', o),
    doc: 'Mid-recoil with muzzle flash — flash shape, light spill, shell eject.',
  },

  // ---- combat / fx ----
  combat: {
    pos: [4, 1.7, 12],
    look: [-6, 1.7, -4],
    fov: 80,
    time: 16.5,
    apply: (e) => e.ctx.peek('peds')?.debugStage?.('firefight'),
    doc: 'Enemies mid-firefight — character quality, animation, impact FX.',
  },
  impacts: {
    pos: [2.5, 1.6, 6],
    // Squared up on the plaster wall 5.25 m away. The old aim looked down the
    // open market, so the burst was staged 20+ m out among the stalls and the
    // decals were never legible — the whole point of this shot.
    look: [-1.8, 1.5, 9.0],
    fov: 60,
    time: 16.5,
    apply: (e) => e.ctx.peek('fx')?.debugBurst?.('wall'),
    doc: 'Bullet impacts on a wall — decals, debris, dust puffs, sparks.',
  },
  hud: {
    pos: [12, 1.75, 18],
    look: [-4, 2.2, -6],
    fov: 80,
    time: 16.5,
    apply: (e) => e.ctx.peek('ui')?.debugState?.('combat'),
    doc: 'Full HUD in combat — layout, typography, readability, hit feedback.',
  },
};

/**
 * ---------------------------------------------------------------------------
 * STEEL CITY shot set.
 *
 * The inherited shots above framed a 120 m Call of Duty market street. These
 * frame the open city described in DESIGN.md. World coordinates are the legacy
 * map's coordinates x4 (DESIGN.md "Scale"), so e.g. the Golden Triangle centre
 * (-58, 16) becomes (-232, 64).
 *
 * `ground: true` makes `pos.y` and `look.y` RELATIVE to the terrain height at
 * that x/z, which keeps a shot framed correctly while `world` is still moving
 * its heightfield around underneath us.
 * ---------------------------------------------------------------------------
 */
const STEEL_CITY_SHOTS = {
  // ---- the establishing set ----
  hero: {
    pos: [-232, 6, 150], look: [-232, 24, -40], fov: 62, time: 17.4, ground: true,
    onRoad: { near: [-232, 64], eye: 5.5, aheadM: 55 },
    clearTraffic: 34,
    player: { dist: 18, state: 'idle' },
    doc: 'Street level looking down a Golden Triangle avenue with a brother in the road — the overall art direction read.',
  },
  skyline: {
    pos: [-528, 60, 464], look: [-232, 40, 40], fov: 50, time: 19.2, ground: true,
    viewmodel: false,
    doc: 'THE signature composition: from the Mt. Washington clifftop across the Mon to downtown, ~500 m out and ~120 m up. Tests skyline silhouette, cliff terrain, river.',
  },
  farview: {
    pos: [984, 90, -56], look: [-232, 40, 40], fov: 42, time: 18.6, ground: true,
    viewmodel: false,
    doc: 'Hazelwood to downtown — the genuinely LONG sightline at 1.2 km. This is the shot that tests LOD, impostors and aerial perspective, not `skyline`.',
  },
  point: {
    pos: [-672, 260, 360], look: [-620, 0, -40], fov: 58, time: 16.0,
    weather: 'scattered',
    viewmodel: false,
    doc: 'Aerial over The Point — all three rivers, the bridges, the city layout in one frame.',
  },
  bridge: {
    pos: [-64, 12, -328], look: [-300, 20, -120], fov: 60, time: 18.4, ground: true,
    weather: 'scattered',
    viewmodel: false,
    doc: 'On a bridge deck over the Allegheny — trusses, deck surface, the river below.',
  },
  street: {
    pos: [680, 4, -520], look: [640, 8, -600], fov: 55, time: 15.0, ground: true,
    onRoad: { near: [680, -552], eye: 2.2, ahead: 0.35 },
    clearTraffic: 34,
    weather: 'overcast',
    player: { dist: 8, state: 'idle' },
    doc: 'Lawrenceville brick rowhouses at eye level — shopfronts, ground-floor density, no visible repetition. A brother stands in the street for scale.',
  },
  mill: {
    pos: [820, 20, 320], look: [872, 40, 248], fov: 58, time: 18.8, ground: true,
    weather: 'overcast',
    viewmodel: false,
    doc: 'Steel Row and the Old Blast Furnace — rusted mill steel, gantries, industrial silhouette.',
  },
  incline: {
    // The incline was rebuilt: it now discovers its uphill bearing by probing
    // terrain instead of extrapolating a hardcoded rise in -z, and runs from
    // about (-488, 296) up a bearing of (-0.609, +0.793) for 180 m, climbing
    // 97.8 m. The old camera here was authored against the BROKEN version that
    // ran the wrong way up the wrong hill, so it framed empty sky. Stand off to
    // the side of the new track so the climb reads as a slope.
    pos: [-430, 42, 452], look: [-556, 58, 372], fov: 55, time: 17.8, ground: true,
    weather: 'overcast',
    viewmodel: false,
    doc: 'The Duquesne Incline climbing Mt. Washington seen side-on — terrain slope, the funicular track and cars, the cliff, hillside housing. The track must sit ON the hill along its whole length.',
  },
  waterfront: {
    pos: [120, 8, 560], look: [-200, 30, 200], fov: 60, time: 7.4, ground: true,
    weather: 'scattered',
    viewmodel: false,
    doc: 'South Side riverfront at morning — water shading, river fog, industrial bank.',
  },

  // ---- lighting / weather sweeps ----
  sunset: {
    // Pulled back onto the Mt. Washington ridge and raised. The old position sat
    // hard against a downtown tower once `buildings` populated the Triangle, and
    // a critic reviewing "the money shot" got half a frame of dark curtain wall.
    pos: [-600, 150, 420], look: [-1000, 20, -60], fov: 58, time: 19.6, ground: true,
    viewmodel: false,
    doc: 'Golden hour down the Ohio from the ridge — scattering, long shadows, god rays, bloom. The money shot.',
  },
  night: {
    pos: [-232, 5, 150], look: [-232, 22, -40], fov: 62, time: 1.5, ground: true,
    onRoad: { near: [-232, 64], eye: 5.0, ahead: 0.3 },
    clearTraffic: 34,
    player: { dist: 15, state: 'idle' },
    doc: 'Downtown at night — sodium pools on wet asphalt, lit windows, exposure adaptation, bloom. The brother is in frame so the night exposure is judged on a lit character too.',
  },
  dawnfog: {
    pos: [-620, 24, 120], look: [-300, 30, -60], fov: 60, time: 6.2, ground: true,
    viewmodel: false,
    doc: 'River fog at dawn pooling in the valley — volumetrics, blue hour, fog that sits in the low ground.',
  },
  rain: {
    pos: [-232, 5, 150], look: [-232, 22, -40], fov: 62, time: 14.0, ground: true,
    onRoad: { near: [-232, 64], eye: 5.0, ahead: 0.3 },
    clearTraffic: 34,
    weather: 'storm',
    viewmodel: false,
    player: { dist: 15, state: 'idle' },
    doc: 'Storm downtown — rain streaks, wet road reflections, puddles, spray. Core to this game s look. The brother is in frame because a man in rain is where wet cloth and hair are judged.',
  },

  /*
   * ---- police searchlight ----
   *
   * WHY THESE EXIST, which is the important part.
   *
   * A player sent a night screenshot in which the helicopter searchlight had
   * washed 15-24% of the frame to a flat cream and dragged the auto-exposure
   * meter down 0.8 EV (2.28 metered under the beam vs 4.09 without), so
   * everything outside the cone went black. The frame read as a diagonal split
   * into blown-out cream and pure black — and it was ONE defect, not the two it
   * looked like.
   *
   * No shot in this set framed the searchlight. So no capture review could ever
   * have caught it: the harness had a hole, and the defect shipped through it to
   * a real player. Every shot here earns its place by covering something a
   * reviewer would otherwise never be shown.
   *
   * Reproduced at 21:21 overcast, wanted 5, because that is the frame that was
   * reported. Two framings, because neither alone is sufficient: from inside the
   * beam you see the wash but cannot judge the penumbra; from outside you can
   * judge penumbra, falloff and ground pool but never see the wash.
   */
  /*
   * NOTE ON FRAMING, learned the hard way. The first cut of these two shots used
   * `onRoad` and authored `look` targets, and produced two IDENTICAL frames with
   * no helicopter and no beam anywhere in them — a shot named `searchlight` that
   * photographed an ordinary night street. Two reasons, both worth stating:
   *
   *   1. `onRoad` REPLACES the authored aim with the lane's own direction, so
   *      the `look` target is ignored and the staged helicopter (placed from the
   *      camera's forward vector) landed at the extreme top edge of frame.
   *   2. `air` aims the beam at the camera, and the fixed beam deliberately
   *      collapses when the camera is inside the cone — that IS the fix for the
   *      wash. So the one framing that reproduces the original defect is also
   *      the framing that shows the least once it is fixed.
   *
   * Both shots therefore stage the helicopter FIRST and then aim the camera at
   * the beam, inside `apply`. Deterministic, because the staged helicopter
   * position is a pure function of the camera pose that preceded it.
   */
  searchlight: {
    pos: [-232, 6, 96], look: [-232, 20, 10], fov: 62, time: 21.35, ground: true,
    clearTraffic: 34,
    weather: 'overcast',
    apply: (e) => frameBeam(e, { stand: 17, aimUp: 0.72 }),
    doc: 'Helicopter searchlight bearing down on the player at 21:21 overcast — the frame a player reported as washed out. Judge: the shaft must have a soft penumbra rather than a hard polygon edge and must fall off along its length; surfaces under it must keep albedo, mortar and window reveals rather than flattening to one cream value; and the REST of the frame must not be crushed to black, which is what the old beam caused by dragging the exposure meter down 0.8 EV.',
  },
  searchlight_side: {
    pos: [-190, 7, 120], look: [-250, 12, 40], fov: 60, time: 21.35, ground: true,
    clearTraffic: 34,
    weather: 'overcast',
    apply: (e) => frameBeam(e, { stand: 72, aimUp: 0.5 }),
    doc: 'The same searchlight seen from OUTSIDE the cone, so the shaft reads edge-on. This is the framing that shows penumbra softness, falloff along the beam, and whether the ground pool has a lit falloff or is a flat disc. The inside view cannot show any of those.',
  },

  // ---- vehicles / driving ----
  car: {
    // Was pos:[6.2,1.35,5.4] look:[0,0.75,0] — a few metres from WORLD ORIGIN.
    // `vehicles.debugPose` stages the car relative to the camera, so all three
    // vehicle shots were staging their subject at the origin, which here is over
    // the river. Same absolute-coordinate mistake as `character` and the first
    // cut of the searchlight shots. Put the camera on a real street first.
    pos: [-232, 6, 96], look: [-232, 5, 60], fov: 45, time: 17.0, ground: true,
    onRoad: { near: [-232, 64], eye: 1.5, aheadM: 9, side: 5.6 },
    clearTraffic: 30,
    weather: 'overcast',
    viewmodel: false,
    apply: (e) => e.ctx.peek('vehicles')?.debugPose?.('beauty'),
    doc: 'Vehicle beauty 3/4 on a real street — car paint flake and clearcoat, shutlines, glass, wheels, interior behind the glass.',
  },
  driving: {
    pos: [-232, 6, 150], look: [-232, 6, -40], fov: 70, time: 17.2, ground: true,
    onRoad: { near: [-232, 64], eye: 2.2, aheadM: 40 },
    clearTraffic: 26,
    weather: 'overcast',
    viewmodel: false,
    apply: (e) => {
      e.ctx.peek('vehicles')?.debugPose?.('chase');
      // See the STAGING THE HUD ITSELF note. Without this the frame is an
      // on-foot HUD photographed behind a car nobody is driving.
      driveHud(e, {
        eyebrow: 'CH 4 · SALVAGE RIGHTS',
        text: 'Run the crates to the yard on Bingham',
        count: '4 / 6 ABOARD',
        timer: 96,
        progress: 0.66,
      });
    },
    hudFrame: driveFrame,
    doc: 'Chase camera behind the player car on a downtown avenue — the camera model, body roll, motion blur, and the DRIVING HUD over it: the vehicle cluster, the GPS route on the ring and the objective panel.',
  },
  cockpit: {
    pos: [-232, 6, 150], look: [-232, 6, -40], fov: 65, time: 17.2, ground: true,
    onRoad: { near: [-232, 64], eye: 1.6, aheadM: 30 },
    clearTraffic: 26,
    weather: 'overcast',
    apply: (e) => {
      e.ctx.peek('vehicles')?.debugPose?.('cockpit');
      driveHud(e, {
        eyebrow: 'CH 4 · SALVAGE RIGHTS',
        text: 'Run the crates to the yard on Bingham',
        count: '4 / 6 ABOARD',
        timer: 96,
        progress: 0.66,
      });
    },
    hudFrame: driveFrame,
    doc: 'From the driver seat on a real street — interior modelling, dash, wheel, hands, glass from inside, with the vehicle instruments (speed, gear, tach, fuel, nitro) read from the seat they belong to.',
  },

  // ---- characters / gameplay ----
  character: {
    // Placed on a real street so the brother has a city behind him rather than
    // a blank wall. `player` stands him 5 m down the pavement from that mark;
    // `actorFrame` then composes the over-the-shoulder camera on him AT THE
    // SHUTTER, once the capsule has settled — see `shotChrome`. It used to
    // compose in `apply`, before the staging existed, and photographed a
    // shoulder at the very edge of frame.
    pos: [-232, 5, 96], look: [-232, 5, 60], fov: 45, time: 16.5, ground: true,
    onRoad: { near: [-232, 64], eye: 1.7, aheadM: 8, side: 4.2 },
    clearTraffic: 20,
    weather: 'overcast',
    viewmodel: false,
    actorFrame: { dist: 3.6, height: 1.66, side: 0.62, aimY: 1.42 },
    // The shot that made the case for the whole `player:` block. Its camera was
    // already derived from the brother, and the default `_shotHide` branch then
    // hid him: the one frame in the set whose named subject is a character had
    // no character in it, through every review round this project has run.
    player: { dist: 5.0, state: 'idle', shoulder: 1 },
    doc: 'Over-the-shoulder on a DeCarlo brother — character quality, cloth, skin, hair, third-person framing. The brother must be the subject and must fill a useful part of the frame.',
  },
  crowd: {
    pos: [-200, 4, 90], look: [-240, 3, 30], fov: 55, time: 12.5, ground: true,
    weather: 'overcast',
    viewmodel: false,
    // 11 m. The lens sits 4.1 m above his feet, and MEASURED at 7 m his feet
    // projected to NDC -1.05 — off the bottom of the picture. Deep inside
    // `debugStage`'s 4.5-30 m band, so he reads as part of the crowd.
    player: { dist: 11, state: 'idle' },
    doc: 'Pedestrians on a downtown sidewalk with the player among them — crowd density, variety, animation, the city feeling alive.',
  },
  chase: {
    pos: [-180, 8, 120], look: [-260, 3, 20], fov: 65, time: 20.2, ground: true,
    apply: (e) => { e.ctx.peek('police')?.debugStage?.('pursuit'); policeHud(e); },
    // Its `doc` has always claimed the wanted HUD and the frame has never had
    // one, for the reason in the STAGING THE HUD ITSELF note.
    hudFrame: policeHud,
    weather: 'scattered',
    viewmodel: false,
    doc: 'Police pursuit — cruisers, lightbars at dusk, traffic reacting, wanted HUD.',
  },
  pursuit: {
    /**
     * THE ANCHOR IS CHOSEN, NOT INHERITED, and it is the difference between
     * this shot and an empty street.
     *
     * `police._stagePursuit` snaps EVERY car in the tableau to the road graph
     * independently — `nearestEdge` at 34, 48, 61, 75 and 90 m — and downtown's
     * longest edge is about 100 m, so a 90 m queue crosses junctions wherever
     * you put it. Where the QUARRY's 34 m mark lands next to a junction it
     * takes the cross street's lane yaw and the car that the whole shot is of
     * comes out broadside with its pursuit behind the lens.
     *
     * MEASURED by re-applying this shot along the avenue and reading the
     * emitted staging — angle between the quarry's nose and the line back to
     * the nearest cruiser, and the cruisers' scatter either side of it:
     *
     *   near z    -26   4    34   64    94    124   154   184
     *   misalign   5°  51°  27°  71°   15°    9°   18°   35°
     *   scatter   22   47   49   57    14     3     4    40   m, worst cruiser
     *
     * 124 is the only anchor where all four cruisers sit inside a lane width of
     * the quarry's own line, at 12 / 25 / 37 / 53 m behind it. `night` and
     * `hero`'s 64 is the worst of the eight. Re-measure if the road graph is
     * regenerated; this is a property of the edges, not of the district.
     *
     * Low — 1.35 m rather than the 5 m establishing eye — because what is being
     * judged is at road level.
     */
    pos: [-232, 5, 150], look: [-232, 12, -40], fov: 62, time: 22.0, ground: true,
    onRoad: { near: [-232, 124], eye: 1.35, aheadM: 46 },
    weather: 'overcast',
    viewmodel: false,
    apply: (e) => { framePursuit(e); policeHud(e); },
    // The stars and the blips are `police`'s, not an authored guess — and they
    // are republished at the shutter because the tableau lives through the
    // whole settle. See `hudFrame` in `shotChrome`.
    hudFrame: policeHud,
    // `at` and `yaw` are FILLED IN BY `framePursuit` against the staged car —
    // the values here are only the shape, and are nulled on every apply so a
    // failed staging can never photograph the last shot's mark. `idle` because
    // a shot settles for hundreds of frames and every other state is a scripted
    // input that walks him out of frame.
    player: { at: null, yaw: 0, state: 'idle', shoulder: -1 },
    doc: 'A 3-star pursuit at 22:00 on a lamp-lined downtown avenue, framed from the car being chased with a brother out at the kerb. THE frame for night lighting: judge whether the carriageway, the kerb line and the lane paint are readable under the lamps and the headlights rather than black; whether more than one car in it throws light (the player car, the nearest cruiser and the pool under every other headlit car); whether the sodium pools have shape and a falloff instead of reading as flat orange decals; and whether a man standing in the beams is lit by them.',
  },
  combat: {
    pos: [-210, 4, 100], look: [-260, 3, 40], fov: 65, time: 16.5, ground: true,
    apply: (e) => e.ctx.peek('peds')?.debugStage?.('firefight'),
    weather: 'overcast',
    // Aiming, inside the tableau (`firefight` stages its reactions from 5 m out
    // and aims them at a ground mark 11 m ahead of the lens). `aim` is
    // STATIONARY — a scripted gait would walk him into the crowd over a settle
    // of hundreds of frames, and by a different distance each run. Nothing here
    // shoots AT him, so he reaches the shutter at full health; MEASURED 130/130.
    // 9 m rather than 6: at 6 his feet projected to NDC -0.83, hard against the
    // bottom edge of a 65 degree frame from a lens 3.4 m above them.
    player: { dist: 9, state: 'aim', shoulder: 1 },
    doc: 'Firefight on the street — third-person gunplay, impact FX, ped reactions. The player is the aiming subject; without him this is a shot of bystanders.',
  },

  // ---- material / detail ----
  detail: {
    pos: [-232, 1.6, 40], look: [-234, 1.0, 34], fov: 38, time: 16.5, ground: true,
    onRoad: { near: [-232, 64], eye: 1.55, aheadM: 5.5, side: 7.5 },
    clearTraffic: 26,
    weather: 'overcast',
    doc: 'Close-up on road surface and kerb — texel density, road paint wear, normal maps, grime.',
  },
  hud: {
    pos: [-232, 6, 150], look: [-232, 24, -40], fov: 62, time: 17.4, ground: true,
    apply: (e) => e.ctx.peek('ui')?.debugState?.('combat'),
    viewmodel: false,
    // The HUD is read OVER a third-person frame in play, and half of what the
    // critic is scoring is contrast against what sits behind it. An empty road
    // is the easiest background this HUD will ever be given.
    player: { dist: 14, state: 'idle' },
    doc: 'Full HUD over a third-person frame — minimap, wanted stars, health/armour, weapon, typography and readability.',
  },
};

// Re-aim the shot set at Steel City. Inherited shots that no longer describe
// anything in this game (the CoD market interior, the first-person viewmodel
// poses) are dropped; the names the tooling enumerates come from __SHOTS__ so
// nothing downstream needs to change.
for (const k of ['interior', 'weapon', 'ads', 'muzzle', 'impacts']) delete SHOTS[k];

/* =======================================================================
 * STAGING FOR THE SECOND MARKETING WAVE — aircraft, armour and the cars.
 * =======================================================================
 *
 * The first marketing set photographed places. This one has to photograph the
 * VERBS — fly, fight, chase, drive — and three of them have no staging API at
 * all, because nothing in the game ever needed to hold a machine still:
 *
 *   an aircraft IN FLIGHT   `vehicles.debugPose` stages on the ground off the
 *                           camera's forward ray, and a plane simply spawned
 *                           at altitude is a plane that falls. A shot settles
 *                           for roughly 1300 frames — twenty seconds of sim —
 *                           which is long enough for a Skylark dropped at
 *                           190 m to reach the river and burn. (Same failure
 *                           the `chase` pose had: 21 m/s of unpinned car drove
 *                           420 m and left `driving.png` with NO CAR IN IT.)
 *   the AIRBASE             its own encounter arms the moment anything crosses
 *                           the wire, and every shot teleports the player to
 *                           its camera. A flightline still would photograph a
 *                           klaxon, three waves of guards and its own subject
 *                           being shelled — `game/airbase.js` publishes the
 *                           inert state for exactly this, as `?noassault=1`.
 *   THREE hero cars         `debugPose` stages one subject; `debugStage('row')`
 *                           stages several but rays for the ground from
 *                           `shot.pos[1] + 14`, which is under the terrain at
 *                           the body shop (deck 24.2 m, a `ground: true` shot's
 *                           authored y is single digits).
 *
 * So three small stagers here, all built out of PUBLISHED doors
 * (`vehicles.spawn` / `despawn`, `specOf`, `world.heightAt`, the assault's own
 * negative-control flag), all releasing what they took the moment another shot
 * is applied (see `shotChrome`), and all composing the camera FROM the staged
 * subject rather than from authored coordinates — the rule the rest of this
 * file learned the expensive way.
 */

/** Scratch for the stagers. Shots run at apply/shutter, never per frame, but
 *  allocating a Euler per aircraft is still pointless. */
const _euler = new THREE.Euler();
const _vec = new THREE.Vector3();

/**
 * PARK A MACHINE WHERE THE SHOT WANTS IT, and have it still be there at the
 * shutter — an aircraft in the sky, a hull on the river.
 *
 * `v.kinematic` is the one honest way to do this. `VehicleSystem.fixedUpdate`
 * skips `fixedStep` entirely for a kinematic body (that is how the trolley
 * rides its rails without being handed to the tyre model and gravity), so the
 * pose set here is the pose photographed 1300 frames later — no pin to fight
 * the integrator, no drift to measure, and `syncTransforms` still draws it and
 * still turns its rotors from `rotorPhase`.
 *
 * What it costs: `stepPlane`/`stepHeli` never run, so the governor never spools
 * and the exhaust flame — which `plane.js` lights from the SPOOLED throttle
 * inside the flight step — stays dark. The blades are posed by hand below as the
 * floor, and a shot that wants a TURNING disc asks `vehicles.debugSpool` for one
 * every frame — see `spoolStaged` and `tickStagedSpool`. A cruising aircraft has
 * no visible plume anyway; a lit afterburner would be worth a followup, not a
 * fake.
 *
 * `despawn` refuses a kinematic vehicle unless the call is `hard` (the trolley
 * must survive every cull), so `releaseStagedKinematic` says so explicitly.
 */
function stageKinematic(e, { type = 'plane', at, yaw = 0, pitch = 0, roll = 0, phase = 0.9 }) {
  const veh = e.ctx.peek('vehicles');
  // Null until a shot ASKS to spool this machine: `false` has to mean "asked and
  // `vehicles.debugSpool` was not there", not "never asked", or the capture log
  // reports a missing rotor on the boat.
  e.__shotSpool = null;
  if (!veh?.spawn || !at) return null;
  releaseStagedKinematic(e);
  const v = veh.spawn(type, _vec.set(at[0], at[1], at[2]), yaw, { plate: 'DCB AIR' });
  if (!v) return null;
  // Not a wreck waiting to happen: nothing in the street may write this off,
  // and nothing may integrate it.
  v._staged = true;
  v.kinematic = true;
  v.quaternion.setFromEuler(_euler.set(pitch, yaw, roll, 'YXZ'));
  v.prevQuaternion.copy(v.quaternion);
  v.prevPosition.copy(v.position);
  v.velocity.set(0, 0, 0);
  v.angularVelocity.set(0, 0, 0);
  v.engineOn = true;
  // The blades: `syncTransforms` reads these two directly, so an aircraft that
  // is never stepped still has a disc at a believable angle rather than one
  // frozen at zero with a blade down the fuselage centreline.
  v.rotorSpin = 1;
  v.rotorPhase = phase;
  v.tailPhase = phase * 2.4;
  v.syncTransforms(1, 0);
  (e.__shotKinematic ??= []).push(v);
  return v;
}

/**
 * SPIN THE DISC ON A MACHINE THAT IS NEVER STEPPED.
 *
 * `stageKinematic` documents the hole this fills: a kinematic body skips
 * `fixedStep`, so `stepHeli` / `stepPlane` never run, the governor never spools,
 * and the aircraft in a marketing frame is a machine with its engine off. The
 * blades are hand-posed there (`rotorSpin = 1`, a phase off zero) which at least
 * stops a blade lying down the fuselage centreline, but it is a POSE: the disc
 * stands still, every blade is legible one at a time, and `vehicles` calls that
 * "the single most obvious 'this is a model, not an aircraft' tell there is".
 *
 * `vehicles.debugSpool(v, rpm01, dt)` is that subsystem's own published door for
 * it and it is theirs to own — the shot asks, it does not reach in. Its contract
 * says it is CALLED ONCE PER FRAME by whoever is staging the shot, which is why
 * `tickStagedSpool` below exists: one call at apply time would set a governor
 * state and one frame of phase, and the 1300 frames of settle that follow would
 * photograph it standing still again.
 *
 * STILL OPTIONAL, deliberately. It landed mid-wave; a capture on a tree without
 * it must degrade to the hand-set pose rather than fail, so every call is
 * guarded and the outcome is published on the engine — `null` never asked,
 * `false` asked and skipped, `true` ran — for `tools/screenshots.mjs` to report.
 * `spool_control` (scratch) stubs the method in and out to prove those three
 * states are distinguishable.
 *
 * ---------------------------------------------------------------------------
 * `shutterDt` — THE SHUTTER IS AN EXPOSURE, AND A REAL RATE OVER-EXPOSES IT
 * ---------------------------------------------------------------------------
 * A gallery pass read `mkt_heli` as "no main rotor blades, only a gold mast
 * stub". The blades were there the whole time. MEASURED at the shutter through
 * `vehicles`' own handles: the staged Skywatch is 15.6 m from the lens at LOD0,
 * its `rotor_y` pivot carries a 108-triangle blade mesh with `visible: true`,
 * and `debugSpool` had run (`spool: true` in the capture's render info). The
 * "gold stub" is the chrome mast, which is opaque; the four blades were not.
 *
 * WHY. `capture.mjs` freezes the sim and then converges TAA over a FIXED 32
 * frames — those 32 frames ARE the exposure, and this is what fills them. A
 * 0.22 m chord at ~3 m radius is 4.2 degrees of arc, so four blades cover 4.7%
 * of the disc on any one frame; at the class's real 40 rad/s and a 1/60 step
 * the disc turns 3.4 REVOLUTIONS across the exposure, every phase is
 * independent, and each pixel of the disc therefore accumulates blade in about
 * one frame in twenty. The disc resolves at roughly 5% opacity, which at
 * gallery size is nothing.
 *
 * The fix is the exposure, not the mesh. A blade smeared over a sweep S reads
 * at about (blade arc / S), so S near 20 degrees puts the disc at ~20% — a
 * blurred arc that reads as TURNING, which is the whole point of spooling it,
 * without the frozen cross that a static pose gives. 20 degrees over 32 frames
 * at 40 rad/s is `dt` of about 1/3600.
 *
 * `debugSpool`'s `dt` is published as "seconds of blade phase to advance"
 * precisely so a harness stepping at its own cadence can ask for its own rate,
 * so this is that door and not a reach into `vehicles`. DEFAULTS to 1/60, so
 * every shot that does not ask is bit-for-bit what it was — `mkt_flight`'s
 * twin, whose 1.9 m props sweep a far smaller disc, is deliberately left alone.
 */
function spoolStaged(e, v, { shutterDt = 1 / 60 } = {}) {
  const veh = e.ctx.peek('vehicles');
  e.__shotSpool = false;
  if (!v || typeof veh?.debugSpool !== 'function') return false;
  // Read by `tickStagedSpool`, which is the call that actually fills the
  // exposure — this one only proves the door is there.
  v._shotSpoolDt = shutterDt;
  try {
    veh.debugSpool(v, 1, shutterDt);
  } catch {
    return false;
  }
  e.__shotSpool = true;
  // The pose the shutter photographs is the one `syncTransforms` last wrote, so
  // publish this one onto the drawn nodes now rather than waiting a frame. Same
  // rule as `holdCamera` and the re-pinned sky clock: the last write before the
  // photograph is the one that counts.
  try { v.syncTransforms(1, 0); } catch { /* a shot must never take the boot down */ }
  return true;
}

/**
 * One frame's worth of rotor, for everything this file has staged in the air.
 *
 * Hung off the capture step wrapper (see `installShotApi`) rather than off an
 * engine event, because there is no per-frame hook to subscribe to and because
 * CAPTURE is exactly the case that needs it: the shot's own apply runs once,
 * ~1300 frames before the shutter. `dt` is the capture clock's fixed 1/60 and
 * not `time.dt`, on purpose — the shutter freezes the sim with `time.scale = 0`
 * and then converges TAA over a fixed 32 frames, and a disc that stops dead for
 * those frames resolves as a sharp cross. Turning through them is what puts a
 * BLURRED disc in the photograph, which is what a rotor looks like.
 *
 * HOW FAR it turns through them is the shot's to choose, because those 32
 * frames are an exposure and 1/60 of a second of a 382 rpm disc over-exposes it
 * to invisibility — see `shutterDt` in `spoolStaged`, which is where the
 * measurement is. Absent that, the rate is exactly what it always was.
 *
 * Costs nothing when nothing is staged, and `debugSpool` returns null for the
 * kinds that have no rotor (the staged Riverjack), so the boat shot pays one
 * property read.
 */
function tickStagedSpool(engine) {
  const list = engine.__shotKinematic;
  if (!list?.length) return;
  const veh = engine.ctx.peek('vehicles');
  if (typeof veh?.debugSpool !== 'function') return;
  for (let i = 0; i < list.length; i++) {
    try { veh.debugSpool(list[i], 1, list[i]._shotSpoolDt ?? 1 / 60); } catch { /* never take the capture down */ }
  }
}

function releaseStagedKinematic(e) {
  const list = e.__shotKinematic;
  if (!list?.length) return;
  e.__shotKinematic = null;
  const veh = e.ctx.peek('vehicles');
  for (const v of list) {
    try { veh?.despawn?.(v, { hard: true }); } catch { /* a shot must never take the boot down */ }
  }
}

/**
 * Frame a staged aircraft FROM the aircraft — a chase rig, not a drone.
 *
 * `dist` back along its flattened nose, `side` off its right wing, `up` above
 * it; the aim runs `aimAhead` further down the same line and `aimY` below it,
 * which is what tips the horizon down far enough to put the city and its
 * bridges UNDER the aeroplane instead of behind it.
 *
 * The nose is flattened to the ground plane on purpose: a banked aircraft's
 * own right vector rolls the LENS with it, and a marketing frame wants the
 * bank in the subject and the horizon level. (`player/camera.js`'s flight
 * chase makes the same choice for the same reason.)
 */
function frameAircraft(e, v, { dist = 30, up = 6, side = 9, aimAhead = 26, aimY = -8 } = {}) {
  if (!v?.position) return;
  const cam = e.ctx.camera;
  const q = v.quaternion;
  // The nose (+Z in the body frame — dynamics takes forwardSpeed along +Z),
  // flattened, and the right that goes with it.
  let fx = 2 * (q.x * q.z + q.w * q.y);
  let fz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const fl = Math.hypot(fx, fz) || 1;
  fx /= fl; fz /= fl;
  const rx = fz, rz = -fx;
  cam.position.set(
    v.position.x - fx * dist + rx * side,
    v.position.y + up,
    v.position.z - fz * dist + rz * side
  );
  const t = {
    x: v.position.x + fx * aimAhead,
    y: v.position.y + aimY,
    z: v.position.z + fz * aimAhead,
  };
  cam.lookAt(t.x, t.y, t.z);
  e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
  holdCamera(e, cam.position, t);
}

/**
 * RIDGELINE AFB WITHOUT THE FIREFIGHT.
 *
 * `game/airbase.js` arms its encounter on `insidePerimeter(focus)`, and every
 * shot teleports the player onto its camera — so a still composed on the apron
 * is a still of a klaxon, a guard wave every seven seconds and three
 * emplacements walking 2100-point shells onto the lens. That is a legitimate
 * frame, but it is not the flightline, and it is not reproducible: the tableau
 * would be a different battle every time the settle length moved.
 *
 * The module already publishes the state this shot wants — `disabled`, the
 * `?noassault=1` negative control, documented there as "dressed (parked jets,
 * tanks, jeeps) but inert". So flip that, stand the encounter down, and
 * photograph the base. Restored by `shotChrome` for any shot that does not
 * declare `airbase: true`, so one marketing capture cannot leave the base
 * switched off under a later review frame.
 */
function airbaseInert(e, off) {
  const A = e.ctx.peek('game')?.airbase;
  if (!A) return null;
  if (off) {
    if (e.__abAssault === undefined) e.__abAssault = A.disabled;
    A.disabled = true;
    A.reset?.();
  } else if (e.__abAssault !== undefined) {
    A.disabled = e.__abAssault;
    e.__abAssault = undefined;
  }
  return A;
}

/** The dressed apron, live handles, west to east: `[near … far]` per kind. */
function airbaseCast(e) {
  const A = airbaseInert(e, true);
  const live = (v) => v?.position && !v.destroyed;
  return {
    jets: (A?.jets ?? []).filter(live),
    tanks: (A?.tanks ?? []).map((t) => t?.v).filter(live),
    jeeps: (A?.jeeps ?? []).filter(live),
  };
}

/**
 * Stand off a ROW of parked machines and look down it.
 *
 * The row is the composition: three jets on 92 m stands, or three tanks on
 * 52 m ones, read as a receding line with the hangar band behind them — depth
 * that no single subject on an apron the size of Ridgeline's can give you.
 *
 * Everything derives from the live handles, never from the field-local
 * layout: `world.airbase` owns that frame and re-deriving it here would be the
 * second owner of a spatial fact (and would silently lie the day the survey
 * re-sites the base). `back` is metres behind the near machine along the row,
 * `side` metres off it — NEGATIVE is the side its nose points at, i.e. the
 * taxiway, which is the side that puts the hangars BEHIND the subject.
 */
function frameRow(e, list, { back = 40, side = -40, eye = 4.5, aim = 1, aimUp = 2.5, aimBias = 0 } = {}) {
  if (!list || list.length < 2) return false;
  const near = list[list.length - 1];
  const far = list[0];
  let dx = far.position.x - near.position.x;
  let dz = far.position.z - near.position.z;
  const l = Math.hypot(dx, dz) || 1;
  dx /= l; dz /= l;
  // Right of "down the row". For the apron rows this points away from the
  // runway, so a negative `side` stands the lens on the taxiway side.
  const rx = dz, rz = -dx;
  const cam = e.ctx.camera;
  cam.position.set(
    near.position.x - dx * back + rx * side,
    near.position.y + eye,
    near.position.z - dz * back + rz * side
  );
  const a = list[Math.min(aim, list.length - 1)];
  const t = {
    x: a.position.x + rx * aimBias,
    y: a.position.y + aimUp,
    z: a.position.z + rz * aimBias,
  };
  cam.lookAt(t.x, t.y, t.z);
  e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
  holdCamera(e, cam.position, t);
  return true;
}

/**
 * THE THREE BROTHERS' OWN CARS, STOOD TOGETHER.
 *
 * `kessel` / `pickup` / `suv` are hero-only classes with single-colour hero
 * paint pools (grey K5, red Ranger, white 4Runner — `specs.js`), so spawning
 * them by name is all it takes to get each brother's actual car. They never
 * appear in the traffic mix, which is also why no existing frame has ever had
 * more than one of them in it.
 *
 * Placed on a shallow arc rather than in a rank: a straight row of three at
 * one yaw is a dealership photograph, and the near flanks occlude each other.
 * `spread` is the arc's radius about the hub, `splay` how far the outer two
 * are swung round toward the lens, and every car is dropped onto
 * `world.heightAt` + its own `comY` and then CHOCKED — brake and handbrake,
 * exactly like `debugPose('beauty')`, because a capture settles for twenty
 * seconds and a forecourt has camber on it.
 *
 * ---------------------------------------------------------------------------
 * `paint` — THE COLOUR IS THE SHOT'S, BECAUSE THE POOL ROLL IS NOT ONE COLOUR
 * ---------------------------------------------------------------------------
 * A gallery pass read this frame as "two of the three are white — the
 * one-colour-each promise collapses", and "the left car's paint renders mottled
 * like frost". Both are `_choosePaint` doing exactly what it is written to do,
 * and neither is a defect in `vehicles`:
 *
 *   COLOUR.  The hero pools are single-entry (`specs.js`: `runnerwhite`,
 *            `rangerred`, `k5grey`) so the HUE is fixed — but the tone roll is
 *            not, and `k5 grey` (0x767c84) rolled light sits a few percent off
 *            `runner white` (0xdedcd6) under one sky. Two of them then read as
 *            the same car in different sizes, which is precisely what the pass
 *            reported. The pool cannot fix that: grey and white ARE close.
 *   WEAR.    `PAINT_WEARS` is [0, 0.5] and a non-fleet spawn rolls it, so a
 *            staged hero car had a 50% chance of the 0.5 mask — road film plus
 *            rust bloom over a near-white body, which is the frost.
 *
 * `spawn` already takes `{ paint, finish, flake, wear }` and `_choosePaint`
 * short-circuits the whole roll when `paint` is given (wear defaults to 0 on
 * that path, which is the neutral mask this frame wants). So the shot names the
 * colour. That is the marketing set's job — it is the same call `debugPose`
 * makes for its beauty paint — and it does NOT change what these cars look like
 * in play, where the catalogue pools still own them.
 */
function stageCars(e, hub, cars) {
  const veh = e.ctx.peek('vehicles');
  const w = e.ctx.peek('world');
  if (!veh?.spawn || !w?.heightAt) return [];
  releaseStagedCars(e);
  const out = (e.__shotCars = []);
  for (const c of cars) {
    const x = hub.x + c.dx;
    const z = hub.z + c.dz;
    const comY = veh.specOf?.(c.type)?.comY ?? 0.6;
    const gy = w.heightAt(x, z) ?? 0;
    const v = veh.spawn(c.type, _vec.set(x, gy + comY + 0.05, z), c.yaw, {
      plate: c.plate,
      // Undefined falls straight through to the pool roll, so a caller that
      // does not care about colour is unaffected.
      paint: c.paint,
      finish: c.paint !== undefined ? 'gloss' : undefined,
      flake: c.flake,
      wear: 0,
    });
    if (!v) continue;
    v._staged = true;
    v.engineOn = false;
    v.input.brake = 1;
    v.input.handbrake = true;
    out.push(v);
  }
  return out;
}

function releaseStagedCars(e) {
  const list = e.__shotCars;
  if (!list?.length) return;
  e.__shotCars = null;
  const veh = e.ctx.peek('vehicles');
  for (const v of list) {
    try { veh?.despawn?.(v, { hard: true }); } catch { /* a shot must never take the boot down */ }
  }
}

/**
 * ONE COLOUR EACH, AND IT IS THE BROTHER'S OWN. `ui/data.js` gives every
 * DeCarlo a colour that the boot card, his HUD and his own car's brake calipers
 * (`specs.js`: `caliper` is Carson's teal, Aidan's amber, Dylan's cyan accent)
 * are already painted in, so the three cars standing together is the one frame
 * in the set that can say who they belong to without a caption. Carson teal,
 * Aidan orange, Dylan violet — read off `BOYZ` and darkened into paint that a
 * real car could be ordered in, because the UI values are screen colours and a
 * body panel at 0xff6a12 reads as a traffic cone.
 *
 * Named here rather than imported: `shots.js` is a dev harness and a hard
 * import of `ui/data.js` for three numbers would make the capture path depend
 * on the UI module graph. The tie is documented instead, in both directions.
 */
const BOYZ_PAINT = {
  /** Carson `#2ea6a0` — deep teal, the river brother. */
  carson: { paint: 0x17605c, flake: 0.30 },
  /** Aidan `#ff6a12` — burnt orange, the body man's own respray. */
  aidan: { paint: 0xb8480f, flake: 0.42 },
  /** Dylan `#c07cff` — violet, the one that is unmistakably his. */
  dylan: { paint: 0x472a7c, flake: 0.55 },
};

/**
 * The brothers' cars at the DeCarlo Body Shop, framed from the cars.
 *
 * The hub is placed off the camera the shot's `onRoad` block has already
 * snapped to the street outside the shop, so the group stands on the forecourt
 * whatever the generator did with that lot — the same reason `onRoad` exists at
 * all. The lens then goes back to a low three-quarter on the hub, and each car
 * is spawned in its owner's colour (`BOYZ_PAINT` above, `stageCars`' `paint`).
 */
function frameBoyzCars(e, {
  ahead = 15, offset = 0, spread = 3.9, splay = 0.5, depth = 1.9,
  dist = 12.5, eye = 1.5, swing = 0.62, aimY = 1.1,
} = {}) {
  const cam = e.ctx.camera;
  cam.updateMatrixWorld();
  const m = cam.matrixWorld.elements;
  const fl = Math.hypot(m[8], m[10]) || 1;
  const fx = -m[8] / fl;
  const fz = -m[10] / fl;
  const rx = -fz;
  const rz = fx;
  const hub = { x: cam.position.x + fx * ahead + rx * offset, z: cam.position.z + fz * ahead + rz * offset };
  // The cars face back down the camera's own axis, splayed. An actor looks
  // down -Z and a vehicle's nose is +Z, so "facing the lens" is the camera's
  // BACKWARD vector: atan2(-fx, -fz).
  const face = Math.atan2(-fx, -fz);
  const cars = stageCars(e, hub, [
    { type: 'suv', plate: 'DCB 001', dx: -rx * spread, dz: -rz * spread, yaw: face - splay, ...BOYZ_PAINT.carson },
    { type: 'pickup', plate: 'DCB 002', dx: fx * depth, dz: fz * depth, yaw: face, ...BOYZ_PAINT.aidan },
    { type: 'kessel', plate: 'DCB 003', dx: rx * spread, dz: rz * spread, yaw: face + splay, ...BOYZ_PAINT.dylan },
  ]);
  if (!cars.length) return false;
  // Three-quarter, low, off the hub — and off to the side the arc opens
  // toward, so the near car reads as a flank and a face rather than a nose.
  const ox = -fx * Math.cos(swing) + rx * Math.sin(swing);
  const oz = -fz * Math.cos(swing) + rz * Math.sin(swing);
  const gy = e.ctx.peek('world')?.heightAt?.(hub.x, hub.z) ?? cam.position.y;
  cam.position.set(hub.x + ox * dist, gy + eye, hub.z + oz * dist);
  e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
  cam.position.set(hub.x + ox * dist, gy + eye, hub.z + oz * dist);
  const t = { x: hub.x, y: gy + aimY, z: hub.z };
  cam.lookAt(t.x, t.y, t.z);
  holdCamera(e, cam.position, t);
  return true;
}

/**
 * Frame a BOAT with the skyline behind it — the lens on the far side of the
 * hull FROM the city, so the frame has a near subject, a river and a skyline.
 *
 * THE DOCK FLEET WAS THE FIRST CHOICE AND IS THE WRONG ONE.
 * `freeroam._seedDockVehicles` moors a Riverjack at each of the three slips at
 * boot, so a subject already exists — but `findWaterSpot` moors it wherever
 * the water search lands, and at the South Side Docks that is hard against a
 * bridge pier. Three framings were drafted from it and in all three the
 * PIER is the photograph: a 20 m concrete block dead centre with the boat as a
 * dark sliver under it. A marketing frame cannot be hostage to where a spawn
 * search happened to stop, so the hull is staged mid-channel instead, on the
 * Monongahela's own published centreline, and held there kinematically for
 * the same reason the aircraft are.
 */
function frameBoat(e, { at, yaw = 0, toward = [-232, 64], dist = 22, eye = 2.6, side = 6, aimPast = 90, aimY = 22 } = {}) {
  const v = stageKinematic(e, { type: 'boat', at, yaw });
  if (!v) return false;
  // Toward the city, flattened: the axis the whole composition is strung on.
  let ax = toward[0] - v.position.x;
  let az = toward[1] - v.position.z;
  const al = Math.hypot(ax, az) || 1;
  ax /= al; az /= al;
  const rx = -az;
  const rz = ax;
  const cam = e.ctx.camera;
  cam.position.set(
    v.position.x - ax * dist + rx * side,
    v.position.y + eye,
    v.position.z - az * dist + rz * side
  );
  const t = {
    x: v.position.x + ax * aimPast,
    y: v.position.y + aimY,
    z: v.position.z + az * aimPast,
  };
  cam.lookAt(t.x, t.y, t.z);
  e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
  holdCamera(e, cam.position, t);
  return true;
}

/**
 * STAND OFF A SHOPFRONT AND LOOK ALONG IT — a frame composed on the FRONTAGE
 * LINE, not on the carriageway.
 *
 * THE ROAD GRAPH IS THE WRONG AUTHORITY HERE, and the first draft proved it.
 * `onRoad` stands the lens on a lane centre and aims down the carriageway at
 * `eye * 0.55`, which is right for a driving shot and wrong for a shopfront:
 * MEASURED at 1280x720 outside the body shop, the bottom 55% of the picture was
 * empty tarmac, the near fascia was 40 m off the lens, and the frame's largest
 * object was a signal mast. That is the exact critic finding the marketing set
 * exists to answer — "the bottom 40-60% of the frame is a featureless flat
 * ground plane with nothing on it".
 *
 * `world.lots` publishes what this shot actually cares about: `frontage`, the
 * segment the shopfront was built on (`world/lots.js`), which is the line
 * `props/layout.js:_frontage` hangs the fascia, the blade, the awning and the
 * lit window off. MEASURED on the body shop's own block: the frontage stands
 * 20 m off the lane-0 centre, so a camera placed off the LANE is 20 m from
 * where the signs are and a camera placed off the FRONTAGE is where you asked
 * for.
 *
 * Everything below is in the frontage's own frame: `u` along the wall, `n` out
 * of it into the street.
 *
 *   near       the anchor the shot is about — a POI or safehouse coordinate.
 *              The lot whose frontage midpoint is nearest it wins.
 *   back/out   the camera, metres back along the wall and out from it. `out`
 *              is what sets the angle the wall is read at: on this block, 16 m
 *              out and 20 m back is 27 degrees, which shows a shopfront's face
 *              AND lets the row recede. Under about 12 degrees the frontage is
 *              edge-on and the type on it is unreadable.
 *   aimAhead   where down the wall the aim lands, so the row runs to a
 *              vanishing point instead of sitting square.
 *   aimOut     off the wall toward the street: swings the lens back across the
 *              carriageway so the far pavement and its lamps close the frame.
 *   aimY       metres above the frontage's own ground. The fascia band sits at
 *              3.15-4.05 m and the blades at 3.3-4.7 (`props/layout.js`), so
 *              this is the number that decides whether the picture is signage
 *              or asphalt.
 *   markAhead / markSide
 *              where the brother stands, down the view axis and to its right.
 *              Resolved here and consumed at `shot:applied` through
 *              `shot.player.at` — the same contract `framePursuit` uses, and
 *              the only way to place him against a composition `apply` has
 *              just derived.
 *
 * `shot` is a PARAMETER for the same reason it is on `framePursuit`: the helper
 * writes the mark back onto the shot it is composing, and reading a shot by
 * name from inside is how one shot ends up staging another one's actor.
 */
function frameFrontage(e, {
  near, back = 20, out = 16, eye = 1.62, aimAhead = 8, aimOut = 2, aimY = 4.6,
  markAhead = 0, markSide = 0,
} = {}, shot = null) {
  if (shot?.player) shot.player.at = null;
  const w = e.ctx.peek('world');
  const lots = w?.lots;
  if (!lots?.length || !near) return false;
  let lot = null;
  let bestD = Infinity;
  for (let i = 0; i < lots.length; i++) {
    const fr = lots[i].frontage;
    if (!fr) continue;
    const mx = (fr[0][0] + fr[1][0]) * 0.5;
    const mz = (fr[0][1] + fr[1][1]) * 0.5;
    const d = Math.hypot(mx - near[0], mz - near[1]);
    if (d < bestD) {
      bestD = d;
      lot = lots[i];
    }
  }
  // 60 m is the forecourt radius plus a lot depth: past that the "anchor" is
  // fronting some other street and the frame would be of somewhere else.
  if (!lot || bestD > 60) return false;
  const fr = lot.frontage;
  const mx = (fr[0][0] + fr[1][0]) * 0.5;
  const mz = (fr[0][1] + fr[1][1]) * 0.5;
  let ux = fr[1][0] - fr[0][0];
  let uz = fr[1][1] - fr[0][1];
  const ul = Math.hypot(ux, uz) || 1;
  ux /= ul;
  uz /= ul;
  /**
   * WHICH WAY IS ALONG, AND WHICH WAY IS OUT — neither can be read off the
   * winding. `lots.js` emits both rows of a block u0 -> u1, so the segment's
   * direction is the generator's business and is right half the time;
   * `_frontage` in `props` decides OUT from the lot centroid for exactly this
   * reason, and this decides ALONG from the world axes so a number tuned here
   * cannot silently reverse the composition on a rebuild.
   */
  if (ux < 0 || (ux === 0 && uz < 0)) {
    ux = -ux;
    uz = -uz;
  }
  let nx = uz;
  let nz = -ux;
  if (nx * (mx - lot.cx) + nz * (mz - lot.cz) < 0) {
    nx = -nx;
    nz = -nz;
  }
  const g = (x, z) => w.heightAt?.(x, z) ?? 0;
  const px = mx - ux * back + nx * out;
  const pz = mz - uz * back + nz * out;
  const tx = mx + ux * aimAhead + nx * aimOut;
  const tz = mz + uz * aimAhead + nz * aimOut;
  const cam = e.ctx.camera;
  const target = { x: tx, y: g(mx, mz) + aimY, z: tz };
  cam.position.set(px, g(px, pz) + eye, pz);
  cam.lookAt(target.x, target.y, target.z);
  // Teleport, then re-assert: the player rig re-derives the camera from the
  // player on the frames after a teleport (see `holdCamera`).
  e.ctx.peek('player')?.teleport?.(cam.position, cam.rotation);
  cam.position.set(px, g(px, pz) + eye, pz);
  cam.lookAt(target.x, target.y, target.z);
  holdCamera(e, cam.position, target);

  if (shot?.player && (markAhead || markSide)) {
    let fx = tx - px;
    let fz = tz - pz;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const kx = px + fx * markAhead - fz * markSide;
    const kz = pz + fz * markAhead + fx * markSide;
    shot.player.at = [kx, g(kx, kz) + 0.2, kz];
  }
  return true;
}

/* =======================================================================
 * MARKETING SHOTS — the set that goes in the repo's README.
 * =======================================================================
 *
 * These are NOT review shots and the difference matters.
 *
 * The review set exists for critics: it must COVER the game, so it is
 * deliberately repetitive, deliberately unflattering, and framed to expose
 * defects. A four-lens panel scored it 23/100 and its sharpest line was the
 * fairest one — "there is no evidence anyone composed these images", and
 * "fourteen of the twenty-four are the same riverfront plaza shot from roughly
 * the same eye height and yaw". That is correct, and for a review set it is
 * almost a virtue.
 *
 * A marketing set has the opposite job: one frame, one idea, composed. So every
 * shot here is authored against three rules the critic gave us for free —
 *
 *   1. A POINT OF INTEREST. Something the eye lands on. The critic's complaint
 *      was "the bottom 40-60% of the frame is a featureless flat ground plane
 *      with nothing on it" — so no shot here points at empty ground.
 *   2. READABLE DEPTH. A foreground element, a mid-ground subject and a
 *      background, so the city has kilometres in it rather than "a near layer
 *      and a cutout".
 *   3. AN AUTHORED PALETTE. Each frame commits to a time and a weather that
 *      serve the Pittsburgh brief — sodium amber, slag orange, river teal, cold
 *      steel over wet grey-brown, leaning overcast. `hero` is the one deliberate
 *      exception: a clear golden hour, because a README needs one bright frame.
 *
 * `hud: false` on all of them. A screenshot in a README is a photograph of a
 * world, not of an interface.
 *
 * Captured by `node tools/screenshots.mjs`, which writes `screenshots/` at
 * 2560x1440 and regenerates its index. They are not part of the review set and
 * critics are never shown them — judging your own marketing frames is how you
 * end up believing them.
 */
const MARKETING_SHOTS = {
  mkt_skyline: {
    pos: [-528, 62, 470], look: [-236, 44, 44], fov: 48, time: 19.35, ground: true,
    weather: 'scattered', viewmodel: false, hud: false, marketing: true,
    doc: 'THE signature composition — downtown read from the Mt. Washington clifftop across the Monongahela at golden hour, with the cliff edge as foreground.',
  },
  mkt_bridge_dusk: {
    // Reuses the review 'bridge' framing, which is known to actually contain a
    // bridge. My first authored guess did not: absolute coordinates picked from
    // the map put the lens somewhere with no bridge in it at all, which is the
    // same mistake this file has now made four times. Reuse a framing that has
    // been LOOKED AT; change only the light.
    pos: [-64, 12, -328], look: [-300, 20, -120], fov: 60, time: 20.2, ground: true,
    weather: 'overcast', viewmodel: false, hud: false, marketing: true,
    doc: 'A river crossing at last light — the forty-bridges idea in one frame, steel against a wet sky.',
  },
  mkt_mill_night: {
    pos: [790, 18, 300], look: [880, 52, 250], fov: 55, time: 21.6, ground: true,
    weather: 'fog', viewmodel: false, hud: false, marketing: true,
    doc: 'The Old Blast Furnace at night in river fog — slag orange against cold steel, the thematic heart of a rustbelt city.',
  },
  mkt_rain_street: {
    pos: [-232, 5, 132], look: [-232, 12, -30], fov: 62, time: 20.4, ground: true,
    onRoad: { near: [-232, 64], eye: 1.62, aheadM: 34 },
    clearTraffic: 0, weather: 'storm', viewmodel: false, hud: false, marketing: true,
    // Eye-level lens (1.62 m), so a close mark still frames him head to foot.
    player: { dist: 7, state: 'idle' },
    doc: 'Downtown in a storm at eye level with a brother walking it — wet asphalt, lit windows, traffic left in deliberately because a living street is the point.',
  },
  mkt_incline: {
    /**
     * SAME LENS POSITION, LOWER AIM — the smallest change that puts the FOOT of
     * the hillside tower in the picture.
     *
     * `buildings` asked for a frame that shows a terraced foundation apron
     * (`archetypes.js:buildTerrace`), on the grounds that no shot in the set
     * has one, and this is the shot with the hillside tower in it. The old aim
     * (`look` y +62, fov 54) put the tower's base at NDC y -0.86 — 49 px off
     * the bottom edge at 720p — and the funicular's lower station at -1.06,
     * i.e. out of frame entirely. Both are now in: MEASURED at 1280x720 with
     * the new aim, the tower foot lands at -0.37 and the lower station at
     * -0.44, and the second car standing at that station is in the photograph
     * for the first time.
     *
     * WHAT IT CANNOT SHOW, and this is the honest half. I measured every lot
     * within 300 m through `world.lots` + `world.heightAt` — the apron is
     * revealed exactly as far as the ground falls away from the lot's own pad,
     * so the fall IS the exposure. The tower's lot falls -0.7 m (its pad is at
     * 8.2 and the lowest ground just outside its footprint is 8.4): its apron
     * is entirely under the pavement, which is `buildTerrace`'s documented
     * "correct when it is buried" case rather than a defect. What this frame
     * does carry is the riverside blocks under the bluff, which fall 3.1-4.4 m
     * (lots 3, 5, 6) — a base band of about 16 px at 190 m. The deep aprons in
     * this quarter are under the Mt. Washington houses (up to 17.8 m of fall,
     * at (-268, 556)), which is behind this lens and wants a shot of its own.
     *
     * `ground: true`, so `look` y is metres ABOVE the terrain at the aim point
     * — 38 over the 12 m bench the tower stands on.
     */
    pos: [-424, 46, 458], look: [-540, 38, 350], fov: 50, time: 7.1, ground: true,
    weather: 'fog', viewmodel: false, hud: false, marketing: true,
    doc: 'The Duquesne Incline climbing Mt. Washington out of dawn river fog — both cars on the trestle, one of them standing at the lower station, the hillside tower rooted beside it and the city on the far bank.',
  },
  mkt_searchlight: {
    // Same base and the same frameBeam parameters as the review
    // 'searchlight_side' shot, which I verified by eye shows a soft-edged shaft
    // with real falloff. My marketing variant used a different base pose, and
    // because frameBeam derives the camera from where the helicopter was
    // STAGED, a different base put the lens flat against a wall.
    pos: [-190, 7, 120], look: [-250, 12, 40], fov: 60, time: 21.35, ground: true,
    weather: 'overcast', viewmodel: false, hud: false, marketing: true,
    apply: (e) => frameBeam(e, { stand: 72, aimUp: 0.5 }),
    doc: 'A police helicopter searchlight sweeping a street at night — the wanted system as a photograph.',
  },
  mkt_point: {
    /**
     * RE-COMPOSED FROM DOWNSTREAM, AND THE FOG IS GONE. Both are answers to a
     * gallery pass that read the old frame as "a thick haze volume swallows the
     * middle of the frame, so the confluence the caption promises is not
     * legible", with "a shelf of detached blue building slabs floating" in the
     * top-right corner.
     *
     * THE FOG WAS PINNED, not weather the hour brought. The shot declared
     * `weather: 'fog'` at 06:54 and `__APPLY_SHOT__` snaps that state
     * immediately — so the frame was a dawn haze volume laid over a 400 m
     * sightline, and the confluence sat inside it. `dawnfog`, the review shot
     * that is ABOUT fog, pins no weather at all and takes what the sky's own
     * clock gives it; this one now does the same and pins `clear`, because a
     * shot whose single job is "where three rivers meet" cannot also be the
     * volumetrics test.
     *
     * THE VIEWPOINT IS FROM THE OHIO, LOOKING BACK UP THE CONFLUENCE. The old
     * pose was 250 m up over the south-west bank looking north-east, which put
     * the Point ACROSS the frame (so the wedge reads as a coastline) and left
     * the far North Shore in the top-right corner, which is where the detached
     * far-LOD slabs live. Standing downstream at 115 m — 400 m off the tip,
     * `world/plan.js` puts the fountain at (-452, 46) and `preview.js` the
     * confluence at (-600, 40) — puts the Ohio in the near field, the fountain
     * and its plaza dead centre, a bridge over each incoming channel, and the
     * Golden Triangle standing behind the whole thing. MEASURED at 1280x720:
     * the frame's top edge sits just above the tallest tower, so the corner the
     * pass complained about is not in the picture, and what horizon does remain
     * is behind the skyline and reads as aerial perspective.
     *
     * The detached far-LOD slabs themselves are NOT fixed here — they are a
     * `buildings`/LOD defect and are filed as one. This frames around them.
     */
    pos: [-880, 115, 45], look: [-470, 22, 45], fov: 48, time: 18.9,
    weather: 'clear', viewmodel: false, hud: false, marketing: true,
    doc: 'The Point from over the Ohio at golden hour, where three rivers meet — the Allegheny and the Monongahela closing on the fountain from either side of the plaza, a bridge on each, and the Golden Triangle behind it. Clear, because the confluence has to be legible; this set already has three frames of weather.',
  },
  mkt_kessel: {
    // Dylan's car, asked for by name. Framed like a press shot: three-quarter
    // front, low, on a real street rather than a turntable.
    pos: [-232, 6, 96], look: [-232, 5, 60], fov: 52, time: 18.9, ground: true,
    onRoad: { near: [-232, 64], eye: 1.35, aheadM: 8, side: 5.2 },
    clearTraffic: 26, weather: 'overcast', viewmodel: false, hud: false, marketing: true,
    // REAR three-quarter, slightly above — the angle the reference photo uses,
    // and the only one that shows what makes this car itself: the unbroken
    // roofline sweeping into a short deck, and the full-width tail bar. A front
    // three-quarter reads as a generic wedge, which is what my first cut looked
    // like.
    apply: (e) => frameVehicle(e, 'kessel', { dist: 10.5, height: 2.6, swing: 2.42, aimY: 0.85 }),
    doc: `Dylan's Kessel GT — a front-drive fastback, three-quarter front at dusk.`,
  },
  mkt_hero: {
    pos: [-232, 6, 150], look: [-232, 24, -40], fov: 62, time: 17.4, ground: true,
    onRoad: { near: [-232, 64], eye: 5.5, aheadM: 55 },
    clearTraffic: 0, viewmodel: false, hud: false, marketing: true,
    // Box art with nobody in it is a photograph of a road. Same 18 m mark as the
    // review `hero` it shares a pose with, so the two stay comparable.
    player: { dist: 18, state: 'idle' },
    doc: 'A Golden Triangle avenue in clear afternoon light with a brother in it — the one bright frame, and the closest thing to a box-art shot.',
  },

  /* ---- wave two: the verbs — fly, fight, chase, drive, and the water ---- */

  mkt_afb: {
    // The pre-pose only has to put the streaming camera on the right side of
    // the map; `frameRow` then composes on the jets that are actually parked.
    pos: [-330, 10, -1380], look: [-520, 12, -1330], fov: 52, time: 18.7, ground: true,
    weather: 'scattered', viewmodel: false, hud: false, marketing: true, airbase: true,
    // REVERSED, and that is a lighting decision. The stands run east-west and
    // the golden-hour sun sits at the west end of them: shot down the row from
    // the east the whole frame is a flare with three black jets in it (drafted,
    // measured by eye, discarded). From the WEST end the same row is front-lit,
    // the sun is behind the lens, and the hangar band is the far side of the
    // apron rather than a silhouette. With the list reversed the row direction
    // flips too, so `side` is now POSITIVE toward the taxiway.
    apply: (e) => frameRow(e, airbaseCast(e).jets.slice().reverse(), { back: 23, side: 12, eye: 6.8, aim: 1, aimUp: 2.6, aimBias: -26 }),
    noCrowd: true,
    shutter: (e) => e.ctx.peek('peds')?.debugStage?.('none'),
    doc: 'Ridgeline AFB at golden hour, from the west end of the flightline — a parked jet in the near field, the rest of the row and the armour stands behind it, the hangar band, the tower and the city on the horizon. The assault encounter is held in its published inert state so this is the base, not the firefight.',
  },
  mkt_flight: {
    pos: [-26, 192, 380], look: [-560, 90, 60], fov: 54, time: 17.3,
    weather: 'scattered', viewmodel: false, hud: false, marketing: true, stagesKinematic: true,
    apply: (e) => {
      // Down the Monongahela toward the confluence at (-600, 40): the one
      // heading that puts all three rivers, the Point and the Golden Triangle
      // in the same frame with bridges under the wing.
      const v = stageKinematic(e, { type: 'twinplane', at: [-44, 234, 364], yaw: -2.21, pitch: 0.02, roll: -0.17 });
      // A cruising twin with two dead props is a glider. See `spoolStaged`.
      spoolStaged(e, v);
      frameAircraft(e, v, { dist: 19, up: 4.2, side: -9, aimAhead: 105, aimY: -42 });
    },
    doc: 'A Meridian twin at 234 m over the Monongahela, gently banked and heading for the confluence — the Point, the bridges and the Golden Triangle underneath it, and both propellers turned into discs. The flyable half of the game, from outside the cockpit.',
  },
  mkt_heli: {
    pos: [-400, 210, -92], look: [-232, 96, 60], fov: 56, time: 19.7,
    weather: 'scattered', viewmodel: false, hud: false, marketing: true, stagesKinematic: true,
    apply: (e) => {
      const v = stageKinematic(e, { type: 'newsheli', at: [-380, 205, -70], yaw: 0.834, pitch: -0.04, roll: 0.15 });
      /**
       * A banked helicopter with a parked disc is a model on a stand — and one
       * spun at its REAL rate over the shutter's 32-frame exposure is a
       * helicopter with no blades at all, which is how a gallery pass read this
       * frame. `spoolStaged`'s `shutterDt` note has the measurement; 1/3600
       * sweeps the disc about 20 degrees across the exposure, which is a
       * blurred arc rather than either a cross or a wash.
       */
      spoolStaged(e, v, { shutterDt: 1 / 3600 });
      /**
       * LENS ON THE DISC'S OWN LEVEL (`up: 0.6`, was 3.4). A blade is a thin
       * dark shape at ~20% opacity, and over the dark city it stays invisible
       * whatever the spool rate does — MEASURED side by side at 1280x720, same
       * `shutterDt`, camera 3.4 m above the machine versus level with it. The
       * disc has to be read against the SKY, so the lens sits on the rotor's
       * plane and the aim drops further (`aimY: -30`) to keep the rivers, the
       * bridges and the Triangle underneath it.
       */
      frameAircraft(e, v, { dist: 15, up: 0.6, side: 6, aimAhead: 80, aimY: -30 });
    },
    doc: 'The Skywatch news helicopter over downtown at dusk, banking toward the Triangle — the lens on the rotor plane so the disc reads as a turning blur against the sky, with the Mon, its bridges and the skyline under it. Deliberately not the police searchlight: this is the city at height, not the wanted system.',
  },
  mkt_tanks: {
    pos: [-330, 10, -1330], look: [-520, 12, -1300], fov: 60, time: 6.9, ground: true,
    weather: 'fog', viewmodel: false, hud: false, marketing: true, airbase: true,
    apply: (e) => frameRow(e, airbaseCast(e).tanks, { back: 8, side: -6.2, eye: 1.1, aim: 1, aimUp: 0.9, aimBias: 14 }),
    // No civilians inside the wire. See `shutter` / `noCrowd` in `shotChrome`.
    noCrowd: true,
    shutter: (e) => e.ctx.peek('peds')?.debugStage?.('none'),
    doc: 'A Bulwark on the Ridgeline apron at dawn, lens at gun height and eight metres off its front quarter — the barrel rakes the frame, the next tank in the row sits under it, the hangar band is behind. Low and close because armour photographed from standing height is a shed.',
  },
  mkt_boyzcars: {
    pos: [632, 6, -464], look: [644, 5, -492], fov: 54, time: 18.3, ground: true,
    onRoad: { near: [632, -464], eye: 1.6, aheadM: 26 },
    clearTraffic: 30, weather: 'clear', viewmodel: false, hud: false, marketing: true, stagesCars: true,
    /*
     * NO CROWD, and the reason is the harness rather than taste. `peds`
     * composes its ambient population around the PLAYER, and every shot
     * teleports the player onto its own camera — so a street-level marketing
     * frame gets the crowd built around the lens. MEASURED here: a pedestrian
     * standing 2 m in front of the camera, filling a third of the frame and
     * covering the middle car. The three hero cars are the subject; the living
     * street is `mkt_rain_street`'s job, and that shot keeps its traffic.
     */
    noCrowd: true,
    shutter: (e) => e.ctx.peek('peds')?.debugStage?.('none'),
    /**
     * CLOSER AND AIMED HIGHER (`dist` 9.8 -> 8.8, `aimY` 0.95 -> 1.8, `fov` 58
     * -> 54). The old lens was near level with its own aim, so the frame's
     * bottom edge fell on tarmac 2.8 m in front of the camera and the near 46%
     * of the picture was empty forecourt — the exact "featureless flat ground
     * plane" the marketing rules at the top of this block exist to forbid.
     * Tilting the lens up moves the bottom edge OUT along the road (MEASURED at
     * 1280x720: the empty band goes from 46% of frame height to 32%, with the
     * shopfronts and the trees behind the cars filling what it gave up), and
     * the shorter lens puts the three of them across the frame instead of
     * leaving room either side.
     *
     * The colours are `frameBoyzCars`/`BOYZ_PAINT`, not the pool roll.
     */
    apply: (e) => frameBoyzCars(e, { ahead: 24, offset: 2.5, spread: 3.5, splay: 0.5, depth: 1.8, dist: 8.8, eye: 1.72, swing: -0.24, aimY: 1.8 }),
    doc: `The three brothers' own cars together at the DeCarlo Body Shop in late light — Carson's teal SUV, Aidan's burnt-orange pickup and Dylan's violet Kessel fastback, each in its owner's own colour from the character set. Hero classes that never appear in traffic, so this is the only frame in the set that can have all three in it.`,
  },
  mkt_chase: {
    // Same anchor as the review `pursuit` shot, which was MEASURED as the one
    // place on this avenue where all four cruisers stage inside a lane width
    // of the quarry's own line. NO `clearTraffic`: the pre-shutter sweep would
    // despawn the entire frozen tableau.
    pos: [-232, 5, 150], look: [-232, 12, -40], fov: 48, time: 21.3, ground: true,
    onRoad: { near: [-232, 124], eye: 1.35, aheadM: 46 },
    weather: 'storm', viewmodel: false, hud: false, marketing: true, pursuitShot: true,
    apply: (e) => framePursuit(e, { dist: 9.5, side: 2.6, eye: 1.2, aimAhead: 30, aimY: 2.2 }, SHOTS.mkt_chase),
    doc: 'A three-star pursuit in the rain — the fleeing car in the near field and four lit lightbars stacked up the avenue behind it. Wet asphalt doubles every strobe.',
  },
  mkt_boat: {
    /**
     * 16:36, NOT 19:12 — THE HOUR IS WHAT MODELS THE HULL.
     *
     * A gallery pass read the old frame as "the Riverjack is a near-black
     * silhouette cropped by the bottom edge". Both halves were the same
     * mistake, and the light half is not fixable by exposure. This composition
     * hangs on the Golden Triangle being BEHIND the boat, and downtown is north
     * of this reach of the Monongahela, so the lens necessarily looks north —
     * MEASURED off `sky.sunDirection` across the clock, the sun is at azimuth
     * -105 degrees and 8 degrees up at 19:12, i.e. low, ahead and to the left,
     * with the camera-facing side of the hull in its own shadow and the sun
     * itself in the corner of the frame dragging the exposure down. There is no
     * evening hour that front-lights a north-facing subject.
     *
     * At 16:36 the sun is 35 degrees up and behind the lens's left shoulder:
     * the deck, the seats, the console and the port sheer are all lit, the hull
     * keeps a shadow side so it still reads as a solid, and the city's south
     * faces — the ones we can see — are lit rather than rimmed. Warm enough to
     * belong in this set; three other frames already own last light.
     *
     * AND THE FRAME IS OFF THE STERN QUARTER, FROM ABOVE. `aimPast: 55, aimY:
     * 11` aimed 55 m past the boat and 11 m up — the lens was pointed at the
     * skyline and the boat was whatever happened to be under the bottom edge.
     * Aiming 5 m past it from 3.3 m up puts the whole hull inside the frame
     * with water all round it and enough down-angle to read the deck, which is
     * the thing that says this is a boat you get into.
     *
     * Mid-channel on the Monongahela: the river's own published polyline runs
     * (-32, 344) -> (-336, 184), and this is a point on it, 200 m off the
     * Golden Triangle. Nose turned up-river toward the confluence.
     */
    pos: [-150, 6, 300], look: [-240, 20, 90], fov: 52, time: 16.6,
    weather: 'scattered', viewmodel: false, hud: false, marketing: true, stagesKinematic: true,
    apply: (e) => frameBoat(e, {
      at: [-191, 0.2, 260], yaw: -1.35, toward: [-236, 60],
      dist: 9.2, eye: 3.3, side: -6, aimPast: 5, aimY: 1.6,
    }),
    doc: 'A Riverjack mid-channel on the Monongahela in late-afternoon light, a three-quarter from above the stern with the Golden Triangle 200 m off its bow — the hull modelled rather than silhouetted, the deck readable. The water half of the game, and Carson’s half of the story.',
  },
  /* ---- wave three: what the city SAYS ---- */

  mkt_butler: {
    // The pre-pose only has to put the streaming camera on the right block;
    // `frameFrontage` composes on the frontage the body shop actually stands on.
    pos: [632, 6, -464], look: [660, 8, -500], fov: 44, time: 19.75, ground: true,
    clearTraffic: 24, weather: 'clear', viewmodel: false, hud: false, marketing: true,
    // 19.75 IS A MEASUREMENT, not a mood. `props._driveLights` runs every
    // emissive in the sign kit off the sun with
    // `mix = 1 - clamp((sunAltitude + 0.05) / 0.19)`, and a sweep of the sky
    // clock puts sunset at 19.75 and full lit at 20.25. At 19.75 the mix is
    // 0.73 — the fascias, the channel letters and the shop windows are lit
    // while the sun is still on the brick and there is colour left in the sky.
    // Half an hour later (20.05, drafted and discarded) the mix is 0.97 and the
    // frame is a dark street with bright signs on it, which is a night shot and
    // is the one this set already has three of.
    /**
     * AIDAN, because this is his street: the body shop is his safehouse and
     * Duke Marrow's crew wants this block. `state: 'idle'` because a shot
     * settles for hundreds of frames and every other state is a scripted input
     * that walks the subject somewhere different each run.
     *
     * `dist` is the FALLBACK mark. The real one is resolved by `frameFrontage`
     * onto the pavement in front of the shopfront and written to
     * `player.at` — `dist` only applies if that helper bails, in which case 11 m
     * down the pre-pose's own axis is still a man in a street rather than a face
     * against the lens.
     *
     * `brother` persists after the shot: `setBrother` rebuilds the body and
     * nothing puts it back. Harmless as captured — `tools/screenshots.mjs` runs
     * every shot in its own browser process — but a hand-driven session that
     * applies this and then another `player:` shot will photograph Aidan in it.
     */
    player: { dist: 11, state: 'idle', brother: 'aidan' },
    /*
     * NO CROWD, for the reason `mkt_boyzcars` documents: `peds` composes its
     * ambient population around the PLAYER and every shot teleports the player
     * onto its own camera, so a street-level frame gets the crowd built around
     * the lens. MEASURED on two drafts of this shot: a pedestrian's head filled
     * the left third of the picture in both, at a different place each time.
     * The life in this frame is Aidan, staged on a mark.
     */
    noCrowd: true,
    shutter: (e) => e.ctx.peek('peds')?.debugStage?.('none'),
    apply: (e) => frameFrontage(e, {
      near: [632, -464], back: 22, out: 17, eye: 1.62,
      aimAhead: 0, aimOut: 5, aimY: 4.4, markAhead: 12, markSide: 1.5,
    }, SHOTS.mkt_butler),
    doc: 'Butler Street at lighting-up time — Aidan on the pavement outside his own body shop, its fascia lit, the frontage running away down the block. The signage system as a photograph: shop names in real type, channel letters, lit windows.',
  },
  mkt_fountain: {
    pos: [-408, 4.5, 64], look: [-452, 12, 46], fov: 50, time: 16.8, ground: true,
    weather: 'scattered', viewmodel: false, hud: false, marketing: true,
    doc: 'The Point fountain in late afternoon from the plaza east of it — the plume centred, the basin and its crowd in the near field, and the confluence with the West End crossing behind. Judge the jet: it should read as water, not as a smoke column.',
  },
};

Object.assign(SHOTS, STEEL_CITY_SHOTS, MARKETING_SHOTS);

/** Shot ids flagged `marketing: true` — what `tools/screenshots.mjs` captures. */
export const MARKETING_IDS = Object.keys(MARKETING_SHOTS);

export function installShotApi(engine, { capture, lockstep = false } = {}) {
  window.__SHOTS__ = SHOTS;
  // Which shot was applied last, so the capture harness can re-pin that shot's
  // authored time-of-day at the shutter without being told it a second time.
  window.__LAST_SHOT__ = null;

  /**
   * `opts.grabFrame` is how many frames the harness will pump before it presses
   * the shutter. Shots whose subject is a transient (a muzzle flash lives ~52 ms)
   * need it so they can land the event on the captured frame instead of guessing.
   */
  window.__APPLY_SHOT__ = (name, opts = {}) => {
    // An inline shot: any agent can frame an arbitrary camera without editing
    // this file (which the lead owns). Pass JSON as the shot name, e.g.
    //   node tools/capture.mjs --shot='{"pos":[10,3,20],"look":[0,2,0],"time":19}'
    let shot;
    if (typeof name === 'string' && name.trim().startsWith('{')) {
      try {
        shot = JSON.parse(name);
      } catch (e) {
        return { error: `inline shot is not valid JSON: ${e.message}` };
      }
      if (!Array.isArray(shot.pos) || !Array.isArray(shot.look)) {
        return { error: 'inline shot needs pos:[x,y,z] and look:[x,y,z]' };
      }
    } else {
      shot = SHOTS[name];
    }
    if (!shot) return { error: `unknown shot "${name}"`, available: Object.keys(SHOTS) };

    // Re-arm the settle predicate: the streaming curve it measures restarts at
    // this teleport. Before the early-returning `onRoad` branch, so both apply
    // paths get it — see `resetSettle`.
    resetSettle();

    // Freeze live input and hand the camera to the shot.
    engine.input.frozen = true;
    engine.input.enabled = false;
    const player = engine.ctx.peek('player');
    player?.setControlEnabled?.(false);

    const cam = engine.camera;
    cam.position.fromArray(shot.pos);
    const target = new THREE.Vector3().fromArray(shot.look);

    // `ground: true` treats the y components as heights ABOVE the terrain, so a
    // shot stays correctly framed while `world` is still reshaping its
    // heightfield. Falls back to absolute y if the world can't answer yet.
    // Installed BEFORE the `onRoad` branch, which returns early — putting this
    // after it meant every road-framed shot (i.e. every street-level review
    // shot) silently skipped it, which is why `detail` still photographed a
    // pile-up after `clearTraffic` was added to it.
    //
    // `capture.mjs` calls this again immediately before the shutter, because a
    // shot settles for ~1300 frames and traffic repopulates and crashes during
    // them. `peds` measured `--shot=hero` at 5693 draws / 16.3 M tris of cars
    // filling the frame — unusable for judging anything.
    window.__LAST_SHOT__ = name;
    window.__PRESHUTTER__ = shot.clearTraffic
      ? () => {
          const veh = engine.ctx.peek('vehicles');
          const pl = engine.ctx.peek('player');
          const mine = pl?.vehicle ?? pl?.currentVehicle ?? null;
          const r2 = shot.clearTraffic * shot.clearTraffic;
          const cp = engine.camera.position;
          let n = 0;
          if (veh?.vehicles?.length) {
            for (const v of veh.vehicles.slice()) {
              if (v === mine || v?._staged) continue;
              const dx = v.position.x - cp.x;
              const dz = v.position.z - cp.z;
              if (dx * dx + dz * dz >= r2) continue;

              // ONLY the wrecks and the stalled. Clearing ALL nearby traffic
              // was over-correction: it was added when a scratch-vector alias in
              // `traffic` spawned every car AT THE CAMERA and pile-ups filled
              // the lens. That bug is fixed (write-offs 0-5/min, big impacts
              // 36/min), and blanket-clearing then emptied the city for reviews
              // — a critic panel duly reported "a four-lane road at 15:00 with
              // zero vehicles on it", which was the harness, not the game.
              // Moving traffic is exactly what a street frame is supposed to
              // show.
              const stalled = (v.speed ?? 0) < 0.6;
              if (!v.destroyed && !stalled) continue;
              veh.despawn(v);
              n++;
            }
          }
          return n;
        }
      : null;

    /*
     * Re-apply the chrome suppression AT THE SHUTTER, not only at apply time.
     *
     * Setting `viewScene.visible = false` when the shot is applied is not
     * enough: the shot then settles for tens to hundreds of frames, and the
     * viewmodel came back every time. Whatever restores it — a camera-mode
     * update, a weapon pose refresh — runs during that settle, so the flag has
     * to be re-asserted on the last frame before the capture rather than the
     * first. Same for the zone toast, which the settle can re-trigger.
     *
     * Chained rather than replacing `__PRESHUTTER__`, so `clearTraffic` still
     * runs where a shot asks for it.
     */
    const prevShutter = window.__PRESHUTTER__;
    window.__PRESHUTTER__ = () => {
      const n = prevShutter ? prevShutter() : 0;
      shotChrome(engine, shot);
      return n;
    };
    window.__PRESHUTTER__?.();

    // `onRoad: { near:[x,z], eye, ahead }` snaps the shot onto the nearest lane
    // of the real road graph and aims it down the street.
    //
    // Hardcoded street coordinates do not survive a procedural city that is
    // still being regenerated: the first hero shots put the camera inside a
    // building and the critics spent their review on a wall two metres from the
    // lens. Resolving the framing from `world.roads` at apply time means a
    // street shot always frames an actual street, whatever the generator did.
    if (shot.onRoad) {
      const w = engine.ctx.peek('world');
      const roads = w?.roads;
      const [nx, nz] = shot.onRoad.near ?? [cam.position.x, cam.position.z];
      const hit = roads?.nearestEdge?.(nx, nz);
      if (hit?.edge != null && roads.laneCenter) {
        const eye = shot.onRoad.eye ?? 5.5;
        // `ahead` is a FRACTION of the edge, which is unpredictable because edge
        // lengths vary from an alley stub to a highway span — the `detail` shot
        // asked for 0.02 and got a camera 1.21 m from a wall, which a critic
        // panel then reported as "a windowless stucco slab" and "windows have no
        // reveal anywhere in the build". Both findings were my framing, not the
        // geometry. `aheadM` says how far to look in METRES and converts.
        let ahead = shot.onRoad.ahead ?? 0.22;
        if (shot.onRoad.aheadM != null) {
          const a = new THREE.Vector3();
          const b = new THREE.Vector3();
          roads.laneCenter(hit.edge.id ?? hit.edge, 0, 0, a);
          roads.laneCenter(hit.edge.id ?? hit.edge, 0, 1, b);
          const len = a.distanceTo(b);
          ahead = len > 1 ? THREE.MathUtils.clamp(shot.onRoad.aheadM / len, 0.01, 0.9) : 0.22;
        }
        const t = typeof hit.t === 'number' ? hit.t : 0.5;
        const lane = hit.lane ?? 0;
        const a = new THREE.Vector3();
        const b = new THREE.Vector3();
        roads.laneCenter(hit.edge.id ?? hit.edge, lane, THREE.MathUtils.clamp(t, 0, 1), a);
        roads.laneCenter(hit.edge.id ?? hit.edge, lane, THREE.MathUtils.clamp(t + ahead, 0, 1), b);
        // Degenerate parameterisation (a very short edge) would aim the camera
        // at its own position; fall back to the authored look target.
        if (a.distanceToSquared(b) > 1) {
          // `side` steps the camera perpendicular off the carriageway onto the
          // pavement. Standing on a live lane means traffic drives through the
          // lens: `render` measured a car occupying the frame in 3 of 8 shot-set
          // captures, which made two review rounds unusable for measurement.
          let sx = 0, sz = 0;
          if (shot.onRoad.side) {
            const dx = b.x - a.x, dz = b.z - a.z;
            const l = Math.hypot(dx, dz) || 1;
            sx = (-dz / l) * shot.onRoad.side;
            sz = (dx / l) * shot.onRoad.side;
          }
          cam.position.set(a.x + sx, a.y + eye, a.z + sz);
          target.set(b.x + sx, b.y + eye * 0.55, b.z + sz);
          cam.lookAt(target);
          if (shot.fov) { cam.fov = shot.fov; cam.updateProjectionMatrix(); }
          player?.teleport?.(cam.position, cam.rotation);
          engine.ctx.peek('weapons')?.debugPose?.('idle');
          engine.ctx.peek('fx')?.debugBurst?.('none');
          engine.ctx.peek('ui')?.debugState?.('clean');
          if (shot.time !== undefined) engine.ctx.peek('sky')?.setTimeOfDay?.(shot.time);
          const sky0 = engine.ctx.peek('sky');
          sky0?.setWeather?.(shot.weather ?? 'clear', { immediate: true });
          engine.__shotCam = null;
          shotChrome(engine, shot);
          shot.apply?.(engine, opts);
          engine.events.emit('shot:applied', { name, shot });
          return { applied: name, pos: cam.position.toArray(), onRoad: true, fov: shot.fov ?? engine.config.fov };
        }
      }
    }

    if (shot.ground) {
      const w = engine.ctx.peek('world');
      const h = w?.heightAt ?? w?.groundHeight;
      if (h) {
        cam.position.y += h.call(w, cam.position.x, cam.position.z) ?? 0;
        target.y += h.call(w, target.x, target.z) ?? 0;
      }
    }
    cam.lookAt(target);
    if (shot.fov) {
      cam.fov = shot.fov;
      cam.updateProjectionMatrix();
    }
    // Keep the player capsule under the camera so gameplay systems stay coherent.
    player?.teleport?.(cam.position, cam.rotation);

    // Shots are applied back to back in one browser session, so clear the
    // previous shot's *looping* debug state first. Without this the `muzzle`
    // shot's scripted burst is still emptying the magazine during `combat`, and
    // `impacts` keeps walking rounds across a wall behind the HUD shot.
    engine.ctx.peek('weapons')?.debugPose?.('idle');
    engine.ctx.peek('fx')?.debugBurst?.('none');
    engine.ctx.peek('ui')?.debugState?.('clean');

    shotChrome(engine, shot);

    // `clearTraffic: <metres>` empties the immediate area of AI vehicles. A
    // material/detail shot is about the surface, and a wrecked traffic car
    // parked across the lens has repeatedly cost a review round — one critic
    // panel judged "the detail shot" and was actually judging a van.
    if (shot.time !== undefined) engine.ctx.peek('sky')?.setTimeOfDay?.(shot.time);
    // Weather shots snap straight to the target state — the live system blends
    // over minutes, which a 90-frame capture would never reach.
    const sky = engine.ctx.peek('sky');
    if (shot.weather) sky?.setWeather?.(shot.weather, { immediate: true });
    else sky?.setWeather?.('clear', { immediate: true });
    shot.apply?.(engine, opts);

    engine.events.emit('shot:applied', { name, shot });
    return { applied: name, pos: shot.pos, fov: shot.fov ?? engine.config.fov };
  };

  if (capture) {
    engine.input.frozen = true;
    // Fixed timestep in capture mode so temporal effects converge identically.
    //
    // `this._last = fake` before each step forces rawDt to be EXACTLY 1000/60 on
    // every frame including the first, whatever else touched `_last` (Engine.start
    // and prewarm both assign performance.now() to it). Without that, frame 1's dt
    // was 0 whenever `_last` had been stamped with a real clock and 1/60 when it
    // had not — a boot-path-dependent one-frame difference in every accumulator.
    let fake = 0;
    engine.step = ((orig) =>
      function () {
        this._last = fake;
        fake += 1000 / 60;
        // BEFORE the frame, not after: `syncTransforms` runs inside this step
        // and is what copies `rotorPhase` onto the rotor pivots, so a phase
        // written afterwards is a phase the frame did not draw.
        tickStagedSpool(this);
        return orig.call(this, fake);
      })(engine.step);
  }

  /**
   * Streaming settle probe, polled by tools/capture.mjs before the shutter.
   *
   * A shot teleports the camera kilometres across a STREAMED city, so the tiles
   * around the new position have not been built yet and the amortised job queue
   * needs many frames to catch up. Capturing on a fixed frame count would
   * photograph a half-built city and hand critics a page of defects that are
   * really just "you took the picture too early".
   *
   * Returns true when `world` reports its build queue drained. Systems that
   * have not implemented `streamingIdle()` are treated as idle so this can
   * never deadlock a capture.
   */
  /*
   * SETTLED means THE PICTURE HAS STOPPED CHANGING — not that one subsystem
   * says its queue is empty.
   *
   * This used to return `world.streamingIdle()` alone. But `buildings`, `props`,
   * `peds` and `traffic` all stream in too, on their own schedules, so the
   * predicate reported "settled" while a quarter of the city was still
   * arriving. MEASURED across three captures of one shot, all three reporting
   * settled:true at 153-158 frames:
   *
   *     draw calls   2959 / 4074 / 4096
   *     triangles    8.26M / 10.94M / 10.96M
   *
   * Same seed, same shot, same tree — a 28% difference in how much city was in
   * the photograph. That is why the pixel gate was unusable: an agent measured a
   * 1.54% noise floor on one same-tree pair and 81.7% on the next, and correctly
   * threw away their own before/after result as meaningless.
   *
   * So ask the RENDERER, which is the thing the shutter actually photographs:
   * draw calls and triangle count unchanged for STABLE_FRAMES consecutive
   * frames. That is rule 12 — assert against the emitted artefact, not against
   * an intermediate flag owned by one of several contributors.
   *
   * `streamingIdle` is kept as a cheap necessary condition so we do not declare
   * stability during a lull in an amortised build queue.
   */
  const RING = 8;
  const _ring = new Array(RING).fill(0);
  const _ringT = new Array(RING).fill(0);
  let _settleFrame = 0;
  let _stableFor = 0;
  let _lastCalls = -1;
  let _lastTris = -1;
  /**
   * Engine frame at which the CURRENT shot was applied. Everything the settle
   * predicate measures is relative to this, never to `engine.time.frame`.
   *
   * THE BUG THIS EXISTS FOR. `MIN_FRAMES` is a knee-clearing minimum for the
   * streaming curve that starts at the TELEPORT — but the predicate read the
   * free-running engine counter, which does not restart between shots. So in
   * any session that applies more than one shot (`skyprobe`, `shotprobe`, every
   * review sweep, `tools/screenshots.mjs` if it ever batches) the test
   * `engineFrame >= 240` was already true on the first poll after the second
   * teleport, and the `streamingIdle` veto above it — gated on the same
   * comparison — never ran at all. Shot 2 onwards could therefore settle on a
   * few consecutive polls of an EMPTY frame's draw count, which is exactly the
   * shape of `mkt_hero` shipping without a lamp, a tree or a bin in it while
   * `hero` at the same pose has all three.
   *
   * Zero until the first shot is applied, so a harness that never applies one
   * (`playtest --quick`) sees precisely the old behaviour.
   */
  let _shotFrame = 0;
  /** Re-arm the settle predicate. Called on every apply, on both apply paths. */
  function resetSettle() {
    _shotFrame = engine.time.frame;
    _settleFrame = 0;
    _stableFor = 0;
    _lastCalls = -1;
    _lastTris = -1;
    _ring.fill(0);
    _ringT.fill(0);
  }
  window.__SETTLED__ = () => {
    /*
     * MEASURED trajectory for `hero`, draw calls per frame after the shot is
     * applied:
     *
     *   f0   217      f160 4041      f320 4234      f720 4257
     *   f40  562      f200 4112      f440 4156      f880 4304
     *   f80  2191     f240 4135      f600 4164
     *   f120 3340
     *
     * Almost the whole city arrives in the first ~200 frames, and the old
     * predicate fired at ~f155 — on the steepest part of that curve, where a
     * few frames of timing difference is a thousand draw calls. Past ~f240 it
     * drifts slowly (a few percent over hundreds of frames) with a jitter of
     * about +/-30 from traffic crossing the frustum edge.
     *
     * So: a MINIMUM frame count to clear the knee, then stability within a
     * tolerance wide enough to ignore moving actors but tight enough to catch a
     * subsystem still streaming.
     */
    const MIN_FRAMES = 240;
    // Consecutive CALLS, not frames. The capture driver pumps in chunks and
    // asks once per chunk, so this predicate is polled far less often than the
    // engine steps. Counting calls as if they were frames is a bug I already
    // shipped once here: with a 20-frame chunk, a 240-"frame" minimum silently
    // demanded 4800 real frames and nothing ever settled.
    const STABLE_CHECKS = 3;
    const TOL = 0.02;

    _settleFrame++;
    // Frames since THIS shot's teleport — see `_shotFrame`. The streaming curve
    // the numbers above describe restarts at every apply, so the free-running
    // engine counter is the wrong clock and silently retires the veto below.
    const sinceShot = engine.time.frame - _shotFrame;
    // `streamingIdle` is a NECESSARY condition early on, but it flickers — it
    // reports a lull in an amortised queue, not completion — so past the knee it
    // is allowed to stop vetoing. Letting it reset the stability counter forever
    // is why this predicate never fired at all and every capture burned the
    // whole 1200-frame budget.
    if (sinceShot < MIN_FRAMES) {
      const w0 = engine.ctx.peek('world');
      if (w0 && typeof w0.streamingIdle === 'function') {
        try { if (w0.streamingIdle() !== true) _stableFor = 0; } catch { /* ignore */ }
      }
    }
    const info = engine.ctx.peek('render')?.renderer?.info;
    if (!info) return true; // nothing to measure — do not hang the harness

    /*
     * OUTSIDE CAPTURE MODE, DO NOT DEMAND PIXEL-GRADE STABILITY.
     *
     * The strict test below exists so a screenshot is reproducible. `playtest`
     * and the other in-game harnesses only need "the world is loaded enough to
     * play", and they run the LIVE game config — full traffic, full peds, no
     * lockstep — where draw calls legitimately oscillate 742-1197 (+/-20%)
     * forever. Two separate agents lost time to `playtest --quick` timing out
     * on this predicate after I tightened it, one of them reproducing it with
     * their own changes fully reverted before concluding it was not theirs.
     *
     * A harness gate that blocks unrelated work is a bug in the gate.
     */
    if (!capture) {
      const w1 = engine.ctx.peek('world');
      let idle = true;
      try { idle = !w1?.streamingIdle || w1.streamingIdle() === true; } catch { /* ignore */ }
      return idle && sinceShot >= MIN_FRAMES;
    }

    /*
     * COMPARE WINDOWS, NOT ADJACENT FRAMES.
     *
     * Some passes run on alternate frames, so the per-frame draw count
     * legitimately oscillates. MEASURED over a 700-frame trace on a fully built
     * scene: calls alternate 877 <-> 1178 EVERY frame — a 35% two-frame swing
     * that never settles and never will.
     *
     * My first cut compared frame N against frame N-1 with a 2% tolerance, so it
     * could never be satisfied. Every capture in the project then burned the
     * full 1200-frame budget and printed "world still streaming", and
     * `playtest --quick` timed out waiting on this predicate. That was my bug,
     * and it blocked every other agent's frames — worth stating plainly, because
     * a harness that fails closed is still a harness that fails.
     *
     * The oscillation is periodic, so the MAXIMUM over a window longer than its
     * period is stable once the scene is. Compare window maxima instead.
     */
    _ring[_settleFrame % RING] = info.render.calls;
    _ringT[_settleFrame % RING] = info.render.triangles;
    if (_settleFrame < RING) return false;
    const calls = Math.max(..._ring);
    const tris = Math.max(..._ringT);
    const steady =
      _lastCalls > 0 &&
      Math.abs(calls - _lastCalls) <= Math.max(4, _lastCalls * TOL) &&
      Math.abs(tris - _lastTris) <= Math.max(2000, _lastTris * TOL);
    _lastCalls = calls;
    _lastTris = tris;
    _stableFor = steady ? _stableFor + 1 : 0;
    return sinceShot >= MIN_FRAMES && _stableFor >= STABLE_CHECKS;
  };

  window.__RENDER_INFO__ = null;
  engine.events.on('resize', () => {});
  const snapInfo = () => {
    const r = engine.ctx.peek('render');
    window.__RENDER_INFO__ = {
      frame: engine.time.frame,
      calls: r?.renderer?.info.render.calls ?? 0,
      tris: r?.renderer?.info.render.triangles ?? 0,
      programs: r?.renderer?.info.programs?.length ?? 0,
      textures: r?.renderer?.info.memory.textures ?? 0,
      geometries: r?.renderer?.info.memory.geometries ?? 0,
      ms: engine.time.dt * 1000,
      /**
       * Did the staged aircraft's rotor actually spool? `null` = this shot never
       * asked, `false` = it asked and `vehicles.debugSpool` is not on this tree
       * yet, `true` = it ran. Published so `tools/screenshots.mjs` can say which
       * of the three happened instead of a capture silently shipping a frozen
       * disc — see `spoolStaged`.
       */
      spool: engine.__shotSpool ?? null,
      // The RESOLVED camera pose. `onRoad` shots re-derive their camera from
      // the road graph at apply time, so when the graph changes — new lots, a
      // re-cut corridor — a shot silently relocates. Two capture sets then
      // compare different PLACES, and a blind A/B measures the move rather than
      // the work. Recording the pose lets the comparison detect that and drop
      // the shot instead of reporting a confounded verdict.
      camPose: [
        +engine.camera.position.x.toFixed(2),
        +engine.camera.position.y.toFixed(2),
        +engine.camera.position.z.toFixed(2),
        +engine.camera.rotation.x.toFixed(3),
        +engine.camera.rotation.y.toFixed(3),
        +engine.camera.rotation.z.toFixed(3),
      ],
    };
  };

  /**
   * LOCKSTEP CAPTURE (`?capture=1&lockstep=1`) — the determinism fix.
   *
   * The problem it solves: the engine's own rAF loop keeps stepping while the
   * driver is doing round trips (waitForFunction on __READY__, the evaluate that
   * applies the shot, the screenshot RPC itself). The number of frames that fit
   * inside those round trips is wall-clock dependent, so `engine.time.frame` at
   * the moment the shutter fires drifted 10-20 frames run to run. Everything
   * phase-locked to the absolute frame index — TAA jitter (render/index.js:1067),
   * GTAO / SSR / contact-shadow noise rotation (`frame % 64`), exposure
   * adaptation, and the cadence of every scripted transient — therefore resolved
   * differently on every run. That, not any subsystem clock read, is what made
   * two identical runs differ and what made pre-warm (which burns ~1.4 s of wall
   * clock before the loop starts) look like a visual change.
   *
   * The fix: in lockstep mode the engine NEVER schedules its own frames. Frames
   * only happen inside __PUMP__(n), which advances exactly n of them. The frame
   * index at the shutter is then a constant, and nothing at all advances while
   * the screenshot is being taken.
   */
  if (lockstep) {
    engine.start = function () { this._running = true; };
    window.__LOCKSTEP__ = true;

    /** Advance exactly `n` engine frames, one per rAF so each is presented. */
    window.__PUMP__ = (n = 1) => new Promise((resolve) => {
      let i = 0;
      const tick = () => {
        engine.step();
        snapInfo();
        if (++i >= n) resolve(engine.time.frame);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    /** Yield `n` rAFs WITHOUT stepping, so the compositor picks up the last
     *  rendered frame before the screenshot. Advances no simulation state. */
    window.__PRESENT__ = (n = 2) => new Promise((resolve) => {
      let i = 0;
      const tick = () => (++i >= n ? resolve(engine.time.frame) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
  } else {
    window.__LOCKSTEP__ = false;
    // Free-running: the engine drives itself, __PUMP__ just waits out n frames.
    window.__PUMP__ = (n = 1) => new Promise((resolve) => {
      let i = 0;
      const tick = () => (++i >= n ? resolve(engine.time.frame) : requestAnimationFrame(tick));
      requestAnimationFrame(tick);
    });
    window.__PRESENT__ = window.__PUMP__;
    const info = () => { snapInfo(); requestAnimationFrame(info); };
    requestAnimationFrame(info);
  }

  return { pump: window.__PUMP__, present: window.__PRESENT__, lockstep: !!lockstep };
}
