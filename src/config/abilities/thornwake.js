/* ================================================================== */
/* THORNWAKE — verdant, line cast                                      */
/* ================================================================== */
/**
 * A bramble erupts along the aimed line: curved, barbed thorns punching up out
 * of the floor behind a travelling front, and **vines threaded between them**.
 *
 * The vines are the whole ability. A field of forty separate spikes reads as
 * forty props no matter how good the spike is; the moment a sagging strand runs
 * from the shoulder of one thorn to the flank of its neighbour, and another
 * crosses it going the other way, the same forty props read as *one thing that
 * grew*. So a vine is not decoration laid over the field — it is a live query
 * against it. Every frame each vine asks the `GrowthField` where two of its
 * instances currently are, at the current sliders, and re-threads a catenary
 * between those two points. Drag `clumping` and the thorns crowd together and
 * the vines slacken with them; drag `vineReach` and the whole weave re-routes
 * onto different neighbours while the clock is stopped.
 *
 * Nothing here is captured in metres. A cast rolls two unitless dice per vine
 * (which instance to start from, how far along the field to look for a partner)
 * and one timestamp per vine (the moment both its ends had broken the surface).
 * Every span, sag, grip height and swing is resolved against this block inside
 * the update loop.
 *
 * The `thorn*` group is different in kind from the rest: those eight numbers are
 * baked into the *geometry*, because a barb cannot be expressed as a per-instance
 * transform. `GrowthField#syncGeometry` compares them each frame and rebuilds
 * the three meshes only when one of them actually moved, so they stay live
 * sliders — a thorn is about 300 triangles and rebuilding three of them costs
 * less than the branch that would avoid it.
 */
export const thornwake = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 2.5, // closer than this and the cast is refused
  speed: 26.0, // how fast the growth front runs down the line, metres/second
  lifetime: 1.5, // seconds the bramble stands after the front lands
  fadeTime: 1.4, // seconds it takes to wither back into the floor
  cooldown: 1.0, // seconds before it can be cast again
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- how the field is laid out --- */
  thorns: 46, // instances planted per cast (hard ceiling 96)
  clusterShare: 0.2, // 0..1 of them held back for the knot at the impact point
  clusterRadius: 1.6, // metres — radius of that knot
  riseStagger: 0.18, // seconds of random delay between neighbours erupting
  frontBias: 0.85, // <1 crowds instances toward the far end, unitless
  widthNear: 0.55, // half-width of the bramble band at the caster, metres
  width: 2.5, // ... and at the far end, metres
  widthCurve: 1.15, // >1 stays narrow, then opens out late
  clumping: 0.8, // >1 pulls instances onto the centre line, unitless
  scatter: 0.6, // extra lateral jitter, fraction of the local half-width

  /* --- the silhouette of the field --- */
  heightNear: 0.55, // metres tall at the caster
  height: 1.9, // metres tall at the far end
  heightCurve: 1.05, // how late the height ramp climbs
  heightJitter: 0.45, // ± fraction per instance
  crown: 0.34, // 0..1 how much shorter the flank thorns are than the spine
  crownPower: 1.5, // how sharply that dome falls off
  peak: 1.3, // extra height multiplier at the far end
  peakWidth: 0.3, // 0..1 of the cast that swell covers
  rubble: 0.2, // 0..1 chance an instance is demoted to a low sprawling shoot
  rubbleScale: 0.42, // height multiplier for those
  rubbleSpread: 1.45, // radius multiplier for those
  radiusNear: 0.16, // metres — base radius of a thorn at the caster
  radius2: 0.24, // ... and at the far end, metres
  radiusCurve: 0.7, // how the radius ramps along the cast
  radiusJitter: 0.45, // ± fraction per instance

  /* --- how a thorn is oriented --- */
  lean: 0.55, // radians away from the caster / out across the band
  leanJitter: 0.6, // ± fraction per instance
  leanRamp: 0.55, // 0 leans everything equally, 1 only leans the far end
  leanForward: 0.45, // weight of "away from the caster" in the lean direction
  leanOutward: 0.95, // weight of "out across the band"
  twist: 1.0, // 0..1 of a full turn of random yaw
  tilt: 0.24, // radians of extra random tip, any bearing

  /* --- the eruption --- */
  riseTime: 0.24, // seconds from buried to full height
  riseOvershoot: 0.32, // how far past full height the punch carries
  settle: 0.45, // seconds that overshoot damps out over
  springRate: 15.0, // radians/second of the overshoot ring
  emergeSink: 0.9, // fraction of its height a thorn is buried at emergence 0
  birthScale: 0.68, // footprint scale at the moment it breaks through
  birthFade: 0.28, // seconds the sap flash decays over
  breachAt: 0.22, // emergence fraction that fires the chips and the crack
  sinkDepth: 0.6, // extra metres a withering thorn drops beyond its own height

  /* --- the shape of one thorn (rebuilds the geometry when it moves) --- */
  /**
   * A tapered curved spike with barbs. `thornTaper` is the exponent on
   * `(1 - t)` down the shaft: 1 is a cone, 2.3 is a needle with a thick heel,
   * which is what a bramble actually looks like. The barbs point *back down the
   * stem* at `thornBarbTilt`, because a thorn that points forward reads as a
   * fir tree.
   */
  thornSides: 5, // faces around the shaft, 3..8
  thornTaper: 2.3, // exponent on the shaft's radius profile
  thornCurve: 0.48, // 0..1 of a unit-height sweep the tip drifts sideways
  thornBarbs: 3, // barbs per thorn, 0..5
  thornBarbLength: 0.19, // barb length, fraction of the unit height
  thornBarbTilt: -0.5, // -1 points the barbs at the floor, +1 at the sky
  thornBarbSpread: 0.62, // 0..1 how far apart the barbs' bearings are scattered
  thornRough: 0.34, // 0..1 irregularity of the facets and ring heights

  /* --- bark --- */
  colorBark: '#4a6b2a', // the lit face of the wood
  colorHeart: '#243d14', // the deep shadow inside a facet
  colorMoss: '#6f8a3a', // the mottle that breaks the bark up
  colorTip: '#c8b06a', // the warm bone highlight on a point
  colorSap: '#9ade5a', // the flash as a thorn breaks the surface
  barkGrain: 0.6, // 0..1 depth of the fibre running up the shaft
  barkGrainScale: 5.5, // grain cycles per metre, world space
  mossAmount: 0.42, // 0..1 how much of the bark the mottle takes
  mossScale: 2.4, // mottle cycles per unit height, local space
  barkRough: 0.74, // surface roughness of the standard material
  tipStart: 0.6, // 0..1 up the thorn where the warm highlight begins
  tipSharp: 1.8, // exponent on that ramp — higher keeps it to the very point
  tipGlow: 1.5, // emissive gain on the tips
  barbEdge: 0.055, // unit-space margin past the shaft that counts as a barb
  barbSpan: 0.075, // unit-space feather on that test
  sapGlow: 2.4, // emissive gain on the birth flash
  barkGlow: 1.0, // master emissive gain on everything above
  barkOpacity: 1.0,

  /* --- the vines that thread the field together --- */
  /**
   * Twelve slots, four per `FilamentPaths` strip: the module holds four role
   * slots and one anchor pair per role, so twelve vines is three strips and six
   * draw calls. `vineReach` is the number of instance indices ahead a vine will
   * look for a partner — the field plants stratified along the line, so index
   * distance *is* distance down the cast, and a small reach gives you local
   * tangles while a large one throws long strands across the corridor.
   */
  vines: 10, // vine slots in use, 0..12 — under the ceiling on purpose, so the
  //            slider has room to go up as well as down
  vineStrands: 2, // parallel filaments per vine, 1..4
  vineReach: 5, // how many instances ahead a vine looks for its partner
  vineMaxSpan: 4.2, // metres — a pair further apart than this is rejected
  vineGripLow: 0.34, // 0..1 up the first thorn the vine is tied off at
  vineGripHigh: 0.8, // 0..1 up the second thorn
  vineBirth: 0.35, // emergence both ends must reach before a vine threads
  vineGrow: 0.3, // seconds a vine takes to draw itself in
  vineSlack: 0.6, // metres of droop at mid-span when fully slack
  vineCurve: 1.7, // 1 is rope, 3 is heavy chain, 0.01 is a parabola
  vineSwing: 0.09, // metres of lateral sway
  vineSwingSpeed: 1.5, // radians/second of that sway
  vineTaut: 0.12, // 0..1 baseline tension while the field is still growing
  vineCinch: 0.72, // 0..1 tension the weave pulls to once the front lands
  cinchTime: 0.4, // seconds that cinch takes
  vineSpread: 0.07, // metres between the parallel filaments of one vine
  vineFloor: 0.04, // metres — vines are clamped above this
  vineGroundDamp: 0.4, // 0..1 on the vertical part of a vine's kink

  /* --- how a vine is drawn --- */
  vineWidth: 0.022, // half-width of a vine's core ribbon, metres
  vineGlowWidth: 4.4, // halo half-width, × the core
  vineGlowOpacity: 0.38, // halo alpha relative to the core
  vineKink: 0.3, // metres of lateral kink along a vine
  vineKinkScale: 1.05, // kinks per metre
  vineOctaves: 3, // 1..5 octaves of that kink
  vineKinkFalloff: 0.52, // amplitude kept per octave
  vineCrawl: 0.45, // how fast the kinks slide along, per second
  vinePinch: 0.22, // 0..1 of the span the kink is eased out over at each end
  vineRestrike: 2.0, // whole re-shapes per second — low; a vine is not lightning
  vineFlicker: 0.06, // 0..1 depth of the whole-weave brightness stutter
  vineFlickerSpeed: 7.0, // steps/second that stutter is quantised to
  vineStrandFlash: 0.14, // 0..1 depth of the per-filament blink
  vineCoreSharp: 2.4, // exponent on the core's edge falloff
  vineGlowFalloff: 2.6, // the same for the halo
  vineSoftFade: 0.5, // metres of depth fade where a vine meets geometry
  vineOpacity: 1.0,
  vineGlow: 0.85, // emissive gain fed into bloom
  vineEndFade: 0.85, // 0..1 how much a vine's ends fade out
  vineEndTaper: 1.0, // 0..1 how much they narrow
  vineTipLength: 0.14, // 0..1 of the span the growing front is smeared over
  vineTipGlow: 0.6, // extra core colour at that front
  colorVineCore: '#c8e07a', // the lit centre line of a vine
  colorVineInner: '#7fa83a',
  colorVineOuter: '#3f6b1e', // its outside
  colorVineHalo: '#14300a', // the wide dim atmosphere around the weave

  /* --- chaff: leaf and husk flicked off the growth --- */
  /**
   * As in `ice` and `thunder`: each system is coloured by a four-stop gradient
   * sampled over the particle's own lifetime, `A` at birth through `D` as it
   * dies. Spelled out rather than derived from the bark palette, so the litter
   * can be made to brown off while the thorns stay green.
   */
  chaffRate: 60, // continuous shed off the standing field, particles/second
  chaffBreach: 9, // extra flicked off each thorn as it breaks the surface
  chaffSize: 0.13,
  chaffSpeed: 3.2, // metres/second
  chaffLifetime: 1.7, // seconds
  chaffGravity: -3.4, // metres/second²
  chaffSpin: 5.0, // radians/second of tumble
  colorChaffA: '#9ade5a',
  colorChaffB: '#6f9a32',
  colorChaffC: '#4a6b2a',
  colorChaffD: '#2a3a16',

  /* --- spore motes drifting up out of the bramble --- */
  moteRate: 45, // particles/second
  moteSize: 0.05,
  moteSpeed: 0.8, // metres/second
  moteLifetime: 2.6, // seconds
  moteRise: 0.5, // upward drift, metres/second
  moteTurbulence: 0.8,
  colorMoteA: '#e8ffb0',
  colorMoteB: '#c8e07a',
  colorMoteC: '#6f9a32',
  colorMoteD: '#1e3010',

  /* --- soil thrown up where a thorn breaches --- */
  soilBreach: 7, // chips per breach
  soilSize: 0.07,
  soilSpeed: 3.6, // metres/second
  soilLifetime: 1.1, // seconds
  soilGravity: -14.0, // metres/second²
  colorSoilA: '#4a3a26',
  colorSoilB: '#33281a',
  colorSoilC: '#241c12',
  colorSoilD: '#1a140d',

  /* --- what the floor does --- */
  crackChance: 0.45, // 0..1 chance a breach also splits the floor
  crackRadius: 0.7, // metres
  crackLife: 5.0, // seconds it lingers
  crackWidth: 0.1, // thickness of the split
  crackIntensity: 0.7,
  colorCrackA: '#1c2411', // the dark of the split
  colorCrackB: '#5f8a2a', // the growth glowing out of it
  dustRadius: 0.85, // metres — the puff of soil around a breach
  dustLife: 1.6, // seconds
  dustIntensity: 0.55,
  colorDustA: '#3a3020',
  colorDustB: '#6f7a4a',

  /* --- the impact --- */
  burstSize: 2.6, // the shell of thrown growth at the impact point, metres
  burstIntensity: 1.1,
  burstChaff: 90, // extra chaff thrown at the impact
  burstSoil: 40, // extra soil thrown at the impact
  impactShake: 0.55,
  shakeDuration: 0.5, // seconds
  impactFlash: 0.1, // screen flash on landing
  rumble: 0.035, // continuous shake while the front travels
  colorBurstA: '#4a6b2a', // shell body
  colorBurstB: '#7fa83a',
  colorBurstC: '#c8e07a', // the filaments and the fresnel rim — this carries it
  colorFlash: '#9ade5a', // the full-screen flash on impact

  /* --- dynamic light --- */
  lightIntensity: 11.0,
  lightRadius: 9.5, // metres
  lightColor: '#8ac04a'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Thornwake.
 *
 * The four controls that carry the character, in the order worth reaching for:
 * `vineReach` (how local the weave is — the difference between a tangle and a
 * cat's cradle), `clumping` (how tightly the thorns crowd, which the vines then
 * follow), `vineSlack` against `vineCinch` (whether the weave hangs or snaps
 * taut), and `thornCurve` (whether the field is a bed of nails or a bramble).
 *
 * Everything in *The thorn's shape* rebuilds three instanced meshes when it
 * moves. That is deliberate and it is cheap; see the block's header.
 */
export const thornwakeSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 120, 0.5, 'growth speed'],
    ['lifetime', 0.1, 8, 0.05, 'standing time'],
    ['fadeTime', 0.1, 6, 0.05, 'wither time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The bramble bed': [
    ['thorns', 1, 96, 1, 'thorns'],
    ['clusterShare', 0, 0.6, 0.01, 'knot share'],
    ['clusterRadius', 0.1, 6, 0.05, 'knot radius'],
    ['riseStagger', 0, 1.5, 0.01, 'eruption stagger'],
    ['frontBias', 0.2, 3, 0.01, 'front crowding'],
    ['widthNear', 0.05, 4, 0.05, 'width at caster'],
    ['width', 0.1, 8, 0.05, 'width at target'],
    ['widthCurve', 0.2, 4, 0.01, 'width curve'],
    ['clumping', 0.2, 4, 0.01, 'clumping'],
    ['scatter', 0, 2, 0.01, 'lateral scatter']
  ],
  'The silhouette': [
    ['heightNear', 0.05, 4, 0.05, 'height at caster'],
    ['height', 0.1, 6, 0.05, 'height at target'],
    ['heightCurve', 0.2, 4, 0.01, 'height curve'],
    ['heightJitter', 0, 1.5, 0.01, 'height jitter'],
    ['crown', 0, 1, 0.01, 'flank shortening'],
    ['crownPower', 0.2, 4, 0.01, 'dome falloff'],
    ['peak', 0.5, 3, 0.01, 'swell at target'],
    ['peakWidth', 0.02, 1, 0.01, 'swell width'],
    ['rubble', 0, 1, 0.01, 'sprawling shoots'],
    ['rubbleScale', 0.05, 1, 0.01, 'shoot height'],
    ['rubbleSpread', 0.5, 3, 0.01, 'shoot spread'],
    ['radiusNear', 0.02, 0.8, 0.005, 'thorn radius, near'],
    ['radius2', 0.02, 0.8, 0.005, 'thorn radius, far'],
    ['radiusCurve', 0.1, 3, 0.01, 'radius curve'],
    ['radiusJitter', 0, 1.5, 0.01, 'radius jitter']
  ],
  'How they lean': [
    ['lean', 0, 1.5, 0.01, 'lean'],
    ['leanJitter', 0, 1.5, 0.01, 'lean jitter'],
    ['leanRamp', 0, 1, 0.01, 'lean ramp'],
    ['leanForward', -1, 2, 0.01, 'lean downrange'],
    ['leanOutward', -1, 2, 0.01, 'lean outward'],
    ['twist', 0, 1, 0.01, 'random yaw'],
    ['tilt', 0, 1, 0.01, 'random tip']
  ],
  'The eruption': [
    ['riseTime', 0.02, 1.5, 0.01, 'rise time'],
    ['riseOvershoot', 0, 1.5, 0.01, 'overshoot'],
    ['settle', 0.05, 2, 0.01, 'settle time'],
    ['springRate', 2, 40, 0.5, 'spring rate'],
    ['emergeSink', 0, 1.5, 0.01, 'buried depth'],
    ['birthScale', 0.1, 1, 0.01, 'birth scale'],
    ['birthFade', 0.02, 1.5, 0.01, 'sap flash time'],
    ['breachAt', 0.02, 1, 0.01, 'breach point'],
    ['sinkDepth', 0, 3, 0.05, 'wither sink']
  ],
  "The thorn's shape": [
    ['thornSides', 3, 8, 1, 'faces'],
    ['thornTaper', 0.6, 5, 0.05, 'taper'],
    ['thornCurve', 0, 1.2, 0.01, 'sweep'],
    ['thornBarbs', 0, 5, 1, 'barbs'],
    ['thornBarbLength', 0.02, 0.5, 0.005, 'barb length'],
    ['thornBarbTilt', -1, 1, 0.01, 'barb tilt'],
    ['thornBarbSpread', 0, 1, 0.01, 'barb scatter'],
    ['thornRough', 0, 1, 0.01, 'roughness']
  ],
  Bark: [
    ['colorBark', 'bark'],
    ['colorHeart', 'heartwood'],
    ['colorMoss', 'mottle'],
    ['colorTip', 'thorn tip'],
    ['colorSap', 'sap flash'],
    ['barkGrain', 0, 1.5, 0.01, 'grain depth'],
    ['barkGrainScale', 0.5, 20, 0.1, 'grain / metre'],
    ['mossAmount', 0, 1, 0.01, 'mottle amount'],
    ['mossScale', 0.2, 10, 0.05, 'mottle scale'],
    ['barkRough', 0.05, 1, 0.01, 'surface roughness'],
    ['tipStart', 0.1, 1, 0.01, 'highlight start'],
    ['tipSharp', 0.2, 6, 0.05, 'highlight sharpness'],
    ['tipGlow', 0, 6, 0.05, 'tip glow'],
    ['barbEdge', 0, 0.3, 0.005, 'barb edge margin'],
    ['barbSpan', 0.005, 0.3, 0.005, 'barb edge feather'],
    ['sapGlow', 0, 8, 0.05, 'sap glow'],
    ['barkGlow', 0, 4, 0.01, 'bark glow'],
    ['barkOpacity', 0.1, 1, 0.01, 'bark opacity']
  ],
  'The weave': [
    ['vines', 0, 12, 1, 'vines'],
    ['vineStrands', 1, 4, 1, 'strands / vine'],
    ['vineReach', 1, 12, 1, 'neighbour reach'],
    ['vineMaxSpan', 0.5, 14, 0.1, 'max span'],
    ['vineGripLow', 0, 1.2, 0.01, 'grip, low end'],
    ['vineGripHigh', 0, 1.2, 0.01, 'grip, high end'],
    ['vineBirth', 0, 1, 0.01, 'thread threshold'],
    ['vineGrow', 0.02, 2, 0.01, 'draw-in time'],
    ['vineSlack', 0, 4, 0.01, 'slack droop'],
    ['vineCurve', 0.01, 5, 0.01, 'catenary curve'],
    ['vineSwing', 0, 1, 0.005, 'sway'],
    ['vineSwingSpeed', 0, 8, 0.05, 'sway speed'],
    ['vineTaut', 0, 1, 0.01, 'tension, growing'],
    ['vineCinch', 0, 1, 0.01, 'tension, cinched'],
    ['cinchTime', 0.02, 3, 0.01, 'cinch time'],
    ['vineSpread', 0, 0.6, 0.005, 'strand spacing'],
    ['vineFloor', -1, 1, 0.01, 'floor clamp'],
    ['vineGroundDamp', 0, 1, 0.01, 'kink ground damp']
  ],
  'The weave/Drawing': [
    ['vineWidth', 0.002, 0.2, 0.001, 'width'],
    ['vineGlowWidth', 1, 20, 0.1, 'halo width'],
    ['vineGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['vineKink', 0, 2, 0.01, 'kink amplitude'],
    ['vineKinkScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['vineOctaves', 1, 5, 1, 'octaves'],
    ['vineKinkFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['vineCrawl', -8, 8, 0.05, 'kink crawl'],
    ['vinePinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['vineRestrike', 0.2, 30, 0.1, 'reshapes / sec'],
    ['vineFlicker', 0, 1, 0.01, 'brightness stutter'],
    ['vineFlickerSpeed', 1, 60, 0.5, 'stutter rate'],
    ['vineStrandFlash', 0, 1, 0.01, 'strand blink'],
    ['vineCoreSharp', 0.5, 10, 0.05, 'core sharpness'],
    ['vineGlowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['vineSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['vineOpacity', 0, 2, 0.01, 'opacity'],
    ['vineGlow', 0, 5, 0.01, 'glow'],
    ['vineEndFade', 0, 1, 0.01, 'end fade'],
    ['vineEndTaper', 0, 1, 0.01, 'end taper'],
    ['vineTipLength', 0.005, 0.5, 0.005, 'growing front length'],
    ['vineTipGlow', 0, 4, 0.05, 'growing front glow'],
    ['colorVineCore', 'vine core'],
    ['colorVineInner', 'vine inner'],
    ['colorVineOuter', 'vine outer'],
    ['colorVineHalo', 'vine halo']
  ],
  'Chaff & spores': [
    ['chaffRate', 0, 400, 1, 'chaff rate'],
    ['chaffBreach', 0, 60, 1, 'chaff / breach'],
    ['chaffSize', 0.005, 0.6, 0.005, 'chaff size'],
    ['chaffSpeed', 0, 15, 0.05, 'chaff speed'],
    ['chaffLifetime', 0.1, 6, 0.05, 'chaff lifetime'],
    ['chaffGravity', -20, 2, 0.1, 'chaff gravity'],
    ['chaffSpin', 0, 20, 0.1, 'chaff tumble'],
    ['moteRate', 0, 300, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 8, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -2, 5, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['colorChaff*', 'Chaff colour'],
    ['colorMote*', 'Mote colour']
  ],
  'Soil & floor': [
    ['soilBreach', 0, 40, 1, 'soil / breach'],
    ['soilSize', 0.005, 0.4, 0.005, 'soil size'],
    ['soilSpeed', 0, 15, 0.05, 'soil speed'],
    ['soilLifetime', 0.1, 4, 0.05, 'soil lifetime'],
    ['soilGravity', -40, 0, 0.1, 'soil gravity'],
    ['crackChance', 0, 1, 0.01, 'crack chance'],
    ['crackRadius', 0.05, 4, 0.05, 'crack radius'],
    ['crackLife', 0.2, 15, 0.1, 'crack lifetime'],
    ['crackWidth', 0.01, 0.6, 0.005, 'crack width'],
    ['crackIntensity', 0, 3, 0.01, 'crack intensity'],
    ['dustRadius', 0.05, 4, 0.05, 'dust radius'],
    ['dustLife', 0.1, 6, 0.05, 'dust lifetime'],
    ['dustIntensity', 0, 3, 0.01, 'dust intensity'],
    ['colorCrackA', 'crack dark'],
    ['colorCrackB', 'crack growth'],
    ['colorDustA', 'dust body'],
    ['colorDustB', 'dust rim'],
    ['colorSoil*', 'Soil colour']
  ],
  Impact: [
    ['burstSize', 0.2, 12, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['burstChaff', 0, 400, 1, 'burst chaff'],
    ['burstSoil', 0, 300, 1, 'burst soil'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst filaments'],
    ['colorFlash', 'impact flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
