/**
 * ===========================================================================
 * VITALS — the arcs on the Slag Ring, the stars, the money, the weapon
 * ===========================================================================
 *
 * The rule this file exists to obey: **the centre of the screen stays empty**,
 * and every readout is either attached to the ring or pinned to a corner. If a
 * value is not changing and is not dangerous, its widget fades out.
 *
 * Health and armour are drawn as two arcs flanking the bottom of the iron ring,
 * meeting at six o'clock and filling outward — health to the left, armour to
 * the right. That reads as one gauge cluster instead of two bars, it costs no
 * horizontal space, and it keeps the player's eye on the map instead of on a
 * corner of the screen.
 */

import { el, setText, setStyle, setClass, clamp, clamp01, damp, lerp, ease } from './util.js';
import { drawWeaponGlyph } from './glyphs.js';
import { star as starPath, roundRect } from './citymap.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARC_DEG = 114; // sweep of a full gauge
/** Degrees of clearance either side of six o'clock, for the district tag. */
const ARC_GAP = 9;

function svgEl(tag, attrs, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}

/* ------------------------------------------------------- health / armour -- */

export class VitalArcs {
  constructor(parent) {
    this.root = svgEl('svg', { class: 'ow-vitals', viewBox: '0 0 100 100' }, parent);

    // Both gauges start just off six o'clock and sweep upward — health up the
    // left flank, armour up the right — so they read as one cluster, the top of
    // the bezel stays clear for the north pip and the bottom stays clear for
    // the district tag.
    this.health = this._gauge(54, 1);
    this.armour = this._gauge(54, -1);

    this.hv = 1;
    this.av = 0;
    this.flash = 0;
  }

  _gauge(r, sign) {
    const g = svgEl('g', {
      // sign -1 mirrors the gauge onto the left flank of the ring
      transform: sign < 0 ? 'translate(100,0) scale(-1,1)' : '',
    }, this.root);
    const C = 2 * Math.PI * r;
    const span = (ARC_DEG / 360) * C;
    const common = {
      cx: 50, cy: 50, r,
      fill: 'none',
      'stroke-linecap': 'butt',
      // 90deg puts the dash start at six o'clock and a circle path runs
      // clockwise (i.e. up the LEFT flank) from there; ARC_GAP holds it off the
      // bottom centre, and the -1 gauge is mirrored onto the right flank.
      transform: `rotate(${90 + ARC_GAP} 50 50)`,
      'stroke-dasharray': `${span} ${C - span}`,
    };
    const track = svgEl('circle', {
      ...common, stroke: 'rgba(5,8,12,.9)', 'stroke-width': 6.0,
    }, g);
    const shadow = svgEl('circle', {
      ...common, stroke: 'rgba(158,176,198,.30)', 'stroke-width': 6.0,
    }, g);
    /**
     * THE FILL IS THICKER THAN THE GAP AROUND IT, not thinner.
     * At 3.2 against a 5.2 track the coloured arc was a hairline inside a grey
     * one and at a glance the gauge read as "a ring", not as "a ring that is
     * two-thirds full" — the empty part was the loudest thing in it. 4.6 inside
     * 6.0 leaves a 0.7 dark margin either side, which is enough to keep the arc
     * separated from the bezel and puts the contrast on the VALUE.
     */
    const fill = svgEl('circle', {
      ...common, stroke: '#41e08a', 'stroke-width': 4.6,
      'stroke-linecap': 'round',
    }, g);
    /**
     * The gauge names itself at its FOOT, just outside the bezel.
     *
     * Two unlabelled arcs flanking a ring are a guess: green-on-the-left is a
     * convention this game never taught anybody, and the one thing a player
     * checks a HUD for is which number is about to kill him. Outside the ring
     * rather than inside it — inside is the live map — and 18 degrees up from
     * the arc's start, which clears the district tag at six o'clock and puts
     * the two labels a comfortable distance apart at the bottom corners.
     */
    const la = ((90 + ARC_GAP + 18) / 180) * Math.PI;
    const lx = 50 + Math.cos(la) * (r + 6);
    const ly = 50 + Math.sin(la) * (r + 6);
    const label = svgEl('text', {
      x: lx.toFixed(2),
      y: ly.toFixed(2),
      'text-anchor': 'middle',
      'dominant-baseline': 'middle',
      // The mirrored gauge would otherwise print its label backwards.
      transform: sign < 0 ? `translate(${(2 * lx).toFixed(2)},0) scale(-1,1)` : '',
      fill: 'rgba(210,222,234,.8)',
      'font-family': 'var(--fm)',
      'font-size': '5.4',
      'letter-spacing': '.55',
      style: 'paint-order:stroke;stroke:rgba(4,7,10,.92);stroke-width:1.8',
    }, g);
    label.textContent = sign < 0 ? 'ARM' : 'HP';
    return { g, track, shadow, fill, label, C, span };
  }

  _set(gauge, frac, colour) {
    const len = gauge.span * clamp01(frac);
    setStyle(gauge.fill, 'stroke-dasharray', `${len.toFixed(2)} ${(gauge.C - len).toFixed(2)}`);
    setStyle(gauge.fill, 'stroke', colour);
  }

  update(dt, s) {
    const hFrac = clamp01(s.health / Math.max(1, s.maxHealth));
    const aFrac = clamp01(s.armour / Math.max(1, s.maxArmour));
    this.hv = damp(this.hv, hFrac, 11, dt);
    this.av = damp(this.av, aFrac, 11, dt);

    // Health reads green while it is not a problem and swings through amber to
    // red as it drops — the colour IS the warning, so nothing has to blink.
    const t = clamp01((this.hv - 0.12) / 0.5);
    const r = Math.round(lerp(255, 65, t));
    const g = Math.round(lerp(59, 224, ease.outQuad(t)));
    const b = Math.round(lerp(78, 138, t));
    let colour = `rgb(${r},${g},${b})`;
    if (this.hv < 0.26) {
      this.flash = (this.flash + dt * 2.6) % 1;
      const k = 0.72 + 0.28 * Math.sin(this.flash * Math.PI * 2);
      colour = `rgba(255,59,78,${k.toFixed(2)})`;
    }
    this._set(this.health, this.hv, colour);
    this._set(this.armour, this.av, '#5fd0ff');
    setStyle(this.armour.g, 'opacity', this.av < 0.005 ? '0.22' : '1');
  }

  dispose() {
    this.root.remove();
  }
}

/* --------------------------------------------------------- wanted stars --- */

/**
 * Five stars, GTA's grammar: earned stars are gold and solid, the star you are
 * about to lose flashes, and the whole rack flashes while you are inside the
 * search cordon but not spotted. A thin bar under the rack runs down as the
 * cooldown drains, which is the one piece of information GTA V hides and every
 * player wishes it showed.
 */
export class WantedStars {
  constructor(parent) {
    this.root = el('div', 'ow-wanted', parent);
    const svg = svgEl('svg', { viewBox: '0 0 132 26', class: 'ow-stars' }, this.root);
    this.stars = [];
    for (let i = 0; i < 5; i++) {
      const g = svgEl('g', { transform: `translate(${i * 26 + 13} 13)` }, svg);
      const back = svgEl('path', { d: this._star(11.4), class: 'back' }, g);
      const fill = svgEl('path', { d: this._star(9.6), class: 'fill' }, g);
      this.stars.push({ g, back, fill, on: 0, pop: 0 });
    }
    const bar = el('div', 'ow-wanted-bar', this.root);
    this.decay = el('i', null, bar);
    this.bar = bar;

    this.level = 0;
    this.shown = 0;
    this.blink = 0;
    this.cool = 1;
  }

  _star(r) {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const rr = i % 2 ? r * 0.44 : r;
      d += (i ? 'L' : 'M') + (Math.cos(a) * rr).toFixed(2) + ' ' + (Math.sin(a) * rr).toFixed(2);
    }
    return d + 'Z';
  }

  set(level, cooldown) {
    if (level > this.level) {
      for (let i = this.level; i < level; i++) this.stars[i].pop = 1;
    }
    this.level = clamp(level | 0, 0, 5);
    if (cooldown !== undefined) this.cool = clamp01(cooldown);
  }

  update(dt) {
    this.blink = (this.blink + dt * 3.1) % 1;
    const flick = this.blink < 0.5;
    for (let i = 0; i < 5; i++) {
      const st = this.stars[i];
      const on = i < this.level;
      // The top star flashes only when the cooldown is nearly spent — you are
      // about to lose it. Flashing it for the whole decay (the first pass) made
      // three stars read as two in any still frame, and the floor is 0.45 so it
      // never reads as unlit even mid-blink.
      const dim = on && i === this.level - 1 && this.cool < 0.34 && flick;
      st.on = damp(st.on, on ? 1 : 0, 16, dt);
      st.pop = Math.max(0, st.pop - dt * 3.6);
      const pop = 1 + ease.outBack(clamp01(1 - st.pop)) * 0 + st.pop * 0.55;
      setStyle(st.g, 'transform', `translate(${i * 26 + 13}px, 13px) scale(${pop.toFixed(3)})`);
      setStyle(st.fill, 'opacity', (st.on * (dim ? 0.45 : 1)).toFixed(3));
      setStyle(st.back, 'opacity', on ? '1' : '0.5');
    }
    setStyle(this.bar, 'opacity', this.level > 0 && this.cool < 0.999 ? '1' : '0');
    setStyle(this.decay, 'transform', `scaleX(${this.cool.toFixed(3)})`);
    return this.level > 0 ? 1 : 0;
  }

  dispose() {
    this.root.remove();
  }
}

/* --------------------------------------------------------------- money --- */

/**
 * The counter rolls. A jump straight to the new total reads as a bug; a
 * 0.55 s eased roll with the delta pinned underneath reads as a payout.
 */
export class MoneyCounter {
  constructor(parent) {
    this.root = el('div', 'ow-money', parent);
    this.value = el('div', 'ow-money-v', this.root, '$0');
    this.delta = el('div', 'ow-money-d', this.root, '');
    this.total = 0;
    this.shown = 0;
    this.deltaV = 0;
    this.deltaT = 0;
    this.hold = 0;
    this._txt = '';
  }

  set(total, delta) {
    if (delta) {
      this.deltaV = delta;
      this.deltaT = 2.6;
      this.hold = 3.4;
    }
    this.total = total;
  }

  update(dt) {
    const before = this.shown;
    this.shown = damp(this.shown, this.total, 7.5, dt);
    if (Math.abs(this.shown - this.total) < 0.7) this.shown = this.total;
    const n = Math.round(this.shown);
    const txt = '$' + n.toLocaleString('en-US');
    if (txt !== this._txt) {
      this._txt = txt;
      setText(this.value, txt);
    }
    const moving = Math.abs(this.shown - before) > 0.01;
    setClass(this.value, 'up', moving && this.total > before);

    this.deltaT = Math.max(0, this.deltaT - dt);
    this.hold = Math.max(0, this.hold - dt);
    if (this.deltaT > 0) {
      const d = this.deltaV;
      setText(this.delta, (d >= 0 ? '+$' : '-$') + Math.abs(d).toLocaleString('en-US'));
      setClass(this.delta, 'neg', d < 0);
      const a = clamp01(this.deltaT / 0.45) * clamp01((2.6 - this.deltaT) / 0.18);
      setStyle(this.delta, 'opacity', a.toFixed(3));
      setStyle(this.delta, 'transform', `translateY(${(1 - clamp01((2.6 - this.deltaT) / 0.25)) * -8}px)`);
    } else {
      setStyle(this.delta, 'opacity', '0');
    }
    return this.hold > 0 || Math.abs(this.shown - this.total) > 0.5 ? 1 : 0;
  }

  dispose() {
    this.root.remove();
  }
}

/* -------------------------------------------------------------- respect --- */

/**
 * The second currency, under the money and in the same grammar: an eased roll
 * with the delta pinned underneath, faded out unless it just moved. Respect
 * exists in `game`'s HUD state (`getHudState().respect`) and was previously
 * displayed nowhere outside a toast; this is the persistent two-currency
 * column.
 */
export class RespectCounter {
  constructor(parent) {
    this.root = el('div', 'ow-respect', parent);
    const row = el('div', 'ow-respect-row', this.root);
    this.value = el('span', 'ow-respect-v', row, '0');
    el('span', 'ow-respect-l', row, 'RESPECT');
    this.delta = el('div', 'ow-respect-d', this.root, '');
    this.total = 0;
    this.shown = 0;
    this.deltaV = 0;
    this.deltaT = 0;
    this.hold = 0;
    this._txt = '';
  }

  set(total, delta) {
    if (delta) {
      this.deltaV = delta;
      this.deltaT = 2.6;
      this.hold = 3.4;
    }
    this.total = total;
  }

  update(dt) {
    this.shown = damp(this.shown, this.total, 7.5, dt);
    if (Math.abs(this.shown - this.total) < 0.7) this.shown = this.total;
    const txt = String(Math.round(this.shown));
    if (txt !== this._txt) {
      this._txt = txt;
      setText(this.value, txt);
    }
    this.deltaT = Math.max(0, this.deltaT - dt);
    this.hold = Math.max(0, this.hold - dt);
    if (this.deltaT > 0) {
      const d = this.deltaV;
      setText(this.delta, (d >= 0 ? '+' : '-') + Math.abs(d));
      setClass(this.delta, 'neg', d < 0);
      const a = clamp01(this.deltaT / 0.45) * clamp01((2.6 - this.deltaT) / 0.18);
      setStyle(this.delta, 'opacity', a.toFixed(3));
    } else {
      setStyle(this.delta, 'opacity', '0');
    }
    return this.hold > 0 || Math.abs(this.shown - this.total) > 0.5 ? 1 : 0;
  }

  dispose() {
    this.root.remove();
  }
}

/* ------------------------------------------------ vehicle meter cluster --- */

/**
 * ===========================================================================
 * THE SEATED CLUSTER — one widget, two instrument faces
 * ===========================================================================
 *
 * Vehicle health, fuel and nitro while driving. Fuel is a live mechanic (the
 * tank runs dry, six gas stations exist) and without this widget the HUD says
 * nothing at all about it.
 *
 * Everything it reads is optional and per-field:
 *   vehicles.getHudState()  -> health, fuel, fuelDry, noFuel, speedKmh, rpm,
 *                              redline, gear, flying, altitude, climbRate,
 *                              rotor, submerged, drowned
 *   player.getHudState()    -> nitroFraction (0..1), nitroOn
 * A missing producer hides its row rather than drawing a lie; the cluster
 * itself only appears while seated.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FACE IS CLASS-AWARE
 * ---------------------------------------------------------------------------
 * The fleet is not one machine. A car wants speed, revs and the gear it is in;
 * an aircraft wants none of those and cannot be flown without the three it does
 * want — how high, how fast up or down, and how close the wing is to letting
 * go. `vehicles.getHudState()` has published `flying`, `altitude`, `climbRate`
 * and `rotor` since the airframes landed and NOTHING drew them, so the entire
 * flight model was flown on the sound of the engine and the horizon out of the
 * window: three bars labelled VEH / FUEL / NOS, one of which (NOS) is not even
 * a bottle on a helicopter.
 *
 * So the shared rows stay shared and the HEAD swaps: `VehicleCluster` for
 * anything with wheels, `FlightCluster` for anything with a rotor or a wing.
 * One widget rather than two, because the fuel, the hull and the drowning
 * warning are the same three facts either way and the player's eye should not
 * have to find a new corner of the screen when he takes off.
 */

/** Tach sweep and where it starts, degrees clockwise from 3 o'clock. */
const TACH_START = 138;
const TACH_SWEEP = 264;
/** Fraction of the sweep painted as the redline band. */
const TACH_REDLINE = 0.13;
/** Most forward gears any pip rack draws. The bus tops out at 8. */
const MAX_GEAR_PIPS = 8;

/**
 * The rev counter, as a ring rather than a bar: it is the one readout on a
 * dashboard that is a ring in every car ever built, and the shape carries the
 * "how close to the limiter" reading without a number.
 */
class TachRing {
  constructor(parent, px) {
    this.root = svgEl('svg', {
      viewBox: '0 0 100 100', class: 'ow-vehm-tach',
      style: `width:calc(${px}px * var(--k));height:calc(${px}px * var(--k));overflow:visible;flex:0 0 auto`,
    }, parent);
    const r = 40;
    const C = 2 * Math.PI * r;
    this.span = (TACH_SWEEP / 360) * C;
    this.C = C;
    const common = {
      cx: 50, cy: 50, r, fill: 'none',
      transform: `rotate(${TACH_START} 50 50)`,
      'stroke-linecap': 'butt',
    };
    svgEl('circle', {
      ...common, stroke: 'rgba(5,8,12,.92)', 'stroke-width': 13,
      'stroke-dasharray': `${this.span} ${C - this.span}`,
    }, this.root);
    svgEl('circle', {
      ...common, stroke: 'rgba(125,140,163,.26)', 'stroke-width': 13,
      'stroke-dasharray': `${this.span} ${C - this.span}`,
    }, this.root);
    // The redline band is part of the DIAL, not of the needle: it has to be
    // visible before you get there, which is the whole point of it.
    const red = this.span * TACH_REDLINE;
    svgEl('circle', {
      ...common, stroke: 'rgba(255,59,78,.42)', 'stroke-width': 13,
      'stroke-dasharray': `${red} ${C - red}`,
      'stroke-dashoffset': -(this.span - red),
    }, this.root);
    this.fill = svgEl('circle', {
      ...common, stroke: 'var(--slag-hot)', 'stroke-width': 9,
      'stroke-dasharray': `0 ${C}`, class: 'ow-vehm-tach-fill',
    }, this.root);
    this._v = -1;
    this._hot = null;
  }

  /** @param {number} frac rpm / redline, 0..1+ */
  set(frac) {
    const v = clamp01(frac);
    const q = Math.round(v * 400);
    if (q !== this._v) {
      this._v = q;
      const len = this.span * (q / 400);
      setStyle(this.fill, 'stroke-dasharray', `${len.toFixed(2)} ${(this.C - len).toFixed(2)}`);
    }
    const hot = v > 1 - TACH_REDLINE ? '#ff3b4e' : v > 0.72 ? 'var(--slag)' : 'var(--slag-hot)';
    if (hot !== this._hot) {
      this._hot = hot;
      setStyle(this.fill, 'stroke', hot);
    }
  }
}

/**
 * The gear rack: one pip per forward gear plus the letter the box is actually
 * in. The letter alone is what a car tells you; the rack is what tells you
 * there are three more to come, which is the thing a player misjudges on an
 * on-ramp.
 */
class GearPips {
  constructor(parent) {
    this.root = el('div', 'ow-vehm-gear', parent);
    this.root.style.cssText = 'display:flex;align-items:center;gap:calc(var(--u)*.9)';
    this.letter = el('span', 'ow-vehm-gear-l', this.root, 'N');
    this.letter.style.cssText =
      'font-family:var(--fm);font-size:calc(13px * var(--k));letter-spacing:.04em;' +
      'color:var(--gold);text-shadow:var(--sh-o1);min-width:calc(11px * var(--k));text-align:center';
    const rack = el('div', null, this.root);
    rack.style.cssText = 'display:flex;align-items:flex-end;gap:calc(2px * var(--k))';
    this.pips = [];
    for (let i = 0; i < MAX_GEAR_PIPS; i++) {
      const p = el('i', 'ow-vehm-pip', rack);
      p.style.cssText =
        'display:block;width:calc(4px * var(--k));height:calc(' + (5 + i * 0.9).toFixed(1) +
        'px * var(--k));background:rgba(125,140,163,.3);box-shadow:0 0 0 1px rgba(0,0,0,.55)';
      this.pips.push(p);
    }
    this._label = null;
    this._count = -1;
    this._lit = -2;
  }

  /** @param {string} label 'R' | 'N' | '1'.. @param {number} gears forward gears */
  set(label, gears) {
    const txt = label ?? '—';
    if (txt !== this._label) {
      this._label = txt;
      setText(this.letter, txt);
      setStyle(this.letter, 'color', txt === 'R' ? 'var(--blood)' : txt === 'N' ? 'var(--steel)' : 'var(--gold)');
    }
    const n = clamp(gears | 0, 0, MAX_GEAR_PIPS);
    if (n !== this._count) {
      this._count = n;
      for (let i = 0; i < MAX_GEAR_PIPS; i++) setStyle(this.pips[i], 'display', i < n ? '' : 'none');
    }
    // '3' lights the third pip; R and N light none.
    const lit = /^[0-9]+$/.test(txt) ? +txt : 0;
    if (lit !== this._lit) {
      this._lit = lit;
      for (let i = 0; i < n; i++) {
        setStyle(this.pips[i], 'background', i < lit ? 'var(--gold)' : 'rgba(125,140,163,.3)');
      }
    }
  }
}

/* ---------------------------------------------------------------- flight -- */

/** Tape scales, SVG units per unit of the quantity. */
const ALT_SCALE = 0.16;     // px per metre — the window spans +/- 200 m
const IAS_SCALE = 0.62;     // px per m/s
const VSI_SCALE = 1.15;     // px per m/s, +/- 20 m/s at the stops
const PITCH_SCALE = 0.85;   // px per degree of pitch on the horizon
/** Metres of altitude below which a stall is the ground, not a stall. */
const STALL_WARN_ALT = 3;
const TAPE_TOP = 6;
const TAPE_BOT = 70;

let _clipSeq = 0;

/**
 * ===========================================================================
 * FLIGHT INSTRUMENTS — altitude tape, VSI, airspeed with a stall band, an
 * artificial horizon and the rotor spool
 * ===========================================================================
 *
 * Drawn as one SVG because it is one instrument panel: the alternative is a
 * dozen absolutely-positioned divs whose alignment has to be maintained in a
 * stylesheet this subsystem does not own.
 *
 * THE STALL BAND IS REAL DATA, NOT DECORATION. `plane.js` models a critical
 * angle of attack and every airframe carries its own `Vref` (30 m/s for the
 * Skylark, 85 for the jet); `src/ui/aircraftprobe.mjs` gates every climb
 * against `1.1 * Vref` for exactly that reason. The red band is that number,
 * per airframe, and the amber above it is the 25% margin the airspeed
 * protection works to hold. A pilot who can see where the band is can fly the
 * approach; a pilot who cannot is guessing, which is what he has been doing.
 *
 * Everything moves by TRANSFORM on a group built once: no SVG geometry is
 * rebuilt per frame, and the tapes, the VSI needle and the horizon are moved by
 * writing a transform rather than by re-laying-out the panel.
 *
 * WHAT IS AND IS NOT QUANTISED (rule 5), because the answer here is not
 * "everything". Behind a change guard, so a settled instrument writes nothing:
 * the three numerals, the stall word, the spool fill and percentage, the rotor
 * name and the blade. NOT behind one: the five transform strings, which are
 * rebuilt every frame and handed to `setStyle` — its own cache drops the DOM
 * write when the string is identical, but the string is still built, and that
 * allocation is what an idle panel costs. Every `setAttribute` on this path is
 * inside a guard for the opposite reason: unlike `setStyle` it has no cache at
 * all, so an unguarded one is a real DOM write on every frame of a parked
 * aircraft.
 */
export class FlightCluster {
  constructor(parent) {
    this.root = el('div', 'ow-fl', parent);
    this.root.style.cssText = 'display:none;flex-direction:column;gap:calc(var(--u)*.8)';

    const svg = svgEl('svg', {
      viewBox: '0 0 210 96',
      style: 'width:calc(264px * var(--k));height:calc(121px * var(--k));display:block',
    }, this.root);
    this.svg = svg;
    const cy = (TAPE_TOP + TAPE_BOT) * 0.5;
    this.cy = cy;

    this.ias = this._tape(svg, 2, 40, 'IAS', 1, IAS_SCALE, 5, 20, 0, 140, 'ias');
    this.alt = this._tape(svg, 168, 40, 'ALT', -1, ALT_SCALE, 25, 100, 0, 900, 'alt');

    // ---- the stall band, inside the airspeed tape's scrolling group -------
    // Two rects, resized only when the airframe changes. Drawn FIRST so the
    // ticks read over them.
    this.stall = svgEl('rect', {
      x: 2, y: 0, width: 38, height: 0, fill: 'rgba(255,59,78,.34)', class: 'ow-fl-stall',
    }, this.ias.band);
    this.caution = svgEl('rect', {
      x: 2, y: 0, width: 38, height: 0, fill: 'rgba(255,176,58,.22)', class: 'ow-fl-caution',
    }, this.ias.band);
    this._vref = -1;

    this._horizon(svg, 46, 144, cy);
    this._vsi(svg, 148, cy);
    this._spool(svg);

    this.wpulse = 0;
    this._blade = 0;
    this._wroteIas = null;
    this._wroteAlt = null;
    this._wroteVsi = null;
    this._wroteWarn = null;
    this._wroteSpool = -1;
    this._wroteBlade = null;
  }

  /**
   * A vertical tape: a clipped window, a scrolling group of ticks, and a fixed
   * readout box on the centre line. `dir` puts the ticks on the left (-1) or
   * the right (+1) of the column.
   */
  _tape(svg, x0, w, label, dir, scale, step, majorStep, lo, hi, cls) {
    const id = `owtape${++_clipSeq}`;
    const clip = svgEl('clipPath', { id }, svg);
    svgEl('rect', { x: x0, y: TAPE_TOP, width: w, height: TAPE_BOT - TAPE_TOP }, clip);
    svgEl('rect', {
      x: x0, y: TAPE_TOP, width: w, height: TAPE_BOT - TAPE_TOP,
      fill: 'rgba(6,9,14,.62)', stroke: 'rgba(125,140,163,.3)', 'stroke-width': 0.6,
    }, svg);

    const win = svgEl('g', { 'clip-path': `url(#${id})` }, svg);
    const band = svgEl('g', {}, win);
    const g = svgEl('g', {}, win);
    const tickX = dir > 0 ? x0 : x0 + w;
    const sgn = dir > 0 ? 1 : -1;
    for (let v = lo; v <= hi; v += step) {
      const major = v % majorStep === 0;
      svgEl('line', {
        x1: tickX, x2: tickX + sgn * (major ? 9 : 5),
        y1: (-v * scale).toFixed(2), y2: (-v * scale).toFixed(2),
        stroke: major ? 'rgba(226,234,244,.72)' : 'rgba(160,175,192,.4)',
        'stroke-width': major ? 0.9 : 0.6,
      }, g);
      if (major) {
        const t = svgEl('text', {
          x: tickX + sgn * 11, y: (-v * scale + 1.9).toFixed(2),
          'text-anchor': dir > 0 ? 'start' : 'end',
          fill: 'rgba(210,222,234,.82)', 'font-family': 'var(--fm)', 'font-size': 6,
        }, g);
        t.textContent = String(v);
      }
    }

    // The readout box sits ON the centre line, over the tape, and is the only
    // thing in the instrument a pilot reads as a number.
    svgEl('rect', {
      x: x0 - 1, y: this.cy - 6, width: w + 2, height: 12,
      fill: 'rgba(8,12,18,.94)', stroke: 'rgba(226,234,244,.6)', 'stroke-width': 0.7,
    }, svg);
    const value = svgEl('text', {
      x: x0 + w * 0.5, y: this.cy + 2.6, 'text-anchor': 'middle',
      fill: '#f2f6fa', 'font-family': 'var(--fm)', 'font-size': 9,
      class: `ow-fl-${cls}`,
    }, svg);
    value.textContent = '0';
    const cap = svgEl('text', {
      x: x0 + w * 0.5, y: TAPE_BOT + 7.5, 'text-anchor': 'middle',
      fill: 'rgba(160,175,192,.85)', 'font-family': 'var(--fm)', 'font-size': 5.8,
      'letter-spacing': 0.6,
    }, svg);
    cap.textContent = label;
    return { g, band, value, scale, hi, lo };
  }

  /** The artificial horizon: sky, ground, pitch ladder, bank, fixed wings. */
  _horizon(svg, x0, x1, cy) {
    const id = `owhrz${++_clipSeq}`;
    const w = x1 - x0;
    const clip = svgEl('clipPath', { id }, svg);
    svgEl('rect', { x: x0, y: TAPE_TOP, width: w, height: TAPE_BOT - TAPE_TOP }, clip);
    const win = svgEl('g', { 'clip-path': `url(#${id})` }, svg);
    const cx = (x0 + x1) * 0.5;
    this.hcx = cx;

    // Oversized so a 60-degree bank never uncovers a corner.
    const g = svgEl('g', { class: 'ow-fl-horizon' }, win);
    svgEl('rect', { x: cx - 120, y: cy - 200, width: 240, height: 200, fill: 'rgba(46,86,120,.72)' }, g);
    svgEl('rect', { x: cx - 120, y: cy, width: 240, height: 200, fill: 'rgba(58,48,34,.78)' }, g);
    svgEl('line', {
      x1: cx - 120, x2: cx + 120, y1: cy, y2: cy,
      stroke: 'rgba(240,233,219,.9)', 'stroke-width': 1,
    }, g);
    for (const d of [-30, -20, -10, 10, 20, 30]) {
      const y = cy + d * PITCH_SCALE;
      const half = d % 20 === 0 ? 13 : 7;
      svgEl('line', {
        x1: cx - half, x2: cx + half, y1: y, y2: y,
        stroke: 'rgba(226,234,244,.6)', 'stroke-width': 0.6,
      }, g);
    }
    // Set ONCE: the rotation pivots on the fixed aircraft symbol, in view-box
    // units, and neither of these ever changes.
    g.style.transformBox = 'view-box';
    g.style.transformOrigin = `${cx}px ${cy}px`;
    this.horizon = g;

    // Fixed aircraft symbol — the reference everything else moves against.
    svgEl('path', {
      d: `M${cx - 20} ${cy} h11 l4 4 l4 -4 h11`,
      fill: 'none', stroke: 'var(--gold)', 'stroke-width': 1.4,
      'stroke-linejoin': 'round',
    }, svg);
    svgEl('rect', {
      x: x0, y: TAPE_TOP, width: w, height: TAPE_BOT - TAPE_TOP,
      fill: 'none', stroke: 'rgba(125,140,163,.3)', 'stroke-width': 0.6,
    }, svg);
    this.warn = svgEl('text', {
      class: 'ow-fl-warn',
      x: cx, y: TAPE_BOT - 5, 'text-anchor': 'middle',
      fill: '#ff3b4e', 'font-family': 'var(--fm)', 'font-size': 7, 'letter-spacing': 0.8,
      style: 'paint-order:stroke;stroke:rgba(4,7,10,.9);stroke-width:1.6',
    }, svg);
    this.warn.textContent = '';
  }

  /** Vertical speed: a needle on a centre-zero scale, plus the number. */
  _vsi(svg, x0, cy) {
    svgEl('rect', {
      x: x0, y: TAPE_TOP, width: 14, height: TAPE_BOT - TAPE_TOP,
      fill: 'rgba(6,9,14,.62)', stroke: 'rgba(125,140,163,.3)', 'stroke-width': 0.6,
    }, svg);
    for (const v of [-20, -10, 0, 10, 20]) {
      const y = cy - v * VSI_SCALE;
      svgEl('line', {
        x1: x0, x2: x0 + (v === 0 ? 14 : 5), y1: y, y2: y,
        stroke: v === 0 ? 'rgba(226,234,244,.7)' : 'rgba(160,175,192,.45)',
        'stroke-width': v === 0 ? 0.9 : 0.6,
      }, svg);
    }
    this.vsiNeedle = svgEl('path', {
      class: 'ow-fl-vsi-n',
      d: `M${x0 + 14} 0 l-5 -3 l0 6 z`, fill: 'var(--river-l)',
      transform: `translate(0 ${cy})`,
    }, svg);
    this.vsiValue = svgEl('text', {
      class: 'ow-fl-vsi',
      x: x0 + 7, y: TAPE_BOT + 7.5, 'text-anchor': 'middle',
      fill: 'rgba(210,222,234,.9)', 'font-family': 'var(--fm)', 'font-size': 5.8,
    }, svg);
    this.vsiValue.textContent = '0';
  }

  /** The rotor / prop spool: a bar, a percentage and a turning blade glyph. */
  _spool(svg) {
    svgEl('rect', {
      x: 2, y: 82, width: 206, height: 10,
      fill: 'rgba(6,9,14,.72)', stroke: 'rgba(125,140,163,.28)', 'stroke-width': 0.6,
    }, svg);
    this.spoolFill = svgEl('rect', {
      class: 'ow-fl-spool', x: 3, y: 83, width: 0, height: 8, fill: 'var(--river)',
    }, svg);
    this.spoolName = svgEl('text', {
      x: 7, y: 89.4, fill: 'rgba(232,240,248,.9)', 'font-family': 'var(--fm)',
      'font-size': 6, 'letter-spacing': 0.7,
    }, svg);
    this.spoolName.textContent = 'ROTOR';
    this.spoolPct = svgEl('text', {
      x: 190, y: 89.4, 'text-anchor': 'end', fill: 'rgba(232,240,248,.9)',
      'font-family': 'var(--fm)', 'font-size': 6,
    }, svg);
    this.spoolPct.textContent = '0%';
    this.blade = svgEl('path', {
      d: 'M-4.6 0 h9.2 M0 -4.6 v9.2 M-3.2 -3.2 l6.4 6.4',
      stroke: 'rgba(232,240,248,.92)', 'stroke-width': 1, fill: 'none',
      transform: 'translate(200 87)',
    }, svg);
    this._wroteName = 'ROTOR';
  }

  /** @param {object} veh ui.state.veh */
  update(dt, veh) {
    const alt = Math.max(0, veh.altitude ?? 0);
    const ias = Math.max(0, veh.speed ?? 0);
    const vs = veh.climb ?? 0;

    setStyle(this.alt.g, 'transform', `translate(0,${(this.cy + alt * ALT_SCALE).toFixed(2)}px)`);
    setStyle(this.ias.g, 'transform', `translate(0,${(this.cy + ias * IAS_SCALE).toFixed(2)}px)`);
    setStyle(this.ias.band, 'transform', `translate(0,${(this.cy + ias * IAS_SCALE).toFixed(2)}px)`);

    const a = Math.round(alt);
    if (a !== this._wroteAlt) {
      this._wroteAlt = a;
      setText(this.alt.value, String(a));
    }
    const s = Math.round(ias);
    if (s !== this._wroteIas) {
      this._wroteIas = s;
      setText(this.ias.value, String(s));
    }

    // ---- the stall band, per airframe ------------------------------------
    const vref = veh.vref > 0 ? veh.vref : 0;
    if (vref !== this._vref) {
      this._vref = vref;
      // Both bands hang BELOW the zero mark of the scrolling group, which is
      // at y = 0 in the group's own space (see `_tape`). Geometry goes through
      // `setAttribute`, not `style`: x/y/width/height are SVG2 CSS properties
      // and the support for them is newer than this project's floor.
      this.stall.setAttribute('y', (-vref * IAS_SCALE).toFixed(2));
      this.stall.setAttribute('height', (vref * IAS_SCALE + 200).toFixed(2));
      this.caution.setAttribute('y', (-vref * 1.25 * IAS_SCALE).toFixed(2));
      this.caution.setAttribute('height', (vref * 0.25 * IAS_SCALE).toFixed(2));
    }

    // ---- vertical speed ---------------------------------------------------
    const cl = clamp(vs, -20, 20);
    setStyle(this.vsiNeedle, 'transform', `translate(0,${(this.cy - cl * VSI_SCALE).toFixed(2)}px)`);
    const v10 = Math.round(vs * 10) / 10;
    if (v10 !== this._wroteVsi) {
      this._wroteVsi = v10;
      setText(this.vsiValue, (v10 > 0 ? '+' : '') + v10.toFixed(1));
      setStyle(this.vsiNeedle, 'fill', v10 < -6 ? '#ff8a5a' : 'var(--river-l)');
    }

    // ---- attitude ---------------------------------------------------------
    // The horizon counter-rotates against the fixed aircraft symbol: a left
    // wing down (bank > 0, the convention `plane.js` and the aircraft gate
    // share) tips the WORLD the other way, which is the only reading of an
    // attitude indicator that has ever been correct.
    const pitch = clamp(veh.pitch ?? 0, -80, 80);
    const bank = clamp(veh.bank ?? 0, -180, 180);
    setStyle(this.horizon, 'transform',
      `rotate(${bank.toFixed(1)}deg) translate(0,${(pitch * PITCH_SCALE).toFixed(2)}px)`);

    // ---- the stall warning, on the horizon --------------------------------
    // Below 1.1x Vref is where the aircraft gate says a wing lets go, so that
    // is the number the panel shouts at, not a prettier one. Only in the air,
    // and 3 m rather than 1: every aircraft sits below its stall speed on the
    // apron, and a Skylark's own gear holds the body ~1.5 m off the tarmac —
    // a threshold at the parked altitude blinks STALL at a stationary plane.
    const warn = vref > 0 && alt > STALL_WARN_ALT && ias < vref * 1.1 ? 'STALL' : '';
    if (warn !== this._wroteWarn) {
      this._wroteWarn = warn;
      setText(this.warn, warn);
    }
    if (warn) {
      this.wpulse = (this.wpulse + dt * 4.4) % 1;
      setStyle(this.warn, 'opacity', (0.4 + 0.6 * Math.abs(Math.cos(this.wpulse * Math.PI))).toFixed(2));
    }

    // ---- spool ------------------------------------------------------------
    const rot = clamp01(veh.rotor ?? 0);
    const q = Math.round(rot * 100);
    if (q !== this._wroteSpool) {
      this._wroteSpool = q;
      this.spoolFill.setAttribute('width', (204 * rot).toFixed(2));
      setStyle(this.spoolFill, 'fill', rot < 0.4 ? 'var(--slag-hot)' : 'var(--river)');
      setText(this.spoolPct, q + '%');
    }
    const name = veh.kind === 'heli' ? 'ROTOR' : 'PROP';
    if (name !== this._wroteName) {
      this._wroteName = name;
      setText(this.spoolName, name);
    }
    // The blade turns at a rate the spool sets — a stopped rotor reads as
    // stopped, which is the difference between "spooling up" and "running".
    // Guarded on the tenth of a degree it is actually DRAWN at: `setAttribute`
    // has no change cache, so without this a parked aircraft writes the same
    // 'rotate(0.0)' into the DOM sixty times a second.
    this._blade = (this._blade + dt * rot * 640) % 360;
    const b = Math.round(this._blade * 10) / 10;
    if (b !== this._wroteBlade) {
      this._wroteBlade = b;
      this.blade.setAttribute('transform', `translate(200 87) rotate(${b.toFixed(1)})`);
    }
  }

  setVisible(on) {
    setStyle(this.root, 'display', on ? 'flex' : 'none');
  }
}

export class VehicleCluster {
  constructor(parent) {
    this.root = el('div', 'ow-vehm', parent);

    /**
     * Where the seated EXIT chip docks (`Prompt`'s 'dock' placement). FIRST in
     * the column so it reads as the cluster's header rather than as a fourth
     * meter, and `display:contents` so an empty slot is not a flex item and
     * cannot contribute a gap of its own.
     */
    this.promptSlot = el('div', null, this.root);
    this.promptSlot.style.cssText = 'display:contents';

    // ---- the ground head: tach ring, speed numeral, gear rack ------------
    this.ground = el('div', 'ow-vehm-ground', this.root);
    this.ground.style.cssText =
      'display:flex;align-items:center;gap:calc(var(--u)*2);margin-bottom:calc(var(--u)*.6)';
    this.tach = new TachRing(this.ground, 42);
    const col = el('div', null, this.ground);
    col.style.cssText =
      'display:flex;flex-direction:column;align-items:flex-end;gap:calc(var(--u)*.5);flex:1 1 auto';
    const srow = el('div', null, col);
    srow.style.cssText = 'display:flex;align-items:baseline;gap:calc(var(--u)*1)';
    this.speed = el('span', 'ow-vehm-speed', srow, '0');
    this.speed.style.cssText =
      'font-family:var(--fm);font-size:calc(24px * var(--k));line-height:1;color:var(--ink);' +
      'text-shadow:var(--sh-o1);font-variant-numeric:tabular-nums';
    const unit = el('span', null, srow, 'KM/H');
    unit.style.cssText =
      'font-family:var(--fm);font-size:calc(8px * var(--k));letter-spacing:.22em;color:var(--steel)';
    this.gears = new GearPips(col);

    // ---- the flight head --------------------------------------------------
    this.flight = new FlightCluster(this.root);

    // ---- the shared rows --------------------------------------------------
    this.rows = {};
    for (const [key, label, cls] of [
      ['health', 'VEH', 'vh'],
      ['fuel', 'FUEL', 'fu'],
      ['nitro', 'NOS', 'no'],
    ]) {
      const r = el('div', 'ow-vehm-row ' + cls, this.root);
      el('span', 'k', r, label);
      const bar = el('div', 'bar', r);
      const fill = el('i', null, bar);
      this.rows[key] = { r, bar, fill, v: -1 };
    }

    /**
     * THE WATER WARNING. `vehicles` publishes `submerged` (0..1 of the body
     * under the waterline) and `drowned`, and emits `vehicle:drowned` when the
     * engine dies — and the HUD said nothing, so a car nosed into the Allegheny
     * simply stopped answering the throttle with no explanation on screen. It
     * is the one failure in this game that looks exactly like a broken build.
     */
    this.warn = el('div', 'ow-vehm-warn', this.root);
    this.warn.style.cssText =
      'display:none;font-family:var(--fm);font-size:calc(8.4px * var(--k));letter-spacing:.2em;' +
      'color:var(--blood);text-shadow:var(--sh-o1);margin-top:calc(var(--u)*.6);white-space:nowrap';

    this.shown = 0;
    this.flash = 0;
    this.wpulse = 0;
    this._wroteSpeed = -1;
    this._wroteWarn = null;
    this._wroteFace = null;
    this._wroteHealthHot = null;
    this._wroteFuelHot = null;
    setStyle(this.root, 'display', 'none');
  }

  _row(key, frac) {
    const row = this.rows[key];
    const on = typeof frac === 'number' && frac >= 0;
    setStyle(row.r, 'display', on ? '' : 'none');
    if (!on) return;
    const v = clamp01(frac);
    if (Math.abs(v - row.v) > 0.002) {
      row.v = v;
      setStyle(row.fill, 'transform', `scaleX(${v.toFixed(3)})`);
    }
  }

  /** @param {object} veh ui.state.veh */
  update(dt, veh) {
    this.shown = damp(this.shown, veh?.on ? 1 : 0, 12, dt);
    if (this.shown < 0.004) {
      setStyle(this.root, 'display', 'none');
      return 0;
    }
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'opacity', this.shown.toFixed(3));

    // ---- which face -------------------------------------------------------
    const face = veh.flying ? 'air' : 'ground';
    if (face !== this._wroteFace) {
      this._wroteFace = face;
      setStyle(this.ground, 'display', face === 'ground' ? 'flex' : 'none');
      this.flight.setVisible(face === 'air');
    }
    if (face === 'ground') {
      const kmh = Math.round(Math.max(0, veh.speedKmh ?? 0));
      if (kmh !== this._wroteSpeed) {
        this._wroteSpeed = kmh;
        setText(this.speed, String(kmh));
      }
      this.tach.set(veh.rpm01 ?? 0);
      this.gears.set(veh.gear ?? '—', veh.gearCount ?? 0);
    } else {
      this.flight.update(dt, veh);
    }

    this._row('health', veh.health);
    // NO TANK, NO GAUGE. A bicycle's `noFuel` gauge pinned at full reads as a
    // broken instrument rather than as an absent one — `vehicles` publishes the
    // flag for exactly this, and nothing was reading it.
    this._row('fuel', veh.noFuel ? -1 : veh.fuel);
    this._row('nitro', veh.nitro);

    // Health goes amber then red as the car dies, same ramp as the arcs.
    const h = clamp01(veh.health);
    const hHot = h < 0.25 ? 'var(--blood)' : h < 0.5 ? 'var(--slag-hot)' : '';
    if (hHot !== this._wroteHealthHot) {
      this._wroteHealthHot = hHot;
      setStyle(this.rows.health.fill, 'background', hHot);
    }

    // Low fuel is the warning that matters: below 15% the bar flashes and the
    // label goes red. DRY pins it solid red and stops the flash — a bar that
    // blinks at empty is noise on top of a throttle that has already stopped
    // answering.
    const fu = this.rows.fuel;
    const has = !veh.noFuel && typeof veh.fuel === 'number' && veh.fuel >= 0;
    const dry = has && (veh.dry || veh.fuel <= 0.001);
    const low = has && !dry && veh.fuel < 0.15;
    if (low) {
      this.flash = (this.flash + dt * 2.4) % 1;
      const k = 0.5 + 0.5 * Math.sin(this.flash * Math.PI * 2);
      setStyle(fu.bar, 'opacity', (0.55 + 0.45 * k).toFixed(2));
    } else {
      setStyle(fu.bar, 'opacity', '1');
    }
    setClass(fu.r, 'low', low || dry);
    const fHot = dry ? 'var(--blood)' : '';
    if (fHot !== this._wroteFuelHot) {
      this._wroteFuelHot = fHot;
      setStyle(fu.fill, 'background', fHot);
      // A dry tank keeps a sliver of red rather than nothing at all: an empty
      // track and a hidden row look the same at a glance.
      setStyle(fu.bar, 'box-shadow', dry ? 'inset 0 0 0 1px rgba(255,59,78,.7)' : '');
    }

    // Nitro brightens while it is being spent.
    setClass(this.rows.nitro.r, 'on', !!veh.nitroOn);

    // ---- water ------------------------------------------------------------
    const sub = veh.submerged ?? 0;
    const txt = veh.drowned ? 'ENGINE DROWNED — BAIL OUT'
      : sub > 0.5 ? 'SINKING — WATER OVER THE SILL'
        : sub > 0.12 ? 'IN WATER' : '';
    if (txt !== this._wroteWarn) {
      this._wroteWarn = txt;
      setText(this.warn, txt);
      setStyle(this.warn, 'display', txt ? '' : 'none');
      setStyle(this.warn, 'color', sub > 0.5 || veh.drowned ? 'var(--blood)' : 'var(--slag-hot)');
    }
    if (txt) {
      this.wpulse = (this.wpulse + dt * 1.9) % 1;
      setStyle(this.warn, 'opacity', (0.62 + 0.38 * Math.cos(this.wpulse * Math.PI * 2)).toFixed(2));
    }
    return this.shown;
  }

  dispose() {
    this.root.remove();
  }
}

/* -------------------------------------------------------------- weapon --- */

/** Bottom-right chip: silhouette, name, magazine / reserve. */
export class WeaponChip {
  constructor(parent) {
    this.root = el('div', 'ow-weap', parent);
    this.canvas = el('canvas', 'ow-weap-icon', this.root);
    this.g = this.canvas.getContext('2d');
    const col = el('div', 'ow-weap-col', this.root);
    this.name = el('div', 'ow-weap-name', col, 'FISTS');
    const row = el('div', 'ow-weap-row', col);
    this.ammo = el('span', 'ow-weap-ammo', row, '—');
    this.reserve = el('span', 'ow-weap-res', row, '');
    this.bar = el('div', 'ow-weap-bar', this.root);
    this.barFill = el('i', null, this.bar);

    this._glyph = '';
    this._colour = '';
    this.k = 1;
    this.resize(1);
  }

  resize(k) {
    this.k = k;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(46 * k * dpr);
    if (this.canvas.width !== px) {
      this.canvas.width = px;
      this.canvas.height = px;
      this._glyph = '';
    }
  }

  update(dt, s) {
    const glyph = s.weaponGlyph ?? 'fist';
    const colour = s.reloading ? '#ffb03a' : '#dfe7ee';
    if (glyph !== this._glyph || colour !== this._colour) {
      this._glyph = glyph;
      this._colour = colour;
      const g = this.g;
      const S = this.canvas.width;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, S, S);
      g.save();
      g.translate(S * 0.5, S * 0.5);
      g.shadowColor = 'rgba(0,0,0,.85)';
      g.shadowBlur = S * 0.06;
      drawWeaponGlyph(g, glyph, S * 0.92, colour);
      g.restore();
    }
    setText(this.name, s.weaponName ?? '');
    const melee = s.magSize === 0 || s.weaponMelee;
    setText(this.ammo, melee ? '∞' : String(s.ammo | 0));
    setText(this.reserve, melee ? '' : '/ ' + (s.reserve | 0));
    setClass(this.ammo, 'low', !melee && s.magSize > 0 && s.ammo / s.magSize <= 0.25);
    setStyle(this.bar, 'opacity', s.reloading ? '1' : '0');
    setStyle(this.barFill, 'transform', `scaleX(${clamp01(s.reloadProgress ?? 0).toFixed(3)})`);
  }

  dispose() {
    this.root.remove();
  }
}

/* --------------------------------------------------------------- clock --- */

/** Time of day + weather, sitting under the money. Fades unless it changed. */
export class CityClock {
  constructor(parent) {
    this.root = el('div', 'ow-clock', parent);
    this.time = el('span', 't', this.root, '00:00');
    this.wx = el('span', 'w', this.root, 'OVERCAST');
    this.hour = 12;
    this.min = 0;
  }

  set(hour, weather) {
    this.hour = hour;
    if (weather) this.weather = weather;
  }

  update() {
    const h = Math.floor(this.hour) % 24;
    const m = Math.floor((this.hour % 1) * 60);
    setText(this.time, `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`);
    setText(this.wx, (this.weather ?? '').toUpperCase());
  }

  dispose() {
    this.root.remove();
  }
}

export { starPath, roundRect };
