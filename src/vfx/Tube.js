import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
  Vector3
} from 'three';
import { createBeamTubeGeometry } from '../assets/ProceduralGeometry.js';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms, frame } from '../core/FrameUniforms.js';
import { LAYER } from '../core/Layers.js';
import { globals } from '../config/globals.js';
import { getColor } from '../utils/color.js';
import { num, str, prefixed, buildKeys, buildDefaults, auditBlock } from './prefixedBlock.js';
// From the leaf, NOT from `./SceneHooks.js`, and the distinction is load-
// bearing rather than tidy. `SceneHooks` imports `config/settings.js`; settings
// imports every ability block; six ability blocks (`firewhip`, `geyser`,
// `railcoil`, `cyclone`, …) import *this* file for `tubeDefaults()`. Importing
// the field from `SceneHooks` therefore closes a ring —
// settings → abilities/index → firewhip → Tube → SceneHooks → settings — and a
// ring that reads a `const` across itself throws or does not depending purely
// on which module you enter the graph from. It survived `main.js` and killed
// `import('src/abilities/registry.js')` stone dead, with a `ReferenceError`
// naming `ABILITY_SETTINGS`, from a file nowhere near the change. `hookFields`
// imports one class from three and nothing else, so there is no ring to be
// lucky about. See its header.
import { disruptGLSL, disruptUniforms } from './hookFields.js';
import { clamp, saturate, smoothstep } from '../utils/math.js';

/**
 * `vfx/Tube.js` — the parametric tube, generalised.
 *
 * ## What it draws
 *
 * One `(t, a)` grid — `assets/ProceduralGeometry.js#createBeamTubeGeometry`, the
 * same one Nova Beam is drawn on — placed in world space by a vertex shader and
 * drawn **three times at three radii**. Nothing about the shape touches the CPU,
 * so a tube of any length, any profile and any path costs the same.
 *
 * ## Draw-call cost
 *
 * **3**, always, whatever the path mode and however long the column is. If an
 * ability wants coils, discs or a charge orb on it, those are `FilamentPaths`
 * and `Shell` — this module deliberately stops at the column so the count stays
 * a number you can hold in your head.
 *
 * ## The three layers, and why the middle one is inverted
 *
 * This is lifted wholesale from `materials/BeamMaterial.js`, because it is the
 * single best idea in that file and re-deriving it badly in a second place would
 * be a waste:
 *
 *   HALO   — widest, nothing but a rim term. The atmosphere the tube is shoving.
 *   SHEATH — rim-weighted, so it reads as *hollow* and its silhouette edges are
 *            the brightest part of it.
 *   CORE   — narrow, and weighted the **opposite** way: brightest where the view
 *            ray runs down the barrel and its path through the tube is longest.
 *
 * Rim-weighted outside, axis-weighted inside, both faces adding: that is a
 * volume integral, cheaply, and the inversion is the entire reason the middle
 * reads as a solid rod rather than as a lit pipe. Widen `coreWidth` or push
 * `coreFill` and the three collapse into one white tube — the sheath is only
 * legible because the core leaves it room. (`SHELL` was renamed `SHEATH` here
 * only so it does not collide with the sibling module `vfx/Shell.js`.)
 *
 * ## The one rule for using it well
 *
 * **Place everything else against `radiusAt()` and `pointAt()`, never against
 * your own copy of the numbers.** Those two functions are the JS mirror of the
 * `tubeRadius()` / `tubeAxis()` pair the vertex shader uses, and they are what
 * keeps a dust skirt, a debris ribbon and a ground scour welded to the column
 * when the profile is dragged — mid-cast, with the clock stopped. A funnel whose
 * skirt was sized from `settings.x.tubeThroat * 3` at spawn is a funnel that
 * comes apart the first time somebody touches a slider.
 *
 * The mirror is a deliberate duplication. The alternative — reading the tube's
 * shape back off the GPU — is a pipeline stall per query, and the queries happen
 * several times a frame. What is *not* mirrored is the `wander` noise: the JS
 * side returns the **mean** axis, because a skirt placed on the noisy axis
 * jitters against the tube it is supposed to hug, and the wobble is centimetres.
 *
 * ## Path modes
 *
 * | mode | what it is |
 * | --- | --- |
 * | `STRAIGHT` | the beam. A chord from origin to target with a smooth drift on it. |
 * | `WHIP`     | a curvature wave travelling handle → tip. See below. |
 * | `FUNNEL`   | a vortex: tight throat, flared skirt at the floor, flared mouth at the top. |
 * | `VINE`     | grows. The front *is* the length; the radius tapers to nothing at the tip; it can recoil on a spring. |
 * | `ARC`      | a bow, with the apex anywhere along the chord. |
 *
 * ### WHIP, and why the crack is not on a timer
 *
 * A bullwhip cracks because the loop travelling down it carries a fixed amount
 * of energy through a decreasing mass per length, so the loop tightens and
 * accelerates; when it reaches the tip the tip briefly goes supersonic. Two
 * terms reproduce that here, and both of them are in the geometry:
 *
 *  1. **the lobe** — a Gaussian bump of lateral offset centred on `wavePhase`,
 *     whose amplitude grows as the phase approaches the tip (`waveGain`);
 *  2. **arc-length conservation** — a whip does not stretch, so the length the
 *     lobe eats has to come out of the axial extent. To first order that excess
 *     is `½∫(dy/ds)² ds`, which for a Gaussian has the closed form
 *     `½·√(π/2)·A²/w ≈ 0.6267·A²/w`, distributed along the whip by the
 *     cumulative of the same bump.
 *
 * So while the loop is mid-whip the tip is pulled *back*, and as the loop runs
 * off the end the lateral offset collapses and the axial extent returns — both
 * at once. That is a speed spike, and it is a property of the curve rather than
 * of a clock.
 *
 * `tipSpeed` is that curve differentiated with respect to its own driver
 * (central difference on the wave phase, times the phase rate), so it is correct
 * on a **zero-length frame** — pause the sandbox and drag `tubeWaveWidth` and
 * the reported speed changes, because the shape did. `waveSpeed` is the speed
 * the loop itself travels at, `length × waveRate`. When the first crosses the
 * second times `crackRatio`, `tube.crack.fired` is true for exactly that frame
 * and `tube.crack.point` is where the tip was standing. Fire the shock ring
 * there. Do not schedule it.
 *
 * ### FUNNEL, and the one function
 *
 * `radiusAt(t)` *is* the vortex profile: `throat + skirt(t) + mouth(t)`, where
 * the skirt is a falling power near the floor and the mouth is a rising one near
 * the top. The debris ribbons, the dust skirt and the ground scour all read it,
 * so dragging `tubeSkirtFlare` moves every one of them together. The first
 * version of this had the skirt as its own slider on the ability and the scour
 * as another; they were never the same number twice.
 *
 * ## What it reads from settings
 *
 * Everything in `tubeDefaults()`, by prefixed key, off whatever object is handed
 * to `sync()` — plus `settings.global` for the master multipliers. Spread
 * `tubeDefaults()` into the ability's settings block and `tubeSchema()` into its
 * editor schema and every control below is a slider for free. Nothing is
 * captured: `sync()` re-reads all of it every frame.
 */

/* ---------------------------------------------------------------- */
/* Enums                                                             */
/* ---------------------------------------------------------------- */

/** Which parametric path the column is threaded along. Compile-time. */
export const TubePath = Object.freeze({
  STRAIGHT: 0, // a chord — the beam
  WHIP: 1, // a curvature wave running handle → tip
  FUNNEL: 2, // a vortex profile standing on the floor
  VINE: 3, // grows from the base, tapers to nothing, recoils on a spring
  ARC: 4 // a bow with a placeable apex
});

/** Which of the three concentric layers a material is. Compile-time. */
export const TubeLayer = Object.freeze({
  CORE: 0, // the axis-weighted rod
  SHEATH: 1, // the rim-weighted hollow around it
  HALO: 2 // the wide rim-only bloom
});

/** Enum → name, for the editor dropdown and for readable diagnostics. */
export const TUBE_PATH_NAMES = Object.freeze(['STRAIGHT', 'WHIP', 'FUNNEL', 'VINE', 'ARC']);
const PATH_NAMES = TUBE_PATH_NAMES;

const TAU = Math.PI * 2;

/**
 * Half the closed-form slope energy of a unit Gaussian lobe, `½·√(π/2)`.
 * See the header: this is the length the whip's loop eats.
 */
const WHIP_EATEN = 0.6266570686577501;

/* ---------------------------------------------------------------- */
/* The settings contract                                             */
/* ---------------------------------------------------------------- */

/**
 * Every value the tube reads, unprefixed, with its default and its unit.
 *
 * An ability spreads `tubeDefaults()` into its own settings block, so these
 * become `tubeRadius`, `tubeFlare`… and appear in the editor like anything else
 * it owns. Flat and prefixed rather than nested because the editor's schema
 * walker works on flat keys, and because two tubes on one ability (a parent beam
 * and its children) then simply take two prefixes.
 */
const TUBE_FIELDS = {
  /* --- the radius profile (STRAIGHT / WHIP / ARC) --- */
  radius: 0.62, // half-width at the far end, metres
  radiusNear: 0.22, // half-width at the muzzle, metres
  radiusCurve: 0.7, // <1 opens early, >1 stays thin then opens late
  flare: 0.9, // extra half-width where it lands, × radius
  flareWidth: 0.22, // how much of the far end flares, fraction of length
  throb: 0.06, // breathing amplitude, × radius
  throbScale: 2.4, // pressure waves along the column, cycles per length
  throbSpeed: 1.6, // Hz they travel at

  /* --- the axis --- */
  wander: 0.06, // smooth low-frequency drift of the axis, metres
  wanderScale: 0.9, // drift features per length
  wanderSpeed: 0.7, // Hz the drift crawls at

  /* --- the surface --- */
  ripple: 0.12, // radial break-up of the barrel, × radius
  rippleBands: 1.6, // break-up features around the barrel
  rippleScale: 3.2, // break-up features along it
  rippleSpeed: 2.4, // Hz it crawls downrange at
  streak: 0.9, // filaments streaming down the surface
  streakSharp: 0.45, // 0 = soft wash, 1 = hard threads
  streakScale: 5.5, // filament features per length
  streakBands: 2.6, // filament features around the barrel
  streakGlow: 1.1, // how hard the sheath's filaments burn to core colour
  flowSpeed: 7.0, // metres-of-parameter per second the filaments run
  bands: 0.0, // rings along the length, cycles per length (0 = off)
  bandSharp: 2.0, // how tight each ring is
  bandDepth: 0.5, // how much they modulate alpha, 0..1
  bandSpeed: 0.6, // Hz they travel at

  /* --- the three layers --- */
  coreWidth: 0.38, // core radius, × the profile
  coreFill: 0.85, // how solid the core reads
  coreSharp: 1.4, // axis-weighting exponent — the inversion
  edgePower: 2.2, // rim-weighting exponent for the sheath
  sheathWidth: 1.0, // sheath radius, × the profile
  sheathRim: 0.9, // strength of the sheath's silhouette
  sheathFill: 0.18, // how much body the sheath keeps
  sheathOpacity: 0.9,
  haloWidth: 1.9, // halo radius, × the profile
  haloRim: 3.4, // rim exponent — high, so it is only a silhouette
  haloOpacity: 0.5,

  /* --- the ends --- */
  muzzleGlow: 1.5, // brightness where the column leaves the caster
  muzzleLength: 0.1, // how far that glow reaches, fraction of length
  tipGlow: 1.6, // brightness of the leading edge
  tipLength: 0.06, // how soft that edge is, fraction of length

  /* --- WHIP --- */
  waveRate: 1.35, // loops per second travelling handle → tip
  waveWidth: 0.16, // how tight the loop is, fraction of length
  waveAmp: 0.3, // lateral throw of the loop, fraction of length
  waveGain: 2.2, // how much the loop grows on its way to the tip, ×
  waveCurve: 1.6, // when that growth happens, >1 = late
  waveRoll: 0.0, // plane the loop cracks in, radians (0 = vertical)
  sag: 0.12, // how far the whip hangs under its own weight, metres
  crackRatio: 1.0, // tip speed ÷ wave speed at which the crack fires

  /* --- FUNNEL --- */
  throat: 0.55, // the vortex waist, metres
  skirtFlare: 1.6, // extra radius at the floor, metres
  skirtHeight: 0.24, // how far up the skirt reaches, fraction of height
  skirtCurve: 1.7, // how abruptly it flares, >1 = tighter to the floor
  mouthFlare: 2.4, // extra radius at the top, metres
  mouthStart: 0.55, // where the mouth begins to open, fraction of height
  mouthCurve: 1.4, // how abruptly it opens
  spin: 0.9, // revolutions per second the surface rotates
  spinTwist: 1.6, // extra revolutions from floor to mouth
  sway: 0.35, // how far the axis precesses, metres
  swayScale: 0.5, // twist of the precession along the height
  swaySpeed: 0.25, // revolutions per second it precesses
  swayCurve: 1.8, // how much of the sway is at the top, >1 = only the top

  /* --- VINE --- */
  tipTaper: 1.3, // how fast the radius falls to zero at the front
  meander: 0.18, // helical wander of the stem, metres
  meanderTurns: 1.4, // turns of that helix over the length
  recoilAmp: 0.35, // how far the spring pulls the tip back, fraction
  recoilFreq: 2.6, // Hz the spring rings at
  recoilDamp: 3.4, // s⁻¹ it dies at
  recoilSway: 0.6, // lateral bow while it is recoiling, metres

  /* --- ARC --- */
  arcHeight: 2.6, // apex height above the chord, metres
  arcLateral: 0.0, // apex offset across the chord, metres
  arcBias: 0.5, // where the apex sits, 0..1 along the chord
  arcCurve: 1.0, // >1 pinches the apex, <1 flattens the top

  /* --- rendering --- */
  opacity: 1.0,
  glow: 2.2, // emissive gain into bloom
  softFade: 0.6, // metres of depth fade against the opaque scene

  /* --- colour (I5: four pickers, none derived from another) --- */
  colorCore: '#ffffff', // the axis-weighted middle
  colorInner: '#d2f5ff', // just off the middle
  colorOuter: '#4ac7ff', // the sheath body
  colorHalo: '#0d33d9' // the outer bloom
};

const FIELD_NAMES = Object.freeze(Object.keys(TUBE_FIELDS));

/**
 * Per-path tuning, applied on top of the field defaults.
 *
 * The same numbers do not suit a vortex and a bullwhip: a funnel with a 0.9
 * flare has a bell on the end of it, and a whip with the beam's 0.06 wander
 * shimmers along its whole length instead of hanging still between cracks.
 * These are starting points, not constraints — every one of them is a slider
 * the moment the ability spreads the block.
 */
const PATH_DEFAULTS = {
  [TubePath.WHIP]: {
    radius: 0.16, radiusNear: 0.09, radiusCurve: 1.6, flare: 0, flareWidth: 0.1,
    wander: 0.02, streakScale: 9, glow: 2.6, tipGlow: 2.4, tipLength: 0.04
  },
  [TubePath.FUNNEL]: {
    flare: 0, flareWidth: 0.1, throb: 0.03, wander: 0.05,
    rippleScale: 2.2, streakScale: 2.6, flowSpeed: -2.5, streakSharp: 0.6,
    coreWidth: 0.94, coreFill: 0.2, sheathWidth: 1.0, haloWidth: 1.22,
    haloRim: 2.2, glow: 1.2
  },
  [TubePath.VINE]: {
    radius: 0.22, throb: 0.02, wander: 0.03, ripple: 0.25, streak: 0.35,
    bands: 7, bandDepth: 0.45, coreWidth: 0.55, coreFill: 0.5,
    haloWidth: 1.5, haloRim: 2.6, glow: 1.1
  },
  [TubePath.ARC]: { flare: 0.3, flareWidth: 0.3 }
};


/**
 * A fresh settings fragment for one tube. Spread into an ability's block.
 *
 * ```js
 * export const firewhip = { range: 16, ..., ...tubeDefaults() };
 * ```
 *
 * @param {string} [prefix] key prefix — take a second one for a second tube
 * @param {number} [path] TubePath.*, which picks the per-path tuning above
 * @param {object} [overrides] **prefixed** overrides, e.g. `{ lashRadius: 0.2 }`,
 *                 so they read the way the ability will read them
 */
export function tubeDefaults(prefix = 'tube', path = TubePath.STRAIGHT, overrides = {}) {
  return buildDefaults(FIELD_NAMES, TUBE_FIELDS, PATH_DEFAULTS[path] ?? {}, prefix, overrides);
}

/**
 * The unprefixed → prefixed key map, built once so `sync()` never concatenates
 * a string on a frame.
 */
export function tubeKeys(prefix = 'tube') {
  return buildKeys(FIELD_NAMES, prefix);
}

/** Editor folders for one tube. Spread into an ability's schema. */
export function tubeSchema(prefix = 'tube', path = TubePath.STRAIGHT) {
  const k = (name) => prefixed(prefix, name);
  const schema = {
    'The column': [
      [k('radius'), 0.01, 4, 0.01, 'far radius (m)'],
      [k('radiusNear'), 0.01, 4, 0.01, 'near radius (m)'],
      [k('radiusCurve'), 0.05, 4, 0.01, 'radius curve'],
      [k('flare'), 0, 4, 0.01, 'flare'],
      [k('flareWidth'), 0.01, 1, 0.01, 'flare width'],
      [k('throb'), 0, 0.5, 0.001, 'throb'],
      [k('throbScale'), 0, 12, 0.1, 'throb bands'],
      [k('throbSpeed'), 0, 8, 0.01, 'throb Hz'],
      [k('wander'), 0, 1, 0.001, 'axis drift (m)'],
      [k('wanderScale'), 0, 6, 0.01, 'drift scale'],
      [k('wanderSpeed'), 0, 4, 0.01, 'drift Hz']
    ],
    'Core / sheath / halo': [
      [k('coreWidth'), 0.02, 2, 0.01, 'core width'],
      [k('coreFill'), 0, 2, 0.01, 'core fill'],
      [k('coreSharp'), 0.05, 8, 0.01, 'core axis power'],
      [k('edgePower'), 0.05, 8, 0.01, 'sheath rim power'],
      [k('sheathWidth'), 0.05, 3, 0.01, 'sheath width'],
      [k('sheathRim'), 0, 2, 0.01, 'sheath rim'],
      [k('sheathFill'), 0, 1, 0.01, 'sheath fill'],
      [k('sheathOpacity'), 0, 1, 0.01, 'sheath opacity'],
      [k('haloWidth'), 0.05, 6, 0.01, 'halo width'],
      [k('haloRim'), 0.05, 10, 0.01, 'halo rim power'],
      [k('haloOpacity'), 0, 1, 0.01, 'halo opacity']
    ],
    'The surface': [
      [k('ripple'), 0, 1, 0.01, 'ripple'],
      [k('rippleBands'), 0, 8, 0.01, 'ripple bands'],
      [k('rippleScale'), 0, 12, 0.01, 'ripple scale'],
      [k('rippleSpeed'), 0, 10, 0.01, 'ripple Hz'],
      [k('streak'), 0, 2, 0.01, 'streaks'],
      [k('streakSharp'), 0, 1, 0.01, 'streak sharpness'],
      [k('streakScale'), 0, 20, 0.1, 'streak scale'],
      [k('streakBands'), 0, 8, 0.01, 'streak bands'],
      [k('streakGlow'), 0, 3, 0.01, 'streak glow'],
      [k('flowSpeed'), 0, 24, 0.1, 'flow speed'],
      [k('bands'), 0, 24, 0.1, 'rings/length'],
      [k('bandSharp'), 0.05, 8, 0.01, 'ring sharpness'],
      [k('bandDepth'), 0, 1, 0.01, 'ring depth'],
      [k('bandSpeed'), -6, 6, 0.01, 'ring Hz']
    ],
    'The ends': [
      [k('muzzleGlow'), 0, 5, 0.01, 'muzzle glow'],
      [k('muzzleLength'), 0, 0.6, 0.001, 'muzzle length'],
      [k('tipGlow'), 0, 5, 0.01, 'tip glow'],
      [k('tipLength'), 0.001, 0.4, 0.001, 'tip length']
    ],
    'Tube colour & render': [
      k('colorCore'),
      k('colorInner'),
      k('colorOuter'),
      k('colorHalo'),
      [k('opacity'), 0, 1, 0.01, 'opacity'],
      [k('glow'), 0, 8, 0.01, 'glow'],
      [k('softFade'), 0, 3, 0.01, 'soft fade (m)']
    ]
  };

  if (path === TubePath.WHIP) {
    schema['The whip'] = [
      [k('waveRate'), 0, 6, 0.01, 'loops/second'],
      [k('waveWidth'), 0.02, 0.6, 0.001, 'loop width'],
      [k('waveAmp'), 0, 1, 0.001, 'loop throw'],
      [k('waveGain'), 0.2, 6, 0.01, 'loop gain'],
      [k('waveCurve'), 0.1, 6, 0.01, 'gain curve'],
      [k('waveRoll'), 0, TAU, 0.01, 'crack plane (rad)'],
      [k('sag'), 0, 2, 0.01, 'sag (m)'],
      [k('crackRatio'), 0.2, 4, 0.01, 'crack ratio']
    ];
  }
  if (path === TubePath.FUNNEL) {
    schema['The vortex'] = [
      [k('throat'), 0.02, 4, 0.01, 'throat (m)'],
      [k('skirtFlare'), 0, 8, 0.01, 'skirt flare (m)'],
      [k('skirtHeight'), 0.01, 1, 0.01, 'skirt height'],
      [k('skirtCurve'), 0.1, 6, 0.01, 'skirt curve'],
      [k('mouthFlare'), 0, 12, 0.01, 'mouth flare (m)'],
      [k('mouthStart'), 0, 0.99, 0.01, 'mouth start'],
      [k('mouthCurve'), 0.1, 6, 0.01, 'mouth curve'],
      [k('spin'), -6, 6, 0.01, 'spin (rev/s)'],
      [k('spinTwist'), -8, 8, 0.01, 'twist'],
      [k('sway'), 0, 4, 0.01, 'precession (m)'],
      [k('swayScale'), 0, 3, 0.01, 'precession twist'],
      [k('swaySpeed'), -3, 3, 0.01, 'precession (rev/s)'],
      [k('swayCurve'), 0.1, 6, 0.01, 'precession curve']
    ];
  }
  if (path === TubePath.VINE) {
    schema['The vine'] = [
      [k('tipTaper'), 0.05, 6, 0.01, 'tip taper'],
      [k('meander'), 0, 2, 0.01, 'meander (m)'],
      [k('meanderTurns'), 0, 8, 0.01, 'meander turns'],
      [k('recoilAmp'), 0, 1, 0.01, 'recoil'],
      [k('recoilFreq'), 0, 10, 0.01, 'recoil Hz'],
      [k('recoilDamp'), 0.1, 16, 0.01, 'recoil damping'],
      [k('recoilSway'), 0, 4, 0.01, 'recoil bow (m)']
    ];
  }
  if (path === TubePath.ARC) {
    schema['The arc'] = [
      [k('arcHeight'), -12, 12, 0.01, 'apex height (m)'],
      [k('arcLateral'), -12, 12, 0.01, 'apex offset (m)'],
      [k('arcBias'), 0.05, 0.95, 0.01, 'apex position'],
      [k('arcCurve'), 0.1, 4, 0.01, 'apex curve']
    ];
  }
  return schema;
}

/* ---------------------------------------------------------------- */
/* GLSL                                                              */
/* ---------------------------------------------------------------- */

const TUBE_UNIFORMS = /* glsl */ `
  #define PI  3.141592653589793
  #define TAU 6.283185307179586

  #define PATH_STRAIGHT 0
  #define PATH_WHIP     1
  #define PATH_FUNNEL   2
  #define PATH_VINE     3
  #define PATH_ARC      4

  uniform float uTime;
  uniform vec3  uOrigin;
  uniform vec3  uTarget;
  uniform vec3  uSide;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uFade;
  uniform float uWidthFade;

  uniform float uRadius;
  uniform float uRadiusNear;
  uniform float uRadiusCurve;
  uniform float uRadiusScale;
  uniform float uFlare;
  uniform float uFlareWidth;
  uniform float uThrob;
  uniform float uThrobScale;
  uniform float uThrobSpeed;

  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;

  uniform float uWavePhase;
  uniform float uWaveWidth;
  uniform float uWaveAmp;
  uniform float uWaveGain;
  uniform float uWaveCurve;
  uniform float uWaveRoll;
  uniform float uSag;

  uniform float uThroat;
  uniform float uSkirtFlare;
  uniform float uSkirtHeight;
  uniform float uSkirtCurve;
  uniform float uMouthFlare;
  uniform float uMouthStart;
  uniform float uMouthCurve;
  uniform float uSpin;
  uniform float uSpinTwist;
  uniform float uSway;
  uniform float uSwayScale;
  uniform float uSwaySpeed;
  uniform float uSwayCurve;

  uniform float uGrow;
  uniform float uTipTaper;
  uniform float uMeander;
  uniform float uMeanderTurns;
  uniform float uRecoil;
  uniform float uRecoilSway;

  uniform float uArcHeight;
  uniform float uArcLateral;
  uniform float uArcBias;
  uniform float uArcCurve;

  uniform float uRipple;
  uniform float uRippleBands;
  uniform float uRippleScale;
  uniform float uRippleSpeed;
  uniform float uStreak;
  uniform float uStreakSharp;
  uniform float uStreakScale;
  uniform float uStreakBands;
  uniform float uStreakGlow;
  uniform float uFlowSpeed;
  uniform float uBands;
  uniform float uBandSharp;
  uniform float uBandDepth;
  uniform float uBandSpeed;

  uniform float uCoreSharp;
  uniform float uCoreFill;
  uniform float uEdgePower;
  uniform float uSheathRim;
  uniform float uSheathFill;
  uniform float uHaloRim;
  uniform float uLayerOpacity;

  uniform float uMuzzleGlow;
  uniform float uMuzzleLength;
  uniform float uTipGlow;
  uniform float uTipLength;

  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorHalo;
`;

const TUBE_VARYINGS = /* glsl */ `
  varying float vT;
  varying float vSpin;
  varying float vFacing;
  varying float vViewZ;
  varying float vDisrupt;   // spellbreak's field, sampled per vertex — see SceneHooks
`;

/**
 * The shape. Every layer, and every consumer on the JS side, is built out of
 * exactly these two functions — see `Tube#radiusAt` / `Tube#pointAt` for the
 * mirror, and the module header for why the duplication is deliberate.
 */
const TUBE_SHAPE = /* glsl */ `
  /**
   * Half-width of the column at t, metres.
   *
   * Three profiles, one signature. FUNNEL is a real vortex — a tight waist with
   * a skirt flaring to the floor and a mouth flaring to the top — rather than a
   * cone, because a cone has no throat and a vortex is *all* throat.
   */
  float tubeRadius(float t) {
    float u = clamp(t, 0.0, 1.0);
    float r;

    #if TUBE_PATH == PATH_FUNNEL
      float skirt = uSkirtFlare *
        pow(1.0 - smoothstep(0.0, max(uSkirtHeight, 1e-3), u), max(uSkirtCurve, 0.05));
      float mouth = uMouthFlare *
        pow(smoothstep(min(uMouthStart, 0.99), 1.0, u), max(uMouthCurve, 0.05));
      r = uThroat + skirt + mouth;

    #elif TUBE_PATH == PATH_VINE
      // The front is the length, so t is renormalised against it and the taper
      // is measured from the *growing* tip rather than from the far end.
      float s = clamp(u / max(uGrow, 1e-3), 0.0, 1.0);
      r = uRadius * pow(1.0 - s, max(uTipTaper, 0.01));

    #else
      r = mix(uRadiusNear, uRadius, pow(u, max(uRadiusCurve, 0.01)));
      r *= 1.0 + uFlare * smoothstep(1.0 - max(uFlareWidth, 1e-3), 1.0, u);
    #endif

    // Pressure waves travelling along it. Small — this is breathing, not a
    // sausage.
    r *= 1.0 + uThrob * sin((u * uThrobScale - uTime * uThrobSpeed) * TAU);
    return max(r * uRadiusScale * uWidthFade, 1e-4);
  }

  /**
   * The column's frames.
   *
   * Two of them, and they are not the same thing. n1/n2 span the *cross
   * section* and come from uSide by Gram-Schmidt, exactly as the beam does it,
   * so the seam in the angular noise stays put as the axis tilts. upN/sideN
   * are the *bending* frame: an honest up and an honest sideways, so a whip
   * cracks vertically and a funnel precesses horizontally whatever the cast is
   * doing. Using one frame for both put the whip's crack in a plane that rolled
   * with the aim, which looked like a bug and was one.
   */
  void tubeFrame(out vec3 dir, out float span, out vec3 n1, out vec3 n2,
                 out vec3 upN, out vec3 sideN) {
    vec3 delta = uTarget - uOrigin;
    span = max(length(delta), 0.01);
    dir = delta / span;

    vec3 lateral = uSide - dir * dot(uSide, dir);
    n1 = length(lateral) > 1e-4 ? normalize(lateral) : normalize(cross(dir, vec3(0.0, 1.0, 0.0)));
    n2 = normalize(cross(dir, n1));

    // Degenerate when the axis *is* vertical (a funnel), which is exactly when
    // the fallback matters: n1 is then already horizontal, so the precession
    // circle stays flat on the floor.
    vec3 vertical = vec3(0.0, 1.0, 0.0) - dir * dir.y;
    upN = length(vertical) > 1e-4 ? normalize(vertical) : n1;
    sideN = normalize(cross(dir, upN));
  }

  /**
   * Approximate normalised cumulative of the Gaussian lobe's slope energy.
   *
   * The exact thing is an error function, which GLSL ES 1.00 does not have and
   * which nobody would be able to see anyway; a smoothstep matched at the
   * inflection is within a percent over the range that matters.
   */
  float whipCumulative(float x) {
    return smoothstep(-1.6, 1.6, x);
  }

  /**
   * A point on the column's mean axis at t.
   *
   * drive is whatever scalar the path's motion is a function of — the wave
   * phase for WHIP, seconds since the snap for VINE, ignored elsewhere. It is a
   * parameter rather than a uniform read so the JS mirror can differentiate the
   * curve with respect to it without lying about what it is differentiating.
   */
  vec3 tubeAxis(float t, float drive, vec3 dir, float span,
                vec3 n1, vec3 n2, vec3 upN, vec3 sideN) {
    float axial = t;
    vec3 lateral = vec3(0.0);

    #if TUBE_PATH == PATH_WHIP
      float w = max(uWaveWidth, 1e-3);
      float x = (t - drive) / w;
      float lobe = exp(-x * x);
      float amp = uWaveAmp * mix(1.0, uWaveGain,
        pow(clamp(drive, 0.0, 1.0), max(uWaveCurve, 0.05)));
      // A whip does not stretch: the length the loop eats comes out of the
      // axial extent, distributed by the cumulative of the same lobe. This is
      // the term that pulls the tip back mid-crack and lets it go afterwards.
      axial = t - WHIP_EATEN * amp * amp / w * whipCumulative(x);
      lateral = (upN * cos(uWaveRoll) + sideN * sin(uWaveRoll)) * amp * lobe * span;
      lateral -= upN * uSag * sin(clamp(t, 0.0, 1.0) * PI);

    #elif TUBE_PATH == PATH_FUNNEL
      // The whole column leans and precesses, weighted to the top so the foot
      // stays planted on the scour it is standing in.
      float ang = (uTime * uSwaySpeed + t * uSwayScale) * TAU + uSeed * 6.283;
      lateral = (sideN * cos(ang) + upN * sin(ang)) *
                uSway * pow(clamp(t, 0.0, 1.0), max(uSwayCurve, 0.05));

    #elif TUBE_PATH == PATH_VINE
      // uRecoil is the spring, resolved on the CPU from drive seconds and the
      // three recoil sliders: 1 at rest, <1 hauled back, >1 overshooting.
      axial = t * uRecoil;
      float coil = (t * uMeanderTurns + uSeed) * TAU;
      lateral = (n1 * cos(coil) + n2 * sin(coil)) * uMeander * t;
      lateral += sideN * uRecoilSway * (1.0 - uRecoil) * sin(clamp(t, 0.0, 1.0) * PI);

    #elif TUBE_PATH == PATH_ARC
      // A skewed bell rather than a parabola, so the apex can sit anywhere
      // along the chord. smoothstep on the tent kills the kink at the top.
      float b = clamp(uArcBias, 0.05, 0.95);
      float k = t < b ? t / b : (1.0 - t) / (1.0 - b);
      float bell = pow(smoothstep(0.0, 1.0, clamp(k, 0.0, 1.0)), max(uArcCurve, 0.05));
      lateral = upN * uArcHeight * bell + sideN * uArcLateral * bell;
    #endif

    vec3 p = uOrigin + dir * (axial * span) + lateral;

    // Smooth drift, pinned at both ends. Deliberately smooth: the bolt's charm
    // is that its noise keeps its corners, and a tube that kinks is a bolt.
    float ends = sin(clamp(t, 0.0, 1.0) * PI);
    float dx = snoise(vec3(t * uWanderScale, uTime * uWanderSpeed, uSeed));
    float dy = snoise(vec3(t * uWanderScale + 31.7, uTime * uWanderSpeed, uSeed + 7.3));
    return p + (n1 * dx + n2 * dy) * uWander * ends;
  }
`;

const TUBE_VERTEX = /* glsl */ `
  ${TUBE_UNIFORMS}
  ${TUBE_VARYINGS}

  #define WHIP_EATEN ${WHIP_EATEN.toFixed(7)}

  ${noiseGLSL}
  ${disruptGLSL}
  ${TUBE_SHAPE}

  void main() {
    vec3 dir, n1, n2, upN, sideN;
    float span;
    tubeFrame(dir, span, n1, n2, upN, sideN);

    float t = position.x;
    float angle = position.y * TAU;
    vec3 nrm = n1 * cos(angle) + n2 * sin(angle);

    // The vortex spins by rotating the *lookup*, not the mesh: a circular cross
    // section rotated about its own centre is a no-op, and re-tessellating it
    // would cost a swirl uniform nobody could see.
    float sa = angle + (uSpin * uTime + uSpinTwist * t) * TAU;

    float rip = snoise(vec3(
      cos(sa) * uRippleBands,
      sin(sa) * uRippleBands,
      t * uRippleScale - uTime * uRippleSpeed + uSeed
    ));
    float r = tubeRadius(t) * (1.0 + uRipple * rip);

    #if TUBE_PATH == PATH_WHIP
      float drive = uWavePhase;
    #else
      float drive = 0.0;
    #endif

    vec3 here = tubeAxis(t, drive, dir, span, n1, n2, upN, sideN) + nrm * r;

    vT = t;
    vSpin = sa;
    // 1 looking down the barrel, 0 at the silhouette. Both tube weightings are
    // built out of this one number, in opposite directions.
    vFacing = abs(dot(normalize(cameraPosition - here), nrm));
    // Opt-in to vfx/SceneHooks.js's disruption field. The tube's vertices are
    // already in world space by this line, so this is one distance against a
    // uniform — and exactly 0.0, uniformly across the draw call, when nothing
    // is disrupting. A beam standing inside Spellbreak's zone is the reference
    // case for the whole hook: without this line the one ability that is meant
    // to be aware of the others cannot see the loudest thing on the stage.
    vDisrupt = disruptAt(here);

    vec4 mv = viewMatrix * vec4(here, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const TUBE_FRAGMENT = /* glsl */ `
  ${TUBE_UNIFORMS}
  ${TUBE_VARYINGS}

  uniform float uGlobalGlow;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  ${noiseGLSL}
  ${commonGLSL}
  ${disruptGLSL}

  void main() {
    // Ahead of the leading edge there is no tube yet. The column is built whole
    // and clipped here rather than scaled, so its *shape* never changes as the
    // front travels — only how much of it exists.
    float tip = max(uTipLength, 1e-3);
    float drawn = smoothstep(uProgress, uProgress - tip, vT);
    if (drawn <= 0.002) discard;

    // Filaments stretched hard along the axis and crawling with the flow.
    float flow = ridged(vec3(
      vT * uStreakScale - uTime * uFlowSpeed,
      cos(vSpin) * uStreakBands,
      sin(vSpin) * uStreakBands + uSeed
    ), 4);
    float streak = smoothstep(mix(0.42, 0.86, clamp(uStreakSharp, 0.0, 1.0)), 0.99, flow) * uStreak;

    float facing = clamp(vFacing, 0.0, 1.0);
    float axisward = pow(facing, max(uCoreSharp, 0.05));
    float rim = pow(1.0 - facing, max(uEdgePower, 0.05));

    vec3 color;
    float alpha;

    #if TUBE_LAYER == 0                                   /* CORE */
      color = mix(uColorInner, uColorCore, clamp(0.35 + streak, 0.0, 1.0));
      alpha = uCoreFill * mix(0.28, 1.0, axisward) + streak * 0.35;

    #elif TUBE_LAYER == 1                                 /* SHEATH */
      color = mix(uColorOuter, uColorInner, clamp(rim * 0.55 + streak, 0.0, 1.0));
      color += uColorCore * streak * uStreakGlow;
      alpha = rim * uSheathRim + uSheathFill * mix(0.12, 1.0, axisward) + streak * 0.4;

    #else                                                 /* HALO */
      float wide = pow(1.0 - facing, max(uHaloRim, 0.05));
      color = mix(uColorHalo, uColorOuter, wide);
      alpha = wide;
    #endif

    // Segment rings: vine nodes, pressure bands, the joints in a chitin tube.
    // Off by default because they are the fastest way to make a rod of light
    // look like plumbing.
    if (uBands > 0.0) {
      float b = 0.5 + 0.5 * sin((vT * uBands - uTime * uBandSpeed) * TAU);
      alpha *= mix(1.0, pow(b, max(uBandSharp, 0.05)), clamp(uBandDepth, 0.0, 1.0));
    }

    float muzzle = smoothstep(uMuzzleLength, 0.0, vT);
    color += uColorCore * muzzle * uMuzzleGlow;
    alpha += muzzle * uMuzzleGlow * 0.2;

    float lead = smoothstep(uProgress - tip * 2.0, uProgress, vT);
    color += uColorCore * lead * uTipGlow;
    alpha += lead * uTipGlow * 0.18;

    alpha *= drawn * uFade * uOpacity * uLayerOpacity;
    if (alpha < 0.003) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.003) discard;

    color *= uGlow * uGlobalGlow;

    // Last, on the finished fragment. Draining a rod of light before its own
    // glow gain is applied does nothing you can see — the gain is 3 to 8 here,
    // so a desaturated colour multiplied by eight is still white. Ordering the
    // other way round was the first attempt and the beam simply ignored the
    // field. The cell erosion has to come after the soft fade too, or the two
    // alpha tests fight and the shards flicker at the floor line.
    disruptShade(color, alpha, vDisrupt, gl_FragCoord.xy);
    if (alpha < 0.003) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One layer of one tube.
 *
 * Uniforms are pushed by `Tube#sync` rather than by a `userData.sync` of their
 * own — unlike `BeamMaterial`, which re-reads `settings.beam` once per pass.
 * Three passes over one settings block is three times the property lookups and
 * three times the `getColor()` calls for one identical answer, so the resolve
 * happens once in the owner and the result is pushed thrice.
 *
 * @param {number} layer TubeLayer.*
 * @param {number} path  TubePath.*
 */
export function createTubeMaterial(layer = TubeLayer.CORE, path = TubePath.STRAIGHT) {
  return new ShaderMaterial({
    defines: { TUBE_LAYER: layer, TUBE_PATH: path },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      // Opt-in to vfx/SceneHooks.js's disruption field — the shared boxes, by
      // identity, never a clone. A material that copies them reads a field that
      // is permanently off and there is no error to find.
      ...disruptUniforms(),
      uOrigin: { value: new Vector3() },
      uTarget: { value: new Vector3(0, 0, 1) },
      uSide: { value: new Vector3(1, 0, 0) },
      uSeed: { value: 0 },
      uProgress: { value: 1 },
      uFade: { value: 1 },
      uWidthFade: { value: 1 },

      uRadius: { value: TUBE_FIELDS.radius },
      uRadiusNear: { value: TUBE_FIELDS.radiusNear },
      uRadiusCurve: { value: TUBE_FIELDS.radiusCurve },
      uRadiusScale: { value: 1 },
      uFlare: { value: TUBE_FIELDS.flare },
      uFlareWidth: { value: TUBE_FIELDS.flareWidth },
      uThrob: { value: TUBE_FIELDS.throb },
      uThrobScale: { value: TUBE_FIELDS.throbScale },
      uThrobSpeed: { value: TUBE_FIELDS.throbSpeed },

      uWander: { value: TUBE_FIELDS.wander },
      uWanderScale: { value: TUBE_FIELDS.wanderScale },
      uWanderSpeed: { value: TUBE_FIELDS.wanderSpeed },

      uWavePhase: { value: 0 },
      uWaveWidth: { value: TUBE_FIELDS.waveWidth },
      uWaveAmp: { value: TUBE_FIELDS.waveAmp },
      uWaveGain: { value: TUBE_FIELDS.waveGain },
      uWaveCurve: { value: TUBE_FIELDS.waveCurve },
      uWaveRoll: { value: TUBE_FIELDS.waveRoll },
      uSag: { value: TUBE_FIELDS.sag },

      uThroat: { value: TUBE_FIELDS.throat },
      uSkirtFlare: { value: TUBE_FIELDS.skirtFlare },
      uSkirtHeight: { value: TUBE_FIELDS.skirtHeight },
      uSkirtCurve: { value: TUBE_FIELDS.skirtCurve },
      uMouthFlare: { value: TUBE_FIELDS.mouthFlare },
      uMouthStart: { value: TUBE_FIELDS.mouthStart },
      uMouthCurve: { value: TUBE_FIELDS.mouthCurve },
      uSpin: { value: TUBE_FIELDS.spin },
      uSpinTwist: { value: TUBE_FIELDS.spinTwist },
      uSway: { value: TUBE_FIELDS.sway },
      uSwayScale: { value: TUBE_FIELDS.swayScale },
      uSwaySpeed: { value: TUBE_FIELDS.swaySpeed },
      uSwayCurve: { value: TUBE_FIELDS.swayCurve },

      uGrow: { value: 1 },
      uTipTaper: { value: TUBE_FIELDS.tipTaper },
      uMeander: { value: TUBE_FIELDS.meander },
      uMeanderTurns: { value: TUBE_FIELDS.meanderTurns },
      uRecoil: { value: 1 },
      uRecoilSway: { value: TUBE_FIELDS.recoilSway },

      uArcHeight: { value: TUBE_FIELDS.arcHeight },
      uArcLateral: { value: TUBE_FIELDS.arcLateral },
      uArcBias: { value: TUBE_FIELDS.arcBias },
      uArcCurve: { value: TUBE_FIELDS.arcCurve },

      uRipple: { value: TUBE_FIELDS.ripple },
      uRippleBands: { value: TUBE_FIELDS.rippleBands },
      uRippleScale: { value: TUBE_FIELDS.rippleScale },
      uRippleSpeed: { value: TUBE_FIELDS.rippleSpeed },
      uStreak: { value: TUBE_FIELDS.streak },
      uStreakSharp: { value: TUBE_FIELDS.streakSharp },
      uStreakScale: { value: TUBE_FIELDS.streakScale },
      uStreakBands: { value: TUBE_FIELDS.streakBands },
      uStreakGlow: { value: TUBE_FIELDS.streakGlow },
      uFlowSpeed: { value: TUBE_FIELDS.flowSpeed },
      uBands: { value: TUBE_FIELDS.bands },
      uBandSharp: { value: TUBE_FIELDS.bandSharp },
      uBandDepth: { value: TUBE_FIELDS.bandDepth },
      uBandSpeed: { value: TUBE_FIELDS.bandSpeed },

      uCoreSharp: { value: TUBE_FIELDS.coreSharp },
      uCoreFill: { value: TUBE_FIELDS.coreFill },
      uEdgePower: { value: TUBE_FIELDS.edgePower },
      uSheathRim: { value: TUBE_FIELDS.sheathRim },
      uSheathFill: { value: TUBE_FIELDS.sheathFill },
      uHaloRim: { value: TUBE_FIELDS.haloRim },
      uLayerOpacity: { value: 1 },

      uMuzzleGlow: { value: TUBE_FIELDS.muzzleGlow },
      uMuzzleLength: { value: TUBE_FIELDS.muzzleLength },
      uTipGlow: { value: TUBE_FIELDS.tipGlow },
      uTipLength: { value: TUBE_FIELDS.tipLength },

      uOpacity: { value: 1 },
      uGlow: { value: TUBE_FIELDS.glow },
      uSoftFade: { value: TUBE_FIELDS.softFade },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorInner: { value: new Color(0.82, 0.96, 1) },
      uColorOuter: { value: new Color(0.29, 0.78, 1) },
      uColorHalo: { value: new Color(0.05, 0.2, 0.85) }
    }),
    vertexShader: TUBE_VERTEX,
    fragmentShader: TUBE_FRAGMENT
  });
}

/* ---------------------------------------------------------------- */
/* Module scratch — I3                                               */
/* ---------------------------------------------------------------- */

const _lat = new Vector3();
const _pa = new Vector3();
const _pb = new Vector3();

/** Default state, so a caller may omit anything it does not care about. */
const DEFAULT_STATE = {
  origin: null,
  target: null,
  side: null,
  progress: 1, // 0..1 of the column that exists yet
  fade: 1, // master alpha
  widthFade: 1, // master radius multiplier — the collapse to a thread
  seed: 0, // unitless dice roll from the cast
  time: 0, // seconds since the path's own beat began
  grow: 1, // VINE: the front, 0..1
  snapAge: -1 // VINE: seconds since the recoil was triggered, <0 = not yet
};

/* ---------------------------------------------------------------- */
/* Tube                                                              */
/* ---------------------------------------------------------------- */

export class Tube {
  /**
   * @param {object} [options]
   * @param {number} [options.path]        TubePath.* — compile-time, pick one per tube
   * @param {string} [options.prefix]      settings key prefix ('tube')
   * @param {number} [options.nodes]       samples along the column
   * @param {number} [options.sides]       facets around the barrel
   * @param {number} [options.renderOrder] the halo's order; sheath +1, core +2
   */
  constructor({
    path = TubePath.STRAIGHT,
    prefix = 'tube',
    nodes = 96,
    sides = 26,
    renderOrder = 11
  } = {}) {
    this.path = path;
    this.prefix = prefix;
    this.keys = tubeKeys(prefix);

    this.group = new Group();
    this.group.name = `Tube:${prefix}`;
    this.group.matrixAutoUpdate = false;

    // WHIP and ARC bend hardest, so they want the samples; a straight column
    // could get away with half of these and never show it.
    this.geometry = createBeamTubeGeometry(nodes, sides);

    this.materials = {};
    this.meshes = {};
    // Halo first so the core adds on top of it. Everything is additive with
    // depthWrite off, so the order is about layering, not correctness.
    for (const [layer, name, order] of [
      [TubeLayer.HALO, 'halo', renderOrder],
      [TubeLayer.SHEATH, 'sheath', renderOrder + 1],
      [TubeLayer.CORE, 'core', renderOrder + 2]
    ]) {
      const material = createTubeMaterial(layer, path);
      const mesh = new Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.matrixAutoUpdate = false;
      mesh.layers.set(LAYER.VFX);
      mesh.renderOrder = order;
      this.group.add(mesh);
      this.materials[name] = material;
      this.meshes[name] = mesh;
    }
    this._order = [
      [this.materials.core, TubeLayer.CORE],
      [this.materials.sheath, TubeLayer.SHEATH],
      [this.materials.halo, TubeLayer.HALO]
    ];

    /* --- the frame, resolved once per sync and reused by every query --- */
    this._origin = new Vector3();
    this._target = new Vector3();
    this._sideRef = new Vector3(1, 0, 0);
    this._dir = new Vector3(0, 0, 1);
    this._n1 = new Vector3(1, 0, 0);
    this._n2 = new Vector3(0, 1, 0);
    this._up = new Vector3(0, 1, 0);
    this._side = new Vector3(1, 0, 0);
    this._span = 1;

    /**
     * Resolved dimensions. Written whole by `sync()` every frame and read by
     * `radiusAt` / `pointAt`; never captured, never stale by more than the
     * frame it was written in.
     */
    this._r = {};
    for (const name of FIELD_NAMES) {
      if (typeof TUBE_FIELDS[name] === 'number') this._r[name] = TUBE_FIELDS[name];
    }
    this._r.grow = 1;
    this._r.recoil = 1;
    this._r.widthFade = 1;
    this._r.wavePhase = 0;

    /** Where the tip is standing, live. Do not keep the reference. */
    this.tipPoint = new Vector3();
    /** Metres/second the tip is moving at, from the curve, not from a clock. */
    this.tipSpeed = 0;
    /** Metres/second the curvature wave itself travels at. */
    this.waveSpeed = 0;

    /**
     * The crack. `fired` is true on exactly the frame the tip first exceeds the
     * wave speed, and false again once it drops back below — so an ability polls
     * it after `sync()` and never needs a timer of its own.
     */
    this.crack = { fired: false, point: new Vector3(), speed: 0, at: 0 };
    this._armed = false;

    /** Defaults for this path, so a missing key falls back rather than NaNs. */
    this._defaults = tubeDefaults(prefix, path);
    /** The settings contract is audited once, on the first frame. */
    this._checked = false;
  }

  /** Draw calls this tube costs. Three, always. */
  get drawCalls() {
    return 3;
  }

  set visible(value) {
    this.group.visible = value;
  }

  get visible() {
    return this.group.visible;
  }

  /* ------------------------------------------------------------------ */
  /* The frame update                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Re-resolve everything from settings and push it into the three layers.
   *
   * Call this every frame, including a zero-length one. Nothing here is
   * cached between frames except the edge-detect on the crack, which is an
   * event rather than a dimension.
   *
   * @param {object} c     the ability's live settings block (`settings.<id>`)
   * @param {object} state  { origin, target, side, progress, fade, widthFade,
   *                          seed, time, grow, snapAge } — dice rolls and
   *                          timestamps only
   * @param {object} [g]    `settings.global`; defaults to the live block.
   *                        Taken from `config/globals.js` rather than from
   *                        `config/settings.js`, because a settings module is
   *                        allowed to spread this module's defaults and the
   *                        round trip through `settings.js` closes a fatal
   *                        import cycle — see `config/globals.js`.
   */
  sync(c, state, g = globals) {
    const s = state || DEFAULT_STATE;
    const K = this.keys;
    const D = this._defaults;
    const r = this._r;

    if (!this._checked) this._audit(c);

    /* --- the cast's own geometry --- */
    if (s.origin) this._origin.copy(s.origin);
    if (s.target) this._target.copy(s.target);
    if (s.side) this._sideRef.copy(s.side);
    this._buildFrame();

    /* --- profile --- */
    r.radius = num(c[K.radius], D[K.radius]);
    r.radiusNear = num(c[K.radiusNear], D[K.radiusNear]);
    r.radiusCurve = num(c[K.radiusCurve], D[K.radiusCurve]);
    r.flare = num(c[K.flare], D[K.flare]);
    r.flareWidth = num(c[K.flareWidth], D[K.flareWidth]);
    r.throb = num(c[K.throb], D[K.throb]);
    r.throbScale = num(c[K.throbScale], D[K.throbScale]);
    r.throbSpeed = num(c[K.throbSpeed], D[K.throbSpeed]) * g.animationSpeed;
    r.widthFade = s.widthFade ?? 1;

    /* --- funnel --- */
    r.throat = num(c[K.throat], D[K.throat]);
    r.skirtFlare = num(c[K.skirtFlare], D[K.skirtFlare]);
    r.skirtHeight = num(c[K.skirtHeight], D[K.skirtHeight]);
    r.skirtCurve = num(c[K.skirtCurve], D[K.skirtCurve]);
    r.mouthFlare = num(c[K.mouthFlare], D[K.mouthFlare]);
    r.mouthStart = num(c[K.mouthStart], D[K.mouthStart]);
    r.mouthCurve = num(c[K.mouthCurve], D[K.mouthCurve]);
    r.sway = num(c[K.sway], D[K.sway]);
    r.swayScale = num(c[K.swayScale], D[K.swayScale]);
    r.swaySpeed = num(c[K.swaySpeed], D[K.swaySpeed]) * g.animationSpeed;
    r.swayCurve = num(c[K.swayCurve], D[K.swayCurve]);

    /* --- whip --- */
    const time = s.time ?? 0;
    r.waveRate = num(c[K.waveRate], D[K.waveRate]) * g.animationSpeed;
    r.waveWidth = num(c[K.waveWidth], D[K.waveWidth]);
    r.waveAmp = num(c[K.waveAmp], D[K.waveAmp]);
    r.waveGain = num(c[K.waveGain], D[K.waveGain]);
    r.waveCurve = num(c[K.waveCurve], D[K.waveCurve]);
    r.waveRoll = num(c[K.waveRoll], D[K.waveRoll]);
    r.sag = num(c[K.sag], D[K.sag]);
    r.crackRatio = num(c[K.crackRatio], D[K.crackRatio]);
    // The phase is a *derived* quantity: seconds since the beat began times a
    // live rate. Drag `waveRate` while paused and the loop moves.
    r.wavePhase = time * r.waveRate;

    /* --- vine --- */
    r.grow = saturate(s.grow ?? 1);
    r.tipTaper = num(c[K.tipTaper], D[K.tipTaper]);
    r.meander = num(c[K.meander], D[K.meander]);
    r.meanderTurns = num(c[K.meanderTurns], D[K.meanderTurns]);
    r.recoilAmp = num(c[K.recoilAmp], D[K.recoilAmp]);
    r.recoilFreq = num(c[K.recoilFreq], D[K.recoilFreq]) * g.animationSpeed;
    r.recoilDamp = num(c[K.recoilDamp], D[K.recoilDamp]);
    r.recoilSway = num(c[K.recoilSway], D[K.recoilSway]);
    const snapAge = s.snapAge ?? -1;
    r.snapAge = snapAge;
    r.recoil = this._springAt(snapAge);

    /* --- arc --- */
    r.arcHeight = num(c[K.arcHeight], D[K.arcHeight]);
    r.arcLateral = num(c[K.arcLateral], D[K.arcLateral]);
    r.arcBias = num(c[K.arcBias], D[K.arcBias]);
    r.arcCurve = num(c[K.arcCurve], D[K.arcCurve]);

    /* --- surface --- */
    r.ripple = num(c[K.ripple], D[K.ripple]) * g.noiseStrength;
    r.rippleBands = num(c[K.rippleBands], D[K.rippleBands]);
    r.rippleScale = num(c[K.rippleScale], D[K.rippleScale]) * g.noiseFrequency;
    r.rippleSpeed = num(c[K.rippleSpeed], D[K.rippleSpeed]) * g.noiseSpeed;
    r.streak = num(c[K.streak], D[K.streak]);
    r.streakSharp = num(c[K.streakSharp], D[K.streakSharp]);
    r.streakScale = num(c[K.streakScale], D[K.streakScale]) * g.noiseFrequency;
    r.streakBands = num(c[K.streakBands], D[K.streakBands]);
    r.streakGlow = num(c[K.streakGlow], D[K.streakGlow]);
    r.flowSpeed = num(c[K.flowSpeed], D[K.flowSpeed]) * g.noiseSpeed;
    r.bands = num(c[K.bands], D[K.bands]);
    r.bandSharp = num(c[K.bandSharp], D[K.bandSharp]);
    r.bandDepth = num(c[K.bandDepth], D[K.bandDepth]);
    r.bandSpeed = num(c[K.bandSpeed], D[K.bandSpeed]) * g.animationSpeed;
    r.spin = num(c[K.spin], D[K.spin]) * g.animationSpeed;
    r.spinTwist = num(c[K.spinTwist], D[K.spinTwist]);
    // The drift is the one place `randomness` and the noise multipliers have
    // anything to bite on, so they scale here rather than everywhere.
    r.wander = num(c[K.wander], D[K.wander]) * g.randomness * g.noiseStrength;
    r.wanderScale = num(c[K.wanderScale], D[K.wanderScale]) * g.noiseFrequency;
    r.wanderSpeed = num(c[K.wanderSpeed], D[K.wanderSpeed]) * g.noiseSpeed;

    /* --- layers, ends, render --- */
    r.coreWidth = num(c[K.coreWidth], D[K.coreWidth]);
    r.coreFill = num(c[K.coreFill], D[K.coreFill]);
    r.coreSharp = num(c[K.coreSharp], D[K.coreSharp]);
    r.edgePower = num(c[K.edgePower], D[K.edgePower]);
    r.sheathWidth = num(c[K.sheathWidth], D[K.sheathWidth]);
    r.sheathRim = num(c[K.sheathRim], D[K.sheathRim]);
    r.sheathFill = num(c[K.sheathFill], D[K.sheathFill]);
    r.sheathOpacity = num(c[K.sheathOpacity], D[K.sheathOpacity]);
    r.haloWidth = num(c[K.haloWidth], D[K.haloWidth]);
    r.haloRim = num(c[K.haloRim], D[K.haloRim]);
    r.haloOpacity = num(c[K.haloOpacity], D[K.haloOpacity]);
    r.muzzleGlow = num(c[K.muzzleGlow], D[K.muzzleGlow]);
    r.muzzleLength = num(c[K.muzzleLength], D[K.muzzleLength]);
    r.tipGlow = num(c[K.tipGlow], D[K.tipGlow]);
    r.tipLength = num(c[K.tipLength], D[K.tipLength]);
    r.opacity = num(c[K.opacity], D[K.opacity]) * g.opacity;
    r.glow = num(c[K.glow], D[K.glow]);
    r.softFade = num(c[K.softFade], D[K.softFade]);

    r.seed = s.seed ?? 0;
    r.progress = this.path === TubePath.VINE ? r.grow : (s.progress ?? 1);
    r.fade = s.fade ?? 1;

    /* --- what the ability asks us about --- */
    this._measureTip();

    /* --- push --- */
    const core = getColor(str(c[K.colorCore], D[K.colorCore]));
    const inner = getColor(str(c[K.colorInner], D[K.colorInner]));
    const outer = getColor(str(c[K.colorOuter], D[K.colorOuter]));
    const halo = getColor(str(c[K.colorHalo], D[K.colorHalo]));
    for (const [material, layer] of this._order) {
      this._push(material, layer, core, inner, outer, halo);
    }
  }

  /* ------------------------------------------------------------------ */
  /* The queries — the JS mirror of the shader's two shape functions     */
  /* ------------------------------------------------------------------ */

  /**
   * Half-width of the column at `t`, **metres**, before the per-layer width
   * multiplier. Multiply by `coreWidth` / `sheathWidth` / `haloWidth` if you
   * want one specific silhouette; leave it alone if you want the profile the
   * three of them are all multiples of, which is almost always what a consumer
   * placing itself against the tube actually wants.
   *
   * This is the funnel's vortex profile, and it is the one function the debris,
   * the dust skirt and the ground scour should all be reading.
   */
  radiusAt(t) {
    const r = this._r;
    const u = saturate(t);
    let out;

    if (this.path === TubePath.FUNNEL) {
      const skirt =
        r.skirtFlare * Math.pow(1 - smoothstep(0, Math.max(r.skirtHeight, 1e-3), u), Math.max(r.skirtCurve, 0.05));
      const mouth =
        r.mouthFlare * Math.pow(smoothstep(Math.min(r.mouthStart, 0.99), 1, u), Math.max(r.mouthCurve, 0.05));
      out = r.throat + skirt + mouth;
    } else if (this.path === TubePath.VINE) {
      const s = saturate(u / Math.max(r.grow, 1e-3));
      out = r.radius * Math.pow(1 - s, Math.max(r.tipTaper, 0.01));
    } else {
      out = r.radiusNear + (r.radius - r.radiusNear) * Math.pow(u, Math.max(r.radiusCurve, 0.01));
      out *= 1 + r.flare * smoothstep(1 - Math.max(r.flareWidth, 1e-3), 1, u);
    }

    out *= 1 + r.throb * Math.sin((u * r.throbScale - frame.uTime.value * r.throbSpeed) * TAU);
    return Math.max(out * r.widthFade, 1e-4);
  }

  /**
   * A point on the column's **mean** axis at `t`, world space.
   *
   * Mean because the `wander` noise is not mirrored here — see the module
   * header. Everything else is: the whip's lobe and its arc-length shortening,
   * the funnel's precession, the vine's spring, the arc's bell.
   *
   * @param {number} t 0..1 from origin to target
   * @param {THREE.Vector3} out
   */
  pointAt(t, out) {
    return this._axisInto(t, this._drive(), out);
  }

  /**
   * Unit tangent at `t`, world space. Central difference on the same curve, so
   * a consumer that wants to orient something along the tube gets an answer
   * consistent with where the tube actually is.
   */
  tangentAt(t, out) {
    const h = 1e-3;
    const drive = this._drive();
    this._axisInto(clamp(t - h, 0, 1), drive, _pa);
    this._axisInto(clamp(t + h, 0, 1), drive, _pb);
    out.subVectors(_pb, _pa);
    return out.lengthSq() > 1e-12 ? out.normalize() : out.copy(this._dir);
  }

  /** Metres from origin to target, live. */
  get span() {
    return this._span;
  }

  /**
   * The vortex mouth radius, or the far-end radius for any other path. Sugar
   * for `radiusAt(1)`, named because that is what the ability means.
   */
  get mouthRadius() {
    return this.radiusAt(1);
  }

  /** The radius where the column meets the floor. Sugar for `radiusAt(0)`. */
  get skirtRadius() {
    return this.radiusAt(0);
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  /** The scalar the path's motion is a function of. See `tubeAxis`. */
  _drive() {
    if (this.path === TubePath.WHIP) return this._r.wavePhase;
    if (this.path === TubePath.VINE) return this._r.snapAge;
    return 0;
  }

  /**
   * The recoil spring, evaluated from seconds since the snap.
   *
   * A damped cosine rather than an exponential: a vine that only eases back is
   * a vine on a lift, and the overshoot past 1 is the bit that reads as elastic.
   * Returns 1 exactly when the snap has not been triggered, so a growing vine
   * pays nothing for the feature.
   */
  _springAt(age) {
    if (!(age >= 0)) return 1;
    const r = this._r;
    return 1 - r.recoilAmp * Math.exp(-r.recoilDamp * age) * Math.cos(TAU * r.recoilFreq * age);
  }

  /** Both frames, mirroring `tubeFrame()` in the vertex shader exactly. */
  _buildFrame() {
    this._dir.subVectors(this._target, this._origin);
    this._span = Math.max(this._dir.length(), 0.01);
    this._dir.multiplyScalar(1 / this._span);

    _lat.copy(this._sideRef).addScaledVector(this._dir, -this._sideRef.dot(this._dir));
    if (_lat.lengthSq() > 1e-8) this._n1.copy(_lat).normalize();
    else this._n1.set(0, 1, 0).cross(this._dir).normalize();
    this._n2.crossVectors(this._dir, this._n1).normalize();

    this._up.set(0, 1, 0).addScaledVector(this._dir, -this._dir.y);
    if (this._up.lengthSq() > 1e-8) this._up.normalize();
    else this._up.copy(this._n1);
    this._side.crossVectors(this._dir, this._up).normalize();
  }

  /** `tubeAxis()`, in JS, minus the wander noise. */
  _axisInto(t, drive, out) {
    const r = this._r;
    let axial = t;
    _lat.set(0, 0, 0);

    switch (this.path) {
      case TubePath.WHIP: {
        const w = Math.max(r.waveWidth, 1e-3);
        const x = (t - drive) / w;
        const lobe = Math.exp(-x * x);
        const amp =
          r.waveAmp * (1 + (r.waveGain - 1) * Math.pow(saturate(drive), Math.max(r.waveCurve, 0.05)));
        axial = t - (WHIP_EATEN * amp * amp) / w * smoothstep(-1.6, 1.6, x);
        const c = Math.cos(r.waveRoll);
        const sn = Math.sin(r.waveRoll);
        _lat.copy(this._up).multiplyScalar(c).addScaledVector(this._side, sn);
        _lat.multiplyScalar(amp * lobe * this._span);
        _lat.addScaledVector(this._up, -r.sag * Math.sin(saturate(t) * Math.PI));
        break;
      }
      case TubePath.FUNNEL: {
        const ang = (frame.uTime.value * r.swaySpeed + t * r.swayScale) * TAU + r.seed * 6.283;
        const amount = r.sway * Math.pow(saturate(t), Math.max(r.swayCurve, 0.05));
        _lat.copy(this._side).multiplyScalar(Math.cos(ang) * amount);
        _lat.addScaledVector(this._up, Math.sin(ang) * amount);
        break;
      }
      case TubePath.VINE: {
        // The spring is recomputed from `drive` rather than read off `r.recoil`
        // so the curve is differentiable in its own driver — `_measureTip` needs
        // that, and for `drive === snapAge` the two are the same number, which
        // is what keeps this in step with the `uRecoil` the shader was handed.
        const recoil = this._springAt(drive);
        axial = t * recoil;
        const coil = (t * r.meanderTurns + r.seed) * TAU;
        _lat.copy(this._n1).multiplyScalar(Math.cos(coil) * r.meander * t);
        _lat.addScaledVector(this._n2, Math.sin(coil) * r.meander * t);
        _lat.addScaledVector(this._side, r.recoilSway * (1 - recoil) * Math.sin(saturate(t) * Math.PI));
        break;
      }
      case TubePath.ARC: {
        const b = clamp(r.arcBias, 0.05, 0.95);
        const k = t < b ? t / b : (1 - t) / (1 - b);
        const bell = Math.pow(smoothstep(0, 1, saturate(k)), Math.max(r.arcCurve, 0.05));
        _lat.copy(this._up).multiplyScalar(r.arcHeight * bell);
        _lat.addScaledVector(this._side, r.arcLateral * bell);
        break;
      }
      default:
        break;
    }

    return out.copy(this._origin).addScaledVector(this._dir, axial * this._span).add(_lat);
  }

  /**
   * The tip, its speed, and the crack.
   *
   * The speed is a central difference of the axis at the tip **with respect to
   * the path's own driver**, times the rate that driver advances at. Not a
   * position delta between frames: that would read zero on a paused frame and
   * would make the crack a function of the frame rate, which is precisely the
   * bug this module exists to avoid.
   */
  _measureTip() {
    const r = this._r;
    const tipT = this.path === TubePath.VINE ? r.grow : 1;
    const drive = this._drive();
    this._axisInto(tipT, drive, this.tipPoint);

    let rate = 0;
    if (this.path === TubePath.WHIP) rate = r.waveRate;
    else if (this.path === TubePath.VINE && r.snapAge >= 0) rate = 1; // driver is seconds

    if (rate === 0) {
      this.tipSpeed = 0;
      this.waveSpeed = 0;
      this.crack.fired = false;
      this._armed = false;
      return;
    }

    const h = 1e-3;
    this._axisInto(tipT, drive - h, _pa);
    this._axisInto(tipT, drive + h, _pb);
    this.tipSpeed = (_pa.distanceTo(_pb) / (2 * h)) * rate;

    // The loop travels the whole whip in 1/waveRate seconds; that is the wave
    // speed the tip has to beat.
    this.waveSpeed = this.path === TubePath.WHIP ? this._span * r.waveRate : 0;

    const threshold = this.waveSpeed * Math.max(r.crackRatio, 0.01);
    const over = this.waveSpeed > 0 && this.tipSpeed >= threshold;
    this.crack.fired = over && !this._armed;
    if (this.crack.fired) {
      this.crack.point.copy(this.tipPoint);
      this.crack.speed = this.tipSpeed;
      this.crack.at = frame.uTime.value;
    }
    this._armed = over;
  }

  /** Push the resolved block into one layer's uniforms. */
  _push(material, layer, core, inner, outer, halo) {
    const r = this._r;
    const u = material.uniforms;

    u.uOrigin.value.copy(this._origin);
    u.uTarget.value.copy(this._target);
    u.uSide.value.copy(this._sideRef);
    u.uSeed.value = r.seed;
    u.uProgress.value = r.progress;
    u.uFade.value = r.fade;
    u.uWidthFade.value = r.widthFade;

    u.uRadius.value = r.radius;
    u.uRadiusNear.value = r.radiusNear;
    u.uRadiusCurve.value = r.radiusCurve;
    u.uFlare.value = r.flare;
    u.uFlareWidth.value = r.flareWidth;
    u.uThrob.value = r.throb;
    u.uThrobScale.value = r.throbScale;
    u.uThrobSpeed.value = r.throbSpeed;

    u.uWander.value = r.wander;
    u.uWanderScale.value = r.wanderScale;
    u.uWanderSpeed.value = r.wanderSpeed;

    u.uWavePhase.value = r.wavePhase;
    u.uWaveWidth.value = r.waveWidth;
    u.uWaveAmp.value = r.waveAmp;
    u.uWaveGain.value = r.waveGain;
    u.uWaveCurve.value = r.waveCurve;
    u.uWaveRoll.value = r.waveRoll;
    u.uSag.value = r.sag;

    u.uThroat.value = r.throat;
    u.uSkirtFlare.value = r.skirtFlare;
    u.uSkirtHeight.value = r.skirtHeight;
    u.uSkirtCurve.value = r.skirtCurve;
    u.uMouthFlare.value = r.mouthFlare;
    u.uMouthStart.value = r.mouthStart;
    u.uMouthCurve.value = r.mouthCurve;
    u.uSpin.value = r.spin;
    u.uSpinTwist.value = r.spinTwist;
    u.uSway.value = r.sway;
    u.uSwayScale.value = r.swayScale;
    u.uSwaySpeed.value = r.swaySpeed;
    u.uSwayCurve.value = r.swayCurve;

    u.uGrow.value = r.grow;
    u.uTipTaper.value = r.tipTaper;
    u.uMeander.value = r.meander;
    u.uMeanderTurns.value = r.meanderTurns;
    u.uRecoil.value = r.recoil;
    u.uRecoilSway.value = r.recoilSway;

    u.uArcHeight.value = r.arcHeight;
    u.uArcLateral.value = r.arcLateral;
    u.uArcBias.value = r.arcBias;
    u.uArcCurve.value = r.arcCurve;

    u.uRipple.value = r.ripple;
    u.uRippleBands.value = r.rippleBands;
    u.uRippleScale.value = r.rippleScale;
    u.uRippleSpeed.value = r.rippleSpeed;
    u.uStreak.value = r.streak;
    u.uStreakSharp.value = r.streakSharp;
    u.uStreakScale.value = r.streakScale;
    u.uStreakBands.value = r.streakBands;
    u.uStreakGlow.value = r.streakGlow;
    u.uFlowSpeed.value = r.flowSpeed;
    u.uBands.value = r.bands;
    u.uBandSharp.value = r.bandSharp;
    u.uBandDepth.value = r.bandDepth;
    u.uBandSpeed.value = r.bandSpeed;

    u.uCoreSharp.value = r.coreSharp;
    u.uCoreFill.value = r.coreFill;
    u.uEdgePower.value = r.edgePower;
    u.uSheathRim.value = r.sheathRim;
    u.uSheathFill.value = r.sheathFill;
    u.uHaloRim.value = r.haloRim;

    u.uMuzzleGlow.value = r.muzzleGlow;
    u.uMuzzleLength.value = r.muzzleLength;
    u.uTipGlow.value = r.tipGlow;
    u.uTipLength.value = r.tipLength;

    // Which of the three radii this layer is, and how hard it is drawn.
    switch (layer) {
      case TubeLayer.CORE:
        u.uRadiusScale.value = r.coreWidth;
        u.uLayerOpacity.value = 1;
        u.uGlow.value = r.glow;
        break;
      case TubeLayer.SHEATH:
        u.uRadiusScale.value = r.sheathWidth;
        u.uLayerOpacity.value = r.sheathOpacity;
        u.uGlow.value = r.glow;
        break;
      default:
        u.uRadiusScale.value = r.haloWidth;
        u.uLayerOpacity.value = r.haloOpacity;
        u.uGlow.value = r.glow * 0.8;
        break;
    }

    u.uOpacity.value = r.opacity;
    u.uSoftFade.value = r.softFade;
    u.uColorCore.value.copy(core);
    u.uColorInner.value.copy(inner);
    u.uColorOuter.value.copy(outer);
    u.uColorHalo.value.copy(halo);
  }

  /**
   * Warn once about a settings block that has not been given the contract.
   *
   * A warning rather than a throw, and `num()` behind it, because the failure
   * this replaces is the nastiest one in the project: a key that is not there
   * reads `undefined`, multiplies through into a uniform, and the tube quietly
   * becomes NaN geometry — a mesh that draws nothing, with no error anywhere and
   * no clue which of seventy sliders was the one. `scripts/check.mjs` catches it
   * statically; this catches it on the first frame, by name, while still
   * drawing something.
   */
  _audit(c) {
    this._checked = true;
    auditBlock(
      `Tube:${this.prefix}`,
      this.keys,
      FIELD_NAMES,
      c,
      `tubeDefaults('${this.prefix}', TubePath.${PATH_NAMES[this.path]})`
    );
  }

  /** Free GPU resources. App teardown only — pooled abilities keep theirs. */
  dispose() {
    this.geometry.dispose();
    for (const key of Object.keys(this.materials)) this.materials[key].dispose();
    this.group.parent?.remove(this.group);
  }
}
