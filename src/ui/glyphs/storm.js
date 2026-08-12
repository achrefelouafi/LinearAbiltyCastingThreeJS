/**
 * Storm sigils.
 *
 * Two shipped: the Lance's bolt-through-arcs, and the Snare's ring with a bolt
 * standing in it. Chain Arc, Thunderclap, Fulminant Orb, Tempest Wall and
 * Railcoil belong here.
 */
import { WRAP } from './wrap.js';

/**
 * Thunder — a bolt struck through a pair of arcs.
 *
 * The zigzag is drawn on the same diagonal the cast travels on, and the two
 * open arcs behind it read as the discharge spreading off it. Stroke only, like
 * the snowflake, so the two slots sit at the same visual weight.
 */
export const THUNDER = WRAP(`
  <path d="M60 10L30 52H49L40 90L72 45H52L60 10Z"/>
  <path d="M23 26C13 36 11 52 17 65"/>
  <path d="M84 34C90 47 88 63 78 73"/>
`);

/**
 * Snare — a ring with a bolt standing in it.
 *
 * The only sigil in the set built around a *circle you look into* rather than a
 * diagonal, because that is the one thing this slot has to say before anything
 * else: it is not a skillshot, it is a footprint. The ellipse is the boundary
 * seen in perspective, four arcs step around it where the rim current runs, and
 * the zigzag rises out of the middle.
 */
export const SNARE = WRAP(`
  <ellipse cx="50" cy="70" rx="38" ry="15"/>
  <path d="M12 70L4 70M88 70L96 70M31 82L27 89M69 82L73 89"/>
  <path d="M56 18L38 46H50L44 68"/>
  <path d="M50 55L62 40H52L58 26"/>
`);

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

/**
 * Sheet Lightning — the sheet overhead, and the light coming *down* out of it.
 *
 * A far cast, so it is built on an ellipse; what makes it findable next to the
 * school's three other ellipses is where the ellipse *sits*. Thunderclap,
 * Snare and Fulminant Orb all put their circle on the floor or around a body,
 * and this one is the only mark in the set whose ellipse is at the top of the
 * frame with everything else hanging below it — which is the one thing the slot
 * has to say before anything else, that the event is above you.
 *
 * The flat zigzag threaded through the ellipse is the discharge inside the
 * cloud: horizontal, because every other storm mark's zigzag runs on the cast
 * diagonal and this one goes nowhere. The three rays falling out of it are the
 * trick — the ability's whole output is light arriving on things that are not
 * the ability. Drawing a ground line under them was tried and it closed the mark
 * into a box; leaving the rays to run out of the frame is what says they land on
 * whatever happens to be standing there.
 */
export const SHEETLIGHTNING = WRAP(`
  <ellipse cx="50" cy="27" rx="42" ry="14"/>
  <path d="M16 30L30 21L42 32L56 21L68 32L82 24"/>
  <path d="M26 44L16 82M50 44L50 88M74 44L84 82"/>
`);

/**
 * Thunderclap — a small dome, a conspicuous empty band, and three rings.
 *
 * A far cast, so it is built on ellipses you look *into*, like the Snare's. What
 * separates the two at 34px is that the Snare has one boundary with something
 * standing in it and this has *four* concentric marks with nothing in the
 * middle. The band between the dome and the innermost ring is the widest gap in
 * the drawing and it is the only part of the sigil that is about anything: it is
 * the quarter-second of silence the slot is built around, and the first version
 * of this mark — five evenly spaced rings — said nothing at all because there
 * was no gap left to notice.
 */
export const THUNDERCLAP = WRAP(`
  <path d="M32 64A18 14 0 0 1 68 64"/>
  <ellipse cx="50" cy="64" rx="29" ry="11"/>
  <ellipse cx="50" cy="64" rx="38" ry="14.5"/>
  <ellipse cx="50" cy="64" rx="47" ry="18"/>
`);

/**
 * Tempest Wall — the aimed diagonal stopped by a bar drawn across it.
 *
 * The house convention gives a line cast a diagonal, and this slot's whole
 * point is that the diagonal is the wall's *normal*. So the diagonal runs
 * up-right in the usual way and then stops dead against a second stroke at
 * right angles to it, with three short verticals falling out of that stroke.
 * Nothing else in the school has a right angle in it, which is what makes it
 * findable on the bar.
 */
export const STORMWALL = WRAP(`
  <path d="M8 92L44 56"/>
  <path d="M26 26L78 78"/>
  <path d="M36 36L36 52M52 52L52 68M68 68L68 84"/>
`);

/**
 * Chain Arc — a zigzag that steps, with two earthing ticks under it.
 *
 * The Lance's bolt is one continuous stroke on a single diagonal; this one is
 * the same diagonal broken into four equal *hops* with hard corners and no
 * taper, which is the difference the slot is about. The two short ticks
 * dropping from the bends are the earthing spikes, and they double as the thing
 * that separates this mark from the Lance's at 34px, where the corner count
 * alone stops being legible.
 */
export const CHAINARC = WRAP(`
  <path d="M12 84L34 60L26 44L54 34L44 22L82 14"/>
  <path d="M34 60L31 76M54 34L57 50"/>
  <path d="M80 24C86 32 87 42 83 50"/>
`);

/**
 * Fulminant Orb — a ball with a loop drawn *around* it, on a diagonal.
 *
 * The only circle in the school that is not lying on the floor. It sits on the
 * cast diagonal with a short trail behind it, so it still reads as a line cast,
 * and the tilted ellipse crossing it is the cage: the one thing the slot has to
 * say is that the filaments go around rather than out, and an ellipse that
 * passes behind the ball and comes out the other side says it in one stroke.
 * The tick dropping off the underside is a spike earthing. Drawing the cage as
 * two crossing ellipses was truer to the effect and turned into a scribble at
 * 34px, so there is one.
 */
export const BALLLIGHTNING = WRAP(`
  <path d="M8 88L28 68"/>
  <circle cx="60" cy="42" r="16"/>
  <ellipse cx="60" cy="42" rx="31" ry="11" transform="rotate(-30 60 42)"/>
  <path d="M56 60L50 74L58 71L52 90"/>
`);

/**
 * Railcoil — the shot as one unbroken bar, with the coils stacked on the near
 * end of it.
 *
 * Every other storm mark is made of corners, because every other storm effect
 * is: the Lance zigzags, Chain Arc hops, the Orb loops. This one is a single
 * dead-straight diagonal, and that is the whole point — a shot with no travel
 * time has no shape to it. The three bars crossing the low end are the coils on
 * the barrel, and they read as coils rather than as a ladder because they sit
 * at the *breech* end and stop, leaving the run to the tip clear.
 *
 * The tick off the far end is the muzzle mark. Two of them made a chevron,
 * which turned the mark into an arrow and put it back in the same family as the
 * Lance; one is enough to say which way it went.
 */
export const RAILCOIL = WRAP(`
  <path d="M12 88L92 16"/>
  <path d="M13 68L33 87M24 58L44 77M35 48L55 67"/>
  <path d="M78 8L88 26"/>
`);

export const STORM_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  sheetlightning: SHEETLIGHTNING,
  railcoil: RAILCOIL,
  thunderclap: THUNDERCLAP,
  stormwall: STORMWALL,
  chainarc: CHAINARC,
  balllightning: BALLLIGHTNING,
  thunder: THUNDER,
  snare: SNARE
};
