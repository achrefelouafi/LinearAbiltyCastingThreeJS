import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* NIGHTFALL — the dome that takes light away                          */
/* ================================================================== */
/**
 * A far cast whose entire job is **subtraction**. A dome of `Medium.VOID`
 * closes over the footprint, the floor under it goes to near-black, and the
 * only things left inside are a slow starfield and the caster's own dynamic
 * light losing an argument with it.
 *
 * ### Why it genuinely darkens, and what had to be true for that
 *
 * `VolumeHull` draws non-additive media with premultiplied "over"
 * (`ONE, ONE_MINUS_SRC_ALPHA`), and premultiplied over with a near-black
 * premultiplied colour **is** subtraction: the destination is multiplied by
 * `1 - alpha` and almost nothing is added back. That is why the palette below
 * runs `#0a0a18 → #000000` and why `nightScatter` is kept far under
 * `nightAbsorption` — a medium whose scatter approaches its absorption gives
 * light *back*, and the one thing this ability may not do is give light back.
 *
 * Three separate things had to be checked before it survived the frame:
 *
 *  1. **Tone mapping.** The dome draws into the linear HDR buffer, and ACES
 *     runs later, in `OutputPass`. ACES is monotonic, so multiplying the input
 *     down always maps down — but it is *compressive at the top*, so taking a
 *     bloomed highlight to a fifth of itself is worth far less than a fifth on
 *     screen. The answer is not more opacity, it is `nightVoidBite`, which
 *     lifts the final alpha independently of the density so the dome can reach
 *     genuine black without being made physically thick (thick kills the
 *     transmittance in the first half-metre and the starfield behind it never
 *     integrates).
 *  2. **Bloom.** `UnrealBloomPass` runs *before* tone mapping and *after* the
 *     dome, so it re-adds energy over the darkened region from anything bright
 *     just outside it. Nothing in this block can stop that; what it can do is
 *     not make the problem — hence no burst shell, no additive decal and no
 *     screen flash that adds. `castDim` is the opposite: `GradeShader` mixes
 *     the frame *toward* the flash colour, so a black flash colour darkens.
 *  3. **Draw order.** Additive VFX drawn after the dome are not darkened by it.
 *     The `night.veil` particles are therefore non-additive on purpose; they
 *     are the only particle system in the project whose job is to occlude.
 *
 * ### The lid, and the uniform that is really an aperture
 *
 * The beat is "closes over the zone from the rim inward", and `HullShape.DOME`
 * has no aperture parameter — `Hollow` and `Throat` are cone-only. Rather than
 * pay a second raymarch for a second hull, the lid is `heightBias` driven past
 * its nominal 0..1: the silhouette term is `(1 - r) · (1 - bias·yn)`, which
 * goes **negative** above `yn = 1/bias`, and negative silhouette is zero
 * density. So the medium fills only the part of the dome below that latitude,
 * and the circle where it meets the dome's surface has radius
 * `R·sqrt(1 - (1/bias)²)`. Walking that circle from the boundary to the apex
 * closes the hole from the rim inward, in one uniform, for nothing. The beat
 * authors the *circle* (`lidOpenRim`) and the ability inverts for the uniform,
 * because the relation is violently non-linear near `bias = 1` — see
 * `NightfallAbility#_lidBias`.
 *
 * It is soft, too, and that is free: erosion scales with `clamp(1 - shape, 0, 2)`
 * so it is at its most violent exactly where the silhouette crosses zero, which
 * is the lip of the aperture. The lid closes with a ragged edge without a line
 * of code asking for one.
 */
export const nightfall = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  speed: 38.0, // how fast the front runs out to the footprint, metres/second
  zoneRadius: 6.5, // the footprint the circle indicator draws, metres
  cooldown: 2.2, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the four beats --- */
  // impactDuration = (closeTime + holdTime) × global.lifetime.
  // fadeDuration   = openTime + settleTime.
  formTime: 0.16, // seconds the medium takes to reach full density at all
  closeTime: 0.9, // seconds the lid takes to seal, rim → apex
  holdTime: 2.4, // seconds it stands sealed
  openTime: 1.1, // seconds the lid takes to reopen, apex → rim
  settleTime: 0.8, // seconds the last of the medium takes to thin out

  /* --- the dome --- */
  domeSpread: 1.04, // hull radius, × zoneRadius
  domeHeight: 0.62, // hull height, × zoneRadius
  // The lid is authored as the **rim of the hole**, not as the uniform that
  // makes it. `heightBias` and the aperture radius are related by
  // `rho = sqrt(1 - 1/bias²)`, which is violently non-linear near bias = 1:
  // driving the uniform from a linear beat leaves the rim loitering at 0.9 R
  // for two thirds of the close and then snapping shut. Authoring `rho` and
  // inverting for the uniform makes the closing circle travel evenly, which is
  // the only version that reads as a lid rather than as a glitch.
  lidOpenRim: 0.985, // aperture rim at full open, × the dome radius
  lidRimShare: 0.78, // share of the close spent walking that rim to the apex
  lidCurve: 1.15, // exponent on the walk; > 1 starts slow and finishes fast
  lidSeal: 0.05, // heightBias once sealed — below ~0.1 the apex is solid

  /* --- the void medium (Medium.VOID, prefix `night`) --- */
  // Steps × covered pixels is the cost, and a dome this wide covers a lot of
  // frame: 30 steps with zero shadow taps is the budget. VOID needs no taps —
  // there is nothing in it to light.
  ...volumeHullDefaults('night', Medium.VOID, {
    nightSteps: 30, // march steps — the cost knob
    nightJitter: 1.0, // step dither; 0 only ever shows you the banding
    nightContact: 1.4, // metres of fade where the dark meets the floor
    nightMargin: 0.14, // headroom inside the hull before erosion escapes it
    nightRound: 1.0, // a dome is round; Chebyshev would square its footprint
    nightHeightBias: 0.05, // the *base*; the lid is added on top (see the note)
    nightFeather: 0.25, // unused by DOME, kept so the audit stays quiet
    nightDensity: 2.1, // density
    nightDensityCurve: 0.7, // < 1 lifts the thin fringe — the dark has no edge
    nightSoftness: 0.6, // edge softness
    nightNoiseFrequency: 0.5, // features per metre — very large, very slow
    nightNoiseStrength: 0.55, // erosion, and the raggedness of the closing lip
    nightNoiseWarp: 0.3, // domain warp
    nightOctaves: 3, // octaves
    nightDetail: 0.4, // fine-octave gain
    nightFlowY: 0.05, // world flow Y, metres/second
    nightRise: 0.08, // buoyant rise, metres/second — night does not billow
    nightSwirl: 0.045, // swirl about the vertical, radians/second
    nightAbsorption: 1.9, // absorption, 1/metre. See VoidBite for the blacking.
    nightScatter: 0.18, // scattering — deliberately tiny: it must not give back
    nightAmbient: 0.04, // multi-scatter floor
    nightAnisotropy: 0.0, // no forward lobe; there is nothing to forward-scatter
    nightEmission: 1.0, // emission (the stars are carried on this)
    nightEmissionCurve: 0.35, // emission by density
    nightShadowTaps: 0, // nothing in here needs a lit side
    nightOpacity: 1.0, // opacity
    nightVoidBite: 1.35, // extra occlusion on the final alpha — the blacking-out
    nightSpeckDensity: 0.075, // fraction of lattice cells holding a star
    nightSpeckScale: 1.6, // star cells per metre
    nightSpeckSize: 0.12, // star size within its cell
    nightSpeckGlow: 16.0, // star brightness
    nightColorCore: '#0a0a18', // the interior
    nightColorMid: '#05050e',
    nightColorEdge: '#020205',
    nightColorDeep: '#000000', // the deepest part of it
    nightColorLight: '#1a1a30', // what little key light it admits
    nightColorSpeck: '#c0d0ff' // the stars
  }),

  /* --- the floor under it --- */
  // `GroundMode.WET` alpha-blended, which is the one mode in the library built
  // to come out *darker* than the stone it lies on. Its beats read backwards
  // from the usual: `grow` snaps the footprint out with the cast, the darkness
  // then **deepens in place** rather than spreading (the first build grew it
  // outward from the centre while the lid closed inward, and two fronts running
  // opposite ways read as two effects), and `recede` dries it back from the
  // edges as the lid reopens.
  floorSpread: 1.02, // mark radius, × zoneRadius
  floorGrow: 0.35, // seconds the footprint takes to snap out
  floorHeight: 0.018, // metres above the floor the quad sits at
  floorShallow: 0.25, // how dark the floor is the instant it lands, 0..1
  floorOpacity: 0.96, // ... and at full seal
  floorEmissive: 0.5, // multiplier on the sheen
  floorEdge: 0.55, // metres of feather on the front
  floorRagged: 0.22, // how far the front wanders, × radius
  floorRaggedScale: 0.45, // lobes per metre
  floorWarp: 0.7, // metres of domain warp on those lobes
  floorRelief: 0.35, // how hard the height field tilts the fake normal
  floorNormalStep: 0.07, // metres between the height taps
  floorAmbient: 0.06, // floor on the diffuse term — almost none, by design
  floorWrap: 0.3, // wraps the terminator round the back, 0..1
  floorSpecular: 0.42, // the only thing that says "stone", not "hole"
  floorGloss: 40, // Blinn exponent
  floorParallax: 0.2, // metres of view-driven offset on interior detail
  floorCell: 0.5, // puddle scale, metres
  floorDepth: 0.2, // puddle depth, metres
  floorLift: 0.06, // ripple height, metres
  floorDetail: 0.5, // ripple gain, 0..1
  floorSpeed: 0.35, // ripple rate
  floorFlow: 0.1, // drift, metres/second
  floorWind: 1.1, // drift bearing, radians in the quad's frame
  floorDepthFade: 0.6, // metres of soft fade against standing geometry
  colorFloor: '#05050b', // the soaked stone itself
  colorFloorEdge: '#3a4a86', // its sheen — the only light it returns
  colorFloorGlow: '#8fa0e0', // the tide mark left as it dries back
  colorFloorDeep: '#000000', // the wettest part of it

  /* --- the veil that eats the silhouette --- */
  // Non-additive: this is the only particle system in the project whose job is
  // to *occlude*. Additive smoke around a subtractive dome would light its own
  // outline, which is the exact opposite of the read.
  veilRate: 55, // particles/second
  veilSize: 1.6,
  veilSpeed: 0.5, // metres/second
  veilLifetime: 3.2, // seconds
  veilRise: 0.25, // upward drift, metres/second
  veilOpacity: 0.5,
  veilTurbulence: 0.35,
  veilSeat: 0.9, // where it boils off the dome, × zoneRadius
  colorVeilA: '#0b0b16', // birth
  colorVeilB: '#07070f', // early
  colorVeilC: '#040409', // late
  colorVeilD: '#000000', // death

  /* --- the stars that lift inside it --- */
  starRate: 26, // particles/second
  starSize: 0.05,
  starSpeed: 0.35, // metres/second
  starLifetime: 3.6, // seconds
  starRise: 0.32, // upward drift, metres/second
  starTurbulence: 0.18,
  starSeat: 0.72, // how far out they are born, × zoneRadius
  colorStarA: '#ffffff', // birth
  colorStarB: '#c0d0ff', // early
  colorStarC: '#5a6bb0', // late
  colorStarD: '#080a18', // death

  /* --- the moment it seals --- */
  // `castDim` runs through `ScreenFlash`, and `GradeShader` *mixes* the frame
  // toward the flash colour rather than adding it — so a black colour is a
  // negative flash. Nothing else in the project uses it that way.
  castDim: 0.34, // strength of the negative flash, 0..1
  colorFall: '#02020a', // what the frame is mixed toward
  sealShake: 0.35, // camera shake as the lid meets at the apex
  shakeDuration: 1.1, // seconds
  rumble: 0.02, // continuous shake while the lid is closing
  holdRumble: 0.008, // ... and while it stands

  /* --- the caster's light, losing --- */
  // The one thing still lit inside. It is deliberately weak and it is
  // deliberately *smothered*: `lightSmother` scales the base intensity down as
  // the seal completes, so the light visibly gives ground rather than shining
  // through a dome that is supposed to be swallowing it.
  lightIntensity: 15,
  lightRadius: 7.5,
  lightColor: '#9fb4ff',
  lightHeight: 1.1, // metres above the floor the light sits at
  lightSmother: 0.68, // 0..1 how much of it the sealed dome takes
  lightStruggle: 5.4 // radians/second of the flutter it fights with
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Nightfall.
 *
 * Reach for `lidOpenRim` / `lidRimShare` first: they are the aperture, and
 * dragging them with the clock paused walks the closing circle up and down the
 * dome by hand. After that, `nightVoidBite` (how black it is allowed to get,
 * which is *not* the same control as `nightDensity`) and `lightSmother` (how
 * badly the caster's own light loses).
 *
 * The hull's `boil` folder is omitted — those seven keys belong to `GAS_BOIL`
 * and do nothing to a VOID medium. `volumeHullDefaults` still emits them so the
 * hull's own audit stays quiet, so they land in "More", where they belong.
 */
export const nightfallSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'front speed'],
    ['zoneRadius', 1, 16, 0.1, 'footprint radius'],
    ['cooldown', 0, 10, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['formTime', 0.02, 2, 0.01, 'form time'],
    ['closeTime', 0.05, 4, 0.01, 'lid closes'],
    ['holdTime', 0.1, 10, 0.05, 'sealed hold'],
    ['openTime', 0.05, 4, 0.01, 'lid opens'],
    ['settleTime', 0.05, 4, 0.01, 'settle out']
  ],
  'The dome': [
    ['domeSpread', 0.3, 2, 0.01, 'radius × zoneRadius'],
    ['domeHeight', 0.1, 2, 0.01, 'height × zoneRadius'],
    ['lidOpenRim', 0.2, 0.999, 0.001, 'aperture rim, open'],
    ['lidRimShare', 0.05, 0.99, 0.01, 'share spent walking it in'],
    ['lidCurve', 0.3, 4, 0.01, 'walk curve'],
    ['lidSeal', 0, 1.5, 0.01, 'bias once sealed']
  ],
  ...volumeHullSchema('night', {
    label: 'Night',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'speck', 'void', 'colour']
  }),
  'The floor': [
    ['floorSpread', 0.2, 2, 0.01, 'radius × zoneRadius'],
    ['floorGrow', 0.02, 3, 0.01, 'footprint snap (s)'],
    ['floorHeight', 0, 0.3, 0.002, 'height above floor (m)'],
    ['floorShallow', 0, 1, 0.01, 'darkness on arrival'],
    ['floorOpacity', 0, 1, 0.01, 'darkness at full seal'],
    ['floorEmissive', 0, 3, 0.01, 'sheen'],
    ['floorEdge', 0.02, 3, 0.01, 'front feather (m)'],
    ['floorRagged', 0, 1, 0.01, 'front wander'],
    ['floorRaggedScale', 0.05, 3, 0.01, 'lobes / metre'],
    ['floorWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['floorDepthFade', 0, 3, 0.01, 'depth feather (m)'],
    ['colorFloor', 'soaked stone'],
    ['colorFloorEdge', 'sheen'],
    ['colorFloorGlow', 'tide mark'],
    ['colorFloorDeep', 'the deepest of it']
  ],
  'The floor/Relief': [
    ['floorRelief', 0, 3, 0.01, 'relief'],
    ['floorNormalStep', 0.01, 0.4, 0.005, 'normal step (m)'],
    ['floorAmbient', 0, 1, 0.01, 'ambient floor'],
    ['floorWrap', 0, 1, 0.01, 'terminator wrap'],
    ['floorSpecular', 0, 3, 0.01, 'specular'],
    ['floorGloss', 1, 128, 1, 'gloss'],
    ['floorParallax', 0, 2, 0.01, 'parallax (m)'],
    ['floorCell', 0.05, 4, 0.01, 'puddle scale (m)'],
    ['floorDepth', 0, 1.5, 0.01, 'puddle depth (m)'],
    ['floorLift', 0, 0.6, 0.005, 'ripple height (m)'],
    ['floorDetail', 0, 1, 0.01, 'ripple gain'],
    ['floorSpeed', 0, 4, 0.01, 'ripple rate'],
    ['floorFlow', 0, 2, 0.01, 'drift (m/s)'],
    ['floorWind', -3.15, 3.15, 0.01, 'drift bearing (rad)']
  ],
  'The veil': [
    ['veilRate', 0, 300, 1, 'veil rate'],
    ['veilSize', 0.1, 6, 0.05, 'veil size'],
    ['veilSpeed', 0, 6, 0.05, 'veil speed'],
    ['veilLifetime', 0.2, 10, 0.05, 'veil lifetime'],
    ['veilRise', -2, 4, 0.01, 'veil rise'],
    ['veilOpacity', 0, 1, 0.01, 'veil opacity'],
    ['veilTurbulence', 0, 3, 0.01, 'veil turbulence'],
    ['veilSeat', 0.1, 2, 0.01, 'seat × zoneRadius'],
    ['colorVeil*', 'Veil colour']
  ],
  'The stars inside': [
    ['starRate', 0, 200, 1, 'star rate'],
    ['starSize', 0.005, 0.4, 0.005, 'star size'],
    ['starSpeed', 0, 4, 0.01, 'star speed'],
    ['starLifetime', 0.2, 10, 0.05, 'star lifetime'],
    ['starRise', -2, 4, 0.01, 'star rise'],
    ['starTurbulence', 0, 3, 0.01, 'star turbulence'],
    ['starSeat', 0.05, 1.5, 0.01, 'seat × zoneRadius'],
    ['colorStar*', 'Star colour']
  ],
  'The moment it seals': [
    ['castDim', 0, 1, 0.01, 'negative flash'],
    ['colorFall', 'what the frame dims toward'],
    ['sealShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.3, 0.002, 'closing rumble'],
    ['holdRumble', 0, 0.3, 0.002, 'held rumble']
  ],
  'The caster’s light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 4, 0.01, 'light height (m)'],
    ['lightSmother', 0, 1, 0.01, 'how much the dome takes'],
    ['lightStruggle', 0, 20, 0.1, 'flutter (rad/s)'],
    ['lightColor', 'light colour']
  ]
};
