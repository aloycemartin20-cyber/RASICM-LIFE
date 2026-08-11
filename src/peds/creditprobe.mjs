#!/usr/bin/env node
/**
 * CREDIT PROBE — a hitmarker means YOUR shot connected.
 *
 *   node src/peds/creditprobe.mjs
 *   node src/peds/creditprobe.mjs --json
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DEFECT THIS REPRODUCES
 * ────────────────────────────────────────────────────────────────────────────
 * `src/ui/index.js` and `src/audio/index.js` both filtered `damage:dealt` on
 * the TARGET alone and never read `source`. `src/peds/crew.js` emits one every
 * 1.5 s per brother with `source` set to that brother, so two companions drew
 * the player a centre-screen X, a floating damage number and an audible tick
 * roughly every 0.75 s with his trigger untouched. A marker that fires when you
 * did not shoot carries exactly as much information as no marker at all — and
 * it takes the honest ones down with it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT IS MEASURED, AND WHAT IS STUBBED
 * ────────────────────────────────────────────────────────────────────────────
 * The HUD half is read off the DRAWN NODES: every `.ow-hit` / `.ow-dn` element
 * the pools have made visible, and the `scale()` the hitmarker's own update
 * wrote into its transform. Not a call count, not a flag — the mark on the
 * screen and how big it is.
 *
 * The AUDIO half stubs ONE function, `AudioSystem.ui()`, and nothing else:
 * `_onDamageDealt` runs for real, including the predicate under test, and what
 * is recorded is which UI cues it asked for. Say the quiet part out loud, per
 * rule 12: **this run asserts nothing about the synthesiser.** Everything
 * downstream of `ui()` belongs to `src/audio/muteprobe.mjs` (the buses) and
 * `src/audio/bootaudioprobe.mjs` (that the graph is running at all). The stub
 * exists because a headless AudioContext needs a real gesture to unlock, and a
 * gate that can fail because the harness could not click is not a gate.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ASSERTIONS, AND THE CONTROL THAT MAKES THEM MEAN SOMETHING
 * ────────────────────────────────────────────────────────────────────────────
 *   1 MINE     the player's own round — fired through `physics.fireBullet`, the
 *              real ballistics path — draws a full-size hitmarker, a damage
 *              number and a hitmarker tick.
 *   2 THEIRS   the identical kill payload stamped with a BROTHER as `source`
 *              draws no damage number and no tick at all.
 *   3 MUTED    ...and the mark it does draw is a fraction of the size, because
 *              the crew still has to read as helping.
 *   4 CONTROL  the SAME payload with `source` deleted and nothing else changed
 *              is indistinguishable from the player's own. One field is the
 *              only difference between arms 2 and 4, so a pass on 2 cannot be
 *              the harness failing to emit, and a pass on 1 cannot be the
 *              filter being absent.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const JSON_OUT = !!args.json;

const log = (...a) => { if (!JSON_OUT) console.log(...a); };
const results = [];
const rec = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(56)} ${detail ?? ''}`);
};

/** Where the staged man stands, metres in front of the player. */
const TARGET_DIST = 9;
/**
 * A full-size marker never draws smaller than this and the muted one never
 * draws larger. `Hitmarkers.update` scales by `a * (0.62 + 0.38 * outBack)`:
 * the smallest full mark is 1.0 * 0.62 and the largest muted one is 0.32 * 1.0
 * at the overshoot peak, so the two bands do not touch and 0.5 sits between
 * them with room either side.
 */
const BIG = 0.5;

/* ==================================================================== */
/* page-side sources                                                     */
/* ==================================================================== */

const SETUP = `
const peds = ctx.peek('peds');
const phys = ctx.peek('physics');
const ui = ctx.peek('ui');
const audio = ctx.peek('audio');
const player = ctx.peek('player');
const w = ctx.peek('world');

const near = w.roads.nearestEdge(0, 0, 900);
if (near?.edge) {
  const e = near.edge;
  const na = w.roads.nodes[e.a], nb = w.roads.nodes[e.b];
  const x = na.x + (nb.x - na.x) * near.t;
  const z = na.z + (nb.z - na.z) * near.t;
  player.teleport({ x, y: w.walkableHeightAt(x, z) + 1.0, z }, 0);
}
peds.spawnCrew();
await window.__PUMP__(40);

const p = player.position;
// A brother wanders, and a brother in the lane stops the round on his own hit
// capsules — which arm 1 would score as the goon having none. Pin them out of
// the way; where does not matter as long as it is not where the goon goes, and
// the lane is chosen after they have walked there.
for (const id of peds.crewAlive?.() ?? []) peds.setCrewGuard?.(id, p.x, p.z - 9);
await window.__PUMP__(90);
const bro = peds.crew?.members?.[0]?.ped ?? null;

window.__TICKS__ = [];
if (audio) {
  // See the header: ONE function is stubbed, and it is the last one before the
  // synthesiser. Everything above it — the target filter, the source predicate,
  // the kill branch — is the production path.
  audio.ui = (kind) => { window.__TICKS__.push(String(kind)); return true; };
  audio.bark = () => false;
  /**
   * THE RUNNING FLAG IS RAISED ONLY ACROSS THE EMIT, AND LOWERED AGAIN.
   *
   * _onDamageDealt declines to do anything while the graph is down, and a
   * headless AudioContext needs a real gesture to come up. Holding the flag
   * true across frames instead makes the rest of AudioSystem run against a
   * null context, and after forty throws _error calls _teardown() and puts
   * it back to false — measured as one arm falling silent for a reason that
   * had nothing to do with the predicate. Raised synchronously, emitted into,
   * lowered: no frame ever runs under the fiction.
   */
  window.__ARM__ = () => { audio.running = true; return true; };
  window.__DISARM__ = () => { audio.running = false; };
} else {
  window.__ARM__ = () => false;
  window.__DISARM__ = () => {};
}
window.__CRED__ = { g: null, bro };
return {
  ok: !!bro && !!ui && !!audio,
  brother: !!bro, hasUi: !!ui, hasAudio: !!audio,
  broD: bro ? +Math.hypot(bro.position.x - p.x, bro.position.z - p.z).toFixed(1) : null,
};
`;

/** Wipe every drawn cue so the next arm is measured from nothing. */
const CLEAR = `
const ui = ctx.peek('ui');
ui.hit.clear();
ui.markers.clear();
await window.__PUMP__(2);
ui.hit.clear();
ui.markers.clear();
window.__TICKS__.length = 0;
return true;
`;

/**
 * ARM 1 — the player's own round, down the path a trigger pull really takes:
 * `physics.fireBullet` into the man's hit capsules, `emitImpact` raising the
 * `damage:dealt` with no `source` on it, and whatever the HUD does with that.
 *
 * IT STANDS THE MAN UP AND SHOOTS HIM IN THE SAME BREATH, and that is not
 * tidiness. Choosing the lane earlier and firing later was measured landing on
 * concrete at 6.32 m of an 8.95 m shot: the stand had drifted between the two,
 * and a bearing that was clear when it was picked was a wall when it was used.
 *
 * SELECTION IS NOT AN ASSERTION. The lane is judged with a mask that DROPS
 * ACTOR and RAGDOLL — what is being chosen is an empty stretch of city, judged
 * with the man standing in it and therefore independent of whether he can be
 * hit, which is the question the assertion asks.
 */
const MINE = `
const peds = ctx.peek('peds');
const phys = ctx.peek('physics');
const player = ctx.peek('player');
const w = ctx.peek('world');
const CITY = phys.MASK.BULLET & ~phys.LAYER.ACTOR & ~phys.LAYER.RAGDOLL;
const p = player.position;

let g = null;
let aim = null;
for (let b = 0; b < ARG.bearings && !aim; b++) {
  const th = (b / ARG.bearings) * Math.PI * 2;
  const gx = p.x + Math.cos(th) * ARG.dist, gz = p.z + Math.sin(th) * ARG.dist;
  const gy = w.walkableHeightAt(gx, gz);
  if (!Number.isFinite(gy) || w.isWater?.(gx, gz)) continue;
  // Pinned, unarmed and effectively immortal: a body to shoot at, not a
  // participant. A live enemy shooting back would put its own events on the bus.
  peds.clearHostiles();
  g = peds.spawnHostile({ x: gx, y: gy, z: gz },
    { hp: 1e9, dmg: 0, ranged: false, speed: 0, range: 0.5 });
  if (!g) break;
  await window.__PUMP__(2);
  const eye = { x: p.x, y: p.y + 1.5, z: p.z };
  const ax = g.position.x, ay = g.position.y + 1.19 * g.scale, az = g.position.z;
  const dx = ax - eye.x, dy = ay - eye.y, dz = az - eye.z;
  const len = Math.hypot(dx, dy, dz) || 1;
  const dir = { x: dx / len, y: dy / len, z: dz / len };
  const foul = phys.raycast(eye, dir, len - 0.4, CITY);
  if (foul.hit) continue;
  aim = { eye, dir, len };
}
if (!g) return { ok: false, why: 'the hostile pool refused to spawn' };
if (!aim) return { ok: false, why: 'no lane clear of city at ' + ARG.dist + ' m from this stand' };
window.__CRED__.g = g;

const hp = g.health;
const seen = [];
const off = ctx.events.on('bullet:impact', (e) => {
  if (!e || e.exit) return;
  seen.push({ surface: e.surface, part: e.part ?? null, onGoon: e.actor === g,
              d: +Math.hypot(e.point.x - aim.eye.x, e.point.y - aim.eye.y,
                             e.point.z - aim.eye.z).toFixed(2) });
});
const armed = window.__ARM__();
phys.fireBullet({
  origin: aim.eye, dir: aim.dir, damage: 24, maxDist: aim.len + 20,
  penetration: 0, dropoff: 1, mask: phys.MASK.BULLET,
});
window.__DISARM__();
off();
await window.__PUMP__(2);
return { ok: true, armed, hp: +(hp - g.health).toFixed(2), first: seen[0] ?? null,
         caps: g.colliders.length, body: !!g.body, aim: +aim.len.toFixed(2) };
`;

/**
 * ARMS 2 and 4 — one kill payload, emitted twice, differing in ONE FIELD.
 * Shaped exactly like `Crew._strike`'s, because that is the emitter the defect
 * was measured on.
 */
const ALLY = `
const g = window.__CRED__.g;
const bro = window.__CRED__.bro;
const pay = {
  target: g, amount: 34, headshot: false, killed: true,
  point: { x: g.position.x, y: g.position.y + 1.1, z: g.position.z },
  from: bro.position,
};
if (ARG.stamp) pay.source = bro;
const armed = window.__ARM__();
ctx.events.emit('damage:dealt', pay);
window.__DISARM__();
await window.__PUMP__(2);
return { armed };
`;

/** What is actually on the screen, and what audio was actually asked for. */
const READ = `
const hits = [];
for (const n of document.querySelectorAll('.ow-hit')) {
  if (n.style.display === 'none') continue;
  const m = /scale\\(([-0-9.]+)\\)/.exec(n.style.transform ?? '');
  hits.push(m ? +Number(m[1]).toFixed(3) : null);
}
let dn = 0;
for (const n of document.querySelectorAll('.ow-dn')) if (n.style.display !== 'none') dn++;
return { hits, dn, ticks: window.__TICKS__.slice() };
`;

/* ==================================================================== */

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--disable-frame-rate-limit'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 576 } });
const pageErrors = [];
page.on('pageerror', (e) => { if (pageErrors.length < 20) pageErrors.push(String(e.message).slice(0, 200)); });

const runAsync = (src, a = null) =>
  page.evaluate(({ s, x }) => {
    const engine = window.__ENGINE__;
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return new AsyncFunction('engine', 'ctx', 'ARG', s)(engine, engine.ctx, x);
  }, { s: src, x: a });
const settle = async (budget = 60) => {
  for (let k = 0; k < budget; k++) {
    await page.evaluate(() => window.__PUMP__(20));
    if (await page.evaluate(() => (window.__SETTLED__ ? window.__SETTLED__() : true))) return true;
  }
  return false;
};

let exitCode = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/?q=low&prewarm=0&capture=1&lockstep=1`,
    { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 150000 });
  await page.evaluate(() => { window.__ENGINE__.input.enabled = false; });
  await settle();

  log('\ncredit probe — whose round earned the hitmarker');
  const set = await runAsync(SETUP, { dist: TARGET_DIST });
  if (!set.ok) {
    rec('the stage was built: a brother on his feet, a HUD and audio', false,
      `brother ${set.brother}, ui ${set.hasUi}, audio ${set.hasAudio}`);
    throw new Error('staging failed');
  }

  await runAsync(CLEAR);
  const shot = await runAsync(MINE, { dist: TARGET_DIST, bearings: 48 });
  if (!shot.ok) {
    rec('a man was stood in a lane clear of city and shot at', false, shot.why);
    throw new Error('staging failed');
  }
  const mine = await runAsync(READ);
  log(`  staged: a man ${shot.aim} m down a clear lane, a brother pinned ${set.broD} m off`);

  await runAsync(CLEAR);
  const allyArm = await runAsync(ALLY, { stamp: true });
  const theirs = await runAsync(READ);

  await runAsync(CLEAR);
  const anonArm = await runAsync(ALLY, { stamp: false });
  const anon = await runAsync(READ);

  const big = (r) => r.hits.filter((h) => h != null && h >= BIG).length;
  const small = (r) => r.hits.filter((h) => h != null && h < BIG).length;
  // EXACT names: `ui.hitmarker()` also asks for `hit_kill` / `hit_flesh`
  // through `playUi`, and a substring match would score those as the audio
  // system's own tick. Both matter, and they are not the same cue.
  const tick = (r) => r.ticks.filter((t) => /^(hitmarker|headshot|kill)$/.test(t)).length;

  rec('1 MINE    the player\'s own round draws a marker, a number and a tick',
    shot.hp > 0 && big(mine) === 1 && mine.dn >= 1 && tick(mine) >= 1,
    `-${shot.hp} HP off a ${shot.aim} m shot (first impact ${JSON.stringify(shot.first)}, ` +
    `${shot.caps} capsule(s), body ${shot.body}), ${big(mine)} full marker(s) ` +
    `${JSON.stringify(mine.hits)}, ${mine.dn} damage number(s), ticks ${JSON.stringify(mine.ticks)}`);

  rec('2 THEIRS  a brother\'s kill draws no damage number and no tick',
    theirs.dn === 0 && tick(theirs) === 0 && big(theirs) === 0 && allyArm.armed,
    `${big(theirs)} full marker(s), ${theirs.dn} damage number(s), ` +
    `ticks ${JSON.stringify(theirs.ticks)}` +
    (allyArm.armed ? '' : ', AUDIO NOT ARMED — the silence proves nothing'));

  rec('3 MUTED   ...but it still draws, small, so the crew reads as helping',
    small(theirs) === 1,
    `${small(theirs)} muted mark(s) ${JSON.stringify(theirs.hits)} (full is >= ${BIG})`);

  rec('4 CONTROL delete `source` and the SAME payload is credited to the player',
    big(anon) === 1 && anon.dn >= 1 && tick(anon) >= 2 && anonArm.armed,
    `${big(anon)} full marker(s) ${JSON.stringify(anon.hits)}, ` +
    `${anon.dn} damage number(s), ticks ${JSON.stringify(anon.ticks)}`);

  if (pageErrors.length) rec('no page errors', false, pageErrors.join(' | '));

  const failed = results.filter((r) => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (JSON_OUT) console.log(JSON.stringify({ results, mine, theirs, anon }, null, 2));
  exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error('creditprobe failed:', e?.message ?? e);
  if (pageErrors.length) console.error('  page errors:', pageErrors.join(' | '));
  exitCode = 1;
} finally {
  await browser.close();
  server?.kill();
}

process.exit(exitCode);
