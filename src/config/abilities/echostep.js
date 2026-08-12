/* ================================================================== */
/* ECHO STEP — chrono                                                  */
/* ================================================================== */
/**
 * Three copies of the caster run the aimed line, each replaying the caster's
 * own recorded motion further behind the present and each fainter.
 *
 * Nothing below is baked into a cast. The recording holds timestamps and the
 * cast holds one dice roll; every delay, stride, metre of lift and step of
 * erosion is resolved from this block on every frame, including a zero-length
 * one. The controls worth reaching for first are `ghostDelay` (how far back in
 * the recording the first echo is reading — drag it while paused and the three
 * figures walk through the past), `ghostStride` (how strung out down the line
 * they are) and `catchUp` (how hard the past closes on the present once the
 * run is over).
 *
 * British spelling in the prose, `color` in the keys — the editor detects a
 * colour picker by the key prefix, and this block is not the place to break
 * that.
 */
export const echostep = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 2.5, // closer than this and the cast is refused
  speed: 15.0, // how fast the run travels down the line, metres/second
  lifetime: 0.85, // seconds the echoes hold at the far end
  fadeTime: 1.15, // seconds they take to come apart
  cooldown: 0.9,
  castAnim: 'cast1', // the clip the real caster throws — and therefore the one every echo replays

  /* --- the recording --- */
  // `sampleRate` is how finely the caster's skeleton is written into the ring;
  // `memory` is how much of it is kept. Both are live: the ring's *capacity* is
  // a structural ceiling in the class (150 samples), the same way `MAX_STRANDS`
  // is in Storm Lance, but how much of it is used is a slider.
  sampleRate: 45, // pose samples per second
  memory: 3.0, // seconds of the caster's past kept on the track

  /* --- the echoes --- */
  ghosts: 3, // how many copies run the line (capped at 4)
  ghostDelay: 0.24, // seconds the first echo lags the caster
  delayGrowth: 1.3, // × further back each echo after that reads
  ghostStride: 2.6, // metres the first echo trails the front
  strideGrowth: 1.18, // × further back each echo after that runs
  ghostLift: 0.0, // metres the newest echo floats above the floor
  ghostSink: 0.055, // metres each older echo sinks below that
  ghostScale: 1.0, // × the caster's own size
  scaleDecay: 0.05, // × smaller per echo — a shrinking copy reads as a receding one
  ghostYaw: 0.09, // radians each echo is turned off the line of travel
  weave: 0.14, // metres of lateral serpentine, × the echo's rank
  weaveWaves: 1.4, // wavelengths of that serpentine over the whole line
  catchUp: 0.85, // 0..1 how far the echoes close on the arrival point as they die
  catchCurve: 2.2, // >1 holds them back and then pulls them in late

  /* --- what an echo looks like --- */
  // These drive `createGhostMaterial`, which bleaches the character's own skin
  // by its luminance rather than tinting it — so the map's light and shade
  // survive and the figure stays a person instead of a coloured blob.
  colorGhost: '#d5be8c', // where the caster's skin was bright
  colorGhostDeep: '#2f2a1e', // where it was dark
  colorRim: '#f4e9cd', // the fresnel edge
  bleach: 0.72, // 0..1 how far the skin is washed toward those two
  ghostOpacity: 0.62, // master opacity of the newest echo
  opacityDecay: 0.66, // × per echo — the decreasing-opacity half of the trick
  facing: 0.42, // 0..1 how much thinner an echo is head-on than edge-on
  rim: 1.5, // fresnel emission
  rimPower: 2.8, // fresnel tightness
  bandGlow: 0.3, // emission of the bands travelling down the body
  bandScale: 4.2, // bands per metre of world height
  bandSpeed: 0.8, // metres/second those bands travel
  erode: 0.04, // 0..1 dissolve on the newest echo
  erodeStep: 0.1, // + per echo — the oldest is the most eaten
  erodeScale: 3.1, // dissolve noise features per metre
  erodeEdge: 0.16, // 0..1 width of the burning edge on the dissolve
  edgeGlow: 2.0, // emission on that edge
  erodeOut: 0.9, // extra dissolve applied over the blow-out

  /* --- the floor's memory of the run --- */
  // A `GroundField` in RUT mode: a strip down the line whose depth follows the
  // contact forces the footfalls posted. The marks are unitless, so the whole
  // track re-cuts itself under a paused slider.
  trackWidth: 0.34, // half-width of the track, metres
  trackCanvas: 6.0, // × that width — how much quad is stood up to hold the spoil
  trackDepth: 0.075, // metres the track is pressed into the floor
  trackSpoil: 0.02, // metres of ridge thrown up either side
  trackSpoilWidth: 0.09, // metres that ridge is spread over
  trackSharp: 0.55, // 0..1 how squared-off the track's floor is
  trackChatter: 0.62, // metres between the prints the run leaves
  trackChatterDepth: 0.5, // 0..1 how deeply those prints read
  trackWander: 0.16, // metres the track drifts off the line
  trackWanderScale: 0.45, // wanders per metre
  stepBlur: 0.55, // metres a single footfall's weight is felt over
  trackEdge: 0.28, // metres of feather on the leading edge
  trackHeight: 0.017, // metres above the floor the quad sits
  trackRelief: 0.55, // how hard the height field tilts the fake normal
  trackNormalStep: 0.05, // metres between the height taps
  trackAmbient: 0.36, // floor on the diffuse term
  trackWrap: 0.5, // 0..1 wraps the terminator round the back
  trackSpecular: 0.3,
  trackGloss: 20, // Blinn exponent
  trackParallax: 0.22, // metres of view-driven offset on interior detail
  trackEmissive: 0.85, // multiplier on the glow at the leading edge
  trackOpacity: 0.8,
  trackDepthFade: 0.4, // metres of soft fade against standing geometry
  colorTrack: '#4a4438', // the disturbed floor itself
  colorTrackEdge: '#b9ab8c', // the spoil ridges and the sheen
  colorTrackGlow: '#e6c98e', // the amber at the leading edge
  colorTrackDeep: '#181510', // the bottom of the print

  /* --- footfalls --- */
  steps: 11, // prints an echo leaves over the whole line
  stepStagger: 0.31, // fraction of a step each echo's pattern is offset by
  stepWeight: 0.9, // 0..1 contact force of the newest echo's step
  weightDecay: 0.7, // × per echo — an older memory presses less hard

  /* --- amber shed by the echoes --- */
  moteRate: 70, // motes/second across all live echoes
  moteSize: 0.05,
  moteSpeed: 0.7,
  moteLifetime: 2.2,
  moteRise: 0.35, // upward drift, metres/second
  moteTurbulence: 0.55,
  moteHeight: 1.0, // metres above the floor they leave the body at
  moteSpread: 0.42, // metres of scatter around it
  moteOpacity: 0.75,
  moteGlow: 0.8,
  colorMoteA: '#fff3d8',
  colorMoteB: '#e6c98e',
  colorMoteC: '#a98a52',
  colorMoteD: '#2a2116',

  /* --- dust lifted by a footfall --- */
  dustPerStep: 7, // particles per print, × its contact force
  dustSize: 0.55,
  dustSpeed: 0.8,
  dustLifetime: 1.9,
  dustRise: 0.28, // upward drift, metres/second
  dustTurbulence: 0.4,
  dustHeight: 0.07, // metres above the floor a print's dust starts
  dustSpread: 0.3, // metres of scatter around the print
  dustOpacity: 0.14,
  colorDustA: '#8e8571',
  colorDustB: '#6f6754',
  colorDustC: '#4e4839',
  colorDustD: '#2b2820',

  /* --- the arrival --- */
  arrivalSize: 1.9, // radius of the pressure shell at the far end, metres
  arrivalIntensity: 1.0,
  arrivalHeight: 0.95, // metres above the floor it opens at
  arrivalShake: 0.22,
  shakeDuration: 0.5,
  arrivalFlash: 0.06, // screen flash — deliberately almost nothing
  colorArrivalA: '#d5be8c', // the shell
  colorArrivalB: '#f4e9cd', // its body
  colorArrivalC: '#fffaf0', // the filaments racing over it
  colorFlash: '#e8dcbc',

  /* --- dynamic light --- */
  lightIntensity: 9,
  lightRadius: 11,
  lightColor: '#e6c98e',
  lightHeight: 1.1, // metres above the floor the light rides at
  lightPulse: 0.25, // depth of the slow swell, 0 = steady
  lightPulseSpeed: 2.4 // radians/second of that swell
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Echo Step.
 *
 * The folder to open first is **The echoes**. `ghostDelay` and `delayGrowth`
 * decide *when* each figure is; `ghostStride` and `strideGrowth` decide where.
 * Those two pairs are independent on purpose — an echo that is far back in the
 * recording but close in space reads completely differently from one that is
 * the reverse, and both are worth having.
 */
export const echostepSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 60, 0.5, 'run speed'],
    ['lifetime', 0.05, 6, 0.01, 'hold at the end'],
    ['fadeTime', 0.05, 5, 0.01, 'come-apart time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The recording': [
    ['sampleRate', 5, 120, 1, 'samples / second'],
    ['memory', 0.25, 5, 0.05, 'seconds remembered']
  ],
  'The echoes': [
    ['ghosts', 1, 4, 1, 'echoes'],
    ['ghostDelay', 0.02, 1.5, 0.01, 'first echo delay'],
    ['delayGrowth', 1, 3, 0.01, 'delay growth'],
    ['ghostStride', 0, 12, 0.05, 'first echo stride'],
    ['strideGrowth', 0.5, 3, 0.01, 'stride growth'],
    ['ghostLift', -0.5, 2, 0.01, 'lift'],
    ['ghostSink', -0.3, 0.4, 0.005, 'sink per echo'],
    ['ghostScale', 0.2, 2, 0.01, 'scale'],
    ['scaleDecay', -0.2, 0.3, 0.005, 'scale decay'],
    ['ghostYaw', -1, 1, 0.01, 'yaw fan'],
    ['weave', 0, 1.5, 0.01, 'lateral weave'],
    ['weaveWaves', 0, 6, 0.05, 'weave wavelengths'],
    ['catchUp', 0, 1, 0.01, 'catch-up'],
    ['catchCurve', 0.2, 6, 0.05, 'catch-up curve']
  ],
  'What an echo looks like': [
    ['colorGhost', 'skin, lit'],
    ['colorGhostDeep', 'skin, shaded'],
    ['colorRim', 'fresnel rim'],
    ['bleach', 0, 1, 0.01, 'bleach'],
    ['ghostOpacity', 0, 1, 0.01, 'opacity'],
    ['opacityDecay', 0.1, 1, 0.01, 'opacity decay'],
    ['facing', 0, 1, 0.01, 'facing falloff'],
    ['rim', 0, 5, 0.01, 'rim glow'],
    ['rimPower', 0.2, 8, 0.05, 'rim tightness'],
    ['bandGlow', 0, 2, 0.01, 'band glow'],
    ['bandScale', 0.2, 16, 0.1, 'bands / metre'],
    ['bandSpeed', -4, 4, 0.01, 'band speed']
  ],
  'What an echo looks like/Coming apart': [
    ['erode', 0, 1, 0.01, 'dissolve'],
    ['erodeStep', 0, 0.5, 0.005, 'dissolve per echo'],
    ['erodeScale', 0.2, 12, 0.05, 'dissolve scale'],
    ['erodeEdge', 0.01, 0.6, 0.005, 'burning edge'],
    ['edgeGlow', 0, 6, 0.05, 'edge glow'],
    ['erodeOut', 0, 1, 0.01, 'dissolve on blow-out']
  ],
  'The track': [
    ['trackWidth', 0.05, 2, 0.01, 'half-width'],
    ['trackCanvas', 2, 14, 0.1, 'canvas × width'],
    ['trackDepth', 0, 0.6, 0.005, 'depth'],
    ['trackSpoil', 0, 0.3, 0.005, 'spoil height'],
    ['trackSpoilWidth', 0.01, 0.5, 0.005, 'spoil width'],
    ['trackSharp', 0, 1, 0.01, 'floor sharpness'],
    ['trackChatter', 0.05, 3, 0.01, 'print pitch'],
    ['trackChatterDepth', 0, 1, 0.01, 'print depth'],
    ['trackWander', 0, 1.5, 0.01, 'wander'],
    ['trackWanderScale', 0.05, 3, 0.01, 'wanders / metre'],
    ['stepBlur', 0.05, 3, 0.01, 'footfall blur'],
    ['trackEdge', 0.02, 2, 0.01, 'front feather'],
    ['trackHeight', 0.002, 0.2, 0.001, 'height above floor']
  ],
  'The track/Lighting': [
    ['trackRelief', 0, 3, 0.01, 'relief'],
    ['trackNormalStep', 0.005, 0.3, 0.005, 'normal step'],
    ['trackAmbient', 0, 1, 0.01, 'ambient'],
    ['trackWrap', 0, 1, 0.01, 'terminator wrap'],
    ['trackSpecular', 0, 2, 0.01, 'specular'],
    ['trackGloss', 1, 80, 1, 'gloss'],
    ['trackParallax', 0, 1.5, 0.01, 'parallax'],
    ['trackEmissive', 0, 4, 0.01, 'emissive'],
    ['trackOpacity', 0, 2, 0.01, 'opacity'],
    ['trackDepthFade', 0.02, 2, 0.01, 'soft intersection'],
    ['colorTrack', 'track body'],
    ['colorTrackEdge', 'spoil & sheen'],
    ['colorTrackGlow', 'leading edge'],
    ['colorTrackDeep', 'print interior']
  ],
  Footfalls: [
    ['steps', 1, 40, 1, 'prints / line'],
    ['stepStagger', 0, 1, 0.01, 'stagger per echo'],
    ['stepWeight', 0, 1, 0.01, 'contact force'],
    ['weightDecay', 0.1, 1, 0.01, 'force decay'],
    ['dustPerStep', 0, 40, 1, 'dust / print'],
    ['dustSize', 0.05, 3, 0.01, 'dust size'],
    ['dustSpeed', 0, 6, 0.05, 'dust speed'],
    ['dustLifetime', 0.1, 6, 0.05, 'dust lifetime'],
    ['dustRise', -2, 3, 0.01, 'dust rise'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['dustHeight', 0, 1, 0.01, 'dust height'],
    ['dustSpread', 0.02, 2, 0.01, 'dust spread'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['colorDust*', 'Dust colour']
  ],
  'Amber motes': [
    ['moteRate', 0, 400, 1, 'motes / second'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 8, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -2, 4, 0.01, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['moteHeight', 0, 2.5, 0.01, 'mote height'],
    ['moteSpread', 0.02, 2, 0.01, 'mote spread'],
    ['moteOpacity', 0, 2, 0.01, 'mote opacity'],
    ['moteGlow', 0, 4, 0.01, 'mote glow'],
    ['colorMote*', 'Mote colour']
  ],
  'The arrival': [
    ['arrivalSize', 0.1, 10, 0.05, 'shell size'],
    ['arrivalIntensity', 0, 4, 0.01, 'shell intensity'],
    ['arrivalHeight', 0, 3, 0.01, 'shell height'],
    ['arrivalShake', 0, 2, 0.01, 'shake'],
    ['shakeDuration', 0.1, 3, 0.01, 'shake duration'],
    ['arrivalFlash', 0, 1, 0.005, 'screen flash'],
    ['colorArrivalA', 'shell'],
    ['colorArrivalB', 'shell body'],
    ['colorArrivalC', 'shell filaments'],
    ['colorFlash', 'flash colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightHeight', 0, 3, 0.01, 'light height'],
    ['lightPulse', 0, 1, 0.01, 'swell depth'],
    ['lightPulseSpeed', 0.1, 12, 0.05, 'swell rate'],
    ['lightColor', 'light colour']
  ]
};
