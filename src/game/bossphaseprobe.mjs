#!/usr/bin/env node
/**
 * BOSS PHASE / CHAPTER OWNERSHIP PROBE — a live chapter owns the world.
 *
 *   node src/game/bossphaseprobe.mjs
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 *  1. `boss.js` kept its health-keyed phase counter in `M.phase` — the RUNNER's
 *     lifecycle field ('intro'|'travel'|'run'|'outro'|'over'). `missions.running`
 *     is `M.phase === 'run'`, so it was FALSE for all three CH7 fights, and five
 *     subsystems read a live finale as free roam: the body shop repaired mid
 *     fight, the race prompt offered a circuit (whose `startCustom` aborts the
 *     live chapter), the safehouse offered a bed, every carjack priced heat, the
 *     kill drops a boss fight's attrition maths assumes stopped spawning, and
 *     every minion kill charged a wanted star into a phase scored on reaching
 *     zero stars.
 *  2. `GameSystem.switchTo` refused a brother switch mid-chapter, but the `U`
 *     key called `characters.cycle(1)` and the X wheel came in through the
 *     `ui:character` event — both landed in `Characters.switchTo`, which had no
 *     mission test at all. Progression is written against whoever is ACTIVE when
 *     a chapter ends (`cs.chapter = Math.max(cs.chapter, M.idx + 1)`), so two
 *     taps of U during Carson's CH8 set DYLAN's frontier to 8, fired his ending
 *     and skipped all eight of his chapters. `Math.max` never regresses.
 *  3. `K` threw a live chapter away on one unconfirmed press, one key from the
 *     `J` the pause panel tells the player to press.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS MEASURES
 * ---------------------------------------------------------------------------
 * Nothing here re-reads the value the code under test just computed:
 *
 *   - the phase defect is measured through a REAL DOWNSTREAM READER. The kill
 *     drop lives in `HostilePool._dropFor`, gated on `game.missions.running`,
 *     and this probe runs the production `HostilePool` against the production
 *     `MissionRunner` and counts PICKUPS SPAWNED. A build with the counter back
 *     in `M.phase` drops nothing during a boss fight;
 *   - the boss's own phase escalation is measured on the EMITTED WAVE — how many
 *     hostiles `peds.spawnHostile` was actually asked for when his health
 *     crossed a phase boundary — so a rename that quietly stopped the counter
 *     advancing cannot pass;
 *   - the runner's guard is measured on `console.error` TEXT plus the recovered
 *     `running`, driven by fake tracks that clobber `phase` from `init` and from
 *     `update`. The real boss chapter is asserted to raise NO such error, which
 *     is what would go red if the counter moved back into `phase`;
 *   - the switch refusal is measured on `characters.activeId` and on
 *     `player.setBrother` — who the game is actually playing — and on the toast
 *     the player is shown, never on the predicate;
 *   - the abort is measured on the RESULT CARD `ui.card(kind, text)` receives
 *     and on the `mission:fail` event, i.e. what the screen says, not on which
 *     internal method ran.
 *
 * Difficulty tables, boss stats and radii are read from `data.js` where the
 * probe needs a number to compare against, but no assertion is a constant
 * copied out of the file under test: the wave size is compared against
 * `BOSSES[id].minions[phase]`, which is authored content, not logic.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS (all four measured — see the summary line each prints)
 * ---------------------------------------------------------------------------
 *   - a fake track that writes `M.phase = 0` in `init` (the exact pre-fix boss
 *     shape) -> the guard logs and `running` survives;
 *   - the same clobber from `update` -> same;
 *   - a well-behaved fake track -> the guard does NOT fire, so it cannot be
 *     passing by logging on everything;
 *   - the kill drop with NO chapter live -> nothing drops, so "it dropped" is
 *     not true of every build.
 */

import { MissionRunner } from './mission.js';
import { TRACKS } from './tracks.js';
import { HostilePool } from './hostiles.js';
import { Characters } from './characters.js';
import { GameSystem } from './index.js';
import { BOYZ, BOSSES, BOY_ORDER } from './data.js';
import { blankSave } from './save.js';

/* -------------------------------------------------------------------------- */
/* assertions                                                                 */
/* -------------------------------------------------------------------------- */

let pass = 0, fail = 0;
const rows = [];
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  rows.push({ ok: !!ok, name, detail: String(detail ?? '') });
};

/* -------------------------------------------------------------------------- */
/* the harness: enough engine to run a chapter, none of the browser           */
/* -------------------------------------------------------------------------- */

/** Deterministic stand-in for `ctx.rng` — no `Math.random` anywhere (rule 4). */
function rng() {
  let n = 1;
  const r = {
    fork: () => rng(),
    float: () => 0,                       // every drop roll succeeds: 0 < 0.28
    range: (a, b) => (a + b) / 2,
    int: (a, b) => a + ((n++) % Math.max(1, b - a + 1)),
    u32: () => (n = (n * 1664525 + 1013904223) >>> 0),
  };
  return r;
}

function bus() {
  const map = new Map();
  return {
    log: [],
    on(k, fn) {
      (map.get(k) ?? map.set(k, []).get(k)).push(fn);
      return () => this.off(k, fn);
    },
    off(k, fn) {
      const a = map.get(k);
      if (a) a.splice(a.indexOf(fn) >>> 0, 1);
    },
    emit(k, p) {
      this.log.push({ k, id: p?.id ?? null, reason: p?.reason ?? null });
      for (const fn of map.get(k) ?? []) fn(p);
    },
  };
}

/** A HUD that only remembers what it was told to show. */
function fakeUi() {
  return {
    toasts: [],
    cards: [],
    notify(text, value, tone) { this.toasts.push({ text, value, tone }); },
    card(kind, sub) { this.cards.push({ kind, sub }); },
    say() {},
    setCharacter(id) { this.character = id; },
    setMoney() {},
    setStation() {},
    setWaypoint() {},
    setObjectives() {},
    clearObjective() {},
    titleCard() {},
    lastToast() { return this.toasts[this.toasts.length - 1] ?? null; },
  };
}

/**
 * A `WorldQuery` stand-in. Flat ground, no roads, no vehicles: this probe is
 * about chapter lifecycle, and a real city would only add reasons for a boot to
 * fail somewhere else.
 */
function fakeWq(ui) {
  const player = {
    brother: null,
    dead: false,
    inVehicle: false,
    health: { value: 100, max: 100, armour: 0 },
    setBrother(id) { this.brother = id; },
    addTrauma() {},
  };
  return {
    ui,
    audio: { setRadioRotation() {}, setRadioStation() {} },
    player,
    pos: { x: 0, y: 0, z: 0 },
    poi: () => null,
    uiSfx() {},
    sfx() {},
    groundY: () => 0,
    focusPos() { return this.pos; },
    playerPos() { return this.pos; },
    playerVehicle: () => null,
    placePlayer(x, z, yaw, y = 0) { this.pos = { x, y, z }; this.yaw = yaw; return true; },
    findGroundSpot(min, max, cx = 0, cz = 0) { return { x: cx + min, z: cz, y: 0, yaw: 0, ok: true }; },
    findRoadSpot(min, max, cx = 0, cz = 0) { return { x: cx + min, z: cz, y: 0, yaw: 0, ok: true }; },
    curbSpot(x, z) { return { x: x + 4, z, yaw: 0 }; },
    nearestShop: () => null,
    spawnVehicle: () => null,
    despawnVehicle() {},
    weapons: null,
  };
}

/** `peds`, as `HostilePool` needs it: a spawner and a kill slot. */
function fakePeds() {
  return {
    spawned: [],
    hostiles: { onKill: null, live: [], aliveCount: 0 },
    spawnHostile(v, opts) {
      const h = {
        position: { x: v.x, y: v.y, z: v.z },
        health: opts?.hp ?? 100,
        maxHealth: opts?.hp ?? 100,
        dead: false,
        active: true,
        opts,
      };
      this.spawned.push(h);
      return h;
    },
    despawnHostile(h) { if (h) h.active = false; },
    clearHostiles() { for (const h of this.spawned) h.active = false; },
    hurtHostile: () => false,
  };
}

function fakePickups() {
  return {
    spawned: [],
    spawn(x, z, kind, opts) { const p = { x, z, kind, opts }; this.spawned.push(p); return p; },
    despawn() {},
    clearMission() {},
  };
}

/** Just the economy/heat/save surface a chapter's start and end touch. */
function fakeEconomy(save, id = 'carson') {
  return {
    cash: save.chars[id].cash,
    respect: save.chars[id].respect,
    char: (who = id) => save.chars[who],
    addCash() {}, addRespect: () => [], unlockWeapon: () => false,
  };
}

function fakeHeat() {
  return { wanted: 0, raise() {}, clear() {}, heat() {} };
}

/** Builds one wired-up world. `missions` is REAL — it is the thing under test. */
function scene({ difficulty = 'normal' } = {}) {
  const save = blankSave();
  const ui = fakeUi();
  const wq = fakeWq(ui);
  const events = bus();
  const peds = fakePeds();
  const pickups = fakePickups();
  const time = { raw: 0, elapsed: 0, dt: 1 / 60, scale: 1, frame: 0 };
  const bag = { peds };
  const ctx = {
    rng: rng(),
    events,
    time,
    peek: (i) => bag[i] ?? null,
    get: (i) => bag[i] ?? null,
    has: (i) => i in bag,
  };
  const economy = fakeEconomy(save);
  const heat = fakeHeat();
  const hostiles = new HostilePool(ctx, wq).init();
  const missions = new MissionRunner(ctx, {
    wq, economy, heat, hostiles, pickups, save,
  });
  missions.difficulty = difficulty;
  // `_dropFor` reaches the game system through `ctx.peek('game')`, exactly as it
  // does in play. This is the whole downstream reader, unmodified.
  bag.game = { missions, pickups };
  return { save, ui, wq, events, peds, pickups, ctx, economy, heat, hostiles, missions, bag, time };
}

/** Capture `console.error` for the duration of `fn`. */
function withErrors(fn) {
  const seen = [];
  const real = console.error;
  console.error = (...a) => seen.push(a.join(' '));
  try { fn(); } finally { console.error = real; }
  return seen;
}

/* ========================================================================== */
/* 1 — A REAL BOSS CHAPTER: the runner's lifecycle survives the fight        */
/* ========================================================================== */

{
  const s = scene();
  const boy = BOYZ.carson;
  const idx = boy.story.findIndex((c) => c.track === 'boss');
  const B = BOSSES[boy.story[idx].bossId];

  const errs = withErrors(() => {
    s.missions.start(boy, idx);
    // Walk the intro out on the runner's own clock — no `ui`, so the phase
    // times out into `_begin` exactly as it does on a headless bench.
    for (let i = 0; i < 8 && s.missions.M.phase === 'intro'; i++) s.missions.update(1);
  });

  const M = s.missions.M;
  check('boss chapter reaches the run phase', M?.phase === 'run', `phase ${M?.phase}`);
  check('THE DEFECT: missions.running is TRUE during a boss fight',
    s.missions.running === true, `running ${s.missions.running}, phase ${JSON.stringify(M?.phase)}`);
  check('the boss is on his feet', !!M?.bossEnt, `bossEnt ${!!M?.bossEnt}`);
  check('the phase counter is a track-owned field, not the lifecycle one',
    typeof M?.bossPhase === 'number' && typeof M?.phase === 'string',
    `bossPhase ${JSON.stringify(M?.bossPhase)}, phase ${JSON.stringify(M?.phase)}`);
  check('the real boss track raises NO clobber error', errs.length === 0,
    errs[0] ?? 'clean');

  // ---- the downstream reader, live: a mission kill drops something --------
  const minion = s.peds.spawned[0];
  s.hostiles._onKill(minion);
  check('KILL DROP: a mission kill drops during the fight (HostilePool._dropFor)',
    s.hostiles.drops === 1 && s.pickups.spawned.length === 1,
    `drops ${s.hostiles.drops}, pickups ${s.pickups.spawned.length}`);

  // ---- his health crosses a phase boundary --------------------------------
  const before = s.peds.spawned.length;
  const ent = M.bossEnt;
  ent.health = ent.maxHealth * 0.45;          // 1 - 0.45 = 0.55 -> phase 1 of 3
  s.missions.update(0.1);
  const wave = s.peds.spawned.length - before;
  check('the boss still escalates: phase counter advanced',
    M.bossPhase === 1, `bossPhase ${M.bossPhase}`);
  check('the escalation still spawns its authored wave',
    wave === B.minions[1], `spawned ${wave}, authored ${B.minions[1]}`);
  check('still running after a phase change',
    s.missions.running === true && M.phase === 'run',
    `running ${s.missions.running}, phase ${JSON.stringify(M.phase)}`);

  // ---- K, twice: the chapter ends through the FAIL RESULT CARD ------------
  const game = Object.create(GameSystem.prototype);
  game.missions = s.missions;
  game.wq = s.wq;
  game.ctx = s.ctx;
  game._abortArmedRaw = 0;
  game._abortArmedSeq = -1;

  const first = game._abortRequest(false);
  check('K once does NOT abandon the chapter',
    first === false && s.missions.active === true,
    `returned ${first}, active ${s.missions.active}`);
  check('K once asks the question on screen',
    /abandon/i.test(s.ui.lastToast()?.text ?? ''), s.ui.lastToast()?.text ?? 'no toast');

  s.ctx.time.raw += 1.0;                       // inside ABORT_CONFIRM
  const second = game._abortRequest(false);
  check('K again inside the window abandons it',
    second === true && s.missions.active === false,
    `returned ${second}, active ${s.missions.active}`);
  const card = s.ui.cards[s.ui.cards.length - 1];
  check('and the screen says what happened (FAILED card, with the reason)',
    card?.kind === 'failed' && /walked away/i.test(card?.sub ?? ''),
    card ? `${card.kind} · "${card.sub}"` : 'no card');
  check('the fail event went out too',
    s.events.log.some((e) => e.k === 'mission:fail' && /walked away/i.test(e.reason ?? '')),
    s.events.log.filter((e) => e.k.startsWith('mission:')).map((e) => e.k).join(', '));

  // ---- NEGATIVE CONTROL: the same kill with no chapter live --------------
  const dropsBefore = s.hostiles.drops;
  s.hostiles._onKill(minion);
  check('NEG CONTROL: no chapter live -> no kill drop',
    s.hostiles.drops === dropsBefore,
    `drops ${dropsBefore} -> ${s.hostiles.drops}`);
}

/* ========================================================================== */
/* 2 — K's confirmation window: expiry, Shift, and a fresh chapter           */
/* ========================================================================== */

{
  const s = scene();
  const boy = BOYZ.carson;
  s.missions.start(boy, boy.story.findIndex((c) => c.track === 'boss'));
  s.missions.forceBegin();

  const game = Object.create(GameSystem.prototype);
  game.missions = s.missions;
  game.wq = s.wq;
  game.ctx = s.ctx;
  game._abortArmedRaw = 0;
  game._abortArmedSeq = -1;

  game._abortRequest(false);
  s.ctx.time.raw += 30;                        // far past ABORT_CONFIRM
  const stale = game._abortRequest(false);
  check('a stale question does not answer itself — K re-arms instead',
    stale === false && s.missions.active === true,
    `returned ${stale}, active ${s.missions.active}`);

  // Shift+K is the door for anyone who knows what the key does.
  const forced = game._abortRequest(true);
  check('Shift+K abandons on one press',
    forced === true && s.missions.active === false,
    `returned ${forced}, active ${s.missions.active}`);
}

{
  // An arm made about chapter A must not answer for chapter B — the WASTED
  // restart hands the player a new chapter inside the same four seconds.
  const s = scene();
  const boy = BOYZ.carson;
  const idx = boy.story.findIndex((c) => c.track === 'boss');
  s.missions.start(boy, idx);
  s.missions.forceBegin();

  const game = Object.create(GameSystem.prototype);
  game.missions = s.missions;
  game.wq = s.wq;
  game.ctx = s.ctx;
  game._abortArmedRaw = 0;
  game._abortArmedSeq = -1;

  game._abortRequest(false);                   // armed on chapter A
  s.missions.abort();
  s.missions.start(boy, idx);                  // ...and A is gone
  s.missions.forceBegin();
  s.ctx.time.raw += 0.4;
  const carried = game._abortRequest(false);
  check('an arm cannot carry over to the NEXT chapter',
    carried === false && s.missions.active === true,
    `returned ${carried}, active ${s.missions.active}`);
}

/* ========================================================================== */
/* 3 — the runner's guard, against tracks that reach for `phase`             */
/* ========================================================================== */

TRACKS.probeClobberInit = {
  init(M) { M.phase = 0; },                    // the exact pre-fix boss shape
  update(M) { M.probeTicks = (M.probeTicks ?? 0) + 1; },
};
TRACKS.probeClobberUpdate = {
  init(M) { M.probeTicks = 0; },
  update(M) { M.phase = 7; M.probeTicks++; },
};
TRACKS.probeWellBehaved = {
  init(M) { M.probeTicks = 0; },
  update(M) { M.probeTicks++; },
};

const fakeChapter = (track) => ({
  no: 'CH ?', name: 'Probe', zone: 'NOWHERE', track, cash: 0, respect: 0,
});

function runFake(track, frames = 3) {
  const s = scene();
  const errs = withErrors(() => {
    s.missions.startCustom(BOYZ.carson, fakeChapter(track), `probe:${track}`);
    s.missions.forceBegin();
    for (let i = 0; i < frames; i++) s.missions.update(0.2);
  });
  return { s, errs, M: s.missions.M };
}

{
  const { s, errs, M } = runFake('probeClobberInit');
  check('GUARD: a track that clobbers phase in init is caught',
    errs.some((e) => /overwrote M\.phase/.test(e)), errs[0] ?? 'nothing logged');
  check('GUARD: ...and the lifecycle field is restored, so `running` survives',
    s.missions.running === true && M.phase === 'run',
    `running ${s.missions.running}, phase ${JSON.stringify(M.phase)}`);
  check('GUARD: ...and the track still ran its own update',
    M.probeTicks > 0, `ticks ${M.probeTicks}`);
}

{
  const { s, errs, M } = runFake('probeClobberUpdate');
  check('GUARD: a track that clobbers phase in update is caught',
    errs.some((e) => /overwrote M\.phase/.test(e)), errs[0] ?? 'nothing logged');
  check('GUARD: ...it says so ONCE, not once a frame',
    errs.filter((e) => /overwrote M\.phase/.test(e)).length === 1,
    `${errs.length} lines`);
  // Repaired inside the SAME frame, before `game._update` hands that frame to
  // `freeroam` / `hostiles` / the heat — a repair on the next frame would still
  // be a whole frame of free-roam behaviour in a boss fight.
  check('GUARD: ...and `running` is true at the end of the frame',
    s.missions.running === true && M.phase === 'run',
    `running ${s.missions.running}, phase ${JSON.stringify(M.phase)}`);
}

{
  const { errs, M } = runFake('probeWellBehaved');
  check('NEG CONTROL: a well-behaved track trips no guard',
    errs.length === 0, errs[0] ?? 'clean');
  check('NEG CONTROL: ...and is left entirely alone',
    M.phase === 'run' && M.probeTicks === 3, `phase ${M.phase}, ticks ${M.probeTicks}`);
}

/* ========================================================================== */
/* 4 — the brother switch: all three doors refuse a live chapter             */
/* ========================================================================== */

/** A `Characters` wired to a mission runner stub in a named state. */
function switcher(missions) {
  const s = scene();
  const characters = new Characters(s.ctx, {
    wq: s.wq,
    economy: s.economy,
    heat: s.heat,
    director: {
      spawnFor: (id) => ({ x: 10, z: 10, yaw: 0, y: 0, line: `doing something as ${id}` }),
      carFor: () => 'sedan',
      activityFor: () => ({ line: 'about' }),
      armUnstick() {},
    },
    save: s.save,
    missions,
  }).init();
  return { s, characters };
}

const LIVE_RUN = { active: true, running: true, M: { side: false } };
const LIVE_INTRO = { active: true, running: false, M: { side: false } };   // the bypass
const SIDE_JOB = { active: true, running: true, M: { side: true } };
const FREE_ROAM = { active: false, running: false, M: null };

{
  const { s, characters } = switcher(FREE_ROAM);
  const ok = characters.switchTo('aidan');
  check('CONTROL: in free roam the switch still works',
    ok === true && characters.activeId === 'aidan' && s.wq.player.brother === 'aidan',
    `returned ${ok}, active ${characters.activeId}, body ${s.wq.player.brother}`);
}

{
  const { s, characters } = switcher(LIVE_RUN);
  const ok = characters.switchTo('aidan');
  check('door 1 — switchTo refuses during a live chapter',
    ok === false && characters.activeId === 'carson' && s.wq.player.brother === null,
    `returned ${ok}, active ${characters.activeId}, body ${s.wq.player.brother}`);
  check('...and says why', s.ui.lastToast()?.text === 'Not during a job',
    s.ui.lastToast()?.text ?? 'no toast');
}

{
  const { s, characters } = switcher(LIVE_RUN);
  const ok = characters.cycle(1);
  check('door 2 — the U key (cycle) refuses too',
    ok === false && characters.activeId === 'carson',
    `returned ${ok}, active ${characters.activeId}`);
  check('...and says why', s.ui.lastToast()?.text === 'Not during a job',
    s.ui.lastToast()?.text ?? 'no toast');
}

{
  const { s, characters } = switcher(LIVE_RUN);
  const target = BOY_ORDER.find((id) => id !== characters.activeId);
  // The wheel COMMITS FIRST: `ui._closeCharWheel` paints the picked brother's
  // accent and loadout on, and only then emits the event. Model that, because
  // the refusal has to undo it.
  s.ui.setCharacter(target);
  s.events.emit('ui:character', { id: target });
  check('door 3 — the X wheel (ui:character) refuses too',
    characters.activeId === 'carson', `active ${characters.activeId}`);
  check('...and says why', s.ui.lastToast()?.text === 'Not during a job',
    s.ui.lastToast()?.text ?? 'no toast');
  check('...and the HUD is put back on the brother actually on screen',
    s.ui.character === 'carson', `HUD wearing ${s.ui.character}`);
}

{
  // The bypass that `missions.running` could never have covered: the intro
  // cutscene and the travel leg are part of the job.
  const { characters } = switcher(LIVE_INTRO);
  const ok = characters.switchTo('aidan');
  check('an intro / travel leg counts as a live chapter (running is false there)',
    ok === false && characters.activeId === 'carson', `returned ${ok}, active ${characters.activeId}`);
}

{
  const { characters } = switcher(SIDE_JOB);
  const ok = characters.switchTo('aidan');
  check('a SIDE job does not lock the brothers',
    ok === true && characters.activeId === 'aidan', `returned ${ok}, active ${characters.activeId}`);
}

{
  // `GameSystem.switchTo` now delegates; it must still refuse, and still
  // report the refusal to callers like the cheat panel.
  const { characters } = switcher(LIVE_RUN);
  const game = Object.create(GameSystem.prototype);
  game.characters = characters;
  const ok = game.switchTo('aidan');
  check('game.switchTo still reports the refusal to its callers',
    ok === false && characters.activeId === 'carson', `returned ${ok}, active ${characters.activeId}`);
}

/* -------------------------------------------------------------------------- */

console.log('\n=== boss phase / chapter ownership ===\n');
const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
}
console.log(`\nbossphase: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
