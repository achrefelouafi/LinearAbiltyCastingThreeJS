/* ================================================================== */
/* INKBLOOM — Ink Bloom                                                */
/* ================================================================== */
/**
 * A bead of ink dropped into standing water, opening on the floor.
 *
 * The trick is a **fingering instability**, and it lives in
 * `vfx/InkDiffusion.js` rather than here: a front whose bulges see a steeper
 * gradient, move faster and become fingers, with the coarse modes inadmissible
 * until the blob has grown into them. This block's job is to aim that
 * mechanism, and there is exactly one number that decides what the pattern *is*
 * — `bloomCoarse`, the wavelength of the largest lobe the bloom can ever grow.
 * Read it against `zoneRadius` before touching anything else. At 2.6 m on a
 * 5.2 m circle you get five or six fat branching lobes; drop it to 0.9 m and
 * the same cast comes out as lace.
 *
 * ### Two fronts, not one
 *
 * The ability draws **two** `InkDiffusion` fields, because a drop of ink in
 * water is two substances arriving at different speeds and that separation is
 * the thing your eye actually uses to date the mark:
 *
 *  - the **wash** (`wash*`, `InkMode.WASH`) is the solvent. It is stable — the
 *    `WASH` mode has no instability term compiled into it at all — spreads
 *    faster (`washSpread` well above `bloomSpread`), and carries a strong
 *    deposition ring at its edge. That ring is the cauliflower line every
 *    watercolour has, and it is the *water's* boundary, always outside the
 *    pigment's.
 *  - the **bloom** (`bloom*`, `InkMode.BLOOM`) is the pigment, and it lags by
 *    `pigmentDelay`, spreads more slowly, and fingers.
 *
 * Set `washSpread` below `bloomSpread` and the illusion inverts instantly: the
 * pigment overtakes its own solvent and the mark reads as a decal with a halo
 * painted round it. The ordering is the design.
 *
 * ### Why so many of these are metres
 *
 * Everything the two fields read is resolved per frame, so `bloomCoarse`,
 * `bloomSpread` and `washRingWidth` are all live on a standing bloom. Pause
 * with **P** halfway through and drag `bloomOnset`: the octaves are re-admitted
 * against the front radius they have *already* reached, so the pattern coarsens
 * or crinkles in place rather than restarting.
 *
 * ### The school has no bloom in it
 *
 * There is no screen flash, no burst shell, no additive particle and no decal
 * in this ability. `bloomCeiling` and `washCeiling` hard-clamp each field's
 * output luminance below `post.bloomThreshold`, so no combination of the
 * fourteen pickers below can feed the bloom pass. The single specular term is
 * the wet gloss on the leading edge, and it is inside that clamp — a reflection
 * that cannot exceed the bloom threshold is an observation about a wet surface,
 * not an emission.
 */

export const inkbloom = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 130.0, // how fast the bead reaches the water, metres/second
  zoneRadius: 5.2, // the pool the ink is allowed to fill, metres
  cooldown: 1.6, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats, in seconds ---
   * All three are scaled by `global.lifetime`, including `pigmentDelay`: a
   * slow-motion bloom in which the pigment still catches the water up in the
   * same tenth of a second is a bloom whose two fronts have stopped being two.
   */
  pigmentDelay: 0.16, // seconds the pigment lags the solvent
  holdTime: 4.2, // seconds the bloom is allowed to keep opening
  fadeTime: 2.4, // seconds it soaks away over

  /* --- where the bead comes from --- */
  handHeight: 1.35, // metres above the floor the bead leaves the caster at
  handForward: 0.5, // metres in front of the caster
  handSide: 0.22, // metres to the side (+ follows `Ability#side`)
  dropLift: 0.06, // metres the bead rides above the floor as it arrives
  dropRate: 1.3, // pigment grains shed per metre of travel

  /* ================================================================ */
  /* The wash — InkDiffusion(WASH), the solvent                        */
  /* ================================================================ */
  /**
   * The water. One nucleus, no instability, a soft interface and a hard ring.
   *
   * `washSpread` is the number that keeps the halo outside the pigment. It is
   * the front radius at one second, and against `bloomSpread` at 2.15 it buys
   * roughly a metre of clear wet paper ahead of the ink for the whole cast.
   */
  washHeight: 0.012, // metres above the floor — under the pigment
  washSpread: 3.35, // metres of front radius at t = 1 s
  washSpreadPower: 0.5, // r ~ t^power; 0.5 is Fickian
  washEdge: 0.26, // metres of interface — wide, because water has no edge
  washClipSoft: 1.3, // metres the wash fades out over as it meets `zoneRadius`
  washCore: 0.82, // density floor inside it — nearly flat, it is not pigment
  washFalloff: 7.5, // metres of e-folding from the nucleus
  washFilm: 0.35, // alpha floor inside the coverage
  washGranulation: 0.1, // the paper's tooth showing through wet
  washGranScale: 1.15, // features per metre
  washRing: 0.9, // the cauliflower line at the water's edge — the point of the field
  washRingWidth: 0.19, // metres
  washDryTime: 3.4, // seconds for the sheen to fall to 1/e
  washWetDarken: 0.55, // how far wet paper pulls toward `washColorWet`
  washGloss: 0.3, // specular on the wet film — the strongest one in the school
  washGlossPower: 30, // its tightness — broad, because water beads shallow
  washMeniscus: 0.7, // how far the film's normal tips at the interface
  washOpacity: 0.62,
  washCeiling: 0.6, // max linear luminance; `post.bloomThreshold` is 0.88
  washSoftFade: 0.3, // metres of depth feather against standing geometry
  washTint: 0.12, // where in the gradient a zero-density film sits
  washTintDensity: 0.7, // how far density walks it
  washColorThin: '#b3a894', // the thinnest wet paper
  washColorBody: '#8c7f6c',
  washColorDeep: '#6b6052',
  washColorPool: '#4e463c', // standing water over the drop
  washColorRing: '#3a3126', // the deposition line at the water's edge
  washColorWet: '#2f2a22', // what the still-wet film pulls toward
  washColorGloss: '#cdd6da', // the sheen on it

  /* ================================================================ */
  /* The bloom — InkDiffusion(BLOOM), the pigment                      */
  /* ================================================================ */
  /**
   * The ink. Four nuclei arriving in sequence, because a bead that hits water
   * does not stay one bead — it breaks, and each fragment opens on its own
   * clock. One nucleus gives a single symmetric flower and reads as a stamp.
   */
  bloomHeight: 0.023, // metres above the floor — over the wash
  bloomSpread: 2.15, // metres of front radius at t = 1 s
  bloomSpreadPower: 0.44, // slower than Fickian: pigment drags on the fibre
  bloomEdge: 0.07, // metres of interface — tight, because pigment has an edge
  bloomClipSoft: 0.95, // metres it fades out over as it meets `zoneRadius`
  bloomSources: 4, // live nuclei — the bead breaking up
  bloomSourceScatter: 0.28, // fraction of the radius the later nuclei scatter over
  bloomSourceDelay: 0.24, // seconds each later nucleus starts behind the first

  /* --- the instability. `bloomCoarse` first, always --- */
  bloomFinger: 0.62, // overall amplitude; 0 gives a disc
  bloomFingerMax: 0.82, // cap, as a fraction of the front radius
  bloomCoarse: 2.6, // metres — the coarsest lobe. The one knob that sets the morphology
  bloomOnset: 0.52, // front radii per wavelength before a mode is admitted
  bloomGrowth: 1.05, // e-folds per wavelength of front travel
  bloomGrowthMax: 1.65, // saturation — a finger stops growing at its own width

  /* --- the film --- */
  bloomCore: 0.5, // density floor inside the blob
  bloomFalloff: 3.6, // metres of e-folding out from a nucleus
  bloomFilm: 0.58, // alpha floor inside the coverage
  bloomGranulation: 0.3, // pigment settling into the paper's tooth as it dries
  bloomGranScale: 1.9, // features per metre
  bloomRing: 0.5, // the deposition line at the pigment's own interface
  bloomRingWidth: 0.1, // metres
  bloomDryTime: 2.1, // seconds for the gloss to fall to 1/e
  bloomWetDarken: 0.42, // how far the wet film pulls toward `bloomColorWet`
  bloomGloss: 0.24, // specular on the wet leading edge — under the ceiling
  bloomGlossPower: 46, // its tightness
  bloomMeniscus: 0.6, // how far the film's normal tips at the interface
  bloomOpacity: 1.0,
  bloomCeiling: 0.58, // max linear luminance; below the wash's, ink is the darker thing
  bloomSoftFade: 0.25, // metres of depth feather
  bloomTint: 0.04, // where in the gradient a zero-density film sits
  bloomTintDensity: 1.1, // over 1, so a thick film reaches `bloomColorPool`
  bloomColorThin: '#8d7f9e', // the thinnest pigment — indigo runs violet when dilute
  bloomColorBody: '#42406a',
  bloomColorDeep: '#1d1e33',
  bloomColorPool: '#07070d', // where the drop went in
  bloomColorRing: '#2a2440', // the deposition line at the pigment front
  bloomColorWet: '#0b0b16', // what the still-wet ink pulls toward
  bloomColorGloss: '#c6ccd6', // the sheen on the leading edge

  /* ================================================================ */
  /* Particles                                                         */
  /* ================================================================ */
  /**
   * Two systems, both **non-additive**. Every other school in the sandbox
   * lights its particles; ink is pigment suspended in water and pigment does
   * not emit. Each carries its own four-stop lifetime gradient rather than a
   * tint borrowed off the field palette, so the grains can be made to settle
   * toward the paper colour while the mark itself stays indigo.
   */

  /* --- pigment grains riding the fingering front --- */
  grainRate: 105, // particles/second while the front is opening
  grainSize: 0.055,
  grainSpeed: 0.55, // metres/second outward off the front
  grainLifetime: 1.9,
  grainSink: -0.16, // metres/second — grains settle, they do not rise
  grainTurbulence: 0.85, // the curl field is what makes them wander like sediment
  grainBand: 0.22, // fraction of the front radius the emission annulus is thick
  colorGrainA: '#6f6486',
  colorGrainB: '#3b3960',
  colorGrainC: '#1b1c2f',
  colorGrainD: '#0a0a10',

  /* --- the slow tendril of colour lifting off the drop --- */
  veilRate: 26,
  veilSize: 0.75,
  veilSpeed: 0.35, // metres/second
  veilLifetime: 3.1,
  veilOpacity: 0.09, // it occludes; more than a tenth and it is fog, not ink
  veilRise: 0.28, // metres/second
  colorVeilA: '#4a4763',
  colorVeilB: '#33324a',
  colorVeilC: '#232232',
  colorVeilD: '#15151f',

  /* ================================================================ */
  /* Feedback                                                          */
  /* ================================================================ */
  // No flash and no burst: both are emissive and this school does not emit.
  // What is left is the weight of the bead going in.
  dropShake: 0.16, // camera kick as the bead breaks the surface
  shakeDuration: 0.45, // seconds it decays over
  rumble: 0.006, // continuous shake while the bloom opens — nearly nothing

  /* --- dynamic light ---
   * Deliberately dim. The pool is wet and a wet floor picks up a little light;
   * that is the whole brief. Above about 12 the bloom starts to look lit from
   * within, which is the failure mode of the school.
   */
  lightIntensity: 4.5,
  lightRadius: 9.0,
  lightColor: '#8d9aa6', // cold, like light off water
  lightPulse: 0.2, // depth of its slow swell, 0 = steady
  lightPulseSpeed: 1.6 // swells/second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Ink Bloom.
 *
 * **The instability** is the folder to open first, and `bloomCoarse` against
 * `zoneRadius` is the single most instructive pair in the block — it is the
 * only control that changes what the pattern *is* rather than how much of it
 * you get. Everything in it redraws a bloom that is already lying on the floor.
 *
 * The second thing worth doing is dragging `washSpread` down through
 * `bloomSpread` with the clock stopped, and watching the mark stop being ink in
 * water the moment the solvent stops leading.
 */
export const inkbloomSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 10, 400, 1, 'bead speed'],
    ['zoneRadius', 1, 14, 0.05, 'pool radius'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['pigmentDelay', 0, 2, 0.005, 'pigment lag (s)'],
    ['holdTime', 0.3, 12, 0.05, 'open time (s)'],
    ['fadeTime', 0.1, 8, 0.05, 'soak-away time (s)']
  ],
  'The bead': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['dropLift', 0, 1.5, 0.01, 'height at the pool'],
    ['dropRate', 0.05, 8, 0.05, 'grains / metre']
  ],
  'The instability': [
    ['bloomCoarse', 0.2, 8, 0.02, 'coarsest lobe (m)'],
    ['bloomFinger', 0, 2, 0.01, 'finger amplitude'],
    ['bloomFingerMax', 0.05, 2, 0.01, 'finger cap (× front)'],
    ['bloomOnset', 0.05, 2, 0.01, 'admission (radii / λ)'],
    ['bloomGrowth', 0, 4, 0.01, 'growth (e-folds / λ)'],
    ['bloomGrowthMax', 0.1, 6, 0.01, 'growth saturation']
  ],
  'The bloom': [
    ['bloomHeight', 0.002, 0.2, 0.001, 'quad height (m)'],
    ['bloomSpread', 0.1, 12, 0.01, 'front at 1 s (m)'],
    ['bloomSpreadPower', 0.1, 1.5, 0.005, 'front exponent'],
    ['bloomEdge', 0.005, 1, 0.005, 'interface width (m)'],
    ['bloomClipSoft', 0.05, 4, 0.01, 'zone feather (m)'],
    ['bloomSources', 1, 4, 1, 'nuclei'],
    ['bloomSourceScatter', 0, 1, 0.005, 'nucleus scatter'],
    ['bloomSourceDelay', 0, 1.5, 0.005, 'nucleus stagger (s)'],
    ['bloomCore', 0, 1, 0.005, 'density floor'],
    ['bloomFalloff', 0.2, 20, 0.05, 'density e-fold (m)'],
    ['bloomFilm', 0, 1, 0.005, 'alpha floor'],
    ['bloomGranulation', 0, 1, 0.005, 'granulation'],
    ['bloomGranScale', 0.1, 8, 0.02, 'grain / metre'],
    ['bloomRing', 0, 2, 0.01, 'deposition ring'],
    ['bloomRingWidth', 0.01, 1, 0.005, 'ring width (m)'],
    ['bloomOpacity', 0, 2, 0.01, 'ink opacity'],
    ['bloomCeiling', 0.05, 1, 0.005, 'luminance ceiling'],
    ['bloomSoftFade', 0.01, 3, 0.01, 'soft intersection (m)'],
    ['bloomTint', 0, 1, 0.005, 'gradient floor'],
    ['bloomTintDensity', 0, 2, 0.01, 'gradient / density'],
    ['bloomColorThin', 'thinnest pigment'],
    ['bloomColorBody', 'body'],
    ['bloomColorDeep', 'deep'],
    ['bloomColorPool', 'the drop'],
    ['bloomColorRing', 'pigment ring'],
    ['bloomColorWet', 'wet ink'],
    ['bloomColorGloss', 'wet sheen']
  ],
  'Wet and dry': [
    ['bloomDryTime', 0.05, 12, 0.05, 'ink dry time (s)'],
    ['bloomWetDarken', 0, 1, 0.005, 'wet darkening'],
    ['bloomGloss', 0, 1.5, 0.005, 'ink gloss'],
    ['bloomGlossPower', 2, 160, 1, 'ink gloss tightness'],
    ['bloomMeniscus', 0, 2, 0.01, 'ink meniscus'],
    ['washDryTime', 0.05, 12, 0.05, 'water dry time (s)'],
    ['washWetDarken', 0, 1, 0.005, 'paper darkening'],
    ['washGloss', 0, 1.5, 0.005, 'water gloss'],
    ['washGlossPower', 2, 160, 1, 'water gloss tightness'],
    ['washMeniscus', 0, 2, 0.01, 'water meniscus']
  ],
  'The wash': [
    ['washHeight', 0.002, 0.2, 0.001, 'quad height (m)'],
    ['washSpread', 0.1, 12, 0.01, 'front at 1 s (m)'],
    ['washSpreadPower', 0.1, 1.5, 0.005, 'front exponent'],
    ['washEdge', 0.005, 1.5, 0.005, 'interface width (m)'],
    ['washClipSoft', 0.05, 4, 0.01, 'zone feather (m)'],
    ['washCore', 0, 1, 0.005, 'density floor'],
    ['washFalloff', 0.2, 20, 0.05, 'density e-fold (m)'],
    ['washFilm', 0, 1, 0.005, 'alpha floor'],
    ['washGranulation', 0, 1, 0.005, 'granulation'],
    ['washGranScale', 0.1, 8, 0.02, 'grain / metre'],
    ['washRing', 0, 2, 0.01, 'cauliflower ring'],
    ['washRingWidth', 0.01, 1, 0.005, 'ring width (m)'],
    ['washOpacity', 0, 2, 0.01, 'wash opacity'],
    ['washCeiling', 0.05, 1, 0.005, 'luminance ceiling'],
    ['washSoftFade', 0.01, 3, 0.01, 'soft intersection (m)'],
    ['washTint', 0, 1, 0.005, 'gradient floor'],
    ['washTintDensity', 0, 2, 0.01, 'gradient / density'],
    ['washColorThin', 'thinnest wet paper'],
    ['washColorBody', 'body'],
    ['washColorDeep', 'deep'],
    ['washColorPool', 'standing water'],
    ['washColorRing', 'cauliflower line'],
    ['washColorWet', 'wet paper'],
    ['washColorGloss', 'water sheen']
  ],
  'Grains & veil': [
    ['grainRate', 0, 600, 1, 'grain rate'],
    ['grainSize', 0.005, 0.4, 0.005, 'grain size'],
    ['grainSpeed', 0, 6, 0.05, 'grain speed'],
    ['grainLifetime', 0.1, 8, 0.05, 'grain lifetime'],
    ['grainSink', -3, 2, 0.01, 'grain sink'],
    ['grainTurbulence', 0, 3, 0.01, 'grain turbulence'],
    ['grainBand', 0.02, 1, 0.005, 'emission band'],
    ['veilRate', 0, 300, 1, 'veil rate'],
    ['veilSize', 0.05, 4, 0.01, 'veil size'],
    ['veilSpeed', 0, 6, 0.05, 'veil speed'],
    ['veilLifetime', 0.2, 10, 0.05, 'veil lifetime'],
    ['veilOpacity', 0, 0.6, 0.002, 'veil opacity'],
    ['veilRise', -2, 4, 0.01, 'veil rise'],
    ['colorGrain*', 'Grain colour'],
    ['colorVeil*', 'Veil colour']
  ],
  'Feedback & light': [
    ['dropShake', 0, 2, 0.005, 'drop shake'],
    ['shakeDuration', 0.05, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.2, 0.001, 'bloom rumble'],
    ['lightIntensity', 0, 40, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'light swell'],
    ['lightPulseSpeed', 0.1, 12, 0.1, 'swell rate'],
    ['lightColor', 'light colour']
  ]
};
