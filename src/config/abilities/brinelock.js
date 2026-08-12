/* ================================================================== */
/* BRINELOCK — Brinelock                                               */
/* ================================================================== */
/**
 * A lane of brine thrown up in a train of splash crowns, held for a beat, and
 * then stopped dead as glass-clear ice in exactly the silhouette the water had.
 *
 * **The block is arranged around the handover, because the handover is the
 * ability.** Two systems draw the same shape at two different moments:
 * `vfx/LiquidSurface.js` draws it as water while the lane is live, and
 * `vfx/GrowthField.js` draws it as ice once it has locked. Every crown is an
 * analytic wave packet — a gaussian-enveloped cosine riding out at
 * `rippleSpeed`, decaying over `rippleDecay` and thinning over `rippleSpread` —
 * and the *ice* is that same packet, sampled at each blade's own footprint on
 * the frozen frame. So the sliders under **The crowns** are not water sliders.
 * They are the shape of both states at once, and dragging `rippleAmp` on a
 * standing sheet of ice re-carves the ice.
 *
 * Three groups therefore have to be read together:
 *
 *  - **The crowns** decide the silhouette. `rippleWidth` is the thickness of
 *    the ring wall, `rippleLength` the spacing of the ripples inside the
 *    packet, `rippleSpeed` how far out the ring has travelled by the time it
 *    freezes. A crown frozen young is a tight ring of fingers around its
 *    impact; one frozen late is a broad transverse bar across the lane. The
 *    lane ends up with both, because the crowns are laid down as the front
 *    passes and they all freeze on the same frame — which is why the frozen
 *    lane reads as a *record* of the splash rather than as a row of props.
 *  - **The lock** decides when. `stillTime` is the beat before it where the
 *    swell is taken to zero — see the note on `stillTime` — and `glazeTime` is
 *    how long the glaze front takes to sweep the lane.
 *  - **The ice** decides the body. `iceGain` is the one number that can break
 *    the trick: at 1 the fingers reach exactly the height the water reached,
 *    and anything else is a different splash. It is a slider because being able
 *    to see it break is worth more than pretending it cannot.
 *
 * The lane is drawn at full length from the first frame. It has to be: a ripple
 * record inside `LiquidSurface` is a fraction of the *sheet*, so growing the
 * sheet behind the front would slide every standing crown downrange as it grew.
 * The ability keeps its own eight-slot ring of crowns in fractions of the
 * **cast** instead and rewrites the module's slots every frame. See the class
 * comment in `abilities/tide/BrinelockAbility.js`.
 */
export const brinelock = {
  /* --- the cast --- */
  range: 19.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 27.0, // how fast the splash front runs down the lane, metres/second
  lifetime: 2.6, // seconds from arrival to the end of the standing beat
  fadeTime: 2.2, // seconds the ice takes to melt back into the lane
  cooldown: 1.9, // seconds before the slot re-arms
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the lane --------------------------------------------------- */
  laneLength: 1.12, // the sheet's extent, × the cast distance
  laneWidth: 1.75, // half-width of the sheet, metres
  poolHeight: 0.05, // metres the mean plane sits above the floor
  poolOpacity: 0.96, // opacity while the brine is still water
  lockedOpacity: 0.0, // opacity it is taken to once the ice has replaced it
  round: 0.15, // 0 rectangular footprint, 1 elliptical — a lane wants low
  edgeSoft: 0.16, // 0..1 of the field over which the waterline fades
  edgeNoise: 0.45, // 0..1 how ragged that line is
  edgeScale: 1.3, // cycles per metre of the raggedness
  contactFade: 0.28, // metres of soft fade against opaque geometry

  /* --- the swell ---------------------------------------------------- */
  // Short and quick, unlike lava: brine is light, and its swell is a chop. All
  // four go to zero over `stillTime` before the lock, because the swell rides
  // the global clock rather than the ability's and freezing the crowns does not
  // freeze it.
  waveAmpA: 0.055, // metres
  waveAmpB: 0.034,
  waveAmpC: 0.021,
  waveAmpD: 0.013,
  waveLengthA: 3.1, // metres, crest to crest
  waveLengthB: 1.9,
  waveLengthC: 1.15,
  waveLengthD: 0.62,
  waveSpeedA: 1.5, // metres/second
  waveSpeedB: 1.15,
  waveSpeedC: 0.85,
  waveSpeedD: 0.6,
  waveAngleA: 0.2, // radians, bearing in the surface plane
  waveAngleB: 1.25,
  waveAngleC: 2.55,
  waveAngleD: 4.1,
  steepness: 0.55, // 0 sine, 1 Gerstner cusps. Above ~1 the mesh self-folds.
  chop: 0.028, // metres
  chopScale: 2.4, // cycles per metre
  chopSpeed: 0.6, // metres/second the field drifts
  detail: 0.01, // metres — fragment-only; lives entirely in the normal
  detailScale: 9.0, // cycles per metre
  detailSpeed: 1.2, // metres/second

  /* --- the crowns --------------------------------------------------- */
  // The shape of the water AND the shape of the ice. See the header.
  rippleAmp: 0.46, // metres of crown at strength 1 — the height of a finger
  rippleSpeed: 1.7, // metres/second the ring wall travels outward
  rippleLength: 1.05, // metres, crest to crest inside the packet
  rippleWidth: 0.62, // metres of the gaussian envelope — the wall's thickness
  rippleDecay: 3.2, // seconds to 1/e; long, so the first crown survives the lock
  rippleSpread: 3.6, // metres over which it also thins with radius
  crownSpacing: 2.6, // metres of front travel between crowns
  crownWander: 0.55, // 0..1 of the half-width a crown is thrown off the centre line
  crownStrength: 1.0, // multiplier on `rippleAmp` for a running crown
  crownJitter: 0.35, // ± fraction of that strength
  impactCrown: 1.7, // strength multiplier for the crown at the far end

  /* --- the flow field ------------------------------------------------ */
  // No crust here — brine has no skin — so the flow is only read by the foam.
  flowAngle: 0.0, // radians, the bulk drift's bearing
  flowSpeed: 0.55, // metres/second
  flowRadial: 0.35, // metres/second outward at the centre
  flowRadialFall: 4.5, // metres to 1/e
  flowEddy: 0.7, // metres/second of curl-noise swirl
  flowEddyScale: 0.4, // cycles per metre
  flowEddySpeed: 0.25, // Hz the eddies churn
  flowGravity: 2.8, // metres/second per unit of surface slope

  /* --- foam ----------------------------------------------------------- */
  foam: 0.85, // 0..1 master
  foamScale: 6.5, // cycles per metre of the speckle
  foamSharp: 1.3,
  foamCrest: 1.0, // how much a rising crest seeds it
  foamSpeed: 0.75, // how much surface speed seeds it

  /* --- the water's shading -------------------------------------------- */
  poolDepth: 0.35, // metres of liquid under the mean plane
  depthTint: 1.7, // Beer-Lambert density, per metre
  translucency: 1.1, // backlight through the thin parts
  ambient: 0.32,
  specular: 1.6,
  shininess: 90, // Blinn-Phong exponent
  fresnel: 1.25,
  envIntensity: 0.85,
  skyIntensity: 0.5,
  poolGlow: 1.0,
  normalEps: 0.04, // metres — the finite-difference step
  colorDeep: '#062a33', // the body seen through its own thickness
  colorShallow: '#1f8f9c', // the body seen thin
  colorFoam: '#e8fbfa',
  colorSpec: '#ffffff',
  colorSky: '#2f4a5c', // the floor under the reflected probe

  /* --- the lock ------------------------------------------------------- */
  lockDelay: 0.55, // seconds after arrival that the brine stops
  // The swell rides `frame.uTime`, not the ability's clock, so freezing the
  // crowns does not freeze it. Rather than snapping it off on the lock frame —
  // a visible centimetre-scale pop across the whole lane — it is ramped out
  // over this window before the lock, and the brine goes glassy-still first.
  stillTime: 0.3, // seconds the swell takes to die before the lock
  glazeTime: 0.42, // seconds the glaze front takes to sweep the lane
  glazeStagger: 0.1, // seconds of extra per-blade scatter inside that sweep
  waterFade: 0.34, // seconds the water takes to hand over once it has locked

  /* --- the ice -------------------------------------------------------- */
  // Consumed at spawn — `GrowthField.plant()` is the one dice roll a cast
  // makes, and re-planting a standing field mid-cast would re-scatter every
  // finger rather than add one. It is the only number in this block that a
  // paused slider cannot move, and it takes effect on the next cast.
  blades: 168, // fingers of ice in the lane
  iceGain: 1.0, // × the sampled water height. 1 is the trick; anything else is not.
  iceFloor: 0.02, // metres — shortest a finger may be, where the water was in a trough
  bladeSpread: 0.94, // 0..1 of the lane's half-width the fingers are laid across
  bladeSpreadNear: 0.72, // the same at the caster's end
  bladeClumping: 0.9, // >1 pulls them toward the centre line
  bladeScatter: 0.3, // extra lateral jitter, fraction of the local half-width
  bladeFrontBias: 1.0, // <1 crowds fingers toward the far end
  bladeRadius: 0.075, // metres, base radius of a finger at the caster's end
  bladeRadiusTip: 0.062, // metres, the same at the far end
  bladeRadiusCurve: 0.7, // how the radius ramps down the lane
  bladeRadiusJitter: 0.42, // ± fraction
  // Small on purpose: every radian of lean takes a finger's tip off the point
  // the water was standing at, and the whole claim of this ability is that it
  // does not.
  bladeLean: 0.16, // radians away from the centre line
  bladeLeanJitter: 0.5, // ± fraction
  bladeLeanRamp: 0.4, // 0 leans everything equally, 1 only the far end
  bladeLeanForward: 0.25, // weight of "away from the caster" in the lean
  bladeLeanOutward: 0.95, // weight of "out across the lane"
  bladeTwist: 1.0, // 0..1 of a full turn of random yaw
  bladeTilt: 0.07, // radians of extra random tip, any bearing
  riseTime: 0.055, // seconds a finger takes to arrive. Short: it does not grow, it locks.
  riseOvershoot: 0.07, // how far past full height the lock carries
  settle: 0.22, // seconds that overshoot damps out over
  springRate: 26, // radians/second of the overshoot ring
  birthScale: 0.7, // footprint scale at the instant it locks
  birthFade: 0.26, // seconds the freeze flash decays over
  sinkDepth: 0.35, // extra metres a melting finger drops beyond its own height

  /* --- the shape of one finger ---------------------------------------- */
  facets: 9, // sides around the lathe
  rings: 13, // levels up it
  taper: 1.35, // >1 pinches it to a needle, <1 leaves a stump
  waist: 0.34, // 0..1 how far the stalk necks in below the bead
  bead: 0.38, // the droplet caught at the top, × the base radius
  beadAt: 0.82, // 0..1 up the finger where it sits
  beadWidth: 0.15, // 0..1 of the finger's length it spans
  shapeTwist: 0.22, // turns of helical twist from foot to tip
  facetJitter: 0.16, // ± fraction of the radius, per facet — breaks the circle

  /* --- the ice's shading ---------------------------------------------- */
  colorIce: '#c8f6ff', // the clear glass
  colorAerated: '#e6fbff', // the milky, air-filled foot
  colorSeam: '#7fe4e0', // the expansion cracks
  colorIceFlash: '#f2ffff', // the crack of light as a finger locks
  aerate: 0.8, // 0..1 how milky the foot gets
  aeratePower: 2.2, // how fast that clears going up
  iceDepthTint: 0.85, // how much the body deepens across its own axis
  icePipe: 1.7, // brightness looking down a finger's axis
  icePipePower: 3.6, // how sharply that falls off
  iceTranslucency: 0.9, // how much light comes through it
  seamScale: 3.4, // cycles per metre across the crack field
  seamStretch: 3.8, // how many times longer a seam is vertically
  seamWidth: 0.15, // 0..1 of the field — the seam's width
  seamGlow: 1.4,
  iceFresnel: 1.5,
  iceFresnelPower: 2.6,
  iceGlint: 1.15,
  iceGlintScale: 24, // cycles per metre of the pinpoints
  iceGlintSpeed: 0.32, // metres/second they crawl at
  iceGlow: 1.15,
  lockGlow: 3.6, // brightness of the freeze flash
  lockGlowPower: 2.2, // how fast it goes
  iceOpacity: 0.95,
  iceRoughness: 0.08,
  iceEnvIntensity: 1.25,

  /* --- spray: the water in the air while the lane is live -------------- */
  sprayRate: 90, // particles/second along the lane
  sprayPerCrown: 26, // extra, thrown when a crown is punched in
  spraySpeed: 3.4, // metres/second
  spraySize: 0.09,
  sprayLifetime: 0.85, // seconds
  sprayGravity: -7.5, // metres/second²
  sprayTurbulence: 0.4,
  colorSprayA: '#eafeff',
  colorSprayB: '#9fe8f0',
  colorSprayC: '#3f9fb4',
  colorSprayD: '#123c4a',

  /* --- frost: what comes off the ice as it locks ----------------------- */
  frostPerBlade: 1.4, // motes released per finger as it locks
  frostSpeed: 0.75, // metres/second
  frostSize: 0.06,
  frostLifetime: 1.6, // seconds
  frostRise: 0.55, // metres/second² upward
  frostTurbulence: 0.7,
  colorFrostA: '#ffffff',
  colorFrostB: '#c8f4ff',
  colorFrostC: '#5fb8cc',
  colorFrostD: '#183848',

  /* --- shards: the ice coming apart as it melts back ------------------- */
  shardRate: 34, // chips/second while the lane melts
  shardSpeed: 1.9, // metres/second
  shardSize: 0.07,
  shardLifetime: 1.1, // seconds
  shardGravity: -9.0, // metres/second²
  colorShardA: '#e8fdff',
  colorShardB: '#a4e0ea',
  colorShardC: '#4d8fa0',
  colorShardD: '#12303c',

  /* --- feedback --------------------------------------------------------- */
  burstSize: 1.5, // metres, the sheet of spray where the front lands
  burstIntensity: 1.1,
  colorBurstA: '#ffffff',
  colorBurstB: '#8fe4f0',
  colorBurstC: '#155f74',
  shockRadius: 3.4, // metres, the ring that runs out across the floor
  colorShockA: '#d8fbff',
  colorShockB: '#1e7a90',
  brineMarks: 7, // wet stains left outside the waterline
  brineRadius: 1.1, // metres each
  brineLife: 5.5, // seconds
  brineIntensity: 0.75,
  colorBrine: '#0f3440',
  colorBrineEdge: '#63c8cf',
  impactShake: 0.35, // camera punch when the front lands
  lockShake: 0.22, // a second, smaller punch on the frame it freezes
  shakeDuration: 0.45, // seconds either decays over
  rumble: 0.11, // continuous shake while the lane is running
  impactFlash: 0.2,
  colorFlash: '#a8ecf6',
  lockFlash: 0.34,
  colorLockFlash: '#e8ffff',

  /* --- the light -------------------------------------------------------- */
  lightColor: '#4fd4e4',
  lightIntensity: 5.5,
  lightRadius: 13.0, // metres
  lightHeight: 0.9 // metres above the lane the light rides
};

/** Editor layout. See the schema notes at the top of `config/abilities/index.js`. */
export const brinelockSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 120, 0.5, 'front speed'],
    ['lifetime', 0.4, 8, 0.05, 'standing beat'],
    ['fadeTime', 0.2, 8, 0.05, 'melt duration'],
    ['cooldown', 0, 10, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The lane': [
    ['laneLength', 0.8, 1.6, 0.01, 'sheet length × cast'],
    ['laneWidth', 0.4, 6, 0.05, 'sheet half-width'],
    ['poolHeight', 0, 0.6, 0.005, 'surface height'],
    ['poolOpacity', 0, 1, 0.01, 'water opacity'],
    ['lockedOpacity', 0, 1, 0.01, 'opacity once locked'],
    ['round', 0, 1, 0.01, 'elliptical footprint'],
    ['edgeSoft', 0.01, 0.6, 0.005, 'waterline softness'],
    ['edgeNoise', 0, 1, 0.01, 'waterline raggedness'],
    ['edgeScale', 0.1, 5, 0.01, 'raggedness / metre'],
    ['contactFade', 0.02, 2, 0.01, 'soft intersection']
  ],
  'The swell': [
    ['waveAmpA', 0, 0.5, 0.002, 'amp A'],
    ['waveAmpB', 0, 0.5, 0.002, 'amp B'],
    ['waveAmpC', 0, 0.5, 0.002, 'amp C'],
    ['waveAmpD', 0, 0.5, 0.002, 'amp D'],
    ['waveLengthA', 0.3, 12, 0.05, 'length A'],
    ['waveLengthB', 0.3, 12, 0.05, 'length B'],
    ['waveLengthC', 0.3, 12, 0.05, 'length C'],
    ['waveLengthD', 0.3, 12, 0.05, 'length D'],
    ['waveSpeedA', -4, 4, 0.01, 'speed A'],
    ['waveSpeedB', -4, 4, 0.01, 'speed B'],
    ['waveSpeedC', -4, 4, 0.01, 'speed C'],
    ['waveSpeedD', -4, 4, 0.01, 'speed D'],
    ['waveAngleA', 0, 6.29, 0.01, 'bearing A'],
    ['waveAngleB', 0, 6.29, 0.01, 'bearing B'],
    ['waveAngleC', 0, 6.29, 0.01, 'bearing C'],
    ['waveAngleD', 0, 6.29, 0.01, 'bearing D'],
    ['steepness', 0, 1.2, 0.01, 'gerstner steepness'],
    ['chop', 0, 0.3, 0.002, 'chop'],
    ['chopScale', 0.1, 8, 0.01, 'chop / metre'],
    ['chopSpeed', 0, 4, 0.01, 'chop drift'],
    ['detail', 0, 0.1, 0.001, 'normal detail'],
    ['detailScale', 0.5, 24, 0.1, 'detail / metre'],
    ['detailSpeed', 0, 4, 0.01, 'detail drift']
  ],
  'The crowns': [
    ['rippleAmp', 0, 1.5, 0.005, 'crown height'],
    ['rippleSpeed', 0.1, 8, 0.02, 'ring speed'],
    ['rippleLength', 0.1, 4, 0.01, 'wavelength'],
    ['rippleWidth', 0.05, 3, 0.01, 'wall thickness'],
    ['rippleDecay', 0.1, 10, 0.05, 'decay to 1/e'],
    ['rippleSpread', 0.2, 12, 0.05, 'radial thinning'],
    ['crownSpacing', 0.4, 12, 0.05, 'metres between crowns'],
    ['crownWander', 0, 1, 0.01, 'lateral wander'],
    ['crownStrength', 0, 3, 0.01, 'running crown strength'],
    ['crownJitter', 0, 1, 0.01, 'strength jitter'],
    ['impactCrown', 0, 4, 0.01, 'final crown strength']
  ],
  'The flow field': [
    ['flowAngle', 0, 6.29, 0.01, 'drift bearing'],
    ['flowSpeed', 0, 4, 0.01, 'drift speed'],
    ['flowRadial', 0, 4, 0.01, 'outflow at centre'],
    ['flowRadialFall', 0.2, 12, 0.05, 'outflow falloff'],
    ['flowEddy', 0, 4, 0.01, 'eddy speed'],
    ['flowEddyScale', 0.02, 2, 0.01, 'eddies / metre'],
    ['flowEddySpeed', 0, 2, 0.01, 'eddy churn'],
    ['flowGravity', 0, 8, 0.05, 'downhill flow']
  ],
  'Foam': [
    ['foam', 0, 1, 0.01, 'foam'],
    ['foamScale', 0.5, 20, 0.1, 'speckle / metre'],
    ['foamSharp', 0.2, 4, 0.01, 'speckle sharpness'],
    ['foamCrest', 0, 3, 0.01, 'seeded by crests'],
    ['foamSpeed', 0, 3, 0.01, 'seeded by speed']
  ],
  'The water': [
    ['poolDepth', 0, 3, 0.01, 'depth under the plane'],
    ['depthTint', 0, 6, 0.01, 'beer-lambert density'],
    ['translucency', 0, 3, 0.01, 'backlight'],
    ['ambient', 0, 1, 0.01, 'ambient'],
    ['specular', 0, 4, 0.01, 'specular'],
    ['shininess', 4, 256, 1, 'shininess'],
    ['fresnel', 0, 3, 0.01, 'fresnel'],
    ['envIntensity', 0, 3, 0.01, 'probe reflection'],
    ['skyIntensity', 0, 2, 0.01, 'sky floor'],
    ['poolGlow', 0, 3, 0.01, 'water glow'],
    ['normalEps', 0.005, 0.2, 0.001, 'normal step'],
    ['colorDeep', 'deep'],
    ['colorShallow', 'shallow'],
    ['colorFoam', 'foam'],
    ['colorSpec', 'specular'],
    ['colorSky', 'sky floor']
  ],
  'The lock': [
    ['lockDelay', 0.05, 4, 0.01, 'seconds until it freezes'],
    ['stillTime', 0.02, 2, 0.01, 'swell dies over'],
    ['glazeTime', 0.02, 3, 0.01, 'glaze sweep'],
    ['glazeStagger', 0, 1, 0.005, 'per-blade scatter'],
    ['waterFade', 0.02, 3, 0.01, 'water hands over']
  ],
  'The ice/Placement': [
    ['blades', 8, 216, 1, 'fingers'],
    ['iceGain', 0, 2, 0.01, 'height × the water'],
    ['iceFloor', 0.005, 0.4, 0.005, 'shortest finger'],
    ['bladeSpread', 0, 1.4, 0.01, 'lane coverage'],
    ['bladeSpreadNear', 0, 1.4, 0.01, 'coverage at the caster'],
    ['bladeClumping', 0.2, 3, 0.01, 'pull to the centre line'],
    ['bladeScatter', 0, 1.5, 0.01, 'lateral jitter'],
    ['bladeFrontBias', 0.2, 3, 0.01, 'crowd toward the far end']
  ],
  'The ice/Body': [
    ['bladeRadius', 0.01, 0.4, 0.002, 'base radius (near)'],
    ['bladeRadiusTip', 0.01, 0.4, 0.002, 'base radius (far)'],
    ['bladeRadiusCurve', 0.1, 3, 0.01, 'radius ramp'],
    ['bladeRadiusJitter', 0, 1, 0.01, 'radius jitter'],
    ['bladeLean', 0, 1.2, 0.01, 'lean'],
    ['bladeLeanJitter', 0, 1, 0.01, 'lean jitter'],
    ['bladeLeanRamp', 0, 1, 0.01, 'lean ramp'],
    ['bladeLeanForward', 0, 2, 0.01, 'lean downrange'],
    ['bladeLeanOutward', 0, 2, 0.01, 'lean across'],
    ['bladeTwist', 0, 1, 0.01, 'random yaw'],
    ['bladeTilt', 0, 0.6, 0.005, 'random tip']
  ],
  'The ice/The lock beat': [
    ['riseTime', 0.01, 1, 0.005, 'time to arrive'],
    ['riseOvershoot', 0, 1, 0.01, 'overshoot'],
    ['settle', 0.02, 2, 0.01, 'overshoot decay'],
    ['springRate', 2, 60, 0.5, 'overshoot ring'],
    ['birthScale', 0.1, 1, 0.01, 'scale as it locks'],
    ['birthFade', 0.02, 2, 0.01, 'freeze flash decay'],
    ['sinkDepth', 0, 2, 0.01, 'extra melt depth']
  ],
  'The ice/Shape': [
    ['facets', 5, 20, 1, 'sides'],
    ['rings', 4, 24, 1, 'levels'],
    ['taper', 0.3, 4, 0.01, 'taper to the tip'],
    ['waist', 0, 0.9, 0.01, 'neck below the bead'],
    ['bead', 0, 1.2, 0.01, 'droplet size'],
    ['beadAt', 0.2, 1, 0.01, 'droplet height'],
    ['beadWidth', 0.03, 0.6, 0.005, 'droplet spread'],
    ['shapeTwist', 0, 1.5, 0.01, 'helical twist'],
    ['facetJitter', 0, 0.6, 0.005, 'facet jitter']
  ],
  'The ice/Shading': [
    ['colorIce', 'clear glass'],
    ['colorAerated', 'milky foot'],
    ['colorSeam', 'expansion cracks'],
    ['colorIceFlash', 'freeze flash'],
    ['aerate', 0, 1, 0.01, 'aeration'],
    ['aeratePower', 0.2, 6, 0.01, 'aeration falloff'],
    ['iceDepthTint', 0, 3, 0.01, 'cross-axis density'],
    ['icePipe', 0, 4, 0.01, 'down-the-axis glow'],
    ['icePipePower', 0.5, 10, 0.05, 'axis falloff'],
    ['iceTranslucency', 0, 3, 0.01, 'translucency'],
    ['seamScale', 0.2, 12, 0.05, 'seams / metre'],
    ['seamStretch', 0.5, 12, 0.05, 'vertical stretch'],
    ['seamWidth', 0.01, 0.6, 0.005, 'seam width'],
    ['seamGlow', 0, 4, 0.01, 'seam glow'],
    ['iceFresnel', 0, 4, 0.01, 'fresnel'],
    ['iceFresnelPower', 0.5, 8, 0.05, 'fresnel power'],
    ['iceGlint', 0, 4, 0.01, 'glints'],
    ['iceGlintScale', 2, 80, 0.5, 'glints / metre'],
    ['iceGlintSpeed', 0, 3, 0.01, 'glint crawl'],
    ['iceGlow', 0, 4, 0.01, 'ice glow'],
    ['lockGlow', 0, 10, 0.05, 'freeze flash'],
    ['lockGlowPower', 0.5, 10, 0.05, 'flash falloff'],
    ['iceOpacity', 0, 1, 0.01, 'ice opacity'],
    ['iceRoughness', 0, 1, 0.01, 'roughness'],
    ['iceEnvIntensity', 0, 4, 0.01, 'probe reflection']
  ],
  'Spray': [
    ['sprayRate', 0, 400, 1, 'per second'],
    ['sprayPerCrown', 0, 160, 1, 'per crown'],
    ['spraySpeed', 0, 14, 0.05, 'speed'],
    ['spraySize', 0.01, 0.5, 0.005, 'size'],
    ['sprayLifetime', 0.1, 4, 0.02, 'lifetime'],
    ['sprayGravity', -30, 10, 0.1, 'gravity'],
    ['sprayTurbulence', 0, 3, 0.01, 'turbulence'],
    ['colorSpray*', 'Spray gradient']
  ],
  'Frost': [
    ['frostPerBlade', 0, 8, 0.05, 'per finger'],
    ['frostSpeed', 0, 6, 0.05, 'speed'],
    ['frostSize', 0.01, 0.4, 0.005, 'size'],
    ['frostLifetime', 0.1, 6, 0.02, 'lifetime'],
    ['frostRise', -4, 4, 0.05, 'rise'],
    ['frostTurbulence', 0, 3, 0.01, 'turbulence'],
    ['colorFrost*', 'Frost gradient']
  ],
  'Shards': [
    ['shardRate', 0, 200, 1, 'per second'],
    ['shardSpeed', 0, 10, 0.05, 'speed'],
    ['shardSize', 0.01, 0.4, 0.005, 'size'],
    ['shardLifetime', 0.1, 4, 0.02, 'lifetime'],
    ['shardGravity', -30, 5, 0.1, 'gravity'],
    ['colorShard*', 'Shard gradient']
  ],
  'Feedback': [
    ['burstSize', 0.1, 8, 0.05, 'spray sheet'],
    ['burstIntensity', 0, 4, 0.01, 'spray sheet glow'],
    ['colorBurstA', 'burst core'],
    ['colorBurstB', 'burst mid'],
    ['colorBurstC', 'burst rim'],
    ['shockRadius', 0.5, 12, 0.05, 'shock ring'],
    ['colorShockA', 'shock inner'],
    ['colorShockB', 'shock outer'],
    ['brineMarks', 0, 24, 1, 'wet stains'],
    ['brineRadius', 0.1, 5, 0.05, 'stain radius'],
    ['brineLife', 0.5, 20, 0.1, 'stain life'],
    ['brineIntensity', 0, 3, 0.01, 'stain strength'],
    ['colorBrine', 'stain'],
    ['colorBrineEdge', 'stain edge'],
    ['impactShake', 0, 2, 0.01, 'arrival shake'],
    ['lockShake', 0, 2, 0.01, 'freeze shake'],
    ['shakeDuration', 0.05, 2, 0.01, 'shake decay'],
    ['rumble', 0, 1, 0.005, 'running rumble'],
    ['impactFlash', 0, 2, 0.01, 'arrival flash'],
    ['colorFlash', 'arrival flash'],
    ['lockFlash', 0, 2, 0.01, 'freeze flash'],
    ['colorLockFlash', 'freeze flash']
  ],
  'The light': [
    ['lightColor', 'colour'],
    ['lightIntensity', 0, 30, 0.1, 'intensity'],
    ['lightRadius', 1, 40, 0.5, 'radius'],
    ['lightHeight', 0, 6, 0.05, 'height above the lane']
  ]
};
