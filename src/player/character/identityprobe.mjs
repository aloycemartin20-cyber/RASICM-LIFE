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
 *   4 ELBOW       the arm HINGES THE WAY AN ARM DOES, on all three builds. See
 *                 the block above the gate.
 *
 * NEGATIVE CONTROL, mandatory: `build.noIdentity` removes every per-brother
 * facial and wardrobe choice — this module's identity table AND brothers.js's
 * own jaw/brow/nose scalars — leaving three bodies of different SIZE and
 * nothing else. Gate 1's separation must go to zero and gate 3's spread must
 * collapse, or the probe is reading the size difference it was told to divide
 * out rather than the identity it claims to measure.
 *
 * Gate 4 carries its OWN control, `build.legacyElbow`, because it is not an
 * identity measurement and `noIdentity` says nothing about it.
 *
 *   node src/player/character/identityprobe.mjs
 *   node src/player/character/identityprobe.mjs --grid=40
 *   node src/player/character/identityprobe.mjs --legacyelbow  # control, red
 */
import * as THREE from 'three';
import { buildBody, buildCharacter, MAT } from './mesh.js';
import { Animator } from '../anim/animator.js';
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

/* ---------------------------------------------------------------------- */
/* 4 ELBOW                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * "CARSON'S ARMS ARE BENT THE WRONG WAY (SEEMS CONTORTED)" — the owner, playing.
 *
 * An elbow is the ANTI-KNEE: a knee's middle joint sits in FRONT of the
 * root->end chord, an elbow's sits BEHIND it, and that offset is the only thing
 * that tells a viewer which way a nearly-straight limb hinges. `mesh.js`'s arm
 * chain was authored with the LEG's signs — MEASURED on the shipped table, the
 * elbow sat 15.0 mm in FRONT of its own chord, hyperextended, while the ped rig
 * next door (`src/peds/rig.js`) has the same joint 10.6 mm behind it.
 *
 * Three things are asserted, and none of them is a number this probe also
 * supplies (ARCHITECTURE.md rule 12): the geometry is read off the EMITTED
 * skeleton, and the posed angles come from driving the real `Animator`.
 *
 *   4a SIGN         the bind elbow is posterior to the shoulder->wrist chord,
 *                   and the bind pose therefore carries FLEXION, not extension.
 *   4b BUILD-INVARIANT  the elbow's axis is the same on all three brothers.
 *                   `bindPositions` used to scale every arm bone's absolute x
 *                   by `build.shoulder`, which scaled the lateral drift BETWEEN
 *                   shoulder, elbow and wrist too — so the broadest brother's
 *                   hinge sat at a different angle from the leanest's (5.50 vs
 *                   4.66 degrees out of vertical) and the bulk deltas sheared
 *                   the very axis the elbow turns about.
 *   4c POSED SIGN   driving the real animator through the core states, every
 *                   elbow on every brother flexes POSITIVE about the hinge the
 *                   FK path turns it on — no state ever drives it through
 *                   straight into hyperextension — and carson matches his
 *                   brothers, who are the controls.
 *
 * NEGATIVE CONTROL: `build.legacyElbow` restores the leg-shaped bow AND the old
 * x scaling. 4a must go NEGATIVE and 4b must blow out, or this gate is reading
 * something other than the fix.
 */

/** Bind elbow offset from the chord, mm of the reference body. + = posterior. */
const ELBOW_DEV_MIN = 6.0;
/** Bind flexion the arm hangs with, degrees. + = flexed. */
const ELBOW_FLEX_MIN = 3.0;
/** How far the three builds' arm axes may disagree, degrees. */
const AXIS_SPREAD_MAX = 0.05;
/** Floor on the posed elbow angle. Anything <= 0 is a reversed hinge. */
const POSED_FLEX_MIN = 2.0;
/** How far carson may differ from his brothers in any posed state, degrees. */
const BROTHER_MATCH_MAX = 1.0;

/** The states the player is in for essentially all of his screen time. */
const CORE_STATES = {
  idle: {},
  walk: { speed: 1.72 },
  run: { speed: 6.4 },
  drive: { driving: true },
};

const fakeCtx = { peek: () => null, get: () => null, config: { q: {} } };

function poseState(over) {
  return {
    x: 0, y: 0, z: 0, faceYaw: 0, aimYaw: 0, aimPitch: 0,
    speed: 0, grounded: true, crouch: false, aim: 0, swim: false, driving: false,
    stumble: 0, turning: 0, strafe: 0, forwardSign: 1, verticalVel: 0,
    landImpulse: 0, steer: 0, lateral: 0, surface: 'concrete', groundDist: 0,
    swing: 0, swingSide: 1, swingWeight: 0, submerged: 0, dead: 0, guard: 0,
    topSpeed: 6, sprinting: false, ...over,
  };
}

/**
 * Bind-pose elbow geometry from the EMITTED skeleton. Bind space is +Y up,
 * -Z forward, +X the character's right, so POSTERIOR is +z.
 */
function elbowBind(build) {
  const { skeleton } = buildBody(build);
  const P = skeleton.positions;
  const S = build.scale ?? 1;
  const sh = P.armR, el = P.forearmR, wr = P.handR;
  // Where the chord shoulder->wrist is at the elbow's height.
  const t = (sh[1] - el[1]) / (sh[1] - wr[1]);
  const chordZ = sh[2] + (wr[2] - sh[2]) * t;
  const deg = (a, b) => [
    Math.atan2(b[0] - a[0], a[1] - b[1]) * 180 / Math.PI,   // frontal, + outward
    Math.atan2(a[2] - b[2], a[1] - b[1]) * 180 / Math.PI,   // sagittal, + forward
  ];
  const [uF, uS] = deg(sh, el);
  const [fF, fS] = deg(el, wr);
  return { dev: ((el[2] - chordZ) / S) * 1000, flex: fS - uS, upperFrontal: uF, foreFrontal: fF };
}

/**
 * Signed elbow flexion of the POSED skeleton, degrees, about the upper arm's
 * own world +X — which is the axis the FK path actually turns the forearm on,
 * so a positive reading is flexion and a negative one is a reversed hinge.
 */
function elbowPosed(spec, extra) {
  const mats = new Array(8).fill(0).map(() => new THREE.MeshBasicMaterial());
  const built = buildCharacter({ ...spec.build, id: spec.id, ...extra }, mats);
  const rig = {
    root: built.root, mesh: built.mesh, skeleton: built.skeleton,
    bones: built.bones, geometry: built.geometry,
    bindPositions: built.bindPositions, scale: spec.build.scale ?? 1, side: 1,
  };
  const wp = (b) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  const out = {};
  for (const [name, over] of Object.entries(CORE_STATES)) {
    // A fresh animator per state: the smoothed channels must settle INTO the
    // state being measured, not out of the previous one.
    const an = new Animator(fakeCtx, rig);
    const s = poseState(over);
    for (let f = 0; f < 200; f++) an.update(1 / 60, s);
    rig.root.updateMatrixWorld(true);
    out[name] = ['R', 'L'].map((sfx) => {
      const a = wp(rig.bones['arm' + sfx]);
      const e = wp(rig.bones['forearm' + sfx]);
      const h = wp(rig.bones['hand' + sfx]);
      const u = e.clone().sub(a).normalize();
      const f = h.clone().sub(e).normalize();
      const m = rig.bones['arm' + sfx].matrixWorld.elements;
      const axis = new THREE.Vector3(m[0], m[1], m[2]).normalize();
      const c = new THREE.Vector3().crossVectors(u, f);
      return Math.atan2(c.dot(axis), u.dot(f)) * 180 / Math.PI;
    });
  }
  return out;
}

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

/* ---- 4 ELBOW ---- */
console.log('\n=== 4 ELBOW — an elbow is the anti-knee ===');
{
  // `--legacyelbow` shoots the whole gate through the control, so the red run
  // can be read line by line instead of only as a verdict.
  const extra = args.legacyelbow ? { legacyElbow: true } : {};
  const bind = {};
  const posed = {};
  for (const id of IDS) {
    bind[id] = elbowBind({ ...BROTHERS[id].build, id, ...extra });
    posed[id] = elbowPosed(BROTHERS[id], extra);
  }

  /* 4a sign */
  let ok = true;
  for (const id of IDS) {
    const b = bind[id];
    const good = b.dev >= ELBOW_DEV_MIN && b.flex >= ELBOW_FLEX_MIN;
    if (!good) ok = false;
    console.log(`  ${good ? 'ok  ' : 'FAIL'} ${id.padEnd(7)} bind elbow ${b.dev >= 0 ? 'BEHIND' : 'IN FRONT OF'} the chord by ` +
      `${Math.abs(b.dev).toFixed(1)} mm, bind flexion ${b.flex.toFixed(2)} deg  ` +
      `(want >= ${ELBOW_DEV_MIN} mm and >= ${ELBOW_FLEX_MIN} deg)`);
  }
  if (!ok) failures++;

  /* 4b build-invariance of the axis */
  {
    const spreadOf = (k) => Math.max(...IDS.map((i) => bind[i][k])) - Math.min(...IDS.map((i) => bind[i][k]));
    const up = spreadOf('upperFrontal'), fo = spreadOf('foreFrontal');
    const good = up <= AXIS_SPREAD_MAX && fo <= AXIS_SPREAD_MAX;
    if (!good) failures++;
    console.log(`  ${good ? 'ok  ' : 'FAIL'} the three builds' arm axes agree: upper arm spread ${up.toFixed(3)} deg, ` +
      `forearm ${fo.toFixed(3)} deg  (want <= ${AXIS_SPREAD_MAX})`);
  }

  /* 4c posed sign, and carson against his brothers */
  {
    let worst = Infinity, worstWhere = '', gap = 0, gapWhere = '';
    for (const st of Object.keys(CORE_STATES)) {
      for (let i = 0; i < 2; i++) {
        for (const id of IDS) {
          const v = posed[id][st][i];
          if (v < worst) { worst = v; worstWhere = `${id} ${st} ${i ? 'L' : 'R'}`; }
        }
        for (const id of ['aidan', 'dylan']) {
          const d = Math.abs(posed.carson[st][i] - posed[id][st][i]);
          if (d > gap) { gap = d; gapWhere = `${st} ${i ? 'L' : 'R'} vs ${id}`; }
        }
      }
      console.log(`     ${st.padEnd(6)} ` + IDS.map((id) =>
        `${id.slice(0, 3)} ${posed[id][st].map((v) => v.toFixed(1).padStart(6)).join('/')}`).join('  '));
    }
    const signOk = worst >= POSED_FLEX_MIN;
    const matchOk = gap <= BROTHER_MATCH_MAX;
    if (!signOk || !matchOk) failures++;
    console.log(`  ${signOk ? 'ok  ' : 'FAIL'} every posed elbow flexes positive: worst ${worst.toFixed(1)} deg at ${worstWhere}  (want >= ${POSED_FLEX_MIN})`);
    console.log(`  ${matchOk ? 'ok  ' : 'FAIL'} carson matches his brothers to ${gap.toFixed(2)} deg (${gapWhere})  (want <= ${BROTHER_MATCH_MAX})`);
  }

  /* control */
  const ctrlBind = IDS.map((id) => elbowBind({ ...BROTHERS[id].build, id, legacyElbow: true }));
  const flipped = ctrlBind.every((b) => b.dev < 0 && b.flex < 0);
  const sheared = (Math.max(...ctrlBind.map((b) => b.upperFrontal)) -
    Math.min(...ctrlBind.map((b) => b.upperFrontal))) > AXIS_SPREAD_MAX;
  if (!(flipped && sheared)) failures++;
  console.log(`  ${flipped && sheared ? 'ok  ' : 'FAIL'} control build.legacyElbow: elbow dev ` +
    `${ctrlBind.map((b) => b.dev.toFixed(1)).join(' / ')} mm, flexion ` +
    `${ctrlBind.map((b) => b.flex.toFixed(2)).join(' / ')} deg, axis spread ` +
    `${(Math.max(...ctrlBind.map((b) => b.upperFrontal)) - Math.min(...ctrlBind.map((b) => b.upperFrontal))).toFixed(3)} deg` +
    `  (want all negative, and the spread over ${AXIS_SPREAD_MAX})`);
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
