/* ================================================================== */
/* GROVECALL — verdant, far cast                                       */
/* ================================================================== */
/**
 * Six trees are called up out of the floor on the circle, and the sun comes
 * through them.
 *
 * The ability is about **scale contrast**, which is a specific and slightly
 * awkward thing to build: everything else in this sandbox is either ankle-high
 * or made of light, and a three-metre trunk only reads as three metres if
 * something in frame is obviously not. So the numbers below are deliberately
 * lopsided — `treeHeight` is an order of magnitude above the crystal field's
 * spikes, `riseTime` is half a second for all of it, and the leaves that shed
 * off the canopies are sized so that a leaf near the top of a trunk is a few
 * pixels. Wind `treeHeight` down to 1 and the whole cast stops working, which
 * is the clearest possible demonstration of what it is for.
 *
 * The **shafts are geometry**. Not a post-process god-ray, not a billboard: a
 * `Curtain` in SHAFT mode, anchored up at canopy height with `-frame.uLightDir`
 * as its up axis, so each sheet is a tapered translucent volume descending along
 * the stage's actual sun direction and terminating by *intersecting the floor*.
 * That is why they hold up when the camera orbits: you can walk round one and
 * see it edge-on, and the grazing term in the curtain shader flares it exactly
 * as a real column of lit dust would. Moving the stage's key light moves them.
 *
 * Everything with a unit below is resolved inside the update loop. A cast
 * captures the field's own record dice, the curtain's per-sheet dice, one seed,
 * and one timestamp per tree — the moment the bearing wave released it.
 */
export const grovecall = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  zoneRadius: 5.0, // radius of the far-cast circle, metres
  speed: 34.0, // how fast the call runs out to the circle, metres/second
  lifetime: 3.2, // seconds the grove stands
  fadeTime: 2.0, // seconds it takes to sink back
  cooldown: 2.0, // seconds before it can be cast again
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the grove --- */
  trees: 6, // trunks called up (hard ceiling 12)
  ringInner: 0.55, // 0..1 of `zoneRadius` — the inside of the band trees stand in
  ringOuter: 1.0, // ... and the outside
  radialCurve: 1.0, // <1 pushes the band toward the rim
  radialJitter: 0.35, // metres of radial wander
  angleJitter: 0.3, // radians of bearing wander
  sweepTime: 0.55, // seconds the wave takes to run all the way round the ring
  sweepStagger: 0.06, // extra seconds of random slop on that wave
  growTime: 0.5, // seconds a trunk takes to reach full height — THE number
  riseOvershoot: 0.18, // how far past full height the growth carries
  settle: 0.6, // seconds that overshoot damps out over
  springRate: 9.0, // radians/second of the overshoot ring
  emergeSink: 0.95, // fraction of its height a trunk is buried at emergence 0
  birthScale: 0.55, // footprint scale the instant it breaks the surface
  birthFade: 0.5, // seconds the sap flash decays over
  breachAt: 0.12, // emergence fraction that fires the roots and the soil
  sinkDepth: 1.2, // extra metres a sinking trunk drops beyond its own height

  /* --- how big they are --- */
  treeHeight: 3.0, // metres, the far side of the ring
  heightNear: 2.6, // metres, the inner side of the ring
  heightCurve: 1.0, // how the height ramps across the band
  heightJitter: 0.22, // ± fraction per tree
  treeRadius: 0.62, // metres — footprint radius of a canopy at the inner side
  treeRadius2: 0.72, // ... and at the rim
  radiusCurve: 1.0, // how the radius ramps across the band
  radiusJitter: 0.18, // ± fraction per tree
  lean: 0.1, // radians the trunks lean outward from the centre
  leanJitter: 0.8, // ± fraction
  leanOutward: 1.0, // weight of "out from the centre" in the lean direction
  // Small but not zero. A grove has no heading, so the obvious value here is 0
  // — but the two weights are normalised before use, and with one of them at
  // zero the other stops meaning anything at all: dragging `leanOutward` on a
  // standing grove does nothing, because a vector of any length pointing
  // radially outward normalises to the same vector. A twelfth of a turn's worth
  // of downrange bias makes the pair a real ratio again, and it reads as the
  // trees having grown away from whatever called them.
  leanForward: 0.12, // weight of "downrange" in the lean direction
  twist: 1.0, // 0..1 of a full turn of random yaw
  tilt: 0.06, // radians of extra random tip, any bearing

  /* --- the shape of one tree (rebuilds the geometry when it moves) --- */
  /**
   * A tapered trunk with branch stubs and a canopy of overlapping irregular
   * discs. Cheap and readable in silhouette is the whole brief: the canopy is
   * five shallow cones, not a sphere and not a billboard, because five cones at
   * random bearings have a ragged outline from every angle for about ninety
   * triangles, and that outline is the only thing that says "tree" at forty
   * metres.
   */
  treeSides: 5, // faces around the trunk, 3..8
  trunkTaper: 0.55, // >0 narrows the trunk toward the crown
  trunkBase: 0.19, // trunk radius at the ground, unit space (× the instance radius)
  trunkLean: 0.14, // 0..1 of a unit height the trunk's own axis wanders
  canopyBase: 0.52, // 0..1 up the tree where the crown starts
  branchStubs: 4, // branch stubs, 0..6
  branchLength: 0.3, // stub length, fraction of the unit height
  branchTilt: 0.45, // -1 points the stubs down, +1 straight up
  canopyDiscs: 5, // overlapping discs in the crown, 1..8
  canopyRadius: 0.34, // disc radius, unit space
  canopySpread: 0.16, // how far the discs are scattered off the axis, unit space
  canopyDome: 0.16, // how far a disc's middle lifts above its rim, unit space
  treeRough: 0.4, // 0..1 irregularity of the trunk facets and the disc rims

  /* --- bark and leaf --- */
  colorBark: '#4a3a28', // the lit face of the trunk
  colorBarkDeep: '#241b12', // the shadow in a bark furrow
  colorLeaf: '#5f8a2a', // the canopy in direct light
  colorLeafDeep: '#223a12', // the canopy in its own shade
  colorLeafGlow: '#a8d84a', // a leaf lit from behind — the translucency term
  colorSap: '#c8ff9a', // the flash as a trunk breaks the surface
  canopySplit: 0.5, // 0..1 up the tree where bark becomes leaf
  canopySoft: 0.06, // 0..1 feather on that boundary
  barkGrain: 0.6, // 0..1 depth of the furrows
  barkScale: 7.0, // furrow cycles per metre, world space
  leafMottle: 0.65, // 0..1 how broken up the canopy colour is
  leafScale: 3.4, // mottle cycles per unit height, local space
  backlight: 1.6, // gain on the leaf translucency
  backlightSharp: 2.4, // exponent on it — higher keeps it to the rim of the sun
  leafRough: 0.82, // surface roughness of the standard material
  sapGlow: 2.2, // emissive gain on the birth flash
  groveGlow: 1.0, // master emissive gain
  groveOpacity: 1.0,

  /* --- the light shafts --- */
  /**
   * `shaftTop` is where the sheets are anchored — canopy height. They then run
   * **down** the sun direction for `shaftTop / lightDir.y` metres, times
   * `shaftOvershoot`, which is how they arrive at the floor no matter where the
   * stage's key light is pointing. `shaftOvershoot` above 1 pushes them through
   * the floor so they terminate on the intersection rather than in mid-air; that
   * is the single most important number here and it is why the ability does not
   * need a fake pool decal on the ground.
   */
  shafts: 9, // sheets (hard ceiling 16)
  shaftTop: 3.1, // metres above the floor the shafts start at
  shaftOvershoot: 1.18, // × the geometric drop to the floor
  shaftSpread: 0.9, // 0..1 of `zoneRadius` the shafts are scattered over
  shaftScatter: 0.5, // metres of extra hashed slop off that scatter
  shaftWidth: 1.5, // metres across a sheet at the canopy
  shaftWidthJitter: 0.35, // ± fraction
  shaftHeightJitter: 0.12, // ± fraction of the computed drop
  shaftTaper: 1.45, // width multiplier where it meets the floor — >1 splays
  shaftLean: 0.35, // metres the foot of the shaft is pushed sideways
  shaftLeanJitter: 0.7, // ± fraction
  shaftRiseSpread: 0.5, // 0..1 stagger of the shafts appearing
  shaftCore: 0.42, // 0..1 of the half-width the bright core covers
  shaftCanopy: 0.38, // 0..1 threshold — how much light gets past the leaves
  shaftCanopySoft: 0.3, // 0..1 feather on that gate
  shaftCanopyScale: 0.7, // gap cycles per metre along the sheet
  shaftMote: 0.85, // 0..1 the dust hanging in the shaft
  shaftMoteScale: 2.0, // motes per metre
  shaftMoteSize: 0.055, // metres
  shaftMoteDrift: 0.05, // metres/second the motes settle
  shaftRipple: 0.1, // metres of travelling ripple across a shaft
  shaftRippleLength: 3.0, // metres, crest to crest
  shaftRippleSpeed: 0.35, // metres/second
  shaftFold: 0.16, // metres of the second, longer fold
  shaftFoldLength: 7.0, // metres
  shaftFoldSpeed: 0.2, // metres/second
  shaftBody: 0.1, // 0..1 how much α a shaft is allowed at all — keep it low
  shaftAlphaBase: 1.0, // coverage at the canopy end
  shaftAlphaTop: 0.15, // coverage at the floor end
  shaftAlphaCurve: 2.4, // exponent between them
  shaftEmissionBase: 1.1, // radiance at the canopy end
  shaftEmissionTop: 0.4, // radiance at the floor end
  shaftEmissionCurve: 0.7, // DELIBERATELY not `shaftAlphaCurve` — see Curtain.js
  shaftFootFade: 0.04, // 0..1 of the length
  shaftHeadFade: 0.18, // 0..1 of the length
  shaftEdgeFade: 0.3, // 0..1 across a sheet
  shaftGraze: 1.0, // 0..1 how much of the 1/|N·V| path term is applied
  shaftGrazeFloor: 0.1, // clamp on |N·V|
  shaftSoftFade: 0.4, // metres of depth fade against opaque geometry
  shaftGlow: 1.35, // emissive gain
  shaftOpacity: 1.0,
  shaftTintSpread: 0.3, // 0..1 how far apart neighbouring shafts are tinted
  colorShaft: '#e8f0c0', // the core of a shaft
  colorShaftEdge: '#8aa85f', // its outside
  colorShaftMote: '#fffbe0', // the dust in it
  colorShaftBody: '#2a3418', // what little it occludes with

  /* --- leaves shed off the canopies --- */
  /**
   * Four-stop lifetime gradient, `A` at birth through `D` as it dies, spelled
   * out rather than derived from the canopy palette — the whole point is that
   * the litter browns off while the grove stays green.
   */
  leafRate: 34, // leaves shed per second across the whole grove
  leafBurst: 14, // extra shed by each tree as its canopy opens
  leafSize: 0.14,
  leafSpeed: 1.1, // metres/second
  leafLifetime: 3.4, // seconds — long: they have three metres to fall
  leafGravity: -1.5, // metres/second²; light enough to flutter
  leafSpin: 3.2, // radians/second of tumble
  leafDrift: 0.7, // turbulence multiplier
  colorLeafA: '#a8d84a',
  colorLeafB: '#6f9a32',
  colorLeafC: '#8a7a2a',
  colorLeafD: '#3a2e14',

  /* --- pollen hanging in the shafts --- */
  pollenRate: 40, // particles/second
  pollenSize: 0.045,
  pollenSpeed: 0.5, // metres/second
  pollenLifetime: 4.0, // seconds
  pollenRise: 0.28, // upward drift, metres/second
  pollenTurbulence: 0.6,
  colorPollenA: '#fffbe0',
  colorPollenB: '#e8f0c0',
  colorPollenC: '#a8b86a',
  colorPollenD: '#3a4020',

  /* --- soil thrown up by the roots --- */
  soilBreach: 26, // chips per trunk breaking the surface
  soilSize: 0.09,
  soilSpeed: 4.5, // metres/second
  soilLifetime: 1.3, // seconds
  soilGravity: -16.0, // metres/second²
  colorSoilA: '#4a3a26',
  colorSoilB: '#33281a',
  colorSoilC: '#241c12',
  colorSoilD: '#171009',

  /* --- what the floor does --- */
  rootRadius: 1.5, // metres — the crack the roots open at a trunk
  rootLife: 7.0, // seconds it lingers
  rootWidth: 0.14, // thickness of the split
  rootIntensity: 0.85,
  colorRootA: '#1a1408', // the dark of the split
  colorRootB: '#6f9a32', // the growth glowing out of it
  duffRadius: 1.7, // metres — the litter ring around a trunk
  duffLife: 6.0, // seconds
  duffIntensity: 0.5,
  colorDuffA: '#3a2e18',
  colorDuffB: '#5f6a34',
  callRate: 0.5, // root cracks laid per metre while the call runs out
  callRadius: 0.55, // metres — one of those
  callLife: 2.4, // seconds

  /* --- the moment the grove arrives --- */
  burstSize: 3.4, // the shell of thrown growth at the centre, metres
  burstIntensity: 1.0,
  burstLeaves: 120, // extra leaves thrown at the call
  burstSoil: 60, // extra soil thrown at the call
  impactShake: 0.75,
  shakeDuration: 0.8, // seconds
  impactFlash: 0.12, // screen flash as the grove lands
  rumble: 0.05, // continuous shake while the call runs out
  colorBurstA: '#3a5a1a', // shell body
  colorBurstB: '#6f9a32',
  colorBurstC: '#c8ff9a', // the filaments and the fresnel rim — this carries it
  colorFlash: '#c8ff9a', // the full-screen flash

  /* --- dynamic light --- */
  lightIntensity: 14.0,
  lightRadius: 13.0, // metres
  lightColor: '#a8d060'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Grovecall.
 *
 * Four controls carry it. `treeHeight` and `growTime` are the scale contrast —
 * three metres in half a second, and both of them are wrong in an interesting
 * way the moment you move either. `sweepTime` is whether the grove arrives as a
 * wave or as an event. `shaftOvershoot` is whether the light reaches the ground.
 *
 * Everything in *The tree's shape* rebuilds three instanced meshes when it
 * moves. A tree is about four hundred triangles and there are three of them; the
 * rebuild is cheaper than the branch that would avoid it, and it is what keeps
 * `canopyDiscs` a slider you can drag rather than a constant you have to reload
 * the page to change.
 */
export const grovecallSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['zoneRadius', 1, 16, 0.1, 'circle radius'],
    ['speed', 4, 140, 0.5, 'call speed'],
    ['lifetime', 0.2, 12, 0.05, 'standing time'],
    ['fadeTime', 0.2, 8, 0.05, 'sink time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The grove': [
    ['trees', 1, 12, 1, 'trunks'],
    ['ringInner', 0, 1.2, 0.01, 'band, inner'],
    ['ringOuter', 0.1, 1.4, 0.01, 'band, outer'],
    ['radialCurve', 0.2, 4, 0.01, 'band curve'],
    ['radialJitter', 0, 3, 0.05, 'radial wander'],
    ['angleJitter', 0, 1.5, 0.01, 'bearing wander'],
    ['sweepTime', 0, 3, 0.01, 'wave around the ring'],
    ['sweepStagger', 0, 1, 0.01, 'wave slop'],
    ['growTime', 0.05, 3, 0.01, 'time to full height'],
    ['riseOvershoot', 0, 1, 0.01, 'overshoot'],
    ['settle', 0.05, 3, 0.01, 'settle time'],
    ['springRate', 1, 30, 0.5, 'spring rate'],
    ['emergeSink', 0, 1.5, 0.01, 'buried depth'],
    ['birthScale', 0.05, 1, 0.01, 'birth scale'],
    ['birthFade', 0.05, 2, 0.01, 'sap flash time'],
    ['breachAt', 0.02, 1, 0.01, 'breach point'],
    ['sinkDepth', 0, 6, 0.05, 'sink depth']
  ],
  'How big they are': [
    ['treeHeight', 0.3, 8, 0.05, 'height at the rim'],
    ['heightNear', 0.3, 8, 0.05, 'height inside'],
    ['heightCurve', 0.2, 4, 0.01, 'height curve'],
    ['heightJitter', 0, 1, 0.01, 'height jitter'],
    ['treeRadius', 0.05, 2.5, 0.01, 'spread inside'],
    ['treeRadius2', 0.05, 2.5, 0.01, 'spread at the rim'],
    ['radiusCurve', 0.1, 3, 0.01, 'spread curve'],
    ['radiusJitter', 0, 1, 0.01, 'spread jitter'],
    ['lean', 0, 1, 0.01, 'lean'],
    ['leanJitter', 0, 2, 0.01, 'lean jitter'],
    ['leanOutward', -1, 2, 0.01, 'lean outward'],
    ['leanForward', -1, 2, 0.01, 'lean downrange'],
    ['twist', 0, 1, 0.01, 'random yaw'],
    ['tilt', 0, 0.6, 0.01, 'random tip']
  ],
  "The tree's shape": [
    ['treeSides', 3, 8, 1, 'trunk faces'],
    ['trunkTaper', 0, 2, 0.01, 'trunk taper'],
    ['trunkBase', 0.03, 0.45, 0.005, 'trunk thickness'],
    ['trunkLean', 0, 0.5, 0.005, 'trunk wander'],
    ['canopyBase', 0.1, 0.95, 0.01, 'crown starts at'],
    ['branchStubs', 0, 6, 1, 'branch stubs'],
    ['branchLength', 0.02, 0.6, 0.005, 'stub length'],
    ['branchTilt', -1, 1, 0.01, 'stub tilt'],
    ['canopyDiscs', 1, 8, 1, 'canopy discs'],
    ['canopyRadius', 0.05, 0.5, 0.005, 'disc radius'],
    ['canopySpread', 0, 0.3, 0.005, 'disc scatter'],
    ['canopyDome', 0, 0.4, 0.005, 'disc dome'],
    ['treeRough', 0, 1, 0.01, 'roughness']
  ],
  'Bark & leaf': [
    ['colorBark', 'bark'],
    ['colorBarkDeep', 'bark furrow'],
    ['colorLeaf', 'canopy, lit'],
    ['colorLeafDeep', 'canopy, shaded'],
    ['colorLeafGlow', 'canopy, backlit'],
    ['colorSap', 'sap flash'],
    ['canopySplit', 0.1, 0.95, 0.01, 'bark / leaf line'],
    ['canopySoft', 0.005, 0.4, 0.005, 'line feather'],
    ['barkGrain', 0, 1.5, 0.01, 'furrow depth'],
    ['barkScale', 0.5, 24, 0.1, 'furrows / metre'],
    ['leafMottle', 0, 1.5, 0.01, 'canopy mottle'],
    ['leafScale', 0.2, 12, 0.05, 'mottle scale'],
    ['backlight', 0, 6, 0.05, 'backlight'],
    ['backlightSharp', 0.2, 8, 0.05, 'backlight sharpness'],
    ['leafRough', 0.05, 1, 0.01, 'surface roughness'],
    ['sapGlow', 0, 8, 0.05, 'sap glow'],
    ['groveGlow', 0, 4, 0.01, 'grove glow'],
    ['groveOpacity', 0.1, 1, 0.01, 'grove opacity']
  ],
  'The light shafts': [
    ['shafts', 0, 16, 1, 'shafts'],
    ['shaftTop', 0.2, 8, 0.05, 'anchored at'],
    ['shaftOvershoot', 0.2, 2.5, 0.01, 'reach past the floor'],
    ['shaftSpread', 0, 1.6, 0.01, 'scatter radius'],
    ['shaftScatter', 0, 3, 0.05, 'scatter slop'],
    ['shaftWidth', 0.1, 8, 0.05, 'width'],
    ['shaftWidthJitter', 0, 1, 0.01, 'width jitter'],
    ['shaftHeightJitter', 0, 1, 0.01, 'length jitter'],
    ['shaftTaper', 0.1, 3, 0.01, 'splay at the floor'],
    ['shaftLean', -3, 3, 0.05, 'lean'],
    ['shaftLeanJitter', 0, 2, 0.01, 'lean jitter'],
    ['shaftRiseSpread', 0, 0.95, 0.01, 'arrival stagger'],
    ['shaftCore', 0.05, 1.5, 0.01, 'core width'],
    ['shaftCanopy', 0, 1, 0.01, 'canopy gate'],
    ['shaftCanopySoft', 0.01, 1, 0.01, 'gate feather'],
    ['shaftCanopyScale', 0.05, 4, 0.01, 'gaps / metre'],
    ['shaftMote', 0, 3, 0.01, 'dust'],
    ['shaftMoteScale', 0.2, 8, 0.05, 'motes / metre'],
    ['shaftMoteSize', 0.005, 0.3, 0.005, 'mote size'],
    ['shaftMoteDrift', -1, 1, 0.005, 'mote drift']
  ],
  'The light shafts/Drawing': [
    ['shaftRipple', 0, 2, 0.01, 'ripple'],
    ['shaftRippleLength', 0.2, 12, 0.05, 'ripple length'],
    ['shaftRippleSpeed', -4, 4, 0.01, 'ripple speed'],
    ['shaftFold', 0, 2, 0.01, 'fold'],
    ['shaftFoldLength', 0.5, 24, 0.1, 'fold length'],
    ['shaftFoldSpeed', -4, 4, 0.01, 'fold speed'],
    ['shaftBody', 0, 1, 0.005, 'occlusion'],
    ['shaftAlphaBase', 0, 2, 0.01, 'coverage at canopy'],
    ['shaftAlphaTop', 0, 2, 0.01, 'coverage at floor'],
    ['shaftAlphaCurve', 0.1, 6, 0.05, 'coverage curve'],
    ['shaftEmissionBase', 0, 3, 0.01, 'radiance at canopy'],
    ['shaftEmissionTop', 0, 3, 0.01, 'radiance at floor'],
    ['shaftEmissionCurve', 0.1, 6, 0.05, 'radiance curve'],
    ['shaftFootFade', 0, 0.5, 0.005, 'canopy-end fade'],
    ['shaftHeadFade', 0, 0.8, 0.005, 'floor-end fade'],
    ['shaftEdgeFade', 0, 1, 0.01, 'edge fade'],
    ['shaftGraze', 0, 1, 0.01, 'grazing term'],
    ['shaftGrazeFloor', 0.02, 1, 0.005, 'grazing clamp'],
    ['shaftSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['shaftGlow', 0, 5, 0.01, 'glow'],
    ['shaftOpacity', 0, 2, 0.01, 'opacity'],
    ['shaftTintSpread', 0, 1, 0.01, 'tint spread'],
    ['colorShaft', 'shaft core'],
    ['colorShaftEdge', 'shaft edge'],
    ['colorShaftMote', 'shaft dust'],
    ['colorShaftBody', 'shaft occlusion']
  ],
  'Leaves & pollen': [
    ['leafRate', 0, 300, 1, 'leaf rate'],
    ['leafBurst', 0, 120, 1, 'leaves / canopy'],
    ['leafSize', 0.005, 0.6, 0.005, 'leaf size'],
    ['leafSpeed', 0, 8, 0.05, 'leaf speed'],
    ['leafLifetime', 0.2, 10, 0.05, 'leaf lifetime'],
    ['leafGravity', -12, 0, 0.05, 'leaf gravity'],
    ['leafSpin', 0, 15, 0.05, 'leaf tumble'],
    ['leafDrift', 0, 3, 0.01, 'leaf drift'],
    ['pollenRate', 0, 300, 1, 'pollen rate'],
    ['pollenSize', 0.005, 0.4, 0.005, 'pollen size'],
    ['pollenSpeed', 0, 6, 0.05, 'pollen speed'],
    ['pollenLifetime', 0.2, 10, 0.05, 'pollen lifetime'],
    ['pollenRise', -2, 4, 0.01, 'pollen rise'],
    ['pollenTurbulence', 0, 3, 0.01, 'pollen turbulence'],
    ['colorLeaf*', 'Leaf colour'],
    ['colorPollen*', 'Pollen colour']
  ],
  'Roots & soil': [
    ['soilBreach', 0, 120, 1, 'soil / trunk'],
    ['soilSize', 0.005, 0.4, 0.005, 'soil size'],
    ['soilSpeed', 0, 18, 0.05, 'soil speed'],
    ['soilLifetime', 0.1, 5, 0.05, 'soil lifetime'],
    ['soilGravity', -40, 0, 0.1, 'soil gravity'],
    ['rootRadius', 0.1, 6, 0.05, 'root crack radius'],
    ['rootLife', 0.5, 20, 0.1, 'root crack lifetime'],
    ['rootWidth', 0.01, 0.6, 0.005, 'root crack width'],
    ['rootIntensity', 0, 3, 0.01, 'root crack intensity'],
    ['duffRadius', 0.1, 6, 0.05, 'litter radius'],
    ['duffLife', 0.2, 15, 0.1, 'litter lifetime'],
    ['duffIntensity', 0, 3, 0.01, 'litter intensity'],
    ['callRate', 0.05, 5, 0.05, 'cracks / metre'],
    ['callRadius', 0.05, 3, 0.05, 'call crack radius'],
    ['callLife', 0.2, 10, 0.1, 'call crack lifetime'],
    ['colorRootA', 'root dark'],
    ['colorRootB', 'root growth'],
    ['colorDuffA', 'litter body'],
    ['colorDuffB', 'litter rim'],
    ['colorSoil*', 'Soil colour']
  ],
  'The arrival': [
    ['burstSize', 0.2, 14, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['burstLeaves', 0, 500, 1, 'burst leaves'],
    ['burstSoil', 0, 400, 1, 'burst soil'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'call rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst filaments'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
