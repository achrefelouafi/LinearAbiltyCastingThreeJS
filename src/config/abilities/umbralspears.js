/* ================================================================== */
/* UMBRALSPEARS — Umbral Spears                                        */
/* ================================================================== */
/**
 * A line of near-black spears that comes up out of the caster's own shadow.
 *
 * This block is the **anti-glow** slot, and almost every number in it is
 * pointed the wrong way round compared with the other forty-nine. There is no
 * body colour brighter than `#0a0710`, no emission anywhere except the rim, no
 * additive particle system and no screen flash. The scene is tuned for bloom;
 * these are the only objects in it that are darker than the floor, and every
 * time a value in here has been raised "just a little" the effect has stopped
 * working, because a dark silhouette only reads while everything about it stays
 * dark.
 *
 * **`rimCeiling` is the one number not to touch.** `UnrealBloomPass` runs on
 * the linear HDR buffer *before* `OutputPass` tone maps, with
 * `settings.post.bloomThreshold` at 0.88. The rim is rolled off so it
 * asymptotes at `rimCeiling` and therefore can never cross that threshold — see
 * the guard in `UmbralSpearsAbility`. Push this above 0.88 and the bloom pass
 * smears the rim across the silhouette the whole ability exists to protect.
 *
 * **`shadow*` is a real shadow, not a decal.** The band on the floor is a
 * `GroundField` in RUT mode, non-additive, so it *shades* the flagstones rather
 * than adding light to them, and it is offset along the horizontal projection
 * of `frame.uLightDir` — the same key direction the lit meshes use. Each spear
 * posts a contact mark as it breaks the surface, which is what pools the
 * darkness at the bases instead of laying an even stripe.
 */
export const umbralspears = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 2.5, // closer than this and the cast is refused
  speed: 33.0, // how fast the front runs the line, metres/second
  lifetime: 1.25, // seconds the spears stand after the front lands
  sinkDelay: 0.25, // seconds into the fade before they start going back down
  sinkTime: 0.7, // seconds they take to withdraw
  cooldown: 0.9, // seconds before it can be cast again
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the field on the floor --- */
  spearCount: 104, // spears this cast (hard ceiling 240)
  clusterShare: 0.2, // 0..1 of them held back for the ring at the impact point
  clusterRadius: 1.9, // metres that ring reaches, < 0 derives from the band
  widthNear: 0.45, // metres, half-width of the band at the caster
  width: 2.4, // metres, at the far end
  widthCurve: 1.35, // >1 keeps the band narrow, then opens it late
  frontBias: 0.85, // <1 crowds the spears toward the far end
  clumping: 1.15, // >1 pulls them toward the centre line
  scatter: 0.45, // extra lateral jitter, fraction of the local half-width

  /* --- the silhouette --- */
  heightNear: 0.7, // metres at the caster
  height: 2.6, // metres at the far end
  heightCurve: 1.15, // how late the ramp climbs
  heightJitter: 0.42, // ± fraction
  crown: 0.4, // 0..1 how much shorter a flank spear is than the spine
  crownPower: 1.5, // how sharply that dome falls off
  peak: 1.2, // extra height multiplier at the far end
  peakWidth: 0.22, // 0..1 of the cast that swell covers
  rubble: 0.16, // 0..1 chance a spear is demoted to a stub
  rubbleScale: 0.32, // height multiplier for those
  rubbleSpread: 1.3, // radius multiplier for those
  minHeight: 0.05, // metres, floor
  radiusNear: 0.13, // metres, base radius at the caster
  radius2: 0.19, // metres, at the far end
  radiusCurve: 0.7, // how the radius ramps along the cast
  radiusJitter: 0.35, // ± fraction
  minRadius: 0.02, // metres, floor

  /* --- how they are aimed --- */
  // `leanForward` is the authored part and `shadowLean` is the part the sun
  // decides: the spears tip away from the light, so they lie *along* their own
  // shadows. With `shadowLean` at zero they stand square to the cast and the
  // field loses the one thing that ties it to the room.
  lean: 0.3, // radians away from vertical
  leanJitter: 0.5, // ± fraction
  leanRamp: 0.6, // 0 leans everything equally, 1 only the far end
  leanForward: 0.35, // weight of "away from the caster" in the lean direction
  leanOutward: 0.9, // weight of "out across the band"
  shadowLean: 0.85, // how hard the key light steers that lean, unitless
  twist: 1.0, // 0..1 of a full turn of random yaw
  tilt: 0.12, // radians of extra random tip, any bearing

  /* --- the eruption --- */
  riseTime: 0.16, // seconds from buried to full height
  riseStagger: 0.14, // seconds of random delay between neighbours
  riseOvershoot: 0.22, // how far past full height the punch carries
  settle: 0.42, // seconds that overshoot damps out over
  springRate: 16.0, // radians/second of the overshoot ring
  emergeSink: 0.9, // fraction of its height a spear is buried at emerge = 0
  birthScale: 0.8, // footprint scale at the moment it breaks through
  birthFade: 0.24, // seconds the birth value decays over
  breachAt: 0.22, // emergence fraction that fires the breach event
  sinkDepth: 0.5, // extra metres a withdrawing spear drops

  /* --- one spear --- */
  spearSides: 5, // facets around the blade (4–8)
  spearTaper: 0.16, // radius at the shoulder, as a fraction of the base
  spearBarb: 1.25, // >1 flares a barb out just above the floor
  spearBarbAt: 0.3, // 0..1 up the spear that barb sits
  spearRough: 0.34, // how far the facets are pushed off a clean blade
  spearTwist: 0.35, // turns of flute from base to tip

  /* --- the rim, which is the entire shading model --- */
  colorBody: '#050308', // the spear. Not a tint on a lit surface — this IS it
  colorRim: '#8a5fd0', // the only bright colour anywhere in the ability
  colorBirth: '#c9a8ff', // the rim, for the instant a spear breaks the surface
  rimPower: 4.2, // how tight the fresnel is
  rimInner: 0.55, // how much of a wider, softer copy is subtracted back off
  rimGain: 1.35, // brightness of the rim before the ceiling
  rimCeiling: 0.82, // hard asymptote, linear HDR — keep below post.bloomThreshold
  rimShadowBias: 0.6, // 0..1 how much the rim prefers the unlit side
  rimTip: 0.45, // 0..1 how much more rim the tip gets than the base
  rimGrain: 0.5, // 0..1 how far the rim is eaten into by world-space grain
  rimGrainScale: 7.5, // grain features per metre
  birthRim: 0.9, // extra rim on a spear that has just arrived
  impactRim: 1.1, // extra rim on the whole field when the front lands
  impactRimTime: 0.45, // seconds that extra decays over

  /* --- the shadow pooled at the bases --- */
  shadowWidth: 1.9, // metres, half-width of the band
  shadowOffset: 0.85, // metres the band is pushed along the shadow direction
  shadowDepth: 0.5, // how dark the middle of the band goes, unitless
  shadowPool: 1.4, // metres one spear's pooling spreads along the band
  shadowEdge: 0.7, // metres of feather on the band's edges
  shadowRagged: 0.3, // how far the front wanders, fraction of the radius
  shadowRaggedScale: 0.55, // lobes per metre
  shadowWarp: 0.6, // metres of domain warp on those lobes
  shadowWander: 0.35, // how far the band drifts off the cast line, metres
  shadowSharp: 0.35, // 0..1 how hard the band's own edge is
  shadowRelief: 0.12, // how much the fake normal sculpts it — a shadow is flat
  shadowAmbient: 0.72, // floor on its diffuse term, so it does not read as a pit
  shadowOpacity: 0.85,
  shadowEmissive: 0.35, // multiplier on the one glowing term, the leading edge
  shadowMarkLife: 5.0, // seconds a pooled deepening lasts
  shadowHeight: 0.014, // metres above the floor the quad sits at
  colorShadow: '#0d0a14', // the band
  colorShadowDeep: '#020104', // under a spear
  colorShadowEdge: '#3a2a55', // its lip
  colorShadowFront: '#6a4aa8', // the line the front draws as it travels

  /* --- gloom and grit --- */
  /**
   * Two systems, both **non-additive** — deliberately. An additive haze around
   * a black object is a grey object, and every version of this that had one
   * looked like smoke with sticks in it.
   */
  gloomRate: 46, // dark haze off the bases, particles/second
  gloomSize: 1.15,
  gloomSpeed: 0.6,
  gloomLifetime: 2.0,
  gloomOpacity: 0.3,
  gloomRise: 0.24, // upward drift, metres/second
  colorGloomA: '#1a1424',
  colorGloomB: '#120d1a',
  colorGloomC: '#0a0710',
  colorGloomD: '#050308',
  gritRate: 30, // chips kicked up as a spear breaks through, particles/second
  gritSize: 0.05,
  gritSpeed: 3.4,
  gritLifetime: 1.1,
  gritGravity: -17.0,
  breachGrit: 5, // chips one breaching spear throws
  colorGritA: '#3a3140',
  colorGritB: '#2a2430',
  colorGritC: '#191420',
  colorGritD: '#0d0a12',

  /* --- dynamic light --- */
  // It is here to *tint* the floor under the field, not to light it. At the
  // shipped intensity it barely reaches the flagstones, which is the point:
  // a bright violet key would undo the whole slot in one slider.
  lightIntensity: 3.4,
  lightRadius: 7.5,
  lightColor: '#5a3aa0',

  /* --- the impact --- */
  impactShake: 0.45,
  shakeDuration: 0.5,
  rumble: 0.02, // continuous shake while the front travels
  impactGrit: 70 // chips thrown where the front lands
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Umbral Spears.
 *
 * The folder to open first is **The rim**, because it is the only lit thing in
 * the ability and every read the slot has comes out of five of its controls:
 * `rimPower` and `rimInner` (line or wash), `rimShadowBias` (which side of the
 * spear it appears on), `rimGain` (how loud) and `rimCeiling` (how loud it is
 * allowed to be before the bloom pass takes over).
 */
export const umbralspearsSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 4, 200, 0.5, 'front speed'],
    ['lifetime', 0.1, 8, 0.05, 'stand time'],
    ['sinkDelay', 0, 3, 0.01, 'sink delay'],
    ['sinkTime', 0.05, 4, 0.01, 'sink time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The field': [
    ['spearCount', 4, 240, 1, 'spears'],
    ['clusterShare', 0, 0.6, 0.01, 'impact ring share'],
    ['clusterRadius', -1, 6, 0.05, 'impact ring radius'],
    ['widthNear', 0, 4, 0.01, 'band half-width, near'],
    ['width', 0.05, 8, 0.01, 'band half-width, far'],
    ['widthCurve', 0.2, 4, 0.01, 'band curve'],
    ['frontBias', 0.2, 3, 0.01, 'crowd toward target'],
    ['clumping', 0.2, 4, 0.01, 'clumping'],
    ['scatter', 0, 2, 0.01, 'lateral scatter']
  ],
  'The silhouette': [
    ['heightNear', 0.05, 4, 0.01, 'height at caster'],
    ['height', 0.1, 8, 0.01, 'height at target'],
    ['heightCurve', 0.2, 4, 0.01, 'height curve'],
    ['heightJitter', 0, 1, 0.01, 'height jitter'],
    ['crown', 0, 1, 0.01, 'flank shortening'],
    ['crownPower', 0.2, 4, 0.01, 'crown falloff'],
    ['peak', 0.2, 3, 0.01, 'swell at target'],
    ['peakWidth', 0.02, 1, 0.01, 'swell width'],
    ['rubble', 0, 1, 0.01, 'stub chance'],
    ['rubbleScale', 0.05, 1, 0.01, 'stub height'],
    ['rubbleSpread', 0.5, 3, 0.01, 'stub girth'],
    ['minHeight', 0.01, 1, 0.01, 'minimum height'],
    ['radiusNear', 0.01, 1, 0.005, 'girth at caster'],
    ['radius2', 0.01, 1, 0.005, 'girth at target'],
    ['radiusCurve', 0.1, 3, 0.01, 'girth curve'],
    ['radiusJitter', 0, 1, 0.01, 'girth jitter'],
    ['minRadius', 0.005, 0.5, 0.005, 'minimum girth']
  ],
  'How they are aimed': [
    ['lean', -1.5, 1.5, 0.01, 'lean (rad)'],
    ['leanJitter', 0, 1, 0.01, 'lean jitter'],
    ['leanRamp', 0, 1, 0.01, 'lean ramp'],
    ['leanForward', -2, 2, 0.01, 'lean downrange'],
    ['leanOutward', -2, 2, 0.01, 'lean outward'],
    ['shadowLean', 0, 3, 0.01, 'lean with the light'],
    ['twist', 0, 1, 0.01, 'random yaw'],
    ['tilt', 0, 1.5, 0.01, 'random tip (rad)']
  ],
  'The eruption': [
    ['riseTime', 0.02, 1.5, 0.01, 'rise time'],
    ['riseStagger', 0, 1.5, 0.01, 'neighbour stagger'],
    ['riseOvershoot', 0, 1, 0.01, 'overshoot'],
    ['settle', 0.05, 2, 0.01, 'settle'],
    ['springRate', 1, 50, 0.5, 'spring rate'],
    ['emergeSink', 0, 1.5, 0.01, 'buried depth'],
    ['birthScale', 0.1, 1, 0.01, 'breakthrough scale'],
    ['birthFade', 0.02, 2, 0.01, 'birth decay'],
    ['breachAt', 0.02, 1, 0.01, 'breach point'],
    ['sinkDepth', 0, 3, 0.01, 'sink depth']
  ],
  'One spear': [
    ['spearSides', 4, 8, 1, 'facets'],
    ['spearTaper', 0.02, 0.8, 0.01, 'shoulder taper'],
    ['spearBarb', 0.3, 2, 0.01, 'barb flare'],
    ['spearBarbAt', 0.05, 0.8, 0.01, 'barb height'],
    ['spearRough', 0, 1, 0.01, 'facet roughness'],
    ['spearTwist', -1.5, 1.5, 0.01, 'flute twist']
  ],
  'The rim': [
    ['rimPower', 0.5, 12, 0.05, 'rim tightness'],
    ['rimInner', 0, 1, 0.01, 'rim thinning'],
    ['rimGain', 0, 4, 0.01, 'rim gain'],
    ['rimCeiling', 0.05, 1.2, 0.01, 'rim ceiling (bloom guard)'],
    ['rimShadowBias', 0, 1, 0.01, 'prefer the unlit side'],
    ['rimTip', 0, 1, 0.01, 'tip weighting'],
    ['rimGrain', 0, 1, 0.01, 'rim erosion'],
    ['rimGrainScale', 0.5, 30, 0.1, 'erosion / metre'],
    ['birthRim', 0, 4, 0.01, 'birth rim'],
    ['impactRim', 0, 4, 0.01, 'impact rim'],
    ['impactRimTime', 0.05, 2, 0.01, 'impact rim decay'],
    ['colorBody', 'body'],
    ['colorRim', 'rim'],
    ['colorBirth', 'birth rim']
  ],
  'The shadow': [
    ['shadowWidth', 0.1, 8, 0.05, 'band half-width'],
    ['shadowOffset', -4, 4, 0.05, 'offset along the shadow'],
    ['shadowDepth', 0, 2, 0.01, 'band darkness'],
    ['shadowPool', 0.1, 6, 0.05, 'pooling reach'],
    ['shadowEdge', 0.05, 3, 0.01, 'band feather'],
    ['shadowRagged', 0, 1.5, 0.01, 'front wander'],
    ['shadowRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['shadowWarp', 0, 3, 0.01, 'domain warp'],
    ['shadowWander', 0, 2, 0.01, 'band drift'],
    ['shadowSharp', 0, 1, 0.01, 'edge hardness'],
    ['shadowRelief', 0, 2, 0.01, 'relief'],
    ['shadowAmbient', 0, 1, 0.01, 'ambient floor'],
    ['shadowOpacity', 0, 1, 0.01, 'opacity'],
    ['shadowEmissive', 0, 2, 0.01, 'leading-edge glow'],
    ['shadowMarkLife', 0.2, 20, 0.1, 'pooling lifetime'],
    ['shadowHeight', 0.002, 0.2, 0.002, 'quad height'],
    ['colorShadow', 'band'],
    ['colorShadowDeep', 'under a spear'],
    ['colorShadowEdge', 'lip'],
    ['colorShadowFront', 'leading edge']
  ],
  'Gloom & grit': [
    ['gloomRate', 0, 400, 1, 'gloom rate'],
    ['gloomSize', 0.05, 4, 0.01, 'gloom size'],
    ['gloomSpeed', 0, 6, 0.05, 'gloom speed'],
    ['gloomLifetime', 0.2, 8, 0.05, 'gloom lifetime'],
    ['gloomOpacity', 0, 1, 0.005, 'gloom opacity'],
    ['gloomRise', -2, 4, 0.01, 'gloom rise'],
    ['gritRate', 0, 300, 1, 'grit rate'],
    ['gritSize', 0.005, 0.4, 0.005, 'grit size'],
    ['gritSpeed', 0, 20, 0.1, 'grit speed'],
    ['gritLifetime', 0.1, 5, 0.05, 'grit lifetime'],
    ['gritGravity', -50, 0, 0.1, 'grit gravity'],
    ['breachGrit', 0, 40, 1, 'chips per breach'],
    ['colorGloom*', 'Gloom colour'],
    ['colorGrit*', 'Grit colour']
  ],
  'The impact': [
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['impactGrit', 0, 400, 1, 'impact grit']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 40, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 30, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
