import { getAbility, ABILITIES } from '../abilities/registry.js';
import { CastShape } from '../config/castShape.js';
import { sigilFor } from './glyphs/index.js';
import { SLOT_COUNT, SLOT_KEYS } from './Loadout.js';
import { ROSTER_TARGET } from './Spellbook.js';

/**
 * Heads-up display: the loadout bar, controls, live stats and toasts.
 *
 * Plain DOM — no framework. The bar used to be built from `ELEMENTS`, which was
 * fine at six abilities and is nonsense at a hundred: it now draws the **loadout**,
 * eight slots that the spellbook rebinds and `localStorage` remembers. A slot
 * can be empty, and an ability can be selected while holding no slot at all
 * (click a card in the book and it is armed on the spot), so the bar carries a
 * ninth *transient* card for exactly that case — otherwise the cooldown sweep
 * and the armed pulse would have nothing to draw on and the player would be
 * aiming a spell with no representation on screen.
 *
 * The cooldown sweep is a `conic-gradient` driven by a CSS custom property, so
 * updating it every frame is one `setProperty` call and never touches layout.
 *
 * The help panel is generated from the same loadout, because a hard-coded key
 * list is a lie the moment anything is rebound.
 *
 * The "N of 100" readout follows the same rule one level up: `N` is
 * `ABILITIES.length`, counted from the registry every time the HUD is built, so
 * an ability that lands is on the counter without anyone remembering to bump a
 * number. Only the *target* is a constant, and it is a constant on purpose —
 * it is what `docs/ROSTER.md` and `docs/ROSTER-II.md` specify between them, and
 * the gap between the two numbers is the entire point of showing them.
 */
export class HUD {
  /**
   * @param {HTMLElement} root
   * @param {import('./Loadout.js').Loadout} loadout
   */
  constructor(root, loadout) {
    this.root = root;
    this.loadout = loadout;

    /** Arm the ability in this slot. `(id) => void` */
    this.onAbility = null;
    /** Open the editor on this ability. `(id) => void` */
    this.onInspect = null;
    /** An empty slot was clicked — open the book to fill it. `(slot) => void` */
    this.onEmptySlot = null;
    /** A card was dropped on a slot. `(slot, id) => void` */
    this.onBind = null;

    this._toastTimer = 0;
    this._statsAccumulator = 0;
    this._frames = 0;
    this._fps = 0;
    /** Last sweep ratio pushed to the DOM, per ability id. */
    this._cooldownShown = new Map();
    this._armedShown = null;
    this._selected = null;

    root.innerHTML = `
      <div class="hud__panel hud__title">
        Elemental Sandbox
        <span data-blurb>Aim with the mouse, click to cast.</span>
        <span class="hud__roster">
          <b>${ABILITIES.length}</b> of ${ROSTER_TARGET} spells
          <kbd>Tab</kbd> spellbook
        </span>
      </div>

      <div class="hud__panel hud__stats">
        <div>FPS <b data-stat="fps">—</b></div>
        <div>Particles <b data-stat="particles">0</b></div>
        <div>Instances <b data-stat="spikes">0</b></div>
        <div>Draw calls <b data-stat="calls">0</b></div>
      </div>

      <div class="hud__panel hud__help" data-help></div>

      <div class="hud__abilities" data-bar></div>

      <div class="hud__toast" data-toast></div>
      <div class="hud__paused" data-paused>Paused</div>
    `;

    this.stats = {
      fps: root.querySelector('[data-stat="fps"]'),
      particles: root.querySelector('[data-stat="particles"]'),
      spikes: root.querySelector('[data-stat="spikes"]'),
      calls: root.querySelector('[data-stat="calls"]')
    };
    this.help = root.querySelector('[data-help]');
    this.toast = root.querySelector('[data-toast]');
    this.pausedBadge = root.querySelector('[data-paused]');
    this.abilityBar = root.querySelector('[data-bar]');

    /** id → the card elements showing it. A slot card, and maybe the transient. */
    this.cards = new Map();

    this._bindBar();
    this.refresh();
    this._unsubscribe = loadout.on('change', () => this.refresh());
  }

  /* ------------------------------------------------------------------ */
  /* Building the bar                                                    */
  /* ------------------------------------------------------------------ */

  /** Re-draw the bar and the help panel from the loadout. */
  refresh() {
    this.abilityBar.innerHTML = `
      ${Array.from({ length: SLOT_COUNT }, (_, slot) => this._slotMarkup(slot)).join('')}
      <div class="ability-card ability-card--loose" data-loose hidden>
        <div class="ability-card__sweep"></div>
        <div class="ability-card__key">—</div>
        <div class="ability-card__glyph" data-loose-glyph></div>
        <div class="ability-card__label" data-loose-label></div>
      </div>
    `;

    this.looseCard = this.abilityBar.querySelector('[data-loose]');
    this._indexCards();
    this._renderHelp();

    // The selection survives a rebind, so re-apply it to the fresh markup.
    if (this._selected) this.setElement(this._selected, { silent: true });
    // Sweep ratios are per id and the elements they were pushed to are gone.
    this._cooldownShown.clear();
  }

  _slotMarkup(slot) {
    const id = this.loadout.idAt(slot);
    const ability = id ? getAbility(id) : null;
    const key = SLOT_KEYS[slot];

    if (!ability) {
      return `
        <div class="ability-card is-empty" data-slot="${slot}">
          <div class="ability-card__key">${key}</div>
          <div class="ability-card__glyph"><span class="ability-card__plus">+</span></div>
          <div class="ability-card__label">Empty</div>
        </div>`;
    }

    return `
      <div class="ability-card" data-slot="${slot}" data-id="${ability.id}" draggable="true"
           style="--accent:${ability.accent}" title="${ability.label} — ${ability.blurb}">
        <div class="ability-card__sweep"></div>
        <div class="ability-card__key">${key}</div>
        <div class="ability-card__glyph">${sigilFor(ability.id)}</div>
        <button type="button" class="ability-card__label" data-inspect
                title="Open ${ability.label} in the editor">${ability.label}</button>
      </div>`;
  }

  _indexCards() {
    this.cards.clear();
    for (const card of this.abilityBar.querySelectorAll('.ability-card[data-id]')) {
      const list = this.cards.get(card.dataset.id);
      if (list) list.push(card);
      else this.cards.set(card.dataset.id, [card]);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bar interaction                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * One delegated listener per event on the bar, not per card: the bar is
   * rebuilt on every rebind, and per-card handlers would be eight closures
   * dropped on the floor each time.
   */
  _bindBar() {
    this.abilityBar.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      const card = event.target.closest?.('.ability-card');
      if (!card) return;

      // The label is a separate target: it opens the ability in the editor
      // rather than arming it, which is the one bit of the HUD that reaches
      // into the tuning UI. Deliberately not on selection — jumping the editor
      // every time the player swaps slot is intrusive.
      if (event.target.closest('[data-inspect]')) {
        if (card.dataset.id) this.onInspect?.(card.dataset.id);
        return;
      }

      if (card.classList.contains('is-empty')) {
        this.onEmptySlot?.(Number(card.dataset.slot));
        return;
      }
      if (card.dataset.id) this.onAbility?.(card.dataset.id);
    });

    /* ---- drag: from the spellbook, or from another slot ---- */

    this.abilityBar.addEventListener('dragstart', (event) => {
      const card = event.target.closest?.('.ability-card[data-id]');
      if (!card) return;
      event.dataTransfer.setData('text/plain', card.dataset.id);
      event.dataTransfer.setData('application/x-ability', card.dataset.id);
      event.dataTransfer.effectAllowed = 'move';
      card.classList.add('is-dragging');
    });

    this.abilityBar.addEventListener('dragend', (event) => {
      event.target.closest?.('.ability-card')?.classList.remove('is-dragging');
      for (const card of this.abilityBar.children) card.classList.remove('is-drop');
    });

    this.abilityBar.addEventListener('dragover', (event) => {
      const card = event.target.closest?.('.ability-card[data-slot]');
      if (!card) return;
      // Without the preventDefault the browser refuses the drop, silently.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      card.classList.add('is-drop');
    });

    this.abilityBar.addEventListener('dragleave', (event) => {
      event.target.closest?.('.ability-card')?.classList.remove('is-drop');
    });

    this.abilityBar.addEventListener('drop', (event) => {
      const card = event.target.closest?.('.ability-card[data-slot]');
      if (!card) return;
      event.preventDefault();
      card.classList.remove('is-drop');
      const id =
        event.dataTransfer.getData('application/x-ability') ||
        event.dataTransfer.getData('text/plain');
      if (id) this.onBind?.(Number(card.dataset.slot), id);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Help panel                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * The key list, generated.
   *
   * It was hard-coded, and hard-coded was already wrong the moment the loadout
   * became rebindable. Slots print as `letter / digit → name`, two to a row;
   * the far casts name themselves in the note underneath rather than the note
   * claiming "V and X" forever.
   */
  _renderHelp() {
    const bound = [];
    const zones = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const ability = getAbility(this.loadout.idAt(slot));
      if (!ability) continue;
      bound.push(
        `<span class="hud__key"><kbd>${SLOT_KEYS[slot]}</kbd><kbd>${slot + 1}</kbd>
          <i>${ability.label}</i></span>`
      );
      if (ability.cast === CastShape.ZONE) zones.push(ability.label);
    }

    const zoneNote =
      zones.length === 0
        ? ''
        : `<div class="hud__help-note">${this._list(zones)}
             ${zones.length > 1 ? 'are far casts' : 'is a far cast'} — aimed with a circle,
             not an arrow.</div>`;

    this.help.innerHTML = `
      <div class="hud__keys">${bound.join('')}</div>
      ${zoneNote}
      <div class="hud__help-note">
        <kbd>Tab</kbd> or <kbd>B</kbd> opens the spellbook — ${ABILITIES.length} spells,
        drag one onto a slot to bind it.
      </div>
      <div><strong>Move</strong> — aim &nbsp; <strong>Left click</strong> — cast</div>
      <div><strong>Esc / right click</strong> — cancel the cast</div>
      <div><strong>Right drag</strong> — orbit &nbsp; <strong>Scroll</strong> — zoom</div>
      <div style="margin-top:6px">
        <kbd>G</kbd> editor &nbsp; <kbd>P</kbd> pause &nbsp; <kbd>C</kbd> clear
      </div>
      <div><kbd>H</kbd> hide this &nbsp; click a slot's name to tune it</div>
      <div class="hud__help-note">Paused still applies every editor change.</div>
    `;
  }

  /** "A", "A and B", "A, B and C". */
  _list(items) {
    if (items.length < 2) return items[0] ?? '';
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Show which ability is in the slot.
   *
   * An ability with no slot — selected straight out of the spellbook — takes
   * over the transient card at the end of the bar, so it still has somewhere to
   * pulse and sweep. The moment it is bound to a real slot the transient card
   * folds away again.
   *
   * @param {string} element
   * @param {{silent?: boolean}} [options]
   */
  setElement(element, options = {}) {
    this._selected = element;
    const ability = getAbility(element);

    if (ability && !this.loadout.has(element)) {
      this.looseCard.hidden = false;
      this.looseCard.dataset.id = element;
      this.looseCard.style.setProperty('--accent', ability.accent);
      this.looseCard.querySelector('[data-loose-glyph]').innerHTML = sigilFor(element);
      this.looseCard.querySelector('[data-loose-label]').textContent = ability.label;
      this.looseCard.title = `${ability.label} — not bound to a slot`;
      this._indexCards();
    } else if (!this.looseCard.hidden) {
      this.looseCard.hidden = true;
      delete this.looseCard.dataset.id;
      this._indexCards();
    }

    for (const [id, cards] of this.cards) {
      for (const card of cards) card.classList.toggle('is-active', id === element);
    }

    if (ability && !options.silent) this.showToast(`${ability.label} selected`);
  }

  /** Highlight the slot while a cast is armed. */
  setArmed(armed) {
    if (armed === this._armedShown) return;
    this._armedShown = armed;
    this.abilityBar.classList.toggle('is-armed', armed);
  }

  /** The spellbook is up: dim the panels it would otherwise fight with. */
  setBookOpen(open) {
    this.root.classList.toggle('is-book-open', open);
  }

  /**
   * Drive one ability's cooldown sweep. Cooldowns are per ability, so this is
   * called once per registered id each frame — a `Map` miss for the forty-odd
   * that are not on the bar, which is the cheapest thing in the loop.
   *
   * @param {string} element
   * @param {number} remaining seconds left
   * @param {number} total     the full cooldown, for the sweep angle
   */
  setCooldown(element, remaining, total) {
    const cards = this.cards.get(element);
    if (!cards) return;

    const ratio = Math.max(0, Math.min(1, remaining / Math.max(total, 0.001)));
    // Only touch the DOM when the sweep visibly moves.
    if (Math.abs(ratio - (this._cooldownShown.get(element) ?? -1)) < 0.01) return;
    this._cooldownShown.set(element, ratio);
    for (const card of cards) {
      card.style.setProperty('--cooldown', ratio);
      card.classList.toggle('is-cooling', ratio > 0.001);
    }
  }

  setPaused(paused) {
    this.pausedBadge.classList.toggle('is-visible', paused);
  }

  toggleHelp() {
    this.help.classList.toggle('is-hidden');
  }

  showToast(message, duration = 1600) {
    this.toast.textContent = message;
    this.toast.classList.add('is-visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.toast.classList.remove('is-visible'), duration);
  }

  /**
   * @param {number} dt
   * @param {() => {particles:number, spikes:number, calls:number}} collect
   *   Called only when the readout actually refreshes, so gathering the numbers
   *   (which means walking the particle pools) stays off the hot path.
   */
  update(dt, collect) {
    this._frames++;
    this._statsAccumulator += dt;
    if (this._statsAccumulator < 0.4) return;

    this._fps = Math.round(this._frames / this._statsAccumulator);
    this._frames = 0;
    this._statsAccumulator = 0;

    const info = collect();
    this.stats.fps.textContent = this._fps;
    this.stats.particles.textContent = info.particles;
    this.stats.spikes.textContent = info.spikes;
    this.stats.calls.textContent = info.calls;
  }

  dispose() {
    clearTimeout(this._toastTimer);
    this._unsubscribe?.();
  }
}

/** Boot screen helper. */
export class LoadingScreen {
  constructor() {
    this.element = document.getElementById('loader');
    this.fill = document.getElementById('loader-fill');
    this.status = document.getElementById('loader-status');
  }

  setProgress(ratio, message) {
    this.fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
    if (message) this.status.textContent = message;
  }

  hide() {
    this.setProgress(1);
    setTimeout(() => this.element.classList.add('is-hidden'), 220);
  }

  fail(message) {
    this.status.textContent = message;
    this.status.style.color = '#ff7a6a';
  }
}
