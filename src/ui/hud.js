/**
 * ===========================================================================
 * HUD — the ward health bar, and the boss health bar
 * ===========================================================================
 *
 * Two widgets, one subsystem, one reason: both are somebody ELSE'S health, and
 * `ui` had no place to draw either. The ward's story is below; the boss's is
 * the same story told about the other end of the fight — `src/game/boss.js`
 * published a name, a phase and a health fraction and the only thing on screen
 * was the objective panel's progress bar, driven by `1 - hpFrac`, i.e. a meter
 * that FILLED UP as the boss went down while sharing its single line with the
 * attack telegraph. See `BossBar`.
 *
 * A `protect` chapter has exactly one way to lose: the brother you are standing
 * over runs out of HP. Everything else on screen during one of those chapters
 * is about the ATTACKERS — "Keep Dylan alive", a `kills / goal` counter, and a
 * progress bar that fills with YOUR OWN KILLS (`game/tracks.js`). The single
 * number that decides whether you win or lose was published every frame on
 * `game.getHudState().ward` and drawn by nobody, so the fail condition was
 * invisible right up until it fired.
 *
 * It is drawn for the whole duration — a name and a meter, shown when the
 * chapter starts, width tracking `hp / maxHp`, hidden when the chapter ends:
 * the row lives at the bottom of the objective panel, so it inherits the
 * panel's position, its fade and its lifetime, and there is no second place on
 * screen for "what is happening to me" to live.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SUBSYSTEM AND NOT A FEW LINES IN `ui/index.js`
 * ---------------------------------------------------------------------------
 * The registry is the sanctioned way to add behaviour without editing
 * `src/ui/index.js`: `static deps = ['ui', 'game']` puts this after both in the
 * topo sort, `ctx.peek` reaches them at runtime (rule 2 — never an import),
 * and the DOM node is parented into the panel `ui` already built. Nothing here
 * writes game state, consumes input, claims the clock or touches `time.scale`.
 *
 * ---------------------------------------------------------------------------
 * TWO BARS, ONE TRUTH
 * ---------------------------------------------------------------------------
 * The FILL snaps to the published health every frame — a health bar that lags
 * is a health bar that lies, and this one is a fail condition. The CHIP behind
 * it is a slower ghost that drains down to meet the fill, which is what makes a
 * hit legible as an amount rather than as a new number. `src/ui/wardprobe.mjs`
 * measures the fill.
 */

import { el, setStyle, setText, clamp01, damp } from './util.js';
import { BOYZ } from './data.js';

/** Uppercased brother name -> his signature colour, for the ward's name+bar. */
const BOY_COLOUR = {};
for (const b of BOYZ) BOY_COLOUR[b.name.toUpperCase()] = b.colour;

/** Below this fraction the bar goes to blood and starts pulsing. */
const CRITICAL = 0.3;
const FALLBACK = '#79d2ff'; // --cyan, the ally colour

/**
 * Name + meter. `set(name, health01)` every frame it should be up, `hide()`
 * every frame it should not; `update(dt)` animates the chip and the pulse.
 */
export class WardBar {
  constructor(parent) {
    this.root = el('div', 'ow-ward', parent);
    // Right-aligned to sit under the objective text, which is right-aligned.
    this.root.style.cssText =
      'display:flex;justify-content:flex-end;align-items:center;' +
      'gap:calc(var(--u) * 2);margin-top:calc(var(--u) * 1.6);';

    this.name = el('div', 'ow-ward-name', this.root, '');
    this.name.style.cssText =
      'font-family:var(--fm);font-size:calc(10px * var(--k));letter-spacing:.28em;' +
      'text-shadow:var(--sh-o1);white-space:nowrap;';

    this.track = el('div', 'ow-ward-track', this.root);
    this.track.style.cssText =
      'position:relative;width:calc(96px * var(--k));height:calc(5px * var(--k));' +
      'background:rgba(8,12,17,.86);overflow:hidden;';

    this.chip = el('i', 'ow-ward-chip', this.track);
    this.chip.style.cssText =
      'position:absolute;left:0;top:0;height:100%;width:100%;' +
      'background:rgba(255,244,232,.34);';

    this.fill = el('i', 'ow-ward-fill', this.track);
    this.fill.style.cssText = 'position:absolute;left:0;top:0;height:100%;width:100%;';

    this.active = false;
    this.health = 1;
    this.chipValue = 1;
    this.colour = FALLBACK;
    this._pulse = 0;
    this._rawName = undefined;
    this._wroteFill = -1;
    this._wroteChip = -1;
    this._wroteHot = null;
    setStyle(this.root, 'display', 'none');
  }

  /** @param {number} health 0..1, already clamped by the caller or here. */
  set(name, health) {
    const h = clamp01(health);
    if (!this.active) {
      this.active = true;
      // A bar that fades in from the previous chapter's value would read as
      // the ward taking damage he never took, so start settled on the truth.
      this.chipValue = h;
      this._pulse = 0;
      setStyle(this.root, 'display', 'flex');
    }
    this.health = h;
    // Compare the RAW name first: `toUpperCase()` on an unchanged string would
    // otherwise allocate once per frame for the whole chapter (rule 5).
    if (name !== this._rawName) {
      this._rawName = name;
      const label = String(name ?? '').toUpperCase();
      setText(this.name, label);
      this.colour = BOY_COLOUR[label] ?? FALLBACK;
      setStyle(this.name, 'color', this.colour);
      this._wroteHot = null;
    }
  }

  hide() {
    if (!this.active) return;
    this.active = false;
    setStyle(this.root, 'display', 'none');
  }

  update(dt) {
    if (!this.active) return;
    // The chip only ever drains toward the fill. Healing (the ward is topped
    // up when he is pinned) snaps both, so the ghost can never sit BEHIND the
    // bar and read as damage that is about to land.
    this.chipValue = this.chipValue > this.health
      ? damp(this.chipValue, this.health, 3.4, dt)
      : this.health;

    const crit = this.health < CRITICAL;
    this._pulse = crit ? (this._pulse + dt) % 1 : 0;

    // Quantised to a tenth of a percent so a settled bar stops writing style
    // strings entirely (rule 5) while still moving smoothly on the way down.
    const f = Math.round(this.health * 1000);
    if (f !== this._wroteFill) {
      this._wroteFill = f;
      setStyle(this.fill, 'width', (f / 10).toFixed(1) + '%');
    }
    const c = Math.round(this.chipValue * 1000);
    if (c !== this._wroteChip) {
      this._wroteChip = c;
      setStyle(this.chip, 'width', (c / 10).toFixed(1) + '%');
    }

    const hot = crit ? '#ff3b4e' : this.colour;
    if (hot !== this._wroteHot) {
      this._wroteHot = hot;
      setStyle(this.fill, 'background', 'linear-gradient(90deg, rgba(8,12,17,.55), ' + hot + ')');
    }
    // Under a third he pulses. Unscaled dt drives it, so it keeps breathing
    // while a card or a menu has the world stopped. Outside the pulse the
    // opacity is a constant and costs nothing.
    if (crit) setStyle(this.root, 'opacity', (0.72 + 0.28 * Math.cos(this._pulse * 6.283)).toFixed(3));
    else setStyle(this.root, 'opacity', '1');
  }

  dispose() {
    this.root.remove();
  }
}

/* ========================================================================== */
/* the boss bar                                                               */
/* ========================================================================== */

/** Most phases any boss has. Ticks are pooled to this and shown/hidden. */
const MAX_PHASE_TICKS = 5;
/**
 * The fill's approach rate, per second.
 *
 * THE WARD'S FILL SNAPS AND THIS ONE DOES NOT, AND THAT IS DELIBERATE.
 * The ward bar is a FAIL CONDITION read at a glance — a bar that lags is a bar
 * that lies about whether you are about to lose, so it is pinned to the truth
 * and only its ghost chip drains. A boss bar is a PROGRESS read: what the
 * player needs from it is "how much did that burst take off", and a value that
 * teleports gives him a new number instead of an amount. So the fill eases and
 * the chip trails further behind it, which is the pair that makes a shotgun
 * blast legible as a bite. At 9/s it is within 1% of the truth in 0.5 s, so it
 * is never lying by anything a person could act on.
 */
const BOSS_FILL_RATE = 9;
const BOSS_CHIP_RATE = 2.1;

/**
 * How long a `mission:boss` record stays believable, in SIMULATED seconds.
 *
 * THE BAR'S LIVENESS IS READ OFF ITS OWN STREAM, NOT OFF `hud.objective`.
 * It used to be `this._bossOn && hud?.objective` — the fight's `active` flag
 * ANDed with a field belonging to a different producer — and that inference is
 * a defect with a paper trail: `src/game/index.js` carries a whole paragraph
 * warning the next author not to make `objective` fall back to the next
 * chapter, *because it would leave a dead rival's health bar over an empty
 * street*. A backstop that turns a one-line change three files away into a
 * visible HUD bug is a coupling, not a backstop.
 *
 * `src/game/boss.js` publishes once per fight tick (`publish(g, B, phase,
 * hpFrac, true)`), so the stream itself says whether a fight is live: a record
 * carrying `active: true`, arriving recently. Every hole the `objective` test
 * covered — a chapter that completes, fails, or is replaced without ever
 * saying `active: false` — is covered by the record simply stopping.
 *
 * SIMULATED time, never raw: the publisher runs on the game clock, so a
 * MISSION FAILED card or a pause menu (scale 0) must not age the record out
 * from under a fight that is still there. 0.35 s is ~21 frames — comfortably
 * past any single-frame hitch and well inside the 0.5 s `wardprobe` allows
 * itself between aborting the chapter and demanding the bar be gone.
 */
const BOSS_STALE = 0.35;

/**
 * Name, weak point, phase ticks and a smoothly depleting meter.
 *
 * Driven from `mission:boss` (`src/game/boss.js`) — the fight publishes its own
 * state and this draws it. Nothing here reads the boss entity, his health or
 * the mission runner.
 */
export class BossBar {
  constructor(parent) {
    this.root = el('div', 'ow-boss', parent);
    /**
     * Top centre, and on its own SCRIM.
     *
     * The chrome layer covers the canvas, so `pointer-events:none` — a hit box
     * over the crosshair would eat a click. The scrim is the part that is not
     * decoration: a boss fight happens outdoors under a bright sky, and the
     * first version of this was a thin dark bar laid straight over a sunlit
     * tree, where neither the empty half of the track nor the phase ticks
     * could be told from the foliage behind them. A soft vertical fade behind
     * the whole widget costs one gradient and makes it legible over anything.
     */
    this.root.style.cssText =
      'position:absolute;left:50%;top:calc(var(--u) * 9);transform:translateX(-50%);' +
      'display:flex;flex-direction:column;align-items:center;pointer-events:none;' +
      'width:calc(460px * var(--k));padding:calc(var(--u) * 2) 0;';

    /**
     * The scrim is its OWN element rather than a background on the root, and
     * the reason is that a radial gradient is clipped to its box: put it on
     * the root and it can only reach zero alpha at the corners, so it reads as
     * a translucent RECTANGLE laid over the sky — which is what the first cut
     * did, visibly. An oversized child whose ellipse closes inside its own
     * bounds has no edge anywhere. Absolutely positioned and FIRST in DOM
     * order; the siblings below are `position:relative` so they paint over it.
     */
    this.scrim = el('i', 'ow-boss-scrim', this.root);
    this.scrim.style.cssText =
      'position:absolute;left:-14%;right:-14%;top:-18%;bottom:-18%;' +
      'background:radial-gradient(ellipse 50% 50% at 50% 50%,' +
      'rgba(6,9,13,.72) 0%, rgba(6,9,13,.5) 42%, rgba(6,9,13,0) 100%);';

    this.name = el('div', 'ow-boss-name', this.root, '');
    this.name.style.cssText =
      'position:relative;font-family:var(--fm);font-size:calc(13px * var(--k));' +
      'letter-spacing:.34em;text-shadow:var(--sh-o1);white-space:nowrap;';

    this.track = el('div', 'ow-boss-track', this.root);
    this.track.style.cssText =
      'position:relative;width:100%;height:calc(9px * var(--k));' +
      'margin-top:calc(var(--u) * 1.2);background:rgba(8,12,17,.92);' +
      'box-shadow:0 0 0 calc(1px * var(--k)) rgba(232,226,212,.22),' +
      '0 calc(2px * var(--k)) calc(6px * var(--k)) rgba(3,6,9,.7);overflow:hidden;';

    this.chip = el('i', 'ow-boss-chip', this.track);
    this.chip.style.cssText =
      'position:absolute;left:0;top:0;height:100%;width:100%;' +
      'background:rgba(255,224,196,.34);';

    this.fill = el('i', 'ow-boss-fill', this.track);
    this.fill.style.cssText = 'position:absolute;left:0;top:0;height:100%;width:100%;';

    /**
     * Phase ticks: the boundaries his health has to cross for the next wave.
     *
     * Drawn OVER the fill, and LIGHT with a dark outline rather than dark on
     * its own — a dark tick is invisible on the empty half of the track, which
     * is precisely the half a player checks to see how far the next phase is.
     */
    this.ticks = [];
    for (let i = 0; i < MAX_PHASE_TICKS; i++) {
      const t = el('i', 'ow-boss-tick', this.track);
      t.style.cssText =
        'position:absolute;top:0;height:100%;width:calc(2px * var(--k));' +
        'background:rgba(240,233,219,.72);' +
        'box-shadow:0 0 0 calc(1px * var(--k)) rgba(6,9,13,.9);display:none;';
      this.ticks.push(t);
    }

    this.weak = el('div', 'ow-boss-weak', this.root, '');
    this.weak.style.cssText =
      'position:relative;font-family:var(--fm);font-size:calc(8.6px * var(--k));' +
      'letter-spacing:.2em;color:var(--ink-2);text-shadow:var(--sh-o1);' +
      'margin-top:calc(var(--u) * .9);white-space:nowrap;';

    this.active = false;
    this.health = 1;
    this.fillValue = 1;
    this.chipValue = 1;
    this.colour = FALLBACK;
    this._pulse = 0;
    this._rawName = undefined;
    this._rawWeak = undefined;
    this._rawColour = undefined;
    this._wrotePhases = -1;
    this._wroteFill = -1;
    this._wroteChip = -1;
    this._wroteHot = null;
    setStyle(this.root, 'display', 'none');
  }

  /** @param {object} s the `mission:boss` record. Read, never retained. */
  set(s) {
    const h = clamp01(s.health);
    if (!this.active) {
      this.active = true;
      // Open on the truth. Fading in from the last fight's value would read as
      // a boss taking damage nobody dealt.
      this.fillValue = h;
      this.chipValue = h;
      this._pulse = 0;
      setStyle(this.root, 'display', 'flex');
    }
    this.health = h;

    // Compare the RAW strings first: `toUpperCase()` on an unchanged name would
    // otherwise allocate once per frame for the whole fight (rule 5).
    if (s.name !== this._rawName) {
      this._rawName = s.name;
      setText(this.name, String(s.name ?? '').toUpperCase());
    }
    if (s.weak !== this._rawWeak) {
      this._rawWeak = s.weak;
      setText(this.weak, String(s.weak ?? '').toUpperCase());
    }
    if (s.colour !== this._rawColour) {
      this._rawColour = s.colour;
      this.colour = s.colour || FALLBACK;
      setStyle(this.name, 'color', this.colour);
      this._wroteHot = null;
    }

    // Ticks move only when the boss does, i.e. once per fight.
    const phases = Math.max(1, Math.min(MAX_PHASE_TICKS + 1, s.phases | 0));
    if (phases !== this._wrotePhases) {
      this._wrotePhases = phases;
      for (let i = 0; i < MAX_PHASE_TICKS; i++) {
        const on = i < phases - 1;
        setStyle(this.ticks[i], 'display', on ? 'block' : 'none');
        // A phase turns over at `hpFrac = 1 - k/phases`, and the fill is drawn
        // from the left, so that is exactly where the mark goes.
        if (on) setStyle(this.ticks[i], 'left', (((i + 1) / phases) * 100).toFixed(3) + '%');
      }
    }
  }

  hide() {
    if (!this.active) return;
    this.active = false;
    setStyle(this.root, 'display', 'none');
  }

  update(dt) {
    if (!this.active) return;
    this.fillValue = damp(this.fillValue, this.health, BOSS_FILL_RATE, dt);
    // The chip only ever drains toward the fill; a boss that is healed (no
    // fight does today, but a phase heal is one line away) snaps both, so the
    // ghost can never sit BEHIND the bar and read as damage about to land.
    this.chipValue = this.chipValue > this.fillValue
      ? damp(this.chipValue, this.fillValue, BOSS_CHIP_RATE, dt)
      : this.fillValue;

    const crit = this.health < CRITICAL;
    this._pulse = crit ? (this._pulse + dt) % 1 : 0;

    // Quantised to a tenth of a percent so a settled bar stops writing style
    // strings entirely (rule 5) while still moving smoothly on the way down.
    const f = Math.round(this.fillValue * 1000);
    if (f !== this._wroteFill) {
      this._wroteFill = f;
      setStyle(this.fill, 'width', (f / 10).toFixed(1) + '%');
    }
    const c = Math.round(this.chipValue * 1000);
    if (c !== this._wroteChip) {
      this._wroteChip = c;
      setStyle(this.chip, 'width', (c / 10).toFixed(1) + '%');
    }

    const hot = crit ? '#ff3b4e' : this.colour;
    if (hot !== this._wroteHot) {
      this._wroteHot = hot;
      /**
       * A HOT LEADING EDGE, and it is the only part of the bar a player reads
       * precisely. The boss colours in `data.js` are identity marks — teal,
       * rust, maroon, violet — and every one of them is dark enough that a
       * flat fill of it against a dark track leaves the exact level ambiguous.
       * The last few per cent burning out to near-white puts a hard, findable
       * edge exactly where his health is.
       */
      setStyle(this.fill, 'background',
        'linear-gradient(90deg, rgba(8,12,17,.55) 0%, ' + hot + ' 76%, #fff3e2 100%)');
    }
    if (crit) setStyle(this.root, 'opacity', (0.74 + 0.26 * Math.cos(this._pulse * 6.283)).toFixed(3));
    else setStyle(this.root, 'opacity', '1');
  }

  dispose() {
    this.root.remove();
  }
}

/**
 * The subsystem. Reads `game.getHudState().ward` — the record `game` already
 * publishes — and draws it. Draws nothing at all when there is no ward, which
 * is every chapter but one. Same for the boss bar off `mission:boss`.
 */
export class HudSystem {
  static id = 'hud';
  static deps = ['ui', 'game'];

  async init(ctx) {
    this.ctx = ctx;
    const ui = ctx.peek('ui');
    // Into the objective panel when there is one, so the ward rides its fade
    // and its position; the chrome layer is the fallback for a `ui` that has
    // rearranged itself, and `document.body` for a headless DOM.
    const parent = ui?.objective?.root ?? ui?.topRight ?? ui?.chromeLayer ?? ui?.root
      ?? document.getElementById('ui') ?? document.body;
    this.bar = new WardBar(parent);
    // The boss bar is NOT in the objective panel: it is top centre, it is the
    // widest thing on screen during a fight, and it must not inherit the
    // panel's right-hand column or its fade.
    const layer = ui?.chromeLayer ?? ui?.root ?? document.getElementById('ui') ?? document.body;
    this.boss = new BossBar(layer);
    this._lastRaw = ctx.time.raw;

    /**
     * The fight publishes; nothing polls it. `_boss` is the record's own
     * fields COPIED OUT — `src/game/boss.js` emits one reused object (rule 5),
     * so retaining the reference would be retaining whatever the next fight
     * happens to put in it.
     */
    this._boss = { name: '', weak: '', colour: '', phase: 0, phases: 1, health: 1 };
    this._bossOn = false;
    /** `time.elapsed` of the last live record. See `BOSS_STALE`. */
    this._bossAt = -1e9;
    this._onBoss = (p) => {
      if (!p || p.active !== true || !Number.isFinite(p.health)) {
        this._bossOn = false;
        return;
      }
      const b = this._boss;
      b.name = p.name; b.weak = p.weak; b.colour = p.colour;
      b.phase = p.phase; b.phases = p.phases; b.health = p.health;
      this._bossOn = true;
      this._bossAt = this.ctx.time.elapsed;
    };
    /**
     * Three canonical lifecycle events as well, and each one drops the bar in
     * the SAME FRAME rather than waiting out `BOSS_STALE`: a chapter that FAILS
     * or COMPLETES stops emitting without ever saying `active:false`. A chapter
     * that is replaced (abort, then the next `startMission` in the same breath)
     * says nothing at all, and the staleness test in `lateUpdate` is what
     * catches that one.
     */
    this._off = [
      ctx.events.on('mission:boss', this._onBoss),
      ctx.events.on('mission:start', () => { this._bossOn = false; }),
      ctx.events.on('mission:complete', () => { this._bossOn = false; }),
      ctx.events.on('mission:fail', () => { this._bossOn = false; }),
    ];
  }

  /**
   * After `ui.lateUpdate` (deps put us behind it), so the objective panel has
   * already been shown or hidden for this frame and the bar is never drawn
   * into a panel that is about to vanish.
   */
  lateUpdate(dt, ctx) {
    if (!this.bar) return;
    // Unscaled: the pulse and the chip drain must keep running while a
    // MISSION FAILED card has the world stopped at zero scale.
    const raw = ctx.time.raw;
    const rawDt = Math.min(0.1, Math.max(0, raw - this._lastRaw));
    this._lastRaw = raw;

    const game = ctx.peek('game');
    const hud = typeof game?.getHudState === 'function' ? game.getHudState() : null;
    const ward = hud ? hud.ward : null;
    if (ward && Number.isFinite(ward.health)) this.bar.set(ward.name, ward.health);
    else this.bar.hide();
    this.bar.update(rawDt);

    // The fight's OWN flag, plus the freshness of the record carrying it —
    // nothing else. See `BOSS_STALE` for why this is not `hud.objective`.
    const live = this._bossOn && ctx.time.elapsed - this._bossAt < BOSS_STALE;
    if (live) this.boss.set(this._boss);
    else this.boss.hide();
    this.boss.update(rawDt);
  }

  dispose() {
    for (const off of this._off ?? []) off?.();
    this._off = null;
    this.bar?.dispose();
    this.bar = null;
    this.boss?.dispose();
    this.boss = null;
  }
}
