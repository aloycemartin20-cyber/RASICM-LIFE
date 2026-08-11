/**
 * GAME — the mission track types.
 *
 * DESIGN.md names eleven of them plus `boss`:
 *
 *   deliver · timedDeliver · race · chase · escape · escort · collect ·
 *   goons/brawl · survive · rampage · boss
 *
 * plus the four the story shape adds:
 *
 *   recover · protect · partner · final
 *
 * Every one is a small object with `init(M, c, g)` and `update(M, dt, g)`,
 * where `M` is the live mission record, `c` is the chapter definition out of
 * `data.js` and `g` is the `MissionRunner` that owns spawning, objectives,
 * markers and the win/fail verdict. Tracks never spawn anything directly —
 * they go through `g.spawnVehicle` / `g.spawnHostile` / `g.spawnPickup` so
 * that cleanup is automatic and a failed mission cannot leak a boss into free
 * roam.
 *
 * Distances are derived for a 3 km map rather than scaled up from the 700 m one
 * the track logic was originally authored against, and every track drives the
 * real subsystems rather than a single-file simulation.
 *
 * Rule 5: no allocation in `update`. Each track keeps its scratch on `M`.
 */

import { RACE_TRACKS, R, TIMED_STORY, MARK_GREEN, MARK_AMBER, REPAIR_TIME } from './data.js';
import { clamp01, dist, driveRoute, upDot } from './util.js';

/* ===================================================================== */
/* helpers shared by several tracks                                       */
/* ===================================================================== */

/**
 * Where a chapter stages itself.
 *
 * `M.startPoi` is the place the chapter names — the docks, the mill, Butler
 * Street — and the runner's `travel` phase guarantees the player is standing
 * within `TRAVEL_ARRIVE` of it before any of these `init` functions run. So a
 * track can stage its content around the POI and know the player is there;
 * chapters that name nowhere stage around the player instead.
 *
 * A POI with a `stage` gives that instead: a `DOCKS` coordinate is the PIER
 * HEAD, over water on purpose, and staging a ward, a wave of hostiles or a
 * parked car on it puts them on the riverbed. `MissionRunner._start` already
 * resolves `startPoi` through the same field — this is the belt to its braces,
 * because a track reached any other way must get the same answer.
 */
function anchor(M, c, g) {
  const p = M.startPoi;
  if (p) {
    if (!p.stage) return p;
    M._anchor.x = p.stage.x;
    M._anchor.z = p.stage.z;
    return M._anchor;
  }
  const f = g.wq.focusPos(g._anchorV);
  M._anchor.x = f.x;
  M._anchor.z = f.z;
  return M._anchor;
}

/** How much tougher an enemy is at this chapter's difficulty and setting. */
function enemyHp(c, g, base = 60) {
  return Math.round((base + c.difficulty * 14) * g.diff.enemy);
}
function enemyDmg(c, g, base = 10) {
  return Math.round((base + c.difficulty * 2) * g.diff.dmgIn);
}

/* ------------------------------------------------------------------- */
/* the wedge watchdog on a track's own vehicle                          */
/* ------------------------------------------------------------------- */

/**
 * Seconds a track vehicle may lie inverted and still before the chapter is
 * declared wedged. Long enough that a roll the player drives out of — the roll
 * assist rights a car in about two — is never scored as one.
 */
const VEH_FAULT_T = 8;
/** Under this ground speed the car is not driving out of it. */
const VEH_STATIC = 0.8;
/** `upDot` below this is on its side or its roof. cos 80 deg. */
const VEH_UPRIGHT = 0.17;

/**
 * Has the vehicle this chapter depends on stopped being a vehicle?
 *
 * TWO faults, and the second is the one that used to hang a chapter forever.
 * `destroyed` is loud and every track already tested it — and it now also
 * covers an aircraft, because `vehicles` raises `vehicle:destroyed` on a
 * terrain impact. On its ROOF is silent: the car is at full health, the
 * objective is intact, nothing fails and nothing can ever complete. A chapter
 * that cannot be won must end with the ordinary retry card rather than leaving
 * the player to reach for the pause menu.
 *
 * `key` is a FIXED property name on `M` — a literal, never built per frame
 * (rule 5) — so two vehicles in one chapter cannot share a clock.
 *
 * @returns {'destroyed'|'inverted'|'gone'|null}
 */
function vehFault(M, dt, v, key) {
  if (!v) return 'gone';
  if (v.destroyed) return 'destroyed';
  const stuck = upDot(v) < VEH_UPRIGHT && Math.abs(v.forwardSpeed ?? 0) < VEH_STATIC;
  const t = stuck ? (M[key] ?? 0) + dt : 0;
  M[key] = t;
  return t >= VEH_FAULT_T ? 'inverted' : null;
}

/**
 * The same watchdog for a COURTESY RIDE — the car a track spawns into `M.veh`
 * only because the player walked to the start line.
 *
 * TWO GUARDS, and both stop this ending a chapter that was still winnable.
 * Losing the courtesy car is not a fail while he has something else to drive:
 * he may have stolen better two streets ago, and failing him for the car he
 * abandoned would be a worse bug than the hang. And it is only applied by the
 * tracks that cannot be finished without a car at all — `race` (a lap timer
 * against 26 m gates a kilometre apart) and `chase` (a muscle car at full
 * throttle). `escape` cools down on foot, `escort`'s truck now drives itself
 * to the drop, and VIPER LANE can be shot off her wheels by a man standing
 * still; all three stay winnable, so none of them calls this.
 *
 * THE RELEASE IS LATCHED, NOT THE FAULT, and that ordering is the whole point.
 * Testing "is he in another car RIGHT NOW" only suppresses the fail on the
 * frames he happens to be seated: `_faultRide` keeps climbing while the
 * abandoned car lies on its roof, so the first frame `playerVehicle()` went
 * null — a wreck, a step out to shoot, a respawn — the chapter ended with
 * "Your car ended up on its roof" for a car he left two minutes and a
 * kilometre ago. Once he has adopted ANY other vehicle the courtesy car stops
 * being this chapter's ride for good and is never watched again.
 *
 * On foot with no substitute the fail stays, because that is the hang this
 * exists for. Wrecking the SUBSTITUTE after the release is not our clock
 * either: `race` still has its authored `baseTimer` and `chase` still has
 * `R.chaseLose`, so both tracks keep a fail path without borrowing this one.
 */
function rideFault(M, dt, g) {
  if (!M.veh || M.rideReleased) return null;
  const pv = g.wq.playerVehicle();
  if (pv && pv !== M.veh && !pv.destroyed) {
    M.rideReleased = true;
    return null;
  }
  return vehFault(M, dt, M.veh, '_faultRide');
}

/** Fail text for a fault, so all seven tracks word it the same way. */
function faultReason(fault, what = 'The vehicle') {
  if (fault === 'inverted') return `${what} ended up on its roof`;
  if (fault === 'gone') return `${what} never arrived`;
  return `${what} was wrecked`;
}

/* ------------------------------------------------------------------- */
/* collect                                                              */
/* ------------------------------------------------------------------- */

/** Nearest a crate may be scattered from the anchor — else they land underfoot. */
const COLLECT_MIN = 60;
/**
 * Where the courtesy boat is moored, relative to the chapter's anchor. Both
 * radii are walking distances off a bank the anchor is already on: MEASURED
 * over six seeds at The Point, the worst mooring is 87 m out with dry land
 * 20 m from the hull (`src/game/dockprobe.mjs`).
 */
const BOAT_MIN = 20;
const BOAT_MAX = 90;

/**
 * Can this hull cross a river? The `boat` class and nothing else in the fleet:
 * a car in water loses 6% of max health a second, and an aircraft that puts
 * down on the Ohio is a wreck, not a ride.
 */
function waterCapable(v) {
  return !!v && !v.destroyed && (v.type === 'boat' || v.spec?.kind === 'boat' || v.spec?.id === 'boat');
}

/* ===================================================================== */

export const TRACKS = {
  /* ------------------------------------------------------------------- */
  /* deliver — take the marked vehicle to the drop                        */
  /* ------------------------------------------------------------------- */
  deliver: {
    init(M, c, g) {
      const dest = g.wq.poi(c.dest) ?? g.wq.nearestSafehouse(0, 0).poi;
      M.dest = dest;
      const a = anchor(M, c, g);
      const boat = c.vehType === 'boat';
      // A boat is moored where you can walk to it; a car is on a real lane.
      const spot = boat
        ? g.wq.findWaterSpot(25, 140, a.x, a.z, undefined, true)
        : g.wq.findRoadSpot(40, 160, a.x, a.z);
      M.veh = g.spawnVehicle(M, c.vehType ?? 'sedan', spot.x, spot.z, spot.yaw, { tag: 'deliver' });
      if (M.veh) {
        // The job is the delivery, not surviving a fender bender.
        M.veh.maxHealth *= 1.6;
        M.veh.health = M.veh.maxHealth;
        // The objective vehicle glows — green fetch, amber when it is timed.
        g.markVehicle(M, M.veh, c.track === 'timedDeliver' ? MARK_AMBER : MARK_GREEN);
      }
      // Hard+ puts a clock on the plain delivery (the `timedStory` flag).
      if (c.track === 'deliver' && !M.hasTimer && g.diff.timedStory) {
        g.armTimer(M, TIMED_STORY.deliver);
      }
      // A TIMED DELIVERY IS CLOCKED ON THE JOB, NOT ON THE CHAPTER NUMBER.
      // See DELIVER_RATE — the authored `baseTimer` is overwritten on purpose.
      if (c.track === 'timedDeliver') {
        g.armTimer(M, dist(spot.x, spot.z, dest.x, dest.z) * DELIVER_RATE);
      }
      M.aboard = false;
    },
    update(M, dt, g) {
      const fault = vehFault(M, dt, M.veh, '_faultDeliver');
      if (fault) return g.fail(M, faultReason(fault));
      const pv = g.wq.playerVehicle();
      if (pv === M.veh) {
        if (!M.aboard) {
          M.aboard = true;
          g.say(g.boyId, M.dest.name === 'DeCarlo Body Shop' ? 'Right. Home it goes.' : null);
        }
        g.marker(M, 0, M.dest.x, M.dest.z, M.dest.name, 'D', R.dropoff);
        g.objective(M, `Deliver to ${M.dest.name}`, null,
          Math.round(dist(M.veh.position.x, M.veh.position.z, M.dest.x, M.dest.z)) + ' m');
        if (dist(M.veh.position.x, M.veh.position.z, M.dest.x, M.dest.z) < R.dropoff) g.win(M);
      } else {
        g.marker(M, 0, M.veh.position.x, M.veh.position.z, 'Your ride', 'V');
        g.objective(M, 'Get in the marked vehicle', null,
          Math.round(dist(M.veh.position.x, M.veh.position.z, g.px, g.pz)) + ' m');
      }
      if (M.state === 'run' && M.hasTimer && M.timer <= 0) g.fail(M, 'Out of time');
    },
  },

  /* ------------------------------------------------------------------- */
  /* timedDeliver — the same job with a clock                             */
  /* ------------------------------------------------------------------- */
  timedDeliver: {
    init(M, c, g) {
      TRACKS.deliver.init(M, c, g);
    },
    update(M, dt, g) {
      TRACKS.deliver.update(M, dt, g);
      if (M.state === 'run' && M.timer <= 0) g.fail(M, 'Out of time');
    },
  },

  /* ------------------------------------------------------------------- */
  /* goons — kill N, out in the open                                      */
  /* ------------------------------------------------------------------- */
  goons: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      for (let i = 0; i < M.goal; i++) {
        const s = g.wq.findGroundSpot(45, 150, a.x, a.z);
        g.spawnHostile(M, s.x, s.z, {
          hp: enemyHp(c, g, 62),
          ranged: i % 3 !== 0,
          dmg: enemyDmg(c, g, 10),
        });
      }
      M.topUpT = 0;
    },
    update(M, dt, g) {
      const alive = g.aliveHostiles(M);
      M.progress = M.goal - alive;
      g.objective(M, 'Take them down', null, `${M.progress} / ${M.goal}`, M.progress / M.goal);
      const near = g.nearestHostile(M);
      if (near) g.marker(M, 0, near.position.x, near.position.z, 'Target', 'X');
      if (alive === 0) return g.win(M);

      // If the player drives off, bring the fight to him rather than making
      // him retrace 400 m of city.
      M.topUpT -= dt;
      if (M.topUpT <= 0) {
        M.topUpT = 2;
        if (near && dist(near.position.x, near.position.z, g.px, g.pz) > 320) {
          for (const h of g.hostilesOf(M)) {
            if (h.dead) continue;
            const s = g.wq.findGroundSpot(70, 150, g.px, g.pz);
            h.position.set(s.x, s.y, s.z);
            h.homeX = s.x;
            h.homeZ = s.z;
          }
          g.notify('They found you', null, 'bad');
        }
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* brawl — the same count, in a ring, hands and steel                   */
  /* ------------------------------------------------------------------- */
  brawl: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      M.arena.x = a.x;
      M.arena.z = a.z;
      M.arena.r = R.brawlLeash;
      for (let i = 0; i < M.goal; i++) {
        const ang = (i / M.goal) * Math.PI * 2;
        const x = a.x + Math.cos(ang) * 26;
        const z = a.z + Math.sin(ang) * 26;
        g.spawnHostile(M, x, z, {
          hp: enemyHp(c, g, 70),
          ranged: false,
          dmg: enemyDmg(c, g, 13),
          leash: R.brawlLeash * 0.8,
        });
      }
      M.leaveT = 0;
    },
    update(M, dt, g) {
      const alive = g.aliveHostiles(M);
      M.progress = M.goal - alive;
      if (alive === 0) return g.win(M);
      g.marker(M, 0, M.arena.x, M.arena.z, 'The yard', 'A');

      const away = dist(g.px, g.pz, M.arena.x, M.arena.z);
      if (away > M.arena.r) {
        M.leaveT += dt;
        g.objective(M, 'Get back in the fight', 6 - M.leaveT, 'Leaving the area');
        if (M.leaveT > 6) return g.fail(M, 'You walked away');
      } else {
        M.leaveT = 0;
        g.objective(M, 'Hands only — put them down', null, `${M.progress} / ${M.goal}`, M.progress / M.goal);
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* race — checkpoint circuit, laps, three rivals                        */
  /* ------------------------------------------------------------------- */
  race: {
    init(M, c, g) {
      const track = RACE_TRACKS[c.trackId] ?? RACE_TRACKS.triangle;
      M.circuit = track;
      M.points = track.points;
      M.cpIdx = 0;
      M.lap = 0;
      M.laps = c.laps ?? track.laps ?? 1;

      // The runner's `travel` phase has already put the player at the start
      // line, so all that is left is to make sure he has something to drive.
      const start = M.points[0];
      const next = M.points[1 % M.points.length];
      const yaw = Math.atan2(next.x - start.x, next.z - start.z);
      if (!g.wq.playerVehicle()) {
        const s = g.wq.findRoadSpot(8, 40, g.px, g.pz);
        M.veh = g.spawnVehicle(M, g.boy.car ?? 'sports', s.x, s.z, yaw);
      }

      M.rivals.length = 0;
      for (let i = 0; i < 3; i++) {
        const s = g.wq.findRoadSpot(18, 60, start.x, start.z);
        const r = g.spawnVehicle(M, i === 0 ? 'muscle' : 'sports', s.x, s.z, yaw, { tag: 'rival' });
        if (!r) continue;
        r.raceCp = 1;
        r.raceLap = 0;
        // A rival that is quicker than the player at difficulty 5 and slower at
        // difficulty 1 — the pace comes from throttle discipline, not cheating.
        r.racePace = 0.78 + c.difficulty * 0.035 + i * 0.02;
        M.rivals.push(r);
      }
      M.bestLap = 0;
      M.lapT = 0;
    },
    update(M, dt, g) {
      const cps = M.points;
      const cp = cps[M.cpIdx];
      M.lapT += dt;
      g.marker(M, 0, cp.x, cp.z, `Checkpoint ${M.cpIdx + 1}`, String(M.cpIdx + 1), R.checkpoint);

      const src = g.wq.playerVehicle() ?? g.wq.player;
      const sx = src?.position?.x ?? g.px;
      const sz = src?.position?.z ?? g.pz;
      if (dist(sx, sz, cp.x, cp.z) < R.checkpoint) {
        M.cpIdx++;
        g.wq.uiSfx('hitmarker', 0.55);
        if (M.cpIdx >= cps.length) {
          M.cpIdx = 0;
          M.lap++;
          if (M.bestLap === 0 || M.lapT < M.bestLap) M.bestLap = M.lapT;
          M.lapT = 0;
          if (M.lap >= M.laps) return g.win(M);
          g.notify(`Lap ${M.lap + 1} of ${M.laps}`, null, 'gold');
        }
      }

      // Rival standings, for the count line.
      let ahead = 0;
      for (const r of M.rivals) {
        if (!r || r.destroyed) continue;
        const total = r.raceLap * cps.length + r.raceCp;
        if (total > M.lap * cps.length + M.cpIdx) ahead++;
      }
      g.objective(
        M,
        `Checkpoint ${M.cpIdx + 1} of ${cps.length}`,
        null,
        M.laps > 1 ? `Lap ${M.lap + 1}/${M.laps} · P${ahead + 1}` : `P${ahead + 1}`,
        (M.lap * cps.length + M.cpIdx) / (M.laps * cps.length)
      );

      if (M.hasTimer && M.timer <= 0) return g.fail(M, 'Out of time');
      const fault = rideFault(M, dt, g);
      if (fault) return g.fail(M, faultReason(fault, 'Your car'));
      this.driveRivals(M, dt, g);
    },

    driveRivals(M, dt, g) {
      const cps = M.points;
      for (const r of M.rivals) {
        if (!r || r.destroyed) continue;
        const t = cps[r.raceCp % cps.length];
        if (dist(r.position.x, r.position.z, t.x, t.z) < R.checkpoint) {
          r.raceCp++;
          if (r.raceCp % cps.length === 0) r.raceLap++;
        }
        // Aim a little past the gate so they carry speed through it.
        const nxt = cps[(r.raceCp + 1) % cps.length];
        const aimX = t.x + (nxt.x - t.x) * 0.18;
        const aimZ = t.z + (nxt.z - t.z) * 0.18;
        // By road, so the standings line means something: a rival that cut the
        // straight line between two gates drove into the Allegheny and the
        // player was P1 by default.
        RIVAL_OPTS.throttle = r.racePace;
        driveRoute(g.wq, r, g._input, aimX, aimZ, dt, RIVAL_OPTS);
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* chase — run the target down                                          */
  /* ------------------------------------------------------------------- */
  chase: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      const s = g.wq.findRoadSpot(180, 320, a.x, a.z);
      M.target = g.spawnVehicle(M, 'muscle', s.x, s.z, s.yaw, { tag: 'target' });
      if (M.target) {
        M.target.maxHealth = M.target.health = 260 + c.difficulty * 70;
        M.target.isMissionTarget = true;
      }
      if (!g.wq.playerVehicle()) {
        const p = g.wq.findRoadSpot(10, 45, g.px, g.pz);
        M.veh = g.spawnVehicle(M, g.boy.car ?? 'sports', p.x, p.z, p.yaw);
      }
      M.fleeT = 0;
      // THE CHAPTER MUST NOT BE LOSABLE BEFORE IT IS PLAYABLE. See CHASE_GRACE.
      M.graceT = CHASE_GRACE;
      M.boardT = 0;
      M.rolled = false;
    },
    update(M, dt, g) {
      const t = M.target;
      if (!t) return g.fail(M, 'The target got away');
      if (t.destroyed) return g.win(M);
      g.marker(M, 0, t.position.x, t.position.z, 'Target', 'X');
      const d = dist(t.position.x, t.position.z, g.px, g.pz);
      const hp = Math.round(clamp01(t.health / t.maxHealth) * 100);

      // THE ARMING LATCH. One way: once he has driven anything at all the chase
      // is on for good, so stepping out to shoot cannot freeze the target.
      if (!M.rolled && g.wq.playerVehicle()) M.rolled = true;
      M.boardT += dt;
      const armed = M.rolled || M.boardT >= CHASE_BOARD;
      if (!armed) {
        g.objective(M, 'Get in a car — he is about to run', null,
          `${Math.round(d)} m · ${hp}%`, 1 - t.health / t.maxHealth);
        return;
      }
      g.objective(M, 'Wreck the target', null, `${Math.round(d)} m · ${hp}%`, 1 - t.health / t.maxHealth);
      M.graceT -= dt;

      // Flee: pick a point directly away from the player and drive at it,
      // re-picked every couple of seconds so he does not head into the river.
      M.fleeT -= dt;
      if (M.fleeT <= 0 || M.fleeX === undefined) {
        M.fleeT = 2.2;
        const away = Math.atan2(t.position.x - g.px, t.position.z - g.pz);
        const s = g.wq.findRoadSpot(160, 300, t.position.x + Math.sin(away) * 120, t.position.z + Math.cos(away) * 120);
        M.fleeX = s.x;
        M.fleeZ = s.z;
      }
      FLEE_OPTS.boost = d < 60;
      driveRoute(g.wq, t, g._input, M.fleeX, M.fleeZ, dt, FLEE_OPTS);
      if (M.graceT <= 0 && d > R.chaseLose) return g.fail(M, 'The target got away');
      const fault = rideFault(M, dt, g);
      if (fault) return g.fail(M, faultReason(fault, 'Your car'));
    },
  },

  /* ------------------------------------------------------------------- */
  /* escape — shed N stars                                                */
  /* ------------------------------------------------------------------- */
  escape: {
    init(M, c, g) {
      M.needStars = c.stars ?? 3;
      g.heat.raise(M.needStars, g.px, g.pz);
      M.graceT = 2.5;
      if (!g.wq.playerVehicle()) {
        const p = g.wq.findRoadSpot(10, 40, g.px, g.pz);
        M.veh = g.spawnVehicle(M, g.boy.car ?? 'sports', p.x, p.z, p.yaw);
      }
    },
    update(M, dt, g) {
      const w = g.heat.wanted;
      M.graceT -= dt;
      const spray = g.wq.nearestShop(g.px, g.pz, 'spray');
      if (spray) g.marker(M, 0, spray.poi.x, spray.poi.z, spray.poi.name, 'S');
      g.objective(
        M,
        'Shake the police',
        null,
        w > 0 ? `${w} star${w === 1 ? '' : 's'} · find a respray` : 'Heat off',
        1 - w / Math.max(1, M.needStars)
      );
      // The respray itself lives in `freeroam.js` so it works outside a
      // mission too; the track only has to notice the result. No `rideFault`
      // here on purpose — see its header: the heat cools on foot.
      if (w === 0 && M.graceT <= 0) g.win(M);
    },
  },

  /* ------------------------------------------------------------------- */
  /* collect — N crates, optionally on the water, optionally on a clock   */
  /* ------------------------------------------------------------------- */
  collect: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      const water = !!c.water;
      const spread = c.spread ?? 380;
      for (let i = 0; i < M.goal; i++) {
        // `nearShore` on a crate is the same rule as on a hull: a crate in the
        // middle of the Ohio is one the player can only reach by abandoning the
        // boat and swimming the last stretch at 2.1 m/s.
        const s = water
          ? g.wq.findWaterSpot(COLLECT_MIN, spread, a.x, a.z, undefined, true)
          : g.wq.findGroundSpot(COLLECT_MIN, spread, a.x, a.z);
        g.spawnPickup(M, s.x, s.z, 'crate', { mission: true, y: water ? 1.1 : undefined });
      }
      // A WATER OBJECTIVE GUARANTEES A HULL — the contract deliver, chase,
      // escort, escape, race and boss-driver already keep with `if
      // (!g.wq.playerVehicle()) g.spawnVehicle(...)`. Swim speed is 2.1 m/s
      // (3.4 sprinting), so a clocked salvage run with no boat is a chapter
      // that cannot be finished rather than one that is hard.
      M.water = water;
      if (water && !waterCapable(g.wq.playerVehicle())) {
        const p = g.wq.findWaterSpot(BOAT_MIN, BOAT_MAX, a.x, a.z, undefined, true);
        M.veh = g.spawnVehicle(M, 'boat', p.x, p.z, p.yaw);
        // Green: fetch it. The clock is on the crates, not on reaching the boat.
        if (M.veh) g.markVehicle(M, M.veh, MARK_GREEN);
      }
    },
    update(M, dt, g) {
      // THE HULL, not `rideFault`. A water salvage is the one track whose
      // courtesy ride cannot be substituted: `rideFault` clears the fault the
      // moment the player is in ANY other undestroyed vehicle, and a sports car
      // is not a way to reach a crate 300 m out in the Ohio. Swim speed is
      // 2.1 m/s, so the alternative is a clocked chapter that cannot be
      // finished rather than one that is hard — the same argument `init` makes
      // for spawning the boat in the first place.
      if (M.water && M.veh) {
        const fault = vehFault(M, dt, M.veh, '_faultHull');
        if (fault && !waterCapable(g.wq.playerVehicle())) {
          return g.fail(M, faultReason(fault, 'The boat'));
        }
      }
      const left = g.pickups.countMission();
      M.progress = M.goal - left;
      g.objective(M, 'Gather the crates', null, `${M.progress} / ${M.goal}`, M.progress / M.goal);
      const n = g.pickups.nearestMission(g.px, g.pz);
      if (n) g.marker(M, 0, n.x, n.z, 'Crate', 'C');
      if (left === 0) return g.win(M);
      if (M.hasTimer && M.timer <= 0) g.fail(M, 'Out of time');
    },
  },

  /* ------------------------------------------------------------------- */
  /* survive — hold the ground for N seconds                              */
  /* ------------------------------------------------------------------- */
  survive: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      M.duration = (c.duration ?? 90) * (g.diff.timerMul ?? g.diff.time);
      M.timer = M.duration;
      M.hasTimer = true;
      M.hold.x = a.x;
      M.hold.z = a.z;
      M.waveT = 2;
      M.wave = 0;
      M.leaveT = 0;
      // Put the player on the hold point if the chapter named one far away.
      if (dist(g.px, g.pz, a.x, a.z) > R.holdLeash) g.wq.placePlayer(a.x, a.z, 0);
    },
    update(M, dt, g) {
      g.marker(M, 0, M.hold.x, M.hold.z, 'Hold here', 'H');
      const away = dist(g.px, g.pz, M.hold.x, M.hold.z);
      if (away > R.holdLeash) {
        M.leaveT += dt;
        g.objective(M, 'Return to the hold point', M.timer, 'Abandoning position');
        if (M.leaveT > 8) return g.fail(M, 'You abandoned the position');
      } else {
        M.leaveT = 0;
        g.objective(M, 'Hold this ground', M.timer, `Wave ${M.wave + 1}`,
          1 - M.timer / M.duration);
      }

      M.waveT -= dt;
      const alive = g.aliveHostiles(M);
      if (M.waveT <= 0 && alive < 7) {
        M.waveT = 7;
        M.wave++;
        const n = 2 + Math.floor(M.wave / 2);
        for (let i = 0; i < n; i++) {
          const s = g.wq.findGroundSpot(60, 130, M.hold.x, M.hold.z);
          g.spawnHostile(M, s.x, s.z, {
            hp: Math.round((55 + M.wave * 9) * g.diff.enemy),
            ranged: g.rng.float() < 0.5,
            dmg: Math.round((10 + M.wave) * g.diff.dmgIn),
            leash: R.holdLeash * 1.4,
          });
        }
        if (M.wave > 1) g.notify(`Wave ${M.wave}`, null, 'bad');
      }

      if (M.timer <= 0) g.win(M);
    },
  },

  /* ------------------------------------------------------------------- */
  /* escort — keep a slow ally alive to the drop                          */
  /* ------------------------------------------------------------------- */
  escort: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      const s = g.wq.findRoadSpot(20, 70, a.x, a.z);
      M.ally = g.spawnVehicle(M, 'truck', s.x, s.z, s.yaw, { tag: 'ally' });
      if (M.ally) {
        M.ally.maxHealth = M.ally.health = 520;
        M.ally.isAlly = true;
      }
      M.dest = g.wq.poi(c.dest) ?? g.wq.nearestSafehouse(s.x, s.z).poi;
      M.attackT = 8;
      M.warnT = 0;
      // Stuck watchdog: where the truck was when the window opened, and how
      // long it has been failing to leave.
      M.stuckX = s.x;
      M.stuckZ = s.z;
      M.stuckT = 0;
      M.unwedged = 0;
      // THE HARD TIMER. Without one, a truck jammed against a wall neither
      // wins nor fails and the chapter runs until the player quits. A WATCHDOG
      // clock: unscaled by difficulty and not paid as a time bonus — see
      // ESCORT_TIMER and `MissionRunner.armTimer`.
      if (!M.hasTimer) g.armTimer(M, ESCORT_TIMER, true);
      if (!g.wq.playerVehicle()) {
        const p = g.wq.findRoadSpot(10, 36, s.x, s.z);
        M.veh = g.spawnVehicle(M, g.boy.car ?? 'sports', p.x, p.z, p.yaw);
      }
    },
    update(M, dt, g) {
      const a = M.ally;
      const fault = vehFault(M, dt, a, '_faultAlly');
      if (fault === 'gone') return g.fail(M, 'The truck never made it out');
      if (fault === 'destroyed') return g.fail(M, 'The truck was destroyed');
      if (fault === 'inverted' && !g.wq.unwedgeVehicle(a, 1.1)) {
        return g.fail(M, 'The truck ended up on its roof');
      }
      if (M.timer <= 0 && M.hasTimer) return g.fail(M, 'Out of time');
      g.marker(M, 0, M.dest.x, M.dest.z, M.dest.name, 'D', R.dropoff);
      g.marker(M, 1, a.position.x, a.position.z, 'The truck', 'T');
      const hull = Math.round(clamp01(a.health / a.maxHealth) * 100);
      const d = dist(a.position.x, a.position.z, M.dest.x, M.dest.z);
      g.objective(M, `Escort the truck to ${M.dest.name}`, null, `${hull}% hull · ${Math.round(d)} m`,
        clamp01(1 - d / Math.max(1, M.escortStart ?? d)));
      if (M.escortStart === undefined) M.escortStart = d;

      // Dylan is driving it and he is, per the chapter, slow and complaining —
      // but he is driving it ON THE ROADS AND OVER THE BRIDGES. The straight
      // line from sh_aidan to sh_dylan crosses the Monongahela channel, and a
      // land vehicle in water loses 6% of max health a second.
      driveRoute(g.wq, a, g._input, M.dest.x, M.dest.z, dt, TRUCK_OPTS);
      if (d < R.dropoff) return g.win(M);
      this.watchStuck(M, dt, g, a);

      if (hull < 45 && M.warnT <= 0) {
        M.warnT = 12;
        g.say('dylan', "This truck is not built for this!");
      }
      M.warnT -= dt;

      this.ambush(M, dt, g, a);
    },

    /**
     * The truck moved less than `STUCK_MOVE` in `STUCK_T` — put it back on the
     * nearest lane rather than letting the chapter run out its clock against a
     * bollard. It is the same recovery `unwedgeVehicle` gives an inverted one,
     * and it is deliberately cheap to trigger and cheap to survive: the timer
     * is still running, so a truck that keeps re-wedging still fails.
     */
    watchStuck(M, dt, g, a) {
      M.stuckT += dt;
      if (dist(a.position.x, a.position.z, M.stuckX, M.stuckZ) > STUCK_MOVE) {
        M.stuckX = a.position.x;
        M.stuckZ = a.position.z;
        M.stuckT = 0;
        return;
      }
      if (M.stuckT < STUCK_T) return;
      M.stuckT = 0;
      M.stuckX = a.position.x;
      M.stuckZ = a.position.z;
      if (g.wq.unwedgeVehicle(a, 1.1)) {
        M.unwedged++;
        g.say('dylan', 'Had to back it out. Give me a second.');
      }
    },

    /**
     * Ambushers, in cars, aimed at the truck rather than at the player.
     *
     * THREE CAPS, all of them missing before and all of them the same bug: a
     * spawner with no accounting. One car every 11 s for a run that has no
     * clock, never despawned (mission vehicles are exempt from the streaming
     * cull), each ramming for 34 HP/s against a 520 HP truck — four converging
     * was 136 HP/s and the chapter was over in four seconds.
     */
    ambush(M, dt, g, a) {
      const list = g.vehiclesOf(M);
      let live = 0;
      // Backwards: retiring one splices it out of the array being walked.
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        if (!v.isAmbush) continue;
        // The distance test comes FIRST so a wreck is retired too — it burns
        // where the player left it and is cleared once the convoy is 250 m up
        // the road, rather than being held for the whole chapter because it
        // failed the `destroyed` guard on the way past.
        if (dist(v.position.x, v.position.z, a.position.x, a.position.z) > AMBUSH_DROP) {
          list.splice(i, 1);
          g.wq.despawnVehicle(v, FORCE);
          continue;
        }
        if (v.destroyed) continue;
        live++;
        const dd = driveRoute(g.wq, v, g._input, a.position.x, a.position.z, dt, RAM_OPTS);
        if (dd < 6.5) g.wq.damageVehicle(a, AMBUSH_RAM * dt, v.position);
      }
      M.attackT -= dt;
      if (live >= AMBUSH_MAX) {
        // Capped. Hold the cadence at a short refill so a slot that frees is
        // filled a beat later rather than on the very next frame.
        if (M.attackT < AMBUSH_REFILL) M.attackT = AMBUSH_REFILL;
        return;
      }
      if (M.attackT > 0) return;
      M.attackT = 11;
      const s = g.wq.findRoadSpot(180, 300, a.position.x, a.position.z);
      const at = g.spawnVehicle(M, 'muscle', s.x, s.z, s.yaw, { tag: 'ambush' });
      if (at) { at.isAmbush = true; at.chaseTarget = a; }
    },
  },

  /* ------------------------------------------------------------------- */
  /* rampage — wreck N targets on a clock                                 */
  /* ------------------------------------------------------------------- */
  rampage: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      M.timer = (c.baseTimer ?? 100) * (g.diff.timerMul ?? g.diff.time);
      M.hasTimer = true;
      const types = ['van', 'truck', 'muscle'];
      for (let i = 0; i < M.goal; i++) {
        const s = g.wq.findRoadSpot(70, c.spread ?? 400, a.x, a.z);
        const v = g.spawnVehicle(M, types[i % types.length], s.x, s.z, s.yaw, { tag: 'rampage' });
        if (v) {
          v.isRampage = true;
          v.maxHealth = v.health = 210;
        }
      }
    },
    update(M, dt, g) {
      let left = 0;
      let near = null;
      let nd = Infinity;
      for (const v of g.vehiclesOf(M)) {
        if (!v.isRampage || v.destroyed) continue;
        left++;
        const d = dist(v.position.x, v.position.z, g.px, g.pz);
        if (d < nd) { nd = d; near = v; }
      }
      M.progress = M.goal - left;
      g.objective(M, 'Wreck the convoy', null, `${M.progress} / ${M.goal}`, M.progress / M.goal);
      if (near) g.marker(M, 0, near.position.x, near.position.z, 'Target', 'X');
      if (left === 0) return g.win(M);
      if (M.timer <= 0) g.fail(M, 'Out of time');
    },
  },

  /* ------------------------------------------------------------------- */
  /* recover — N marked stolen cars, each driven back to the home ring    */
  /* ------------------------------------------------------------------- */
  /* The marked cars glow green across the map, delivering one unmarks it,
   * bumps progress and steps you OUT of it, wrecking one HE HAS SEEN fails the
   * chapter (see RECOVER_SEEN — one he never got near is replaced instead), and
   * hard+ puts 260 s on the whole job. */
  recover: {
    init(M, c, g) {
      M.dest = g.wq.poi(c.dest) ?? g.wq.nearestSafehouse(g.px, g.pz).poi;
      for (let i = 0; i < M.goal; i++) {
        // One car per third of the compass, 260-620 m out, so the map reads
        // as "they are all over the Burgh" and no two spawn on one street.
        this.place(M, g, i);
      }
      M.progress = 0;
      if (!M.hasTimer && g.diff.timedStory) g.armTimer(M, TIMED_STORY.recover);
    },

    /** Put marked car `i` on a lane a third of the compass around the drop. */
    place(M, g, i) {
      const bear = ((i + 0.5) / M.goal) * Math.PI * 2;
      const s = g.wq.findRoadSpot(120, 320,
        M.dest.x + Math.cos(bear) * 300, M.dest.z + Math.sin(bear) * 300);
      const v = g.spawnVehicle(M, RECOVER_TYPES[i % RECOVER_TYPES.length], s.x, s.z, s.yaw, { tag: 'recover' });
      if (v) {
        v.recoverSlot = i;
        v.recoverSeen = false;
        g.markVehicle(M, v, MARK_GREEN);
      }
      return v;
    },

    update(M, dt, g) {
      let nearest = null;
      let nd = Infinity;
      // Wrecks are collected, not acted on inside the walk: `place` pushes a
      // replacement onto the very array being iterated.
      //
      // ALL OF THEM, not the last one seen. A single `lost` slot despawned
      // every unwitnessed wreck it walked past and replaced ONE, so two cars
      // lost on the same frame — a pursuit through a junction, one explosion
      // near two of them — left the chapter permanently a car short of `goal`
      // with no fail path and nothing on the map to fetch. Preallocated on `M`
      // (rule 5); emptied here rather than at the end so an early `return`
      // cannot leave stale slots behind.
      const lost = M._lostSlots;
      lost.length = 0;
      const list = g.vehiclesOf(M);
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        if (!v._marked) continue;
        const d = dist(v.position.x, v.position.z, g.px, g.pz);
        // WITNESSED, ONCE, AND IT STAYS WITNESSED. See RECOVER_SEEN.
        if (!v.recoverSeen && (d <= RECOVER_SEEN || g.wq.playerVehicle() === v)) v.recoverSeen = true;
        if (v.destroyed) {
          if (v.recoverSeen) return g.fail(M, 'A marked car was wrecked');
          // He never laid eyes on it. Traffic, a stray cop or a streamed-in
          // collision 600 m away is not a thing the player did, and ending his
          // chapter for it is indistinguishable from a bug.
          g.unmarkVehicle(v);
          list.splice(i, 1);
          g.wq.despawnVehicle(v, FORCE);
          lost.push(v.recoverSlot ?? 0);
          continue;
        }
        if (d < nd) { nd = d; nearest = v; }
      }
      for (let k = 0; k < lost.length; k++) {
        const rep = this.place(M, g, lost[k]);
        // No road spot for a replacement is the one case where the goal really
        // has moved out of reach, and it must end the chapter rather than
        // quietly leave it a car short.
        if (!rep) return g.fail(M, 'A marked car was wrecked');
        if (!nearest) nearest = rep;
      }
      const pv = g.wq.playerVehicle();
      if (pv && pv._marked) {
        g.marker(M, 0, M.dest.x, M.dest.z, M.dest.name, 'D', R.dropoff);
        const d = dist(pv.position.x, pv.position.z, M.dest.x, M.dest.z);
        g.objective(M, `Bring it home to ${M.dest.name}`, null,
          `${M.progress} / ${M.goal} · ${Math.round(d)} m`, M.progress / M.goal);
        if (d < R.dropoff) {
          g.unmarkVehicle(pv);
          M.progress++;
          g.wq.uiSfx('regen', 0.9);
          if (M.progress >= M.goal) return g.win(M);
          g.notify('Recovered', `${M.progress} / ${M.goal}`, 'gold');
          // Out you get, go fetch the next one.
          g.forceExit();
        }
      } else if (nearest) {
        g.marker(M, 0, nearest.position.x, nearest.position.z, 'Marked car', 'V');
        g.objective(M, 'Get in a marked car', null,
          `${M.progress} / ${M.goal} · ${Math.round(nd)} m`, M.progress / M.goal);
      }
      if (M.state === 'run' && M.hasTimer && M.timer <= 0) g.fail(M, 'Out of time');
    },
  },

  /* ------------------------------------------------------------------- */
  /* protect — keep the named brother alive, drop N attackers             */
  /* ------------------------------------------------------------------- */
  /* The ward is a named ally pinned on a guard anchor with `noRevive` and his
   * HP bar in the HUD. Waves of three every 9 s aimed at HIM, a kill pulling
   * the next wave to 4 s, mission fails the moment he goes down, completes at
   * `goal` kills. The ward's HP is published on `game.getHudState().ward` for
   * `ui` to draw. */
  protect: {
    init(M, c, g) {
      const a = anchor(M, c, g);
      const s = g.wq.findGroundSpot(5, 12, a.x, a.z);
      const ward = g.spawnWard(M, s.x, s.z, c.ward ?? 'dylan', WARD_HP);
      if (!ward) return g.fail(M, 'He never made it here');
      M.hold.x = s.x;
      M.hold.z = s.z;
      M.waveT = 3;
      M.wave = 0;
      M.kills = 0;
      M._seenKills = 0;
      M.progress = 0;
    },
    update(M, dt, g) {
      const w = M.ward;
      if (!w) return g.fail(M, 'He never made it here');
      if (w.health <= 0) return g.fail(M, `${w.name} went down`);
      M.progress = M.kills;
      if (M.kills >= M.goal) return g.win(M);
      // A kill brings the next wave sooner.
      if (M.kills > M._seenKills) {
        M._seenKills = M.kills;
        M.waveT = Math.min(M.waveT, 4);
      }
      g.marker(M, 0, w.x, w.z, w.name, 'W', 10);
      g.objective(M, `Keep ${w.name} alive`, null, `${M.kills} / ${M.goal}`, M.kills / M.goal);

      M.waveT -= dt;
      if (M.waveT <= 0) {
        M.waveT = 9;
        M.wave++;
        for (let i = 0; i < 3; i++) {
          const s = g.wq.findGroundSpot(35, 80, w.x, w.z);
          const h = g.spawnHostile(M, s.x, s.z, {
            hp: enemyHp(M.def, g, 58),
            ranged: M.def.difficulty >= 4 && i % 2 === 0,
            dmg: enemyDmg(M.def, g, 9),
            // Leashed to the WARD, not the player: this is what makes them
            // besiegers rather than a posse that chases you off the map.
            leash: 60,
          });
          if (h) { h.homeX = w.x; h.homeZ = w.z; }
        }
        if (M.wave > 1) g.notify(`Wave ${M.wave}`, null, 'bad');
      }

      // Attackers in his face chip him down — `hostiles` only ever fights the
      // player, so the siege damage is the track's arithmetic, exactly like
      // the escort ambushers ramming the truck.
      for (const h of g.hostilesOf(M)) {
        if (!h.active || h.dead) continue;
        if (dist(h.position.x, h.position.z, w.x, w.z) < R.wardAttack) {
          g.hurtWard(M, h.damage * 0.55 * dt);
        }
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* partner — drive to them, then fix the car on foot in the ring        */
  /* ------------------------------------------------------------------- */
  /* A timed-on-hard approach to the partner's zone, then the clock STOPS and
   * the minigame starts — on foot within 4.5 m of the dead sedan, the repair
   * fills over 6 s with a live percentage, sparks and a tick every 0.4 s, and
   * the chapter completes at 100%. */
  partner: {
    init(M, c, g) {
      M.dest = g.wq.poi(c.dest) ?? g.wq.poi(g.boy.home);
      M.step = 0;
      M.repair = 0;
      if (!M.hasTimer && g.diff.timedStory) g.armTimer(M, TIMED_STORY.partner);
    },
    update(M, dt, g) {
      const c = M.def;
      const pname = g.boy.partner?.name ?? 'them';
      if (M.step === 0) {
        g.marker(M, 0, M.dest.x, M.dest.z, pname, 'P', 14);
        const d = dist(g.px, g.pz, M.dest.x, M.dest.z);
        g.objective(M, `Get to ${pname} — ${M.dest.name}`, null, `${Math.round(d)} m`);
        if (M.hasTimer && M.timer <= 0) return g.fail(M, 'You left them waiting');
        if (d < R.partnerZone) {
          M.step = 1;
          // The approach was the race; the repair is not, so the clock stops
          // at the flip.
          M.hasTimer = false;
          M.timer = 0;
          const s = g.wq.findRoadSpot(6, 26, M.dest.x, M.dest.z);
          M.veh = g.spawnVehicle(M, 'sedan', s.x, s.z, s.yaw, { tag: 'partner' });
          if (M.veh) {
            // Dead on the kerb: real damage so the body wears the trouble.
            g.wq.damageVehicle(M.veh, M.veh.maxHealth * 0.72, M.veh.position);
          }
          const ps = g.wq.findGroundSpot(2.5, 5, s.x, s.z);
          const partner = g.boy.partner;
          if (partner) {
            g.spawnFigure(M, ps.x, ps.z, {
              id: partner.id,
              name: partner.name,
              color: parseInt(partner.color.slice(1), 16),
              accent: parseInt(partner.color.slice(1), 16),
            });
            g.say(partner.id, c.partnerLine ?? 'You made it! Can you take a look?');
          }
        }
      } else {
        const v = M.veh;
        // NOT the inverted arm of `vehFault`: this car is a repair target, not
        // a ride, and the repair runs on foot beside it — a sedan on its roof
        // is ugly, not unwinnable, and failing it would end a winnable chapter.
        if (!v) return g.fail(M, 'The car is gone');
        if (v.destroyed) return g.fail(M, 'You wrecked the car. Date night is off');
        g.marker(M, 0, v.position.x, v.position.z, 'The car', 'R', R.repair);
        const onFoot = !g.wq.playerVehicle();
        const d = dist(g.px, g.pz, v.position.x, v.position.z);
        if (onFoot && d < R.repair) {
          M.repair += (dt / REPAIR_TIME) * 100;
          g.repairFx(M, v);
          g.objective(M, `Repairing the car — ${Math.min(99, Math.floor(M.repair))}%`,
            null, '', clamp01(M.repair / 100), 'Repair');
          if (M.repair >= 100) {
            v.health = v.maxHealth;
            g.notify('Car fixed', null, 'gold');
            return g.win(M);
          }
        } else {
          g.objective(M, `Repair ${pname}'s car — stand by it on foot`,
            null, `${Math.round(d)} m`, clamp01(M.repair / 100), 'Repair');
        }
      }
    },
  },

  /* ------------------------------------------------------------------- */
  /* final — zero-reward homecoming into the ending                       */
  /* ------------------------------------------------------------------- */
  /* A marker on home, nothing spawned, nothing paid — arriving triggers the
   * ending. `MissionRunner.win` routes a `final` chapter into `_ending`
   * (slides, story-done flag, the all-weapons unlock) instead of the result
   * card. */
  final: {
    init(M, c, g) {
      M.dest = g.wq.poi(c.dest) ?? g.wq.poi(g.boy.home);
    },
    update(M, dt, g) {
      g.marker(M, 0, M.dest.x, M.dest.z, M.dest.name, 'H', R.finalZone);
      const d = dist(g.px, g.pz, M.dest.x, M.dest.z);
      g.objective(M, `Drive home to ${M.dest.name}`, null, `${Math.round(d)} m`, -1, 'Homecoming');
      if (d < R.finalZone) return g.win(M);
    },
  },
};

/** A protect ward's health pool. Flat: he is family, not a difficulty knob. */
const WARD_HP = 320;

/* ------------------------------------------------------------------- */
/* recover tuning                                                       */
/* ------------------------------------------------------------------- */

/** The three classes a recover chapter scatters, one per compass third. */
const RECOVER_TYPES = Object.freeze(['muscle', 'sedan', 'sports']);

/**
 * Metres at which a marked car counts as SEEN, after which wrecking it fails
 * the chapter.
 *
 * `recover` scatters its cars 260-620 m out and then fails the whole chapter
 * the frame any one of them reports `destroyed` — from anywhere, for any
 * reason. Mission vehicles are exempt from the streaming cull but nothing else:
 * traffic rear-ends them, a pursuit drives through them, and a car left
 * half-way up an off-camera incline rolls. The player gets a FAILED card for an
 * event that happened outside his draw distance and that he could not have
 * influenced, which is the exact shape of a bug report.
 *
 * So the fail is gated on WITNESS, and the witness latches: once he has been
 * within 90 m of a car — inside the streamed-in shell, close enough that its
 * marker and its glow are on screen — wrecking it is on him for the rest of the
 * chapter, however far away it happens. An unwitnessed wreck is replaced on a
 * fresh lane instead, so the goal count and the payout are unchanged and the
 * chapter stays exactly as long as it was.
 *
 * 90 m is the marked-car glow's own working range rather than a new number: the
 * ring is 3 m across and pulses, which is what "he can see it" means here.
 */
const RECOVER_SEEN = 90;

/* ------------------------------------------------------------------- */
/* timedDeliver tuning                                                  */
/* ------------------------------------------------------------------- */

/**
 * SECONDS PER METRE OF HAUL. One number, every timed delivery, story or side
 * job — which is the whole point of it.
 *
 * The two authored chapters were clocked by hand and the hands disagreed by a
 * factor of six. MEASURED off the shipped defs and POI table: Aidan CH 3 "Hot
 * Parts" runs to `shop_ammo` (384, -280) and is staged around the player, a
 * ~300 m haul on 88 s — 0.293 s/m. Carson CH 5 "Air Mail" runs to `ap_east`
 * (1032, -784), a 1959 m haul on 96 s — 0.049 s/m. The same player driving the
 * same way passes one with half a minute spare and cannot physically finish the
 * other, and nothing in either number says which is the intended difficulty.
 *
 * So the clock is derived from the job instead. Crow-flight, not road distance:
 * a route length is a second opinion about the same fact (rule 12's spatial
 * form) and it moves whenever the road graph is re-cut, so a chapter's clock
 * would silently change under a `world` edit. The road factor is baked in here.
 *
 * 0.14 s/m is ~7.1 m/s of crow-flight progress: a ~1.3x road factor over a
 * ~9.3 m/s (34 km/h) city average, which is what the streets actually deliver
 * with lights, corners and traffic. It puts CH 3 at 42 s and CH 5 at 274 s —
 * tighter than the authored 88 s on the short haul and four and a half times
 * the authored 96 s on the long one, which is the direction the defect was in.
 *
 * `armTimer` still scales by `DIFFS.timerMul`, so hard and steel squeeze both
 * chapters by the same fraction rather than one of them into impossibility.
 *
 * A gate on this must derive its own distance from the EMITTED spawn and the
 * destination POI; `M.timer` divided by a distance this file also computed is
 * a number compared to itself.
 */
const DELIVER_RATE = 0.14;

/* ------------------------------------------------------------------- */
/* chase tuning                                                         */
/* ------------------------------------------------------------------- */

/**
 * Seconds after the chase ARMS before `R.chaseLose` may end it. The same 2.5 s
 * `escape` gives the player before a zero-star frame can win it, and for the
 * mirror-image reason: a track whose verdict is read on frame one reads it
 * against the staging rather than against anything the player did.
 */
const CHASE_GRACE = 2.5;
/**
 * ...and the chase does not ARM until he is behind a wheel.
 *
 * MEASURED against the staging this track authors itself: the target spawns
 * 180-320 m out (`findRoadSpot(180, 320)`) and the courtesy car 10-45 m from
 * the player, who walks at 1.72 m/s and sprints at 6.4. A muscle car at full
 * throttle opens ~24 m/s on a man on foot, so from a 250 m start it crosses
 * `R.chaseLose` (620 m) in about 15 s — while the player is still walking to
 * the car the chapter told him to take. 2.5 s of grace cannot cover that and
 * no constant can, because the gap is a WALK, not a delay: so the target
 * loiters and the lose-distance is disarmed until he has driven something.
 *
 * The ceiling is the anti-wedge: a player who never gets into any car has the
 * chase start without him rather than a chapter that can never end.
 */
const CHASE_BOARD = 20;

/* ------------------------------------------------------------------- */
/* escort tuning                                                        */
/* ------------------------------------------------------------------- */

/**
 * The anti-hang bound, in seconds — a WATCHDOG, not a challenge.
 *
 * MEASURED on the only escort in the story — Aidan CH 5, sh_aidan (632,-464)
 * to sh_dylan (-504,432) over the Monongahela: the routed truck covers the
 * 2.2 km road distance in ~210 s of headless sim at throttle 0.62. 360 s is
 * 1.7x that, which is slack for the ambushers, the stuck recoveries and a
 * player who stops to fight, and is still a bound rather than a wait.
 *
 * ARMED AS A WATCHDOG (`armTimer`'s third argument), which is what keeps that
 * 1.7x true and what keeps it out of the payout. Difficulty-scaled it was
 * 259 s on steel — 1.23x the measured run, i.e. a chapter that could now be
 * lost on time where the author never gave it a clock at all. And `win` pays
 * `max(0, timer) * TIME_BONUS` for anything carrying `hasTimer`: MEASURED by
 * `escortprobe`, the routed truck reaches the drop with ~250 s still on this
 * clock, which was $1500 of time bonus on a $2900 authored purse. A bound the
 * code invented to stop a hang must cost the player nothing and pay him
 * nothing.
 */
const ESCORT_TIMER = 360;
/** Metres the truck must make in `STUCK_T` or it is wedged. */
const STUCK_MOVE = 3;
const STUCK_T = 8;
/** Ambush cars alive at once. Four converging was the second CH 5 blocker. */
const AMBUSH_MAX = 3;
/** Metres from the truck past which an ambusher is retired, not chased. */
const AMBUSH_DROP = 250;
/**
 * Ram damage per second, per car. Was 34 with no cap, so four of them took a
 * 520 HP truck down in under four seconds; at 18 the capped three take 29 s of
 * uninterrupted contact, which is a threat the player can answer.
 */
const AMBUSH_RAM = 18;
/** Seconds before a freed ambush slot is refilled. */
const AMBUSH_REFILL = 4;
/**
 * Past `vehicles.despawn`'s `isMission` cull-guard — the same door
 * `MissionRunner.cleanup` uses, and the only other caller authorised to open
 * it. Frozen and shared so the retirement path allocates nothing.
 */
const FORCE = Object.freeze({ force: true });

/* ------------------------------------------------------------------- */
/* reused steer options — rule 5: no `update` allocates a literal       */
/* ------------------------------------------------------------------- */

/** A rival's pace is per-car, so this one is written before every call. */
const RIVAL_OPTS = { throttle: 1, gain: 1.5 };
/** The chase target boosts only once the player is on its bumper. */
const FLEE_OPTS = { throttle: 1, boost: false };
/** Dylan, slow and complaining, easing off for the drop. */
const TRUCK_OPTS = Object.freeze({ throttle: 0.62, gain: 1.4, slow: 26 });
/** An ambusher has one setting. */
const RAM_OPTS = Object.freeze({ throttle: 1, boost: true });

/* ===================================================================== */
/* the objective eyebrow, shared                                          */
/* ===================================================================== */

export function trackOf(id) {
  return TRACKS[id] ?? null;
}
