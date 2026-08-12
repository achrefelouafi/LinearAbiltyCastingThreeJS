/* ================================================================== */
/* GEARLOCK — forge · far cast                                         */
/* ================================================================== */
/**
 * A train of machined spur gears winds up out of the floor inside the aimed
 * circle, meshes, spins up, and then **locks** — the whole train seizes at once
 * with a shudder and a sheet of sparks.
 *
 * ## THE TRICK — the teeth actually mesh
 *
 * Every gear's angular rate is `−(z_prev / z) · ω_prev`, and — the half
 * everybody forgets — its absolute *phase* is solved against its neighbour so
 * that a tooth of one is aimed at a gap of the other along the line of centres.
 * Rate alone gives you a train that counter-rotates beautifully and grinds
 * straight through itself. `vfx/HardSurface.js` §6 does the arithmetic; this
 * block supplies the numbers, and the reason none of them is baked at spawn is
 * so that dragging `teethA/B/C` or `moduleFrac` **with the clock stopped**
 * re-teeths, re-spaces and re-phases the standing train in the same frame,
 * still meshed.
 *
 * ## Why the module is a fraction here and metres in the solver
 *
 * A gear's *module* is millimetres of pitch diameter per tooth, and it is the
 * one number that decides whether two gears mesh: same module, and the standard
 * centre distance `m(z₁+z₂)/2` puts their pitch circles exactly in contact.
 * `GearTrain` takes it in metres. This block stores it as a fraction of
 * `zoneRadius` instead, because the aim circle is a promise about how much
 * floor the cast is going to take and a train whose size ignored it would break
 * that promise. The metre is produced inside the update loop, every frame:
 * `module = moduleFrac × zoneRadius`.
 *
 * ## `addendum` appears once and is used twice
 *
 * It is the tooth's height above the pitch circle, in modules, and it goes both
 * into the *profile* (`gearShape`) and into the *spacing* (`GearTrain`). Two
 * sliders here would be two ways to say the same thing and one way to make the
 * teeth miss, so there is one and it feeds both.
 */
export const gearlock = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 46.0, // how fast the front runs out to the circle, metres/second
  zoneRadius: 5.2, // the aimed circle, metres — also the train's own scale
  lifetime: 2.2, // seconds the train runs at speed before it locks
  fadeTime: 1.6, // seconds the seize and the sink-back take
  cooldown: 1.2,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the train --- */
  gearCount: 7, // gears in the chain, 2..12 (GearTrain's capacity)
  teethA: 11, // the three tooth counts the train draws from. THE ratios —
  teethB: 17, //   drag them while paused and the whole train re-meshes
  teethC: 26, //   around the new numbers
  moduleFrac: 0.0165, // module as a fraction of zoneRadius (see the header)
  addendum: 1.0, // × module, tooth height above the pitch circle — profile AND spacing
  bearingSpread: 0.115, // ± turns each link may wander off the previous bearing
  bearingBias: 0.045, // turns added to every link — positive curls the train round
  spin: 2.35, // radians/second of the root gear; negative runs it backwards
  phase: 0.0, // turns of the root gear at the moment it lands
  lift: 0.035, // metres the gears float above the floor

  /* --- the gear profile (unitless proportions; see `gearShape()`) --- */
  pressureAngle: 20.0, // degrees; 20 is the modern standard, 14.5 the old one
  dedendum: 1.25, // × module below the pitch circle — the 0.25 is root clearance
  backlash: 0.045, // 0..1 of the tooth thickness taken off both flanks
  rootFillet: 0.5, // 0..1 of the root gap blended into the flank
  flankSteps: 5, // involute samples per flank; 3 is visibly polygonal
  tipSteps: 2, // arc samples across the tooth tip
  rootSteps: 2, // arc samples along the root circle between teeth
  thickness: 0.2, // face to face, as a fraction of the gear's own diameter
  chamfer: 0.02, // 45° break on both faces, same units — the highlight catcher
  bore: 0.3, // the axle hole, as a fraction of the outer radius
  boreSegments: 26, // facets round the bore
  boreChamfer: 0.014, // countersink on the bore, in unit lengths
  lightenHoles: 5, // lightening holes; 0 for a solid blank
  lightenRadius: 0.13, // one hole's radius, fraction of the outer radius
  lightenRing: 0.58, // the circle they sit on, fraction of the outer radius
  lightenSegments: 14, // facets round one hole
  creaseAngle: 30.0, // degrees; above this a joint shades hard and counts as an edge

  /* --- coming up out of the floor --- */
  riseTime: 0.34, // seconds one gear takes to break the surface
  riseStagger: 0.075, // seconds between one gear starting and the next
  riseDepth: 0.22, // extra metres below the floor a gear starts from

  /* --- the clock --- */
  // Nothing here is integrated. `tau(t)` is a closed-form warp of the ability's
  // own age, so a paused train re-phases under every one of these.
  spinUp: 0.45, // seconds of exponential run-up before the rate is nominal
  seizeTime: 0.34, // seconds the seize takes to bring the rate to zero
  shudder: 0.055, // seconds of clock wobble at the lock — × spin = radians
  shudderRate: 13.0, // wobbles/second
  shudderDecay: 0.4, // seconds the wobble decays over

  /* --- friction heat --- */
  // Written per instance into `aHeat`, so a small gear spinning fast comes up
  // hotter than the big slow one it is driving, off one shared material.
  heatGain: 0.34, // 0..1 heat at the reference rim speed
  heatSpeed: 9.0, // metres/second of rim speed at which `heatGain` is reached
  seizeHeat: 0.42, // extra heat dumped in at the lock
  seizeHeatDecay: 0.9, // seconds that extra heat bleeds off over

  /* --- the steel --- */
  // `hardSurfaceParams()` by name. There is deliberately no hot-colour picker:
  // the blackbody ramp is on the real Planckian locus and nobody gets to place
  // the yellow. See `vfx/HardSurface.js` §7.
  colorMetal: '#96a0aa', // clean steel
  colorDeep: '#363c44', // the bottom of a casting pit
  colorScale: '#2a2622', // mill scale, the blue-black oxide off the forge
  colorPolish: '#e8eef6', // a worn edge, where the file has been
  colorSpec: '#fff2e0', // the anisotropic highlight's own colour
  roughness: 0.34, // base, before grain / pitting / wear
  metalness: 0.95,
  envIntensity: 1.0, // HDR probe gain
  brush: 1, // BrushMode: 0 LINEAR, 1 CIRCUMFERENTIAL, 2 RADIAL — a gear is turned
  anisotropy: 0.82, // 0 round highlight, 1 fully smeared along the grain
  specular: 1.6, // gain on the anisotropic lobe
  grain: 0.6, // how hard the brushing cuts into roughness
  grainScale: 96.0, // grain frequency, cycles per unit of local space
  grainStretch: 30.0, // how far a streak runs along the brush direction
  scale: 0.24, // mill scale coverage, 0..1
  scaleScale: 7.0, // its patch size
  scaleSharp: 0.6, // 0 a smear, 1 a hard flake edge
  pit: 0.3, // casting pits and corrosion
  pitScale: 58.0,
  wear: 0.66, // how bright the machined edges come up
  wearGrain: 0.42, // how much the grain breaks that wear up
  heatCold: 300.0, // kelvin at heat = 0 — a cold workshop
  heatHot: 1500.0, // kelvin at heat = 1 — forging heat; a gear never gets past it
  heatRef: 1250.0, // kelvin at which the emission term reaches 1
  heatExponent: 4.0, // Stefan-Boltzmann; 4 is the physical value
  heatGlow: 2.2, // gain on the emission
  heatTint: 0.8, // how far the albedo washes toward the hot colour
  heatEdge: 0.24, // how much cooler an edge is — thin sections radiate faster

  /* --- the bed plate (GroundField, LATTICE) --- */
  fieldEdge: 0.5, // metres of feather on the front
  fieldRagged: 0.1, // how far the front wanders, fraction of the radius
  fieldRaggedScale: 0.9, // lobes per metre
  fieldWarp: 0.2, // metres of domain warp on those lobes
  fieldRelief: 0.7, // how hard the height field tilts the fake normal
  fieldCell: 0.62, // metres — the lattice pitch
  fieldCellJitter: 0.12, // 0..1; a machined bed is nearly regular
  fieldSeam: 0.045, // metres of gap between cells
  fieldThickness: 0.05, // metres — the rib
  fieldLift: 0.05, // metres the ribs stand proud
  fieldDepth: 0.14, // metres the recesses drop
  fieldSharp: 0.8, // 0..1 — machined, so hard
  fieldDetail: 0.35, // 0..1 fine breakup
  fieldSpeed: 2.6, // cells per second the lattice propagates along its edges
  fieldParallax: 0.25, // metres of view-driven offset on the interior
  fieldOpacity: 0.85,
  fieldEmissive: 1.0, // multiplier on the glowing terms
  colorFieldBase: '#5e6670', // the plate itself
  colorFieldEdge: '#aeb9c4', // rib crowns
  colorFieldGlow: '#ff9c46', // anything emissive — the heat in the recesses
  colorFieldDeep: '#14171b', // the recesses

  /* --- the grind at the tooth contacts --- */
  // At the pitch point the two flanks are in pure rolling and the sliding speed
  // is exactly zero, which is why the jets are struck a little either side of
  // it — see `_grindAt()`.
  slideOffset: 0.42, // metres along the common tangent from the pitch point
  slideRef: 7.0, // metres/second of sliding at which the sparks run flat out
  grindLift: 0.06, // metres the jets start off the surface
  grindBounce: 0.45, // 0..1 of the into-surface velocity that comes back out
  grindRise: 0.38, // 0..1 extra tilt away from the floor — the rooster tail
  grindSpeedGain: 0.5, // spark speed as a fraction of the sliding speed
  grindSpeedFloor: 1.4, // metres/second, so a stalled train still ticks over
  grindSpeedCeiling: 22.0, // metres/second
  grindFan: 0.7, // radians the jets fan through, in the tangent/normal plane
  grindSwing: 0.24, // radians of fan across it
  grindGraze: 0.05, // sine of the shallowest angle a jet may leave at
  grindJets: 4, // sub-directions per contact per frame
  grindSpread: 0.11, // handed to the particle system, per jet
  grindVariance: 0.5, // ditto
  grindDrift: 0.14, // fraction of the sliding velocity added as `inherit`

  /* --- sparks, swarf and dust --- */
  /**
   * Four-stop lifetime gradients, `A` at birth through `D` as the particle
   * dies. Spelled out rather than derived from the steel, because a spark is a
   * burning chip of iron and cools on its own schedule.
   */
  sparkRate: 260, // sparks/second at `slideRef` sliding speed
  sparkSize: 0.13,
  sparkLifetime: 0.5,
  sparkGravity: -15.0,
  sparkStretch: 0.22, // how far a spark smears along its velocity
  colorSparkA: '#fff6e2',
  colorSparkB: '#ffc44a',
  colorSparkC: '#ff7a22',
  colorSparkD: '#5d1a05',
  swarfRate: 34, // machined chips spat out of the mesh, particles/second
  swarfSize: 0.05,
  swarfSpeed: 4.4,
  swarfLifetime: 1.3,
  swarfGravity: -19.0,
  colorSwarfA: '#c9b49a',
  colorSwarfB: '#8a7a68',
  colorSwarfC: '#4a443e',
  colorSwarfD: '#2a2724',
  dustRate: 46, // floor dust as a gear breaks the surface, particles/second
  dustSize: 0.9,
  dustSpeed: 1.2,
  dustLifetime: 2.0,
  dustOpacity: 0.16,
  dustRise: 0.5, // upward drift, metres/second
  dustTurbulence: 0.6,
  colorDustA: '#8d8478',
  colorDustB: '#6e675d',
  colorDustC: '#4c473f',
  colorDustD: '#2c2925',

  /* --- the lock --- */
  lockSparks: 320, // extra sparks thrown at every contact when it seizes
  lockShake: 0.85,
  shakeDuration: 0.6,
  lockFlash: 0.14, // full-screen flash on the seize
  colorFlash: '#ffcf9a',
  burstSize: 2.1, // the pressure shell at the seize, metres
  burstIntensity: 1.2,
  colorBurstA: '#6a4a34',
  colorBurstB: '#ffae5c',
  colorBurstC: '#fff0d2',
  rumble: 0.035, // continuous shake while the train is running

  /* --- dynamic light --- */
  lightIntensity: 12.0,
  lightRadius: 13.0,
  lightColor: '#ff9a4e' // warm workshop light off the hot mesh points
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Gearlock.
 *
 * Reach for **`teethA/B/C`** and **`moduleFrac`** first, with the clock stopped
 * — they are the ability. Every other folder dresses a train that is already
 * correct; those four decide whether it is a train at all, and watching the
 * whole thing re-space and re-phase around a new ratio while nothing is moving
 * is the demonstration this slot exists to give.
 *
 * If a tooth ever appears to pass through its neighbour, it is one of exactly
 * two things and never anything else: `addendum` disagreeing with itself (it
 * cannot — there is one slider, which is the point), or `dedendum` wound so far
 * down that the root circle has eaten the flank, which `gearRadii()` clamps but
 * cannot make pretty. Everything else is spacing, and spacing comes from the
 * pitch radii, which come from the module.
 */
export const gearlockSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'front speed'],
    ['zoneRadius', 1.5, 14, 0.1, 'footprint radius'],
    ['lifetime', 0.2, 8, 0.05, 'run time'],
    ['fadeTime', 0.2, 6, 0.05, 'seize + sink'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The train (the ratios)': [
    ['gearCount', 2, 12, 1, 'gears'],
    ['teethA', 6, 40, 1, 'tooth count A'],
    ['teethB', 6, 40, 1, 'tooth count B'],
    ['teethC', 6, 40, 1, 'tooth count C'],
    ['moduleFrac', 0.004, 0.06, 0.0005, 'module ÷ radius'],
    ['addendum', 0.4, 1.6, 0.01, 'addendum ×module'],
    ['bearingSpread', 0, 0.4, 0.005, 'bearing wander (turns)'],
    ['bearingBias', -0.25, 0.25, 0.005, 'bearing bias (turns)'],
    ['spin', -8, 8, 0.01, 'root spin (rad/s)'],
    ['phase', 0, 1, 0.005, 'root phase (turns)'],
    ['lift', 0, 0.4, 0.005, 'float above floor (m)']
  ],
  'The gear profile': [
    ['pressureAngle', 8, 32, 0.5, 'pressure angle (°)'],
    ['dedendum', 0.6, 2, 0.01, 'dedendum ×module'],
    ['backlash', 0, 0.3, 0.005, 'backlash'],
    ['rootFillet', 0, 1, 0.01, 'root fillet'],
    ['flankSteps', 2, 10, 1, 'flank samples'],
    ['tipSteps', 1, 6, 1, 'tip samples'],
    ['rootSteps', 1, 6, 1, 'root samples'],
    ['thickness', 0.05, 0.6, 0.005, 'face width ÷diameter'],
    ['chamfer', 0, 0.06, 0.001, 'face chamfer'],
    ['bore', 0, 0.6, 0.005, 'bore ÷radius'],
    ['boreSegments', 8, 48, 1, 'bore facets'],
    ['boreChamfer', 0, 0.05, 0.001, 'bore countersink'],
    ['lightenHoles', 0, 8, 1, 'lightening holes'],
    ['lightenRadius', 0.02, 0.3, 0.005, 'hole radius ÷radius'],
    ['lightenRing', 0.2, 0.85, 0.005, 'hole circle ÷radius'],
    ['lightenSegments', 6, 32, 1, 'hole facets'],
    ['creaseAngle', 5, 80, 1, 'crease angle (°)']
  ],
  'Coming up out of the floor': [
    ['riseTime', 0.05, 2, 0.01, 'rise time (s)'],
    ['riseStagger', 0, 0.6, 0.005, 'stagger (s)'],
    ['riseDepth', 0, 1.5, 0.01, 'start depth (m)']
  ],
  'The clock': [
    ['spinUp', 0.02, 3, 0.01, 'run-up (s)'],
    ['seizeTime', 0.02, 3, 0.01, 'seize (s)'],
    ['shudder', 0, 0.4, 0.001, 'clock shudder (s)'],
    ['shudderRate', 1, 40, 0.5, 'shudder rate (Hz)'],
    ['shudderDecay', 0.05, 3, 0.01, 'shudder decay (s)']
  ],
  'Friction heat': [
    ['heatGain', 0, 1, 0.01, 'heat at ref speed'],
    ['heatSpeed', 0.5, 30, 0.1, 'ref rim speed (m/s)'],
    ['seizeHeat', 0, 1, 0.01, 'heat at the lock'],
    ['seizeHeatDecay', 0.05, 4, 0.01, 'lock heat decay (s)']
  ],
  'The steel': [
    ['colorMetal', 'steel'],
    ['colorDeep', 'pit bottom'],
    ['colorScale', 'mill scale'],
    ['colorPolish', 'worn edge'],
    ['colorSpec', 'highlight'],
    ['roughness', 0.02, 1, 0.005, 'roughness'],
    ['metalness', 0, 1, 0.005, 'metalness'],
    ['envIntensity', 0, 3, 0.01, 'probe gain'],
    ['brush', 0, 2, 1, 'brush mode'],
    ['anisotropy', 0, 1, 0.01, 'anisotropy'],
    ['specular', 0, 6, 0.01, 'specular gain'],
    ['grain', 0, 2, 0.01, 'grain depth'],
    ['grainScale', 4, 300, 1, 'grain frequency'],
    ['grainStretch', 1, 120, 1, 'grain stretch'],
    ['scale', 0, 1, 0.01, 'mill scale'],
    ['scaleScale', 0.5, 30, 0.1, 'scale patch size'],
    ['scaleSharp', 0, 1, 0.01, 'scale edge'],
    ['pit', 0, 1, 0.01, 'pitting'],
    ['pitScale', 4, 200, 1, 'pit frequency'],
    ['wear', 0, 1, 0.01, 'edge wear'],
    ['wearGrain', 0, 1, 0.01, 'wear breakup']
  ],
  'The blackbody ramp': [
    ['heatCold', 200, 900, 5, 'cold (K)'],
    ['heatHot', 900, 2400, 5, 'hot (K)'],
    ['heatRef', 400, 2400, 5, 'emission ref (K)'],
    ['heatExponent', 1, 8, 0.1, 'emission exponent'],
    ['heatGlow', 0, 8, 0.01, 'emission gain'],
    ['heatTint', 0, 1, 0.01, 'albedo wash'],
    ['heatEdge', 0, 1, 0.01, 'edge cooling']
  ],
  'The bed plate': [
    ['fieldEdge', 0.02, 3, 0.01, 'front feather (m)'],
    ['fieldRagged', 0, 1, 0.01, 'front wander'],
    ['fieldRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['fieldWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['fieldRelief', 0, 2, 0.01, 'relief'],
    ['fieldCell', 0.1, 3, 0.01, 'lattice pitch (m)'],
    ['fieldCellJitter', 0, 1, 0.01, 'cell jitter'],
    ['fieldSeam', 0, 0.4, 0.005, 'seam (m)'],
    ['fieldThickness', 0.005, 0.5, 0.005, 'rib width (m)'],
    ['fieldLift', 0, 0.6, 0.005, 'rib height (m)'],
    ['fieldDepth', 0, 1, 0.005, 'recess depth (m)'],
    ['fieldSharp', 0, 1, 0.01, 'edge hardness'],
    ['fieldDetail', 0, 1, 0.01, 'fine detail'],
    ['fieldSpeed', 0, 12, 0.05, 'propagation (cells/s)'],
    ['fieldParallax', 0, 1.5, 0.01, 'parallax (m)'],
    ['fieldOpacity', 0, 1.5, 0.01, 'opacity'],
    ['fieldEmissive', 0, 4, 0.01, 'emissive'],
    ['colorFieldBase', 'plate'],
    ['colorFieldEdge', 'rib crown'],
    ['colorFieldGlow', 'recess glow'],
    ['colorFieldDeep', 'recess']
  ],
  'The grind': [
    ['slideOffset', 0, 2, 0.01, 'offset from pitch point (m)'],
    ['slideRef', 0.5, 30, 0.1, 'ref sliding speed (m/s)'],
    ['grindLift', 0, 0.5, 0.005, 'jet lift (m)'],
    ['grindBounce', 0, 1, 0.01, 'restitution'],
    ['grindRise', 0, 1, 0.01, 'rooster tail'],
    ['grindSpeedGain', 0, 2, 0.01, 'speed ÷ sliding'],
    ['grindSpeedFloor', 0, 10, 0.1, 'speed floor (m/s)'],
    ['grindSpeedCeiling', 1, 60, 0.5, 'speed ceiling (m/s)'],
    ['grindFan', 0, 3, 0.01, 'fan (rad)'],
    ['grindSwing', 0, 2, 0.01, 'swing (rad)'],
    ['grindGraze', 0, 0.6, 0.005, 'grazing floor'],
    ['grindJets', 1, 8, 1, 'jets / contact'],
    ['grindSpread', 0, 1, 0.01, 'jet spread'],
    ['grindVariance', 0, 2, 0.01, 'speed variance'],
    ['grindDrift', 0, 1, 0.01, 'inherited drift']
  ],
  'Sparks, swarf & dust': [
    ['sparkRate', 0, 1200, 1, 'spark rate'],
    ['sparkSize', 0.005, 0.6, 0.005, 'spark size'],
    ['sparkLifetime', 0.05, 3, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['swarfRate', 0, 300, 1, 'swarf rate'],
    ['swarfSize', 0.005, 0.4, 0.005, 'swarf size'],
    ['swarfSpeed', 0, 20, 0.1, 'swarf speed'],
    ['swarfLifetime', 0.1, 5, 0.05, 'swarf lifetime'],
    ['swarfGravity', -50, 0, 0.1, 'swarf gravity'],
    ['dustRate', 0, 400, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 8, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['colorSpark*', 'Spark colour'],
    ['colorSwarf*', 'Swarf colour'],
    ['colorDust*', 'Dust colour']
  ],
  'The lock': [
    ['lockSparks', 0, 900, 1, 'seize sparks'],
    ['lockShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['lockFlash', 0, 2, 0.01, 'screen flash'],
    ['burstSize', 0.1, 10, 0.05, 'shell size'],
    ['burstIntensity', 0, 5, 0.01, 'shell intensity'],
    ['rumble', 0, 0.4, 0.005, 'running rumble'],
    ['colorFlash', 'flash colour'],
    ['colorBurstA', 'shell'],
    ['colorBurstB', 'shell body'],
    ['colorBurstC', 'shell filaments']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
