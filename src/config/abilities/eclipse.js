import { shellDefaults, shellSchema, ShellMode } from '../../vfx/Shell.js';

/* ================================================================== */
/* ECLIPSE — the light goes wrong before anything appears              */
/* ================================================================== */
/**
 * The far cast whose first beat has no geometry in it at all.
 *
 * This is the Thunderclap lesson applied to light. Thunderclap buys its bang by
 * spending half a second *not* banging; Eclipse buys its disc by spending the
 * whole travel phase making the world quietly wrong — colour draining out of
 * the frame toward the umbra, the corners closing in, the key light cooling and
 * dimming — with nothing on screen to explain why. Only then does the black disc
 * open, and by then the frame has already told you something is coming.
 *
 * Two hooks from `vfx/SceneHooks.js` carry that first beat and neither of them
 * draws anything:
 *
 *  - **`Hook.GRADE`** — saturation, temperature, lift and vignette, blended
 *    from `settings.post` by a weight that is the anticipation curve itself.
 *  - **`Hook.KEY_LIGHT`** — `tint()` and `brightness()` only. `aim()` is never
 *    called, which is deliberate: an eclipse does not move the sun, it stands in
 *    front of it, so every shadow on the stage must stay exactly where it is
 *    while it goes cold and soft. Moving the light was the first version and it
 *    read as a second sunset rather than as an occultation.
 *
 * Three beats:
 *
 * | phase | what it is | how long |
 * | --- | --- | --- |
 * | travel | **the anticipation** — the grade drains and the key cools, nothing is drawn | `range / speed` |
 * | impact | second contact and totality — the disc opens, the corona lights | `(openTime + holdTime) × global.lifetime` |
 * | fade | third contact — the disc lets go and the world comes back | `closeTime` |
 *
 * The four controls worth reaching for first are `wrongCurve` (how late the
 * anticipation commits — the single biggest lever on whether the slot lands),
 * `anticipateWeight` (how wrong the world gets *before* the disc, which must
 * stay below 1 or the disc has nothing left to add), `discRadiusEnd` (the size
 * of the umbra, and the one radius that matters — the black disc is derived
 * from the corona's live radius, not authored separately) and `beadAt`, which
 * places Baily's beads in the opening.
 *
 * Nothing here is captured by a cast. A cast rolls one seed for the corona and
 * the beads, and remembers whether second contact has fired; every metre,
 * radian and second below is re-read on every frame, zero-length ones included.
 */
export const eclipse = {
  /* --- the cast --- */
  range: 21.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 34.0, // deliberately slow: the travel phase is the anticipation
  cooldown: 8.5,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 5.6, // the footprint — what the circle indicator measures out

  /* ------------------------------------------------------------------ */
  /* The beats                                                           */
  /* ------------------------------------------------------------------ */
  openTime: 0.85, // seconds the disc takes to open — second contact
  holdTime: 2.2, // seconds of totality
  closeTime: 1.3, // seconds the disc takes to let go — third contact
  wrongCurve: 1.7, // exponent on the anticipation ramp; >1 holds off, then commits

  /* ------------------------------------------------------------------ */
  /* The anticipation — four numbers, no geometry                        */
  /* ------------------------------------------------------------------ */
  /**
   * `anticipateWeight` is how far the grade is driven by the time the disc
   * opens; the remainder is spent during the opening, so the world keeps going
   * wrong right through second contact. At 1 the anticipation arrives at
   * totality early and the disc adds nothing.
   */
  gradeWeight: 1.0, // master on the whole grade hook, 0 = transparent
  anticipateWeight: 0.55, // 0..1 of the drain spent before the disc opens
  gradeSaturation: 0.15, // 0 is monochrome, 1 untouched
  gradeTemper: -0.4, // + warm, − cool; matches post.temperature
  gradeLift: -0.06, // black level, negative crushes toward the umbra
  gradeVignette: 0.55, // how much darker the corners get, 0..1

  keyWeight: 1.0, // master on the key-light hook, 0 = transparent
  keyDim: 0.35, // key intensity at totality, in environment.sunIntensity units
  colorCold: '#7f93c8', // what the key cools to — never warmer than the stage

  /* ------------------------------------------------------------------ */
  /* The disc — vfx/Shell.js in SUNDISC, carrying the corona only         */
  /* ------------------------------------------------------------------ */
  /**
   * The shell draws the corona and nothing else: `discFill`, `discGranule` and
   * `discRim` are all zero, because a sun disc's own face is exactly the thing
   * an eclipse does not have. The black middle is the umbra quad, which is not
   * additive and therefore can be black — a `Shell` is additive and the darkest
   * mark it can make is "nothing".
   *
   * `discRadiusEnd` is the ability's real radius. Keep it near `zoneRadius`, or
   * the aim circle will measure out a footprint the disc does not fill.
   */
  ...shellDefaults('disc', ShellMode.SUNDISC, {
    discRadius: 0.35, //     radius at t = 0, metres
    discRadiusEnd: 5.6, //   radius at totality, metres
    discExpand: 3.2, //      opening curve — fast, then easing into place
    discHeight: 0.02,
    discLift: 0.09, //       metres above the floor the corona plane sits
    discFill: 0.0, //        no face: the umbra owns the middle
    discGranule: 0.0, //     ... and no convection cells on it
    discRim: 0.0, //         the fresnel rim is meaningless on a flat annulus
    discCorona: 1.7, //      brightness of the filaments licking off the rim
    discCoronaReach: 2.1, // how far past the rim the shell is drawn, × radius
    discCoronaLength: 0.85, // how far the filaments reach, × radius
    discCoronaScale: 6.5, // filament features per radius
    discCoronaWarp: 0.55, // domain warp — the thing that stops them being spokes
    discCoronaSpeed: 0.5, // Hz they crawl at
    discCoronaSharp: 0.66, // threshold: low fills the corona in and it reads as fog
    discRimWidth: 0.1, //    hot band just inside the rim, × radius
    discDissolve: 0.35,
    discGlow: 2.8,
    discSoftFade: 0.4,
    discColorBody: '#120e18', //   barely there — the shell is additive
    discColorRim: '#c8b8ff', //    the pale ring at the limb
    discColorEdge: '#ffffff', //   the hottest mark it has
    discColorCorona: '#e8dcff' //  the filaments
  }),

  /* ------------------------------------------------------------------ */
  /* The umbra — the only non-additive thing in the ability               */
  /* ------------------------------------------------------------------ */
  umbraScale: 0.98, // × the corona's live radius — slightly inside its rim
  umbraReach: 1.4, // how far past the rim the quad is drawn, × radius
  umbraEdge: 0.05, // softness of the limb, fraction of the radius
  umbraShade: 1.0, // how much of colorUmbra survives; 0 crushes the disc to absolute black
  umbraOpacity: 0.96, // coverage over the floor
  umbraLift: 0.045, // metres above the floor
  rimGlow: 1.5, // brightness of the ring at the limb
  rimWidth: 0.09, // its width, fraction of the radius
  beadCount: 9.0, // Baily's beads around the limb
  beadSize: 0.13, // angular half-width of one bead, fraction of its cell
  beadWidth: 0.07, // radial half-width, fraction of the radius
  beadSpin: 0.1, // turns/second the bead pattern rotates
  beadAt: 0.88, // where in the opening the beads flash, 0..1
  beadWindow: 0.16, // how long that flash lasts, 0..1 of the opening
  beadFlash: 2.0, // brightness of a bead at its peak
  colorUmbra: '#05040a', // the disc itself
  colorLimb: '#d8c8ff', // the ring at its edge
  colorBead: '#fff4e0', // the beads

  /* ------------------------------------------------------------------ */
  /* The drain — dust drawn inward while the world goes wrong             */
  /* ------------------------------------------------------------------ */
  drainRate: 55.0, // motes per second during the anticipation
  drainRadius: 1.9, // where they start, × zoneRadius
  drainSpeed: 2.4, // metres/second inward
  drainSize: 0.06, // metres
  drainLifetime: 1.9, // seconds
  drainRise: 0.12, // metres/second of buoyancy
  drainHeight: 1.6, // metres of air they are lifted out of
  drainTurbulence: 0.35, // curl-noise strength
  drainJitter: 0.5, // metres of slop on one emission puff
  colorDrainA: '#b8c8e8', // birth — the colour the world still has
  colorDrainB: '#8f8fb8', // early
  colorDrainC: '#4a4260', // late
  colorDrainD: '#0d0a14', // death — it arrives at the umbra as nothing

  /* ------------------------------------------------------------------ */
  /* The corona sparks — thrown off the limb at second contact            */
  /* ------------------------------------------------------------------ */
  sparkBurst: 90.0, // how many go up on the bead flash
  sparkRate: 14.0, // per second through totality
  sparkSpeed: 3.4, // metres/second
  sparkSize: 0.09, // metres
  sparkLifetime: 1.1, // seconds
  sparkStretch: 0.55, // velocity stretching
  sparkGravity: -0.5, // metres/second² — they fall back into the disc
  colorSparkA: '#ffffff', // birth
  colorSparkB: '#e6d8ff', // early
  colorSparkC: '#9a86d8', // late
  colorSparkD: '#241c38', // death

  /* ------------------------------------------------------------------ */
  /* The light and the flash                                              */
  /* ------------------------------------------------------------------ */
  lightColor: '#c9b6ff', // the corona's own glow on the floor
  lightIntensity: 2.6,
  lightRadius: 11.0, // metres
  lightHeight: 0.9, // metres above the floor
  lightTotality: 0.22, // × its intensity once the beads have gone
  contactFlash: 0.5, // screen flash at second contact
  colorFlash: '#efe4ff'
};

/**
 * Editor layout.
 *
 * The `disc*` folders come from `shellSchema('disc', ShellMode.SUNDISC)`; the
 * dome, cone and ring-train keys `shellDefaults` also brings in do nothing to a
 * sun disc and are deliberately unfiled — they land in the trailing "More"
 * folder, exactly as `thunderclap`'s spare shell keys do.
 *
 * The grade and key-light rows are the four numbers of the anticipation, and
 * they are the ones to drag first with the simulation **paused**: they drive the
 * scene rather than anything in this ability's own group, so the frame changes
 * while nothing in the ability moves.
 */
export const eclipseSchema = {
  'The cast': ['range', 'minRange', 'speed', 'cooldown', 'castAnim', ['zoneRadius', 1, 14, 0.1, 'circle radius (m)']],
  'The beats': [
    ['openTime', 0.05, 5, 0.01, 'second contact (s)'],
    ['holdTime', 0.1, 10, 0.05, 'totality (s)'],
    ['closeTime', 0.1, 6, 0.05, 'third contact (s)'],
    ['wrongCurve', 0.2, 5, 0.01, 'anticipation curve']
  ],
  'The anticipation': [
    ['gradeWeight', 0, 1, 0.01, 'grade taken'],
    ['anticipateWeight', 0, 1, 0.01, 'drain before the disc'],
    ['gradeSaturation', 0, 1.5, 0.01, 'saturation'],
    ['gradeTemper', -1, 1, 0.01, 'temperature'],
    ['gradeLift', -0.3, 0.3, 0.005, 'lift'],
    ['gradeVignette', 0, 1.5, 0.01, 'vignette'],
    ['keyWeight', 0, 1, 0.01, 'key light taken'],
    ['keyDim', 0, 4, 0.01, 'key at totality'],
    'colorCold'
  ],
  ...shellSchema('disc', ShellMode.SUNDISC),
  'The umbra': [
    ['umbraScale', 0.4, 1.4, 0.01, '× corona radius'],
    ['umbraReach', 1, 3, 0.01, 'drawn reach × radius'],
    ['umbraEdge', 0.002, 0.4, 0.002, 'limb softness'],
    ['umbraShade', 0, 1, 0.01, 'shade kept'],
    ['umbraOpacity', 0, 1, 0.01, 'opacity'],
    ['umbraLift', 0.005, 0.5, 0.005, 'height (m)'],
    ['rimGlow', 0, 4, 0.01, 'limb ring'],
    ['rimWidth', 0.005, 0.4, 0.005, 'limb width'],
    'colorUmbra',
    'colorLimb'
  ],
  "The umbra/Baily's beads": [
    ['beadCount', 1, 32, 1, 'beads'],
    ['beadSize', 0.01, 0.5, 0.005, 'angular size'],
    ['beadWidth', 0.005, 0.4, 0.005, 'radial size'],
    ['beadSpin', -2, 2, 0.01, 'spin (turns/s)'],
    ['beadAt', 0, 1, 0.01, 'when they flash'],
    ['beadWindow', 0.02, 1, 0.01, 'how long'],
    ['beadFlash', 0, 6, 0.01, 'brightness'],
    'colorBead'
  ],
  'The drain': [
    ['drainRate', 0, 300, 1, 'motes/second'],
    ['drainRadius', 0.5, 4, 0.05, 'start × zoneRadius'],
    ['drainSpeed', 0, 12, 0.05, 'inward (m/s)'],
    ['drainSize', 0.005, 0.4, 0.005, 'size (m)'],
    ['drainLifetime', 0.2, 8, 0.05, 'life (s)'],
    ['drainRise', -1, 2, 0.01, 'buoyancy (m/s)'],
    ['drainHeight', 0.1, 8, 0.05, 'column (m)'],
    ['drainTurbulence', 0, 3, 0.01, 'turbulence'],
    ['drainJitter', 0.01, 3, 0.01, 'puff radius (m)'],
    ['colorDrain*', 'Drain gradient']
  ],
  'The corona sparks': [
    ['sparkBurst', 0, 400, 1, 'burst count'],
    ['sparkRate', 0, 200, 1, 'per second'],
    ['sparkSpeed', 0, 20, 0.05, 'speed (m/s)'],
    ['sparkSize', 0.005, 0.5, 0.005, 'size (m)'],
    ['sparkLifetime', 0.1, 6, 0.05, 'life (s)'],
    ['sparkStretch', 0, 3, 0.01, 'stretch'],
    ['sparkGravity', -8, 8, 0.05, 'gravity (m/s²)'],
    ['colorSpark*', 'Spark gradient']
  ],
  'The light': [
    'lightColor',
    ['lightIntensity', 0, 12, 0.05, 'intensity'],
    ['lightRadius', 1, 40, 0.5, 'radius (m)'],
    ['lightHeight', 0, 6, 0.05, 'height (m)'],
    ['lightTotality', 0, 1, 0.01, 'totality multiplier'],
    ['contactFlash', 0, 2, 0.01, 'contact flash'],
    'colorFlash'
  ]
};
