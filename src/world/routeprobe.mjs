#!/usr/bin/env node
/**
 * WORLD — "does `world.routeTo` hand back a route a car could actually drive,
 * and does `world.streetAt` know what road it is on?"
 *
 * These two are infrastructure: mission AI asks for the drive, the wayfinding
 * UI draws it and prints the street. Both are silent when wrong — a route with
 * a gap in it looks like a route, and a car sent across a river without a
 * bridge just drives into the Monongahela — so everything here is asserted
 * against the EMITTED graph and the EMITTED waypoint list, never against the
 * router's own bookkeeping.
 *
 * WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 *
 * Every waypoint carries a `node` id and an `edge` id, and both are the
 * router's own working notes. Continuity is therefore decided GEOMETRICALLY:
 * for each interior leg the probe searches the graph for an edge whose segment
 * contains BOTH ends of that leg, and a leg with no such edge is a leg with no
 * road under it. Node ids are never trusted, `edge` is only ever cross-checked
 * against the edge the geometry found, and the river test is run against
 * `plan.RIVERS` — the authored centrelines, which the router has never read.
 *
 * The negative controls are the other half of that argument, and all three run
 * BEFORE the gate, aborting it if they do not fire:
 *
 *   splice     delete one interior waypoint from a real route and the
 *              continuity checker must report the gap it leaves
 *   nobridge   re-run the river test on a real crossing with the bridge flag
 *              masked off and it must report an unbridged crossing
 *   island     a two-island toy graph must come back null AND must have been
 *              REFUSED by the component guard, not merely searched to
 *              exhaustion — tested against both publication shapes, a per-node
 *              `component` id and `graph.mainComponent`
 *
 * Assertions
 *
 *   continuity   every interior leg of all 12 routes lies along one graph edge,
 *                and its length is that of the sub-segment it covers
 *   stubs        first point is the caller's `from`, last is his `to`, and
 *                neither off-graph hop is longer than the 60 m entry radius
 *   metres       the quoted distance is the sum of the legs and is never
 *                shorter than the crow flies; detour ratio is a RATCHET
 *   bridges      every leg that crosses a river centreline is a bridge deck,
 *                and the 12 pairs between them cross all three rivers
 *   water        a point in mid-channel routes to null and has no street name
 *   far          a point past the entry radius routes to null
 *   names        every drivable emitted edge resolves to a street name; the
 *                authored vocabulary is internally unique and does not collide
 *                with a name `netgen` emits; `streetAt` on an edge returns that
 *                edge's name; mission copy's Butler Street is a real street
 *                with the body shop on it
 *   cache        a second call inside the 8 m quantum does not re-solve, and
 *                still reports the stubs from where the caller now is
 *   timing       256 warm solves with distinct endpoints, p95 under budget
 *
 * Usage
 *   node src/world/routeprobe.mjs
 *   node src/world/routeprobe.mjs --json=/tmp/route.json
 *   node src/world/routeprobe.mjs --seed=1234
 */

import { Terrain } from './terrain.js';
import { generateCity } from './netgen.js';
import { RoadGraph } from './roadgraph.js';
import { Router } from './route.js';
import {
  RIVERS, DISTRICT_STREETS, CORRIDOR_STREETS, corridorStreetName, corridorHalfWidth, segDist2,
} from './plan.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/** Must match `route.js`. A stub longer than this is a route that cheated. */
const ENTRY_MAX = 60;
/** A waypoint is ON an edge when it is this close to its segment, in metres. */
const ON_EDGE_EPS = 0.05;
/** Leg length must agree with the sub-segment it covers to this, in metres. */
const LEN_EPS = 0.05;
/** How far the quoted route may exceed an independent Dijkstra's, in metres.
 *  Not a tolerance for a worse route — it is float slop on a 1.5 km sum. */
const OPTIMAL_EPS = 0.05;
/**
 * RATCHET (ARCHITECTURE.md rule 13). Worst road-distance-over-crow-flies across
 * the 12 pairs. Steel City is three land masses joined by eleven bridges, so a
 * big number here is geography, not a bad solver: MEASURED at x2.70 on
 * `lm_point -> shop_food2` — the Point Fountain to the Incline Diner, 504 m
 * apart across the Monongahela with the Fort Pitt Bridge the only crossing, and
 * that bridge lands 400 m west of the diner. Every other pair is under x2.15.
 * LOWER this when the network gets better connected; never RAISE it to make a
 * wandering route pass.
 */
const MAX_DETOUR = 2.85;
/** RATCHET. Metres from the DeCarlo Body Shop to the nearest Butler Street
 *  edge. `src/game/data.js` says the shop is ON Butler Street; this is how far
 *  off "on" currently is. */
const MAX_BUTLER_OFFSET = 60;
/**
 * Mirrors `route.js`'s `STREET_SLACK`: how far past the footway still counts as
 * being on the street. The thing under test is WHICH edge wins the query, not
 * this number, so the reference scan below has to use the same rule.
 */
const STREET_SLACK = 3.5;
/** Streets mission and HUD copy names by hand. The world has to agree. */
const NAMED_IN_COPY = [
  'Butler Street', 'Liberty Avenue', 'Carson Street', 'Fifth Avenue',
  'Smallman Street', 'Grandview Avenue', 'Brighton Road',
];
/** Timing budget for one warm solve, p95, milliseconds. */
const SOLVE_P95_MS = 3.0;
/**
 * Timing budget for a cache hit, MEDIAN, milliseconds — and the median rather
 * than the p95 deliberately. A hit is a handful of microseconds, so at that
 * magnitude a tail percentile measures the operating system's scheduler and not
 * this code: one run in five puts a 0.7 ms hiccup somewhere in 256 samples and
 * moves the p95 by 40x while the median does not move at all. The tail is
 * printed, and the ratio below is the property that actually matters.
 */
const HIT_P50_MS = 0.02;
/** A hit has to be at least this much cheaper than a solve to be worth having. */
const HIT_SPEEDUP = 5;
/** Warm-up solves before the clock is trusted. */
const WARMUP = 64;
const TIMED = 256;

const SEED = args.seed ? Number(args.seed) >>> 0 : 0x5eed1234;

/* ---------------------------------------------------------- the city ----- */

const t0 = Date.now();
const terrain = new Terrain({ cell: 8, extent: 1792 });
terrain.bake();
const city = generateCity(terrain, new Rng(SEED).fork().fork());
const graph = city.graph;
const router = new Router(graph);
const buildMs = Date.now() - t0;

const poiById = new Map(city.pois.map((p) => [p.id, p]));

/* ------------------------------------------------- independent geometry -- */

const _seg = { d2: 0, t: 0 };

/** Perpendicular distance from a point to an edge's segment, and the parameter. */
function edgeDist(e, x, z) {
  const na = graph.nodes[e.a];
  const nb = graph.nodes[e.b];
  segDist2(x, z, na.x, na.z, nb.x, nb.z, _seg);
  return { d: Math.sqrt(_seg.d2), t: _seg.t };
}

/**
 * Every DRIVABLE graph edge whose segment contains BOTH ends of the leg. This
 * is the whole continuity test: no edge, no road under the leg. Brute force
 * over the edge list on purpose — the router's spatial index is the thing under
 * test.
 *
 * Mill trackage is excluded, and that exclusion is load-bearing rather than
 * tidy: rail is in the graph so `roadmesh` can draw ballast, it runs within the
 * 7 m node-weld radius of the street grid all through Lawrenceville, and a leg
 * lying along it is a car on the sleepers. A leg whose only cover is a rail
 * edge is therefore a BREAK, not a pass.
 */
function edgesUnder(px, pz, qx, qz) {
  const out = [];
  for (const e of graph.edges) {
    if (e.rail) continue;
    const a = edgeDist(e, px, pz);
    if (a.d > ON_EDGE_EPS) continue;
    const b = edgeDist(e, qx, qz);
    if (b.d > ON_EDGE_EPS) continue;
    out.push({ e, span: Math.abs(b.t - a.t) * e.len });
  }
  return out;
}

/** Do segments p-q and r-s properly cross? */
function crosses(px, pz, qx, qz, rx, rz, sx, sz) {
  const d = (ax, az, bx, bz, cx, cz) => (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d1 = d(px, pz, qx, qz, rx, rz);
  const d2 = d(px, pz, qx, qz, sx, sz);
  const d3 = d(rx, rz, sx, sz, px, pz);
  const d4 = d(rx, rz, sx, sz, qx, qz);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** Which river centreline, if any, this leg crosses. */
function riverCrossed(px, pz, qx, qz) {
  for (const r of RIVERS) {
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      if (crosses(px, pz, qx, qz, a[0], a[1], b[0], b[1])) return r.id;
    }
  }
  return null;
}

/**
 * Nearest DRIVABLE edge in PLAN — brute force over the whole edge list, with no
 * spatial index and no height term. This is the independent reference
 * `streetAt` is scored against: a different implementation of the same
 * question, so a bug in the router's grid walk cannot hide behind it.
 */
function nearestDrivable(x, z) {
  let best = null;
  let bd = Infinity;
  for (const e of graph.edges) {
    if (e.rail) continue;
    const { d } = edgeDist(e, x, z);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return { edge: best, dist: bd };
}

function nearestDrivableDist(x, z) {
  return nearestDrivable(x, z).dist;
}

/** What `streetAt` is contractually obliged to answer at (x, z), in plan. */
function expectedStreet(x, z) {
  const { edge, dist } = nearestDrivable(x, z);
  if (!edge) return null;
  if (dist > corridorHalfWidth(edge.kind, edge.lanes) + STREET_SLACK) return null;
  return edge.name ?? corridorStreetName(edge.corridor);
}

/**
 * The shortest road distance between two world points, by an INDEPENDENT
 * Dijkstra over the emitted graph.
 *
 * This is the second opinion on the number `routeTo` quotes. It shares no code
 * with the router: no heuristic, no cache, no spatial index, a different
 * expansion order, and endpoints found by the brute-force scan above. A route
 * that is continuous, bridged and plausible can still be the WRONG route — a
 * solver that only ever leaves the entry edge by one of its two ends, say,
 * produces perfectly legal waypoints that are quietly a little long every time
 * — and nothing else in this file would notice. Returns metres including both
 * off-graph stubs, or null.
 */
function referenceShortest(fromX, fromZ, toX, toZ) {
  const inHit = nearestDrivable(fromX, fromZ);
  const outHit = nearestDrivable(toX, toZ);
  if (!inHit.edge || inHit.dist > ENTRY_MAX) return null;
  if (!outHit.edge || outHit.dist > ENTRY_MAX) return null;
  const ein = inHit.edge;
  const eout = outHit.edge;
  const tin = edgeDist(ein, fromX, fromZ).t;
  const tout = edgeDist(eout, toX, toZ).t;
  const stubs = inHit.dist + outHit.dist;
  if (ein === eout) return stubs + Math.abs(tout - tin) * ein.len;

  const n = graph.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  const heapI = [];
  const heapK = [];
  const push = (i, k) => {
    heapI.push(i);
    heapK.push(k);
    let c = heapI.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heapK[p] <= heapK[c]) break;
      [heapI[p], heapI[c]] = [heapI[c], heapI[p]];
      [heapK[p], heapK[c]] = [heapK[c], heapK[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heapI[0];
    const last = heapI.length - 1;
    heapI[0] = heapI[last];
    heapK[0] = heapK[last];
    heapI.pop();
    heapK.pop();
    let c = 0;
    for (;;) {
      const l = c * 2 + 1;
      const r = l + 1;
      let m = c;
      if (l < heapI.length && heapK[l] < heapK[m]) m = l;
      if (r < heapI.length && heapK[r] < heapK[m]) m = r;
      if (m === c) break;
      [heapI[m], heapI[c]] = [heapI[c], heapI[m]];
      [heapK[m], heapK[c]] = [heapK[c], heapK[m]];
      c = m;
    }
    return top;
  };
  const relaxSeed = (id, d) => {
    if (d < dist[id]) {
      dist[id] = d;
      push(id, d);
    }
  };
  relaxSeed(ein.a, tin * ein.len);
  relaxSeed(ein.b, (1 - tin) * ein.len);
  while (heapI.length) {
    const u = pop();
    if (done[u]) continue;
    done[u] = 1;
    const links = graph.nodes[u].links;
    for (let i = 0; i < links.length; i++) {
      const e = graph.edges[links[i]];
      if (e.rail) continue;
      if (e.oneway && e.a !== u) continue;
      const v = e.a === u ? e.b : e.a;
      const nd = dist[u] + e.len;
      if (nd < dist[v]) {
        dist[v] = nd;
        push(v, nd);
      }
    }
  }
  const best = Math.min(dist[eout.a] + tout * eout.len, dist[eout.b] + (1 - tout) * eout.len);
  return Number.isFinite(best) ? stubs + best : null;
}

/**
 * Everything worth knowing about one returned waypoint list, decided from the
 * graph rather than from the list's own `node` / `edge` fields.
 */
function analyse(path, fromX, fromZ, toX, toZ, isBridge = (e) => e.bridge) {
  const rep = {
    points: path.length,
    breaks: [],
    crossings: [],
    unbridged: [],
    mislabelled: 0,
    metres: 0,
    quoted: path.metres,
    stubIn: Math.hypot(path[1].x - fromX, path[1].z - fromZ),
    stubOut: Math.hypot(path[path.length - 1].x - path[path.length - 2].x,
      path[path.length - 1].z - path[path.length - 2].z),
    startsAt: Math.hypot(path[0].x - fromX, path[0].z - fromZ),
    endsAt: Math.hypot(path[path.length - 1].x - toX, path[path.length - 1].z - toZ),
  };
  for (let i = 1; i < path.length; i++) {
    rep.metres += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  }
  // Interior legs: everything but the first and last hop, which are the
  // off-graph stubs and are asserted separately.
  for (let i = 1; i < path.length - 2; i++) {
    const p = path[i];
    const q = path[i + 1];
    const len = Math.hypot(q.x - p.x, q.z - p.z);
    const under = edgesUnder(p.x, p.z, q.x, q.z);
    if (!under.length) {
      rep.breaks.push({ leg: i, from: [p.x, p.z], to: [q.x, q.z], len, why: 'no edge covers this leg' });
      continue;
    }
    if (!under.some((u) => Math.abs(u.span - len) <= LEN_EPS)) {
      rep.breaks.push({ leg: i, from: [p.x, p.z], to: [q.x, q.z], len, why: `no covering edge spans ${len.toFixed(2)} m` });
    }
    if (p.edge >= 0 && !under.some((u) => u.e.id === p.edge)) rep.mislabelled++;
    const river = riverCrossed(p.x, p.z, q.x, q.z);
    if (river) {
      rep.crossings.push({ leg: i, river });
      if (!under.some((u) => isBridge(u.e))) {
        rep.unbridged.push({ leg: i, river, from: [p.x, p.z], to: [q.x, q.z] });
      }
    }
  }
  return rep;
}

/* --------------------------------------------------------------- pairs --- */

/**
 * Twelve pairs of real points of interest. Eleven of them are on opposite banks
 * — four across the Allegheny, five across the Monongahela, two across the Ohio
 * — and the twelfth is deliberately same-bank, so a river test that fires on
 * everything cannot pass. Which river a pair actually crosses is MEASURED off
 * the returned route, not asserted from this table.
 */
const PAIRS = [
  ['gas_north', 'shop_ammo'],
  ['sh_loft', 'gas_strip'],
  ['gas_north', 'gas_law'],
  ['sh_loft', 'dk_south'],
  ['shop_food', 'sh_boathouse'],
  ['sh_apartment', 'sh_garage'],
  ['gas_row', 'gas_south'],
  ['shop_ammo2', 'sh_boathouse'],
  ['lm_point', 'shop_food2'],
  ['dk_point', 'gas_west'],
  ['gas_north', 'gas_west'],
  ['gas_strip', 'gas_law'],
];

/* -------------------------------------------------------------- checks --- */

const checks = [];
const fail = (name, msg) => checks.push({ name, ok: false, msg });
const pass = (name, msg) => checks.push({ name, ok: true, msg });
const check = (ok, name, msg) => (ok ? pass(name, msg) : fail(name, msg));

/* --- NEGATIVE CONTROLS, before anything else ----------------------------- */

const controls = {};
{
  // A real crossing route to corrupt.
  const a = poiById.get('gas_north');
  const b = poiById.get('shop_ammo');
  const real = router.routeTo(a.x, a.z, b.x, b.z);
  if (!real) {
    console.error('SELF-CHECK FAILED — the control route (gas_north -> shop_ammo) is null; nothing to corrupt.');
    process.exit(2);
  }
  const copy = real.map((w) => ({ x: w.x, z: w.z, y: w.y, node: w.node, edge: w.edge, name: w.name }));
  copy.metres = real.metres;

  // splice: remove one interior waypoint. The gap it leaves must be seen.
  const cut = copy.slice();
  cut.splice(Math.floor(cut.length / 2), 1);
  cut.metres = copy.metres;
  const spliced = analyse(cut, a.x, a.z, b.x, b.z);
  controls.splice = spliced.breaks.length;

  // nobridge: same route, bridge flag masked off.
  const masked = analyse(copy, a.x, a.z, b.x, b.z, () => false);
  controls.crossings = masked.crossings.length;
  controls.nobridge = masked.unbridged.length;

  if (controls.splice === 0) {
    console.error('SELF-CHECK FAILED — deleting a waypoint left the continuity checker green. The gate proves nothing; aborting.');
    process.exit(2);
  }
  if (controls.crossings === 0 || controls.nobridge === 0) {
    console.error(`SELF-CHECK FAILED — the control route crosses ${controls.crossings} river(s) and masking the bridge flag flagged ${controls.nobridge}. Aborting.`);
    process.exit(2);
  }
}

// island: two disjoint pairs of nodes, one route request across the gap.
{
  const mk = (publish) => {
    const g = new RoadGraph();
    g.addNode(0, 0, 0);
    g.addNode(100, 0, 0);
    g.addNode(600, 0, 0);
    g.addNode(700, 0, 0);
    g.addEdge(0, 1, { kind: 'street', lanes: 2 });
    g.addEdge(2, 3, { kind: 'street', lanes: 2 });
    g.finalise();
    if (publish === 'node') {
      g.nodes[0].component = 0;
      g.nodes[1].component = 0;
      g.nodes[2].component = 1;
      g.nodes[3].component = 1;
    } else if (publish === 'graph') {
      g.mainComponent = Int32Array.from([0, 0, 1, 1]);
      g.mainComponentId = 0;
    }
    return g;
  };
  const run = (publish) => {
    const r = new Router(mk(publish));
    const out = r.routeTo(50, 0, 650, 0);
    return { out, refusals: r.stats.refusals };
  };
  const none = run('none');
  const node = run('node');
  const gph = run('graph');
  controls.island = { none: none.refusals, node: node.refusals, graph: gph.refusals };
  if (none.out !== null || node.out !== null || gph.out !== null) {
    console.error('SELF-CHECK FAILED — a route was returned across two disconnected islands. Aborting.');
    process.exit(2);
  }
  if (none.refusals !== 0 || node.refusals !== 1 || gph.refusals !== 1) {
    console.error(`SELF-CHECK FAILED — the component guard did not fire on exactly the published arms (none=${none.refusals} node=${node.refusals} graph=${gph.refusals}). Aborting.`);
    process.exit(2);
  }
}

console.log(
  `self-check: splicing a waypoint -> ${controls.splice} break(s); masking the bridge flag -> ` +
  `${controls.nobridge}/${controls.crossings} crossing(s) unbridged; the island guard refuses on a ` +
  `per-node id and on graph.mainComponent and not when neither is published. all three CAN fail. ok`
);

/* --- the twelve routes --------------------------------------------------- */

const rows = [];
const riversHit = new Set();
let worstDetour = 0;
let worstDetourPair = '';
for (const [aId, bId] of PAIRS) {
  const a = poiById.get(aId);
  const b = poiById.get(bId);
  if (!a || !b) {
    fail('continuity', `no such POI: ${!a ? aId : bId}`);
    continue;
  }
  const path = router.routeTo(a.x, a.z, b.x, b.z);
  const crow = Math.hypot(b.x - a.x, b.z - a.z);
  if (!path) {
    fail('continuity', `${aId} -> ${bId}: null (nearest drivable ${nearestDrivableDist(a.x, a.z).toFixed(1)} / ${nearestDrivableDist(b.x, b.z).toFixed(1)} m)`);
    rows.push({ pair: `${aId}->${bId}`, ok: false });
    continue;
  }
  const rep = analyse(path, a.x, a.z, b.x, b.z);
  const detour = rep.metres / Math.max(1, crow);
  if (detour > worstDetour) {
    worstDetour = detour;
    worstDetourPair = `${aId}->${bId}`;
  }
  for (const c of rep.crossings) riversHit.add(c.river);
  rows.push({
    pair: `${aId}->${bId}`,
    ok: true,
    points: rep.points,
    metres: rep.metres,
    crow,
    detour,
    crossings: rep.crossings.map((c) => c.river),
    stubIn: rep.stubIn,
    stubOut: rep.stubOut,
    breaks: rep.breaks.length,
    unbridged: rep.unbridged.length,
    mislabelled: rep.mislabelled,
  });

  const tag = `${aId}->${bId}`;
  check(rep.breaks.length === 0, 'continuity',
    rep.breaks.length === 0
      ? `${tag}: ${rep.points} points, ${rep.points - 3} interior legs all on one edge`
      : `${tag}: ${rep.breaks.length} leg(s) with no road under them — ${JSON.stringify(rep.breaks[0])}`);
  check(rep.mislabelled === 0, 'edge-label',
    rep.mislabelled === 0
      ? `${tag}: every waypoint's edge id is the edge its geometry sits on`
      : `${tag}: ${rep.mislabelled} waypoint(s) name an edge their geometry is not on`);
  check(rep.startsAt < 1e-6 && rep.endsAt < 1e-6, 'stubs',
    `${tag}: starts ${rep.startsAt.toFixed(4)} m from the caller's from, ends ${rep.endsAt.toFixed(4)} m from his to`);
  check(rep.stubIn <= ENTRY_MAX + 1e-6 && rep.stubOut <= ENTRY_MAX + 1e-6, 'stubs',
    `${tag}: off-graph hops ${rep.stubIn.toFixed(1)} m in, ${rep.stubOut.toFixed(1)} m out (<= ${ENTRY_MAX})`);
  check(Math.abs(rep.quoted - rep.metres) < 0.01, 'metres',
    `${tag}: quoted ${rep.quoted.toFixed(1)} m vs summed legs ${rep.metres.toFixed(1)} m`);
  check(rep.metres >= crow - 1e-6, 'metres',
    `${tag}: ${rep.metres.toFixed(0)} m by road vs ${crow.toFixed(0)} m crow-fly (x${detour.toFixed(2)})`);
  const ref = referenceShortest(a.x, a.z, b.x, b.z);
  rows[rows.length - 1].ref = ref;
  check(ref !== null && Math.abs(rep.metres - ref) <= OPTIMAL_EPS, 'shortest',
    ref === null
      ? `${tag}: the reference Dijkstra found no route at all`
      : `${tag}: ${rep.metres.toFixed(2)} m vs an independent Dijkstra's ${ref.toFixed(2)} m (${(rep.metres - ref).toFixed(2)} m over)`);
  check(rep.unbridged.length === 0, 'bridges',
    rep.unbridged.length === 0
      ? (rep.crossings.length
        ? `${tag}: ${rep.crossings.length} river crossing(s), all on a bridge deck`
        : `${tag}: same bank, no river crossed`)
      : `${tag}: ${rep.unbridged.length} river crossing(s) NOT on a bridge — ${JSON.stringify(rep.unbridged[0])}`);
}

check(worstDetour <= MAX_DETOUR, 'metres',
  `worst detour x${worstDetour.toFixed(2)} on ${worstDetourPair} (RATCHET ${MAX_DETOUR})`);
check(riversHit.size === RIVERS.length, 'bridges',
  `the 12 pairs cross ${riversHit.size}/${RIVERS.length} rivers: ${[...riversHit].sort().join(', ')}`);

/* --- open water and out of reach ---------------------------------------- */

const waterRows = [];
for (const r of RIVERS) {
  // The most open water this river has inside the built city — found by
  // walking its centreline and measuring against the graph directly.
  let best = null;
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i];
    const b = r.pts[i + 1];
    const steps = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 20));
    for (let k = 0; k <= steps; k++) {
      const x = a[0] + (b[0] - a[0]) * (k / steps);
      const z = a[1] + (b[1] - a[1]) * (k / steps);
      if (Math.abs(x) > 1000 || Math.abs(z) > 1000) continue;
      const d = nearestDrivableDist(x, z);
      if (!best || d > best.d) best = { x, z, d };
    }
  }
  if (!best) {
    fail('water', `${r.id}: no centreline sample inside the city`);
    continue;
  }
  const anchor = poiById.get('shop_food');
  const out = router.routeTo(best.x, best.z, anchor.x, anchor.z);
  const back = router.routeTo(anchor.x, anchor.z, best.x, best.z);
  const name = router.streetAt(best.x, best.z);
  waterRows.push({ river: r.id, x: best.x, z: best.z, clear: best.d, out: out === null, back: back === null, name });
  check(best.d > ENTRY_MAX, 'water',
    `${r.id}: mid-channel (${best.x.toFixed(0)},${best.z.toFixed(0)}) is ${best.d.toFixed(0)} m from the nearest road (> ${ENTRY_MAX})`);
  check(out === null && back === null, 'water',
    `${r.id}: routeTo from mid-channel is ${out === null ? 'null' : `${out.length} points`}, to it is ${back === null ? 'null' : `${back.length} points`}`);
  check(name === null, 'water', `${r.id}: streetAt mid-channel is ${name === null ? 'null' : `"${name}"`}`);
}

/* --- ballast is not a road ----------------------------------------------- */

{
  // The point on the mill trackage that is furthest from any street. It is
  // still inside the entry radius, so a route from it is legal — but it has to
  // start by crossing to the road, never by running along the sleepers.
  let deep = null;
  for (const e of graph.edges) {
    if (!e.rail) continue;
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    for (let k = 0; k <= 8; k++) {
      const u = k / 8;
      const x = na.x + (nb.x - na.x) * u;
      const z = na.z + (nb.z - na.z) * u;
      const d = nearestDrivableDist(x, z);
      if (!deep || d > deep.d) deep = { x, z, d };
    }
  }
  const anchor = poiById.get('shop_food');
  if (!deep) {
    fail('ballast', 'no rail in the emitted graph — the trackage test has nothing to stand on');
  } else {
    const path = router.routeTo(deep.x, deep.z, anchor.x, anchor.z);
    if (!path) {
      fail('ballast', `standing on the trackage at (${deep.x.toFixed(0)},${deep.z.toFixed(0)}), ${deep.d.toFixed(0)} m from a street, routes to null`);
    } else {
      const rep = analyse(path, deep.x, deep.z, anchor.x, anchor.z);
      check(rep.breaks.length === 0, 'ballast',
        rep.breaks.length === 0
          ? `from the trackage at (${deep.x.toFixed(0)},${deep.z.toFixed(0)}): every leg is on a street, and the ${rep.stubIn.toFixed(0)} m entry stub crosses to one`
          : `from the trackage: ${rep.breaks.length} leg(s) with no STREET under them — ${JSON.stringify(rep.breaks[0])}`);
      check(rep.stubIn > deep.d - 1, 'ballast',
        `the entry stub is ${rep.stubIn.toFixed(1)} m — the nearest street is ${deep.d.toFixed(1)} m away, so nothing joined the rail instead`);
    }
  }
}

// A landmark that legitimately sits past the entry radius, if there is one.
{
  const far = city.pois
    .map((p) => ({ p, d: nearestDrivableDist(p.x, p.z) }))
    .filter((r) => r.d > ENTRY_MAX)
    .sort((u, v) => v.d - u.d)[0];
  const anchor = poiById.get('shop_food');
  if (far) {
    const out = router.routeTo(far.p.x, far.p.z, anchor.x, anchor.z);
    check(out === null, 'far',
      `${far.p.id} is ${far.d.toFixed(0)} m off the network and routes to ${out === null ? 'null' : `${out.length} points`}`);
  } else {
    // Nothing authored is out of reach, so make a point that is.
    const out = router.routeTo(1420, 1420, anchor.x, anchor.z);
    check(out === null, 'far',
      `every POI is within ${ENTRY_MAX} m of a road; a corner of the map routes to ${out === null ? 'null' : `${out.length} points`}`);
  }
}

/* --- street names -------------------------------------------------------- */

{
  // Coverage: every drivable emitted edge must resolve to a name.
  const missing = new Map();
  let resolved = 0;
  for (const e of graph.edges) {
    if (e.rail) continue;
    const n = e.name ?? corridorStreetName(e.corridor);
    if (n) resolved++;
    else missing.set(e.corridor ?? '(null)', (missing.get(e.corridor ?? '(null)') ?? 0) + 1);
  }
  check(missing.size === 0, 'names',
    missing.size === 0
      ? `all ${resolved} drivable edges resolve to a street name`
      : `${[...missing.values()].reduce((s, v) => s + v, 0)} edge(s) have no name — ${[...missing.keys()].slice(0, 6).join(', ')}`);

  // Uniqueness: the authored vocabulary must not repeat itself, and must not
  // restate a name `netgen` already emits.
  const authored = new Map();
  const dupes = [];
  const add = (n, where) => {
    if (authored.has(n)) dupes.push(`${n} (${authored.get(n)} / ${where})`);
    else authored.set(n, where);
  };
  for (const [d, s] of Object.entries(DISTRICT_STREETS)) {
    for (const k of ['along', 'cross', 'alley']) for (const n of s[k]) add(n, `${d}.${k}`);
  }
  for (const [k, v] of Object.entries(CORRIDOR_STREETS)) add(v, `corridor.${k}`);
  check(dupes.length === 0, 'names',
    dupes.length === 0 ? `${authored.size} authored street names, all distinct` : `repeated: ${dupes.join('; ')}`);

  const emitted = new Set();
  for (const e of graph.edges) if (e.name) emitted.add(e.name);
  const clash = [...authored.keys()].filter((n) => emitted.has(n));
  check(clash.length === 0, 'names',
    clash.length === 0
      ? `no authored name collides with the ${emitted.size} names netgen emits`
      : `collides with netgen: ${clash.join(', ')}`);

  // streetAt must name the nearest street, and the reference for "nearest" is
  // a brute-force scan of the whole edge list, not the router's own index.
  // Sampled at the midpoint of the LONGEST edge carrying each name, so a
  // sample is a stretch of road rather than the inside of a junction.
  const longest = new Map();
  for (const e of graph.edges) {
    if (e.rail) continue;
    const n = e.name ?? corridorStreetName(e.corridor);
    if (!n) continue;
    const cur = longest.get(n);
    if (!cur || e.len > cur.len) longest.set(n, e);
  }
  let own = 0;
  const wrong = [];
  for (const [n, e] of longest) {
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    const mx = (na.x + nb.x) / 2;
    const mz = (na.z + nb.z) / 2;
    const got = router.streetAt(mx, mz);
    const want = expectedStreet(mx, mz);
    if (got !== want) wrong.push(`(${mx.toFixed(0)},${mz.toFixed(0)}) got ${got === null ? 'null' : `"${got}"`}, nearest edge is ${want === null ? 'null' : `"${want}"`}`);
    if (got === n) own++;
  }
  check(wrong.length === 0, 'names',
    wrong.length === 0
      ? `streetAt agrees with a brute-force nearest-edge scan at all ${longest.size} street samples (${own} of them name their own street; the rest sit closer to a road that overlaps them)`
      : `${wrong.length}/${longest.size} disagree: ${wrong.slice(0, 4).join('; ')}`);

  const copyMiss = [];
  for (const n of NAMED_IN_COPY) {
    const e = longest.get(n);
    if (!e) {
      copyMiss.push(`${n}: nothing in the graph is called that`);
      continue;
    }
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    const got = router.streetAt((na.x + nb.x) / 2, (na.z + nb.z) / 2, (na.y + nb.y) / 2);
    if (got !== n) copyMiss.push(`${n} -> ${got === null ? 'null' : `"${got}"`}`);
  }
  check(copyMiss.length === 0, 'names',
    copyMiss.length === 0
      ? `every street the game's copy names by hand exists and reports itself: ${NAMED_IN_COPY.join(', ')}`
      : copyMiss.join('; '));

  // A deck and the quay under it are different streets at the same x, z.
  {
    let pick = null;
    for (const e of graph.edges) {
      if (!e.bridge || e.rail) continue;
      const na = graph.nodes[e.a];
      const nb = graph.nodes[e.b];
      const mx = (na.x + nb.x) / 2;
      const mz = (na.z + nb.z) / 2;
      const deckY = (na.y + nb.y) / 2;
      for (const o of graph.edges) {
        if (o === e || o.rail || o.bridge) continue;
        const { d, t } = edgeDist(o, mx, mz);
        if (d > 24) continue;
        const oy = graph.nodes[o.a].y + (graph.nodes[o.b].y - graph.nodes[o.a].y) * t;
        if (Math.abs(deckY - oy) < 8) continue;
        if (!pick || d < pick.d) pick = { e, o, mx, mz, deckY, oy, d };
      }
    }
    if (!pick) {
      fail('names', 'no bridge deck in the graph has a road under it — the height test has nothing to bite on');
    } else {
      const onDeck = router.streetAt(pick.mx, pick.mz, pick.deckY);
      const below = router.streetAt(pick.mx, pick.mz, pick.oy);
      check(onDeck === (pick.e.name ?? null) && below !== onDeck, 'names',
        `at (${pick.mx.toFixed(0)},${pick.mz.toFixed(0)}), ${pick.d.toFixed(1)} m apart in plan and ` +
        `${(pick.deckY - pick.oy).toFixed(1)} m apart in height: the deck is "${onDeck}", ` +
        `the road under it is ${below === null ? 'null' : `"${below}"`}`);
    }
  }

  // Where the street stops. Marched laterally off an isolated arterial until
  // `streetAt` gives up, so the footway rule is a MEASURED metre count rather
  // than an assertion that the constant equals itself.
  {
    let iso = null;
    for (const e of graph.edges) {
      if (e.rail || e.bridge || e.len < 60) continue;
      const na = graph.nodes[e.a];
      const nb = graph.nodes[e.b];
      const mx = (na.x + nb.x) / 2;
      const mz = (na.z + nb.z) / 2;
      let crowded = false;
      for (const o of graph.edges) {
        if (o === e || o.rail) continue;
        if (edgeDist(o, mx, mz).d < 40) {
          crowded = true;
          break;
        }
      }
      if (crowded) continue;
      if (!iso || e.len > iso.e.len) iso = { e, mx, mz };
    }
    if (!iso) {
      fail('names', 'no edge in the graph is 40 m clear of every other — the footway march has nowhere to run');
    } else {
      const hw = corridorHalfWidth(iso.e.kind, iso.e.lanes);
      let cut = Infinity;
      for (let off = 0; off <= 30; off += 0.25) {
        const px = iso.mx - iso.e.dz * off;
        const pz = iso.mz + iso.e.dx * off;
        if (router.streetAt(px, pz) === null) {
          cut = off;
          break;
        }
      }
      check(cut >= hw && cut <= hw + STREET_SLACK + 0.25, 'names',
        `a ${iso.e.kind} street ends ${cut.toFixed(2)} m off its centreline — its carriageway and footway reach ${hw.toFixed(2)} m, plus ${STREET_SLACK} m of slack`);
    }
  }

  // Off the carriageway and off the footway, there is no street.
  const e0 = longest.get('Butler Street');
  if (!e0) {
    fail('names', 'no edge in the emitted graph is called Butler Street — mission copy names it');
  } else {
    const na = graph.nodes[e0.a];
    const nb = graph.nodes[e0.b];
    const mx = (na.x + nb.x) / 2;
    const mz = (na.z + nb.z) / 2;
    const off = corridorHalfWidth(e0.kind, e0.lanes) + 12;
    const px = mx - e0.dz * off;
    const pz = mz + e0.dx * off;
    const got = router.streetAt(px, pz, (na.y + nb.y) / 2);
    check(got !== 'Butler Street', 'names',
      `${off.toFixed(1)} m off the Butler Street centreline — past its footway — streetAt says ${got === null ? 'null' : `"${got}"`}`);

    // Mission copy: the body shop is ON Butler Street.
    let butlerDist = Infinity;
    for (const e of graph.edges) {
      if (e.name !== 'Butler Street') continue;
      const shop = poiById.get('sh_bodyshop');
      const { d } = edgeDist(e, shop.x, shop.z);
      if (d < butlerDist) butlerDist = d;
    }
    check(butlerDist <= MAX_BUTLER_OFFSET, 'names',
      `the DeCarlo Body Shop is ${butlerDist.toFixed(1)} m from a Butler Street edge (RATCHET ${MAX_BUTLER_OFFSET})`);
  }

  // Mill trackage is not a street.
  const rail = graph.edges.filter((e) => e.rail).sort((a, b) => b.len - a.len)[0];
  if (rail) {
    const na = graph.nodes[rail.a];
    const nb = graph.nodes[rail.b];
    const got = router.streetAt((na.x + nb.x) / 2, (na.z + nb.z) / 2);
    const onRoad = nearestDrivableDist((na.x + nb.x) / 2, (na.z + nb.z) / 2);
    check(got === null || onRoad < 20, 'names',
      `the middle of the longest ballast run reports ${got === null ? 'null' : `"${got}"`} (nearest road ${onRoad.toFixed(0)} m)`);
  }
}

/* --- the cache ----------------------------------------------------------- */

{
  const a = poiById.get('gas_strip');
  const b = poiById.get('sh_boathouse');
  // Start on a quantum centre, so a 3 m nudge provably stays in the same cell.
  const ax = Math.round(a.x / 8) * 8;
  const az = Math.round(a.z / 8) * 8;
  const before = { solves: router.stats.solves, hits: router.stats.hits };
  const p1 = router.routeTo(ax, az, b.x, b.z);
  const solved = router.stats.solves - before.solves;
  const snapshot = p1.map((w) => [w.x, w.z]);
  const p2 = router.routeTo(ax + 3, az, b.x, b.z);
  const reSolved = router.stats.solves - before.solves - solved;
  const hits = router.stats.hits - before.hits;
  const sameSpine = p2.length === snapshot.length
    && snapshot.slice(1, -1).every((p, i) => Math.abs(p[0] - p2[i + 1].x) < 1e-9 && Math.abs(p[1] - p2[i + 1].z) < 1e-9);
  check(solved === 1 && reSolved === 0 && hits === 1, 'cache',
    `first call solved (${solved}), a 3 m nudge inside the 8 m quantum did not (${reSolved} solve, ${hits} hit)`);
  check(sameSpine, 'cache', 'the cached spine is returned unchanged');
  check(Math.abs(p2[0].x - (ax + 3)) < 1e-9 && Math.abs(p2[0].z - az) < 1e-9, 'cache',
    `the entry stub is re-pointed at the live position (${p2[0].x.toFixed(2)}, ${p2[0].z.toFixed(2)})`);
  // Past the quantum it must solve again.
  const before2 = router.stats.solves;
  router.routeTo(ax + 40, az, b.x, b.z);
  check(router.stats.solves - before2 === 1, 'cache', '40 m away re-solves');
}

/* --- the cache: two callers, one plan cell, two decks -------------------- */

/**
 * The case the plan-only key could not see. There is ONE Router per World and
 * `world.routeTo` is shared, so the calls interleaved in it are not one caller
 * moving through time: `game/util.js`'s `driveRoute` runs it once per AI
 * vehicle with that vehicle's own `fromY`. Two of them in the same 8 m plan
 * cell on different decks — a car on a bridge and a car on the quay under it —
 * must not share a route, because the entry waypoint `_repoint` never touches
 * is the one that says which road the route starts on.
 *
 * The pair is FOUND, not authored: any bridge edge with a drivable edge within
 * the plan quantum and a storey or more below it will do, and the assertion is
 * skipped rather than guessed at if this seed grows no such crossing.
 */
{
  let deck = null;
  let under = null;
  for (const e of graph.edges) {
    if (!e.bridge || e.rail) continue;
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    const mx = (na.x + nb.x) * 0.5;
    const mz = (na.z + nb.z) * 0.5;
    const my = (na.y + nb.y) * 0.5;
    for (const o of graph.edges) {
      if (o === e || o.rail || o.bridge) continue;
      const hit = edgeDist(o, mx, mz);
      if (hit.d > 8) continue;
      const oa = graph.nodes[o.a];
      const ob = graph.nodes[o.b];
      const oy = oa.y + (ob.y - oa.y) * hit.t;
      if (my - oy < 6) continue;
      deck = { x: mx, z: mz, y: my };
      under = { x: mx, z: mz, y: oy };
      break;
    }
    if (deck) break;
  }
  if (!deck) {
    check(true, 'deck', 'no bridge-over-road crossing on this seed — case skipped');
  } else {
    const dst = poiById.get('gas_strip');
    const before = { solves: router.stats.solves, hits: router.stats.hits };
    const hi = router.routeTo(deck.x, deck.z, dst.x, dst.z, { fromY: deck.y });
    const hiEntry = hi ? hi[Math.min(1, hi.length - 1)].y : null;
    const lo = router.routeTo(under.x, under.z, dst.x, dst.z, { fromY: under.y });
    const loEntry = lo ? lo[Math.min(1, lo.length - 1)].y : null;
    const solves = router.stats.solves - before.solves;
    const hits = router.stats.hits - before.hits;
    check(solves === 2 && hits === 0, 'deck',
      `two callers ${(deck.y - under.y).toFixed(1)} m apart in one plan cell both solved ` +
      `(${solves} solves, ${hits} hits)`);
    check(hiEntry !== null && loEntry !== null && Math.abs(hiEntry - loEntry) > 3, 'deck',
      `each got its own deck's entry waypoint (${Number(hiEntry).toFixed(1)} m vs ${Number(loEntry).toFixed(1)} m)`);
  }
}

/* --- the published surface ----------------------------------------------- */

{
  // `route.js` is only reachable by the rest of the game through `world`, so
  // the delegates are part of the deliverable. If this fails with a load error
  // rather than a missing method, the fault is in `index.js`'s module scope and
  // not in the routing API.
  let W = null;
  let why = '';
  try {
    const mod = await import('./index.js');
    W = mod.WorldSystem ?? mod.default ?? null;
  } catch (e) {
    why = String(e.message).split('\n')[0];
  }
  check(typeof W?.prototype?.routeTo === 'function' && typeof W?.prototype?.streetAt === 'function', 'api',
    W
      ? `world.routeTo is ${typeof W.prototype.routeTo}, world.streetAt is ${typeof W.prototype.streetAt}`
      : `src/world/index.js did not load headless: ${why}`);
}

/* --- timing -------------------------------------------------------------- */

let timing = null;
{
  // Endpoint pairs sampled off the graph itself, each distinct so the cache
  // can never hit. A few metres off a lane centre is where a mission asks
  // from: a forecourt, a kerb, a lot.
  const rng = new Rng(0xa17e);
  const drivable = graph.edges.filter((e) => !e.rail && e.len > 12);
  const sample = () => {
    const e = drivable[rng.int(0, drivable.length - 1)];
    const na = graph.nodes[e.a];
    const nb = graph.nodes[e.b];
    const t = rng.range(0.15, 0.85);
    const off = rng.range(-16, 16);
    return {
      x: na.x + (nb.x - na.x) * t - e.dz * off,
      z: na.z + (nb.z - na.z) * t + e.dx * off,
    };
  };
  const pairs = [];
  for (let i = 0; i < WARMUP + TIMED; i++) pairs.push([sample(), sample()]);
  for (let i = 0; i < WARMUP; i++) router.routeTo(pairs[i][0].x, pairs[i][0].z, pairs[i][1].x, pairs[i][1].z);

  const ms = [];
  let nulls = 0;
  for (let i = WARMUP; i < pairs.length; i++) {
    const [p, q] = pairs[i];
    const t = process.hrtime.bigint();
    const r = router.routeTo(p.x, p.z, q.x, q.z);
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (!r) nulls++;
  }
  ms.sort((u, v) => u - v);
  const p95 = ms[Math.floor(ms.length * 0.95)];
  const mean = ms.reduce((s, v) => s + v, 0) / ms.length;

  // The cache-hit path, measured the same way.
  const hit = [];
  const [hp, hq] = pairs[pairs.length - 1];
  router.routeTo(hp.x, hp.z, hq.x, hq.z);
  for (let i = 0; i < TIMED; i++) {
    const t = process.hrtime.bigint();
    router.routeTo(hp.x + (i % 4), hp.z, hq.x, hq.z);
    hit.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  hit.sort((u, v) => u - v);
  const hitP50 = hit[hit.length >> 1];
  const p50 = ms[ms.length >> 1];

  timing = { n: ms.length, mean, p50, p95, max: ms[ms.length - 1], nulls, hitP50, hitP95: hit[Math.floor(hit.length * 0.95)], hitMax: hit[hit.length - 1] };
  check(p95 <= SOLVE_P95_MS, 'timing',
    `${ms.length} warm solves over ${graph.nodes.length} nodes: mean ${mean.toFixed(3)} ms, p50 ${p50.toFixed(3)}, p95 ${p95.toFixed(3)}, max ${timing.max.toFixed(3)} (budget p95 ${SOLVE_P95_MS} ms; ${nulls} null)`);
  check(hitP50 <= HIT_P50_MS && hitP50 * HIT_SPEEDUP <= p50, 'timing',
    `cache hits: p50 ${hitP50.toFixed(4)} ms, ${(p50 / Math.max(hitP50, 1e-6)).toFixed(0)}x cheaper than a solve ` +
    `(budgets: p50 ${HIT_P50_MS} ms, ${HIT_SPEEDUP}x). Tail, not gated: p95 ${timing.hitP95.toFixed(4)}, max ${timing.hitMax.toFixed(4)}`);
}

/* -------------------------------------------------------------- report --- */

if (args.json) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(String(args.json)), { recursive: true });
  writeFileSync(String(args.json), JSON.stringify({ rows, waterRows, timing, controls, checks }, null, 2));
}

console.log('');
console.log(`  city: ${graph.nodes.length} nodes / ${graph.edges.length} edges, built in ${buildMs} ms, seed 0x${SEED.toString(16)}`);
console.log('');
for (const r of rows) {
  if (!r.ok) {
    console.log(`  ${r.pair.padEnd(30)} NULL`);
    continue;
  }
  console.log(
    `  ${r.pair.padEnd(30)} ${String(r.points).padStart(3)} pts  ${r.metres.toFixed(0).padStart(5)} m` +
    `  x${r.detour.toFixed(2)}  stubs ${r.stubIn.toFixed(0)}/${r.stubOut.toFixed(0)} m` +
    `  ${r.crossings.length ? r.crossings.join('+') : 'same bank'}`
  );
}
console.log('');
for (const w of waterRows) {
  console.log(`  ${w.river.padEnd(13)} open water at (${w.x.toFixed(0)},${w.z.toFixed(0)}), ${w.clear.toFixed(0)} m clear -> route ${w.out && w.back ? 'null' : 'ROUTED'}, street ${w.name ?? 'null'}`);
}
console.log('');
let ok = 0;
for (const c of checks) {
  console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name.padEnd(11)} ${c.msg}`);
  if (c.ok) ok++;
}
const allOk = checks.length > 0 && ok === checks.length;
console.log(`\n${allOk ? 'ALL PASSED' : 'FAILED'} — ${ok}/${checks.length}`);
process.exit(allOk ? 0 : 1);
