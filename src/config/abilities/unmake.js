/* ================================================================== */
/* UNMAKE — Unmake                                                     */
/* ================================================================== */
/**
 * A lane of the room's own substance is heaved out of the floor and then
 * **stops existing**, cube by cube, in pieces that get bigger as it goes.
 *
 * The block divides in two and the seam between them is the whole ability.
 * Everything under *the lane* builds matter — a run of near-cubic ashlar blocks
 * on a `GrowthField`, a trench on a `GroundField`, a stone material with a
 * lattice printed on it. Everything under *the unmaking* takes it away, through
 * the `VOXEL` half of `vfx/Dissolve.js`, and the numbers that matter there are
 * only three:
 *
 *  - **`cellSize`** — the *finest* cube, measured in a block's own units, where
 *    a block is exactly 1 unit on a side. 0.2 means five cubes across a block
 *    on the first rung.
 *  - **`rungs`** — how many doublings the ladder walks. Five means the last
 *    cubes are **sixteen times** the first, and that ratio is the acceleration
 *    the roster line asks for. Turn it down to 1 and the ability becomes a
 *    uniform crumble, which is a perfectly good effect and a completely
 *    different sentence.
 *  - **`take`** — how much of what is left each rung claims before handing on.
 *    Low values leave more material for the coarse rungs, so the loss is
 *    back-loaded and the acceleration is steeper.
 *
 * **Why the blocks are cubes and not slabs.** The voxel lattice is *object
 * space* — it has to be, because the displacement it produces is added to
 * `transformed` — so an instance scaled 1 : 3 is partitioned into cuboids of
 * the same 1 : 3, and you get dominoes. `GrowthField` scales an instance
 * `(radius, height, radius)`, so `blockNear` / `blockFar` feed *both* axes from
 * one number and `blockJitter` is deliberately small. This ability is called
 * Unmake, not Unbrick.
 *
 * **Why `blockSegments` is a real control and not a quality setting.** A cell
 * with no vertex in it cannot become a cube. At `cellSize` 0.2 a block is five
 * cells across, so twelve segments puts roughly two and a half vertices along
 * each cell edge — enough for a chunk to hold a face. Drop the segments and the
 * lattice starts claiming whole blocks at a time; raise `cellSize` past
 * `1 / blockSegments × 3` and you will see the same thing.
 *
 * **The erosion half of the patch ships switched off.** `erode` is 0 on
 * purpose: this is the cube slot, and a burning threshold edge crossing the
 * blocks at the same time reads as two abilities in a coat. The controls are
 * here because turning `erode` up is the fastest way to see what the other half
 * of `Dissolve.js` does.
 */
export const unmake = {
  /* --- the cast --- */
  range: 21.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 34.0, // how fast the heave front runs the line, metres/second
  standTime: 0.5, // seconds the lane stands whole before it starts to go
  unmakeTime: 1.15, // seconds the dissolve takes to run 0 → 1
  settleTime: 0.55, // seconds after that for the last motes to clear
  cooldown: 1.1, // seconds before it can be cast again
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the lane on the floor --- */
  blockCount: 68, // blocks this cast (hard ceiling 160)
  clusterShare: 0.18, // 0..1 of them held back for the pile at the far end
  clusterRadius: 1.7, // metres that pile reaches, < 0 derives from the band
  widthNear: 0.5, // metres, half-width of the lane at the caster
  width: 1.8, // metres, at the far end
  widthCurve: 1.15, // >1 keeps the lane narrow, then opens it late
  frontBias: 0.95, // <1 crowds the blocks toward the far end
  clumping: 1.15, // >1 pulls them onto the centre line
  scatter: 0.45, // extra lateral jitter, fraction of the local half-width

  /* --- one block --- */
  // `blockNear`/`blockFar` drive footprint *and* height from one number. See
  // the header: the lattice is object space and a non-cubic instance gives
  // non-cubic chunks.
  blockNear: 0.62, // metres — cube side at the caster
  blockFar: 1.02, // metres — cube side at the far end
  blockCurve: 1.05, // how late the size ramp climbs
  blockJitter: 0.18, // ± fraction. Kept small on purpose — see the header.
  crown: 0.35, // 0..1 how much smaller a flank block is than the spine
  crownPower: 1.5, // how sharply that dome falls off
  peak: 1.15, // extra size multiplier at the far end
  peakWidth: 0.22, // 0..1 of the cast that swell covers
  rubble: 0.24, // 0..1 chance a block is demoted to broken masonry
  rubbleScale: 0.42, // size multiplier for those
  rubbleSpread: 1.15, // footprint multiplier for those
  minBlock: 0.06, // metres, floor

  /* --- the block's silhouette (rebuilds the geometry when they move) --- */
  blockSegments: 12, // subdivisions per cube edge — read the header before moving
  blockRound: 0.22, // 0 a hard cube, 1 a sphere. The chamfer on a quarried stone.
  blockChip: 0.3, // 0..1 how far the corners are knocked off
  blockChipScale: 3.2, // chip features per unit — how coarse the damage is

  /* --- how they sit --- */
  lean: 0.12, // radians off vertical
  leanJitter: 0.6, // ± fraction
  leanRamp: 0.5, // 0 leans everything equally, 1 only the far end
  leanForward: 0.5, // weight of "away from the caster" in the lean direction
  leanOutward: 0.7, // weight of "out across the lane"
  twist: 1.0, // 0..1 of a full turn of random yaw
  tilt: 0.1, // radians of extra random tip, any bearing

  /* --- the heave --- */
  riseTime: 0.14, // seconds from buried to standing
  riseStagger: 0.1, // seconds of random delay between neighbours
  riseOvershoot: 0.3, // how far past full height the punch carries
  settle: 0.4, // seconds that overshoot damps out over
  springRate: 18.0, // radians/second of the overshoot ring
  emergeSink: 0.95, // fraction of its size a block is buried at emerge = 0
  birthScale: 0.78, // footprint scale at the moment it breaks through
  birthFade: 0.22, // seconds the birth flash decays over
  breachAt: 0.2, // emergence fraction that fires the breach event

  /* --- the unmaking: the VOXEL ladder --- */
  cellSize: 0.2, // the FINEST cube, in block-local units (a block is 1 unit)
  rungs: 5, // doublings; 5 means the last cubes are 16× the first
  take: 0.5, // fraction of cells a rung claims before handing on
  span: 0.26, // progress units one cell takes to let go
  blockiness: 0.85, // 0..1 how hard a chunk snaps to the lattice. 0 is a shatter.
  facet: 0.5, // sub-lattice size, as a fraction of the cell
  hold: 0.4, // 0..1 of a chunk's life before it starts shrinking away
  drift: 1.05, // metres a chunk travels
  driftUp: 0.42, // unitless upward preference in the block's own frame
  lift: 0.38, // metres up, linear in the chunk's life
  gravity: 0.5, // metres of fall, on life squared
  tumble: 2.1, // radians a chunk turns before it goes
  wobble: 0.07, // metres of hashed wander
  wobbleRate: 5.0, // radians/second of that wander
  colorEmber: '#b98cff', // a chunk lighting up as it lets go
  unmakeGlow: 1.35, // multiplier on the ember and the erosion edge

  /* --- the erosion half, shipped switched off. See the header. --- */
  erode: 0, // 0..1 — how much of the threshold behaviour is on
  noiseScale: 3.2, // features per block unit
  warp: 0.4, // domain warp — the ragged re-entrant edge
  edgeWidth: 0.1, // width of the burning band, noise units
  colorEdge: '#cfa8ff', // that band

  /* --- the matter --- */
  colorStone: '#191521', // the block itself
  colorSeam: '#7d4fd6', // the lattice printed along the cell boundaries
  colorBirth: '#c7a4ff', // the flash as a block breaks the surface
  stoneRoughness: 0.85,
  stoneMetalness: 0.06, // just enough for the key light to find an edge
  seamWidth: 0.06, // fraction of a cell — half-width of a printed seam
  seamGlow: 0.85, // brightness of the seams before the ceiling
  seamCeiling: 0.8, // hard asymptote, linear HDR — keep below post.bloomThreshold
  seamFade: 0.7, // 0..1 how far the seams dim once their cube is moving
  grain: 0.35, // 0..1 how far world-space grain eats the seams
  grainScale: 5.5, // grain features per metre
  birthFlash: 1.1, // extra seam brightness on a block that has just arrived

  /* --- the trench the matter came out of --- */
  trenchWidth: 1.7, // metres, half-width of the track
  trenchDepth: 0.55, // how deep the gouge reads, unitless
  trenchLift: 0.06, // metres of spoil thrown up along its lips
  trenchThickness: 0.05, // metres of lip
  trenchEdge: 0.5, // metres of feather on the track's edges
  trenchRagged: 0.34, // how far the edge wanders, fraction of the radius
  trenchRaggedScale: 0.6, // lobes per metre
  trenchWarp: 0.5, // metres of domain warp on those lobes
  trenchSharp: 0.45, // 0..1 how hard the gouge's own edge is
  trenchDetail: 0.5, // 0..1 interior detail
  trenchRelief: 0.75, // how hard the fake normal sculpts it
  trenchAmbient: 0.3, // floor on its diffuse term
  trenchOpacity: 0.9,
  trenchEmissive: 0.5, // multiplier on the one glowing term
  trenchMarkLife: 6.0, // seconds a breach deepening lasts
  trenchHeight: 0.016, // metres above the floor the quad sits at
  colorTrench: '#221d2c', // the gouged stone
  colorTrenchDeep: '#08060c', // the bottom of it
  colorTrenchEdge: '#5a4a72', // the lip
  colorTrenchGlow: '#8a5fe0', // the line the heave front draws as it passes

  /* --- chips: the cubes too small to be geometry --- */
  // `chipSize` is a *base*: the emitter scales it by the ladder's current rung,
  // so the chips coming off get bigger at exactly the same moments the
  // geometry's cubes do. That agreement is most of why the acceleration reads.
  chipRate: 150, // chips per second at full dissolve rate
  chipSize: 0.045, // metres at rung 0
  chipRungGain: 0.55, // 0..1 how much of the ladder's growth the chips inherit
  chipSpeed: 2.4,
  chipLifetime: 1.15,
  chipGravity: -9.0,
  breachChips: 6, // chips one block throws as it breaks the surface
  colorChipA: '#8d6fd0',
  colorChipB: '#4b3a72',
  colorChipC: '#241d33',
  colorChipD: '#0e0b16',

  /* --- gloom: what is left where the matter was --- */
  gloomRate: 34, // particles/second
  gloomSize: 1.05,
  gloomSpeed: 0.55,
  gloomLifetime: 2.1,
  gloomOpacity: 0.28,
  gloomRise: 0.3, // upward drift, metres/second
  colorGloomA: '#231b31',
  colorGloomB: '#171126',
  colorGloomC: '#0d0917',
  colorGloomD: '#05040a',

  /* --- motes: the flare of a cube that stops existing --- */
  moteRate: 90, // particles/second at full dissolve rate
  moteSize: 0.075,
  moteSpeed: 1.5,
  moteLifetime: 0.85,
  moteRise: 0.9, // upward drift, metres/second
  moteTurbulence: 0.7,
  colorMoteA: '#e2ccff',
  colorMoteB: '#a778f0',
  colorMoteC: '#5c3aa8',
  colorMoteD: '#1a1030',

  /* --- dynamic light --- */
  lightIntensity: 5.5,
  lightRadius: 9.0,
  lightColor: '#6a3fc0',

  /* --- the beats you feel --- */
  heaveShake: 0.4, // knock as the front lands
  shakeDuration: 0.5,
  rumble: 0.025, // continuous shake while the front travels
  unmakeRumble: 0.045, // continuous shake while the lane is coming apart
  impactChips: 60 // chips thrown where the front lands
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Unmake.
 *
 * Open **The unmaking** first and drag `rungs` from 1 to 6 with the clock
 * stopped mid-dissolve. That is the ability: at 1 every chunk is `cellSize`
 * across and the lane crumbles evenly; at 6 the last of it leaves in pieces
 * sixty-four times the size of the first, and the eye reads the difference as
 * speed rather than as scale.
 *
 * `cellSize` and `blockSegments` are a pair — see the block header before you
 * move either on its own.
 */
export const unmakeSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 4, 200, 0.5, 'front speed'],
    ['standTime', 0.05, 4, 0.05, 'stand time'],
    ['unmakeTime', 0.1, 6, 0.05, 'unmake time'],
    ['settleTime', 0.05, 4, 0.05, 'settle time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The unmaking': [
    ['cellSize', 0.04, 0.6, 0.005, 'finest cube (block units)'],
    ['rungs', 1, 6, 1, 'doublings'],
    ['take', 0.05, 0.95, 0.01, 'claimed per rung'],
    ['span', 0.02, 1, 0.01, 'time to let go'],
    ['blockiness', 0, 1, 0.01, 'snap to the lattice'],
    ['facet', 0.1, 1, 0.05, 'sub-lattice'],
    ['hold', 0, 0.98, 0.01, 'hold before shrink'],
    ['drift', 0, 6, 0.01, 'drift (m)'],
    ['driftUp', -1, 2, 0.01, 'upward bias'],
    ['lift', -2, 4, 0.01, 'lift (m)'],
    ['gravity', 0, 8, 0.01, 'fall (m)'],
    ['tumble', 0, 9, 0.01, 'tumble (rad)'],
    ['wobble', 0, 0.5, 0.005, 'wander (m)'],
    ['wobbleRate', 0, 20, 0.1, 'wander rate'],
    ['unmakeGlow', 0, 4, 0.01, 'ember glow'],
    ['colorEmber', 'ember']
  ],
  'The unmaking/Erosion (off by default)': [
    ['erode', 0, 1, 0.01, 'erosion on'],
    ['noiseScale', 0.2, 12, 0.05, 'features / unit'],
    ['warp', 0, 2, 0.01, 'domain warp'],
    ['edgeWidth', 0.01, 0.5, 0.005, 'burn width'],
    ['colorEdge', 'burning edge']
  ],
  'The lane': [
    ['blockCount', 4, 160, 1, 'blocks'],
    ['clusterShare', 0, 0.6, 0.01, 'far pile share'],
    ['clusterRadius', -1, 6, 0.05, 'far pile radius'],
    ['widthNear', 0, 4, 0.01, 'lane half-width, near'],
    ['width', 0.05, 8, 0.01, 'lane half-width, far'],
    ['widthCurve', 0.2, 4, 0.01, 'lane curve'],
    ['frontBias', 0.2, 3, 0.01, 'crowd toward target'],
    ['clumping', 0.2, 4, 0.01, 'clumping'],
    ['scatter', 0, 2, 0.01, 'lateral scatter']
  ],
  'One block': [
    ['blockNear', 0.05, 3, 0.01, 'cube side, near (m)'],
    ['blockFar', 0.05, 4, 0.01, 'cube side, far (m)'],
    ['blockCurve', 0.2, 4, 0.01, 'size curve'],
    ['blockJitter', 0, 0.6, 0.01, 'size jitter'],
    ['crown', 0, 1, 0.01, 'flank shrinking'],
    ['crownPower', 0.2, 4, 0.01, 'crown falloff'],
    ['peak', 0.2, 3, 0.01, 'swell at target'],
    ['peakWidth', 0.02, 1, 0.01, 'swell width'],
    ['rubble', 0, 1, 0.01, 'broken chance'],
    ['rubbleScale', 0.05, 1, 0.01, 'broken size'],
    ['rubbleSpread', 0.5, 3, 0.01, 'broken spread'],
    ['minBlock', 0.01, 1, 0.01, 'minimum side'],
    ['blockSegments', 4, 18, 1, 'segments / edge'],
    ['blockRound', 0, 1, 0.01, 'corner rounding'],
    ['blockChip', 0, 1, 0.01, 'corner damage'],
    ['blockChipScale', 0.5, 10, 0.1, 'damage / unit']
  ],
  'How they sit': [
    ['lean', -1.5, 1.5, 0.01, 'lean (rad)'],
    ['leanJitter', 0, 1, 0.01, 'lean jitter'],
    ['leanRamp', 0, 1, 0.01, 'lean ramp'],
    ['leanForward', -2, 2, 0.01, 'lean downrange'],
    ['leanOutward', -2, 2, 0.01, 'lean outward'],
    ['twist', 0, 1, 0.01, 'random yaw'],
    ['tilt', 0, 1.5, 0.01, 'random tip (rad)']
  ],
  'The heave': [
    ['riseTime', 0.02, 1.5, 0.01, 'rise time'],
    ['riseStagger', 0, 1.5, 0.01, 'neighbour stagger'],
    ['riseOvershoot', 0, 1, 0.01, 'overshoot'],
    ['settle', 0.05, 2, 0.01, 'settle'],
    ['springRate', 1, 50, 0.5, 'spring rate'],
    ['emergeSink', 0, 1.5, 0.01, 'buried depth'],
    ['birthScale', 0.1, 1, 0.01, 'breakthrough scale'],
    ['birthFade', 0.02, 2, 0.01, 'birth decay'],
    ['breachAt', 0.02, 1, 0.01, 'breach point']
  ],
  'The matter': [
    ['stoneRoughness', 0.05, 1, 0.01, 'roughness'],
    ['stoneMetalness', 0, 1, 0.01, 'metalness'],
    ['seamWidth', 0.005, 0.3, 0.005, 'seam half-width'],
    ['seamGlow', 0, 4, 0.01, 'seam glow'],
    ['seamCeiling', 0.05, 1.2, 0.01, 'seam ceiling (bloom guard)'],
    ['seamFade', 0, 1, 0.01, 'seam dimming'],
    ['grain', 0, 1, 0.01, 'seam erosion'],
    ['grainScale', 0.5, 30, 0.1, 'grain / metre'],
    ['birthFlash', 0, 4, 0.01, 'birth flash'],
    ['colorStone', 'stone'],
    ['colorSeam', 'seam'],
    ['colorBirth', 'birth flash']
  ],
  'The trench': [
    ['trenchWidth', 0.1, 8, 0.05, 'half-width'],
    ['trenchDepth', 0, 2, 0.01, 'depth'],
    ['trenchLift', 0, 1, 0.01, 'spoil lip (m)'],
    ['trenchThickness', 0, 0.5, 0.005, 'lip thickness (m)'],
    ['trenchEdge', 0.05, 3, 0.01, 'feather'],
    ['trenchRagged', 0, 1.5, 0.01, 'edge wander'],
    ['trenchRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['trenchWarp', 0, 3, 0.01, 'domain warp'],
    ['trenchSharp', 0, 1, 0.01, 'edge hardness'],
    ['trenchDetail', 0, 1, 0.01, 'interior detail'],
    ['trenchRelief', 0, 2, 0.01, 'relief'],
    ['trenchAmbient', 0, 1, 0.01, 'ambient floor'],
    ['trenchOpacity', 0, 1, 0.01, 'opacity'],
    ['trenchEmissive', 0, 2, 0.01, 'front glow'],
    ['trenchMarkLife', 0.2, 20, 0.1, 'breach mark life'],
    ['trenchHeight', 0.002, 0.2, 0.002, 'quad height'],
    ['colorTrench', 'gouged stone'],
    ['colorTrenchDeep', 'the bottom'],
    ['colorTrenchEdge', 'lip'],
    ['colorTrenchGlow', 'heave front']
  ],
  'Chips, gloom & motes': [
    ['chipRate', 0, 600, 1, 'chip rate'],
    ['chipSize', 0.005, 0.3, 0.005, 'chip size at rung 0'],
    ['chipRungGain', 0, 1, 0.01, 'chips follow the ladder'],
    ['chipSpeed', 0, 20, 0.1, 'chip speed'],
    ['chipLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['chipGravity', -50, 0, 0.1, 'chip gravity'],
    ['breachChips', 0, 40, 1, 'chips per breach'],
    ['gloomRate', 0, 400, 1, 'gloom rate'],
    ['gloomSize', 0.05, 4, 0.01, 'gloom size'],
    ['gloomSpeed', 0, 6, 0.05, 'gloom speed'],
    ['gloomLifetime', 0.2, 8, 0.05, 'gloom lifetime'],
    ['gloomOpacity', 0, 1, 0.005, 'gloom opacity'],
    ['gloomRise', -2, 4, 0.01, 'gloom rise'],
    ['moteRate', 0, 400, 1, 'mote rate'],
    ['moteSize', 0.005, 0.5, 0.005, 'mote size'],
    ['moteSpeed', 0, 10, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 5, 0.05, 'mote lifetime'],
    ['moteRise', -2, 6, 0.01, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['colorChip*', 'Chip colour'],
    ['colorGloom*', 'Gloom colour'],
    ['colorMote*', 'Mote colour']
  ],
  'The beats you feel': [
    ['heaveShake', 0, 3, 0.01, 'landing knock'],
    ['shakeDuration', 0.1, 4, 0.01, 'knock duration'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['unmakeRumble', 0, 0.3, 0.002, 'unmaking rumble'],
    ['impactChips', 0, 400, 1, 'impact chips']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 40, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 30, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
