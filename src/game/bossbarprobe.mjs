#!/usr/bin/env node
/**
 * BOSS BAR / FLANK PROBE — the two things a boss fight was advertising and not
 * doing.
 *
 *   node src/game/bossbarprobe.mjs
 *   node src/game/bossbarprobe.mjs --verbose
 *
 * ---------------------------------------------------------------------------
 * WHAT WAS BROKEN
 * ---------------------------------------------------------------------------
 *  1. NO HEALTH BAR. All four fights ran with the boss's health drawn only as
 *     the objective panel's progress slot, fed `1 - hpFrac` — a meter that
 *     FILLED UP as the boss went down, in a panel whose single text line was
 *     simultaneously the attack telegraph. During the moment that decides the
 *     fight the panel read "SLAM — MOVE" and the bar read fuller than it had
 *     a second earlier.
 *
 *  2. THE FLANK DID NOT EXIST. Every boss's `weak` string tells the player
 *     where to stand — "Armour plate is bolted to his chest — hit him from
 *     behind", "Front is plated — wreck the rear wheels" — and nothing in the
 *     engine read it. Damage from every bearing was identical, so the only
 *     coaching the game gives during its finale was false, and the optimal
 *     play was to stand still and hold the trigger.
 *
 * ---------------------------------------------------------------------------
 * RULE 12 — WHAT THIS MEASURES
 * ---------------------------------------------------------------------------
 * Nothing here calls `_takeFor`, reads `FRONT_TAKE`, or asks the code what
 * multiplier it thinks it applied. Both quantities are emitted artefacts:
 *
 *   the flank   THE BOSS'S OWN HEALTH, before and after. The probe subtracts a
 *               fixed number of points itself — the same field `hurtHostile`
 *               and `vehicles.damage()` write — steps the REAL `bossTrack`,
 *               and reads what is left. Every assertion is a RATIO of two such
 *               readings taken at two bearings, so a build that scaled all
 *               damage, or none, cannot pass.
 *
 *   the bar     the `mission:boss` records that actually went out on the bus,
 *               captured by an independent subscriber. The health in them is
 *               cross-checked against the health the probe measured on the
 *               entity, so a bar wired to a constant, to the kill counter, or
 *               to `1 - hpFrac` (the defect) all fail differently.
 *
 * The DRAWN width of the bar is not measurable in node and is not measured
 * here: `src/ui/wardprobe.mjs` section 4 does it in a real browser, on laid-out
 * CSS pixels, by sweeping every element under the HUD root without knowing
 * which one is supposed to be the bar.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROLS
 * ---------------------------------------------------------------------------
 * Green is 20/20. Two reverts, applied for real and MEASURED, plus two
 * controls that run inside every green pass:
 *
 *   boss.js  `_flank` body replaced by `M.bossHp = now`   -> 15/20,
 *            and the summary line reads 1.000x instead of 2.222x
 *   boss.js  the panel meter put back (`1 - hpFrac`, no
 *            `publish`) — THE DEFECT                      -> 14/20, with the
 *            panel caught at `progress 0.88` on a boss at 12% health
 *
 *   - REAR vs REAR, in-pass. The same measurement repeated at one bearing must
 *     return 1.000. This is the control on the HARNESS: it proves the rig is
 *     not manufacturing a difference out of frame timing or ordering, which is
 *     the only way the front/rear number could be an artefact.
 *   - NO CHAPTER LIVE, in-pass. After the chapter ends the bus must stop
 *     carrying `active: true`, so "the bar is published" cannot be a sentence
 *     that is true of every build.
 */

import * as THREE from 'three';
import { MissionRunner } from './mission.js';
import { GameSystem } from './index.js';
import { HostilePool } from './hostiles.js';
import { BOYZ, BOSSES } from './data.js';
import { blankSave } from './save.js';

const VERBOSE = process.argv.includes('--verbose');

let pass = 0, fail = 0;
const rows = [];
const check = (name, ok, detail) => {
  ok ? pass++ : fail++;
  rows.push({ ok: !!ok, name, detail: String(detail ?? '') });
};

/* -------------------------------------------------------------------------- */
/* harness                                                                    */
/* -------------------------------------------------------------------------- */

/** Deterministic stand-in for `ctx.rng` — no `Math.random` anywhere (rule 4). */
function rng() {
  let n = 1;
  return {
    fork: () => rng(),
    float: () => 0,
    range: (a, b) => (a + b) / 2,
    int: (a, b) => a + ((n++) % Math.max(1, b - a + 1)),
    u32: () => (n = (n * 1664525 + 1013904223) >>> 0),
    signed: () => 0,
  };
}

function bus() {
  const map = new Map();
  return {
    log: [],
    on(k, fn) {
      (map.get(k) ?? map.set(k, new Set()).get(k)).add(fn);
      return () => map.get(k)?.delete(fn);
    },
    off(k, fn) { map.get(k)?.delete(fn); },
    emit(k, p) {
      this.log.push(k);
      for (const fn of [...(map.get(k) ?? [])]) fn(p);
    },
  };
}

function fakeUi() {
  return {
    toasts: [], cards: [],
    notify(text, value, tone) { this.toasts.push({ text, value, tone }); },
    card(kind, sub) { this.cards.push({ kind, sub }); },
    say() {}, setCharacter() {}, setMoney() {}, setStation() {}, setWaypoint() {},
    setObjectives() {}, clearObjective() {}, titleCard() {},
  };
}

/**
 * A `WorldQuery` stand-in on flat dry ground.
 *
 * `pos` is writable and IS the player: the runner copies it into `px`/`pz`
 * through `focusPos()` every update, which is the path the bearing is read
 * down in play. Moving the player is therefore how this probe flanks.
 */
function fakeWq(ui, veh = null) {
  const player = {
    brother: null, dead: false, inVehicle: false,
    health: { value: 100, max: 100, armour: 0 },
    setBrother(id) { this.brother = id; },
    addTrauma() {}, applyDamage() {},
  };
  return {
    ui, player,
    audio: { setRadioRotation() {}, setRadioStation() {} },
    pos: { x: 0, y: 0, z: 0 },
    poi: () => null,
    uiSfx() {}, sfx() {},
    groundY: () => 0,
    surfaceY: () => 0,
    focusPos() { return this.pos; },
    playerPos() { return this.pos; },
    playerVehicle: () => null,
    placePlayer(x, z, yaw, y = 0) { this.pos = { x, y, z }; this.yaw = yaw; return true; },
    findGroundSpot(min, max, cx = 0, cz = 0) { return { x: cx + min, z: cz, y: 0, yaw: 0, ok: true }; },
    findRoadSpot(min, max, cx = 0, cz = 0) { return { x: cx + min, z: cz, y: 0, yaw: 0, ok: true }; },
    curbSpot(x, z) { return { x: x + 4, z, yaw: 0 }; },
    nearestShop: () => null,
    spawnVehicle: () => veh,
    despawnVehicle() {},
    damageVehicle() {},
    vehicles: null,
    weapons: null,
  };
}

/** `peds`, as the runner and `HostilePool` need it. A hostile carries a yaw. */
function fakePeds() {
  return {
    spawned: [],
    hostiles: { onKill: null, live: [], aliveCount: 0 },
    spawnHostile(v, opts) {
      const h = {
        position: { x: v.x, y: v.y, z: v.z },
        yaw: 0,
        health: opts?.hp ?? 100,
        maxHealth: opts?.hp ?? 100,
        dead: false, active: true, opts,
      };
      this.spawned.push(h);
      return h;
    },
    despawnHostile(h) { if (h) h.active = false; },
    clearHostiles() { for (const h of this.spawned) h.active = false; },
    hurtHostile: () => false,
  };
}

/** A `Vehicle` handle with the ONE property `yawOf` reads: a real quaternion. */
function fakeVehicle(x, z, yaw) {
  const v = {
    position: new THREE.Vector3(x, 0, z),
    quaternion: new THREE.Quaternion(),
    health: 1, maxHealth: 1, destroyed: false, forwardSpeed: 0,
  };
  v.quaternion.setFromEuler(new THREE.Euler(0, yaw, 0, 'YXZ'));
  return v;
}

function fakePickups() {
  return { spawned: [], spawn(x, z, k, o) { const p = { x, z, k, o }; this.spawned.push(p); return p; }, despawn() {}, clearMission() {} };
}

function scene({ veh = null } = {}) {
  const save = blankSave();
  const ui = fakeUi();
  const wq = fakeWq(ui, veh);
  const events = bus();
  const peds = fakePeds();
  const pickups = fakePickups();
  const time = { raw: 0, elapsed: 0, dt: 1 / 60, scale: 1, frame: 0 };
  const bag = { peds };
  const ctx = {
    rng: rng(), events, time,
    peek: (i) => bag[i] ?? null, get: (i) => bag[i] ?? null, has: (i) => i in bag,
  };
  const economy = {
    cash: save.chars.carson.cash, respect: save.chars.carson.respect,
    char: (who = 'carson') => save.chars[who],
    addCash() {}, addRespect: () => [], unlockWeapon: () => false,
  };
  const heat = { wanted: 0, raise() {}, clear() {}, heat() {} };
  const hostiles = new HostilePool(ctx, wq).init();
  const missions = new MissionRunner(ctx, { wq, economy, heat, hostiles, pickups, save });
  bag.game = { missions, pickups };

  // An independent record of what the bus actually carried. Nothing in `ui`
  // and nothing in `boss.js` can write to this.
  const boss = [];
  events.on('mission:boss', (p) => boss.push({
    id: p.id, name: p.name, weak: p.weak, phase: p.phase,
    phases: p.phases, health: p.health, active: p.active,
  }));

  return { save, ui, wq, events, peds, pickups, ctx, missions, hostiles, boss, time };
}

/** Start a boss chapter and walk it into the run phase. */
function startBoss(s, boyId = 'carson') {
  const boy = BOYZ[boyId];
  const idx = boy.story.findIndex((c) => c.track === 'boss');
  s.missions.start(boy, idx);
  for (let i = 0; i < 8 && s.missions.M.phase === 'intro'; i++) s.missions.update(1);
  return { boy, idx, B: BOSSES[boy.story[idx].bossId] };
}

/** Stand the player `d` metres off the boss at `a` radians from his nose. */
function standAt(s, bx, bz, facing, a, d = 6) {
  s.wq.pos = { x: bx + Math.sin(facing + a) * d, y: 0, z: bz + Math.cos(facing + a) * d };
}

/**
 * Take `points` off him from bearing `a`, and return what he ACTUALLY lost.
 *
 * The subtraction is the probe's, in the same field the four real damage paths
 * write. The reading afterwards is the entity's own health. Nothing in between
 * is consulted.
 */
function hitFrom(s, ent, a, points, facing = 0) {
  ent.yaw = facing;
  standAt(s, ent.position.x, ent.position.z, facing, a);
  s.missions.update(1 / 60);              // let the bearing settle into px/pz
  const before = ent.health;
  ent.health -= points;
  s.missions.update(1 / 60);
  return before - ent.health;
}

/* ========================================================================== */
/* 1 — the bearing is priced, and it is priced on his health                 */
/* ========================================================================== */

const POINTS = 60;
let frontTake = 0, rearTake = 0;

{
  const s = scene();
  const { B } = startBoss(s);
  const ent = s.missions.M.bossEnt;
  check('a brute boss fight is live with a hostile on his feet',
    !!ent && s.missions.running === true && ent.maxHealth === B.hp,
    `${B.name}, ${ent?.health}/${ent?.maxHealth} hp, running ${s.missions.running}`);

  // Dead ahead, over the shoulder, and straight up his back.
  frontTake = hitFrom(s, ent, 0, POINTS) / POINTS;
  const sideTake = hitFrom(s, ent, Math.PI / 2, POINTS) / POINTS;
  rearTake = hitFrom(s, ent, Math.PI, POINTS) / POINTS;

  check('THE DEFECT: the same damage is worth MORE from behind than in front',
    rearTake > frontTake * 1.5,
    `front ${frontTake.toFixed(3)}, flank ${sideTake.toFixed(3)}, rear ${rearTake.toFixed(3)} ` +
    `of ${POINTS} points — rear/front ${(rearTake / frontTake).toFixed(3)}x`);

  check('the shoulder is between the two, not a cliff edge',
    sideTake > frontTake + 0.02 && sideTake < rearTake - 0.02,
    `front ${frontTake.toFixed(3)} < flank ${sideTake.toFixed(3)} < rear ${rearTake.toFixed(3)}`);

  check('a hit from behind is not attenuated at all',
    Math.abs(rearTake - 1) < 0.02, `rear take ${rearTake.toFixed(4)}`);

  check('and the front is reduced, not immune',
    frontTake > 0.2 && frontTake < 0.75, `front take ${frontTake.toFixed(4)}`);

  // NEGATIVE CONTROL on the HARNESS: the same bearing twice must be flat.
  const rearA = hitFrom(s, ent, Math.PI, POINTS) / POINTS;
  const rearB = hitFrom(s, ent, Math.PI, POINTS) / POINTS;
  check('NEG CONTROL: the same bearing twice measures 1.000x (the rig is not inventing a delta)',
    Math.abs(rearA / rearB - 1) < 0.01, `${rearA.toFixed(4)} vs ${rearB.toFixed(4)}`);

  // A HEAL must not be priced — a boss topped up would otherwise be robbed.
  ent.health = Math.min(ent.maxHealth, ent.health + 100);
  const healed = ent.health;
  s.missions.update(1 / 60);
  check('healing him is not run through the flank term',
    Math.abs(ent.health - healed) < 0.001, `${healed.toFixed(1)} -> ${ent.health.toFixed(1)}`);
}

/* ========================================================================== */
/* 2 — the fight is still winnable head-on, just slower                      */
/* ========================================================================== */

{
  /** Grind him down at a fixed rate from one bearing; return seconds taken. */
  const timeToKill = (a) => {
    const s = scene();
    startBoss(s);
    const ent = s.missions.M.bossEnt;
    ent.yaw = 0;
    standAt(s, ent.position.x, ent.position.z, 0, a);
    const DPS = 200;
    const STEP = 1 / 30;
    let t = 0;
    while (ent.health > 0 && t < 300) {
      ent.health -= DPS * STEP;
      s.missions.update(STEP);
      // The runner nulls the handle at cleanup; the fight is over either way.
      if (!s.missions.M?.bossEnt) break;
      t += STEP;
    }
    return { t, left: ent.health };
  };

  const front = timeToKill(0);
  const rear = timeToKill(Math.PI);
  check('a purely FRONTAL fight still kills him',
    front.left <= 0 && front.t < 120,
    `${front.t.toFixed(1)} s at 200 dps, ${front.left.toFixed(1)} hp left`);
  check('and going round the back is meaningfully faster',
    rear.t < front.t * 0.7 && rear.left <= 0,
    `front ${front.t.toFixed(1)} s vs rear ${rear.t.toFixed(1)} s — ` +
    `${(front.t / rear.t).toFixed(2)}x longer head-on`);
  // A fight that took twenty times as long from the front would be a wall
  // dressed as a mechanic; this is the upper bound on the tuning.
  check('the frontal penalty is a cost, not a wall',
    front.t / rear.t < 4, `${(front.t / rear.t).toFixed(2)}x`);
  if (VERBOSE) console.log(`   ttk front ${front.t.toFixed(2)} s · rear ${rear.t.toFixed(2)} s`);
}

/* ========================================================================== */
/* 3 — the driver boss is priced off HER CAR's heading                       */
/* ========================================================================== */

{
  const veh = fakeVehicle(0, 0, 0);
  const s = scene({ veh });
  const boy = BOYZ.dylan;
  const idx = boy.story.findIndex((c) => c.track === 'boss');
  s.missions.start(boy, idx);
  for (let i = 0; i < 8 && s.missions.M.phase === 'intro'; i++) s.missions.update(1);
  const M = s.missions.M;
  const B = BOSSES[boy.story[idx].bossId];

  check('the driver boss is live in her car',
    !!M?.bossVeh && M.bossVeh.maxHealth === B.hp,
    `${B.name}, ${M?.bossVeh?.health}/${M?.bossVeh?.maxHealth}`);

  if (M?.bossVeh) {
    const v = M.bossVeh;
    const hitVeh = (a) => {
      s.wq.pos = { x: v.position.x + Math.sin(a) * 8, y: 0, z: v.position.z + Math.cos(a) * 8 };
      s.missions.update(1 / 60);
      const before = v.health;
      v.health -= POINTS;
      s.missions.update(1 / 60);
      return (before - v.health) / POINTS;
    };
    const nose = hitVeh(0);
    const tail = hitVeh(Math.PI);
    check('"front is plated — wreck the rear wheels" is true of the car too',
      tail > nose * 1.5, `nose ${nose.toFixed(3)}, tail ${tail.toFixed(3)} — ${(tail / nose).toFixed(2)}x`);
  }
}

/* ========================================================================== */
/* 4 — the bar is published, and it is his health                            */
/* ========================================================================== */

{
  const s = scene();
  const { B } = startBoss(s);
  const ent = s.missions.M.bossEnt;
  s.boss.length = 0;
  standAt(s, ent.position.x, ent.position.z, 0, Math.PI);   // full price, clean maths
  s.missions.update(1 / 60);

  const first = s.boss.at(-1);
  check('a boss fight publishes a boss record',
    !!first && first.active === true,
    first ? `${first.name} · phase ${first.phase + 1}/${first.phases} · ${(first.health * 100).toFixed(0)}%` : 'nothing on mission:boss');
  check('it carries his name, his phase count and the weak point the fight coaches',
    first?.name === B.name && first?.phases === B.phases && first?.weak === B.weak,
    `name "${first?.name}", phases ${first?.phases}, weak "${first?.weak}"`);

  /**
   * Four levels on the way down, and the published health must be HIS.
   *
   * A MISSING record is scored, never thrown on. The whole point of the
   * reverted arm is a build that publishes nothing, and a probe that dies with
   * a TypeError on its own negative control reports "the harness broke" where
   * it should report "the feature is absent".
   */
  const levels = [];
  for (const frac of [0.8, 0.55, 0.3, 0.12]) {
    ent.health = ent.maxHealth * frac;
    s.missions.update(1 / 60);
    const r = s.boss.at(-1) ?? null;
    levels.push({ want: ent.health / ent.maxHealth, got: r ? r.health : null, phase: r ? r.phase : null });
  }
  const drawn = levels.filter((l) => Number.isFinite(l.got));
  check('the published health tracks the health he actually has',
    drawn.length === levels.length && levels.every((l) => Math.abs(l.got - l.want) < 0.005),
    drawn.length !== levels.length
      ? `only ${drawn.length}/${levels.length} levels published anything at all`
      : levels.map((l) => `${(l.want * 100).toFixed(0)}%->${(l.got * 100).toFixed(0)}%`).join(' '));
  check('...and it goes DOWN as he does (the panel bar it replaces went up)',
    drawn.length === levels.length && levels.every((l, i) => i === 0 || l.got < levels[i - 1].got),
    levels.map((l) => (l.got === null ? '—' : l.got.toFixed(3))).join(' > '));
  check('the phase in the record escalates with the damage',
    Number.isFinite(levels.at(-1).phase) && levels.at(-1).phase > levels[0].phase,
    `phase ${levels[0].phase} -> ${levels.at(-1).phase} of ${B.phases}`);

  // The objective panel must no longer be drawing the inverted bar.
  const obj = s.missions.hudObjective();
  check('THE DEFECT: the objective panel no longer draws an inverted health bar',
    obj && obj.progress === -1,
    `progress ${obj?.progress}, eyebrow "${obj?.eyebrow}", text "${obj?.text}"`);

  // ...and it dies with the fight.
  s.boss.length = 0;
  ent.health = 0;
  ent.dead = true;
  s.missions.update(1 / 60);
  const down = s.boss.at(-1) ?? null;
  check('when he drops, the bar is published empty and then switched off',
    !!down && down.active === false && down.health === 0,
    down ? `active ${down.active}, health ${down.health}` : 'no final record');

  // NEGATIVE CONTROL: nothing live, nothing published.
  s.missions.abort();
  s.boss.length = 0;
  s.missions.update(1 / 60);
  check('NEG CONTROL: no chapter live -> nothing claims to be a boss',
    s.boss.every((r) => r.active !== true),
    `${s.boss.length} record(s) after abort`);
}

/* ========================================================================== */

for (const r of rows) {
  console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
  if (!r.ok || VERBOSE) console.log(`       ${r.detail}`);
}
console.log(`\nboss bar + flank: ${pass}/${pass + fail}` +
  `   (rear/front damage ${(rearTake / Math.max(1e-6, frontTake)).toFixed(3)}x)`);
process.exit(fail ? 1 : 0);
