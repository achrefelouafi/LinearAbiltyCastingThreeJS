/* ================================================================== */
/* SCROLLWARD — a ring of scrolls that unrolls into a wall of text     */
/* ================================================================== */
/**
 * The far cast built on **`FoldMesh`'s `UNROLL` mode**.
 *
 * A ring of scrolls stands up around the aimed circle and pays itself out: the
 * spools climb, the paper hangs behind them, and what was a row of rolls on the
 * floor becomes a wall of writing you can walk round.
 *
 * ## What the module is doing, and why the numbers below are what they are
 *
 * The sheet is placed **by arc length from the free end**, which is the entire
 * reason this reads as paper rather than as a scrolling texture:
 *
 *  - the paid-out run is an arc of constant curvature `curl`, in **1/metres**.
 *    Paper keeps a set from having been rolled and loses it as it hangs, so
 *    this block carries *two* of them — `curlRoll` while there is still a fat
 *    roll at the top, `curlFlat` once the sheet is fully out — and the ability
 *    walks between them on the payout. The lean of the wall is that number;
 *  - the wound part is a real **Archimedean spiral**, `r = √(r₀² + wt/π)`,
 *    where `core` is `r₀` and `paper` is the sheet thickness `t`. It tightens
 *    toward the spool because that is what a square root does. Make `paper`
 *    thicker and the roll is fatter and shorter for the same length of sheet,
 *    exactly as it would be on a table;
 *  - because every mark on the paper — grain, laid lines, the writing — is a
 *    function of the **sheet coordinate** and nothing else, the foreshortening
 *    of the text as it comes off the roll is free and it is *correct*. The
 *    shader never learns it is on a curve. Place by fraction of the sheet
 *    instead of by arc length and the writing bunches at the spool and stretches
 *    on the run, which is the single tell that separates this from a decal.
 *
 * Three beats, mapped onto the phase machine:
 *
 * | phase | what it is | how long |
 * | --- | --- | --- |
 * | travel | the seed crosses to the circle; the rolls are already lying there | `range / speed` |
 * | impact | **the payout**, then a hold with the wall standing | `unrollTime + holdTime` |
 * | fade | the scrolls **wind back up** and go | `windTime` |
 *
 * The four controls worth reaching for first are `sheetLength` (how tall the
 * wall is — the roll and the run share it, because they are the same paper),
 * `curlRoll`, `ink`, and `scrolls`.
 *
 * **No bloom.** Ink is the matte school: nothing here is additive, there is no
 * screen flash, and the one light is a low warm lamp so the wall casts an edge.
 *
 * Nothing below is captured by a cast. A cast rolls one seed; every metre,
 * radian and second is re-read on every frame, zero-length ones included.
 */
import { foldMeshSchema } from '../../vfx/FoldMesh.js';

/** The sheet, surface and writing folders come straight off the module. */
const PAPER = foldMeshSchema('Paper');

export const scrollward = {
  /* --- the cast --- */
  range: 19.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  speed: 42.0, // how fast the seed crosses to the circle, metres/second
  cooldown: 6.4,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 4.6, // the footprint — what the circle indicator measures out

  /* --- the beats --- */
  unrollTime: 1.5, // seconds the wall takes to pay out
  holdTime: 1.7, // seconds it stands there afterwards
  windTime: 1.25, // seconds it takes to wind back up and go — the fade phase
  payoutSeed: 0.05, // how much paper is off the roll before the cast lands, 0..1
  payoutEnd: 1.0, // how much is off it at full extension, 0..1
  rewind: 0.12, // how far back onto the roll the fade takes it, 0..1
  windHold: 0.42, // fraction of the fade the wall stays opaque for while it winds

  /* ------------------------------------------------------------------ */
  /* The wall                                                            */
  /* ------------------------------------------------------------------ */
  /**
   * `FoldMesh`'s `ZONE` layout: every scroll stands upright on a circle with
   * its face turned outward, so the ring reads as a wall from outside and as a
   * room from inside. `arc` under a full turn makes it a screen rather than an
   * enclosure, which is the other half of what this layout is for.
   */
  scrolls: 13, // live scrolls, capped at 20 by the class
  ringRadius: 0.94, // the ring, × zoneRadius
  radiusJitter: 0.09, // ±fraction per scroll — a hand-placed row, not a fence
  arc: 6.283185, // radians the ring covers; a full turn is a closed room
  arcPhase: 0.22, // radians — where the first scroll stands
  lift: 0.03, // metres the free end sits off the floor
  liftJitter: 0.025, // ±metres
  bob: 0.018, // metres of breathing — paper in a room with air in it
  bobRate: 0.9, // radians/second
  yawJitter: 0.14, // ±radians each scroll is turned off true by
  rollJitter: 0.05, // ±radians of lean about its own face
  pitch: 0.0, // radians the whole ring tips
  sizeJitter: 0.14, // ±fraction per scroll
  revealSpread: 0.55, // width of the wave that brings the scrolls into being
  /**
   * Radians/second of rotation about the sheet's normal. Ships at 0 and should
   * stay there for a standing scroll: the shader applies it as `tumble × uTime`
   * with `uTime` counting from app start, so any non-zero value has the ring
   * already spun through hundreds of radians by the time you cast. It is
   * exposed because a slow drift on a *short* scroll is a look, not because a
   * scroll should turn.
   */
  tumble: 0.0,

  /* ------------------------------------------------------------------ */
  /* The roll                                                            */
  /* ------------------------------------------------------------------ */
  /**
   * The spool's core radius, `r₀` in the spiral, in metres.
   *
   * 60 mm rather than the 30 mm a real scroll rod would be, and the reason is
   * tessellation rather than taste: the mesh has a fixed number of segments
   * along the sheet, so *segments per turn* is `segmentsV × 2πr / sheetLength`.
   * Halving the core doubles the number of turns 3.2 m of paper has to make and
   * halves the segments each one gets, and the roll goes from a circle to a
   * nut. If you want a thinner rod, shorten the sheet with it.
   */
  core: 0.06,
  paper: 0.0012, // metres — sheet thickness, t. Sets how fast the roll grows.
  curlRoll: 0.6, // 1/metres of set in the run while most of it is still wound
  curlFlat: 0.13, // 1/metres once it is fully paid out — the paper relaxes
  spoolClimb: 1.0, // 0 pins the spool and the sheet falls; 1 the wall rises
  spin: 0.0, // radians of phase on the roll

  /* ------------------------------------------------------------------ */
  /* The sheet                                                           */
  /* ------------------------------------------------------------------ */
  sheetWidth: 0.64, // metres across
  sheetLength: 3.2, // metres along — the roll and the run share this
  aspect: 1.0, // multiplier on the width
  thickness: 0.0006, // metres per stacked flap. `UNROLL` has no flaps; harmless.

  /* --- the paper as an object --- */
  ambient: 0.48, // floor under the diffuse term
  tintSpread: 0.07, // ±per-scroll brightness walk — no two sheets the same age
  paperOpacity: 1.0, // master coverage before the fade
  woundShade: 0.42, // how much darker the paper is where it is still on the roll

  /* ------------------------------------------------------------------ */
  /* The surface — every key here is read by `FoldMesh` verbatim         */
  /* ------------------------------------------------------------------ */
  grain: 0.6, // how much fibre shows in the albedo
  grainScale: 48, // fibres per metre
  grainAngle: 1.4, // radians — the machine direction runs across a scroll
  grainAniso: 12, // how far the fibres are stretched along it
  fleck: 0.34, // sparse darker specks in the pulp
  laid: 0.2, // the regular ribbing of a laid sheet
  laidPitch: 34, // lines per metre, the fine ones
  chainPitch: 1.4, // lines per metre, the coarse chain lines
  creaseGlow: 0.25, // a scroll has no creases; kept low for the deckle
  creaseDark: 0.2, // ... and the same for the shadow side
  creaseSharp: 1.6, // exponent on the band profile
  transmit: 0.85, // how much light comes through the sheet from behind
  transmitPower: 4.0, // tightness of that lobe — a wide one, it is thin paper
  wrap: 0.5, // how far light bends around the sheet, 0..1
  sheen: 0.18, // grazing specular along the fibre
  gloss: 22, // specular exponent
  edge: 0.014, // deckle — the fraction of the sheet its edge thins over

  colorPaper: '#e8dcc0', // the sheet, lit
  colorShade: '#a89880', // the sheet, unlit
  colorTransmit: '#ffdfae', // light coming *through* the paper
  colorCrease: '#fff4de', // the highlight along the deckle and the tangent line

  /* ------------------------------------------------------------------ */
  /* The writing                                                         */
  /* ------------------------------------------------------------------ */
  /**
   * Columns of hashed strokes in **sheet space**, which is what makes the
   * foreshortening real: the text is printed on the material, so it compresses
   * exactly as much as the paper it is on does where it turns onto the roll.
   * Nothing in the fragment shader knows about the curve.
   */
  ink: 0.86, // 0 blank paper, 1 fully written
  inkRows: 26, // characters down the scroll
  inkCols: 4, // columns across it
  inkFill: 0.86, // fraction of cells that carry a mark
  inkWeight: 0.06, // stroke half-width, cell units
  inkMargin: 0.07, // fraction of the sheet left blank at the edges
  inkSeed: 11.3, // shifts the whole text
  inkGhost: 0.32, // how much the writing shows through from the back
  colorInk: '#201914', // the writing

  /* ------------------------------------------------------------------ */
  /* Dust off the spools — `scrollward.dust`, SMOKE, non-additive        */
  /* ------------------------------------------------------------------ */
  dustRate: 34, // particles/second while the wall is paying out
  dustBurst: 40, // particles thrown on the frame the scrolls stand up
  dustSize: 0.42, // metres
  dustLifetime: 1.7, // seconds
  dustSpeed: 0.7, // metres/second
  dustRise: 0.22, // metres/second² of buoyancy
  dustSpread: 0.9, // radians of the emission cone
  dustOpacity: 0.36, // it is dust, not smoke
  dustTurbulence: 0.35, // curl noise strength
  colorDustA: '#e2d7bd',
  colorDustB: '#c4b79a',
  colorDustC: '#9c8f76',
  colorDustD: '#6b6153',

  /* ------------------------------------------------------------------ */
  /* Flakes — `scrollward.flakes`, LEAF, lit and non-additive            */
  /* ------------------------------------------------------------------ */
  flakeRate: 22, // particles/second, shed from the spool as it climbs
  flakeBurst: 34, // particles on the frame the wall stands up
  flakeSize: 0.1, // metres
  flakeLifetime: 2.4, // seconds
  flakeSpeed: 1.1, // metres/second
  flakeGravity: -2.2, // metres/second² — a flake of paper falls slowly
  flakeSpin: 5.5, // radians/second of tumble
  flakeSpread: 0.85, // radians of the emission cone
  colorFlakeA: '#efe4cc',
  colorFlakeB: '#d3c4a4',
  colorFlakeC: '#a8977b',
  colorFlakeD: '#6a6050',

  /* ------------------------------------------------------------------ */
  /* The floor and the camera                                            */
  /* ------------------------------------------------------------------ */
  markCount: 6, // how many dust marks are stamped round the ring at impact
  markRadius: 0.62, // metres — the radius of one of them
  markLife: 1.9, // seconds it lasts
  markIntensity: 0.5, // how strongly it reads against the floor
  colorMarkA: '#dccfb4', // the mark, near
  colorMarkB: '#8b7f68', // the mark, far
  rumble: 0.03, // continuous camera shake while the wall is paying out
  standShake: 0.14, // one-shot shake on the frame the scrolls stand up
  shakeDuration: 0.6, // seconds that shake takes to die

  /* --- the light --- */
  /**
   * One warm lamp inside the ring, climbing with the wall so the inside faces
   * stay lit as they rise. Low: the wall should be lit by the room, and this
   * exists so the paper's translucency has something to be translucent *to*.
   */
  lightColor: '#ffdaa4', // the colour of that lamp
  lightIntensity: 3.2, // its intensity
  lightRadius: 9.0, // metres it reaches
  lightHeight: 0.55 // its height as a fraction of the paid-out wall
};

/** Editor layout. The three paper folders come straight off `FoldMesh`. */
export const scrollwardSchema = {
  'The cast': [
    ['range', 4, 34, 0.5],
    ['minRange', 0, 10, 0.5, 'min range'],
    ['speed', 6, 90, 0.5],
    ['cooldown', 0, 14, 0.1],
    ['castAnim', 'cast animation'],
    ['zoneRadius', 1, 12, 0.1, 'footprint (m)']
  ],
  'The beats': [
    ['unrollTime', 0.2, 5, 0.05, 'payout (s)'],
    ['holdTime', 0, 6, 0.05, 'hold (s)'],
    ['windTime', 0.2, 4, 0.05, 'wind back (s)'],
    ['payoutSeed', 0, 0.5, 0.005, 'payout on arrival'],
    ['payoutEnd', 0.05, 1, 0.005, 'payout, full'],
    ['rewind', 0, 1, 0.005, 'payout, wound back'],
    ['windHold', 0, 0.95, 0.01, 'opaque through the wind']
  ],
  'The wall': [
    ['scrolls', 1, 20, 1, 'count'],
    ['ringRadius', 0.1, 2, 0.01, 'ring (× footprint)'],
    ['radiusJitter', 0, 0.5, 0.005, 'ring jitter'],
    ['arc', 0.2, 6.284, 0.01, 'arc (rad)'],
    ['arcPhase', 0, 6.284, 0.01, 'first scroll'],
    ['lift', -0.5, 2, 0.01, 'free end (m)'],
    ['liftJitter', 0, 0.5, 0.005, 'free end jitter (m)'],
    ['bob', 0, 0.3, 0.005, 'bob (m)'],
    ['bobRate', 0, 6, 0.05, 'bob rate'],
    ['yawJitter', 0, 1.6, 0.01, 'yaw jitter'],
    ['rollJitter', 0, 1, 0.01, 'lean jitter'],
    ['pitch', -1, 1, 0.01, 'ring tip'],
    ['sizeJitter', 0, 1, 0.01, 'size jitter'],
    ['revealSpread', 0.01, 1, 0.01, 'appear wave'],
    ['tumble', 0, 2, 0.01, 'tumble (rad/s)']
  ],
  'The roll': [
    ['core', 0.005, 0.3, 0.001, 'core (m)'],
    ['paper', 0.0001, 0.004, 0.00005, 'thickness (m)'],
    ['curlRoll', -1.5, 1.5, 0.01, 'set, wound (1/m)'],
    ['curlFlat', -1.5, 1.5, 0.01, 'set, paid out (1/m)'],
    ['spoolClimb', 0, 1, 0.01, 'spool climbs'],
    ['spin', 0, 6.283, 0.01, 'roll phase']
  ],
  'Paper · sheet': [
    ['sheetWidth', 0.05, 4, 0.01, 'width (m)'],
    ['sheetLength', 0.2, 8, 0.01, 'length (m)'],
    ['aspect', 0.25, 4, 0.01],
    ['thickness', 0, 0.006, 0.0001, 'flap offset (m)']
  ],
  'Paper · body': [
    ['ambient', 0, 1, 0.01],
    ['tintSpread', 0, 0.4, 0.01, 'tint spread'],
    ['paperOpacity', 0, 1, 0.01, 'opacity'],
    ['woundShade', 0, 1, 0.01, 'roll shading']
  ],
  'Paper · surface': PAPER['Paper · surface'],
  'Paper · writing': PAPER['Paper · writing'],
  'Spool dust': [
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
  'Flakes': [
    ['flakeRate', 0, 160, 1, 'rate (/s)'],
    ['flakeBurst', 0, 200, 1, 'burst'],
    ['flakeSize', 0.02, 1, 0.005, 'size (m)'],
    ['flakeLifetime', 0.1, 6, 0.05, 'lifetime (s)'],
    ['flakeSpeed', 0, 12, 0.05, 'speed (m/s)'],
    ['flakeGravity', -12, 2, 0.05, 'gravity (m/s²)'],
    ['flakeSpin', 0, 20, 0.1, 'spin (rad/s)'],
    ['flakeSpread', 0, 1.6, 0.01, 'cone'],
    'colorFlakeA',
    'colorFlakeB',
    'colorFlakeC',
    'colorFlakeD'
  ],
  'Floor and camera': [
    ['markCount', 0, 12, 1, 'floor marks'],
    ['markRadius', 0.1, 4, 0.05, 'mark size (m)'],
    ['markLife', 0.1, 6, 0.05, 'mark life (s)'],
    ['markIntensity', 0, 2, 0.01, 'mark strength'],
    'colorMarkA',
    'colorMarkB',
    ['rumble', 0, 0.6, 0.005],
    ['standShake', 0, 1.2, 0.01, 'stand-up shake'],
    ['shakeDuration', 0.05, 2, 0.05, 'shake decay (s)']
  ],
  'The light': [
    'lightColor',
    ['lightIntensity', 0, 20, 0.1, 'intensity'],
    ['lightRadius', 1, 30, 0.5, 'radius (m)'],
    ['lightHeight', 0, 1.5, 0.01, 'height (× wall)']
  ]
};
