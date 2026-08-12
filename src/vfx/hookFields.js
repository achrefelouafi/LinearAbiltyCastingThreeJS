import { Vector4 } from 'three';

/* ------------------------------------------------------------------------ */
/* hookFields — the two published fields, and nothing else                   */
/* ------------------------------------------------------------------------ */
/**
 * The uniform boxes and GLSL that `vfx/SceneHooks.js` **publishes** for other
 * materials to opt into: DISRUPT (spellbreak) and GRAVITY (hourglass).
 *
 * This file exists for one reason, and it is a module-graph reason rather than
 * a graphics one, so it is worth writing down properly.
 *
 * `SceneHooks.js` imports `config/settings.js` — it must, because `apply()`
 * blends the key light and the grade *from settings* rather than from the live
 * value, which is the only way a blend cannot compound frame over frame. And
 * `config/settings.js` imports `config/abilities/index.js`, which imports every
 * settings module, six of which (`firewhip`, `geyser`, `railcoil`, `cyclone`,
 * …) import `vfx/Tube.js` for `tubeDefaults()`. So the moment `Tube` opted into
 * the disruption field the graph closed a ring:
 *
 * ```
 * settings.js → abilities/index.js → firewhip.js → Tube.js → SceneHooks.js → settings.js
 * ```
 *
 * ES modules tolerate a ring; they do not tolerate one that reads a `const`
 * across it before the defining body has run. Whether it explodes depends
 * entirely on **which module you enter the graph from**. Enter at `src/main.js`
 * and `settings.js` is entered first, so `abilities/index.js` finishes before
 * `settings.js`'s body reaches `...ABILITY_SETTINGS` — fine. Enter at
 * `abilities/registry.js` or at `config/abilities/index.js` — which any test,
 * any script, any tool and any future entry point may reasonably do — and
 * `settings.js`'s body runs first and throws
 * `ReferenceError: Cannot access 'ABILITY_SETTINGS' before initialization`,
 * from a file that has nothing to do with the change that broke it.
 *
 * That failure mode was live in the tree: `Tube.js` carried a long comment
 * explaining that the ring was benign from the entries the app happens to use,
 * and naming this file as the real fix. It was right about the fix and
 * optimistic about the ring. Both of the two importable entry points that are
 * not `main.js` were already dead.
 *
 * So the published fields live here instead, in a leaf that imports one class
 * from three and nothing else. A material opting into a field now depends on
 * the *field*, not on the ledger that drives it — which is also the honest
 * dependency: `FilamentPaths` does not care that a token stack exists, it cares
 * that there are three uniforms with agreed names and a function that reads
 * them. `SceneHooks.js` imports these boxes and re-exports the public four
 * unchanged, so every existing `import { disruptGLSL, disruptUniforms } from
 * '../vfx/SceneHooks.js'` keeps working and no consumer had to be touched.
 *
 * MATERIAL AGE deliberately did **not** move. It is not published: there is one
 * floor, `SceneHooks` patches it directly, and no other material opts in. A
 * leaf module for a field with a single in-house consumer would be filing.
 *
 * ## Invariants
 *
 * - **I1** — not one dimension is authored here across a frame boundary. The
 *   values in these boxes are the *neutral*, which is a definition of off
 *   rather than a metre; every live value is written by `SceneHooks.apply()`
 *   from the holding ability's settings, every frame, zero-length ones
 *   included.
 * - **I3** — the boxes are created once at module load and shared **by
 *   identity**. A material that spreads a *copy* reads a field that is
 *   permanently off and gets no error, which is the one trap in this file.
 */

/* ---------------------------------------------------------------- */
/* The published uniform blocks                                      */
/* ---------------------------------------------------------------- */

/**
 * DISRUPT's three uniform boxes, shared **by identity** with every material
 * that opts in — the `core/FrameUniforms.js` pattern. One write per frame in
 * `SceneHooks.apply()` updates every opted-in shader in the app, which is the
 * only way this could be cheap enough to put in `FilamentPaths` and mean it.
 *
 * `uDisruptRegion.w <= 0` is the off state and every consumer tests it first.
 */
export const disruptBlock = {
  /** xyz centre in metres, w radius in metres. w <= 0 means no disruption. */
  uDisruptRegion: { value: new Vector4(0, 0, 0, 0) },
  /** x drain (desaturate), y fracture (dither erosion), z dim, w edge 0..1. */
  uDisruptPower: { value: new Vector4(0, 0, 0, 0.35) },
  /** Device pixels per fracture cell. Bigger cells read as bigger shards. */
  uDisruptGrain: { value: 6 }
};

/** GRAVITY's block. Same sharing rule. `uGravityWell.w <= 0` is off. */
export const gravityBlock = {
  /** xyz centre in metres, w radius in metres. */
  uGravityWell: { value: new Vector4(0, 0, 0, 0) },
  /** x multiplier inside, y multiplier outside, z edge 0..1, w unused. */
  uGravityMix: { value: new Vector4(1, 1, 0.25, 0) }
};

/** The neutral for DISRUPT. Written on release; see `SceneHooks`'s header. */
export function neutraliseDisrupt() {
  disruptBlock.uDisruptRegion.value.set(0, 0, 0, 0);
  disruptBlock.uDisruptPower.value.set(0, 0, 0, 0.35);
  disruptBlock.uDisruptGrain.value = 6;
}

/** The neutral for GRAVITY — a multiplier of exactly 1 everywhere. */
export function neutraliseGravity() {
  gravityBlock.uGravityWell.value.set(0, 0, 0, 0);
  gravityBlock.uGravityMix.value.set(1, 1, 0.25, 0);
}

/**
 * The uniform boxes a material spreads in to read the disruption field.
 *
 * ```js
 * uniforms: sharedUniforms({ ...disruptUniforms(), uColorCore: ... })
 * ```
 *
 * Returns the shared boxes, not copies — that is the point. A material that
 * clones them reads a field that is permanently off, and there is no error.
 */
export function disruptUniforms() {
  return disruptBlock;
}

/** As `disruptUniforms()`, for the gravity multiplier. */
export function gravityUniforms() {
  return gravityBlock;
}

/* ---------------------------------------------------------------- */
/* GLSL — the opt-in                                                 */
/* ---------------------------------------------------------------- */

/**
 * The disrupt helper, for any stage of any material.
 *
 * Two functions and a guard. `disruptAt()` is meant for the **vertex** stage:
 * the field is smooth over metres, sampling it per vertex and interpolating
 * costs one varying instead of a world position and a distance per fragment,
 * and on a filament strip that is the difference between free and not.
 * `disruptShade()` then does the visible work in the fragment stage.
 *
 * The fracture is a screen-space dither rather than a displacement because this
 * has to work in materials that have nothing in common: a ribbon strip whose
 * vertices are placed by a parametric path, a ground quad with four vertices,
 * an instanced flock, a swept tube and a growth instance. There is no shared
 * vertex stage to push geometry apart in. Quantising `gl_FragCoord` into cells
 * and erasing whole cells reads as the effect *breaking up* rather than fading
 * out, which is the distinction that matters — a spell being torn apart, not a
 * spell ending.
 *
 * The first version dithered per pixel with a plain hash and it read as
 * dissolve-into-static, indistinguishable from a fade at any distance. The cell
 * size is what makes it shards, and it is a slider (`uDisruptGrain`).
 */
export const disruptGLSL = /* glsl */ `
#ifndef SCENE_HOOK_DISRUPT_INCLUDED
#define SCENE_HOOK_DISRUPT_INCLUDED

uniform vec4  uDisruptRegion;   // xyz centre metres, w radius metres (<=0 == off)
uniform vec4  uDisruptPower;    // x drain, y fracture, z dim, w edge 0..1
uniform float uDisruptGrain;    // device pixels per fracture cell

/** Cheap 2D hash. Local name so it cannot collide with the noise library. */
float shDisruptHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

/**
 * Field strength at a world point, 0..1. The first line is the whole cost when
 * nothing is disrupting: one compare against a uniform, the same answer for
 * every vertex in the draw call.
 */
float disruptAt(vec3 worldPos) {
  float r = uDisruptRegion.w;
  if (r <= 0.0) return 0.0;
  float d = distance(worldPos, uDisruptRegion.xyz);
  float edge = clamp(uDisruptPower.w, 0.001, 1.0);
  return 1.0 - smoothstep(r * (1.0 - edge), r, d);
}

/**
 * Apply the disruption to a shaded fragment. k is the interpolated field.
 * cell is normally gl_FragCoord.xy.
 */
void disruptShade(inout vec3 colour, inout float alpha, float k, vec2 cell) {
  if (k <= 0.0) return;
  float drain = clamp(uDisruptPower.x * k, 0.0, 1.0);
  float luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
  colour = mix(colour, vec3(luma), drain);
  colour *= 1.0 - clamp(uDisruptPower.z * k, 0.0, 0.95);
  float shard = shDisruptHash(floor(cell / max(uDisruptGrain, 1.0)));
  alpha *= step(clamp(uDisruptPower.y * k, 0.0, 1.0), shard);
}

#endif
`;

/**
 * The gravity helper — one function, for anything integrating a fall.
 *
 * A multiplier rather than a vector on purpose. Every falling thing in this
 * project already owns a gravity in metres/second² that is a slider on its own
 * block (`ShatterField`'s `gravity`, a particle system's `uGravity`), and I1
 * says that number must stay the ability's. Handing out a *replacement* vector
 * would take that slider away from whoever is falling; handing out a signed
 * scale leaves it exactly where it was and lets `hourglass` flip the sign of
 * everything in the zone with one number.
 */
export const gravityGLSL = /* glsl */ `
#ifndef SCENE_HOOK_GRAVITY_INCLUDED
#define SCENE_HOOK_GRAVITY_INCLUDED

uniform vec4 uGravityWell;   // xyz centre metres, w radius metres (<=0 == off)
uniform vec4 uGravityMix;    // x inside, y outside, z edge 0..1, w unused

/** Signed multiplier on this point's gravity. Exactly 1.0 when no hook is held. */
float gravityScaleAt(vec3 worldPos) {
  float r = uGravityWell.w;
  if (r <= 0.0) return 1.0;
  float d = distance(worldPos, uGravityWell.xyz);
  float edge = clamp(uGravityMix.z, 0.001, 1.0);
  float k = 1.0 - smoothstep(r * (1.0 - edge), r, d);
  return mix(uGravityMix.y, uGravityMix.x, k);
}

#endif
`;
