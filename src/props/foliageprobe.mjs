#!/usr/bin/env node
/**
 * FOLIAGEPROBE — does the emitted canopy read as a tree, at leaf scale, at
 * every LOD tier, and does it have a surface for the light to land on?
 *
 * ---------------------------------------------------------------------------
 * THE THREE DEFECTS THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 * A critic panel scored the vegetation three ways and every one of them is a
 * measurable property of the geometry that comes out of `kit_green.js`:
 *
 *   1  "oversized flat leaf cards on the foreground tree, a quarter of the
 *      frame in cutout leaves at wrong scale" — CARD EXTENT. A card is a fan
 *      of triangles round one apex, so the emitted index buffer says exactly
 *      how big each one is without asking the emitter.
 *   2  "shrubs that render as unlit black blobs" — two causes, both in the
 *      vertex data. The shading normal has to lean OUT of the crown shell or
 *      every card is lit by wherever it happens to point and the mass has no
 *      top; and the AO mask cannot be authored for a 3 m crown interior and
 *      then applied to a 40 cm shrub that has no interior to speak of.
 *   3  "every tree past ~40 m is a bare armature" — CANOPY FILL at the far
 *      tier. Measured as the share of the crown's own silhouette box the leaf
 *      geometry covers, against the share the WOOD covers. A tier whose twigs
 *      out-cover its leaves is a bare armature by definition, whatever the
 *      card count says.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NOT CIRCULAR (rule 12)
 * ---------------------------------------------------------------------------
 * The probe never reads `SPECIES`, a `size`, a `bias` or a card count. It
 * registers the real kit through the real `registerGreen(K)` with a recording
 * stub for the prototype library, and then measures the `BufferGeometry` that
 * came out — positions, normals, the mask colour attribute and the index. Card
 * extents are reconstructed from the index buffer's own fan topology; the shell
 * alignment is the emitted normal dotted with the direction from the crown
 * CENTROID (computed from the emitted vertices), which is not a quantity the
 * emitter ever writes down.
 *
 * THE CONTROL. `--legacy` re-imports the kit with
 * `location.search = '?owLegacyCanopy=1'`, which restores the card normals
 * (no shell bias), the crown-interior AO on everything, and the old far tier.
 * `--gate` runs both and requires the control to fail.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *   node src/props/foliageprobe.mjs
 *   node src/props/foliageprobe.mjs --legacy
 *   node src/props/foliageprobe.mjs --gate
 *   node src/props/foliageprobe.mjs --json
 */
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  })
);

/** Records what `registerGreen` declares, and keeps the geometry it built. */
function stubLibrary() {
  const protos = new Map();
  return {
    protos,
    proto(id, factory, surface, opts = {}) {
      if (protos.has(id)) return id;
      const geo = opts.geo ?? (factory ? factory() : null);
      if (!geo) return id;
      protos.set(id, { id, geo, surface, shared: !!opts.shared });
      return id;
    },
  };
}

function attrs(geo) {
  return {
    pos: geo.attributes.position.array,
    nrm: geo.attributes.normal.array,
    col: geo.attributes.color?.array ?? null,
    idx: geo.index.array,
    verts: geo.attributes.position.count,
  };
}

/**
 * CARD EXTENTS, read off the index buffer's fan topology.
 *
 * A foliage card is a triangle fan: every triangle in it shares one apex. Group
 * triangles by their common vertex, then the card's extent is twice the largest
 * apex-to-rim distance. Nothing here knows what the emitter thought the card
 * size was.
 */
function cardExtents(a) {
  const fans = new Map();
  for (let t = 0; t < a.idx.length; t += 3) {
    const i0 = a.idx[t];
    const i1 = a.idx[t + 1];
    const i2 = a.idx[t + 2];
    // the apex is the index shared with the neighbouring triangle in the fan
    const apex = i0;
    let f = fans.get(apex);
    if (!f) fans.set(apex, (f = []));
    f.push(i1, i2);
  }
  const out = [];
  for (const [apex, ring] of fans) {
    if (ring.length < 6) continue; // not a fan: a quad strip or a tube
    const ax = a.pos[apex * 3];
    const ay = a.pos[apex * 3 + 1];
    const az = a.pos[apex * 3 + 2];
    let r = 0;
    for (const v of ring) {
      r = Math.max(r, Math.hypot(a.pos[v * 3] - ax, a.pos[v * 3 + 1] - ay, a.pos[v * 3 + 2] - az));
    }
    if (r > 0) out.push(r * 2);
  }
  return out;
}

/** Centroid and radii of the emitted geometry. */
function bounds(a) {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  const n = a.verts;
  for (let i = 0; i < n; i++) {
    cx += a.pos[i * 3];
    cy += a.pos[i * 3 + 1];
    cz += a.pos[i * 3 + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, a.pos[i * 3]);
    x1 = Math.max(x1, a.pos[i * 3]);
    y0 = Math.min(y0, a.pos[i * 3 + 1]);
    y1 = Math.max(y1, a.pos[i * 3 + 1]);
    z0 = Math.min(z0, a.pos[i * 3 + 2]);
    z1 = Math.max(z1, a.pos[i * 3 + 2]);
  }
  return { cx, cy, cz, x0, x1, y0, y1, z0, z1 };
}

/**
 * SHELL ALIGNMENT — mean dot of the emitted vertex normal with the outward
 * direction from the crown centroid, weighted nowhere and hidden nowhere.
 *
 * A card carrying its OWN normal averages ~0 here whatever it looks like from
 * one angle, because the cards are thrown in every direction; a canopy whose
 * normals lean out of the shell averages well above it, and that is the whole
 * difference between a mass that has a lit top and a dark underside and a
 * collage that reads flat black under a lamp.
 */
function shellAlign(a, b) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < a.verts; i++) {
    let ox = a.pos[i * 3] - b.cx;
    let oy = a.pos[i * 3 + 1] - b.cy;
    let oz = a.pos[i * 3 + 2] - b.cz;
    const l = Math.hypot(ox, oy, oz);
    if (l < 1e-4) continue;
    ox /= l;
    oy /= l;
    oz /= l;
    // a card is two-sided in the shader, so the sign of the dot is not the
    // question — whether the normal lies along the shell direction is
    s += Math.abs(a.nrm[i * 3] * ox + a.nrm[i * 3 + 1] * oy + a.nrm[i * 3 + 2] * oz);
    n++;
  }
  return n ? s / n : 0;
}

/** Total emitted triangle area — the numerator of canopy overdraw. */
function triAreaSum(a) {
  let s = 0;
  for (let t = 0; t < a.idx.length; t += 3) {
    const A = a.idx[t] * 3;
    const B = a.idx[t + 1] * 3;
    const C = a.idx[t + 2] * 3;
    const ax = a.pos[B] - a.pos[A];
    const ay = a.pos[B + 1] - a.pos[A + 1];
    const az = a.pos[B + 2] - a.pos[A + 2];
    const bx = a.pos[C] - a.pos[A];
    const by = a.pos[C + 1] - a.pos[A + 1];
    const bz = a.pos[C + 2] - a.pos[A + 2];
    s += 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
  }
  return s;
}

/** Mean of the AO mask channel (blue) over the emitted vertices. */
function aoMask(a) {
  if (!a.col) return 0;
  let s = 0;
  for (let i = 0; i < a.verts; i++) s += a.col[i * 3 + 2];
  return s / a.verts;
}

/**
 * SILHOUETTE FILL — rasterise the geometry's triangles into a 48x48 grid over
 * a common box in the XY plane and count occupied cells.
 *
 * This is what "bare armature" means numerically: at 300 m a tree is fifteen
 * pixels tall, so what decides whether it reads as a tree is how much of its
 * own crown box the leaves actually cover, not how many cards there are.
 */
function fill(a, box, N = 48) {
  const grid = new Uint8Array(N * N);
  const sx = N / Math.max(1e-6, box.x1 - box.x0);
  const sy = N / Math.max(1e-6, box.y1 - box.y0);
  const px = (i) => (a.pos[i * 3] - box.x0) * sx;
  const py = (i) => (a.pos[i * 3 + 1] - box.y0) * sy;
  for (let t = 0; t < a.idx.length; t += 3) {
    const x = [px(a.idx[t]), px(a.idx[t + 1]), px(a.idx[t + 2])];
    const y = [py(a.idx[t]), py(a.idx[t + 1]), py(a.idx[t + 2])];
    const lo = { x: Math.floor(Math.min(...x)), y: Math.floor(Math.min(...y)) };
    const hi = { x: Math.ceil(Math.max(...x)), y: Math.ceil(Math.max(...y)) };
    for (let gy = Math.max(0, lo.y); gy < Math.min(N, hi.y + 1); gy++) {
      for (let gx = Math.max(0, lo.x); gx < Math.min(N, hi.x + 1); gx++) {
        const cx = gx + 0.5;
        const cy = gy + 0.5;
        // half-plane test against the triangle
        let inside = true;
        let sign = 0;
        for (let k = 0; k < 3; k++) {
          const j = (k + 1) % 3;
          const d = (x[j] - x[k]) * (cy - y[k]) - (y[j] - y[k]) * (cx - x[k]);
          if (Math.abs(d) < 1e-9) continue;
          const s = d > 0 ? 1 : -1;
          if (sign === 0) sign = s;
          else if (s !== sign) { inside = false; break; }
        }
        if (inside) grid[gy * N + gx] = 1;
      }
    }
  }
  let n = 0;
  for (let i = 0; i < grid.length; i++) n += grid[i];
  return n / (N * N);
}

function pct(list, p) {
  if (!list.length) return 0;
  const s = [...list].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/**
 * TURNING TREES — is autumn a season or a single orange asset?
 *
 * There was one `leaf_autumn` surface, so every tree in the city that had
 * turned had turned to exactly the same colour at exactly the same stage, and
 * two of them in one frame read as one asset instanced twice.
 *
 * WHAT IS MEASURED, AND WHY IT IS NOT CIRCULAR. Nothing here reads
 * `layout.js`'s leaf constants. "Turned" is decided by the SHADER's own
 * contract — `LEAF_CARD` documents `uParam.x` as season, 0 spring, 1 autumn,
 * and mixes autumn in over `smoothstep(0.55, 1.0, season)` — so a leaf surface
 * is a turning one iff the season the palette hands the bake is over 0.55. The
 * variants are then counted off the emitted proto table and their seasons off
 * the palette. A file that registered three protos all pointing at one surface
 * would score 1, which is the defect.
 *
 * `_leafIndex` is exercised directly over a uniform sweep rather than through
 * `hash3i`: the question is whether the MAPPING spreads turning trees over the
 * variants that exist, and a uniform input is the one input that answers it
 * without also measuring the hash.
 */
const TURN_SEASON = 0.55;

async function measureAutumn(K, legacy) {
  // The control drives the REAL hatch through the real registration path, so
  // what fails below is the shipped behaviour and not a probe-only shortcut.
  // `oneAutumn()` caches on first call, hence a fresh module per arm.
  if (legacy) process.env.OW_ONE_AUTUMN = '1';
  else delete process.env.OW_ONE_AUTUMN;
  const { Layout } = await import(`./layout.js?arm=${legacy ? 'legacy' : 'fixed'}`);
  const { SURFACES } = await import('./palette.js');
  const L = Object.create(Layout.prototype);
  L.lib = K;
  const before = K.protos.size;
  L._autumnExtra = L._registerAutumn();

  // Every leaf proto the kit and this pass between them registered, by species.
  const bySpecies = new Map();
  const shared = { yes: 0, no: 0 };
  for (const [id, p] of K.protos) {
    const m = /^tree_(.+)_(\d+)_leaf(\d+)$/.exec(id);
    if (!m) continue;
    const key = `${m[1]}_${m[2]}`;
    let rec = bySpecies.get(key);
    if (!rec) bySpecies.set(key, (rec = { idx: new Map() }));
    rec.idx.set(+m[3], p);
  }
  const seasonOf = (surface) => SURFACES[surface]?.opts?.bake?.param?.[0] ?? 0;
  let minTurning = Infinity;
  const seasons = new Set();
  const surfaces = new Set();
  for (const rec of bySpecies.values()) {
    let turning = 0;
    const base = rec.idx.get(0);
    for (const [n, p] of rec.idx) {
      const s = seasonOf(p.surface);
      if (s <= TURN_SEASON) continue;
      turning++;
      seasons.add(+s.toFixed(3));
      surfaces.add(p.surface);
      // A turning variant that built its own crown would be paying twice for
      // one silhouette. Index 3 is the kit's, which shares by construction.
      if (n > 0 && base) (p.geo === base.geo ? shared.yes++ : shared.no++);
    }
    minTurning = Math.min(minTurning, turning);
  }
  if (!bySpecies.size) minTurning = 0;

  // The street planting's own worst case: a maple, which turns 34 % of the time.
  const AUT = 0.34;
  const N = 20000;
  const hits = new Map();
  let turned = 0;
  for (let i = 0; i < N; i++) {
    const li = L._leafIndex((i + 0.5) / N, AUT);
    const p = [...bySpecies.values()][0]?.idx.get(li);
    if (p && seasonOf(p.surface) > TURN_SEASON) {
      turned++;
      hits.set(li, (hits.get(li) ?? 0) + 1);
    }
  }
  const split = [...hits.entries()].sort((a, b) => a[0] - b[0]);
  return {
    protosAdded: K.protos.size - before,
    canopies: bySpecies.size,
    turningPerCanopy: minTurning === Infinity ? 0 : minTurning,
    seasons: [...seasons].sort((a, b) => a - b),
    surfaces: [...surfaces].sort(),
    sharedGeo: shared.yes,
    ownGeo: shared.no,
    turnedPct: +(turned / N * 100).toFixed(1),
    split: split.map(([li, n]) => `leaf${li} ${(n / Math.max(1, turned) * 100).toFixed(0)}%`),
    splitMin: split.length ? Math.min(...split.map(([, n]) => n / Math.max(1, turned))) : 0,
  };
}

async function measure(legacy) {
  if (legacy) globalThis.location = { search: '?owLegacyCanopy=1' };
  else delete globalThis.location;
  const { registerGreen } = await import(`./kit_green.js?arm=${legacy ? 'legacy' : 'fixed'}`);
  const K = stubLibrary();
  registerGreen(K);
  /**
   * The turning-tree pass runs on the FIXED arm only, which is what makes it a
   * measurement: the control arm is the kit exactly as it shipped, one autumn
   * surface across the whole city, and it has to fail.
   */
  const autumn = await measureAutumn(K, legacy);

  const out = { protos: K.protos.size, tris: 0, autumn, near: {}, far: {}, shrubs: {} };
  const nearCards = [];
  const farCards = [];
  let nearTris = 0;
  let farTris = 0;
  const shrubAlign = [];
  const shrubAo = [];
  const farFill = [];
  const farOver = [];
  const crownRatio = [];
  const woodFill = [];
  const nearFill = [];

  for (const [id, p] of K.protos) {
    const a = attrs(p.geo);
    const tris = a.idx.length / 3;
    out.tris += tris;
    const isLeaf = /_leaf\d?$/.test(id);
    const isWood = /_wood$/.test(id);
    const far = /_far_/.test(id);
    if (isLeaf && !far) {
      nearCards.push(...cardExtents(a));
      nearTris += tris;
    }
    if (isLeaf && far) {
      farCards.push(...cardExtents(a));
      farTris += tris;
    }
    if (/^(shrub_|hedge_|scrub_)/.test(id)) {
      shrubAlign.push(shellAlign(a, bounds(a)));
      shrubAo.push(aoMask(a));
    }
  }

  /**
   * The far tier judged as a silhouette: leaf fill against wood fill over the
   * SAME box, so the comparison cannot be gamed by a bigger crown.
   */
  for (const [id, p] of K.protos) {
    const m = id.match(/^tree_(\w+?)_far_leaf0$/);
    if (!m) continue;
    const wood = K.protos.get(`tree_${m[1]}_far_wood`);
    if (!wood) continue;
    const la = attrs(p.geo);
    const wa = attrs(wood.geo);
    /**
     * The box is the CROWN's own bounds, not the tree's. Measuring the leaves
     * over a box that includes six metres of bare trunk dilutes the number
     * with ground the canopy was never meant to cover, and a metric that gets
     * better when a tree is shorter is not measuring a canopy.
     */
    const box = bounds(la);
    farFill.push(fill(la, box));
    woodFill.push(fill(wa, box));
    farOver.push(triAreaSum(la) / Math.max(1e-6, (box.x1 - box.x0) * (box.y1 - box.y0)));
    const nb = K.protos.get(`tree_${m[1]}_0_leaf0`);
    if (nb) {
      const na = attrs(nb.geo);
      const nbx = bounds(na);
      crownRatio.push((box.x1 - box.x0) / Math.max(1e-6, nbx.x1 - nbx.x0));
    }
  }
  for (const [id, p] of K.protos) {
    const m = id.match(/^tree_(\w+?)_0_leaf0$/);
    if (!m) continue;
    const la = attrs(p.geo);
    nearFill.push(fill(la, bounds(la)));
  }

  return {
    arm: legacy ? 'legacy (control: must fail)' : 'fixed',
    protos: out.protos,
    tris: out.tris,
    nearTris,
    farTris,
    cardMed: +pct(nearCards, 0.5).toFixed(2),
    cardP95: +pct(nearCards, 0.95).toFixed(2),
    cardMax: +pct(nearCards, 0.999).toFixed(2),
    cards: nearCards.length,
    farCardMed: +pct(farCards, 0.5).toFixed(2),
    farCards: farCards.length,
    shrubAlign: +(shrubAlign.reduce((s, v) => s + v, 0) / Math.max(1, shrubAlign.length)).toFixed(3),
    shrubAo: +(shrubAo.reduce((s, v) => s + v, 0) / Math.max(1, shrubAo.length)).toFixed(3),
    farFill: +(farFill.reduce((s, v) => s + v, 0) / Math.max(1, farFill.length)).toFixed(3),
    farOver: +(farOver.reduce((s, v) => s + v, 0) / Math.max(1, farOver.length)).toFixed(2),
    farOverMin: +Math.min(...farOver).toFixed(2),
    crownRatio: +Math.min(...crownRatio).toFixed(2),
    woodFill: +(woodFill.reduce((s, v) => s + v, 0) / Math.max(1, woodFill.length)).toFixed(3),
    nearFill: +(nearFill.reduce((s, v) => s + v, 0) / Math.max(1, nearFill.length)).toFixed(3),
    autumn: out.autumn,
  };
}

/**
 * Limits are properties of a tree, not of this code.
 *
 *   card p95 <= 1.35 m   a card is a SPRAY of leaves, not a leaf. A London
 *                        plane's spray at the rim of the crown is hand-sized to
 *                        forearm-sized; past about 1.3 m across you are looking
 *                        at a cutout, which is what "wrong scale" meant.
 *   shrub align >= 0.55  the emitted normals must lean out of the shell. A card
 *                        keeping its own normal scores ~0.35 here (measured on
 *                        the control arm) and reads as an unlit blob.
 *   shrub AO <= 0.55     the crown-interior darkening authored for a 3 m plane
 *                        crown, applied to a 40 cm shrub, is the other half of
 *                        the black blob.
 *   far fill >= 0.34     the far crown must cover a third of its own
 *                        silhouette box, and
 *   far fill >= 2x wood  more of that box than the branches do, or the tier is
 *                        an armature with a tuft on it whatever else is true.
 *   far overdraw >= 5.5  THE ONE THAT ACTUALLY SEPARATES THE ARMS, and the
 *                        only one derived rather than chosen. Card area over
 *                        crown silhouette area. The leaf bake covers ~25 % of
 *                        a card and `alphaTest` 0.21 keeps roughly half of
 *                        what the mip chain hands it at range, so the expected
 *                        OPAQUE layers over a point is overdraw x 0.25 x 0.5;
 *                        under about 0.7 layers the crown is a haze with
 *                        branches through it, which is "bare armature" seen
 *                        from 300 m. 5.5 is that threshold.
 *   far crown >= 0.9x    a far tier whose crown is narrower than the near
 *                        tier's pops when it swaps and reads as a lollipop
 *                        whatever its density.
 */
function grade(r) {
  return [
    ['near card p95 <= 1.35 m', r.cardP95 <= 1.35, `${r.cardP95}`],
    ['near canopy fill >= 0.55', r.nearFill >= 0.55, `${r.nearFill}`],
    ['shrub shell align >= 0.55', r.shrubAlign >= 0.55, `${r.shrubAlign}`],
    ['shrub AO mask <= 0.55', r.shrubAo <= 0.55, `${r.shrubAo}`],
    ['far canopy fill >= 0.34', r.farFill >= 0.34, `${r.farFill}`],
    ['far canopy > 2x wood fill', r.farFill >= r.woodFill * 2, `${r.farFill} vs ${r.woodFill}`],
    ['far overdraw >= 5.5 (worst)', r.farOverMin >= 5.5, `${r.farOverMin}`],
    ['far crown >= 0.9x near crown', r.crownRatio >= 0.9, `${r.crownRatio}`],
    ['turning leaf surfaces >= 3', r.autumn.turningPerCanopy >= 3, `${r.autumn.turningPerCanopy} per canopy`],
    ['turning seasons distinct >= 3', r.autumn.seasons.length >= 3, `${r.autumn.seasons.join('/')}`],
    ['autumn costs no new crown', r.autumn.ownGeo === 0, `${r.autumn.ownGeo} unshared`],
    ['no turning variant under 25%', r.autumn.splitMin >= 0.25, `${(r.autumn.splitMin * 100).toFixed(0)}% of turned`],
  ];
}

function print(r, checks) {
  console.log(`\n--- ${r.arm} --------------------------------------------------`);
  console.log(`  protos ${r.protos}  triangles ${r.tris}  (near leaf ${r.nearTris}, far leaf ${r.farTris})`);
  console.log(`  near cards ${r.cards}: median ${r.cardMed} m, p95 ${r.cardP95} m, max ${r.cardMax} m`);
  console.log(`  far cards ${r.farCards}: median ${r.farCardMed} m`);
  console.log(`  canopy fill  near ${r.nearFill}   far ${r.farFill}   far wood ${r.woodFill}`);
  console.log(`  far overdraw mean ${r.farOver}, worst species ${r.farOverMin};  far/near crown width ${r.crownRatio}`);
  console.log(`  shrubs: shell align ${r.shrubAlign}   AO mask ${r.shrubAo}`);
  console.log(
    `  turning: ${r.autumn.turningPerCanopy} surface(s) on each of ${r.autumn.canopies} canopies ` +
    `(+${r.autumn.protosAdded} protos, ${r.autumn.sharedGeo} sharing a crown, ${r.autumn.ownGeo} building their own)`
  );
  console.log(
    `  seasons ${r.autumn.seasons.join(' / ')}  [${r.autumn.surfaces.join(' ')}]   ` +
    `a maple turns ${r.autumn.turnedPct}% of the time, split ${r.autumn.split.join('  ') || '(none)'}`
  );
  let pass = 0;
  for (const [label, ok, val] of checks) {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(28)} ${val}`);
    if (ok) pass++;
  }
  return pass;
}

async function main() {
  const wantLegacy = !!args.legacy || !!args.gate;
  const wantFixed = !args.legacy || !!args.gate;
  let fixed = null;
  let legacy = null;
  if (wantFixed) fixed = await measure(false);
  if (wantLegacy) legacy = await measure(true);
  if (args.json) console.log(JSON.stringify({ fixed, legacy }, null, 2));

  let ok = true;
  if (fixed) {
    const ch = grade(fixed);
    const pass = print(fixed, ch);
    console.log(`  ${pass}/${ch.length}`);
    if (pass !== ch.length) ok = false;
  }
  if (legacy) {
    const ch = grade(legacy);
    const pass = print(legacy, ch);
    console.log(`  ${pass}/${ch.length} — a control that PASSES means the gate measures nothing`);
    if (args.gate && pass === ch.length) {
      console.log('\nCONTROL DID NOT FAIL — gate is decorative');
      ok = false;
    }
  }
  console.log(ok ? '\nFOLIAGE GATE PASSED' : '\nFOLIAGE GATE FAILED');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
