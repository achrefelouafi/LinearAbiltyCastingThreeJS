import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* HOURGLASS — the inversion                                           */
/* ================================================================== */
/**
 * A far cast. Two raymarched cones of sand stand apex to apex over the circle:
 * the bulb above the neck drains, the heap below it grows, the whole zone goes
 * weightless for a beat — and then the sand falls **up**.
 *
 * ### One number is the ability
 *
 * `flow` is a signed, unitless rate the ability resolves from the durations
 * below on every frame. It is +1 while the glass runs down, it eases through
 * zero across `stallTime`, and it is −1 while it runs back up. That single
 * number is written into `Hook.GRAVITY` as the multiplier inside the well, and
 * every consumer — the grains, the two volumes' advection, the dust, the motes
 * — reads it **back off the published field** rather than off the local
 * variable. There is therefore exactly one sign in this ability, and flipping
 * it flips the zone.
 *
 * ### Why the stall is not only drama
 *
 * A particle's position in this engine is `start + v·travel(age) + ½·g·age²`,
 * closed form in its own age. That is what lets a grain already in the air
 * reverse when the field does — nothing is integrated, so nothing has spent the
 * old gravity. But it also means position is a *function of g*, so a
 * discontinuous g moves every live grain the instant it changes. Easing `flow`
 * through zero over `stallTime` is what keeps a thousand grains continuous
 * across the turn: at the crossing the quadratic term is exactly zero, every
 * grain sits on its own ballistic path, hanging, and then starts to climb.
 *
 * The beat you can see coming and the mechanism that makes the beat safe are
 * the same curve. Wind `stallTime` down toward zero and you can watch it break.
 *
 * ### The two cones are one shape
 *
 * `waistHeight` is the neck, and both hulls are measured from it: the upper
 * bulb's apex sits there and shrinks toward it as it empties; the heap's apex
 * climbs toward it as it fills. At full drain the heap touches the neck and the
 * bulb has gone. One number owns the silhouette — invariant I5's stated
 * exception, where the sharing *is* the design — so dragging `zoneRadius`
 * scales the whole glass and nothing has to be kept in agreement with anything.
 *
 * There is no glass. A vessel would want a refractive hard surface this school
 * does not have, and the shape does not need one: two cones apex to apex say
 * hourglass on their own, and leaving the vessel out is what lets the sand be
 * the only object in the frame.
 */
export const hourglass = {
  /* --- the cast --- */
  range: 18.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 34.0, // how fast the glass runs out to the circle, metres/second
  zoneRadius: 3.6, // the footprint the circle indicator draws, metres
  cooldown: 1.6, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the cast leaves the caster --- */
  handForward: 0.55, // metres in front of the caster the seed leaves
  handHeight: 1.24, // metres above the floor

  /* --- the five beats --- */
  // impactDuration = drainTime + stallTime + riseTime (the seat rides inside
  // the drain); fadeDuration = settleTime. All of them are live, so re-timing
  // the turn re-times a glass that is already standing.
  seatTime: 0.34, // seconds the glass takes to stand up once it lands
  drainTime: 1.55, // seconds the upper bulb takes to empty
  stallTime: 0.62, // seconds the zone spends going weightless and coming back
  riseTime: 1.05, // seconds the sand takes to climb back — faster than the fall
  settleTime: 1.2, // seconds the standing glass takes to let go

  /* --- the silhouette, all × zoneRadius except where stated --- */
  waistHeight: 0.62, // the neck — both cones are measured from it
  bulbRadius: 0.92, // mouth radius of the upper bulb when it is full
  bulbHeight: 1.05, // apex-to-mouth length of the upper bulb when it is full
  bulbEmpty: 0.07, // what is left of the bulb at full drain — a sliver at the neck
  pileFill: 0.98, // how close the heap's apex gets to the neck at full drain
  pileMax: 1.0, // hard cap on the heap's base radius, × zoneRadius
  reposeAngle: 34.0, // degrees — the heap's angle of repose; radius = height / tan
  neckRadius: 0.11, // metres — the throat the grains are born in
  seedFill: 0.16, // how much of the glass exists while the cast is still travelling
  hullSlack: 1.06, // extra proxy-hull headroom on top of the margin compensation

  /* --- the gravity well (Hook.GRAVITY) --- */
  // A sphere centred on the neck, so it covers both cones and the air between
  // them. `gravityInside` is a *magnitude*: the ability multiplies it by `flow`
  // and hands the product to the hook, and that product is the one sign in the
  // file. `gravityOutside` stays 1 — the rest of the world is not in the glass.
  gravityRadius: 2.4, // × zoneRadius — the well, measured from the neck
  gravityEdge: 0.3, // softness of the well's wall, as a fraction of its radius
  gravityInside: 1.0, // magnitude of the multiplier inside; 1 = a clean inversion
  gravityOutside: 1.0, // ... and outside, where the world must stay normal

  /* --- the advection inside the two volumes --- */
  // Metres per second along each hull's own axis and along world up. These are
  // *not* handed to the hull as rates — see `_domain()` in the ability: the
  // medium offsets its noise domain by rate × the shared app clock, so a rate
  // that changes mid-cast teleports the field by t·Δv. They are integrated to a
  // signed displacement first, and it is the displacement that flips.
  streamJet: 1.5, // sand running down the upper cone toward the neck
  streamFall: 0.85, // ... and the world-Y component of the same stream
  settleJet: 0.7, // sand settling into the heap
  settleFall: 0.3, // ... and its world-Y component
  scourTurn: 0.22, // radians/second the floor's grooves are cut round

  /* --- the falling column (Medium.SAND in a CONE, prefix `sand`) --- */
  // Cost: steps × (1 + taps) × covered pixels. The column is the larger of the
  // two on screen; at 26 steps, one tap and a tenth of 1080p that is about 11 M
  // samples against the library's 20 M budget, and the heap below is
  // deliberately cheaper because it is squat and mostly occludes itself.
  ...volumeHullDefaults('sand', Medium.SAND, {
    sandSteps: 26, // march steps — the cost knob
    sandJitter: 1.0, // step dither; 0 only ever shows you the banding
    sandContact: 0.55, // metres of fade where the sand meets standing geometry
    sandMargin: 0.15, // headroom inside the proxy cone for the erosion
    sandRound: 0.55, // footprint rounding
    sandHeightBias: 0.12, // density falls only slightly toward the mouth
    sandFeather: 0.22, // far-edge feather
    sandThroat: 0.09, // cone: how long the opening at the apex is
    sandHollow: 0.0, // cone: peak off-axis — a column, not a ring
    sandDensity: 2.5, // density
    sandDensityCurve: 1.0, // density curve
    sandSoftness: 0.34, // edge softness — sand is a threshold, not a fog edge
    sandNoiseFrequency: 2.9, // features per metre — this is the grain size
    sandNoiseStrength: 0.72, // erosion
    sandNoiseWarp: 0.22, // domain warp
    sandOctaves: 4, // octaves
    sandDetail: 1.0, // fine-octave gain — sand is all fine octave
    sandRise: 0.0, // driven from the integrated displacement; see above
    sandJet: 0.0, // ... and so is this
    sandSwirl: 0.28, // swirl about the cone's axis, radians/second
    sandAbsorption: 3.4, // absorption, 1/metre
    sandScatter: 2.6, // scattering — kept near absorption or the sand goes black
    sandAmbient: 0.44, // multi-scatter floor
    sandAnisotropy: 0.06, // sand scatters almost isotropically
    sandShadowTaps: 1, // self-shadow taps — an absorber needs a lit side
    sandShadowStrength: 1.05,
    sandShadowLength: 0.5, // metres
    sandOpacity: 1.0,
    sandColorCore: '#e6d0a2', // sunlit grains
    sandColorMid: '#bda172',
    sandColorEdge: '#6d6252',
    sandColorDeep: '#241f19',
    sandColorLight: '#ffeccb' // the key light through the column
  }),

  /* --- the heap (Medium.SAND in a CONE, prefix `dune`) --- */
  ...volumeHullDefaults('dune', Medium.SAND, {
    duneSteps: 20, // squat and self-occluding; it does not need the column's march
    duneJitter: 1.0,
    duneContact: 0.7, // metres — it sits on the floor, so this one matters
    duneMargin: 0.13,
    duneRound: 0.7, // a heap is round
    duneHeightBias: 0.08,
    duneFeather: 0.18,
    duneThroat: 0.16, // cone: the apex is blunt — a heap has no needle point
    duneHollow: 0.0,
    duneDensity: 3.2, // packed, not airborne
    duneDensityCurve: 0.9,
    duneSoftness: 0.28,
    duneNoiseFrequency: 3.4, // a heap reads grainier than the falling column
    duneNoiseStrength: 0.55, // ... but erodes less; it is not in the air
    duneNoiseWarp: 0.18,
    duneOctaves: 4,
    duneDetail: 1.0,
    duneRise: 0.0, // integrated displacement, as above
    duneJet: 0.0,
    duneSwirl: 0.0, // a heap does not turn
    duneAbsorption: 4.2,
    duneScatter: 3.0,
    duneAmbient: 0.36,
    duneAnisotropy: 0.04,
    duneShadowTaps: 1,
    duneShadowStrength: 1.15,
    duneShadowLength: 0.42,
    duneOpacity: 1.0,
    duneColorCore: '#d8c297',
    duneColorMid: '#a88d63',
    duneColorEdge: '#5c5245',
    duneColorDeep: '#1c1814',
    duneColorLight: '#ffe6bd'
  }),

  /* --- the floor under it --- */
  // GroundMode.SCOUR, shaded rather than additive: sand drifting on stone is
  // darker than the stone. The grooves keep **one** rotation rate all cast —
  // see the ability for why the sign flip deliberately stops at the floor.
  scourSpread: 1.35, // radius of the quad, × zoneRadius
  scourEdge: 0.45, // metres of feather on the growth front
  scourRagged: 0.32, // how far that front wanders, as a fraction of the radius
  scourRaggedScale: 0.6, // lobes per metre
  scourWarp: 0.55, // metres of domain warp on those lobes
  scourDepth: 0.075, // metres — how deep a groove is scoured
  scourLift: 0.05, // metres — how high the drift piles between grooves
  scourArms: 11, // grooves; a whole number or the spiral tears at ±π
  scourSwirl: 0.42, // spiral pitch; 0 gives dead-straight spokes
  scourSharp: 0.48, // 0 soft grooves, 1 knife-edged
  scourDetail: 0.85, // grain over the drift
  scourRelief: 0.9, // how hard the height field tilts the fake normal
  scourNormalStep: 0.05, // metres between the height taps
  scourAmbient: 0.34, // floor on the diffuse term
  scourWrap: 0.5, // wraps the terminator round the back
  scourSpecular: 0.16, // dry sand has almost no sheen
  scourGloss: 14.0, // Blinn exponent
  scourParallax: 0.22, // metres of view-driven offset on the groove detail
  scourEmissive: 0.85, // multiplier on every glowing term
  scourTurnGlow: 1.6, // × emissive at the top of the stall — the floor lights up
  scourOpacity: 0.9,
  scourHeight: 0.018, // metres the quad floats above the floor
  scourDepthFade: 0.4, // metres of soft fade against anything standing in it
  colorScourBase: '#8a7c63', // the drift itself
  colorScourEdge: '#cdb98e', // the ridges between the grooves
  colorScourGlow: '#e8c27a', // the front, and the light left in the grooves
  colorScourDeep: '#241f19', // the bottom of a groove

  /* --- the grains: the particles that actually reverse --- */
  // These are what the trick is *about*. Their gravity is the published field,
  // so a grain half way down the neck when the zone turns climbs back out along
  // the arc it fell in.
  grainRate: 320, // particles/second at full flow
  grainSize: 0.05,
  grainSpeed: 0.55, // metres/second of initial scatter out of the throat
  grainLifetime: 1.15, // seconds
  grainGravity: -13.5, // metres/second², × the published multiplier
  grainSpin: 6.0, // radians/second of tumble
  grainSpread: 0.55, // how wide the throat sprays, 0..1
  grainBurst: 190, // extra grains thrown off the heap on the turn
  colorGrainA: '#f2e0b8',
  colorGrainB: '#c8ab7c',
  colorGrainC: '#8a7758',
  colorGrainD: '#4a4134',

  /* --- the dust that puffs where the stream lands --- */
  dustRate: 46, // particles/second
  dustSize: 0.55,
  dustSpeed: 0.9, // metres/second
  dustLifetime: 2.1, // seconds
  dustRise: 0.5, // metres/second², × the published multiplier — it sinks when flipped
  dustOpacity: 0.2,
  dustTurbulence: 0.7,
  dustSpread: 0.42, // metres of scatter around the landing point
  colorDustA: '#d8c8a8',
  colorDustB: '#a8967a',
  colorDustC: '#5c5245',
  colorDustD: '#2a2620',

  /* --- the motes: bone-amber time dust hanging round the glass --- */
  moteRate: 70, // particles/second
  moteSize: 0.055,
  moteSpeed: 0.35, // metres/second
  moteLifetime: 2.6, // seconds
  moteRise: 0.7, // metres/second², × the published multiplier
  moteTurbulence: 0.55,
  moteGlow: 1.5,
  moteShell: 1.35, // × the bulb radius — how far out they hang
  colorMoteA: '#ffeccb',
  colorMoteB: '#e8c27a',
  colorMoteC: '#a98a52',
  colorMoteD: '#3a2f1e',

  /* --- the punctuation --- */
  seatBurstSize: 2.1, // the shell of dust as the glass seats, metres
  seatBurstIntensity: 1.1,
  warnAt: 0.42, // 0..1 of the stall envelope the telegraph fires at
  warnBurstSize: 3.4, // the telegraph shell, metres
  warnBurstIntensity: 1.35,
  warnRingRadius: 5.2, // metres — the ring that says the turn is coming
  warnRingIntensity: 0.85,
  warnFlash: 0.06, // screen flash on the telegraph
  turnBurstSize: 4.6, // the shell at the instant the sand reverses, metres
  turnBurstIntensity: 1.7,
  turnRingRadius: 8.0, // metres
  turnRingIntensity: 1.15,
  turnFlash: 0.2, // screen flash on the turn
  seatShake: 0.4,
  turnShake: 0.72,
  shakeDuration: 0.65, // seconds
  rumble: 0.028, // continuous shake while the glass is running
  colorSeatA: '#5c5245',
  colorSeatB: '#bda172',
  colorSeatC: '#e6d0a2',
  colorWarnA: '#6b5a34',
  colorWarnB: '#d5be8c',
  colorWarnC: '#ffeccb',
  colorTurnA: '#8a7758',
  colorTurnB: '#e8c27a',
  colorTurnC: '#fff4dc',
  colorWarnFlash: '#d5be8c',
  colorTurnFlash: '#ffeccb',
  colorRingA: '#8a7758', // body of a floor ring
  colorRingB: '#ffeccb', // its crest

  /* --- dynamic light --- */
  lightIntensity: 15, // the glow through the falling column
  lightRadius: 14, // metres
  lightSwell: 0.55, // × intensity at the top of the stall — the weightless beat
  lightFlicker: 0.12, // depth of the steady breathing under it
  lightTickRate: 5.4, // radians/second of that breathing — constant, see the ability
  lightColor: '#e8c27a'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Hourglass.
 *
 * Reach for `stallTime` first — it is the whole ability. Short, and the turn is
 * a jump cut and the grains snap onto a new arc; long, and the zone hangs
 * weightless until the beat stops being a beat. Then `drainTime` against
 * `riseTime`: the fall wants to be slow enough to be boring and the climb fast
 * enough to be wrong, and the gap between those two numbers is the joke.
 *
 * After that, `reposeAngle` — a steep heap reads as a spike and a shallow one
 * as a puddle — and `sandNoiseFrequency`, which is the size of the grain and
 * therefore whether the column reads as sand at all.
 *
 * The `sandBoil*` / `sandVoid*` / `sandSpeck*` keys and their `dune` twins are
 * not filed here on purpose. `volumeHullDefaults` emits the whole vocabulary so
 * the hull's own audit stays quiet, but bubbles, stars and embers do nothing to
 * a SAND medium and twelve inert rows per folder is worse than a "More" folder
 * nobody opens.
 */
export const hourglassSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'travel speed'],
    ['zoneRadius', 1, 12, 0.1, 'footprint radius'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handHeight', 0, 3, 0.01, 'hand height']
  ],
  'The beats': [
    ['seatTime', 0.05, 2, 0.01, 'seat time'],
    ['drainTime', 0.1, 6, 0.01, 'drain time'],
    ['stallTime', 0.02, 4, 0.01, 'stall time'],
    ['riseTime', 0.1, 6, 0.01, 'rise time'],
    ['settleTime', 0.1, 6, 0.01, 'settle time']
  ],
  'The silhouette': [
    ['waistHeight', 0.1, 2.5, 0.01, 'neck height ×R'],
    ['bulbRadius', 0.1, 2.5, 0.01, 'bulb radius ×R'],
    ['bulbHeight', 0.1, 3, 0.01, 'bulb length ×R'],
    ['bulbEmpty', 0, 0.5, 0.005, 'bulb left at full drain'],
    ['pileFill', 0.1, 1.2, 0.01, 'heap reach toward the neck'],
    ['pileMax', 0.1, 2.5, 0.01, 'heap radius cap ×R'],
    ['reposeAngle', 12, 65, 0.5, 'angle of repose (deg)'],
    ['neckRadius', 0.01, 1, 0.005, 'throat radius (m)'],
    ['seedFill', 0, 1, 0.01, 'glass while travelling'],
    ['hullSlack', 1, 2, 0.01, 'proxy hull slack']
  ],
  'The inversion': [
    ['gravityRadius', 0.2, 6, 0.01, 'well radius ×R'],
    ['gravityEdge', 0.01, 1, 0.01, 'well edge'],
    ['gravityInside', -2, 2, 0.01, 'multiplier inside'],
    ['gravityOutside', -2, 2, 0.01, 'multiplier outside'],
    ['streamJet', -8, 8, 0.01, 'column axial flow (m/s)'],
    ['streamFall', -8, 8, 0.01, 'column vertical flow (m/s)'],
    ['settleJet', -8, 8, 0.01, 'heap axial flow (m/s)'],
    ['settleFall', -8, 8, 0.01, 'heap vertical flow (m/s)'],
    ['scourTurn', -3, 3, 0.01, 'groove rotation (rad/s)']
  ],
  ...volumeHullSchema('sand', {
    label: 'Falling sand',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'colour']
  }),
  ...volumeHullSchema('dune', {
    label: 'The heap',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'colour']
  }),
  'The floor': [
    ['scourSpread', 0.2, 3, 0.01, 'radius ×R'],
    ['scourEdge', 0.05, 3, 0.01, 'front feather (m)'],
    ['scourRagged', 0, 1, 0.01, 'front wander'],
    ['scourRaggedScale', 0.05, 3, 0.01, 'lobes / metre'],
    ['scourWarp', 0, 3, 0.01, 'lobe warp (m)'],
    ['scourDepth', 0, 0.6, 0.005, 'groove depth (m)'],
    ['scourLift', 0, 0.4, 0.005, 'drift height (m)'],
    ['scourArms', 1, 32, 1, 'grooves'],
    ['scourSwirl', -2, 2, 0.01, 'spiral pitch'],
    ['scourSharp', 0, 1, 0.01, 'groove sharpness'],
    ['scourDetail', 0, 1, 0.01, 'grain'],
    ['scourRelief', 0, 3, 0.01, 'relief'],
    ['scourNormalStep', 0.005, 0.4, 0.005, 'normal step (m)'],
    ['scourAmbient', 0, 1, 0.01, 'ambient'],
    ['scourWrap', 0, 1, 0.01, 'terminator wrap'],
    ['scourSpecular', 0, 2, 0.01, 'specular'],
    ['scourGloss', 1, 90, 1, 'gloss'],
    ['scourParallax', 0, 2, 0.01, 'parallax (m)'],
    ['scourEmissive', 0, 4, 0.01, 'emissive'],
    ['scourTurnGlow', 1, 6, 0.01, 'emissive × at the stall'],
    ['scourOpacity', 0, 1, 0.01, 'opacity'],
    ['scourHeight', 0, 0.3, 0.002, 'float above floor (m)'],
    ['scourDepthFade', 0.05, 2, 0.01, 'soft fade (m)'],
    ['colorScourBase', 'drift'],
    ['colorScourEdge', 'ridges'],
    ['colorScourGlow', 'front'],
    ['colorScourDeep', 'groove floor']
  ],
  'The grains': [
    ['grainRate', 0, 1200, 1, 'grain rate'],
    ['grainSize', 0.005, 0.4, 0.005, 'grain size'],
    ['grainSpeed', 0, 8, 0.05, 'throat speed (m/s)'],
    ['grainLifetime', 0.1, 5, 0.01, 'grain lifetime'],
    ['grainGravity', -40, 0, 0.1, 'gravity (m/s²)'],
    ['grainSpin', 0, 20, 0.1, 'tumble (rad/s)'],
    ['grainSpread', 0, 1, 0.01, 'throat spread'],
    ['grainBurst', 0, 800, 1, 'grains on the turn'],
    ['colorGrain*', 'Grain colour']
  ],
  'Dust & motes': [
    ['dustRate', 0, 400, 1, 'dust rate'],
    ['dustSize', 0.05, 3, 0.01, 'dust size'],
    ['dustSpeed', 0, 6, 0.05, 'dust speed'],
    ['dustLifetime', 0.1, 8, 0.05, 'dust lifetime'],
    ['dustRise', -4, 6, 0.01, 'dust buoyancy'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['dustSpread', 0, 3, 0.01, 'dust scatter (m)'],
    ['moteRate', 0, 500, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 6, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -4, 6, 0.01, 'mote buoyancy'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['moteGlow', 0, 6, 0.01, 'mote glow'],
    ['moteShell', 0.2, 4, 0.01, 'mote shell ×bulb radius'],
    ['colorDust*', 'Dust colour'],
    ['colorMote*', 'Mote colour']
  ],
  'Seat, telegraph & turn': [
    ['seatBurstSize', 0.1, 8, 0.05, 'seat shell (m)'],
    ['seatBurstIntensity', 0, 4, 0.01, 'seat intensity'],
    ['warnAt', 0.05, 0.95, 0.01, 'telegraph trigger'],
    ['warnBurstSize', 0.1, 10, 0.05, 'telegraph shell (m)'],
    ['warnBurstIntensity', 0, 4, 0.01, 'telegraph intensity'],
    ['warnRingRadius', 0.5, 20, 0.1, 'telegraph ring (m)'],
    ['warnRingIntensity', 0, 3, 0.01, 'telegraph ring intensity'],
    ['warnFlash', 0, 1, 0.01, 'telegraph flash'],
    ['turnBurstSize', 0.1, 14, 0.05, 'turn shell (m)'],
    ['turnBurstIntensity', 0, 4, 0.01, 'turn intensity'],
    ['turnRingRadius', 0.5, 26, 0.1, 'turn ring (m)'],
    ['turnRingIntensity', 0, 3, 0.01, 'turn ring intensity'],
    ['turnFlash', 0, 2, 0.01, 'turn flash'],
    ['seatShake', 0, 3, 0.01, 'seat shake'],
    ['turnShake', 0, 3, 0.01, 'turn shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.5, 0.005, 'running rumble'],
    ['colorSeatA', 'seat shell'],
    ['colorSeatB', 'seat body'],
    ['colorSeatC', 'seat crest'],
    ['colorWarnA', 'telegraph shell'],
    ['colorWarnB', 'telegraph body'],
    ['colorWarnC', 'telegraph crest'],
    ['colorTurnA', 'turn shell'],
    ['colorTurnB', 'turn body'],
    ['colorTurnC', 'turn crest'],
    ['colorWarnFlash', 'telegraph flash colour'],
    ['colorTurnFlash', 'turn flash colour'],
    ['colorRingA', 'floor ring'],
    ['colorRingB', 'floor ring crest']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightSwell', 0, 3, 0.01, 'swell at the stall'],
    ['lightFlicker', 0, 1, 0.01, 'breathing depth'],
    ['lightTickRate', 0.5, 30, 0.1, 'breathing rate (rad/s)'],
    ['lightColor', 'light colour']
  ]
};
