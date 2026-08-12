#!/usr/bin/env node
/**
 * Capture the marketing set into `screenshots/`, and write its index.
 *
 *   node tools/screenshots.mjs              # all of them, 2560x1440
 *   node tools/screenshots.mjs --w=1920 --h=1080
 *   node tools/screenshots.mjs --only=mkt_skyline,mkt_mill_night
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS NOT `tools/shotset.mjs`
 *
 * `shotset` captures the REVIEW set: it covers the game, it is deliberately
 * repetitive, and it is framed to expose defects. This captures the MARKETING
 * set — the frames that go in the repo README — which has the opposite job.
 * Mixing them costs you both: a review set that flatters is useless, and a
 * marketing set chosen for coverage is why a critic panel said of ours that
 * "marketing could not cut a ten-second reel from this set".
 *
 * The shots live in `src/dev/shots.js` flagged `marketing: true`, with the
 * composition rules written beside them. They carry `hud: false`.
 *
 * Determinism comes free from `capture.mjs`: lockstep frames, a frozen sim at
 * the shutter, a re-pinned sky clock, a reset TAA jitter sequence, and a
 * work-budgeted (not wall-clock) streaming build. Two runs of an unchanged tree
 * produce byte-identical PNGs, so re-running this is a no-op unless the game
 * actually changed.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const ROOT = resolve(import.meta.dirname, '..');
const OUT = resolve(args.out ?? join(ROOT, 'screenshots'));
const W = Number(args.w ?? 2560);
const H = Number(args.h ?? 1440);

/**
 * The set and its captions, mirrored from `src/dev/shots.js`.
 *
 * Deliberately duplicated rather than imported: this file is a node script and
 * `shots.js` is browser module that pulls in three. The order here is the order
 * they appear in the README, which is an editorial decision and not the same as
 * the order they happen to be declared in.
 */
const SET = [
  ['mkt_skyline', 'Downtown from the Mt. Washington clifftop', 'The signature view: the Golden Triangle read across the Monongahela at golden hour.'],
  ['mkt_rain_street', 'Downtown in a storm', 'Wet asphalt, lit windows, and traffic that was deliberately left in.'],
  ['mkt_mill_night', 'The Old Blast Furnace', 'Slag orange against cold steel in river fog — the thematic heart of a rustbelt city.'],
  ['mkt_searchlight', 'Police searchlight', 'Five stars, and a helicopter sweeping the street below.'],
  ['mkt_bridge_dusk', 'A tied-arch bridge at last light', 'Three rivers and forty bridges, in one frame.'],
  ['mkt_incline', 'The Duquesne Incline at dawn', 'The funicular climbing out of river fog.'],
  ['mkt_point', 'The Point', 'Where three rivers meet.'],
  ['mkt_kessel', "Dylan's Kessel GT", 'A front-drive fastback — the fast brother\u2019s own car.'],
  ['mkt_hero', 'A Golden Triangle avenue', 'Clear afternoon light, at street level.'],

  /*
   * WAVE TWO — THE VERBS.
   *
   * The nine above photograph PLACES, and a critic reading them back could
   * not have told you what you do in this game. These eight are the verbs:
   * fly, chase, drive, fight, and go out on the water. Appended rather than
   * interleaved so the gallery reads as two deliberate movements — the city,
   * then what happens in it — and so the order of the original set, which was
   * an editorial decision, is left alone.
   */
  ['mkt_chase', 'Three stars, in the rain', 'A pursuit stacked up a downtown avenue at 21:20, every lightbar doubled by wet asphalt.'],
  ['mkt_boyzcars', "The brothers’ own cars", 'Carson’s 4Runner, Aidan’s pickup and Dylan’s Kessel, together outside the DeCarlo Body Shop.'],
  ['mkt_heli', 'Skywatch over downtown', 'The news helicopter banking across the Triangle at dusk.'],
  ['mkt_flight', 'Over the three rivers', 'A twin at two hundred metres, with the confluence and its bridges below the wing.'],
  ['mkt_afb', 'Ridgeline AFB', 'The flightline at golden hour — jets on the apron, armour behind them, hangars beyond.'],
  ['mkt_tanks', 'Armour on the apron', 'A Bulwark column in the dawn haze, at gun height.'],
  ['mkt_boat', 'A Riverjack on the Monongahela', 'Last light on the water, the Golden Triangle astern.'],
  ['mkt_fountain', 'The Point fountain', 'Where the Allegheny and the Monongahela become the Ohio.'],

  /*
   * WAVE THREE — WHAT THE CITY SAYS.
   *
   * The seventeen above are places and verbs, and a critic panel reading them
   * back found the same gap twice: "a signless, empty world". The signage
   * system answers it — shop names in real stroke type, channel letters, blade
   * signs, neon, lamp banners, street plates — and not one frame in the set was
   * standing close enough to a shopfront to show it. This one is, and it is on
   * the street the middle brother's whole arc is fought over.
   */
  ['mkt_butler', 'Butler Street at lighting-up time', 'Aidan outside his own body shop, its sign lit — every word in this city is geometry, not a texture.'],
];

const only = args.only ? String(args.only).split(',').map((s) => s.trim()) : null;
const shots = only ? SET.filter(([id]) => only.includes(id)) : SET;

mkdirSync(OUT, { recursive: true });

const done = [];
const failed = [];
/**
 * Shots that ASKED for a rotor and did not get one — see `spool` below.
 * Reported at the end rather than per shot, because it is a property of the
 * tree the set was captured from, not of any one frame.
 */
const unspooled = [];
for (const [id, title, caption] of shots) {
  const out = join(OUT, `${id.replace(/^mkt_/, '')}.png`);
  process.stdout.write(`  ${id} ... `);
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(ROOT, 'tools/capture.mjs'), `--shot=${id}`, `--out=${out}`, `--w=${W}`, `--h=${H}`],
      { stdio: 'pipe', cwd: ROOT }
    );
    const kb = existsSync(out) ? Math.round(statSync(out).size / 1024) : 0;
    // A frame that renders as a flat colour compresses to almost nothing. That
    // is the cheapest possible check that the shutter caught a real image, and
    // it has caught a black frame in this project before.
    if (kb < 80) throw new Error(`suspiciously small (${kb} KB) — probably a blank frame`);
    /**
     * DID THE ROTOR TURN?
     *
     * The two aircraft frames stage a KINEMATIC machine, which is never handed
     * to `stepPlane` / `stepHeli`, so the governor never spools and the blades
     * are a hand-set pose (`shots.js:stageKinematic`). They now ask
     * `vehicles.debugSpool` for a real one and carry on without it if that door
     * is not on this tree yet — `shots.js:spoolStaged` — and the answer rides
     * out on the capture's own render info: `null` this shot never asked,
     * `false` it asked and was skipped, `true` it ran.
     *
     * POLLED HERE, once per capture, because it is a per-tree fact that a
     * marketing frame can ship silently wrong: a helicopter photographed with a
     * parked disc is a model on a stand, and nothing else in this pipeline
     * would say so.
     */
    let spool = null;
    try {
      spool = JSON.parse(String(stdout))?.info?.spool ?? null;
    } catch {
      // capture printed something unparseable; the PNG is still the deliverable
    }
    if (spool === false) unspooled.push(id);
    console.log(`ok (${kb} KB)${spool === true ? ' · rotor spooled' : ''}${spool === false ? ' · rotor POSED (vehicles.debugSpool absent)' : ''}`);
    done.push([id, title, caption, `${id.replace(/^mkt_/, '')}.png`]);
  } catch (e) {
    console.log('FAILED');
    failed.push([id, String(e.message ?? e).split('\n')[0].slice(0, 140)]);
  }
}

const md = [
  '# Steel City — screenshots',
  '',
  '**DeCarlo Boyz** — an open-world game built in Three.js. Everything here is',
  'generated at runtime: no art files, no textures on disk, no CDN, no network.',
  'The city, its materials, its vehicles and its three brothers are all',
  'procedural, and the whole thing runs in a browser tab.',
  '',
  `Captured at ${W}x${H} by \`node tools/screenshots.mjs\`. The capture path is`,
  'deterministic — lockstep frames, a frozen simulation at the shutter and a',
  'work-budgeted streaming build — so two runs of an unchanged tree produce',
  'byte-identical images.',
  '',
];
for (const [, title, caption, file] of done) {
  md.push(`### ${title}`, '', `![${title}](${file})`, '', `*${caption}*`, '');
}
if (failed.length) {
  md.push('', '<!-- not captured this run:', ...failed.map(([id, why]) => `     ${id}: ${why}`), '-->', '');
}
writeFileSync(join(OUT, 'README.md'), md.join('\n'));

console.log(`\n${done.length}/${shots.length} captured into ${OUT}`);
if (unspooled.length) {
  console.log(
    `note: ${unspooled.join(', ')} asked for a spooled rotor and got the hand-set pose — ` +
    '`vehicles.debugSpool` is not on this tree. Re-run when it lands.'
  );
}
if (failed.length) {
  console.error('\nfailed:');
  for (const [id, why] of failed) console.error(`  ${id}  ${why}`);
  process.exit(1);
}
