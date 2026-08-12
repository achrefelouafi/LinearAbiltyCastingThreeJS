/* ================================================================== */
/* RESONANCE — aether, line cast                                       */
/* ================================================================== */
/**
 * Resonant Chord. A note struck down the aimed line: rings of compression run
 * out from the caster, **reflect off the far end**, and the outbound and
 * returning trains interfere. Where they cancel the air is dead still; where
 * they add it is violently compressed.
 *
 * **The pattern is not painted on.** `vfx/Shell.js` in `RING_TRAIN` mode folds
 * every ring off the far end (`s = span − |d − span|` on a `2·span` cycle) and
 * evaluates the superposition
 *
 * ```
 *   sin(ks − ωt) − sin(k(2L − s) − ωt) = 2·cos(kL − ωt)·sin(k(s − L))
 * ```
 *
 * so a ring standing on a node genuinely pinches to the axis and goes dark. The
 * ability asks the module where those nodes are (`nodePosition`), how strong
 * the standing wave is at a given metre (`standingAt`) and what wavelength fits
 * a whole number of half-waves on this particular cast (`resonantSpacing`), and
 * then puts the distortion pockets, the dust lift and the light on the
 * **antinodes** — and nothing whatever on the nodes. Move `halfWaves` from 8 to
 * 9 and the pockets, the dust and the dark bands all move together, because
 * they are all reading one function.
 *
 * `spacing` and `rings` are therefore *derived* while `lockSpacing` is up: a
 * wavelength that does not fit the line an exact number of times gives a
 * pattern that slides along it, which reads as "some rings are dimmer" rather
 * than as "this line is resonating". Open the lock and the two sliders take
 * over and the nodes drift, which is worth seeing once.
 *
 * Keys prefixed `chord*` are the `Shell` contract, spread verbatim from
 * `shellDefaults('chord', ShellMode.RING_TRAIN)` so the module's audit stays
 * quiet; the ones belonging to the dome, the cone and the sun disc are inert in
 * this mode and are filed together rather than hidden.
 */
export const resonance = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 64.0, // how fast the strike front runs down the line, metres/second
  lifetime: 3.2, // seconds the chord rings for
  fadeTime: 1.7, // seconds the pattern takes to damp out
  cooldown: 1.4,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the chord is strung --- */
  originForward: 0.7, // metres in front of the caster the run starts
  originSide: 0.18, // metres to the side (+ follows `Ability#side`)
  lineHeight: 1.2, // metres above the floor the whole run sits at
  establishTrips: 1.0, // crossings of the line the pattern takes to establish

  /* ------------------------------------------------------------------ */
  /* The standing wave                                                   */
  /* ------------------------------------------------------------------ */
  halfWaves: 8, // half-wavelengths that fit the line — the mode number
  lockSpacing: 1.0, // 0 uses `chordSpacing` raw, 1 locks it to the resonance
  pockets: 4, // antinodes that get a distortion pocket (capped at 4)

  /* ------------------------------------------------------------------ */
  /* The ring train — vfx/Shell.js, prefix `chord`, mode RING_TRAIN      */
  /* ------------------------------------------------------------------ */
  chordRadius: 0.3, // ring radius as the chord is struck, metres
  chordRadiusEnd: 1.35, // ... once the pattern has established, metres
  chordExpand: 2.0, // easing exponent on that growth
  chordSpan: 6.0, // run length, metres — the cast overrides this every frame
  chordLift: 0.0, // offset along the axis from the strike point, metres
  chordRings: 8, // live rings (derived from `halfWaves` while locked)
  chordSpacing: 4.4, // wavelength, metres (derived while locked)
  chordRingSpeed: 11.0, // metres/second a ring travels at
  chordRingThickness: 0.15, // radial thickness of one ring, metres
  chordRingSharp: 1.8, // how hard its profile falls off
  chordReflect: 1.0, // 0 = rings die at the far end, 1 = perfect reflection
  chordStanding: 1.0, // how much of the standing envelope modulates them
  chordSwell: 0.55, // extra radius at an antinode, × radius
  chordOpacity: 1.0,
  chordGlow: 2.4, // emissive gain into bloom
  chordSoftFade: 0.6, // metres of depth fade against the opaque scene
  chordColorBody: '#5fa0c0', // the body of a ring
  chordColorRim: '#d0f0ff', // its edge
  chordColorEdge: '#ffffff', // the hottest mark it has — antinodes only

  /* --- inert on RING_TRAIN: the dome, cone and sun-disc groups --- */
  // `Shell` reads its whole contract whatever the mode, so these keep the
  // module's audit quiet and stay reachable in the panel. Dragging one of them
  // does nothing in this mode, and that is the honest answer.
  chordHeight: 1.0, // axial extent, × radius (surface modes only)
  chordDisplace: 0.0, // billow along the normal, × radius
  chordNoiseScale: 1.8, // billow features per unit radius
  chordNoiseSpeed: 0.6, // Hz the billow crawls at
  chordTurbulence: 1.0, // master on the billow
  chordFill: 0.0, // body fill (surface modes only)
  chordRim: 1.0, // fresnel rim strength
  chordRimPower: 2.2, // how tight that rim is
  chordSeal: 1.4, // DOME: brightness where it meets the floor
  chordSealWidth: 0.12, // DOME: width of that band
  chordEdge: 1.2, // CONE: brightness of the leading lip
  chordEdgeWidth: 0.16, // CONE: width of that lip
  chordConeCurve: 1.0, // CONE: flare curve
  chordDissolve: 0.9, // age dissolve on the surface modes
  chordCoronaReach: 1.8, // SUNDISC: drawn reach past the rim, × radius
  chordCorona: 1.3, // SUNDISC: corona brightness
  chordCoronaLength: 0.55, // SUNDISC: how far the filaments reach, × radius
  chordCoronaScale: 5.0, // SUNDISC: filament features per radius
  chordCoronaWarp: 0.45, // SUNDISC: domain warp
  chordCoronaSpeed: 0.7, // SUNDISC: Hz they crawl at
  chordCoronaSharp: 0.72, // SUNDISC: threshold
  chordGranule: 0.45, // SUNDISC: convection cells
  chordGranuleScale: 6.0, // SUNDISC: cells per radius
  chordRimWidth: 0.18, // SUNDISC: hot band inside the rim, × radius
  chordColorCorona: '#ffb44a', // SUNDISC filaments

  /* ------------------------------------------------------------------ */
  /* The pockets — vfx/Distortion.js, SHOCK, one per antinode            */
  /* ------------------------------------------------------------------ */
  /**
   * A pocket is a shell of compressed air standing on an antinode. Its
   * amplitude is `standingAt()` at that metre, so the four of them pulse
   * together on the temporal term of the superposition — which is exactly what
   * a standing wave does, and it is why the nodes stay empty.
   *
   * `pocketStrength` is a **screen fraction**, not metres, and the post pass
   * applies `post.distortion × global.distortion` on top of it once. Never
   * multiply either of those in here.
   */
  pocketWidth: 4.4, // metres, the quad the pocket is drawn on
  pocketHeight: 4.4, // metres
  pocketRadius: 1.9, // metres — where the falloff reaches zero
  pocketWindow: 0.55, // 0..1 of the radius the falloff starts at
  pocketWave: 0.6, // metres — the radius of the compressed shell
  pocketThickness: 0.34, // metres — how thick that shell is
  pocketCompression: 1.15, // strength just inside the front
  pocketRarefaction: 0.75, // ... and just outside it
  pocketRings: 2, // 1..4 concentric fronts per pocket
  pocketRingGap: 0.42, // metres between them
  pocketRingDecay: 0.7, // how much dimmer each front out is
  pocketStrength: 0.055, // screen widths at post.distortion = 1
  pocketMaxOffset: 0.16, // hard ceiling on that offset
  pocketOpacity: 1.0,
  pocketDepthReject: 0.55, // 0..1 how hard geometry in front rejects it
  pocketDepthFade: 1.1, // metres of soft fade against that geometry
  pocketPerspective: 0.65, // 0..1 how much distance shrinks it
  pocketPerspectiveRef: 10, // metres at which it is drawn unscaled

  /* ------------------------------------------------------------------ */
  /* Dust, grit and sparks                                               */
  /* ------------------------------------------------------------------ */
  /**
   * Each system is coloured by a four-stop gradient sampled over the
   * particle's own lifetime, `A` at birth through `D` as it dies. The dust and
   * the grit are emitted **only at the antinodes**, with a count proportional
   * to the standing amplitude there, which is what makes the pattern legible
   * without drawing a single marker.
   */
  dustRate: 200, // motes lifted at the antinodes, particles/second (all of them)
  dustSize: 0.07,
  dustSpeed: 2.4, // metres/second off the line
  dustLifetime: 1.5,
  dustRise: 1.6, // upward drift, metres/second
  dustTurbulence: 0.5,
  colorDustA: '#ffffff',
  colorDustB: '#d0f0ff',
  colorDustC: '#5fa0c0',
  colorDustD: '#102030',
  gritRate: 60, // grit hopping off the floor under an antinode, /second
  gritSize: 0.05,
  gritSpeed: 3.6,
  gritLifetime: 1.1,
  gritGravity: -13.0, // metres/second²
  colorGritA: '#9fb8c8',
  colorGritB: '#6a8496',
  colorGritC: '#33454f',
  colorGritD: '#102030',
  sparkRate: 0, // continuous sparks — off by default; the chord is not a bolt
  sparkSize: 0.12,
  sparkSpeed: 7.5,
  sparkLifetime: 0.5,
  sparkGravity: -9.0,
  sparkStretch: 0.2, // how far a spark smears along its velocity
  colorSparkA: '#ffffff',
  colorSparkB: '#d0f0ff',
  colorSparkC: '#7fc0dc',
  colorSparkD: '#204058',

  /* --- dynamic light --- */
  lightIntensity: 12.0,
  lightRadius: 15.0,
  lightColor: '#8fd4ee',
  lightPulse: 0.55, // how much of the light rides the standing breath, 0..1

  /* --- the strike and the reflection --- */
  strikeSize: 1.6, // the shell at the caster's hand, metres
  strikeIntensity: 1.5,
  strikeSparks: 90, // sparks thrown as the chord is struck
  strikeFlash: 0.1, // screen flash on the strike
  strikeShake: 0.5,
  shakeDuration: 0.4,
  reflectSize: 2.4, // the shell at the far end when the wave turns round, metres
  reflectIntensity: 1.3,
  reflectSparks: 120, // sparks thrown by the reflection
  reflectShake: 0.7,
  rumble: 0.035, // continuous shake while the chord rings
  colorStrikeA: '#5fa0c0', // strike/reflection shell body
  colorStrikeB: '#d0f0ff', // its billow
  colorStrikeC: '#ffffff', // the filaments racing across it
  colorFlash: '#d0f0ff' // the full-screen flash
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Resonant Chord.
 *
 * **The standing wave** is the folder that matters. `halfWaves` is an integer
 * mode number: at 8 there are nine nodes and eight antinodes on the line, and
 * every consumer — the rings, the pockets, the dust, the light — re-places
 * itself the instant it changes. `chordReflect` is the other one to reach for:
 * take it to zero and the whole pattern collapses into a plain outbound train,
 * which is the clearest way to see that the nodes were real.
 */
export const resonanceSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 4, 200, 0.5, 'strike speed'],
    ['lifetime', 0.2, 12, 0.05, 'ring time'],
    ['fadeTime', 0.1, 8, 0.05, 'decay time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation'],
    ['originForward', -1, 4, 0.01, 'run start (m)'],
    ['originSide', -2, 2, 0.01, 'run lateral (m)'],
    ['lineHeight', 0, 4, 0.01, 'run height (m)']
  ],
  'The standing wave': [
    ['halfWaves', 1, 24, 1, 'half-waves on the line'],
    ['lockSpacing', 0, 1, 0.01, 'lock to resonance'],
    ['establishTrips', 0.1, 4, 0.05, 'crossings to establish'],
    ['chordReflect', 0, 1, 0.01, 'reflection'],
    ['chordStanding', 0, 1, 0.01, 'standing envelope'],
    ['chordSwell', 0, 2, 0.01, 'antinode swell'],
    ['chordSpacing', 0.1, 12, 0.01, 'wavelength (m, unlocked)'],
    ['chordRings', 1, 24, 1, 'rings (unlocked)'],
    ['chordRingSpeed', 0, 40, 0.05, 'ring speed (m/s)']
  ],
  'The rings': [
    ['chordRadius', 0.01, 12, 0.01, 'start radius (m)'],
    ['chordRadiusEnd', 0.01, 20, 0.01, 'end radius (m)'],
    ['chordExpand', 0.2, 12, 0.01, 'expansion curve'],
    ['chordLift', -2, 2, 0.01, 'lift along the run (m)'],
    ['chordRingThickness', 0.01, 2, 0.01, 'thickness (m)'],
    ['chordRingSharp', 0.05, 8, 0.01, 'profile'],
    ['chordOpacity', 0, 1, 0.01, 'opacity'],
    ['chordGlow', 0, 8, 0.01, 'glow'],
    ['chordSoftFade', 0, 3, 0.01, 'soft fade (m)'],
    'chordColorBody',
    'chordColorRim',
    'chordColorEdge'
  ],
  'The rings/Inert on this mode': [
    ['chordHeight', 0.02, 4, 0.01, 'height × radius'],
    ['chordDisplace', 0, 1.5, 0.01, 'billow'],
    ['chordNoiseScale', 0.1, 10, 0.01, 'billow scale'],
    ['chordNoiseSpeed', 0, 4, 0.01, 'billow Hz'],
    ['chordTurbulence', 0, 3, 0.01, 'turbulence'],
    ['chordFill', 0, 1, 0.01, 'body fill'],
    ['chordRim', 0, 3, 0.01, 'rim'],
    ['chordRimPower', 0.1, 8, 0.01, 'rim power'],
    ['chordDissolve', 0, 2, 0.01, 'dissolve'],
    ['chordSeal', 0, 4, 0.01, 'floor seal'],
    ['chordSealWidth', 0.01, 0.6, 0.01, 'seal width'],
    ['chordEdge', 0, 4, 0.01, 'leading lip'],
    ['chordEdgeWidth', 0.01, 0.8, 0.01, 'lip width'],
    ['chordConeCurve', 0.1, 4, 0.01, 'flare curve'],
    ['chordSpan', 0.1, 40, 0.05, 'run length (m)'],
    ['chordCoronaReach', 1, 4, 0.01, 'drawn reach'],
    ['chordCorona', 0, 4, 0.01, 'corona'],
    ['chordCoronaLength', 0, 3, 0.01, 'corona length'],
    ['chordCoronaScale', 0.5, 20, 0.1, 'corona scale'],
    ['chordCoronaWarp', 0, 2, 0.01, 'corona warp'],
    ['chordCoronaSpeed', 0, 4, 0.01, 'corona Hz'],
    ['chordCoronaSharp', 0, 0.98, 0.01, 'corona threshold'],
    ['chordGranule', 0, 2, 0.01, 'granulation'],
    ['chordGranuleScale', 0.5, 24, 0.1, 'granule scale'],
    ['chordRimWidth', 0.01, 0.6, 0.01, 'rim band'],
    'chordColorCorona'
  ],
  'The pockets': [
    ['pockets', 0, 4, 1, 'antinodes with a pocket'],
    ['pocketStrength', 0, 0.4, 0.001, 'strength (screen widths)'],
    ['pocketRadius', 0.1, 8, 0.05, 'falloff radius (m)'],
    ['pocketWindow', 0, 0.99, 0.01, 'falloff start'],
    ['pocketWave', 0.05, 4, 0.01, 'shell radius (m)'],
    ['pocketThickness', 0.02, 2, 0.01, 'shell thickness (m)'],
    ['pocketCompression', 0, 3, 0.01, 'compression'],
    ['pocketRarefaction', 0, 3, 0.01, 'rarefaction'],
    ['pocketRings', 1, 4, 1, 'fronts'],
    ['pocketRingGap', 0.05, 3, 0.01, 'front gap (m)'],
    ['pocketRingDecay', 0, 3, 0.01, 'front decay'],
    ['pocketMaxOffset', 0.01, 1, 0.005, 'offset ceiling'],
    ['pocketOpacity', 0, 1, 0.01, 'opacity'],
    ['pocketWidth', 0.5, 16, 0.1, 'quad width (m)'],
    ['pocketHeight', 0.5, 16, 0.1, 'quad height (m)'],
    ['pocketDepthReject', 0, 1, 0.01, 'depth reject'],
    ['pocketDepthFade', 0.01, 4, 0.01, 'depth fade (m)'],
    ['pocketPerspective', 0, 1, 0.01, 'perspective'],
    ['pocketPerspectiveRef', 1, 40, 0.5, 'perspective ref (m)']
  ],
  'Dust & grit': [
    ['dustRate', 0, 1200, 1, 'dust rate'],
    ['dustSize', 0.005, 0.6, 0.005, 'dust size'],
    ['dustSpeed', 0, 20, 0.1, 'dust speed'],
    ['dustLifetime', 0.05, 6, 0.05, 'dust lifetime'],
    ['dustRise', -3, 8, 0.05, 'dust rise'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['gritRate', 0, 400, 1, 'grit rate'],
    ['gritSize', 0.005, 0.4, 0.005, 'grit size'],
    ['gritSpeed', 0, 20, 0.1, 'grit speed'],
    ['gritLifetime', 0.05, 4, 0.05, 'grit lifetime'],
    ['gritGravity', -40, 0, 0.1, 'grit gravity'],
    ['colorDust*', 'Dust colour'],
    ['colorGrit*', 'Grit colour']
  ],
  'Sparks': [
    ['sparkRate', 0, 600, 1, 'spark rate'],
    ['sparkSize', 0.005, 0.8, 0.005, 'spark size'],
    ['sparkSpeed', 0, 40, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 4, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['colorSpark*', 'Spark colour']
  ],
  'Strike, reflection & light': [
    ['strikeSize', 0.1, 10, 0.05, 'strike shell (m)'],
    ['strikeIntensity', 0, 5, 0.01, 'strike intensity'],
    ['strikeSparks', 0, 600, 1, 'strike sparks'],
    ['strikeFlash', 0, 2, 0.01, 'screen flash'],
    ['strikeShake', 0, 3, 0.01, 'strike shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['reflectSize', 0.1, 12, 0.05, 'reflection shell (m)'],
    ['reflectIntensity', 0, 5, 0.01, 'reflection intensity'],
    ['reflectSparks', 0, 600, 1, 'reflection sparks'],
    ['reflectShake', 0, 3, 0.01, 'reflection shake'],
    ['rumble', 0, 0.5, 0.005, 'ringing rumble'],
    'colorStrikeA',
    'colorStrikeB',
    'colorStrikeC',
    'colorFlash',
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'light on the breath'],
    'lightColor'
  ]
};
