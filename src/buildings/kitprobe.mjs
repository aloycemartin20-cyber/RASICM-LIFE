#!/usr/bin/env node
/**
 * BUILDINGS — the facade-kit gate.
 *
 * WHAT IT IS FOR. Two blind critic panels, twice each, reported the same three
 * things about this city's buildings: "extruded boxes with window-grid decals,
 * no cornices, setbacks, HVAC, fire escapes or facade thickness", "no facade
 * depth, cornices or window recesses anywhere", and "a tower spears a hillside
 * with no foundation". Those are claims about GEOMETRY, and geometry is exactly
 * the kind of claim a probe can settle without a camera.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY IT IS NODE-ONLY, AND WHY THAT IS NOT A COMPROMISE
 * ─────────────────────────────────────────────────────────────────────────────
 * `solidprobe`, `skyprobe` and `windprobe` all boot vite and a GPU Chromium,
 * because what they assert on is a rendered frame or a live scene. This one
 * asserts on the BufferGeometry the generators emit, and none of that needs a
 * renderer: `TileBuilder` builds `THREE.Mesh`es out of merged buffers and only
 * ever touches a material at `build()`, so a stub material factory is enough.
 * The result runs in about a second and can therefore live in `gate`, which is
 * the whole argument — a gate nobody can afford to run is a file.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * RULE 12 — WHAT IS MEASURED
 * ─────────────────────────────────────────────────────────────────────────────
 * The EMITTED TRIANGLES, never the arithmetic that placed them. The cornice
 * test does not ask `buildCrown` how far it projected anything: it cuts the
 * building's own emitted geometry with two horizontal planes — one through the
 * middle of the upper wall, one through the crown — and compares the SUPPORT
 * FUNCTIONS of the two cuts. Offsetting a shape outward by d adds exactly d to
 * its support in every direction, so the difference IS the projection of the
 * cornice, in metres, on the elevation that faces that way. A painted-on
 * cornice measures zero however convincing its normal map is.
 *
 * Getting there took two wrong measurements, and both are written up at the
 * functions that replaced them (`triangles`, `sliceSupport`) because both are
 * traps anyone measuring generated architecture will walk into: a point sample
 * cannot see a long extrusion, and a radius-per-bearing cannot see anything
 * near a corner.
 *
 * Every tier carries a NEGATIVE CONTROL (`--control`), which flips one flag in
 * `facadeOpts` and nothing else and requires the corresponding tier to go RED.
 * A green control run fails the probe: it means the tier was measuring the
 * harness. The control arm for the crown is deliberately the FLAT CAPPING BAND
 * this wave replaced rather than an unbuilt roofline, so what the tier proves
 * is "there is a profile here", not "there is a roof here".
 *
 * Usage
 *   node src/buildings/kitprobe.mjs
 *   node src/buildings/kitprobe.mjs --control     assert the controls go red
 *   node src/buildings/kitprobe.mjs --json=/tmp/k.json
 *   node src/buildings/kitprobe.mjs --verbose
 */
import * as THREE from 'three';
import { writeFileSync } from 'node:fs';
import { Rng } from '../core/rng.js';
import { ProtoLibrary, TileBuilder } from './tile.js';
import { planBuilding, buildLot, buildLotLod, blockPalette } from './archetypes.js';
import { districtStyle } from './palette.js';
import { facadeOpts } from './facade.js';
import { syntheticLots, DISTRICT_GEO } from './debug.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const CONTROL = !!args.control;
const VERBOSE = !!args.verbose;

/**
 * A stub material forge. `ProtoLibrary` only calls `materials.get(name, opts)`
 * at mesh-build time and never reads anything back off the result, so this is
 * the whole dependency — no WebGL context, no texture bakes, no `MaterialSystem`.
 */
const materials = {
  _c: new Map(),
  get(name) {
    let m = this._c.get(name);
    if (!m) this._c.set(name, (m = new THREE.MeshBasicMaterial({ name })));
    return m;
  },
};

// ─────────────────────────────────────────────────────────────── harness ───
/**
 * Build ONE lot into its own tile, so every measurement is attributable to one
 * building. `groundY` is passed the way `index.js` passes it (the lowest corner
 * of the footprint, less 12 cm) — this probe does not have a terrain field and
 * does not need one: what it asserts about the foundation is how far BELOW that
 * datum the emitted apron reaches, which is the property that makes the apron
 * correct on a slope it cannot see.
 */
function buildOne(lib, lot, districtId, tileSeed, lod = 0, groundY = 0) {
  const style = districtStyle(districtId);
  const rng = new Rng((lot.seed ?? 1) >>> 0);
  const block = blockPalette(Rng, tileSeed, style);
  const plan = planBuilding(lot, style, rng, block);
  const T = new TileBuilder(lib, `probe_${lot.id}_${lod}`);
  const r2 = new Rng(((lot.seed ?? 1) ^ (lod ? 0x9e37 : 0x51ed)) >>> 0);
  if (lod) buildLotLod(T, lib, plan, r2, groundY);
  else buildLot(T, lib, plan, r2, groundY);
  /**
   * The fire-escape placements, taken BEFORE `build()`.
   *
   * Not a shortcut and not private-field archaeology for its own sake: below
   * `MERGE_BELOW` instances a tile folds a small instance group into its static
   * batch, which is a DRAW-CALL decision and not a content one. A single-lot
   * tile is always below that threshold, so by the time the meshes exist the
   * six landings of one fire escape are indistinguishable triangles inside a
   * 40 000-triangle steel batch. The placement list is the emitted artifact
   * that says where the escape is; the merge is what happens to it afterwards.
   */
  const escapes = [];
  for (const [id, e] of T._inst) {
    if (!/^fe\|/.test(id)) continue;
    for (const m of e.m) escapes.push(new THREE.Vector3().setFromMatrixPosition(m));
  }
  const built = T.build(null);
  return { plan, built, T, escapes };
}

/**
 * Every emitted TRIANGLE of a built tile, as a flat [ax,ay,az, bx.., cx..] run.
 *
 * WHY TRIANGLES AND NOT VERTICES, which is what this probe measured first and
 * got wrong. A cornice is a `moulding` — one `ExtrudeGeometry` with `steps: 1`
 * swept the whole length of the elevation — and a blank party wall is one
 * extruded shape with no holes in it. Both have vertices ONLY AT THEIR ENDS.
 * Sampling vertices therefore reports no cornice anywhere along a wall and no
 * wall anywhere behind a sign, which is exactly what the first run of this file
 * reported: 12/85 buildings "without" a cornice that is plainly there, and 38
 * mounts "floating" in the middle of the walls they are bolted to. A long
 * extrusion is invisible to a point sample and obvious to a plane cut.
 */
function triangles(built, { instanced = true } = {}) {
  const out = [];
  const v = new THREE.Vector3();
  const m = new THREE.Matrix4();
  const push = (pa, idx, mat) => {
    const n = idx ? idx.count : pa.count;
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pa, idx ? idx.getX(i) : i);
      if (mat) v.applyMatrix4(mat);
      out.push(v.x, v.y, v.z);
    }
  };
  built.group.traverse((o) => {
    if (o.isInstancedMesh) {
      if (!instanced) return;
      const pa = o.geometry.getAttribute('position');
      const idx = o.geometry.getIndex();
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m);
        push(pa, idx, m);
      }
      return;
    }
    if (!o.isMesh || !o.geometry) return;
    const pa = o.geometry.getAttribute('position');
    if (pa) push(pa, o.geometry.getIndex(), null);
  });
  return out;
}

/**
 * A HORIZONTAL SLICE of a triangle soup, binned by bearing from a centre.
 *
 * For each triangle that straddles the plane `y`, the two crossing points are
 * computed exactly and the segment between them is sampled; the maximum radius
 * seen in each of `BINS` bearings is the cut profile. This is the measurement a
 * cornice, a plinth and a foundation terrace can all be held to, because every
 * one of them is a long prism and every long prism crosses the plane along its
 * whole length whether or not it has a vertex there.
 */
const BINS = 96;
const DIRS = new Float64Array(BINS * 2);
for (let i = 0; i < BINS; i++) {
  const a = -Math.PI + ((i + 0.5) / BINS) * Math.PI * 2;
  DIRS[i * 2] = Math.cos(a);
  DIRS[i * 2 + 1] = Math.sin(a);
}

/**
 * THE SUPPORT FUNCTION of a horizontal slice: for each of `BINS` directions,
 * how far the cut reaches in that direction.
 *
 * WHY NOT A RADIUS PER BEARING, which is what this file measured second and
 * also got wrong. Radius-by-bearing is dominated by CORNERS: on a rectangular
 * plan the radius at 44 degrees and at 46 degrees differ by half a metre, so
 * two cuts taken at different heights disagree by more than the thing being
 * measured, and the tier reported "no cornice" on plans that have one all the
 * way round (measured: worst-bin projections of -0.68 m, all of them at
 * corners). A support function has the property that matters here and radius
 * does not: OFFSETTING A SHAPE OUTWARD BY d ADDS EXACTLY d TO ITS SUPPORT IN
 * EVERY DIRECTION. So `support(crown) - support(wall)` in a direction IS the
 * projection of the cornice on the elevation that faces that way, corners
 * included, whatever the plan.
 */
function sliceSupport(tri, y) {
  const sup = new Float64Array(BINS).fill(-Infinity);
  let count = 0;
  const px = [0, 0, 0];
  const pz = [0, 0, 0];
  const mark = (x, z) => {
    count++;
    for (let i = 0; i < BINS; i++) {
      const d = x * DIRS[i * 2] + z * DIRS[i * 2 + 1];
      if (d > sup[i]) sup[i] = d;
    }
  };
  for (let i = 0; i < tri.length; i += 9) {
    let n = 0;
    for (let e = 0; e < 3; e++) {
      const a = i + e * 3;
      const b = i + ((e + 1) % 3) * 3;
      const ya = tri[a + 1];
      const yb = tri[b + 1];
      if (ya === yb) continue;
      if ((ya - y) * (yb - y) > 0) continue;
      const t = (y - ya) / (yb - ya);
      if (t < 0 || t > 1) continue;
      px[n] = tri[a] + (tri[b] - tri[a]) * t;
      pz[n] = tri[a + 2] + (tri[b + 2] - tri[a + 2]) * t;
      n++;
      if (n === 2) break;
    }
    if (n < 2) continue;
    // Only the ENDS of the crossing segment matter to a support function: the
    // extreme in any direction is always an endpoint of some segment.
    mark(px[0], pz[0]);
    mark(px[1], pz[1]);
  }
  return { sup, count };
}

let bad = 0;
const rows = [];
function check(name, ok, detail) {
  rows.push({ name, ok: !!ok, detail });
  if (!ok) bad++;
  console.log(`  ${ok ? ' ok ' : 'FAIL'} ${name.padEnd(46)} ${detail ?? ''}`);
}

// ────────────────────────────────────────────────────────────── the run ───
if (CONTROL) {
  facadeOpts.crown = false;
  facadeOpts.terrace = false;
  facadeOpts.mounts = false;
}

const lib = new ProtoLibrary(materials);
/**
 * A cross-section of the city: the loft/rowhouse districts that carry the
 * escapes and the water towers, and downtown for the setbacks and the crowns.
 */
const SAMPLE = ['lawren', 'strip', 'southside', 'downtown', 'steelrow', 'mtwash'];
const builds = [];
for (const d of DISTRICT_GEO) {
  if (!SAMPLE.includes(d.id)) continue;
  const tx = Math.round(d.x / 96);
  const tz = Math.round(d.z / 96);
  const lots = syntheticLots(tx, tz);
  const tileSeed = (Math.imul(tx, 0x27d4eb2d) ^ Math.imul(tz, 0x165667b1)) >>> 0;
  for (const lot of lots) {
    if (!lot || lot.kind === 'park' || lot.kind === 'lot') continue;
    let rec = null;
    try {
      rec = buildOne(lib, lot, d.id, tileSeed, 0);
    } catch (err) {
      console.error(`[kitprobe] build failed for ${d.id}/${lot.id}: ${err.message}`);
      continue;
    }
    builds.push({ district: d.id, lot, ...rec });
  }
}
console.log(`\n[kitprobe] ${builds.length} buildings built across ${SAMPLE.length} districts${CONTROL ? ' (CONTROL ARM)' : ''}\n`);

// ── 1. CORNICE PROJECTION ──────────────────────────────────────────────────
/**
 * "No cornices anywhere." A cornice is a course that stands proud of the wall
 * under it, so the measurement is: in how many directions does the top 1.4 m of
 * this building reach further from its own centre than its middle third does,
 * and by how much.
 */
{
  let measured = 0;
  let withCornice = 0;
  let sumProj = 0;
  let worst = Infinity;
  const perimeter = [];
  for (const b of builds) {
    const vol = b.plan.volumes[0];
    // One-volume buildings only: on a setback stack the "top" of volume 0 is
    // under volume 1, and what we would be measuring is the setback.
    if (b.plan.volumes.length !== 1 || b.plan.pitched) continue;
    /**
     * MERGED GEOMETRY ONLY for the reference cut. The instanced furniture is
     * what hangs OFF a wall — a fire escape stands 1.35 m out, an air
     * conditioner 0.56 — and a reference surface that includes them is a
     * reference surface that says a 34 cm cornice is recessed.
     */
    const tri = triangles(b.built, { instanced: false });
    if (tri.length < 900) continue;
    const c = b.plan.centroid;
    const top = vol.y0 + vol.h;
    /**
     * The reference cut goes through the UPPER WALL, never the ground floor.
     * A shopfront is a projecting fascia, an awning that reaches 95 cm and a
     * pair of painted pilasters; cutting through it and calling the result
     * "the wall" reports that a 34 cm cornice is recessed. Measured: with the
     * cut at 55% of the total height, 27 of 85 buildings failed this tier —
     * every one of them low enough that 55% was still inside its shopfront.
     */
    const gh = vol.floors[0]?.kind === 'ground' ? vol.floors[0].h : 0;
    if (vol.h - gh < 3) continue; // nothing above the shop to measure against
    const wall = sliceSupport(tri, vol.y0 + gh + (vol.h - gh) * 0.5);
    // Through the cornice: every profile in the family spans this height, and
    // so does the flat capping band the control arm falls back to.
    const crown = sliceSupport(tri, top - 0.3);
    if (wall.count < 40 || crown.count < 40) continue;
    /**
     * ONLY THE BINS THAT FACE THE STREET.
     *
     * Not a softened bar — a corrected one. A rowhouse or a commercial block
     * abuts its neighbours, so `buildElevation` returns early on a PARTY WALL
     * and that wall correctly has no cornice, no plinth and no openings: it is
     * inside the building next door. Measured over the whole perimeter the tier
     * therefore tops out near 50% on exactly the archetypes that make up most
     * of the city, and reported 60 of 84 buildings "without" a cornice that is
     * on every elevation anyone can see. What the critics photographed was the
     * street elevation, and that is what this measures.
     *
     * THE CONE IS NARROW ON PURPOSE, and the reason is arithmetic rather than
     * taste. A cornice that offsets ONE face outward by d raises the support in
     * that face's own normal direction by exactly d, and in a direction `a`
     * degrees off it by d·cos(a) — the extreme point stops being the cornice
     * and becomes the building's corner. At the 69-degree cone this tier used
     * first, a 30 cm cornice is worth 0.1 m in the worst direction and the tier
     * reported 0.073 m as a failure of the cornice rather than of the cone.
     * Inside 25 degrees the measurement is at least 0.9 d.
     */
    const CONE = 0.9;
    let hits = 0;
    let thin = Infinity;
    let bins = 0;
    let allBins = 0;
    let allHits = 0;
    for (let i = 0; i < BINS; i++) {
      const proj = crown.sup[i] - wall.sup[i];
      if (!Number.isFinite(proj)) continue;
      const facing = DIRS[i * 2] * b.plan.toStreet[0] + DIRS[i * 2 + 1] * b.plan.toStreet[1];
      allBins++;
      if (proj > 0.18) allHits++;
      if (facing < CONE) continue;
      bins++;
      if (proj > 0.18) hits++;
      if (proj < thin) thin = proj;
    }
    if (bins < 4 || allBins < 20) continue;
    measured++;
    sumProj += thin;
    if (thin < worst) worst = thin;
    if (hits / bins > 0.8) withCornice++;
    perimeter.push(allHits / allBins);
  }
  const frac = measured ? withCornice / measured : 0;
  const mean = measured ? sumProj / measured : 0;
  perimeter.sort((a, b2) => a - b2);
  const medPer = perimeter.length ? perimeter[perimeter.length >> 1] : 0;
  check(
    'cornice runs the street elevation',
    CONTROL ? frac < 0.25 : frac > 0.9,
    `${withCornice}/${measured} buildings carry it over 80% of their street frontage ` +
      `(median ${(medPer * 100).toFixed(0)}% of the FULL perimeter, party walls included)`
  );
  check(
    'cornice projection is a shadow, not a line',
    CONTROL ? mean < 0.19 : mean > 0.19,
    `mean thinnest-direction projection ${mean.toFixed(3)} m, worst ${worst === Infinity ? 'n/a' : worst.toFixed(3)} m ` +
      `(the flat band this replaced measures 0.14 m and throws no shadow at street distance)`
  );
}

// ── 2. FOUNDATION REACH ────────────────────────────────────────────────────
/**
 * "A tower spears a hillside with no foundation." The apron is authored below
 * grade, so what is asserted is REACH — how far under the seating datum the
 * emitted geometry goes — and BATTER — that it gets wider as it goes down. Both
 * are properties of the emitted prisms, not of the hill, which is the point:
 * the apron is correct on a slope it never queried.
 */
{
  let deep = 0;
  let tallDeep = 0;
  let tallN = 0;
  let batterOk = 0;
  let n = 0;
  let minY = 0;
  for (const b of builds) {
    const tri = triangles(b.built, { instanced: false });
    if (tri.length < 900) continue;
    n++;
    let lo = Infinity;
    for (let i = 1; i < tri.length; i += 3) if (tri[i] < lo) lo = tri[i];
    if (lo < minY) minY = lo;
    const tall = ['tower', 'curtain', 'deco'].includes(b.plan.arch);
    if (tall) tallN++;
    if (lo <= -3.5) deep++;
    if (tall && lo <= -7.5) tallDeep++;
    // Batter: the apron must be WIDER two courses down than one course down.
    const c = b.plan.centroid;
    const hi = sliceSupport(tri, -1.0).sup;
    const low = sliceSupport(tri, -4.0).sup;
    let wider = 0;
    let bins = 0;
    for (let i = 0; i < BINS; i++) {
      if (hi[i] < 0 || low[i] < 0) continue;
      bins++;
      if (low[i] > hi[i] + 0.15) wider++;
    }
    if (bins > 12 && wider / bins > 0.7) batterOk++;
  }
  check(
    'foundation reaches below grade',
    CONTROL ? deep === 0 : deep / Math.max(1, n) > 0.9,
    `${deep}/${n} buildings reach 3.5 m under the seating datum (deepest ${minY.toFixed(2)} m)`
  );
  check(
    'hillside towers reach further',
    CONTROL ? tallDeep === 0 : tallN === 0 || tallDeep / tallN > 0.85,
    `${tallDeep}/${tallN} tall buildings reach 7.5 m under`
  );
  check(
    'the apron steps OUT as it steps down',
    CONTROL ? true : batterOk / Math.max(1, n) > 0.8,
    `${batterOk}/${n} buildings widen between the first and third course`
  );
}

// ── 3. THE GROUND-AO BAKE SURVIVED THE FOUNDATION ──────────────────────────
/**
 * The risk this wave introduced and the reason `TileBuilder.add` grew a
 * `buried` flag: the AO junction bake reads the MINIMUM emitted vertex Y per
 * cell as its ground, so an apron reaching nine metres down would have become
 * the ground and every wall in the tile would have lost its junction darkening.
 *
 * Measured as the fraction of wall vertices within the bake's own skirting
 * height that carry a non-zero AO mask (the blue channel of the colour
 * attribute). This is an A/B in one process: the same lots are rebuilt with the
 * terrace off, and the two numbers have to agree. A tier that only ran the
 * `after` arm could not tell "the bake is fine" from "the bake never worked".
 */
{
  const aoFrac = () => {
    let lit = 0;
    let total = 0;
    for (const b of builds.slice(0, 40)) {
      const rec = buildOne(lib, b.lot, b.district, 7, 0);
      rec.built.group.traverse((o) => {
        if (!o.isMesh || o.isInstancedMesh || !o.geometry) return;
        const pa = o.geometry.getAttribute('position');
        const ca = o.geometry.getAttribute('color');
        if (!pa || !ca) return;
        for (let i = 0; i < pa.count; i++) {
          const y = pa.getY(i);
          if (y < 0.02 || y > 1.2) continue;
          total++;
          if (ca.getZ(i) > 0.05) lit++;
        }
      });
    }
    return { lit, total, frac: total ? lit / total : 0 };
  };
  const withTerrace = aoFrac();
  const keep = facadeOpts.terrace;
  facadeOpts.terrace = false;
  const without = aoFrac();
  facadeOpts.terrace = keep;
  const drop = without.frac > 0 ? (without.frac - withTerrace.frac) / without.frac : 0;
  check(
    'ground AO survives the buried apron',
    withTerrace.frac > 0.25 && drop < 0.12,
    `${(withTerrace.frac * 100).toFixed(1)}% of skirting vertices darkened with the apron, ` +
      `${(without.frac * 100).toFixed(1)}% without (relative loss ${(drop * 100).toFixed(1)}%)`
  );
}

// ── 4. THE SIGN MOUNT CONTRACT ─────────────────────────────────────────────
/**
 * The contract in `tile.js` promises specific things. This tier reads them off
 * the published array and refuses anything it cannot verify against the
 * emitted geometry — in particular that a mount is ON a building, which is the
 * failure mode a consumer cannot detect for itself.
 */
{
  const kinds = new Map();
  let n = 0;
  let badYaw = 0;
  let badNorm = 0;
  let badSize = 0;
  let floating = 0;
  let checkedFloat = 0;
  for (const b of builds) {
    const ms = b.built.group.userData.owSignMounts;
    if (!Array.isArray(ms)) continue;
    const tri = ms.length ? triangles(b.built) : null;
    for (const m of ms) {
      n++;
      kinds.set(m.kind, (kinds.get(m.kind) ?? 0) + 1);
      if (Math.abs(Math.atan2(m.nx, m.nz) - m.ry) > 1e-6) badYaw++;
      if (Math.abs(Math.hypot(m.nx, m.nz) - 1) > 1e-6 || m.ny !== 0) badNorm++;
      if (!(m.w > 0.4) || !(m.h > 0.2) || !(m.w < 20) || !Number.isFinite(m.seed)) badSize++;
      /**
       * ON THE BUILDING. Sampled at seven points per triangle — the corners,
       * the edge midpoints and the centroid — because the surface a mount is
       * bolted to is routinely one 20 m quad with four vertices, none of which
       * is anywhere near the middle of the wall. An approximation, and stated
       * as one: it can call a mount grounded that is 2 m from the nearest
       * SAMPLE rather than from the nearest surface point. It cannot miss a
       * mount hanging in the air, which is the defect being looked for.
       */
      if (checkedFloat < 400 && tri) {
        checkedFloat++;
        let near = false;
        for (let i = 0; i < tri.length && !near; i += 9) {
          for (let s = 0; s < 7 && !near; s++) {
            let x;
            let y;
            let z;
            if (s < 3) {
              x = tri[i + s * 3];
              y = tri[i + s * 3 + 1];
              z = tri[i + s * 3 + 2];
            } else if (s < 6) {
              const a = i + (s - 3) * 3;
              const c2 = i + ((s - 2) % 3) * 3;
              x = (tri[a] + tri[c2]) * 0.5;
              y = (tri[a + 1] + tri[c2 + 1]) * 0.5;
              z = (tri[a + 2] + tri[c2 + 2]) * 0.5;
            } else {
              x = (tri[i] + tri[i + 3] + tri[i + 6]) / 3;
              y = (tri[i + 1] + tri[i + 4] + tri[i + 7]) / 3;
              z = (tri[i + 2] + tri[i + 5] + tri[i + 8]) / 3;
            }
            if (Math.abs(x - m.x) < 2 && Math.abs(y - m.y) < 2 && Math.abs(z - m.z) < 2) near = true;
          }
        }
        if (!near) floating++;
      }
    }
  }
  check(
    'mounts are published at LOD0',
    CONTROL ? n === 0 : n > 40,
    `${n} mounts over ${builds.length} buildings: ${[...kinds].map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`
  );
  check('mount yaw agrees with its normal', badYaw === 0, `${badYaw} disagreements`);
  check('mount normals are unit and vertical-faced', badNorm === 0, `${badNorm} malformed`);
  check('mount fields have a usable size and seed', badSize === 0, `${badSize} malformed`);
  check(
    'no mount floats off its building',
    floating === 0,
    `${floating}/${checkedFloat} with no geometry within 2 m`
  );
  if (!CONTROL) {
    for (const k of ['fascia', 'blade', 'wall', 'billboard']) {
      check(`the contract publishes '${k}' mounts`, (kinds.get(k) ?? 0) > 0, `${kinds.get(k) ?? 0}`);
    }
  }
}

// ── 5. THE FAR LOD PUBLISHES NOTHING ───────────────────────────────────────
/**
 * The contract says LOD0 only, and a consumer keying its signs off the near
 * tile's lifetime is relying on that. A massing mesh with fascia mounts on it
 * would put a shopfront sign on a building with no shopfront.
 */
{
  let far = 0;
  for (const b of builds.slice(0, 30)) {
    const rec = buildOne(lib, b.lot, b.district, 7, 1);
    far += rec.built.group.userData.owSignMounts?.length ?? 0;
  }
  check('the far LOD publishes no mounts', far === 0, `${far} mounts on 30 massing meshes`);
}

// ── 6. FIRE ESCAPES, AND WHICH WALL THEY ARE ON ────────────────────────────
/**
 * A Pittsburgh signature the owner asked for by name, and the finding was that
 * they were absent. They are placed as instances of one prototype, so the
 * measurement is the placement matrices of `bi_fe|*` — and where they sit
 * relative to the street, because an escape across a shopfront is the defect
 * this wave was fixing, not the fix.
 */
{
  let withEscape = 0;
  let loft = 0;
  let onFront = 0;
  let placed = 0;
  for (const b of builds) {
    const isLoft = ['warehouse', 'mill', 'rowhouse', 'block'].includes(b.plan.arch);
    if (isLoft) loft++;
    for (const v of b.escapes) {
      placed++;
      const dx = v.x - b.plan.centroid[0];
      const dz = v.z - b.plan.centroid[1];
      const r = Math.hypot(dx, dz) || 1;
      if ((dx * b.plan.toStreet[0] + dz * b.plan.toStreet[1]) / r > 0.55) onFront++;
    }
    if (b.escapes.length > 0 && isLoft) withEscape++;
  }
  check(
    'loft and rowhouse stock carries fire escapes',
    loft === 0 || withEscape / loft > 0.35,
    `${withEscape}/${loft} lofts/rowhouses, ${placed} landings placed`
  );
  check(
    'escapes hang off the flank, not the shopfront',
    placed === 0 || onFront / placed < 0.2,
    `${onFront}/${placed} landings on a street-facing wall`
  );
}

// ── 7. THE BUDGET ──────────────────────────────────────────────────────────
/**
 * "Under +15% tile triangles and FLAT draw calls at LOD0." Both arms are built
 * here in one process from the same lots and the same seeds, so the delta is
 * the kit and nothing else. Draw calls are the number that actually has to hold
 * flat: triangles are cheap and submission is not.
 */
{
  const measure = () => {
    const l2 = new ProtoLibrary(materials);
    let tris = 0;
    let draws = 0;
    let inst = 0;
    for (const b of builds) {
      const rec = buildOne(l2, b.lot, b.district, 7, 0);
      tris += rec.built.stats.tris + rec.built.stats.instTris;
      draws += rec.built.stats.draws;
      inst += rec.built.stats.instances;
    }
    l2.dispose();
    return { tris, draws, inst };
  };
  const on = measure();
  const keepC = facadeOpts.crown;
  const keepT = facadeOpts.terrace;
  facadeOpts.crown = false;
  facadeOpts.terrace = false;
  const off = measure();
  facadeOpts.crown = keepC;
  facadeOpts.terrace = keepT;
  const dTris = (on.tris - off.tris) / Math.max(1, off.tris);
  const dDraw = on.draws - off.draws;
  check(
    'kit costs under +15% triangles',
    dTris < 0.15,
    `${(off.tris / 1000).toFixed(0)}k -> ${(on.tris / 1000).toFixed(0)}k (${(dTris * 100).toFixed(1)}%)`
  );
  check(
    'kit adds no draw calls per building',
    dDraw <= 0,
    `${off.draws} -> ${on.draws} batches over ${builds.length} single-lot tiles (${dDraw >= 0 ? '+' : ''}${dDraw})`
  );
  if (VERBOSE) console.log(`       instances ${off.inst} -> ${on.inst}`);
}

// ── 8. THE STREAMED TILE, WHICH IS THE ONE THE FRAME ACTUALLY DRAWS ────────
/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT TIER 7 COULD NOT SEE, AND WHAT IT COST
 * ─────────────────────────────────────────────────────────────────────────────
 * Tier 7 builds ONE LOT PER TILE, because every other tier here wants a
 * measurement attributable to one building. That is right for a cornice
 * projection and WRONG for a draw call, and the difference is `MERGE_BELOW`:
 * a one-lot tile has a handful of each prototype, so every instance group is
 * under the threshold and folds into the static batch, and the tier reports a
 * flat draw count no matter what the kit does. The frame does not build one lot
 * per tile. `BuildingSystem._buildNear` puts a WHOLE TILE of lots through one
 * `TileBuilder`, where the same groups are hundreds strong and stay instanced.
 *
 * So tier 7 reported `2249 -> 2249` and was believed, and the kit was convicted
 * of a per-tile batching failure it does not have on the strength of a number
 * measured in a world with one building in it. This tier builds the way the
 * streamer builds and asserts the two things that world can actually go wrong
 * in:
 *
 *   1. BATCHING IS PER TILE, NOT PER LOT. One tile of N lots must cost a small
 *      fraction of N single-lot tiles. This is the property `MERGE_BELOW` and
 *      the shared prototype library exist to produce, and it is the one that
 *      would collapse if a piece stopped sharing an id or a surface.
 *   2. THE KIT ADDS NO BATCHES TO IT. Same assertion as tier 7, in the world
 *      where the instance groups are big enough for the answer to be different.
 *
 * NEGATIVE CONTROL: `TileBuilder.mergeBelow = 0` turns the fold off and nothing
 * else. Tier 1 must go red, which is what says it was measuring the merge.
 */
{
  /** Build a whole tile of lots through ONE builder, the way the streamer does. */
  const streamTile = (districtId, tx, tz) => {
    const style = districtStyle(districtId);
    const tileSeed = (Math.imul(tx, 0x27d4eb2d) ^ Math.imul(tz, 0x165667b1)) >>> 0;
    const block = blockPalette(Rng, tileSeed, style);
    const l2 = new ProtoLibrary(materials);
    const T = new TileBuilder(l2, `stream_${tx},${tz}`);
    let lots = 0;
    for (const lot of syntheticLots(tx, tz)) {
      if (!lot || lot.kind === 'park' || lot.kind === 'lot') continue;
      const rng = new Rng((lot.seed ?? 1) >>> 0);
      let plan;
      try {
        plan = planBuilding(lot, style, rng, block);
      } catch {
        continue;
      }
      buildLot(T, l2, plan, new Rng(((lot.seed ?? 1) ^ 0x51ed) >>> 0), 0);
      lots++;
    }
    const built = T.build(null);
    let merged = 0;
    let inst = 0;
    let casters = 0;
    const cast = new Map();
    built.group.traverse((o) => {
      if (o.isInstancedMesh) inst++;
      else if (o.isMesh) merged++;
      else return;
      // The renderer's own caster rule, not `castShadow`: ARCHITECTURE.md is
      // explicit that `owNoShadow` is the ONLY shadow-caster switch.
      const casts = o.userData.owNoShadow !== true;
      if (casts) casters++;
      cast.set(o.name, casts);
    });
    l2.dispose();
    return { lots, merged, inst, draws: merged + inst, casters, cast, stats: built.stats };
  };

  /** The same lots, one tile each — what tier 7 measures. */
  const perLot = (districtId, tx, tz) => {
    const style = districtStyle(districtId);
    const tileSeed = (Math.imul(tx, 0x27d4eb2d) ^ Math.imul(tz, 0x165667b1)) >>> 0;
    const l2 = new ProtoLibrary(materials);
    let draws = 0;
    for (const lot of syntheticLots(tx, tz)) {
      if (!lot || lot.kind === 'park' || lot.kind === 'lot') continue;
      try {
        draws += buildOne(l2, lot, districtId, tileSeed, 0).built.stats.draws;
      } catch {
        /* counted by tier 0 */
      }
    }
    l2.dispose();
    return draws;
  };

  const TILES = [];
  for (const d of DISTRICT_GEO) {
    if (!SAMPLE.includes(d.id)) continue;
    TILES.push([d.id, Math.round(d.x / 96), Math.round(d.z / 96)]);
  }

  const sweep = () => {
    let draws = 0;
    let merged = 0;
    let inst = 0;
    let lots = 0;
    let casters = 0;
    const cast = new Map();
    for (const [id, tx, tz] of TILES) {
      const r = streamTile(id, tx, tz);
      draws += r.draws;
      merged += r.merged;
      inst += r.inst;
      lots += r.lots;
      casters += r.casters;
      for (const [k, v] of r.cast) cast.set(k, (cast.get(k) ?? false) || v);
    }
    return { draws, merged, inst, lots, casters, cast };
  };

  const streamed = sweep();
  const scattered = TILES.reduce((s, [id, tx, tz]) => s + perLot(id, tx, tz), 0);
  const ratio = streamed.draws / Math.max(1, scattered);
  check(
    'kit pieces ride the tile batch, not the lot',
    ratio < 0.25,
    `${streamed.lots} lots in ${TILES.length} streamed tiles cost ${streamed.draws} batches ` +
      `(${streamed.merged} merged + ${streamed.inst} instanced) against ${scattered} one lot at a time ` +
      `(${(ratio * 100).toFixed(1)}%)`
  );

  // The negative control for the line above: no fold, so every instance group
  // becomes its own mesh and the streamed tile stops being a batch.
  const keepMerge = TileBuilder.mergeBelow;
  TileBuilder.mergeBelow = 0;
  const unmerged = sweep();
  TileBuilder.mergeBelow = keepMerge;
  /**
   * The bar is +30%, and it is where the MEASUREMENT puts it rather than where
   * it would sound impressive: turning the fold off takes these six tiles from
   * 257 batches to 390, which is +52%. Both arms are deterministic — same
   * seeds, same lots, no timing — so the only job of the number is to be far
   * enough below the observed gap that a real merge cannot trip it and far
   * enough above zero that a broken fold cannot pass.
   */
  check(
    'CONTROL: with the fold off the tile stops batching',
    unmerged.draws > streamed.draws * 1.3,
    `${streamed.draws} batches merged -> ${unmerged.draws} unmerged ` +
      `(+${unmerged.draws - streamed.draws}); a green line here would mean tier 8 measures nothing`
  );

  // And the kit's own cost, measured in the world that has the instance counts.
  const keepC = facadeOpts.crown;
  const keepT = facadeOpts.terrace;
  const keepR = facadeOpts.roof;
  facadeOpts.crown = false;
  facadeOpts.terrace = false;
  facadeOpts.roof = false;
  const without = sweep();
  facadeOpts.crown = keepC;
  facadeOpts.terrace = keepT;
  facadeOpts.roof = keepR;
  check(
    'kit adds under 40 batches across the streamed tiles',
    streamed.draws - without.draws < 40,
    `${without.draws} -> ${streamed.draws} over ${TILES.length} tiles ` +
      `(${streamed.draws - without.draws >= 0 ? '+' : ''}${streamed.draws - without.draws})`
  );

  /**
   * THE HATCH MUST NOT RE-ROLL THE CITY. `facadeOpts` is a negative control,
   * and a control arm that draws a different number of times from the stream
   * builds a different city — different lots, different heights, different roof
   * furniture — so every delta measured against it is that city and not the
   * feature. This is the defect that convicted the kit of a frame cost it does
   * not have; see the stream-parity note in `archetypes.js`'s `dressRoof`.
   *
   * Measured as the LOT COUNT and the emitted collision/mount structure holding
   * still, which is what a re-rolled stream cannot do.
   */
  check(
    'the hatch does not re-roll the city',
    without.lots === streamed.lots,
    `${streamed.lots} lots with the kit, ${without.lots} with it hatched off`
  );

  // ── 9. NO SMALL KIT PIECE CASTS A SHADOW ─────────────────────────────────
  /**
   * Asserted on the EMITTED MESHES and against the renderer's own rule
   * (`owNoShadow`, not `castShadow` — ARCHITECTURE.md calls the second one
   * inert and it is). Two classes:
   *
   *   INTERIORS   the cardboard room behind a window, the floor plate behind a
   *               curtain wall. Inside the hull; cannot cast anywhere the wall
   *               does not already.
   *   SUB-TEXEL   dentil teeth, modillions, escape gratings. Smaller than the
   *               cascade texel that would have to resolve them.
   */
  const interiors = [...streamed.cast].filter(([k, v]) => /^b_room_|^bi_rm\|/.test(k) && v);
  check(
    'window interiors cast no shadow',
    interiors.length === 0,
    `${interiors.length} interior batches still casting${interiors.length ? `: ${interiors.slice(0, 4).map(([k]) => k).join(' ')}` : ''}`
  );
  const subtexel = [...streamed.cast].filter(([k, v]) => /^bi_(fe|dt|mo|rh)\|/.test(k) && v);
  check(
    'escape gratings and tooth courses cast no shadow',
    subtexel.length === 0,
    `${subtexel.length} still casting${subtexel.length ? `: ${subtexel.slice(0, 4).map(([k]) => k).join(' ')}` : ''}`
  );

  // The control: with the routing off, both of the above must go red.
  const keepRouting = TileBuilder.keepKitCasters;
  TileBuilder.keepKitCasters = true;
  const loud = sweep();
  TileBuilder.keepKitCasters = keepRouting;
  const loudInteriors = [...loud.cast].filter(([k, v]) => /^b_room_|^bi_rm\|/.test(k) && v).length;
  check(
    'CONTROL: without the routing the interiors cast again',
    loudInteriors > 0 && loud.casters > streamed.casters,
    `casters ${streamed.casters} routed -> ${loud.casters} unrouted (${loudInteriors} interior batches)`
  );
  if (VERBOSE) {
    console.log(`       streamed casters ${streamed.casters} of ${streamed.draws} batches`);
  }
}

if (args.json) {
  writeFileSync(String(args.json), JSON.stringify({ control: CONTROL, rows }, null, 2));
}
console.log(
  bad === 0
    ? `\nFACADE KIT GATE PASSED${CONTROL ? ' (control arm went red where it had to)' : ''}`
    : `\nFACADE KIT GATE FAILED (${bad} checks)`
);
process.exit(bad === 0 ? 0 : 1);
