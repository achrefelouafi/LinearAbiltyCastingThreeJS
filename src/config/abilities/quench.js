import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* QUENCH — forge · far cast                                           */
/* ================================================================== */
/**
 * White-hot stock is plunged into the aimed circle. It sits there for a moment,
 * barely steaming, and then the vapour blanket collapses and the bath *erupts*
 * while the metal falls through yellow, orange, cherry and out the bottom into
 * black.
 *
 * ## THE TRICK — the cooling curve is physical, twice over
 *
 * **The colour** is not authored. `vfx/HardSurface.js` puts the Planckian locus
 * in the shader — Kim's cubic fit above 1667 K, a locus-fitted quadratic in
 * `1000/T` below it — and the emission is `(T/T_ref)ⁿ` with `n = 4` off
 * Stefan-Boltzmann. That is why there is no `colorHot` picker in this block and
 * why there must not be one. An authored white→orange gradient passes through a
 * yellow that is too saturated and slightly green, because the straight line in
 * RGB between white and orange is not the line the locus takes; steel at 1400 K
 * is pale straw, not lemon. And because the brightness is `T⁴` rather than a
 * fade curve, the metal **stops glowing on its own** — nothing tells it to, the
 * exponent does it, and at 620 K it is 0.06 of the reference and effectively
 * out.
 *
 * **The rate** is not authored either, or at least not as one curve. Real
 * quenching has three stages and they are wildly different speeds:
 *
 * | stage | what is happening | speed |
 * | --- | --- | --- |
 * | vapour blanket | the surface is above the Leidenfrost point and boils a film of steam that *insulates* it | slow (`filmTau`) |
 * | nucleate boiling | the film collapses; water touches metal and flashes | very fast (`boilTau`) |
 * | convection | below boiling, ordinary heat transfer into the water | slow (`convectTau`) |
 *
 * That is the whole shape of the ability. The steam is driven by the
 * **heat flow** `Σ mass · dT/dt`, not by an envelope, so it is quiet during the
 * blanket, enormous the moment the blanket goes, and gone before the metal is.
 * The loud part and the colour ramp are the same number seen from two sides,
 * which is why it convinces. At the shipped defaults the bath sits at about 0.3
 * of full steam for three-quarters of a second, pins at 0.9 at t ≈ 0.8 s when
 * the billets' film collapses, and is back under 0.1 by t ≈ 2.4 s — while the
 * metal goes 1750 → 1550 → 1200 → 930 K over the same window. Nobody authored
 * that timing; it is `filmTime`, `filmTau` and `boilTau` doing arithmetic.
 *
 * Each stage is a Newton exponential and the boundaries are solved in closed
 * form, so `T(t)` is a pure function of the elapsed time and these sliders.
 * Pause mid-quench and drag `boilTau`: the standing billet re-cools, the steam
 * re-thickens and the light re-tints, on a zero-length frame. An integrator
 * would have made every one of these dead.
 *
 * ## Mass matters, and that is the read
 *
 * A part's lumped time constant scales with its volume-to-area ratio, i.e. with
 * its characteristic length. `massRef` is the size at which the sliders above
 * mean what they say, and every part's τ is scaled by `(size/massRef)^massExponent`
 * — so the small off-cuts go black while the big billet is still cherry, off one
 * shared material and one shared curve. It is the single detail that stops the
 * scene reading as "some objects with an animated emissive".
 *
 * It has a second consequence nobody designed and everybody likes: the off-cuts
 * have short τs, so **their** vapour blankets collapse first, and the bath gets
 * a small early flurry of steam a third of a second before the main event. That
 * is the maths, not a beat — set `massExponent` to 0 and it goes away along with
 * everything else worth looking at.
 *
 * ## On the word "white"
 *
 * The top of this ramp is 1750 K, and a 1750 K blackbody is **orange** — its
 * blue channel is a thousandth of its red. The white in a foundry photograph is
 * the sensor clipping, and that is exactly how it is reproduced here: the
 * emission at entry is 3.8× the reference, which after `heatGlow` and the
 * material's Reinhard ceiling lands at roughly `(3.6, 1.6, 0)` and tone-maps to
 * a saturated yellow-white core with an orange skirt. Pushing `tempStart` up to
 * fake a bluer hue is the wrong lever: it makes the metal *hotter*, the T⁴ term
 * blows out, and it still is not white. Turn `heatGlow` instead.
 */
export const quench = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 30.0, // how fast the stock falls downrange to the bath, metres/second
  zoneRadius: 4.2, // the aimed circle — the bath, metres
  lifetime: 3.0, // seconds of quench you get to watch
  fadeTime: 2.2, // seconds the last steam takes to go
  cooldown: 1.4,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the work --- */
  plateCount: 3, // billets, 1..8
  boltCount: 9, // off-cuts, 0..16
  plateSize: 1.5, // the hero billet's largest extent, metres
  plateSizeJitter: 0.35, // 0..1 spread of that size across the billets
  boltSize: 0.42, // an off-cut's largest extent, metres
  boltSizeJitter: 0.45, // 0..1 spread
  scatter: 0.72, // how much of the circle the work is thrown across, 0..1
  entryHeight: 5.5, // metres above the bath the stock starts
  entryTilt: 0.5, // radians of random tumble on the way in
  restDepth: -0.06, // metres the work settles to; negative is under the surface
  plateLean: 0.22, // radians of random lie, so nothing is axis-aligned

  /* --- the billet's profile (unitless proportions; see `plateShape()`) --- */
  plateWidth: 1.0, // the two in-plane extents, relative to each other
  plateDepth: 0.42,
  plateThickness: 0.16, // unit lengths
  plateCorner: 0.14, // fraction of the short side, corner radius
  plateBevel: 0.035, // unit lengths, 45° break round the whole outline
  plateBolts: 4, // countersunk holes; 0, 2, 4 or 6
  plateBoltRadius: 0.06, // fraction of the short side
  plateBoltInset: 0.18, // fraction of the short side, in from each corner
  plateCounterSink: 0.032, // radial flare at the face
  plateCounterDepth: 0.04, // unit lengths, how deep the flare cuts
  plateCrease: 34.0, // degrees above which a joint shades hard

  /* --- the off-cut's profile (see `boltShape()`) --- */
  boltLength: 2.4, // × head width across flats — the dominant dimension
  boltHeadHeight: 0.6, // fractions of the head width throughout
  boltHeadChamfer: 0.1,
  boltWasher: 0.06,
  boltWasherRadius: 0.62,
  boltShankRadius: 0.3,
  boltThreadTurns: 8, // full turns over the threaded length
  boltThreadDepth: 0.04, // radial, fraction of the head width
  boltThreadFrom: 0.3, // 0..1 up the shank where the thread starts
  boltTipTaper: 0.12, // 0..1 of the shank spent tapering to the point
  boltCrease: 28.0, // degrees

  /* --- the cooling curve --- */
  // Kelvin, and they are real: 1650 K is white-yellow welding heat, 1450 K is
  // forging heat, 1150 K is cherry, 900 K is the first visible red in a dark
  // room, and below 750 K there is nothing to see at all.
  tempStart: 1750.0, // kelvin the stock enters at — bright orange-white
  tempBath: 335.0, // kelvin of the water; everything decays toward it
  filmTime: 0.8, // seconds the insulating vapour blanket holds
  filmTau: 7.0, // seconds — the slow time constant under the blanket
  boilTau: 1.2, // seconds — nucleate boiling, the violent stage
  boilEnd: 640.0, // kelvin at which boiling gives out and convection takes over
  convectTau: 5.2, // seconds — the slow tail
  massRef: 1.5, // metres of part size at which the four times above hold
  massExponent: 1.0, // τ ∝ (size/massRef)^this; 1 is the lumped-capacity value
  steamRef: 2200.0, // mass-weighted kelvin/second of heat flow at which the steam pins

  /* --- the steel --- */
  // `hardSurfaceParams()` by name. There is deliberately no hot-colour picker
  // — see the header.
  colorMetal: '#8f959c', // clean steel
  colorDeep: '#33383e', // the bottom of a pit
  colorScale: '#241f1b', // mill scale, thick on stock that has been in a fire
  colorPolish: '#e4ebf3', // a worn edge
  colorSpec: '#fff2e2', // the anisotropic highlight's own colour
  roughness: 0.42, // forged stock is not a mirror
  metalness: 0.92,
  envIntensity: 0.85,
  brush: 0, // BrushMode: 0 LINEAR, 1 CIRCUMFERENTIAL, 2 RADIAL — rolled stock
  anisotropy: 0.6,
  specular: 1.3,
  grain: 0.45,
  grainScale: 72.0,
  grainStretch: 18.0,
  scale: 0.46, // mill scale coverage — high; this came out of the fire
  scaleScale: 5.5,
  scaleSharp: 0.62,
  pit: 0.3,
  pitScale: 48.0,
  wear: 0.5,
  wearGrain: 0.45,
  heatCold: 300.0, // kelvin at heat = 0 — must bracket the curve below
  heatHot: 2000.0, // kelvin at heat = 1 — ditto, or the ramp clips
  heatRef: 1250.0, // kelvin at which the emission term reaches 1
  heatExponent: 4.0, // Stefan-Boltzmann; 4 is the physical value
  heatGlow: 3.2, // gain on the emission
  heatTint: 0.85, // how far the albedo washes toward the hot colour
  heatEdge: 0.26, // edges run cooler — thin sections radiate faster

  /* --- the steam volume (Medium.SMOKE, prefix `steam`) --- */
  // A dome is the wrong silhouette for a quench and a cylinder is the right
  // one: steam off a bath goes *up* in a column with a flat-ish top, it does
  // not arch over. The march cost is steps × (1 + shadow taps) × covered
  // pixels; two taps is worth it here because a steam column with no lit side
  // reads as fog.
  ...volumeHullDefaults('steam', Medium.SMOKE, {
    steamSteps: 30, // march steps — the cost knob
    steamJitter: 1.0, // step dither; 0 only ever shows you the banding
    steamContact: 0.5, // metres of fade where the steam meets the water
    steamMargin: 0.2, // headroom inside the hull for the erosion
    steamHeightBias: -0.55, // NEGATIVE: steam thickens as it climbs, unlike smoke
    steamFeather: 0.42, // far-edge feather
    steamDensity: 1.5,
    steamDensityCurve: 0.85,
    steamSoftness: 0.6, // steam has no hard edge anywhere
    steamNoiseFrequency: 0.85, // features per metre
    steamNoiseStrength: 0.8, // erosion
    steamNoiseWarp: 0.4, // domain warp — the roll of a boiling column
    steamOctaves: 4,
    steamDetail: 0.6,
    steamFlowY: 0.0,
    steamRise: 2.4, // buoyant rise, metres/second — steam is fast
    steamSwirl: 0.35, // swirl about the vertical, radians/second
    steamAbsorption: 1.5, // 1/metre — steam is thin, it is not soot
    steamScatter: 3.4, // scattering — and very bright
    steamAmbient: 0.55, // multi-scatter floor, high: water vapour is white
    steamEmission: 0.0, // steam does not emit; the metal below lights it
    steamShadowTaps: 2, // self-shadow taps
    steamShadowLength: 1.1, // self-shadow reach, metres
    steamColorCore: '#ffffff',
    steamColorMid: '#e8eef3',
    steamColorEdge: '#c6d2dc',
    steamColorDeep: '#8e9aa4',
    steamColorLight: '#ffd8a8' // the firelight the hot stock throws up into it
  }),
  steamWidth: 1.15, // the column's half-width, × zoneRadius
  steamHeight: 2.6, // its height, metres per unit of zoneRadius
  steamLift: 0.02, // metres above the floor the column starts
  steamFade: 1.0, // master gain on the volume's opacity
  steamCurve: 0.65, // exponent on the boil rate before it drives the volume

  /* --- the bath (GroundField, POOL) --- */
  fieldEdge: 0.55, // metres of feather on the rim
  fieldRagged: 0.14, // how far the rim wanders, fraction of the radius
  fieldRaggedScale: 0.6, // lobes per metre
  fieldWarp: 0.35, // metres of domain warp on those lobes
  fieldRelief: 0.55, // how hard the height field tilts the fake normal
  fieldCell: 0.9, // metres — the surface's feature size
  fieldThickness: 0.06, // metres — the meniscus rim
  fieldDepth: 0.4, // metres of apparent depth
  fieldSharp: 0.3, // 0..1 — water is soft
  fieldDetail: 0.7, // fine chop
  fieldFlow: 0.28, // metres/second the surface drifts
  fieldSpeed: 0.9, // surface events per second
  fieldWindAngle: 0.4, // radians, in the quad's frame
  fieldParallax: 0.4, // metres of view-driven offset into the water
  fieldSpecular: 0.9,
  fieldGloss: 60.0, // Blinn exponent — water is glossy
  fieldOpacity: 0.9,
  fieldEmissive: 1.0,
  colorFieldBase: '#2c3a42', // the water
  colorFieldEdge: '#9fc0cc', // the meniscus and the chop highlights
  colorFieldGlow: '#ff7a28', // what the hot stock throws back up through it
  colorFieldDeep: '#0c1216', // the bottom of the tank

  /* --- steam, sparks and spatter --- */
  /**
   * Four-stop lifetime gradients, `A` at birth through `D` as the particle
   * dies. The sparks are the exception that proves I5's rule: they are tinted
   * *per emission* with `blackbodyColor(T)` of the metal that threw them, on
   * top of this gradient, because a flake of scale is the same temperature as
   * the billet and hard-coding an orange is how you end up with cherry-red
   * steel throwing lemon sparks.
   */
  steamRate: 190, // wisps/second at full boil
  steamSize: 1.15,
  steamSpeed: 2.3,
  steamLifetime: 2.4,
  steamOpacity: 0.3,
  steamRise: 1.9, // upward drift, metres/second
  steamTurbulence: 0.8,
  colorSteamA: '#ffffff',
  colorSteamB: '#eef3f7',
  colorSteamC: '#c4d0da',
  colorSteamD: '#8c98a2',
  sparkRate: 90, // scale flakes popping off, particles/second at full boil
  sparkSize: 0.1,
  sparkSpeed: 3.6,
  sparkLifetime: 0.65,
  sparkGravity: -11.0,
  sparkStretch: 0.16,
  colorSparkA: '#ffffff',
  colorSparkB: '#ffd07a',
  colorSparkC: '#ff7420',
  colorSparkD: '#4a1204',
  dropRate: 120, // water thrown off the boil, particles/second
  dropSize: 0.06,
  dropSpeed: 4.2,
  dropLifetime: 0.9,
  dropGravity: -16.0,
  colorDropA: '#dff0f7',
  colorDropB: '#a9c8d6',
  colorDropC: '#6f8f9e',
  colorDropD: '#3a4c56',

  /* --- the plunge --- */
  splashDrops: 260, // one-shot water thrown at the moment of entry
  splashSteam: 70, // ... and the first flash of steam
  plungeShake: 0.6,
  shakeDuration: 0.7,
  plungeFlash: 0.1, // full-screen flash on entry
  colorFlash: '#ffd9b0',
  burstSize: 2.4, // the splash dome, metres
  burstIntensity: 1.0,
  colorBurstA: '#20323c',
  colorBurstB: '#9fc0cc',
  colorBurstC: '#ffffff',

  /* --- dynamic light --- */
  // The intensity follows the same `T⁴` the metal's emission does, so the light
  // goes out with the steel rather than on a fade curve of its own.
  lightIntensity: 18.0,
  lightRadius: 15.0,
  lightColor: '#ff8c3a', // the authored tint...
  lightBlackbody: 0.85, // ...and how far it is dragged onto the real locus
  lightCeiling: 2.4 // clamp on the T⁴ term, or entry heat blows the exposure
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Quench.
 *
 * Open **The cooling curve** first and drag `filmTime` with the clock stopped.
 * Everything the ability is doing is downstream of that one number: push it to
 * two seconds and the billet hangs there glowing while nothing happens, then
 * detonates; take it to zero and the whole quench is one violent second. The
 * steam, the light, the albedo and the emission all answer, because they are
 * all the same `T(t)` read at different points.
 *
 * `massExponent` is the second thing to reach for. At 0 every part cools
 * together and the scene flattens into one animated colour; at 1 the bolts are
 * black before the plate is orange and you can read the sizes off the heat.
 *
 * The nine `steamBoil*` and one `steamVoid*` keys are not filed below on
 * purpose: `volumeHullDefaults` emits the whole vocabulary so the hull's own
 * audit stays quiet, but they belong to other media and do nothing to SMOKE.
 * They are reachable in the trailing "More" folder if anybody needs them.
 */
export const quenchSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 160, 1, 'entry speed'],
    ['zoneRadius', 1.5, 12, 0.1, 'bath radius'],
    ['lifetime', 0.5, 12, 0.05, 'quench time'],
    ['fadeTime', 0.2, 8, 0.05, 'steam clear'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The cooling curve': [
    ['tempStart', 700, 2400, 5, 'entry temp (K)'],
    ['tempBath', 280, 373, 1, 'bath temp (K)'],
    ['filmTime', 0, 3, 0.01, 'vapour blanket (s)'],
    ['filmTau', 0.2, 20, 0.05, 'blanket τ (s)'],
    ['boilTau', 0.05, 6, 0.01, 'nucleate boil τ (s)'],
    ['boilEnd', 380, 1200, 5, 'boiling gives out (K)'],
    ['convectTau', 0.2, 20, 0.05, 'convection τ (s)'],
    ['massRef', 0.1, 5, 0.01, 'reference size (m)'],
    ['massExponent', 0, 2, 0.01, 'τ ∝ size^n'],
    ['steamRef', 100, 12000, 10, 'heat flow at full steam']
  ],
  'The work': [
    ['plateCount', 0, 8, 1, 'billets'],
    ['boltCount', 0, 16, 1, 'off-cuts'],
    ['plateSize', 0.2, 4, 0.01, 'billet size (m)'],
    ['plateSizeJitter', 0, 1, 0.01, 'billet size spread'],
    ['boltSize', 0.05, 1.5, 0.01, 'off-cut size (m)'],
    ['boltSizeJitter', 0, 1, 0.01, 'off-cut size spread'],
    ['scatter', 0, 1, 0.01, 'scatter ÷radius'],
    ['entryHeight', 0, 16, 0.1, 'entry height (m)'],
    ['entryTilt', 0, 3, 0.01, 'entry tumble (rad)'],
    ['restDepth', -1, 1, 0.005, 'resting depth (m)'],
    ['plateLean', 0, 1.5, 0.01, 'resting lean (rad)']
  ],
  'The billet profile': [
    ['plateWidth', 0.2, 2, 0.01, 'width'],
    ['plateDepth', 0.1, 2, 0.01, 'depth'],
    ['plateThickness', 0.02, 0.8, 0.005, 'thickness'],
    ['plateCorner', 0, 0.5, 0.005, 'corner radius'],
    ['plateBevel', 0, 0.15, 0.001, 'bevel'],
    ['plateBolts', 0, 6, 1, 'holes'],
    ['plateBoltRadius', 0.01, 0.2, 0.002, 'hole radius'],
    ['plateBoltInset', 0.05, 0.45, 0.005, 'hole inset'],
    ['plateCounterSink', 0, 0.12, 0.002, 'countersink flare'],
    ['plateCounterDepth', 0, 0.12, 0.002, 'countersink depth'],
    ['plateCrease', 5, 80, 1, 'crease angle (°)']
  ],
  'The off-cut profile': [
    ['boltLength', 0.6, 5, 0.01, 'length ×head'],
    ['boltHeadHeight', 0.2, 1.4, 0.01, 'head height'],
    ['boltHeadChamfer', 0, 0.3, 0.005, 'head chamfer'],
    ['boltWasher', 0, 0.3, 0.005, 'flange'],
    ['boltWasherRadius', 0.3, 1, 0.005, 'flange radius'],
    ['boltShankRadius', 0.08, 0.5, 0.005, 'shank radius'],
    ['boltThreadTurns', 0, 24, 1, 'thread turns'],
    ['boltThreadDepth', 0, 0.12, 0.002, 'thread depth'],
    ['boltThreadFrom', 0, 0.9, 0.01, 'thread start'],
    ['boltTipTaper', 0, 0.5, 0.005, 'tip taper'],
    ['boltCrease', 5, 80, 1, 'crease angle (°)']
  ],
  'The steel': [
    ['colorMetal', 'steel'],
    ['colorDeep', 'pit bottom'],
    ['colorScale', 'mill scale'],
    ['colorPolish', 'worn edge'],
    ['colorSpec', 'highlight'],
    ['roughness', 0.02, 1, 0.005, 'roughness'],
    ['metalness', 0, 1, 0.005, 'metalness'],
    ['envIntensity', 0, 3, 0.01, 'probe gain'],
    ['brush', 0, 2, 1, 'brush mode'],
    ['anisotropy', 0, 1, 0.01, 'anisotropy'],
    ['specular', 0, 6, 0.01, 'specular gain'],
    ['grain', 0, 2, 0.01, 'grain depth'],
    ['grainScale', 4, 300, 1, 'grain frequency'],
    ['grainStretch', 1, 120, 1, 'grain stretch'],
    ['scale', 0, 1, 0.01, 'mill scale'],
    ['scaleScale', 0.5, 30, 0.1, 'scale patch size'],
    ['scaleSharp', 0, 1, 0.01, 'scale edge'],
    ['pit', 0, 1, 0.01, 'pitting'],
    ['pitScale', 4, 200, 1, 'pit frequency'],
    ['wear', 0, 1, 0.01, 'edge wear'],
    ['wearGrain', 0, 1, 0.01, 'wear breakup']
  ],
  'The blackbody ramp': [
    ['heatCold', 200, 900, 5, 'cold (K)'],
    ['heatHot', 900, 2400, 5, 'hot (K)'],
    ['heatRef', 400, 2400, 5, 'emission ref (K)'],
    ['heatExponent', 1, 8, 0.1, 'emission exponent'],
    ['heatGlow', 0, 8, 0.01, 'emission gain'],
    ['heatTint', 0, 1, 0.01, 'albedo wash'],
    ['heatEdge', 0, 1, 0.01, 'edge cooling']
  ],
  'The steam column': [
    ['steamWidth', 0.2, 3, 0.01, 'half-width ×radius'],
    ['steamHeight', 0.2, 8, 0.01, 'height ×radius'],
    ['steamLift', -0.5, 2, 0.01, 'base height (m)'],
    ['steamFade', 0, 2, 0.01, 'volume gain'],
    ['steamCurve', 0.1, 3, 0.01, 'boil → volume curve']
  ],
  ...volumeHullSchema('steam', {
    label: 'Steam',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'colour']
  }),
  'The bath': [
    ['fieldEdge', 0.02, 3, 0.01, 'rim feather (m)'],
    ['fieldRagged', 0, 1, 0.01, 'rim wander'],
    ['fieldRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['fieldWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['fieldRelief', 0, 2, 0.01, 'relief'],
    ['fieldCell', 0.1, 4, 0.01, 'feature size (m)'],
    ['fieldThickness', 0.005, 0.4, 0.005, 'meniscus (m)'],
    ['fieldDepth', 0, 2, 0.01, 'apparent depth (m)'],
    ['fieldSharp', 0, 1, 0.01, 'edge hardness'],
    ['fieldDetail', 0, 1, 0.01, 'chop'],
    ['fieldFlow', 0, 3, 0.01, 'drift (m/s)'],
    ['fieldSpeed', 0, 6, 0.01, 'events / second'],
    ['fieldWindAngle', -3.2, 3.2, 0.01, 'drift angle (rad)'],
    ['fieldParallax', 0, 1.5, 0.01, 'parallax (m)'],
    ['fieldSpecular', 0, 3, 0.01, 'specular'],
    ['fieldGloss', 1, 200, 1, 'gloss'],
    ['fieldOpacity', 0, 1.5, 0.01, 'opacity'],
    ['fieldEmissive', 0, 4, 0.01, 'emissive'],
    ['colorFieldBase', 'water'],
    ['colorFieldEdge', 'meniscus'],
    ['colorFieldGlow', 'firelight in the water'],
    ['colorFieldDeep', 'tank bottom']
  ],
  'Steam, sparks & spatter': [
    ['steamRate', 0, 800, 1, 'steam rate'],
    ['steamSize', 0.05, 5, 0.01, 'steam size'],
    ['steamSpeed', 0, 10, 0.05, 'steam speed'],
    ['steamLifetime', 0.2, 8, 0.05, 'steam lifetime'],
    ['steamOpacity', 0, 1, 0.005, 'steam opacity'],
    ['steamRise', -2, 6, 0.01, 'steam rise'],
    ['steamTurbulence', 0, 3, 0.01, 'steam turbulence'],
    ['sparkRate', 0, 600, 1, 'spark rate'],
    ['sparkSize', 0.005, 0.6, 0.005, 'spark size'],
    ['sparkSpeed', 0, 20, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 3, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['dropRate', 0, 600, 1, 'spatter rate'],
    ['dropSize', 0.005, 0.4, 0.005, 'spatter size'],
    ['dropSpeed', 0, 20, 0.1, 'spatter speed'],
    ['dropLifetime', 0.1, 4, 0.05, 'spatter lifetime'],
    ['dropGravity', -50, 0, 0.1, 'spatter gravity'],
    ['colorSteam*', 'Steam colour'],
    ['colorSpark*', 'Spark colour'],
    ['colorDrop*', 'Spatter colour']
  ],
  'The plunge': [
    ['splashDrops', 0, 900, 1, 'splash droplets'],
    ['splashSteam', 0, 400, 1, 'splash steam'],
    ['plungeShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['plungeFlash', 0, 2, 0.01, 'screen flash'],
    ['burstSize', 0.1, 10, 0.05, 'splash dome (m)'],
    ['burstIntensity', 0, 5, 0.01, 'dome intensity'],
    ['colorFlash', 'flash colour'],
    ['colorBurstA', 'dome shell'],
    ['colorBurstB', 'dome body'],
    ['colorBurstC', 'dome crest']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightBlackbody', 0, 1, 0.01, 'onto the locus'],
    ['lightCeiling', 0.1, 8, 0.01, 'T⁴ ceiling'],
    ['lightColor', 'light tint']
  ]
};
