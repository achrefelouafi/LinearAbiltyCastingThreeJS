/**
 * Forge sigils.
 *
 * All six have landed — Anvilfall, Sawline, Piston Drive, Gearlock, Quench and
 * Shrapnel Bloom — and the marks below are the shipped set. Author any further
 * mark with `WRAP` from `./wrap.js`, keyed by ability id, and add it to the map
 * below. `index.js` already folds this module into `ELEMENT_SIGILS`, so a new
 * sigil needs no edit anywhere else.
 *
 * This is the one school whose subjects are *machined*, and that is the gift:
 * everywhere else in the set a straight line and a right angle are wrong, and
 * here they are the point. Flat faces, bevels, parallel rules and struck arcs
 * read as manufactured against forty-odd organic marks without anything else
 * being done to them.
 *
 * The thing to resist is detail. A gear with twenty teeth is a cog at 100px
 * and a filled circle at 34px; six teeth say "gear" and survive. The same
 * applies to the saw and to the anvil's bevels — one bevel, drawn large.
 */
import { WRAP } from './wrap.js';

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

/**
 * Shrapnel Bloom — three fragments, and the skips they took to get there.
 *
 * The ellipse is the far-cast convention. What the mark has to say beyond that
 * is *ricochet*, and a burst of straight rays cannot say it — every other
 * explosion sigil in the set is straight rays. So each of the three arms is a
 * pair of shallow arcs meeting the ellipse at a point: a bounce, drawn. Three
 * arms rather than six, because at 34px six turn the ellipse into a smudge and
 * the whole read depends on one arc being separable from the next.
 *
 * The single tumbling chip at the end of the longest arm is what stopped the
 * mark reading as a splash: an arc that ends in nothing is water.
 */
export const SHRAPNEL = WRAP(`
  <ellipse cx="50" cy="62" rx="34" ry="14"/>
  <path d="M50 62Q62 40 74 52Q84 62 92 44"/>
  <path d="M50 62Q40 42 26 50Q14 57 9 40"/>
  <path d="M50 62Q56 78 70 82Q82 85 88 76"/>
  <path d="M86 32L96 36L92 46L82 42Z"/>
`);

/**
 * Anvilfall — the silhouette, dropping, into the dish it is about to make.
 *
 * The anvil is drawn as one closed outline rather than as a face plus a horn,
 * because two shapes touching at a corner fill in and turn to mud at 34px. The
 * horn is the single point on the left, which is the only part of the profile
 * nobody mistakes for a hammer.
 *
 * The ellipse is the house mark for a far cast, and here it is doing a second
 * job: it is the dent, so the anvil is standing *in* it rather than on the
 * line. The two ticks overhead are the fall — the one thing the profile alone
 * cannot say — and they are deliberately short, because long ones read as
 * speed and this ability is about weight.
 */
export const ANVILFALL = WRAP(`
  <path d="M31 15V26"/>
  <path d="M69 15V26"/>
  <path d="M11 41L32 31H80V45H32Z"/>
  <path d="M46 45L41 70H69L64 45"/>
  <ellipse cx="50" cy="79" rx="35" ry="9"/>
`);

/**
 * Gearlock — two wheels in mesh, seen from above.
 *
 * Both are ellipses, which is the house mark for a far cast and also, by luck,
 * exactly what a gear lying flat on the floor looks like from the camera this
 * sandbox uses. They are drawn *touching*, because the whole ability is that
 * the teeth interlock and a pair with daylight between them says the opposite
 * of the thing the slot is for.
 *
 * The teeth are three ticks on the big wheel and nothing at all on the small
 * one. A first version put six ticks on each and at 34px the result was two
 * fuzzy discs — the ticks merged into the outline and took the outline with
 * them. Three, on one wheel, on the side away from the mesh, is the fewest that
 * still reads as "toothed" and the most that survives.
 */
export const GEARLOCK = WRAP(`
  <ellipse cx="39" cy="50" rx="27" ry="18"/>
  <ellipse cx="79" cy="59" rx="14" ry="9"/>
  <path d="M39 32V20"/>
  <path d="M12 50H2"/>
  <path d="M39 68V80"/>
`);

/**
 * Quench — the billet going in, and the steam coming off.
 *
 * The ellipse is the bath (and the far cast); the bar is struck straight
 * through its centre so it is unmistakably *entering* rather than lying beside
 * it. The two curls are the steam, and they are drawn as opposed hooks rather
 * than as a rising plume: a plume at this size is a smudge, whereas two hooks
 * facing away from each other read as boiling even when they are four pixels
 * tall.
 *
 * The bar stops short of the bottom of the ellipse rather than crossing it,
 * which is the one detail that keeps it from reading as a sword on a stand.
 */
export const QUENCH = WRAP(`
  <ellipse cx="50" cy="64" rx="33" ry="12"/>
  <path d="M50 76V30"/>
  <path d="M30 46C30 37 40 37 40 27"/>
  <path d="M70 46C70 37 60 37 60 27"/>
`);

/**
 * Sawline — the blade, the cut behind it, and the spray off the tangent.
 *
 * The diagonal is the house mark for a line cast and here it is the kerf, so
 * the mark reads bottom-left to top-right the way the cast travels. The blade
 * is a plain circle: teeth at this size are the same mistake the gear makes at
 * twenty of them, and the tooth count is not what this slot is about.
 *
 * What it *is* about is the three strokes. They leave from the point where the
 * circle touches the kerf, and they leave **along the tangent there** rather
 * than out from the centre — which is the whole ability in one decision. The
 * first version drew them radially and it was immediately a sun with a stick
 * through it; swinging them onto the tangent turned the same five strokes into
 * a grinder. They fan slightly and they are unequal, because a sheaf is not a
 * comb.
 */
export const SAWLINE = WRAP(`
  <path d="M8 90L43 67"/>
  <circle cx="60" cy="50" r="24"/>
  <path d="M43 67L16 40M43 67L31 29M43 67L12 55"/>
`);

/**
 * Piston Drive — one ram up, two down, over the rail they are bolted to.
 *
 * The diagonal is the house mark for a line cast, and here it is the rail: a
 * single straight rule with three stations on it, drawn as short verticals
 * rather than as pistons, because a piston at 34px is a lozenge and a lozenge
 * is not saying anything.
 *
 * What the mark has to say beyond the aim is the **cam**, and it says it by
 * making the three stations unequal: one is fully up, one is halfway, one is
 * still down. That is the phase offset — the sequence down the line — read as
 * a staircase, and it is the only part of this slot that a still frame can
 * carry. The stroke over the tall one is the top of its travel, which is what
 * turns a stick into something that has arrived somewhere.
 */
export const PISTONDRIVE = WRAP(`
  <path d="M10 84L90 52"/>
  <path d="M26 79V44M54 69V30M82 59V47"/>
  <path d="M17 40H35"/>
`);

export const FORGE_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  pistondrive: PISTONDRIVE,
  shrapnel: SHRAPNEL,
  sawline: SAWLINE,
  anvilfall: ANVILFALL,
  gearlock: GEARLOCK,
  quench: QUENCH,
};
