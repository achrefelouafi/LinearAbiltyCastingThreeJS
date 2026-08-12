import { ShellMode, shellDefaults, shellSchema } from '../../vfx/Shell.js';

/* ================================================================== */
/* SUNSPEAR — flame, line cast                                         */
/* ================================================================== */
/**
 * A white-fire javelin on a ballistic arc, and the hole it leaves in the air.
 *
 * This is one of the two slots that exist to prove the distortion pass works,
 * and it is the loud one: the spear's wake is written straight into the
 * refraction buffer, so the floor grid, the character and every particle behind
 * it genuinely bend as it goes past. Nothing about that is a post effect bolted
 * on afterwards — it is one quad on `LAYER.DISTORTION` riding the spear, and
 * `wakeStrength` is a slider you can push until the room folds.
 *
 * On landing the same emitter stops travelling and settles over a **sun disc**
 * lying flat on the floor, with corona filaments licking off its rim. The spear
 * itself is deliberately simple geometry: a faceted spindle, extremely bright.
 * All the drama is in the wake and the disc, and a spear with more detail on it
 * than that just competes with them.
 *
 * ## Two things about the numbers below
 *
 * **`spearFlight` is 1, and that is not a second.** The javelin's τ is driven
 * off the ability's own front, so it lands on the exact frame the impact beat
 * fires however the ease-in curve behaves. That makes `wakeSpan` a *fraction of
 * the flight* rather than a duration — which is the more useful slider anyway —
 * and `wakeBurn`, in real seconds, is the one that says how long the wake takes
 * to catch its own head up after the spear is gone.
 *
 * **The disc's radius is not in this block twice.** `discRadius` → `discRadiusEnd`
 * is interpolated by `Shell` on its own easing exponent from the ability's
 * normalised life, and the corona filaments are placed against whatever radius
 * that resolves to *this frame* (`Shell#radius`). Drag `discRadiusEnd` with the
 * game paused and the corona moves out with the rim, because it never had its
 * own copy of the number.
 */
export const sunspear = {
  /* --- the cast --- */
  range: 30.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  speed: 34.0, // how fast the javelin covers the line, metres/second
  cooldown: 1.1, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws
  discHold: 0.9, // seconds the disc holds at full before the bloom-out
  discFade: 2.6, // seconds of slow bloom-out — the long tail this slot is for

  /* --- where the javelin leaves the caster --- */
  handForward: 0.7, // metres in front of the caster
  handSide: 0.3, // metres to the side (+ follows `Ability#side`)
  handHeight: 1.55, // metres above the floor — thrown from over the shoulder
  landHeight: 0.34, // metres the spear's centre lands at, so its point meets the floor

  /* --- the arc --- */
  spearFlight: 1.0, // nominal flight, in units of the ability's own front (see above)
  arcApex: 3.4, // metres the throw lofts at mid-span
  arcApexCurve: 1.1, // >1 flattens the top of the lob
  arcCurve: 1.0, // easing on launch → land; >1 accelerates into the ground

  /* --- the javelin --- */
  spearRadius: 0.17, // half-width at the butt, metres
  spearStretch: 5.2, // length along the heading, × the radius (half-length)
  // Not 1. At exactly 1 the alignment slerp overwrites the tumble outright and
  // `spearSpin` becomes a control that does nothing; a few per cent short of it
  // leaves a slow roll and a couple of degrees of lean, which is also what
  // stops the javelin reading as a prop on a rail.
  spearAlign: 0.96, // 1 lays the long axis exactly on the heading
  spearSpin: 2.4, // residual roll about that axis, radians/second
  spearFlash: 0.14, // seconds the birth pop decays over
  spearSides: 5, // facets around the spindle
  spearTaper: 0.06, // point radius as a fraction of the butt
  spearRough: 0.16, // how far the facets are pushed off a clean prism
  spearBend: 0.05, // sideways curve from butt to point

  /* --- the javelin's shading --- */
  spearCore: 0.34, // 0..1 of the half-width that runs pure white
  spearFalloff: 2.2, // how hard the fire falls off across the shaft
  spearHead: 0.62, // 0..1 along the shaft where the head heat starts
  spearHeadGain: 2.4, // how much hotter the point is than the butt
  spearFresnel: 1.5, // edge light on the silhouette
  spearFresnelPower: 2.0,
  spearNoise: 0.55, // how much the fire crawls over the shaft
  spearNoiseScale: 4.5, // features per unit length
  spearNoiseSpeed: 2.6, // Hz that crawl runs at
  spearGlow: 3.2, // emissive gain into bloom
  spearOpacity: 1.0,
  spearSoftFade: 0.4, // metres of depth feather where it meets geometry
  colorSpearCore: '#ffffff',
  colorSpearFire: '#ffe07a',
  colorSpearEdge: '#ff9a1f',

  /* --- the wake, in the refraction buffer --- */
  // Magnitudes are SCREEN FRACTIONS, not metres, and `post.distortion` ×
  // `global.distortion` is applied by the pass — never here, or it lands twice.
  wakeWidth: 3.6, // metres across
  wakeHeight: 3.0, // metres tall
  wakeStrength: 0.62, // screen widths at post.distortion = 1. Push it.
  wakeOpacity: 1.0, // coverage against other emitters
  wakeFrequency: 0.95, // shimmer cycles per metre
  wakeSpeed: 2.4, // metres/second the shimmer advects upward, in WORLD space
  wakeSourceBias: 1.5, // exponent pushing the amplitude toward the base
  wakeSpread: 0.85, // how much the column widens with height
  wakeVertical: 0.4, // how much of the offset runs vertically
  wakeFlicker: 0.35,
  wakeDepthReject: 1.0, // 0..1 — how hard fragments behind the floor are dropped
  wakeDepthFade: 0.45, // metres of feather on that rejection
  wakePerspective: 0.0, // 0 keeps the warp the same size at any distance
  wakePerspectiveRef: 14.0, // metres, the reference distance when it is not
  wakeFall: 0.55, // 0..1 the wake decays over the flight — it cools behind the spear

  /* --- the wake once the spear has landed --- */
  // The same single emitter, parked over the disc. A second one is a second
  // draw call, a second coverage term to argue with the first, and one more
  // thing to keep in step.
  discWakeWidth: 8.0, // metres across
  discWakeHeight: 2.4, // metres tall
  discWakeStrength: 0.45, // screen widths
  discWakeSettle: 0.22, // seconds the emitter takes to swap jobs

  /* --- the fire trail --- */
  wakeSpan: 0.34, // FRACTION of the flight the trail reaches back over
  wakeBurn: 0.55, // seconds the tail takes to catch the head after landing
  wakeTrailWidth: 0.4, // metres at the head
  wakeTrailTaper: 1.5, // >1 sharpens the tail to a point
  wakeTrailLift: 0.05, // metres the tail floats above the flown path
  wakeTrailOpacity: 0.95,
  wakeTrailGlow: 2.2,
  wakeTrailCore: 2.4, // how tightly light crowds the centre line
  wakeTrailHeadBias: 0.55, // >0 keeps the brightness near the spear
  wakeTrailNoise: 0.6,
  wakeTrailNoiseScale: 1.4, // features per metre
  wakeTrailNoiseSpeed: 1.6,
  wakeTrailSoftFade: 0.5, // metres of depth feather
  colorWakeA: '#ffffff',
  colorWakeB: '#ffe07a',
  colorWakeC: '#ff9a1f',
  colorWakeD: '#4a1602',

  /* --- the sun disc --- */
  // 44 keys, prefixed `disc`, spread out of `Shell`'s own contract. Every one
  // of them is a slider in "The sun disc" below.
  ...shellDefaults('disc', ShellMode.SUNDISC, {
    discRadius: 0.5,
    discRadiusEnd: 4.6,
    discExpand: 4.0,
    discHeight: 0.02,
    discLift: 0.035,
    discFill: 0.78,
    discRim: 0.5,
    discRimPower: 2.0,
    discDissolve: 0.45,
    discGlow: 3.0,
    discCoronaReach: 2.1,
    discCorona: 1.6,
    discCoronaLength: 0.62,
    discCoronaScale: 5.5,
    discCoronaWarp: 0.5,
    discCoronaSpeed: 0.85,
    discCoronaSharp: 0.7,
    discGranule: 0.55,
    discGranuleScale: 6.5,
    discRimWidth: 0.2,
    discSoftFade: 0.55,
    discColorBody: '#ff9a1f',
    discColorRim: '#ffe07a',
    discColorEdge: '#ffffff',
    discColorCorona: '#ffd27a'
  }),

  /* --- the corona filaments licking off the rim --- */
  // Two roles on one instanced strip: a crowd of short arcs travelling round
  // the boundary, and a handful of long slow licks going the other way.
  flareCount: 14, // short arcs
  flareRadius: 1.02, // × the disc's live radius
  flareSpan: 0.13, // turns one arc covers
  flareSpeed: 0.22, // turns per second they travel
  flareLift: 0.55, // metres one hops over the rim at mid-span
  flareJitter: 0.35, // 0..1 radial wobble
  flareHug: 0.08, // metres above the floor
  lickCount: 5, // long licks
  lickRadius: 1.04, // × the disc's live radius
  lickSpan: 0.34, // turns one covers
  lickSpeed: -0.09, // turns/second — negative, so the two sets counter-rotate
  lickLift: 1.5, // metres it reaches at mid-span
  lickJitter: 0.6,
  lickHug: 0.1, // metres above the floor
  lickPhase: 0.37, // turns of constant offset, so the sets do not stack

  /* --- how the filaments are drawn --- */
  flareWidth: 0.055, // half-width of a filament, metres
  flareGlowWidth: 6.5, // the halo, × that width
  flareGlowOpacity: 0.42,
  flareKink: 0.22, // metres of lateral kink at the coarsest octave
  flareKinkScale: 1.6, // kinks per metre
  flareOctaves: 3, // 1–5
  flareKinkFalloff: 0.55, // amplitude kept per octave
  flareCrawl: 1.8, // how fast the kinks slide along
  flarePinch: 0.2, // fraction of the path the ends are eased over
  flareRestrike: 9, // whole re-shapes per second
  flareFlicker: 0.18, // depth of the whole-corona stutter
  flareFlickerSpeed: 22,
  flareStrandFlash: 0.35, // depth of the per-filament blink
  flareCoreSharp: 3.4, // how hard the core falls off across the ribbon
  flareFalloff: 2.2, // the same for the halo
  flareSoftFade: 0.5, // metres of depth fade
  flareOpacity: 1.0,
  flareGlow: 2.6,
  colorFlareCore: '#ffffff',
  colorFlareInner: '#ffe07a',
  colorFlareOuter: '#ff9a1f',
  colorFlareHalo: '#6a2202',

  /* --- embers, smoke and motes --- */
  emberRate: 300, // shed off the shaft in flight, particles/second
  emberSize: 0.14,
  emberSpeed: 5.0,
  emberLifetime: 0.55,
  emberGravity: 3.0, // white fire rises
  emberStretch: 0.3,
  emberBurst: 220, // extra thrown at the landing
  colorEmberA: '#ffffff',
  colorEmberB: '#ffffff',
  colorEmberC: '#ffe07a',
  colorEmberD: '#ff6a1f',
  smokeRate: 40, // haze off the scorched disc
  smokeSize: 1.4,
  smokeSpeed: 1.3,
  smokeLifetime: 2.6,
  smokeOpacity: 0.09,
  smokeRise: 1.0,
  colorSmokeA: '#6b5238',
  colorSmokeB: '#54402c',
  colorSmokeC: '#3c2e20',
  colorSmokeD: '#221a12',
  moteRate: 70, // what drifts up out of the disc while it blooms out
  moteSize: 0.07,
  moteSpeed: 1.1,
  moteLifetime: 2.2,
  moteRise: 1.4,
  moteTurbulence: 0.55,
  colorMoteA: '#ffffff',
  colorMoteB: '#ffe07a',
  colorMoteC: '#ff9a1f',
  colorMoteD: '#3a1204',

  /* --- the landing --- */
  burstSize: 3.4, // the shell of white fire at the point of impact, metres
  burstIntensity: 1.7,
  impactFlash: 0.62, // the hard screen flash. This one is meant to hurt
  castFlash: 0.12, // a much smaller one as the javelin leaves the hand
  impactShake: 1.0,
  shakeDuration: 0.7,
  rumble: 0.02, // continuous shake while it flies
  colorBurstA: '#ff9a1f',
  colorBurstB: '#ffe07a',
  colorBurstC: '#ffffff',
  colorFlash: '#ffe07a',
  colorCastFlash: '#ffffff',

  /* --- dynamic light --- */
  lightIntensity: 34.0,
  lightRadius: 22.0,
  lightColor: '#ffc46a'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Sunspear.
 *
 * Start in **The wake**. `wakeStrength` is the whole reason this slot exists,
 * and it is worth dragging it to its maximum once with the game paused and the
 * spear halfway down the line, just to see what the distortion pass can
 * actually do — then bring it back to somewhere you can still read the floor
 * through. After that, **The sun disc** and its corona are where the time goes.
 */
export const sunspearSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 0.5, 'throw speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['discHold', 0.05, 6, 0.01, 'disc hold (s)'],
    ['discFade', 0.1, 8, 0.05, 'bloom-out (s)'],
    ['castAnim', 'cast animation']
  ],
  'The throw': [
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['landHeight', 0, 2, 0.01, 'landing height'],
    ['spearFlight', 0.1, 4, 0.05, 'nominal flight'],
    ['arcApex', 0, 16, 0.05, 'loft (m)'],
    ['arcApexCurve', 0.2, 4, 0.01, 'loft curve'],
    ['arcCurve', 0.3, 4, 0.01, 'path easing']
  ],
  'The javelin': [
    ['spearRadius', 0.02, 0.8, 0.005, 'half-width (m)'],
    ['spearStretch', 0.5, 16, 0.05, 'half-length × width'],
    ['spearAlign', 0, 1, 0.01, 'align to heading'],
    ['spearSpin', 0, 20, 0.05, 'roll (rad/s)'],
    ['spearFlash', 0.01, 1, 0.01, 'birth pop (s)'],
    ['spearSides', 3, 9, 1, 'facets'],
    ['spearTaper', 0.01, 0.6, 0.005, 'point radius'],
    ['spearRough', 0, 0.8, 0.005, 'facet roughness'],
    ['spearBend', 0, 0.6, 0.005, 'bend']
  ],
  'The javelin/Shading': [
    ['spearCore', 0, 1, 0.01, 'white core'],
    ['spearFalloff', 0.2, 8, 0.05, 'fire falloff'],
    ['spearHead', 0, 1, 0.01, 'head heat starts'],
    ['spearHeadGain', 0, 6, 0.01, 'head heat'],
    ['spearFresnel', 0, 4, 0.01, 'edge light'],
    ['spearFresnelPower', 0.2, 8, 0.05, 'edge tightness'],
    ['spearNoise', 0, 2, 0.01, 'fire crawl'],
    ['spearNoiseScale', 0.2, 16, 0.1, 'crawl scale'],
    ['spearNoiseSpeed', 0, 10, 0.05, 'crawl Hz'],
    ['spearGlow', 0, 8, 0.01, 'glow'],
    ['spearOpacity', 0, 2, 0.01, 'opacity'],
    ['spearSoftFade', 0.02, 2, 0.01, 'soft fade (m)'],
    ['colorSpearCore', 'core'],
    ['colorSpearFire', 'fire'],
    ['colorSpearEdge', 'edge']
  ],
  'The wake': [
    ['wakeStrength', 0, 2, 0.005, 'warp strength'],
    ['wakeWidth', 0.2, 16, 0.05, 'width (m)'],
    ['wakeHeight', 0.2, 12, 0.05, 'height (m)'],
    ['wakeOpacity', 0, 1, 0.01, 'coverage'],
    ['wakeFrequency', 0.05, 6, 0.01, 'shimmer / metre'],
    ['wakeSpeed', 0, 10, 0.05, 'advection (m/s)'],
    ['wakeSourceBias', 0.1, 6, 0.05, 'base bias'],
    ['wakeSpread', 0, 3, 0.01, 'column spread'],
    ['wakeVertical', 0, 1, 0.01, 'vertical share'],
    ['wakeFlicker', 0, 1, 0.01, 'flicker'],
    ['wakeDepthReject', 0, 1, 0.01, 'depth reject'],
    ['wakeDepthFade', 0.01, 2, 0.01, 'depth feather (m)'],
    ['wakePerspective', 0, 1, 0.01, 'perspective'],
    ['wakePerspectiveRef', 1, 40, 0.5, 'perspective ref (m)'],
    ['wakeFall', 0, 1, 0.01, 'decay over flight'],
    ['discWakeWidth', 0.2, 24, 0.1, 'disc width (m)'],
    ['discWakeHeight', 0.2, 12, 0.05, 'disc height (m)'],
    ['discWakeStrength', 0, 2, 0.005, 'disc strength'],
    ['discWakeSettle', 0.02, 2, 0.01, 'settle (s)']
  ],
  'The fire trail': [
    ['wakeSpan', 0.01, 1, 0.005, 'trail span (flight)'],
    ['wakeBurn', 0.05, 3, 0.01, 'burn-off (s)'],
    ['wakeTrailWidth', 0.01, 2, 0.005, 'width (m)'],
    ['wakeTrailTaper', 0.2, 5, 0.01, 'taper'],
    ['wakeTrailLift', -1, 1, 0.005, 'lift (m)'],
    ['wakeTrailOpacity', 0, 2, 0.01, 'opacity'],
    ['wakeTrailGlow', 0, 6, 0.01, 'glow'],
    ['wakeTrailCore', 0.2, 8, 0.01, 'core tightness'],
    ['wakeTrailHeadBias', -1, 2, 0.01, 'head bias'],
    ['wakeTrailNoise', 0, 2, 0.01, 'noise'],
    ['wakeTrailNoiseScale', 0.1, 8, 0.05, 'noise scale'],
    ['wakeTrailNoiseSpeed', 0, 6, 0.05, 'noise speed'],
    ['wakeTrailSoftFade', 0.02, 2, 0.01, 'soft fade (m)'],
    ['colorWake*', 'Trail colour']
  ],
  ...shellSchema('disc', ShellMode.SUNDISC),
  // `Shell`'s settings contract is one block across all five of its modes, so
  // spreading it gives a SUNDISC fourteen keys the sun disc's program does not
  // compile. Filed here rather than left to fall into the editor's "More"
  // folder: they are not unfiled, they are *inert*, and a panel that says so is
  // worth fourteen lines. Nothing reads them and moving them does nothing.
  'The sun disc/Inert in this mode': [
    ['discSpan', 0.1, 40, 0.05, 'span (CONE/RING_TRAIN)'],
    ['discSeal', 0, 4, 0.01, 'floor seal (DOME)'],
    ['discSealWidth', 0.01, 0.6, 0.01, 'seal width (DOME)'],
    ['discEdge', 0, 4, 0.01, 'leading lip (CONE)'],
    ['discEdgeWidth', 0.01, 0.8, 0.01, 'lip width (CONE)'],
    ['discConeCurve', 0.1, 4, 0.01, 'flare curve (CONE)'],
    ['discRings', 1, 48, 1, 'rings (RING_TRAIN)'],
    ['discSpacing', 0.1, 12, 0.01, 'wavelength (RING_TRAIN)'],
    ['discRingSpeed', 0, 40, 0.05, 'ring speed (RING_TRAIN)'],
    ['discRingThickness', 0.01, 2, 0.01, 'ring thickness (RING_TRAIN)'],
    ['discRingSharp', 0.05, 8, 0.01, 'ring profile (RING_TRAIN)'],
    ['discReflect', 0, 1, 0.01, 'reflection (RING_TRAIN)'],
    ['discStanding', 0, 1, 0.01, 'standing wave (RING_TRAIN)'],
    ['discSwell', 0, 2, 0.01, 'antinode swell (RING_TRAIN)']
  ],
  'The corona': [
    ['flareCount', 0, 32, 1, 'short arcs'],
    ['flareRadius', 0.5, 2, 0.01, 'radius × disc'],
    ['flareSpan', 0.01, 1, 0.005, 'arc span (turns)'],
    ['flareSpeed', -2, 2, 0.01, 'travel (turns/s)'],
    ['flareLift', 0, 4, 0.01, 'hop height (m)'],
    ['flareJitter', 0, 1, 0.01, 'radial wobble'],
    ['flareHug', 0, 1, 0.005, 'floor clearance (m)'],
    ['lickCount', 0, 16, 1, 'long licks'],
    ['lickRadius', 0.5, 2, 0.01, 'radius × disc'],
    ['lickSpan', 0.01, 1, 0.005, 'lick span (turns)'],
    ['lickSpeed', -2, 2, 0.01, 'travel (turns/s)'],
    ['lickLift', 0, 6, 0.01, 'reach (m)'],
    ['lickJitter', 0, 1, 0.01, 'radial wobble'],
    ['lickHug', 0, 1, 0.005, 'floor clearance (m)'],
    ['lickPhase', 0, 1, 0.01, 'phase offset (turns)']
  ],
  'The corona/Filaments': [
    ['flareWidth', 0.005, 0.4, 0.005, 'width (m)'],
    ['flareGlowWidth', 1, 20, 0.1, 'halo width'],
    ['flareGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['flareKink', 0, 2, 0.01, 'kink (m)'],
    ['flareKinkScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['flareOctaves', 1, 5, 1, 'octaves'],
    ['flareKinkFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['flareCrawl', -10, 10, 0.05, 'kink crawl'],
    ['flarePinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['flareRestrike', 0.5, 60, 0.5, 'restrikes / sec'],
    ['flareFlicker', 0, 1, 0.01, 'flicker'],
    ['flareFlickerSpeed', 1, 90, 1, 'flicker rate'],
    ['flareStrandFlash', 0, 1, 0.01, 'filament blink'],
    ['flareCoreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['flareFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['flareSoftFade', 0.02, 3, 0.01, 'soft fade (m)'],
    ['flareOpacity', 0, 2, 0.01, 'opacity'],
    ['flareGlow', 0, 8, 0.01, 'glow'],
    ['colorFlareCore', 'core'],
    ['colorFlareInner', 'inner'],
    ['colorFlareOuter', 'outer'],
    ['colorFlareHalo', 'halo']
  ],
  'Embers, smoke & motes': [
    ['emberRate', 0, 1200, 1, 'ember rate'],
    ['emberSize', 0.005, 0.8, 0.005, 'ember size'],
    ['emberSpeed', 0, 30, 0.1, 'ember speed'],
    ['emberLifetime', 0.05, 4, 0.01, 'ember lifetime'],
    ['emberGravity', -20, 20, 0.1, 'ember gravity'],
    ['emberStretch', 0, 3, 0.01, 'ember stretch'],
    ['emberBurst', 0, 800, 1, 'embers at impact'],
    ['colorEmber*', 'Ember colour'],
    ['smokeRate', 0, 400, 1, 'smoke rate'],
    ['smokeSize', 0.05, 5, 0.05, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['smokeRise', -2, 5, 0.01, 'smoke rise'],
    ['colorSmoke*', 'Smoke colour'],
    ['moteRate', 0, 500, 1, 'mote rate'],
    ['moteSize', 0.005, 0.5, 0.005, 'mote size'],
    ['moteSpeed', 0, 10, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 8, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['colorMote*', 'Mote colour']
  ],
  'The landing': [
    ['burstSize', 0.2, 14, 0.05, 'burst size (m)'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.5, 0.005, 'flight rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst core'],
    ['colorFlash', 'impact flash'],
    ['colorCastFlash', 'release flash']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 60, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
