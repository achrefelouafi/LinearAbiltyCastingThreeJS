import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* SPOREFALL — verdant, far cast                                       */
/* ================================================================== */
/**
 * The quietest cast in the sandbox, and the only volume in it that goes
 * **sideways**.
 *
 * Every other raymarched thing in the expansion billows: a dome, a cone, a
 * column. This one pours. A slab of spore-laden air opens on the circle, its
 * density field stretched flat in Y so every eddy in it is a pancake rather
 * than a ball, and it spreads outward across the floor and pools in the middle
 * instead of climbing. Out of it, bioluminescent motes drift up — and **die at
 * head height**.
 *
 * That death height is the ability. A mote that keeps rising turns a zone cast
 * into fog: the scene fills, the character is lost in it, and the read stops
 * being "there is something on the ground there" and becomes "the fog machine
 * is on". So `moteDeathHeight` is a real metre, and the motes genuinely stop
 * there: their lifetime is *solved* from it against the rise speed and the drag
 * every frame, written to the system's `uLifeScale`, which means dragging the
 * slider with the clock stopped re-times every mote already in the air and
 * moves the ceiling they vanish at. See `SporefallAbility#_moteLifetime`.
 *
 * The two pieces are a `VolumeHull(BOX, SPORE)` and a `GroundField(POOL)` —
 * two draw calls for the whole cast, which is the other half of "quiet".
 */
export const sporefall = {
  /* --- the cast --- */
  range: 19.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 22.0, // how fast the seep runs to the circle, metres/second
  cooldown: 1.6, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 5.4, // the footprint the indicator draws, metres

  /* --- the beats, all seconds --- */
  seepTime: 1.6, // the slab spreading from the impact point to the boundary
  holdTime: 4.5, // it lying there
  disperseTime: 2.6, // it thinning out and sinking

  /* --- the slab --- */
  // Half-extents handed to `setSize()` every frame. The hull is a BOX rather
  // than a CYLINDER because a box with `sporeRound` near 1 gives the same
  // rounded footprint for the same money *and* keeps its corners available:
  // turn the rounding down and the slab reads as a spill with a straight
  // leading edge, which is a different and useful look.
  sporeRadius: 1.0, // slab half-width, × zoneRadius
  sporeThickness: 0.62, // slab height, metres — this is the whole trick
  sporeBase: 0.0, // metres above the floor the slab starts
  sporeGather: 0.3, // footprint at the moment it lands, × the full one
  sporeHeap: 1.9, // thickness at that moment, × the full one
  sporeSink: 0.45, // 0..1 of the thickness it loses as it disperses
  sporeCreep: 0.18, // extra footprint it keeps taking while it disperses, × R
  ...volumeHullDefaults('spore', Medium.SPORE, {
    sporeSteps: 26,
    sporeDensity: 1.25,
    sporeDensityCurve: 1.3,
    sporeMargin: 0.2,
    sporeRound: 0.92,
    // Low, on purpose. A slab this thin has almost no Y to fall off across, and
    // biasing density downward inside it just makes the top half empty and the
    // silhouette a hard lid.
    sporeHeightBias: 0.12,
    sporeFeather: 0.55,
    sporeSoftness: 0.6,
    sporeNoiseFrequency: 0.95,
    sporeNoiseStrength: 0.7,
    // The pancake. `Flatten` stretches the *noise domain's* Y, so every eddy is
    // short and wide; squashing the hull alone gives a low cloud made of round
    // blobs, which reads as a cloud someone sat on.
    sporeFlatten: 0.88,
    sporeRise: 0.08,
    sporeFlowY: -0.06,
    sporeOctaves: 3,
    sporeAbsorption: 0.55,
    sporeScatter: 1.5,
    sporeAmbient: 0.5,
    sporeAnisotropy: 0.45,
    sporeEmission: 1.5,
    sporeEmissionCurve: 0.7,
    sporeSpeckDensity: 0.14,
    sporeSpeckScale: 3.0,
    sporeSpeckSize: 0.18,
    sporeSpeckGlow: 5.0,
    sporeColorCore: '#a8e8b8',
    sporeColorMid: '#7ad0a0',
    sporeColorEdge: '#2a6b4a',
    sporeColorDeep: '#0c1c14',
    sporeColorLight: '#d8ffe8',
    sporeColorSpeck: '#c8ff9a'
  }),

  /* --- the pool on the floor --- */
  poolRadius: 1.02, // × zoneRadius
  poolHeight: 0.02, // metres above the floor the quad sits at
  poolEdge: 0.55, // metres of feather on the spreading front
  poolRagged: 0.3, // how far that front wanders, as a fraction of the radius
  poolRaggedScale: 0.55, // lobes per metre
  poolWarp: 0.7, // metres of domain warp on those lobes
  poolRelief: 0.35, // how hard the height field tilts the fake normal
  poolAmbient: 0.4,
  poolSpecular: 0.55, // wet-looking, because a spore pool is damp
  poolGloss: 30,
  poolCell: 0.9, // metres — the meniscus cell pitch
  poolDepth: 0.14, // metres of apparent depth
  poolFlow: 0.12, // metres/second the surface drifts at
  poolSwirl: 0.22,
  poolDetail: 0.55,
  poolSharp: 0.35,
  poolSpeed: 0.4, // surface events per second
  poolEmissive: 0.85, // multiplier on the glowing terms
  poolOpacity: 0.9,
  poolDepthFade: 0.6, // metres of soft fade against standing geometry
  colorPoolBase: '#2a6b4a', // the liquid itself
  colorPoolEdge: '#7ad0a0', // the meniscus rim
  colorPoolGlow: '#c8ff9a', // whatever is glowing in it
  colorPoolDeep: '#08140e', // the bottom

  /* --- the motes: the thing you actually watch --- */
  /**
   * Each system is coloured by a four-stop gradient sampled over the
   * particle's own lifetime, `A` at birth through `D` as it dies. `D` matters
   * more here than anywhere else in the project: it is the colour a mote is
   * wearing at exactly the moment it reaches `moteDeathHeight`, so it is what
   * draws the ceiling.
   */
  moteRate: 34, // motes leaving the slab, particles/second
  moteSize: 0.05,
  moteRise: 1.15, // metres/second straight up, before drag
  moteDrag: 0.62, // 1/second — with the rise, this sets the terminal height
  moteSpread: 0.22, // 0..1 cone on the launch direction
  moteSpeedVariance: 0.3, // 0..1 — softens the ceiling into a layer, not a plane
  moteBirthHeight: 0.16, // metres above the floor they leave from
  moteDeathHeight: 1.85, // metres — THE slider. Head height, and it matters.
  moteSag: -0.05, // metres/second² — the whisper of gravity at the top
  moteTurbulence: 0.55,
  moteGlow: 2.2,
  moteInset: 0.92, // 0..1 of the footprint they rise from
  colorMoteA: '#e8ffd0',
  colorMoteB: '#c8ff9a',
  colorMoteC: '#7ad0a0',
  colorMoteD: '#1c4030',

  /* --- the drift: heavy air rolling off the slab's edge --- */
  driftRate: 20, // particles/second
  driftSize: 0.9,
  driftSpeed: 0.55, // metres/second, outward
  driftLifetime: 3.2,
  driftOpacity: 0.07,
  driftRise: 0.06, // metres/second² — nearly nothing, it is heavy
  driftInset: 0.85, // 0..1 of the footprint it leaves from
  colorDriftA: '#4a8a68',
  colorDriftB: '#376a50',
  colorDriftC: '#264a38',
  colorDriftD: '#12241a',

  /* --- the muzzle and the landing --- */
  handHeight: 1.18, // metres above the floor the cast leaves from
  handForward: 0.48, // metres in front of the caster
  handSide: 0.16, // metres to the side
  muzzleSize: 0.4, // the puff at the hand, metres
  muzzleIntensity: 0.9,
  castFlash: 0.04, // screen flash on release — barely anything, on purpose
  colorCastFlash: '#9fe8b0',
  burstSize: 2.2, // the low shell as the slab lands, metres
  burstIntensity: 0.7,
  burstMotes: 90, // motes released at that moment
  impactShake: 0.16,
  shakeDuration: 0.9,
  impactFlash: 0.05,
  rumble: 0.008, // continuous shake while the seep travels
  colorBurstA: '#2a6b4a',
  colorBurstB: '#7ad0a0',
  colorBurstC: '#c8ff9a',
  colorFlash: '#9fe8b0',

  /* --- dynamic light --- */
  // Deliberately weak and deliberately low. The slab is emissive on its own and
  // a strong light in the middle of it flattens the whole thing out.
  lightIntensity: 7,
  lightRadius: 9,
  lightHeight: 0.5, // metres above the floor
  lightColor: '#7ad0a0',
  lightBreathe: 0.18, // depth of the slow swell on the light, 0 = steady
  lightBreatheRate: 0.55 // swells per second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Sporefall.
 *
 * Two sliders carry the cast and they are worth finding first.
 * `moteDeathHeight`, in **The motes**, is the ceiling the glow stops at —
 * take it to four metres and watch the zone cast turn into weather, which is
 * the failure this ability is built to avoid. `sporeFlatten`, in **spore ·
 * flow**, is the pancake: take it to zero and the slab immediately reads as a
 * low cloud rather than as something pouring, with every other number
 * unchanged.
 */
export const sporefallSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 150, 1, 'seep speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['zoneRadius', 1, 16, 0.05, 'footprint radius'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['seepTime', 0.1, 6, 0.05, 'spreading out'],
    ['holdTime', 0.2, 14, 0.1, 'lying there'],
    ['disperseTime', 0.2, 8, 0.05, 'thinning out']
  ],
  'The slab': [
    ['sporeRadius', 0.2, 3, 0.01, 'half-width'],
    ['sporeThickness', 0.05, 4, 0.01, 'thickness'],
    ['sporeBase', -0.5, 3, 0.01, 'base height'],
    ['sporeGather', 0.05, 1, 0.01, 'footprint on landing'],
    ['sporeHeap', 0.5, 5, 0.01, 'thickness on landing'],
    ['sporeSink', 0, 1, 0.01, 'sink as it disperses'],
    ['sporeCreep', 0, 1, 0.01, 'creep as it disperses']
  ],
  ...volumeHullSchema('spore', {
    label: 'The slab',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'speck', 'colour']
  }),
  'The pool': [
    ['poolRadius', 0.2, 3, 0.01, 'radius'],
    ['poolHeight', 0, 0.3, 0.005, 'hover height'],
    ['poolEdge', 0.02, 3, 0.01, 'front feather'],
    ['poolRagged', 0, 1, 0.01, 'front raggedness'],
    ['poolRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['poolWarp', 0, 3, 0.01, 'domain warp'],
    ['poolRelief', 0, 2, 0.01, 'relief'],
    ['poolAmbient', 0, 1, 0.01, 'ambient'],
    ['poolSpecular', 0, 2, 0.01, 'specular'],
    ['poolGloss', 2, 128, 1, 'gloss'],
    ['poolCell', 0.05, 4, 0.01, 'cell pitch'],
    ['poolDepth', 0, 1, 0.005, 'apparent depth'],
    ['poolFlow', 0, 2, 0.01, 'surface flow'],
    ['poolSwirl', 0, 2, 0.01, 'swirl'],
    ['poolDetail', 0, 1, 0.01, 'detail'],
    ['poolSharp', 0, 1, 0.01, 'sharpness'],
    ['poolSpeed', 0, 4, 0.01, 'surface speed'],
    ['poolEmissive', 0, 3, 0.01, 'emissive'],
    ['poolOpacity', 0, 1, 0.01, 'opacity'],
    ['poolDepthFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorPoolBase', 'liquid'],
    ['colorPoolEdge', 'meniscus'],
    ['colorPoolGlow', 'glow'],
    ['colorPoolDeep', 'bottom']
  ],
  'The motes': [
    ['moteDeathHeight', 0.2, 8, 0.01, 'death height (m)'],
    ['moteBirthHeight', 0, 2, 0.01, 'birth height (m)'],
    ['moteRise', 0.05, 6, 0.01, 'rise speed (m/s)'],
    ['moteDrag', 0.05, 4, 0.01, 'drag (1/s)'],
    ['moteSag', -3, 1, 0.01, 'sag (m/s2)'],
    ['moteRate', 0, 300, 1, 'rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'size'],
    ['moteSpread', 0, 1, 0.01, 'launch cone'],
    ['moteSpeedVariance', 0, 1, 0.01, 'speed variance'],
    ['moteTurbulence', 0, 3, 0.01, 'turbulence'],
    ['moteGlow', 0, 6, 0.01, 'glow'],
    ['moteInset', 0, 1.5, 0.01, 'inset'],
    ['colorMote*', 'Mote colour']
  ],
  'The drift': [
    ['driftRate', 0, 200, 1, 'rate'],
    ['driftSize', 0.05, 4, 0.01, 'size'],
    ['driftSpeed', 0, 5, 0.05, 'speed'],
    ['driftLifetime', 0.2, 10, 0.05, 'lifetime'],
    ['driftOpacity', 0, 0.6, 0.005, 'opacity'],
    ['driftRise', -2, 2, 0.01, 'rise'],
    ['driftInset', 0, 1.5, 0.01, 'inset'],
    ['colorDrift*', 'Drift colour']
  ],
  'Muzzle & landing': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['muzzleSize', 0.05, 4, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 4, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 1, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour'],
    ['burstSize', 0.2, 10, 0.05, 'landing shell'],
    ['burstIntensity', 0, 4, 0.01, 'shell intensity'],
    ['burstMotes', 0, 500, 1, 'motes on landing'],
    ['impactShake', 0, 2, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 1, 0.01, 'screen flash'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['colorBurstA', 'shell'],
    ['colorBurstB', 'shell body'],
    ['colorBurstC', 'shell motes'],
    ['colorFlash', 'landing flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 4, 0.01, 'light height'],
    ['lightBreathe', 0, 1, 0.01, 'breathe depth'],
    ['lightBreatheRate', 0.05, 4, 0.01, 'breathe rate'],
    ['lightColor', 'light colour']
  ]
};
