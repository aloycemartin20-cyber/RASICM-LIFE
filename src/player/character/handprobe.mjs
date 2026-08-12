#!/usr/bin/env node
/**
 * HAND GATE — the mechanical answer to "does he have fingers?".
 *
 * The player holds a weapon on screen for the entire game, so the hand is the
 * second-most photographed 4 cm of the project after the face, and a review
 * called it a T-ish fist. This measures the EMITTED geometry, not the code that
 * emits it: it slices the hand with a horizontal plane through the middle
 * phalanges, projects every skin triangle's intersection with that plane into
 * (x, z), and clusters the resulting points. A hand with digits produces one
 * island per digit. A mitten produces one island.
 *
 * WHY A SLICE AND NOT A COMPONENT COUNT. Counting connected components of the
 * index buffer would count TUBE EMISSIONS — it would pass on four rods buried
 * inside a solid palm block, and it would fail on a hand modelled as one
 * surface. A cross-section is what a camera sees: two digits that touch are one
 * island, and that is the correct answer, because on screen they are one shape.
 *
 * NEGATIVE CONTROL, run every time: `build.mittHands` restores the pre-fix
 * hand — one tapered tube plus a thumb — and the island count must collapse.
 *
 *   node src/player/character/handprobe.mjs
 *   node src/player/character/handprobe.mjs --dump   # + the slice as ASCII
 */
import { buildBody, MAT } from './mesh.js';
import { BROTHERS } from '../brothers.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/**
 * FOUR, not five. The slice sits below the thumb — a thumb opposes the palm
 * and ends above the middle phalanges, which is the whole point of a thumb —
 * so the finger row is what crosses this plane. The thumb is asserted
 * separately, by reach.
 */
const WANT_DIGITS = 4;
/** The control must fall to at most this, or the slice is not measuring. */
const CONTROL_MAX = 1;
/**
 * How far the hand must reach off its own wrist -> fingertip axis in the band
 * BETWEEN the wrist and the knuckles, metres. Only the palm and the thumb live
 * in that band, and the palm alone is 42 mm of it — so 48 mm is a floor a hand
 * can only clear with a thumb standing off the side of it.
 */
const THUMB_REACH = 0.048;
/**
 * Two islands are the same island if any pair of their points is closer than
 * this, in metres.
 *
 * THIS IS WHY THE SLICE IS RESAMPLED. A finger is a 7-sided tube, so the raw
 * plane-edge intersections along it are ~7 mm apart while the GAP between two
 * adjacent relaxed fingers is 4.6 mm — a merge radius that holds a finger
 * together at the raw sampling would bridge straight across its neighbour, and
 * the first run of this probe read 18 islands per hand for exactly that reason.
 * Every intersection segment is resampled at 0.8 mm, so within a digit the
 * spacing is 0.8 mm and between digits it is 3.5 or more, and 2 mm separates
 * them with margin at both ends.
 */
const MERGE = 0.0020;
/** Resample spacing along each intersection segment, metres. */
const STEP = 0.0008;

/** Where to slice, as a fraction of wrist -> fingertip below the wrist. */
const SLICE_AT = 0.74;

/** Segment of triangle (a,b,c) at plane y = py, appended to `pts`. */
function slice(pts, ax, ay, az, bx, by, bz, cx, cy, cz, py) {
  const P = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
  for (let i = 0; i < 3; i++) {
    const p = P[i], q = P[(i + 1) % 3];
    if ((p[1] - py) * (q[1] - py) > 0) continue;
    const d = q[1] - p[1];
    if (Math.abs(d) < 1e-12) continue;
    const t = (py - p[1]) / d;
    if (t < 0 || t > 1) continue;
    pts.push([p[0] + (q[0] - p[0]) * t, p[2] + (q[2] - p[2]) * t]);
  }
  // Resample the chord between the two crossings, so the point spacing is set
  // by STEP and not by the tube's radial count.
  if (pts.length >= 2) {
    const b = pts[pts.length - 1], a = pts[pts.length - 2];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(len / STEP);
    for (let i = 1; i < n; i++) {
      const t = i / n;
      pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
}

/** Single-link clustering with a `MERGE` radius. Returns cluster sizes. */
function cluster(pts, merge) {
  const n = pts.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const m2 = merge * merge;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = pts[i][0] - pts[j][0], dz = pts[i][1] - pts[j][1];
      if (dx * dx + dz * dz > m2) continue;
      const a = find(i), b = find(j);
      if (a !== b) parent[a] = b;
    }
  }
  const sizes = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    sizes.set(r, (sizes.get(r) ?? 0) + 1);
  }
  return [...sizes.values()];
}

function measure(id, mitt) {
  const build = mitt ? { ...BROTHERS[id].build, mittHands: true } : BROTHERS[id].build;
  const { geometry, skeleton } = buildBody(build);
  const P = skeleton.positions;
  const out = {};
  for (const side of ['R', 'L']) {
    const wr = P['hand' + side], he = P['handEnd' + side];
    const py = wr[1] + (he[1] - wr[1]) * SLICE_AT;
    // Only geometry belonging to this hand: everything else at that height is
    // the far arm, the trouser or nothing.
    const R = 0.11 * (build.scale ?? 1);
    const pos = geometry.attributes.position.array;
    const idx = geometry.index.array;
    const pts = [];
    for (const g of geometry.groups) {
      if (g.materialIndex !== MAT.skin) continue;
      for (let i = g.start; i < g.start + g.count; i += 3) {
        const a = idx[i] * 3, b = idx[i + 1] * 3, k = idx[i + 2] * 3;
        let near = false;
        for (const o of [a, b, k]) {
          const dx = pos[o] - wr[0], dy = pos[o + 1] - wr[1], dz = pos[o + 2] - wr[2];
          if (dx * dx + dy * dy + dz * dz <= R * R) { near = true; break; }
        }
        if (!near) continue;
        slice(pts,
          pos[a], pos[a + 1], pos[a + 2],
          pos[b], pos[b + 1], pos[b + 2],
          pos[k], pos[k + 1], pos[k + 2], py);
      }
    }
    // The thumb, measured by REACH rather than by the slice: it opposes the
    // palm and ends above the finger row, so it never crosses that plane. Max
    // perpendicular distance from the wrist -> fingertip axis, over the band
    // the thumb occupies. This is a guard, not a discriminator — the pre-fix
    // hand had a thumb too — but a hand that loses it should not pass.
    const axis = [he[0] - wr[0], he[1] - wr[1], he[2] - wr[2]];
    const alen = Math.hypot(axis[0], axis[1], axis[2]);
    for (let k = 0; k < 3; k++) axis[k] /= alen;
    let thumb = 0;
    const seen = new Set();
    for (const g of geometry.groups) {
      if (g.materialIndex !== MAT.skin) continue;
      for (let i = g.start; i < g.start + g.count; i++) {
        const v = idx[i];
        if (seen.has(v)) continue;
        seen.add(v);
        const dx = pos[v * 3] - wr[0], dy = pos[v * 3 + 1] - wr[1], dz = pos[v * 3 + 2] - wr[2];
        if (dx * dx + dy * dy + dz * dz > R * R) continue; // this hand only
        const t = dx * axis[0] + dy * axis[1] + dz * axis[2];
        if (t < 0.20 * alen || t > 0.50 * alen) continue;
        const px = dx - t * axis[0], py2 = dy - t * axis[1], pz = dz - t * axis[2];
        thumb = Math.max(thumb, Math.hypot(px, py2, pz));
      }
    }

    const sizes = cluster(pts, MERGE * (build.scale ?? 1));
    // Drop specks: a cluster of one or two points is a triangle grazing the
    // plane, not a digit.
    const digits = sizes.filter((s) => s >= 4);
    out[side] = { digits: digits.length, points: pts.length, pts, py, thumb };
  }
  return out;
}

function ascii(pts) {
  const ROWS = 15, COLS = 46;
  const g = Array.from({ length: ROWS }, () => new Array(COLS).fill(' '));
  let x0 = 9, x1 = -9, z0 = 9, z1 = -9;
  for (const p of pts) {
    x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
    z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]);
  }
  for (const p of pts) {
    const c = Math.min(COLS - 1, Math.max(0, Math.round(((p[1] - z0) / (z1 - z0 || 1)) * (COLS - 1))));
    const r = Math.min(ROWS - 1, Math.max(0, Math.round(((p[0] - x0) / (x1 - x0 || 1)) * (ROWS - 1))));
    g[r][c] = '#';
  }
  return g.map((r) => '    ' + r.join('')).join('\n');
}

let failures = 0;
console.log(`hand digits — slice at ${SLICE_AT} wrist->fingertip, ${MERGE * 1000} mm merge radius`);
for (const id of ['carson', 'aidan', 'dylan']) {
  const r = measure(id, false);
  const S = BROTHERS[id].build.scale ?? 1;
  const bad = ['R', 'L'].filter((s) => r[s].digits < WANT_DIGITS);
  const noThumb = ['R', 'L'].filter((s) => r[s].thumb < THUMB_REACH * S);
  if (bad.length || noThumb.length) failures++;
  console.log(`\n=== ${id} ===`);
  console.log(`  islands in the palm cross-section: R ${r.R.digits}  L ${r.L.digits}  (want >= ${WANT_DIGITS} each)`);
  console.log(`  thumb reach off the palm axis    : R ${(r.R.thumb * 1000).toFixed(1)} mm  L ${(r.L.thumb * 1000).toFixed(1)} mm  (want >= ${(THUMB_REACH * S * 1000).toFixed(1)})`);
  console.log(`  slice points: R ${r.R.points}  L ${r.L.points}`);
  console.log(bad.length ? `  FAIL: ${bad.join('/')} hand is a mitten`
    : noThumb.length ? `  FAIL: ${noThumb.join('/')} hand has no opposed thumb` : '  PASS');
  if (args.dump) console.log(ascii(r.R.pts));
}

/* ---- negative control ---- */
{
  const r = measure('aidan', true);
  const ok = r.R.digits <= CONTROL_MAX && r.L.digits <= CONTROL_MAX;
  if (!ok) failures++;
  console.log('\n=== negative control (aidan, build.mittHands) ===');
  console.log(`  islands with the pre-fix hand: R ${r.R.digits}  L ${r.L.digits}  (want <= ${CONTROL_MAX})`);
  console.log(ok
    ? '  PASS (the slice separates digits; it is not just counting geometry)'
    : '  FAIL: control did not collapse — the slice is not measuring digits');
}

console.log(`\n${failures ? `FAIL (${failures} check${failures > 1 ? 's' : ''})` : 'PASS (3/3 brothers, control red)'}`);
process.exit(failures ? 1 : 0);
