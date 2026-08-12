/**
 * Vehicle materials.
 *
 * Real automotive paint is three layers: a coloured metallic base coat, a
 * transparent clearcoat over it, and the flake suspended in the base. Three's
 * MeshPhysicalMaterial models exactly that (`clearcoat` +
 * `clearcoatNormalMap`), and using it properly is the single biggest
 * difference between a car that reads as a car and a car that reads as a
 * coloured box:
 *
 *   - the clearcoat gives a second, sharper specular lobe that travels across
 *     the shoulder line independently of the base-coat highlight,
 *   - the flake normal breaks that highlight into a shimmer,
 *   - the orange-peel clearcoat normal ripples the reflected world slightly,
 *     which is what stops a reflection reading as a decal,
 *   - polishing swirls in the roughness map appear only when a highlight
 *     crosses them.
 *
 * Everything is cached: dozens of traffic cars share one material per colour,
 * and one texture set for the whole game.
 */

import * as THREE from 'three';
import {
  makeFlakeMaps, makeOrangePeel, makePaintORM, makeTyreMaps, makeRimNormal,
  makeRimMaps, makeBodyAlbedo, makeRoadFilm, makeRustBloom, makeGlassMaps,
  makeTrimMaps,
  makePlate, makeDash, makeDashEmissive, makeFabric, makeFabricNormal,
  makeReflector, makeGrilleMesh, makeRust, makeGlassCracks, makeLivery,
} from './textures.js';

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE WEATHERING EXTENSION — ONE onBeforeCompile SHARED BY EVERY PAINT MATERIAL
 * ────────────────────────────────────────────────────────────────────────────
 * `bakeGrime` used to be the whole weathering model: a MULTIPLY-ONLY vertex
 * colour, maximum strength 0.34, no texture anywhere in it. Multiply-only can
 * darken and nothing else, so it can express "the sill is in shadow" and it can
 * express literally none of the things a Pittsburgh car actually shows —
 * road salt is a pale bloom that LIGHTENS, rust is an orange that is not a
 * darker version of the paint, and a replacement door is a small HUE shift, not
 * a value one. That is the mechanism behind the critic's standing complaint
 * that the whole build is factory-clean: the model could not represent dirt.
 *
 * So the vertex attribute stops being a colour and becomes three MASKS —
 * `aWear = (roadFilm, rust, panelId)` — and the compositing moves into the
 * fragment shader where it can add, lighten and shift hue.
 *
 * PERMUTATION BUDGET, and it drives p99 frame time, so it matters: this is ONE
 * hook function and ONE `customProgramCacheKey` string
 * shared by every paint material, and gloss / matte / primer are deliberately
 * given the SAME map slots and a non-zero clearcoat so they land in the same
 * three permutation. Net effect on the program count is therefore +1 family for
 * the whole vehicle fleet, and it REPLACES three families that the old
 * finish-dependent map sets produced. `VehicleSystem.prewarmMaterials` builds a
 * mesh carrying `aWear` for every paint in `PAINTS`, so nothing here compiles
 * during play.
 *
 * `render/materialpatch.js` chains onto whatever hook it finds (it calls
 * `prevHook` first and composes `customProgramCacheKey`), so setting these at
 * construction time is the supported way to extend a lit material here.
 */
const WEAR_PARS_VS = /* glsl */ `
attribute vec3 aWear;
varying vec3 vWear;
varying vec2 vBodyUv;
`;

const WEAR_PARS_FS = /* glsl */ `
uniform sampler2D owFilmTex;
uniform sampler2D owRustTex;
uniform vec4 owWearP;   // x film, y rust, z salt, w respray
uniform vec4 owWearS;   // x filmScale, y rustScale, z wetness, w unused
varying vec3 vWear;
varying vec2 vBodyUv;
`;

/**
 * Runs immediately after three's map_fragment, so it composites onto the paint
 * colour before anything reads it. Deliberately NOT wrapped in braces:
 * owVWCov and owVWRust are read again by the roughness, metalness and clearcoat
 * blocks further down main().
 */
const WEAR_ALBEDO_FS = /* glsl */ `
  float owVWFilm = clamp( vWear.x, 0.0, 1.0 ) * owWearP.x;
  float owVWRustM = clamp( vWear.y, 0.0, 1.0 ) * owWearP.y;

  // A repaired panel never matches. The id is constant across a whole door, so
  // the door shifts as one piece rather than dissolving into noise.
  float owVWPan = ( fract( vWear.z * 8.371 ) - 0.5 ) * owWearP.w;
  diffuseColor.rgb *= vec3( 1.0 + owVWPan, 1.0 + owVWPan * 0.93, 1.0 + owVWPan * 0.84 );

  vec4 owVWFl = texture2D( owFilmTex, vBodyUv * owWearS.x );
  float owVWCov = owVWFl.a * owVWFilm;
  // Road film is warm grey-brown. g carries the LINEAR albedo, r the salt mask.
  vec3 owVWFilmCol = vec3( owVWFl.g * 1.18, owVWFl.g, owVWFl.b );
  diffuseColor.rgb = mix( diffuseColor.rgb, owVWFilmCol, owVWCov * 0.80 );

  // Salt bloom LIGHTENS — the one weathering term a multiply could never make.
  // All of these are LINEAR reflectances, not sRGB bytes over 255: dried road
  // salt is ~0.34, rust scale ~0.19, and a pitted core ~0.04.
  float owVWSalt = owVWFl.r * owVWFilm * owWearP.z;
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.36, 0.355, 0.34 ), owVWSalt );

  vec4 owVWRu = texture2D( owRustTex, vBodyUv * owWearS.y );
  float owVWRust = owVWRu.a * owVWRustM;
  // Blistered halo, then orange scale, then the dark pit inside it.
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.13, 0.090, 0.062 ), owVWRu.b * owVWRust * 0.5 );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.21, 0.088, 0.032 ), owVWRu.r * owVWRust );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.045, 0.030, 0.022 ), owVWRu.g * owVWRust );

  // Wet paint is darker paint. The film soaks first and darkest.
  diffuseColor.rgb *= 1.0 - owWearS.z * ( 0.14 + owVWCov * 0.22 );
`;

const WEAR_ROUGH_FS = /* glsl */ `
  roughnessFactor = mix( roughnessFactor, 0.88, owVWCov * 0.9 );
  roughnessFactor = mix( roughnessFactor, 0.95, owVWRust );
`;

const WEAR_METAL_FS = /* glsl */ `
  // Iron oxide is a dielectric. Rust is the one place the flake must stop.
  metalnessFactor *= 1.0 - owVWRust * 0.92;
`;

const WEAR_CLEAR_FS = /* glsl */ `
  // Road film and rust both kill the clear layer; standing water restores it,
  // which is why a filthy car looks briefly new in the rain.
  material.clearcoat *= ( 1.0 - owVWCov * 0.70 ) * ( 1.0 - owVWRust * 0.95 );
  material.clearcoat = mix( material.clearcoat, 1.0, owWearS.z * 0.55 );
  material.clearcoatRoughness = mix( material.clearcoatRoughness, 0.62, owVWCov * 0.8 );
  material.clearcoatRoughness = mix( material.clearcoatRoughness, 0.030, owWearS.z * 0.7 );
`;

function installWear(mat, uniforms) {
  mat.userData.owVehWear = uniforms;
  mat.customProgramCacheKey = () => 'ow:vehpaint';
  mat.onBeforeCompile = (shader) => {
    for (const k in uniforms) shader.uniforms[k] = uniforms[k];
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\n' + WEAR_PARS_VS)
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vWear = aWear;\n  vBodyUv = uv;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WEAR_PARS_FS)
      .replace('#include <map_fragment>', '#include <map_fragment>\n' + WEAR_ALBEDO_FS)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n' + WEAR_ROUGH_FS)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n' + WEAR_METAL_FS)
      .replace(
        '#include <lights_physical_fragment>',
        '#include <lights_physical_fragment>\n' + WEAR_CLEAR_FS
      );
  };
  return mat;
}

export class VehicleMaterials {
  constructor(ctx) {
    this.ctx = ctx;
    this.q = ctx?.config?.q ?? {};
    this._tex = {};
    this._paints = new Map();
    this._plates = new Map();
    this._mats = new Map();
    this._all = [];
    this._built = false;
    /**
     * Shared by every paint material by REFERENCE, so `setWetness` is one write
     * for the whole fleet and costs nothing per frame. x/y are the film and
     * rust tiling (taken off the textures' own repeat so the tuning stays in
     * `textures.js`), z is the wetness integral. The per-finish AMOUNTS live in
     * a second, per-material `owWearP`.
     */
    this._wearS = { value: new THREE.Vector4(0.42, 0.8, 0, 0) };
  }

  build() {
    if (this._built) return this;
    this._built = true;
    const lowQ = this.ctx?.config?.quality === 'low';
    const s = lowQ ? 0.5 : 1;
    const T = this._tex;
    const flake = makeFlakeMaps(Math.round(512 * s));
    T.flake = flake.normal;
    T.flakeMetal = flake.metal;
    T.peel = makeOrangePeel(Math.round(256 * s));
    T.paintORM = makePaintORM(Math.round(512 * s));
    T.bodyAlbedo = makeBodyAlbedo(Math.round(512 * s));
    T.roadFilm = makeRoadFilm(Math.round(512 * s));
    T.rustBloom = makeRustBloom(Math.round(512 * s));
    T.glass = makeGlassMaps(Math.round(512 * s));
    const tyre = makeTyreMaps(Math.round(1024 * s));
    T.tyreAlbedo = tyre.albedo;
    T.tyreNormal = tyre.normal;
    T.rimNormal = makeRimNormal(Math.round(256 * s));
    const rim = makeRimMaps(Math.round(512 * s));
    T.rimAlbedo = rim.albedo;
    T.rimRough = rim.rough;
    const trim = makeTrimMaps(Math.round(256 * s));
    T.trimAlbedo = trim.albedo;
    T.trimNormal = trim.normal;
    T.dash = makeDash(Math.round(512 * s));
    T.dashEmissive = makeDashEmissive(Math.round(512 * s));
    T.fabric = makeFabric(Math.round(256 * s));
    T.fabricNormal = makeFabricNormal(Math.round(256 * s));
    T.reflector = makeReflector(Math.round(256 * s));
    T.grille = makeGrilleMesh(Math.round(256 * s));
    T.rust = makeRust(Math.round(512 * s));
    T.cracks = makeGlassCracks(Math.round(512 * s));
    T.liveryPolice = makeLivery('police', Math.round(512 * s));
    for (const k in T) if (T[k]) T[k].anisotropy = Math.min(this.q.anisotropy ?? 8, 16);
    // The film and rust maps are sampled by hand in the extension, so three
    // never builds a uv transform for them; carry their authored tiling across
    // into the uniform instead of duplicating the number here.
    this._wearS.value.x = T.roadFilm.repeat.x;
    this._wearS.value.y = T.rustBloom.repeat.x;
    return this;
  }

  /**
   * Global wetness, 0..1. Driven by `VehicleSystem.setWetness` off the canonical
   * `weather:change` event, so the same integral that changes the tyre's grip
   * also darkens the paint and re-glosses the clearcoat. One write, whole fleet.
   */
  setWetness(w) {
    this._wearS.value.z = w > 1 ? 1 : w < 0 ? 0 : w || 0;
  }

  /* ---------------------------------------------------------------- */

  _reg(m) {
    this._all.push(m);
    return m;
  }

  _cached(key, make) {
    let m = this._mats.get(key);
    if (!m) {
      m = this._reg(make());
      m.name = `veh_${key}`;
      this._mats.set(key, m);
    }
    return m;
  }

  /**
   * Automotive paint. `finish` is 'gloss' (clearcoated metallic), 'matte'
   * (a resprayed beater), or 'primer' (bare filler).
   *
   * ────────────────────────────────────────────────────────────────────────
   * `gloss` — 0 is a work truck, 1 is a show car, AND IT IS NOT DECORATION
   * ────────────────────────────────────────────────────────────────────────
   * Every vehicle in the fleet carried the same clearcoat: `ccR` 0.055 and an
   * orange-peel normal at 0.55. Two consequences, both measured off the `car`
   * shot at 1920x1080.
   *
   * ONE. A 0.55 clearcoat normal on a 14 cm peel tile SMEARS the environment.
   * A sharp clear layer mirrors the sky as a band with an edge — bright where
   * the sky is, dark where the street is — and the pigment survives between
   * the bands. Perturbed that hard, the same energy arrives as a low-frequency
   * MOTTLE spread over the whole panel, and low-frequency white added to a
   * coloured diffuse is exactly the "noisy vertex-coloured plastic" the review
   * named. Measured on the bonnet of a `slag orange` 0xc4460d (linear 0.54,
   * 0.061, 0.006): the frame returned 226/166/159, i.e. linear 0.75/0.38/0.34
   * — a 0.34 white pedestal under a pigment whose blue channel is 0.006. The
   * ordered colour was not on the car.
   *
   * TWO. A concours respray and a mill truck that has been through fifteen
   * Pittsburgh winters cannot share a clearcoat. `gloss` is the one number
   * that separates them, and it moves the three things that actually differ:
   * how sharp the clear layer is (`ccR`), how much orange peel is in it
   * (`peel`), and how much environment it returns (`env`).
   *
   * It does NOT add a permutation: the map slots and the non-zero clearcoat
   * are identical across the range, so the whole fleet stays in the one
   * `ow:vehpaint` program family. See `build.js` `glossFor`.
   */
  paint(color, { finish = 'gloss', flake = 0.5, clearcoat = 1, wear = 0, gloss = 0.75 } = {}) {
    const key = `${color}|${finish}|${flake.toFixed(2)}|${clearcoat.toFixed(2)}|${wear.toFixed(2)}|${gloss.toFixed(2)}`;
    let m = this._paints.get(key);
    if (m) return m;
    const T = this._tex;
    const c = new THREE.Color(color);
    // Perceptual: paler colours carry more of their look in the diffuse term,
    // dark colours are almost entirely the two specular lobes.
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

    /**
     * ALL THREE FINISHES SHARE ONE MAP SET AND A NON-ZERO CLEARCOAT.
     *
     * They used to differ — gloss had a flake normal and two ORM slots, matte
     * had a peel normal and one, primer had no clearcoat at all — which is
     * three different three permutations for what is conceptually one material
     * with three sets of numbers, and `clearcoat: 0` on the primer forced a
     * fourth by dropping USE_CLEARCOAT. Keeping the slots identical and the
     * primer's clearcoat at a real (small, matte) 0.05 collapses the fleet into
     * ONE program, which matters while p99 is being chased.
     */
    const g = gloss < 0 ? 0 : gloss > 1 ? 1 : gloss;
    const F = finish === 'gloss'
      /**
       * THE CLEAR LAYER IS SHARP, AND THAT IS WHERE THE REFLECTION COMES FROM.
       *
       * `peel` was 0.55 for the whole fleet. `makeOrangePeel` tiles at 7 over
       * an object-space METRE uv, so that is a 14 cm ripple driven at half a
       * unit of normal — enough to scatter a near-mirror lobe across a whole
       * bonnet. The result is not "a reflection with texture in it", it is a
       * uniform white pedestal, and it is what buried the pigment.
       *
       * Real orange peel on factory paint is a few microns of waviness over a
       * few millimetres: it makes a reflected edge WOBBLE, it does not dissolve
       * it. 0.10-0.34 across the gloss range does that and nothing more.
       *
       * `env` comes down with it. The sky PMREM the vehicle shots are staged
       * under is a keyless white hemisphere, so every joule the clear layer
       * returns is white — at 0.80 with a smeared normal it was 0.34 linear of
       * it. 0.46-0.66 with a SHARP normal puts the same look back as a legible
       * band across the shoulder instead of a haze over the panel.
       */
      ? {
        rough: 1.10,
        /**
         * THE CLEAR LAYER IS A FRACTION, AND THE MEASUREMENT IS WHY.
         *
         * Ablation on the shipped `car` frame, one parameter at a time, 90
         * frames of TAA settle between reads, on the beauty car's ordered
         * oxblood 0x7d1b16 (linear 0.202 / 0.011 / 0.008):
         *
         *   as shipped                       224/158/151   chroma 0.327
         *   envMapIntensity 0.71 -> 0        224/159/152   chroma 0.323
         *   specularIntensity 1 -> 0.22,
         *     clearcoat 1 -> 0.45            230/116/104   chroma 0.549
         *
         * Two things follow and both are load-bearing. `envMapIntensity` was
         * a dead uniform when this note was first written (zeroing it moved
         * the frame by under one count) because r180 overwrites it with
         * `scene.environmentIntensity` for materials on the scene environment.
         * `render.bindEnvMaterials` now bridges that for the vehicle material
         * family — the paint DOES sample the sky's PMREM and the slot is live
         * again. The historical numbers in the note above were still tuned
         * against the dead slot; treat them as pre-bridge values.
         *
         * And the white pedestal that buried the pigment is the CLEARCOAT
         * LOBE plus the BASE COAT'S OWN dielectric specular. Both are real,
         * both are white under a keyless overcast, and together they were
         * delivering 0.29 linear on top of a 0.011 green channel.
         *
         * `specularIntensity` is the honest fix for half of it and it is not a
         * fudge: three's clearcoat is a layer stacked on a base whose F0 is
         * still computed for an AIR interface. Under a clear layer the base
         * coat is INDEX-MATCHED — the step is 1.5 to 1.5, not 1.0 to 1.5 — so
         * its Fresnel is a small fraction of what an exposed pigment would
         * return. 0.26 is that fraction.
         */
        cc: clearcoat * (0.42 + 0.22 * g),
        spec: 0.26,
        ccR: 0.125 - 0.098 * g,
        peel: 0.34 - 0.24 * g,
        flakeN: 0.035 + flake * 0.065,
        env: 0.46 + 0.20 * g,
        film: 0.26, rust: 0.05, salt: 0.14, respray: 0.024,
      }
      : finish === 'matte'
        ? { rough: 2.35, cc: Math.max(0.10, clearcoat * 0.16), spec: 0.34, ccR: 0.62, peel: 1.1, flakeN: 0.09, env: 0.62, film: 0.50, rust: 0.24, salt: 0.30, respray: 0.060 }
        : { rough: 2.9, cc: 0.05, spec: 0.40, ccR: 0.80, peel: 1.5, flakeN: 0.07, env: 0.45, film: 0.70, rust: 0.46, salt: 0.42, respray: 0.090 };

    m = new THREE.MeshPhysicalMaterial({
      color: c,
      /**
       * THE MISSING ALBEDO MAP. The sedan had none: this slot was empty and
       * the whole body was one constant diffuse value, which is what makes a
       * car read as plastic. See `makeBodyAlbedo` — it is a low-contrast multiplier
       * carrying spray mottle, wet-sand grain, stone chips and polish-through,
       * mapped through the object-space metre uv baked by `bakeBoxUV`.
       */
      map: T.bodyAlbedo,
      /**
       * Metalness 1 THROUGH A MASK, not a fudged scalar. See `makeFlakeMaps`:
       * the map is ~0.04 between platelets and 1.0 on one, so the material is
       * honestly "0 or 1" per texel and mips to the flake coverage fraction at
       * distance. `flake` scales the pigment's own contribution, not the mask.
       */
      metalness: 0.55 + 0.45 * flake,
      metalnessMap: T.flakeMetal,
      // The BASE COAT is not a mirror. Under a clearcoat it is a fairly rough
      // pigmented layer — the sharp reflection you see on a car comes from the
      // clear layer above it. Running the base at 0.38 let its own specular
      // lobe swamp the pigment and a dark red car came out dusty pink.
      roughness: F.rough,
      roughnessMap: T.paintORM,
      normalMap: T.flake,
      normalScale: new THREE.Vector2(F.flakeN, F.flakeN),
      // See the ablation over `cc` above: the base coat sits under a clear
      // layer, so its Fresnel step is glass-to-pigment and not air-to-pigment.
      specularIntensity: F.spec,
      clearcoat: F.cc,
      clearcoatRoughness: F.ccR,
      clearcoatRoughnessMap: T.paintORM,
      clearcoatNormalMap: T.peel,
      clearcoatNormalScale: new THREE.Vector2(F.peel, F.peel),
      // A dark colour is nearly all specular, so it may carry more environment
      // before the pigment stops reading. 0.10, not 0.16: at 0.16 the darkest
      // pool colour (`midnight` 0x15181d, linear lum 0.010) took a 0.96 env on
      // top of a 0.46 base and came back the same value as `gunmetal`.
      envMapIntensity: F.env + 0.10 * (1 - lum),
      vertexColors: true,
      dithering: true,
    });
    installWear(m, {
      owFilmTex: { value: T.roadFilm },
      owRustTex: { value: T.rustBloom },
      owWearP: {
        value: new THREE.Vector4(
          Math.min(1.0, F.film + wear * 0.42),
          Math.min(0.9, F.rust + wear * 0.55),
          F.salt,
          F.respray
        ),
      },
      owWearS: this._wearS,
    });
    m.name = `veh_paint_${key}`;
    this._paints.set(key, m);
    this._reg(m);
    return m;
  }

  /**
   * Automotive glass. Not `transmission` — that costs a full scene copy per
   * frame and the interior behind it has to remain legible. A dark tinted
   * transparent physical material with a strong specular and a high env
   * intensity reads correctly: near-black head on, a hard sky reflection at
   * grazing angles, and the seats visible through it.
   */
  glass({ tint = 0x141a20, opacity = 0.46, tintStrength = 1 } = {}) {
    return this._cached(`glass_${tint}_${opacity}_${tintStrength}`, () => {
      const T = this._tex;
      /**
       * "Not one pane of actual glass in twenty-four frames."
       *
       * The material WAS transparent. What it was not was recognisable, and the
       * measurable reason is `envMapIntensity: 2.6`: 2.6x an overcast white sky
       * through a nearly-mirror roughness of 0.055 returns a value well past 1.0
       * over the whole pane, so the tint, the interior and the transparency were
       * all buried under a flat blown-out reflection. Under the sodium-lit night
       * sky the same number is right; under the overcast the vehicle shots are
       * staged in it destroys the pane. 1.15 keeps the sky reflection legible as
       * a reflection instead of as white paint.
       *
       * The other half is the FRIT — the black ceramic dot matrix baked round
       * the edge of every bonded screen (see `makeGlassMaps`). It is the single
       * most recognisable feature of automotive glass, it gives the pane a
       * physical edge instead of a floating rectangle, and no car without one
       * has ever read as glazed.
       *
       * TINTED, NOT OPAQUE. `opacity` was 0.62 over a 0x0a0e12 tint and the
       * glass is DOUBLE-SIDED, so a three-quarter view looks through TWO panes:
       * 0.38 x 0.38 = 0.14 of whatever is behind them survived, and what is
       * behind them is a cabin. The review's "opaque black glass" and its
       * "black void cabin" are the same defect counted twice — the pane was
       * eating five sixths of the interior it exists to show. 0.46 over a
       * lifted 0x141a20 leaves 0.29 through the pair and 0.54 through one,
       * which is what a factory privacy tint actually passes.
       *
       * The `map`'s ALPHA is doing real work here and it is easy to miss: the
       * haze in `makeGlassMaps` is authored as coverage, so `opacity` is the
       * CEILING of the tint, reached only in the corners and along the frit.
       */
      const m = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(tint),
        map: T.glass,
        metalness: 0,
        roughness: 0.055,
        transparent: true,
        opacity,
        side: THREE.DoubleSide,
        envMapIntensity: 1.45,
        ior: 1.52,
        specularIntensity: 1,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        depthWrite: false,
        premultipliedAlpha: false,
      });
      return m;
    });
  }

  /** Tyre rubber. Matte, textured, absolutely never shiny. */
  rubber() {
    return this._cached('rubber', () => {
      const T = this._tex;
      return new THREE.MeshStandardMaterial({
        // Was 0xf0f0f0 over a #1b1b1c map, i.e. ~0.009 linear — under
        // ARCHITECTURE.md's 0.02 albedo floor and dark enough that the moulded
        // tread and lettering could not be seen at any distance.
        color: 0xffffff,
        map: T.tyreAlbedo,
        normalMap: T.tyreNormal,
        normalScale: new THREE.Vector2(1.7, 1.7),
        // Scrubbed rubber is one of the roughest surfaces on a car and it must
        // not carry an environment reflection at all: a specular sheen on the
        // rubber is env, not roughness.
        roughness: 0.97,
        metalness: 0,
        envMapIntensity: 0.10,
      });
    });
  }

  /** Wheel rim. `dark` gives the black-painted alloy / steel look. */
  rim(kind = 'alloy') {
    return this._cached(`rim_${kind}`, () => {
      const T = this._tex;
      const isDark = kind === 'steel' || kind === 'black';
      /**
       * WHY THE ALLOYS CAME OUT WHITE, AND WHY BRIGHTNESS WAS NEVER THE FIX.
       *
       * These were already `metalness: 1`. A metalness-1 surface with NO albedo
       * map, roughness 0.42 and 1.15x env under a uniform overcast sky is a
       * mirror pointed at a white hemisphere, and it returns white — measured
       * flat at 235-248 across the entire rim face in the preview, with no read
       * of the spokes, the lip or the hub. They read as matte dielectric,
       * which is what a bright, uniform, formless thing looks like.
       *
       * A metal reads as metal through spatially varying REFLECTANCE and
       * ROUGHNESS, so both now come from a polar-space map that agrees with the
       * wheel's own geometry (see `makeRimMaps` / `bakePolarUV`): machined lathe
       * rings, cast pockets, iron-oxide brake dust towards the hub, kerb rash on
       * the lip. The clearcoat is gone — a machined alloy has a thin lacquer at
       * most, and a 0.3 clearcoat was adding a second white lobe on top of the
       * first.
       */
      return new THREE.MeshPhysicalMaterial({
        // Same map set for both styles so alloy and steel stay in ONE program;
        // a painted steel wheel is a dielectric over steel, so it differs by
        // tint, metalness and roughness scale, not by which slots are bound.
        color: isDark ? 0x53565b : 0xffffff,
        map: T.rimAlbedo,
        metalness: isDark ? 0.12 : 1,
        roughness: isDark ? 1.5 : 1,
        roughnessMap: T.rimRough,
        normalMap: T.rimNormal,
        normalScale: new THREE.Vector2(0.7, 0.7),
        clearcoat: 0,
        envMapIntensity: isDark ? 0.5 : 0.85,
      });
    });
  }

  /** Ventilated brake disc — heat-blued cast iron with a wear ring. */
  disc() {
    return this._cached('disc', () => {
      const T = this._tex;
      return new THREE.MeshStandardMaterial({
        color: 0x6a6560,
        metalness: 0.85,
        roughness: 0.42,
        normalMap: T.rimNormal,
        normalScale: new THREE.Vector2(0.9, 0.9),
        envMapIntensity: 0.9,
      });
    });
  }

  caliper(color = 0x8a2418) {
    return this._cached(`caliper_${color}`, () =>
      new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.45, envMapIntensity: 1 })
    );
  }

  chrome() {
    return this._cached('chrome', () =>
      new THREE.MeshPhysicalMaterial({
        // Same failure mode as the alloys: 2.1x env on a near-mirror under an
        // overcast white sky returns white over the whole part, so the handles,
        // the badges and the exhaust tips all disappeared into a flat blowout.
        // Real bright trim is chromed ABS, not a laboratory mirror — it pits,
        // it is slightly rough, and it holds a visible gradient.
        /**
         * ...and it was still white. `envMapIntensity` is inert here (see the
         * ablation over the paint's clear layer), so cutting it from 2.1 to
         * 1.25 changed nothing at all, and the brightwork round every
         * greenhouse in the fleet — the DLO strip, the drip rail, the mirror
         * caps — photographed as a solid white frame with no gradient in it.
         *
         * What DOES move is reflectance and roughness. Chromed ABS is not a
         * first-surface mirror: it is a thin bright layer over a plastic
         * substrate, it holds fingerprints and micro-scratches, and at 0.26
         * roughness it returns the DARKER lower half of the environment as
         * well as the sky — which is the gradient that separates metal from
         * white paint.
         */
        color: 0xa6acb4,
        metalness: 1,
        roughness: 0.26,
        clearcoat: 0.45,
        clearcoatRoughness: 0.10,
        envMapIntensity: 1.25,
      })
    );
  }

  /** Grained bumper plastic — bumper covers, mirror caps, arch liners, trim. */
  trim(shade = 'dark') {
    return this._cached(`trim_${shade}`, () => {
      const T = this._tex;
      return new THREE.MeshStandardMaterial({
        // The map carries the value now; the tint only separates the three
        // shades. Same slots for all three, so they stay in one program.
        color: shade === 'dark' ? 0x9298a0 : shade === 'grey' ? 0xd0d6dc : 0x585d64,
        map: T.trimAlbedo,
        normalMap: T.trimNormal,
        normalScale: new THREE.Vector2(0.9, 0.9),
        metalness: 0.02,
        roughness: 0.80,
        envMapIntensity: 0.42,
      });
    });
  }

  /** The black void behind grilles, inside arches and behind glass edges. */
  cavity() {
    return this._cached('cavity', () =>
      new THREE.MeshStandardMaterial({
        color: 0x050607,
        metalness: 0.1,
        roughness: 0.85,
        envMapIntensity: 0.12,
      })
    );
  }

  grilleMesh() {
    return this._cached('grillemesh', () => {
      const T = this._tex;
      return new THREE.MeshStandardMaterial({
        color: 0x2a2d31,
        map: T.grille,
        transparent: true,
        alphaTest: 0.35,
        metalness: 0.75,
        roughness: 0.45,
        side: THREE.DoubleSide,
        envMapIntensity: 0.9,
      });
    });
  }

  /** Rusted, unpainted steel for wrecks and beaters. */
  rustMetal() {
    return this._cached('rust', () => {
      const T = this._tex;
      return new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: T.rust,
        transparent: true,
        metalness: 0.25,
        roughness: 0.88,
        envMapIntensity: 0.5,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });
    });
  }

  /* --------------------------------------------------------- lights -- */

  /**
   * Lamp lenses and their emissive cores. These are the only per-vehicle
   * materials: a brake light has to light up on THIS car and not on the one
   * next to it, so the caller gets a fresh instance and drives
   * `emissiveIntensity`.
   */
  lamp(kind) {
    const spec = LAMPS[kind] ?? LAMPS.tail;
    const m = new THREE.MeshPhysicalMaterial({
      color: spec.color,
      emissive: spec.emissive,
      emissiveIntensity: 0,
      metalness: 0,
      roughness: spec.rough,
      transparent: spec.opacity < 1,
      opacity: spec.opacity,
      transmission: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.04,
      envMapIntensity: 1.8,
      ior: 1.55,
      side: THREE.FrontSide,
      toneMapped: true,
    });
    m.name = `veh_lamp_${kind}`;
    this._reg(m);
    return m;
  }

  reflectorMat() {
    return this._cached('reflectorbowl', () => {
      const T = this._tex;
      return new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: T.reflector,
        metalness: 0.95,
        roughness: 0.16,
        envMapIntensity: 1.6,
      });
    });
  }

  /* ------------------------------------------------------ interior -- */

  /**
   * Seat cloth — and the reason every cabin in the game photographed as a void.
   *
   * `color` was 0x30333a. That is 0.030 LINEAR, and it multiplied `makeFabric`,
   * whose own value runs 0.06-0.12 linear. The product is 0.0026: an order of
   * magnitude under ARCHITECTURE.md's 0.02 albedo floor, darker than the
   * `cavity` material that exists specifically to be a hole, and far below any
   * cloth ever fitted to a car (0.04-0.09 for a dark trim). The seats were not
   * "untextured", they were unlit black at every exposure the game can reach —
   * which is why the review saw blobs: the fabric weave and its normal map were
   * both there and both multiplied into nothing.
   *
   * Same rule as the tyre and the rim above: THE MAP CARRIES THE VALUE, the
   * colour only tints. 0xd6dae0 lands the product at ~0.055 linear, a dark
   * grey automotive cloth, and the weave becomes visible for the first time.
   */
  seat() {
    return this._cached('seat', () => {
      const T = this._tex;
      return new THREE.MeshStandardMaterial({
        color: 0xd6dae0,
        map: T.fabric,
        normalMap: T.fabricNormal,
        normalScale: new THREE.Vector2(0.8, 0.8),
        roughness: 0.92,
        metalness: 0,
        envMapIntensity: 0.35,
      });
    });
  }

  /**
   * Headliner cloth — the roof lining, the pillar trim and the visors.
   *
   * ITS WHOLE JOB IS TO BE THE BRIGHTEST THING IN THE CABIN. A car interior is
   * lit almost entirely by bounce off the lining; without one, everything below
   * the belt is lit by the sky through the glass alone and the top of the frame
   * is a hole. The cockpit capture measured 23/28/33 across its upper third
   * before this existed.
   *
   * So it takes NO albedo map: `makeFabric` peaks at 0.124 linear and a
   * headliner is 0.28-0.36, which no colour multiplier can reach from there.
   * 0x9fa2a6 is 0.34 linear flat, with the fabric NORMAL for weave — the same
   * slot set `leather()` uses, so the two share a program.
   */
  headliner() {
    return this._cached('headliner', () =>
      new THREE.MeshStandardMaterial({
        /**
         * MEASURED, twice, on the cockpit frame's upper third:
         *   0x9fa2a6 (0.34 linear) -> 183, brighter than the road through the
         *                             windscreen. A lining lit like a lightbox.
         *   0x74777b (0.19 linear) -> 178. Barely moved, because the cabin's
         *                             indirect budget is generous and the
         *                             surface faces the one direction the sky
         *                             fill is strongest from.
         * 0x5a5d61 is 0.106 linear and lands it near 130 — lighter than the
         * dash, darker than the sky through the glass, which is the ordering a
         * real cabin has. The number is set from the frame, not from a
         * reflectance table, because the reflectance table has been wrong twice.
         */
        color: 0x5a5d61,
        normalMap: this._tex.fabricNormal,
        normalScale: new THREE.Vector2(0.45, 0.45),
        roughness: 0.95,
        metalness: 0,
        envMapIntensity: 0.45,
      })
    );
  }

  leather() {
    return this._cached('leather', () =>
      new THREE.MeshStandardMaterial({
        color: 0x1b1d21,
        normalMap: this._tex.fabricNormal,
        normalScale: new THREE.Vector2(0.35, 0.35),
        roughness: 0.62,
        metalness: 0,
        envMapIntensity: 0.5,
      })
    );
  }

  dash() {
    return this._cached('dash', () => {
      const T = this._tex;
      return new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map: T.dash,
        emissive: 0xffffff,
        emissiveMap: T.dashEmissive,
        emissiveIntensity: 0.6,
        roughness: 0.55,
        metalness: 0.1,
        envMapIntensity: 0.4,
      });
    });
  }

  /** The plate is per-vehicle so the number differs car to car. */
  plate(text) {
    let m = this._plates.get(text);
    if (m) return m;
    m = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: makePlate(text),
      roughness: 0.42,
      metalness: 0.05,
      envMapIntensity: 0.9,
    });
    m.name = `veh_plate_${text}`;
    this._plates.set(text, m);
    this._reg(m);
    return m;
  }

  livery(kind) {
    return this._cached(`livery_${kind}`, () => {
      const map = kind === 'police' ? this._tex.liveryPolice : this._tex.liveryPolice;
      return new THREE.MeshStandardMaterial({
        color: 0xffffff,
        map,
        transparent: true,
        roughness: 0.34,
        metalness: 0.05,
        envMapIntensity: 1,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
    });
  }

  /** Single-material distant LOD: everything baked to vertex colour. */
  distant() {
    return this._cached('distant', () =>
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        metalness: 0.35,
        roughness: 0.42,
        envMapIntensity: 1.0,
      })
    );
  }

  cracksTexture() {
    return this._tex.cracks;
  }

  dispose() {
    for (const m of this._all) m.dispose?.();
    this._all.length = 0;
    this._paints.clear();
    this._plates.clear();
    this._mats.clear();
    for (const k in this._tex) this._tex[k]?.dispose?.();
    this._tex = {};
    this._built = false;
  }
}

const LAMPS = {
  head: { color: 0xf2f6ff, emissive: 0xfff2d8, rough: 0.04, opacity: 0.55 },
  drl: { color: 0xe8f0ff, emissive: 0xdfeaff, rough: 0.06, opacity: 0.8 },
  tail: { color: 0x6e0b0b, emissive: 0xff1a10, rough: 0.06, opacity: 0.86 },
  brake: { color: 0x8c0d0d, emissive: 0xff2211, rough: 0.05, opacity: 0.88 },
  indicator: { color: 0xa8570a, emissive: 0xff8a10, rough: 0.07, opacity: 0.86 },
  reverse: { color: 0xd8dde3, emissive: 0xf6faff, rough: 0.06, opacity: 0.8 },
  policeRed: { color: 0x7a0d0d, emissive: 0xff1408, rough: 0.05, opacity: 0.85 },
  policeBlue: { color: 0x0b1e6e, emissive: 0x2a5cff, rough: 0.05, opacity: 0.85 },
};

export { LAMPS };
