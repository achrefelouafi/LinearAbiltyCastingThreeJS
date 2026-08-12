/* ================================================================== */
/* FEATHERFALL — two hundred feathers, and two ways to fall            */
/* ================================================================== */
/**
 * A slow rain of feathers over the circle. It has no impact beat, no burst, no
 * shockwave and no burn: the whole cast is the descent, and the descent is the
 * ability.
 *
 * ### The block is a flight model, not a look
 *
 * Most of what follows are the coefficients of a real falling-plate model,
 * evaluated in closed form per feather in `materials/FeatherMaterial.js`. A
 * thin plate dropped through air does not sink; it goes unstable, and it goes
 * unstable in one of two ways depending on its aspect ratio. This block
 * carries both, and `tumbleShare` is the split between them:
 *
 *  - **Fluttering** (`sink`, `lift`, `swing`, `flutterRate`, `pitch`) — the
 *    leaf motion. The plate glides to one side, stalls, flips, and glides
 *    back. It falls *slowest* in the middle of each glide, because that is
 *    where it is fastest sideways and therefore making the most lift, and
 *    fastest at each stall.
 *  - **Tumbling** (`tumbleRate`, `tumbleDrift`, `tumbleSink`, `tumbleBob`) —
 *    end over end, steadily, drifting in the direction of rotation, and
 *    noticeably quicker down. Tumblers are the ones your eye follows.
 *
 * The three numbers that matter, in order: **`lift`**, which is how much of
 * the sink a glide cancels (0 is a sheet of paper in a vacuum, 0.95 is a
 * sycamore seed and takes twenty seconds to land); **`swing`**, the peak
 * sideways speed; and **`tumbleShare`**. Nothing else changes the character
 * of the fall nearly as much.
 *
 * ### Why the cast is so long
 *
 * `lifetime` has to cover the whole descent or feathers vanish in mid-air,
 * which is the one failure this slot cannot survive. The arithmetic is worth
 * writing down because the two are coupled and neither is obvious:
 *
 * ```
 *   mean sink   = sink · (1 − lift/2)   = 1.05 · 0.70 = 0.735 m/s
 *   longest fall = ceiling / mean sink  = 4.6 / 0.735 ≈ 6.3 s
 *   last release = stagger              = 1.9 s
 *   descent      ≈ 8.2 s                → lifetime 8.4 s, with a margin
 * ```
 *
 * Raise `ceiling` or `lift`, or lower `sink`, and `lifetime` has to follow.
 * The check harness stops a cast at fifteen seconds, which is the real
 * ceiling on all of this.
 *
 * ### Everything with a unit is here, including the outline
 *
 * The feather's silhouette is built in the vertex shader out of `uv` and the
 * dozen shape keys below, so `vaneWidth`, `taper`, `cup` and the rest are live
 * sliders with no geometry behind them to rebuild. Drag `cup` on a flock that
 * is already in the air and two hundred feathers re-curl on the spot.
 */
export const featherfall = {
  /* --- the cast --- */
  range: 17.0, // maximum cast distance, metres
  minRange: 2.0, // closer than this and the cast is refused
  zoneRadius: 5.2, // the circle the flock is released over, metres — HEADLINE
  speed: 26.0, // how fast the cast reaches the circle, metres/second
  lifetime: 8.4, // seconds the descent is given — see the arithmetic above
  fadeTime: 2.6, // seconds the settled feathers take to go
  cooldown: 1.6,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the flock --- */
  count: 190, // feathers in one cast; the cap in the ability is 256
  ceiling: 4.6, // metres above the floor the highest feather is released
  ceilingVary: 0.4, // 0..1 of that height the lowest one starts at instead
  stagger: 1.9, // seconds between the first release and the last
  floorHeight: 0.012, // metres above the floor a landed feather rests at
  windX: 0.16, // ambient drift, metres/second (world +X)
  windZ: -0.09, // ambient drift, metres/second (world +Z)

  /* --- the feather's outline, in units of its own length --- */
  featherSize: 0.26, // length of a feather, metres
  featherSizeVary: 0.45, // ± fraction of that, per feather
  vaneWidth: 0.19, // half-width of the vane at its widest
  widthBias: 0.85, // <1 pushes the widest point toward the tip
  taper: 0.65, // >1 sharpens the tip, <1 rounds it
  leadFrac: 0.62, // the leading vane is narrower — a feather is not symmetric
  quill: 0.16, // fraction of the length that is bare calamus
  cup: 0.55, // cross-sectional curl toward the underside — this is what catches air
  arch: 0.1, // lengthwise bow of the whole feather
  barb: 0.06, // ripple on the outline, × the half-width
  barbFreq: 22.0, // ripple waves along the length
  pivot: 0.42, // fraction along the feather the motion is anchored at

  /* --- the flutter regime --- */
  sink: 1.05, // still-air sink rate, metres/second — HEADLINE
  lift: 0.6, // 0..1 of the sink a glide cancels — HEADLINE
  swing: 0.95, // peak sideways speed of the glide, metres/second
  flutterRate: 4.2, // radians/second of the flutter oscillation
  flutterVary: 0.55, // ± fraction of that rate, per feather
  pitch: 0.95, // radians the plate tilts at the extreme of a glide
  spin: 0.35, // radians/second of slow roll about the rachis

  /* --- the tumbling regime --- */
  tumbleShare: 0.28, // 0..1 of the flock that tumbles instead of fluttering
  tumbleRate: 7.5, // radians/second, end over end
  tumbleDrift: 0.55, // metres/second it slides, in the direction of rotation
  tumbleSink: 1.15, // metres/second — a tumbler makes almost no lift
  tumbleBob: 0.06, // metres of vertical wobble per revolution

  /* --- the catch: one gust each, at its own moment --- */
  catchGain: 0.55, // metres a feather rises when it catches — HEADLINE
  catchWidth: 0.55, // seconds the gust lasts
  catchWindow: 3.2, // seconds into the fall the gust may happen within

  /* --- the ends of the descent --- */
  birthFade: 0.35, // seconds a feather takes to fade in at its release
  settleTime: 0.9, // seconds before landing over which it lies flat

  /* --- shading --- */
  rachis: 0.55, // strength of the spine down the middle
  barbLines: 0.35, // strength of the barb striations
  barbCount: 26.0, // barbs across one vane
  grain: 0.18, // world-space fibre variation between feathers
  grainScale: 6.0, // grain features per metre
  fresnel: 0.7, // rim light on the silhouette
  fresnelPower: 2.4,
  translucency: 1.6, // backlit transmission — the read of a feather in a low sun
  translucencyPower: 3.2, // how tightly that hugs the anti-sun direction
  glow: 0.8, // emissive gain into bloom
  opacity: 1.0,
  colorQuill: '#b9a88f', // the shaft and the base
  colorVane: '#f2ece2', // the body of the vane
  colorTip: '#cfe3ee', // the tip, cooled off
  colorGlow: '#ffd9a8', // what the sun looks like coming through one

  /* --- the down --- */
  /**
   * The only particle system, and it is nearly empty. Down is what comes off a
   * feather, not what a feather is: a handful of specks a second, drifting
   * with almost no speed. At the shipped rate the whole cast is under two
   * hundred live particles against the 1500 budget.
   */
  downRate: 26, // specks per second
  downSize: 0.05, // metres
  downSpeed: 0.28, // metres/second
  downLifetime: 3.2, // seconds
  downRise: -0.12, // gentle sink, metres/second
  downTurbulence: 0.7, // curl-noise strength
  colorDownA: '#fffaf0', // birth
  colorDownB: '#efe6d6',
  colorDownC: '#c8beb0',
  colorDownD: '#2b2823', // death

  /* --- dynamic light --- */
  // Warm and wide and very soft. There is nothing hot in this ability; the
  // light exists so the flock has a direction to be lit from as it comes down.
  lightIntensity: 7.0,
  lightRadius: 11.0,
  lightColor: '#ffe3bd'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Featherfall.
 *
 * Two folders do all the work and they are the two regimes. Start in **The
 * flutter** with `lift`: at 0 the feathers drop like wet paper, at 0.9 they
 * hang and glide and the cast outlasts its own `lifetime` — which is the one
 * way to break this slot, and the reason the two folders sit next to each
 * other. Then **The tumble**, and specifically `tumbleShare`: at 0 the flock
 * is beautiful and slightly monotonous, at 1 it is a shower of leaves, and
 * somewhere near a quarter it stops looking like a system at all.
 *
 * `catchGain` in **The catch** is the cheapest trick in the ability and worth
 * knowing about: each feather gets exactly one gust, at its own moment,
 * somewhere in `catchWindow`. It is what stops the descent reading as a loop.
 *
 * The shape folder is in fractions of the feather's own length, so `featherSize`
 * resizes the whole flock and nothing about the outline changes.
 */
export const featherfallSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['zoneRadius', 1, 16, 0.1, 'zone radius (m)'],
    ['speed', 5, 120, 0.5, 'cast speed'],
    ['lifetime', 1, 13, 0.1, 'descent window (s)'],
    ['fadeTime', 0.2, 6, 0.05, 'fade time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The flock': [
    ['count', 1, 256, 1, 'feathers'],
    ['ceiling', 0.5, 14, 0.1, 'release height (m)'],
    ['ceilingVary', 0, 0.95, 0.01, 'height spread'],
    ['stagger', 0, 6, 0.05, 'release spread (s)'],
    ['floorHeight', 0, 0.3, 0.001, 'resting height (m)'],
    ['windX', -3, 3, 0.01, 'wind X (m/s)'],
    ['windZ', -3, 3, 0.01, 'wind Z (m/s)']
  ],
  'The feather': [
    ['featherSize', 0.03, 1.2, 0.005, 'length (m)'],
    ['featherSizeVary', 0, 1.2, 0.01, 'length spread'],
    ['vaneWidth', 0.02, 0.6, 0.005, 'vane half-width'],
    ['widthBias', 0.2, 2.5, 0.01, 'widest point'],
    ['taper', 0.1, 3, 0.01, 'tip taper'],
    ['leadFrac', 0.1, 1.4, 0.01, 'leading vane ×'],
    ['quill', 0, 0.6, 0.005, 'bare calamus'],
    ['cup', 0, 2.5, 0.01, 'cross-section curl'],
    ['arch', -1, 1, 0.005, 'lengthwise bow'],
    ['barb', 0, 0.4, 0.005, 'outline ripple'],
    ['barbFreq', 0, 60, 0.5, 'ripple waves'],
    ['pivot', 0, 1, 0.01, 'motion anchor']
  ],
  'The flutter': [
    ['sink', 0.05, 6, 0.01, 'sink rate (m/s)'],
    ['lift', 0, 0.95, 0.01, 'lift fraction'],
    ['swing', 0, 5, 0.01, 'glide speed (m/s)'],
    ['flutterRate', 0.2, 16, 0.05, 'flutter (rad/s)'],
    ['flutterVary', 0, 1, 0.01, 'flutter spread'],
    ['pitch', 0, 1.8, 0.01, 'stall tilt (rad)'],
    ['spin', -3, 3, 0.01, 'axial roll (rad/s)']
  ],
  'The tumble': [
    ['tumbleShare', 0, 1, 0.01, 'share that tumbles'],
    ['tumbleRate', 0, 24, 0.1, 'tumble (rad/s)'],
    ['tumbleDrift', 0, 4, 0.01, 'drift (m/s)'],
    ['tumbleSink', 0.05, 6, 0.01, 'tumble sink (m/s)'],
    ['tumbleBob', 0, 0.5, 0.005, 'tumble bob (m)']
  ],
  'The catch': [
    ['catchGain', 0, 3, 0.01, 'gust rise (m)'],
    ['catchWidth', 0.05, 3, 0.01, 'gust length (s)'],
    ['catchWindow', 0.1, 10, 0.05, 'gust window (s)']
  ],
  'The landing': [
    ['birthFade', 0.02, 2, 0.01, 'fade in (s)'],
    ['settleTime', 0.05, 4, 0.01, 'lie flat over (s)']
  ],
  Shading: [
    ['rachis', 0, 2, 0.01, 'spine'],
    ['barbLines', 0, 1.5, 0.01, 'barb striations'],
    ['barbCount', 2, 80, 1, 'barbs per vane'],
    ['grain', 0, 1, 0.01, 'fibre grain'],
    ['grainScale', 0.2, 24, 0.1, 'grain per metre'],
    ['fresnel', 0, 3, 0.01, 'rim light'],
    ['fresnelPower', 0.2, 8, 0.05, 'rim tightness'],
    ['translucency', 0, 6, 0.01, 'backlight'],
    ['translucencyPower', 0.2, 12, 0.05, 'backlight tightness'],
    ['glow', 0, 4, 0.01, 'glow'],
    ['opacity', 0, 1, 0.01, 'opacity'],
    'colorQuill',
    'colorVane',
    'colorTip',
    'colorGlow'
  ],
  'The down': [
    ['downRate', 0, 300, 1, 'down rate'],
    ['downSize', 0.005, 0.3, 0.005, 'down size'],
    ['downSpeed', 0, 4, 0.01, 'down speed'],
    ['downLifetime', 0.2, 10, 0.05, 'down lifetime'],
    ['downRise', -2, 2, 0.01, 'down rise'],
    ['downTurbulence', 0, 3, 0.01, 'down turbulence'],
    ['colorDown*', 'Down colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
