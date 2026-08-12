/* ================================================================== */
/* BROODBURST — hive, far cast                                         */
/* ================================================================== */
/**
 * A clutch of eggs, and then what was in them.
 *
 * Every egg keeps **its own clock**. It is laid, it inflates, the shell thins
 * until the thing inside is visible through it, and then the seam gives and two
 * half-shells swing apart. Nothing about that is global: the ramp is
 * `GrowthField`'s per-instance `aBirth`, the throb's phase is the egg's own
 * dice, and the clutch is laid on a radial wave, so at any moment the middle of
 * the circle is hatching while the rim is still swelling. A clutch that popped
 * in unison was the first version and it read as one object with forty copies.
 *
 * What comes out **follows the floor**. `ColonySwarm`'s `cling` pins every agent
 * to `floorY + crawlHeight` after the flock and the shape have both had their
 * say, so the crawlers bank into turns, separate on the lattice and condense
 * into a spreading ring — all of it in the plane of the ground. That is the one
 * thing separating this from every other swarm in the sandbox, and it is why
 * `crawlHeight` is measured in centimetres rather than metres: the moment they
 * are more than a hand off the floor they are flying, and the illusion is gone.
 *
 * Five draw calls: three egg variants, the crawlers, and the wet slick they run
 * across. See `src/abilities/hive/BroodburstAbility.js` and
 * `src/materials/BroodEggMaterial.js`.
 */
export const broodburst = {
  /* --- the cast --- */
  range: 18.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 25.0, // how fast the clutch is carried to the circle, metres/second
  cooldown: 2.2, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 4.8, // the footprint the indicator draws, metres

  /* --- the beats, all seconds --- */
  layTime: 0.9, // the wave of eggs being laid, centre to rim
  layStagger: 0.35, // extra random delay between neighbours in that wave
  swellTime: 2.6, // one egg from laid to split — this is the per-egg clock
  crawlTime: 3.6, // the crawlers running about after the last egg goes
  scatterTime: 1.8, // them dispersing and the husks sinking

  /* --- the clutch --- */
  eggs: 44, // eggs in the circle, whole number (capped at 72)
  clusterShare: 0.18, // 0..1 of them heaped in the middle instead of scattered
  innerFrac: 0.06, // × zoneRadius — the hole in the middle of the ring
  radialCurve: 0.85, // <1 pushes the clutch toward the rim
  radialJitter: 0.22, // metres of radial wander
  angleJitter: 0.3, // radians of bearing wander

  /* --- one egg, in metres --- */
  eggHeight: 0.62, // an egg at the centre
  eggHeightRim: 0.46, // an egg at the boundary
  heightCurve: 1.0, // how the ramp between them runs
  heightJitter: 0.26, // ± fraction
  eggRadius: 0.26, // footprint at the centre
  eggRadiusRim: 0.21, // footprint at the boundary
  radiusCurve: 0.8,
  radiusJitter: 0.24, // ± fraction
  eggTilt: 0.22, // radians of random tip — eggs are not planted upright; the
  //               per-egg roll and settings.global.randomness scale it inside
  //               GrowthField, so it needs no jitter slider of its own
  eggSink: 0.24, // fraction of its height an egg is bedded into the floor
  riseTime: 0.3, // seconds an egg takes to accrete in place
  riseOvershoot: 0.2,
  settleTime: 0.4, // seconds that overshoot damps out over
  springRate: 15.0, // radians/second of the overshoot ring
  birthScale: 0.35, // footprint at the moment it appears
  sinkDepth: 0.5, // extra metres a husk drops as it withdraws

  /* --- the shape of the shell (rebuilds the geometry when changed) --- */
  eggRings: 16, // rings up the shell, whole number
  eggSides: 12, // bearings per half-shell, whole number
  seamTear: 0.16, // radians the seam wanders off the meridian — the torn edge

  /* --- the hatch, all fractions of one egg's own ramp --- */
  swellAt: 0.08, // where inflation starts
  splitAt: 0.62, // where the seam gives
  splitSpan: 0.22, // how long the seam takes to open
  huskAt: 0.9, // where what is left of the shell stops being there
  swell: 0.45, // fraction the shell inflates by
  swellCurve: 1.8, // >1 holds it small and then goes late
  bulge: 0.32, // extra width at the waist
  stretch: 0.24, // extra height, as a fraction of the swell
  throb: 0.055, // fraction of a per-egg pulse on top of the inflation
  throbRate: 7.0, // pulses across the whole ramp
  gape: 1.3, // radians each half-shell swings through
  gapeSlide: 0.13, // unit-space, how far the halves also slide apart
  gapeLift: 0.06, // unit-space, how far the husk lifts as it opens
  gapeCurve: 0.6, // <1 snaps open then eases

  /* --- the shell's surface --- */
  veins: 0.9, // strength of the vein network
  veinScale: 5.5, // features around the shell
  veinBands: 2.6, // features up the shell
  veinSharp: 0.62, // 0 soft mottle, 1 hard filaments
  mottle: 0.35, // broad blotching under the veins
  mottleScale: 2.2,
  rimWidth: 0.55, // how far in from the torn edge the lip reaches
  rimDark: 0.7, // how much darker that lip is
  rimGlow: 1.8, // and how hot it is once the seam has given
  shellFresnel: 1.2,
  shellFresnelPower: 2.4,
  thin: 2.4, // how much light the stretched shell passes
  thinPower: 3.0,
  broodGlow: 2.8, // the thing inside, showing through
  broodRise: 1.7, // >1 keeps it hidden until the shell is tight
  interiorGlow: 0.9, // the wet inside of an opened husk
  shellGlow: 1.0, // master multiplier on every emissive term
  shellRoughness: 0.48,
  shellEnv: 0.8,
  colorShell: '#c9c06a', // the crown of the shell
  colorBelly: '#8e9440', // where it sits on the floor
  colorVein: '#d8ff72', // the vein network
  colorBrood: '#a8ff3c', // the thing inside
  colorRim: '#ffe08a', // the torn lip once the seam gives
  colorInterior: '#2a2410', // the wet inside of an opened husk

  /* --- the crawlers --- */
  crawlers: 200, // agents at full strength, whole number (capped at 256)
  crawlShape: 0, // Silhouette: 0 bird, 1 leaf, 2 card, 3 droplet, 4 mote
  crawlHeight: 0.07, // metres off the floor a crawler rides — keep this small
  crawlSize: 0.2, // metres, nose to tail
  crawlAspect: 1.25, // span / length
  crawlSizeJitter: 0.35, // ± fraction
  crawlSweep: 0.55, // rake on the legs
  crawlDihedral: 0.12, // leg fold, fraction of the size
  crawlScuttle: 16.0, // leg beats per second
  crawlBank: 0.05, // radians of roll per m/s² of lateral acceleration
  crawlBankMax: 0.7, // radians
  crawlLit: 0.55, // 0 emissive, 1 wrapped diffuse
  crawlEdgeGain: 1.8, // emission multiplier edge-on
  crawlGlow: 1.1,
  crawlOpacity: 1.0,
  crawlSoftFade: 0.2, // metres of depth feather against standing geometry

  /* --- how they move --- */
  crawlSpacing: 0.34, // metres between lateral cells on the separation lattice
  crawlSpacingUp: 0.12, // metres between vertical cells — flat, they are on a floor
  crawlLatticeX: 9, // cells across
  crawlLatticeY: 2, // cells up
  crawlLatticeZ: 12, // ranks behind the lead
  crawlLag: 0.35, // seconds the back rank trails the lead by
  crawlJitter: 0.1, // metres of slop off the cell
  crawlChurn: 0.9, // radians/second the formation rolls
  crawlBreathe: 0.16, // fraction it swells by
  crawlBreatheRate: 2.2, // radians/second
  crawlWander: 0.12, // metres of curl drift — keep under half the spacing
  crawlWanderScale: 0.8, // features per metre
  crawlWanderSpeed: 0.9,
  crawlGather: 0.85, // 0 collapses every agent onto the lead's own path
  crawlOrbitRadius: 1.6, // metres the lead circles the clutch at
  crawlOrbitTurns: 0.9, // turns per unit of the lead's parameter
  crawlLeadRate: 0.28, // how fast that parameter advances, per second
  crawlRevealSpread: 0.3, // width of the wave that brings agents in
  crawlCondense: 0.72, // 0..1 how hard they hold the ring
  crawlRing: 0.72, // ring radius, × zoneRadius
  crawlRingGrow: 0.55, // extra ring radius by the end, × zoneRadius
  crawlRingThick: 0.34, // ring section, × zoneRadius
  crawlFill: 0.75, // 0 a shell of agents, 1 a solid body
  crawlSteps: 3, // descent steps onto the ring, 1..4
  crawlSlack: 0.85, // fraction of each step taken
  crawlRough: 0.12, // unitless slop off the isosurface — a crowd, not a membrane
  crawlSpin: 0.5, // radians/second the ring turns
  crawlTint: 0.25, // where in the gradient the swarm sits
  crawlTintJitter: 0.3, // ± per-agent walk along it
  crawlTintAlong: 0.3, // extra walk from head to tail
  colorCrawlA: '#e2ff96', // birth
  colorCrawlB: '#9ad03c', // early
  colorCrawlC: '#5a7018', // late
  colorCrawlD: '#1a1e06', // death

  /* --- the slick they run across --- */
  slickRadius: 1.1, // × zoneRadius
  slickHeight: 0.014, // metres above the floor the quad sits at
  slickEdge: 0.55, // metres of feather on the spreading front
  slickRagged: 0.4, // how far that front wanders, as a fraction of the radius
  slickRaggedScale: 0.6, // lobes per metre
  slickWarp: 0.7, // metres of domain warp on those lobes
  slickRelief: 0.4, // how hard the height field tilts the fake normal
  slickCell: 0.75, // metres — the puddle scale
  slickLift: 0.03, // metres of ripple
  slickDepth: 0.1, // metres of apparent puddle depth
  slickFlow: 0.16, // metres/second the wet drifts
  slickSpeed: 0.7, // ripple events per second
  slickAmbient: 0.24,
  slickSpecular: 0.85, // wet, so this is high on purpose
  slickGloss: 42,
  slickDetail: 0.55,
  slickSharp: 0.4,
  slickEmissive: 0.7,
  slickOpacity: 0.85,
  slickDepthFade: 0.45, // metres of soft fade against standing geometry
  slickDry: 0.8, // 0..1 how far the slick dries back in as the cast ends
  colorSlickBase: '#3a3a18', // the wet stone
  colorSlickEdge: '#c9c06a', // the meniscus
  colorSlickGlow: '#a8ff3c', // whatever is glowing in it
  colorSlickDeep: '#0c0f04', // the bottom

  /* --- the goo an egg lets go of --- */
  gooRate: 12, // per second per standing clutch
  gooBurst: 16, // per egg at the moment its seam gives
  gooSize: 0.08, // metres
  gooSpeed: 2.4, // metres/second
  gooLifetime: 1.3, // seconds
  gooGravity: -9.0, // metres/second²
  gooGlow: 1.6,
  colorGooA: '#eaffb0', // birth
  colorGooB: '#a8ff3c', // early
  colorGooC: '#6a8a1c', // late
  colorGooD: '#1e2408', // death

  /* --- shell fragments --- */
  chipBurst: 5, // per egg at the moment its seam gives
  chipSize: 0.07, // metres
  chipSpeed: 2.0, // metres/second
  chipLifetime: 1.6, // seconds
  chipGravity: -12.0, // metres/second²
  chipSpin: 8.0, // radians/second
  colorChipA: '#d8cf82', // birth
  colorChipB: '#9a9448', // early
  colorChipC: '#5c5824', // late
  colorChipD: '#1a180a', // death

  /* --- the spore haze over the clutch --- */
  hazeRate: 16, // per second
  hazeSize: 0.65, // metres
  hazeSpeed: 0.7, // metres/second
  hazeLifetime: 2.4, // seconds
  hazeRise: 0.42, // metres/second² of buoyancy
  hazeOpacity: 0.32,
  colorHazeA: '#b8c078', // birth
  colorHazeB: '#7e8848', // early
  colorHazeC: '#4a5028', // late
  colorHazeD: '#14170c', // death

  /* --- the muzzle, the landing and the scatter --- */
  handForward: 0.65, // metres downrange of the caster
  handSide: 0.32, // metres to the caster's side
  handHeight: 1.3, // metres off the floor
  muzzleSize: 0.9, // metres, the shell at the hand
  muzzleIntensity: 1.0,
  castFlash: 0.05, // screen flash on release
  colorCastFlash: '#c9c06a',
  burstSize: 2.4, // metres, the shell as the clutch lands
  burstIntensity: 1.0,
  burstGoo: 60, // goo thrown at that moment
  shockRadius: 3.4, // metres, the ring pushed out under it
  impactShake: 0.34,
  shakeDuration: 1.0, // seconds
  impactFlash: 0.06,
  rumble: 0.012, // continuous shake while the clutch is carried out
  colorBurstA: '#d8e8a0',
  colorBurstB: '#9ad03c',
  colorBurstC: '#5a7018',
  colorFlash: '#c8ff6a',
  slickDecalRadius: 1.0, // × zoneRadius — the wet mat decal under the clutch
  slickDecalLife: 6.0, // seconds it weathers away over
  slickDecalIntensity: 0.8,
  colorMat: '#3a3a18',
  colorMatEdge: '#9ad03c',

  /* --- the dynamic light --- */
  lightIntensity: 8.0,
  lightRadius: 10.0, // metres
  lightHeight: 0.5, // metres above the floor
  lightPulse: 0.28, // 0..1 depth of the slow breathing
  lightPulseRate: 2.4, // radians/second
  lightColor: '#a8d848'
};

/** Editor layout: which folders exist and what goes in them. */
export const broodburstSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 150, 1, 'carry speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['zoneRadius', 1, 16, 0.05, 'footprint radius'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['layTime', 0.05, 5, 0.05, 'laying wave'],
    ['layStagger', 0, 2, 0.01, 'neighbour stagger'],
    ['swellTime', 0.2, 10, 0.05, 'one egg, laid to split'],
    ['crawlTime', 0.2, 14, 0.1, 'crawlers running'],
    ['scatterTime', 0.2, 8, 0.05, 'dispersing']
  ],
  'The clutch': [
    ['eggs', 1, 72, 1, 'eggs'],
    ['clusterShare', 0, 1, 0.01, 'heaped in the middle'],
    ['innerFrac', 0, 1, 0.01, 'inner hole × zone'],
    ['radialCurve', 0.2, 3, 0.01, 'radial curve'],
    ['radialJitter', 0, 2, 0.01, 'radial wander (m)'],
    ['angleJitter', 0, 1.6, 0.01, 'bearing wander (rad)']
  ],
  'One egg': [
    ['eggHeight', 0.05, 2.5, 0.01, 'height at the centre (m)'],
    ['eggHeightRim', 0.05, 2.5, 0.01, 'height at the rim (m)'],
    ['heightCurve', 0.2, 3, 0.01, 'height curve'],
    ['heightJitter', 0, 1, 0.01, 'height jitter'],
    ['eggRadius', 0.02, 1.2, 0.005, 'radius at the centre (m)'],
    ['eggRadiusRim', 0.02, 1.2, 0.005, 'radius at the rim (m)'],
    ['radiusCurve', 0.2, 3, 0.01, 'radius curve'],
    ['radiusJitter', 0, 1, 0.01, 'radius jitter'],
    ['eggTilt', 0, 1.2, 0.01, 'tilt (rad)'],
    ['eggSink', 0, 1, 0.01, 'bedded into the floor'],
    ['riseTime', 0.02, 2, 0.01, 'accretion time'],
    ['riseOvershoot', 0, 1.5, 0.01, 'overshoot'],
    ['settleTime', 0.05, 3, 0.01, 'settle'],
    ['springRate', 1, 40, 0.5, 'spring rate'],
    ['birthScale', 0.02, 1, 0.01, 'scale on appearing'],
    ['sinkDepth', 0, 3, 0.01, 'extra sink (m)']
  ],
  'One egg/Shell shape': [
    ['eggRings', 6, 28, 1, 'rings'],
    ['eggSides', 5, 24, 1, 'sides per half'],
    ['seamTear', 0, 0.6, 0.005, 'seam tear (rad)']
  ],
  'The hatch': [
    ['swellAt', 0, 0.9, 0.01, 'inflation starts'],
    ['splitAt', 0.05, 0.98, 0.01, 'seam gives'],
    ['splitSpan', 0.01, 0.8, 0.01, 'seam opening'],
    ['huskAt', 0.1, 1, 0.01, 'husk gone'],
    ['swell', 0, 2, 0.01, 'inflation'],
    ['swellCurve', 0.2, 5, 0.05, 'inflation curve'],
    ['bulge', 0, 1.5, 0.01, 'waist bulge'],
    ['stretch', 0, 1.5, 0.01, 'lengthening'],
    ['throb', 0, 0.4, 0.005, 'throb'],
    ['throbRate', 0, 24, 0.5, 'throb rate'],
    ['gape', 0, 3, 0.01, 'gape (rad)'],
    ['gapeSlide', 0, 0.8, 0.005, 'halves sliding apart'],
    ['gapeLift', 0, 0.6, 0.005, 'husk lift'],
    ['gapeCurve', 0.1, 3, 0.05, 'gape curve']
  ],
  'The shell': [
    ['veins', 0, 3, 0.01, 'veins'],
    ['veinScale', 0.5, 20, 0.1, 'vein features around'],
    ['veinBands', 0.2, 12, 0.1, 'vein features up'],
    ['veinSharp', 0, 1, 0.01, 'vein sharpness'],
    ['mottle', 0, 1.5, 0.01, 'mottle'],
    ['mottleScale', 0.2, 10, 0.1, 'mottle scale'],
    ['rimWidth', 0.02, 1, 0.01, 'torn lip width'],
    ['rimDark', 0, 1, 0.01, 'lip darkening'],
    ['rimGlow', 0, 6, 0.01, 'lip glow'],
    ['shellFresnel', 0, 4, 0.01, 'fresnel'],
    ['shellFresnelPower', 0.2, 8, 0.05, 'fresnel power'],
    ['thin', 0, 8, 0.05, 'translucency'],
    ['thinPower', 0.2, 10, 0.05, 'translucency power'],
    ['broodGlow', 0, 8, 0.05, 'brood glow'],
    ['broodRise', 0.2, 6, 0.05, 'brood reveal curve'],
    ['interiorGlow', 0, 4, 0.01, 'husk interior'],
    ['shellGlow', 0, 4, 0.01, 'master glow'],
    ['shellRoughness', 0, 1, 0.01, 'roughness'],
    ['shellEnv', 0, 3, 0.01, 'env intensity'],
    ['colorShell', 'crown'],
    ['colorBelly', 'belly'],
    ['colorVein', 'veins'],
    ['colorBrood', 'the thing inside'],
    ['colorRim', 'torn lip'],
    ['colorInterior', 'husk interior']
  ],
  'The crawlers': [
    ['crawlers', 0, 256, 1, 'agents'],
    ['crawlShape', 0, 4, 1, 'silhouette'],
    ['crawlHeight', 0, 0.6, 0.005, 'height off the floor (m)'],
    ['crawlSize', 0.02, 1, 0.005, 'size (m)'],
    ['crawlAspect', 0.3, 4, 0.01, 'aspect'],
    ['crawlSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['crawlSweep', 0, 2, 0.01, 'leg rake'],
    ['crawlDihedral', 0, 1, 0.01, 'leg fold'],
    ['crawlScuttle', 0, 40, 0.5, 'leg beats / second'],
    ['crawlBank', 0, 0.4, 0.005, 'bank'],
    ['crawlBankMax', 0, 2, 0.01, 'bank ceiling'],
    ['crawlLit', 0, 1, 0.01, 'lit vs emissive'],
    ['crawlEdgeGain', 0, 6, 0.05, 'edge-on gain'],
    ['crawlGlow', 0, 4, 0.01, 'glow'],
    ['crawlOpacity', 0, 1, 0.01, 'opacity'],
    ['crawlSoftFade', 0.02, 2, 0.01, 'soft intersection']
  ],
  'The crawlers/Movement': [
    ['crawlSpacing', 0.05, 2, 0.01, 'lateral spacing (m)'],
    ['crawlSpacingUp', 0.01, 1, 0.005, 'vertical spacing (m)'],
    ['crawlLatticeX', 1, 20, 1, 'cells across'],
    ['crawlLatticeY', 1, 8, 1, 'cells up'],
    ['crawlLatticeZ', 1, 24, 1, 'ranks behind'],
    ['crawlLag', 0, 2, 0.01, 'cohesion lag (s)'],
    ['crawlJitter', 0, 0.6, 0.005, 'slop (m)'],
    ['crawlChurn', 0, 4, 0.01, 'churn'],
    ['crawlBreathe', 0, 1, 0.01, 'breathe'],
    ['crawlBreatheRate', 0, 8, 0.05, 'breathe rate'],
    ['crawlWander', 0, 0.6, 0.005, 'wander (m)'],
    ['crawlWanderScale', 0.05, 4, 0.01, 'wander scale'],
    ['crawlWanderSpeed', 0, 4, 0.01, 'wander speed'],
    ['crawlGather', 0, 1, 0.01, 'gather'],
    ['crawlOrbitRadius', 0, 8, 0.05, 'lead orbit (m)'],
    ['crawlOrbitTurns', 0, 4, 0.01, 'lead turns'],
    ['crawlLeadRate', 0, 3, 0.01, 'lead rate'],
    ['crawlRevealSpread', 0.02, 1, 0.01, 'reveal spread'],
    ['crawlCondense', 0, 1, 0.01, 'hold on the ring'],
    ['crawlRing', 0.05, 2, 0.01, 'ring radius × zone'],
    ['crawlRingGrow', 0, 2, 0.01, 'ring growth × zone'],
    ['crawlRingThick', 0.02, 1.5, 0.01, 'ring section × zone'],
    ['crawlFill', 0, 1, 0.01, 'fill'],
    ['crawlSteps', 1, 4, 1, 'descent steps'],
    ['crawlSlack', 0.2, 1, 0.01, 'step slack'],
    ['crawlRough', 0, 0.6, 0.005, 'isosurface slop'],
    ['crawlSpin', -3, 3, 0.01, 'ring spin'],
    ['crawlTint', 0, 1, 0.01, 'gradient position'],
    ['crawlTintJitter', 0, 1, 0.01, 'gradient jitter'],
    ['crawlTintAlong', 0, 1, 0.01, 'head-to-tail walk'],
    ['colorCrawl*', 'Crawler colour']
  ],
  'The slick': [
    ['slickRadius', 0.2, 3, 0.01, 'radius × zone'],
    ['slickHeight', 0, 0.3, 0.002, 'hover height'],
    ['slickEdge', 0.02, 3, 0.01, 'front feather'],
    ['slickRagged', 0, 1, 0.01, 'front raggedness'],
    ['slickRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['slickWarp', 0, 3, 0.01, 'domain warp'],
    ['slickRelief', 0, 2, 0.01, 'relief'],
    ['slickCell', 0.05, 4, 0.01, 'puddle scale (m)'],
    ['slickLift', 0, 0.4, 0.002, 'ripple (m)'],
    ['slickDepth', 0, 1, 0.005, 'apparent depth (m)'],
    ['slickFlow', 0, 2, 0.01, 'drift'],
    ['slickSpeed', 0, 4, 0.01, 'ripple rate'],
    ['slickAmbient', 0, 1, 0.01, 'ambient'],
    ['slickSpecular', 0, 2, 0.01, 'specular'],
    ['slickGloss', 2, 128, 1, 'gloss'],
    ['slickDetail', 0, 1, 0.01, 'detail'],
    ['slickSharp', 0, 1, 0.01, 'sharpness'],
    ['slickEmissive', 0, 3, 0.01, 'emissive'],
    ['slickOpacity', 0, 1, 0.01, 'opacity'],
    ['slickDepthFade', 0.02, 3, 0.01, 'soft intersection'],
    ['slickDry', 0, 1, 0.01, 'drying back'],
    ['colorSlickBase', 'wet stone'],
    ['colorSlickEdge', 'meniscus'],
    ['colorSlickGlow', 'glow'],
    ['colorSlickDeep', 'bottom']
  ],
  'The goo': [
    ['gooRate', 0, 200, 1, 'rate'],
    ['gooBurst', 0, 120, 1, 'per hatch'],
    ['gooSize', 0.005, 0.4, 0.005, 'size'],
    ['gooSpeed', 0, 10, 0.05, 'speed'],
    ['gooLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['gooGravity', -40, 0, 0.5, 'gravity'],
    ['gooGlow', 0, 6, 0.01, 'glow'],
    ['colorGoo*', 'Goo colour']
  ],
  'The shell fragments': [
    ['chipBurst', 0, 40, 1, 'per hatch'],
    ['chipSize', 0.005, 0.4, 0.005, 'size'],
    ['chipSpeed', 0, 10, 0.05, 'speed'],
    ['chipLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['chipGravity', -40, 0, 0.5, 'gravity'],
    ['chipSpin', 0, 30, 0.5, 'spin'],
    ['colorChip*', 'Fragment colour']
  ],
  'The haze': [
    ['hazeRate', 0, 200, 1, 'rate'],
    ['hazeSize', 0.05, 4, 0.01, 'size'],
    ['hazeSpeed', 0, 5, 0.05, 'speed'],
    ['hazeLifetime', 0.2, 8, 0.05, 'lifetime'],
    ['hazeRise', -2, 3, 0.01, 'buoyancy'],
    ['hazeOpacity', 0, 1, 0.01, 'opacity'],
    ['colorHaze*', 'Haze colour']
  ],
  'Muzzle & landing': [
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['muzzleSize', 0.05, 4, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 4, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 1, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour'],
    ['burstSize', 0.2, 10, 0.05, 'landing shell'],
    ['burstIntensity', 0, 4, 0.01, 'shell intensity'],
    ['burstGoo', 0, 400, 1, 'goo on landing'],
    ['shockRadius', 0.2, 14, 0.05, 'ring'],
    ['impactShake', 0, 2, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 1, 0.01, 'screen flash'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['slickDecalRadius', 0.2, 3, 0.01, 'mat radius × zone'],
    ['slickDecalLife', 0.5, 20, 0.1, 'mat life'],
    ['slickDecalIntensity', 0, 3, 0.01, 'mat intensity'],
    ['colorBurstA', 'shell'],
    ['colorBurstB', 'shell body'],
    ['colorBurstC', 'shell motes'],
    ['colorFlash', 'landing flash colour'],
    ['colorMat', 'mat'],
    ['colorMatEdge', 'mat rim']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 4, 0.01, 'light height (m)'],
    ['lightPulse', 0, 1, 0.01, 'pulse depth'],
    ['lightPulseRate', 0.05, 8, 0.01, 'pulse rate'],
    ['lightColor', 'light colour']
  ]
};
