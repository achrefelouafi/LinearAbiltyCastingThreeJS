/* ================================================================== */
/* RIME — Rimewalker                                                   */
/* ================================================================== */
/**
 * Sheet ice. Not spikes: plates a few centimetres thick that glaze the floor
 * behind a freezing front, lock, and then peel their downwind edge up off the
 * stone like paper curling off a hot pan.
 *
 * Three groups of numbers matter more than the rest:
 *
 *  - **`curl`, `curlTime`, `curlDelay`** — the roll. `curl` is the total angle
 *    the rim turns through, in radians: at 0 the field is a frozen pavement, at
 *    π every plate is standing on its hinge with its rim pointing back at the
 *    floor. It is a live uniform, so a standing field peels and unpeels under
 *    the slider with the clock stopped, which is the control worth reaching for
 *    first.
 *  - **`thickness` against `plateHeight`** — how thin the ice reads. The plate
 *    is generated in unit space and scaled to `plateHeight` metres tall, so the
 *    sheet's own thickness is authored in metres here and divided by the height
 *    inside the geometry factory. That is also why there is no height jitter in
 *    this block: jittering the height would jitter the thickness with it, and a
 *    field of sheets that are not all the same thickness does not read as one
 *    event. Size variety comes from `radiusJitter` instead.
 *  - **`sublimeTime`, `sublimeEdge`, `sublimeGlow`** — the directional fade.
 *    The corridor does not dim; a front runs it from the caster's end forward
 *    and the ice in front of that line is untouched while the ice behind it has
 *    gone. Widen `sublimeEdge` and you can watch the band eat the plates.
 *
 * Everything with a unit below is resolved against this block inside the update
 * loop, on every frame including a zero-length one. The cast captures a seed
 * and a handful of timestamps and nothing else.
 */
export const rime = {
  /* --- the cast --- */
  range: 16.0, // maximum cast distance, metres
  minRange: 2.0, // closer than this and the cast is refused
  speed: 12.0, // how fast the freezing front runs the line, metres/second
  cooldown: 1.0, // seconds
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws
  lifetime: 1.7, // seconds the corridor stands once the front has landed
  snapDelay: 0.3, // seconds after the hold before the curls snap off
  sublimeTime: 1.6, // seconds the sublimation front takes to run the corridor

  /* --- where the plates are laid --- */
  plateCount: 168, // plates in the corridor, capped at the field's capacity
  clusterShare: 0.16, // 0..1 of them held back for the ring at the impact point
  clusterRadius: 1.6, // metres, radius of that ring
  widthNear: 0.5, // half-width of the glazed band at the caster, metres
  width: 1.7, // ... and at the far end, metres
  widthCurve: 0.85, // <1 flares the band early, >1 keeps it narrow then opens
  frontBias: 1.0, // <1 crowds the plates toward the far end, unitless
  clumping: 0.8, // >1 pulls them onto the centre line, unitless
  scatter: 0.85, // extra lateral jitter, fraction of the local half-width
  lockStagger: 0.26, // seconds of random delay between neighbouring plates
  tilt: 0.1, // radians of random tip, so the pavement is not perfectly flat
  twist: 1.0, // 0..1 of a full turn of random yaw per plate

  /* --- the eruption of one plate --- */
  // These are SCALE emergence, not PUSH: a plate accretes on the floor rather
  // than punching up out of it, because ice on stone freezes, it does not erupt.
  riseTime: 0.14, // seconds from nothing to full size
  riseOvershoot: 0.1, // how far past full size the lock carries
  settle: 0.3, // seconds that overshoot damps out over
  springRate: 20.0, // radians/second of the overshoot ring
  birthScale: 0.35, // footprint scale at the instant it locks

  /* --- the size of one plate --- */
  plateRadius: 0.95, // plan diameter at the caster, metres
  plateRadiusFar: 1.3, // ... and at the far end, metres
  radiusCurve: 0.7, // how the plan size ramps along the cast
  radiusJitter: 0.34, // ± fraction, the only size variety in the field
  plateHeight: 0.85, // vertical scale of a plate at the caster, metres
  plateHeightFar: 1.05, // ... and at the far end, metres
  heightCurve: 0.9, // how late that ramp climbs
  crown: 0.25, // 0..1 — how much smaller the plates on the flanks are
  crownPower: 1.4, // how sharply that dome falls off

  /* --- the sheet itself (these rebuild the geometry when they move) --- */
  facets: 11, // sides of the plan polygon, 7–14 read best
  rings: 8, // radial subdivisions; the roll needs these to bend smoothly
  rimJitter: 0.34, // 0..1 — how irregular the plan outline is
  buckle: 0.055, // unit-space non-planarity, so a flat plate still catches light
  thickness: 0.032, // metres — the actual thickness of the ice

  /* --- the curl --- */
  curl: 2.5, // radians the rim rolls through when fully peeled
  curlTime: 0.95, // seconds one plate takes to go from flat to fully peeled
  curlDelay: 0.34, // 0..1 of that clock spent lying flat first — the "lock"
  curlHinge: -0.06, // unit space; where across the plate the roll starts
  curlSpread: 0.55, // radians of per-plate jitter on the peel bearing

  /* --- the sheet material --- */
  depthTint: 1.15, // how hard the body tint comes in at a grazing angle
  depthPower: 1.5, // how fast it comes in
  translucency: 0.9, // interior glow through the rime grain
  fresnel: 1.6, // rim brightness
  fresnelPower: 2.2, // how tight that rim is
  lipGlow: 1.8, // the highlight on the rolled edge — the signature of the slot
  lipWidth: 0.45, // 0..1 of the roll that counts as lip
  lipPower: 1.6, // how sharply the lip term falls off inward
  grain: 0.4, // rime grain over the sheet
  grainScale: 4.5, // grain features per metre
  glint: 1.3, // pinpoint sparkle
  glintScale: 26.0, // glints per metre
  glintSpeed: 0.5, // how fast they scroll
  glow: 1.25, // overall emissive gain
  birthGlow: 2.6, // flash as a plate locks
  birthPower: 6.0, // how fast that flash dies inside the curl clock
  opacity: 0.86,
  roughness: 0.14, // MeshStandardMaterial roughness — drives the env reflection
  envIntensity: 1.1, // how much of the HDR probe the sheet reflects
  colorSheet: '#dff6ff', // the ice face-on, where it is thinnest
  colorDeep: '#123b4a', // the body tint at a grazing angle
  colorLip: '#ffffff', // the rolled edge and the frost grain
  colorGlow: '#7ecbe0', // everything emissive on the plate

  /* --- the sublimation front --- */
  sublimeEdge: 1.1, // metres of the dissolve band
  sublimeGlow: 2.2, // how bright the band burns as the ice turns to vapour
  colorSublime: '#bfeaff', // that band

  /* --- the glaze pool where the front grounds out --- */
  // One `GroundField` in PLATE mode: interlocking sheet ice on the floor, with
  // its own plates lifting downwind. It is a disc because that is what the
  // module is shaped like — see the class comment for why the *corridor* is not
  // one of these.
  poolRadius: 2.6, // metres
  poolGrow: 0.5, // seconds the pool takes to freeze out to full radius
  poolHold: 0.55, // 0..1 of the sublimation the pool survives before it recedes
  poolHeight: 0.02, // metres above the floor the quad sits at
  poolCell: 0.42, // metres — the pitch of one plate in the pool
  poolCellJitter: 0.85, // 0..1 — how irregular that packing is
  poolSeam: 0.035, // metres of gap between plates
  poolThickness: 0.03, // metres of body
  poolLift: 0.09, // metres the downwind edge of a pool plate rises
  poolEdge: 0.4, // metres of feather on the freezing front
  poolRagged: 0.32, // how far that front wanders, fraction of the radius
  poolRaggedScale: 0.8, // lobes per metre
  poolWarp: 0.5, // metres of domain warp on those lobes
  poolRelief: 0.7, // how hard the height field tilts the fake normal
  poolNormalStep: 0.05, // metres between the height taps
  poolAmbient: 0.34, // floor on the diffuse term
  poolWrap: 0.45, // 0..1 wraps the terminator round the back
  poolSpecular: 0.65,
  poolGloss: 30.0, // Blinn exponent
  poolParallax: 0.3, // metres of view-driven offset on the interior
  poolDetail: 0.55, // 0..1 frozen spray in the seams
  poolEmissive: 1.0, // multiplier on the pool's glowing terms
  poolOpacity: 0.95,
  poolDepthFade: 0.4, // metres of soft fade against standing geometry
  colorPoolBase: '#9fd3e4', // the pool's ice
  colorPoolEdge: '#eaf9ff', // its lips and highlights
  colorPoolGlow: '#7ecbe0', // its emissive
  colorPoolDeep: '#123b4a', // the thick middle of a pool plate

  /* --- the curls that snap off --- */
  shardCount: 90, // fragments thrown when the hold ends
  shardSpawnRadius: 0.35, // metres of scatter about the corridor
  shardSpawnHeight: 0.3, // metres above the floor they come off at
  shardSize: 0.3, // metres
  shardSizeJitter: 0.5, // ± fraction
  shardSpeed: 2.4, // metres/second
  shardSpeedJitter: 0.7, // ± fraction
  shardSpread: 0.4, // 0 throws them all downrange, 1 is fully random
  shardUpBias: 0.55, // how much +Y is folded into the throw
  shardGravity: -11.0, // metres/second²
  shardDrag: 1.1, // 1/second
  shardSpin: 7.0, // radians/second of tumble
  shardSpinJitter: 0.8, // ± fraction
  shardLifetime: 1.5, // seconds
  shardShrink: 0.75, // 0..1 of its size a fragment loses by the end
  shardShrinkPower: 1.7, // how late that shrink bites
  shardFloor: 0.02, // metres; a fragment never sinks below this
  shardFloorSpin: 0.2, // fraction of the tumble kept once grounded
  shardOpacity: 0.95,
  shardGlow: 1.2,
  shardRim: 1.1, // rim light on a fragment
  shardRimPower: 2.4,
  shardShade: 1.0, // how much the key direction shades a fragment
  shardAmbient: 0.4,
  shardFadeStart: 0.55, // 0..1 of its life before a fragment starts fading
  shardSoft: 0.3, // metres of soft fade where a fragment meets geometry
  colorShardA: '#ffffff', // a fragment lit
  colorShardB: '#7ecbe0', // a fragment in shade
  colorShardEdge: '#dff6ff', // its rim

  /* --- mist, glints and chips --- */
  /**
   * As everywhere in this project, each system is coloured by a four-stop
   * gradient sampled over the particle's own lifetime, `A` at birth through `D`
   * as it dies — spelled out rather than derived from the plate palette, so the
   * vapour can be made to warm off while the ice stays blue.
   */
  mistRate: 55, // vapour off the freezing front, particles/second
  mistSize: 0.85,
  mistSpeed: 0.8,
  mistLifetime: 2.4,
  mistOpacity: 0.08,
  mistRise: 0.35, // upward drift, metres/second
  colorMistA: '#dff6ff',
  colorMistB: '#a8ccd8',
  colorMistC: '#5f7f8e',
  colorMistD: '#22333c',
  glintRate: 130, // ice crystals hanging over the corridor, particles/second
  glintSize: 0.055,
  glintSpeed: 0.9,
  glintLifetime: 1.5,
  glintRise: 0.5,
  glintTurbulence: 0.6,
  colorGlintA: '#ffffff',
  colorGlintB: '#dff6ff',
  colorGlintC: '#7ecbe0',
  colorGlintD: '#123b4a',
  breachChips: 2, // chips thrown as one plate locks
  chipSize: 0.05,
  chipSpeed: 2.2,
  chipLifetime: 1.1,
  chipGravity: -14.0,
  colorChipA: '#eaf9ff',
  colorChipB: '#9fd3e4',
  colorChipC: '#4d7f92',
  colorChipD: '#1b3440',

  /* --- the impact and the snap --- */
  burstSize: 2.2, // the shell of freezing vapour at the far end, metres
  burstIntensity: 1.1,
  colorBurstA: '#7ecbe0',
  colorBurstB: '#dff6ff',
  colorBurstC: '#ffffff',
  shockRadius: 4.5, // the ring that snaps out across the floor, metres
  colorShockA: '#dff6ff',
  colorShockB: '#ffffff',
  impactShake: 0.5,
  shakeDuration: 0.5,
  impactFlash: 0.16,
  colorFlash: '#dff6ff',
  snapShake: 0.3, // the jolt as the curls break off
  rumble: 0.02, // continuous shake while the front runs

  /* --- dynamic light --- */
  lightIntensity: 14.0,
  lightRadius: 12.0,
  lightColor: '#9fd8ee',
  lightPulse: 0.25, // depth of the light's slow breath, 0 = steady
  lightPulseSpeed: 1.4 // breaths per second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Rimewalker.
 *
 * `The curl` is the folder this ability exists for — drag `curl` on a standing
 * corridor and every plate in it rolls up or lies back down. After that,
 * `thickness` in `The sheet` is the one that decides whether you are looking at
 * ice or at glass, and `sublimeTime` in `The cast` decides whether the corridor
 * evaporates or is wiped away.
 */
export const rimeSchema = {
  'The cast': [
    ['range', 2, 48, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 80, 0.5, 'freezing front speed'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['lifetime', 0.1, 8, 0.05, 'corridor lifetime'],
    ['snapDelay', 0, 3, 0.01, 'delay before the curls snap'],
    ['sublimeTime', 0.1, 6, 0.05, 'sublimation time'],
    ['castAnim', 'cast animation']
  ],
  'The corridor': [
    ['plateCount', 8, 216, 1, 'plates'],
    ['clusterShare', 0, 0.6, 0.01, 'held for the impact ring'],
    ['clusterRadius', 0.2, 6, 0.05, 'impact ring radius'],
    ['widthNear', 0.05, 4, 0.01, 'band half-width at the caster'],
    ['width', 0.05, 6, 0.01, 'band half-width at the target'],
    ['widthCurve', 0.2, 4, 0.01, 'band curve'],
    ['frontBias', 0.3, 3, 0.01, 'crowd toward the target'],
    ['clumping', 0.2, 4, 0.01, 'pull onto the centre line'],
    ['scatter', 0, 2, 0.01, 'lateral scatter'],
    ['lockStagger', 0, 1.5, 0.01, 'stagger between plates'],
    ['tilt', 0, 0.6, 0.005, 'random tip'],
    ['twist', 0, 1, 0.01, 'random yaw']
  ],
  'The corridor/Locking': [
    ['riseTime', 0.02, 1, 0.01, 'lock time'],
    ['riseOvershoot', 0, 1, 0.01, 'overshoot'],
    ['settle', 0.05, 2, 0.01, 'settle'],
    ['springRate', 2, 60, 0.5, 'overshoot ring'],
    ['birthScale', 0.05, 1, 0.01, 'size at the lock']
  ],
  'The plate': [
    ['plateRadius', 0.1, 4, 0.01, 'plan size at the caster'],
    ['plateRadiusFar', 0.1, 5, 0.01, 'plan size at the target'],
    ['radiusCurve', 0.1, 4, 0.01, 'plan curve'],
    ['radiusJitter', 0, 1, 0.01, 'plan jitter'],
    ['plateHeight', 0.1, 4, 0.01, 'vertical scale at the caster'],
    ['plateHeightFar', 0.1, 5, 0.01, 'vertical scale at the target'],
    ['heightCurve', 0.1, 4, 0.01, 'vertical curve'],
    ['crown', 0, 1, 0.01, 'flank falloff'],
    ['crownPower', 0.2, 5, 0.01, 'falloff sharpness']
  ],
  'The sheet': [
    ['facets', 5, 18, 1, 'plan sides'],
    ['rings', 3, 14, 1, 'radial rings'],
    ['rimJitter', 0, 0.9, 0.01, 'outline irregularity'],
    ['buckle', 0, 0.3, 0.005, 'non-planarity'],
    ['thickness', 0.002, 0.2, 0.001, 'sheet thickness (m)']
  ],
  'The curl': [
    ['curl', 0, 6.2, 0.01, 'roll at the rim (rad)'],
    ['curlTime', 0.05, 4, 0.01, 'time to peel'],
    ['curlDelay', 0, 0.95, 0.01, 'lie flat first'],
    ['curlHinge', -0.45, 0.45, 0.005, 'hinge across the plate'],
    ['curlSpread', 0, 3, 0.01, 'peel bearing jitter']
  ],
  'The ice': [
    ['depthTint', 0, 3, 0.01, 'grazing tint'],
    ['depthPower', 0.2, 6, 0.01, 'tint curve'],
    ['translucency', 0, 3, 0.01, 'interior glow'],
    ['fresnel', 0, 5, 0.01, 'rim'],
    ['fresnelPower', 0.2, 8, 0.01, 'rim tightness'],
    ['lipGlow', 0, 6, 0.01, 'lip highlight'],
    ['lipWidth', 0.02, 0.99, 0.01, 'lip width'],
    ['lipPower', 0.2, 6, 0.01, 'lip falloff'],
    ['grain', 0, 2, 0.01, 'rime grain'],
    ['grainScale', 0.2, 20, 0.1, 'grain / metre'],
    ['glint', 0, 4, 0.01, 'sparkle'],
    ['glintScale', 2, 90, 0.5, 'glints / metre'],
    ['glintSpeed', 0, 4, 0.01, 'glint scroll'],
    ['glow', 0, 5, 0.01, 'glow'],
    ['birthGlow', 0, 8, 0.01, 'lock flash'],
    ['birthPower', 0.5, 20, 0.1, 'lock flash decay'],
    ['opacity', 0, 1, 0.01, 'opacity'],
    ['roughness', 0.01, 1, 0.01, 'roughness'],
    ['envIntensity', 0, 4, 0.01, 'env reflection'],
    ['colorSheet', 'sheet, face-on'],
    ['colorDeep', 'body tint'],
    ['colorLip', 'lip & grain'],
    ['colorGlow', 'emissive']
  ],
  'The sublimation': [
    ['sublimeEdge', 0.05, 6, 0.01, 'band width (m)'],
    ['sublimeGlow', 0, 8, 0.01, 'band glow'],
    ['colorSublime', 'the band']
  ],
  'The glaze pool': [
    ['poolRadius', 0.2, 12, 0.05, 'radius'],
    ['poolGrow', 0.05, 3, 0.01, 'freeze-out time'],
    ['poolHold', 0, 1, 0.01, 'survives this much of the fade'],
    ['poolHeight', 0, 0.4, 0.005, 'height above floor'],
    ['poolCell', 0.05, 2, 0.01, 'plate pitch'],
    ['poolCellJitter', 0, 1, 0.01, 'packing irregularity'],
    ['poolSeam', 0.002, 0.4, 0.002, 'seam width'],
    ['poolThickness', 0.002, 0.3, 0.002, 'plate body'],
    ['poolLift', 0, 0.8, 0.005, 'downwind lift'],
    ['poolEdge', 0.02, 3, 0.01, 'front feather'],
    ['poolRagged', 0, 1, 0.01, 'front wander'],
    ['poolRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['poolWarp', 0, 3, 0.01, 'domain warp'],
    ['poolRelief', 0, 3, 0.01, 'relief'],
    ['poolNormalStep', 0.005, 0.4, 0.005, 'normal step'],
    ['poolAmbient', 0, 1, 0.01, 'ambient'],
    ['poolWrap', 0, 1, 0.01, 'terminator wrap'],
    ['poolSpecular', 0, 3, 0.01, 'specular'],
    ['poolGloss', 1, 120, 1, 'gloss'],
    ['poolParallax', 0, 2, 0.01, 'parallax'],
    ['poolDetail', 0, 1, 0.01, 'frozen spray'],
    ['poolEmissive', 0, 4, 0.01, 'emissive'],
    ['poolOpacity', 0, 1, 0.01, 'opacity'],
    ['poolDepthFade', 0.02, 2, 0.01, 'soft intersection'],
    ['colorPoolBase', 'pool ice'],
    ['colorPoolEdge', 'pool lips'],
    ['colorPoolGlow', 'pool emissive'],
    ['colorPoolDeep', 'pool interior']
  ],
  'The curls that snap off': [
    ['shardCount', 0, 180, 1, 'fragments'],
    ['shardSpawnRadius', 0, 2, 0.01, 'scatter'],
    ['shardSpawnHeight', 0, 2, 0.01, 'spawn height'],
    ['shardSize', 0.02, 1.5, 0.01, 'size'],
    ['shardSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['shardSpeed', 0, 20, 0.05, 'speed'],
    ['shardSpeedJitter', 0, 1, 0.01, 'speed jitter'],
    ['shardSpread', 0, 1, 0.01, 'spread'],
    ['shardUpBias', 0, 1, 0.01, 'up bias'],
    ['shardGravity', -40, 5, 0.1, 'gravity'],
    ['shardDrag', 0, 6, 0.01, 'drag'],
    ['shardSpin', 0, 30, 0.1, 'tumble'],
    ['shardSpinJitter', 0, 1, 0.01, 'tumble jitter'],
    ['shardLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['shardShrink', 0, 1, 0.01, 'shrink'],
    ['shardShrinkPower', 0.2, 6, 0.01, 'shrink curve'],
    ['shardFloor', 0, 1, 0.005, 'floor'],
    ['shardFloorSpin', 0, 1, 0.01, 'floor tumble'],
    ['shardOpacity', 0, 1, 0.01, 'opacity'],
    ['shardGlow', 0, 4, 0.01, 'glow'],
    ['shardRim', 0, 4, 0.01, 'rim'],
    ['shardRimPower', 0.2, 8, 0.01, 'rim tightness'],
    ['shardShade', 0, 2, 0.01, 'shading'],
    ['shardAmbient', 0, 1, 0.01, 'ambient'],
    ['shardFadeStart', 0, 1, 0.01, 'fade start'],
    ['shardSoft', 0, 2, 0.01, 'soft intersection'],
    ['colorShardA', 'fragment lit'],
    ['colorShardB', 'fragment shaded'],
    ['colorShardEdge', 'fragment rim']
  ],
  'Mist & glints': [
    ['mistRate', 0, 400, 1, 'mist rate'],
    ['mistSize', 0.05, 4, 0.01, 'mist size'],
    ['mistSpeed', 0, 8, 0.05, 'mist speed'],
    ['mistLifetime', 0.2, 8, 0.05, 'mist lifetime'],
    ['mistOpacity', 0, 1, 0.005, 'mist opacity'],
    ['mistRise', -2, 4, 0.01, 'mist rise'],
    ['glintRate', 0, 600, 1, 'glint rate'],
    ['glintSize', 0.005, 0.4, 0.005, 'glint size'],
    ['glintSpeed', 0, 10, 0.05, 'glint speed'],
    ['glintLifetime', 0.1, 6, 0.05, 'glint lifetime'],
    ['glintRise', -2, 6, 0.05, 'glint rise'],
    ['glintTurbulence', 0, 3, 0.01, 'glint turbulence'],
    ['colorMist*', 'Mist colour'],
    ['colorGlint*', 'Glint colour']
  ],
  'Chips': [
    ['breachChips', 0, 20, 1, 'chips per plate'],
    ['chipSize', 0.005, 0.4, 0.005, 'chip size'],
    ['chipSpeed', 0, 15, 0.05, 'chip speed'],
    ['chipLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['chipGravity', -40, 0, 0.1, 'chip gravity'],
    ['colorChip*', 'Chip colour']
  ],
  'Impact & snap': [
    ['burstSize', 0.1, 10, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['shockRadius', 0.2, 20, 0.1, 'shockwave radius'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['snapShake', 0, 3, 0.01, 'snap shake'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst plates'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest'],
    ['colorFlash', 'impact flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'light breath'],
    ['lightPulseSpeed', 0, 8, 0.05, 'breath rate'],
    ['lightColor', 'light colour']
  ]
};
