#!/usr/bin/env node
/**
 * Dump the baked face atlas for each brother as a PNG, straight off the canvas
 * the material is bound to.
 *
 * A face atlas is the one texture in the project you cannot judge on the model:
 * it is painted in the skull's (phi, theta), so a feature that lands 5% out is
 * a mouth on a chin, and on a 120 px head at play distance that reads as "a
 * smudge" rather than as "misregistered". `headprobe.mjs` gate 6 measures the
 * registration; this is how you LOOK at what was measured.
 *
 *   node src/player/character/atlasshot.mjs --out=/tmp/atlas
 *   node src/player/character/atlasshot.mjs --map=normal
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

const OUT = resolve(args.out ?? '/tmp/atlas');
const WHICH = args.map ?? 'map';
const BOYS = (args.boy ?? 'carson,aidan,dylan').split(',');

const portOpen = (p) =>
  new Promise((res) => {
    const s = net.connect({ port: p, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 200; i++) {
    const p = 5900 + Math.floor(Math.random() * 90);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port');
}

const PORT = await freePort();
const root = resolve(import.meta.dirname, '../../..');
const server = spawn(resolve(root, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
  cwd: root, stdio: 'ignore', env: { ...process.env, OW_NO_HMR: '1' },
});
for (let i = 0; i < 160; i++) {
  await new Promise((r) => setTimeout(r, 250));
  if (await portOpen(PORT)) break;
}

const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
mkdirSync(OUT, { recursive: true });
let failed = null;
try {
  for (const boy of BOYS) {
    await page.goto(`http://127.0.0.1:${PORT}/src/player/preview.html?boy=${boy}&pose=idle&view=face`, {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
    await page.waitForFunction('window.__PREVIEW_READY__ === true', null, { timeout: 60000 });
    const data = await page.evaluate((which) => {
      const rig = window.__PREVIEW__.rig;
      const tex = rig.textures.face[which];
      const src = tex.image;
      const c = document.createElement('canvas');
      c.width = src.width; c.height = src.height;
      c.getContext('2d').drawImage(src, 0, 0);
      return { url: c.toDataURL('image/png'), w: src.width, h: src.height };
    }, WHICH);
    writeFileSync(`${OUT}/${boy}-${WHICH}.png`, Buffer.from(data.url.split(',')[1], 'base64'));
    console.log(`${boy}: ${WHICH} ${data.w}x${data.h} -> ${OUT}/${boy}-${WHICH}.png`);
  }
} catch (e) {
  failed = e;
} finally {
  await browser.close();
  server.kill();
}
if (failed) { console.error(failed.message); process.exit(1); }
