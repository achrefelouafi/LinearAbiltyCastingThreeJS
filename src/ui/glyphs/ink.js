/**
 * Ink sigils.
 *
 * Nothing shipped in this school — see `docs/ROSTER-II.md` for what is coming:
 * Sumi Stroke, Ink Bloom, Paper Storm, Seal Script, Splatterbrand and
 * Scrollward. Author each mark with `WRAP` from `./wrap.js`, keyed by ability
 * id, and add it to the map below. `index.js` already folds this module into
 * `ELEMENT_SIGILS`, so a new sigil needs no edit anywhere else.
 *
 * The envelope is stroke-only at a fixed weight, which everywhere else in the
 * set is a constraint and here is a coincidence: these six *are* strokes. The
 * temptation is therefore to draw a real brushstroke — a swelling, tapering
 * mark. `WRAP` cannot: one weight, round caps, no fill. Do not fight it by
 * stacking three paths to fake a taper, which at 34px is a blot. Say "brush"
 * with the *gesture* — an entry that starts off-box, a hooked exit, a broken
 * tail — and let the ability itself carry the dry-brush dynamics.
 *
 * This is also the school with no bloom, and the sigils should feel it: fewer
 * strokes than anywhere else, more white space, nothing radiating.
 */
import { WRAP } from './wrap.js';

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

/**
 * SEALSCRIPT — a character hung over the ellipse it was written above.
 *
 * The house rule for a far cast is an ellipse you look *into*, and here it is
 * doing double duty: it is the aim circle and it is the wash of ink on the
 * floor that the column stands over. Above it, one seal-script character —
 * a stem through two bars — because a column of three tiny characters at 34px
 * is a stack of grey rectangles, and the thing to say is *writing*, not *a lot
 * of writing*.
 *
 * The bars are bowed rather than straight. That is the entire difference
 * between this and a plumb-line-and-crossbars glyph, and it is the one place in
 * the set where a curve is load-bearing: seal script has no straight lines in
 * it, and two flat bars read as a diagram.
 */
export const SEALSCRIPT = WRAP(`
  <path d="M50 14L50 66"/>
  <path d="M31 30C40 24 60 24 69 30"/>
  <path d="M36 50C43 45 57 45 64 50"/>
  <ellipse cx="50" cy="82" rx="27" ry="9"/>
`);

/**
 * SUMISTROKE — one diagonal gesture that stops being a line.
 *
 * The diagonal is the house mark for a line cast, so the only thing left to say
 * is *dry brush*, and the way to say it inside a single stroke weight is to let
 * the stroke break. The tuck is the short tick at the top left, set at an angle
 * to the gesture the way a real 起筆 reverses before it travels; the body runs
 * down the box; and then the mark comes apart into two shortening dashes that
 * do not reach the corner.
 *
 * Drawing the tail as a dotted line was the first attempt and it reads as a
 * measurement, not a fray — evenly spaced anything looks deliberate. Two dashes
 * of falling length with a widening gap is the smallest thing that reads as
 * running out.
 */
export const SUMISTROKE = WRAP(`
  <path d="M20 16L27 25"/>
  <path d="M24 24C38 40 48 50 60 62"/>
  <path d="M66 68L74 76"/>
  <path d="M81 82L85 86"/>
`);

/**
 * INKBLOOM — the house ellipse for a far cast, with an unstable front inside it.
 *
 * The ring is the pool; the closed curve inside it is the ink. Its four lobes
 * are deliberately *unequal* — that is the whole mark. A rosette of five even
 * petals is what the first version drew and it reads as a flower, which is the
 * one thing a fingering instability is not: the instability is interesting
 * precisely because it is not symmetric, and unequal reach is the cheapest way
 * to say so in a still image.
 *
 * The short stroke overhead is the bead still on its way in, and it is what
 * stops the mark being read as a lily pad. It stops well clear of the ring so
 * that at 34px it stays a separate object rather than joining the blot.
 */
export const INKBLOOM = WRAP(`
  <ellipse cx="50" cy="64" rx="34" ry="13"/>
  <path d="M50 54C53.5 54 56.5 58.2 60.3 59.9C64 61.6 72.7 62.7 72.5 64C72.3 65.3 62.6 65.9 58.8 67.5C55.1 69.1 53.1 73.5 50 73.6C46.9 73.7 43.5 69.5 40.3 67.9C37 66.3 30.7 65.4 30.5 64C30.3 62.6 35.8 61.3 39 59.6C42.3 57.9 46.5 54 50 54Z"/>
  <path d="M50 22L50 36"/>
`);

/**
 * ORIGAMI — a crane on the diagonal, and the flat sheet it came from.
 *
 * The house rule for a line cast is a diagonal, and here the diagonal *is* the
 * crane's own centre crease — the one line every folded thing has. The two
 * strokes hanging off it are the halves either side of that crease, one seen
 * nearly edge-on and one nearly flat: the same two strokes at different
 * foreshortenings, which is what says "folded" rather than "pointed".
 *
 * The lozenge left behind at the tail is the ability. A square of paper,
 * unfolded, dropping out of the shot. The first draft drew it as a second,
 * smaller crane and the mark turned into a flock — at 34px a flock is a smudge,
 * and *before and after* is the idea anyway.
 */
export const ORIGAMI = WRAP(`
  <path d="M34 72L88 20"/>
  <path d="M34 72L54 26L88 20"/>
  <path d="M34 72L74 64L88 20"/>
  <path d="M6 82L20 70L34 82L20 94Z"/>
`);

/**
 * SCROLLWARD — two scrolls standing on the far-cast ellipse.
 *
 * The ellipse is the house mark for a ground-targeted cast and here it is also
 * the ring the scrolls stand on, so it is doing two jobs and paying for itself.
 *
 * The idea is in the two vertical strokes: each one **bows near its roll and
 * straightens toward the floor**, because that is the ability — curvature
 * tightest where the paper has just come off the spool, relaxing as it pays
 * out. Draw them as straight lines and the mark says "two posts". The circles
 * are the rolls, set at different heights so the pair reads as a wall caught
 * mid-rise rather than as a gate.
 */
export const SCROLLWARD = WRAP(`
  <ellipse cx="50" cy="82" rx="35" ry="10"/>
  <path d="M31 80C31 62 24 48 32 41"/>
  <circle cx="35" cy="34" r="7"/>
  <path d="M69 80C69 58 62 41 70 33"/>
  <circle cx="73" cy="26" r="7"/>
`);

/**
 * SPLATTERBRAND — the house diagonal for a line cast, read as a *distribution*.
 *
 * Three things sit on it, in the order the ability puts them there: the mass,
 * tilted along the travel vector rather than round; two teeth off its leading
 * arc and none off its trailing one, which is the asymmetry the whole slot is
 * about; and three satellites getting smaller as they get further, which is the
 * power law drawn as literally as six strokes allow.
 *
 * The satellites are the mark. The first draft scattered five dots of one size
 * around the blob and it read as a paw print — even sizes say "stencil" in a
 * sigil for exactly the reason they say it in the effect. Shrinking them down
 * the diagonal is the only thing here that could not be any other ink slot.
 */
export const SPLATTERBRAND = WRAP(`
  <ellipse cx="32" cy="70" rx="15" ry="9.5" transform="rotate(-42 32 70)"/>
  <path d="M43 60L53 51"/>
  <path d="M35 59L37 48"/>
  <circle cx="58" cy="47" r="5"/>
  <circle cx="71" cy="34" r="3.2"/>
  <circle cx="83" cy="23" r="2.2"/>
`);

export const INK_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  splatterbrand: SPLATTERBRAND,
  sealscript: SEALSCRIPT,
  origami: ORIGAMI,
  scrollward: SCROLLWARD,
  inkbloom: INKBLOOM,
  sumistroke: SUMISTROKE,
};
