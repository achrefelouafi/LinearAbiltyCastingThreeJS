import { EventEmitter } from '../utils/EventEmitter.js';
import { ABILITIES, getAbility } from '../abilities/registry.js';

/**
 * The loadout — which eight abilities are on the bar, and in what order.
 *
 * Fifty abilities do not fit on a keyboard, so the keyboard stops being the
 * roster and becomes a *view* of it. Eight slots, each holding an ability id or
 * `null`; the spellbook rebinds them; the binding is persisted. Everything that
 * used to index `ELEMENTS` by slot number now goes through here.
 *
 * ## Why the model is separate from the HUD
 *
 * Three consumers need the same eight values and none of them owns it: the HUD
 * draws them, the input manager binds keys from them, and the spellbook writes
 * them. The first cut hung the array off `HUD` and had the spellbook reach in
 * to mutate it, which worked right up until the input table needed to rebuild
 * on a rebind and there was nothing to listen to. So this is a tiny model with
 * one event: `change`, fired after any mutation, with no arguments — the whole
 * loadout is eight values and every listener re-reads all of them.
 *
 * ## What is a slot and what is a key
 *
 * `SLOT_KEYS[i]` is the letter for slot `i`, and digit `i + 1` mirrors it. The
 * letters are the ones the sandbox shipped with — `Q E R F V X` — plus `Z` and
 * `T` for the two new slots. `C` is deliberately *not* a slot: it clears the
 * scene and has done since the first build, and a demo where the muscle memory
 * for "clear" suddenly casts something is a worse demo.
 */

/** localStorage key. Versioned: a v2 slot count must not read a v1 array. */
const STORAGE_KEY = 'frost-sandbox.loadout.v1';

/**
 * Slot letters, in slot order. Digits `1..8` mirror them.
 *
 * The first six match the `key` field on the six registry descriptors that
 * shipped; `defaultLoadout()` asserts that correspondence rather than assuming
 * it, so moving a letter in the registry moves the ability with it.
 */
export const SLOT_KEYS = Object.freeze(['Q', 'E', 'R', 'F', 'V', 'X', 'Z', 'T']);

/** How many slots the bar has. Derived so the two can never disagree. */
export const SLOT_COUNT = SLOT_KEYS.length;

/**
 * What goes in the slots no registry entry claims with a `key`.
 *
 * Slots 7 and 8 (`Z` and `T`) are empty in the shipping six-ability build and
 * fill themselves in as the roster lands — the ids below are the first two of
 * the forty-four in `docs/ROSTER.md`. An id that is not registered yet is
 * skipped silently, which is why this list can name abilities that do not
 * exist: today it resolves to nothing and the slots read "empty", and the day
 * `rime` is registered the slot picks it up with no edit here.
 */
const DEFAULT_FILL = Object.freeze(['rime', 'hail']);

/**
 * The loadout a fresh browser gets: every registry entry that names a `key`
 * goes to that key's slot, then `DEFAULT_FILL` mops up what is left.
 *
 * Derived rather than written down, because a hand-written default is a second
 * place the letters live and the two drift the first time somebody swaps `V`
 * and `X` in the registry.
 *
 * @returns {(string|null)[]} exactly `SLOT_COUNT` entries
 */
export function defaultLoadout() {
  const slots = new Array(SLOT_COUNT).fill(null);
  const placed = new Set();

  for (const ability of ABILITIES) {
    if (!ability.key) continue;
    const slot = SLOT_KEYS.indexOf(ability.key.toUpperCase());
    if (slot < 0 || slots[slot]) continue;
    slots[slot] = ability.id;
    placed.add(ability.id);
  }

  let fill = 0;
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    if (slots[slot]) continue;
    while (fill < DEFAULT_FILL.length) {
      const id = DEFAULT_FILL[fill++];
      if (placed.has(id) || !getAbility(id)) continue;
      slots[slot] = id;
      placed.add(id);
      break;
    }
  }

  return slots;
}

/* ------------------------------------------------------------------ */

export class Loadout extends EventEmitter {
  constructor() {
    super();
    /** @type {(string|null)[]} slot index → ability id. Read through `idAt`. */
    this._slots = this._read();
  }

  /* ---- reading ---------------------------------------------------- */

  /**
   * The raw array. Treat it as read-only — mutating it skips the persist and
   * the `change` event, and the HUD will happily draw a stale bar for the rest
   * of the session.
   */
  get slots() {
    return this._slots;
  }

  /**
   * The slot letters, in slot order.
   *
   * Read through the instance rather than importing `SLOT_KEYS` directly, so
   * the day the letters themselves become rebindable there is one place that
   * has to change and every consumer already asks the right object.
   */
  get keys() {
    return SLOT_KEYS;
  }

  /** How many slots actually hold something. */
  get filled() {
    let count = 0;
    for (const id of this._slots) if (id) count++;
    return count;
  }

  /** Ability id in a slot, or `null` — including for an out-of-range index. */
  idAt(slot) {
    return this._slots[slot] ?? null;
  }

  /** The letter bound to a slot, or `''`. */
  keyAt(slot) {
    return SLOT_KEYS[slot] ?? '';
  }

  /** Which slot holds this id, or `-1`. */
  slotOf(id) {
    return this._slots.indexOf(id);
  }

  /** The letter this ability answers to, or `''` when it is not on the bar. */
  keyFor(id) {
    return this.keyAt(this.slotOf(id));
  }

  has(id) {
    return this.slotOf(id) >= 0;
  }

  /** First slot holding nothing, or `-1` when the bar is full. */
  firstEmpty() {
    return this._slots.indexOf(null);
  }

  /* ---- writing ---------------------------------------------------- */

  /**
   * Put an ability in a slot.
   *
   * An ability already on the bar **moves** rather than duplicating: the two
   * slots swap contents. Two slots holding the same spell is never what the
   * drag meant, and the alternative — silently refusing the drop — reads as a
   * broken drag target.
   *
   * @param {number} slot
   * @param {string|null} id  a registered ability id, or null to empty the slot
   * @returns {boolean} whether anything changed
   */
  bind(slot, id) {
    if (slot < 0 || slot >= SLOT_COUNT) return false;
    if (id !== null && !getAbility(id)) return false;
    if (this._slots[slot] === id) return false;

    const from = id === null ? -1 : this._slots.indexOf(id);
    if (from >= 0) this._slots[from] = this._slots[slot];
    this._slots[slot] = id;

    this._commit();
    return true;
  }

  /** Empty a slot. */
  clearSlot(slot) {
    return this.bind(slot, null);
  }

  /** Exchange two slots' contents. Used by dragging one bar card onto another. */
  swap(a, b) {
    if (a === b) return false;
    if (a < 0 || b < 0 || a >= SLOT_COUNT || b >= SLOT_COUNT) return false;
    const held = this._slots[a];
    this._slots[a] = this._slots[b];
    this._slots[b] = held;
    this._commit();
    return true;
  }

  /** Back to the registry-derived default. */
  reset() {
    this._slots = defaultLoadout();
    this._commit();
    return true;
  }

  /* ---- persistence ------------------------------------------------- */

  /**
   * Read the stored loadout, repairing anything that no longer makes sense.
   *
   * Stored ids are validated against the registry one by one instead of the
   * array being accepted or rejected whole: a saved bar that names one ability
   * which has since been renamed should lose that slot, not the other seven.
   * Any failure at all — no storage, bad JSON, wrong shape — falls back to the
   * default, because a spellbook demo that will not boot in private browsing is
   * not a demo.
   */
  _read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultLoadout();
      const stored = JSON.parse(raw);
      if (!Array.isArray(stored)) return defaultLoadout();

      const slots = new Array(SLOT_COUNT).fill(null);
      const placed = new Set();
      for (let slot = 0; slot < SLOT_COUNT; slot++) {
        const id = stored[slot];
        if (typeof id !== 'string' || placed.has(id) || !getAbility(id)) continue;
        slots[slot] = id;
        placed.add(id);
      }
      return slots;
    } catch (error) {
      console.warn('[Loadout] could not read the stored loadout', error);
      return defaultLoadout();
    }
  }

  _commit() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._slots));
    } catch (error) {
      // Private browsing, a full quota, a file:// origin. The bar still works
      // for this session; it just will not survive a reload.
      console.warn('[Loadout] could not persist the loadout', error);
    }
    this.emit('change');
  }
}
