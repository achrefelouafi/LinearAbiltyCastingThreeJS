/* ================================================================== */
/* REFRACTION CASCADE — lumen, line                                    */
/* ================================================================== */
/**
 * A beam that gets to the far end by bouncing.
 *
 * Three or four glass panes hang in a zig-zag down the aimed line. A shot
 * leaves the hand, strikes the first pane, comes off it at the reflected angle,
 * crosses to the second, and so on to the floor at the end of the cast — losing
 * a slice of its width and its brightness at every bounce.
 *
 * **The panes reflect the actual scene.** Each one renders the `WORLD` layer
 * from a camera mirrored about its own plane and samples that target
 * projectively, so what you see in a pane is the room *behind the camera*, and
 * it slides across the glass as you orbit. An environment map would have been a
 * tenth of the cost and reads as chrome within about half a second of movement,
 * because a reflection that does not parallax is filed by the brain as painted
 * shine. That parallax is the whole ability.
 *
 * The numbers to reach for first:
 *
 *  - `paneOffset` — how far the zig-zag throws each pane off the cast line. It
 *    is the ability's whole silhouette, and because each pane's *normal is
 *    derived from the two legs meeting on it* rather than authored, dragging it
 *    re-aims every pane at once. Pause and drag it: the beam stays a legal
 *    reflection at every value.
 *  - `paneCount` — one to four. Four is a wall of glass and two nested scene
 *    renders a frame; the module's budget picks which two of the four actually
 *    re-render, by apparent size and by how long each has been waiting.
 *  - `paneRoughness` — 0 is a black mirror, 0.4 is scuffed glass. This is the
 *    single slider that decides whether the cascade reads as jewellery or as
 *    industrial.
 *  - `bounceLoss` — width and brightness kept per bounce. At 1 the fourth leg
 *    is as hot as the first, which says the mirrors are amplifiers.
 *
 * ### On the cost that is not a draw call
 *
 * Five draw calls: four panes and one beam. But every pane that renders is an
 * extra full traversal of the `WORLD` layer — a scene graph walk, a render
 * list, a sort and every opaque draw again — so `vfx/Mirror.js` caps the number
 * that may re-render in one frame at two and hands the slots out on
 * `priority × apparent size × (1 + frames since it last rendered)`. At 60 Hz
 * with four panes that is a 30–50 ms old reflection on the ones that miss,
 * which is invisible on a slow orbit. `paneResolution` is the other half of the
 * bill: at 320² a reflection is a tenth of a 1080p frame and about 800 kB of
 * half-float colour, per pane.
 *
 * ### Why the beam's twenty-six keys are not a `Tube` prefix
 *
 * `vfx/Tube.js` is three draw calls for one tube and does not instance, so four
 * legs would be twelve. `materials/CascadeBeamMaterial.js` is the same
 * parameter-space grid instanced by leg — one draw call for the whole cascade,
 * with each instance looking its own endpoints up out of a uniform array. The
 * keys below are that material's contract.
 */
export const refractcascade = {
  /* --- the cast --- */
  range: 26.0, // maximum cast distance, metres
  minRange: 6.0, // closer than this and the zig-zag has no room
  speed: 42.0, // how fast the front runs down the *line*, metres/second
  lifetime: 1.6, // seconds the cascade holds once it has landed
  fadeTime: 0.8, // seconds it lets go over
  cooldown: 1.1,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the shot leaves the caster --- */
  handHeight: 1.3, // metres above the floor
  handForward: 0.6, // metres in front of the caster
  handSide: 0.18, // metres to the side (+ follows `Ability#side`)
  endHeight: 0.3, // metres above the floor where the last leg lands

  /* --- the panes --- */
  // `paneFirst`/`paneLast` are fractions of the cast's own length, so the whole
  // zig-zag stretches with the aim instead of bunching at the caster.
  paneCount: 3, // 1..4 — see the budget note in the header
  paneFirst: 0.24, // fraction of the span the first pane sits at
  paneLast: 0.84, // ... and the last
  paneSide: 1, // which side the first pane is on; the sign is all that is read
  paneOffset: 2.5, // metres the zig-zag throws a pane off the line
  paneOffsetTaper: 0.86, // multiplier per pane — the zig-zag narrows downrange
  paneAltitude: 1.95, // metres above the floor, first pane
  paneRise: 0.22, // metres added per pane
  paneBob: 0.1, // metres of vertical drift
  paneBobSpeed: 0.38, // Hz of that drift
  paneRoll: 0.22, // radians each pane is rolled about its own normal
  paneRollStep: 0.4, // radians added per pane
  paneStagger: 0.16, // fraction of the span a pane fades in over, before the beam
  paneWidth: 2.3, // metres across
  paneTall: 2.9, // metres up
  paneGrowScale: 0.55, // how small a pane starts, × its final size

  /* --- the glass (vfx/Mirror) --- */
  paneResolution: 320, // square reflection target, pixels — the real cost
  paneReflectivity: 0.92, // how much of the reflection survives
  paneFresnel: 0.4, // extra reflectivity at a grazing angle
  paneFresnelPower: 2.6,
  paneRoughness: 0.14, // 0 is a black mirror
  paneBlurRadius: 0.03, // the blur kernel at roughness 1, in target UV
  paneBlurTaps: 8, // 1..12
  paneRoughStretch: 1.3, // how far the lobe smears along the view-vertical
  paneRipple: 0.1, // world-space disturbance on the lookup
  paneRippleScale: 1.6, // features per metre
  paneRippleSpeed: 0.4,
  paneOpacity: 0.96,
  paneEdgeFade: 0.14, // fraction of the surface the edge feathers over
  paneCorner: 0.15, // 0 rectangle, 1 ellipse
  panePriority: 1.0, // weight against the two-reflections-a-frame budget
  colorPaneTint: '#e8f4ff', // multiplies the reflection — glass is not neutral
  colorPaneBase: '#0b1220', // what shows where it does not reflect

  /* --- the beam (materials/CascadeBeamMaterial.js) --- */
  beamRadiusNear: 0.1, // half-width at the muzzle, metres
  beamRadiusFar: 0.065, // ... at the far end
  beamRadiusCurve: 1.1, // >1 stays fat and thins late
  beamThrob: 0.07, // fraction of the radius that pulses
  beamThrobBands: 6, // pulses along the whole cascade
  beamThrobSpeed: 5.0, // radians/second they slide at
  beamTipSoft: 0.018, // fraction of the path the drawn tip tapers over
  bounceLoss: 0.86, // width and brightness kept per bounce
  beamCoreSharp: 2.1, // how fast the body falls off toward the silhouette
  beamCoreTight: 3.6, // how small the white centre is
  beamRimPower: 2.6, // how tight the glass edge is
  beamRim: 0.95, // how strong it is
  beamBands: 8, // travelling energy bands along the path
  beamBandDepth: 0.42,
  beamBandSpeed: 6.5, // radians/second
  beamBandStagger: 1.2, // radians of phase added per leg
  beamGrain: 0.32, // longitudinal noise on the body
  beamGrainScale: 13,
  beamGrainSpeed: 1.5,
  beamTipGlow: 2.4, // extra heat right behind the travelling front
  beamTipLength: 0.05, // how far back that reaches, fraction of the path
  beamGlow: 3.0, // overall emissive gain
  beamOpacity: 1.0,
  beamSoftFade: 0.35, // metres of soft fade where a leg meets geometry
  colorBeamCore: '#ffffff', // the centre of a leg
  colorBeamInner: '#fff0cc',
  colorBeamOuter: '#ffb43c', // the outside of it
  colorBeamHalo: '#4fd0ff', // the rim — the cold side of the split

  /* --- sparks, motes and dust --- */
  /**
   * Each system is coloured by a four-stop gradient sampled over the particle's
   * own lifetime, `A` at birth through `D` as it dies. Spelled out rather than
   * derived from the beam palette, so the bounce sparks can be made to cool to
   * blue while the beam stays gold.
   */
  sparkRate: 90, // sparks shed along the beam, particles/second
  sparkSize: 0.11,
  sparkSpeed: 5.5,
  sparkLifetime: 0.55,
  sparkGravity: -6.0,
  sparkStretch: 0.2, // how far a spark smears along its velocity
  colorSparkA: '#ffffff',
  colorSparkB: '#fff0cc',
  colorSparkC: '#ffb43c',
  colorSparkD: '#5a2a05',
  moteRate: 70, // glass dust hanging around the panes, particles/second
  moteSize: 0.045,
  moteSpeed: 0.7,
  moteLifetime: 2.0,
  moteRise: 0.25, // upward drift, metres/second
  moteTurbulence: 0.5,
  moteScatter: 1.4, // metres around a pane the dust is seeded in
  colorMoteA: '#ffffff',
  colorMoteB: '#cfe8ff',
  colorMoteC: '#6fb0e0',
  colorMoteD: '#10243a',
  dustRate: 26, // dust off the floor where the last leg lands
  dustSize: 0.7,
  dustSpeed: 1.1,
  dustLifetime: 1.8,
  dustOpacity: 0.08,
  dustRise: 0.5,
  colorDustA: '#4d4a44',
  colorDustB: '#3d3a35',
  colorDustC: '#2e2c28',
  colorDustD: '#191817',

  /* --- dynamic light --- */
  lightIntensity: 24,
  lightRadius: 14,
  lightColor: '#ffd8a0',
  lightPulse: 0.14, // depth of the light's breathing, 0 = steady
  lightPulseSpeed: 3.2, // Hz

  /* --- the beats --- */
  muzzleSize: 0.5, // the flash at the hand, metres
  muzzleIntensity: 1.7,
  castFlash: 0.09, // screen flash on release
  colorMuzzleA: '#ffb43c',
  colorMuzzleB: '#fff0cc',
  colorMuzzleC: '#ffffff',
  colorCastFlash: '#ffe9c4',
  bounceSize: 0.9, // the shell thrown at each pane, metres
  bounceIntensity: 1.5,
  bounceSparks: 55, // sparks thrown at each pane
  bounceFlash: 0.05, // screen flash per bounce
  colorBounceA: '#4fd0ff',
  colorBounceB: '#fff0cc',
  colorBounceC: '#ffffff',
  burstSize: 2.4, // the shell where the last leg lands, metres
  burstIntensity: 1.6,
  burstSparks: 140,
  burstDust: 40,
  shockRadius: 5.0, // impact shockwave ring, metres
  colorShockA: '#ffe4a8',
  colorShockB: '#ffffff',
  scorchRadius: 0.7, // burn mark where it lands, metres
  scorchLife: 5.5,
  scorchIntensity: 0.5,
  colorScorch: '#120d08',
  colorEmber: '#ff9a2a',
  impactShake: 0.6,
  shakeDuration: 0.5,
  impactFlash: 0.22,
  colorFlash: '#fff2d8', // the full-screen flash on impact
  rumble: 0.018 // continuous shake while the cascade stands
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Refraction Cascade.
 *
 * **The zig-zag** is the folder that changes what this looks like; **The
 * glass** is the folder that changes what it costs. Everything in both
 * re-resolves on the frame it moves, which matters more here than usual: each
 * pane's normal is the bisector of the two legs meeting on it, so a slider that
 * moves a pane also re-aims it, and the beam is still a legal reflection at
 * every value on the way.
 */
export const refractcascadeSchema = {
  'The cast': [
    ['range', 6, 60, 0.1, 'max range'],
    ['minRange', 0, 16, 0.1, 'min range'],
    ['speed', 4, 200, 0.5, 'front speed'],
    ['lifetime', 0.1, 8, 0.05, 'hold time'],
    ['fadeTime', 0.05, 4, 0.01, 'fade time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where it leaves the hand': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['endHeight', 0, 4, 0.01, 'height at target']
  ],
  'The zig-zag': [
    ['paneCount', 1, 4, 1, 'panes'],
    ['paneFirst', 0.02, 0.95, 0.01, 'first pane (× span)'],
    ['paneLast', 0.05, 0.98, 0.01, 'last pane (× span)'],
    ['paneSide', -1, 1, 1, 'first pane side'],
    ['paneOffset', 0, 8, 0.05, 'lateral throw (m)'],
    ['paneOffsetTaper', 0.3, 1.4, 0.01, 'throw taper / pane'],
    ['paneAltitude', 0.2, 8, 0.05, 'altitude (m)'],
    ['paneRise', -1, 2, 0.01, 'rise / pane (m)'],
    ['paneBob', 0, 1, 0.005, 'bob (m)'],
    ['paneBobSpeed', 0, 3, 0.01, 'bob Hz'],
    ['paneRoll', -3.1416, 3.1416, 0.01, 'roll (rad)'],
    ['paneRollStep', -1.6, 1.6, 0.01, 'roll / pane (rad)'],
    ['paneStagger', 0.01, 0.6, 0.005, 'fade-in lead (× span)'],
    ['paneWidth', 0.2, 8, 0.05, 'pane width (m)'],
    ['paneTall', 0.2, 8, 0.05, 'pane height (m)'],
    ['paneGrowScale', 0.05, 1, 0.01, 'start size ×']
  ],
  'The glass': [
    ['paneResolution', 64, 1024, 32, 'reflection target (px)'],
    ['paneReflectivity', 0, 1.5, 0.01, 'reflectivity'],
    ['paneFresnel', 0, 1.5, 0.01, 'fresnel'],
    ['paneFresnelPower', 0.2, 8, 0.05, 'fresnel power'],
    ['paneRoughness', 0, 1, 0.005, 'roughness'],
    ['paneBlurRadius', 0, 0.2, 0.001, 'blur radius'],
    ['paneBlurTaps', 1, 12, 1, 'blur taps'],
    ['paneRoughStretch', 0, 4, 0.01, 'lobe stretch'],
    ['paneRipple', 0, 1, 0.005, 'ripple'],
    ['paneRippleScale', 0.05, 6, 0.01, 'ripple scale'],
    ['paneRippleSpeed', 0, 4, 0.01, 'ripple speed'],
    ['paneOpacity', 0, 1, 0.01, 'opacity'],
    ['paneEdgeFade', 0, 0.6, 0.005, 'edge fade'],
    ['paneCorner', 0, 1, 0.01, 'corner (0 rect, 1 ellipse)'],
    ['panePriority', 0, 4, 0.05, 'budget priority'],
    ['colorPaneTint', 'reflection tint'],
    ['colorPaneBase', 'unreflected base']
  ],
  'The beam/Profile': [
    ['beamRadiusNear', 0.005, 1, 0.005, 'radius at hand (m)'],
    ['beamRadiusFar', 0.005, 1, 0.005, 'radius at target (m)'],
    ['beamRadiusCurve', 0.05, 5, 0.01, 'radius curve'],
    ['beamThrob', 0, 0.6, 0.005, 'throb'],
    ['beamThrobBands', 0, 24, 0.1, 'throb bands'],
    ['beamThrobSpeed', 0, 20, 0.05, 'throb speed'],
    ['beamTipSoft', 0.002, 0.2, 0.001, 'tip taper'],
    ['bounceLoss', 0.2, 1, 0.005, 'kept per bounce']
  ],
  'The beam/Shading': [
    ['beamCoreSharp', 0.05, 8, 0.01, 'body falloff'],
    ['beamCoreTight', 0.05, 12, 0.01, 'white centre'],
    ['beamRimPower', 0.05, 8, 0.01, 'rim power'],
    ['beamRim', 0, 3, 0.01, 'rim strength'],
    ['beamBands', 0, 40, 0.1, 'energy bands'],
    ['beamBandDepth', 0, 2, 0.01, 'band depth'],
    ['beamBandSpeed', -30, 30, 0.1, 'band speed'],
    ['beamBandStagger', -3.1416, 3.1416, 0.01, 'band phase / leg'],
    ['beamGrain', 0, 2, 0.01, 'grain'],
    ['beamGrainScale', 0.5, 40, 0.5, 'grain scale'],
    ['beamGrainSpeed', 0, 8, 0.05, 'grain speed'],
    ['beamTipGlow', 0, 8, 0.05, 'front glow'],
    ['beamTipLength', 0.002, 0.4, 0.002, 'front length'],
    ['beamGlow', 0, 8, 0.01, 'glow'],
    ['beamOpacity', 0, 2, 0.01, 'opacity'],
    ['beamSoftFade', 0.02, 3, 0.01, 'soft intersection (m)'],
    ['colorBeamCore', 'core'],
    ['colorBeamInner', 'inner'],
    ['colorBeamOuter', 'outer'],
    ['colorBeamHalo', 'rim halo']
  ],
  'Sparks, motes & dust': [
    ['sparkRate', 0, 600, 1, 'spark rate'],
    ['sparkSize', 0.005, 0.6, 0.005, 'spark size'],
    ['sparkSpeed', 0, 30, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 4, 0.01, 'spark lifetime'],
    ['sparkGravity', -40, 10, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['moteRate', 0, 400, 1, 'mote rate'],
    ['moteSize', 0.005, 0.3, 0.005, 'mote size'],
    ['moteSpeed', 0, 6, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -2, 4, 0.01, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['moteScatter', 0.05, 5, 0.05, 'mote scatter (m)'],
    ['dustRate', 0, 300, 1, 'dust rate'],
    ['dustSize', 0.05, 3, 0.01, 'dust size'],
    ['dustSpeed', 0, 6, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['colorSpark*', 'Spark colour'],
    ['colorMote*', 'Mote colour'],
    ['colorDust*', 'Dust colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'breathing depth'],
    ['lightPulseSpeed', 0, 20, 0.05, 'breathing Hz'],
    ['lightColor', 'light colour']
  ],
  'The beats': [
    ['muzzleSize', 0.05, 6, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorMuzzleA', 'muzzle shell'],
    ['colorMuzzleB', 'muzzle body'],
    ['colorMuzzleC', 'muzzle core'],
    ['colorCastFlash', 'release flash'],
    ['bounceSize', 0.05, 5, 0.05, 'bounce shell (m)'],
    ['bounceIntensity', 0, 5, 0.01, 'bounce intensity'],
    ['bounceSparks', 0, 400, 1, 'bounce sparks'],
    ['bounceFlash', 0, 1, 0.005, 'bounce screen flash'],
    ['colorBounceA', 'bounce shell'],
    ['colorBounceB', 'bounce body'],
    ['colorBounceC', 'bounce core'],
    ['burstSize', 0.2, 12, 0.05, 'impact shell (m)'],
    ['burstIntensity', 0, 5, 0.01, 'impact intensity'],
    ['burstSparks', 0, 600, 1, 'impact sparks'],
    ['burstDust', 0, 300, 1, 'impact dust'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest'],
    ['scorchRadius', 0.05, 4, 0.05, 'scorch radius'],
    ['scorchLife', 0.5, 20, 0.1, 'scorch lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'scorch intensity'],
    ['colorScorch', 'scorch'],
    ['colorEmber', 'ember'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['colorFlash', 'impact flash colour'],
    ['rumble', 0, 0.3, 0.001, 'hold rumble']
  ]
};
