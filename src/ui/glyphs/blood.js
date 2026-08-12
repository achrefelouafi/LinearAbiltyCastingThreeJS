/**
 * Blood sigils.
 *
 * Nothing shipped in this school — see `docs/ROSTER.md` for what is coming.
 * Author each mark with `WRAP` from `./wrap.js`, keyed by ability id, and add
 * it to the map below. `index.js` already folds this module into
 * `ELEMENT_SIGILS`, so a new sigil needs no edit anywhere else.
 */
import { WRAP } from './wrap.js';

/**
 * Crimson Tide — a breaking wave on the cast diagonal.
 *
 * The house convention wants a diagonal for a line cast, and a wave already is
 * one: the long back slope runs up from bottom-left, the lip curls over at the
 * top right and throws two droplets clear of it. The short chord under the curl
 * is the hollow of the barrel, and it is the one stroke that stops the mark
 * reading as a comma. Five strokes, and the two droplets survive 34px because
 * they are round caps on zero-length paths rather than circles.
 */
export const CRIMSONTIDE = WRAP(`
  <path d="M8 78C26 76 40 66 54 46C64 32 74 24 86 24"/>
  <path d="M86 24C92 32 90 44 80 50C70 56 58 52 55 44"/>
  <path d="M8 88C28 86 46 80 62 68"/>
  <path d="M74 14L74.01 14"/>
  <path d="M60 18L60.01 18"/>
`);

/**
 * Plague Bloom — a blister letting go on the rim of a far cast.
 *
 * The ellipse is the house convention for a circle you look into, and the three
 * domes sitting on it are the pustules. The middle one has already gone: its
 * walls are drawn splayed outward with no cap, and three strokes leave it
 * upward. Two intact blisters against one burst one is the smallest way to say
 * "these are on individual timers", which is the whole ability. The spray is
 * deliberately narrow — widen it and the mark turns into a plant.
 */
export const PLAGUEBLOOM = WRAP(`
  <ellipse cx="50" cy="72" rx="37" ry="13"/>
  <path d="M17 73C17 62 32 62 32 73"/>
  <path d="M68 74C68 63 83 63 83 74"/>
  <path d="M36 70C36 52 44 44 44 40M64 70C64 52 56 44 56 40"/>
  <path d="M50 36V12M38 34L31 18M62 34L69 18"/>
`);

/**
 * Sanguine Pact — two orbits crossing over a circle you look into.
 *
 * The flat ellipse is the house mark for a far cast and here it is also the
 * pool. The two ellipses standing over it are inclined orbits, crossed rather
 * than concentric, because *crossed* is the one arrangement that cannot be read
 * as a flat ring seen from an angle — which is precisely the mistake the
 * ability is built to avoid. Three beads sit on them, one on each orbit and one
 * where they meet.
 *
 * The first version drew the orbits as concentric ellipses of different widths.
 * At 34px that is a target, not a pact.
 */
export const SANGUINEPACT = WRAP(`
  <ellipse cx="50" cy="76" rx="34" ry="12"/>
  <ellipse cx="50" cy="48" rx="30" ry="15" transform="rotate(28 50 48)"/>
  <ellipse cx="50" cy="48" rx="30" ry="15" transform="rotate(-28 50 48)"/>
  <path d="M50 24L50.01 24"/>
  <path d="M22 58L22.01 58"/>
  <path d="M78 58L78.01 58"/>
`);

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

/**
 * Bone Cage — the house ellipse with a ribcage standing in it.
 *
 * Sanguine Pact already owns two *closed* ellipses crossed over a flat one, so
 * this cannot be another set of rings: side by side at 34px they would be the
 * same mark. These are **open arcs** — they spring off the rim, meet at a point
 * overhead and stop there — and the two shallow ties running between them are
 * what turn an arch into a cage. The ties are also the only thing in the mark
 * that is horizontal, which is what the eye finds first at slot size.
 *
 * The first version drew the ribs with a knuckle on each, to say bone rather
 * than iron. A knuckle is about a pixel and a half at 34px and it read as a
 * wobble in the stroke, so the bone is carried by the palette and the mark is
 * left to say cage.
 */
export const BONECAGE = WRAP(`
  <ellipse cx="50" cy="80" rx="34" ry="10"/>
  <path d="M15 80C15 42 32 18 50 16"/>
  <path d="M85 80C85 42 68 18 50 16"/>
  <path d="M20 54C34 47 66 47 80 54"/>
  <path d="M16 68C32 62 68 62 84 68"/>
`);

/**
 * Hemorrhage — three threads on the cast diagonal, arriving out of step.
 *
 * The house diagonal, drawn three times: same heading, offset laterally, and
 * — the whole point — stopping at three *different* distances, so the far ends
 * make a staircase instead of a row. That stagger is the ripple, and it is the
 * only thing in the mark that has to survive 34px.
 *
 * A splash flicks off the two leading ends and a shallow puddle lies under
 * them. The first draft had the threads dashed, to say "mist"; at 34px a dash
 * is a gap and the mark read as broken rather than as vapour, so the threads
 * are solid and the pool carries the aftermath instead.
 */
export const HEMOLANCE = WRAP(`
  <path d="M10 80L58 32"/>
  <path d="M18 88L72 34"/>
  <path d="M32 90L84 38"/>
  <path d="M84 38L94 28M84 38L92 46M72 34L82 24"/>
  <path d="M60 80C68 75 84 75 92 80"/>
`);

export const BLOOD_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  bonecage: BONECAGE,
  sanguinepact: SANGUINEPACT,
  hemolance: HEMOLANCE,
  plaguebloom: PLAGUEBLOOM,
  crimsontide: CRIMSONTIDE
};
