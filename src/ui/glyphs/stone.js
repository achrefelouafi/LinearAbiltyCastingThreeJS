/**
 * Stone sigils.
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
 * Obsidian Bloom — one blade with the fracture ribs drawn across it.
 *
 * The school already has two marks built on an ellipse you look into — the
 * Sinkhole's rim and Tectonic's cracked circle — so the ellipse here is pushed
 * to the bottom of the frame and used as a *floor* with something standing out
 * of it, which is the only mark in the school shaped that way.
 *
 * The blade's two flanks bow **inward**. That is the entire ability in two
 * curves: obsidian breaks in smooth curved shells, so a mark for it whose sides
 * were straight would be describing a quartz crystal. The two arcs struck across
 * the low end are the rib marks that radiate from wherever the blow landed, and
 * they are the reason this reads as broken glass rather than as a tooth.
 *
 * A ring of six blades was truer to what the ability actually does and turned
 * into a smear of verticals at 34px. One blade, big, with the ribs legible, says
 * more.
 */
export const OBSIDIAN = WRAP(`
  <ellipse cx="50" cy="80" rx="38" ry="10"/>
  <path d="M32 80C40 56 46 32 52 10C60 34 66 56 70 80"/>
  <path d="M37 71A15 13 0 0 0 66 72"/>
  <path d="M42 57A10 9 0 0 0 61 58"/>
`);

/**
 * Stone Spine — three slabs heaving off one floor line, on the diagonal.
 *
 * The house convention for a line cast is a diagonal, and here the diagonal is
 * made of the *progression*: each plate is tipped further over than the one
 * before it and stands taller, so the mark reads left to right the way the cast
 * travels. Every plate is a closed quad rather than a spike, which is the one
 * thing this slot has to say before anything else — plates, not spikes — and
 * each of them keeps one edge on the floor line, which is the hinge.
 */
export const STONESPINE = WRAP(`
  <path d="M8 82H92"/>
  <path d="M18 82L23 62L41 66L35 82Z"/>
  <path d="M44 82L54 46L72 53L63 82Z"/>
  <path d="M70 82L84 30L96 40L88 82Z"/>
`);

/**
 * Sinkhole — a rim you look into, with walls that never meet.
 *
 * The ellipse is the far-cast convention. The two walls run inward from the rim
 * and simply stop: there is no floor stroke, because a drawn floor is exactly
 * what stops a hole reading as bottomless, and the ability makes the same
 * decision in the shader. The block tumbling between them is falling, and it is
 * never shown landing either.
 */
export const SINKHOLE = WRAP(`
  <ellipse cx="50" cy="38" rx="40" ry="15"/>
  <path d="M10 38L36 86"/>
  <path d="M90 38L64 86"/>
  <path d="M42 58L54 53L60 63L48 69Z"/>
`);


/**
 * Petrify — a column on the diagonal, closed on from both sides, running out.
 *
 * The diagonal is the house convention for a line cast. The two short strokes
 * bracketing it are the facets coming in off the shell — they point *at* the
 * line rather than standing on it, which is the whole difference between this
 * slot and every other stone slot. The three ticks falling off the low end are
 * the sand, and they are the only part of the mark that is not straight.
 */
export const PETRIFY = WRAP(`
  <path d="M20 78L80 26"/>
  <path d="M34 44L45 55M62 76L52 65"/>
  <path d="M27 86L23 94M41 82L37 91M55 78L51 87"/>
`);

/**
 * Tectonic — a circle you look into, with three cracks of unequal length in it.
 *
 * The ellipse is the house convention for a far cast. What the mark has to say
 * beyond that is the trick, so the three cracks are deliberately *not* the same
 * length: one has already reached the rim, one is most of the way, one has
 * barely left the middle. Each has a single kink, because a straight line out
 * of a centre is a spoke and this ability spends a whole slider avoiding that.
 * Five cracks would be truer to the effect and unreadable at 34px; three is the
 * fewest that still shows a race.
 */
export const TECTONIC = WRAP(`
  <ellipse cx="50" cy="56" rx="37" ry="16"/>
  <path d="M50 56L66 48L86 50"/>
  <path d="M50 56L36 65L21 61"/>
  <path d="M50 56L57 67"/>
`);

/**
 * Boulder — a circle running down a diagonal, over the track it has cut.
 *
 * The diagonal is the line-cast convention, and here it is the *rut*: two
 * parallel strokes converging into the distance with the rock sitting on the
 * near end of them, so the mark reads bottom-left to top-right the way the cast
 * travels. The two short ticks are what it has thrown out behind itself. The
 * circle is the only closed shape in the school, which is what tells it apart
 * from Stone Spine's plates at 34px.
 */
export const BOULDER = WRAP(`
  <circle cx="30" cy="66" r="17"/>
  <path d="M44 78L88 44"/>
  <path d="M22 84L74 26"/>
  <path d="M14 52L6 44M20 40L14 31"/>
`);

export const STONE_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  obsidian: OBSIDIAN,
  boulder: BOULDER,
  stonespine: STONESPINE,
  sinkhole: SINKHOLE,
  tectonic: TECTONIC,
  petrify: PETRIFY
};
