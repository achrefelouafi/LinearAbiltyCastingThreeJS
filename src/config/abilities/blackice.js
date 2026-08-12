/* ================================================================== */
/* BLACKICE — Black Ice                                                */
/* ================================================================== */
/**
 * A sheet of meltwater that freezes into a mirror.
 *
 * This is the only slot in the sandbox that reflects the **real scene**: a
 * camera mirrored about the sheet's plane renders the world layer into a small
 * target and the surface samples it projectively. Everything else in the
 * project that looks reflective is a fresnel ramp over an environment probe,
 * and the difference is parallax — an env map's reflection does not slide
 * across the surface as you orbit, and the eye reads a static reflection as
 * painted-on shine within about half a second of camera movement.
 *
 * Three numbers are the ability:
 *
 *  - **`roughWet` → `roughIce`** — the reflection's blur radius is
 *    `roughness × blurRadius` in reflection-UV, so a sheet at `roughWet = 1` is
 *    a scuffed puddle you can barely read the room in and a sheet at
 *    `roughIce = 0.02` is a black mirror. The freeze drives one to the other,
 *    and *that transition is the ability*. Drag `roughIce` up on a paused,
 *    fully frozen sheet and the room in it dissolves back into slush.
 *  - **`ripple`** — the surface disturbance, in reflection-UV. It is multiplied
 *    by `1 − freeze`, so the reflection stops moving at exactly the moment the
 *    water stops being water. Freezing a sheet whose reflection still swims is
 *    the tell that gives the whole thing away, and it is one multiply.
 *  - **`reflectWet` → `reflectIce`** — how much of the reflection survives at
 *    all. Water reflects hard at a grazing angle and weakly face-on (that is
 *    `fresnel`); ice reflects more evenly, so the fresnel term is not the thing
 *    that changes — the base weight is.
 *
 * **`resolution` is the cost slider.** The reflection is one extra
 * `renderer.render()` of the world layer, and halving this quarters its pixels
 * and changes its draw-call count not at all. 384² is 1.13 MB of half-float
 * colour and 16% of a 720p frame's pixels; 256 is plenty while the sheet is
 * still rough, and 512 is worth it for a black mirror you are going to stand
 * and look at. `mirrorPriority` is this sheet's claim on the two-mirrors-a-frame
 * budget, and matters only when something else reflective is on screen.
 *
 * The pool underneath and the plate crust over the top are `GroundField`s and
 * carry no reflection at all — they are the silhouette and the texture, and the
 * mirror is the middle of the sandwich.
 */
export const blackice = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 26.0, // how fast the front reaches the circle, metres/second
  cooldown: 1.6, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
  zoneRadius: 5.0, // metres — the footprint the aim indicator draws
  lifetime: 2.6, // seconds the sheet holds once it has landed
  thawTime: 1.8, // seconds the sheet takes to go back to water and vanish

  /* --- the beats, all measured from the moment the front lands --- */
  floodTime: 0.45, // seconds the meltwater takes to reach the full circle
  freezeDelay: 0.18, // seconds of open water before the freeze starts
  freezeTime: 1.15, // seconds the freeze takes to reach a mirror finish

  /* --- the mirror --- */
  sheetSpan: 0.92, // the reflective disc as a fraction of `zoneRadius`
  sheetHeight: 0.014, // metres above the floor the mirror plane sits at
  sheetOpacity: 0.95,
  sheetEdgeFade: 0.22, // 0..1 of the half-extent the disc feathers over
  roughWet: 1.0, // 0..1 blur at open water — barely a reflection at all
  roughIce: 0.02, // ... and at a full freeze. This is the black mirror.
  blurRadius: 0.045, // reflection-UV radius at roughness 1
  blurTaps: 7, // 1..12 taps in the roughness disc
  roughStretch: 1.4, // elongation of that disc along the normal's screen dir
  reflectWet: 0.55, // 0..1 reflection weight at open water
  reflectIce: 0.94, // ... and at a full freeze
  fresnel: 0.4, // 0..1 how much grazing angle shapes the reflection
  fresnelPower: 2.2,
  ripple: 0.02, // reflection-UV amplitude of the surface disturbance
  rippleScale: 1.6, // cycles per metre
  rippleSpeed: 0.7, // metres per second
  resolution: 384, // reflection target edge, pixels. The cost slider.
  mirrorPriority: 1.4, // claim on the two-reflections-a-frame budget
  colorTint: '#c6d8e2', // multiplies the reflection — black ice is not neutral
  colorSheet: '#0a1218', // what shows where the surface does not reflect

  /* --- the meltwater pool underneath --- */
  poolSpan: 1.0, // pool radius as a fraction of `zoneRadius`
  poolHeight: 0.006, // metres above the floor
  poolEdge: 0.4, // metres of feather on the spreading front
  poolRagged: 0.3, // how far that front wanders, fraction of the radius
  poolRaggedScale: 0.55, // lobes per metre
  poolWarp: 0.6, // metres of domain warp on those lobes
  poolRelief: 0.45, // how hard the height field tilts the fake normal
  poolNormalStep: 0.07, // metres between the height taps
  poolAmbient: 0.22, // floor on the diffuse term — this is dark water
  poolWrap: 0.4,
  poolSpecular: 1.15, // wet stone is mostly specular
  poolGloss: 46.0, // Blinn exponent
  poolParallax: 0.28, // metres of view-driven offset on the interior
  poolCell: 0.9, // ripple scale, metres
  poolThickness: 0.16, // metres of meniscus at the rim
  poolLift: 0.035, // metres of wave height
  poolDepth: 0.05, // metres of body depth
  poolDetail: 0.75,
  poolSpeed: 1.0, // ripple rate — multiplied by (1 − freeze)
  poolFlow: 0.22, // metres/second of drift — likewise
  poolWind: 0.9, // radians, the drift bearing in the quad's frame
  poolEmissive: 0.5,
  poolOpacity: 0.9,
  poolDepthFade: 0.4, // metres of soft fade against standing geometry
  colorPoolBase: '#131b21', // the water body
  colorPoolEdge: '#9fc4d6', // the meniscus and the sheen
  colorPoolGlow: '#4c8f96', // anything emissive in it
  colorPoolDeep: '#05090c', // the interior

  /* --- the plate crust over the top --- */
  crustSpan: 0.98, // crust radius as a fraction of `zoneRadius`
  crustHeight: 0.022, // metres above the floor — over the mirror
  crustEdge: 0.55, // metres of feather on the freezing front
  crustRagged: 0.42, // how far that front wanders — ice fronts are ragged
  crustRaggedScale: 0.75, // lobes per metre
  crustWarp: 0.7, // metres of domain warp
  crustRelief: 0.35,
  crustNormalStep: 0.05,
  crustAmbient: 0.3,
  crustWrap: 0.5,
  crustSpecular: 0.85,
  crustGloss: 34.0,
  crustParallax: 0.12,
  crustCell: 1.5, // metres — plate size. Big plates: this is one sheet.
  crustCellJitter: 0.9, // 0..1 irregularity of the plate tessellation
  crustSeam: 0.035, // metres of gap between plates
  crustThickness: 0.02, // metres of sheet
  crustLift: 0.006, // metres of curl — nearly none. Black ice lies flat.
  crustDetail: 0.5,
  crustEmissive: 0.7,
  crustOpacity: 0.34, // low: the crust is a veil of seams over the reflection
  crustDepthFade: 0.35,
  colorCrustBase: '#243440', // the ice sheet itself
  colorCrustEdge: '#dcefff', // the plate lips
  colorCrustGlow: '#7ecbe0', // anything emissive
  colorCrustDeep: '#0a1016', // the seams

  /* --- the cold fog crawling over the sheet --- */
  mistRate: 42.0, // particles/second
  mistSpeed: 1.1, // metres/second
  mistRise: 0.28, // metres/second² — it hugs the floor
  mistSize: 1.7,
  mistLifetime: 2.4, // seconds
  mistOpacity: 0.42,
  impactMist: 55, // particles thrown as the water lands
  colorMistA: '#e6f2fb',
  colorMistB: '#b7ccdd',
  colorMistC: '#7b93a8',
  colorMistD: '#3f4f5e',

  /* --- crystals lighting up along the freeze front --- */
  glintRate: 64.0, // particles/second
  glintSpeed: 0.9, // metres/second
  glintRise: 0.55, // metres/second²
  glintSize: 0.075,
  glintLifetime: 1.1, // seconds
  glintTurbulence: 0.7,
  colorGlintA: '#ffffff',
  colorGlintB: '#bfe8ff',
  colorGlintC: '#5aa6c4',
  colorGlintD: '#1f3a4a',

  /* --- flecks of water and shattered ice --- */
  impactSpray: 46, // particles as the water lands
  thawSpray: 34, // ... and as the sheet lets go
  spraySpeed: 4.0, // metres/second
  sprayGravity: -13.0, // metres/second²
  spraySize: 0.11,
  sprayLifetime: 1.2, // seconds
  colorSprayA: '#eaf6ff',
  colorSprayB: '#a9c9dd',
  colorSprayC: '#5c7a8e',
  colorSprayD: '#243440',

  /* --- landing and letting go --- */
  burstSize: 2.2, // metres, the shell of freezing air
  burstIntensity: 0.7,
  colorBurstA: '#dff0ff',
  colorBurstB: '#8fc0d8',
  colorBurstC: '#2d4a5c',
  shockRadius: 5.2, // metres, the ring across the floor
  colorShockA: '#e6f4ff',
  colorShockB: '#4c8f96',
  impactShake: 0.34,
  shakeDuration: 0.6, // seconds
  impactFlash: 0.14, // black ice is dark; this is nearly off
  colorFlash: '#cfe4f0',
  rumble: 0.2, // continuous shake while the front is running

  /* --- the light --- */
  lightColor: '#8fc0d8',
  lightIntensity: 4.0,
  lightRadius: 11.0,
  lightPulse: 0.18, // depth of the slow breathing on the light
  lightPulseSpeed: 0.55 // cycles/second of it
};

/** Editor layout. */
export const blackiceSchema = {
  'The cast': [
    ['range', 2, 48, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 80, 0.5, 'front speed'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['zoneRadius', 1, 14, 0.1, 'footprint radius'],
    ['lifetime', 0.1, 10, 0.05, 'sheet lifetime'],
    ['thawTime', 0.1, 6, 0.05, 'thaw time'],
    ['castAnim', 'cast animation']
  ],
  'The freeze': [
    ['floodTime', 0.05, 3, 0.01, 'flood (s)'],
    ['freezeDelay', 0, 2, 0.01, 'open water first (s)'],
    ['freezeTime', 0.05, 6, 0.05, 'freeze (s)']
  ],
  'The mirror': [
    ['roughWet', 0, 1, 0.005, 'roughness — water'],
    ['roughIce', 0, 1, 0.005, 'roughness — ice'],
    ['reflectWet', 0, 1, 0.01, 'reflectivity — water'],
    ['reflectIce', 0, 1, 0.01, 'reflectivity — ice'],
    ['blurRadius', 0, 0.2, 0.001, 'blur radius (uv)'],
    ['blurTaps', 1, 12, 1, 'blur taps'],
    ['roughStretch', 0, 4, 0.05, 'blur stretch'],
    ['fresnel', 0, 1, 0.01, 'fresnel'],
    ['fresnelPower', 0.2, 8, 0.05, 'fresnel curve'],
    ['ripple', 0, 0.15, 0.001, 'ripple (uv)'],
    ['rippleScale', 0.1, 8, 0.05, 'ripple cycles/m'],
    ['rippleSpeed', 0, 5, 0.05, 'ripple speed'],
    ['sheetSpan', 0.2, 1.4, 0.01, 'disc span'],
    ['sheetHeight', 0, 0.2, 0.001, 'plane height (m)'],
    ['sheetOpacity', 0, 1, 0.01, 'opacity'],
    ['sheetEdgeFade', 0.01, 1, 0.01, 'edge fade'],
    ['resolution', 64, 1024, 32, 'target edge (px)'],
    ['mirrorPriority', 0, 6, 0.05, 'budget priority'],
    'colorTint',
    'colorSheet'
  ],
  'The pool': [
    ['poolSpan', 0.2, 1.6, 0.01, 'span'],
    ['poolHeight', 0, 0.2, 0.001, 'height (m)'],
    ['poolEdge', 0.02, 3, 0.01, 'front feather (m)'],
    ['poolRagged', 0, 1, 0.01, 'front wander'],
    ['poolRaggedScale', 0.05, 4, 0.01, 'lobes/m'],
    ['poolWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['poolCell', 0.05, 4, 0.01, 'ripple scale (m)'],
    ['poolThickness', 0, 1, 0.005, 'meniscus (m)'],
    ['poolLift', 0, 0.5, 0.001, 'wave height (m)'],
    ['poolDepth', 0, 1, 0.005, 'body depth (m)'],
    ['poolDetail', 0, 1, 0.01, 'detail'],
    ['poolSpeed', 0, 6, 0.05, 'ripple rate'],
    ['poolFlow', 0, 3, 0.01, 'drift (m/s)'],
    ['poolWind', 0, 6.28, 0.01, 'drift bearing']
  ],
  'The pool/Surface': [
    ['poolRelief', 0, 3, 0.01, 'relief'],
    ['poolNormalStep', 0.01, 0.4, 0.005, 'normal step (m)'],
    ['poolAmbient', 0, 1, 0.01, 'ambient'],
    ['poolWrap', 0, 1, 0.01, 'light wrap'],
    ['poolSpecular', 0, 3, 0.01, 'specular'],
    ['poolGloss', 1, 128, 1, 'gloss'],
    ['poolParallax', 0, 1, 0.01, 'parallax'],
    ['poolEmissive', 0, 3, 0.01, 'emissive'],
    ['poolOpacity', 0, 1, 0.01, 'opacity'],
    ['poolDepthFade', 0, 2, 0.01, 'depth fade (m)'],
    'colorPoolBase',
    'colorPoolEdge',
    'colorPoolGlow',
    'colorPoolDeep'
  ],
  'The crust': [
    ['crustSpan', 0.2, 1.6, 0.01, 'span'],
    ['crustHeight', 0, 0.2, 0.001, 'height (m)'],
    ['crustEdge', 0.02, 3, 0.01, 'front feather (m)'],
    ['crustRagged', 0, 1, 0.01, 'front wander'],
    ['crustRaggedScale', 0.05, 4, 0.01, 'lobes/m'],
    ['crustWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['crustCell', 0.1, 5, 0.01, 'plate size (m)'],
    ['crustCellJitter', 0, 1, 0.01, 'plate irregularity'],
    ['crustSeam', 0, 0.4, 0.001, 'seam (m)'],
    ['crustThickness', 0, 0.3, 0.001, 'sheet (m)'],
    ['crustLift', 0, 0.3, 0.001, 'curl (m)'],
    ['crustDetail', 0, 1, 0.01, 'detail']
  ],
  'The crust/Surface': [
    ['crustRelief', 0, 3, 0.01, 'relief'],
    ['crustNormalStep', 0.01, 0.4, 0.005, 'normal step (m)'],
    ['crustAmbient', 0, 1, 0.01, 'ambient'],
    ['crustWrap', 0, 1, 0.01, 'light wrap'],
    ['crustSpecular', 0, 3, 0.01, 'specular'],
    ['crustGloss', 1, 128, 1, 'gloss'],
    ['crustParallax', 0, 1, 0.01, 'parallax'],
    ['crustEmissive', 0, 3, 0.01, 'emissive'],
    ['crustOpacity', 0, 1, 0.01, 'opacity'],
    ['crustDepthFade', 0, 2, 0.01, 'depth fade (m)'],
    'colorCrustBase',
    'colorCrustEdge',
    'colorCrustGlow',
    'colorCrustDeep'
  ],
  'Fog': [
    ['mistRate', 0, 300, 1, 'rate'],
    ['mistSpeed', 0, 10, 0.05, 'speed'],
    ['mistRise', -3, 4, 0.02, 'buoyancy'],
    ['mistSize', 0.05, 5, 0.01, 'size'],
    ['mistLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['mistOpacity', 0, 1, 0.01, 'opacity'],
    ['impactMist', 0, 300, 1, 'at the landing'],
    'colorMistA',
    'colorMistB',
    'colorMistC',
    'colorMistD'
  ],
  'Crystals': [
    ['glintRate', 0, 300, 1, 'rate'],
    ['glintSpeed', 0, 10, 0.05, 'speed'],
    ['glintRise', -3, 4, 0.02, 'buoyancy'],
    ['glintSize', 0.01, 1, 0.005, 'size'],
    ['glintLifetime', 0.1, 6, 0.05, 'lifetime'],
    ['glintTurbulence', 0, 4, 0.01, 'turbulence'],
    'colorGlintA',
    'colorGlintB',
    'colorGlintC',
    'colorGlintD'
  ],
  'Spray': [
    ['impactSpray', 0, 300, 1, 'at the landing'],
    ['thawSpray', 0, 300, 1, 'at the thaw'],
    ['spraySpeed', 0, 20, 0.1, 'speed'],
    ['sprayGravity', -40, 0, 0.5, 'gravity'],
    ['spraySize', 0.02, 1, 0.005, 'size'],
    ['sprayLifetime', 0.1, 6, 0.05, 'lifetime'],
    'colorSprayA',
    'colorSprayB',
    'colorSprayC',
    'colorSprayD'
  ],
  'Landing': [
    ['burstSize', 0.2, 12, 0.05, 'shell size'],
    ['burstIntensity', 0, 4, 0.01, 'shell intensity'],
    ['shockRadius', 0.5, 16, 0.1, 'ring radius'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration'],
    ['impactFlash', 0, 1.5, 0.01, 'flash'],
    ['rumble', 0, 3, 0.01, 'rumble'],
    'colorBurstA',
    'colorBurstB',
    'colorBurstC',
    'colorShockA',
    'colorShockB',
    'colorFlash'
  ],
  'The light': [
    ['lightIntensity', 0, 40, 0.1, 'intensity'],
    ['lightRadius', 1, 40, 0.5, 'radius'],
    ['lightPulse', 0, 1, 0.01, 'breath depth'],
    ['lightPulseSpeed', 0, 6, 0.05, 'breath speed'],
    'lightColor'
  ]
};
