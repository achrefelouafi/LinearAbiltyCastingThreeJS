/* ================================================================== */
/* HEMOLANCE — blood, line cast                                        */
/* ================================================================== */
/**
 * Hemorrhage. A volley of needles, and the mist they leave behind.
 *
 * Two numbers carry this whole ability and they are worth finding before
 * anything else in the block:
 *
 *  - **`ripplePhase`** — the seconds between one needle leaving the hand and
 *    the next. It is the signature. At 0 the volley is a shotgun: twelve lances
 *    on one frame, which reads as a single wide object and is over before the
 *    eye resolves it. At 0.06 it is a *ripple* — you see each needle
 *    individually, in order, and the volley reads as twelve things instead of
 *    one thing. Past about 0.15 it stops being a volley and becomes a queue.
 *  - **`mistLife`** — how long a metre of mist survives after the needle that
 *    laid it has already gone. This is the other half of the trick. A needle at
 *    a hundred and forty metres a second crosses the whole cast in a tenth of a
 *    second; on its own it is a flicker you are not sure you saw. The trail
 *    outliving the projectile is what leaves the *evidence* on screen, so twelve
 *    needles fired over two thirds of a second stack up into twelve visible
 *    threads even though never more than three are in the air at once.
 *
 * The needles fly dead straight on purpose: no loft, no weave. Everything else
 * in the sandbox that travels does something on the way, and a lance that
 * curves is a bolt. `pathCurve` is the only shaping control, and it only
 * changes how the speed is distributed along a line that stays a line — which
 * is also what lets the mist shader mirror the flight exactly with one `pow`.
 *
 * `speedJitter` is deliberately *absent*. Varying the flight times on top of
 * the ripple muddies the one thing the volley exists to show, and the first
 * build had it at 0.2 and read as a mess rather than as a rhythm.
 */
export const hemolance = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 2.5, // closer than this and the cast is refused, metres
  speed: 130.0, // how fast the cast front runs the line, metres/second
  lifetime: 0.9, // seconds the volley holds — stretched to cover the ripple
  fadeTime: 1.0, // seconds the last mist bleeds off
  cooldown: 0.7, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the volley --- */
  needles: 12, // lances in one volley (capped at 16)
  ripplePhase: 0.06, // SECONDS BETWEEN NEEDLES — the signature slider
  volleyLead: 0.02, // seconds before the first needle leaves
  needleTime: 0.13, // seconds one needle is in the air
  fanWidth: 0.42, // metres — half-width of the fan at the hand
  handHeight: 1.3, // metres above the floor the volley leaves from
  handForward: 0.55, // metres in front of the caster
  handSide: 0.2, // metres to the side (+ follows `Ability#side`)
  spreadSide: 0.55, // ± metres across the line where they converge
  spreadForward: 0.4, // ± metres along it
  landHeight: 0.55, // metres above the floor they converge at — chest height
  pathCurve: 1.25, // >1 accelerates the needle over its flight

  /* --- the needle --- */
  needleRadius: 0.03, // half-width of a lance, metres
  needleLength: 20.0, // how far it is drawn out along its heading, × the radius
  needleAlign: 0.94, // 0 tumbles freely, 1 lays the lance along its flight
  needleSpin: 6.0, // roll about the long axis, radians/second
  needleFlash: 0.05, // seconds of birth flash as a lance appears
  needleGlow: 1.5, // emissive gain on the body
  needleOpacity: 1.0,
  needleRim: 3.0, // fresnel exponent — this is most of the silhouette
  needleTip: 2.2, // extra heat crowded into the leading half
  colorNeedleCore: '#ff8a92', // the wet highlight along the lance
  colorNeedleEdge: '#c01a28', // its body
  colorNeedleDeep: '#3a0509', // the side turned away from you

  /* --- the mist that outlives the needle --- */
  /**
   * One instanced strip carries every thread and it holds no history at all.
   * The vertex shader knows when the needle passed each point on its own path —
   * that is a closed form, not a recording — and shades the ribbon by how long
   * ago that was. Which is why `mistLife`, `mistSpread` and `mistDrift` reshape
   * threads that are already hanging in the air with the clock stopped, and why
   * dragging `ripplePhase` re-lays all twelve of them at once.
   */
  mistLife: 0.85, // seconds a point of mist survives after the needle passed
  mistWidth: 0.022, // metres — the hairline at the instant it is laid
  mistSpread: 0.17, // metres it swells to by the time it dies
  mistDrift: 0.34, // metres/second the thread rises as it ages
  mistWander: 0.15, // metres of lateral wander at full age
  mistWanderScale: 1.3, // wander features per metre
  mistWanderSpeed: 0.35, // how fast the wander field itself moves
  mistCore: 3.4, // how hard a fresh thread crowds its own centre line
  mistFalloff: 1.7, // >1 holds the thread bright then drops it
  mistOpacity: 0.9,
  mistSoftFade: 0.35, // metres of depth feather against solid geometry
  colorMistA: '#ff5a66', // the instant it is laid
  colorMistB: '#c01a28',
  colorMistC: '#6e0d16',
  colorMistD: '#2a0508', // as it dies

  /* --- the pools --- */
  /**
   * `GroundField(POCK)` again, and shaded rather than additive — which is the
   * whole difference between this and Starfall's rings. A shaded POCK with a
   * shallow bowl, a low wet rim and a tight specular is a puddle; the same mode
   * additive with a tall rim and a hot glow is a ring of light. One shader, two
   * substances, one draw call either way.
   */
  fieldRadius: 3.2, // metres — the footprint the pools may spread over
  poolRadius: 0.5, // metres one impact's pool reaches
  poolSpread: 5.5, // how fast it spreads to that radius, 1/second
  poolLife: 9.0, // seconds a pool takes to soak away
  poolRim: 0.02, // metres the wet lip stands proud
  poolDepth: 0.06, // metres the pool sinks
  poolThickness: 0.05, // metres — how wide the lip is
  poolDetail: 0.45, // grain across the wet stone
  fieldEdge: 0.35, // metres of feather on the footprint boundary
  fieldRagged: 0.3, // how far that boundary wanders, fraction of the radius
  fieldRaggedScale: 0.9, // lobes per metre
  fieldWarp: 0.45, // metres of domain warp on those lobes
  fieldRelief: 0.8, // how hard the height field tilts the fake normal
  fieldSpecular: 1.4, // pools are mostly specular — this is the wet read
  fieldGloss: 60, // Blinn exponent — tight, like standing liquid
  fieldEmissive: 0.5, // multiplier on the glowing terms; blood barely glows
  fieldOpacity: 1.0,
  fieldHeight: 0.018, // metres the quad floats above the floor
  colorPoolBase: '#5a0a10', // the blood itself
  colorPoolEdge: '#e8737d', // the wet lip and the sheen
  colorPoolGlow: '#c01a28', // the little heat left in a fresh hit
  colorPoolDeep: '#1a0205', // the middle of a deep one

  /* --- droplets, spray and haze --- */
  /**
   * Three shared systems, each with its own four-stop lifetime gradient (A at
   * birth through D as it dies). All three are non-additive: blood that adds
   * light is neon, and the school has exactly one bright thing in it, which is
   * the fresh end of the mist.
   */
  dropletBurst: 14, // fat droplets thrown by one impact
  dropletSize: 0.06,
  dropletSpeed: 4.6, // metres/second
  dropletLifetime: 0.9, // seconds
  dropletGravity: -16.0, // metres/second²
  colorDropletA: '#e0424f',
  colorDropletB: '#a8121f',
  colorDropletC: '#6a0a12',
  colorDropletD: '#2a0408',
  sprayBurst: 22, // fine spray off the same impact
  spraySize: 0.05,
  spraySpeed: 9.5, // metres/second
  sprayLifetime: 0.4, // seconds
  sprayGravity: -13.0, // metres/second²
  sprayStretch: 0.3, // how far a spray streak smears along its velocity
  colorSprayA: '#ff7a84',
  colorSprayB: '#c8202e',
  colorSprayC: '#7a0e18',
  colorSprayD: '#33060b',
  hazeBurst: 5, // slow red haze hanging where the volley struck
  hazeSize: 0.75,
  hazeSpeed: 0.9, // metres/second
  hazeLifetime: 1.9, // seconds
  hazeRise: 0.42, // metres/second
  hazeOpacity: 0.16,
  colorHazeA: '#7a1620',
  colorHazeB: '#5a0f18',
  colorHazeC: '#3a0810',
  colorHazeD: '#180308',

  /* --- the muzzle and the impacts --- */
  muzzleSize: 0.45, // the burst at the hand as the volley leaves, metres
  muzzleIntensity: 1.3,
  castFlash: 0.06, // screen flash on release
  colorMuzzleA: '#5a0a10',
  colorMuzzleB: '#c01a28',
  colorMuzzleC: '#ff8a92',
  colorCastFlash: '#c01a28',
  shellSize: 0.9, // the splash one needle opens where it lands, metres
  shellIntensity: 1.2,
  shellLife: 0.4, // seconds
  colorShellA: '#5a0a10',
  colorShellB: '#c01a28',
  colorShellC: '#ff8a92',
  impactFlash: 0.1, // screen flash, fired by the *last* needle only
  colorFlash: '#c01a28',
  impactShake: 0.11, // per-needle kick
  shakeDuration: 0.22, // seconds it decays over
  rumble: 0.015, // continuous shake while the volley is in flight

  /* --- dynamic light --- */
  lightIntensity: 9, // the standing glow at the point of impact
  lightRadius: 11, // metres
  lightColor: '#c01a28',
  lightPulse: 0.3, // depth of the arterial pulse, 0 = steady
  lightPulseSpeed: 3.4, // pulses/second
  lightPunch: 6.0 // added to the light by each needle that lands
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Hemorrhage.
 *
 * Start in **The volley** with `ripplePhase` and take it from 0 to 0.15 slowly
 * — that single control is the difference between a shotgun and a volley, and
 * nothing else in the folder matters until it is set. Then **The mist**:
 * `mistLife` decides whether the ability leaves evidence or a flicker, and
 * `mistSpread` decides whether the evidence is a wire or a smear.
 */
export const hemolanceSchema = {
  'The cast': [
    ['range', 3, 50, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 400, 1, 'front speed'],
    ['lifetime', 0.1, 5, 0.05, 'hold time'],
    ['fadeTime', 0.1, 5, 0.05, 'fade time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The volley': [
    ['needles', 1, 16, 1, 'needles'],
    ['ripplePhase', 0, 0.3, 0.005, 'ripple phase (s/needle)'],
    ['volleyLead', 0, 1, 0.005, 'lead-in'],
    ['needleTime', 0.02, 1, 0.005, 'time in the air'],
    ['fanWidth', 0, 2, 0.01, 'muzzle fan'],
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['spreadSide', 0, 4, 0.01, 'spread across'],
    ['spreadForward', 0, 4, 0.01, 'spread along'],
    ['landHeight', 0, 3, 0.01, 'convergence height'],
    ['pathCurve', 0.4, 3, 0.01, 'flight acceleration']
  ],
  'The needle': [
    ['needleRadius', 0.005, 0.2, 0.001, 'half-width'],
    ['needleLength', 2, 60, 0.5, 'length (× radius)'],
    ['needleAlign', 0, 1, 0.01, 'align to flight'],
    ['needleSpin', 0, 30, 0.1, 'roll rate'],
    ['needleFlash', 0.01, 0.5, 0.005, 'birth flash'],
    ['needleGlow', 0, 6, 0.01, 'glow'],
    ['needleOpacity', 0, 2, 0.01, 'opacity'],
    ['needleRim', 0.2, 8, 0.05, 'rim sharpness'],
    ['needleTip', 0, 6, 0.05, 'tip heat'],
    ['colorNeedleCore', 'needle highlight'],
    ['colorNeedleEdge', 'needle body'],
    ['colorNeedleDeep', 'needle shadow']
  ],
  'The mist': [
    ['mistLife', 0.05, 4, 0.01, 'mist lifetime'],
    ['mistWidth', 0.002, 0.3, 0.002, 'hairline width'],
    ['mistSpread', 0, 1.5, 0.005, 'swell at death'],
    ['mistDrift', -1, 3, 0.01, 'rise'],
    ['mistWander', 0, 1.5, 0.005, 'lateral wander'],
    ['mistWanderScale', 0.05, 6, 0.05, 'wander scale'],
    ['mistWanderSpeed', 0, 4, 0.01, 'wander speed'],
    ['mistCore', 0.3, 10, 0.05, 'core tightness'],
    ['mistFalloff', 0.2, 6, 0.05, 'death curve'],
    ['mistOpacity', 0, 2, 0.01, 'opacity'],
    ['mistSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorMist*', 'Mist colour']
  ],
  'The pools': [
    ['fieldRadius', 0.3, 14, 0.1, 'footprint radius'],
    ['poolRadius', 0.05, 3, 0.01, 'pool radius'],
    ['poolSpread', 0.2, 25, 0.1, 'spread rate'],
    ['poolLife', 0.5, 30, 0.5, 'pool lifetime'],
    ['poolRim', 0, 0.4, 0.002, 'lip height'],
    ['poolDepth', 0, 0.8, 0.005, 'pool depth'],
    ['poolThickness', 0.005, 0.4, 0.005, 'lip width'],
    ['poolDetail', 0, 1, 0.01, 'wet grain'],
    ['fieldEdge', 0.02, 3, 0.01, 'boundary feather'],
    ['fieldRagged', 0, 1, 0.01, 'boundary wander'],
    ['fieldRaggedScale', 0.1, 4, 0.05, 'wander scale'],
    ['fieldWarp', 0, 3, 0.01, 'domain warp'],
    ['fieldRelief', 0, 2, 0.01, 'relief'],
    ['fieldSpecular', 0, 4, 0.01, 'wet specular'],
    ['fieldGloss', 1, 150, 1, 'gloss'],
    ['fieldEmissive', 0, 4, 0.01, 'emissive'],
    ['fieldOpacity', 0, 2, 0.01, 'opacity'],
    ['fieldHeight', 0.001, 0.2, 0.001, 'height above floor'],
    ['colorPoolBase', 'pool body'],
    ['colorPoolEdge', 'wet lip'],
    ['colorPoolGlow', 'fresh heat'],
    ['colorPoolDeep', 'pool depths']
  ],
  'Droplets & spray': [
    ['dropletBurst', 0, 100, 1, 'droplets / impact'],
    ['dropletSize', 0.005, 0.4, 0.005, 'droplet size'],
    ['dropletSpeed', 0, 20, 0.1, 'droplet speed'],
    ['dropletLifetime', 0.1, 4, 0.01, 'droplet lifetime'],
    ['dropletGravity', -50, 0, 0.1, 'droplet gravity'],
    ['sprayBurst', 0, 150, 1, 'spray / impact'],
    ['spraySize', 0.005, 0.3, 0.005, 'spray size'],
    ['spraySpeed', 0, 30, 0.1, 'spray speed'],
    ['sprayLifetime', 0.05, 3, 0.01, 'spray lifetime'],
    ['sprayGravity', -50, 0, 0.1, 'spray gravity'],
    ['sprayStretch', 0, 3, 0.01, 'spray stretch'],
    ['colorDroplet*', 'Droplet colour'],
    ['colorSpray*', 'Spray colour']
  ],
  'Haze': [
    ['hazeBurst', 0, 60, 1, 'haze / impact'],
    ['hazeSize', 0.05, 3, 0.01, 'haze size'],
    ['hazeSpeed', 0, 6, 0.05, 'haze speed'],
    ['hazeLifetime', 0.2, 6, 0.05, 'haze lifetime'],
    ['hazeRise', -2, 4, 0.01, 'haze rise'],
    ['hazeOpacity', 0, 1, 0.005, 'haze opacity'],
    ['colorHaze*', 'Haze colour']
  ],
  'Muzzle & impact': [
    ['muzzleSize', 0.05, 4, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle intensity'],
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorMuzzleA', 'muzzle shell'],
    ['colorMuzzleB', 'muzzle body'],
    ['colorMuzzleC', 'muzzle crest'],
    ['colorCastFlash', 'release flash colour'],
    ['shellSize', 0.05, 5, 0.05, 'splash size'],
    ['shellIntensity', 0, 5, 0.01, 'splash intensity'],
    ['shellLife', 0.05, 2, 0.01, 'splash life'],
    ['colorShellA', 'splash shell'],
    ['colorShellB', 'splash body'],
    ['colorShellC', 'splash crest'],
    ['impactFlash', 0, 2, 0.01, 'last-needle screen flash'],
    ['colorFlash', 'screen flash colour'],
    ['impactShake', 0, 2, 0.01, 'per-needle shake'],
    ['shakeDuration', 0.05, 2, 0.01, 'shake decay'],
    ['rumble', 0, 0.3, 0.005, 'flight rumble']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'pulse depth'],
    ['lightPulseSpeed', 0.2, 20, 0.1, 'pulse rate'],
    ['lightPunch', 0, 40, 0.5, 'punch per needle'],
    ['lightColor', 'light colour']
  ]
};
