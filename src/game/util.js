/**
 * GAME — the world adapter.
 *
 * Everything the mission layer needs to ask about Steel City, in one place, so
 * no track implementation has to know which subsystem answers which question or
 * what to do when one of them is still a stub.
 *
 * ARCHITECTURE.md rule 2: nothing here imports another subsystem. Every query
 * goes through `ctx.peek(id)` and every one has a defined answer when the
 * subsystem is missing — that is what lets the mission harness run a whole
 * chapter before `police` has landed.
 *
 * Rule 5: this module allocates nothing after `init`. All the Vector3s are
 * preallocated scratch; anything that returns a point returns a reused `{x,z}`
 * record unless the caller passes an `out`.
 */

import * as THREE from 'three';
import { POI, SAFEHOUSES, SHOPS, SHOPS_BY_KIND, GAS_STATIONS, DOCKS } from './data.js';

const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Shortest signed difference between two angles. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

export function dist2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

export function dist(ax, az, bx, bz) {
  return Math.sqrt(dist2(ax, az, bx, bz));
}

/** mm:ss for a mission clock. */
export function clockText(sec) {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _up = new THREE.Vector3();

/** Heading of a vehicle handle, radians, +Z forward to match `Math.atan2(dx,dz)`. */
export function yawOf(v) {
  if (!v?.quaternion) return 0;
  _q.copy(v.quaternion);
  _e.setFromQuaternion(_q, 'YXZ');
  return _e.y;
}

/**
 * How upright a vehicle handle is: +1 on its wheels, 0 on its side, -1 on its
 * roof. Read off the EMITTED orientation rather than any roll state the
 * dynamics keep, because a wedged car is exactly the case where the two stop
 * agreeing (rule 12).
 */
export function upDot(v) {
  if (!v?.quaternion) return 1;
  return _up.set(0, 1, 0).applyQuaternion(v.quaternion).y;
}

/**
 * Steer an AI-driven vehicle toward a point. The one place any mission actor
 * decides how to hold a wheel, so a rival, a fleeing target, an escort truck
 * and a boss all drive with the same physics-respecting logic.
 *
 * @param {object} veh   the `vehicles` subsystem
 * @param {object} v     the vehicle handle
 * @param {object} inp   a PREALLOCATED input record, reused by the caller
 */
export function driveToward(veh, v, inp, tx, tz, opts = {}) {
  if (!veh?.setInput || !v || v.destroyed) return 0;
  const dx = tx - v.position.x;
  const dz = tz - v.position.z;
  const d = Math.hypot(dx, dz);
  const err = wrapAngle(Math.atan2(dx, dz) - yawOf(v));
  const speed = Math.abs(v.forwardSpeed ?? 0);
  const slowRadius = opts.slow ?? 0;
  inp.steer = clamp(err * (opts.gain ?? 1.6), -1, 1);
  // Back off the throttle for a corner: full lock at 30 m/s just understeers.
  const corner = 1 - Math.min(0.72, Math.abs(err) * (speed / 34));
  inp.throttle = clamp((opts.throttle ?? 1) * corner, 0, 1);
  inp.brake = slowRadius > 0 && d < slowRadius ? clamp(1 - d / slowRadius, 0, 0.85) : 0;
  inp.handbrake = Math.abs(err) > 1.75 && speed > 15;
  inp.boost = !!opts.boost && Math.abs(err) < 0.5;
  veh.setInput(v, inp);
  return d;
}

/* ===================================================================== */
/* driveRoute — the same wheel, but the road graph picks where to point it */
/* ===================================================================== */

/**
 * Seconds between route solves for ONE vehicle.
 *
 * MEASURED on the emitted city (3141 nodes, 4399 edges): 400 random
 * node-to-node solves averaged 0.111 ms, worst 1.05 ms. The mission layer and
 * the pursuit fleet together never hold more than ~14 AI cars, so 1 Hz is
 * 1.6 ms of CPU per second of play. The leg-arrival test below is what keeps
 * the car on the road BETWEEN solves; the period only bounds how stale a plan
 * may get, and the solve always restarts from where the car actually is.
 */
const ROUTE_PERIOD = 1.0;
/** Aim at the first waypoint at least this far ahead — closer ones wobble. */
const LEG_MIN = 22;
/** Within this of the aimed waypoint, the leg is done: re-solve now. */
const LEG_ARRIVE = 12;
/**
 * Inside this range of the destination, drive straight at it. The last two
 * waypoints of any route are off-graph stubs anyway, and a `routeTo` call per
 * second for a boss circling the player 20 m away buys nothing.
 */
const ROUTE_MIN = 40;
/** The destination moving this far re-solves immediately rather than at 1 Hz. */
const DEST_MOVE = 40;
/**
 * A held leg waypoint further than this from the car cannot be ours. Vehicle
 * handles are POOLED (`vehicles.despawn` recycles them), so a cruiser can be
 * handed back to `heat` still carrying the route state of its previous life.
 * Nothing else notices, because a stale waypoint steers exactly like a live
 * one — it just points at a road on the other side of the city.
 */
const LEG_STALE = 220;

/** Reused steer options — `driveToward` reads them and returns. Rule 5. */
const _ropts = { throttle: 1, gain: 1.6, slow: 0, boost: false };
/** Reused `routeTo` options. `fromY` is what keeps a bridge deck off its quay. */
const _routeOpts = { fromY: 0, toY: NaN };
/** Solve-phase counter, so fourteen AI cars never all re-plan on one frame. */
let _routeSeq = 0;

/**
 * Steer an AI vehicle toward a distant point BY ROAD.
 *
 * `driveToward` is pure pursuit against a raw (x, z): correct for the last
 * forty metres and catastrophic over a kilometre, because Steel City is three
 * rivers and a hill and the straight line between two safehouses goes through
 * the Monongahela. This asks `world.routeTo` — the same graph `traffic` and
 * `police` drive on — for draw-ordered waypoints and feeds `driveToward` the
 * next one instead of the destination.
 *
 * THE RETURN VALUE IS THE DISTANCE TO THE FINAL DESTINATION, not to the leg.
 * Every caller uses it as a trigger radius (ram range, tracer range, "the
 * target got away"), and handing back the leg distance would fire all of them
 * at the wrong moment.
 *
 * NO ROAD GRAPH, NO ROUTE. A bench with no `world`, an endpoint in open water,
 * two ends on different islands: `routeTo` returns null and this falls through
 * to `driveToward` unchanged, which is what every headless probe of this file
 * exercises.
 *
 * @param {object} wq  the `WorldQuery` — `.vehicles` and `.world`
 * @param {object} v   the vehicle handle; route state is cached on it
 * @param {object} inp a PREALLOCATED input record, reused by the caller
 * @param {number} dt  seconds since the caller's last call for THIS vehicle
 */
export function driveRoute(wq, v, inp, tx, tz, dt, opts = EMPTY_OPTS) {
  const veh = wq?.vehicles;
  if (!veh?.setInput || !v || v.destroyed) return 0;
  const d = dist(v.position.x, v.position.z, tx, tz);
  const world = wq.world;
  let r = v._route;
  if (!r) {
    r = v._route = {
      t: (_routeSeq++ % 8) * (ROUTE_PERIOD / 8),
      have: false, final: false, x: 0, z: 0, tx, tz,
    };
  }
  r.t -= dt;

  if (!world?.routeTo || d < ROUTE_MIN) {
    r.have = false;
    return driveToward(veh, v, inp, tx, tz, opts);
  }
  if (r.have) {
    const leg = dist(v.position.x, v.position.z, r.x, r.z);
    if (leg < LEG_ARRIVE || leg > LEG_STALE) r.t = 0;
  }
  if (dist2(r.tx, r.tz, tx, tz) > DEST_MOVE * DEST_MOVE) r.t = 0;

  if (r.t <= 0 || !r.have) {
    r.t = ROUTE_PERIOD;
    r.tx = tx;
    r.tz = tz;
    r.have = false;
    _routeOpts.fromY = v.position.y;
    const path = world.routeTo(v.position.x, v.position.z, tx, tz, _routeOpts);
    if (path && path.length > 1) {
      let k = path.length - 1;
      for (let i = 1; i < path.length; i++) {
        if (dist2(path[i].x, path[i].z, v.position.x, v.position.z) >= LEG_MIN * LEG_MIN) { k = i; break; }
      }
      // COPY. `routeTo` hands back a REUSED array of reused records
      // (src/world/route.js) and the next caller this frame overwrites it.
      r.x = path[k].x;
      r.z = path[k].z;
      r.final = k === path.length - 1;
      r.have = true;
    }
  }
  if (!r.have) return driveToward(veh, v, inp, tx, tz, opts);

  _ropts.throttle = opts.throttle ?? 1;
  _ropts.gain = opts.gain ?? 1.6;
  _ropts.boost = !!opts.boost;
  // The slow radius is about ARRIVING. Applied to an intermediate junction
  // waypoint it brakes the car to a crawl at every corner of a 2 km route.
  _ropts.slow = r.final ? (opts.slow ?? 0) : 0;
  driveToward(veh, v, inp, r.x, r.z, _ropts);
  return d;
}

export class WorldQuery {
  constructor(ctx) {
    this.ctx = ctx;
    this.rng = ctx.rng.fork();

    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._spot = { x: 0, y: 0, z: 0, yaw: 0, ok: false };
    this._spot2 = { x: 0, y: 0, z: 0, yaw: 0, ok: false };
    this._lane = { x: 0, y: 0, z: 0, yaw: 0, ok: false };
    this._playerPos = new THREE.Vector3();
    this._half = 1400; // resolved from world.CITY_SIZE at init
  }

  init() {
    const w = this.world;
    if (w?.CITY_SIZE) this._half = w.CITY_SIZE / 2 - 60;
    return this;
  }

  /* ------------------------------------------------------------ systems -- */

  get world() { return this.ctx.peek('world'); }
  get player() { return this.ctx.peek('player'); }
  get vehicles() { return this.ctx.peek('vehicles'); }
  get peds() { return this.ctx.peek('peds'); }
  get police() { return this.ctx.peek('police'); }
  get traffic() { return this.ctx.peek('traffic'); }
  get ui() { return this.ctx.peek('ui'); }
  get audio() { return this.ctx.peek('audio'); }
  get physics() { return this.ctx.peek('physics'); }
  get weapons() { return this.ctx.peek('weapons'); }

  /* ------------------------------------------------------------- ground -- */

  /**
   * Best available floor height. `physics.groundHeight` casts against the real
   * static world (so it lands on a bridge deck, not the river below it);
   * `world.heightAt` is the analytic terrain fallback.
   */
  groundY(x, z, fromY = 260) {
    const ph = this.physics;
    if (ph?.groundHeight) {
      const h = ph.groundHeight(x, z, fromY);
      if (Number.isFinite(h) && h > -500) return h;
    }
    const w = this.world;
    if (w?.heightAt) {
      const h = w.heightAt(x, z);
      if (Number.isFinite(h)) return h;
    }
    return 0;
  }

  /**
   * The surface an OBJECTIVE floats on: the ground, or the water lying over it.
   *
   * `groundY` is the RIVERBED. `WATER_Y` is 0 and `RIVER_BED` is -11
   * (`src/world/plan.js`), so every marker, glow ring and figure the mission
   * layer put over water was drawn ~9 m under the surface — including Carson
   * CH 1's boat ring, which is the first objective a new save ever sees, and
   * every crate of his salvage chapter.
   *
   * ANYTHING THE PLAYER LOOKS AT GOES THROUGH THIS. Anything that has to touch
   * the ground — a capsule, a wheel, a spawn height — still goes through
   * `groundY`, because a hostile standing on the water is a different bug.
   */
  surfaceY(x, z, fromY = 260) {
    const g = this.groundY(x, z, fromY);
    const w = this.world?.waterLevelAt?.(x, z);
    return Number.isFinite(w) && w > g ? w : g;
  }

  isWater(x, z) {
    return this.world?.isWater?.(x, z) === true;
  }

  surfaceAt(x, z) {
    return this.world?.surfaceAt?.(x, z) ?? 'asphalt';
  }

  inBounds(x, z) {
    return Math.abs(x) < this._half && Math.abs(z) < this._half;
  }

  districtName(x, z) {
    return this.world?.districtAt?.(x, z)?.name ?? '';
  }

  /* ------------------------------------------------------------- player -- */

  /** Live player position (feet). Copied into scratch — safe to keep for a frame. */
  playerPos(out = this._playerPos) {
    const p = this.player;
    const src = p?.position ?? p?.getPosition?.();
    if (src && Number.isFinite(src.x)) return out.copy(src);
    return out.copy(this.ctx.camera.position);
  }

  /** Where the mission should measure from: the car if he is in one, else him. */
  focusPos(out = this._playerPos) {
    const p = this.player;
    if (p?.inVehicle && p.vehicle?.position) return out.copy(p.vehicle.position);
    return this.playerPos(out);
  }

  playerVehicle() {
    const p = this.player;
    return p?.inVehicle ? p.vehicle ?? null : null;
  }

  /**
   * Put the player's feet at (x, z) on the ground, facing `yaw`.
   *
   * `player.teleport` takes an EYE position — feet + stand-eye * body scale.
   *
   * He is dropped out of any vehicle first, and that is not a nicety. While
   * `player.inVehicle` is true, `focusPos` (and the camera, and every mission
   * distance check) reads the VEHICLE's position, not his — so teleporting a
   * seated player leaves the game measuring from a car that is still parked
   * a kilometre away. That is what made a `chase` staged at the boathouse
   * report "the target got away" on its first frame.
   */
  placePlayer(x, z, yaw = 0, yOverride = null) {
    const p = this.player;
    if (!p) return false;
    if (p.inVehicle) p.vehicles?.abort?.(p.movement);
    const y = yOverride ?? this.groundY(x, z) + 0.06;
    if (p.movement?.teleport) {
      p.movement.teleport(x, y, z, yaw);
      p.rig?.reset?.(p.movement.anchorHeight, p.movement.position, yaw);
      return true;
    }
    if (p.teleport) {
      const scale = p.brother?.build?.scale ?? 1;
      this._v.set(x, y + 1.66 * scale, z);
      p.teleport(this._v, yaw);
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- POI -- */

  poi(id) {
    return POI.get(id) ?? null;
  }

  nearestOf(list, x, z) {
    let best = null;
    let bd = Infinity;
    for (let i = 0; i < list.length; i++) {
      const d = dist2(x, z, list[i].x, list[i].z);
      if (d < bd) { bd = d; best = list[i]; }
    }
    if (!best) return null;
    this._near ??= { poi: null, dist: 0 };
    this._near.poi = best;
    this._near.dist = Math.sqrt(bd);
    return this._near;
  }

  nearestSafehouse(x, z) { return this.nearestOf(SAFEHOUSES, x, z); }
  nearestGas(x, z) { return this.nearestOf(GAS_STATIONS, x, z); }
  nearestShop(x, z, kind) {
    // NOTE: `nearestOf` returns a REUSED record. Read `.poi`/`.dist` off it
    // before calling this again or the second call overwrites the first.
    return this.nearestOf(kind ? (SHOPS_BY_KIND[kind] ?? SHOPS) : SHOPS, x, z);
  }

  /* --------------------------------------------------------- spawn spots -- */

  /**
   * A dry, road-adjacent point in an annulus around `(cx, cz)`.
   *
   * The annulus radii come in as real metres and the road test goes through
   * the road graph, so a mission car spawns ON a lane rather than in somebody's
   * front room.
   */
  findRoadSpot(min, max, cx, cz, out = this._spot) {
    const roads = this.world?.roads;
    out.ok = false;
    /** Best OFF-annulus road point seen, in case nothing legal ever lands. */
    let bx = 0, bz = 0, byaw = 0, bPen = Infinity;
    for (let i = 0; i < 120; i++) {
      const a = this.rng.float() * TAU;
      const r = lerp(min, max, this.rng.float());
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (!this.inBounds(x, z) || this.isWater(x, z)) continue;
      if (!roads?.nearestEdge) {
        out.x = x; out.z = z; out.y = this.groundY(x, z); out.yaw = a; out.ok = true;
        return out;
      }
      const hit = roads.nearestEdge(x, z, 40);
      if (!this._drivableTo(hit)) continue;
      // Snap onto the lane centre so nothing spawns half on the kerb.
      let px = x, pz = z, pyaw = a;
      if (roads.laneCenter) {
        const t = clamp01(typeof hit.t === 'number' ? hit.t : 0.5);
        roads.laneCenter(hit.edge.id ?? hit.edge, hit.lane ?? 0, t, this._v);
        if (this.isWater(this._v.x, this._v.z)) continue;
        px = this._v.x;
        pz = this._v.z;
        pyaw = roads.laneYaw ? roads.laneYaw(hit.edge, hit.lane ?? 0) : a;
      }
      /**
       * THE SNAP MUST NOT BREAK THE PROMISE. The sample above is inside the
       * annulus, but `nearestEdge` searches 40 m and `laneCenter` moves the
       * point onto the road — so the RETURNED spot could sit anywhere from
       * 0 m to `max + 40` m out. MEASURED on requests for 22-30 m: answers at
       * 1.5 m (a cruiser materialising against the player's hip) and 52.7 m —
       * and 52.7 m is past the 35 m kill-attribution window (`ATTRIB_VEH_NEAR`,
       * freeroam.js), which made the playtest's cop-kill reward checks flake
       * 1-in-3: a wreck staged "22-30 m away" landed 36-53 m away, and the
       * reward path — correctly, per the same anti-clairvoyance rule the
       * ped-kill check asserts — refused to pay for it. Re-measure the SNAPPED
       * point against the caller's own annulus and keep sampling when the road
       * pulled it outside; the nearest miss is kept as a last resort so a
       * road-sparse area still gets a road-legal spot rather than nothing.
       */
      const d = Math.hypot(px - cx, pz - cz);
      const pen = d < min ? min - d : d > max ? d - max : 0;
      if (pen > 0) {
        if (pen < bPen) { bPen = pen; bx = px; bz = pz; byaw = pyaw; }
        continue;
      }
      out.x = px;
      out.z = pz;
      out.yaw = pyaw;
      out.y = this.groundY(out.x, out.z);
      out.ok = true;
      return out;
    }
    // Roads exist around here, just none whose lane centre falls inside the
    // ring that was asked for: hand back the closest road point found. It is
    // drivable and legal — merely off-annulus, exactly what every caller got
    // on EVERY answer before the recheck above existed.
    if (bPen < Infinity) {
      out.x = bx; out.z = bz; out.yaw = byaw;
      out.y = this.groundY(bx, bz);
      out.ok = true;
      return out;
    }
    /**
     * Nothing legal in the ring at all. This is what an anchor ON THE WATER
     * looks like — a pier, a boss arena on a marina — and the old answer was a
     * jittered point at `min` from that anchor, i.e. still in the river.
     * Ask the graph for the nearest lane to the ANCHOR instead and snap to it.
     * `ok` stays false because the annulus was not honoured, but the answer is
     * a carriageway rather than the riverbed.
     */
    const far = roads?.nearestEdge ? roads.nearestEdge(cx, cz, ANCHOR_ROAD_REACH) : null;
    if (this._drivableTo(far) && roads.laneCenter) {
      const t = clamp01(typeof far.t === 'number' ? far.t : 0.5);
      roads.laneCenter(far.edge.id ?? far.edge, far.lane ?? 0, t, this._v);
      out.x = this._v.x;
      out.z = this._v.z;
      out.y = this.groundY(out.x, out.z);
      out.yaw = roads.laneYaw ? roads.laneYaw(far.edge, far.lane ?? 0) : 0;
      out.ok = false;
      return out;
    }
    // No road graph at all (a bench with no `world`): a jittered point near the
    // anchor so a mission still starts rather than silently spawning nothing.
    const a = this.rng.float() * TAU;
    out.x = cx + Math.cos(a) * min;
    out.z = cz + Math.sin(a) * min;
    out.y = this.groundY(out.x, out.z);
    out.yaw = a;
    out.ok = false;
    return out;
  }

  /**
   * Is this `nearestEdge` hit somewhere a CAR may be put?
   *
   * `roads.nearestEdge` answers with the nearest edge of any kind, and two of
   * those kinds are not road: mill trackage (`rail`) is in the graph so
   * `roadmesh` can draw ballast, and — until `netgen.closeNetwork` — a stranded
   * fragment no car can reach. A mission that spawns its marked car on either
   * is a mission that cannot be completed, and neither failure says anything
   * when it happens.
   */
  _drivableTo(hit) {
    const e = hit?.edge;
    if (!e || e.rail) return false;
    const roads = this.world?.roads;
    const main = roads?.driveMain;
    if (main === undefined || main < 0) return true;
    const n = roads.nodes[e.a];
    return !n || n.component === undefined || n.component === main;
  }

  /** A dry point that need not be near a road — crates, enemies, hold points. */
  findGroundSpot(min, max, cx, cz, out = this._spot2) {
    out.ok = false;
    for (let i = 0; i < 140; i++) {
      const a = this.rng.float() * TAU;
      const r = lerp(min, max, this.rng.float());
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (!this.inBounds(x, z) || this.isWater(x, z)) continue;
      if (this.world?.isOpen && !this.world.isOpen(x, z, 1.2)) continue;
      out.x = x; out.z = z; out.y = this.groundY(x, z); out.yaw = a; out.ok = true;
      return out;
    }
    /**
     * 140 samples and not one of them was dry, open ground. Handing the caller
     * back the point it asked about is how a `protect` ward, a boss and every
     * wave of hostiles came to stand on the riverbed: MEASURED at the South
     * Side Docks, 2160 samples of the 5-12 m annulus and ZERO dry ones, and
     * the old fallback returned (cx, cz) — 8.8 m under the Monongahela — with
     * `ok` false that nobody reads.
     *
     * Fall through to the road resolver. It is the same annulus, it never
     * returns water, and its own last resort is the nearest lane to the anchor
     * — pavement is not the verge this asked for, but it is ground.
     */
    return this.findRoadSpot(min, max, cx, cz, out);
  }

  /**
   * A point ON a river — Carson's salvage crates and the boat deliveries.
   *
   * `nearShore` matters more than it looks: a boat moored in the middle of the
   * Mon is a boat you cannot get to on foot, and Carson's first chapter is a
   * boat delivery. When it is set the point must have dry land within
   * `SHORE_REACH`, which is what makes the mission reachable.
   */
  findWaterSpot(min, max, cx, cz, out = this._spot2, nearShore = false) {
    out.ok = false;
    for (let i = 0; i < 220; i++) {
      const a = this.rng.float() * TAU;
      const r = lerp(min, max, this.rng.float());
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      if (!this.inBounds(x, z)) continue;
      if (!this.isWater(x, z)) continue;
      if (nearShore && !this._shoreWithin(x, z, SHORE_REACH)) continue;
      out.x = x; out.z = z; out.y = 0; out.yaw = a; out.ok = true;
      return out;
    }
    if (nearShore) return this.findWaterSpot(min, max, cx, cz, out, false);
    // No water within reach: fall back to the nearest dock's PIER HEAD, which
    // is over water by construction — that is what the coordinate on a `DOCKS`
    // record is, and why the dry point beside it is a separate `stage` field.
    const d = this.nearestOf(DOCKS, cx, cz);
    out.x = d.poi.x; out.z = d.poi.z; out.y = 0; out.yaw = 0;
    return out;
  }

  /** Is there dry land within `r` of this water point? Eight-way probe. */
  _shoreWithin(x, z, r) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      if (!this.isWater(x + Math.cos(a) * r, z + Math.sin(a) * r)) return true;
    }
    return false;
  }

  /** Kerbside pose next to a POI — where a mission or safehouse car appears. */
  curbSpot(x, z, out = this._spot) {
    return this.findRoadSpot(14, 70, x, z, out);
  }

  /**
   * The nearest drivable LANE CENTRE to a point, or null.
   *
   * `findRoadSpot` is the annulus version — "put a car somewhere near here".
   * This is the unwedge version: "where I stand is not a road, name the road".
   * Same `_drivableTo` filter, so it never answers with mill trackage or a
   * stranded fragment, and never with a lane centre that is under water.
   *
   * The record is REUSED. Read it before the next call.
   */
  nearestLane(x, z, out = this._lane) {
    out.ok = false;
    const roads = this.world?.roads;
    if (!roads?.nearestEdge || !roads.laneCenter) return null;
    const hit = roads.nearestEdge(x, z, LANE_REACH);
    if (!this._drivableTo(hit)) return null;
    const id = hit.edge.id ?? hit.edge;
    const lane = hit.lane ?? 0;
    const t = clamp01(typeof hit.t === 'number' ? hit.t : 0.5);
    roads.laneCenter(id, lane, t, this._v);
    if (this.isWater(this._v.x, this._v.z)) return null;
    out.x = this._v.x;
    out.z = this._v.z;
    out.y = this.groundY(out.x, out.z);
    out.yaw = roads.laneYaw ? roads.laneYaw(id, lane) : 0;
    out.ok = true;
    return out;
  }

  /**
   * Put a wedged AI vehicle back on the nearest lane, upright and stopped.
   *
   * `setPose` is the ONE published way to relocate a `Vehicle`: it clears the
   * velocity, the angular velocity, every wheel's suspension state and the
   * drivetrain, so the car does not arrive still carrying the spin that put it
   * on its roof. Writing `position` alone leaves all of that intact and the
   * car re-wedges within a second.
   *
   * @returns {boolean} true if it was moved.
   */
  unwedgeVehicle(v, ride = 0.6) {
    if (typeof v?.setPose !== 'function') return false;
    const lane = this.nearestLane(v.position.x, v.position.z);
    if (!lane) return false;
    this._v2.set(lane.x, lane.y + ride, lane.z);
    v.setPose(this._v2, lane.yaw);
    return true;
  }

  /* ------------------------------------------------------------ vehicles -- */

  /**
   * Spawn a mission vehicle. Returns the handle or null. `type` is a
   * `vehicles` class id: sports muscle sedan van truck police bike boat.
   */
  spawnVehicle(type, x, z, yaw = 0, opts) {
    const veh = this.vehicles;
    if (!veh?.spawn) return null;
    const water = type === 'boat';
    const y = water ? (veh.waterHeightAt?.(x, z) ?? 0) + 0.4 : this.groundY(x, z) + 0.6;
    this._v.set(x, y, z);
    return veh.spawn(type, this._v, yaw, opts ?? EMPTY_OPTS);
  }

  despawnVehicle(v, opts) {
    if (v) this.vehicles?.despawn?.(v, opts);
  }

  damageVehicle(v, amount, point) {
    if (v && !v.destroyed) this.vehicles?.damage?.(v, amount, point);
  }

  /* -------------------------------------------------------------- audio -- */

  sfx(kind, position, opts) {
    const a = this.audio;
    if (!a?.play) return;
    try { a.play(kind, position ?? null, opts); } catch { /* optional feedback */ }
  }

  uiSfx(id, gain = 1) {
    const a = this.audio;
    if (!a) return;
    try {
      if (a.playUi) a.playUi(id, gain);
      else if (a.ui) a.ui(id, gain);
    } catch { /* optional feedback */ }
  }
}

const EMPTY_OPTS = Object.freeze({});

/** How far a moored boat may sit from a bank and still be walkable-to. */
const SHORE_REACH = 22;

/**
 * How far `findRoadSpot` will reach from the ANCHOR when its whole annulus was
 * illegal. Generous on purpose: this only runs when the anchor itself is in a
 * river or walled in, and the alternative answer is the riverbed. The widest
 * gap between a pier head and the nearest lane in the authored table is 75 m
 * (`dock_point`), so 400 m is slack, not a target.
 */
const ANCHOR_ROAD_REACH = 400;

/**
 * How far `nearestLane` will search. A wedged car is by definition somewhere it
 * should not be — a forecourt, a verge, the back of a lot — but it got there by
 * driving, so the road it left is close. 80 m covers the widest reservation in
 * the plan without reaching across a river.
 */
const LANE_REACH = 80;
