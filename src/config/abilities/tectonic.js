/* ================================================================== */
/* TECTONIC SLAM — stone, far cast                                     */
/* ================================================================== */
/**
 * The ground is hit once and then it tears: five fissures whip out of the
 * point of impact to the boundary of the circle **at different speeds**, each
 * with a wave of dust riding just behind its own tip, and a pressure ring goes
 * with the fastest of them.
 *
 * Two derivations live in this block and are worth knowing before you drag
 * anything:
 *
 *  - **`speedSpread` is the whole ability.** The fastest arm runs at
 *    `fissureSpeed × (1 + speedSpread)` and the slowest at exactly
 *    `fissureSpeed`. Take the spread to zero and all five arms land together,
 *    which is a star, and a star is *revealed* rather than drawn. The default
 *    is deliberately large.
 *  - **there is no `ringRadiusEnd`.** The ring's end radius is `zoneRadius ×
 *    ringReach` and its clock is the fastest arm's arrival time, so the two
 *    events coincide by construction rather than by tuning. It is the one
 *    number here that is a consequence, and the ability assigns it onto a
 *    proxy that inherits from this block rather than writing into it.
 *
 * The rest of the `ring*` family is `vfx/Shell.js` in `DOME` mode, read through
 * its `ring` key prefix; the RING_TRAIN and SUNDISC halves of that vocabulary
 * are not authored here because a flattened dome has no use for them, and the
 * ability fills them in from `shellDefaults()` so the module's audit stays
 * quiet.
 */
export const tectonic = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 46.0, // how fast the shock front runs out to the circle, metres/second
  zoneRadius: 6.4, // the footprint — what the circle indicator measures out, metres
  holdTime: 0.85, // seconds the open ground holds *after* the slowest arm lands
  settleTime: 1.7, // seconds the cracks take to close and the rubble to sink
  cooldown: 1.6,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
  handForward: 0.6, // metres in front of the caster the front leaves from

  /* --- the fissures --- */
  arms: 5, // main cracks racing outward (capped at 8) — live, re-fans the network
  armJitter: 0.24, // radians of scatter on each arm's launch bearing
  wander: 1.15, // how hard an arm veers, in units of its baked angular walk
  fissureSpeed: 7.2, // the *slowest* arm's propagation, metres/second
  speedSpread: 0.9, // the fastest arm runs this much faster again, as a fraction
  fissureWidth: 0.46, // full width of an open crack, metres
  openLag: 0.85, // metres behind the tip the crack reaches full width — the unzip
  tipFeather: 0.26, // metres of feather on the tearing edge
  fissureHeight: 0.018, // metres the ribbon sits above the floor
  fissureGrain: 0.42, // 0..1 how much noise breaks up the seam's alpha
  gashOpacity: 1.0, // the alpha-blended crack itself
  forks: 0.72, // 0..1 of the forks kept — rank-culled, live
  forkLength: 0.8, // 0..1 of a fork's baked length that is drawn

  /* --- the ember in the floor of the crack --- */
  emberHeat: 1.7, // brightness of a freshly torn crack floor
  emberCool: 1.15, // seconds a point of crack takes to cool to dead basalt
  emberPulse: 3.0, // radians/second the heat breathes along the crack
  emberFlicker: 0.32, // 0..1 depth of the high-frequency guttering
  tipFlash: 1.5, // extra white at the tearing tip itself
  glowWidth: 3.6, // the underglow ribbon, × the crack's own width
  glowOpacity: 0.5, // and its opacity

  /* --- colour of the ground and the fire in it --- */
  colorSeam: '#463f34', // a cold, closed crack — the floor of the gash
  colorMagma: '#8a3410', // the first heat
  colorEmber: '#ff7a2a', // the ember the underglow is painted in
  colorHot: '#ffd9a0', // the white-hot tearing edge
  colorRubble: '#8a7f6b', // the blocks of crust levered up along the lips

  /* --- the crust shouldered up along the lips --- */
  rubbleSize: 0.42, // metres, a full-size block
  rubbleSpread: 0.55, // metres outside the crack edge the blocks are pushed
  rubbleEmerge: 0.55, // metres of crack the tip must pass before a block is fully up

  /* --- the pressure ring (vfx/Shell.js, DOME, `ring` prefix) --- */
  ringReach: 1.0, // where the ring lands, × zoneRadius. 1 = exactly the boundary
  ringFade: 0.34, // seconds it takes to die once it has landed
  ringRadius: 0.7, // radius at the slam, metres
  ringExpand: 1.0, // 1 is a linear front; >1 snaps out and eases in
  ringHeight: 0.16, // axial extent, × radius — flat, because it is a ground front
  ringLift: 0.05, // metres it hovers above the floor
  ringDisplace: 0.14, // billow along the surface normal, × radius
  ringNoiseScale: 2.2, // billow features per unit radius
  ringNoiseSpeed: 0.5, // Hz the billow crawls at
  ringTurbulence: 1.0, // master on the billow
  ringFill: 0.12, // how much body the shell keeps, 0 = rim only
  ringRim: 1.15, // strength of the fresnel rim
  ringRimPower: 2.6, // how tight that rim is
  ringSeal: 1.6, // brightness of the band where it meets the floor
  ringSealWidth: 0.16, // how wide that band is, fraction of the sweep
  ringDissolve: 0.7, // how hard the age dissolve bites
  ringOpacity: 0.9,
  ringGlow: 1.5, // emissive gain into bloom
  ringSoftFade: 0.5, // metres of depth fade against the opaque scene
  ringColorBody: '#6b5f4c', // the body of the front — dust, not light
  ringColorRim: '#d8c49a', // its fresnel rim
  ringColorEdge: '#ffe8c0', // the seal where it scrapes the floor

  /* --- the dust wave riding behind each tip --- */
  /**
   * As everywhere else in the project, each system is coloured by a four-stop
   * gradient sampled over the particle's own lifetime, `A` at birth through `D`
   * as it dies. Spelled out rather than derived from the stone palette, so the
   * dust can be made to settle browner than the rock it came out of.
   */
  dustRate: 190, // particles/second across every running arm
  dustSize: 1.1,
  dustSpeed: 3.4, // metres/second off the lip
  dustLifetime: 2.4,
  dustOpacity: 0.3,
  dustRise: 0.5, // upward drift, metres/second
  dustTurbulence: 0.75,
  dustLag: 1.1, // metres behind the tip the wave sits
  dustLift: 0.42, // how much +Y is folded into the sideways throw
  dustHeight: 0.16, // metres above the floor it is emitted at
  colorDustA: '#a89880',
  colorDustB: '#8a7f6b',
  colorDustC: '#5d554a',
  colorDustD: '#3a352e',

  /* --- chips off the tearing edge --- */
  gritRate: 90, // particles/second across every running arm
  gritSize: 0.06,
  gritSpeed: 6.5,
  gritLifetime: 1.3,
  gritGravity: -19.0,
  colorGritA: '#6e6455',
  colorGritB: '#4a4239',
  colorGritC: '#39332b',
  colorGritD: '#241f1a',

  /* --- embers lifting out of the open crack --- */
  emberRate: 110, // particles/second across every arm
  emberSize: 0.055,
  emberSpeed: 1.9,
  emberLifetime: 1.5,
  emberRise: 1.4, // upward drift, metres/second
  emberTurbulence: 0.85,
  emberGlow: 2.1,
  colorSparkA: '#ffd9a0',
  colorSparkB: '#ff7a2a',
  colorSparkC: '#b03a08',
  colorSparkD: '#2a1008',

  /* --- what the ground keeps --- */
  markRate: 7, // dust rings dropped behind the tips, per second
  markRadius: 1.1, // radius of one, metres
  markLife: 2.6, // seconds it lingers
  markIntensity: 0.5,
  starRadius: 0.34, // the crack star under the impact, × zoneRadius
  starWidth: 0.5, // how finely it splits into filaments
  starLife: 5.0, // seconds
  starIntensity: 0.9,
  slamDust: 0.8, // the dust ring the slam sits in, × zoneRadius

  /* --- the slam --- */
  muzzleSize: 0.7, // the stamp at the caster's feet, metres
  muzzleIntensity: 1.2,
  slamSize: 3.4, // the ball of dust punched out of the floor, metres
  slamIntensity: 1.3,
  slamGrit: 110, // chips thrown straight up at the slam
  slamDustCount: 60, // and dust
  slamShake: 0.85, // the punch — deliberately modest; the rumble does the work
  slamShakeTime: 0.45, // seconds that punch decays over
  slamFlash: 0.12, // screen flash on the slam
  colorFlash: '#c8a878', // the colour of it
  slamRumble: 0.16, // peak continuous shake as the ground comes apart
  shakeRamp: 0.75, // <1 climbs early, >1 holds off until the tips are nearly out
  shakeDecay: 0.7, // seconds the rumble decays over once every arm has landed
  travelRumble: 0.02, // continuous shake while the front runs to the circle

  /* --- dynamic light --- */
  lightIntensity: 16,
  lightRadius: 14,
  lightColor: '#ff8a3c',
  lightHeight: 0.35, // metres above the floor the light sits at
  lightBreath: 3.4, // radians/second of the slow breath in it
  lightFloor: 0.12 // how much of it survives once the ember is cold, 0..1
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Tectonic Slam.
 *
 * The four controls that carry the character: `speedSpread` (whether this is
 * five racing cracks or one star), `wander` (whether they are cracks or
 * spokes), `emberCool` (how long the ground stays lit behind them) and
 * `dustLag` (how far behind the tearing edge the dust wave sits — take it to
 * zero and the tip disappears inside its own dust).
 *
 * Everything below re-draws a network that is already open, on a paused clock.
 * Dragging `arms` mid-slam re-fans it; dragging `zoneRadius` re-scales it and
 * walks the rubble out along the cracks with it.
 */
export const tectonicSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'front speed'],
    ['zoneRadius', 1, 16, 0.05, 'footprint radius'],
    ['holdTime', 0.05, 6, 0.01, 'hold after landing'],
    ['settleTime', 0.1, 6, 0.01, 'settle time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['handForward', -1, 3, 0.01, 'front offset'],
    ['castAnim', 'cast animation']
  ],
  'The fissures': [
    ['arms', 1, 8, 1, 'arms'],
    ['armJitter', 0, 1.5, 0.01, 'bearing scatter'],
    ['wander', 0, 4, 0.01, 'veer'],
    ['fissureSpeed', 1, 40, 0.1, 'slowest arm (m/s)'],
    ['speedSpread', 0, 3, 0.01, 'fastest arm, × faster'],
    ['fissureWidth', 0.05, 2, 0.01, 'crack width (m)'],
    ['openLag', 0.05, 5, 0.01, 'unzip length (m)'],
    ['tipFeather', 0.02, 2, 0.01, 'tip feather (m)'],
    ['fissureHeight', 0, 0.2, 0.001, 'height above floor (m)'],
    ['fissureGrain', 0, 1, 0.01, 'seam grain'],
    ['gashOpacity', 0, 1, 0.01, 'crack opacity'],
    ['forks', 0, 1, 0.01, 'forks kept'],
    ['forkLength', 0.05, 1, 0.01, 'fork length']
  ],
  'The ember': [
    ['emberHeat', 0, 5, 0.01, 'heat'],
    ['emberCool', 0.05, 6, 0.01, 'cooling time (s)'],
    ['emberPulse', 0, 12, 0.05, 'heat pulse'],
    ['emberFlicker', 0, 1, 0.01, 'flicker'],
    ['tipFlash', 0, 6, 0.05, 'tip flash'],
    ['glowWidth', 1, 12, 0.05, 'underglow width'],
    ['glowOpacity', 0, 2, 0.01, 'underglow opacity'],
    ['colorSeam', 'cold seam'],
    ['colorMagma', 'first heat'],
    ['colorEmber', 'ember'],
    ['colorHot', 'tearing edge']
  ],
  'The crust': [
    ['rubbleSize', 0.05, 2, 0.01, 'block size (m)'],
    ['rubbleSpread', 0, 3, 0.01, 'push off the lip (m)'],
    ['rubbleEmerge', 0.05, 3, 0.01, 'emerge over (m)'],
    ['colorRubble', 'rubble']
  ],
  'The pressure ring': [
    ['ringReach', 0.2, 2, 0.01, 'lands at × footprint'],
    ['ringFade', 0.02, 2, 0.01, 'death after landing (s)'],
    ['ringRadius', 0.05, 8, 0.01, 'radius at the slam (m)'],
    ['ringExpand', 0.2, 8, 0.01, 'expansion curve'],
    ['ringHeight', 0.02, 2, 0.01, 'height × radius'],
    ['ringLift', -1, 2, 0.005, 'lift (m)'],
    ['ringDisplace', 0, 1.5, 0.01, 'billow'],
    ['ringNoiseScale', 0.1, 10, 0.01, 'billow scale'],
    ['ringNoiseSpeed', 0, 4, 0.01, 'billow Hz'],
    ['ringTurbulence', 0, 3, 0.01, 'turbulence'],
    ['ringFill', 0, 1, 0.01, 'body fill'],
    ['ringRim', 0, 3, 0.01, 'rim'],
    ['ringRimPower', 0.1, 8, 0.01, 'rim power'],
    ['ringSeal', 0, 4, 0.01, 'floor seal'],
    ['ringSealWidth', 0.01, 0.6, 0.01, 'seal width'],
    ['ringDissolve', 0, 2, 0.01, 'dissolve'],
    ['ringOpacity', 0, 1, 0.01, 'opacity'],
    ['ringGlow', 0, 8, 0.01, 'glow'],
    ['ringSoftFade', 0, 3, 0.01, 'soft fade (m)'],
    ['ringColorBody', 'front body'],
    ['ringColorRim', 'front rim'],
    ['ringColorEdge', 'floor seal']
  ],
  'The dust wave': [
    ['dustRate', 0, 900, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 14, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['dustLag', 0, 6, 0.01, 'wave lag behind tip (m)'],
    ['dustLift', 0, 3, 0.01, 'wave lift'],
    ['dustHeight', 0, 2, 0.01, 'emit height (m)'],
    ['colorDust*', 'Dust colour']
  ],
  'Chips & embers': [
    ['gritRate', 0, 500, 1, 'chip rate'],
    ['gritSize', 0.005, 0.4, 0.005, 'chip size'],
    ['gritSpeed', 0, 25, 0.1, 'chip speed'],
    ['gritLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['gritGravity', -50, 0, 0.1, 'chip gravity'],
    ['emberRate', 0, 600, 1, 'ember rate'],
    ['emberSize', 0.005, 0.4, 0.005, 'ember size'],
    ['emberSpeed', 0, 12, 0.05, 'ember speed'],
    ['emberLifetime', 0.1, 8, 0.05, 'ember lifetime'],
    ['emberRise', -3, 8, 0.05, 'ember rise'],
    ['emberTurbulence', 0, 3, 0.01, 'ember turbulence'],
    ['emberGlow', 0, 8, 0.01, 'ember glow'],
    ['colorGrit*', 'Chip colour'],
    ['colorSpark*', 'Ember colour']
  ],
  'Marks on the ground': [
    ['markRate', 0, 40, 0.5, 'dust rings / sec'],
    ['markRadius', 0.1, 6, 0.05, 'ring radius'],
    ['markLife', 0.2, 12, 0.1, 'ring lifetime'],
    ['markIntensity', 0, 3, 0.01, 'ring intensity'],
    ['starRadius', 0.05, 1.5, 0.01, 'impact star × footprint'],
    ['starWidth', 0, 3, 0.01, 'star detail'],
    ['starLife', 0.5, 20, 0.1, 'star lifetime'],
    ['starIntensity', 0, 3, 0.01, 'star intensity'],
    ['slamDust', 0.05, 2, 0.01, 'slam dust ring × footprint']
  ],
  'The slam': [
    ['muzzleSize', 0.05, 6, 0.05, 'foot stamp size'],
    ['muzzleIntensity', 0, 5, 0.01, 'foot stamp intensity'],
    ['slamSize', 0.2, 14, 0.05, 'dust ball size'],
    ['slamIntensity', 0, 5, 0.01, 'dust ball intensity'],
    ['slamGrit', 0, 400, 1, 'slam chips'],
    ['slamDustCount', 0, 400, 1, 'slam dust'],
    ['slamShake', 0, 3, 0.01, 'slam punch'],
    ['slamShakeTime', 0.1, 4, 0.01, 'punch decay'],
    ['slamFlash', 0, 2, 0.01, 'screen flash'],
    ['colorFlash', 'flash colour'],
    ['slamRumble', 0, 0.6, 0.005, 'propagation rumble'],
    ['shakeRamp', 0.05, 4, 0.01, 'rumble ramp curve'],
    ['shakeDecay', 0.05, 4, 0.01, 'rumble decay (s)'],
    ['travelRumble', 0, 0.5, 0.005, 'travel rumble']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightHeight', 0, 4, 0.01, 'light height'],
    ['lightBreath', 0, 12, 0.05, 'breath rate'],
    ['lightFloor', 0, 1, 0.01, 'floor once cold'],
    ['lightColor', 'light colour']
  ]
};
