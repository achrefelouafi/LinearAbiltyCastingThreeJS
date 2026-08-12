/**
 * Hive sigils.
 *
 * Nothing shipped in this school — see `docs/ROSTER-II.md` for what is coming:
 * Locust Tide, Web Line, Hive Column, Wasp Funnel, Carapace and Broodburst.
 * Author each mark with `WRAP` from `./wrap.js`, keyed by ability id, and add
 * it to the map below. `index.js` already folds this module into
 * `ELEMENT_SIGILS`, so a new sigil needs no edit anywhere else.
 *
 * The school is emergence — many small things behaving as one — and the mark
 * cannot be many small things. Twenty dots in a 100-unit box is grey. Draw the
 * *one* the many add up to: the silhouette the swarm condenses into, the cell
 * the lattice is made of, the plate the tessellation locks. Three or four
 * cells say "lattice" far better than thirty do.
 *
 * Where an agent has to appear at all, one is enough and it should be large —
 * a single insect at the head of a mass, drawn big enough to have a body and
 * two wings, reads at 34px where a scatter of specks does not.
 */
import { WRAP } from './wrap.js';

/**
 * Web Line — a corner web hung off the drag-line that threw it.
 *
 * The house rule for a line cast is a diagonal, and here the diagonal is the
 * thing that does the work: the drag-line runs off the bottom-left corner and
 * the hub sits on it, so the whole mark leans the way the cast is aimed. Three
 * radials and two chords is the fewest that reads as *web* rather than as
 * *fan* — the chords are what say the radials are connected to each other.
 *
 * The first draft drew a full orb, all the way round. At 34px a complete web is
 * a disc with a texture on it and the counter fills in; a quarter of one keeps
 * its white space and is legible at half the size.
 */
export const WEBLINE = WRAP(`
  <path d="M6 94L22 78"/>
  <path d="M22 78L34 14"/>
  <path d="M22 78L72 26"/>
  <path d="M22 78L90 62"/>
  <path d="M26 56C33 57 42 63 46 72"/>
  <path d="M31 30C46 33 63 47 73 66"/>
`);

/**
 * Hive Column — three cells that agree with each other, and one that budded off.
 *
 * The far-cast ellipse sits under a stack of *flat-top* hexagons, and flat-top
 * is the whole reason it works: in that orientation a neighbour is directly
 * above, sharing a whole edge, so two cells drawn one above the other read as
 * *built* rather than as two hexagons someone lined up. The third is offset
 * sixty degrees off the second, sharing its upper-left edge, which is what says
 * the tower grew by budding and is why its silhouette is lopsided.
 *
 * Every shared edge is drawn once, by both cells, at the same coordinates — the
 * first draft nudged them apart by a couple of units to "show" the seam and the
 * mark immediately read as a pile of loose tiles. The lattice is exact or it is
 * not a lattice.
 */
export const HIVECOLUMN = WRAP(`
  <ellipse cx="48" cy="88" rx="34" ry="8"/>
  <path d="M59 66L51.5 53L36.5 53L29 66L36.5 79L51.5 79Z"/>
  <path d="M59 40L51.5 27L36.5 27L29 40L36.5 53L51.5 53Z"/>
  <path d="M81.5 27L74 14L59 14L51.5 27L59 40L74 40Z"/>
`);

/**
 * Locust Tide — the last of the three shapes, on the diagonal of a line cast.
 *
 * The swarm becomes a fist, then a wall, then a spear, and only one of those
 * can be the mark. It is the spear: it is what the cast *arrives* as, and a
 * spearhead on a diagonal says "thrown down a line" before you have read
 * anything else in the box. The two strokes sweeping back off the shaft are one
 * pair of wings, drawn large — the school's rule about never trying to draw the
 * many, applied to a mark that still has to say *insects*.
 *
 * The first version drew all three silhouettes in sequence across the box. At
 * 34px it was three grey lumps and the diagonal had gone.
 */
export const LOCUSTTIDE = WRAP(`
  <path d="M12 88L70 30"/>
  <path d="M50 26L78 22L74 50"/>
  <path d="M40 54C30 44 22 42 13 46"/>
  <path d="M34 60C24 70 22 78 26 87"/>
`);

/**
 * Carapace — a dome of plates, and one still on its way in.
 *
 * The far-cast ellipse is the footprint, because that is the first thing a
 * ground-targeted slot has to say. The dome over it is drawn as *three* strokes
 * and not as one arc: the two seams running down from the crown are what turn a
 * bump into an assembly, and they meet the rim exactly where the arc does,
 * because a seam that stops short says the plates do not touch.
 *
 * The loose quadrilateral up and to the right is the plate that has not landed
 * yet, at the same tilt as the seam it is going to fill. One is enough — two
 * read as debris, and this is the school where everything ends up in its place.
 */
export const CARAPACE = WRAP(`
  <ellipse cx="50" cy="78" rx="38" ry="11"/>
  <path d="M12 78Q14 26 50 20Q86 26 88 78"/>
  <path d="M50 20L38 78"/>
  <path d="M50 20L68 76"/>
  <path d="M74 12L92 18L88 34L70 28Z"/>
`);

/**
 * Wasp Funnel — a nest mouth, a funnel, and the bands travelling up it.
 *
 * The far-cast ellipse is the mouth, because a ground-targeted slot has to say
 * where it lands first. The two walls flare out of it rather than up from it,
 * which is what separates a funnel from a column at 34px. The two arcs across
 * them are the ability: they sag in the middle, so they read as bands *wrapped
 * round* the cone rather than as rungs drawn over the top of it — and two of
 * them, spaced unevenly, say a wave is travelling where three evenly spaced
 * ones would just say "ladder".
 */
export const WASPFUNNEL = WRAP(`
  <ellipse cx="50" cy="86" rx="20" ry="6"/>
  <path d="M30 86C26 58 22 36 14 14"/>
  <path d="M70 86C74 58 78 36 86 14"/>
  <path d="M25 58Q50 66 75 58"/>
  <path d="M19 34Q50 43 81 34"/>
`);

/**
 * Broodburst — one egg, already open.
 *
 * The far-cast ellipse under it, and above it a *single* egg split into two
 * half-shells tipped apart. One egg and not a clutch: three or four small ovals
 * at 34px are three or four grey pills, and the thing the slot has to say is not
 * "several" but "these come apart".
 *
 * The inner edge of each half is a zig-zag rather than a line, and the two
 * zig-zags do not mirror each other — a symmetric split reads as a hinge on a
 * manufactured case, and this is supposed to have torn. The gap between them is
 * deliberately empty: whatever came out is the next second of the cast, and
 * drawing it here would put two ideas in one mark.
 */
export const BROODBURST = WRAP(`
  <ellipse cx="50" cy="88" rx="32" ry="7"/>
  <path d="M44 78C24 70 18 40 30 16L38 30L32 44L40 58Z"/>
  <path d="M56 78C76 70 82 40 70 16L61 31L68 45L59 59Z"/>
`);

/** Keyed by ability id. */
/* ------------------------------------------------------------------ */
/* APPEND NEW MARKS ABOVE THE MAP — one `export const NAME = WRAP(...)` */
/* per ability, with the doc comment that says what the mark is saying. */
/* ------------------------------------------------------------------ */

export const HIVE_SIGILS = {
  /* --- APPEND SIGILS BELOW THIS LINE (id: NAME,) --- */
  broodburst: BROODBURST,
  waspfunnel: WASPFUNNEL,
  carapace: CARAPACE,
  locusttide: LOCUSTTIDE,
  hivecolumn: HIVECOLUMN,
  webline: WEBLINE,
};
