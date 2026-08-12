/**
 * Arcane sigils.
 *
 * One shipped: the Nova Beam's charge held in a bracket. Runic Seal, Prism
 * Lance, Chronofracture, Starfall, Arcane Volley and Glyphstorm belong here.
 */
import { WRAP } from './wrap.js';

/**
 * Beam — a charge held in a bracket, firing a cone.
 *
 * The orb sits low-left where the other three sigils start their diagonal, two
 * open brackets behind it read as the hands holding it, and three tapering rays
 * open out to the upper right with a single wave threaded through them: the
 * column, and the coil wrapped around it.
 */
export const BEAM = WRAP(`
  <circle cx="27" cy="66" r="11"/>
  <path d="M13 55C7 62 7 74 13 81"/>
  <path d="M40 79C47 73 47 61 40 55"/>
  <path d="M41 57L92 20M42 66L94 50M43 75L92 80"/>
  <path d="M46 63C56 49 64 71 74 57C82 46 88 52 93 46"/>
`);

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

/**
 * Astral Gate — the far ellipse with three shafts standing *out of* it.
 *
 * The house ellipse for a zone cast, read here as the aperture seen from
 * above, and the whole point of the mark is the crossing: each of the three
 * shafts is drawn as a full stroke that starts *below* the ellipse's near edge
 * and continues above it, so the ring passes across them. That overlap is the
 * only thing in the sigil doing any work — it is the two-dimensional version
 * of the ability's clip, and it survives 34px where a starfield inside the
 * ring does not.
 *
 * A first attempt drew the shafts stopping at the ellipse, which is what a
 * decal looks like: three sticks resting on a circle. Letting them cross is
 * one changed coordinate and it is the difference between "on" and "through".
 */
export const ASTRALGATE = WRAP(`
  <ellipse cx="50" cy="62" rx="36" ry="15"/>
  <path d="M30 74L34 22"/>
  <path d="M52 78L50 12"/>
  <path d="M72 71L66 30"/>
`);

/**
 * Spellbreak — the far ellipse, cracked, with the pieces already leaving.
 *
 * The house mark for a zone cast is an ellipse you look into, and this is the
 * only one in the set that is **broken**: the ring is drawn as two arcs with a
 * gap on each side rather than as a closed curve, so at 34px the first thing
 * you read is that the circle has failed. A single jagged stroke crosses it —
 * one line, not a web, because a spider-crack turns to grey mush at slot size
 * — and two short strokes fly off the top left and top right, which are the
 * panes.
 *
 * Four strokes. An early version drew a dome standing on the ellipse and it
 * was a good picture of what the ability *draws* and a bad picture of what it
 * *does*: what it does is break the thing that was there. The dome went.
 */
export const SPELLBREAK = WRAP(`
  <path d="M15 62A35 20 0 0 0 50 82A35 20 0 0 0 85 62"/>
  <path d="M85 54A35 20 0 0 0 50 34A35 20 0 0 0 15 54"/>
  <path d="M32 24L45 46L34 54L52 74"/>
  <path d="M22 30L8 16M70 26L84 12"/>
`);

/**
 * Starfall — three falls out of one knot, into the far circle.
 *
 * The mark *is* the trick. A small ring high and to the left is the vanishing
 * point every star leaves from; three strokes come out of it and fan apart on
 * their way down to the house ellipse, so the sigil says "one origin, many
 * landings" before the blurb does. The rays are drawn from just outside the
 * ring rather than from its centre, because three lines meeting inside a circle
 * at 34px is a blot.
 */
export const STARFALL = WRAP(`
  <circle cx="29" cy="15" r="6"/>
  <path d="M27 22L17 66"/>
  <path d="M31 22L49 74"/>
  <path d="M34 20L79 62"/>
  <ellipse cx="50" cy="76" rx="35" ry="13"/>
`);

/**
 * Chronofracture — two panes standing on a far circle, one of them failing.
 *
 * The ellipse is the house mark for a far cast, and it is read as the ground
 * the panes are hanging over. Two leaning quads stand on it — deliberately not
 * parallel, because the panes never are — and a single zigzag runs down the
 * right-hand one. Three strokes plus the circle: at 34px the crack is the only
 * thing that survives as detail, which is correct, because it is the tell that
 * says this is glass and not a gate.
 */
export const CHRONOFRACTURE = WRAP(`
  <ellipse cx="50" cy="76" rx="35" ry="13"/>
  <path d="M22 68L26 28L47 22L45 62Z"/>
  <path d="M57 62L59 25L79 33L78 70Z"/>
  <path d="M70 28L64 44L73 51L67 67"/>
`);

/**
 * Prism Lance — one line in, three out, reconverging.
 *
 * The house diagonal comes up from the lower left and *stops* at a triangle,
 * which is the only place in the set a cast line is interrupted by a body. Out
 * of the far side, three curves bow apart and meet again at a single point in
 * the upper right: the whole ability in five strokes, and the only mark in the
 * school whose rays are curved rather than straight — a claw of straight lines
 * says "many shots", and these are one shot that was bent.
 *
 * Six children draw in the world; three read at 34px. Six here is a smudge.
 */
export const PRISMLANCE = WRAP(`
  <path d="M10 88L38 60"/>
  <path d="M46 32L61 60H31Z"/>
  <path d="M57 49Q64 21 92 14"/>
  <path d="M58 52Q78 33 92 14"/>
  <path d="M57 56Q72 56 92 14"/>
`);

/**
 * Glyphstorm — four marks up the diagonal, two of them side-on.
 *
 * The house diagonal for a line cast, with the ability's one idea drawn on it
 * literally: the first and third marks are plates you can read, the second and
 * fourth are the same plates caught edge-on and reduced to a bare stroke. Two
 * quads and two slashes is the whole sigil, and at 34px the alternation is
 * still the thing you see — which is the point, because the alternation is the
 * ability. An attempt at putting a glyph *inside* the plates went in the bin:
 * at slot size it filled them in and the storm became a row of bricks.
 */
export const GLYPHSTORM = WRAP(`
  <path d="M10 86L22 62L40 68L28 92Z"/>
  <path d="M45 62L52 42"/>
  <path d="M58 42L70 20L84 26L72 48Z"/>
  <path d="M86 20L92 8"/>
`);

/**
 * Runic Seal — two rings, four ticks, one mark in the middle.
 *
 * The house ellipse for a far cast, doubled: the band between the two rings is
 * where the writing goes, and leaving it *empty* is the whole decision. Three
 * attempts put actual glyph strokes in that band and every one of them turned
 * to a dotted grey smear at 34px — the runes are five centimetres wide in a
 * five-metre seal, and there is no honest way to say that in a slot icon. What
 * survives shrinking is the *structure*: concentric, divided, centred. So the
 * four ticks carry "this thing is measured out" and the diamond carries "and
 * there is a bigger mark in the middle", which is the ability in two facts.
 *
 * It reads apart from its school-mates on count: Starfall's ellipse has rays
 * coming into it and Chronofracture's has panes standing on it, and this is the
 * only mark in the set with a second ring.
 */
export const RUNESEAL = WRAP(`
  <ellipse cx="50" cy="55" rx="42" ry="24"/>
  <ellipse cx="50" cy="55" rx="31" ry="18"/>
  <path d="M50 31V21M50 79V89M88 55H98M12 55H2"/>
  <path d="M50 44L61 55L50 66L39 55Z"/>
`);

/**
 * Arcane Volley — three weaves out of one knot, into one point.
 *
 * The house diagonal again, but drawn three times: three sine curves leaving a
 * small ring at the hand, crossing each other, and meeting at a single dot in
 * the upper right. The ring says the bolts gather before they go, the crossings
 * say they weave, and the dot says they land together — which is the ability in
 * order of events.
 *
 * Three curves rather than seven for the same reason Prism Lance draws three
 * rays: seven strokes through a 100-unit box is a hatch pattern at slot size.
 * The dot is drawn as a tiny filled-looking circle (a stroked r=3) because a
 * point where three strokes converge otherwise reads as a fray.
 */
export const ARCANEVOLLEY = WRAP(`
  <circle cx="20" cy="80" r="9"/>
  <path d="M27 73Q38 46 56 54Q74 62 86 22"/>
  <path d="M29 75Q52 66 60 40Q68 18 86 22"/>
  <path d="M25 71Q30 40 54 30Q76 22 86 22"/>
  <circle cx="87" cy="20" r="3"/>
`);

export const ARCANE_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  astralgate: ASTRALGATE,
  spellbreak: SPELLBREAK,
  arcanevolley: ARCANEVOLLEY,
  runeseal: RUNESEAL,
  glyphstorm: GLYPHSTORM,
  prismlance: PRISMLANCE,
  starfall: STARFALL,
  chronofracture: CHRONOFRACTURE,
  beam: BEAM
};
