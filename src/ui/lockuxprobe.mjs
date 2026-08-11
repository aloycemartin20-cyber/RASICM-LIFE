#!/usr/bin/env node
/**
 * LOCK-UX PROBE — pointer lock must never steal the mouse from the UI.
 *
 *   npm run build && node src/ui/lockuxprobe.mjs
 *
 * ---------------------------------------------------------------------------
 * THE TWO BUGS THIS GATES (one root cause: input.js grabbed pointer lock on
 * ANY left click while unlocked, and `menu.close()` re-grabbed it on the way
 * back to the game):
 *
 *   1. The CHEATS button is unreachable while playing on desktop — the pointer
 *      is locked, so the cursor cannot get to it. FIX: on desktop the button is
 *      shown only on the pause overlay, where the mouse is free.
 *   2. Clicking Story from the pause menu grabbed the lock, so the story
 *      overview opened with a captured, invisible cursor and "Let's Ride" was
 *      dead until you pressed ESC. FIX: a click on a UI element never grabs the
 *      lock (input.js checks the mousedown target), and no lock is grabbed
 *      while `ui.isPaused()` (the pause guard `ui` installs on `input`).
 *   3. THE OTHER HALF OF THE SAME DOOR: nothing ever gave the lock BACK.
 *      `ui._syncPause` released it on the rising edge of "an overlay needs the
 *      cursor" and had no falling edge, so after every cutscene, every result
 *      card and every map the camera was dead until the player clicked the
 *      world — and `Input._onMouseDown` pushed `Mouse0` on that very click, so
 *      restoring mouse-look fired a round. FIX: the falling edge re-requests
 *      the lock, and the click that asks for it no longer queues a trigger
 *      pull. Both are gated below, each with a negative control.
 *
 * NOTE ON WHAT CHANGED IN THIS FILE. "Let's Ride returns to a running game with
 * NO pointer lock" used to be an assertion here and is now inverted: the lock
 * coming back on its own IS the fix for bug 3. That is not rule 13 — the
 * threshold did not move to make a run go green, the requirement changed, and a
 * probe still asserting the old shape would pin the build to the defect.
 *
 * ---------------------------------------------------------------------------
 * WHY IT SHIMS THE BROWSER
 * ---------------------------------------------------------------------------
 * Headless Chromium NEVER grants pointer lock: `document.pointerLockElement`
 * stays null forever, with every flag, after a real gesture (see the header of
 * `src/ui/pauseprobe.mjs`). The entire bug lives in the pointer-lock path, so a
 * faithful model of the two behaviours a real browser has and headless omits is
 * installed before any page script: `requestPointerLock()` actually succeeds
 * (asynchronously, firing `pointerlockchange`), and a human click holds ~90 ms
 * between mousedown and mouseup so a lock acquired mid-click steals the rest of
 * it — the exact timing that is the whole bug.
 *
 * WHAT IS MEASURED, NOT ASSUMED (rule 12): the EMITTED lock state — grant count
 * off the model and `document.pointerLockElement` — and the RENDERED button
 * `display`, never the `ui` flags the code set. Every fix carries a NEGATIVE
 * CONTROL run against the LIVE code: the pause guard is nulled and the same
 * Story transition then DOES grab the lock; the mousedown target gate is fed a
 * canvas target and DOES lock, a non-canvas target and does NOT. A gate that
 * cannot be made to fail is decorative.
 *
 * WHAT CANNOT BE AUTOMATED HERE: that a real Chrome, having grabbed the lock,
 * hides the cursor and starts eating Escape — headless does neither, which is
 * why the model exists. The model reproduces the click-theft timing and the
 * grant/exit bookkeeping; the human-perceived "cursor is gone" is reasoned
 * about, not screenshotted.
 */
import { chromium } from 'playwright';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('='))
);

/* ------------------------------------------------------------------ shim -- */

/** A working model of Chrome's pointer lock (see pauseprobe.mjs for the why). */
function installPointerLockModel() {
  let lockEl = null;
  const fire = () => document.dispatchEvent(new Event('pointerlockchange', { bubbles: true }));

  Object.defineProperty(Document.prototype, 'pointerLockElement', {
    configurable: true,
    get: () => lockEl,
  });

  Element.prototype.requestPointerLock = function requestPointerLock() {
    return new Promise((resolve) => {
      setTimeout(() => {
        lockEl = this;
        window.__LOCK__.grants++;
        fire();
        resolve();
      }, 8);
    });
  };

  Document.prototype.exitPointerLock = function exitPointerLock() {
    if (!lockEl) return;
    lockEl = null;
    window.__LOCK__.exits++;
    fire();
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.__LOCK__ = {
    grants: 0,
    exits: 0,
    get locked() { return !!lockEl; },
    escape() {
      if (!lockEl) return false;
      lockEl = null;
      window.__LOCK__.exits++;
      fire();
      return true;
    },
  };

  /** A human click: press, hold ~90 ms, release. Models lock retargeting. */
  window.__CLICK__ = async (x, y, holdMs = 90) => {
    const target = document.elementFromPoint(x, y);
    if (!target) return { error: 'nothing at ' + x + ',' + y };
    const name = (el) => (el ? (el.className || el.tagName) : 'null');
    const mk = (type, el) => el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, button: 0, buttons: type === 'mouseup' ? 0 : 1,
    }));
    mk('mousedown', target);
    await sleep(holdMs);
    const dest = lockEl ?? target;
    mk('mouseup', dest);
    mk('click', dest);
    return { target: name(target), landedOn: name(dest), stolen: dest !== target, lockAfter: !!lockEl };
  };
}

/* ------------------------------------------------------------------ probe -- */

const { port, server } = await startServer({ explicitPort: args.port });
const b = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});

const results = [];
const rec = (area, name, ok, detail) => results.push({ area, name, ok, detail: detail ?? '' });
let page;

const pump = (n) =>
  page.evaluate(
    (k) => new Promise((d) => { let i = 0; const t = () => (++i >= k ? d() : requestAnimationFrame(t)); requestAnimationFrame(t); }),
    n
  );

/** Human-click an element centre; null (element missing / display:none) is not
 *  a crash — it is a failed target, reported so the negative control reads as a
 *  clean FAIL rather than aborting the whole run. */
const clickCentre = async (at) =>
  at ? page.evaluate(([x, y]) => window.__CLICK__(x, y), at)
    : { missing: true, stolen: false, lockAfter: false };

/** Centre of an element found by a DOM query, in client px, or null. */
const centreOf = (sel, textRe) =>
  page.evaluate(([s, re]) => {
    const els = [...document.querySelectorAll(s)];
    const el = re ? els.find((e) => new RegExp(re, 'i').test(e.textContent || '')) : els[0];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  }, [sel, textRe ? textRe.source : null]);

/** Everything about the current lock / overlay / button state, measured. */
const snap = () =>
  page.evaluate(() => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    const btn = ui.cheats?.btn ?? null;
    return {
      locked: !!document.pointerLockElement,
      grants: window.__LOCK__.grants,
      menu: !!ui.menu?.open,
      cheatsOpen: !!ui.cheats?.open,
      storyOpen: !!ui.story?.open,
      paused: !!ui.isPaused?.(),
      scale: e.time.scale,
      elapsed: +e.time.elapsed.toFixed(3),
      touchActive: !!ui.touch?.active,
      btnDisplay: btn ? getComputedStyle(btn).display : 'no-button',
      guard: typeof e.input.pointerLockGuard === 'function',
    };
  });

/** Does the world actually tick? Measured off the clock, not a flag. */
const simRuns = async () => {
  const a = (await snap()).elapsed;
  await pump(24);
  const c = (await snap()).elapsed;
  return { ran: c > a + 0.02, from: a, to: c };
};

async function bootPage(label, viewport, touch) {
  page = await b.newPage({ viewport, hasTouch: touch, isMobile: touch });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message).slice(0, 160)));
  await page.addInitScript(installPointerLockModel);
  if (touch) await page.addInitScript(() => { window.__FORCE_TOUCH__ = true; });
  await page.goto(`http://127.0.0.1:${port}/?cheats=1&boot=0&q=low&prewarm=0`,
    { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 180000 });
  await pump(60);
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    e.input.enabled = true; e.input.frozen = false;
    e.ctx.peek('player')?.setControlEnabled?.(true);
  });
  await pump(12);
  return errs;
}

/* ---- DESKTOP: the whole story, with negative controls --------------------- */

async function runDesktop() {
  const label = 'desktop';
  const errs = await bootPage(label, { width: 1280, height: 720 }, false);

  rec(label, 'the cheat button exists under ?cheats=1', (await snap()).btnDisplay !== 'no-button');

  // --- micro-test: the mousedown TARGET gate, in isolation ----------------
  // Unlocked, before any world click. Spy: replace the lock request with a
  // counter so we read exactly whether `_onMouseDown` asked for it, then feed
  // it a canvas target and a non-canvas target. This exercises the
  // `e.target === canvas` line in input.js and nothing else.
  const gate = await page.evaluate(() => {
    const e = window.__ENGINE__;
    const input = e.input;
    input.enabled = true; input.pointerLocked = false;
    let calls = 0;
    const spy = () => { calls++; };
    input.requestPointerLock = spy;                    // own-property shadow
    const md = (t) => t.dispatchEvent(new MouseEvent('mousedown',
      { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
    // Non-canvas target (the <html> element: reaches window, target !== canvas).
    calls = 0; md(document.documentElement); const ui = calls;
    // Canvas target (an empty-world click resolves here): must ask for the lock.
    calls = 0; md(input.canvas); const world = calls;
    delete input.requestPointerLock;                   // restore the prototype method
    return { ui, world };
  });
  rec(label, 'a mousedown on a NON-canvas target does not ask for pointer lock',
    gate.ui === 0, `requestPointerLock calls ${gate.ui}`);
  rec(label, 'NEG CONTROL: a mousedown on the canvas DOES ask for pointer lock',
    gate.world === 1, `requestPointerLock calls ${gate.world}`);

  /**
   * --- micro-test: the click that restores mouse-look does not fire ---------
   * MEASURED on the EMITTED EDGE — `input._pendingDown`, the set `beginFrame`
   * turns into `firePressed` and `weapons` turns into a round — not on a flag
   * saying we meant to swallow it.
   *
   * `requestPointerLock` is shadowed by a stub that RETURNS TRUE and grants
   * nothing, which is the browser's "request accepted, grant later" contract
   * without the async grant landing mid-probe and dragging the page state with
   * it. Naming the stub's assertion (rule 12): everything downstream of the
   * request — whether Chrome actually grants it — is proven by the world click
   * two checks below, which locks for real through the model.
   *
   * Three arms, and the second two are why the first means anything:
   *   relock  unlocked, in a browser that HAS granted a lock -> swallowed
   *   virgin  unlocked, in a browser that never grants (headless, an embed,
   *           a denied permission) -> NOT swallowed, or the fire button is
   *           dead for ever
   *   playing already locked -> NOT swallowed; this is an ordinary trigger
   */
  const swallow = await page.evaluate(() => {
    const input = window.__ENGINE__.input;
    const saved = { works: input.pointerLockWorks, locked: input.pointerLocked };
    input.requestPointerLock = () => true;             // own-property shadow
    const arm = (locked, works) => {
      input.pointerLocked = locked;
      input.pointerLockWorks = works;
      input._pendingDown.clear();
      input.canvas.dispatchEvent(new MouseEvent('mousedown',
        { bubbles: true, cancelable: true, button: 0, buttons: 1 }));
      const queued = input._pendingDown.has('Mouse0');
      input._pendingDown.clear();
      return queued;
    };
    const out = { relock: arm(false, true), virgin: arm(false, false), playing: arm(true, true) };
    delete input.requestPointerLock;                   // back to the prototype
    input.pointerLocked = saved.locked;
    input.pointerLockWorks = saved.works;
    return out;
  });
  rec(label, 'the click that restores mouse-look does not also pull the trigger',
    swallow.relock === false, `Mouse0 queued ${swallow.relock}`);
  rec(label, 'NEG CONTROL: where the browser never grants a lock, the click DOES fire',
    swallow.virgin === true, `Mouse0 queued ${swallow.virgin}`);
  rec(label, 'NEG CONTROL: a click while already locked is an ordinary trigger pull',
    swallow.playing === true, `Mouse0 queued ${swallow.playing}`);

  // --- click into the world: now we are playing, pointer locked -----------
  await page.evaluate(() => window.__CLICK__(innerWidth / 2, innerHeight / 2));
  await pump(20);
  const playing = await snap();
  rec(label, 'clicking the world locks the pointer', playing.locked,
    `locked ${playing.locked}, grants ${playing.grants}`);
  rec(label, 'the cheat button is HIDDEN while playing (cursor cannot reach it)',
    playing.btnDisplay === 'none', `display ${playing.btnDisplay}, locked ${playing.locked}`);

  // --- open the pause menu: mouse is free, button must appear -------------
  await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').menu.show());
  await pump(6);
  const onMenu = await snap();
  rec(label, 'the cheat button APPEARS on the pause overlay', onMenu.btnDisplay !== 'none',
    `display ${onMenu.btnDisplay}, menu ${onMenu.menu}`);
  rec(label, 'the pause overlay is not pointer-locked', !onMenu.locked,
    `locked ${onMenu.locked}`);

  // --- clicking the cheat button opens the panel, grabs NO lock -----------
  const btnAt = await centreOf('.ow-cheat-btn');
  const btnClick = await clickCentre(btnAt);
  await pump(10);
  const panel = await snap();
  rec(label, 'the cheat-button click is not stolen by a pointer-lock grab', !btnClick.stolen,
    `pressed "${btnClick.target}", released on "${btnClick.landedOn}"`);
  rec(label, 'clicking the cheat button opens the panel and takes the menu down',
    panel.cheatsOpen && !panel.menu, `cheats ${panel.cheatsOpen}, menu ${panel.menu}`);
  rec(label, 'opening the cheat panel does not lock the pointer', !panel.locked,
    `locked ${panel.locked}`);
  // ESC out of the panel, back to the game.
  await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').cheats.hide());
  await pump(10);

  // --- the menu -> Story -> chapter path, seamless ------------------------
  // Re-lock by clicking the world, then open the menu the real way (ESC eaten
  // by the browser while locked, as it arrives in a real session).
  await page.evaluate(() => window.__CLICK__(innerWidth / 2, innerHeight / 2));
  await pump(16);
  // The player presses Escape. While locked the browser EATS the key to exit
  // the lock (that lost lock is what opens the menu); only when unlocked does a
  // real Escape reach the page. Pressing both would toggle the menu shut again.
  const eaten = await page.evaluate(() => window.__LOCK__.escape());
  if (!eaten) await page.keyboard.press('Escape');
  await pump(16);
  const beforeStory = await snap();
  rec(label, 'ESC opens the pause menu', beforeStory.menu, `menu ${beforeStory.menu}`);

  const storyAt = await centreOf('.ow-menu .ow-btn', /story/);
  const grantsBefore = beforeStory.grants;
  const storyClick = await clickCentre(storyAt);
  await pump(20);
  const inStory = await snap();
  rec(label, 'clicking Story is not stolen by a pointer-lock grab', !storyClick.stolen,
    `pressed "${storyClick.target}", released on "${storyClick.landedOn}"`);
  rec(label, 'Story opens the overview and closes the menu',
    inStory.storyOpen && !inStory.menu, `story ${inStory.storyOpen}, menu ${inStory.menu}`);
  rec(label, 'the menu -> Story transition grabs NO pointer lock',
    !inStory.locked && inStory.grants === grantsBefore,
    `locked ${inStory.locked}, grants ${grantsBefore} -> ${inStory.grants}`);

  // "Let's Ride" returns to a RUNNING free-roam game — and to mouse-look. The
  // click must not be stolen on the way (bug 2) and the camera must be live on
  // arrival without a second click (bug 3); this one transition is where the
  // two requirements meet, which is why it asserts both.
  const rideAt = await centreOf('.ow-story .ow-btn.primary', /ride/);
  const rideClick = await clickCentre(rideAt);
  await pump(16);
  const back = await snap();
  const ran = await simRuns();
  rec(label, "Let's Ride returns to a running game WITH mouse-look, no second click",
    !!rideClick && !rideClick.stolen && !back.storyOpen && !back.menu && back.locked && ran.ran,
    `stolen ${rideClick?.stolen}, story ${back.storyOpen}, locked ${back.locked}, elapsed ${ran.from} -> ${ran.to}`);

  // A chapter row is also a live, clickable target that grabs no lock. Starting
  // a chapter may open a mission intro (a cutscene legitimately freezes the sim
  // — that is "reaching the game", not free roam), so the assertion is only that
  // the click is seamless and never locks the mouse, then we abort back out.
  await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').openStory());
  await pump(10);
  const chapterAt = await centreOf('.ow-story-row.playable');
  if (chapterAt) {
    const chapClick = await clickCentre(chapterAt);
    await pump(16);
    const afterChap = await snap();
    rec(label, 'a chapter row is clickable without a mouse-lock dance',
      !chapClick.stolen && !afterChap.locked,
      `stolen ${chapClick.stolen}, locked ${afterChap.locked}`);
    // Clean up: drop any mission the chapter started and close the overview.
    await page.evaluate(() => {
      const ui = window.__ENGINE__.ctx.peek('ui');
      window.__ENGINE__.ctx.peek('game')?.abortMission?.();
      ui.closeStory();
    });
    await pump(10);
  } else {
    rec(label, 'a chapter row is clickable without a mouse-lock dance', false,
      'no playable chapter row rendered');
  }

  /* --- the falling edge, through the real overlay path ---------------------
   * NOT ONE CLICK IS ISSUED IN THIS BLOCK. The map goes up and comes down
   * through `ui`'s own methods, and the lock has to come back from
   * `_syncPause` alone — which is the whole of bug 3. Measured on the model's
   * grant counter and `document.pointerLockElement`, never on a `ui` flag.
   */
  // Back to free roam first, and PROVEN back: the chapter row above can leave a
  // mission intro running, and a live cutscene is itself a cursor-needing
  // overlay — so the transition below would not be a falling edge at all, and
  // the block would report a broken re-lock that is really a dirty fixture.
  await page.evaluate(() => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    e.ctx.peek('game')?.abortMission?.();
    ui.subs?.cut?.cancel?.();
    ui.closeStory();
    if (ui.map?.open) ui.closeMap();
    if (ui.phone?.open) ui.phone.hide();
    ui.menu.close();
    // The outcome card an aborted chapter leaves behind has no hide(): it
    // retires on its own life timer. Run the timer out rather than reaching
    // past the retire path, so the fixture leaves by the door the game uses.
    if (ui.bigCard?.active) ui.bigCard.t = ui.bigCard.life;
  });
  await pump(20);
  const calm = await page.evaluate(() => {
    const ui = window.__ENGINE__.ctx.peek('ui');
    return {
      paused: !!ui.isPaused?.(), cut: !!ui.subs?.cut?.active,
      hard: ui._hardModal(), card: !!ui.bigCard?.active,
    };
  });
  rec(label, 'the fixture is back in free roam before the falling-edge case',
    !calm.paused && !calm.cut && !calm.hard && !calm.card,
    `paused ${calm.paused}, cut ${calm.cut}, hard modal ${calm.hard ?? 'none'}, card ${calm.card}`);

  const mapUp = await page.evaluate(async () => {
    const ui = window.__ENGINE__.ctx.peek('ui');
    ui.openMap();
    await new Promise((r) => setTimeout(r, 40));
    return { locked: !!document.pointerLockElement, grants: window.__LOCK__.grants };
  });
  await pump(8);
  rec(label, 'an overlay takes the cursor back off mouse-look', !mapUp.locked,
    `locked ${mapUp.locked}`);
  await page.evaluate(() => window.__ENGINE__.ctx.peek('ui').closeMap());
  await pump(20);
  const mapDown = await snap();
  rec(label, 'closing the last overlay hands mouse-look back with NO click',
    mapDown.locked && mapDown.grants > mapUp.grants,
    `locked ${mapDown.locked}, grants ${mapUp.grants} -> ${mapDown.grants}`);

  // NEG CONTROL 1: with the re-request removed, the same close leaves the
  // camera dead — the shipped behaviour this replaces.
  const noRegrab = await page.evaluate(async () => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    const saved = e.input.requestPointerLock;
    e.input.requestPointerLock = () => false;          // remove the fix
    ui.openMap();
    await new Promise((r) => setTimeout(r, 60));
    ui.closeMap();
    await new Promise((r) => setTimeout(r, 60));
    const locked = !!document.pointerLockElement;
    e.input.requestPointerLock = saved;
    return { locked };
  });
  await pump(16);
  rec(label, 'NEG CONTROL: with the re-request removed, the map leaves mouse-look dead',
    !noRegrab.locked, `locked-with-fix-off ${noRegrab.locked}`);

  // NEG CONTROL 2: it is the LAST overlay that hands the lock back, not any
  // overlay. With the menu still up, closing the map must leave the cursor
  // free — otherwise the fix would re-capture the mouse over a live menu,
  // which is bug 2 arriving from the other side.
  const stacked = await page.evaluate(async () => {
    const ui = window.__ENGINE__.ctx.peek('ui');
    ui.menu.show();
    ui.openMap();
    await new Promise((r) => setTimeout(r, 40));
    ui.closeMap();
    await new Promise((r) => setTimeout(r, 60));
    const underMenu = !!document.pointerLockElement;
    ui.menu.close();
    await new Promise((r) => setTimeout(r, 60));
    return { underMenu, afterMenu: !!document.pointerLockElement };
  });
  await pump(16);
  rec(label, 'closing one overlay under another keeps the cursor free',
    !stacked.underMenu, `locked with the menu still up ${stacked.underMenu}`);
  rec(label, 'and the last one out re-locks',
    stacked.afterMenu, `locked after the menu closed ${stacked.afterMenu}`);

  // --- NEGATIVE CONTROL for the pause guard -------------------------------
  // With the guard nulled, the SAME Story transition DOES grab the lock. This
  // proves the guard is the code path that gates the behaviour, not the harness.
  // There are TWO complementary fixes and the bug returns only if BOTH are
  // disabled: `pointerLockGuard` refuses a NEW grab while paused (the grab that
  // menu.close() re-requests here), and `input.exitPointerLock()` — called from
  // ui._syncPause when a cursor-needing overlay comes up — releases the lock the
  // player already held. Disable either alone and the other still frees the
  // cursor, which is the point; disable both to reproduce the original trap.
  const neg = await page.evaluate(async () => {
    const e = window.__ENGINE__;
    const ui = e.ctx.peek('ui');
    const savedGuard = e.input.pointerLockGuard;
    const savedExit = e.input.exitPointerLock;
    e.input.pointerLockGuard = null;                   // remove fix #1
    e.input.exitPointerLock = () => {};                // remove fix #2
    ui.menu.show();
    await new Promise((r) => setTimeout(r, 30));
    ui.openStory();                                    // menu -> story, the trap path
    ui.menu.close();                                   // close() re-requests the lock
    await new Promise((r) => setTimeout(r, 60));       // let the async grant land
    const locked = !!document.pointerLockElement;
    // clean up: release lock, restore both fixes, resume
    document.exitPointerLock?.();
    ui.closeStory();
    e.input.pointerLockGuard = savedGuard;
    e.input.exitPointerLock = savedExit;
    return { locked };
  });
  await pump(10);
  rec(label, 'NEG CONTROL: with BOTH pointer-lock fixes removed, Story DOES grab the lock',
    neg.locked, `locked-with-fixes-off ${neg.locked}`);

  rec(label, 'no page errors', errs.length === 0, [...new Set(errs)].slice(0, 3).join(' | '));
  await page.close();
}

/* ---- TOUCH: the negative control for the whole button-visibility fix ------ */

async function runTouch() {
  const label = 'touch';
  const errs = await bootPage(label, { width: 390, height: 844 }, true);
  const s = await snap();
  rec(label, 'touch controls are active on a phone profile', s.touchActive,
    `touch.active ${s.touchActive}`);
  // The negative control for bug #1: the SAME cheat-button code shows the button
  // during free roam on touch (no pointer lock to hide it from), where desktop
  // hides it. If both hid it or both showed it, the platform gate would be dead.
  rec(label, 'NEG CONTROL: on touch the cheat button is VISIBLE while playing',
    s.btnDisplay !== 'none' && s.btnDisplay !== 'no-button',
    `display ${s.btnDisplay}, menu ${s.menu}`);
  rec(label, 'no page errors', errs.length === 0, [...new Set(errs)].slice(0, 3).join(' | '));
  await page.close();
}

try {
  await runDesktop();
  await runTouch();

  const pass = results.filter((r) => r.ok).length;
  const w = Math.max(...results.map((r) => r.name.length));
  let area = '';
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log(`\n--- ${area} ---`); }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`);
  }
  console.log(`\n${pass}/${results.length} lock-UX behaviours working`);
  if (pass !== results.length) process.exitCode = 1;
} catch (e) {
  console.error('lockuxprobe failed:', e.message, e.stack);
  process.exitCode = 1;
} finally {
  await b.close();
  server?.kill();
}
