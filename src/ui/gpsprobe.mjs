#!/usr/bin/env node
/**
 * UI — "does the map answer the two questions the player actually asks?"
 *
 *   node src/ui/gpsprobe.mjs        (npm run gps)
 *
 * Two features that both LOOK fine when they are dead, which is why they need
 * a gate rather than a glance:
 *
 *   THE GPS LINE. `world.routeTo` has existed and been gated by
 *   `src/world/routeprobe.mjs` since wave 2, and `radar.js` has had a route
 *   draw pass for longer than that — but NOTHING EVER CALLED THE ONE WITH THE
 *   OTHER. `ui.setRoute` was only ever fed by `debugState`, i.e. by a
 *   screenshot fiction. A player who dropped a pin on the map got a flag and
 *   no line, on both projections, and every frame of it looked like a HUD
 *   working correctly.
 *
 *   THE "WHAT NOW" PANEL. `game.getHudState().objective` was null whenever no
 *   chapter was running, so the readout that says what the game is asking of
 *   you was blank for most of the playtime, and the only carrier of that
 *   information was a four-second toast fired the same frame the full-screen
 *   result card went up — underneath it, where nobody has ever read one.
 *
 * WHY IT IS NOT CIRCULAR (ARCHITECTURE.md rule 12)
 *
 * Everything is asserted against what `ui` HOLDS AND DRAWS, never against
 * `game`'s bookkeeping or the router's:
 *
 *   - the route is read off `ui.state.route` — the flat array the Slag Ring
 *     strokes — and its endpoints are compared with the waypoint the probe
 *     itself emitted and the player position the probe itself set. The probe
 *     never calls `world.routeTo`, so it cannot agree with the solver by
 *     construction;
 *   - the ALIASING check is the one that would have caught the most likely
 *     way to write this feature wrongly. `world.routeTo` documents that its
 *     waypoint array is REUSED between calls, so a caller that hands the array
 *     straight to `ui` publishes a buffer the next solve overwrites. The probe
 *     makes `world` solve a completely different route and then asserts the
 *     line `ui` is holding did not move;
 *   - the latency is measured in WALL CLOCK milliseconds around a tap on
 *     `ui.setRoute`, not in frames and not off `game`'s own timer.
 *
 * Negative controls, all of which must fire or the run is meaningless:
 *
 *   nowaypoint   with no pin dropped there is no line. If this is not null the
 *                later "a line appeared" checks are asserting a constant
 *   liveobjective  a RUNNING chapter must own the panel. If the NEXT state
 *                showed through a live mission, the "it survives the card"
 *                check would pass on a build where NEXT simply never goes away
 *   stalecard    the toast must NOT have arrived while the card was up. That
 *                is the defect; without this arm "a toast eventually arrives"
 *                passes on the unfixed build too. It filters on the PRESS J
 *                value, because a won chapter legitimately toasts its payout
 *                under the card and counting every notification would call
 *                that the bug
 *
 * One more check earns its place for a reason that is not about this feature:
 * `game.getHudState().objective` must stay NULL in free roam, because
 * `src/ui/hud.js` hides the boss bar on it. The first cut of the NEXT panel
 * fell `objective` back to the NEXT record, and `src/ui/wardprobe.mjs` caught
 * a dead rival's health bar 39.9 px wide over an empty street. Two fields, and
 * a check here that says why.
 */
import { startServer, stopServer } from '../../tools/lib/server.mjs';
import { chromium } from 'playwright';

/** Wall-clock milliseconds a waypoint change has to reach `ui.setRoute` in. */
const ROUTE_LATENCY_MS = 1000;
/** Metres the route's ends may miss the player / the pin by. The off-graph
 *  stubs are exact (`route.js` emits the caller's own coordinates), so this is
 *  float slop plus one frame of the player drifting, not a tolerance. */
const END_EPS = 2;

const srv = await startServer();
const port = srv.port;
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });

const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

const pump = (n) =>
  page.evaluate((k) => new Promise((d) => {
    let i = 0;
    const t = () => (++i >= k ? d() : requestAnimationFrame(t));
    requestAnimationFrame(t);
  }), n);

const run = (body, arg) => page.evaluate(new Function('ARG', `
  const e = window.__ENGINE__;
  const game = e.ctx.peek('game');
  const ui = e.ctx.peek('ui');
  const world = e.ctx.peek('world');
  ${body}
`), arg);

await page.goto(`http://127.0.0.1:${port}/?boot=0`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
await pump(60);

/* -- taps: everything measured below is measured HERE, at the ui boundary -- */
await run(`
  window.__GPS__ = { routes: [], notifies: [] };
  const setRoute = ui.setRoute.bind(ui);
  ui.setRoute = (flat) => {
    window.__GPS__.routes.push({ t: performance.now(), n: flat ? flat.length : 0 });
    return setRoute(flat);
  };
  const notify = ui.notify.bind(ui);
  ui.notify = (text, value, tone) => {
    window.__GPS__.notifies.push({ t: performance.now(), text: String(text ?? ''),
      value: String(value ?? ''), card: ui.bigCard.active });
    return notify(text, value, tone);
  };
  e.input.enabled = true;
  e.input.frozen = false;
  game.missions.abort();
  return true;`);
await pump(20);

let fails = 0;
const rows = [];
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  rows.push(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};

/* ==================================================================== */
/* 1. the GPS line                                                      */
/* ==================================================================== */

// NEGATIVE CONTROL: no pin, no line.
const idle = await run(`return { route: ui.state.route, wp: ui.state.waypoint };`);
ok('NEG CONTROL: no waypoint dropped -> no route on the HUD',
  idle.route === null || idle.route === undefined, `route ${JSON.stringify(idle.route)}`);

/**
 * Drop the pin through the exact wire the pause map uses (`ui:waypoint`), at a
 * point picked off the ROAD GRAPH so "not by road" cannot be the answer — and
 * on the same island as the player, which `route.js` refuses across.
 */
const drop = await run(`
  const p = ui.state;
  const near = world.roads.nearestEdge(p.x, p.z, 200);
  // A node ~500-900 m away on the drivable network: far enough that the route
  // is a real multi-leg drive, close enough to stay in one district.
  let best = null;
  for (const n of world.roads.nodes) {
    const d = Math.hypot(n.x - p.x, n.z - p.z);
    if (d < 450 || d > 950) continue;
    if (world.streetAt(n.x, n.z, n.y) == null) continue;
    if (!best || d < best.d) best = { d, x: n.x, z: n.z };
  }
  if (!best) return null;
  window.__GPS__.routes.length = 0;
  window.__GPS__.dropped = performance.now();
  e.ctx.events.emit('ui:waypoint', { x: best.x, z: best.z });
  return { x: best.x, z: best.z, d: best.d, px: p.x, pz: p.z, near: !!near.edge };`);
ok('the probe found a road-reachable pin to drop (test can fail)',
  !!drop, drop ? `${drop.d.toFixed(0)} m away at ${drop.x.toFixed(0)}, ${drop.z.toFixed(0)}` : 'no node found');

// Wait for a route, in WALL CLOCK, and record how long it took.
await page.waitForFunction(() => (window.__GPS__.routes.at(-1)?.n ?? 0) >= 4,
  null, { timeout: 8000 }).catch(() => {});
const fed = await run(`
  const g = window.__GPS__;
  const last = g.routes.at(-1) ?? null;
  return { ms: last ? last.t - g.dropped : -1, n: last ? last.n : 0,
    calls: g.routes.length, route: ui.state.route ? Array.from(ui.state.route) : null };`);
ok(`a waypoint change reaches ui.setRoute within ${ROUTE_LATENCY_MS} ms`,
  fed.ms >= 0 && fed.ms <= ROUTE_LATENCY_MS && fed.n >= 4,
  `${fed.ms.toFixed(0)} ms, ${fed.n / 2} points, ${fed.calls} call(s)`);

const ends = fed.route && drop
  ? {
    from: Math.hypot(fed.route[0] - drop.px, fed.route[1] - drop.pz),
    to: Math.hypot(fed.route.at(-2) - drop.x, fed.route.at(-1) - drop.z),
  }
  : null;
ok('the line starts at the player and ends at the pin', !!ends &&
  ends.from <= END_EPS + 8 && ends.to <= END_EPS,
  ends ? `start off by ${ends.from.toFixed(2)} m, end off by ${ends.to.toFixed(2)} m` : 'no route');

/**
 * THE ALIASING CHECK. `world.routeTo` hands back a REUSED array; a caller that
 * publishes it directly publishes a buffer the next solve rewrites. Solve
 * something else and confirm the published line is untouched.
 */
const alias = await run(`
  const before = Array.from(ui.state.route);
  // Any other pair on the network — the point is that it re-solves, not where.
  const n0 = world.roads.nodes[Math.floor(world.roads.nodes.length * 0.17)];
  const n1 = world.roads.nodes[Math.floor(world.roads.nodes.length * 0.61)];
  const other = world.routeTo(n0.x, n0.z, n1.x, n1.z);
  const after = Array.from(ui.state.route);
  let moved = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) moved++;
  return { moved, len: before.length, solved: !!other, otherLen: other ? other.length : 0 };`);
ok('an unrelated solve does not rewrite the published line (routeTo REUSES its array)',
  alias.moved === 0 && alias.solved,
  `${alias.moved}/${alias.len} coordinates changed; the other solve returned ${alias.otherLen} waypoint(s)`);

ok('the pause map draws the same array the ring does',
  await run(`return ui.map.route === ui.state.route;`), 'ui.map.route === ui.state.route');

/** The FROM end moves with the player: the poll is ~1 Hz, not once ever. */
const moved = await run(`
  const p = ui.state;
  const before = ui.state.route ? Array.from(ui.state.route).slice(0, 2) : null;
  // Somewhere else on the same road network, so the new solve is still a route.
  let spot = null;
  for (const n of world.roads.nodes) {
    const d = Math.hypot(n.x - p.x, n.z - p.z);
    if (d < 180 || d > 320) continue;
    if (world.streetAt(n.x, n.z, n.y) == null) continue;
    spot = n;
    break;
  }
  if (!spot) return null;
  game.wq.placePlayer(spot.x, spot.z, 0, null);
  window.__GPS__.movedAt = performance.now();
  return { before, x: spot.x, z: spot.z };`);
await page.waitForTimeout(1600);
await pump(30);
const resolved = await run(`
  const now = ui.state.route ? Array.from(ui.state.route).slice(0, 2) : null;
  return { now, dropped: window.__GPS__.routes.length };`);
const startShift = moved && resolved.now
  ? Math.hypot(resolved.now[0] - moved.before[0], resolved.now[1] - moved.before[1]) : -1;
ok('the line re-solves from where the car now is (the ~1 Hz poll runs)',
  startShift > 50, `the start moved ${startShift.toFixed(0)} m after the player did`);

/** Clearing the pin clears the line — otherwise a stale route outlives it. */
const cleared = await run(`
  e.ctx.events.emit('ui:waypoint', null);
  return true;`);
await page.waitForTimeout(1400);
await pump(20);
ok('clearing the waypoint clears the line',
  cleared && (await run(`return ui.state.route;`)) === null, 'route back to null');

/* ==================================================================== */
/* 2. the persistent NEXT state                                         */
/* ==================================================================== */

/**
 * Read the PANEL, not `game`'s record: what the player sees is the claim.
 * `objective` is checked separately and for the opposite reason — see below.
 */
const panelOf = `{
  eyebrow: (ui.root.querySelector('.ow-obj-eyebrow')?.textContent ?? '').trim(),
  text: (ui.root.querySelector('.ow-obj-text')?.textContent ?? '').trim(),
  vis: +((ui.root.querySelector('.ow-obj')?.style.opacity) || '0'),
}`;

const nextIdle = await run(`
  const h = game.getHudState();
  return { panel: ${panelOf}, objective: h.objective,
    next: h.next ? { x: h.next.x, z: h.next.z, name: h.next.name } : null,
    blips: (ui._blipView ?? []).map((x) => x.kind) };`);
ok('with nothing running the panel says what is next',
  nextIdle.panel.eyebrow === 'NEXT CHAPTER' && nextIdle.panel.text.length > 2 &&
  nextIdle.panel.vis > 0.5,
  `"${nextIdle.panel.eyebrow}" / "${nextIdle.panel.text}" at opacity ${nextIdle.panel.vis}`);
/**
 * THE CROSS-SUBSYSTEM CONTRACT THIS FEATURE ALMOST BROKE, kept honest here.
 *
 * `src/ui/hud.js`'s boss bar hides itself on `_bossOn && hud.objective`,
 * because a null `objective` is the one signal that survives a chapter ending
 * by a route that emits no lifecycle event (an abort followed immediately by
 * the next `startMission`). The first cut of the NEXT panel simply fell
 * `objective` back to the NEXT record, which made it permanently truthy — and
 * left a dead rival's health bar 39.9 px wide over an empty street. It is a
 * SECOND field for that reason, and this is the check that says so.
 */
ok('...without making game.objective truthy in free roam (hud.js reads that)',
  nextIdle.objective === null, `objective ${JSON.stringify(nextIdle.objective)}`);
ok('...and the map carries a chapter pin for it',
  !!nextIdle.next && nextIdle.blips.includes('chapter'),
  `pin ${JSON.stringify(nextIdle.next)}, blip kinds ${JSON.stringify(nextIdle.blips)}`);

// NEGATIVE CONTROL: a live chapter owns the panel; NEXT must not show through.
const live = await run(`
  game.startMission(game.nextChapter().index);
  game.missions.skipIntro && game.missions.skipIntro();
  game.missions.forceBegin && game.missions.forceBegin();
  return true;`);
await pump(20);
const liveObj = await run(`
  const h = game.getHudState();
  return { panel: ${panelOf}, objective: !!h.objective, nextObjective: h.nextObjective,
    active: game.missions.active, next: h.next };`);
ok('NEG CONTROL: a running chapter owns the panel, NEXT does not show through',
  live && liveObj.active && liveObj.objective === true &&
  liveObj.nextObjective === null && liveObj.panel.eyebrow !== 'NEXT CHAPTER' &&
  liveObj.next === null,
  `panel "${liveObj.panel.eyebrow}" / "${liveObj.panel.text}", next pin ${JSON.stringify(liveObj.next)}`);

/**
 * THE DEFECT, EXACTLY. WIN the chapter — the real path, `missions.win` ->
 * `mission:complete` -> `ui`'s own result card — and watch both halves: the
 * panel must go back to NEXT while the card is still up, and the toast must
 * NOT fire underneath it. The outro banter is skipped (`doneHold = 0`) because
 * this file is about the card, not about the dialogue that precedes it.
 */
await run(`
  window.__GPS__.notifies.length = 0;
  const M = game.missions.M;
  game.missions.win(M);
  M.doneHold = 0;
  M.sceneDone = true;
  return true;`);
await page.waitForFunction(
  () => window.__ENGINE__.ctx.peek('ui').bigCard.active === true, null, { timeout: 20000 }
).catch(() => {});
await pump(20);
/**
 * `PRESS J` is what identifies the announce toast, and the filter matters: a
 * won chapter legitimately toasts its PAYOUT under the card (`+$700`), and a
 * check that counted every notification would have called that the defect.
 */
const underCard = await run(`
  const h = game.getHudState();
  const all = window.__GPS__.notifies;
  return { card: ui.bigCard.active, panel: ${panelOf}, running: game.missions.active,
    all: all.map((x) => x.text + ' / ' + x.value),
    announce: all.filter((x) => x.value === 'PRESS J').map((x) => x.text) };`);
ok('the chapter really ended and the result card really came up (test can fail)',
  underCard.card === true, `card ${underCard.card}, chapter still running ${underCard.running}`);
ok('the NEXT state is back while the result card is still up',
  underCard.card === true && underCard.panel.eyebrow === 'NEXT CHAPTER' &&
  underCard.panel.vis > 0.5,
  `panel "${underCard.panel.eyebrow}" / "${underCard.panel.text}" at opacity ${underCard.panel.vis}`);
ok('NEG CONTROL: no "press J" toast fired underneath the card',
  underCard.announce.length === 0,
  `announce toasts under the card: ${JSON.stringify(underCard.announce)}; ` +
  `everything that did toast: ${JSON.stringify(underCard.all)}`);

// The card expires on its own; the toast is owed the moment it does.
await page.waitForFunction(
  () => window.__ENGINE__.ctx.peek('ui').bigCard.active === false, null, { timeout: 20000 }
).catch(() => {});
await page.waitForTimeout(2200);
await pump(40);
const afterCard = await run(`
  const all = window.__GPS__.notifies;
  return { panel: ${panelOf}, card: ui.bigCard.active,
    announce: all.filter((x) => x.value === 'PRESS J')
      .map((x) => ({ text: x.text, card: x.card })) };`);
ok('the toast arrives once the screen is the player\'s again',
  afterCard.card === false && afterCard.announce.length > 0 &&
  afterCard.announce.every((t) => t.card === false),
  JSON.stringify(afterCard.announce));
ok('and the panel still says what is next after the card is gone',
  afterCard.panel.eyebrow === 'NEXT CHAPTER',
  `"${afterCard.panel.eyebrow}" / "${afterCard.panel.text}"`);

/* ==================================================================== */

console.log('\n=== GPS route + the persistent NEXT state ===');
for (const r of rows) console.log(r);
if (errs.length) console.log(`\n  page errors (not gated): ${errs.slice(0, 3).join(' | ')}`);
console.log(`\ngps: ${rows.length - fails}/${rows.length}`);
await b.close();
await stopServer(srv);
process.exit(fails ? 1 : 0);
