import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* DRAGONBREATH — Wyrm's Breath, a real cone volume                    */
/* ================================================================== */
/**
 * A line cast, sustained. The apex is at the caster's hand, the mouth is out at
 * the target, and what is in between is a **raymarched cone** rather than a
 * widening billboard: `flameHollow` moves the density peak off the axis, so the
 * gout is a sheath with unburnt air down the middle and orbiting the cast shows
 * you the far wall of the tongue through the near one.
 *
 * ### The two numbers that make or break it
 *
 * `flameHollow` is the trick. At 0 the cone is solid and reads as a cardboard
 * megaphone from every angle — there is nothing to see *through*, so no amount
 * of turbulence stops it looking like a decal. Around 0.45 the peak sits
 * halfway out to the wall and the middle goes empty, which is what a real
 * nozzle does: fuel burns at the shear layer, not in the core.
 *
 * `flameJet` is the sustain. It slides the noise domain backwards along the
 * hull's own +Z, so features travel *outward* at that many metres per second.
 * `Medium.FLAME` samples in `localDomain()` — hull space — precisely so this
 * works: the turbulence belongs to the jet and yaws with the caster instead of
 * being swum through. (Pyroclasm needs the exact opposite and says so.)
 *
 * ### Reach
 *
 * `reach` is a live multiplier on the cast's own distance, and it is the number
 * every downstream metre is derived from: the hull's three half-extents, the
 * scorch's length, the tongues' start and overshoot, where the light sits.
 * Dragging it mid-cast shortens the gout **and pulls the floor burn back in
 * with it**, which is the one thing a spawned decal could never do.
 *
 * The eight `flameBoil*` / one `flameVoid*` keys, and the four `flameSpeck*`,
 * belong to other media and are inert here — see the note above
 * `dragonbreathSchema`.
 */
export const dragonbreath = {
  /* --- the cast --- */
  range: 17.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 96.0, // how fast the gout reaches the mouth, metres/second
  cooldown: 1.6, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the cone is pinned --- */
  handForward: 0.7, // metres in front of the caster the apex sits
  handSide: 0.18, // metres to the side (+ follows `Ability#side`)
  handHeight: 1.35, // metres above the floor
  endHeight: 0.55, // height of the mouth's centre at the target, metres

  /* --- the beats --- */
  sustainTime: 1.15, // seconds the gout is held at full reach
  fadeTime: 0.75, // seconds it takes to gutter out

  /* --- the cone --- */
  reach: 1.0, // × the cast distance — the live length of the gout
  dieback: 0.34, // × reach — how far it pulls back in as it guts out
  coneFlare: 0.24, // mouth half-width ÷ span; 0.24 is roughly a 27° cone
  coneSquash: 0.82, // mouth half-height ÷ half-width; a breath is wider than tall
  coneSlack: 1.06, // extra proxy-hull headroom past the margin compensation

  /* --- the flame volume (Medium.FLAME, prefix `flame`) --- */
  // Emissive, so no self-shadow taps: the medium radiates and there is nothing
  // for a key light to give it. That halves the march cost, which is what pays
  // for 38 steps on a hull this close to the camera.
  ...volumeHullDefaults('flame', Medium.FLAME, {
    flameSteps: 38, // march steps
    flameJitter: 1.0, // step dither; 0 only ever shows you the banding
    flameContact: 0.8, // metres of fade where the flame meets the floor
    flameMargin: 0.3, // headroom inside the hull — paired with NoiseStrength
    flameHollow: 0.46, // THE TRICK: how far off-axis the density peak sits, 0..0.9
    flameThroat: 0.16, // fraction of the span the cone opens over at the apex
    flameFeather: 0.3, // feather on the mouth
    flameHeightBias: 0.0, // unused on a cone; the hull is not standing on the floor
    flameDensity: 2.6, // density
    flameDensityCurve: 1.15, // density curve
    flameSoftness: 0.34, // edge softness
    flameNoiseFrequency: 2.2, // features per metre
    flameNoiseStrength: 1.0, // erosion — raise this and you owe flameMargin
    flameNoiseWarp: 0.38, // domain warp
    flameOctaves: 4, // octaves
    flameJet: 7.5, // metres/second the flow crawls along the hull axis, outward
    flameRise: 0.9, // buoyant rise, metres/second
    flameSwirl: 0.6, // roll about the cone axis, radians/second
    flameAbsorption: 0.85, // absorption, 1/metre
    flameScatter: 0.35, // scattering
    flameAmbient: 0.1, // multi-scatter floor
    flameAnisotropy: 0.45, // forward scatter
    flameEmission: 7.5, // emission — this is what a flame lives on
    flameEmissionCurve: 1.4, // emission by density
    flameShadowTaps: 0, // emissive media need none, and the shader is built without them
    flameOpacity: 1.0
  }),

  /* --- the floor burn, growing along the cone's ground intersection --- */
  // GroundMode.RUT: a track with a live `length` and a live `progress`, which is
  // the only mode in `GroundField` whose front runs *down* something rather than
  // out from a centre. A cone's ground intersection is a wedge and none of the
  // ten modes draws a wedge, so the widening is carried by the contact-force
  // samples instead — see `markNear`.
  scorchWidth: 0.72, // track half-width, × the mouth half-width
  scorchEdge: 0.55, // metres the ends of the track are capped over
  scorchDepth: 0.05, // metres — a burn barely digs; the colour does the work
  scorchLift: 0.03, // metres of spoil piled either side
  scorchThickness: 0.22, // metres — width of that spoil band
  scorchSeam: 0.9, // metres over which one contact sample blends into the next
  scorchCell: 0.85, // metres — pitch of the chatter along the track
  scorchWander: 0.18, // metres the track drifts laterally; a breath does not slalom
  scorchRaggedScale: 0.5, // lobes per metre on that drift
  scorchSharp: 0.35, // 0 soft-edged burn, 1 knife-edged
  scorchDetail: 0.55, // grain
  scorchRelief: 0.5, // how hard the height field tilts the fake normal
  scorchNormalStep: 0.06, // metres between the height taps
  scorchAmbient: 0.24, // floor on the diffuse term
  scorchWrap: 0.55, // wraps the terminator round the back
  scorchSpecular: 0.3, // vitrified stone has a sheen
  scorchGloss: 26.0, // Blinn exponent
  scorchParallax: 0.12, // metres of view-driven offset on the interior detail
  scorchEmissive: 1.25, // multiplier on every glowing term
  scorchOpacity: 0.96,
  scorchHeight: 0.02, // metres the quad floats above the floor
  scorchDepthFade: 0.4, // metres of soft fade against anything standing in it
  markRate: 1.1, // contact samples posted per metre of front travel
  markNear: 0.28, // contact force at the caster's feet, 0..1 — the wedge, faked
  colorScorchBase: '#2c211a', // the burnt stone
  colorScorchEdge: '#8a5a2e', // the spoil either side
  colorScorchGlow: '#ff7a1e', // the burning front
  colorScorchDeep: '#0e0705', // the bottom of the track

  /* --- the licking tongues at the front edge --- */
  // One FilamentPaths role, two draw calls whatever the count. They are pinned
  // loosely (`tongueConverge` well below 1) so their far ends flail past the
  // mouth instead of arriving on it — that looseness is the entire read.
  tongueCount: 7, // filaments (the strip's capacity caps at 48)
  tongueStart: 0.52, // where they leave the axis, × the span
  tongueOvershoot: 1.22, // where they aim, × the span — past the volume
  tongueNear: 0.35, // metres they are fanned at `tongueStart`
  tongueFan: 1.35, // × the mouth half-width — how far they are fanned at the far end
  tongueSpreadCurve: 1.5, // >1 keeps them tight then flares them late
  tongueSag: 0.18, // metres of upward bow at mid-span; negative droops
  tongueTwist: 0.35, // turns of roll from end to end
  tongueTwistSpeed: 0.55, // turns/second the whole fan rolls
  tongueConverge: 0.18, // 0..1 — how hard the far end is pinned to the target
  tongueLickBase: 0.86, // mean fraction of the path that is drawn
  tongueLickDepth: 0.26, // ± on that, so they periodically outrun the volume
  tongueLickSpeed: 5.4, // licks per second
  tongueTipLength: 0.16, // fraction of the path the front is smeared over
  tongueTipGlow: 2.6, // extra heat on that front
  tongueFadeStart: 0.9, // 0 square, 1 faded to nothing, at the apex end
  tongueFadeEnd: 1.0, // ... and at the tip
  tongueTaperStart: 0.85, // the same for the ribbon's width
  tongueTaperEnd: 1.0,
  tongueKink: 1.2, // per-role multiplier on the shared jitter
  tongueWidthScale: 1.0, // per-role multiplier on the shared width
  tongueDim: 1.0, // 0..1 how secondary the role is
  tongueGroundDamp: 1.0, // 1 in the air; drop it toward 0.3 for anything flat
  tongueFloor: 0.06, // metres the tongues are clamped above the floor
  /* the shared ribbon look (`filamentLook()`'s vocabulary, all of it authored) */
  tongueWidth: 0.05, // half-width of the core ribbon, metres
  tongueGlowWidth: 5.4, // halo half-width, × the core width
  tongueGlowOpacity: 0.5, // halo alpha relative to the core
  tongueJitter: 0.42, // metres of lateral kink at the coarsest octave
  tongueJitterScale: 1.1, // kinks per metre
  tongueOctaves: 4, // 1–5
  tongueJitterFalloff: 0.55, // amplitude kept per octave
  tongueCrawl: 4.2, // how fast the kinks slide along, per second
  tonguePinch: 0.2, // fraction of the path the kink eases in over at each end
  tongueRestrike: 13, // whole re-shapes per second
  tongueFlicker: 0.3, // depth of the whole-bundle brightness stutter
  tongueFlickerSpeed: 22, // stutters/second
  tongueStrandFlash: 0.55, // depth of the per-filament blink
  tongueCoreSharp: 3.4, // exponent on the core's edge falloff
  tongueGlowFalloff: 2.2, // the same for the halo
  tongueSoftFade: 0.6, // metres of depth fade against the opaque scene
  tongueOpacity: 1.0,
  tongueGlow: 2.6, // emissive gain fed into bloom
  colorTongueCore: '#fff6d8', // the white-hot centre line
  colorTongueInner: '#ffc65a',
  colorTongueOuter: '#ff5a14',
  colorTongueHalo: '#5a1404', // the wide, dim atmosphere

  /* --- embers streaming out of the mouth --- */
  emberRate: 260, // particles/second
  emberSize: 0.13,
  emberSpeed: 13.0, // metres/second
  emberLifetime: 0.85, // seconds
  emberGravity: -6.0, // metres/second²
  emberStretch: 0.22, // how far a spark smears along its velocity
  emberSpread: 0.55, // 0..1 cone of the initial scatter
  emberGlow: 2.2,
  colorEmberA: '#fff2c0',
  colorEmberB: '#ffb03a',
  colorEmberC: '#e0400f',
  colorEmberD: '#2a0a04',

  /* --- burning fuel falling out of the cone --- */
  dripRate: 34, // particles/second
  dripSize: 0.12,
  dripSpeed: 2.2, // metres/second
  dripLifetime: 1.3, // seconds
  dripGravity: -9.5, // metres/second²
  dripTurbulence: 0.5,
  dripGlow: 2.8,
  dripSeat: 0.65, // where along the span they come off, as a fraction
  colorDripA: '#fff2c0',
  colorDripB: '#ffb03a',
  colorDripC: '#c03408',
  colorDripD: '#2a0a04',

  /* --- smoke off the burnt floor --- */
  smokeRate: 58, // particles/second
  smokeSize: 1.05,
  smokeSpeed: 1.6, // metres/second
  smokeLifetime: 2.6, // seconds
  smokeRise: 1.0, // metres/second²
  smokeOpacity: 0.16,
  colorSmokeA: '#4a3b32',
  colorSmokeB: '#332721',
  colorSmokeC: '#221a16',
  colorSmokeD: '#140f0c',

  /* --- the punctuation --- */
  muzzleSize: 1.1, // the flare at the hand as the breath starts, metres
  muzzleIntensity: 2.0,
  castFlash: 0.13, // screen flash on release
  impactFlash: 0.16, // ... as the gout reaches the mouth
  mouthBurstSize: 3.2, // the shell of burning air at the mouth, metres
  mouthBurstIntensity: 1.6,
  mouthBurstRate: 3.4, // shells shed per second while the breath is sustained
  impactShake: 0.35,
  shakeDuration: 0.5, // seconds
  rumble: 0.055, // continuous shake while the breath is held
  colorBurstA: '#e0400f',
  colorBurstB: '#ffb03a',
  colorBurstC: '#fff2c0',
  colorCastFlash: '#ffb03a',
  colorFlash: '#fff2c0', // the full-screen flash when the gout lands

  /* --- dynamic light --- */
  lightIntensity: 30, // the gout is the brightest thing in the room
  lightRadius: 20, // metres
  lightSpan: 0.62, // where the light sits along the cone, 0 apex .. 1 mouth
  lightColor: '#ff8a20'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Wyrm's Breath.
 *
 * Reach for `flameHollow` first — it is the difference between a cone you can
 * see through and a painted megaphone — and then `flameJet`, which is how fast
 * the sustain crawls. `coneFlare` and `reach` between them decide the whole
 * silhouette. If the flame ends on a dead straight line, that is
 * `flameNoiseStrength` against `flameMargin`, as always.
 *
 * The `flameBoil*`, `flameVoid*` and `flameSpeck*` keys are not filed here on
 * purpose. `volumeHullDefaults` emits the whole vocabulary so the hull's own
 * audit stays quiet, but bubbles, stars and extra occlusion do nothing to a
 * FLAME medium, and thirteen inert rows is worse than a "More" folder nobody
 * opens.
 */
export const dragonbreathSchema = {
  'The cast': [
    ['range', 3, 50, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 300, 1, 'gout speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation'],
    ['sustainTime', 0.05, 6, 0.01, 'sustain'],
    ['fadeTime', 0.05, 4, 0.01, 'gutter out']
  ],
  'Where the cone is pinned': [
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['endHeight', 0, 4, 0.01, 'mouth height']
  ],
  'The cone': [
    ['reach', 0.1, 1.6, 0.01, 'reach ×cast distance'],
    ['dieback', 0.05, 1, 0.01, 'die-back ×reach'],
    ['coneFlare', 0.02, 0.8, 0.005, 'flare (half-width ÷ span)'],
    ['coneSquash', 0.2, 2, 0.01, 'mouth squash'],
    ['coneSlack', 1, 2, 0.01, 'proxy hull slack']
  ],
  ...volumeHullSchema('flame', {
    label: 'Flame',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'colour']
  }),
  'Floor burn': [
    ['scorchWidth', 0.1, 3, 0.01, 'half-width ×mouth'],
    ['scorchEdge', 0.05, 3, 0.01, 'end cap (m)'],
    ['scorchDepth', 0, 0.6, 0.005, 'gouge depth (m)'],
    ['scorchLift', 0, 0.3, 0.005, 'spoil height (m)'],
    ['scorchThickness', 0.01, 1, 0.005, 'spoil width (m)'],
    ['scorchSeam', 0.05, 4, 0.01, 'force blend (m)'],
    ['scorchCell', 0.05, 4, 0.01, 'chatter pitch (m)'],
    ['scorchWander', 0, 2, 0.01, 'track wander'],
    ['scorchRaggedScale', 0.05, 3, 0.01, 'wander scale'],
    ['scorchSharp', 0, 1, 0.01, 'edge sharpness'],
    ['scorchDetail', 0, 1, 0.01, 'grain'],
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
    ['markRate', 0.05, 6, 0.05, 'contact samples / metre'],
    ['markNear', 0, 1, 0.01, 'force at the caster'],
    ['colorScorchBase', 'burnt stone'],
    ['colorScorchEdge', 'spoil'],
    ['colorScorchGlow', 'burning front'],
    ['colorScorchDeep', 'track floor']
  ],
  'Licking tongues': [
    ['tongueCount', 0, 24, 1, 'filaments'],
    ['tongueStart', 0, 1, 0.01, 'start ×span'],
    ['tongueOvershoot', 0.2, 2, 0.01, 'aim ×span'],
    ['tongueNear', 0, 2, 0.01, 'fan at the start (m)'],
    ['tongueFan', 0, 4, 0.01, 'fan at the tip ×mouth'],
    ['tongueSpreadCurve', 0.2, 5, 0.01, 'fan curve'],
    ['tongueSag', -2, 2, 0.01, 'mid-span bow (m)'],
    ['tongueTwist', -4, 4, 0.01, 'twist over length'],
    ['tongueTwistSpeed', -6, 6, 0.01, 'twist speed'],
    ['tongueConverge', 0, 1, 0.01, 'lock onto the target'],
    ['tongueLickBase', 0.1, 1.6, 0.01, 'mean draw'],
    ['tongueLickDepth', 0, 1, 0.01, 'lick depth'],
    ['tongueLickSpeed', 0, 20, 0.1, 'licks / second'],
    ['tongueTipLength', 0.005, 0.6, 0.005, 'tip smear'],
    ['tongueTipGlow', 0, 8, 0.05, 'tip glow'],
    ['tongueFadeStart', 0, 1, 0.01, 'fade at the apex'],
    ['tongueFadeEnd', 0, 1, 0.01, 'fade at the tip'],
    ['tongueTaperStart', 0, 1, 0.01, 'taper at the apex'],
    ['tongueTaperEnd', 0, 1, 0.01, 'taper at the tip'],
    ['tongueKink', 0, 4, 0.01, 'kink ×'],
    ['tongueWidthScale', 0, 4, 0.01, 'width ×'],
    ['tongueDim', 0, 1, 0.01, 'role dim'],
    ['tongueGroundDamp', 0, 1, 0.01, 'ground damp'],
    ['tongueFloor', -1, 2, 0.01, 'floor clamp (m)']
  ],
  'Licking tongues/Ribbon': [
    ['tongueWidth', 0.005, 0.6, 0.005, 'core half-width (m)'],
    ['tongueGlowWidth', 1, 30, 0.1, 'halo width ×'],
    ['tongueGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['tongueJitter', 0, 3, 0.01, 'kink amplitude (m)'],
    ['tongueJitterScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['tongueOctaves', 1, 5, 1, 'octaves'],
    ['tongueJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['tongueCrawl', -20, 20, 0.1, 'kink crawl'],
    ['tonguePinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['tongueRestrike', 0.5, 90, 0.5, 'restrikes / sec'],
    ['tongueFlicker', 0, 1, 0.01, 'brightness stutter'],
    ['tongueFlickerSpeed', 1, 120, 1, 'stutter rate'],
    ['tongueStrandFlash', 0, 1, 0.01, 'filament blink'],
    ['tongueCoreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['tongueGlowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['tongueSoftFade', 0.02, 3, 0.01, 'soft intersection (m)'],
    ['tongueOpacity', 0, 2, 0.01, 'opacity'],
    ['tongueGlow', 0, 8, 0.01, 'glow'],
    ['colorTongueCore', 'core'],
    ['colorTongueInner', 'inner'],
    ['colorTongueOuter', 'outer'],
    ['colorTongueHalo', 'halo']
  ],
  'Embers & drips': [
    ['emberRate', 0, 1200, 1, 'ember rate'],
    ['emberSize', 0.005, 0.8, 0.005, 'ember size'],
    ['emberSpeed', 0, 40, 0.1, 'ember speed'],
    ['emberLifetime', 0.05, 4, 0.01, 'ember lifetime'],
    ['emberGravity', -50, 5, 0.1, 'ember gravity'],
    ['emberStretch', 0, 3, 0.01, 'ember stretch'],
    ['emberSpread', 0, 1, 0.01, 'ember spread'],
    ['emberGlow', 0, 8, 0.01, 'ember glow'],
    ['colorEmber*', 'Ember colour'],
    ['dripRate', 0, 300, 1, 'drip rate'],
    ['dripSize', 0.005, 0.6, 0.005, 'drip size'],
    ['dripSpeed', 0, 12, 0.05, 'drip speed'],
    ['dripLifetime', 0.1, 6, 0.05, 'drip lifetime'],
    ['dripGravity', -40, 0, 0.1, 'drip gravity'],
    ['dripTurbulence', 0, 3, 0.01, 'drip turbulence'],
    ['dripGlow', 0, 8, 0.01, 'drip glow'],
    ['dripSeat', 0, 1.2, 0.01, 'drip seat ×span'],
    ['colorDrip*', 'Drip colour']
  ],
  'Smoke': [
    ['smokeRate', 0, 400, 1, 'smoke rate'],
    ['smokeSize', 0.05, 4, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime'],
    ['smokeRise', -2, 5, 0.01, 'smoke rise'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['colorSmoke*', 'Smoke colour']
  ],
  'Muzzle & mouth': [
    ['muzzleSize', 0.05, 8, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['impactFlash', 0, 2, 0.01, 'flash on arrival'],
    ['mouthBurstSize', 0.2, 14, 0.05, 'mouth shell size'],
    ['mouthBurstIntensity', 0, 5, 0.01, 'mouth shell intensity'],
    ['mouthBurstRate', 0, 20, 0.1, 'mouth shells / sec'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.5, 0.005, 'sustain rumble'],
    ['colorBurstA', 'shell body'],
    ['colorBurstB', 'shell mid'],
    ['colorBurstC', 'shell arcs'],
    ['colorCastFlash', 'release flash colour'],
    ['colorFlash', 'arrival flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 140, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 60, 0.1, 'light radius'],
    ['lightSpan', 0, 1.4, 0.01, 'light along the cone'],
    ['lightColor', 'light colour']
  ]
};
