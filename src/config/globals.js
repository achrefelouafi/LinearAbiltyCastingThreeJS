/**
 * globals.js — the master multipliers, extracted so the load order works.
 *
 * This is `settings.global`, and it is *the same object*: `config/settings.js`
 * writes `global: globals` rather than re-declaring the block, so the editor,
 * the presets and every consumer below still mutate one identity. Nothing about
 * the shape changed when it moved.
 *
 * ## Why it is its own file
 *
 * The same reason `config/castShape.js` is: an import cycle that has to be
 * broken *outside* `settings.js` rather than inside it.
 *
 * `vfx/Shell.js` and `vfx/Tube.js` want `settings.global` as the default third
 * argument to `sync()`. Meanwhile an ability's settings module is entitled to
 * spread `shellDefaults(…)` / `tubeDefaults(…)` into its own block — the tech
 * library documents that as the intended usage, and eight of the fifty do it.
 * Put those two facts together and the module graph closes a loop:
 *
 * ```
 * config/abilities/index.js → abilities/thunderclap.js → vfx/Shell.js
 *                           → config/settings.js → config/abilities/index.js
 * ```
 *
 * That loop is fatal, not merely ugly. Whichever of `registry.js` /
 * `settings.js` / `abilities/index.js` is imported first, one of them ends up
 * running its body while another is still resolving dependencies, and the
 * symptom is a bare `ReferenceError: Cannot access 'ABILITY_SETTINGS' before
 * initialization` thrown from a line that has been correct for months. It was
 * diagnosed the hard way; the fix is that the two modules a *settings* module
 * may transitively pull in must not reach back to `settings.js`.
 *
 * So this file imports **nothing**. It is a leaf, and it can be depended on
 * from anywhere without closing anything.
 *
 * `vfx/Distortion.js` still imports `config/settings.js` and is fine, because
 * it also needs `settings.post` and no settings module imports it. If one ever
 * does, the same treatment applies to `post`.
 */

/**
 * Multipliers that scale everything at once. `1` is neutral for every one of
 * them, which is what makes a preset diff readable.
 */
export const globals = {
  timeScale: 1.0, // slow-mo / fast forward for the whole simulation
  speed: 1.0, // eruption travel speed multiplier
  lifetime: 1.0, // ability lifetime multiplier
  glow: 1.0, // emissive multiplier fed into bloom
  shaderIntensity: 1.0, // master strength of every procedural shader effect
  noiseStrength: 1.0,
  noiseFrequency: 1.0,
  noiseSpeed: 1.0,
  turbulence: 1.0,
  randomness: 1.0, // per-instance / per-particle jitter multiplier
  particleCount: 1.0,
  particleLifetime: 1.0,
  particleSpeed: 1.0,
  particleSize: 1.0,
  emissionRate: 1.0,
  lightIntensity: 1.0,
  lightRadius: 1.0,
  distortion: 1.0,
  fresnel: 1.0,
  opacity: 1.0,
  animationSpeed: 1.0, // character animation playback rate
  cameraShake: 1.0,
  explosionIntensity: 1.0
};
