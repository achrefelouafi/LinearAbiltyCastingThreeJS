/* ================================================================== */
/* SPELLBREAK — arcane, zone cast                                      */
/* ================================================================== */
/**
 * A bell of arcane glass closes over the zone, holds, and is broken.
 *
 * Every other block in this directory describes something its ability
 * *draws*. A third of this one describes something it **publishes**: the
 * `Hook.DISRUPT` region in `vfx/SceneHooks.js`, which is a sphere in world
 * metres plus three 0..1 powers, read by every material that has opted in.
 * Cast into an empty room and those sliders do nothing you can see; cast into
 * a standing Nova Beam and they are the whole ability.
 *
 * The field folder is therefore first, and it is worth dragging **with another
 * cast standing in the zone and the clock paused** — which is the only way to
 * see what any of it does.
 *
 * Two numbers are deliberately independent and deliberately related.
 * `shardPixels` is the size of a fracture cell in *device pixels*, and
 * `paneSize` is the size of one of this ability's own glass fragments in
 * *metres*. They are separate controls because one is measured on the screen
 * and the other in the world and no honest formula relates them; they are
 * meant to be tuned until they read as the same substance breaking. Push them
 * far apart and the cast stops being one event.
 *
 * Keys prefixed `glass*` are the `vfx/Shell.js` contract, written out longhand
 * from `shellDefaults('glass', ShellMode.DOME)` so the module's audit stays
 * quiet. The ones belonging to `CONE`, `RING_TRAIN` and `SUNDISC` are inert in
 * this mode and are filed together at the end rather than hidden. **There is
 * no `glassRadius` or `glassRadiusEnd`** — those two are the one thing the
 * ability computes rather than authors, from `zoneRadius` and the two
 * fractions below, so the glass and the aim circle can never come unstuck. See
 * the overlay note in `SpellbreakAbility`.
 */
export const spellbreak = {
  /* --- the cast --- */
  range: 20.0, //         maximum cast distance, metres
  minRange: 2.5, //       closer than this and the cast is refused
  speed: 58.0, //         how fast the null front travels, metres/second
  cooldown: 1.4, //       seconds
  castAnim: 'cast1', //   which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 5.0, //     the footprint the aim circle measures out, metres

  sealTime: 0.24, //      seconds the bell takes to close over the zone
  holdTime: 0.42, //      seconds it stands intact before it is broken
  ringTime: 0.85, //      seconds the pressure ring takes to cross the zone
  fadeTime: 1.2, //       seconds the panes have to fall and the field to let go

  /* ------------------------------------------------------------------ */
  /* The disruption field — what this cast does to the other casts       */
  /* ------------------------------------------------------------------ */
  fieldSpan: 1.12, //     region radius, × zoneRadius (a little past the glass)
  fieldLift: 1.15, //     metres above the floor the sphere is centred on
  fieldEdge: 0.34, //     0..1 of the radius the field softens over
  warnSpan: 0.5, //       region radius while the front is travelling, × fieldSpan
  warnDrain: 0.5, //      0..1 desaturation during that warning
  warnDim: 0.14, //       0..1 dimming during that warning
  drain: 1.0, //          0..1 desaturation once the bell has closed
  dim: 0.44, //           0..1 dimming once the bell has closed
  fracture: 0.16, //      0..1 cell erosion while the bell merely stands
  fractureBite: 0.88, //  0..1 peak cell erosion on the frame the bell breaks
  fractureFall: 0.62, //  seconds that peak decays back to `fracture` over
  shardPixels: 9.0, //    device pixels per fracture cell — bigger cells, bigger shards
  releaseCurve: 2.1, //   >1 holds the field then drops it; 1 lets go evenly

  /* ------------------------------------------------------------------ */
  /* The bell of arcane glass — vfx/Shell.js, prefix `glass`, mode DOME  */
  /* ------------------------------------------------------------------ */
  domeStart: 0.18, //     dome radius as the bell begins to close, × zoneRadius
  domeSpan: 1.0, //       dome radius once it has closed, × zoneRadius
  glassExpand: 3.4, //    easing exponent on that closure
  glassHeight: 0.72, //   axial extent, × radius — a bell, not a hemisphere
  glassLift: 0.02, //     metres it hovers above the floor
  glassDisplace: 0.05, // billow along the normal, × radius. Glass barely billows.
  glassNoiseScale: 3.2, // billow features per unit radius
  glassNoiseSpeed: 0.22, // Hz the billow crawls at
  glassTurbulence: 1.0, // master on the billow
  glassFill: 0.1, //      body fill — glass is nearly all rim
  glassRim: 1.9, //       strength of the fresnel rim
  glassRimPower: 2.9, //  how tight that rim is
  glassSeal: 1.6, //      brightness where the bell meets the floor
  glassSealWidth: 0.09, // how wide that seal band is, fraction of the sweep
  glassDissolve: 1.35, // how hard the age dissolve bites as it goes
  glassOpacity: 0.86,
  glassGlow: 2.2, //      emissive gain into bloom
  glassSoftFade: 0.5, //  metres of depth fade against the opaque scene
  glassColorBody: '#2a3f6e', //   the body of the glass
  glassColorRim: '#9fd8ff', //    its fresnel rim and its floor seal
  glassColorEdge: '#ffffff', //   the hottest mark it has

  /* --- Shell keys the DOME mode never reads. Present for the audit. --- */
  glassSpan: 6.0, //      CONE / RING_TRAIN run length, metres
  glassEdge: 1.2, //      CONE: brightness of the leading lip
  glassEdgeWidth: 0.16, // CONE: width of that lip
  glassConeCurve: 1.0, // CONE: flare curve
  glassRings: 10, //      RING_TRAIN: live instance count
  glassSpacing: 1.6, //   RING_TRAIN: wavelength, metres
  glassRingSpeed: 7.0,
  glassRingThickness: 0.16,
  glassRingSharp: 1.6,
  glassReflect: 1.0,
  glassStanding: 1.0,
  glassSwell: 0.45,
  glassCoronaReach: 1.8, // SUNDISC: drawn reach past the rim, × radius
  glassCorona: 1.3,
  glassCoronaLength: 0.55,
  glassCoronaScale: 5.0,
  glassCoronaWarp: 0.45,
  glassCoronaSpeed: 0.7,
  glassCoronaSharp: 0.72,
  glassGranule: 0.45,
  glassGranuleScale: 6.0,
  glassRimWidth: 0.18,
  glassColorCorona: '#ffd27a', // SUNDISC filaments

  /* ------------------------------------------------------------------ */
  /* The panes it breaks into — vfx/ShatterField.js                      */
  /* ------------------------------------------------------------------ */
  paneCount: 96, //       fragments thrown when the bell goes
  paneSides: 6, //        corners on one pane, 3–8 (geometry; rebuilt on change)
  paneThickness: 0.1, //  pane thickness as a fraction of its width
  paneRagged: 0.45, //    0..1 how far the corners wander off a regular polygon
  paneSpawnSpan: 0.9, //  the annulus the panes come off, × zoneRadius
  paneSpawnHeight: 0.85, // metres above the floor the anchor sits
  paneSpawnRadius: 0.35, // metres of scatter about that anchor
  paneSize: 0.42, //      metres, the unit geometry's scale
  paneSizeJitter: 0.6, // ± fraction
  paneSpeed: 5.4, //      metres/second a pane leaves at
  paneSpeedJitter: 0.65, // ± fraction
  paneSpread: 0.72, //    0 throws every pane downrange, 1 is fully random
  paneUp: 0.55, //        how much +Y is folded into the throw, 0..1
  paneGravity: -16.0, //  metres/second², signed
  paneDrag: 0.9, //       1/second; 0 is pure ballistics
  paneSpin: 7.5, //       radians/second of tumble
  paneSpinJitter: 0.85, // ± fraction
  paneLifetime: 1.5, //   seconds a pane lives
  paneShrink: 0.55, //    0..1 of its size lost by the end of life
  paneShrinkPower: 2.0, // how late that shrink bites
  paneFloorSpin: 0.2, //  fraction of the tumble kept once it is grounded
  paneOpacity: 0.92,
  paneGlow: 1.5, //       gain on the edge term only; the body never glows
  paneRim: 1.1,
  paneRimPower: 2.2,
  paneShade: 1.0, //      how much the key light models the pane
  paneAmbient: 0.34,
  paneFadeStart: 0.55, // 0..1 of life before it starts fading
  paneSoft: 0.3, //       metres of soft fade where a pane meets the floor
  paneSceneMix: 0.7, //   how much of the scene behind shows through
  paneRefract: 0.045, //  screen-space offset of that lookup
  paneSaturation: 0.22, // how much colour survives in what shows through
  colorPaneA: '#cfe8ff', //   a pane at birth
  colorPaneB: '#3c5f96', //   ... and as it dies
  colorPaneEdge: '#ffffff', // its fresnel edge
  colorPaneScene: '#9fb6d8', // tint on whatever shows through it

  /* ------------------------------------------------------------------ */
  /* The push — vfx/Distortion.js, SHOCK                                 */
  /* ------------------------------------------------------------------ */
  pushSpan: 1.6, //       the emitter quad's half-extent, × zoneRadius
  pushLift: 0.9, //       metres above the floor the emitter is anchored
  pushStrength: 0.05, //  screen widths at post.distortion = 1. Not metres.
  pushWindow: 0.9, //     0..1 of the radius the effect is windowed into
  pushMaxOffset: 0.1, //  hard clamp on the offset, screen widths
  pushThickness: 0.55, // metres of the wavefront
  pushCompression: 1.0, // the leading half of the wave
  pushRarefaction: 0.7, // the trailing half
  pushRings: 2, //        1..4
  pushRingGap: 1.3, //    metres between them
  pushRingDecay: 0.55, // how much weaker each following ring is
  pushDepthFade: 0.4, //  metres of depth fade at the silhouette
  pushOpacity: 1.0,

  /* ------------------------------------------------------------------ */
  /* Particles                                                           */
  /* ------------------------------------------------------------------ */
  glintRate: 130, //      glints off the standing bell, particles/second
  glintBreak: 260, //     extra glints thrown on the break
  glintSize: 0.12,
  glintSpeed: 6.5,
  glintLifetime: 0.62,
  glintGravity: -9.0,
  glintStretch: 0.22, //  how far a glint smears along its velocity
  colorGlintA: '#ffffff',
  colorGlintB: '#cfe8ff',
  colorGlintC: '#6fa8e8',
  colorGlintD: '#16294a',

  // The drained colour, leaving. Slow and wide, and the one system meant to be
  // read as coming off *other people's spells* rather than off the glass.
  dustRate: 110, //       particles/second
  dustBreak: 180, //      extra thrown on the break
  dustSize: 0.09,
  dustSpeed: 1.3,
  dustLifetime: 2.1,
  dustRise: 0.75, //      upward drift, metres/second
  dustTurbulence: 0.85,
  colorDustA: '#b9c6d8',
  colorDustB: '#8f9db2',
  colorDustC: '#5c6a7e',
  colorDustD: '#20262f',

  gritRate: 34, //        glass powder off the floor, particles/second
  gritBreak: 90,
  gritSize: 0.05,
  gritSpeed: 4.2,
  gritLifetime: 1.3,
  gritGravity: -19.0,
  colorGritA: '#8fa6c4',
  colorGritB: '#5d6f8c',
  colorGritC: '#39465a',
  colorGritD: '#232a35',

  /* --- dynamic light --- */
  lightIntensity: 15.0,
  lightRadius: 14.0,
  lightColor: '#9fd8ff',
  lightPulse: 0.35, //    depth of the light's swell, 0 = steady
  lightPulseSpeed: 7.0,

  /* --- the break --- */
  burstSize: 3.2, //      the shell of dead air at the break, metres
  burstIntensity: 1.2,
  colorBurstA: '#2a3f6e',
  colorBurstB: '#9fd8ff',
  colorBurstC: '#ffffff',
  shockSpan: 1.9, //      the floor ring at the break, × zoneRadius
  colorShockA: '#9fd8ff',
  colorShockB: '#ffffff',
  breakFlash: 0.2, //     screen flash on the break
  colorFlash: '#cfe8ff',
  breakShake: 0.7,
  shakeDuration: 0.5,
  rumble: 0.022 //        continuous shake while the front travels
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Spellbreak.
 *
 * "The field" is first because it *is* the ability. Everything below it is the
 * cast telling you the field is there.
 */
export const spellbreakSchema = {
  'The field (what it does to other casts)': [
    ['fieldSpan', 0.2, 3, 0.01, 'radius × zone'],
    ['fieldLift', 0, 5, 0.01, 'centre height (m)'],
    ['fieldEdge', 0.02, 1, 0.01, 'edge softness'],
    ['warnSpan', 0, 1.5, 0.01, 'warning radius ×'],
    ['warnDrain', 0, 1, 0.01, 'warning desaturation'],
    ['warnDim', 0, 1, 0.01, 'warning dimming'],
    ['drain', 0, 1, 0.01, 'desaturation'],
    ['dim', 0, 1, 0.01, 'dimming'],
    ['fracture', 0, 1, 0.01, 'standing erosion'],
    ['fractureBite', 0, 1, 0.01, 'erosion at the break'],
    ['fractureFall', 0.05, 3, 0.01, 'erosion decay (s)'],
    ['shardPixels', 1, 40, 0.5, 'shard cell (px)'],
    ['releaseCurve', 0.5, 6, 0.05, 'let-go curve']
  ],
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'null-front speed'],
    ['zoneRadius', 1, 14, 0.1, 'zone radius'],
    ['sealTime', 0.02, 2, 0.01, 'bell closes over'],
    ['holdTime', 0.02, 4, 0.01, 'bell holds for'],
    ['ringTime', 0.05, 4, 0.01, 'push ring crossing'],
    ['fadeTime', 0.05, 5, 0.01, 'let-go time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The bell': [
    ['domeStart', 0.01, 1.5, 0.01, 'start radius × zone'],
    ['domeSpan', 0.1, 2, 0.01, 'closed radius × zone'],
    ['glassExpand', 0.2, 12, 0.01, 'closure curve'],
    ['glassHeight', 0.02, 3, 0.01, 'height × radius'],
    ['glassLift', -1, 1, 0.001, 'lift (m)'],
    ['glassDisplace', 0, 1.5, 0.01, 'billow'],
    ['glassNoiseScale', 0.1, 10, 0.01, 'billow scale'],
    ['glassNoiseSpeed', 0, 4, 0.01, 'billow Hz'],
    ['glassTurbulence', 0, 3, 0.01, 'turbulence']
  ],
  'The bell/Shading': [
    ['glassFill', 0, 1, 0.01, 'body fill'],
    ['glassRim', 0, 4, 0.01, 'rim'],
    ['glassRimPower', 0.1, 8, 0.01, 'rim power'],
    ['glassSeal', 0, 4, 0.01, 'floor seal'],
    ['glassSealWidth', 0.01, 0.6, 0.005, 'seal width'],
    ['glassDissolve', 0, 3, 0.01, 'dissolve'],
    ['glassOpacity', 0, 1, 0.01, 'opacity'],
    ['glassGlow', 0, 8, 0.01, 'glow'],
    ['glassSoftFade', 0, 3, 0.01, 'soft fade (m)'],
    ['glassColorBody', 'glass body'],
    ['glassColorRim', 'glass rim'],
    ['glassColorEdge', 'glass edge']
  ],
  'The panes': [
    ['paneCount', 0, 180, 1, 'panes thrown'],
    ['paneSides', 3, 8, 1, 'corners per pane'],
    ['paneThickness', 0.01, 0.5, 0.005, 'thickness × width'],
    ['paneRagged', 0, 1, 0.01, 'corner wander'],
    ['paneSpawnSpan', 0, 2, 0.01, 'break annulus × zone'],
    ['paneSpawnHeight', 0, 4, 0.01, 'break height (m)'],
    ['paneSpawnRadius', 0, 2, 0.01, 'break scatter (m)'],
    ['paneSize', 0.02, 2, 0.01, 'pane size (m)'],
    ['paneSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['paneSpeed', 0, 25, 0.1, 'throw speed'],
    ['paneSpeedJitter', 0, 1, 0.01, 'speed jitter'],
    ['paneSpread', 0, 1, 0.01, 'throw spread'],
    ['paneUp', 0, 1, 0.01, 'upward bias'],
    ['paneGravity', -50, 5, 0.1, 'gravity'],
    ['paneDrag', 0, 5, 0.01, 'drag'],
    ['paneSpin', 0, 30, 0.1, 'tumble'],
    ['paneSpinJitter', 0, 1, 0.01, 'tumble jitter'],
    ['paneLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['paneShrink', 0, 1, 0.01, 'shrink'],
    ['paneShrinkPower', 0.2, 6, 0.05, 'shrink curve'],
    ['paneFloorSpin', 0, 1, 0.01, 'grounded tumble']
  ],
  'The panes/Shading': [
    ['paneOpacity', 0, 1, 0.01, 'opacity'],
    ['paneGlow', 0, 4, 0.01, 'edge glow'],
    ['paneRim', 0, 3, 0.01, 'rim'],
    ['paneRimPower', 0.2, 8, 0.05, 'rim power'],
    ['paneShade', 0, 1, 0.01, 'key light'],
    ['paneAmbient', 0, 1, 0.01, 'ambient'],
    ['paneFadeStart', 0, 1, 0.01, 'fade start'],
    ['paneSoft', 0, 2, 0.01, 'soft fade (m)'],
    ['paneSceneMix', 0, 1, 0.01, 'scene through'],
    ['paneRefract', 0, 0.3, 0.001, 'refraction'],
    ['paneSaturation', 0, 1, 0.01, 'scene saturation'],
    ['colorPaneA', 'pane at birth'],
    ['colorPaneB', 'pane at death'],
    ['colorPaneEdge', 'pane edge'],
    ['colorPaneScene', 'scene tint']
  ],
  'The push': [
    ['pushSpan', 0.2, 4, 0.01, 'radius × zone'],
    ['pushLift', 0, 5, 0.01, 'anchor height (m)'],
    ['pushStrength', 0, 0.3, 0.001, 'strength (screen)'],
    ['pushWindow', 0.1, 1, 0.01, 'window'],
    ['pushMaxOffset', 0.01, 0.4, 0.005, 'max offset'],
    ['pushThickness', 0.05, 4, 0.01, 'wavefront (m)'],
    ['pushCompression', 0, 3, 0.01, 'compression'],
    ['pushRarefaction', 0, 3, 0.01, 'rarefaction'],
    ['pushRings', 1, 4, 1, 'rings'],
    ['pushRingGap', 0.1, 6, 0.05, 'ring gap (m)'],
    ['pushRingDecay', 0, 1, 0.01, 'ring decay'],
    ['pushDepthFade', 0, 3, 0.01, 'depth fade (m)'],
    ['pushOpacity', 0, 1, 0.01, 'opacity']
  ],
  'Glints & drained colour': [
    ['glintRate', 0, 800, 1, 'glint rate'],
    ['glintBreak', 0, 900, 1, 'glints on break'],
    ['glintSize', 0.005, 0.6, 0.005, 'glint size'],
    ['glintSpeed', 0, 30, 0.1, 'glint speed'],
    ['glintLifetime', 0.05, 4, 0.01, 'glint lifetime'],
    ['glintGravity', -50, 5, 0.1, 'glint gravity'],
    ['glintStretch', 0, 3, 0.01, 'glint stretch'],
    ['dustRate', 0, 600, 1, 'dust rate'],
    ['dustBreak', 0, 700, 1, 'dust on break'],
    ['dustSize', 0.005, 0.5, 0.005, 'dust size'],
    ['dustSpeed', 0, 12, 0.05, 'dust speed'],
    ['dustLifetime', 0.1, 8, 0.05, 'dust lifetime'],
    ['dustRise', -3, 6, 0.05, 'dust rise'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['colorGlint*', 'Glint colour'],
    ['colorDust*', 'Drained colour']
  ],
  Grit: [
    ['gritRate', 0, 300, 1, 'grit rate'],
    ['gritBreak', 0, 400, 1, 'grit on break'],
    ['gritSize', 0.005, 0.4, 0.005, 'grit size'],
    ['gritSpeed', 0, 25, 0.1, 'grit speed'],
    ['gritLifetime', 0.1, 5, 0.05, 'grit lifetime'],
    ['gritGravity', -50, 0, 0.1, 'grit gravity'],
    ['colorGrit*', 'Grit colour']
  ],
  'The break': [
    ['burstSize', 0.2, 14, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['shockSpan', 0.2, 5, 0.01, 'floor ring × zone'],
    ['breakFlash', 0, 2, 0.01, 'screen flash'],
    ['breakShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst core'],
    ['colorShockA', 'floor ring'],
    ['colorShockB', 'floor ring crest'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'light swell'],
    ['lightPulseSpeed', 0.5, 40, 0.1, 'swell rate'],
    ['lightColor', 'light colour']
  ],
  'Inert Shell keys (CONE / RING_TRAIN / SUNDISC)': [
    ['glassSpan', 0.1, 30, 0.1, 'run length (m)'],
    ['glassEdge', 0, 4, 0.01, 'cone lip'],
    ['glassEdgeWidth', 0.01, 0.6, 0.005, 'cone lip width'],
    ['glassConeCurve', 0.1, 4, 0.01, 'cone curve'],
    ['glassRings', 1, 24, 1, 'rings'],
    ['glassSpacing', 0.1, 8, 0.05, 'ring wavelength (m)'],
    ['glassRingSpeed', 0, 40, 0.1, 'ring speed'],
    ['glassRingThickness', 0.01, 1, 0.005, 'ring thickness'],
    ['glassRingSharp', 0.1, 6, 0.05, 'ring profile'],
    ['glassReflect', 0, 1, 0.01, 'reflection'],
    ['glassStanding', 0, 1, 0.01, 'standing envelope'],
    ['glassSwell', 0, 2, 0.01, 'antinode swell'],
    ['glassCoronaReach', 0.5, 4, 0.01, 'corona reach'],
    ['glassCorona', 0, 4, 0.01, 'corona'],
    ['glassCoronaLength', 0, 2, 0.01, 'corona length'],
    ['glassCoronaScale', 0.5, 16, 0.1, 'corona scale'],
    ['glassCoronaWarp', 0, 2, 0.01, 'corona warp'],
    ['glassCoronaSpeed', 0, 4, 0.01, 'corona Hz'],
    ['glassCoronaSharp', 0, 1, 0.01, 'corona threshold'],
    ['glassGranule', 0, 2, 0.01, 'granulation'],
    ['glassGranuleScale', 1, 20, 0.1, 'granule scale'],
    ['glassRimWidth', 0.01, 1, 0.01, 'disc rim width'],
    ['glassColorCorona', 'corona colour']
  ]
};
