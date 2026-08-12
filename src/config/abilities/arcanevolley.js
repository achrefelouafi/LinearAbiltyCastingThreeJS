/* ================================================================== */
/* ARCANE VOLLEY — arcane, line                                        */
/* ================================================================== */
/**
 * Seven bolts that weave apart and land on one point at one instant.
 *
 * They gather at the hand first, circling it while the cast winds up; then they
 * go, each on its own Lissajous figure, crossing each other the whole way; then
 * every one of them arrives at the same place on the same frame and the volley
 * lands as a single hit.
 *
 * **Nothing about that is simulated.** The convergence is `(1 − τ)^weaveDecay`
 * multiplying the weave: identically zero at the target, so no bolt has
 * anywhere else to be. There is no homing, no steering and no correction, which
 * is why the whole flight re-shapes under a slider with the clock stopped.
 *
 * The four numbers that carry it:
 *
 *  - `weaveSide` / `weaveUp` — how far apart the bolts get. Unequal on purpose:
 *    equal amplitudes on a 1:1-ish ratio draw circles, and a volley of circles
 *    reads as a drill bit.
 *  - `weaveTurns` — a multiplier on every bolt's frequency *pair*. The ratios
 *    themselves are a fixed table in `materials/VolleyMaterial.js`; this scales
 *    all seven together, so the weave gets busier without becoming uniform.
 *  - `weaveDecay` — where the bolts give up their spread. Below 1 they hold it
 *    late and snap in at the end; above 2 they are practically converged
 *    half-way and the last third is a straight line.
 *  - `trailSpan` — seconds of flight a trail reaches back over. The trails are
 *    the read; the heads are deliberately tiny.
 */
export const arcanevolley = {
  /* --- the cast --- */
  range: 24.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 34.0, // how fast the volley crosses the span, metres/second
  charge: 0.5, // seconds the bolts circle the hand before they go
  lifetime: 0.35, // seconds the spent trails hang after the volley lands
  fadeTime: 0.55, // seconds they blow out over
  cooldown: 0.75,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the bolts gather --- */
  handHeight: 1.32, // metres above the floor
  handForward: 0.55, // metres in front of the caster
  handSide: 0.2, // metres to the side (+ follows `Ability#side`)
  endHeight: 0.85, // metres above the floor where all seven arrive

  /* --- the wind-up --- */
  // While the cast is charging, a bolt's τ is pinned at zero and its weave
  // phase is *rotated* instead — so it traces the τ = 0 slice of its own
  // Lissajous figure, which is a small loop around the hand. At release the
  // rotation stops and the identical offset simply starts travelling.
  orbitTurns: 1.25, // turns each bolt makes around the hand over the whole wind-up
  orbitStart: 0.22, // how tight the ring is when the bolts appear, × full spread
  chargeCurve: 0.8, // <1 opens the ring early, >1 keeps it tight then flings it out
  chargeShake: 0.02, // continuous camera shake while it winds up

  /* --- the weave --- */
  bolts: 7, // bolts in the volley (capped at 8)
  // These two are also the radius of the ring the bolts gather on, because the
  // gather *is* the flight at tau = 0 — see the wind-up note above. At 2.1 m the
  // ring was wider than the caster and read as an orbit of the whole body
  // rather than of a hand, so they came down until the ring was about an arm's
  // length and the weave still crossed itself four or five times on the way out.
  weaveSide: 1.15, // metres of lateral throw at launch
  weaveUp: 0.75, // metres of vertical throw at launch
  weaveTurns: 1.0, // multiplier on every bolt's frequency pair
  weavePhase: 1.5708, // radians the vertical weave leads the lateral by
  weaveDecay: 1.45, // >0 pulls the weave to exactly zero at the target
  pathCurve: 1.0, // easing on launch → land; >1 accelerates into the hit

  /* --- the trails --- */
  trailSpan: 0.34, // seconds of flight one trail reaches back over
  trailBurn: 0.3, // seconds the tail takes to catch the head up after landing
  trailWidth: 0.14, // half-width at the head, metres
  trailTaper: 1.5, // >1 sharpens the tail to a point
  trailCoreSharp: 2.4, // how hard the hot core falls off across the ribbon
  trailCoreWidth: 0.36, // fraction of the ribbon the core occupies
  trailHaloFalloff: 2.4, // how fast the halo fades across the rest of it
  trailHaloOpacity: 0.6,
  trailFlicker: 0.09, // depth of the per-bolt brightness blink
  trailFlickerSpeed: 20, // blinks/second
  trailGlow: 2.1, // emissive gain into bloom
  trailOpacity: 1.0,
  trailSoftFade: 0.5, // metres of soft fade where a trail meets geometry
  colorTrailA: '#2a1a4a', // the tail — the four stops run tail → head, not
  colorTrailB: '#8a5fd0', // birth → death, because a ribbon *is* the history
  colorTrailC: '#e0c0ff',
  colorTrailD: '#ffffff', // the head

  /* --- the heads --- */
  headSize: 0.13, // radius of the billboard, metres. Small: the trails are the read
  headCoreSharp: 3.6, // how tight the white centre is
  headSoft: 1.1, // falloff of the bloom around it
  headGlow: 2.4, // emissive gain
  headOpacity: 1.0,
  headSoftFade: 0.35, // metres of soft fade against geometry
  colorHeadCore: '#ffffff',
  colorHeadRim: '#a274ff',

  /* --- motes, sparks and dust --- */
  /**
   * Each system is coloured by a four-stop gradient over the particle's own
   * lifetime, `A` at birth through `D` as it dies. The motes get their own
   * palette rather than the trail's, so the gather can be made colder than the
   * bolts it is feeding.
   */
  intakeRate: 220, // motes drawn into the hand while it winds up, particles/second
  moteRate: 90, // motes shed along the trails in flight, particles/second
  moteShell: 1.5, // radius the intake motes appear at, metres
  moteSize: 0.055,
  moteSpeed: 1.1,
  moteLifetime: 1.1,
  moteRise: 0.35, // upward drift, metres/second
  moteSwirl: 3.4, // radians/second the intake orbits the hand
  moteSwirlExpand: -0.55, // <0 draws the orbit inward as the mote ages
  moteTurbulence: 0.45,
  colorMoteA: '#ffffff',
  colorMoteB: '#d9c0ff',
  colorMoteC: '#8a5fd0',
  colorMoteD: '#170e2e',
  sparkSize: 0.13,
  sparkSpeed: 8.5,
  sparkLifetime: 0.5,
  sparkGravity: -12.0,
  sparkStretch: 0.22, // how far a spark smears along its velocity
  burstSparks: 190, // sparks thrown by the combined impact
  colorSparkA: '#ffffff',
  colorSparkB: '#efe0ff',
  colorSparkC: '#9a6fe0',
  colorSparkD: '#241a52',
  dustSize: 1.0,
  dustSpeed: 1.3,
  dustLifetime: 1.9,
  dustRise: 0.45,
  dustOpacity: 0.07,
  burstDust: 45, // puffs kicked off the floor by the impact
  colorDustA: '#463a5e',
  colorDustB: '#38304c',
  colorDustC: '#2c263c',
  colorDustD: '#191524',

  /* --- what the ground does --- */
  scorchRadius: 0.65, // burn under the convergence point, metres
  scorchLife: 5.0, // seconds it lingers
  scorchIntensity: 0.38,
  shockRadius: 5.5, // impact shockwave ring, metres
  colorScorch: '#151024',
  colorEmber: '#a86bff',
  colorShockA: '#d9c0ff', // body of the shockwave ring
  colorShockB: '#ffffff', // its crest

  /* --- the muzzle and the impact --- */
  muzzleSize: 0.6, // the flash at the hand as the volley leaves, metres
  muzzleIntensity: 1.6,
  castFlash: 0.08, // screen flash on release
  colorMuzzleA: '#8a5fd0',
  colorMuzzleB: '#d9c0ff',
  colorMuzzleC: '#ffffff',
  colorCastFlash: '#d9c0ff',
  burstSize: 3.0, // the shell where all seven land, metres
  burstIntensity: 1.6,
  impactShake: 0.75,
  shakeDuration: 0.5,
  impactFlash: 0.26,
  rumble: 0.015, // continuous shake while the volley is in the air
  colorBurstA: '#8a5fd0',
  colorBurstB: '#c9a4ff',
  colorBurstC: '#ffffff',
  colorFlash: '#e6d5ff', // the full-screen flash on impact

  /* --- dynamic light --- */
  lightIntensity: 20,
  lightRadius: 14,
  lightColor: '#b98cff',
  lightPulse: 0.22, // depth of the light's breathing, 0 = steady
  lightPulseSpeed: 3.1 // Hz
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Arcane Volley.
 *
 * `The weave` is the folder. Everything in it is a uniform on both the trail
 * and the head shader, so dragging any of it re-flies seven bolts that are
 * already in the air — including at `dt = 0`, which is the point. The one to
 * try first is `weaveDecay`: it is the difference between a volley that snaps
 * together at the last moment and one that has already given up by half-way.
 */
export const arcanevolleySchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 0.5, 'volley speed'],
    ['charge', 0, 3, 0.01, 'wind-up'],
    ['lifetime', 0.05, 6, 0.01, 'hold after landing'],
    ['fadeTime', 0.05, 4, 0.01, 'blow-out time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where they gather': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['endHeight', 0, 4, 0.01, 'height at target'],
    ['orbitTurns', 0, 6, 0.01, 'turns while held'],
    ['orbitStart', 0, 1, 0.01, 'ring at spawn'],
    ['chargeCurve', 0.1, 4, 0.01, 'ring opening curve'],
    ['chargeShake', 0, 0.3, 0.005, 'wind-up shake']
  ],
  'The weave': [
    ['bolts', 1, 8, 1, 'bolts'],
    ['weaveSide', 0, 8, 0.01, 'lateral throw (m)'],
    ['weaveUp', 0, 8, 0.01, 'vertical throw (m)'],
    ['weaveTurns', 0, 4, 0.01, 'frequency multiplier'],
    ['weavePhase', 0, 6.29, 0.01, 'vertical lead (rad)'],
    ['weaveDecay', 0.1, 6, 0.01, 'convergence curve'],
    ['pathCurve', 0.2, 4, 0.01, 'approach easing']
  ],
  'The trails': [
    ['trailSpan', 0.02, 1.5, 0.01, 'reach back (s)'],
    ['trailBurn', 0.02, 2, 0.01, 'catch-up (s)'],
    ['trailWidth', 0.005, 0.8, 0.005, 'width at head'],
    ['trailTaper', 0.1, 6, 0.01, 'tail taper'],
    ['trailCoreSharp', 0.2, 10, 0.05, 'core sharpness'],
    ['trailCoreWidth', 0.02, 1, 0.01, 'core width'],
    ['trailHaloFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['trailHaloOpacity', 0, 2, 0.01, 'halo opacity'],
    ['trailFlicker', 0, 1, 0.01, 'bolt blink'],
    ['trailFlickerSpeed', 1, 90, 1, 'blink rate'],
    ['trailGlow', 0, 8, 0.01, 'glow'],
    ['trailOpacity', 0, 2, 0.01, 'opacity'],
    ['trailSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorTrail*', 'Trail colour (tail → head)']
  ],
  'The heads': [
    ['headSize', 0.01, 1, 0.005, 'head radius (m)'],
    ['headCoreSharp', 0.2, 10, 0.05, 'core sharpness'],
    ['headSoft', 0.1, 6, 0.05, 'bloom falloff'],
    ['headGlow', 0, 8, 0.01, 'glow'],
    ['headOpacity', 0, 2, 0.01, 'opacity'],
    ['headSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorHeadCore', 'head core'],
    ['colorHeadRim', 'head bloom']
  ],
  'Motes, sparks & dust': [
    ['intakeRate', 0, 900, 1, 'intake rate'],
    ['moteRate', 0, 600, 1, 'shed rate'],
    ['moteShell', 0.1, 6, 0.05, 'intake shell (m)'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 12, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 8, 0.05, 'mote rise'],
    ['moteSwirl', -12, 12, 0.05, 'intake swirl (rad/s)'],
    ['moteSwirlExpand', -2, 2, 0.01, 'intake in/out'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['sparkSize', 0.005, 0.8, 0.005, 'spark size'],
    ['sparkSpeed', 0, 40, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 4, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['burstSparks', 0, 600, 1, 'impact sparks'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 8, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['burstDust', 0, 300, 1, 'impact dust'],
    ['colorMote*', 'Mote colour'],
    ['colorSpark*', 'Spark colour'],
    ['colorDust*', 'Dust colour']
  ],
  'The ground': [
    ['scorchRadius', 0.05, 4, 0.05, 'scorch radius'],
    ['scorchLife', 0.5, 20, 0.1, 'scorch lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'scorch intensity'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    'colorScorch',
    'colorEmber',
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest']
  ],
  'Muzzle & impact': [
    ['muzzleSize', 0.05, 6, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorMuzzleA', 'muzzle shell'],
    ['colorMuzzleB', 'muzzle body'],
    ['colorMuzzleC', 'muzzle arcs'],
    ['colorCastFlash', 'release flash colour'],
    ['burstSize', 0.2, 14, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst arcs'],
    ['colorFlash', 'impact flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'light breathing'],
    ['lightPulseSpeed', 0, 12, 0.01, 'breathing Hz'],
    ['lightColor', 'light colour']
  ]
};
