/**
 * Lumen sigils.
 *
 * All six have landed — Godspear, Solar Lens, Refraction Cascade, Dawnbreak,
 * Eclipse and Photon Lattice — and the marks below are the shipped set. Author
 * any further mark with `WRAP` from `./wrap.js`, keyed by ability id, and add it
 * to the map below. `index.js` already folds this module into `ELEMENT_SIGILS`,
 * so a new sigil needs no edit anywhere else.
 *
 * A school made of light has one obvious mark — rays coming off a disc — and
 * if two of these six use it, both are wasted. Radiating strokes are also the
 * single worst pattern at slot size: seven lines through a 100-unit box is a
 * hatch, and hatch reads as texture rather than as a symbol.
 *
 * Draw what the light *does* instead. Lumen's tricks are about occlusion,
 * bouncing and direction, so the marks that work are the ones with something
 * in the way: a beam broken across a mirror, a disc with a bite taken out of
 * it, a shaft that lands somewhere. The one thing the school may share is a
 * consistent light direction — pick it once and keep it, and six unrelated
 * marks will still look like one family.
 */
import { WRAP } from './wrap.js';

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

/**
 * Refraction Cascade — one line, folded twice.
 *
 * A line cast, so it is built on the house diagonal from the lower left to the
 * upper right — but the diagonal is *broken*, and each break has a short bar
 * lying across it. Three strokes and the whole ability is there: light that
 * gets where it is going by not going straight.
 *
 * The two bars are drawn at the angle a mirror would actually have to be at to
 * turn the beam the way the path turns, tilts computed rather than eyeballed,
 * which is the same discipline the ability itself runs on. It costs nothing and
 * it is the difference between a zig-zag with two ticks on it and a mark
 * somebody can read.
 *
 * A version with the panes as small parallelograms — glass, seen at an angle —
 * fills in at 34px and the mark becomes a dashed line with two blobs.
 */
export const REFRACTCASCADE = WRAP(`
  <path d="M10 84L38 46L44 75L83 30"/>
  <path d="M25 43L51 49"/>
  <path d="M31 72L57 78"/>
`);

/**
 * Solar Lens — a burning glass, and the point it comes to.
 *
 * Two arcs make a biconvex element, two straight strokes run from its edges to
 * a single point on the far-cast ellipse, and that is the ability: something in
 * the air, and everything it collects arriving in one place. The convergence
 * lands just *inside* the ellipse rather than at its centre, because the point
 * walks and a mark that puts it dead centre says "beam", which is the wrong
 * slot.
 *
 * The first draft drew rays coming *out* of the element as well, which is the
 * hatch the school header warns about — seven strokes through a 100-unit box —
 * and at 34px the element and its rays merged into one grey lozenge. Taking the
 * incoming light out entirely and keeping only the cone that leaves is what
 * made it legible; the lens shape carries the rest.
 */
export const SOLARLENS = WRAP(`
  <path d="M30 27Q50 14 70 27"/>
  <path d="M30 27Q50 40 70 27"/>
  <path d="M33 32L50 70M67 32L50 70"/>
  <ellipse cx="50" cy="78" rx="32" ry="10"/>
`);

/**
 * Dawnbreak — a sun riding a track over a circle you look into.
 *
 * The far-cast ellipse is the footprint, and the two strokes above it are the
 * whole ability: an arc that is a *path* rather than a dome, with the disc
 * sitting on it. Nothing radiates, which is the school's one rule, and the mark
 * still says "sun" because the arc tells you it is going somewhere.
 *
 * The first draft drew the sun low and to the left with a long shadow raking
 * across the footprint, which is literally what the ability does to the stage.
 * At 34px the shadow stroke and the ellipse's near edge merge into one thick
 * line and the mark reads as a struck-through circle. The track survives the
 * size; the shadow did not.
 */
export const DAWNBREAK = WRAP(`
  <ellipse cx="50" cy="80" rx="33" ry="10"/>
  <path d="M14 54A36 36 0 0 1 86 54"/>
  <circle cx="50" cy="30" r="11"/>
`);

/**
 * Eclipse — a disc with a bite taken out of it.
 *
 * Exactly the mark the school's header asks for, and the reason it is not a
 * wasted idea here is that occlusion *is* this slot: the second arc is the
 * occluder, drawn as a rim rather than as a filled shape so the two circles
 * keep their white space where they cross. A corona of rays round the outside
 * was tried and is the hatch the header warns about — at slot size it turns the
 * whole mark into a grey smudge with a hole in it.
 *
 * The footprint ellipse is the far cast, and it is drawn thin and low so the
 * eye reads the bite first.
 */
export const ECLIPSE = WRAP(`
  <circle cx="48" cy="42" r="22"/>
  <path d="M66 21A22 22 0 0 0 66 63"/>
  <ellipse cx="50" cy="84" rx="30" ry="8"/>
`);

/**
 * Godspear — a slanted shaft, capped at the mouth, landing in a bar.
 *
 * The one mark in this school made entirely of straight lines, which is what
 * separates it from Dawnbreak, Eclipse and Solar Lens at slot size before any
 * colour arrives. It is a line cast, so it is built on a diagonal, and the
 * diagonal leans the way `shaftTilt` leans the real thing — the shaft lies over
 * with the stage's key light rather than standing on end.
 *
 * The two edges *diverge* downward because the shaft does: narrow where it
 * enters, wide where it lands. The short cap across the top is what stops the
 * wedge reading as an arrowhead, and the bar along the bottom is the band on the
 * floor, which is half the ability.
 *
 * A version with three hatch strokes across the wedge — the dust in the beam —
 * is exactly the radiating-hatch failure this file's header warns about: at 34px
 * the wedge fills in and the mark becomes a grey triangle.
 */
export const GODSPEAR = WRAP(`
  <path d="M21 15L46 79"/>
  <path d="M35 15L86 79"/>
  <path d="M21 15L35 15"/>
  <path d="M40 90L92 90"/>
`);

/**
 * Photon Lattice — four beams crossing, and nothing at the crossings.
 *
 * The mark *is* the trick. Two families of parallel lines meet at four points
 * and there is deliberately no dot, no star and no thickening drawn at any of
 * them: at 34px the crossings read as bright because two strokes overlap there,
 * which is exactly why the nodes in the ability read as bright. Adding four
 * little diamonds was the first draft and it is the same lie the shader refuses
 * to tell.
 *
 * It is a far cast, so it sits over the ellipse the school uses for one. The
 * lines are drawn on the two isometric bearings rather than square to the box,
 * because a square grid at this size reads as a hash symbol.
 */
export const PHOTONLATTICE = WRAP(`
  <path d="M30 50L78 29"/>
  <path d="M22 64L70 43"/>
  <path d="M22 29L70 50"/>
  <path d="M30 43L78 64"/>
  <ellipse cx="50" cy="84" rx="30" ry="8"/>
`);

export const LUMEN_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  refractcascade: REFRACTCASCADE,
  photonlattice: PHOTONLATTICE,
  godspear: GODSPEAR,
  solarlens: SOLARLENS,
  dawnbreak: DAWNBREAK,
  eclipse: ECLIPSE,
};
