/* ================================================================== */
/* BONE CAGE — blood, far cast                                         */
/* ================================================================== */
/**
 * The slot that exists to prove a school is not a palette.
 *
 * Crimson Tide is the other blood zone cast and it is viscous, wet, red and
 * self-lit. This is bone, and every one of those four is inverted deliberately:
 *
 * | Crimson Tide | Bone Cage |
 * | --- | --- |
 * | a specular sheen keyed off the surface normal | no sheen term at all |
 * | roughness pulled *down* in the wet grooves | `boneRoughness` pinned at 0.94 and pushed **up** in the pits |
 * | emissive sap glowing in the dark | scatter clamped by `sssCeiling`, below the bloom threshold |
 * | a fresnel rim brightening the silhouette | `boneChalk`, a fresnel-shaped curve on the **albedo** |
 *
 * The last of those is the one worth understanding, because it is the whole
 * difference between chalk and matte plastic. A dielectric gets shinier at
 * grazing incidence. A porous mineral gets *lighter*: light that would have
 * refracted into a smooth surface is scattered straight back out of the pores a
 * fraction of a millimetre away instead. So the fresnel curve is applied to
 * `diffuseColor` and nothing at all is added to the specular lobe. Take
 * `boneChalk` to zero under the same lights and the ribs turn into grey rubber.
 *
 * `sssStrength` is the warmth — the cheap back-scatter transmission term,
 * modulated by a thickness field that is genuinely thin near the tips, near the
 * silhouettes and wherever the trabecular noise says the interior is open. It
 * is the one warm thing in a bleached object, and it is what stops the cage
 * reading as plaster. It is also **capped**, in the shader, by `sssCeiling`,
 * because bone is lit and bone does not glow — and that is enforced rather than
 * trusted to the tuning staying sensible. Turning `global.glow` up cannot make
 * this material bloom.
 *
 * The shape of the cage is one slider: `GrowthField` scales an instance's lean
 * by its own radial fraction, so `ribLeanShut` lays the rim over hard and
 * leaves the middle standing nearly upright, and the ring becomes a dome. The
 * ribs are straight — see `createBoneRibGeometry` for the rotation arithmetic
 * that forced that, and for what a baked-in sickle actually looked like.
 *
 * Four draw calls: three rib silhouettes and a `GroundField(POCK)` carrying one
 * crater per rib.
 */
export const bonecage = {
  /* --- the cast --- */
  range: 16.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 26.0, // how fast the call runs to the circle, metres/second
  cooldown: 2.0, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 5.0, // the footprint the indicator draws, metres

  /* --- the beats, all seconds --- */
  raiseTime: 0.75, // the ring coming up, rim first
  closeTime: 1.2, // it laying over into a dome
  holdTime: 4.2, // it standing
  crumbleTime: 2.6, // it going back under

  /* --- the ring --- */
  ribCount: 60, // how many ribs. 288 is the field's hard ceiling
  ribRing: 1.0, // outer radius, × zoneRadius
  ribInner: 0.34, // inner radius, × zoneRadius — 0 fills the disc with spikes
  ribRadialCurve: 0.85, // <1 pushes the band toward the rim
  ribRadialJitter: 0.22, // metres of radial wander
  ribAngleJitter: 0.5, // radians of bearing wander
  riseStagger: 0.35, // seconds of random delay between neighbours

  /* --- one rib, in metres --- */
  ribLength: 3.4, // at the rim
  ribLengthInner: 1.5, // at the inner radius
  ribLengthCurve: 1.0, // how late the ramp climbs
  ribLengthJitter: 0.22, // ± fraction
  ribGirth: 0.34, // base radius at the rim
  ribGirthInner: 0.2, // at the inner radius
  ribGirthCurve: 0.7,
  ribGirthJitter: 0.28, // ± fraction

  /* --- how it lays over --- */
  ribLeanOpen: 0.16, // radians inward at the moment it breaks the floor
  ribLeanShut: 1.15, // radians inward once the cage is closed
  ribLeanJitter: 0.16, // ± fraction
  ribLeanRamp: 0.82, // 0 leans everything alike, 1 only leans the rim
  ribRoll: 0.55, // 0..1 of a full turn of random roll about its own axis
  ribTilt: 0.13, // radians of extra random tip, any bearing

  /* --- the eruption --- */
  ribRiseTime: 0.26, // seconds from buried to full height
  ribOvershoot: 0.2, // how far past full height the punch carries
  ribSettle: 0.45, // seconds the overshoot damps out over
  ribSpring: 15.0, // radians/second of that overshoot ring
  ribSink: 0.9, // fraction of its height a rib is buried at emergence 0
  ribBirthScale: 0.88, // footprint scale the moment it breaks through
  ribBirthFade: 0.55, // seconds the grime on a fresh rib takes to shed
  ribBreachAt: 0.22, // emergence fraction that cracks the floor
  ribSinkDepth: 0.5, // extra metres it drops as the cage goes back under

  /* --- the rib's silhouette (rebuilt only when one of these moves) --- */
  ribSides: 7, // facets around the section
  ribRings: 12, // rings up its length
  ribFlatten: 0.44, // 0..1 how much the section is a blade rather than a rod
  ribTwist: 0.18, // turns of the section along the length
  ribGroove: 0.3, // 0..1 depth of the costal groove down one face
  ribHead: 1.05, // the articular bulb, × the shaft
  ribNeck: 0.52, // the pinch above it — the stroke that says "jointed"
  ribShaft: 0.7, // the blade
  ribTaper: 0.1, // the tip
  ribKnuckle: 0.2, // the sternal swell before the end
  ribWarp: 0.28, // 0..1 surface irregularity. 0 is a lathe

  /* --- the bone itself --- */
  boneRoughness: 0.94, // chalk. There is deliberately no wet value to mix to
  boneRoughnessPit: 0.4, // extra roughness inside a pit
  boneEnv: 0.25, // envMapIntensity — low, because bone reflects almost nothing
  boneOpacity: 1.0,
  boneGrain: 0.35, // Haversian grain, running up the bone
  boneGrainScale: 6.5, // along-frequency
  boneGrainBands: 2.2, // around-frequency — must stay well under the along one
  bonePit: 0.45, // trabecular pitting
  bonePitScale: 24.0, // cycles per metre, world space, so ribs match each other
  bonePitCut: 0.55, // 0..1 how sparse the pits are
  boneChalk: 0.55, // the anti-fresnel. Zero makes it grey rubber
  boneChalkPower: 2.6, // how tight to the silhouette that lift sits
  stainAmount: 0.7, // 0..1 how dark the earth stain at the buried end is
  stainHeight: 0.26, // 0..1 of the rib it reaches. A rib stained end to end is painted
  grimeAmount: 0.85, // 0..1 how filthy a rib is the moment it breaks the floor
  colorBone: '#e8dcc4', // cortex
  colorBoneShade: '#a8977c', // grain and the inside of a pit
  colorMarrow: '#e0745a', // the warm thing the scatter is made of
  colorStain: '#6b5a44', // earth, at the buried end only
  colorGrime: '#4a4238', // the floor a fresh rib comes up wearing

  /* --- subsurface scatter --- */
  sssStrength: 0.9,
  sssPower: 3.2, // tightness of the back-scatter lobe
  sssDistort: 0.35, // how much the normal bends the transmission direction
  sssAmbient: 0.18, // the part that survives with no key behind it
  sssCeiling: 0.5, // hard clamp. This is the anti-glow contract for the slot
  sssThinBase: 0.15, // thickness at the buried end, 0..1 (1 = paper)
  sssThinEdge: 0.65, // how much the silhouette counts as thin

  /* --- the crumble --- */
  witherDepth: 1.0, // 0..1 how far the scatter is drained as it dies
  crumbleFade: 0.6, // 0..1 of the opacity lost on the way down

  /* --- the cracked floor --- */
  floorRadius: 1.08, // × zoneRadius
  floorHeight: 0.014, // metres above the floor the quad sits at
  floorEdge: 0.5, // metres of feather at the boundary
  floorRagged: 0.3, // how far that boundary wanders, × the radius
  floorRaggedScale: 0.55, // lobes per metre
  floorWarp: 0.6, // metres of domain warp on those lobes
  floorRelief: 0.85, // how hard the height field tilts the fake normal
  floorNormalStep: 0.05, // metres between the height taps
  floorAmbient: 0.3,
  floorSpecular: 0.18, // dry. A shiny crater is a wet crater
  floorGloss: 16,
  floorParallax: 0.3, // metres of view-driven offset inside a crater
  floorCell: 0.4, // metres — the grain
  floorLift: 0.06, // metres — rim height
  floorDepth: 0.16, // metres — crater depth
  floorDetail: 0.6,
  floorSharp: 0.55,
  floorSpeed: 1.0, // dig rate
  floorMarkLife: 9.0, // seconds a crater weathers away over
  floorMarkRadius: 0.55, // metres, a full-strength crater
  floorEmissive: 0.0, // zero, and it stays zero: POCK's glow channel is ember
  floorOpacity: 0.9,
  floorDepthFade: 0.5, // metres of soft fade against standing geometry
  colorFloorBase: '#4a4640', // broken flagstone
  colorFloorEdge: '#8f887c', // the rim thrown up around a hole
  colorFloorGlow: '#000000', // nothing here is hot
  colorFloorDeep: '#100e0c', // the bottom of the hole

  /* --- the chips a rib throws as it comes through --- */
  breachGrit: 9, // chips per rib
  gritSpeed: 3.4, // metres/second
  gritLifetime: 1.5, // seconds
  gritGravity: -13.0, // metres/second²
  gritSize: 0.075,
  colorGritA: '#8f877a', // birth
  colorGritB: '#615b52', // early
  colorGritC: '#3a3630', // late
  colorGritD: '#181614', // death

  /* --- stone and bone dust --- */
  breachDust: 5, // puffs per rib
  dustRate: 14.0, // per second off a standing cage
  dustBirthHeight: 0.06, // metres
  dustSpeed: 1.1, // metres/second
  dustLifetime: 2.8, // seconds
  dustSize: 0.6,
  dustRise: 0.35, // metres/second²
  dustOpacity: 0.24,
  colorDustA: '#b8ae9c', // birth
  colorDustB: '#877e70', // early
  colorDustC: '#4e483f', // late
  colorDustD: '#1c1a17', // death

  /* --- the hand, and the one-shot --- */
  handHeight: 1.2, // metres
  handForward: 0.5, // metres down the heading
  handSide: 0.32, // metres lateral
  muzzleSize: 0.6,
  muzzleIntensity: 0.7,
  castFlash: 0.04, // screen flash on release
  colorCastFlash: '#c8b89c',
  burstSize: 3.2, // the pressure shell as the ring comes up
  burstIntensity: 0.6,
  impactShake: 0.4,
  shakeDuration: 0.8, // seconds
  impactFlash: 0.06,
  rumble: 0.03, // travel rumble
  colorBurstA: '#d8ccb4',
  colorBurstB: '#6b6252',
  colorBurstC: '#f0e4cc',
  colorFlash: '#d8c4a8',

  /* --- the dynamic light --- */
  lightIntensity: 7.0,
  lightRadius: 9.0, // metres
  lightHeight: 0.35, // metres — on the floor, inside the cage
  lightSmother: 0.5, // 0..1 how much the closing cage puts it out
  lightColor: '#f8c0b0'
};

/** Editor layout. */
export const bonecageSchema = {
  'The cast': ['range', 'minRange', 'speed', 'cooldown', 'castAnim', ['zoneRadius', 1, 12, 0.1, 'zone radius (m)']],
  'The beats': [
    ['raiseTime', 0.1, 4, 0.05, 'raise (s)'],
    ['closeTime', 0.1, 6, 0.05, 'close (s)'],
    ['holdTime', 0.2, 16, 0.1, 'hold (s)'],
    ['crumbleTime', 0.2, 12, 0.1, 'crumble (s)']
  ],
  'The ring': [
    ['ribCount', 4, 240, 1, 'ribs'],
    ['ribRing', 0.2, 2, 0.01, 'outer radius (× zone)'],
    ['ribInner', 0, 1, 0.01, 'inner radius (× zone)'],
    ['ribRadialCurve', 0.2, 3, 0.01, 'radial bunching'],
    ['ribRadialJitter', 0, 2, 0.01, 'radial wander (m)'],
    ['ribAngleJitter', 0, 2, 0.01, 'bearing wander (rad)'],
    ['riseStagger', 0, 2, 0.01, 'stagger (s)']
  ],
  'One rib': [
    ['ribLength', 0.2, 8, 0.05, 'length at rim (m)'],
    ['ribLengthInner', 0.1, 6, 0.05, 'length inside (m)'],
    ['ribLengthCurve', 0.2, 3, 0.01, 'length ramp'],
    ['ribLengthJitter', 0, 1, 0.01, 'length jitter'],
    ['ribGirth', 0.02, 1.5, 0.01, 'girth at rim (m)'],
    ['ribGirthInner', 0.02, 1.5, 0.01, 'girth inside (m)'],
    ['ribGirthCurve', 0.2, 3, 0.01, 'girth ramp'],
    ['ribGirthJitter', 0, 1, 0.01, 'girth jitter']
  ],
  'The close': [
    ['ribLeanOpen', -0.5, 1.6, 0.01, 'lean at breach (rad)'],
    ['ribLeanShut', -0.5, 1.8, 0.01, 'lean when shut (rad)'],
    ['ribLeanJitter', 0, 1, 0.01, 'lean jitter'],
    ['ribLeanRamp', 0, 1, 0.01, 'rim-only lean'],
    ['ribRoll', 0, 1, 0.01, 'random roll'],
    ['ribTilt', 0, 1, 0.01, 'random tip (rad)']
  ],
  'The eruption': [
    ['ribRiseTime', 0.02, 2, 0.01, 'rise (s)'],
    ['ribOvershoot', 0, 1, 0.01, 'overshoot'],
    ['ribSettle', 0.05, 3, 0.01, 'settle (s)'],
    ['ribSpring', 2, 40, 0.5, 'spring rate'],
    ['ribSink', 0, 1.5, 0.01, 'buried depth'],
    ['ribBirthScale', 0.2, 1.2, 0.01, 'birth scale'],
    ['ribBirthFade', 0.05, 3, 0.01, 'grime shed (s)'],
    ['ribBreachAt', 0.02, 1, 0.01, 'breach at'],
    ['ribSinkDepth', 0, 3, 0.01, 'sink depth (m)']
  ],
  'The rib silhouette': [
    ['ribSides', 4, 14, 1, 'facets'],
    ['ribRings', 5, 24, 1, 'rings'],
    ['ribFlatten', 0, 0.9, 0.01, 'blade flatten'],
    ['ribTwist', -1, 1, 0.01, 'section twist'],
    ['ribGroove', 0, 0.8, 0.01, 'costal groove'],
    ['ribHead', 0.2, 2, 0.01, 'articular head'],
    ['ribNeck', 0.05, 1.5, 0.01, 'neck'],
    ['ribShaft', 0.1, 1.5, 0.01, 'shaft'],
    ['ribTaper', 0.02, 0.8, 0.01, 'tip'],
    ['ribKnuckle', 0, 0.8, 0.01, 'sternal knuckle'],
    ['ribWarp', 0, 1, 0.01, 'irregularity']
  ],
  'The bone': [
    ['boneRoughness', 0.2, 1, 0.01, 'roughness'],
    ['boneRoughnessPit', 0, 0.6, 0.01, 'pit roughness'],
    ['boneEnv', 0, 2, 0.01, 'env intensity'],
    ['boneOpacity', 0, 1, 0.01, 'opacity'],
    ['boneChalk', 0, 2, 0.01, 'chalk (anti-fresnel)'],
    ['boneChalkPower', 0.2, 8, 0.05, 'chalk tightness'],
    ['boneGrain', 0, 1, 0.01, 'grain'],
    ['boneGrainScale', 0.5, 24, 0.1, 'grain along'],
    ['boneGrainBands', 0.2, 12, 0.1, 'grain around'],
    ['bonePit', 0, 1, 0.01, 'pitting'],
    ['bonePitScale', 2, 80, 0.5, 'pit pitch (cycles/m)'],
    ['bonePitCut', 0, 1, 0.01, 'pit sparsity'],
    ['stainAmount', 0, 1, 0.01, 'earth stain'],
    ['stainHeight', 0, 1, 0.01, 'stain reach'],
    ['grimeAmount', 0, 1, 0.01, 'grime on breach'],
    ['colorBone', 'cortex'],
    ['colorBoneShade', 'grain / pit'],
    ['colorMarrow', 'subsurface warmth'],
    ['colorStain', 'earth stain'],
    ['colorGrime', 'grime on a fresh rib']
  ],
  'Subsurface scatter': [
    ['sssStrength', 0, 3, 0.01, 'strength'],
    ['sssPower', 0.2, 12, 0.1, 'lobe tightness'],
    ['sssDistort', 0, 1.5, 0.01, 'normal distortion'],
    ['sssAmbient', 0, 1, 0.01, 'ambient term'],
    ['sssCeiling', 0, 1.5, 0.01, 'hard ceiling (anti-glow)'],
    ['sssThinBase', 0, 1, 0.01, 'thickness at base'],
    ['sssThinEdge', 0, 1, 0.01, 'silhouette thinness']
  ],
  'The crumble': [
    ['witherDepth', 0, 1, 0.01, 'wither'],
    ['crumbleFade', 0, 1, 0.01, 'opacity lost']
  ],
  'The cracked floor': [
    ['floorRadius', 0.2, 3, 0.01, 'radius (× zone)'],
    ['floorHeight', 0, 0.2, 0.002, 'hover height (m)'],
    ['floorEdge', 0.02, 3, 0.01, 'boundary feather (m)'],
    ['floorRagged', 0, 1, 0.01, 'boundary raggedness'],
    ['floorRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['floorWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['floorRelief', 0, 2, 0.01, 'relief'],
    ['floorNormalStep', 0.005, 0.4, 0.005, 'normal tap (m)'],
    ['floorAmbient', 0, 1, 0.01, 'ambient'],
    ['floorSpecular', 0, 2, 0.01, 'specular'],
    ['floorGloss', 2, 128, 1, 'gloss'],
    ['floorParallax', 0, 2, 0.01, 'parallax (m)'],
    ['floorCell', 0.05, 3, 0.01, 'grain (m)'],
    ['floorLift', 0, 0.5, 0.005, 'rim height (m)'],
    ['floorDepth', 0, 1, 0.005, 'crater depth (m)'],
    ['floorDetail', 0, 1, 0.01, 'detail'],
    ['floorSharp', 0, 1, 0.01, 'sharpness'],
    ['floorSpeed', 0, 6, 0.05, 'dig rate'],
    ['floorMarkLife', 0.5, 30, 0.1, 'crater life (s)'],
    ['floorMarkRadius', 0.05, 3, 0.01, 'crater radius (m)'],
    ['floorEmissive', 0, 2, 0.01, 'emissive'],
    ['floorOpacity', 0, 1, 0.01, 'opacity'],
    ['floorDepthFade', 0.02, 3, 0.01, 'soft intersection (m)'],
    ['colorFloorBase', 'broken flagstone'],
    ['colorFloorEdge', 'crater rim'],
    ['colorFloorGlow', 'ember (kept black)'],
    ['colorFloorDeep', 'the hole']
  ],
  'Chips & dust': [
    ['breachGrit', 0, 60, 1, 'chips per rib'],
    ['gritSpeed', 0, 12, 0.1, 'chip speed (m/s)'],
    ['gritLifetime', 0.1, 6, 0.05, 'chip life (s)'],
    ['gritGravity', -30, 0, 0.5, 'chip gravity'],
    ['gritSize', 0.01, 0.4, 0.005, 'chip size'],
    ['colorGrit*', 'Chip colour'],
    ['breachDust', 0, 40, 1, 'dust per rib'],
    ['dustRate', 0, 120, 1, 'dust rate'],
    ['dustBirthHeight', 0, 1, 0.005, 'dust birth height (m)'],
    ['dustSpeed', 0, 6, 0.05, 'dust speed (m/s)'],
    ['dustLifetime', 0.2, 10, 0.05, 'dust life (s)'],
    ['dustSize', 0.05, 3, 0.01, 'dust size'],
    ['dustRise', -1, 2, 0.01, 'dust rise'],
    ['dustOpacity', 0, 0.6, 0.005, 'dust opacity'],
    ['colorDust*', 'Dust colour']
  ],
  'Hand & shell': [
    ['handHeight', 0, 3, 0.01, 'hand height (m)'],
    ['handForward', -1, 3, 0.01, 'hand forward (m)'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral (m)'],
    ['muzzleSize', 0.05, 4, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 4, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 1, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour'],
    ['burstSize', 0.2, 12, 0.05, 'pressure shell'],
    ['burstIntensity', 0, 4, 0.01, 'shell intensity'],
    ['impactShake', 0, 2, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration (s)'],
    ['impactFlash', 0, 1, 0.01, 'screen flash'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['colorBurstA', 'shell'],
    ['colorBurstB', 'shell body'],
    ['colorBurstC', 'shell motes'],
    ['colorFlash', 'impact flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius (m)'],
    ['lightHeight', 0, 4, 0.01, 'light height (m)'],
    ['lightSmother', 0, 1, 0.01, 'smothered by the cage'],
    ['lightColor', 'light colour']
  ]
};
