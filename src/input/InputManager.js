import { Vector2 } from 'three';
import { EventEmitter } from '../utils/EventEmitter.js';

/**
 * Normalises pointer + keyboard input into a small event vocabulary.
 *
 * Events:
 *   `pointer:move` (ndc)          — every move, armed or not
 *   `pointer:confirm` (ndc)       — left click on the viewport
 *   `action` (name, slot)         — everything else, already named by intent.
 *                                   `ability` carries the 0-based slot index,
 *                                   which App maps through the loadout.
 *
 * Pointer events that begin on top of DOM UI (the editor, the HUD) are ignored
 * so dragging a slider never fires the ability.
 *
 * ## Why the switch went away
 *
 * The keyboard used to be a `switch` with one hard-coded `case` per ability
 * letter. That is fine while the letters *are* the roster; it stops being fine
 * the moment eight slots are rebindable over fifty abilities, because the truth
 * about which key means which slot then lives in `Loadout` and a second copy in
 * a switch statement is a second copy that will be wrong.
 *
 * So the letters arrive as data — `setSlotKeys(['Q','E',...])` — and are folded
 * into one lookup table alongside the fixed actions. Rebinding is a call, not
 * an edit. Two rules make the table safe to build from user data:
 *
 *  - **Reserved keys win.** `C` clears the scene and has since the first build;
 *    a loadout that tries to claim it loses, loudly, in the console. Muscle
 *    memory that suddenly casts a spell is worse than a slot that will not bind.
 *  - **Digits mirror letters.** Slot `i` also answers to digit `i + 1`, which is
 *    generated here rather than being eight more rows to keep in step.
 */

/**
 * Keys that are not slots and never will be.
 *
 * `Tab` is the spellbook, which costs the page its focus-traversal key; that is
 * a fair trade in a full-screen canvas demo with one text field in it, and `B`
 * is kept as the alternative for anyone who disagrees.
 */
const RESERVED_KEYS = Object.freeze({
  Escape: 'cancel',
  KeyH: 'toggleHelp',
  KeyG: 'toggleEditor',
  KeyC: 'clear',
  KeyP: 'togglePause',
  Tab: 'toggleSpellbook',
  KeyB: 'toggleSpellbook'
});

/** Keys whose browser default would fight the app. */
const SWALLOW_DEFAULT = new Set(['Tab']);

export class InputManager extends EventEmitter {
  /**
   * @param {HTMLElement} domElement
   * @param {object} [options]
   * @param {string[]} [options.slotKeys] one letter per loadout slot, in order
   */
  constructor(domElement, options = {}) {
    super();
    this.dom = domElement;
    this.pointer = new Vector2(); // NDC
    this.keys = new Set();
    this.enabled = true;

    /** `KeyboardEvent.code` → slot index. Rebuilt by `setSlotKeys`. */
    this._slotByCode = new Map();
    this.setSlotKeys(options.slotKeys ?? []);

    this._bind();
  }

  /**
   * Point the slot keys at a new letter list.
   *
   * Cheap and idempotent: call it every time the loadout changes and forget
   * about it. A letter that collides with a reserved key is dropped and its
   * slot becomes digit-only.
   *
   * @param {string[]} keys one letter per slot, in slot order
   */
  setSlotKeys(keys) {
    this._slotByCode.clear();
    for (let slot = 0; slot < keys.length; slot++) {
      const letter = String(keys[slot] ?? '').toUpperCase();
      if (letter.length === 1) {
        const code = `Key${letter}`;
        if (code in RESERVED_KEYS) {
          console.warn(
            `[InputManager] slot ${slot + 1} wants ${letter}, which is reserved for ` +
              `"${RESERVED_KEYS[code]}" — the slot keeps its digit only.`
          );
        } else {
          this._slotByCode.set(code, slot);
        }
      }
      // Digits 1..9 mirror the letters. Ten slots would need `Digit0`; eight do not.
      if (slot < 9) this._slotByCode.set(`Digit${slot + 1}`, slot);
    }
  }

  _bind() {
    this.dom.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    this.dom.addEventListener('contextmenu', this._onContextMenu);
  }

  _onContextMenu = (event) => event.preventDefault();

  _updatePointer(event) {
    this.pointer.set(
      (event.clientX / window.innerWidth) * 2 - 1,
      -(event.clientY / window.innerHeight) * 2 + 1
    );
  }

  _onPointerDown = (event) => {
    if (!this.enabled) return;
    if (event.target !== this.dom) return; // started on UI

    this._updatePointer(event);

    if (event.button === 0) {
      this.emit('pointer:confirm', this.pointer);
    } else if (event.button === 2) {
      // Right button also orbits (OrbitControls owns the drag); putting an armed
      // cast away on the same press is the convention players expect.
      this.emit('action', 'cancel');
    }
  };

  _onPointerMove = (event) => {
    this._updatePointer(event);
    this.emit('pointer:move', this.pointer);
  };

  _onKeyDown = (event) => {
    if (event.repeat) return;
    const target = event.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

    this.keys.add(event.code);

    // Reserved first, so a bad rebind can never shadow "clear" or "pause".
    const action = RESERVED_KEYS[event.code];
    if (action) {
      if (SWALLOW_DEFAULT.has(event.code)) event.preventDefault();
      this.emit('action', action);
      return;
    }

    const slot = this._slotByCode.get(event.code);
    if (slot !== undefined) this.emit('action', 'ability', slot);
  };

  _onKeyUp = (event) => {
    this.keys.delete(event.code);
  };

  dispose() {
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.dom.removeEventListener('contextmenu', this._onContextMenu);
    this.clear();
  }
}
