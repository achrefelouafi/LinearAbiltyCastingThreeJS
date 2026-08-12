/* ================================================================== */
/* PISTON DRIVE — forge                                                */
/* ================================================================== */
/**
 * A battery of machined hydraulic pistons bolted into the floor along the
 * aimed line. They dwell. They slam. They dwell at the top, ring once, and
 * drop. The whole row runs off one shaft, and each station is keyed a little
 * further round it, so the strike travels down the lane as a wave.
 *
 * ## The cam curve is the ability, and it lives in this block
 *
 * "The cam" here is not a metaphor for an easing function. It is a real
 * dwell–rise–dwell–return cam specified the way a cam is actually specified:
 * as **four angular shares of one shaft turn**, plus a motion law for each of
 * the two moving segments.
 *
 * ```
 *   lift
 *    1 |            ╭────────────╮
 *      |           ╱              ╲
 *      |          ╱                ╲
 *    0 |─────────╯                  ╰──────
 *      └──────────┬──┬──────────────┬──┬───→  shaft angle, one full turn
 *         camLow  camRise   camHigh   camFall
 * ```
 *
 * The four shares are **normalised at use**, not here, so each one is an
 * independent slider: pushing `camRise` up shortens everything else
 * proportionally rather than forcing you to rebalance the other three by hand.
 * Ship values give a 6% rise — about 22° of shaft — which is what makes it a
 * *snap* rather than a lift, and that ratio is the single number to reach for
 * if the row starts reading as rising rock.
 *
 * `camSnap` and `camDrop` choose the motion law inside the rise and the return.
 * Both blend between two textbook cam laws, and both satisfy the boundary
 * conditions a real follower needs (zero velocity at each end, so the follower
 * never leaves the cam):
 *
 *  - **cycloidal**, `s = τ − sin(2πτ)/2π` — the jerk-free one. At 0 you get a
 *    high-speed cam that would not shake a machine apart, and a piston that
 *    looks like it is being politely raised.
 *  - **constant acceleration**, the parabolic law — hard, with an acceleration
 *    step at the midpoint you can genuinely see. At 1 the row hits.
 *
 * `camRing` is what happens *after* the rise: a real follower on a return
 * spring overshoots and rings, and it rings in **seconds** rather than in
 * shaft angle, which is why it has its own rate and decay rather than being
 * folded into `camHigh`.
 *
 * ## What is a metre and what is not
 *
 * `pistonHeight`, `stroke`, `railOffset` and everything in "The ports" are
 * metres and are resolved every frame. Everything in "The piston's shape" is a
 * **proportion of the piston's own height** — `HardSurface` shapes carry no
 * metres at all — and moves real geometry through a `ShapeCache`. And
 * everything in "The cam curve" is either a fraction of a turn or a
 * dimensionless law parameter, which is why dragging any of it re-poses a row
 * that is already standing, with the clock stopped.
 */
export const pistondrive = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 26.0, // how fast the arming front runs down the line, metres/second
  lifetime: 2.8, // seconds the battery keeps cycling once the front has arrived
  fadeTime: 0.9, // seconds the row takes to withdraw
  cooldown: 1.3,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the battery --- */
  pistonCount: 12, // stations along the line (capped at 16)
  pistonHeight: 1.55, // metres, base to crown, of one piston
  stroke: 1.15, // metres the crown stands proud of the floor at full lift
  railOffset: 0.62, // metres either side of the cast line — the two rails
  pistonSplay: 0.1, // radians each rail leans outward
  pistonYaw: 0.0, // radians of fixed yaw on every station
  sizeJitter: 0.06, // ±fraction of the height; a machine is nearly, not quite, uniform
  armFeather: 0.05, // fraction of the line a station takes to come live
  pistonShadow: true, // do the pistons cast real shadows

  /* --- the piston's shape (proportions of its own height) --- */
  pistonLength: 2.45, // × head diameter, base to crown — the dominant dimension
  pistonSegments: 22, // facets round the axis
  baseRadius: 0.47, // fractions of the head diameter throughout
  baseHeight: 0.17,
  baseChamfer: 0.05,
  rodRadius: 0.18,
  collarAt: 0.44, // 0..1 up the length
  collarRadius: 0.31,
  collarHeight: 0.14,
  collarChamfer: 0.045,
  headAt: 0.68, // 0..1 up the length, where the head begins
  headRadius: 0.5,
  headChamfer: 0.07,
  rings: 3, // machined grooves round the head — the detail that says "engine"
  ringDepth: 0.035,
  ringHeight: 0.05,
  faceRecess: 0.06, // dished crown; 0 for a flat punch
  pistonCrease: 26.0, // degrees; above this a joint shades hard and counts as an edge

  /* --- the cam curve: four control points and two motion laws --- */
  camRate: 1.15, // shaft turns per second — one full cycle every 0.87 s
  camPhase: 0.0, // turns of offset on the whole shaft
  camStagger: 0.085, // turns each station is keyed behind the one before it
  camLow: 0.4, // share of one turn spent dwelling down
  /**
   * ... rising, and THIS is the snap.
   *
   * At the ship values it is 47° of shaft and 0.113 s, which puts a 1.15 m
   * stroke through about seven frames at 60 fps. That number was arrived at
   * from the other end: 0.06 (22°, 44 ms, under three frames) is more
   * faithful to a real pneumatic ram and on screen the piston simply *is*
   * somewhere else — there is no motion blur here, so a genuine snap with
   * nothing between the endpoints reads as a pop-in rather than as force.
   * Seven frames is the fewest that still reads as travel.
   */
  camRise: 0.13,
  camHigh: 0.29, // ... dwelling at the top
  camFall: 0.18, // ... returning
  camSnap: 0.88, // 0 cycloidal (jerk-free), 1 constant acceleration (hard)
  camDrop: 0.6, // the same blend for the return
  camRing: 0.11, // fraction of the stroke the follower overshoots by
  camRingRate: 7.5, // ring frequency, hertz
  camRingDecay: 9.0, // ring decay, 1/seconds
  strikeAt: 0.55, // lift above which a station counts as having struck

  /* --- the steel --- */
  colorMetal: '#98a0a8', // clean steel
  colorDeep: '#363b41', // the bottom of a pit
  colorScale: '#282420', // mill scale, the blue-black oxide off the forge
  colorPolish: '#e9f0f8', // a worn edge, where the guide has been
  colorSpec: '#fff0da', // the anisotropic highlight's own colour
  steelRough: 0.31,
  steelMetalness: 0.94,
  steelEnv: 1.0,
  brushAniso: 0.84, // 0 round highlight, 1 fully smeared along the grain
  brushSpecular: 1.7, // gain on the anisotropic lobe
  brushGrain: 0.58, // how hard the brushing cuts into roughness
  brushGrainScale: 110.0, // grain frequency, cycles per unit of local space
  brushGrainStretch: 30.0, // how far a streak runs along the brush direction
  millScale: 0.24,
  millScalePatch: 6.5,
  millScaleSharp: 0.58,
  steelPit: 0.3,
  steelPitScale: 58.0,
  steelWear: 0.78,
  steelWearGrain: 0.36,

  /* --- how hot a station runs --- */
  /**
   * The row's heat is **per station**, carried on the `aHeat` instanced
   * attribute the `HardSurface` material reads as an *offset* on `uHeat`. It
   * is derived from the cam rather than from a clock: a station is coldest
   * during its low dwell, comes up across the rise, and bleeds off through the
   * top dwell on a real exponential in seconds. Nothing is remembered between
   * frames, which is why dragging `camRate` while paused re-heats the whole
   * battery in the right pattern rather than the last one.
   */
  pistonHeatIdle: 0.1, // 0..1 heat a station carries at rest
  pistonHeatDrive: 0.4, // 0..1 extra heat at the moment of the strike
  heatBleed: 2.6, // 1/seconds the strike heat decays at
  heatCold: 300.0, // kelvin at heat = 0 — a cold workshop
  heatHot: 2000.0, // kelvin at heat = 1
  heatRef: 1250.0, // kelvin at which the emission term reaches 1
  heatExponent: 4.0, // Stefan-Boltzmann; 4 is the physical value
  heatGlow: 2.3, // gain on the emission
  heatTint: 0.78, // how far the albedo washes toward the hot colour
  heatEdge: 0.24, // how much cooler an edge reads

  /* --- the deck plate each station comes up through --- */
  deckSize: 1.05, // metres across
  deckLift: 0.04, // metres the seated plate sits below the floor line — a recess
  deckWidth: 1.0, // the two in-plane extents, relative to each other
  deckDepth: 0.86,
  deckThickness: 0.1, // unit lengths
  deckCorner: 0.13, // fraction of the short side, corner radius
  deckBevel: 0.03, // unit lengths, 45° break round the whole outline
  deckBolts: 4, // 0, 2, 4 or 6 — laid out on the corners
  deckBoltRadius: 0.06, // fraction of the short side
  deckBoltInset: 0.17, // fraction of the short side, in from each corner
  deckSink: 0.032, // fraction of the short side, countersink flare
  colorDeckMetal: '#7d848c',
  colorDeckDeep: '#2c3035',
  colorDeckScale: '#221f1c',
  colorDeckPolish: '#cfd8e2',
  colorDeckSpec: '#ffeed6',
  deckRough: 0.44,
  deckMetalness: 0.88,
  deckScale: 0.44, // mill scale coverage on the deck, 0..1
  deckPit: 0.46,
  deckHeat: 0.04, // 0..1 — a deck plate does not glow, and this says so

  /* --- the ports in the floor (GroundField, POCK) --- */
  portHeight: 0.015, // metres the quad floats above the floor
  portDepth: 0.2, // metres of bowl round a port
  portLift: 0.09, // metres the lip stands proud
  portRim: 0.16, // metres the lip spreads over
  portGrain: 0.5, // 0..1 fine grain in the bowl
  portDig: 3.5, // how fast a port opens once it is posted, 1/seconds
  portLife: 9.0, // seconds a port weathers away over
  portRadius: 0.72, // metres, radius of a full-strength port
  portEdge: 0.6, // metres of feather on the field's own front
  portRelief: 0.85, // how hard the height field tilts the fake normal
  portNormalStep: 0.05, // metres between the height taps
  portAmbient: 0.3, // floor on the diffuse term
  portWrap: 0.45, // 0..1 wraps the terminator round the back
  portSpecular: 0.5,
  portGloss: 24.0, // Blinn exponent
  portParallax: 0.2, // metres of view-driven offset on the interior
  portEmissive: 1.4, // multiplier on the glowing term
  portOpacity: 1.0,
  portDepthFade: 0.5, // metres of soft fade against standing geometry
  colorPortBase: '#6e675e', // the stone round the port
  colorPortEdge: '#b4a998', // the lip
  colorPortGlow: '#ff9a3c', // heat still in a fresh port
  colorPortDeep: '#141210', // the bowl

  /* --- what a strike throws --- */
  strikeDust: 9, // smoke puffs per strike
  strikeChips: 7, // chips per strike
  strikeSparks: 12, // sparks sheared off the port lip per strike
  ventRate: 26.0, // continuous dust off the whole battery, particles/second
  dustSize: 0.7,
  dustSpeed: 2.4,
  dustLifetime: 1.8,
  dustOpacity: 0.13,
  dustRise: 0.85,
  colorDustA: '#7a7168',
  colorDustB: '#5e564e',
  colorDustC: '#413b36',
  colorDustD: '#2a2724',
  chipSize: 0.08,
  chipSpeed: 6.5,
  chipLifetime: 1.2,
  chipGravity: -22.0,
  chipSpin: 14.0, // radians/second of tumble
  colorChipA: '#8b8175',
  colorChipB: '#5c554c',
  colorChipC: '#3e3833',
  colorChipD: '#292522',
  sparkSize: 0.11,
  sparkSpeed: 8.5,
  sparkLifetime: 0.42,
  sparkGravity: -19.0,
  sparkStretch: 0.26,
  sparkGlow: 1.4,
  sparkHeat: 0.88, // 0..1 on the same ramp as the pistons — the tint's temperature
  sparkTemper: 0.8, // 0..1 how far that tint overrules the gradient
  colorSparkA: '#fffaf0',
  colorSparkB: '#ffce8a',
  colorSparkC: '#ff7a24',
  colorSparkD: '#5c1704',

  /* --- the drive, the shake and the light --- */
  strikeShake: 0.16, // per-strike camera kick
  shakeDuration: 0.4,
  strikeFlash: 0.0, // screen flash per strike; 0 by default, twelve of these is a strobe
  colorFlash: '#ffc788',
  castShake: 0.5, // the kick as the battery seats
  castFlash: 0.1,
  colorCastFlash: '#ffd8a8',
  seatSize: 1.6, // the shell as the battery seats, metres
  seatIntensity: 1.3,
  colorSeatA: '#3d4148',
  colorSeatB: '#ffa447',
  colorSeatC: '#fff0d4',
  rumble: 0.045, // continuous shake while the battery is cycling
  lightIntensity: 15.0,
  lightRadius: 12.0,
  lightColor: '#ff9d4c',
  lightPulse: 0.35, // how far the light drops between strikes
  lightPulseRate: 2.0 // pulses/second, nominally the shaft rate
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Piston Drive.
 *
 * Open **The cam curve** first and nothing else. Those seven controls are the
 * ability: `camRise` against `camLow`/`camHigh` decides whether this is a
 * machine or a hillside, `camSnap` decides how hard the hit lands inside that,
 * `camStagger` turns the row from a chorus into a wave, and `camRing` is the
 * difference between a piston that stops and a piston that *arrives*.
 *
 * Two combinations worth trying before touching anything else. Set `camRise`
 * to 0.4 and `camSnap` to 0 — that is the smooth ease the roster warns about,
 * and it is instructive how completely the row stops being machinery. Then set
 * `camStagger` to 0 and watch twelve stations fire as one, which is a
 * different and much less interesting effect.
 */
export const pistondriveSchema = {
  'The cast': [
    ['range', 3, 50, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 2, 120, 0.5, 'arming speed'],
    ['lifetime', 0.1, 8, 0.05, 'cycling time'],
    ['fadeTime', 0.05, 4, 0.01, 'withdraw time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The cam curve': [
    ['camRate', 0.05, 8, 0.01, 'shaft turns / sec'],
    ['camPhase', 0, 1, 0.005, 'shaft phase'],
    ['camStagger', -0.5, 0.5, 0.005, 'keying per station'],
    ['camLow', 0, 2, 0.005, 'dwell down'],
    ['camRise', 0.005, 1, 0.005, 'rise (the snap)'],
    ['camHigh', 0, 2, 0.005, 'dwell up'],
    ['camFall', 0.005, 1, 0.005, 'return'],
    ['camSnap', 0, 1, 0.01, 'rise law: soft → hard'],
    ['camDrop', 0, 1, 0.01, 'return law: soft → hard'],
    ['camRing', 0, 0.6, 0.005, 'overshoot'],
    ['camRingRate', 0.5, 30, 0.1, 'ring frequency'],
    ['camRingDecay', 0.5, 40, 0.1, 'ring decay'],
    ['strikeAt', 0.05, 0.95, 0.01, 'strike threshold']
  ],
  'The battery': [
    ['pistonCount', 1, 16, 1, 'stations'],
    ['pistonHeight', 0.3, 5, 0.01, 'piston height'],
    ['stroke', 0.05, 4, 0.01, 'stroke'],
    ['railOffset', 0, 4, 0.01, 'rail offset'],
    ['pistonSplay', -0.8, 0.8, 0.005, 'rail splay'],
    ['pistonYaw', -3.15, 3.15, 0.01, 'yaw'],
    ['sizeJitter', 0, 0.6, 0.005, 'size jitter'],
    ['armFeather', 0.005, 0.4, 0.005, 'arming feather'],
    ['pistonShadow', 'casts shadows']
  ],
  "The piston's shape": [
    ['pistonLength', 1, 5, 0.01, 'length / head Ø'],
    ['pistonSegments', 6, 48, 1, 'facets'],
    ['baseRadius', 0.1, 1, 0.005, 'base radius'],
    ['baseHeight', 0.02, 0.6, 0.005, 'base height'],
    ['baseChamfer', 0.001, 0.2, 0.001, 'base chamfer'],
    ['rodRadius', 0.03, 0.5, 0.005, 'rod radius'],
    ['collarAt', 0.05, 0.95, 0.005, 'collar position'],
    ['collarRadius', 0.05, 0.8, 0.005, 'collar radius'],
    ['collarHeight', 0.01, 0.5, 0.005, 'collar height'],
    ['collarChamfer', 0.001, 0.2, 0.001, 'collar chamfer'],
    ['headAt', 0.1, 0.98, 0.005, 'head start'],
    ['headRadius', 0.1, 0.7, 0.005, 'head radius'],
    ['headChamfer', 0.001, 0.25, 0.001, 'head chamfer'],
    ['rings', 0, 8, 1, 'head grooves'],
    ['ringDepth', 0.002, 0.15, 0.001, 'groove depth'],
    ['ringHeight', 0.005, 0.2, 0.001, 'groove height'],
    ['faceRecess', 0, 0.3, 0.005, 'crown dish'],
    ['pistonCrease', 5, 70, 1, 'crease angle (deg)']
  ],
  'The steel': [
    ['colorMetal', 'clean steel'],
    ['colorDeep', 'pit bottom'],
    ['colorScale', 'mill scale'],
    ['colorPolish', 'worn edge'],
    ['colorSpec', 'highlight'],
    ['steelRough', 0.02, 1, 0.01, 'roughness'],
    ['steelMetalness', 0, 1, 0.01, 'metalness'],
    ['steelEnv', 0, 3, 0.01, 'probe gain'],
    ['brushAniso', 0, 1, 0.01, 'anisotropy'],
    ['brushSpecular', 0, 6, 0.01, 'lobe gain'],
    ['brushGrain', 0, 2, 0.01, 'grain depth'],
    ['brushGrainScale', 5, 400, 1, 'grain frequency'],
    ['brushGrainStretch', 1, 120, 0.5, 'streak length'],
    ['millScale', 0, 1, 0.01, 'scale coverage'],
    ['millScalePatch', 0.5, 30, 0.1, 'scale patch size'],
    ['millScaleSharp', 0, 1, 0.01, 'flake edge'],
    ['steelPit', 0, 1, 0.01, 'pitting'],
    ['steelPitScale', 5, 200, 1, 'pit frequency'],
    ['steelWear', 0, 1, 0.01, 'edge wear'],
    ['steelWearGrain', 0, 1, 0.01, 'wear break-up']
  ],
  Heat: [
    ['pistonHeatIdle', 0, 1, 0.005, 'idle heat'],
    ['pistonHeatDrive', 0, 1, 0.005, 'strike heat'],
    ['heatBleed', 0.1, 20, 0.05, 'heat bleed-off'],
    ['heatCold', 200, 1200, 5, 'cold end (K)'],
    ['heatHot', 800, 3000, 10, 'hot end (K)'],
    ['heatRef', 400, 2500, 10, 'emission reference (K)'],
    ['heatExponent', 1, 6, 0.05, 'emission exponent'],
    ['heatGlow', 0, 8, 0.01, 'emission gain'],
    ['heatTint', 0, 1, 0.01, 'albedo wash'],
    ['heatEdge', 0, 1, 0.01, 'edge cooling']
  ],
  'The deck plates': [
    ['deckSize', 0.1, 4, 0.01, 'plate size'],
    ['deckLift', 0, 0.5, 0.005, 'plate height'],
    ['deckWidth', 0.2, 2, 0.01, 'width'],
    ['deckDepth', 0.1, 2, 0.01, 'depth'],
    ['deckThickness', 0.01, 0.6, 0.005, 'thickness'],
    ['deckCorner', 0.01, 0.5, 0.005, 'corner radius'],
    ['deckBevel', 0.002, 0.2, 0.002, 'bevel'],
    ['deckBolts', 0, 6, 2, 'bolts'],
    ['deckBoltRadius', 0.01, 0.2, 0.002, 'bolt radius'],
    ['deckBoltInset', 0.05, 0.45, 0.005, 'bolt inset'],
    ['deckSink', 0, 0.2, 0.002, 'countersink'],
    ['colorDeckMetal', 'deck metal'],
    ['colorDeckDeep', 'deck pit'],
    ['colorDeckScale', 'deck scale'],
    ['colorDeckPolish', 'deck polish'],
    ['colorDeckSpec', 'deck highlight'],
    ['deckRough', 0.02, 1, 0.01, 'roughness'],
    ['deckMetalness', 0, 1, 0.01, 'metalness'],
    ['deckScale', 0, 1, 0.01, 'scale coverage'],
    ['deckPit', 0, 1, 0.01, 'pitting'],
    ['deckHeat', 0, 1, 0.005, 'heat']
  ],
  'The ports': [
    ['portHeight', 0, 0.3, 0.005, 'quad height'],
    ['portDepth', 0, 1.5, 0.005, 'bowl depth'],
    ['portLift', 0, 0.6, 0.005, 'lip height'],
    ['portRim', 0.01, 0.8, 0.005, 'lip spread'],
    ['portGrain', 0, 1, 0.01, 'grain'],
    ['portDig', 0.2, 20, 0.1, 'open rate'],
    ['portLife', 0.5, 30, 0.1, 'port lifetime'],
    ['portRadius', 0.05, 3, 0.01, 'port radius'],
    ['portEdge', 0.02, 3, 0.01, 'field feather'],
    ['portRelief', 0, 3, 0.01, 'relief'],
    ['portNormalStep', 0.005, 0.4, 0.005, 'normal step'],
    ['portAmbient', 0, 1, 0.01, 'ambient floor'],
    ['portWrap', 0, 1, 0.01, 'terminator wrap'],
    ['portSpecular', 0, 3, 0.01, 'specular'],
    ['portGloss', 1, 120, 1, 'gloss'],
    ['portParallax', 0, 1.5, 0.01, 'parallax'],
    ['portEmissive', 0, 6, 0.01, 'emissive'],
    ['portOpacity', 0, 2, 0.01, 'opacity'],
    ['portDepthFade', 0, 3, 0.01, 'soft intersection'],
    ['colorPortBase', 'stone'],
    ['colorPortEdge', 'lip'],
    ['colorPortGlow', 'heat'],
    ['colorPortDeep', 'bowl']
  ],
  'Dust, chips & sparks': [
    ['strikeDust', 0, 60, 1, 'dust per strike'],
    ['strikeChips', 0, 60, 1, 'chips per strike'],
    ['strikeSparks', 0, 120, 1, 'sparks per strike'],
    ['ventRate', 0, 400, 1, 'continuous dust'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 12, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['chipSize', 0.005, 0.4, 0.005, 'chip size'],
    ['chipSpeed', 0, 25, 0.1, 'chip speed'],
    ['chipLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['chipGravity', -60, 0, 0.1, 'chip gravity'],
    ['chipSpin', 0, 40, 0.5, 'chip tumble'],
    ['sparkSize', 0.005, 0.6, 0.005, 'spark size'],
    ['sparkSpeed', 0, 40, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 3, 0.01, 'spark lifetime'],
    ['sparkGravity', -60, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['sparkGlow', 0, 6, 0.01, 'spark glow'],
    ['sparkHeat', 0, 1, 0.005, 'spark temperature'],
    ['sparkTemper', 0, 1, 0.01, 'blackbody override'],
    ['colorDust*', 'Dust colour'],
    ['colorChip*', 'Chip colour'],
    ['colorSpark*', 'Spark colour']
  ],
  'Drive, shake & light': [
    ['strikeShake', 0, 2, 0.005, 'shake per strike'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration'],
    ['strikeFlash', 0, 1, 0.005, 'flash per strike'],
    ['colorFlash', 'strike flash colour'],
    ['castShake', 0, 3, 0.01, 'seating shake'],
    ['castFlash', 0, 2, 0.01, 'seating flash'],
    ['colorCastFlash', 'seating flash colour'],
    ['seatSize', 0.1, 10, 0.05, 'seating shell'],
    ['seatIntensity', 0, 5, 0.01, 'seating intensity'],
    ['colorSeatA', 'seat shell'],
    ['colorSeatB', 'seat body'],
    ['colorSeatC', 'seat core'],
    ['rumble', 0, 0.5, 0.005, 'drive rumble'],
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'light pulse depth'],
    ['lightPulseRate', 0.1, 20, 0.1, 'light pulse rate'],
    ['lightColor', 'light colour']
  ]
};
