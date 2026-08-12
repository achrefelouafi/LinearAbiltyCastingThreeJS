/* ================================================================== */
/* LOCUSTTIDE — Locust Tide (hive, line cast)                          */
/* ================================================================== */
/**
 * A colony thrown down the aimed line that **forms shapes on its way**: a
 * loose boil out of the hand, closing into a fist, opening into a wall, drawing
 * itself into a spear at the target, and coming apart again.
 *
 * The silhouette is emergent. Nothing in this ability draws a fist — the agents
 * target positions sampled from a signed distance field, and the shape is
 * whatever four hundred insects standing in it add up to.
 *
 * **The three schedule keys are the ability.** `fistAt`, `wallAt` and `spearAt`
 * are fractions of the *cast line*, not seconds, which is deliberate: a
 * fifteen-metre cast and a thirty-metre cast both show all three shapes, and
 * both show them in the same places relative to the caster. `morphCurve`
 * decides whether the swarm holds a shape and then snaps to the next (> 1) or
 * flows continuously between them (≈ 1). Drag any of the three with **P** held
 * mid-cast and the standing cloud re-forms: the shapes are a pure function of
 * where the lead is, and where the lead is is a pure function of live settings.
 *
 * **The size triple morphs with the field.** A fist is compact, a wall is broad
 * and thin, a spear is long and narrow, so each stage carries its own
 * `Width/Height/Depth/Up` and the four are interpolated on *the same* blend
 * fraction the field is. Getting that wrong is very visible: blend the fields
 * but hold the size and the wall arrives as a fist-sized slab, then inflates.
 *
 * **The strip in the floor is derived, not authored.** `_biteAt()` asks how far
 * the bottom of the current shape is off the floor and turns the answer into a
 * contact strength for `vfx/GroundField.js` in `RUT` mode, so the wall — which
 * stands low and broad — scours the ground and the spear, which flies, barely
 * marks it. Every contact sample already lying in the floor is re-derived every
 * frame from its own stored *fraction of the track*, which is why dragging
 * `wallUp` on a paused frame re-carves a gouge that was cut two seconds ago.
 *
 * A cast captures three kinds of thing and no others: one seed, the fraction of
 * the line each contact sample was taken at, and one unitless lateral dice roll
 * per sample. Not a metre among them.
 */
export const locusttide = {
  /* --- the cast --- */
  range: 21.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 14.0, // how fast the colony runs the line, metres/second
  lifetime: 1.0, // seconds the spear holds at the target after it lands
  fadeTime: 1.2, // seconds the last of the cloud takes to go
  cooldown: 1.2, // seconds before the slot re-arms
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the colony leaves the caster --- */
  // The base class puts the cast on the floor because that is what the aim
  // arrow targets; a colony boils out of a hand, so the offsets live here.
  handForward: 0.85, // metres in front of the caster
  handSide: 0.32, // metres to the side (+ follows `Ability#side`)
  handHeight: 1.42, // metres above the floor
  endHeight: 1.05, // metres above the floor where the line ends
  leadRise: 0.9, // metres the lead lofts at mid-span

  /* ------------------------------------------------------------------ */
  /* The colony — vfx/Colony.js `ColonySwarm`, which is a `Swarm`         */
  /* ------------------------------------------------------------------ */
  /**
   * `latticeX × latticeY × latticeZ` is the number of *distinct* cells an agent
   * can claim, and it must stay above `locusts` or two of them share one and
   * the separation guarantee — the only reason this is not a cloud of smoke
   * with wings — quietly stops holding. 12 × 7 × 6 is 504 for 420 agents.
   *
   * Everything here still runs while the colony is condensed: the lattice is
   * what the agents fall back into as the shape lets go of them, and the churn
   * and the wander are what stop a held shape reading as a mesh.
   */
  locusts: 420, // live agents (capped at 640)
  latticeX: 12, // cells across
  latticeY: 7, // cells up
  latticeZ: 6, // ranks strung out behind the lead
  spacingSide: 0.44, // metres between lateral cells
  spacingUp: 0.36, // metres between vertical cells
  lag: 0.3, // seconds the back rank trails the lead by
  jitter: 0.15, // metres of per-agent slop off its own cell
  churn: 0.5, // radians/second the whole formation rolls
  breathe: 0.2, // fraction the formation swells by
  breatheRate: 2.3, // radians/second of that swell
  wander: 0.2, // metres of curl-noise drift — keep under half the spacing
  wanderScale: 0.85, // features per metre of that drift
  wanderSpeed: 0.9, // how fast the drift field moves
  gather: 1.0, // 0 collapses every agent onto the lead's own path

  /* --- one locust --- */
  size: 0.2, // metres, nose to tail
  aspect: 1.3, // wingspan / length — an insect is not a gull
  sizeJitter: 0.38, // ±fraction of size
  sweep: 1.05, // how far the wings rake back
  dihedral: 0.55, // wing fold out of the card's plane, fraction of size
  wingCurl: 0.06, // static camber across the wing, fraction of size
  flapRate: 14.0, // wing-beats/second — each agent runs on its own phase
  bank: 0.045, // radians of roll per m/s² of lateral acceleration
  bankMax: 0.85, // radians — the hard ceiling on that roll
  billboard: 0.1, // 0 the agent's own frame, 1 camera-facing
  edgeStretch: 1.9, // how much an edge-on card grows so it stays a line
  edgeGain: 2.4, // how much brighter it gets while it is edge-on
  lit: 0.55, // 0 pure emissive, 1 wrapped diffuse — chitin is lit, not lit up
  revealTime: 0.18, // seconds the colony takes to appear at the hand
  revealSpread: 0.38, // 0..1 width of that appearance wave

  /* --- the colony's colour --- */
  colorLocustA: '#efe4a6', // birth end: sunlit wing membrane
  colorLocustB: '#b8a44a', // chitin olive
  colorLocustC: '#6b7524', // the sick green of a stripped field
  colorLocustD: '#20200c', // death end: a husk in shadow
  tint: 0.26, // where in that gradient the colony sits
  tintJitter: 0.36, // ±per-agent walk along it
  tintAlong: 0.3, // extra walk from head to tail
  opacity: 1.0,
  glow: 0.85, // emissive gain — deliberately below 1; insects do not glow
  softFade: 0.3, // metres of soft fade where an agent meets geometry

  /* ------------------------------------------------------------------ */
  /* THE TRICK — the shapes, and the schedule that morphs between them   */
  /* ------------------------------------------------------------------ */
  /**
   * Four beats along the line, as fractions of it. They must stay in order —
   * the ability nudges them apart if they are not, rather than dividing by zero
   * — and the interesting drags are the two gaps: a short `fistAt → wallAt` is
   * a swarm snapping open, a long one is a wall being drawn out of a fist.
   */
  closeAt: 0.1, // where the boil begins to close into a shape at all
  fistAt: 0.33, // where it is fully a fist
  wallAt: 0.62, // where it is fully a wall
  spearAt: 0.95, // where it is fully a spear
  morphCurve: 1.4, // >1 holds each shape and then crosses quickly
  condenseMax: 0.94, // how completely the shape wins over the flock, 0..1

  shapeForward: 0.0, // metres the shape sits ahead of the lead
  shapeSide: 0.0, // metres it sits to the side of it
  shapeSpin: 0.35, // radians/second the whole shape turns about world up
  shapeFill: 0.7, // 0 a shell of insects, 1 a packed body
  shapeSteps: 3, // gradient-descent steps onto the field, 1..4
  shapeSlack: 0.85, // fraction of each step taken; < 1 stops concavities ringing
  shapeRough: 0.08, // unitless slop off the isosurface — a crowd, not a membrane

  /**
   * The three silhouettes, each with its own metres.
   *
   * These scale a field that is **not** a unit cube — the fist is a rounded box
   * whose knuckles reach 0.64, the wall is 0.96 tall and 0.16 thick, and the
   * spear's widest point is its 0.21-radius head — so the numbers below are
   * scale factors on those extents rather than half-extents in metres.
   * `LocusttideAbility` carries the six unit constants that convert, which is
   * why `spearWidth: 2.2` is a 46 cm spindle and not a 2.2 m one. Multiply if
   * you want to know how big something really is; drag if you want to find out.
   *
   * The `Up` values are the only ones here measured straight off the floor,
   * because the ground bite reads them and a bite measured from a lofting lead
   * would move every time `leadRise` did.
   */
  fistWidth: 1.55, // scale across  (× 0.72 unit → ~1.1 m half-width)
  fistHeight: 1.5, // scale up      (× 0.64 unit → ~0.96 m half-height)
  fistDepth: 1.45, // scale downrange
  fistUp: 1.7, // metres the fist's centre rides above the floor
  wallWidth: 3.7, // a wall is broad...  (× 0.98 → 3.6 m half-width)
  wallHeight: 2.3, // ...tall...          (× 0.96 → 2.2 m half-height)
  wallDepth: 1.8, // ...and thin          (× 0.16 → 0.29 m half-depth)
  wallUp: 2.15, // metres its centre rides above the floor — its foot is in the dirt
  spearWidth: 2.2, // a spear is narrow...  (× 0.21 → 0.46 m half-width)
  spearHeight: 2.2,
  spearDepth: 3.0, // ...and long, downrange (× ~0.95 → 2.9 m half-length)
  spearUp: 1.95, // metres its centre rides above the floor — it flies, so it barely bites

  /* --- and how it comes apart --- */
  holdTime: 0.35, // seconds the spear holds at the target before it lets go
  disperseTime: 0.7, // seconds the shape takes to release the colony
  disperseSpacing: 1.7, // × the formation opens out to as it scatters
  disperseWander: 1.9, // × the curl drift grows to
  disperseChurn: 1.8, // × the formation roll grows to
  disperseLag: 1.5, // × the rank lag grows to — the tail strings out
  vanishDelay: 0.5, // seconds after the hold before agents start winking out
  vanishTime: 0.9, // seconds the whole colony takes to wink out

  /* ------------------------------------------------------------------ */
  /* The surge — a density wave running down the cast                    */
  /* ------------------------------------------------------------------ */
  // Longitudinal, not a brightness ramp: agents are displaced along the wave
  // axis by a sine of their own position on it, which crowds them at the zero
  // crossings. Small here; it is the whole read of `waspfunnel` and only a
  // texture on the mass in this one.
  waveAmp: 0.22, // metres of longitudinal bunching
  waveLength: 3.2, // metres between crests
  waveSpeed: -7.0, // metres/second the crests travel (negative = back down the line)
  waveAlong: 1.0, // 0 the wave climbs, 1 it runs along the cast

  /* ------------------------------------------------------------------ */
  /* The bite — how the shape's own height decides what the floor takes  */
  /* ------------------------------------------------------------------ */
  biteReach: 2.5, // metres of clearance over which the strip weakens to nothing
  biteGain: 1.2, // multiplier on the resulting contact strength

  /* ------------------------------------------------------------------ */
  /* The stripped track — vfx/GroundField.js, RUT mode                   */
  /* ------------------------------------------------------------------ */
  rutSamples: 14, // contact samples posted along the track (capped at 16)
  rutWidth: 1.6, // half-width of the stripped swathe, metres
  rutDepth: 0.14, // metres the floor is taken down at full contact
  rutSharp: 0.35, // 0..1 how squarely the edge of the swathe falls away
  rutCell: 0.34, // metres between bite marks along the track
  rutBiteDepth: 0.7, // 0..1 how deeply those bite marks show
  rutSpoil: 0.05, // metres of chaff heaped either side
  rutSpoilWidth: 0.22, // metres wide that heap is
  rutSampleBlend: 1.1, // metres over which two contact samples blend together
  rutEdge: 0.3, // metres of feather at the head of the swathe
  rutRagged: 0.34, // how far the edge wanders, as a fraction of the radius
  rutRaggedScale: 0.9, // lobes per metre
  rutWarp: 0.45, // metres of domain warp on those lobes
  rutRelief: 0.7, // how hard the height field tilts the fake normal
  rutNormalStep: 0.05, // metres between the height taps
  rutAmbient: 0.3, // floor on the diffuse term
  rutWrap: 0.45, // 0..1 wraps the terminator round the back
  rutSpecular: 0.22, // stripped ground is matte
  rutGloss: 16, // Blinn exponent
  rutParallax: 0.22, // metres of view-driven offset on the interior detail
  rutEmissive: 0.7, // multiplier on anything glowing in the swathe
  rutOpacity: 0.95,
  rutDepthFade: 0.5, // metres of soft fade against standing geometry
  rutHeight: 0.013, // metres above the floor the quad sits at
  rutHold: 0.6, // seconds the swathe stays at full strength after arrival
  rutFadeTime: 1.7, // seconds it then takes to fade out of the floor
  colorRutBase: '#6c6244', // the stripped ground itself
  colorRutEdge: '#a89b6a', // the torn lip either side
  colorRutGlow: '#c8c05a', // the faint chitin dust left in it
  colorRutDeep: '#221e12', // the shadow in the gouge

  /* ------------------------------------------------------------------ */
  /* Chaff — shredded stubble the tide kicks up                          */
  /* ------------------------------------------------------------------ */
  chaffRate: 190, // particles/second while the colony is travelling
  chaffSize: 0.075, // metres
  chaffSpeed: 3.4, // metres/second off the floor
  chaffSpread: 0.85, // 0..1 cone width
  chaffLifetime: 1.5, // seconds
  chaffGravity: -7.5, // metres/second²
  chaffSpin: 9.0, // radians/second of tumble
  colorChaffA: '#d8cf9e',
  colorChaffB: '#a89a55',
  colorChaffC: '#6b6030',
  colorChaffD: '#2a2612',

  /* --- dust the mass drags off the floor --- */
  dustRate: 46, // particles/second
  dustSize: 0.85, // metres
  dustSpeed: 1.5, // metres/second
  dustLifetime: 2.4, // seconds
  dustRise: 0.5, // metres/second² of buoyancy
  dustOpacity: 0.5,
  dustTurbulence: 0.55,
  colorDustA: '#b6ad8c',
  colorDustB: '#8d8567',
  colorDustC: '#5c5742',
  colorDustD: '#2a2820',

  /* --- glints: sunlight caught on a wing, one agent at a time --- */
  glintRate: 130, // particles/second
  glintSize: 0.055, // metres
  glintSpeed: 1.1, // metres/second
  glintLifetime: 0.5, // seconds — a flash, not a mote
  glintRise: 0.3, // metres/second² of buoyancy
  glintTurbulence: 0.7,
  glintGlow: 1.6, // emissive gain on the flash
  colorGlintA: '#fff6d2',
  colorGlintB: '#e6d484',
  colorGlintC: '#9aa03c',
  colorGlintD: '#33380f',

  /* ------------------------------------------------------------------ */
  /* The cast and the landing                                            */
  /* ------------------------------------------------------------------ */
  muzzleSize: 1.0, // metres the boil at the hand reaches
  muzzleIntensity: 0.8,
  castFlash: 0.16, // screen flash as the colony leaves the hand
  castGlints: 40, // glints thrown at the hand
  colorMuzzleA: '#d9cf8e',
  colorMuzzleB: '#8f8c3a',
  colorMuzzleC: '#4a5417',
  colorCastFlash: '#c8c67a',

  burstSize: 2.6, // metres the landing dust ball reaches
  burstIntensity: 1.0,
  burstChaff: 150, // chaff thrown out by the landing
  burstGlints: 120, // glints thrown out by the landing
  shockRadius: 3.4, // metres the ground ring reaches
  impactShake: 0.42,
  shakeDuration: 0.5, // seconds the landing shake decays over
  impactFlash: 0.2,
  rumble: 0.03, // continuous shake while the tide is travelling
  colorBurstA: '#cbc48c', // dust-ball shell
  colorBurstB: '#8d8b3e', // its body
  colorBurstC: '#4b5418', // its filaments
  colorShockA: '#ded39a', // the ground ring's leading edge
  colorShockB: '#6a6a28', // and its trail
  colorFlash: '#cdc684', // the landing's screen flash

  /* --- the dynamic light --- */
  lightColor: '#c9c46a', // a sickly sunlit green-gold
  lightIntensity: 1.5,
  lightRadius: 11.0, // metres
  lightFlicker: 0.16, // 0..1 depth of the wingbeat shimmer on the light
  lightFlickerSpeed: 21.0 // shimmer steps/second
};

/** Editor layout. The three schedule folders come first because they are the ability. */
export const locusttideSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 60, 0.5, 'colony speed'],
    ['lifetime', 0.1, 4, 0.01, 'hold at target'],
    ['fadeTime', 0.05, 4, 0.01, 'fade time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where it leaves the hand': [
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['endHeight', 0, 5, 0.01, 'height at target'],
    ['leadRise', -2, 8, 0.05, 'mid-span loft']
  ],
  'The shapes/Schedule': [
    ['closeAt', 0, 1, 0.01, 'starts closing at'],
    ['fistAt', 0, 1, 0.01, 'fist at'],
    ['wallAt', 0, 1, 0.01, 'wall at'],
    ['spearAt', 0, 1, 0.01, 'spear at'],
    ['morphCurve', 0.2, 4, 0.01, 'morph curve'],
    ['condenseMax', 0, 1, 0.01, 'shape vs flock']
  ],
  'The shapes/Fist': [
    ['fistWidth', 0.1, 6, 0.01, 'half-width (m)'],
    ['fistHeight', 0.1, 6, 0.01, 'half-height (m)'],
    ['fistDepth', 0.1, 6, 0.01, 'half-depth (m)'],
    ['fistUp', 0, 8, 0.01, 'centre height (m)']
  ],
  'The shapes/Wall': [
    ['wallWidth', 0.1, 10, 0.01, 'half-width (m)'],
    ['wallHeight', 0.1, 8, 0.01, 'half-height (m)'],
    ['wallDepth', 0.05, 6, 0.01, 'half-depth (m)'],
    ['wallUp', 0, 8, 0.01, 'centre height (m)']
  ],
  'The shapes/Spear': [
    ['spearWidth', 0.05, 4, 0.01, 'half-width (m)'],
    ['spearHeight', 0.05, 4, 0.01, 'half-height (m)'],
    ['spearDepth', 0.2, 10, 0.01, 'half-depth (m)'],
    ['spearUp', 0, 8, 0.01, 'centre height (m)']
  ],
  'The shapes/How they are drawn': [
    ['shapeForward', -4, 6, 0.01, 'ahead of the lead (m)'],
    ['shapeSide', -4, 4, 0.01, 'off the lead (m)'],
    ['shapeSpin', -4, 4, 0.01, 'shape spin (rad/s)'],
    ['shapeFill', 0, 1, 0.01, 'shell → solid'],
    ['shapeSteps', 1, 4, 1, 'descent steps'],
    ['shapeSlack', 0.05, 1, 0.01, 'step relaxation'],
    ['shapeRough', 0, 0.5, 0.005, 'crowd slop']
  ],
  'The shapes/Coming apart': [
    ['holdTime', 0, 3, 0.01, 'hold at target (s)'],
    ['disperseTime', 0.05, 4, 0.01, 'disperse time (s)'],
    ['disperseSpacing', 1, 5, 0.01, 'spacing ×'],
    ['disperseWander', 1, 6, 0.01, 'drift ×'],
    ['disperseChurn', 1, 6, 0.01, 'roll ×'],
    ['disperseLag', 1, 5, 0.01, 'rank lag ×'],
    ['vanishDelay', 0, 3, 0.01, 'vanish delay (s)'],
    ['vanishTime', 0.05, 4, 0.01, 'vanish time (s)']
  ],
  'The formation': [
    ['locusts', 1, 640, 1, 'locusts'],
    ['latticeX', 1, 20, 1, 'cells across'],
    ['latticeY', 1, 14, 1, 'cells up'],
    ['latticeZ', 1, 24, 1, 'ranks back'],
    ['spacingSide', 0.02, 3, 0.01, 'lateral spacing'],
    ['spacingUp', 0.02, 3, 0.01, 'vertical spacing'],
    ['lag', 0, 2.5, 0.01, 'rank lag'],
    ['jitter', 0, 1.5, 0.01, 'cell slop'],
    ['churn', -6, 6, 0.01, 'formation roll'],
    ['breathe', 0, 1.5, 0.01, 'swell'],
    ['breatheRate', 0, 8, 0.05, 'swell rate'],
    ['wander', 0, 1.5, 0.01, 'curl drift'],
    ['wanderScale', 0.05, 3, 0.01, 'drift features / m'],
    ['wanderSpeed', 0, 4, 0.01, 'drift speed'],
    ['gather', 0, 1, 0.01, 'collapse onto lead']
  ],
  'The surge': [
    ['waveAmp', 0, 2, 0.01, 'bunching (m)'],
    ['waveLength', 0.2, 12, 0.05, 'crest spacing (m)'],
    ['waveSpeed', -20, 20, 0.1, 'crest speed (m/s)'],
    ['waveAlong', 0, 1, 0.01, 'climbs → runs down']
  ],
  'One locust': [
    ['size', 0.02, 1, 0.005, 'size'],
    ['aspect', 0.3, 4, 0.01, 'span / length'],
    ['sizeJitter', 0, 1, 0.01, 'size jitter'],
    ['sweep', 0, 2, 0.01, 'wing rake'],
    ['dihedral', 0, 1.5, 0.01, 'wing fold'],
    ['wingCurl', -1, 1, 0.01, 'wing camber'],
    ['flapRate', 0, 40, 0.5, 'wing-beats / sec'],
    ['bank', 0, 0.5, 0.001, 'bank per m/s²'],
    ['bankMax', 0, 2, 0.01, 'max bank'],
    ['billboard', 0, 1, 0.01, 'camera facing'],
    ['edgeStretch', 1, 5, 0.01, 'edge-on stretch'],
    ['edgeGain', 0, 6, 0.01, 'edge-on gain'],
    ['lit', 0, 1, 0.01, 'diffuse mix'],
    ['revealTime', 0.01, 2, 0.01, 'gather time'],
    ['revealSpread', 0.01, 1, 0.01, 'gather spread']
  ],
  'Colony colour': [
    ['colorLocust*', 'Locust gradient'],
    ['tint', 0, 1, 0.01, 'gradient position'],
    ['tintJitter', 0, 1, 0.01, 'per-agent walk'],
    ['tintAlong', 0, 1, 0.01, 'head-to-tail walk'],
    ['opacity', 0, 2, 0.01, 'opacity'],
    ['glow', 0, 4, 0.01, 'glow'],
    ['softFade', 0.02, 2, 0.01, 'soft intersection']
  ],
  'The stripped track': [
    ['biteReach', 0.1, 8, 0.01, 'bite reach (m)'],
    ['biteGain', 0, 3, 0.01, 'bite gain'],
    ['rutSamples', 1, 16, 1, 'contact samples'],
    ['rutWidth', 0.05, 5, 0.01, 'half-width (m)'],
    ['rutDepth', 0, 1.5, 0.01, 'depth (m)'],
    ['rutSharp', 0, 1, 0.01, 'edge sharpness'],
    ['rutCell', 0.05, 2, 0.01, 'bite pitch (m)'],
    ['rutBiteDepth', 0, 1, 0.01, 'bite depth'],
    ['rutSpoil', 0, 0.6, 0.005, 'chaff heap (m)'],
    ['rutSpoilWidth', 0, 1, 0.005, 'heap width (m)'],
    ['rutSampleBlend', 0.05, 4, 0.01, 'sample blend (m)'],
    ['rutEdge', 0.02, 2, 0.01, 'head feather (m)'],
    ['rutRagged', 0, 1, 0.01, 'edge wander'],
    ['rutRaggedScale', 0.05, 4, 0.01, 'lobes / m'],
    ['rutWarp', 0, 2, 0.01, 'domain warp (m)'],
    ['rutRelief', 0, 2, 0.01, 'relief'],
    ['rutNormalStep', 0.01, 0.4, 0.005, 'normal step (m)'],
    ['rutAmbient', 0, 1, 0.01, 'ambient'],
    ['rutWrap', 0, 1, 0.01, 'terminator wrap'],
    ['rutSpecular', 0, 2, 0.01, 'specular'],
    ['rutGloss', 1, 80, 1, 'gloss'],
    ['rutParallax', 0, 1, 0.01, 'parallax (m)'],
    ['rutEmissive', 0, 3, 0.01, 'emissive'],
    ['rutOpacity', 0, 1, 0.01, 'opacity'],
    ['rutDepthFade', 0.02, 2, 0.01, 'soft intersection'],
    ['rutHeight', 0.002, 0.1, 0.001, 'height off floor (m)'],
    ['rutHold', 0, 4, 0.01, 'hold (s)'],
    ['rutFadeTime', 0.1, 6, 0.01, 'fade (s)'],
    ['colorRutBase', 'stripped ground'],
    ['colorRutEdge', 'torn lip'],
    ['colorRutGlow', 'chitin dust'],
    ['colorRutDeep', 'gouge shadow']
  ],
  'Chaff': [
    ['chaffRate', 0, 800, 1, 'chaff rate'],
    ['chaffSize', 0.005, 0.5, 0.005, 'chaff size'],
    ['chaffSpeed', 0, 20, 0.05, 'chaff speed'],
    ['chaffSpread', 0, 1, 0.01, 'chaff spread'],
    ['chaffLifetime', 0.1, 6, 0.05, 'chaff lifetime'],
    ['chaffGravity', -30, 5, 0.1, 'chaff gravity'],
    ['chaffSpin', 0, 30, 0.1, 'chaff tumble'],
    ['colorChaff*', 'Chaff colour']
  ],
  'Dust': [
    ['dustRate', 0, 400, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 10, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustTurbulence', 0, 4, 0.01, 'dust turbulence'],
    ['colorDust*', 'Dust colour']
  ],
  'Wing glints': [
    ['glintRate', 0, 800, 1, 'glint rate'],
    ['glintSize', 0.005, 0.4, 0.005, 'glint size'],
    ['glintSpeed', 0, 10, 0.05, 'glint speed'],
    ['glintLifetime', 0.05, 3, 0.01, 'glint lifetime'],
    ['glintRise', -2, 4, 0.01, 'glint rise'],
    ['glintTurbulence', 0, 4, 0.01, 'glint turbulence'],
    ['glintGlow', 0, 6, 0.01, 'glint glow'],
    ['colorGlint*', 'Glint colour']
  ],
  'Release & landing': [
    ['muzzleSize', 0.05, 4, 0.05, 'hand boil size'],
    ['muzzleIntensity', 0, 5, 0.01, 'hand boil intensity'],
    ['castFlash', 0, 2, 0.01, 'release flash'],
    ['castGlints', 0, 400, 1, 'release glints'],
    ['colorMuzzleA', 'hand boil shell'],
    ['colorMuzzleB', 'hand boil body'],
    ['colorMuzzleC', 'hand boil filaments'],
    ['colorCastFlash', 'release flash colour'],
    ['burstSize', 0.05, 8, 0.05, 'landing dust size'],
    ['burstIntensity', 0, 5, 0.01, 'landing dust intensity'],
    ['burstChaff', 0, 600, 1, 'landing chaff'],
    ['burstGlints', 0, 600, 1, 'landing glints'],
    ['shockRadius', 0.2, 12, 0.05, 'ground ring (m)'],
    ['impactShake', 0, 3, 0.01, 'landing shake'],
    ['shakeDuration', 0.05, 2, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'landing flash'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['colorBurstA', 'dust-ball shell'],
    ['colorBurstB', 'dust-ball body'],
    ['colorBurstC', 'dust-ball filaments'],
    ['colorShockA', 'ring edge'],
    ['colorShockB', 'ring trail'],
    ['colorFlash', 'landing flash colour']
  ],
  'The light': [
    ['lightColor', 'light colour'],
    ['lightIntensity', 0, 8, 0.01, 'intensity'],
    ['lightRadius', 1, 40, 0.5, 'radius (m)'],
    ['lightFlicker', 0, 1, 0.01, 'wingbeat shimmer'],
    ['lightFlickerSpeed', 1, 60, 0.5, 'shimmer speed']
  ]
};
