#!/usr/bin/env node
/**
 * Measure the Old Blast Furnace's rust off the EMITTED FRAME.
 *
 * `wearColor` / `wearMaterial` on `metal_rust` are shader inputs; reading them
 * back would be comparing the code to its own input (ARCHITECTURE rule 12). So
 * this reads pixels out of `tools/capture.mjs --shot=mill --w=1280 --h=720`.
 *
 * THE NUMBER THAT MATTERS IS HUE, NOT BRIGHTNESS. Overcast haze and aerial
 * perspective move absolute level around freely at 60-90 m, but they cannot
 * make iron oxide cold: rust is r > g > b by a wide margin, and a light-neutral
 * wear layer collapses g and b together or puts b ABOVE g. `g-b` is therefore
 * the discriminator, and it is signed.
 *
 * Patches are fractions of the frame, so the numbers survive a resize:
 *
 *   band    the wear collar on the furnace shell — the worst of the defect
 *   stove   the hot-blast stove tops behind it
 *   mass    the whole furnace massing, for context
 *
 * Usage: node src/materials/millstat.mjs shots/mill.png [after.png ...]
 */
import { PNG } from 'pngjs';
import { readFileSync } from 'node:fs';

const PATCHES = {
  band: [0.484, 0.338, 0.533, 0.412],
  stove: [0.528, 0.478, 0.566, 0.531],
  mass: [0.440, 0.300, 0.688, 0.740],
};

function stat(png, [fx0, fy0, fx1, fy1]) {
  const x0 = Math.round(fx0 * png.width);
  const x1 = Math.round(fx1 * png.width);
  const y0 = Math.round(fy0 * png.height);
  const y1 = Math.round(fy1 * png.height);
  let n = 0, sr = 0, sg = 0, sb = 0, cold = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (png.width * y + x) << 2;
      const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
      n++;
      sr += r; sg += g; sb += b;
      if (b >= g) cold++;
    }
  }
  return { r: sr / n, g: sg / n, b: sb / n, cold: (100 * cold) / n };
}

for (const f of process.argv.slice(2)) {
  const png = PNG.sync.read(readFileSync(f));
  const lines = Object.entries(PATCHES).map(([k, box]) => {
    const s = stat(png, box);
    return `${k.padEnd(6)} rgb ${s.r.toFixed(1)},${s.g.toFixed(1)},${s.b.toFixed(1)}` +
      `  r-g ${(s.r - s.g).toFixed(1)}  g-b ${(s.g - s.b).toFixed(1)}` +
      `  cold(b>=g) ${s.cold.toFixed(1)}%`;
  });
  console.log(`${f.split('/').pop()}\n  ${lines.join('\n  ')}`);
}
