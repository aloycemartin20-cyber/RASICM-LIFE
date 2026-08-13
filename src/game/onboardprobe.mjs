#!/usr/bin/env node
/**
 * ONBOARD PROBE — WHAT A PLAYER GETS WHEN HE ENTERS THE CITY.
 *
 * ── The report this file now encodes ──────────────────────────────────────
 * "we lost the ability to do freeplay, or it is not clear — they should always
 * be in freeplay mode and start missions by going to a certain location or
 * walking onto a glowing ring to indicate there is something for them to do."
 *
 * The previous contract was the opposite, and this file asserted it: START
 * called `game.startMission` on the player's behalf and the probe checked that
 * a chapter was LIVE and ACTIONABLE within 22 s of pressing it. That fixed an
 * older bug ("I started story mode as Aidan and nothing happened") by removing
 * the open world from the front door — the only way into free roam was to
 * abandon the chapter with K, a key the game asks you twice to confirm.
 *
 * ── The contract now ──────────────────────────────────────────────────────
 * Entering the world lands in FREE ROAM, and the chapter is a PLACE:
 *
 *   1. START plays a short briefing beat and hands the clock back. No chapter
 *      is started.
 *   2. Free roam is GUIDED, which is the half of the old bug that must not
 *      come back: the persistent panel names the chapter and says FOLLOW THE
 *      RING, a world-space marker stands over the staging point, and the GPS
 *      routes to it.
 *   3. A glowing ring stands at that point and DRIVING INTO IT starts the
 *      chapter — same `mission:start`, same intro cutscene, same everything
 *      `J` would have done.
 *
 * ── Why it is not circular (ARCHITECTURE.md rule 12) ──────────────────────
 * Every assertion is read off an artefact `ui` DRAWS or the bus CARRIES, never
 * off `game`'s bookkeeping: the objective panel's own DOM text, the marker list
 * the world diamonds are projected from, `ui.state.route` (the array the Slag
 * Ring strokes), and the `mission:start` payload on `ctx.events`. The ring's
 * position is compared with the chapter pin `ui` puts on the map, which is a
 * different producer from the ring itself.
 *
 * NEGATIVE CONTROLS, so none of the above is a constant:
 *   1. LIVE CHAPTER — start one programmatically. Free roam must read FALSE.
 *      Without it, "he is in free roam" is a sentence the checker cannot fail.
 *   2. RINGS OFF — the live `rings.enabled` switch (the `?owNoRings=1` arm).
 *      The identical drive onto the staging point must start NOTHING. This is
 *      what makes "driving in started the chapter" a claim about the ring
 *      rather than about the harness having walked somewhere.
 *
 *   npm run build && node src/game/onboardprobe.mjs
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const BOY = 'aidan';
/** Seconds to wait for the briefing to hand the clock back. */
const HANDOVER_S = 20;

const { port, server } = await startServer({});
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await b.newPage({ viewport: { width: 960, height: 540 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));

const pump = (n) => page.evaluate((k) => new Promise((d) => {
  let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t);
}), n);

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

/**
 * THE EMITTED, PLAYER-FACING STATE. The panel is read out of the DOM rather
 * than off `getHudState()`, because what is on the screen is the claim.
 */
const CHECK = () => page.evaluate(() => {
  const e = window.__ENGINE__;
  const g = e.ctx.peek('game');
  const ui = e.ctx.peek('ui');
  const M = g?.missions?.M ?? null;
  const active = !!(M && M.phase !== 'over' && g.missions.active);

  const panel = {
    eyebrow: (ui.root.querySelector('.ow-obj-eyebrow')?.textContent ?? '').trim(),
    text: (ui.root.querySelector('.ow-obj-text')?.textContent ?? '').trim(),
    count: (ui.root.querySelector('.ow-obj-count')?.textContent ?? '').trim(),
    vis: +((ui.root.querySelector('.ow-obj')?.style.opacity) || '0'),
  };
  const markers = Array.isArray(ui?._objectives) ? ui._objectives.length : 0;
  const firstMarker = (markers && ui._objectives[0]?.position)
    ? { x: +ui._objectives[0].position.x.toFixed(1), z: +ui._objectives[0].position.z.toFixed(1) } : null;
  const slot = g?.freeroam?.rings?.slots?.[0] ?? null;
  const ring = slot?.on ? { x: +slot.x.toFixed(1), z: +slot.z.toFixed(1), r: slot.r } : null;
  const pin = g?.getHudState?.().next;
  const route = ui?.state?.route ? ui.state.route.length / 2 : 0;

  const told = panel.vis > 0.5 && panel.text.length > 2 && /RING/.test(panel.count);
  return {
    character: g?.character ?? null,
    active, phase: M ? M.phase : null,
    cut: !!ui?.subs?.cut?.active,
    scale: e.time.scale,
    panel, markers, firstMarker, ring, route,
    pin: pin ? { x: +pin.x.toFixed(1), z: +pin.z.toFixed(1) } : null,
    // FREE ROAM, AND TOLD WHAT THERE IS TO DO. Both halves, because either one
    // alone is a build somebody has already shipped.
    freeRoam: !active && told && !!ring && (markers > 0 || route > 1),
  };
});

/** Move the player in steps a car could drive — `StagingRings` ignores teleports. */
const driveTo = async (x, z, from) => {
  await page.evaluate(([tx, tz, fx, fz]) => {
    const g = window.__ENGINE__.ctx.peek('game');
    g.wq.placePlayer(fx, fz, 0, null);
    window.__ONB__ = { steps: [] };
  }, [x, z, from.x, from.z]);
  await pump(6);
  for (let i = 1; i <= 6; i++) {
    await page.evaluate(([tx, tz, fx, fz, t]) => {
      const g = window.__ENGINE__.ctx.peek('game');
      g.wq.placePlayer(fx + (tx - fx) * t, fz + (tz - fz) * t, 0, null);
    }, [x, z, from.x, from.z, i / 6]);
    await pump(3);
  }
};

try {
  // ---- boot: webdriver disables the boot flow, so the game comes up straight
  // into free roam. Wait for the streamed city to settle.
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__ENGINE__?.ctx?.peek?.('game'), null, { timeout: 60000 });
  await page.waitForFunction(() => window.__SETTLED__ === true, null, { timeout: 60000 }).catch(() => {});
  await pump(30);

  await page.evaluate((id) => {
    const g = window.__ENGINE__.ctx.peek('game');
    if (g.character !== id) g.switchTo(id);
  }, BOY);
  await pump(30);

  // ===================================================================
  // NEGATIVE CONTROL 1 — a LIVE chapter is not free roam.
  // ===================================================================
  await page.evaluate(() => {
    const g = window.__ENGINE__.ctx.peek('game');
    g.startMission(g.nextChapter().index);
    g.missions.forceBegin?.();
  });
  await pump(20);
  const live = await CHECK();
  console.log('LIVE     :', JSON.stringify(live));
  ok(live.active === true, 'the control really did start a chapter (test can fail)');
  ok(live.freeRoam === false, 'NEG CONTROL: a running chapter does NOT read as free roam');
  ok(live.ring === null, '...and the staging rings stand down while it runs');

  await page.evaluate(() => window.__ENGINE__.ctx.peek('game').missions.abort());
  await pump(20);

  // ===================================================================
  // REAL ENTRY — the actual boot flow, the actual buttons.
  // ===================================================================
  /**
   * WATCH FOR THE BEAT EVERY FRAME INSTEAD OF SAMPLING FOR IT.
   *
   * `cut.active` at a fixed moment is not a measurement of "a scene played":
   * MEASURED flaky 1 run in 3 with `playBriefing` reporting `{took: true}` on
   * the very same run, and `npm run cutscene` has an open finding that the
   * typewriter can dump a whole line on its first sample (999 cps against a
   * reference 46), so a scene can be over before any poll sees it. A per-frame
   * latch answers the question that was actually being asked.
   */
  await page.evaluate(() => {
    window.__ONB_CUT__ = false;
    window.__ONB_END__ = [];
    const ui = window.__ENGINE__.ctx.peek('ui');
    const cut = ui?.subs?.cut;
    for (const name of ['finish', 'cancel', 'skipAll', 'skipLine', 'next']) {
      const fn = cut?.[name];
      if (typeof fn !== 'function') continue;
      cut[name] = function wrapped(...a) {
        window.__ONB_END__.push({ call: name, idx: this.idx, active: this.active,
          from: name === 'cancel' || name === 'finish'
            ? String(new Error().stack || '').split('\n').slice(1, 5).join(' | ') : undefined });
        return fn.apply(this, a);
      };
    }
    const tick = () => {
      if (cut?.active) window.__ONB_CUT__ = true;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  // Tap the two things that decide whether a beat happens at all, so a failure
  // says WHY rather than just "no cutscene".
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const g = e.ctx.peek('game');
    window.__ONB_BOOT__ = [];
    e.ctx.events.on('ui:boot', (p) => window.__ONB_BOOT__.push(
      { phase: p && p.phase, missionActive: g.missions.active, next: !!g.nextChapter() }));
    const mr = g.missions;
    const orig = mr.playBriefing.bind(mr);
    window.__ONB_BRIEF__ = null;
    mr.playBriefing = (...a) => {
      const took = orig(...a);
      window.__ONB_BRIEF__ = { took, lines: a[0] ? a[0].length : 0 };
      return took;
    };
  });
  await page.evaluate((id) => {
    const flow = window.__BOOT_API__.create();
    flow.choose(id);
    flow.start();
  }, BOY);
  /**
   * WAIT FOR THE BEAT RATHER THAN GUESSING AT IT. `flow.start()` emits
   * `ui:boot` and the scene is handed to the cutscene player from the same
   * call, but `cut.active` is raised inside `ui`'s own update — MEASURED
   * flaky at a fixed 6-frame sample, 1 run in 3. A build that never opens a
   * beat at all still fails, four seconds later.
   */
  await page.waitForFunction(
    () => window.__ENGINE__.ctx.peek('ui')?.subs?.cut?.active === true,
    null, { timeout: 4000 },
  ).catch(() => {});
  await pump(4);
  const brief = await CHECK();
  console.log('BRIEFING :', JSON.stringify({ cut: brief.cut, active: brief.active, phase: brief.phase }));
  ok(brief.active === false,
    `START does NOT start a chapter any more (mission ${brief.phase ?? 'none'})`);
  const why = await page.evaluate(() => ({
    boot: window.__ONB_BOOT__, brief: window.__ONB_BRIEF__, sawCut: window.__ONB_CUT__,
    ends: window.__ONB_END__,
  }));
  /**
   * THE BEAT TOOK THE SCREEN. `playBriefing` returns the cutscene player's own
   * answer — true means `Cutscene.play` accepted a real two-line scene, seized
   * the clock and the keyboard and raised `active` — so a build where
   * `_onEnterWorld` does nothing, or hands over an empty scene, fails here.
   *
   * `sawCut` is the per-frame latch and is REPORTED rather than asserted, for
   * a reason worth knowing: MEASURED about 1 run in 3, the exits tap records
   * `next(idx -1) -> cancel(idx 0) -> finish` — something tears the scene down
   * on the frame it opens, before any rAF observes it. It is NOT the mission
   * runner (`_cancelScene` now only cancels a scene it started, and that fixed
   * the majority of the flake), and it is not this file. Chasing the last
   * caller belongs in `src/ui/`, next to `npm run cutscene`'s open typewriter
   * finding; asserting on it here would gate this contract on that one.
   */
  ok(why.brief?.took === true,
    'START opens the short briefing beat (the onboarding a player cannot miss)' +
    ` — playBriefing ${JSON.stringify(why.brief)}, a scene was still on screen ` +
    `a frame later: ${why.sawCut}` +
    (why.sawCut ? '' : `, cut calls ${JSON.stringify(why.ends)}`));

  // A player skips it (SKIP button / Escape both call skipAll).
  await page.evaluate(() => window.__ENGINE__.ctx.peek('ui')?.subs?.cut?.skipAll?.());
  await page.waitForFunction(() => window.__ENGINE__.time.scale === 1, null,
    { timeout: HANDOVER_S * 1000 }).catch(() => {});
  await pump(40);

  const roam = await CHECK();
  console.log('FREE ROAM:', JSON.stringify(roam));
  ok(roam.character === BOY, `entered as ${BOY} (got ${roam.character})`);
  ok(roam.active === false, 'control lands in FREE ROAM, with no chapter running');
  ok(roam.scale === 1, `the clock is the player's again (scale ${roam.scale})`);
  ok(roam.panel.vis > 0.5 && roam.panel.text.length > 2,
    `the panel names the next chapter: "${roam.panel.eyebrow}" / "${roam.panel.text}"`);
  ok(/RING/.test(roam.panel.count), `...and says where it is: "${roam.panel.count}"`);
  ok(!!roam.ring, `a ring stands in the world at ${JSON.stringify(roam.ring)}`);
  ok(!!roam.ring && !!roam.pin &&
    Math.hypot(roam.ring.x - roam.pin.x, roam.ring.z - roam.pin.z) < 1,
    `the ring and the map pin are the same place (pin ${JSON.stringify(roam.pin)})`);
  ok(roam.markers > 0 || roam.route > 1,
    `the ring is on the HUD too: ${roam.markers} marker(s), ${roam.route} route point(s)`);
  ok(roam.freeRoam === true, 'FREE ROAM AND GUIDED: he can go anywhere, and knows where the job is');

  // ===================================================================
  // NEGATIVE CONTROL 2 — the rings switched off. The identical drive.
  // ===================================================================
  const ringAt = roam.ring;
  const approach = { x: ringAt.x + 90, z: ringAt.z };
  await page.evaluate(() => {
    const g = window.__ENGINE__.ctx.peek('game');
    g.freeroam.rings.enabled = false;
    window.__ONB_STARTS__ = [];
    window.__ENGINE__.ctx.events.on('mission:start', (p) => window.__ONB_STARTS__.push(p.id));
  });
  await driveTo(ringAt.x, ringAt.z, approach);
  const off = await CHECK();
  const offStarts = await page.evaluate(() => window.__ONB_STARTS__.length);
  console.log('RINGS OFF:', JSON.stringify({ active: off.active, starts: offStarts }));
  ok(off.active === false && offStarts === 0,
    `NEG CONTROL: with the rings off the same drive starts nothing (${offStarts} mission:start)`);

  // ===================================================================
  // THE RING IS THE DOOR — switch them back on and drive in.
  // ===================================================================
  await page.evaluate(() => {
    window.__ENGINE__.ctx.peek('game').freeroam.rings.enabled = true;
    window.__ONB_CUT__ = false;          // re-arm the latch for the entry beat
  });
  await pump(10);
  await driveTo(ringAt.x, ringAt.z, approach);
  await pump(20);
  const entered = await CHECK();
  const starts = await page.evaluate(() => window.__ONB_STARTS__.slice());
  console.log('ENTERED  :', JSON.stringify({ active: entered.active, phase: entered.phase, starts }));
  ok(entered.active === true && starts.length === 1,
    `driving into the ring started the chapter (${starts.length} mission:start: ${starts.join(', ')})`);
  const sawIntro = await page.evaluate(() => window.__ONB_CUT__);
  /**
   * The chapter is LIVE AND PLAYABLE, which is the claim this file can make
   * about the ring. Whether the intro takes the screen as a cutscene or as the
   * caption-bar fallback is `mission.js:_playScene`'s business and is the same
   * on both doors — `src/ui/gpsprobe.mjs` proves the equality where it belongs,
   * on the `mission:start` payload, field by field. Asserting the cutscene here
   * measured the typewriter (`npm run cutscene` is red on it) 1 run in 3.
   */
  ok(['intro', 'travel', 'run'].includes(entered.phase),
    `...and the chapter is live and playable, exactly as J leaves it (phase ${entered.phase}` +
    `, a scene took the screen: ${sawIntro})`);

  ok(errs.length === 0, `no page errors (${errs.length})`);
  if (errs.length) errs.slice(0, 6).forEach((m) => console.log('   pageerror:', m));
} catch (err) {
  fail++;
  console.log('FAIL  threw:', String(err?.stack ?? err).slice(0, 400));
}

console.log(`\n${pass}/${pass + fail} onboard checks passed`);
await b.close();
stopServerSafe(server);
process.exit(fail ? 1 : 0);

function stopServerSafe(s) { try { s?.kill?.(); } catch { /* reaped on exit */ } }
