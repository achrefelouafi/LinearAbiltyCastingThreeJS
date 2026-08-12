/* ================================================================== */
/* SAWLINE — forge                                                     */
/* ================================================================== */
/**
 * A machined circular saw blade drops out of the caster's hand, buries its
 * rim in the floor and runs the length of the aimed line, cutting a kerf and
 * throwing a sheaf of grinding sparks off the contact. At the far end it
 * grinds in place for a moment, hurls a handful of glowing offcuts downrange,
 * and dives out of sight into its own cut.
 *
 * ## What the numbers here are
 *
 * Three different kinds of number live in this block and they behave very
 * differently, so it is worth naming them.
 *
 *  1. **Metres, radians and seconds** — `bladeDiameter`, `bladeBite`,
 *     `bladeSpin`. These are resolved inside the update loop every frame, so
 *     dragging them re-places a blade that is already halfway down the lane.
 *  2. **Shape proportions** — `teeth`, `toothRake`, `bladeArbor` and the rest
 *     of "The blade's teeth". `HardSurface` shapes carry **no metres**: every
 *     field is a fraction of the blade's own diameter, and the geometry is
 *     regenerated (through a `ShapeCache`, only when a number actually moves)
 *     rather than transformed. Drag `teeth` with the clock stopped and the
 *     blade re-teeths in the frame you let go of the slider.
 *  3. **The grind** — the `grind*` group is handed straight to
 *     `GrindContact`, the solver that turns a contact point, a surface normal
 *     and a rim velocity into spark jets. `grindGain`, `grindFloor` and
 *     `grindCeiling` are the only place the sparks' *speed* is authored, and
 *     they are authored as a fraction of the rim speed rather than as an
 *     absolute, because that is the whole point of the slot — see the class
 *     doc in `abilities/forge/SawlineAbility.js`.
 *
 * ## The one sign that matters
 *
 * `bladeSpin` is **signed**, and the sign is not cosmetic. The blade's spin
 * axis is the cast's `side` vector, so a positive rate puts the teeth at the
 * bottom of the blade travelling *downrange* and the spray goes forward with
 * the cut (a climb cut); a negative rate throws the whole sheaf back over the
 * blade, which is the angle-grinder rooster tail everybody recognises. It
 * ships negative.
 */
export const sawline = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 11.0, // how fast the blade tracks down the line, metres/second
  lifetime: 0.7, // seconds it grinds in place at the far end
  fadeTime: 0.75, // seconds it takes to dive out of the cut
  cooldown: 1.1,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the blade, in metres --- */
  bladeDiameter: 1.45, // rim to rim, metres — the only size the blade has
  bladeBite: 0.26, // metres the rim runs below the floor at full depth
  bladeBiteIn: 0.12, // fraction of the line spent sinking to that depth
  /**
   * Radians/second about the cast's side vector. **Signed** — see the header.
   *
   * The magnitude is a compromise with the frame rate rather than with
   * realism. There is no motion blur here, so any rate above about 9 rad/s
   * aliases against a twenty-tooth rim at 60 fps and the teeth strobe, which
   * is exactly what a saw does on video and is not worth fighting. The four
   * *expansion slots* are the feature that has to read, and their pitch is
   * 90°: at 48 rad/s a slot moves 46° a frame, just inside the half-pitch
   * where the eye still resolves which way it is turning. Push this past about
   * 60 and the blade visibly runs backwards.
   */
  bladeSpin: -48.0,
  bladeLean: 0.07, // radians the blade tips forward out of vertical
  bladeWander: 0.11, // metres of lateral drift off the cast line
  bladeWanderScale: 0.34, // drifts per metre of travel
  bladeExit: 2.6, // metres the hub sinks over the fade, taking the blade under the floor
  bladeShadow: true, // does the blade cast a real shadow

  /* --- the blade's teeth (proportions, not metres — see the header) --- */
  teeth: 20, // tooth count
  toothRake: 15.0, // degrees of hook on the cutting face; negative scrapes
  toothClearance: 25.0, // degrees of relief behind the tip
  toothGullet: 0.17, // fraction of the tip radius down to the gullet floor
  toothLand: 0.34, // 0..1 of the tooth pitch spent flat on the tip
  bladeThickness: 0.055, // unit lengths, face to face — a blade is a plate
  bladeChamfer: 0.013, // unit lengths, the bevel that catches the light on the rim
  bladeArbor: 0.15, // bore, as a fraction of the tip radius
  bladeSlots: 4, // expansion slots; 0 for a plain plate
  slotDepth: 0.29, // fraction of the tip radius, inward from the gullet floor
  slotWidth: 0.036, // fraction of the tip radius
  bladeCrease: 30.0, // degrees; above this a joint shades hard and counts as an edge

  /* --- the steel --- */
  /**
   * `HardSurface`'s brushed anisotropic material. The brushing is
   * **circumferential about the blade's own axis**, which for a `SAWBLADE`
   * seated on `HardAxis.X` is local +X — the grain runs round the plate the
   * way a surface grinder leaves it, and the highlight smears across the
   * grain into an arc rather than sitting on the rim as a dot.
   */
  colorMetal: '#9ba3ac', // clean steel
  colorDeep: '#383d43', // the bottom of a pit
  colorScale: '#2a2622', // mill scale, the blue-black oxide off the forge
  colorPolish: '#eef4fb', // a worn edge, where the workpiece has been
  colorSpec: '#fff1dd', // the anisotropic highlight's own colour
  steelRough: 0.29, // base roughness, before grain / pitting / wear
  steelMetalness: 0.95,
  steelEnv: 1.05, // HDR probe gain
  brushAniso: 0.88, // 0 round highlight, 1 fully smeared along the grain
  brushSpecular: 1.9, // gain on the anisotropic lobe
  brushGrain: 0.62, // how hard the brushing cuts into roughness
  brushGrainScale: 130.0, // grain frequency, cycles per unit of local space
  brushGrainStretch: 34.0, // how far a streak runs along the brush direction
  millScale: 0.18, // mill scale coverage, 0..1
  millScalePatch: 7.5, // its patch size
  millScaleSharp: 0.62, // 0 a smear, 1 a hard flake edge
  steelPit: 0.24, // casting pits and corrosion
  steelPitScale: 62.0,
  steelWear: 0.9, // how bright the machined edges come up
  steelWearGrain: 0.34, // how much the grain breaks that wear up

  /* --- how hot the blade gets --- */
  /**
   * One 0..1 heat drives a real Planckian ramp — there is deliberately no
   * `colorHot` picker, because the value of the term is that nobody gets to
   * place the yellow. `bladeHeatIdle` is what the blade carries in the air;
   * `bladeHeat` is what it reaches with the rim buried and cutting.
   */
  bladeHeatIdle: 0.06, // 0..1 heat with the rim clear of the floor
  bladeHeat: 0.44, // 0..1 heat at full engagement
  heatCold: 300.0, // kelvin at heat = 0 — a cold workshop
  heatHot: 2100.0, // kelvin at heat = 1 — past the point steel burns
  heatRef: 1250.0, // kelvin at which the emission term reaches 1
  heatExponent: 4.0, // Stefan-Boltzmann; 4 is the physical value
  heatGlow: 2.6, // gain on the emission
  heatTint: 0.82, // how far the albedo washes toward the hot colour
  heatEdge: 0.26, // how much cooler an edge reads — thin sections radiate faster

  /* --- the grind: where the sparks come from --- */
  /**
   * `contactPhase` walks the touch point along the **engagement arc** — the
   * chord where the blade's circle crosses the floor. −1 is the entry edge,
   * 0 is bottom dead centre, +1 is the exit edge. It matters because the rim
   * velocity is `ω × r` evaluated *there*: at bottom dead centre the tangent
   * is horizontal, and near either edge it has a real vertical component that
   * throws the sheaf up out of the kerf.
   */
  contactPhase: 0.62, // −1 entry edge … 0 bottom … +1 exit edge
  grindLift: 0.05, // metres the jets start off the surface, along the normal
  grindBounce: 0.6, // 0..1 of the into-surface velocity that comes back out
  grindRise: 0.34, // 0..1 extra tilt away from the floor — the rooster tail
  grindGain: 0.5, // spark speed as a fraction of the rim speed
  grindFloor: 2.2, // metres/second, so a stalled blade still throws something
  grindCeiling: 30.0, // metres/second
  grindFan: 0.82, // radians the jets fan through, in the tangent/normal plane
  grindSwing: 0.3, // radians of fan across it
  grindGraze: 0.05, // sine of the shallowest angle a jet may leave at
  grindJets: 5, // sub-directions per emission; each is one emit() call
  grindSpread: 0.09, // cone half-angle handed to the particle system, per jet
  grindVariance: 0.55, // ±fraction on each spark's speed
  grindDrift: 0.14, // fraction of the rim velocity added as inherited motion

  /* --- the sparks --- */
  /**
   * The four stops are the *cooling* of one spark over its own life. The
   * blackbody tint on top of them is the *temperature it left at*, taken off
   * the same Planckian locus the blade uses, and `sparkTemper` decides how
   * much of the authored gradient that tint is allowed to overrule. At 0 the
   * gradient rules outright; at 1 the sparks are exactly the colour steel of
   * that temperature is.
   */
  sparkRate: 1150.0, // sparks thrown off the contact, particles/second
  sparkSize: 0.13,
  sparkLifetime: 0.52,
  sparkGravity: -17.0, // metres/second², so the sheaf droops into an arc
  sparkStretch: 0.32, // how far a spark smears along its velocity
  sparkGlow: 1.6,
  sparkHeat: 0.93, // 0..1 on the same ramp as the blade — the tint's temperature
  sparkTemper: 0.85, // 0..1 how far that tint overrules the gradient
  colorSparkA: '#fffdf4',
  colorSparkB: '#ffd99a',
  colorSparkC: '#ff8a2c',
  colorSparkD: '#6d1c05',

  /* --- grit off the kerf --- */
  gritRate: 130.0, // cold chips of floor, particles/second
  gritSize: 0.075,
  gritSpeed: 6.0,
  gritLifetime: 1.1,
  gritGravity: -21.0,
  gritSpin: 13.0, // radians/second of tumble
  colorGritA: '#7d7468',
  colorGritB: '#5d564d',
  colorGritC: '#3f3a34',
  colorGritD: '#2a2723',

  /* --- smoke off the cut --- */
  smokeRate: 38.0,
  smokeSize: 0.85,
  smokeSpeed: 1.35,
  smokeLifetime: 2.3,
  smokeOpacity: 0.1,
  smokeRise: 0.95,
  colorSmokeA: '#6a6259',
  colorSmokeB: '#544d46',
  colorSmokeC: '#3c3733',
  colorSmokeD: '#262321',

  /* --- the kerf on the floor (GroundField, RUT) --- */
  kerfHeight: 0.02, // metres the quad floats above the floor
  kerfWidth: 0.16, // metres — half-width of the gouge floor
  kerfDepth: 0.28, // metres of gouge
  kerfLift: 0.1, // metres the spoil ridges stand proud
  kerfSharp: 0.74, // 0 a dish, 1 a square-shouldered slot
  kerfEdge: 0.55, // metres of feather at the front of the cut
  kerfThickness: 0.1, // metres the spoil spreads either side
  kerfWander: 0.4, // metres the track drifts — matched to `bladeWander`
  kerfWanderScale: 0.9, // drift lobes per metre
  kerfSeam: 0.6, // metres one contact sample smears along the track
  kerfRelief: 0.95, // how hard the height field tilts the fake normal
  kerfNormalStep: 0.05, // metres between the height taps
  kerfAmbient: 0.3, // floor on the diffuse term
  kerfWrap: 0.45, // 0..1 wraps the terminator round the back
  kerfSpecular: 0.55,
  kerfGloss: 26.0, // Blinn exponent
  kerfParallax: 0.22, // metres of view-driven offset on the interior
  kerfDetail: 0.55, // 0..1 grain in the gouge
  kerfEmissive: 1.7, // multiplier on the glowing lip right under the blade
  kerfOpacity: 1.0,
  kerfDepthFade: 0.5, // metres of soft fade against standing geometry
  biteRate: 2.4, // contact samples posted per metre of travel
  kerfMarkLife: 7.0, // seconds one sample weathers away over
  kerfMarkRadius: 0.7, // metres, a full-strength sample
  colorKerfBase: '#6b6259', // cut stone
  colorKerfEdge: '#b3a794', // the spoil ridges
  colorKerfGlow: '#ff8f38', // the hot lip under the blade
  colorKerfDeep: '#15120f', // the bottom of the slot

  /* --- the offcuts (Projectile) --- */
  /**
   * The last bite throws a handful of slugs downrange. They are the one place
   * `Projectile` earns its keep here: staggered launches, a parametric arc
   * that re-flies under the slider, a trail drawn entirely in the vertex
   * shader, and an `arrivals` event per landing that fires its own little
   * spark burst.
   */
  offcutCount: 8, // slugs thrown at the last bite
  offcutRadius: 0.17, // metres
  offcutJitter: 0.42, // ±fraction of that radius
  offcutStretch: 0.55, // scale along the aligned axis
  offcutAlign: 0.25, // 0 tumble freely, 1 lay the long axis along the heading
  offcutSpin: 11.0, // tumble rate, radians/second
  offcutFlash: 0.16, // birth flash decay, seconds
  offcutThrow: 6.0, // metres past the blade the middle of the fan lands
  offcutSpreadSide: 2.4, // ±metres across the cast line
  offcutSpreadForward: 2.2, // ±metres along it
  offcutApex: 2.5, // ballistic loft, metres
  offcutApexCurve: 1.15, // >1 flattens the top of the lob
  offcutCurve: 1.0, // easing exponent on launch → land
  offcutFlight: 0.66, // seconds one slug is in the air
  offcutFlightJitter: 0.28, // ±fraction of that
  offcutWindow: 0.42, // seconds the staggered launches spread over
  offcutLead: 0.02, // seconds before the first slug leaves
  offcutLinger: 0.7, // seconds a landed slug stays on the floor
  offcutSink: 1.1, // body radii it sinks over that linger
  offcutLandSparks: 24, // sparks kicked up where a slug hits
  /* the slug's own shape — proportions again, never metres */
  slugWidth: 1.0, // the two in-plane extents, relative to each other
  slugDepth: 0.62,
  slugThickness: 0.26, // unit lengths
  slugCorner: 0.28, // fraction of the short side, corner radius
  slugBevel: 0.055, // unit lengths, 45° break round the whole outline
  /* the slug's steel — its own pickers, because it is cut floor, not blade */
  colorSlagMetal: '#8a7f72',
  colorSlagDeep: '#2f2a25',
  colorSlagScale: '#241f1b',
  colorSlagPolish: '#d9cfbe',
  colorSlagSpec: '#ffe6c4',
  slagRough: 0.46,
  slagMetalness: 0.72,
  slagScale: 0.42, // mill scale coverage on a slug, 0..1
  slagPit: 0.5,
  slagHeat: 0.82, // 0..1 on the shared ramp — slugs come out of the cut hot
  slagHeatGlow: 3.0,
  slagHeatTint: 0.9,
  /* the trail behind a slug */
  trailSpan: 0.26, // seconds of flight the tail reaches back over
  trailBurn: 0.24, // seconds the tail takes to catch up after landing
  trailWidth: 0.08, // metres at the head
  trailTaper: 1.7, // >1 sharpens the tail to a point
  trailLift: 0.02, // metres the tail floats above the flown path
  trailOpacity: 0.95,
  trailGlow: 1.7,
  trailCore: 2.3, // how tightly light crowds the centre line
  trailHeadBias: 0.5, // >0 keeps the brightness near the body
  trailNoise: 0.5,
  trailNoiseScale: 1.9, // features per metre
  trailNoiseSpeed: 0.7,
  trailSoftFade: 0.35, // metres of depth feather against solid geometry
  colorTrailA: '#fff4dc',
  colorTrailB: '#ffb453',
  colorTrailC: '#d9481a',
  colorTrailD: '#3a0d04',

  /* --- the drop, the last bite and the shake --- */
  dropSize: 0.9, // the shell where the blade first bites, metres
  dropIntensity: 1.5,
  dropSparks: 90, // sparks thrown on first contact
  castFlash: 0.06, // screen flash as the blade lands
  colorDropA: '#3a3f45',
  colorDropB: '#ffb453',
  colorDropC: '#fff2d8',
  colorCastFlash: '#ffcf94',
  biteSize: 2.2, // the shell at the far end, metres
  biteIntensity: 1.6,
  biteSparks: 260, // sparks thrown at the last bite
  biteShake: 0.55,
  shakeDuration: 0.5,
  biteFlash: 0.16,
  rumble: 0.05, // continuous shake while the blade is cutting
  colorBiteA: '#4a3a2c',
  colorBiteB: '#ff9a37',
  colorBiteC: '#fff6e4',
  colorFlash: '#ffd8a4', // the full-screen flash at the last bite
  scorchRadius: 0.55, // dark burn left where a slug lands, metres
  scorchLife: 6.0,
  scorchIntensity: 0.5,
  colorScorch: '#100d0a',
  colorEmber: '#ff8f38',

  /* --- dynamic light --- */
  lightIntensity: 17.0,
  lightRadius: 11.0,
  lightColor: '#ffa04a',
  lightFlicker: 0.22, // depth of the light's stutter, 0 = steady
  lightFlickerSpeed: 31.0 // stutters/second — roughly the expansion slots going past
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Sawline.
 *
 * The four controls that carry the slot, in order: **`bladeSpin`** (how fast
 * the rim is going, and therefore how hard the sparks leave — the sign flips
 * the spray front to back), **`contactPhase`** (where on the engagement arc
 * the sparks are struck from, which is what turns a flat spray into a rooster
 * tail), **`grindGain`** (spark speed as a fraction of the rim speed) and
 * **`bladeBite`** (how deep the cut is, which is what decides how long the
 * engagement arc is in the first place).
 *
 * Everything in "The blade's teeth" rebuilds real geometry. It is cheap
 * enough to drag — a blade is about four milliseconds — but it is not free,
 * and it is the only folder here that is not just a uniform write.
 */
export const sawlineSchema = {
  'The cast': [
    ['range', 3, 50, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 1, 60, 0.1, 'blade speed'],
    ['lifetime', 0.05, 5, 0.01, 'grind at the end'],
    ['fadeTime', 0.05, 4, 0.01, 'dive-out time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The blade': [
    ['bladeDiameter', 0.3, 4, 0.01, 'diameter'],
    ['bladeBite', 0.01, 1.2, 0.005, 'cut depth'],
    ['bladeBiteIn', 0.01, 0.6, 0.005, 'run-in fraction'],
    ['bladeSpin', -200, 200, 0.5, 'spin rate (signed)'],
    ['bladeLean', -0.6, 0.6, 0.005, 'forward lean'],
    ['bladeWander', 0, 1.2, 0.005, 'lateral wander'],
    ['bladeWanderScale', 0.02, 3, 0.01, 'wanders / metre'],
    ['bladeExit', 0, 8, 0.05, 'dive depth'],
    ['bladeShadow', 'casts a shadow']
  ],
  "The blade's teeth": [
    ['teeth', 6, 48, 1, 'tooth count'],
    ['toothRake', -30, 40, 0.5, 'rake (deg)'],
    ['toothClearance', 2, 55, 0.5, 'clearance (deg)'],
    ['toothGullet', 0.03, 0.4, 0.005, 'gullet depth'],
    ['toothLand', 0.05, 0.8, 0.01, 'tip land'],
    ['bladeThickness', 0.01, 0.3, 0.002, 'plate thickness'],
    ['bladeChamfer', 0.001, 0.08, 0.001, 'rim chamfer'],
    ['bladeArbor', 0.03, 0.5, 0.005, 'arbor bore'],
    ['bladeSlots', 0, 10, 1, 'expansion slots'],
    ['slotDepth', 0.02, 0.6, 0.005, 'slot depth'],
    ['slotWidth', 0.005, 0.12, 0.001, 'slot width'],
    ['bladeCrease', 5, 70, 1, 'crease angle (deg)']
  ],
  'The steel': [
    ['colorMetal', 'clean steel'],
    ['colorDeep', 'pit bottom'],
    ['colorScale', 'mill scale'],
    ['colorPolish', 'worn edge'],
    ['colorSpec', 'highlight'],
    ['steelRough', 0.02, 1, 0.01, 'roughness'],
    ['steelMetalness', 0, 1, 0.01, 'metalness'],
    ['steelEnv', 0, 3, 0.01, 'probe gain']
  ],
  'The steel/Brushing': [
    ['brushAniso', 0, 1, 0.01, 'anisotropy'],
    ['brushSpecular', 0, 6, 0.01, 'lobe gain'],
    ['brushGrain', 0, 2, 0.01, 'grain depth'],
    ['brushGrainScale', 5, 400, 1, 'grain frequency'],
    ['brushGrainStretch', 1, 120, 0.5, 'streak length']
  ],
  'The steel/Surface history': [
    ['millScale', 0, 1, 0.01, 'scale coverage'],
    ['millScalePatch', 0.5, 30, 0.1, 'scale patch size'],
    ['millScaleSharp', 0, 1, 0.01, 'flake edge'],
    ['steelPit', 0, 1, 0.01, 'pitting'],
    ['steelPitScale', 5, 200, 1, 'pit frequency'],
    ['steelWear', 0, 1, 0.01, 'edge wear'],
    ['steelWearGrain', 0, 1, 0.01, 'wear break-up']
  ],
  Heat: [
    ['bladeHeatIdle', 0, 1, 0.005, 'heat in the air'],
    ['bladeHeat', 0, 1, 0.005, 'heat while cutting'],
    ['heatCold', 200, 1200, 5, 'cold end (K)'],
    ['heatHot', 800, 3000, 10, 'hot end (K)'],
    ['heatRef', 400, 2500, 10, 'emission reference (K)'],
    ['heatExponent', 1, 6, 0.05, 'emission exponent'],
    ['heatGlow', 0, 8, 0.01, 'emission gain'],
    ['heatTint', 0, 1, 0.01, 'albedo wash'],
    ['heatEdge', 0, 1, 0.01, 'edge cooling']
  ],
  'The grind': [
    ['contactPhase', -1, 1, 0.01, 'contact along the arc'],
    ['grindLift', 0, 0.4, 0.005, 'jet lift'],
    ['grindBounce', 0, 1, 0.01, 'restitution'],
    ['grindRise', 0, 1.5, 0.01, 'rooster tail'],
    ['grindGain', 0, 1.5, 0.01, 'speed / rim speed'],
    ['grindFloor', 0, 15, 0.1, 'speed floor'],
    ['grindCeiling', 2, 80, 0.5, 'speed ceiling'],
    ['grindFan', 0, 2.4, 0.01, 'fan angle'],
    ['grindSwing', 0, 1.2, 0.01, 'fan swing'],
    ['grindGraze', 0, 0.6, 0.005, 'grazing floor'],
    ['grindJets', 1, 12, 1, 'jets'],
    ['grindSpread', 0, 0.8, 0.005, 'per-jet spread'],
    ['grindVariance', 0, 1.5, 0.01, 'speed variance'],
    ['grindDrift', 0, 1, 0.01, 'inherited rim motion']
  ],
  Sparks: [
    ['sparkRate', 0, 3500, 5, 'spark rate'],
    ['sparkSize', 0.005, 0.6, 0.005, 'spark size'],
    ['sparkLifetime', 0.05, 3, 0.01, 'spark lifetime'],
    ['sparkGravity', -60, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['sparkGlow', 0, 6, 0.01, 'spark glow'],
    ['sparkHeat', 0, 1, 0.005, 'spark temperature'],
    ['sparkTemper', 0, 1, 0.01, 'blackbody override'],
    ['colorSpark*', 'Spark colour']
  ],
  'Grit & smoke': [
    ['gritRate', 0, 600, 1, 'grit rate'],
    ['gritSize', 0.005, 0.4, 0.005, 'grit size'],
    ['gritSpeed', 0, 25, 0.1, 'grit speed'],
    ['gritLifetime', 0.1, 5, 0.05, 'grit lifetime'],
    ['gritGravity', -60, 0, 0.1, 'grit gravity'],
    ['gritSpin', 0, 40, 0.5, 'grit tumble'],
    ['smokeRate', 0, 400, 1, 'smoke rate'],
    ['smokeSize', 0.05, 4, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['smokeRise', -2, 4, 0.01, 'smoke rise'],
    ['colorGrit*', 'Grit colour'],
    ['colorSmoke*', 'Smoke colour']
  ],
  'The kerf': [
    ['kerfHeight', 0, 0.3, 0.005, 'quad height'],
    ['kerfWidth', 0.02, 1.2, 0.005, 'gouge half-width'],
    ['kerfDepth', 0, 1.5, 0.005, 'gouge depth'],
    ['kerfLift', 0, 0.6, 0.005, 'spoil height'],
    ['kerfSharp', 0, 1, 0.01, 'shoulder sharpness'],
    ['kerfEdge', 0.02, 2, 0.01, 'front feather'],
    ['kerfThickness', 0, 0.6, 0.005, 'spoil spread'],
    ['kerfWander', 0, 2, 0.01, 'track drift'],
    ['kerfWanderScale', 0.05, 4, 0.01, 'drift lobes / m'],
    ['kerfSeam', 0.05, 3, 0.01, 'sample smear'],
    ['biteRate', 0.1, 12, 0.1, 'samples / metre'],
    ['kerfMarkLife', 0.5, 20, 0.1, 'sample lifetime'],
    ['kerfMarkRadius', 0.05, 3, 0.01, 'sample radius']
  ],
  'The kerf/Shading': [
    ['kerfRelief', 0, 3, 0.01, 'relief'],
    ['kerfNormalStep', 0.005, 0.4, 0.005, 'normal step'],
    ['kerfAmbient', 0, 1, 0.01, 'ambient floor'],
    ['kerfWrap', 0, 1, 0.01, 'terminator wrap'],
    ['kerfSpecular', 0, 3, 0.01, 'specular'],
    ['kerfGloss', 1, 120, 1, 'gloss'],
    ['kerfParallax', 0, 1.5, 0.01, 'parallax'],
    ['kerfDetail', 0, 1, 0.01, 'grain'],
    ['kerfEmissive', 0, 6, 0.01, 'hot lip'],
    ['kerfOpacity', 0, 2, 0.01, 'opacity'],
    ['kerfDepthFade', 0, 3, 0.01, 'soft intersection'],
    ['colorKerfBase', 'cut stone'],
    ['colorKerfEdge', 'spoil'],
    ['colorKerfGlow', 'hot lip'],
    ['colorKerfDeep', 'slot bottom']
  ],
  'The offcuts': [
    ['offcutCount', 0, 24, 1, 'slugs'],
    ['offcutRadius', 0.02, 0.8, 0.005, 'slug radius'],
    ['offcutJitter', 0, 1, 0.01, 'size jitter'],
    ['offcutStretch', 0.05, 3, 0.01, 'stretch'],
    ['offcutAlign', 0, 1, 0.01, 'align to heading'],
    ['offcutSpin', 0, 40, 0.5, 'tumble'],
    ['offcutFlash', 0.01, 1, 0.01, 'birth flash'],
    ['offcutThrow', 0.5, 25, 0.1, 'throw distance'],
    ['offcutSpreadSide', 0, 10, 0.05, 'lateral spread'],
    ['offcutSpreadForward', 0, 10, 0.05, 'depth spread'],
    ['offcutApex', 0, 10, 0.05, 'loft'],
    ['offcutApexCurve', 0.2, 4, 0.01, 'loft curve'],
    ['offcutCurve', 0.2, 4, 0.01, 'path curve'],
    ['offcutFlight', 0.05, 3, 0.01, 'flight time'],
    ['offcutFlightJitter', 0, 1, 0.01, 'flight jitter'],
    ['offcutWindow', 0, 2, 0.01, 'launch window'],
    ['offcutLead', 0, 1.5, 0.01, 'launch lead'],
    ['offcutLinger', 0, 4, 0.05, 'linger'],
    ['offcutSink', 0, 4, 0.05, 'sink'],
    ['offcutLandSparks', 0, 200, 1, 'sparks per landing']
  ],
  'The offcuts/Slug shape': [
    ['slugWidth', 0.2, 2, 0.01, 'width'],
    ['slugDepth', 0.1, 2, 0.01, 'depth'],
    ['slugThickness', 0.02, 1, 0.005, 'thickness'],
    ['slugCorner', 0.01, 0.5, 0.005, 'corner radius'],
    ['slugBevel', 0.002, 0.2, 0.002, 'bevel']
  ],
  'The offcuts/Slug steel': [
    ['colorSlagMetal', 'slug metal'],
    ['colorSlagDeep', 'slug pit'],
    ['colorSlagScale', 'slug scale'],
    ['colorSlagPolish', 'slug polish'],
    ['colorSlagSpec', 'slug highlight'],
    ['slagRough', 0.02, 1, 0.01, 'roughness'],
    ['slagMetalness', 0, 1, 0.01, 'metalness'],
    ['slagScale', 0, 1, 0.01, 'scale coverage'],
    ['slagPit', 0, 1, 0.01, 'pitting'],
    ['slagHeat', 0, 1, 0.005, 'heat'],
    ['slagHeatGlow', 0, 8, 0.01, 'emission gain'],
    ['slagHeatTint', 0, 1, 0.01, 'albedo wash']
  ],
  'The offcuts/Trail': [
    ['trailSpan', 0.01, 2, 0.01, 'tail span'],
    ['trailBurn', 0.01, 2, 0.01, 'tail burn'],
    ['trailWidth', 0.005, 0.6, 0.005, 'tail width'],
    ['trailTaper', 0.2, 5, 0.01, 'tail taper'],
    ['trailLift', -0.5, 0.5, 0.005, 'tail lift'],
    ['trailOpacity', 0, 2, 0.01, 'tail opacity'],
    ['trailGlow', 0, 6, 0.01, 'tail glow'],
    ['trailCore', 0.2, 8, 0.01, 'tail core'],
    ['trailHeadBias', 0, 2, 0.01, 'head bias'],
    ['trailNoise', 0, 2, 0.01, 'tail noise'],
    ['trailNoiseScale', 0.1, 8, 0.05, 'noise scale'],
    ['trailNoiseSpeed', 0, 4, 0.01, 'noise speed'],
    ['trailSoftFade', 0.02, 2, 0.01, 'soft intersection'],
    ['colorTrail*', 'Trail colour']
  ],
  'Drop, bite & shake': [
    ['dropSize', 0.05, 6, 0.05, 'drop shell'],
    ['dropIntensity', 0, 5, 0.01, 'drop intensity'],
    ['dropSparks', 0, 500, 1, 'drop sparks'],
    ['castFlash', 0, 2, 0.01, 'flash on landing'],
    ['colorDropA', 'drop shell'],
    ['colorDropB', 'drop body'],
    ['colorDropC', 'drop core'],
    ['colorCastFlash', 'landing flash'],
    ['biteSize', 0.2, 12, 0.05, 'bite shell'],
    ['biteIntensity', 0, 5, 0.01, 'bite intensity'],
    ['biteSparks', 0, 900, 1, 'bite sparks'],
    ['biteShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['biteFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'cutting rumble'],
    ['colorBiteA', 'bite shell'],
    ['colorBiteB', 'bite body'],
    ['colorBiteC', 'bite core'],
    ['colorFlash', 'bite flash colour'],
    ['scorchRadius', 0.05, 4, 0.05, 'scorch radius'],
    ['scorchLife', 0.5, 20, 0.1, 'scorch lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'scorch intensity'],
    ['colorScorch', 'scorch'],
    ['colorEmber', 'ember']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightFlicker', 0, 1, 0.01, 'light stutter'],
    ['lightFlickerSpeed', 1, 120, 1, 'stutter rate'],
    ['lightColor', 'light colour']
  ]
};
