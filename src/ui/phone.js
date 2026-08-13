/**
 * ===========================================================================
 * THE PHONE
 * ===========================================================================
 *
 * A burner with a cracked screen. It is the shell every open-world game needs
 * for the things that are not gameplay: who you can call, what is on the radio,
 * how far through the twenty-four chapters you are.
 *
 * Four tabs, arrow keys to move, one column of rows — deliberately small. A
 * phone that tries to be an operating system is a phone nobody opens. What it
 * has to do is (a) look like an object in the world rather than a menu, and
 * (b) name the brothers and the six stations in their own colours.
 *
 * STORY is the fourth, and it is the one the player was missing: three
 * brothers with their own frontiers, the family completion percent, the
 * free-roam job tally and the active brother's chapters marked done / current
 * / locked. Every number on it (and on PROGRESS, which used to print a
 * hard-coded "4 / 24") comes from `game.getProgress()` — this file computes no
 * progress of its own, so it cannot disagree with the pause menu or the story
 * overview.
 *
 * It slides in from the bottom right, so it never covers the ring or the
 * objective, and it dims the rest of the HUD while it is up.
 */

import { el, setText, setStyle, setClass, clamp, clamp01, damp, ease } from './util.js';
import { BOYZ, STATIONS, PACKAGES } from './data.js';

const TABS = ['CONTACTS', 'RADIO', 'STORY', 'PROGRESS'];
const TAB_CONTACTS = 0;
const TAB_RADIO = 1;
const TAB_STORY = 2;
const TAB_PROGRESS = 3;

/**
 * How many rows the STORY page spends before the chapter list: the three
 * brothers, then COMPLETION and SIDE JOBS.
 */
const STORY_HEAD = 5;
/** Rows the pool has to cover: 5 + a brother's eight chapters, with slack. */
const ROW_POOL = 15;
/** Status colours for a chapter row — done, current, locked. */
const STATUS_COLOUR = { done: '#41e08a', current: '#ffc93c', locked: '#5c6a7d' };

export class Phone {
  constructor(parent) {
    this.root = el('div', 'ow-phone', parent);
    const body = el('div', 'ow-phone-body', this.root);

    // status bar
    const bar = el('div', 'ow-phone-bar', body);
    const sig = el('div', 'ow-phone-sig', bar);
    for (let i = 0; i < 4; i++) {
      const b = el('i', null, sig);
      setStyle(b, 'height', `calc(${3 + i * 2}px * var(--k))`);
    }
    el('span', 'carrier', bar, 'STEEL CELL');
    this.clock = el('span', 'clk', bar, '17:23');
    const batt = el('div', 'ow-phone-batt', bar);
    el('i', null, batt);

    this.tabRow = el('div', 'ow-phone-tabs', body);
    this.tabEls = TABS.map((t, i) => {
      const tab = el('div', 'tab', this.tabRow, t);
      // Tabs are tap targets, not just labels — on touch the arrow keys the
      // footer used to name do not exist.
      this._press(tab, () => {
        this.tab = i;
        this.index = 0;
        this.list.scrollTop = 0;
        this._paint();
      });
      return tab;
    });

    this.list = el('div', 'ow-phone-list', body);
    /**
     * THE STORY PAGE IS TALLER THAN THE PHONE, and it has to be: three
     * brothers, two summary lines and eight chapters is thirteen rows against
     * a screen anchored 84 px off the bottom of a 720 px viewport. Capping the
     * list and scrolling it is the only way the chapter states are readable
     * without the phone growing off the top of the screen. Inline rather than
     * in `style.js` because it is a property of THIS widget's content, and the
     * other three pages never reach the cap.
     */
    setStyle(this.list, 'max-height', '46vh');
    setStyle(this.list, 'overflow-y', 'auto');
    this.rows = [];
    for (let i = 0; i < ROW_POOL; i++) {
      const r = el('div', 'ow-phone-row', this.list);
      const dot = el('i', null, r);
      const col = el('div', 'c', r);
      const t = el('div', 'n', col, '');
      const sub = el('div', 's', col, '');
      const val = el('div', 'v', r, '');
      setStyle(r, 'display', 'none');
      // A tap selects AND activates — one thumb, one motion, like a phone.
      this._press(r, () => {
        if (i >= Math.min(this._count(), this.rows.length)) return;
        this.index = i;
        this._paint();
        const a = this.activate();
        if (a) this.onActivate?.(a);
      });
      this.rows.push({ r, dot, t, sub, val });
    }

    this.foot = el('div', 'ow-phone-foot', body, '↑ ↓ SELECT · ← → TAB · P CLOSE');
    this._footTouch = null;

    // The way out that does not need a keyboard: opening the phone hides the
    // touch layer (and the PHONE button that opened it) under the modal rule.
    this.closeBtn = el('button', 'ow-modal-x sm', this.root, '✕');
    this.closeBtn.type = 'button';
    this.closeBtn.setAttribute('aria-label', 'Close phone');
    this._press(this.closeBtn, () => this.hide());

    this.open = false;
    this.a = 0;
    this.tab = 0;
    this.index = 0;
    this.station = 'grease';
    this.character = 'aidan';
    this.found = 0;
    /**
     * WAS A HARD-CODED 4. Nothing in the tree ever called `setState({chapter})`
     * — `ui/index.js` feeds this widget five fields and progress is not among
     * them — so the PROGRESS page has read "4 / 24" on every save this game has
     * ever had, including a brand new one. `game._pushProgress` now pushes the
     * real record (`story`, below) whenever it moves; this stays as the
     * fallback for a build with no `game` at all, and 0 is the honest one.
     */
    this.chapter = 0;
    this.respect = 0;
    /**
     * `game.getProgress()`'s REUSED record — read every paint, never retained
     * field by field, which is what keeps the page live between pushes. Null
     * until `game` exists (the model-preview page and every bench).
     */
    this.story = null;
    /** Called with `activate()`'s result when a row is tapped. */
    this.onActivate = null;
    setStyle(this.root, 'display', 'none');
    setStyle(this.root, 'pointer-events', 'none');
    this._paint();
  }

  /** click AND touchend, the same pairing every modal control here uses. */
  _press(node, fn) {
    node.addEventListener('click', fn);
    node.addEventListener('touchend', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }, { passive: false });
  }

  /** The footer names the controls the player actually has. */
  setTouch(on) {
    if (this._footTouch === on) return;
    this._footTouch = on;
    setText(this.foot, on ? 'TAP A ROW · TAP A TAB · ✕ CLOSE' : '↑ ↓ SELECT · ← → TAB · P CLOSE');
  }

  show() {
    this.open = true;
    setStyle(this.root, 'display', '');
    setStyle(this.root, 'pointer-events', 'auto');
    this._paint();
  }

  hide() {
    this.open = false;
    setStyle(this.root, 'pointer-events', 'none');
  }

  toggle() {
    if (this.open) this.hide();
    else this.show();
  }

  move(d) {
    const n = Math.min(this._count(), this.rows.length);
    if (n <= 0) return;
    this.index = (this.index + d + n) % n;
    this._paint();
    this._scrollToSel();
  }

  /**
   * Keep the highlighted row inside the capped list. `scrollIntoView` is
   * deliberately not used: it scrolls every scrollable ANCESTOR, and this
   * widget sits inside the HUD's own layers.
   */
  _scrollToSel() {
    const r = this.rows[this.index]?.r;
    if (!r) return;
    const list = this.list;
    const top = r.offsetTop;
    const bottom = top + r.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }

  cycleTab(d) {
    this.tab = (this.tab + d + TABS.length) % TABS.length;
    this.index = 0;
    this.list.scrollTop = 0;
    this._paint();
  }

  /** @returns {{kind:string,id:string}|null} what the highlighted row means */
  activate() {
    if (this.tab === TAB_CONTACTS) return { kind: 'character', id: BOYZ[this.index]?.id };
    if (this.tab === TAB_RADIO) return { kind: 'station', id: STATIONS[this.index]?.id };
    if (this.tab === TAB_STORY) {
      // A brother row is a call, exactly as on CONTACTS; a chapter row asks to
      // play it. `ui` routes `character`; `chapter` is inert until it does.
      if (this.index < BOYZ.length) return { kind: 'character', id: BOYZ[this.index]?.id };
      const c = this._chapters()[this.index - STORY_HEAD];
      return c ? { kind: 'chapter', id: c.index } : null;
    }
    return null;
  }

  /** The ACTIVE brother's chapter list, or an empty list before `game` exists. */
  _chapters() {
    const list = this.story?.chapterList;
    return Array.isArray(list) ? list : EMPTY;
  }

  _count() {
    if (this.tab === TAB_CONTACTS) return BOYZ.length;
    if (this.tab === TAB_RADIO) return STATIONS.length;
    if (this.tab === TAB_STORY) return STORY_HEAD + this._chapters().length;
    return 4;
  }

  _paint() {
    for (let i = 0; i < this.tabEls.length; i++) setClass(this.tabEls[i], 'on', i === this.tab);
    const n = Math.min(this._count(), this.rows.length);
    if (this.index >= n) this.index = 0;
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      if (i >= n) {
        setStyle(row.r, 'display', 'none');
        continue;
      }
      setStyle(row.r, 'display', '');
      setClass(row.r, 'sel', i === this.index);
      if (this.tab === TAB_CONTACTS) {
        const b = BOYZ[i];
        setStyle(row.dot, 'background', b.colour);
        setText(row.t, b.name);
        setText(row.sub, b.role.toUpperCase());
        setText(row.val, b.id === this.character ? 'ACTIVE' : 'CALL');
        setStyle(row.val, 'color', b.id === this.character ? b.accent : '');
      } else if (this.tab === TAB_RADIO) {
        const st = STATIONS[i];
        setStyle(row.dot, 'background', st.colour);
        setText(row.t, st.name);
        setText(row.sub, st.genre);
        setText(row.val, st.id === this.station ? '▶ ON AIR' : st.freq);
        setStyle(row.val, 'color', st.id === this.station ? st.colour : '');
      } else if (this.tab === TAB_STORY) {
        this._paintStory(row, i);
      } else {
        this._paintProgress(row, i);
      }
    }
  }

  /**
   * THE STORY PAGE — the report's "there is no way to tell what your progress
   * is in the missions or in the game", answered on the one screen a player
   * already opens for the radio.
   *
   * Three brothers with their own frontiers, the family completion percent,
   * the free-roam job tally, and then the ACTIVE brother's chapters with
   * `done` / `current` / `locked` in the colour of each. Everything is read off
   * `game.getProgress()`'s reused record — this widget derives nothing, so it
   * cannot disagree with the pause map or the story overview, which read the
   * same call.
   *
   * No allocation per row: it writes straight into the pooled DOM (rule 5).
   */
  _paintStory(row, i) {
    const s = this.story;
    if (i < BOYZ.length) {
      const b = BOYZ[i];
      const p = s?.boys?.[i] ?? null;
      const done = p ? p.done : 0;
      const total = p ? p.total : b.story?.length ?? 8;
      setStyle(row.dot, 'background', b.colour);
      setText(row.t, b.name);
      setText(row.sub, b.id === (s?.boy ?? this.character)
        ? 'ACTIVE · ' + b.role.toUpperCase() : b.role.toUpperCase());
      setText(row.val, p && p.storyDone ? 'COMPLETE' : `${done} / ${total}`);
      setStyle(row.val, 'color', b.accent);
      return;
    }
    if (i === BOYZ.length) {
      const pct = s ? s.percent : 0;
      setStyle(row.dot, 'background', '#ffc93c');
      setText(row.t, 'COMPLETION');
      setText(row.sub, `${s ? s.chapters : this.chapter} OF ${s ? s.total : 24} CHAPTERS`);
      setText(row.val, `${pct}%`);
      setStyle(row.val, 'color', '#ffc93c');
      return;
    }
    if (i === BOYZ.length + 1) {
      setStyle(row.dot, 'background', '#38c8c8');
      setText(row.t, 'SIDE JOBS');
      setText(row.sub, 'FREE-ROAM WORK DONE');
      setText(row.val, String(s ? s.jobs : 0));
      setStyle(row.val, 'color', '#38c8c8');
      return;
    }
    const c = this._chapters()[i - STORY_HEAD];
    const colour = STATUS_COLOUR[c?.status] ?? STATUS_COLOUR.locked;
    setStyle(row.dot, 'background', colour);
    setText(row.t, c ? `${c.no} · ${c.name}` : '');
    setText(row.sub, c?.best ? `BEST ${c.best}` : '');
    setText(row.val, (c?.status ?? '').toUpperCase());
    setStyle(row.val, 'color', colour);
  }

  /** The four headline counters. Same source as STORY — no second arithmetic. */
  _paintProgress(row, i) {
    const s = this.story;
    let name = '';
    let value = '';
    let colour = '#ffc93c';
    if (i === 0) {
      name = 'CHAPTERS';
      value = `${s ? s.chapters : this.chapter} / ${s ? s.total : 24}`;
    } else if (i === 1) {
      name = 'HIDDEN PACKAGES';
      colour = '#ffe36e';
      value = `${s ? s.packages : this.found} / ${s ? s.packagesTotal : PACKAGES.length}`;
    } else if (i === 2) {
      name = 'SIDE JOBS';
      colour = '#41e08a';
      value = String(s ? s.jobs : 0);
    } else {
      name = 'RESPECT';
      colour = '#ff6a12';
      value = String(this.respect | 0);
    }
    setStyle(row.dot, 'background', colour);
    setText(row.t, name);
    setText(row.sub, '');
    setText(row.val, value);
    setStyle(row.val, 'color', colour);
  }

  setState(o) {
    if (o.station !== undefined) this.station = o.station;
    if (o.character !== undefined) this.character = o.character;
    if (o.found !== undefined) this.found = o.found;
    if (o.respect !== undefined) this.respect = o.respect;
    if (o.chapter !== undefined) this.chapter = o.chapter;
    // `game.getProgress()`'s reused record. Held by reference on purpose —
    // see `this.story`.
    if (o.story !== undefined) this.story = o.story;
    if (o.hour !== undefined) {
      const h = Math.floor(o.hour) % 24;
      const m = Math.floor((o.hour % 1) * 60);
      setText(this.clock, `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`);
    }
    this._paint();
  }

  update(dt) {
    this.a = damp(this.a, this.open ? 1 : 0, 16, dt);
    if (!this.open && this.a < 0.005) {
      setStyle(this.root, 'display', 'none');
      return 0;
    }
    const k = ease.outCubic(this.a);
    setStyle(this.root, 'opacity', k.toFixed(3));
    setStyle(this.root, 'transform', `translateY(${((1 - k) * 46).toFixed(1)}px)`);
    return k;
  }

  dispose() {
    this.root.remove();
  }
}

const EMPTY = Object.freeze([]);
