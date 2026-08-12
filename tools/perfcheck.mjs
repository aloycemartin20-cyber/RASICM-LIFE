#!/usr/bin/env node
/**
 * PERFCHECK — the frame-budget gate, and the only honest way to A/B two trees.
 *
 *   node tools/perfcheck.mjs                          report one arm (this tree)
 *   node tools/perfcheck.mjs --gate                   assert the budgets, exit 1 on a miss
 *   node tools/perfcheck.mjs --gate --ab=<ref>        assert +5% vs a reference arm
 *   node tools/perfcheck.mjs --ab=<refDir>            this tree vs a reference worktree
 *   node tools/perfcheck.mjs --ab=<dirA>,<dirB>       two named trees
 *   node tools/perfcheck.mjs --ab='.|owNoFarRing=1,.'  ONE build, change off vs on
 *   node tools/perfcheck.mjs --q=medium --reps=5 --json=/tmp/p.json
 *   node tools/perfcheck.mjs --drive                  scripted fast drive: hitches + geoDelta
 *   node tools/perfcheck.mjs --gov=1                  NEGATIVE CONTROL: unpin the governor
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN. The old version booted the production build with
 * the ADAPTIVE GOVERNOR RUNNING and no pinned tier, then printed the settled
 * frame time next to whatever tier the governor happened to land on. Two arms of
 * one A/B measured on one machine minutes apart came back at tier `low` / 60.3 ms
 * and tier `high` / 21.6 ms, and the number was reported as a 3x regression. It
 * is not a comparison at all: the two arms were not drawing the same picture.
 * A governor is a feedback loop whose output is the thing you are trying to
 * measure, so it has to be OFF for a measurement and ON for play.
 *
 *   `?q=<tier>&gov=0`  pins the preset AND stops the resolution trim
 *                      (`src/main.js:153` — `gov=0` skips the Governor entirely).
 *
 * Two arms are then only comparable if they actually drew the same picture, so
 * every arm reports `tier` and `renderScale` and `--ab` REFUSES to print a delta
 * when they differ. That refusal is the entire point of the rewrite: a confident
 * delta between mismatched configurations is worse than no delta.
 *
 * RULE 12 — what is measured is the EMITTED frame cadence: the wall-clock gaps
 * between successive `requestAnimationFrame` callbacks of the real production
 * build, with the frame-rate limiter off. Not `engine.time.dt` (which the engine
 * clamps and which a stalled tab reports as 100 ms forever), not a governor
 * sample window (the governor's own median is the input to the loop we just
 * disabled), and not a draw-call count standing in for cost.
 *
 * ── THE SCENES, and why these two ─────────────────────────────────────────────
 * `day` and `night` are the SAME downtown avenue at 17.4 h and 1.5 h — the
 * `hero` and `night` shots in `src/dev/shots.js`, which are authored to one
 * position on purpose. Matching position across the pair means the day/night
 * delta is lighting, not geography. Night is the expensive one and the one that
 * regressed historically (two spot lights, lamp pools, bloom on a dark frame).
 * `skyline` is the Mt. Washington vantage; it is REPORTED, not gated — it is
 * where the city is judged for liveliness rather than for frame cost.
 *
 * ── THE BUDGETS ──────────────────────────────────────────────────────────────
 * Cut from the `main` baseline worktree measured by this same file, tier
 * `high`, governor off, three-run medians, plus 5%:
 *
 *   MEASURED main (2026-08-11, this machine, --reps=3):
 *     day    p50 18.3 ms   p95 22.4 ms
 *     night  p50 15.7 ms   p95 18.9 ms
 *
 *   Corroborated on THIS tree with `?owNoFarRing=1&owNoAmortise=1` (the change
 *   under test switched off, same build, same minute): day p50 17.8 / p95 20.1,
 *   night p50 15.5 / p95 17.5 — within 3% of the separate worktree, which is
 *   what makes the number above a property of the code rather than of the run.
 *
 * A budget is a CEILING ON REGRESSION, not a target: it says "this tree is not
 * measurably slower than the tree it was cut from". Lowering one when the frame
 * gets cheaper is the RATCHET discipline of rule 13; raising one to make a run
 * go green is how a gate becomes a record of decay.
 *
 * ── AND THE THING THESE NUMBERS CANNOT DO ────────────────────────────────────
 * An absolute millisecond budget is a statement about the code ONLY IF the
 * machine is the same machine. MEASURED, and this is the most important number
 * in this file: two runs of ONE unchanged baseline worktree, an hour apart on
 * this machine, came back at
 *
 *     day p50 31.0 ms   and   day p50 18.3 ms
 *
 * — a 70% swing with no code change at all, because other work was running the
 * first time. So:
 *
 *   - `--gate` REFUSES TO GRADE a run whose own three passes disagree by more
 *     than `GATE_MAX_SPREAD`, and exits 2 (INCONCLUSIVE) rather than 1. A gate
 *     that scored the swing above as a 70% regression would be FLAKY, and
 *     ARCHITECTURE.md is explicit that flaky is worse than red.
 *   - `--ab` is the form that does not care about the machine, and the arm
 *     syntax `path|extraQuery` is what makes it usable: both arms come off ONE
 *     build, one page load apart, so the delta is the change and not the load
 *     average. Every change measured with this file should carry a hatch that
 *     turns it off (`?owNoFarRing=1`, `?owNoAmortise=1` are the two live ones).
 *   - `--ab` between two DIRECTORIES is now INTERLEAVED pass by pass, so it no
 *     longer inherits the drift above — but it opens two browsers, and on a
 *     machine that is already thrashing that pushes the within-run spread past
 *     `GATE_MAX_SPREAD` and the gate correctly declines to grade.
 *
 * WHAT THAT MEANT IN PRACTICE, recorded so nobody re-discovers it: three
 * consecutive `--gate` runs on the tree these budgets were cut for scored
 * PASS / FAIL / FAIL, with day p50 drifting 18.2 -> 18.9 -> 21.7 ms across the
 * three as other work started on the machine. The code did not change between
 * them. Treat a red absolute gate as a question ("was the machine busy?")
 * before treating it as an answer, and reach for `--gate --ab=<ref>` when you
 * need the answer to be about the code.
 *
 * NOT IN `npm run gate`: this boots vite preview and Chromium with a GPU and
 * takes several minutes, which is an order of magnitude past the whole node-only
 * chain (ARCHITECTURE.md rule 9 — "a probe that boots vite goes in handoff or
 * soak"). It is a `soak` member.
 */
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import net from 'node:net';

const SELF_ROOT = resolve(import.meta.dirname, '..');

const arg = (k, d) => {
  const m = process.argv.find((a) => a === `--${k}` || a.startsWith(`--${k}=`));
  if (!m) return d;
  const i = m.indexOf('=');
  return i < 0 ? true : m.slice(i + 1);
};

const QUALITY = String(arg('q', 'high'));
const GOV = arg('gov', '0') === '1';          // negative control only
const REPS = Number(arg('reps', 3));
const FRAMES = Number(arg('frames', 300));
const GATE = arg('gate', false) === true;
const DRIVE = arg('drive', false) === true;
const AB = arg('ab', null);
const JSON_OUT = arg('json', null);
const VERBOSE = arg('v', false) === true;

/**
 * p50/p95 ceilings, milliseconds, at tier `high` with the governor pinned off.
 * See the header for where these came from. RATCHET: lower them when the frame
 * gets cheaper; never raise one to make a run go green.
 */
const BUDGET = {
  day: { p50: 19.2, p95: 23.5 },
  night: { p50: 16.5, p95: 19.8 },
};

/** Scene name -> shot id in `src/dev/shots.js`. `gate` is which ones are asserted. */
const SCENES = [
  { name: 'day', shot: 'hero', gate: true },
  { name: 'night', shot: 'night', gate: true },
  { name: 'skyline', shot: 'skyline', gate: false },
];

/**
 * Largest run-to-run disagreement `--gate` will still grade, as a fraction of
 * the median. Above this the run is INCONCLUSIVE, not failed — see `runGate`.
 */
const GATE_MAX_SPREAD = 0.18;

/**
 * How much slower than its REFERENCE ARM a tree may be and still pass
 * `--gate --ab=<ref>`. The same +5% the absolute budgets carry, expressed as a
 * ratio so it survives a machine that is busy — which, MEASURED on this one, is
 * the difference between a gate and a coin toss.
 */
const GATE_HEADROOM = 0.05;

/** m/s above which a traffic car counts as MOVING rather than parked in a queue. */
const MOVING_MS = 1.5;

/* ───────────────────────────────────────────────────────────── server ──── */

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 400; i++) {
    const p = 4400 + Math.floor(Math.random() * 900);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

async function startPreview(dir) {
  // A STALE dist/ MEASURES A BUILD THAT IS NOT THIS TREE. This harness once
  // graded a 13.5-hour-old bundle red while the working tree was green, and a
  // whole wave of agents chased the ghost. Rebuild whenever any source file is
  // newer than the bundle; the ~4 s build is nothing against a wrong verdict.
  const distHtml = resolve(dir, 'dist/index.html');
  const stale = !existsSync(distHtml) || (() => {
    const built = statSync(distHtml).mtimeMs;
    const newer = execSync(
      `find src index.html vite.config.js -newer dist/index.html -print -quit`,
      { cwd: dir, encoding: 'utf8' }
    ).trim();
    return newer.length > 0 || built === 0;
  })();
  if (stale) {
    execSync('npx vite build', { cwd: dir, stdio: 'ignore' });
  }
  if (!existsSync(distHtml)) {
    throw new Error(`${dir} has no dist/ and the rebuild failed — run \`npm run build\` in it`);
  }
  const port = await freePort();
  const bin = resolve(dir, 'node_modules/.bin/vite');
  const proc = spawn(existsSync(bin) ? bin : resolve(SELF_ROOT, 'node_modules/.bin/vite'),
    ['preview', '--port', String(port), '--strictPort'], { cwd: dir, stdio: 'ignore' });
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (await portOpen(port)) return { port, proc };
  }
  proc.kill();
  throw new Error(`vite preview never came up for ${dir}`);
}

/* ────────────────────────────────────────────────────── in-page probes ──── */

/**
 * Time `n` real presented frames. Returns the raw gaps in ms.
 *
 * Deliberately NOT `engine.time.dt`: that is clamped at 100 ms and interpolated,
 * so a stalled build reports a tidy number for a frame nobody saw.
 */
const FRAME_TIMER = (n) =>
  new Promise((done) => {
    const t = [];
    let last = performance.now();
    let i = 0;
    const tick = () => {
      const now = performance.now();
      t.push(now - last);
      last = now;
      if (++i >= n) return done(t);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

/**
 * What the frame actually contains, sampled OUTSIDE the timing window.
 *
 * `movingVisible` is the liveliness number: traffic cars inside the camera
 * frustum, in front of the near plane, moving faster than a queue. Counted off
 * the drivers' own vehicles' world positions and velocities — the emitted
 * population, never the `trafficBudget` constant that asked for it.
 */
const SCENE_STATE = ({ moving }) => {
  const e = window.__ENGINE__;
  const ctx = e.ctx;
  const cam = ctx.camera;
  cam.updateMatrixWorld();
  const traffic = ctx.peek('traffic');
  const drivers = traffic?.drivers ?? [];
  let live = 0, movingAll = 0, visible = 0, movingVisible = 0, farthest = 0;
  const cp = cam.getWorldPosition(cam.position.clone());
  for (const d of drivers) {
    const v = d?.vehicle;
    if (!v?.position) continue;
    live++;
    const sp = v.velocity ? Math.hypot(v.velocity.x, v.velocity.z) : 0;
    const isMoving = sp > moving;
    if (isMoving) movingAll++;
    const dist = Math.hypot(v.position.x - cp.x, v.position.z - cp.z);
    if (dist > farthest) farthest = dist;
    const ndc = v.position.clone().project(cam);
    const onScreen = ndc.z > -1 && ndc.z < 1 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1;
    if (!onScreen) continue;
    visible++;
    if (isMoving) movingVisible++;
  }
  const r = ctx.peek('render')?.renderer?.info?.render;
  return {
    tier: e.config.quality,
    renderScale: +(e.config.q.renderScale ?? 1).toFixed(3),
    trafficBudget: e.config.q.trafficBudget ?? null,
    draws: r?.calls ?? null,
    tris: r?.triangles ?? null,
    spotLightCount: ctx.peek('render')?.stats?.spotLightCount ?? null,
    cam: [+cp.x.toFixed(1), +cp.y.toFixed(1), +cp.z.toFixed(1)],
    hour: +(ctx.peek('sky')?.hour ?? -1).toFixed(2),
    live,
    movingAll,
    movingFrac: live ? +(movingAll / live).toFixed(3) : null,
    visible,
    movingVisible,
    farthestM: +farthest.toFixed(0),
  };
};

/**
 * THE SCRIPTED FAST DRIVE — what a hitch is actually made of.
 *
 * A steady camera measures the STEADY-STATE frame; it cannot see the streaming
 * spikes, because nothing is streaming. This walks the anchor across the city at
 * `mps` metres per second — the streamer keys off the camera, so this is the same
 * work a car at 160 km/h asks for — and records, PER FRAME:
 *
 *   dt       the presented gap (the emitted cadence, again — not `time.dt`)
 *   geos     `renderer.info.memory.geometries`, the live geometry count
 *
 * `geoDelta` is that count's frame-to-frame difference, and it is the whole
 * reason this exists: a >25 ms frame carrying geoDelta 22-55 was a frame in
 * which some build job uploaded twenty to fifty geometries at once, which is a
 * job that does not respect `q.tileBuildBudgetMs` however small the budget is —
 * the queue budgets between jobs, never inside one (`src/world/streaming.js`).
 * A hitch with geoDelta 0 is something else entirely and must not be blamed on
 * streaming.
 *
 * `buildMs` rides along as a LABEL, never as an assertion: it is `world`'s own
 * report of what its job queue spent, i.e. exactly the kind of intermediate
 * rule 12 says not to grade on. It is here so a hitch can be attributed to the
 * queue or acquitted, and the grading is done on `dt` and `geoDelta`.
 *
 * The route runs downtown -> east across the Golden Triangle and out past
 * Lawrenceville: dense tiles, sector road mesh, bridges and the terrain
 * collision patch's 48 m snap all cross it.
 */
const DRIVE_SCRIPT = ({ frames, mps, from, dir }) =>
  new Promise((done) => {
    const e = window.__ENGINE__;
    const ctx = e.ctx;
    const pl = ctx.peek('player');
    const w = ctx.peek('world');
    const r = ctx.peek('render')?.renderer;
    const out = [];
    let i = 0;
    let last = performance.now();
    let prevGeo = r?.info.memory.geometries ?? 0;
    const step = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      const t = i / 60;
      const x = from[0] + dir[0] * mps * t;
      const z = from[1] + dir[1] * mps * t;
      const y = (w?.walkableHeightAt?.(x, z) ?? 2) + 1.4;
      pl?.teleport?.({ x, y, z });
      const geo = r?.info.memory.geometries ?? 0;
      out.push({
        i, dt, geoDelta: geo - prevGeo,
        calls: r?.info.render.calls ?? 0,
        buildMs: +(w?._stats?.buildMs ?? 0).toFixed(1),
      });
      prevGeo = geo;
      if (++i >= frames) return done(out);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

async function measureDrive(dir, label, extra = '') {
  const { port, proc } = await startPreview(dir);
  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio',
      '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  const out = { label, dir, extra, q: QUALITY, runs: [], errors: errs };
  try {
    await page.goto(`http://127.0.0.1:${port}/?q=${QUALITY}&gov=0${extra ? `&${extra}` : ''}`,
      { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
    for (let rep = 0; rep < REPS; rep++) {
      // Back to the start, and let the first ring rebuild before the clock runs.
      await page.evaluate(({ from }) => {
        const ctx = window.__ENGINE__.ctx;
        const w = ctx.peek('world');
        ctx.peek('player')?.teleport?.({ x: from[0], y: (w?.walkableHeightAt?.(from[0], from[1]) ?? 2) + 1.4, z: from[1] });
      }, { from: DRIVE_FROM });
      await page.evaluate(FRAME_TIMER, 180);
      const rows = await page.evaluate(DRIVE_SCRIPT,
        { frames: DRIVE_FRAMES, mps: DRIVE_MPS, from: DRIVE_FROM, dir: DRIVE_DIR });
      const dts = rows.map((r) => r.dt).sort((a, b) => a - b);
      const hitches = rows.filter((r) => r.dt > HITCH_MS)
        .sort((a, b) => b.dt - a.dt);
      out.runs.push({
        p50: +pct(dts, 0.5).toFixed(2),
        p95: +pct(dts, 0.95).toFixed(2),
        p99: +pct(dts, 0.99).toFixed(2),
        max: +dts[dts.length - 1].toFixed(2),
        hitches: hitches.length,
        withGeo: hitches.filter((h) => h.geoDelta > 0).length,
        worstGeoDelta: rows.reduce((m, r) => Math.max(m, r.geoDelta), 0),
        worstHitchGeoDelta: hitches.length ? Math.max(...hitches.map((h) => h.geoDelta)) : 0,
        top: hitches.slice(0, 6).map((h) => ({ f: h.i, ms: +h.dt.toFixed(1), geoDelta: h.geoDelta, buildMs: h.buildMs })),
      });
    }
  } finally {
    await browser.close();
    proc.kill();
  }
  out.p50 = +median(out.runs.map((r) => r.p50)).toFixed(2);
  out.hitches = median(out.runs.map((r) => r.hitches));
  out.worstGeoDelta = Math.max(...out.runs.map((r) => r.worstGeoDelta));
  out.worstHitchGeoDelta = Math.max(...out.runs.map((r) => r.worstHitchGeoDelta));
  out.maxMs = Math.max(...out.runs.map((r) => r.max));
  return out;
}

/** Downtown, heading east-north-east out through Lawrenceville. */
const DRIVE_FROM = [-232, 64];
const DRIVE_DIR = [0.94, -0.34];
const DRIVE_MPS = 45;
const DRIVE_FRAMES = 1500;
/** A frame past this is a hitch a player feels. */
const HITCH_MS = 25;

function printDrive(a) {
  console.log(`\n${a.label} — scripted drive ${DRIVE_MPS} m/s x ${DRIVE_FRAMES} frames, ${a.runs.length} runs`);
  console.log('  run    p50     p95     p99     max  hitches  w/geo  worstGeoDelta(hitch)');
  a.runs.forEach((r, i) => {
    console.log(`  ${String(i + 1).padEnd(3)}${f(r.p50)}  ${f(r.p95)}  ${f(r.p99)}  ${f(r.max)}  ` +
      `${f(r.hitches, 7)}  ${f(r.withGeo, 5)}  ${f(r.worstGeoDelta, 8)} (${r.worstHitchGeoDelta})`);
    for (const h of r.top) console.log(`        f${h.f} ${h.ms} ms  geoDelta ${h.geoDelta}  world buildMs ${h.buildMs}`);
  });
}

/* ─────────────────────────────────────────────────────────── measuring ──── */

const pct = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * An arm is `path` or `path|extraQuery`.
 *
 * The second form is the one that actually works on a shared machine. Two
 * DIRECTORIES have to be measured minutes apart, and MEASURED here: two runs of
 * the same unchanged baseline tree, an hour apart on this machine, came back at
 * day p50 31.0 ms and 18.3 ms — a 70% swing with no code change at all, because
 * other work was running. Any between-directory delta smaller than that is
 * indistinguishable from the load average.
 *
 * `path|owNoFarRing=1` runs the SAME BUILD with the change's negative-control
 * hatch up, so the two arms are one page load apart and share a compile, a GPU
 * state and a machine minute. That is the only arm pairing here whose delta is
 * the change.
 */
function parseArm(spec) {
  const i = String(spec).indexOf('|');
  return i < 0
    ? { dir: resolve(String(spec)), extra: '' }
    : { dir: resolve(String(spec).slice(0, i)), extra: String(spec).slice(i + 1) };
}

async function openArm(dir, label, extra = '') {
  const { port, proc } = await startPreview(dir);
  const browser = await chromium.launch({
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio',
      '--disable-frame-rate-limit'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 160)); });

  const out = {
    label, dir, extra, q: QUALITY, gov: GOV, reps: REPS, frames: FRAMES, scenes: {}, errors: errs,
  };
  const query = `?q=${QUALITY}${GOV ? '' : '&gov=0'}${extra ? `&${extra}` : ''}`;
  await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  for (const s of SCENES) out.scenes[s.name] = { runs: [], state: null };
  return {
    out,
    close: async () => { await browser.close(); proc.kill(); },
    /** One scene, one pass: apply the shot, wait for the city, time the frames. */
    pass: async (s, rep) => {
      await page.evaluate((n) => window.__APPLY_SHOT__(n), s.shot);
      // `__SETTLED__` is the same predicate the capture harness refuses to press
      // the shutter without: draw calls and triangles stable, queue drained.
      await page.waitForFunction('window.__SETTLED__ ? window.__SETTLED__() : true',
        null, { timeout: 120000, polling: 200 }).catch(() => {});
      await page.evaluate(FRAME_TIMER, 90);              // discard: post-settle warm
      const times = await page.evaluate(FRAME_TIMER, FRAMES);
      const sorted = times.slice().sort((a, b) => a - b);
      out.scenes[s.name].runs.push({
        p50: +pct(sorted, 0.5).toFixed(2),
        p95: +pct(sorted, 0.95).toFixed(2),
        p99: +pct(sorted, 0.99).toFixed(2),
        max: +sorted[sorted.length - 1].toFixed(2),
      });
      out.scenes[s.name].state = await page.evaluate(SCENE_STATE, { moving: MOVING_MS });
      if (VERBOSE) {
        const r = out.scenes[s.name].runs.at(-1);
        console.log(`  [${label}] ${s.name} rep${rep + 1}  p50 ${r.p50}  p95 ${r.p95}  ` +
          `moving/visible ${out.scenes[s.name].state.movingVisible}/${out.scenes[s.name].state.visible}`);
      }
    },
  };
}

/** Fold each scene's per-pass numbers into the medians everything else grades. */
function finishArm(out) {
  for (const s of SCENES) {
    const sc = out.scenes[s.name];
    if (!sc.runs.length) continue;
    sc.p50 = +median(sc.runs.map((r) => r.p50)).toFixed(2);
    sc.p95 = +median(sc.runs.map((r) => r.p95)).toFixed(2);
    sc.p99 = +median(sc.runs.map((r) => r.p99)).toFixed(2);
  }
  out.tier = out.scenes.day.state?.tier ?? null;
  out.renderScale = out.scenes.day.state?.renderScale ?? null;
  return out;
}

async function measureArm(dir, label, extra = '') {
  const arm = await openArm(dir, label, extra);
  try {
    // Scenes interleaved across reps rather than one repeated to exhaustion: a
    // machine that heats up biases every scene equally instead of loading it
    // all onto the last one.
    for (let rep = 0; rep < REPS; rep++) for (const s of SCENES) await arm.pass(s, rep);
  } finally {
    await arm.close();
  }
  return finishArm(arm.out);
}

/**
 * BOTH ARMS AT ONCE, INTERLEAVED PASS BY PASS.
 *
 * Running arm A to completion and then arm B is how this file started, and on a
 * shared machine it does not measure the code. MEASURED with the arms
 * sequential, one build, the change's own hatch as the control: night p50 came
 * back 50.5 ms for the control and 31.5 ms for the change — a 60% "improvement"
 * from a change that adds work, because something else on the machine started
 * and stopped between the two arms. The same pairing an hour earlier read +0.3.
 *
 * Interleaved, A and B are never more than one pass apart, so a load spike lands
 * on both. The price is that each arm is now measured with the OTHER arm's page
 * idling in a second browser — real, constant, and symmetric, which is the trade
 * being bought. Every number this mode prints is therefore slower in absolute
 * terms than `--gate`'s single-arm numbers, and only the RATIO is meant to be
 * read.
 */
async function measureArmsInterleaved(specA, specB) {
  const a = await openArm(specA.dir, `A ${specA.extra || 'ref'}`, specA.extra);
  const b = await openArm(specB.dir, `B ${specB.extra || 'this'}`, specB.extra);
  try {
    for (let rep = 0; rep < REPS; rep++) {
      for (const s of SCENES) {
        await a.pass(s, rep);
        await b.pass(s, rep);
      }
    }
  } finally {
    await a.close();
    await b.close();
  }
  return [finishArm(a.out), finishArm(b.out)];
}

/* ───────────────────────────────────────────────────────────── reports ──── */

const f = (n, w = 6) => String(n).padStart(w);

function printArm(a) {
  console.log(`\n${a.label}  (${a.dir})`);
  console.log(`  tier ${a.tier} · renderScale ${a.renderScale} · governor ${a.gov ? 'ON' : 'pinned off'} · ` +
    `${a.reps} reps x ${a.frames} frames`);
  console.log('  scene     p50     p95     p99   draws   live  moving  visible  mvVis');
  for (const s of SCENES) {
    const sc = a.scenes[s.name];
    const st = sc.state ?? {};
    console.log(`  ${s.name.padEnd(8)}${f(sc.p50)}  ${f(sc.p95)}  ${f(sc.p99)}  ${f(st.draws ?? '-')}  ` +
      `${f(st.live ?? '-', 5)}  ${f(st.movingFrac ?? '-', 6)}  ${f(st.visible ?? '-', 7)}  ${f(st.movingVisible ?? '-', 5)}`);
  }
  if (a.errors.length) console.log(`  page errors: ${a.errors.slice(0, 4).join(' | ')}`);
}

/**
 * Largest disagreement between the three runs of one scene, as a fraction of
 * their median. This is the gate's own honesty check, and it is not optional on
 * a machine that anything else is allowed to use.
 */
function repSpread(sc) {
  const v = sc.runs.map((r) => r.p50);
  const m = median(v);
  return m > 0 ? (Math.max(...v) - Math.min(...v)) / m : 0;
}

function runGate(a) {
  console.log('\nGATE — frame budget, tier high, governor pinned off');
  let fails = 0;
  /*
   * REFUSE TO GRADE A RUN THE MACHINE MOVED UNDER.
   *
   * An absolute millisecond budget is only a statement about the code if the
   * machine is the same machine. MEASURED here: two runs of ONE unchanged
   * baseline tree, an hour apart on this machine, came back at day p50 31.0 ms
   * and 18.3 ms, because other work was running the second time. A gate that
   * grades that as a 70% regression is not strict, it is FLAKY, and
   * ARCHITECTURE.md is explicit that a flaky gate is worse than a red one.
   *
   * The three runs are interleaved across the scenes, so sustained load shows
   * up as the runs disagreeing with each other. When they do, this reports
   * INCONCLUSIVE and exits 2 — deliberately neither 0 nor 1, so a chain still
   * stops but nobody reads it as a budget failure. Re-run it on a quiet
   * machine, or use `--gate --ab=<ref>`, whose delta does not care about load.
   */
  const spread = Math.max(...SCENES.filter((s) => s.gate).map((s) => repSpread(a.scenes[s.name])));
  if (spread > GATE_MAX_SPREAD) {
    console.log(`  INCONCLUSIVE  the three runs of a gated scene disagree by ` +
      `${(spread * 100).toFixed(0)}% (limit ${(GATE_MAX_SPREAD * 100).toFixed(0)}%).`);
    console.log('  The machine moved under the measurement; this says nothing about the code.');
    for (const s of SCENES) {
      console.log(`    ${s.name.padEnd(8)} p50 runs ${a.scenes[s.name].runs.map((r) => r.p50).join(' / ')}`);
    }
    console.log('\nperfcheck: GATE INCONCLUSIVE');
    return -1;
  }
  const check = (name, got, cap) => {
    const ok = got <= cap;
    if (!ok) fails++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(12)} ${f(got)} ms  (budget ${cap})`);
  };
  // A budget compares tiers, so an arm that did not land on the pinned tier is
  // not measuring the thing the budget was cut from. This is the failure the
  // old perfcheck could not see.
  if (a.tier !== QUALITY) {
    fails++;
    console.log(`  FAIL  tier pinned to "${QUALITY}" but the build reports "${a.tier}"`);
  }
  // ...and the resolution trim must not have moved DURING the run. Compared
  // scene to scene rather than against the preset's own number: the preset is
  // this build's input, and a gate that re-reads its input measures nothing
  // (rule 12). A governor that trimmed anything shows up as two scenes
  // disagreeing, whatever the preset says.
  const scales = [...new Set(SCENES.map((s) => a.scenes[s.name].state?.renderScale))];
  const tiers = [...new Set(SCENES.map((s) => a.scenes[s.name].state?.tier))];
  if (scales.length > 1 || tiers.length > 1) {
    fails++;
    console.log(`  FAIL  configuration moved during the run — renderScale ${scales.join('/')} ` +
      `tier ${tiers.join('/')}. The governor is not off.`);
  }
  for (const s of SCENES) {
    if (!s.gate) continue;
    check(`${s.name} p50`, a.scenes[s.name].p50, BUDGET[s.name].p50);
    check(`${s.name} p95`, a.scenes[s.name].p95, BUDGET[s.name].p95);
  }
  // Reported, never gated: liveliness belongs to the traffic harness, but a
  // frame budget met by an empty city is not a frame budget met.
  const sk = a.scenes.skyline.state ?? {};
  console.log(`  note  skyline vantage: ${sk.movingVisible} moving of ${sk.visible} visible cars, ` +
    `${sk.live} live drivers, ${((sk.movingFrac ?? 0) * 100).toFixed(0)}% of them moving, ` +
    `farthest ${sk.farthestM} m`);
  // ARCHITECTURE.md: `numSpotLights` is a shader permutation key and was
  // measured at ~1.5 ms each on a 17.6 ms night frame. It is not covered by any
  // budget in `config.q`, so it is reported here every run.
  console.log(`  note  spotLightCount day ${a.scenes.day.state?.spotLightCount} · ` +
    `night ${a.scenes.night.state?.spotLightCount}`);
  console.log(fails === 0 ? '\nperfcheck: GATE PASS' : `\nperfcheck: GATE FAIL (${fails})`);
  return fails;
}

/**
 * THE LOAD-IMMUNE FORM OF THE BUDGET, and the one that belongs in a chain.
 *
 * Same assertion as `runGate` — p50 and p95 at matched day/night scenes, three-
 * run medians — but the ceiling is the REFERENCE ARM's own median rather than a
 * millisecond constant. A busy machine slows both arms, so the ratio survives
 * it; an absolute constant does not, and this machine is never idle (measured
 * during this work: load average 8.5, with three other browser probes running).
 *
 * The refusal in `printAB` runs first: two arms that did not draw the same
 * picture are not compared at all.
 */
function runGateAB(a, b) {
  console.log(`\nGATE (A/B) — B may be at most ${(GATE_HEADROOM * 100).toFixed(0)}% slower than A`);
  let fails = 0;
  if (a.tier !== b.tier || a.renderScale !== b.renderScale) {
    console.log('  FAIL  arms did not draw the same picture — see the refusal above');
    return 1;
  }
  // Same refusal as the absolute form: interleaving makes the arms share a
  // machine minute, it does not make a machine that is thrashing measurable.
  const spread = Math.max(...SCENES.filter((s) => s.gate)
    .flatMap((s) => [repSpread(a.scenes[s.name]), repSpread(b.scenes[s.name])]));
  if (spread > GATE_MAX_SPREAD) {
    console.log(`  INCONCLUSIVE  a gated scene's three passes disagree by ` +
      `${(spread * 100).toFixed(0)}% (limit ${(GATE_MAX_SPREAD * 100).toFixed(0)}%).`);
    for (const s of SCENES) {
      console.log(`    ${s.name.padEnd(8)} A ${a.scenes[s.name].runs.map((r) => r.p50).join(' / ')}` +
        `   B ${b.scenes[s.name].runs.map((r) => r.p50).join(' / ')}`);
    }
    console.log('\nperfcheck: GATE INCONCLUSIVE');
    return -1;
  }
  for (const s of SCENES) {
    if (!s.gate) continue;
    for (const k of ['p50', 'p95']) {
      const cap = +(a.scenes[s.name][k] * (1 + GATE_HEADROOM)).toFixed(2);
      const got = b.scenes[s.name][k];
      const ok = got <= cap;
      if (!ok) fails++;
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${`${s.name} ${k}`.padEnd(12)} ${f(got)} ms  ` +
        `(ref ${f(a.scenes[s.name][k])} -> cap ${cap})`);
    }
  }
  const skA = a.scenes.skyline.state ?? {};
  const skB = b.scenes.skyline.state ?? {};
  console.log(`  note  skyline vantage moving cars in frame: A ${skA.movingVisible} of ${skA.visible} ` +
    `-> B ${skB.movingVisible} of ${skB.visible}`);
  console.log(fails === 0 ? '\nperfcheck: GATE PASS' : `\nperfcheck: GATE FAIL (${fails})`);
  return fails;
}

function printAB(a, b) {
  console.log('\nA/B');
  if (a.tier !== b.tier || a.renderScale !== b.renderScale) {
    console.log(`  REFUSING TO COMPARE — the two arms did not draw the same picture:`);
    console.log(`    ${a.label}: tier ${a.tier} renderScale ${a.renderScale}`);
    console.log(`    ${b.label}: tier ${b.tier} renderScale ${b.renderScale}`);
    console.log('  Pin both arms (--q=) and leave the governor off; a delta between');
    console.log('  mismatched configurations is not a measurement.');
    return 1;
  }
  console.log(`  both arms: tier ${a.tier} · renderScale ${a.renderScale}`);
  console.log('  scene      p50 A     p50 B      d p50      p95 A     p95 B      d p95    mvVis A/B');
  for (const s of SCENES) {
    const x = a.scenes[s.name], y = b.scenes[s.name];
    const d50 = +(y.p50 - x.p50).toFixed(2);
    const d95 = +(y.p95 - x.p95).toFixed(2);
    console.log(`  ${s.name.padEnd(8)}${f(x.p50, 8)}${f(y.p50, 10)}${f((d50 > 0 ? '+' : '') + d50, 11)}` +
      `${f(x.p95, 11)}${f(y.p95, 10)}${f((d95 > 0 ? '+' : '') + d95, 11)}` +
      `${f(`${x.state?.movingVisible ?? '-'}/${y.state?.movingVisible ?? '-'}`, 13)}`);
  }
  return 0;
}

/* ─────────────────────────────────────────────────────────────── main ──── */

let code = 0;
let payload;
if (DRIVE) {
  const arms = AB ? String(AB).split(',').map((s) => parseArm(s.trim())) : [];
  if (arms.length) {
    const a = await measureDrive(arms[0].dir, `A ${arms[0].extra || 'ref'}`, arms[0].extra);
    const b = arms[1]
      ? await measureDrive(arms[1].dir, `B ${arms[1].extra || 'this'}`, arms[1].extra)
      : await measureDrive(SELF_ROOT, 'B this');
    printDrive(a);
    printDrive(b);
    console.log(`\n  worst geoDelta on a hitch:  A ${a.worstHitchGeoDelta}  ->  B ${b.worstHitchGeoDelta}`);
    console.log(`  hitches (>${HITCH_MS} ms), median run:  A ${a.hitches}  ->  B ${b.hitches}`);
    console.log(`  worst frame:  A ${a.maxMs} ms  ->  B ${b.maxMs} ms`);
    payload = { mode: 'drive-ab', a, b };
  } else {
    const a = await measureDrive(SELF_ROOT, 'drive');
    printDrive(a);
    payload = { mode: 'drive', a };
  }
} else if (AB) {
  const parts = String(AB).split(',').map((s) => s.trim()).filter(Boolean);
  const armA = parseArm(parts[0]);
  const armB = parts.length >= 2 ? parseArm(parts[1]) : { dir: SELF_ROOT, extra: '' };
  const [a, b] = await measureArmsInterleaved(armA, armB);
  printArm(a);
  printArm(b);
  code = printAB(a, b);
  if (GATE && code === 0) {
    const r = runGateAB(a, b);
    code = r === 0 ? 0 : r < 0 ? 2 : 1;
  }
  payload = { mode: GATE ? 'gate-ab' : 'ab', a, b };
} else {
  const a = await measureArm(SELF_ROOT, GATE ? 'gate' : 'perfcheck');
  printArm(a);
  payload = { mode: GATE ? 'gate' : 'report', a };
  if (GATE) {
    const r = runGate(a);
    code = r === 0 ? 0 : r < 0 ? 2 : 1;
  }
}

if (JSON_OUT) {
  mkdirSync(dirname(resolve(String(JSON_OUT))), { recursive: true });
  writeFileSync(resolve(String(JSON_OUT)), JSON.stringify(payload, null, 2));
}
process.exit(code);
