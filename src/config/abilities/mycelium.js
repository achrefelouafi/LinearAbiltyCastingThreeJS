/* ================================================================== */
/* MYCELIUM — verdant, line cast                                       */
/* ================================================================== */
/**
 * Mycelial Web — the one ability in the sandbox that is **under the floor**.
 *
 * A fungal mat runs out beneath the flagstones along the aimed line. Nothing
 * draws the mat. What is on screen is light *escaping* — through the mortar
 * courses, through the open pores of the stone, and nowhere else — so the
 * pattern you actually see belongs to the floor, and the mycelium only decides
 * how brightly each part of the floor is lit from below.
 *
 * The escape mask is built out of `world/Ground.js`'s **own** procedural
 * fields, at its frequencies and phase offsets: the level set of its
 * `fbm3(wp * 0.018)` macro variation is the mortar course, its
 * `fbm3(wp * 0.06 + 3.0)` sheen patches seal the light off (polished stone is
 * sound stone), and its `snoise01(wp * 0.7)` grain biases where the open pores
 * sit. The contour distance is divided by that field's own gradient so
 * `seamWidth` is a measurement in metres of a real mortar course rather than a
 * dimensionless threshold whose width on the floor depends on where you stand.
 *
 * Three sliders carry the illusion and each of them is worth taking to zero
 * once to see what it was doing:
 *
 *  - **`webParallax`** — the buried web is sampled offset by
 *    `depth * viewXZ / viewY`, so it slides against the cracks it is seen
 *    through as the camera orbits. At zero the cast is a sticker.
 *  - **`webSpread`** — metres of extra blur per metre of burial. At zero every
 *    strand is equally sharp and the mat reads as painted on the underside of
 *    a pane of glass rather than as something inside stone.
 *  - **`polishSeal`** — how completely the floor's own polished patches close.
 *    At zero the glow ignores the stone entirely and you are looking at the
 *    network, which is the failure the whole file exists to avoid.
 *
 * The pieces are one bespoke seep quad (`materials/MyceliumSeepMaterial.js`)
 * and one `GroundField(WET)` for the damp patch at the far end — two draw
 * calls, plus two shared particle systems.
 */
export const mycelium = {
  /* --- the cast --- */
  range: 17.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 13.0, // how fast the growth front creeps, metres/second
  cooldown: 1.5, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats, all seconds --- */
  creepTime: 2.2, // the mat creeping on past the target after the front lands
  holdTime: 5.0, // it lying there, pulsing
  rotTime: 3.2, // it dying back and going out

  /* --- the lane the mat spreads in --- */
  laneHalfWidth: 2.1, // metres — half-width of the band at the caster
  laneTaper: 0.22, // 0..1 how much narrower the far end is
  laneBack: 0.9, // metres the mat reaches back behind the caster
  laneEdge: 0.55, // metres of feather on every boundary
  laneRagged: 0.85, // metres the boundaries wander by
  laneRaggedScale: 0.42, // lobes per metre
  laneWarp: 0.9, // metres of domain warp on those lobes
  creepReach: 0.22, // extra length the mat takes after landing, × the cast
  dieBack: 1.0, // 0..1 how much of the mat the rot reclaims
  seepHeight: 0.012, // metres above the floor the seep quad sits at

  /* --- the buried web --- */
  webCell: 0.44, // metres between hyphae
  webStretch: 2.3, // >1 draws the strands out along the lane
  webJitter: 0.92, // 0..1 lattice disorder — 0 is a grid, and looks like one
  webCore: 0.014, // metres — half-width of a hypha lying on the surface
  webSpread: 0.6, // extra metres of half-width per metre of burial depth
  webDepthMin: 0.02, // metres — the shallowest a strand runs
  webDepthMax: 0.24, // metres — the deepest
  webDepthPitch: 0.32, // cycles per metre in the burial-depth field
  webAbsorb: 4.2, // 1/metre — Beer-Lambert extinction through the flags
  webParallax: 1.0, // 0..1 of the true depth offset. Zero flattens the cast
  webBranch: 0.55, // 0..1 weight of the finer secondary web
  webBranchScale: 2.8, // >1 how much finer that web is

  /* --- the nutrient pulses running the web --- */
  pulseSpacing: 3.4, // metres between crests
  pulseSpeed: 2.2, // metres/second they travel downrange at
  pulseSharp: 7.0, // crest exponent — low is a swell, high is a bead
  pulseGain: 0.85, // how much brighter a crest is

  /* --- the escape mask: the floor's own detail --- */
  stoneStep: 0.35, // metres between the macro-gradient taps
  seamLevel: 0.05, // which contour of the floor's macro field is a mortar course
  seamWidth: 0.075, // metres — the course itself, a real measurement
  seamWeight: 1.0, // 0..1 how much light a seam passes
  seamRelief: 0.55, // 0..1 how much a seam behaves like a slot you look into
  seamGlow: 0.4, // extra light on the lip of a lit seam
  porePitch: 9.0, // cycles per metre — re-synthesised; see the note below
  poreCut: 0.68, // 0..1 how sparse the open pores are
  poreWeight: 0.45, // 0..1 how much light a pore passes
  polishSeal: 0.85, // 0..1 how completely the floor's sheen patches close
  stoneBleed: 0.06, // 0..1 floor on the mask — thin flags are never opaque

  /* --- the seep quad's output --- */
  seepEmissive: 1.5, // multiplier on every glowing term
  seepOpacity: 1.0,
  seepDepthFade: 0.55, // metres of soft fade against standing geometry
  colorSeepDeep: '#14403c', // a strand buried at webDepthMax
  colorSeepShallow: '#6cf0b0', // one just under the surface
  colorSeepPulse: '#c8ffb0', // a nutrient surge
  colorSeepSeam: '#2a6b60', // the lip of a crack catching the light

  /* --- the damp patch at the far end --- */
  dampRadius: 3.1, // metres
  dampHeight: 0.016, // metres above the floor the quad sits at
  dampEdge: 0.6, // metres of feather on the spreading front
  dampRagged: 0.34, // how far that front wanders, as a fraction of the radius
  dampRaggedScale: 0.5, // lobes per metre
  dampWarp: 0.7, // metres of domain warp on those lobes
  dampRelief: 0.3, // how hard the height field tilts the fake normal
  dampAmbient: 0.36,
  dampSpecular: 0.7, // wet stone is shiny stone
  dampGloss: 40,
  dampCell: 0.85, // metres — the puddle scale
  dampLift: 0.03, // metres — ripple height
  dampDepth: 0.1, // metres — how deep the soak reads
  dampFlow: 0.1, // metres/second the wet drifts at
  dampDetail: 0.6,
  dampSpeed: 0.35, // ripple events per second
  dampWindAngle: 0.4, // radians, in the quad's frame
  dampEmissive: 0.5, // multiplier on the glowing terms — kept low; this is water
  dampOpacity: 0.8,
  dampDepthFade: 0.6, // metres of soft fade against standing geometry
  colorDampBase: '#2c3630', // the soaked stone
  colorDampEdge: '#8fb0a4', // the sheen on it
  colorDampGlow: '#5fd0a0', // the tide mark left as it dries
  colorDampDeep: '#0a120e', // the darkest of the soak

  /* --- the spores leaking out of the seams --- */
  sporeRate: 26.0, // per second along the lane
  sporeBirthHeight: 0.03, // metres — they come out of the floor, not above it
  sporeRise: 0.55, // metres/second
  sporeDrag: 1.4, // 1/second
  sporeSag: -0.05, // metres/second² — they barely fall
  sporeSize: 0.045,
  sporeLifetime: 3.4, // seconds
  sporeSpread: 0.45, // launch cone
  sporeSpeedVariance: 0.6,
  sporeTurbulence: 0.5,
  sporeGlow: 2.2,
  puffRate: 1.4, // puffs per metre of front travel
  puffSpores: 7, // spores in one puff
  colorSporeA: '#d8ffd0', // birth
  colorSporeB: '#8fe8b0', // early
  colorSporeC: '#3f8f78', // late
  colorSporeD: '#12241f', // death

  /* --- the vapour off the damp stone --- */
  vapourRate: 12.0, // per second
  vapourBirthHeight: 0.05, // metres
  vapourSize: 0.7,
  vapourSpeed: 0.5, // metres/second
  vapourLifetime: 3.6, // seconds
  vapourRise: 0.22, // metres/second²
  vapourOpacity: 0.2,
  colorVapourA: '#8fa8a0', // birth
  colorVapourB: '#5f7a72', // early
  colorVapourC: '#37453f', // late
  colorVapourD: '#121815', // death

  /* --- the hand, and the two one-shots --- */
  handHeight: 1.15, // metres
  handForward: 0.55, // metres down the heading
  handSide: 0.3, // metres lateral
  muzzleSize: 0.65, // the shell at the hand
  muzzleIntensity: 0.9,
  castFlash: 0.05, // screen flash on release
  colorCastFlash: '#4f9e86',
  burstSize: 2.4, // the shell as the mat knots up
  burstIntensity: 0.8,
  burstSpores: 90, // spores thrown at the knot
  impactShake: 0.14,
  shakeDuration: 0.9, // seconds
  impactFlash: 0.05,
  rumble: 0.02, // travel rumble
  colorBurstA: '#7fd8a8',
  colorBurstB: '#2f6b58',
  colorBurstC: '#c8ffb0',
  colorFlash: '#5fb894',

  /* --- the dynamic light --- */
  lightIntensity: 9.0,
  lightRadius: 8.0, // metres
  lightHeight: 0.14, // metres — low, because the light is coming out of the floor
  lightBreathe: 0.45, // 0..1 depth of the breathe
  lightBreatheRate: 0.4, // hertz
  lightColor: '#4f9e86'
};

/** Editor layout. */
export const myceliumSchema = {
  'The cast': ['range', 'minRange', 'speed', 'cooldown', 'castAnim'],
  'The beats': [
    ['creepTime', 0.1, 8, 0.05, 'creep (s)'],
    ['holdTime', 0.2, 16, 0.1, 'hold (s)'],
    ['rotTime', 0.2, 12, 0.1, 'rot (s)']
  ],
  'The lane': [
    ['laneHalfWidth', 0.2, 8, 0.05, 'half-width (m)'],
    ['laneTaper', 0, 1, 0.01, 'far-end taper'],
    ['laneBack', 0, 4, 0.05, 'reach behind caster (m)'],
    ['laneEdge', 0.02, 3, 0.01, 'front feather (m)'],
    ['laneRagged', 0, 4, 0.01, 'boundary wander (m)'],
    ['laneRaggedScale', 0.05, 3, 0.01, 'lobes / metre'],
    ['laneWarp', 0, 4, 0.01, 'domain warp (m)'],
    ['creepReach', 0, 1, 0.01, 'creep past target (× cast)'],
    ['dieBack', 0, 1, 0.01, 'die-back'],
    ['seepHeight', 0, 0.2, 0.002, 'hover height (m)']
  ],
  'The buried web': [
    ['webCell', 0.05, 3, 0.01, 'hypha spacing (m)'],
    ['webStretch', 0.2, 8, 0.05, 'stretch along lane'],
    ['webJitter', 0, 1, 0.01, 'lattice disorder'],
    ['webCore', 0.002, 0.2, 0.001, 'strand half-width (m)'],
    ['webSpread', 0, 3, 0.01, 'blur per metre of depth'],
    ['webDepthMin', 0, 1, 0.005, 'shallowest (m)'],
    ['webDepthMax', 0.01, 2, 0.005, 'deepest (m)'],
    ['webDepthPitch', 0.02, 2, 0.01, 'depth variation (cycles/m)'],
    ['webAbsorb', 0, 15, 0.05, 'stone absorption (1/m)'],
    ['webParallax', 0, 2, 0.01, 'depth parallax'],
    ['webBranch', 0, 1, 0.01, 'secondary web'],
    ['webBranchScale', 1, 8, 0.05, 'secondary fineness']
  ],
  'The pulses': [
    ['pulseSpacing', 0.2, 12, 0.05, 'crest spacing (m)'],
    ['pulseSpeed', -8, 8, 0.05, 'crest speed (m/s)'],
    ['pulseSharp', 1, 24, 0.5, 'crest sharpness'],
    ['pulseGain', 0, 3, 0.01, 'crest gain']
  ],
  'The stone (the escape mask)': [
    ['stoneStep', 0.05, 2, 0.01, 'gradient tap (m)'],
    ['seamLevel', -0.6, 0.6, 0.005, 'mortar contour'],
    ['seamWidth', 0.005, 0.5, 0.005, 'mortar width (m)'],
    ['seamWeight', 0, 1, 0.01, 'seam transmission'],
    ['seamRelief', 0, 1, 0.01, 'slot occlusion'],
    ['seamGlow', 0, 2, 0.01, 'seam lip glow'],
    ['porePitch', 0.5, 30, 0.1, 'pore pitch (cycles/m)'],
    ['poreCut', 0, 1, 0.01, 'pore sparsity'],
    ['poreWeight', 0, 1, 0.01, 'pore transmission'],
    ['polishSeal', 0, 1, 0.01, 'polish seals'],
    ['stoneBleed', 0, 0.5, 0.005, 'bleed through sound stone']
  ],
  'The seep': [
    ['seepEmissive', 0, 5, 0.01, 'emissive'],
    ['seepOpacity', 0, 1, 0.01, 'opacity'],
    ['seepDepthFade', 0.02, 3, 0.01, 'soft intersection (m)'],
    ['colorSeepDeep', 'deep strand'],
    ['colorSeepShallow', 'shallow strand'],
    ['colorSeepPulse', 'nutrient pulse'],
    ['colorSeepSeam', 'seam lip']
  ],
  'The damp': [
    ['dampRadius', 0.2, 10, 0.05, 'radius (m)'],
    ['dampHeight', 0, 0.2, 0.002, 'hover height (m)'],
    ['dampEdge', 0.02, 3, 0.01, 'front feather (m)'],
    ['dampRagged', 0, 1, 0.01, 'front raggedness'],
    ['dampRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['dampWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['dampRelief', 0, 2, 0.01, 'relief'],
    ['dampAmbient', 0, 1, 0.01, 'ambient'],
    ['dampSpecular', 0, 2, 0.01, 'specular'],
    ['dampGloss', 2, 128, 1, 'gloss'],
    ['dampCell', 0.05, 4, 0.01, 'puddle scale (m)'],
    ['dampLift', 0, 0.5, 0.005, 'ripple height (m)'],
    ['dampDepth', 0, 1, 0.005, 'soak depth (m)'],
    ['dampFlow', 0, 2, 0.01, 'drift (m/s)'],
    ['dampDetail', 0, 1, 0.01, 'detail'],
    ['dampSpeed', 0, 4, 0.01, 'ripple rate'],
    ['dampWindAngle', -3.15, 3.15, 0.01, 'drift bearing'],
    ['dampEmissive', 0, 3, 0.01, 'emissive'],
    ['dampOpacity', 0, 1, 0.01, 'opacity'],
    ['dampDepthFade', 0.02, 3, 0.01, 'soft intersection (m)'],
    ['colorDampBase', 'soaked stone'],
    ['colorDampEdge', 'sheen'],
    ['colorDampGlow', 'tide mark'],
    ['colorDampDeep', 'deepest soak']
  ],
  'The spores': [
    ['sporeRate', 0, 200, 1, 'rate'],
    ['sporeBirthHeight', 0, 1, 0.005, 'birth height (m)'],
    ['sporeRise', 0.02, 4, 0.01, 'rise (m/s)'],
    ['sporeDrag', 0.05, 4, 0.01, 'drag (1/s)'],
    ['sporeSag', -2, 1, 0.01, 'sag (m/s2)'],
    ['sporeSize', 0.005, 0.3, 0.005, 'size'],
    ['sporeLifetime', 0.2, 10, 0.05, 'lifetime (s)'],
    ['sporeSpread', 0, 1, 0.01, 'launch cone'],
    ['sporeSpeedVariance', 0, 1, 0.01, 'speed variance'],
    ['sporeTurbulence', 0, 3, 0.01, 'turbulence'],
    ['sporeGlow', 0, 6, 0.01, 'glow'],
    ['puffRate', 0.05, 6, 0.05, 'puffs / metre'],
    ['puffSpores', 0, 60, 1, 'spores / puff'],
    ['colorSpore*', 'Spore colour']
  ],
  'The vapour': [
    ['vapourRate', 0, 150, 1, 'rate'],
    ['vapourBirthHeight', 0, 1, 0.005, 'birth height (m)'],
    ['vapourSize', 0.05, 4, 0.01, 'size'],
    ['vapourSpeed', 0, 4, 0.01, 'speed (m/s)'],
    ['vapourLifetime', 0.2, 12, 0.05, 'lifetime (s)'],
    ['vapourRise', -1, 2, 0.01, 'rise (m/s2)'],
    ['vapourOpacity', 0, 0.6, 0.005, 'opacity'],
    ['colorVapour*', 'Vapour colour']
  ],
  'Hand & knot': [
    ['handHeight', 0, 3, 0.01, 'hand height (m)'],
    ['handForward', -1, 3, 0.01, 'hand forward (m)'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral (m)'],
    ['muzzleSize', 0.05, 4, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 4, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 1, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour'],
    ['burstSize', 0.2, 10, 0.05, 'knot shell'],
    ['burstIntensity', 0, 4, 0.01, 'shell intensity'],
    ['burstSpores', 0, 400, 1, 'spores at the knot'],
    ['impactShake', 0, 2, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration (s)'],
    ['impactFlash', 0, 1, 0.01, 'screen flash'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['colorBurstA', 'shell'],
    ['colorBurstB', 'shell body'],
    ['colorBurstC', 'shell motes'],
    ['colorFlash', 'knot flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius (m)'],
    ['lightHeight', 0, 3, 0.01, 'light height (m)'],
    ['lightBreathe', 0, 1, 0.01, 'breathe depth'],
    ['lightBreatheRate', 0.05, 4, 0.01, 'breathe rate (Hz)'],
    ['lightColor', 'light colour']
  ]
};
