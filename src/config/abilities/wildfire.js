import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* WILDFIRE — spread as a cellular automaton                           */
/* ================================================================== */
/**
 * A far cast. A seed of fire lands in the circle and then **spreads**: cell to
 * cell across a grid, biased by a wind, jumping gaps as spot fires, refusing to
 * cross ground with no fuel in it, and curling back over ground it has already
 * burnt. Not a growing circle — a front.
 *
 * ### The block below is the rule table, and it is worth reading as one
 *
 * Everything from `grid` to `seedSpread` is the automaton. None of it is a
 * dimension: they are counts, probabilities per tick, and fractions. The
 * simulation therefore has no idea how big it is, which is exactly why
 * `zoneRadius` stays live over a running fire — the pitch of the lattice is
 * `2 · zoneRadius / grid`, re-resolved every frame, and the *pattern* the
 * automaton produced is untouched by the rescale.
 *
 * Three of the rules are the ones that make it read as wildfire rather than as
 * a flood fill, and all three are worth dragging:
 *
 *  - **`fuelFloor`** is where the islands come from. Fuel is a two-octave
 *    value-noise field rolled once per cast, and a cell below the floor never
 *    catches at all. At 0 the fire fills the circle like paint; by about 0.35
 *    there are unburnt patches the front has to go *around*, and going around
 *    something is what makes a boundary look alive. Turn it up past 0.55 and
 *    the fire cannot get out of its own seed.
 *  - **`windBias`** skews the per-neighbour probability by the dot product of
 *    the step direction with the wind, so the burn goes oval and the upwind
 *    edge crawls. This is also the direction the flames lean.
 *  - **`spotChance`** is the ember jump: a burning cell occasionally lights one
 *    two to `spotRange` cells downwind, over whatever is in between. Spot fires
 *    are what make a real fire front unpredictable, and each one drops a scorch
 *    on the floor where it landed.
 *
 * **`reburnChance`** is the fourth, quieter one. A burnt cell keeps whatever
 * fuel `consume` left it, and if that is still above `reburnFloor` a neighbour
 * can set it going again — which is how the front ends up burning back over
 * itself instead of only ever advancing.
 *
 * ### What a cast captures
 *
 * The fuel map (unitless, rolled once — it is the terrain), each cell's state,
 * and the timestamp it caught. Every metre, second of duration and colour is
 * resolved from this block on the frame it is drawn.
 */
export const wildfire = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  speed: 40.0, // how fast the ignition dart flies to the circle, metres/second
  zoneRadius: 6.5, // the footprint the circle indicator draws, metres
  holdTime: 3.4, // seconds the fire spreads freely
  smoulderTime: 2.6, // seconds it takes to run out and go dark
  cooldown: 1.8, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws
  handForward: 0.6, // metres in front of the caster the dart leaves
  handHeight: 1.3, // metres above the floor

  /* --- the automaton (all unitless: counts, chances, fractions) --- */
  grid: 26, // cells across the zone. A topology, captured at spawn
  tickRate: 12, // automaton generations per second
  spread: 0.36, // chance a burning cell lights an orthogonal neighbour, per tick
  diagonalBias: 0.62, // that chance, × for a diagonal neighbour
  windBias: 0.85, // how hard the wind skews the chance, ± along the wind
  windAngle: 0.25, // radians, measured off the cast heading
  fuelFloor: 0.36, // fuel a cell needs before it can catch — this makes the islands
  fuelScale: 3.2, // fuel patches across the zone; low is big country, high is speckle
  fuelBias: 0.06, // pushes the whole fuel field up or down
  spotChance: 0.045, // chance per burning cell per tick of throwing a spot fire
  spotRange: 4, // cells a spot fire can jump over
  consume: 0.55, // fraction of a cell's fuel one burn eats
  reburnFloor: 0.42, // fuel a spent cell needs before it can catch again
  reburnChance: 0.12, // × the normal chance, for a spent cell catching again
  seeds: 3, // ignition points dropped when the dart lands
  seedSpread: 0.16, // how far those scatter, as a fraction of the radius

  /* --- how one cell burns --- */
  catchTime: 0.22, // seconds a cell takes to come up to full heat
  burnTime: 2.3, // seconds a *full-fuel* cell burns for; a poor cell burns briefly
  charTime: 0.6, // seconds the char takes to blacken
  ashTime: 2.2, // seconds after burnout the ash takes to grey over
  cellFill: 1.12, // drawn cell width, × the lattice pitch — over 1 so cells touch
  cellJitter: 0.22, // per-cell placement slop, × the pitch
  blockiness: 0.55, // 0 a disc, 1 a square — how visible the lattice is
  cellRough: 0.5, // 0..1 noise chewed out of a cell's edge
  cellRoughScale: 2.6, // features per metre on that noise
  cellVein: 0.55, // 0..1 how much of the ember is vein rather than wash
  cellLift: 0.014, // metres above the floor the scar sits
  cellOpacity: 1.0,
  cellGlow: 2.0,
  cellSoftFade: 0.3, // metres of depth feather
  colorFlash: '#fff0cc', // the frame a cell catches
  colorEmber: '#ff6a16', // what stays hot afterwards
  colorChar: '#120c0a', // burnt ground
  colorAsh: '#57504a', // and what it greys over to

  /* --- the flames standing on the burning cells --- */
  flameHeight: 0.9, // metres at full heat on a full-fuel cell
  flameWidth: 0.17, // metres, half-width at the base
  flameLean: 0.32, // metres the crown leans downwind
  flameWaver: 0.05, // metres of sway at the crown
  flameWaverRate: 3.6, // sways per second
  flameTaper: 1.25, // >1 pulls a tongue to a point
  flameBulge: 0.5, // how much it swells above the base
  flameNoiseScale: 2.1, // features per metre
  flameNoiseSpeed: 2.6, // metres/second the field climbs
  flameErosion: 0.95, // how hard the noise eats the silhouette
  flameOpacity: 1.0,
  flameGlow: 1.6,
  flameSoftFade: 0.4, // metres of depth feather
  colorFlameA: '#fff2c4', // at the foot
  colorFlameB: '#ff9424',
  colorFlameC: '#c72e08',
  colorFlameD: '#1c1414', // the smoke at the tip

  /* --- the pall over the front (Medium.FLAME, prefix `pall`) --- */
  // It follows the *burning cells*, not the zone: the hull is placed on their
  // centroid and sized to their extent, both re-derived every frame. A hull over
  // the whole circle would spend most of its step budget in vacuum, which is the
  // one failure `VolumeHull` warns about twice.
  pallSpread: 1.15, // × the front's own extent
  pallHeight: 1.1, // metres, half-height of the hull
  pallSlack: 1.14, // proxy hull slack, ×
  pallCells: 42, // burning cells for a fully opaque pall
  ...volumeHullDefaults('pall', Medium.FLAME, {
    pallSteps: 24, // march steps — the cost knob
    pallJitter: 1.0, // step dither; 0 only ever shows you the banding
    pallContact: 0.5, // metres of fade where it meets the floor
    pallMargin: 0.26, // headroom inside the hull for the erosion
    pallDensity: 1.5, // thinner than a jet: this is the haze over a front
    pallNoiseFrequency: 1.4, // features per metre
    pallNoiseStrength: 0.95,
    pallRise: 1.9, // buoyant rise, metres/second
    pallEmission: 2.2,
    pallShadowTaps: 0, // an emissive medium does not need a lit side
    pallSpeckDensity: 0.05,
    pallSpeckGlow: 7.0
  }),

  /* --- the scorch a spot fire leaves where it lands (GroundMode.POCK) --- */
  spotEdge: 0.4, // metres of feather on the field's own front
  spotRagged: 0.3, // how far that front wanders
  spotRaggedScale: 0.8, // lobes per metre
  spotWarp: 0.5, // metres of domain warp
  spotDepth: 0.06, // metres of bowl under a spot fire
  spotLift: 0.02, // metres of lip around it
  spotRelief: 0.5, // how hard the height field tilts the fake normal
  spotNormalStep: 0.06, // metres between the height taps
  spotAmbient: 0.3,
  spotWrap: 0.45,
  spotSpecular: 0.12, // burnt ground is not shiny
  spotGloss: 16,
  spotParallax: 0.2,
  spotMarkLife: 8.0, // seconds a spot scorch weathers away over
  spotMarkRadius: 0.55, // metres, a full-strength spot scorch
  spotHeight: 0.01, // metres above the floor the quad sits
  spotEmissive: 1.0,
  spotOpacity: 0.9,
  spotDepthFade: 0.4,
  colorSpotBase: '#2a1f19',
  colorSpotEdge: '#6a5a4c',
  colorSpotGlow: '#ff5a12',
  colorSpotDeep: '#0a0706',

  /* --- embers and smoke --- */
  /**
   * Two systems, each with its own four-stop lifetime gradient sampled `A` at
   * birth through `D` as it dies. Both are emitted from cells the automaton says
   * are burning, so the particles show the same front the geometry does.
   */
  moteRate: 170, // embers lifting off the front, particles/second
  moteSize: 0.065,
  moteSpeed: 1.6,
  moteLifetime: 1.7,
  moteRise: 2.0, // upward drift, metres/second
  moteTurbulence: 0.9,
  moteGlow: 2.0,
  colorMoteA: '#fff0c8',
  colorMoteB: '#ff8e22',
  colorMoteC: '#c02c08',
  colorMoteD: '#241210',
  smokeRate: 55, // pall off the burnt ground, particles/second
  smokeSize: 1.1,
  smokeSpeed: 1.2,
  smokeLifetime: 3.0,
  smokeRise: 0.75,
  smokeOpacity: 0.085,
  colorSmokeA: '#514640',
  colorSmokeB: '#3e3630',
  colorSmokeC: '#2e2825',
  colorSmokeD: '#191514',

  /* --- feedback --- */
  landShake: 0.4, // the kick as the dart lands
  shakeDuration: 0.5, // seconds that kick takes to die
  landFlash: 0.14, // screen flash on landing
  castFlash: 0.05, // screen flash on release
  colorCastFlash: '#ffab5e',
  burstSize: 2.2, // the shell where the dart lands, metres
  burstIntensity: 1.5,
  rumble: 0.02, // continuous shake while the fire burns
  colorBurstA: '#c72e08',
  colorBurstB: '#ff9424',
  colorBurstC: '#fff2c4',

  /* --- dynamic light --- */
  lightIntensity: 20, // it rides the centroid of the burning cells
  lightRadius: 14,
  lightHeight: 0.9, // metres above the floor the light sits
  lightColor: '#ff7a2e',
  lightFlicker: 0.3, // depth of the gutter, 0 = steady
  lightFlickerSpeed: 11 // gutters per second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Wildfire.
 *
 * **The automaton** is the folder that matters, and it behaves like a rule
 * table rather than like a look: change one number and the *shape of the burn*
 * changes, not its colour. `fuelFloor`, `windBias` and `spotChance` are the
 * three that carry the character. Everything in it takes effect on the next
 * generation, so a paused fire keeps whatever pattern it had and resumes under
 * the new rules — which is the honest behaviour for a simulation and the one
 * place in this block where a slider is *not* retroactive.
 *
 * Everything else — the pitch of the lattice, how long a cell burns, how tall
 * its flame is, where the pall sits — re-resolves every frame, paused included.
 *
 * The `pallBoil*` and `pallVoid*` keys `volumeHullDefaults` emits belong to
 * other media and do nothing to a FLAME hull, so they are left to the trailing
 * "More" folder.
 */
export const wildfireSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'dart speed'],
    ['zoneRadius', 1, 16, 0.1, 'footprint radius'],
    ['holdTime', 0.2, 12, 0.05, 'spread time'],
    ['smoulderTime', 0.2, 10, 0.05, 'smoulder time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handHeight', 0, 3, 0.01, 'hand height']
  ],
  'The automaton': [
    ['grid', 8, 30, 1, 'cells across'],
    ['tickRate', 1, 40, 0.5, 'generations / sec'],
    ['spread', 0, 1, 0.005, 'catch chance'],
    ['diagonalBias', 0, 1.5, 0.01, 'diagonal ×'],
    ['windBias', 0, 2, 0.01, 'wind skew'],
    ['windAngle', -3.15, 3.15, 0.01, 'wind angle (rad)'],
    ['fuelFloor', 0, 0.9, 0.01, 'fuel floor'],
    ['fuelScale', 0.5, 10, 0.1, 'fuel patches'],
    ['fuelBias', -0.5, 0.5, 0.01, 'fuel bias'],
    ['spotChance', 0, 0.4, 0.002, 'spot-fire chance'],
    ['spotRange', 2, 10, 1, 'spot range (cells)'],
    ['consume', 0, 1, 0.01, 'fuel consumed'],
    ['reburnFloor', 0, 1, 0.01, 'reburn floor'],
    ['reburnChance', 0, 1, 0.01, 'reburn ×'],
    ['seeds', 1, 12, 1, 'ignition points'],
    ['seedSpread', 0, 1, 0.01, 'seed scatter']
  ],
  'How a cell burns': [
    ['catchTime', 0.01, 2, 0.01, 'catch (s)'],
    ['burnTime', 0.1, 10, 0.05, 'burn (s)'],
    ['charTime', 0.05, 5, 0.05, 'char (s)'],
    ['ashTime', 0.1, 10, 0.05, 'ash (s)'],
    ['cellFill', 0.2, 2, 0.01, 'cell width × pitch'],
    ['cellJitter', 0, 1, 0.01, 'placement slop × pitch'],
    ['blockiness', 0, 1, 0.01, 'lattice visibility'],
    ['cellRough', 0, 1.5, 0.01, 'edge chew'],
    ['cellRoughScale', 0.1, 8, 0.05, 'chew / metre'],
    ['cellVein', 0, 1, 0.01, 'ember vein'],
    ['cellLift', 0, 0.2, 0.001, 'scar height (m)'],
    ['cellOpacity', 0, 2, 0.01, 'opacity'],
    ['cellGlow', 0, 8, 0.05, 'ember glow'],
    ['cellSoftFade', 0.02, 2, 0.01, 'soft intersection (m)'],
    ['colorFlash', 'catch'],
    ['colorEmber', 'ember'],
    ['colorChar', 'char'],
    ['colorAsh', 'ash']
  ],
  'The flames': [
    ['flameHeight', 0, 5, 0.01, 'height (m)'],
    ['flameWidth', 0.02, 1, 0.01, 'half-width (m)'],
    ['flameLean', -1, 1.5, 0.01, 'downwind lean (m)'],
    ['flameWaver', 0, 0.5, 0.005, 'crown sway (m)'],
    ['flameWaverRate', 0, 12, 0.05, 'sways / sec'],
    ['flameTaper', 0.1, 4, 0.01, 'taper'],
    ['flameBulge', 0, 2, 0.01, 'bulge'],
    ['flameNoiseScale', 0.1, 8, 0.05, 'features / metre'],
    ['flameNoiseSpeed', 0, 12, 0.05, 'climb (m/s)'],
    ['flameErosion', 0, 3, 0.01, 'erosion'],
    ['flameOpacity', 0, 2, 0.01, 'opacity'],
    ['flameGlow', 0, 6, 0.05, 'glow'],
    ['flameSoftFade', 0.02, 2, 0.01, 'soft intersection (m)'],
    ['colorFlame*', 'Flame colour']
  ],
  'The pall': [
    ['pallSpread', 0.2, 3, 0.01, 'hull radius × front'],
    ['pallHeight', 0.1, 5, 0.01, 'hull half-height (m)'],
    ['pallSlack', 1, 2, 0.01, 'proxy hull slack'],
    ['pallCells', 4, 200, 1, 'cells for a full pall']
  ],
  ...volumeHullSchema('pall', {
    label: 'Pall',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'speck', 'colour']
  }),
  'Spot-fire scorches': [
    ['spotEdge', 0.02, 2, 0.01, 'front feather (m)'],
    ['spotRagged', 0, 1, 0.01, 'front wander'],
    ['spotRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['spotWarp', 0, 3, 0.01, 'lobe warp (m)'],
    ['spotDepth', 0, 0.5, 0.005, 'bowl depth (m)'],
    ['spotLift', 0, 0.3, 0.002, 'rim height (m)'],
    ['spotRelief', 0, 2, 0.01, 'relief'],
    ['spotNormalStep', 0.01, 0.3, 0.005, 'normal step (m)'],
    ['spotAmbient', 0, 1, 0.01, 'ambient'],
    ['spotWrap', 0, 1, 0.01, 'terminator wrap'],
    ['spotSpecular', 0, 2, 0.01, 'specular'],
    ['spotGloss', 1, 80, 1, 'gloss'],
    ['spotParallax', 0, 1, 0.01, 'parallax (m)'],
    ['spotMarkLife', 0.5, 20, 0.1, 'scorch life (s)'],
    ['spotMarkRadius', 0.05, 3, 0.01, 'scorch radius (m)'],
    ['spotHeight', 0, 0.2, 0.001, 'quad height (m)'],
    ['spotEmissive', 0, 4, 0.01, 'emissive'],
    ['spotOpacity', 0, 2, 0.01, 'opacity'],
    ['spotDepthFade', 0.05, 3, 0.01, 'soft fade (m)'],
    ['colorSpotBase', 'scorched ground'],
    ['colorSpotEdge', 'rim'],
    ['colorSpotGlow', 'hot centre'],
    ['colorSpotDeep', 'deep burn']
  ],
  'Embers & smoke': [
    ['moteRate', 0, 900, 1, 'ember rate'],
    ['moteSize', 0.005, 0.5, 0.005, 'ember size'],
    ['moteSpeed', 0, 12, 0.05, 'ember speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'ember lifetime'],
    ['moteRise', -2, 8, 0.05, 'ember rise'],
    ['moteTurbulence', 0, 3, 0.01, 'ember turbulence'],
    ['moteGlow', 0, 6, 0.05, 'ember glow'],
    ['smokeRate', 0, 500, 1, 'smoke rate'],
    ['smokeSize', 0.05, 4, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 10, 0.05, 'smoke lifetime'],
    ['smokeRise', -2, 4, 0.01, 'smoke rise'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['colorMote*', 'Ember colour'],
    ['colorSmoke*', 'Smoke colour']
  ],
  'Landing & feedback': [
    ['burstSize', 0.2, 10, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['landShake', 0, 3, 0.01, 'landing shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake decay (s)'],
    ['landFlash', 0, 2, 0.01, 'landing flash'],
    ['castFlash', 0, 2, 0.01, 'release flash'],
    ['rumble', 0, 0.3, 0.002, 'burn rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst core'],
    ['colorCastFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightHeight', 0, 4, 0.01, 'light height (m)'],
    ['lightFlicker', 0, 1, 0.01, 'light gutter'],
    ['lightFlickerSpeed', 1, 60, 1, 'gutter rate'],
    ['lightColor', 'light colour']
  ]
};
