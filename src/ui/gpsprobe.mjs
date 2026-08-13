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
 *   norings      with the rings switched off (the live `?owNoRings=1` arm) AND
 *                no pin dropped there is no line. If this is not null the
 *                later "a line appeared" checks are asserting a constant.
 *                "No pin" alone is no longer that state: the player is always
 *                in free roam and the next chapter stands in the world as a
 *                ring the GPS routes to, which is what the third section below
 *                is about
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
  // Every mission:start, off the BUS — the artefact both doors have to produce.
  window.__GPS__.starts = [];
  e.ctx.events.on('mission:start', (p) => window.__GPS__.starts.push(
    { id: p.id, chapter: p.chapter, name: p.name, zone: p.zone, track: p.track }));
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

/**
 * NEGATIVE CONTROL: NOTHING TO NAVIGATE TO -> NO LINE.
 *
 * "No pin dropped" is no longer that state. The player is always in free roam
 * now and the next chapter stands in the world as a ring
 * (`src/game/freeroam.js:StagingRings`), which the GPS routes to when he has
 * expressed no preference of his own — so an empty HUD needs BOTH off. The
 * rings' own `enabled` switch is the live `?owNoRings=1` arm, which is exactly
 * what makes this a control rather than a special case.
 */
await run(`
  game.freeroam.rings.enabled = false;
  game.missions.userWaypoint = null;
  e.ctx.events.emit('ui:waypoint', null);
  return true;`);
await page.waitForTimeout(1400);
await pump(30);
const idle = await run(`return { route: ui.state.route, wp: ui.state.waypoint };`);
ok('NEG CONTROL: nothing asking for a line -> no route on the HUD',
  idle.route === null || idle.route === undefined, `route ${JSON.stringify(idle.route)}`);

/* -- the ring, and the line to it -------------------------------------- */
await run(`game.freeroam.rings.enabled = true; return true;`);
await page.waitForTimeout(1400);
await pump(30);
const ringNav = await run(`
  const s = game.freeroam.rings.slots[0];
  const pin = game.getHudState().next;
  const r = ui.state.route ? Array.from(ui.state.route) : null;
  return {
    ring: s.on ? { x: s.x, z: s.z, y: s.y, r: s.r } : null,
    water: s.on ? world.isWater(s.x, s.z) : null,
    pin: pin ? { x: pin.x, z: pin.z, name: pin.name } : null,
    surface: s.on ? world.surfaceAt(s.x, s.z) : null,
    end: r ? { x: r.at(-2), z: r.at(-1) } : null,
    n: r ? r.length / 2 : 0,
  };`);
ok('a ring stands at the next chapter\'s staging point',
  !!ringNav.ring && !!ringNav.pin &&
  Math.hypot(ringNav.ring.x - ringNav.pin.x, ringNav.ring.z - ringNav.pin.z) < 1,
  `ring ${JSON.stringify(ringNav.ring)} against the map pin ${JSON.stringify(ringNav.pin)}`);
ok('...on dry, reachable ground', ringNav.water === false,
  `world.isWater ${ringNav.water}, surface "${ringNav.surface}"`);
ok('...and the GPS routes to it with no pin dropped at all',
  !!ringNav.end && ringNav.n >= 2 &&
  Math.hypot(ringNav.end.x - ringNav.ring.x, ringNav.end.z - ringNav.ring.z) <= END_EPS,
  `${ringNav.n} point(s), the line ends ` +
  `${ringNav.end ? Math.hypot(ringNav.end.x - ringNav.ring.x, ringNav.end.z - ringNav.ring.z).toFixed(2) : '-'} m from the ring`);

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

/**
 * Clearing the pin hands the line back to the RING — it must not leave a stale
 * route to a destination the player has just dismissed, and it must not leave
 * him with nothing either. The pin the probe dropped is hundreds of metres from
 * the staging point, so "the line moved back to the ring" is a real change of
 * destination and not the same array by another name.
 */
const cleared = await run(`
  e.ctx.events.emit('ui:waypoint', null);
  return true;`);
await page.waitForTimeout(1600);
await pump(30);
const backToRing = await run(`
  const s = game.freeroam.rings.slots[0];
  const r = ui.state.route ? Array.from(ui.state.route) : null;
  return { end: r ? { x: r.at(-2), z: r.at(-1) } : null,
    ring: { x: s.x, z: s.z }, wp: ui.state.waypoint };`);
ok('clearing the waypoint hands the line back to the chapter ring',
  cleared && !!backToRing.end &&
  Math.hypot(backToRing.end.x - backToRing.ring.x, backToRing.end.z - backToRing.ring.z) <= END_EPS,
  `line ends ${backToRing.end ? Math.hypot(backToRing.end.x - backToRing.ring.x, backToRing.end.z - backToRing.ring.z).toFixed(2) : '-'} m from the ring`);

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
  count: (ui.root.querySelector('.ow-obj-count')?.textContent ?? '').trim(),
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
/**
 * THE PANEL NAMES THE PLACE, NOT THE KEY. `game/index.js:RING_CUE` is the one
 * string behind this, the SIDE JOB line and both announce toasts, so a build
 * where the cue drifts between surfaces fails here.
 */
ok('...and tells him HOW to start it, in world terms',
  /RING/.test(nextIdle.panel.count),
  `the panel's meta line reads "${nextIdle.panel.count}"`);

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
 * NOT fire underneath it. The outro banter is skipped because this file is
 * about the card, not about the dialogue that precedes it.
 *
 * SKIPPING IT MEANS SKIPPING THE SCENE, not just the hold. Setting
 * `doneHold = 0` and `sceneDone = true` does NOT end the outro:
 * `mission.js:593` returns early for as long as `cut.active`, and only
 * `_sceneOverran` (26 s of raw time, `SCENE_WATCHDOG`) puts it down. MEASURED
 * on this exact sequence — `{phase: 'outro', state: 'won', sceneDone: true,
 * doneHold: 0, cut: true, scale: 0}` twenty seconds after `win()` — so the
 * three checks below were racing a 26 s watchdog against a 20 s wait and this
 * file was calling the loser a defect. `skipAll()` is the button the player
 * has; press it.
 */
await run(`
  window.__GPS__.notifies.length = 0;
  const M = game.missions.M;
  game.missions.win(M);
  M.doneHold = 0;
  ui.subs.cut && ui.subs.cut.skipAll && ui.subs.cut.skipAll();
  M.sceneDone = true;
  return true;`);
await page.waitForFunction(
  () => window.__ENGINE__.ctx.peek('ui').bigCard.active === true, null, { timeout: 20000 }
).catch(() => {});
await pump(20);
/**
 * `PRESS J` is what identifies the announce toast — it is a SUBSTRING now, the
 * value reads "FOLLOW THE RING · PRESS J" — and the filter matters: a
 * won chapter legitimately toasts its PAYOUT under the card (`+$700`), and a
 * check that counted every notification would have called that the defect.
 */
const underCard = await run(`
  const h = game.getHudState();
  const all = window.__GPS__.notifies;
  return { card: ui.bigCard.active, panel: ${panelOf}, running: game.missions.active,
    all: all.map((x) => x.text + ' / ' + x.value),
    announce: all.filter((x) => /PRESS J/.test(x.value)).map((x) => x.text) };`);
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
    announce: all.filter((x) => /PRESS J/.test(x.value))
      .map((x) => ({ text: x.text, card: x.card })) };`);
ok('the toast arrives once the screen is the player\'s again',
  afterCard.card === false && afterCard.announce.length > 0 &&
  afterCard.announce.every((t) => t.card === false),
  JSON.stringify(afterCard.announce));
ok('and the panel still says what is next after the card is gone',
  afterCard.panel.eyebrow === 'NEXT CHAPTER',
  `"${afterCard.panel.eyebrow}" / "${afterCard.panel.text}"`);

/* ==================================================================== */
/* 3. the phone's STORY page reflects what has actually been played     */
/* ==================================================================== */
/**
 * A chapter has just been WON through the real path, so the frontier has
 * moved. The page is read out of the phone's rendered ROWS — the DOM the
 * player looks at — and not off `game.getProgress()`, which is the arithmetic
 * that fed it. `game._pushProgress` is the only thing that ever writes this;
 * the probe never calls `setState`, so a build where the push is missing
 * fails here with the constructor's zeroes.
 *
 * NEGATIVE CONTROL is built in and is the reason the row texts are compared
 * rather than merely non-empty: before this wave the page printed a hard-coded
 * "4 / 24" on every save including a brand new one, so any check that only
 * asked "is there a number" passed on the dead build.
 */
await run(`
  ui.phone.show();
  ui.phone.tab = 2;         // STORY
  ui.phone.index = 0;
  ui.phone._paint();
  return true;`);
await pump(10);
const story = await run(`
  const rows = [...ui.root.querySelectorAll('.ow-phone-row')]
    .filter((r) => r.style.display !== 'none')
    .map((r) => ({
      n: (r.querySelector('.n')?.textContent ?? '').trim(),
      s: (r.querySelector('.s')?.textContent ?? '').trim(),
      v: (r.querySelector('.v')?.textContent ?? '').trim(),
    }));
  return { rows, frontier: game.getHudState().chapter, tabs:
    [...ui.root.querySelectorAll('.ow-phone-tabs .tab')].map((t) => t.textContent.trim()) };`);
const done = story.rows.filter((r) => r.v === 'DONE');
const current = story.rows.filter((r) => r.v === 'CURRENT');
const completion = story.rows.find((r) => r.n === 'COMPLETION') ?? null;
const jobsRow = story.rows.find((r) => r.n === 'SIDE JOBS') ?? null;
ok('the phone has a STORY page', story.tabs.includes('STORY'), story.tabs.join(' · '));
ok('...listing the chapter just completed as DONE',
  done.length === story.frontier && story.frontier >= 1,
  `${done.length} DONE against a frontier of ${story.frontier}: ${done.map((r) => r.n).join(', ')}`);
ok('...and exactly one CURRENT chapter to go to next',
  current.length === 1, current.map((r) => `${r.n} ${r.v}`).join(' | ') || 'none');
ok('...with a completion percent that is neither 0 nor a hard-coded default',
  !!completion && /^[1-9]\d?%$/.test(completion.v) && /OF 24 CHAPTERS$/.test(completion.s),
  completion ? `"${completion.n}" ${completion.s} -> ${completion.v}` : 'no COMPLETION row');
ok('...and a free-roam job tally',
  !!jobsRow && /^\d+$/.test(jobsRow.v),
  jobsRow ? `${jobsRow.n} = ${jobsRow.v}` : 'no SIDE JOBS row');
// PUT THE PHONE DOWN. An open phone is a live `phone` pause claim, and the
// section below drives the player through a ring — which a stopped world
// correctly refuses to notice (`game._syncRings` is gated on it).
await run(`ui.phone.hide(); return true;`);
await pump(30);

/* ==================================================================== */
/* 4. THE RING IS THE SAME DOOR AS J                                    */
/* ==================================================================== */
/**
 * Drive the player onto the staging point in steps a car could cover — the
 * entry test is swept but ignores teleports, so a single `placePlayer` onto
 * the ring is (correctly) not an entry. Then compare the `mission:start` the
 * ring produced with the one `game.startMission` produces for the same
 * chapter: two EMITTED payloads, field by field. Nothing here reads the
 * runner's own idea of what it started.
 */
const walkIn = async () => {
  const from = await run(`
    const s = game.freeroam.rings.slots[0];
    window.__GPS__.starts.length = 0;
    game.wq.placePlayer(s.x + 60, s.z, 0, null);
    return { x: s.x, z: s.z };`);
  await pump(8);
  for (let i = 1; i <= 6; i++) {
    await run(`game.wq.placePlayer(ARG.x + 60 * (1 - ARG.t), ARG.z, 0, null); return true;`,
      { x: from.x, z: from.z, t: i / 6 });
    await pump(4);
  }
  await pump(10);
  return from;
};
await walkIn();
const ringStart = await run(`
  return { active: game.missions.active, phase: game.missions.M ? game.missions.M.phase : null,
    starts: window.__GPS__.starts.slice() };`);
ok('driving into the ring starts the chapter',
  ringStart.active === true && ringStart.starts.length === 1,
  `${ringStart.starts.length} mission:start, phase ${ringStart.phase}`);

// Put the intro cutscene down before the second start: two scenes stacked on
// one another hold `time.scale` at 0 and the comparison below stops being
// about the door either of them opened.
await run(`
  ui.subs.cut && ui.subs.cut.skipAll && ui.subs.cut.skipAll();
  game.missions.abort();
  window.__GPS__.starts.length = 0;
  return true;`);
await pump(30);
await run(`game.startMission(game.nextChapter().index); return true;`);
await pump(10);
const keyStart = await run(`return window.__GPS__.starts.slice();`);
const a = ringStart.starts[0] ?? null;
const bK = keyStart[0] ?? null;
ok('...and it is the SAME mission:start the J path emits',
  !!a && !!bK && a.chapter === bK.chapter && a.name === bK.name &&
  a.zone === bK.zone && a.track === bK.track,
  `ring ${JSON.stringify(a)} vs key ${JSON.stringify(bK)}`);
await run(`
  ui.subs.cut && ui.subs.cut.skipAll && ui.subs.cut.skipAll();
  game.missions.abort();
  return true;`);
await pump(30);

/* ==================================================================== */

console.log('\n=== GPS route + the persistent NEXT state ===');
for (const r of rows) console.log(r);
if (errs.length) console.log(`\n  page errors (not gated): ${errs.slice(0, 3).join(' | ')}`);
console.log(`\ngps: ${rows.length - fails}/${rows.length}`);
await b.close();
await stopServer(srv);
process.exit(fails ? 1 : 0);
