#!/usr/bin/env node
/**
 * SIGNPROBE — does this city say anything, and can you read it?
 *
 * ---------------------------------------------------------------------------
 * THE FINDINGS THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 * A critic panel scored the city "a signless, empty world — no billboards,
 * storefronts, shop names, graffiti or road markings anywhere", and the owner
 * asked for Pittsburgh-themed signs. Four of those five are properties of
 * emitted geometry and are measured here:
 *
 *   1  IS THERE TYPE AT ALL, and is it an ALPHABET rather than eight
 *      letter-shaped blobs? Measured as pairwise DISCRIMINABILITY: every
 *      glyph is rasterised out of its own emitted triangles into a fixed em
 *      box, and no two of the 36 alphanumerics may agree on more than 94 % of
 *      their cells. A "font" of interchangeable shapes fails this by
 *      construction, which is what the negative control demonstrates.
 *   2  DOES THE TYPE SURVIVE PLACEMENT? Every instance matrix of every piece
 *      of type is decomposed and required to be UNIFORMLY scaled, and its cap
 *      height in metres is required to be legible. A word stretched to a
 *      shop's frontage is the defect `fascia_board` already documents, and it
 *      is invisible in a proto-only check.
 *   3  ARE THE AUTHORED PLACES SIGNED, AT THEIR OWN COORDINATES? DeCarlo Body
 *      Shop, Rustbelt Respray, Foundry Supply, Row Hardware, Primo's Sandwich,
 *      the Incline Diner and six gas stations are gameplay, not dressing.
 *   4  IS ANY OF IT A REAL-WORLD TRADEMARK? Every string the kit can emit is
 *      swept against a denylist.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT CIRCULAR (rule 12)
 * ---------------------------------------------------------------------------
 * Nothing here reads a stroke count, a glyph table, an advance width or a
 * placement rule. It runs the REAL `registerSignKit` against a recording
 * prototype library and the REAL `Layout` against a synthetic world, and then
 * measures what came out: index buffers, vertex positions, instance matrices
 * and the strings that ended up on the protos. Discriminability is computed by
 * RASTERISING the emitted triangles — a quantity the emitter never writes down
 * — and the density ordering is authored here as a design requirement, not
 * read out of `DISTRICT_STYLE`.
 *
 * THE CONTROLS. Three, and all three must FAIL for the run to be green:
 *   - a BLOCK FONT (one full-em quad per character) run through the same
 *     discriminability measurement;
 *   - a denylisted trademark injected into the same sweep;
 *   - a deliberately NON-UNIFORM instance matrix run through the same scale
 *     decomposition.
 * A check that has never been seen to fail is a check with no evidence behind
 * it.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node src/props/signprobe.mjs
 *   node src/props/signprobe.mjs --gate     exit 1 on any failure
 *   node src/props/signprobe.mjs --json
 */
import * as THREE from 'three';
import { ProtoLibrary } from './batch.js';
import { EMISSIVE, SURFACES, DISTRICT_STYLE } from './palette.js';
import {
  registerSignKit, buildTextGeo, SIGN_WORDS, BANNER_WORDS, streetPlateText, textWidth,
} from './kit_sign.js';
import { Layout, REG_PLATES } from './layout.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  if (!args.json) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  }
  return !!ok;
}

/* ========================================================================= */
/* 1. THE ALPHABET — rasterised out of its own triangles                     */
/* ========================================================================= */

/**
 * Rasterise a geometry's triangles into a fixed box.
 *
 * The box is the same for every glyph — the widest em plus the stroke — so a
 * narrow letter is not stretched to fill the grid and made to look like a wide
 * one. Point-in-triangle at each cell centre; no anti-aliasing, because the
 * question is topology and not quality.
 */
function raster(geo, cols = 22, rows = 30, halfW = 0.62, halfH = 0.68) {
  const pos = geo.getAttribute('position').array;
  const idx = geo.getIndex().array;
  const bits = new Uint8Array(cols * rows);
  for (let t = 0; t < idx.length; t += 3) {
    const ax = pos[idx[t] * 3];
    const ay = pos[idx[t] * 3 + 1];
    const bx = pos[idx[t + 1] * 3];
    const by = pos[idx[t + 1] * 3 + 1];
    const cx = pos[idx[t + 2] * 3];
    const cy = pos[idx[t + 2] * 3 + 1];
    const x0 = Math.min(ax, bx, cx);
    const x1 = Math.max(ax, bx, cx);
    const y0 = Math.min(ay, by, cy);
    const y1 = Math.max(ay, by, cy);
    const c0 = Math.max(0, Math.floor(((x0 + halfW) / (2 * halfW)) * cols));
    const c1 = Math.min(cols - 1, Math.ceil(((x1 + halfW) / (2 * halfW)) * cols));
    const r0 = Math.max(0, Math.floor(((y0 + halfH) / (2 * halfH)) * rows));
    const r1 = Math.min(rows - 1, Math.ceil(((y1 + halfH) / (2 * halfH)) * rows));
    for (let r = r0; r <= r1; r++) {
      const py = ((r + 0.5) / rows) * 2 * halfH - halfH;
      for (let c = c0; c <= c1; c++) {
        if (bits[r * cols + c]) continue;
        const px = ((c + 0.5) / cols) * 2 * halfW - halfW;
        const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
        const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
        const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
        const neg = d1 < 0 || d2 < 0 || d3 < 0;
        const posi = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(neg && posi)) bits[r * cols + c] = 1;
      }
    }
  }
  return bits;
}

/**
 * Overlap of the INK, not of the grid: |A and B| / |A or B|.
 *
 * Agreement over every cell is the wrong measure and it was the first one
 * tried: two narrow letters in a wide em box agree on ninety percent of the
 * grid because ninety percent of the grid is empty in both, so I and T came
 * out at 93.9 % and the threshold was doing nothing. Scoring only the cells
 * either letter actually inks gives I/T the ~0.5 they deserve.
 */
function agreement(a, b) {
  let both = 0;
  let either = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) both++;
    if (a[i] || b[i]) either++;
  }
  return either ? both / either : 1;
}

const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('');

function alphabetBitmaps() {
  const out = new Map();
  for (const ch of ALPHA) {
    const { geo } = buildTextGeo([ch]);
    out.set(ch, { bits: raster(geo), ink: geo.getIndex().count / 3 });
    geo.dispose();
  }
  return out;
}

/** THE NEGATIVE CONTROL: one full-em quad per character, identical for all. */
function blockFontBitmaps() {
  const out = new Map();
  const g = new THREE.PlaneGeometry(0.62, 1.0);
  const bits = raster(g);
  for (const ch of ALPHA) out.set(ch, { bits, ink: 2 });
  g.dispose();
  return out;
}

function worstAgreement(maps) {
  let worst = 0;
  let pair = '';
  const keys = [...maps.keys()];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = agreement(maps.get(keys[i]).bits, maps.get(keys[j]).bits);
      if (a > worst) {
        worst = a;
        pair = `${keys[i]}/${keys[j]}`;
      }
    }
  }
  return { worst, pair };
}

/* ========================================================================= */
/* 2. THE DENYLIST                                                           */
/* ========================================================================= */

/**
 * Real-world marks this city must never print. Not exhaustive and not meant to
 * be — it is the set a rustbelt sign kit would plausibly reach for by accident,
 * plus the beer everyone thinks of when they hear "Iron City", which is exactly
 * the trap DESIGN.md's own note about original coinages warns about.
 */
const DENY = [
  'IRON CITY', 'PRIMANTI', 'HEINZ', 'PPG', 'US STEEL', 'U.S. STEEL',
  'CARNEGIE STEEL', 'WESTINGHOUSE', 'GULF OIL', 'ALCOA', 'MELLON',
  'GIANT EAGLE', 'EAT N PARK', 'SHEETZ', 'WAWA', 'DUQUESNE BREWING',
  'ROLLING ROCK', 'YUENGLING', 'ISALY', 'KLONDIKE', 'SUNOCO', 'EXXON',
  'MOBIL', 'TEXACO', 'SHELL OIL', 'BP', 'CHEVRON', 'COCA COLA', 'COCA-COLA',
  'PEPSI', 'BUDWEISER', 'MILLER LITE', 'MARLBORO', 'LUCKY STRIKE',
  'CAMEL CIGARETTES', 'FORD', 'CHEVROLET', 'CADILLAC', 'PONTIAC', 'BUICK',
  'STUDEBAKER', 'PACKARD', 'GOODYEAR', 'FIRESTONE', 'PENNZOIL', 'QUAKER STATE',
  'VALVOLINE', 'MAXWELL HOUSE', 'FOLGERS', 'WONDER BREAD', 'KODAK', 'RCA',
  'WESTERN UNION', 'WOOLWORTH', 'KAUFMANN', 'MACY', 'SEARS', 'A&P',
];

/**
 * WORD BOUNDARIES, NOT SUBSTRINGS. A naive `includes` fires 'RCA' inside
 * MERCANTILE and ARCADE, which is a check that cries wolf until somebody turns
 * it off — the worst failure mode a gate has. A mark is matched only when it
 * occupies whole words.
 */
function denyHits(strings) {
  const hits = [];
  const res = DENY.map((d) => [d,
    new RegExp(`(^|[^A-Z0-9])${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Z0-9]|$)`)]);
  for (const s of strings) {
    const u = String(s).toUpperCase();
    for (const [d, re] of res) if (re.test(u)) hits.push(`${s} ~ ${d}`);
  }
  return hits;
}

/* ========================================================================= */
/* 3. A SYNTHETIC CITY, AND THE REAL LAYOUT RUN OVER IT                      */
/* ========================================================================= */

/**
 * The twelve districts, laid out in a row 900 m apart so `districtAt` is a
 * pure function of x and nothing in one district can reach another. Each gets
 * the SAME lots, so a difference in emitted sign counts is a difference in the
 * district's own dressing rules and nothing else.
 */
const DISTRICTS = Object.keys(DISTRICT_STYLE);
const LANE = 900;

function districtAt(x) {
  const i = Math.round(x / LANE);
  return DISTRICTS[Math.min(DISTRICTS.length - 1, Math.max(0, i))];
}

/** Authored sites, mirrored off `world`'s own shipped tables at load time. */
const POIS = [
  { id: 'gas_strip', name: 'Strip Fuel', x: 256, z: -72, kind: 'gas' },
  { id: 'shop_spray', name: 'Rustbelt Respray', x: -136, z: 96, kind: 'respray' },
  { id: 'shop_ammo', name: 'Foundry Supply', x: 384, z: -280, kind: 'ammo' },
  { id: 'shop_food', name: "Primo's Sandwich", x: -120, z: 24, kind: 'food' },
  { id: 'shop_ammo2', name: 'Row Hardware', x: 816, z: 464, kind: 'ammo' },
  { id: 'shop_food2', name: 'Incline Diner', x: -560, z: 504, kind: 'food' },
];
const SAFES = [
  { id: 'sh_bodyshop', name: 'DeCarlo Body Shop', x: 632, z: -464 },
  { id: 'sh_boathouse', name: "Carson's Boathouse", x: 88, z: 560 },
];
const BRIDGES = [
  { id: 'br_sixth', name: 'Sixth Street Bridge', a: [-150, -20], b: [-235, -330] },
  { id: 'br_hotmetal', name: 'Hot Metal Bridge', a: [596, 620], b: [512, 900] },
];
const LANDMARKS = [
  { id: 'lm_mill', name: 'Old Blast Furnace', x: 872, z: 248, kind: 'mill', site: { r: 72 } },
  { id: 'lm_incline', name: 'Duquesne Incline', x: -488, z: 296, kind: 'incline', site: { r: 16 } },
  { id: 'lm_market', name: 'Strip Market', x: 352, z: -224, kind: 'market', site: { r: 3 } },
];

const STREET_NAMES = ['Butler Street', 'Boulevard of the Allies', 'Sarah Street',
  'Federal Street', 'Twenty-Second Street', 'Lowrie Street'];

function makeNode(id, x, z) {
  return { id, x, y: 0, z, links: [] };
}

/**
 * One straight arterial per district lane, 400 m long, running in z. Lots sit
 * 30 m off it, so `laneIntrusion` has a real corridor to answer about rather
 * than an empty graph that clears everything by default.
 */
function makeRoads() {
  const nodes = [];
  const edges = [];
  for (let i = 0; i < DISTRICTS.length; i++) {
    const x = i * LANE;
    const a = makeNode(nodes.length, x, -220);
    nodes.push(a);
    const b = makeNode(nodes.length, x, 220);
    nodes.push(b);
    const c = makeNode(nodes.length, x + 160, 0);
    nodes.push(c);
    const mk = (na, nb) => {
      const dx = nb.x - na.x;
      const dz = nb.z - na.z;
      const len = Math.hypot(dx, dz);
      const e = {
        id: edges.length, a: na.id, b: nb.id, dx: dx / len, dz: dz / len, len,
        kind: 'arterial', lanes: 4, forward: 2, laneWidth: 3.4, rail: false,
        bridge: false, corridor: `d${i}_u0`, width: 13.6,
      };
      na.links.push(e.id);
      nb.links.push(e.id);
      edges.push(e);
    };
    // a T junction: two collinear halves plus a stub, so `node.links.length`
    // reaches 3 and the corner kit (and its street blades) actually fires
    const mid = makeNode(nodes.length, x, 0);
    nodes.push(mid);
    mk(a, mid);
    mk(mid, b);
    mk(mid, c);
  }
  return {
    nodes,
    edges,
    edgesInRect(x0, z0, x1, z1, out) {
      out.length = 0;
      for (const e of edges) {
        const na = nodes[e.a];
        const nb = nodes[e.b];
        if (Math.min(na.x, nb.x) > x1 || Math.max(na.x, nb.x) < x0) continue;
        if (Math.min(na.z, nb.z) > z1 || Math.max(na.z, nb.z) < z0) continue;
        out.push(e);
      }
      return out;
    },
  };
}

/**
 * A physics stub. It is not a model of the city — it answers the three
 * questions `layout` asks and nothing else:
 *   down   there is a deck at the lot's own height (so the roof probe and the
 *          "is this building in the BVH" probe both succeed);
 *   across there is a wall exactly on the nominal line (push = 0);
 *   up     nothing overhead (headroom clear).
 */
function stubPhysics(deckFor) {
  return {
    MASK: { WORLD: 1 },
    raycast(x, y, z, dx, dy, dz, maxd) {
      if (dy < -0.5) {
        const deck = deckFor(x, z);
        if (deck === null) return { hit: false };
        const dist = y - deck;
        if (dist < 0 || dist > maxd) return { hit: false };
        return { hit: true, distance: dist, point: new THREE.Vector3(x, deck, z) };
      }
      if (dy > 0.5) return { hit: false };
      return {
        hit: true, distance: 1.9,
        point: new THREE.Vector3(x + dx * 1.9, y, z + dz * 1.9),
      };
    },
  };
}

/** Records everything the layout places. */
function stubBatch(lib) {
  const puts = [];
  return {
    lib,
    lamps: [],
    puts,
    put(id, m) {
      puts.push({ id, m: m.clone ? m.clone() : m });
      return this;
    },
    place(id, x, y, z, ry = 0, sx = 1, sy = sx, sz = sx) {
      const m = new THREE.Matrix4().makeRotationY(ry);
      m.scale(new THREE.Vector3(sx, sy, sz));
      m.setPosition(x, y, z);
      return this.put(id, m);
    },
    add() { return this; },
    box() { return this; },
  };
}

/** A rectangular lot with a frontage on its street side. */
function makeLot(id, cx, cz, w, d, height, kind, seed) {
  const hx = w / 2;
  const hz = d / 2;
  return {
    id,
    cx,
    cz,
    seed,
    kind,
    height,
    y: 0,
    district: districtAt(cx),
    footprint: [
      [cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz],
    ],
    // the -x face looks at the road that runs down the district lane
    frontage: [[cx - hx, cz - hz], [cx - hx, cz + hz]],
  };
}

function buildCity() {
  const roads = makeRoads();
  const lots = [];
  let n = 0;
  for (let i = 0; i < DISTRICTS.length; i++) {
    const x = i * LANE + 30;
    for (let k = 0; k < 8; k++) {
      const cz = -140 + k * 40;
      // one tall lot in four, so the rooftop hoarding pass has candidates
      const tall = k % 4 === 3;
      lots.push(makeLot(n, x + 11, cz, 22, 30, tall ? 26 : 11,
        k % 3 === 0 ? 'shop' : 'block', (n + 1) * 2654435761 >>> 0));
      n++;
    }
  }
  // The authored sites: a shop lot whose frontage centre sits on the POI.
  const authored = [];
  for (const p of [...POIS, ...SAFES]) {
    const lot = makeLot(n, p.x + 11, p.z, 22, 26, 10, 'shop', (n + 7) * 40503 >>> 0);
    lot.district = 'lawren';
    lots.push(lot);
    authored.push({ poi: p, lot });
    n++;
  }
  const deckByLot = lots.map((l) => ({ l, y: l.height }));
  const deckFor = (x, z) => {
    for (const { l, y } of deckByLot) {
      const f = l.footprint;
      if (x >= f[0][0] - 1 && x <= f[1][0] + 1 && z >= f[0][1] - 1 && z <= f[2][1] + 1) return y;
    }
    return 0.0;
  };
  const world = {
    roads,
    CITY_SIZE: 12000,
    heightAt: () => 0,
    districtAt: (x) => ({ id: districtAt(x) }),
    surfaceAt: () => 'sidewalk',
    isWater: () => false,
    streetAt: (x, z) => STREET_NAMES[Math.abs(Math.round(x / 37) + Math.round(z / 53))
      % STREET_NAMES.length],
    pois: POIS,
    safehouses: SAFES,
    bridges: BRIDGES,
    landmarks: LANDMARKS,
  };
  return { world, lots, authored, deckFor };
}

/**
 * Run the real `Layout` over the synthetic city and return every placement,
 * with the text each one carries resolved off the prototype record.
 */
function runLayout() {
  const lib = new ProtoLibrary({ get: () => ({ name: 'stub' }) });
  registerSignKit(lib);
  const { world, lots, authored, deckFor } = buildCity();
  const phys = stubPhysics(deckFor);
  const layout = new Layout({
    world,
    lib,
    peek: (k) => (k === 'physics' ? phys : null),
    q: { grassDensity: 0.6 },
  });
  const B = stubBatch(lib);

  // The whole map as one tile, so nothing is dropped on a bounds test: the
  // per-tile split is `world`'s business and this probe is not measuring it.
  const bx = { x0: -4000, z0: -4000, x1: 20000, z1: 20000 };
  for (const lot of lots) layout.lotWalls(B, lot, bx);
  // junction furniture (the street blades) and the named-place pass
  for (const e of world.roads.edges) layout._edgeFurniture(B, e, bx, 0, null);
  layout._placeSigns(B, bx);

  const out = [];
  for (const p of B.puts) {
    const rec = lib.protos.get(p.id);
    if (!rec) continue;
    const sx = new THREE.Vector3();
    const sy = new THREE.Vector3();
    const sz = new THREE.Vector3();
    const e = p.m.elements;
    sx.set(e[0], e[1], e[2]);
    sy.set(e[4], e[5], e[6]);
    sz.set(e[8], e[9], e[10]);
    out.push({
      id: p.id,
      surface: rec.surface,
      text: rec.owText?.text ?? null,
      x: e[12],
      y: e[13],
      z: e[14],
      scale: [sx.length(), sy.length(), sz.length()],
      capH: rec.owText ? sy.length() : 0,
    });
  }
  return { lib, placements: out, authored, world, lots };
}

/* ========================================================================= */
/* CLASSIFICATION — which family of sign is this?                            */
/* ========================================================================= */

const SHOP_SET = new Set([...SIGN_WORDS.core, ...SIGN_WORDS.market, ...SIGN_WORDS.row,
  ...SIGN_WORDS.mill, ...SIGN_WORDS.hill, ...SIGN_WORDS.civic, ...SIGN_WORDS.park]
  .flatMap((s) => [s, ...s.split(' ')]));
const BLADE_SET = new Set(SIGN_WORDS.blade);
const NEON_SET = new Set(SIGN_WORDS.neon);
const BILL_SET = new Set(SIGN_WORDS.billboard.flat());
const GHOST_SET = new Set(SIGN_WORDS.ghost.flat());
const PLATE_SET = new Set(STREET_NAMES.map(streetPlateText));
const BANNER_SET = new Set(Object.values(BANNER_WORDS).map((l) => l.join(' ')));
const AUTHORED_SET = new Set([...POIS, ...SAFES].map((p) => p.name.toUpperCase())
  .flatMap((s) => [s, ...s.split(' ')]));
const PLACE_SET = new Set([...BRIDGES, ...LANDMARKS].map((p) => p.name.toUpperCase())
  .flatMap((s) => [s, ...s.split(' ')]));
/**
 * THE REGULATORY PLATES. `layout.js` types the white plates on the street
 * kit's sign posts — they shipped blank, which is the "blank rectangles
 * standing in for signage" defect at two metres from the lens — and its
 * legends are the one vocabulary in the city that does not live in
 * `SIGN_WORDS`, because each line is sized against a specific plate. Read from
 * `layout.js`'s own export rather than restated here: a second copy of a word
 * list is a classifier that passes on words the city no longer says.
 */
const REG_SET = new Set(Object.values(REG_PLATES)
  .flat()
  .flatMap((d) => d.words)
  .map((lines) => lines.join(' ')));

function classify(p) {
  if (p.id.startsWith('nw_')) {
    if (p.id.includes('_halo_')) return 'neon_halo';
    if (p.id.endsWith('_dead')) return 'neon_dead';
    return 'neon';
  }
  if (!p.text) return null;
  if (p.surface === 'ghost_ink') return 'ghost';
  if (EMISSIVE[p.surface] && p.surface.startsWith('neon_')) return 'neon_vertical';
  const t = p.text;
  const words = t.split(' ');
  if (BANNER_SET.has(t)) return 'banner';
  if (PLATE_SET.has(t)) return 'street_plate';
  if (PLACE_SET.has(t) || words.every((w) => PLACE_SET.has(w))) return 'place_plaque';
  if (t.startsWith('STEEL ROW WORKS') || t.endsWith('LOWER STATION')) return 'place_plaque';
  if (BILL_SET.has(t)) return 'billboard';
  if (words.length === 1 && BLADE_SET.has(t)) return 'blade';
  if (words.length === 1 && NEON_SET.has(t)) return 'neon';
  if (AUTHORED_SET.has(t) || words.every((w) => AUTHORED_SET.has(w))) return 'fascia_authored';
  if (SHOP_SET.has(t) || words.every((w) => SHOP_SET.has(w))) return 'fascia';
  if (REG_SET.has(t)) return 'regulatory';
  if (t.length === 1) return 'neon_vertical';
  return 'unclassified';
}

/* ========================================================================= */
/* THE RUN                                                                   */
/* ========================================================================= */

// ---- 1. the alphabet -------------------------------------------------------
const glyphs = alphabetBitmaps();
const inked = [...glyphs.values()].filter((g) => g.bits.some((b) => b)).length;
check('every alphanumeric emits ink', inked === ALPHA.length,
  `${inked}/${ALPHA.length} glyphs have rasterised triangles`);

const live = worstAgreement(glyphs);
const LIMIT = 0.85;
check('the alphabet is discriminable', live.worst < LIMIT,
  `worst pair ${live.pair} shares ${(live.worst * 100).toFixed(1)}% of its ink (limit ${LIMIT * 100}%)`);

const ctrl = worstAgreement(blockFontBitmaps());
check('NEGATIVE CONTROL: a block font is NOT discriminable', ctrl.worst >= LIMIT,
  `control worst agreement ${(ctrl.worst * 100).toFixed(1)}%`);

// Kerning: a monospace grid is what a bar code looks like. Measured on the
// EMITTED width of two strings of equal length and very different letters.
const wIII = textWidth('IIIII');
const wMMM = textWidth('MMMMM');
check('the type is kerned, not monospaced', wMMM > wIII * 1.8,
  `IIIII ${wIII.toFixed(2)} em vs MMMMM ${wMMM.toFixed(2)} em`);

// ---- 2. the denylist -------------------------------------------------------
const run = runLayout();
const emittedStrings = new Set();
for (const p of run.placements) if (p.text) emittedStrings.add(p.text);
const vocab = [
  ...SHOP_SET, ...SIGN_WORDS.blade, ...SIGN_WORDS.neon,
  ...SIGN_WORDS.billboard.flat(), ...SIGN_WORDS.ghost.flat(),
  ...emittedStrings,
];
const hits = denyHits(vocab);
check('zero real-world trademarks in anything the city says', hits.length === 0,
  `${vocab.length} strings swept, ${hits.length} hits${hits.length ? `: ${hits.slice(0, 4).join(', ')}` : ''}`);
const ctrlHits = denyHits([...vocab, 'IRON CITY BREWING CO']);
check('NEGATIVE CONTROL: the denylist catches an injected mark', ctrlHits.length > 0,
  `${ctrlHits.length} hit(s) on the poisoned sweep`);

// ---- 3. what got emitted ---------------------------------------------------
const byKind = new Map();
const unclassified = [];
for (const p of run.placements) {
  const k = classify(p);
  if (!k) continue;
  if (k === 'unclassified') unclassified.push(p.text);
  byKind.set(k, (byKind.get(k) ?? 0) + 1);
}
const kinds = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
if (!args.json) {
  console.log('\n      emitted signs by kind');
  for (const [k, v] of kinds) console.log(`        ${k.padEnd(18)} ${v}`);
}
check('every emitted string classifies', unclassified.length === 0,
  unclassified.length ? `unclassified: ${[...new Set(unclassified)].slice(0, 5).join(' | ')}`
    : `${kinds.length} families`);

for (const k of ['fascia', 'blade', 'neon', 'ghost', 'billboard', 'street_plate',
  'place_plaque']) {
  check(`the city emits ${k} signs`, (byKind.get(k) ?? 0) > 0, `${byKind.get(k) ?? 0}`);
}

// ---- 4. the authored places are signed, at their own coordinates ----------
const missed = [];
for (const a of run.authored) {
  const want = a.poi.name.toUpperCase();
  const near = run.placements.filter((p) => p.text
    && Math.hypot(p.x - a.poi.x, p.z - a.poi.z) < 40
    && want.includes(p.text));
  if (!near.length) missed.push(`${a.poi.name} @ ${a.poi.x},${a.poi.z}`);
}
check('every authored shop and safehouse is signed at its own coordinates',
  missed.length === 0,
  missed.length ? `unsigned: ${missed.join('; ')}`
    : `${run.authored.length}/${run.authored.length} signed`);

// ---- 4b. the named places -------------------------------------------------
/**
 * A LANDMARK WITH NO SIGN IS THE FINDING. `--shot=mill` came back with the Old
 * Blast Furnace unlabelled on the first pass because the gate search ran one
 * ring and that ring had no spot with 6 m of lane clearance on it; these three
 * assertions are what turned that from "looks fine in a screenshot" into a
 * failure, and they measure the EMITTED placement's own coordinates.
 */
const placedNear = (name, x, z, r) => run.placements.some((p) => p.text
  && p.text.includes(name) && Math.hypot(p.x - x, p.z - z) < r);
check('the Old Blast Furnace gate is signed',
  placedNear('BLAST FURNACE', 872, 248, 160), 'within 160 m of the mill');
check('the Duquesne Incline station is signed',
  placedNear('INCLINE', -488, 296, 120), 'within 120 m of the lower station');
const unnamedBridges = BRIDGES.filter((b) => !run.placements.some((p) => p.text
  && b.name.toUpperCase().includes(p.text)
  && (Math.hypot(p.x - b.a[0], p.z - b.a[1]) < 40
    || Math.hypot(p.x - b.b[0], p.z - b.b[1]) < 40)));
check('every bridge carries a name plaque at an end', unnamedBridges.length === 0,
  unnamedBridges.length ? unnamedBridges.map((b) => b.name).join(', ')
    : `${BRIDGES.length}/${BRIDGES.length} bridges`);

// ---- 5. district density ---------------------------------------------------
const perDistrict = new Map();
for (const p of run.placements) {
  if (!p.text && !p.id.startsWith('nw_')) continue;
  const d = districtAt(p.x);
  perDistrict.set(d, (perDistrict.get(d) ?? 0) + 1);
}
if (!args.json) {
  console.log('\n      signs per district (identical lots in every one)');
  for (const d of DISTRICTS) console.log(`        ${d.padEnd(10)} ${perDistrict.get(d) ?? 0}`);
}
const dense = (perDistrict.get('strip') ?? 0) + (perDistrict.get('lawren') ?? 0);
const sparse = (perDistrict.get('mtwash') ?? 0) + (perDistrict.get('troy') ?? 0);
const mid = perDistrict.get('downtown') ?? 0;
check('the Strip and Butler Street are denser than the hills', dense > sparse * 1.15,
  `strip+lawren ${dense} vs mtwash+troy ${sparse}`);
check('downtown sits between them', mid > sparse / 2 && mid < dense,
  `downtown ${mid}, sparse pair ${sparse}, dense pair ${dense}`);
check('signage never reads as Times Square', dense < sparse * 6,
  `densest pair ${dense} is ${(dense / Math.max(1, sparse)).toFixed(1)}x the sparsest`);

// ---- 6. type survives placement -------------------------------------------
const typed = run.placements.filter((p) => p.text);
let skew = 0;
let worstSkew = 0;
for (const p of typed) {
  const [sx, sy, sz] = p.scale;
  const r = Math.max(sx, sy, sz) / Math.max(1e-6, Math.min(sx, sy, sz));
  worstSkew = Math.max(worstSkew, r);
  if (r > 1.02) skew++;
}
check('no piece of type rides a non-uniform scale', skew === 0,
  `${typed.length} instances, worst axis ratio ${worstSkew.toFixed(3)}`);

const ctrlSkewM = new THREE.Matrix4().makeScale(5, 1, 1);
const ce = ctrlSkewM.elements;
const cr = Math.max(
  new THREE.Vector3(ce[0], ce[1], ce[2]).length(),
  new THREE.Vector3(ce[4], ce[5], ce[6]).length()
) / Math.min(
  new THREE.Vector3(ce[0], ce[1], ce[2]).length(),
  new THREE.Vector3(ce[4], ce[5], ce[6]).length()
);
check('NEGATIVE CONTROL: the scale check sees a stretched matrix', cr > 1.02,
  `injected 5:1 matrix reads ${cr.toFixed(2)}`);

const tooSmall = typed.filter((p) => p.capH < 0.055);
check('every word is drawn at a legible cap height', tooSmall.length === 0,
  `min cap ${Math.min(...typed.map((p) => p.capH)).toFixed(3)} m over ${typed.length} words`);

// ---- 7. night neon ---------------------------------------------------------
const neonProtos = [...run.lib.protos.values()].filter((p) => p.id.startsWith('nw_'));
const emissiveNeon = neonProtos.filter((p) => EMISSIVE[p.surface] && !EMISSIVE[p.surface].additive);
const halos = neonProtos.filter((p) => EMISSIVE[p.surface]?.additive);
check('neon words are emissive, not lit surfaces', emissiveNeon.length > 0,
  `${emissiveNeon.length} emissive word protos of ${neonProtos.length}`);
check('every neon word carries an additive halo', halos.length > 0,
  `${halos.length} halo protos`);
const night = emissiveNeon.every((p) => {
  const d = EMISSIVE[p.surface];
  return d.base + d.night * 1.0 > d.base * 3;
});
check('neon runs up after dark', night,
  'base + night*mix at full night is more than 3x the daytime intensity');
const deadTubes = neonProtos.filter((p) => p.id.endsWith('_dead'));
check('some tubes are dead', deadTubes.length > 0,
  `${deadTubes.length} dead-tube protos (static failure, not animated flicker)`);

// ---- 8. the inks cost no texture memory ------------------------------------
const inkNames = ['sign_ink', 'sign_pale', 'sign_gilt'].map((k) => SURFACES[k]?.name);
check('the lettering inks share an existing bake', inkNames.every((n) => n === 'metal_painted'),
  `${inkNames.join(', ')} — tint is not part of materials._bakeKey, so no new texture set`);

/* ========================================================================= */
const failed = results.filter((r) => !r.ok);
if (args.json) {
  console.log(JSON.stringify({
    results,
    kinds: Object.fromEntries(byKind),
    perDistrict: Object.fromEntries(perDistrict),
    typeInstances: typed.length,
    protos: run.lib.protos.size,
  }, null, 2));
} else {
  console.log(`\nsignprobe: ${results.length - failed.length}/${results.length} checks green`);
}
if (args.gate && failed.length) process.exit(1);
