#!/usr/bin/env node
/**
 * WORLD — the orphaned-tile gate.
 *
 * `world` emits `world:tile:unload` SYNCHRONOUSLY and QUEUES `world:tile:load`.
 * So a camera jump larger than the stream radius — a brother switch, mission
 * staging, a respawn, a capture shot — can drop a tile whose load job is still
 * in the queue. Fire that job and `buildings` and `props` build a tile `world`
 * has stopped streaming: nothing will ever unload it, and `skyline.restore()`
 * for the cells it suppressed is never called, so downtown photographs as a
 * bare plain for the rest of the session.
 *
 * WHAT THIS ASSERTS, and why it is not a re-read of the code's own input:
 * every number below comes off the LIVE MAPS the three subsystems maintain
 * INDEPENDENTLY (`world._tiles.live`, `buildings.tiles`, `props.tiles`) after a
 * real teleport through the real shot API, plus a ledger of ACTUAL
 * `skyline.suppress` / `skyline.restore` CALLS taken by wrapping both methods
 * before the first tile streams. A build that leaks cannot make those agree.
 *
 *   reconcile   every tile `buildings` / `props` hold is one `world` still
 *               streams. An orphan is a leak by definition — no unload can
 *               reach it, because the record it would name is gone
 *   restore     `skyline.restore` fires at all when tiles go away
 *   balance     net suppression (suppress - restore) equals the number of tiles
 *               actually standing. This is the VISUAL symptom as an invariant:
 *               anything above that count is a downtown cell whose impostors
 *               are switched off with no streamed geometry in their place
 *   idle        the world still reports `streamingIdle()` afterwards, i.e. the
 *               guard drops jobs rather than stranding them in the queue
 *
 * NEGATIVE CONTROL: `--leak` boots with `?owStaleTileLoads=1`, which fires the
 * stale loads on purpose. MEASURED at q=medium with the guard disabled: 15 of
 * 46 `buildings` tiles orphaned, the furthest 1044 m behind the camera, and the
 * suppression ledger 15 out of balance.
 *
 * Usage
 *   node src/world/tileleakprobe.mjs
 *   node src/world/tileleakprobe.mjs --leak         negative control
 *   node src/world/tileleakprobe.mjs --q=high
 *   node src/world/tileleakprobe.mjs --json=/tmp/tileleak.json
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const LEAK = !!args.leak;
const Q = String(args.q ?? 'medium');

const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 300; i++) {
    const p = 5900 + Math.floor(Math.random() * 900);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = await freePort();
const root = resolve(import.meta.dirname, '../..');
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
  env: { ...process.env, OW_NO_HMR: '1' },
});
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if (await portOpen(PORT)) break;
}

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--mute-audio', '--js-flags=--max-old-space-size=4096'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

/**
 * Wrap `skyline.restore` so the probe counts CALLS, not intentions. Reading
 * `skyline`'s instance table instead would be reading the same structure
 * `suppress`/`restore` write, which cannot distinguish "restored" from "never
 * suppressed".
 */
const armCounters = () => {
  const b = window.__ENGINE__.ctx.peek('buildings');
  const sk = b?.skyline;
  window.__TL__ = { restore: 0, suppress: 0 };
  if (sk && !sk.__tlWrapped) {
    sk.__tlWrapped = true;
    const r = sk.restore.bind(sk);
    const s = sk.suppress.bind(sk);
    sk.restore = (...a) => { window.__TL__.restore++; return r(...a); };
    sk.suppress = (...a) => { window.__TL__.suppress++; return s(...a); };
  }
  return !!sk;
};

/**
 * Live tile maps, read straight off the three subsystems.
 *
 * `world` keys its live set by a packed integer (`streaming.js` `key()`) while
 * `buildings` and `props` key theirs by `"tx,tz"`, so the comparison is made on
 * the tile COORDINATES the records carry, never on either side's key format.
 */
const sample = () => {
  const ctx = window.__ENGINE__.ctx;
  const w = ctx.peek('world');
  const b = ctx.peek('buildings');
  const p = ctx.peek('props');
  const wk = [...(w?._tiles?.live?.values() ?? [])].map((r) => `${r.tx},${r.tz}`);
  const live = new Set(wk);
  const cam = ctx.camera.position;
  const orphans = (map) => {
    const out = [];
    for (const k of map?.keys?.() ?? []) {
      if (live.has(k)) continue;
      const [tx, tz] = k.split(',').map(Number);
      const cx = (tx + 0.5) * 128;
      const cz = (tz + 0.5) * 128;
      out.push({ k, d: Math.round(Math.hypot(cx - cam.x, cz - cam.z)) });
    }
    return out.sort((a, b2) => b2.d - a.d);
  };
  return {
    world: wk.length,
    buildings: b?.tiles?.size ?? 0,
    props: p?.tiles?.size ?? 0,
    bOrphans: orphans(b?.tiles),
    pOrphans: orphans(p?.tiles),
    idle: w?.streamingIdle?.() === true,
    pending: w?.queue?.pending ?? -1,
    counters: { ...(window.__TL__ ?? { restore: 0, suppress: 0 }) },
    cam: [Math.round(cam.x), Math.round(cam.z)],
  };
};

const pump = (n) => page.evaluate((k) => window.__PUMP__(k), n);

let failure = null;
let R = null;
try {
  const url =
    `http://127.0.0.1:${PORT}/?capture=1&lockstep=1&prewarm=0&q=${Q}` +
    (LEAK ? '&owStaleTileLoads=1' : '');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });
  // Armed BEFORE the first tile streams, so `suppress - restore` is a complete
  // ledger for the session and can be balanced against the live tile count.
  if (!(await page.evaluate(armCounters))) throw new Error('no buildings.skyline to instrument');

  // Downtown, fully built, so there is a real suppressed skyline underneath.
  await page.evaluate(() => window.__APPLY_SHOT__('hero'));
  for (let i = 0; i < 60 && !(await page.evaluate(() => window.__SETTLED__() === true)); i++) {
    await pump(20);
  }
  const before = await page.evaluate(sample);

  /*
   * THE JUMP. Applied while the queue is deliberately NOT drained — 12 frames
   * after a second downtown re-frame — because the leak needs a load job in
   * flight when the tile is dropped. A jump from a settled state would only
   * exercise the empty-queue case and could never reproduce it.
   */
  await page.evaluate(() => window.__APPLY_SHOT__('night'));
  await pump(12);
  await page.evaluate(() => window.__APPLY_SHOT__('mill'));

  for (let i = 0; i < 90 && !(await page.evaluate(() => window.__SETTLED__() === true)); i++) {
    await pump(20);
  }
  await pump(60);
  const after = await page.evaluate(sample);
  R = { before, after };
} catch (e) {
  failure = e;
} finally {
  await browser.close();
  server.kill();
}

if (failure) {
  console.error(`[tileleak] FAILED: ${failure.message}`);
  if (errors.length) console.error(errors.slice(0, 8).join('\n'));
  process.exit(1);
}

if (args.json) {
  mkdirSync(dirname(resolve(String(args.json))), { recursive: true });
  writeFileSync(resolve(String(args.json)), JSON.stringify(R, null, 2));
}

const { before, after } = R;
console.log(`\nTILE LEAK GATE  q=${Q}${LEAK ? '  [NEGATIVE CONTROL: owStaleTileLoads=1]' : ''}`);
for (const [tag, s] of [['before jump', before], ['after jump ', after]]) {
  console.log(
    `  ${tag}  cam ${s.cam.join(',')}  world ${String(s.world).padStart(3)}  ` +
      `buildings ${String(s.buildings).padStart(3)}  props ${String(s.props).padStart(3)}  ` +
      `orphans b/p ${s.bOrphans.length}/${s.pOrphans.length}  ` +
      `skyline.restore ${s.counters.restore}  idle ${s.idle}`
  );
}
if (after.bOrphans.length) {
  const far = after.bOrphans.slice(0, 6).map((o) => `${o.k}@${o.d}m`).join(' ');
  console.log(`  furthest buildings orphans: ${far}`);
}

let bad = 0;
const check = (ok, name, detail) => {
  if (!ok) bad++;
  console.log(`  ${ok ? ' ok ' : 'FAIL'} ${name.padEnd(32)} ${detail}`);
};

check(
  after.bOrphans.length === 0,
  'buildings holds no orphan tile',
  `${after.bOrphans.length} of ${after.buildings} buildings tiles are not streamed by world` +
    (after.bOrphans.length ? ` (furthest ${after.bOrphans[0].d} m)` : '')
);
check(
  after.pOrphans.length === 0,
  'props holds no orphan tile',
  `${after.pOrphans.length} of ${after.props} props tiles are not streamed by world` +
    (after.pOrphans.length ? ` (furthest ${after.pOrphans[0].d} m)` : '')
);
check(
  after.counters.restore > 0,
  'skyline.restore fired at all',
  `${after.counters.restore} restore call(s) against ${after.counters.suppress} suppress call(s)`
);
/*
 * THE VISUAL SYMPTOM, stated as an invariant — and deliberately balanced
 * against `world`, not against `buildings`.
 *
 * `_onTileLoad` suppresses the impostors under a tile exactly once and
 * `_onTileUnload` restores them exactly once, so net suppression is "how many
 * cells of the impostor field are currently switched off". The number of cells
 * that have earned the right to be switched off is the number of tiles WORLD IS
 * STREAMING. Balancing it against `buildings.tiles.size` instead would count the
 * orphans on both sides and pass on a leaking build — measured: 46 vs 46, green,
 * with fifteen orphaned tiles in the scene. That is exactly the shape rule 12
 * warns about, and it went green here once before this line was corrected.
 *
 * A cell above that count is one whose skyline is off and whose streamed
 * geometry is a kilometre behind the camera, past the cull distance: the bare
 * tan plain this defect was reported as.
 */
const netSuppressed = after.counters.suppress - after.counters.restore;
check(
  netSuppressed === after.world,
  'skyline suppression balances',
  `${netSuppressed} cell(s) suppressed vs ${after.world} tiles world streams` +
    (netSuppressed === after.world ? '' : ` — ${netSuppressed - after.world} cell(s) left dark`)
);
check(after.idle === true, 'world is still streaming-idle', `pending ${after.pending}`);

if (LEAK) {
  console.log(
    bad > 0
      ? `\nNEGATIVE CONTROL OK — ${bad}/5 checks red with the guard disabled`
      : '\nNEGATIVE CONTROL FAILED — the leak did not reproduce, so the gate proves nothing'
  );
  process.exit(bad > 0 ? 0 : 1);
}

console.log(bad === 0 ? '\nTILE LEAK GATE PASSED' : `\nTILE LEAK GATE FAILED — ${bad}/5`);
process.exit(bad === 0 ? 0 : 1);
