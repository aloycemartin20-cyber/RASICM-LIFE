#!/usr/bin/env node
/**
 * IDENTITY GATE — the mechanical answer to "can you tell which brother that
 * is?", asked of the geometry rather than of the palette.
 *
 * A review scored the character as one man in three colours. Colour is the one
 * thing this probe deliberately cannot see: everything below is measured on the
 * emitted, UNTEXTURED surface, so a change that only recolours the brothers
 * moves none of these numbers.
 *
 *   1 FACE        the three faces are different SHAPES. A depth map of the
 *                 front of each skull is sampled in head-local units — i.e.
 *                 after dividing out `headScale` and `scale`, so "the same
 *                 face, bigger" scores zero — and the pairwise RMS is the
 *                 separation, in millimetres of a 1.78 m reference body.
 *   2 SILHOUETTE  the three BUILDS read apart at a glance: shoulder span,
 *                 chest depth and stature, with carson the broadest and dylan
 *                 the leanest by a stated margin. This is the 20 m read.
 *   3 WARDROBE    the three OUTFITS are different garments, measured as how
 *                 far down the arm the shirt material reaches — carson's
 *                 sleeve is rolled below the elbow, aidan's stops on the
 *                 bicep, dylan's runs to the wrist — and as the fraction of
 *                 each arm that is left bare.
 *
 * NEGATIVE CONTROL, mandatory: `build.noIdentity` removes every per-brother
 * facial and wardrobe choice — this module's identity table AND brothers.js's
 * own jaw/brow/nose scalars — leaving three bodies of different SIZE and
 * nothing else. Gate 1's separation must go to zero and gate 3's spread must
 * collapse, or the probe is reading the size difference it was told to divide
 * out rather than the identity it claims to measure.
 *
 *   node src/player/character/identityprobe.mjs
 *   node src/player/character/identityprobe.mjs --grid=40
 */
import { buildBody, MAT } from './mesh.js';
import { BROTHERS } from '../brothers.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const GRID = Number(args.grid ?? 34);
const IDS = ['carson', 'aidan', 'dylan'];
const PAIRS = [['carson', 'aidan'], ['aidan', 'dylan'], ['carson', 'dylan']];

/**
 * How far apart two faces have to be, RMS over the sampled front of the skull,
 * in millimetres of a 1.78 m body.
 *
 * 1.5 mm sounds small and is not: it is an RMS over the WHOLE sampled face,
 * most of which — forehead, upper cheek, the sides of the skull — is identical
 * between brothers by construction, so the features that do differ carry the
 * whole number alone. MEASURED with the identity block in place: carson/aidan
 * 3.95, aidan/dylan 3.39, carson/dylan 6.51 mm. With `noIdentity` every pair is
 * 0.00, because that control removes brothers.js's jaw/brow/nose as well and
 * the three heads become one head at three sizes — which the head-local
 * normalisation then divides out exactly.
 *
 * An earlier draft of the identity table scored aidan/dylan at 2.04 against a
 * 2.00 residual from the build scalars alone: the table was adding almost
 * nothing between the two younger brothers. That is what moved aidan's alae,
 * cheek, deep-set eyes and gonial flare up and dylan's to near zero.
 */
const FACE_MIN = 1.5;
/**
 * The control must fall to under this fraction of the live separation. It can
 * be this brutal because `build.noIdentity` removes brothers.js's jaw/brow/nose
 * scalars as well as this module's table: with no facial authoring of any kind
 * the three heads are the same shape at three sizes, and the size is divided
 * out, so the residual is quantisation and nothing else.
 */
const FACE_CONTROL_MAX = 0.06;

/** Shoulder span margins, as a fraction. Carson broadest, dylan leanest. */
const SPAN_MARGIN = 0.06;

function rayTri(ox, oy, oz, dx, dy, dz, t) {
  const e1x = t[3] - t[0], e1y = t[4] - t[1], e1z = t[5] - t[2];
  const e2x = t[6] - t[0], e2y = t[7] - t[1], e2z = t[8] - t[2];
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-12 && det < 1e-12) return -1;
  const inv = 1 / det, tx = ox - t[0], ty = oy - t[1], tz = oz - t[2];
  const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv; if (v < 0 || u + v > 1) return -1;
  const d = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return d > 1e-6 ? d : -1;
}

/**
 * Depth map of the front of one skull, in head-local units: for a grid of
 * (x, y) it returns the nearest z of the face surface, or NaN where the ray
 * misses. Dividing by `hs` is what makes this a shape comparison and not a
 * size comparison.
 */
function faceDepth(build) {
  const { geometry, skeleton } = buildBody(build);
  const S = build.scale ?? 1;
  const hs = (build.headScale ?? 1) * S;
  const hb = skeleton.positions.head;
  const c = [hb[0], hb[1] + 0.096 * hs, hb[2] + 0.004 * hs];
  const pos = geometry.attributes.position.array;
  const idx = geometry.index.array;
  const tris = [];
  for (const g of geometry.groups) {
    if (g.materialIndex !== MAT.face) continue;
    for (let i = g.start; i < g.start + g.count; i += 3) {
      const a = idx[i] * 3, b = idx[i + 1] * 3, k = idx[i + 2] * 3;
      tris.push([
        pos[a], pos[a + 1], pos[a + 2],
        pos[b], pos[b + 1], pos[b + 2],
        pos[k], pos[k + 1], pos[k + 2],
      ]);
    }
  }
  const out = new Float64Array(GRID * GRID).fill(NaN);
  for (let j = 0; j < GRID; j++) {
    // y from the brow down past the chin; x across the face but inboard of the
    // ears, which are separate tubes and not part of the shape being compared.
    const ly = 0.052 - (j / (GRID - 1)) * 0.150;
    for (let i = 0; i < GRID; i++) {
      const lx = -0.050 + (i / (GRID - 1)) * 0.100;
      const ox = c[0] + lx * hs, oy = c[1] + ly * hs, oz = c[2] - 0.30 * hs;
      let best = Infinity;
      for (const t of tris) {
        const d = rayTri(ox, oy, oz, 0, 0, 1, t);
        if (d >= 0 && d < best) best = d;
      }
      if (best < Infinity) out[j * GRID + i] = (oz + best - c[2]) / hs;
    }
  }
  return out;
}

/** RMS difference between two depth maps, in mm of the reference body. */
function faceRms(a, b) {
  let n = 0, s = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    const d = (a[i] - b[i]) * 1000;
    s += d * d;
    n++;
  }
  return n ? Math.sqrt(s / n) : 0;
}

/** Silhouette measurements from the emitted hull, metres. */
function silhouette(build) {
  const { geometry, skeleton } = buildBody(build);
  const P = skeleton.positions;
  const pos = geometry.attributes.position.array;
  const shY = P.armR[1], chY = P.chest[1];
  let span = 0, depth = 0, top = -9, bottom = 9;
  const n = geometry.attributes.position.count;
  for (let v = 0; v < n; v++) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    top = Math.max(top, y);
    bottom = Math.min(bottom, y);
    if (Math.abs(y - shY) < 0.045) span = Math.max(span, Math.abs(x) * 2);
    if (Math.abs(y - chY) < 0.030 && Math.abs(x) < 0.06) depth = Math.max(depth, -z);
  }
  return { span, depth, height: top - bottom };
}

/**
 * Where the shirt stops on the arm, as a fraction of shoulder -> wrist.
 *
 * READ FROM THE OUTSIDE IN, because the naive version does not work. Selecting
 * "shirt vertices near the arm axis" also selects the TORSO: the arm axis runs
 * 190 mm out from the centre line and the torso's own surface reaches 160 mm,
 * so the chest is within 60 mm of the arm at every height and the first run of
 * this probe reported all three sleeves ending at 102% of the arm. So instead:
 * bin the arm by t, and in each bin ask which material owns the OUTERMOST
 * vertex. The torso is always inboard of the arm's own surface, so it can never
 * win a bin, and the answer — sleeve or skin — is also literally what a camera
 * outboard of the arm sees.
 */
function sleeve(build) {
  const { geometry, skeleton } = buildBody(build);
  const P = skeleton.positions;
  const pos = geometry.attributes.position.array;
  const idx = geometry.index.array;
  const sh = P.armR, wr = P.handR;
  const ax = [wr[0] - sh[0], wr[1] - sh[1], wr[2] - sh[2]];
  const len = Math.hypot(ax[0], ax[1], ax[2]);
  for (let k = 0; k < 3; k++) ax[k] /= len;
  // 21 bins, one per 4.8% of the arm. AT 42 THE READING IS NOISE: a bin is
  // then narrower than the spacing between rings on the sleeve, so a bin can
  // contain a skin vertex and no sleeve vertex and be scored bare in the
  // middle of a covered sleeve. Measured at 42: aidan alternated
  // shirt/skin/shirt/skin from bin 14 to bin 41.
  const BINS = 21;
  const NEG = -Infinity;
  const shirtX = new Float64Array(BINS).fill(NEG);
  const skinX = new Float64Array(BINS).fill(NEG);
  const seen = new Set();
  for (const g of geometry.groups) {
    if (g.materialIndex !== MAT.shirt && g.materialIndex !== MAT.skin) continue;
    const dst = g.materialIndex === MAT.shirt ? shirtX : skinX;
    for (let i = g.start; i < g.start + g.count; i++) {
      const v = idx[i];
      if (seen.has(v)) continue;
      seen.add(v);
      const dx = pos[v * 3] - sh[0], dy = pos[v * 3 + 1] - sh[1], dz = pos[v * 3 + 2] - sh[2];
      const t = (dx * ax[0] + dy * ax[1] + dz * ax[2]) / len;
      if (t < 0 || t >= 1) continue;
      const b = Math.min(BINS - 1, Math.floor(t * BINS));
      const x = pos[v * 3];
      if (x > dst[b]) dst[b] = x;
    }
  }
  // The hem is the last bin, counting out from the shoulder, whose outermost
  // surface is still fabric.
  let hem = 0, covered = 0;
  for (let b = 0; b < BINS; b++) {
    if (!(shirtX[b] > skinX[b])) break;
    hem = (b + 1) / BINS;
    covered++;
  }
  return { hem, bare: Math.max(0, 1 - covered / BINS) };
}

function run(noIdentity) {
  const face = {}, sil = {}, slv = {};
  for (const id of IDS) {
    const build = noIdentity ? { ...BROTHERS[id].build, noIdentity: true } : BROTHERS[id].build;
    face[id] = faceDepth(build);
    sil[id] = silhouette(build);
    slv[id] = sleeve(build);
  }
  const rms = PAIRS.map(([a, b]) => [`${a}/${b}`, faceRms(face[a], face[b])]);
  return { rms, sil, slv };
}

let failures = 0;
const live = run(false);
const ctrl = run(true);

/* ---- 1 FACE ---- */
console.log(`=== 1 FACE — pairwise shape separation, ${GRID}x${GRID} depth map, head-local ===`);
for (const [name, v] of live.rms) {
  const ok = v >= FACE_MIN;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(15)} ${v.toFixed(2)} mm RMS  (want >= ${FACE_MIN})`);
}

/* ---- 2 SILHOUETTE ---- */
console.log('\n=== 2 SILHOUETTE — the 20 m read ===');
for (const id of IDS) {
  const s = live.sil[id];
  console.log(`  ${id.padEnd(7)} shoulder span ${(s.span * 100).toFixed(1)} cm   chest depth ${(s.depth * 100).toFixed(1)} cm   height ${(s.height * 100).toFixed(1)} cm`);
}
{
  const c = live.sil.carson.span, a = live.sil.aidan.span, d = live.sil.dylan.span;
  const broadest = c / a - 1, leanest = a / d - 1;
  const ok = broadest >= SPAN_MARGIN && leanest >= SPAN_MARGIN;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} carson is ${(broadest * 100).toFixed(1)}% broader than aidan, aidan ${(leanest * 100).toFixed(1)}% broader than dylan  (want >= ${SPAN_MARGIN * 100}% each)`);
}

/* ---- 3 WARDROBE ---- */
console.log('\n=== 3 WARDROBE — where the sleeve stops, shoulder -> wrist ===');
for (const id of IDS) {
  const s = live.slv[id];
  console.log(`  ${id.padEnd(7)} hem at ${(s.hem * 100).toFixed(1)}% of the arm, ${(s.bare * 100).toFixed(1)}% bare`);
}
{
  const hems = IDS.map((id) => live.slv[id].hem).sort((x, y) => x - y);
  const gaps = [hems[1] - hems[0], hems[2] - hems[1]];
  const ok = gaps.every((g) => g >= 0.12);
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} sleeve lengths separated by ${gaps.map((g) => (g * 100).toFixed(1) + '%').join(' and ')}  (want >= 12% each)`);
}

/* ---- negative control ---- */
console.log('\n=== negative control: build.noIdentity (one face, one garment) ===');
{
  let ok = true;
  for (let i = 0; i < live.rms.length; i++) {
    const ratio = ctrl.rms[i][1] / (live.rms[i][1] || 1);
    if (ratio > FACE_CONTROL_MAX) ok = false;
    console.log(`  face ${live.rms[i][0].padEnd(15)} ${live.rms[i][1].toFixed(2)} -> ${ctrl.rms[i][1].toFixed(2)} mm  (${(ratio * 100).toFixed(0)}% of live, want <= ${FACE_CONTROL_MAX * 100}%)`);
  }
  const hems = IDS.map((id) => ctrl.slv[id].hem);
  const spread = Math.max(...hems) - Math.min(...hems);
  if (spread > 0.02) ok = false;
  console.log(`  sleeve spread collapses to ${(spread * 100).toFixed(1)}%  (want <= 2%)`);
  if (!ok) failures++;
  console.log(ok
    ? '  PASS (the separation comes from the identity table, not from the size difference)'
    : '  FAIL: control did not collapse — this probe is reading build scale, not identity');
}

console.log(`\n${failures ? `FAIL (${failures} check${failures > 1 ? 's' : ''})` : 'PASS'}`);
process.exit(failures ? 1 : 0);
