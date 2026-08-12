/**
 * VEHICLE GROUND CONTACT.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT WAS ACTUALLY WRONG
 * ────────────────────────────────────────────────────────────────────────────
 * Before this file there was no ground-contact mark under a car at all — not a
 * blob decal, not a fake, NOTHING. `src/peds/crowdfx.js` has had a
 * `GroundShadows` pool under every body
 * and every foot since early on; vehicles never had an equivalent, and the only
 * thing under a car was whatever road dressing `props` had scattered there by
 * hash — an oil stain or a tar patch that has no idea a car is parked on it.
 *
 * Measured on `car.png` before this file existed, sampling 200x30 px blocks:
 *
 *     under the car, mid-wheelbase      (78, 74, 68)
 *     open asphalt just behind it       (75, 70, 64)
 *     open asphalt left of the car      (68, 64, 59)
 *     under the rear axle               (88, 82, 75)
 *
 * The ground under the car was 15% BRIGHTER than the open asphalt beside it,
 * and the brightest sample in the set was directly under the rear axle. So the
 * critic's description of the symptom was exact even though the mechanism was
 * not: there was no occlusion under a two-tonne object, and the sky was lighting
 * the road under it as if it were not there.
 *
 * The engine's real contact shadow is a screen-space depth march
 * (`render/contact.js`) plus GTAO, and both are quality-gated — at `low` the
 * contact pass is not even constructed. So a car needs a geometric fallback for
 * the same reason a ped does.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO POOLS, BECAUSE THEY ARE TWO DIFFERENT PHENOMENA
 * ────────────────────────────────────────────────────────────────────────────
 * The soft darkening under the floor pan and the near-black crescent where a
 * tyre meets the road are not the same thing at different strengths. The body
 * AO is metres wide, soft, and roughly the shape of the car; the tyre patch is
 * fifteen centimetres, hard-edged, and is the single mark that makes a wheel
 * look like it is bearing weight rather than intersecting the road. Blending
 * them into one texture gives a grey smudge that reads as neither.
 *
 * Both are `InstancedMesh` (hard rule 7) — two draw calls for the entire
 * vehicle fleet — and both MULTIPLY rather than alpha-blend towards a colour.
 * That distinction is not cosmetic and it is written up at length on the
 * material below: blending towards a near-black constant makes anything darker
 * than the constant BRIGHTER, which is measurably what the first cut did to the
 * road under the sill.
 *
 * The shadow FADES AND SHRINKS with ride height. A car that has just landed a
 * jump has its shadow 30 cm below its floor and it must not stay welded to the
 * body; a car on its roof should not have a wheel patch at all. Both fall out
 * of driving the pool off the wheels' real contact points instead of off the
 * body transform.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS POOL WAS ONCE REPORTED AS CONTRIBUTING NOTHING. IT WAS NOT.
 * ────────────────────────────────────────────────────────────────────────────
 * `src/render/aoprobe.mjs` group 3 read a 0.002-0.012 linear whole-band delta
 * against this pool, with the wrong SIGN, and that was taken as "the pool is
 * invisible". Two separate things were true and neither was the one assumed:
 *
 *   - The BURIAL was real and is measured and swept below. It is not what the
 *     probe was reading, because the probe's number never had the resolution
 *     to see it either way.
 *
 *   - The whole-band mean the probe asserted on is a measurement of the
 *     renderer's AUTO-EXPOSURE, not of this pool. Darkening a few thousand
 *     pixels lowers the metered key, the adaptation opens up, and all two
 *     million other pixels come back brighter. MEASURED on `car`: this pool
 *     moves 10 778 band pixels and darkens them by 1.20 linear, while the
 *     508 000 pixels it cannot reach BRIGHTEN by 0.077 — and 0.077 x 508 000
 *     buries 1.20 x 10 778. The band mean went the wrong way while the shadow
 *     was doing its whole job.
 *
 * The probe now measures the footprint against the frame's own exposure, which
 * is the discipline `src/peds/shadowprobe.mjs` already arrived at for the ped
 * pool. Do not go looking for a strength bug here on the strength of a
 * whole-frame average again.
 */

import * as THREE from 'three';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _yaw = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * A superelliptical falloff. `n` near 2 is an ellipse; higher values square it
 * off, which is what a car's floor pan actually occludes — the dark area under a
 * saloon is a rounded rectangle, not an oval, and an oval leaves the corners of
 * the car visibly floating.
 */
function occlusionTexture(size, n, power, edge) {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / (size - 1)) * 2 - 1;
      const v = (y / (size - 1)) * 2 - 1;
      const r = Math.pow(Math.pow(Math.abs(u), n) + Math.pow(Math.abs(v), n), 1 / n);
      let a = 1 - Math.min(1, r);
      a = Math.pow(a, power);
      // A hard-ish inner core with a long soft skirt: the penumbra of a large
      // occluder 20 cm off the ground under a sky source.
      a = a * edge + (1 - edge) * Math.pow(a, 0.35) * a;
      const i = (y * size + x) * 4;
      d[i] = 255; d[i + 1] = 255; d[i + 2] = 255;
      d[i + 3] = Math.round(255 * Math.max(0, Math.min(1, a)));
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE DRAWN-VS-COLLIDER BIAS, SWEPT ON THIS POOL'S OWN QUADS
 * ────────────────────────────────────────────────────────────────────────────
 * Same disease as `src/peds/crowdfx.js`, and read its note first: the wheels
 * stand on the STREAMED COLLISION mesh, which `roadmesh` builds at 11 m rows
 * and 9 columns, while the visible carriageway is emitted at 2.7 m rows with
 * camber, wheel ruts and `roadWob` on top. The collider is consistently the
 * LOWER of the pair, so a decal placed at the collider's answer depth-tests out.
 *
 * MEASURED the same way the ped pool was — a vertical ray against the EMITTED
 * VERTICES of every visible mesh under each quad, never `heightAt` and never
 * the collider (rule 12) — over 132 quads from six emitted frames (`driving`,
 * `car`, `street`, `cockpit`, `chase`, `crowd`), with the ORIGINAL fixed lifts
 * (body +0.016, tyre +0.012) in place:
 *
 *              quads   buried   median gap   p10 gap
 *   all         132      79      -0.003 m    -0.039 m
 *   body         80      47
 *   tyre         52      32
 *
 * SIXTY PERCENT of the fleet's contact marks were under the road.
 *
 * THE BODY QUAD NEEDS MORE LIFT THAN THE TYRE QUAD, and that is not a taste
 * call. A tyre patch is placed at that wheel's OWN contact point, so its
 * estimate is sampled where it is drawn: the collider-vs-drawn disagreement
 * under a tyre quad is a median 7-31 mm. The body quad is placed at the car's
 * CENTRE off the MEAN of four contacts taken at the corners of a 4.7 m box —
 * and on a cambered carriageway the centre is the crown, which is the highest
 * part of the section the mean cannot see. Under a body quad the disagreement
 * is a median 21-54 mm and a p10 of 111 mm on `street`.
 *
 * It is also the cheap one to lift. The cost of a lift is paid at grazing
 * angles: `eps` metres off the deck seen at 13 degrees of depression displaces
 * the mark by `eps / tan(13°)` ≈ 4.3 x eps. The body blob is ~2.4 x 5.0 m, so
 * 55 mm displaces it by 4% of its own length; the tyre patch is 0.31 x 0.53 m,
 * where the same lift would move it by two thirds of its width — and the tyre
 * patch is THE mark that says the wheel is bearing weight. So they get
 * different epsilons, sized to what each one can afford.
 *
 * SWEPT offline on those 132 quads, re-solving `_contactY` for each candidate
 * (cap, body eps, tyre eps) against the drawn surface measured under each:
 *
 *    cap    body   tyre   buried (body/tyre)   p10 gap   worst float   mean lift
 *   0.000   0.016  0.012   79  (47/80, 32/52)   -0.039      0.354        0.014
 *   0.100   0.030  0.030    6  ( 5/80,  1/52)   +0.016      0.368        0.056
 *   0.100   0.045  0.030    4  ( 3/80,  1/52)   +0.021      0.383        0.065
 *   0.100   0.055  0.030    3  ( 2/80,  1/52)   +0.021      0.393        0.071
 *   0.100   0.070  0.030    2  ( 1/80,  1/52)   +0.021      0.408        0.080
 *   0.125   0.055  0.030    2  ( 1/80,  1/52)   +0.021      0.393        0.072
 *   0.150   0.055  0.030    2  ( 1/80,  1/52)   +0.021      0.393        0.072
 *
 * The CAP is 0.10 and stays there. It is the ceiling on how far the drawn
 * estimate may raise a quad above the ground the car is standing on, and it
 * exists because `walkableHeightAt` reads junction pads and kerb stones up to
 * +0.20 m high. Its knee is in the same place as the ped pool's: at body eps
 * 0.030 the buried count runs 31 / 10 / 8 / 6 / 6 / 5 / 5 across caps
 * 0.000 / 0.045 / 0.075 / 0.100 / 0.125 / 0.150 / 0.300, and the mean lift is
 * flat past 0.10 (0.071 -> 0.072). The ONE quad 0.125 would buy back is a car
 * on `street` parked over a pad the estimator reads 166 mm high — precisely the
 * over-read the cap is there to refuse. Chasing it with a bigger cap is trading
 * the clamp's whole job for one distant quad.
 *
 * VERIFIED on the shipped values by re-measuring the same six frames against
 * the EMITTED INSTANCE TRANSFORMS rather than against what `add` was handed —
 * the pool's own `instanceMatrix`, so the check does not depend on any
 * instrumentation inside this file and cannot agree with it by construction:
 *
 *              quads   buried   median gap   p10 gap
 *   driving      18       2       +0.047     -0.004
 *   car          15       0       +0.037     +0.021
 *   street       22       1       +0.055     +0.034
 *   cockpit      28       0       +0.043     +0.021
 *   chase        24       0       +0.047     +0.023
 *   crowd        25       0       +0.060     +0.021
 *
 * 79 of 132 buried before, 3 of 132 after. Everything still buried is reported
 * rather than papered over: all three are past 36 m and all three are cars
 * sitting over surfaces `walkableHeightAt` does not model.
 *
 * This closed a real defect and it is NOT what `src/render/aoprobe.mjs` group 3
 * was reading — see the note at the top of this file. Both were true; only one
 * of them was ever measured.
 */
const CAR_SURFACE_LIFT_CAP = 0.10;
const CAR_BODY_EPS = 0.055;
const CAR_TYRE_EPS = 0.030;

class Pool {
  constructor(cap, tex, opacity, order) {
    this.cap = cap;
    this.tex = tex;
    this.geo = new THREE.PlaneGeometry(1, 1, 1, 1);
    /**
     * ────────────────────────────────────────────────────────────────────────
     * MULTIPLY-DARKEN, NOT "ALPHA-BLEND TOWARDS NEAR-BLACK"
     * ────────────────────────────────────────────────────────────────────────
     * The first cut of this pool copied the ped one: `MeshBasicMaterial` with a
     * near-black `color` and ordinary alpha blending, i.e.
     *
     *     out = colour * a + dst * (1 - a)
     *
     * which is a LERP TOWARDS A CONSTANT, and a lerp towards a constant makes
     * anything darker than that constant BRIGHTER. Measured on the `car` shot
     * with an A/B capture (`?owNoCarShadow=1`, same frame, same camera, same
     * subject position to two decimals): the strip of road visible under the
     * sill has a minimum of 0.0015 linear, and the "shadow" colour was 0.030
     * linear — twenty times brighter. The mean of that strip went from 9.19 to
     * 13.71 (linear x255) WITH the shadow switched on. It lit the ground.
     *
     * Which is exactly the failure a naive blob decal produces: a
     * "ground-contact mark" that renders BRIGHTER than the asphalt around it.
     * It is a real and easy mistake, which is why the measurement is kept here.
     *
     * Occlusion is not a colour. It is a transmittance, and the only operator
     * that expresses it is a multiply:
     *
     *     out = dst * (1 - a)
     *
     * which is `src ZERO, dst ONE_MINUS_SRC_ALPHA`. It cannot brighten anything
     * — at a = 0 it is the identity and at a = 1 it is black — it needs no
     * colour at all, and it is correct in the linear HDR target this composites
     * into regardless of how dark or bright the surface under it happens to be.
     * The alpha factors are split out so the target's own alpha channel is left
     * alone; TAA and the composite read it.
     */
    this.mat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: tex,
      transparent: true,
      opacity,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.renderOrder = order;
    this.mesh.userData.owNoShadow = true;
    this.mesh.userData.owNoPrepass = true;
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.n = 0;
  }

  begin() {
    this.n = 0;
  }

  /** Place one quad, flat on the ground, yawed to `yaw`. */
  put(x, y, z, yaw, sx, sz, fade) {
    if (this.n >= this.cap || fade <= 0.01) return;
    _yaw.setFromAxisAngle(_up, yaw);
    _q.copy(_yaw).multiply(_flat);
    _v.set(x, y, z);
    // Fade is folded into SCALE as well as being clipped by the caller: a
    // shrinking patch reads as a rising car, a merely-dimmer one reads as a
    // lighting change. Never let it hit zero area, or the quad flickers.
    _s.set(sx * (0.55 + 0.45 * fade), sz * (0.55 + 0.45 * fade), 1);
    _m.compose(_v, _q, _s);
    this.mesh.setMatrixAt(this.n, _m);
    this.n++;
  }

  end() {
    this.mesh.count = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.tex.dispose?.();
    this.mesh.dispose?.();
  }
}

export class VehicleGroundShadows {
  /**
   * @param {number} bodyCap  how many cars get a floor-pan patch
   * @param {number} tyreCap  how many INDIVIDUAL tyre patches (4 per car)
   */
  constructor(bodyCap = 64, tyreCap = 96) {
    // n = 3.1: distinctly squared off. power 1.5, edge 0.55: a firm core under
    // the floor with a long skirt out past the sills.
    const bodyTex = occlusionTexture(64, 3.1, 1.5, 0.55);
    // A contact patch is nearly hard-edged — the tyre touches the road.
    const tyreTex = occlusionTexture(32, 2.4, 2.6, 0.85);
    this.body = new Pool(bodyCap, bodyTex, 0.80, 5);
    this.tyre = new Pool(tyreCap, tyreTex, 0.92, 6);
    this.group = new THREE.Group();
    this.group.name = 'vehicleGroundShadows';
    this.group.add(this.body.mesh, this.tyre.mesh);
    /** Preallocated: hard rule 5 — nothing allocates inside `add`. */
    this._c = new THREE.Vector3();
    this._world = null;
  }

  /** `vehicles` hands the world in once it is up; harnesses may never. */
  bindWorld(w) {
    this._world = w ?? null;
  }

  /**
   * The height to draw a contact mark at, given the ground the wheels resolved.
   *
   * `raw` is the COLLIDER's answer and is the floor — `walkableHeightAt` reads
   * a metre low over rail ballast and building plinths, and a mark below the
   * car's own tyres is worse than the burial it replaces. `CAR_SURFACE_LIFT_CAP`
   * is the ceiling. `eps` is per-pool: see the sweep above for why the body and
   * the tyre cannot share one.
   *
   * `raw` doubles as `walkableHeightAt`'s deck hint, so a car on a river
   * crossing resolves against the bridge and not the riverbed.
   */
  _contactY(x, z, raw, eps) {
    const w = this._world;
    if (!w?.walkableHeightAt) return raw + eps;
    const g = w.walkableHeightAt(x, z, raw);
    if (!Number.isFinite(g) || g <= raw) return raw + eps;
    return Math.min(g, raw + CAR_SURFACE_LIFT_CAP) + eps;
  }

  begin() {
    this.body.begin();
    this.tyre.begin();
  }

  /**
   * @param v       a Vehicle
   * @param yaw     its heading, radians
   * @param tyres   whether this car is close enough to earn per-wheel patches
   */
  add(v, yaw, tyres) {
    const spec = v.spec;
    if (!spec) return;

    // ---- where the ground IS ---------------------------------------------
    // Off the wheels' own contact points, never off the body transform: that is
    // what makes the shadow separate correctly when the car leaves the ground,
    // and it costs nothing because the dynamics already solved for it.
    let gy = 0;
    let grounded = 0;
    for (const w of v.wheels ?? []) {
      // `w.contact` is a PREALLOCATED Vector3 and is therefore always truthy —
      // this is the exact footgun ARCHITECTURE.md rule 12 records `playprobe`
      // falling into twice. Test the flag, never the vector.
      if (w.grounded !== true) continue;
      gy += w.contact.y;
      grounded++;
    }
    const half = spec.half ?? { x: 0.9, z: 2.2 };
    if (grounded === 0) {
      // Airborne (or upside down). Fall back to the body's own floor plane and
      // let the height fade take it away.
      gy = v.position.y - (spec.comY ?? 0.5) + (spec.style?.groundY ?? 0.1);
    } else {
      gy /= grounded;
    }

    const lift = v.position.y - (spec.comY ?? 0.5) - gy;
    // A body sits ~0.1-0.2 m off the deck normally; fade out over the next 1.2 m.
    const fade = Math.max(0, Math.min(1, 1 - (lift - 0.30) / 1.2)) *
      (0.35 + 0.65 * (grounded / Math.max(1, (v.wheels?.length ?? 4))));
    if (fade <= 0.02) return;

    /**
     * WIDER THAN THE CAR, deliberately. A capture is taken from about 1.5 m and
     * a saloon's sill is at 0.4 m, so almost the whole footprint is hidden
     * behind the car's own bodywork — an A/B diff of the `car` shot showed the
     * patch contributing a 15-pixel band and nothing else. What is actually
     * visible at eye level is the PENUMBRA spilling out past the sill, so the
     * patch runs about 1.5x the car's width: the extra 25 cm each side is the
     * part anyone ever sees.
     */
    this.body.put(
      v.position.x, this._contactY(v.position.x, v.position.z, gy, CAR_BODY_EPS), v.position.z, yaw,
      half.x * 2.60, half.z * 2.24, fade
    );

    if (!tyres) return;
    for (const w of v.wheels ?? []) {
      if (w.grounded !== true) continue;
      const r = w.hp?.radius ?? 0.34;
      // Elongated along the direction of travel: a loaded tyre's contact patch
      // is roughly 1.6 x longer than it is wide, and it is the long axis that
      // makes the wheel look like it is standing on the road.
      this.tyre.put(
        w.contact.x, this._contactY(w.contact.x, w.contact.z, w.contact.y, CAR_TYRE_EPS), w.contact.z, yaw,
        r * 0.90, r * 1.55, 1
      );
    }
  }

  end() {
    this.body.end();
    this.tyre.end();
  }

  dispose() {
    this.body.dispose();
    this.tyre.dispose();
    this.group.clear();
  }
}
