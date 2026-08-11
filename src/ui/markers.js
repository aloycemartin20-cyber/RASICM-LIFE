import * as THREE from 'three';
import { el, svg, setText, setStyle, setClass, Pool, ease, clamp, clamp01, metres } from './util.js';

const _v = new THREE.Vector3();

/**
 * Projects a world point into HUD pixels.
 * Returns the shared scratch object — never held past the call site.
 */
const _proj = { x: 0, y: 0, dist: 0, behind: false, offscreen: false, angle: 0 };
function project(pos, camera, w, h, margin) {
  _v.copy(pos);
  const dist = _v.distanceTo(camera.position);
  /**
   * BEHIND IS A DOT PRODUCT, NOT AN NDC TEST — because this renderer's depth
   * is REVERSED.
   *
   * This read `_v.z > 1` after `project()`, which is the correct test for a
   * conventional projection (near -> -1, far -> +1) and is NEVER TRUE here:
   * `render` runs a reversed-Z pipeline (near -> 1, far -> 0), so a point
   * behind the lens comes back at z ~= 0. MEASURED on a live frame with an
   * objective 978 m directly astern: `ndc.z = -0.0001`, `behind = false`.
   *
   * Everything downstream of the flag was therefore dead for every
   * behind-the-player target: the mirror below never ran, so the marker drew
   * at the projection's ANTIPODE — the wrong side of the screen — the chevron
   * never replaced the diamond, and a target you had turned your back on was
   * drawn as an on-screen diamond a few dozen pixels from the crosshair with a
   * distance of nearly a kilometre on it.
   *
   * The camera's own forward axis answers the question in any depth
   * convention: `matrixWorld` columns are [right, up, BACKWARD], so forward is
   * the negated third column and the sign of the dot is the whole test.
   */
  const e = camera.matrixWorld.elements;
  const behind =
    (pos.x - camera.position.x) * -e[8] +
    (pos.y - camera.position.y) * -e[9] +
    (pos.z - camera.position.z) * -e[10] <= 0;
  _v.project(camera);
  let x = (_v.x * 0.5 + 0.5) * w;
  let y = (-_v.y * 0.5 + 0.5) * h;
  if (behind) {
    // mirror through the centre so the edge arrow points the correct way
    x = w - x;
    y = h - y;
  }
  const cx = w * 0.5;
  const cy = h * 0.5;
  let dx = x - cx;
  let dy = y - cy;
  const mx = w * 0.5 - margin;
  const my = h * 0.5 - margin;
  /**
   * A BEHIND-CAMERA TARGET IS PUSHED OUT TO THE RIM, NOT LEFT NEAR THE MIDDLE.
   *
   * The mirror above maps a point directly behind the lens to somewhere near
   * screen CENTRE, and the old test only ever clamped points that were already
   * outside the safe area — so an objective straight behind the player drew its
   * chevron a few dozen pixels from the crosshair, pointing at nothing the eye
   * could follow, while the whole grammar of the widget says "on the edge, in
   * the direction you must turn". The same `Math.min` ratio SCALES UP as
   * happily as it clamps down, so one condition covers both.
   */
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  let off = behind;
  if (behind || ax > mx || ay > my) {
    off = true;
    if (ax < 1e-3 && ay < 1e-3) {
      // Dead astern, with no bearing left in the projection: six o'clock is
      // the honest answer and the chevron points down at it.
      dx = 0;
      dy = my;
    } else {
      const s = Math.min(mx / (ax || 1e-4), my / (ay || 1e-4));
      dx *= s;
      dy *= s;
    }
  }
  _proj.x = cx + dx;
  _proj.y = cy + dy;
  _proj.dist = dist;
  _proj.behind = behind;
  _proj.offscreen = off;
  _proj.angle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  return _proj;
}

/**
 * Marker geometry, CSS px before `k`. `GLYPH` MIRRORS `.ow-mk-glyph`'s box in
 * `style.js` — the two are one measurement in two languages, and the transform
 * below centres the glyph on the projected point, so they must not drift.
 */
const GLYPH = 22;
/**
 * Opacity floors. The distance curve exists so a busy map is not a wall of
 * icons, but it used to reach ZERO at 300 m and an objective marker is the one
 * thing on screen the player is actively hunting for. MEASURED on the 1920x1080
 * hud capture before the floor: the far marker drew at alpha 0.00 — invisible,
 * with its distance readout invisible with it.
 *
 * The off-screen chevron gets the HIGHER floor, not the lower one it used to
 * get from a flat 0.72 multiplier: a chevron is by definition pointing at
 * something you cannot see, so dimming it is dimming the only thing left.
 */
const FADE_FLOOR = 0.55;
const CHEVRON_FLOOR = 0.8;

/**
 * ---------------------------------------------------------------------------
 * RIM DE-COLLISION — two off-screen objectives are not one objective
 * ---------------------------------------------------------------------------
 * `project()` clamps an off-screen target to the safe-area rectangle along the
 * ray from screen centre, so any two targets on a similar BEARING land on the
 * same rim point however far apart they are in the world. MEASURED on a live
 * frame with two live objectives behind the player — RENDEZVOUS at 982 m and
 * CRATE at 1295 m — both chevrons, both distance readouts and both names drew
 * on top of each other, and the pair read as one marker with a smeared label.
 *
 * The fix is a one-dimensional problem, so it is solved in one dimension: a
 * clamped point lies ON the rim rectangle, so it has a single perimeter
 * coordinate, and separating labels along that coordinate is the classic
 * spread. Sliding along the rim keeps every chevron on the boundary and moves
 * it the SHORTEST distance that makes it readable, which is what preserves the
 * bearing — pushing them radially inward instead would put an "off-screen"
 * marker in the middle of the picture.
 *
 * On-screen markers are left alone: they are at their true projected position
 * and moving one would be a lie about where the thing is.
 */
/**
 * Minimum gap between two rim markers, CSS px before `k`.
 *
 * SIZED FOR THE LABEL, NOT FOR THE GLYPH. The first cut used 58 — a little
 * over the 44 px glyph box — and MEASURED on the emitted layout that still
 * overprinted: at k = 0.667 the pair came out 38.7 px apart while
 * "RENDEZVOUS" alone draws 53 px wide, so the two names still touched by
 * 2.6 px with the chevrons cleanly separated. The name is the widest part of a
 * marker and the part that is unreadable when it collides, so the spacing is
 * set from it: ~96 px clears a ten-character objective name beside a short one
 * at every scale, and the rim has 5 400 px of perimeter at 1080p to spend.
 */
const RIM_SEP = 96;
/** Preallocated spread workspace — rule 5, never grown per frame. */
const _rimS = new Float64Array(8);
const _rimI = new Int32Array(8);

/**
 * Perimeter coordinate of a point already clamped to the rim rectangle
 * (half-extents `mx`, `my`, centred on the origin). Runs clockwise from the
 * middle of the right edge; the total perimeter is `4 * (mx + my)`.
 */
export function rimParam(dx, dy, mx, my) {
  // The clamp in `project()` scales by the SMALLER of mx/|dx| and my/|dy|, so
  // exactly one axis is pinned. Whichever is proportionally further out is the
  // edge the point is on; the corner case resolves either way and agrees.
  if (Math.abs(dx) * my >= Math.abs(dy) * mx) {
    return dx >= 0 ? dy + my                       // right edge, top -> bottom
      : 2 * my + 2 * mx + (my - dy);               // left edge, bottom -> top
  }
  return dy >= 0 ? 2 * my + (mx - dx)              // bottom edge, right -> left
    : 4 * my + 2 * mx + (dx + mx);                 // top edge, left -> right
}

/** Inverse of `rimParam` — writes into `out` (`{x, y}`), never allocates. */
export function rimPoint(s, mx, my, out) {
  const P = 4 * (mx + my);
  let t = s % P;
  if (t < 0) t += P;
  if (t < 2 * my) { out.x = mx; out.y = t - my; return out; }
  t -= 2 * my;
  if (t < 2 * mx) { out.x = mx - t; out.y = my; return out; }
  t -= 2 * mx;
  if (t < 2 * my) { out.x = -mx; out.y = my - t; return out; }
  t -= 2 * my;
  out.x = t - mx;
  out.y = -my;
  return out;
}

/**
 * Push `n` perimeter coordinates apart until no neighbour is within `sep`,
 * in place, on a CIRCLE of circumference `P`. Order-preserving and symmetric:
 * a colliding pair splits the correction between them, so neither marker gets
 * to keep the disputed spot and both stay near their true bearing.
 *
 * Two relaxation sweeps rather than an exact solve — with the six markers the
 * pool can hold and a rim of a few thousand pixels, two sweeps converge, and a
 * cluster too dense to separate degrades to evenly spaced rather than to a
 * pile. Returns the number of coordinates it moved.
 */
export function spreadRim(s, n, sep, P) {
  if (n < 2) return 0;
  let moved = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      let gap = s[j] - s[i];
      // The last-to-first gap wraps the circle.
      if (j === 0) gap += P;
      if (gap >= sep) continue;
      const push = (sep - gap) * 0.5;
      s[i] -= push;
      s[j] += push;
      moved++;
    }
  }
  return moved;
}

function diamond(parent) {
  const s = svg('svg', { viewBox: '0 0 16 16' }, parent);
  svg(
    'rect',
    {
      x: 3.2,
      y: 3.2,
      width: 9.6,
      height: 9.6,
      transform: 'rotate(45 8 8)',
      fill: 'rgba(121,210,255,.9)',
      stroke: 'rgba(6,20,28,.75)',
      'stroke-width': 1,
    },
    s
  );
  return s;
}

function chevron(parent) {
  const s = svg('svg', { viewBox: '0 0 16 16' }, parent);
  svg('path', { d: 'M8 1.5 14.4 13H1.6z', fill: 'rgba(121,210,255,.95)', stroke: 'rgba(6,20,28,.7)', 'stroke-width': 1 }, s);
  return s;
}

function nadeGlyph(parent) {
  const s = svg('svg', { viewBox: '0 0 16 16' }, parent);
  svg('circle', { cx: 8, cy: 8, r: 5.4, fill: 'rgba(255,63,49,.95)', stroke: 'rgba(0,0,0,.5)', 'stroke-width': 1 }, s);
  svg('rect', { x: 7.2, y: 0.8, width: 1.6, height: 3.2, fill: 'rgba(255,63,49,.95)' }, s);
  return s;
}

/**
 * Everything anchored to a world position: objective markers with distance,
 * grenade danger indicators, and floating damage numbers.
 *
 * Off-screen targets are clamped to a rectangular ring inside the safe area and
 * their glyph swaps to a chevron pointing at the target — the same behaviour as
 * a CoD objective you have turned away from.
 */
export class WorldMarkers {
  constructor(parent, rng) {
    this.rng = rng;
    this.objRoot = el('div', 'ow-layer', parent);
    this.objPool = new Pool(
      6,
      () => {
        const node = el('div', 'ow-mk');
        const gl = el('div', 'ow-mk-glyph', node);
        const dia = diamond(gl);
        const chev = chevron(gl);
        chev.style.display = 'none';
        const letter = el('div', 'ow-mk-letter', gl, 'A');
        const dist = el('div', 'ow-mk-dist', node, '0M');
        const name = el('div', 'ow-mk-name', node, '');
        node._dia = dia;
        node._chev = chev;
        node._letter = letter;
        node._dist = dist;
        node._name = name;
        return node;
      },
      this.objRoot
    );

    this.nadePool = new Pool(
      4,
      () => {
        const node = el('div', 'ow-nade');
        const ring = el('div', 'ow-nade-ring', node);
        const core = el('div', 'ow-nade-core', node);
        nadeGlyph(core);
        const label = el('div', 'ow-nade-label', node, 'GRENADE');
        node._ring = ring;
        node._label = label;
        node._pos = new THREE.Vector3();
        return node;
      },
      this.objRoot
    );

    this.dnPool = new Pool(
      16,
      () => {
        const node = el('div', 'ow-dn');
        node._pos = new THREE.Vector3();
        return node;
      },
      this.objRoot
    );

    // Per-frame projection scratch for the objective pass, sized to the pool.
    // Rule 5: `updateObjectives` allocates nothing.
    const cap = this.objPool.items.length;
    this._px = new Float64Array(cap);
    this._py = new Float64Array(cap);
    this._pd = new Float64Array(cap);
    this._pa = new Float64Array(cap);
    this._pe = new Uint8Array(cap);
    this._rimOut = { x: 0, y: 0 };
    /** Negative control for `src/ui/rimprobe.mjs` — the overprinting build. */
    this.debugNoSpread = false;
  }

  /**
   * Slide every rim-clamped marker along the safe-area rectangle until no two
   * are within `RIM_SEP`. See the note above `rimParam`. The chevrons keep the
   * angle they were projected at, so each still points at its own target.
   */
  _spreadEdges(n, cx, cy, mx, my, k) {
    if (this.debugNoSpread) return 0;
    let m = 0;
    for (let i = 0; i < n && m < _rimS.length; i++) {
      if (!this._pe[i]) continue;
      const s = rimParam(this._px[i] - cx, this._py[i] - cy, mx, my);
      // Insertion sort as we collect — n is at most the pool size.
      let j = m++;
      while (j > 0 && _rimS[j - 1] > s) {
        _rimS[j] = _rimS[j - 1];
        _rimI[j] = _rimI[j - 1];
        j--;
      }
      _rimS[j] = s;
      _rimI[j] = i;
    }
    if (m < 2) return 0;
    const moved = spreadRim(_rimS, m, RIM_SEP * k, 4 * (mx + my));
    if (!moved) return 0;
    for (let q = 0; q < m; q++) {
      const p = rimPoint(_rimS[q], mx, my, this._rimOut);
      this._px[_rimI[q]] = cx + p.x;
      this._py[_rimI[q]] = cy + p.y;
    }
    return moved;
  }

  /** @param {Array} list [{ position:Vector3, label:'A', name:'CAPTURE', color }] */
  updateObjectives(list, camera, w, h, k) {
    const items = this.objPool.items;
    let n = 0;
    const margin = 74 * k;
    // PROJECT FIRST, DRAW SECOND. The rim spread is a decision about the whole
    // SET of markers, so no position can be written until every one is known.
    if (list) {
      for (let i = 0; i < list.length && n < items.length; i++) {
        const o = list[i];
        if (!o?.position) continue;
        const p = project(o.position, camera, w, h, margin);
        const it = items[n];
        if (!it.alive) {
          it.alive = true;
          setStyle(it.node, 'display', '');
        }
        this._px[n] = p.x;
        this._py[n] = p.y;
        this._pd[n] = p.dist;
        this._pa[n] = p.angle;
        this._pe[n] = p.offscreen ? 1 : 0;
        setText(it.node._letter, o.label ?? '');
        setText(it.node._dist, metres(p.dist));
        setText(it.node._name, o.name ?? '');
        n++;
      }
      this._spreadEdges(n, w * 0.5, h * 0.5, w * 0.5 - margin, h * 0.5 - margin, k);
      for (let i = 0; i < n; i++) {
        const node = items[i].node;
        const gh = GLYPH * k * 0.5;
        setStyle(node, 'transform',
          `translate(${(this._px[i] - GLYPH * k).toFixed(1)}px,${(this._py[i] - gh).toFixed(1)}px)`);
        setStyle(node, 'width', `${(GLYPH * 2 * k).toFixed(1)}px`);
        const edge = this._pe[i] === 1;
        setStyle(node._dia, 'display', edge ? 'none' : '');
        setStyle(node._chev, 'display', edge ? '' : 'none');
        setStyle(node._letter, 'opacity', edge ? '0' : '1');
        // The chevron keeps the angle it was PROJECTED at, not the one the
        // slid position implies: it points at its own target, which is the
        // only reason a chevron is on screen at all.
        if (edge) setStyle(node._chev, 'transform', `rotate(${this._pa[i].toFixed(1)}deg)`);
        // Distant markers dim, but never out — see the floors above.
        const curve = clamp01(1.15 - this._pd[i] / 260);
        const fade = Math.max(edge ? CHEVRON_FLOOR : FADE_FLOOR, curve);
        setStyle(node, 'opacity', fade.toFixed(3));
      }
    }
    for (let i = n; i < items.length; i++) {
      if (items[i].alive) {
        items[i].alive = false;
        setStyle(items[i].node, 'display', 'none');
      }
    }
  }

  /** @param {number} fuse seconds until detonation */
  spawnGrenade(position, fuse = 2.4) {
    const it = this.nadePool.acquire();
    it.life = fuse;
    it.node._pos.copy(position);
    return it;
  }

  updateGrenades(dt, camera, w, h, k) {
    const items = this.nadePool.items;
    const margin = 56 * k;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.alive) continue;
      it.t += dt;
      if (it.t >= it.life) {
        this.nadePool.release(it);
        continue;
      }
      const node = it.node;
      const p = project(node._pos, camera, w, h, margin);
      setStyle(node, 'transform', `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`);
      const close = p.dist < 9;
      setText(node._label, close ? 'DANGER CLOSE' : 'GRENADE');
      // pulse rate ramps as the fuse burns down
      const remain = 1 - it.t / it.life;
      const rate = 2.2 + (1 - remain) * 5;
      const ph = (it.t * rate) % 1;
      const rs = 0.7 + 0.9 * ease.outCubic(ph);
      setStyle(node._ring, 'transform', `scale(${rs.toFixed(3)})`);
      setStyle(node._ring, 'opacity', (0.9 * (1 - ph)).toFixed(3));
      setStyle(node, 'opacity', clamp01(remain * 4).toFixed(3));
    }
  }

  /** @param {'hit'|'hs'|'kill'|'armour'} kind */
  spawnDamage(position, amount, kind = 'hit') {
    const it = this.dnPool.acquire();
    it.life = kind === 'kill' ? 1.25 : 0.95;
    it.node._pos.copy(position);
    it.a = this.rng.signed() * 16; // lateral drift
    it.b = 0.9 + this.rng.float() * 0.25;
    setText(it.node, Math.round(amount));
    setClass(it.node, 'hs', kind === 'hs');
    setClass(it.node, 'kill', kind === 'kill');
    setClass(it.node, 'armour', kind === 'armour');
    return it;
  }

  updateDamage(dt, camera, w, h, k) {
    const items = this.dnPool.items;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.alive) continue;
      it.t += dt;
      const u = it.t / it.life;
      if (u >= 1) {
        this.dnPool.release(it);
        continue;
      }
      const node = it.node;
      const p = project(node._pos, camera, w, h, 0);
      if (p.behind) {
        setStyle(node, 'opacity', '0');
        continue;
      }
      const rise = ease.outCubic(clamp01(u * 1.15)) * 42 * k * it.b;
      const drift = it.a * k * ease.outQuad(u);
      const pop = 1 + 0.35 * (1 - ease.outQuint(clamp01(u / 0.12)));
      setStyle(
        node,
        'transform',
        `translate(${(p.x + drift).toFixed(1)}px,${(p.y - rise).toFixed(1)}px) translate(-50%,-50%) scale(${pop.toFixed(3)})`
      );
      const a = u < 0.55 ? 1 : 1 - ease.inQuad((u - 0.55) / 0.45);
      setStyle(node, 'opacity', (a * clamp01(2.6 - p.dist / 90)).toFixed(3));
    }
  }

  clear() {
    this.nadePool.releaseAll();
    this.dnPool.releaseAll();
  }

  dispose() {
    this.objRoot.remove();
  }
}
