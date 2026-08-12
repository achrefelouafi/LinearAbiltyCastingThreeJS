/* ================================================================== */
/* VOIDRIFT — the hole in the floor                                    */
/* ================================================================== */
/**
 * A line cast that does not put anything *on* the stage. It takes a piece of
 * the stage away: a slit torn open along the aimed line, lying in the floor
 * plane, with a different sky behind it.
 *
 * ### Why the numbers are shaped the way they are
 *
 * **The tear is two independent fronts, and that is the whole beat.** `open`
 * sweeps a threshold on a ragged field, which unzips the wound *across* its
 * width from the long centreline — that is `openTime`. `tearSpeed` marches the
 * two ends *along* the line at a real metres-per-second, from a `tearSeed` nick
 * to `riftSpan × half the cast length`. The second front is the one that
 * matters: a slit whose `radiusX` grows while `riftWidth` stands still has ends
 * that propagate, and a slit whose *both* radii grow is a sprite scaling up.
 * The first build did the second thing and it read as a decal fading in from
 * nothing, which is precisely the failure `Portal`'s own doc comment warns
 * about — it just warns about it for `open`, and `open` was already right.
 *
 * **`parallax` must not be 1.** One is geometrically honest and geometric
 * honesty reads as a hole in a *wall*. 1.75 is the shipped value: the interior
 * slides against the camera about three quarters faster than the aperture says
 * it should, and that mismatch is the entire illusion of depth. Drag it to 1
 * with the clock paused and watch the rift turn into a sticker.
 *
 * **The lens is authored separately from the hole.** `Portal` deliberately
 * writes no screen-space offsets; the ring of bent floor comes from a
 * `DistortionField` in `LENS` mode at the same anchor, with `lensRadius` a
 * little past the rift's own half-length so the bend starts outside the
 * fracture rather than inside it. Its `lensStrength` is a screen fraction, not
 * a metre, and neither `post.distortion` nor `global.distortion` is folded into
 * it — the pass applies both, once.
 *
 * **Closing runs the tear backwards.** The same ragged field, the same grain,
 * the same shards, `open` descending instead of ascending — so it un-tears in
 * the places it tore. What is left over `afterTime` is a hairline: `afterOpen`
 * is small enough that only the band nearest the centreline is still open, the
 * rim exponential covers all of it, and `afterGlow` lifts it to white. A
 * separate afterimage quad was tried first and cost a draw call to say
 * something the pinch already says.
 */
export const voidrift = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 62.0, // how fast the cast front runs down the line, metres/second
  cooldown: 1.4, // seconds
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws
  holdTime: 1.5, // seconds the rift stands open once the tear finishes
  closeTime: 0.42, // seconds the tear takes to run backwards
  afterTime: 0.5, // seconds the hairline afterimage lingers for

  /* --- where the rift stands --- */
  // The aperture lies in the floor plane by default (`tilt` = 0 puts its normal
  // straight up), so the camera looks *down into* space rather than at a pane
  // hung in the air. `riftHeight` is the clearance that keeps a tilted rift
  // from sinking its near edge through the floor and being depth-rejected.
  centreBias: 0.52, // where along the cast line the rift is centred, 0..1
  riftHeight: 0.24, // metres the rift plane floats above the floor
  riftSpan: 0.86, // full half-length as a fraction of half the cast length
  riftWidth: 0.95, // metres, half-width of the slit across the line
  tilt: 0.16, // radians the plane rolls about the cast line
  margin: 0.55, // extra quad around the aperture so the cracks have room, 0..1

  /* --- the tear --- */
  tearSeed: 0.35, // metres, half-length of the first nick
  tearSpeed: 30.0, // metres/second the two ends race outward
  openTime: 0.22, // seconds the seam takes to unzip to full width
  closeDraw: 0.62, // 0..1 how far the ends pull back in as it shuts
  afterOpen: 0.085, // aperture left as the hairline afterimage, 0..1 of the field
  afterGlow: 3.4, // × the fracture glow while the hairline burns off
  seam: 0.92, // 0 unzips from the centre, 1 from the long centreline
  tearJag: 0.72, // 0..1 how uneven the tear front is
  tearScale: 2.4, // cycles per metre of crack grain — a physical size
  tearCrawl: 0.18, // Hz the grain creeps while the rift is held
  edgeSoft: 0.035, // 0..1 of the field — how hard the aperture cuts

  /* --- the fracture rim --- */
  rim: 0.042, // 0..1 of the field — width of the fracture band
  rimGlow: 2.9,
  core: 0.009, // 0..1 — the white-hot line inside the band
  coreGlow: 7.0,
  throat: 0.2, // 0..1 — the soft inner glow past the rim
  throatGlow: 0.55,
  crackCount: 17, // radial fractures around the rim
  crackWidth: 0.075, // 0..1 of one angular cell
  crackLength: 0.26, // 0..1 of the field they reach out to
  crackGlow: 2.1,

  /* --- the interior --- */
  parallax: 1.75, // 1 is honest and reads as a window. See the note above.
  swirl: 0.06, // radians/second the whole interior turns
  interiorFade: 0.4, // 0..1 how much the void darkens toward the rim
  opacity: 1.0,
  starSize: 0.04, // star core size, in lattice cells
  starTwinkle: 0.42,
  starGain: 1.15,
  starScaleA: 2.4, // stars per metre, near shell
  starScaleB: 5.0, // ... middle shell
  starScaleC: 9.8, // ... far shell
  starDepthA: 3.0, // metres behind the aperture, near shell
  starDepthB: 8.5, // ... middle shell
  starDepthC: 22.0, // ... far shell
  starDriftA: 0.04, // radians/second, near shell
  starDriftB: 0.021, // ... middle shell
  starDriftC: 0.009, // ... far shell
  nebulaScale: 0.19, // cycles per metre
  nebulaSpeed: 0.045,
  nebulaGain: 0.6,
  nebulaDepth: 14.0, // metres behind the aperture

  /* --- the interior's colours --- */
  // Ten pickers, none derived from another (I5). The interior is genuinely
  // `#000000`: `Portal` writes premultiplied, so a black interior at alpha 1
  // *removes* the floor rather than tinting it.
  colorVoid: '#000000', // the nothing behind the aperture
  colorRim: '#b07aff', // the fracture band
  colorCore: '#ffffff', // the white-hot line inside it
  colorCrack: '#8a5fd0', // the crown of radial fractures
  colorThroat: '#2c1256', // the soft glow just inside the lip
  colorStarA: '#ffffff', // near shell
  colorStarB: '#c8d4ff', // middle shell
  colorStarC: '#8f7dff', // far shell
  colorNebulaA: '#0d0418', // the nebula's floor
  colorNebulaB: '#5b2ea6', // ... and its crest

  /* --- the lens that bends the floor into it --- */
  // Screen fractions, never metres, and never pre-multiplied by
  // `post.distortion` / `global.distortion` — the pass applies both, once.
  lensRadius: 1.55, // falloff edge, × the rift's live half-length
  lensQuad: 2.3, // the emitter quad, × lensRadius
  lensStrength: 0.24, // screen widths at post.distortion = 1
  lensWindow: 0.62, // 0..1 of the radius where the falloff starts
  lensCore: 0.2, // 0..1 of the radius — the 1/r² clamp
  lensSwirl: 0.35, // tangential component, so the floor drags round the tear
  lensMax: 0.9, // hard ceiling on the offset
  lensLift: 0.5, // metres the billboard is anchored above the floor
  lensDepthReject: 1.0, // 0..1 how hard geometry in front of it kills the warp
  lensDepthFade: 0.45, // metres of feather on that rejection
  lensPerspective: 0.35, // 0..1 how much the warp shrinks with distance
  lensPerspectiveRef: 14.0, // metres at which perspective is neutral

  /* --- motes pulled in and eaten --- */
  // These are the only particles that go *inward*. `motePull` is the swirl
  // system's radial expansion, driven negative: at -1 the offset reaches zero
  // exactly at the end of a mote's life, so it converges on the rift and is
  // gone. Nothing about that is faked with a fade.
  moteRate: 130, // motes born per second, particles/second
  moteSize: 0.075,
  moteSpread: 2.1, // metres — radius of the ball a mote is born in
  moteDrift: 0.3, // metres/second the ball sinks toward the plane
  moteSink: -0.55, // gravity on a mote, metres/second²
  moteSpin: 1.9, // radians/second it orbits the rift while it falls in
  motePull: -0.94, // radial expansion; negative eats them at the rim
  moteLifetime: 1.5, // seconds
  moteTurbulence: 0.35,
  colorMoteA: '#e8dcff', // birth
  colorMoteB: '#b07aff', // early
  colorMoteC: '#4a2a8c', // late
  colorMoteD: '#07030f', // death — it goes out as it is swallowed

  /* --- embers shed by the fracture rim --- */
  emberRate: 90, // particles/second, shed along the live tear
  emberSize: 0.11,
  emberSpeed: 3.6, // metres/second
  emberLifetime: 0.55, // seconds
  emberGravity: -4.5, // metres/second²
  emberStretch: 0.22, // how far a streak smears along its velocity
  colorEmberA: '#ffffff',
  colorEmberB: '#dcc8ff',
  colorEmberC: '#8a5fd0',
  colorEmberD: '#1b0a35',

  /* --- what the floor keeps --- */
  scorchRate: 1.1, // stains laid per metre of new tear
  scorchRadius: 0.55, // metres
  scorchLife: 5.5, // seconds
  scorchIntensity: 0.7,
  colorScorch: '#04030a', // the stain where the floor is missing
  colorScorchEdge: '#6a4aa8', // its lit lip
  shockRadius: 6.0, // the ring thrown out when the tear completes, metres
  colorShockA: '#7a4fd0', // body of the ring
  colorShockB: '#ffffff', // its crest

  /* --- the moment it finishes tearing --- */
  burstSize: 2.4, // shell of displaced air at the far end, metres
  burstIntensity: 1.3,
  burstEmbers: 140, // extra embers thrown at that moment
  colorBurstA: '#3a1a6a',
  colorBurstB: '#8a5fd0',
  colorBurstC: '#ffffff',
  impactShake: 0.55,
  shakeDuration: 0.6, // seconds
  impactFlash: 0.16, // screen flash on completion
  colorFlash: '#c9a2ff',
  rumble: 0.035, // continuous shake while the ends are still racing

  /* --- dynamic light --- */
  // Violet, weak and short: the rift is a hole, and a hole that floodlights the
  // room is a lamp. What the light is for is picking the floor's own relief out
  // of the darkness immediately around the lip.
  lightIntensity: 11,
  lightRadius: 9,
  lightColor: '#a86bff'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Void Rift.
 *
 * The four controls that carry the whole effect, in order: `parallax` (1 is a
 * window, 1.75 is a hole in space), `tearSpeed` (how fast the ends race, and
 * therefore whether it reads as torn or as drawn), `riftWidth` against
 * `riftSpan` (a wound versus a manhole) and `lensStrength` (how hard the floor
 * bends into it). Everything below is live on a rift that is already standing —
 * pause with **P** halfway through the tear and drag any of them.
 */
export const voidriftSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'front speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation'],
    ['holdTime', 0.1, 8, 0.01, 'hold open'],
    ['closeTime', 0.05, 3, 0.01, 'close time'],
    ['afterTime', 0.05, 3, 0.01, 'afterimage time']
  ],
  'Where it stands': [
    ['centreBias', 0, 1, 0.01, 'centre along the line'],
    ['riftHeight', 0, 3, 0.01, 'height above floor (m)'],
    ['riftSpan', 0.05, 1.4, 0.01, 'half-length × half the cast'],
    ['riftWidth', 0.05, 4, 0.01, 'half-width (m)'],
    ['tilt', -1.5, 1.5, 0.01, 'roll about the line (rad)'],
    ['margin', 0, 1.5, 0.01, 'crack margin']
  ],
  'The tear': [
    ['tearSeed', 0.02, 3, 0.01, 'first nick (m)'],
    ['tearSpeed', 0.5, 80, 0.5, 'ends race (m/s)'],
    ['openTime', 0.02, 2, 0.01, 'unzip time'],
    ['closeDraw', 0, 1, 0.01, 'ends pull back'],
    ['afterOpen', 0.01, 0.4, 0.005, 'hairline aperture'],
    ['afterGlow', 0, 10, 0.05, 'hairline glow ×'],
    ['seam', 0, 1, 0.01, 'seam (centre → centreline)'],
    ['tearJag', 0, 1, 0.01, 'front raggedness'],
    ['tearScale', 0.1, 8, 0.05, 'grain (cycles/m)'],
    ['tearCrawl', -2, 2, 0.01, 'grain crawl (Hz)'],
    ['edgeSoft', 0.002, 0.3, 0.002, 'edge softness']
  ],
  'The fracture': [
    ['rim', 0.002, 0.3, 0.002, 'rim band'],
    ['rimGlow', 0, 10, 0.05, 'rim glow'],
    ['core', 0.001, 0.1, 0.001, 'core line'],
    ['coreGlow', 0, 20, 0.05, 'core glow'],
    ['throat', 0.01, 1, 0.005, 'throat depth'],
    ['throatGlow', 0, 5, 0.01, 'throat glow'],
    ['crackCount', 1, 40, 1, 'radial cracks'],
    ['crackWidth', 0.005, 0.4, 0.005, 'crack width'],
    ['crackLength', 0.01, 1.2, 0.01, 'crack reach'],
    ['crackGlow', 0, 8, 0.05, 'crack glow'],
    ['colorRim', 'fracture band'],
    ['colorCore', 'hot line'],
    ['colorCrack', 'radial cracks'],
    ['colorThroat', 'throat glow']
  ],
  'What is behind it': [
    ['parallax', 0.2, 3, 0.01, 'parallax (1 = a window)'],
    ['swirl', -1, 1, 0.005, 'interior spin (rad/s)'],
    ['interiorFade', 0, 1, 0.01, 'darken toward rim'],
    ['opacity', 0, 1.5, 0.01, 'aperture opacity'],
    ['starSize', 0.005, 0.2, 0.001, 'star size'],
    ['starTwinkle', 0, 1.5, 0.01, 'twinkle'],
    ['starGain', 0, 4, 0.01, 'star gain'],
    ['nebulaScale', 0.02, 1.5, 0.01, 'nebula scale (cyc/m)'],
    ['nebulaSpeed', 0, 1, 0.005, 'nebula drift'],
    ['nebulaGain', 0, 3, 0.01, 'nebula gain'],
    ['nebulaDepth', 1, 60, 0.5, 'nebula depth (m)'],
    ['colorVoid', 'the void itself'],
    ['colorNebulaA', 'nebula floor'],
    ['colorNebulaB', 'nebula crest']
  ],
  'What is behind it/Star shells': [
    ['starScaleA', 0.2, 30, 0.1, 'near: stars / m'],
    ['starDepthA', 0.2, 60, 0.1, 'near: depth (m)'],
    ['starDriftA', -0.5, 0.5, 0.001, 'near: drift (rad/s)'],
    ['colorStarA', 'near shell'],
    ['starScaleB', 0.2, 30, 0.1, 'mid: stars / m'],
    ['starDepthB', 0.2, 60, 0.1, 'mid: depth (m)'],
    ['starDriftB', -0.5, 0.5, 0.001, 'mid: drift (rad/s)'],
    ['colorStarB', 'middle shell'],
    ['starScaleC', 0.2, 30, 0.1, 'far: stars / m'],
    ['starDepthC', 0.2, 90, 0.1, 'far: depth (m)'],
    ['starDriftC', -0.5, 0.5, 0.001, 'far: drift (rad/s)'],
    ['colorStarC', 'far shell']
  ],
  'The lens': [
    ['lensRadius', 0.2, 4, 0.01, 'falloff × half-length'],
    ['lensQuad', 1, 5, 0.05, 'emitter quad × radius'],
    ['lensStrength', 0, 1.5, 0.005, 'strength (screen widths)'],
    ['lensWindow', 0, 1, 0.01, 'falloff start'],
    ['lensCore', 0.02, 1, 0.01, '1/r² clamp'],
    ['lensSwirl', -2, 2, 0.01, 'tangential drag'],
    ['lensMax', 0, 3, 0.01, 'offset ceiling'],
    ['lensLift', 0, 4, 0.01, 'anchor height (m)'],
    ['lensDepthReject', 0, 1, 0.01, 'depth reject'],
    ['lensDepthFade', 0, 3, 0.01, 'depth feather (m)'],
    ['lensPerspective', 0, 1, 0.01, 'perspective'],
    ['lensPerspectiveRef', 1, 40, 0.5, 'perspective ref (m)']
  ],
  'Motes it eats': [
    ['moteRate', 0, 600, 1, 'mote rate'],
    ['moteSize', 0.005, 0.5, 0.005, 'mote size'],
    ['moteSpread', 0.1, 8, 0.05, 'birth radius (m)'],
    ['moteDrift', -3, 3, 0.01, 'sink toward plane (m/s)'],
    ['moteSink', -12, 4, 0.05, 'gravity (m/s²)'],
    ['moteSpin', -8, 8, 0.05, 'orbit (rad/s)'],
    ['motePull', -1, 1, 0.01, 'radial pull (−1 eats them)'],
    ['moteLifetime', 0.1, 6, 0.05, 'mote lifetime'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['colorMote*', 'Mote colour']
  ],
  'Embers off the rim': [
    ['emberRate', 0, 600, 1, 'ember rate'],
    ['emberSize', 0.005, 0.6, 0.005, 'ember size'],
    ['emberSpeed', 0, 25, 0.1, 'ember speed'],
    ['emberLifetime', 0.05, 4, 0.01, 'ember lifetime'],
    ['emberGravity', -40, 10, 0.1, 'ember gravity'],
    ['emberStretch', 0, 3, 0.01, 'ember stretch'],
    ['colorEmber*', 'Ember colour']
  ],
  'What the floor keeps': [
    ['scorchRate', 0.05, 6, 0.05, 'stains / metre'],
    ['scorchRadius', 0.05, 4, 0.05, 'stain radius'],
    ['scorchLife', 0.5, 20, 0.1, 'stain lifetime'],
    ['scorchIntensity', 0, 3, 0.01, 'stain intensity'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['colorScorch', 'stain'],
    ['colorScorchEdge', 'stain lip'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest']
  ],
  'The moment it opens': [
    ['burstSize', 0.2, 12, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['burstEmbers', 0, 500, 1, 'burst embers'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'tearing rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst arcs'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
