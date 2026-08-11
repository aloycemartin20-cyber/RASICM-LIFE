/**
 * ===========================================================================
 * THE STREET MAP
 * ===========================================================================
 *
 * One renderer, two consumers: the Slag Ring (a 190 px disc at 1.0-4.5 px/m)
 * and the pause map (full screen at 0.1-2 px/m). Sharing the projection is what
 * stops the two ever disagreeing about which way north is.
 *
 * SOURCE OF TRUTH
 *   `world.roads` — the RoadGraph. Nodes and edges, `kind` in
 *   highway|arterial|street|alley. We snapshot it into flat typed arrays and
 *   index those into a uniform grid, so a minimap frame strokes the ~60 edges
 *   actually on screen instead of all 3 000.
 *
 *   `world` may not exist yet when the map first draws (or may exist with an
 *   empty graph). When it doesn't, `_synthesise()` generates a deterministic
 *   Steel City network from the district/bridge/river tables in data.js: the
 *   same twelve districts, the same eleven bridges, the same three rivers. A
 *   capture taken at t=0 therefore still shows a real map of the right city.
 *   `refresh()` keeps polling, and swaps in the real graph the moment it lands.
 *
 * DRAWING
 *   Ground -> district tint -> parks -> water -> road casing -> road fill ->
 *   bridge decks -> labels. Casing-then-fill (two passes over the whole set,
 *   not per-edge) is what makes junctions read as junctions instead of a pile
 *   of overlapping outlines.
 */

import { clamp, clamp01, lerp } from './util.js';
import {
  RIVERS, DISTRICTS, BRIDGES, LANDMARKS, HALF_CITY, districtAt, POI_STYLE,
} from './data.js';

/**
 * Blip kinds the authored POI table does not carry, and the one lookup both
 * projections use. `chapter` is the NEXT story chapter's staging pin: a job
 * the player has NOT accepted, so it must not wear the live-mission amber or
 * the two become indistinguishable the moment a chapter is running. One owner,
 * two consumers (`radar.js`, `pausemap.js`) — the same rule the blip array
 * itself follows.
 */
const EXTRA_STYLE = {
  chapter: { c: '#7bc8ff', g: 'flag', p: 9, label: 'NEXT CHAPTER' },
};

/** POI/blip style for a kind, or null. Never invents a colour. */
export function styleFor(kind) {
  return POI_STYLE[kind] ?? EXTRA_STYLE[kind] ?? null;
}

/* ------------------------------------------------------------- palette --- */

/**
 * Map palette.
 *
 * The contrast budget is spent in one place: roads against ground. Everything
 * else — district tint, parks, water — sits inside a narrow band just above the
 * ground tone so the street network is unambiguously the brightest thing on the
 * disc and the blips are brighter still. Sampled values: ground L*≈13,
 * street L*≈46, highway L*≈73, blips L*≈70-90.
 */
export const MAP_INK = {
  land: '#161b21',
  landLo: '#10151a',
  // The rivers ARE the city — three of them meeting at The Point is the whole
  // silhouette — and at #082a36 they were L*≈14 against land at L*≈13, i.e. a
  // black shape on a black shape. Nothing about the map's read depends on the
  // water being dark; it depends on the water being UNAMBIGUOUSLY not land.
  water: '#12455a',
  waterEdge: 'rgba(86,214,206,.50)',
  park: '#18271e',
  casing: '#070a0e',
  street: '#606d7a',
  arterial: '#8d9bab',
  highway: '#c6d3e0',
  alley: '#525d69',
  rail: '#2e3640',
  // Bridges are the only way across, so they get the one warm ink on the map —
  // sodium against everything else's cold steel (DESIGN.md's palette), which is
  // what lets the player pick the next crossing out of a grid of grey at a
  // glance. Cold white read as "a slightly brighter street".
  bridge: '#ffca7a',
  bridgeCasing: '#1a0f06',
  label: 'rgba(203,216,229,.78)',
  streetLabel: 'rgba(178,196,216,.86)',
};

const KIND_ID = { highway: 3, arterial: 2, street: 1, alley: 0 };
/** Draw order: alleys first so arterials overprint them at junctions. */
const KIND_ORDER = [0, 1, 2, 3];
const KIND_COLOUR = [MAP_INK.alley, MAP_INK.street, MAP_INK.arterial, MAP_INK.highway];
/**
 * Stroke widths, in CSS px, NOT metres.
 *
 * Drawing roads at true metric width is the mistake that makes a game minimap
 * look like a blueprint: a 15 m arterial at the radar's closest zoom is 14 px
 * on a 196 px disc, so three roads fill the whole thing and the network
 * disappears into slabs. Every real map — paper, Google, GTA — draws roads at a
 * roughly constant screen width and lets the class carry the hierarchy. The
 * metric width still modulates within [min,max] so a six-lane arterial reads
 * fatter than a two-lane street when you are zoomed right in.
 */
const KIND_MIN = [0.8, 1.5, 2.1, 2.9];
const KIND_MAX = [1.7, 3.1, 4.6, 6.8];
/** ppm below which a class stops being drawn (LOD, keeps the map legible). */
const KIND_LOD = [0.34, 0.11, 0.0, 0.0];

const CELL = 128; // metres per spatial-index cell
/** New street-name lookups a single labelled frame may pay for. See below. */
const NAME_BUDGET = 24;

/* --------------------------------------------------------------- water --- */

function seg2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax;
  const dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return qx * qx + qz * qz;
}

/** Distance from (x,z) to the nearest river centreline, minus half its width. */
export function waterDepth(x, z) {
  let best = Infinity;
  for (let i = 0; i < RIVERS.length; i++) {
    const r = RIVERS[i];
    const p = r.pts;
    const hw = r.width * 0.5;
    for (let j = 0; j + 3 < p.length; j += 2) {
      const d2 = seg2(x, z, p[j], p[j + 1], p[j + 2], p[j + 3]);
      const d = Math.sqrt(d2) - hw;
      if (d < best) best = d;
    }
  }
  return best;
}

export const isWater = (x, z) => waterDepth(x, z) < 0;

/* ----------------------------------------------------------- the source --- */

export class CityMap {
  constructor(rng) {
    this.rng = rng;
    this.live = false; // true once world.roads is the source
    this.ready = false;
    this._tries = 0;

    // Flat edge arrays — grown once, never per frame.
    this.n = 0;
    this.x0 = new Float32Array(0);
    this.z0 = new Float32Array(0);
    this.x1 = new Float32Array(0);
    this.z1 = new Float32Array(0);
    this.kind = new Uint8Array(0);
    this.width = new Float32Array(0);
    this.bridge = new Uint8Array(0);
    this.y = new Float32Array(0);
    /**
     * Resolved street names, filled LAZILY and only for edges something asked
     * to label. A `world` edge usually carries `name: null` and defers to the
     * corridor table `route.js` reads, so the only honest source is
     * `world.streetAt` — which `ui` may not import (rule 2) and cannot afford
     * to call 3 000 times at adopt. Six visible arterials a frame, cached
     * for good, is the whole cost.
     */
    this.names = [];
    this.nameAt = null;

    this.cells = new Map();
    this._visit = null;
    this._out = [];
    this._stamp = 0;
    this._seen = null;

    this.parks = [];
    this._buildParks();
    this._synthesise();
  }

  /* ------------------------------------------------------------ sourcing -- */

  /**
   * Adopt `world.roads` once it exists and has edges. Cheap to call every few
   * frames; returns true when the source changed.
   */
  refresh(ctx) {
    if (this.live || this._tries > 400) return false;
    this._tries++;
    const world = ctx?.peek?.('world');
    const roads = world?.roads;
    const edges = roads?.edges;
    const nodes = roads?.nodes;
    if (!Array.isArray(edges) || !Array.isArray(nodes) || edges.length < 8) return false;

    this._alloc(edges.length);
    let n = 0;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      const a = nodes[e.a];
      const b = nodes[e.b];
      if (!a || !b) continue;
      if (e.rail) continue;
      this.x0[n] = a.x;
      this.z0[n] = a.z;
      this.x1[n] = b.x;
      this.z1[n] = b.z;
      this.kind[n] = KIND_ID[e.kind] ?? 1;
      this.width[n] = e.width ?? 8;
      this.bridge[n] = e.bridge ? 1 : 0;
      // Mid-deck height, so `streetAt` can tell a bridge from the quay it
      // flies over — eighteen metres apart and two metres apart in plan.
      this.y[n] = ((a.y ?? 0) + (b.y ?? 0)) * 0.5;
      n++;
    }
    if (n < 8) return false;
    this.n = n;
    this.live = true;
    this.names.length = 0;
    this.nameAt = typeof world.streetAt === 'function'
      ? (x, z, y) => world.streetAt(x, z, y)
      : null;
    this._index();
    return true;
  }

  /** The street name on edge `i`, resolved once and remembered. */
  edgeName(i) {
    const cached = this.names[i];
    if (cached !== undefined) return cached;
    const n = this.nameAt
      ? this.nameAt((this.x0[i] + this.x1[i]) * 0.5, (this.z0[i] + this.z1[i]) * 0.5, this.y[i])
      : null;
    this.names[i] = n || null;
    return this.names[i];
  }

  _alloc(cap) {
    if (this.x0.length >= cap) return;
    this.x0 = new Float32Array(cap);
    this.z0 = new Float32Array(cap);
    this.x1 = new Float32Array(cap);
    this.z1 = new Float32Array(cap);
    this.kind = new Uint8Array(cap);
    this.width = new Float32Array(cap);
    this.bridge = new Uint8Array(cap);
    this.y = new Float32Array(cap);
  }

  _index() {
    this.cells.clear();
    for (let i = 0; i < this.n; i++) {
      const cx0 = Math.floor(Math.min(this.x0[i], this.x1[i]) / CELL);
      const cx1 = Math.floor(Math.max(this.x0[i], this.x1[i]) / CELL);
      const cz0 = Math.floor(Math.min(this.z0[i], this.z1[i]) / CELL);
      const cz1 = Math.floor(Math.max(this.z0[i], this.z1[i]) / CELL);
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const k = cx * 73856093 ^ cz * 19349663;
          let l = this.cells.get(k);
          if (!l) this.cells.set(k, (l = []));
          l.push(i);
        }
      }
    }
    this._seen = new Int32Array(this.n);
    this._stamp = 0;
    this.ready = true;
  }

  /** Edge indices whose cell overlaps the world-space rect. Reused array. */
  query(x0, z0, x1, z1) {
    const out = this._out;
    out.length = 0;
    if (!this.n) return out;
    const stamp = ++this._stamp;
    const seen = this._seen;
    const cx0 = Math.floor(x0 / CELL);
    const cx1 = Math.floor(x1 / CELL);
    const cz0 = Math.floor(z0 / CELL);
    const cz1 = Math.floor(z1 / CELL);
    // A whole-city query is faster served linearly than through the map.
    if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 420) {
      for (let i = 0; i < this.n; i++) out.push(i);
      return out;
    }
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const l = this.cells.get(cx * 73856093 ^ cz * 19349663);
        if (!l) continue;
        for (let j = 0; j < l.length; j++) {
          const id = l[j];
          if (seen[id] === stamp) continue;
          seen[id] = stamp;
          out.push(id);
        }
      }
    }
    return out;
  }

  /* -------------------------------------------------------------- parks --- */

  _buildParks() {
    // The Point is a park by design; the rest are the green the twelve
    // districts each need so the map is not wall-to-wall grey.
    this.parks = [
      { x: -620, z: 40, r: 190 },
      { x: -232, z: 236, r: 92 },
      { x: 236, z: -400, r: 84 },
      { x: 704, z: -720, r: 96 },
      { x: -352, z: -712, r: 118 },
      { x: 520, z: -1180, r: 104 },
      { x: 88, z: 776, r: 96 },
      { x: -664, z: 560, r: 128 },
      { x: -1160, z: 448, r: 112 },
      { x: -1064, z: -712, r: 96 },
      { x: 1088, z: -160, r: 88 },
      { x: 892, z: 552, r: 78 },
    ];
  }

  /* -------------------------------------------------- fallback generator --- */

  /**
   * A deterministic Steel City network for the frames before `world` is up.
   *
   * Not a placeholder grid: district-local grids at per-district angles, an
   * arterial ring joining neighbouring districts, two river-following highways
   * and the eleven authored bridges. Water is respected — the only crossings
   * are the bridges, which is the whole point of this map.
   */
  _synthesise() {
    const rng = this.rng;
    const E = [];
    const push = (ax, az, bx, bz, kind, width, bridge = 0) => {
      E.push(ax, az, bx, bz, KIND_ID[kind], width, bridge);
    };
    const dryLine = (ax, az, bx, bz, margin = 6) => {
      const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, bz - az) / 24));
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        if (waterDepth(ax + (bx - ax) * t, az + (bz - az) * t) < margin) return false;
      }
      return true;
    };

    // ---- district grids ---------------------------------------------------
    for (let d = 0; d < DISTRICTS.length; d++) {
      const dd = DISTRICTS[d];
      const ang = rng.range(-0.9, 0.9) + (dd.id === 'downtown' ? 0.42 : 0);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      // Block sizes taken from the real thing: a downtown block is ~60 m, a
      // rowhouse block ~80 m, a mill site much coarser. At the radar's closest
      // zoom (190 m across) that puts three streets on the disc, which is what
      // makes it read as a city rather than as two lines crossing.
      const spacing = dd.id === 'downtown' ? 62 : dd.id === 'steelrow' ? 104 : 80;
      // 1.22 so neighbouring districts' grids overlap: a city is continuous,
      // and twelve tidy discs of streets with gaps between them is a boardgame.
      const R = dd.r * 1.22;
      const half = Math.ceil((R / spacing) * 2);
      const jitter = spacing * 0.1;
      for (let ii = -half; ii <= half; ii++) {
        // half-steps are alleys — the fine grain that makes a block a block
        const alley = ii % 2 !== 0;
        const i = ii >> 1;
        const off = ii * spacing * 0.5 + rng.range(-jitter, jitter);
        // chord half-length inside the disc
        const c = Math.abs(off) >= R ? 0 : Math.sqrt(R * R - off * off);
        if (c < 26) continue;
        const kind = alley ? 'alley' : i % 3 === 0 ? 'arterial' : 'street';
        const width = alley ? 6 : i % 3 === 0 ? 16 : 10;
        for (const axis of [0, 1]) {
          const ux = axis ? ca : -sa;
          const uz = axis ? sa : ca;
          const vx = axis ? -sa : ca;
          const vz = axis ? ca : sa;
          // walk the chord in segments so water can bite pieces out of it
          const segs = Math.max(2, Math.round((c * 2) / 96));
          let runStart = null;
          for (let s = 0; s <= segs; s++) {
            const t = -c + (2 * c * s) / segs;
            const px = dd.x + vx * off + ux * t;
            const pz = dd.z + vz * off + uz * t;
            const ok = waterDepth(px, pz) > 12 && Math.abs(px) < HALF_CITY - 40 &&
              Math.abs(pz) < HALF_CITY - 40;
            if (ok && runStart === null) runStart = [px, pz];
            else if (!ok && runStart) {
              const lx = dd.x + vx * off + ux * (t - (2 * c) / segs);
              const lz = dd.z + vz * off + uz * (t - (2 * c) / segs);
              if (Math.hypot(lx - runStart[0], lz - runStart[1]) > 40)
                push(runStart[0], runStart[1], lx, lz, kind, width);
              runStart = null;
            }
          }
          if (runStart) {
            const px = dd.x + vx * off + ux * c;
            const pz = dd.z + vz * off + uz * c;
            if (Math.hypot(px - runStart[0], pz - runStart[1]) > 40)
              push(runStart[0], runStart[1], px, pz, kind, width);
          }
        }
      }
    }

    // ---- arterials between neighbouring districts on the same bank --------
    for (let a = 0; a < DISTRICTS.length; a++) {
      for (let b = a + 1; b < DISTRICTS.length; b++) {
        const A = DISTRICTS[a];
        const B = DISTRICTS[b];
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d > 760) continue;
        if (!dryLine(A.x, A.z, B.x, B.z, 12)) continue;
        push(A.x, A.z, B.x, B.z, 'arterial', 16);
      }
    }

    // ---- the bridges ------------------------------------------------------
    for (const br of BRIDGES) {
      push(br.a[0], br.a[1], br.b[0], br.b[1], br.kind, br.kind === 'highway' ? 26 : 18, 1);
    }

    // ---- two highways, one per bank, following the rivers -----------------
    const HW = [
      [-1180, 200, -700, 150, -300, 190, 120, 380, 560, 560, 980, 660],
      [-1040, -420, -640, -300, -240, -230, 200, -330, 620, -520, 900, -760],
    ];
    for (const line of HW) {
      for (let i = 0; i + 3 < line.length; i += 2) {
        push(line[i], line[i + 1], line[i + 2], line[i + 3], 'highway', 30);
      }
    }

    // (An earlier pass scattered 40 random radial spurs here "for texture".
    // On the pause map they read as isolated dashes with no destination —
    // noise, not detail — so they are gone. Density has to come from the
    // district grids, which are at least coherent.)

    const n = E.length / 7;
    this._alloc(n);
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      this.x0[i] = E[o];
      this.z0[i] = E[o + 1];
      this.x1[i] = E[o + 2];
      this.z1[i] = E[o + 3];
      this.kind[i] = E[o + 4];
      this.width[i] = E[o + 5];
      this.bridge[i] = E[o + 6];
    }
    this.n = n;
    this._index();
  }

  /* --------------------------------------------------------------- draw --- */

  /**
   * @param {CanvasRenderingContext2D} g
   * @param {object} v { cx, cz, ppm, rot, w, h, alleys, tint, labels }
   *
   * The canvas transform is left set to world -> screen on exit, so callers can
   * keep drawing in world metres if they want; `g.save()/restore()` around this
   * is the caller's job.
   */
  draw(g, v) {
    const { w, h, ppm } = v;
    const rot = v.rot ?? 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);

    // ---- visible world rect (rotation-aware AABB) -------------------------
    const rad = Math.hypot(w, h) * 0.5 / ppm + 60;
    const x0 = v.cx - rad;
    const x1 = v.cx + rad;
    const z0 = v.cz - rad;
    const z1 = v.cz + rad;

    g.save();
    g.translate(w * 0.5, h * 0.5);
    g.rotate(rot);
    g.scale(ppm, ppm);
    g.translate(-v.cx, -v.cz);
    // Everything below is authored in world metres.
    const mpp = 1 / ppm; // metres per device pixel

    // ---- ground -----------------------------------------------------------
    g.fillStyle = MAP_INK.land;
    g.fillRect(x0, z0, x1 - x0, z1 - z0);

    // ---- district tint ----------------------------------------------------
    if (v.tint !== false) {
      for (let i = 0; i < DISTRICTS.length; i++) {
        const d = DISTRICTS[i];
        if (d.x + d.r < x0 || d.x - d.r > x1 || d.z + d.r < z0 || d.z - d.r > z1) continue;
        const grd = g.createRadialGradient(d.x, d.z, d.r * 0.15, d.x, d.z, d.r * 1.15);
        grd.addColorStop(0, d.tint);
        grd.addColorStop(1, 'rgba(0,0,0,0)');
        // Deliberately faint. The tint is there so the twelve districts read as
        // twelve different places on the pause map; on the radar it must never
        // compete with the roads.
        g.globalAlpha = 0.3;
        g.fillStyle = grd;
        g.beginPath();
        g.arc(d.x, d.z, d.r * 1.15, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    }

    // ---- parks ------------------------------------------------------------
    g.fillStyle = MAP_INK.park;
    for (let i = 0; i < this.parks.length; i++) {
      const p = this.parks[i];
      if (p.x + p.r < x0 || p.x - p.r > x1 || p.z + p.r < z0 || p.z - p.r > z1) continue;
      g.beginPath();
      g.arc(p.x, p.z, p.r, 0, Math.PI * 2);
      g.fill();
    }

    // ---- water ------------------------------------------------------------
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let pass = 0; pass < 2; pass++) {
      g.strokeStyle = pass === 0 ? MAP_INK.waterEdge : MAP_INK.water;
      for (let i = 0; i < RIVERS.length; i++) {
        const r = RIVERS[i];
        g.lineWidth = r.width + (pass === 0 ? Math.max(2.4 * mpp, 5) : 0);
        g.beginPath();
        g.moveTo(r.pts[0], r.pts[1]);
        for (let j = 2; j < r.pts.length; j += 2) g.lineTo(r.pts[j], r.pts[j + 1]);
        g.stroke();
      }
    }

    // ---- roads ------------------------------------------------------------
    const ids = this.query(x0, z0, x1, z1);
    const allowAlley = v.alleys !== false && ppm > 0.5;
    const px = v.px ?? 1; // device px per CSS px
    // Casing pass: one path per class, stroked once. Two passes over the whole
    // set (casing, then fill) is what makes junctions read.
    for (let k = 0; k < KIND_ORDER.length; k++) {
      const kk = KIND_ORDER[k];
      if (kk === 0 && !allowAlley) continue;
      if (ppm < KIND_LOD[kk]) continue;
      // widths are authored in CSS px; convert to metres for this transform
      const fill = clamp(
        this._classWidth(kk) * 0.72,
        KIND_MIN[kk] * px * mpp,
        KIND_MAX[kk] * px * mpp
      );
      const casing = fill + Math.max(1.6 * px * mpp, fill * 0.34);
      for (let pass = 0; pass < 2; pass++) {
        g.lineWidth = pass === 0 ? casing : fill;
        g.strokeStyle = pass === 0 ? MAP_INK.casing : KIND_COLOUR[kk];
        g.beginPath();
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          if (this.kind[id] !== kk) continue;
          g.moveTo(this.x0[id], this.z0[id]);
          g.lineTo(this.x1[id], this.z1[id]);
        }
        g.stroke();
      }
    }

    // ---- bridge decks: brighter than the road they carry, because on this
    // map the bridges are the only way across and the player is always
    // looking for the next one -------------------------------------------
    // Two passes, casing first and WIDER than the road's own casing: a warm
    // deck laid straight onto a cold grid needs its own dark gap or the two
    // inks meet and the crossing reads as a colour artefact rather than as a
    // separate structure. Casing is +2.6 px against the road's +1.6.
    if (ppm > 0.12) {
      g.lineCap = 'butt';
      for (let pass = 0; pass < 2; pass++) {
        g.strokeStyle = pass === 0 ? MAP_INK.bridgeCasing : MAP_INK.bridge;
        for (let i = 0; i < ids.length; i++) {
          const id = ids[i];
          if (!this.bridge[id]) continue;
          const kk = this.kind[id];
          const fill = clamp(
            this._classWidth(kk) * 0.72,
            KIND_MIN[kk] * px * mpp,
            KIND_MAX[kk] * px * mpp
          );
          g.lineWidth = pass === 0 ? fill + Math.max(2.6 * px * mpp, fill * 0.5) : fill;
          g.beginPath();
          g.moveTo(this.x0[id], this.z0[id]);
          g.lineTo(this.x1[id], this.z1[id]);
          g.stroke();
        }
      }
      g.lineCap = 'round';
    }

    g.restore();

    // ---- labels are drawn in screen space so they never rotate ------------
    if (v.labels) this._labels(g, v, cos, sin);
    // ...except street names, which run ALONG their street: a name floating
    // free of the line it belongs to labels nothing on a map this dense.
    if (v.streets) this._streetLabels(g, v, cos, sin, ids);
  }

  _classWidth(k) {
    return k === 3 ? 26 : k === 2 ? 15 : k === 1 ? 10 : 7;
  }

  /**
   * Street names, written ALONG the arterials and highways on screen.
   *
   * Four rules, each of which is why a naive version draws nothing or draws
   * mush:
   *
   *   - only ARTERIAL and HIGHWAY (`kind >= 2`). Naming every residential
   *     street at radar zoom writes four labels into a 190 m disc;
   *   - the length gate is on the RUN — every visible edge sharing the name,
   *     summed — not on one edge. MEASURED on the emitted graph: a named
   *     arterial is chopped into ~30 m graph edges, which is 19 device px at
   *     the radar's closest zoom, so a per-edge gate at any useful threshold
   *     labels NOTHING. The first version of this method did exactly that and
   *     drew zero labels on a disc with 674 arterial edges behind it;
   *   - the gate is in SCREEN PIXELS. "Is there room to write this here" is a
   *     screen question, not a metres one;
   *   - one label per NAME, placed on the run's edge nearest the view centre.
   *     Otherwise "LIBERTY AVENUE" is written a dozen times down one road.
   *
   * Text runs along the edge and is flipped through 180 degrees when that would
   * put it upside down, which is what every paper map does and what makes the
   * name readable without the player tilting his head.
   */
  _streetLabels(g, v, cos, sin, ids) {
    const { w, h, ppm } = v;
    if (!this.live || !this.nameAt) return;
    const px = v.px ?? 1;
    const rot = v.rot ?? 0;
    const minRun = 84 * px; // device px of road under the name
    const fs = clamp(9.2 * px, 8, 22);
    // Preallocated candidate records, linear-scanned (rule 5). A dozen names
    // fit on the widest view this ever draws, so a Map would cost more in
    // per-frame entry churn than the scan costs in comparisons.
    const pool = (this._namePool ??= []);
    let np = 0;
    /**
     * NEW name resolutions this frame. A name costs one `world.streetAt` the
     * first time it is wanted and nothing ever after, but the pause map's
     * widest labelled view has ~830 arterial edges on screen at once — so an
     * unbudgeted first frame does 830 spatial queries in one go and the map
     * opens with a hitch. Bounded here and converged over the next half second;
     * an unresolved edge is simply skipped this frame, never guessed at.
     */
    let budget = NAME_BUDGET;

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (this.kind[id] < 2) continue;
      const ax = (this.x0[id] - v.cx) * ppm;
      const az = (this.z0[id] - v.cz) * ppm;
      const bx = (this.x1[id] - v.cx) * ppm;
      const bz = (this.z1[id] - v.cz) * ppm;
      const run = Math.hypot(bx - ax, bz - az);
      const mx = (ax + bx) * 0.5;
      const mz = (az + bz) * 0.5;
      const sx = w * 0.5 + mx * cos - mz * sin;
      const sy = h * 0.5 + mx * sin + mz * cos;
      if (sx < 0 || sy < 0 || sx > w || sy > h) continue;
      let name = this.names[id];
      if (name === undefined) {
        if (budget <= 0) continue;
        budget--;
        name = this.edgeName(id);
      }
      if (!name) continue;
      let slot = -1;
      for (let j = 0; j < np; j++) if (pool[j].name === name) { slot = j; break; }
      if (slot < 0) {
        slot = np++;
        pool[slot] ??= { name: '', d2: 0, run: 0, x: 0, y: 0, a: 0, used: false };
        const r0 = pool[slot];
        r0.name = name;
        r0.run = 0;
        r0.d2 = Infinity;
        r0.used = false;
      }
      const r = pool[slot];
      r.run += run;
      // The label goes on the segment closest to the middle of the view, which
      // is the one least likely to be clipped and the one the player is
      // actually looking at.
      const d2 = (sx - w * 0.5) ** 2 + (sy - h * 0.5) ** 2;
      if (d2 >= r.d2) continue;
      let a = Math.atan2(bz - az, bx - ax) + rot;
      if (a > Math.PI * 0.5 || a < -Math.PI * 0.5) a += Math.PI;
      r.d2 = d2;
      r.x = sx;
      r.y = sy;
      r.a = a;
    }
    if (!np) return;

    g.save();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `700 ${fs.toFixed(1)}px ${v.font}`;
    g.lineJoin = 'round';
    g.lineWidth = Math.max(2.4, fs * 0.32);
    g.strokeStyle = 'rgba(4,7,10,.92)';
    g.fillStyle = MAP_INK.streetLabel;

    /**
     * LONGEST RUN FIRST, and no two labels on top of each other. Without both,
     * a 178 px disc over downtown draws eight names into the space of three and
     * the result is less legible than no names at all — MEASURED on the hud
     * capture, where Fifth Avenue, Grant Street and two bridge decks landed in
     * one 40 px square. Selection is a scan rather than a sort because the
     * candidate list is a dozen entries and a sort allocates.
     */
    const max = v.streetMax ?? 4;
    const taken = (this._nameTaken ??= new Float32Array(64));
    let nt = 0;
    for (let k = 0; k < max; k++) {
      let pick = -1;
      let best = minRun;
      for (let j = 0; j < np; j++) {
        const m = pool[j];
        if (m.used || m.run < best) continue;
        best = m.run;
        pick = j;
      }
      if (pick < 0) break;
      const m = pool[pick];
      m.used = true;
      const half = Math.max(g.measureText(m.name).width * 0.5, fs * 2) + fs * 0.5;
      let clash = false;
      for (let t = 0; t < nt && !clash; t++) {
        const dx = m.x - taken[t * 3];
        const dy = m.y - taken[t * 3 + 1];
        if (Math.hypot(dx, dy) < half + taken[t * 3 + 2]) clash = true;
      }
      if (clash) {
        k--; // a rejected candidate does not spend one of the label slots
        continue;
      }
      if (nt * 3 + 2 < taken.length) {
        taken[nt * 3] = m.x;
        taken[nt * 3 + 1] = m.y;
        taken[nt * 3 + 2] = half;
        nt++;
      }
      g.save();
      g.translate(m.x, m.y);
      g.rotate(m.a);
      g.strokeText(m.name, 0, -fs * 0.95);
      g.fillText(m.name, 0, -fs * 0.95);
      g.restore();
    }
    for (let j = 0; j < np; j++) pool[j].used = false;
    g.restore();
  }

  _labels(g, v, cos, sin) {
    const { w, h, ppm } = v;
    const proj = (x, z, out) => {
      const dx = (x - v.cx) * ppm;
      const dz = (z - v.cz) * ppm;
      out[0] = w * 0.5 + dx * cos - dz * sin;
      out[1] = h * 0.5 + dx * sin + dz * cos;
    };
    const p = this._lp ?? (this._lp = [0, 0]);
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    if (ppm > 0.055) {
      const fs = clamp(v.labelScale * 12, 9, 15);
      g.font = `700 ${fs}px ${v.font}`;
      g.fillStyle = MAP_INK.label;
      g.strokeStyle = 'rgba(4,7,10,.9)';
      g.lineWidth = 3;
      g.lineJoin = 'round';
      for (let i = 0; i < DISTRICTS.length; i++) {
        const d = DISTRICTS[i];
        proj(d.x, d.z, p);
        if (p[0] < -80 || p[1] < -20 || p[0] > w + 80 || p[1] > h + 20) continue;
        g.strokeText(d.name, p[0], p[1]);
        g.fillText(d.name, p[0], p[1]);
      }
    }
    if (ppm > 0.22 && v.landmarks !== false) {
      const fs = clamp(v.labelScale * 9.5, 8, 12);
      g.font = `600 ${fs}px ${v.font}`;
      g.fillStyle = 'rgba(255,201,60,.66)';
      g.strokeStyle = 'rgba(4,7,10,.85)';
      g.lineWidth = 2.6;
      for (let i = 0; i < LANDMARKS.length; i++) {
        const l = LANDMARKS[i];
        proj(l.x, l.z, p);
        if (p[0] < -60 || p[1] < -20 || p[0] > w + 60 || p[1] > h + 20) continue;
        g.strokeText(l.name, p[0], p[1] - fs * 1.5);
        g.fillText(l.name, p[0], p[1] - fs * 1.5);
      }
    }
  }
}

/* ---------------------------------------------------------------- icons --- */

/**
 * POI glyphs, drawn as paths. `r` is the half-size in device px. Every icon is
 * a filled shape on a dark rounded plate — an outline-only icon disappears the
 * moment the map under it goes light, which it does over water and parks.
 */
export function drawIcon(g, kind, x, y, r, colour, alpha = 1) {
  g.save();
  g.globalAlpha = alpha;
  g.translate(x, y);

  // plate
  g.fillStyle = 'rgba(6,10,14,.86)';
  g.strokeStyle = colour;
  g.lineWidth = Math.max(1, r * 0.16);
  roundRect(g, -r, -r, r * 2, r * 2, r * 0.34);
  g.fill();
  g.stroke();

  g.fillStyle = colour;
  g.strokeStyle = colour;
  g.lineWidth = Math.max(1, r * 0.2);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const s = r * 0.62;

  switch (kind) {
    case 'home': // safehouse
      g.beginPath();
      g.moveTo(0, -s);
      g.lineTo(s, 0);
      g.lineTo(s * 0.62, 0);
      g.lineTo(s * 0.62, s * 0.8);
      g.lineTo(-s * 0.62, s * 0.8);
      g.lineTo(-s * 0.62, 0);
      g.lineTo(-s, 0);
      g.closePath();
      g.fill();
      break;
    case 'fuel':
      g.beginPath();
      g.rect(-s * 0.85, -s * 0.9, s * 1.15, s * 1.8);
      g.fill();
      g.beginPath();
      g.moveTo(s * 0.42, -s * 0.35);
      g.lineTo(s * 0.85, -s * 0.35);
      g.lineTo(s * 0.85, s * 0.55);
      g.stroke();
      break;
    case 'spray':
      g.beginPath();
      g.arc(0, 0, s * 0.78, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = 'destination-out';
      g.beginPath();
      g.arc(0, 0, s * 0.34, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = 'source-over';
      break;
    case 'ammo':
      g.beginPath();
      g.rect(-s, -s * 0.34, s * 1.5, s * 0.68);
      g.fill();
      g.beginPath();
      g.rect(-s * 0.2, s * 0.2, s * 0.42, s * 0.7);
      g.fill();
      break;
    case 'food':
      g.beginPath();
      g.moveTo(0, s * 0.75);
      g.bezierCurveTo(-s * 1.3, -s * 0.1, -s * 0.5, -s * 0.95, 0, -s * 0.3);
      g.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.3, -s * 0.1, 0, s * 0.75);
      g.fill();
      break;
    case 'star':
      star(g, 0, 0, s, s * 0.44, 5);
      g.fill();
      break;
    case 'plane':
      g.beginPath();
      g.moveTo(0, -s);
      g.lineTo(s * 0.22, -s * 0.1);
      g.lineTo(s, s * 0.35);
      g.lineTo(s, s * 0.6);
      g.lineTo(s * 0.22, s * 0.35);
      g.lineTo(s * 0.22, s * 0.72);
      g.lineTo(s * 0.5, s);
      g.lineTo(-s * 0.5, s);
      g.lineTo(-s * 0.22, s * 0.72);
      g.lineTo(-s * 0.22, s * 0.35);
      g.lineTo(-s, s * 0.6);
      g.lineTo(-s, s * 0.35);
      g.lineTo(-s * 0.22, -s * 0.1);
      g.closePath();
      g.fill();
      break;
    case 'boat':
      g.beginPath();
      g.moveTo(-s, s * 0.15);
      g.lineTo(s, s * 0.15);
      g.lineTo(s * 0.6, s * 0.8);
      g.lineTo(-s * 0.6, s * 0.8);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(0, s * 0.05);
      g.lineTo(0, -s);
      g.lineTo(s * 0.7, -s * 0.45);
      g.closePath();
      g.fill();
      break;
    case 'bridge':
      g.beginPath();
      g.moveTo(-s, s * 0.55);
      g.quadraticCurveTo(0, -s * 0.9, s, s * 0.55);
      g.stroke();
      g.beginPath();
      g.moveTo(-s, s * 0.55);
      g.lineTo(s, s * 0.55);
      g.stroke();
      break;
    case 'pkg':
      g.beginPath();
      g.moveTo(0, -s);
      g.lineTo(s, -s * 0.4);
      g.lineTo(s, s * 0.5);
      g.lineTo(0, s);
      g.lineTo(-s, s * 0.5);
      g.lineTo(-s, -s * 0.4);
      g.closePath();
      g.fill();
      break;
    case 'flag':
      g.beginPath();
      g.moveTo(-s * 0.5, s);
      g.lineTo(-s * 0.5, -s);
      g.stroke();
      g.beginPath();
      g.moveTo(-s * 0.5, -s);
      g.lineTo(s * 0.85, -s * 0.5);
      g.lineTo(-s * 0.5, 0);
      g.closePath();
      g.fill();
      break;
    case 'mission':
      star(g, 0, 0, s * 1.02, s * 0.42, 5);
      g.fill();
      break;
    case 'dot':
    default:
      g.beginPath();
      g.arc(0, 0, s * 0.7, 0, Math.PI * 2);
      g.fill();
      break;
  }
  g.restore();
}

export function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

export function star(g, cx, cy, ro, ri, points) {
  g.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 ? ri : ro;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) g.moveTo(x, y);
    else g.lineTo(x, y);
  }
  g.closePath();
}

/** The player chevron. Drawn at the origin pointing "up" (-y). */
export function drawPlayerArrow(g, r, colour, inVehicle) {
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.beginPath();
  if (inVehicle) {
    g.moveTo(0, -r * 1.5);
    g.lineTo(r * 0.78, -r * 0.2);
    g.lineTo(r * 0.78, r * 1.25);
    g.lineTo(-r * 0.78, r * 1.25);
    g.lineTo(-r * 0.78, -r * 0.2);
  } else {
    g.moveTo(0, -r * 1.62);
    g.lineTo(r * 1.16, r * 1.3);
    g.lineTo(0, r * 0.58);
    g.lineTo(-r * 1.16, r * 1.3);
  }
  g.closePath();
  g.strokeStyle = 'rgba(3,6,9,.92)';
  g.lineWidth = Math.max(1.6, r * 0.42);
  g.stroke();
  g.fillStyle = colour;
  g.fill();
}

export { clamp, clamp01, lerp, districtAt };
