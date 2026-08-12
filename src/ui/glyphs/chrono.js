/**
 * Chrono sigils.
 *
 * Nothing shipped in this school — see `docs/ROSTER-II.md` for what is coming:
 * Echo Step, Stasis Field, Rewind, Hourglass, Afterimage and Entropy Wave.
 * Author each mark with `WRAP` from `./wrap.js`, keyed by ability id, and add
 * it to the map below. `index.js` already folds this module into
 * `ELEMENT_SIGILS`, so a new sigil needs no edit anywhere else.
 *
 * Every one of these six is *about* time, so the cheap mark — a clock face, a
 * circling arrow — is available to all of them and therefore useful to none.
 * Worse, a ring with a tick in it is Runic Seal's territory already.
 *
 * The set has one device that no other school can use, and it should carry the
 * whole school: **repetition with decay**. The same shape drawn two or three
 * times, offset, is a copy of a moment; which end of the run is the present is
 * said by which end is denser or larger. Echo Step, Afterimage and Rewind are
 * three different answers to that one idea and must not be three drawings of
 * it — decide early which is offset in space, which in scale and which in
 * direction, and hold the line.
 */
import { WRAP } from './wrap.js';

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

/**
 * Entropy Wave — one ring drawn three times, eaten away toward the middle.
 *
 * A far cast, so the outermost ring is the house rule's ellipse you look into,
 * and it is the only one that is whole. The middle ring has lost its two ends
 * and the innermost is down to a pair of dashes, so reading inward is reading
 * *forward in time*: the centre aged first and has nearly gone, and the
 * complete outer ring is the front that has not finished arriving.
 *
 * That is the school's repetition-with-decay device on the one axis its
 * neighbours did not take — Echo Step owns offset in space, Afterimage owns
 * scale and Rewind owns direction, and this one is the same shape repeated with
 * *material* removed. It is also the only mark in the school that is legible as
 * a statement about the ground rather than about a body.
 *
 * The draft with five evenly spaced rings is a moiré pattern at 34px: the
 * vertical gap between two flat concentric ellipses is a fraction of the gap
 * between their radii, so the rings have to be spaced by their *minor* axis and
 * three is all that fits.
 */
export const ENTROPY = WRAP(`
  <ellipse cx="50" cy="55" rx="40" ry="22"/>
  <path d="M25.6 50.6A26 13 0 0 1 74.4 50.6"/>
  <path d="M74.4 59.4A26 13 0 0 1 25.6 59.4"/>
  <path d="M39.6 52.5A12 5 0 0 1 60.4 52.5"/>
  <path d="M59.2 58.2A12 5 0 0 1 40.8 58.2"/>
`);

/**
 * Hourglass — the same cone twice, one full and one open.
 *
 * A far cast, so the house rule gives it the ellipse you look into, and the
 * bowtie standing in it is the two bulbs meeting at the neck. Nothing else in
 * the set is a bowtie, which is most of why it survives on a bar of a hundred.
 *
 * The school's device is repetition with decay, and this is the one slot where
 * the two copies are **the same shape in opposite states**: the upper cone is
 * closed and the lower one is drawn as an open V. Closed reads as full and open
 * reads as filling, so the mark says which way the sand is going — and because
 * the two are otherwise identical it also says that the ability is about
 * swapping them.
 *
 * The draft that closed both triangles is a solid bowtie at 34px and it stops
 * being an hourglass and starts being a stroke-weight test. Leaving the bottom
 * edge to the ellipse costs nothing: the eye closes it.
 */
export const HOURGLASS = WRAP(`
  <ellipse cx="50" cy="84" rx="30" ry="8"/>
  <path d="M27 15L73 15L50 50Z"/>
  <path d="M31 74L50 50L69 74"/>
`);

/**
 * Echo Step — the same stride drawn three times, walking away down the line.
 *
 * Chrono's one device is repetition with decay, and this module's header asks
 * each slot to commit to *which* repetition it is. **Echo Step is the one
 * offset in space**: three identical chevrons marching up the diagonal, each
 * further back and each smaller, so the largest is unambiguously the present.
 * Afterimage takes offset in scale and Rewind takes offset in direction; if a
 * later hand blurs that split the school collapses into three drawings of one
 * idea.
 *
 * The chevrons carry the diagonal on their own, which is why there is no fourth
 * stroke ruling it in. The draft that had one crossed all three apexes and at
 * 34px the whole mark went to a hatched smudge — the white space between the
 * repeats is the only thing saying there are three of them.
 */
export const ECHOSTEP = WRAP(`
  <path d="M73 50L84 21L54 29"/>
  <path d="M47 69L56 47L33 53"/>
  <path d="M23 87L30 71L13 75"/>
`);

/**
 * Stasis Field — a fall that stops at the boundary.
 *
 * A far cast, so the house rule gives it the ellipse you look *into*, and the
 * arch over it is the held sphere. The idea is the other two strokes: they are
 * **one** trajectory, coming down from the top right, drawn twice with a gap
 * where it crosses the arch and with the second piece far shorter than the
 * first. Something arrived, and then it did not carry on.
 *
 * Deliberately not repetition-with-decay: this is the one chrono slot that is
 * not about copies of a moment, and drawing it as one would have taken a device
 * the other three need. It is also why the arch is closed rather than broken —
 * Nightfall's dome is a lid coming down with a gap in it, and the two marks have
 * to survive sitting on the same bar.
 *
 * The first draft put the stub *outside* the arch, on the near side. That reads
 * as a thing bouncing off, which is a shield; the stub has to be inside, past
 * the skin, or the mark says the wrong ability.
 */
export const STASISFIELD = WRAP(`
  <ellipse cx="50" cy="79" rx="33" ry="10"/>
  <path d="M17 79Q17 34 50 34Q83 34 83 79"/>
  <path d="M92 6L70 30"/>
  <path d="M60 44L52 53"/>
`);

/**
 * Afterimage — one body drawn at three scales, in one place, on the diagonal.
 *
 * The school's device is repetition with decay and each slot has to own a
 * different axis of it. Echo Step is the repeat offset in **space**; this is
 * the repeat offset in **scale** — the same almond nested twice inside itself
 * with the spine of it left showing, so what you read is one object at three
 * ages rather than three objects. Rewind still has direction, which is the
 * only axis left and the reason neither of these two may take it.
 *
 * The short stroke running out of the bottom-left corner is collinear with the
 * almonds' own long axis, so the house rule for a line cast is paid without a
 * fifth stroke: the trajectory and the body are one diagonal. The draft that
 * made all three repeats the same size needed an offset to be legible at all,
 * which is Echo Step's mark with worse spacing.
 */
export const AFTERIMAGE = WRAP(`
  <path d="M10 90L32 68"/>
  <path d="M82 18Q74 58 34 66Q42 26 82 18"/>
  <path d="M73 27Q68 52 43 57Q48 32 73 27"/>
  <path d="M51 49L65 35"/>
`);

/**
 * Rewind — one diagonal, gone up it and come back down.
 *
 * The school's device is repetition with decay on three axes, and the other two
 * are spoken for: Echo Step took **space**, Afterimage took **scale**, so this
 * takes **direction**, exactly as the module header asks. It is the only one of
 * the three whose repeat is a single continuous stroke — the outbound leg, a
 * hairpin over the top, and the return leg beside it — because direction is the
 * one axis you cannot state with two separate copies of a shape. Two strokes
 * side by side are Void Rift's tear; a stroke that turns over is a journey.
 *
 * The line cast's diagonal is therefore paid for twice, which is a bonus rather
 * than the idea. The arrowhead has to be on the *near* end: put it at the top
 * and the mark reads as a throw with a flourish, and the whole ability is that
 * the flourish is the ability.
 *
 * The draft with a third, straight rule through the middle of the hairpin was
 * more obviously a loop and completely closed the counter at 34px. The white
 * space between the two legs is the only thing saying there are two of them.
 */
export const REWIND = WRAP(`
  <path d="M12 78L66 24Q78 10 86 26Q91 37 74 44L22 92"/>
  <path d="M22 92L38 89"/>
  <path d="M22 92L27 77"/>
`);

export const CHRONO_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  entropy: ENTROPY,
  rewind: REWIND,
  afterimage: AFTERIMAGE,
  hourglass: HOURGLASS,
  echostep: ECHOSTEP,
  stasisfield: STASISFIELD,
};
