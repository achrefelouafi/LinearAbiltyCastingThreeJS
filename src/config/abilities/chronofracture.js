/* ================================================================== */
/* CHRONOFRACTURE — arcane, far cast                                   */
/* ================================================================== */
/**
 * Panes of frozen time hung in the air over the circle.
 *
 * The trick is **stillness**, and stillness is expensive in a sandbox where
 * everything else crawls, gutters, breathes and drifts. Almost every number
 * below that could have been a rate ships at zero on purpose — `stillness`,
 * `stillSpeed`'s effect, `sealSpin`, `refractRippleSpeed` — because the moment
 * one of them moves, the panes stop being frozen time and become glass.
 *
 * Two of those deserve their own note.
 *
 * `sealSpin` is the one that cannot be animated. `GroundField`'s RUNE rings
 * rotate by `uTime × spin`, so easing the slider toward zero does not slow the
 * rings down, it *teleports* them — the whole seal snaps back to bearing zero
 * over however many seconds of wall clock have elapsed. It is therefore a
 * constant for the life of a cast and it ships at 0.
 *
 * `crackLead` is the deliberate exception. For the last fraction of a second
 * before the break, hairline fractures ink themselves across every pane. That
 * *is* motion, and it is there because a break with no tell reads as a cut.
 * Set it to 0 for the purist reading; the panes then go from perfect to gone.
 *
 * On the refraction: the panes ask `ShatterField`/`DistortionField` for a real
 * screen-space sample and the repo does not have one yet (`frame.uSceneColor`
 * does not exist). Until it does, "an older, colder copy of what is behind it"
 * is faked three ways — a low-saturation cold wash alpha-blended over the
 * scene, which genuinely desaturates it; a chromatic split of the pane's own
 * frozen grain (`fringe` / `fringeOffset`), which is what a three-tap scene
 * sample would look like; and a real `DistortionField` REFRACT hull, which
 * genuinely offsets the frame behind each pane. What is missing is the blur.
 * Nothing here fakes it, because a fake blur without a texture is a smear of
 * flat colour and it looks like exactly that.
 */
export const chronofracture = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  zoneRadius: 5.0, // the far-cast circle the indicator draws, metres
  speed: 52.0, // how fast the freeze front runs to the circle, metres/second
  assembleTime: 0.55, // seconds the panes take to open
  holdTime: 1.5, // seconds they hang dead still afterwards
  fadeTime: 1.15, // seconds the fragments have to fall
  cooldown: 1.4,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the panes hang --- */
  paneCount: 20, // panes in the air (capped at 28)
  paneInner: 0.18, // innermost pane, as a fraction of `zoneRadius`
  paneReach: 1.05, // outermost pane, as a fraction of `zoneRadius`
  paneHeight: 1.9, // metres above the floor the band is centred on
  paneRise: 1.15, // ± metres of height scatter across the band
  paneWidth: 1.55, // metres, a pane's width before jitter
  paneAspect: 1.35, // height / width
  paneSizeJitter: 0.4, // ± fraction on both dimensions
  paneFaceOut: 0.78, // 0 every pane faces downrange, 1 each faces radially out
  paneYaw: 0.5, // ± radians of random yaw on top of that
  paneTilt: 0.22, // ± radians of random lean out of vertical

  /* --- the assembly --- */
  assembleStagger: 0.72, // fraction of `assembleTime` the last pane waits for
  assembleCurve: 2.1, // >1 opens slowly then snaps the last of the way
  seamWidth: 0.09, // metres of bright edge on the opening slit
  seamGlow: 3.4, // how hard that edge burns

  /* --- the glass --- */
  paneOpacity: 0.34, // the cold wash — this is what desaturates the scene
  paneGlow: 1.25, // emissive gain on every glowing term in the pane
  frost: 0.62, // amount of suspended frozen grain, 0..1
  frostScale: 1.35, // grain features per metre
  grain: 0.3, // fine dust on top of it, 0..1
  fringe: 0.75, // chromatic split of that grain, 0..1
  fringeOffset: 0.055, // metres the red and blue taps sit either side
  rim: 1.1, // fresnel brightness at grazing angles
  rimPower: 2.6, // how tight that rim is
  border: 0.045, // metres of bright hairline around a pane's perimeter
  stillness: 0.0, // 0 is frozen; above 0 the grain drifts and the trick dies
  stillSpeed: 0.35, // cycles/second of that drift, if you enable it
  paneSoft: 0.35, // metres of soft fade where a pane meets solid geometry

  /* --- the pre-cracks --- */
  crackLead: 0.18, // seconds before the break the fractures ink themselves
  crackArms: 7, // radial fractures out of each pane's stress point
  crackRings: 1.6, // concentric fractures per metre
  crackWidth: 0.012, // metres, half-width of a fracture
  crackGlow: 2.2, // how hard a fracture burns

  /* --- pane colour --- */
  colorGlass: '#6a8ab0', // the cold wash laid over the scene behind
  colorGhost: '#d0e8ff', // the frozen grain — the "older" image
  colorRim: '#d0e8ff', // the fresnel edge
  colorSeam: '#ffffff', // the opening slit and the perimeter hairline
  colorCrack: '#ffffff', // the fractures

  /* --- the refraction hull (one DistortionField over all the panes) --- */
  refractStrength: 0.42, // screen widths at post.distortion = 1
  refractPower: 1.1, // rim exponent; 0 flattens it to a uniform pane
  refractOpacity: 0.95, // coverage against other distorters
  refractRipple: 0.06, // normal perturbation on the hull
  refractRippleScale: 1.6, // cycles per metre
  refractRippleSpeed: 0.0, // metres/second — ships at zero, see the header
  refractDepthReject: 1.0, // how hard the character occludes the warp, 0..1
  refractDepthFade: 0.35, // metres of feather on that occlusion

  /* --- the break --- */
  shardsPerPane: 9, // fragments thrown by each pane (capped by the field)
  shardSize: 0.36, // metres, a fragment's unit scale
  shardSizeJitter: 0.6, // ± fraction
  shardSpeed: 7.5, // metres/second off the pane
  shardSpeedJitter: 0.7, // ± fraction
  shardSpread: 0.55, // 0 throws every fragment the same way, 1 is random
  shardUp: 0.12, // how much +Y is folded into the throw
  shardScatter: 0.32, // metres of scatter about the pane it came off
  shardGravity: -26.0, // metres/second², signed — fast, they are falling glass
  shardDrag: 0.55, // 1/second
  shardSpin: 11.0, // radians/second of tumble
  shardSpinJitter: 0.85, // ± fraction
  shardLifetime: 1.05, // seconds a fragment lives
  shardShrink: 0.35, // fraction of its size lost by the end of that
  shardShrinkPower: 2.2, // how late the shrink bites
  shardFloor: 0.02, // metres; fragments do not sink below this
  shardFloorSpin: 0.18, // fraction of the tumble kept once grounded

  /* --- fragment shading --- */
  shardOpacity: 0.85,
  shardGlow: 1.6,
  shardRim: 1.3, // fresnel gain on a fragment's edge
  shardRimPower: 2.2,
  shardShade: 0.75, // how much the key light shades the body
  shardAmbient: 0.4, // floor on that
  shardFadeStart: 0.55, // fraction of life the fade-out begins at
  shardSoft: 0.2, // metres of soft fade against geometry
  shardSceneMix: 0.7, // how much of the scene sample a shard shows, if bound
  shardRefract: 0.045, // screen fraction the scene sample is pushed by
  shardSaturation: 0.22, // how much colour survives in that sample
  colorShardA: '#d0e8ff', // fragment body at birth
  colorShardB: '#6a8ab0', // ... and as it dies
  colorShardEdge: '#ffffff', // its fresnel rim
  colorShardScene: '#b9d4ea', // tint on the scene sample, if one is ever bound

  /* --- the seal burnt into the floor --- */
  sealScale: 1.25, // × zoneRadius — the seal is wider than the pane band
  sealHeight: 0.02, // metres the quad floats above the floor
  sealEdge: 0.3, // metres of feather on the growth front
  sealRagged: 0.14, // how far that front wanders, fraction of the radius
  sealRaggedScale: 0.55, // lobes per metre
  sealWarp: 0.35, // metres of domain warp on those lobes
  sealRelief: 0.55, // how hard the incision tilts the fake normal
  sealNormalStep: 0.05, // metres between the height taps
  sealAmbient: 0.3, // floor on the diffuse term
  sealWrap: 0.5, // wraps the terminator round the back, 0..1
  sealSpecular: 0.65,
  sealGloss: 30, // Blinn exponent
  sealParallax: 0.2, // metres of view-driven offset on the incision
  sealRings: 3, // 1..4 nested rings of glyphs
  sealRingInner: 0.34, // innermost ring as a fraction of the radius
  sealGlyphSize: 0.6, // metres — the em box of one glyph
  sealGlyphStroke: 0.05, // metres — half-width of a stroke
  sealGlyphGap: 1.3, // slot pitch, in glyph widths
  sealSpin: 0.0, // radians/second, ring 0 — see the header, it must be constant
  sealSpinFalloff: 0.55, // how much slower each ring out turns
  sealRule: 0.014, // metres — half-width of the compass circles
  sealThickness: 0.05, // metres of stroke depth
  sealDepth: 0.2, // metres the incision is cut to
  sealCell: 0.5, // metres — grain pitch under the seal
  sealDetail: 0.5, // 0..1 of fine detail in the substrate
  sealEmissive: 1.4, // multiplier on the seal's glowing terms
  sealOpacity: 0.95,
  sealDepthFade: 0.4, // metres of soft fade against standing geometry
  colorSealBase: '#2a3a4c', // the stone the seal is cut into
  colorSealEdge: '#d0e8ff', // its lips and highlights
  colorSealGlow: '#8fc4ff', // the ignition inside the strokes
  colorSealDeep: '#0a1018', // the bottom of the incision

  /* --- motes: dust that stopped when time did --- */
  moteRate: 70, // particles/second while the panes are up
  moteSize: 0.05,
  moteSpeed: 0.22, // metres/second — near zero, they hang
  moteLifetime: 2.6,
  moteDrift: 0.05, // upward drift, metres/second
  moteTurbulence: 0.06, // how much curl noise is allowed to move them
  colorMoteA: '#ffffff',
  colorMoteB: '#d0e8ff',
  colorMoteC: '#6a8ab0',
  colorMoteD: '#1a2a3c',

  /* --- glints: the sparks that come off a pane locking, and the break --- */
  glintRate: 40, // particles/second during the assembly
  glintSize: 0.11,
  glintSpeed: 3.4,
  glintLifetime: 0.45,
  glintGravity: -6.0,
  glintStretch: 0.22, // how far a glint smears along its velocity
  glintBurst: 220, // extra glints thrown at the break
  colorGlintA: '#ffffff',
  colorGlintB: '#d0e8ff',
  colorGlintC: '#8fc4ff',
  colorGlintD: '#2a4a70',

  /* --- chips: the heavy debris of the break --- */
  chipBurst: 90, // chips thrown at the break
  chipSize: 0.075,
  chipSpeed: 6.5,
  chipLifetime: 1.4,
  chipGravity: -22.0,
  colorChipA: '#b9d4ea',
  colorChipB: '#6a8ab0',
  colorChipC: '#3c5570',
  colorChipD: '#1a2a3c',

  /* --- dynamic light --- */
  lightIntensity: 15, // the pale light inside the panes
  lightRadius: 14,
  lightColor: '#a8cdf0',
  lightHold: 0.7, // multiplier while the panes are simply hanging
  lightBreak: 2.4, // multiplier on the punch at the break

  /* --- feedback --- */
  freezeFlash: 0.1, // screen flash as the last pane locks
  colorFreezeFlash: '#d0e8ff',
  breakFlash: 0.26, // screen flash at the break
  colorBreakFlash: '#ffffff',
  breakShake: 0.55,
  breakShakeDuration: 0.5, // seconds that shake decays over
  breakBurst: 3.6, // metres, the shell of released time at the break
  breakBurstIntensity: 1.3,
  colorBreakA: '#6a8ab0', // burst shell
  colorBreakB: '#d0e8ff', // burst body
  colorBreakC: '#ffffff' // burst filaments
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Chronofracture.
 *
 * The four controls that carry the character, in the order worth reaching for:
 * `paneCount` and `paneWidth` (how much of the circle is wall), `paneOpacity`
 * (how cold the scene behind goes), `fringe` (how *wrong* the frozen image
 * looks) and `holdTime` (how long you are made to stare at something that is
 * not moving). Turn `stillness` up if you want to see why it ships at zero.
 */
export const chronofractureSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['zoneRadius', 1, 16, 0.1, 'circle radius'],
    ['speed', 5, 200, 1, 'freeze-front speed'],
    ['assembleTime', 0.05, 3, 0.01, 'assembly time'],
    ['holdTime', 0, 8, 0.01, 'hold (dead still)'],
    ['fadeTime', 0.1, 5, 0.01, 'fall time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where the panes hang': [
    ['paneCount', 1, 28, 1, 'panes'],
    ['paneInner', 0, 1.5, 0.01, 'inner radius ×'],
    ['paneReach', 0, 2, 0.01, 'outer radius ×'],
    ['paneHeight', 0, 8, 0.01, 'band height'],
    ['paneRise', 0, 5, 0.01, 'height scatter ±'],
    ['paneWidth', 0.1, 6, 0.01, 'pane width'],
    ['paneAspect', 0.2, 4, 0.01, 'height / width'],
    ['paneSizeJitter', 0, 1.5, 0.01, 'size jitter ±'],
    ['paneFaceOut', 0, 1, 0.01, 'face outward'],
    ['paneYaw', 0, 3.2, 0.01, 'yaw scatter ±'],
    ['paneTilt', 0, 1.6, 0.01, 'lean scatter ±']
  ],
  'The assembly': [
    ['assembleStagger', 0, 0.98, 0.01, 'stagger'],
    ['assembleCurve', 0.2, 6, 0.05, 'open curve'],
    ['seamWidth', 0.002, 0.5, 0.002, 'seam width'],
    ['seamGlow', 0, 10, 0.05, 'seam glow']
  ],
  'The glass': [
    ['paneOpacity', 0, 1, 0.005, 'cold wash'],
    ['paneGlow', 0, 5, 0.01, 'pane glow'],
    ['frost', 0, 2, 0.01, 'frozen grain'],
    ['frostScale', 0.05, 8, 0.01, 'grain / metre'],
    ['grain', 0, 1, 0.01, 'fine dust'],
    ['fringe', 0, 2, 0.01, 'chromatic split'],
    ['fringeOffset', 0, 0.4, 0.002, 'split offset'],
    ['rim', 0, 4, 0.01, 'fresnel rim'],
    ['rimPower', 0.2, 8, 0.05, 'rim tightness'],
    ['border', 0, 0.3, 0.002, 'perimeter hairline'],
    ['stillness', 0, 1, 0.01, 'grain drift (kills it)'],
    ['stillSpeed', 0, 4, 0.01, 'drift rate'],
    ['paneSoft', 0.01, 2, 0.01, 'soft intersection']
  ],
  'The pre-cracks': [
    ['crackLead', 0, 1.5, 0.005, 'lead before break'],
    ['crackArms', 0, 16, 1, 'radial fractures'],
    ['crackRings', 0, 8, 0.05, 'rings / metre'],
    ['crackWidth', 0.001, 0.08, 0.001, 'fracture width'],
    ['crackGlow', 0, 8, 0.05, 'fracture glow']
  ],
  'Pane colour': [
    ['colorGlass', 'cold wash'],
    ['colorGhost', 'frozen grain'],
    ['colorRim', 'fresnel rim'],
    ['colorSeam', 'seam & hairline'],
    ['colorCrack', 'fractures']
  ],
  'Refraction': [
    ['refractStrength', 0, 2, 0.005, 'strength'],
    ['refractPower', 0, 6, 0.05, 'rim exponent'],
    ['refractOpacity', 0, 1, 0.01, 'coverage'],
    ['refractRipple', 0, 1, 0.005, 'ripple'],
    ['refractRippleScale', 0.05, 8, 0.05, 'ripple / metre'],
    ['refractRippleSpeed', 0, 4, 0.01, 'ripple speed (kills it)'],
    ['refractDepthReject', 0, 1, 0.01, 'occlusion'],
    ['refractDepthFade', 0.02, 3, 0.01, 'occlusion feather']
  ],
  'The break': [
    ['shardsPerPane', 0, 24, 1, 'fragments / pane'],
    ['shardSize', 0.02, 1.5, 0.01, 'fragment size'],
    ['shardSizeJitter', 0, 1.5, 0.01, 'size jitter ±'],
    ['shardSpeed', 0, 30, 0.1, 'throw speed'],
    ['shardSpeedJitter', 0, 1.5, 0.01, 'speed jitter ±'],
    ['shardSpread', 0, 1, 0.01, 'throw spread'],
    ['shardUp', -1, 1, 0.01, 'upward bias'],
    ['shardScatter', 0, 2, 0.01, 'spawn scatter'],
    ['shardGravity', -60, 0, 0.5, 'gravity'],
    ['shardDrag', 0, 4, 0.01, 'drag'],
    ['shardSpin', 0, 30, 0.1, 'tumble rate'],
    ['shardSpinJitter', 0, 1.5, 0.01, 'tumble jitter ±'],
    ['shardLifetime', 0.1, 4, 0.01, 'fragment lifetime'],
    ['shardShrink', 0, 1, 0.01, 'shrink'],
    ['shardShrinkPower', 0.2, 6, 0.05, 'shrink curve'],
    ['shardFloor', -1, 2, 0.01, 'floor height'],
    ['shardFloorSpin', 0, 1, 0.01, 'grounded tumble']
  ],
  'The break/Fragment shading': [
    ['shardOpacity', 0, 2, 0.01, 'opacity'],
    ['shardGlow', 0, 5, 0.01, 'glow'],
    ['shardRim', 0, 4, 0.01, 'rim'],
    ['shardRimPower', 0.2, 8, 0.05, 'rim tightness'],
    ['shardShade', 0, 1, 0.01, 'key shading'],
    ['shardAmbient', 0, 1, 0.01, 'ambient floor'],
    ['shardFadeStart', 0, 1, 0.01, 'fade start'],
    ['shardSoft', 0, 2, 0.01, 'soft intersection'],
    ['shardSceneMix', 0, 1, 0.01, 'scene mix'],
    ['shardRefract', 0, 0.3, 0.002, 'scene refraction'],
    ['shardSaturation', 0, 1, 0.01, 'scene saturation'],
    ['colorShardA', 'fragment birth'],
    ['colorShardB', 'fragment death'],
    ['colorShardEdge', 'fragment rim'],
    ['colorShardScene', 'scene tint']
  ],
  'The seal': [
    ['sealScale', 0.2, 3, 0.01, 'radius × zone'],
    ['sealHeight', 0, 0.3, 0.005, 'float above floor'],
    ['sealEdge', 0.02, 2, 0.01, 'front feather'],
    ['sealRagged', 0, 1, 0.01, 'front wander'],
    ['sealRaggedScale', 0.05, 4, 0.01, 'wander / metre'],
    ['sealWarp', 0, 3, 0.01, 'domain warp'],
    ['sealRelief', 0, 3, 0.01, 'relief'],
    ['sealNormalStep', 0.005, 0.4, 0.005, 'normal step'],
    ['sealAmbient', 0, 1, 0.01, 'ambient'],
    ['sealWrap', 0, 1, 0.01, 'terminator wrap'],
    ['sealSpecular', 0, 3, 0.01, 'specular'],
    ['sealGloss', 1, 120, 1, 'gloss'],
    ['sealParallax', 0, 2, 0.01, 'parallax'],
    ['sealThickness', 0.005, 0.4, 0.005, 'stroke depth'],
    ['sealDepth', 0, 1, 0.005, 'incision depth'],
    ['sealCell', 0.05, 3, 0.01, 'substrate grain'],
    ['sealDetail', 0, 1, 0.01, 'substrate detail'],
    ['sealEmissive', 0, 6, 0.01, 'emissive'],
    ['sealOpacity', 0, 2, 0.01, 'opacity'],
    ['sealDepthFade', 0.02, 3, 0.01, 'soft intersection']
  ],
  'The seal/Glyphs': [
    ['sealRings', 1, 4, 1, 'rings'],
    ['sealRingInner', 0.05, 0.9, 0.01, 'inner ring ×'],
    ['sealGlyphSize', 0.05, 2, 0.01, 'glyph em box'],
    ['sealGlyphStroke', 0.005, 0.3, 0.002, 'stroke half-width'],
    ['sealGlyphGap', 0.6, 3, 0.01, 'slot pitch'],
    ['sealSpin', -1, 1, 0.005, 'ring spin (constant!)'],
    ['sealSpinFalloff', 0, 3, 0.01, 'spin falloff'],
    ['sealRule', 0.002, 0.1, 0.001, 'compass rule']
  ],
  'The seal/Colour': [
    ['colorSealBase', 'stone'],
    ['colorSealEdge', 'lips'],
    ['colorSealGlow', 'ignition'],
    ['colorSealDeep', 'incision']
  ],
  'Motes & glints': [
    ['moteRate', 0, 400, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 6, 0.01, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteDrift', -2, 2, 0.01, 'mote drift'],
    ['moteTurbulence', 0, 2, 0.01, 'mote turbulence'],
    ['glintRate', 0, 400, 1, 'glint rate'],
    ['glintSize', 0.005, 0.6, 0.005, 'glint size'],
    ['glintSpeed', 0, 20, 0.1, 'glint speed'],
    ['glintLifetime', 0.05, 3, 0.01, 'glint lifetime'],
    ['glintGravity', -40, 5, 0.1, 'glint gravity'],
    ['glintStretch', 0, 2, 0.01, 'glint stretch'],
    ['glintBurst', 0, 700, 1, 'glints at the break'],
    ['colorMote*', 'Mote colour'],
    ['colorGlint*', 'Glint colour']
  ],
  'Chips': [
    ['chipBurst', 0, 400, 1, 'chips at the break'],
    ['chipSize', 0.005, 0.5, 0.005, 'chip size'],
    ['chipSpeed', 0, 25, 0.1, 'chip speed'],
    ['chipLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['chipGravity', -60, 0, 0.5, 'chip gravity'],
    ['colorChip*', 'Chip colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightHold', 0, 3, 0.01, 'hold multiplier'],
    ['lightBreak', 0, 8, 0.05, 'break punch'],
    ['lightColor', 'light colour']
  ],
  'Feedback': [
    ['freezeFlash', 0, 2, 0.01, 'flash on lock'],
    ['colorFreezeFlash', 'lock flash colour'],
    ['breakFlash', 0, 2, 0.01, 'flash on break'],
    ['colorBreakFlash', 'break flash colour'],
    ['breakShake', 0, 3, 0.01, 'break shake'],
    ['breakShakeDuration', 0.05, 3, 0.01, 'shake duration'],
    ['breakBurst', 0.1, 14, 0.05, 'break shell size'],
    ['breakBurstIntensity', 0, 5, 0.01, 'break shell intensity'],
    ['colorBreakA', 'shell'],
    ['colorBreakB', 'body'],
    ['colorBreakC', 'filaments']
  ]
};
