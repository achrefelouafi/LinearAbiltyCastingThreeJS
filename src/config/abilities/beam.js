/* ================================================================== */
/* BEAM — ability four                                                 */
/* ================================================================== */
/**
 * A sustained super beam: the caster winds up a ball of light in both hands,
 * then lets a column of it out along the aimed line, where it *stays* —
 * burning into the floor for `lifetime` before it collapses back to a thread
 * and blinks out. Reference for the look: `superbeam.jpg`.
 *
 * This is the ability with a **fourth beat**. Ice, thunder and meteor all run
 * travel → impact → fade; the beam puts a `charge` in front of that, so the
 * shot is something you watch arrive *and* something that lands and holds.
 * Nothing in the base class needed changing for it — `BeamAbility` simply
 * refuses to let the front leave the hand until the orb is up to power.
 *
 * The column is **one tube** — see `assets/ProceduralGeometry.js` — drawn
 * three times at three radii by `materials/BeamMaterial.js`: a wide halo, a
 * hollow rim-weighted sheath and, inside it, a core weighted the *opposite*
 * way, brightest where the view ray runs down the barrel. That inversion is
 * what makes the middle read as a solid rod of light instead of as a lit
 * pipe. The coils spiralling around it and the shock discs racing down it are
 * two more instanced passes placed against the same radius profile, so all
 * five stay welded together when the shape is dragged.
 *
 * Deliberately *not* electric: no kinks anywhere. The bolt's noise is
 * piecewise-linear so it keeps its corners; every noise term here is smooth
 * and stretched hard along the flow, because a beam that kinks is a bolt.
 *
 * As in every other block, a cast captures nothing but one seed and a few
 * timestamps. The barrel, the flare, the coil pitch and the disc train are all
 * resolved against these numbers each frame — which is why dragging `radius`
 * re-bores a beam that is already burning, with the clock stopped.
 */
export const beam = {
  /* --- the cast --- */
  range: 26.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  charge: 0.42, // seconds the orb winds up before the beam is let out
  speed: 150.0, // how fast the leading edge races downrange, metres/second
  lifetime: 1.15, // seconds it burns once it lands
  fadeTime: 0.4, // seconds it takes to collapse
  cooldown: 1.6,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where it leaves the caster --- */
  // Both hands, so this one sits on the centre line rather than off a
  // shoulder like the bolt and the rock.
  handHeight: 1.3, // metres above the floor
  handForward: 0.72, // metres in front of the caster
  handSide: 0.0, // metres to the side (+ follows `Ability#side`)
  endHeight: 1.0, // height of the beam where it lands, metres

  /* --- the column --- */
  // A narrow throat that stays tight (`radiusCurve` above 1) and then opens
  // hard over the last tenth of the span: the beam reads as a jet with a bell
  // on the end rather than as a cone, which is what puts the weight at the
  // impact instead of spreading it down the whole line.
  radiusNear: 0.16, // half-width at the muzzle, metres
  radius: 0.77, // half-width at the target
  radiusCurve: 1.27, // <1 opens out early, >1 stays tight then flares late
  flare: 1.74, // extra swell where it lands
  flareWidth: 0.09, // how much of the span that swell covers, 0..1
  // Both wobbles ship at zero. The column reads cleaner with a hard, still
  // silhouette — the coils already give the eye something moving to follow —
  // but the rates below are tuned, so raising either one is a single drag.
  throb: 0.0, // pressure waves travelling out along it
  throbScale: 4.8, // waves over the length
  throbSpeed: 2.6, // waves/second
  wander: 0.0, // metres the axis drifts, pinned at both ends
  wanderScale: 0.9, // drift features per unit length
  wanderSpeed: 0.7,

  /* --- the three tube passes --- */
  // The core is deliberately narrow and not fully opaque. Widen it or push
  // `coreFill` up and the three layers stack into one white rod: the cyan
  // sheath and the gold coils are only readable because the middle leaves
  // them room.
  coreWidth: 0.2, // the hot rod, × the column radius
  coreSharp: 1.55, // how tightly the core hugs the axis
  coreFill: 0.6, // how solid it reads
  shellWidth: 1.0, // the sheath
  shellRim: 1.15, // brightness of its silhouette edges
  shellFill: 0.18, // how much body it has between them
  shellOpacity: 0.95,
  // Wide and faint: the halo is atmosphere, not a second beam. Pushing its
  // opacity up fogs the sheath's silhouette edges, which are the read.
  haloWidth: 2.75, // the outer bloom
  haloRim: 4.3, // how tightly that hugs the silhouette
  haloOpacity: 0.14,
  edgePower: 2.2, // rim exponent shared by the sheath

  /* --- the surface --- */
  ripple: 0.2, // how far the noise pushes the barrel off round
  rippleBands: 2.2, // ripple features around the barrel
  rippleScale: 4.25, // ... and along it
  rippleSpeed: 2.0, // how fast they crawl downrange
  streak: 1.1, // filaments streaming along the flow
  streakSharp: 0.45, // 0 = a wash, 1 = hard threads
  streakScale: 4.2, // threads per unit length
  streakBands: 1.8, // ... and around the barrel
  // Kept low: the threads carry heat into the *sheath*, and pushing this up
  // whitens it out until the beam is one colour from axis to rim.
  streakGlow: 0.55, // how hot a thread burns in the sheath
  flowSpeed: 7.0, // how fast the whole field streams downrange
  mouthGlow: 1.6, // heat where the column leaves the orb
  mouthLength: 0.1, // how far that reaches, fraction of the span
  // Kept below the muzzle's: the flare and the impact shell already carry the
  // far end, and stacking a hot cap on top of them blows it out to a disc.
  tipGlow: 0.6, // heat on the leading edge / the burning end
  tipLength: 0.09, // length of that edge, fraction of the span
  softFade: 0.62, // metres of soft fade where it meets geometry

  /* --- colour --- */
  colorCore: '#ffffff', // the axis
  colorInner: '#d3f4ff',
  colorOuter: '#3ec6ff', // the outside of the sheath
  colorHalo: '#0d3ce0', // the wide bloom around it
  // The column is deliberately held *back*. Three additive tube passes at full
  // strength clip to white and the beam becomes a flat plank; dropping the
  // gain and the opacity keeps it glassy and hands the read to the coils.
  glow: 0.74, // overall emissive gain
  opacity: 0.29,

  /* --- the coils --- */
  /**
   * Ribbons spiralling around the column, on the same strip the bolt is drawn
   * on. Warm on purpose: the reference frames a white-hot beam with gold
   * coils, and the colour split is what stops them dissolving into the sheath.
   */
  coils: 4, // ribbons (capped at 8)
  coilTurns: 1.45, // turns each one makes over the length
  // Negative, so the ribbons roll *against* the direction the charge pulse
  // runs. The two motions reading differently is what keeps a held beam from
  // looking like a single rotating screw.
  coilSpeed: -0.69, // turns/second they roll on top of that
  coilRadius: 1.88, // how far out they ride, × the column radius
  coilFlare: 0.57, // extra opening at the far end
  coilWidth: 0.1, // half-width at the muzzle, metres
  coilWidthTip: 1.9, // that width at the target, as a multiple
  coilSharp: 2.2, // how hard the ribbon falls off across its width
  coilPulse: 0.65, // depth of the charge running along it
  coilPulseFreq: 3.0, // pulses over the length
  coilPulseSpeed: 1.6, // pulses/second
  // Driven hard on purpose. With the column dialled back above, the ribbons
  // are what the eye actually follows down the beam.
  coilGlow: 8.0,
  coilOpacity: 2.0,
  colorCoil: '#ffdc8c',
  colorCoilEdge: '#ff6a12',

  /* --- the shock discs --- */
  rings: 10, // discs in flight (capped at 12)
  ringSpeed: 1.31, // trips down the beam per second
  // Both lips well clear of the sheath, and close together: the discs read as
  // thin hoops orbiting the column rather than as plates growing out of it.
  ringInner: 2.42, // inner lip, × the local column radius
  ringOuter: 2.73, // outer lip
  ringSwell: 0.55, // how much they open out as they travel
  ringFade: 0.18, // how much is left of one by the time it lands
  ringSharp: 1.6, // how thin the band reads
  ringGlow: 2.4,
  ringOpacity: 0.7,
  colorRing: '#9ceeff',

  /* --- the charge orb --- */
  orbSize: 0.39, // radius once it is up to power, metres
  orbThrob: 0.11, // how hard it pulses
  orbThrobSpeed: 6.9,
  orbTurbulence: 0.24, // how far the noise eats into its surface
  orbScale: 2.2, // features over the surface
  orbFlow: 0.9, // how fast they crawl
  orbBands: 5.0, // filament frequency
  orbRim: 1.8, // rim exponent
  orbGlow: 2.8,
  orbOpacity: 1.0,

  /* --- what the ground does --- */
  scorchRate: 1.1, // burns laid per metre of front travel
  scorchRadius: 0.7, // radius of one, metres
  scorchLife: 7.0, // seconds it lingers
  scorchIntensity: 0.55,
  colorScorch: '#0a0d14',
  colorEmber: '#4ad6ff',
  dustRate: 7.0, // dust rings thrown off the burning end, per second
  dustRadius: 2.4, // radius of one, metres
  dustLife: 0.9,
  colorDustA: '#3d5c74',
  colorDustB: '#9ceeff',
  shockRate: 3.5, // pressure rings snapped across the floor, per second
  shockRadius: 7.0, // radius of the one at the impact, metres
  colorShockA: '#3ec6ff', // body of the shockwave ring
  colorShockB: '#ffffff', // its crest

  /* --- sparks, motes, smoke and debris --- */
  /**
   * As in `ice`, `thunder` and `meteor`: each system is coloured by a four-stop
   * gradient sampled over the particle's own lifetime, `A` at birth through
   * `D` as it dies. The motes do double duty — they are the intake spiralling
   * *into* the orb while it charges, and the drift shed off the column once it
   * is firing.
   */
  sparkRate: 300, // sparks shed off the column, particles/second
  sparkSize: 0.15,
  sparkSpeed: 8.0,
  sparkLifetime: 0.55,
  sparkGravity: -9.0,
  sparkStretch: 0.22, // how far a spark smears along its velocity
  sparkForward: 0.9, // how hard the spray is dragged downrange
  colorSparkA: '#ffffff',
  colorSparkB: '#d3f4ff',
  colorSparkC: '#3ec6ff',
  colorSparkD: '#0b2f7a',
  moteRate: 120, // the drift hanging around the column
  moteSize: 0.06,
  moteSpeed: 1.6,
  moteLifetime: 1.5,
  moteRise: 0.9, // upward drift, metres/second
  moteTurbulence: 0.8,
  colorMoteA: '#ffffff',
  colorMoteB: '#9ceeff',
  colorMoteC: '#3ec6ff',
  colorMoteD: '#06205e',
  intakeRate: 260, // motes pulled into the orb while it charges
  intakeRadius: 2.6, // how far out they are drawn from, metres
  intakeSpeed: 7.5, // how fast they fall in
  smokeRate: 90, // steam scoured off the floor under the beam
  smokeSize: 1.1,
  smokeSpeed: 1.4,
  smokeLifetime: 2.4,
  smokeOpacity: 0.07,
  smokeRise: 0.7,
  colorSmokeA: '#41566d',
  colorSmokeB: '#35485e',
  colorSmokeC: '#2a3949',
  colorSmokeD: '#1a2430',
  debrisRate: 34, // chips torn off the floor along the burn line
  debrisSize: 0.06,
  debrisSpeed: 6.0,
  debrisLifetime: 1.4,
  debrisGravity: -18.0,
  colorDebrisA: '#2b323c',
  colorDebrisB: '#1f252d',
  colorDebrisC: '#1a1f26',
  colorDebrisD: '#1a1f26',

  /* --- dynamic light --- */
  // Two lights: one rides the beam, one sits in the caster's hands so the
  // charge actually lights the body that is holding it.
  lightIntensity: 30,
  lightRadius: 20,
  lightColor: '#7fdcff',
  lightPulse: 0.18, // depth of the hum, 0 = steady
  lightPulseSpeed: 5.0, // pulses/second
  muzzleLightIntensity: 16,
  muzzleLightRadius: 9,

  /* --- the wind-up, the release and the burn --- */
  chargeShake: 0.045, // rumble while the orb spools up
  castFlash: 0.22, // screen flash as it is released
  muzzleSize: 1.1, // the pressure shell thrown off the hands, metres
  muzzleIntensity: 2.0,
  colorCastFlash: '#d3f4ff',
  burstSize: 4.2, // the shell at the impact point, metres
  burstIntensity: 1.6,
  burstSparks: 220, // extra sparks thrown when it lands
  burstDebris: 70,
  pulseRate: 2.6, // pressure shells off the burning end, per second
  pulseSize: 2.2, // radius of one, metres
  pulseIntensity: 1.1,
  splashRate: 260, // sparks kicked back up the beam while it burns
  impactShake: 0.9,
  shakeDuration: 0.7,
  burnShake: 0.09, // continuous rumble while the beam is standing
  impactFlash: 0.3,
  rumble: 0.05, // rumble while the leading edge travels
  colorBurstA: '#3ec6ff',
  colorBurstB: '#d3f4ff',
  colorBurstC: '#ffffff',
  colorFlash: '#d3f4ff' // the full-screen flash on impact
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Nova Beam.
 *
 * Every control here is read by a shader on the frame it changes, so the whole
 * folder reshapes a beam that is already burning — pause with **P** halfway
 * through the hold and the entire panel stays live. The ones worth reaching
 * for first are `radius` and `flare` (how heavy the column reads), `charge`
 * and `lifetime` (the wind-up and the hold, which are what make this ability
 * different from the other three), `coils` / `coilTurns` (the ribbons around
 * it) and `streak` / `flowSpeed` (how hard the energy streams downrange).
 */
export const beamSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['charge', 0, 3, 0.01, 'wind-up time'],
    ['speed', 5, 400, 1, 'travel speed'],
    ['lifetime', 0.05, 8, 0.01, 'burn time'],
    ['fadeTime', 0.05, 4, 0.01, 'collapse time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where it leaves the hands': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['endHeight', 0, 4, 0.01, 'height at target']
  ],
  'The column': [
    ['radiusNear', 0.01, 3, 0.01, 'radius at hands'],
    ['radius', 0.02, 5, 0.01, 'radius at target'],
    ['radiusCurve', 0.1, 4, 0.01, 'radius curve'],
    ['flare', 0, 4, 0.01, 'flare at target'],
    ['flareWidth', 0.02, 1, 0.01, 'flare width'],
    ['throb', 0, 0.6, 0.005, 'pressure waves'],
    ['throbScale', 0, 12, 0.1, 'waves / length'],
    ['throbSpeed', 0, 10, 0.05, 'wave speed'],
    ['wander', 0, 1, 0.005, 'axis drift'],
    ['wanderScale', 0.1, 6, 0.05, 'drift scale'],
    ['wanderSpeed', 0, 5, 0.01, 'drift speed']
  ],
  // The three tube passes. `coreSharp` and `shellRim` are the pair that decide
  // whether the beam reads as a solid rod or as a lit pipe — see
  // `materials/BeamMaterial.js`.
  'Core, sheath & halo': [
    ['coreWidth', 0.05, 1.5, 0.01, 'core width'],
    ['coreSharp', 0.1, 8, 0.05, 'core focus'],
    ['coreFill', 0, 3, 0.01, 'core fill'],
    ['shellWidth', 0.2, 3, 0.01, 'sheath width'],
    ['shellRim', 0, 3, 0.01, 'sheath rim'],
    ['shellFill', 0, 1.5, 0.01, 'sheath fill'],
    ['shellOpacity', 0, 2, 0.01, 'sheath opacity'],
    ['edgePower', 0.2, 8, 0.05, 'rim falloff'],
    ['haloWidth', 0.5, 8, 0.05, 'halo width'],
    ['haloRim', 0.5, 10, 0.05, 'halo falloff'],
    ['haloOpacity', 0, 2, 0.01, 'halo opacity']
  ],
  'Surface & flow': [
    ['ripple', 0, 1, 0.005, 'surface ripple'],
    ['rippleBands', 0.1, 8, 0.05, 'ripples around'],
    ['rippleScale', 0.1, 12, 0.05, 'ripples along'],
    ['rippleSpeed', 0, 12, 0.05, 'ripple crawl'],
    ['streak', 0, 3, 0.01, 'filaments'],
    ['streakSharp', 0, 1, 0.01, 'filament sharpness'],
    ['streakScale', 0.2, 20, 0.1, 'filaments / length'],
    ['streakBands', 0.2, 10, 0.05, 'filaments around'],
    ['streakGlow', 0, 4, 0.01, 'filament heat'],
    ['flowSpeed', 0, 30, 0.1, 'flow speed'],
    ['mouthGlow', 0, 6, 0.05, 'muzzle heat'],
    ['mouthLength', 0.005, 0.5, 0.005, 'muzzle length'],
    ['tipGlow', 0, 6, 0.05, 'burning-end heat'],
    ['tipLength', 0.005, 0.5, 0.005, 'burning-end length'],
    ['softFade', 0.02, 3, 0.01, 'soft intersection']
  ],
  'Beam colour': [
    ['colorCore', 'axis'],
    ['colorInner', 'inner'],
    ['colorOuter', 'sheath'],
    ['colorHalo', 'halo'],
    ['glow', 0, 8, 0.01, 'glow'],
    ['opacity', 0, 2, 0.01, 'opacity']
  ],
  'The coils': [
    ['coils', 0, 8, 1, 'ribbons'],
    ['coilTurns', -8, 8, 0.05, 'turns over length'],
    ['coilSpeed', -6, 6, 0.01, 'roll speed'],
    ['coilRadius', 0.2, 4, 0.01, 'ride radius'],
    ['coilFlare', 0, 4, 0.01, 'flare at target'],
    ['coilWidth', 0.005, 0.6, 0.005, 'width at hands'],
    ['coilWidthTip', 0.05, 6, 0.01, 'width at target'],
    ['coilSharp', 0.2, 8, 0.05, 'edge falloff'],
    ['coilPulse', 0, 1, 0.01, 'charge pulse'],
    ['coilPulseFreq', 0, 12, 0.05, 'pulses / length'],
    ['coilPulseSpeed', -8, 8, 0.05, 'pulse speed'],
    // Headroom above the shipped values on purpose — they sit high, and a
    // control that starts pinned to its own maximum can only ever come down.
    ['coilGlow', 0, 14, 0.01, 'glow'],
    ['coilOpacity', 0, 3, 0.01, 'opacity'],
    ['colorCoil', 'ribbon core'],
    ['colorCoilEdge', 'ribbon edge']
  ],
  'Shock discs': [
    ['rings', 0, 12, 1, 'discs'],
    ['ringSpeed', 0, 6, 0.01, 'trips / second'],
    ['ringInner', 0.2, 4, 0.01, 'inner lip'],
    ['ringOuter', 0.3, 6, 0.01, 'outer lip'],
    ['ringSwell', 0, 3, 0.01, 'swell downrange'],
    ['ringFade', 0, 1, 0.01, 'fade downrange'],
    ['ringSharp', 0.2, 8, 0.05, 'band sharpness'],
    ['ringGlow', 0, 8, 0.01, 'glow'],
    ['ringOpacity', 0, 2, 0.01, 'opacity'],
    ['colorRing', 'disc colour']
  ],
  'The charge': [
    ['orbSize', 0.02, 2, 0.01, 'orb radius'],
    ['orbThrob', 0, 0.6, 0.005, 'orb pulse'],
    ['orbThrobSpeed', 0, 20, 0.1, 'pulse rate'],
    ['orbTurbulence', 0, 1, 0.01, 'surface turbulence'],
    ['orbScale', 0.2, 8, 0.05, 'surface scale'],
    ['orbFlow', 0, 5, 0.01, 'surface crawl'],
    ['orbBands', 0.5, 15, 0.1, 'filament scale'],
    ['orbRim', 0.2, 6, 0.05, 'rim falloff'],
    ['orbGlow', 0, 8, 0.01, 'glow'],
    ['orbOpacity', 0, 2, 0.01, 'opacity'],
    ['intakeRate', 0, 900, 1, 'intake rate'],
    ['intakeRadius', 0.2, 8, 0.05, 'intake radius'],
    ['intakeSpeed', 0.5, 25, 0.1, 'intake speed'],
    ['chargeShake', 0, 0.5, 0.005, 'wind-up rumble']
  ],
  'What the floor does': [
    ['scorchRate', 0.05, 8, 0.05, 'burns / metre'],
    ['scorchRadius', 0.05, 4, 0.05, 'burn radius'],
    ['scorchLife', 0.5, 20, 0.1, 'burn lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'burn intensity'],
    ['dustRate', 0, 20, 0.1, 'dust rings / sec'],
    ['dustRadius', 0.2, 10, 0.05, 'dust ring radius'],
    ['dustLife', 0.1, 5, 0.05, 'dust ring lifetime'],
    ['shockRate', 0, 20, 0.1, 'shock rings / sec'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['colorScorch', 'scorch'],
    ['colorEmber', 'ember'],
    ['colorDustA', 'dust'],
    ['colorDustB', 'dust crest'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest']
  ],
  'Sparks & motes': [
    ['sparkRate', 0, 1200, 1, 'spark rate'],
    ['sparkSize', 0.005, 0.8, 0.005, 'spark size'],
    ['sparkSpeed', 0, 40, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 4, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['sparkForward', 0, 4, 0.01, 'downrange drag'],
    ['moteRate', 0, 600, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 12, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 8, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['colorSpark*', 'Spark colour'],
    ['colorMote*', 'Mote colour']
  ],
  'Steam & debris': [
    ['smokeRate', 0, 500, 1, 'steam rate'],
    ['smokeSize', 0.05, 4, 0.01, 'steam size'],
    ['smokeSpeed', 0, 8, 0.05, 'steam speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'steam lifetime'],
    ['smokeOpacity', 0, 1, 0.005, 'steam opacity'],
    ['smokeRise', -2, 4, 0.01, 'steam rise'],
    ['debrisRate', 0, 300, 1, 'debris rate'],
    ['debrisSize', 0.005, 0.4, 0.005, 'debris size'],
    ['debrisSpeed', 0, 25, 0.1, 'debris speed'],
    ['debrisLifetime', 0.1, 5, 0.05, 'debris lifetime'],
    ['debrisGravity', -50, 0, 0.1, 'debris gravity'],
    ['colorSmoke*', 'Steam colour'],
    ['colorDebris*', 'Debris colour']
  ],
  'Release, impact & burn': [
    ['muzzleSize', 0.05, 8, 0.05, 'release shell'],
    ['muzzleIntensity', 0, 5, 0.01, 'release intensity'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour'],
    ['burstSize', 0.2, 18, 0.05, 'impact shell'],
    ['burstIntensity', 0, 5, 0.01, 'impact intensity'],
    ['burstSparks', 0, 800, 1, 'impact sparks'],
    ['burstDebris', 0, 400, 1, 'impact debris'],
    ['pulseRate', 0, 12, 0.1, 'burn shells / sec'],
    ['pulseSize', 0.1, 10, 0.05, 'burn shell size'],
    ['pulseIntensity', 0, 5, 0.01, 'burn shell intensity'],
    ['splashRate', 0, 900, 1, 'back-splash rate'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['burnShake', 0, 0.5, 0.005, 'burn rumble'],
    ['colorBurstA', 'impact shell'],
    ['colorBurstB', 'impact body'],
    ['colorBurstC', 'impact arcs'],
    ['colorFlash', 'impact flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'beam intensity'],
    ['lightRadius', 0.5, 60, 0.1, 'beam radius'],
    ['lightPulse', 0, 1, 0.01, 'hum depth'],
    ['lightPulseSpeed', 0, 30, 0.1, 'hum rate'],
    ['muzzleLightIntensity', 0, 120, 0.5, 'hand intensity'],
    ['muzzleLightRadius', 0.5, 40, 0.1, 'hand radius'],
    ['lightColor', 'light colour']
  ]
};
