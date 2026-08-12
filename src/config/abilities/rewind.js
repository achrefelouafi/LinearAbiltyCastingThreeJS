/* ================================================================== */
/* REWIND — chrono                                                     */
/* ================================================================== */
/**
 * The floor is torn open along the line, and then it is not.
 *
 * There is nothing in this block that describes a *reversed* effect, because
 * there is no such thing here. Everything under "The wake" is an ordinary
 * gouged track and an ordinary shower of debris, authored exactly as Rolling
 * Ruin's would be; everything under "The beat" describes what the **clock** they
 * are handed does. Point a decreasing number at a closed form and it runs
 * backwards for free — that is the whole ability, and it is why this block is
 * two thirds the length of the one next to it.
 *
 * ## The five numbers that are the ability
 *
 * `forwardRate`, `turnAt`, `holdTime`, `backRate` and `reachBack` are
 * `reverseParams()` from `vfx/TimeControl.js`, one for one. Time runs forward at
 * `forwardRate` until `turnAt` seconds of cast age, stops dead for `holdTime`,
 * and then runs backwards at `backRate` until it reaches `reachBack`.
 *
 * **`holdTime` is not decoration and it is the first thing to try setting to
 * zero.** A reversal with no pause at the top reads as a glitch: the eye needs a
 * moment in which nothing at all moves in order to understand that what follows
 * is the same motion inverted rather than a different motion. At 0 the slot
 * looks broken. At 0.16 it looks deliberate. Nothing else about the ability
 * changes between those two values.
 *
 * **`reachBack` is negative on purpose.** It is the earliest instant the clock
 * may reach, measured in cast age, so a negative value takes the wake back past
 * the moment the cast started — the dust that was already hanging in the air
 * when you pressed the button gathers up too. Set it to 0 and the reversal stops
 * politely at the cast; set it to -1.2 and it reaches into whatever was standing
 * there before.
 *
 * ## Why there is not a single decal in here
 *
 * `GroundDecals` is a pooled one-shot system on the app's forward clock, and
 * **nothing can un-spawn a decal**. A scorch or a crack left standing on the
 * floor while the debris that made it flies back up and the gouge closes under
 * it is the one detail that gives the whole thing away, and it gives it away
 * instantly. So the floor here is a `GroundField(RUT)` — a live mesh whose track
 * is re-resolved from `progress` every frame — and the ability is entirely
 * decal-free. The same argument retired a `DecalType.CRACK` at the break and a
 * `DUSTRING` at each station; both looked better on the forward leg and both
 * ruined the return.
 *
 * The one exception, and it is deliberate, is the pressure shell at the turn.
 * See `turnBurstSize`.
 *
 * ## Two lifetimes that are load-bearing
 *
 * `shardLife` **must outlast the whole beat**. `ShatterField` retires a fragment
 * for good the moment its own age passes its lifetime, and no clock brings a
 * retired fragment back — so a shard that expires on the forward leg simply is
 * not there to reassemble. Keep it above `turnAt - breakAt`.
 *
 * `dustLife` and `gritLife` want the **opposite**: keep them *under* the length
 * of the beat. When the time region lets go, everything inside jumps from its
 * rewound age back to its true one in a single frame, and anything still alive
 * at that instant pops out of existence. Let them expire on their own and
 * nothing does.
 */
export const rewind = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 2.0, // closer than this and the cast is refused
  speed: 52.0, // how fast the tearing front travels, metres/second
  cooldown: 1.8, // seconds
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beat (vfx/TimeControl.js reverseParams) --- */
  forwardRate: 1.0, // × real time before the turn
  turnAt: 1.05, // seconds of cast age at which time stops going forward
  holdTime: 0.16, // seconds held at the top — the beat you can see coming
  backRate: 2.2, // × the speed it then runs backwards at
  reachBack: -0.3, // earliest instant the clock may reach, seconds of cast age
  settleTime: 0.4, // seconds after the clock lands on that floor before DONE

  /* --- the sphere the reversal actually reaches into --- */
  // Everything that injects `shaders/lib/timewarp.glsl.js` and stands inside
  // this sphere runs the bent clock, including other casts' particles. Outside
  // it, the world carries on.
  fieldRadius: 12.0, // metres — outer edge
  fieldAlong: 0.5, // 0..1 where along the cast line the sphere is centred
  fieldHeight: 2.0, // metres above the floor its centre sits at
  fieldCore: 0.72, // 0..1 of the radius reversed at full strength
  fieldStrength: 1.0, // 0..1 master weight; 0 reverses nothing but this ability

  /* --- the wake: GroundField(RUT) --- */
  rutTime: 0.55, // seconds the gouge takes to reach the end of the line
  rutWidth: 0.72, // metres — half-width of the track
  rutDepth: 0.3, // metres it is sunk into the floor
  rutHeight: 0.02, // metres above the floor the quad sits at
  rutEdge: 0.22, // metres of feather on the head of the track
  rutRagged: 0.2, // how far the head wanders, fraction of the radius
  rutRaggedScale: 0.75, // lobes per metre on that wander
  rutWarp: 0.4, // metres of domain warp on those lobes
  rutRelief: 0.85, // how hard the height field tilts the fake normal
  rutNormalStep: 0.05, // metres between the height taps
  rutAmbient: 0.26, // floor on the diffuse term
  rutWrap: 0.4, // 0..1 wraps the terminator round the back
  rutSpecular: 0.22,
  rutGloss: 18.0, // Blinn exponent
  rutParallax: 0.3, // metres of view-driven offset on the interior detail
  rutSharp: 0.55, // 0..1 how hard the trough profile falls off
  rutChatter: 0.42, // metres between the transverse chatter marks
  rutChatterDepth: 0.5, // 0..1 how deep they cut
  rutSpoil: 0.11, // metres the spoil heaped along the lip stands proud
  rutSpoilWidth: 0.16, // metres wide that lip is
  rutDrift: 0.16, // how far the track wanders off the cast line
  rutEmissive: 0.35, // multiplier on every glowing term (there is almost none)
  rutOpacity: 0.95,
  rutDepthFade: 0.4, // metres of soft fade against standing geometry
  colorRutBase: '#4c4741', // the broken stone
  colorRutEdge: '#8f877a', // lips and highlights
  colorRutChurn: '#c8a878', // the freshly torn face
  colorRutDeep: '#14120f', // the bottom of the trough

  /* --- the debris: ShatterField --- */
  breakAt: 0.3, // seconds of the bent clock the first station gives way at
  breakGap: 0.16, // seconds between stations (there are six)
  breakShards: 13, // fragments thrown at one station
  shardSize: 0.2, // metres — the unit geometry's scale
  shardSizeJitter: 0.6, // ± fraction
  shardScatter: 0.28, // metres of scatter about the station
  shardHeight: 0.18, // metres the station sits above the floor
  shardSpeed: 5.4, // metres/second
  shardSpeedJitter: 0.55, // ± fraction
  shardSpread: 0.4, // 0 throws every fragment downrange, 1 is fully random
  shardUp: 0.72, // how much +Y is folded into the throw
  shardGravity: -19.0, // metres/second²
  shardDrag: 0.7, // 1/second
  shardSpin: 8.0, // radians/second of tumble
  shardSpinJitter: 0.75, // ± fraction
  shardShrink: 0.25, // 0..1 of its size lost by the end of life
  shardShrinkPower: 2.2, // how late that shrink bites
  shardFloor: 0.0, // metres — fragments rest on the floor
  shardFloorSpin: 0.18, // fraction of the tumble kept once grounded
  shardLife: 1.5, // seconds — MUST outlast turnAt − breakAt. See the header
  shardOpacity: 1.0,
  shardGlow: 0.12,
  shardRim: 0.5,
  shardRimPower: 2.6,
  shardShade: 0.75,
  shardAmbient: 0.3,
  shardFadeStart: 0.8, // 0..1 of life before it starts fading
  shardSoft: 0.3, // metres of soft intersection
  shardSceneMix: 0.0, // no scene sample: these are rock, not glass
  shardRefract: 0.0,
  shardSaturation: 0.9,
  colorShardA: '#6b6259', // lit face
  colorShardB: '#3a352f', // shaded face
  colorShardEdge: '#c9b492', // the broken edge
  colorShardScene: '#8f877a', // what a translucent one would show (unused at 0 mix)

  /* --- dust and grit --- */
  /**
   * Two systems, both on four-stop lifetime gradients (`A` at birth through `D`
   * as it dies), and both emitted **only while the clock is going forward** —
   * `reverseRate()` is the switch. A spawn is a log entry rather than a state
   * and a `RateEmitter` fed a negative step banks credit it dumps later, so the
   * reverse leg emits nothing at all and the region un-spawns what is already
   * there by driving each particle's own age back to zero at its emitter.
   */
  dustRate: 210, // dust drawn up along the head of the gouge, particles/second
  dustSize: 0.85,
  dustSpeed: 2.1, // metres/second
  dustLife: 1.6, // seconds — keep under the beat. See the header
  dustRise: 0.6, // metres/second
  dustSpread: 0.85, // cone
  dustOpacity: 0.1,
  dustTurbulence: 0.5,
  colorDustA: '#8a7f6e',
  colorDustB: '#6f6558',
  colorDustC: '#514a41',
  colorDustD: '#2b2723',

  gritRate: 90, // chips flicked out of the trough, particles/second
  gritSize: 0.05,
  gritSpeed: 4.6, // metres/second
  gritLife: 1.4, // seconds — keep under the beat
  gritGravity: -21.0, // metres/second²
  gritSpread: 0.7, // cone
  colorGritA: '#7a6f60',
  colorGritB: '#5c534a',
  colorGritC: '#3d3833',
  colorGritD: '#26221f',

  /* --- the turn: the one thing that does not reverse --- */
  turnBurstSize: 3.6, // the pressure shell that announces the turn, metres
  turnBurstIntensity: 1.0,
  turnFlash: 0.11, // screen flash
  turnShake: 0.3, // camera shake
  shakeDuration: 0.5, // seconds it decays over
  colorTurnA: '#8a7f6e', // burst shell
  colorTurnB: '#d9c49a', // burst body
  colorTurnC: '#ffeecb', // burst filaments
  colorTurnFlash: '#e8d8b4',

  /* --- casting --- */
  castFlash: 0.07, // screen flash as the front leaves the caster
  colorCastFlash: '#d9c49a',
  rumble: 0.03, // continuous shake while the gouge is opening

  /* --- dynamic light --- */
  lightIntensity: 15.0,
  lightRadius: 15.0,
  lightColor: '#d9a95e', // warm, and deliberately of a piece with `colorTurnB`
  lightSag: 0.35 // how far the key dips once the clock has turned over
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Rewind.
 *
 * **The beat** is the whole folder. Cast it, pause with **P** halfway through
 * the return, and drag `backRate`: the debris in the air re-flies from scratch
 * and the gouge re-closes to a different length, because `reverseTime()` is a
 * closed form over these five numbers and nothing was ever accumulated. That is
 * the difference between the closed form and `TimeWarpClock`, and it is the
 * reason the module's own doc says to prefer it.
 *
 * `fieldRadius` is the second thing to touch, and it is the one to touch with
 * *another* ability standing on the line: shrink it to four metres and only the
 * middle of the wake runs backwards while both ends carry on.
 */
export const rewindSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 300, 1, 'tear speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The beat': [
    ['forwardRate', 0, 3, 0.01, 'forward rate ×'],
    ['turnAt', 0.1, 5, 0.01, 'turn at (s)'],
    ['holdTime', 0, 1.5, 0.01, 'hold at the top (s)'],
    ['backRate', 0.1, 8, 0.05, 'reverse rate ×'],
    ['reachBack', -4, 0, 0.01, 'reach back to (s)'],
    ['settleTime', 0.05, 3, 0.05, 'settle (s)']
  ],
  'The sphere it reaches into': [
    ['fieldRadius', 0.5, 40, 0.1, 'radius (m)'],
    ['fieldAlong', 0, 1, 0.01, 'centre along the line'],
    ['fieldHeight', 0, 10, 0.05, 'centre height (m)'],
    ['fieldCore', 0, 0.98, 0.01, 'full-strength core'],
    ['fieldStrength', 0, 1, 0.01, 'grip']
  ],
  'The wake': [
    ['rutTime', 0.05, 4, 0.01, 'gouge time (s)'],
    ['rutWidth', 0.05, 4, 0.01, 'track half-width (m)'],
    ['rutDepth', 0, 1.5, 0.01, 'depth (m)'],
    ['rutHeight', 0.005, 0.2, 0.005, 'height above floor (m)'],
    ['rutEdge', 0.02, 2, 0.01, 'head feather (m)'],
    ['rutRagged', 0, 1, 0.01, 'head wander'],
    ['rutRaggedScale', 0.05, 3, 0.01, 'wander lobes / m'],
    ['rutWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['rutRelief', 0, 2, 0.01, 'relief'],
    ['rutNormalStep', 0.005, 0.4, 0.005, 'normal step (m)'],
    ['rutAmbient', 0, 1, 0.01, 'ambient'],
    ['rutWrap', 0, 1, 0.01, 'terminator wrap'],
    ['rutSpecular', 0, 2, 0.01, 'specular'],
    ['rutGloss', 1, 120, 1, 'gloss'],
    ['rutParallax', 0, 1.5, 0.01, 'parallax (m)'],
    ['rutSharp', 0, 1, 0.01, 'trough sharpness'],
    ['rutChatter', 0.05, 2, 0.01, 'chatter pitch (m)'],
    ['rutChatterDepth', 0, 1, 0.01, 'chatter depth'],
    ['rutSpoil', 0, 0.6, 0.005, 'spoil lip (m)'],
    ['rutSpoilWidth', 0, 0.6, 0.005, 'spoil width (m)'],
    ['rutDrift', 0, 1.5, 0.01, 'track drift'],
    ['rutEmissive', 0, 3, 0.01, 'emissive'],
    ['rutOpacity', 0, 1, 0.01, 'opacity'],
    ['rutDepthFade', 0.02, 3, 0.01, 'soft intersection (m)'],
    ['colorRutBase', 'broken stone'],
    ['colorRutEdge', 'lip'],
    ['colorRutChurn', 'torn face'],
    ['colorRutDeep', 'trough']
  ],
  'The debris': [
    ['breakAt', 0, 3, 0.01, 'first station at (s)'],
    ['breakGap', 0.01, 1, 0.005, 'between stations (s)'],
    ['breakShards', 0, 40, 1, 'fragments / station'],
    ['shardSize', 0.02, 1, 0.005, 'size (m)'],
    ['shardSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['shardScatter', 0, 2, 0.01, 'scatter (m)'],
    ['shardHeight', 0, 2, 0.01, 'station height (m)'],
    ['shardSpeed', 0, 25, 0.1, 'throw speed'],
    ['shardSpeedJitter', 0, 1, 0.01, 'speed jitter'],
    ['shardSpread', 0, 1, 0.01, 'throw spread'],
    ['shardUp', 0, 1, 0.01, 'up bias'],
    ['shardGravity', -60, 0, 0.1, 'gravity'],
    ['shardDrag', 0, 4, 0.01, 'drag'],
    ['shardSpin', 0, 30, 0.1, 'tumble'],
    ['shardSpinJitter', 0, 1, 0.01, 'tumble jitter'],
    ['shardShrink', 0, 1, 0.01, 'shrink'],
    ['shardShrinkPower', 0.2, 6, 0.05, 'shrink curve'],
    ['shardFloor', -1, 2, 0.01, 'rest height (m)'],
    ['shardFloorSpin', 0, 1, 0.01, 'grounded tumble'],
    ['shardLife', 0.2, 6, 0.05, 'lifetime (s) — must outlast the beat'],
    ['shardOpacity', 0, 1, 0.01, 'opacity'],
    ['shardGlow', 0, 2, 0.01, 'glow'],
    ['shardRim', 0, 3, 0.01, 'rim'],
    ['shardRimPower', 0.2, 8, 0.05, 'rim tightness'],
    ['shardShade', 0, 2, 0.01, 'shading'],
    ['shardAmbient', 0, 1, 0.01, 'ambient'],
    ['shardFadeStart', 0, 1, 0.01, 'fade starts at'],
    ['shardSoft', 0.02, 2, 0.01, 'soft intersection (m)'],
    ['shardSceneMix', 0, 1, 0.01, 'scene sample'],
    ['shardRefract', 0, 1, 0.01, 'refraction'],
    ['shardSaturation', 0, 2, 0.01, 'saturation'],
    ['colorShardA', 'lit face'],
    ['colorShardB', 'shaded face'],
    ['colorShardEdge', 'broken edge'],
    ['colorShardScene', 'scene tint']
  ],
  'Dust & grit': [
    ['dustRate', 0, 900, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 20, 0.1, 'dust speed'],
    ['dustLife', 0.1, 6, 0.05, 'dust lifetime (s)'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustSpread', 0, 1, 0.01, 'dust cone'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['gritRate', 0, 600, 1, 'grit rate'],
    ['gritSize', 0.005, 0.4, 0.005, 'grit size'],
    ['gritSpeed', 0, 25, 0.1, 'grit speed'],
    ['gritLife', 0.1, 5, 0.05, 'grit lifetime (s)'],
    ['gritGravity', -60, 0, 0.1, 'grit gravity'],
    ['gritSpread', 0, 1, 0.01, 'grit cone'],
    ['colorDust*', 'Dust colour'],
    ['colorGrit*', 'Grit colour']
  ],
  'The turn': [
    ['turnBurstSize', 0.2, 14, 0.05, 'burst size (m)'],
    ['turnBurstIntensity', 0, 4, 0.01, 'burst intensity'],
    ['turnFlash', 0, 1, 0.005, 'screen flash'],
    ['turnShake', 0, 2, 0.01, 'shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration (s)'],
    ['colorTurnA', 'burst shell'],
    ['colorTurnB', 'burst body'],
    ['colorTurnC', 'burst filaments'],
    ['colorTurnFlash', 'flash colour']
  ],
  'Casting': [
    ['castFlash', 0, 1, 0.005, 'release flash'],
    ['colorCastFlash', 'release flash colour'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 80, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightSag', 0, 1, 0.01, 'dip once time turns'],
    ['lightColor', 'light colour']
  ]
};
