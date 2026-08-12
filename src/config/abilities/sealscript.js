/* ================================================================== */
/* SEALSCRIPT — Seal Script                                            */
/* ================================================================== */
/**
 * A column of characters written top-to-bottom in the air over a wash of ink.
 *
 * The trick is **legible brush weight in three dimensions**. Ten seal-script
 * skeletons are authored in `abilities/ink/SealscriptAbility.js` as unitless
 * control points in an em box; every one of those points is turned into metres
 * here, every frame. Each stroke is drawn in sequence with a real entry, body
 * and exit, and — this is the part that matters — each one is a **swept
 * ellipse**, not a billboard. `depth` is a genuine half-thickness through the
 * paper normal, so orbiting to ninety degrees off the writing gives you a
 * column of ink *bars* rather than a column that has vanished.
 *
 * ### The three keys the trick lives in
 *
 *  - `depth` — metres of half-thickness through the paper normal. At the
 *    default 0.024 m against a `strokeWidth` of 0.030 m the cross-section is
 *    very nearly round, which is why the writing survives being looked at
 *    edge-on. Drop it to 0.002 and the column disappears when you orbit; that
 *    is the failure this ability exists to not have.
 *  - `columnBow` — metres the middle of each character bulges toward the
 *    reader. A perfectly flat plane of characters reads as a decal the moment
 *    the camera moves. A barrel gives the column volume and the strokes at the
 *    edges of the em box genuinely recede.
 *  - `charTwist` — radians of yaw between one character and the next, so the
 *    column fans instead of lying in one plane. Small. At 0.2 it stops being
 *    writing and starts being a mobile.
 *
 * ### The brush is round
 *
 * `BrushTip.ROUND` rather than the sumi hake, because seal script is written
 * with a round brush and because a round ferrule spreads its bristles on a disc
 * — which is the only tip layout where `ferruleDepth` does anything. That
 * matters here and nowhere else: it is what puts grain *through* the stroke as
 * well as across it, so the depth axis has structure in it rather than being an
 * extruded silhouette.
 *
 * ### Even weight is the legibility
 *
 * Seal script has almost constant stroke weight, and that evenness is exactly
 * what makes it read as *writing* rather than as painting. So `pressEntry` and
 * `pressExit` are high (0.74 / 0.66) where sumi's are near zero: the brush is
 * tucked in at both ends and never lifts to a point. `inkFalloff` is the one
 * concession — the brush genuinely does get drier down a column — and at 0.22
 * the last character has a little fray in it and the first does not.
 *
 * ### No bloom
 *
 * `ceiling` clamps the material's output linear luminance against
 * `post.bloomThreshold` (0.88), so 0.62 makes it arithmetically impossible for
 * this slot to feed the bloom pass. `washCeiling` does the same for the ground
 * wash. Both are the anti-glow contract, not a taste setting.
 */

export const sealscript = {
  /* --- the cast --- */
  range: 17.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 140.0, // how fast the brush reaches the point, metres/second
  zoneRadius: 3.4, // the wash's footprint, metres — the circle the aim drew
  cooldown: 1.6, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats, in seconds --- */
  leadTime: 0.28, // seconds before the first mark; the brush is on its way
  writeTime: 2.1, // seconds the whole column takes to write itself
  holdTime: 1.9, // seconds it hangs, finished
  fadeTime: 1.7, // seconds it takes to go

  /* ================================================================ */
  /* The column                                                        */
  /* ================================================================ */
  chars: 5, // characters in the column, 1..6
  emSize: 0.62, // metres — the em box. A measurement, not a proportion
  charPitch: 1.34, // slot pitch, in em boxes
  baseHeight: 0.95, // metres above the floor the LOWEST character's centre sits
  columnDrift: 0.07, // metres of per-character lateral wander; a hand is not a printer
  columnBow: 0.09, // metres the middle of a character bulges toward the reader
  charTwist: 0.055, // radians of yaw between one character and the next
  charPause: 0.55, // stroke-widths of pause between characters, in the drawing clock
  strokeOverlap: 0.35, // how far a stroke's window overruns the next one's start

  /* ================================================================ */
  /* The brush — BrushStroke, ROUND tip                                */
  /* ================================================================ */
  strokeWidth: 0.03, // metres, ferrule half-width at pressure 1
  depth: 0.024, // metres, half-thickness through the paper normal. THE TRICK
  ferruleDepth: 0.008, // metres the bristles spread through it — ROUND tips only
  bristleWidth: 2.4, // >1 overlaps into a solid stroke; high, because seal script is solid
  splay: 0.1, // fraction the bristles fan out at full pressure
  wobble: 0.0035, // metres of per-bristle lateral wander
  fibreScale: 9.0, // features per metre of that wander — small strokes, fine grain

  /* --- pressure: even, tucked at both ends --- */
  pressEntry: 0.74, // pressure control points, scaled by each stroke's own weight
  pressSwell: 0.98,
  pressHold: 0.94,
  pressExit: 0.66,

  /* ================================================================ */
  /* The ink                                                           */
  /* ================================================================ */
  inkLoad: 1.0, // multiplier on every stroke's own metre-pigment load
  strokeInk: 2.6, // metre-pigment per stroke; a stroke is ~0.3 m, so it stays wet
  inkFalloff: 0.22, // fraction of that lost by the last character in the column
  flowLength: 0.7, // pigment laid per metre of travel, at pressure 1
  flowDwell: 0.3, // extra pigment laid per metre when the brush dwells
  speedRef: 1.6, // metres per unit t at which the brush counts as "at speed"
  edgeStarve: 0.6, // load multiplier at the edge of the ferrule
  loadJitter: 0.3, // +/- fraction of load, per bristle
  dryBand: 0.7, // metre-pigment over which a bristle goes wet -> dry
  dryThin: 0.6, // width multiplier when a bristle is fully dry
  skipScale: 11.0, // features per metre of the contact noise
  skipSoft: 0.14, // softness of the contact threshold
  skipContrast: 1.7, // pushes the value noise off its central pile
  poolSwell: 0.4, // fraction the stroke widens per unit of extra pigment
  poolCurve: 0.05, // extra pigment per 1/metre of curvature — LOW, see the class doc
  pigment: 1.0, // overall density multiplier

  /* ================================================================ */
  /* The mark                                                          */
  /* ================================================================ */
  headTaper: 0.16, // fraction of the drawn length the moving head tapers over
  wetLength: 0.16, // metres behind the head that still read wet
  bleed: 0.3, // fraction of the bristle half-width the edge wicks over
  fibreEdge: 0.1, // capillary roughness of that edge
  dryPigment: 0.72, // density multiplier where a bristle is dry
  wetGain: 0.4, // extra density in the wet band behind the head
  opacity: 1.0,
  lit: 0.5, // 0 flat pigment, 1 wrapped diffuse. Higher than sumi: this has volume
  backLit: 0.6, // the floor of that wrap
  ceiling: 0.62, // max linear luminance. post.bloomThreshold is 0.88. DO NOT RAISE
  softFade: 0.1, // metres of depth feather — it hangs in air, so this can be generous
  tint: 0.28, // where in the gradient a zero-density mark sits
  tintDensity: 0.7, // how far density walks it
  tintJitter: 0.06, // +/- per bristle
  colorWash: '#a89b86', // the palest wicked edge
  colorBody: '#4e453c',
  colorInk: '#171412',
  colorPool: '#050404',

  /* ================================================================ */
  /* The ground wash — InkDiffusion(WASH)                              */
  /* ================================================================ */
  washHeight: 0.02, // metres above the floor
  washSpread: 1.9, // metres of front radius at t = 1 s
  washPower: 0.45, // r ~ t^power; 0.5 is Fickian diffusion
  washEdge: 0.14, // metres, the width of the interface
  washClip: 0.9, // metres the mass fades out over as it reaches `zoneRadius`
  washSources: 3, // live nuclei, so the pool is not a perfect disc
  washScatter: 0.3, // fraction of the radius the extra nuclei scatter over
  washDelay: 0.22, // seconds each later nucleus starts behind the first
  washCore: 0.55, // density floor inside the blob
  washFalloff: 3.4, // metres of e-folding out from a nucleus
  washFilm: 0.5, // alpha floor inside the coverage
  washGranulation: 0.3, // pigment settling into the floor's tooth
  washGranScale: 1.4, // features per metre
  washRing: 0.6, // strength of the deposition line at the interface
  washRingWidth: 0.15, // metres
  washDryTime: 2.4, // seconds for the gloss to fall to 1/e
  washWetDarken: 0.32, // how far the wet film pulls toward `colorWashWet`
  washGloss: 0.2, // specular strength on the wet film — under the ceiling
  washGlossPower: 40, // its tightness
  washMeniscus: 0.5, // how far the film's normal tips at the interface
  washOpacity: 0.9,
  washCeiling: 0.62, // the same anti-bloom clamp, for the same reason
  washSoftFade: 0.22, // metres of depth feather
  washTint: 0.08, // where in the gradient a zero-density film sits
  washTintDensity: 1.0, // how far density walks it
  /* Named `film`, not `wash`, on purpose: the brush already owns `colorWash`
   * for its palest wicked edge, and two colour keys one character apart is how
   * a picker ends up bound to the wrong thing. */
  colorFilmA: '#a29480', // thinnest film
  colorFilmB: '#4a4139',
  colorFilmC: '#1b1714',
  colorFilmD: '#080706',
  colorFilmRing: '#2b1f18', // the deposition line at the interface
  colorFilmWet: '#0f0c09', // what the still-wet film pulls toward
  colorFilmGloss: '#c4cad0', // the specular on it

  /* ================================================================ */
  /* Ink motes — pigment lifting off the wet strokes                   */
  /* ================================================================ */
  moteRate: 30.0, // particles/second while the brush is writing
  moteSize: 0.05,
  moteSpeed: 0.5, // metres/second
  moteLifetime: 1.7, // seconds
  moteRise: 0.25, // metres/second²
  moteTurbulence: 0.55,
  moteOpacity: 0.45,
  moteGlow: 0.3, // held low: a matte school does not get bright particles
  colorMoteA: '#8b8071',
  colorMoteB: '#494037',
  colorMoteC: '#221d19',
  colorMoteD: '#0c0a09',

  /* ================================================================ */
  /* Drips — ink that ran off a stroke and fell into the wash          */
  /* ================================================================ */
  dripRate: 5.0, // droplets/second, from the strokes already written
  dripBurst: 12, // droplets thrown when the last stroke lands
  dripSize: 0.045,
  dripSpeed: 0.5,
  dripLifetime: 1.6,
  dripGravity: -8.5, // metres/second²
  dripOpacity: 0.9,
  colorDripA: '#5d5348',
  colorDripB: '#2d2722',
  colorDripC: '#141110',
  colorDripD: '#060505',

  /* ================================================================ */
  /* Feel                                                              */
  /* ================================================================ */
  rumble: 0.008, // camera rumble while the column is being written. Tiny
  finishShake: 0.05, // one-shot nudge as the last stroke is completed
  shakeDuration: 0.45, // seconds

  /* ================================================================ */
  /* Dynamic light                                                     */
  /* ================================================================ */
  /* A small warm lamp riding the brush, so the wash below the column reads
   * damp. Ink emits nothing; this lights the paper. Turn it to 0 and the slot
   * still works. */
  lightIntensity: 3.6,
  lightRadius: 5.5, // metres
  lightColor: '#c6b69c'
};

/** Editor layout: which folders exist and what goes in them. */
export const sealscriptSchema = {
  'The cast': [
    ['range', 4, 40, 0.5, 'range (m)'],
    ['minRange', 0.5, 12, 0.1, 'minimum range (m)'],
    ['speed', 10, 300, 1, 'travel speed (m/s)'],
    ['zoneRadius', 0.5, 14, 0.1, 'wash radius (m)'],
    ['cooldown', 0.1, 6, 0.05, 'cooldown (s)'],
    'castAnim',
    ['leadTime', 0, 3, 0.01, 'lead-in (s)'],
    ['writeTime', 0.2, 12, 0.05, 'write (s)'],
    ['holdTime', 0.1, 10, 0.05, 'hold (s)'],
    ['fadeTime', 0.2, 8, 0.05, 'fade (s)']
  ],
  'The column': [
    ['chars', 1, 6, 1, 'characters'],
    ['emSize', 0.1, 2.5, 0.01, 'em box (m)'],
    ['charPitch', 0.6, 3, 0.01, 'slot pitch (em)'],
    ['baseHeight', 0, 6, 0.02, 'lowest character (m)'],
    ['columnDrift', 0, 0.6, 0.005, 'lateral wander (m)'],
    ['columnBow', -0.6, 0.6, 0.005, 'barrel toward the reader (m)'],
    ['charTwist', -0.4, 0.4, 0.005, 'twist per character (rad)'],
    ['charPause', 0, 3, 0.01, 'pause between characters'],
    ['strokeOverlap', 0, 2, 0.01, 'stroke overlap']
  ],
  'The brush': [
    ['strokeWidth', 0.002, 0.2, 0.001, 'ferrule half-width (m)'],
    ['depth', 0.001, 0.15, 0.001, 'half-depth through the paper (m)'],
    ['ferruleDepth', 0, 0.08, 0.0005, 'ferrule depth (m)'],
    ['bristleWidth', 0.2, 5, 0.01, 'bristle overlap'],
    ['splay', 0, 1.5, 0.01, 'splay at full pressure'],
    ['wobble', 0, 0.05, 0.0005, 'bristle wander (m)'],
    ['fibreScale', 0.5, 40, 0.1, 'wander frequency (1/m)'],
    ['pressEntry', 0, 2, 0.01, 'pressure: entry'],
    ['pressSwell', 0, 2.5, 0.01, 'pressure: swell'],
    ['pressHold', 0, 2.5, 0.01, 'pressure: hold'],
    ['pressExit', 0, 2, 0.01, 'pressure: exit']
  ],
  'The ink': [
    ['inkLoad', 0.05, 4, 0.01, 'ink load multiplier'],
    ['strokeInk', 0.05, 12, 0.05, 'load per stroke (metre-pigment)'],
    ['inkFalloff', 0, 1, 0.01, 'load lost down the column'],
    ['flowLength', 0.02, 3, 0.01, 'flow per metre'],
    ['flowDwell', 0, 3, 0.01, 'flow while dwelling'],
    ['speedRef', 0.05, 20, 0.05, 'reference speed'],
    ['edgeStarve', 0, 1.5, 0.01, 'edge starvation'],
    ['loadJitter', 0, 1, 0.01, 'per-bristle load jitter'],
    ['dryBand', 0.02, 6, 0.01, 'dry band (metre-pigment)'],
    ['dryThin', 0, 1.5, 0.01, 'dry thinning'],
    ['skipScale', 0.5, 40, 0.1, 'skip frequency (1/m)'],
    ['skipSoft', 0.005, 0.6, 0.005, 'skip softness'],
    ['skipContrast', 0.2, 5, 0.01, 'skip contrast'],
    ['poolSwell', 0, 2, 0.01, 'pool swell'],
    ['poolCurve', 0, 1, 0.005, 'pool on curvature'],
    ['pigment', 0.05, 4, 0.01, 'pigment density']
  ],
  'The mark': [
    ['headTaper', 0.002, 0.6, 0.002, 'head taper'],
    ['wetLength', 0, 2, 0.005, 'wet band (m)'],
    ['bleed', 0.01, 1, 0.005, 'capillary bleed'],
    ['fibreEdge', 0, 1, 0.005, 'edge roughness'],
    ['dryPigment', 0, 1.5, 0.01, 'density when dry'],
    ['wetGain', 0, 1.5, 0.01, 'density when wet'],
    ['opacity', 0, 1, 0.005, 'opacity'],
    ['lit', 0, 1, 0.01, 'wrapped diffuse'],
    ['backLit', 0, 1, 0.01, 'wrap floor'],
    ['ceiling', 0.05, 0.88, 0.005, 'luminance ceiling'],
    ['softFade', 0.002, 0.6, 0.002, 'depth feather (m)'],
    ['tint', 0, 1, 0.005, 'gradient at zero density'],
    ['tintDensity', 0, 2, 0.01, 'gradient walk'],
    ['tintJitter', 0, 0.5, 0.005, 'per-bristle tint jitter'],
    ['colorWash', 'wicked edge'],
    ['colorBody', 'body'],
    ['colorInk', 'full ink'],
    ['colorPool', 'pooled']
  ],
  'The ground wash': [
    ['washHeight', 0, 0.3, 0.002, 'height (m)'],
    ['washSpread', 0.1, 10, 0.05, 'spread at 1 s (m)'],
    ['washPower', 0.1, 1.5, 0.01, 'spread exponent'],
    ['washEdge', 0.01, 1, 0.005, 'interface width (m)'],
    ['washClip', 0.05, 4, 0.05, 'clip softness (m)'],
    ['washSources', 1, 4, 1, 'nuclei'],
    ['washScatter', 0, 1, 0.01, 'nucleus scatter'],
    ['washDelay', 0, 2, 0.01, 'nucleus delay (s)'],
    ['washCore', 0, 1, 0.01, 'core density'],
    ['washFalloff', 0.2, 20, 0.05, 'falloff (m)'],
    ['washFilm', 0, 1, 0.01, 'film floor'],
    ['washGranulation', 0, 1, 0.005, 'granulation'],
    ['washGranScale', 0.1, 8, 0.05, 'granulation scale (1/m)'],
    ['washRing', 0, 2, 0.01, 'deposition ring'],
    ['washRingWidth', 0.01, 1, 0.005, 'ring width (m)'],
    ['washDryTime', 0.1, 12, 0.05, 'dry time (s)'],
    ['washWetDarken', 0, 1, 0.01, 'wet darkening'],
    ['washGloss', 0, 1, 0.005, 'wet gloss'],
    ['washGlossPower', 2, 200, 1, 'gloss tightness'],
    ['washMeniscus', 0, 2, 0.01, 'meniscus'],
    ['washOpacity', 0, 1, 0.005, 'opacity'],
    ['washCeiling', 0.05, 0.88, 0.005, 'luminance ceiling'],
    ['washSoftFade', 0.005, 1, 0.005, 'depth feather (m)'],
    ['washTint', 0, 1, 0.005, 'gradient at zero density'],
    ['washTintDensity', 0, 2, 0.01, 'gradient walk'],
    ['colorFilm*', 'Film colour'],
    ['colorFilmRing', 'deposition line'],
    ['colorFilmWet', 'wet film'],
    ['colorFilmGloss', 'specular on the wet film']
  ],
  'Ink motes': [
    ['moteRate', 0, 400, 1, 'rate'],
    ['moteSize', 0.005, 0.4, 0.002, 'size'],
    ['moteSpeed', 0, 6, 0.05, 'speed'],
    ['moteLifetime', 0.1, 6, 0.05, 'lifetime (s)'],
    ['moteRise', -3, 3, 0.01, 'rise (m/s²)'],
    ['moteTurbulence', 0, 3, 0.01, 'turbulence'],
    ['moteOpacity', 0, 1, 0.005, 'opacity'],
    ['moteGlow', 0, 1, 0.005, 'glow — keep it low'],
    ['colorMote*', 'Mote colour']
  ],
  Drips: [
    ['dripRate', 0, 80, 0.5, 'rate'],
    ['dripBurst', 0, 120, 1, 'droplets on the last stroke'],
    ['dripSize', 0.005, 0.3, 0.002, 'size'],
    ['dripSpeed', 0, 6, 0.05, 'speed'],
    ['dripLifetime', 0.1, 5, 0.05, 'lifetime (s)'],
    ['dripGravity', -30, 0, 0.1, 'gravity (m/s²)'],
    ['dripOpacity', 0, 1, 0.005, 'opacity'],
    ['colorDrip*', 'Droplet colour']
  ],
  Feel: [
    ['rumble', 0, 0.2, 0.001, 'writing rumble'],
    ['finishShake', 0, 1, 0.005, 'shake on the last stroke'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration (s)']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 40, 0.1, 'light intensity'],
    ['lightRadius', 0.5, 30, 0.1, 'light radius (m)'],
    ['lightColor', 'light colour']
  ]
};
