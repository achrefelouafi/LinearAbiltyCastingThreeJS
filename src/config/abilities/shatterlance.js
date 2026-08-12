/* ================================================================== */
/* SHATTERLANCE — the wind-up is the ability                           */
/* ================================================================== */
/**
 * One enormous ice lance, assembled in the air out of converging shards, held
 * long enough for you to read it as a single object, thrown, and broken on
 * arrival into two hundred instanced fragments that inherit its flight.
 *
 * The numbers that decide whether it works:
 *
 *  - **`assembly`** — how long the wind-up lasts. Everything before the throw
 *    is bought by `advance()` refusing to let the front leave the caster for
 *    this many seconds, and the whole ability lives or dies on it being long
 *    enough to look at. Under about six tenths of a second the shards and the
 *    lance are one event and the contrast is gone.
 *  - **`intakeStagger`** against **`intakeEase`** — how the shards arrive.
 *    Stagger spreads them over the clock so they land in a stream; ease decides
 *    whether they drift in or snap in at the last moment. At `stagger 0`,
 *    `ease 1` every shard flies a straight line at the same speed and the
 *    intake reads as a collapsing balloon.
 *  - **`fragmentCount` and `fragInherit`** — the break. `fragInherit` is the
 *    fraction of the lance's own flight velocity every fragment leaves with; at
 *    0 the impact is a firework, at 1 the shrapnel carries on downrange, which
 *    is what makes it read as something that *hit* rather than as something
 *    that popped.
 *
 * Everything with a unit is resolved against this block inside the update loop,
 * on every frame including a zero-length one — including the whole intake,
 * which is a closed-form flight in a vertex shader with no CPU state at all.
 */
export const shatterlance = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 62.0, // how fast the lance flies once released, metres/second
  cooldown: 1.4, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
  assembly: 1.15, // seconds of wind-up before the front is allowed to leave
  lifetime: 0.5, // seconds the impact holds before the fade takes over
  fadeTime: 1.6, // seconds the shrapnel and the frost sheet take to go

  /* --- the lance --- */
  lanceLength: 4.2, // metres, nose to tail
  lanceRadius: 0.42, // metres, at its widest
  lanceHeight: 1.35, // metres above the floor it hangs and flies at
  lanceLean: 1.5708, // radians the body is tipped from vertical; π/2 is level
  lanceRoll: 0.35, // 0..1 of a turn about its own long axis
  hoverForward: 3.4, // metres in front of the caster the lance assembles
  hoverBob: 0.06, // metres it rises and falls by while it hangs
  hoverBobSpeed: 1.6, // bobs per second
  formLengthCurve: 0.6, // <1 extends the lance early in the wind-up
  formRadiusCurve: 1.5, // >1 keeps it thin then thickens it late
  formSeed: 0.12, // 0..1 of full size the lance starts the wind-up at

  /* --- the body (these rebuild the geometry when they move) --- */
  facets: 7, // sides of the prism
  swell: 0.26, // 0..1 up the lance where it is widest
  tailWidth: 0.22, // 0..1 of the full radius at the tail
  tipCurve: 1.35, // how fast it tapers to the point
  flute: 0.28, // 0..1 depth of the grooves between facets
  fluteTwist: 0.5, // turns the grooves make over the length
  bodyJitter: 0.12, // 0..1 irregularity, so it is ice and not a machined cone

  /* --- the lance material --- */
  depthTint: 1.3, // how dark a facet gets seen head-on
  fresnel: 2.0, // rim brightness
  fresnelPower: 2.3, // how tight that rim is
  facetSharp: 0.62, // how hard the facets separate
  fracture: 0.3, // internal crack planes
  fractureScale: 5.0, // crack features per metre
  veins: 0.28, // milky veining
  veinScale: 2.6, // vein features per unit
  seamGlow: 2.4, // the light in the flute valleys — the lance's signature
  seamCount: 3.5, // seams around the circumference (facets / 2 reads best)
  seamWidth: 0.35, // 0..1 how wide one seam is
  seamTwist: 0.5, // turns the seams make over the length
  glint: 1.4, // pinpoint sparkle
  glintScale: 22.0, // glints per metre
  glintSpeed: 0.6, // how fast they scroll
  glow: 1.4, // overall emissive gain
  chargeGlow: 3.0, // the weld line running the lance as it fills
  opacity: 0.94,
  roughness: 0.1, // drives the env reflection
  envIntensity: 1.2, // how much of the HDR probe the ice reflects
  colorIce: '#ffffff', // the body at a grazing angle
  colorDeep: '#0d2f52', // the body seen head-on
  colorSeam: '#8fe3ff', // the flute valleys and the weld line
  colorRim: '#d8f4ff', // the silhouette, the veins and the glints

  /* --- the shards that fly in --- */
  intakeCount: 120, // shards in the intake, one draw call for the lot
  intakeSphere: 4.5, // metres, the shell they start on
  intakeSpread: 3.2, // metres, that shell stretched along the lance
  intakeStagger: 0.55, // 0..1 of the wind-up spread across the shards
  intakeSize: 0.22, // metres, one shard
  intakeSpin: 6.0, // radians/second of tumble on the way in
  intakeEase: 3.0, // >1 makes them accelerate in at the last moment
  intakeOpacity: 0.95,
  intakeGlow: 1.6,
  intakeRim: 1.2, // rim light on a shard
  intakeRimPower: 2.2,
  intakeShade: 1.0, // how much the key direction shades a shard
  intakeAmbient: 0.35,
  colorIntakeA: '#8fe3ff', // a shard out on the shell
  colorIntakeB: '#ffffff', // ...and the moment before it lands
  colorIntakeEdge: '#d8f4ff', // its rim

  /* --- the break --- */
  fragmentCount: 200, // fragments the lance breaks into
  fragSpawnRadius: 0.5, // metres of scatter about the lance's own body
  fragSpawnHeight: 1.35, // metres above the floor the break happens at
  fragInherit: 0.45, // 0..1 of the flight velocity every fragment leaves with
  fragSize: 0.34, // metres
  fragSizeJitter: 0.6, // ± fraction
  fragSpeed: 7.5, // metres/second of its own throw, on top of the inheritance
  fragSpeedJitter: 0.7, // ± fraction
  fragSpread: 0.38, // 0 throws them all downrange, 1 is fully random
  fragUpBias: 0.4, // how much +Y is folded into the throw
  fragGravity: -19.0, // metres/second²
  fragDrag: 0.7, // 1/second
  fragSpin: 11.0, // radians/second of tumble
  fragSpinJitter: 0.85, // ± fraction
  fragLifetime: 1.8, // seconds
  fragShrink: 0.7, // 0..1 of its size a fragment loses by the end
  fragShrinkPower: 1.5, // how late that shrink bites
  fragFloor: 0.03, // metres; a fragment never sinks below this
  fragFloorSpin: 0.18, // fraction of the tumble kept once grounded
  fragOpacity: 0.96,
  fragGlow: 1.3,
  fragRim: 1.2,
  fragRimPower: 2.3,
  fragShade: 1.0,
  fragAmbient: 0.38,
  fragFadeStart: 0.6, // 0..1 of its life before a fragment starts fading
  fragSoft: 0.3, // metres of soft fade where a fragment meets geometry
  colorFragA: '#ffffff', // a fragment lit
  colorFragB: '#8fe3ff', // a fragment in shade
  colorFragEdge: '#d8f4ff', // its rim

  /* --- the frost sheet under the break --- */
  // A `GroundField` in PLATE mode with almost no lift: this is a sheet of frost
  // thrown flat across the stone by the impact, not a raft of curling plates.
  sheetRadius: 5.5, // metres
  sheetGrow: 0.35, // seconds it takes to reach that radius
  sheetHold: 0.5, // 0..1 of the fade it survives before it goes
  sheetHeight: 0.02, // metres above the floor the quad sits at
  sheetCell: 0.3, // metres — the pitch of one frost plate
  sheetCellJitter: 0.95, // 0..1 — how irregular that packing is
  sheetSeam: 0.02, // metres of gap between plates
  sheetThickness: 0.014, // metres of body
  sheetLift: 0.012, // metres the downwind edge rises — deliberately almost none
  sheetEdge: 0.55, // metres of feather on the front
  sheetRagged: 0.42, // how far that front wanders, fraction of the radius
  sheetRaggedScale: 1.1, // lobes per metre
  sheetWarp: 0.7, // metres of domain warp on those lobes
  sheetRelief: 0.55, // how hard the height field tilts the fake normal
  sheetNormalStep: 0.04, // metres between the height taps
  sheetAmbient: 0.36, // floor on the diffuse term
  sheetWrap: 0.5, // 0..1 wraps the terminator round the back
  sheetSpecular: 0.7,
  sheetGloss: 34.0, // Blinn exponent
  sheetParallax: 0.2, // metres of view-driven offset on the interior
  sheetDetail: 0.7, // 0..1 frozen spray in the seams
  sheetEmissive: 1.0,
  sheetOpacity: 0.9,
  sheetDepthFade: 0.4, // metres of soft fade against standing geometry
  colorSheetBase: '#a9d6ea', // the frost itself
  colorSheetEdge: '#ffffff', // its lips and highlights
  colorSheetGlow: '#8fe3ff', // its emissive
  colorSheetDeep: '#0d2f52', // the thick middle of a plate

  /* --- motes, chips and mist --- */
  /**
   * The motes are the only place in the sandbox using the particle engine's
   * `swirl` mode with a *negative* expansion: the offset shrinks over the
   * particle's life, so they spiral inward onto the assembly point instead of
   * away from it. Everything else about them is the usual four-stop gradient.
   */
  moteRate: 150, // frost drawn in during the wind-up, particles/second
  moteSize: 0.06,
  moteLifetime: 1.1,
  moteShell: 4.0, // metres, the radius they are drawn in from
  moteSwirl: 3.4, // radians/second they orbit the assembly at
  moteConverge: 0.92, // 0..1 of their radius they give up over their life
  moteRise: 0.15, // upward drift, metres/second
  moteTurbulence: 0.35,
  colorMoteA: '#8fe3ff',
  colorMoteB: '#d8f4ff',
  colorMoteC: '#ffffff',
  colorMoteD: '#0d2f52',
  chipCount: 70, // chips thrown at the break
  chipSize: 0.06,
  chipSpeed: 6.5,
  chipLifetime: 1.3,
  chipGravity: -18.0,
  colorChipA: '#ffffff',
  colorChipB: '#a9d6ea',
  colorChipC: '#3f6f92',
  colorChipD: '#0d2f52',
  mistRate: 40, // vapour off the frost sheet, particles/second
  mistSize: 1.1,
  mistSpeed: 1.2,
  mistLifetime: 2.2,
  mistOpacity: 0.1,
  mistRise: 0.5,
  colorMistA: '#d8f4ff',
  colorMistB: '#9db8c8',
  colorMistC: '#5a7686',
  colorMistD: '#1d2c36',

  /* --- the shock and the shake --- */
  burstSize: 3.4, // the shell of pulverised ice at the break, metres
  burstIntensity: 1.5,
  colorBurstA: '#8fe3ff',
  colorBurstB: '#d8f4ff',
  colorBurstC: '#ffffff',
  shockRadius: 8.0, // the cold ring that snaps out across the floor, metres
  colorShockA: '#8fe3ff',
  colorShockB: '#ffffff',
  breakFlash: 0.3, // screen flash at the break
  colorFlash: '#d8f4ff',
  breakShake: 1.1,
  shakeDuration: 0.6,
  chargeShake: 0.05, // continuous shake while the lance assembles
  rumble: 0.02, // continuous shake while it flies

  /* --- dynamic light --- */
  lightIntensity: 20.0,
  lightRadius: 15.0,
  lightColor: '#8fe3ff',
  lightPulse: 0.3, // depth of the light's breath while it charges
  lightPulseSpeed: 2.2 // breaths per second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Shatterlance.
 *
 * Start in `The wind-up`. `assembly` is the ability: shorten it and the slot
 * becomes an ordinary fast projectile, lengthen it and it becomes a siege
 * weapon. `The shards` decides how the lance is fed, and `The break` decides
 * whether the impact reads as shrapnel or as confetti — `fragInherit` is the
 * control that separates the two.
 */
export const shatterlanceSchema = {
  'The wind-up': [
    ['assembly', 0.05, 5, 0.01, 'wind-up (s)'],
    ['formLengthCurve', 0.1, 4, 0.01, 'length curve'],
    ['formRadiusCurve', 0.1, 4, 0.01, 'girth curve'],
    ['formSeed', 0.01, 1, 0.01, 'size at t=0'],
    ['hoverForward', 0.5, 10, 0.05, 'assembles this far out (m)'],
    ['hoverBob', 0, 1, 0.005, 'hover bob (m)'],
    ['hoverBobSpeed', 0, 8, 0.05, 'bobs / second'],
    ['chargeShake', 0, 0.5, 0.005, 'charge shake']
  ],
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'flight speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['lifetime', 0.05, 4, 0.01, 'impact hold'],
    ['fadeTime', 0.1, 6, 0.05, 'fade'],
    ['rumble', 0, 0.5, 0.005, 'flight rumble'],
    ['castAnim', 'cast animation']
  ],
  'The lance': [
    ['lanceLength', 0.5, 12, 0.05, 'length (m)'],
    ['lanceRadius', 0.05, 2, 0.01, 'radius (m)'],
    ['lanceHeight', 0.2, 5, 0.01, 'flight height (m)'],
    ['lanceLean', 0.6, 2.6, 0.01, 'pitch (rad)'],
    ['lanceRoll', 0, 1, 0.01, 'roll'],
    ['facets', 4, 16, 1, 'facets'],
    ['swell', 0.05, 0.9, 0.01, 'widest point'],
    ['tailWidth', 0.02, 1, 0.01, 'tail width'],
    ['tipCurve', 0.3, 4, 0.01, 'tip taper'],
    ['flute', 0, 0.7, 0.01, 'groove depth'],
    ['fluteTwist', -3, 3, 0.01, 'groove twist'],
    ['bodyJitter', 0, 0.6, 0.01, 'irregularity']
  ],
  'The ice': [
    ['depthTint', 0, 3, 0.01, 'head-on tint'],
    ['fresnel', 0, 6, 0.01, 'rim'],
    ['fresnelPower', 0.2, 8, 0.01, 'rim tightness'],
    ['facetSharp', 0, 1, 0.01, 'facet separation'],
    ['fracture', 0, 2, 0.01, 'internal cracks'],
    ['fractureScale', 0.5, 20, 0.1, 'cracks / metre'],
    ['veins', 0, 2, 0.01, 'veining'],
    ['veinScale', 0.2, 10, 0.05, 'vein scale'],
    ['seamGlow', 0, 8, 0.01, 'seam glow'],
    ['seamCount', 0.5, 12, 0.5, 'seams around'],
    ['seamWidth', 0.02, 1, 0.01, 'seam width'],
    ['seamTwist', -3, 3, 0.01, 'seam twist'],
    ['chargeGlow', 0, 8, 0.01, 'weld line'],
    ['glint', 0, 4, 0.01, 'sparkle'],
    ['glintScale', 2, 80, 0.5, 'glints / metre'],
    ['glintSpeed', 0, 4, 0.01, 'glint scroll'],
    ['glow', 0, 5, 0.01, 'glow'],
    ['opacity', 0, 1, 0.01, 'opacity'],
    ['roughness', 0.01, 1, 0.01, 'roughness'],
    ['envIntensity', 0, 4, 0.01, 'env reflection'],
    ['colorIce', 'body, grazing'],
    ['colorDeep', 'body, head-on'],
    ['colorSeam', 'seams & weld'],
    ['colorRim', 'rim, veins, glints']
  ],
  'The shards': [
    ['intakeCount', 0, 256, 1, 'shards'],
    ['intakeSphere', 0.2, 14, 0.05, 'shell radius (m)'],
    ['intakeSpread', 0.2, 16, 0.05, 'shell along the lance (m)'],
    ['intakeStagger', 0, 0.95, 0.01, 'arrival stagger'],
    ['intakeSize', 0.02, 1.2, 0.01, 'shard size (m)'],
    ['intakeSpin', 0, 30, 0.1, 'tumble'],
    ['intakeEase', 1, 8, 0.05, 'convergence curve'],
    ['intakeOpacity', 0, 1, 0.01, 'opacity'],
    ['intakeGlow', 0, 5, 0.01, 'glow'],
    ['intakeRim', 0, 4, 0.01, 'rim'],
    ['intakeRimPower', 0.2, 8, 0.01, 'rim tightness'],
    ['intakeShade', 0, 2, 0.01, 'shading'],
    ['intakeAmbient', 0, 1, 0.01, 'ambient'],
    ['colorIntakeA', 'shard on the shell'],
    ['colorIntakeB', 'shard arriving'],
    ['colorIntakeEdge', 'shard rim']
  ],
  'The break': [
    ['fragmentCount', 0, 256, 1, 'fragments'],
    ['fragSpawnRadius', 0, 3, 0.01, 'scatter (m)'],
    ['fragSpawnHeight', 0, 5, 0.01, 'break height (m)'],
    ['fragInherit', 0, 1.5, 0.01, 'inherited velocity'],
    ['fragSize', 0.02, 1.5, 0.01, 'size (m)'],
    ['fragSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['fragSpeed', 0, 30, 0.1, 'throw speed'],
    ['fragSpeedJitter', 0, 1, 0.01, 'speed jitter'],
    ['fragSpread', 0, 1, 0.01, 'spread'],
    ['fragUpBias', 0, 1, 0.01, 'up bias'],
    ['fragGravity', -60, 5, 0.1, 'gravity'],
    ['fragDrag', 0, 6, 0.01, 'drag'],
    ['fragSpin', 0, 40, 0.1, 'tumble'],
    ['fragSpinJitter', 0, 1, 0.01, 'tumble jitter'],
    ['fragLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['fragShrink', 0, 1, 0.01, 'shrink'],
    ['fragShrinkPower', 0.2, 6, 0.01, 'shrink curve'],
    ['fragFloor', 0, 1, 0.005, 'floor'],
    ['fragFloorSpin', 0, 1, 0.01, 'floor tumble'],
    ['fragOpacity', 0, 1, 0.01, 'opacity'],
    ['fragGlow', 0, 4, 0.01, 'glow'],
    ['fragRim', 0, 4, 0.01, 'rim'],
    ['fragRimPower', 0.2, 8, 0.01, 'rim tightness'],
    ['fragShade', 0, 2, 0.01, 'shading'],
    ['fragAmbient', 0, 1, 0.01, 'ambient'],
    ['fragFadeStart', 0, 1, 0.01, 'fade start'],
    ['fragSoft', 0, 2, 0.01, 'soft intersection'],
    ['colorFragA', 'fragment lit'],
    ['colorFragB', 'fragment shaded'],
    ['colorFragEdge', 'fragment rim']
  ],
  'The frost sheet': [
    ['sheetRadius', 0.2, 20, 0.05, 'radius'],
    ['sheetGrow', 0.02, 3, 0.01, 'spread time'],
    ['sheetHold', 0, 1, 0.01, 'survives this much of the fade'],
    ['sheetHeight', 0, 0.4, 0.005, 'height above floor'],
    ['sheetCell', 0.05, 2, 0.01, 'plate pitch'],
    ['sheetCellJitter', 0, 1, 0.01, 'packing irregularity'],
    ['sheetSeam', 0.002, 0.4, 0.002, 'seam width'],
    ['sheetThickness', 0.002, 0.3, 0.002, 'plate body'],
    ['sheetLift', 0, 0.5, 0.002, 'downwind lift'],
    ['sheetEdge', 0.02, 3, 0.01, 'front feather'],
    ['sheetRagged', 0, 1, 0.01, 'front wander'],
    ['sheetRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['sheetWarp', 0, 3, 0.01, 'domain warp'],
    ['sheetRelief', 0, 3, 0.01, 'relief'],
    ['sheetNormalStep', 0.005, 0.4, 0.005, 'normal step'],
    ['sheetAmbient', 0, 1, 0.01, 'ambient'],
    ['sheetWrap', 0, 1, 0.01, 'terminator wrap'],
    ['sheetSpecular', 0, 3, 0.01, 'specular'],
    ['sheetGloss', 1, 120, 1, 'gloss'],
    ['sheetParallax', 0, 2, 0.01, 'parallax'],
    ['sheetDetail', 0, 1, 0.01, 'frozen spray'],
    ['sheetEmissive', 0, 4, 0.01, 'emissive'],
    ['sheetOpacity', 0, 1, 0.01, 'opacity'],
    ['sheetDepthFade', 0.02, 2, 0.01, 'soft intersection'],
    ['colorSheetBase', 'frost'],
    ['colorSheetEdge', 'frost lips'],
    ['colorSheetGlow', 'frost emissive'],
    ['colorSheetDeep', 'plate interior']
  ],
  'Motes, chips & mist': [
    ['moteRate', 0, 600, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteLifetime', 0.1, 5, 0.05, 'mote lifetime'],
    ['moteShell', 0.2, 14, 0.05, 'mote shell (m)'],
    ['moteSwirl', -12, 12, 0.05, 'mote orbit'],
    ['moteConverge', 0, 1, 0.01, 'mote convergence'],
    ['moteRise', -2, 4, 0.01, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['chipCount', 0, 300, 1, 'chips at the break'],
    ['chipSize', 0.005, 0.4, 0.005, 'chip size'],
    ['chipSpeed', 0, 30, 0.1, 'chip speed'],
    ['chipLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['chipGravity', -60, 0, 0.1, 'chip gravity'],
    ['mistRate', 0, 400, 1, 'mist rate'],
    ['mistSize', 0.05, 4, 0.01, 'mist size'],
    ['mistSpeed', 0, 8, 0.05, 'mist speed'],
    ['mistLifetime', 0.2, 8, 0.05, 'mist lifetime'],
    ['mistOpacity', 0, 1, 0.005, 'mist opacity'],
    ['mistRise', -2, 4, 0.01, 'mist rise'],
    ['colorMote*', 'Mote colour'],
    ['colorChip*', 'Chip colour'],
    ['colorMist*', 'Mist colour']
  ],
  'The shock': [
    ['burstSize', 0.2, 14, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['shockRadius', 0.5, 30, 0.1, 'shockwave radius'],
    ['breakFlash', 0, 2, 0.01, 'screen flash'],
    ['breakShake', 0, 4, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst core'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'light breath'],
    ['lightPulseSpeed', 0, 10, 0.05, 'breath rate'],
    ['lightColor', 'light colour']
  ]
};
