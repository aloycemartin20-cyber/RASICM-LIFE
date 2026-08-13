#!/usr/bin/env node
/**
 * TIERSHOT — the acceptance frame for the three gaits, on the real build.
 *
 * `feeltest.mjs` and `moveprobe.mjs` prove the numbers. This proves the thing
 * the owner actually reported, which was not a number: *"player walks a little
 * too fast and run doesn't seem to do anything now"*. That is a claim about
 * what a gait LOOKS like from behind the shoulder, and about whether pressing a
 * key changes it, so the artifact has to be pictures.
 *
 * THE FRAMES ARE COMPARABLE BY CONSTRUCTION. One mark, one heading, one fixed
 * camera, and each tier given the SAME AMOUNT OF SIMULATED TIME from a
 * standstill — so the only thing that differs between the three PNGs is how far
 * down the street the brother got, which is exactly the quantity in dispute.
 * Distance is read off the emitted body position and printed with the frame, so
 * the picture and the measurement cannot drift apart.
 *
 *   node src/player/tiershot.mjs
 *   node src/player/tiershot.mjs --out=/tmp/tiers --secs=2 --boy=dylan
 *
 * WHY THE STATE IS SET AFTER THE SETTLE, not in the shot block. `src/dev/
 * shots.js` documents its `player.state` as stationary-only and it is right to:
 * a shot settles for hundreds of frames and a moving state walks the subject
 * out of frame by a different distance every run. Here the shot stages him
 * IDLE, the streaming settles, and only then does the tier go on and the clock
 * start — which is what makes the distances mean something.
 *
 * The camera is deliberately NOT the chase camera. A follow camera keeps the
 * subject the same size in every frame, which is precisely the difference this
 * is trying to show.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const W = Number(args.w ?? 1280);
const H = Number(args.h ?? 720);
const Q = args.q ?? 'high';
const OUT = resolve(args.out ?? 'shots/tiers');
const BOY = args.boy ?? 'carson';
/** Simulated seconds each tier is given, from a standing start. */
const SECS = Number(args.secs ?? 2);
/** The three keyboard gaits, in `player.debugState` names. */
const TIERS = [
  ['walk', 'Alt+W'],
  ['jog', 'W alone'],
  ['sprint', 'Shift+W'],
];

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });
async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 6100 + Math.floor(Math.random() * 90);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = await freePort();
const root = resolve(import.meta.dirname, '../..');
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' },
});
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await portOpen(PORT)) break;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

mkdirSync(OUT, { recursive: true });
let failed = null;
const rows = [];
try {
  await page.goto(`http://127.0.0.1:${PORT}/?capture=1&q=${Q}&shot=character`, {
    waitUntil: 'domcontentloaded', timeout: 120000,
  });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 120000 });
  await page.evaluate(() => window.__APPLY_SHOT__('character', { grabFrame: 60 }));
  await page.evaluate(
    () => new Promise((d) => { let i = 0; const t = () => (window.__SETTLED__?.() || ++i > 900 ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); })
  );
  await pump(60);

  /**
   * THE MARK AND THE HEADING, MEASURED RATHER THAN ASSUMED.
   *
   * Same lesson `feeltest.findRunway` learned the hard way: the shot's street
   * is dressed with furniture and the direction he happens to be facing is not
   * necessarily the direction with room in it. Cast the character capsule along
   * eight headings and take the deepest, so a frame that shows a short run
   * shows a short run because of the gait and not because of a bollard.
   */
  const site = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const p = e.ctx.peek('player');
    const phys = e.ctx.peek('physics');
    const c = p.movement.position;
    let best = { yaw: p.movement.faceYaw, room: 0 };
    for (let i = 0; i < 8; i++) {
      const yaw = (i / 8) * Math.PI * 2;
      const dir = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
      const a = { x: c.x, y: c.y + 0.36, z: c.z };
      const b = { x: c.x, y: c.y + 1.62, z: c.z };
      let room = 0;
      for (const d of [22, 18, 15, 12, 9, 6]) {
        if (d <= room) break;
        if (!phys.capsuleCast(a, b, 0.3, dir, d, phys.MASK.CHARACTER).hit) { room = d; break; }
      }
      if (room > best.room) best = { yaw, room };
    }
    return { at: [c.x, c.y, c.z], yaw: best.yaw, room: best.room };
  });
  console.log(`mark ${site.at.map((v) => v.toFixed(1)).join(', ')} · ` +
    `heading ${(site.yaw * 180 / Math.PI).toFixed(0)} deg · ${site.room} m of room · ${SECS}s per tier`);

  for (const [state, label] of TIERS) {
    /* Re-stage from the shot every time rather than teleporting by hand: the
     * shot block is what un-hides the body and reseats the rig, and a frame
     * with an invisible subject is the classic failure here. */
    const shot = {
      pos: [0, 0, 0], look: [0, 0, 0], fov: 46, time: 13.5,
      player: { at: site.at, yaw: site.yaw, state: 'idle', brother: BOY, camera: false },
    };
    /* Camera AT THE FAR END OF THE RUNWAY, LOOKING BACK — fixed for all three
     * tiers, which is the whole point. Down-the-runway from behind was the
     * obvious framing and it is wrong twice: the space behind the mark is the
     * inside of a facade (the first attempt photographed a wall from within
     * one), and a subject running away shrinks, which reads as less difference
     * rather than more. Running TOWARD a lens that is standing in the clear
     * space we just measured, the faster tier ends the window visibly closer
     * and larger, and every metre of the difference is on screen. */
    const fwd = [-Math.sin(site.yaw), 0, -Math.cos(site.yaw)];
    const far = Math.max(10, site.room - 2);
    shot.pos = [site.at[0] + fwd[0] * far, site.at[1] + 2.2, site.at[2] + fwd[2] * far];
    shot.look = [site.at[0] + fwd[0] * 2.0, site.at[1] + 1.0, site.at[2] + fwd[2] * 2.0];
    await page.evaluate((s) => window.__APPLY_SHOT__(s, { grabFrame: 30 }), JSON.stringify(shot));
    await pump(24);

    const res = await page.evaluate(async ([st, secs]) => {
      const e = window.__ENGINE__;
      const p = e.ctx.peek('player');
      const m = p.movement;
      const start = { x: m.position.x, z: m.position.z };
      // `debugState` writes `scriptedInput`, which `latchInput` only reads while
      // control is enabled — the shot turned it off on the way in.
      p.setControlEnabled(true);
      p._suppressCamera = true;
      p.debugState(st);
      const t0 = e.ctx.time.elapsed;
      let peak = 0;
      await new Promise((done) => {
        const tick = () => {
          peak = Math.max(peak, m.horizontalSpeed);
          if (e.ctx.time.elapsed - t0 >= secs) return done();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return {
        dist: Math.hypot(m.position.x - start.x, m.position.z - start.z),
        secs: e.ctx.time.elapsed - t0,
        peak, speed: m.horizontalSpeed, state: m.state,
        sprinting: m.sprinting, jogging: m.jogging, walking: m.walking,
        runSpec: m.sprintSpeed, jogSpec: m.jogSpeed,
        at: [m.position.x, m.position.y, m.position.z],
      };
    }, [state, SECS]);

    await pump(3);
    const file = `${OUT}/${BOY}-${state}.png`;
    await page.screenshot({ path: file, type: 'png' });
    rows.push({ state, label, file, ...res });
    // Park him and hand the camera back before the next stage.
    await page.evaluate(() => {
      const p = window.__ENGINE__.ctx.peek('player');
      p.debugState('idle');
      p.movement.velocity.set(0, 0, 0);
    });
    await pump(20);
  }
} catch (e) {
  failed = e;
} finally {
  if (failed || args.verbose) console.error(logs.slice(-40).join('\n'));
  await browser.close();
  server.kill();
}

if (rows.length) {
  const f2 = (v) => Number(v).toFixed(2);
  console.log(`\n=== ${BOY.toUpperCase()} — ${SECS}s from a standing start, one mark, one camera ===`);
  console.log('  input     state    peak m/s   after Ns   metres   flags');
  for (const r of rows) {
    const flags = [r.walking && 'walking', r.jogging && 'jogging', r.sprinting && 'sprinting']
      .filter(Boolean).join(',') || '-';
    console.log(
      `  ${r.label.padEnd(9)} ${r.state.padEnd(8)} ${f2(r.peak).padStart(8)} ` +
      `${f2(r.speed).padStart(10)} ${f2(r.dist).padStart(8)}   ${flags}`
    );
  }
  const byState = Object.fromEntries(rows.map((r) => [r.state, r]));
  if (byState.jog && byState.sprint) {
    console.log(
      `\n  Shift is worth +${f2(byState.sprint.peak - byState.jog.peak)} m/s and ` +
      `+${f2(byState.sprint.dist - byState.jog.dist)} m over ${SECS}s ` +
      `(spec: jog ${f2(byState.jog.jogSpec)}, run ${f2(byState.jog.runSpec)})`
    );
  }
  console.log(`\n  frames -> ${OUT}`);
}
if (failed) { console.error(failed.message); process.exit(1); }
