/**
 * Ability sigils for the HUD and the spellbook.
 *
 * Drawn inline so they inherit `currentColor` (the slot's `--accent`) and need
 * no image assets — the same rule the rest of the project follows: nothing is a
 * texture, including the icons.
 *
 * One module per school, folded together here. Splitting them was not
 * housekeeping: a hundred sigils in one file is a hundred merge conflicts when
 * seventeen agents author them in parallel, and a sigil belongs next to the
 * other marks it has to be *distinguishable from*, which is its school's.
 *
 * A new school adds two lines here — the import, and the spread in
 * `ELEMENT_SIGILS` — and `npm run check` fails the roster if a school in
 * `SCHOOLS` has no module folded in, so the pair cannot drift apart.
 *
 * The envelope lives in `./wrap.js`. See that file for the authoring rules —
 * the short version is one mark, three to six strokes, and a diagonal for a
 * line cast against an ellipse for a far cast.
 */

import { FROST_SIGILS } from './frost.js';
import { FLAME_SIGILS } from './flame.js';
import { STORM_SIGILS } from './storm.js';
import { STONE_SIGILS } from './stone.js';
import { VERDANT_SIGILS } from './verdant.js';
import { VOID_SIGILS } from './void.js';
import { ARCANE_SIGILS } from './arcane.js';
import { BLOOD_SIGILS } from './blood.js';
import { AETHER_SIGILS } from './aether.js';
import { TIDE_SIGILS } from './tide.js';
import { FORGE_SIGILS } from './forge.js';
import { LUMEN_SIGILS } from './lumen.js';
import { INK_SIGILS } from './ink.js';
import { CHRONO_SIGILS } from './chrono.js';
import { HIVE_SIGILS } from './hive.js';

/**
 * ability id → inline SVG markup.
 *
 * Flat rather than nested by school, because every consumer looks a sigil up by
 * the id it already has and none of them care which file it came from. School
 * ordering matches `SCHOOLS` in the registry so a duplicate id would be caught
 * by reading the spread in one direction.
 */
export const ELEMENT_SIGILS = Object.freeze({
  ...FROST_SIGILS,
  ...FLAME_SIGILS,
  ...STORM_SIGILS,
  ...STONE_SIGILS,
  ...VERDANT_SIGILS,
  ...VOID_SIGILS,
  ...ARCANE_SIGILS,
  ...BLOOD_SIGILS,
  ...AETHER_SIGILS,
  ...TIDE_SIGILS,
  ...FORGE_SIGILS,
  ...LUMEN_SIGILS,
  ...INK_SIGILS,
  ...CHRONO_SIGILS,
  ...HIVE_SIGILS
});

/**
 * The sigil for an ability, or an empty string.
 *
 * Always use this rather than indexing the map. A registry entry can land
 * before its sigil is drawn — that is the normal order of work on a new
 * ability, and a slot with no icon is a fine intermediate state. Indexing
 * directly puts `undefined` into an `innerHTML` and prints the word on the bar,
 * which looks like a bug and is not one.
 *
 * @param {string} id
 * @returns {string} inline SVG, or '' if this ability has no sigil yet
 */
export function sigilFor(id) {
  return ELEMENT_SIGILS[id] ?? '';
}
