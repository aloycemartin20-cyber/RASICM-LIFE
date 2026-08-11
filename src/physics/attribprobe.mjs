#!/usr/bin/env node
/**
 * ATTRIBUTION PROBE — a `damage:dealt` raised by a round NAMES the shooter.
 *
 *   node src/physics/attribprobe.mjs          # npm run attrib
 *   node src/physics/attribprobe.mjs --quiet
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS FOR
 * ---------------------------------------------------------------------------
 * `ui._isPlayerSource` and `audio._isPlayerSource` both answer "did the PLAYER
 * deal this?" with `if (s == null) return true` — an ABSENT `source` means the
 * player. That was true by accident of population: `physics.emitImpact` was the
 * only emitter in the tree that left the field unset, it is reachable only from
 * `physics.fireBullet`, and `fireBullet` had exactly two callers, both the
 * player's (`weapons/ballistics.js`, `weapons/melee.js`).
 *
 * It is one caller away from being false. The moment an AI shooter traces a
 * round through `fireBullet`, every enemy hit starts drawing the player a
 * centre-screen hitmarker, a damage number and an audible tick — the same
 * defect `src/peds/creditprobe.mjs` exists for, arriving from the other side.
 * `fireBullet` now carries `opts.source` through the penetration solver onto
 * the payload, and this gates that wire.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED (rule 12)
 * ---------------------------------------------------------------------------
 * The REAL `PhysicsSystem` traces REAL rounds against REAL colliders and the
 * assertions read the `damage:dealt` payloads off a REAL event bus. Nothing
 * here inspects `_bulletSource`, `fireBullet`'s arguments or any other
 * intermediate the production code already holds — the artefact is the payload
 * a listener four subsystems away actually receives.
 *
 * What is NOT real, declared: there is no `world`, so there is no terrain and
 * no static BVH. Every ray in this file is horizontal and every hit is on a
 * collider, which is the only path that can raise `damage:dealt` at all.
 *
 * ---------------------------------------------------------------------------
 * NEGATIVE CONTROL
 * ---------------------------------------------------------------------------
 * `phys.debugNoBulletSource` (the authored live hatch, never set in play) puts
 * the attribution back the way it shipped. Every check below is re-run with it
 * on and MUST go red, or the checks are agreeing with something other than the
 * wire under test.
 */
import * as THREE from 'three';
import { PhysicsSystem } from './index.js';
import { LAYER, MASK } from './surfaces.js';
import { Rng } from '../core/rng.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const QUIET = !!args.quiet;

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

/** The smallest bus that satisfies `ctx.events` for this path. */
function makeBus() {
  const map = new Map();
  return {
    log: [],
    on(k, fn) { (map.get(k) ?? map.set(k, new Set()).get(k)).add(fn); },
    off(k, fn) { map.get(k)?.delete(fn); },
    emit(k, p) { for (const fn of map.get(k) ?? []) fn(p); },
  };
}

/**
 * A physics system with a bus and an rng and nothing else. `init()` is skipped
 * deliberately: it wants a scene for the debug view and a `world` for the
 * ground fallback, and this file fires horizontally at colliders, which needs
 * neither.
 */
function makePhysics() {
  const phys = new PhysicsSystem();
  const bus = makeBus();
  const rng = new Rng(0x5ADFACE);
  phys.ctx = { events: bus, peek: () => null, scene: null, rng };
  phys.rng = rng;
  phys.ballistics.rng = rng;
  /** Every `damage:dealt` the run raises, in order. THE artefact. */
  const dealt = [];
  bus.on('damage:dealt', (e) => dealt.push({ target: e.target, source: e.source, has: 'source' in e }));
  return { phys, bus, dealt };
}

/** A man-sized capsule standing `x` metres down +X, owned by `owner`. */
function stand(phys, x, owner, opts = {}) {
  const c = phys.addCollider({
    shape: 'capsule', layer: LAYER.ACTOR, surface: 'flesh',
    owner, radius: 0.34, ...opts,
  });
  c.setSegment(x, 0.4, 0, x, 1.5, 0, 0.34);
  return c;
}

const ORIGIN = new THREE.Vector3(0, 1.1, 0);
const DIR = new THREE.Vector3(1, 0, 0);

/** One round down +X. `penetration` 0 stops it in the first thing it meets. */
function fire(phys, opts = {}) {
  return phys.fireBullet({
    origin: ORIGIN, dir: DIR, maxDist: 60, damage: 30,
    penetration: 0, dropoff: 1, mask: MASK.BULLET, ...opts,
  });
}

/* ------------------------------------------------------------------ */
/* the checks, as a function of the arm                                */
/* ------------------------------------------------------------------ */

/**
 * @param {boolean} live  false = the negative control (attribution disabled)
 * @returns {{name:string, ok:boolean, detail:string}[]}
 */
function runArm(live) {
  const out = [];
  const check = (name, ok, detail) => out.push({ name, ok: !!ok, detail: String(detail) });

  /* ---- 1. the round names its shooter ------------------------------ */
  {
    const { phys, dealt } = makePhysics();
    phys.debugNoBulletSource = !live;
    const cop = { id: 'cop' };
    const goon = { id: 'goon' };
    stand(phys, 6, goon);
    fire(phys, { source: cop });
    check('a round fired by a named shooter arrives attributed to him',
      dealt.length === 1 && dealt[0].source === cop && dealt[0].target === goon,
      `${dealt.length} payload(s), source=${dealt[0]?.source?.id ?? String(dealt[0]?.source)}`);
  }

  /* ---- 2. two shooters in a row do not bleed into each other ------- */
  {
    const { phys, dealt } = makePhysics();
    phys.debugNoBulletSource = !live;
    const a = { id: 'A' };
    const b = { id: 'B' };
    stand(phys, 6, { id: 'goon' });
    fire(phys, { source: a });
    fire(phys, { source: b });
    fire(phys, { source: a });
    check('back-to-back rounds each carry their OWN shooter',
      dealt.length === 3 && dealt[0].source === a && dealt[1].source === b && dealt[2].source === a,
      dealt.map((d) => d.source?.id ?? String(d.source)).join(','));
  }

  /* ---- 3. an unnamed round stays unnamed --------------------------- */
  //
  // The player's own melee sweep still fires without a source, and `ui` and
  // `audio` read that as his. Threading attribution must not invent one.
  {
    const { phys, dealt } = makePhysics();
    phys.debugNoBulletSource = !live;
    stand(phys, 6, { id: 'goon' });
    fire(phys);
    check('an unstamped round leaves the source unnamed (absence still means the player)',
      dealt.length === 1 && dealt[0].source == null,
      `source=${String(dealt[0]?.source)}`);
  }

  /* ---- 4. attribution survives penetration ------------------------- */
  //
  // Two men in a line and a budget that gets through the first: the solver
  // emits from inside its own layer loop, several frames below the caller.
  {
    const { phys, dealt } = makePhysics();
    phys.debugNoBulletSource = !live;
    const cop = { id: 'cop' };
    const near = { id: 'near' };
    const far = { id: 'far' };
    stand(phys, 5, near);
    stand(phys, 9, far);
    fire(phys, { source: cop, penetration: 4 });
    const hits = dealt.filter((d) => d.source === cop);
    check('every layer of a penetrating round is attributed, not just the first',
      dealt.length >= 2 && hits.length === dealt.length &&
      dealt.some((d) => d.target === near) && dealt.some((d) => d.target === far),
      `${hits.length}/${dealt.length} attributed over targets ${dealt.map((d) => d.target?.id).join(',')}`);
  }

  /* ---- 5. a nested shot does not steal the outer round's shooter --- */
  //
  // `hit.collider.onHit` runs INSIDE the trace. A round fired from there —
  // a rigged charge, a retaliation — must not leave its own shooter stamped
  // on the rest of the outer round.
  {
    const { phys, dealt } = makePhysics();
    phys.debugNoBulletSource = !live;
    const cop = { id: 'cop' };
    const trap = { id: 'trap' };
    const near = { id: 'near' };
    const far = { id: 'far' };
    let nested = 0;
    stand(phys, 5, near, {
      onHit: () => {
        if (nested++) return;               // the inner shot must not recurse
        phys.fireBullet({
          origin: new THREE.Vector3(0, 1.1, 8), dir: new THREE.Vector3(0, 0, 1),
          maxDist: 20, damage: 5, penetration: 0, dropoff: 1, mask: MASK.BULLET,
          source: trap,
        });
      },
    });
    stand(phys, 9, far);
    const side = phys.addCollider({ shape: 'capsule', layer: LAYER.ACTOR, surface: 'flesh', owner: { id: 'bystander' }, radius: 0.34 });
    side.setSegment(0, 0.4, 12, 0, 1.5, 12, 0.34);
    fire(phys, { source: cop, penetration: 4 });
    const farHit = dealt.find((d) => d.target === far);
    const trapHit = dealt.find((d) => d.source === trap);
    check('a shot fired from inside the trace cannot re-stamp the outer round',
      !!trapHit && !!farHit && farHit.source === cop,
      `nested=${nested}, far attributed to ${farHit?.source?.id ?? String(farHit?.source)}`);
  }

  /* ---- 6. the stamp does not outlive the trace --------------------- */
  //
  // `weapons/ballistics.js` calls `emitImpact` DIRECTLY for a vehicle hit,
  // outside any `fireBullet`. If the last shooter were still parked on the
  // system, an unrelated later impact would inherit him.
  {
    const { phys, dealt } = makePhysics();
    phys.debugNoBulletSource = !live;
    const cop = { id: 'cop' };
    const goon = { id: 'goon' };
    const c = stand(phys, 6, goon);
    fire(phys, { source: cop });
    phys.emitImpact(1, 1, 0, -1, 0, 0, 1, 0, 0, 0, 12, false, { actor: goon, collider: c, part: null });
    check('a direct emitImpact after the trace inherits nobody',
      dealt.length === 2 && dealt[1].source == null,
      `second payload source=${String(dealt[1]?.source)}`);
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* report                                                              */
/* ------------------------------------------------------------------ */

const fixed = runArm(true);
const control = runArm(false);

let bad = 0;
if (!QUIET) console.log('LIVE — attribution threaded');
for (const r of fixed) {
  if (!r.ok) bad++;
  if (!QUIET || !r.ok) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  [${r.detail}]`);
}

/**
 * The control arm. Two of the six checks assert that a source stays UNNAMED —
 * an unstamped round (3) and a direct `emitImpact` outside any trace (6). Both
 * are true in either arm by construction: they are the guards that stop the
 * other four passing by stamping everything indiscriminately, so they are
 * expected to stay green here and are exempt from the "must go red" set.
 */
const CTL_EXEMPT = new Set([2, 5]);
let ctlFired = 0;
let ctlExpected = 0;
if (!QUIET) console.log('\nCONTROL — debugNoBulletSource (the shipped build)');
for (let i = 0; i < control.length; i++) {
  const r = control[i];
  if (CTL_EXEMPT.has(i)) {
    if (!QUIET) console.log(`  exempt       ${r.name}`);
    continue;
  }
  ctlExpected++;
  if (!r.ok) ctlFired++;
  if (!QUIET) console.log(`  ${r.ok ? 'still green' : 'went RED   '}  ${r.name}`);
}
const ctlOK = ctlFired === ctlExpected;
if (!ctlOK) bad++;
console.log(`\n  ${ctlOK ? 'PASS' : 'FAIL'}  CONTROL: ${ctlFired}/${ctlExpected} attribution checks go red with the wire cut`);

console.log(`\nattribprobe: ${fixed.length - fixed.filter((r) => !r.ok).length}/${fixed.length} live checks` +
  `, control ${ctlFired}/${ctlExpected} red — ${bad === 0 ? 'PASS' : 'FAIL'}`);
process.exit(bad === 0 ? 0 : 1);
