/* ================================================================== */
/* EMBERFLOCK — Emberflight                                            */
/* ================================================================== */
/**
 * Two dozen ember birds thrown down the aimed line.
 *
 * The whole flock is **one draw call and one closed-form function of time**.
 * Nothing about a bird exists on the CPU — no velocity, no neighbour list, no
 * history — so every number below reshapes a flock that is already in the air,
 * with the clock stopped. `spacingSide` opens the formation out mid-flight;
 * `lag` strings it out behind the lead; `bank` changes how hard the birds roll
 * into their turns, and *that* one is the difference between a flock and a
 * handful of sparks.
 *
 * The trails are a second instanced strip that evaluates the same flock
 * function backwards in each bird's own clock, so a ribbon is threaded through
 * its bird by construction rather than by a buffer that has to be kept in step.
 * That is why `trailSpan` is measured in **seconds** and not in metres: the
 * tail is not a length, it is how far back in time the ribbon is allowed to
 * look.
 *
 * The one thing a cast captures is the flock seed, which shifts the separation
 * lattice so two casts do not lay the same formation out. That is a dice roll,
 * not a dimension.
 */
export const emberflock = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 17.0, // how fast the lead point runs the line, metres/second
  lifetime: 1.0, // seconds the flock holds at the target after it arrives
  fadeTime: 0.85, // seconds the last of it takes to go out
  cooldown: 0.9, // seconds before the slot re-arms
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the flock gathers --- */
  // Measured from the caster's origin in the cast's own frame, the way the
  // bolt's hand point is: birds leave a hand, not a pair of feet.
  handForward: 0.7, // metres in front of the caster
  handSide: 0.3, // metres to the side (+ follows `Ability#side`)
  handHeight: 1.45, // metres above the floor
  endHeight: 1.05, // metres above the floor where the line ends
  leadRise: 1.9, // metres the lead lofts at mid-span

  /* --- the formation (the separation lattice) --- */
  /**
   * `latticeX × latticeY × latticeZ` is the number of *distinct* slots a bird
   * can claim. Ask for more birds than that and two of them share a cell, which
   * is the one way the separation guarantee breaks — keep the product above
   * `birds`. The third axis is not a distance, it is the **lag**: latticeZ is
   * how many ranks are strung out behind the lead and `lag` is how far back in
   * seconds the last of them sits.
   */
  birds: 24, // live agents (capped at 48)
  latticeX: 6, // cells across
  latticeY: 3, // cells up
  latticeZ: 6, // ranks strung out behind the lead
  spacingSide: 0.72, // metres between lateral cells
  spacingUp: 0.46, // metres between vertical cells
  lag: 0.42, // seconds the back rank trails the lead by
  jitter: 0.18, // metres of per-bird slop off its own cell
  churn: 0.85, // radians/second the whole formation rolls
  breathe: 0.24, // fraction the formation swells by
  breatheRate: 1.9, // radians/second of that swell
  wander: 0.26, // metres of curl-noise drift — keep under half the spacing
  wanderScale: 0.55, // features per metre of that drift
  wanderSpeed: 0.65, // how fast the drift field moves
  gather: 1.0, // 0 collapses every bird onto the lead's own path

  /* --- the bird --- */
  size: 0.34, // metres, nose to tail
  aspect: 1.65, // wingspan / length
  sizeJitter: 0.34, // ±fraction of size
  sweep: 0.9, // how far the wings rake back
  dihedral: 0.42, // wing fold out of the card's plane, fraction of size
  wingCurl: 0.07, // static camber across the wing, fraction of size
  flapRate: 7.5, // wing-beats/second (each bird runs on its own phase)
  bank: 0.075, // radians of roll per m/s² of lateral acceleration
  bankMax: 1.15, // radians — the hard ceiling on that roll
  billboard: 0.12, // 0 the bird's own frame, 1 camera-facing
  edgeStretch: 1.7, // how much an edge-on bird grows so it stays a line
  edgeGain: 2.2, // how much brighter it gets while it is edge-on
  lit: 0.3, // 0 pure emissive, 1 wrapped diffuse
  revealTime: 0.22, // seconds the flock takes to appear at the hand
  revealSpread: 0.4, // 0..1 width of that appearance wave

  /* --- the bird's colour --- */
  colorBirdA: '#fff0c8', // birth end of the gradient
  colorBirdB: '#ffd27a',
  colorBirdC: '#ff6a1f',
  colorBirdD: '#3d0d04', // death end
  tint: 0.22, // where in that gradient the flock sits
  tintJitter: 0.3, // ±per-bird walk along it
  tintAlong: 0.4, // extra walk from nose to tail
  opacity: 1.0,
  glow: 1.7, // emissive gain on the birds
  softFade: 0.3, // metres of soft fade where a bird meets geometry

  /* --- the trails --- */
  trailSpan: 0.38, // SECONDS of flight the tail reaches back over
  trailWidth: 0.1, // metres, half-width at the bird
  trailTaper: 1.6, // >1 sharpens the tail to a point
  trailLift: 0.42, // metres/second the tail floats above the flown path
  trailSag: 0.55, // metres/second² it then slumps back down
  trailWobble: 0.55, // metres of curl drift per second of tail age
  trailWobbleScale: 0.7, // features per metre of that drift
  trailWobbleSpeed: 0.6, // how fast the drift field moves
  trailCore: 1.7, // how tightly light crowds the ribbon's centre line
  trailHeadBias: 0.5, // >0 keeps the brightness near the bird
  trailOpacity: 0.85,
  trailGlow: 1.5,
  trailSoftFade: 0.4, // metres of soft fade against solid geometry
  trailTint: 0.12, // where in the trail gradient the head sits
  trailTintAlong: 0.72, // how far down it the tail walks
  trailTintJitter: 0.18, // ±per-bird walk along it
  trailPersist: 0.25, // SECONDS the trails outlive the birds
  trailFadeTime: 0.4, // seconds they then take to go out
  colorTrailA: '#ffe6b0',
  colorTrailB: '#ff9a3c',
  colorTrailC: '#c02c06',
  colorTrailD: '#2a0803',

  /* --- the collapse and the column --- */
  /**
   * The last beat. On arrival the formation squeezes onto its own lead point
   * over `collapseTime`, and then the point itself lifts by `columnHeight` over
   * `columnTime` while the lattice's vertical spacing opens back out — a wide
   * flock becomes a narrow chimney of birds going up.
   *
   * `columnTrailSpan` is shortened deliberately. A long tail on a bird that is
   * climbing straight up draws a rope, not a rising ember; cutting the span to
   * a fifth of a second turns the ribbons into flecks and the column reads.
   */
  collapseTime: 0.22, // seconds the squeeze onto the point takes
  collapseTighten: 0.85, // 0..1 how much of the slop the squeeze removes
  columnTime: 0.42, // seconds the column takes to rise
  columnHeight: 4.6, // metres it rises by
  columnRadius: 0.16, // metres between lateral cells once collapsed
  columnSpacing: 0.62, // metres between vertical cells once collapsed
  columnLag: 0.16, // seconds the back rank trails by once collapsed
  columnChurn: 2.6, // radians/second the column twists at
  columnTrailSpan: 0.16, // seconds of tail while the column climbs
  birdFade: 0.25, // seconds the birds take to wink out at the top

  /* --- embers, sparks and smoke --- */
  /**
   * As everywhere else in this project, each system is coloured by a four-stop
   * gradient sampled over the particle's own lifetime, `A` at birth through `D`
   * as it dies. Spelled out rather than derived from the bird palette, so the
   * smoke can be made cold while the flock stays gold.
   */
  emberRate: 260, // embers shed by the flock, particles/second
  emberSize: 0.1,
  emberSpeed: 1.6, // metres/second off the birds
  emberLifetime: 1.5, // seconds
  emberRise: 1.4, // buoyancy, metres/second
  emberTurbulence: 0.85,
  colorEmberA: '#fff2d0',
  colorEmberB: '#ffb14a',
  colorEmberC: '#ff5a12',
  colorEmberD: '#3d0d04',
  sparkRate: 130, // hard bright streaks off the wings, particles/second
  sparkSize: 0.11,
  sparkSpeed: 5.5,
  sparkLifetime: 0.6,
  sparkGravity: -9.5, // metres/second²
  sparkStretch: 0.24, // how far a spark smears along its velocity
  colorSparkA: '#ffffff',
  colorSparkB: '#ffe08a',
  colorSparkC: '#ff7a1f',
  colorSparkD: '#5a1604',
  smokeRate: 42, // thin soot left hanging on the line, particles/second
  smokeSize: 0.9,
  smokeSpeed: 0.9,
  smokeLifetime: 2.4,
  smokeRise: 0.7,
  smokeOpacity: 0.09,
  colorSmokeA: '#4a3a30',
  colorSmokeB: '#3a2c24',
  colorSmokeC: '#2a201a',
  colorSmokeD: '#181210',

  /* --- what the ground gets --- */
  scorchRate: 0.55, // char marks laid per metre of lead travel
  scorchRadius: 0.55, // radius of one mark, metres
  scorchLife: 5.0, // seconds a mark lingers
  scorchIntensity: 0.5,
  colorScorch: '#140a06', // the burn itself
  colorCharEmber: '#ff6a1f', // the embers still cooling in it

  /* --- the release and the arrival --- */
  gatherSparks: 26, // sparks thrown as the flock forms at the hand
  castFlash: 0.08, // screen flash on release
  colorCastFlash: '#ffd27a',
  burstSize: 2.2, // the fireball where the flock collapses, metres
  burstIntensity: 1.5,
  burstSparks: 150, // extra sparks thrown at the collapse
  burstEmbers: 120,
  columnEmbers: 320, // embers/second fed into the rising column
  columnSpeed: 6.5, // how fast those embers climb, metres/second
  shockRadius: 4.5, // ring snapped across the floor on arrival, metres
  colorShockA: '#ffd27a', // body of that ring
  colorShockB: '#fff4d8', // its crest
  colorBurstA: '#ff6a1f', // burst shell
  colorBurstB: '#ffb14a', // burst body
  colorBurstC: '#fff0c8', // the filaments racing over it
  colorFlash: '#ffb14a', // the full-screen flash on arrival
  impactShake: 0.42,
  shakeDuration: 0.5, // seconds that shake decays over
  impactFlash: 0.16,
  rumble: 0.012, // continuous shake while the flock is downrange

  /* --- dynamic light --- */
  lightIntensity: 17, // the flock carries its own light
  lightRadius: 13,
  lightColor: '#ff9a3c',
  lightFlicker: 0.26, // depth of the flame gutter, 0 = steady
  lightFlickerSpeed: 13 // gutters/second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Emberflight.
 *
 * The four controls that carry the character, in the order worth reaching for:
 * **`bank`** (the roll out of a turn — drop it to zero and the flock instantly
 * reads as sparks), **`lag`** and **`latticeZ`** (how strung out the skein is),
 * **`churn`** (how much the formation rolls, which is what generates the
 * lateral acceleration the bank feeds on) and **`trailSpan`** (how much of the
 * screen the flock's history occupies).
 *
 * `wander` has a trap in it: past about half of `spacingSide` the curl drift is
 * bigger than a lattice cell and birds start passing through one another, at
 * which point the whole thing reads as smoke with wings. The slider's range
 * lets you go there; the default does not.
 */
export const emberflockSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 80, 0.5, 'flock speed'],
    ['lifetime', 0.1, 4, 0.01, 'hold at target'],
    ['fadeTime', 0.05, 4, 0.01, 'fade time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where they gather': [
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['endHeight', 0, 5, 0.01, 'height at target'],
    ['leadRise', -2, 8, 0.05, 'mid-span loft']
  ],
  'The formation': [
    ['birds', 1, 48, 1, 'birds'],
    ['latticeX', 1, 16, 1, 'cells across'],
    ['latticeY', 1, 10, 1, 'cells up'],
    ['latticeZ', 1, 24, 1, 'ranks back'],
    ['spacingSide', 0.02, 3, 0.01, 'lateral spacing'],
    ['spacingUp', 0.02, 3, 0.01, 'vertical spacing'],
    ['lag', 0, 2.5, 0.01, 'rank lag'],
    ['jitter', 0, 1.5, 0.01, 'cell slop'],
    ['churn', -6, 6, 0.01, 'formation roll'],
    ['breathe', 0, 1.5, 0.01, 'swell'],
    ['breatheRate', 0, 8, 0.05, 'swell rate'],
    ['wander', 0, 1.5, 0.01, 'curl drift'],
    ['wanderScale', 0.05, 3, 0.01, 'drift features / m'],
    ['wanderSpeed', 0, 4, 0.01, 'drift speed'],
    ['gather', 0, 1, 0.01, 'collapse onto lead']
  ],
  'The bird': [
    ['size', 0.02, 2, 0.01, 'size'],
    ['aspect', 0.3, 4, 0.01, 'span / length'],
    ['sizeJitter', 0, 1, 0.01, 'size jitter'],
    ['sweep', 0, 2, 0.01, 'wing rake'],
    ['dihedral', 0, 1.5, 0.01, 'wing fold'],
    ['wingCurl', -1, 1, 0.01, 'wing camber'],
    ['flapRate', 0, 20, 0.1, 'wing-beats / sec'],
    ['bank', 0, 0.5, 0.001, 'bank per m/s²'],
    ['bankMax', 0, 2, 0.01, 'max bank'],
    ['billboard', 0, 1, 0.01, 'camera facing'],
    ['edgeStretch', 1, 5, 0.01, 'edge-on stretch'],
    ['edgeGain', 0, 6, 0.01, 'edge-on gain'],
    ['lit', 0, 1, 0.01, 'diffuse mix'],
    ['revealTime', 0.01, 2, 0.01, 'gather time'],
    ['revealSpread', 0.01, 1, 0.01, 'gather spread']
  ],
  'Bird colour': [
    ['colorBird*', 'Bird gradient'],
    ['tint', 0, 1, 0.01, 'gradient position'],
    ['tintJitter', 0, 1, 0.01, 'per-bird walk'],
    ['tintAlong', 0, 1, 0.01, 'nose-to-tail walk'],
    ['opacity', 0, 2, 0.01, 'opacity'],
    ['glow', 0, 6, 0.01, 'glow'],
    ['softFade', 0.02, 2, 0.01, 'soft intersection']
  ],
  'The trails': [
    ['trailSpan', 0.02, 2, 0.01, 'tail length (seconds)'],
    ['trailWidth', 0.005, 0.6, 0.005, 'tail width'],
    ['trailTaper', 0.1, 5, 0.01, 'tail taper'],
    ['trailLift', -2, 4, 0.01, 'tail lift'],
    ['trailSag', -2, 4, 0.01, 'tail sag'],
    ['trailWobble', 0, 3, 0.01, 'tail drift'],
    ['trailWobbleScale', 0.05, 3, 0.01, 'drift features / m'],
    ['trailWobbleSpeed', 0, 4, 0.01, 'drift speed'],
    ['trailCore', 0.1, 6, 0.01, 'core tightness'],
    ['trailHeadBias', 0, 1, 0.01, 'head bias'],
    ['trailOpacity', 0, 2, 0.01, 'opacity'],
    ['trailGlow', 0, 6, 0.01, 'glow'],
    ['trailSoftFade', 0.02, 2, 0.01, 'soft intersection'],
    ['trailTint', 0, 1, 0.01, 'gradient position'],
    ['trailTintAlong', 0, 1, 0.01, 'head-to-tail walk'],
    ['trailTintJitter', 0, 1, 0.01, 'per-bird walk'],
    ['trailPersist', 0, 2, 0.01, 'outlive the birds'],
    ['trailFadeTime', 0.05, 3, 0.01, 'trail fade'],
    ['colorTrail*', 'Trail gradient']
  ],
  'The collapse & column': [
    ['collapseTime', 0.05, 2, 0.01, 'collapse time'],
    ['collapseTighten', 0, 1, 0.01, 'slop removed'],
    ['columnTime', 0.05, 3, 0.01, 'rise time'],
    ['columnHeight', 0, 20, 0.1, 'rise height'],
    ['columnRadius', 0.01, 1.5, 0.01, 'column lateral spacing'],
    ['columnSpacing', 0.02, 3, 0.01, 'column vertical spacing'],
    ['columnLag', 0, 1.5, 0.01, 'column rank lag'],
    ['columnChurn', -8, 8, 0.01, 'column twist'],
    ['columnTrailSpan', 0.02, 1, 0.01, 'column tail (seconds)'],
    ['birdFade', 0.05, 2, 0.01, 'birds wink out over'],
    ['columnEmbers', 0, 900, 1, 'column embers / sec'],
    ['columnSpeed', 0, 20, 0.1, 'column ember speed']
  ],
  'Embers & sparks': [
    ['emberRate', 0, 900, 1, 'ember rate'],
    ['emberSize', 0.005, 0.5, 0.005, 'ember size'],
    ['emberSpeed', 0, 12, 0.05, 'ember speed'],
    ['emberLifetime', 0.1, 6, 0.05, 'ember lifetime'],
    ['emberRise', -2, 8, 0.05, 'ember rise'],
    ['emberTurbulence', 0, 3, 0.01, 'ember turbulence'],
    ['sparkRate', 0, 900, 1, 'spark rate'],
    ['sparkSize', 0.005, 0.5, 0.005, 'spark size'],
    ['sparkSpeed', 0, 30, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 3, 0.01, 'spark lifetime'],
    ['sparkGravity', -40, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['colorEmber*', 'Ember colour'],
    ['colorSpark*', 'Spark colour']
  ],
  'Smoke & ground': [
    ['smokeRate', 0, 400, 1, 'smoke rate'],
    ['smokeSize', 0.05, 4, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime'],
    ['smokeRise', -2, 4, 0.01, 'smoke rise'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['colorSmoke*', 'Smoke colour'],
    ['scorchRate', 0.02, 4, 0.02, 'char marks / metre'],
    ['scorchRadius', 0.05, 4, 0.05, 'char radius'],
    ['scorchLife', 0.5, 20, 0.1, 'char lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'char intensity'],
    ['colorScorch', 'char'],
    ['colorCharEmber', 'char embers']
  ],
  'Release & arrival': [
    ['gatherSparks', 0, 200, 1, 'sparks on release'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour'],
    ['burstSize', 0.2, 10, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['burstSparks', 0, 600, 1, 'burst sparks'],
    ['burstEmbers', 0, 600, 1, 'burst embers'],
    ['shockRadius', 0.5, 20, 0.1, 'shockwave radius'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst filaments'],
    ['colorFlash', 'arrival flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightFlicker', 0, 1, 0.01, 'light gutter'],
    ['lightFlickerSpeed', 1, 60, 1, 'gutter rate'],
    ['lightColor', 'light colour']
  ]
};
