#!/usr/bin/env node
/**
 * MOVEPROBE — the jump arc and the gait tiers, measured on the real build.
 *
 * Two player reports produced this file:
 *
 *   "jump is not high enough"
 *   "shift to run or nitro doesn't always work (is this limited to which gun
 *    is being held?)"
 *
 * Both are things a still frame cannot show and a single scripted run reports
 * wrongly, so this drives the shipping build through a browser with REAL key
 * events and reports DISTRIBUTIONS, never one number.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHAT IT MEASURES, AND WHY IT IS NOT CIRCULAR (hard rule 12)
 *
 * The jump suite never reads `JUMP_SPEED`, `JUMP_APEX`, `velocity.y` or any
 * other intermediate the movement code used to build the arc. It records the
 * EMITTED TRAJECTORY — `player.position.y` per rendered frame — and reports the
 * apex above the surface the character was measurably standing on, which it
 * establishes by watching the capsule settle rather than by asking the terrain
 * function that placed it. The two differ by whole kerbs.
 *
 *   What input would make this fail?  Any change that lowers the arc, adds
 *   variance to it, or lets something else (a mantle, a ground snap, a step-up)
 *   eat it. Reverting the fix takes the spread from 0.09 m to 0.60 m and the
 *   median from 0.95 m to 0.21 m — see the negative control in the report.
 *
 * The apex is refined by fitting a parabola through the three samples around
 * the peak sample, so a 60 Hz sampler does not quantise the answer. Sites where
 * the capsule never settled, or where the jump turned into a mantle/vault, are
 * REPORTED SEPARATELY rather than being dropped — a probe that silently skips
 * the awkward sites is how the 0.21 m case hid.
 *
 * The sprint suite drives Shift the way a player does (page.keyboard.down),
 * through the transitions where it plausibly breaks, and scores a PASS RATE
 * over many attempts per scenario. It reports the achieved speed against the
 * active brother's DESIGN.md run speed, not against whatever the code asked
 * for.
 *
 * ONE SCENARIO HOLDS NO KEY AT ALL, AND IT IS SCORED AS ITS OWN TIER. Full
 * deflection engages a committed gait with no key held; Shift promotes it to
 * the brother's authored run. `W alone, no Shift (jog tier)` therefore asserts
 * `jogging` and `MOVE.autoJogScale` of the run, while the eleven rows that hold
 * Shift assert `sprinting` and the whole run — and every row asserts that the
 * OTHER tier never latched. Two opposite reports produced that shape: "I always
 * need to hold in the run button to move fast enough", and then, on the build
 * that answered it, "player walks a little too fast and run doesn't seem to do
 * anything now". A single-tier score cannot be red for both.
 *
 * THE SPRINT SUITE NOW CHOOSES ITS OWN GROUND, and that is not housekeeping.
 * `sites()` classifies TERRAIN, and a flat tile can have a bench on it; an
 * attempt covers 8-9.5 m and a contact at that speed is a stumble, which ends
 * a sprint correctly. Measured on one build, the same twelve scenarios scored
 * 12/12 in isolation, 3/12 after an 8-site jump phase and 1/12 after the full
 * 40-site phase — the difference being that `props` only dresses a tile once
 * its BVH settles, so the site is bare early in a session and furnished later.
 * The phase now stands on six candidate sites and RAY-CASTS eight headings off
 * each (`__MP__.clearHeading`), then runs down the one with room. With that,
 * the same build scores 12/12 after the jump phase too.
 *
 *   node src/player/moveprobe.mjs
 *   node src/player/moveprobe.mjs --only=jump --sites=48
 *   node src/player/moveprobe.mjs --only=sprint --reps=4
 *   node src/player/moveprobe.mjs --json=/tmp/before.json
 *
 * ──────────────────────────────────────────────────────────────────────────
 * IT TAKES ABOUT 14 AND A HALF MINUTES. IT IS NOT HUNG.
 *
 * Measured end to end on a full default run: 14 min 25 s, exit 0. It scored
 * 9/11 gates when that timing was taken; it is 11/11 on the build that added
 * auto-run, and the two reds it used to carry went green for two different
 * reasons — the sprint latch by the auto-run work, the nitro A/B by whoever
 * was in `src/vehicles/` at the same time. Neither number is a claim about
 * your tree: run it.
 * Unlike the other harnesses this one cannot be stepped: it drives REAL key
 * events through a REAL browser and has to pump REAL rendered frames between
 * them, four gaits at each of ~40 sites, plus the sprint scenarios and a
 * counterbalanced nitro A/B. That is inherent to what it measures, not slack.
 *
 * It used to print NOTHING until the very end, which is indistinguishable from
 * a hang. It now writes a progress line to stderr for
 * every phase (stderr, so `--json` and any piping of the report stay clean).
 *
 * While iterating, cut the wait rather than waiting: `--only=jump --sites=8`
 * is about 40 s and still covers all four gaits and all four ground classes.
 *
 * It is NOT on the pre-handoff list (`npm run handoff`) for the same reason —
 * fifteen minutes is not a thing anyone will run before every handoff. Run it
 * when you have touched the jump arc, the sprint latch, or the nitro channel.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { startServer, stopServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const ONLY = args.only ?? 'all';
const SITES = Number(args.sites ?? 40);
const REPS = Number(args.reps ?? 3);
/** `--dump=N` keeps the raw per-frame trajectory of the first N jumps. */
const DUMP = Number(args.dump ?? 0);

/* ====================================================================== */
/* stats                                                                  */
/* ====================================================================== */

const q = (arr, p) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const dist = (arr) => ({
  n: arr.length,
  min: q(arr, 0), p25: q(arr, 0.25), med: q(arr, 0.5), p75: q(arr, 0.75), max: q(arr, 1),
  spread: q(arr, 1) - q(arr, 0),
});
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '--');
const fmtDist = (d) =>
  `n=${d.n}  min ${f2(d.min)}  p25 ${f2(d.p25)}  MED ${f2(d.med)}  p75 ${f2(d.p75)}  max ${f2(d.max)}  spread ${f2(d.spread)}`;

/* ====================================================================== */
/* bring-up                                                               */
/* ====================================================================== */

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

const report = { jump: null, sprint: null, nitro: null, brothers: null, errs };

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(120);

  /* ---- in-page helpers ------------------------------------------------- */
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true;
    e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);

    const P = () => e.ctx.peek('player');
    const M = () => P().movement;

    const MP = {
      /**
       * Candidate stand-on-able sites, classified by the SHAPE OF THE GROUND
       * under the capsule footprint rather than by what the city calls itself.
       * A "kerb" is a 0.15 m discontinuity whatever district it is in.
       */
      sites(n) {
        const w = e.ctx.peek('world');
        const R = 0.32;                       // capsule radius
        const h = (x, z) => w.walkableHeightAt(x, z);
        const out = { flat: [], slope: [], step: [], kerb: [] };

        const classify = (x, z) => {
          const c = h(x, z);
          if (!Number.isFinite(c)) return null;
          const s = [h(x + R, z), h(x - R, z), h(x, z + R), h(x, z - R)];
          if (s.some((v) => !Number.isFinite(v))) return null;
          const all = [c, ...s];
          const span = Math.max(...all) - Math.min(...all);
          const gx = (s[0] - s[1]) / (2 * R);
          const gz = (s[2] - s[3]) / (2 * R);
          const grad = Math.hypot(gx, gz);
          // A plane through the samples explains a slope; the residual is what
          // a kerb, a stair nose or a wall base leaves behind.
          const resid = Math.max(...all.map((v, i) => {
            const dx = i === 1 ? R : i === 2 ? -R : 0;
            const dz = i === 3 ? R : i === 4 ? -R : 0;
            return Math.abs(v - (c + gx * dx + gz * dz));
          }));
          const rec = { x, z, y: c, grad: +grad.toFixed(3), span: +span.toFixed(3), resid: +resid.toFixed(3), surf: w.surfaceAt?.(x, z) ?? '?' };
          // A step is a DISCONTINUITY the plane cannot explain; a slope is a
          // plane. Testing residual first would file every rough hillside as a
          // step, which is how the slope bucket came back empty on the first run.
          if (resid > 0.14) return { ...rec, cls: 'step' };
          if (grad > 0.18) return { ...rec, cls: 'slope' };
          if (resid > 0.06) return { ...rec, cls: 'step' };
          if (span < 0.03) return { ...rec, cls: 'flat' };
          return null;
        };

        // Deterministic lattice + jitter (no Math.random: reproducible runs).
        let seed = 0x9e3779b9 >>> 0;
        const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
        const half = (w.CITY_SIZE ?? 3000) * 0.42;
        for (let i = 0; i < 24000 && (out.flat.length < n || out.slope.length < n || out.step.length < n); i++) {
          const x = (rnd() * 2 - 1) * half;
          const z = (rnd() * 2 - 1) * half;
          if (w.isWater?.(x, z)) continue;
          const c = classify(x, z);
          if (!c) continue;
          if (out[c.cls].length < n) out[c.cls].push(c);
        }

        /* Kerbs, taken off the road graph rather than found by luck: stand on
         * the pavement lip exactly half a carriageway from the lane centre. */
        const roads = w.roads;
        if (roads?.edges?.length) {
          const v = { x: 0, y: 0, z: 0 };
          const a = { x: 0, y: 0, z: 0 };
          for (let i = 0; i < roads.edges.length && out.kerb.length < n; i += 3) {
            const ed = roads.edges[i];
            if (!ed) continue;
            try {
              roads.laneCenter(ed.id, 0, 0.45, v);
              roads.laneCenter(ed.id, 0, 0.55, a);
              const dx = a.x - v.x, dz = a.z - v.z;
              const l = Math.hypot(dx, dz);
              if (l < 1e-3) continue;
              const nx = -dz / l, nz = dx / l;
              const off = (ed.width ?? 8) * 0.5 + 0.35;
              const x = v.x + nx * off, z = v.z + nz * off;
              if (w.isWater?.(x, z)) continue;
              const y = h(x, z);
              if (!Number.isFinite(y)) continue;
              out.kerb.push({ x, z, y, cls: 'kerb', grad: 0, span: 0, resid: 0, surf: w.surfaceAt?.(x, z) ?? '?' });
            } catch { /* edge without a lane solve */ }
          }
        }
        return out;
      },

      /** Put the capsule 0.6 m above a site and let it fall onto whatever is
       *  really there — geometry, not the analytic field. */
      place(x, z, yaw = 0, lift = 0.6) {
        const p = P(), m = M();
        const phys = e.ctx.peek('physics');
        const w = e.ctx.peek('world');
        let gy = phys?.groundHeight?.(x, z, (w?.walkableHeightAt?.(x, z) ?? 0) + 40);
        if (!Number.isFinite(gy)) gy = w?.walkableHeightAt?.(x, z) ?? 0;
        m.scriptedInput = null;
        m.teleport(x, gy + lift, z, yaw);
        p.rig.reset(m.anchorHeight, m.position, yaw);
        p.animator?.reset();
        return { gy };
      },

      /**
       * OWN THE SITE BEFORE MEASURING ON IT.
       *
       * The sprint phase runs after the jump phase has teleported the character
       * to forty sites across the whole city, and by then the world around the
       * open site is not the world the site was chosen for: traffic has spawned
       * on it, a wanted level may be live, and the character may be carrying
       * damage from a fall. All three end a sprint legitimately —
       * `MOVE.stumble` on a contact, police fire, a hard landing — so a run
       * scored on that ground is not a measurement of the sprint latch.
       *
       * MEASURED, one build, three ways of reaching the same twelve scenarios:
       * isolated (`--only=sprint`) 12/12 at 6.40 m/s; after an 8-site jump
       * phase, 3/12 with the SAME 6.40 m/s top speed but the state dropping out
       * mid-run; after the full 40-site phase, 1/12 and a top speed of 2.94 m/s
       * — which is `MOVE.airSpeedCap` (3.0), i.e. a character who was never on
       * the ground at all. The gate was reading the city, not the sprint.
       */
      clearSite(x, z, r = 70) {
        const p = P();
        const veh = e.ctx.peek('vehicles');
        e.ctx.peek('police')?.clearWanted?.('probe');
        for (const o of (veh?.active ?? veh?.vehicles ?? []).slice()) {
          if (!o?.position) continue;
          const dx = o.position.x - x, dz = o.position.z - z;
          if (dx * dx + dz * dz < r * r) veh?.despawn?.(o);
        }
        // A fall from the jump phase must not be the reason a sprint stumbles.
        p.health?.reset?.(true);
        return true;
      },

      /**
       * WHICH WAY IS THERE ROOM TO RUN?
       *
       * `sites()` classifies TERRAIN — gradient and planarity — and a tile can
       * be perfectly flat and have a lamp post, a bench or a wall standing on
       * it. That is not a hypothetical: the sprint scenarios below hold the key
       * for 1.2 s, which is 8 m at 6.4 m/s and 9.5 m at Dylan's 7.9, and a
       * contact at that speed IS a stumble (`MOVE.stumble.wallSpeed` 5.2), which
       * correctly ends the sprint. Scored on that ground the gate reports the
       * street furniture rather than the latch.
       *
       * It is also why the same twelve scenarios pass in isolation and fail
       * after the jump phase: the props pass only dresses a tile once its BVH
       * is settled (see ARCHITECTURE.md rule 8), so early in a session the site
       * is bare and forty sites later it is furnished.
       *
       * So the heading is MEASURED, not assumed: eight of them, each scored by
       * how far a ray gets down the run line AND down the line the direction-
       * change test swaps onto, at two heights. Call it after the character is
       * standing on the site so the tile is really built.
       */
      clearHeading(x, z, dist = 16) {
        const phys = e.ctx.peek('physics');
        const w = e.ctx.peek('world');
        const V = Object.getPrototypeOf(P().position).constructor;
        let gy = phys?.groundHeight?.(x, z, (w?.walkableHeightAt?.(x, z) ?? 0) + 40);
        if (!Number.isFinite(gy)) gy = w?.walkableHeightAt?.(x, z) ?? 0;
        const o = new V();
        const d = new V();
        const reach = (dx, dz) => {
          let worst = dist;
          for (const h of [0.35, 1.2]) {
            o.set(x, gy + h, z);
            d.set(dx, 0, dz);
            const hit = phys?.raycast?.(o, d, dist, phys.MASK.CHARACTER);
            if (hit?.hit) worst = Math.min(worst, hit.distance);
          }
          return worst;
        };
        let best = { yaw: 0, room: -1 };
        for (let i = 0; i < 8; i++) {
          const yaw = (i / 8) * Math.PI * 2;
          const s = Math.sin(yaw), c = Math.cos(yaw);
          // Forward is (-sin, -cos) in this basis; the swap test runs LEFT.
          const room = Math.min(reach(-s, -c), reach(-c, s));
          if (room > best.room) best = { yaw, room: +room.toFixed(2) };
        }
        return best;
      },

      /** Wait until the capsule is genuinely at rest on something. */
      settle(maxFrames = 200) {
        return new Promise((res) => {
          const m = M();
          let i = 0, still = 0, last = m.position.y;
          const t = () => {
            const y = m.position.y;
            const moved = Math.abs(y - last);
            last = y;
            still = (m.grounded && moved < 2e-4 && Math.abs(m.velocity.y) < 0.05) ? still + 1 : 0;
            if (still >= 12) return res({ ok: true, y, frames: i, surf: m.character?.groundSurfaceName ?? '?' });
            if (++i >= maxFrames) return res({ ok: false, y, frames: i, surf: m.character?.groundSurfaceName ?? '?' });
            requestAnimationFrame(t);
          };
          requestAnimationFrame(t);
        });
      },

      /**
       * Record the emitted trajectory ONE SAMPLE PER FIXED STEP.
       *
       * A requestAnimationFrame sampler is the wrong instrument for an arc that
       * lasts 0.5 s: headless the page runs at 15-30 fps, which is 8-15 samples
       * for the whole jump, and the apex then depends on where the frame
       * boundaries happen to fall. Measured with the frame sampler, one
       * unchanged build read 0.52 to 0.62 m on flat asphalt — spread that is
       * entirely the instrument.
       *
       * So wrap `Movement.step`, which IS the 120 Hz clock the arc is built on.
       * The wrapper only reads and appends; it never touches the simulation, and
       * it lives in the probe, not in the game.
       */
      _hook() {
        const m = M();
        if (m.__mpHooked) return;
        m.__mpHooked = true;
        m.__mpLog = null;
        const orig = m.step.bind(m);
        m.step = (h) => {
          orig(h);
          const L = m.__mpLog;
          if (L) L.push({
            y: m.position.y, g: m.grounded ? 1 : 0, s: m.state,
            // Both committed tiers, separately: `run` is Shift's, `jog` is what
            // W alone latches. They are mutually exclusive by construction, so
            // a trace where both read 1 on the same step is itself a defect.
            sp: m.horizontalSpeed, run: m.sprinting ? 1 : 0, jog: m.jogging ? 1 : 0,
            ads: P().adsProgress, aim: m.aiming ? 1 : 0, vy: m.velocity.y, h,
            // So a sprint dropout can be attributed rather than guessed at.
            st: m.stumbleTime > 0 ? 1 : 0, bl: m.blocked ? 1 : 0,
            mag: m.cmd.mag,
          });
        };
      },
      /** Run the fixed-step recorder for `frames` rendered frames of wall time. */
      rec(frames) {
        MP._hook();
        const m = M();
        m.__mpLog = [];
        return new Promise((res) => {
          let i = 0;
          const t = () => {
            if (++i >= frames) { const out = m.__mpLog; m.__mpLog = null; return res(out); }
            requestAnimationFrame(t);
          };
          requestAnimationFrame(t);
        });
      },

      state() {
        const p = P(), m = M();
        const wp = e.ctx.peek('weapons');
        return {
          y: m.position.y, grounded: m.grounded, state: m.state, stance: m.stance,
          sprinting: m.sprinting, jogging: m.jogging, aiming: m.aiming, ads: p.adsProgress,
          // `run` is the brother's authored top tier, `jogTier` what W alone is
          // worth. Both read off the movement system rather than recomputed
          // here — a probe that recomputes the scale cannot catch it drifting.
          speed: m.horizontalSpeed, brother: p.brother?.id, run: m.sprintSpeed,
          jogTier: m.jogSpeed,
          weapon: wp?.current?.id ?? null, wcls: wp?.current?.cls ?? null,
          wads: wp?.adsProgress ?? null, hp: p.health?.value ?? null,
          fov: p.rig?.fov ?? null, boom: p.rig?.collideRadius ?? null,
        };
      },

      setWeapon(id) {
        const wp = e.ctx.peek('weapons');
        if (!wp) return null;
        try { wp.giveWeapon?.(id); wp.setWeapon(id); } catch { /* not in loadout */ }
        return wp.current?.id ?? null;
      },
      weapons() {
        const wp = e.ctx.peek('weapons');
        return { ids: wp?.weaponIds ?? [], cur: wp?.current?.id ?? null };
      },
      setBrother(id) { P().setBrother?.(id); return P().brother?.id; },

      /* ---- vehicle / nitro ---------------------------------------------- */

      /**
       * Put a clean test car on a real lane, pointing down it, and stand the
       * player beside it. Same construction as `tools/playprobe.mjs`: a car
       * spawned at yaw 0 faces wherever world +Z happens to be, which on half
       * the lanes is a wall, and then "boost does nothing" is a car driving
       * into a building.
       */
      spawnCar() {
        const pl = P(), veh = e.ctx.peek('vehicles'), w = e.ctx.peek('world');
        const p = pl.position;
        const roads = w?.roads;
        if (!roads?.nearestEdge || !veh?.spawn) return null;
        const hit = roads.nearestEdge(p.x, p.z, 300);
        if (hit?.edge == null) return null;
        const V = Object.getPrototypeOf(p).constructor;
        const id = hit.edge.id ?? hit.edge, lane = hit.lane ?? 0;
        const t0 = Math.min(0.88, (hit.t ?? 0.5) + 0.02);
        const a = new V(), b = new V();
        roads.laneCenter(id, lane, t0, a);
        roads.laneCenter(id, lane, Math.min(0.96, t0 + 0.06), b);
        const dx = b.x - a.x, dz = b.z - a.z;
        // A vehicle's nose is +Z, so a heading d needs yaw = atan2(d.x, d.z).
        const yaw = Math.hypot(dx, dz) > 0.05 ? Math.atan2(dx, dz) : 0;
        for (const other of [...(veh.active ?? veh.vehicles ?? [])]) {
          if (!other?.position) continue;
          const ox = other.position.x - a.x, oz = other.position.z - a.z;
          if (ox * ox + oz * oz < 26 * 26) veh.despawn?.(other);
        }
        const car = veh.spawn('sedan', { x: a.x, y: a.y + 0.6, z: a.z }, yaw, {});
        if (!car) return null;
        car._probeCar = true;
        MP._car = car;
        MP._carPose = { x: a.x, y: a.y + 0.6, z: a.z, yaw };
        pl.teleport?.(
          { x: a.x + Math.cos(yaw) * 2.4, y: a.y + 1.0, z: a.z - Math.sin(yaw) * 2.4 },
          { x: 0, y: 0, z: 0 }
        );
        return { x: +a.x.toFixed(1), z: +a.z.toFixed(1), yaw: +yaw.toFixed(2) };
      },

      /** Identical start state for both arms of the A/B. */
      resetCar(nitro) {
        const car = MP._car, pose = MP._carPose;
        if (!car || !pose) return false;
        const V = Object.getPrototypeOf(P().position).constructor;
        // setPose zeroes both velocities, which is exactly the clean start the
        // comparison needs — otherwise arm B inherits arm A's roll-out.
        car.setPose(new V(pose.x, pose.y, pose.z), pose.yaw);
        if (typeof nitro === 'number') P().vehicles.nitro = nitro;
        return true;
      },

      car() {
        const car = MP._car, pl = P();
        if (!car) return null;
        return {
          // SIGNED. `speed` is velocity.length() and a car being pushed
          // backwards scores the same as one being pushed forwards.
          fwd: +(car.forwardSpeed ?? 0).toFixed(3),
          speed: +(car.speed ?? 0).toFixed(3),
          // Did the boost actually REACH the car? Distinguishes "the player
          // never sent it" from "the car was sent it and ignored it".
          inBoost: car.input?.boost ?? null,
          inThrottle: +(car.input?.throttle ?? 0).toFixed(2),
          nitro: +pl.vehicles.nitro.toFixed(2),
          nitroOn: pl.vehicles.nitroOn,
          inVehicle: pl.inVehicle === true,
          hudNitro: pl.getHudState?.().nitroFraction ?? null,
          t: e.ctx.time.elapsed,
        };
      },

      /** Record the car's signed forward speed once per rendered frame. */
      recCar(frames) {
        return new Promise((res) => {
          const out = [];
          let i = 0;
          const t = () => {
            out.push(MP.car());
            if (++i >= frames) return res(out);
            requestAnimationFrame(t);
          };
          requestAnimationFrame(t);
        });
      },
      hurt(n) {
        e.events.emit('damage:dealt', { target: 'player', amount: n, headshot: false, killed: false, point: { x: 0, y: 0, z: 0 } });
        return P().health?.value ?? null;
      },
    };
    window.__MP__ = MP;
  });

  const mp = (fn, ...a) => page.evaluate(fn, ...a);

  /* ==================================================================== */
  /* JUMP                                                                 */
  /* ==================================================================== */

  if (ONLY === 'all' || ONLY === 'jump') {
    const sites = await page.evaluate((n) => window.__MP__.sites(n), Math.ceil(SITES / 4));
    const list = [...sites.flat, ...sites.slope, ...sites.step, ...sites.kerb];
    const rows = [];

    /**
     * A player does not jump from a dead stop on a car park. THE GAIT IS PART
     * OF THE INPUT: the first pass of this probe only ever measured a settled
     * standing jump and reported a flawless 0.60 +/- 0.01 m everywhere, while
     * `tools/playprobe.mjs` — which jumps straight out of a sprint — was
     * reporting 0.18 m on the same build. Both numbers were real. Measuring one
     * gait and calling it "the jump" is the same mistake as sampling the arc at
     * a fixed frame offset.
     */
    /* The middle row used to be `jog` on a bare W. Auto-run made W and Shift+W
     * the SAME gait, so that row would have been the sprint row measured twice
     * — a quarter of a fifteen-minute probe spent proving a thing to itself.
     * It is the WALK modifier instead, which restores a genuinely slow gait to
     * the set: the four now span 0, 1.72 and 6.4 m/s. */
    const GAITS = [
      { id: 'stand', keys: [], settle: 0 },
      { id: 'walk', keys: ['KeyW', 'AltLeft'], settle: 34 },
      { id: 'run', keys: ['ShiftLeft', 'KeyW'], settle: 46 },
      { id: 'run-release', keys: ['ShiftLeft', 'KeyW'], settle: 46, release: true },
    ];

    /**
     * PROGRESS, ON stderr, BECAUSE SILENCE READS AS A HANG.
     *
     * This probe drives REAL key events through a REAL browser at REAL time —
     * `page.keyboard.down` plus a pump of rendered frames, per gait, per site —
     * and it prints nothing until every measurement is in. A full run is about
     * **14.5 minutes** (measured: 93 usable jumps over 4 gaits x ~40 sites,
     * plus the sprint scenarios and the counterbalanced nitro A/B). Half an
     * hour of silence is indistinguishable from a hang from the outside.
     *
     * stderr, not stdout, so `--json` and any piping of the report stay clean.
     * Cut the wait with `--only=jump --sites=8` (about 40 s) while iterating.
     */
    const total = list.length * GAITS.length;
    let done = 0;
    const tick = (label) => {
      done++;
      process.stderr.write(
        `\rmoveprobe: jump ${done}/${total} sites  (${label})            `
      );
    };

    for (const s of list) {
      for (const g of GAITS) {
        tick(`${s.cls}/${g.id}`);
        await page.evaluate(([x, z]) => window.__MP__.place(x, z, 0), [s.x, s.z]);
        const settled = await page.evaluate(() => window.__MP__.settle());
        if (!settled.ok) { rows.push({ ...s, gait: g.id, ok: false, why: 'never settled' }); continue; }

        for (const k of g.keys) await page.keyboard.down(k);
        if (g.settle) await pump(g.settle);
        if (g.release) { for (const k of g.keys) await page.keyboard.up(k); await pump(3); }

        const trace = page.evaluate((f) => window.__MP__.rec(f), 90);
        // THE RECORDER MUST BE RUNNING BEFORE THE KEY LANDS. Without this pump
        // the first sample of the trace was already 2 fixed steps into the
        // ascent, so the "take-off surface" was read 0.16 m up the arc and the
        // apex came out 0.21-0.46 m on a build whose jump is a flat 0.60 m
        // everywhere. That is the whole reported "0.21 to 0.93" spread, and it
        // was the harness, not the game.
        await pump(6);
        await page.keyboard.down('Space');
        await pump(3);
        await page.keyboard.up('Space');
        const t = await trace;
        if (!g.release) for (const k of g.keys) await page.keyboard.up(k);
        await pump(4);

        /* ---- read the arc out of the emitted trajectory ------------------
         * take-off  = the last FIXED STEP the capsule was grounded before it
         *             left the surface
         * apex      = the highest sampled position of the air phase. At 120 Hz
         *             the sample either side of the true apex is under a
         *             millimetre below it, so no curve fitting is needed and
         *             none is done — the number is a measured position.
         * A mantle/vault is flagged, not silently dropped: it is a different
         * mechanic that happens to consume the same key. */
        /* Locate the LAUNCH, not the first airborne step.
         *
         * `CharacterController.probeGround` sweeps 0.06 m down, and one fixed
         * step of a jump only lifts the capsule ~0.05 m, so the step on which
         * the impulse is applied still reports `grounded`. Taking the first
         * !grounded step as take-off therefore read the surface one step up the
         * arc and under-reported every jump in this build by a constant 0.042 m
         * — enough to matter when the question is "is it high enough".
         *
         * The launch is the step where the vertical velocity jumps upward
         * discontinuously. `vy` is used ONLY to find that index; the height is
         * still measured entirely from emitted positions. */
        let launch = -1;
        for (let i = 1; i < t.length; i++) {
          if (t[i].vy > 1 && t[i].vy - t[i - 1].vy > 1) { launch = i; break; }
        }
        let mantled = false;
        let end = t.length;
        if (launch > 0) {
          for (let i = launch + 1; i < t.length; i++) {
            if (t[i].s === 'mantle' || t[i].s === 'vault') { mantled = true; end = i; break; }
            if (t[i].g && t[i].vy <= 0) { end = i; break; }
          }
        }
        if (launch < 1) { rows.push({ ...s, gait: g.id, ok: true, jumped: false, mantled }); continue; }

        const first = launch;
        const takeoff = t[launch - 1].y;
        const air = t.slice(launch, end);
        let peak = takeoff;
        for (const r of air) if (r.y > peak) peak = r.y;
        const airTime = air.reduce((a, r) => a + r.h, 0);
        // Independent sanity number on the SAME samples: a free ballistic arc
        // of this air time implies g = 8 * apex / airTime^2. If that does not
        // land near the engine's gravity, something is holding the character up
        // or pulling him down and the apex is not a jump measurement.
        const gImplied = airTime > 1e-3 ? (8 * (peak - takeoff)) / (airTime * airTime) : NaN;

        rows.push({
          ...s, gait: g.id, ok: true, mantled, jumped: true,
          apex: peak - takeoff, takeoff,
          gImplied: +gImplied.toFixed(2),
          steps: air.length,
          airTime: +airTime.toFixed(3),
          netRise: +(t[end - 1] ? t[Math.min(end, t.length - 1)].y - takeoff : 0).toFixed(3),
          speed: +(t[first - 1].sp ?? 0).toFixed(2),
          trace: DUMP && rows.length < DUMP
            ? t.map((r) => [+r.y.toFixed(4), r.g, +r.vy.toFixed(2), r.s]) : undefined,
        });
      }
    }

    /**
     * Keep only arcs that were actually FREE BALLISTIC flight.
     *
     * "Apex above the take-off surface" only measures the jump impulse if the
     * ground did not move under the character between leaving it and coming
     * back. Sprinting off a hillside, or landing on top of the kerb you jumped
     * over, produces a real trajectory whose height is mostly terrain — one
     * such arc in this build reads 1.54 m over a 1.4 s air phase, which is
     * simply not a 0.61 s jump.
     *
     * `gImplied = 8 * apex / airTime^2` is that test, and it is INDEPENDENT of
     * the impulse: a free arc must imply the engine's gravity whatever the jump
     * speed is. So this filter cannot hide the defect the gate exists for — if
     * the impulse varied, every arc would still be ballistic and the spread
     * would still open up. It only removes arcs that were never a measurement
     * of the impulse in the first place, and the count is reported.
     */
    const BALLISTIC = [15, 27]; // engine gravity is 20.6; probe bias is ~+1
    const clean = rows.filter(
      (r) => r.ok && !r.mantled && r.jumped &&
        r.gImplied >= BALLISTIC[0] && r.gImplied <= BALLISTIC[1]
    );
    const nonBallistic = rows.filter(
      (r) => r.ok && !r.mantled && r.jumped &&
        !(r.gImplied >= BALLISTIC[0] && r.gImplied <= BALLISTIC[1])
    );
    const byClass = {};
    for (const c of ['flat', 'slope', 'step', 'kerb']) {
      const a = clean.filter((r) => r.cls === c).map((r) => r.apex);
      if (a.length) byClass[c] = dist(a);
    }
    const byGait = {};
    for (const g of ['stand', 'walk', 'run', 'run-release']) {
      const a = clean.filter((r) => r.gait === g).map((r) => r.apex);
      if (a.length) byGait[g] = dist(a);
    }
    report.jump = {
      all: dist(clean.map((r) => r.apex)),
      byClass, byGait,
      mantled: rows.filter((r) => r.mantled).length,
      unsettled: rows.filter((r) => !r.ok).length,
      noJump: rows.filter((r) => r.ok && !r.jumped).length,
      nonBallistic: nonBallistic.length,
      nonBallisticDetail: nonBallistic.map((r) =>
        ({ cls: r.cls, gait: r.gait, surf: r.surf, apex: +r.apex.toFixed(2), airTime: r.airTime, gImplied: r.gImplied })),
      worst: [...clean].sort((a, b) => a.apex - b.apex).slice(0, 8)
        .map((r) => ({ cls: r.cls, gait: r.gait, surf: r.surf, apex: +r.apex.toFixed(3), grad: r.grad, resid: r.resid, speed: r.speed })),
      gImplied: dist(clean.filter((r) => Number.isFinite(r.gImplied)).map((r) => r.gImplied)),
      airTime: dist(clean.map((r) => r.airTime)),
      rows,
    };
  }

  /* ==================================================================== */
  /* SPRINT                                                               */
  /* ==================================================================== */

  if (ONLY === 'all' || ONLY === 'sprint') {
    /**
     * Somewhere open and level, so a failure is the sprint code and not a wall
     * — and "open" is now MEASURED on the site the character is standing on
     * rather than inferred from the terrain field. Six candidates, each stood
     * on long enough for its tile to finish dressing, and the first one with
     * room to run in some direction wins. See `__MP__.clearHeading`.
     */
    let open = null;
    let openYaw = 0;
    let openRoom = 0;
    {
      const cands = await page.evaluate(() => window.__MP__.sites(6).flat ?? []);
      for (const c of cands) {
        await page.evaluate(([x, z]) => window.__MP__.clearSite(x, z), [c.x, c.z]);
        await page.evaluate(([x, z]) => window.__MP__.place(x, z, 0), [c.x, c.z]);
        await page.evaluate(() => window.__MP__.settle(120));
        await pump(45); // let the tile finish streaming its props before asking
        const best = await page.evaluate(([x, z]) => window.__MP__.clearHeading(x, z), [c.x, c.z]);
        if (best.room > openRoom) { open = c; openYaw = best.yaw; openRoom = best.room; }
        if (openRoom >= 14) break;
      }
      if (!open) { open = cands[0] ?? null; }
      process.stderr.write(
        `\rmoveprobe: sprint site ${open ? `${open.x.toFixed(0)}, ${open.z.toFixed(0)}` : 'NONE'} ` +
        `· ${openRoom.toFixed(1)} m of room on heading ${(openYaw * 180 / Math.PI).toFixed(0)} deg          `
      );
    }

    /**
     * One attempt: from a standing start, hold Shift+W (or W alone) and see
     * which TIER the character reaches. Both halves are measured on the emitted
     * motion — `sprinting`/`jogging` are the state machine's own claim, `speed`
     * is the distance it actually covered.
     */
    const attempt = async (setup, { shift = true } = {}) => {
      await page.evaluate(([x, z]) => window.__MP__.clearSite(x, z), [open.x, open.z]);
      await page.evaluate(([x, z, y]) => window.__MP__.place(x, z, y), [open.x, open.z, openYaw]);
      await page.evaluate(() => window.__MP__.settle(120));
      if (setup) await setup();
      const trace = page.evaluate((f) => window.__MP__.rec(f), 75);
      if (shift) await page.keyboard.down('ShiftLeft');
      await page.keyboard.down('KeyW');
      await pump(70);
      await page.keyboard.up('KeyW');
      if (shift) await page.keyboard.up('ShiftLeft');
      const t = await trace;
      const tail = t.slice(Math.floor(t.length * 0.5));
      const st = await page.evaluate(() => window.__MP__.state());
      // Which flag this attempt is entitled to: Shift claims the top tier, W
      // alone claims the middle one. Scoring the W-alone row against `sprinting`
      // is exactly what made it green on the build the owner reported as having
      // a dead Shift key.
      const key = shift ? 'run' : 'jog';
      return {
        tier: key,
        everSprinted: t.some((r) => r[key] === 1),
        heldSprint: tail.filter((r) => r[key] === 1).length / Math.max(1, tail.length),
        // A tier is only itself if the OTHER one never latched: W alone
        // reaching `sprinting` would be the auto-run wave's bug returning.
        bledOver: t.some((r) => r[shift ? 'jog' : 'run'] === 1),
        topSpeed: Math.max(...t.map((r) => r.sp)),
        runSpeed: st.run,
        wantSpeed: shift ? st.run : st.jogTier,
        ads: Math.max(...t.map((r) => r.ads)),
        aimed: tail.some((r) => r.aim === 1),
        weapon: st.weapon, wcls: st.wcls,
      };
    };

    const scenarios = [];
    const wl = await page.evaluate(() => window.__MP__.weapons());

    // 1. Bare: whatever the brother spawns with.
    scenarios.push({ name: 'baseline (spawn weapon)', setup: null });

    /**
     * 1b. NO KEY AT ALL — the MIDDLE tier, scored on its own flag and its own
     * speed rather than on the run's.
     *
     * This row has been re-baselined twice by two opposite reports. It arrived
     * as "I always need to hold in the run button to move fast enough" and was
     * scored against `sprinting` and 85 % of the brother's run, which is what
     * W alone emitted at the time. The owner then played that build and filed
     * the other half: "player walks a little too fast and run doesn't seem to
     * do anything now" — and this row could not have caught it, because a W
     * that emits the run speed is exactly what it was asserting.
     *
     * So it now asserts the tier: `jogging` held for the second half, speed at
     * `MOVE.autoJogScale` of the run and NOT at the run, and `sprinting` never
     * latched at all (`bledOver`). Every other row still holds Shift and still
     * demands the full run, so the set says all three things at once — W alone
     * moves you, Shift is worth holding, and neither one is the other.
     */
    scenarios.push({ name: 'W alone, no Shift (jog tier)', setup: null, shift: false });

    // 2. One per weapon class — the player's own hypothesis.
    const byCls = { melee: 'pipe', light: 'smg', precise: 'harpoon', explosive: 'rocket' };
    for (const [cls, id] of Object.entries(byCls)) {
      scenarios.push({
        name: `holding ${id} (${cls})`,
        setup: async () => { await page.evaluate((w) => window.__MP__.setWeapon(w), id); await pump(40); },
      });
    }

    // 3. ADS entered and left again — a stuck aim state would show here.
    scenarios.push({
      name: 'after entering and leaving ADS',
      setup: async () => {
        await page.evaluate((w) => window.__MP__.setWeapon(w), 'smg');
        await pump(20);
        await page.mouse.down({ button: 'right' });
        await pump(30);
        await page.mouse.up({ button: 'right' });
        await pump(40);
      },
    });

    // 4. After landing a jump.
    scenarios.push({
      name: 'after landing a jump',
      setup: async () => {
        await page.keyboard.down('Space'); await pump(3); await page.keyboard.up('Space');
        await pump(60);
      },
    });

    // 5. After taking damage.
    scenarios.push({
      name: 'after taking damage',
      setup: async () => { await page.evaluate(() => window.__MP__.hurt(18)); await pump(20); },
    });

    // 6. After a melee swing.
    scenarios.push({
      name: 'after a melee swing',
      setup: async () => {
        await page.evaluate((w) => window.__MP__.setWeapon(w), 'pipe');
        await pump(20);
        await page.mouse.down({ button: 'left' }); await pump(4); await page.mouse.up({ button: 'left' });
        await pump(70);
      },
    });

    // 7. Crouch toggled on and off.
    scenarios.push({
      name: 'after a crouch toggle',
      setup: async () => {
        await page.keyboard.down('KeyC'); await pump(3); await page.keyboard.up('KeyC'); await pump(25);
        await page.keyboard.down('KeyC'); await pump(3); await page.keyboard.up('KeyC'); await pump(25);
      },
    });

    const rows = [];
    let scDone = 0;
    for (const sc of scenarios) {
      process.stderr.write(`\rmoveprobe: sprint ${++scDone}/${scenarios.length} scenarios  (${sc.name})            `);
      const runs = [];
      for (let i = 0; i < REPS; i++) runs.push(await attempt(sc.setup, { shift: sc.shift !== false }));
      /* Three conditions, all on the emitted motion: the tier's own flag held
       * through the back half, the tier's own speed reached (85 %, the same bar
       * the run has always had), and the OTHER tier never latched — a ceiling
       * as well as a floor, so a jog that quietly became a run fails here. */
      const pass = runs.filter((r) =>
        r.heldSprint > 0.6 && r.topSpeed > r.wantSpeed * 0.85 && !r.bledOver).length;
      rows.push({
        name: sc.name, reps: runs.length, pass, tier: runs[0].tier,
        rate: pass / runs.length,
        ever: runs.filter((r) => r.everSprinted).length,
        bled: runs.filter((r) => r.bledOver).length,
        topSpeed: dist(runs.map((r) => r.topSpeed)),
        runSpeed: runs[0].runSpeed,
        wantSpeed: runs[0].wantSpeed,
        ads: dist(runs.map((r) => r.ads)),
        weapon: runs[0].weapon, wcls: runs[0].wcls,
      });
    }

    /**
     * 8. Direction change while Shift stays down.
     *
     * THE CHECK HAS TO OWN ITS CONDITIONS. The first version sprinted 50 frames
     * in each of three directions across the open city and counted every
     * non-sprinting step afterwards, so it scored 2, 5 and 53 dropped frames on
     * three runs of the same build — it was measuring what the character
     * happened to run into, not the direction change. A sprint into a wall or a
     * kerb IS supposed to drop the sprint (`MOVE.stumble`), so a trial that
     * stumbles is not evidence either way and is reported as excluded.
     *
     * What is measured now: after each key swap, how many steps until sprint
     * re-engages, on trials where nothing was hit.
     */
    const changes = [];
    for (let rep = 0; rep < REPS; rep++) {
      await page.evaluate(([x, z]) => window.__MP__.clearSite(x, z), [open.x, open.z]);
      await page.evaluate(([x, z, y]) => window.__MP__.place(x, z, y), [open.x, open.z, openYaw]);
      await page.evaluate(() => window.__MP__.settle(120));
      const trace = page.evaluate((f) => window.__MP__.rec(f), 130);
      await page.keyboard.down('ShiftLeft');
      await page.keyboard.down('KeyW'); await pump(45);
      // The swap itself: A goes down before W comes up, which is what a player
      // does and is the case where `mag` could briefly fall under the gate.
      await page.keyboard.down('KeyA'); await page.keyboard.up('KeyW'); await pump(45);
      await page.keyboard.up('KeyA'); await page.keyboard.up('ShiftLeft');
      const t = await trace;
      await pump(10);
      const first = t.findIndex((r) => r.run === 1);
      if (first < 0) { changes.push({ ok: false, why: 'never sprinted at all' }); continue; }
      /**
       * THE WINDOW HAS TO END WHEN THE INPUT DOES, and it did not.
       *
       * `rec(130)` records 130 RENDERED frames, which is ~260 fixed steps, and
       * the keys are released after ~90 of those frames. The tail of every
       * trace is therefore a character standing still with no keys down —
       * correctly not sprinting — and the old window ran to the end of the
       * recording and counted it. MEASURED: "worst gap 205 steps" against a
       * 20-step budget, on every run, on every build. This row has reported 0 %
       * for as long as it has existed and the number was never about the
       * direction change at all. It is the same disease as the rest of rule
       * 12's list: the measurement included something the code was never asked
       * to do. The window now closes on the last step where the player was
       * still asking to move.
       */
      let lastHeld = -1;
      for (let i = 0; i < t.length; i++) if (t[i].mag > 0.45) lastHeld = i;
      if (lastHeld <= first) { changes.push({ ok: false, why: 'no input window' }); continue; }
      const hit = t.slice(first, lastHeld + 1).some((r) => r.st === 1);
      // The swap shows up in the trace as the step where the wish direction
      // turns; find the longest run of non-sprinting steps after that.
      const after = t.slice(first, lastHeld + 1);
      let worst = 0, cur = 0;
      for (const r of after) {
        if (r.run === 0) { cur++; worst = Math.max(worst, cur); } else cur = 0;
      }
      changes.push({ ok: !hit, stumbled: hit, worstGapSteps: worst, minMag: Math.min(...after.map((r) => r.mag)) });
    }
    const usable = changes.filter((c) => c.ok);
    const passed = usable.filter((c) => c.worstGapSteps <= 20).length;
    rows.push({
      name: 'direction change with Shift held',
      reps: usable.length, pass: passed,
      rate: usable.length ? passed / usable.length : 1,
      ever: changes.filter((c) => c.worstGapSteps !== undefined).length,
      dropoutFrames: usable.length ? Math.max(...usable.map((c) => c.worstGapSteps)) : 0,
      excludedStumble: changes.filter((c) => c.stumbled).length,
      topSpeed: dist(usable.map(() => (rows[0]?.runSpeed ?? 0))),
      runSpeed: (await page.evaluate(() => window.__MP__.state())).run,
      wantSpeed: (await page.evaluate(() => window.__MP__.state())).run,
      tier: 'run', bled: 0,
      ads: dist([0]),
    });

    report.sprint = rows;
  }

  /* ==================================================================== */
  /* NITRO — Shift in a car                                               */
  /* ==================================================================== */

  if (ONLY === 'all' || ONLY === 'nitro') {
    process.stderr.write('\rmoveprobe: nitro A/B (counterbalanced, 4 runs per arm)                    ');
    const site = await page.evaluate(() => window.__MP__.spawnCar());
    if (!site) {
      report.nitro = { err: 'could not place a test car on a lane' };
    } else {
      await pump(40);
      await page.keyboard.down('KeyF');
      await pump(6);
      await page.keyboard.up('KeyF');
      await pump(160);
      const seated = await page.evaluate(() => window.__MP__.car());

      if (!seated?.inVehicle) {
        report.nitro = { err: 'never got into the test car', seated };
      } else {
        /**
         * One arm of the A/B. Same car, same pose, same zeroed velocity, same
         * full bottle — the only difference is whether Shift is held.
         *
         * The result is read off the SIGNED forward speed the car emitted, not
         * off the boost flag this probe set. Asserting that `input.boost === 1`
         * would only prove the probe pressed the key.
         */
        /**
         * Compare the two arms AT MATCHED SIMULATED TIME, not after a matched
         * number of rendered frames.
         *
         * The first cut of this took the top speed over 125 frames. Headless
         * the page runs at 15-30 fps, so 125 frames is anywhere from 4 to 8
         * seconds of car, and a sedan is still accelerating throughout — so
         * "top speed" was mostly a measure of how fast the browser happened to
         * be running. Measured: 11.01 and 13.22 m/s on two unboosted runs, a
         * 2.21 m/s spread, against a claimed 0.69 m/s "boost gain". That gate
         * went green on pure noise for a channel nothing in the game reads.
         */
        const AT = [1.5, 2.5, 3.5];
        const run = async (boost) => {
          await page.evaluate((n) => window.__MP__.resetCar(n), 100);
          await pump(20);
          const trace = page.evaluate((f) => window.__MP__.recCar(f), 190);
          if (boost) await page.keyboard.down('ShiftLeft');
          await page.keyboard.down('KeyW');
          await pump(185);
          await page.keyboard.up('KeyW');
          if (boost) await page.keyboard.up('ShiftLeft');
          const t = await trace;
          await pump(10);
          const t0 = t[0].t;
          const at = AT.map((d) => {
            const want = t0 + d;
            let best = null;
            for (const r of t) if (best === null || Math.abs(r.t - want) < Math.abs(best.t - want)) best = r;
            return best && Math.abs(best.t - want) < 0.35 ? best.fwd : NaN;
          });
          return {
            boost, at,
            span: +(t[t.length - 1].t - t0).toFixed(2),
            top: Math.max(...t.map((r) => r.fwd)),
            reachedBoostInput: t.some((r) => r.inBoost > 0),
            nitroStart: t[0].nitro,
            nitroEnd: t[t.length - 1].nitro,
            nitroOnFrames: t.filter((r) => r.nitroOn).length,
          };
        };

        // Counterbalanced so an engine that simply warms up, or a browser that
        // speeds up as it settles, cannot masquerade as a boost: ABBA ABBA.
        const arms = [];
        for (const b of [false, true, true, false, false, true, true, false]) arms.push(await run(b));

        // Recharge: sit off the throttle with an emptied bottle and watch it
        // come back. Measured on the published meter, not on the constant.
        await page.evaluate(() => window.__MP__.resetCar(10));
        const before = (await page.evaluate(() => window.__MP__.car())).nitro;
        await pump(180);
        const after = (await page.evaluate(() => window.__MP__.car())).nitro;

        /**
         * At each matched time, is the boosted arm SEPARATED from the unboosted
         * one, or merely a bit higher on a noisy sample? Non-overlap (every
         * boosted run above every plain run) is the standard this project
         * already uses for its A/Bs, and it is the only one that means anything
         * at four runs per arm.
         */
        const byTime = AT.map((d, i) => {
          const p = arms.filter((a) => !a.boost).map((a) => a.at[i]).filter(Number.isFinite);
          const b = arms.filter((a) => a.boost).map((a) => a.at[i]).filter(Number.isFinite);
          return {
            t: d, plain: dist(p), boosted: dist(b),
            gain: (q(b, 0.5) || 0) - (q(p, 0.5) || 0),
            separated: p.length >= 2 && b.length >= 2 && Math.min(...b) > Math.max(...p),
          };
        });
        report.nitro = {
          site, arms, byTime,
          separatedAt: byTime.filter((r) => r.separated).length,
          reachedCar: arms.filter((a) => a.boost).every((a) => a.reachedBoostInput),
          drained: arms.filter((a) => a.boost).every((a) => a.nitroEnd < a.nitroStart - 5),
          rechargeFrom: before, rechargeTo: after,
        };
      }
    }
  }

  /* ==================================================================== */
  /* PER-BROTHER SPEED                                                    */
  /* ==================================================================== */

  if (ONLY === 'all' || ONLY === 'brothers') {
    process.stderr.write('\rmoveprobe: brothers, three tiers each                                      ');
    /**
     * GET OUT OF THE CAR FIRST.
     *
     * The nitro suite above leaves the player seated, and `horizontalSpeed`
     * while driving is the CAR's speed. Without this the suite reported Aidan
     * sprinting at 13.03 m/s and Dylan at 2.31 — neither of which is a man
     * running, and both of which would have been filed as a movement defect.
     */
    await page.evaluate(() => {
      const pl = window.__ENGINE__.ctx.peek('player');
      pl.vehicles?.abort?.(pl.movement);
    });
    await pump(30);
    const open = await page.evaluate(() => window.__MP__.sites(1).flat[0] ?? null);
    /**
     * ALL THREE TIERS PER BROTHER, on the same ground, back to back.
     *
     * The ladder is per-brother by construction — the jog is a fraction OF the
     * authored run (`MOVE.autoJogScale`), so it inherits the run's spread and
     * the brothers stay distinguishable at the gait they are actually played
     * in. That claim is only worth anything measured, and only measured
     * together: three separate absolute rows can all be right while the two
     * gaps between them are wrong, which is precisely the shape of the bug this
     * pass fixed.
     */
    const leg = async (keys) => {
      await page.evaluate(([x, z]) => window.__MP__.place(x, z, 0), [open.x, open.z]);
      await page.evaluate(() => window.__MP__.settle(120));
      const trace = page.evaluate((f) => window.__MP__.rec(f), 110);
      for (const k of keys) await page.keyboard.down(k);
      await pump(105);
      for (const k of [...keys].reverse()) await page.keyboard.up(k);
      const t = await trace;
      return Math.max(...t.map((r) => r.sp));
    };
    const out = [];
    for (const id of ['carson', 'aidan', 'dylan']) {
      await page.evaluate((b) => window.__MP__.setBrother(b), id);
      await pump(30);
      await page.evaluate((w) => window.__MP__.setWeapon(w), 'pipe');
      await pump(20);
      const walk = await leg(['AltLeft', 'KeyW']);
      const jog = await leg(['KeyW']);
      const run = await leg(['ShiftLeft', 'KeyW']);
      const st = await page.evaluate(() => window.__MP__.state());
      out.push({
        id, spec: st.run, jogSpec: st.jogTier,
        walk, jog, run, topSpeed: run,
        fov: st.fov, boom: st.boom,
      });
    }
    report.brothers = out;
  }
} finally {
  // Wipe the progress line so it cannot bleed into the first report row.
  process.stderr.write('\r' + ' '.repeat(78) + '\r');
  if (args.json) writeFileSync(String(args.json), JSON.stringify(report, null, 2));
  await browser.close();
  stopServer(server);
}

/* ====================================================================== */
/* output                                                                 */
/* ====================================================================== */

if (report.jump) {
  const j = report.jump;
  console.log('\n=== JUMP — apex above the take-off surface, metres ===');
  console.log(`  ALL            ${fmtDist(j.all)}`);
  console.log('  -- by gait (the input) --');
  for (const [k, d] of Object.entries(j.byGait)) console.log(`  ${k.padEnd(14)} ${fmtDist(d)}`);
  console.log('  -- by ground (where you are standing) --');
  for (const [k, d] of Object.entries(j.byClass)) console.log(`  ${k.padEnd(14)} ${fmtDist(d)}`);
  console.log(`  excluded: ${j.mantled} became a mantle/vault, ${j.unsettled} never settled, ${j.noJump} never left the ground,`);
  console.log(`            ${j.nonBallistic} were not free ballistic arcs (the ground moved under the jump):`);
  for (const d of j.nonBallisticDetail) {
    console.log(`              ${d.gait}/${d.cls}/${d.surf}  apex ${f2(d.apex)} over ${d.airTime}s -> implied g ${d.gImplied}`);
  }
  console.log(`  air time: med ${f2(j.airTime.med)} s   implied g (8*apex/airTime^2): med ${f2(j.gImplied.med)} m/s^2`);
  if (j.worst.length) {
    console.log('  lowest sites:');
    for (const w of j.worst) console.log(`    ${String(w.apex).padEnd(7)} m  ${w.gait}/${w.cls}/${w.surf}  grad ${w.grad}  resid ${w.resid}  v ${w.speed}`);
  }
  if (DUMP) {
    for (const r of j.rows.filter((x) => x.trace)) {
      console.log(`\n  -- trace ${r.gait}/${r.cls}/${r.surf}  apex ${f2(r.apex)}  airTime ${r.airTime}s (one row per fixed step) --`);
      console.log('     y        g   vy      state');
      for (const [y, g, vy, st] of r.trace) {
        console.log(`     ${String(y).padEnd(9)}${g}   ${String(vy).padEnd(7)} ${st}`);
      }
    }
  }
}

if (report.sprint) {
  console.log('\n=== GAIT TIERS — pass rate over repeats (pass = held the tier\'s own flag,');
  console.log('    reached 85% of the tier\'s own speed, and never latched the other tier) ===');
  for (const r of report.sprint) {
    const flag = r.rate === 1 ? 'PASS' : r.rate === 0 ? 'FAIL' : 'FLAKY';
    console.log(
      `  ${flag.padEnd(6)} ${String(Math.round(r.rate * 100)).padStart(3)}%  ${(r.tier ?? 'run').padEnd(4)} ` +
      `${r.name.padEnd(32)} top ${f2(r.topSpeed.med)}/${f2(r.wantSpeed ?? r.runSpeed)} m/s  ads ${f2(r.ads.max)}` +
      (r.bled ? `  ${r.bled} bled into the other tier` : '') +
      (r.dropoutFrames !== undefined ? `  worst gap ${r.dropoutFrames} steps` : '') +
      (r.excludedStumble ? `  (${r.excludedStumble} trials excluded: hit something)` : '')
    );
  }
}

if (report.nitro) {
  const n = report.nitro;
  console.log('\n=== NITRO — Shift in a car, counterbalanced A/B from an identical start ===');
  if (n.err) console.log(`  UNMEASURABLE: ${n.err}`);
  else {
    console.log('  signed forward speed at matched simulated time, 4 runs per arm:');
    for (const r of n.byTime) {
      console.log(
        `    t+${r.t}s   plain ${f2(r.plain.min)}..${f2(r.plain.max)} (med ${f2(r.plain.med)})` +
        `   boosted ${f2(r.boosted.min)}..${f2(r.boosted.max)} (med ${f2(r.boosted.med)})` +
        `   gain ${f2(r.gain)}   ${r.separated ? 'SEPARATED' : 'overlapping — indistinguishable from noise'}`
      );
    }
    console.log(`  boost input reached the car: ${n.reachedCar}   meter drained while boosting: ${n.drained}`);
    console.log(`  recharge off the throttle: ${f2(n.rechargeFrom)} -> ${f2(n.rechargeTo)} / 100`);
  }
}

if (report.brothers) {
  console.log('\n=== BROTHERS — the three tiers reached, m/s (Alt+W · W · Shift+W) ===');
  for (const b of report.brothers) {
    console.log(
      `  ${b.id.padEnd(8)} walk ${f2(b.walk)}  jog ${f2(b.jog)}/${f2(b.jogSpec)}  ` +
      `run ${f2(b.run)}/${f2(b.spec)}   Shift buys +${f2(b.run - b.jog)} ` +
      `(${((b.run / Math.max(0.01, b.jog) - 1) * 100).toFixed(0)}%)  camFov ${f2(b.fov)}  boom ${f2(b.boom)}`
    );
  }
}

/* ====================================================================== */
/* gates                                                                  */
/* ====================================================================== */

/**
 * TARGET (not a ratchet): `JUMP_APEX` in tuning.js, currently 0.95 m, with the
 * reasoning for that number written beside it. The gate below allows +/- 0.07 m
 * on the median, which is the tolerance of the instrument plus the step-quantum
 * of the integrator, not slack for the feel to drift.
 *
 * CONSISTENCY is a RATCHET (hard rule 13). The bar is 0.00 m of spread — the
 * same input should produce the same height everywhere, full stop — and the
 * threshold here records where this build got to, not where the bar is. It was
 * 0.04 m before this pass and 0.00-0.02 m after, so it is set at 0.06 m to
 * absorb the odd site where the capsule is stepping up onto something as it
 * leaves. LOWER IT when you improve it; never raise it to make a run go green.
 *
 * What input would make this fail: any change that scales the jump impulse by
 * the ground normal, the gait, the frame the key lands on, or the surface — the
 * class of thing the player's "it varies" report would have been about. Reverting
 * `JUMP_APEX` alone takes the median to 0.60 and fails the target gate; making
 * the impulse additive rather than an assignment fails the spread gate.
 */
const GATE = { apexTarget: 0.95, apexTol: 0.07, spreadMax: 0.06, sprintRate: 1.0 };
const checks = [];
const gate = (name, ok, detail) => checks.push({ name, ok, detail });

if (report.jump) {
  const j = report.jump;
  gate('jump apex hits the authored target',
    Math.abs(j.all.med - GATE.apexTarget) <= GATE.apexTol,
    `median ${f2(j.all.med)} m, want ${GATE.apexTarget} +/- ${GATE.apexTol}`);
  gate('jump apex is the same everywhere [RATCHET 0.06, goal 0.00]',
    j.all.spread <= GATE.spreadMax,
    `spread ${f2(j.all.spread)} m over ${j.all.n} jumps (${f2(j.all.min)}..${f2(j.all.max)})`);
  gate('no ground class jumps differently',
    Object.values(j.byClass).every((d) => Math.abs(d.med - j.all.med) <= GATE.spreadMax),
    Object.entries(j.byClass).map(([k, d]) => `${k} ${f2(d.med)}`).join(' '));
  gate('no gait jumps differently',
    Object.values(j.byGait).every((d) => Math.abs(d.med - j.all.med) <= GATE.spreadMax),
    Object.entries(j.byGait).map(([k, d]) => `${k} ${f2(d.med)}`).join(' '));
}

if (report.sprint) {
  const bad = report.sprint.filter((r) => r.rate < GATE.sprintRate);
  gate('each gait tier engages in every state that should allow it',
    bad.length === 0,
    bad.length ? bad.map((r) => `${r.name} ${Math.round(r.rate * 100)}%`).join('; ')
      : `${report.sprint.length} scenarios, all 100%`);
  /* The tiers must not leak into each other. Its own gate rather than a term
   * inside the row above, so a build where W silently latches the run says so
   * in one line instead of hiding inside a pass rate. */
  const bled = report.sprint.filter((r) => (r.bled ?? 0) > 0);
  gate('no scenario reaches a tier its input did not ask for',
    bled.length === 0,
    bled.length ? bled.map((r) => `${r.name} ${r.bled}/${r.reps}`).join('; ')
      : `${report.sprint.length} scenarios clean`);
}

if (report.nitro && !report.nitro.err) {
  const n = report.nitro;
  // Player-side plumbing: mine, and it must be green.
  gate('Shift in a car reaches the vehicle boost channel', n.reachedCar,
    `input.boost seen at the car on every boosted run`);
  gate('the nitro meter drains while boosting', n.drained,
    n.arms.filter((a) => a.boost).map((a) => `${f2(a.nitroStart)}->${f2(a.nitroEnd)}`).join(' '));
  gate('the nitro meter recharges off the throttle',
    n.rechargeTo > n.rechargeFrom + 2,
    `${f2(n.rechargeFrom)} -> ${f2(n.rechargeTo)} / 100`);
  /**
   * SIGNED, and on the emitted speed rather than on the flag this probe set.
   *
   * This is the one gate here that is NOT the player's to fix. `boost` is
   * accepted by `vehicles.setInput` and stored on `Vehicle.input`, and nothing
   * in `src/vehicles/dynamics.js` reads it — so the channel is inert and the
   * car goes exactly as fast with Shift as without. The intended numbers are
   * accel x1.75 and top speed x1.28 while boosting. This goes green the moment
   * `vehicles` applies them.
   */
  gate('holding Shift makes the car measurably faster [vehicles-side]',
    n.separatedAt >= 2,
    `boosted arm clears the plain arm at ${n.separatedAt}/${n.byTime.length} matched times` +
    ` (gains ${n.byTime.map((r) => f2(r.gain)).join(', ')} m/s)`);
}

if (report.brothers) {
  const off = report.brothers.filter((b) => Math.abs(b.run - b.spec) > 0.25);
  gate('each brother reaches his own DESIGN.md run speed on Shift',
    off.length === 0,
    report.brothers.map((b) => `${b.id} ${f2(b.run)}/${f2(b.spec)}`).join('  '));
  const jogOff = report.brothers.filter((b) => Math.abs(b.jog - b.jogSpec) > 0.25);
  gate('each brother\'s W-alone jog is his own tier',
    jogOff.length === 0,
    report.brothers.map((b) => `${b.id} ${f2(b.jog)}/${f2(b.jogSpec)}`).join('  '));
  /**
   * THE GAP, PER BROTHER — the gate for the report this pass came from.
   *
   * "run doesn't seem to do anything now" is not a claim about any single
   * speed, it is a claim about the DIFFERENCE, and on the build he played this
   * difference was 0.00 m/s for all three brothers. 1.5 m/s is the bar because
   * it is roughly a walk's worth of speed: below that the key is a nudge.
   */
  const flat = report.brothers.filter((b) => b.run - b.jog < 1.5);
  gate('Shift is worth a tier on every brother',
    flat.length === 0,
    report.brothers.map((b) => `${b.id} +${f2(b.run - b.jog)}`).join('  '));
  const ladder = report.brothers.filter((b) => !(b.walk < b.jog && b.jog < b.run));
  gate('walk < jog < run for every brother',
    ladder.length === 0,
    report.brothers.map((b) => `${b.id} ${f2(b.walk)}/${f2(b.jog)}/${f2(b.run)}`).join('  '));
  const speeds = report.brothers.map((b) => b.run);
  gate('the brothers are actually different speeds',
    Math.max(...speeds) - Math.min(...speeds) > 1.0,
    `${f2(Math.min(...speeds))} .. ${f2(Math.max(...speeds))} m/s`);
  /* The jog tier inherits the run's spread because it is a fraction of it —
   * assert that, or a future flat jog speed would erase the cast at the gait
   * the game is mostly played in and no other gate here would notice. */
  const jogs = report.brothers.map((b) => b.jog);
  gate('the brothers stay different at the JOG tier too',
    Math.max(...jogs) - Math.min(...jogs) > 0.7,
    `${f2(Math.min(...jogs))} .. ${f2(Math.max(...jogs))} m/s`);
}

if (checks.length) {
  console.log('\n=== gates ===');
  for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(52)} ${c.detail}`);
  const pass = checks.filter((c) => c.ok).length;
  console.log(`\n${pass}/${checks.length} gates`);
  if (pass !== checks.length) process.exitCode = 1;
}

if (errs.length) {
  console.log('\n=== page errors ===');
  for (const e of [...new Set(errs)].slice(0, 10)) console.log('  ' + e);
}
console.log('');
