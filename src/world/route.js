import { corridorHalfWidth, corridorStreetName, segDist2 } from './plan.js';

/**
 * WORLD — road routing and street names.
 *
 * Two questions every mission, every waypoint arrow and every "where am I"
 * readout needs answered against the SAME graph traffic and police drive on:
 *
 *   routeTo(fromX, fromZ, toX, toZ)   drive me there — a list of waypoints
 *   streetAt(x, z, y?)                what is this road called
 *
 * `roads.route(a, b)` already exists and is what `traffic` and `police` use;
 * it takes NODE IDS and costs in time, because an AI driver already knows which
 * node it is sitting on and wants the quickest way. A mission does not: it has
 * a world position that is usually not on the network at all — a forecourt, a
 * dock, a lot behind a shop — and it wants the SHORTEST way, in metres, so the
 * distance it quotes the player is the distance he drives. So this is a second
 * solver, not a wrapper: `cost = edge length`, endpoints are metres, and the
 * off-graph hops at each end are part of the answer.
 *
 * WHAT COMES BACK
 *
 * A REUSED array of `{ x, z, y, node, edge, name }`, first point the caller's
 * own `from`, last point his `to`:
 *
 *   [0]        from            node -1, edge -1   the off-graph entry stub
 *   [1]        entry point     node -1, edge E    where the stub meets the road
 *   [2..k]     graph nodes     node id,  edge E   `edge` is the one LEAVING
 *   [k+1]      exit point      node -1, edge -1   the off-graph exit stub
 *   [k+2]      to              node -1, edge -1
 *
 * `edge` on a waypoint is the graph edge you travel along to reach the NEXT
 * waypoint, so a follower reads leg `i` as `p[i] -> p[i+1]` on `p[i].edge`, and
 * `name` is that leg's street. The two stubs carry `edge = -1` because there is
 * no road under them. `path.metres` is the whole thing end to end, stubs
 * included — an ETA needs the walk across the forecourt too.
 *
 * An entry or exit point that lands ON a junction is MERGED with it rather than
 * emitted twice, so those rows can carry a real node id and the list can be
 * shorter than the shape above. Nothing may assume a fixed length; what is
 * guaranteed is that consecutive interior waypoints always share one edge, and
 * that no leg is ever zero length.
 *
 * The array and the waypoint objects are reused between calls (ARCHITECTURE.md
 * rule 5). Read what you need; do not retain it across a call.
 *
 * NULL MEANS "NOT BY ROAD", and it means it for three different reasons, all of
 * which a caller wants to treat the same way: either end further than
 * `ENTRY_MAX` from a drivable edge (open water, a hilltop, the middle of a
 * runway), the two ends on different connected components of the graph, or no
 * path found. A mission that gets null should fall back to a straight-line
 * marker, not retry.
 *
 * THE COMPONENT REFUSAL IS BELT AND BRACES. `netgen.pruneIslands` publishes
 * `roads.mainComponent`, and the A* below cannot cross between islands anyway —
 * it would simply exhaust the heap and return null after touching every node on
 * the near island. Checking first turns a full-graph search into two array
 * reads, which is what makes the worst case (a stranded start, the far side of
 * the map as the target) as cheap as the common one. It reads a per-node
 * `comp` / `component` if one is published and `roads.mainComponent` if that
 * is, and refuses if EITHER says the two ends are on different islands.
 */

/** Metres from a drivable edge past which an endpoint is not on the road net. */
const ENTRY_MAX = 60;
/**
 * Cache quantum, metres. Two calls whose four endpoint coordinates round to the
 * same 8 m cell get the same route back. Sized against the caller, not the
 * solver: this is polled at about 1 Hz, and 8 m is a quarter of a second at
 * 108 km/h, so the route cannot go stale within a frame of anyone noticing.
 * The two off-graph stubs are re-pointed at the live endpoints on a cache hit,
 * so a hit is never a waypoint list that starts somewhere the caller is not.
 */
const QUANT = 8;
/**
 * Cache quantum for the DECK, metres, and the band a call with no height at all
 * lands in.
 *
 * The plan quantum above is sized against ONE CALLER MOVING THROUGH TIME, and
 * for that the argument holds — nobody changes deck without also moving 8 m.
 * There is one `Router` per `World` and `world.routeTo` is a shared entry
 * point, so the calls interleaved in it are not one caller: `game/util.js`'s
 * `driveRoute` runs it once per AI vehicle, staggered across eight phases, each
 * with its own `_routeOpts.fromY`. Two of those in the same 8 m plan cell on
 * different decks — one on the Sixth Street bridge, one on the Allegheny Quay
 * eighteen metres beneath it — is not a caller moving, it is two callers, and
 * the second would take the first's deck route with its stubs re-pointed at the
 * quay. It would then steer for a bridge waypoint from underneath the bridge,
 * i.e. into the abutment. `_repoint` cannot save it: it moves the two off-graph
 * stubs in PLAN only, and never touches `p[1]`, the entry waypoint that carries
 * the road the route starts on.
 *
 * 4 m is under `DECK_SLACK * 2` — anything the entry search would call the same
 * deck lands in the same band or the one beside it, and a real deck separation
 * is a storey or more. `NO_DECK` is its own band so that callers who pass no
 * height (the mission and marker paths, which are plan queries by nature) still
 * share a cache line with each other and with nobody else.
 */
const DECK_QUANT = 4;
const NO_DECK = -32768;
/** Search radius for `streetAt`. Covers the widest corridor plus its slack. */
const STREET_MAX = 20;
/**
 * How far past the footway edge still counts as being ON the street. A forecourt
 * or a front garden is not, which is why `streetAt` can return null a few metres
 * from a road it can see.
 */
const STREET_SLACK = 3.5;
/** Two route points closer than this are one point; drop the duplicate. */
const JOIN_EPS = 0.5;
/** Height disagreement, metres, before a candidate edge is a different deck. */
const DECK_SLACK = 1.5;
/** What a metre of deck disagreement costs against a metre of plan distance. */
const DECK_PENALTY = 12;

const _seg = { d2: 0, t: 0 };

/**
 * The cache band a route endpoint's height falls in. A number always, never
 * NaN — a NaN in the key would never compare equal to itself and every
 * heightless caller would miss.
 */
function deckBand(y) {
  return Number.isFinite(y) ? Math.round(y / DECK_QUANT) : NO_DECK;
}

/** Min-heap on f. Same shape as `roadgraph.js`'s, which is not exported. */
class Heap {
  constructor(cap = 1024) {
    this.idx = new Int32Array(cap);
    this.key = new Float32Array(cap);
    this.n = 0;
  }
  clear() {
    this.n = 0;
  }
  push(i, k) {
    if (this.n >= this.idx.length) {
      const idx = new Int32Array(this.idx.length * 2);
      const key = new Float32Array(this.key.length * 2);
      idx.set(this.idx);
      key.set(this.key);
      this.idx = idx;
      this.key = key;
    }
    let c = this.n++;
    this.idx[c] = i;
    this.key[c] = k;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.key[p] <= this.key[c]) break;
      const ti = this.idx[p];
      const tk = this.key[p];
      this.idx[p] = this.idx[c];
      this.key[p] = this.key[c];
      this.idx[c] = ti;
      this.key[c] = tk;
      c = p;
    }
  }
  pop() {
    const top = this.idx[0];
    this.n--;
    if (this.n > 0) {
      this.idx[0] = this.idx[this.n];
      this.key[0] = this.key[this.n];
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < this.n && this.key[l] < this.key[m]) m = l;
        if (r < this.n && this.key[r] < this.key[m]) m = r;
        if (m === c) break;
        const ti = this.idx[m];
        const tk = this.key[m];
        this.idx[m] = this.idx[c];
        this.key[m] = this.key[c];
        this.idx[c] = ti;
        this.key[c] = tk;
        c = m;
      }
    }
    return top;
  }
}

export class Router {
  /** @param {import('./roadgraph.js').RoadGraph} roads */
  constructor(roads) {
    this.roads = roads;
    this._scan = [];
    this._near = { edge: null, dist: Infinity, t: 0, x: 0, z: 0, y: 0 };
    this._exit = { edge: null, dist: Infinity, t: 0, x: 0, z: 0, y: 0 };
    this._pool = [];
    this._path = [];
    this._order = new Int32Array(64);
    this._heap = new Heap();
    this._epoch = 0;
    this._g = null;
    this._came = null;
    this._cameEdge = null;
    this._open = null;
    this._closed = null;
    this._cache = {
      fx: NaN, fz: NaN, tx: NaN, tz: NaN, fy: NaN, ty: NaN,
      stamp: -1, valid: false, ok: false,
    };
    /** Diagnostics for the dev overlay. Never read by the solver itself. */
    this.stats = { solves: 0, hits: 0, expanded: 0, refusals: 0 };
  }

  /* ------------------------------------------------------------- streets -- */

  /**
   * The name of the street at (x, z), or null off the network.
   *
   * PASS `y` WHEN YOU HAVE ONE, for the reason `surfaceAt` documents: every
   * bridge in Steel City flies over a riverfront quay, so in plan view a car on
   * the Sixth Street deck is two metres from the Allegheny Quay and eighteen
   * metres above it. Without a height the answer is a coin toss between them.
   */
  streetAt(x, z, y = NaN) {
    const hit = this._nearestDrivable(x, z, STREET_MAX, y, this._near);
    const e = hit.edge;
    if (!e) return null;
    if (hit.dist > corridorHalfWidth(e.kind, e.lanes) + STREET_SLACK) return null;
    return this._edgeName(e);
  }

  /** The street name an emitted edge carries, authored or from the plan. */
  _edgeName(e) {
    if (!e || e.rail) return null;
    return e.name ?? corridorStreetName(e.corridor);
  }

  /* -------------------------------------------------------------- routes -- */

  /**
   * Waypoints from (fromX, fromZ) to (toX, toZ) by road, or null.
   *
   * `opts.fromY` / `opts.toY` disambiguate a bridge deck from the quay beneath
   * it, exactly as in `streetAt`, and they ARE part of the cache key — see
   * `DECK_QUANT` for the two-callers-one-cell case that says they must be.
   */
  routeTo(fromX, fromZ, toX, toZ, opts = null) {
    const roads = this.roads;
    if (!roads || !roads.nodes.length) return null;
    const stamp = roads.edges.length;
    const c = this._cache;
    const qfx = Math.round(fromX / QUANT);
    const qfz = Math.round(fromZ / QUANT);
    const qtx = Math.round(toX / QUANT);
    const qtz = Math.round(toZ / QUANT);
    const qfy = deckBand(opts?.fromY);
    const qty = deckBand(opts?.toY);
    if (
      c.valid && c.stamp === stamp &&
      c.fx === qfx && c.fz === qfz && c.tx === qtx && c.tz === qtz &&
      c.fy === qfy && c.ty === qty
    ) {
      this.stats.hits++;
      if (!c.ok) return null;
      return this._repoint(fromX, fromZ, toX, toZ);
    }
    c.valid = true;
    c.stamp = stamp;
    c.fx = qfx;
    c.fz = qfz;
    c.tx = qtx;
    c.tz = qtz;
    c.fy = qfy;
    c.ty = qty;
    c.ok = false;
    this.stats.solves++;

    const entry = this._nearestDrivable(fromX, fromZ, ENTRY_MAX, opts?.fromY ?? NaN, this._near);
    if (!entry.edge) return null;
    const exit = this._nearestDrivable(toX, toZ, ENTRY_MAX, opts?.toY ?? NaN, this._exit);
    if (!exit.edge) return null;

    if (!this._sameComponent(entry.edge.a, exit.edge.a)) {
      this.stats.refusals++;
      return null;
    }

    this._path.length = 0;
    this._push(fromX, fromZ, entry.y, -1, -1);

    if (entry.edge === exit.edge) {
      // One edge, both ends on it: drive along it, no junction in between.
      this._push(entry.x, entry.z, entry.y, -1, -1);
      if (Math.hypot(exit.x - entry.x, exit.z - entry.z) >= JOIN_EPS) {
        this._path[1].edge = entry.edge.id;
        this._path[1].name = this._edgeName(entry.edge);
        this._push(exit.x, exit.z, exit.y, -1, -1);
      }
      this._push(toX, toZ, exit.y, -1, -1);
      c.ok = true;
      return this._finish();
    }

    const goal = this._solve(entry, exit);
    if (goal < 0) return null;

    // Walk the came-from chain back to whichever entry endpoint seeded it.
    const nodes = roads.nodes;
    let count = 0;
    for (let cur = goal; cur !== -1; cur = this._came[cur]) {
      if (count >= this._order.length) {
        const bigger = new Int32Array(this._order.length * 2);
        bigger.set(this._order);
        this._order = bigger;
      }
      this._order[count++] = cur;
      if (count > nodes.length) return null; // a cycle cannot happen; refuse rather than hang
    }

    const first = nodes[this._order[count - 1]];
    if (Math.hypot(first.x - entry.x, first.z - entry.z) >= JOIN_EPS) {
      this._push(entry.x, entry.z, entry.y, -1, entry.edge.id);
    }
    for (let i = count - 1; i >= 0; i--) {
      const id = this._order[i];
      const n = nodes[id];
      // The edge LEAVING this node is the one the next node was reached by,
      // and the last node leaves along the exit edge.
      const leave = i > 0 ? this._cameEdge[this._order[i - 1]] : exit.edge.id;
      this._push(n.x, n.z, n.y, id, leave);
    }
    const last = nodes[goal];
    if (Math.hypot(last.x - exit.x, last.z - exit.z) >= JOIN_EPS) {
      this._push(exit.x, exit.z, exit.y, -1, -1);
    } else {
      this._path[this._path.length - 1].edge = -1;
      this._path[this._path.length - 1].name = null;
    }
    this._push(toX, toZ, exit.y, -1, -1);
    c.ok = true;
    return this._finish();
  }

  /* ------------------------------------------------------------ internals -- */

  /**
   * Nearest DRIVABLE edge within `maxDist`, with its projection point.
   *
   * Not `roads.nearestEdge`: that one hands back mill trackage, which is in the
   * graph so `roadmesh` can draw ballast and is not a road — a route that
   * enters or leaves on a rail edge is a car on the sleepers. The height
   * penalty is the same one `nearestEdge` documents, for the same reason.
   */
  _nearestDrivable(x, z, maxDist, y, out) {
    out.edge = null;
    out.dist = Infinity;
    out.t = 0;
    out.x = x;
    out.z = z;
    out.y = 0;
    const roads = this.roads;
    const list = this._scan;
    list.length = 0;
    roads.edgesInRect(x - maxDist, z - maxDist, x + maxDist, z + maxDist, list);
    const useY = Number.isFinite(y);
    let bestScore = Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.rail) continue;
      const na = roads.nodes[e.a];
      const nb = roads.nodes[e.b];
      segDist2(x, z, na.x, na.z, nb.x, nb.z, _seg);
      const d = Math.sqrt(_seg.d2);
      if (d > maxDist) continue;
      const ey = na.y + (nb.y - na.y) * _seg.t;
      let score = d;
      if (useY) {
        const over = Math.abs(ey - y) - DECK_SLACK;
        if (over > 0) score += over * DECK_PENALTY;
      }
      if (score < bestScore) {
        bestScore = score;
        out.edge = e;
        out.dist = d;
        out.t = _seg.t;
        out.x = na.x + (nb.x - na.x) * _seg.t;
        out.z = na.z + (nb.z - na.z) * _seg.t;
        out.y = ey;
      }
    }
    return out;
  }

  /**
   * A* from the entry projection to the exit projection. Returns the exit-edge
   * endpoint the optimal route arrives at, or -1.
   *
   * Both endpoints of the entry edge are seeded, each with the distance from
   * the projection to it, so the solver is free to leave the entry point in
   * either direction. The heuristic is straight-line distance to the exit
   * PROJECTION, which is admissible against a metre-cost graph — and because
   * the projection lies on the exit edge, `h` at either exit endpoint is
   * exactly the remaining along-edge distance. So `f` at the moment an exit
   * endpoint is popped IS the total route length, and the first one popped is
   * the optimum: no second pass, no candidate bookkeeping.
   */
  _solve(entry, exit) {
    const roads = this.roads;
    const nodes = roads.nodes;
    const edges = roads.edges;
    this._ensure(nodes.length);
    const g = this._g;
    const came = this._came;
    const cameEdge = this._cameEdge;
    const open = this._open;
    const closed = this._closed;
    const heap = this._heap;
    const epoch = ++this._epoch;
    heap.clear();

    const ex = exit.x;
    const ez = exit.z;
    const ga = exit.edge.a;
    const gb = exit.edge.b;

    const seed = (id, cost) => {
      const n = nodes[id];
      g[id] = cost;
      came[id] = -1;
      cameEdge[id] = entry.edge.id;
      open[id] = epoch;
      heap.push(id, cost + Math.hypot(n.x - ex, n.z - ez));
    };
    seed(entry.edge.a, entry.t * entry.edge.len);
    seed(entry.edge.b, (1 - entry.t) * entry.edge.len);

    let expanded = 0;
    while (heap.n > 0) {
      const u = heap.pop();
      if (closed[u] === epoch) continue;
      closed[u] = epoch;
      expanded++;
      if (u === ga || u === gb) {
        this.stats.expanded = expanded;
        return u;
      }
      const links = nodes[u].links;
      for (let i = 0; i < links.length; i++) {
        const e = edges[links[i]];
        if (e.rail) continue;
        if (e.oneway && e.a !== u) continue;
        const v = e.a === u ? e.b : e.a;
        if (closed[v] === epoch) continue;
        const ng = g[u] + e.len;
        if (open[v] === epoch && ng >= g[v]) continue;
        open[v] = epoch;
        g[v] = ng;
        came[v] = u;
        cameEdge[v] = e.id;
        const n = nodes[v];
        heap.push(v, ng + Math.hypot(n.x - ex, n.z - ez));
      }
    }
    this.stats.expanded = expanded;
    return -1;
  }

  _ensure(n) {
    if (this._g && this._g.length >= n) return;
    this._g = new Float32Array(n);
    this._came = new Int32Array(n);
    this._cameEdge = new Int32Array(n);
    this._open = new Int32Array(n).fill(-1);
    this._closed = new Int32Array(n).fill(-1);
    this._epoch = 0;
  }

  /**
   * Are these two nodes on the same island? See the header — this is a guard,
   * not the correctness argument. It trusts whichever of the two publications
   * exists and refuses if either disagrees, so it stays right whether the
   * component id lands on the node or on the graph.
   */
  _sameComponent(a, b) {
    const nodes = this.roads.nodes;
    const ca = nodes[a]?.comp ?? nodes[a]?.component;
    const cb = nodes[b]?.comp ?? nodes[b]?.component;
    if (typeof ca === 'number' && typeof cb === 'number' && ca !== cb) return false;
    const arr = this.roads.mainComponent;
    if (arr && arr.length > a && arr.length > b && arr[a] !== arr[b]) return false;
    return true;
  }

  _push(x, z, y, node, edge) {
    const i = this._path.length;
    let w = this._pool[i];
    if (!w) this._pool[i] = w = { x: 0, z: 0, y: 0, node: -1, edge: -1, name: null };
    w.x = x;
    w.z = z;
    w.y = y;
    w.node = node;
    w.edge = edge;
    w.name = edge >= 0 ? this._edgeName(this.roads.edges[edge]) : null;
    this._path.push(w);
    return w;
  }

  /** Total the legs and hand the reused array back. */
  _finish() {
    const p = this._path;
    let m = 0;
    for (let i = 1; i < p.length; i++) m += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
    p.metres = m;
    return p;
  }

  /** Cache hit: move the two off-graph stubs to where the caller actually is. */
  _repoint(fromX, fromZ, toX, toZ) {
    const p = this._path;
    p[0].x = fromX;
    p[0].z = fromZ;
    p[p.length - 1].x = toX;
    p[p.length - 1].z = toZ;
    return this._finish();
  }
}
