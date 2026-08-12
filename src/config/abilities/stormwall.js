/* ================================================================== */
/* STORMWALL — the cast you aim is the wall's NORMAL                   */
/* ================================================================== */
/**
 * Every other line cast in the project builds *along* the line you aimed: the
 * bolt runs down it, the beam lies on it, the fire trail burns it. This one
 * turns ninety degrees. The aimed line is the **normal** of a rain curtain that
 * stands **across** your heading at the target point — so what the arrow
 * indicator measures out is where the wall goes, and how far away it is, not
 * how long it is. Its length is `wallWidth`, and it is measured sideways.
 *
 * Mechanically that is one line of the ability: `Curtain#setPlacement` is
 * handed the cast's **side** vector as its `along`, not its direction. The
 * module's own doc calls that out because this slot is the reason the argument
 * exists.
 *
 * Three beats:
 *
 *  1. **`riseTime`** — the wall comes up out of the floor, staggered across the
 *     rank by `riseSpread` so it is a thing arriving rather than a decal
 *     appearing.
 *  2. **`holdTime`** — it stands. Rain sheets down the face, lightning restrikes
 *     *inside the wall's own plane* at `strikeRate`, and the floor under and in
 *     front of it is wet and reflective.
 *  3. **`fallTime`** — it **drains**. `rise` runs back to zero, which collapses
 *     each sheet down onto its own foot, and `fallSink` takes the foot below
 *     the floor. It does not fade uniformly; a uniform fade is a decal being
 *     switched off and it throws away the one thing the beat had to say.
 *
 * Three modules, four draw calls: `Curtain(RAIN)` for the water,
 * `FilamentPaths` for the lightning (two passes, halo and core, over one strip)
 * and `GroundField(WET)` for the floor.
 *
 * **What a cast captures.** A seed, three unitless dice per lightning strike
 * (where its two ends sit across the wall, and a decorrelation seed) and the
 * timestamps of those strikes. Not a metre: `wallWidth`, `wallHeight`, the rank
 * pitch, the strike's endpoints and the wet patch are all resolved from these
 * numbers inside the update loop, on zero-length frames included. Pause a
 * standing wall, drag `wallWidth`, and the rank re-lays itself, the lightning
 * re-spans it and the puddle re-scales under it together.
 */

export const stormwall = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and you are standing in your own wall
  speed: 34.0, // how fast the squall runs out to the point, metres/second
  cooldown: 2.2, // seconds
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the three beats (seconds) --- */
  riseTime: 0.75, // it comes up out of the floor
  holdTime: 4.4, // ... and stands. Scaled by global.lifetime with riseTime
  fallTime: 1.6, // ... and drains downward

  /* --- the wall itself ---------------------------------------------- */
  // `wallWidth` is the one number that means anything here: it is the rank's
  // total span across your heading, and the sheet pitch and each sheet's own
  // width are read off it, the way `snare.zoneRadius` drives five consumers.
  // Sizing the sheets independently and hoping they add up to a wall is how you
  // get a wall with a hole in it.
  wallWidth: 9.5, // metres, ACROSS the heading — the wall's length
  wallHeight: 5.4, // metres
  sheets: 8, // sheets in the rank (hard ceiling 16)
  sheetOverlap: 1.6, // each sheet's width, × the rank pitch. >1 overlaps.
  sheetScatter: 0.32, // metres of hashed slop off the nominal rank
  sheetLean: 0.5, // metres the head is pushed along the wall's normal
  sheetLeanJitter: 0.55, // ± fraction of that
  sheetTaper: 1.08, // width multiplier at the head; >1 splays
  sheetWidthJitter: 0.22, // ± fraction
  sheetHeightJitter: 0.26, // ± fraction
  riseSpread: 0.5, // 0..1 stagger of the rise across the rank
  fallSink: 0.55, // metres the foot drops below the floor as it drains
  phaseSpread: 1.0, // turns of per-sheet ripple phase offset

  /* --- the fold in the cloth --- */
  rippleAmp: 0.42, // metres
  rippleLength: 2.9, // metres along the sheet, crest to crest
  rippleSpeed: 1.4, // metres/second
  rippleCurve: 1.3, // exponent on height: 0 rigid, >0 pins the foot
  foldAmp: 0.85, // metres — the second, longer fold
  foldLength: 8.0, // metres
  foldSpeed: 0.4, // metres/second
  rippleNoise: 0.2, // metres of fbm slop
  rippleNoiseScale: 0.4, // cycles per metre
  rippleNoiseSpeed: 0.18, // Hz

  /* --- the two curves. They MUST disagree ---------------------------- */
  // Coverage and radiance falling off together is a hanging ribbon. Rain is the
  // opposite of an aurora: it *covers* most at the foot where the drops pile up
  // and it *shines* fairly evenly, so alphaCurve sits well above emissionCurve
  // and the head of the wall is thin without going dark.
  alphaBase: 1.0, // coverage at the foot
  alphaTop: 0.18, // coverage at the head
  alphaCurve: 2.2, // exponent between them
  emissionBase: 0.95, // radiance at the foot
  emissionTop: 0.5, // radiance at the head
  emissionCurve: 0.7, // ... deliberately not `alphaCurve`

  /* --- the envelope --- */
  body: 0.44, // 0..1 how much α a sheet is allowed at all
  footFade: 0.03, // 0..1 of the height
  headFade: 0.24, // 0..1 of the height
  edgeFade: 0.28, // 0..1 across the sheet
  graze: 1.0, // 0..1 of the 1/|N·V| path term — the volume cue
  grazeFloor: 0.13, // clamp on |N·V|
  curtainSoftFade: 0.5, // metres of depth fade against opaque geometry
  curtainOpacity: 1.0,
  curtainGlow: 1.05, // emissive gain into bloom
  tintSpread: 0.35, // 0..1 how far apart neighbouring sheets are tinted

  /* --- the rain running down the face --- */
  streakDensity: 12.0, // lanes per metre across the face
  streakRepeat: 3.2, // streaks per sheet height
  streakSpeed: 2.6, // sheet heights per second
  streakSpeedJitter: 0.4, // ± fraction, per lane
  streakWidth: 0.13, // 0..1 of a lane
  streakTail: 0.1, // 0..1 of a repeat — the trailing smear
  streakDuty: 0.6, // 0..1 of lanes carrying a streak
  haze: 0.34, // the veil between the streaks
  colorRainTail: '#5f7f9a', // the smear behind a drop
  colorRainHead: '#c8dcea', // the drop itself
  colorRainBody: '#101c2a', // what the sheet's coverage is made of

  /* --- the lightning inside the wall's plane ------------------------- */
  // `CRACK`: filament 0 is the trunk and everything else forks off it, so the
  // count is "how much fracture", not "how many lines". Both ends of the trunk
  // are placed in the plane spanned by the wall's own width and height, which
  // is why the discharge reads as being *inside* the water rather than in front
  // of it.
  boltFilaments: 6, // filaments in one strike
  strikeRate: 2.4, // strikes per second
  strikeHold: 0.26, // seconds one strike stays lit
  boltTop: 0.92, // where a strike starts, × wallHeight
  boltBottom: 0.04, // ... and where it ends
  boltDrift: 0.5, // ± fraction of the half-width the two ends differ by
  crackAngle: 0.6, // radians a fork leaves its parent by
  crackLength: 0.6, // fork length, × its parent's
  crackFalloff: 0.55, // extra shortening per generation
  crackSpread: 0.5, // ± fraction of variation on `crackAngle`
  crackStart: 0.2, // 0..1 earliest point on a parent a fork may happen
  crackSag: 0.22, // metres of bow on a segment
  crackFork: 0.5, // 0..1 slides the branch/twig split
  boltTaper: 0.85, // 0..1 how tapered the trunk's ends are

  /* --- and the current that runs along its foot --- */
  footFilaments: 4, // filaments crawling the wall's base
  footSag: -0.12, // metres; negative droops it onto the floor
  footSpread: 0.45, // metres the crawl fans out over
  footKink: 0.55, // × the shared kink amplitude
  footDim: 0.6, // 0..1 how secondary the crawl reads
  footDamp: 0.28, // 0..1 on the kink's world y — below 0.4 or it buries itself
  footFloor: 0.03, // metres the crawl is clamped above

  /* --- the filament look (both roles share it) --- */
  filWidth: 0.03, // half-width of a core ribbon, metres
  filGlowWidth: 6.4, // halo half-width, × the core
  filGlowOpacity: 0.42,
  filJitter: 0.5, // metres of kink at the coarsest octave
  filJitterScale: 1.5, // kinks per metre
  filOctaves: 4, // 1..5
  filJitterFalloff: 0.55, // amplitude kept per octave
  filCrawl: 3.0, // how fast the kinks slide along
  filPinch: 0.14, // 0..1 of the path the kink eases in over at each end
  filRestrike: 26, // whole re-shapes per second
  filFlicker: 0.3, // depth of the whole-bundle stutter
  filFlickerSpeed: 34, // steps/second
  filStrandFlash: 0.5, // depth of the per-filament blink
  filCoreSharp: 4.6, // exponent on the core's edge falloff
  filGlowFalloff: 2.4,
  filSoftFade: 0.6, // metres of depth fade
  filOpacity: 1.0,
  filGlow: 2.6,
  colorBoltCore: '#ffffff',
  colorBoltInner: '#dcecff',
  colorBoltOuter: '#7fb4ff',
  colorBoltHalo: '#12325a',

  /* --- the wet floor (vfx/GroundField.js, WET) ----------------------- */
  wetRadius: 7.8, // metres
  wetForward: 1.7, // metres downrange of the wall the patch is centred —
  //                   "under and in front of it", so the reflection reads from
  //                   the caster's side as well as through the curtain
  wetHeight: 0.015, // metres above the floor the quad sits at
  wetDry: 0.8, // 0..1 how far the patch has dried back from its own edge by
  //                the end of the drain. WET's `recede` eats the *outside*
  //                first, which is how a puddle actually goes.
  wetEdge: 0.5, // metres of feather on the growth front
  wetRagged: 0.3, // how far the front wanders, fraction of the radius
  wetRaggedScale: 0.55, // lobes per metre
  wetWarp: 0.6, // metres of domain warp on those lobes
  wetCell: 0.5, // puddle scale, metres
  wetCellJitter: 0.8,
  wetLift: 0.014, // metres of surface ripple
  wetDepth: 0.05, // metres the puddles sit down in
  wetSharp: 0.45,
  wetDetail: 0.75,
  wetSpeed: 1.4, // ripple rate
  wetFlow: 0.4, // drift, metres/second
  wetWind: 0.5, // drift bearing, radians in the quad's frame
  wetRelief: 0.5, // how hard the height field tilts the fake normal
  wetNormalStep: 0.05, // metres between the height taps
  wetAmbient: 0.22, // floor on the diffuse term
  wetWrap: 0.4,
  wetSpecular: 1.15, // this is the whole point of a wet floor
  wetGloss: 46, // Blinn exponent
  wetParallax: 0.25, // metres of view-driven offset
  wetEmissive: 0.7,
  wetOpacity: 0.9,
  wetDepthFade: 0.5, // metres of soft fade against standing geometry
  colorWetBase: '#243646', // the soaked stone
  colorWetEdge: '#c8dcea', // sheen and highlights
  colorWetGlow: '#5f7f9a', // anything emissive in it
  colorWetDeep: '#101c2a', // the bottom of a puddle

  /* --- spray, mist and sparks ---------------------------------------- */
  /**
   * Four-stop lifetime gradients, `A` at birth through `D` as it dies, spelled
   * out per system rather than derived from the rain palette — the spray should
   * be able to stay white while the curtain goes slate.
   */
  sprayRate: 150, // droplets/second bouncing off the wall's foot
  spraySize: 0.05,
  spraySpeed: 2.6,
  sprayLifetime: 0.65,
  sprayGravity: -11.0,
  spraySpread: 0.75,
  colorSprayA: '#eaf4ff',
  colorSprayB: '#c8dcea',
  colorSprayC: '#7f9fb8',
  colorSprayD: '#3d5266',

  mistRate: 34, // haze rolling off the face
  mistSize: 1.5,
  mistSpeed: 0.9,
  mistLifetime: 3.0,
  mistRise: 0.32, // metres/second
  mistOpacity: 0.07,
  colorMistA: '#7f97ab',
  colorMistB: '#5f7f9a',
  colorMistC: '#3b4f61',
  colorMistD: '#1d2833',

  strikeSparks: 34, // sparks thrown by one lightning strike
  sparkSize: 0.14,
  sparkSpeed: 7.0,
  sparkLifetime: 0.45,
  sparkGravity: -14.0,
  sparkStretch: 0.2,
  colorSparkA: '#ffffff',
  colorSparkB: '#dcecff',
  colorSparkC: '#7fb4ff',
  colorSparkD: '#12325a',

  /* --- what the beats do to the camera and the screen --- */
  riseShake: 0.32, // shake as the wall comes up
  riseShakeTime: 0.6, // seconds it decays over
  strikeFlash: 0.06, // screen flash on a lightning strike. Small — it fires
  //                     twice a second and a bright one is a strobe.
  colorStrikeFlash: '#c8dcea',
  strikeLight: 22, // additive punch on the dynamic light per strike
  holdRumble: 0.03, // sustained shake while the wall stands

  /* --- dynamic light --- */
  lightIntensity: 8,
  lightRadius: 15,
  lightColor: '#7f9fbf'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Tempest Wall.
 *
 * `wallWidth` and `wallHeight` are the two to reach for: they re-lay the rank,
 * re-span the lightning and re-scale the puddle at once, on a wall that is
 * already standing. After those, `sheetOverlap` decides whether it reads as a
 * wall or as a fence (below about 1.2 you can see between the sheets), and the
 * pair `alphaCurve` / `emissionCurve` is the one thing in the Curtain module
 * that must never be set equal — do it once and you will see the hanging
 * ribbon the module exists to avoid.
 */
export const stormwallSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 0.5, 'squall speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The three beats': [
    ['riseTime', 0.05, 3, 0.01, '1 · rise (s)'],
    ['holdTime', 0.2, 12, 0.05, '2 · hold (s)'],
    ['fallTime', 0.1, 5, 0.05, '3 · drain (s)']
  ],
  'The wall': [
    ['wallWidth', 1, 24, 0.1, 'width ACROSS the aim (m)'],
    ['wallHeight', 0.5, 14, 0.05, 'height (m)'],
    ['sheets', 1, 16, 1, 'sheets in the rank'],
    ['sheetOverlap', 0.5, 3, 0.01, 'sheet width × pitch'],
    ['sheetScatter', 0, 2, 0.01, 'rank slop (m)'],
    ['sheetLean', -3, 3, 0.01, 'head lean (m)'],
    ['sheetLeanJitter', 0, 2, 0.01, 'lean jitter'],
    ['sheetTaper', 0.2, 2.5, 0.01, 'head taper'],
    ['sheetWidthJitter', 0, 1, 0.01, 'width jitter'],
    ['sheetHeightJitter', 0, 1, 0.01, 'height jitter'],
    ['riseSpread', 0, 0.95, 0.01, 'rise stagger'],
    ['fallSink', 0, 3, 0.01, 'drain sink (m)'],
    ['phaseSpread', 0, 4, 0.01, 'phase spread']
  ],
  'The wall/The fold': [
    ['rippleAmp', 0, 3, 0.01, 'ripple (m)'],
    ['rippleLength', 0.2, 12, 0.05, 'ripple length (m)'],
    ['rippleSpeed', -6, 6, 0.01, 'ripple speed (m/s)'],
    ['rippleCurve', 0, 4, 0.01, 'ripple curve'],
    ['foldAmp', 0, 4, 0.01, 'fold (m)'],
    ['foldLength', 1, 24, 0.1, 'fold length (m)'],
    ['foldSpeed', -4, 4, 0.01, 'fold speed (m/s)'],
    ['rippleNoise', 0, 2, 0.01, 'slop (m)'],
    ['rippleNoiseScale', 0.02, 3, 0.01, 'slop scale'],
    ['rippleNoiseSpeed', 0, 2, 0.01, 'slop Hz']
  ],
  'The wall/The two curves': [
    ['alphaBase', 0, 2, 0.01, 'coverage at foot'],
    ['alphaTop', 0, 2, 0.01, 'coverage at head'],
    ['alphaCurve', 0.05, 6, 0.01, 'coverage curve'],
    ['emissionBase', 0, 3, 0.01, 'radiance at foot'],
    ['emissionTop', 0, 3, 0.01, 'radiance at head'],
    ['emissionCurve', 0.05, 6, 0.01, 'radiance curve']
  ],
  'The wall/The envelope': [
    ['body', 0, 1, 0.01, 'sheet body'],
    ['footFade', 0, 0.5, 0.005, 'foot fade'],
    ['headFade', 0, 1, 0.01, 'head fade'],
    ['edgeFade', 0, 1, 0.01, 'edge fade'],
    ['graze', 0, 2, 0.01, 'grazing path term'],
    ['grazeFloor', 0.02, 1, 0.01, 'grazing clamp'],
    ['curtainSoftFade', 0.02, 3, 0.01, 'soft fade (m)'],
    ['curtainOpacity', 0, 2, 0.01, 'opacity'],
    ['curtainGlow', 0, 4, 0.01, 'glow'],
    ['tintSpread', 0, 1, 0.01, 'tint spread']
  ],
  'The rain': [
    ['streakDensity', 1, 40, 0.5, 'lanes / metre'],
    ['streakRepeat', 0.2, 12, 0.05, 'streaks / height'],
    ['streakSpeed', 0, 12, 0.05, 'fall speed'],
    ['streakSpeedJitter', 0, 1, 0.01, 'speed jitter'],
    ['streakWidth', 0.02, 1, 0.005, 'streak width'],
    ['streakTail', 0.005, 0.6, 0.005, 'streak tail'],
    ['streakDuty', 0, 1, 0.01, 'lanes carrying'],
    ['haze', 0, 1, 0.01, 'veil'],
    ['colorRainTail', 'streak tail'],
    ['colorRainHead', 'drop head'],
    ['colorRainBody', 'sheet body']
  ],
  'The lightning': [
    ['boltFilaments', 0, 20, 1, 'filaments / strike'],
    ['strikeRate', 0, 12, 0.05, 'strikes / second'],
    ['strikeHold', 0.02, 1.5, 0.01, 'strike lifetime (s)'],
    ['boltTop', 0, 1.2, 0.01, 'start height × wall'],
    ['boltBottom', 0, 1, 0.01, 'end height × wall'],
    ['boltDrift', 0, 1.5, 0.01, 'end-to-end drift'],
    ['crackAngle', 0, 1.6, 0.01, 'fork angle (rad)'],
    ['crackLength', 0.05, 1, 0.01, 'fork length'],
    ['crackFalloff', 0, 1, 0.01, 'generation falloff'],
    ['crackSpread', 0, 1.5, 0.01, 'fork variation'],
    ['crackStart', 0, 0.9, 0.01, 'earliest fork'],
    ['crackSag', -2, 2, 0.01, 'segment bow (m)'],
    ['crackFork', 0, 1, 0.01, 'branch / twig split'],
    ['boltTaper', 0, 1, 0.01, 'trunk taper']
  ],
  'The lightning/Along the foot': [
    ['footFilaments', 0, 12, 1, 'filaments'],
    ['footSag', -2, 2, 0.01, 'sag (m)'],
    ['footSpread', 0, 3, 0.01, 'fan (m)'],
    ['footKink', 0, 3, 0.01, 'kink × shared'],
    ['footDim', 0, 1, 0.01, 'dim'],
    ['footDamp', 0, 1, 0.01, 'ground damp'],
    ['footFloor', 0, 0.5, 0.005, 'floor clamp (m)']
  ],
  'The lightning/The ribbon': [
    ['filWidth', 0.004, 0.4, 0.002, 'core width (m)'],
    ['filGlowWidth', 1, 20, 0.1, 'halo width'],
    ['filGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['filJitter', 0, 3, 0.01, 'kink (m)'],
    ['filJitterScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['filOctaves', 1, 5, 1, 'octaves'],
    ['filJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['filCrawl', -20, 20, 0.1, 'kink crawl'],
    ['filPinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['filRestrike', 0.5, 90, 0.5, 'restrikes / sec'],
    ['filFlicker', 0, 1, 0.01, 'brightness stutter'],
    ['filFlickerSpeed', 1, 120, 1, 'stutter rate'],
    ['filStrandFlash', 0, 1, 0.01, 'filament blink'],
    ['filCoreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['filGlowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['filSoftFade', 0.02, 3, 0.01, 'soft fade (m)'],
    ['filOpacity', 0, 2, 0.01, 'opacity'],
    ['filGlow', 0, 8, 0.01, 'glow'],
    ['colorBoltCore', 'core'],
    ['colorBoltInner', 'inner'],
    ['colorBoltOuter', 'outer'],
    ['colorBoltHalo', 'halo']
  ],
  'The wet floor': [
    ['wetRadius', 0.5, 20, 0.1, 'radius (m)'],
    ['wetForward', -6, 8, 0.05, 'centred downrange (m)'],
    ['wetHeight', 0.002, 0.2, 0.001, 'height above floor (m)'],
    ['wetDry', 0, 1, 0.01, 'dries back by (end of drain)'],
    ['wetEdge', 0.02, 3, 0.01, 'front feather (m)'],
    ['wetRagged', 0, 1, 0.01, 'front wander'],
    ['wetRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['wetWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['wetCell', 0.05, 4, 0.01, 'puddle scale (m)'],
    ['wetCellJitter', 0, 1, 0.01, 'puddle disorder'],
    ['wetLift', 0, 0.2, 0.001, 'ripple height (m)'],
    ['wetDepth', 0, 0.6, 0.005, 'puddle depth (m)'],
    ['wetSharp', 0, 1, 0.01, 'profile hardness'],
    ['wetDetail', 0, 1, 0.01, 'detail'],
    ['wetSpeed', 0, 6, 0.01, 'ripple rate'],
    ['wetFlow', 0, 3, 0.01, 'drift (m/s)'],
    ['wetWind', -3.2, 3.2, 0.01, 'drift bearing (rad)'],
    ['wetRelief', 0, 2, 0.01, 'relief'],
    ['wetNormalStep', 0.005, 0.3, 0.005, 'normal step (m)'],
    ['wetAmbient', 0, 1, 0.01, 'ambient'],
    ['wetWrap', 0, 1, 0.01, 'terminator wrap'],
    ['wetSpecular', 0, 3, 0.01, 'specular'],
    ['wetGloss', 1, 120, 1, 'gloss'],
    ['wetParallax', 0, 2, 0.01, 'parallax (m)'],
    ['wetEmissive', 0, 3, 0.01, 'emissive'],
    ['wetOpacity', 0, 1, 0.01, 'opacity'],
    ['wetDepthFade', 0.02, 3, 0.01, 'soft fade (m)'],
    ['colorWetBase', 'soaked stone'],
    ['colorWetEdge', 'sheen'],
    ['colorWetGlow', 'emissive'],
    ['colorWetDeep', 'puddle floor']
  ],
  'Spray, mist & sparks': [
    ['sprayRate', 0, 600, 1, 'spray rate'],
    ['spraySize', 0.005, 0.4, 0.005, 'spray size'],
    ['spraySpeed', 0, 12, 0.05, 'spray speed'],
    ['sprayLifetime', 0.05, 3, 0.01, 'spray lifetime'],
    ['sprayGravity', -40, 0, 0.1, 'spray gravity'],
    ['spraySpread', 0, 1, 0.01, 'spray cone'],
    ['mistRate', 0, 300, 1, 'mist rate'],
    ['mistSize', 0.05, 5, 0.01, 'mist size'],
    ['mistSpeed', 0, 6, 0.05, 'mist speed'],
    ['mistLifetime', 0.2, 10, 0.05, 'mist lifetime'],
    ['mistRise', -2, 4, 0.01, 'mist rise'],
    ['mistOpacity', 0, 1, 0.005, 'mist opacity'],
    ['strikeSparks', 0, 300, 1, 'sparks / strike'],
    ['sparkSize', 0.005, 0.8, 0.005, 'spark size'],
    ['sparkSpeed', 0, 30, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 3, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['colorSpray*', 'Spray colour'],
    ['colorMist*', 'Mist colour'],
    ['colorSpark*', 'Spark colour']
  ],
  'Camera & light': [
    ['riseShake', 0, 2, 0.01, 'shake on the rise'],
    ['riseShakeTime', 0.05, 3, 0.01, 'shake duration (s)'],
    ['strikeFlash', 0, 1, 0.005, 'flash per strike'],
    ['strikeLight', 0, 90, 0.5, 'light punch per strike'],
    ['holdRumble', 0, 0.4, 0.005, 'rumble while standing'],
    ['colorStrikeFlash', 'strike flash colour'],
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
