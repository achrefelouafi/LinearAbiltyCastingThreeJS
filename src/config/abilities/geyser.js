/* ================================================================== */
/* GEYSER — Geyser                                                     */
/* ================================================================== */
/**
 * A vent opens on the aimed circle, a column of water stands out of it, and
 * when the pressure fails the column comes back down as rain.
 *
 * **The block is arranged around one identity: the rain is the column.** Every
 * number the droplets fly on is *derived* from the column's own geometry and
 * its own speed, resolved on the frame it is used:
 *
 *  - they are born at `jetHeight × seedAt` metres, which is where
 *    `Tube.pointAt(seedAt)` puts the column's axis;
 *  - they are scattered over `Tube.radiusAt(seedAt)` metres, which is how wide
 *    the column *is* at that height — so widening `jetMouthFlare` widens the
 *    cloud they leave from;
 *  - they carry `columnSpeed × pressure` metres per second of upward velocity,
 *    so they climb `v²/2g` further before they turn over;
 *  - they carry `2π × jetSpin × radiusAt(seedAt) × swirlCarry` metres per
 *    second of tangential velocity, so the ring they land in is the swirl the
 *    column had, thrown outward for the whole of the fall.
 *
 * There is **no `rainRadius` slider and no `dropFlightTime` slider**, and there
 * must not be. Both are computed — the ring from the inherited speed and the
 * fall time from `sqrt(2h/g)` — because the first version of this block had
 * them as their own numbers and they were never the same as the column twice:
 * every time the plume was retuned the rain landed either inside the pool or
 * out in dry floor, and nobody could see why. `gravity` is the slider they are
 * both a function of, and it is the one to reach for.
 *
 * **The funnel is inverted, and that is a profile rather than a transform.**
 * `vfx/Tube.js` in `FUNNEL` mode is written for a tornado: a wide intake mouth
 * at the top, a waist, and a skirt flaring out where it touches the floor. A
 * geyser is that silhouette upside down, so `jetSkirtFlare` is tiny (a tight
 * collar around the vent bore) and `jetMouthFlare` is large with a low
 * `jetMouthStart` (a trumpet opening almost from the ground). Everything else
 * about the module then works in the ability's favour without being fought:
 * `jetSwayCurve` above 1 weights the precession to the *top*, so the head of
 * the plume whips while the vent stays planted, which is exactly right.
 * Rotating the tube end-for-end instead would have put the sway at the vent.
 */
import { TubePath, tubeDefaults, tubeSchema } from '../../vfx/Tube.js';

export const geyser = {
  /* --- the cast --- */
  range: 21.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  speed: 34.0, // how fast the cast reaches the circle, metres/second
  zoneRadius: 6.0, // the vent pool, metres — the rain lands inside it
  lifetime: 3.4, // seconds from the vent opening to the end of the beat
  fadeTime: 2.6, // seconds the pool takes to settle once the rain is down
  cooldown: 2.2, // seconds before the slot re-arms
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats --- */
  preFill: 0.35, // 0..1 of the pool that has welled up before the vent blows
  ventRise: 0.4, // seconds the pool takes to open out once it has
  chargeTime: 0.4, // seconds the column takes to reach full height
  holdTime: 0.7, // seconds it holds at full pressure before it fails
  collapseTime: 0.9, // seconds the column takes to fall back into the vent
  surge: 0.12, // ± fraction the pressure breathes by while it holds
  surgeRate: 2.3, // Hz it breathes at

  /* --- the column --- */
  jetHeight: 7.6, // metres from the pool surface to the head of the plume
  jetBase: 0.02, // metres the foot floats above the pool surface
  jetTaper: 0.22, // width multiplier at the end of the collapse, 0..1
  lightRide: 0.3, // where on the column the dynamic light sits, 0..1
  lightHeight: 0.0, // extra metres above that

  /* ------------------------------------------------------------------ */
  /* The column — vfx/Tube.js, prefix `jet`, path FUNNEL (inverted)      */
  /* ------------------------------------------------------------------ */
  /**
   * `jetThroat + jetSkirtFlare` is the vent bore (0.70 m shipped) and
   * `jetThroat + jetMouthFlare` is the head of the plume (2.32 m). The ratio of
   * those two sums *is* the inversion; make them equal and this is a pipe.
   *
   * `jetThrob` is deliberately small. It is a real pressure pulse and it moves
   * `radiusAt()`, which the rain's launch scatter and landing ring are both
   * read off — so at the shipped 0.035 the ring breathes by about eleven
   * centimetres out of four and a half metres and nobody sees it, and at 0.2
   * ninety-six drops visibly pump in and out together. That lockstep is the
   * tell; the pulse itself is fine.
   */
  ...tubeDefaults('jet', TubePath.FUNNEL, {
    jetThroat: 0.42, // the bore, metres
    jetSkirtFlare: 0.28, // the collar at the vent, metres — small: this is the inversion
    jetSkirtHeight: 0.12, // how far up that collar reaches, fraction of height
    jetSkirtCurve: 2.4, // >1 keeps it tight to the vent
    jetMouthFlare: 1.9, // the plume at the top, metres
    jetMouthStart: 0.18, // it opens almost from the ground — a trumpet, not a funnel
    jetMouthCurve: 1.15, // how abruptly it opens
    jetSpin: 0.45, // revolutions/second the surface rotates — the swirl the rain inherits
    jetSpinTwist: 0.9, // extra revolutions from vent to head
    jetSway: 0.28, // how far the axis precesses, metres
    jetSwayScale: 0.35, // twist of the precession along the height
    jetSwaySpeed: 0.22, // revolutions/second it precesses
    jetSwayCurve: 2.4, // >1 whips the head and plants the vent
    jetThrob: 0.035, // pressure pulses, × radius — small, and see the note below
    jetThrobScale: 3.2, // waves along the column, cycles per length
    jetThrobSpeed: 2.4, // Hz they travel at
    jetWander: 0.06, // smooth drift of the axis, metres
    jetWanderScale: 1.1,
    jetWanderSpeed: 0.7,
    jetRipple: 0.2, // radial break-up of the barrel, × radius
    jetRippleBands: 1.8,
    jetRippleScale: 3.0,
    jetRippleSpeed: 2.0,
    jetStreak: 1.1, // filaments streaming up the surface
    jetStreakSharp: 0.55,
    jetStreakScale: 4.5,
    jetStreakBands: 3.0,
    jetStreakGlow: 1.3,
    jetFlowSpeed: 6.5, // positive: the surface runs UP, which is the whole read
    jetCoreWidth: 0.7, // a column of water is nearly all body
    jetCoreFill: 0.35,
    jetSheathWidth: 1.0,
    jetSheathRim: 1.0,
    jetHaloWidth: 1.35,
    jetHaloRim: 2.4,
    jetHaloOpacity: 0.45,
    jetMuzzleGlow: 2.0, // the vent is the brightest part of it
    jetMuzzleLength: 0.14,
    jetTipGlow: 1.4,
    jetTipLength: 0.12,
    jetGlow: 1.1,
    jetSoftFade: 0.5,
    jetColorCore: '#ffffff',
    jetColorInner: '#d8f8ff',
    jetColorOuter: '#4fc4dc',
    jetColorHalo: '#0d3a4e'
  }),

  /* ------------------------------------------------------------------ */
  /* The rain — the column, in the air                                   */
  /* ------------------------------------------------------------------ */
  droplets: 96, // bodies seeded when the pressure fails (capped at 128)
  seedAt: 0.8, // 0..1 up the column — where the water tears off
  gravity: 9.81, // metres/second². Drives the apex, the fall time and the ring.
  columnSpeed: 5.0, // metres/second the water is going up at full pressure
  swirlCarry: 0.22, // 0..1 of the column's tangential speed that survives the tear
  spreadSpeed: 0.3, // metres/second of extra outward push at the head
  dropRadius: 0.085, // metres
  dropSizeJitter: 0.4, // ± fraction
  dropStretch: 1.8, // scale along the heading — a falling drop is not a sphere
  // At 1.0 the alignment is total — `Projectile` slerps the tumble all the way
  // to the heading, which is right for a drop (a falling drop does not tumble,
  // it points where it is going) and which makes `dropSpin` below inert. Back
  // `dropAlign` off to about 0.8 and the tumble comes back.
  dropAlign: 1.0, // 1 lays the body's +Y along its own heading
  dropSpin: 1.2, // radians/second of tumble — only visible below dropAlign 1
  dropFlash: 0.16, // seconds the birth pop decays over
  dropPathCurve: 1.0, // 1 is constant horizontal speed, which is what ballistics does
  dropApexCurve: 0.85, // <1 rounds the top of the arc toward a parabola
  dropWindow: 0.22, // seconds the tear is spread over — short: it lets go at once
  dropLead: 0.02, // seconds before the first drop leaves
  dropSpeedJitter: 0.18, // ± fraction of the computed fall time
  dropFillBias: -0.6, // <0 fills the ring inward from the rim
  dropFillScatter: 0.7, // 0 clean radial order, 1 pure spatial hash
  dropHashCell: 1.0, // metres of the hash lattice
  dropRingBias: 0.28, // <0.5 crowds the landing ring's rim: axis water falls straight down
  dropLinger: 0.05, // seconds a landed drop stays before it goes under
  dropSink: 1.4, // body radii it sinks over that linger
  rippleStrength: 0.9, // strength of the ripple each landing puts in the pool
  splashPerDrop: 5, // spray particles thrown at each landing

  /* --- the drop's trail --- */
  trailSpan: 0.18, // seconds of flight the tail reaches back over
  trailBurn: 0.14, // seconds the tail takes to catch up after landing
  trailWidth: 0.055, // metres at the head
  trailTaper: 1.7, // >1 sharpens the tail to a point
  trailLift: 0.0, // metres the tail floats above the flown path
  trailOpacity: 0.7,
  trailGlow: 1.1,
  trailCore: 2.4, // how tightly light crowds the centre line
  trailHeadBias: 0.55, // >0 keeps the brightness near the body
  trailNoise: 0.25,
  trailNoiseScale: 2.2, // features per metre
  trailNoiseSpeed: 0.8,
  trailSoftFade: 0.3, // metres of depth feather
  colorTrailA: '#ffffff',
  colorTrailB: '#c4f0fa',
  colorTrailC: '#3f9fb8',
  colorTrailD: '#0d2c38',

  /* --- the drop's body --- */
  dropFacets: 9, // sides around the lathe
  dropRings: 7, // levels up it
  dropTaper: 0.55, // 0 a sphere, 1 a full teardrop point
  dropPinch: 0.28, // how far the trailing end necks in
  colorDropClear: '#bfeef6', // the body once the air has come out of it
  colorDropFroth: '#ffffff', // the same water, white with entrained air
  colorDropSpot: '#eafcff', // the refracted hot spot on the far side
  colorDropRim: '#67d4e6', // the silhouette
  dropIor: 1.333, // refractive index. Water. Move it and watch the spot slide.
  dropSpot: 2.2, // brightness of that refracted point
  dropSpotPower: 14, // how tight it is
  dropRim: 0.9,
  dropRimPower: 2.2,
  dropFroth: 0.85, // 0..1 aeration where it tears off
  dropFrothFade: 1.3, // exponent on tau — >1 clears late
  dropAmbient: 0.35,
  dropShade: 0.7,
  dropFlashGain: 1.8,
  dropGlow: 1.2,
  dropOpacity: 1.0,
  dropSoftFade: 0.18, // metres of depth feather

  /* ------------------------------------------------------------------ */
  /* The vent pool — vfx/LiquidSurface.js                                */
  /* ------------------------------------------------------------------ */
  poolHeight: 0.05, // metres the mean plane sits above the floor
  poolOpacity: 0.95,
  round: 1.0, // 0 rectangular footprint, 1 elliptical
  edgeSoft: 0.18, // 0..1 of the field over which the waterline fades
  edgeNoise: 0.4, // 0..1 how ragged that line is
  edgeScale: 1.2, // cycles per metre of the raggedness
  contactFade: 0.28, // metres of soft fade against opaque geometry

  waveAmpA: 0.07, // metres
  waveAmpB: 0.042,
  waveAmpC: 0.026,
  waveAmpD: 0.015,
  waveLengthA: 2.9, // metres, crest to crest
  waveLengthB: 1.8,
  waveLengthC: 1.05,
  waveLengthD: 0.58,
  waveSpeedA: 1.3, // metres/second
  waveSpeedB: 1.0,
  waveSpeedC: 0.75,
  waveSpeedD: 0.5,
  waveAngleA: 0.4, // radians
  waveAngleB: 1.5,
  waveAngleC: 2.8,
  waveAngleD: 4.4,
  steepness: 0.5, // 0 sine, 1 Gerstner cusps
  chop: 0.03, // metres
  chopScale: 2.2, // cycles per metre
  chopSpeed: 0.7, // metres/second the field drifts
  detail: 0.011, // metres — fragment-only; lives in the normal
  detailScale: 8.5, // cycles per metre
  detailSpeed: 1.1, // metres/second

  rippleAmp: 0.16, // metres per unit of `rippleStrength`
  rippleSpeed: 2.9, // metres/second the front travels
  rippleLength: 0.8, // metres, crest to crest inside the packet
  rippleWidth: 0.45, // metres of the gaussian envelope
  rippleDecay: 1.1, // seconds to 1/e
  rippleSpread: 2.8, // metres over which it also thins with radius

  flowAngle: 0.0, // radians, the bulk drift's bearing
  flowSpeed: 0.15, // metres/second
  flowRadial: 1.4, // metres/second outward at the vent — this is the boil
  flowRadialFall: 2.2, // metres to 1/e
  flowEddy: 0.9, // metres/second of curl-noise swirl
  flowEddyScale: 0.5, // cycles per metre
  flowEddySpeed: 0.35, // Hz the eddies churn
  flowGravity: 2.4, // metres/second per unit of surface slope

  foam: 0.95, // 0..1 master — a vent pool is mostly foam
  foamScale: 7.0, // cycles per metre of the speckle
  foamSharp: 1.2,
  foamCrest: 1.0, // how much a rising crest seeds it
  foamSpeed: 0.9, // how much surface speed seeds it

  poolDepth: 0.4, // metres of liquid under the mean plane
  depthTint: 1.5, // Beer-Lambert density, per metre
  translucency: 1.0,
  ambient: 0.34,
  specular: 1.5,
  shininess: 80, // Blinn-Phong exponent
  fresnel: 1.2,
  envIntensity: 0.8,
  skyIntensity: 0.5,
  poolGlow: 1.0,
  normalEps: 0.042, // metres — the finite-difference step
  colorDeep: '#08303c', // the body seen through its own thickness
  colorShallow: '#2497a8', // the body seen thin
  colorFoam: '#eafcfb',
  colorSpec: '#ffffff',
  colorSky: '#33526a', // the floor under the reflected probe

  /* --- spray: the water shed off the column while it stands ----------- */
  sprayRate: 130, // particles/second up the column
  spraySpeed: 4.2, // metres/second
  spraySize: 0.085,
  sprayLifetime: 1.1, // seconds
  sprayGravity: -8.5, // metres/second²
  sprayTurbulence: 0.5,
  colorSprayA: '#ffffff',
  colorSprayB: '#b8eef8',
  colorSprayC: '#3f9cb4',
  colorSprayD: '#0f2f3c',

  /* --- steam: the boil, and what the vent breathes out ---------------- */
  steamRate: 46, // puffs/second
  steamSpeed: 1.6, // metres/second
  steamSize: 0.9,
  steamLifetime: 2.4, // seconds
  steamRise: 1.1, // metres/second² upward
  steamOpacity: 0.4,
  colorSteamA: '#ffffff',
  colorSteamB: '#cfe6ec',
  colorSteamC: '#7e9aa6',
  colorSteamD: '#2a3a44',

  /* --- grit: what the vent throws up with the water ------------------- */
  gritRate: 22, // chips/second
  gritSpeed: 5.5, // metres/second
  gritSize: 0.06,
  gritLifetime: 1.5, // seconds
  gritGravity: -11.0, // metres/second²
  colorGritA: '#8f9aa0',
  colorGritB: '#6a767e',
  colorGritC: '#3e4850',
  colorGritD: '#171d22',

  /* --- feedback -------------------------------------------------------- */
  burstSize: 2.4, // metres, the shell of spray as the vent opens
  burstIntensity: 1.2,
  colorBurstA: '#ffffff',
  colorBurstB: '#9fe8f4',
  colorBurstC: '#12586e',
  shockRadius: 5.2, // metres, the ring across the floor
  colorShockA: '#dcfbff',
  colorShockB: '#1c7288',
  wetMarks: 9, // wet stains left outside the waterline
  wetRadius: 1.3, // metres each
  wetLife: 6.5, // seconds
  wetIntensity: 0.7,
  colorWet: '#0d3540',
  colorWetEdge: '#5fc4d0',
  ventShake: 0.4, // camera punch as the vent opens
  shakeDuration: 0.5, // seconds it decays over
  rumble: 0.17, // continuous shake while the column stands
  ventFlash: 0.22,
  colorFlash: '#a4ecf8',

  /* --- the light -------------------------------------------------------- */
  lightColor: '#5fd8ec',
  lightIntensity: 6.2,
  lightRadius: 15.0 // metres
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * The `jet*` keys come straight out of `tubeSchema`, so the folders the module
 * publishes are the folders the panel shows and the pair cannot drift apart.
 * The keys belonging to `STRAIGHT`, `WHIP`, `VINE` and `ARC` are inert on this
 * path; they are filed together at the bottom rather than hidden, because a key
 * the panel cannot reach is a key nobody can rule out.
 */
const jetFolders = tubeSchema('jet', TubePath.FUNNEL);
const jetCovered = new Set(
  Object.values(jetFolders)
    .flat()
    .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
);
const jetInactive = Object.keys(geyser).filter(
  (key) => key.startsWith('jet') && key in tubeDefaults('jet') && !jetCovered.has(key)
);

export const geyserSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 120, 0.5, 'cast speed'],
    ['zoneRadius', 1, 14, 0.1, 'vent pool radius'],
    ['lifetime', 0.4, 10, 0.05, 'vent duration'],
    ['fadeTime', 0.2, 8, 0.05, 'settle duration'],
    ['cooldown', 0, 10, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['preFill', 0, 1, 0.01, 'pool before the vent blows'],
    ['ventRise', 0.02, 3, 0.01, 'pool swell'],
    ['chargeTime', 0.02, 3, 0.01, 'column rise'],
    ['holdTime', 0.02, 6, 0.01, 'full pressure hold'],
    ['collapseTime', 0.05, 5, 0.01, 'column collapse'],
    ['surge', 0, 0.6, 0.005, 'pressure breathing'],
    ['surgeRate', 0, 10, 0.01, 'breathing Hz']
  ],
  'The plume': [
    ['jetHeight', 1, 30, 0.1, 'column height (m)'],
    ['jetBase', 0, 1, 0.005, 'foot above the pool (m)'],
    ['jetTaper', 0.01, 1, 0.01, 'width at collapse'],
    ['lightRide', 0, 1, 0.01, 'light height on the column'],
    ['lightHeight', -2, 6, 0.05, 'extra light height (m)']
  ],
  ...jetFolders,
  'Prefixed keys this mode does not read': jetInactive,
  'The rain/Ballistics': [
    ['droplets', 1, 128, 1, 'drops'],
    ['seedAt', 0.05, 1, 0.01, 'where it tears off'],
    ['gravity', 0.5, 30, 0.05, 'gravity (m/s²)'],
    ['columnSpeed', 0, 30, 0.1, 'column speed (m/s)'],
    ['swirlCarry', 0, 2, 0.01, 'swirl carried'],
    ['spreadSpeed', 0, 8, 0.05, 'outward push (m/s)'],
    ['dropWindow', 0.01, 2, 0.005, 'tear window'],
    ['dropLead', 0, 1, 0.005, 'lead-in'],
    ['dropSpeedJitter', 0, 1, 0.01, 'fall-time jitter'],
    ['dropPathCurve', 0.2, 3, 0.01, 'horizontal easing'],
    ['dropApexCurve', 0.1, 3, 0.01, 'arc roundness'],
    ['dropFillBias', -1, 1, 0.01, 'ring fill order'],
    ['dropFillScatter', 0, 1, 0.01, 'fill scatter'],
    ['dropHashCell', 0.1, 6, 0.05, 'hash cell (m)'],
    ['dropRingBias', 0.05, 1.5, 0.01, 'ring crowding'],
    ['dropLinger', 0, 2, 0.01, 'linger on landing'],
    ['dropSink', 0, 6, 0.05, 'sink depth'],
    ['rippleStrength', 0, 4, 0.01, 'ripple per landing'],
    ['splashPerDrop', 0, 60, 1, 'spray per landing']
  ],
  'The rain/Body': [
    ['dropRadius', 0.01, 0.5, 0.002, 'radius (m)'],
    ['dropSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['dropStretch', 0.5, 5, 0.01, 'stretch along heading'],
    ['dropAlign', 0, 1, 0.01, 'align to heading'],
    ['dropSpin', 0, 20, 0.05, 'tumble'],
    ['dropFlash', 0.01, 1, 0.005, 'birth pop'],
    ['dropFacets', 5, 20, 1, 'sides'],
    ['dropRings', 3, 16, 1, 'levels'],
    ['dropTaper', 0, 1, 0.01, 'teardrop'],
    ['dropPinch', 0, 0.9, 0.01, 'trailing neck']
  ],
  'The rain/Shading': [
    ['colorDropClear', 'clear body'],
    ['colorDropFroth', 'aerated body'],
    ['colorDropSpot', 'refracted spot'],
    ['colorDropRim', 'silhouette'],
    ['dropIor', 1.01, 2.5, 0.001, 'refractive index'],
    ['dropSpot', 0, 8, 0.01, 'spot brightness'],
    ['dropSpotPower', 1, 60, 0.5, 'spot tightness'],
    ['dropRim', 0, 4, 0.01, 'rim'],
    ['dropRimPower', 0.2, 8, 0.05, 'rim power'],
    ['dropFroth', 0, 1, 0.01, 'aeration'],
    ['dropFrothFade', 0.05, 4, 0.01, 'aeration clears'],
    ['dropAmbient', 0, 1, 0.01, 'ambient'],
    ['dropShade', 0, 2, 0.01, 'key light'],
    ['dropFlashGain', 0, 6, 0.01, 'birth flash'],
    ['dropGlow', 0, 4, 0.01, 'glow'],
    ['dropOpacity', 0, 1, 0.01, 'opacity'],
    ['dropSoftFade', 0.01, 2, 0.01, 'soft intersection']
  ],
  'The rain/Trail': [
    ['trailSpan', 0.01, 2, 0.005, 'tail reach (s)'],
    ['trailBurn', 0.01, 2, 0.005, 'tail catch-up (s)'],
    ['trailWidth', 0.005, 0.6, 0.002, 'width (m)'],
    ['trailTaper', 0.2, 5, 0.01, 'taper'],
    ['trailLift', -0.5, 0.5, 0.005, 'lift (m)'],
    ['trailOpacity', 0, 1, 0.01, 'opacity'],
    ['trailGlow', 0, 5, 0.01, 'glow'],
    ['trailCore', 0.2, 8, 0.01, 'core tightness'],
    ['trailHeadBias', -1, 2, 0.01, 'head bias'],
    ['trailNoise', 0, 3, 0.01, 'noise'],
    ['trailNoiseScale', 0.1, 10, 0.05, 'noise / metre'],
    ['trailNoiseSpeed', 0, 4, 0.01, 'noise speed'],
    ['trailSoftFade', 0.01, 2, 0.01, 'soft intersection'],
    ['colorTrail*', 'Trail gradient']
  ],
  'The pool/The sheet': [
    ['poolHeight', 0, 0.6, 0.005, 'surface height'],
    ['poolOpacity', 0, 1, 0.01, 'opacity'],
    ['round', 0, 1, 0.01, 'elliptical footprint'],
    ['edgeSoft', 0.01, 0.6, 0.005, 'waterline softness'],
    ['edgeNoise', 0, 1, 0.01, 'waterline raggedness'],
    ['edgeScale', 0.1, 5, 0.01, 'raggedness / metre'],
    ['contactFade', 0.02, 2, 0.01, 'soft intersection']
  ],
  'The pool/The swell': [
    ['waveAmpA', 0, 0.5, 0.002, 'amp A'],
    ['waveAmpB', 0, 0.5, 0.002, 'amp B'],
    ['waveAmpC', 0, 0.5, 0.002, 'amp C'],
    ['waveAmpD', 0, 0.5, 0.002, 'amp D'],
    ['waveLengthA', 0.3, 12, 0.05, 'length A'],
    ['waveLengthB', 0.3, 12, 0.05, 'length B'],
    ['waveLengthC', 0.3, 12, 0.05, 'length C'],
    ['waveLengthD', 0.3, 12, 0.05, 'length D'],
    ['waveSpeedA', -4, 4, 0.01, 'speed A'],
    ['waveSpeedB', -4, 4, 0.01, 'speed B'],
    ['waveSpeedC', -4, 4, 0.01, 'speed C'],
    ['waveSpeedD', -4, 4, 0.01, 'speed D'],
    ['waveAngleA', 0, 6.29, 0.01, 'bearing A'],
    ['waveAngleB', 0, 6.29, 0.01, 'bearing B'],
    ['waveAngleC', 0, 6.29, 0.01, 'bearing C'],
    ['waveAngleD', 0, 6.29, 0.01, 'bearing D'],
    ['steepness', 0, 1.2, 0.01, 'gerstner steepness'],
    ['chop', 0, 0.3, 0.002, 'chop'],
    ['chopScale', 0.1, 8, 0.01, 'chop / metre'],
    ['chopSpeed', 0, 4, 0.01, 'chop drift'],
    ['detail', 0, 0.1, 0.001, 'normal detail'],
    ['detailScale', 0.5, 24, 0.1, 'detail / metre'],
    ['detailSpeed', 0, 4, 0.01, 'detail drift']
  ],
  'The pool/Ripples': [
    ['rippleAmp', 0, 1, 0.005, 'ripple height'],
    ['rippleSpeed', 0.1, 8, 0.02, 'front speed'],
    ['rippleLength', 0.1, 4, 0.01, 'wavelength'],
    ['rippleWidth', 0.05, 3, 0.01, 'packet width'],
    ['rippleDecay', 0.1, 8, 0.05, 'decay to 1/e'],
    ['rippleSpread', 0.2, 12, 0.05, 'radial thinning']
  ],
  'The pool/The flow field': [
    ['flowAngle', 0, 6.29, 0.01, 'drift bearing'],
    ['flowSpeed', 0, 4, 0.01, 'drift speed'],
    ['flowRadial', 0, 6, 0.01, 'boil at the vent'],
    ['flowRadialFall', 0.2, 12, 0.05, 'boil falloff'],
    ['flowEddy', 0, 4, 0.01, 'eddy speed'],
    ['flowEddyScale', 0.02, 2, 0.01, 'eddies / metre'],
    ['flowEddySpeed', 0, 2, 0.01, 'eddy churn'],
    ['flowGravity', 0, 8, 0.05, 'downhill flow']
  ],
  'The pool/Foam & shading': [
    ['foam', 0, 1, 0.01, 'foam'],
    ['foamScale', 0.5, 20, 0.1, 'speckle / metre'],
    ['foamSharp', 0.2, 4, 0.01, 'speckle sharpness'],
    ['foamCrest', 0, 3, 0.01, 'seeded by crests'],
    ['foamSpeed', 0, 3, 0.01, 'seeded by speed'],
    ['poolDepth', 0, 3, 0.01, 'depth under the plane'],
    ['depthTint', 0, 6, 0.01, 'beer-lambert density'],
    ['translucency', 0, 3, 0.01, 'backlight'],
    ['ambient', 0, 1, 0.01, 'ambient'],
    ['specular', 0, 4, 0.01, 'specular'],
    ['shininess', 4, 256, 1, 'shininess'],
    ['fresnel', 0, 3, 0.01, 'fresnel'],
    ['envIntensity', 0, 3, 0.01, 'probe reflection'],
    ['skyIntensity', 0, 2, 0.01, 'sky floor'],
    ['poolGlow', 0, 3, 0.01, 'pool glow'],
    ['normalEps', 0.005, 0.2, 0.001, 'normal step'],
    ['colorDeep', 'deep'],
    ['colorShallow', 'shallow'],
    ['colorFoam', 'foam'],
    ['colorSpec', 'specular'],
    ['colorSky', 'sky floor']
  ],
  'Spray': [
    ['sprayRate', 0, 600, 1, 'per second'],
    ['spraySpeed', 0, 16, 0.05, 'speed'],
    ['spraySize', 0.01, 0.5, 0.005, 'size'],
    ['sprayLifetime', 0.1, 5, 0.02, 'lifetime'],
    ['sprayGravity', -30, 10, 0.1, 'gravity'],
    ['sprayTurbulence', 0, 3, 0.01, 'turbulence'],
    ['colorSpray*', 'Spray gradient']
  ],
  'Steam': [
    ['steamRate', 0, 300, 1, 'per second'],
    ['steamSpeed', 0, 8, 0.05, 'speed'],
    ['steamSize', 0.05, 4, 0.01, 'size'],
    ['steamLifetime', 0.1, 8, 0.02, 'lifetime'],
    ['steamRise', -4, 6, 0.05, 'rise'],
    ['steamOpacity', 0, 1, 0.01, 'opacity'],
    ['colorSteam*', 'Steam gradient']
  ],
  'Grit': [
    ['gritRate', 0, 200, 1, 'per second'],
    ['gritSpeed', 0, 20, 0.05, 'speed'],
    ['gritSize', 0.01, 0.4, 0.005, 'size'],
    ['gritLifetime', 0.1, 5, 0.02, 'lifetime'],
    ['gritGravity', -30, 5, 0.1, 'gravity'],
    ['colorGrit*', 'Grit gradient']
  ],
  'Feedback': [
    ['burstSize', 0.1, 10, 0.05, 'vent shell'],
    ['burstIntensity', 0, 4, 0.01, 'shell glow'],
    ['colorBurstA', 'burst core'],
    ['colorBurstB', 'burst mid'],
    ['colorBurstC', 'burst rim'],
    ['shockRadius', 0.5, 14, 0.05, 'shock ring'],
    ['colorShockA', 'shock inner'],
    ['colorShockB', 'shock outer'],
    ['wetMarks', 0, 24, 1, 'wet stains'],
    ['wetRadius', 0.1, 5, 0.05, 'stain radius'],
    ['wetLife', 0.5, 20, 0.1, 'stain life'],
    ['wetIntensity', 0, 3, 0.01, 'stain strength'],
    ['colorWet', 'stain'],
    ['colorWetEdge', 'stain edge'],
    ['ventShake', 0, 2, 0.01, 'vent shake'],
    ['shakeDuration', 0.05, 2, 0.01, 'shake decay'],
    ['rumble', 0, 1, 0.005, 'running rumble'],
    ['ventFlash', 0, 2, 0.01, 'vent flash'],
    ['colorFlash', 'vent flash']
  ],
  'The light': [
    ['lightColor', 'colour'],
    ['lightIntensity', 0, 30, 0.1, 'intensity'],
    ['lightRadius', 1, 40, 0.5, 'radius']
  ]
};
