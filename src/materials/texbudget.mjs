#!/usr/bin/env node
/**
 * TEXTURE BUDGET — what the level actually baked, per bake, at a named shot.
 *
 *   node src/materials/texbudget.mjs --shot=mill
 *   node src/materials/texbudget.mjs --shot=mill --gate      exit 1 over the cap
 *   node src/materials/texbudget.mjs --shot=mill --json=/tmp/before.json
 *   node src/materials/texbudget.mjs --shot=mill --control   negative control
 *
 * WHY A SHOT AND NOT THE SPAWN POINT. Bakes are lazy: a surface costs nothing
 * until some tile asks for it. `src/materials/memcheck.mjs` boots the spawn
 * point, which is downtown, so it has never once photographed the mill — and
 * Steel Row is the worst level in the game for this, because the industrial
 * kit, the rust family and the landmark surfaces all land in one place. The
 * only number worth gating is the WORST level's, so this teleports to the shot
 * first and waits for streaming to drain before it reads the ledger.
 *
 * RULE 12 — what is measured is the EMITTED allocation, read out of the live
 * production build after streaming settles: `materials.textureReport()` for the
 * per-bake ledger and `renderer.info.memory.textures` as the INDEPENDENT
 * engine-side count. The ledger is the system's own arithmetic, so it is not
 * evidence on its own; three's texture count is counted by a different piece of
 * code from a different data structure, and the two have to move together.
 *
 * NEGATIVE CONTROL (`--control`): re-read the same scene at `?q=low`, where
 * `MaterialSystem._size()` halves every bake dimension. A real byte counter
 * must fall by roughly 4x; a counter that is really reporting a constant, a
 * library size, or a stale field cannot. The control is REPORTED, never gated —
 * it exists to prove the gated number is a measurement.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import net from 'node:net';

const ROOT = resolve(import.meta.dirname, '../..');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);
const SHOT = args.shot ?? 'mill';
const GATE = !!args.gate;
const CONTROL = !!args.control;
const TOP = Number(args.top ?? 18);

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 5900 + Math.floor(Math.random() * 600);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = await freePort();
const server = spawn(
  resolve(ROOT, 'node_modules/.bin/vite'),
  ['--port', String(PORT), '--strictPort'],
  { cwd: ROOT, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' } }
);
let up = false;
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await portOpen(PORT)) { up = true; break; }
}
if (!up) { server.kill(); throw new Error('vite failed to start'); }

const browser = await chromium.launch({
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu', '--mute-audio'],
});

/** Boot the build at `shot`, settle streaming, read the ledger back. */
async function measure(q) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pump = (n) =>
    page.evaluate(
      (k) =>
        window.__PUMP__
          ? window.__PUMP__(k)
          : new Promise((d) => {
              let i = 0;
              const t = () => (++i >= k ? d() : requestAnimationFrame(t));
              requestAnimationFrame(t);
            }),
      n
    );
  try {
    const url =
      `http://127.0.0.1:${PORT}/?capture=1&lockstep=1&shot=${encodeURIComponent(SHOT)}` +
      (q ? `&q=${q}` : '');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction('window.__READY__ === true', null, { timeout: 180000 });
    await page.evaluate(
      (s) => window.__APPLY_SHOT__?.(s, { grabFrame: 60 }),
      SHOT
    );
    // The shot teleports across a streamed city; the surfaces this is counting
    // are exactly the ones the new tiles are about to ask for, so reading
    // before the queue drains measures a half-built level.
    let frames = 0;
    let settled = false;
    while (frames < 1600) {
      if (await page.evaluate(() => window.__SETTLED__?.() === true)) { settled = true; break; }
      await pump(20);
      frames += 20;
    }
    await pump(60);
    const out = await page.evaluate(() => {
      const e = window.__ENGINE__;
      const m = e.ctx.peek('materials');
      const r = e.ctx.peek('render')?.renderer;
      return {
        report: m?.textureReport?.() ?? null,
        memory: m?.textureMemory ?? null,
        threeTextures: r?.info?.memory?.textures ?? null,
      };
    });
    out.settled = settled;
    out.frames = frames;
    return out;
  } finally {
    await page.close();
  }
}

let code = 0;
try {
  const main = await measure(null);
  const rep = main.report;
  if (!rep) throw new Error('no textureReport() — is materials built?');

  console.log(`shot ${SHOT}  streamed ${main.settled ? 'settled' : `NOT SETTLED (${main.frames}f)`}`);
  console.log(
    `BAKED ${rep.mib} MiB in ${rep.bakes} bakes for ${rep.materials} materials ` +
      `(soft cap ${rep.budgetMib} MiB) — three reports ${main.threeTextures} textures`
  );
  const shared = rep.rows.filter((r) => r.mats > 1);
  const savedMib = shared.reduce((s, r) => s + r.mib * (r.mats - 1), 0);
  console.log(
    `sharing: ${shared.length} bakes carry ${shared.reduce((s, r) => s + r.mats, 0)} materials ` +
      `— ${savedMib.toFixed(1)} MiB NOT spent on per-variant bakes`
  );
  console.log(`\n  ${'MiB'.padStart(7)}  ${'px'.padStart(5)}  ${'mats'.padStart(4)}  key`);
  for (const r of rep.rows.slice(0, TOP)) {
    console.log(
      `  ${r.mib.toFixed(2).padStart(7)}  ${String(r.px).padStart(5)}  ` +
        `${String(r.mats).padStart(4)}  ${r.key}`
    );
  }
  if (rep.rows.length > TOP) {
    const rest = rep.rows.slice(TOP).reduce((s, r) => s + r.mib, 0);
    console.log(`  ${rest.toFixed(2).padStart(7)}  ...    ${rep.rows.length - TOP} more`);
  }

  if (CONTROL) {
    const low = await measure('low');
    const ratio = low.report ? rep.mib / low.report.mib : 0;
    console.log(
      `\nNEGATIVE CONTROL q=low: ${low.report?.mib} MiB in ${low.report?.bakes} bakes ` +
        `(ratio ${ratio.toFixed(2)}x, expect ~4x if the counter is real)`
    );
    if (!(ratio > 2.5)) {
      console.log('CONTROL FAILED — the counter did not move with bake resolution');
      code = 1;
    }
  }

  if (args.json) {
    writeFileSync(String(args.json), JSON.stringify({ shot: SHOT, ...main }, null, 2));
    console.log(`\nwrote ${args.json}`);
  }

  if (GATE) {
    if (rep.over) {
      console.log(`\nFAIL: ${rep.mib} MiB over the ${rep.budgetMib} MiB soft cap`);
      code = 1;
    } else {
      console.log(`\nOK: ${rep.mib} MiB under the ${rep.budgetMib} MiB soft cap`);
    }
  }
} catch (e) {
  console.error(e.message);
  code = 1;
} finally {
  await browser.close();
  server.kill();
}
process.exit(code);
