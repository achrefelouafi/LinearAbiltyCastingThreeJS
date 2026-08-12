import { abilitiesBySchool, getAbility, getSchool, ABILITIES } from '../abilities/registry.js';
import { CastShape } from '../config/castShape.js';
import { sigilFor } from './glyphs/index.js';
import { SLOT_COUNT } from './Loadout.js';

/**
 * The spellbook — a full-screen browser for the whole roster.
 *
 * A hundred abilities do not fit on a bar, so the bar stops being the roster
 * and becomes a shortcut into it. `Tab` (or `B`) opens this; a card is one
 * ability, grouped under its school.
 *
 * ## The three ways in, and why there are three
 *
 * A hundred of anything is only navigable if the user can arrive from whichever
 * direction they already know the answer from:
 *
 *  - **Scanning** — one section per school with sticky headers, so the heading
 *    that tells you where you are never scrolls off. The first cut used nine
 *    fixed columns side by side, which is a lovely diagram and a terrible
 *    interface: with an uneven roster eight of the columns are half empty, the
 *    cards shrink to fit the narrowest one, and the blurb — the only thing that
 *    distinguishes two frost slots — gets clipped to two words.
 *  - **Jumping** — the school rail across the top, which scrolls to a section,
 *    tracks the one you are reading, and doubles as the roster's shape at a
 *    glance. `PgUp` / `PgDn` walk the same sections from the keyboard.
 *  - **Typing** — a fuzzy filter over name, school and blurb. No focus ritual:
 *    the book takes the keyboard while it is open, so you just type.
 *
 * ## What fifteen schools and a hundred cards changed
 *
 * Nothing structural, which was the point of the audit — the panel was built
 * for fifty and scaled to a hundred with four changes, none of them visual:
 *
 *  - **The rail wraps.** Fifteen chips do not fit across a 1420px header. It
 *    was already an `overflow-x: auto` strip with the scrollbar hidden, which
 *    at nine chips never scrolled and at fifteen silently hides Hive off the
 *    right-hand edge with nothing on screen to say so. It now wraps to two
 *    rows; the chips are unchanged and the rail is still the roster's shape.
 *  - **The rail follows the scroll.** With fifteen sections the header you are
 *    under is no longer obvious from the scrollbar, so an `IntersectionObserver`
 *    lights the chip for whichever section owns the top of the body. It is the
 *    same treatment `:hover` already gave a chip, so nothing new was designed.
 *  - **The filter walks arrays, not the DOM.** Every keystroke used to run
 *    `querySelectorAll('.spell')` once per section plus once over the body —
 *    a hundred and twenty element visits and two live NodeLists per character
 *    typed. The card lists are now sliced once at build time, and a card's
 *    `hidden` flag is only written when it actually changes, which is what
 *    keeps a hundred cards off the style-recalculation path.
 *  - **Nothing is virtualised.** A hundred cards is roughly six hundred
 *    elements, which every browser lays out in single-digit milliseconds, and
 *    the book is built once at boot rather than on open. Virtualisation would
 *    buy nothing and would cost the sticky headers, the arrow-key ring and the
 *    filter's ability to answer in one pass. Revisit it at a thousand.
 *
 * ## Keyboard ownership
 *
 * While the book is open it installs a **capture-phase** `keydown` listener on
 * the document and stops every key there. `InputManager` listens on `window` in
 * the bubble phase, which is the very last stop in the propagation path, so one
 * `stopPropagation()` at the top makes the game deaf for exactly as long as the
 * book is up. The alternative — an `enabled` flag on the input manager — needs
 * an exception carved out for the keys that close the book, and exceptions to a
 * mute switch are how a UI ends up casting a spell into its own search box.
 *
 * ## Selecting versus binding
 *
 * A click **casts-selects**: the ability goes in the slot, arms, and the book
 * closes — one click from "I wonder what Hailwrath looks like" to aiming it.
 * Binding is the deliberate act, so it takes a modifier or a drag: shift-click,
 * `Shift`+`Enter`, or dragging the card onto a slot in the bar, which stays
 * visible below the book for exactly that reason. Opening the book *from* an
 * empty slot puts it in bind mode, where a plain click binds instead — at that
 * point the user has already said which slot they mean.
 */

/**
 * How many abilities the finished roster has, for the "N of 100" readout.
 *
 * A constant rather than a count, because the whole point of the indicator is
 * the *gap*: `N` is `ABILITIES.length` and comes from the registry, and this is
 * what `docs/ROSTER.md` and `docs/ROSTER-II.md` between them specify. The two
 * being equal is the finish line, and a target derived from the registry could
 * never say anything but "done".
 */
export const ROSTER_TARGET = 100;

/** Cast-shape tags, as the cards label them. */
const SHAPE_TAG = {
  [CastShape.LINE]: 'ARROW',
  [CastShape.ZONE]: 'CIRCLE'
};

/* ------------------------------------------------------------------ */
/* Fuzzy matching                                                      */
/* ------------------------------------------------------------------ */

/**
 * Score `needle` as a subsequence of `hay`; `-1` when it is not one.
 *
 * Plain `includes()` is not enough for a roster where the memorable part of a
 * name is rarely its start — "cndr" should find Cinder Fall. The scoring is the
 * usual one: every matched character is worth something, consecutive matches
 * are worth more (so "cinder" beats "cndr" on the same card), and a gap costs a
 * little, capped so a long blurb is not punished into oblivion.
 *
 * Both arguments must already be lower case; this is called ~150 times per
 * keystroke and `toLowerCase()` in the loop was measurable.
 */
function subsequenceScore(needle, hay) {
  let score = 0;
  let cursor = 0;
  let streak = 0;

  for (let i = 0; i < needle.length; i++) {
    const at = hay.indexOf(needle[i], cursor);
    if (at < 0) return -1;
    streak = at === cursor && i > 0 ? streak + 1 : 0;
    // Word starts read as intentional: "gc" should find Glacial Crown.
    const boundary = at === 0 || hay[at - 1] === ' ' ? 3 : 0;
    score += 6 + streak * 4 + boundary - Math.min(at - cursor, 6);
    cursor = at + 1;
  }
  return score;
}

/* ------------------------------------------------------------------ */

export class Spellbook {
  /**
   * @param {HTMLElement} root  the overlay host, `#spellbook`
   * @param {object} hooks
   * @param {import('./Loadout.js').Loadout} hooks.loadout
   * @param {(id: string) => void} hooks.onSelect  cast-select and arm
   * @param {(slot: number, id: string) => void} [hooks.onBind] bind, warm and toast;
   *   when absent the book writes the loadout itself
   * @param {(id: string) => void} [hooks.onInspect] open this ability in the editor
   * @param {(open: boolean) => void} [hooks.onToggle] fired on every open/close
   * @param {(message: string) => void} [hooks.onToast]
   */
  constructor(root, hooks = {}) {
    this.root = root;
    this.loadout = hooks.loadout;
    this.onSelect = hooks.onSelect ?? null;
    this.onBind = hooks.onBind ?? null;
    this.onInspect = hooks.onInspect ?? null;
    this.onToggle = hooks.onToggle ?? null;
    this.onToast = hooks.onToast ?? null;

    this.isOpen = false;
    /** Slot a plain click binds to, or `null` for cast-select. */
    this._bindTarget = null;
    /** The ability the app currently has in the slot, highlighted here. */
    this._selected = null;
    /** Current filter text, lower case. */
    this._query = '';
    /** Cards passing the filter, in DOM order — the arrow-key ring. */
    this._visible = [];
    this._cursor = -1;
    /** Counts last written to the chips and headers, so the filter can skip. */
    this._shownCounts = new Map();
    /** The school whose section owns the top of the body, for the rail. */
    this._currentSchool = null;

    /**
     * Search haystacks, built once at construction.
     * Per keystroke this is a flat array walk instead of fifty registry lookups
     * and fifty string concatenations.
     */
    this._haystacks = ABILITIES.map((ability) => ({
      id: ability.id,
      label: ability.label.toLowerCase(),
      school: (getSchool(ability.school)?.label ?? ability.school).toLowerCase(),
      blurb: ability.blurb.toLowerCase(),
      shape: (SHAPE_TAG[ability.cast] ?? '').toLowerCase()
    }));

    this._build();

    this._unsubscribe = this.loadout.on('change', () => this._paintSlotKeys());
    this._onKeyDown = this._onKeyDown.bind(this);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  _build() {
    const groups = abilitiesBySchool();
    const registered = ABILITIES.length;

    this.root.innerHTML = `
      <div class="book__scrim" data-scrim></div>
      <div class="book" role="dialog" aria-modal="true" aria-label="Spellbook">
        <header class="book__head">
          <div class="book__brand">
            Spellbook
            <span class="book__count"><b>${registered}</b> of ${ROSTER_TARGET}</span>
          </div>
          <label class="book__search">
            <svg class="book__search-icon" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.4 15.4 L21 21" />
            </svg>
            <input type="text" spellcheck="false" autocomplete="off"
                   placeholder="Type to filter — name, school, description" data-search />
          </label>
          <div class="book__mode" data-mode hidden></div>
        </header>

        <nav class="book__rail" data-rail>
          ${groups
            .map(
              ({ school, abilities }) => `
            <button class="book-chip" data-jump="${school.id}" style="--accent:${school.accent}">
              <i></i>${school.label}<b>${abilities.length}</b>
            </button>`
            )
            .join('')}
        </nav>

        <div class="book__body" data-body>
          ${groups.map((group) => this._schoolMarkup(group)).join('')}
          <div class="book__empty" data-empty hidden>
            Nothing matches. <kbd>Esc</kbd> to close.
          </div>
        </div>

        <footer class="book__foot">
          <span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> browse</span>
          <span><kbd>PgUp</kbd><kbd>PgDn</kbd> school</span>
          <span><kbd>Enter</kbd> cast</span>
          <span><kbd>Shift</kbd> + click or drag onto a slot to bind</span>
          <span><kbd>Esc</kbd> close</span>
          <button class="book__reset" data-reset>Reset loadout</button>
        </footer>
      </div>
    `;

    this.panel = this.root.querySelector('.book');
    this.body = this.root.querySelector('[data-body]');
    this.search = this.root.querySelector('[data-search]');
    this.modeBadge = this.root.querySelector('[data-mode]');
    this.emptyNote = this.root.querySelector('[data-empty]');

    /** id → card element. The only lookup the filter and the cursor need. */
    this.cards = new Map();
    /** Every card in DOM order — the array the filter and the ring walk. */
    this._ordered = [];
    /** card → the index of the section holding it, for `PgUp` / `PgDn`. */
    this._cardSection = new Map();
    /** card → its `[data-key]` badge, so a rebind is not a hundred queries. */
    this._keyBadges = new Map();
    /** One entry per section: its element, its cards, and its live count node. */
    this.sections = [];

    this.chips = new Map(
      [...this.root.querySelectorAll('[data-jump]')].map((chip) => [chip.dataset.jump, chip])
    );

    for (const element of this.root.querySelectorAll('.book-school')) {
      const cards = [...element.querySelectorAll('.spell')];
      const index = this.sections.length;
      for (const card of cards) {
        this.cards.set(card.dataset.id, card);
        this._cardSection.set(card, index);
        this._keyBadges.set(card, card.querySelector('[data-key]'));
        this._ordered.push(card);
      }
      this.sections.push({
        id: element.dataset.school,
        element,
        cards,
        // Two counts that must always agree: the one in the sticky header and
        // the one in the chip that jumps to it. Resolved once, written together.
        headCount: element.querySelector('[data-school-count]'),
        chipCount: this.chips.get(element.dataset.school)?.querySelector('b') ?? null,
        chip: this.chips.get(element.dataset.school) ?? null
      });
    }

    this._paintSlotKeys();
    this._bindEvents();
    this._watchScroll();
  }

  /**
   * Light the chip for the section you are reading.
   *
   * At nine schools the rail was a menu; at fifteen it is also a position
   * indicator, because the sticky header only tells you where you are once you
   * have already looked away from the rail.
   *
   * This wants to be an `IntersectionObserver` and is not, twice over. The
   * question is "which heading was the last one to pass the top", and that is
   * not an intersection: a section taller than the observed band satisfies it
   * while intersecting nothing at all, which is how the first version got
   * stuck on Flame for the length of the roster. Answering it needs the
   * geometry anyway, and once you are reading rects the observer is only a
   * way of being told when to read them — which a scroll event does more
   * simply, and without the delivery quirks an observer has in a page that is
   * not the front tab.
   *
   * The read is one rect for the body plus one per section, at most once per
   * animation frame, and only while the body is actually being scrolled.
   */
  _watchScroll() {
    if (!this.sections.length) return;

    let queued = false;
    this._onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        this._markCurrentSchool();
      });
    };
    this.body.addEventListener('scroll', this._onScroll, { passive: true });
  }

  /** Light the chip for the last section whose heading is at or above the top. */
  _markCurrentSchool() {
    if (!this.sections.length) return;

    // One read of the body and at most fifteen of the sections, a few times per
    // scroll gesture. Sections are in document order, so the first one that has
    // not reached the top ends the walk.
    const band = this.body.getBoundingClientRect().top + 4;
    let current = this.sections[0].id;
    for (const section of this.sections) {
      if (section.element.hidden) continue;
      if (section.element.getBoundingClientRect().top > band) break;
      current = section.id;
    }

    if (current === this._currentSchool) return;
    this.chips.get(this._currentSchool)?.classList.remove('is-current');
    this.chips.get(current)?.classList.add('is-current');
    this._currentSchool = current;
  }

  _schoolMarkup({ school, abilities }) {
    return `
      <section class="book-school" data-school="${school.id}" style="--accent:${school.accent}">
        <h3 class="book-school__head">
          <i class="book-school__dot"></i>${school.label}
          <b data-school-count>${abilities.length}</b>
        </h3>
        <div class="book-school__grid">
          ${abilities.map((ability) => this._cardMarkup(ability)).join('')}
        </div>
      </section>`;
  }

  _cardMarkup(ability) {
    return `
      <div class="spell" role="button" tabindex="-1" draggable="true"
           data-id="${ability.id}" style="--accent:${ability.accent}"
           title="${ability.label} — ${ability.blurb}">
        <span class="spell__glyph">${sigilFor(ability.id)}</span>
        <span class="spell__text">
          <span class="spell__name">${ability.label}</span>
          <span class="spell__blurb">${ability.blurb}</span>
        </span>
        <span class="spell__shape">${SHAPE_TAG[ability.cast] ?? ''}</span>
        <span class="spell__key" data-key hidden></span>
      </div>`;
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  _bindEvents() {
    this.root.querySelector('[data-scrim]').addEventListener('pointerdown', () => this.close());

    for (const [id, chip] of this.chips) {
      chip.addEventListener('click', () => {
        this.root
          .querySelector(`.book-school[data-school="${id}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }

    this.root.querySelector('[data-reset]').addEventListener('click', () => {
      this.loadout.reset();
      this.onToast?.('Loadout reset');
    });

    this.search.addEventListener('input', () => this._applyFilter(this.search.value));

    // One delegated listener for a hundred cards, on the body rather than each:
    // the card markup is generated and re-generated, and per-card listeners are
    // fifty closures to leak on every rebuild.
    this.body.addEventListener('click', (event) => {
      const card = event.target.closest?.('.spell');
      if (!card) return;
      this._activate(card.dataset.id, event.shiftKey);
    });

    this.body.addEventListener('pointerover', (event) => {
      const card = event.target.closest?.('.spell');
      if (card) this._setCursor(this._visible.indexOf(card), { scroll: false });
    });

    this.body.addEventListener('dragstart', (event) => {
      const card = event.target.closest?.('.spell');
      if (!card) return;
      // `text/plain` so the drop target can read it during `dragover` in every
      // browser that bothers to expose the types list, and the app-specific
      // type so a stray text drag from elsewhere cannot bind a slot.
      event.dataTransfer.setData('text/plain', card.dataset.id);
      event.dataTransfer.setData('application/x-ability', card.dataset.id);
      event.dataTransfer.effectAllowed = 'copy';
      this.root.classList.add('is-dragging');
    });

    this.body.addEventListener('dragend', () => this.root.classList.remove('is-dragging'));
  }

  /* ------------------------------------------------------------------ */
  /* Open / close                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * @param {object} [options]
   * @param {number} [options.slot] open in bind mode, targeting this slot
   */
  open(options = {}) {
    const slot = Number.isInteger(options.slot) ? options.slot : null;
    this._bindTarget = slot !== null && slot >= 0 && slot < SLOT_COUNT ? slot : null;

    if (this._bindTarget === null) {
      this.modeBadge.hidden = true;
    } else {
      this.modeBadge.hidden = false;
      this.modeBadge.textContent = `Binding to ${this.loadout.keyAt(this._bindTarget)}`;
    }

    if (!this.isOpen) {
      this.isOpen = true;
      this.root.classList.add('is-open');
      // The editor is a `lil-gui` root at z 40 and would otherwise sit on the
      // book's right-hand column. It is a tool, not part of the reading, so it
      // fades for as long as the book is up; `G` brings it back afterwards.
      document.body.classList.add('is-book-open');
      document.addEventListener('keydown', this._onKeyDown, true);
      this.onToggle?.(true);
    }

    this.search.value = '';
    this._applyFilter('');
    // Focus is a convenience, not the input path — the capture handler feeds
    // the field either way — but it gives the caret somewhere honest to blink.
    this.search.focus({ preventScroll: true });

    const cursor = this._selected ? this._visible.indexOf(this.cards.get(this._selected)) : -1;
    this._setCursor(cursor >= 0 ? cursor : 0, { scroll: true, instant: true });
    // The cursor has just moved the body without a scroll event having been
    // dispatched yet, and on the first open nothing has scrolled at all.
    this._markCurrentSchool();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this._bindTarget = null;
    this.root.classList.remove('is-open', 'is-dragging');
    document.body.classList.remove('is-book-open');
    document.removeEventListener('keydown', this._onKeyDown, true);
    this.search.blur();
    this.onToggle?.(false);
  }

  toggle(options) {
    if (this.isOpen) this.close();
    else this.open(options);
  }

  /* ------------------------------------------------------------------ */
  /* State painting                                                      */
  /* ------------------------------------------------------------------ */

  /** Mirror the app's current slot into the book's highlight. */
  setSelected(id) {
    if (id === this._selected) return;
    if (this._selected) this.cards.get(this._selected)?.classList.remove('is-selected');
    this._selected = id;
    this.cards.get(id)?.classList.add('is-selected');
  }

  /**
   * Stamp each card with the key it is bound to, if any.
   *
   * Runs on every loadout change, so the badge element is resolved once at
   * build time rather than by a `querySelector` per card — at a hundred cards
   * that was a hundred selector matches to repaint at most eight badges.
   */
  _paintSlotKeys() {
    for (const [id, card] of this.cards) {
      const key = this.loadout.keyFor(id);
      const badge = this._keyBadges.get(card);
      if (!badge) continue;
      badge.hidden = !key;
      badge.textContent = key;
      card.classList.toggle('is-bound', Boolean(key));
    }
  }

  /* ------------------------------------------------------------------ */
  /* Filtering                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Re-run the filter. Called on every keystroke, so every line here is on a
   * budget of one hundred cards times however fast the user types.
   *
   * Three things keep it instant, and all three are about *not* touching the
   * DOM rather than about the scoring:
   *
   *  - the haystacks are a flat array built once, so no card is asked what it
   *    is called;
   *  - `hidden` is written only where it changes, because assigning the same
   *    value still invalidates style for that element and a hundred of those
   *    per keystroke is a visible stutter on a laptop;
   *  - the visible list is rebuilt from the cached DOM-order array instead of
   *    a fresh `querySelectorAll`, which is where the old version spent most
   *    of its time.
   */
  _applyFilter(raw) {
    const query = raw.trim().toLowerCase();
    this._query = query;

    let best = -Infinity;
    let bestCard = null;

    for (const hay of this._haystacks) {
      const card = this.cards.get(hay.id);
      if (!card) continue;
      const score = this._score(query, hay);
      const hit = score > -Infinity;
      if (card.hidden === hit) card.hidden = !hit;
      if (hit && score > best) {
        best = score;
        bestCard = card;
      }
    }

    // Fold away a school with nothing left in it, and correct its count so the
    // headers read as a live tally of the filter rather than of the roster.
    for (const section of this.sections) {
      let shown = 0;
      for (const card of section.cards) if (!card.hidden) shown++;

      if (this._shownCounts.get(section.id) !== shown) {
        this._shownCounts.set(section.id, shown);
        section.element.hidden = shown === 0;
        if (section.headCount) section.headCount.textContent = shown;
        // The chip carries the same number as the header it jumps to; two
        // counts side by side that disagree reads as a bug.
        if (section.chipCount) section.chipCount.textContent = shown;
        section.chip?.classList.toggle('is-dim', shown === 0);
      }
    }

    this._visible = this._ordered.filter((card) => !card.hidden);
    this.emptyNote.hidden = this._visible.length > 0;

    const index = bestCard ? this._visible.indexOf(bestCard) : -1;
    this._setCursor(index, { scroll: Boolean(query) });
  }

  /**
   * Best of the three haystacks, weighted: the name is what the user is most
   * likely typing, the school is a coarse filter ("frost"), and the blurb is
   * the long tail ("hailstones") that should match but never outrank a name.
   */
  _score(query, hay) {
    if (!query) return 0;

    const name = subsequenceScore(query, hay.label);
    if (name >= 0) return name * 3 + 40;

    const school = subsequenceScore(query, hay.school);
    if (school >= 0) return school * 2 + 20;

    if (hay.shape.startsWith(query)) return 15;
    // The blurb is a sentence, so a subsequence over it matches nearly
    // everything — substring only, and it scores below every name hit.
    if (hay.blurb.includes(query)) return 10;

    return -Infinity;
  }

  /* ------------------------------------------------------------------ */
  /* Cursor                                                              */
  /* ------------------------------------------------------------------ */

  _setCursor(index, options = {}) {
    const previous = this._visible[this._cursor];
    if (previous) previous.classList.remove('is-cursor');

    this._cursor = this._visible.length === 0 ? -1 : Math.max(0, Math.min(index, this._visible.length - 1));

    const card = this._visible[this._cursor];
    if (!card) return;
    card.classList.add('is-cursor');
    if (options.scroll !== false) {
      card.scrollIntoView({ block: 'nearest', behavior: options.instant ? 'auto' : 'smooth' });
    }
  }

  _moveCursor(delta) {
    if (this._visible.length === 0) return;
    const next = (this._cursor + delta + this._visible.length) % this._visible.length;
    this._setCursor(next);
  }

  /**
   * Vertical movement is a column count, not a fixed stride: the grid is
   * `auto-fill`, so how many cards make a row is a function of the window and
   * the only honest place to ask is the computed style at the moment of the
   * keypress. Once per arrow press, which is not a hot path.
   */
  _moveRow(direction) {
    const card = this._visible[this._cursor];
    if (!card) return this._moveCursor(direction);
    const columns = getComputedStyle(card.parentElement).gridTemplateColumns.split(' ').length;
    this._moveCursor(direction * Math.max(1, columns));
  }

  /**
   * `PgDn` / `PgUp`: the first card of the next or previous school.
   *
   * Fifteen sections is the point at which arrowing is no longer a way to get
   * anywhere — Hive is thirty row-presses from Frost — and the rail is a mouse
   * affordance. This is the rail from the keyboard, and it deliberately walks
   * the *visible* list, so under a filter it steps between the schools that
   * still have something in them rather than through empty ones.
   *
   * Backwards behaves the way "previous paragraph" does in a text editor: from
   * the middle of a section it goes to the top of that section first, and only
   * then to the one above. Jumping straight past the section you are reading
   * is the behaviour everyone complains about.
   *
   * The scroll is instant here where an arrow key's is smooth. A section jump
   * crosses most of the panel, and smoothly animating six hundred pixels turns
   * a keystroke into a wait — worse, holding the key queues animations that
   * each restart from wherever the last one had got to, and the cursor ends up
   * somewhere the view never reaches.
   */
  _moveSection(direction) {
    if (this._visible.length === 0) return;
    const jump = { instant: true };
    const from = this._cardSection.get(this._visible[this._cursor]);

    if (direction > 0) {
      for (let i = this._cursor + 1; i < this._visible.length; i++) {
        if (this._cardSection.get(this._visible[i]) !== from) return this._setCursor(i, jump);
      }
      return this._setCursor(this._visible.length - 1, jump);
    }

    let index = this._cursor - 1;
    while (index >= 0 && this._cardSection.get(this._visible[index]) === from) index--;
    if (index < 0) return this._setCursor(0, jump);
    const target = this._cardSection.get(this._visible[index]);
    while (index > 0 && this._cardSection.get(this._visible[index - 1]) === target) index--;
    return this._setCursor(index, jump);
  }

  /* ------------------------------------------------------------------ */
  /* Activation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * A card has been chosen. `bind` is the shift modifier — or the standing bind
   * mode, when the book was opened from an empty slot.
   */
  _activate(id, bind) {
    if (!getAbility(id)) return;

    if (bind || this._bindTarget !== null) {
      const slot = this._bindTarget ?? this._defaultBindSlot(id);
      // Routed through the app when it is listening, so a bind warms the class
      // and announces itself the same way a drag onto the bar does.
      if (this.onBind) this.onBind(slot, id);
      else if (this.loadout.bind(slot, id)) {
        this.onToast?.(`${getAbility(id).label} bound to ${this.loadout.keyAt(slot)}`);
      }
      // Bind mode is a one-shot: the slot the user asked for is filled, so the
      // book drops back to browsing rather than quietly rebinding it again.
      if (this._bindTarget !== null) {
        this._bindTarget = null;
        this.modeBadge.hidden = true;
        this.close();
      }
      return;
    }

    this.onSelect?.(id);
    this.close();
  }

  /**
   * Where a shift-click lands when the user has not named a slot: the first
   * empty one, and failing that the slot holding whatever is selected — which
   * is the slot they are looking at, so the swap is the one they can see.
   */
  _defaultBindSlot(id) {
    const already = this.loadout.slotOf(id);
    if (already >= 0) return already;
    const empty = this.loadout.firstEmpty();
    if (empty >= 0) return empty;
    const selected = this._selected ? this.loadout.slotOf(this._selected) : -1;
    return selected >= 0 ? selected : 0;
  }

  /* ------------------------------------------------------------------ */
  /* Keyboard                                                            */
  /* ------------------------------------------------------------------ */

  _onKeyDown(event) {
    if (!this.isOpen) return;

    // Everything, unconditionally: while the book is up the game does not get
    // the keyboard. See the class header.
    event.stopPropagation();

    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close();
        return;
      case 'Tab':
        // Tab opened it, Tab closes it. Preventing the default also keeps the
        // browser from walking focus out of the dialog.
        event.preventDefault();
        this.close();
        return;
      case 'ArrowRight':
        event.preventDefault();
        this._moveCursor(1);
        return;
      case 'ArrowLeft':
        event.preventDefault();
        this._moveCursor(-1);
        return;
      case 'ArrowDown':
        event.preventDefault();
        this._moveRow(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        this._moveRow(-1);
        return;
      case 'PageDown':
        event.preventDefault();
        this._moveSection(1);
        return;
      case 'PageUp':
        event.preventDefault();
        this._moveSection(-1);
        return;
      case 'Home':
        event.preventDefault();
        this._setCursor(0);
        return;
      case 'End':
        event.preventDefault();
        this._setCursor(this._visible.length - 1);
        return;
      case 'Enter': {
        event.preventDefault();
        const card = this._visible[this._cursor];
        if (card) this._activate(card.dataset.id, event.shiftKey);
        return;
      }
      default:
        break;
    }

    // Anything else is typing. The field owns it, so make sure it has focus —
    // a click on a card takes it away and the next keystroke would go nowhere.
    if (document.activeElement !== this.search) {
      this.search.focus({ preventScroll: true });
    }
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    document.removeEventListener('keydown', this._onKeyDown, true);
    if (this._onScroll) this.body?.removeEventListener('scroll', this._onScroll);
    this._unsubscribe?.();
    this.root.innerHTML = '';
    this.cards.clear();
    this._cardSection.clear();
    this._keyBadges.clear();
    this._ordered.length = 0;
    this.sections.length = 0;
  }
}
