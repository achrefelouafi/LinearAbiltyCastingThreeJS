/**
 * Flame sigils.
 *
 * One shipped: Cinder Fall's cracked ball trailing fire. Pyroclasm, Wyrm's
 * Breath, Ashen Lash, Emberflight, Magma Fount and Sunspear belong here.
 */
import { WRAP } from './wrap.js';

/**
 * Meteor — a cracked ball trailing fire.
 *
 * The circle sits forward and low with three seams splitting it, and three
 * tapering streaks run back up the same diagonal the other two sigils are drawn
 * on, so the slot reads as "the rock, thrown" at 34px.
 */
export const METEOR = WRAP(`
  <circle cx="62" cy="62" r="24"/>
  <path d="M46 45L58 58L52 72M74 46L66 60L79 72M58 84L64 70"/>
  <path d="M30 70L10 90M40 34L18 22M22 48L4 44"/>
`);

/**
 * Emberflight — three birds climbing the diagonal, and the column at the end.
 *
 * The chevron is the only bird shape that survives 34px: a wing outline loses
 * its rake and turns into a lozenge, while an open V keeps reading as
 * "something flying away from you" down to a handful of pixels. Three of them
 * on the line cast's diagonal give the skein; the vertical stroke with a fourth
 * chevron on top is the collapse going up, which is the beat no other flame
 * slot has.
 */
export const EMBERFLOCK = WRAP(`
  <path d="M6 80L16 73L26 80"/>
  <path d="M30 64L40 57L50 64"/>
  <path d="M54 48L64 41L74 48"/>
  <path d="M78 44L78 15"/>
  <path d="M70 23L78 14L86 23"/>
`);

/**
 * Pyroclasm — the far cast's ellipse, with the beat drawn inside it.
 *
 * A ZONE slot has to say "you look *into* this" before it says anything else,
 * so the footprint ellipse carries the mark and everything else sits on it. The
 * two short strokes lean inward off the rim: they are the collapse, and pointing
 * them in is the only cue that separates this slot from every other flame circle
 * at 34px. The column standing in the middle is what the collapse becomes.
 *
 * An earlier version drew three inward arrowheads instead. Arrowheads are two
 * strokes each, so six of them plus the ellipse turned the whole mark into a
 * ring of grey fuzz the moment it was scaled down — the chevron rule the
 * Emberflight mark learnt, arrived at from the other direction.
 */
export const PYROCLASM = WRAP(`
  <ellipse cx="50" cy="66" rx="36" ry="15"/>
  <path d="M16 40L29 53M84 40L71 53"/>
  <path d="M50 54C39 38 61 31 50 12"/>
`);

/**
 * Ashen Lash — the whip, with the loop still in it, cracking off the end.
 *
 * One continuous stroke does the whole job: it curls into a loop at the handle
 * end and then runs away up the line cast's diagonal, which is the ability's
 * entire beat in a single line — the loop is at the handle, and it travels. The
 * three short ticks off the far end are the crack, deliberately *detached* from
 * the lash so they read as a bang in the air rather than as a frayed tip.
 *
 * The loop was half this size in the first draft and closed into a solid dot at
 * 34px; at twenty-odd units across the counter survives, which is the only
 * reason you can tell this slot from Emberflight's skein on the bar.
 */
export const FIREWHIP = WRAP(`
  <path d="M8 90C25 90 35 78 33 64C31 52 16 49 16 62C16 79 41 81 57 64L84 32"/>
  <path d="M74 14L80 24M96 20L88 28M98 46L88 42"/>
`);

/**
 * Sunspear — the javelin coming down, and the sun it lands in.
 *
 * The line cast's diagonal, thrown *downward* — every other flame line in the
 * set climbs to the right, so a stroke going the other way separates this slot
 * before you have read anything else on it. The two short strokes flaring back
 * off the tip are the head; the shallow crown below is the disc's near rim
 * lying on the floor, with two corona ticks coming off its ends.
 *
 * The rim is deliberately an **open arc** and not an ellipse. An ellipse is the
 * house mark for a far cast, and this is a line cast that happens to finish in
 * a circle; closing that curve made the bar say the wrong thing about how the
 * slot is aimed, which is the first thing a sigil owes the player.
 */
export const SUNSPEAR = WRAP(`
  <path d="M14 8L58 62"/>
  <path d="M58 62L44 59M58 62L55 47"/>
  <path d="M22 84C36 73 68 73 82 84"/>
  <path d="M17 80L7 73M87 80L97 73"/>
`);

/**
 * Wyrm's Breath — the cone, opening up the line cast's diagonal.
 *
 * Two rays from a single apex at the bottom left, closed by an arc across the
 * mouth: that is the whole ability, and a closed mouth on an *open* apex is what
 * separates a cone from Sunspear's javelin-into-a-disc at 34px. The S-curve
 * inside it is the hollow — the tongue passing through its own middle, which is
 * the trick the slot is selling.
 *
 * The first draft drew the mouth as a straight bar between the two rays. It read
 * as a triangle, i.e. as a flat shape, which is exactly the thing the ability
 * spends a raymarcher not being; the arc is the only stroke in the mark that
 * says there is a volume in there.
 */
export const DRAGONBREATH = WRAP(`
  <path d="M14 86L90 52M14 86L56 12"/>
  <path d="M56 12C76 22 88 36 90 52"/>
  <path d="M31 76C48 71 45 55 63 49"/>
`);

/**
 * Magma Fount — the pool, its seam, and one blob out and back.
 *
 * A far cast has to say "you look *into* this" first, so the footprint ellipse
 * carries the mark. The zigzag across it is the crust seam, and it is the one
 * stroke that separates this slot from every other flame circle: a smooth line
 * would read as a waterline, while a broken one reads as something with a skin
 * on it. The arch leaving the middle and coming back down inside the rim is the
 * fount, drawn as a closed loop on purpose — a blob that lands outside its own
 * pool is a different ability.
 */
export const MAGMA = WRAP(`
  <ellipse cx="50" cy="74" rx="34" ry="13"/>
  <path d="M20 74L34 69L48 77L62 70L78 75"/>
  <path d="M38 70C33 26 76 30 74 72"/>
  <circle cx="55" cy="25" r="5"/>
`);

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/**
 * Firewalk — four prints alternating up the line cast's diagonal, and a flame
 * off the last one.
 *
 * The prints are ovals rather than little feet, and that is not a compromise:
 * at 34px five toes are five grey pixels and the mark turns to mush. What has
 * to survive the scale is the *alternation* — four marks stepping either side
 * of an implied diagonal — because that is what the ability is, and it is a
 * shape no other flame slot in the set makes.
 *
 * The lateral offset was ±9 units in the first draft and the trail read as
 * scattered blots; at ±6 the eye still joins the marks into a line and the zig
 * survives. The single flame curling off the far print is what says the trail
 * is burning rather than merely printed, and it goes on the *last* print
 * because that is the one that just lit.
 */
export const FIREWALK = WRAP(`
  <ellipse cx="21" cy="80" rx="5" ry="8" transform="rotate(-36 21 80)"/>
  <ellipse cx="32" cy="57" rx="5" ry="8" transform="rotate(-36 32 57)"/>
  <ellipse cx="58" cy="53" rx="5" ry="8" transform="rotate(-36 58 53)"/>
  <ellipse cx="70" cy="30" rx="5" ry="8" transform="rotate(-36 70 30)"/>
  <path d="M70 22C63 14 77 11 71 3"/>
`);

/**
 * Wildfire — the footprint ellipse, with the automaton stepping across it.
 *
 * A far cast has to say "you look into this" first, so the ellipse carries the
 * mark. What sits on it is three **squares** in a staircase and a fourth one
 * detached beyond them: the front advancing cell by cell, and the ember that
 * jumped the gap. Nothing else in the school — or in the set — uses squares,
 * so the slot is separable from Magma Fount's ellipse-and-seam at a glance,
 * which the first draft was not: that one drew the front as a jagged polyline
 * and read as the same mark as the magma crust at 34px.
 *
 * Right angles are also the one shape that says *lattice* without a caption,
 * which is the whole ability.
 */
export const WILDFIRE = WRAP(`
  <ellipse cx="50" cy="62" rx="36" ry="21"/>
  <rect x="22" y="62" width="13" height="13"/>
  <rect x="38" y="52" width="13" height="13"/>
  <rect x="54" y="60" width="13" height="13"/>
  <rect x="74" y="24" width="11" height="11"/>
`);

/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

export const FLAME_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  firewalk: FIREWALK,
  wildfire: WILDFIRE,
  magma: MAGMA,
  dragonbreath: DRAGONBREATH,
  sunspear: SUNSPEAR,
  firewhip: FIREWHIP,
  pyroclasm: PYROCLASM,
  emberflock: EMBERFLOCK,
  meteor: METEOR
};
