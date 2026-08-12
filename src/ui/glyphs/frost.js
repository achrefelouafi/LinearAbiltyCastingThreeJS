/**
 * Frost sigils.
 *
 * Two shipped: the Lance's snowflake-over-a-point, and the Crown's ring of
 * blades. Rimewalker, Hailwrath and Shatterlance belong here.
 */
import { WRAP } from './wrap.js';

/**
 * Ice — a six-fold snowflake over a rising lance.
 *
 * Three axes at 60°, each with a pair of barbs, and a heavier vertical that runs
 * past the star into a point: the star says frost, the point says skillshot.
 */
export const ICE = WRAP(`
  <path d="M50 12V88"/>
  <path d="M17.5 30.5L82.5 69.5"/>
  <path d="M82.5 30.5L17.5 69.5"/>
  <path d="M50 24L41 33M50 24L59 33"/>
  <path d="M50 76L41 67M50 76L59 67"/>
  <path d="M27.5 36.5L27.7 49.2M27.5 36.5L38.5 30.4"/>
  <path d="M72.5 63.5L72.3 50.8M72.5 63.5L61.5 69.6"/>
  <path d="M72.5 36.5L72.3 49.2M72.5 36.5L61.5 30.4"/>
  <path d="M27.5 63.5L27.7 50.8M27.5 63.5L38.5 69.6"/>
`);

/**
 * Glacier — a crown of blades standing on a ring.
 *
 * The second sigil built around a *circle you look into*, because it is the
 * second far cast and that is the first thing the slot has to say. Where the
 * Snare stands one bolt in the middle of its ellipse, this one stands the ring
 * itself up: five blades of uneven height rising off the boundary with the
 * spire tallest in the middle, which is the silhouette the ability actually
 * makes.
 */
export const GLACIER = WRAP(`
  <ellipse cx="50" cy="74" rx="38" ry="13"/>
  <path d="M9 70L13 41L21 66"/>
  <path d="M24 65L30 31L37 60"/>
  <path d="M42 61L50 15L58 61"/>
  <path d="M63 60L70 31L76 65"/>
  <path d="M79 66L87 41L91 70"/>
`);

/**
 * Hail — stones falling into the circle.
 *
 * The far cast's ellipse again, because that is the first thing the slot has to
 * say, but this one is read from *outside* it: the Crown stands its blades up
 * off the boundary, so Hailwrath puts everything above the rim instead and
 * leaves the ring itself unbroken. Three steep strokes of unequal length,
 * stopped short of the ellipse so they read as still falling, plus one stub
 * that has almost landed — the stagger the whole ability is built on, drawn as
 * four different distances to go.
 *
 * A first version drew the stones as small diamonds. At 34px a diamond is a
 * dot, four dots over an ellipse is a domino, and the mark said nothing about
 * falling; the strokes say it with the same ink.
 */
export const HAIL = WRAP(`
  <ellipse cx="50" cy="74" rx="36" ry="13"/>
  <path d="M24 14L33 50"/>
  <path d="M50 8L57 56"/>
  <path d="M76 20L79 44"/>
  <path d="M64 54L66 63"/>
`);

/**
 * Rime — three plates peeling off a frozen line.
 *
 * The line cast's diagonal, laid low across the box so it reads as *floor*
 * rather than as a bolt, with three hooks standing off it. Each hook is one
 * stroke that leaves the ground, turns over and comes back down — which is the
 * entire silhouette of the ability, and the only mark in the set that curls.
 * They grow toward the far end, so the diagonal also says which way the cast
 * goes.
 *
 * A first version drew the plates as flat lozenges lying on the line. At 34px
 * flat lozenges on a diagonal are a dashed line, and a dashed line says
 * nothing; the hooks say "this stands up" with the same amount of ink.
 */
export const RIME = WRAP(`
  <path d="M10 78L90 52"/>
  <path d="M26 72C26 58 40 56 40 64"/>
  <path d="M48 65C48 46 68 45 66 57"/>
  <path d="M70 59C70 45 86 44 83 54"/>
`);

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/**
 * Shatterlance — one lance, already coming apart.
 *
 * The other two frost marks are fields of many small things; this slot is a
 * single object, so the mark is a single heavy diagonal. The three chips thrown
 * off its trailing edge are what stop it reading as the Lance's point again:
 * the whole ability is the contrast between one solid and two hundred pieces,
 * and the sigil has to carry that at 34px.
 */
export const SHATTERLANCE = WRAP(`
  <path d="M22 82L74 24L82 18L78 30L26 88Z"/>
  <path d="M46 50L62 44M40 62L52 68"/>
  <path d="M12 40L24 34M16 62L8 70M40 20L34 8"/>
`);

/**
 * Avalanche — a slope shedding into two heaps at their angle of repose.
 *
 * The line cast's diagonal is the release plane at the top left, and what it
 * has shed is the whole mark: two cones sitting on the floor, the far one
 * wider and *shallower* than the near one, because a heap that has had longer
 * to slump is flatter. That difference in slope between two otherwise
 * identical triangles is the ability, drawn with no extra ink.
 *
 * A first version drew the heap as a single smooth mound. It was unreadable —
 * a mound is a hill, and a hill says nothing about material. Two straight-sided
 * cones overlapping say "this is granular and it has stopped where it could
 * not get any steeper", which is the only thing the mark has to say.
 */
export const AVALANCHE = WRAP(`
  <path d="M4 88H96"/>
  <path d="M8 12L38 52"/>
  <path d="M14 88L36 46L60 88"/>
  <path d="M46 88L72 60L96 88"/>
`);

/**
 * Black Ice — a shape and its reflection, across the far cast's ellipse.
 *
 * The ellipse is the house convention for a zone, and here it doubles as the
 * waterline: one peak stands above it and a shorter, inverted twin hangs
 * below. Nothing else in the set is symmetric about a horizontal, so the mark
 * says "reflective" before it says anything else — which is right, because the
 * reflection is the whole ability.
 *
 * The twin is deliberately *shorter* than the peak rather than a true mirror
 * image. A perfectly symmetrical mark reads as a diamond and loses the idea
 * completely; foreshortening the lower half is what makes the eye read the
 * ellipse as a ground plane seen at an angle. The short stroke on the left is
 * the sheen line that says the plane is glassy rather than open.
 */
export const BLACKICE = WRAP(`
  <ellipse cx="50" cy="50" rx="41" ry="15"/>
  <path d="M34 36L50 6L66 36"/>
  <path d="M38 64L50 84L62 64"/>
  <path d="M16 45L34 45"/>
`);

/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

export const FROST_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  blackice: BLACKICE,
  avalanche: AVALANCHE,
  shatterlance: SHATTERLANCE,
  rime: RIME,
  hail: HAIL,
  ice: ICE,
  glacier: GLACIER
};
