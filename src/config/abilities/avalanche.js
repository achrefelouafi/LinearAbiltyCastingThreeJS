/* ================================================================== */
/* AVALANCHE — granular flow                                           */
/* ================================================================== */
/**
 * Snow that piles, slumps and finds its angle of repose.
 *
 * The rest of the frost school throws solids — the Lance's crystals, the
 * Crown's blades, Rimewalker's sheets. This slot throws *material*, and the
 * only reason it reads as material rather than as a moving wave is that the
 * surface obeys a repose angle. Four numbers are the ability and the rest is
 * dressing:
 *
 *  - **`repose`** — radians. The slope the heap refuses to exceed. Dry snow
 *    sits between 30° and 38° (0.52–0.66 rad); wet snow holds steeper and sand
 *    a little shallower. Pull it down on a *paused* cast and the whole
 *    avalanche flattens and spreads outward, because every lobe holds its
 *    volume while its slope relaxes. That is the one control worth reaching
 *    for first, and it is the reason this slot exists.
 *  - **`excess`** — radians of over-steepening at release. A lobe is born
 *    steeper than repose and is therefore *unstable*, which is what gives the
 *    front its slip faces. At 0 the heap is a tidy pile and nothing collapses.
 *  - **`slump`** — 1/s, the rate that excess decays at. It is the collapse
 *    speed. Low and the front is a slow, shouldering wall; high and each lobe
 *    splats the instant it lands.
 *  - **`creep`** — m/s the centroid of a collapsing lobe crawls downhill, which
 *    is the "keeps falling forward over itself" in one term. At 0 the lobes
 *    stack in place and the avalanche is a growing wall rather than a flow.
 *
 * `runout` is the second idea. An avalanche does not stop because it reached a
 * line on the floor; it *decelerates* and the surface freezes where it lies. So
 * the heap has its own clock, and after the cast front lands that clock is
 * throttled to zero over `runout` seconds on the `runoutCurve` exponent — which
 * slows the release of new lobes and the collapse of the standing ones by the
 * same factor, because both are functions of the same clock. The deposit stops
 * moving; it does not fade out mid-slump.
 *
 * Everything with a unit below is resolved against this block inside the update
 * loop on every frame, zero-length frames included. A cast captures one seed
 * and two timestamps.
 */
export const avalanche = {
  /* --- the cast --- */
  range: 19.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 11.0, // how fast the front runs the line, metres/second
  cooldown: 1.4, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws
  lifetime: 1.5, // seconds the deposit stands once the front has landed
  settleTime: 1.9, // seconds the deposit takes to sink and thin away

  /* --- the runout: how the flow stops --- */
  runout: 1.15, // seconds the heap's clock takes to throttle to a standstill
  runoutCurve: 2.0, // >1 lets it coast and then stop; 1 is a linear brake
  heapLead: 1.05, // heap front speed as a multiple of the cast speed, unitless

  /* --- the heap: the lobe train (see the header) --- */
  heapWidth: 3.6, // metres either side of the line the sheet covers
  heapFloor: 0.006, // metres the heap sits above the stone, to beat z-fighting
  heapHeight: 1.05, // multiplier on the whole envelope
  lobes: 16, // lobes alive at once — this is the fragment cost
  lobeRate: 6.0, // lobes released per second
  lobeVolume: 1.7, // cubic metres of snow per lobe
  lobeJitter: 0.5, // ± fraction on that volume
  repose: 0.58, // radians — 33°, the angle the surface refuses to exceed
  excess: 0.24, // radians of over-steepening at release — the slip faces
  slump: 2.6, // 1/s the excess decays at — the collapse rate
  creep: 1.9, // m/s a collapsing lobe's centroid crawls forward
  lobeScatter: 1.05, // metres of lateral scatter on release
  widen: 1.55, // >1 stretches each lobe across the line rather than along it
  bed: 0.26, // metres of settled deposit left in the tail
  bedRamp: 2.8, // metres behind the front it takes to reach that depth
  bedWidth: 3.0, // metres, half-width of that deposit
  bedCurve: 0.62, // how sharply the deposit thins toward its edges
  settleSink: 0.5, // metres the whole deposit sinks over the fade
  settleFlatten: 0.6, // 0..1 of the height it loses over the fade

  /* --- the snow, as a substance --- */
  snowAmbient: 0.52, // floor under the diffuse term
  snowWrap: 0.55, // how far light bends round a translucent grain
  snowFresh: 0.8, // seconds a lobe counts as freshly turned over for
  snowGrain: 0.13, // speckle depth
  snowGrainScale: 74.0, // grains per metre
  snowGlint: 0.55, // pinpoint sparkle — snow, not sand
  snowGlintScale: 130.0, // glints per metre, on its own finer lattice
  heapToe: 0.07, // metres of height the heap fades out over at its edge
  heapOpacity: 1.0,
  colorFresh: '#f4f8fd', // material that has just been turned over at the front
  colorSettled: '#c9d5e3', // the tail, hours old in avalanche seconds
  colorFace: '#ffffff', // the slip face — the part still above repose
  colorDeep: '#54687e', // shadow inside the body of the heap

  /* --- the slabs: hard blocks the flow shoulders up --- */
  slabCount: 54, // instances in the field, capped at the field's capacity
  slabCluster: 0.22, // 0..1 of them held back for the pile-up at the far end
  slabClusterRadius: 2.4, // metres, radius of that pile-up
  slabWidthNear: 0.9, // half-width of the slab band at the caster, metres
  slabWidth: 2.9, // ... and at the far end, metres
  slabWidthCurve: 0.9, // <1 flares the band early
  slabBias: 1.15, // <1 crowds the slabs toward the far end, unitless
  slabClump: 1.1, // >1 pulls them onto the centre line, unitless
  slabScatter: 0.75, // extra lateral jitter, fraction of the local half-width
  slabStagger: 0.22, // seconds of random delay between neighbouring slabs
  slabHeightNear: 0.72, // metres tall at the caster
  slabHeight: 1.45, // ... and at the far end
  slabHeightCurve: 0.95, // how late that ramp climbs
  slabHeightJitter: 0.42, // ± fraction
  slabCrown: 0.35, // 0..1 — how much shorter the slabs on the flanks are
  slabCrownPower: 1.5, // how sharply that dome falls off
  slabRubble: 0.3, // 0..1 chance a slab is demoted to wreckage
  slabRubbleScale: 0.34, // height multiplier for those
  slabRadiusNear: 0.5, // metres, plan radius at the caster
  slabRadius: 0.86, // metres, plan radius at the far end
  slabRadiusCurve: 0.7, // how the plan size ramps along the cast
  slabRadiusJitter: 0.45, // ± fraction
  slabLean: 0.14, // radians of lean away from the caster, before the tie below
  slabRepose: 0.55, // 0..1 — how far the slabs lie back onto the repose slope
  slabLeanRamp: 0.55, // 0 leans everything equally, 1 only the far end
  slabTwist: 1.0, // 0..1 of a full turn of random yaw
  slabTilt: 0.16, // radians of extra random tip, any bearing
  slabRise: 0.22, // seconds from buried to full height
  slabOvershoot: 0.28, // how far past full height the shoulder-up carries
  slabSettle: 0.45, // seconds that overshoot damps out over
  slabSpring: 15.0, // radians/second of the overshoot ring
  slabSink: 0.92, // fraction of its height a slab is buried at emergence 0
  slabBirthScale: 0.7, // footprint scale at the moment it breaks the surface
  slabBirthFade: 0.3, // seconds the birth flash decays over
  slabBreach: 0.28, // emergence fraction that throws the chunk burst
  slabRetractSink: 0.6, // extra metres a slab drops as the deposit melts out

  /* --- the shape of one slab (these rebuild the geometry when they move) --- */
  facets: 6, // sides of the plan polygon; 5–8 read best
  shear: 0.55, // 0..1 — how far the top face is tipped off horizontal
  taper: 0.78, // plan radius at the top as a fraction of the base
  rough: 0.3, // 0..1 outline irregularity — a slab is a fracture, not a prism
  notch: 0.22, // 0..1 how deeply the top face is chipped at its high corner

  /* --- the slab material --- */
  slabRoughness: 0.86, // MeshStandardMaterial roughness — snow is not glossy
  strata: 0.4, // depth of the wind-packed layering up the slab
  strataScale: 9.0, // layers per metre
  grain: 0.22, // hashed speckle over the crust
  grainScale: 34.0, // speckles per metre
  fracture: 1.1, // how bright the raw broken face is
  fractureSharp: 1.9, // how tightly that face is confined to the up-slope side
  slabRim: 0.7, // rim light on the silhouette
  slabRimPower: 2.6, // how tight that rim is
  slabGlow: 0.85, // overall emissive gain on a slab
  slabBirthGlow: 1.6, // flash as a slab breaks the surface
  colorCrust: '#dbe6f0', // the wind-packed outside of a slab
  colorFracture: '#ffffff', // the raw face where the slab broke
  colorShade: '#5b7086', // shadow inside the block
  colorSlabGlow: '#bcd8ec', // everything emissive on a slab

  /* --- the powder cloud --- */
  powderRate: 70.0, // particles/second off the front
  powderSpeed: 3.6, // metres/second
  powderRise: 1.5, // metres/second² of buoyancy
  powderSize: 1.5,
  powderLifetime: 2.0, // seconds
  powderOpacity: 0.72,
  impactPowder: 90, // particles thrown at the pile-up
  colorPowderA: '#ffffff',
  colorPowderB: '#dfe9f4',
  colorPowderC: '#b3c3d4',
  colorPowderD: '#8496a8',

  /* --- spindrift: fine crystals off the crest --- */
  driftRate: 90.0, // particles/second
  driftSpeed: 2.6, // metres/second
  driftRise: 1.1, // metres/second² of buoyancy
  driftSize: 0.09,
  driftLifetime: 1.3, // seconds
  driftTurbulence: 0.9,
  colorDriftA: '#ffffff',
  colorDriftB: '#e2f2ff',
  colorDriftC: '#a8ccea',
  colorDriftD: '#5d7f9e',

  /* --- chunks knocked loose as a slab shoulders up --- */
  breachChunks: 12, // particles per slab breaking the surface
  impactChunks: 60, // ... and at the pile-up
  chunkSpeed: 4.2, // metres/second
  chunkGravity: -12.0, // metres/second²
  chunkSize: 0.15,
  chunkLifetime: 1.4, // seconds
  colorChunkA: '#ffffff',
  colorChunkB: '#d6e2ee',
  colorChunkC: '#93a7ba',
  colorChunkD: '#5a6c7d',

  /* --- the pile-up at the far end --- */
  burstSize: 2.6, // metres, the shell of thrown powder
  burstIntensity: 0.8,
  colorBurstA: '#ffffff',
  colorBurstB: '#cfe0ef',
  colorBurstC: '#7d93a8',
  shockRadius: 4.4, // metres, the ring across the floor
  colorShockA: '#eef6ff',
  colorShockB: '#7fa0bc',
  impactShake: 0.5,
  shakeDuration: 0.75, // seconds
  impactFlash: 0.12, // an avalanche is not bright; this is nearly off
  colorFlash: '#dbe8f4',
  rumble: 0.55, // continuous shake while the front is running

  /* --- the light --- */
  lightColor: '#cfe2f2',
  lightIntensity: 5.5,
  lightRadius: 13.0,
  lightPulse: 0.22, // depth of the slow breathing on the light
  lightPulseSpeed: 0.7 // cycles/second of it
};

/** Editor layout. */
export const avalancheSchema = {
  'The cast': [
    ['range', 2, 48, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 40, 0.5, 'front speed'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['lifetime', 0.1, 8, 0.05, 'deposit lifetime'],
    ['settleTime', 0.1, 6, 0.05, 'settle time'],
    ['castAnim', 'cast animation']
  ],
  'The runout': [
    ['runout', 0.05, 5, 0.05, 'runout (s)'],
    ['runoutCurve', 0.2, 6, 0.05, 'runout curve'],
    ['heapLead', 0.2, 3, 0.01, 'heap lead']
  ],
  'The heap': [
    ['repose', 0.15, 1.2, 0.005, 'repose angle (rad)'],
    ['excess', 0, 0.8, 0.005, 'over-steep (rad)'],
    ['slump', 0.1, 12, 0.05, 'slump rate (1/s)'],
    ['creep', 0, 8, 0.05, 'creep (m/s)'],
    ['lobes', 1, 24, 1, 'live lobes'],
    ['lobeRate', 0.5, 20, 0.1, 'lobes/s'],
    ['lobeVolume', 0.05, 12, 0.05, 'lobe volume (m³)'],
    ['lobeJitter', 0, 1, 0.01, 'lobe jitter'],
    ['lobeScatter', 0, 6, 0.05, 'lateral scatter (m)'],
    ['widen', 0.2, 4, 0.05, 'lobe widening'],
    ['heapWidth', 0.5, 12, 0.1, 'sheet half-width (m)'],
    ['heapHeight', 0, 3, 0.01, 'height gain'],
    ['heapFloor', 0, 0.2, 0.001, 'sits at (m)']
  ],
  'The heap/Deposit': [
    ['bed', 0, 2, 0.01, 'deposit depth (m)'],
    ['bedRamp', 0.1, 12, 0.1, 'deposit ramp (m)'],
    ['bedWidth', 0.2, 12, 0.1, 'deposit half-width (m)'],
    ['bedCurve', 0.05, 4, 0.05, 'deposit edge'],
    ['settleSink', 0, 3, 0.01, 'sink over the fade (m)'],
    ['settleFlatten', 0, 1, 0.01, 'flatten over the fade']
  ],
  'The snow': [
    ['snowAmbient', 0, 1, 0.01, 'ambient'],
    ['snowWrap', 0, 1, 0.01, 'light wrap'],
    ['snowFresh', 0.05, 4, 0.05, 'fresh (s)'],
    ['snowGrain', 0, 0.6, 0.01, 'grain'],
    ['snowGrainScale', 5, 300, 1, 'grains/m'],
    ['snowGlint', 0, 3, 0.01, 'glint'],
    ['snowGlintScale', 10, 400, 1, 'glints/m'],
    ['heapToe', 0.005, 0.4, 0.005, 'toe (m)'],
    ['heapOpacity', 0, 1, 0.01, 'opacity'],
    'colorFresh',
    'colorSettled',
    'colorFace',
    'colorDeep'
  ],
  'The slabs': [
    ['slabCount', 0, 96, 1, 'slabs'],
    ['slabCluster', 0, 0.6, 0.01, 'held for the pile-up'],
    ['slabClusterRadius', 0.2, 8, 0.05, 'pile-up radius'],
    ['slabWidthNear', 0.05, 6, 0.01, 'band half-width at the caster'],
    ['slabWidth', 0.05, 8, 0.01, 'band half-width at the target'],
    ['slabWidthCurve', 0.2, 4, 0.01, 'band curve'],
    ['slabBias', 0.3, 3, 0.01, 'crowd toward the target'],
    ['slabClump', 0.2, 4, 0.01, 'pull onto the centre line'],
    ['slabScatter', 0, 2, 0.01, 'lateral scatter'],
    ['slabStagger', 0, 1.5, 0.01, 'stagger between slabs']
  ],
  'The slabs/Size': [
    ['slabHeightNear', 0.05, 4, 0.01, 'height at the caster'],
    ['slabHeight', 0.05, 5, 0.01, 'height at the target'],
    ['slabHeightCurve', 0.1, 4, 0.01, 'height curve'],
    ['slabHeightJitter', 0, 1, 0.01, 'height jitter'],
    ['slabCrown', 0, 1, 0.01, 'flank falloff'],
    ['slabCrownPower', 0.2, 5, 0.01, 'falloff sharpness'],
    ['slabRubble', 0, 1, 0.01, 'demoted to wreckage'],
    ['slabRubbleScale', 0.05, 1, 0.01, 'wreckage height'],
    ['slabRadiusNear', 0.05, 3, 0.01, 'plan radius at the caster'],
    ['slabRadius', 0.05, 3, 0.01, 'plan radius at the target'],
    ['slabRadiusCurve', 0.1, 4, 0.01, 'plan curve'],
    ['slabRadiusJitter', 0, 1, 0.01, 'plan jitter']
  ],
  'The slabs/Attitude': [
    ['slabLean', 0, 1.2, 0.01, 'lean (rad)'],
    ['slabRepose', 0, 1, 0.01, 'lie back onto the slope'],
    ['slabLeanRamp', 0, 1, 0.01, 'lean ramp'],
    ['slabTwist', 0, 1, 0.01, 'random yaw'],
    ['slabTilt', 0, 0.8, 0.005, 'random tip']
  ],
  'The slabs/Shouldering up': [
    ['slabRise', 0.02, 1.5, 0.01, 'rise time'],
    ['slabOvershoot', 0, 1, 0.01, 'overshoot'],
    ['slabSettle', 0.05, 2, 0.01, 'settle'],
    ['slabSpring', 2, 60, 0.5, 'overshoot ring'],
    ['slabSink', 0, 1, 0.01, 'buried at emergence 0'],
    ['slabBirthScale', 0.05, 1, 0.01, 'size at the surface'],
    ['slabBirthFade', 0.02, 2, 0.01, 'birth flash decay'],
    ['slabBreach', 0.02, 1, 0.01, 'breach fraction'],
    ['slabRetractSink', 0, 3, 0.01, 'extra sink on retract (m)']
  ],
  'The slab shape': [
    ['facets', 4, 10, 1, 'plan sides'],
    ['shear', 0, 1, 0.01, 'top face tip'],
    ['taper', 0.2, 1.2, 0.01, 'top plan fraction'],
    ['rough', 0, 0.9, 0.01, 'outline irregularity'],
    ['notch', 0, 0.7, 0.01, 'chipped corner']
  ],
  'The slab surface': [
    ['slabRoughness', 0.05, 1, 0.01, 'roughness'],
    ['strata', 0, 1.2, 0.01, 'wind layering'],
    ['strataScale', 1, 40, 0.5, 'layers/m'],
    ['grain', 0, 1, 0.01, 'speckle'],
    ['grainScale', 4, 120, 1, 'speckles/m'],
    ['fracture', 0, 3, 0.01, 'broken face'],
    ['fractureSharp', 0.2, 8, 0.05, 'broken face tightness'],
    ['slabRim', 0, 3, 0.01, 'rim'],
    ['slabRimPower', 0.2, 8, 0.05, 'rim tightness'],
    ['slabGlow', 0, 3, 0.01, 'glow'],
    ['slabBirthGlow', 0, 5, 0.01, 'birth flash'],
    'colorCrust',
    'colorFracture',
    'colorShade',
    'colorSlabGlow'
  ],
  'Powder': [
    ['powderRate', 0, 400, 1, 'rate'],
    ['powderSpeed', 0, 20, 0.1, 'speed'],
    ['powderRise', -5, 8, 0.05, 'buoyancy'],
    ['powderSize', 0.05, 5, 0.01, 'size'],
    ['powderLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['powderOpacity', 0, 1, 0.01, 'opacity'],
    ['impactPowder', 0, 400, 1, 'at the pile-up'],
    'colorPowderA',
    'colorPowderB',
    'colorPowderC',
    'colorPowderD'
  ],
  'Spindrift': [
    ['driftRate', 0, 400, 1, 'rate'],
    ['driftSpeed', 0, 20, 0.1, 'speed'],
    ['driftRise', -5, 8, 0.05, 'buoyancy'],
    ['driftSize', 0.01, 1, 0.005, 'size'],
    ['driftLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['driftTurbulence', 0, 4, 0.01, 'turbulence'],
    'colorDriftA',
    'colorDriftB',
    'colorDriftC',
    'colorDriftD'
  ],
  'Chunks': [
    ['breachChunks', 0, 60, 1, 'per slab'],
    ['impactChunks', 0, 300, 1, 'at the pile-up'],
    ['chunkSpeed', 0, 20, 0.1, 'speed'],
    ['chunkGravity', -40, 0, 0.5, 'gravity'],
    ['chunkSize', 0.02, 1, 0.01, 'size'],
    ['chunkLifetime', 0.1, 6, 0.05, 'lifetime'],
    'colorChunkA',
    'colorChunkB',
    'colorChunkC',
    'colorChunkD'
  ],
  'The pile-up': [
    ['burstSize', 0.2, 12, 0.05, 'shell size'],
    ['burstIntensity', 0, 4, 0.01, 'shell intensity'],
    ['shockRadius', 0.5, 16, 0.1, 'ring radius'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration'],
    ['impactFlash', 0, 1.5, 0.01, 'flash'],
    ['rumble', 0, 3, 0.01, 'rumble'],
    'colorBurstA',
    'colorBurstB',
    'colorBurstC',
    'colorShockA',
    'colorShockB',
    'colorFlash'
  ],
  'The light': [
    ['lightIntensity', 0, 40, 0.1, 'intensity'],
    ['lightRadius', 1, 40, 0.5, 'radius'],
    ['lightPulse', 0, 1, 0.01, 'breath depth'],
    ['lightPulseSpeed', 0, 6, 0.05, 'breath speed'],
    'lightColor'
  ]
};
