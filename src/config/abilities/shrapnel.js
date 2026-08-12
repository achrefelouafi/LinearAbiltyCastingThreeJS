/* ================================================================== */
/* SHRAPNEL BLOOM — forge, zone cast                                   */
/* ================================================================== */
/**
 * A machined canister is thrown at the circle and comes apart into plates and
 * bolts, and the plates and bolts **bounce**.
 *
 * **The tell this block exists to defeat.** Every shatter in the sandbox up to
 * now has ended the same way: a fragment reaches the floor and stops dead,
 * because `vfx/ShatterField.js` clamps `y` and keeps a fraction of the tumble.
 * That is right for ice and for stone, which shatter and stay shattered. It is
 * wrong for steel, and it is the single thing that separates a burst from a
 * shatter — real fragments hit hard ground and *skitter*. So this slot solves
 * the flight as a piecewise ballistic with a real restitution at every
 * contact, keeps the tumble running through the bounce, and only lets the
 * piece slide to a stop when its rebound falls below `stopSpeed`.
 *
 * `restitution` is therefore the headline slider, and it is worth dragging it
 * from 0 to 0.7 with the clock stopped: at 0 you get every other shatter in
 * the project, and every step above it moves the whole scatter outward,
 * because a fragment that bounces travels further.
 *
 * **The first bounce lands on the circle.** The throw speed is not typed in —
 * it is fitted to the aim indicator. For a ballistic launch at `elevation`,
 * `R = v²·sin(2θ)/g`, so `v = √(R·g / sin 2θ)` with `R = zoneRadius`, and the
 * fragments touch down on the ring the player was shown. The craters they
 * leave (`vfx/GroundField.js` in `POCK`) are posted at those touchdowns and
 * their positions are re-derived every frame, so the pockmarks re-place
 * themselves when `zoneRadius`, `elevation`, `gravity` or `speedScale` move.
 * A ring of dents at the edge of the circle and a scatter of steel *past* it
 * is the whole picture, and both halves come from the same three numbers.
 *
 * The steel is `vfx/HardSurface.js` — real plate geometry with counterbored
 * bolt holes, real hex bolts with a helical thread, brushed anisotropic
 * specular, and a blackbody ramp on `heat` that runs a genuine cooling curve
 * (`heat = heatStart · e^(−coolRate·t)`) from white-hot at the burst to cold
 * grey by the time the pieces have stopped moving. Nothing fades: they are
 * lumps of metal, and at the very end of the cast the floor they are lying on
 * simply drops out from under them (`exitSink`).
 */
export const shrapnel = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.5, // closer than this and the cast is refused
  speed: 34.0, // how fast the canister flies to the circle, metres/second
  zoneRadius: 5.0, // the ring the first bounces land on, metres. Drives the throw speed
  cooldown: 2.0, // seconds before the slot re-arms
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws
  holdTime: 2.4, // seconds the field is left alone after everything has stopped
  fadeTime: 2.4, // seconds the dust and the light take to go

  /* --- the canister on its way there --- */
  canisterSize: 0.55, // metres — its longest dimension
  canisterApex: 2.4, // metres the throw arcs above the straight line
  canisterHeight: 1.15, // metres above the floor it leaves the caster at
  canisterSpin: 5.5, // radians/second it tumbles end over end
  canisterLength: 2.0, // × head width — the bolt proportions, live
  canisterHead: 0.68, // head height, fraction of the head width
  canisterShank: 0.34, // shank radius, fraction of the head width
  canisterThread: 8.0, // full turns of thread over the threaded length
  canisterWasher: 0.09, // flange under the head; 0 for none

  /* --- the throw --- */
  fragCount: 56, // fragments thrown (capped at 96)
  elevation: 0.62, // radians above the horizontal the sheaf leaves at
  speedScale: 1.0, // multiplier on the range-fitted speed. 1 lands them on the ring
  speedJitter: 0.32, // ± fraction
  spread: 0.26, // 0 every fragment on its ideal arc, 1 fully random
  gravity: -20.0, // metres/second²
  chargeRadius: 0.3, // metres of scatter on where a fragment starts
  chargeHeight: 0.55, // metres above the floor the canister opens at
  fragLifetime: 6.5, // seconds a fragment lives. Longer than the cast, on purpose

  /* --- the ricochet: the whole point --- */
  restitution: 0.44, // 0..1 of the into-floor speed that comes back out
  friction: 0.28, // 0..1 of the along-floor speed lost at each contact
  tumbleKeep: 0.82, // 0..1 of the tumble rate that survives a contact
  bounces: 4, // contacts before the next one is treated as dead
  stopSpeed: 0.65, // metres/second — a rebound slower than this settles instead
  slide: 3.2, // 1/second the along-floor speed decays at once settled
  groundSpin: 0.24, // 0..1 of the tumble rate kept while sliding
  seat: 0.34, // × the fragment's size — how far its centre rests above the floor
  exitSink: 0.7, // metres the floor drops by at the end of the cast

  /* --- the fragments --- */
  fragSize: 0.19, // metres, the unit geometry's scale
  fragSizeJitter: 0.5, // ± fraction
  fragShrink: 0.0, // 0..1 of its size lost by the end of life. Steel does not shrink
  fragShrinkPower: 1.6, // how late that shrink bites
  fragSpin: 13.0, // radians/second of tumble at birth
  fragSpinJitter: 0.75, // ± fraction
  plateWidth: 1.0, // the torn plate: in-plane extents, relative to each other
  plateDepth: 0.62,
  plateThickness: 0.15, // unit lengths
  plateBevel: 0.04, // unit lengths, 45° break round the whole outline
  plateCorner: 0.13, // fraction of the short side, corner radius
  plateBolts: 2, // 0, 2, 4 or 6 — holes left in the fragment
  plateBoltRadius: 0.08, // fraction of the short side
  boltLength: 1.7, // the bolt fragment: × head width across flats
  boltHead: 0.6, // head height, fraction of the head width
  boltShank: 0.3, // shank radius, fraction of the head width
  boltThread: 6.0, // full turns over the threaded length
  boltThreadDepth: 0.04, // radial, fraction of the head width

  /* --- the steel (vfx/HardSurface.js, canonical names) --- */
  brushMode: 1, // 0 LINEAR, 1 CIRCUMFERENTIAL, 2 RADIAL — turned parts, so round the axis
  brushAxisX: 0.0, // the grain direction in the part's own space
  brushAxisY: 1.0,
  brushAxisZ: 0.0,
  anisotropy: 0.74, // 0 round highlight, 1 fully smeared along the grain
  specular: 1.6, // gain on the anisotropic lobe
  grain: 0.6, // how hard the brushing cuts into roughness
  grainScale: 110.0, // grain cycles per unit of local space
  grainStretch: 22.0, // how far a streak runs along the brush direction
  roughness: 0.34, // base, before grain / pitting / wear
  metalness: 0.95,
  envIntensity: 1.0, // HDR probe gain
  millScale: 0.24, // the blue-black oxide, 0..1 coverage — fresh steel, so not much
  millScaleSize: 8.0, // its patch size
  millScaleSharp: 0.62, // 0 a smear, 1 a hard flake edge
  pit: 0.28, // casting pits and corrosion
  pitScale: 90.0,
  wear: 0.72, // how bright the machined edges come up
  wearGrain: 0.36, // how much the grain breaks that wear up
  heatStart: 0.72, // 0..1 heat the fragments leave the burst at
  coolRate: 0.55, // 1/second — Newton's law, and the whole cooling curve
  heatCold: 300.0, // kelvin at heat = 0
  heatHot: 2100.0, // kelvin at heat = 1
  heatRef: 1250.0, // kelvin at which the emission term reaches 1
  heatExponent: 4.0, // Stefan-Boltzmann; 4 is the physical value
  heatGlow: 2.6, // gain on the emission
  heatTint: 0.8, // how far the albedo washes toward the hot colour
  heatEdge: 0.26, // how much cooler an edge reads — thin sections radiate faster
  colorMetal: '#949aa1', // clean steel
  colorDeep: '#383d43', // the bottom of a pit
  colorScale: '#2c2724', // mill scale
  colorPolish: '#e8eef6', // a torn edge, bright where the metal let go
  colorSpec: '#fff2e0', // the anisotropic highlight's own colour

  /* --- the craters the first bounces leave (GroundField, POCK) --- */
  pockRadius: 8.0, // metres — the quad, and the frame the marks are fractions of
  pockDepth: 0.11, // metres a crater goes down by
  pockLift: 0.03, // metres of rim heaved up around it
  pockRimWidth: 0.09, // metres — how wide that rim band is
  pockMarkRadius: 0.34, // metres — radius of one full-strength crater
  pockDig: 22.0, // craters/second — how fast one digs itself in. Fast: this is a strike
  pockLife: 24.0, // seconds a crater weathers away over
  pockLoad: 0.8, // 0..1 strength of one crater
  pockGrain: 0.42, // 0..1 grit across the field
  pockHeight: 0.014, // metres the quad floats above the floor
  pockEdge: 0.6, // metres of feather on the growth front
  pockRagged: 0.18, // how far that front wanders, as a fraction of the radius
  pockRaggedScale: 0.5, // lobes per metre
  pockWarp: 0.6, // metres of domain warp on those lobes
  pockRelief: 1.1, // how hard the height field tilts the fake normal
  pockNormalStep: 0.035, // metres between the height taps
  pockAmbient: 0.3, // floor on the diffuse term
  pockWrap: 0.4, // 0..1 wraps the terminator round the back
  pockSpecular: 0.3, // struck stone has a little sheen where it is fresh
  pockGloss: 22.0, // Blinn exponent
  pockParallax: 0.18, // metres of view-driven offset on interior detail
  pockEmissive: 0.9, // multiplier on the glowing term — the scorch a hot fragment leaves
  pockOpacity: 0.92,
  pockDepthFade: 0.4, // metres of soft fade against standing geometry
  colorPockBase: '#6e655a', // the struck floor
  colorPockEdge: '#9d9184', // the chipped rim
  colorPockGlow: '#d9702c', // where a hot fragment touched
  colorPockDeep: '#231f1b', // the bottom of the nick

  /* --- sparks and smoke --- */
  /**
   * Two systems, each with its own four-stop lifetime gradient (I5). The
   * sparks are additive and are tinted by the *blackbody colour of the steel*
   * rather than by a hard-coded orange — see `_sparkTint` in the ability, and
   * `HardSurface`'s own note on why a cherry-red fragment must not throw
   * lemon-yellow sparks.
   */
  burstSparks: 260, // sparks thrown by the detonation itself
  bounceSparks: 9, // ... and by one fragment striking the floor
  sparkSize: 0.12,
  sparkSpeed: 8.0,
  sparkLifetime: 0.5,
  sparkGravity: -19.0,
  sparkStretch: 0.22, // how far a spark smears along its velocity
  sparkHeatTint: 0.9, // 0..1 how far the steel's blackbody colour tints them
  colorSparkA: '#fff0d2',
  colorSparkB: '#ffb257',
  colorSparkC: '#d05a1c',
  colorSparkD: '#41190a',
  smokeCount: 70, // puffed out by the detonation
  smokeSize: 0.9,
  smokeSpeed: 4.0,
  smokeLifetime: 2.4,
  smokeRise: 0.7, // upward drift, metres/second
  smokeOpacity: 0.16,
  smokeTurbulence: 0.7,
  colorSmokeA: '#8a8176',
  colorSmokeB: '#645c53',
  colorSmokeC: '#433e39',
  colorSmokeD: '#26221f',

  /* --- feedback --- */
  burstSize: 1.9, // the detonation shell, metres
  burstIntensity: 1.5,
  colorBurstA: '#c9531d', // shell
  colorBurstB: '#ffb257', // body
  colorBurstC: '#fff0d2', // arcs
  impactShake: 0.85,
  shakeDuration: 0.5,
  shakeFrequency: 22.0, // Hz. Sharp and bright — the opposite of the anvil
  impactFlash: 0.16,
  colorFlash: '#ffd9a8',
  rumble: 0.015, // continuous shake while the canister is in the air

  /* --- the dynamic light --- */
  lightIntensity: 20.0,
  lightRadius: 14.0,
  lightHeight: 0.7, // metres above the floor the light sits after the burst
  lightColor: '#ff9440'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Shrapnel Bloom.
 *
 * **The ricochet** is the folder to open first, and `restitution` is the
 * slider — at 0 this ability is every other shatter in the project, and it is
 * worth seeing that once. `bounces`, `friction` and `stopSpeed` between them
 * decide whether the pieces skitter to the far wall or rattle once and lie
 * down. After that, **The throw**: `zoneRadius` and `elevation` are what the
 * speed is fitted to, so they move the whole bloom and the ring of craters
 * with it, and `spread` is how tidy that ring is allowed to be.
 */
export const shrapnelSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 4, 140, 0.5, 'throw speed'],
    ['zoneRadius', 1, 16, 0.05, 'zone radius'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['holdTime', 0.2, 10, 0.05, 'hold after burst'],
    ['fadeTime', 0.2, 8, 0.05, 'fade time'],
    ['castAnim', 'cast animation']
  ],
  'The ricochet': [
    ['restitution', 0, 0.95, 0.005, 'restitution'],
    ['friction', 0, 1, 0.005, 'tangential loss'],
    ['tumbleKeep', 0, 1, 0.005, 'tumble kept / bounce'],
    ['bounces', 0, 8, 1, 'bounces'],
    ['stopSpeed', 0.05, 4, 0.01, 'settle speed (m/s)'],
    ['slide', 0, 20, 0.05, 'slide decay (1/s)'],
    ['groundSpin', 0, 1, 0.01, 'tumble while sliding'],
    ['seat', 0, 1, 0.01, 'rest height × size'],
    ['exitSink', 0, 4, 0.01, 'floor drop at the end (m)']
  ],
  'The throw': [
    ['fragCount', 1, 96, 1, 'fragments'],
    ['elevation', 0.08, 1.45, 0.005, 'launch angle (rad)'],
    ['speedScale', 0.2, 2.5, 0.01, 'speed × fitted'],
    ['speedJitter', 0, 1.5, 0.01, 'speed jitter'],
    ['spread', 0, 1, 0.01, 'direction scatter'],
    ['gravity', -60, -1, 0.5, 'gravity'],
    ['chargeRadius', 0, 2, 0.01, 'origin scatter (m)'],
    ['chargeHeight', 0, 3, 0.01, 'burst height (m)'],
    ['fragLifetime', 0.5, 14, 0.1, 'fragment lifetime']
  ],
  'The canister': [
    ['canisterSize', 0.05, 2, 0.01, 'size (m)'],
    ['canisterApex', 0, 10, 0.05, 'throw arc (m)'],
    ['canisterHeight', 0, 3, 0.01, 'release height (m)'],
    ['canisterSpin', -20, 20, 0.1, 'tumble (rad/s)'],
    ['canisterLength', 0.6, 5, 0.01, 'length'],
    ['canisterHead', 0.2, 1.4, 0.01, 'head height'],
    ['canisterShank', 0.1, 0.5, 0.005, 'shank radius'],
    ['canisterThread', 0, 24, 0.5, 'thread turns'],
    ['canisterWasher', 0, 0.3, 0.005, 'flange']
  ],
  'The fragments': [
    ['fragSize', 0.02, 1, 0.005, 'size (m)'],
    ['fragSizeJitter', 0, 1.5, 0.01, 'size jitter'],
    ['fragShrink', 0, 1, 0.01, 'shrink'],
    ['fragShrinkPower', 0.2, 5, 0.01, 'shrink curve'],
    ['fragSpin', 0, 40, 0.1, 'tumble (rad/s)'],
    ['fragSpinJitter', 0, 1.5, 0.01, 'tumble jitter']
  ],
  'The fragments/Plate': [
    ['plateWidth', 0.2, 2, 0.01, 'width'],
    ['plateDepth', 0.2, 2, 0.01, 'depth'],
    ['plateThickness', 0.02, 0.6, 0.005, 'thickness'],
    ['plateBevel', 0, 0.2, 0.002, 'bevel'],
    ['plateCorner', 0, 0.5, 0.005, 'corner radius'],
    ['plateBolts', 0, 6, 2, 'holes'],
    ['plateBoltRadius', 0.01, 0.2, 0.002, 'hole radius']
  ],
  'The fragments/Bolt': [
    ['boltLength', 0.6, 5, 0.01, 'length'],
    ['boltHead', 0.2, 1.4, 0.01, 'head height'],
    ['boltShank', 0.1, 0.5, 0.005, 'shank radius'],
    ['boltThread', 0, 24, 0.5, 'thread turns'],
    ['boltThreadDepth', 0, 0.12, 0.002, 'thread depth']
  ],
  'The steel/Brushing': [
    ['brushMode', 0, 2, 1, 'grain mode'],
    ['brushAxisX', -1, 1, 0.01, 'grain axis X'],
    ['brushAxisY', -1, 1, 0.01, 'grain axis Y'],
    ['brushAxisZ', -1, 1, 0.01, 'grain axis Z'],
    ['anisotropy', 0, 1, 0.01, 'anisotropy'],
    ['specular', 0, 5, 0.01, 'specular gain'],
    ['grain', 0, 2, 0.01, 'grain depth'],
    ['grainScale', 4, 300, 1, 'grain scale'],
    ['grainStretch', 1, 120, 0.5, 'grain stretch']
  ],
  'The steel/Surface': [
    ['roughness', 0.02, 1, 0.01, 'roughness'],
    ['metalness', 0, 1, 0.01, 'metalness'],
    ['envIntensity', 0, 3, 0.01, 'probe gain'],
    ['millScale', 0, 1, 0.01, 'mill scale'],
    ['millScaleSize', 0.5, 30, 0.1, 'scale patch size'],
    ['millScaleSharp', 0, 1, 0.01, 'scale flake edge'],
    ['pit', 0, 1, 0.01, 'pitting'],
    ['pitScale', 4, 240, 1, 'pit scale'],
    ['wear', 0, 1, 0.01, 'edge wear'],
    ['wearGrain', 0, 1, 0.01, 'wear break-up'],
    ['colorMetal', 'steel'],
    ['colorDeep', 'pit floor'],
    ['colorScale', 'mill scale'],
    ['colorPolish', 'torn edge'],
    ['colorSpec', 'highlight']
  ],
  'The steel/Heat': [
    ['heatStart', 0, 1, 0.005, 'heat at the burst'],
    ['coolRate', 0, 6, 0.01, 'cooling (1/s)'],
    ['heatCold', 100, 900, 5, 'cold (K)'],
    ['heatHot', 900, 2600, 5, 'hot (K)'],
    ['heatRef', 400, 2400, 5, 'emission ref (K)'],
    ['heatExponent', 0.5, 8, 0.05, 'emission exponent'],
    ['heatGlow', 0, 8, 0.01, 'emission gain'],
    ['heatTint', 0, 1, 0.01, 'albedo wash'],
    ['heatEdge', 0, 1, 0.01, 'edge cooling']
  ],
  'The craters': [
    ['pockRadius', 1, 24, 0.1, 'field radius (m)'],
    ['pockDepth', 0, 1, 0.002, 'depth (m)'],
    ['pockLift', 0, 0.3, 0.002, 'rim height (m)'],
    ['pockRimWidth', 0.01, 0.6, 0.002, 'rim width (m)'],
    ['pockMarkRadius', 0.02, 2, 0.005, 'crater radius (m)'],
    ['pockDig', 0.5, 60, 0.5, 'dig rate'],
    ['pockLife', 1, 60, 0.5, 'weathering (s)'],
    ['pockLoad', 0, 1, 0.01, 'crater strength'],
    ['pockGrain', 0, 1, 0.01, 'grit']
  ],
  'The craters/Shading': [
    ['pockHeight', 0, 0.2, 0.001, 'float above floor (m)'],
    ['pockEdge', 0.02, 3, 0.01, 'front feather (m)'],
    ['pockRagged', 0, 1, 0.01, 'front wander'],
    ['pockRaggedScale', 0.05, 4, 0.01, 'lobes / m'],
    ['pockWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['pockRelief', 0, 3, 0.01, 'relief'],
    ['pockNormalStep', 0.005, 0.4, 0.005, 'normal step (m)'],
    ['pockAmbient', 0, 1, 0.01, 'ambient'],
    ['pockWrap', 0, 1, 0.01, 'terminator wrap'],
    ['pockSpecular', 0, 2, 0.01, 'specular'],
    ['pockGloss', 1, 96, 1, 'gloss'],
    ['pockParallax', 0, 1.5, 0.01, 'parallax (m)'],
    ['pockEmissive', 0, 3, 0.01, 'emissive'],
    ['pockOpacity', 0, 1, 0.01, 'opacity'],
    ['pockDepthFade', 0, 3, 0.01, 'depth fade (m)'],
    ['colorPockBase', 'struck floor'],
    ['colorPockEdge', 'chipped rim'],
    ['colorPockGlow', 'scorch'],
    ['colorPockDeep', 'the nick']
  ],
  'Sparks & smoke': [
    ['burstSparks', 0, 900, 1, 'burst sparks'],
    ['bounceSparks', 0, 60, 1, 'sparks / bounce'],
    ['sparkSize', 0.005, 0.6, 0.005, 'spark size'],
    ['sparkSpeed', 0, 30, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 3, 0.01, 'spark lifetime'],
    ['sparkGravity', -60, 5, 0.5, 'spark gravity'],
    ['sparkStretch', 0, 2, 0.01, 'spark stretch'],
    ['sparkHeatTint', 0, 1, 0.01, 'blackbody tint'],
    ['smokeCount', 0, 400, 1, 'smoke'],
    ['smokeSize', 0.05, 4, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 20, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime'],
    ['smokeRise', -2, 5, 0.01, 'smoke rise'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['smokeTurbulence', 0, 3, 0.01, 'smoke turbulence'],
    ['colorSpark*', 'Spark colour'],
    ['colorSmoke*', 'Smoke colour']
  ],
  'Feedback': [
    ['burstSize', 0.1, 12, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['impactShake', 0, 4, 0.01, 'shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration'],
    ['shakeFrequency', 2, 60, 0.5, 'shake Hz'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.4, 0.002, 'throw rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst arcs'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 100, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 45, 0.1, 'light radius'],
    ['lightHeight', 0, 5, 0.01, 'light height (m)'],
    ['lightColor', 'light colour']
  ]
};
