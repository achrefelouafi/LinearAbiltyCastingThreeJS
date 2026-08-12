/* ================================================================== */
/* SNARE — ability five, and the first **far cast**                    */
/* ================================================================== */
/**
 * A trap planted at a point rather than a shot fired along a line: the caster
 * whips a leash of current out across the floor, and where it lands the ring
 * snaps open — a column of lightning tears up out of the middle, tendrils
 * crawl outward to the boundary and arcs run around the rim, all of it
 * holding, re-striking and dragging the air upward for `lifetime` before it
 * collapses. Reference for the look: `electricalboost.jpg`.
 *
 * This is the block that defines what a far cast *is* in this project. The
 * targeting is a circle (see the `zone` block) and `zoneRadius` is the promise
 * that circle makes: the boundary the indicator draws is the boundary the
 * field burns, the tendrils reach and the rim arcs run along, so dragging that
 * one number re-scales the indicator and a snare that is already standing
 * together.
 *
 * The whole cage is **one instanced strip** — see `materials/SnareMaterial.js`.
 * Every filament is the same ribbon, and a *role* decided from its instance
 * index (leash → column → tendril → rim) picks which parametric path the
 * vertex shader threads it along. Two draw calls for all four, however many
 * filaments are in the air.
 *
 * As in every other block, a cast captures nothing but a seed and a few
 * timestamps. Every metre, radian and second is resolved against these numbers
 * each frame — including a zero-length one, which is why the trap reshapes
 * under the sliders with the clock stopped.
 */
export const snare = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 0.0, // a trap can legitimately be dropped on your own feet
  zoneRadius: 4.4, // the footprint — what the circle indicator measures out
  speed: 62.0, // how fast the leash races to the point, metres/second
  snapTime: 0.16, // seconds the ring takes to slam open once it lands
  lifetime: 2.6, // seconds the snare stands
  fadeTime: 0.75, // seconds it takes to collapse
  cooldown: 1.4,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the leash that plants it --- */
  // Thrown from a hand, so these are measured from the caster's origin in the
  // cast's own frame, exactly as the bolt and the rock are.
  handHeight: 1.24, // metres above the floor
  handForward: 0.58, // metres in front of the caster
  handSide: 0.18, // metres to the side (+ follows `Ability#side`)
  leashStrands: 3, // filaments in the whip
  leashSag: -0.35, // metres the mid-span bows (negative drops it to the floor)
  leashSpread: 0.22, // how far the filaments separate, metres
  leashKink: 0.3, // kink amplitude on the whip, metres
  leashWidth: 1.0, // × the shared filament width
  leashCling: 0.12, // how far above the floor the tip runs, metres

  /* --- the column --- */
  strands: 15, // filaments in the pillar
  height: 9.2, // how high it reaches, metres
  heightCurve: 1.45, // <1 gets it up fast, >1 makes it climb late
  throat: 0.16, // radius where it leaves the floor, × zoneRadius
  columnSpread: 0.25, // radius at the top, × zoneRadius
  columnCurve: 2.88, // >1 keeps the throat tight then opens it late
  columnFlare: 0.585, // extra opening over the last quarter, × zoneRadius
  columnTwist: 0.22, // turns a filament makes over the climb
  columnSpin: 1.26, // turns/second the whole pillar rolls
  columnKink: 0.27, // kink amplitude, metres
  columnWidth: 1.86, // × the shared filament width
  columnTaper: 1.09, // how much thinner the top is than the base

  /* --- the tendrils crawling out to the boundary --- */
  tendrils: 20, // separate ground filaments (capped with the rest at 56)
  tendrilInner: 0.0, // where they leave the column, × zoneRadius
  tendrilReach: 1.07, // where they end, × zoneRadius (1 = exactly on the band)
  tendrilCurve: 1.18, // <1 throws them outward early
  tendrilWander: 1.41, // radians a tendril veers over its run
  tendrilArch: 1.16, // metres it hops off the floor mid-span
  tendrilHug: 0.005, // how far above the floor it runs, metres
  tendrilSpin: -0.225, // turns/second the whole fan rotates
  tendrilKink: 0.72, // kink amplitude, metres
  tendrilWidth: 0.75, // × the shared filament width
  tendrilDim: 0.8, // how much dimmer than the column

  /* --- the arcs running around the rim --- */
  rimArcs: 14, // arcs on the boundary at once
  rimSpan: 0.335, // fraction of the circle one arc covers
  rimSpeed: -1.84, // revolutions/second they travel
  // High enough to clear the burnt band underneath them: an arc that hops
  // 0.3 m over a band this bright is simply invisible.
  rimHeight: 0.98, // metres they hop at mid-span
  rimJitter: 0.23, // radial wobble, × zoneRadius
  rimKink: 0.15, // kink amplitude, metres
  rimWidth: 0.85, // × the shared filament width
  rimDim: 1.0,

  /* --- the shape every filament shares --- */
  // The same piecewise-linear value noise the bolt uses — linear on purpose,
  // because smoothstep rounds the corners off and the corners are the entire
  // reason it reads as lightning.
  jitter: 1.0, // master multiplier on the four per-role kink amplitudes
  jitterScale: 1.4, // kinks per metre
  octaves: 4, // 1–5; each halves the amplitude and doubles the rate
  jitterFalloff: 0.55, // amplitude kept per octave
  crawl: 2.4, // how fast the kinks slide along a filament
  pinch: 0.16, // fraction of the span the ends are pulled straight over
  restrike: 21, // times/second every filament re-rolls its shape
  flicker: 0.26, // depth of the whole-cage brightness stutter
  flickerSpeed: 30,
  strandFlash: 0.45, // how much individual filaments blink out

  /* --- the ribbon --- */
  width: 0.032, // half-width of a filament, metres
  coreSharp: 4.4, // how hard the hot core falls off across the ribbon
  glowWidth: 6.2, // the halo, × the core width
  glowFalloff: 2.3, // how fast the halo fades across its ribbon
  glowOpacity: 0.44,
  softFade: 0.7, // metres of soft fade where a filament meets geometry

  /* --- colour --- */
  // Violet rather than the Storm Lance's blue: two electric abilities on the
  // bar need to be told apart at a glance, and the hue split does it before
  // the silhouette does.
  colorCore: '#ffffff', // the centre of a filament
  colorInner: '#dcd0ff',
  colorOuter: '#8f6bff', // the outside of a filament
  colorHalo: '#2a0e8c', // the wide glow around the cage
  glow: 2.2, // overall emissive gain
  opacity: 1.0,

  /* --- the field burnt into the floor --- */
  /**
   * The indicator's promise, made real: the same circle, the same thick
   * boundary, now a live shader instead of a targeting aid. It is an
   * ability-owned mesh rather than a decal precisely because a decal captures
   * its radius when it spawns — this one has to re-scale under `zoneRadius`
   * while it is standing.
   */
  fieldBoundary: 0.02, // thickness of the burnt band, metres
  fieldBoundaryGlow: 2.9,
  fieldFill: 0.65, // the wash inside it
  fieldFalloff: 3.6, // how hard that wash crowds to the rim
  fieldVeins: 2.98, // filaments burnt across the disc
  fieldVeinScale: 2.0, // veins per metre
  fieldVeinSharp: 0.72, // 0 = a wash, 1 = hard threads
  fieldWarp: 0.55, // domain warp — what stops the veins reading as spokes
  fieldCrawl: 0.5, // how fast they writhe
  fieldRings: 2.4, // pressure rings travelling out from the middle
  fieldRingSpeed: 0.8, // rings/second
  fieldSpokes: 20, // ticks stepping around the boundary
  fieldSpokeLength: 0.5, // how far they reach in, metres
  fieldSpin: 0.05, // revolutions/second the ticks step around
  fieldCore: 1.3, // brightness of the pool the column stands in
  fieldCoreSize: 0.22, // its radius, × zoneRadius
  fieldPulse: 0.0, // brightness breathing
  fieldPulseSpeed: 3.95,
  fieldOpacity: 1.0,
  fieldHeight: 0.03, // hover distance above the floor, metres
  colorField: '#8f6bff', // the wash and the veins
  colorFieldEdge: '#ffffff', // the boundary band and the core pool

  /* --- what else the ground does --- */
  arcRate: 5.0, // branching burns laid around the rim, per second
  arcRadius: 1.2, // radius of one, metres
  arcLife: 0.75,
  arcIntensity: 0.9,
  arcBranches: 0.7, // how finely a burn splits into filaments
  trailRate: 1.1, // burns laid per metre while the leash races out
  scorchRadius: 1.6, // dark burn under the column, metres
  scorchLife: 7.5,
  scorchIntensity: 0.5,
  colorArc: '#c3b0ff',
  colorEmber: '#8f6bff',
  colorScorch: '#0b0813',
  shockRadius: 7.0, // the ring that snaps out when the trap opens, metres
  colorShockA: '#8f6bff', // body of the shockwave ring
  colorShockB: '#ffffff', // its crest

  /* --- sparks, updraft, smoke and debris --- */
  /**
   * As in every other block: a four-stop gradient sampled over the particle's
   * own lifetime, `A` at birth through `D` as it dies. The **updraft** is this
   * ability's signature system — motes drawn off the whole disc and hauled
   * inward and up into the column, which is the read that says the trap is
   * pulling on the air rather than just sitting in it.
   */
  sparkRate: 320, // sparks thrown off the cage, particles/second
  sparkSize: 0.15,
  sparkSpeed: 8.5,
  sparkLifetime: 0.55,
  sparkGravity: -13.0,
  sparkStretch: 0.2, // how far a spark smears along its velocity
  colorSparkA: '#ffffff',
  colorSparkB: '#dcd0ff',
  colorSparkC: '#8f6bff',
  colorSparkD: '#2a0e8c',
  updraftRate: 210, // motes hauled up the column, particles/second
  updraftSize: 0.07,
  updraftSpeed: 6.0, // how fast they are pulled in
  updraftLifetime: 1.4,
  updraftRise: 5.5, // upward acceleration once they are inside, m/s²
  updraftInset: 0.15, // how far inside the boundary they are picked up
  updraftTurbulence: 0.9,
  colorUpdraftA: '#8f6bff',
  colorUpdraftB: '#dcd0ff',
  colorUpdraftC: '#ffffff',
  colorUpdraftD: '#1b0a5e',
  smokeRate: 70, // haze scoured off the burnt floor
  smokeSize: 1.05,
  smokeSpeed: 1.2,
  smokeLifetime: 2.4,
  smokeOpacity: 0.06,
  smokeRise: 0.6,
  colorSmokeA: '#4a4368',
  colorSmokeB: '#3a3554',
  colorSmokeC: '#2b2740',
  colorSmokeD: '#191728',
  debrisRate: 30, // chips torn off the floor inside the ring
  debrisSize: 0.055,
  debrisSpeed: 5.5,
  debrisLifetime: 1.3,
  debrisGravity: -17.0,
  colorDebrisA: '#2a2733',
  colorDebrisB: '#201e28',
  colorDebrisC: '#1a1822',
  colorDebrisD: '#1a1822',

  /* --- dynamic light --- */
  lightIntensity: 24,
  lightRadius: 18,
  lightHeight: 0.38, // how far up the column the light sits, 0..1
  lightColor: '#a98bff',
  lightFlicker: 0.38, // depth of the light's gutter, 0 = steady
  lightFlickerSpeed: 24,

  /* --- the throw, the snap and the hold --- */
  muzzleSize: 0.5, // the flash at the hand as the leash leaves it
  muzzleIntensity: 1.7,
  castFlash: 0.09, // screen flash on release
  colorCastFlash: '#c3b0ff',
  burstSize: 2.8, // the shell thrown off when the ring opens, metres
  burstIntensity: 1.5,
  burstSparks: 200, // extra sparks at the snap
  burstDebris: 60,
  pulseRate: 1.5, // pressure shells shed off the column while it holds, /s
  pulseSize: 1.2, // radius of one, metres
  pulseIntensity: 0.5,
  ringRate: 1.4, // dust rings pushed across the floor while it holds, /s
  impactShake: 0.85,
  shakeDuration: 0.6,
  holdShake: 0.07, // continuous rumble while the snare stands
  impactFlash: 0.26,
  rumble: 0.025, // rumble while the leash races out
  colorBurstA: '#8f6bff',
  colorBurstB: '#dcd0ff',
  colorBurstC: '#ffffff',
  colorFlash: '#c3b0ff' // the full-screen flash when it snaps open
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Voltaic Snare — the first far cast.
 *
 * `zoneRadius` is the control that matters most here and the only one that
 * reaches outside the ability: it is read by the circle indicator *and* by
 * the tendrils, the rim arcs and the burnt field, so dragging it re-scales
 * what you aim with and what you get at the same time. After that,
 * `snapTime` and `height` carry the moment the trap opens, and `tendrils` /
 * `rimArcs` / `strands` decide how much of the footprint is actually lit.
 */
export const snareSchema = {
  'The cast': [
    ['zoneRadius', 0.5, 14, 0.05, 'footprint radius'],
    ['range', 2, 50, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 300, 1, 'leash speed'],
    ['snapTime', 0.02, 1.5, 0.01, 'snap-open time'],
    ['lifetime', 0.1, 12, 0.05, 'hold time'],
    ['fadeTime', 0.05, 4, 0.01, 'collapse time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The leash': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['leashStrands', 0, 6, 1, 'filaments'],
    ['leashSag', -3, 3, 0.01, 'mid-span bow'],
    ['leashSpread', 0, 2, 0.01, 'fan'],
    ['leashCling', 0, 1.5, 0.01, 'height at the tip'],
    ['leashKink', 0, 2, 0.01, 'kink amplitude'],
    ['leashWidth', 0.1, 4, 0.01, 'ribbon width']
  ],
  'The column': [
    ['strands', 0, 16, 1, 'filaments'],
    ['height', 0.5, 24, 0.1, 'height'],
    ['heightCurve', 0.1, 4, 0.01, 'climb curve'],
    ['throat', 0.005, 1, 0.005, 'throat, × footprint'],
    ['columnSpread', 0.01, 1, 0.005, 'top, × footprint'],
    ['columnCurve', 0.1, 5, 0.01, 'opening curve'],
    ['columnFlare', 0, 1, 0.005, 'top flare'],
    ['columnTwist', -4, 4, 0.01, 'twist over height'],
    ['columnSpin', -4, 4, 0.01, 'spin'],
    ['columnKink', 0, 2, 0.01, 'kink amplitude'],
    ['columnWidth', 0.1, 6, 0.01, 'ribbon width'],
    ['columnTaper', 0.05, 2, 0.01, 'taper to the top']
  ],
  'The tendrils': [
    ['tendrils', 0, 20, 1, 'tendrils'],
    ['tendrilInner', 0, 1, 0.005, 'start, × footprint'],
    ['tendrilReach', 0.05, 1.6, 0.01, 'end, × footprint'],
    ['tendrilCurve', 0.1, 4, 0.01, 'reach curve'],
    ['tendrilWander', 0, 4, 0.01, 'veer'],
    ['tendrilArch', 0, 3, 0.01, 'hop off the floor'],
    ['tendrilHug', 0.005, 1, 0.005, 'floor clearance'],
    ['tendrilSpin', -2, 2, 0.005, 'fan rotation'],
    ['tendrilKink', 0, 2, 0.01, 'kink amplitude'],
    ['tendrilWidth', 0.05, 4, 0.01, 'ribbon width'],
    ['tendrilDim', 0, 1, 0.01, 'dim vs the column']
  ],
  'The rim arcs': [
    ['rimArcs', 0, 14, 1, 'arcs'],
    ['rimSpan', 0.01, 1, 0.005, 'arc span, × the circle'],
    ['rimSpeed', -3, 3, 0.01, 'travel speed'],
    ['rimHeight', 0, 3, 0.01, 'hop height'],
    ['rimJitter', 0, 1, 0.01, 'radial wobble'],
    ['rimKink', 0, 2, 0.01, 'kink amplitude'],
    ['rimWidth', 0.05, 4, 0.01, 'ribbon width'],
    ['rimDim', 0, 1, 0.01, 'dim vs the column']
  ],
  'Filaments & flicker': [
    ['jitter', 0, 4, 0.01, 'kink master'],
    ['jitterScale', 0.05, 8, 0.01, 'kinks / metre'],
    ['octaves', 1, 5, 1, 'octaves'],
    ['jitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['crawl', -20, 20, 0.1, 'kink crawl'],
    ['pinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['restrike', 0.5, 90, 0.5, 'restrikes / sec'],
    ['flicker', 0, 1, 0.01, 'brightness stutter'],
    ['flickerSpeed', 1, 120, 1, 'stutter rate'],
    ['strandFlash', 0, 1, 0.01, 'filament blink']
  ],
  'The ribbon & colour': [
    ['width', 0.005, 0.4, 0.001, 'filament width'],
    ['coreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['glowWidth', 1, 30, 0.1, 'halo width'],
    ['glowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['glowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['softFade', 0.02, 3, 0.01, 'soft intersection'],
    ['glow', 0, 8, 0.01, 'glow'],
    ['opacity', 0, 2, 0.01, 'opacity'],
    ['colorCore', 'core'],
    ['colorInner', 'inner'],
    ['colorOuter', 'outer'],
    ['colorHalo', 'halo']
  ],
  'The field on the floor': [
    ['fieldBoundary', 0.02, 2, 0.01, 'band thickness'],
    ['fieldBoundaryGlow', 0, 8, 0.05, 'band glow'],
    ['fieldFill', 0, 2, 0.01, 'interior fill'],
    ['fieldFalloff', 0.1, 5, 0.05, 'fill falloff'],
    ['fieldVeins', 0, 3, 0.01, 'burnt veins'],
    ['fieldVeinScale', 0.1, 8, 0.05, 'veins / metre'],
    ['fieldVeinSharp', 0, 1, 0.01, 'vein sharpness'],
    ['fieldWarp', 0, 2, 0.01, 'domain warp'],
    ['fieldCrawl', -4, 4, 0.01, 'vein crawl'],
    ['fieldRings', 0, 12, 0.1, 'pressure rings'],
    ['fieldRingSpeed', -6, 6, 0.01, 'ring speed'],
    ['fieldSpokes', 0, 96, 1, 'boundary ticks'],
    ['fieldSpokeLength', 0.05, 3, 0.01, 'tick length'],
    ['fieldSpin', -2, 2, 0.005, 'tick spin'],
    ['fieldCore', 0, 4, 0.01, 'centre pool'],
    ['fieldCoreSize', 0.02, 1, 0.005, 'pool size, × footprint'],
    ['fieldPulse', 0, 1, 0.01, 'pulse'],
    ['fieldPulseSpeed', 0, 10, 0.05, 'pulse speed'],
    ['fieldOpacity', 0, 2, 0.01, 'opacity'],
    ['fieldHeight', 0.005, 0.4, 0.005, 'hover height'],
    ['colorField', 'field'],
    ['colorFieldEdge', 'band & pool']
  ],
  'Burns on the ground': [
    ['arcRate', 0, 30, 0.1, 'rim burns / sec'],
    ['arcRadius', 0.1, 8, 0.05, 'burn radius'],
    ['arcLife', 0.05, 5, 0.05, 'burn lifetime'],
    ['arcIntensity', 0, 3, 0.01, 'burn intensity'],
    ['arcBranches', 0, 3, 0.01, 'branch detail'],
    ['trailRate', 0.05, 8, 0.05, 'leash burns / metre'],
    ['scorchRadius', 0.05, 8, 0.05, 'scorch radius'],
    ['scorchLife', 0.5, 20, 0.1, 'scorch lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'scorch intensity'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['ringRate', 0, 12, 0.1, 'dust rings / sec'],
    ['colorArc', 'burn'],
    ['colorEmber', 'ember'],
    ['colorScorch', 'scorch'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest']
  ],
  'Sparks & updraft': [
    ['sparkRate', 0, 1200, 1, 'spark rate'],
    ['sparkSize', 0.005, 0.8, 0.005, 'spark size'],
    ['sparkSpeed', 0, 40, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 4, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['updraftRate', 0, 900, 1, 'updraft rate'],
    ['updraftSize', 0.005, 0.4, 0.005, 'updraft size'],
    ['updraftSpeed', 0, 25, 0.1, 'pull-in speed'],
    ['updraftLifetime', 0.1, 8, 0.05, 'updraft lifetime'],
    ['updraftRise', -5, 25, 0.1, 'lift'],
    ['updraftInset', 0, 0.95, 0.01, 'pick-up inset'],
    ['updraftTurbulence', 0, 3, 0.01, 'updraft swirl'],
    ['colorSpark*', 'Spark colour'],
    ['colorUpdraft*', 'Updraft colour']
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
  'Throw, snap & hold': [
    ['muzzleSize', 0.05, 6, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['burstSize', 0.2, 14, 0.05, 'snap shell size'],
    ['burstIntensity', 0, 5, 0.01, 'snap shell intensity'],
    ['burstSparks', 0, 600, 1, 'snap sparks'],
    ['burstDebris', 0, 300, 1, 'snap debris'],
    ['pulseRate', 0, 12, 0.1, 'hold shells / sec'],
    ['pulseSize', 0.1, 10, 0.05, 'hold shell size'],
    ['pulseIntensity', 0, 5, 0.01, 'hold shell intensity'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['holdShake', 0, 0.5, 0.005, 'hold rumble'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorCastFlash', 'release flash colour'],
    ['colorBurstA', 'shell'],
    ['colorBurstB', 'shell body'],
    ['colorBurstC', 'shell arcs'],
    ['colorFlash', 'snap flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightHeight', 0, 1, 0.01, 'height up the column'],
    ['lightFlicker', 0, 1, 0.01, 'light gutter'],
    ['lightFlickerSpeed', 1, 90, 1, 'gutter rate'],
    ['lightColor', 'light colour']
  ]
};
