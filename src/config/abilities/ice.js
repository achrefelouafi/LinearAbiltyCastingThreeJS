/* ================================================================== */
/* ICE — ability one                                                   */
/* ================================================================== */
/**
 * A glacial eruption: a fracture front races out along the aimed line and a
 * field of crystal spikes tears up out of the floor behind it, small and dense
 * at the caster, tall and violent at the far end.
 *
 * Everything is generated — the crystals are procedural geometry
 * (`assets/ProceduralGeometry.js`), their shading is a patched standard
 * material (`materials/IceMaterial.js`), the frost is a shader on a quad and
 * the mist, shards and glitter are GPU particles. There are no textures and no
 * meshes on disk.
 */
export const ice = {
  /* --- the cast itself --- */
  range: 15.0, // maximum cast distance, metres
  minRange: 2.5, // closer than this and the cast is refused
  speed: 26.0, // how fast the fracture front travels, metres/second
  lifetime: 3.6, // seconds the field stands before it withdraws
  cooldown: 0.4, // seconds before the ability can be armed again
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the footprint the spikes fill --- */
  widthNear: 0.55, // half-width of the band at the caster, metres
  width: 2.5, // half-width at the far end, metres
  widthCurve: 0.75, // <1 flares early, >1 stays narrow then opens out
  spikeCount: 190, // instances spent on one cast (capped at 288)
  density: 1.0, // multiplier on that count
  clumping: 1.35, // >1 pulls spikes toward the centre line
  scatter: 0.55, // extra lateral jitter, fraction of the local half-width
  frontBias: 0.85, // <1 crowds spikes toward the impact point

  /* --- silhouette of the field --- */
  heightNear: 0.5, // spike height at the caster, metres
  height: 3.1, // spike height at the far end, metres
  heightCurve: 1.7, // how late the ramp climbs
  heightJitter: 0.55,
  crown: 0.55, // how much shorter the flank blades are than the spine, 0..1
  peak: 1.45, // extra height multiplier at the impact point
  peakWidth: 0.28, // how much of the line that swell covers, 0..1
  rubble: 0.42, // fraction of the spikes demoted to ankle-height shards
  rubbleScale: 0.3,

  /* --- an individual crystal --- */
  radius: 0.41, // base radius, metres
  radiusJitter: 0.93,
  taper: 0.69, // tip radius as a fraction of the base
  facets: 7, // sides of the prism (5–8 read best)
  roughness: 0.09, // how far the facets are pushed off a clean prism
  bend: 0.66, // sideways curve from base to tip
  lean: 0.42, // radians the spikes lean away from the caster
  leanJitter: 1.5,
  twist: 1.0, // random yaw, 0..1 of a full turn

  /* --- the eruption --- */
  riseTime: 0.17, // seconds from buried to full height
  riseOvershoot: 0.26, // how far past full height the punch carries
  riseStagger: 0.09, // seconds of random delay between neighbours
  settle: 0.55, // seconds the overshoot takes to damp out
  shatterDelay: 0.6, // seconds after `lifetime` before they start to go
  sinkTime: 1.0, // seconds to withdraw into the floor

  /* --- the ice material --- */
  colorDeep: '#3e737a', // the colour thick ice accumulates toward
  colorIce: '#8adaff', // body
  colorRim: '#f2feff', // fresnel edge
  colorCore: '#638797', // the light trapped inside a fresh crystal
  opacity: 0.92,
  depthTint: 1.15, // how fast the deep tint builds with thickness
  fresnel: 2.3,
  fresnelPower: 2.4,
  translucency: 1.5, // light bleeding through from behind
  envIntensity: 0.9, // how much of the HDR probe the facets catch
  facetSharp: 0.68, // crispness of the internal facet shading
  fracture: 0.62, // internal crack planes
  fractureScale: 6.5, // cracks per metre
  veins: 0.45, // milky feather-frost inside the crystal
  veinScale: 3.2,
  // Named `glint*` rather than `sparkle*` on purpose: these are the pinpoint
  // highlights on the crystal *surface*, and the `sparkle*` family further
  // down drives the glitter *particles*. Two different effects.
  glint: 1.1,
  glintScale: 34.0,
  glintSpeed: 0.7,
  frostLine: 0.5, // rime banding climbing the crystal
  glow: 0.85, // overall emissive gain
  edgeGlow: 1.1, // brightness of the silhouette rim
  birthGlow: 1.6, // extra glow on a crystal that has just erupted
  birthFade: 0.45, // seconds that birth flash lasts

  /* --- what the ground does --- */
  frostSpread: 1.35, // frost patch radius, × the local half-width
  frostRate: 3.6, // patches laid per metre of front travel
  frostLife: 7.0, // seconds a patch lingers
  frostIntensity: 0.85,
  frostCrystals: 1.5, // grain of the packed snow
  colorFrost: '#f0f9ff', // the lit face of the snow
  colorFrostEdge: '#79b6dd', // what it goes in its own shadow
  shockRadius: 5.5, // impact shockwave ring, metres
  colorShockA: '#5fd0ff', // body of the shockwave ring
  colorShockB: '#f2feff', // its crest

  /* --- mist, shards and glitter --- */
  /**
   * Every particle system is coloured by a four-stop gradient sampled over the
   * particle's own lifetime: `A` the instant it is born, `D` as it dies. They
   * are spelled out rather than derived from the crystal palette so the fog can
   * be warmed, or the glitter recoloured, without touching the ice itself.
   */
  mistRate: 260, // rolling ground fog, particles/second
  mistSize: 1.15,
  mistSpeed: 1.3,
  mistLifetime: 2.8,
  mistOpacity: 0.05,
  mistRise: 0.35, // how fast the fog lifts, metres/second
  colorMistA: '#f2feff',
  colorMistB: '#cdefff',
  colorMistC: '#a9e4ff',
  colorMistD: '#09304c',
  // Chips are thrown per *breach*, not per second: a crystal cracks the floor
  // once and spits once. The old key here was `shardRate`, a per-second figure
  // left over from a draft where the shards streamed the whole cast — nothing
  // read it, and the count it should have been driving was hard-coded to 3.
  // Renamed rather than repurposed so an old preset carrying `shardRate: 150`
  // is dropped by `applySettings` instead of quietly emitting fifty times the
  // chips it used to.
  breachShards: 3, // ice chips spat where one crystal breaks the surface
  shardSize: 0.075,
  shardSpeed: 7.0,
  shardLifetime: 1.7,
  shardGravity: -14.0,
  colorShardA: '#f2feff',
  colorShardB: '#a9e4ff',
  colorShardC: '#a9e4ff',
  colorShardD: '#12496f',
  sparkleRate: 130, // the rising glitter plume
  sparkleSize: 0.055,
  sparkleSpeed: 3.4,
  sparkleLifetime: 2.6,
  sparkleRise: 1.6, // upward drift, metres/second
  sparkleTurbulence: 0.55,
  colorSparkleA: '#f2feff',
  colorSparkleB: '#57c9ff',
  colorSparkleC: '#a9e4ff',
  colorSparkleD: '#041e32',

  /* --- dynamic light --- */
  lightIntensity: 9,
  lightRadius: 13,
  lightColor: '#7fd4ff',

  /* --- the impact at the far end --- */
  burstSize: 3.6,
  burstIntensity: 0.75,
  burstShards: 90, // extra chips thrown at the impact
  impactShake: 0.7,
  impactFlash: 0.12,
  shakeDuration: 0.9,
  rumble: 0.06, // continuous shake while the front travels
  // The frost shell mixes A→B across its billowing noise and lays C over the
  // crystallised plates and the fresnel rim, so C is the one that reads hot.
  colorBurstA: '#a9e4ff',
  colorBurstB: '#cdefff',
  colorBurstC: '#f2feff',
  colorFlash: '#f2feff' // the full-screen flash on impact
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * The folders the Frost Lance's controls are filed under, and the range each
 * one is tuned to. Lifted from the hand-written `Editor#_buildIce` it replaced,
 * ranges and labels intact — they were arrived at by dragging, not by rounding
 * the default, and a slider whose maximum sits on the shipped value can only
 * ever come down.
 *
 * Format is documented in `config/abilities/index.js`.
 */
export const iceSchema = {
  'The cast': [
    ['range', 2, 40, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 80, 0.5, 'front speed'],
    ['lifetime', 0.2, 12, 0.1, 'field lifetime'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  Footprint: [
    ['widthNear', 0.05, 6, 0.01, 'width at caster'],
    ['width', 0.1, 10, 0.05, 'width at target'],
    ['widthCurve', 0.2, 4, 0.01, 'width curve'],
    ['spikeCount', 4, 288, 1, 'crystal count'],
    ['density', 0.05, 1, 0.01, 'density'],
    ['clumping', 0.3, 4, 0.01, 'pull to centre'],
    ['scatter', 0, 2, 0.01, 'lateral scatter'],
    ['frontBias', 0.3, 3, 0.01, 'crowd toward target']
  ],
  Silhouette: [
    ['heightNear', 0.05, 6, 0.01, 'height at caster'],
    ['height', 0.1, 12, 0.05, 'height at target'],
    ['heightCurve', 0.2, 5, 0.01, 'height curve'],
    ['heightJitter', 0, 1.5, 0.01, 'height jitter'],
    ['crown', 0, 0.95, 0.01, 'flank falloff'],
    ['peak', 1, 4, 0.01, 'swell at target'],
    ['peakWidth', 0.02, 1, 0.01, 'swell width'],
    ['rubble', 0, 1, 0.01, 'rubble fraction'],
    ['rubbleScale', 0.05, 1, 0.01, 'rubble height']
  ],
  // These four regenerate the crystal geometry — see IceAbility#_syncGeometry.
  'The crystal': [
    ['radius', 0.02, 1.5, 0.01, 'base radius'],
    ['radiusJitter', 0, 1.5, 0.01, 'radius jitter'],
    ['taper', 0.01, 0.8, 0.01, 'tip taper'],
    ['facets', 3, 10, 1, 'facets'],
    ['roughness', 0, 1, 0.01, 'surface roughness'],
    ['bend', 0, 1.5, 0.01, 'bend'],
    ['lean', 0, 1.4, 0.01, 'lean from caster'],
    ['leanJitter', 0, 1.5, 0.01, 'lean jitter'],
    ['twist', 0, 1, 0.01, 'random yaw']
  ],
  'The eruption': [
    ['riseTime', 0.02, 1.5, 0.01, 'rise time'],
    ['riseOvershoot', 0, 1, 0.01, 'punch overshoot'],
    ['riseStagger', 0, 1, 0.005, 'stagger'],
    ['settle', 0.05, 2, 0.01, 'settle time'],
    ['shatterDelay', 0, 4, 0.05, 'hold before sinking'],
    ['sinkTime', 0.1, 4, 0.05, 'sink time']
  ],
  'Ice material': [
    ['colorDeep', 'deep'],
    ['colorIce', 'body'],
    ['colorRim', 'rim'],
    ['colorCore', 'inner light'],
    ['opacity', 0, 1, 0.01, 'opacity'],
    ['depthTint', 0, 3, 0.01, 'thickness tint'],
    ['fresnel', 0, 6, 0.01, 'fresnel'],
    ['fresnelPower', 0.5, 6, 0.05, 'fresnel power'],
    ['translucency', 0, 4, 0.01, 'translucency'],
    ['envIntensity', 0, 3, 0.01, 'reflection'],
    ['facetSharp', 0, 1.5, 0.01, 'facet contrast'],
    ['fracture', 0, 2, 0.01, 'internal cracks'],
    ['fractureScale', 0.5, 20, 0.1, 'crack scale'],
    ['veins', 0, 2, 0.01, 'feather frost'],
    ['veinScale', 0.2, 10, 0.05, 'frost scale'],
    ['glint', 0, 5, 0.01, 'surface glint'],
    ['glintScale', 4, 90, 0.5, 'glint scale'],
    ['glintSpeed', 0, 4, 0.01, 'glint speed'],
    ['frostLine', 0, 1.5, 0.01, 'rime at the base'],
    ['glow', 0, 5, 0.01, 'glow'],
    ['edgeGlow', 0, 6, 0.01, 'edge glow'],
    ['birthGlow', 0, 10, 0.05, 'birth flash'],
    ['birthFade', 0.02, 2, 0.01, 'birth flash time']
  ],
  'Frost on the ground': [
    ['frostSpread', 0.1, 5, 0.01, 'patch radius'],
    ['frostRate', 0.2, 12, 0.1, 'patches / metre'],
    ['frostLife', 0.5, 20, 0.1, 'patch lifetime'],
    ['frostIntensity', 0, 2, 0.01, 'intensity'],
    ['frostCrystals', 0, 4, 0.01, 'snow grain'],
    ['shockRadius', 0.5, 20, 0.1, 'shockwave radius'],
    ['colorFrost', 'snow'],
    ['colorFrostEdge', 'snow shadow'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest']
  ],
  'Mist, chips & glitter': [
    ['mistRate', 0, 900, 1, 'mist rate'],
    ['mistSize', 0.05, 4, 0.01, 'mist size'],
    ['mistSpeed', 0, 8, 0.05, 'mist speed'],
    ['mistLifetime', 0.2, 8, 0.05, 'mist lifetime'],
    ['mistOpacity', 0, 2, 0.01, 'mist opacity'],
    ['mistRise', -2, 4, 0.01, 'mist rise'],
    ['breachShards', 0, 40, 1, 'chips per breach'],
    ['shardSize', 0.005, 0.5, 0.005, 'chip size'],
    ['shardSpeed', 0, 25, 0.1, 'chip speed'],
    ['shardLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['shardGravity', -40, 0, 0.1, 'chip gravity'],
    ['sparkleRate', 0, 600, 1, 'glitter rate'],
    ['sparkleSize', 0.005, 0.4, 0.005, 'glitter size'],
    ['sparkleSpeed', 0, 12, 0.05, 'glitter speed'],
    ['sparkleLifetime', 0.2, 8, 0.05, 'glitter lifetime'],
    ['sparkleRise', -2, 8, 0.05, 'glitter rise'],
    ['sparkleTurbulence', 0, 3, 0.01, 'glitter turbulence'],
    ['colorMist*', 'Mist colour'],
    ['colorShard*', 'Chip colour'],
    ['colorSparkle*', 'Glitter colour']
  ],
  Impact: [
    ['burstSize', 0.2, 14, 0.05, 'burst size'],
    ['burstIntensity', 0, 4, 0.01, 'burst intensity'],
    ['burstShards', 0, 400, 1, 'burst chips'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'vapour shell'],
    ['colorBurstB', 'shell body'],
    ['colorBurstC', 'plates & rim'],
    ['colorFlash', 'screen flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.1, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
