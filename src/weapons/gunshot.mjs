#!/usr/bin/env node
/**
 * GUNSHOT — photograph a weapon IN THE GAME, in a character's hands.
 *
 * ---------------------------------------------------------------------------
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * There are two ways to look at a weapon in this project and until now neither
 * of them was the one that matters.
 *
 *   `src/weapons/shoot.mjs`   photographs the MODEL on a studio rig. Perfect for
 *                             chamfers, wear masks and material separation, and
 *                             it tells you nothing about the thing the player
 *                             sees, because the player never gets closer to a
 *                             weapon than two and a half metres and never sees
 *                             it without a hand wrapped round it.
 *   `tools/capture.mjs`       photographs the CITY. Its three weapon shots
 *                             (`weapon`, `ads`, `muzzle`) were inherited from a
 *                             first-person game and deleted with the viewmodel;
 *                             `character` frames a brother but takes whatever
 *                             happens to be in his hands.
 *
 * `weapons.debugPose(id, { mode })` has staged an over-the-shoulder review
 * frame all along — `_applyPoseCamera` composes it and re-applies it every
 * `lateUpdate` so the character can keep breathing under it. Nothing had a way
 * to press the shutter on it. This is that shutter.
 *
 *   node src/weapons/gunshot.mjs --w=pistol --mode=ads   --out=/tmp/p.png
 *   node src/weapons/gunshot.mjs --w=shotgun --mode=fire --out=/tmp/s.png
 *   node src/weapons/gunshot.mjs --w=shotgun --mode=idle --brother=carson
 *
 * modes: idle (hip carry) · ads (shouldered) · fire (mid-recoil, flash lit)
 *
 * `--brother` stages the man who owns it first, because `update` polls the save
 * twice a second and puts `loadout[0]` back in the hands of anyone holding
 * something he does not carry — the same staging rule `arsenalprobe.mjs`
 * documents at length, and the reason its `viewmodel` group exists.
 *
 * Dev tool. Nothing in the game imports it and it asserts nothing; it is a
 * camera, and the acceptance criterion is a human looking at the frame.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { startServer } from '../../tools/lib/server.mjs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const WEAPON = String(args.w ?? 'pistol');
const MODE = String(args.mode ?? 'ads');
const BROTHER = args.brother ? String(args.brother) : null;
const OUT = resolve(String(args.out ?? `/tmp/gun-${WEAPON}-${MODE}.png`));
const W = Number(args.width ?? 1600);
const H = Number(args.height ?? 900);
/* The pose is frozen, but the CITY behind it is streamed and the exposure,
 * TAA and GTAO histories are temporal. 150 frames is where all three stop
 * moving on this shot; fewer photographs a half-built street. */
const SETTLE = Number(args.settle ?? 150);

const { port, server } = await startServer({ explicitPort: args.port });
const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') logs.push(`[console] ${m.text().slice(0, 200)}`); });

let failed = null;
try {
  await page.goto(`http://127.0.0.1:${port}/?capture=1`, {
    waitUntil: 'domcontentloaded', timeout: 180000,
  });
  await page.waitForFunction('window.__READY__===true', null, { timeout: 420000 });

  const pump = (n) =>
    page.evaluate((k) => new Promise((d) => {
      let i = 0;
      const t = () => (++i >= k ? d() : requestAnimationFrame(t));
      requestAnimationFrame(t);
    }), n);

  await pump(60);
  const staged = await page.evaluate(({ wid, mode, boy, grab }) => {
    const wp = window.__ENGINE__.ctx.peek('weapons');
    /* Unlock first: a fresh save owns four weapons and `debugPose` force-equips
     * through `setWeaponImmediate`, but the ownership poll would still take a
     * chapter reward straight back out of his hands. */
    wp.unlockEverything();
    if (boy) wp.setBrother(boy, true);
    wp.debugPose('idle');
    wp.debugPose(wid, { mode, grabFrame: grab });
    return { id: wp.rig?.active?.id ?? null, brother: wp.brotherId, name: wp.labelFor(wid) };
  }, { wid: WEAPON, mode: MODE, boy: BROTHER, grab: SETTLE });

  await pump(SETTLE);
  const held = await page.evaluate(() => {
    const wp = window.__ENGINE__.ctx.peek('weapons');
    return wp.rig?.active?.id ?? null;
  });

  mkdirSync(dirname(OUT), { recursive: true });
  await page.screenshot({ path: OUT, type: 'png' });
  console.log(JSON.stringify({
    ok: held === WEAPON, out: OUT, weapon: WEAPON, mode: MODE,
    staged: staged.id, heldAtShutter: held, brother: staged.brother, name: staged.name,
  }, null, 2));
} catch (e) {
  failed = e;
}
if (logs.length) console.error(logs.slice(0, 12).join('\n'));
await browser.close();
server?.kill();
if (failed) {
  console.error(JSON.stringify({ ok: false, error: String(failed.message).slice(0, 300) }));
  process.exit(1);
}
