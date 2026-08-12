/* ================================================================== */
/* THUNDERCLAP — the ability that is mostly silence                    */
/* ================================================================== */
/**
 * A far cast whose entire read is a **gap**.
 *
 * Three beats, and the middle one is empty on purpose:
 *
 *  1. `clapTime` — a hard white flash and a dome that is fully out before you
 *     have finished blinking. No particles, no debris, no shake.
 *  2. `gapTime` — **nothing**. The dome is gone, the light is off, no emitter
 *     is running. This is the most interesting number in the block and the one
 *     the whole slot is built to show off.
 *  3. `frontTime` — the pressure front arrives: `frontRings` concentric
 *     refraction rings crossing to `zoneRadius`, and *this* is where the camera
 *     shake, the dust and the grit live.
 *
 * The physics is the joke and the joke is the design: light is fast and sound
 * is not, so what you saw and what hit you are separated by a quarter of a
 * second. Put the shake on beat 1 and this becomes another shockwave slot.
 *
 * **Where the metres come from.** `zoneRadius` is the circle the aim indicator
 * draws before the click, and it is exactly where the pressure front stops —
 * one number driving the promise and the payoff, the way `snare.zoneRadius`
 * does. The dome does *not* read it: a clap's dome is a metre and a half and
 * its front is six, and deriving one from the other would make the indicator
 * lie about the first beat. So the dome carries its own `domeRadius` /
 * `domeRadiusEnd` sliders, which is `Shell`'s own contract.
 *
 * The rings themselves are `vfx/Distortion.js` in `SHOCK` mode, twice: one
 * emitter billboarded at the camera for the air, one lying flat on the floor
 * for the stone. Their magnitudes are **screen fractions**, never metres, and
 * neither of them multiplies `global.distortion` into itself — the post pass
 * applies that once, for everybody.
 *
 * A cast captures one seed and a handful of timestamps. Every metre, radian
 * and second below is resolved inside the update loop, including on a
 * zero-length frame: pause mid-gap, drag `gapTime` down, and the front you
 * were waiting for arrives with the clock stopped.
 */

import { ShellMode, shellDefaults, shellSchema } from '../../vfx/Shell.js';

export const thunderclap = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 2.0, // closer than this and the cast is refused
  zoneRadius: 6.0, // the circle — and exactly where the pressure front stops, metres
  speed: 150.0, // how fast the knot of compressed air reaches the point, metres/second
  cooldown: 1.2, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the three beats (seconds; all scaled by global.lifetime) --- */
  clapTime: 0.15, // BEAT 1 — the flash and the dome, start to finish
  gapTime: 0.26, // BEAT 2 — THE GAP. Nothing is drawn, nothing is emitted, the
  //                 light is off. This is the ability. 0 collapses it into an
  //                 ordinary shockwave; 0.5 is a clap a long way off.
  frontTime: 0.62, // BEAT 3 — seconds the front takes to cross `zoneRadius`
  fadeTime: 1.1, // seconds of settling dust after the front has passed

  /* --- beat 1: the knot and the dome ------------------------------- */
  // The clap travels to the point as a small knot of compressed air — the same
  // Shell held at its start radius. It is on screen for about a tenth of a
  // second and mostly reads as a smear, which is the intent: the clap arrives
  // from somewhere rather than being switched on.
  knotFade: 0.32, // 0..1 how visible the travelling knot is
  clapFlash: 0.8, // full-screen flash on beat 1, 0..2
  colorClapFlash: '#ffffff', // ... and its colour
  clapLight: 44, // additive punch on the dynamic light at beat 1
  clapShake: 0.06, // camera shake on beat 1. Deliberately almost nothing —
  //                   the punch belongs to beat 3 and putting it here undoes
  //                   the whole effect.

  /* --- beat 2: the gap --------------------------------------------- */
  gapGlow: 0.03, // 0..1 of the light that survives the gap. Authored at
  //                 nearly zero on purpose. Push it to 0.4 and you get a
  //                 rumble of heat lightning through the pause, which is a
  //                 different effect and a worse one.

  /* --- beat 3: the pressure front ---------------------------------- */
  frontExpand: 2.4, // easing exponent on the wavefront: 1 − (1−t)^n. >1 = it
  //                    arrives fast and then eases out to `zoneRadius`
  frontDecay: 1.5, // how fast the front loses amplitude as it spreads
  frontRings: 3, // concentric fronts, 1..4 (the shader's hard ceiling)
  frontRingGap: 1.15, // metres between one front and the next
  frontRingDecay: 0.7, // how much weaker each trailing front is
  frontRumble: 0.09, // sustained camera shake while the front is crossing
  frontDepthReject: 1.0, // 0..1 how hard the emitters refuse fragments behind geometry
  frontDepthFade: 0.5, // metres of feather on that rejection

  /* --- the front in the air (billboard emitter) --- */
  // Screen fractions, not metres. Never multiply global.distortion in here.
  airStrength: 0.55, // peak offset, in screen widths at post.distortion = 1
  airThickness: 0.6, // metres — how thick one wavefront is
  airWindow: 0.72, // 0..1 of the falloff radius where the mask starts dying
  airCompression: 1.2, // gain on the inside of the front
  airRarefaction: 0.85, // ... and on the outside
  airSpan: 2.3, // the quad's width, × zoneRadius (it must cover the ring)
  airHeight: 1.5, // the quad's height, × zoneRadius
  airMaxOffset: 1.25, // hard ceiling on the offset
  airPerspective: 0.4, // 0..1 how much the warp shrinks with distance
  airPerspectiveRef: 15.0, // metres at which `airPerspective` is 1:1

  /* --- the same front in the floor (ground emitter) --- */
  floorStrength: 0.4,
  floorThickness: 0.8, // metres
  floorWindow: 0.8, // 0..1 of the falloff radius
  floorCompression: 1.0,
  floorRarefaction: 0.7,
  floorSpan: 2.2, // the quad's extent, × zoneRadius
  floorHeight: 0.05, // metres above the floor the emitter lies at
  floorMaxOffset: 1.0,

  /* --- what beat 3 does to the world --- */
  boomShake: 1.35, // the punch, on THIS beat and not the first one
  boomShakeTime: 0.75, // seconds it decays over
  boomFlash: 0.1, // a small secondary flash. Keep it well under `clapFlash`
  colorBoomFlash: '#cfe4ff',
  boomLight: 12, // additive punch on the dynamic light at beat 3

  /* --- the ring the front leaves on the floor --- */
  shockLife: 0.7, // seconds
  shockWidth: 0.06, // thickness of the ring, fraction of its radius
  shockIntensity: 1.2,
  colorShockA: '#3f6fd0', // body of the ring
  colorShockB: '#ffffff', // its crest

  /* --- dust rings laid along the front's own travel --- */
  ringRate: 0.7, // puffs per metre of wavefront travel
  ringRadius: 1.4, // radius of one puff, metres
  ringLife: 1.4, // seconds it lingers
  ringIntensity: 0.5,
  colorRingA: '#5b6b7e', // the puff
  colorRingB: '#cfe4ff', // its lit edge

  /* --- the dust the front shoves ----------------------------------- */
  /**
   * As everywhere else, each system is coloured by a four-stop gradient sampled
   * over the particle's own lifetime, `A` at birth through `D` as it dies.
   * Spelled out rather than derived from the ring palette, so the dust can be
   * made to go warm while the refraction stays cold.
   */
  dustRate: 300, // particles/second while the front is crossing
  dustSize: 1.1,
  dustSpeed: 5.5, // metres/second, thrown outward on the wavefront
  dustLifetime: 2.1,
  dustRise: 0.5, // upward drift, metres/second
  dustSpread: 0.55, // 0..1 cone width off the outward normal
  dustOpacity: 0.09,
  boomDust: 70, // one-shot puff on the frame the front launches
  colorDustA: '#7e8896',
  colorDustB: '#5b6470',
  colorDustC: '#3d4652',
  colorDustD: '#232a33',

  /* --- and the grit it kicks up --- */
  gritRate: 110, // chips/second while the front is crossing
  gritSize: 0.06,
  gritSpeed: 7.5,
  gritLifetime: 1.2,
  gritGravity: -19.0, // metres/second²
  boomGrit: 80, // one-shot on the frame the front launches
  colorGritA: '#2b323c',
  colorGritB: '#232932',
  colorGritC: '#1b2028',
  colorGritD: '#151a21',

  /* --- dynamic light --- */
  lightIntensity: 5, // the standing level; the beats punch it with `lightBoost`
  lightRadius: 20,
  lightColor: '#cfe4ff',

  /* --- the dome (vfx/Shell.js, DOME mode, prefix `dome`) ------------ */
  // 44 keys. The RING_TRAIN and SUNDISC members of the block are inert in DOME
  // mode and are left out of the schema below on purpose — they land in the
  // editor's trailing "More" folder, which is exactly what it is for.
  ...shellDefaults('dome', ShellMode.DOME, {
    domeRadius: 0.38, // the travelling knot, metres
    domeRadiusEnd: 4.4, // the dome at the end of beat 1, metres
    domeExpand: 7.0, // very fast, then easing — "already out" by frame three
    domeHeight: 0.82, // squashed a little; a clap is wider than it is tall
    domeLift: 0.02,
    domeDisplace: 0.13,
    domeNoiseScale: 2.6,
    domeNoiseSpeed: 1.6,
    domeFill: 0.05, // nearly empty: this is a pressure shell, not a fireball
    domeRim: 1.9,
    domeRimPower: 2.6,
    domeSeal: 2.3, // bright where it meets the floor
    domeSealWidth: 0.1,
    domeDissolve: 1.15,
    domeOpacity: 0.85,
    domeGlow: 2.4,
    domeSoftFade: 0.45,
    domeColorBody: '#3f6fd0',
    domeColorRim: '#cfe4ff',
    domeColorEdge: '#ffffff',
    domeColorCorona: '#9fc4ff'
  })
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Thunderclap.
 *
 * Reach for **The three beats** first and nothing else. `gapTime` is the
 * ability: drag it from 0 to 0.6 with a clap standing and you can watch the
 * slot turn from "a shockwave" into "a thunderclap" and back. `frontTime`
 * against `frontExpand` decides whether the front snaps out or rolls out, and
 * `airStrength` is how much of the frame it drags with it.
 *
 * The `dome*` folders come from `shellSchema('dome', ShellMode.DOME)`; the
 * ring-train and sun-disc keys `shellDefaults` also brings in do nothing to a
 * dome and are deliberately unfiled.
 */
export const thunderclapSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['zoneRadius', 1, 16, 0.05, 'front reach (m)'],
    ['speed', 20, 400, 1, 'arrival speed'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The three beats': [
    ['clapTime', 0.02, 1, 0.005, '1 · flash + dome (s)'],
    ['gapTime', 0, 1.2, 0.005, '2 · THE GAP (s)'],
    ['frontTime', 0.05, 2.5, 0.01, '3 · front crossing (s)'],
    ['fadeTime', 0.1, 4, 0.05, 'settle (s)']
  ],
  'Beat 1 · the clap': [
    ['knotFade', 0, 1, 0.01, 'travelling knot'],
    ['clapFlash', 0, 2, 0.01, 'screen flash'],
    ['clapLight', 0, 120, 0.5, 'light punch'],
    ['clapShake', 0, 1, 0.005, 'shake (keep it small)'],
    ['colorClapFlash', 'flash colour']
  ],
  'Beat 2 · the gap': [['gapGlow', 0, 1, 0.005, 'light through the gap']],
  'Beat 3 · the front': [
    ['frontExpand', 0.5, 8, 0.05, 'arrival curve'],
    ['frontDecay', 0.2, 5, 0.05, 'amplitude decay'],
    ['frontRings', 1, 4, 1, 'concentric fronts'],
    ['frontRingGap', 0.1, 5, 0.05, 'gap between fronts (m)'],
    ['frontRingDecay', 0, 2, 0.01, 'trailing front decay'],
    ['frontRumble', 0, 0.5, 0.005, 'rumble while crossing'],
    ['frontDepthReject', 0, 1, 0.01, 'occlusion'],
    ['frontDepthFade', 0.02, 3, 0.01, 'occlusion feather (m)']
  ],
  'Beat 3 · the front/In the air': [
    ['airStrength', 0, 2, 0.01, 'strength (screen widths)'],
    ['airThickness', 0.05, 3, 0.01, 'wavefront thickness (m)'],
    ['airWindow', 0.05, 1, 0.01, 'falloff window'],
    ['airCompression', 0, 3, 0.01, 'compression'],
    ['airRarefaction', 0, 3, 0.01, 'rarefaction'],
    ['airSpan', 1, 4, 0.05, 'quad width × radius'],
    ['airHeight', 0.2, 4, 0.05, 'quad height × radius'],
    ['airMaxOffset', 0.05, 4, 0.05, 'offset ceiling'],
    ['airPerspective', 0, 1, 0.01, 'distance falloff'],
    ['airPerspectiveRef', 1, 40, 0.5, 'reference distance (m)']
  ],
  'Beat 3 · the front/In the floor': [
    ['floorStrength', 0, 2, 0.01, 'strength (screen widths)'],
    ['floorThickness', 0.05, 3, 0.01, 'wavefront thickness (m)'],
    ['floorWindow', 0.05, 1, 0.01, 'falloff window'],
    ['floorCompression', 0, 3, 0.01, 'compression'],
    ['floorRarefaction', 0, 3, 0.01, 'rarefaction'],
    ['floorSpan', 1, 4, 0.05, 'quad extent × radius'],
    ['floorHeight', 0.005, 0.5, 0.005, 'height above floor (m)'],
    ['floorMaxOffset', 0.05, 4, 0.05, 'offset ceiling']
  ],
  'Beat 3 · the impact': [
    ['boomShake', 0, 3, 0.01, 'shake'],
    ['boomShakeTime', 0.05, 3, 0.01, 'shake duration (s)'],
    ['boomFlash', 0, 1, 0.005, 'screen flash'],
    ['boomLight', 0, 80, 0.5, 'light punch'],
    ['colorBoomFlash', 'flash colour']
  ],
  'Marks on the floor': [
    ['shockLife', 0.1, 4, 0.05, 'ring lifetime (s)'],
    ['shockWidth', 0.01, 0.5, 0.005, 'ring thickness'],
    ['shockIntensity', 0, 3, 0.01, 'ring intensity'],
    ['colorShockA', 'ring body'],
    ['colorShockB', 'ring crest'],
    ['ringRate', 0.05, 4, 0.05, 'dust puffs / metre'],
    ['ringRadius', 0.1, 6, 0.05, 'puff radius (m)'],
    ['ringLife', 0.1, 6, 0.05, 'puff lifetime (s)'],
    ['ringIntensity', 0, 2, 0.01, 'puff intensity'],
    ['colorRingA', 'puff'],
    ['colorRingB', 'puff edge']
  ],
  'Dust & grit': [
    ['dustRate', 0, 900, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 20, 0.1, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustSpread', 0, 1, 0.01, 'dust cone'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['boomDust', 0, 300, 1, 'dust on the boom'],
    ['gritRate', 0, 500, 1, 'grit rate'],
    ['gritSize', 0.005, 0.4, 0.005, 'grit size'],
    ['gritSpeed', 0, 25, 0.1, 'grit speed'],
    ['gritLifetime', 0.1, 5, 0.05, 'grit lifetime'],
    ['gritGravity', -50, 0, 0.1, 'grit gravity'],
    ['boomGrit', 0, 400, 1, 'grit on the boom'],
    ['colorDust*', 'Dust colour'],
    ['colorGrit*', 'Grit colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'standing intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ],
  ...shellSchema('dome', ShellMode.DOME)
};
