#!/usr/bin/env node
/**
 * GROUNDING GATE — is anything in the frame touching anything.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MEASURES, AND WHY IT IS NOT A UNIFORM READ-BACK
 * ────────────────────────────────────────────────────────────────────────────
 * Two blind critic panels scored this build with "no contact shadows or AO
 * grounding anything — every ped floats" and "no visible AO at wall/ground
 * junctions". Both are statements about EMITTED PIXELS, so this probe reads
 * emitted pixels (ARCHITECTURE.md rule 12) and never a uniform, a buffer
 * strength or an instance count. A pool can be populated, visible, in the
 * scene and correctly blended and still contribute nothing to the picture —
 * which is exactly what was measured here, see GROUP 2.
 *
 * Three groups, each an A/B of ONE build against a live URL hatch:
 *
 *   1  TILE BAKE     `?owNoTileAo=1`      the ground-junction vertex AO baked
 *                                         by `src/buildings/tile.js`
 *   2  PED BLOBS     `?owNoPedShadow=1`   the geometric contact pool under
 *                                         every pedestrian (`src/peds/`)
 *   3  CAR BLOBS     `?owNoCarShadow=1`   the same for the fleet
 *                                         (`src/vehicles/groundshadow.js`)
 *
 * Both arms of a group are a full capture of ONE shot, so nothing is compared
 * across cameras and nothing is compared against a remembered number. Groups
 * are not all shot on the SAME frame, though — group 3 photographs a frame with
 * a car in it, see the note by `CAR_SHOT` — and each shot in play carries its
 * own group-0 floor for exactly that reason.
 *
 * THE ASSERTION IS "THE FEATURE IS IN THE PICTURE", not "the picture is
 * pretty": each group passes when switching the feature off measurably
 * BRIGHTENS the pixels the feature touches (occlusion removed) by more than
 * the harness's own noise floor, and fails when the two arms are the same
 * picture. The noise floor is not assumed — group 0 captures the same shot
 * twice with no hatch at all and reports what two identical arms differ by.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE WHOLE-BAND MEAN IS A MEASUREMENT OF THE AUTO-EXPOSURE, NOT OF THE FEATURE
 * ────────────────────────────────────────────────────────────────────────────
 * This gate used to assert on the mean linear luminance of the WHOLE band, and
 * that number is confounded, badly, in the direction that fails a working
 * feature. The renderer meters the frame it is given: darkening a few thousand
 * pixels lowers the metered key, the adaptation opens up, and every OTHER pixel
 * in the frame comes back brighter. A small-footprint decal pool is then
 * outvoted by its own side effect.
 *
 * MEASURED, this build, `?owNoCarShadow=1` on three shots, splitting the band
 * into the pixels the hatch MOVES and the pixels it cannot reach (linear x255,
 * 519 086 px of band at 1280x720):
 *
 *                 moved px   moved dLum   drift on the rest   whole-band dLum
 *   car            10 778      +1.196          -0.077             -0.051
 *   driving         6 164      +0.317          -0.015             -0.011
 *   street            277      +1.781          -0.002             -0.001
 *
 * Every one of those is a pool doing its job — the road it covers is 0.3 to 1.8
 * linear darker with it on — and every one of them reported a NEGATIVE
 * whole-band delta, i.e. "this occlusion term brightens the frame". It does not.
 * 0.077 x 508 000 untouched pixels simply outweighs 1.196 x 10 778 touched ones.
 *
 * So the delta is now taken over the FOOTPRINT — the pixels that actually moved
 * — and corrected by the drift measured where the feature cannot reach. That is
 * the discipline `src/peds/shadowprobe.mjs` already arrived at independently for
 * the ped pool, in its own words: measured against the frame's own exposure, or
 * it is not a measurement of the blend. The whole-band figures are still
 * printed, because they are what a naive read gives and the next person should
 * be able to see the gap for themselves.
 *
 * THE CORRECTION IS A GAIN, NOT AN OFFSET, and here that distinction has teeth.
 * Exposure is a multiply, so it moves a bright pixel further than a dark one.
 * `shadowprobe` gets away with subtracting an offset because its reference is a
 * strip of the SAME road 14 px either side of the mark, at the same brightness;
 * this probe's reference is every untouched pixel in the band, which includes
 * sky and lit facades and averages 35 linear against a shaded contact mark's 14.
 * MEASURED on `car`: the untouched pixels moved -0.077 at a mean of 35 linear,
 * which is a gain of 0.99772, and the footprint sits at 12.3. An offset
 * correction credits the whole -0.077 to a footprint that the gain only moves
 * -0.028, and reports +1.273 where the gain reports +1.224 — 4% of flattery.
 * Small here, and it is the SIGN of the error that matters: an offset
 * correction always over-credits a feature that lands on the darker-than-
 * average part of the frame, which is every ground-contact mark there is.
 *
 *   node src/render/aoprobe.mjs            all groups, on `street`
 *   node src/render/aoprobe.mjs --shot=detail
 *   node src/render/aoprobe.mjs --keep     leave the PNGs on disk
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const SHOT = args.shot ?? 'street';
const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const root = resolve(import.meta.dirname, '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'ow-aoprobe-'));

/**
 * The HUD is drawn over the world and is pixel-identical in every arm, so it
 * only dilutes the means. It lives in the corners; this is the middle band,
 * which is also where the ground is.
 */
const BAND = { x0: 0.06, x1: 0.94, y0: 0.30, y1: 0.94 };

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function shoot(name, params, shot = SHOT) {
  const out = join(dir, `${name}.png`);
  const a = ['src/render/shotprobe.mjs', `--shot=${shot}`, `--out=${out}`, `--w=${W}`, `--h=${H}`];
  if (params) a.push(`--params=${params}`);
  execFileSync('node', a, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  return PNG.sync.read(readFileSync(out));
}

/**
 * The A/B, split into the pixels the hatch MOVED and the pixels it could not
 * reach. Linear, because occlusion is a transmittance and an sRGB mean of a
 * multiply is not proportional to anything.
 *
 * `d > 2` on the summed channel deltas is the footprint test, unchanged: the
 * harness is deterministic (group 0 reports 0.00% moved between two identical
 * captures) so this floor is far above the capture's own noise and far below
 * anything an occlusion term does.
 *
 * The numbers that come out of the split:
 *
 *   dUnder   how much brighter the FOOTPRINT is with the feature off
 *   drift    how much brighter the rest of the band is with the feature off —
 *            the auto-exposure's answer to the feature, measured where the
 *            feature is not
 *   gain     that same drift as a RATIO (off / live over the untouched pixels),
 *            which is the form the exposure actually applies it in
 *   dCorr    mean(off - live * gain) over the footprint: the only part this gate
 *            is entitled to attribute to the feature
 *
 * `raised` counts footprint pixels the feature made BRIGHTER under the same
 * gain — a transmittance can only multiply down, so this is the shape of the
 * historical lerp defect and it is printed whether or not it gates.
 */
function compare(a, b) {
  const x0 = Math.round(a.width * BAND.x0);
  const x1 = Math.round(a.width * BAND.x1);
  const y0 = Math.round(a.height * BAND.y0);
  const y1 = Math.round(a.height * BAND.y1);
  let la = 0;
  let lb = 0;
  let n = 0;
  let brighter = 0;
  let mn = 0;
  let mla = 0;
  let mlb = 0;
  let sn = 0;
  let sla = 0;
  let slb = 0;
  // The footprint is a small fraction of the band, so holding its two luminances
  // costs a few thousand floats and lets the gain be applied per pixel after it
  // has been measured. Preallocating the whole band instead would be 1.2 M.
  const mA = [];
  const mB = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * a.width + x) * 4;
      const ya =
        0.2126 * srgbToLinear(a.data[i] / 255) +
        0.7152 * srgbToLinear(a.data[i + 1] / 255) +
        0.0722 * srgbToLinear(a.data[i + 2] / 255);
      const yb =
        0.2126 * srgbToLinear(b.data[i] / 255) +
        0.7152 * srgbToLinear(b.data[i + 1] / 255) +
        0.0722 * srgbToLinear(b.data[i + 2] / 255);
      la += ya;
      lb += yb;
      n++;
      const d =
        Math.abs(a.data[i] - b.data[i]) +
        Math.abs(a.data[i + 1] - b.data[i + 1]) +
        Math.abs(a.data[i + 2] - b.data[i + 2]);
      if (d > 2) { mn++; mla += ya; mlb += yb; mA.push(ya); mB.push(yb); }
      else { sn++; sla += ya; slb += yb; }
      if (yb > ya + 1e-4) brighter++;
    }
  }
  const drift = sn ? ((slb / sn) - (sla / sn)) * 255 : 0;
  // 1 when the hatch changed nothing outside the footprint — the honest default
  // for a group with no side effect on the metering.
  const gain = sn && sla > 0 ? slb / sla : 1;
  const underLive = mn ? (mla / mn) * 255 : 0;
  const underOff = mn ? (mlb / mn) * 255 : 0;
  let dCorr = 0;
  let raised = 0;
  for (let k = 0; k < mn; k++) {
    const d = mB[k] - mA[k] * gain;
    dCorr += d;
    // `d < 0` is the feature making this pixel brighter than the exposure alone
    // accounts for. 1e-6 linear is well under a byte at these levels.
    if (d < -1e-6) raised++;
  }
  return {
    live: (la / n) * 255,
    off: (lb / n) * 255,
    moved: mn / n,
    movedN: mn,
    brighter: brighter / n,
    underLive,
    underOff,
    drift,
    gain,
    dUnder: underOff - underLive,
    dCorr: mn ? (dCorr / mn) * 255 : 0,
    raised: mn ? raised / mn : 0,
  };
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * A GATE FOR CAR CONTACT MARKS CANNOT BE SHOT ON A STREET WITH NO CAR IN IT
 * ────────────────────────────────────────────────────────────────────────────
 * `street` is the right frame for the bake and for the crowd — a downtown
 * pavement with sixty pedestrians on it — and it is the wrong frame for the
 * fleet. Its nearest car with a contact mark is 60 m away, so the whole vehicle
 * pool lands on 269 band pixels there, 0.05%, and the gate is then measuring
 * the framing rather than the feature. That is the same failure
 * `src/peds/shadowprobe.mjs` fixed by composing its own subject rather than
 * borrowing a camera, and its reasoning transfers exactly.
 *
 * So the vehicle group takes its A/B on a shot that HAS a car in it — the
 * caller's own shot if that shot is a vehicle shot, `car` otherwise — with its
 * own noise floor captured on that same shot, because a floor measured on a
 * different frame bounds nothing. MEASURED, this pool, same build: 277 px of
 * footprint on `street`, 10 778 on `car`. Same pool, thirty-nine times the
 * evidence, and no change to what is being asserted.
 *
 * The pool is NOT hidden on `street` — the 277 px it does reach are 1.78 linear
 * darker with it on, the largest per-pixel darkening of the three shots because
 * distant marks land on open sunlit road. There is simply almost nothing of it
 * in that frame, and 277 px against a 0.04% presence bar is a gate one parked
 * car away from being unmeasurable.
 *
 * THE MIRROR OF THIS IS OPEN AND IS NOT FIXED HERE. Run
 * `--shot=driving` and group 2 goes red at 0.000% — a chase camera down an
 * avenue that `clearTraffic` has emptied has no pedestrian contact mark in
 * frame at all. That is the identical defect with the subjects swapped, it
 * predates this change (measured red on `driving` before it too), and the same
 * remedy applies: give group 2 a crowd-bearing shot. It is left alone because
 * the ped pool's evidence is owned by `src/peds/shadowprobe.mjs`, which stages
 * its own subject and passes 4/4 — so nothing is currently unmeasured, only
 * measured in the other file.
 */
const VEHICLE_SHOTS = new Set(['car', 'driving', 'cockpit', 'chase']);
const CAR_SHOT = VEHICLE_SHOTS.has(SHOT) ? SHOT : 'car';

const rows = [];
let fails = 0;

/**
 * GROUP 0 — the noise floor, measured rather than assumed.
 *
 * Every other group is a claim that two captures differ. That claim is only
 * meaningful against what two captures of the SAME build differ by, and this
 * harness is deterministic by construction (`?capture=1` seeds the city and
 * takes the streaming budget work-denominated) — so the honest expectation is
 * zero, and anything else is the number the other groups have to beat.
 *
 * One per shot in play: see the note on `CAR_SHOT`.
 */
const liveOf = new Map();
const floorOf = new Map();
for (const shot of new Set([SHOT, CAR_SHOT])) {
  const a = shoot(`live-${shot}`, null, shot);
  const c = shoot(`control-${shot}`, null, shot);
  liveOf.set(shot, a);
  const f = compare(a, c);
  floorOf.set(shot, f);
  rows.push([`0 noise floor (${shot})`, 'no hatch', f, null, 0, shot]);
}

/**
 * `assert: false` — REPORTED, NOT GATED, and the reason is written down.
 *
 * The tile bake is real: MEASURED in the live scene, 43.44% of the 1 288 246
 * building vertices in the `street` frame carry a vertex-AO mask over 0.3 with
 * it on against 39.48% with `?owNoTileAo=1`, so it is reaching four points of
 * coverage that nothing had. It is NOT visible: 0.009% of the band moves,
 * against a noise floor of 0.000% and a bar of 1%.
 *
 * The diagnosis is the useful part, and it is why this row must not be turned
 * into a passing assertion by lowering the bar. `buildings` ALREADY bakes a
 * base-AO term into most of its geometry (`geom.js weather()`), which is where
 * those 39.48 points come from — so a second bake over the same walls has
 * almost nothing left to add. The junctions the critic panels actually
 * photographed in `detail.png` are the retaining wall standing on the plaza,
 * and that wall is not a building: it belongs to `world`/`props`, whose
 * geometry no bake in `src/buildings/` can reach. Closing that finding needs a
 * bake on the owner of the ground, not a bigger number here.
 */
/**
 * Per-group bar, fraction of the band. A shared 1% bar was UNREACHABLE for the
 * contact-blob groups by geometry, not by defect: at this camera (2.2 m up,
 * looking level) a 0.6 m ground blob at 40 m projects to ~1 px of height, and
 * the whole ped pool physically covers ~0.07% of the frame — reaching 1% would
 * need marks seven times larger, i.e. a worse picture. So the small-footprint
 * decal groups carry a PRESENCE bar (well above the measured noise floor x4,
 * far below the old shared bar) and the sign test still does the honest work:
 * the marks must exist AND darken. The bake row keeps the big bar — its
 * finding is diagnostic (see the header) and must not be lowered into a pass.
 */
const GROUPS = [
  ['1 tile ground-AO bake', 'owNoTileAo=1', false, 0.01, SHOT],
  ['2 ped contact blobs', 'owNoPedShadow=1', true, 0.0004, SHOT],
  ['3 car contact blobs', 'owNoCarShadow=1', true, 0.0004, CAR_SHOT],
];

for (const [label, hatch, assert, bar, shot] of GROUPS) {
  const off = shoot(`${hatch.replace(/[^a-z0-9]/gi, '')}-${shot}`, hatch, shot);
  rows.push([label, hatch, compare(liveOf.get(shot), off), assert, bar, shot]);
}

// The bar: per group (see GROUPS), never under what two identical captures of
// THAT SHOT disagree by — a deterministic harness cannot make the bar zero.
const barFor = (bar, shot) => Math.max(bar, floorOf.get(shot).moved * 4);

console.log(`\nGROUNDING GATE — shot '${SHOT}' at ${W}x${H}, band ${JSON.stringify(BAND)}`);
console.log('  live = feature ON, off = hatch arm; luminance is LINEAR x255.');
console.log('  "band" is the whole band and is confounded by auto-exposure — see the header.');
console.log('  "footprint" is the pixels the hatch moved; dCorr subtracts the drift measured');
console.log('  on the pixels it did not touch, and is the only column this gate asserts on.\n');
console.log('  group                     band dLum   moved    footprint px    dUnder    drift    gain      dCorr   raised   shot');
for (const [label, hatch, r, , , shot] of rows) {
  const d = r.off - r.live;
  console.log(
    `  ${label.padEnd(24)} ${((d >= 0 ? '+' : '') + d.toFixed(3)).padStart(9)}` +
      `${(r.moved * 100).toFixed(2)}%`.padStart(9) +
      `${r.movedN}`.padStart(15) +
      `${(r.dUnder >= 0 ? '+' : '') + r.dUnder.toFixed(3)}`.padStart(10) +
      `${(r.drift >= 0 ? '+' : '') + r.drift.toFixed(3)}`.padStart(9) +
      `${r.gain.toFixed(5)}`.padStart(9) +
      `${(r.dCorr >= 0 ? '+' : '') + r.dCorr.toFixed(3)}`.padStart(11) +
      `${(r.raised * 100).toFixed(1)}%`.padStart(9) +
      `   ${shot}  ${hatch}`
  );
}
console.log('');

for (const [label, , r, assert, bar, shot] of rows) {
  if (assert === null) continue;
  const MOVED_BAR = barFor(bar, shot);
  const inPicture = r.moved > MOVED_BAR;
  // A transmittance can only multiply DOWN, so removing it can only raise the
  // pixels it touched — measured against what the frame's own exposure did to
  // the pixels it did not.
  const occludes = r.dCorr >= 0;
  if (assert === false) {
    console.log(`  ----  ${label}: REPORTED ONLY — ${(r.moved * 100).toFixed(3)}% of the band ` +
      `moved on '${shot}', ${r.dCorr.toFixed(3)} linear over ${r.movedN} px. See the note on GROUPS.`);
  } else if (!inPicture) {
    console.log(`  FAIL  ${label}: NOT IN THE PICTURE — ${(r.moved * 100).toFixed(3)}% of the ` +
      `band moved on '${shot}' against a ${(MOVED_BAR * 100).toFixed(3)}% bar. The feature is ` +
      'running and the frame does not know about it.');
    fails++;
  } else if (!occludes) {
    console.log(`  FAIL  ${label}: it BRIGHTENS the ${r.movedN} px it touches ` +
      `(${r.underLive.toFixed(3)} -> ${r.underOff.toFixed(3)} at an exposure gain of ` +
      `${r.gain.toFixed(5)}, net ${r.dCorr.toFixed(3)}). An occlusion term that lights the ground ` +
      'is a lerp towards a constant, not a transmittance — see the note in src/peds/crowdfx.js.');
    fails++;
  } else {
    console.log(`  PASS  ${label}: ${(r.moved * 100).toFixed(2)}% of the band on '${shot}' ` +
      `(${r.movedN} px), ${r.dCorr.toFixed(3)} linear darker with it on at an exposure gain of ` +
      `${r.gain.toFixed(5)}; ${(r.raised * 100).toFixed(1)}% of the footprint raised.`);
  }
}

if (!args.keep) rmSync(dir, { recursive: true, force: true });
else console.log(`\n  frames kept in ${dir}`);

console.log(fails === 0 ? '\nGROUNDING GATE PASSED\n' : `\nGROUNDING GATE: ${fails} RED\n`);
process.exit(fails === 0 ? 0 : 1);
