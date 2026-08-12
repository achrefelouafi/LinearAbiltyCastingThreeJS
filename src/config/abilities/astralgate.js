/* ================================================================== */
/* ASTRAL GATE — arcane, zone cast                                     */
/* ================================================================== */
/**
 * A ring gate tears open in the air over the zone and obelisks of astral stone
 * climb out of it.
 *
 * **The one number that carries the ability is `gateHeight`.** Put the
 * aperture on the floor and the whole thing is free: the floor hides
 * everything underneath it and there is nothing to clip. Float it a metre and
 * a half up and every body that is only half-way through has the other half
 * hanging in mid-air under a hole in space — which is what
 * `materials/AstralStoneMaterial.js` exists to prevent, and what `lipWidth`
 * and `lipGlow` exist to turn from an absence into an effect.
 *
 * Two keys are computed rather than authored, from `zoneRadius` — the portal's
 * two half-extents — because a gate whose size does not follow the aim circle
 * is a gate standing in the wrong place. There is therefore no `gateRadiusX`
 * slider; there is `gateSpan`, a fraction, and the ability resolves the metres
 * every frame. Same for the growth field's footprint, which is the aperture's
 * and not the zone's: nothing may come out of a hole it does not fit through.
 *
 * The `star*` and `nebula*` families are three parallax shells and one fbm
 * cloud inside the aperture, in **metres behind the plane**. `parallax` is the
 * single most important number in the portal and it must not be 1 — at 1 the
 * interior is a geometrically honest window into a room, and a window is not a
 * gate. See `vfx/Portal.js`.
 */
export const astralgate = {
  /* --- the cast --- */
  range: 22.0, //         maximum cast distance, metres
  minRange: 3.0, //       closer than this and the cast is refused
  speed: 46.0, //         how fast the summoning front travels, metres/second
  cooldown: 1.8, //       seconds
  castAnim: 'cast3', //   which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 4.6, //     the footprint the aim circle measures out, metres

  openTime: 0.55, //      seconds the aperture takes to tear open
  pourTime: 0.95, //      seconds the bodies take to finish coming through
  holdTime: 1.5, //       seconds everything stands
  fadeTime: 1.6, //       seconds the bodies sink back and the hole shuts
  retractCurve: 1.5, //   >1 holds them up, then drops them back through
  shutCurve: 3.0, //      >1 keeps the hole open until the last body is gone

  /* ------------------------------------------------------------------ */
  /* The gate — vfx/Portal.js                                            */
  /* ------------------------------------------------------------------ */
  gateHeight: 1.55, //    metres the aperture floats above the floor. See above.
  gateSpan: 0.78, //      aperture radius, × zoneRadius
  gateMargin: 0.5, //     0..1 extra quad so the crown of cracks has somewhere to go
  gateOpacity: 0.98,
  tearSeam: 0.0, //       0 unzips from the centre, 1 from the long centreline
  tearJag: 0.72, //       0..1 how uneven the tear front is
  tearScale: 1.5, //      cycles per metre of the crack grain
  tearCrawl: 0.16, //     Hz the grain creeps while the tear is held
  edgeSoft: 0.04, //      0..1 of the field — how hard the aperture cuts

  rim: 0.04, //           0..1 of the field — the fracture band's width
  rimGlow: 2.6,
  core: 0.012, //         0..1 — the white-hot line inside the band
  coreGlow: 5.5,
  throat: 0.2, //         0..1 — the soft inner glow past the rim
  throatGlow: 0.75,
  crackCount: 16, //      radial fractures around the rim
  crackWidth: 0.08, //    0..1 of one angular cell
  crackLength: 0.26, //   0..1 of the field they reach out to
  crackGlow: 2.0,

  parallax: 1.65, //      1 is geometrically honest. Do not ship 1.
  swirl: 0.06, //         rad/s the whole interior turns at
  interiorFade: 0.38, //  0..1 how much the void darkens toward the rim

  starSize: 0.042,
  starTwinkle: 0.4,
  starGain: 1.1,
  starScaleA: 2.4, //     stars per metre, near shell
  starScaleB: 5.0,
  starScaleC: 9.0, //     ... far shell
  starDepthA: 2.2, //     metres behind the plane, near shell
  starDepthB: 6.5,
  starDepthC: 17.0,
  starDriftA: 0.035, //   rad/s, near shell
  starDriftB: 0.019,
  starDriftC: 0.009,
  nebulaScale: 0.24, //   cycles per metre
  nebulaSpeed: 0.045,
  nebulaGain: 0.6,
  nebulaDepth: 12.0, //   metres behind the plane

  colorVoid: '#000000',
  colorGateRim: '#8f7dff',
  colorGateCore: '#ffffff',
  colorGateCrack: '#6f52d8',
  colorGateThroat: '#2a1560',
  colorStarA: '#ffffff',
  colorStarB: '#c4d2ff',
  colorStarC: '#8f7dff',
  colorNebulaA: '#100a24',
  colorNebulaB: '#4b2a9c',

  /* ------------------------------------------------------------------ */
  /* What comes through — vfx/GrowthField.js                             */
  /* ------------------------------------------------------------------ */
  bodyCount: 34, //       obelisks planted per cast (capped at 96)
  bodyCluster: 0.2, //    0..1 held back for the group under the middle
  bodyInner: 0.06, //     inner radius of the annulus, × the aperture radius
  bodyRadialCurve: 0.85, // <1 pushes the ring toward the rim
  bodyRadialJitter: 0.22, // metres of radial wander
  bodyAngleJitter: 0.3, // radians of bearing wander
  riseStagger: 0.5, //    0..1 of the pour beat spent staggering the arrivals

  bodyHeightNear: 1.5, // metres at the centre of the aperture
  bodyHeight: 2.9, //     ... and at its rim
  bodyHeightCurve: 1.0, // how late that ramp climbs
  bodyHeightJitter: 0.42, // ± fraction
  bodyCrown: 0.3, //      0..1 how much shorter the flank bodies are
  bodyCrownPower: 1.5,
  bodyPeak: 1.0, //       extra height multiplier at the rim
  bodyPeakWidth: 0.25,
  bodyRubble: 0.16, //    0..1 chance a body is demoted to a shard
  bodyRubbleScale: 0.34,
  bodyRubbleSpread: 1.3,

  bodyRadiusNear: 0.3, // metres, base radius at the centre
  bodyRadius: 0.24, //    ... and at the rim (< 0 would track the near value)
  bodyRadiusCurve: 0.7,
  bodyRadiusJitter: 0.4,

  bodyLean: 0.16, //      radians away from the centre
  bodyLeanJitter: 0.55, // ± fraction
  bodyLeanRamp: 0.7, //   0 leans everything, 1 only the rim
  bodyLeanOutward: 0.9, // weight of "out across the annulus" in the lean
  bodyLeanForward: 0.2, // weight of "away from the caster"
  bodyTwist: 1.0, //      0..1 of a full turn of random yaw
  bodyTilt: 0.07, //      radians of extra random tip

  riseTime: 0.42, //      seconds one body takes to come all the way through
  riseOvershoot: 0.18, // how far past full height the arrival carries
  settle: 0.55, //        seconds that overshoot damps out over
  springRate: 12.0, //    radians/second of the overshoot ring
  emergeSink: 1.15, //    fraction of its height a body is buried at emerge = 0.
  //                      Above 1 on purpose: at 0.85 the tip of an untriggered
  //                      body pokes through the plane and the field starts as a
  //                      ring of stubs already standing in the hole.
  birthScale: 0.9, //     footprint scale on the frame it breaks the plane
  birthFade: 0.3, //      seconds the arrival flash decays over
  breachAt: 0.12, //      emergence fraction that fires the breach spark
  sinkDepth: 0.6, //      extra metres a retracting body drops beyond its height

  /* --- the body's silhouette (geometry; rebuilt when one of these moves) --- */
  bodySides: 5, //        facets round one obelisk, 3–8
  bodyTaper: 0.16, //     tip radius as a fraction of the base
  bodyRough: 0.34, //     how far the facets are pushed off a clean prism
  bodyBend: 0.14, //      sideways curve from base to tip

  /* --- astral stone (materials/AstralStoneMaterial.js) --- */
  colorStoneDeep: '#0d1024', //  the base, in shadow
  colorStoneFace: '#3a3f66', //  the lit faces near the tip
  colorStoneVein: '#b9a6ff', //  the starlight in the cracks
  colorLip: '#e6dcff', //        the band where a body crosses the plane
  colorBirth: '#ffffff', //      the flash as it breaks through
  stoneFaceCurve: 1.4, //  >1 keeps the base dark and opens out late
  stoneVeins: 0.85,
  stoneVeinScale: 1.6, //  cycles per metre
  stoneVeinSharp: 0.62,
  stoneSpecks: 0.7,
  stoneSpeckScale: 11.0, // cells per metre
  stoneGrain: 0.35,
  stoneGrainScale: 5.5, // cycles per metre
  stoneSeedOffset: 3.1, // how far a per-instance seed shifts the vein field
  stoneFresnel: 0.9,
  stoneFresnelPower: 3.0,
  stoneGlow: 1.4,
  stoneRoughness: 0.72,
  stoneMetalness: 0.08,
  stoneEnv: 0.9,
  birthGlow: 2.2, //      gain on the arrival flash
  lipWidth: 0.22, //      metres the emergence band falls off over
  lipGlow: 2.6, //        gain on that band

  /* ------------------------------------------------------------------ */
  /* The bent air at the rim — vfx/Distortion.js, LENS                   */
  /* ------------------------------------------------------------------ */
  lensSpan: 1.35, //      the emitter quad's half-extent, × the aperture radius
  lensStrength: 0.035, // screen widths at post.distortion = 1. Not metres.
  lensCore: 0.28, //      0..1 of the radius the 1/r² is clamped inside
  lensWindow: 0.95, //    0..1 of the radius the effect is windowed into
  lensMaxOffset: 0.09, // hard clamp on the offset, screen widths
  lensFold: 0.6, //       how hard the guard against a folded lookup bites
  lensSwirl: 0.35, //     tangential component — the lens turning
  lensDepthFade: 0.5, //  metres of depth fade at the silhouette
  lensOpacity: 1.0,

  /* ------------------------------------------------------------------ */
  /* Particles                                                           */
  /* ------------------------------------------------------------------ */
  moteRate: 150, //       star-stuff drifting up out of the aperture, /second
  moteOpen: 90, //        extra thrown on the frame the tear completes
  moteSize: 0.07,
  moteSpeed: 1.6,
  moteLifetime: 2.3,
  moteRise: 0.9, //       upward drift, metres/second
  moteTurbulence: 0.8,
  colorMoteA: '#ffffff',
  colorMoteB: '#c4d2ff',
  colorMoteC: '#8f7dff',
  colorMoteD: '#241548',

  gritRate: 20, //        chips shaken off the standing obelisks, /second
  gritBreach: 14, //      chips thrown by one body breaking the plane
  gritSize: 0.055,
  gritSpeed: 3.6,
  gritLifetime: 1.4,
  gritGravity: -18.0,
  colorGritA: '#6a6f96',
  colorGritB: '#45496b',
  colorGritC: '#2a2d47',
  colorGritD: '#171a2c',

  hazeRate: 26, //        cold haze pouring off the underside of the gate, /second
  hazeSize: 0.9,
  hazeSpeed: 0.9,
  hazeLifetime: 2.6,
  hazeOpacity: 0.09,
  hazeFall: -0.35, //     drift, metres/second — negative, it spills downward
  colorHazeA: '#3b3560',
  colorHazeB: '#2c2848',
  colorHazeC: '#211e36',
  colorHazeD: '#131223',

  /* --- dynamic light --- */
  lightIntensity: 18.0,
  lightRadius: 16.0,
  lightColor: '#9d86ff',
  lightPulse: 0.3, //     depth of the light's swell, 0 = steady
  lightPulseSpeed: 5.5,
  lightHeight: 0.65, //   0..1 of the tallest body the light climbs to

  /* --- the tear and the arrival --- */
  burstSize: 2.4, //      the shell of displaced air as the hole opens, metres
  burstIntensity: 1.3,
  colorBurstA: '#2a1560',
  colorBurstB: '#8f7dff',
  colorBurstC: '#ffffff',
  ringSpan: 1.5, //       the floor ring under the gate at the tear, × zoneRadius
  colorRingA: '#8f7dff',
  colorRingB: '#e6dcff',
  openFlash: 0.16, //     screen flash as the hole finishes tearing
  colorFlash: '#c4b2ff',
  openShake: 0.55,
  shakeDuration: 0.7,
  rumble: 0.03 //         continuous shake while the front travels
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Astral Gate.
 *
 * Drag `gateHeight` first, with the field standing and the clock paused. At 0
 * the ability is a hole in the floor with things coming out of it and the clip
 * is doing nothing; every centimetre above that is a centimetre of buried
 * obelisk the clip is holding back, and the emergence lip climbs each shaft as
 * you drag. That one slider is the whole demonstration.
 */
export const astralgateSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'summon-front speed'],
    ['zoneRadius', 1, 12, 0.1, 'zone radius'],
    ['openTime', 0.05, 3, 0.01, 'tear open'],
    ['pourTime', 0.05, 4, 0.01, 'pour through'],
    ['holdTime', 0.05, 6, 0.01, 'hold'],
    ['fadeTime', 0.05, 6, 0.01, 'sink back & shut'],
    ['retractCurve', 0.3, 6, 0.05, 'withdrawal curve'],
    ['shutCurve', 0.3, 8, 0.05, 'hole-shut curve'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The gate': [
    ['gateHeight', 0, 5, 0.01, 'aperture height (m)'],
    ['gateSpan', 0.1, 1.5, 0.01, 'aperture radius × zone'],
    ['gateMargin', 0, 1.5, 0.01, 'crack margin'],
    ['gateOpacity', 0, 1, 0.01, 'opacity'],
    ['tearSeam', 0, 1, 0.01, 'seam (0 disc, 1 slit)'],
    ['tearJag', 0, 1, 0.01, 'tear raggedness'],
    ['tearScale', 0.1, 8, 0.05, 'crack grain (cyc/m)'],
    ['tearCrawl', 0, 2, 0.01, 'grain crawl (Hz)'],
    ['edgeSoft', 0.002, 0.4, 0.002, 'aperture edge']
  ],
  'The gate/Fracture': [
    ['rim', 0.002, 0.3, 0.002, 'rim width'],
    ['rimGlow', 0, 8, 0.05, 'rim glow'],
    ['core', 0.001, 0.1, 0.001, 'core line'],
    ['coreGlow', 0, 12, 0.05, 'core glow'],
    ['throat', 0.01, 1, 0.005, 'throat'],
    ['throatGlow', 0, 4, 0.02, 'throat glow'],
    ['crackCount', 1, 40, 1, 'radial cracks'],
    ['crackWidth', 0.005, 0.4, 0.005, 'crack width'],
    ['crackLength', 0.01, 1, 0.01, 'crack reach'],
    ['crackGlow', 0, 6, 0.05, 'crack glow'],
    ['colorGateRim', 'rim'],
    ['colorGateCore', 'core'],
    ['colorGateCrack', 'cracks'],
    ['colorGateThroat', 'throat']
  ],
  'The gate/Interior': [
    ['parallax', 0.2, 4, 0.01, 'parallax (never 1)'],
    ['swirl', -1, 1, 0.005, 'swirl (rad/s)'],
    ['interiorFade', 0, 1, 0.01, 'darken toward rim'],
    ['starSize', 0.005, 0.3, 0.001, 'star size'],
    ['starTwinkle', 0, 1, 0.01, 'twinkle'],
    ['starGain', 0, 4, 0.01, 'star gain'],
    ['starScaleA', 0.2, 20, 0.1, 'stars/m near'],
    ['starScaleB', 0.2, 20, 0.1, 'stars/m mid'],
    ['starScaleC', 0.2, 30, 0.1, 'stars/m far'],
    ['starDepthA', 0.2, 20, 0.1, 'depth near (m)'],
    ['starDepthB', 0.5, 40, 0.1, 'depth mid (m)'],
    ['starDepthC', 1, 80, 0.5, 'depth far (m)'],
    ['starDriftA', -0.3, 0.3, 0.001, 'drift near'],
    ['starDriftB', -0.3, 0.3, 0.001, 'drift mid'],
    ['starDriftC', -0.3, 0.3, 0.001, 'drift far'],
    ['nebulaScale', 0.02, 2, 0.01, 'nebula scale'],
    ['nebulaSpeed', 0, 1, 0.005, 'nebula speed'],
    ['nebulaGain', 0, 3, 0.01, 'nebula gain'],
    ['nebulaDepth', 1, 60, 0.5, 'nebula depth (m)'],
    ['colorVoid', 'void'],
    ['colorStarA', 'stars near'],
    ['colorStarB', 'stars mid'],
    ['colorStarC', 'stars far'],
    ['colorNebulaA', 'nebula low'],
    ['colorNebulaB', 'nebula high']
  ],
  'What comes through': [
    ['bodyCount', 1, 96, 1, 'obelisks'],
    ['bodyCluster', 0, 1, 0.01, 'centre cluster'],
    ['bodyInner', 0, 1, 0.01, 'inner radius × aperture'],
    ['bodyRadialCurve', 0.2, 3, 0.01, 'radial curve'],
    ['bodyRadialJitter', 0, 3, 0.01, 'radial wander (m)'],
    ['bodyAngleJitter', 0, 1.5, 0.01, 'bearing wander (rad)'],
    ['riseStagger', 0, 1, 0.01, 'arrival stagger'],
    ['riseTime', 0.02, 2, 0.01, 'one body rises in (s)'],
    ['riseOvershoot', 0, 1, 0.01, 'overshoot'],
    ['settle', 0.02, 2, 0.01, 'settle (s)'],
    ['springRate', 1, 40, 0.5, 'spring rate'],
    ['emergeSink', 0.2, 2, 0.01, 'buried depth × height'],
    ['birthScale', 0.1, 1.5, 0.01, 'birth footprint'],
    ['birthFade', 0.02, 2, 0.01, 'arrival flash (s)'],
    ['breachAt', 0, 1, 0.01, 'breach fires at'],
    ['sinkDepth', 0, 4, 0.05, 'extra sink (m)']
  ],
  'What comes through/Silhouette': [
    ['bodyHeightNear', 0.05, 8, 0.05, 'height at centre'],
    ['bodyHeight', 0.05, 12, 0.05, 'height at rim'],
    ['bodyHeightCurve', 0.2, 4, 0.01, 'height curve'],
    ['bodyHeightJitter', 0, 1, 0.01, 'height jitter'],
    ['bodyCrown', 0, 1, 0.01, 'crown'],
    ['bodyCrownPower', 0.2, 4, 0.01, 'crown falloff'],
    ['bodyPeak', 0.2, 3, 0.01, 'rim peak'],
    ['bodyPeakWidth', 0.02, 1, 0.01, 'peak width'],
    ['bodyRubble', 0, 1, 0.01, 'shard share'],
    ['bodyRubbleScale', 0.05, 1, 0.01, 'shard height'],
    ['bodyRubbleSpread', 0.5, 3, 0.01, 'shard footprint'],
    ['bodyRadiusNear', 0.02, 2, 0.01, 'base radius, centre'],
    ['bodyRadius', 0.02, 2, 0.01, 'base radius, rim'],
    ['bodyRadiusCurve', 0.1, 3, 0.01, 'radius curve'],
    ['bodyRadiusJitter', 0, 1, 0.01, 'radius jitter'],
    ['bodyLean', -1, 1, 0.01, 'lean (rad)'],
    ['bodyLeanJitter', 0, 1, 0.01, 'lean jitter'],
    ['bodyLeanRamp', 0, 1, 0.01, 'lean ramp'],
    ['bodyLeanOutward', 0, 1, 0.01, 'lean outward'],
    ['bodyLeanForward', 0, 1, 0.01, 'lean downrange'],
    ['bodyTwist', 0, 1, 0.01, 'random yaw'],
    ['bodyTilt', 0, 0.6, 0.005, 'random tip (rad)'],
    ['bodySides', 3, 8, 1, 'facets'],
    ['bodyTaper', 0.02, 0.9, 0.01, 'tip taper'],
    ['bodyRough', 0, 1, 0.01, 'facet roughness'],
    ['bodyBend', 0, 1, 0.01, 'shaft bend']
  ],
  'Astral stone': [
    ['stoneFaceCurve', 0.2, 4, 0.01, 'base→tip curve'],
    ['stoneVeins', 0, 3, 0.01, 'vein strength'],
    ['stoneVeinScale', 0.1, 8, 0.05, 'vein scale (cyc/m)'],
    ['stoneVeinSharp', 0, 1, 0.01, 'vein threshold'],
    ['stoneSpecks', 0, 3, 0.01, 'speck strength'],
    ['stoneSpeckScale', 1, 40, 0.5, 'specks (cells/m)'],
    ['stoneGrain', 0, 1, 0.01, 'grain'],
    ['stoneGrainScale', 0.5, 20, 0.1, 'grain scale'],
    ['stoneSeedOffset', 0, 20, 0.1, 'per-body seed shift'],
    ['stoneFresnel', 0, 3, 0.01, 'fresnel'],
    ['stoneFresnelPower', 0.2, 8, 0.05, 'fresnel power'],
    ['stoneGlow', 0, 6, 0.01, 'vein glow'],
    ['stoneRoughness', 0, 1, 0.01, 'roughness'],
    ['stoneMetalness', 0, 1, 0.01, 'metalness'],
    ['stoneEnv', 0, 3, 0.01, 'env intensity'],
    ['birthGlow', 0, 8, 0.05, 'arrival flash glow'],
    ['colorStoneDeep', 'stone, base'],
    ['colorStoneFace', 'stone, tip'],
    ['colorStoneVein', 'veins'],
    ['colorBirth', 'arrival flash']
  ],
  // `gateHeight` belongs here as much as it belongs to the gate, and it is
  // filed under "The gate" rather than in both places: two lil-gui controllers
  // bound to one property do not keep each other's readouts in step, and a
  // slider showing a stale number is worse than a slider in the wrong folder.
  'The clip (the ability)': [
    ['lipWidth', 0.01, 1.5, 0.005, 'emergence band (m)'],
    ['lipGlow', 0, 8, 0.05, 'emergence glow'],
    ['colorLip', 'emergence band']
  ],
  'The bent air': [
    ['lensSpan', 0.2, 4, 0.01, 'radius × aperture'],
    ['lensStrength', 0, 0.25, 0.001, 'strength (screen)'],
    ['lensCore', 0.01, 1, 0.01, 'core clamp'],
    ['lensWindow', 0.1, 1, 0.01, 'window'],
    ['lensMaxOffset', 0.01, 0.4, 0.005, 'max offset'],
    ['lensFold', 0, 1, 0.01, 'fold guard'],
    ['lensSwirl', -2, 2, 0.01, 'swirl'],
    ['lensDepthFade', 0, 3, 0.01, 'depth fade (m)'],
    ['lensOpacity', 0, 1, 0.01, 'opacity']
  ],
  'Motes & grit': [
    ['moteRate', 0, 700, 1, 'mote rate'],
    ['moteOpen', 0, 500, 1, 'motes on opening'],
    ['moteSize', 0.005, 0.5, 0.005, 'mote size'],
    ['moteSpeed', 0, 12, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 6, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['gritRate', 0, 300, 1, 'grit rate'],
    ['gritBreach', 0, 80, 1, 'grit per breach'],
    ['gritSize', 0.005, 0.4, 0.005, 'grit size'],
    ['gritSpeed', 0, 25, 0.1, 'grit speed'],
    ['gritLifetime', 0.1, 5, 0.05, 'grit lifetime'],
    ['gritGravity', -50, 0, 0.1, 'grit gravity'],
    ['colorMote*', 'Mote colour'],
    ['colorGrit*', 'Grit colour']
  ],
  Haze: [
    ['hazeRate', 0, 300, 1, 'haze rate'],
    ['hazeSize', 0.05, 4, 0.01, 'haze size'],
    ['hazeSpeed', 0, 8, 0.05, 'haze speed'],
    ['hazeLifetime', 0.2, 8, 0.05, 'haze lifetime'],
    ['hazeOpacity', 0, 1, 0.005, 'haze opacity'],
    ['hazeFall', -3, 2, 0.01, 'haze drift'],
    ['colorHaze*', 'Haze colour']
  ],
  'The tear': [
    ['burstSize', 0.2, 14, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['ringSpan', 0.2, 5, 0.01, 'floor ring × zone'],
    ['openFlash', 0, 2, 0.01, 'screen flash'],
    ['openShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst core'],
    ['colorRingA', 'floor ring'],
    ['colorRingB', 'floor ring crest'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'light swell'],
    ['lightPulseSpeed', 0.5, 40, 0.1, 'swell rate'],
    ['lightHeight', 0, 1, 0.01, 'light climb'],
    ['lightColor', 'light colour']
  ]
};
