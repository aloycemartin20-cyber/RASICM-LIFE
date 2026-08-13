/**
 * WORLD — the city plan.
 *
 * Every authored number for Steel City lives here, already converted to world
 * metres. DESIGN.md gives legacy coordinates over a ~700 m map; the whole city
 * is scaled by K = 4 so it becomes a 3 km open world you have to drive.
 *
 * Nothing in this file builds geometry — it is data plus a couple of pure
 * helpers. `terrain.js`, `netgen.js` and `roadmesh.js` consume it.
 */

/** Legacy -> world scale. DESIGN.md: "multiply every legacy coordinate by 4". */
export const K = 4;

/** Metres, square, origin-centred. This is `world.CITY_SIZE`. */
export const CITY_SIZE = 3000;
export const HALF_CITY = CITY_SIZE / 2;

/** Streaming tile edge, metres (ARCHITECTURE.md: 128 m tiles). */
export const TILE = 128;
/** My own geometry is merged 4x4 tiles at a time so the draw count stays sane. */
export const SECTOR = TILE * 4;

/** Pool level of all three rivers. Steel City has no locks worth modelling. */
export const WATER_Y = 0;
/** Depth of the dredged channel at the centreline. */
export const RIVER_BED = -11;
/** Metres of bank between the waterline and undisturbed ground. */
export const RIVER_SHORE = 44;
/** Height of the top of the bank above the pool. */
export const RIVER_BANK = 5.2;
/**
 * HOW FAR PAST ITS OWN WATERLINE THE RIVER IS DRAWN.
 *
 * `water.js` builds each river's sheet `width/2 + OVER` either side of the
 * centreline so there is never a seam where it meets the bank, and every vertex
 * of that overhang whose ground stands ABOVE `WATER_Y` is pushed under it. The
 * ones whose ground is BELOW the pool are left at pool level — correctly, that
 * is what a river does — so the visible water is the contour where the terrain
 * crosses `WATER_Y`, out to this distance from the waterline.
 *
 * THAT CONTOUR IS NOT `terrain.isWater`, and the gap is a road defect.
 * `isWater` answers `waterDist <= 6 && height < WATER_Y - 0.25`, so between 6
 * and 24 m outside a waterline it says DRY while the sheet is drawn over the
 * ground at pool level. MEASURED on the analytic field at 4 m: 4.51 % of that
 * band is below the pool — 801 of 17 755 samples — and `netgen` was laying
 * streets across it on a plan-distance setback alone. `downtown_v7` came out
 * 5.54 m under the Monongahela's surface 23 m from its waterline on the shipped
 * seed, which is the "road from downtown goes into the river" the owner drove
 * into. `netgen.underRiver` is the one test both the corridor clip and the
 * closing links now apply, and `src/game/groundtruthprobe.mjs` gates it.
 *
 * ONE OWNER, because two subsystems deciding one fact is how the Point Fountain
 * ended up 8.7 m under the Ohio (ARCHITECTURE.md rule 12). `water.js` still
 * spells the same 24 as its own `OVER`; it should import this instead.
 */
export const RIVER_OVERHANG = 24;

/**
 * `?owNoOakland=1` / `OW_NO_OAKLAND=1` — the A/B hatch for the OAKLAND wave.
 *
 * ONE BUILD, THE CHANGE OFF AND ON. `tools/perfcheck.mjs --ab='.|owNoOakland=1,.'`
 * is the only machine-immune way to price a new district: two worktrees measured
 * minutes apart on this machine have come back 70% different with no code change
 * at all (see that file's header), so the two arms have to be the same binary in
 * the same minute.
 *
 * What it removes is the whole wave and nothing else — the district (and with it
 * its terrain pad, its street grid, its blocks, its lots and its traffic) and the
 * three landmark sites (and with them the road reserve, the ring roads, the
 * emitted geometry, the planting and the `urbanAt` suppression). It does NOT
 * touch the bridge colours: those are a tint on an existing bake plus one
 * accumulator key, and there is no arm of them worth measuring.
 *
 * Read at MODULE SCOPE deliberately, because `terrain.js` derives `PAD` and
 * `GREEN_SITES` from these arrays once at load. A hatch consulted later would
 * leave the heightfield with an Oakland-shaped plateau in it and no Oakland on
 * top, which is a measurement of nothing.
 */
function planHatch(qs, env) {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get(qs) === '1') return true;
  } catch { /* no location */ }
  try {
    if (typeof process !== 'undefined' && process?.env?.[env] === '1') return true;
  } catch { /* no process */ }
  return false;
}
const NO_OAKLAND = planHatch('owNoOakland', 'OW_NO_OAKLAND');
if (NO_OAKLAND) console.warn('[world] OAKLAND wave OFF — no district, no Cathedral, no parks');
/** The wave's own entries, dropped as one when the hatch is set. */
const OAKLAND_IDS = new Set(['oakland', 'lm_cathedral', 'lm_ironwood', 'lm_colorpark', 'dk_color']);
const wave = (list) => (NO_OAKLAND ? list.filter((e) => !OAKLAND_IDS.has(e.id)) : list);

const p4 = (pts) => pts.map(([x, z]) => [x * K, z * K]);

/**
 * The three rivers, DESIGN.md polylines x4.
 *
 * Two deliberate departures from the table, both so that The Point reads as
 * the tip of a triangle of land rather than a puddle:
 *   - an extra vertex is inserted on the Allegheny and the Monongahela ~110 m
 *     short of the confluence, so the two channels run parallel for a moment
 *     instead of converging from 40 degrees apart and eating the whole wedge;
 *   - every river is extrapolated past the map edge so no channel simply stops.
 */
export const RIVERS = [
  {
    id: 'allegheny',
    name: 'Allegheny',
    width: 144,
    pts: [
      [1320, -1360],
      ...p4([
        [228, -252],
        [150, -196],
        [66, -136],
        [-16, -82],
        [-88, -40],
      ]),
      [-464, -72],
      [-600, 40],
    ],
  },
  {
    id: 'monongahela',
    name: 'Monongahela',
    width: 136,
    pts: [
      [1360, 1320],
      ...p4([
        [236, 232],
        [156, 182],
        [74, 132],
        [-8, 86],
        [-84, 46],
      ]),
      [-452, 148],
      [-600, 40],
    ],
  },
  {
    id: 'ohio',
    name: 'Ohio',
    width: 184,
    /**
     * THE OHIO'S OUTER END USED TO STOP AT (-1560, -620) AND THAT WAS A CRATER.
     *
     * `segDist2` clamps the segment parameter to [0, 1], so past the last
     * vertex `riverAt` measures the RADIAL distance to that vertex: the channel
     * stops being a channel and becomes a disc. A disc of radius
     * `width/2 + RIVER_SHORE` = 136 m, carved unconditionally to
     * `RIVER_BED = -11`.
     *
     * That would be harmless in low ground, which is where the Allegheny and
     * the Monongahela end — but rr = 1560 is well inside the rim-hill band
     * (`rawHeight` adds up to 236 m of ridged noise past rr = 1180), so the
     * Ohio's cap was punched through a hillside standing 100-155 m high. The
     * result was a 272 m elliptical bowl 165 m deep with a 74-degree wall, and
     * it is the crater a reviewer photographed on the right of `farview` from
     * 2.6 km away in Hazelwood.
     *
     * Carry the channel out past the rim band instead, which is what the file
     * header already claims every river does.
     */
    pts: [...p4([[-150, 10], [-214, -24], [-268, -68], [-336, -124]]), [-1560, -620], [-2560, -1010]],
  },
];

/**
 * The twelve districts, DESIGN.md x4.
 *
 * `pad` is the elevation the terrain is pulled toward inside the district and
 * `edge` how many metres it takes to get there — that is what turns Troy Hill
 * and Mt. Washington into hills with flat tops full of houses, which is what
 * Pittsburgh actually looks like from the air.
 */
export const DISTRICTS = wave([
  { id: 'point', name: 'THE POINT', x: -672, z: 16, r: 248, tall: 0.10, tint: [0.30, 0.36, 0.30], pad: 4, edge: 120, density: 0.15, wealth: 0.5, grid: 'park' },
  { id: 'downtown', name: 'GOLDEN TRIANGLE', x: -232, z: 64, r: 400, tall: 1.00, tint: [0.36, 0.38, 0.44], pad: 9, edge: 180, density: 1.0, wealth: 0.85, grid: 'downtown' },
  { id: 'strip', name: 'THE STRIP', x: 248, z: -184, r: 344, tall: 0.55, tint: [0.42, 0.34, 0.28], pad: 12, edge: 200, density: 0.8, wealth: 0.45, grid: 'grid' },
  { id: 'lawren', name: 'LAWRENCEVILLE', x: 680, z: -552, r: 384, tall: 0.42, tint: [0.40, 0.33, 0.30], pad: 26, edge: 260, density: 0.75, wealth: 0.5, grid: 'grid' },
  { id: 'northsh', name: 'NORTH SHORE', x: -160, z: -600, r: 416, tall: 0.50, tint: [0.31, 0.36, 0.40], pad: 10, edge: 220, density: 0.6, wealth: 0.6, grid: 'grid' },
  { id: 'troy', name: 'TROY HILL', x: 520, z: -1032, r: 360, tall: 0.30, tint: [0.34, 0.38, 0.32], pad: 74, edge: 300, density: 0.55, wealth: 0.4, grid: 'hill' },
  { id: 'southside', name: 'SOUTH SIDE', x: 160, z: 608, r: 432, tall: 0.45, tint: [0.40, 0.35, 0.30], pad: 8, edge: 210, density: 0.7, wealth: 0.45, grid: 'grid' },
  { id: 'mtwash', name: 'MT. WASHINGTON', x: -528, z: 464, r: 368, tall: 0.28, tint: [0.33, 0.37, 0.33], pad: null, edge: 0, density: 0.5, wealth: 0.55, grid: 'hill' },
  { id: 'steelrow', name: 'STEEL ROW', x: 784, z: 384, r: 400, tall: 0.62, tint: [0.44, 0.32, 0.26], pad: 7, edge: 190, density: 0.6, wealth: 0.25, grid: 'mill' },
  { id: 'westend', name: 'WEST END', x: -1032, z: 368, r: 384, tall: 0.30, tint: [0.35, 0.36, 0.33], pad: 58, edge: 300, density: 0.45, wealth: 0.4, grid: 'hill' },
  { id: 'northside', name: 'MANCHESTER', x: -984, z: -568, r: 368, tall: 0.32, tint: [0.34, 0.35, 0.38], pad: 16, edge: 240, density: 0.55, wealth: 0.4, grid: 'grid' },
  { id: 'hazel', name: 'HAZELWOOD', x: 984, z: -56, r: 344, tall: 0.36, tint: [0.40, 0.34, 0.28], pad: 34, edge: 260, density: 0.5, wealth: 0.3, grid: 'grid' },
  /**
   * OAKLAND — the campus plateau, and the one hole this table still had in it.
   *
   * SITED BY SURVEY, NOT BY EYE. Pittsburgh's Oakland is up the hill east of
   * downtown, south of the Strip, north of the Monongahela, west of Hazelwood
   * — and on this map that description picks out exactly one piece of ground,
   * the basin between `strip`, `steelrow` and `hazel`. It was measured before
   * it was authored:
   *
   *   - CENTRE-TO-CENTRE. No district centre in this table has ever fallen
   *     inside another's circle and this one does not either: 352 m to `strip`
   *     (r 344), 434 m to `steelrow` (r 400), 474 m to `hazel` (r 344), 753 m
   *     to `downtown`. `r = 316` keeps every other centre outside OAKLAND's
   *     circle in turn, which is the same invariant read the other way.
   *   - DRY. Sampled every 15 degrees on the r = 320 ring: nearest waterline
   *     147 m, zero wet samples. The Monongahela is 400 m south of the centre.
   *   - THE BASIN IS REAL, and filling it is a fix rather than a cost.
   *     MEASURED on the shipped analytic field with no OAKLAND in it,
   *     `heightAt(520, 40) = -22.48 m` — 22 m of DRY ground below the pool,
   *     because `isWater` needs a waterline within 6 m and there is none for
   *     400 m. Every district around it pads up (strip 12, steelrow 7, hazel
   *     34) and the un-padded gap between them sagged. `pad: 26` is a plateau
   *     between the Strip and Hazelwood, which is what Oakland is.
   *
   * `edge: 300` rather than the 240-260 its neighbours use, because the lift
   * here is ~48 m and `smootherstep`'s peak grade is 1.875x the mean: 48 x
   * 1.875 / 300 = 30%, at `netgen`'s MAX_GRADE rather than over it, and the
   * grid's own `clipToLand` drops any rail that finds worse.
   */
  { id: 'oakland', name: 'OAKLAND', x: 520, z: 40, r: 316, tall: 0.52, tint: [0.38, 0.36, 0.31], pad: 26, edge: 300, density: 0.72, wealth: 0.62, grid: 'campus' },
]);

export const DISTRICT_BY_ID = Object.fromEntries(DISTRICTS.map((d) => [d.id, d]));

/**
 * The Mt. Washington bluff.
 *
 * The signature view of the city is downtown seen from the top of this cliff,
 * so it is authored explicitly rather than falling out of a radial pad: a ridge
 * line roughly parallel to the south bank of the Mon, terrain climbing ~104 m
 * over 130 m of ground south of it (about 39 degrees — walkable nowhere, which
 * is why the Incline exists), then a plateau of timber houses.
 */
export const BLUFF = {
  line: [
    [-1010, 236],
    [-780, 258],
    [-560, 318],
    [-352, 404],
    [-140, 514],
    [80, 628],
    [300, 742],
  ],
  rise: 104,
  /** metres of ground the climb takes */
  run: 132,
  /** how far south the plateau extends before it falls away again */
  depth: 640,
  fall: 340,
  /** metres of taper at each end of the ridge */
  taper: 260,
};

/** Radial elevation controls that are not districts (rolling country, rim hills). */
export const HILLS = [
  { x: 1180, z: -880, r: 520, h: 96 },   // beyond Troy Hill
  { x: 1240, z: 520, r: 520, h: 78 },    // beyond Steel Row
  { x: -1300, z: 700, r: 560, h: 104 },  // beyond the West End
  { x: -1360, z: -900, r: 520, h: 88 },  // beyond Manchester
  { x: 420, z: 980, r: 480, h: 70 },     // the South Side slopes
  { x: 900, z: -180, r: 360, h: 44 },    // Hazelwood ridge
];

/**
 * THE SIX LANDMARKS — and the ground each of them stands on.
 *
 * `x, z` is the authored centre. **This table is the city's single source of
 * truth for where a landmark IS.** It is published as `world.landmarks`, and
 * `src/game/data.js` and `src/ui/data.js` already carry the same numbers;
 * `src/buildings/` adopts them at init (`adoptLandmarkSites`) rather than
 * keeping a fourth copy, because it kept a fourth copy and it disagreed —
 * see the note on `lm_point` below.
 *
 * THE POINT FOUNTAIN MOVED, AND THIS COORDINATE IS THE RIGHT ONE.
 *
 * `DESIGN.md` lists `lm_point` at legacy `(-178, 8)`, which is `(-712, 32)`
 * after the x4 scale, and `src/buildings/landmarks.js` used to build it there.
 * That is not the Point. `DESIGN.md` also puts the confluence of the three
 * rivers at legacy `(-150, 10)` -> `(-600, 40)`, and the Ohio runs WEST from
 * it — so `(-712, 32)` is 112 m DOWNSTREAM of the confluence, in the middle of
 * the Ohio's 184 m channel. Measured on the shipped terrain:
 * `heightAt(-712, 32) = -8.68 m` and `isWater(-712, 32) === true`. The
 * fountain was standing on the river bed under 8.7 m of water.
 *
 * The real Point is the TIP OF THE TRIANGLE, upstream of where the two rivers
 * join — which is what `(-452, 46)` is: `heightAt = +3.56 m`, dry, on the
 * wedge of land between the Allegheny (centreline z = -81 at this x) and the
 * Monongahela (z = 148). Legacy's `(-178, 8)` was authored against a 700 m map
 * whose channels were drawn narrower than a x4 scale of them; the scale note
 * in `DESIGN.md` does not survive contact with a real river.
 *
 * `site` is the FOOTPRINT THE LANDMARK ACTUALLY OCCUPIES, as an oriented
 * rounded box in world metres: half-extents `hx, hz` about a centre offset
 * `ox, oz` from `x, z`, rotated by `yaw`, with corner radius `r`. `hx = hz = 0`
 * makes it a disc; `hx = 0` makes it a capsule. Every one of the six was
 * MEASURED off the emitted geometry — the low triangles a bumper can reach,
 * within 4 m of the ground — not read off the builder's constants, and each
 * carries 2-5 m of margin over what was measured:
 *
 *   lm_tower    disc  r 36        podium 52 x 44 + colonnade; measured 33.6
 *   lm_stadium  box   116 x 94    pier ring 108 x 86 + masts;  measured 110.6
 *   lm_mill     disc  r 72        stack, stoves, cast house, silos, gantries;
 *                                 irregular, measured 71.1 at 45 degrees
 *   lm_incline  capsule r 16      the funicular: a 187 m trestle up the bluff.
 *               x 208 long        Its BEARING is not authored — see `uphill`
 *   lm_point    disc  r 46        basin R 30 + granite apron to 44 + bollards
 *   lm_market   box   42 x 122    the hall 30 x 96 + the head building;
 *                                 measured 66.3 to the head building's corner
 *
 * `netgen.reserveLandmarks` keeps every drivable corridor `LANDMARK_RESERVE`
 * metres clear of these, and `src/world/lmsweep.mjs` asserts it against the
 * emitted graph. Nothing else may assume a landmark is round.
 *
 * `uphill` MARKS A SITE WHOSE BEARING IS SOLVED, NOT AUTHORED — and it is here
 * because guessing it did not work. A funicular points up the hill, so
 * `buildings`' `incline()` used to DISCOVER the steepest bearing off the
 * terrain at build time. Reserving the ground under it changed the terrain
 * (a road corridor sinks the ground 0.55 m), the steepest-bearing scan is a
 * knife edge between neighbouring bearings, and the trestle swung 30 degrees —
 * straight back out of the capsule that had just been reserved for it, which
 * `roadsweep.mjs` duly reported as 20 impassable directions.
 *
 * So `world` solves it once, on the RAW terrain, before a single corridor is
 * laid — `netgen.orientLandmarkSites` — writes the answer into `site.yaw` and
 * the capsule's offset, and publishes it. `buildings` reads that bearing
 * instead of probing. Two subsystems deciding independently which way a
 * landmark faces is the same defect as two deciding where it is.
 */
export const LANDMARKS = wave([
  { id: 'lm_point', name: 'The Point Fountain', x: -452, z: 46, kind: 'fountain',
    site: { ox: 0, oz: 0, hx: 0, hz: 0, yaw: 0, r: 46 } },
  { id: 'lm_incline', name: 'Duquesne Incline', x: -488, z: 296, kind: 'incline',
    site: { ox: 0, oz: 96, hx: 0, hz: 96, yaw: 0, r: 16 },
    // `run` is the length of the funicular; the capsule is `hz` = run/2 + a
    // little either side, so it covers the lower station, the trestle and the
    // upper station's own 18 x 14 m footprint. Defaults point straight up +z
    // until `orientLandmarkSites` solves the real bearing.
    uphill: { run: 180, dir: [0, 1], rise: 0 } },
  { id: 'lm_stadium', name: 'Steel Bowl', x: -416, z: -512, kind: 'stadium',
    site: { ox: 0, oz: 0, hx: 36, hz: 14, yaw: 0, r: 80 } },
  { id: 'lm_mill', name: 'Old Blast Furnace', x: 872, z: 248, kind: 'mill',
    site: { ox: 0, oz: 0, hx: 0, hz: 0, yaw: 0, r: 72 } },
  { id: 'lm_tower', name: 'Steel Tower', x: -208, z: -16, kind: 'tower',
    site: { ox: 0, oz: 0, hx: 0, hz: 0, yaw: 0, r: 36 } },
  { id: 'lm_market', name: 'Strip Market', x: 352, z: -224, kind: 'market',
    site: { ox: 0, oz: -7, hx: 18, hz: 58, yaw: 0, r: 3 } },
  /**
   * THE CATHEDRAL OF STEEL — Oakland's gothic tower and the quad it stands on.
   *
   * A limestone skyscraper alone on a lawn, which is a silhouette this city
   * does not otherwise own: everything tall in Steel City is either a glass
   * curtain wall (the Steel Tower) or a mill stack. It reads from Mt.
   * Washington, from the Strip and from both airfields, and it is the reason
   * OAKLAND is legible from outside its own streets.
   *
   * The site is a BOX, not a disc, and it is the QUAD rather than the tower:
   * the tower's own base is 34 x 30 m, the flanking halls stand on the long
   * edges, and the reserve keeps the carriageway off the lawn between them.
   * `yaw` is `DISTRICT_YAW.oakland`, so the quad is square to Oakland's grid
   * and the ring road `landmarkRings` lays around it reads as the campus
   * perimeter rather than as a roundabout in a field.
   */
  { id: 'lm_cathedral', name: 'The Cathedral of Steel', x: 508, z: 24, kind: 'cathedral',
    site: { ox: 0, oz: 0, hx: 54, hz: 42, yaw: 0.52, r: 12 } },
  /**
   * IRONWOOD PARK — Oakland's big park, on the south-east shoulder of the
   * plateau where the ground falls away toward the Monongahela.
   *
   * A disc, because a park has no facade to square up to, and 84 m of it so
   * the ring road is a park drive with room for lawns, a path loop and a
   * bandstand inside it. Placed 199 m from the district centre, so the whole
   * site (199 + 84 = 283 m) sits inside OAKLAND's r = 316 rather than hanging
   * off its edge, and 87 m clear of the Cathedral's quad so the two reserves
   * do not merge into one block nobody can drive between.
   */
  { id: 'lm_ironwood', name: 'Ironwood Park', x: 676, z: 164, kind: 'greenpark',
    site: { ox: 0, oz: 0, hx: 0, hz: 0, yaw: 0, r: 84 } },
  /**
   * COLOR PARK — the legal wall, on the Monongahela's south bank.
   *
   * The riverside slab where the city stopped painting over the paint: bays of
   * poured concrete in loud primaries, a tagged retaining wall, and the trail
   * running through it. It is a CAPSULE-ISH BOX along the bank rather than a
   * disc, because the bank here is 40 m of dry shelf between the waterline and
   * Carson Street and a disc big enough to matter would land in one or the
   * other. `yaw` is the bearing of the waterline itself, measured off the
   * emitted `waterDist` field between x = 280 and x = 400.
   */
  { id: 'lm_colorpark', name: 'Color Park', x: 306, z: 654, kind: 'colorpark',
    site: { ox: 0, oz: 0, hx: 76, hz: 16, yaw: 0.489, r: 5 } },
  /**
   * GLASSHOUSE COURT — the glass castle on the Triangle, and the one downtown
   * silhouette no generator will ever produce.
   *
   * The owner's report was "downtown does not have enough buildings — make it
   * like pittsburgh (steel building, ppg, highmark tower, etc.)". Of that list
   * the Steel Tower already exists as `lm_tower`; the deco crowns and the
   * pyramid caps are massing rules and now come out of
   * `src/buildings/archetypes.js` on ordinary downtown lots. The glass gothic
   * castle does not: spired corner turrets on a mirrored curtain wall are an
   * authored shape or they are absent, and it is the profile that makes a
   * skyline photograph read as this city rather than as any city.
   *
   * THE SITE IS A CITY BLOCK, NOT A TOWER PAD, and that is the whole point.
   * The real thing is one tower and five low buildings round a plaza, and a
   * landmark that reserved only its shaft would have put another empty field
   * in the middle of the district the report says is already too empty. So
   * `hx, hz` = 30 x 40 is a downtown block (`netgen.GRID_STYLE.downtown` cuts
   * them at about 65 x 95 m), `yaw` is `DISTRICT_YAW.downtown` so it is square
   * to the Triangle's grid, and `buildings` fills the block edges with the
   * court's own wings — street wall on all four sides, plaza in the middle.
   *
   * WHERE IT STANDS WAS MEASURED, NOT PICKED. A reserve is only as good as the
   * corridors `netgen.reserveLandmarks` is allowed to cut, and it exempts
   * bridges, elevated decks and rails — the first draft of an enlarged
   * `lm_tower` site went red on `lmsweep` at 41.3 m of intrusion because it
   * reached the Fort Duquesne approach. So downtown was swept on an 8 m
   * lattice for the point that maximises the smaller of (a) distance to any
   * un-cuttable corridor and (b) distance to an existing landmark site.
   * (-216, 104) came back at 93 m and 84 m against the 79 m this site needs
   * (55 m of reach plus `LANDMARK_RESERVE`), and it is 121 m off the Steel
   * Tower — one block, which is what the two of them are apart in the city
   * this is a portrait of.
   */
  { id: 'lm_glass', name: 'Glasshouse Court', x: -216, z: 104, kind: 'glasscourt',
    site: { ox: 0, oz: 0, hx: 30, hz: 40, yaw: -0.52, r: 5 } },
]);

/**
 * Metres of clear ground between a landmark site and the CENTRELINE of any
 * drivable corridor.
 *
 * It has to cover the widest carriageway in the city — a 6-lane parkway is
 * `corridorHalfWidth('highway', 6)` = 14.3 m from centreline to kerb face —
 * plus what the graph solver moves a point by after the corridors are laid:
 * `simplify` may cut a bend corner by up to its 1.6 m tolerance, the dedup
 * merge taper reaches 2.5 m past a centreline, and `nodeAt` welds within 7 m.
 * 24 m clears all of it with room, and the surplus reads as the apron or
 * plaza a landmark of this size would have anyway.
 */
export const LANDMARK_RESERVE = 24;

/**
 * Signed distance from (x, z) to a landmark `site`, in metres. Negative inside.
 *
 * The standard rounded-box field, which is exact for every shape in the table
 * above: disc, capsule and oriented box are all the same expression. Exactness
 * matters because both the reservation and the ring road are built off the
 * ISOLINES of this function.
 */
export function siteDist(lm, x, z) {
  const s = lm.site;
  if (!s) return Infinity;
  const dx = x - lm.x - s.ox;
  const dz = z - lm.z - s.oz;
  const c = Math.cos(s.yaw);
  const sn = Math.sin(s.yaw);
  const qx = Math.abs(dx * c + dz * sn) - s.hx;
  const qz = Math.abs(-dx * sn + dz * c) - s.hz;
  const ax = qx > 0 ? qx : 0;
  const az = qz > 0 ? qz : 0;
  const outside = Math.sqrt(ax * ax + az * az);
  const inside = Math.min(Math.max(qx, qz), 0);
  return outside + inside - s.r;
}

/** Distance to the NEAREST landmark site. Negative inside one of them. */
export function nearestSiteDist(x, z, out = null) {
  let best = Infinity;
  let which = null;
  for (const lm of LANDMARKS) {
    const d = siteDist(lm, x, z);
    if (d < best) {
      best = d;
      which = lm;
    }
  }
  if (out) out.lm = which;
  return best;
}

export const AIRFIELDS = [
  { id: 'af_county', name: 'Allegheny County Airfield', x: -1072, z: 784, runway: [600, 88], yaw: 0.30 },
  { id: 'af_rivers', name: 'Rivers Field', x: 1032, z: -784, runway: [512, 80], yaw: -0.42 },
];

/**
 * THE MILITARY AIRBASE — Ridgeline AFB, the biggest single site on the map.
 *
 * SITED BY SURVEY, NOT BY EYE (the coordinates were measured, 2026-08): a
 * 199-candidate scan of every map-edge rectangle big enough for a 1200 m
 * runway, scored on the real `Terrain` APIs (LS-fit centreline slope clamped
 * to the same 2.2% the civilian benches use, worst cut/fill over the whole
 * field, `waterDist`, `slopeAt`) and on the emitted road graph (edges whose
 * endpoint lands inside the field). The winner is the high shelf on the
 * north-west rim above Manchester: centreline fit -0.77% (inside the clamp),
 * worst residual 8.2 m, nearest water 578 m, ZERO drivable and ZERO rail
 * edges inside the field, 387 m clear of the nearest district circle,
 * 1.9 km from the nearest civilian airfield. Takeoff run is +a (east):
 * measured climb-out terrain past that end stays within 29 m of the bench,
 * against 87 m the other way into the Manchester rim.
 *
 * `runway` is [length, PAVED width] — unlike the civilian entries, whose
 * width is the whole strip. Everything else about the site (the L-shaped
 * field, fence polygon, gates, apron, parking, patrol loop) lives in
 * `src/world/airbase.js`, which is the one owner of every spatial fact here
 * — same contract as `world.airfields[].layout`.
 */
export const AIRBASE = {
  id: 'ab_ridge',
  name: 'Ridgeline AFB',
  kind: 'military',
  x: -675,
  z: -1390,
  yaw: 1.67,
  runway: [1200, 46],
};

export const DOCKS = wave([
  { id: 'dk_south', name: 'South Side Docks', x: -88, z: 280 },
  { id: 'dk_north', name: 'North Shore Slip', x: -24, z: -264 },
  { id: 'dk_point', name: 'Point Marina', x: -744, z: -88 },
  /**
   * COLOR PARK LANDING — the South Side flats' own slip, off the legal wall.
   *
   * The excursion boats work this bank, and until this entry the whole of the
   * Monongahela east of the Smithfield Street Bridge had nowhere to tie up:
   * `dk_south` is 400 m downstream of The Point and the other two are on the
   * Allegheny and the Ohio. Sited IN the channel, like the other three, so a
   * hull moored on it floats — `heightAt` here is river bed, not bank.
   *
   * `src/game/data.js` owns what a dock DOES (staging apron, mission anchor)
   * and does not carry this one yet; see the handoff note.
   */
  { id: 'dk_color', name: 'Color Park Landing', x: 322, z: 606 },
]);

export const SAFEHOUSES = [
  { id: 'sh_boathouse', name: "Carson's Boathouse", x: 88, z: 560 },
  { id: 'sh_bodyshop', name: 'DeCarlo Body Shop', x: 632, z: -464 },
  /**
   * DYLAN'S GARAGE MOVED OFF THE BLUFF FACE, and it had to.
   *
   * The authored point was (-504, 432). The owner's report — "dylan starts in
   * the wall" — is that coordinate exactly: MEASURED on the analytic terrain it
   * stands at 92.0 m on the Mt. Washington CLIFF, `slopeAt(...,3)` = 0.77 (the
   * `world.isOpen` reject bar is 0.62), on a face that climbs from 15 m at
   * z = 380 to 101 m at z = 440. The nearest drivable edge is 20.1 m away at
   * (-513, 450) and its deck is 102 m — TEN METRES ABOVE the safehouse. So the
   * one thing a start point has to be, a piece of ground beside a street, it
   * was not: `Director.groundPose` walks 2-16 m off that clifftop lane looking
   * for pavement and lands on the corridor's own stepped retaining skirt, which
   * is the "settle race" flake — the ankle probe reads bearings blocked because
   * a road cut into a 77% slope IS a wall on its downhill side.
   *
   * The replacement is SURVEYED, not eyeballed, by the `groundtruthprobe`
   * method (a pristine analytic terrain — `generateCity` mutates the
   * heightfield, so each seed gets its own — plus the real emitted graph, over
   * the same six seeds), and it is the best point on the plateau that satisfies
   * what a start has to BE, on ALL SIX:
   *
   *   slope     0.039 worst over a 12 m forecourt ring (vs 0.77 before)
   *   relief    1.2 m of height spread over a 26 m ring — this is the one that
   *             fails on a bluff lip and passes nowhere near one, and it is the
   *             criterion the old point could never have met
   *   road      nearest drivable edge 11.4-11.6 m on every seed, outside
   *             `corridorHalfWidth('street', 2) + 3` = 9.3 m so `resolvePoi`
   *             keeps it (moved 0 m) rather than walking the forecourt away
   *   deck      that edge's deck within 0.5 m of the ground he stands on
   *
   * It is 48 m up his own street from the Incline Diner (-560, 504) and 119 m
   * from the incline's upper station, so it is still his corner of the hill.
   *
   * `src/game/data.js` `sh_dylan` and `src/ui/data.js` `sh_garage` MUST carry
   * the same coordinate — `game` owns what a safehouse DOES and `ui` draws the
   * pin, `world` owns whether the ground under it is somewhere you can stand.
   * Those two are another subsystem's files; see the handoff note.
   */
  { id: 'sh_garage', name: "Dylan's Garage", x: -560, z: 552 },
  { id: 'sh_apartment', name: 'Triangle Apartment', x: -264, z: 96 },
  { id: 'sh_loft', name: 'Shore Loft', x: -192, z: -672 },
];

/**
 * The drive-in services: pumps, respray, ammo counters, diners.
 *
 * These coordinates MUST match `src/game/data.js` — `game` owns what a POI
 * DOES, `world` owns whether the ground under it is somewhere you can drive a
 * car onto and stand still. They are listed here so the terrain can give each
 * one a flat forecourt off the kerb (`netgen.applyServicePads`) and so
 * `world.pois` can answer "is this place reachable" without importing another
 * subsystem's module (ARCHITECTURE.md rule 2).
 */
export const SERVICES = [
  { id: 'gas_strip', name: 'Strip Fuel', x: 256, z: -72, kind: 'gas' },
  { id: 'gas_south', name: 'Carson St Gas', x: 144, z: 528, kind: 'gas' },
  { id: 'gas_west', name: 'West End Pumps', x: -952, z: 304, kind: 'gas' },
  { id: 'gas_north', name: 'Shore Service', x: -184, z: -544, kind: 'gas' },
  { id: 'gas_row', name: 'Steel Row Fuel', x: 760, z: 328, kind: 'gas' },
  { id: 'gas_law', name: 'Butler St Gas', x: 696, z: -512, kind: 'gas' },
  // MOVED OFF THE MONONGAHELA. (-336, 176) — DESIGN.md's legacy (-84, 44) at
  // K = 4 — is 10.9 m under the river; the surveyed replacement is dry, 1.0%
  // slope over a 12 m ring and 13.5-13.6 m off a two-lane arterial on all six
  // seeds, which clears `corridorHalfWidth('arterial', 2) + 3` = 10.4 m, so
  // `resolvePoi` keeps it (moved 0 m on every seed) rather than walking the
  // forecourt somewhere else. The reasoning and the measurements are in
  // `src/game/data.js` SHOPS, which MUST agree with this line.
  { id: 'shop_spray', name: 'Rustbelt Respray', x: -136, z: 96, kind: 'respray' },
  { id: 'shop_ammo', name: 'Foundry Supply', x: 384, z: -280, kind: 'ammo' },
  { id: 'shop_food', name: "Primo's Sandwich", x: -120, z: 24, kind: 'food' },
  { id: 'shop_ammo2', name: 'Row Hardware', x: 816, z: 464, kind: 'ammo' },
  { id: 'shop_food2', name: 'Incline Diner', x: -560, z: 504, kind: 'food' },
];

/**
 * Radius of the flat forecourt stamped into the terrain at a POI, and how many
 * metres it takes to blend back into the hillside. `game` triggers its drive-in
 * services at `R.service` = 11 m, so the pad has to be at least that.
 */
export const POI_PAD = { r: 17, blend: 26 };

/**
 * BRIDGES — the map's chokepoints.
 *
 * The rivers are the only thing splitting the city, so every one of these is a
 * place police will try to close and several missions stage on. `a` and `b` are
 * anchors on dry land; the generator finds the water crossing between them,
 * pins the deck at `deckY` and ramps the approaches.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * `steel` — WHAT COLOUR THE SUPERSTRUCTURE IS PAINTED.
 * ───────────────────────────────────────────────────────────────────────────
 * A palette key in `world/palette.js`, handed to `bridges.js` on the emitted
 * spec. Until this field existed every truss, arch and cable in the city was
 * one material, so eleven crossings over three rivers had one identity between
 * them — which is the opposite of what a bridge is for on a map whose
 * chokepoints are all bridges. You cannot say "meet me at the blue one".
 *
 * The convention is Pittsburgh's, not an invention:
 *
 *   `bridge_gold`   THE SISTERS and the two gateway crossings. Three identical
 *                   self-anchored suspension spans in a row over the Allegheny
 *                   — Sixth, Seventh, Ninth — plus Fort Pitt and Fort Duquesne,
 *                   the pair you arrive downtown through, and the Sixteenth
 *                   Street truss. Aztec gold over red lead.
 *   `bridge_blue`   the long river crossings: Smithfield, Birmingham,
 *                   Thirty-First, West End, McKees Rocks. Cold blue-green
 *                   structural paint, which is what the big spans upstream and
 *                   downstream of the golden triangle actually wear.
 *   `bridge_black`  the Hot Metal Bridge, alone. It is the MILL's bridge — it
 *                   carried ladles, not commuters — and it was never painted a
 *                   civic colour. Bare plate, mill scale and rust.
 *
 * Nothing else in the file may decide this. `bridges.js` reads `spec.steel`
 * and nothing else; a bridge with no `steel` key falls back to the gold, which
 * is the colour every span used to be.
 */
export const BRIDGES = [
  { id: 'br_fortduq', name: 'Fort Duquesne Bridge', river: 'allegheny', kind: 'highway', a: [-405, -35], b: [-520, -370], lanes: 4, deckY: 19, style: 'arch', steel: 'bridge_gold' },
  { id: 'br_sixth', name: 'Sixth Street Bridge', river: 'allegheny', kind: 'arterial', a: [-150, -20], b: [-235, -330], lanes: 4, deckY: 17, style: 'suspension', steel: 'bridge_gold' },
  /**
   * THE MIDDLE SISTER. Pittsburgh's trio is three identical self-anchored
   * suspension spans on one straight reach of the Allegheny, and this map had
   * two of them with a 220 m hole where the third goes. Its anchors are the
   * midpoint of Sixth's and Ninth's on both banks — the same bearing, the same
   * deck height, the same style — so it lands in the downtown grid and the
   * North Shore grid exactly where its sisters do.
   */
  { id: 'br_seventh', name: 'Seventh Street Bridge', river: 'allegheny', kind: 'arterial', a: [-40, -80], b: [-125, -390], lanes: 4, deckY: 17, style: 'suspension', steel: 'bridge_gold' },
  { id: 'br_ninth', name: 'Ninth Street Bridge', river: 'allegheny', kind: 'arterial', a: [70, -140], b: [-15, -450], lanes: 4, deckY: 17, style: 'suspension', steel: 'bridge_gold' },
  { id: 'br_16th', name: 'Sixteenth Street Bridge', river: 'allegheny', kind: 'arterial', a: [352, -352], b: [268, -652], lanes: 4, deckY: 18, style: 'truss', steel: 'bridge_gold' },
  { id: 'br_31st', name: 'Thirty-First Street Bridge', river: 'allegheny', kind: 'arterial', a: [648, -596], b: [560, -900], lanes: 4, deckY: 18, style: 'truss', steel: 'bridge_blue' },
  { id: 'br_fortpitt', name: 'Fort Pitt Bridge', river: 'monongahela', kind: 'highway', a: [-372, 116], b: [-500, 392], lanes: 4, deckY: 21, style: 'arch', steel: 'bridge_gold' },
  { id: 'br_smithfield', name: 'Smithfield Street Bridge', river: 'monongahela', kind: 'arterial', a: [-96, 268], b: [-176, 552], lanes: 4, deckY: 17, style: 'truss', steel: 'bridge_blue' },
  { id: 'br_birmingham', name: 'Birmingham Bridge', river: 'monongahela', kind: 'arterial', a: [268, 436], b: [188, 724], lanes: 4, deckY: 19, style: 'truss', steel: 'bridge_blue' },
  { id: 'br_hotmetal', name: 'Hot Metal Bridge', river: 'monongahela', kind: 'street', a: [596, 620], b: [512, 900], lanes: 2, deckY: 15, style: 'truss', steel: 'bridge_black' },
  { id: 'br_westend', name: 'West End Bridge', river: 'ohio', kind: 'arterial', a: [-856, -296], b: [-944, 16], lanes: 4, deckY: 20, style: 'arch', steel: 'bridge_blue' },
  { id: 'br_mckees', name: 'McKees Rocks Bridge', river: 'ohio', kind: 'arterial', a: [-1204, -520], b: [-1296, -172], lanes: 4, deckY: 20, style: 'truss', steel: 'bridge_blue' },
];

/* ------------------------------------------------------- street names ---- */

/**
 * THE STREET VOCABULARY — what `world.streetAt(x, z)` speaks.
 *
 * `netgen` already names everything it authors by hand: the connectors
 * (Liberty Avenue, Butler Street, Carson Street …), the quays and parkways, the
 * eleven bridges and their approaches, the landmark rings, the Mt. Washington
 * climbs. Those names go straight onto the emitted edge as `edge.name` and this
 * table must never restate one — a name that appears twice is two roads with
 * one identity, which is worse for wayfinding than no name at all.
 *
 * What was left anonymous is the bulk of the city: the DISTRICT GRIDS. Every
 * rail `netgen.gridDistrict` lays carries `district` and a corridor id of the
 * form `<district>_u<i>` / `_v<j>` / `_a<j>` (`u` and `v` are the two families
 * of parallel streets in the district's own rotated frame, `a` the service
 * alleys), plus whatever run suffix the clipping passes tagged it with — see
 * `CORRIDOR_RUN` below. The index is stable — it comes from the district's
 * radius and `GRID_STYLE` spacing, not from the rng, which only jitters the
 * rail's position — so a name indexed by it names the same street every boot.
 *
 * SIZES ARE NOT GUESSES. `gridDistrict` lays `ceil(2 * r * 1.12 / a) + 1` rails
 * of the `u` family, the same in `b` for `v`, and one alley slot per `v` row:
 * measured against the emitted graph, the largest index actually reached is
 * exactly one less than each array's length below. `src/world/routeprobe.mjs`
 * asserts that EVERY emitted grid corridor resolves to a name, so a district
 * whose grid grows will go red here rather than quietly falling back to null.
 *
 * The names are Pittsburgh's, per neighbourhood: numbered streets where the
 * real city numbers them (the Strip, Lawrenceville, the South Side), named
 * avenues where it names them, and `Way` for the alleys, which is what
 * Pittsburgh calls them.
 */
export const DISTRICT_STREETS = {
  point: {
    along: ['Commonwealth Place', 'Fort Pitt Boulevard', 'Fort Duquesne Boulevard', 'Point Way', 'Marina Drive'],
    cross: ['Portage Path', 'Penn Lawn Drive', 'Gateway Walk', 'Blockhouse Walk'],
    // `GRID_STYLE.park` sets `alleys: 0`, so the Point has none.
    alley: [],
  },
  downtown: {
    along: ['Penn Avenue', 'Forbes Avenue', 'Boulevard of the Allies', 'Oliver Avenue', 'Sixth Avenue',
      'Seventh Avenue', 'Bigelow Boulevard', 'Centre Avenue', 'Webster Avenue', 'Duquesne Way',
      'Wylie Avenue', 'Bedford Avenue'],
    cross: ['Stanwix Street', 'Wood Street', 'Market Street', 'Smithfield Street', 'Cherry Way',
      'Ross Street', 'Tenth Street', 'Ninth Street', 'Eighth Street', 'Seventh Street'],
    alley: ['Strawberry Way', 'Montour Way', 'Exchange Way', 'Coffey Way', 'Barbeau Way',
      'Fancourt Way', 'Garrison Way', 'Graeme Way', 'Tito Way'],
  },
  strip: {
    along: ['Eleventh Street', 'Twelfth Street', 'Fourteenth Street', 'Fifteenth Street', 'Seventeenth Street',
      'Eighteenth Street', 'Twentieth Street', 'Twenty-First Street', 'Twenty-Second Street'],
    cross: ['Railroad Street', 'Terminal Way', 'Herron Avenue', 'Melwood Avenue', 'Wharf Street',
      'Waterfront Way', 'Belmont Street', 'Boundary Street'],
    alley: ['Spring Way', 'Mulberry Way', 'Ganges Way', 'Cabinet Way', 'Bellefonte Way',
      'Juniper Way', 'Vespucius Way'],
  },
  lawren: {
    along: ['Thirty-Fourth Street', 'Thirty-Fifth Street', 'Thirty-Sixth Street', 'Thirty-Seventh Street',
      'Thirty-Eighth Street', 'Thirty-Ninth Street', 'Fortieth Street', 'Forty-Third Street',
      'Forty-Fifth Street', 'Fifty-First Street'],
    cross: ['Willow Street', 'Hatfield Street', 'Foster Street', 'Charlotte Street', 'Holmes Street',
      'Fisk Street', 'Harrison Street', 'McCandless Avenue'],
    alley: ['Comrie Way', 'Duncan Way', 'Berlin Way', 'Sassafras Way', 'Plummer Way',
      'Ligonier Way', 'Keystone Way'],
  },
  northsh: {
    along: ['Federal Street', 'Sandusky Street', 'Anderson Street', 'Isabella Street', 'General Robinson Street',
      'Reedsdale Street', 'North Shore Drive', 'Art Rooney Avenue', 'Mazeroski Way', 'Tony Dorsett Drive',
      'Scotland Street'],
    cross: ['East Ohio Street', 'Cedar Avenue', 'East North Avenue', 'Madison Avenue', 'Chestnut Street',
      'Nash Street', 'Progress Street', 'Lockhart Street', 'Foreland Street'],
    alley: ['Wettach Way', 'Compromise Way', 'Suismon Way', 'Avery Way', 'Middle Way',
      'Tripoli Way', 'Voskamp Way', 'Jacksonia Way'],
  },
  troy: {
    along: ['Lowrie Street', 'Ley Street', 'Claim Street', 'Froman Street', 'Harpster Street',
      'Herman Street', 'Province Street', 'Basin Street', 'Goettman Street'],
    cross: ['Wicklines Lane', 'Hatteras Street', 'Homer Street', 'Vinial Street', 'Ravine Street',
      'Straubs Lane', 'Bushnell Street'],
    alley: ['Bohemian Way', 'Baltic Way', 'Vista Way', 'Osgood Way', 'Hilltop Way', 'Cowley Way'],
  },
  southside: {
    along: ['South Fourth Street', 'South Sixth Street', 'South Seventh Street', 'South Ninth Street',
      'South Twelfth Street', 'South Thirteenth Street', 'South Fifteenth Street', 'South Seventeenth Street',
      'South Eighteenth Street', 'South Twentieth Street', 'South Twenty-Second Street'],
    cross: ['Sarah Street', 'Wharton Street', 'Jane Street', 'Mary Street', 'Sidney Street',
      'Bingham Street', 'Josephine Street', 'Mission Street', 'Muriel Street'],
    alley: ['Larkins Way', 'Wrights Way', 'Fox Way', 'Harcum Way', 'Pius Way',
      'Salisbury Way', 'Cuthbert Way', 'Fisher Way'],
  },
  mtwash: {
    along: ['Virginia Avenue', 'Republic Street', 'Bigham Street', 'Southern Avenue', 'Boggs Avenue',
      'Merrimac Street', 'Kearsarge Street', 'Norton Street', 'Ulysses Street'],
    cross: ['Amabell Street', 'Haberman Avenue', 'Warrington Avenue', 'Wyoming Street', 'Belonda Street',
      'Meridan Street', 'Plymouth Street'],
    alley: ['Sweetbriar Way', 'Gearing Way', 'Sumner Way', 'Hallock Way', 'Estella Way', 'Fingal Way'],
  },
  steelrow: {
    along: ['Amity Street', 'Ann Street', 'Doyle Avenue', 'Munhall Road', 'Whitaker Way',
      'Waterfront Drive', 'Bessemer Avenue'],
    cross: ['Furnace Street', 'Slag Street', 'Ingot Street', 'Cast House Row', 'Hot Metal Street', 'Tandem Way'],
    alley: ['Cinder Way', 'Ladle Way', 'Tuyere Way', 'Scale Way', 'Coke Way'],
  },
  westend: {
    along: ['Main Street', 'Wabash Street', 'Sanctus Street', 'Alexander Street', 'Lorenz Avenue',
      'Chartiers Avenue', 'Independence Street', 'Noblestown Road', 'Crane Avenue', 'Berry Street'],
    cross: ['Elliott Street', 'Woodville Avenue', 'Obey Street', 'Hassler Street', 'Middletown Road',
      'Broadhead Fording Road', 'Herschel Street', 'Stafford Street'],
    alley: ['Bergman Way', 'Sylvania Way', 'Fairhaven Way', 'Dagmar Way', 'Ilona Way',
      'Cuba Way', 'Kearns Way'],
  },
  northside: {
    along: ['Chateau Street', 'Beaver Avenue', 'Columbus Avenue', 'Fulton Street', 'Sheffield Street',
      'Juniata Street', 'Pennsylvania Avenue', 'Liverpool Street', 'Adams Street', 'Bidwell Street'],
    cross: ['Manhattan Street', 'Marshall Avenue', 'Allegheny Avenue', 'Ridge Avenue', 'Western Avenue',
      'North Franklin Street', 'Fontella Street', 'Decatur Street'],
    alley: ['Faulsey Way', 'Rush Way', 'Dounton Way', 'Massachusetts Way', 'Fayette Way',
      'Stedman Way', 'Boquet Way'],
  },
  /**
   * OAKLAND. `GRID_STYLE.campus` is the widest grid in the city outside the
   * mill — institutional blocks are big — so the arrays are short: `R = r *
   * 1.12 = 353.9`, `ceil(2R / a) + 1 = 7` rails of the `u` family at a = 118,
   * `ceil(2R / b) + 1 = 6` of the `v` family at b = 148, and one alley slot per
   * `v` row, which is 5. Those are the counts below, exactly, and
   * `routeprobe.mjs` goes red if the grid ever outgrows them.
   *
   * Named the way the rest of this table is named — the real neighbourhood's
   * streets — and checked against every other entry for collisions, because
   * `routeprobe` asserts all 285 authored names are distinct and that none of
   * them shadows a name `netgen` emits by hand. Oakland's two obvious
   * candidates, Forbes Avenue and Fifth Avenue, are already spoken for
   * (downtown's grid and a cross-town connector), which is why neither is here.
   */
  oakland: {
    along: ['Bellefield Avenue', 'Dithridge Street', 'Craig Street', 'Neville Street',
      'Bayard Street', 'Ruskin Avenue', 'Schenley Drive'],
    cross: ['Atwood Street', 'Meyran Avenue', 'Oakland Avenue', 'Semple Street',
      'McKee Place', 'Coltart Avenue'],
    alley: ['Louisa Way', 'Frew Way', 'Tennyson Way', 'Halket Way', 'Darragh Way'],
  },
  hazel: {
    along: ['Second Avenue', 'Hazelwood Avenue', 'Flowers Avenue', 'Elizabeth Street', 'Gladstone Street',
      'Chatsworth Avenue', 'Johnston Avenue', 'Tecumseh Street', 'Lytle Street'],
    cross: ['Blair Street', 'Berwick Street', 'Monongahela Street', 'Melvin Street', 'Nansen Street',
      'Rakoczy Street', 'Tullymet Street', 'Winterburn Avenue'],
    alley: ['Hazel Way', 'Glenwood Way', 'Alluvian Way', 'Dilworth Way', 'Renova Way',
      'Berkshire Way', 'Chaucer Way'],
  },
};

/**
 * The four hill climbs `netgen.switchbacks` lays without a name. Their corridor
 * ids are already the real streets; this is where they become copy the HUD can
 * print. (The three Mt. Washington climbs — Sycamore, Shiloh, Bailey — are
 * named at the corridor, so they are deliberately absent.)
 */
export const CORRIDOR_STREETS = {
  rialto: 'Rialto Street',
  steuben: 'Steuben Street',
  greentree: 'Greentree Road',
  hazelclimb: 'Sylvan Avenue',
};

/**
 * `lawren_u7~af1#0` -> `lawren_u7`. Three passes cut a corridor into runs and
 * each tags the pieces: `~n` (landmark reserve, `netgen.reserveLandmarks`),
 * `~af n` (airfield clip, `airfield.js`) and `#n` (dedup,
 * `netgen.dedupeCorridors`). All three are still the same street, and none of
 * these markers can appear in an authored corridor id.
 */
const CORRIDOR_RUN = /[~#](?:af)?\d+/g;
/** `lawren_u7` -> district `lawren`, family `u`, index 7. */
const GRID_CORRIDOR = /^([a-z]+)_([uva])(\d+)$/;

/**
 * The street name of an emitted corridor id, or null if the plan does not name
 * it. Pure lookup — `route.js` owns the policy of which edge to ask about.
 */
export function corridorStreetName(corridorId) {
  if (typeof corridorId !== 'string' || corridorId === '') return null;
  const base = corridorId.replace(CORRIDOR_RUN, '');
  const fixed = CORRIDOR_STREETS[base];
  if (fixed) return fixed;
  const g = GRID_CORRIDOR.exec(base);
  if (!g) return null;
  const set = DISTRICT_STREETS[g[1]];
  if (!set) return null;
  const list = g[2] === 'u' ? set.along : g[2] === 'v' ? set.cross : set.alley;
  return list[+g[3]] ?? null;
}

/** Lane geometry, shared by the mesh builder, traffic and the minimap. */
export const ROAD_KIND = {
  highway: { laneWidth: 3.9, shoulder: 2.6, sidewalk: 0, kerb: 0.0, speed: 33, paint: 'highway' },
  arterial: { laneWidth: 3.6, shoulder: 0.4, sidewalk: 3.4, kerb: 0.16, speed: 18, paint: 'arterial' },
  street: { laneWidth: 3.3, shoulder: 0.3, sidewalk: 2.7, kerb: 0.15, speed: 12, paint: 'street' },
  alley: { laneWidth: 3.0, shoulder: 0.0, sidewalk: 0, kerb: 0.0, speed: 7, paint: 'none' },
};

/** Carriageway half-width (kerb face to kerb face / 2) for an edge. */
export function roadHalfWidth(kind, lanes) {
  const k = ROAD_KIND[kind] ?? ROAD_KIND.street;
  return (lanes * k.laneWidth) / 2 + k.shoulder;
}

/** Total corridor half-width including pavements — what the terrain flattens to. */
export function corridorHalfWidth(kind, lanes) {
  const k = ROAD_KIND[kind] ?? ROAD_KIND.street;
  return roadHalfWidth(kind, lanes) + k.sidewalk;
}

// --------------------------------------------------------------- helpers --

export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(t) {
  t = clamp01(t);
  return t * t * (3 - 2 * t);
}

export function smootherstep(t) {
  t = clamp01(t);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Squared distance from (px,pz) to segment (ax,az)-(bx,bz), plus the parameter.
 * Writes `out = { d2, t }` to avoid allocating in hot loops.
 */
export function segDist2(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  out.d2 = qx * qx + qz * qz;
  out.t = t;
  return out;
}

/** Tile index of a world position. */
export function tileOf(x, z, out = { tx: 0, tz: 0 }) {
  out.tx = Math.floor(x / TILE);
  out.tz = Math.floor(z / TILE);
  return out;
}
