import { Color } from 'three';

/**
 * Cached hex-string → THREE.Color conversion.
 *
 * The editor stores colours as `#rrggbb` strings; shaders need Colors every
 * frame. Allocating a Color per frame per uniform would churn the GC, so we
 * memoise one instance per string and mutate uniform values from it.
 */
const cache = new Map();

export function getColor(hex) {
  let c = cache.get(hex);
  if (!c) {
    // three's colour management already converts `#rrggbb` (sRGB) into the
    // linear working space — no manual conversion here, or it would be applied
    // twice and everything would come out too dark.
    c = new Color(hex);
    cache.set(hex, c);
  }
  return c;
}

/** Copy a settings colour into a uniform's Color value without allocating. */
export function copyColor(target, hex) {
  target.copy(getColor(hex));
  return target;
}

/** Fresh (non-shared) Color from a settings string — for one-off construction. */
export function makeColor(hex) {
  return getColor(hex).clone();
}

/**
 * `copyColor` for a params bag: takes a `#rrggbb` string **or** a `THREE.Color`
 * **or** nothing, and falls back.
 *
 * Every VFX module reads its colours off a live params object every frame, and
 * every one of them has to answer the same three questions: did the caller
 * supply this key at all, did they supply a string from a settings block or a
 * Color they are already holding, and what does the module look like if they
 * did not. `copyColor` above answers none of them — it is the fast path for a
 * key you know is a string.
 *
 * `Dissolve` and `FoldMesh` each arrived with a private, character-identical
 * copy of this function; it is here so the next module does not write a third.
 * Note `??`, not `||`: an empty string is a caller mistake worth seeing as
 * black rather than silently becoming the fallback.
 *
 * @param {THREE.Color} target the uniform's Color, mutated in place
 * @param {string|THREE.Color|null|undefined} value from the params bag
 * @param {string|THREE.Color} fallback the module's default
 */
export function putColor(target, value, fallback) {
  const v = value ?? fallback;
  target.copy(typeof v === 'string' ? getColor(v) : v);
  return target;
}
