/* ================================================================== */
/* THUNDER — ability two                                               */
/* ================================================================== */
/**
 * A bolt thrown from the caster's hand along the aimed line: a bundle of
 * lightning filaments that snap into existence, hold while they gutter, and
 * blow out. Reference for the look: `thundercast.jpg`.
 *
 * The bolt is **one mesh**. Every filament is an instance of the same ribbon
 * strip, and its entire shape — the sag of the axis, the fan of the bundle,
 * the kinks in an individual strand, the camera-facing width — is evaluated in
 * the vertex shader from the numbers below. Nothing about the path exists on
 * the CPU, which is why `strands`, `jitter` and `spread` reshape a bolt that
 * is already in the air, and do it with the clock paused.
 *
 * The one thing a cast *does* capture is `uSeed`, a single random number
 * rolled at spawn so two casts do not draw the identical bolt. That is an
 * event, not a dimension — the same rule `IceAbility` follows.
 */
export const thunder = {
  /* --- the cast --- */
  range: 24.0, // maximum cast distance, metres
  minRange: 2.0, // closer than this and the cast is refused
  speed: 105.0, // how fast the strike front travels, metres/second
  lifetime: 0.45, // seconds the bolt holds after it lands
  fadeTime: 0.5, // seconds it takes to blow out
  cooldown: 0.5,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the bolt leaves the caster --- */
  // The beam starts at the hand, not at the feet, so these are measured from
  // the caster's origin in the cast's own frame.
  handHeight: 1.28, // metres above the floor
  handForward: 0.55, // metres in front of the caster
  handSide: 0.16, // metres to the side (+ follows `Ability#side`)
  endHeight: 0.35, // height of the bolt where it lands, metres
  sag: 0.22, // metres the mid-span bows upward (negative droops)

  /* --- the bundle of filaments --- */
  strands: 9, // separate filaments (capped at 24)
  spread: 0.75, // metres the bundle fans out at the far end
  spreadNear: 0.05, // ... and at the hand
  spreadCurve: 1.6, // >1 keeps the bundle tight then opens it late
  twist: 0.45, // turns the bundle makes around the axis over its length
  twistSpeed: 0.8, // turns/second it rolls on top of that
  branchDim: 0.72, // how much dimmer an outer filament is than the spine

  /* --- the shape of one filament --- */
  jitter: 0.34, // metres of kink at the coarsest octave
  jitterScale: 0.85, // kinks per metre
  octaves: 4, // 1–5; each one halves the amplitude and doubles the rate
  jitterFalloff: 0.55, // amplitude kept per octave
  crawl: 3.2, // how fast the kinks slide along the bolt
  pinch: 0.14, // fraction of the span the ends are pulled straight over
  converge: 0.8, // how hard the far end is pulled onto the target, 0..1

  /* --- the ribbon --- */
  width: 0.025, // half-width of a filament at the hand, metres
  widthTip: 0.43, // that width at the impact point, as a fraction
  widthCurve: 1.09, // how early the taper happens
  coreWidth: 1.31, // multiplier on the central spine
  coreSharp: 4.95, // how hard the hot core falls off across the ribbon
  glowWidth: 5.7, // the halo, × the core width
  glowFalloff: 2.4, // how fast the halo fades across its ribbon
  glowOpacity: 0.49,
  softFade: 0.78, // metres of soft fade where the bolt meets geometry

  /* --- flicker & restrike --- */
  restrike: 24, // times/second the filaments re-roll their shape
  flicker: 0.3, // depth of the whole-bolt brightness stutter
  flickerSpeed: 34, // stutters/second
  strandFlash: 0.5, // how much individual filaments blink out
  tipGlow: 2.0, // extra heat on the leading edge while it travels
  tipLength: 0.08, // length of that leading edge, fraction of the span

  /* --- colour --- */
  colorCore: '#ffffff', // the centre of a filament
  colorInner: '#c9ecff',
  colorOuter: '#3aa0ff', // the outside of a filament
  colorHalo: '#0b3fc8', // the wide glow around the bundle
  glow: 2.3, // overall emissive gain
  opacity: 1.0,

  /* --- what the ground does --- */
  arcRate: 0.9, // electric burns laid per metre of front travel
  arcRadius: 1.5, // radius of one burn, metres
  arcLife: 0.6, // seconds a burn lingers
  arcIntensity: 1.0,
  arcBranches: 0.6, // how finely the burn splits into filaments
  scorchRadius: 0.5, // dark burn mark under the bolt, metres
  scorchLife: 6.5,
  scorchIntensity: 0.45,
  colorArc: '#9fdcff',
  colorScorch: '#080b11',
  colorEmber: '#4aa8ff',
  shockRadius: 6.5, // impact shockwave ring, metres
  colorShockA: '#c9ecff', // body of the shockwave ring
  colorShockB: '#ffffff', // its crest

  /* --- sparks, motes, smoke and debris --- */
  /**
   * As in `ice`: each system is coloured by a four-stop gradient sampled over
   * the particle's own lifetime, `A` at birth through `D` as it dies. Spelled
   * out rather than derived from the bolt palette, so the sparks can be made
   * to cool to orange while the filaments stay blue.
   */
  sparkRate: 240, // sparks thrown off the bolt, particles/second
  sparkSize: 0.16,
  sparkSpeed: 9.0,
  sparkLifetime: 0.5,
  sparkGravity: -12.0,
  sparkStretch: 0.18, // how far a spark smears along its velocity
  colorSparkA: '#ffffff',
  colorSparkB: '#ffffff',
  colorSparkC: '#c9ecff',
  colorSparkD: '#1e5b95',
  moteRate: 90, // the slow ionised motes drifting off the bolt
  moteSize: 0.05,
  moteSpeed: 1.5,
  moteLifetime: 1.6,
  moteRise: 1.0, // upward drift, metres/second
  moteTurbulence: 0.7,
  colorMoteA: '#ffffff',
  colorMoteB: '#c9ecff',
  colorMoteC: '#3aa0ff',
  colorMoteD: '#02195f',
  smokeRate: 50, // thin haze off the scorched floor
  smokeSize: 1.0,
  smokeSpeed: 1.1,
  smokeLifetime: 2.2,
  smokeOpacity: 0.06,
  smokeRise: 0.55,
  colorSmokeA: '#3d546e',
  colorSmokeB: '#33475e',
  colorSmokeC: '#33475e',
  colorSmokeD: '#1c2938',
  debrisRate: 24, // chips kicked off the floor under the bolt
  debrisSize: 0.055,
  debrisSpeed: 5.0,
  debrisLifetime: 1.3,
  debrisGravity: -17.0,
  colorDebrisA: '#252c36',
  colorDebrisB: '#1c222a',
  colorDebrisC: '#1c222a',
  colorDebrisD: '#1c222a',

  /* --- dynamic light --- */
  lightIntensity: 26,
  lightRadius: 17,
  lightColor: '#63b8ff',
  lightFlicker: 0.4, // depth of the light's gutter, 0 = steady
  lightFlickerSpeed: 26,

  /* --- the muzzle and the impact --- */
  // Both shells are the same shader: A→B is mixed across the billowing noise
  // and stays nearly empty, and C is what the racing filaments and the fresnel
  // rim are drawn in — so C is the one carrying the read.
  muzzleSize: 0.55, // the flash at the hand, metres
  muzzleIntensity: 1.9,
  castFlash: 0.1, // screen flash on release
  colorMuzzleA: '#3aa0ff',
  colorMuzzleB: '#c9ecff',
  colorMuzzleC: '#ffffff',
  colorCastFlash: '#c9ecff',
  burstSize: 3.0, // the shell at the impact point, metres
  burstIntensity: 1.4,
  burstSparks: 170, // extra sparks thrown at the impact
  burstDebris: 45,
  impactShake: 0.8,
  shakeDuration: 0.55,
  impactFlash: 0.28,
  rumble: 0.03, // continuous shake while the front travels
  colorBurstA: '#3aa0ff',
  colorBurstB: '#c9ecff',
  colorBurstC: '#ffffff',
  colorFlash: '#c9ecff' // the full-screen flash on impact
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Storm Lance.
 *
 * Every control here is read by the vertex shader on the frame it changes, so
 * the whole folder reshapes a bolt that is already in the air. The ones worth
 * reaching for first are `jitter` and `jitterScale` (how violently it kinks),
 * `strands` and `spread` (how wide the bundle reads) and `restrike` (how hard
 * it strobes) — those four carry the character of the effect.
 */
export const thunderSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 400, 1, 'strike speed'],
    ['lifetime', 0.05, 6, 0.01, 'bolt lifetime'],
    ['fadeTime', 0.05, 4, 0.01, 'blow-out time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where it leaves the hand': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['endHeight', 0, 4, 0.01, 'height at target'],
    ['sag', -3, 3, 0.01, 'mid-span bow']
  ],
  'The bundle': [
    ['strands', 1, 24, 1, 'filaments'],
    ['spread', 0, 5, 0.01, 'fan at target'],
    ['spreadNear', 0, 2, 0.01, 'fan at hand'],
    ['spreadCurve', 0.2, 5, 0.01, 'fan curve'],
    ['twist', -4, 4, 0.01, 'twist over length'],
    ['twistSpeed', -6, 6, 0.01, 'twist speed'],
    ['branchDim', 0, 1, 0.01, 'outer filament dim']
  ],
  'The filament': [
    ['jitter', 0, 3, 0.01, 'kink amplitude'],
    ['jitterScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['octaves', 1, 5, 1, 'octaves'],
    ['jitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['crawl', -20, 20, 0.1, 'kink crawl'],
    ['pinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['converge', 0, 1, 0.01, 'lock onto target']
  ],
  'The ribbon': [
    ['width', 0.005, 0.6, 0.005, 'width at hand'],
    ['widthTip', 0.02, 3, 0.01, 'width at target'],
    ['widthCurve', 0.1, 4, 0.01, 'taper curve'],
    ['coreWidth', 1, 6, 0.01, 'spine thickness'],
    ['coreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['glowWidth', 1, 30, 0.1, 'halo width'],
    ['glowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['glowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['softFade', 0.02, 3, 0.01, 'soft intersection']
  ],
  'Flicker & restrike': [
    ['restrike', 0.5, 90, 0.5, 'restrikes / sec'],
    ['flicker', 0, 1, 0.01, 'brightness stutter'],
    ['flickerSpeed', 1, 120, 1, 'stutter rate'],
    ['strandFlash', 0, 1, 0.01, 'filament blink'],
    ['tipGlow', 0, 8, 0.05, 'leading-edge glow'],
    ['tipLength', 0.005, 0.5, 0.005, 'leading-edge length']
  ],
  'Bolt colour': [
    ['colorCore', 'core'],
    ['colorInner', 'inner'],
    ['colorOuter', 'outer'],
    ['colorHalo', 'halo'],
    ['glow', 0, 8, 0.01, 'glow'],
    ['opacity', 0, 2, 0.01, 'opacity']
  ],
  'Burns on the ground': [
    ['arcRate', 0.05, 8, 0.05, 'burns / metre'],
    ['arcRadius', 0.1, 8, 0.05, 'burn radius'],
    ['arcLife', 0.05, 5, 0.05, 'burn lifetime'],
    ['arcIntensity', 0, 3, 0.01, 'burn intensity'],
    ['arcBranches', 0, 3, 0.01, 'branch detail'],
    ['scorchRadius', 0.05, 4, 0.05, 'scorch radius'],
    ['scorchLife', 0.5, 20, 0.1, 'scorch lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'scorch intensity'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['colorArc', 'burn'],
    ['colorEmber', 'ember'],
    ['colorScorch', 'scorch'],
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
    ['moteRate', 0, 600, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 12, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 8, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['colorSpark*', 'Spark colour'],
    ['colorMote*', 'Mote colour']
  ],
  'Smoke & debris': [
    ['smokeRate', 0, 500, 1, 'smoke rate'],
    ['smokeSize', 0.05, 4, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['smokeRise', -2, 4, 0.01, 'smoke rise'],
    ['debrisRate', 0, 300, 1, 'debris rate'],
    ['debrisSize', 0.005, 0.4, 0.005, 'debris size'],
    ['debrisSpeed', 0, 25, 0.1, 'debris speed'],
    ['debrisLifetime', 0.1, 5, 0.05, 'debris lifetime'],
    ['debrisGravity', -50, 0, 0.1, 'debris gravity'],
    ['colorSmoke*', 'Smoke colour'],
    ['colorDebris*', 'Debris colour']
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
    ['burstSparks', 0, 600, 1, 'burst sparks'],
    ['burstDebris', 0, 300, 1, 'burst debris'],
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
    ['lightFlicker', 0, 1, 0.01, 'light gutter'],
    ['lightFlickerSpeed', 1, 90, 1, 'gutter rate'],
    ['lightColor', 'light colour']
  ]
};
