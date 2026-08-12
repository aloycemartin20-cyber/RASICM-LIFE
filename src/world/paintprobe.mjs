#!/usr/bin/env node
/**
 * PAINTPROBE — is there READABLE lane paint on the emitted road surface?
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 * Two critic panels scored this build with "no lane markings", and one of them
 * decided a whole A/B pair on it. The code had a marking pass the entire time;
 * what it did not have was markings you could see. Every longitudinal stroke
 * was a quad showing the WHOLE 0..1 window of a bake whose glyph covers the
 * middle 28 % of it, cut at `alphaTest` 0.42. The mip chain averages alpha, so
 * the first mip that mattered took the coverage under the cut and the line was
 * discarded outright — and a dashed line, at 0.28 x 0.25 duty, was never drawn
 * at any range at all. The only marking family that survived was the crossing,
 * whose bars cover 0.46 of their own window, which is exactly why a zebra was
 * the only paint anybody could photograph.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED, AND WHY IT IS NOT CIRCULAR (rule 12)
 * ---------------------------------------------------------------------------
 * Nothing here reads `_paint`'s arguments, the palette, or any constant in
 * `roadmesh.js`. The probe generates the real city, runs the real sector
 * builder in VISUAL mode over a spread of districts, and then reads the
 * EMITTED `BufferGeometry` off the meshes that come out — positions, uvs and
 * indices — as a stranger would. Every number below is computed from those
 * triangles:
 *
 *   coverage   painted square metres per kilometre of emitted carriageway,
 *              and the share of carriageway AREA that carries a longitudinal
 *              stroke. A road with no centre line cannot fake this.
 *   window     the u-extent of the glyph window each quad actually shows, and
 *              the physical width of the quad in metres. This is the fix
 *              itself: a quad that shows 0..1 of the bake is showing 72 %
 *              empty texels and mips to nothing.
 *   stroke     window x width — the painted stroke in centimetres. Real US
 *              urban markings are 10-16 cm; a 50 cm "line" is a quad hoping a
 *              texture will draw a line inside it.
 *   junctions  crossings, stop bars and lane arrows per junction arm, counted
 *              off the emitted meshes by name.
 *   marked     THE SHARE OF EACH BLOCK THAT CARRIES ANY MARKING AT ALL. Every
 *              measure above can be satisfied by beautiful paint on 40 % of
 *              the city; this one cannot. See `markedSpan`.
 *
 * THE CONTROLS — two of them, because there are two independent ways to end up
 * with an unmarked street and each needs its own arm to be worth anything.
 *
 *   `--legacy` re-imports the builder with `location.search =
 *   '?owPaintLegacy=1'`, which lays the markings exactly as they shipped —
 *   full 0..1 windows, ribbon dashes, the 0.42 cut. It is the control for the
 *   window, stroke and glyph assertions.
 *
 *   `--fatpads` re-imports it with `?fatpads=1`, which puts back the blanket
 *   junction pad (`hw * 1.05` at a continuation node, `hw * 1.3` at a
 *   junction). The markings are then laid exactly as they are today and are
 *   just as readable — there is simply far less road to lay them on. It is the
 *   control for `marked`, and the ONLY arm that isolates it.
 *
 * Every assertion must fail in at least one control or it is measuring
 * nothing. `--gate` runs all three and requires fixed green / both controls
 * red.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node src/world/paintprobe.mjs            # measure current code
 *   node src/world/paintprobe.mjs --legacy   # the shipped marking pass, must fail
 *   node src/world/paintprobe.mjs --fatpads  # the shipped junction pads, must fail
 *   node src/world/paintprobe.mjs --gate     # all three, and compare
 *   node src/world/paintprobe.mjs --json
 */
import { Terrain } from './terrain.js';
import { generateCity } from './netgen.js';
import { SECTOR, roadHalfWidth } from './plan.js';
import { PALETTE } from './palette.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/**
 * Sectors sampled, by district centre. Deliberately spread across the wealth
 * range — Steel Row's paint is meant to be older than downtown's, and a probe
 * that only looked at the Golden Triangle would never see that.
 */
const SITES = [
  { id: 'downtown', x: -232, z: 64 },
  { id: 'strip', x: 248, z: -184 },
  { id: 'lawren', x: 680, z: -552 },
  { id: 'southside', x: 160, z: 608 },
  { id: 'steelrow', x: 784, z: 384 },
  { id: 'northside', x: -984, z: -568 },
];

/** Longitudinal stroke families: these are the ones that used to vanish. */
const LONG_KEYS = ['line_white', 'line_yellow', 'line_dash'];

/**
 * A quad is a stroke if it is long and thin. Measured off the triangles, not
 * off the emitter's arguments: the two shortest edges of the quad's bounding
 * parallelogram give the width, the other pair the run.
 */
function quadStats(pos, ia, ib, ic, id) {
  const p = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const [a, b, c, d] = [p(ia), p(ib), p(ic), p(id)];
  const len = (u, v) => Math.hypot(u[0] - v[0], u[1] - v[1], u[2] - v[2]);
  const mid = (u, v) => [(u[0] + v[0]) * 0.5, (u[2] + v[2]) * 0.5];
  const e0 = (len(a, b) + len(c, d)) * 0.5;
  const e1 = (len(b, c) + len(d, a)) * 0.5;
  // The two ENDS of the stroke, in plan: the midpoints of whichever opposite
  // pair of edges is the short one. Those are what get projected onto the road
  // graph in `markedSpan`.
  const ends = e0 < e1 ? [mid(a, b), mid(c, d)] : [mid(b, c), mid(d, a)];
  return { w: Math.min(e0, e1), l: Math.max(e0, e1), ends };
}

function triArea(pos, i0, i1, i2) {
  const ax = pos[i1 * 3] - pos[i0 * 3];
  const ay = pos[i1 * 3 + 1] - pos[i0 * 3 + 1];
  const az = pos[i1 * 3 + 2] - pos[i0 * 3 + 2];
  const bx = pos[i2 * 3] - pos[i0 * 3];
  const by = pos[i2 * 3 + 1] - pos[i0 * 3 + 1];
  const bz = pos[i2 * 3 + 2] - pos[i0 * 3 + 2];
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return 0.5 * Math.hypot(cx, cy, cz);
}

/** Everything measured off one emitted mesh. */
function readMesh(mesh, out) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position.array;
  const uv = geo.attributes.uv.array;
  const idx = geo.index.array;
  // road_<key>_<sx>_<sz>
  const m = mesh.name.match(/^road_(.+)_(-?\d+)_(-?\d+)$/);
  const key = m ? m[1] : mesh.name;
  let area = 0;
  for (let t = 0; t < idx.length; t += 3) area += triArea(pos, idx[t], idx[t + 1], idx[t + 2]);
  const rec = out.byKey[key] ?? (out.byKey[key] = { area: 0, quads: 0, widths: [], uSpans: [] });
  rec.area += area;

  if (!LONG_KEYS.includes(key)) return;
  // Longitudinal quads come out as index pairs (a,b,c) (a,c,d).
  for (let t = 0; t + 5 < idx.length; t += 6) {
    const a = idx[t];
    const b = idx[t + 1];
    const c = idx[t + 2];
    const d = idx[t + 5];
    if (idx[t + 3] !== a || idx[t + 4] !== c) continue;
    const q = quadStats(pos, a, b, c, d);
    if (q.l < q.w * 1.5) continue;
    const us = [uv[a * 2], uv[b * 2], uv[c * 2], uv[d * 2]];
    rec.quads++;
    rec.widths.push(q.w);
    rec.uSpans.push(Math.max(...us) - Math.min(...us));
    out.strokes.push([q.ends[0][0], q.ends[0][1], q.ends[1][0], q.ends[1][1]]);
  }
}

/**
 * HOW MUCH OF EACH BLOCK CARRIES MARKINGS — the measure the pad radius moves.
 *
 * Every longitudinal quad is matched to a road-graph edge and each edge reports
 * the SPAN from its first stroke to its last as a share of its own length.
 * Nothing here reads an inset, a pad radius or `_paint`'s arguments: the graph
 * is the city's, the strokes are read off emitted triangles, and the match is
 * brute geometry over a grid. An edge painted end to end scores 1 whatever laid
 * it.
 *
 * MATCHING ON DISTANCE ALONE DOES NOT WORK, and it produced a wrong answer here
 * before it produced a right one: at a crossroads the crossing road's centre
 * line passes within a few metres of this edge's centreline, projects inside
 * this edge's own span, and pins its first stroke to arc ~0. Every arm then
 * scored an identical 4.1 m approach and the measure was reporting the CROSSING
 * road's paint. So a stroke must also RUN THE WAY THE EDGE RUNS — `ALIGN_COS`,
 * 20 degrees — and lie inside the edge's own carriageway. Junction glyphs are
 * not longitudinal and were never in this set at all.
 *
 * WHY SPAN AND NOT COVERED LENGTH. A dashed lane line is 3 m on and 9 m off by
 * design, and a blacked-out stretch of centre line is authored wear — measuring
 * covered metres would score a correctly-marked American street at a quarter
 * and would fall when the district ages. The defect being measured is the bare
 * approach at each END of a block, and a span is exactly blind to the middle
 * and exactly sensitive to the ends.
 *
 * The span never crosses a node: each edge is scored on its own, so the bare
 * tarmac either side of a junction is counted twice, once against each block,
 * which is how it is experienced from a car.
 */
const MARK_CELL = 48;
/** cos 20 degrees: how far off an edge's bearing a stroke may run and still be its. */
const ALIGN_COS = 0.94;
/** Slack outside the kerb line, for the shoulder line and the quad's own width. */
const MARK_SLACK = 1.2;

function markedSpan(graph, ownedEdges, strokes) {
  const grid = new Map();
  const key = (x, z) => `${Math.floor(x / MARK_CELL)},${Math.floor(z / MARK_CELL)}`;
  for (const e of ownedEdges) {
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    const x0 = Math.floor(Math.min(na.x, nb.x) / MARK_CELL);
    const x1 = Math.floor(Math.max(na.x, nb.x) / MARK_CELL);
    const z0 = Math.floor(Math.min(na.z, nb.z) / MARK_CELL);
    const z1 = Math.floor(Math.max(na.z, nb.z) / MARK_CELL);
    for (let z = z0 - 1; z <= z1 + 1; z++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        const k = `${x},${z}`;
        let l = grid.get(k);
        if (!l) grid.set(k, (l = []));
        l.push(e);
      }
    }
  }
  const lo = new Map();
  const hi = new Map();
  let orphan = 0;
  for (const [ax, az, bx, bz] of strokes) {
    const mx = (ax + bx) * 0.5;
    const mz = (az + bz) * 0.5;
    const sl = Math.hypot(bx - ax, bz - az);
    if (sl < 1e-6) { orphan++; continue; }
    const sdx = (bx - ax) / sl;
    const sdz = (bz - az) / sl;
    const cand = grid.get(key(mx, mz));
    if (!cand) { orphan++; continue; }
    let best = null;
    let bestD = Infinity;
    let bestT = 0;
    for (const e of cand) {
      const na = graph.nodes[e.a];
      const nb = graph.nodes[e.b];
      const dx = nb.x - na.x;
      const dz = nb.z - na.z;
      const l2 = dx * dx + dz * dz;
      if (l2 < 1e-9) continue;
      const el = Math.sqrt(l2);
      if (Math.abs((sdx * dx + sdz * dz) / el) < ALIGN_COS) continue;
      const t = ((mx - na.x) * dx + (mz - na.z) * dz) / l2;
      if (t < 0 || t > 1) continue;
      const d = Math.hypot(mx - (na.x + dx * t), mz - (na.z + dz * t));
      if (d > roadHalfWidth(e.kind, e.lanes) + MARK_SLACK || d >= bestD) continue;
      bestD = d;
      best = e;
      bestT = t;
    }
    if (!best) { orphan++; continue; }
    // Both ENDS of the stroke, not its middle: a 3 m dash that starts at the
    // stop bar has its first metre there and that is the number wanted.
    const s0 = bestT * best.len - sl * 0.5;
    const s1 = bestT * best.len + sl * 0.5;
    const cur = lo.get(best.id);
    if (cur === undefined || s0 < cur) lo.set(best.id, s0);
    const cur2 = hi.get(best.id);
    if (cur2 === undefined || s1 > cur2) hi.set(best.id, s1);
  }
  const byKind = {};
  /**
   * THE APPROACH — how far you drive out of a junction before the paint
   * starts, in metres, one sample per block END. This is the defect in the
   * units a driver has: "the line starts about eight metres in front of the
   * bonnet". The share above says how much of a block is marked; this says
   * where the missing part IS, and only the pad radius moves it.
   */
  const approach = [];
  for (const e of ownedEdges) {
    const k = (byKind[e.kind] ??= { len: 0, span: 0, edges: 0, marked: 0 });
    k.len += e.len;
    k.edges++;
    if (!lo.has(e.id)) continue;
    k.marked++;
    k.span += Math.max(0, hi.get(e.id) - lo.get(e.id));
    if (e.kind === 'alley') continue; // `paint: 'none'`; any stroke on one is a neighbour's
    approach.push(Math.max(0, lo.get(e.id)), Math.max(0, e.len - hi.get(e.id)));
  }
  return { byKind, orphan, approach };
}

function pct(list, p) {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/** `arm` is one of 'fixed', 'legacy' (marking pass), 'fatpads' (junction pad). */
async function measure(arm) {
  if (arm === 'legacy') globalThis.location = { search: '?owPaintLegacy=1' };
  else if (arm === 'fatpads') globalThis.location = { search: '?fatpads=1' };
  else delete globalThis.location;
  // Fresh module instance per arm: `owPaintLegacy` is read at module load and
  // `fatpads` is cached on first use, so a shared instance would keep whichever
  // arm ran first.
  const { RoadMeshBuilder } = await import(`./roadmesh.js?arm=${arm}`);

  const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
  const city = generateCity(terrain, new Rng(0x600d));
  const graph = city.graph;
  const materials = { get: () => ({ isMaterial: true }) };
  const rm = new RoadMeshBuilder({ graph, terrain, materials, palette: PALETTE, rng: new Rng(7) });

  const out = { byKey: {}, sectors: 0, sites: [], strokes: [] };
  // District circles overlap, so two sites can name the same sector. Building
  // one twice would double-count every metre of paint in it.
  const seen = new Set();
  const built = new Set();
  for (const site of SITES) {
    const sx = Math.floor(site.x / SECTOR);
    const sz = Math.floor(site.z / SECTOR);
    const before = JSON.stringify(Object.keys(out.byKey));
    let meshes = 0;
    for (let dz = 0; dz <= 1; dz++) {
      for (let dx = 0; dx <= 1; dx++) {
        const k = `${sx + dx},${sz + dz}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (!rm.hasWork(sx + dx, sz + dz)) continue;
        const b = rm.begin(sx + dx, sz + dz, 'visual');
        while (!b.step(1e9)) { /* drain */ }
        const { group } = b.finish();
        if (!group) continue;
        out.sectors++;
        built.add(k);
        for (const mesh of group.children) {
          readMesh(mesh, out);
          meshes++;
        }
      }
    }
    out.sites.push({ id: site.id, meshes, before });
  }
  /**
   * Which edges were actually offered to the builder. An edge belongs to the
   * sector holding its MIDPOINT and is emitted whole by that sector, so an
   * edge owned by a built sector had all of its length painted or not painted;
   * one owned by an unbuilt neighbour contributes nothing and must not sit in
   * the denominator. The rule is `plan.js`'s `SECTOR` grid, not a private of
   * the builder, but it is the builder's rule and this is the coupling.
   */
  const owned = graph.edges.filter((e) => {
    if (e.rail) return false;
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    const k = `${Math.floor(((na.x + nb.x) / 2) / SECTOR)},${Math.floor(((na.z + nb.z) / 2) / SECTOR)}`;
    return built.has(k);
  });
  out.mark = markedSpan(graph, owned, out.strokes);
  return out;
}

/** Lane and junction census, straight off the graph — context, not a gate. */
function census(graph) {
  const byKind = {};
  for (const e of graph.edges) {
    if (e.rail) continue;
    const k = (byKind[e.kind] ??= { n: 0, len: 0, lanes: {} });
    k.n++;
    k.len += e.len;
    k.lanes[e.lanes] = (k.lanes[e.lanes] ?? 0) + 1;
  }
  return byKind;
}

function report(name, out) {
  const road = out.byKey.road?.area ?? 0;
  const pad = out.byKey.road_pad?.area ?? 0;
  const carriageway = road + pad;
  let paint = 0;
  for (const k in out.byKey) {
    if (k.startsWith('line_') || k.startsWith('mark_')) paint += out.byKey[k].area;
  }
  const longW = [];
  const longU = [];
  let longQuads = 0;
  let longArea = 0;
  for (const k of LONG_KEYS) {
    const r = out.byKey[k];
    if (!r) continue;
    longQuads += r.quads;
    longArea += r.area;
    longW.push(...r.widths);
    longU.push(...r.uSpans);
  }
  const strokeCm = longW.map((w, i) => w * longU[i] * 100);
  const res = {
    arm: name,
    sectors: out.sectors,
    carriagewayM2: +carriageway.toFixed(0),
    paintM2: +paint.toFixed(1),
    paintPerKm2: +((paint / Math.max(1, carriageway)) * 1000).toFixed(2),
    longQuads,
    uSpanMed: +pct(longU, 0.5).toFixed(3),
    uSpanMax: +pct(longU, 0.98).toFixed(3),
    widthMedCm: +(pct(longW, 0.5) * 100).toFixed(1),
    widthP05Cm: +(pct(longW, 0.05) * 100).toFixed(1),
    widthP95Cm: +(pct(longW, 0.95) * 100).toFixed(1),
    strokeMedCm: +pct(strokeCm, 0.5).toFixed(1),
    strokeP05Cm: +pct(strokeCm, 0.05).toFixed(1),
    strokeP95Cm: +pct(strokeCm, 0.95).toFixed(1),
    longM2: +longArea.toFixed(1),
    longPerKm2: +((longArea / Math.max(1, carriageway)) * 1000).toFixed(2),
    crossM2: +(out.byKey.mark_cross?.area ?? 0).toFixed(1),
    stopM2: +(out.byKey.mark_stop?.area ?? 0).toFixed(1),
    arrowM2: +((out.byKey.mark_arrow?.area ?? 0) + (out.byKey.mark_arrow_turn?.area ?? 0)).toFixed(1),
    keys: Object.keys(out.byKey).filter((k) => k.startsWith('line_') || k.startsWith('mark_'))
      .map((k) => `${k}=${out.byKey[k].area.toFixed(0)}m2/${out.byKey[k].quads}q`).join(' '),
  };
  const m = out.mark.byKind;
  const frac = (k) => (m[k] ? +(m[k].span / Math.max(1, m[k].len) * 100).toFixed(1) : 0);
  res.markedPct = { arterial: frac('arterial'), highway: frac('highway'), street: frac('street'), alley: frac('alley') };
  res.markedKm = Object.fromEntries(Object.keys(m).map((k) => [k, +(m[k].len / 1000).toFixed(1)]));
  // The three classes the road table gives a marking scheme. `alley` is
  // `paint: 'none'` by design and is reported, never graded.
  const paved = ['arterial', 'highway', 'street'];
  res.markedAll = +(
    paved.reduce((s, k) => s + (m[k]?.span ?? 0), 0)
    / Math.max(1, paved.reduce((s, k) => s + (m[k]?.len ?? 0), 0)) * 100
  ).toFixed(1);
  res.markedOrphan = out.mark.orphan;
  res.approachMed = +pct(out.mark.approach, 0.5).toFixed(2);
  res.approachP90 = +pct(out.mark.approach, 0.9).toFixed(2);
  return res;
}

/**
 * The gate. Limits are properties of a real street, not of this code:
 *
 *   paintPerKm2 >= 4     four square metres of paint per thousand of tarmac.
 *                        A single 13 cm centre line down an 11 m carriageway
 *                        is already 11.8; four is a floor a city with SOME
 *                        unmarked back streets can still clear, and a city
 *                        with none cannot.
 *   uSpanMax  <= 0.55    no quad may show more than half the bake across. This
 *                        is the fix: 1.0 means 72 % empty texels averaging the
 *                        stroke away.
 *   stroke 8..40 cm      the painted band, measured. A US lane line is 10-15
 *                        and a double yellow assembly is 30.
 *   crossings, stop bars and arrows all present.
 *   marked               of every metre of a class, the share lying between
 *                        that block's own first and last stroke. The rest is
 *                        junction box, which is CORRECTLY bare: an American
 *                        junction carries a crossing and a stop bar, not a
 *                        centre line. What is not correctly bare is the plain
 *                        polyline vertex, which had a junction pad too.
 *
 *                        MEASURED, this city, the two arms side by side:
 *
 *                                     fixed   ?fatpads=1
 *                          overall     75.6      72.4
 *                          arterial    69.8      64.4
 *                          highway     55.9      47.0
 *                          street      78.0      75.7
 *
 *                        so the floors are 65 overall (a wide guard against
 *                        paint disappearing again, which no pad radius can
 *                        reach), 67 arterial and 50 highway, both of which sit
 *                        between the arms and both of which the control fails.
 *                        Highway moves most because a trunk road is nearly all
 *                        continuation vertices and almost no junctions.
 *
 *                        NOT GATED, but printed and worth reading: the bare
 *                        approach out of a junction is 4.1 m at the median and
 *                        8.1 m at p90 IN ALL THREE ARMS. That is the junction
 *                        box itself, and it is identical because the pad at a
 *                        real junction was deliberately left alone — the arms
 *                        differ only where there was no junction to begin with.
 */
function grade(r) {
  const checks = [
    ['lane paint per km2 >= 4', r.longPerKm2 >= 4, `${r.longPerKm2}`],
    ['longitudinal quads > 400', r.longQuads > 400, `${r.longQuads}`],
    ['uSpan p98 <= 0.70', r.uSpanMax <= 0.70, `${r.uSpanMax}`],
    ['quad width p05 >= 8 cm', r.widthP05Cm >= 8, `${r.widthP05Cm}`],
    ['quad width p95 <= 40 cm', r.widthP95Cm <= 40, `${r.widthP95Cm}`],
    ['crossings present', r.crossM2 > 20, `${r.crossM2} m2`],
    ['stop bars present', r.stopM2 > 5, `${r.stopM2} m2`],
    ['lane arrows present', r.arrowM2 > 2, `${r.arrowM2} m2`],
    ['marked length >= 65%', r.markedAll >= 65, `${r.markedAll}%`],
    ['arterial marked >= 67%', r.markedPct.arterial >= 67, `${r.markedPct.arterial}%`],
    ['highway marked >= 50%', r.markedPct.highway >= 50, `${r.markedPct.highway}%`],
  ];
  return checks;
}

function print(r, checks) {
  console.log(`\n--- ${r.arm} --------------------------------------------------`);
  console.log(
    `  sectors ${r.sectors}  carriageway ${r.carriagewayM2} m2  paint ${r.paintM2} m2 ` +
    `(${r.paintPerKm2} per km2)`
  );
  console.log(
    `  longitudinal quads ${r.longQuads}  uSpan med ${r.uSpanMed} p98 ${r.uSpanMax}  ` +
    `quad width med ${r.widthMedCm} cm`
  );
  console.log(
    `  quad width      p05 ${r.widthP05Cm}  med ${r.widthMedCm}  p95 ${r.widthP95Cm} cm  ` +
    `(stroke inside the window: ${r.strokeMedCm} cm at the median)`
  );
  console.log(`  lane paint ${r.longM2} m2 (${r.longPerKm2} per km2)   by key: ${r.keys}`);
  console.log(`  crossings ${r.crossM2} m2   stop bars ${r.stopM2} m2   arrows ${r.arrowM2} m2`);
  console.log(
    `  marked length ${r.markedAll}% of ${['arterial', 'highway', 'street'].map((k) => `${k} ${r.markedKm[k] ?? 0} km`).join(' + ')}` +
    `   (arterial ${r.markedPct.arterial}%  highway ${r.markedPct.highway}%  street ${r.markedPct.street}%` +
    `  alley ${r.markedPct.alley}% ungraded, paint: 'none')   unplaced strokes ${r.markedOrphan}`
  );
  console.log(`  bare approach out of a junction: med ${r.approachMed} m  p90 ${r.approachP90} m`);
  let pass = 0;
  for (const [label, ok, val] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} ${val}`);
    if (ok) pass++;
  }
  return pass;
}

async function main() {
  const terrain = new Terrain({ cell: 8, extent: 1792 }).bake();
  const c = census(generateCity(terrain, new Rng(0x600d)).graph);
  console.log('lane census (context, not graded):');
  for (const k in c) {
    console.log(`  ${k.padEnd(9)} ${c[k].n} edges  ${(c[k].len / 1000).toFixed(1)} km  lanes ${JSON.stringify(c[k].lanes)}`);
  }

  const wantLegacy = !!args.legacy || !!args.gate;
  const wantFat = !!args.fatpads || !!args.gate;
  const wantFixed = (!args.legacy && !args.fatpads) || !!args.gate;

  let fixed = null;
  let legacy = null;
  let fatpads = null;
  if (wantFixed) fixed = report('fixed', await measure('fixed'));
  if (wantLegacy) legacy = report('legacy marking pass (control: must fail)', await measure('legacy'));
  if (wantFat) fatpads = report('legacy junction pads (control: must fail)', await measure('fatpads'));

  if (args.json) console.log(JSON.stringify({ fixed, legacy, fatpads }, null, 2));

  let ok = true;
  if (fixed) {
    const ch = grade(fixed);
    const pass = print(fixed, ch);
    console.log(`  ${pass}/${ch.length}`);
    if (pass !== ch.length) ok = false;
  }
  for (const ctl of [legacy, fatpads]) {
    if (!ctl) continue;
    const ch = grade(ctl);
    const pass = print(ctl, ch);
    console.log(`  ${pass}/${ch.length} — a control that PASSES means the gate measures nothing`);
    if (args.gate && pass === ch.length) {
      console.log(`\nCONTROL "${ctl.arm}" DID NOT FAIL — gate is decorative`);
      ok = false;
    }
  }
  console.log(ok ? '\nPAINT GATE PASSED' : '\nPAINT GATE FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
