/**
 * Verdant sigils.
 *
 * Nothing shipped in this school — see `docs/ROSTER.md` for what is coming.
 * Author each mark with `WRAP` from `./wrap.js`, keyed by ability id, and add
 * it to the map below. `index.js` already folds this module into
 * `ELEMENT_SIGILS`, so a new sigil needs no edit anywhere else.
 */
import { WRAP } from './wrap.js';

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

/**
 * Mycelial Web — the house diagonal, but **broken**, with the two breaks
 * crossed by the mortar courses the light actually comes out of.
 *
 * Every other line cast in this school draws one continuous stem: Thornwake's
 * bramble, Vinelash's whip. This slot is the one whose subject is not on the
 * surface, so the stem is the only thing in the set that is interrupted, and
 * what interrupts it is a transverse stroke rather than empty space — a seam,
 * crossing the lane, with the thread reappearing on the far side of it. Barbs
 * sit on one side of a stem and stop; these cross it, which is what keeps the
 * mark out of Thornwake's territory at 34px. One short fork says the thing is
 * a network rather than a root.
 *
 * The first version put a round cap in each gap instead of a crossing stroke,
 * on the theory that a dot reads as a point of light. At slot size a dot on the
 * same bearing as the stem simply rejoins it, and the mark went back to being
 * an unbroken diagonal with two lumps in it.
 */
export const MYCELIUM = WRAP(`
  <path d="M8 92C19 84 27 77 34 68"/>
  <path d="M48 54C56 46 64 40 72 34"/>
  <path d="M86 24C90 21 92 19 95 16"/>
  <path d="M33 55L47 69"/>
  <path d="M71 21L85 35"/>
  <path d="M52 51C46 42 48 31 57 26"/>
`);

/**
 * Thornwake — a line cast, so it is built on the house diagonal: one bramble
 * stem running low-left to high-right with three barbs hooking back off it.
 * The barbs are the read; a bare diagonal is every line cast in the set, and
 * the backward hook is the one thing this school does that no other does.
 */
export const THORNWAKE = WRAP(`
  <path d="M14 84C34 74 54 56 86 20"/>
  <path d="M35 68L22 58"/>
  <path d="M53 52L40 41"/>
  <path d="M71 35L58 25"/>
`);

/**
 * Vinelash — the house diagonal again, but the far end *curls back on itself*.
 *
 * Thornwake owns the straight bramble with barbs, so this one cannot be a
 * stem with leaves on it: side by side at 34px the two would be the same
 * mark. The single idea here is the hook — the tip whipping back past where it
 * reached — and the two cupped leaves are there only to say the stem is alive.
 * The first version put five leaves along the stem and it turned into a smudge
 * at slot size; the curl survives being shrunk and the leaves nearly do.
 */
export const VINELASH = WRAP(`
  <path d="M13 88C36 79 55 63 66 45"/>
  <path d="M66 45C74 31 86 26 91 34C95 41 89 50 79 50"/>
  <path d="M40 68C31 60 29 49 33 41C42 45 46 55 43 64"/>
  <path d="M63 46C58 35 61 24 69 19C75 27 72 39 65 45"/>
`);

/**
 * Grovecall — a far cast, so the house ellipse, seen in perspective and looked
 * *into*. One trunk and one canopy arch stand inside it, and a single slanted
 * stroke falls through the crown to the ring: the ability is the light getting
 * through, and a grove drawn without it is just a tree in a circle.
 *
 * Deliberately the only mark in this school with a closed curve — Thornwake and
 * Vinelash are both diagonals, and at 34px the closed ring is what separates
 * this slot from them before any of the detail resolves.
 */
export const GROVECALL = WRAP(`
  <ellipse cx="50" cy="76" rx="32" ry="11"/>
  <path d="M45 76L45 47"/>
  <path d="M25 47C25 22 65 22 65 47"/>
  <path d="M82 15L61 71"/>
`);

/**
 * Bloomburst — a far cast, so the house ellipse, and inside it one flower seen
 * from slightly above: four petals opening off a centre, plus the hint of a
 * fifth as the short stroke that keeps the mark from being a perfect cross.
 *
 * The petals are drawn as *opening* rather than open — each one is a curve that
 * leaves the centre tight and turns out at its end, which is the same shape the
 * vertex shader draws and the only way a still image says "unfurling". A
 * radially symmetric rosette would read as a snowflake at 34px, and the frost
 * school already owns that.
 */
export const BLOOMBURST = WRAP(`
  <ellipse cx="50" cy="70" rx="34" ry="13"/>
  <path d="M50 52C50 40 44 30 33 26"/>
  <path d="M50 52C56 41 66 35 77 38"/>
  <path d="M50 52C40 48 29 49 22 57"/>
  <path d="M50 52C60 55 70 61 72 70"/>
`);

/**
 * Sporefall — the house ellipse again, but this one is *flat and low*, drawn
 * twice: an outer rim and an inner pool, because the ability is a substance
 * lying on the ground with a spreading front. Three short rising strokes with a
 * dot over each stop dead at the same height — that stopped line is the whole
 * slot, and it is what separates this from Grovecall's ellipse, which is
 * something standing up inside a ring rather than something leaving one.
 */
export const SPOREFALL = WRAP(`
  <ellipse cx="50" cy="74" rx="36" ry="12"/>
  <path d="M29 74C33 68 67 68 71 74"/>
  <path d="M33 62L33 46"/>
  <path d="M50 60L50 38"/>
  <path d="M67 63L67 50"/>
  <path d="M24 34L76 34"/>
`);

export const VERDANT_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  mycelium: MYCELIUM,
  bloomburst: BLOOMBURST,
  sporefall: SPOREFALL,
  grovecall: GROVECALL,
  thornwake: THORNWAKE,
  vinelash: VINELASH
};
