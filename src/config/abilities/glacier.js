/* ================================================================== */
/* GLACIER — ability six, and the far cast that comes out of the floor */
/* ================================================================== */
/**
 * A cold front races along the floor to the aimed point, the disc freezes out
 * to the boundary the circle drew, and a wall of crystal tears up out of the
 * ground around it: a ring of blades leaning outward with a skirt of wreckage
 * banked against their feet. It stands, glints, breathes cold off its rim —
 * and then breaks into plates and sinks back into the floor. Reference for the
 * look: `Hud7Xfg3LH.jpg`.
 *
 * The **middle stays open**: every shard is seated in a band about
 * `zoneRadius` and nothing is planted in the centre, because the read is a
 * wall you are looking into and filling the disc stops it being a ring. What
 * lives inside it is air and frozen ground.
 *
 * The second **far cast**, and the counterpart to the Voltaic Snare: same
 * circle, same promise, opposite answer. The snare fills the footprint with
 * current standing in the air; this one fills it with geometry standing on the
 * ground, so `zoneRadius` is again the one number that matters — it is where
 * the ring of blades is seated, where the sheet's boundary band burns, where
 * the curtain of cold air stands and where the rime creeps.
 *
 * Three things carry it, and each has its own group below:
 *
 *  - **the sweep.** The ring does not appear; it *closes*. The blade nearest
 *    the caster goes up first and the wave runs around both sides to meet
 *    behind the crown (`sweepTime`), with the skirt banking up behind the wave
 *    (`skirtDelay`, `skirtWave`).
 *  - **the freeze front.** Every shard crystallises upward along its own axis
 *    while it rises (`frontRough`, `frontWidth`, `frontGlow` — see
 *    `materials/GlacierMaterial.js`), so the ice *forms* rather than sliding
 *    out of a hole.
 *  - **the shatter.** It leaves the same way it arrived, in pieces: a
 *    per-shard ramp against a chunk id made of voronoi cells and flat facets,
 *    so plates and wedges come away one at a time (`shatterScale`,
 *    `shatterEdge`, `shatterGlow`).
 *
 * As in every other block, a cast captures nothing but a seed and a handful of
 * timestamps. Every metre, radian and second is resolved against these numbers
 * each frame — including a zero-length one, which is why the crown reshapes
 * under the sliders with the clock stopped.
 */
export const glacier = {
  /* --- the cast --- */
  range: 18.0, // maximum cast distance, metres
  minRange: 0.0, // a wall of ice around your own feet is a legitimate play
  zoneRadius: 4.6, // the footprint — what the circle indicator measures out
  speed: 44.0, // how fast the front races to the point, metres/second
  snapTime: 0.22, // seconds the sheet takes to freeze out to the boundary
  lifetime: 4.2, // seconds the crown stands
  shatterDelay: 0.5, // seconds after `lifetime` before the ice starts to break
  shatterStagger: 0.45, // seconds of random delay between neighbours
  sinkTime: 1.15, // seconds one shard takes to crumble and withdraw
  cooldown: 1.6,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the front leaves the caster --- */
  // Thrown from a hand, so these are measured from the caster's origin in the
  // cast's own frame, exactly as the bolt, the rock and the leash are.
  handHeight: 1.22, // metres above the floor
  handForward: 0.6, // metres in front of the caster
  handSide: 0.18, // metres to the side (+ follows `Ability#side`)

  /* --- how the footprint is filled --- */
  /**
   * Everything is seated in a band about `zoneRadius`; the middle of the
   * circle is left empty on purpose, because the read of the ability is a wall
   * you are looking *into* and filling the disc stops it being a ring. The
   * spire in the middle is kept as a control and ships at zero.
   */
  spikeCount: 220, // instances spent on one cast (capped at 320)
  density: 1.0, // multiplier on that count
  ringShare: 0.6, // fraction of them spent on the wall at the boundary
  coreShare: 0.0, // ... on the spire in the middle (0 = the middle stays open)
  lateShare: 0.12, // ... held back to push up during the hold
  ringSeat: 0.94, // where the wall stands, × zoneRadius
  ringScatter: 0.16, // radial jitter of the wall, × zoneRadius
  skirtSeat: 0.74, // inner lip of the wreckage banked against it, × zoneRadius
  skirtBand: 0.42, // how wide that band is, × zoneRadius
  skirtBias: 0.9, // <1 pushes the skirt outward, >1 crowds it inward
  coreSpread: 0.16, // radius of the cluster in the middle, × zoneRadius

  /* --- the silhouette --- */
  /**
   * The reference is a *starburst*, not a fence: long needles thrown outward
   * from the rim at a steep angle, fanned off the radius so they cross, with
   * wildly uneven lengths. `ringLean` is the single control that decides
   * whether this reads as a crown or a picket line — at 0 it is a fence, and
   * the higher it goes the further the blades are thrown out over the floor.
   */
  ringHeight: 1.4, // length of a blade on the wall, metres
  ringWave: 0.61, // how uneven the crest of that wall is, 0..1
  skirtHeight: 1.7, // length of a shard in the skirt, metres
  coreHeight: 5.2, // length of the spire, metres
  heightJitter: 0.65,
  ringLean: 0.33, // radians the wall is thrown outward (≈19°)
  skirtLean: 0.3, // ... and the skirt
  coreLean: 0.2, // the spire stands nearly upright
  leanJitter: 1.3,
  fan: 1.16, // radians a blade is splayed off its own radius, ± — the crossing
  twist: 1.0, // random yaw, 0..1 of a full turn
  rubble: 0.53, // fraction of the skirt demoted to ankle-height wreckage
  rubbleScale: 0.34,

  /* --- an individual crystal --- */
  // Blunt wedges rather than needles: a thick base that only narrows to about
  // a third at the tip, so each facet stays wide enough to catch a flash.
  radius: 0.375, // base radius, metres
  radiusJitter: 0.94,
  taper: 0.36, // tip radius as a fraction of the base
  facets: 7, // sides of the prism — fewer, so each facet is a broad flash
  roughness: 0.0, // how far the facets are pushed off a clean prism
  bend: 0.0, // sideways curve from base to tip — nearly straight

  /* --- the bloom: when each shard goes up --- */
  riseTime: 0.2, // seconds from buried to full height
  riseOvershoot: 0.3, // how far past full height the punch carries
  settle: 0.5, // seconds the overshoot takes to damp out
  sweepTime: 0.42, // seconds the wave takes to run around the ring
  skirtDelay: 0.1, // seconds before the skirt starts
  skirtWave: 0.26, // ... and how long it takes to cross the band
  coreDelay: 0.2, // seconds before the spire comes up
  stagger: 0.07, // seconds of random delay on top of all of it
  bloomSpread: 0.7, // fraction of the hold the late shards are scattered over

  /* --- the ice: prismatic glass, not the Lance's quarried crystal --- */
  /**
   * Deliberately the *opposite* treatment to `ice`. Two frost abilities on one
   * bar have to be told apart before the silhouette does it, and a recolour is
   * not enough — so where the Frost Lance is milky, diffuse and tinted deeper
   * the thicker it gets, these blades are near-empty glass carried entirely by
   * their edges: a chromatically split fresnel (`dispersion`), light piped up
   * the body to an incandescent point (`pipe`, `tipBias`, `tipGlow`), flow
   * lines instead of feather frost (`stria`) and one real reflection of the
   * stage off every facet (`envIntensity`, `specular`).
   * See `materials/GlacierMaterial.js`.
   */
  colorGlass: '#0e4a66', // the little body it has
  colorEdge: '#ffffff', // the silhouette, the flow lines and the glint
  colorPrismA: '#57f0ff', // one end of the dispersion split
  colorPrismB: '#8f9bff', // ... and the other
  colorCore: '#a8f4ff', // the light piped up the blade
  colorTip: '#ffffff', // the incandescent point
  body: 1.37, // how much of a body it has at all, 0 = pure edges
  edgePower: 1.14, // how tightly the silhouette hugs the rim
  edgeGain: 0.81, // how hard it burns
  dispersion: 0.73, // how far the red, green and blue fresnels come apart
  pipe: 1.09, // light piped along the blade
  tipBias: 1.6, // how hard that light crowds toward the point
  bands: 1.4, // slow waves travelling up it
  pulseSpeed: 0.6,
  tipStart: 0.6, // where the incandescent tip begins, 0..1 up the blade
  tipGlow: 1.5,
  stria: 0.75, // flow lines running the blade's length
  striaScale: 6.0,
  envIntensity: 0.6, // how much of the HDR probe the facets catch
  specular: 2.0, // the tight sun lobe off them
  glow: 1.0, // overall emissive gain
  opacity: 1.0,
  birthGlow: 2.2, // extra glow on a shard that has just erupted
  birthFade: 0.5, // seconds that birth flash lasts

  /* --- the freeze front and the shatter --- */
  /**
   * The two things that make this ability's ice *arrive* and *leave* rather
   * than fade in and out. Both are per-instance ramps the ability drives; what
   * lives here is only their look.
   */
  frontRough: 0.35, // how ragged the crystallising edge is
  frontWidth: 0.12, // how much of the shard is lit behind that edge
  frontGlow: 2.4, // how hard it burns
  shatterScale: 7.0, // break-up cells per unit of the crystal
  shatterEdge: 0.08, // width of the lit rim on a fresh break
  shatterGlow: 3.0,

  /* --- the sheet of ice on the floor --- */
  /**
   * The indicator's promise, made real: the same circle and the same thick
   * boundary, now a frozen sheet instead of a targeting aid. An ability-owned
   * mesh rather than a decal precisely because a decal captures its radius
   * when it spawns — this one has to re-scale under `zoneRadius` while the
   * crown is standing, and to run its own front outward and back.
   */
  fieldBoundary: 0.4, // thickness of the band at the edge, metres
  fieldBoundaryGlow: 2.4,
  fieldFill: 0.26, // the wash inside it
  fieldFalloff: 1.4, // how hard that wash crowds to the rim
  fieldPlates: 1.0, // tonal break-up between plates
  fieldPlateScale: 2.2, // plates per metre
  fieldSeam: 0.8, // rime piled in the seams between them
  fieldFingers: 0.9, // frost fingers crawling over the sheet
  fieldFingerScale: 1.6, // fingers per metre
  fieldWarp: 0.5, // domain warp — what stops them reading as spokes
  fieldCrawl: 0.12, // how fast they writhe
  fieldRings: 2.6, // pressure rings travelling in toward the spire
  fieldRingSpeed: -0.5, // rings/second (negative travels inward)
  fieldSweep: 0.4, // slow cold sweep around the disc
  fieldSweepSpeed: 0.12, // revolutions/second
  fieldCore: 1.0, // brightness of the pool the spire stands in
  fieldCoreSize: 0.2, // its radius, × zoneRadius
  fieldPulse: 0.18, // brightness breathing
  fieldPulseSpeed: 1.6,
  fieldOpacity: 1.0,
  fieldHeight: 0.03, // hover distance above the floor, metres
  colorField: '#a7e6ff', // the wash, the plates and the fingers
  colorFieldEdge: '#ffffff', // the boundary band, the seams and the pool

  /* --- the curtain of cold air standing on the ring --- */
  /**
   * An open cylinder seated on the boundary, eroded by ridged noise stretched
   * hard vertically and scrolled downward. This is the piece that frames the
   * crown from the outside: without it the wall of blades ends at its own
   * silhouette, and a wall of ice that is not shedding cold reads as glass.
   * Set `veil` to 0 to take it off.
   */
  veil: 0.5, // master opacity of the curtain, 0 hides it
  veilHeight: 1.9, // how high it stands, metres
  veilRadius: 1.02, // where it stands, × zoneRadius
  veilFlare: 0.32, // how far it leans outward at the top
  veilBillow: 0.22, // metre-scale lobes pushing its silhouette off round
  veilScale: 1.4, // noise features per metre
  veilStretch: 0.5, // <1 draws the structures out into vertical falls
  veilFlow: 0.4, // how fast they pour downward
  veilErode: 0.55, // how much harder the top is eaten away than the base
  veilFalloff: 1.8, // how fast it thins with height
  veilSpin: 0.02, // revolutions/second the whole curtain turns
  veilSoftFade: 0.8, // metres of soft fade where it meets geometry
  colorVeil: '#8cd2ff',
  colorVeilCrest: '#ffffff',

  /* --- what the ground does --- */
  trailFrostRate: 2.2, // rime patches laid per metre of front travel
  trailFrostRadius: 1.0, // radius of one, metres
  frostSpread: 1.5, // the rime sheet under the crown, × zoneRadius
  frostLife: 7.5, // seconds a rime patch lingers
  frostIntensity: 0.85,
  frostCrystals: 1.5, // grain of the packed snow
  frostCollar: 2.6, // rime around the foot of a blade, × its own radius
  rimeRate: 3.0, // rime patches creeping around the boundary, per second
  rimeRadius: 1.0, // radius of one, metres
  colorFrost: '#f0f9ff', // the lit face of the snow
  colorFrostEdge: '#79b6dd', // what it goes in its own shadow
  shockRadius: 7.5, // the ring that snaps out when the crown blooms, metres
  ringRate: 0.9, // pressure rings pushed out while it stands, per second
  colorShockA: '#8ee8ff', // body of the shockwave ring
  colorShockB: '#ffffff', // its crest

  /* --- mist, chips, glitter and snow --- */
  /**
   * As in every other block: a four-stop gradient sampled over the particle's
   * own lifetime, `A` at birth through `D` as it dies. The **snow** is this
   * ability's signature system — ice dust spawned *above* the crown and left
   * to fall back down through it. Everything else in the project is thrown
   * upward, and a slow fall inside the ring is what says the air over it is
   * freezing rather than burning.
   */
  mistRate: 240, // cold air pouring off the rim, particles/second
  mistSize: 1.1,
  mistSpeed: 1.6,
  mistLifetime: 3.0,
  mistOpacity: 0.055,
  mistRise: -0.12, // negative: cold air is heavy, it falls and spreads
  mistTurbulence: 0.4,
  colorMistA: '#f2feff',
  colorMistB: '#cdefff',
  colorMistC: '#8ec9e8',
  colorMistD: '#0a2c42',
  shardSize: 0.07, // ice chips
  shardSpeed: 6.5,
  shardLifetime: 1.6,
  shardGravity: -15.0,
  breachShards: 3, // chips thrown as one shard breaks the surface
  shatterShards: 5, // ... and as it comes apart
  colorShardA: '#ffffff',
  colorShardB: '#cdefff',
  colorShardC: '#8ee8ff',
  colorShardD: '#0a3c55',
  glitterRate: 150, // the sparkle lifting off the sheet
  glitterSize: 0.05,
  glitterSpeed: 2.6,
  glitterLifetime: 2.4,
  glitterRise: 1.3, // upward drift, metres/second
  glitterTurbulence: 0.6,
  glitterGlow: 1.0,
  colorGlitterA: '#ffffff',
  colorGlitterB: '#6fe0ff',
  colorGlitterC: '#bdeeff',
  colorGlitterD: '#062434',
  snowRate: 110, // ice dust falling back through the crown
  snowSize: 0.045,
  snowSpeed: 0.9, // how hard it is pushed downward to start with
  snowLifetime: 3.2,
  snowFall: -1.1, // gravity on it, metres/second²
  snowTurbulence: 0.85, // what turns the fall into a drift
  snowGlow: 0.9,
  snowInset: 0.85, // how far inside the boundary it falls, × zoneRadius
  snowHeight: 1.35, // where it starts, × the height of the wall
  colorSnowA: '#ffffff',
  colorSnowB: '#e4f9ff',
  colorSnowC: '#a7e6ff',
  colorSnowD: '#0c3348',

  /* --- dynamic light --- */
  lightIntensity: 14,
  lightRadius: 16,
  lightHeight: 0.45, // how far up the crown the light sits, 0..1
  lightColor: '#8ee8ff',

  /* --- the throw, the bloom and the hold --- */
  muzzleSize: 0.55, // the puff at the hand as the front leaves it
  muzzleIntensity: 1.5,
  castFlash: 0.08, // screen flash on release
  colorCastFlash: '#cdefff',
  burstSize: 4.0, // the vapour shell thrown off at the bloom, metres
  burstIntensity: 1.1,
  burstShards: 120, // extra chips at the bloom
  burstMist: 70,
  burstGlitter: 140,
  vapourRate: 1.6, // vapour shells shed off the wall while it stands, /s
  vapourSize: 1.4, // radius of one, metres
  vapourIntensity: 0.7,
  impactShake: 0.85,
  shakeDuration: 0.85,
  holdShake: 0.05, // continuous rumble while the crown stands
  impactFlash: 0.2,
  rumble: 0.045, // rumble while the front races out
  colorBurstA: '#a7e6ff',
  colorBurstB: '#cdefff',
  colorBurstC: '#ffffff',
  colorFlash: '#cdefff' // the full-screen flash when it blooms
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Glacial Crown — the far cast that comes out of the floor.
 *
 * `zoneRadius` is again the control that reaches outside the ability: it is
 * read by the circle indicator *and* by the ring of blades, the sheet and the
 * curtain, so dragging it re-scales what you aim with and what you get
 * together. After that the two groups that carry the cast are **The bloom**,
 * where `sweepTime` decides how the ring closes, and **Freeze front &
 * shatter**, which is how the ice arrives and how it leaves.
 */
export const glacierSchema = {
  'The cast': [
    ['zoneRadius', 0.5, 14, 0.05, 'footprint radius'],
    ['range', 2, 50, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'front speed'],
    ['snapTime', 0.02, 1.5, 0.01, 'freeze-out time'],
    ['lifetime', 0.2, 14, 0.05, 'hold time'],
    ['shatterDelay', 0, 4, 0.01, 'delay before it breaks'],
    ['shatterStagger', 0, 3, 0.01, 'break stagger'],
    ['sinkTime', 0.05, 5, 0.01, 'crumble time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where the front leaves the hand': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['muzzleSize', 0.05, 6, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour']
  ],
  'Filling the footprint': [
    ['spikeCount', 1, 320, 1, 'shards'],
    ['density', 0.1, 2, 0.01, 'density'],
    ['ringShare', 0, 1, 0.01, 'share on the wall'],
    ['coreShare', 0, 0.5, 0.01, 'share on the spire'],
    ['lateShare', 0, 0.5, 0.01, 'share held back'],
    ['ringSeat', 0.2, 1.4, 0.01, 'wall seat, × footprint'],
    ['ringScatter', 0, 0.6, 0.005, 'wall jitter, × footprint'],
    ['skirtSeat', 0, 1.4, 0.01, 'skirt inner lip, × footprint'],
    ['skirtBand', 0.02, 1.4, 0.01, 'skirt width, × footprint'],
    ['skirtBias', 0.2, 3, 0.01, 'skirt crowding'],
    ['coreSpread', 0.01, 0.6, 0.005, 'spire cluster, × footprint']
  ],
  Silhouette: [
    ['ringHeight', 0.2, 12, 0.05, 'wall height'],
    ['ringWave', 0, 1, 0.01, 'crest unevenness'],
    ['skirtHeight', 0.05, 6, 0.05, 'skirt height'],
    ['coreHeight', 0.2, 12, 0.05, 'spire height'],
    ['heightJitter', 0, 1.5, 0.01, 'height jitter'],
    ['ringLean', -1.5, 1.5, 0.01, 'wall lean (0 = a fence)'],
    ['skirtLean', -1.5, 1.5, 0.01, 'skirt lean'],
    ['coreLean', -1.5, 1.5, 0.01, 'spire lean'],
    ['leanJitter', 0, 3, 0.01, 'lean jitter'],
    ['fan', 0, 1.6, 0.01, 'splay off the radius'],
    ['twist', 0, 1, 0.01, 'random yaw'],
    ['rubble', 0, 1, 0.01, 'rubble fraction'],
    ['rubbleScale', 0.05, 1, 0.01, 'rubble height']
  ],
  'The crystal': [
    ['radius', 0.05, 1.2, 0.005, 'base radius'],
    ['radiusJitter', 0, 1.5, 0.01, 'radius jitter'],
    ['taper', 0.01, 0.9, 0.01, 'tip taper'],
    ['facets', 3, 12, 1, 'facets'],
    ['roughness', 0, 1, 0.01, 'facet roughness'],
    ['bend', 0, 1.5, 0.01, 'bend']
  ],
  'The bloom': [
    ['sweepTime', 0, 3, 0.01, 'sweep around the ring'],
    ['skirtDelay', 0, 2, 0.01, 'skirt delay'],
    ['skirtWave', 0, 2, 0.01, 'skirt wave'],
    ['coreDelay', 0, 2, 0.01, 'spire delay'],
    ['stagger', 0, 1, 0.005, 'random stagger'],
    ['bloomSpread', 0, 1, 0.01, 'late shards spread'],
    ['riseTime', 0.02, 1.5, 0.01, 'rise time'],
    ['riseOvershoot', 0, 1.5, 0.01, 'punch overshoot'],
    ['settle', 0.05, 2, 0.01, 'settle']
  ],
  'Prismatic glass': [
    ['opacity', 0, 1, 0.01, 'opacity'],
    ['body', 0, 2, 0.01, 'body (0 = pure edges)'],
    ['edgePower', 0.5, 8, 0.01, 'edge tightness'],
    ['edgeGain', 0, 6, 0.01, 'edge gain'],
    ['dispersion', 0, 1, 0.01, 'chromatic split'],
    ['pipe', 0, 5, 0.01, 'piped light'],
    ['tipBias', 0.2, 6, 0.01, 'crowding to the point'],
    ['bands', 0, 8, 0.05, 'travelling bands'],
    ['pulseSpeed', -4, 4, 0.01, 'band speed'],
    ['tipStart', 0, 1, 0.01, 'tip start'],
    ['tipGlow', 0, 6, 0.01, 'tip glow'],
    ['stria', 0, 3, 0.01, 'flow lines'],
    ['striaScale', 0.5, 24, 0.1, 'flow line scale'],
    ['envIntensity', 0, 3, 0.01, 'env reflection'],
    ['specular', 0, 8, 0.05, 'sun glint'],
    ['glow', 0, 4, 0.01, 'glow'],
    ['birthGlow', 0, 6, 0.01, 'birth flash'],
    ['birthFade', 0.02, 3, 0.01, 'birth fade'],
    ['colorGlass', 'body'],
    ['colorEdge', 'edge & glint'],
    ['colorPrismA', 'dispersion A'],
    ['colorPrismB', 'dispersion B'],
    ['colorCore', 'piped light'],
    ['colorTip', 'tip']
  ],
  'Freeze front & shatter': [
    ['frontRough', 0, 1.5, 0.01, 'front raggedness'],
    ['frontWidth', 0.01, 0.8, 0.01, 'front width'],
    ['frontGlow', 0, 8, 0.05, 'front glow'],
    ['shatterScale', 1, 24, 0.1, 'break-up cells'],
    ['shatterEdge', 0.005, 0.4, 0.005, 'break edge width'],
    ['shatterGlow', 0, 8, 0.05, 'break glow']
  ],
  'The sheet on the floor': [
    ['fieldBoundary', 0.02, 2, 0.01, 'band thickness'],
    ['fieldBoundaryGlow', 0, 8, 0.05, 'band glow'],
    ['fieldFill', 0, 2, 0.01, 'interior fill'],
    ['fieldFalloff', 0.1, 5, 0.05, 'fill falloff'],
    ['fieldPlates', 0, 3, 0.01, 'plate break-up'],
    ['fieldPlateScale', 0.2, 10, 0.05, 'plates / metre'],
    ['fieldSeam', 0, 3, 0.01, 'seam rime'],
    ['fieldFingers', 0, 3, 0.01, 'frost fingers'],
    ['fieldFingerScale', 0.1, 8, 0.05, 'fingers / metre'],
    ['fieldWarp', 0, 2, 0.01, 'domain warp'],
    ['fieldCrawl', -4, 4, 0.01, 'finger crawl'],
    ['fieldRings', 0, 12, 0.1, 'pressure rings'],
    ['fieldRingSpeed', -6, 6, 0.01, 'ring speed'],
    ['fieldSweep', 0, 3, 0.01, 'cold sweep'],
    ['fieldSweepSpeed', -2, 2, 0.01, 'sweep speed'],
    ['fieldCore', 0, 4, 0.01, 'centre pool'],
    ['fieldCoreSize', 0.02, 1, 0.005, 'pool size, × footprint'],
    ['fieldPulse', 0, 1, 0.01, 'pulse'],
    ['fieldPulseSpeed', 0, 10, 0.05, 'pulse speed'],
    ['fieldOpacity', 0, 2, 0.01, 'opacity'],
    ['fieldHeight', 0.005, 0.4, 0.005, 'hover height'],
    ['colorField', 'sheet'],
    ['colorFieldEdge', 'band & seams']
  ],
  'The curtain of cold': [
    ['veil', 0, 2, 0.01, 'opacity (0 hides it)'],
    ['veilHeight', 0.1, 8, 0.05, 'height'],
    ['veilRadius', 0.5, 1.6, 0.005, 'seat, × footprint'],
    ['veilFlare', -0.5, 1.5, 0.01, 'outward lean'],
    ['veilBillow', 0, 1.5, 0.01, 'silhouette lobes'],
    ['veilScale', 0.1, 6, 0.05, 'noise / metre'],
    ['veilStretch', 0.05, 3, 0.01, 'vertical stretch'],
    ['veilFlow', -4, 4, 0.01, 'fall speed'],
    ['veilErode', 0, 1, 0.01, 'erosion with height'],
    ['veilFalloff', 0.2, 6, 0.05, 'thinning with height'],
    ['veilSpin', -1, 1, 0.005, 'rotation'],
    ['veilSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorVeil', 'curtain'],
    ['colorVeilCrest', 'crest']
  ],
  Rime: [
    ['trailFrostRate', 0.05, 10, 0.05, 'trail rime / metre'],
    ['trailFrostRadius', 0.05, 6, 0.05, 'trail rime radius'],
    ['frostSpread', 0.2, 4, 0.05, 'impact rime, × footprint'],
    ['frostLife', 0.5, 20, 0.1, 'rime lifetime'],
    ['frostIntensity', 0, 2, 0.01, 'rime intensity'],
    ['frostCrystals', 0, 4, 0.01, 'snow grain'],
    ['frostCollar', 0, 8, 0.05, 'collar, × shard radius'],
    ['rimeRate', 0, 20, 0.1, 'rim rime / sec'],
    ['rimeRadius', 0.05, 6, 0.05, 'rim rime radius'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['ringRate', 0, 12, 0.1, 'pressure rings / sec'],
    ['colorFrost', 'snow'],
    ['colorFrostEdge', 'snow shadow'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest']
  ],
  'Mist, glitter & snow': [
    ['mistRate', 0, 900, 1, 'mist rate'],
    ['mistSize', 0.05, 4, 0.01, 'mist size'],
    ['mistSpeed', 0, 8, 0.05, 'mist speed'],
    ['mistLifetime', 0.2, 8, 0.05, 'mist lifetime'],
    ['mistOpacity', 0, 1, 0.005, 'mist opacity'],
    ['mistRise', -3, 3, 0.01, 'mist rise (− falls)'],
    ['mistTurbulence', 0, 3, 0.01, 'mist swirl'],
    ['glitterRate', 0, 900, 1, 'glitter rate'],
    ['glitterSize', 0.005, 0.4, 0.005, 'glitter size'],
    ['glitterSpeed', 0, 20, 0.1, 'glitter speed'],
    ['glitterLifetime', 0.1, 8, 0.05, 'glitter lifetime'],
    ['glitterRise', -3, 8, 0.01, 'glitter lift'],
    ['glitterTurbulence', 0, 3, 0.01, 'glitter swirl'],
    ['glitterGlow', 0, 4, 0.01, 'glitter glow'],
    ['snowRate', 0, 600, 1, 'snow rate'],
    ['snowSize', 0.005, 0.4, 0.005, 'snow size'],
    ['snowSpeed', 0, 10, 0.05, 'initial push'],
    ['snowLifetime', 0.2, 10, 0.05, 'snow lifetime'],
    ['snowFall', -12, 2, 0.05, 'snow gravity'],
    ['snowTurbulence', 0, 3, 0.01, 'snow drift'],
    ['snowGlow', 0, 4, 0.01, 'snow glow'],
    ['snowInset', 0.05, 1.4, 0.01, 'fall inset, × footprint'],
    ['snowHeight', 0.2, 4, 0.05, 'fall height, × wall'],
    ['colorMist*', 'Mist colour'],
    ['colorGlitter*', 'Glitter colour'],
    ['colorSnow*', 'Snow colour']
  ],
  'Ice chips': [
    ['shardSize', 0.005, 0.5, 0.005, 'chip size'],
    ['shardSpeed', 0, 30, 0.1, 'chip speed'],
    ['shardLifetime', 0.1, 6, 0.05, 'chip lifetime'],
    ['shardGravity', -50, 0, 0.1, 'chip gravity'],
    ['breachShards', 0, 30, 1, 'chips on breach'],
    ['shatterShards', 0, 30, 1, 'chips on break-up'],
    ['colorShard*', 'Chip colour']
  ],
  'Bloom & hold': [
    ['burstSize', 0.2, 14, 0.05, 'vapour shell size'],
    ['burstIntensity', 0, 5, 0.01, 'vapour shell intensity'],
    ['burstShards', 0, 600, 1, 'bloom chips'],
    ['burstMist', 0, 400, 1, 'bloom mist'],
    ['burstGlitter', 0, 600, 1, 'bloom glitter'],
    ['vapourRate', 0, 12, 0.05, 'hold shells / sec'],
    ['vapourSize', 0.1, 10, 0.05, 'hold shell size'],
    ['vapourIntensity', 0, 5, 0.01, 'hold shell intensity'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['holdShake', 0, 0.5, 0.005, 'hold rumble'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'shell'],
    ['colorBurstB', 'shell body'],
    ['colorBurstC', 'shell plates'],
    ['colorFlash', 'bloom flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightHeight', 0, 1, 0.01, 'height up the crown'],
    ['lightColor', 'light colour']
  ]
};
