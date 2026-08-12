/**
 * WRAP — the one SVG envelope every sigil in the set is drawn inside.
 *
 * A 100×100 box, stroke only, no fill, inheriting `currentColor` — which in the
 * HUD is the slot's `--accent`, so a sigil is recoloured by CSS and never by
 * re-authoring the mark. Stroke-only is not a style choice: a filled glyph at
 * 34px on a dark bar turns into a blob, and the whole point of the set is that
 * a hundred of them stay distinguishable at that size.
 *
 * It lives in its own module so a hundred sigils can be authored across fifteen
 * school files without any of them copying the envelope — and so that changing
 * the stroke weight for the whole set stays a one-line edit rather than a
 * hundred.
 *
 * Author a sigil as paths in a 100×100 space and hand the body to `WRAP`:
 *
 * ```js
 * const RIME = WRAP(`
 *   <path d="M12 70L40 40L68 62L92 30"/>
 * `);
 * ```
 *
 * The rules the existing six follow, worth following:
 *  - one mark, not a scene — three to six strokes is the budget;
 *  - line casts are built on a diagonal, far casts on an ellipse you look
 *    *into*, because the first thing a slot has to say is how it is aimed;
 *  - no stroke thinner than the shared weight, because the renderer will not
 *    hint it at 34px and it will simply disappear.
 */
export const WRAP = (body) =>
  `<svg class="glyph-svg" viewBox="0 0 100 100" aria-hidden="true" fill="none"
     stroke="currentColor" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
