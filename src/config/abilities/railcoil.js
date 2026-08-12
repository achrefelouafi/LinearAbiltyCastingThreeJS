/* ================================================================== */
/* RAILCOIL — the shot that is already there                           */
/* ================================================================== */
/**
 * A rail shot with **zero travel time**, and every number below exists to
 * serve that one idea.
 *
 * The beat structure is inverted against every other line cast in the sandbox.
 * There is no front racing down the line: `windUp` seconds are spent with the
 * shot at the caster while four helical coils collapse inward along the
 * barrel, and on the frame they meet the front goes from 0 to 1 in one step.
 * The full-length channel is simply *already there*, and everything after it is
 * decay — `flashHold` seconds at full white, then `lifetime + fadeTime` seconds
 * of an ionisation channel cooling to blue, sagging under its own weight and
 * breaking into disconnected segments.
 *
 * **The two colour sets are shared on purpose**, which is the one place this
 * block bends I5. `channelColor*` is the hot palette and `colorCool*` is the
 * cold one; the tube and the filaments both read the *same* blend of the two,
 * because they are not two effects that happen to match — they are one channel
 * drawn as a core and its threads, and a channel whose core and threads cool at
 * different rates is a bug rather than a look. The blend runs on `coolCurve`.
 *
 * **The decay clock is derived, never stored.** It is
 * `(age − windUp − flashHold) / (lifetime + fadeTime)`, so dragging `windUp`
 * with the clock stopped does not merely move the wind-up: it slides the whole
 * decay backwards and forwards through itself, which is the most direct proof
 * available that nothing here was captured at spawn.
 */

import { TubePath, tubeDefaults, tubeSchema } from '../../vfx/Tube.js';

export const railcoil = {
  /* --- the cast --- */
  range: 26.0, // maximum cast distance, metres — the longest line cast in the set
  minRange: 3.0, // closer than this and the cast is refused
  /**
   * Metres/second the front travels at — and the one dead number in the block,
   * because `advance()` is overridden and never reads it. Every settings block
   * carries `speed`, the HUD prints it and the harness checks it is positive,
   * so it stays; 900 is roughly what the barrel would imply if anything
   * integrated it, and nothing does. That is the whole ability.
   */
  speed: 900.0,
  windUp: 0.55, // seconds the coils take to collapse to the muzzle
  flashHold: 0.09, // seconds the shot stands at full white before it starts to die
  lifetime: 0.65, // seconds of the hot half of the decay
  fadeTime: 0.9, // seconds of the cold half — 1.55 s of decay in total
  cooldown: 1.5,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the barrel --- */
  // The shot leaves a rail held at the hip, not a hand held out in front, so
  // the muzzle sits further forward and lower than the bolt's does.
  handHeight: 1.24, // metres above the floor
  handForward: 0.45, // metres in front of the caster
  handSide: 0.2, // metres to the side (+ follows `Ability#side`)
  endHeight: 1.12, // height of the far end of the shot, metres
  barrelLength: 2.8, // metres of barrel the coils collapse along

  /* --- the coils, during the wind-up --- */
  coilCount: 4, // coils along the barrel, 1..4 (one filament role each)
  coilFilaments: 3, // filaments in one coil
  coilSpan: 0.3, // how much of the barrel one coil covers at the start, 0..1
  coilRadius: 0.6, // metres a coil starts at
  coilRadiusEnd: 0.07, // ...and where it has closed to when they meet
  coilTurns: 2.6, // turns of the helix over its own span
  coilSpin: 3.4, // revolutions/second it rolls at
  coilSpread: 0.55, // phase offset between the filaments of one coil, turns
  coilTaper: 1.0, // how the radius runs from one end of a coil to the other
  coilGather: 2.2, // >1 holds the coils apart and then rushes them together
  coilKink: 0.5, // × the shared kink amplitude
  coilWidth: 0.85, // × the shared ribbon width
  coilDim: 0.95, // how bright a coil is against the channel
  coilLift: 0.0, // metres the coils bow upward over their own span

  /* --- the residual coil, after the shot --- */
  // Current does not stop the instant the shot leaves: one coil survives, wound
  // around the whole channel, unwinding as it dies. It is also what keeps the
  // coil sliders live during the decay, which is the beat you can actually
  // pause and look at.
  ringdownFilaments: 4,
  ringdownRadius: 0.4, // metres it stands off the channel at the start
  ringdownTurns: 7.0, // turns over the length of the shot
  ringdownSpin: -2.6, // revolutions/second, against the coils' direction
  ringdownLife: 0.6, // fraction of the decay it survives
  ringdownDim: 0.7,

  /* --- the ionisation channel: Tube(STRAIGHT), prefix `channel` --- */
  ...tubeDefaults('channel', TubePath.STRAIGHT, {
    channelRadius: 0.135, // half-width at the far end, metres
    channelRadiusNear: 0.165, // ...and at the muzzle: a rail shot is widest where it left
    channelRadiusCurve: 0.85,
    channelFlare: 0.0,
    channelFlareWidth: 0.1,
    channelThrob: 0.09, // the channel pulses as it dumps its charge
    channelThrobScale: 6.5,
    channelThrobSpeed: 5.5,
    channelWander: 0.045,
    channelWanderScale: 1.4,
    channelRipple: 0.22,
    channelRippleScale: 6.0,
    channelStreak: 1.35, // current running down the outside of the channel
    channelStreakScale: 15.0,
    channelStreakSharp: 0.62,
    channelFlowSpeed: 15.0,
    channelCoreWidth: 0.34,
    channelCoreFill: 1.0,
    channelCoreSharp: 1.6,
    channelSheathWidth: 1.0,
    channelSheathRim: 1.0,
    channelHaloWidth: 2.4,
    channelHaloRim: 3.6,
    channelHaloOpacity: 0.55,
    channelMuzzleGlow: 2.6,
    channelMuzzleLength: 0.07,
    channelTipGlow: 1.5,
    channelTipLength: 0.05,
    channelGlow: 2.8,
    channelSoftFade: 0.5,
    channelColorCore: '#ffffff', // the hot palette — see the header on sharing
    channelColorInner: '#dff2ff',
    channelColorOuter: '#a8e0ff',
    channelColorHalo: '#1a4fd0'
  }),

  /* --- how the channel dies --- */
  channelCollapse: 0.42, // fraction of the decay the tube's width collapses over
  coolCurve: 1.35, // >1 holds the white and then dumps it — the cooling ramp
  colorCoolCore: '#7fc4ff', // the cold palette the hot one is blended toward
  colorCoolInner: '#3f8ce8',
  colorCoolOuter: '#1a4fd0',
  colorCoolHalo: '#050e33',

  /* --- the break-up: the channel snapping into disconnected segments --- */
  segments: 3, // segments the channel breaks into, 1..3 (one filament role each)
  segmentFilaments: 4, // filaments in one segment
  segmentGap: 0.05, // fraction of the span left clear between segments
  segmentSpread: 0.09, // metres the filaments of one segment fan out by
  segmentKink: 1.0, // × the shared kink amplitude
  segmentWidth: 1.0, // × the shared ribbon width
  segmentFray: 1.6, // how much the kink grows as a segment dies
  dissolveNoise: 7.3, // spatial frequency of the dissolve noise along the span
  dissolveStagger: 0.6, // 0 = every segment dies together, 1 = strictly in turn
  dissolveTip: 0.16, // how soft the eaten end of a dying segment is, 0..1
  channelSag: 1.05, // metres the dead channel droops by the end
  channelSagCurve: 2.3, // >1 holds it straight and then lets it go

  /* --- the shared filament look (canonical keys, read by FilamentPaths) --- */
  width: 0.026, // half-width of one filament, metres
  glowWidth: 6.4, // the halo, × that width
  glowOpacity: 0.42,
  jitter: 0.14, // metres of kink at the coarsest octave
  jitterScale: 1.9, // kinks per metre
  octaves: 4, // 1–5; each halves the amplitude and doubles the rate
  jitterFalloff: 0.55,
  crawl: 3.6, // how fast the kinks slide along
  pinch: 0.13, // fraction of a filament its ends are pulled straight over
  restrike: 26, // whole re-shapes per second
  flicker: 0.28, // depth of the whole-bundle brightness stutter
  flickerSpeed: 36,
  strandFlash: 0.42, // how much individual filaments blink out
  coreSharp: 4.6, // exponent on a filament's edge falloff
  glowFalloff: 2.4,
  softFade: 0.7, // metres of soft fade where a filament meets geometry
  opacity: 1.0,
  glow: 2.4, // emissive gain into bloom

  /* --- the recoil --- */
  recoilShake: 2.4, // the hardest kick in the set, and the point of the slot
  recoilTime: 0.55, // seconds it decays over
  recoilFreq: 34, // Hz the shake rings at
  chargeShake: 0.05, // continuous rumble while the coils close
  fireFlash: 0.42, // screen flash on firing
  colorFireFlash: '#dff2ff',
  muzzleSize: 1.5, // the flare at the muzzle, metres
  muzzleIntensity: 2.2,
  colorMuzzleA: '#1a4fd0', // muzzle shell
  colorMuzzleB: '#a8e0ff', // muzzle body
  colorMuzzleC: '#ffffff', // muzzle filaments — the one carrying the read
  fireLight: 2.2, // light punch on firing, × lightIntensity

  /* --- the scorch line --- */
  // Thin and long: the floor under an ionisation channel does not get a crater,
  // it gets a hairline burn that lasts.
  scorchMarks: 14, // marks laid along the line at the instant of the shot
  scorchRadius: 0.3, // radius of one mark, metres
  scorchJitter: 0.35, // metres the marks wander off the axis
  scorchLife: 7.5, // seconds a mark lingers
  scorchIntensity: 0.55,
  colorScorch: '#06080f', // the burnt floor
  colorScorchEmber: '#3f8ce8', // the ionisation still glowing in it

  /* --- sparks, motes and haze --- */
  /**
   * Four-stop lifetime gradients, `A` at birth through `D` as it dies, spelled
   * out per system rather than derived from the channel palette — the sparks
   * are metal off the rail and are allowed to be warm while the channel is not.
   */
  fireSparks: 260, // sparks thrown out of the muzzle when it goes
  sparkRate: 130, // sparks shed off the channel while it is hot, particles/second
  sparkSize: 0.13,
  sparkSpeed: 11.0,
  sparkLifetime: 0.55,
  sparkGravity: -14.0,
  sparkStretch: 0.24, // how far a spark smears along its velocity
  colorSparkA: '#ffffff',
  colorSparkB: '#dff2ff',
  colorSparkC: '#5f9fe8',
  colorSparkD: '#12306b',
  moteRate: 150, // ionised motes drifting off the dying channel
  moteSize: 0.055,
  moteSpeed: 1.2,
  moteLifetime: 1.9,
  moteRise: 0.9, // upward drift, metres/second
  moteTurbulence: 0.9,
  colorMoteA: '#ffffff',
  colorMoteB: '#a8e0ff',
  colorMoteC: '#2f6fd0',
  colorMoteD: '#04143c',
  smokeRate: 34, // haze off the burnt air
  smokeSize: 0.85,
  smokeSpeed: 0.8,
  smokeLifetime: 2.6,
  smokeOpacity: 0.06,
  smokeRise: 0.6,
  colorSmokeA: '#4a5566',
  colorSmokeB: '#39424f',
  colorSmokeC: '#2a313a',
  colorSmokeD: '#181c22',

  /* --- dynamic light --- */
  lightIntensity: 30,
  lightRadius: 20,
  lightColor: '#8fc8ff',
  lightFlicker: 0.35, // depth of the gutter as the channel dies
  lightFlickerSpeed: 30
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Railcoil.
 *
 * `wind-up` and `flash hold` are the two that change what the ability *is*:
 * the first is how long you wait, the second is how long the shot reads as a
 * solid white bar before it starts to come apart. After that go to **The
 * break-up** — `dissolve stagger` at 0 kills the whole channel in one piece and
 * at 1 walks it out segment by segment, and everything about how the decay
 * reads sits between those two.
 *
 * The channel folders below are generated by the tech library from the
 * `channel` prefix, so they carry the same labels here as on any other tube.
 */
export const railcoilSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 2000, 5, 'front speed (unused)'],
    ['windUp', 0.05, 3, 0.01, 'wind-up (s)'],
    ['flashHold', 0, 1, 0.005, 'flash hold (s)'],
    ['lifetime', 0.05, 4, 0.01, 'hot decay (s)'],
    ['fadeTime', 0.05, 4, 0.01, 'cold decay (s)'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The barrel': [
    ['handHeight', 0, 3, 0.01, 'muzzle height'],
    ['handForward', -1, 3, 0.01, 'muzzle forward'],
    ['handSide', -1.5, 1.5, 0.01, 'muzzle lateral'],
    ['endHeight', 0, 4, 0.01, 'height at target'],
    ['barrelLength', 0.3, 8, 0.05, 'barrel length (m)']
  ],
  'The coils': [
    ['coilCount', 1, 4, 1, 'coils'],
    ['coilFilaments', 1, 8, 1, 'filaments / coil'],
    ['coilSpan', 0.02, 1, 0.01, 'coil span'],
    ['coilRadius', 0.02, 3, 0.01, 'start radius (m)'],
    ['coilRadiusEnd', 0.01, 2, 0.01, 'closed radius (m)'],
    ['coilTurns', 0.2, 10, 0.05, 'turns'],
    ['coilSpin', -12, 12, 0.05, 'spin (rev/s)'],
    ['coilSpread', 0, 2, 0.01, 'phase spread'],
    ['coilTaper', 0.05, 4, 0.01, 'radius curve'],
    ['coilGather', 0.2, 6, 0.01, 'collapse curve'],
    ['coilKink', 0, 3, 0.01, 'coil kink'],
    ['coilWidth', 0.05, 3, 0.01, 'coil width'],
    ['coilDim', 0, 2, 0.01, 'coil brightness'],
    ['coilLift', -1, 1, 0.01, 'coil bow (m)']
  ],
  'The ring-down': [
    ['ringdownFilaments', 0, 8, 1, 'filaments'],
    ['ringdownRadius', 0.01, 3, 0.01, 'stand-off (m)'],
    ['ringdownTurns', 0.2, 24, 0.1, 'turns'],
    ['ringdownSpin', -12, 12, 0.05, 'spin (rev/s)'],
    ['ringdownLife', 0.02, 1, 0.01, 'survives (× decay)'],
    ['ringdownDim', 0, 2, 0.01, 'brightness']
  ],
  ...tubeSchema('channel', TubePath.STRAIGHT),
  'The cooling': [
    ['channelCollapse', 0.02, 1, 0.01, 'width collapse'],
    ['coolCurve', 0.1, 6, 0.01, 'cooling curve'],
    ['colorCoolCore', 'cold core'],
    ['colorCoolInner', 'cold inner'],
    ['colorCoolOuter', 'cold outer'],
    ['colorCoolHalo', 'cold halo']
  ],
  'The break-up': [
    ['segments', 1, 3, 1, 'segments'],
    ['segmentFilaments', 1, 8, 1, 'filaments / segment'],
    ['segmentGap', 0, 0.3, 0.005, 'gap between segments'],
    ['segmentSpread', 0, 1, 0.005, 'fan (m)'],
    ['segmentKink', 0, 3, 0.01, 'segment kink'],
    ['segmentWidth', 0.05, 3, 0.01, 'segment width'],
    ['segmentFray', 0, 6, 0.01, 'fray as it dies'],
    ['dissolveNoise', 0.5, 40, 0.1, 'dissolve noise'],
    ['dissolveStagger', 0, 0.95, 0.01, 'dissolve stagger'],
    ['dissolveTip', 0.01, 0.6, 0.005, 'dissolve softness'],
    ['channelSag', 0, 4, 0.01, 'sag (m)'],
    ['channelSagCurve', 0.2, 6, 0.01, 'sag curve']
  ],
  'The filaments': [
    ['width', 0.002, 0.3, 0.001, 'width (m)'],
    ['glowWidth', 1, 20, 0.1, 'halo width'],
    ['glowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['jitter', 0, 2, 0.005, 'kink amplitude'],
    ['jitterScale', 0.05, 8, 0.01, 'kinks / metre'],
    ['octaves', 1, 5, 1, 'octaves'],
    ['jitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['crawl', -20, 20, 0.1, 'kink crawl'],
    ['pinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['restrike', 0.5, 90, 0.5, 'restrikes / sec'],
    ['flicker', 0, 1, 0.01, 'brightness stutter'],
    ['flickerSpeed', 1, 120, 1, 'stutter rate'],
    ['strandFlash', 0, 1, 0.01, 'filament blink'],
    ['coreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['glowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['softFade', 0.02, 3, 0.01, 'soft intersection'],
    ['opacity', 0, 2, 0.01, 'opacity'],
    ['glow', 0, 8, 0.01, 'glow']
  ],
  'The recoil': [
    ['recoilShake', 0, 6, 0.01, 'recoil'],
    ['recoilTime', 0.05, 3, 0.01, 'recoil duration'],
    ['recoilFreq', 4, 90, 1, 'recoil frequency'],
    ['chargeShake', 0, 0.5, 0.005, 'wind-up rumble'],
    ['fireFlash', 0, 2, 0.01, 'screen flash'],
    ['fireLight', 0, 6, 0.01, 'light punch'],
    ['muzzleSize', 0.05, 8, 0.05, 'muzzle flare size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle flare intensity'],
    ['colorFireFlash', 'flash colour'],
    ['colorMuzzleA', 'muzzle shell'],
    ['colorMuzzleB', 'muzzle body'],
    ['colorMuzzleC', 'muzzle arcs']
  ],
  'The scorch line': [
    ['scorchMarks', 0, 40, 1, 'marks'],
    ['scorchRadius', 0.05, 3, 0.01, 'mark radius'],
    ['scorchJitter', 0, 2, 0.01, 'mark wander'],
    ['scorchLife', 0.5, 20, 0.1, 'mark lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'mark intensity'],
    ['colorScorch', 'scorch'],
    ['colorScorchEmber', 'scorch glow']
  ],
  'Sparks & motes': [
    ['fireSparks', 0, 900, 1, 'muzzle sparks'],
    ['sparkRate', 0, 900, 1, 'spark rate'],
    ['sparkSize', 0.005, 0.8, 0.005, 'spark size'],
    ['sparkSpeed', 0, 40, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 4, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['moteRate', 0, 600, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 12, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 8, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['colorSpark*', 'Spark colour'],
    ['colorMote*', 'Mote colour']
  ],
  'Haze': [
    ['smokeRate', 0, 300, 1, 'haze rate'],
    ['smokeSize', 0.05, 4, 0.01, 'haze size'],
    ['smokeSpeed', 0, 8, 0.05, 'haze speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'haze lifetime'],
    ['smokeOpacity', 0, 1, 0.005, 'haze opacity'],
    ['smokeRise', -2, 4, 0.01, 'haze rise'],
    ['colorSmoke*', 'Haze colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightFlicker', 0, 1, 0.01, 'light gutter'],
    ['lightFlickerSpeed', 1, 90, 1, 'gutter rate'],
    ['lightColor', 'light colour']
  ]
};
