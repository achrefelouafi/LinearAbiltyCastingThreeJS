/* ================================================================== */
/* AURORA — Aurora Veil, the aether school's quiet far cast            */
/* ================================================================== */
/**
 * A ring of vertical sheets standing in the circle, rippling, banded in three
 * hues, and washing the floor underneath with their own colour.
 *
 * **The trick is the mismatch between two curves.** A hanging ribbon and a
 * curtain of aurora are the same geometry; the only thing that separates them
 * is that on cloth, coverage and brightness fall off *together* — where it
 * thins it both stops hiding things and stops being bright. Light in air does
 * not do that. A column of excited gas keeps radiating long after it has
 * stopped occluding anything, so the top of a real aurora is bright and
 * transparent at the same time.
 *
 * So `Curtain` runs two independent curves up the sheet:
 *
 * ```
 * alpha    = mix(alphaTop,    alphaBase,    pow(1 - h, alphaCurve))
 * emission = mix(emissionTop, emissionBase, pow(1 - h, emissionCurve))
 * ```
 *
 * and **both exponents are sliders below, and they are meant to disagree.**
 * The library's own defaults are `alphaCurve` 2.4 against `emissionCurve` 0.7;
 * this block pushes them further apart still, to 2.6 against 0.55, because the
 * sandbox's bloom chain is generous and the head of the sheet can afford to be
 * almost pure radiance. Set the two equal, look at it once, and the hanging
 * ribbon you were trying not to make is exactly what is standing there.
 *
 * The second reason it reads as air is `veilGraze`: a sheet has no thickness,
 * so a ray crossing it face-on passes through nothing while a ray crossing it
 * edge-on travels the length of a fold. Both curves are scaled by `1/|N·V|`,
 * floored at `veilGrazeFloor`. Turn `veilGraze` to zero and the curtain becomes
 * a decal that looks identical from every angle.
 *
 * **There is no violence in this slot.** No impact, no screen flash, no camera
 * shake, no shockwave, no burst, and the floor companion's impact-ring term is
 * held at zero in the ability rather than exposed here. It is the one ability
 * in the sandbox that is a relief to cast, and every knob below was chosen to
 * keep it that way — `speed` is deliberately slow enough that you watch it
 * cross, and `lifetime` is deliberately long enough that you stop waiting for
 * something to happen.
 *
 * Three beats: **rise** (travel — the sheets come up out of the floor on a
 * staggered wave), **ripple** (impact, and it is a very long hold), **fade**
 * (the feet leave the ground and the whole veil climbs away over `fadeLift`).
 *
 * A cast captures nothing but a seed and the phase clock. Every metre below is
 * re-read inside the update loop, on a zero-length frame included — pause and
 * drag `veilSpread` and the ring re-lays itself around you.
 */
export const aurora = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  zoneRadius: 6.0, // the footprint — what the circle indicator measures out
  speed: 18.0, // how fast the veil's front crosses to the point, metres/second
  lifetime: 7.0, // seconds the veil stands and ripples. This is the ability
  fadeTime: 3.4, // seconds it takes to climb away
  cooldown: 2.0,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the layout --- */
  veilLayout: 1, // 0 line · 1 ring · 2 scatter — a live uniform, no recompile
  veilCount: 9, // sheets drawn (hard ceiling 12)
  veilSpacing: 2.2, // metres between sheets, LINE layout only
  veilSpread: 1.0, // ring / scatter radius as a multiple of `zoneRadius`
  veilScatter: 0.7, // metres of hashed slop off each sheet's nominal place
  veilRiseSpread: 0.6, // 0..1 stagger of the rise wave across the sheets

  /* --- the body of a sheet --- */
  veilWidth: 5.2, // metres along the sheet
  veilWidthJitter: 0.3, // ±fraction
  veilHeight: 7.5, // metres tall
  veilHeightJitter: 0.28, // ±fraction
  veilBase: 0.15, // metres the foot sits above the floor
  veilTaper: 1.15, // width multiplier at the head; >1 flares
  veilLean: 1.3, // metres the head is pushed along the sheet's own normal
  veilLeanJitter: 0.6, // ±fraction
  fadeLift: 4.5, // metres the feet climb over the fade — how it lets go

  /* --- the travelling ripple --- */
  rippleAmp: 0.9, // metres of the fast fold
  rippleLength: 4.2, // metres along the sheet, crest to crest
  rippleSpeed: 0.85, // metres/second the crest travels
  rippleCurve: 1.15, // exponent on height: 0 rigid, >0 pins the foot
  foldAmp: 1.6, // metres of the second, much longer fold
  foldLength: 12.0, // metres
  foldSpeed: 0.3, // metres/second
  rippleNoise: 0.3, // metres of fbm slop on top of both
  rippleNoiseScale: 0.3, // cycles per metre
  rippleNoiseSpeed: 0.11, // Hz
  phaseSpread: 1.2, // turns of per-sheet phase offset

  /* --- the two curves. The whole ability is in these six numbers. --- */
  alphaBase: 0.95, // coverage at the foot
  alphaTop: 0.0, // coverage at the head — nothing, it is only light up there
  alphaCurve: 2.6, // how fast coverage dies with height
  emissionBase: 0.8, // radiance at the foot
  emissionTop: 0.55, // radiance at the head. Deliberately NOT alphaTop
  emissionCurve: 0.55, // ... and deliberately NOT alphaCurve. See the header

  /* --- the envelope --- */
  veilBody: 0.22, // 0..1 how much alpha the sheet is allowed at all
  veilFootFade: 0.05, // 0..1 of the height
  veilHeadFade: 0.32, // 0..1 of the height
  veilEdgeFade: 0.36, // 0..1 across the sheet
  veilGraze: 1.0, // 0..1 how much of the 1/|N·V| path term is applied
  veilGrazeFloor: 0.1, // clamp on |N·V| — 0.1 gives a 10× ceiling
  veilSoftFade: 0.7, // metres of depth fade against opaque geometry
  veilOpacity: 1.0,
  veilGlow: 1.45, // emissive gain into the bloom chain
  veilTintSpread: 0.55, // 0..1 how far apart neighbouring sheets are tinted

  /* --- the aurora itself --- */
  rayScale: 0.75, // cycles per metre of the vertical striations
  raySpeed: 0.05, // Hz — the striations drift along the sheet
  raySharp: 0.5, // 0..1 how hard a ray's edge is
  bandScale: 0.1, // cycles per metre of the three-way hue band
  bandSpeed: 0.03, // Hz
  hem: 0.14, // 0..1 of the height — the coloured band along the bottom edge

  colorA: '#5fffc0', // the green body
  colorB: '#3a9aff', // the blue band
  colorC: '#c05fff', // the violet band
  colorHem: '#ff7ab0', // the hem. Real aurora has one; leaving it out is why
  colorBody: '#0e1a26', // what little substance the sheet has

  /* --- the wash on the floor --- */
  // `Curtain`'s floor companion: one extra quad walking the same sheet frame,
  // so the light under a sheet cannot drift out from under it. Impact rings are
  // part of that companion and are held at zero by the ability — this slot has
  // no impacts to ring.
  washSpread: 2.6, // quad extent as a multiple of `zoneRadius`
  washFade: 0.4, // 0..1 of the half-extent where it dies
  washWet: 0.3, // 0..1 how reflective the stone reads
  washDark: 0.18, // 0..1 how much that darkens it. Low: this is light, not rain
  washSheen: 1.1, // env reflection gain
  washSheenRough: 0.8, // cycles per metre of the surface ripple
  washSheenSpeed: 0.25, // Hz
  washFresnel: 1.6,
  washPool: 1.0, // 0..1 master on the per-sheet footprints
  washPoolWidth: 2.6, // metres either side of a sheet
  washPoolLength: 1.15, // 0..1 of the sheet's own half-width
  washPoolSoft: 2.2, // metres of feather
  washOpacity: 0.7,
  colorWash: '#101c2a', // the damp stone
  colorPool: '#2f6a5c', // the coloured light lying under a sheet
  colorRing: '#8fe8d8', // the ring term's colour; unused, see above

  /* --- drift: the motes that hang in the air under the veil --- */
  driftRate: 26, // particles/second
  driftSize: 0.05,
  driftSpeed: 0.35, // metres/second
  driftLifetime: 4.5, // seconds
  driftRise: 0.22, // metres/second of buoyancy
  driftTurbulence: 0.4,
  driftSpread: 1.05, // 0..1 of the footprint radius they are born across
  driftCeiling: 0.55, // × `veilHeight`, how high they are seeded
  colorDriftA: '#e8fff4',
  colorDriftB: '#5fffc0',
  colorDriftC: '#3a9aff',
  colorDriftD: '#101c2a',

  /* --- dynamic light --- */
  lightIntensity: 7.0, // low. The veil is its own light; this is the spill
  lightRadius: 16.0,
  lightColor: '#5fe8c0',
  lightHeight: 3.4, // metres above the ring the light hangs at
  lightSway: 0.18, // depth of the slow swell
  lightSwaySpeed: 0.22 // swells per second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Aurora Veil.
 *
 * Start in **The two curves**. `alphaCurve` and `emissionCurve` are the ability;
 * drag them together and watch it turn into a hanging rag, then drag them apart
 * again. After that, `veilLean` and `rippleAmp` decide whether the sheets fold
 * (they must — the graze term only shows on a fold), and `veilTintSpread`
 * decides whether the ring is one colour or three.
 */
export const auroraSchema = {
  'The cast': [
    ['range', 4, 45, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['zoneRadius', 1, 14, 0.05, 'footprint radius'],
    ['speed', 3, 80, 0.5, 'rise-front speed'],
    ['lifetime', 0.5, 20, 0.05, 'hold'],
    ['fadeTime', 0.2, 10, 0.05, 'fade time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The two curves': [
    ['alphaBase', 0, 2, 0.01, 'coverage at the foot'],
    ['alphaTop', 0, 2, 0.01, 'coverage at the head'],
    ['alphaCurve', 0.1, 6, 0.01, 'alpha curve'],
    ['emissionBase', 0, 3, 0.01, 'radiance at the foot'],
    ['emissionTop', 0, 3, 0.01, 'radiance at the head'],
    ['emissionCurve', 0.1, 6, 0.01, 'emission curve']
  ],
  'The layout': [
    ['veilLayout', 0, 2, 1, 'line / ring / scatter'],
    ['veilCount', 1, 12, 1, 'sheets'],
    ['veilSpacing', 0.1, 8, 0.05, 'sheet spacing (m)'],
    ['veilSpread', 0.1, 3, 0.01, 'ring radius × zone'],
    ['veilScatter', 0, 4, 0.01, 'placement slop (m)'],
    ['veilRiseSpread', 0, 0.95, 0.01, 'rise stagger']
  ],
  'The sheet': [
    ['veilWidth', 0.2, 16, 0.05, 'width (m)'],
    ['veilWidthJitter', 0, 1, 0.01, 'width jitter'],
    ['veilHeight', 0.5, 20, 0.05, 'height (m)'],
    ['veilHeightJitter', 0, 1, 0.01, 'height jitter'],
    ['veilBase', -1, 4, 0.01, 'foot height (m)'],
    ['veilTaper', 0.05, 3, 0.01, 'head width ×'],
    ['veilLean', -4, 4, 0.01, 'lean (m)'],
    ['veilLeanJitter', 0, 1.5, 0.01, 'lean jitter'],
    ['fadeLift', 0, 14, 0.05, 'climb on fade (m)']
  ],
  'The ripple': [
    ['rippleAmp', 0, 4, 0.01, 'ripple amplitude (m)'],
    ['rippleLength', 0.2, 20, 0.05, 'ripple length (m)'],
    ['rippleSpeed', -6, 6, 0.01, 'ripple speed (m/s)'],
    ['rippleCurve', 0, 4, 0.01, 'ripple height curve'],
    ['foldAmp', 0, 6, 0.01, 'fold amplitude (m)'],
    ['foldLength', 0.5, 40, 0.1, 'fold length (m)'],
    ['foldSpeed', -4, 4, 0.01, 'fold speed (m/s)'],
    ['rippleNoise', 0, 2, 0.01, 'noise slop (m)'],
    ['rippleNoiseScale', 0.02, 3, 0.01, 'noise cycles / m'],
    ['rippleNoiseSpeed', 0, 2, 0.01, 'noise speed (Hz)'],
    ['phaseSpread', 0, 4, 0.01, 'per-sheet phase']
  ],
  'The envelope': [
    ['veilBody', 0, 1, 0.005, 'substance'],
    ['veilFootFade', 0, 0.5, 0.005, 'foot fade'],
    ['veilHeadFade', 0, 0.9, 0.005, 'head fade'],
    ['veilEdgeFade', 0, 0.9, 0.005, 'edge fade'],
    ['veilGraze', 0, 1, 0.01, 'grazing path term'],
    ['veilGrazeFloor', 0.02, 1, 0.005, 'graze clamp'],
    ['veilSoftFade', 0.02, 4, 0.01, 'soft intersection (m)'],
    ['veilOpacity', 0, 2, 0.01, 'opacity'],
    ['veilGlow', 0, 6, 0.01, 'glow'],
    ['veilTintSpread', 0, 1, 0.01, 'tint spread']
  ],
  'The aurora': [
    ['rayScale', 0.02, 4, 0.01, 'ray cycles / m'],
    ['raySpeed', -1, 1, 0.005, 'ray drift (Hz)'],
    ['raySharp', 0, 1, 0.01, 'ray sharpness'],
    ['bandScale', 0.005, 1, 0.005, 'band cycles / m'],
    ['bandSpeed', -0.5, 0.5, 0.005, 'band drift (Hz)'],
    ['hem', 0, 0.6, 0.005, 'hem height'],
    ['colorA', 'green body'],
    ['colorB', 'blue band'],
    ['colorC', 'violet band'],
    ['colorHem', 'hem'],
    ['colorBody', 'substance']
  ],
  'The floor wash': [
    ['washSpread', 0.5, 6, 0.05, 'quad extent × zone'],
    ['washFade', 0.02, 1, 0.01, 'edge fade'],
    ['washWet', 0, 1, 0.01, 'wetness'],
    ['washDark', 0, 1, 0.01, 'darkening'],
    ['washSheen', 0, 3, 0.01, 'reflection gain'],
    ['washSheenRough', 0.05, 4, 0.01, 'ripple cycles / m'],
    ['washSheenSpeed', 0, 3, 0.01, 'ripple speed (Hz)'],
    ['washFresnel', 0.2, 6, 0.01, 'fresnel'],
    ['washPool', 0, 2, 0.01, 'footprint light'],
    ['washPoolWidth', 0.05, 8, 0.05, 'footprint width (m)'],
    ['washPoolLength', 0, 3, 0.01, 'footprint length ×'],
    ['washPoolSoft', 0.05, 6, 0.05, 'footprint feather (m)'],
    ['washOpacity', 0, 2, 0.01, 'wash opacity'],
    ['colorWash', 'damp stone'],
    ['colorPool', 'light on the floor'],
    ['colorRing', 'ring (unused)']
  ],
  Drift: [
    ['driftRate', 0, 300, 1, 'motes / second'],
    ['driftSize', 0.005, 0.4, 0.005, 'mote size'],
    ['driftSpeed', 0, 4, 0.01, 'mote speed (m/s)'],
    ['driftLifetime', 0.2, 12, 0.05, 'mote lifetime (s)'],
    ['driftRise', -2, 3, 0.01, 'mote rise'],
    ['driftTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['driftSpread', 0, 2, 0.01, 'seeded across × radius'],
    ['driftCeiling', 0, 2, 0.01, 'seeded up to × height'],
    ['colorDrift*', 'Mote colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 40, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 12, 0.05, 'light height (m)'],
    ['lightSway', 0, 1, 0.01, 'sway depth'],
    ['lightSwaySpeed', 0, 3, 0.01, 'sways / second'],
    ['lightColor', 'light colour']
  ]
};
