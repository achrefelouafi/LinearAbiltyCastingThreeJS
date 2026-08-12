import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* FIREWALK — the burning trail of footprints                          */
/* ================================================================== */
/**
 * A line cast. Something walks the aimed line and each footfall ignites where
 * it lands: an actual sole — heel, arch, ball, five toes — burnt into the floor,
 * heel first, throwing a short pillar of flame as it lights.
 *
 * ### Why the numbers below are anatomy
 *
 * Flame is the school with no silhouette. Everything in it is a cloud, a jet or
 * a front, and the only shapes are the ones the medium happens to erode itself
 * into that frame. The trick here is to put one recognisable object in it, and a
 * footprint is the cheapest recognisable object there is — three ellipses and
 * five dots, and the eye completes a body walking away from you.
 *
 * That only works if the proportions are right, so they are sliders and they are
 * named after feet rather than after shapes. `archCut` is the one worth
 * dragging: at 0 the sole is a bean and reads as a scorch blot, and by about
 * 0.4 the medial arch is eaten in far enough that the mark reads as a **foot**
 * from any angle. There is no gradual improvement in between — it snaps.
 *
 * `stride` is the other one. A walk is two lines of marks either side of the
 * centre line, taken in turn; the alternation is what the eye reconstructs a
 * gait from. At `stride: 0` the whole trail collapses into a dotted line down
 * the middle and the silhouette stops working even though every print is still
 * a perfect foot.
 *
 * ### What a cast captures
 *
 * Per print: a seed, a lateral dice roll and the timestamp the front crossed
 * it. Nothing else. Every metre, radian and second below is re-resolved in the
 * vertex or fragment shader on the frame it is read, so dragging `stepLength`
 * on a paused trail re-spaces prints that are already burning and takes their
 * pillars, their lane and their light with them.
 */
export const firewalk = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 11.0, // how fast the walk runs down the line, metres/second
  lifetime: 1.5, // seconds the trail burns after the last footfall
  fadeTime: 1.8, // seconds it takes to burn down to a scar
  cooldown: 1.2, // seconds
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the gait --- */
  startOffset: 1.1, // metres in front of the caster the first print lands
  stepLength: 1.15, // metres between successive footfalls
  stride: 0.3, // metres from the centre line to a print — 0 kills the silhouette
  wander: 0.05, // metres of per-print lateral slop, × a unitless dice roll
  toeOut: 0.14, // radians each print splays away from the line of travel
  printLift: 0.014, // metres the sole quad floats above the floor

  /* --- the sole --- */
  // Roughly a size 43 boot at the defaults: 30 cm by 11.5 cm.
  footLength: 0.3, // metres, heel to the end of the toes
  footWidth: 0.115, // metres, across the ball
  heelWidth: 0.78, // heel width as a fraction of the ball's
  ballWidth: 1.0, // ball width as a fraction of `footWidth`
  archCut: 0.42, // 0..1 how far the medial arch is eaten in — see above
  soleRound: 0.02, // metres of smooth union between heel, waist and ball
  toeSize: 0.03, // metres, the big toe; the others taper off it
  toeSpread: 0.92, // how far the toe row fans across the width
  toeGap: 0.016, // metres the toe row sits ahead of the ball
  solePad: 0.13, // metres of quad outside the sole, for the scorch halo to live in

  /* --- how a print burns --- */
  rollTime: 0.17, // seconds the ignition takes to run heel to toe
  flashTime: 0.09, // seconds a freshly lit point stays white
  coolTime: 1.7, // seconds that point takes to go dark
  charTime: 0.5, // seconds the char takes to blacken
  soleRim: 0.016, // metres of ember rim inside the outline
  soleHalo: 0.1, // metres of scorch outside it
  soleEdge: 0.006, // metres of feather on the outline
  soleGrain: 5.5, // ember-vein features per metre
  soleVein: 0.6, // 0..1 how much of the sole is vein rather than flat char
  soleRagged: 0.03, // metres the halo wanders
  soleOpacity: 1.0,
  soleGlow: 2.2, // emissive gain on the embers
  soleSoftFade: 0.3, // metres of depth feather where the print meets geometry
  colorFlash: '#fff4d6', // the ignition line running heel to toe
  colorEmber: '#ff6a18', // the veins that stay hot
  colorChar: '#100b09', // burnt stone
  colorAsh: '#4a423c', // the print before the char takes
  colorHalo: '#241813', // the scorch outside the sole

  /* --- the pillar each print throws --- */
  pillarHeight: 1.35, // metres at full stretch
  pillarWidth: 0.22, // metres, half-width at the base
  pillarRise: 0.2, // seconds to full height
  pillarFall: 0.95, // seconds to gutter out
  pillarLean: 0.18, // metres the crown leans downrange
  pillarWaver: 0.07, // metres of sideways sway at the crown
  pillarWaverRate: 3.1, // sways per second
  pillarTaper: 1.35, // >1 pulls the flame to a point
  pillarBulge: 0.55, // 0..1 how much it swells above the base
  pillarNoiseScale: 1.6, // features per metre
  pillarNoiseSpeed: 2.4, // metres/second the field climbs
  pillarErosion: 0.9, // how hard the noise eats the silhouette
  pillarOpacity: 1.0,
  pillarGlow: 1.7,
  pillarSoftFade: 0.4, // metres of depth feather
  colorPillarA: '#fff0c0', // at the foot
  colorPillarB: '#ff9a2a',
  colorPillarC: '#d43c0a',
  colorPillarD: '#241a1c', // the smoke at the crown

  /* --- the pyre standing on the newest print (Medium.FLAME, prefix `pyre`) --- */
  // One raymarched volume, and it rides the print that just lit rather than
  // covering the whole lane: coverage is the dominant cost in this module and a
  // box over twenty metres of floor spends its entire step budget in vacuum.
  pyreWidth: 0.42, // metres, half-width of the hull
  pyreHeight: 0.95, // metres, half-height
  pyreSlack: 1.12, // proxy hull slack, × — headroom for the erosion to spill into
  pyreLinger: 1.1, // seconds the volume keeps burning on a print after it lit
  ...volumeHullDefaults('pyre', Medium.FLAME, {
    pyreSteps: 26, // march steps — the cost knob; the hull is small, so this is cheap
    pyreJitter: 1.0, // step dither; 0 only ever shows you the banding
    pyreContact: 0.22, // metres of fade where the flame meets the floor
    pyreMargin: 0.2, // headroom inside the hull before the erosion
    pyreDensity: 2.4,
    pyreNoiseFrequency: 3.2, // features per metre — a small fire has a fine grain
    pyreNoiseStrength: 0.85,
    pyreRise: 1.6, // buoyant rise, metres/second
    pyreEmission: 3.2,
    pyreShadowTaps: 0, // an emissive medium does not need a lit side
    pyreSpeckDensity: 0.07,
    pyreSpeckGlow: 9.0
  }),

  /* --- the lane the walk scorches (GroundMode.RUT, prefix `lane`) --- */
  // RUT and not a decal: the char is drawn by a front whose progress is
  // re-resolved every frame, and each footfall posts a contact sample so the
  // burn is deeper under a print than between two.
  laneReach: 1.4, // metres — the mark's own radius, i.e. how wide the canvas is
  laneWidth: 0.42, // metres, half-width of the scorched lane
  laneDepth: 0.05, // metres of gouge — a scorch, not a trench
  laneLift: 0.02, // metres of ash heaped along the edges
  laneThickness: 0.14, // metres the heaped edge spreads over
  laneEdge: 0.3, // metres of feather on the front
  laneRagged: 0.35, // how far the front wanders, as a fraction of the radius
  laneRaggedScale: 1.1, // lobes per metre
  laneWarp: 0.4, // metres of domain warp on those lobes
  laneRelief: 0.55, // how hard the height field tilts the fake normal
  laneNormalStep: 0.05, // metres between the height taps
  laneAmbient: 0.3, // floor on the diffuse term
  laneWrap: 0.45, // wraps the terminator round the back
  laneSpecular: 0.15, // burnt stone is not shiny
  laneGloss: 18, // Blinn exponent
  laneParallax: 0.2, // metres of view-driven offset on the interior detail
  laneCell: 0.8, // metres — the pitch of the chatter along the track
  laneSeam: 0.55, // metres a footfall's contact sample reaches along the track
  laneSharp: 0.55, // 0..1 how hard the lane's edge is
  laneDetail: 0.5, // 0..1 chatter depth
  laneSwirl: 0.22, // how much the lane drifts off the dead-straight line
  laneMarkLife: 7.0, // seconds a footfall's contact sample weathers away over
  laneMarkRadius: 0.5, // metres, a full-strength contact sample
  laneHeight: 0.012, // metres above the floor the lane quad sits
  laneEmissive: 1.0, // multiplier on the glowing terms
  laneOpacity: 0.95,
  laneDepthFade: 0.4, // metres of soft fade against standing geometry
  colorLaneBase: '#2b211c', // the scorched stone
  colorLaneEdge: '#6e5a4a', // the ash heaped at its lip
  colorLaneGlow: '#ff5a12', // what is still hot in the gouge
  colorLaneDeep: '#0b0706', // the bottom of the burn

  /* --- embers, smoke and the sparks a footfall kicks --- */
  /**
   * Three systems, each with its own four-stop lifetime gradient sampled `A` at
   * birth through `D` as it dies. Spelled out rather than derived from the sole
   * palette, so the embers can be made to cool to soot while the prints stay
   * orange.
   */
  moteRate: 130, // embers lifting off the burning prints, particles/second
  moteSize: 0.07,
  moteSpeed: 1.3,
  moteLifetime: 1.5,
  moteRise: 1.7, // upward drift, metres/second
  moteTurbulence: 0.85,
  moteGlow: 2.0,
  colorMoteA: '#fff0c8',
  colorMoteB: '#ff9226',
  colorMoteC: '#c8340a',
  colorMoteD: '#2a1410',
  smokeRate: 34, // haze off the lane, particles/second
  smokeSize: 0.8,
  smokeSpeed: 1.0,
  smokeLifetime: 2.6,
  smokeRise: 0.6,
  smokeOpacity: 0.075,
  colorSmokeA: '#4a4038',
  colorSmokeB: '#3a322c',
  colorSmokeC: '#2c2622',
  colorSmokeD: '#1a1614',
  sparkStamp: 26, // sparks kicked out by one footfall
  sparkSize: 0.11,
  sparkSpeed: 4.6,
  sparkLifetime: 0.65,
  sparkGravity: -14.0,
  sparkStretch: 0.2, // how far a spark smears along its velocity
  colorSparkA: '#ffffff',
  colorSparkB: '#ffc25a',
  colorSparkC: '#ff5c14',
  colorSparkD: '#5a1c08',

  /* --- feedback --- */
  stampShake: 0.09, // camera kick per footfall
  shakeDuration: 0.35, // seconds that kick takes to die
  castFlash: 0.05, // screen flash as the first print lights
  colorCastFlash: '#ffb268',
  rumble: 0.012, // continuous shake while the walk runs out

  /* --- dynamic light --- */
  lightIntensity: 15, // it rides the newest print
  lightRadius: 9,
  lightHeight: 0.55, // metres above the print the light sits
  lightColor: '#ff8434',
  lightFlicker: 0.28, // depth of the gutter, 0 = steady
  lightFlickerSpeed: 13 // gutters per second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Firewalk.
 *
 * Reach for **The sole** first — `archCut`, `toeSpread` and `footWidth` are
 * what decide whether the mark reads as a foot at all — and then **The gait**,
 * where `stride` and `stepLength` decide whether a row of feet reads as a walk.
 * Everything in both folders is live on a paused trail.
 *
 * The `pyreBoil*` and `pyreVoid*` keys `volumeHullDefaults` emits belong to
 * other media and do nothing to a FLAME hull, so they are not filed here; they
 * still appear in the trailing "More" folder for anyone who wants them.
 */
export const firewalkSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 2, 60, 0.5, 'walking speed'],
    ['lifetime', 0.1, 8, 0.05, 'burn time'],
    ['fadeTime', 0.1, 8, 0.05, 'burn-down time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The gait': [
    ['startOffset', -1, 6, 0.05, 'first print (m)'],
    ['stepLength', 0.2, 4, 0.01, 'step length (m)'],
    ['stride', 0, 1.5, 0.01, 'stride width (m)'],
    ['wander', 0, 0.5, 0.005, 'per-print slop (m)'],
    ['toeOut', -0.8, 0.8, 0.01, 'toe-out (rad)'],
    ['printLift', 0, 0.2, 0.001, 'print height (m)']
  ],
  'The sole': [
    ['footLength', 0.08, 1.2, 0.005, 'foot length (m)'],
    ['footWidth', 0.03, 0.6, 0.005, 'foot width (m)'],
    ['heelWidth', 0.2, 1.4, 0.01, 'heel × ball'],
    ['ballWidth', 0.3, 1.6, 0.01, 'ball × width'],
    ['archCut', 0, 0.85, 0.01, 'arch cut'],
    ['soleRound', 0.002, 0.12, 0.002, 'union radius (m)'],
    ['toeSize', 0.005, 0.12, 0.001, 'big toe (m)'],
    ['toeSpread', 0, 2, 0.01, 'toe spread'],
    ['toeGap', -0.02, 0.1, 0.001, 'toe gap (m)'],
    ['solePad', 0.02, 0.6, 0.005, 'quad margin (m)']
  ],
  'How a print burns': [
    ['rollTime', 0.01, 1.5, 0.005, 'heel-to-toe roll (s)'],
    ['flashTime', 0.01, 1, 0.005, 'flash (s)'],
    ['coolTime', 0.05, 8, 0.05, 'cool (s)'],
    ['charTime', 0.05, 5, 0.01, 'char (s)'],
    ['soleRim', 0.002, 0.1, 0.001, 'ember rim (m)'],
    ['soleHalo', 0.01, 0.6, 0.005, 'scorch halo (m)'],
    ['soleEdge', 0.001, 0.08, 0.001, 'outline feather (m)'],
    ['soleGrain', 0.5, 20, 0.1, 'veins / metre'],
    ['soleVein', 0, 1, 0.01, 'vein share'],
    ['soleRagged', 0, 0.2, 0.002, 'halo wander (m)'],
    ['soleOpacity', 0, 2, 0.01, 'opacity'],
    ['soleGlow', 0, 8, 0.05, 'ember glow'],
    ['soleSoftFade', 0.02, 2, 0.01, 'soft intersection (m)'],
    ['colorFlash', 'ignition line'],
    ['colorEmber', 'ember veins'],
    ['colorChar', 'burnt stone'],
    ['colorAsh', 'fresh print'],
    ['colorHalo', 'scorch halo']
  ],
  'The pillars': [
    ['pillarHeight', 0, 6, 0.01, 'height (m)'],
    ['pillarWidth', 0.02, 1.5, 0.01, 'half-width (m)'],
    ['pillarRise', 0.01, 2, 0.01, 'rise (s)'],
    ['pillarFall', 0.05, 6, 0.05, 'gutter (s)'],
    ['pillarLean', -1, 1.5, 0.01, 'downrange lean (m)'],
    ['pillarWaver', 0, 0.6, 0.005, 'crown sway (m)'],
    ['pillarWaverRate', 0, 12, 0.05, 'sways / sec'],
    ['pillarTaper', 0.1, 4, 0.01, 'taper'],
    ['pillarBulge', 0, 2, 0.01, 'bulge'],
    ['pillarNoiseScale', 0.1, 8, 0.05, 'features / metre'],
    ['pillarNoiseSpeed', 0, 12, 0.05, 'climb (m/s)'],
    ['pillarErosion', 0, 3, 0.01, 'erosion'],
    ['pillarOpacity', 0, 2, 0.01, 'opacity'],
    ['pillarGlow', 0, 6, 0.05, 'glow'],
    ['pillarSoftFade', 0.02, 2, 0.01, 'soft intersection (m)'],
    ['colorPillar*', 'Pillar colour']
  ],
  'The pyre': [
    ['pyreWidth', 0.05, 3, 0.01, 'hull half-width (m)'],
    ['pyreHeight', 0.05, 4, 0.01, 'hull half-height (m)'],
    ['pyreSlack', 1, 2, 0.01, 'proxy hull slack'],
    ['pyreLinger', 0.05, 6, 0.05, 'linger on a print (s)']
  ],
  ...volumeHullSchema('pyre', {
    label: 'Pyre',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'speck', 'colour']
  }),
  'The lane': [
    ['laneReach', 0.2, 8, 0.05, 'canvas radius (m)'],
    ['laneWidth', 0.05, 3, 0.01, 'lane half-width (m)'],
    ['laneDepth', 0, 0.6, 0.005, 'gouge depth (m)'],
    ['laneLift', 0, 0.3, 0.002, 'ash lip (m)'],
    ['laneThickness', 0.02, 0.8, 0.005, 'lip spread (m)'],
    ['laneEdge', 0.02, 2, 0.01, 'front feather (m)'],
    ['laneRagged', 0, 1, 0.01, 'front wander'],
    ['laneRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['laneWarp', 0, 3, 0.01, 'lobe warp (m)'],
    ['laneRelief', 0, 2, 0.01, 'relief'],
    ['laneNormalStep', 0.01, 0.3, 0.005, 'normal step (m)'],
    ['laneAmbient', 0, 1, 0.01, 'ambient'],
    ['laneWrap', 0, 1, 0.01, 'terminator wrap'],
    ['laneSpecular', 0, 2, 0.01, 'specular'],
    ['laneGloss', 1, 80, 1, 'gloss'],
    ['laneParallax', 0, 1, 0.01, 'parallax (m)'],
    ['laneCell', 0.05, 3, 0.01, 'chatter pitch (m)'],
    ['laneSeam', 0.05, 3, 0.01, 'contact reach (m)'],
    ['laneSharp', 0, 1, 0.01, 'edge sharpness'],
    ['laneDetail', 0, 1, 0.01, 'chatter depth'],
    ['laneSwirl', -2, 2, 0.01, 'lane drift'],
    ['laneMarkLife', 0.5, 20, 0.1, 'contact life (s)'],
    ['laneMarkRadius', 0.05, 3, 0.01, 'contact radius (m)'],
    ['laneHeight', 0, 0.2, 0.001, 'quad height (m)'],
    ['laneEmissive', 0, 4, 0.01, 'emissive'],
    ['laneOpacity', 0, 2, 0.01, 'opacity'],
    ['laneDepthFade', 0.05, 3, 0.01, 'soft fade (m)'],
    ['colorLaneBase', 'scorched stone'],
    ['colorLaneEdge', 'ash lip'],
    ['colorLaneGlow', 'hot gouge'],
    ['colorLaneDeep', 'deep burn']
  ],
  'Embers & smoke': [
    ['moteRate', 0, 800, 1, 'ember rate'],
    ['moteSize', 0.005, 0.5, 0.005, 'ember size'],
    ['moteSpeed', 0, 12, 0.05, 'ember speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'ember lifetime'],
    ['moteRise', -2, 8, 0.05, 'ember rise'],
    ['moteTurbulence', 0, 3, 0.01, 'ember turbulence'],
    ['moteGlow', 0, 6, 0.05, 'ember glow'],
    ['smokeRate', 0, 400, 1, 'smoke rate'],
    ['smokeSize', 0.05, 4, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 10, 0.05, 'smoke lifetime'],
    ['smokeRise', -2, 4, 0.01, 'smoke rise'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['colorMote*', 'Ember colour'],
    ['colorSmoke*', 'Smoke colour']
  ],
  'Sparks & feedback': [
    ['sparkStamp', 0, 300, 1, 'sparks / footfall'],
    ['sparkSize', 0.005, 0.6, 0.005, 'spark size'],
    ['sparkSpeed', 0, 30, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 4, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['colorSpark*', 'Spark colour'],
    ['stampShake', 0, 1, 0.005, 'footfall kick'],
    ['shakeDuration', 0.05, 3, 0.01, 'kick decay (s)'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 3, 0.01, 'light height (m)'],
    ['lightFlicker', 0, 1, 0.01, 'light gutter'],
    ['lightFlickerSpeed', 1, 60, 1, 'gutter rate'],
    ['lightColor', 'light colour']
  ]
};
