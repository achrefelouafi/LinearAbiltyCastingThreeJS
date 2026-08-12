/* ================================================================== */
/* SILENCE — Silence                                                   */
/* ================================================================== */
/**
 * A sphere of the world stops being rendered.
 *
 * This is the shortest block in the project on purpose, and it is short for the
 * same reason the ability is the most aggressive thing in the sandbox: almost
 * nothing here describes something being *drawn*. There is no medium, no
 * gradient, no shell and no volume. `Hook.HOLE` from `vfx/SceneHooks.js` parks
 * an invisible depth-writing sphere at the anchor before any opaque in the
 * frame; everything further away than its front surface fails the depth test
 * and is never shaded. What survives in those pixels is the clear colour. Not
 * black in front of the world — a pixel the world never reached.
 *
 * So the numbers divide into three groups and only the first one does anything
 * an artist would call rendering:
 *
 *  - **the hole** — `zoneRadius`, `holeLift`, `holeSquash`, `holeWeight` and the
 *    four times. Four numbers and a schedule, and they are the ability.
 *  - **the rim** — one billboarded annulus, one draw call, deliberately *dark*.
 *    `colorRim` is nearly black and the only lit term is `lipGain`, rolled off
 *    at `lipCeiling`. A bright rim was the first version and it is the one thing
 *    that genuinely breaks this ability: the hole is punched in the scene pass,
 *    so `UnrealBloomPass` runs *after* it and a hot edge bleeds straight across
 *    the void it is supposed to bound. `SceneHooks` documents that caveat; this
 *    block's answer to it is to not be bright.
 *  - **the dust** — one sparse system falling inward. It exists to prove the
 *    trick rather than to decorate it: particles depth-test, the hole is in the
 *    depth prepass, and so every mote simply *stops* at the boundary with no
 *    code anywhere telling it to.
 *
 * **`holeLift` against `zoneRadius`.** The centre sits `holeLift` metres above
 * the floor and the sphere has radius `zoneRadius`, so at the shipped 3.0
 * against 4.2 the void bites 1.2 m into the ground and stands seven metres
 * high. Lift it past the radius and the hole leaves the floor alone entirely,
 * which is a very different and much quieter effect.
 *
 * **`rimWidth` and `rimWaver` are metres, not fractions.** The rim is 9 cm wide
 * whether the hole is one metre across or eight — a rim that scaled with the
 * radius read as a ring painted on a balloon.
 */
export const silence = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.5, // closer than this and the cast is refused
  speed: 44.0, // how fast the front reaches the circle, metres/second
  zoneRadius: 4.2, // metres — the footprint, and the sphere's radius
  openTime: 0.34, // seconds the hole takes to open
  holdTime: 1.5, // seconds it stands open
  closeTime: 0.55, // seconds it takes to close
  settleTime: 0.35, // seconds the rim takes to let go after that
  cooldown: 1.5, // seconds before it can be cast again
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the hole --- */
  holeLift: 3.0, // metres the sphere's centre sits above the floor
  holeSquash: 0.92, // <1 flattens the void vertically; 1 is a true sphere
  holeWeight: 1.0, // the hook's blend. 0 is transparent, not "off but held".
  openBounce: 0.07, // fraction of overshoot as the hole snaps open
  gatherRadius: 1.55, // rim radius during travel, as a multiple of zoneRadius

  /* --- the rim: one annulus, and it does not glow --- */
  rimSwell: 1.03, // ring radius as a multiple of the hole radius
  rimPad: 1.3, // billboard half-extent as a multiple of the ring radius
  rimWidth: 0.09, // metres — half-width of the band, constant at any radius
  rimWaver: 0.06, // metres the ring wanders off a perfect circle
  rimWaverSpeed: 0.5, // radians/second of that wander
  rimOpacity: 0.9,
  rimInnerBias: 0.6, // how much more opaque the inner half of the band is
  rimTravel: 0.3, // 0..1 rim opacity while the front is still travelling
  lipGain: 0.5, // the one lit term, on the outer half of the band
  lipCeiling: 0.6, // hard asymptote, linear HDR — keep well below post.bloomThreshold
  colorRim: '#0a0710', // the band. Nearly black, and that is the design.
  colorLip: '#9f86d8', // the outer lip, the only colour in the ability

  /* --- the dust drawn in, and erased --- */
  dustRate: 55, // particles/second
  dustSize: 0.055,
  dustSpeed: 2.7, // metres/second inward
  dustLifetime: 1.6,
  dustRise: -0.4, // metres/second — it sinks as it goes
  dustSpawn: 1.9, // where it starts, as a multiple of the hole radius
  dustTurbulence: 0.45,
  dustOpacity: 0.55,
  colorDustA: '#c9b8ee',
  colorDustB: '#7f6bb0',
  colorDustC: '#3a2f56',
  colorDustD: '#0c0916',

  /* --- dynamic light --- */
  // Turned almost all the way down, on purpose, and it is the only light in the
  // project that is. A hole does not emit; this exists to put the faintest cold
  // wash on the flagstones at the rim so the boundary has somewhere to sit.
  lightIntensity: 1.3,
  lightRadius: 7.0,
  lightColor: '#2c1a48',

  /* --- the beats you feel --- */
  castDim: 0.16, // the screen darkens slightly as it opens (a negative flash)
  colorDim: '#050308', // what it darkens toward
  openShake: 0.3, // knock as the hole opens
  shakeDuration: 0.45,
  rumble: 0.012 // continuous shake while the front travels
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Silence.
 *
 * **The hole** is the whole panel. Drag `zoneRadius` with the clock stopped and
 * the world comes back or goes away around a standing void; drag `holeLift` and
 * the bite it takes out of the floor opens and closes. Everything under **The
 * rim** is a boundary treatment on something that is not there, and the two
 * numbers worth leaving alone are `lipGain` and `lipCeiling` — see the block
 * header for what a bright rim does to a hole punched before the bloom pass.
 */
export const silenceSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 4, 200, 0.5, 'front speed'],
    ['zoneRadius', 0.5, 14, 0.1, 'hole radius (m)'],
    ['openTime', 0.02, 3, 0.01, 'open time'],
    ['holdTime', 0.05, 8, 0.05, 'hold time'],
    ['closeTime', 0.02, 4, 0.01, 'close time'],
    ['settleTime', 0.02, 3, 0.01, 'rim settle'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The hole': [
    ['holeLift', 0, 12, 0.05, 'centre above floor (m)'],
    ['holeSquash', 0.2, 2, 0.01, 'vertical squash'],
    ['holeWeight', 0, 1, 0.01, 'hook blend'],
    ['openBounce', 0, 0.5, 0.01, 'open overshoot'],
    ['gatherRadius', 0.5, 3, 0.01, 'gather radius (× hole)']
  ],
  'The rim': [
    ['rimSwell', 0.9, 1.3, 0.005, 'ring radius (× hole)'],
    ['rimPad', 1.05, 2.5, 0.01, 'billboard padding'],
    ['rimWidth', 0.01, 0.6, 0.005, 'band half-width (m)'],
    ['rimWaver', 0, 0.5, 0.005, 'wander (m)'],
    ['rimWaverSpeed', 0, 4, 0.01, 'wander rate'],
    ['rimOpacity', 0, 1, 0.01, 'opacity'],
    ['rimInnerBias', 0, 2, 0.01, 'inner weighting'],
    ['rimTravel', 0, 1, 0.01, 'opacity while travelling'],
    ['lipGain', 0, 3, 0.01, 'lip gain'],
    ['lipCeiling', 0.05, 1.2, 0.01, 'lip ceiling (bloom guard)'],
    ['colorRim', 'band'],
    ['colorLip', 'lip']
  ],
  'The dust': [
    ['dustRate', 0, 400, 1, 'rate'],
    ['dustSize', 0.005, 0.4, 0.005, 'size'],
    ['dustSpeed', 0, 12, 0.05, 'inward speed'],
    ['dustLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['dustRise', -4, 2, 0.01, 'rise'],
    ['dustSpawn', 1.05, 4, 0.01, 'spawn radius (× hole)'],
    ['dustTurbulence', 0, 3, 0.01, 'turbulence'],
    ['dustOpacity', 0, 1, 0.01, 'opacity'],
    ['colorDust*', 'Dust colour']
  ],
  'The beats you feel': [
    ['castDim', 0, 1, 0.01, 'screen dim'],
    ['colorDim', 'dim toward'],
    ['openShake', 0, 3, 0.01, 'opening knock'],
    ['shakeDuration', 0.1, 4, 0.01, 'knock duration'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 40, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 30, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
