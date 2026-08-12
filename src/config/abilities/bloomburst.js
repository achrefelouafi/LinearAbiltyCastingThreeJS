import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* BLOOMBURST — verdant, far cast                                      */
/* ================================================================== */
/**
 * A meadow forced open on a clock.
 *
 * Stalks push up out of the circle, each carrying a closed bud; the buds
 * unfurl in a wave that runs from the middle of the footprint out to the
 * boundary; the field holds, breathing pollen; and then **every petal in the
 * circle lets go on the same frame** and the whole thing becomes a low volume
 * of pollen that drifts and settles.
 *
 * The trick is the unfurl, and it lives entirely in the vertex shader. Each
 * petal is stored once, unbent, and posed per frame from a quadratic Bezier
 * whose control points lerp from a bud pose to an open pose — so the closed
 * shape, the open shape, and the *shape of the journey between them*
 * (`unfurlCurve`, the signature slider) are three independent things you can
 * drag on a field that is already standing, with the clock stopped. See
 * `materials/PetalMaterial.js` for why nothing about the pose can live on the
 * CPU: `GrowthField` shares one geometry across every instance of a variant,
 * and the bend is a function of time *per instance*.
 *
 * The wave is `GrowthField.triggerRadial`, and the opening clock is the
 * `aBirth` attribute the field already writes — this ability hands `birthFade`
 * its own `unfurlTime`, which is what couples the two without a second
 * attribute or a second clock.
 */
export const bloomburst = {
  /* --- the cast --- */
  range: 21.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 32.0, // how fast the growth front runs to the circle, metres/second
  cooldown: 1.4, // seconds
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 4.6, // the footprint the indicator draws, metres

  /* --- the beats, all seconds --- */
  riseTime: 0.34, // stalk from buried to full height
  waveTime: 0.72, // for the opening wave to cross the circle, centre to rim
  waveStagger: 0.14, // random scatter on top of the wave, per flower
  waveInvert: false, // true runs the wave from the boundary inward instead
  unfurlTime: 0.62, // one bud from closed to fully open
  holdTime: 1.15, // the field standing open before it lets go
  releaseTime: 0.55, // every petal leaving at once
  witherTime: 1.35, // the stalks folding back into the floor after them

  /* --- the field on the ground --- */
  flowers: 38, // stalks planted per cast (hard ceiling 96)
  coreShare: 0.18, // 0..1 of them held back for the middle of the circle
  innerFrac: 0.16, // inner edge of the ring, as a fraction of zoneRadius
  radialCurve: 0.85, // <1 pushes the ring outward, >1 crowds it inward
  radialJitter: 0.42, // metres of radial wander per flower
  angleJitter: 0.35, // radians of bearing wander per flower

  /* --- one flower's proportions --- */
  heightNear: 1.28, // metres tall in the middle of the circle
  height: 0.94, // ...and out at the boundary
  heightCurve: 0.9, // how quickly the height ramps from middle to rim
  heightJitter: 0.26, // ± fraction
  // The footprint radius scales the *whole* flower sideways — stalk, hinge and
  // blade half-width are all fractions of it — so this is really "how big is
  // one bloom", and 0.42 m gives an open head about eighty centimetres across.
  stalkRadius: 0.42, // metres, footprint radius of a flower in the middle
  stalkRadiusTop: 0.34, // metres, the same out at the rim
  radiusCurve: 0.75, // how that ramps from middle to rim
  radiusJitter: 0.24, // ± fraction
  lean: 0.16, // radians a flower leans away from the middle
  leanJitter: 0.7, // ± fraction
  leanRamp: 0.7, // 0 leans everything, 1 only the boundary
  // The lean direction is a normalised blend of these two, so one of them on
  // its own does nothing at all — scaling a vector before normalising it is a
  // no-op, and `leanOutward` read as a dead slider until `leanForward` was
  // given a non-zero default to blend against. Together they aim the whole
  // meadow: all-outward is a rosette, all-forward is a field bent by wind.
  leanOutward: 0.95, // how much of that lean is radially outward
  leanForward: 0.18, // ...and how much is downrange, along the cast
  tilt: 0.14, // radians of extra random tip, any bearing
  twist: 1.0, // 0..1 of a full turn of random yaw per flower

  /* --- how a stalk arrives --- */
  riseOvershoot: 0.2, // how far past full height the push carries
  settle: 0.4, // seconds that overshoot damps out over
  springRate: 12.0, // radians/second of the overshoot ring
  emergeSink: 0.9, // fraction of its height a stalk is buried at emerge = 0
  birthScale: 0.7, // footprint scale at the moment it breaks the surface
  breachAt: 0.22, // emergence fraction that fires the breach puff
  sinkDepth: 0.5, // extra metres a withering stalk drops beyond its height

  /* --- the flower, as geometry (these rebuild the mesh) --- */
  petals: 6, // blades per flower; variants carry ±1 around this
  petalSegments: 8, // tessellation along one blade
  stalkSides: 6, // sides of the stalk prism

  /* --- the flower, as a pose (these are live uniforms, no rebuild) --- */
  // Every length here is a fraction of the flower's own height, so a short
  // flower and a tall one are the same shape.
  stemFrac: 0.44, // how much of the height is bare stalk
  stemRadius: 0.05, // stalk thickness at the floor
  heartRadius: 0.09, // radius the petals are hinged on
  petalWidth: 0.3, // half-width of a blade at its widest
  petalWidthBias: 0.78, // <1 puts the widest point nearer the hinge
  petalTaper: 0.7, // >1 sharpens the tip, <1 rounds it
  petalCrease: 0.44, // the lengthwise fold, as a fraction of the half-width
  petalCup: 0.3, // cross-sectional curl toward the axis, same units

  /* --- the two poses the unfurl runs between --- */
  budMidOut: 0.02, // bud: the mid control point, outward
  budMidUp: 0.34, // ...and upward
  budTipOut: 0.05, // bud: the tip, outward — near zero is a closed bud
  budTipUp: 0.7, // ...and upward
  openMidOut: 0.3, // open: the mid control point, outward
  openMidUp: 0.44, // ...and upward
  openTipOut: 0.64, // open: the tip thrown out past the footprint
  openTipUp: 0.14, // ...and dropped, which is what makes it a flower
  unfurlCurve: 1.55, // THE slider: >1 holds the bud shut then throws it open
  petalStagger: 0.28, // 0..1 ripple between the petals of one flower

  /* --- the release --- */
  releaseThrow: 0.95, // outward travel of a freed petal, in flower heights
  releaseLift: 0.6, // ...and upward
  releaseSpin: 1.45, // radians it tumbles about its own hinge
  releaseShrink: 0.85, // how far it closes to nothing on the way out
  stemWilt: 0.6, // how far the stalk folds once the petals have gone

  /* --- petal colour and shading --- */
  colorStem: '#4f7a34', // the stalk
  colorPetalBase: '#f7e6f2', // the blade at the hinge
  colorPetalMid: '#f2d0e8', // ...across the body
  colorPetalTip: '#a84f8a', // ...at the tip
  colorVein: '#8a3a6e', // the midrib and the vein fan
  colorHeart: '#ffe89a', // the middle of the flower, and the birth flash
  veins: 0.5, // strength of the vein pattern
  veinCount: 5.0, // ribs across the blade
  grain: 0.2, // fibrous world-space variation
  grainScale: 7.5, // features per metre of that grain
  fresnel: 1.0, // rim strength
  fresnelPower: 2.6, // how tight the rim is
  translucency: 1.9, // backlit glow through the blade
  translucencyPower: 4.0, // how narrowly that faces the sun
  petalGlow: 1.0, // overall emissive gain on the flowers
  edgeGlow: 0.65, // gain on the rim term alone
  heartGlow: 2.6, // gain on the middle of the flower
  birthGlow: 1.4, // flash as a bud starts to open
  petalOpacity: 1.0,
  petalRoughness: 0.6,
  envIntensity: 0.7,

  /* --- the pollen volume --- */
  // A raymarched SPORE cylinder standing over the circle. It is barely there
  // while the field is only holding, and it is the whole ability for the
  // second and a half after the petals let go.
  pollenRadius: 1.05, // hull footprint, × zoneRadius
  pollenSwell: 1.35, // extra footprint at the peak of the release
  pollenLift: 1.9, // hull height, metres
  pollenBase: 0.35, // metres above the floor the hull starts
  pollenHaze: 0.16, // 0..1 fade while the flowers are merely standing
  pollenSettle: 0.55, // 0..1 how far the hull sinks back as it dies
  ...volumeHullDefaults('pollen', Medium.SPORE, {
    pollenSteps: 30,
    pollenDensity: 1.1,
    pollenMargin: 0.24,
    pollenHeightBias: 0.22,
    pollenFlatten: 0.32,
    pollenRise: 0.5,
    pollenFlowY: -0.1,
    pollenNoiseFrequency: 1.5,
    pollenSpeckDensity: 0.2,
    pollenSpeckScale: 3.4,
    pollenSpeckGlow: 9.0,
    pollenEmission: 2.6,
    pollenColorCore: '#ffe89a',
    pollenColorMid: '#e8c878',
    pollenColorEdge: '#8a7a3a',
    pollenColorDeep: '#241f10',
    pollenColorLight: '#fff4c8',
    pollenColorSpeck: '#fff0b0'
  }),

  /* --- pollen motes, petal confetti and the green haze --- */
  /**
   * As everywhere else in the project: each system is coloured by a four-stop
   * gradient sampled over the particle's own lifetime, `A` at birth through
   * `D` as it dies, spelled out rather than derived from the flower palette so
   * the pollen can be made to cool to brown while the petals stay pink.
   */
  pollenRate: 62, // motes drifting off the open flowers, particles/second
  pollenSize: 0.055,
  pollenSpeed: 0.75, // metres/second off the heart
  pollenLifetime: 2.1,
  pollenDrift: 0.34, // upward drift, metres/second²
  pollenTurbulence: 0.8,
  pollenGlow: 1.5,
  colorPollenA: '#fff6cc',
  colorPollenB: '#ffe89a',
  colorPollenC: '#d8b45a',
  colorPollenD: '#4a3c14',
  confettiSize: 0.11, // torn petal fragments
  confettiSpeed: 3.4,
  confettiLifetime: 2.6,
  confettiGravity: -2.6,
  confettiSpin: 5.0,
  colorConfettiA: '#f7e6f2',
  colorConfettiB: '#f2d0e8',
  colorConfettiC: '#a84f8a',
  colorConfettiD: '#3a1830',
  hazeRate: 26, // low green haze off the growing ground
  hazeSize: 0.85,
  hazeSpeed: 0.6,
  hazeLifetime: 2.4,
  hazeOpacity: 0.09,
  hazeRise: 0.3,
  colorHazeA: '#7fc85f',
  colorHazeB: '#5f9a44',
  colorHazeC: '#3d6b2c',
  colorHazeD: '#1e3418',

  /* --- what the ground does --- */
  mossRadius: 0.95, // moss mat under one flower, metres
  mossLife: 7.0, // seconds it lingers
  mossIntensity: 0.7,
  mossSpread: 1.15, // the wide mat under the whole circle, × zoneRadius
  colorMoss: '#4a7a2e',
  colorMossEdge: '#9fd06a',
  shockRadius: 5.5, // the ring pushed out when the field takes hold, metres
  colorShockA: '#c8e89a',
  colorShockB: '#ffe89a',

  /* --- the muzzle and the release --- */
  muzzleSize: 0.5, // the puff at the caster's hand, metres
  muzzleIntensity: 1.4,
  handHeight: 1.2, // metres above the floor the cast leaves from
  handForward: 0.5, // metres in front of the caster
  handSide: 0.18, // metres to the side
  castFlash: 0.08, // screen flash on release
  colorCastFlash: '#d8f0a0',
  burstSize: 3.4, // the shell thrown when the petals let go, metres
  burstIntensity: 1.1,
  burstPollen: 320, // extra pollen motes at that moment
  burstConfetti: 150, // ...and petal fragments
  impactShake: 0.35,
  shakeDuration: 0.7,
  impactFlash: 0.14,
  rumble: 0.018, // continuous shake while the growth front travels
  colorBurstA: '#e8d09a',
  colorBurstB: '#f2d0e8',
  colorBurstC: '#ffe89a',
  colorFlash: '#ffe89a',

  /* --- dynamic light --- */
  lightIntensity: 12,
  lightRadius: 11,
  lightColor: '#c8e07a',
  lightHeight: 0.75 // 0..1 of a flower's height the light sits at
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Bloomburst.
 *
 * The folder to reach for first is **The unfurl**. `unfurlCurve` is the
 * ability: at 0.4 the buds sag open the moment they clear the ground and the
 * field reads as wilting in reverse; at 1.0 they open linearly, which is the
 * dullest setting on the panel; at 2.5 they stay shut, hold, and then snap
 * open in the last third, which is what a real bud does and what the cast was
 * tuned around. The eight `bud*`/`open*` numbers are the two poses that curve
 * runs between, and they are worth dragging with **P** held.
 */
export const bloomburstSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'growth front speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['zoneRadius', 1, 14, 0.05, 'footprint radius'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['riseTime', 0.05, 2, 0.01, 'stalk rise'],
    ['waveTime', 0.05, 4, 0.01, 'wave across the circle'],
    ['waveStagger', 0, 1.5, 0.01, 'per-flower scatter'],
    ['waveInvert', 'run the wave rim-inward'],
    ['unfurlTime', 0.05, 4, 0.01, 'one bud opening'],
    ['holdTime', 0, 8, 0.05, 'hold open'],
    ['releaseTime', 0.05, 3, 0.01, 'petals letting go'],
    ['witherTime', 0.05, 5, 0.05, 'stalks folding back']
  ],
  'The field': [
    ['flowers', 1, 96, 1, 'flowers'],
    ['coreShare', 0, 1, 0.01, 'held for the middle'],
    ['innerFrac', 0, 1, 0.01, 'inner edge'],
    ['radialCurve', 0.2, 4, 0.01, 'radial crowding'],
    ['radialJitter', 0, 3, 0.01, 'radial wander'],
    ['angleJitter', 0, 1.5, 0.01, 'bearing wander']
  ],
  'One flower': [
    ['heightNear', 0.1, 5, 0.01, 'height, middle'],
    ['height', 0.1, 5, 0.01, 'height, rim'],
    ['heightCurve', 0.1, 4, 0.01, 'height curve'],
    ['heightJitter', 0, 1, 0.01, 'height jitter'],
    ['stalkRadius', 0.02, 2, 0.005, 'footprint, middle'],
    ['stalkRadiusTop', 0.02, 2, 0.005, 'footprint, rim'],
    ['radiusCurve', 0.1, 4, 0.01, 'footprint curve'],
    ['radiusJitter', 0, 1, 0.01, 'footprint jitter'],
    ['lean', -1, 1, 0.01, 'lean'],
    ['leanJitter', 0, 2, 0.01, 'lean jitter'],
    ['leanRamp', 0, 1, 0.01, 'lean ramp'],
    ['leanOutward', 0, 2, 0.01, 'lean outward'],
    ['leanForward', 0, 2, 0.01, 'lean downrange'],
    ['tilt', 0, 1, 0.01, 'random tip'],
    ['twist', 0, 1, 0.01, 'random yaw']
  ],
  'How it arrives': [
    ['riseOvershoot', 0, 1.5, 0.01, 'overshoot'],
    ['settle', 0.05, 2, 0.01, 'settle'],
    ['springRate', 1, 40, 0.5, 'spring rate'],
    ['emergeSink', 0, 1.5, 0.01, 'buried depth'],
    ['birthScale', 0.1, 1.5, 0.01, 'scale at breach'],
    ['breachAt', 0.02, 0.9, 0.01, 'breach point'],
    ['sinkDepth', 0, 3, 0.05, 'wither depth']
  ],
  'The flower/Geometry': [
    ['petals', 3, 12, 1, 'petals'],
    ['petalSegments', 2, 16, 1, 'blade segments'],
    ['stalkSides', 3, 12, 1, 'stalk sides']
  ],
  'The flower/Shape': [
    ['stemFrac', 0.05, 0.9, 0.01, 'bare stalk'],
    ['stemRadius', 0.005, 0.3, 0.005, 'stalk thickness'],
    ['heartRadius', 0.01, 0.4, 0.005, 'hinge radius'],
    ['petalWidth', 0.02, 1, 0.005, 'blade half-width'],
    ['petalWidthBias', 0.2, 3, 0.01, 'widest point'],
    ['petalTaper', 0.1, 3, 0.01, 'tip taper'],
    ['petalCrease', 0, 2, 0.01, 'lengthwise crease'],
    ['petalCup', 0, 2, 0.01, 'cross-section cup']
  ],
  'The unfurl': [
    ['unfurlCurve', 0.2, 4, 0.01, 'unfurl curve'],
    ['petalStagger', 0, 0.9, 0.01, 'petal ripple'],
    ['budMidOut', -0.4, 1, 0.005, 'bud mid, out'],
    ['budMidUp', 0, 1.2, 0.005, 'bud mid, up'],
    ['budTipOut', -0.4, 1, 0.005, 'bud tip, out'],
    ['budTipUp', 0, 1.4, 0.005, 'bud tip, up'],
    ['openMidOut', -0.4, 1.5, 0.005, 'open mid, out'],
    ['openMidUp', -0.5, 1.2, 0.005, 'open mid, up'],
    ['openTipOut', -0.4, 2, 0.005, 'open tip, out'],
    ['openTipUp', -1, 1.4, 0.005, 'open tip, up']
  ],
  'The release': [
    ['releaseThrow', 0, 4, 0.01, 'thrown outward'],
    ['releaseLift', -2, 4, 0.01, 'thrown upward'],
    ['releaseSpin', -6, 6, 0.01, 'tumble'],
    ['releaseShrink', 0, 1, 0.01, 'closes to nothing'],
    ['stemWilt', 0, 1, 0.01, 'stalk wilt']
  ],
  'Petal colour': [
    ['colorStem', 'stalk'],
    ['colorPetalBase', 'blade, hinge'],
    ['colorPetalMid', 'blade, body'],
    ['colorPetalTip', 'blade, tip'],
    ['colorVein', 'veins'],
    ['colorHeart', 'heart'],
    ['veins', 0, 2, 0.01, 'vein strength'],
    ['veinCount', 1, 16, 0.5, 'ribs across'],
    ['grain', 0, 1, 0.01, 'fibre grain'],
    ['grainScale', 0.5, 30, 0.1, 'grain scale'],
    ['fresnel', 0, 4, 0.01, 'rim'],
    ['fresnelPower', 0.5, 8, 0.05, 'rim tightness'],
    ['translucency', 0, 6, 0.01, 'backlit glow'],
    ['translucencyPower', 0.5, 16, 0.1, 'backlit tightness'],
    ['petalGlow', 0, 4, 0.01, 'glow'],
    ['edgeGlow', 0, 3, 0.01, 'rim glow'],
    ['heartGlow', 0, 8, 0.01, 'heart glow'],
    ['birthGlow', 0, 6, 0.01, 'opening flash'],
    ['petalOpacity', 0, 1, 0.01, 'opacity'],
    ['petalRoughness', 0.02, 1, 0.01, 'roughness'],
    ['envIntensity', 0, 3, 0.01, 'env intensity']
  ],
  'The pollen volume': [
    ['pollenRadius', 0.2, 3, 0.01, 'hull footprint'],
    ['pollenSwell', 1, 3, 0.01, 'swell at release'],
    ['pollenLift', 0.2, 8, 0.05, 'hull height'],
    ['pollenBase', 0, 4, 0.01, 'hull base height'],
    ['pollenHaze', 0, 1, 0.01, 'idle fade'],
    ['pollenSettle', 0, 1, 0.01, 'settle as it dies']
  ],
  ...volumeHullSchema('pollen', {
    label: 'The pollen volume',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'speck', 'colour']
  }),
  'Pollen & confetti': [
    ['pollenRate', 0, 600, 1, 'pollen rate'],
    ['pollenSize', 0.005, 0.4, 0.005, 'pollen size'],
    ['pollenSpeed', 0, 8, 0.05, 'pollen speed'],
    ['pollenLifetime', 0.1, 8, 0.05, 'pollen lifetime'],
    ['pollenDrift', -2, 4, 0.01, 'pollen drift'],
    ['pollenTurbulence', 0, 3, 0.01, 'pollen turbulence'],
    ['pollenGlow', 0, 4, 0.01, 'pollen glow'],
    ['colorPollen*', 'Pollen colour'],
    ['confettiSize', 0.005, 0.5, 0.005, 'confetti size'],
    ['confettiSpeed', 0, 20, 0.1, 'confetti speed'],
    ['confettiLifetime', 0.1, 8, 0.05, 'confetti lifetime'],
    ['confettiGravity', -20, 2, 0.1, 'confetti gravity'],
    ['confettiSpin', 0, 20, 0.1, 'confetti spin'],
    ['colorConfetti*', 'Confetti colour']
  ],
  'Green haze': [
    ['hazeRate', 0, 300, 1, 'haze rate'],
    ['hazeSize', 0.05, 4, 0.01, 'haze size'],
    ['hazeSpeed', 0, 6, 0.05, 'haze speed'],
    ['hazeLifetime', 0.2, 8, 0.05, 'haze lifetime'],
    ['hazeOpacity', 0, 1, 0.005, 'haze opacity'],
    ['hazeRise', -2, 4, 0.01, 'haze rise'],
    ['colorHaze*', 'Haze colour']
  ],
  'The ground': [
    ['mossRadius', 0.05, 4, 0.05, 'moss under a flower'],
    ['mossLife', 0.5, 20, 0.1, 'moss lifetime'],
    ['mossIntensity', 0, 2, 0.01, 'moss intensity'],
    ['mossSpread', 0.2, 3, 0.01, 'moss under the circle'],
    ['shockRadius', 0.5, 20, 0.1, 'ring radius'],
    ['colorMoss', 'moss'],
    ['colorMossEdge', 'moss edge'],
    ['colorShockA', 'ring body'],
    ['colorShockB', 'ring crest']
  ],
  'Muzzle & release': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['muzzleSize', 0.05, 5, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour'],
    ['burstSize', 0.2, 14, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['burstPollen', 0, 900, 1, 'burst pollen'],
    ['burstConfetti', 0, 600, 1, 'burst confetti'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst motes'],
    ['colorFlash', 'burst flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 2, 0.01, 'light height'],
    ['lightColor', 'light colour']
  ]
};
