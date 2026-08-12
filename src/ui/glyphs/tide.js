/**
 * Tide sigils.
 *
 * All six have landed — Tiderush, Undertow, Brinelock, Geyser, Abyssal Cage and
 * Torrent — and the marks below are the shipped set. Author any further mark
 * with `WRAP` from `./wrap.js`, keyed by ability id, and add it to the map
 * below. `index.js` already folds this module into `ELEMENT_SIGILS`, so a new
 * sigil needs no edit anywhere else.
 *
 * The trap this school walks into: every one of the six is water, so every one
 * of them wants to be drawn as a curve, and six curves at 34px are one smudge.
 * Pick the *structure* the ability has that the others do not — a crown that
 * has stopped (Brinelock), a column standing in its own pool (Geyser), a
 * closed sphere (Abyssal Cage), a spiral that goes under (Undertow) — and draw
 * that. The wave itself is the least distinguishing thing in the set.
 *
 * Watch frost, too, and not only the other tide marks: a breaking wave and a
 * sheet of ice are neighbours in colour as well as in form, and Brinelock in
 * particular has to be told apart from Rimewalker with the colour taken away.
 */
import { WRAP } from './wrap.js';

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

/**
 * Brinelock — a crown that has stopped.
 *
 * The line cast's diagonal, laid low so it reads as a lane on the floor rather
 * than as a bolt, with a splash crown standing on it: four fingers of unequal
 * height, each one ending in the bead it was about to shed. The beads are the
 * mark. Take them away and this is Rimewalker's row of plates or Glacier's ring
 * of blades; leave them on and it is unmistakably *water*, and water drawn as
 * something rigid is the whole ability in one shape.
 *
 * A first version drew the crown as a smooth arc — a wave curling over the
 * diagonal. At 34px it was a comma, it said "wave" and nothing else, and it was
 * indistinguishable from the other five tide marks before any of them existed.
 * The frozen fingers say which wave.
 */
export const BRINELOCK = WRAP(`
  <path d="M8 78L92 62"/>
  <path d="M26 74L31 44"/>
  <path d="M44 71L50 26"/>
  <path d="M62 68L65 40"/>
  <path d="M78 65L82 50"/>
  <circle cx="31" cy="39" r="5"/><circle cx="50" cy="21" r="6"/><circle cx="82" cy="46" r="4"/>
`);

/**
 * Tiderush — a breaking diagonal with its own light lying on the floor.
 *
 * The house rule for a line cast is a diagonal, and the wave is it: one long
 * back slope hooking over into a curl at the top right, which is the direction
 * the cast travels. The three short strokes underneath are the caustic net, and
 * they are the reason this mark is not just "a wave" — they get *longer* toward
 * the front, because the whole ability is that the brightest light is thrown on
 * the ground ahead of the water rather than under it.
 *
 * The first draft drew the net as three more curves echoing the crest, which is
 * what caustics actually look like and is exactly the smudge this school's
 * header warns about: five curves in one 34px box and the mark says nothing.
 * Straight dashes under a curve keep their white space, and they read as
 * *ground* rather than as more water.
 */
export const TIDERUSH = WRAP(`
  <path d="M8 56C26 50 42 32 58 14"/>
  <path d="M58 14C69 4 85 9 78 25"/>
  <path d="M14 84L28 80"/>
  <path d="M40 86L60 79"/>
  <path d="M70 84L94 75"/>
`);

/**
 * Abyssal Cage — a closed sphere built out of smaller closed spheres.
 *
 * A far cast, so the footprint ellipse is there to say "over there" — but the
 * idea is carried by the four circles above it. One big one is the cage; three
 * small ones straddle its outline, which is the only stroke in the set that
 * says *made of bubbles* rather than *a bubble*. They deliberately overlap the
 * big circle rather than sitting inside it: a cluster tucked in the middle
 * reads as a diagram of an atom, and at 34px the crossings are what carry the
 * foam.
 *
 * The obvious mark was a rainbow arc, and it is unusable — the sigil set is
 * monochrome by construction, so the one thing this ability is actually about
 * is the one thing the mark cannot say. Drawing the *structure* instead is the
 * same lesson the school header already gives for Brinelock.
 */
export const BUBBLECAGE = WRAP(`
  <ellipse cx="50" cy="88" rx="30" ry="7"/>
  <circle cx="50" cy="48" r="29"/>
  <circle cx="31" cy="29" r="11"/>
  <circle cx="66" cy="24" r="8"/>
  <circle cx="72" cy="60" r="10"/>
`);

/**
 * Torrent — the diagonal, and where it goes afterwards.
 *
 * A line cast, so the jet is a diagonal, and it is drawn thin and straight to
 * say "pressure" rather than "wave". The idea is the three strokes leaving the
 * foot of it: they fan out **forward**, along the floor, in the direction the
 * jet was already travelling, and they are deliberately of unequal length with
 * nothing at all going back up the slope. That asymmetry is the whole ability.
 *
 * The first version fanned five strokes symmetrically about the contact point,
 * which is a starburst — the exact picture this slot exists to argue against —
 * and at 34px it was indistinguishable from every impact mark in the set. A fan
 * that only goes one way reads as deflection immediately, even before you can
 * resolve the individual strokes.
 */
export const TORRENT = WRAP(`
  <path d="M16 12L54 74"/>
  <path d="M54 74L92 62"/>
  <path d="M54 74L88 80"/>
  <path d="M54 74L78 90"/>
  <path d="M8 84H36"/>
`);

/**
 * Undertow — a far cast you look into, with a way out of the bottom.
 *
 * The house rule for a ground-targeted slot is an ellipse you look *into*, so
 * the pool is the ellipse and everything else happens inside it. The idea is
 * the arm: one stroke that comes in from the rim and winds once toward the
 * centre, and then the throat dropping straight out of the bottom of the mark
 * with a chevron on its end. That downward exit is the whole point — of the six
 * tide marks this is the only one whose stroke *leaves the ellipse*, which is
 * how it stays apart from Abyssal Cage's circles and Geyser's column at 34px.
 *
 * A true drawn spiral was the obvious mark and it is unreadable small: three
 * turns fill the counter and the whole thing goes to a disc. One winding arm
 * plus a hole says the same thing with four strokes.
 */
export const UNDERTOW = WRAP(`
  <ellipse cx="50" cy="46" rx="40" ry="17"/>
  <path d="M88 42C86 22 54 16 36 26C24 33 26 47 46 48"/>
  <path d="M50 48L50 82"/>
  <path d="M39 71L50 84L61 71"/>
`);

/**
 * Geyser — a column standing in its own pool.
 *
 * A far cast, so the pool is the ellipse you look into; the idea is the *only
 * vertical stroke in the school*. Two lines rise out of the middle of the
 * ellipse and splay apart at the top — the inverted funnel, narrow at the vent
 * and open at the head — with two short strokes falling back outside them.
 * Those two are the whole ability in two marks: the water that went up is the
 * water that comes down, so they are drawn shorter than the column and angled
 * *outward*, landing back inside the same ellipse.
 *
 * The nearest neighbour is Undertow, which is also an ellipse with a vertical
 * stroke — so this one deliberately goes *up* out of the ring and splays, where
 * that one goes down out of it and closes into a chevron. Up-and-open against
 * down-and-shut is legible at 34px; two verticals would not be.
 */
export const GEYSER = WRAP(`
  <ellipse cx="50" cy="80" rx="38" ry="12"/>
  <path d="M40 78C42 48 34 30 26 12"/>
  <path d="M60 78C58 48 66 30 74 12"/>
  <path d="M16 34L12 62"/>
  <path d="M86 36L89 64"/>
`);

export const TIDE_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  geyser: GEYSER,
  torrent: TORRENT,
  undertow: UNDERTOW,
  brinelock: BRINELOCK,
  bubblecage: BUBBLECAGE,
  tiderush: TIDERUSH,
};
