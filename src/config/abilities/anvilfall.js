/* ================================================================== */
/* ANVILFALL — forge, zone cast                                        */
/* ================================================================== */
/**
 * A machined anvil falls out of the ceiling and lands on the circle.
 *
 * Everything in this block exists to sell **mass**, and mass is not a look —
 * it is a set of consequences that have to agree with one another. The three
 * that carry the read are:
 *
 *  1. **The floor dishes under it.** `vfx/GroundField.js` in `POCK` mode, with
 *     five craters posted in a line along the anvil's own base, so the dent is
 *     the shape of the thing that made it rather than a circle. The marks are
 *     unitless fractions and their positions are **re-derived every frame** —
 *     drag `anvilSize` with the clock stopped and the dent under the anvil
 *     changes length.
 *  2. **The shock is low and slow.** `vfx/Shell.js` in `PRESSURE` mode, at
 *     `shockHeight = 0.1` (a flat lens hugging the floor, not a dome),
 *     `shockExpand = 1.15` (nearly linear, so it keeps travelling instead of
 *     snapping out and easing) and `shockGlow = 0.55` in dust colours. The
 *     first pass had it at the shipped `PRESSURE` defaults — a bright fast
 *     hemisphere — and it read as a grenade going off under the anvil.
 *  3. **It stays.** Nothing about the anvil fades. It is opaque steel from the
 *     frame it lands to the frame the slot is reclaimed, and it leaves by
 *     sinking (`exitSink`), because a lump of steel that dissolves is a
 *     hologram. `fadeTime` is long on purpose: the whole point of the slot is
 *     that you get to walk round it afterwards.
 *
 * **The one number the landing is not allowed to invent.** Every consequence
 * of the impact is a function of the speed the anvil is *actually travelling
 * at* when it arrives, and that speed is read off the animation rather than
 * typed in: the height above the floor is `dropHeight · (1 − u^fallCurve)`, so
 * `v = dropHeight · fallCurve / T` where `T` is the cast's own travel time.
 * The shake, the chip speed, the dust speed, the light punch, the depth of the
 * dent and the speed of the pressure front are all derived from it against
 * `refSpeed`. Halve `dropHeight` on a paused cast and six things get quieter
 * together — which is the only way a landing ever reads as heavy, because a
 * hard shake over a slow arrival reads as a bug in the camera.
 *
 * The steel is `vfx/HardSurface.js`: brushed anisotropic specular along the
 * face, mill scale, casting pits, machined-edge wear and a real blackbody ramp
 * on `heat`. `heat` ships at 0.08 — visually stone cold, because a forge that
 * only ever produces glowing props is a fireworks shop — but it is a live
 * slider, and at 0.6 the same anvil comes out of the fire.
 */
export const anvilfall = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 26.0, // how fast the cast reaches the circle, metres/second — also the fall clock
  zoneRadius: 3.4, // the circle the anvil lands inside, metres
  cooldown: 2.4, // seconds before the slot re-arms
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws
  holdTime: 2.8, // seconds the anvil simply sits there after everything has settled
  fadeTime: 2.2, // seconds the dust, the ring and the light take to go

  /* --- the fall --- */
  dropHeight: 9.5, // metres above the floor the anvil starts
  fallCurve: 2.0, // 2 is constant gravity; 1 is a lift descending; 3 is cartoon
  driftForward: 0.0, // metres downrange of the circle's centre it lands
  driftSide: 0.0, // metres to the side (+ follows `Ability#side`)
  yawTurns: 0.28, // turns/second it rotates on the way down — slow, because it is heavy
  tilt: 0.14, // radians it is tipped over at the top of the fall
  tiltSettle: 2.6, // how fast that tilt levels out; >1 lands it flat
  refSpeed: 28.0, // metres/second the derived reads are normalised against
  settleDrop: 0.05, // metres it compresses into the floor after landing
  settleTime: 0.42, // seconds that compression takes
  exitStart: 0.55, // 0..1 of the fade before it starts sinking out of sight
  exitSink: 1.5, // metres it sinks by, × anvilSize

  /* --- the anvil, as a live shape (fractions of its own length) --- */
  anvilSize: 1.75, // metres — the geometry's longest dimension. The only metre here
  bodyHeight: 0.66, // overall height
  faceWidth: 0.5, // the working slab across
  faceDepth: 0.42, // ... and front to back
  waistWidth: 0.24, // the pinch under the face
  waistHeight: 0.3, // how much of the height the waist takes
  baseWidth: 0.56, // the foot it stands on
  hornReach: 0.46, // how far the horn projects past the face
  hornDroop: 0.07, // how far the horn's tip falls
  fillet: 0.62, // 0..1 smoothing on the silhouette — the forged look
  corner: 0.11, // 0..1 rounding on every cross-section

  /* --- the steel (vfx/HardSurface.js, canonical names, `anvil`-free) --- */
  brushMode: 0, // 0 LINEAR, 1 CIRCUMFERENTIAL, 2 RADIAL — an anvil is drawn out lengthways
  brushAxisX: 1.0, // the grain direction in the part's own space; +X is the horn
  brushAxisY: 0.0,
  brushAxisZ: 0.0,
  anisotropy: 0.82, // 0 round highlight, 1 fully smeared along the grain
  specular: 1.35, // gain on the anisotropic lobe
  grain: 0.5, // how hard the brushing cuts into roughness
  grainScale: 70.0, // grain cycles per unit of local space
  grainStretch: 30.0, // how far a streak runs along the brush direction
  roughness: 0.42, // base, before grain / pitting / wear
  metalness: 0.93,
  envIntensity: 1.0, // HDR probe gain
  millScale: 0.42, // the blue-black oxide off the forge, 0..1 coverage
  millScaleSize: 5.5, // its patch size
  millScaleSharp: 0.6, // 0 a smear, 1 a hard flake edge
  pit: 0.4, // casting pits and corrosion
  pitScale: 48.0,
  wear: 0.66, // how bright the machined edges come up
  wearGrain: 0.4, // how much the grain breaks that wear up
  heat: 0.08, // 0..1 — cold, but the slider is here and it is the forge's one knob
  heatCold: 300.0, // kelvin at heat = 0
  heatHot: 1900.0, // kelvin at heat = 1
  heatRef: 1250.0, // kelvin at which the emission term reaches 1
  heatExponent: 4.0, // Stefan-Boltzmann; 4 is the physical value
  heatGlow: 2.2, // gain on the emission
  heatTint: 0.75, // how far the albedo washes toward the hot colour
  heatEdge: 0.24, // how much cooler an edge reads — thin sections radiate faster
  colorMetal: '#8d949c', // clean steel
  colorDeep: '#33383e', // the bottom of a pit
  colorScale: '#2a2521', // mill scale
  colorPolish: '#e2e9f2', // a worn edge, where the hammer has been
  colorSpec: '#fff1de', // the anisotropic highlight's own colour

  /* --- the dent (vfx/GroundField.js, POCK) --- */
  dishRadius: 3.4, // metres — the quad and the frame the marks are fractions of
  dishDepth: 0.34, // metres the floor gives way by at refSpeed
  dishCurve: 0.8, // how the depth answers the impact speed; 1 is linear
  dishSink: 0.55, // 0..1 of that depth the anvil itself settles into
  dishFootprint: 0.72, // the line of craters, × anvilSize
  dishLift: 0.075, // metres of rim heaved up around each crater
  dishRimWidth: 0.2, // metres — how wide that rim band is
  dishMarkRadius: 0.72, // metres — radius of one full-strength crater
  dishDig: 9.0, // craters/second — how fast one digs itself in
  dishLife: 26.0, // seconds a crater weathers away over. Longer than the cast, on purpose
  dishBaseLoad: 1.0, // 0..1 crater strength under the heavy end
  dishHornLoad: 0.34, // ... and under the horn, which barely touches
  dishGrain: 0.55, // 0..1 grit across the whole dent
  dishHeight: 0.016, // metres the quad floats above the floor
  dishEdge: 0.45, // metres of feather on the growth front
  dishRagged: 0.22, // how far that front wanders, as a fraction of the radius
  dishRaggedScale: 0.6, // lobes per metre
  dishWarp: 0.55, // metres of domain warp on those lobes
  dishRelief: 0.95, // how hard the height field tilts the fake normal
  dishNormalStep: 0.05, // metres between the height taps
  dishAmbient: 0.3, // floor on the diffuse term
  dishWrap: 0.42, // 0..1 wraps the terminator round the back
  dishSpecular: 0.22, // stone dust is not glossy
  dishGloss: 16.0, // Blinn exponent
  dishParallax: 0.3, // metres of view-driven offset on interior detail
  dishEmissive: 0.35, // multiplier on the glowing term — near zero; this is a hole
  dishOpacity: 0.95,
  dishDepthFade: 0.45, // metres of soft fade against standing geometry
  colorDishBase: '#6b6155', // the churned floor
  colorDishEdge: '#a1968a', // the heaved rim
  colorDishGlow: '#c0703a', // the only warm thing in the dent — grit off hot steel
  colorDishDeep: '#241f1b', // the bottom of the bowl

  /* --- the pressure front (vfx/Shell.js, prefix `shock`, mode PRESSURE) --- */
  shockRadius: 1.4, // metres, at the instant of contact
  shockRadiusEnd: 9.5, // metres it reaches. Also the reach the front's speed is fitted to
  shockExpand: 1.15, // easing exponent — near 1 keeps it *travelling* rather than easing out
  shockHeight: 0.1, // axial extent, × radius. A flat lens on the floor, not a dome
  shockSpan: 6.0, // unused by PRESSURE; kept so the module's audit stays quiet
  shockLift: 0.05, // hover above the floor, metres
  shockDisplace: 0.07, // billow along the normal, × radius
  shockNoiseScale: 1.5, // billow features per unit radius
  shockNoiseSpeed: 0.35, // Hz the billow crawls at
  shockTurbulence: 1.0, // master on the billow
  shockFill: 0.04, // how much body it keeps — almost none, it is a pressure edge
  shockRim: 1.9, // strength of the fresnel rim
  shockRimPower: 4.0, // how tight that rim is
  shockSeal: 1.4, // DOME only; kept for the audit
  shockSealWidth: 0.12, // DOME only
  shockEdge: 1.2, // CONE only
  shockEdgeWidth: 0.16, // CONE only
  shockConeCurve: 1.0, // CONE only
  shockDissolve: 0.8, // how hard the age dissolve bites
  shockRings: 10, // RING_TRAIN only
  shockSpacing: 1.6, // RING_TRAIN only
  shockRingSpeed: 7.0, // RING_TRAIN only
  shockRingThickness: 0.16, // RING_TRAIN only
  shockRingSharp: 1.6, // RING_TRAIN only
  shockReflect: 1.0, // RING_TRAIN only
  shockStanding: 1.0, // RING_TRAIN only
  shockSwell: 0.45, // RING_TRAIN only
  shockCoronaReach: 1.8, // SUNDISC only
  shockCorona: 1.3, // SUNDISC only
  shockCoronaLength: 0.55, // SUNDISC only
  shockCoronaScale: 5.0, // SUNDISC only
  shockCoronaWarp: 0.45, // SUNDISC only
  shockCoronaSpeed: 0.7, // SUNDISC only
  shockCoronaSharp: 0.72, // SUNDISC only
  shockGranule: 0.45, // SUNDISC only
  shockGranuleScale: 6.0, // SUNDISC only
  shockRimWidth: 0.18, // SUNDISC only
  shockOpacity: 0.5, // a pressure front you can see through
  shockGlow: 0.55, // deliberately dim: this is displaced air and dust, not light
  shockSoftFade: 0.7, // metres of depth fade against the opaque scene
  shockColorBody: '#3b332a', // the body, such as it is
  shockColorRim: '#c9b69c', // the rim — dust colour, never white
  shockColorEdge: '#efe3ce', // the hottest mark it has
  shockColorCorona: '#ffb44a', // SUNDISC only
  shockSpeedRatio: 0.34, // the front travels at this fraction of the anvil's arrival speed
  shockDelay: 0.0, // seconds after contact the front starts, if you want a beat

  /* --- dust, chips and sparks --- */
  /**
   * Three systems, each with its own four-stop lifetime gradient (I5). The
   * dust is non-additive because a plume thrown up by something heavy has to
   * *occlude* — an additive plume reads as the anvil landing in fog.
   */
  dustCount: 190, // puffed out of the rim on contact
  dustRate: 55, // particles/second still rolling off the dent afterwards
  dustSize: 1.15,
  dustSpeed: 5.5, // metres/second at refSpeed; scaled by the real arrival speed
  dustLifetime: 2.8,
  dustRise: 0.5, // upward drift, metres/second
  dustOpacity: 0.2,
  dustTurbulence: 0.6,
  dustHeight: 0.22, // metres above the floor it is emitted from
  colorDustA: '#8f8477',
  colorDustB: '#6d6459',
  colorDustC: '#4c4640',
  colorDustD: '#2b2723',
  chipCount: 120, // floor chips spat out from under it
  chipSize: 0.07,
  chipSpeed: 7.5, // metres/second at refSpeed
  chipLifetime: 1.5,
  chipGravity: -22.0,
  chipSpray: 0.85, // 0 straight up, 1 flat out along the floor
  colorChipA: '#5c534a',
  colorChipB: '#443d36',
  colorChipC: '#332e29',
  colorChipD: '#221f1c',
  sparkCount: 60, // struck sparks — steel on stone, and hotter if `heat` is up
  sparkSize: 0.1,
  sparkSpeed: 6.0,
  sparkLifetime: 0.55,
  sparkGravity: -16.0,
  sparkStretch: 0.16, // how far a spark smears along its velocity
  sparkHeatTint: 0.85, // 0..1 how far the blackbody colour of the steel tints them
  colorSparkA: '#ffd9a8',
  colorSparkB: '#ff9e42',
  colorSparkC: '#c2521c',
  colorSparkD: '#3a1a0c',

  /* --- feedback --- */
  impactShake: 1.6, // camera kick at refSpeed
  shakeDuration: 0.95, // seconds it decays over — long and low, not a snap
  shakeFrequency: 11.0, // Hz. A heavy landing is a low frequency, and this is the tell
  impactFlash: 0.05, // screen flash. Almost nothing: steel does not flash
  colorFlash: '#d8c8ae',
  rumble: 0.02, // continuous shake while the anvil is still falling
  settleRumble: 0.05, // ... and while the dust is rolling off it

  /* --- the dynamic light --- */
  lightIntensity: 9.0,
  lightRadius: 12.0,
  lightHeight: 0.9, // metres above the floor the light sits once it has landed
  lightColor: '#c08a52'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Anvilfall.
 *
 * Reach for **The fall** first. `dropHeight` and `fallCurve` are the two
 * controls the whole ability hangs off, because the arrival speed derived from
 * them drives the shake, the dent, the front and both particle speeds at once
 * — and `refSpeed` is what "hard enough" means, so lowering it makes every
 * landing count as heavy. After that, **The dent** (`dishDepth`,
 * `dishFootprint`) is where the mass actually reads, and **The steel** is a
 * whole material editor: `heat` alone takes the same anvil from cold grey to
 * welding orange.
 */
export const anvilfallSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 4, 120, 0.5, 'cast speed'],
    ['zoneRadius', 1, 12, 0.05, 'zone radius'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['holdTime', 0.2, 10, 0.05, 'hold after landing'],
    ['fadeTime', 0.2, 8, 0.05, 'fade time'],
    ['castAnim', 'cast animation']
  ],
  'The fall': [
    ['dropHeight', 1, 30, 0.1, 'drop height (m)'],
    ['fallCurve', 0.6, 4, 0.01, 'fall curve'],
    ['driftForward', -6, 6, 0.05, 'drift downrange (m)'],
    ['driftSide', -6, 6, 0.05, 'drift sideways (m)'],
    ['yawTurns', -2, 2, 0.01, 'yaw (turns/s)'],
    ['tilt', 0, 1, 0.005, 'tilt at the top (rad)'],
    ['tiltSettle', 0.2, 8, 0.05, 'tilt settle'],
    ['refSpeed', 4, 90, 0.5, 'reference speed (m/s)'],
    ['settleDrop', 0, 0.5, 0.005, 'compression (m)'],
    ['settleTime', 0.05, 3, 0.01, 'compression time'],
    ['exitStart', 0, 1, 0.01, 'sink starts at'],
    ['exitSink', 0, 6, 0.05, 'sink depth × size']
  ],
  'The anvil': [
    ['anvilSize', 0.3, 6, 0.01, 'length (m)'],
    ['bodyHeight', 0.2, 1.6, 0.01, 'height'],
    ['faceWidth', 0.1, 1.2, 0.01, 'face width'],
    ['faceDepth', 0.1, 1.2, 0.01, 'face depth'],
    ['waistWidth', 0.05, 0.9, 0.01, 'waist width'],
    ['waistHeight', 0.05, 0.8, 0.01, 'waist height'],
    ['baseWidth', 0.1, 1.4, 0.01, 'base width'],
    ['hornReach', 0, 1.2, 0.01, 'horn reach'],
    ['hornDroop', 0, 0.4, 0.005, 'horn droop'],
    ['fillet', 0, 1, 0.01, 'forge fillet'],
    ['corner', 0, 0.9, 0.01, 'section rounding']
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
    ['colorPolish', 'worn edge'],
    ['colorSpec', 'highlight']
  ],
  'The steel/Heat': [
    ['heat', 0, 1, 0.005, 'heat'],
    ['heatCold', 100, 900, 5, 'cold (K)'],
    ['heatHot', 900, 2600, 5, 'hot (K)'],
    ['heatRef', 400, 2400, 5, 'emission ref (K)'],
    ['heatExponent', 0.5, 8, 0.05, 'emission exponent'],
    ['heatGlow', 0, 8, 0.01, 'emission gain'],
    ['heatTint', 0, 1, 0.01, 'albedo wash'],
    ['heatEdge', 0, 1, 0.01, 'edge cooling']
  ],
  'The dent': [
    ['dishRadius', 0.5, 14, 0.05, 'dent radius (m)'],
    ['dishDepth', 0, 2, 0.005, 'depth at ref (m)'],
    ['dishCurve', 0.2, 3, 0.01, 'depth vs speed'],
    ['dishSink', 0, 1, 0.01, 'anvil settles into'],
    ['dishFootprint', 0, 2, 0.01, 'footprint × size'],
    ['dishLift', 0, 0.5, 0.005, 'rim height (m)'],
    ['dishRimWidth', 0.02, 1, 0.005, 'rim width (m)'],
    ['dishMarkRadius', 0.05, 4, 0.01, 'crater radius (m)'],
    ['dishDig', 0.5, 40, 0.1, 'dig rate'],
    ['dishLife', 1, 60, 0.5, 'weathering (s)'],
    ['dishBaseLoad', 0, 1, 0.01, 'load, heavy end'],
    ['dishHornLoad', 0, 1, 0.01, 'load, horn end'],
    ['dishGrain', 0, 1, 0.01, 'grit']
  ],
  'The dent/Shading': [
    ['dishHeight', 0, 0.2, 0.001, 'float above floor (m)'],
    ['dishEdge', 0.02, 3, 0.01, 'front feather (m)'],
    ['dishRagged', 0, 1, 0.01, 'front wander'],
    ['dishRaggedScale', 0.05, 4, 0.01, 'lobes / m'],
    ['dishWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['dishRelief', 0, 3, 0.01, 'relief'],
    ['dishNormalStep', 0.005, 0.4, 0.005, 'normal step (m)'],
    ['dishAmbient', 0, 1, 0.01, 'ambient'],
    ['dishWrap', 0, 1, 0.01, 'terminator wrap'],
    ['dishSpecular', 0, 2, 0.01, 'specular'],
    ['dishGloss', 1, 96, 1, 'gloss'],
    ['dishParallax', 0, 1.5, 0.01, 'parallax (m)'],
    ['dishEmissive', 0, 3, 0.01, 'emissive'],
    ['dishOpacity', 0, 1, 0.01, 'opacity'],
    ['dishDepthFade', 0, 3, 0.01, 'depth fade (m)'],
    ['colorDishBase', 'churned floor'],
    ['colorDishEdge', 'heaved rim'],
    ['colorDishGlow', 'hot grit'],
    ['colorDishDeep', 'bowl']
  ],
  'The pressure front': [
    ['shockRadius', 0.05, 20, 0.01, 'start radius (m)'],
    ['shockRadiusEnd', 0.5, 40, 0.05, 'reach (m)'],
    ['shockSpeedRatio', 0.02, 2, 0.005, 'front speed / arrival'],
    ['shockDelay', 0, 1.5, 0.01, 'delay after contact (s)'],
    ['shockExpand', 0.6, 8, 0.01, 'expansion curve'],
    ['shockHeight', 0.02, 2, 0.005, 'height × radius'],
    ['shockLift', -1, 2, 0.005, 'lift (m)'],
    ['shockDisplace', 0, 1.5, 0.005, 'billow'],
    ['shockNoiseScale', 0.1, 10, 0.01, 'billow scale'],
    ['shockNoiseSpeed', 0, 4, 0.01, 'billow Hz'],
    ['shockTurbulence', 0, 3, 0.01, 'turbulence'],
    ['shockFill', 0, 1, 0.005, 'body fill'],
    ['shockRim', 0, 4, 0.01, 'rim'],
    ['shockRimPower', 0.1, 10, 0.01, 'rim power'],
    ['shockDissolve', 0, 2, 0.01, 'dissolve'],
    ['shockOpacity', 0, 1, 0.01, 'opacity'],
    ['shockGlow', 0, 6, 0.01, 'glow'],
    ['shockSoftFade', 0, 3, 0.01, 'soft fade (m)'],
    ['shockColorBody', 'front body'],
    ['shockColorRim', 'front rim'],
    ['shockColorEdge', 'front edge']
  ],
  'Dust & chips': [
    ['dustCount', 0, 600, 1, 'dust on contact'],
    ['dustRate', 0, 400, 1, 'dust rate after'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 25, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustRise', -2, 5, 0.01, 'dust rise'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['dustHeight', 0, 2, 0.01, 'dust height (m)'],
    ['chipCount', 0, 400, 1, 'chips'],
    ['chipSize', 0.005, 0.4, 0.005, 'chip size'],
    ['chipSpeed', 0, 30, 0.1, 'chip speed'],
    ['chipLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['chipGravity', -60, 0, 0.5, 'chip gravity'],
    ['chipSpray', 0, 1, 0.01, 'chip flatness'],
    ['colorDust*', 'Dust colour'],
    ['colorChip*', 'Chip colour']
  ],
  'Sparks': [
    ['sparkCount', 0, 400, 1, 'sparks'],
    ['sparkSize', 0.005, 0.6, 0.005, 'spark size'],
    ['sparkSpeed', 0, 30, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 3, 0.01, 'spark lifetime'],
    ['sparkGravity', -60, 5, 0.5, 'spark gravity'],
    ['sparkStretch', 0, 2, 0.01, 'spark stretch'],
    ['sparkHeatTint', 0, 1, 0.01, 'blackbody tint'],
    ['colorSpark*', 'Spark colour']
  ],
  'Feedback': [
    ['impactShake', 0, 5, 0.01, 'shake at ref'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['shakeFrequency', 2, 40, 0.5, 'shake Hz'],
    ['impactFlash', 0, 1, 0.005, 'screen flash'],
    ['rumble', 0, 0.4, 0.002, 'fall rumble'],
    ['settleRumble', 0, 0.4, 0.002, 'settle rumble'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 5, 0.01, 'light height (m)'],
    ['lightColor', 'light colour']
  ],
  'Unused modes (kept for the Shell audit)': [
    ['shockSpan', 0.1, 40, 0.05, 'span'],
    ['shockSeal', 0, 4, 0.01, 'seal'],
    ['shockSealWidth', 0.01, 0.6, 0.01, 'seal width'],
    ['shockEdge', 0, 4, 0.01, 'cone lip'],
    ['shockEdgeWidth', 0.01, 0.8, 0.01, 'cone lip width'],
    ['shockConeCurve', 0.1, 4, 0.01, 'cone curve'],
    ['shockRings', 1, 48, 1, 'rings'],
    ['shockSpacing', 0.1, 12, 0.01, 'spacing'],
    ['shockRingSpeed', 0, 40, 0.05, 'ring speed'],
    ['shockRingThickness', 0.01, 2, 0.01, 'ring thickness'],
    ['shockRingSharp', 0.05, 8, 0.01, 'ring profile'],
    ['shockReflect', 0, 1, 0.01, 'reflection'],
    ['shockStanding', 0, 1, 0.01, 'standing wave'],
    ['shockSwell', 0, 2, 0.01, 'antinode swell'],
    ['shockCoronaReach', 1, 4, 0.01, 'corona reach'],
    ['shockCorona', 0, 4, 0.01, 'corona'],
    ['shockCoronaLength', 0, 3, 0.01, 'corona length'],
    ['shockCoronaScale', 0.5, 20, 0.1, 'corona scale'],
    ['shockCoronaWarp', 0, 2, 0.01, 'corona warp'],
    ['shockCoronaSpeed', 0, 4, 0.01, 'corona Hz'],
    ['shockCoronaSharp', 0, 0.98, 0.01, 'corona threshold'],
    ['shockGranule', 0, 2, 0.01, 'granulation'],
    ['shockGranuleScale', 0.5, 24, 0.1, 'granule scale'],
    ['shockRimWidth', 0.01, 0.6, 0.01, 'rim band'],
    ['shockColorCorona', 'corona']
  ]
};
