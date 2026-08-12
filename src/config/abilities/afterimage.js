/* ================================================================== */
/* AFTERIMAGE — chrono                                                 */
/* ================================================================== */
/**
 * A fan of blades flies the line, opening as it goes, and every `snapGap`
 * seconds it sheds a copy of itself that stops where it was.
 *
 * There is no captured second anywhere in this block's ability. Copy `k` is
 * the cast shown at age `k × snapGap`, and `snapGap` is the slider directly
 * below — so with the sandbox paused, dragging it re-ages every frozen moment
 * at once, slides each of them to where it would have been at its new age, and
 * re-opens it to the shape it had there. Dragging `speed`, `range`,
 * `bladeLength`, `splay` or `openCurve` does the same to all of them
 * simultaneously. That is the ability; the rest of this block is dressing.
 *
 * Open **The row** first, put `snaps` at 6 and pull `snapGap` back and forth.
 */
export const afterimage = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 2.5, // closer than this and the cast is refused
  speed: 17.0, // how fast the body flies, metres/second
  lifetime: 1.0, // seconds the row stands after the body lands
  fadeTime: 1.2, // seconds it takes to be taken away
  cooldown: 0.8,
  castAnim: 'cast2',

  /* --- the row --- */
  snaps: 6, // frozen copies standing behind the body (capped at 8)
  snapGap: 0.115, // seconds of cast age between one copy's instant and the next
  flightCurve: 1.15, // >1 leaves slowly and arrives fast, so the row bunches at the muzzle

  /* --- the flight the whole row sits on --- */
  liftNear: 1.25, // metres above the floor at the muzzle
  lift: 0.95, // ... and at the far end
  arc: 0.3, // metres the flight bows upward at mid-span
  sway: 0.22, // metres of lateral wander along the line
  swayWaves: 1.15, // wavelengths of that wander over the whole line

  /* --- one body --- */
  // The form has to change strongly with age or six copies of it read as six
  // of the same object: a bud at the muzzle, a blade at mid-range and a
  // splayed fan at the end is three legibly different silhouettes off one
  // parameter, and that is what makes the row read as one thing photographed
  // six times.
  fins: 3, // blades in the fan (capped at 4)
  splay: 0.42, // radians a blade tilts off the axis, fully open
  finGap: 0.075, // metres a blade steps off the axis, fully open
  roll: 0.0, // radians the fan is rolled at birth
  rollSpeed: 1.3, // radians/second it keeps rolling as it flies
  holdSpin: 0.12, // radians/second a *frozen* copy keeps turning — it is held, not dead
  lengthNear: 0.45, // metres — the bud at the muzzle
  bladeLength: 2.0, // metres — the blade, fully open
  radiusNear: 0.085, // metres
  bladeRadius: 0.15, // metres
  flatten: 0.42, // 0..1 squashes the sliver into a blade rather than a spindle
  openCurve: 0.75, // <1 opens it early, >1 keeps it shut and opens it late

  /* --- what being held does to a copy --- */
  holdLife: 2.6, // seconds a frozen copy takes to give up
  holdShrink: 0.045, // × per second it contracts
  holdSink: 0.045, // metres/second it settles toward the floor
  holdDim: 0.6, // 0..1 how far a fully-held copy has faded out
  erode: 0.9, // 0..1 how much of a held copy the dissolve eventually takes
  erodeScale: 2.4, // dissolve noise features per metre
  erodeEdge: 0.17, // 0..1 width of the burning edge on that dissolve
  edgeGlow: 1.5, // emission on that edge

  /* --- colour and shading --- */
  colorLive: '#f6e3b4', // the copy that is still the present
  colorHeld: '#8d8570', // ... and one that has been standing a while
  colorRim: '#ffeec8', // the fresnel edge and the dissolve's burn
  colorCore: '#fffdf6', // the spine down the middle of a blade
  rim: 1.15, // fresnel emission
  rimPower: 2.5, // fresnel tightness
  core: 0.9, // brightness of the spine
  bandScale: 3.2, // bands per metre of world height
  bandSpeed: 0.55, // metres/second those bands travel
  bandGlow: 0.32, // their emission
  glow: 1.6, // overall emissive gain
  opacity: 1.0,
  softFade: 0.5, // metres of soft fade where a copy meets geometry

  /* --- the stasis bubble on the newest held copy --- */
  holdRadius: 1.5, // metres of the region that stops time around it
  holdCore: 0.4, // 0..1 of that radius that is fully stopped
  holdStrength: 0.95, // 0..1 how completely
  holdRate: 0.0, // clock rate inside — 0 stasis, -1 rewind, 0.25 slow motion

  /* --- what the body sheds --- */
  moteRate: 110, // motes/second off the live body
  moteSize: 0.055,
  moteSpeed: 1.1,
  moteLifetime: 2.6, // long, because a mote that dies in 200 ms cannot be seen to stop
  moteRise: 0.3, // upward drift, metres/second
  moteTurbulence: 0.5,
  moteSpread: 0.3, // metres of scatter around the body
  moteOpacity: 0.8,
  moteGlow: 1.0,
  colorMoteA: '#fff6df',
  colorMoteB: '#f0d8a0',
  colorMoteC: '#a3906a',
  colorMoteD: '#2b2519',

  /* --- the shutter click, when a copy detaches --- */
  shearPerSnap: 26, // streaks thrown sideways per freeze
  shearSize: 0.13,
  shearSpeed: 5.5,
  shearLifetime: 0.55,
  shearGravity: -3.0,
  shearStretch: 0.22, // how far a streak smears along its velocity
  shearSpread: 0.28, // metres of scatter at the freeze
  shearGlow: 1.4,
  colorShearA: '#ffffff',
  colorShearB: '#ffeec8',
  colorShearC: '#c9a86a',
  colorShearD: '#3a2f1c',
  snapRingRadius: 0.9, // the thin ring left on the floor under a freeze, metres
  snapRingLife: 0.7,
  snapRingWidth: 0.04,
  snapRingIntensity: 0.55,
  snapPunch: 0.35, // × light intensity added on each freeze
  colorSnapRingA: '#d8c395',
  colorSnapRingB: '#fff4d8',

  /* --- the arrival --- */
  arrivalSize: 2.1, // radius of the pressure shell at the far end, metres
  arrivalIntensity: 1.1,
  arrivalShear: 90, // streaks thrown on arrival
  arrivalShake: 0.3,
  shakeDuration: 0.45,
  arrivalFlash: 0.09,
  rumble: 0.012, // continuous shake while the body flies
  colorArrivalA: '#c9a86a',
  colorArrivalB: '#f4e9cd',
  colorArrivalC: '#fffaf0',
  colorFlash: '#efe2c0',

  /* --- dynamic light --- */
  lightIntensity: 14,
  lightRadius: 13,
  lightColor: '#f0d8a0',
  lightSteps: 4, // levels the light quantises to — it steps, one per copy shed
  lightStagger: 0.3 // 0..1 how far it drops between those levels
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Afterimage.
 *
 * Every control in **The row**, **The flight** and **One body** is evaluated
 * per instance in the vertex shader against each copy's own age, so all of them
 * reshape the whole standing row and not just the body that is still moving.
 * That is worth doing at least once with **P** held down: it is the clearest
 * demonstration of invariant I1 anywhere in the sandbox.
 */
export const afterimageSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 80, 0.5, 'flight speed'],
    ['lifetime', 0.05, 8, 0.01, 'row hold'],
    ['fadeTime', 0.05, 5, 0.01, 'taken-away time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The row': [
    ['snaps', 0, 8, 1, 'frozen copies'],
    ['snapGap', 0.02, 0.8, 0.005, 'seconds between copies'],
    ['flightCurve', 0.2, 4, 0.01, 'flight curve']
  ],
  'The flight': [
    ['liftNear', 0, 3, 0.01, 'height at muzzle'],
    ['lift', 0, 3, 0.01, 'height at target'],
    ['arc', -2, 3, 0.01, 'mid-span bow'],
    ['sway', 0, 2, 0.01, 'lateral wander'],
    ['swayWaves', 0, 6, 0.05, 'wander wavelengths']
  ],
  'One body': [
    ['fins', 1, 4, 1, 'blades'],
    ['splay', 0, 1.6, 0.01, 'splay'],
    ['finGap', 0, 0.6, 0.005, 'blade offset'],
    ['roll', -3.2, 3.2, 0.01, 'roll at birth'],
    ['rollSpeed', -8, 8, 0.05, 'roll speed'],
    ['holdSpin', -3, 3, 0.01, 'held spin'],
    ['lengthNear', 0.05, 3, 0.01, 'length at muzzle'],
    ['bladeLength', 0.1, 6, 0.01, 'length open'],
    ['radiusNear', 0.01, 0.8, 0.005, 'radius at muzzle'],
    ['bladeRadius', 0.01, 0.8, 0.005, 'radius open'],
    ['flatten', 0.02, 1, 0.01, 'blade flatness'],
    ['openCurve', 0.1, 4, 0.01, 'opening curve']
  ],
  'Being held': [
    ['holdLife', 0.1, 10, 0.05, 'hold lifetime'],
    ['holdShrink', 0, 0.6, 0.005, 'shrink / second'],
    ['holdSink', -0.3, 0.6, 0.005, 'settle / second'],
    ['holdDim', 0, 1, 0.01, 'dim when held'],
    ['erode', 0, 1.5, 0.01, 'dissolve'],
    ['erodeScale', 0.2, 10, 0.05, 'dissolve scale'],
    ['erodeEdge', 0.01, 0.6, 0.005, 'burning edge'],
    ['edgeGlow', 0, 6, 0.05, 'edge glow']
  ],
  'Being held/Stasis bubble': [
    ['holdRadius', 0, 8, 0.05, 'bubble radius'],
    ['holdCore', 0, 1, 0.01, 'stopped core'],
    ['holdStrength', 0, 1, 0.01, 'strength'],
    ['holdRate', -2, 2, 0.05, 'clock rate inside']
  ],
  Colour: [
    ['colorLive', 'the present'],
    ['colorHeld', 'held'],
    ['colorRim', 'rim & burn'],
    ['colorCore', 'spine'],
    ['rim', 0, 5, 0.01, 'rim glow'],
    ['rimPower', 0.2, 8, 0.05, 'rim tightness'],
    ['core', 0, 4, 0.01, 'spine brightness'],
    ['bandScale', 0.2, 14, 0.1, 'bands / metre'],
    ['bandSpeed', -4, 4, 0.01, 'band speed'],
    ['bandGlow', 0, 2, 0.01, 'band glow'],
    ['glow', 0, 6, 0.01, 'glow'],
    ['opacity', 0, 2, 0.01, 'opacity'],
    ['softFade', 0.02, 3, 0.01, 'soft intersection']
  ],
  Motes: [
    ['moteRate', 0, 600, 1, 'motes / second'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 10, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 4, 0.01, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['moteSpread', 0.02, 2, 0.01, 'mote spread'],
    ['moteOpacity', 0, 2, 0.01, 'mote opacity'],
    ['moteGlow', 0, 4, 0.01, 'mote glow'],
    ['colorMote*', 'Mote colour']
  ],
  'The shutter': [
    ['shearPerSnap', 0, 200, 1, 'streaks / freeze'],
    ['shearSize', 0.005, 0.6, 0.005, 'streak size'],
    ['shearSpeed', 0, 25, 0.1, 'streak speed'],
    ['shearLifetime', 0.05, 4, 0.01, 'streak lifetime'],
    ['shearGravity', -30, 5, 0.1, 'streak gravity'],
    ['shearStretch', 0, 3, 0.01, 'streak stretch'],
    ['shearSpread', 0.02, 2, 0.01, 'streak spread'],
    ['shearGlow', 0, 4, 0.01, 'streak glow'],
    ['colorShear*', 'Streak colour'],
    ['snapRingRadius', 0.05, 6, 0.05, 'ring radius'],
    ['snapRingLife', 0.05, 4, 0.05, 'ring lifetime'],
    ['snapRingWidth', 0.005, 0.4, 0.005, 'ring width'],
    ['snapRingIntensity', 0, 3, 0.01, 'ring intensity'],
    ['snapPunch', 0, 3, 0.01, 'light punch / freeze'],
    ['colorSnapRingA', 'ring body'],
    ['colorSnapRingB', 'ring crest']
  ],
  'The arrival': [
    ['arrivalSize', 0.1, 12, 0.05, 'shell size'],
    ['arrivalIntensity', 0, 5, 0.01, 'shell intensity'],
    ['arrivalShear', 0, 400, 1, 'arrival streaks'],
    ['arrivalShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 3, 0.01, 'shake duration'],
    ['arrivalFlash', 0, 1, 0.005, 'screen flash'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['colorArrivalA', 'shell'],
    ['colorArrivalB', 'shell body'],
    ['colorArrivalC', 'shell filaments'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightSteps', 1, 10, 1, 'quantise levels'],
    ['lightStagger', 0, 1, 0.01, 'step depth'],
    ['lightColor', 'light colour']
  ]
};
