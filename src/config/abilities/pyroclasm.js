import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* PYROCLASM — the ash dome that collapses before it blows              */
/* ================================================================== */
/**
 * A far cast. A raymarched dome of ash forms at the full footprint, **contracts**
 * onto its own centre, stands compressed for a beat, and then inverts its
 * density and blasts out past the boundary it started from.
 *
 * The three beats are three radii — `formSpread`, `collapseRadius`,
 * `blastSpread` — all expressed as multiples of `zoneRadius`, which is the one
 * value the indicator, the hull, the heat column and the floor scour all read.
 * That sharing *is* the design (invariant I5's stated exception): dragging
 * `zoneRadius` mid-cast moves every one of them together, which is what you
 * want, and giving the dome its own metre would give you two numbers that have
 * to agree.
 *
 * ### Why the medium is sampled in world space
 *
 * `Medium.ASH` evaluates its fbm in `worldDomain()` — world metres, not hull
 * space. That is the whole implosion. A hull-local field (which is what
 * `Medium.FLAME` uses, deliberately, so a jet carries its own turbulence)
 * shrinks its grain along with `uSize`, so a contracting dome renders as the
 * *same* cloud getting smaller: a zoom, not a collapse. Sampled in world space
 * the grain is nailed to the room, so the shrinking silhouette eats inward
 * through a stationary field and you can watch individual clots of ash pass out
 * of the volume. Nothing else in the beat sells it.
 *
 * ### The inversion
 *
 * `blast*` below are the far ends of five lerps the ability drives with one
 * unitless beat. They are authored as endpoints rather than deltas because the
 * pair that actually needs watching — `ashNoiseStrength` against `ashMargin` —
 * is only legible when both ends are written down. Erosion is quadratic in the
 * distance past the medium's nominal surface, so raising it without also giving
 * the hull more headroom slices the ash off along a dead straight line at the
 * proxy wall. `blastMargin` is above `ashMargin` for exactly that reason; if you
 * raise `blastErosion`, you owe `blastMargin`.
 */
export const pyroclasm = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  speed: 44.0, // how fast the ignition front runs out to the footprint, metres/second
  zoneRadius: 6.0, // the footprint the circle indicator draws, metres
  cooldown: 1.5, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the cast leaves the caster --- */
  handForward: 0.6, // metres in front of the caster the ash coughs out
  handHeight: 1.3, // metres above the floor

  /* --- the four beats --- */
  // impactDuration = collapseTime + holdTime; fadeDuration = blastTime + settleTime.
  // All four are live, so re-timing the collapse re-times a dome already standing.
  collapseTime: 0.62, // seconds the dome takes to contract from full radius
  holdTime: 0.34, // seconds it stands compressed before it goes
  blastTime: 0.46, // seconds the blast front takes to reach full spread
  settleTime: 1.35, // seconds the surge takes to thin out and die

  /* --- the three radii, × zoneRadius --- */
  formSpread: 1.06, // radius the dome forms at
  collapseRadius: 0.33, // radius it contracts to
  blastSpread: 1.62, // radius it blasts out to, past the boundary
  hullSlack: 1.05, // extra proxy-hull headroom on top of the margin compensation
  charSeat: 0.42, // how far the floor is charred before the blast front moves

  /* --- the three heights, × zoneRadius --- */
  // The dome stands *up* as it narrows — the same ash in a smaller footprint —
  // and runs low and wide once it lets go. That vertical swing is most of what
  // reads as pressure.
  formHeight: 0.5, // dome height when it forms
  compressHeight: 0.98, // ... at full compression
  blastHeight: 0.33, // ... at full spread

  /* --- the density inversion (the far end of five lerps) --- */
  blastHeightBias: 1.55, // > 1 drives the field negative near the top: the dome hollows out
  blastDensityCurve: 0.45, // < 1 lifts the thin fringe to nearly the weight of the old core
  blastErosion: 1.75, // × ashNoiseStrength — throws the field past its own silhouette
  blastMargin: 0.46, // headroom inside the hull at full erosion (see the note above)
  blastDensity: 0.62, // × ashDensity — the surge is thinner than the compressed dome
  blastRise: 2.6, // metres/second the noise domain climbs once it is loose

  /* --- the ash volume (Medium.ASH, prefix `ash`) --- */
  // Steps × (1 + shadow taps) × covered pixels is the cost; a dome filling a
  // quarter of 1080p at 34 steps and one tap is about 35 M samples, which is the
  // working limit for a hero volume and the reason the step count is not 44.
  // The eight `ashBoil*` / `ashVoid*` keys below belong to other media and are
  // inert here — see the note above `pyroclasmSchema`.
  ...volumeHullDefaults('ash', Medium.ASH, {
    ashSteps: 34, // march steps — the cost knob, see above
    ashJitter: 1.0, // step dither; 0 only ever shows you the banding
    ashContact: 1.1, // metres of fade where the ash meets the floor
    ashMargin: 0.24, // headroom inside the hull before the blast
    ashHeightBias: 0.3, // density falls this much toward the crown
    ashFeather: 0.28, // far-edge feather
    ashDensity: 2.3, // density
    ashDensityCurve: 1.05, // density curve before the blast
    ashSoftness: 0.4, // edge softness
    ashNoiseFrequency: 1.5, // features per metre — the grain the collapse reveals
    ashNoiseStrength: 0.9, // erosion
    ashNoiseWarp: 0.32, // domain warp
    ashOctaves: 4, // octaves
    ashDetail: 0.75, // fine-octave gain
    ashFlowY: -0.45, // world flow Y, metres/second — ash falls
    ashRise: 0.15, // buoyant rise, metres/second — nearly nothing while it collapses
    ashSwirl: 0.12, // swirl about the vertical, radians/second
    ashAbsorption: 3.0, // absorption, 1/metre
    ashScatter: 2.0, // scattering
    ashAmbient: 0.32, // multi-scatter floor
    ashEmission: 1.9, // emission (the embers inside the medium)
    ashEmissionCurve: 0.7, // emission by density
    ashShadowTaps: 1, // self-shadow taps — ash is absorbing and needs a lit side
    ashShadowLength: 0.8, // self-shadow reach, metres
    ashSpeckDensity: 0.09, // fraction of lattice cells holding an ember
    ashSpeckScale: 3.0, // ember cells per metre
    ashSpeckSize: 0.14, // ember size within its cell
    ashSpeckGlow: 11.0, // ember brightness
    // The neutral default for this one is a cold blue-white, which is right for
    // VOID's stars and wrong for embers in a soot cloud.
    ashColorSpeck: '#ff8a3a' // the embers inside the medium
  }),

  /* --- the heat column standing over it --- */
  // Magnitudes are SCREEN FRACTIONS, not metres, and the post pass applies
  // `post.distortion × global.distortion` on top — never multiply those in here.
  hazeStrength: 0.42, // screen widths of offset at post.distortion = 1
  hazeWidth: 2.35, // × the ash radius — how wide the column is
  hazeHeight: 2.0, // × the ash radius — how tall
  hazeLift: 0.05, // metres above the floor the column starts
  hazeTravel: 1.6, // × hazeWidth while the front is still running out
  hazeFrequency: 0.85, // shimmer cycles per metre
  hazeSpeed: 2.4, // metres/second the shimmer climbs
  hazeSourceBias: 1.15, // exponent — how hard it favours the base
  hazeSpread: 0.95, // how far the column opens out over its height
  hazeVertical: 0.42, // how much of the wobble is up/down rather than sideways
  hazeFlicker: 0.35, // depth of the second, slower clock
  hazePerspective: 0.5, // 0 = a fixed screen fraction, 1 = shrinks with distance
  hazePerspectiveRef: 14.0, // metres at which perspective = 1
  hazeDepthReject: 1.0, // how hard opaque geometry in front of the column cuts it, 0..1
  hazeDepthFade: 0.45, // metres over which standing geometry cuts the shimmer

  /* --- the floor, scoured by the front as it passes --- */
  // GroundMode.SCOUR, shaded rather than additive: a burn is darker than the
  // stone it is on. `grow` is driven by the blast front's own radius, so the
  // mark is *drawn by* the surge rather than spawned whole at impact.
  scorchSpread: 1.72, // radius of the scour quad, × zoneRadius
  scorchEdge: 0.62, // metres of feather on the growth front
  scorchRagged: 0.3, // how far that front wanders, as a fraction of the radius
  scorchRaggedScale: 0.55, // lobes per metre
  scorchWarp: 0.75, // metres of domain warp on those lobes
  scorchDepth: 0.15, // metres — how deep a groove is cut
  scorchLift: 0.055, // metres — how high the spoil piles between grooves
  scorchArms: 13, // radial grooves; a whole number or the spiral tears at ±π
  scorchSwirl: 0.34, // spiral pitch; 0 gives dead-straight spokes
  scorchSharp: 0.62, // 0 soft grooves, 1 knife-edged
  scorchDetail: 0.7, // fine grain over the scour
  scorchTurn: 0.04, // radians/second the whole pattern creeps
  scorchRelief: 0.85, // how hard the height field tilts the fake normal
  scorchNormalStep: 0.07, // metres between the height taps
  scorchAmbient: 0.26, // floor on the diffuse term
  scorchWrap: 0.5, // wraps the terminator round the back
  scorchSpecular: 0.22, // vitrified ground has a little sheen
  scorchGloss: 18.0, // Blinn exponent
  scorchParallax: 0.2, // metres of view-driven offset on the groove detail
  scorchEmissive: 1.1, // multiplier on every glowing term
  scorchOpacity: 0.95,
  scorchHeight: 0.02, // metres the quad floats above the floor
  scorchDepthFade: 0.42, // metres of soft fade against anything standing in it
  colorScorchBase: '#2a211c', // the burnt ground itself
  colorScorchEdge: '#6b5344', // the ridges of spoil between the grooves
  colorScorchGlow: '#ff7a2a', // the front, and the heat still in the grooves
  colorScorchDeep: '#0d0908', // the bottom of a groove

  /* --- embers raining inside the dome --- */
  emberRate: 170, // particles/second
  emberSize: 0.075,
  emberSpeed: 1.1, // metres/second of initial scatter
  emberLifetime: 1.9, // seconds
  emberFall: -2.4, // gravity, metres/second² — negative, they rain
  emberTurbulence: 0.85,
  emberGlow: 2.4,
  emberInset: 0.82, // where inside the dome they are born, × the ash radius
  emberCeiling: 0.9, // ... and how far up it, × the dome height
  emberBurst: 220, // extra embers thrown out on the blast
  colorEmberA: '#ffd9a0',
  colorEmberB: '#ff7a2a',
  colorEmberC: '#a33a10',
  colorEmberD: '#3a1408',

  /* --- the ash that gets out of the dome --- */
  pallRate: 66, // particles/second
  pallSize: 1.15,
  pallSpeed: 1.4, // metres/second
  pallLifetime: 2.8, // seconds
  pallRise: 0.5, // gravity, metres/second² — a slow lift
  pallOpacity: 0.28,
  pallBurst: 140, // extra puffs thrown out on the blast
  colorPallA: '#5c4a3e',
  colorPallB: '#3a2c24',
  colorPallC: '#251c17',
  colorPallD: '#1a1210',

  /* --- grit kicked off the floor --- */
  gritRate: 26, // particles/second while the dome is compressed
  gritSize: 0.06,
  gritSpeed: 6.5, // metres/second
  gritLifetime: 1.4, // seconds
  gritGravity: -19.0, // metres/second²
  gritBurst: 110, // extra chips thrown out on the blast
  colorGritA: '#6b5344',
  colorGritB: '#2a211c',
  colorGritC: '#1a1210',
  colorGritD: '#1a1210',

  /* --- the punctuation --- */
  burstSize: 3.6, // the shell of hot air at the moment of collapse, metres
  burstIntensity: 1.5,
  blastBurstSize: 7.5, // ... and at the moment it lets go, metres
  blastBurstIntensity: 2.0,
  shockRadius: 11.0, // the ring that snaps out across the floor, metres
  castFlash: 0.09, // screen flash as the front leaves the caster
  collapseFlash: 0.1, // ... as the dome finishes contracting
  blastFlash: 0.34, // ... as it goes
  impactShake: 0.55, // shake when the dome forms
  blastShake: 1.05, // shake when it blows
  shakeDuration: 0.7, // seconds
  rumble: 0.05, // continuous shake while the dome is compressed
  colorBurstA: '#5c2a10',
  colorBurstB: '#ff7a2a',
  colorBurstC: '#ffd9a0',
  colorCastFlash: '#ff7a2a',
  colorFlash: '#ffd9a0', // the full-screen flash on the blast
  colorShockA: '#5c2a10', // body of the shockwave ring
  colorShockB: '#ffd9a0', // its crest

  /* --- dynamic light --- */
  lightIntensity: 24, // the ember glow inside the dome
  lightRadius: 18, // metres
  lightHeight: 0.45, // where the light sits in the dome, × the dome height
  lightColor: '#ff7a2a'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Pyroclasm.
 *
 * Reach for `collapseRadius` and `blastSpread` first — those two carry the beat
 * — and then `ashNoiseFrequency`, which is the size of the grain the collapse
 * reveals and therefore the single control that decides whether the implosion
 * reads at all. If you see the ash sliced off along a straight line, that is
 * `ashNoiseStrength` (or `blastErosion`) against `ashMargin` (or `blastMargin`),
 * every time.
 *
 * The eight `ashBoil*` and one `ashVoid*` keys are not filed here on purpose.
 * `volumeHullDefaults` emits the whole vocabulary so the hull's own audit stays
 * quiet, but GAS_BOIL's bubbles and VOID's extra occlusion do nothing to an ASH
 * medium, and nine inert rows in a folder is worse than a "More" folder nobody
 * opens.
 */
export const pyroclasmSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'front speed'],
    ['zoneRadius', 1, 16, 0.1, 'footprint radius'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handHeight', 0, 3, 0.01, 'hand height']
  ],
  'The beats': [
    ['collapseTime', 0.05, 3, 0.01, 'contract time'],
    ['holdTime', 0, 3, 0.01, 'compressed hold'],
    ['blastTime', 0.05, 3, 0.01, 'blast time'],
    ['settleTime', 0.1, 6, 0.01, 'settle time']
  ],
  'The dome': [
    ['formSpread', 0.2, 2.5, 0.01, 'form radius ×R'],
    ['collapseRadius', 0.05, 1.2, 0.01, 'collapsed radius ×R'],
    ['blastSpread', 0.3, 3, 0.01, 'blast radius ×R'],
    ['hullSlack', 1, 2, 0.01, 'proxy hull slack'],
    ['charSeat', 0.05, 1.5, 0.01, 'char before the blast ×R'],
    ['formHeight', 0.05, 2, 0.01, 'form height ×R'],
    ['compressHeight', 0.05, 3, 0.01, 'compressed height ×R'],
    ['blastHeight', 0.05, 2, 0.01, 'blast height ×R']
  ],
  'The inversion': [
    ['blastHeightBias', 0, 3, 0.01, 'hollow the crown'],
    ['blastDensityCurve', 0.1, 3, 0.01, 'fringe lift'],
    ['blastErosion', 0.2, 4, 0.01, 'erosion ×'],
    ['blastMargin', 0.02, 0.7, 0.01, 'headroom at full erosion'],
    ['blastDensity', 0.05, 2, 0.01, 'density ×'],
    ['blastRise', -4, 8, 0.01, 'domain rise (m/s)']
  ],
  ...volumeHullSchema('ash', {
    label: 'Ash',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'speck', 'colour']
  }),
  'Heat column': [
    ['hazeStrength', 0, 2, 0.01, 'strength (screen widths)'],
    ['hazeWidth', 0.2, 5, 0.01, 'width ×ash radius'],
    ['hazeHeight', 0.2, 6, 0.01, 'height ×ash radius'],
    ['hazeLift', -1, 3, 0.01, 'base height (m)'],
    ['hazeTravel', 0.05, 4, 0.01, 'width while travelling ×'],
    ['hazeFrequency', 0.05, 5, 0.01, 'cycles / metre'],
    ['hazeSpeed', 0, 10, 0.01, 'climb speed (m/s)'],
    ['hazeSourceBias', 0, 5, 0.01, 'base bias'],
    ['hazeSpread', 0, 3, 0.01, 'column spread'],
    ['hazeVertical', 0, 1, 0.01, 'vertical share'],
    ['hazeFlicker', 0, 2, 0.01, 'flicker'],
    ['hazePerspective', 0, 1, 0.01, 'perspective'],
    ['hazePerspectiveRef', 1, 40, 0.5, 'perspective ref (m)'],
    ['hazeDepthReject', 0, 1, 0.01, 'occlusion strength'],
    ['hazeDepthFade', 0.05, 3, 0.01, 'occlusion fade (m)']
  ],
  'Floor scour': [
    ['scorchSpread', 0.3, 3, 0.01, 'radius ×R'],
    ['scorchEdge', 0.05, 3, 0.01, 'front feather (m)'],
    ['scorchRagged', 0, 1, 0.01, 'front wander'],
    ['scorchRaggedScale', 0.05, 3, 0.01, 'lobes / metre'],
    ['scorchWarp', 0, 3, 0.01, 'lobe warp (m)'],
    ['scorchDepth', 0, 1, 0.005, 'groove depth (m)'],
    ['scorchLift', 0, 0.5, 0.005, 'spoil height (m)'],
    ['scorchArms', 1, 40, 1, 'grooves'],
    ['scorchSwirl', -2, 2, 0.01, 'spiral pitch'],
    ['scorchSharp', 0, 1, 0.01, 'groove sharpness'],
    ['scorchDetail', 0, 1, 0.01, 'grain'],
    ['scorchTurn', -2, 2, 0.01, 'rotation (rad/s)'],
    ['scorchRelief', 0, 3, 0.01, 'relief'],
    ['scorchNormalStep', 0.005, 0.4, 0.005, 'normal step (m)'],
    ['scorchAmbient', 0, 1, 0.01, 'ambient'],
    ['scorchWrap', 0, 1, 0.01, 'terminator wrap'],
    ['scorchSpecular', 0, 2, 0.01, 'specular'],
    ['scorchGloss', 1, 90, 1, 'gloss'],
    ['scorchParallax', 0, 2, 0.01, 'parallax (m)'],
    ['scorchEmissive', 0, 4, 0.01, 'emissive'],
    ['scorchOpacity', 0, 1, 0.01, 'opacity'],
    ['scorchHeight', 0, 0.3, 0.005, 'float above floor (m)'],
    ['scorchDepthFade', 0.05, 3, 0.01, 'soft intersection (m)'],
    ['colorScorchBase', 'burnt ground'],
    ['colorScorchEdge', 'spoil ridges'],
    ['colorScorchGlow', 'heat in the grooves'],
    ['colorScorchDeep', 'groove floor']
  ],
  'Embers': [
    ['emberRate', 0, 800, 1, 'ember rate'],
    ['emberSize', 0.005, 0.4, 0.005, 'ember size'],
    ['emberSpeed', 0, 12, 0.05, 'ember speed'],
    ['emberLifetime', 0.1, 8, 0.05, 'ember lifetime'],
    ['emberFall', -20, 4, 0.05, 'ember gravity'],
    ['emberTurbulence', 0, 3, 0.01, 'ember turbulence'],
    ['emberGlow', 0, 8, 0.01, 'ember glow'],
    ['emberInset', 0, 1.5, 0.01, 'birth radius ×ash radius'],
    ['emberCeiling', 0, 2, 0.01, 'birth height ×dome height'],
    ['emberBurst', 0, 800, 1, 'embers on the blast'],
    ['colorEmber*', 'Ember colour']
  ],
  'Ash & grit': [
    ['pallRate', 0, 400, 1, 'ash rate'],
    ['pallSize', 0.05, 4, 0.01, 'ash size'],
    ['pallSpeed', 0, 10, 0.05, 'ash speed'],
    ['pallLifetime', 0.2, 10, 0.05, 'ash lifetime'],
    ['pallRise', -3, 5, 0.01, 'ash rise'],
    ['pallOpacity', 0, 1, 0.005, 'ash opacity'],
    ['pallBurst', 0, 600, 1, 'ash on the blast'],
    ['colorPall*', 'Ash colour'],
    ['gritRate', 0, 300, 1, 'grit rate'],
    ['gritSize', 0.005, 0.4, 0.005, 'grit size'],
    ['gritSpeed', 0, 30, 0.1, 'grit speed'],
    ['gritLifetime', 0.1, 5, 0.05, 'grit lifetime'],
    ['gritGravity', -50, 0, 0.1, 'grit gravity'],
    ['gritBurst', 0, 500, 1, 'grit on the blast'],
    ['colorGrit*', 'Grit colour']
  ],
  'Impact & blast': [
    ['burstSize', 0.2, 16, 0.05, 'collapse shell size'],
    ['burstIntensity', 0, 5, 0.01, 'collapse shell intensity'],
    ['blastBurstSize', 0.2, 24, 0.05, 'blast shell size'],
    ['blastBurstIntensity', 0, 6, 0.01, 'blast shell intensity'],
    ['shockRadius', 0.5, 40, 0.1, 'shockwave radius'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['collapseFlash', 0, 2, 0.01, 'flash on collapse'],
    ['blastFlash', 0, 2, 0.01, 'flash on the blast'],
    ['impactShake', 0, 3, 0.01, 'shake on collapse'],
    ['blastShake', 0, 4, 0.01, 'shake on the blast'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.5, 0.005, 'compressed rumble'],
    ['colorBurstA', 'shell body'],
    ['colorBurstB', 'shell mid'],
    ['colorBurstC', 'shell arcs'],
    ['colorCastFlash', 'release flash colour'],
    ['colorFlash', 'blast flash colour'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 60, 0.1, 'light radius'],
    ['lightHeight', 0, 1.5, 0.01, 'light height ×dome height'],
    ['lightColor', 'light colour']
  ]
};
