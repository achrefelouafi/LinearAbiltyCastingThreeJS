import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* PETRIFY — Petrifying Gaze                                           */
/* ================================================================== */
/**
 * A grey stone column that **accretes out of the air** along the aimed line,
 * stands, and then crumbles into a raymarched fall of sand.
 *
 * The two halves of the trick each own a block below.
 *
 * **Accretion.** Every facet is a plate that appears out on a cylindrical
 * *shell* around the cast axis at `shellRadius` and converges inward onto the
 * column's surface as it grows. It is the convergence that reads, not the
 * growth: a field that simply scales up in place is a field of props fading
 * in, and the first version of this looked exactly like that. `swirl` and
 * `tumble` are what stop the approach from being a straight radial slide —
 * with both at zero the facets come in like lift doors and the eye reads a
 * mechanism rather than stone gathering.
 *
 * **Collapse.** `crumble*` shrinks the facets to nothing on a front that runs
 * the line, and `sand*` (a `VolumeHull` in the SAND medium) fades in *behind*
 * them. `sandLead` is the number that matters and it is measured in seconds
 * **before** the first facet lets go: the two halves must overlap or there is
 * one frame where the column is simply absent, which is the single most
 * obvious way this ability can fail.
 *
 * The palette is deliberately the quietest in the sandbox. `emission` ships at
 * 0.06 and the highest value in the four stone pickers is `#9a948a`; there is
 * no ember, no rim glow and no birth flash beyond a pale dust bloom. Everything
 * else in this project fights the bloom pass. This one hides from it.
 */
export const petrify = {
  /* --- the cast --- */
  range: 17.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 21.0, // how fast the gaze runs down the line, metres/second
  holdTime: 1.6, // seconds the finished column stands before it lets go
  crumbleTime: 0.95, // seconds the facets take to shrink to nothing
  sandTail: 0.8, // seconds the sand keeps falling after the last facet has gone
  cooldown: 1.4, // seconds before it can be cast again
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the axis the column is built on --- */
  axisHeight: 1.32, // metres above the floor the axis runs at, at the caster
  endHeight: 1.05, // metres, the same axis where it lands
  axisSag: 0.14, // metres the axis bows *downward* at mid-span
  axisForward: 0.6, // metres in front of the caster the column starts
  columnRadiusNear: 0.32, // metres, the column's surface radius at the caster
  columnRadius: 0.66, // metres, at the far end
  columnCurve: 1.3, // >1 keeps the column thin, then swells it late (exponent)

  /* --- the shell the facets arrive from --- */
  facetCount: 190, // plates in the column (hard ceiling 264)
  shellRadius: 2.3, // metres from the axis a facet first appears at
  shellJitter: 0.4, // ± fraction of that radius, per facet
  shellDrift: 0.55, // metres of along-axis wander while it is still out there
  swirl: 1.05, // radians a facet sweeps around the axis on its way in
  tumble: 2.2, // radians it rolls about its own normal on the way in
  accreteTime: 0.44, // seconds one facet takes to arrive and lock
  accreteStagger: 0.34, // seconds of random delay between neighbours
  overshoot: 0.16, // fraction of the trip it carries past the surface
  springRate: 19.0, // radians/second of that overshoot ring
  settle: 0.3, // seconds the overshoot damps out over
  birthFade: 0.22, // seconds the pale arrival bloom decays over

  /* --- one facet --- */
  facetSize: 0.6, // metres, plate radius at the far end
  facetSizeNear: 0.42, // metres, at the caster
  facetSizeJitter: 0.44, // ± fraction, per facet
  facetThickness: 0.34, // plate thickness, as a fraction of its own radius
  facetSides: 6, // vertices around one plate (4–9)
  facetTaper: 0.66, // outer face radius as a fraction of the inner face
  facetRough: 0.44, // how far the vertices are pushed off a clean polygon
  facetShoulder: 0.62, // where up the plate the widest ring sits, 0..1

  /* --- the stone --- */
  // Four pickers, none derived from another (I5). `colorPale` is the film of
  // rock dust on a face that has just landed; it is *not* an emissive colour,
  // it is mixed into the albedo, which is why this slot never blooms.
  colorStone: '#9a948a', // a face turned toward the light
  colorShade: '#565049', // a face turned away from it
  colorSeam: '#221f1c', // the crack where two plates meet
  colorPale: '#c4bcb0', // the dust bloom on a facet the instant it lands
  grain: 0.75, // strength of the world-space stone grain, unitless
  grainScale: 5.5, // grain features per metre
  seamDepth: 0.6, // how dark a plate goes toward its own rim, unitless
  facetSharp: 0.6, // how much a face pointing at the camera is lifted
  birthPale: 0.55, // how far a landing facet mixes toward `colorPale`
  emission: 0.06, // the whole slot's emissive gain — deliberately near zero
  stoneRoughness: 0.88, // MeshStandardMaterial roughness
  envIntensity: 0.3, // how much of the HDR probe the stone picks up
  opacity: 1.0,

  /* --- the crumble --- */
  crumbleStagger: 0.75, // 0..1 of the crumble spent travelling the line
  crumbleSpan: 0.4, // 0..1 of the crumble one facet's own collapse takes
  crumbleDrop: 0.55, // metres a facet falls while it collapses
  crumbleSpin: 2.6, // radians it tumbles through as it goes

  /* --- the fall of sand --- */
  // A BOX hull from the floor to the top of the column, spanning the cast.
  // BOX rather than CYLINDER because the column is horizontal and the sand is
  // not: the volume the grains occupy is the column's own footprint extruded
  // *down* to the floor, and that is a box, tightly.
  sandLead: 0.4, // seconds the sand starts BEFORE the first facet lets go
  sandOnset: 0.45, // seconds it takes to reach full density
  sandGirth: 1.35, // × the column radius — half-width of the sand box
  sandHead: 0.5, // metres of headroom above the column inside the box
  sandDust: 1.0, // master multiplier on the volume's own opacity, unitless
  ...volumeHullDefaults('sand', Medium.SAND, {
    // Fewer steps than the SAND default: this box is long and the camera sees
    // a lot of it, and coverage is the expensive axis, not resolution.
    sandSteps: 26,
    sandMargin: 0.22,
    sandHeightBias: 0.75, // the grains pile toward the floor
    sandFeather: 0.4,
    sandDensity: 1.9,
    sandNoiseFrequency: 2.6,
    sandNoiseStrength: 1.05,
    sandRise: -2.4, // metres/second — it falls
    sandFlatten: 0.25, // eddies stretched wide, so it pours rather than billows
    sandShadowTaps: 1,
    sandAmbient: 0.46,
    sandOpacity: 0.9
  }),

  /* --- dust, grit and grains --- */
  /**
   * Three systems, each with its own four-stop lifetime gradient (I5). The
   * grains are the one that carries the crumble, so it is the one with the
   * rate worth reaching for first.
   */
  dustRate: 34, // grey haze off the column, particles/second
  dustSize: 0.85,
  dustSpeed: 0.7,
  dustLifetime: 2.4,
  dustOpacity: 0.16,
  dustRise: 0.32, // upward drift, metres/second
  colorDustA: '#8f8880',
  colorDustB: '#767068',
  colorDustC: '#5c5750',
  colorDustD: '#33302c',
  gritRate: 26, // chips flicked off as a facet locks, particles/second
  gritSize: 0.05,
  gritSpeed: 2.2,
  gritLifetime: 1.5,
  gritGravity: -14.0,
  colorGritA: '#a49c90',
  colorGritB: '#7d766c',
  colorGritC: '#4c4740',
  colorGritD: '#2a2724',
  grainRate: 320, // the fall of sand itself, particles/second
  grainSize: 0.055,
  grainSpeed: 1.4,
  grainLifetime: 1.1,
  grainGravity: -11.0,
  grainStretch: 0.22, // how far a grain smears along its velocity
  grainOpacity: 0.7,
  colorGrainA: '#c0b5a4',
  colorGrainB: '#a2988a',
  colorGrainC: '#797066',
  colorGrainD: '#4a453f',

  /* --- what the ground does --- */
  crackRadius: 1.5, // stone cracking under the column at impact, metres
  crackLife: 5.0, // seconds it lingers
  crackIntensity: 0.32,
  duneRadius: 1.1, // the dust ring where the sand lands, metres
  duneLife: 4.0,
  duneIntensity: 0.4,
  duneRate: 1.1, // dust rings laid per metre of crumble front travel
  colorCrack: '#3a352f',
  colorCrackEdge: '#7d766c',
  colorDune: '#8a8278',
  colorDuneEdge: '#c0b6a8',

  /* --- dynamic light --- */
  // The quietest light in the sandbox, and it is not there to light the stone
  // — the stage does that. It is there so the *dust* has something to catch.
  lightIntensity: 5.0,
  lightRadius: 9.0,
  lightColor: '#6d665c',

  /* --- the impact and the shake --- */
  lockShake: 0.22, // camera shake as the column locks
  shakeDuration: 0.7, // seconds that shake damps out over
  crumbleShake: 0.3, // shake as it goes
  rumble: 0.014, // continuous shake while the gaze travels
  burstSize: 1.6, // the dust shell where the column finishes, metres
  burstIntensity: 0.55,
  burstGrit: 60, // chips thrown at the lock
  colorBurstA: '#8f8880',
  colorBurstB: '#6a645c',
  colorBurstC: '#b6ada0'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Petrifying Gaze.
 *
 * The four controls that carry the ability, in the order worth dragging them:
 * `shellRadius` (how far out of the air the stone comes from), `swirl` (whether
 * the approach reads as gathering or as machinery), `sandLead` (whether the
 * handoff has a hole in it) and `emission` (which should never leave the
 * bottom of its range — the restraint *is* the slot).
 */
export const petrifySchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 4, 120, 0.5, 'gaze speed'],
    ['holdTime', 0.1, 8, 0.05, 'column hold'],
    ['crumbleTime', 0.1, 4, 0.01, 'crumble time'],
    ['sandTail', 0.05, 4, 0.05, 'sand tail'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The column': [
    ['axisHeight', 0, 4, 0.01, 'axis height at caster'],
    ['endHeight', 0, 4, 0.01, 'axis height at target'],
    ['axisSag', -1.5, 1.5, 0.01, 'mid-span droop'],
    ['axisForward', -1, 4, 0.01, 'start distance'],
    ['columnRadiusNear', 0.05, 3, 0.01, 'radius at caster'],
    ['columnRadius', 0.05, 3, 0.01, 'radius at target'],
    ['columnCurve', 0.2, 4, 0.01, 'radius curve']
  ],
  'Accretion': [
    ['facetCount', 8, 264, 1, 'facets'],
    ['shellRadius', 0.2, 8, 0.01, 'shell radius'],
    ['shellJitter', 0, 1, 0.01, 'shell jitter'],
    ['shellDrift', 0, 3, 0.01, 'along-axis wander'],
    ['swirl', -6, 6, 0.01, 'swirl in (rad)'],
    ['tumble', 0, 8, 0.01, 'roll in (rad)'],
    ['accreteTime', 0.05, 2, 0.01, 'arrival time'],
    ['accreteStagger', 0, 2, 0.01, 'neighbour stagger'],
    ['overshoot', 0, 1, 0.01, 'lock overshoot'],
    ['springRate', 1, 50, 0.5, 'lock ring rate'],
    ['settle', 0.05, 2, 0.01, 'lock settle'],
    ['birthFade', 0.02, 2, 0.01, 'arrival bloom decay']
  ],
  'One facet': [
    ['facetSize', 0.05, 2, 0.01, 'plate radius at target'],
    ['facetSizeNear', 0.05, 2, 0.01, 'plate radius at caster'],
    ['facetSizeJitter', 0, 1, 0.01, 'plate size jitter'],
    ['facetThickness', 0.02, 1.5, 0.01, 'plate thickness'],
    ['facetSides', 4, 9, 1, 'plate sides'],
    ['facetTaper', 0.1, 1.6, 0.01, 'outer face taper'],
    ['facetRough', 0, 1, 0.01, 'edge roughness'],
    ['facetShoulder', 0.05, 0.95, 0.01, 'shoulder height']
  ],
  'The stone': [
    ['grain', 0, 3, 0.01, 'grain'],
    ['grainScale', 0.2, 20, 0.05, 'grain features / m'],
    ['seamDepth', 0, 2, 0.01, 'plate rim darkening'],
    ['facetSharp', 0, 2, 0.01, 'facet lift'],
    ['birthPale', 0, 2, 0.01, 'arrival dust'],
    ['emission', 0, 1, 0.005, 'emission'],
    ['stoneRoughness', 0.05, 1, 0.01, 'roughness'],
    ['envIntensity', 0, 2, 0.01, 'probe intensity'],
    ['opacity', 0, 1, 0.01, 'opacity'],
    ['colorStone', 'lit stone'],
    ['colorShade', 'shaded stone'],
    ['colorSeam', 'plate seam'],
    ['colorPale', 'arrival dust']
  ],
  'The crumble': [
    ['crumbleStagger', 0, 1, 0.01, 'front travel'],
    ['crumbleSpan', 0.05, 1, 0.01, 'one facet collapse'],
    ['crumbleDrop', 0, 3, 0.01, 'facet drop'],
    ['crumbleSpin', 0, 12, 0.05, 'facet tumble']
  ],
  'The fall of sand': [
    ['sandLead', 0, 2, 0.01, 'sand lead (s)'],
    ['sandOnset', 0.05, 2, 0.01, 'sand onset (s)'],
    ['sandGirth', 0.5, 4, 0.01, 'box half-width ×'],
    ['sandHead', 0, 3, 0.01, 'box headroom'],
    ['sandDust', 0, 2, 0.01, 'sand opacity ×']
  ],
  ...volumeHullSchema('sand', {
    label: 'Sand volume',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'colour']
  }),
  'Dust, grit & grains': [
    ['dustRate', 0, 300, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 6, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['gritRate', 0, 300, 1, 'grit rate'],
    ['gritSize', 0.005, 0.4, 0.005, 'grit size'],
    ['gritSpeed', 0, 20, 0.1, 'grit speed'],
    ['gritLifetime', 0.1, 5, 0.05, 'grit lifetime'],
    ['gritGravity', -50, 0, 0.1, 'grit gravity'],
    ['grainRate', 0, 1200, 1, 'grain rate'],
    ['grainSize', 0.005, 0.4, 0.005, 'grain size'],
    ['grainSpeed', 0, 12, 0.05, 'grain speed'],
    ['grainLifetime', 0.1, 5, 0.05, 'grain lifetime'],
    ['grainGravity', -50, 0, 0.1, 'grain gravity'],
    ['grainStretch', 0, 3, 0.01, 'grain stretch'],
    ['grainOpacity', 0, 1, 0.01, 'grain opacity'],
    ['colorDust*', 'Dust colour'],
    ['colorGrit*', 'Grit colour'],
    ['colorGrain*', 'Grain colour']
  ],
  'Marks on the ground': [
    ['crackRadius', 0.1, 8, 0.05, 'crack radius'],
    ['crackLife', 0.2, 20, 0.1, 'crack lifetime'],
    ['crackIntensity', 0, 2, 0.01, 'crack intensity'],
    ['duneRadius', 0.1, 6, 0.05, 'dust ring radius'],
    ['duneLife', 0.2, 20, 0.1, 'dust ring lifetime'],
    ['duneIntensity', 0, 2, 0.01, 'dust ring intensity'],
    ['duneRate', 0.05, 6, 0.05, 'rings / metre'],
    ['colorCrack', 'crack'],
    ['colorCrackEdge', 'crack edge'],
    ['colorDune', 'dust ring'],
    ['colorDuneEdge', 'dust ring edge']
  ],
  'The lock & the shake': [
    ['lockShake', 0, 2, 0.01, 'lock shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['crumbleShake', 0, 2, 0.01, 'crumble shake'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['burstSize', 0.1, 8, 0.05, 'dust shell size'],
    ['burstIntensity', 0, 3, 0.01, 'dust shell intensity'],
    ['burstGrit', 0, 400, 1, 'lock grit'],
    ['colorBurstA', 'shell'],
    ['colorBurstB', 'shell body'],
    ['colorBurstC', 'shell rim']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
