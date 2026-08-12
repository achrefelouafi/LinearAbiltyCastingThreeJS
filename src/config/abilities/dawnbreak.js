/* ================================================================== */
/* DAWNBREAK — the ability that moves the sun                          */
/* ================================================================== */
/**
 * The far cast whose effect is almost entirely **the rest of the scene**.
 *
 * Dawnbreak borrows `Hook.KEY_LIGHT` from `vfx/SceneHooks.js` and swings the
 * stage's one directional light from the horizon, up over the top and back down
 * the other side. Because it is the *same* light that was already casting every
 * shadow in the world, the character's shadow, the crystals of a Frost Lance
 * still standing on the floor and the floor's own relief all sweep round with
 * it. Nothing in this block describes a shadow, because nothing has to: the
 * world was always drawing them.
 *
 * Three beats, and they map onto the phase machine like this:
 *
 * | phase | what it is | how long |
 * | --- | --- | --- |
 * | travel | the stage's light rakes down toward the horizon as the cast reaches out | `range / speed` |
 * | impact | **the sweep** — horizon, overhead, horizon | `sweepTime × global.lifetime` |
 * | fade | the sun slides back to wherever `settings.environment` says it lives | `settleTime` |
 *
 * The three controls worth reaching for first are `sunWeight` (how much of the
 * sun the ability takes — at 0 the hook is transparent and the editor's own
 * `environment.sunAzimuth` reads straight through), `sweepTime` (a slow sweep
 * is a sunrise, a fast one is a searchlight) and `elevHigh` (how close to true
 * noon the arc gets, which is the difference between long raking shadows all
 * the way through and a moment of flat overhead light in the middle).
 *
 * **On putting it back.** The restore is free and it is exact.
 * `Environment.update()` re-authors the key light from `settings.environment`
 * on every frame *before* the abilities run, and `SceneHooks.apply()` blends
 * from those settings rather than from the live light — so the frame after the
 * token is released, the sun is bit-for-bit where the sliders say, whether the
 * cast ended normally, was cleared with **C**, or was pushed off the four-cast
 * concurrency cap mid-sweep.
 *
 * **What the sweep costs: nothing.** `App.frame` already sets
 * `shadowMap.needsUpdate` unconditionally every frame, so the 4096² directional
 * map is re-rendered whether the sun moves or not — 1 draw call and 9,578
 * triangles, measured. Moving the sun changes what lands in those texels and
 * nothing else. The cost that *is* real is a look cost: the map's contents now
 * change every frame, so PCF's temporal stability goes and a shadow edge that
 * was rock-steady crawls slightly. Slow the sweep and it reads as softness.
 *
 * Nothing here is captured by a cast. A cast rolls one seed for the daystar's
 * granulation; every metre, radian and second below is re-read on every frame,
 * zero-length ones included.
 */
export const dawnbreak = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 44.0, // how fast the cast reaches the circle, metres/second
  cooldown: 9.0, // seconds — the longest in the school; this one takes the world
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 6.5, // the footprint — what the circle indicator measures out

  /* ------------------------------------------------------------------ */
  /* The beats                                                           */
  /* ------------------------------------------------------------------ */
  sweepTime: 4.2, // seconds for the whole arc: horizon → overhead → horizon
  settleTime: 1.2, // seconds the sun takes to slide back to the stage's own aim
  reachCurve: 1.4, // exponent on the travel-phase ramp — >1 holds off, then commits

  /* ------------------------------------------------------------------ */
  /* The arc — every one of these is a radian the hook re-reads each frame */
  /* ------------------------------------------------------------------ */
  /**
   * `sunWeight` is the blend against `settings.environment`, not an opacity. At
   * 0 the hook is *transparent*: the light is exactly where the environment
   * sliders put it, and the ability is still holding the hook. At 1 the arc
   * below is the whole truth.
   */
  sunWeight: 1.0, // 0..1 — how much of the sun the cast takes
  elevLow: 0.09, // radians above the horizon the arc starts and ends at
  elevHigh: 1.36, // radians at the top of the arc (π/2 would be true noon)
  elevCurve: 0.85, // exponent on sin(πd) — <1 lingers high, >1 lingers low
  azStart: 2.15, // radians — the bearing the sun rises on
  azSweep: 1.75, // radians the bearing turns through over the whole arc
  intensityLow: 1.5, // key intensity at the horizon, same units as environment.sunIntensity
  intensityHigh: 4.6, // ... and at the top of the arc
  colorHorizon: '#ff9a44', // the key light's colour on the horizon
  colorZenith: '#fff4dc', // ... and overhead

  /* ------------------------------------------------------------------ */
  /* The daystar — the one thing the ability actually draws               */
  /* ------------------------------------------------------------------ */
  /**
   * A single additive billboard placed up-sun from the circle, built in view
   * space around `uCentre` (see `materials/DaystarMaterial.js`). It exists so
   * the sweep reads as *the sun moving* rather than as the lighting glitching.
   */
  discDistance: 74.0, // metres up-sun from the circle the disc hangs
  discSize: 3.4, // radius of the body, metres at that distance
  discReach: 4.0, // how far past the body the quad is drawn, × discSize
  discSoft: 0.12, // how soft the limb is, 0..1 of the radius
  discLimb: 0.4, // limb-darkening exponent — low is a flatter, hotter face
  haloSize: 3.2, // aureole reach, × discSize (the quad grows to cover it)
  haloFalloff: 2.4, // how fast the aureole dies off; high is a tight glow
  flare: 0.6, // the anamorphic streak — the one deliberately artificial term
  flareLength: 0.9, // its half-length, × the aureole reach
  flareWidth: 0.16, // its half-height, × discSize
  granule: 0.35, // convection mottling across the face, 0..1
  granuleScale: 1.5, // cells per disc radius
  granuleSpeed: 0.12, // Hz the mottling crawls at
  discGlow: 2.6, // emissive gain into bloom
  discOpacity: 1.0, // master coverage of the disc
  colorDisc: '#fff6e2', // the body at the top of the arc
  colorDiscLow: '#ff7a2e', // the body on the horizon
  colorHalo: '#ffc27a', // the aureole and the streak

  /* ------------------------------------------------------------------ */
  /* The dust — how you see that the light has a direction                */
  /* ------------------------------------------------------------------ */
  /**
   * Grazing light picks dust out of the air; overhead light does not. That is
   * what `moteGraze` is: the emission rate is multiplied by it at the horizon
   * and by 1 at the top, so the air thickens at both ends of the arc and
   * clears in the middle without anything being keyframed.
   */
  moteRate: 26.0, // motes per second at the top of the arc
  moteGraze: 1.9, // × that rate on the horizon
  moteSize: 0.055, // metres
  moteLifetime: 3.4, // seconds
  moteRise: 0.22, // metres/second of buoyancy
  moteSpeed: 0.35, // metres/second of initial drift
  moteTurbulence: 0.5, // curl-noise strength on the drift
  moteHeight: 2.6, // metres of air above the circle the dust fills
  moteSpread: 0.95, // × zoneRadius — how much of the circle it fills
  moteJitter: 0.24, // metres of slop on one emission puff
  colorMoteA: '#fff0d2', // birth
  colorMoteB: '#ffcf94', // early
  colorMoteC: '#c98f52', // late
  colorMoteD: '#3b2c22', // death

  /* ------------------------------------------------------------------ */
  /* The local light, the flash and the readout                           */
  /* ------------------------------------------------------------------ */
  lightColor: '#ffce93', // the dynamic light standing in the circle
  lightIntensity: 2.2,
  lightRadius: 13.0, // metres
  lightHeight: 1.4, // metres above the floor it hangs
  lightNoon: 1.7, // × its intensity at the top of the arc — the shimmer curve
  crestFlash: 0.35, // screen flash as the sun leaves the horizon
  colorFlash: '#ffd9a6'
};

/** Editor layout. */
export const dawnbreakSchema = {
  'The cast': ['range', 'minRange', 'speed', 'cooldown', 'castAnim', ['zoneRadius', 1, 14, 0.1, 'circle radius (m)']],
  'The beats': [
    ['sweepTime', 0.4, 14, 0.05, 'sweep (s)'],
    ['settleTime', 0.1, 6, 0.05, 'settle back (s)'],
    ['reachCurve', 0.2, 4, 0.01, 'reach curve']
  ],
  'The arc': [
    ['sunWeight', 0, 1, 0.01, 'how much sun it takes'],
    ['elevLow', -0.2, 1.2, 0.005, 'horizon elevation (rad)'],
    ['elevHigh', 0.1, 1.5708, 0.005, 'top elevation (rad)'],
    ['elevCurve', 0.2, 3, 0.01, 'arc curve'],
    ['azStart', -3.1416, 6.2832, 0.005, 'rise bearing (rad)'],
    ['azSweep', -6.2832, 6.2832, 0.005, 'bearing swept (rad)'],
    ['intensityLow', 0, 10, 0.05, 'key at the horizon'],
    ['intensityHigh', 0, 10, 0.05, 'key overhead'],
    'colorHorizon',
    'colorZenith'
  ],
  'The daystar': [
    ['discDistance', 12, 180, 0.5, 'distance (m)'],
    ['discSize', 0.2, 20, 0.05, 'body radius (m)'],
    ['discReach', 1.2, 10, 0.05, 'drawn reach × radius'],
    ['discSoft', 0.005, 0.9, 0.005, 'limb softness'],
    ['discLimb', 0.05, 3, 0.01, 'limb darkening'],
    ['haloSize', 1, 8, 0.05, 'aureole × radius'],
    ['haloFalloff', 0.2, 8, 0.05, 'aureole falloff'],
    ['discGlow', 0, 8, 0.05, 'glow'],
    ['discOpacity', 0, 1, 0.01, 'opacity'],
    'colorDisc',
    'colorDiscLow',
    'colorHalo'
  ],
  'The daystar/Flare and face': [
    ['flare', 0, 3, 0.01, 'streak'],
    ['flareLength', 0.05, 3, 0.01, 'streak length'],
    ['flareWidth', 0.01, 1, 0.005, 'streak width'],
    ['granule', 0, 1, 0.01, 'granulation'],
    ['granuleScale', 0.1, 8, 0.05, 'granule scale'],
    ['granuleSpeed', 0, 2, 0.01, 'granule Hz']
  ],
  'The dust': [
    ['moteRate', 0, 200, 1, 'motes/second'],
    ['moteGraze', 0.1, 6, 0.05, 'grazing multiplier'],
    ['moteSize', 0.005, 0.4, 0.005, 'size (m)'],
    ['moteLifetime', 0.2, 10, 0.05, 'life (s)'],
    ['moteRise', -1, 2, 0.01, 'buoyancy (m/s)'],
    ['moteSpeed', 0, 4, 0.01, 'drift (m/s)'],
    ['moteTurbulence', 0, 3, 0.01, 'turbulence'],
    ['moteHeight', 0.2, 12, 0.05, 'column height (m)'],
    ['moteSpread', 0.05, 1.5, 0.01, 'fill × zoneRadius'],
    ['moteJitter', 0.01, 2, 0.01, 'puff radius (m)'],
    ['colorMote*', 'Dust gradient']
  ],
  'The light': [
    'lightColor',
    ['lightIntensity', 0, 12, 0.05, 'intensity'],
    ['lightRadius', 1, 40, 0.5, 'radius (m)'],
    ['lightHeight', 0, 6, 0.05, 'height (m)'],
    ['lightNoon', 0.2, 4, 0.01, 'overhead multiplier'],
    ['crestFlash', 0, 2, 0.01, 'crest flash'],
    'colorFlash'
  ]
};
