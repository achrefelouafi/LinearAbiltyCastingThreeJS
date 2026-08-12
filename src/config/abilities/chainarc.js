/* ================================================================== */
/* CHAIN ARC — storm, line                                             */
/* ================================================================== */
/**
 * A discharge that **hops**. Everything else in the sandbox that crosses a
 * distance travels: a front moves at metres per second and the effect is drawn
 * behind it. This one picks five to nine points down the aimed line and is
 * simply *at* the first, and then *at* the second — the space between two nodes
 * was never crossed so much as skipped, and that discontinuity is the whole
 * read.
 *
 * Nothing below is a position. The graph is stored as unitless fractions
 * (`along`, `lateral`, `lift`) rolled once per cast; `scatter` and `lift` are
 * the metres those fractions are multiplied by, *in the vertex shader*, on the
 * frame they are read. That is why dragging `scatter` re-routes a chain already
 * in the air, and why `route` — a plain integer dial — re-rolls the whole graph
 * under a discharge mid-flight without restarting it. The roster asks Chain Arc
 * for exactly that trick and it is the one thing this block exists to make
 * possible.
 *
 * The hop clock is expressed in **metres per second**, not in seconds per hop.
 * The first version had a `hopTime` slider and it was wrong in a way that took a
 * while to name: dropping the node count from nine to five made every hop
 * longer but left the cadence identical, so a long chain and a short one took
 * the same time to arrive and the discharge stopped feeling like it was
 * propagating through anything. `speed` divided by the hop's own length fixes
 * it — a short hop is quick, a long one is not, and the total flight time
 * tracks the cast length the way it should.
 *
 * Three roles share one `FilamentPaths` strip: the chain itself (driven by
 * `ArcNetwork`), the earthing spike that stabs down from the node currently
 * lit, and the crawl that opens across the floor at the last node. Two draw
 * calls for all three — the strip is drawn once as a halo and once as a core,
 * and that is the entire mesh cost of the ability.
 */
export const chainarc = {
  /* --- the cast --- */
  range: 26.0, // maximum cast distance, metres
  minRange: 2.5, // closer than this and the cast is refused
  speed: 62.0, // metres/second the discharge propagates through the graph
  lifetime: 0.5, // seconds the chain holds lit after the last node
  fadeTime: 0.55, // seconds it takes to gutter out
  cooldown: 0.6, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the chain leaves the caster --- */
  // Node 0 is the hand, so these place the first node rather than an origin.
  handHeight: 1.3, // metres above the floor
  handForward: 0.5, // metres in front of the caster
  handSide: 0.14, // metres to the side (+ follows `Ability#side`)
  endHeight: 0.4, // height of the last node, metres

  /* --- the graph --- */
  nodes: 7, // points including both ends, 2..12
  route: 1.0, // re-roll dial: any change re-routes the chain mid-flight
  filaments: 3, // whole polylines drawn over the same nodes
  scatter: 2.1, // metres the lateral fractions are scaled by
  lift: 0.75, // metres the lift fractions are scaled by
  alongJitter: 0.55, // 0..1 of a hop a node may slide down the line
  hopSag: 0.14, // metres a hop bows downward at mid-hop
  hopBow: 0.35, // metres a hop bows sideways, alternating per hop
  floorY: 0.08, // metres — a hop's filaments are clamped above this

  /* --- the hop clock --- */
  hopStretch: 1.0, // unitless multiplier on the derived hop time
  hold: 1.3, // hops a lit segment stays at full
  overlap: 2.8, // hops it then decays over — this is the guttering tail
  tip: 0.35, // how much of a hop the front is smeared over

  /* --- the chain's share of the shared look --- */
  kink: 1.0, // multiplier on `jitter` for the chain role
  chainWidth: 1.0, // multiplier on `width` for the chain role
  dim: 1.0, // 0..1 alpha on the chain role
  groundDamp: 0.5, // 0..1 on the kink's world y — a chain skimming the floor wants < 1

  /* --- the ribbon, shared by all three roles --- */
  width: 0.03, // half-width of the core ribbon, metres
  glowWidth: 6.0, // halo half-width, × `width`
  glowOpacity: 0.5, // halo alpha relative to the core
  jitter: 0.5, // metres of lateral kink at the coarsest octave
  jitterScale: 1.5, // kinks per metre
  octaves: 4, // 1–5; each halves the amplitude and doubles the rate
  jitterFalloff: 0.55, // amplitude kept per octave
  crawl: 3.0, // how fast the kinks slide along, per second
  pinch: 0.12, // 0..1 of the path the kink is eased in over at each end
  restrike: 26, // whole re-shapes per second
  flicker: 0.28, // 0..1 depth of the whole-bundle brightness stutter
  flickerSpeed: 32, // steps/second that stutter is quantised to
  strandFlash: 0.5, // 0..1 depth of the per-filament blink
  coreSharp: 4.4, // exponent on the core's edge falloff — higher is thinner
  glowFalloff: 2.4, // the same for the halo
  softFade: 0.7, // metres of depth fade against the opaque scene
  opacity: 1.0,
  glow: 2.4, // emissive gain into bloom

  /* --- colour of the ribbon --- */
  colorCore: '#ffffff', // the white-hot centre line
  colorInner: '#eaf6ff',
  colorOuter: '#5fb0ff',
  colorHalo: '#0b2f7a', // the wide, dim atmosphere

  /* --- the earthing spikes --- */
  // One node at a time earths, and only if its dice roll passes `earthChance`.
  // The roll is fixed per cast; the *threshold* is read every frame, so winding
  // the slider up while paused makes the current node earth on the spot.
  earthChance: 0.55, // 0..1 — how many nodes stab down to the floor
  spikeStrands: 2, // filaments in one spike
  spikeLife: 0.22, // seconds a spike lingers after its node lit
  spikeFloor: 0.05, // metres the spike is clamped above the floor
  spikeSag: 0.05, // metres the spike bows at mid-span
  spikeNear: 0.03, // metres the spike is fanned at the node
  spikeSpread: 0.35, // ... and at the floor
  spikeCurve: 1.4, // how late that fan opens
  spikeTwist: 0.3, // turns of roll from node to floor
  spikeTwistSpeed: 1.2, // turns/second the fan rolls
  spikeConverge: 0.75, // 0..1 — how hard the far end is pinned to the floor point
  spikeKink: 0.7, // multiplier on `jitter` for the spike role
  spikeWidth: 0.8, // multiplier on `width` for the spike role
  spikeDim: 0.8, // 0..1 alpha on the spike role
  spikeGroundDamp: 0.35, // 0..1 on the kink's world y near the floor
  spikeTipGlow: 1.6, // extra core colour where it hits the floor

  /* --- the crawl that opens at the last node --- */
  crawlStrands: 7, // tendrils radiating across the floor
  crawlLife: 0.85, // seconds the crawl lingers
  crawlGrow: 0.28, // seconds it takes to reach full extension
  crawlInner: 0.25, // metres from the impact point a tendril starts
  crawlReach: 3.4, // metres it reaches
  crawlCurve: 0.85, // <1 sprints out early, >1 covers the ground late
  crawlWander: 1.5, // radians of per-tendril veer
  crawlArch: 0.25, // metres it lifts at mid-span
  crawlHug: 0.06, // metres it floats above the floor throughout
  crawlSpin: 0.15, // turns/second the whole crawl rotates
  crawlKink: 0.9, // multiplier on `jitter` for the crawl role
  crawlWidth: 0.9, // multiplier on `width` for the crawl role
  crawlDim: 0.9, // 0..1 alpha on the crawl role
  crawlGroundDamp: 0.3, // 0..1 on the kink's world y — flat filaments bury without this
  crawlFloor: 0.03, // metres the crawl is clamped above the floor
  crawlTip: 0.14, // 0..1 of the path the growing front is smeared over
  crawlTipGlow: 0.9, // extra core colour at that front

  /* --- what the ground does under each node --- */
  // A burn per node, deliberately *not* a continuous line: the bolt was never
  // between the nodes, so the floor should not claim it was.
  nodeArcRadius: 1.05, // radius of one electric burn, metres
  nodeArcLife: 0.55, // seconds a burn lingers
  nodeArcIntensity: 1.0,
  nodeArcBranches: 0.75, // how finely a burn splits into filaments
  nodeScorchRadius: 0.4, // dark mark under a node, metres
  nodeScorchLife: 5.5, // seconds
  nodeScorchIntensity: 0.4,
  colorArc: '#9fdcff', // the branching burn
  colorEmber: '#4aa8ff', // its hot centre
  colorScorch: '#080b11', // the dark mark
  shockRadius: 5.5, // impact shockwave ring, metres
  colorShockA: '#c9ecff', // body of the shockwave ring
  colorShockB: '#ffffff', // its crest

  /* --- the flash at each node --- */
  nodeBurstSize: 0.55, // shell of ionised air at a node, metres
  nodeBurstIntensity: 1.6,
  nodeSparks: 26, // sparks thrown at a node
  nodeLightPunch: 9.0, // additive light punch as a node lights
  colorNodeA: '#2f7fff', // node shell
  colorNodeB: '#c9ecff', // node body
  colorNodeC: '#ffffff', // node arcs

  /* --- sparks, motes, smoke and debris --- */
  /**
   * As in `thunder`: each system is coloured by a four-stop gradient sampled
   * over the particle's own lifetime, `A` at birth through `D` as it dies.
   * Spelled out rather than derived from the ribbon palette, so the sparks can
   * be cooled to orange while the chain stays blue.
   */
  sparkRate: 150, // sparks shed along the lit chain, particles/second
  sparkSize: 0.14,
  sparkSpeed: 8.5, // metres/second
  sparkLifetime: 0.45, // seconds
  sparkGravity: -13.0, // metres/second²
  sparkStretch: 0.2, // how far a spark smears along its velocity
  colorSparkA: '#ffffff',
  colorSparkB: '#eaf6ff',
  colorSparkC: '#5fb0ff',
  colorSparkD: '#1a4a8a',
  moteRate: 70, // ionised motes drifting off the chain, particles/second
  moteSize: 0.05,
  moteSpeed: 1.3, // metres/second
  moteLifetime: 1.4, // seconds
  moteRise: 0.9, // upward drift, metres/second
  moteTurbulence: 0.7,
  colorMoteA: '#ffffff',
  colorMoteB: '#c9ecff',
  colorMoteC: '#5fb0ff',
  colorMoteD: '#04205e',
  smokeRate: 26, // thin haze off the burnt floor, particles/second
  smokeSize: 0.9,
  smokeSpeed: 1.0, // metres/second
  smokeLifetime: 2.0, // seconds
  smokeOpacity: 0.06,
  smokeRise: 0.5, // metres/second
  colorSmokeA: '#3d546e',
  colorSmokeB: '#33475e',
  colorSmokeC: '#2a3b50',
  colorSmokeD: '#1c2938',
  debrisSize: 0.05,
  debrisSpeed: 4.5, // metres/second
  debrisLifetime: 1.2, // seconds
  debrisGravity: -17.0, // metres/second²
  nodeDebris: 5, // chips kicked off the floor at one node
  colorDebrisA: '#252c36',
  colorDebrisB: '#1c222a',
  colorDebrisC: '#1c222a',
  colorDebrisD: '#141920',

  /* --- dynamic light --- */
  lightIntensity: 24, // the light hops from node to node with the discharge
  lightRadius: 16, // metres
  lightColor: '#5fb0ff',
  lightFlicker: 0.45, // depth of the light's gutter, 0 = steady
  lightFlickerSpeed: 30, // steps/second

  /* --- the release and the last node --- */
  castFlash: 0.1, // screen flash as the chain leaves the hand
  colorCastFlash: '#eaf6ff',
  burstSize: 2.6, // the shell at the last node, metres
  burstIntensity: 1.5,
  burstSparks: 150, // extra sparks thrown at the last node
  burstDebris: 40,
  impactShake: 0.75,
  shakeDuration: 0.5, // seconds
  impactFlash: 0.26, // screen flash at the last node
  rumble: 0.025, // continuous shake while the chain is arriving
  colorBurstA: '#2f7fff', // burst shell
  colorBurstB: '#c9ecff', // burst body
  colorBurstC: '#ffffff', // burst arcs
  colorFlash: '#c9ecff' // the full-screen flash at the last node
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Chain Arc.
 *
 * Reach for **The graph** first. `nodes`, `scatter` and `route` are the three
 * that carry the ability: the first decides how many times it skips, the second
 * how far off the aimed line it is willing to go, and the third re-rolls the
 * whole route under a discharge that is already in the air. Drag `route` with
 * the clock stopped and watch a standing chain take a different path — that is
 * the trick, and it is one slider.
 *
 * **The hop clock** is next. `hold` at 8 lights the whole chain and leaves it
 * lit; at 0 with `overlap` low it is a single spark running the line. The
 * shipped values sit between the two, which is what makes the passed segments
 * linger dim and gutter rather than switching off.
 */
export const chainarcSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 300, 1, 'propagation speed'],
    ['lifetime', 0.05, 6, 0.01, 'chain lifetime'],
    ['fadeTime', 0.05, 4, 0.01, 'gutter-out time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where it leaves the hand': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['endHeight', 0, 4, 0.01, 'height at target']
  ],
  'The graph': [
    ['nodes', 2, 12, 1, 'nodes'],
    ['route', 0, 40, 1, 'route (re-roll)'],
    ['filaments', 1, 8, 1, 'filaments'],
    ['scatter', 0, 8, 0.01, 'lateral scatter (m)'],
    ['lift', 0, 5, 0.01, 'lift (m)'],
    ['alongJitter', 0, 1, 0.01, 'along jitter'],
    ['hopSag', -1, 1, 0.01, 'hop sag (m)'],
    ['hopBow', -2, 2, 0.01, 'hop bow (m)'],
    ['floorY', 0, 1, 0.005, 'floor clamp (m)']
  ],
  'The hop clock': [
    ['hopStretch', 0.05, 6, 0.01, 'hop stretch'],
    ['hold', 0, 10, 0.05, 'hold (hops)'],
    ['overlap', 0.05, 12, 0.05, 'gutter (hops)'],
    ['tip', 0.01, 1, 0.01, 'front smear']
  ],
  'The ribbon': [
    ['width', 0.005, 0.4, 0.001, 'core width (m)'],
    ['glowWidth', 1, 20, 0.1, 'halo width'],
    ['glowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['jitter', 0, 3, 0.01, 'kink amplitude (m)'],
    ['jitterScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['octaves', 1, 5, 1, 'octaves'],
    ['jitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['crawl', -20, 20, 0.1, 'kink crawl'],
    ['pinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['restrike', 0.5, 90, 0.5, 'restrikes / sec'],
    ['flicker', 0, 1, 0.01, 'brightness stutter'],
    ['flickerSpeed', 1, 120, 1, 'stutter rate'],
    ['strandFlash', 0, 1, 0.01, 'filament blink'],
    ['coreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['glowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['softFade', 0.02, 3, 0.01, 'soft intersection'],
    ['opacity', 0, 2, 0.01, 'opacity'],
    ['glow', 0, 8, 0.01, 'glow'],
    ['colorCore', 'core'],
    ['colorInner', 'inner'],
    ['colorOuter', 'outer'],
    ['colorHalo', 'halo']
  ],
  'The chain role': [
    ['kink', 0, 3, 0.01, 'kink ×'],
    ['chainWidth', 0.1, 4, 0.01, 'width ×'],
    ['dim', 0, 1, 0.01, 'alpha'],
    ['groundDamp', 0, 1, 0.01, 'ground damp']
  ],
  'The earthing spikes': [
    ['earthChance', 0, 1, 0.01, 'nodes that earth'],
    ['spikeStrands', 1, 8, 1, 'spike filaments'],
    ['spikeLife', 0.02, 2, 0.01, 'spike lifetime'],
    ['spikeFloor', 0, 1, 0.005, 'floor clamp (m)'],
    ['spikeSag', -1, 1, 0.01, 'spike sag (m)'],
    ['spikeNear', 0, 1, 0.005, 'fan at node (m)'],
    ['spikeSpread', 0, 3, 0.01, 'fan at floor (m)'],
    ['spikeCurve', 0.2, 5, 0.01, 'fan curve'],
    ['spikeTwist', -4, 4, 0.01, 'twist'],
    ['spikeTwistSpeed', -6, 6, 0.01, 'twist speed'],
    ['spikeConverge', 0, 1, 0.01, 'lock onto floor'],
    ['spikeKink', 0, 3, 0.01, 'kink ×'],
    ['spikeWidth', 0.1, 4, 0.01, 'width ×'],
    ['spikeDim', 0, 1, 0.01, 'alpha'],
    ['spikeGroundDamp', 0, 1, 0.01, 'ground damp'],
    ['spikeTipGlow', 0, 6, 0.05, 'floor-strike glow']
  ],
  'The crawl at the last node': [
    ['crawlStrands', 0, 16, 1, 'tendrils'],
    ['crawlLife', 0.05, 4, 0.01, 'crawl lifetime'],
    ['crawlGrow', 0.02, 2, 0.01, 'grow time'],
    ['crawlInner', 0, 3, 0.01, 'inner radius (m)'],
    ['crawlReach', 0.2, 14, 0.05, 'reach (m)'],
    ['crawlCurve', 0.2, 4, 0.01, 'reach curve'],
    ['crawlWander', 0, 4, 0.01, 'veer (rad)'],
    ['crawlArch', 0, 2, 0.01, 'mid-span lift (m)'],
    ['crawlHug', 0, 1, 0.005, 'float above floor (m)'],
    ['crawlSpin', -3, 3, 0.01, 'spin'],
    ['crawlKink', 0, 3, 0.01, 'kink ×'],
    ['crawlWidth', 0.1, 4, 0.01, 'width ×'],
    ['crawlDim', 0, 1, 0.01, 'alpha'],
    ['crawlGroundDamp', 0, 1, 0.01, 'ground damp'],
    ['crawlFloor', 0, 1, 0.005, 'floor clamp (m)'],
    ['crawlTip', 0.01, 1, 0.01, 'front smear'],
    ['crawlTipGlow', 0, 6, 0.05, 'front glow']
  ],
  'Burns under each node': [
    ['nodeArcRadius', 0.1, 8, 0.05, 'burn radius'],
    ['nodeArcLife', 0.05, 5, 0.05, 'burn lifetime'],
    ['nodeArcIntensity', 0, 3, 0.01, 'burn intensity'],
    ['nodeArcBranches', 0, 3, 0.01, 'branch detail'],
    ['nodeScorchRadius', 0.05, 4, 0.05, 'scorch radius'],
    ['nodeScorchLife', 0.5, 20, 0.1, 'scorch lifetime'],
    ['nodeScorchIntensity', 0, 2, 0.01, 'scorch intensity'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['colorArc', 'burn'],
    ['colorEmber', 'ember'],
    ['colorScorch', 'scorch'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest']
  ],
  'The flash at each node': [
    ['nodeBurstSize', 0.05, 6, 0.05, 'node shell size'],
    ['nodeBurstIntensity', 0, 5, 0.01, 'node shell intensity'],
    ['nodeSparks', 0, 200, 1, 'sparks per node'],
    ['nodeDebris', 0, 60, 1, 'chips per node'],
    ['nodeLightPunch', 0, 60, 0.5, 'light punch'],
    ['colorNodeA', 'node shell'],
    ['colorNodeB', 'node body'],
    ['colorNodeC', 'node arcs']
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
    ['debrisSize', 0.005, 0.4, 0.005, 'debris size'],
    ['debrisSpeed', 0, 25, 0.1, 'debris speed'],
    ['debrisLifetime', 0.1, 5, 0.05, 'debris lifetime'],
    ['debrisGravity', -50, 0, 0.1, 'debris gravity'],
    ['colorSmoke*', 'Smoke colour'],
    ['colorDebris*', 'Debris colour']
  ],
  'The last node': [
    ['castFlash', 0, 2, 0.01, 'flash on release'],
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
