/**
 * Aether sigils.
 *
 * Nothing shipped in this school — see `docs/ROSTER.md` for what is coming.
 * Author each mark with `WRAP` from `./wrap.js`, keyed by ability id, and add
 * it to the map below. `index.js` already folds this module into
 * `ELEMENT_SIGILS`, so a new sigil needs no edit anywhere else.
 */
import { WRAP } from './wrap.js';

/**
 * Slipstream — a diagonal, and two rules that do not line up across it.
 *
 * The diagonal is the house mark for a line cast, and here it is also the
 * blade itself. The idea is carried entirely by the other four strokes: two
 * horizontal rules that pass behind the blade and come out the far side
 * *stepped*, which is the one thing this ability does — it displaces what is
 * behind it and emits nothing of its own.
 *
 * A first version drew three parallel diagonals, meaning "the same edge,
 * slid". At 34px that is three lines and no idea. Breaking a rule across the
 * blade needs the viewer to do no work at all.
 */
export const SLIPSTREAM = WRAP(`
  <path d="M18 82L82 18"/>
  <path d="M10 36H56"/>
  <path d="M68 44H92"/>
  <path d="M8 62H30"/>
  <path d="M44 70H90"/>
`);

/**
 * Cyclone — the funnel seen from the side, standing in its own footprint.
 *
 * A far cast, so it is built on the ellipse you look *into*: the wide ellipse
 * is the scoured floor and the two curves rising out of it are the profile
 * itself, waisted at the throat and flaring again at the mouth. That is the
 * ability's one idea drawn in two strokes. A spiral was the obvious mark and it
 * was wrong — at 34px a spiral is a smudge, and it says "swirl" rather than
 * "something is standing on the ground over there".
 */
export const CYCLONE = WRAP(`
  <ellipse cx="50" cy="82" rx="34" ry="11"/>
  <path d="M22 20C30 38 40 50 43 82"/>
  <path d="M78 20C70 38 60 50 57 82"/>
  <path d="M20 20C34 27 66 27 80 20"/>
`);

/**
 * Resonant Chord — the line, and the standing pattern on it.
 *
 * A line cast, so it is a diagonal. The three rings crossing it are the ring
 * train seen edge-on, and they are drawn at deliberately *unequal* sizes —
 * wide, pinched, wide — because the whole point of the slot is that the pattern
 * has places where the air is still and places where it is violently
 * compressed. Evenly sized rings read as a spring, which is the one thing this
 * must not look like.
 */
export const RESONANCE = WRAP(`
  <path d="M14 84L86 20"/>
  <ellipse cx="31" cy="70" rx="6.5" ry="17" transform="rotate(48 31 70)"/>
  <ellipse cx="50" cy="53" rx="6.5" ry="6" transform="rotate(48 50 53)"/>
  <ellipse cx="69" cy="36" rx="6.5" ry="17" transform="rotate(48 69 36)"/>
`);

/**
 * Aurora Veil — four folded sheets standing in the ellipse you look into.
 *
 * A far cast, so the ellipse. The four strokes rising out of it are the sheets
 * seen edge-on: each is a shallow S, they are drawn to *different* heights, and
 * none of them is vertical. That is the whole idea — a rank of straight
 * parallel lines is a fence, and it takes exactly one bend per stroke to make
 * it cloth. The bends alternate direction across the four so the mark has a
 * wave in it at 34px even when the individual curves have stopped resolving.
 */
export const AURORA = WRAP(`
  <ellipse cx="50" cy="82" rx="36" ry="11"/>
  <path d="M22 78C17 62 29 54 23 38"/>
  <path d="M40 84C34 64 47 52 41 28"/>
  <path d="M61 84C57 62 68 50 63 22"/>
  <path d="M79 79C75 65 85 56 81 40"/>
`);

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/**
 * Sky Fracture — the crack, and the crack's reflection.
 *
 * The one sigil in the set built around a horizon: the split above the line and
 * its answer below it, because the ability's whole trick is that you see the
 * mark on the floor *before* the sky does anything. The lower half is drawn
 * lighter-handed — fewer branches — so the pair reads as reflection rather than
 * as symmetry.
 */
export const SKYFRACTURE = WRAP(`
  <path d="M62 6L52 30L66 34L44 62"/>
  <path d="M52 30L38 26M66 34L78 28"/>
  <path d="M8 68H92"/>
  <path d="M58 78L50 92M58 78L70 88"/>
`);

/**
 * Mirage — a runner, and the rule behind them stepped out of true.
 *
 * The figure is four strokes and no more: a head, a leaning trunk, a stride.
 * It has to be a *runner* rather than a standing person, because the ability's
 * second half is that you lose the double the moment it slows — a figure at
 * rest is the one thing this slot never shows you.
 *
 * The two short rules either side of it are the ability's first half, and they
 * are the reason there is no separate diagonal for the line cast: they are one
 * line, offset where the body crosses it, so the mark says "the world bends
 * around this" without drawing a single thing the figure itself emits. An
 * earlier version outlined the runner twice, slightly apart, meaning "a
 * duplicate". At 34px two overlapping stick figures are a smudge with a hat on.
 */
export const MIRAGE = WRAP(`
  <circle cx="63" cy="23" r="8.5"/>
  <path d="M60 33L47 58"/>
  <path d="M47 58L62 79M47 58L28 73"/>
  <path d="M6 62H30"/>
  <path d="M74 50H96"/>
`);

/**
 * Featherfall — three descents into the ellipse you look into.
 *
 * A far cast, so the ellipse. What is standing in it is the entire ability:
 * three paths down, and **no two of them the same kind of line**. One weaves —
 * that is the flutterer, glide, stall, glide back. One is a hard zigzag of
 * straight segments — the tumbler, which has no curve in it anywhere. One is a
 * single smooth sweep that barely turns — the one that caught a gust and rode
 * it. Three copies of the same wiggle would say "feathers"; three different
 * *kinds* of wiggle say the thing this slot is actually about.
 *
 * A drawn feather was the first version and it is a worse mark: at 34px a
 * feather is an almond, and an almond is not a fall.
 */
export const FEATHERFALL = WRAP(`
  <ellipse cx="50" cy="86" rx="33" ry="9"/>
  <path d="M24 10C34 22 16 30 26 42C36 54 18 62 28 74"/>
  <path d="M52 8L60 20L48 28L58 40L46 48L56 60L48 72"/>
  <path d="M92 24C78 34 74 50 64 76"/>
`);

/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

export const AETHER_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  featherfall: FEATHERFALL,
  mirage: MIRAGE,
  skyfracture: SKYFRACTURE,
  aurora: AURORA,
  cyclone: CYCLONE,
  resonance: RESONANCE,
  slipstream: SLIPSTREAM
};
