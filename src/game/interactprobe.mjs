#!/usr/bin/env node
/**
 * INTERACTION PROBE — does the contextual-action set actually fire?
 *
 * `tools/playprobe.mjs` asks whether the game responds like a game at all.
 * This one is narrower and deeper: it walks the priority chain in
 * `src/game/freeroam.js` and checks each branch through the real key path and
 * the real DOM prompt.
 *
 * Every check is a state delta observed in a running build. Nothing here calls
 * an interaction handler directly: the point is to prove that standing in the
 * right place and pressing F does the thing, not that a method exists.
 *
 * The `carjack` area is the deep one, and it exists for a report: "when I steal
 * a car that is being driven, the occupant should be pulled out by my
 * character." It stages a car with a body in the seat AND a `traffic` Driver at
 * the wheel, presses F, and reads WHERE THE MAN CAME OUT off the canonical
 * `vehicle:exit` — in the car's own frame, so "through the door" is a number.
 * MEASURED: 1.57 m outboard of a 1.02 m half width and 0.07 m fore and aft,
 * i.e. at the door; the NEGATIVE CONTROL (`player.vehicles.debugLegacyJack`,
 * the pre-fix order and the lost race with `traffic`) puts him 0.00 m off the
 * centre line, inside the car, with the player's own jack carrying no ped at
 * all.
 *
 *   npm run build && node src/game/interactprobe.mjs
 *   node src/game/interactprobe.mjs --keep     leave the browser open on failure
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const KEEP = process.argv.includes('--keep');

const { port, server } = await startServer({});
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

const results = [];
let area = '';
const rec = (name, ok, detail) => results.push({ area, name, ok: !!ok, detail });

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

/** Run a body with `engine`, `game`, `player`, `police`, `veh`, `sky` in scope. */
const run = (body) =>
  page.evaluate(`(() => {
    const engine = window.__ENGINE__;
    const ctx = engine.ctx;
    const game = ctx.peek('game');
    const player = ctx.peek('player');
    const police = ctx.peek('police');
    const veh = ctx.peek('vehicles');
    const sky = ctx.peek('sky');
    ${body}
  })()`);

/** The prompt as the player sees it: the real HUD node, not the model. */
const prompt = () =>
  page.evaluate(() => {
    const root = document.querySelector('.ow-prompt');
    if (!root || getComputedStyle(root).display === 'none') return null;
    return {
      key: root.querySelector('.ow-key')?.textContent ?? '',
      text: root.querySelector('.ow-prompt-txt')?.textContent ?? '',
      sub: root.querySelector('.ow-prompt-sub')?.textContent ?? '',
    };
  });

const tapF = async () => {
  await page.keyboard.down('KeyF');
  await pump(3);
  await page.keyboard.up('KeyF');
  await pump(4);
};

/** Park a spawned car exactly where we want it and hold it still for N frames. */
const settle = async (frames = 20) => {
  for (let i = 0; i < frames; i += 4) {
    await run(`
      const v = game.__probeVeh;
      if (v && game.__probeAt) {
        v.position.set(game.__probeAt.x, v.position.y, game.__probeAt.z);
        v.velocity.set(0, 0, 0);
        v.forwardSpeed = 0; v.speed = 0;
      }
      return true;`);
    await pump(4);
  }
};

try {
  // `?cheats=1` is the seam the teleport area needs — `ui.cheats` is null
  // without it (see the header of `src/ui/cheats.js`). It only builds the menu
  // layer; nothing else in this file changes behaviour under it.
  await page.goto(`http://127.0.0.1:${port}/?cheats=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(120);
  await run(`
    engine.input.enabled = true; engine.input.frozen = false;
    player.setControlEnabled?.(true);
    game.missions.abort();
    game.heat.clear('probe');
    // Tap of the whole contextual chain: what did F resolve to, every time.
    window.__ACTS__ = [];
    const fr = game.freeroam;
    const orig = fr.doAction.bind(fr);
    fr.doAction = () => { const id = fr.act.id; const r = orig(); window.__ACTS__.push(id + '->' + r); return r; };
    return true;`);
  await pump(20);
  // The FIRST synthetic keypress of a session is unreliable in a headless
  // browser — the page has never been interacted with. Burn one against
  // nothing so that every measured press below is a fair test.
  await page.keyboard.down('KeyF');
  await pump(2);
  await page.keyboard.up('KeyF');
  await pump(6);

  /* =================================================================== */
  area = 'safehouse';
  /* =================================================================== */

  const shSetup = await run(`
    const sh = game.safehouses.find((s) => s.id === 'sh_carson');
    game.missions.abort();
    game.wq.placePlayer(sh.x, sh.z, 0);
    player.health.value = 62;           // above the regen cap, so any climb is ours
    player.health.armour = 0;
    game.freeroam._atHome = false;
    game.__w0 = game.writer.writes;
    return { name: sh.name, hp: player.health.value, armour: player.armour,
             maxArmour: player.maxArmour, writes: game.__w0 };`);
  await pump(70);
  const shAfter = await run(`
    return { hp: player.health.value, armour: player.armour,
             writes: game.writer.writes, home: game.freeroam.lastSafehouse };`);
  const shPrompt = await prompt();

  rec('standing in the ring heals HP', shAfter.hp > shSetup.hp + 0.5,
    `${shSetup.hp.toFixed(1)} -> ${shAfter.hp.toFixed(1)} hp`);
  rec('standing in the ring restores armour',
    shSetup.maxArmour > 0 ? shAfter.armour > shSetup.armour + 0.5 : true,
    `${shSetup.armour.toFixed(1)} -> ${shAfter.armour.toFixed(1)} of ${shSetup.maxArmour}`);
  rec('entering autosaves once', shAfter.writes > shSetup.writes,
    `${shSetup.writes} -> ${shAfter.writes} writes`);
  rec('lastSafehouse is recorded', shAfter.home === 'sh_carson', String(shAfter.home));
  rec('prompt offers sleep', /SLEEP/.test(shPrompt?.text ?? ''),
    shPrompt ? `[${shPrompt.key}] ${shPrompt.text} · ${shPrompt.sub}` : 'no prompt');

  const beforeSleep = await run(`
    const sh = game.safehouses.find((s) => s.id === 'sh_carson');
    game.wq.placePlayer(sh.x, sh.z, 0);   // he slides on the bank; re-plant him
    player.health.value = 40;
    window.__ACTS__.length = 0;
    return { hour: sky.hour, hp: player.health.value, writes: game.writer.writes,
             act: game.getAction().id };`);
  await pump(4);
  await tapF();
  await pump(20);
  const afterSleep = await run(`
    return { hour: sky.hour, hp: player.health.value, writes: game.writer.writes,
             acts: window.__ACTS__.slice() };`);
  const slept = ((afterSleep.hour - beforeSleep.hour) + 24) % 24;
  rec('F sleeps the clock forward 8 h', Math.abs(slept - 8) < 0.9,
    `${beforeSleep.hour.toFixed(2)} -> ${afterSleep.hour.toFixed(2)} (+${slept.toFixed(2)} h)` +
    ` · action was "${beforeSleep.act}", F did [${afterSleep.acts.join(', ') || 'nothing'}]`);
  rec('F fully restores', afterSleep.hp >= 99, `${beforeSleep.hp} -> ${afterSleep.hp} hp`);
  rec('F saves', afterSleep.writes > beforeSleep.writes,
    `${beforeSleep.writes} -> ${afterSleep.writes} writes`);

  /* =================================================================== */
  area = 'take a car';
  /* =================================================================== */

  // Somewhere with no shop, pump, safehouse or start line inside 60 m, so the
  // only thing that can claim the prompt is the car.
  // Somewhere with no shop, pump, safehouse or start line inside 60 m AND well
  // off the road graph — on a lane, traffic drives into the measurement and
  // the resolver correctly offers a car that is not the one under test.
  const clear = await run(`
    const w = engine.ctx.peek('world');
    const far = (x, z) => {
      const all = [...game.shops, ...game.gasStations, ...game.safehouses,
                   ...Object.values(game.raceTracks).map((t) => t.points[0])];
      for (const p of all) if (Math.hypot(p.x - x, p.z - z) < 60) return false;
      const e = w?.roads?.nearestEdge?.(x, z, 200);
      if (e && e.edge && e.dist <= 45) return false;
      // Flat, too: surfaceAt reports 'dirt' above a 0.55 slope, and on a
      // hillside the player slides more than a metre in the few frames between
      // being planted and being measured. (No backticks in here: this string
      // is a template literal — ARCHITECTURE.md rule 10.)
      return w?.surfaceAt?.(x, z) === 'grass';
    };
    for (let i = 0; i < 300; i++) {
      const s = game.wq.findGroundSpot(150, 1100, 0, 0);
      if (s.ok && far(s.x, s.z)) { game.__clear = { x: s.x, z: s.z }; return game.__clear; }
    }
    game.__clear = { x: 0, z: 0 };
    return game.__clear;`);

  const take = await run(`
    const c = game.__clear;
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    if (player.inVehicle) player.vehicles.abort(player.movement);
    // Clear the street: a traffic car wandering past would be the thing the
    // resolver offers, and the test would be measuring the wrong vehicle.
    for (const v2 of veh.vehicles.slice()) {
      if (Math.hypot(v2.position.x - c.x, v2.position.z - c.z) < 40) veh.despawn(v2);
    }
    const v = game.wq.spawnVehicle('sedan', c.x, c.z, 0);
    game.__probeVeh = v; game.__probeAt = c;
    return { name: v && v.name, spawned: !!v };`);
  await settle(20);
  // Re-plant him just before reading: on a slope he slides, and the whole
  // point of this check is the DISTANCE at which the offer stands.
  // Build the geometry around the player rather than moving the player into
  // it, and measure it several times over.
  //
  // Two separate sources of noise had to go. Planting a player on uneven ground
  // lets him slide a metre before the read, and — the interesting one —
  // SOMETHING ELSE IN THE BUILD RE-SPAWNS A VEHICLE within a metre or two of
  // the player within a couple of frames, anywhere in the world, including a
  // grass spot 70 m from the nearest road (see the report). So each attempt
  // clears the field, builds the geometry and reads it in the tightest window
  // available; the first attempt where the car under test really is the
  // nearest one is the measurement. If all five are gatecrashed the check
  // fails, which is the right outcome.
  const TAKE_SAMPLE = `
    const p = player.position;
    const t = game.getAction().target;
    game.__offered = t;
    const root = document.querySelector('.ow-prompt');
    return {
      dist: t ? +Math.hypot(t.position.x - p.x, t.position.z - p.z).toFixed(2) : null,
      id: game.getAction().id, short: game.getAction().short,
      name: t ? t.name : null, probe: t === game.__probeVeh,
      text: root && getComputedStyle(root).display !== 'none'
        ? (root.querySelector('.ow-prompt-txt').textContent || '') : '',
    };`;
  let takeState = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    await run(`
      const c = game.__clear;
      if (game.__probeVeh) veh.despawn(game.__probeVeh);
      game.wq.placePlayer(c.x, c.z, Math.PI * 0.5);
      const p = player.position;
      for (const o of veh.vehicles.slice()) {
        if (Math.hypot(o.position.x - p.x, o.position.z - p.z) < 80) veh.despawn(o);
      }
      const v = game.wq.spawnVehicle('sedan', p.x + 4.8, p.z, 0);
      game.__probeVeh = v; game.__probeAt = { x: p.x + 4.8, z: p.z };
      return { name: v && v.name };`);
    await pump(2);
    takeState = await run(TAKE_SAMPLE);
    if (takeState.probe && takeState.id === 'enter') break;
  }
  rec('a car beyond `player`’s own 3.4 m reach is still offered',
    takeState.id === 'enter' && takeState.probe && takeState.dist > 3.4,
    `${takeState.dist} m · ${takeState.text || 'no prompt'}` +
    ` · id "${takeState.id}"${takeState.probe ? '' : ' (a passing car, not the spawned one)'}`);
  rec('the prompt names the car',
    !!takeState.name && takeState.text.includes(String(takeState.name).toUpperCase()),
    `${takeState.name} -> ${takeState.text || '-'}`);
  void take;

  await tapF();
  await pump(170);
  const entered = await run(`
    return { inVehicle: !!player.inVehicle, phase: player.vehicles.phase,
             same: player.vehicles.vehicle === game.__offered,
             acts: window.__ACTS__.slice(-2) };`);
  rec('F takes it', entered.inVehicle && entered.same,
    `${entered.inVehicle ? `in ${entered.same ? 'the offered car' : 'a DIFFERENT car'}` : 'on foot'}` +
    ` (${entered.phase}) · F did [${entered.acts.join(', ')}]`);

  /* =================================================================== */
  area = 'seated exit';
  /* =================================================================== */

  /**
   * "LEAVE THE SKYLARK" is written off the vehicle's NAME and nothing else, so
   * the line reads the same at a kerb and at 210 m over the Allegheny. `game`
   * is the only side that can tell them apart (`wq.surfaceY` and `surfaceAt`
   * are not reachable from `ui`), and it publishes the answer on the prompt
   * payload as `place`. These read that LIVE record while the player is seated.
   *
   * It is also the gate on the sampling. Those world queries are cached against
   * the DOOR POINT'S own movement rather than re-asked every frame, and a
   * vehicle that changes altitude without moving in x or z is precisely the
   * case a naive cache would answer wrongly — so the fall below is measured
   * from a car that has not moved an inch horizontally.
   */
  const kerb = await run(`
    const p = game.freeroam.exitPlace;
    return { id: game.getAction().id, active: p.active, over: p.over,
             drop: +p.drop.toFixed(2), airborne: p.airborne, water: p.water };`);
  rec('seated, the EXIT publishes the landing under the door',
    kerb.id === 'exit' && kerb.active === true && kerb.airborne === false && kerb.drop < 1.2,
    `id "${kerb.id}" · ${kerb.drop} m onto ${kerb.over ?? '-'} · airborne ${kerb.airborne}`);

  await run(`
    const v = player.vehicles.vehicle;
    game.__exitY = v.position.y;
    v.position.y += 210;`);
  await pump(3);
  const high = await run(`
    const p = game.freeroam.exitPlace;
    return { active: p.active, drop: +p.drop.toFixed(1), airborne: p.airborne,
             y: +player.vehicles.vehicle.position.y.toFixed(1) };`);
  rec('210 m over the same patch of ground, it reads as a FALL',
    high.active === true && high.airborne === true && high.drop > 150,
    `${high.drop} m of air under the belly at ${high.y} m · airborne ${high.airborne}`);

  await run(`player.vehicles.vehicle.position.y = game.__exitY;`);
  await pump(3);
  const back = await run(`
    const p = game.freeroam.exitPlace;
    return { drop: +p.drop.toFixed(2), airborne: p.airborne };`);
  rec('...and back on its wheels it is a step again, not a fall',
    back.airborne === false && back.drop < 1.2,
    `${back.drop} m under the belly · airborne ${back.airborne}`);

  // AND WHAT IT COSTS. `surfaceY` is a ground raycast; it used to be run once
  // per frame for every second the player was in any vehicle, alongside
  // `surfaceAt` and `isWater`. Counted on the REAL `WorldQuery` method, over a
  // second of frames, in a parked car — where the honest answer is that the
  // ground has not moved and there is nothing to ask.
  await run(`
    const wq = game.wq;
    const raw = wq.surfaceY.bind(wq);
    let n = 0;
    wq.surfaceY = (x, z, y) => { n++; return raw(x, z, y); };
    game.__surfaceDone = () => { wq.surfaceY = raw; return n; };`);
  await pump(60);
  const cost = await run(`return { n: game.__surfaceDone() };`);
  rec('the landing is SAMPLED, not raycast every frame',
    cost.n <= 20,
    `${cost.n} ground samples across 60 frames parked (one per frame was the cost before)`);

  /* =================================================================== */
  area = 'grand theft auto';
  /* =================================================================== */

  const jack = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    if (game.__offered) game.wq.despawnVehicle(game.__offered);
    game.heat.clear('probe');
    const c = game.__clear;
    for (const v2 of veh.vehicles.slice()) {
      if (Math.hypot(v2.position.x - c.x, v2.position.z - c.z) < 60) veh.despawn(v2);
    }
    const v = game.wq.spawnVehicle('police', c.x, c.z, 0);
    game.__probeVeh = v;
    return { before: game.heat.wanted, owner: game.heat.authoritative ? 'game' : 'police',
             police: !!v && v.type === 'police' };`);
  await settle(20);
  // Clear the field and stand on the cruiser's door, in one evaluate.
  await run(`
    const c = game.__clear, v = game.__probeVeh;
    for (const o of veh.vehicles.slice()) if (o !== v) {
      if (Math.hypot(o.position.x - c.x, o.position.z - c.z) < 60) veh.despawn(o);
    }
    v.position.set(c.x, v.position.y, c.z); v.velocity.set(0, 0, 0);
    game.wq.placePlayer(c.x + 2.6, c.z, Math.PI * 0.5);
    return true;`);
  await pump(2);
  const jackPrompt = await prompt();
  const jackTarget = await run(`
    const t = game.getAction().target;
    return { id: game.getAction().id, cruiser: t === game.__probeVeh };`);
  rec('a cruiser reads as COMMANDEER',
    jackTarget.cruiser && jackTarget.id === 'commandeer' && /COMMANDEER/.test(jackPrompt?.text ?? ''),
    `${jackPrompt?.text ?? 'no prompt'} · id "${jackTarget.id}"`);
  await tapF();
  await pump(160);
  const jacked = await run(`
    return { inVehicle: !!player.inVehicle, wanted: game.heat.wanted,
             policeLevel: police ? police.level : null };`);
  rec('stealing a police car raises the wanted level',
    jacked.inVehicle && jacked.wanted > jack.before,
    `${jack.before}* -> ${jacked.wanted}* (heat owned by ${jack.owner})`);

  /* =================================================================== */
  area = 'carjack';
  /* =================================================================== */

  /**
   * REPORTED, from play: "when I steal a car that is being driven, the
   * occupant should be pulled out by my character."
   *
   * The car is staged with BOTH halves of what "being driven" means in this
   * engine, because they are separate facts: a `traffic` Driver (the AI that
   * steers it) and a `peds` body in the seat (the man you can actually grab —
   * the seating sweep is budgeted, so a car can have the first without the
   * second). Its nose is laid along world +x on purpose: the pre-fix drop
   * point was the literal expression `vehicle.position.x + 1.4`, so with the
   * car parked this way that offset runs 1.4 m down its own centre line and
   * the control below can be read as "is he still in the car".
   *
   * WHAT IS MEASURED: the ped's position AT THE MOMENT OF THE PULL, taken off
   * the `vehicle:jack` event rather than sampled later — he runs, so a reading
   * taken two seconds after the fact would score the flee, not the pull.
   */
  await run(`
    window.__JACK__ = null;
    window.__CRIMES__ = [];
    if (police && !police.__crimeTap) {
      const raw = police.reportCrime.bind(police);
      police.reportCrime = (kind, at, sev) => {
        window.__CRIMES__.push(kind);
        return raw(kind, at, sev);
      };
      police.__crimeTap = true;
    }
    window.__EJECT__ = null;
    ctx.events.on('vehicle:exit', (e) => {
      if (!e || e.actor !== game.__jackPed) return;
      const v = e.vehicle;
      const q = v.quaternion;
      window.__EJECT__ = {
        px: e.actor.position.x, py: e.actor.position.y, pz: e.actor.position.z,
        vx: v.position.x, vz: v.position.z,
        heading: Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)),
        hx: v.spec && v.spec.half ? v.spec.half.x : 1, hz: v.spec && v.spec.half ? v.spec.half.z : 2.3,
      };
    });
    ctx.events.on('vehicle:jack', (e) => {
      const p = e.ped;
      const v = e.vehicle;
      const q = v.quaternion;
      window.__JACK__ = {
        hasPed: !!p, active: p ? p.active !== false : false,
        state: p ? String(p.state) : '', inCar: p ? !!p.vehicle : false,
        px: p ? p.position.x : 0, py: p ? p.position.y : 0, pz: p ? p.position.z : 0,
        vx: v.position.x, vz: v.position.z,
        heading: Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x)),
        hx: v.spec && v.spec.half ? v.spec.half.x : 1, hz: v.spec && v.spec.half ? v.spec.half.z : 2.3,
      };
    });
    return true;`);

  /** Park an OCCUPIED, AI-driven sedan on the clear spot and stand at its door. */
  const stageJack = (legacy) => run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    game.heat.clear('probe');
    window.__JACK__ = null;
    window.__EJECT__ = null;
    window.__CRIMES__.length = 0;
    const peds = ctx.peek('peds');
    const traffic = ctx.peek('traffic');
    const c = game.__clear;
    for (const o of veh.vehicles.slice()) {
      if (Math.hypot(o.position.x - c.x, o.position.z - c.z) < 60) veh.despawn(o);
    }
    const v = game.wq.spawnVehicle('sedan', c.x, c.z, Math.PI * 0.5);
    game.__probeVeh = v; game.__probeAt = c;
    // The body in the seat, through the published door traffic itself uses.
    const ped = peds.attachDriver(v, 0, { archetype: 'street' });
    game.__jackPed = ped;
    void traffic;
    player.vehicles.debugLegacyJack = ${legacy ? 'true' : 'false'};
    game.wq.placePlayer(c.x, c.z - 2.9, 0);
    return { ped: !!ped, occupied: !!peds.driverOf(v) };`);

  /**
   * The AI at the wheel goes on LAST, immediately before the key. A `Driver`
   * bound to a car parked seventy metres off its own lane is a lost driver,
   * and `traffic` correctly recycles one — which despawns the car under the
   * test. Binding it a beat before F is pressed leaves the handover path
   * exactly what it is in play and nothing else time to intervene.
   */
  const bindTraffic = () => run(`
    const traffic = ctx.peek('traffic');
    const v = game.__probeVeh;
    const roads = ctx.peek('world') && ctx.peek('world').roads;
    const e = roads && roads.nearestEdge ? roads.nearestEdge(v.position.x, v.position.z) : null;
    let bound = false;
    if (e && e.edge && traffic && traffic.attach) {
      bound = !!traffic.attach(v, e.edge, e.lane || 0, e.t || 0);
    }
    return { bound, driving: !!traffic.driverOf(v) };`);

  const jk = await stageJack(false);
  await settle(12);
  const jkOffer = await run(`
    const v = game.__probeVeh;
    return { id: game.getAction().id, target: game.getAction().target === v,
             pull: player.vehicles.prompt ? player.vehicles.prompt.text : null };`);
  const jkBound = await bindTraffic();
  rec('an occupied car is staged: a body in the seat and an AI at the wheel',
    jk.ped && jk.occupied && jkBound.driving,
    `ped ${jk.ped}, traffic driver ${jkBound.driving}`);
  rec('the player reads it as a PULL OUT, not an ENTER',
    jkOffer.pull === 'PULL OUT' && jkOffer.target,
    `player prompt "${jkOffer.pull}" · contextual action "${jkOffer.id}"`);

  await tapF();
  await pump(12);
  await pump(190);
  const jackRes = await run(`
    const v = game.__probeVeh;
    const peds = ctx.peek('peds');
    const traffic = ctx.peek('traffic');
    const j = window.__JACK__;
    const g = window.__EJECT__;
    let eject = null;
    if (g) {
      const dx = g.px - g.vx, dz = g.pz - g.vz;
      const ch = Math.cos(g.heading), sh = Math.sin(g.heading);
      eject = { x: dx * ch - dz * sh, z: dx * sh + dz * ch, hx: g.hx, hz: g.hz };
    }
    return {
      j, eject,
      seated: game.wq.playerVehicle() === v,
      pedLeft: peds.driverOf(v) === null,
      pedAlive: game.__jackPed ? game.__jackPed.active !== false : false,
      trafficLeft: traffic.driverOf(v) === null,
      aged: !!(traffic._abandoned || []).some((a) => a.v === v),
      crimes: window.__CRIMES__.slice(),
    };`);
  const L = jackRes.eject;
  rec('the PLAYER is the one who hauls him out — his own jack carries the ped',
    !!jackRes.j && jackRes.j.hasPed && jackRes.j.inCar === false && jackRes.j.state !== 'driving',
    jackRes.j ? `ped ${jackRes.j.hasPed}, still in the car ${jackRes.j.inCar}, state ${jackRes.j.state}`
      : 'no vehicle:jack event at all');
  rec('he comes out THROUGH THE DOOR — clear of the flank, beside the car',
    !!L && Math.abs(L.x) > L.hx && Math.abs(L.z) < L.hz,
    L ? `${Math.abs(L.x).toFixed(2)} m outboard of a ${L.hx.toFixed(2)} m half width, ` +
        `${Math.abs(L.z).toFixed(2)} m fore/aft of ${L.hz.toFixed(2)}` : 'never left the car');
  rec('and he is left standing on the road, not despawned mid-pull',
    jackRes.pedAlive && jackRes.j?.active === true && Math.abs(jackRes.j.py) < 400,
    `on his feet ${jackRes.j ? jackRes.j.active : '-'} at the pull, ` +
    `still in the crowd ${jackRes.pedAlive}`);
  rec('the player ends up in the seat the occupant left', jackRes.seated && jackRes.pedLeft,
    `seated ${jackRes.seated}, seat free ${jackRes.pedLeft}`);
  rec('the car is HANDED OVER by traffic, not abandoned to the ageing list',
    jackRes.trafficLeft && jackRes.aged === false,
    `traffic driver ${jackRes.trafficLeft ? 'released' : 'STILL BOUND'}, ` +
    `in the abandoned list ${jackRes.aged}`);
  rec('the carjack is still booked by police (the existing hook)',
    jackRes.crimes.includes('carjack'), `reportCrime saw [${jackRes.crimes.join(', ') || 'nothing'}]`);

  /**
   * THE RESERVATION ITSELF, put directly. `traffic` clearing the seat under the
   * animation is a RACE, and a race lost by 350 ms is not something a sampled
   * assertion can be trusted to catch; this asks the mechanism instead.
   */
  const hold = await run(`
    const peds = ctx.peek('peds');
    const v = game.wq.spawnVehicle('sedan', game.__clear.x + 14, game.__clear.z, 0);
    const ped = peds.attachDriver(v, 0, { archetype: 'street' });
    const mark = { who: 'probe' };
    peds.holdOccupant(v, mark);
    const stranger = peds.pullFromVehicle(v, v.position);
    const stillIn = peds.driverOf(v) === ped;
    peds.releaseOccupant(v, mark);
    const holder = peds.pullFromVehicle(v, v.position);
    const out = peds.driverOf(v) === null;
    game.wq.despawnVehicle(v);
    return { seated: !!ped, stranger: !!stranger, stillIn, holder: !!holder, out };`);
  rec('a reserved occupant cannot be taken by anyone but the holder',
    hold.seated && hold.stranger === false && hold.stillIn === true &&
    hold.holder === true && hold.out === true,
    `while held: pull returned ${hold.stranger ? 'the ped' : 'null'} and he stayed in ` +
    `(${hold.stillIn}); once released: ${hold.holder ? 'pulled' : 'still refused'}`);

  /**
   * NEGATIVE CONTROL — the pre-fix carjack, on the live build with no edit.
   * `traffic.abandon()` first, which ejects the body itself at
   * `position.x + 1.4` before the player has reached the door and files the
   * car for ageing. The car is parked nose-along-x, so that offset is 1.4 m
   * down its own centre line: he ends up INSIDE it.
   */
  await stageJack(true);
  await settle(12);
  await bindTraffic();
  await tapF();
  await pump(190);
  const legacyJack = await run(`
    const v = game.__probeVeh;
    const traffic = ctx.peek('traffic');
    const j = window.__JACK__;
    const g = window.__EJECT__;
    let eject = null;
    if (g) {
      const dx = g.px - g.vx, dz = g.pz - g.vz;
      const ch = Math.cos(g.heading), sh = Math.sin(g.heading);
      eject = { x: dx * ch - dz * sh, z: dx * sh + dz * ch, hx: g.hx, hz: g.hz };
    }
    void traffic;
    return { eject, jackHadPed: !!(j && j.hasPed),
             seated: game.wq.playerVehicle() === v };`);
  const CL = legacyJack.eject;
  rec('NEGATIVE CONTROL — the old path drops him INSIDE the car he was in',
    !!CL && Math.abs(CL.x) < CL.hx,
    CL ? `${Math.abs(CL.x).toFixed(2)} m off centre against a ${CL.hx.toFixed(2)} m half width`
      : 'he never left the car at all');
  rec('NEGATIVE CONTROL — and the player never touches him: the jack carries no ped',
    legacyJack.jackHadPed === false && legacyJack.seated === true,
    `jack carried a ped ${legacyJack.jackHadPed}, player seated ${legacyJack.seated}`);
  await run(`player.vehicles.debugLegacyJack = false; return true;`);

  /* =================================================================== */
  area = 'gas station';
  /* =================================================================== */

  const gas = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    game.heat.clear('probe');
    const g = game.gasStations[0];
    const v = game.wq.spawnVehicle('sedan', g.x, g.z, 0);
    game.__probeVeh = v; game.__probeAt = g;
    game.debugBoard(v);
    return { station: g.name, hasFuel: typeof v.fuel === 'number', maxFuel: v.maxFuel ?? null };`);
  await pump(120);
  const gasBefore = await run(`
    const v = game.__probeVeh, g = game.__probeAt;
    v.position.set(g.x, v.position.y, g.z); v.velocity.set(0, 0, 0);
    if (typeof v.fuel === 'number') v.fuel = Math.min(v.fuel, (v.maxFuel ?? 100) * 0.2);
    return { fuel: v.fuel ?? null, aboard: game.wq.playerVehicle() === v };`);
  await settle(48);
  const gasAfter = await run(`return { fuel: game.__probeVeh.fuel ?? null };`);
  const gasPrompt = await prompt();
  rec('vehicles exposes a tank', gas.hasFuel, gas.hasFuel ? `maxFuel ${gas.maxFuel}` : 'no v.fuel yet');
  rec('stopping at the pumps refuels',
    !gas.hasFuel || (gasAfter.fuel > gasBefore.fuel + 1),
    gas.hasFuel ? `${gasBefore.fuel?.toFixed(1)} -> ${gasAfter.fuel?.toFixed(1)} at ${gas.station}`
      : 'skipped — no fuel model');
  rec('the pump prompt says what is happening', /REFUEL|TANK|STOP AT|REPAIR/.test(gasPrompt?.text ?? ''),
    gasPrompt ? `${gasPrompt.text} · ${gasPrompt.sub}` : 'no prompt');

  /* =================================================================== */
  area = 'body shop';
  /* =================================================================== */

  const shop = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    const s = game.safehouses.find((x) => x.id === 'sh_aidan');
    const v = game.wq.spawnVehicle('sedan', s.x, s.z, 0);
    game.__probeVeh = v; game.__probeAt = s;
    game.debugBoard(v);
    return { name: s.name };`);
  await pump(120);
  const shopBefore = await run(`
    const v = game.__probeVeh, s = game.__probeAt;
    v.position.set(s.x, v.position.y, s.z); v.velocity.set(0, 0, 0);
    v.health = v.maxHealth * 0.35;
    if (typeof v.fuel === 'number') v.fuel = (v.maxFuel ?? 100) * 0.25;
    return { health: v.health, fuel: v.fuel ?? null, cash: game.economy.cash,
             aboard: game.wq.playerVehicle() === v };`);
  await settle(48);
  const shopAfter = await run(`
    const v = game.__probeVeh;
    return { health: v.health, fuel: v.fuel ?? null, cash: game.economy.cash };`);
  const shopPrompt = await prompt();
  rec('Aidan’s shop repairs the car', shopAfter.health > shopBefore.health + 1,
    `${shopBefore.health.toFixed(0)} -> ${shopAfter.health.toFixed(0)} hp`);
  rec('Aidan’s shop tops the tank',
    shopBefore.fuel == null || shopAfter.fuel > shopBefore.fuel + 1,
    shopBefore.fuel == null ? 'skipped — no fuel model'
      : `${shopBefore.fuel.toFixed(1)} -> ${shopAfter.fuel.toFixed(1)}`);
  rec('and it is free', shopAfter.cash === shopBefore.cash, `$${shopBefore.cash} -> $${shopAfter.cash}`);
  rec('with a prompt', /DENT|SOUND|PULL INTO/.test(shopPrompt?.text ?? ''),
    shopPrompt ? `${shopPrompt.text} · ${shopPrompt.sub}` : 'no prompt');

  /* =================================================================== */
  area = 'respray';
  /* =================================================================== */

  const spray = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    const s = game.shops.find((x) => x.kind === 'spray');
    const v = game.wq.spawnVehicle('sedan', s.x, s.z, 0);
    game.__probeVeh = v; game.__probeAt = s;
    game.debugBoard(v);
    return { name: s.name };`);
  await pump(120);
  const sprayBefore = await run(`
    const v = game.__probeVeh, s = game.__probeAt;
    v.position.set(s.x, v.position.y, s.z); v.velocity.set(0, 0, 0);
    game.heat.raise(3, s.x, s.z);
    return { wanted: game.heat.wanted, paint: v.paintName, plate: v.plate,
             aboard: game.wq.playerVehicle() === v };`);
  await settle(64);
  const sprayAfter = await run(`
    const v = game.__probeVeh;
    return { wanted: game.heat.wanted, paint: v.paintName, plate: v.plate };`);
  rec('driving in clears the wanted level', sprayBefore.wanted >= 1 && sprayAfter.wanted === 0,
    `${sprayBefore.wanted}* -> ${sprayAfter.wanted}* at ${spray.name}`);
  rec('and changes the paint', sprayAfter.paint === 'resprayed',
    `${sprayBefore.paint} -> ${sprayAfter.paint}`);
  rec('and the plate', sprayAfter.plate !== sprayBefore.plate,
    `${sprayBefore.plate} -> ${sprayAfter.plate}`);

  /* =================================================================== */
  area = 'vehicle swap';
  /* =================================================================== */

  const swap = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    if (game.__probeVeh2) game.wq.despawnVehicle(game.__probeVeh2);
    game.heat.clear('probe');
    const c = game.__clear;
    const a = game.wq.spawnVehicle('sedan', c.x, c.z, 0);
    const b2 = game.wq.spawnVehicle('muscle', c.x + 4.4, c.z, 0);
    game.__probeVeh = a; game.__probeAt = c; game.__probeVeh2 = b2;
    game.debugBoard(a);
    return { a: a && a.name, b: b2 && b2.name };`);
  await pump(130);
  await run(`
    const b2 = game.__probeVeh2, c = game.__clear;
    b2.position.set(c.x + 4.4, b2.position.y, c.z); b2.velocity.set(0, 0, 0);
    for (const v2 of veh.vehicles.slice()) {
      if (v2 === b2 || v2 === game.__probeVeh) continue;
      if (Math.hypot(v2.position.x - c.x, v2.position.z - c.z) < 40) veh.despawn(v2);
    }
    return true;`);
  await settle(16);
  // The swap is a ROLLING move — parked means EXIT — so put the player's car
  // in motion before asking what the action button says.
  await run(`
    const a = game.__probeVeh, b2 = game.__probeVeh2, c = game.__clear;
    a.position.set(c.x, a.position.y, c.z);
    b2.position.set(c.x + 4.4, b2.position.y, c.z);
    b2.velocity.set(0, 0, 0);
    a.velocity.set(0, 0, -4);
    a.sleeping = false;
    return true;`);
  await pump(6);
  const swapPrompt = await prompt();
  const swapOffer = await run(`
    game.__offered = game.getAction().target;
    return { id: game.getAction().id, name: game.__offered && game.__offered.name };`);
  rec('a car alongside is offered',
    swapOffer.id === 'swap' && /SWITCH TO THE/.test(swapPrompt?.text ?? ''),
    swapPrompt ? swapPrompt.text : 'no prompt');
  await tapF();
  await pump(170);
  const swapped = await run(`
    return { inB: player.vehicles.vehicle === game.__offered,
             name: player.vehicles.vehicle && player.vehicles.vehicle.name,
             phase: player.vehicles.phase };`);
  rec('F switches into it', swapped.inB,
    `now in ${swapped.name ?? 'nothing'} (${swapped.phase}), offered ${swapOffer.name}`);

  /* =================================================================== */
  area = 'free roam content';
  /* =================================================================== */

  const pk = await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    if (game.__probeVeh2) game.wq.despawnVehicle(game.__probeVeh2);
    game.__probeVeh = null; game.__probeVeh2 = null;
    game.missions.abort();
    game.save.packages.length = 0;
    game.pickups.clear();
    game.freeroam.seedPackages();
    const seeded = game.pickups.live.length;
    const p = game.freeroam.packages[0];
    game.wq.placePlayer(p.x + 1.2, p.z, 0);
    game.__cash0 = game.economy.cash;
    return { seeded, id: p.id };`);
  await pump(40);
  const pkAfter = await run(`
    return { found: game.save.packages.slice(), gained: game.economy.cash - game.__cash0 };`);
  rec('12 hidden packages seed', pk.seeded === 12, `${pk.seeded} live`);
  rec('walking over one collects it', pkAfter.found.includes(pk.id),
    `${pkAfter.found.length} found, +$${pkAfter.gained}`);

  const shops = await run(`
    const a = game.shops.find((s) => s.kind === 'ammo');
    game.wq.placePlayer(a.x, a.z, 0);
    const c = game.economy.char();
    for (const k in c.ammo) c.ammo[k] = 0;
    return { name: a.name };`);
  await pump(24);
  const ammoPrompt = await prompt();
  rec('an ammo counter offers a purchase', /ROUNDS|FULLY LOADED/.test(ammoPrompt?.text ?? ''),
    ammoPrompt ? `${ammoPrompt.text} · ${ammoPrompt.sub}` : `no prompt at ${shops.name}`);

  await run(`
    const f = game.shops.find((s) => s.kind === 'food');
    game.wq.placePlayer(f.x, f.z, 0);
    player.health.value = 30;
    return true;`);
  await pump(24);
  const foodPrompt = await prompt();
  const foodCash = await run(`return game.economy.cash;`);
  await tapF();
  await pump(20);
  const foodAfter = await run(`return { hp: player.health.value, cash: game.economy.cash };`);
  rec('a food counter offers a meal', /EAT|NOT HUNGRY/.test(foodPrompt?.text ?? ''),
    foodPrompt ? foodPrompt.text : 'no prompt');
  rec('F buys it and heals', foodAfter.hp > 90 && foodAfter.cash < foodCash,
    `hp 30 -> ${foodAfter.hp.toFixed(0)}, $${foodCash} -> $${foodAfter.cash}`);

  // A circuit needs a car, so the honest test is "sitting on the grid in a car,
  // does the start line offer the race". On foot at a start line the resolver
  // correctly offers whatever car is parked there instead, which is the point
  // of the priority chain.
  const races = await run(`
    const ids = Object.keys(game.raceTracks);
    const t = game.raceTracks[ids[0]];
    const s = t.points[0];
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    const v = game.wq.spawnVehicle('sports', s.x, s.z, 0);
    game.__probeVeh = v; game.__probeAt = s;
    game.debugBoard(v);
    return { count: ids.length, name: t.name };`);
  await pump(120);
  await settle(16);
  const racePrompt = await prompt();
  const raceAct = await run(`return game.getAction().id;`);
  rec('3 race circuits exist', races.count === 3, `${races.count} tracks`);
  rec('a start line offers the circuit', raceAct === 'race' || /START/.test(racePrompt?.text ?? ''),
    racePrompt ? `${racePrompt.text} · ${racePrompt.sub}` : `no prompt at ${races.name}`);
  await run(`
    if (player.inVehicle) player.vehicles.abort(player.movement);
    if (game.__probeVeh) game.wq.despawnVehicle(game.__probeVeh);
    game.__probeVeh = null;
    return true;`);

  const lock = await run(`
    game.save.unlocks.length = 0;
    for (const id of ['carson', 'aidan', 'dylan']) game.save.chars[id].respect = 0;
    const sh = game.safehouses.find((s) => s.respect);
    game.wq.placePlayer(sh.x, sh.z, 0);
    return { id: sh.id, need: sh.respect };`);
  await pump(24);
  const lockedPrompt = await prompt();
  const unlocked = await run(`
    game.economy.addRespect(${'350'}, 'probe');
    return { has: game.economy.hasUnlock('sh_dt'), unlocks: game.save.unlocks.slice() };`);
  await pump(24);
  const unlockedPrompt = await prompt();
  /* =================================================================== */
  area = 'ride the trolley';
  /* =================================================================== */
  /**
   * REPORTED, from play: "I don't see any trollys — add riding the trolly or
   * the incline with automatic cinematic camera".
   *
   * `src/vehicles/tramprobe.mjs` gates the same sequence in node against a
   * stub physics world; this is the half that stub cannot answer — the real
   * streamed city, the real key path, the real DOM prompt, the real collision
   * world deciding where a man may be put down. If these two disagree, the
   * difference is the world, which is the point of running both.
   *
   * Ordering note: this section leaves the player standing on the ballast in
   * the Strip, which is why it sits after everything that cares where he is.
   */

  const tramSeen = await run(`
    game.missions.abort();
    if (player.inVehicle) player.vehicles.abort(player.movement);
    const svc = veh._tram;
    const cars = svc && svc.cars ? svc.cars : [];
    return {
      cars: cars.length,
      stops: svc && svc.stops ? svc.stops.map((s) => s.name) : [],
      transit: cars.every((c) => !!c.vehicle.transit),
      takeable: cars.every((c) => c.vehicle.enterable === false),
    };`);
  rec('a fleet of trolleys is running the line, not one car',
    tramSeen.cars >= 2 && tramSeen.transit && tramSeen.takeable,
    `${tramSeen.cars} cars, stops ${tramSeen.stops.join(' / ')}`);

  /**
   * Park the player at the kerb beside the car under test.
   *
   * The offset is rotated by the carriage's own YAW rather than by
   * three's `applyQuaternion`: this string is evaluated in the page, where
   * `THREE` is not a global. A vehicle's nose is +Z, so (2.4, -4.35) local is
   * "two and a half metres off the flank, level with the rear door".
   */
  const STAND_BESIDE = `
    const svc = veh._tram;
    const c = svc.cars[game.__tramIdx];
    const v = c.vehicle;
    const q = v.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    const s = Math.sin(yaw), co = Math.cos(yaw);
    const lx = 2.4, lz = -4.35;
    game.wq.placePlayer(v.position.x + lx * co + lz * s, v.position.z - lx * s + lz * co, 0);
    return { dwelling: c.transit.dwelling, speed: +c.transit.speed.toFixed(2) };`;

  // Stand next to the nearest car and let the city stream in around us before
  // anything is measured — a prompt read through a half-built tile is noise.
  await run(`
    const svc = veh._tram;
    const p = player.position;
    let best = 0;
    let bd = Infinity;
    svc.cars.forEach((c, i) => {
      const d = Math.hypot(c.vehicle.position.x - p.x, c.vehicle.position.z - p.z);
      if (d < bd) { bd = d; best = i; }
    });
    game.__tramIdx = best;
    return best;`);
  await run(STAND_BESIDE);
  await pump(150);

  /* ---- NEGATIVE CONTROL: press F at a rolling carriage ---------------- */
  /**
   * The waits in this section are WOUND, not sat out.
   *
   * A trolley stands 8 s and runs 45 s, so watching the timetable go round
   * costs this probe a minute and a half of wall clock to prove three
   * transitions. The timetable is `tramprobe.mjs`'s subject and is gated
   * there against the emitted trajectory; what is under test HERE is the
   * player path through the real streamed world, so the service's own
   * `RailMover` state is moved to the interesting moment the same way
   * `game.__probeAt` holds a car still for the carjack section above.
   */
  await run(`
    const m = veh._tram.cars[game.__tramIdx].mover;
    m.wait = 0;
    return m.wait;`);
  await pump(45);
  await run(STAND_BESIDE);
  await pump(6);
  const movingPrompt = await prompt();
  await tapF();
  await pump(20);
  const movingBoard = await run(`
    const c = veh._tram.cars[game.__tramIdx];
    return { inVehicle: !!player.inVehicle, phase: player.vehicles.phase,
             speed: +c.transit.speed.toFixed(2) };`);
  rec('CONTROL: F at a moving trolley does nothing',
    movingBoard.inVehicle === false && movingBoard.phase === 'none',
    `at ${movingBoard.speed} m/s: phase ${movingBoard.phase}, ` +
    `prompt ${movingPrompt ? movingPrompt.text : 'none'}`);

  /* ---- board at the stop --------------------------------------------- */
  await run(`
    const m = veh._tram.cars[game.__tramIdx].mover;
    m.s = m.dir > 0 ? m.sMax - 6 : m.sMin + 6;
    return m.s;`);
  let atStop = false;
  for (let i = 0; i < 25; i++) {
    const st = await run('return veh._tram.cars[game.__tramIdx].transit.dwelling;');
    if (st) { atStop = true; break; }
    await pump(8);
  }
  await run(STAND_BESIDE);
  await pump(8);
  const ridePrompt = await prompt();
  rec('a trolley standing at its stop offers the ride',
    atStop && /RIDE/.test(ridePrompt?.text ?? ''),
    ridePrompt ? `${ridePrompt.key} ${ridePrompt.text} · ${ridePrompt.sub}` : 'no prompt');

  await tapF();
  await pump(120);
  const aboard = await run(`
    const c = veh._tram.cars[game.__tramIdx];
    return {
      phase: player.vehicles.phase,
      passenger: player.vehicles.passenger === true,
      same: player.vehicles.vehicle === c.vehicle,
      cine: player.rig.cinematicActive === true,
      shot: player.rig.cinematicShot,
      driver: c.vehicle.driver ?? null,
    };`);
  rec('F seats you as a PASSENGER, with no hand on the controls',
    aboard.phase === 'drive' && aboard.passenger && aboard.same && aboard.driver === null,
    `phase ${aboard.phase}, passenger ${aboard.passenger}, driver ${aboard.driver}`);
  rec('...and the automatic camera takes over',
    aboard.cine === true && !!aboard.shot,
    `cinematic ${aboard.cine}, opening shot ${aboard.shot}`);

  /* ---- ride a segment ------------------------------------------------ */
  const shotSet = new Set();
  for (let i = 0; i < 26; i++) {
    const s = await run('return player.rig.cinematicShot;');
    if (s) shotSet.add(s);
    await pump(8);
  }
  const riding = await run(`
    const c = veh._tram.cars[game.__tramIdx];
    const v = c.vehicle;
    const inv = v.quaternion.clone().invert();
    const local = player.position.clone().sub(v.position).applyQuaternion(inv);
    return {
      moving: c.transit.speed > 1,
      seated: player.vehicles.phase === 'drive',
      lx: +local.x.toFixed(2), ly: +local.y.toFixed(2), lz: +local.z.toFixed(2),
      half: { x: v.spec.half.x, y: v.spec.half.y, z: v.spec.half.z },
    };`);
  rec('the reel CUTS between framings while you ride',
    shotSet.size >= 2,
    `${shotSet.size} distinct shots: ${[...shotSet].join(', ')}`);
  rec('the passenger rides INSIDE the carriage',
    riding.seated && Math.abs(riding.lx) < riding.half.x &&
    Math.abs(riding.lz) < riding.half.z && Math.abs(riding.ly) < riding.half.y + 0.6,
    `body at (${riding.lx}, ${riding.ly}, ${riding.lz}) in a ` +
    `${riding.half.x * 2} x ${riding.half.z * 2} m carriage, moving ${riding.moving}`);

  /* ---- ring the bell, get off at the next stop ------------------------ */
  await tapF();
  await pump(10);
  const rang = await run(`
    return { requested: player.vehicles.alightRequested === true,
             phase: player.vehicles.phase };`);
  rec('F between stops rings for the next one instead of dumping you out',
    rang.requested === true && rang.phase === 'drive',
    `requested ${rang.requested}, phase ${rang.phase}`);

  // Wind on to the far mark (see the note above the control).
  await run(`
    const m = veh._tram.cars[game.__tramIdx].mover;
    m.s = m.dir > 0 ? m.sMax - 8 : m.sMin + 8;
    return m.s;`);
  let gotOff = false;
  for (let i = 0; i < 40; i++) {
    const st = await run('return player.vehicles.phase;');
    if (st === 'none') { gotOff = true; break; }
    await pump(8);
  }
  const alighted = await run(`
    const c = veh._tram.cars[game.__tramIdx];
    const v = c.vehicle;
    const p = player.position;
    return {
      phase: player.vehicles.phase,
      inVehicle: !!player.inVehicle,
      passenger: player.vehicles.passenger === true,
      cine: player.rig.cinematicActive === true,
      dwelling: c.transit.dwelling,
      off: +Math.hypot(p.x - v.position.x, p.z - v.position.z).toFixed(2),
      drop: +(p.y - (v.position.y - v.spec.comY)).toFixed(2),
      halfX: v.spec.half.x, halfZ: v.spec.half.z,
    };`);
  rec('...and the next dwell puts you down beside the car',
    gotOff && alighted.inVehicle === false && alighted.passenger === false &&
    alighted.dwelling === true &&
    alighted.off > alighted.halfX && alighted.off < alighted.halfZ + 6 &&
    Math.abs(alighted.drop) < 2.5,
    `phase ${alighted.phase}, ${alighted.off} m from the car centre, ` +
    `${alighted.drop} m above the railhead, dwelling ${alighted.dwelling}`);
  rec('...with the camera handed back to the player',
    alighted.cine === false,
    `cinematic ${alighted.cine}`);

  /* =================================================================== */
  area = 'job board';
  /* =================================================================== */

  const board = await run(`
    game.missions.abort();
    const list = game.jobBoard();
    return {
      count: list.length,
      ids: list.map((j) => j.id),
      names: list.map((j) => j.name),
      pays: list.map((j) => j.pay),
      dists: list.map((j) => Math.round(j.dist)),
      tracks: list.map((j) => j.track),
    };`);
  rec('the board offers three distinct jobs',
    board.count === 3 && new Set(board.ids).size === 3,
    board.ids.join(', '));
  rec('each pays and is somewhere to drive to',
    board.pays.every((p) => p > 0) && board.dists.every((d) => d > 100),
    board.names.map((n, i) => `${n} $${board.pays[i]} @ ${board.dists[i]}m`).join(' · '));

  const took = await run(`
    const M = game.takeJob();
    return M ? { id: M.id, track: M.track, side: M.side, cash: M.def.cash,
                 poi: M.startPoi && M.startPoi.name } : null;`);
  rec('a job starts as a real mission',
    !!took && took.side === true && !!took.track,
    took ? `${took.id} · ${took.track} · $${took.cash} · staged at ${took.poi}` : 'did not start');

  const afterStory = await run(`
    game.missions.abort();
    const boy = game.characters.boy;
    game.economy.char().chapter = boy.story.length;   // arc complete
    game._announceNext();                             // which clears the pending chapter
    const M = game.startMission();
    const out = M ? { id: M.id, side: M.side } : null;
    game.missions.abort();
    game.economy.char().chapter = 0;
    return out;`);
  rec('J still gives you work after the story ends',
    !!afterStory && afterStory.side === true,
    afterStory ? afterStory.id : 'J did nothing with the arc complete');

  /* =================================================================== */
  area = 'free roam content';
  /* =================================================================== */

  rec('a locked safehouse says so', /LOCKED/.test(lockedPrompt?.text ?? ''),
    lockedPrompt ? `${lockedPrompt.text} · ${lockedPrompt.sub}` : 'no prompt');
  rec('respect unlocks it and the ring opens',
    unlocked.has && !/LOCKED/.test(unlockedPrompt?.text ?? ''),
    `${unlocked.unlocks.join(', ')} · ${unlockedPrompt?.text ?? 'no prompt'}`);

  /* =================================================================== */
  area = 'teleport';
  /* =================================================================== */
  /*
   * "TELEPORTING TO THE INCLINE CAUSES THE PLAYER TO GET STUCK UNDER THE
   * BUILDING AND CAN'T GET OUT" — the owner's report, measured.
   *
   * Every destination the cheat menu offers is taken for real, the city is
   * allowed to STREAM (this is the whole point: a spawn or a teleport is vetted
   * against collision that does not exist yet, so the only honest place to ask
   * is standing on it, after `world.streamingIdle`), and then two questions:
   *
   *   floor     the feet are not below `world.walkableHeightAt`. This is the
   *             bridge class: a pin on a deck resolved to the RIVERBANK under
   *             it, because `walkableHeightAt` with no `y` hint says so in its
   *             own note — "a bridge deck more than a couple of metres off the
   *             ground is ignored". All twelve bridges failed this.
   *   bearings  at least `TP_BAR` of 16 bearings at ankle height are a way out,
   *             by the same 2 m rule `spawnprobe` uses. This is the incline
   *             class: INSIDE the lower station, 10 of 16 blocked, its roof
   *             9.2 m overhead, and no rescue ever came because only a brother
   *             switch armed `Director.armUnstick` — a cheat teleport did not.
   *
   * RATCHETED (rule 13), not absolute: a handful of destinations are the middle
   * of a landmark whose interior is wider than the 30 m rescue ring — the Old
   * Blast Furnace pin is 72 m inside its own site — and those are a POI-table
   * question, not a placement one. The count may only go down.
   */
  const TP_BAR = 8;
  /**
   * How many destinations may still fail the bearings test.
   *
   * A RATCHET (rule 13), and it is checked against a measurement taken in the
   * SAME RUN rather than against a number written down once: the control arm
   * below walks the identical list with the fix switched off, so the pair is
   * immune to the machine, to streaming order and to the seed. Before the fix,
   * every bridge pin put the player under its own span and six landmark pins
   * put him inside the building.
   */
  const TP_MAX_STUCK = 8;
  /**
   * ...and the control must be at least this bad, or the pair proves nothing.
   * It walks the bridge and landmark groups only — see `ctlList`.
   */
  const TP_MIN_CONTROL_STUCK = 10;
  /** Feet may sit this far under the analytic surface (kerb camber, settle). */
  const TP_FLOOR_TOL = 0.35;

  /**
   * Where he ended up, and whether he can leave.
   *
   * `blocked` is `spawnprobe`'s rule exactly: of sixteen bearings at ankle
   * height, how many meet a wall within 2 m or ground one step up 1.2 m out.
   * `floor` is `walkableHeightAt` with NO hint — deliberately, because the
   * question here is "is he under the street", and the hinted answer would call
   * legitimate ground beneath a bridge a violation. The deck election the fix
   * actually makes is asserted analytically at the end, where it is exact.
   */
  const tpSample = () => page.evaluate(() => {
    const e = window.__ENGINE__;
    const w = e.ctx.peek('world');
    const ph = e.ctx.peek('physics');
    const pos = e.ctx.peek('player').feetPosition ?? e.ctx.peek('player').position;
    const mask = ph.MASK?.WORLD;
    let blocked = 0;
    const H = pos.y + 0.40;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const h = ph.raycast({ x: pos.x, y: H, z: pos.z }, { x: dx, y: 0, z: dz }, 8, mask);
      if (h?.hit) { if (h.distance < 2) blocked++; continue; }
      const gy = ph.groundHeight?.(pos.x + dx * 1.2, pos.z + dz * 1.2, 200, mask);
      if (Number.isFinite(gy) && gy - pos.y > 0.42) blocked++;
    }
    const floor = w.walkableHeightAt(pos.x, pos.z);
    return {
      x: +pos.x.toFixed(1), y: +pos.y.toFixed(2), z: +pos.z.toFixed(1), blocked,
      wet: w.isWater(pos.x, pos.z) === true,
      under: +((Number.isFinite(floor) ? floor : pos.y) - pos.y).toFixed(2),
    };
  });

  /** Teleport, let the city arrive, let the deferred unstick have its say. */
  const tpTo = async (x, z) => {
    await page.evaluate(([px, pz]) => window.__ENGINE__.ctx.peek('ui').cheats._teleport(px, pz), [x, z]);
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(() => window.__ENGINE__.ctx.peek('world')?.streamingIdle?.() === true)) break;
      await pump(8);
    }
    // `streamingIdle` can flicker true a frame before the sector under his feet
    // lands, and `Director.tickUnstick` is gated on the same predicate, so give
    // the deferred rescue frames to run and then confirm once more.
    await pump(24);
    if (!(await page.evaluate(() => window.__ENGINE__.ctx.peek('world')?.streamingIdle?.() === true))) {
      for (let i = 0; i < 20; i++) {
        if (await page.evaluate(() => window.__ENGINE__.ctx.peek('world')?.streamingIdle?.() === true)) break;
        await pump(8);
      }
      await pump(24);
    }
    return tpSample();
  };

  /** Walk the whole list once. Returns the rows and the two counts. */
  const tpSweep = async (targets) => {
    const rows = [];
    for (const t of targets) rows.push({ t, r: await tpTo(t.x, t.z) });
    return {
      rows,
      // A DOCK IS EXEMPT FROM THE FLOOR TEST, deliberately: `world/plan.js`
      // sites all four of them IN the channel so a hull moored on one floats,
      // so `heightAt` there is river BED and the man swims. Wet is the right
      // answer at a dock pin and never anywhere else.
      sunk: rows.filter((r) => !r.r.wet && r.r.under > TP_FLOOR_TOL),
      stuck: rows.filter((r) => 16 - r.r.blocked < TP_BAR),
    };
  };

  const tpTargets = await page.evaluate(() => {
    const c = window.__ENGINE__.ctx.peek('ui')?.cheats;
    if (!c) return null;
    return c._teleportTargets().map((t) => ({ name: t.name, group: t.group, x: t.x, z: t.z }));
  });
  rec('the cheat menu publishes a teleport list', Array.isArray(tpTargets) && tpTargets.length > 20,
    tpTargets ? `${tpTargets.length} destinations` : 'no cheat menu (needs ?cheats=1)');

  const fixArm = await tpSweep(tpTargets ?? []);
  const nRows = fixArm.rows.length;
  rec('every teleport lands ON the walkable surface, not under it',
    nRows > 0 && fixArm.sunk.length === 0,
    `${nRows - fixArm.sunk.length}/${nRows} on the floor (${fixArm.rows.filter((r) => r.r.wet).length} wet, exempt)` +
      (fixArm.sunk.length ? ` — under it: ` + fixArm.sunk.map((r) => `${r.t.name} ${r.r.under} m`).join(', ') : ''));
  rec(`every teleport leaves ${TP_BAR}/16 bearings to walk out of`,
    nRows > 0 && fixArm.stuck.length <= TP_MAX_STUCK,
    `${nRows - fixArm.stuck.length}/${nRows} clear (RATCHET <= ${TP_MAX_STUCK})` +
      (fixArm.stuck.length ? ` — stuck: ` + fixArm.stuck.map((r) => `${r.t.name} ${r.r.blocked}/16`).join(', ') : ''));
  const incline = fixArm.rows.find((r) => /INCLINE/.test(r.t.name) && r.t.group === 'LANDMARK');
  rec('the Duquesne Incline is somewhere you can stand',
    !!incline && 16 - incline.r.blocked >= TP_BAR,
    incline ? `${incline.r.blocked}/16 blocked at ${incline.r.x}, ${incline.r.y}, ${incline.r.z}` : 'not offered');

  /**
   * THE NEGATIVE CONTROL — the same page, the same list, in the same run, with
   * `?nostandfix=1`: the hatch in `src/game/util.js` that puts `placePlayer`
   * back exactly as it shipped. If the failures do not come back, none of the
   * three checks above is measuring anything (ARCHITECTURE.md rule 12).
   */
  await page.goto(`http://127.0.0.1:${port}/?cheats=1&nostandfix=1`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 120000 });
  await pump(120);
  // The control walks the CLASSES the fix targets — every bridge pin and every
  // landmark — rather than all 80-odd destinations: the gas stations and
  // safehouses were already fine on both arms, and a second full sweep doubles
  // the wall clock of this file for rows that cannot move.
  const ctlList = (tpTargets ?? []).filter((t) => t.group === 'BRIDGE' || t.group === 'LANDMARK');
  const ctlArm = await tpSweep(ctlList);
  const ctlInc = ctlArm.rows.find((r) => /INCLINE/.test(r.t.name) && r.t.group === 'LANDMARK');
  const fixSame = fixArm.rows.filter((r) => r.t.group === 'BRIDGE' || r.t.group === 'LANDMARK');
  const fixSameStuck = fixSame.filter((r) => 16 - r.r.blocked < TP_BAR);
  rec('N1 NEGATIVE CONTROL: with the fix off, the same rows strand him',
    ctlArm.stuck.length >= TP_MIN_CONTROL_STUCK && ctlArm.stuck.length > fixSameStuck.length,
    `${ctlArm.stuck.length}/${ctlArm.rows.length} stuck without the fix against ${fixSameStuck.length}/${fixSame.length} with it` +
      ` — e.g. ` + ctlArm.stuck.slice(0, 6).map((r) => `${r.t.name} ${r.r.blocked}/16`).join(', '));
  rec('N2 NEGATIVE CONTROL: with the fix off, the incline traps him again',
    !!ctlInc && 16 - ctlInc.r.blocked < TP_BAR,
    ctlInc ? `${ctlInc.r.blocked}/16 blocked (fixed arm: ${incline?.r.blocked}/16)` : 'not measured');

  /**
   * ...and the deck election itself, asserted ANALYTICALLY so no streaming race
   * can touch it. `standSpot` walks a ladder of height hints; the plain call is
   * the one `cheats.groundY` makes and the one that put the player on the
   * riverbank. On a bridge pin the two must disagree by most of a span.
   */
  const deck = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const w = e.ctx.peek('world');
    const wq = e.ctx.peek('game').wq;
    const out = [];
    for (const b of (w.bridges ?? [])) {
      // `world.bridges` publishes the two dry anchors; mid-span is where the
      // deck is highest over the channel and is the only point that matters.
      if (!Array.isArray(b.a) || !Array.isArray(b.b)) continue;
      const x = (b.a[0] + b.b[0]) / 2;
      const z = (b.a[1] + b.b[1]) / 2;
      const plain = w.walkableHeightAt(x, z);
      const s = wq.standSpot(x, z);
      out.push({ name: b.name ?? b.id, lift: +(s.y - plain).toFixed(2) });
    }
    return out;
  });
  const lifted = deck.filter((d) => d.lift > 4);
  rec('a bridge pin resolves to the DECK, not the bank under it',
    deck.length > 0 && lifted.length >= Math.ceil(deck.length * 0.5),
    `${lifted.length}/${deck.length} bridge pins lift onto their own deck; worst lift ` +
      `${Math.max(0, ...deck.map((d) => d.lift)).toFixed(2)} m over the un-hinted answer`);

  /* ---- report ------------------------------------------------------- */
  const pass = results.filter((r) => r.ok).length;
  const w = Math.max(...results.map((r) => r.name.length));
  let cur = '';
  for (const r of results) {
    if (r.area !== cur) { cur = r.area; console.log(`\n--- ${cur} ---`); }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail ?? ''}`);
  }
  console.log(`\n${pass}/${results.length} interactions working`);
  if (errs.length) console.log(`\nconsole errors (${errs.length}):\n  ` + [...new Set(errs)].slice(0, 8).join('\n  '));
  process.exitCode = pass === results.length ? 0 : 1;
} catch (e) {
  console.error('interactprobe failed:', e.message);
  console.error([...new Set(errs)].slice(0, 8).join('\n'));
  process.exitCode = 1;
} finally {
  if (!KEEP) await b.close();
  server?.kill();
}
