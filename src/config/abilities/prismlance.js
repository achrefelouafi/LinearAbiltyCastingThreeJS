/* ================================================================== */
/* PRISM LANCE — arcane, line                                          */
/* ================================================================== */
/**
 * White light in, spectrum out.
 *
 * A lance of white light is wound up in the hand and let out along the aimed
 * line — but it does not reach the target. Part-way down the span a refracting
 * solid is hanging in the air, and the lance ends *there*. What continues is a
 * fan of coloured child beams that leave the prism at slightly different
 * angles, bow apart, and converge again exactly where the white lance was
 * pointed. Then the solid cracks, and the fan whitens as it dies.
 *
 * Three of the numbers below carry the whole read and are the ones to reach
 * for first:
 *
 *  - `prismAt` — where along the span the solid floats. Drag it while the cast
 *    is standing and the split point slides; the lance and the fan re-cut
 *    against each other because neither of them owns a length.
 *  - `fanSpread` — how far the children bow off the axis at mid-span.
 *  - `fanDispersion` — the *ordering*. It ramps the throw from the first child
 *    to the last, so the fan opens like a spectrum rather than like six beams
 *    pointing six ways. At 1 every child bends the same amount and the fan is a
 *    tube; at 0 the whole fan collapses onto the axis, which is what a prism
 *    with no dispersion in it should do.
 *
 * The white lance is a `vfx/Tube` under the `lance` prefix, so all seventy-nine
 * of its keys are sliders here for free. The prism and the fan are bespoke —
 * `materials/PrismMaterial.js` — because neither a refracting solid nor a
 * per-instance-hue beam fan exists in the library, and both are the point.
 */
export const prismlance = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  // Slower than the Storm Lance on purpose. At 105 m/s the split happens 40 ms
  // before the impact and the fan never exists as a separate beat; at 46 the
  // white half and the coloured half each get about a fifth of a second, which
  // is the least you can show someone and have them see two things.
  speed: 46.0, // how fast the front travels once it is released, metres/second
  charge: 0.42, // seconds the lance winds up in the hand before it goes
  lifetime: 0.7, // seconds the fan holds after it lands
  fadeTime: 0.85, // seconds the prism cracks and the fan whitens out over
  cooldown: 0.8,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the lance leaves the caster --- */
  handHeight: 1.3, // metres above the floor
  handForward: 0.6, // metres in front of the caster
  handSide: 0.18, // metres to the side (+ follows `Ability#side`)
  endHeight: 0.5, // metres above the floor where the fan converges

  /* --- the charge --- */
  chargeStub: 0.22, // fraction of the way to the prism the wind-up glow creeps
  chargeSwell: 0.55, // how much narrower the lance is at the start of the charge, ×
  chargeShake: 0.02, // continuous camera shake while it winds up

  /* --- the solid --- */
  // A triangular bipyramid: three faces up, three down, no smooth normals
  // anywhere on it. `prismRadius` is the equator, `prismLength` the half-height,
  // so a tall thin prism is `length` up and `radius` down.
  prismAt: 0.46, // where the solid floats, fraction of the span
  prismHeight: 1.45, // metres above the floor
  prismRadius: 0.38, // equator radius, metres
  prismLength: 0.62, // apex half-height, metres
  prismSpin: 0.35, // revolutions/second about its own axis
  prismTilt: 0.34, // radians it leans out of vertical
  prismBob: 0.09, // metres it rises and falls by
  prismBobSpeed: 0.7, // Hz of that bob
  prismSwell: 1.18, // how much bigger it gets while the lance is in it, ×
  prismIor: 1.62, // index of refraction of the body
  prismDispersion: 0.055, // how far the red and blue indices sit either side of it
  prismFresnelPower: 2.6, // how tight the grazing-angle rim is
  prismFresnelScale: 1.15, // how strong it is
  prismEnvIntensity: 1.0, // gain on the environment probe
  prismEnvMix: 0.62, // 0 = the two sky pickers only, 1 = the equirect only
  prismFacet: 0.55, // strength of the interior veining
  prismFacetScale: 5.5, // veining features per metre of the solid's own space
  prismGlow: 1.5, // emissive gain into bloom
  prismOpacity: 0.34, // how solid it reads away from the rim
  prismLoadGlow: 1.9, // how hard it blazes while the lance is striking it
  prismCrackTime: 0.55, // seconds the fracture takes to eat the whole solid
  prismCrackScale: 5.0, // fracture cells per metre
  prismCrackEdge: 0.14, // width of the glowing lip of a fracture
  prismCrackGlow: 2.6, // brightness of that lip
  colorPrismBody: '#d7e4ff', // what the refracted room is tinted with
  colorPrismRim: '#ffffff', // the grazing-angle rim
  colorPrismFire: '#ffd6ff', // the interior veins, the load glow and the cracks
  colorPrismSkyUp: '#5a6b96', // fallback room, upward — used when no equirect is bound
  colorPrismSkyDown: '#0a0a14', // fallback room, downward

  /* --- the fan of children --- */
  children: 6, // child beams (capped at 8; six is the spectrum)
  fanSpread: 0.95, // metres the fan bows off the axis at mid-span
  fanDispersion: 2.4, // throw of the last child ÷ the first — the spectral order
  fanBow: 1.0, // where the bulge sits; >1 pushes it toward the target
  fanBowCurve: 1.0, // >1 tightens the bulge into a shorter arc
  fanSpin: 0.1, // revolutions/second the whole fan rolls about the axis
  fanWave: 0.1, // travelling ripple on the throw, × the throw
  fanWaveScale: 2.2, // ripples along the span
  fanWaveSpeed: 1.0, // Hz they travel at
  fanWidth: 0.16, // half-width of one child's ribbon at the prism, metres
  fanWidthTip: 0.62, // that width at the target, as a fraction
  fanCoreSharp: 2.8, // how hard the hot core falls off across the ribbon
  fanCoreWidth: 0.32, // fraction of the ribbon the core occupies
  fanHaloFalloff: 2.6, // how fast the halo fades across the rest of it
  fanHaloOpacity: 0.55,
  fanTipGlow: 1.5, // extra heat on the leading edge while it extends
  fanTipLength: 0.07, // length of that leading edge, fraction of the span
  fanFlicker: 0.1, // depth of the per-child brightness blink
  fanFlickerSpeed: 22, // blinks/second
  fanGlow: 2.2, // emissive gain
  fanOpacity: 1.0,
  fanSoftFade: 0.5, // metres of soft fade where a child meets geometry
  fanCollapse: 1.6, // >1 holds the colour late and whitens all at once
  colorChild1: '#ff4d5e', // the spectrum, spelled out. Eight pickers for eight
  colorChild2: '#ff9a3c', // possible children; `children` decides how many draw
  colorChild3: '#ffe066',
  colorChild4: '#69e07a',
  colorChild5: '#4fd6ff',
  colorChild6: '#7a7bff',
  colorChild7: '#c46bff',
  colorChild8: '#ff6be0',
  colorFanCore: '#ffffff', // the hot centre line every child shares
  colorCollapse: '#ffffff', // what the fan whitens back to as it dies

  /* --- the prism chips (vfx/ShatterField) --- */
  chipCount: 96, // fragments thrown when the solid lets go
  chipScatter: 0.24, // metres of spawn scatter about the solid
  chipSpeed: 4.6, // metres/second
  chipSpeedJitter: 0.7, // ± fraction of that
  chipSpread: 0.7, // 0 throws every chip downrange, 1 is fully random
  chipUpBias: 0.35, // how much +Y is folded into the throw
  chipGravity: -14.0, // metres/second²
  chipDrag: 1.1, // 1/second
  chipSize: 0.17, // metres
  chipSizeJitter: 0.65, // ± fraction
  chipShrink: 0.75, // fraction of its size a chip loses by the end of life
  chipShrinkPower: 1.7, // how late that shrink bites
  chipSpin: 12.0, // radians/second of tumble
  chipSpinJitter: 0.8, // ± fraction
  chipLifetime: 1.5, // seconds a chip lives
  chipFloorSpin: 0.2, // fraction of the tumble kept once it is on the floor
  chipGlow: 1.5, // emissive gain on a chip
  chipRim: 0.9, // strength of its rim term
  chipRimPower: 2.2, // how tight that rim is
  chipOpacity: 0.9,
  chipFadeStart: 0.55, // fraction of its life before it starts fading
  chipShade: 0.9, // how much the fake lighting darkens a facing-away face
  chipAmbient: 0.4, // floor under that shading
  colorChipA: '#ffffff', // a chip's lit face
  colorChipB: '#8fa8ff', // its shaded face
  colorChipEdge: '#ffd6ff', // its rim
  colorChipScene: '#c0d0ff', // what it tints the scene sample with, when there is one

  /* --- spectral motes, sparks and dust --- */
  /**
   * Each system is coloured by a four-stop gradient over the particle's own
   * lifetime, `A` at birth through `D` as it dies. Spelled out per system
   * rather than derived from the beam palette, so the motes can be made to cool
   * to violet while the sparks stay white.
   */
  moteRate: 110, // motes shed by the solid, particles/second
  moteSize: 0.06,
  moteSpeed: 1.3,
  moteLifetime: 1.5,
  moteRise: 0.5, // upward drift, metres/second
  moteTurbulence: 0.6,
  colorMoteA: '#ffffff',
  colorMoteB: '#d9c0ff',
  colorMoteC: '#7a7bff',
  colorMoteD: '#1a1240',
  sparkSize: 0.14,
  sparkSpeed: 8.0,
  sparkLifetime: 0.55,
  sparkGravity: -11.0,
  sparkStretch: 0.2, // how far a spark smears along its velocity
  splitSparks: 70, // sparks thrown at the moment the lance enters the prism
  burstSparks: 150, // ... and at the impact
  crackSparks: 90, // ... and when the solid cracks
  colorSparkA: '#ffffff',
  colorSparkB: '#ffe9ff',
  colorSparkC: '#9f8bff',
  colorSparkD: '#241a52',
  dustSize: 1.0,
  dustSpeed: 1.2,
  dustLifetime: 2.0,
  dustRise: 0.5,
  dustOpacity: 0.07,
  burstDust: 40, // puffs kicked up where the fan converges
  colorDustA: '#4a4a68',
  colorDustB: '#3a3a52',
  colorDustC: '#2e2e42',
  colorDustD: '#1a1a26',

  /* --- what the ground does --- */
  scorchRadius: 0.7, // pale burn under the convergence point, metres
  scorchLife: 5.5, // seconds it lingers
  scorchIntensity: 0.4,
  shockRadius: 6.0, // impact shockwave ring, metres
  colorScorch: '#141020',
  colorEmber: '#b08aff',
  colorShockA: '#e3d0ff', // body of the shockwave ring
  colorShockB: '#ffffff', // its crest

  /* --- the muzzle, the split and the impact --- */
  muzzleSize: 0.5, // the flash at the hand as the lance leaves it, metres
  muzzleIntensity: 1.7,
  castFlash: 0.09, // screen flash on release
  colorMuzzleA: '#b9c8ff',
  colorMuzzleB: '#e8f0ff',
  colorMuzzleC: '#ffffff',
  colorCastFlash: '#e8f0ff',
  splitSize: 1.5, // the shell that pops off the solid as the lance enters, metres
  splitIntensity: 1.8,
  splitFlash: 0.14, // screen flash at the split
  colorSplitA: '#ff9ae0',
  colorSplitB: '#9fd0ff',
  colorSplitC: '#ffffff',
  burstSize: 2.6, // the shell where the fan converges, metres
  burstIntensity: 1.5,
  impactShake: 0.6,
  shakeDuration: 0.5,
  impactFlash: 0.22,
  rumble: 0.02, // continuous shake while the front travels
  colorBurstA: '#c58aff',
  colorBurstB: '#9fe0ff',
  colorBurstC: '#ffffff',
  colorFlash: '#efe0ff', // the full-screen flash on impact

  /* --- dynamic light --- */
  lightIntensity: 22,
  lightRadius: 15,
  lightColor: '#cbb4ff',
  lightPulse: 0.18, // depth of the light's breathing, 0 = steady
  lightPulseSpeed: 2.4, // Hz

  /* --- the white lance (vfx/Tube, prefix `lance`) --- */
  /**
   * `Tube` reads its numbers by prefixed key off this very block, so these
   * seventy-nine are the tube's whole contract and every one of them is a
   * slider for free.
   *
   * They are spelled out rather than spread from `tubeDefaults('lance')` on
   * purpose, and the reason is in the header of `config/abilities/index.js`: a
   * settings module must not import anything beyond a constant. `vfx/Tube.js`
   * imports `config/settings.js` for its `settings.global` default argument,
   * and importing it from here closes a cycle that leaves `settings.js`
   * spreading an `ABILITY_SETTINGS` that has not been initialised yet — which
   * fails at load with a `ReferenceError`, not at review. (`vfx/VolumeHull.js`
   * imports no such thing, which is why Pyroclasm's block may spread its
   * defaults and this one may not.)
   *
   * The list mirrors `TUBE_FIELDS` in `vfx/Tube.js` and must stay in step with
   * it; `Tube` names any key it cannot find, once, on the console. The
   * WHIP/FUNNEL/VINE/ARC groups are here because `sync()` resolves every field
   * whatever the path is — this lance is STRAIGHT and reads none of them.
   *
   * Overridden away from the tube's defaults on three counts: it is thin, it is
   * white, and it does not flare. A lance that opens out at the far end reads
   * as arriving somewhere, and this one is supposed to be interrupted.
   */

  /* --- the radius profile (STRAIGHT / WHIP / ARC) --- */
  lanceRadius: 0.3, // half-width at the far end, metres
  lanceRadiusNear: 0.14, // half-width at the muzzle, metres
  lanceRadiusCurve: 0.85, // <1 opens early, >1 stays thin then opens late
  lanceFlare: 0, // extra half-width where it lands, × radius
  lanceFlareWidth: 0.12, // how much of the far end flares, fraction of length
  lanceThrob: 0.04, // breathing amplitude, × radius
  lanceThrobScale: 2.4, // pressure waves along the column, cycles per length
  lanceThrobSpeed: 1.6, // Hz they travel at

  /* --- the axis --- */
  lanceWander: 0.03, // smooth low-frequency drift of the axis, metres
  lanceWanderScale: 0.9, // drift features per length
  lanceWanderSpeed: 0.7, // Hz the drift crawls at

  /* --- the surface --- */
  lanceRipple: 0.07, // radial break-up of the barrel, × radius
  lanceRippleBands: 1.6, // break-up features around the barrel
  lanceRippleScale: 3.2, // break-up features along it
  lanceRippleSpeed: 2.4, // Hz it crawls downrange at
  lanceStreak: 0.7, // filaments streaming down the surface
  lanceStreakSharp: 0.45, // 0 = soft wash, 1 = hard threads
  lanceStreakScale: 7, // filament features per length
  lanceStreakBands: 2.6, // filament features around the barrel
  lanceStreakGlow: 1.1, // how hard the sheath's filaments burn to core colour
  lanceFlowSpeed: 9, // metres-of-parameter per second the filaments run
  lanceBands: 0.0, // rings along the length, cycles per length (0 = off)
  lanceBandSharp: 2.0, // how tight each ring is
  lanceBandDepth: 0.5, // how much they modulate alpha, 0..1
  lanceBandSpeed: 0.6, // Hz they travel at

  /* --- the three layers --- */
  lanceCoreWidth: 0.42, // core radius, × the profile
  lanceCoreFill: 0.95, // how solid the core reads
  lanceCoreSharp: 1.4, // axis-weighting exponent — the inversion
  lanceEdgePower: 2.2, // rim-weighting exponent for the sheath
  lanceSheathWidth: 1.0, // sheath radius, × the profile
  lanceSheathRim: 0.9, // strength of the sheath's silhouette
  lanceSheathFill: 0.18, // how much body the sheath keeps
  lanceSheathOpacity: 0.8,
  lanceHaloWidth: 2.1, // halo radius, × the profile
  lanceHaloRim: 3.4, // rim exponent — high, so it is only a silhouette
  lanceHaloOpacity: 0.42,

  /* --- the ends --- */
  lanceMuzzleGlow: 2, // brightness where the column leaves the caster
  lanceMuzzleLength: 0.1, // how far that glow reaches, fraction of length
  lanceTipGlow: 2.2, // brightness of the leading edge
  lanceTipLength: 0.05, // how soft that edge is, fraction of length

  /* --- WHIP --- */
  lanceWaveRate: 1.35, // loops per second travelling handle → tip
  lanceWaveWidth: 0.16, // how tight the loop is, fraction of length
  lanceWaveAmp: 0.3, // lateral throw of the loop, fraction of length
  lanceWaveGain: 2.2, // how much the loop grows on its way to the tip, ×
  lanceWaveCurve: 1.6, // when that growth happens, >1 = late
  lanceWaveRoll: 0.0, // plane the loop cracks in, radians (0 = vertical)
  lanceSag: 0.12, // how far the whip hangs under its own weight, metres
  lanceCrackRatio: 1.0, // tip speed ÷ wave speed at which the crack fires

  /* --- FUNNEL --- */
  lanceThroat: 0.55, // the vortex waist, metres
  lanceSkirtFlare: 1.6, // extra radius at the floor, metres
  lanceSkirtHeight: 0.24, // how far up the skirt reaches, fraction of height
  lanceSkirtCurve: 1.7, // how abruptly it flares, >1 = tighter to the floor
  lanceMouthFlare: 2.4, // extra radius at the top, metres
  lanceMouthStart: 0.55, // where the mouth begins to open, fraction of height
  lanceMouthCurve: 1.4, // how abruptly it opens
  lanceSpin: 0.9, // revolutions per second the surface rotates
  lanceSpinTwist: 1.6, // extra revolutions from floor to mouth
  lanceSway: 0.35, // how far the axis precesses, metres
  lanceSwayScale: 0.5, // twist of the precession along the height
  lanceSwaySpeed: 0.25, // revolutions per second it precesses
  lanceSwayCurve: 1.8, // how much of the sway is at the top, >1 = only the top

  /* --- VINE --- */
  lanceTipTaper: 1.3, // how fast the radius falls to zero at the front
  lanceMeander: 0.18, // helical wander of the stem, metres
  lanceMeanderTurns: 1.4, // turns of that helix over the length
  lanceRecoilAmp: 0.35, // how far the spring pulls the tip back, fraction
  lanceRecoilFreq: 2.6, // Hz the spring rings at
  lanceRecoilDamp: 3.4, // s⁻¹ it dies at
  lanceRecoilSway: 0.6, // lateral bow while it is recoiling, metres

  /* --- ARC --- */
  lanceArcHeight: 2.6, // apex height above the chord, metres
  lanceArcLateral: 0.0, // apex offset across the chord, metres
  lanceArcBias: 0.5, // where the apex sits, 0..1 along the chord
  lanceArcCurve: 1.0, // >1 pinches the apex, <1 flattens the top

  /* --- rendering --- */
  lanceOpacity: 1.0,
  lanceGlow: 2.4, // emissive gain into bloom
  lanceSoftFade: 0.6, // metres of depth fade against the opaque scene

  /* --- colour (I5: four pickers, none derived from another) --- */
  lanceColorCore: '#ffffff', // the axis-weighted middle
  lanceColorInner: '#f2f4ff', // just off the middle
  lanceColorOuter: '#c8d4ff', // the sheath body
  lanceColorHalo: '#6070c8' // the outer bloom
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */

/**
 * Prism Lance.
 *
 * The folders are ordered the way the cast happens: the hand, then the solid,
 * then what leaves it, then what it breaks into. Everything in `The solid` and
 * `The fan` is read by a shader on the frame it changes, so both folders
 * reshape a cast that is already standing — pause with **P** part-way down the
 * line and drag `prismAt` to watch the split slide.
 */
export const prismlanceSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 300, 1, 'lance speed'],
    ['charge', 0, 3, 0.01, 'wind-up'],
    ['lifetime', 0.05, 6, 0.01, 'hold after landing'],
    ['fadeTime', 0.05, 4, 0.01, 'collapse time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where it leaves the hand': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['endHeight', 0, 4, 0.01, 'height at target'],
    ['chargeStub', 0, 1, 0.01, 'wind-up creep'],
    ['chargeSwell', 0.05, 1, 0.01, 'wind-up width'],
    ['chargeShake', 0, 0.3, 0.005, 'wind-up shake']
  ],
  'The solid': [
    ['prismAt', 0.05, 0.95, 0.01, 'position along span'],
    ['prismHeight', 0.2, 5, 0.01, 'height (m)'],
    ['prismRadius', 0.05, 2, 0.01, 'equator radius (m)'],
    ['prismLength', 0.05, 3, 0.01, 'apex half-height (m)'],
    ['prismSpin', -3, 3, 0.01, 'spin (rev/s)'],
    ['prismTilt', -1.6, 1.6, 0.01, 'lean (rad)'],
    ['prismBob', 0, 1, 0.005, 'bob (m)'],
    ['prismBobSpeed', 0, 4, 0.01, 'bob Hz'],
    ['prismSwell', 0.5, 3, 0.01, 'swell under load']
  ],
  'The solid/Refraction': [
    ['prismIor', 1.01, 3, 0.005, 'index of refraction'],
    ['prismDispersion', 0, 0.4, 0.001, 'dispersion'],
    ['prismFresnelPower', 0.2, 8, 0.01, 'rim power'],
    ['prismFresnelScale', 0, 4, 0.01, 'rim strength'],
    ['prismEnvIntensity', 0, 4, 0.01, 'probe gain'],
    ['prismEnvMix', 0, 1, 0.01, 'probe vs sky'],
    ['prismFacet', 0, 3, 0.01, 'interior veins'],
    ['prismFacetScale', 0.5, 24, 0.1, 'vein scale'],
    ['prismGlow', 0, 6, 0.01, 'glow'],
    ['prismOpacity', 0, 1, 0.01, 'body opacity'],
    ['prismLoadGlow', 0, 6, 0.01, 'load glow']
  ],
  'The solid/The crack': [
    ['prismCrackTime', 0.05, 3, 0.01, 'crack duration'],
    ['prismCrackScale', 0.5, 24, 0.1, 'crack cells / m'],
    ['prismCrackEdge', 0.01, 0.6, 0.005, 'crack lip width'],
    ['prismCrackGlow', 0, 8, 0.01, 'crack lip glow']
  ],
  'The solid/Colour': [
    'colorPrismBody',
    'colorPrismRim',
    'colorPrismFire',
    'colorPrismSkyUp',
    'colorPrismSkyDown'
  ],
  'The fan': [
    ['children', 1, 8, 1, 'child beams'],
    ['fanSpread', 0, 6, 0.01, 'bow off axis (m)'],
    ['fanDispersion', 0, 6, 0.01, 'dispersion order'],
    ['fanBow', 0.2, 3, 0.01, 'bulge position'],
    ['fanBowCurve', 0.2, 4, 0.01, 'bulge tightness'],
    ['fanSpin', -3, 3, 0.01, 'fan roll (rev/s)'],
    ['fanWave', 0, 1, 0.01, 'ripple'],
    ['fanWaveScale', 0, 10, 0.05, 'ripples / span'],
    ['fanWaveSpeed', -6, 6, 0.01, 'ripple Hz']
  ],
  'The fan/The ribbon': [
    ['fanWidth', 0.005, 1, 0.005, 'width at prism'],
    ['fanWidthTip', 0.02, 3, 0.01, 'width at target'],
    ['fanCoreSharp', 0.2, 10, 0.05, 'core sharpness'],
    ['fanCoreWidth', 0.02, 1, 0.01, 'core width'],
    ['fanHaloFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['fanHaloOpacity', 0, 2, 0.01, 'halo opacity'],
    ['fanTipGlow', 0, 6, 0.05, 'leading-edge glow'],
    ['fanTipLength', 0.005, 0.5, 0.005, 'leading-edge length'],
    ['fanFlicker', 0, 1, 0.01, 'child blink'],
    ['fanFlickerSpeed', 1, 90, 1, 'blink rate'],
    ['fanGlow', 0, 8, 0.01, 'glow'],
    ['fanOpacity', 0, 2, 0.01, 'opacity'],
    ['fanSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['fanCollapse', 0.2, 5, 0.01, 'whitening curve']
  ],
  'The fan/Spectrum': [
    'colorChild1',
    'colorChild2',
    'colorChild3',
    'colorChild4',
    'colorChild5',
    'colorChild6',
    'colorChild7',
    'colorChild8',
    'colorFanCore',
    'colorCollapse'
  ],
  // The tube's own controls, filed under the lance rather than at the top
  // level, and authored here rather than spread from `tubeSchema('lance')` for
  // the same import reason the block gives above.
  'The white lance/The column': [
    ['lanceRadius', 0.01, 4, 0.01, 'far radius (m)'],
    ['lanceRadiusNear', 0.01, 4, 0.01, 'near radius (m)'],
    ['lanceRadiusCurve', 0.05, 4, 0.01, 'radius curve'],
    ['lanceFlare', 0, 4, 0.01, 'flare'],
    ['lanceFlareWidth', 0.01, 1, 0.01, 'flare width'],
    ['lanceThrob', 0, 0.5, 0.001, 'throb'],
    ['lanceThrobScale', 0, 12, 0.1, 'throb bands'],
    ['lanceThrobSpeed', 0, 8, 0.01, 'throb Hz'],
    ['lanceWander', 0, 1, 0.001, 'axis drift (m)'],
    ['lanceWanderScale', 0, 6, 0.01, 'drift scale'],
    ['lanceWanderSpeed', 0, 4, 0.01, 'drift Hz']
  ],
  'The white lance/Core, sheath & halo': [
    ['lanceCoreWidth', 0.02, 2, 0.01, 'core width'],
    ['lanceCoreFill', 0, 2, 0.01, 'core fill'],
    ['lanceCoreSharp', 0.05, 8, 0.01, 'core axis power'],
    ['lanceEdgePower', 0.05, 8, 0.01, 'sheath rim power'],
    ['lanceSheathWidth', 0.05, 3, 0.01, 'sheath width'],
    ['lanceSheathRim', 0, 2, 0.01, 'sheath rim'],
    ['lanceSheathFill', 0, 1, 0.01, 'sheath fill'],
    ['lanceSheathOpacity', 0, 1, 0.01, 'sheath opacity'],
    ['lanceHaloWidth', 0.05, 6, 0.01, 'halo width'],
    ['lanceHaloRim', 0.05, 10, 0.01, 'halo rim power'],
    ['lanceHaloOpacity', 0, 1, 0.01, 'halo opacity']
  ],
  'The white lance/The surface': [
    ['lanceRipple', 0, 1, 0.01, 'ripple'],
    ['lanceRippleBands', 0, 8, 0.01, 'ripple bands'],
    ['lanceRippleScale', 0, 12, 0.01, 'ripple scale'],
    ['lanceRippleSpeed', 0, 10, 0.01, 'ripple Hz'],
    ['lanceStreak', 0, 2, 0.01, 'streaks'],
    ['lanceStreakSharp', 0, 1, 0.01, 'streak sharpness'],
    ['lanceStreakScale', 0, 20, 0.1, 'streak scale'],
    ['lanceStreakBands', 0, 8, 0.01, 'streak bands'],
    ['lanceStreakGlow', 0, 3, 0.01, 'streak glow'],
    ['lanceFlowSpeed', 0, 24, 0.1, 'flow speed'],
    ['lanceBands', 0, 24, 0.1, 'rings/length'],
    ['lanceBandSharp', 0.05, 8, 0.01, 'ring sharpness'],
    ['lanceBandDepth', 0, 1, 0.01, 'ring depth'],
    ['lanceBandSpeed', -6, 6, 0.01, 'ring Hz']
  ],
  'The white lance/The ends': [
    ['lanceMuzzleGlow', 0, 5, 0.01, 'muzzle glow'],
    ['lanceMuzzleLength', 0, 0.6, 0.001, 'muzzle length'],
    ['lanceTipGlow', 0, 5, 0.01, 'tip glow'],
    ['lanceTipLength', 0.001, 0.4, 0.001, 'tip length']
  ],
  'The white lance/Colour & render': [
    'lanceColorCore',
    'lanceColorInner',
    'lanceColorOuter',
    'lanceColorHalo',
    ['lanceOpacity', 0, 1, 0.01, 'opacity'],
    ['lanceGlow', 0, 8, 0.01, 'glow'],
    ['lanceSoftFade', 0, 3, 0.01, 'soft fade (m)']
  ],
  // `Tube.sync()` resolves every field it owns whatever path it was built for,
  // so these exist on the block and drive uniforms a STRAIGHT column never
  // reads. Filed, rather than left to fall into "More", so it is obvious they
  // are inert here and not merely undocumented.
  'The white lance/Inert on a straight column': [
    ['lanceWaveRate', 0, 6, 0.01, 'whip: loops/second'],
    ['lanceWaveWidth', 0.02, 0.6, 0.001, 'whip: loop width'],
    ['lanceWaveAmp', 0, 1, 0.001, 'whip: loop throw'],
    ['lanceWaveGain', 0.2, 6, 0.01, 'whip: loop gain'],
    ['lanceWaveCurve', 0.1, 6, 0.01, 'whip: gain curve'],
    ['lanceWaveRoll', 0, 6.29, 0.01, 'whip: crack plane (rad)'],
    ['lanceSag', 0, 2, 0.01, 'whip: sag (m)'],
    ['lanceCrackRatio', 0.2, 4, 0.01, 'whip: crack ratio'],
    ['lanceThroat', 0.02, 4, 0.01, 'funnel: throat (m)'],
    ['lanceSkirtFlare', 0, 8, 0.01, 'funnel: skirt flare (m)'],
    ['lanceSkirtHeight', 0.01, 1, 0.01, 'funnel: skirt height'],
    ['lanceSkirtCurve', 0.1, 6, 0.01, 'funnel: skirt curve'],
    ['lanceMouthFlare', 0, 12, 0.01, 'funnel: mouth flare (m)'],
    ['lanceMouthStart', 0, 0.99, 0.01, 'funnel: mouth start'],
    ['lanceMouthCurve', 0.1, 6, 0.01, 'funnel: mouth curve'],
    ['lanceSpin', -6, 6, 0.01, 'funnel: spin (rev/s)'],
    ['lanceSpinTwist', -8, 8, 0.01, 'funnel: twist'],
    ['lanceSway', 0, 4, 0.01, 'funnel: precession (m)'],
    ['lanceSwayScale', 0, 3, 0.01, 'funnel: precession twist'],
    ['lanceSwaySpeed', -3, 3, 0.01, 'funnel: precession (rev/s)'],
    ['lanceSwayCurve', 0.1, 6, 0.01, 'funnel: precession curve'],
    ['lanceTipTaper', 0.05, 6, 0.01, 'vine: tip taper'],
    ['lanceMeander', 0, 2, 0.01, 'vine: meander (m)'],
    ['lanceMeanderTurns', 0, 8, 0.01, 'vine: meander turns'],
    ['lanceRecoilAmp', 0, 1, 0.01, 'vine: recoil'],
    ['lanceRecoilFreq', 0, 10, 0.01, 'vine: recoil Hz'],
    ['lanceRecoilDamp', 0.1, 16, 0.01, 'vine: recoil damping'],
    ['lanceRecoilSway', 0, 4, 0.01, 'vine: recoil bow (m)'],
    ['lanceArcHeight', -12, 12, 0.01, 'arc: apex height (m)'],
    ['lanceArcLateral', -12, 12, 0.01, 'arc: apex offset (m)'],
    ['lanceArcBias', 0.05, 0.95, 0.01, 'arc: apex position'],
    ['lanceArcCurve', 0.1, 4, 0.01, 'arc: apex curve']
  ],
  'Prism chips': [
    ['chipCount', 0, 190, 1, 'fragments'],
    ['chipScatter', 0, 2, 0.01, 'spawn scatter (m)'],
    ['chipSpeed', 0, 30, 0.1, 'throw speed'],
    ['chipSpeedJitter', 0, 2, 0.01, 'speed jitter'],
    ['chipSpread', 0, 1, 0.01, 'throw spread'],
    ['chipUpBias', 0, 2, 0.01, 'upward bias'],
    ['chipGravity', -50, 5, 0.1, 'gravity'],
    ['chipDrag', 0, 6, 0.01, 'drag'],
    ['chipSize', 0.01, 1, 0.005, 'size (m)'],
    ['chipSizeJitter', 0, 2, 0.01, 'size jitter'],
    ['chipShrink', 0, 1, 0.01, 'shrink'],
    ['chipShrinkPower', 0.1, 6, 0.01, 'shrink curve'],
    ['chipSpin', 0, 40, 0.1, 'tumble (rad/s)'],
    ['chipSpinJitter', 0, 2, 0.01, 'tumble jitter'],
    ['chipLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['chipFloorSpin', 0, 1, 0.01, 'grounded tumble']
  ],
  'Prism chips/Look': [
    ['chipGlow', 0, 5, 0.01, 'glow'],
    ['chipRim', 0, 3, 0.01, 'rim'],
    ['chipRimPower', 0.2, 8, 0.05, 'rim power'],
    ['chipOpacity', 0, 1, 0.01, 'opacity'],
    ['chipFadeStart', 0, 1, 0.01, 'fade start'],
    ['chipShade', 0, 2, 0.01, 'shading'],
    ['chipAmbient', 0, 2, 0.01, 'ambient'],
    'colorChipA',
    'colorChipB',
    'colorChipEdge',
    'colorChipScene'
  ],
  'Motes, sparks & dust': [
    ['moteRate', 0, 600, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 12, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 8, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['sparkSize', 0.005, 0.8, 0.005, 'spark size'],
    ['sparkSpeed', 0, 40, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 4, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['splitSparks', 0, 400, 1, 'sparks at the split'],
    ['crackSparks', 0, 400, 1, 'sparks at the crack'],
    ['burstSparks', 0, 600, 1, 'sparks at the impact'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 8, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['burstDust', 0, 300, 1, 'dust at the impact'],
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
  'Muzzle, split & impact': [
    ['muzzleSize', 0.05, 6, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorMuzzleA', 'muzzle shell'],
    ['colorMuzzleB', 'muzzle body'],
    ['colorMuzzleC', 'muzzle arcs'],
    ['colorCastFlash', 'release flash colour'],
    ['splitSize', 0.1, 8, 0.05, 'split shell size'],
    ['splitIntensity', 0, 5, 0.01, 'split intensity'],
    ['splitFlash', 0, 2, 0.01, 'split screen flash'],
    ['colorSplitA', 'split shell'],
    ['colorSplitB', 'split body'],
    ['colorSplitC', 'split arcs'],
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
