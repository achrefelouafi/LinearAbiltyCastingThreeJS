/* ================================================================== */
/* GLYPHSTORM — arcane, line cast                                      */
/* ================================================================== */
/**
 * Several hundred instanced quads, each carrying one procedural mark, thrown
 * down the aimed line and settling into a burning hex lattice on the floor.
 *
 * The whole ability is two draw calls — one `Swarm` and one `GroundField` —
 * and the character of it lives in exactly one number.
 *
 * **`billboard`.** At 1 every card is a sprite: it faces the camera whatever
 * it is doing, and the storm is a flat wall of legible symbols that never
 * changes. At 0 every card is a plate in the world: it turns as the formation
 * churns and it vanishes for the part of the turn where it is edge-on, and the
 * storm is a scatter of bright lines with no symbols in it at all. Neither is
 * the effect. It ships at **0.22**, which is where a card keeps its own facing
 * and the storm *flickers* between the two, and that flicker is the ability.
 *
 * The two sliders next to it exist to stop the edge-on half of that flicker
 * disappearing: `edgeStretch` grows a card as it turns so its line never falls
 * under a pixel and aliases into nothing, and `edgeGain` lifts its emission,
 * because a card that collapses without getting brighter reads as a hole in
 * the storm rather than as a mark seen side-on.
 *
 * On the alphabet: `Swarm`'s `CARD` walks up to six strokes between the points
 * of a 3 × 5 lattice, seeded off the agent. `GroundField`'s `RUNE` mode has a
 * genuinely legible sixteen-letterform alphabet, and it is *not* what this
 * wants and it is not exported anyway — `src/vfx/README.md` makes the argument
 * directly: a seal is something you pause and stare at, and a storm is
 * weather. Three hundred cheap marks read as a script you were never taught;
 * three hundred correct ones read as a font specimen.
 */
export const glyphstorm = {
  /* --- the cast --- */
  range: 26.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 21.0, // how fast the storm's lead travels, metres/second
  settleTime: 0.7, // seconds the cards take to come down onto the floor
  lifetime: 1.5, // seconds the lattice holds after they land
  fadeTime: 1.3, // seconds it takes to burn out
  cooldown: 1.1,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the storm comes from and where it goes --- */
  handForward: 0.7, // metres in front of the caster the cards gather
  handSide: 0.3, // metres to the side (+ follows `Ability#side`)
  handHeight: 1.35, // metres above the floor
  flightHeight: 1.5, // metres above the floor at the far end, in flight
  leadRise: 1.1, // metres the lead lofts at mid-span

  /* --- the formation --- */
  cards: 300, // live agents (capped at 384)
  latticeX: 13, // separation cells across
  latticeY: 8, // ... up
  latticeZ: 4, // ... and ranks strung out behind the lead
  spacingSide: 0.46, // metres between lateral cells
  spacingUp: 0.34, // metres between vertical cells
  lag: 0.42, // seconds the back rank trails the lead by
  formJitter: 0.14, // metres of slop off a cell
  churn: 1.15, // radians/second the whole formation rolls
  breathe: 0.22, // fraction the formation swells by
  breatheRate: 1.9, // radians/second
  wander: 0.13, // metres of curl drift — keep under half the spacing
  wanderScale: 0.55, // features per metre
  wanderSpeed: 0.7,
  gatherTight: 0.06, // `gather` at the hand: 0 puts every card on the lead
  gatherStorm: 1.0, // ... and once the storm is open
  gatherRamp: 0.34, // fraction of the flight the storm opens over
  revealRamp: 0.26, // fraction of the flight the cards are written in over
  revealSpread: 0.4, // width of that wave, 0..1

  /* --- the card --- */
  cardSize: 0.36, // metres, nose to tail
  cardAspect: 0.78, // span / length
  cardSizeJitter: 0.35, // ± fraction
  billboard: 0.22, // 0 the card's own frame, 1 camera-facing — THE slider
  edgeStretch: 2.1, // how much an edge-on card grows, ≥ 1
  edgeGain: 3.2, // emission multiplier when it is edge-on
  bank: 0.075, // radians of roll per m/s² of lateral acceleration
  bankMax: 1.5, // radians
  dihedral: 0.18, // fold across the card, fraction of its size
  flapRate: 2.6, // folds/second
  curl: 0.12, // quadratic bend across the chord, fraction of size
  glyphWeight: 0.075, // stroke half-width, in card units
  glyphStrokes: 4, // strokes in the walk, 1..6
  cardFrame: 0.3, // brightness of the card's border
  cardLit: 0.0, // 0 emissive, 1 wrapped diffuse

  /* --- card colour --- */
  tint: 0.25, // where in the gradient the storm sits, 0..1
  tintJitter: 0.3, // ± per-card walk along it
  tintAlong: 0.4, // extra walk from the head of the storm to its tail
  cardOpacity: 1.0,
  cardGlow: 1.5,
  cardSoft: 0.4, // metres of depth feather against solid geometry
  colorCardA: '#fff4de', // the hottest cards, at the head
  colorCardB: '#ffe8c0',
  colorCardC: '#c08a3a',
  colorCardD: '#2a1a0a', // the coldest, trailing

  /* --- the settling --- */
  settleHeight: 0.22, // metres the cards come down to before they go out
  settleSpacing: 0.18, // fraction the vertical spacing collapses to
  settleChurn: 0.12, // fraction the churn collapses to
  settleGather: 1.35, // `gather` opens further as the storm spills outward
  settleDim: 0.9, // fraction of the card opacity given up as they land

  /* --- the lattice burnt into the floor --- */
  burnRadius: 5.2, // metres — the footprint the lattice fills
  burnGrow: 0.85, // seconds the charge takes to cross it
  burnLead: 0.25, // fraction of the settle that passes before it starts
  burnHeight: 0.02, // metres the quad floats above the floor
  burnCell: 0.62, // metres — one hex
  burnCellJitter: 0.7, // 0..1 — how unevenly the front steps cell to cell
  burnSeam: 0.075, // metres — the node at each hex corner
  burnThickness: 0.045, // metres — trace half-width
  burnLift: 0.05, // metres the trace stands proud
  burnDepth: 0.1, // metres the substrate is etched to
  burnSpeed: 1.6, // charge runs per second along the traces
  burnEdge: 0.4, // metres of feather on the growth front
  burnRagged: 0.3, // how far the front wanders, fraction of the radius
  burnRaggedScale: 0.5, // lobes per metre
  burnWarp: 0.45, // metres of domain warp on those lobes
  burnRelief: 0.7, // how hard the trace tilts the fake normal
  burnNormalStep: 0.05, // metres between the height taps
  burnAmbient: 0.28, // floor on the diffuse term
  burnWrap: 0.45, // wraps the terminator round the back, 0..1
  burnSpecular: 0.4,
  burnGloss: 22, // Blinn exponent
  burnParallax: 0.25, // metres of view-driven offset on the etch
  burnEmissive: 1.7, // multiplier on the glowing terms
  burnOpacity: 1.0,
  burnDepthFade: 0.4, // metres of soft fade against standing geometry
  colorBurnBase: '#5a4322', // the trace itself
  colorBurnEdge: '#fff4de', // the nodes
  colorBurnGlow: '#ffb54a', // the charge running along it
  colorBurnDeep: '#2a1a0a', // the etched substrate between traces

  /* --- ink: the motes shed by the storm --- */
  inkRate: 150, // particles/second
  inkSize: 0.055,
  inkSpeed: 1.2,
  inkLifetime: 1.5,
  inkRise: 0.35, // upward drift, metres/second
  inkTurbulence: 0.85,
  colorInkA: '#fff4de',
  colorInkB: '#ffe8c0',
  colorInkC: '#c08a3a',
  colorInkD: '#2a1a0a',

  /* --- sparks: struck off a card as it lands --- */
  sparkRate: 60, // particles/second while the storm is settling
  sparkSize: 0.1,
  sparkSpeed: 5.5,
  sparkLifetime: 0.6,
  sparkGravity: -14.0,
  sparkStretch: 0.2, // how far a spark smears along its velocity
  sparkBurst: 180, // extra sparks thrown as the lattice takes
  colorSparkA: '#ffffff',
  colorSparkB: '#ffe8c0',
  colorSparkC: '#c08a3a',
  colorSparkD: '#3a2510',

  /* --- dynamic light --- */
  lightIntensity: 19,
  lightRadius: 13,
  lightColor: '#ffbf72',
  lightSettle: 0.6, // multiplier once the storm is on the floor

  /* --- the hand, and the landing --- */
  muzzleSize: 0.65, // the knot of light the cards are written out of, metres
  muzzleIntensity: 1.7,
  castFlash: 0.09, // screen flash on release
  colorMuzzleA: '#c08a3a',
  colorMuzzleB: '#ffe8c0',
  colorMuzzleC: '#fff4de',
  colorCastFlash: '#ffe8c0',
  settleFlash: 0.16, // screen flash as the lattice takes
  colorSettleFlash: '#ffd79a',
  settleShake: 0.42,
  settleShakeDuration: 0.55, // seconds that shake decays over
  rumble: 0.022 // continuous shake while the storm is in the air
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Glyphstorm.
 *
 * Reach for `billboard` first and drag it end to end — it is the ability, and
 * everything else in "The card" is there to keep both ends of it legible. Then
 * `latticeX/Y/Z` against `cards`: the product of the three is the number of
 * distinct slots the separation lattice has, and asking for more cards than
 * that is the one way agents start sharing a cell and the formation stops
 * reading as a formation.
 */
export const glyphstormSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 2, 120, 0.5, 'storm speed'],
    ['settleTime', 0.05, 4, 0.01, 'settle time'],
    ['lifetime', 0.05, 8, 0.01, 'lattice hold'],
    ['fadeTime', 0.1, 6, 0.01, 'burn-out time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The flight': [
    ['handForward', -1, 4, 0.01, 'hand forward'],
    ['handSide', -2, 2, 0.01, 'hand lateral'],
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['flightHeight', 0, 8, 0.01, 'height at target'],
    ['leadRise', -3, 6, 0.01, 'mid-span loft']
  ],
  'The formation': [
    ['cards', 1, 384, 1, 'cards'],
    ['latticeX', 1, 24, 1, 'cells across'],
    ['latticeY', 1, 24, 1, 'cells up'],
    ['latticeZ', 1, 32, 1, 'ranks back'],
    ['spacingSide', 0.02, 3, 0.01, 'lateral spacing'],
    ['spacingUp', 0.02, 3, 0.01, 'vertical spacing'],
    ['lag', 0, 3, 0.01, 'rank lag'],
    ['formJitter', 0, 1, 0.005, 'cell slop'],
    ['churn', -6, 6, 0.01, 'formation roll'],
    ['breathe', 0, 1.5, 0.01, 'breathe depth'],
    ['breatheRate', 0, 8, 0.01, 'breathe rate'],
    ['wander', 0, 1, 0.005, 'curl drift'],
    ['wanderScale', 0.05, 4, 0.01, 'drift / metre'],
    ['wanderSpeed', 0, 4, 0.01, 'drift speed'],
    ['gatherTight', 0, 1.5, 0.01, 'gather at hand'],
    ['gatherStorm', 0, 2, 0.01, 'gather in flight'],
    ['gatherRamp', 0.02, 1, 0.01, 'open over'],
    ['revealRamp', 0.02, 1, 0.01, 'write in over'],
    ['revealSpread', 0.02, 1, 0.01, 'write-in wave']
  ],
  'The card': [
    ['cardSize', 0.02, 2, 0.01, 'card size'],
    ['cardAspect', 0.1, 4, 0.01, 'span / length'],
    ['cardSizeJitter', 0, 1.5, 0.01, 'size jitter ±'],
    ['billboard', 0, 1, 0.01, 'camera facing — THE one'],
    ['edgeStretch', 1, 6, 0.01, 'edge-on stretch'],
    ['edgeGain', 0, 10, 0.05, 'edge-on gain'],
    ['bank', 0, 0.5, 0.005, 'bank / lateral g'],
    ['bankMax', 0, 3.2, 0.01, 'bank limit'],
    ['dihedral', 0, 1, 0.01, 'fold'],
    ['flapRate', 0, 12, 0.05, 'fold rate'],
    ['curl', 0, 1, 0.01, 'curl'],
    ['glyphWeight', 0.005, 0.3, 0.005, 'stroke width'],
    ['glyphStrokes', 1, 6, 1, 'strokes / mark'],
    ['cardFrame', 0, 2, 0.01, 'border brightness'],
    ['cardLit', 0, 1, 0.01, 'lit vs emissive']
  ],
  'Card colour': [
    ['tint', 0, 1, 0.01, 'gradient position'],
    ['tintJitter', 0, 1, 0.01, 'per-card walk ±'],
    ['tintAlong', 0, 1, 0.01, 'head-to-tail walk'],
    ['cardOpacity', 0, 2, 0.01, 'opacity'],
    ['cardGlow', 0, 6, 0.01, 'glow'],
    ['cardSoft', 0, 2, 0.01, 'soft intersection'],
    ['colorCard*', 'Card colour']
  ],
  'The settling': [
    ['settleHeight', 0, 3, 0.01, 'settle height'],
    ['settleSpacing', 0, 1, 0.01, 'vertical collapse'],
    ['settleChurn', 0, 1, 0.01, 'roll collapse'],
    ['settleGather', 0, 3, 0.01, 'spill outward'],
    ['settleDim', 0, 1, 0.01, 'cards give up']
  ],
  'The lattice': [
    ['burnRadius', 0.5, 20, 0.1, 'footprint radius'],
    ['burnGrow', 0.05, 5, 0.01, 'charge crossing time'],
    ['burnLead', 0, 1, 0.01, 'starts after'],
    ['burnHeight', 0, 0.3, 0.005, 'float above floor'],
    ['burnCell', 0.05, 3, 0.01, 'hex size'],
    ['burnCellJitter', 0, 2, 0.01, 'front unevenness'],
    ['burnSeam', 0.002, 0.4, 0.002, 'node size'],
    ['burnThickness', 0.002, 0.4, 0.002, 'trace width'],
    ['burnLift', 0, 0.5, 0.005, 'trace height'],
    ['burnDepth', 0, 1, 0.005, 'etch depth'],
    ['burnSpeed', 0, 8, 0.05, 'charge rate'],
    ['burnEdge', 0.02, 3, 0.01, 'front feather'],
    ['burnRagged', 0, 1, 0.01, 'front wander'],
    ['burnRaggedScale', 0.05, 4, 0.01, 'wander / metre'],
    ['burnWarp', 0, 3, 0.01, 'domain warp'],
    ['burnRelief', 0, 3, 0.01, 'relief'],
    ['burnNormalStep', 0.005, 0.4, 0.005, 'normal step'],
    ['burnAmbient', 0, 1, 0.01, 'ambient'],
    ['burnWrap', 0, 1, 0.01, 'terminator wrap'],
    ['burnSpecular', 0, 3, 0.01, 'specular'],
    ['burnGloss', 1, 120, 1, 'gloss'],
    ['burnParallax', 0, 2, 0.01, 'parallax'],
    ['burnEmissive', 0, 6, 0.01, 'emissive'],
    ['burnOpacity', 0, 2, 0.01, 'opacity'],
    ['burnDepthFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorBurnBase', 'trace'],
    ['colorBurnEdge', 'nodes'],
    ['colorBurnGlow', 'charge'],
    ['colorBurnDeep', 'etched substrate']
  ],
  'Ink & sparks': [
    ['inkRate', 0, 800, 1, 'ink rate'],
    ['inkSize', 0.005, 0.4, 0.005, 'ink size'],
    ['inkSpeed', 0, 12, 0.05, 'ink speed'],
    ['inkLifetime', 0.1, 6, 0.05, 'ink lifetime'],
    ['inkRise', -3, 5, 0.01, 'ink rise'],
    ['inkTurbulence', 0, 3, 0.01, 'ink turbulence'],
    ['sparkRate', 0, 600, 1, 'spark rate'],
    ['sparkSize', 0.005, 0.6, 0.005, 'spark size'],
    ['sparkSpeed', 0, 30, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 3, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 2, 0.01, 'spark stretch'],
    ['sparkBurst', 0, 700, 1, 'sparks at the landing'],
    ['colorInk*', 'Ink colour'],
    ['colorSpark*', 'Spark colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightSettle', 0, 3, 0.01, 'settled multiplier'],
    ['lightColor', 'light colour']
  ],
  'Hand & landing': [
    ['muzzleSize', 0.05, 6, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorMuzzleA', 'muzzle shell'],
    ['colorMuzzleB', 'muzzle body'],
    ['colorMuzzleC', 'muzzle arcs'],
    ['colorCastFlash', 'release flash colour'],
    ['settleFlash', 0, 2, 0.01, 'flash on landing'],
    ['colorSettleFlash', 'landing flash colour'],
    ['settleShake', 0, 3, 0.01, 'landing shake'],
    ['settleShakeDuration', 0.05, 3, 0.01, 'shake duration'],
    ['rumble', 0, 0.5, 0.005, 'flight rumble']
  ]
};
