/* ================================================================== */
/* PLAGUEBLOOM — Plague Bloom, the blood school's far cast             */
/* ================================================================== */
/**
 * A boiling cloud of gas standing over a circle of blistered ground.
 *
 * **The trick is the sync.** The cloud is a `Medium.GAS_BOIL` volume, whose
 * density is driven by a cellular field of bubbles that inflate and pop on
 * *individual* timers, so the cloud has visible internal events rather than
 * drifting noise. The floor underneath is a `GroundMode.PUSTULE` field, whose
 * blisters inflate and burst on individual timers too — and the two lattices
 * are deliberately **the same lattice**:
 *
 *  - `gasBoilScale` is *cells per metre*. It sets the pitch of the bubbles in
 *    the cloud, and the ability hands `1 / gasBoilScale` to the floor as its
 *    cell size in metres. One slider, two fields, one pitch.
 *  - `gasBoilRate` is *pops per second*. It is the base rate of the cloud's
 *    cell clocks and it is handed to the floor as its `speed`. Both modules
 *    multiply it by `global.noiseSpeed`, so the two stay locked even when the
 *    whole sandbox is slowed down.
 *  - both fields take the cast's one dice roll as their `seed`, and both are
 *    sampled in **world space** off `frame.uTime` — which is why the floor
 *    quad is never yawed with the cast. Yawing it would slide the floor
 *    lattice out of register with the cloud lattice above it, and the whole
 *    read of "that blister burst and *that* bubble popped" would go with it.
 *
 * This is the one place in the sandbox where two values are shared rather than
 * authored twice, and it is the `snare.zoneRadius` exemption in I5: the
 * sharing *is* the design. Give the floor its own pitch slider and within
 * about ten seconds of dragging it the two fields are strangers.
 *
 * The beats are `seep → boil → burst`:
 *
 *  1. **seep** (travel) — a wet stain opens on the floor at the target ahead
 *     of the front, and the first breath of gas creeps up out of it.
 *  2. **boil** (impact, long) — the dome inflates, the blisters come up, and
 *     the cloud sits there having events in it.
 *  3. **burst** (fade, slow) — the footprint is eaten back from its edge, the
 *     dome climbs and spreads as it thins, and the last blisters vent.
 *
 * Nothing here is captured at cast time. The cast rolls one seed and notes one
 * timestamp per frame; every metre, second and colour below is re-read inside
 * the update loop, on a zero-length frame included.
 */
import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

export const plaguebloom = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  zoneRadius: 5.0, // the footprint — what the circle indicator measures out
  speed: 24.0, // how fast the seep front crosses to the point, metres/second
  lifetime: 6.0, // seconds the bloom stands and boils
  fadeTime: 3.6, // seconds it takes to disperse
  cooldown: 1.8,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the cloud, as a body in the world --- */
  // Placement only. Everything about what the gas *is* lives in the `gas*`
  // block below, which `VolumeHull` owns.
  cloudSpread: 1.08, // dome radius as a multiple of `zoneRadius`
  cloudHeight: 3.1, // metres from the floor to the crown of the dome
  cloudLift: 0.0, // metres the dome's floor sits above the ground
  seepDensity: 0.26, // 0..1 how much cloud there is during the travel beat
  riseTime: 1.15, // seconds the dome takes to inflate once the cast lands
  disperseSpread: 0.6, // extra dome radius over the disperse, × `zoneRadius`
  disperseLift: 1.6, // metres the dome climbs as it lets go
  disperseCurve: 1.7, // >1 holds the cloud, then drops it late

  ...volumeHullDefaults('gas', Medium.GAS_BOIL, {
    // 32 steps against a dome that fills perhaps a quarter of a 1080p frame is
    // 520k × 32 × (1 + 1 tap) = 33M samples — over the 20M budget on paper and
    // fine in practice because this cast draws three meshes in total and there
    // is nothing else on screen competing for fill. Drop `global.volumeQuality`
    // if it ever shares a frame with Pyroclasm.
    gasSteps: 32,
    gasMargin: 0.2, // the boil eats into the silhouette; it needs the headroom
    gasHeightBias: 0.55, // heavier at the floor: this is gas pooling, not a mushroom
    gasRound: 0.55,
    gasRise: 0.35, // barely buoyant — the point is that it hangs
    gasFlatten: 0.35, // pancake the eddies so it spreads rather than billows
    gasBoilRate: 0.5, // pops per second — SHARED with the floor's blisters
    gasBoilScale: 1.7, // cells per metre — SHARED with the floor's blisters
    gasBoilSize: 0.76,
    gasBoilDepth: 1.05, // let the bubbles genuinely eat the cloud
    gasBoilFlash: 2.6
  }),

  /* --- the floor: the blisters --- */
  /**
   * `GroundMode.PUSTULE`, world-aligned, sharing the cloud's pitch and clock.
   * There is deliberately no `pustuleCell` and no `pustuleSpeed` here — see the
   * header. Everything else about how a blister is *shaped* is its own slider.
   */
  pustuleHeight: 0.024, // metres the quad floats above the floor
  pustuleJitter: 0.9, // 0..1 lattice disorder
  pustuleSeam: 0.06, // metres of skin between neighbouring blisters
  pustuleLift: 0.16, // metres a taut blister stands proud
  pustuleDepth: 0.13, // metres of crater it leaves when it goes
  pustuleSharp: 0.45, // 0..1 profile hardness
  pustuleDetail: 0.75, // 0..1 grain on the skin
  pustuleEdge: 0.5, // metres of feather on the growth front
  pustuleRagged: 0.26, // how far the front wanders, as a fraction of the radius
  pustuleRaggedScale: 0.6, // lobes per metre
  pustuleWarp: 0.55, // metres of domain warp on those lobes
  pustuleRelief: 0.85, // how hard the height field tilts the fake normal
  pustuleNormalStep: 0.05, // metres between the height taps
  pustuleAmbient: 0.3, // floor on the diffuse term
  pustuleWrap: 0.5, // 0..1 wraps the terminator round the back
  pustuleSpecular: 0.75, // wet skin is shiny; this is most of why it reads as flesh
  pustuleGloss: 42, // Blinn exponent
  pustuleParallax: 0.2, // metres of view-driven offset on the interior detail
  pustuleEmissive: 1.1, // multiplier on the glowing terms
  pustuleOpacity: 1.0,
  pustuleDepthFade: 0.4, // metres of soft fade where the character stands in it
  pustuleColorBase: '#7a8a2a', // the skin
  pustuleColorEdge: '#c8d86a', // the taut highlight on a full blister
  pustuleColorGlow: '#e8ff9a', // what a burst throws
  pustuleColorDeep: '#1c2408', // inside the crater

  /* --- the floor: the stain that seeps out first --- */
  // A `GroundMode.POOL` quad under the blisters, alpha-blended so it genuinely
  // darkens the flagstones instead of lighting them. It is the only thing on
  // screen during the travel beat.
  stainSpread: 1.15, // stain radius as a multiple of `zoneRadius`
  stainHeight: 0.012, // metres above the floor — under the blisters
  stainCell: 1.3, // ripple frequency, cycles per metre
  stainThickness: 0.09, // metres of meniscus at the rim
  stainLift: 0.02, // metres of wave height
  stainDepth: 0.07, // metres the middle dishes down
  stainSharp: 0.35,
  stainDetail: 0.5,
  stainSpeed: 0.35, // ripples per second
  stainFlow: 0.12, // metres/second the surface drifts
  stainWindAngle: 0.9, // radians, bearing of that drift
  stainEdge: 0.55, // metres of feather on the front
  stainRagged: 0.34, // fraction of the radius the rim wanders by
  stainRaggedScale: 0.45, // lobes per metre
  stainWarp: 0.7, // metres of domain warp
  stainRelief: 0.35,
  stainNormalStep: 0.07, // metres between the height taps
  stainAmbient: 0.42,
  stainWrap: 0.55, // 0..1 wraps the terminator round the back
  stainSpecular: 0.9,
  stainGloss: 60,
  stainParallax: 0.12, // metres of view-driven offset
  stainDepthFade: 0.45, // metres of soft fade against standing geometry
  stainOpacity: 0.85,
  stainEmissive: 0.5,
  stainRecede: 0.55, // 0..1 how much of the stain the disperse eats back
  stainColorBase: '#4a5a18', // the liquid
  stainColorEdge: '#a8c04a', // the meniscus and the sheen
  stainColorGlow: '#9aa83a', // the faint luminescence off the deep
  stainColorDeep: '#141a06', // the middle, where it has pooled

  /* --- the vents: what a bursting blister throws --- */
  /**
   * The CPU walks the *same* lattice the floor shader draws, with the same two
   * hashes, and fires these where a blister crosses its burst phase. That is
   * the sync made visible: the puff leaves the ground on the frame the blister
   * on the ground opens, and the bubble directly above it is popping on the
   * same clock.
   */
  ventShare: 0.3, // 0..1 fraction of blisters big enough to vent at all
  ventPuffs: 3, // gas particles a vent releases
  ventSpatter: 4, // droplets a vent throws
  ventLight: 0.9, // how hard a vent punches the dynamic light
  ventRadius: 0.22, // metres the vent's emission is spread over

  /* --- vent gas --- */
  puffSize: 0.85,
  puffSpeed: 1.05, // metres/second it leaves the blister at
  puffLifetime: 2.4, // seconds
  puffRise: 0.7, // buoyancy, metres/second²
  puffOpacity: 0.16,
  puffTurbulence: 0.55,
  colorPuffA: '#c8d86a',
  colorPuffB: '#9aa83a',
  colorPuffC: '#5a6a20',
  colorPuffD: '#232a0c',

  /* --- spatter --- */
  spatterSize: 0.05,
  spatterSpeed: 3.2, // metres/second
  spatterLifetime: 1.2, // seconds
  spatterGravity: -12.0, // metres/second²
  colorSpatterA: '#d8e87a',
  colorSpatterB: '#8a9a2a',
  colorSpatterC: '#4a5a18',
  colorSpatterD: '#2a3210',

  /* --- spores: the slow motes drifting up out of the cloud --- */
  sporeRate: 55, // particles/second over the whole footprint
  sporeSize: 0.055,
  sporeSpeed: 0.45, // metres/second
  sporeLifetime: 3.2, // seconds
  sporeRise: 0.55, // metres/second of drift
  sporeTurbulence: 0.85,
  sporeSpread: 0.9, // 0..1 of the footprint radius they are born across
  sporeCeiling: 1.25, // × `cloudHeight`, how high they are seeded
  colorSporeA: '#e8ff9a',
  colorSporeB: '#c8d86a',
  colorSporeC: '#7a8a2a',
  colorSporeD: '#2a3a0c',

  /* --- dynamic light --- */
  lightIntensity: 9.5,
  lightRadius: 12.0,
  lightColor: '#a8c04a',
  lightHeight: 1.4, // metres above the footprint the light hangs at
  lightBreath: 0.22, // depth of the slow swell under the cloud
  lightBreathSpeed: 0.7 // swells per second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Plague Bloom.
 *
 * The two controls that carry the ability are in **The cloud · boil**:
 * `gasBoilRate` and `gasBoilScale`. They are the only sliders in the sandbox
 * that drive two separate shaders on purpose — drag either with the clock
 * stopped and the blisters on the floor re-pitch and re-time along with the
 * bubbles in the cloud. After that, `pustuleLift` and `pustuleSpecular` decide
 * whether the floor reads as flesh or as gravel, and `gasBoilDepth` decides how
 * much of the cloud the bubbles are allowed to eat.
 */
export const plaguebloomSchema = {
  'The cast': [
    ['range', 4, 40, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['zoneRadius', 1, 12, 0.05, 'footprint radius'],
    ['speed', 4, 90, 0.5, 'seep speed'],
    ['lifetime', 0.5, 16, 0.05, 'hold'],
    ['fadeTime', 0.2, 10, 0.05, 'disperse time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The cloud · placement': [
    ['cloudSpread', 0.3, 2.5, 0.01, 'dome radius × zone'],
    ['cloudHeight', 0.4, 10, 0.05, 'dome height (m)'],
    ['cloudLift', -1, 3, 0.01, 'dome floor (m)'],
    ['seepDensity', 0, 1, 0.01, 'gas during the seep'],
    ['riseTime', 0.05, 5, 0.01, 'inflate time (s)'],
    ['disperseSpread', 0, 3, 0.01, 'spread on disperse × zone'],
    ['disperseLift', 0, 8, 0.05, 'climb on disperse (m)'],
    ['disperseCurve', 0.2, 5, 0.01, 'disperse curve']
  ],
  ...volumeHullSchema('gas', {
    label: 'The cloud',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'boil', 'colour']
  }),
  'The blisters': [
    ['pustuleHeight', 0, 0.2, 0.002, 'quad height (m)'],
    ['pustuleJitter', 0, 1, 0.01, 'lattice disorder'],
    ['pustuleSeam', 0.001, 0.4, 0.002, 'skin between (m)'],
    ['pustuleLift', 0, 0.8, 0.005, 'blister height (m)'],
    ['pustuleDepth', 0, 0.8, 0.005, 'crater depth (m)'],
    ['pustuleSharp', 0, 1, 0.01, 'profile hardness'],
    ['pustuleDetail', 0, 1, 0.01, 'skin grain']
  ],
  'The blisters/Front & light': [
    ['pustuleEdge', 0.01, 3, 0.01, 'front feather (m)'],
    ['pustuleRagged', 0, 1, 0.01, 'front wander'],
    ['pustuleRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['pustuleWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['pustuleRelief', 0, 3, 0.01, 'relief'],
    ['pustuleNormalStep', 0.005, 0.3, 0.005, 'normal step (m)'],
    ['pustuleAmbient', 0, 1, 0.01, 'ambient'],
    ['pustuleWrap', 0, 1, 0.01, 'terminator wrap'],
    ['pustuleSpecular', 0, 3, 0.01, 'wet sheen'],
    ['pustuleGloss', 1, 120, 1, 'gloss'],
    ['pustuleParallax', 0, 1.5, 0.01, 'parallax (m)'],
    ['pustuleEmissive', 0, 4, 0.01, 'emissive'],
    ['pustuleOpacity', 0, 1, 0.01, 'opacity'],
    ['pustuleDepthFade', 0.01, 2, 0.01, 'soft intersection (m)'],
    ['pustuleColorBase', 'skin'],
    ['pustuleColorEdge', 'taut highlight'],
    ['pustuleColorGlow', 'burst glow'],
    ['pustuleColorDeep', 'crater interior']
  ],
  'The stain': [
    ['stainSpread', 0.2, 2.5, 0.01, 'stain radius × zone'],
    ['stainHeight', 0, 0.2, 0.002, 'quad height (m)'],
    ['stainCell', 0.05, 6, 0.01, 'ripple cycles / m'],
    ['stainThickness', 0.001, 0.6, 0.002, 'meniscus (m)'],
    ['stainLift', 0, 0.4, 0.002, 'wave height (m)'],
    ['stainDepth', 0, 0.8, 0.005, 'body depth (m)'],
    ['stainSharp', 0, 1, 0.01, 'profile hardness'],
    ['stainDetail', 0, 1, 0.01, 'grain'],
    ['stainSpeed', 0, 4, 0.01, 'ripples / second'],
    ['stainFlow', 0, 2, 0.01, 'drift (m/s)'],
    ['stainWindAngle', -3.15, 3.15, 0.01, 'drift bearing (rad)'],
    ['stainEdge', 0.01, 3, 0.01, 'front feather (m)'],
    ['stainRagged', 0, 1, 0.01, 'rim wander'],
    ['stainRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['stainWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['stainRelief', 0, 3, 0.01, 'relief'],
    ['stainNormalStep', 0.005, 0.3, 0.005, 'normal step (m)'],
    ['stainAmbient', 0, 1, 0.01, 'ambient'],
    ['stainWrap', 0, 1, 0.01, 'terminator wrap'],
    ['stainSpecular', 0, 3, 0.01, 'sheen'],
    ['stainGloss', 1, 160, 1, 'gloss'],
    ['stainParallax', 0, 1.5, 0.01, 'parallax (m)'],
    ['stainDepthFade', 0.01, 2, 0.01, 'soft intersection (m)'],
    ['stainOpacity', 0, 1, 0.01, 'opacity'],
    ['stainEmissive', 0, 3, 0.01, 'emissive'],
    ['stainRecede', 0, 1, 0.01, 'eaten back on disperse'],
    ['stainColorBase', 'liquid'],
    ['stainColorEdge', 'meniscus & sheen'],
    ['stainColorGlow', 'luminescence'],
    ['stainColorDeep', 'the deep']
  ],
  'The vents': [
    ['ventShare', 0, 1, 0.01, 'blisters that vent'],
    ['ventPuffs', 0, 12, 1, 'gas per vent'],
    ['ventSpatter', 0, 20, 1, 'droplets per vent'],
    ['ventLight', 0, 6, 0.01, 'light punch'],
    ['ventRadius', 0.01, 1.5, 0.01, 'vent radius (m)']
  ],
  'Vent gas': [
    ['puffSize', 0.05, 4, 0.01, 'puff size'],
    ['puffSpeed', 0, 8, 0.01, 'puff speed (m/s)'],
    ['puffLifetime', 0.1, 8, 0.05, 'puff lifetime (s)'],
    ['puffRise', -2, 4, 0.01, 'puff rise'],
    ['puffOpacity', 0, 1, 0.005, 'puff opacity'],
    ['puffTurbulence', 0, 3, 0.01, 'puff turbulence'],
    ['colorPuff*', 'Puff colour']
  ],
  Spatter: [
    ['spatterSize', 0.005, 0.4, 0.005, 'droplet size'],
    ['spatterSpeed', 0, 20, 0.1, 'droplet speed (m/s)'],
    ['spatterLifetime', 0.1, 5, 0.05, 'droplet lifetime (s)'],
    ['spatterGravity', -40, 0, 0.1, 'gravity'],
    ['colorSpatter*', 'Spatter colour']
  ],
  Spores: [
    ['sporeRate', 0, 400, 1, 'spores / second'],
    ['sporeSize', 0.005, 0.4, 0.005, 'spore size'],
    ['sporeSpeed', 0, 6, 0.01, 'spore speed (m/s)'],
    ['sporeLifetime', 0.2, 10, 0.05, 'spore lifetime (s)'],
    ['sporeRise', -2, 4, 0.01, 'spore rise'],
    ['sporeTurbulence', 0, 3, 0.01, 'spore turbulence'],
    ['sporeSpread', 0, 1.5, 0.01, 'seeded across × radius'],
    ['sporeCeiling', 0, 3, 0.01, 'seeded up to × height'],
    ['colorSpore*', 'Spore colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 6, 0.05, 'light height (m)'],
    ['lightBreath', 0, 1, 0.01, 'breath depth'],
    ['lightBreathSpeed', 0, 6, 0.01, 'breaths / second'],
    ['lightColor', 'light colour']
  ]
};
