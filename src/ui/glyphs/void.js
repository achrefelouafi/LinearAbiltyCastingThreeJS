/**
 * Void sigils.
 *
 * Nothing shipped in this school — see `docs/ROSTER.md` for what is coming.
 * Author each mark with `WRAP` from `./wrap.js`, keyed by ability id, and add
 * it to the map below. `index.js` already folds this module into
 * `ELEMENT_SIGILS`, so a new sigil needs no edit anywhere else.
 */
import { WRAP } from './wrap.js';

/**
 * Void Rift — a slit prised open on the diagonal, still cracking at both ends.
 *
 * The house rule for a line cast is a diagonal, and the mark obeys it twice
 * over: the diagonal *is* the cast, and the two bowed strokes are the same
 * diagonal pulled apart. Everything the ability does is in the gap between
 * them. The two short strokes running past the tips are the tear continuing
 * into rock it has not opened yet, which is the one thing that stops the lens
 * shape reading as an eye — and an eye is what the first draft was.
 */
export const VOIDRIFT = WRAP(`
  <path d="M20 76Q50 32 80 24"/>
  <path d="M20 76Q50 68 80 24"/>
  <path d="M20 76L8 90"/>
  <path d="M80 24L92 10"/>
  <path d="M66 38L77 44"/>
`);

/**
 * Singularity — two straight lines that fail to stay straight.
 *
 * The far-cast ellipse is there because the house rule says a circle you look
 * *into* is the first thing a ground-targeted slot has to say, and the small
 * ring standing in the middle of it is the horizon. The idea is the other two
 * strokes: they come in level from both edges and bow hard around the ring
 * before leaving on the same level they arrived at. That is the ability — light
 * that was going somewhere else, going around this instead.
 *
 * The first draft drew the two strokes as a spiral wound onto the ring, which
 * is what the accretion disc actually looks like and is completely illegible at
 * 34px: it fills the counter and the whole mark goes to a smudge. Bent lines
 * keep their white space, and white space is the only thing a sigil has.
 */
export const SINGULARITY = WRAP(`
  <ellipse cx="50" cy="78" rx="34" ry="11"/>
  <circle cx="50" cy="40" r="10"/>
  <path d="M6 20Q50 30 94 20"/>
  <path d="M6 60Q50 50 94 60"/>
`);

/**
 * Nightfall — a lid coming down on a circle you look into.
 *
 * The far-cast ellipse is the footprint. The two strokes rising off its rim are
 * the dome, and the *gap* between their tips is the whole ability: the lid has
 * not met yet, and the small cross standing in that gap is the last of the sky.
 * Drawing the dome closed gives you a filled shape at 34px and the mark stops
 * saying anything at all; the hole is what carries it.
 */
export const NIGHTFALL = WRAP(`
  <ellipse cx="50" cy="74" rx="37" ry="13"/>
  <path d="M13 74Q11 36 39 27"/>
  <path d="M87 74Q89 36 61 27"/>
  <path d="M50 11V23"/>
  <path d="M44 17H56"/>
`);

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/**
 * Soul Tether — three links on a sagging line.
 *
 * Drawn as a catenary rather than a straight diagonal because the sag *is* the
 * ability before it snaps taut, and the middle link is turned 90° to its
 * neighbours for the same reason the real chain is: an unturned chain reads as
 * a string of beads. Three links is the fewest that shows the alternation.
 */
export const SOULCHAIN = WRAP(`
  <path d="M10 22C10 22 28 74 50 78C72 82 90 40 90 40"/>
  <ellipse cx="27" cy="50" rx="7" ry="12" transform="rotate(-52 27 50)"/>
  <ellipse cx="50" cy="74" rx="12" ry="6"/>
  <ellipse cx="74" cy="58" rx="7" ry="12" transform="rotate(48 74 58)"/>
`);

/**
 * Unmake — three squares climbing a diagonal, the last of them half gone.
 *
 * The diagonal is the house convention for a line cast and it is not drawn: the
 * three squares stand on it, and they *grow* along it, because the one thing
 * this slot has to say before anything else is that the pieces get bigger as it
 * goes. The first is whole, the second has lost a corner, and the third is two
 * sides and a chip leaving — so the mark reads left to right as the same event
 * accelerating, which is the ability.
 *
 * The first draft drew all three the same size and shaded the last one in. At
 * 34px that is a row of dots: identical squares carry no direction, and a
 * filled counter is a blob. Growth plus subtraction is what survives the size.
 */
export const UNMAKE = WRAP(`
  <rect x="10" y="68" width="18" height="18" rx="2"/>
  <path d="M38 64V40H62"/>
  <path d="M62 64H38"/>
  <path d="M64 42V12H94"/>
  <rect x="79" y="52" width="10" height="10" rx="1" transform="rotate(26 84 57)"/>
`);

/**
 * Silence — an ellipse with the strokes that cross it missing inside it.
 *
 * The far-cast ellipse is the house convention for a ground-targeted slot, and
 * here it is doing a second job: three lines run straight across the mark and
 * every one of them stops at the ellipse and picks up again on the far side.
 * Nothing is drawn *in* the counter, which is the ability — the lines are not
 * bent round the circle, not shaded out and not interrupted by anything you can
 * see. They are simply not there for the width of it.
 *
 * The first draft filled the ellipse in. That is a black disc in front of the
 * world and it is exactly the thing this slot is not; it also went to a blob at
 * 34px. An empty counter with three broken lines through it says absence with
 * no ink at all, which is the same argument the ability makes.
 */
export const SILENCE = WRAP(`
  <ellipse cx="50" cy="52" rx="30" ry="30"/>
  <path d="M6 30H19M81 30H94"/>
  <path d="M6 52H19M81 52H94"/>
  <path d="M6 74H19M81 74H94"/>
`);

/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

/**
 * Umbral Spears — three blades on a diagonal, and the shadow they lie in.
 *
 * The diagonal is the house convention for a line cast; here it is not drawn as
 * a line at all but implied by three barbed blades of rising height standing on
 * it. The long stroke beneath them is the shadow, offset to one side rather
 * than centred, because the one thing this slot has that no other void slot has
 * is a light direction. Each blade carries its barb as a single kink, which is
 * the only interior detail that survives 34px.
 */
export const UMBRALSPEARS = WRAP(`
  <path d="M21 78L19 56L26 58L23 40"/>
  <path d="M46 80L44 54L52 57L48 30"/>
  <path d="M73 84L72 52L81 56L77 24"/>
  <path d="M10 90L86 74"/>
`);

export const VOID_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  silence: SILENCE,
  unmake: UNMAKE,
  soulchain: SOULCHAIN,
  umbralspears: UMBRALSPEARS,
  nightfall: NIGHTFALL,
  singularity: SINGULARITY,
  voidrift: VOIDRIFT
};
