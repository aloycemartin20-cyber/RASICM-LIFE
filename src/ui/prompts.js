import { el, setText, setStyle, ease, clamp01, damp } from './util.js';

/**
 * ---------------------------------------------------------------------------
 * PLACEMENT — the same chip, in the place its content belongs
 * ---------------------------------------------------------------------------
 * `centre` is the contextual prompt: something in the WORLD is offering an
 * action, so the line sits under the middle of the screen where the player is
 * already looking at the thing.
 *
 * `dock` is for a prompt about the MACHINE THE PLAYER IS IN. The seated EXIT
 * chip is the whole reason this exists: nothing publishes it (`player.vehicles`
 * nulls its prompt the moment you are seated), so `ui` synthesizes it, and it
 * used to be drawn dead centre for 3.2 s and then deleted — a panel over the
 * windscreen at the exact moment the player is learning to drive, and then no
 * reminder at all for the rest of the game. Docked, it belongs to the vehicle
 * cluster: same corner, same fade, out of the road.
 *
 * The chip is REPARENTED on a placement change rather than repositioned,
 * because "beside the cluster" is a relationship the cluster's own layout
 * already expresses, and a hand-computed offset into another widget's box is
 * the kind of number that goes stale silently. Placement changes on boarding
 * and on stepping out — twice per car, never per frame.
 */
const PLACEMENT_CSS = {
  centre: '',
  dock: 'position:relative;left:auto;top:auto;transform:none;width:100%;' +
    'justify-content:flex-start;margin-bottom:calc(var(--u)*1.4);' +
    'padding:calc(var(--u)*1.2) calc(var(--u)*1.8);gap:calc(var(--u)*1.6);',
};

/** Interaction prompt: keycap + verb, with an optional hold-progress rule. */
export class Prompt {
  constructor(parent) {
    this.home = parent;
    this.root = el('div', 'ow-prompt', parent);
    this.key = el('div', 'ow-key', this.root, 'F');
    const col = el('div', null, this.root);
    this.txt = el('div', 'ow-prompt-txt', col, 'INTERACT');
    this.sub = el('div', 'ow-prompt-sub', col, '');
    const bar = el('div', null, col);
    bar.style.cssText =
      'margin-top:calc(var(--u)*1);height:calc(1.5px * var(--k));background:rgba(255,255,255,.16);width:100%';
    this.fill = el('i', null, bar);
    this.fill.style.cssText =
      'display:block;height:100%;width:100%;background:var(--amber);transform-origin:left;transform:scaleX(0)';
    this.bar = bar;

    this.shown = 0;
    this.active = false;
    this.progress = 0;
    this.placement = 'centre';
    /** 0..1 multiplier on the settled opacity. See `set`. */
    this.dim = 1;
    this._dock = null;
    setStyle(this.root, 'display', 'none');
  }

  /**
   * @param {object} p { key, text, sub, progress, placement, host, dim }
   *   placement  'centre' (default) | 'dock'
   *   host       the node a 'dock' placement parents into; ignored otherwise
   *   dim        0..1 opacity multiplier once the chip has settled
   */
  set(p) {
    this.active = true;
    setText(this.key, p.key ?? 'F');
    setText(this.txt, (p.text ?? 'INTERACT').toUpperCase());
    setText(this.sub, (p.sub ?? '').toUpperCase());
    setStyle(this.sub, 'display', p.sub ? '' : 'none');
    this.progress = p.progress ?? 0;
    setStyle(this.bar, 'display', p.progress !== undefined ? '' : 'none');
    this.dim = p.dim ?? 1;
    this.setPlacement(p.placement ?? 'centre', p.host ?? null);
  }

  /** Reparent + restyle. A no-op unless the placement actually changed. */
  setPlacement(name, host) {
    const to = PLACEMENT_CSS[name] === undefined ? 'centre' : name;
    // The remembered host is only replaced by a DOCK request; a centre
    // placement must not read as "the host changed", or every on-foot frame
    // would rewrite `cssText` and re-invalidate the style cache below.
    const dock = to === 'dock' ? (host ?? this._dock) : this._dock;
    if (to === this.placement && dock === this._dock) return;
    this.placement = to;
    this._dock = dock;
    const parent = to === 'dock' && dock ? dock : this.home;
    if (this.root.parentNode !== parent) parent.appendChild(this.root);
    this.root.style.cssText = PLACEMENT_CSS[to];
    // `cssText` wipes the properties `update()` writes, and `setStyle` caches
    // per node — so without this the chip would keep the display / opacity /
    // transform it had before the move and never write them again.
    this.root._ows_display = undefined;
    this.root._ows_opacity = undefined;
    this.root._ows_transform = undefined;
  }

  clear() {
    this.active = false;
  }

  update(dt) {
    this.shown = damp(this.shown, this.active ? 1 : 0, 18, dt);
    const vis = this.shown;
    setStyle(this.root, 'display', vis < 0.005 ? 'none' : '');
    if (vis < 0.005) return;
    setStyle(this.root, 'opacity', (vis * this.dim).toFixed(3));
    const y = (1 - ease.outCubic(vis)) * 7;
    // A docked chip is in flow inside its host and must not be pulled back by
    // the centring transform the centre placement lives on.
    setStyle(this.root, 'transform', this.placement === 'dock'
      ? `translateY(${y.toFixed(2)}px)`
      : `translate(-50%,calc(-50% + ${y.toFixed(2)}px))`);
    setStyle(this.fill, 'transform', `scaleX(${clamp01(this.progress).toFixed(3)})`);
  }

  dispose() {
    this.root.remove();
  }
}

/** Kill confirmation / objective banner. One at a time, newest wins. */
export class Banner {
  constructor(parent) {
    this.root = el('div', 'ow-banner', parent);
    this.title = el('div', 'ow-banner-t', this.root, '');
    this.sub = el('div', 'ow-banner-s', this.root, '');
    el('div', 'ow-banner-rule', this.root);
    this.t = 1;
    this.life = 2.1;
    setStyle(this.root, 'display', 'none');
  }

  show(title, sub, life = 2.1) {
    setText(this.title, (title ?? '').toUpperCase());
    setText(this.sub, (sub ?? '').toUpperCase());
    setStyle(this.sub, 'display', sub ? '' : 'none');
    this.life = life;
    this.t = 0;
  }

  update(dt) {
    if (this.t >= 1) {
      setStyle(this.root, 'display', 'none');
      return;
    }
    this.t = Math.min(1, this.t + dt / this.life);
    const u = this.t;
    const inT = clamp01(u / (0.16 / this.life));
    const a = u > 0.78 ? 1 - ease.inQuad((u - 0.78) / 0.22) : ease.outQuad(inT);
    const s = 0.965 + 0.035 * ease.outBack(inT);
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'opacity', a.toFixed(3));
    setStyle(this.root, 'transform', `translate(-50%,-50%) scale(${s.toFixed(4)})`);
  }

  dispose() {
    this.root.remove();
  }
}
