/* ================================================================== */
/* ROLLING RUIN — stone, line cast                                     */
/* ================================================================== */
/**
 * A boulder is put on the floor and shoved down the aimed line. It rolls,
 * gouges, throws chips out from under itself, rumbles, and breaks into pieces
 * of itself when it arrives.
 *
 * Three numbers in this block are **not** here, and their absence is the
 * design:
 *
 *  - **no spin rate.** A rolling body's rotation is `distance / radius` and
 *    nothing else — see the class comment on `BoulderAbility`. A slider for it
 *    would be a slider for how badly the rock skates.
 *  - **no rut depth curve.** The rut's depth follows the contact load, and the
 *    contact load is the boulder's own speed against `loadSpeed`. `pathCurve`
 *    is what makes it accelerate, so the gouge deepens down the track for a
 *    physical reason rather than a scripted one.
 *  - **no chatter pitch.** The marks the rim prints into the floor are spaced
 *    at the body's own circumference, `2π · radius · rutChatter`. `rutChatter`
 *    is a fudge on that (1 = exactly one print per turn), not a length.
 *
 * The `rut*` family drives `vfx/GroundField.js` in `RUT` mode through a params
 * object the ability fills every frame, and the `debris*`/`chunk*` families
 * drive `vfx/ShatterField.js` the same way — canonical names on the module
 * side, prefixed names here, so two consumers of "width" cannot collide.
 */
export const boulder = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 12.0, // how fast the *front* runs down the line, metres/second
  holdTime: 0.5, // seconds the pile is held after the pieces stop flying
  rutFadeTime: 1.4, // seconds the gouge takes to fade out of the floor
  cooldown: 1.4,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the rock --- */
  radius: 0.62, // metres. Drives the roll, the rut width and the chatter pitch
  handForward: 1.1, // metres in front of the caster it is put down
  handSide: 0.0, // metres to the side (+ follows `Ability#side`)
  pathCurve: 1.4, // >1 accelerates down the track — this is what deepens the rut
  flash: 0.14, // seconds the birth pop on the body decays over
  rockDetail: 2, // icosphere subdivisions, 0–3
  rockLumps: 0.28, // low-frequency deformation, × the radius
  rockLumpScale: 1.5, // lumps per unit radius
  rockRough: 0.2, // high-frequency chipping
  rockCuts: 6, // planar fracture faces sliced off it
  rockCutDepth: 0.22, // how far in those planes bite, × the radius
  rockCraters: 4, // impact bowls punched into it
  rockCraterDepth: 0.16, // how deep those bowls go, × the radius
  colorRock: '#6e6455', // the stone itself

  /* --- how hard it is pressing --- */
  loadSpeed: 16.5, // metres/second at which the rut is at full depth
  loadCurve: 1.3, // >1 keeps the gouge shallow until it is really moving
  loadPeak: 1.0, // ceiling on the load, 0..1

  /* --- the rut it leaves --- */
  rutWidth: 0.5, // half-width of the gouged floor, metres
  rutDepth: 0.3, // metres at full contact load
  rutSharp: 0.55, // 0..1 how squarely the gouge's walls fall away
  rutChatter: 1.0, // prints per turn of the rim — 1 is the true circumference
  rutChatterDepth: 0.55, // 0..1 how deeply those prints show
  rutSpoil: 0.13, // metres of spoil ridge heaped either side
  rutSpoilWidth: 0.15, // metres wide that ridge is
  rutSampleBlend: 0.9, // metres over which two contact samples blend together
  rutSamples: 14, // contact samples posted along the track (capped at 16)
  rutDrift: 0.0, // the track's own lateral wander — off; this rock rolls straight
  rutEdge: 0.35, // metres of feather at the head of the gouge
  rutRagged: 0.18, // how far the edge wanders, as a fraction of the radius
  rutRaggedScale: 0.7, // lobes per metre
  rutWarp: 0.35, // metres of domain warp on those lobes
  rutRelief: 0.75, // how hard the height field tilts the fake normal
  rutNormalStep: 0.05, // metres between the height taps
  rutAmbient: 0.3, // floor on the diffuse term
  rutWrap: 0.45, // 0..1 wraps the terminator round the back
  rutSpecular: 0.35,
  rutGloss: 20, // Blinn exponent
  rutParallax: 0.25, // metres of view-driven offset on the interior detail
  rutEmissive: 1.0, // multiplier on the churn under the body
  rutOpacity: 1.0,
  rutDepthFade: 0.5, // metres of soft fade against standing geometry
  rutHeight: 0.012, // metres above the floor the quad sits at
  colorRutBase: '#6e6455', // the churned floor
  colorRutEdge: '#a89880', // the spoil ridges either side
  colorRutChurn: '#c8a878', // the ground still moving right under the body
  colorRutDeep: '#241f1a', // the bottom of the gouge

  /* --- what it breaks into --- */
  debrisCount: 80, // fragments thrown on arrival
  debrisSize: 0.19, // metres, a full-size fragment
  debrisSizeJitter: 0.6, // ± fraction
  debrisSpeed: 5.5, // metres/second
  debrisSpeedJitter: 0.55, // ± fraction
  debrisSpread: 0.34, // 0 throws everything downrange, 1 is fully random
  debrisUp: 0.45, // how much +Y is folded into the throw, 0..1
  debrisInherit: 0.45, // how much of the boulder's own velocity a piece keeps
  debrisScatter: 0.9, // where a piece starts, × the body radius
  debrisHeight: 0.7, // how high it starts, × the body radius
  debrisGravity: -21.0, // metres/second², signed
  debrisDrag: 0.6, // 1/second; 0 is pure ballistics
  debrisShrink: 0.35, // 0..1 of its size lost by the end of life
  debrisShrinkPower: 2.0, // how late that shrink bites
  debrisSpin: 7.0, // radians/second of tumble
  debrisSpinJitter: 0.8, // ± fraction
  debrisFloorSpin: 0.2, // fraction of the tumble kept once it is on the floor
  debrisLifetime: 1.7, // seconds a fragment lives
  chunkGlow: 1.0, // emissive gain on a fragment
  chunkRim: 0.5, // strength of its rim light
  chunkRimPower: 2.6, // how tight that rim is
  chunkShade: 1.0, // how hard the key light shades it
  chunkAmbient: 0.32, // floor on that shading
  chunkFadeStart: 0.72, // 0..1 of its life before it starts to fade
  chunkSoft: 0.2, // metres of depth feather against the floor
  colorChunkA: '#6e6455', // a lit face
  colorChunkB: '#39332b', // a shaded one
  colorChunkEdge: '#a89880', // the fresh fracture edge
  colorChunkTint: '#4a4239', // the tint behind it, if a scene sample ever exists

  /* --- the plume off the contact patch --- */
  /**
   * As everywhere else, each system is coloured by a four-stop gradient over
   * the particle's own lifetime, `A` at birth through `D` as it dies. Spelled
   * out rather than derived from the stone palette, so the dust can be made to
   * settle browner than the rock that threw it.
   */
  dustRate: 150, // particles/second at full contact load
  dustSize: 0.95,
  dustSpeed: 2.6,
  dustLifetime: 2.2,
  dustOpacity: 0.28,
  dustRise: 0.55, // upward drift, metres/second
  dustTurbulence: 0.7,
  dustHeight: 0.14, // metres above the floor it leaves the contact patch at
  dustBack: 0.8, // how far behind the rock the plume is thrown, 0..1
  colorDustA: '#a89880',
  colorDustB: '#8a7f6b',
  colorDustC: '#5d554a',
  colorDustD: '#39332b',

  /* --- chips spat out from under it --- */
  chipRate: 70, // particles/second at full contact load
  chipSize: 0.055,
  chipSpeed: 5.5,
  chipLifetime: 1.2,
  chipGravity: -19.0,
  chipSpray: 0.6, // how far out to the side they are thrown, 0..1
  chipBack: 0.5, // and how far behind, 0..1
  colorChipA: '#6e6455',
  colorChipB: '#4a4239',
  colorChipC: '#39332b',
  colorChipD: '#241f1a',

  /* --- the shove and the arrival --- */
  muzzleSize: 0.9, // the thud where it is set down, metres
  muzzleIntensity: 1.0,
  burstSize: 2.6, // the ball of dust where it breaks, metres
  burstIntensity: 1.2,
  burstChips: 90, // extra chips thrown on arrival
  burstDust: 45, // and dust
  crackRadius: 2.4, // the star of cracks under the impact, metres
  crackWidth: 0.5, // how finely it splits into filaments
  crackLife: 6.0, // seconds it lingers
  crackIntensity: 0.85,
  impactDust: 3.0, // the dust ring it lands in, metres
  impactShake: 0.9,
  shakeDuration: 0.5, // seconds that punch decays over
  impactFlash: 0.08, // screen flash on arrival — small; this is a rock, not a bomb
  colorFlash: '#c8a878',
  rumble: 0.11, // continuous shake at `loadSpeed`, scaled by actual speed
  settleRumble: 0.02, // what is left of it while the pile settles
  settleDust: 0.5, // dust still rolling off the pile, × the travelling rate

  /* --- dynamic light --- */
  // Low on purpose. A boulder emits nothing; this is a soft warm bounce that
  // gives the dust plume something to catch, and it rides with the rock.
  lightIntensity: 7,
  lightRadius: 9,
  lightColor: '#c8a878',
  lightHeight: 0.6 // metres above the floor the light sits at
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Rolling Ruin.
 *
 * Start with `radius` — it is the only control in the block that moves five
 * other things at once, on purpose: the rock, the rotation rate that keeps it
 * from skating, the width of what it throws, where the pieces start, and the
 * pitch of the chatter marks in the rut. Then `pathCurve` and `loadSpeed`,
 * which together decide whether the gouge is a scratch that deepens into a
 * trench or a trench the whole way.
 */
export const boulderSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 2, 60, 0.1, 'roll speed'],
    ['holdTime', 0.05, 4, 0.01, 'hold after landing'],
    ['rutFadeTime', 0.1, 6, 0.01, 'rut fade'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The rock': [
    ['radius', 0.1, 2.5, 0.01, 'radius (m)'],
    ['handForward', -1, 4, 0.01, 'set down at (m)'],
    ['handSide', -2, 2, 0.01, 'lateral offset (m)'],
    ['pathCurve', 0.4, 3, 0.01, 'acceleration curve'],
    ['flash', 0.01, 1, 0.01, 'birth pop (s)'],
    ['rockDetail', 0, 3, 1, 'subdivisions'],
    ['rockLumps', 0, 0.8, 0.01, 'lumpiness'],
    ['rockLumpScale', 0.2, 5, 0.01, 'lumps / radius'],
    ['rockRough', 0, 0.8, 0.01, 'surface chipping'],
    ['rockCuts', 0, 14, 1, 'fracture facets'],
    ['rockCutDepth', 0, 0.6, 0.01, 'facet depth'],
    ['rockCraters', 0, 10, 1, 'craters'],
    ['rockCraterDepth', 0, 0.5, 0.01, 'crater depth'],
    ['colorRock', 'stone']
  ],
  'Contact load': [
    ['loadSpeed', 1, 60, 0.1, 'full-depth speed (m/s)'],
    ['loadCurve', 0.1, 4, 0.01, 'load curve'],
    ['loadPeak', 0, 1, 0.01, 'load ceiling'],
    ['rumble', 0, 0.6, 0.005, 'rumble at full speed'],
    ['settleRumble', 0, 0.3, 0.005, 'settling rumble']
  ],
  'The rut': [
    ['rutWidth', 0.05, 3, 0.01, 'half-width (m)'],
    ['rutDepth', 0, 1.5, 0.01, 'depth (m)'],
    ['rutSharp', 0, 1, 0.01, 'wall sharpness'],
    ['rutChatter', 0, 4, 0.01, 'prints per turn'],
    ['rutChatterDepth', 0, 1, 0.01, 'print depth'],
    ['rutSpoil', 0, 0.8, 0.005, 'spoil ridge (m)'],
    ['rutSpoilWidth', 0.02, 1, 0.01, 'ridge width (m)'],
    ['rutSampleBlend', 0.05, 4, 0.01, 'sample blend (m)'],
    ['rutSamples', 1, 16, 1, 'contact samples'],
    ['rutDrift', 0, 2, 0.01, 'track drift'],
    ['rutEdge', 0.02, 2, 0.01, 'head feather (m)'],
    ['rutRagged', 0, 1, 0.01, 'ragged edge'],
    ['rutRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['rutWarp', 0, 3, 0.01, 'edge warp'],
    ['rutHeight', 0, 0.2, 0.001, 'height above floor (m)']
  ],
  'The rut/Lighting': [
    ['rutRelief', 0, 3, 0.01, 'relief'],
    ['rutNormalStep', 0.005, 0.3, 0.005, 'normal step (m)'],
    ['rutAmbient', 0, 1, 0.01, 'ambient'],
    ['rutWrap', 0, 1, 0.01, 'terminator wrap'],
    ['rutSpecular', 0, 2, 0.01, 'specular'],
    ['rutGloss', 1, 80, 1, 'gloss'],
    ['rutParallax', 0, 1.5, 0.01, 'parallax (m)'],
    ['rutEmissive', 0, 3, 0.01, 'churn glow'],
    ['rutOpacity', 0, 1, 0.01, 'opacity'],
    ['rutDepthFade', 0.01, 3, 0.01, 'soft fade (m)'],
    ['colorRutBase', 'churned floor'],
    ['colorRutEdge', 'spoil ridge'],
    ['colorRutChurn', 'churn under the body'],
    ['colorRutDeep', 'bottom of the gouge']
  ],
  'The shatter': [
    ['debrisCount', 0, 160, 1, 'fragments'],
    ['debrisSize', 0.02, 1, 0.01, 'fragment size (m)'],
    ['debrisSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['debrisSpeed', 0, 25, 0.1, 'throw speed'],
    ['debrisSpeedJitter', 0, 1, 0.01, 'speed jitter'],
    ['debrisSpread', 0, 1, 0.01, 'spread'],
    ['debrisUp', 0, 1, 0.01, 'up bias'],
    ['debrisInherit', 0, 2, 0.01, 'inherited velocity'],
    ['debrisScatter', 0, 3, 0.01, 'start scatter × radius'],
    ['debrisHeight', 0, 3, 0.01, 'start height × radius'],
    ['debrisGravity', -60, 0, 0.5, 'gravity'],
    ['debrisDrag', 0, 4, 0.01, 'drag'],
    ['debrisShrink', 0, 1, 0.01, 'shrink'],
    ['debrisShrinkPower', 0.2, 6, 0.01, 'shrink curve'],
    ['debrisSpin', 0, 30, 0.1, 'tumble'],
    ['debrisSpinJitter', 0, 1, 0.01, 'tumble jitter'],
    ['debrisFloorSpin', 0, 1, 0.01, 'tumble once grounded'],
    ['debrisLifetime', 0.1, 6, 0.05, 'lifetime']
  ],
  'The shatter/Shading': [
    ['chunkGlow', 0, 4, 0.01, 'glow'],
    ['chunkRim', 0, 3, 0.01, 'rim'],
    ['chunkRimPower', 0.1, 8, 0.01, 'rim power'],
    ['chunkShade', 0, 2, 0.01, 'shading'],
    ['chunkAmbient', 0, 1, 0.01, 'ambient'],
    ['chunkFadeStart', 0, 1, 0.01, 'fade start'],
    ['chunkSoft', 0, 2, 0.01, 'soft fade (m)'],
    ['colorChunkA', 'lit face'],
    ['colorChunkB', 'shaded face'],
    ['colorChunkEdge', 'fracture edge'],
    ['colorChunkTint', 'scene tint']
  ],
  'Dust & chips': [
    ['dustRate', 0, 600, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 14, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['dustHeight', 0, 2, 0.01, 'emit height (m)'],
    ['dustBack', 0, 2, 0.01, 'thrown behind'],
    ['chipRate', 0, 400, 1, 'chip rate'],
    ['chipSize', 0.005, 0.4, 0.005, 'chip size'],
    ['chipSpeed', 0, 25, 0.1, 'chip speed'],
    ['chipLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['chipGravity', -50, 0, 0.1, 'chip gravity'],
    ['chipSpray', 0, 3, 0.01, 'chip sideways'],
    ['chipBack', 0, 3, 0.01, 'chip backwards'],
    ['settleDust', 0, 2, 0.01, 'settling dust'],
    ['colorDust*', 'Dust colour'],
    ['colorChip*', 'Chip colour']
  ],
  'The shove & the arrival': [
    ['muzzleSize', 0.05, 6, 0.05, 'set-down thud'],
    ['muzzleIntensity', 0, 5, 0.01, 'thud intensity'],
    ['burstSize', 0.2, 14, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['burstChips', 0, 400, 1, 'burst chips'],
    ['burstDust', 0, 300, 1, 'burst dust'],
    ['crackRadius', 0.1, 10, 0.05, 'crack star radius'],
    ['crackWidth', 0, 3, 0.01, 'crack detail'],
    ['crackLife', 0.5, 20, 0.1, 'crack lifetime'],
    ['crackIntensity', 0, 3, 0.01, 'crack intensity'],
    ['impactDust', 0.1, 10, 0.05, 'impact dust ring'],
    ['impactShake', 0, 3, 0.01, 'impact shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 4, 0.01, 'light height'],
    ['lightColor', 'light colour']
  ]
};
