#!/usr/bin/env node
/**
 * PAINT / GLASS / CABIN PROBE — the three things the review called by name,
 * measured off the emitted frame instead of argued about.
 *
 *   node src/vehicles/paintprobe.mjs
 *   node src/vehicles/paintprobe.mjs --verbose
 *   node src/vehicles/paintprobe.mjs --control=wash
 *   node src/vehicles/paintprobe.mjs --control=void
 *   node src/vehicles/paintprobe.mjs --control=flat
 *   node src/vehicles/paintprobe.mjs --control=hood
 *   node src/vehicles/paintprobe.mjs --control=deadenv
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IT MEASURES, AND WHY IT IS THE FRAME AND NOT THE MATERIAL
 * ────────────────────────────────────────────────────────────────────────────
 * `paint.js` can be given any numbers you like and they will read back exactly
 * as they were set — reading them proves the assignment ran, which is hard rule
 * 12's definition of measuring the code's own input. What a critic sees is the
 * PIXELS, and every claim in the review is a statement about pixels:
 *
 *   "noisy vertex-coloured plastic"  -> the ordered colour is not on the car:
 *                                       chroma at the body pixels collapses
 *                                       toward the achromatic axis.
 *   "opaque black glass"             -> the glazed pixels sit at the black
 *                                       floor and carry no structure.
 *   "black void cabin"               -> the cabin's upper third is darker than
 *                                       anything a lined roof can be.
 *
 * So this boots the real game in headless Chromium, applies the shipped `car`
 * and `cockpit` shots, and reads the CANVAS BACK. It also dumps the resolved
 * material state alongside — not as a gate, but so a red gate can be diagnosed
 * without a second run.
 *
 * THE COLOUR MEASURE IS A RATIO, NOT A LEVEL. Exposure, weather and time of day
 * all move absolute brightness, and none of them is what the review is about.
 * `chroma` here is (max-min)/max over the sRGB triple — how far the pixel is
 * from grey — which is invariant to exposure and is exactly the axis a white
 * specular pedestal destroys.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NEGATIVE CONTROLS
 * ────────────────────────────────────────────────────────────────────────────
 * Each control perturbs the SHIPPED MATERIALS ONCE, in the page, after the
 * world has built and before the shutter — no debug hooks in the shipping path,
 * the same discipline `shapeprobe` uses on style data. Each reproduces a defect
 * this file was written against, MEASURED on the pre-campaign build:
 *
 *   --control=wash   put the pre-campaign clear layer back (env 0.96, orange
 *                    peel 0.55). This is the state the review photographed: a
 *                    `slag orange` 0xc4460d body came back 226/166/159, chroma
 *                    0.30. The paint assertions must go red.
 *   --control=void   draw the cabin lining in `cavity` again — the material
 *                    it shipped in, albedo 0.0015. This IS the pre-campaign
 *                    build, whose cockpit upper third measured 23/28/33. The
 *                    cabin assertions must go red, and so must the glass
 *                    ones: see the note over `glass.lit`.
 *   --control=flat   an actually opaque pane: no haze map, 0.94 over the old near-black
 *                    0x0a0e12 tint. The glass assertions must go red.
 *                    MEASURED, and worth stating because it is the campaign's
 *                    most useful negative result: restoring only the shipped
 *                    0.62 does NOT fail these gates (46.0 -> 49.5). The
 *                    review's "opaque black glass" was mostly not the glass.
 *                    It was the unlit cabin behind it, which is why
 *                    `--control=void` takes the glass gates down with it.
 *   --control=deadenv  put the paints' `envMap` slot back to null, which is the
 *                    binding every vehicle material had before
 *                    `render.bindEnvMaterials`. three then overwrites
 *                    `envMapIntensity` with `scene.environmentIntensity` on
 *                    every frame and the paint's own level is inert again —
 *                    which is the state `paint.js`'s ablation measured when it
 *                    found 0.71 -> 0 worth under one count. `paint.envlive`
 *                    must go red. It is the ONLY one that should: no light is
 *                    removed by this control, only the paint's authority over
 *                    how much of it comes back.
 *   --control=hood   compose the fourth view from the BONNET constants the
 *                    rig used to mount it on (`CHASE.bonnetUp`/`bonnetFore`
 *                    against `spec.half`) instead of running the rig. The two
 *                    cockpit assertions must go red — a hood-cam is outside
 *                    the cabin and on the centreline, and if the gate cannot
 *                    say so it is not measuring anything.
 *
 * A control that does not go red means the assertion it targets is decorative.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';
import { PNG } from 'pngjs';
import * as THREE from 'three';
import { CameraRig } from '../player/camera.js';
import { Movement } from '../player/movement.js';
import { CHASE } from '../player/tuning.js';
import { VEHICLE_SPECS, finalizeSpec } from './specs.js';

/** Region statistics over an emitted PNG. Regions are normalised (u0,v0,u1,v1). */
function sample(png, regions) {
  const out = {};
  for (const name in regions) {
    const [u0, v0, u1, v1] = regions[name];
    const x0 = Math.round(u0 * png.width);
    const x1 = Math.max(x0 + 1, Math.round(u1 * png.width));
    const y0 = Math.round(v0 * png.height);
    const y1 = Math.max(y0 + 1, Math.round(v1 * png.height));
    let r = 0, g = 0, b = 0, chroma = 0, lum = 0, lum2 = 0, dark = 0, n = 0;
    // Kept so the bright TAIL can be read as well as the average — see
    // `paint.highlight`. A mean cannot tell a panel with a specular return on
    // it from the same panel uniformly raised by that return's energy.
    const lums = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        const R = png.data[i], G = png.data[i + 1], B = png.data[i + 2];
        r += R; g += G; b += B;
        const mx = Math.max(R, G, B);
        const mn = Math.min(R, G, B);
        chroma += mx > 4 ? (mx - mn) / mx : 0;
        const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        lum += L; lum2 += L * L;
        lums.push(L);
        if (L < 40) dark++;
        n++;
      }
    }
    const mean = lum / n;
    lums.sort((p, q) => p - q);
    const pct = (f) => lums[Math.min(n - 1, Math.floor(f * n))];
    out[name] = {
      r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1),
      chroma: +(chroma / n).toFixed(4),
      lum: +mean.toFixed(1),
      sd: +Math.sqrt(Math.max(0, lum2 / n - mean * mean)).toFixed(2),
      p50: +pct(0.50).toFixed(1),
      p99: +pct(0.99).toFixed(1),
      darkFrac: +(dark / n).toFixed(3),
      px: n,
    };
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* the fourth view, solved offline                                     */
/* ------------------------------------------------------------------ */
/**
 * WHERE THE LENS ACTUALLY ENDS UP when the view cycle reaches `near` in a car.
 *
 * Runs the real `CameraRig` against a stub vehicle — the same construction
 * `src/player/camtest.mjs` uses — and reads the EMITTED camera position back
 * into the vehicle's own frame. Nothing here reads the rig's inputs: the
 * assertion is about the transform the rig published, which is the thing that
 * decides what the frame contains.
 *
 * The control (`--control=hood`) does not perturb any code. It composes the
 * pre-campaign eye point straight from the tuning constants that produced it
 * (`CHASE.bonnetUp`, `CHASE.bonnetFore` against `spec.half`) and runs the same
 * assertions on it. Those must go red, or the assertions do not distinguish a
 * cabin from a hood-cam.
 */
function solveFourthView(specId, useHood) {
  const spec = finalizeSpec(structuredClone(VEHICLE_SPECS[specId]));
  const v = {
    spec,
    position: new THREE.Vector3(0, spec.comY, 0),
    quaternion: new THREE.Quaternion(),
    velocity: new THREE.Vector3(0, 0, 6),
  };
  if (useHood) {
    const p = new THREE.Vector3(
      0, spec.half.y * CHASE.bonnetUp, spec.half.z * CHASE.bonnetFore
    );
    return { spec, local: p };
  }
  const time = { frame: 0, elapsed: 0, dt: 1 / 60, scale: 1 };
  const listeners = new Map();
  const events = {
    emit: () => {},
    on: (n, f) => {
      if (!listeners.has(n)) listeners.set(n, []);
      listeners.get(n).push(f);
      return () => {};
    },
  };
  const HIT = { hit: false, distance: 0, point: new THREE.Vector3(), normal: new THREE.Vector3() };
  const registry = {
    physics: {
      MASK: { WORLD: 3, CHARACTER: 3 },
      staticWorld: null,
      raycast: () => (HIT.hit = false, HIT),
      groundHeight: () => 0,
      checkCapsule: () => true,
      // Open sky: the boom never collides, so the framing is the solver's own
      // answer rather than a wall's.
      sphereCast: () => ({ hit: false, distance: Infinity }),
    },
  };
  const ctx = {
    time, events,
    input: {
      look: { x: 0, y: 0 }, get: () => 0, isDown: () => false,
      axis: () => 0, pressed: () => false, consume: () => false,
    },
    config: { fov: 65 },
    peek: (k) => registry[k] ?? null,
  };
  const player = { controlEnabled: true, health: { dead: false } };
  const cam = new CameraRig(ctx);
  const move = new Movement(ctx, player);
  move.grounded = true;
  const health = { fraction: 1, suppression: 0 };
  cam.setVehicle(v);
  cam.setView('near');
  // Long enough for the timed view ease and every exponential to arrive.
  for (let i = 0; i < 420; i++) {
    time.frame++;
    time.elapsed += 1 / 60;
    cam.update(1 / 60, move, health);
  }
  const local = cam.position.clone().sub(v.position);
  return { spec, local, nearBlend: cam.nearBlend };
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const VERBOSE = !!args.verbose;
const CONTROL = args.control ?? null;
const PORT = Number(args.port ?? 5461);
const ROOT = resolve(import.meta.dirname, '../..');

/* ------------------------------------------------------------------ */
/* regions — normalised, so they survive a viewport change            */
/* ------------------------------------------------------------------ */
/**
 * Picked off the shipped framing of each shot and kept well inside the subject.
 * `car` stages a three-quarter front on South Seventh Street; `cockpit` stages
 * the driver's seat of the same class on the same street.
 */
const REGIONS = {
  car: {
    bonnet: [0.365, 0.505, 0.448, 0.551],   // crown of the bonnet, upward facing
    flank: [0.521, 0.505, 0.583, 0.542],    // door skin, near vertical
    nose: [0.583, 0.435, 0.630, 0.463],     // rear quarter, turned from the sky
    glass: [0.458, 0.426, 0.510, 0.450],    // windscreen
  },
  /**
   * THE COCKPIT REGIONS MOVED WITH THE LENS, AND THEY HAD TO.
   *
   * These were picked off a staged eye that sat in the PASSENGER seat 13 cm
   * under the roof (see `_applyPoseCamera` in `vehicles/index.js`). That frame
   * was mostly headliner, so the ceiling was worth 14% of the picture's height
   * and the world was a slot near the bottom. The eye is now the one
   * `player/camera.js` publishes for the fourth view, and the frame it produces
   * is the one a driver gets: the roof header arcs across the very top, the
   * windscreen fills the upper half, and the rim and the binnacle hold the
   * bottom.
   *
   * Left on the OLD coordinates these would have read: `roof` 186.7 with a sd
   * of 43 (it was sitting on the CITY, four buildings and a crane) and
   * `aperture` 64.3 (it was sitting on the steering wheel). Both would still
   * have passed their thresholds, which is the whole reason they had to be
   * re-derived rather than re-tuned — a gate that passes on the wrong pixels is
   * worse than one that fails.
   */
  cockpit: {
    roof: [0.340, 0.004, 0.660, 0.026],     // the windscreen header, from below
    aperture: [0.320, 0.250, 0.680, 0.320], // world through the screen, over the rim
    binnacle: [0.160, 0.780, 0.260, 0.880], // instrument face, left of the boss
  },
};

/* ------------------------------------------------------------------ */

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

let server = null;
if (!(await portOpen(PORT))) {
  server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' },
  });
  for (let i = 0; i < 160; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(PORT)) break;
  }
}

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu',
    '--force-color-profile=srgb', '--mute-audio',
  ],
});
// 1920x1080: the acceptance captures are taken there, so the normalised
// regions below mean the same thing in both.
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[console] ${m.text()}`); });
process.on('uncaughtException', (e) => {
  console.log(logs.slice(0, 12).join('\n'));
  console.log(String(e));
  process.exit(1);
});

const results = {};
let materials = null;
let cloth = null;

try {
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&shot=car`, {
    waitUntil: 'domcontentloaded', timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });

  /**
   * ---- the control perturbation ----------------------------------------
   *
   * APPLIED AFTER THE SHOT IS STAGED, NOT AT LOAD. `debugPose` SPAWNS the
   * subject, so its paint material does not exist until the shot has been
   * applied — a control run at load perturbed the traffic fleet and left the
   * one car in frame untouched, and all three material controls came back
   * green while looking like they had done something.
   */
  const applyControl = () => {
    if (!CONTROL) return Promise.resolve();
    return page.evaluate((ctl) => {
      const mats = window.__ENGINE__.ctx.peek('vehicles')?.mats;
      if (!mats) throw new Error('no vehicle materials');
      const all = mats._all ?? [];
      for (const m of all) {
        if (ctl === 'wash' && m.name?.startsWith('veh_paint_')) {
          // The pre-campaign clear layer, exactly: a full-strength clearcoat
          // over a base coat whose Fresnel was still computed for an AIR
          // interface, with the 0.55 orange peel smearing both across the
          // panel. `envMapIntensity` is restored too, for completeness — it is
          // inert, which is half of what this control demonstrates.
          m.specularIntensity = 1;
          m.clearcoat = 1;
          m.envMapIntensity = 0.96;
          if (m.clearcoatNormalScale) m.clearcoatNormalScale.set(0.55, 0.55);
          m.clearcoatRoughness = 0.055;
          m.needsUpdate = true;
        }
      }
      if (ctl === 'flat') {
        // The cache key carries the tint, so find the pane by SHAPE rather than
        // by name: depth-write-off, transparent, physical.
        for (const m of all) {
          if (m.isMeshPhysicalMaterial && m.transparent && m.depthWrite === false && m.opacity < 1) {
            // The map's ALPHA is the real ceiling on the tint (see `glass()`
            // in paint.js), so `opacity` alone cannot make a pane opaque —
            // 0.95 through a 0.0-0.55 haze mask is still 0.52. Dropping the
            // map is what an actually blacked-out pane is.
            m.color.setHex(0x0a0e12);
            m.map = null;
            m.opacity = 0.94;
            m.needsUpdate = true;
          }
        }
      }
      if (ctl === 'deadenv') {
        /**
         * THE PRE-FIX ENV BINDING, EXACTLY.
         *
         * `render.bindEnvMaterials` points each vehicle material's `envMap` at
         * the texture `scene.environment` already holds, which is the only
         * thing that stops three overwriting `envMapIntensity` with
         * `scene.environmentIntensity` every frame (see the note over
         * `bindEnvMaterials` in `render/index.js`). Putting the slot back to
         * null restores the defect: the map is still sampled, so the car does
         * not visibly change, but the material's own level is inert again.
         *
         * `paint.envlive` must go red. Nothing else should — this control does
         * not remove any light, it only takes away the paint's control over how
         * much of it comes back.
         *
         * THE DEREGISTRATION IS NOT OPTIONAL, and finding that out is the most
         * useful thing this control has done. `render` re-binds whenever the
         * registered list GROWS, and traffic keeps mixing body colours for the
         * whole settle, so a first version that only nulled the slot was
         * silently repaired within a second or two: the control run came back
         * 15/15 and reported the gate as decorative when in fact the gate was
         * fine and the control had been undone. Removing the registration is
         * what "before `bindEnvMaterials` existed" actually means.
         */
        const r = window.__ENGINE__.ctx.peek('render');
        if (r?._envLists) r._envLists.length = 0;
        for (const m of all) {
          if (m.name?.startsWith('veh_paint_')) {
            m.envMap = null;
            m.needsUpdate = true;
          }
        }
      }
      if (ctl === 'void') {
        /**
         * The pre-campaign cabin, exactly: the SAME lofted lining, drawn in the
         * `cavity` material `body.js` used to push it into. Deleting the mesh
         * is NOT equivalent and was the first mistake here — with the lining
         * gone the single-sided shell shows the sky through the roof and the
         * region reads BRIGHTER than the fix (measured 194 against 164).
         */
        for (const m of all) {
          if (m.name === 'veh_headliner') {
            m.color.setHex(0x050607);
            m.envMapIntensity = 0.12;
            m.needsUpdate = true;
          }
        }
      }
    }, CONTROL);
  };

  for (const shot of ['car', 'cockpit']) {
    await page.evaluate((s) => window.__APPLY_SHOT__?.(s, { grabFrame: 90 }), shot);
    // One frame so the pose materialises the subject's LOD0, then perturb, then
    // settle: TAA needs well over a hundred frames to forget the unperturbed
    // history, and a control read before it has is a control that reads green.
    await page.evaluate(
      () => new Promise((d) => { let i = 0; const t = () => (++i >= 30 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })
    );
    await applyControl();
    await page.evaluate(
      () => new Promise((d) => { let i = 0; const t = () => (++i >= 200 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })
    );
    /**
     * THE SHUTTER, not the framebuffer. `readPixels` on the default
     * framebuffer comes back all zeroes here — the drawing buffer is not
     * preserved past the compositor, so it measures nothing at all and reports
     * a confident 0/0/0 while doing it. `page.screenshot` reads what the page
     * actually PRESENTED, which is the same artifact `tools/capture.mjs`
     * writes and the same one a reviewer looks at.
     */
    const png = PNG.sync.read(await page.screenshot({ type: 'png' }));
    results[shot] = sample(png, REGIONS[shot]);

    /**
     * ---- THE ENV ABLATION, IN THE SAME RUN --------------------------------
     *
     * `paint.envlive` and `paint.highlight` are both statements about what the
     * ENVIRONMENT contributes to the panel, and neither can be made from one
     * frame: a bonnet lit to 143 tells you nothing about where the 143 came
     * from. So the paints' own `envMapIntensity` is driven to zero, the frame is
     * re-read, and the pair is compared.
     *
     * It has to be the SAME staged car in the SAME light — a second boot would
     * differ by the weather clock and the paint pool draw, and the difference
     * being measured here is smaller than either. The value is saved and put
     * back before the cockpit shot, which shares these materials.
     */
    if (shot === 'car') {
      /**
       * The saved level rides on the MATERIAL, not on a parallel array indexed
       * by position. `_all` is append-only but it does grow — traffic keeps
       * mixing body colours through the settle — so a positional restore hands
       * `undefined` to every paint mixed after the save and permanently breaks
       * the fleet's env for the rest of the run, including the cockpit shot
       * that follows. Keying off the material itself cannot get that wrong.
       */
      await page.evaluate(() => {
        const mats = window.__ENGINE__.ctx.peek('vehicles')?.mats;
        for (const m of mats?._all ?? []) {
          if (!m.name?.startsWith('veh_paint_')) continue;
          m.userData.__probeEnv = m.envMapIntensity;
          m.envMapIntensity = 0;
        }
      });
      await page.evaluate(
        () => new Promise((d) => { let i = 0; const t = () => (++i >= 200 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })
      );
      results.carNoEnv = sample(
        PNG.sync.read(await page.screenshot({ type: 'png' })), REGIONS.car
      );
      await page.evaluate(() => {
        const mats = window.__ENGINE__.ctx.peek('vehicles')?.mats;
        for (const m of mats?._all ?? []) {
          if (m.userData?.__probeEnv === undefined) continue;
          m.envMapIntensity = m.userData.__probeEnv;
          delete m.userData.__probeEnv;
        }
      });
    }
  }

  materials = await page.evaluate(() => {
    const mats = window.__ENGINE__.ctx.peek('vehicles')?.mats;
    const out = { paints: [], glass: null, headliner: null, seat: null };
    for (const m of mats?._all ?? []) {
      if (m.name?.startsWith('veh_paint_') && out.paints.length < 4) {
        out.paints.push({
          name: m.name,
          env: +m.envMapIntensity.toFixed(3),
          cc: +m.clearcoat.toFixed(3),
          ccR: +m.clearcoatRoughness.toFixed(4),
          peel: +m.clearcoatNormalScale.x.toFixed(3),
          metal: +m.metalness.toFixed(3),
          rough: +m.roughness.toFixed(3),
        });
      }
      if (m.name === 'veh_headliner') out.headliner = { color: m.color.getHexString(), env: m.envMapIntensity };
      if (m.name === 'veh_seat') out.seat = { color: m.color.getHexString() };
      if (m.isMeshPhysicalMaterial && m.transparent && m.depthWrite === false && !out.glass) {
        out.glass = { color: m.color.getHexString(), opacity: +m.opacity.toFixed(3), env: m.envMapIntensity };
      }
    }
    let steer = 0;
    window.__ENGINE__.scene.traverse((o) => { if (o.name === 'steeringWheel') steer++; });
    let liner = 0;
    window.__ENGINE__.scene.traverse((o) => { if (o.name === 'headliner') liner++; });
    out.steeringWheels = steer;
    out.headliners = liner;
    return out;
  });

  /**
   * ────────────────────────────────────────────────────────────────────────
   * CABIN CLOTH — MEASURED ON THE TEXELS THE BAKE EMITS, IN THE PAGE.
   * ────────────────────────────────────────────────────────────────────────
   * `headliner()` ships with NO albedo map and its own note says why: "makeFabric
   * peaks at 0.124 linear and a headliner is 0.28-0.36, which no colour
   * multiplier can reach from there." `material.color` is a MULTIPLY and
   * multiplies are ≤ 1, so that is a hard ceiling and not an opinion — which
   * makes it a measurable property of the emitted texels rather than of
   * anybody's intent.
   *
   * So this bakes BOTH cloths through the real module and reads their pixels
   * back. It is done in the page because the bakes are Canvas2D and there is no
   * canvas in node (and no new dependency is allowed to give it one, hard rule
   * 3); the module is the shipping one, served by the same vite this probe
   * already runs, so nothing here is a re-implementation of what it measures.
   *
   * THE NEGATIVE CONTROL IS BUILT IN AND IS TAKEN EVERY RUN: the identical
   * measurement on `makeFabric`, which must FAIL the liftability test the new
   * bake passes. If both passed, this would be measuring nothing — a seat cloth
   * that can be a headliner means the second bake never needed to exist.
   *
   * Linear, because reflectance is linear and an sRGB mean of a multiply is not
   * proportional to anything.
   */
  cloth = await page.evaluate(async () => {
    const mod = await import('/src/vehicles/textures.js');
    const s2l = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const read = (tex) => {
      const img = tex.image;
      const g = img.getContext('2d');
      const d = g.getImageData(0, 0, img.width, img.height).data;
      const lums = [];
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const L = 0.2126 * s2l(d[i] / 255) + 0.7152 * s2l(d[i + 1] / 255) + 0.0722 * s2l(d[i + 2] / 255);
        lums.push(L);
        sum += L;
      }
      lums.sort((a, b) => a - b);
      const p = (q) => lums[Math.min(lums.length - 1, Math.floor(lums.length * q))];
      const mean = sum / lums.length;
      tex.dispose?.();
      return {
        n: lums.length,
        mean: +mean.toFixed(4),
        p05: +p(0.05).toFixed(4),
        p95: +p(0.95).toFixed(4),
        max: +lums[lums.length - 1].toFixed(4),
        // The weave, as a fraction of the cloth's own level: a modulation, not
        // a level, so it survives whatever `color` the material tints it with.
        weave: +((p(0.95) - p(0.05)) / Math.max(1e-6, mean)).toFixed(4),
      };
    };
    return {
      seat: read(mod.makeFabric(256)),
      headliner: typeof mod.makeHeadlinerCloth === 'function'
        ? read(mod.makeHeadlinerCloth(256))
        : null,
    };
  });
} finally {
  await browser.close();
  if (server) server.kill();
}

/* ------------------------------------------------------------------ */
/* assertions                                                          */
/* ------------------------------------------------------------------ */

const checks = [];
const check = (id, ok, label, detail) => checks.push({ id, ok: !!ok, label, detail });

const C = results.car ?? {};
const K = results.cockpit ?? {};
const NE = results.carNoEnv ?? {};

/**
 * THE ORDERED COLOUR HAS TO BE ON THE CAR.
 *
 * Chroma floors, not colour matches: the beauty car's paint is drawn from a
 * pool, so the assertion cannot name a hue. What it can say is that the body is
 * not grey. Pre-campaign the bonnet measured chroma 0.297 with a 0.34 linear
 * white pedestal under it; every colour in `common` and `loud` except
 * `oxide white` and `sand` carries far more than 0.40 of its own.
 */
check('paint.bonnet', (C.bonnet?.chroma ?? 0) >= 0.34,
  'the bonnet still carries the colour it was ordered in',
  `chroma ${C.bonnet?.chroma} (min 0.34), rgb ${C.bonnet?.r}/${C.bonnet?.g}/${C.bonnet?.b}`);

check('paint.flank', (C.flank?.chroma ?? 0) >= 0.34,
  'so does the door skin, which faces the street rather than the sky',
  `chroma ${C.flank?.chroma} (min 0.34)`);

/**
 * A PANEL TURNED AWAY FROM THE SKY MUST BE DARKER AND MORE SATURATED THAN ONE
 * FACING IT. That difference IS the clearcoat: a lobe that returns the sky is
 * the only thing that can make two pieces of the same paint read differently.
 * A flat, formless paint scores near 1 here.
 */
const shade = (C.nose?.lum ?? 1) / Math.max(1, C.bonnet?.lum ?? 1);
check('paint.lobe', shade < 0.92,
  'the clear layer returns the sky, so the crown and the wing are not the same value',
  `wing/bonnet luminance ${shade.toFixed(3)} (max 0.92)`);

/**
 * ...and it must not do it by turning the panel into noise. `sd` is the
 * luminance standard deviation inside one flat patch of door skin; a smeared
 * clearcoat normal is exactly what drives it up.
 */
check('paint.smooth', (C.flank?.sd ?? 99) < 24,
  'the door skin is a panel, not a mottle',
  `luminance sd ${C.flank?.sd} (max 24)`);

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE PAINT'S OWN ENV LEVEL REACHES THE FRAME
 * ────────────────────────────────────────────────────────────────────────────
 * This is the gate `paint.js`'s ablation note asked for. It measured
 * `envMapIntensity` 0.71 -> 0 moving the bonnet by UNDER ONE COUNT and
 * concluded the slot was dead; the cause was three overwriting the uniform with
 * `scene.environmentIntensity` for any material without an `envMap` of its own,
 * and the fix is `render.bindEnvMaterials` (see the note there).
 *
 * The assertion is a DIFFERENCE, not a level, because that is the claim: the
 * number the paint asks for has to be the number the frame gets. Removing the
 * environment from a clearcoated body panel under an overcast sky is a large,
 * unambiguous move — MEASURED at 48.0 luminance counts, 139.4 down to 91.4,
 * with chroma running the other way as the white pedestal comes off the
 * pigment.
 *
 * THE FLOOR IS BRACKETED BY TWO MEASUREMENTS RATHER THAN CHOSEN. The live tree
 * produces 48.0; `--control=deadenv`, which is the same ablation against the
 * pre-fix binding, produces 1.6 — and 1.6 is what `paint.js` was looking at
 * when it wrote "under one count" and concluded the slot was dead. 12 sits a
 * quarter of the way to the live figure and seven times the null one, so
 * neither drift nor a partial regression can land on the wrong side of it.
 *
 * `--control=deadenv` restores the pre-fix binding and must take this red.
 */
const envDelta = Math.abs((C.bonnet?.lum ?? 0) - (NE.bonnet?.lum ?? 0));
check('paint.envlive', envDelta >= 12,
  'the environment the paint asks for is the environment it gets',
  `bonnet luminance ${C.bonnet?.lum} with env, ${NE.bonnet?.lum} without ` +
  `(delta ${envDelta.toFixed(1)}, min 12)`);

/**
 * ...AND IT ARRIVES AS A HIGHLIGHT, NOT AS A LEVEL.
 *
 * An environment that only raised the panel's average would be a fill light
 * wearing a clearcoat's name. What a clear layer does is return the sky as a
 * BAND across the crown, so the bright tail of the patch pulls away from its
 * median. `p99 - p50` is that separation, measured inside one flat piece of
 * bonnet so the only thing that can produce it is the shading.
 *
 * Both halves are asserted, and the second is what makes it about the clearcoat
 * rather than about the flake normal map: the tail has to be there, and it has
 * to LEAVE when the environment does. A geometric or albedo texture would keep
 * its variance with the env at zero.
 */
const tail = (C.bonnet?.p99 ?? 0) - (C.bonnet?.p50 ?? 0);
const tailNoEnv = (NE.bonnet?.p99 ?? 0) - (NE.bonnet?.p50 ?? 0);
check('paint.highlight', tail >= 10 && tailNoEnv < tail * 0.75,
  'the clear layer returns the sky as a highlight across the crown',
  `bonnet p99-p50 ${tail.toFixed(1)} (min 10), without env ${tailNoEnv.toFixed(1)} ` +
  `(must be under ${(tail * 0.75).toFixed(1)})`);

/**
 * GLASS IS TINTED, NOT PAINTED. Two things have to be true at once: the pane
 * cannot sit on the black floor, and it has to carry STRUCTURE — the cabin
 * behind it and the sky on it — which a flat black pane cannot.
 */
/**
 * ...and the pane is mostly reporting on WHAT IS BEHIND IT, which is the point.
 * Pre-campaign this region measured 30/34/43 with the cabin drawn as a hole;
 * it now measures 46 with a lined one. `--control=flat` shows the gate can
 * still catch an opaque pane, and `--control=void` shows that darkening the
 * cabin alone is enough to take these down — which is the real causal chain
 * behind the review's phrase.
 */
check('glass.lit', (C.glass?.lum ?? 0) > 40,
  'the windscreen is glazed rather than blacked out',
  `luminance ${C.glass?.lum} (min 40)`);

check('glass.structure', (C.glass?.sd ?? 0) > 20,
  'there is something to see through it',
  `luminance sd ${C.glass?.sd} (min 20)`);

/**
 * THE CABIN HAS A ROOF. Pre-campaign the cockpit's upper third measured 23/28/33
 * — a hole where a headliner belongs, and the top third of the frame.
 */
check('cabin.lined', (K.roof?.lum ?? 0) > 52,
  'the cabin ceiling is a lined surface, not a hole',
  `luminance ${K.roof?.lum} (min 52), rgb ${K.roof?.r}/${K.roof?.g}/${K.roof?.b}`);

check('cabin.notblack', (K.roof?.darkFrac ?? 1) < 0.25,
  'and almost none of it is at the black floor',
  `fraction under L=40: ${K.roof?.darkFrac} (max 0.25)`);

/** The world is still visible out of the screen — a lining is not a blindfold. */
check('cabin.aperture', (K.aperture?.lum ?? 0) > 60,
  'the road is still there through the windscreen',
  `luminance ${K.aperture?.lum} (min 60)`);

/**
 * ...AND THE FRAME CONTAINS A DASHBOARD.
 *
 * The three assertions above can all be satisfied by a lens sitting on the
 * bonnet: a bright thing at the top, the world in the middle, no black. What
 * separates the driver's seat from a hood-cam is that the car's own instruments
 * are in the picture, below the rim and lit by nothing but the cabin's share of
 * the sky. This region is the binnacle face left of the steering boss, and it
 * is the one the OLD staged eye could not have held — it was 29 cm further back
 * and aimed above the belt line, with the dash out of frame entirely.
 */
check('cabin.binnacle', (K.binnacle?.lum ?? 0) > 30 && (K.binnacle?.darkFrac ?? 1) < 0.35,
  'the instrument binnacle is in the frame and lit',
  `luminance ${K.binnacle?.lum} (min 30), fraction under L=40 ${K.binnacle?.darkFrac} (max 0.35)`);

/** The parts that have to exist, counted in the live scene graph. */
check('cabin.parts', (materials?.headliners ?? 0) > 0 && (materials?.steeringWheels ?? 0) > 0,
  'a headliner mesh and a steering-wheel mesh are in the frame',
  `headliners ${materials?.headliners}, steering wheels ${materials?.steeringWheels}`);

/* ---- the fourth view lands in the cabin, on every car class ---------- */
const CABIN_CLASSES = ['sports', 'muscle', 'sedan', 'suv', 'pickup', 'van'];
const eyeRows = [];
let eyeIn = 0;
let eyeSide = 0;
for (const id of CABIN_CLASSES) {
  const { spec, local } = solveFourthView(id, CONTROL === 'hood');
  const st = spec.style;
  // Vehicle-local, origin at the CoM: the shell runs `-comY` to `dims.H - comY`.
  const y = local.y + spec.comY;
  const inside =
    local.z < st.cowlZ - 0.10 && local.z > st.backlightBaseZ &&
    y > st.sillY && y < st.roofY - 0.10 &&
    Math.abs(local.x) < st.hwMax * 0.95;
  const driver = local.x > st.hwMax * 0.15;
  if (inside) eyeIn++;
  if (driver) eyeSide++;
  eyeRows.push(`${id} (${local.x.toFixed(2)}, ${y.toFixed(2)}, ${local.z.toFixed(2)}) ` +
    `cabin z<${(st.cowlZ - 0.10).toFixed(2)} y<${(st.roofY - 0.10).toFixed(2)}`);
}
check('cockpit.inside', eyeIn === CABIN_CLASSES.length,
  'the fourth view puts the lens inside the cabin on every car class',
  `${eyeIn}/${CABIN_CLASSES.length} inside — ${eyeRows.join(' | ')}`);
check('cockpit.driverside', eyeSide === CABIN_CLASSES.length,
  '...and on the driver\'s side of it, not on the centreline',
  `${eyeSide}/${CABIN_CLASSES.length} on the car's left`);

/* ---- cabin cloth --------------------------------------------------- */
/**
 * THE HEADLINER BAND IS 0.28-0.36 LINEAR and it is not this file's opinion:
 * it is the reflectance `paint.js` names for a lining, and the reason it gives
 * for the lining having no albedo map at all. The bar here is therefore
 * "somewhere in this map is a texel a lining could be made of" — `max >= 0.28`,
 * with the mean held inside the band so the lift is the CLOTH's value and not
 * one bright fleck.
 *
 * The seat bake is measured with the same code every run and must fail that
 * same test. It is the control, and it is also the reason the second bake
 * exists.
 */
const CH = cloth?.headliner ?? null;
const CS = cloth?.seat ?? null;
check('cloth.liftable', !!CH && CH.max >= 0.28,
  'the headliner bake reaches a lining\'s reflectance (max >= 0.28 linear)',
  CH ? `max ${CH.max}, mean ${CH.mean}, p05 ${CH.p05}, p95 ${CH.p95}` : 'makeHeadlinerCloth missing');
check('cloth.band', !!CH && CH.mean >= 0.26 && CH.mean <= 0.36,
  '...as its MEAN, not as one bright texel — 0.26..0.36 linear',
  CH ? `mean ${CH.mean}` : 'n/a');
check('cloth.weave', !!CH && CH.weave >= 0.05,
  '...and it carries a visible weave: p95-p05 over the mean',
  CH ? `${CH.weave} (seat cloth ${CS?.weave ?? '?'})` : 'n/a');
check('cloth.control', !!CS && CS.max < 0.28,
  'CONTROL: the SEAT bake cannot be lifted to a lining, which is why there are two',
  CS ? `makeFabric max ${CS.max} linear, mean ${CS.mean}` : 'n/a');

/* ------------------------------------------------------------------ */

const pass = checks.filter((c) => c.ok).length;
if (VERBOSE || CONTROL) {
  console.log(JSON.stringify({ control: CONTROL, results, materials, cloth }, null, 2));
}
for (const c of checks) {
  console.log(`  ${c.ok ? ' ok ' : 'FAIL'}  ${c.label}\n          ${c.detail}`);
}
if (logs.length) console.log(logs.slice(0, 6).join('\n'));
console.log(`\npaintprobe: ${pass}/${checks.length} checks passed${CONTROL ? ` (control=${CONTROL})` : ''}`);

if (CONTROL) {
  // A control run is expected to FAIL its target assertions; the harness reports
  // which went red so a decorative gate is visible as one that did not.
  console.log(`red under control: ${checks.filter((c) => !c.ok).map((c) => c.id).join(', ') || 'NONE — the gate is decorative'}`);
  process.exit(0);
}
process.exit(pass === checks.length ? 0 : 1);
