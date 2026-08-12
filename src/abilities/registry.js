/**
 * registry.js — abilities are data.
 *
 * This is the single place an ability is *declared*. Nothing else in the
 * project enumerates abilities: the HUD builds its bar from here, the aim
 * controller asks here whether it should draw an arrow or a circle, the editor
 * groups its folders by the school named here, and `config/settings.js` derives
 * `ELEMENTS` and `ELEMENT_META` from here rather than holding its own list.
 *
 * The two halves of a descriptor are loaded on very different schedules, and
 * the split is the whole design:
 *
 *  - **`load` is lazy.** A hundred ability classes are not constructed at boot;
 *    each one is a few hundred lines that build meshes, materials and particle
 *    systems the moment they are instantiated. `AbilityManager` builds a pool
 *    for an id the first time that id is selected or cast, and `App` calls
 *    `warm(id)` on selection so the class is in memory long before the click.
 *  - **`settings` is not lazy.** Every block is registered at module load,
 *    because the editor, the preset system, `DEFAULT_SETTINGS` and the aim
 *    controller all need the complete tree up front. Settings modules are plain
 *    numbers and `#rrggbb` strings with no imports — they must stay cheap.
 *
 * The `settings` field holds the **live block object**, not a copy and not a
 * loader: `getAbility('ice').settings === settings.ice`. Mutating one mutates
 * the other, which is what keeps a slider live on a standing effect.
 *
 * This module must never import `config/settings.js`. `settings.js` imports
 * *this* to build its derived views, and closing that loop leaves the registry
 * evaluating against a half-initialised module. `CastShape` lives in
 * `config/castShape.js` for exactly that reason.
 */

import { CastShape } from '../config/castShape.js';
import { ABILITY_SETTINGS } from '../config/abilities/index.js';

/* ------------------------------------------------------------------ */
/* Schools                                                             */
/* ------------------------------------------------------------------ */
/**
 * The fifteen schools, declared once.
 *
 * A school is a grouping, not a mechanic — it decides which section of the
 * spellbook an ability sits in, which top-level editor folder holds it, and
 * which `ui/glyphs/<school>.js` its sigil is authored in. `accent` is the
 * school's own colour and is *not* inherited by its abilities: every ability
 * carries its own `accent`, because two frost slots that are the same blue are
 * two slots the player cannot tell apart at 34px.
 *
 * **Order is the reading order** of the spellbook rail, the editor's folder
 * list and `abilitiesBySchool()`. The nine that shipped keep their positions —
 * the rail is a shape people learn — and the six new schools are appended in
 * the order `docs/ROSTER-II.md` introduces them.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  ADDING A SCHOOL
 * ─────────────────────────────────────────────────────────────────────
 *  1. Append here. Never reorder.
 *  2. Create `src/ui/glyphs/<id>.js` from the stub shape the other fourteen
 *     use — the two append anchors included, because that is what lets several
 *     agents author sigils into one school without colliding — and fold it into
 *     `src/ui/glyphs/index.js`. `npm run check` fails a school with no glyph
 *     module, so a sixteenth school cannot land half-wired.
 *  3. Give the editor a leading mark in `SCHOOL_MARK` (`ui/Editor.js`). Missing
 *     is survivable — it falls back to `◇` — but two schools sharing `◇` is a
 *     panel you cannot skim.
 * Nothing else enumerates schools.
 *
 * **On the accents.** These are read as a 7–8px dot on near-black next to
 * fourteen others, so "different enough" was decided by measuring rather than
 * by eye: every pair was scored with the redmean approximation `check.mjs` now
 * runs on every build, and the bar was set by the *tightest pair already
 * shipping* — frost `#7ecbe0` against aether `#8fe8d8`, at 0.081. Anything
 * closer than that is a pair the nine-school rail has never asked anyone to
 * tell apart, and two of the six proposed accents were closer than that:
 *
 *  - **Lumen** was proposed `#ffd98a`, which scores **0.033** against arcane's
 *    `#ffd27a` — a seven-unit difference in one channel, less than half the
 *    separation of the tightest shipped pair, and the worst collision in the
 *    set by a factor of two. Lumen is the school where light is the object
 *    rather than the ornament, so it took the bleached end of the warm ramp
 *    instead: `#ffeec2`, 0.144 from arcane.
 *  - **Chrono** was proposed `#e8c78a`, which scores **0.063** against the same
 *    arcane gold — still under the bar, and next to lumen's original it would
 *    have made three chips nobody could separate. It moved down and back to
 *    `#d5be8c`, a genuinely bone amber whose nearest neighbour is now 0.107
 *    away. It also reads quieter, which is the school.
 *
 * **Forge stays as proposed.** `#d8763a` against flame's `#ff8a3c` looks like
 * the obvious collision in this list and measures 0.097 — wider apart than
 * frost and storm are today. Do not "fix" it.
 *
 * Tide, ink and hive landed as proposed: tide's saturated teal holds against
 * frost's pale blue and aether's mint, ink's warm bone is far lighter and far
 * flatter than stone's tan, and hive's olive is the only yellow-green in the
 * set.
 */
export const SCHOOLS = Object.freeze([
  { id: 'frost', label: 'Frost', accent: '#7ecbe0' },
  { id: 'flame', label: 'Flame', accent: '#ff8a3c' },
  { id: 'storm', label: 'Storm', accent: '#7fb4ff' },
  { id: 'stone', label: 'Stone', accent: '#a89880' },
  { id: 'verdant', label: 'Verdant', accent: '#7fc85f' },
  { id: 'void', label: 'Void', accent: '#a98bff' },
  { id: 'arcane', label: 'Arcane', accent: '#ffd27a' },
  { id: 'blood', label: 'Blood', accent: '#e04a5a' },
  { id: 'aether', label: 'Aether', accent: '#8fe8d8' },
  { id: 'tide', label: 'Tide', accent: '#3fb9c8' }, //  deep teal — wet, and lit from below
  { id: 'forge', label: 'Forge', accent: '#d8763a' }, //  scale orange — flame with the heat taken out
  { id: 'lumen', label: 'Lumen', accent: '#ffeec2' }, //  bleached warm white — light itself, not gold
  { id: 'ink', label: 'Ink', accent: '#d8d2c4' }, //  bone paper — the one matte school
  { id: 'chrono', label: 'Chrono', accent: '#d5be8c' }, //  bone amber — quiet, and slightly wrong
  { id: 'hive', label: 'Hive', accent: '#b8a44a' } //  chitin olive — the only yellow-green
]);

/** school id → its descriptor. Built once; the list above is the source. */
const SCHOOL_BY_ID = new Map(SCHOOLS.map((school) => [school.id, school]));

/** Look up a school. Returns `undefined` for an unknown id — callers guard. */
export function getSchool(id) {
  return SCHOOL_BY_ID.get(id);
}

/* ------------------------------------------------------------------ */
/* The roster                                                          */
/* ------------------------------------------------------------------ */
/**
 * One descriptor per ability.
 *
 * ```
 * {
 *   id,       // settings key, particle-system prefix, glyph key, pool key
 *   label,    // shown in the HUD slot, the spellbook card and the editor folder
 *   school,   // one of SCHOOLS[].id
 *   accent,   // this ability's own slot colour, #rrggbb
 *   key,      // optional: the keyboard letter, if it holds a default loadout slot
 *   cast,     // CastShape.LINE or CastShape.ZONE
 *   blurb,    // one sentence, present tense, what the player sees
 *   load,     // () => Promise<class>  — lazy, see the header
 *   settings   // the live block from config/abilities/<id>.js — NOT lazy
 * }
 * ```
 *
 * Order is slot order: the first six hold the six keys the sandbox shipped
 * with, and `ELEMENTS` is this array's ids in this order.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  APPENDING TO THE ROSTER — read this before you add your entry
 * ─────────────────────────────────────────────────────────────────────
 *
 * Seventeen agents at a time write into this array. To keep the diffs disjoint
 * and the merges clean:
 *
 *  1. **Append.** Add your entry at the end of `ABILITIES`, below the marker
 *     comment. Never reorder or reformat the entries above yours — the six
 *     that shipped hold keyboard slots by array index.
 *  2. **One entry, five lines.** Match the shape below exactly. No blank line
 *     inside an entry, one blank line between entries.
 *  3. **`id` is the contract.** It is the settings key (`settings.rime`), the
 *     particle-system prefix (`'rime.mist'`), the glyph key
 *     (`ELEMENT_SIGILS.rime`), and the pool key. Lower case, no punctuation,
 *     the id printed in `docs/ROSTER.md`.
 *  4. **`load` names the class, not the module.** `.then((m) => m.RimeAbility)`
 *     — the manager awaits a *class*, and a module namespace object thrown into
 *     `new` is a very confusing stack trace.
 *  5. **`settings` is `ABILITY_SETTINGS.<id>`**, which means your block must be
 *     imported in `config/abilities/index.js` first. Do that edit in the same
 *     commit or the registry entry throws on load.
 *  6. **`accent` is yours to choose**, but check it against the school's other
 *     accents at 34px on the dark bar before you commit it. Two slots the same
 *     blue is a bug the compiler cannot see.
 *  7. **No `key`.** Eight keyboard slots exist and a hundred abilities do not
 *     fit on them; the spellbook binds them at runtime and the binding is saved
 *     to `localStorage`. Omit the field entirely.
 *
 * The worked example, which is a real entry from `docs/ROSTER.md` and should be
 * copied verbatim as a starting point:
 *
 * ```js
 *   {
 *     id: 'rime',
 *     label: 'Rimewalker',
 *     school: 'frost',
 *     accent: '#7ecbe0',
 *     cast: CastShape.LINE,
 *     blurb: 'Sheet ice glazes the floor and peels up behind the front.',
 *     load: () => import('./frost/RimeAbility.js').then((m) => m.RimeAbility),
 *     settings: ABILITY_SETTINGS.rime
 *   }
 * ```
 *
 * A `ZONE` entry is the same five lines with `cast: CastShape.ZONE`, plus a
 * `zoneRadius` in its settings block — that is the entire difference, and the
 * circle indicator, the reach ring and the snap-out come for free.
 *
 * New classes live in `src/abilities/<school>/<Name>Ability.js`. The six that
 * shipped predate the school directories and stay where they are; do not move
 * them, their relative imports are load-bearing and the churn buys nothing.
 */
export const ABILITIES = [
  {
    id: 'ice',
    label: 'Frost Lance',
    school: 'frost',
    accent: '#5fd0ff',
    key: 'Q',
    cast: CastShape.LINE,
    blurb: 'A fracture front races out and a field of crystal tears up behind it.',
    load: () => import('./IceAbility.js').then((m) => m.IceAbility),
    settings: ABILITY_SETTINGS.ice
  },

  {
    id: 'thunder',
    label: 'Storm Lance',
    school: 'storm',
    accent: '#7fb4ff',
    key: 'E',
    cast: CastShape.LINE,
    blurb: 'A bundle of lightning filaments snaps out, gutters, and blows out.',
    load: () => import('./ThunderAbility.js').then((m) => m.ThunderAbility),
    settings: ABILITY_SETTINGS.thunder
  },

  {
    id: 'meteor',
    label: 'Cinder Fall',
    school: 'flame',
    accent: '#ff8a3c',
    key: 'R',
    cast: CastShape.LINE,
    blurb: 'A burning rock is lobbed downrange and tears the floor open where it lands.',
    load: () => import('./MeteorAbility.js').then((m) => m.MeteorAbility),
    settings: ABILITY_SETTINGS.meteor
  },

  {
    id: 'beam',
    label: 'Nova Beam',
    school: 'arcane',
    accent: '#7ff0ff',
    key: 'F',
    cast: CastShape.LINE,
    blurb: 'A charged column of light is let out along the line, and holds there burning.',
    load: () => import('./BeamAbility.js').then((m) => m.BeamAbility),
    settings: ABILITY_SETTINGS.beam
  },

  {
    id: 'snare',
    label: 'Voltaic Snare',
    school: 'storm',
    accent: '#a98bff',
    key: 'V',
    cast: CastShape.ZONE,
    blurb: 'A trap of current snaps open on the circle and hauls the air up into a pillar.',
    load: () => import('./SnareAbility.js').then((m) => m.SnareAbility),
    settings: ABILITY_SETTINGS.snare
  },

  {
    id: 'glacier',
    label: 'Glacial Crown',
    school: 'frost',
    accent: '#8ee8ff',
    key: 'X',
    cast: CastShape.ZONE,
    blurb: 'A ring of blades closes around the footprint, stands, and breaks apart.',
    load: () => import('./GlacierAbility.js').then((m) => m.GlacierAbility),
    settings: ABILITY_SETTINGS.glacier
  },

  /* ---------------------------------------------------------------- */
  /* APPEND NEW ABILITIES BELOW THIS LINE — see the note above.        */
  /* ---------------------------------------------------------------- */

  {
    id: 'geyser',
    label: 'Geyser',
    school: 'tide',
    accent: '#1fd6e8',
    cast: CastShape.ZONE,
    blurb: 'A vent blows a column of water into the air, and the column comes back down as rain.',
    load: () => import('./tide/GeyserAbility.js').then((m) => m.GeyserAbility),
    settings: ABILITY_SETTINGS.geyser
  },

  {
    id: 'pistondrive',
    label: 'Piston Drive',
    school: 'forge',
    accent: '#9fb0bc',
    cast: CastShape.LINE,
    blurb: 'A battery of hydraulic rams bolts itself into the lane and slams down the line on a cam.',
    load: () => import('./forge/PistondriveAbility.js').then((m) => m.PistondriveAbility),
    settings: ABILITY_SETTINGS.pistondrive
  },

  {
    id: 'astralgate',
    label: 'Astral Gate',
    school: 'arcane',
    accent: '#7d5cff',
    cast: CastShape.ZONE,
    blurb: 'A ring gate tears open in the air and obelisks of astral stone climb out through it.',
    load: () => import('./arcane/AstralgateAbility.js').then((m) => m.AstralgateAbility),
    settings: ABILITY_SETTINGS.astralgate
  },

  {
    id: 'entropy',
    label: 'Entropy Wave',
    school: 'chrono',
    // Rusted bronze. Chrono is pale amber and bone, and every other slot in it
    // takes the pale end; this is the one that is about corrosion, so it takes
    // the ramp all the way down into the oxide.
    accent: '#a8794e',
    cast: CastShape.ZONE,
    blurb: 'A wave of decay crosses the floor — rust, dust, moss and pitting — and then takes it all back.',
    load: () => import('./chrono/EntropyAbility.js').then((m) => m.EntropyAbility),
    settings: ABILITY_SETTINGS.entropy
  },

  {
    id: 'rewind',
    label: 'Rewind',
    school: 'chrono',
    accent: '#d99a2e',
    cast: CastShape.LINE,
    blurb: 'A gouge tears down the line, stops, and then unhappens — debris, dust and all.',
    load: () => import('./chrono/RewindAbility.js').then((m) => m.RewindAbility),
    settings: ABILITY_SETTINGS.rewind
  },

  {
    id: 'undertow',
    label: 'Undertow',
    school: 'tide',
    accent: '#3a7fd0',
    cast: CastShape.ZONE,
    blurb: 'A whirlpool opens on the circle and winds everything loose down into it.',
    load: () => import('./tide/UndertowAbility.js').then((m) => m.UndertowAbility),
    settings: ABILITY_SETTINGS.undertow
  },

  {
    id: 'bonecage',
    label: 'Bone Cage',
    school: 'blood',
    accent: '#f8c0b0',
    cast: CastShape.ZONE,
    blurb: 'Ribs of dry bone punch up around the circle and lay over into a dome.',
    load: () => import('./blood/BonecageAbility.js').then((m) => m.BonecageAbility),
    settings: ABILITY_SETTINGS.bonecage
  },

  {
    id: 'torrent',
    label: 'Torrent',
    school: 'tide',
    accent: '#0e7f8f',
    cast: CastShape.LINE,
    blurb: 'A cutting jet walks down the line and fans its spray out along the surface it hits.',
    load: () => import('./tide/TorrentAbility.js').then((m) => m.TorrentAbility),
    settings: ABILITY_SETTINGS.torrent
  },

  {
    id: 'broodburst',
    label: 'Broodburst',
    school: 'hive',
    accent: '#9bd14a',
    cast: CastShape.ZONE,
    blurb: 'A clutch of eggs swells, thins, splits, and lets the floor fill with crawlers.',
    load: () => import('./hive/BroodburstAbility.js').then((m) => m.BroodburstAbility),
    settings: ABILITY_SETTINGS.broodburst
  },

  {
    id: 'obsidian',
    label: 'Obsidian Bloom',
    school: 'stone',
    accent: '#7565a0',
    cast: CastShape.ZONE,
    blurb: 'Volcanic glass opens out of the floor in curved shells, stands, and goes to flakes.',
    load: () => import('./stone/ObsidianAbility.js').then((m) => m.ObsidianAbility),
    settings: ABILITY_SETTINGS.obsidian
  },

  {
    id: 'waspfunnel',
    label: 'Wasp Funnel',
    school: 'hive',
    accent: '#f0b429',
    cast: CastShape.ZONE,
    blurb: 'A nest opens on the circle and a funnel of wasps stands out of it, surging as it climbs.',
    load: () => import('./hive/WaspfunnelAbility.js').then((m) => m.WaspfunnelAbility),
    settings: ABILITY_SETTINGS.waspfunnel
  },

  {
    id: 'silence',
    label: 'Silence',
    school: 'void',
    accent: '#5c4b8c',
    cast: CastShape.ZONE,
    blurb: 'A sphere of the world stops being rendered. Not black — absent.',
    load: () => import('./void/SilenceAbility.js').then((m) => m.SilenceAbility),
    settings: ABILITY_SETTINGS.silence
  },

  {
    id: 'refractcascade',
    label: 'Refraction Cascade',
    school: 'lumen',
    accent: '#7fe0ff',
    cast: CastShape.LINE,
    blurb: 'The shot reaches the far end by bouncing off panes that reflect the real room.',
    load: () => import('./lumen/RefractCascadeAbility.js').then((m) => m.RefractCascadeAbility),
    settings: ABILITY_SETTINGS.refractcascade
  },

  {
    id: 'afterimage',
    label: 'Afterimage',
    school: 'chrono',
    // The pale end of the school's own bone amber. Echo Step took the gold and
    // these two must not be one dot at 34px; `#efe4c8` against `#c9a86a`
    // measures 0.240 apart on the redmean scale the school accents are judged
    // by, which is three times the tightest pair that already ships.
    accent: '#efe4c8',
    cast: CastShape.LINE,
    blurb: 'The cast leaves frozen copies of itself down the line, and every one of them is still live.',
    load: () => import('./chrono/AfterimageAbility.js').then((m) => m.AfterimageAbility),
    settings: ABILITY_SETTINGS.afterimage
  },

  {
    id: 'shrapnel',
    label: 'Shrapnel Bloom',
    school: 'forge',
    accent: '#e0913f',
    cast: CastShape.ZONE,
    blurb: 'A canister opens over the circle and throws machined steel that bounces off the floor.',
    load: () => import('./forge/ShrapnelAbility.js').then((m) => m.ShrapnelAbility),
    settings: ABILITY_SETTINGS.shrapnel
  },

  {
    id: 'photonlattice',
    label: 'Photon Lattice',
    school: 'lumen',
    accent: '#a8f0ff',
    cast: CastShape.ZONE,
    blurb: 'A grid of thin beams hangs over the circle; the crossings are bright because two beams add there.',
    load: () => import('./lumen/PhotonLatticeAbility.js').then((m) => m.PhotonLatticeAbility),
    settings: ABILITY_SETTINGS.photonlattice
  },

  {
    id: 'splatterbrand',
    label: 'Splatterbrand',
    school: 'ink',
    // Vermilion, the other pole of the school's palette from Ink Bloom's
    // indigo. Warm against that slot's cool at 34px, which is the only
    // separation that survives being shrunk.
    accent: '#d1452c',
    cast: CastShape.LINE,
    blurb: 'A loaded brush is flung down the line: a directional mass, a crown of spikes, and droplets thrown past it.',
    load: () => import('./ink/SplatterbrandAbility.js').then((m) => m.SplatterbrandAbility),
    settings: ABILITY_SETTINGS.splatterbrand
  },

  {
    id: 'sealscript',
    label: 'Seal Script',
    school: 'ink',
    accent: '#8fa39a', //  seal-stone jade — cool, so it never reads as cinnabar
    cast: CastShape.ZONE,
    blurb: 'A column of characters is written top-to-bottom in the air over a wash of ink.',
    load: () => import('./ink/SealscriptAbility.js').then((m) => m.SealscriptAbility),
    settings: ABILITY_SETTINGS.sealscript
  },

  {
    id: 'hourglass',
    label: 'Hourglass',
    school: 'chrono',
    accent: '#e8c27a',
    cast: CastShape.ZONE,
    blurb: 'Sand drains into a heap, the zone goes weightless, and then it all falls up.',
    load: () => import('./chrono/HourglassAbility.js').then((m) => m.HourglassAbility),
    settings: ABILITY_SETTINGS.hourglass
  },

  {
    id: 'brinelock',
    label: 'Brinelock',
    school: 'tide',
    accent: '#00d2b4',
    cast: CastShape.LINE,
    blurb: 'A lane of brine is thrown up in splash crowns and stopped mid-air as clear ice.',
    load: () => import('./tide/BrinelockAbility.js').then((m) => m.BrinelockAbility),
    settings: ABILITY_SETTINGS.brinelock
  },

  {
    id: 'blackice',
    label: 'Black Ice',
    school: 'frost',
    accent: '#4c8f96',
    cast: CastShape.ZONE,
    blurb: 'Meltwater floods the circle and freezes into a mirror that reflects the real room.',
    load: () => import('./frost/BlackIceAbility.js').then((m) => m.BlackIceAbility),
    settings: ABILITY_SETTINGS.blackice
  },

  {
    id: 'bubblecage',
    label: 'Abyssal Cage',
    school: 'tide',
    accent: '#a8ecf0',
    cast: CastShape.ZONE,
    blurb: 'A cage of soap film closes on the circle, drains, and bursts one bubble at a time.',
    load: () => import('./tide/BubblecageAbility.js').then((m) => m.BubblecageAbility),
    settings: ABILITY_SETTINGS.bubblecage
  },

  {
    id: 'spellbreak',
    label: 'Spellbreak',
    school: 'arcane',
    accent: '#6ee0c4',
    cast: CastShape.ZONE,
    blurb: 'A bell of arcane glass closes over the zone and breaks — and so does anything standing inside it.',
    load: () => import('./arcane/SpellbreakAbility.js').then((m) => m.SpellbreakAbility),
    settings: ABILITY_SETTINGS.spellbreak
  },

  {
    id: 'sawline',
    label: 'Sawline',
    school: 'forge',
    accent: '#ffae42',
    cast: CastShape.LINE,
    blurb: 'A machined blade buries its rim in the floor and runs the line, throwing sparks off the contact tangent.',
    load: () => import('./forge/SawlineAbility.js').then((m) => m.SawlineAbility),
    settings: ABILITY_SETTINGS.sawline
  },

  {
    id: 'firewalk',
    label: 'Firewalk',
    school: 'flame',
    accent: '#ff9e6a',
    cast: CastShape.LINE,
    blurb: 'Footprints ignite in sequence down the line, each throwing a short pillar of flame.',
    load: () => import('./flame/FirewalkAbility.js').then((m) => m.FirewalkAbility),
    settings: ABILITY_SETTINGS.firewalk
  },

  {
    id: 'wildfire',
    label: 'Wildfire',
    school: 'flame',
    accent: '#8f4a12',
    cast: CastShape.ZONE,
    blurb: 'Fire spreads across the circle cell by cell, jumping gaps and leaving unburnt islands.',
    load: () => import('./flame/WildfireAbility.js').then((m) => m.WildfireAbility),
    settings: ABILITY_SETTINGS.wildfire
  },

  {
    id: 'scrollward',
    label: 'Scrollward',
    school: 'ink',
    accent: '#bfa76a',
    cast: CastShape.ZONE,
    blurb: 'A ring of scrolls stands up and pays itself out into a wall of writing.',
    load: () => import('./ink/ScrollwardAbility.js').then((m) => m.ScrollwardAbility),
    settings: ABILITY_SETTINGS.scrollward
  },

  {
    id: 'carapace',
    label: 'Carapace',
    school: 'hive',
    accent: '#d2a02c',
    cast: CastShape.ZONE,
    blurb: 'Chitin plates fly in and lock into a dome that closes with no gaps.',
    load: () => import('./hive/CarapaceAbility.js').then((m) => m.CarapaceAbility),
    settings: ABILITY_SETTINGS.carapace
  },

  {
    id: 'stasisfield',
    label: 'Stasis Field',
    school: 'chrono',
    accent: '#8fb6a8',
    cast: CastShape.ZONE,
    blurb: 'A sphere of stopped time shuts over the circle and everything caught inside it holds.',
    load: () => import('./chrono/StasisfieldAbility.js').then((m) => m.StasisfieldAbility),
    settings: ABILITY_SETTINGS.stasisfield
  },

  {
    id: 'gearlock',
    label: 'Gearlock',
    school: 'forge',
    accent: '#69a2b6',
    cast: CastShape.ZONE,
    blurb: 'A train of involute gears winds up out of the floor, meshes, runs, and seizes.',
    load: () => import('./forge/GearlockAbility.js').then((m) => m.GearlockAbility),
    settings: ABILITY_SETTINGS.gearlock
  },

  {
    id: 'quench',
    label: 'Quench',
    school: 'forge',
    accent: '#db7b7a',
    cast: CastShape.ZONE,
    blurb: 'White-hot stock is plunged; the vapour blanket collapses and the steam is enormous.',
    load: () => import('./forge/QuenchAbility.js').then((m) => m.QuenchAbility),
    settings: ABILITY_SETTINGS.quench
  },

  {
    id: 'unmake',
    label: 'Unmake',
    school: 'void',
    accent: '#b84fc0',
    cast: CastShape.LINE,
    blurb: 'A lane of matter is heaved out of the floor and then stops existing, cube by growing cube.',
    load: () => import('./void/UnmakeAbility.js').then((m) => m.UnmakeAbility),
    settings: ABILITY_SETTINGS.unmake
  },

  {
    id: 'solarlens',
    label: 'Solar Lens',
    school: 'lumen',
    accent: '#fff0b0',
    cast: CastShape.ZONE,
    blurb: 'A burning glass hangs over the circle and walks its focus across the floor.',
    load: () => import('./lumen/SolarLensAbility.js').then((m) => m.SolarLensAbility),
    settings: ABILITY_SETTINGS.solarlens
  },

  {
    id: 'anvilfall',
    label: 'Anvilfall',
    school: 'forge',
    accent: '#b8b2a6',
    cast: CastShape.ZONE,
    blurb: 'A machined anvil falls out of nowhere, dishes the floor under itself, and stays there.',
    load: () => import('./forge/AnvilfallAbility.js').then((m) => m.AnvilfallAbility),
    settings: ABILITY_SETTINGS.anvilfall
  },

  {
    id: 'tiderush',
    label: 'Tiderush',
    school: 'tide',
    accent: '#36c9d8',
    cast: CastShape.LINE,
    blurb: 'A wave runs down the line and throws its own refracted light on the floor ahead of it.',
    load: () => import('./tide/TiderushAbility.js').then((m) => m.TiderushAbility),
    settings: ABILITY_SETTINGS.tiderush
  },

  {
    id: 'godspear',
    label: 'Godspear',
    school: 'lumen',
    accent: '#ffd94a',
    cast: CastShape.LINE,
    blurb: 'A colonnade of lit air walks down the line, and the room’s own dust burns as it drifts through.',
    load: () => import('./lumen/GodspearAbility.js').then((m) => m.GodspearAbility),
    settings: ABILITY_SETTINGS.godspear
  },

  {
    id: 'locusttide',
    label: 'Locust Tide',
    school: 'hive',
    accent: '#9dbf3c',
    cast: CastShape.LINE,
    blurb: 'A colony thrown down the line closes into a fist, opens into a wall and lands as a spear.',
    load: () => import('./hive/LocusttideAbility.js').then((m) => m.LocusttideAbility),
    settings: ABILITY_SETTINGS.locusttide
  },

  {
    id: 'mycelium',
    label: 'Mycelial Web',
    school: 'verdant',
    accent: '#4f9e86',
    cast: CastShape.LINE,
    blurb: 'A fungal mat runs out under the flagstones and shows only as light coming up through the mortar.',
    load: () => import('./verdant/MyceliumAbility.js').then((m) => m.MyceliumAbility),
    settings: ABILITY_SETTINGS.mycelium
  },

  {
    id: 'featherfall',
    label: 'Featherfall',
    school: 'aether',
    // Warm bone. Every other aether slot is a cool colour, and the one thing
    // in the school that is not made of energy should not be lit like it is.
    accent: '#ffe6bf',
    cast: CastShape.ZONE,
    blurb: 'Feathers come down over the circle — stalling, sideslipping, catching, and gliding.',
    load: () => import('./aether/FeatherfallAbility.js').then((m) => m.FeatherfallAbility),
    settings: ABILITY_SETTINGS.featherfall
  },

  {
    id: 'mirage',
    label: 'Mirage',
    school: 'aether',
    // Orchid. The five aether slots that already ship run blue, grey, cyan,
    // mint and near-white; the one warm-shifted violet on the rail is the one
    // that is not made of light at all.
    accent: '#cfa8ff',
    cast: CastShape.LINE,
    blurb: 'A double of the caster sprints the line, drawn only in refraction, and is lost as it slows.',
    load: () => import('./aether/MirageAbility.js').then((m) => m.MirageAbility),
    settings: ABILITY_SETTINGS.mirage
  },

  {
    id: 'echostep',
    label: 'Echo Step',
    school: 'chrono',
    // Amber with the bone taken out of it. The school's own `#d5be8c` is the
    // *pale* end of chrono and the snapshot slots want it; a run of echoes is
    // the warmest thing this school does, so it takes the gold.
    accent: '#c9a86a',
    cast: CastShape.LINE,
    blurb: 'Three copies of the caster run the line, each replaying what you just did, later and fainter.',
    load: () => import('./chrono/EchostepAbility.js').then((m) => m.EchostepAbility),
    settings: ABILITY_SETTINGS.echostep
  },

  {
    id: 'origami',
    label: 'Paper Storm',
    school: 'ink',
    accent: '#e0603c',
    cast: CastShape.LINE,
    blurb: 'A flight of folded cranes runs the line and comes apart into flat sheets of writing.',
    load: () => import('./ink/OrigamiAbility.js').then((m) => m.OrigamiAbility),
    settings: ABILITY_SETTINGS.origami
  },

  {
    id: 'sheetlightning',
    label: 'Sheet Lightning',
    school: 'storm',
    accent: '#d6b4ff',
    cast: CastShape.ZONE,
    blurb: 'A fracture buried in cloud strobes, and every real shadow on the stage snaps with it.',
    load: () => import('./storm/SheetLightningAbility.js').then((m) => m.SheetLightningAbility),
    settings: ABILITY_SETTINGS.sheetlightning
  },

  {
    id: 'dawnbreak',
    label: 'Dawnbreak',
    school: 'lumen',
    accent: '#ff9f70',
    cast: CastShape.ZONE,
    blurb: 'Takes hold of the sun and swings it overhead; every shadow on the stage sweeps with it.',
    load: () => import('./lumen/DawnbreakAbility.js').then((m) => m.DawnbreakAbility),
    settings: ABILITY_SETTINGS.dawnbreak
  },

  {
    id: 'eclipse',
    label: 'Eclipse',
    school: 'lumen',
    accent: '#d8c0f0',
    cast: CastShape.ZONE,
    blurb: 'The light goes wrong first — colour drains, the key cools — and only then does the black disc open.',
    load: () => import('./lumen/EclipseAbility.js').then((m) => m.EclipseAbility),
    settings: ABILITY_SETTINGS.eclipse
  },

  {
    id: 'inkbloom',
    label: 'Ink Bloom',
    school: 'ink',
    // Diluted indigo. The school's own accent is bone `#d8d2c4`, which the
    // brush slots want; the two diffusion slots take the ink itself, one at
    // each end of the palette — indigo here, vermilion on Splatterbrand.
    accent: '#7f93b4',
    cast: CastShape.ZONE,
    blurb: 'A bead of ink opens on the water in branching fingers, wet at the edge and drying behind it.',
    load: () => import('./ink/InkbloomAbility.js').then((m) => m.InkbloomAbility),
    settings: ABILITY_SETTINGS.inkbloom
  },

  {
    id: 'hivecolumn',
    label: 'Hive Column',
    school: 'hive',
    accent: '#d8a828',
    cast: CastShape.ZONE,
    blurb: 'Comb cells bud outward from a seed, refusing each other, into a tower.',
    load: () => import('./hive/HivecolumnAbility.js').then((m) => m.HivecolumnAbility),
    settings: ABILITY_SETTINGS.hivecolumn
  },

  {
    id: 'avalanche',
    label: 'Avalanche',
    school: 'frost',
    accent: '#9ab0c0',
    cast: CastShape.LINE,
    blurb: 'Snow piles, slumps and finds its angle of repose, collapsing forward over itself.',
    load: () => import('./frost/AvalancheAbility.js').then((m) => m.AvalancheAbility),
    settings: ABILITY_SETTINGS.avalanche
  },

  {
    id: 'sumistroke',
    label: 'Sumi Stroke',
    school: 'ink',
    accent: '#c8492c', //  cinnabar — the seal red, the only saturated thing in Ink
    cast: CastShape.LINE,
    blurb: 'One enormous brushstroke down the line, which runs out of ink before the end.',
    load: () => import('./ink/SumistrokeAbility.js').then((m) => m.SumistrokeAbility),
    settings: ABILITY_SETTINGS.sumistroke
  },

  {
    id: 'webline',
    label: 'Web Line',
    school: 'hive',
    accent: '#e2e6c4',
    cast: CastShape.LINE,
    blurb: 'A drag-line bites and an orb web spins across the lane, film and all.',
    load: () => import('./hive/WeblineAbility.js').then((m) => m.WeblineAbility),
    settings: ABILITY_SETTINGS.webline
  },

  {
    id: 'shatterlance',
    label: 'Shatterlance',
    school: 'frost',
    accent: '#3fa9e6',
    cast: CastShape.LINE,
    blurb: 'A single lance assembles in the air, hangs, fires, and breaks apart on arrival.',
    load: () => import('./frost/ShatterlanceAbility.js').then((m) => m.ShatterlanceAbility),
    settings: ABILITY_SETTINGS.shatterlance
  },

  {
    id: 'soulchain',
    label: 'Soul Tether',
    school: 'void',
    accent: '#8fe6c8',
    cast: CastShape.LINE,
    blurb: 'A chain of ghost-iron links is thrown out, snaps taut, and breaks link by link.',
    load: () => import('./void/SoulchainAbility.js').then((m) => m.SoulchainAbility),
    settings: ABILITY_SETTINGS.soulchain
  },

  {
    id: 'skyfracture',
    label: 'Sky Fracture',
    school: 'aether',
    accent: '#9fb4ff',
    cast: CastShape.LINE,
    blurb: 'The crack shows on the floor first, then the sky splits, then the pressure arrives.',
    load: () => import('./aether/SkyfractureAbility.js').then((m) => m.SkyfractureAbility),
    settings: ABILITY_SETTINGS.skyfracture
  },

  {
    id: 'sanguinepact',
    label: 'Sanguine Pact',
    school: 'blood',
    accent: '#e0505c',
    cast: CastShape.ZONE,
    blurb: 'A pool draws itself, sends up a mist column, and beads of blood climb around it until the pact seals.',
    load: () => import('./blood/SanguinePactAbility.js').then((m) => m.SanguinePactAbility),
    settings: ABILITY_SETTINGS.sanguinepact
  },

  {
    id: 'magma',
    label: 'Magma Fount',
    school: 'flame',
    accent: '#c9401a',
    cast: CastShape.ZONE,
    blurb: 'A molten pool splits the floor open and throws blobs back into itself.',
    load: () => import('./flame/MagmaAbility.js').then((m) => m.MagmaAbility),
    settings: ABILITY_SETTINGS.magma
  },

  {
    id: 'hemolance',
    label: 'Hemorrhage',
    school: 'blood',
    accent: '#ff5a66',
    cast: CastShape.LINE,
    blurb: 'Hair-thin lances ripple down the line and leave their mist hanging after them.',
    load: () => import('./blood/HemolanceAbility.js').then((m) => m.HemolanceAbility),
    settings: ABILITY_SETTINGS.hemolance
  },

  {
    id: 'umbralspears',
    label: 'Umbral Spears',
    school: 'void',
    accent: '#8a5fd0',
    cast: CastShape.LINE,
    blurb: 'Near-black spears rise out of the shadow, lit only along a violet rim.',
    load: () => import('./void/UmbralSpearsAbility.js').then((m) => m.UmbralSpearsAbility),
    settings: ABILITY_SETTINGS.umbralspears
  },

  {
    id: 'nightfall',
    label: 'Nightfall',
    school: 'void',
    accent: '#6478c8',
    cast: CastShape.ZONE,
    blurb: 'A dome of dark closes over the circle from the rim in, and the floor goes out under it.',
    load: () => import('./void/NightfallAbility.js').then((m) => m.NightfallAbility),
    settings: ABILITY_SETTINGS.nightfall
  },

  {
    id: 'bloomburst',
    label: 'Bloomburst',
    school: 'verdant',
    accent: '#e08ac8',
    cast: CastShape.ZONE,
    blurb: 'Flowers unfurl in a wave across the circle, then throw their petals at once.',
    load: () => import('./verdant/BloomburstAbility.js').then((m) => m.BloomburstAbility),
    settings: ABILITY_SETTINGS.bloomburst
  },

  {
    id: 'sporefall',
    label: 'Sporefall',
    school: 'verdant',
    accent: '#c8ff9a',
    cast: CastShape.ZONE,
    blurb: 'A slab of spores pours across the floor and glowing motes rise out of it.',
    load: () => import('./verdant/SporefallAbility.js').then((m) => m.SporefallAbility),
    settings: ABILITY_SETTINGS.sporefall
  },

  {
    id: 'dragonbreath',
    label: "Wyrm's Breath",
    school: 'flame',
    accent: '#ff3d14',
    cast: CastShape.LINE,
    blurb: 'A sustained cone of flame, hollow down the middle, burning a track into the floor.',
    load: () => import('./flame/DragonbreathAbility.js').then((m) => m.DragonbreathAbility),
    settings: ABILITY_SETTINGS.dragonbreath
  },

  {
    id: 'grovecall',
    label: 'Grovecall',
    school: 'verdant',
    accent: '#57c8a0',
    cast: CastShape.ZONE,
    blurb: 'Six trees rise on a wave around the circle and the sun comes through them.',
    load: () => import('./verdant/GrovecallAbility.js').then((m) => m.GrovecallAbility),
    settings: ABILITY_SETTINGS.grovecall
  },

  {
    id: 'runeseal',
    label: 'Runic Seal',
    school: 'arcane',
    accent: '#ff9d2e',
    cast: CastShape.ZONE,
    blurb: 'A seal writes itself on the floor, catches from the middle out, and goes off.',
    load: () => import('./arcane/RunesealAbility.js').then((m) => m.RunesealAbility),
    settings: ABILITY_SETTINGS.runeseal
  },

  {
    id: 'glyphstorm',
    label: 'Glyphstorm',
    school: 'arcane',
    accent: '#e8b45c',
    cast: CastShape.LINE,
    blurb: 'A blizzard of burning marks storms downrange and settles into a lattice.',
    load: () => import('./arcane/GlyphstormAbility.js').then((m) => m.GlyphstormAbility),
    settings: ABILITY_SETTINGS.glyphstorm
  },

  {
    id: 'vinelash',
    label: 'Verdant Lash',
    school: 'verdant',
    accent: '#4fc06a',
    cast: CastShape.LINE,
    blurb: 'A vine grows down the line, leafing as it goes, then snaps back and sheds.',
    load: () => import('./verdant/VinelashAbility.js').then((m) => m.VinelashAbility),
    settings: ABILITY_SETTINGS.vinelash
  },

  {
    id: 'tectonic',
    label: 'Tectonic Slam',
    school: 'stone',
    accent: '#c86a2a',
    cast: CastShape.ZONE,
    blurb: 'Five fissures race out to the boundary at different speeds, dust riding each tip.',
    load: () => import('./stone/TectonicAbility.js').then((m) => m.TectonicAbility),
    settings: ABILITY_SETTINGS.tectonic
  },

  {
    id: 'boulder',
    label: 'Rolling Ruin',
    school: 'stone',
    accent: '#8f7a4e',
    cast: CastShape.LINE,
    blurb: 'A boulder rolls down the line gouging a rut, and breaks apart on arrival.',
    load: () => import('./stone/BoulderAbility.js').then((m) => m.BoulderAbility),
    settings: ABILITY_SETTINGS.boulder
  },

  {
    id: 'stonespine',
    label: 'Stone Spine',
    school: 'stone',
    accent: '#b09a72',
    cast: CastShape.LINE,
    blurb: 'Slabs of floor tear loose and heave over on their hinges like river ice.',
    load: () => import('./stone/StonespineAbility.js').then((m) => m.StonespineAbility),
    settings: ABILITY_SETTINGS.stonespine
  },

  {
    id: 'sinkhole',
    label: 'Sinkhole',
    school: 'stone',
    accent: '#7a6a58',
    cast: CastShape.ZONE,
    blurb: 'The floor cracks, drops away into a funnel and swallows its own lip.',
    load: () => import('./stone/SinkholeAbility.js').then((m) => m.SinkholeAbility),
    settings: ABILITY_SETTINGS.sinkhole
  },

  {
    id: 'singularity',
    label: 'Singularity',
    school: 'void',
    accent: '#6f3bff',
    cast: CastShape.ZONE,
    blurb: 'A gravity well opens over the circle, bends the floor around it, and then inverts.',
    load: () => import('./void/SingularityAbility.js').then((m) => m.SingularityAbility),
    settings: ABILITY_SETTINGS.singularity
  },

  {
    id: 'rime',
    label: 'Rimewalker',
    school: 'frost',
    accent: '#7ecbe0',
    cast: CastShape.LINE,
    blurb: 'Sheet ice glazes the floor and peels up off it behind the front.',
    load: () => import('./frost/RimeAbility.js').then((m) => m.RimeAbility),
    settings: ABILITY_SETTINGS.rime
  },

  {
    id: 'petrify',
    label: 'Petrifying Gaze',
    school: 'stone',
    accent: '#8e9298',
    cast: CastShape.LINE,
    blurb: 'Grey facets gather out of the air into a stone column, then run out as sand.',
    load: () => import('./stone/PetrifyAbility.js').then((m) => m.PetrifyAbility),
    settings: ABILITY_SETTINGS.petrify
  },

  {
    id: 'hail',
    label: 'Hailwrath',
    school: 'frost',
    accent: '#bfe4f2',
    cast: CastShape.ZONE,
    blurb: 'Freezing air stands over the circle and then it comes down, pocking the floor white.',
    load: () => import('./frost/HailAbility.js').then((m) => m.HailAbility),
    settings: ABILITY_SETTINGS.hail
  },

  {
    id: 'sunspear',
    label: 'Sunspear',
    school: 'flame',
    accent: '#ffefa0',
    cast: CastShape.LINE,
    blurb: 'A white-fire javelin arcs downrange, bending the world behind it, and opens a sun on the floor.',
    load: () => import('./flame/SunspearAbility.js').then((m) => m.SunspearAbility),
    settings: ABILITY_SETTINGS.sunspear
  },

  {
    id: 'cyclone',
    label: 'Cyclone',
    school: 'aether',
    accent: '#aab6c2',
    cast: CastShape.ZONE,
    blurb: 'A vortex touches down on the circle, grinds the floor, and ropes out from the bottom up.',
    load: () => import('./aether/CycloneAbility.js').then((m) => m.CycloneAbility),
    settings: ABILITY_SETTINGS.cyclone
  },

  {
    id: 'resonance',
    label: 'Resonant Chord',
    school: 'aether',
    accent: '#6fd8ee',
    cast: CastShape.LINE,
    blurb: 'Rings run down the line and reflect, and the interference stands still where it lands.',
    load: () => import('./aether/ResonanceAbility.js').then((m) => m.ResonanceAbility),
    settings: ABILITY_SETTINGS.resonance
  },

  {
    id: 'prismlance',
    label: 'Prism Lance',
    school: 'arcane',
    accent: '#ff6bd6',
    cast: CastShape.LINE,
    blurb: 'A white lance breaks on a floating prism and finishes as a fan of colour.',
    load: () => import('./arcane/PrismLanceAbility.js').then((m) => m.PrismLanceAbility),
    settings: ABILITY_SETTINGS.prismlance
  },

  {
    id: 'arcanevolley',
    label: 'Arcane Volley',
    school: 'arcane',
    accent: '#b98cff',
    cast: CastShape.LINE,
    blurb: 'Seven bolts weave apart down the line and land on one point together.',
    load: () => import('./arcane/ArcaneVolleyAbility.js').then((m) => m.ArcaneVolleyAbility),
    settings: ABILITY_SETTINGS.arcanevolley
  },

  {
    id: 'plaguebloom',
    label: 'Plague Bloom',
    school: 'blood',
    accent: '#a8c04a',
    cast: CastShape.ZONE,
    blurb: 'A boiling cloud settles over the circle and the floor blisters and bursts beneath it.',
    load: () => import('./blood/PlaguebloomAbility.js').then((m) => m.PlaguebloomAbility),
    settings: ABILITY_SETTINGS.plaguebloom
  },

  {
    id: 'aurora',
    label: 'Aurora Veil',
    school: 'aether',
    accent: '#5fffc0',
    cast: CastShape.ZONE,
    blurb: 'Sheets of banded light rise around the circle, ripple for a long while, and climb away.',
    load: () => import('./aether/AuroraAbility.js').then((m) => m.AuroraAbility),
    settings: ABILITY_SETTINGS.aurora
  },

  {
    id: 'starfall',
    label: 'Starfall',
    school: 'arcane',
    accent: '#8fa8ff',
    cast: CastShape.ZONE,
    blurb: 'Cold stars fall out of one point in the sky and open rings across the circle.',
    load: () => import('./arcane/StarfallAbility.js').then((m) => m.StarfallAbility),
    settings: ABILITY_SETTINGS.starfall
  },

  {
    id: 'chronofracture',
    label: 'Chronofracture',
    school: 'arcane',
    accent: '#c8d4e0',
    cast: CastShape.ZONE,
    blurb: 'Panes of stopped time hang over the circle, hold dead still, and break all at once.',
    load: () => import('./arcane/ChronofractureAbility.js').then((m) => m.ChronofractureAbility),
    settings: ABILITY_SETTINGS.chronofracture
  },

  {
    id: 'voidrift',
    label: 'Void Rift',
    school: 'void',
    accent: '#c9a2ff',
    cast: CastShape.LINE,
    blurb: 'A slit tears open along the line and the stars behind it move at the wrong rate.',
    load: () => import('./void/VoidriftAbility.js').then((m) => m.VoidriftAbility),
    settings: ABILITY_SETTINGS.voidrift
  },

  {
    id: 'crimsontide',
    label: 'Crimson Tide',
    school: 'blood',
    accent: '#b0121f',
    cast: CastShape.LINE,
    blurb: 'A wave of blood surges down the line, curls, breaks and soaks away.',
    load: () => import('./blood/CrimsonTideAbility.js').then((m) => m.CrimsonTideAbility),
    settings: ABILITY_SETTINGS.crimsontide
  },

  {
    id: 'thunderclap',
    label: 'Thunderclap',
    school: 'storm',
    accent: '#cfe4ff',
    cast: CastShape.ZONE,
    blurb: 'A white flash and a dome, a beat of nothing, and then the pressure front arrives.',
    load: () => import('./storm/ThunderclapAbility.js').then((m) => m.ThunderclapAbility),
    settings: ABILITY_SETTINGS.thunderclap
  },

  {
    id: 'stormwall',
    label: 'Tempest Wall',
    school: 'storm',
    accent: '#5f7f9a',
    cast: CastShape.LINE,
    blurb: 'A curtain of rain rises across your heading, restrikes from inside, and drains away.',
    load: () => import('./storm/StormwallAbility.js').then((m) => m.StormwallAbility),
    settings: ABILITY_SETTINGS.stormwall
  },

  {
    id: 'thornwake',
    label: 'Thornwake',
    school: 'verdant',
    accent: '#96b83c',
    cast: CastShape.LINE,
    blurb: 'A barbed bramble tears up along the line and vines thread it into one mass.',
    load: () => import('./verdant/ThornwakeAbility.js').then((m) => m.ThornwakeAbility),
    settings: ABILITY_SETTINGS.thornwake
  },

  {
    id: 'firewhip',
    label: 'Ashen Lash',
    school: 'flame',
    accent: '#ff4a12',
    cast: CastShape.LINE,
    blurb: 'A burning lash is thrown down the line and cracks in mid-air where the loop runs off the tip.',
    load: () => import('./flame/FirewhipAbility.js').then((m) => m.FirewhipAbility),
    settings: ABILITY_SETTINGS.firewhip
  },

  {
    id: 'railcoil',
    label: 'Railcoil',
    school: 'storm',
    accent: '#4fd8ff',
    cast: CastShape.LINE,
    blurb: 'Coils collapse along the barrel and the shot is simply already there, cooling as it dies.',
    load: () => import('./storm/RailcoilAbility.js').then((m) => m.RailcoilAbility),
    settings: ABILITY_SETTINGS.railcoil
  },

  {
    id: 'slipstream',
    label: 'Slipstream',
    school: 'aether',
    accent: '#e2f2ff',
    cast: CastShape.LINE,
    blurb: 'A blade of vacuum opens along the line and the world behind it slides.',
    load: () => import('./aether/SlipstreamAbility.js').then((m) => m.SlipstreamAbility),
    settings: ABILITY_SETTINGS.slipstream
  },

  {
    id: 'pyroclasm',
    label: 'Pyroclasm',
    school: 'flame',
    accent: '#d2552e',
    cast: CastShape.ZONE,
    blurb: 'A dome of ash collapses onto its own centre, then blasts out past the boundary.',
    load: () => import('./flame/PyroclasmAbility.js').then((m) => m.PyroclasmAbility),
    settings: ABILITY_SETTINGS.pyroclasm
  },

  {
    id: 'emberflock',
    label: 'Emberflight',
    school: 'flame',
    accent: '#ffc24a',
    cast: CastShape.LINE,
    blurb: 'A flock of ember birds streams downrange, then collapses and goes up.',
    load: () => import('./flame/EmberflockAbility.js').then((m) => m.EmberflockAbility),
    settings: ABILITY_SETTINGS.emberflock
  },

  {
    id: 'chainarc',
    label: 'Chain Arc',
    school: 'storm',
    accent: '#00b4ff',
    cast: CastShape.LINE,
    blurb: 'The discharge hops from node to node down the line, lighting one segment at a time.',
    load: () => import('./storm/ChainArcAbility.js').then((m) => m.ChainArcAbility),
    settings: ABILITY_SETTINGS.chainarc
  },

  {
    id: 'balllightning',
    label: 'Fulminant Orb',
    school: 'storm',
    accent: '#5f6fff',
    cast: CastShape.LINE,
    blurb: 'A caged orb of current walks downrange at walking pace, then opens.',
    load: () => import('./storm/BallLightningAbility.js').then((m) => m.BallLightningAbility),
    settings: ABILITY_SETTINGS.balllightning
  }

];

/* ------------------------------------------------------------------ */
/* Lookups                                                             */
/* ------------------------------------------------------------------ */

/** id → descriptor. One map, built once; `getAbility` is called every frame. */
const BY_ID = new Map(ABILITIES.map((ability) => [ability.id, ability]));

/**
 * Every registered id, in slot order.
 *
 * Frozen because `ELEMENTS` is this array — the HUD, `App` and the aim
 * controller all hold on to it, and an ability list that can be spliced from
 * anywhere is a class of bug nobody wants to chase.
 */
export const ABILITY_IDS = Object.freeze(ABILITIES.map((ability) => ability.id));

/**
 * Look up one descriptor. Returns `undefined` for an unknown id.
 *
 * Callers guard rather than throw: the id can come from a `localStorage`
 * loadout written by an older build, and a stale slot should quietly do
 * nothing rather than take the frame loop down with it.
 */
export function getAbility(id) {
  return BY_ID.get(id);
}

/**
 * The roster grouped for the spellbook: `[{ school, abilities }]`, in
 * `SCHOOLS` order, with empty schools dropped.
 *
 * Built fresh on each call rather than cached — it is called when the
 * spellbook opens, not per frame, and a cache here would silently go stale the
 * first time somebody hot-reloads a registry entry in dev.
 */
export function abilitiesBySchool() {
  const groups = [];
  for (const school of SCHOOLS) {
    const abilities = ABILITIES.filter((ability) => ability.school === school.id);
    if (abilities.length) groups.push({ school, abilities });
  }
  return groups;
}
