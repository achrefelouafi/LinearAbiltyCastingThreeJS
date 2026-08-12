/* ================================================================== */
/* STASIS FIELD — chrono                                               */
/* ================================================================== */
/**
 * A sphere of stopped time dropped over the aimed circle.
 *
 * This block is short by the standards of this directory, and that is the
 * ability rather than an omission. Stasis Field draws **two** things — a
 * refractive hull standing in the air and a hex lattice on the floor — because
 * everything else it does happens inside *other* people's shaders. The numbers
 * that matter most here are the four in "The held sphere": they are the entire
 * ability, and none of them tints a pixel.
 *
 * ## What each of the four does
 *
 * `fieldScale` is the outer edge, as a multiple of the aim circle, so the
 * reticle you targeted with is the boundary you get. `fieldCore` is how much of
 * that radius is held *flat* — the rest is a shell in which the clock runs
 * slower the further in you look, and that gradient is the reason the field
 * reads as a field rather than as a hard sphere of frozen sprites. `holdRate`
 * is the clock rate inside: **0 is a stasis field, 0.2 is slow motion and 1 is
 * an ability that does nothing**, and it is a slider because the other two are
 * genuinely worth having. `armLag` is how far behind the world the interior
 * falls while the field is still closing — see the class doc for why a lag and
 * a rate are the same mechanism seen from two ends.
 *
 * ## The two things that are drawn
 *
 * `glass*` is a `DistortionField` in `REFRACT` mode on a sphere hull. It emits
 * no light at all: it writes screen-space offsets, so what you see is the floor
 * grid, the character and every particle *behind* the sphere bending as they
 * cross its skin. That is deliberate. The first version put a `Shell(DOME)`
 * over it with a bright fresnel rim and the slot immediately read as a shield —
 * a thing that stops damage, not a thing that stops time — and no amount of
 * recolouring fixed it, because a glowing dome is a *barrier* and the eye knows
 * it before it knows anything else.
 *
 * `lattice*` is a `GroundField` in `LATTICE` mode: a hex mesh that propagates
 * cell by cell along its own edges. It is on the floor for one reason, which is
 * that it is driven by the field's **own interior clock** — so it starts
 * spreading, and then stops dead part way out and holds there for two seconds.
 * A growth front arrested mid-growth is the cheapest legible picture of "time
 * stopped here" this project can draw, and `latticeTime` against `holdTime` is
 * the pair to drag: set `latticeTime` above `holdTime` and the lattice never
 * finishes until the field lets go.
 */
export const stasisfield = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 2.0, // closer than this and the cast is refused
  zoneRadius: 5.0, // the aimed circle, metres — the field's own radius keys off this
  speed: 34.0, // how fast the seed travels out to the circle, metres/second
  cooldown: 2.2, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
  holdTime: 2.4, // seconds the field stays shut once it has snapped
  releaseTime: 0.45, // seconds the interior takes to catch back up when it lets go
  settleTime: 0.55, // seconds after the catch-up before the cast is finished

  /* --- the held sphere (vfx/TimeControl.js) — the ability --- */
  fieldScale: 1.0, // outer edge of the held sphere, × zoneRadius
  fieldHeight: 2.1, // metres above the floor the sphere is centred at
  fieldCore: 0.6, // 0..1 of the radius held flat; past it the clock ramps back up
  fieldStrength: 1.0, // 0..1 master weight; 0 is a field that holds nothing
  holdRate: 0.0, // clock rate inside: 0 stasis, 0.2 slow motion, 1 identity
  armLag: 0.22, // seconds the interior falls behind while the field is closing
  armCurve: 1.7, // >1 keeps the grip weak and then takes hold late

  /* --- the glass: DistortionField(REFRACT) on a sphere hull --- */
  // Magnitudes are SCREEN FRACTIONS, not metres. `post.distortion ×
  // global.distortion` is applied by the pass exactly once and must not be
  // multiplied in here.
  glassScale: 1.0, // hull radius, × the field radius
  glassSquash: 0.94, // vertical scale on the hull, so it is not a perfect ball
  glassLift: 0.15, // metres the hull sits above the field centre
  glassStrength: 0.42, // screen widths of refraction at the rim
  glassPower: 2.6, // rim exponent; 0 flattens the hull into a uniform pane
  glassRipple: 0.22, // how much the skin crawls
  glassRippleScale: 1.7, // cycles per metre of that crawl
  glassRippleSpeed: 0.3, // metres/second it travels at
  glassOpacity: 1.0, // master on the emitter's contribution
  glassDepthReject: 0.7, // 0..1 how hard opaque geometry in front of it cuts it
  glassDepthFade: 0.45, // metres of feather on that rejection
  glassPerspective: 0.35, // 0..1 how much the effect falls off with distance
  glassPerspectiveRef: 12.0, // metres — the distance that falloff is referenced to

  /* --- the floor: GroundField(LATTICE), on the field's own clock --- */
  latticeScale: 1.02, // radius, × the field radius — a hair proud of the skin
  latticeTime: 1.15, // seconds the lattice would take to reach the rim, unheld
  latticeHeight: 0.02, // metres above the floor the quad sits at
  latticeCell: 0.44, // metres across one hex
  latticeSeam: 0.032, // metres — the gap between neighbouring cells
  latticeThickness: 0.055, // metres — the wall of a cell
  latticeLift: 0.06, // metres a cell stands proud of the floor
  latticeDepth: 0.05, // metres of recess inside a cell
  latticeSharp: 0.55, // 0..1 how hard the cell profile falls off
  latticeDetail: 0.5, // 0..1 grain inside a cell
  latticeEdge: 0.28, // metres of feather on the propagation front
  latticeRagged: 0.1, // how far that front wanders, fraction of the radius
  latticeRaggedScale: 0.6, // lobes per metre on the wander
  latticeWarp: 0.3, // metres of domain warp on those lobes
  latticeRelief: 0.55, // how hard the height field tilts the fake normal
  latticeNormalStep: 0.05, // metres between the height taps
  latticeAmbient: 0.3, // floor on the diffuse term
  latticeWrap: 0.42, // 0..1 wraps the terminator round the back
  latticeSpecular: 0.35,
  latticeGloss: 26.0, // Blinn exponent
  latticeParallax: 0.2, // metres of view-driven offset on the interior detail
  latticeSpeed: 0.3, // events per second in the cell shader's own animation
  latticeEmissive: 1.15, // multiplier on every glowing term
  latticeOpacity: 0.82,
  latticeDepthFade: 0.45, // metres of soft fade against standing geometry
  colorLatticeBase: '#5c6b66', // the substance of a cell wall
  colorLatticeEdge: '#cfe0d8', // rims and highlights
  colorLatticeGlow: '#a8d4c4', // the propagating front
  colorLatticeDeep: '#141a19', // the recess inside a cell

  /* --- the dust the field catches --- */
  /**
   * Two systems, both coloured by a four-stop lifetime gradient (`A` at birth
   * through `D` as it dies) as in `ice` and `thunder`.
   *
   * `moteRate` is emitted **in a thin shell at the rim**, not through the
   * volume, because the rim is the only place in a stasis field where anything
   * is still moving. `rimBand` is how thick that shell is as a fraction of the
   * radius; take it to 1 and the whole interior is seeded, which fills the
   * sphere with motionless specks and looks like a rendering fault.
   */
  moteRate: 130, // motes emitted per second into the rim shell
  moteSize: 0.055,
  moteSpeed: 0.65, // metres/second — barely anything; the field takes it from there
  moteLifetime: 3.4, // seconds. Long, because a held mote never spends its life
  moteRise: 0.35, // upward drift, metres/second
  moteTurbulence: 0.45,
  moteGlow: 0.85,
  moteOpacity: 0.9,
  rimBand: 0.3, // 0..1 of the radius the rim shell occupies
  snapMotes: 90, // extra motes thrown inward on the frame the field shuts
  colorMoteA: '#ffffff',
  colorMoteB: '#cfe6dc',
  colorMoteC: '#8fb6a8',
  colorMoteD: '#2c3a36',

  dustRate: 34, // the low haze drawn up off the floor as the field closes
  dustSize: 0.9,
  dustSpeed: 0.9, // metres/second
  dustLifetime: 3.0, // seconds
  dustRise: 0.25, // metres/second
  dustOpacity: 0.07,
  snapDust: 40, // extra puffs on the snap
  colorDustA: '#5c6b66',
  colorDustB: '#4a5754',
  colorDustC: '#3a4442',
  colorDustD: '#202625',

  /* --- the snap: the one frame that punches --- */
  snapBurstSize: 3.4, // the shell of arrested air, metres
  snapBurstIntensity: 1.1,
  snapFlash: 0.14, // screen flash
  snapShake: 0.24, // camera shake
  shakeDuration: 0.4, // seconds it decays over
  snapRingRadius: 5.6, // the ring left on the floor at the boundary, metres
  snapRingIntensity: 0.9,
  colorSnapA: '#8fb6a8', // burst shell
  colorSnapB: '#cfe6dc', // burst body
  colorSnapC: '#ffffff', // burst filaments
  colorSnapFlash: '#dff0e8',
  colorRingA: '#a8d4c4', // ring body
  colorRingB: '#ffffff', // ring crest

  /* --- the release: the interior catching up --- */
  releaseBurstSize: 4.2, // metres
  releaseBurstIntensity: 0.8,
  releaseFlash: 0.09,
  releaseShake: 0.12,
  colorReleaseA: '#6f8f84',
  colorReleaseB: '#a8d4c4',
  colorReleaseC: '#e8f4ee',
  colorReleaseFlash: '#cfe6dc',

  /* --- casting --- */
  castFlash: 0.06, // screen flash as the seed leaves the hand
  colorCastFlash: '#cfe6dc',
  handHeight: 1.25, // metres above the floor the seed leaves at
  handForward: 0.5, // metres in front of the caster
  rumble: 0.012, // continuous shake while the seed travels

  /* --- dynamic light --- */
  // Deliberately steady: see `lightShimmer()` in the class.
  lightIntensity: 13.0,
  lightRadius: 13.0,
  lightColor: '#9fc6b8'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Stasis Field.
 *
 * Reach for **The held sphere** and nothing else first. Cast the field over a
 * standing Storm Lance or a Cinder Fall, pause with **P**, and drag
 * `fieldScale` — the boundary between the particles that are moving and the
 * particles that are not moves with it, on a frame of zero length. That is the
 * ability, and it is also invariant I1 demonstrated more loudly than anywhere
 * else in the project.
 *
 * `holdRate` is the second thing to touch. At 0.15 the slot stops being a
 * stasis field and becomes a bullet-time bubble, which is a completely
 * different ability for the cost of one number.
 */
export const stasisfieldSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['zoneRadius', 1, 14, 0.05, 'aim circle (m)'],
    ['speed', 5, 200, 1, 'seed speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation'],
    ['holdTime', 0.2, 8, 0.05, 'time held (s)'],
    ['releaseTime', 0.05, 3, 0.01, 'catch-up (s)'],
    ['settleTime', 0.05, 3, 0.05, 'settle (s)']
  ],
  'The held sphere': [
    ['fieldScale', 0.2, 2.5, 0.01, 'radius × aim circle'],
    ['fieldHeight', 0, 8, 0.05, 'centre height (m)'],
    ['fieldCore', 0, 0.98, 0.01, 'flat core (0..1)'],
    ['fieldStrength', 0, 1, 0.01, 'grip'],
    ['holdRate', 0, 1, 0.01, 'clock rate inside'],
    ['armLag', 0, 1.5, 0.01, 'lag while closing (s)'],
    ['armCurve', 0.3, 5, 0.01, 'grip curve']
  ],
  'The glass': [
    ['glassScale', 0.2, 2, 0.01, 'hull × field radius'],
    ['glassSquash', 0.3, 1.6, 0.01, 'hull squash'],
    ['glassLift', -2, 3, 0.01, 'hull lift (m)'],
    ['glassStrength', 0, 2, 0.01, 'refraction (screen widths)'],
    ['glassPower', 0, 8, 0.05, 'rim exponent'],
    ['glassRipple', 0, 2, 0.01, 'skin crawl'],
    ['glassRippleScale', 0.1, 8, 0.05, 'crawl cycles / m'],
    ['glassRippleSpeed', -3, 3, 0.01, 'crawl speed (m/s)'],
    ['glassOpacity', 0, 2, 0.01, 'opacity'],
    ['glassDepthReject', 0, 1, 0.01, 'occlusion'],
    ['glassDepthFade', 0.02, 3, 0.01, 'occlusion feather (m)'],
    ['glassPerspective', 0, 1, 0.01, 'distance falloff'],
    ['glassPerspectiveRef', 1, 40, 0.5, 'reference distance (m)']
  ],
  'The lattice on the floor': [
    ['latticeScale', 0.2, 2, 0.01, 'radius × field radius'],
    ['latticeTime', 0.1, 6, 0.05, 'unheld spread time (s)'],
    ['latticeHeight', 0.005, 0.2, 0.005, 'height above floor (m)'],
    ['latticeCell', 0.08, 2, 0.01, 'cell width (m)'],
    ['latticeSeam', 0, 0.3, 0.002, 'seam (m)'],
    ['latticeThickness', 0.005, 0.4, 0.005, 'wall (m)'],
    ['latticeLift', 0, 0.5, 0.005, 'cell lift (m)'],
    ['latticeDepth', 0, 0.6, 0.005, 'cell recess (m)'],
    ['latticeSharp', 0, 1, 0.01, 'profile sharpness'],
    ['latticeDetail', 0, 1, 0.01, 'interior grain'],
    ['latticeEdge', 0.02, 2, 0.01, 'front feather (m)'],
    ['latticeRagged', 0, 1, 0.01, 'front wander'],
    ['latticeRaggedScale', 0.05, 3, 0.01, 'wander lobes / m'],
    ['latticeWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['latticeRelief', 0, 2, 0.01, 'relief'],
    ['latticeNormalStep', 0.005, 0.4, 0.005, 'normal step (m)'],
    ['latticeAmbient', 0, 1, 0.01, 'ambient'],
    ['latticeWrap', 0, 1, 0.01, 'terminator wrap'],
    ['latticeSpecular', 0, 2, 0.01, 'specular'],
    ['latticeGloss', 1, 120, 1, 'gloss'],
    ['latticeParallax', 0, 1.5, 0.01, 'parallax (m)'],
    ['latticeSpeed', 0, 3, 0.01, 'cell animation rate'],
    ['latticeEmissive', 0, 4, 0.01, 'emissive'],
    ['latticeOpacity', 0, 1, 0.01, 'opacity'],
    ['latticeDepthFade', 0.02, 3, 0.01, 'soft intersection (m)'],
    ['colorLatticeBase', 'cell wall'],
    ['colorLatticeEdge', 'rim'],
    ['colorLatticeGlow', 'front'],
    ['colorLatticeDeep', 'recess']
  ],
  'Motes & haze': [
    ['moteRate', 0, 600, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 8, 0.05, 'mote speed'],
    ['moteLifetime', 0.2, 10, 0.05, 'mote lifetime'],
    ['moteRise', -2, 4, 0.01, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['moteGlow', 0, 3, 0.01, 'mote glow'],
    ['moteOpacity', 0, 1, 0.01, 'mote opacity'],
    ['rimBand', 0.02, 1, 0.01, 'rim shell thickness'],
    ['snapMotes', 0, 400, 1, 'motes on the snap'],
    ['dustRate', 0, 300, 1, 'haze rate'],
    ['dustSize', 0.05, 4, 0.01, 'haze size'],
    ['dustSpeed', 0, 8, 0.05, 'haze speed'],
    ['dustLifetime', 0.2, 10, 0.05, 'haze lifetime'],
    ['dustRise', -2, 4, 0.01, 'haze rise'],
    ['dustOpacity', 0, 1, 0.005, 'haze opacity'],
    ['snapDust', 0, 300, 1, 'haze on the snap'],
    ['colorMote*', 'Mote colour'],
    ['colorDust*', 'Haze colour']
  ],
  'The snap': [
    ['snapBurstSize', 0.2, 14, 0.05, 'burst size (m)'],
    ['snapBurstIntensity', 0, 4, 0.01, 'burst intensity'],
    ['snapFlash', 0, 1, 0.005, 'screen flash'],
    ['snapShake', 0, 2, 0.01, 'shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration (s)'],
    ['snapRingRadius', 0.5, 20, 0.1, 'boundary ring (m)'],
    ['snapRingIntensity', 0, 3, 0.01, 'ring intensity'],
    ['colorSnapA', 'burst shell'],
    ['colorSnapB', 'burst body'],
    ['colorSnapC', 'burst filaments'],
    ['colorSnapFlash', 'flash colour'],
    ['colorRingA', 'ring body'],
    ['colorRingB', 'ring crest']
  ],
  'The release': [
    ['releaseBurstSize', 0.2, 16, 0.05, 'burst size (m)'],
    ['releaseBurstIntensity', 0, 4, 0.01, 'burst intensity'],
    ['releaseFlash', 0, 1, 0.005, 'screen flash'],
    ['releaseShake', 0, 2, 0.01, 'shake'],
    ['colorReleaseA', 'burst shell'],
    ['colorReleaseB', 'burst body'],
    ['colorReleaseC', 'burst filaments'],
    ['colorReleaseFlash', 'flash colour']
  ],
  'Casting': [
    ['handHeight', 0, 3, 0.01, 'hand height (m)'],
    ['handForward', -1, 3, 0.01, 'hand forward (m)'],
    ['castFlash', 0, 1, 0.005, 'release flash'],
    ['colorCastFlash', 'release flash colour'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
