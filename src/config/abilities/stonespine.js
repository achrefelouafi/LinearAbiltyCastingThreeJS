/* ================================================================== */
/* STONESPINE — Stone Spine                                            */
/* ================================================================== */
/**
 * Plates, not spikes.
 *
 * Every other "something comes out of the ground" slot in the sandbox punches a
 * body straight up out of the floor. This one does not: a slab of floor is
 * **hinged along one edge** and swings up about that edge like a paving stone
 * being levered with a crowbar. The consequence is the whole ability. Because
 * the rise is a *rotation about a world-space line* and not a translation, the
 * lifted face shows the dirt underside that was buried a moment ago, the far
 * edge travels through an arc, and anything sitting on the top face slides off
 * it. None of that falls out of a translation, at any amount of tuning.
 *
 * Two numbers do the heavy lifting and they are the first two to reach for:
 * `hingeAngle` (how far over the plates go — past about 1.4 rad they start
 * standing on end and the field turns into a wall) and `hingeAlign` (0 gives
 * every plate its own bearing and the field reads as broken river ice, 1 combs
 * them all downrange and it reads as a staircase). Everything else is a shade
 * of those two.
 *
 * **What a cast captures.** A count, a per-plate bearing roll, a handful of
 * unitless jitters and one timestamp per plate. Not a metre, not a radian, not
 * a second — the hinge angle, the reach, the thickness and the heave are all
 * resolved against this block inside the update loop, on a zero-length frame
 * included. Dragging `hingeAngle` on a field that has already finished rising
 * swings every plate, with the clock stopped. That is the test.
 */
export const stonespine = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 2.0, // closer than this and the cast is refused
  speed: 22.0, // how fast the heave front travels, metres/second
  lifetime: 2.6, // seconds the field stands after the front lands
  cooldown: 1.1, // seconds before the slot re-arms
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- how many plates and where they sit --- */
  slabCount: 44, // plates per cast, capped at 96
  clusterShare: 0.2, // 0..1 of them held back for the ring at the impact point
  riseStagger: 0.16, // seconds of random delay between neighbouring plates
  frontBias: 1.0, // <1 crowds the field toward the far end, unitless
  widthNear: 0.8, // half-width of the band at the caster, metres
  width: 2.6, // ... and at the far end, metres
  widthCurve: 1.15, // >1 keeps the band narrow then opens it out late
  clumping: 1.0, // >1 pulls plates toward the centre line, unitless
  scatter: 0.55, // extra lateral jitter, fraction of the local half-width
  clusterRadius: 2.8, // radius of the terminal ring of plates, metres

  /* --- the plate itself (metres unless noted) --- */
  // `reach` is the distance from the hinge to the far edge — the dimension that
  // swings up, so it is also how tall a plate stands once it is over.
  reachNear: 0.85, // reach at the caster
  reach: 2.3, // reach at the far end
  reachCurve: 1.1, // how late the ramp climbs
  reachJitter: 0.35, // ± fraction
  minReach: 0.14, // floor on the above
  plateWidth: 0.6, // half-width across the hinge at the caster
  plateWidthFar: 1.1, // ... and at the far end
  plateWidthCurve: 0.7, // how the width ramps along the cast
  plateWidthJitter: 0.35, // ± fraction
  minWidth: 0.08, // floor on the above
  thickness: 0.24, // slab thickness — the depth of the torn-out floor
  thicknessJitter: 0.4, // ± fraction
  crown: 0.32, // 0..1 how much shorter the flank plates are than the spine
  crownPower: 1.5, // how sharply that dome falls off
  peak: 1.25, // extra reach multiplier at the far end
  peakWidth: 0.22, // 0..1 of the cast that swell covers
  rubble: 0.18, // 0..1 chance a plate is demoted to a broken chip
  rubbleScale: 0.34, // reach multiplier for those
  rubbleSpread: 1.3, // width multiplier for those

  /* --- THE HINGE --- */
  hingeAngle: 0.95, // radians the plate swings through at full rise
  hingeJitter: 0.4, // ± fraction, per plate
  hingeAlign: 0.55, // 0 every plate picks its own bearing, 1 all comb downrange
  hingeShift: 0.35, // fraction of the reach the hinge sits behind the plate's site
  heave: 0.2, // metres the hinge line itself is shoved up out of the floor
  burial: 0.4, // extra metres a plate starts below the floor

  /* --- the eruption --- */
  riseTime: 0.28, // seconds from buried to fully swung
  riseOvershoot: 0.18, // how far past the final angle the shove carries
  settle: 0.42, // seconds that overshoot rocks itself out over
  springRate: 15.0, // radians/second of that rocking
  birthScale: 0.9, // footprint scale at the moment it breaks the surface
  birthFade: 0.32, // seconds the dust flash on a new plate decays over
  breachAt: 0.18, // emergence fraction that fires the hinge puff
  sinkDelay: 0.3, // seconds into the fade before the plates start dropping back
  sinkTime: 0.9, // seconds they take to fall flat and sink
  sinkDepth: 0.5, // extra metres they drop past their own thickness

  /* --- the silhouette of one slab (rebuilds the geometry when moved) --- */
  edgeSamples: 12, // perimeter samples round the ragged three edges
  ragged: 0.3, // how far the outline wanders off a clean quad, 0..1
  chamfer: 0.18, // 0..1 of the thickness taken off as a bevelled top rim
  topInset: 0.16, // how far that bevel pulls the top face in, 0..1
  tear: 0.36, // 0..1 of the thickness the underside is torn away by

  /* --- shading --- */
  // The top face is the old floor: dressed, pale, dusty. Everything below the
  // soil line was in the ground five frames ago and is filthy. `soilLine` is
  // where the two meet and it is the single term that says "this used to be
  // level with your feet".
  colorFace: '#6b6357', // the top face — the floor that got lifted
  colorFlank: '#4a443b', // the sawn sides
  colorSoil: '#3a352e', // earth clinging under the soil line
  colorSoilDeep: '#141210', // the deepest crevices of the underside
  colorDust: '#8d8375', // the pale film and the birth flash
  soilLine: 0.74, // 0..1 up the thickness where the earth stops
  soilBlur: 0.2, // 0..1 how soft that line is
  soilSmear: 0.3, // 0..1 of the reach that soil creeps over onto the top face
  grain: 0.55, // strength of the quarry mottling (world space)
  grainScale: 3.2, // mottle features per metre
  speckle: 0.5, // bright mineral flecks
  speckleScale: 24.0, // flecks per metre
  damp: 0.45, // 0..1 how much darker and rougher the underside is
  dustFilm: 0.4, // 0..1 pale wash over the upward-facing surfaces
  rim: 0.5, // grazing-angle lift on the edges
  rimPower: 2.6, // how tightly that hugs the silhouette
  roughFace: 0.82, // PBR roughness of the dressed top
  roughSoil: 0.98, // ... of the earthy underside
  envIntensity: 0.45, // how much of the HDR probe the stone takes
  birthDust: 0.9, // brightness of the dust flash as a plate breaks through
  glow: 1.0, // master emissive gain (stone barely glows; this is the ceiling)
  opacity: 1.0,

  /* --- dust, grit and trickling sand --- */
  /**
   * Three systems, each with its own four-stop lifetime gradient (`A` at birth
   * through `D` as it dies), spelled out rather than derived from the slab
   * palette so the dust can be made to hang blue-grey while the stone stays warm.
   */
  dustRate: 60, // the rolling ground dust, particles/second
  dustSize: 1.0,
  dustSpeed: 1.2, // metres/second off the hinge
  dustLifetime: 2.4,
  dustOpacity: 0.32,
  dustRise: 0.55, // upward drift, metres/second
  dustTurbulence: 0.5,
  breachDust: 5, // puff thrown at each hinge as it breaks the surface
  colorDustA: '#9b9184',
  colorDustB: '#7a7165',
  colorDustC: '#4e483f',
  colorDustD: '#26231e',
  gritRate: 26, // chips kicked out along the front, particles/second
  gritSize: 0.07,
  gritSpeed: 4.2,
  gritLifetime: 1.4,
  gritGravity: -18.0,
  breachGrit: 9, // chips thrown at each hinge as it breaks the surface
  colorGritA: '#6b6357',
  colorGritB: '#4a443b',
  colorGritC: '#2a251f',
  colorGritD: '#191714',
  sandRate: 80, // the fine stuff that slides off the tilted top faces
  sandSize: 0.06,
  sandSpeed: 1.1,
  sandLifetime: 1.5,
  sandFall: -3.2, // gravity on it, metres/second²
  sandTurbulence: 0.7,
  colorSandA: '#a2988a',
  colorSandB: '#877d70',
  colorSandC: '#585045',
  colorSandD: '#2c2823',

  /* --- what the ground keeps --- */
  crackRadius: 1.2, // fracture mark under each hinge, metres
  crackLife: 6.0, // seconds it weathers away over
  crackIntensity: 0.5,
  crackWidth: 0.45, // how finely the fracture splits
  colorCrack: '#2a251f',
  colorCrackEdge: '#7a6f5e',
  ringRadius: 1.5, // ground-hugging dust ring at each hinge, metres
  ringLife: 1.3,
  colorRingA: '#8d8375',
  colorRingB: '#4e483f',

  /* --- the arrival --- */
  burstSize: 2.6, // dust ball at the impact point, metres
  burstIntensity: 1.1,
  burstDust: 70, // extra dust thrown there
  burstGrit: 80, // extra chips thrown there
  shockRadius: 5.5, // the ring that snaps out across the floor, metres
  impactShake: 0.95,
  shakeDuration: 0.65,
  impactFlash: 0.06, // stone does not flash much; this is nearly off
  rumble: 0.055, // continuous shake while the front travels
  colorBurstA: '#8d8375',
  colorBurstB: '#5e564b',
  colorBurstC: '#2a251f',
  colorShockA: '#a2988a',
  colorShockB: '#d8cfc0',
  colorFlash: '#8d8375',

  /* --- dynamic light --- */
  lightIntensity: 7.0,
  lightRadius: 9.0,
  lightColor: '#c8a878'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Stone Spine.
 *
 * "The hinge" is the folder this ability exists for; open it first. `hingeAngle`
 * and `hingeAlign` between them cover everything from a cracked pavement to a
 * flight of stairs, and both of them reshape a field that has already finished
 * standing. "One slab" rebuilds the geometry when you move it — that is why
 * those five controls are slower than the rest and why they are worth it.
 */
export const stonespineSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 3, 120, 0.5, 'heave speed'],
    ['lifetime', 0.2, 12, 0.05, 'field lifetime'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The hinge': [
    ['hingeAngle', 0, 1.9, 0.01, 'swing (radians)'],
    ['hingeJitter', 0, 1, 0.01, 'swing jitter'],
    ['hingeAlign', 0, 1, 0.01, 'comb downrange'],
    ['hingeShift', -0.5, 1, 0.01, 'hinge behind site'],
    ['heave', -0.5, 1.5, 0.01, 'hinge lift'],
    ['burial', 0, 2, 0.01, 'start depth']
  ],
  'The field': [
    ['slabCount', 1, 96, 1, 'plates'],
    ['clusterShare', 0, 0.7, 0.01, 'held for the ring'],
    ['riseStagger', 0, 1.5, 0.01, 'rise stagger'],
    ['frontBias', 0.3, 3, 0.01, 'front bias'],
    ['widthNear', 0.05, 6, 0.05, 'band at caster'],
    ['width', 0.1, 10, 0.05, 'band at target'],
    ['widthCurve', 0.2, 4, 0.01, 'band curve'],
    ['clumping', 0.3, 4, 0.01, 'clumping'],
    ['scatter', 0, 2, 0.01, 'lateral scatter'],
    ['clusterRadius', 0.2, 10, 0.05, 'terminal ring radius']
  ],
  'The plate': [
    ['reachNear', 0.05, 6, 0.05, 'reach at caster'],
    ['reach', 0.1, 8, 0.05, 'reach at target'],
    ['reachCurve', 0.2, 4, 0.01, 'reach curve'],
    ['reachJitter', 0, 1.2, 0.01, 'reach jitter'],
    ['minReach', 0.02, 1, 0.01, 'minimum reach'],
    ['plateWidth', 0.05, 4, 0.01, 'half-width at caster'],
    ['plateWidthFar', 0.05, 6, 0.01, 'half-width at target'],
    ['plateWidthCurve', 0.1, 3, 0.01, 'width curve'],
    ['plateWidthJitter', 0, 1.2, 0.01, 'width jitter'],
    ['minWidth', 0.02, 1, 0.01, 'minimum half-width'],
    ['thickness', 0.02, 1.2, 0.01, 'slab thickness'],
    ['thicknessJitter', 0, 1.2, 0.01, 'thickness jitter'],
    ['crown', 0, 1, 0.01, 'flank crown'],
    ['crownPower', 0.3, 4, 0.01, 'crown falloff'],
    ['peak', 0.5, 3, 0.01, 'swell at target'],
    ['peakWidth', 0.02, 1, 0.01, 'swell width'],
    ['rubble', 0, 1, 0.01, 'broken chips'],
    ['rubbleScale', 0.05, 1, 0.01, 'chip reach'],
    ['rubbleSpread', 0.5, 3, 0.01, 'chip width']
  ],
  'The eruption': [
    ['riseTime', 0.02, 2, 0.01, 'rise time'],
    ['riseOvershoot', 0, 1, 0.01, 'overshoot'],
    ['settle', 0.05, 2, 0.01, 'settle'],
    ['springRate', 1, 40, 0.5, 'rock rate'],
    ['birthScale', 0.2, 1, 0.01, 'birth scale'],
    ['birthFade', 0.02, 2, 0.01, 'birth flash decay'],
    ['breachAt', 0.02, 0.9, 0.01, 'breach at'],
    ['sinkDelay', 0, 3, 0.01, 'fall-back delay'],
    ['sinkTime', 0.05, 4, 0.01, 'fall-back time'],
    ['sinkDepth', 0, 3, 0.01, 'sink depth']
  ],
  'One slab': [
    ['edgeSamples', 6, 22, 1, 'perimeter samples'],
    ['ragged', 0, 1, 0.01, 'outline raggedness'],
    ['chamfer', 0, 0.6, 0.01, 'top bevel'],
    ['topInset', 0, 0.5, 0.01, 'bevel inset'],
    ['tear', 0, 0.9, 0.01, 'torn underside']
  ],
  'Stone & soil': [
    ['colorFace', 'top face'],
    ['colorFlank', 'sides'],
    ['colorSoil', 'earth'],
    ['colorSoilDeep', 'deep crevice'],
    ['colorDust', 'dust film'],
    ['soilLine', 0, 1, 0.01, 'soil line'],
    ['soilBlur', 0.01, 0.8, 0.01, 'soil line blur'],
    ['soilSmear', 0, 1, 0.01, 'soil smear onto face'],
    ['grain', 0, 2, 0.01, 'quarry mottling'],
    ['grainScale', 0.2, 12, 0.05, 'mottle / metre'],
    ['speckle', 0, 3, 0.01, 'mineral flecks'],
    ['speckleScale', 2, 80, 0.5, 'flecks / metre'],
    ['damp', 0, 1, 0.01, 'underside darkening'],
    ['dustFilm', 0, 1, 0.01, 'dust film'],
    ['rim', 0, 3, 0.01, 'edge lift'],
    ['rimPower', 0.5, 8, 0.05, 'edge tightness'],
    ['roughFace', 0.05, 1, 0.01, 'face roughness'],
    ['roughSoil', 0.05, 1, 0.01, 'soil roughness'],
    ['envIntensity', 0, 2, 0.01, 'probe intensity'],
    ['birthDust', 0, 4, 0.01, 'breach flash'],
    ['glow', 0, 4, 0.01, 'emissive gain'],
    ['opacity', 0, 1, 0.01, 'opacity']
  ],
  'Dust & grit': [
    ['dustRate', 0, 400, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 8, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['breachDust', 0, 40, 1, 'puff per hinge'],
    ['gritRate', 0, 300, 1, 'grit rate'],
    ['gritSize', 0.005, 0.4, 0.005, 'grit size'],
    ['gritSpeed', 0, 20, 0.1, 'grit speed'],
    ['gritLifetime', 0.1, 5, 0.05, 'grit lifetime'],
    ['gritGravity', -50, 0, 0.1, 'grit gravity'],
    ['breachGrit', 0, 60, 1, 'chips per hinge'],
    ['sandRate', 0, 500, 1, 'sand rate'],
    ['sandSize', 0.005, 0.4, 0.005, 'sand size'],
    ['sandSpeed', 0, 8, 0.05, 'sand speed'],
    ['sandLifetime', 0.1, 6, 0.05, 'sand lifetime'],
    ['sandFall', -30, 2, 0.1, 'sand gravity'],
    ['sandTurbulence', 0, 3, 0.01, 'sand turbulence'],
    ['colorDust*', 'Dust colour'],
    ['colorGrit*', 'Grit colour'],
    ['colorSand*', 'Sand colour']
  ],
  'Marks on the ground': [
    ['crackRadius', 0.1, 6, 0.05, 'fracture radius'],
    ['crackLife', 0.5, 20, 0.1, 'fracture lifetime'],
    ['crackIntensity', 0, 2, 0.01, 'fracture intensity'],
    ['crackWidth', 0, 2, 0.01, 'fracture detail'],
    ['ringRadius', 0.1, 6, 0.05, 'dust ring radius'],
    ['ringLife', 0.1, 6, 0.05, 'dust ring lifetime'],
    ['colorCrack', 'fracture'],
    ['colorCrackEdge', 'fracture edge'],
    ['colorRingA', 'dust ring'],
    ['colorRingB', 'dust ring edge']
  ],
  'The arrival': [
    ['burstSize', 0.2, 12, 0.05, 'dust ball size'],
    ['burstIntensity', 0, 4, 0.01, 'dust ball intensity'],
    ['burstDust', 0, 400, 1, 'burst dust'],
    ['burstGrit', 0, 400, 1, 'burst grit'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 1, 0.005, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst core'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest'],
    ['colorFlash', 'impact flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
