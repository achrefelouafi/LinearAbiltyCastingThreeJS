/* ================================================================== */
/* HIVE COLUMN — hive, far cast                                        */
/* ================================================================== */
/**
 * A comb tower that is **built**, not grown.
 *
 * Everything else in the sandbox that comes out of the floor is placed by a
 * function of position: a radius, a band, a noise field. This one is placed by
 * its own history. One seed cell is laid at the middle of the circle, and every
 * cell after it buds one lattice unit off a cell already standing, in *that
 * cell's* frame — which has been turned by up to `drift` of a turn from its own
 * parent's. Locally the packing is perfect hexagon-on-hexagon and three cells in
 * a row read as masonry; globally two fronts that left the seed around opposite
 * sides of a void come back at each other out of register, the candidate lands
 * within `refuse` of something already placed, and it is **thrown away**.
 *
 * The refusal is the ability. It is what puts a seam where two fronts met, a
 * hole where three did, and a perimeter that is jagged because of what happened
 * rather than because a noise function said so. `drift` and `refuse` are one
 * control and they are the two sliders to reach for: at `drift = 0` the refusal
 * never fires, the whole thing collapses into a hex grid filled by radius, and
 * the slot stops being this slot.
 *
 * Two draw calls for the structure: `LatticeGrowth` for the comb and
 * `GroundField(LATTICE)` for the wax the comb is seated on. See
 * `src/abilities/hive/HivecolumnAbility.js`.
 */
export const hivecolumn = {
  /* --- the cast --- */
  range: 19.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 24.0, // how fast the scent runner reaches the circle, metres/second
  cooldown: 2.0, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 4.4, // the footprint the indicator draws, metres

  /* --- the beats, all seconds --- */
  buildPad: 0.4, // slack after the last cell lands before the hold starts
  holdTime: 3.4, // the finished tower standing
  collapseTime: 1.5, // it withdrawing back into the floor

  /* --- the colony: change any of these and the structure regrows --- */
  cells: 156, // cells the growth attempts, whole number (capped at 240)
  drift: 0.19, // turns of lattice drift a child may take from its parent
  refuse: 0.93, // LATTICE UNITS — a candidate closer than this is refused
  climb: 0.34, // 0..1 tendency to start a new layer instead of spreading out
  outward: 0.42, // 0..1 preference for candidates further from the seed
  layers: 8, // ceiling on stacked layers, whole number — this is the column

  /* --- the comb, in metres --- */
  pitch: 0.36, // between adjacent cell centres
  cellRadius: 0.205, // circumradius of one cell
  sizeJitter: 0.16, // ± fraction on a cell's height and radius
  heightBase: 0.2, // a cell far out on the skirt
  heightPeak: 0.95, // a cell at the seed
  heightFalloff: 6.5, // LATTICE UNITS over which peak decays to base
  layerHeight: 0.3, // between stacked layers
  baseY: 0.0, // the floor the comb is seated on
  rise: 0.42, // how far a cell climbs out of the floor as it lands

  /* --- the build clock --- */
  stagger: 0.014, // seconds between one cell landing and the next
  growTime: 0.24, // seconds one cell takes to land
  overshoot: 0.3, // fraction it overshoots by on the way

  /* --- the comb's surface --- */
  tintRadius: 7.5, // LATTICE UNITS over which the four-stop gradient is walked
  tintJitter: 0.16, // ± per-cell walk along it
  combWrap: 0.45, // 0 hard terminator, 1 fully wrapped
  rimPow: 3.4, // how narrow the bright rim on a cell wall is
  rimGain: 0.55,
  sheenPow: 40, // waxy specular exponent
  sheenGain: 0.62,
  coreGlow: 0.9, // how hot the recess at the bottom of a cell is
  flashGain: 1.6, // the flash as a cell lands
  combGlow: 1.0, // master multiplier on every emissive term
  colorCombA: '#e8d179', // birth — fresh wax at the growing edge
  colorCombB: '#c39a33', // early
  colorCombC: '#7f5a16', // late
  colorCombD: '#33240d', // death — old comb deep in the tower
  colorCombCore: '#c8f04a', // the sick green down in the recess
  colorCombRim: '#fff0b4', // the lit lip of a cell wall
  colorCombSheen: '#fffbe6', // the waxy specular
  colorCombFlash: '#eaff9a', // a cell the instant it snaps into place

  /* --- the wax mat on the floor, a GroundField(LATTICE) --- */
  floorRadius: 1.18, // × zoneRadius
  floorHeight: 0.018, // metres above the floor the quad sits at
  floorEdge: 0.5, // metres of feather on the propagating front
  floorRagged: 0.36, // how far that front wanders, as a fraction of the radius
  floorRaggedScale: 0.8, // lobes per metre
  floorWarp: 0.62, // metres of domain warp on those lobes
  floorRelief: 0.72, // how hard the height field tilts the fake normal
  floorCell: 0.34, // metres — the hex pitch, deliberately near `pitch`
  floorSeam: 0.05, // metres — the node at each corner
  floorThickness: 0.045, // metres — trace half-width
  floorLift: 0.05, // metres — how far a trace stands proud
  floorDepth: 0.16, // metres — how far the etch between traces sinks
  floorSpeed: 1.1, // charge events per second
  floorAmbient: 0.3, // floor on the diffuse term
  floorWrap: 0.45, // 0..1 wraps the terminator round the back
  floorSpecular: 0.42,
  floorGloss: 26, // Blinn exponent
  floorParallax: 0.25, // metres of view-driven offset on interior detail
  floorDetail: 0.6,
  floorSharp: 0.5,
  floorEmissive: 1.0, // multiplier on the glowing terms
  floorOpacity: 0.92,
  floorDepthFade: 0.5, // metres of soft fade against standing geometry
  colorFloorBase: '#8a6a26', // the wax itself
  colorFloorEdge: '#e8d179', // trace lips and highlights
  colorFloorGlow: '#c8f04a', // whatever is charged
  colorFloorDeep: '#160f04', // the etch between the traces

  /* --- wax motes coming off the build --- */
  moteRate: 46, // per second while the tower is building
  moteSize: 0.075, // metres
  moteSpeed: 0.85, // metres/second on release
  moteLifetime: 2.4, // seconds
  moteRise: 0.55, // metres/second² of buoyancy
  moteTurbulence: 0.55,
  moteGlow: 1.4,
  cellMotes: 3, // extra motes thrown by each cell as it snaps into place
  colorMoteA: '#f6ffc0', // birth
  colorMoteB: '#d8e878', // early
  colorMoteC: '#a8b038', // late
  colorMoteD: '#3a3c10', // death

  /* --- the dry dust the tower pushes out of the floor --- */
  dustRate: 22, // per second while building
  dustSize: 0.7, // metres
  dustSpeed: 0.85, // metres/second
  dustLifetime: 2.2, // seconds
  dustRise: 0.5, // metres/second² of buoyancy
  dustOpacity: 0.42,
  colorDustA: '#c8b076', // birth
  colorDustB: '#9a8450', // early
  colorDustC: '#5e4f2c', // late
  colorDustD: '#1c1710', // death

  /* --- chips of old comb knocked loose --- */
  chipSize: 0.1, // metres
  chipSpeed: 2.2, // metres/second
  chipLifetime: 1.5, // seconds
  chipGravity: -13.0, // metres/second²
  chipSpin: 9.0, // radians/second
  cellChipChance: 0.22, // 0..1 — how often a landing cell throws one
  collapseChips: 90, // thrown all at once when the tower lets go
  colorChipA: '#e8d179', // birth
  colorChipB: '#b48c30', // early
  colorChipC: '#6b4c14', // late
  colorChipD: '#241a08', // death

  /* --- the muzzle, the seating and the collapse --- */
  handForward: 0.7, // metres downrange of the caster
  handSide: 0.34, // metres to the caster's side
  handHeight: 1.35, // metres off the floor
  muzzleSize: 1.0, // metres, the shell at the hand
  muzzleIntensity: 1.1,
  castFlash: 0.05, // screen flash on release
  colorCastFlash: '#e8d179',
  burstSize: 2.6, // metres, the shell as the seed cell is laid
  burstIntensity: 1.2,
  burstMotes: 90, // motes thrown at that moment
  shockRadius: 3.2, // metres, the dust ring pushed out under it
  impactShake: 0.4,
  shakeDuration: 1.0, // seconds
  impactFlash: 0.07,
  rumble: 0.014, // continuous shake while the runner travels
  colorBurstA: '#f2e29a',
  colorBurstB: '#c8a03c',
  colorBurstC: '#c8f04a',
  colorFlash: '#eaff9a',
  colorSeat: '#8a6a26', // the wax mat decal under the tower
  colorSeatEdge: '#e8d179',
  seatRadius: 1.05, // × zoneRadius
  seatLife: 7.0, // seconds the mat weathers away over
  seatIntensity: 0.85,

  /* --- the dynamic light --- */
  lightIntensity: 9.0,
  lightRadius: 11.0, // metres
  lightHeight: 0.75, // × the tower's own height
  lightPulse: 0.22, // 0..1 depth of the slow breathing
  lightPulseRate: 1.7, // radians/second
  lightColor: '#d8c04a'
};

/** Editor layout: which folders exist and what goes in them. */
export const hivecolumnSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 150, 1, 'runner speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['zoneRadius', 1, 16, 0.05, 'footprint radius'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['buildPad', 0, 3, 0.05, 'slack after the last cell'],
    ['holdTime', 0.2, 14, 0.1, 'standing'],
    ['collapseTime', 0.2, 8, 0.05, 'withdrawing']
  ],
  'The colony': [
    ['cells', 4, 240, 1, 'cells attempted'],
    ['drift', 0, 0.5, 0.005, 'lattice drift (turns)'],
    ['refuse', 0.3, 1.4, 0.005, 'refusal distance'],
    ['climb', 0, 1, 0.01, 'tendency to climb'],
    ['outward', -1, 2, 0.01, 'outward bias'],
    ['layers', 1, 14, 1, 'layer ceiling']
  ],
  'The comb': [
    ['pitch', 0.08, 1.2, 0.005, 'cell pitch (m)'],
    ['cellRadius', 0.03, 0.8, 0.005, 'cell radius (m)'],
    ['sizeJitter', 0, 1, 0.01, 'size jitter'],
    ['heightBase', 0.02, 2, 0.01, 'height at the skirt (m)'],
    ['heightPeak', 0.05, 4, 0.01, 'height at the seed (m)'],
    ['heightFalloff', 0.5, 24, 0.1, 'falloff (lattice units)'],
    ['layerHeight', 0.05, 1.2, 0.005, 'layer pitch (m)'],
    ['baseY', -1, 2, 0.01, 'seat height (m)'],
    ['rise', 0, 2, 0.01, 'climb out of the floor (m)']
  ],
  'The build clock': [
    ['stagger', 0.001, 0.12, 0.001, 'seconds per cell'],
    ['growTime', 0.03, 1.5, 0.01, 'one cell landing'],
    ['overshoot', 0, 1.5, 0.01, 'overshoot']
  ],
  'The comb/Surface': [
    ['tintRadius', 0.5, 24, 0.1, 'gradient reach (lattice units)'],
    ['tintJitter', 0, 1, 0.01, 'gradient jitter'],
    ['combWrap', 0, 1, 0.01, 'terminator wrap'],
    ['rimPow', 0.5, 12, 0.1, 'rim tightness'],
    ['rimGain', 0, 3, 0.01, 'rim gain'],
    ['sheenPow', 2, 120, 1, 'sheen tightness'],
    ['sheenGain', 0, 3, 0.01, 'sheen gain'],
    ['coreGlow', 0, 4, 0.01, 'recess glow'],
    ['flashGain', 0, 6, 0.01, 'landing flash'],
    ['combGlow', 0, 4, 0.01, 'master glow']
  ],
  'The comb/Colour': [
    ['colorComb*', 'Comb gradient'],
    ['colorCombCore', 'recess'],
    ['colorCombRim', 'cell rim'],
    ['colorCombSheen', 'wax sheen'],
    ['colorCombFlash', 'landing flash']
  ],
  'The wax mat': [
    ['floorRadius', 0.2, 3, 0.01, 'radius × zone'],
    ['floorHeight', 0, 0.3, 0.002, 'hover height'],
    ['floorEdge', 0.02, 3, 0.01, 'front feather'],
    ['floorRagged', 0, 1, 0.01, 'front raggedness'],
    ['floorRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['floorWarp', 0, 3, 0.01, 'domain warp'],
    ['floorRelief', 0, 2, 0.01, 'relief'],
    ['floorCell', 0.05, 2, 0.01, 'hex pitch (m)'],
    ['floorSeam', 0.002, 0.4, 0.002, 'node size (m)'],
    ['floorThickness', 0.002, 0.4, 0.002, 'trace width (m)'],
    ['floorLift', 0, 0.6, 0.005, 'trace height (m)'],
    ['floorDepth', 0, 1, 0.005, 'etch depth (m)'],
    ['floorSpeed', 0, 5, 0.01, 'charge rate'],
    ['floorAmbient', 0, 1, 0.01, 'ambient'],
    ['floorWrap', 0, 1, 0.01, 'terminator wrap'],
    ['floorSpecular', 0, 2, 0.01, 'specular'],
    ['floorGloss', 2, 128, 1, 'gloss'],
    ['floorParallax', 0, 1.5, 0.01, 'parallax'],
    ['floorDetail', 0, 1, 0.01, 'detail'],
    ['floorSharp', 0, 1, 0.01, 'sharpness'],
    ['floorEmissive', 0, 3, 0.01, 'emissive'],
    ['floorOpacity', 0, 1, 0.01, 'opacity'],
    ['floorDepthFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorFloorBase', 'wax'],
    ['colorFloorEdge', 'trace lip'],
    ['colorFloorGlow', 'charge'],
    ['colorFloorDeep', 'etch']
  ],
  'The motes': [
    ['moteRate', 0, 300, 1, 'rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'size'],
    ['moteSpeed', 0, 6, 0.05, 'speed'],
    ['moteLifetime', 0.2, 8, 0.05, 'lifetime'],
    ['moteRise', -2, 3, 0.01, 'buoyancy'],
    ['moteTurbulence', 0, 3, 0.01, 'turbulence'],
    ['moteGlow', 0, 6, 0.01, 'glow'],
    ['cellMotes', 0, 16, 1, 'motes per cell'],
    ['colorMote*', 'Mote colour']
  ],
  'The dust': [
    ['dustRate', 0, 200, 1, 'rate'],
    ['dustSize', 0.05, 4, 0.01, 'size'],
    ['dustSpeed', 0, 5, 0.05, 'speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'lifetime'],
    ['dustRise', -2, 3, 0.01, 'buoyancy'],
    ['dustOpacity', 0, 1, 0.01, 'opacity'],
    ['colorDust*', 'Dust colour']
  ],
  'The chips': [
    ['chipSize', 0.01, 0.6, 0.005, 'size'],
    ['chipSpeed', 0, 12, 0.05, 'speed'],
    ['chipLifetime', 0.2, 6, 0.05, 'lifetime'],
    ['chipGravity', -40, 0, 0.5, 'gravity'],
    ['chipSpin', 0, 30, 0.5, 'spin'],
    ['cellChipChance', 0, 1, 0.01, 'chance per cell'],
    ['collapseChips', 0, 400, 1, 'chips on collapse'],
    ['colorChip*', 'Chip colour']
  ],
  'Muzzle & seating': [
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['muzzleSize', 0.05, 4, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 4, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 1, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour'],
    ['burstSize', 0.2, 10, 0.05, 'seating shell'],
    ['burstIntensity', 0, 4, 0.01, 'shell intensity'],
    ['burstMotes', 0, 500, 1, 'motes on seating'],
    ['shockRadius', 0.2, 14, 0.05, 'dust ring'],
    ['impactShake', 0, 2, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 1, 0.01, 'screen flash'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['seatRadius', 0.2, 3, 0.01, 'mat radius × zone'],
    ['seatLife', 0.5, 20, 0.1, 'mat life'],
    ['seatIntensity', 0, 3, 0.01, 'mat intensity'],
    ['colorBurstA', 'shell'],
    ['colorBurstB', 'shell body'],
    ['colorBurstC', 'shell motes'],
    ['colorFlash', 'seating flash colour'],
    ['colorSeat', 'mat'],
    ['colorSeatEdge', 'mat rim']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 2, 0.01, 'height × tower'],
    ['lightPulse', 0, 1, 0.01, 'pulse depth'],
    ['lightPulseRate', 0.05, 6, 0.01, 'pulse rate'],
    ['lightColor', 'light colour']
  ]
};
