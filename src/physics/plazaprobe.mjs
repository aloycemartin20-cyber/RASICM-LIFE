#!/usr/bin/env node
/**
 * PLAZA PROBE — does `physics.groundHeight` answer the surface a man actually
 * ends up standing on, on a raised pavement whose collision has not arrived?
 *
 *   node src/physics/plazaprobe.mjs
 *   node src/physics/plazaprobe.mjs --verbose
 *   node src/physics/plazaprobe.mjs --frames=800
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * `groundHeight` took one down-ray on `MASK.WORLD` and believed it. Two things
 * in the shipped city put a pavement out of that ray's reach:
 *
 *   1. `world`'s corridor floor and its city-wide safety net are registered on
 *      `LAYER.CLIP`, which is in `MASK.CHARACTER` and deliberately in NEITHER
 *      `MASK.WORLD` nor `MASK.BULLET` (ARCHITECTURE, the collision contract).
 *      A capsule stands on sheets the height query is blind to.
 *   2. The road and pavement collision sectors are AMORTISED build jobs
 *      (`world._pumpColSector`), while the terrain patch is rebuilt IMMEDIATELY
 *      when the camera teleports — deliberately, so nobody falls through the
 *      world on a jump. Between the teleport and that job finishing, the only
 *      thing under a pavement on `MASK.WORLD` is the terrain: sunk 0.55 m under
 *      every corridor, sampled on an 8 m grid, and further down on a graded
 *      bench. The same state is PERMANENT outside the 320 m collision patch,
 *      which is where every distant traffic and police spawn is scored.
 *
 * A shot stages its actor at `shot:applied` — inside that window — and the
 * shutter fires after `streamingIdle()`, i.e. after the sector has landed. So
 * the query is answered in one collision state and the frame is photographed in
 * another, and the number that matters is whether the query agreed with the
 * state the picture was taken in.
 *
 * MEASURED in the game at the `character` shot's mark (`src/dev/shots.js`): the
 * ray answered 2.2 m under the pavement, the staged capsule went under it,
 * resolved upward, and slid 4.7 m sideways over ~800 frames — putting the
 * subject's head three screen half-widths outside the frame.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES (hard rule 12)
 * ---------------------------------------------------------------------------
 * NOT `groundHeight` against `walkableHeightAt`. That is the very number the
 * fix reads, and comparing it with itself would prove nothing whatever.
 *
 * The reference is WHERE A REAL CAPSULE ENDS UP: a `CharacterController` is
 * staged at whatever the query answered, stepped under gravity, and the
 * pavement's collision sector is registered part way through the settle — the
 * arrival the real streamer schedules. Every number below comes off that
 * capsule's emitted position, solved by the triangle solver against geometry
 * `groundHeight` cannot see on any mask it is ever called with.
 *
 * The site, which is `world`'s own construction at 1/100 scale:
 *
 *      y = D        the pavement, arriving MID-SETTLE on LAYER.STATIC
 *      y = D        the same surface on LAYER.CLIP (world's corridor floor and
 *      y = D-0.73   safety net: resident from boot, invisible to MASK.WORLD)
 *      y = D-2.20   the terrain patch on LAYER.STATIC — what the ray finds
 *
 * plus a bridge deck on STATIC above one corner: the case the correction must
 * not touch.
 *
 * WHAT IS STUBBED, and therefore what this cannot see: `world` is a plain
 * object publishing `walkableHeightAt` / `surfaceAt`, so this proves nothing
 * about whether the real city's authored surface is in the right PLACE — only
 * that physics consumes it correctly. `src/world/` owns the former.
 *
 * NEGATIVE CONTROL, run in the same process against the same site:
 * `physics.debugWalkableFloor = false` restores the raw ray, and the two
 * `control.*` gates assert the defect comes back — the staged man ends up
 * metres from where the query put him. If they ever pass quietly, this file is
 * measuring the harness rather than the fix.
 */
import * as THREE from 'three';
import { PhysicsSystem } from './index.js';
import { LAYER } from './surfaces.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const VERBOSE = !!args.verbose;
const FRAMES = Number(args.frames ?? 800);
/** Frame at which the amortised pavement sector lands. */
const SECTOR_AT = Number(args.sectorAt ?? 120);
const DT = 1 / 120;

let failures = 0;
let checks = 0;
const rec = (name, ok, detail = '') => {
  checks++;
  if (!ok) failures++;
  if (!ok || VERBOSE) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  }
};
const f2 = (n) => (Number.isFinite(n) ? n.toFixed(2) : String(n));
const f3 = (n) => (Number.isFinite(n) ? n.toFixed(3) : String(n));

/* ====================================================================== */
/* THE SITE                                                               */
/* ====================================================================== */

/** Plaza extent, metres, centred on the origin. */
const HALF = 24;
/** The authored walkable surface: a raised pavement on a 2% camber. */
const deckAt = (x, z) => 4.2 + x * 0.02 + z * 0.01;
/** How far under it the streamed terrain patch reads, as measured in game. */
const UNDER_READ = 2.2;
const terrainAt = (x, z) => deckAt(x, z) - UNDER_READ;
/** `world`'s corridor floor: CLIP, `FLOOR_SINK` under the carriageway. */
const floorAt = (x, z) => deckAt(x, z) - 0.73;
/** The bridge deck over one corner — STATIC, above the pavement. */
const BRIDGE = { x0: 12, x1: 22, z0: 12, z1: 22, y: 9.0 };

/** A grid mesh over the plaza from a height function. */
function sheet(name, heightFn, step = 4) {
  const n = Math.round((HALF * 2) / step) + 1;
  const pos = new Float32Array(n * n * 3);
  const idx = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -HALF + i * step;
      const z = -HALF + j * step;
      const k = (j * n + i) * 3;
      pos[k] = x;
      pos[k + 1] = heightFn(x, z);
      pos[k + 2] = z;
      if (i < n - 1 && j < n - 1) {
        const a = j * n + i;
        idx.push(a, a + n, a + n + 1, a, a + n + 1, a + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  m.name = name;
  m.matrixAutoUpdate = false;
  m.updateMatrixWorld(true);
  return m;
}

/** The collision state a teleport leaves behind: no pavement sector yet. */
function buildSite(walkFn = deckAt) {
  const phys = new PhysicsSystem();
  phys.addStatic(sheet('terrain', terrainAt, 8), 'dirt');
  phys.addStatic(sheet('corridor_floor', floorAt, 4), 'concrete', { mask: LAYER.CLIP });
  const br = new THREE.Mesh(
    new THREE.PlaneGeometry(BRIDGE.x1 - BRIDGE.x0, BRIDGE.z1 - BRIDGE.z0).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial()
  );
  br.position.set((BRIDGE.x0 + BRIDGE.x1) / 2, BRIDGE.y, (BRIDGE.z0 + BRIDGE.z1) / 2);
  br.name = 'bridge';
  br.updateMatrixWorld(true);
  phys.addStatic(br, 'metal');
  phys.rebuildStatic();
  phys.ground.bind({
    walkableHeightAt: (x, z) => walkFn(x, z),
    surfaceAt: () => 'sidewalk',
  });
  return phys;
}

/** The amortised sector landing: the pavement becomes real collision. */
function landPavement(phys) {
  phys.addStatic(sheet('pavement', deckAt, 4), 'concrete');
  phys.rebuildStatic();
}

/* ====================================================================== */
/* WHERE A REAL CAPSULE ENDS UP — the independent reference               */
/* ====================================================================== */

/**
 * Stage a capsule with its feet at `feetY` and step it under gravity, landing
 * the pavement sector at `SECTOR_AT` exactly as the streamer would. Returns the
 * emitted start and end poses and the length of the path between them.
 */
function settle(phys, x, z, feetY) {
  const c = phys.createCharacter({ position: new THREE.Vector3(x, feetY, z) });
  c.teleport(x, feetY, z);
  const start = { x: c.position.x, y: c.position.y, z: c.position.z };
  let vy = 0;
  let path = 0;
  let px = c.position.x, pz = c.position.z;
  for (let i = 0; i < FRAMES; i++) {
    if (i === SECTOR_AT) landPavement(phys);
    vy = c.grounded ? -0.4 : vy - 9.81 * DT;
    c.move(0, vy * DT, 0);
    // PATH LENGTH, not displacement: a capsule that squirts out of a wedge and
    // comes back reads zero on a straight-line measure.
    path += Math.hypot(c.position.x - px, c.position.z - pz);
    px = c.position.x; pz = c.position.z;
  }
  const end = { x: c.position.x, y: c.position.y, z: c.position.z };
  phys.removeCharacter(c);
  return {
    requested: feetY, start, end, path,
    plan: Math.hypot(end.x - start.x, end.z - start.z),
    /** How far the man had to travel from the mark he was staged on. */
    travel: Math.abs(end.y - feetY),
  };
}

/* ====================================================================== */
/* THE RUN                                                                */
/* ====================================================================== */

/** The mark: off the bridge, on the raised pavement. */
const MARK = { x: -6, z: 4 };
const DECK = deckAt(MARK.x, MARK.z);

function arm(fixed) {
  const phys = buildSite();
  phys.debugWalkableFloor = fixed;
  // Where a shot camera sits over the mark, which is what sets the ray origin.
  const gh = phys.groundHeight(MARK.x, MARK.z, DECK + 3.4 + 8);
  return { phys, gh, settle: settle(phys, MARK.x, MARK.z, gh + 0.03) };
}

console.log('\nRAISED-PLAZA GROUND QUERY');

const fix = arm(true);
const raw = arm(false);

if (VERBOSE) {
  console.log(`  authored pavement ${f3(DECK)} m · corridor floor ${f3(floorAt(MARK.x, MARK.z))} m` +
    ` · terrain patch ${f3(terrainAt(MARK.x, MARK.z))} m`);
  console.log(`  fixed  groundHeight ${f3(fix.gh)}  staged ${f3(fix.settle.start.y)}` +
    ` -> rest ${f3(fix.settle.end.y)}  moved ${f3(fix.settle.plan)} m in plan, path ${f3(fix.settle.path)} m`);
  console.log(`  raw    groundHeight ${f3(raw.gh)}  staged ${f3(raw.settle.start.y)}` +
    ` -> rest ${f3(raw.settle.end.y)}  moved ${f3(raw.settle.plan)} m in plan, path ${f3(raw.settle.path)} m`);
}

/**
 * 1. THE GATE THAT MATTERS. `groundHeight` never sees the CLIP sheets and does
 *    not wait for the pavement sector; the capsule solver sees both and nothing
 *    else. They have to agree about where the man is standing when the shutter
 *    opens.
 */
rec('plaza.agrees', Math.abs(fix.gh - fix.settle.end.y) < 0.06,
  `groundHeight ${f3(fix.gh)} m vs where the capsule ends up, ${f3(fix.settle.end.y)} m ` +
  `(delta ${f3(Math.abs(fix.gh - fix.settle.end.y))} m)`);

/**
 * 2. So the man staged there STAYS there. This is the property a review frame
 *    actually needs: the camera is composed against a pose, and if the pose has
 *    to travel afterwards the picture is of somewhere else.
 */
rec('plaza.staged', fix.settle.travel < 0.08,
  `staged at ${f3(fix.settle.requested)} m, ends at ${f3(fix.settle.end.y)} m ` +
  `(${f3(fix.settle.travel)} m of unrequested travel)`);

/**
 * 3. ...and he does not wander in plan over the settle a capture waits out.
 *    NOT a discriminator: this synthetic site is two clean sheets, so the
 *    reverted arm resolves straight up and reads the same. The 4.7 m squirt the
 *    game measured needs the real mark's kerbs and shopfronts to resolve
 *    against, and inventing them here to manufacture a number would be worse
 *    than reporting that this cannot see them.
 */
rec('plaza.still', fix.settle.plan < 0.10 && fix.settle.path < 0.25,
  `${f3(fix.settle.plan)} m from the mark after ${FRAMES} frames ` +
  `(path length ${f3(fix.settle.path)} m)`);

/**
 * 4-6. THE NEGATIVE CONTROL, same site, same process: the raw ray, which is the
 * shipped behaviour this replaces. Each of the three gates above has to come
 * back red on it.
 */
rec('control.underreads', Math.abs((fix.gh - raw.gh) - UNDER_READ) < 0.05,
  `the raw ray answers ${f3(raw.gh)} m, ${f3(fix.gh - raw.gh)} m under the pavement ` +
  `(the game measured 2.2 m at the character mark)`);
rec('control.notwhereitsaid', Math.abs(raw.gh - raw.settle.end.y) > 1.5,
  `the query put him at ${f3(raw.gh)} m and he ends at ${f3(raw.settle.end.y)} m — ` +
  `${f3(Math.abs(raw.gh - raw.settle.end.y))} m out`);
rec('control.travels', raw.settle.travel > 1.5,
  `${f3(raw.settle.travel)} m of unrequested travel after the shot camera was ` +
  `composed on him (the fixed arm: ${f3(fix.settle.travel)} m)`);

/* ---------------------------------------------------------------------- */
console.log('\nTHE GUARDS — what the correction must never touch');

const p = buildSite();

/** A ray that finds something ABOVE the authored surface keeps it. */
const bx = (BRIDGE.x0 + BRIDGE.x1) / 2, bz = (BRIDGE.z0 + BRIDGE.z1) / 2;
const onDeck = p.groundHeight(bx, bz, BRIDGE.y + 20);
rec('guard.above', Math.abs(onDeck - BRIDGE.y) < 0.02,
  `on the bridge deck: ${f3(onDeck)} m (deck ${f2(BRIDGE.y)}, pavement ${f2(deckAt(bx, bz))})`);

/**
 * A query that STARTS UNDER the authored surface is never lifted onto it —
 * the tunnel / car-park / bridge-soffit case, and the whole reason the
 * correction is guarded on `fromY` instead of applied blind.
 */
const underY = DECK - 1.0;
const under = p.groundHeight(MARK.x, MARK.z, underY);
rec('guard.under', Math.abs(under - terrainAt(MARK.x, MARK.z)) < 0.05,
  `from ${f3(underY)} m (below the deck) the answer stays on the triangle at ${f3(under)} m`);

/**
 * A SETTLED WORLD IS LEFT ALONE. Once the road sector has landed, the ray and
 * the authored surface disagree by camber and an 8 m grid — MEASURED in the
 * live city on a 10 m sample grid, median 0.028 m and p90 0.107 m — and
 * "correcting" that would float every decal, puddle and tyre mark off the
 * asphalt. Same site, with the pavement's STATIC collision present.
 */
// A pavement authored 12 cm above its own collision: the worst honest
// disagreement measured in the settled city (0.124 m at spawn 0).
const settledPhys = buildSite((x, z) => deckAt(x, z) + 0.124);
landPavement(settledPhys);
const settledY = settledPhys.groundHeight(MARK.x, MARK.z, DECK + 12);
rec('guard.settled', Math.abs(settledY - DECK) < 0.01 && settledPhys.walkableFloorLifts === 0,
  `a 0.124 m disagreement is ignored: ${f3(settledY)} m, the pavement's own ` +
  `triangles (${settledPhys.walkableFloorLifts} lifts)`);

/** A mask with no STATIC bit in it is not a ground question. */
const noStatic = p.groundHeight(MARK.x, MARK.z, 40, LAYER.PROP);
rec('guard.mask', !Number.isFinite(noStatic),
  `a mask without LAYER.STATIC returns ${String(noStatic)}`);

/** Off the map the proxy answers NaN and the ray stands unaltered. */
const off = p.groundHeight(9000, 9000, 40);
rec('guard.offmap', !Number.isFinite(off), `${String(off)} at (9000, 9000)`);

/** No `world` at all — every node bench — behaves exactly as before. */
const bare = new PhysicsSystem();
bare.addStatic(sheet('terrain', terrainAt, 8), 'dirt');
bare.rebuildStatic();
const bareY = bare.groundHeight(MARK.x, MARK.z, 40);
rec('guard.noworld', Math.abs(bareY - terrainAt(MARK.x, MARK.z)) < 0.05,
  `an unbound ground proxy answers the raw ray, ${f3(bareY)} m`);

/** The correction is counted, so a session can see how often it fires. */
rec('guard.counted', fix.phys.walkableFloorLifts > 0 && raw.phys.walkableFloorLifts === 0,
  `${fix.phys.walkableFloorLifts} lifts on the fixed arm, ` +
  `${raw.phys.walkableFloorLifts} on the reverted one`);

console.log(`\nplazaprobe: ${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
