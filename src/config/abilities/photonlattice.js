/* ================================================================== */
/* PHOTONLATTICE — Photon Lattice, the lumen school's standing grid    */
/* ================================================================== */
/**
 * A three-dimensional grid of very thin beams hanging over the footprint:
 * one family running across the cast, one running up, one running downrange.
 * They cross at sixty-four points and every crossing is a bright node.
 *
 * **The trick is that nothing is drawn at the nodes.** There is no sprite, no
 * flare, no billboard, no second pass and no `uNodeGlow` slider anywhere in this
 * block. A node is bright because two beams are being *added* there, and the
 * only reason that works is that the beams are drawn additively and each one's
 * brightness is a real line integral through a gaussian tube rather than a
 * surface with a gradient painted on it. Two integrals sum to exactly twice
 * one; three, at a corner, to exactly three.
 *
 * The consequence is the one rule for tuning this block, and it is worth
 * knowing before touching anything: **if the nodes are not bright enough, the
 * beams are too dim.** `density`, `coreGain` and `intensity` are the only
 * honest answers. Reaching for something that lights the crossings on its own
 * would be building the fake this ability exists as the counter-example to.
 *
 * The second thing that makes it read is that `beamRadius` is *small* — four or
 * five centimetres of gaussian sigma. A fat beam has a broad, soft maximum, two
 * fat beams crossing sum to a slightly brighter blob, and the lattice reads as
 * a fog cube with lumps in it. A thin beam has a sharp maximum, and where two
 * sharp maxima coincide the eye reads a point of light. Drag `beamRadius` up
 * with the clock stopped and watch the nodes dissolve; that is the whole
 * argument in one slider.
 *
 * The rest is timing. Beams grow **from their own midpoints outward**, which is
 * why the nodes near the centre of the volume appear before the ones at the
 * corners, and why the fade — which retracts them the same way — puts the
 * corner nodes out first. Nothing was told to do that. It falls out of beams
 * that are actually the length they say they are.
 *
 * Four beats: **assemble** (travel — the beams draw in, staggered by
 * `stagger`), **lock** (impact — the grid stands, a `pulse` band running along
 * every beam at `pulseSpeed`), **retract** (fade — they draw back into their
 * midpoints) and out.
 *
 * A cast captures one seed. Every metre is re-resolved in the vertex shader
 * every frame, including a zero-length one: pause with **P** and drag `gridX`
 * and beams change *family* under you while the lattice re-lays itself.
 */
export const photonlattice = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.5, // closer than this and the cast is refused
  zoneRadius: 5.0, // the footprint — what the circle indicator measures out
  speed: 24.0, // metres/second the assemble front crosses to the point
  lifetime: 3.4, // seconds the locked grid stands
  fadeTime: 1.7, // seconds the beams take to retract
  cooldown: 1.9,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the grid --- */
  // Node counts, not beam counts. A family of beams runs along each axis and
  // is laid out on the plane of the other two, so these three numbers give
  // gy·gz + gx·gz + gx·gy beams and gx·gy·gz crossings. Five is the ceiling:
  // 3 × 25 = 75 beams, against a buffer allocated for 96.
  gridX: 4, // nodes across the cast
  gridY: 4, // nodes up
  gridZ: 4, // nodes downrange
  latticeSpread: 0.92, // half-extent across and downrange, × `zoneRadius`
  latticeHeight: 2.5, // half-extent up, metres
  latticeLift: 3.1, // metres the grid's centre floats above the floor
  latticeOverhang: 0.6, // metres a beam runs past the outermost node it serves
  latticeSpin: 0.0, // radians of standing yaw about the grid's own up
  latticeSpinSpeed: 0.09, // radians/second it turns while it stands

  /* --- one beam. Read the header before widening it. --- */
  beamRadius: 0.045, // metres — the CORE gaussian's sigma. This is the ability
  haloScale: 5.0, // the halo's sigma as a multiple of the core's
  hullPad: 3.2, // sigmas of gaussian tail the bounding hull has to cover
  density: 3.2, // per metre — turns the line integral into brightness
  coreGain: 1.0,
  haloGain: 0.3, // low: the halo is there to seat the core, not to be seen
  endTaper: 0.15, // 0..1 of the beam over which each end fades in
  endTint: 0.55, // 0..1 how far the ends take `colorEnd`
  intensity: 1.05, // master gain

  colorCore: '#fffaf0', // the beam itself, near-white so two of them clip warm
  colorHalo: '#8fd0ff', // the wider, cooler lobe that seats it in the air
  colorEnd: '#ffb85c', // what the free ends run out to

  /* --- the beats --- */
  stagger: 0.62, // 0..1 how far apart the beams switch on
  flicker: 0.14, // 0..1 depth of the per-beam breath
  flickerSpeed: 1.25, // breaths per second
  pulse: 2.6, // extra brightness in the band that runs along each beam
  pulseWidth: 0.12, // 0..1 of a beam
  pulseSpeed: 0.85, // traversals per second
  retract: 1.0, // 0..1 how far the beams draw back in over the fade

  /* --- motes hanging inside the volume --- */
  // Not node markers. They are seeded through the whole box and drift; the ones
  // that happen to be near a beam are lit by the beam, in the frame buffer,
  // because both are additive. Nothing samples the lattice to place them.
  moteRate: 40, // particles/second
  moteSize: 0.035,
  moteSpeed: 0.4, // metres/second
  moteLifetime: 3.2, // seconds
  moteRise: 0.12, // metres/second of buoyancy
  moteTurbulence: 0.35,
  moteSpread: 1.05, // 0..1 of the box's half-extent they are born across
  colorMoteA: '#ffffff',
  colorMoteB: '#bfe6ff',
  colorMoteC: '#4a7fb0',
  colorMoteD: '#0a1420',

  /* --- the lock --- */
  shockRadius: 5.5, // metres — the thin ring that snaps out when the grid locks
  shockLife: 0.55, // seconds
  colorShockA: '#ffffff',
  colorShockB: '#8fd0ff',
  castFlash: 0.1, // screen flash as the assemble begins
  colorCastFlash: '#e8f4ff',
  lockFlash: 0.26, // screen flash on the lock
  colorFlash: '#ffffff',
  lockShake: 0.14, // camera shake on the lock. A grid of light has no mass
  shakeDuration: 0.35, // seconds

  /* --- dynamic light --- */
  lightIntensity: 13.0,
  lightRadius: 14.0,
  lightColor: '#bfe0ff',
  lightSway: 0.12, // depth of the slow swell
  lightSwaySpeed: 0.7 // swells per second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Photon Lattice.
 *
 * Two sliders and nothing else, to begin with. `beamRadius` in **The beam** is
 * the ability: at 0.045 m the crossings are points of light, at 0.2 m they are
 * lumps in fog, and the transition is continuous and instructive. `density` is
 * the honest brightness control, and it is the only one — there is deliberately
 * no node term to reach for.
 *
 * After that, **The grid** is where the shape lives. `gridX/Y/Z` change how many
 * beams there are *and which family each one belongs to*, live, with the clock
 * stopped.
 */
export const photonlatticeSchema = {
  'The cast': [
    ['range', 5, 45, 0.1, 'max range'],
    ['minRange', 0, 14, 0.1, 'min range'],
    ['zoneRadius', 1, 14, 0.05, 'footprint radius'],
    ['speed', 4, 90, 0.5, 'assemble speed'],
    ['lifetime', 0.2, 14, 0.05, 'locked hold'],
    ['fadeTime', 0.2, 8, 0.05, 'retract time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The grid': [
    ['gridX', 1, 5, 1, 'nodes across'],
    ['gridY', 1, 5, 1, 'nodes up'],
    ['gridZ', 1, 5, 1, 'nodes downrange'],
    ['latticeSpread', 0.1, 2, 0.01, 'half-extent × zone'],
    ['latticeHeight', 0.2, 10, 0.05, 'half-extent up (m)'],
    ['latticeLift', 0, 12, 0.05, 'centre height (m)'],
    ['latticeOverhang', 0, 4, 0.01, 'overhang past nodes (m)'],
    ['latticeSpin', -3.2, 3.2, 0.01, 'standing yaw (rad)'],
    ['latticeSpinSpeed', -2, 2, 0.005, 'yaw rate (rad/s)']
  ],
  'The beam': [
    ['beamRadius', 0.005, 0.5, 0.001, 'core sigma (m)'],
    ['haloScale', 1, 16, 0.05, 'halo sigma ×'],
    ['hullPad', 1.5, 6, 0.05, 'hull padding (sigmas)'],
    ['density', 0, 12, 0.01, 'brightness / m'],
    ['coreGain', 0, 4, 0.01, 'core gain'],
    ['haloGain', 0, 3, 0.01, 'halo gain'],
    ['endTaper', 0.005, 0.5, 0.005, 'end taper'],
    ['endTint', 0, 1, 0.01, 'end colour pull'],
    ['intensity', 0, 5, 0.01, 'intensity'],
    ['colorCore', 'beam core'],
    ['colorHalo', 'beam halo'],
    ['colorEnd', 'free ends']
  ],
  'The beats': [
    ['stagger', 0, 0.95, 0.01, 'switch-on stagger'],
    ['flicker', 0, 1, 0.01, 'breath depth'],
    ['flickerSpeed', 0, 8, 0.01, 'breaths / second'],
    ['pulse', 0, 8, 0.01, 'pulse brightness'],
    ['pulseWidth', 0.01, 0.6, 0.005, 'pulse width'],
    ['pulseSpeed', -4, 4, 0.01, 'pulse traversals / s'],
    ['retract', 0, 1, 0.01, 'retract depth']
  ],
  Motes: [
    ['moteRate', 0, 300, 1, 'motes / second'],
    ['moteSize', 0.005, 0.3, 0.005, 'mote size'],
    ['moteSpeed', 0, 4, 0.01, 'mote speed (m/s)'],
    ['moteLifetime', 0.2, 10, 0.05, 'mote lifetime (s)'],
    ['moteRise', -2, 2, 0.01, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['moteSpread', 0, 2, 0.01, 'born across × extent'],
    ['colorMote*', 'Mote colour']
  ],
  'The lock': [
    ['shockRadius', 0.2, 16, 0.05, 'ring radius (m)'],
    ['shockLife', 0.05, 3, 0.01, 'ring life (s)'],
    ['castFlash', 0, 1.5, 0.01, 'cast flash'],
    ['lockFlash', 0, 1.5, 0.01, 'lock flash'],
    ['lockShake', 0, 2, 0.01, 'lock shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration (s)'],
    ['colorShockA', 'ring core'],
    ['colorShockB', 'ring rim'],
    ['colorCastFlash', 'cast flash'],
    ['colorFlash', 'lock flash']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightSway', 0, 1, 0.01, 'sway depth'],
    ['lightSwaySpeed', 0, 4, 0.01, 'sways / second'],
    ['lightColor', 'light colour']
  ]
};
