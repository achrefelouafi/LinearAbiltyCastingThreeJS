import { MAX_TIME_REGIONS } from '../../core/FrameUniforms.js';

/**
 * The time field — a handful of spheres that bend any shader's clock.
 *
 * ## What the field is
 *
 * Up to `MAX_TIME_REGIONS` spheres, published as shared uniform boxes in
 * `core/FrameUniforms.js` and filled by the pool in `vfx/TimeControl.js`. Each
 * one carries a centre, an outer radius, a soft inner radius, a strength, a
 * **hold timestamp** and a **rate**. A fragment or vertex inside a region does
 * not see the world clock; it sees
 *
 *     bent = mix(clock, hold + (clock - hold) * rate, weight)
 *
 * and that one line is all three chrono capabilities:
 *
 * | rate | what the region does |
 * | --- | --- |
 * | `0`  | **stasis** — the clock stops dead at `hold`. Nothing inside advances. |
 * | `-1` | **rewind** — the clock is mirrored about `hold` and runs backwards. |
 * | `0.2`| slow motion at a fifth speed, still anchored at `hold`. |
 * | `1`  | identity, whatever the weight. |
 *
 * `weight` is `strength × (1 - smoothstep(inner, outer, distance))`, so the
 * shell of a region is a **time-dilation gradient**: the derivative of `bent`
 * with respect to `clock` is `mix(1, rate, weight)`, which at rate 0 means
 * things at the rim crawl and things at the centre are stopped. That gradient
 * is the reason a stasis field reads as a *field* rather than as a hard sphere
 * of frozen sprites, and it comes free with the `mix`.
 *
 * ## Why a hold timestamp rather than a time scale
 *
 * The first version published a per-region `timeScale` and expected each
 * consumer to integrate it — `myClock += dt * scaleAtMyPosition`. That works
 * exactly once and then falls apart, because every consumer in this project is
 * a **closed-form function of time** with no per-object state to integrate
 * into: a particle is `f(uTime - aSpawn)` evaluated fresh in the vertex shader
 * every frame with nowhere to keep an accumulator, and a crystal's emergence is
 * `g(now - birth)`. There is no `myClock` to advance. Publishing the instant
 * the region locked instead turns the whole thing into a closed form too, which
 * means it also survives the one test that matters here: pause with **P**, drag
 * the radius, and particles that were outside the sphere snap to their held
 * pose while the rest keep theirs. A frame of zero length changes the picture.
 *
 * ## Composition
 *
 * Regions compose in slot order — each is applied to the clock the previous one
 * left behind. Every region is exactly identity at `weight = 0`, so the fold
 * over four slots with none live is four `mix`es by zero, and with one live it
 * is the single bend you asked for. Overlapping two regions is well defined but
 * is not a designed case; a stasis inside a rewind wins, because a rate of zero
 * discards whatever it is handed.
 *
 * ## Cost
 *
 * `uTimeRegionCount` is `0` unless a chrono ability is standing. Both entry
 * points open on it, so the cost of the entire mechanism in the fifty abilities
 * that never heard of it is **one uniform float compare and a branch that every
 * fragment in the draw takes the same way**. The uniform boxes themselves are
 * in `sharedUniforms()`, but three.js only uploads uniforms the compiled
 * program declares, so a shader that does not inject this chunk uploads none of
 * them.
 *
 * ## Using it
 *
 * Inject `timeWarpGLSL` (it carries its own uniform declarations behind an
 * include guard) and replace your clock:
 *
 * ```glsl
 *   float t = warpedTime(uTime, vWorldPos) - uBirth;
 * ```
 *
 * That is the whole integration for any shader whose position does not depend
 * on its own clock — ground fields, growth fields, tubes, shells, rim rings.
 *
 * A shader whose position *is* a function of the clock (a particle) cannot use
 * `warpedTime`, because probing the field at the bent position is a feedback
 * loop that thaws its own freeze: the frozen particle sits still, the world
 * clock moves on, and one frame later the probe is being asked about a position
 * that the particle only has *because* it is frozen. Such a shader must write
 * its own loop over the slots and probe each region at the position the body
 * had **when that region locked** — see `particles/ParticleSystem.js`, which
 * does exactly that with `timeRegionFalloff` and `timeRegionClock`.
 *
 * ## Editing this file
 *
 * No backticks in the GLSL comments below: the source is one template literal
 * and a stray backtick ends it, reporting as a JS syntax error pointing into
 * the middle of a shader. Reserved words to stay away from while you are in
 * here: `packed`, `flat`, `sample`, `filter`, `input`, `output`. Uniform arrays
 * may be indexed **only by a loop counter**, which is why both loops below run
 * to the compile-time constant and break on the live count rather than looping
 * to the live count directly.
 */
export const timeWarpGLSL = /* glsl */ `
#ifndef TIMEWARP_LIB_INCLUDED
#define TIMEWARP_LIB_INCLUDED

#define MAX_TIME_REGIONS ${MAX_TIME_REGIONS}

uniform float uTimeRegionCount;
uniform vec4  uTimeRegion[MAX_TIME_REGIONS];      // xyz centre (m), w outer radius (m)
uniform vec4  uTimeRegionWarp[MAX_TIME_REGIONS];  // x strength, y inner/outer, z hold (s), w rate

/*
 * How strongly one region holds a point. 0 outside, strength at the core.
 *
 * Both vec4s arrive as parameters rather than being fetched in here, because a
 * function cannot index a uniform array by its own argument in ESSL 1.00 — the
 * caller has to be a loop, and the loop has to do the fetch.
 *
 * The inner radius is pushed a millimetre below the outer one before the
 * smoothstep sees it. smoothstep(a, a, x) divides by zero, and a feather of
 * exactly 1 with a small radius lands there.
 */
float timeRegionFalloff(vec3 worldPos, vec4 region, vec4 warp) {
  float outer = max(region.w, 1e-4);
  float inner = min(clamp(warp.y, 0.0, 1.0) * outer, outer - 1e-3);
  float d = distance(worldPos, region.xyz);
  return clamp(warp.x, 0.0, 1.0) * (1.0 - smoothstep(inner, outer, d));
}

/*
 * Bend one clock by one region. Identity at weight 0 and at rate 1.
 * warp.z is the hold instant, warp.w the rate.
 */
float timeRegionClock(float clock, vec4 warp, float weight) {
  return mix(clock, warp.z + (clock - warp.z) * warp.w, weight);
}

/*
 * The clock a point at worldPos lives on. Only valid where the position does
 * not itself depend on the answer — see the header.
 */
float warpedTime(float clock, vec3 worldPos) {
  if (uTimeRegionCount < 0.5) return clock;
  float bent = clock;
  for (int i = 0; i < MAX_TIME_REGIONS; i++) {
    if (float(i) >= uTimeRegionCount) break;
    vec4 region = uTimeRegion[i];
    vec4 warp = uTimeRegionWarp[i];
    bent = timeRegionClock(bent, warp, timeRegionFalloff(worldPos, region, warp));
  }
  return bent;
}

/*
 * How held a point is, 0..1, strongest region wins.
 *
 * This is what lets a stasis field be seen at all. The ability draws almost
 * nothing; every other shader in the frame can desaturate, add a pale rim, or
 * kill its own flicker by this number, and the bubble appears as an absence of
 * motion with an edge you can find.
 */
float timeRegionWeight(vec3 worldPos) {
  if (uTimeRegionCount < 0.5) return 0.0;
  float held = 0.0;
  for (int i = 0; i < MAX_TIME_REGIONS; i++) {
    if (float(i) >= uTimeRegionCount) break;
    held = max(held, timeRegionFalloff(worldPos, uTimeRegion[i], uTimeRegionWarp[i]));
  }
  return held;
}

#endif
`;
