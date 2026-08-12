/* ================================================================== */
/* SUMISTROKE — Sumi Stroke                                            */
/* ================================================================== */
/**
 * One enormous brushstroke laid down the aimed line, on the floor, which runs
 * out of ink before it gets to the end.
 *
 * The trick is **dry brush**, and dry brush is a *supply* problem rather than a
 * texture problem. `vfx/BrushStroke.js` models the ferrule as a rank of
 * individual bristles, each carrying its own load of pigment in
 * *metre-pigment* — the length of nominal full-pressure stroke it can lay
 * before it is empty. Every bristle spends its own load against the pressure
 * curve and the brush's own speed, and past the point where a bristle's load
 * runs low it starts making intermittent contact with the paper. So the tail
 * comes apart into separated fibre streaks that each stop somewhere different,
 * with clean floor between them, because they genuinely ran out at different
 * places. Nothing here is a mask over an even stroke, and the difference is
 * visible from across the room: a mask makes holes in a mark, and dry brush is
 * several marks that used to be one.
 *
 * ### Why the numbers below are shaped the way they are
 *
 * The rule this block is tuned under is `BrushStroke`'s own: **let the pressure
 * curve spend the ink**. Three keys do almost all the work, and none of them is
 * called `dryness`:
 *
 *  - `inkLoad` × `mainLoad` — metre-pigment in the ferrule. At 1.0 × 11 the
 *    brush carries eleven metres of full-pressure stroke, and a `range` of 22 m
 *    therefore *cannot* be reached wet. That is the whole design: the runout
 *    point is `load / spend-rate`, and it moves when you drag either.
 *  - `entryDwell` — where the spine's second control point sits, as a fraction
 *    of the span. Small means the brush *dwells* at the entry, `|B'(t)|`
 *    collapses there, `BrushStroke`'s dwell term blows up, the ink pools into a
 *    heavy head — and that pool is paid for out of the same ferrule, so the
 *    tail frays sooner. Cause and effect, one slider.
 *  - `mainSwell` / `mainHold` — how hard the body of the stroke presses. Press
 *    harder and it dries earlier. That is the correct direction, and it is why
 *    `dryBand` is a shape control here rather than a placement control.
 *
 * ### Metres, not fractions
 *
 * `width`, `depth`, `bow`, `pressLength`, `shoulderOffset` and `wetLength` are
 * all **metres**, so a stroke cast at four metres and a stroke cast at twenty
 * are drawn with the *same brush* — the short one is a fat comma and the long
 * one is a hairline that dies half way. Scaling the brush with the cast length
 * was the first thing tried and it looks like a zoom, not like calligraphy.
 *
 * ### No bloom
 *
 * Ink is the anti-glow school. `ceiling` is a hard clamp on the material's
 * output *linear luminance* against `post.bloomThreshold` (0.88 as shipped), so
 * 0.62 makes it arithmetically impossible for this mark to feed the bloom pass
 * whatever the four pickers are set to. The particle systems are all
 * non-additive with their glow held down for the same reason. If anything in
 * this slot ever haloes, the value that is wrong is one of these.
 */

export const sumistroke = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres — deliberately longer than the ferrule holds
  minRange: 4.0, // closer than this and the cast is refused
  speed: 17.0, // metres/second the brush is dragged; the mark is drawn at this rate
  cooldown: 1.1, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats, in seconds --- */
  liftTime: 0.26, // seconds the brush is dragged past the target before it comes off
  holdTime: 2.6, // seconds the finished mark stands while the ink soaks in
  soakTime: 1.8, // seconds the capillary bleed takes to reach `bleedSoak`
  fadeTime: 1.9, // seconds it takes to go

  /* ================================================================ */
  /* Where the stroke is drawn                                         */
  /* ================================================================ */
  paperLift: 0.03, // metres the mark floats above the floor — see `softFade`
  startInset: 0.9, // metres in front of the caster the brush is set down
  endOvershoot: 1.4, // metres past the aim point the brush is dragged before lifting
  bow: 1.1, // metres of lateral arc; a calligraphic stroke is never straight
  bowSkew: 0.42, // 0..1 — where the belly of that arc sits along the span
  entryDwell: 0.11, // fraction of the span p1 sits from p0. SMALL = the brush dwells
  exitRush: 0.46, // fraction of the span p2 sits back from p3. LARGE = it accelerates away

  /* ================================================================ */
  /* The brush — BrushStroke, FLAT tip                                 */
  /* ================================================================ */
  width: 0.42, // metres, ferrule half-width at pressure 1
  depth: 0.028, // metres, half-thickness through the paper normal
  ferruleDepth: 0.0, // metres the bristles spread through it — 0 for a flat hake
  bristleWidth: 1.55, // >1 overlaps into a solid stroke, <1 separates it from the start
  splay: 0.22, // fraction the bristles fan out at full pressure
  wobble: 0.016, // metres of per-bristle lateral wander
  fibreScale: 2.1, // features per metre of that wander

  /* ================================================================ */
  /* The ink — the whole trick                                         */
  /* ================================================================ */
  inkLoad: 1.0, // multiplier on every stroke's own metre-pigment load
  mainLoad: 11.0, // metre-pigment in the ferrule for the main stroke
  pressLoad: 4.5, // and for the entry press — a short mark, so it never runs out
  shoulderLoad: 4.0, // and for the shoulder streak, which is meant to die early
  flowLength: 0.62, // pigment laid per metre of travel, at pressure 1
  flowDwell: 0.44, // extra pigment laid per metre when the brush dwells
  speedRef: 16.0, // metres per unit t at which the brush counts as "at speed"
  edgeStarve: 0.48, // load multiplier at the edge of the ferrule — dries outside-in
  loadJitter: 0.42, // +/- fraction of load, per bristle: no two let go together
  dryBand: 2.9, // metre-pigment over which a bristle goes wet -> dry
  dryThin: 0.5, // width multiplier when a bristle is fully dry
  skipScale: 3.1, // features per metre of the contact noise
  skipSoft: 0.11, // softness of the contact threshold
  skipContrast: 1.9, // pushes the value noise off its central pile (README trap 4)

  /* --- pooling --- */
  poolSwell: 0.52, // fraction the stroke widens per unit of extra pigment
  poolCurve: 0.4, // extra pigment per 1/metre of spine curvature
  pigment: 1.0, // overall density multiplier

  /* ================================================================ */
  /* The three marks the brush makes                                   */
  /* ================================================================ */
  /* Windows are unitless fractions of `progress`, which runs 0..1 as the front
   * travels. They overlap on purpose: a brush that finishes one mark before it
   * starts the next has been lifted, and lifting is a thing you can see. */

  /* --- the entry press (起筆): the brush is set down and tucked back --- */
  pressLength: 0.75, // metres — how far back the tuck travels before reversing
  pressAngle: 2.15, // radians off the cast heading the tuck runs at
  pressStart: 0.0, // where in `progress` it is written
  pressSpan: 0.13,
  pressEntry: 0.55, // pressure control points: entry, swell, hold, exit
  pressSwell: 1.25,
  pressHold: 1.15,
  pressExit: 0.35,

  /* --- the stroke itself --- */
  mainStart: 0.05,
  mainSpan: 0.95,
  mainEntry: 0.34, // set down light...
  mainSwell: 1.15, // ...press through the body...
  mainHold: 0.78, // ...ease off...
  mainExit: 0.05, // ...and lift to nothing

  /* --- the shoulder streak: what the top edge of the ferrule left behind --- */
  shoulderOffset: 0.34, // metres to the side of the main spine
  shoulderScale: 0.72, // fraction of the main span it covers
  shoulderStart: 0.11,
  shoulderSpan: 0.7,
  shoulderEntry: 0.22,
  shoulderSwell: 0.52,
  shoulderHold: 0.36,
  shoulderExit: 0.03,

  /* ================================================================ */
  /* The mark on the paper                                             */
  /* ================================================================ */
  headTaper: 0.07, // fraction of the drawn length the moving head tapers over
  wetLength: 1.3, // metres behind the head that still read wet
  bleed: 0.2, // fraction of the bristle half-width the edge wicks over
  bleedSoak: 0.16, // extra bleed once the mark has soaked for `soakTime`
  fibreEdge: 0.2, // capillary roughness of that edge
  dryPigment: 0.66, // density multiplier where a bristle is dry
  wetGain: 0.34, // extra density in the wet band behind the head
  opacity: 1.0,
  lit: 0.3, // 0 flat pigment, 1 wrapped diffuse
  backLit: 0.75, // the floor of that wrap — high, because ink is matte
  ceiling: 0.62, // max linear luminance. post.bloomThreshold is 0.88. DO NOT RAISE
  softFade: 0.035, // metres of depth feather. See the note in the class doc
  tint: 0.05, // where in the gradient a zero-density mark sits
  tintDensity: 0.86, // how far density walks it
  tintJitter: 0.09, // +/- per bristle

  /* --- four pickers, none derived from another --- */
  colorWash: '#b9ac96', // the palest wicked edge, where the vehicle outran the pigment
  colorBody: '#574c42',
  colorInk: '#1a1714',
  colorPool: '#060505', // where it pooled at the tuck

  /* ================================================================ */
  /* Pigment mist — thrown off the wet part of the stroke              */
  /* ================================================================ */
  mistRate: 46.0, // particles/second while the brush is down
  mistSize: 0.1,
  mistSpeed: 0.9, // metres/second
  mistLifetime: 1.5, // seconds
  mistRise: 0.35, // metres/second² — barely; this is heavy pigment, not smoke
  mistTurbulence: 0.5,
  mistOpacity: 0.5,
  mistGlow: 0.32, // held low: a matte school does not get bright particles
  colorMistA: '#8d8375',
  colorMistB: '#4a4139',
  colorMistC: '#221d1a',
  colorMistD: '#0d0b0a',

  /* ================================================================ */
  /* Flying white — paper fibre torn up where the brush has gone dry   */
  /* ================================================================ */
  /* Emitted only downstream of the runout point, which the ability computes on
   * the CPU with the same integral the vertex shader uses. That is what makes
   * this system read as a *consequence* of the dry brush rather than as an
   * effect that happens to be near the end. */
  flakeRate: 34.0, // particles/second, over the dry length only
  flakeSize: 0.055,
  flakeSpeed: 1.5,
  flakeLifetime: 1.15,
  flakeGravity: -3.4, // metres/second²
  flakeSpin: 7.0, // radians/second
  flakeOpacity: 0.85,
  colorFlakeA: '#d3c8b1', // bare paper, which is the point of flying white
  colorFlakeB: '#a2937c',
  colorFlakeC: '#5d5348',
  colorFlakeD: '#241f1b',

  /* ================================================================ */
  /* Spatter — droplets flung at the tuck and at the lift              */
  /* ================================================================ */
  spatterTuck: 26, // droplets thrown when the brush is set down
  spatterLift: 18, // and when it is picked up
  spatterSize: 0.075,
  spatterSpeed: 3.6,
  spatterLifetime: 0.95,
  spatterGravity: -9.5,
  spatterOpacity: 0.9,
  colorSpatterA: '#6b5f52',
  colorSpatterB: '#312a25',
  colorSpatterC: '#171412',
  colorSpatterD: '#070606',

  /* ================================================================ */
  /* Feel                                                              */
  /* ================================================================ */
  rumble: 0.012, // camera rumble while the brush is dragging. Tiny — this is paper
  liftShake: 0.06, // one-shot nudge as the brush is lifted
  shakeDuration: 0.4, // seconds

  /* ================================================================ */
  /* Dynamic light                                                     */
  /* ================================================================ */
  /* Ink emits nothing. This is a small warm lamp riding the wet head so the
   * floor around the brush reads slightly damp — it lights the paper, it does
   * not light the ink. Turn it to 0 and the slot still works. */
  lightIntensity: 3.2,
  lightRadius: 4.5, // metres
  lightHeight: 0.55, // metres above the floor the lamp sits
  lightColor: '#c9b79a'
};

/** Editor layout: which folders exist and what goes in them. */
export const sumistrokeSchema = {
  'The cast': [
    ['range', 4, 40, 0.5, 'range (m)'],
    ['minRange', 0.5, 12, 0.1, 'minimum range (m)'],
    ['speed', 3, 60, 0.5, 'brush speed (m/s)'],
    ['cooldown', 0.1, 6, 0.05, 'cooldown (s)'],
    'castAnim',
    ['liftTime', 0.02, 3, 0.01, 'lift (s)'],
    ['holdTime', 0.2, 10, 0.05, 'hold (s)'],
    ['soakTime', 0.1, 8, 0.05, 'soak time (s)'],
    ['fadeTime', 0.2, 8, 0.05, 'fade (s)']
  ],
  'The gesture': [
    ['paperLift', 0, 0.4, 0.002, 'paper lift (m)'],
    ['startInset', 0, 6, 0.05, 'set-down inset (m)'],
    ['endOvershoot', 0, 8, 0.05, 'lift overshoot (m)'],
    ['bow', -6, 6, 0.02, 'lateral bow (m)'],
    ['bowSkew', 0, 1, 0.01, 'bow skew'],
    ['entryDwell', 0.01, 0.6, 0.005, 'entry dwell'],
    ['exitRush', 0.01, 0.9, 0.005, 'exit rush']
  ],
  'The brush': [
    ['width', 0.02, 1.6, 0.005, 'ferrule half-width (m)'],
    ['depth', 0.001, 0.3, 0.001, 'mark half-depth (m)'],
    ['ferruleDepth', 0, 0.2, 0.001, 'ferrule depth (m)'],
    ['bristleWidth', 0.2, 4, 0.01, 'bristle overlap'],
    ['splay', 0, 1.5, 0.01, 'splay at full pressure'],
    ['wobble', 0, 0.12, 0.001, 'bristle wander (m)'],
    ['fibreScale', 0.2, 12, 0.05, 'wander frequency (1/m)']
  ],
  'The ink': [
    ['inkLoad', 0.05, 4, 0.01, 'ink load multiplier'],
    ['mainLoad', 0.5, 40, 0.1, 'main load (metre-pigment)'],
    ['pressLoad', 0.2, 20, 0.1, 'tuck load (metre-pigment)'],
    ['shoulderLoad', 0.1, 20, 0.1, 'shoulder load (metre-pigment)'],
    ['flowLength', 0.02, 3, 0.01, 'flow per metre'],
    ['flowDwell', 0, 3, 0.01, 'flow while dwelling'],
    ['speedRef', 1, 60, 0.5, 'reference speed'],
    ['edgeStarve', 0, 1.5, 0.01, 'edge starvation'],
    ['loadJitter', 0, 1, 0.01, 'per-bristle load jitter'],
    ['dryBand', 0.05, 12, 0.05, 'dry band (metre-pigment)'],
    ['dryThin', 0, 1.5, 0.01, 'dry thinning'],
    ['skipScale', 0.2, 16, 0.05, 'skip frequency (1/m)'],
    ['skipSoft', 0.005, 0.6, 0.005, 'skip softness'],
    ['skipContrast', 0.2, 5, 0.01, 'skip contrast'],
    ['poolSwell', 0, 2, 0.01, 'pool swell'],
    ['poolCurve', 0, 3, 0.01, 'pool on curvature'],
    ['pigment', 0.05, 4, 0.01, 'pigment density']
  ],
  'The tuck (起筆)': [
    ['pressLength', 0, 4, 0.02, 'tuck length (m)'],
    ['pressAngle', -3.2, 3.2, 0.01, 'tuck angle (rad)'],
    ['pressStart', 0, 1, 0.005, 'window start'],
    ['pressSpan', 0.01, 1, 0.005, 'window span'],
    ['pressEntry', 0, 2, 0.01, 'pressure: entry'],
    ['pressSwell', 0, 2.5, 0.01, 'pressure: swell'],
    ['pressHold', 0, 2.5, 0.01, 'pressure: hold'],
    ['pressExit', 0, 2, 0.01, 'pressure: exit']
  ],
  'The stroke': [
    ['mainStart', 0, 1, 0.005, 'window start'],
    ['mainSpan', 0.01, 1, 0.005, 'window span'],
    ['mainEntry', 0, 2, 0.01, 'pressure: entry'],
    ['mainSwell', 0, 2.5, 0.01, 'pressure: swell'],
    ['mainHold', 0, 2.5, 0.01, 'pressure: hold'],
    ['mainExit', 0, 2, 0.01, 'pressure: exit']
  ],
  'The shoulder streak': [
    ['shoulderOffset', -2, 2, 0.01, 'lateral offset (m)'],
    ['shoulderScale', 0.05, 1.4, 0.01, 'span fraction'],
    ['shoulderStart', 0, 1, 0.005, 'window start'],
    ['shoulderSpan', 0.01, 1, 0.005, 'window span'],
    ['shoulderEntry', 0, 2, 0.01, 'pressure: entry'],
    ['shoulderSwell', 0, 2.5, 0.01, 'pressure: swell'],
    ['shoulderHold', 0, 2.5, 0.01, 'pressure: hold'],
    ['shoulderExit', 0, 2, 0.01, 'pressure: exit']
  ],
  'The mark': [
    ['headTaper', 0.002, 0.5, 0.002, 'head taper'],
    ['wetLength', 0, 8, 0.02, 'wet band (m)'],
    ['bleed', 0.01, 1, 0.005, 'capillary bleed'],
    ['bleedSoak', 0, 1, 0.005, 'extra bleed when soaked'],
    ['fibreEdge', 0, 1, 0.005, 'edge roughness'],
    ['dryPigment', 0, 1.5, 0.01, 'density when dry'],
    ['wetGain', 0, 1.5, 0.01, 'density when wet'],
    ['opacity', 0, 1, 0.005, 'opacity'],
    ['lit', 0, 1, 0.01, 'wrapped diffuse'],
    ['backLit', 0, 1, 0.01, 'wrap floor'],
    ['ceiling', 0.05, 0.88, 0.005, 'luminance ceiling'],
    ['softFade', 0.002, 0.5, 0.002, 'depth feather (m)'],
    ['tint', 0, 1, 0.005, 'gradient at zero density'],
    ['tintDensity', 0, 2, 0.01, 'gradient walk'],
    ['tintJitter', 0, 0.5, 0.005, 'per-bristle tint jitter'],
    ['colorWash', 'wicked edge'],
    ['colorBody', 'body'],
    ['colorInk', 'full ink'],
    ['colorPool', 'pooled']
  ],
  'Pigment mist': [
    ['mistRate', 0, 400, 1, 'rate'],
    ['mistSize', 0.005, 0.6, 0.005, 'size'],
    ['mistSpeed', 0, 8, 0.05, 'speed'],
    ['mistLifetime', 0.1, 6, 0.05, 'lifetime (s)'],
    ['mistRise', -4, 4, 0.02, 'rise (m/s²)'],
    ['mistTurbulence', 0, 3, 0.01, 'turbulence'],
    ['mistOpacity', 0, 1, 0.005, 'opacity'],
    ['mistGlow', 0, 1, 0.005, 'glow — keep it low'],
    ['colorMist*', 'Mist colour']
  ],
  'Flying white (飛白)': [
    ['flakeRate', 0, 400, 1, 'rate'],
    ['flakeSize', 0.005, 0.4, 0.002, 'size'],
    ['flakeSpeed', 0, 10, 0.05, 'speed'],
    ['flakeLifetime', 0.1, 6, 0.05, 'lifetime (s)'],
    ['flakeGravity', -20, 4, 0.05, 'gravity (m/s²)'],
    ['flakeSpin', 0, 24, 0.1, 'spin (rad/s)'],
    ['flakeOpacity', 0, 1, 0.005, 'opacity'],
    ['colorFlake*', 'Fibre colour']
  ],
  Spatter: [
    ['spatterTuck', 0, 200, 1, 'droplets at the tuck'],
    ['spatterLift', 0, 200, 1, 'droplets at the lift'],
    ['spatterSize', 0.005, 0.4, 0.002, 'size'],
    ['spatterSpeed', 0, 16, 0.05, 'speed'],
    ['spatterLifetime', 0.1, 4, 0.05, 'lifetime (s)'],
    ['spatterGravity', -30, 0, 0.1, 'gravity (m/s²)'],
    ['spatterOpacity', 0, 1, 0.005, 'opacity'],
    ['colorSpatter*', 'Droplet colour']
  ],
  Feel: [
    ['rumble', 0, 0.2, 0.001, 'drag rumble'],
    ['liftShake', 0, 1, 0.005, 'shake on lift'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration (s)']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 40, 0.1, 'light intensity'],
    ['lightRadius', 0.5, 30, 0.1, 'light radius (m)'],
    ['lightHeight', 0, 4, 0.02, 'light height (m)'],
    ['lightColor', 'light colour']
  ]
};
