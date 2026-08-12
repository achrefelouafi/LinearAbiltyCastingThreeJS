/* ================================================================== */
/* CARAPACE — a dome of interlocking chitin plates                     */
/* ================================================================== */
/**
 * One spherical Voronoi tessellation, cut by `sites` and `jitter`, whose cells
 * fly in from outside and lock against their neighbours' edges.
 *
 * **The two structural keys.** `sites` and `jitter` are the only numbers in
 * here that re-run the clipper — everything else is a uniform, live on a
 * zero-length frame. `sites` is how many plates the dome is made of; `jitter`
 * wobbles the Fibonacci lattice they sit on, and at 0 the dome is a perfectly
 * regular honeycomb that reads as a manufactured object rather than as armour.
 *
 * **The dome's footprint is `zoneRadius`.** Not a radius of its own: the aim
 * circle measured the dome out, and `domeHeight` is the only thing that makes
 * it a dome rather than a hemisphere. That sharing *is* the design, in the
 * sense invariant I5 allows.
 *
 * **`seam` is the one to be careful with.** It draws every plate's rim in
 * toward its own centre by a fraction *of the unit sphere*, before any metres
 * arrive, so two neighbours inset by the same amount and the gap between them
 * stays even all the way round. Small, it is the dark line between two plates.
 * Large, the dome is a scatter of debris — which is what the fade uses it for,
 * and what `openSeam` is.
 */
export const carapace = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 36.0, // how fast the summoning front travels, metres/second
  cooldown: 1.6,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 3.6, // metres — the aim circle, and the dome's own footprint
  holdTime: 2.2, // seconds the closed dome stands
  fadeTime: 1.4, // seconds the seams take to open and the dome to go

  /* --- the tessellation: only these two re-run the clipper --- */
  sites: 52, // plates, whole number, at least 12
  jitter: 0.36, // unitless wobble on the Fibonacci lattice — 0 is too regular

  /* --- the dome --- */
  domeHeight: 0.74, // dome height as a fraction of `zoneRadius`
  thickness: 0.13, // metres a plate is extruded inward
  seam: 0.042, // 0..1 the rim is drawn in toward the plate centre
  flyOut: 3.0, // metres a plate starts out from its locked place
  tumbleSpin: 2.0, // radians it starts rotated about its own axis
  tumbleSwing: 1.15, // radians it starts tipped off the dome
  stagger: 0.014, // seconds between one plate locking and the next
  lockTime: 0.34, // seconds one plate takes to arrive
  orderScatter: 0.26, // 0 they lock from the ground up, 1 at random

  /* --- the shell's look --- */
  tintHeight: 0.9, // how much of the gradient the dome's height walks
  tintJitter: 0.17,
  wrap: 0.38, // 0 hard terminator, 1 light bleeding through the plate
  rimPow: 3.0, // fresnel exponent — the grazing shine that says chitin
  rimGain: 0.7,
  sheenPow: 56.0, // the oily highlight that slides across a carapace
  sheenGain: 0.95,
  seamGlow: 0.45, // how hot the side walls are — the only evidence of seams
  arriveGain: 1.7, // flash as a plate locks
  glow: 1.0,
  colorPlateA: '#4a3c1c', // at the foot of the dome
  colorPlateB: '#8a6f26',
  colorPlateC: '#c9a63a',
  colorPlateD: '#efdf92', // at the crown
  colorRim: '#fff0bc', // the fresnel rim
  colorSheen: '#ffffff', // the sheen lobe
  colorSeam: '#ffab2e', // light from inside the shell, out along a seam
  colorArrive: '#fff2c4', // the flash as a plate locks

  /* --- the opening: the seams come apart along the tessellation --- */
  openSeam: 0.4, // 0..1 extra inset at full open — the gaps ARE the Voronoi
  openRetract: 2.4, // exponent on the collapse: high holds full size, then goes
  openSpill: 3.2, // how much the seam light climbs as the gaps widen
  openChips: 120, // chips thrown as the dome lets go

  /* --- the apron: the chitin floor the dome grows out of --- */
  apronRadius: 1.16, // × zoneRadius
  apronHeight: 0.02, // metres above the floor the quad sits at
  apronEdge: 0.3, // metres of feather on the front
  apronRagged: 0.26, // how far the front wanders, fraction of the radius
  apronRaggedScale: 0.7, // lobes per metre
  apronWarp: 0.42, // metres of domain warp on those lobes
  apronCell: 0.6, // metres — plate size on the floor
  apronCellJitter: 0.85,
  apronSeam: 0.055, // metres — gap between floor plates
  apronThickness: 0.05, // metres — sheet thickness
  apronLift: 0.11, // metres — how far a downwind edge curls up
  apronRelief: 0.65, // how hard the height field tilts the fake normal
  apronAmbient: 0.3,
  apronWrap: 0.45,
  apronSpecular: 0.5,
  apronGloss: 24.0,
  apronEmissive: 0.9,
  apronOpacity: 0.9,
  apronDepthFade: 0.5, // metres of soft fade where it meets the dome
  colorApronBase: '#6a5626',
  colorApronEdge: '#d9c274',
  colorApronGlow: '#ffab2e',
  colorApronDeep: '#1a1408',

  /* --- chips knocked off as each plate slams home --- */
  chipLand: 5, // chips thrown by one landing plate
  chipSize: 0.075,
  chipSpeed: 3.4,
  chipLifetime: 1.2,
  chipGravity: -14.0,
  colorChipA: '#e8cf7c',
  colorChipB: '#b08f34',
  colorChipC: '#6d5820',
  colorChipD: '#2e2510',

  /* --- dust pushed out from under the rim --- */
  dustRate: 40.0, // particles/second
  dustSize: 0.8,
  dustSpeed: 1.4,
  dustLifetime: 2.4,
  dustRise: 0.3,
  dustOpacity: 0.11,
  colorDustA: '#7d7048',
  colorDustB: '#6a6042',
  colorDustC: '#4c4530',
  colorDustD: '#26221a',

  /* --- amber motes leaking out of the seams --- */
  moteRate: 55.0, // particles/second
  moteSize: 0.05,
  moteSpeed: 0.9,
  moteLifetime: 1.7,
  moteRise: 0.8, // upward drift, metres/second
  moteTurbulence: 0.6,
  colorMoteA: '#fff0c2',
  colorMoteB: '#ffb63c',
  colorMoteC: '#c07414',
  colorMoteD: '#3a2205',

  /* --- the seal: the moment the ring of first plates bites --- */
  burstSize: 2.4, // the dust shell where the dome grounds out, metres
  burstIntensity: 1.1,
  shockRadius: 5.5, // impact ring across the floor, metres
  crackRadius: 3.0, // fractures under the rim, metres
  crackLife: 5.0,
  crackIntensity: 0.6,
  sealFlash: 0.12, // screen flash as the dome closes
  openFlash: 0.16, // and as it comes apart
  impactShake: 0.7,
  shakeDuration: 0.5,
  rumble: 0.02, // continuous shake while the plates are still arriving
  colorBurstA: '#7d6c3a',
  colorBurstB: '#c9a63a',
  colorBurstC: '#efdf92',
  colorShockA: '#c9a63a',
  colorShockB: '#fff2c4',
  colorCrack: '#ffab2e',
  colorCrackDeep: '#241a06',
  colorSealFlash: '#e8cf7c',
  colorOpenFlash: '#ffc457',

  /* --- dynamic light: it lives INSIDE the dome --- */
  lightIntensity: 16.0,
  lightRadius: 11.0,
  lightColor: '#ffb040',
  lightHeight: 0.45, // fraction of the dome's height the light hangs at
  lightPulse: 0.3, // depth of the light's breathing, 0 = steady
  lightPulseSpeed: 3.4,
  lightSpill: 2.4 // how far the light climbs as the seams open
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Carapace.
 *
 * The folder to open first is **The tessellation**: drag `sites` and watch the
 * dome re-cut itself, plate for plate, with no gaps at any count. Then take
 * `seam` up from 0.04 to 0.4 with the clock paused — every gap that opens is a
 * real Voronoi edge shared exactly by the two plates either side of it, which
 * is the entire claim this slot is making.
 *
 * `orderScatter` decides whether the dome is *built* or *dropped on you*: at 0
 * the plates lock from the ground up, at 1 they arrive in no order at all.
 */
export const carapaceSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'front speed'],
    ['zoneRadius', 0.5, 12, 0.05, 'footprint radius'],
    ['holdTime', 0.05, 8, 0.01, 'hold time'],
    ['fadeTime', 0.05, 5, 0.01, 'open time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The tessellation': [
    ['sites', 12, 96, 1, 'plates'],
    ['jitter', 0, 1.5, 0.01, 'lattice wobble'],
    ['domeHeight', 0.1, 2, 0.01, 'height / radius'],
    ['thickness', 0.01, 0.8, 0.005, 'plate thickness'],
    ['seam', 0, 0.4, 0.002, 'seam inset']
  ],
  'The fly-in': [
    ['flyOut', 0, 12, 0.05, 'start distance'],
    ['tumbleSpin', 0, 8, 0.05, 'start spin'],
    ['tumbleSwing', 0, 3, 0.01, 'start tip'],
    ['stagger', 0, 0.12, 0.001, 'plate to plate'],
    ['lockTime', 0.02, 2, 0.01, 'one plate lands in'],
    ['orderScatter', 0, 1, 0.01, 'order scatter'],
    ['arriveGain', 0, 6, 0.01, 'landing flash']
  ],
  'The shell': [
    ['tintHeight', 0, 2, 0.01, 'height tint'],
    ['tintJitter', 0, 1, 0.01, 'per-plate tint'],
    ['wrap', 0, 1, 0.01, 'light wrap'],
    ['rimPow', 0.2, 10, 0.05, 'rim exponent'],
    ['rimGain', 0, 3, 0.01, 'rim gain'],
    ['sheenPow', 2, 160, 1, 'sheen tightness'],
    ['sheenGain', 0, 4, 0.01, 'sheen gain'],
    ['seamGlow', 0, 3, 0.01, 'seam glow'],
    ['glow', 0, 4, 0.01, 'glow'],
    ['colorPlate*', 'Plate body'],
    ['colorRim', 'rim'],
    ['colorSheen', 'sheen'],
    ['colorSeam', 'seam light'],
    ['colorArrive', 'landing flash']
  ],
  'The opening': [
    ['openSeam', 0, 1, 0.01, 'seam at full open'],
    ['openRetract', 0.2, 8, 0.05, 'collapse curve'],
    ['openSpill', 0, 10, 0.05, 'seam light spill'],
    ['openChips', 0, 400, 1, 'chips at the open'],
    ['openFlash', 0, 1, 0.005, 'screen flash'],
    ['colorOpenFlash', 'open flash']
  ],
  'The apron': [
    ['apronRadius', 0.2, 3, 0.01, 'radius × zone'],
    ['apronHeight', 0, 0.3, 0.005, 'height off floor'],
    ['apronEdge', 0.02, 2, 0.01, 'front feather'],
    ['apronRagged', 0, 1, 0.01, 'front raggedness'],
    ['apronRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['apronWarp', 0, 3, 0.01, 'domain warp'],
    ['apronCell', 0.05, 3, 0.01, 'plate size'],
    ['apronCellJitter', 0, 1, 0.01, 'plate jitter'],
    ['apronSeam', 0, 0.4, 0.005, 'plate gap'],
    ['apronThickness', 0, 0.4, 0.005, 'sheet thickness'],
    ['apronLift', 0, 0.6, 0.005, 'edge curl'],
    ['apronRelief', 0, 2, 0.01, 'relief'],
    ['apronAmbient', 0, 1, 0.01, 'ambient'],
    ['apronWrap', 0, 1, 0.01, 'light wrap'],
    ['apronSpecular', 0, 2, 0.01, 'specular'],
    ['apronGloss', 2, 120, 1, 'gloss'],
    ['apronEmissive', 0, 3, 0.01, 'emissive'],
    ['apronOpacity', 0, 2, 0.01, 'opacity'],
    ['apronDepthFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorApronBase', 'apron body'],
    ['colorApronEdge', 'apron rim'],
    ['colorApronGlow', 'apron glow'],
    ['colorApronDeep', 'apron interior']
  ],
  'Chips, dust & motes': [
    ['chipLand', 0, 40, 1, 'chips / plate'],
    ['chipSize', 0.005, 0.4, 0.005, 'chip size'],
    ['chipSpeed', 0, 20, 0.1, 'chip speed'],
    ['chipLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['chipGravity', -50, 0, 0.1, 'chip gravity'],
    ['dustRate', 0, 400, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 8, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['moteRate', 0, 400, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 8, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -2, 6, 0.01, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['colorChip*', 'Chip colour'],
    ['colorDust*', 'Dust colour'],
    ['colorMote*', 'Mote colour']
  ],
  'The seal': [
    ['burstSize', 0.1, 10, 0.05, 'dust shell'],
    ['burstIntensity', 0, 3, 0.01, 'shell intensity'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['crackRadius', 0.1, 10, 0.05, 'fracture radius'],
    ['crackLife', 0.5, 20, 0.1, 'fracture lifetime'],
    ['crackIntensity', 0, 2, 0.01, 'fracture intensity'],
    ['sealFlash', 0, 1, 0.005, 'screen flash'],
    ['impactShake', 0, 3, 0.01, 'seal shake'],
    ['shakeDuration', 0.05, 2, 0.01, 'shake decay'],
    ['rumble', 0, 0.3, 0.001, 'build rumble'],
    ['colorBurstA', 'shell inner'],
    ['colorBurstB', 'shell mid'],
    ['colorBurstC', 'shell rim'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest'],
    ['colorCrack', 'fracture'],
    ['colorCrackDeep', 'fracture interior'],
    ['colorSealFlash', 'seal flash']
  ],
  'Light': [
    ['lightIntensity', 0, 60, 0.5, 'intensity'],
    ['lightRadius', 1, 40, 0.5, 'radius'],
    ['lightHeight', 0, 1.5, 0.01, 'height in the dome'],
    ['lightPulse', 0, 1, 0.01, 'breathing depth'],
    ['lightPulseSpeed', 0, 20, 0.1, 'breathing rate'],
    ['lightSpill', 0, 8, 0.05, 'spill on opening'],
    ['lightColor', 'colour']
  ]
};
