/* ================================================================== */
/* ORIGAMI — Paper Storm. A flock of cranes that unfolds in flight.    */
/* ================================================================== */
/**
 * The line cast built entirely out of **`vfx/FoldMesh.js`**.
 *
 * A flight of folded paper cranes is thrown down the aimed line. When they
 * arrive they **come apart** — every crease runs backwards through the sequence
 * it was folded in, the birds flatten into sheets of written paper, and the
 * sheets sink and go. The whole flock opens on **one number**, `progress`,
 * staggered per bird by `foldStagger`, and the ability's job is to drive that
 * number and nothing else.
 *
 * The single most important consequence of the module doing the folding is that
 * the paper **cannot stretch**: each crease is a rigid motion per material
 * point, so a half-open crane has exactly the surface area of a flat sheet at
 * every intermediate value. That is the trick, and it is the reason this block
 * has no "crane size while folded" key — there is no such quantity.
 *
 * Three beats, mapped onto the phase machine:
 *
 * | phase | what it is | how long |
 * | --- | --- | --- |
 * | travel | the flock flies, folded, appearing as the front passes their dice | `range / speed` |
 * | impact | **the unfold**, then a hold with the sheets flat in the air | `openTime + holdTime` |
 * | fade | the sheets sink, turn over and go | `sinkTime` |
 *
 * The four controls worth reaching for first are `foldStagger` (how much of a
 * ripple the opening is, versus the whole flock snapping open together),
 * `openTime`, `sheets`, and `ink` — a crane folded from a blank sheet is a
 * paper aeroplane, and a crane folded from a written one is the ability.
 *
 * **No bloom, anywhere.** Ink is the matte school. Nothing here is additive,
 * nothing goes through `ctx.flash`, `scrapGlow` ships well under 1, and the
 * paper material is the one tone-mapped material in `src/vfx/`. If any of this
 * starts to glow, that is a bug and not a look.
 *
 * Nothing below is captured by a cast. A cast rolls one seed; every metre,
 * radian and second is re-read on every frame, zero-length ones included.
 */
import { foldMeshSchema } from '../../vfx/FoldMesh.js';

/** The sheet, surface and writing folders come straight off the module. */
const PAPER = foldMeshSchema('Paper');

export const origami = {
  /* --- the cast --- */
  range: 21.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 15.0, // how fast the flock flies downrange, metres/second
  cooldown: 5.2,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats --- */
  openTime: 1.15, // seconds the flock spends coming apart
  holdTime: 0.55, // seconds the flat sheets hang in the air afterwards
  sinkTime: 1.35, // seconds of falling and fading — the fade phase

  /* ------------------------------------------------------------------ */
  /* The flight                                                          */
  /* ------------------------------------------------------------------ */
  /**
   * Where the birds are. All of it is `FoldMesh`'s `LINE` layout: the flock is
   * strung down the lane, scattered on unitless dice, and slid along it by
   * `travel` — so the *shape* of the flock is fixed per cast and its position
   * is a live function of the front.
   */
  sheets: 18, // live cranes, capped at 28 by the class
  spread: 1.9, // metres of lateral scatter across the lane
  stretch: 3.4, // metres of scatter along the lane — the flock's depth
  lift: 1.55, // metres off the floor the flock flies at
  liftJitter: 0.62, // ±metres per bird
  bob: 0.12, // metres of vertical breathing
  bobRate: 2.3, // radians/second of that breathing
  overrun: 2.8, // metres the flock coasts past the end of the line as it opens
  sink: 1.2, // metres/second the flat sheets fall through the fade

  /* --- attitude --- */
  flyPitch: -0.12, // radians of nose-up on the folded flock
  openPitch: 0.55, // extra radians of pitch by the time a sheet is flat
  yawJitter: 0.45, // ±radians per bird
  rollJitter: 0.5, // ±radians of bank per bird
  openRoll: 1.15, // radians a sheet turns over by as it opens
  /**
   * Radians/second of free rotation about the sheet's own normal.
   *
   * **Constant for the whole cast, deliberately.** The shader applies it as
   * `tumble × uTime`, and `uTime` is seconds since the app booted — so ramping
   * this from 0 as the birds open, which is what the first version did, slews
   * every sheet by `t · Δω` on the frame you change it: hundreds of radians, in
   * one frame, as an instant snap. The "it starts spinning as it opens" read is
   * bought instead by `openRoll`, which is a closed-form *angle* and can be
   * re-evaluated at will — including while paused.
   */
  tumble: 0.3,
  revealSpread: 0.42, // width of the appearance wave, as a fraction of the flock

  /* ------------------------------------------------------------------ */
  /* The unfold                                                          */
  /* ------------------------------------------------------------------ */
  /**
   * `progress` itself is not here: it is the beat, driven from 1 down to 0 (and
   * a stagger's worth above 1, so the last bird still starts closed) across the
   * impact phase. What is here is the *shape* of that run.
   */
  foldStagger: 0.55, // fraction of the unfold spread across the flock
  foldGain: 1.0, // multiplier on every crease angle; >1 overfolds
  hinge: 0.016, // metres — the crease radius. Under one grid cell it kinks.
  stageEase: 1.0, // 0 linear crease windows, 1 smoothstepped
  openLift: 0.42, // metres a sheet rises by as it opens — air under the paper

  /* ------------------------------------------------------------------ */
  /* The sheet                                                           */
  /* ------------------------------------------------------------------ */
  /** `CRANE` wants a square: `aspect` away from 1 opens the tips. */
  sheetWidth: 0.36, // metres across (the u axis)
  sheetLength: 0.36, // metres along (the v axis) — the head end is +v
  aspect: 1.0, // multiplier on the width. Leave at 1 for a crane.
  sizeJitter: 0.24, // ±fraction per bird
  thickness: 0.0009, // metres of paper per stacked flap — kills the z-fight

  /* --- the paper as an object --- */
  ambient: 0.5, // floor under the diffuse term
  tintSpread: 0.08, // ±per-sheet brightness walk
  paperOpacity: 1.0, // master coverage of the paper before the fade

  /* ------------------------------------------------------------------ */
  /* The surface — every key here is read by `FoldMesh` verbatim         */
  /* ------------------------------------------------------------------ */
  grain: 0.55, // how much fibre shows in the albedo
  grainScale: 62, // fibres per metre
  grainAngle: 0.25, // radians — the machine direction
  grainAniso: 8.5, // how far the fibres are stretched along it
  fleck: 0.3, // sparse darker specks in the pulp
  laid: 0.15, // the regular ribbing of a laid sheet
  laidPitch: 48, // lines per metre, the fine ones
  chainPitch: 1.9, // lines per metre, the coarse chain lines
  creaseGlow: 0.55, // how much a mountain crease catches the light
  creaseDark: 0.42, // how much a valley crease holds shadow
  creaseSharp: 1.7, // exponent on the band profile — apparent crease width
  transmit: 0.72, // how much light comes through the sheet from behind
  transmitPower: 5.0, // tightness of that lobe
  wrap: 0.42, // how far light bends around the sheet, 0..1
  sheen: 0.22, // grazing specular along the fibre
  gloss: 26, // specular exponent
  edge: 0.022, // deckle — the fraction of the sheet its edge thins over

  colorPaper: '#efe6d2', // the sheet, lit
  colorShade: '#b0a288', // the sheet, unlit
  colorTransmit: '#ffe4bb', // light coming *through* the paper
  colorCrease: '#fff8ea', // the highlight along a mountain fold

  /* ------------------------------------------------------------------ */
  /* The writing                                                         */
  /* ------------------------------------------------------------------ */
  /**
   * Hashed strokes in a grid, in **sheet space** — so the text folds with the
   * paper for free and comes out the right way round on a flap that has been
   * turned over twice. A crane folded from a blank sheet reads as plastic.
   */
  ink: 0.42, // 0 blank paper, 1 fully written
  inkRows: 13, // characters down the sheet
  inkCols: 5, // columns across
  inkFill: 0.72, // fraction of cells that carry a mark
  inkWeight: 0.075, // stroke half-width, cell units
  inkMargin: 0.1, // fraction of the sheet left blank at the edges
  inkSeed: 3.7, // shifts the whole text
  inkGhost: 0.34, // how much the writing shows through from the back
  colorInk: '#1d1613', // the writing

  /* ------------------------------------------------------------------ */
  /* The scraps — `vfx/Swarm.js`, one draw call                          */
  /* ------------------------------------------------------------------ */
  /**
   * Torn corners and offcuts flying with the flock, on `LEAF` silhouettes.
   *
   * They are not decoration: they are what makes the unfold read as *violent*
   * rather than as an animation, and they are driven by the same beat — their
   * `reveal` is `1 − progress`, so a scrap exists exactly to the extent that a
   * crane has come apart.
   */
  scraps: 96, // live scraps, capped at 192
  scrapSize: 0.115, // metres, nose to tail
  scrapAspect: 1.3, // span / length
  scrapSizeJitter: 0.45, // ±fraction
  scrapCurl: 0.38, // leaf curl across the chord, fraction of size
  scrapLatticeX: 5, // cells across the formation
  scrapLatticeY: 3, // cells up
  scrapLatticeZ: 7, // ranks strung out behind the lead
  scrapSpacing: 0.55, // metres between lateral cells
  scrapSpacingUp: 0.44, // metres between vertical cells
  scrapJitter: 0.34, // metres of slop off the cell
  scrapLag: 0.55, // seconds the back rank trails the lead by
  scrapChurn: 0.5, // radians/second the formation rolls — see `tumble`, same clock
  scrapBreathe: 0.22, // fraction the formation swells by
  scrapBreatheRate: 1.4, // radians/second
  scrapWander: 0.24, // metres of curl drift — keep under half the spacing
  scrapWanderScale: 0.6, // features per metre
  scrapWanderSpeed: 0.55, // drift rate
  scrapGather: 0.85, // 0 collapses every scrap onto the lead's own path
  scrapRise: 1.1, // metres the scrap lead lofts at mid-span
  scrapEnd: 1.2, // metres off the floor the scrap lead ends at
  scrapBank: 0.05, // radians of roll per m/s² of lateral acceleration
  scrapBankMax: 1.1, // radians
  scrapEdgeStretch: 1.5, // how much an edge-on scrap grows, ≥1
  scrapRevealSpread: 0.45, // width of the appearance wave
  scrapTint: 0.28, // where in the gradient the cloud sits
  scrapTintJitter: 0.35, // ±per-scrap walk along it
  scrapTintAlong: 0.4, // extra walk from the front of the cloud to the back
  scrapOpacity: 0.95, // coverage
  scrapGlow: 0.3, // emission. Ink does not bloom — keep this well under 1.
  scrapSoftFade: 0.3, // metres of depth feather against solid geometry
  colorScrapA: '#e8dcc2', // freshly torn
  colorScrapB: '#cbbb99',
  colorScrapC: '#a29070', // shaded — a scrap seen edge-on
  colorScrapD: '#7d6f58', // going

  /* ------------------------------------------------------------------ */
  /* Paper dust — `origami.dust`, SMOKE, non-additive                    */
  /* ------------------------------------------------------------------ */
  dustRate: 26, // particles/second while the flock is coming apart
  dustBurst: 40, // particles thrown on the frame the unfold starts
  dustSize: 0.5, // metres
  dustLifetime: 1.5, // seconds
  dustSpeed: 0.9, // metres/second
  dustRise: 0.35, // metres/second² of buoyancy
  dustSpread: 0.85, // radians of the emission cone
  dustOpacity: 0.4, // it is dust, not smoke
  dustTurbulence: 0.4, // curl noise strength
  colorDustA: '#e6dcc6',
  colorDustB: '#c9bda3',
  colorDustC: '#a1927a',
  colorDustD: '#6f6555',

  /* ------------------------------------------------------------------ */
  /* Chaff — `origami.chaff`, LEAF, lit and non-additive                 */
  /* ------------------------------------------------------------------ */
  chaffRate: 34, // particles/second during the unfold
  chaffBurst: 46, // particles per bird on the frame it opens
  chaffSize: 0.16, // metres
  chaffLifetime: 2.1, // seconds
  chaffSpeed: 2.4, // metres/second
  chaffGravity: -2.6, // metres/second² — paper falls slowly
  chaffSpin: 7.0, // radians/second of tumble
  chaffSpread: 0.95, // radians of the emission cone
  colorChaffA: '#f2e9d6',
  colorChaffB: '#d8c9a8',
  colorChaffC: '#b0a082',
  colorChaffD: '#6d6250',

  /* ------------------------------------------------------------------ */
  /* The floor and the camera                                            */
  /* ------------------------------------------------------------------ */
  ringRadius: 2.1, // metres — the dust ring dropped under the unfold
  ringLife: 1.5, // seconds it lasts
  ringIntensity: 0.55, // how strongly it reads against the floor
  colorRingA: '#ded2b8', // the ring, near
  colorRingB: '#8d8069', // the ring, far
  rumble: 0.04, // continuous camera shake while the flock is in the air
  openShake: 0.12, // one-shot shake on the frame the flock opens
  shakeDuration: 0.5, // seconds that shake takes to die

  /* --- the light --- */
  /**
   * One warm lamp riding the flock. Low, because a matte school should be lit
   * by the room rather than by itself — this exists so the birds catch an edge
   * against the floor, not so they glow.
   */
  lightColor: '#ffdca8', // the colour of that lamp
  lightIntensity: 2.6, // its intensity
  lightRadius: 7.5 // metres it reaches
};

/** Editor layout. The three paper folders come straight off `FoldMesh`. */
export const origamiSchema = {
  'The cast': [
    ['range', 4, 34, 0.5],
    ['minRange', 0, 10, 0.5, 'min range'],
    ['speed', 4, 40, 0.5],
    ['cooldown', 0, 14, 0.1],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['openTime', 0.15, 4, 0.05, 'unfold (s)'],
    ['holdTime', 0, 3, 0.05, 'hold (s)'],
    ['sinkTime', 0.2, 4, 0.05, 'sink (s)']
  ],
  'The flight': [
    ['sheets', 1, 28, 1, 'cranes'],
    ['spread', 0, 6, 0.05, 'lateral scatter (m)'],
    ['stretch', 0, 10, 0.05, 'depth (m)'],
    ['lift', 0, 5, 0.05, 'altitude (m)'],
    ['liftJitter', 0, 2.5, 0.05, 'altitude jitter (m)'],
    ['bob', 0, 0.6, 0.01, 'bob (m)'],
    ['bobRate', 0, 8, 0.05, 'bob rate'],
    ['overrun', 0, 10, 0.1, 'coast past end (m)'],
    ['sink', 0, 6, 0.05, 'fall (m/s)'],
    ['flyPitch', -1, 1, 0.01, 'pitch'],
    ['openPitch', -2, 2, 0.01, 'pitch when open'],
    ['yawJitter', 0, 3.2, 0.01, 'yaw jitter'],
    ['rollJitter', 0, 3.2, 0.01, 'roll jitter'],
    ['openRoll', -3.2, 3.2, 0.01, 'roll when open'],
    ['tumble', 0, 3, 0.01, 'tumble (rad/s)'],
    ['revealSpread', 0.01, 1, 0.01, 'appear wave']
  ],
  'The unfold': [
    ['foldStagger', 0, 1, 0.01, 'flock stagger'],
    ['foldGain', 0, 1.6, 0.01, 'fold gain'],
    ['hinge', 0.002, 0.2, 0.001, 'crease radius (m)'],
    ['stageEase', 0, 1, 0.01, 'stage ease'],
    ['openLift', -1, 2, 0.01, 'pop (m)']
  ],
  'Paper · sheet': PAPER['Paper · sheet'],
  'Paper · body': [
    ['ambient', 0, 1, 0.01],
    ['tintSpread', 0, 0.4, 0.01, 'tint spread'],
    ['paperOpacity', 0, 1, 0.01, 'opacity']
  ],
  'Paper · surface': PAPER['Paper · surface'],
  'Paper · writing': PAPER['Paper · writing'],
  'The scraps': [
    ['scraps', 0, 192, 1, 'count'],
    ['scrapSize', 0.01, 0.6, 0.005, 'size (m)'],
    ['scrapAspect', 0.3, 3, 0.01, 'aspect'],
    ['scrapSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['scrapCurl', 0, 1, 0.01, 'curl'],
    ['scrapLatticeX', 1, 12, 1, 'lattice across'],
    ['scrapLatticeY', 1, 8, 1, 'lattice up'],
    ['scrapLatticeZ', 1, 16, 1, 'ranks'],
    ['scrapSpacing', 0.05, 2, 0.01, 'spacing (m)'],
    ['scrapSpacingUp', 0.05, 2, 0.01, 'spacing up (m)'],
    ['scrapJitter', 0, 1.5, 0.01, 'jitter (m)'],
    ['scrapLag', 0, 2, 0.01, 'lag (s)'],
    ['scrapChurn', 0, 3, 0.01, 'churn'],
    ['scrapBreathe', 0, 1, 0.01, 'breathe'],
    ['scrapBreatheRate', 0, 6, 0.05, 'breathe rate'],
    ['scrapWander', 0, 1, 0.01, 'wander (m)'],
    ['scrapWanderScale', 0.05, 3, 0.05, 'wander scale'],
    ['scrapWanderSpeed', 0, 3, 0.05, 'wander speed'],
    ['scrapGather', 0, 1, 0.01, 'gather'],
    ['scrapRise', -2, 5, 0.05, 'lead rise (m)'],
    ['scrapEnd', 0, 5, 0.05, 'lead end (m)'],
    ['scrapBank', 0, 0.3, 0.005, 'bank'],
    ['scrapBankMax', 0, 3, 0.01, 'bank max'],
    ['scrapEdgeStretch', 1, 4, 0.05, 'edge stretch'],
    ['scrapRevealSpread', 0.01, 1, 0.01, 'appear wave'],
    ['scrapTint', 0, 1, 0.01, 'tint'],
    ['scrapTintJitter', 0, 1, 0.01, 'tint jitter'],
    ['scrapTintAlong', 0, 1, 0.01, 'tint along'],
    ['scrapOpacity', 0, 1, 0.01, 'opacity'],
    ['scrapGlow', 0, 1.5, 0.01, 'glow'],
    ['scrapSoftFade', 0, 2, 0.01, 'soft fade'],
    'colorScrapA',
    'colorScrapB',
    'colorScrapC',
    'colorScrapD'
  ],
  'Paper dust': [
    ['dustRate', 0, 160, 1, 'rate (/s)'],
    ['dustBurst', 0, 200, 1, 'burst'],
    ['dustSize', 0.05, 3, 0.01, 'size (m)'],
    ['dustLifetime', 0.1, 6, 0.05, 'lifetime (s)'],
    ['dustSpeed', 0, 6, 0.05, 'speed (m/s)'],
    ['dustRise', -2, 4, 0.05, 'rise (m/s²)'],
    ['dustSpread', 0, 1.6, 0.01, 'cone'],
    ['dustOpacity', 0, 1, 0.01, 'opacity'],
    ['dustTurbulence', 0, 2, 0.01, 'turbulence'],
    'colorDustA',
    'colorDustB',
    'colorDustC',
    'colorDustD'
  ],
  'Chaff': [
    ['chaffRate', 0, 200, 1, 'rate (/s)'],
    ['chaffBurst', 0, 200, 1, 'burst'],
    ['chaffSize', 0.02, 1, 0.005, 'size (m)'],
    ['chaffLifetime', 0.1, 6, 0.05, 'lifetime (s)'],
    ['chaffSpeed', 0, 12, 0.05, 'speed (m/s)'],
    ['chaffGravity', -12, 2, 0.05, 'gravity (m/s²)'],
    ['chaffSpin', 0, 20, 0.1, 'spin (rad/s)'],
    ['chaffSpread', 0, 1.6, 0.01, 'cone'],
    'colorChaffA',
    'colorChaffB',
    'colorChaffC',
    'colorChaffD'
  ],
  'Floor and camera': [
    ['ringRadius', 0.2, 8, 0.05, 'dust ring (m)'],
    ['ringLife', 0.1, 5, 0.05, 'ring life (s)'],
    ['ringIntensity', 0, 2, 0.01, 'ring strength'],
    'colorRingA',
    'colorRingB',
    ['rumble', 0, 0.6, 0.005],
    ['openShake', 0, 1.2, 0.01, 'unfold shake'],
    ['shakeDuration', 0.05, 2, 0.05, 'shake decay (s)']
  ],
  'The light': [
    'lightColor',
    ['lightIntensity', 0, 20, 0.1, 'intensity'],
    ['lightRadius', 1, 30, 0.5, 'radius (m)']
  ]
};
