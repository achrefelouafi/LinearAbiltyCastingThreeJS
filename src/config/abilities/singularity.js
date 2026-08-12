/* ================================================================== */
/* SINGULARITY — a gravity well over the aimed circle                  */
/* ================================================================== */
/**
 * The far cast that is mostly made of the **distortion pass**.
 *
 * `LAYER.DISTORTION` and its offset buffer shipped in the first build with
 * nothing writing to them. This block is largely the settings for the thing
 * that finally does: a `LENS` emitter whose magnitude goes as 1/r² inside a
 * falloff, so the floor, the character and every particle behind the well bend
 * around it. Everything else — the accretion streams, the horizon, the dust and
 * the hole in the floor — is dressing on that one idea.
 *
 * Three beats, and they map onto the phase machine like this:
 *
 * | phase | what it is | how long |
 * | --- | --- | --- |
 * | travel | a seed thrown downrange, the well already faintly bending light | `range / speed` |
 * | impact | **form** then the long **pull** | `formTime + pullTime` |
 * | fade | **INVERT** — the lens flips sign — then the throw-out | `invertTime + throwTime` |
 *
 * The four controls worth reaching for first are `lensStrength` and `lensCore`
 * (how hard and how tight the warp is), `orbitRate` (how fast the disc turns,
 * and therefore how hard the inside laps the outside) and `zoneRadius`, which
 * drives the lens falloff, the disc, the funnel and the dust ring at once —
 * one of the few places the sharing *is* the design, exactly as it is on the
 * snare.
 *
 * Nothing here is captured by a cast. A cast rolls one seed and remembers
 * whether the collapse has fired; every metre, radian and second below is
 * re-read on every frame, zero-length ones included.
 */
export const singularity = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 58.0, // how fast the seed travels to the circle, metres/second
  cooldown: 6.0,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 5.2, // the footprint — what the circle indicator measures out

  /* --- the beats --- */
  formTime: 0.5, // seconds the well takes to open once the seed lands
  pullTime: 2.4, // seconds it hauls everything inward
  invertTime: 0.18, // seconds the lens spends inverted — the flip
  throwTime: 1.25, // seconds the wreckage takes to disperse
  wellHeight: 1.85, // metres above the floor the well hangs
  launchHeight: 1.2, // metres — where the seed leaves the caster
  seedOpen: 0.26, // how open the well is while the seed is still travelling, 0..1

  /* ------------------------------------------------------------------ */
  /* The lens — the ability                                              */
  /* ------------------------------------------------------------------ */
  /**
   * Magnitudes are **screen fractions**, not metres: a fragment at strength 1
   * displaces the frame under it by a whole `post.distortion` of screen width
   * however far away the well is. The pass multiplies by `post.distortion ×
   * global.distortion` exactly once, so nothing here may include either.
   */
  lensRadius: 1.45, // the falloff edge, × zoneRadius
  lensSeed: 0.45, // that radius while the well is still forming, × itself
  lensStrength: 0.5, // screen widths at the falloff edge, at post.distortion = 1
  lensPull: 1.8, // extra strength by the end of the pull, × lensStrength
  lensBurst: 2.4, // extra strength during the flip, × lensStrength
  lensCurve: 1.7, // exponent on the opening ramp — >1 deepens late
  lensWindow: 0.3, // 0..1 of the radius at which the falloff starts
  lensCore: 0.15, // 0..1 of the radius — the 1/r² clamp at the centre
  lensMax: 3.0, // hard ceiling on the displacement
  lensSwirl: 0.45, // tangential fraction — frame dragging
  lensSwirlPull: 1.2, // extra swirl by the end of the pull, × lensSwirl
  lensFold: 0.0, // 0 never lets the sample cross the centre and flip the image
  lensInverted: false, // sample inward the whole time — the well magnifies
  lensFlips: true, // does the collapse flip the lens? this is the third beat
  /**
   * How hard opaque geometry *in front of* the emitter cuts the warp.
   *
   * Ships at 0 and that is deliberate: the lens is a billboard standing at the
   * well's own height, so the floor across its lower half is nearer the camera
   * than the emitter plane. At 1 the depth term throws all of it away and the
   * well bends the sky while the ground stays flat — which is the exact
   * symptom that reads as "the distortion pass is not reaching me". Raise it
   * only if a well behind a pillar is warping the pillar.
   */
  lensDepthReject: 0.0,
  lensDepthFade: 0.6, // metres over which that rejection feathers
  lensPerspective: 0.0, // 0 keeps the warp a screen fraction, 1 shrinks it with distance
  lensPerspectiveRef: 14.0, // metres at which perspective = 1
  lensOpacity: 1.0, // coverage of the emitter against anything overlapping it

  /* ------------------------------------------------------------------ */
  /* The infall — instanced ribbons on a conserved-momentum orbit        */
  /* ------------------------------------------------------------------ */
  /**
   * `r² · dθ/dt` is held constant, `r` closes linearly on the horizon over
   * `fallTime`, and θ comes out in closed form — so the inside of the disc
   * genuinely laps the outside and the tail, which is a fixed window of *time*,
   * stretches all by itself as a stream speeds up.
   */
  streams: 96, // live filaments (capped at 160)
  fallTime: 2.6, // seconds one stream takes to reach the horizon
  fallSpeedUp: 0.45, // how much shorter that fall gets by the end of the pull, 0..1
  discOuter: 0.92, // the widest orbit, × zoneRadius
  discInner: 0.3, // the tightest starting orbit, × zoneRadius
  discSeed: 0.5, // the disc's radius while the well is forming, × itself
  discDraw: 0.35, // how far the pull hauls the whole disc in, 0..1
  discSwallow: 1.0, // where a stream is swallowed, × horizonRadius
  orbitRate: 1.0, // radians/second at the widest orbit
  orbitPull: 1.4, // extra rate by the end of the pull, × orbitRate
  inclination: 0.42, // radians the orbits tilt out of the disc plane
  flatten: 0.5, // 0 a flat disc, 1 a sphere of orbits
  trailTime: 0.55, // seconds of history in a stream's tail
  ejectDistance: 11.0, // metres the disc is thrown outward by on the collapse
  streamWobble: 0.09, // metres of lateral slop on a stream
  streamWobbleTurns: 3.0, // wobbles per turn of the orbit
  streamWidth: 0.075, // half-width of a stream at its head, metres
  streamWidthTail: 0.16, // that width at the tail, as a fraction
  streamWidthCurve: 1.5, // how early the taper happens
  streamWidthNear: 1.9, // extra width at the horizon, × streamWidth
  streamEnter: 0.12, // fraction of the fall spent fading in
  streamExit: 0.07, // ... and fading out
  streamCoreSharp: 2.6, // how hard the hot core falls off across the ribbon
  streamHeat: 0.7, // 0 colours by tail-to-head, 1 by how far down the well it is
  streamGlow: 2.2, // emissive gain
  streamOpacity: 1.0,
  streamSoftFade: 0.4, // metres of soft fade where a stream meets geometry
  colorStreamTail: '#3a1f7a', // the cold outer end of a stream
  colorStreamHead: '#b58cff', // its hot nose
  colorStreamCore: '#ffffff', // the centre of the ribbon
  colorStreamHalo: '#160a2e', // the wide soft edge

  /* ------------------------------------------------------------------ */
  /* The event horizon                                                   */
  /* ------------------------------------------------------------------ */
  /**
   * The only object in the project that is *darker* than what it covers. It
   * alpha-blends rather than adding, because additive blending cannot make
   * anything darker and an additive hole is a gap you can see straight through.
   */
  horizonRadius: 0.62, // metres
  horizonSeed: 0.2, // that radius while the well is forming, × itself
  horizonBurst: 1.6, // how far it is torn open by the collapse, × itself
  horizonEdge: 0.05, // metres of feather on the silhouette
  horizonRing: 1.18, // the photon ring, × horizonRadius
  horizonRingWidth: 0.05, // metres
  horizonRingGlow: 3.6,
  horizonDoppler: 0.55, // brightness asymmetry across the turning disc, 0..1
  horizonHalo: 0.45, // metres the outer bloom reaches past the ring
  horizonHaloGlow: 1.5,
  horizonRim: 0.45, // sheen on the inside of the ring
  horizonShimmer: 0.12, // 0..1 wobble on the ring's radius
  horizonShimmerRate: 0.7, // cycles/second
  horizonOpacity: 1.0,
  horizonSoftFade: 0.3, // metres of soft fade against standing geometry
  colorVoid: '#0a0612', // the interior
  colorRim: '#6a3fd0', // the sheen just inside the ring
  colorRing: '#ffffff', // the photon ring
  colorHorizonHalo: '#8a5cf0', // the bloom around it

  /* ------------------------------------------------------------------ */
  /* The floor being drawn in — GroundField(FUNNEL)                      */
  /* ------------------------------------------------------------------ */
  funnelRadius: 1.05, // the pit, × zoneRadius
  funnelSeed: 0.3, // that radius while the well is forming, × itself
  funnelDepth: 1.3, // metres the cone reads as deep
  funnelDeepen: 1.6, // how much deeper it reads by the end of the pull, × itself
  funnelLift: 0.1, // metres of spoil slumped over the rim
  funnelThickness: 0.09, // metres the lip blocks tilt in by
  funnelCell: 0.7, // metres — pitch of those blocks
  funnelCellJitter: 0.85, // 0..1
  funnelSeam: 0.05, // metres of gap between them
  funnelSharp: 0.62, // 0 a bowl, 1 a shaft
  funnelDetail: 0.7, // scree grain on the walls, 0..1
  funnelEdge: 0.4, // metres of feather on the growth front
  funnelRagged: 0.22, // how far that front wanders, × the radius
  funnelRaggedScale: 0.6, // lobes per metre
  funnelWarp: 0.5, // metres of domain warp on them
  funnelRelief: 0.85, // how hard the height field tilts the fake normal
  funnelParallax: 0.5, // metres of view-driven offset on the wall detail
  funnelEmissive: 1.0,
  funnelOpacity: 0.95,
  funnelDepthFade: 0.5, // metres of soft fade against standing geometry
  funnelHeight: 0.02, // metres the quad hovers above the floor
  colorFunnelBase: '#241a33', // the ground around the pit
  colorFunnelEdge: '#7a5ec0', // the calved lip
  colorFunnelGlow: '#b07aff', // the light coming up out of the throat
  colorFunnelDeep: '#05030a', // the interior

  /* ------------------------------------------------------------------ */
  /* The dust — Swarm(MOTE)                                              */
  /* ------------------------------------------------------------------ */
  /**
   * `churn` is the rate the formation rolls at and is deliberately *not* ramped
   * by the pull: the swarm shader multiplies it by the shared clock, so raising
   * it mid-cast slews the whole cloud by seconds × Δω. The angular acceleration
   * in this ability lives in the infall streams, where θ is closed form.
   */
  moteCount: 216, // live agents (capped at 288)
  moteLatticeX: 12, // cells across
  moteLatticeY: 6, // cells up
  moteLatticeZ: 4, // ranks — with a POINT lead these separate by jitter alone
  moteSpacing: 0.62, // metres between lateral cells
  moteSpacingUp: 0.46, // metres between vertical cells
  moteCollapse: 0.16, // that spacing at the end of the pull, × itself
  moteEject: 4.5, // how far the collapse throws the cloud, × the spacing
  moteLag: 0.35, // seconds the back rank trails by
  moteJitter: 0.24, // metres of slop off a cell
  moteChurn: 0.8, // radians/second the formation rolls
  moteBreathe: 0.14, // fraction it swells by
  moteBreatheRate: 1.3, // radians/second
  moteWander: 0.16, // metres of curl drift — keep under half the spacing
  moteWanderScale: 0.55, // features per metre
  moteWanderSpeed: 0.6,
  moteGather: 1.0, // 0 collapses every mote onto the well exactly
  moteSize: 0.12, // metres
  moteAspect: 1.0, // span / length — 1 keeps a mote round
  moteSizeJitter: 0.55, // ±fraction
  moteEdgeStretch: 1.2, // how much an edge-on mote grows, ≥1
  moteRevealSpread: 0.5, // width of the appearance wave, 0..1
  moteTint: 0.35, // where in the gradient the cloud sits
  moteTintJitter: 0.4, // ±per-agent walk along it
  moteTintAlong: 0.25, // extra walk across a mote
  moteGlow: 1.6,
  moteOpacity: 0.85,
  moteSoftFade: 0.3, // metres of depth feather
  colorMoteA: '#e8dcff',
  colorMoteB: '#b58cff',
  colorMoteC: '#6a3fd0',
  colorMoteD: '#160a2e',

  /* ------------------------------------------------------------------ */
  /* Dust, chips and what comes back out                                 */
  /* ------------------------------------------------------------------ */
  /**
   * As on `ice` and `thunder`, each system is coloured by a four-stop gradient
   * sampled over the particle's own lifetime, `A` at birth through `D` as it
   * dies, spelled out rather than derived from the well's palette.
   *
   * The dust is the one system in the project that uses the particle shader's
   * SWIRL path, and `dustContract` is why: it is `uSwirlExpand`, and a
   * *negative* value closes the particle's offset onto its anchor over its
   * life. That is an orbit decaying, with no simulation anywhere.
   */
  dustRate: 170, // motes drawn off the floor, particles/second
  dustRing: 0.55, // inner edge of the ring they seed on, × the disc radius
  dustSpread: 0.55, // metres of vertical scatter at birth
  dustSize: 0.07,
  dustLifetime: 1.9, // seconds
  dustRise: 0.35, // vertical drift, metres/second
  dustSwirl: 2.2, // radians/second about the well
  dustSwirlPull: 1.5, // extra rate by the end of the pull, × dustSwirl
  dustContract: -0.82, // fraction the orbit closes by over a life; negative = inward
  dustTurbulence: 0.5,
  dustOpacity: 0.9,
  dustGlow: 1.4,
  colorDustA: '#ffffff',
  colorDustB: '#c9a8ff',
  colorDustC: '#6a3fd0',
  colorDustD: '#0a0612',
  shardRate: 16, // chips torn off the floor, particles/second
  shardSpread: 0.35, // metres of scatter at birth
  shardSize: 0.07,
  shardSpeed: 4.2, // metres/second, thrown at the well
  shardLifetime: 1.5,
  shardGravity: -5.5, // metres/second² — light, because the well is holding them up
  colorShardA: '#2a2233',
  colorShardB: '#1c1626',
  colorShardC: '#120e1a',
  colorShardD: '#0a0810',
  sparkSize: 0.15,
  sparkSpeed: 15.0, // metres/second the collapse spits them out at
  sparkLifetime: 0.8,
  sparkGravity: -9.0,
  sparkStretch: 0.22, // how far a spark smears along its velocity
  sparkGlow: 2.4,
  colorSparkA: '#ffffff',
  colorSparkB: '#e0ccff',
  colorSparkC: '#8a5cf0',
  colorSparkD: '#2a1060',

  /* ------------------------------------------------------------------ */
  /* Emission balance and the shake                                      */
  /* ------------------------------------------------------------------ */
  travelEmission: 0.35, // × the rates while the seed is still in the air
  holdEmission: 1.6, // × the rates by the end of the pull
  rumble: 0.035, // continuous shake while the well is standing
  rumblePull: 1.8, // extra rumble by the end of the pull, × rumble
  shakeDuration: 0.55, // seconds a one-shot shake decays over

  /* ------------------------------------------------------------------ */
  /* The three one-shots                                                 */
  /* ------------------------------------------------------------------ */
  castBurstSize: 0.7, // the shell at the caster's hand, metres
  castBurstIntensity: 1.4,
  castFlash: 0.06, // screen flash on release
  colorCastA: '#6a3fd0',
  colorCastB: '#b58cff',
  colorCastC: '#ffffff',
  colorCastFlash: '#3a1f7a',
  formBurstSize: 3.4, // the shell that collapses inward as the well seats, metres
  formBurstIntensity: 1.5,
  formRingRadius: 6.5, // the ring that snaps across the floor, metres
  formRingIntensity: 1.1,
  formFlash: 0.14,
  formShake: 0.4,
  colorFormA: '#0a0612',
  colorFormB: '#6a3fd0',
  colorFormC: '#c9a8ff',
  colorFormFlash: '#6a3fd0',
  collapseSize: 6.5, // the shell thrown out by the inversion, metres
  collapseIntensity: 2.3,
  collapseSparks: 260, // sparks spat back out
  collapseShards: 130, // chips spat back out
  collapseThrow: 3.2, // × shardSpeed on the way out
  collapseRingRadius: 12.0, // metres
  collapseRingIntensity: 1.4,
  collapseFlash: 0.42,
  collapseShake: 1.4,
  colorCollapseA: '#3a1f7a',
  colorCollapseB: '#b58cff',
  colorCollapseC: '#ffffff',
  colorCollapseFlash: '#c9a8ff',
  colorRingA: '#b58cff', // body of both shockwave rings
  colorRingB: '#ffffff', // their crest
  crackRadius: 5.0, // the fractures left in the floor, metres
  crackLife: 5.5, // seconds
  crackBranches: 0.7, // how finely they split
  crackIntensity: 0.8,
  colorCrackA: '#1a1026',
  colorCrackB: '#8a5cf0',

  /* --- dynamic light --- */
  lightIntensity: 16,
  lightRadius: 15,
  lightColor: '#7a45e0',
  lightBreathe: 0.32, // depth of the well's slow pulse, 0 = steady
  lightBreatheRate: 3.4 // radians/second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Singularity.
 *
 * The first folder is the one that matters. Everything in **The lens** is a
 * screen-space measurement rather than a metre, and the three that carry the
 * whole effect are `lensStrength`, `lensCore` and `lensRadius` — drag the
 * middle one down toward 0.05 with the clock paused and watch the centre of the
 * frame turn into a mirror.
 */
export const singularitySchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'seed speed'],
    ['cooldown', 0, 20, 0.05, 'cooldown'],
    ['zoneRadius', 0.5, 14, 0.05, 'footprint radius'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['formTime', 0.05, 3, 0.01, 'form time'],
    ['pullTime', 0.2, 10, 0.05, 'pull time'],
    ['invertTime', 0.02, 1.5, 0.01, 'inversion time'],
    ['throwTime', 0.1, 5, 0.05, 'throw-out time'],
    ['wellHeight', 0, 8, 0.05, 'well height'],
    ['launchHeight', 0, 3, 0.01, 'seed height'],
    ['seedOpen', 0, 1, 0.01, 'seed openness']
  ],
  'The lens': [
    ['lensRadius', 0.2, 4, 0.01, 'falloff radius'],
    ['lensSeed', 0, 1, 0.01, 'radius while forming'],
    ['lensStrength', 0, 3, 0.005, 'strength'],
    ['lensPull', 0, 6, 0.01, 'strength on the pull'],
    ['lensBurst', 0, 8, 0.01, 'strength on the flip'],
    ['lensCurve', 0.1, 5, 0.01, 'opening curve'],
    ['lensWindow', 0, 1, 0.01, 'falloff start'],
    ['lensCore', 0.02, 1, 0.005, 'centre clamp'],
    ['lensMax', 0.1, 8, 0.05, 'displacement ceiling'],
    ['lensSwirl', -2, 2, 0.01, 'frame dragging'],
    ['lensSwirlPull', 0, 6, 0.01, 'dragging on the pull'],
    ['lensFold', 0, 1, 0.01, 'allow image flip'],
    ['lensInverted', 'sample inward'],
    ['lensFlips', 'flip on collapse'],
    ['lensDepthReject', 0, 1, 0.01, 'depth rejection'],
    ['lensDepthFade', 0.02, 3, 0.01, 'depth feather'],
    ['lensPerspective', 0, 1, 0.01, 'shrink with distance'],
    ['lensPerspectiveRef', 1, 40, 0.1, 'perspective reference'],
    ['lensOpacity', 0, 1, 0.01, 'coverage']
  ],
  'The infall': [
    ['streams', 1, 160, 1, 'streams'],
    ['fallTime', 0.2, 10, 0.05, 'fall time'],
    ['fallSpeedUp', 0, 0.95, 0.01, 'fall speed-up'],
    ['discOuter', 0.05, 2, 0.01, 'widest orbit'],
    ['discInner', 0.01, 2, 0.01, 'tightest orbit'],
    ['discSeed', 0, 1, 0.01, 'disc while forming'],
    ['discDraw', 0, 0.9, 0.01, 'haul-in on the pull'],
    ['discSwallow', 0.1, 4, 0.01, 'swallow radius'],
    ['orbitRate', 0, 8, 0.01, 'orbit rate'],
    ['orbitPull', 0, 8, 0.01, 'rate on the pull'],
    ['inclination', 0, 1.6, 0.01, 'orbit tilt'],
    ['flatten', 0, 2, 0.01, 'disc / sphere'],
    ['trailTime', 0.02, 3, 0.01, 'tail length, seconds'],
    ['ejectDistance', 0, 40, 0.1, 'throw-out distance']
  ],
  'The infall/Ribbon': [
    ['streamWidth', 0.005, 0.6, 0.005, 'width at the head'],
    ['streamWidthTail', 0.01, 2, 0.01, 'width at the tail'],
    ['streamWidthCurve', 0.1, 5, 0.01, 'taper curve'],
    ['streamWidthNear', 0.1, 6, 0.01, 'width at the horizon'],
    ['streamWobble', 0, 1, 0.005, 'wobble'],
    ['streamWobbleTurns', 0, 12, 0.1, 'wobbles / turn'],
    ['streamEnter', 0.01, 0.5, 0.005, 'fade in'],
    ['streamExit', 0.01, 0.5, 0.005, 'fade out'],
    ['streamCoreSharp', 0.5, 10, 0.05, 'core sharpness'],
    ['streamHeat', 0, 1, 0.01, 'colour by depth'],
    ['streamGlow', 0, 8, 0.01, 'glow'],
    ['streamOpacity', 0, 2, 0.01, 'opacity'],
    ['streamSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorStreamTail', 'stream tail'],
    ['colorStreamHead', 'stream head'],
    ['colorStreamCore', 'ribbon core'],
    ['colorStreamHalo', 'ribbon halo']
  ],
  'The event horizon': [
    ['horizonRadius', 0.05, 4, 0.01, 'horizon radius'],
    ['horizonSeed', 0, 1, 0.01, 'radius while forming'],
    ['horizonBurst', 0, 6, 0.01, 'tear on collapse'],
    ['horizonEdge', 0.005, 0.5, 0.005, 'silhouette feather'],
    ['horizonRing', 1, 2.5, 0.01, 'photon ring radius'],
    ['horizonRingWidth', 0.005, 0.5, 0.005, 'ring width'],
    ['horizonRingGlow', 0, 12, 0.05, 'ring glow'],
    ['horizonDoppler', 0, 1, 0.01, 'beaming asymmetry'],
    ['horizonHalo', 0.02, 3, 0.01, 'halo reach'],
    ['horizonHaloGlow', 0, 6, 0.05, 'halo glow'],
    ['horizonRim', 0, 3, 0.01, 'inner sheen'],
    ['horizonShimmer', 0, 1, 0.01, 'ring shimmer'],
    ['horizonShimmerRate', 0, 6, 0.05, 'shimmer rate'],
    ['horizonOpacity', 0, 1, 0.01, 'opacity'],
    ['horizonSoftFade', 0.02, 2, 0.01, 'soft intersection'],
    ['colorVoid', 'interior'],
    ['colorRim', 'inner sheen'],
    ['colorRing', 'photon ring'],
    ['colorHorizonHalo', 'halo']
  ],
  'The hole in the floor': [
    ['funnelRadius', 0.1, 3, 0.01, 'pit radius'],
    ['funnelSeed', 0, 1, 0.01, 'radius while forming'],
    ['funnelDepth', 0, 5, 0.01, 'depth'],
    ['funnelDeepen', 0.5, 4, 0.01, 'deepening on the pull'],
    ['funnelLift', 0, 1, 0.005, 'spoil over the rim'],
    ['funnelThickness', 0, 0.5, 0.005, 'lip tilt'],
    ['funnelCell', 0.05, 3, 0.01, 'lip block pitch'],
    ['funnelCellJitter', 0, 1, 0.01, 'block jitter'],
    ['funnelSeam', 0, 0.3, 0.005, 'block gap'],
    ['funnelSharp', 0, 1, 0.01, 'bowl / shaft'],
    ['funnelDetail', 0, 1, 0.01, 'wall grain'],
    ['funnelEdge', 0.02, 2, 0.01, 'front feather'],
    ['funnelRagged', 0, 1, 0.01, 'front raggedness'],
    ['funnelRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['funnelWarp', 0, 3, 0.01, 'domain warp'],
    ['funnelRelief', 0, 3, 0.01, 'relief'],
    ['funnelParallax', 0, 2, 0.01, 'parallax'],
    ['funnelEmissive', 0, 4, 0.01, 'emissive'],
    ['funnelOpacity', 0, 1, 0.01, 'opacity'],
    ['funnelDepthFade', 0.02, 3, 0.01, 'soft intersection'],
    ['funnelHeight', 0, 0.2, 0.001, 'hover height'],
    ['colorFunnelBase', 'ground'],
    ['colorFunnelEdge', 'calved lip'],
    ['colorFunnelGlow', 'throat glow'],
    ['colorFunnelDeep', 'interior']
  ],
  'The dust cloud': [
    ['moteCount', 0, 288, 1, 'motes'],
    ['moteLatticeX', 1, 24, 1, 'cells across'],
    ['moteLatticeY', 1, 16, 1, 'cells up'],
    ['moteLatticeZ', 1, 16, 1, 'ranks'],
    ['moteSpacing', 0.02, 3, 0.01, 'lateral spacing'],
    ['moteSpacingUp', 0.02, 3, 0.01, 'vertical spacing'],
    ['moteCollapse', 0.01, 1, 0.01, 'spacing at full pull'],
    ['moteEject', 0, 12, 0.05, 'throw-out'],
    ['moteLag', 0, 2, 0.01, 'rank lag'],
    ['moteJitter', 0, 1.5, 0.01, 'cell jitter'],
    ['moteChurn', -4, 4, 0.01, 'formation roll'],
    ['moteBreathe', 0, 1, 0.01, 'breathe'],
    ['moteBreatheRate', 0, 6, 0.05, 'breathe rate'],
    ['moteWander', 0, 1, 0.01, 'wander'],
    ['moteWanderScale', 0.05, 3, 0.01, 'wander scale'],
    ['moteWanderSpeed', 0, 4, 0.05, 'wander speed'],
    ['moteGather', 0, 1, 0.01, 'gather onto the well'],
    ['moteSize', 0.01, 1, 0.005, 'mote size'],
    ['moteAspect', 0.2, 4, 0.01, 'mote aspect'],
    ['moteSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['moteEdgeStretch', 1, 4, 0.01, 'edge-on stretch'],
    ['moteRevealSpread', 0.01, 1, 0.01, 'appearance wave'],
    ['moteTint', 0, 1, 0.01, 'tint'],
    ['moteTintJitter', 0, 1, 0.01, 'tint jitter'],
    ['moteTintAlong', 0, 1, 0.01, 'tint across'],
    ['moteGlow', 0, 6, 0.01, 'glow'],
    ['moteOpacity', 0, 2, 0.01, 'opacity'],
    ['moteSoftFade', 0.02, 2, 0.01, 'soft intersection'],
    ['colorMote*', 'Mote colour']
  ],
  'Dust & debris': [
    ['dustRate', 0, 900, 1, 'dust rate'],
    ['dustRing', 0, 1.5, 0.01, 'ring inner edge'],
    ['dustSpread', 0, 3, 0.01, 'birth scatter'],
    ['dustSize', 0.005, 0.5, 0.005, 'dust size'],
    ['dustLifetime', 0.1, 8, 0.05, 'dust lifetime'],
    ['dustRise', -3, 4, 0.05, 'dust rise'],
    ['dustSwirl', -12, 12, 0.05, 'orbit rate'],
    ['dustSwirlPull', 0, 6, 0.01, 'orbit rate on the pull'],
    ['dustContract', -1, 1, 0.01, 'orbit contraction'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['dustOpacity', 0, 2, 0.01, 'dust opacity'],
    ['dustGlow', 0, 6, 0.01, 'dust glow'],
    ['shardRate', 0, 200, 1, 'chip rate'],
    ['shardSpread', 0, 2, 0.01, 'chip scatter'],
    ['shardSize', 0.005, 0.4, 0.005, 'chip size'],
    ['shardSpeed', 0, 30, 0.1, 'chip speed'],
    ['shardLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['shardGravity', -40, 10, 0.1, 'chip gravity'],
    ['colorDust*', 'Dust colour'],
    ['colorShard*', 'Chip colour']
  ],
  'The collapse': [
    ['collapseSize', 0.2, 20, 0.05, 'burst size'],
    ['collapseIntensity', 0, 6, 0.01, 'burst intensity'],
    ['collapseSparks', 0, 800, 1, 'sparks'],
    ['collapseShards', 0, 500, 1, 'chips'],
    ['collapseThrow', 0.5, 10, 0.05, 'chip speed × '],
    ['collapseRingRadius', 0.5, 30, 0.1, 'ring radius'],
    ['collapseRingIntensity', 0, 4, 0.01, 'ring intensity'],
    ['collapseFlash', 0, 2, 0.01, 'screen flash'],
    ['collapseShake', 0, 4, 0.01, 'shake'],
    ['crackRadius', 0.2, 16, 0.05, 'fracture radius'],
    ['crackLife', 0.2, 20, 0.1, 'fracture lifetime'],
    ['crackBranches', 0, 3, 0.01, 'fracture detail'],
    ['crackIntensity', 0, 3, 0.01, 'fracture intensity'],
    ['sparkSize', 0.005, 0.8, 0.005, 'spark size'],
    ['sparkSpeed', 0, 60, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 4, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['sparkGlow', 0, 8, 0.01, 'spark glow'],
    ['colorCollapseA', 'collapse shell'],
    ['colorCollapseB', 'collapse body'],
    ['colorCollapseC', 'collapse arcs'],
    ['colorCollapseFlash', 'collapse flash'],
    ['colorRingA', 'shockwave ring'],
    ['colorRingB', 'shockwave crest'],
    ['colorCrackA', 'fracture'],
    ['colorCrackB', 'fracture glow'],
    ['colorSpark*', 'Spark colour']
  ],
  'Cast & form': [
    ['castBurstSize', 0.05, 5, 0.05, 'cast shell size'],
    ['castBurstIntensity', 0, 5, 0.01, 'cast shell intensity'],
    ['castFlash', 0, 2, 0.01, 'cast flash'],
    ['colorCastA', 'cast shell'],
    ['colorCastB', 'cast body'],
    ['colorCastC', 'cast arcs'],
    ['colorCastFlash', 'cast flash colour'],
    ['formBurstSize', 0.2, 14, 0.05, 'form shell size'],
    ['formBurstIntensity', 0, 5, 0.01, 'form shell intensity'],
    ['formRingRadius', 0.5, 25, 0.1, 'form ring radius'],
    ['formRingIntensity', 0, 4, 0.01, 'form ring intensity'],
    ['formFlash', 0, 2, 0.01, 'form flash'],
    ['formShake', 0, 3, 0.01, 'form shake'],
    ['colorFormA', 'form shell'],
    ['colorFormB', 'form body'],
    ['colorFormC', 'form arcs'],
    ['colorFormFlash', 'form flash colour'],
    ['travelEmission', 0, 2, 0.01, 'emission while travelling'],
    ['holdEmission', 0, 4, 0.01, 'emission at full pull'],
    ['rumble', 0, 0.5, 0.005, 'rumble'],
    ['rumblePull', 0, 6, 0.01, 'rumble on the pull'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightBreathe', 0, 1, 0.01, 'light pulse'],
    ['lightBreatheRate', 0, 20, 0.05, 'pulse rate'],
    ['lightColor', 'light colour']
  ]
};
