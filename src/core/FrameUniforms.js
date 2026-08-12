import { Vector2, Vector3, Vector4 } from 'three';

/* ---------------------------------------------------------------- */
/* Time regions — the shared clock-bending field                     */
/* ---------------------------------------------------------------- */

/**
 * How many regions may bend the world's clock at once.
 *
 * Four, and the number is a compromise rather than a limit anybody hit. Every
 * shader that opts into the field pays `2 × MAX_TIME_REGIONS` vec4s of its
 * uniform budget whether or not a region is live — GLSL ES 1.00 guarantees only
 * 128 vec4 vertex uniform vectors, and the particle shader is not the only
 * thing that wants a share of them. Eight regions would be sixteen vec4s, an
 * eighth of the guaranteed budget, to serve a case that does not exist: the
 * ability manager caps at four concurrent casts and no single cast has ever
 * wanted two.
 *
 * The pool lives in `vfx/TimeControl.js`. The boxes live here, holding nothing
 * but zeroes, so that `core/` and `particles/` can read the field without
 * importing a VFX module and dragging its shader source into the boot bundle —
 * the same argument that put `distortionWriters` in `core/Layers.js`.
 *
 * **With no chrono ability standing, `uTimeRegionCount` is 0 and every consumer
 * costs one float compare.** Nothing else in this file has to know they exist.
 */
export const MAX_TIME_REGIONS = 4;

/** xyz = centre in world metres, w = outer radius in metres. */
const timeRegions = [];
/** x = strength 0..1, y = inner radius as a fraction of w, z = hold (s), w = rate. */
const timeRegionWarps = [];
for (let i = 0; i < MAX_TIME_REGIONS; i++) {
  timeRegions.push(new Vector4(0, 0, 0, 0));
  // rate 1 and strength 0 are both identity; a slot that was never claimed
  // must not bend anything even if a consumer reads past `uTimeRegionCount`.
  timeRegionWarps.push(new Vector4(0, 0, 0, 1));
}

/**
 * Uniform objects shared by *every* custom material, by identity.
 *
 * Because three.js stores uniforms as `{ value }` boxes, handing the same box to
 * many materials means one write per frame updates all of them. That keeps the
 * per-frame CPU work for dozens of VFX materials down to a handful of
 * assignments instead of a traversal.
 */
export const frame = {
  uTime: { value: 0 },
  uDelta: { value: 0 },
  uResolution: { value: new Vector2(1, 1) },
  /** Packed-RGBA depth of the opaque scene — drives soft particles. */
  uSceneDepth: { value: null },
  uCameraNear: { value: 0.1 },
  uCameraFar: { value: 400 },
  /** Equirectangular HDR used for cheap reflections in custom shaders. */
  uEnvMap: { value: null },
  /**
   * World-space direction *toward* the sun, mirrored from the environment.
   * Custom shaders that fake a normal — ground snow, rubble — need the same key
   * direction the lit meshes are using or the fake reads as a sticker.
   */
  uLightDir: { value: new Vector3(0.45, 0.78, 0.44).normalize() },
  /** Global multipliers mirrored from settings so shaders can read them. */
  uShaderIntensity: { value: 1 },
  uGlobalGlow: { value: 1 },

  /**
   * How many slots of the two arrays below are live. **Zero unless a chrono
   * ability is standing**, which is the whole cost model: every consumer of the
   * field opens with `if (uTimeRegionCount < 0.5) return clock;`.
   *
   * A float rather than an int because the loops that read the arrays compare
   * `float(i)` against it, and mixing an int uniform into a float compare has
   * cost people a driver-specific compile before.
   */
  uTimeRegionCount: { value: 0 },
  /** xyz = centre (world metres), w = outer radius (metres). */
  uTimeRegion: { value: timeRegions },
  /** x = strength 0..1, y = inner radius / outer, z = hold (s), w = rate. */
  uTimeRegionWarp: { value: timeRegionWarps }
};

/**
 * Convenience: the uniform block every VFX material wants.
 *
 * The three `uTimeRegion*` boxes are in here rather than in a separate helper
 * so that a material opts into the time field by **declaring the uniforms in
 * its shader**, and by nothing else. three.js only uploads uniforms the
 * compiled program actually declares, so a material that never injects
 * `timeWarpGLSL` carries three unread references and uploads nothing.
 */
export function sharedUniforms(extra = {}) {
  return {
    uTime: frame.uTime,
    uResolution: frame.uResolution,
    uSceneDepth: frame.uSceneDepth,
    uCameraNear: frame.uCameraNear,
    uCameraFar: frame.uCameraFar,
    uLightDir: frame.uLightDir,
    uShaderIntensity: frame.uShaderIntensity,
    uGlobalGlow: frame.uGlobalGlow,
    uTimeRegionCount: frame.uTimeRegionCount,
    uTimeRegion: frame.uTimeRegion,
    uTimeRegionWarp: frame.uTimeRegionWarp,
    ...extra
  };
}
