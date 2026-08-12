/* ================================================================== */
/* FIREWHIP — Ashen Lash                                               */
/* ================================================================== */
/**
 * A burning lash thrown along the aimed line, which **cracks**.
 *
 * The whole slot is built on one idea, and it is worth stating before the
 * numbers: the crack is not scheduled. `vfx/Tube.js`'s WHIP path carries a
 * Gaussian curvature lobe travelling handle → tip, and it conserves arc length
 * — the lateral throw of the loop is paid for out of the axial extent, so the
 * tip is hauled *back* while the loop is mid-whip and let go as the loop runs
 * off the end. Differentiating that curve with respect to its own driver gives
 * a tip speed that spikes, and when the spike crosses `lashCrackRatio × the
 * wave speed` the tube reports `crack.fired` for exactly one frame. The shock
 * ring is fired there, at the tip, on that frame.
 *
 * Which means **the three whip sliders below are the ability**. `lashWaveAmp`,
 * `lashWaveWidth` and `lashWaveGain` decide whether it cracks, how hard, and
 * where along the lash the bang happens; drag them mid-cast and the crack
 * moves. Two ranges are worth knowing:
 *
 *  - the loop eats `0.6267 × amp² / width` of the span while it travels, so
 *    `amp²/width` much above `0.55` yanks the tip back behind the caster and
 *    the lash reads as a rubber band rather than as leather. The shipped
 *    numbers peak at about a third of the span, which is roughly what a real
 *    whip does;
 *  - below about `amp = 0.6 × width` the tip never beats the wave and it stops
 *    cracking altogether. That is correct — a slack whip does not bang — but if
 *    the ring has gone missing, that is the first place to look.
 *
 * Every dimension here is resolved inside the update loop. The cast captures
 * one seed, the timestamp of the crack, and the crack's position as three
 * *fractions of the cast length* — never metres.
 */

import { TubePath, tubeDefaults, tubeSchema } from '../../vfx/Tube.js';
import { ShellMode, shellDefaults, shellSchema } from '../../vfx/Shell.js';

export const firewhip = {
  /* --- the cast --- */
  range: 17.0, // maximum cast distance, metres
  minRange: 2.5, // closer than this and the cast is refused
  speed: 64.0, // how fast the lash reaches full extension, metres/second
  windUp: 0.24, // seconds the loop spends forming at the handle before release
  windUpReach: 0.26, // how much of the lash exists while it winds up, 0..1 of the span
  lifetime: 1.0, // seconds the lash hangs at full extension — the crack lands in here
  fadeTime: 1.05, // seconds it takes to fall and burn out
  cooldown: 0.85,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the lash leaves the caster --- */
  // The base class puts the cast on the floor because that is what the aim
  // arrow targets; a whip comes out of a hand, so the handle is offset here.
  handHeight: 1.34, // metres above the floor
  handForward: 0.55, // metres in front of the caster
  handSide: 0.24, // metres to the side (+ follows `Ability#side`)
  tipHeight: 1.15, // height of the far end while the lash is up, metres
  fallHeight: 0.09, // ...and where it comes to rest once it has fallen, metres
  fallTime: 0.9, // seconds the fall takes, measured from the crack
  fallCurve: 2.1, // >1 holds the lash up and then drops it

  /* --- the lash itself: Tube(WHIP), prefix `lash` --- */
  ...tubeDefaults('lash', TubePath.WHIP, {
    lashRadius: 0.105, // half-width at the tip, metres — a whip is thin
    lashRadiusNear: 0.17, // ...and thicker in the hand
    lashRadiusCurve: 1.25, // stays fat out of the hand, then tapers late
    lashFlare: 0.0, // nothing blooms at the end of a whip
    lashFlareWidth: 0.1,
    lashThrob: 0.05, // the burning breathes a little
    lashThrobScale: 3.4,
    lashThrobSpeed: 2.2,
    lashWander: 0.025, // metres of low-frequency drift on the axis
    lashRipple: 0.18, // radial break-up — the lash is burning, not extruded
    lashRippleScale: 4.2,
    lashStreak: 1.15, // fire running down the leather
    lashStreakScale: 11.0,
    lashStreakSharp: 0.55,
    lashFlowSpeed: 9.0, // metres-of-parameter/second the fire runs at
    lashCoreWidth: 0.42,
    lashCoreFill: 0.9,
    lashSheathWidth: 1.0,
    lashHaloWidth: 2.1,
    lashHaloRim: 3.2,
    lashMuzzleGlow: 1.8, // the handle is the hottest part while it winds up
    lashMuzzleLength: 0.14,
    lashTipGlow: 2.6,
    lashTipLength: 0.05,
    /* the three that decide whether it cracks — see the header */
    lashWaveRate: 1.5, // loops per second travelling handle → tip
    lashWaveWidth: 0.2, // how tight the loop is, fraction of the span
    lashWaveAmp: 0.17, // lateral throw of the loop, fraction of the span
    lashWaveGain: 2.1, // how much the loop grows on its way to the tip, ×
    lashWaveCurve: 1.5, // when that growth happens, >1 = late
    lashWaveRoll: 0.85, // the plane it cracks in, radians (0 = vertical)
    lashSag: 0.38, // metres the lash hangs under its own weight
    lashCrackRatio: 1.0, // tip speed ÷ wave speed at which the crack fires
    lashGlow: 2.4,
    lashSoftFade: 0.5,
    lashColorCore: '#fff3d2', // the white-hot centre of the lash
    lashColorInner: '#ffc46a',
    lashColorOuter: '#ff7a1e',
    lashColorHalo: '#8a1c05' // the deep burnt bloom around it
  }),

  /* --- the shock ring: Shell(PRESSURE), prefix `crack` --- */
  // A squashed pressure shell whose axis is the lash's own heading, so it
  // reads as a ring standing perpendicular to the whip rather than as a ball.
  ...shellDefaults('crack', ShellMode.PRESSURE, {
    crackRadius: 0.14, // metres at the instant it fires
    crackRadiusEnd: 2.9, // ...and where it has got to when it dies
    crackExpand: 4.6, // fast, then easing out — a pressure front, not a balloon
    crackHeight: 0.16, // axial extent × radius: 0.16 is a lens, 1 is a ball
    crackLift: 0.0,
    crackDisplace: 0.06,
    crackNoiseScale: 2.4,
    crackFill: 0.03, // almost nothing but rim
    crackRim: 1.9,
    crackRimPower: 3.2,
    crackDissolve: 1.3,
    crackOpacity: 0.85,
    crackGlow: 1.7,
    crackSoftFade: 0.4,
    crackColorBody: '#8a1c05',
    crackColorRim: '#ffc46a',
    crackColorEdge: '#ffe9b0'
  }),
  crackLife: 0.45, // seconds the shock ring lives after it fires
  crackShake: 1.15, // camera shake at the crack, × the speed ratio it fired at
  crackShakeTime: 0.4, // seconds that shake decays over
  crackFlash: 0.24, // screen flash at the crack
  crackLight: 1.8, // light punch at the crack, × lightIntensity
  crackSparks: 130, // embers thrown out of the crack
  crackAshBurst: 55, // ash flakes blown off it
  crackBurstSize: 1.15, // the little fireball at the crack point, metres
  crackBurstIntensity: 1.7,
  colorCrackBurstA: '#8a1c05', // burst shell
  colorCrackBurstB: '#ff8a2a', // burst body
  colorCrackBurstC: '#ffe9b0', // burst filaments — the one carrying the read
  colorCrackFlash: '#ffe9b0', // the full-screen flash

  /* --- the release, and the snap at full extension --- */
  muzzleSize: 0.5, // the flare at the hand as the lash goes, metres
  muzzleIntensity: 1.6,
  castFlash: 0.09, // screen flash on release
  releaseSparks: 40, // embers thrown off the handle
  colorMuzzleA: '#8a1c05',
  colorMuzzleB: '#ff8a2a',
  colorMuzzleC: '#ffe9b0',
  colorCastFlash: '#ffb26a',
  snapShake: 0.45, // the thump as the lash reaches full extension
  snapShakeTime: 0.3,
  snapSparks: 70,
  rumble: 0.022, // continuous shake while the lash is out

  /* --- embers --- */
  /**
   * As in `thunder`: every system is coloured by a four-stop gradient sampled
   * over the particle's own lifetime, `A` at birth through `D` as it dies, and
   * spelled out rather than derived from the lash palette — so the embers can
   * be made to cool to red while the lash itself stays straw-white.
   */
  emberRate: 110, // embers shed off the lash, particles/second
  emberFallRate: 340, // ...and while it lies on the floor burning out
  emberSize: 0.1,
  emberSpeed: 2.2, // metres/second they leave the lash at
  emberSpread: 0.85, // how wide that cone is, 0..1
  emberLifetime: 1.5,
  emberGravity: -3.4, // metres/second² — embers are light
  emberStretch: 0.14, // how far one smears along its velocity
  colorEmberA: '#fff3d2',
  colorEmberB: '#ffb04a',
  colorEmberC: '#ff5a12',
  colorEmberD: '#5a1204',

  /* --- ash flakes, shed the whole way --- */
  ashRate: 70, // flakes/second off the lash
  ashSize: 0.11,
  ashSpeed: 1.5,
  ashSpread: 1.0,
  ashLifetime: 2.8,
  ashGravity: -1.0, // they flutter down rather than fall
  ashSpin: 4.2, // radians/second they tumble at
  ashTurbulence: 1.3, // how much the curl field pushes them about
  colorAshA: '#8a6a52',
  colorAshB: '#5d5048',
  colorAshC: '#3a332e',
  colorAshD: '#231f1c',

  /* --- smoke off the burn --- */
  smokeRate: 28, // puffs/second
  smokeSize: 0.9,
  smokeSpeed: 0.9,
  smokeLifetime: 2.4,
  smokeOpacity: 0.07,
  smokeRise: 0.7, // metres/second of buoyancy
  colorSmokeA: '#5a4a40',
  colorSmokeB: '#43382f',
  colorSmokeC: '#332c26',
  colorSmokeD: '#1e1a17',

  /* --- what the ground gets --- */
  scorchRate: 7.0, // burn marks laid per second while the lash lies burning
  scorchRadius: 0.42, // radius of one mark, metres
  scorchLife: 5.5, // seconds a mark lingers
  scorchIntensity: 0.5,
  colorScorch: '#120a06', // the burnt floor
  colorScorchEmber: '#ff6a1f', // the embers still alive in it

  /* --- dynamic light --- */
  lightIntensity: 20,
  lightRadius: 13,
  lightColor: '#ff8a3a',
  lightFlicker: 0.28, // depth of the ember gutter, 0 = steady
  lightFlickerSpeed: 17
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Ashen Lash.
 *
 * Reach for **The whip** first. Everything else on this ability decorates a
 * curve; those eight sliders *are* the curve, and the crack is a property of
 * it. `loop throw` and `loop width` against each other decide whether it bangs
 * at all; `loops/second` decides where along the beat it does.
 *
 * The tube and shell folders below are generated by the tech library from the
 * `lash` and `crack` prefixes, so they carry the same labels here as they do on
 * every other ability that mounts one.
 */
export const firewhipSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'lash speed'],
    ['windUp', 0, 1.5, 0.01, 'wind-up (s)'],
    ['windUpReach', 0.02, 1, 0.01, 'wind-up reach'],
    ['lifetime', 0.05, 4, 0.01, 'hang time'],
    ['fadeTime', 0.05, 4, 0.01, 'burn-out time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where it leaves the hand': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['tipHeight', 0, 4, 0.01, 'tip height'],
    ['fallHeight', 0, 3, 0.01, 'resting height'],
    ['fallTime', 0.05, 4, 0.01, 'fall time'],
    ['fallCurve', 0.2, 6, 0.01, 'fall curve']
  ],
  ...tubeSchema('lash', TubePath.WHIP),
  ...shellSchema('crack', ShellMode.PRESSURE),
  'The crack': [
    ['crackLife', 0.05, 3, 0.01, 'ring lifetime'],
    ['crackShake', 0, 4, 0.01, 'crack shake'],
    ['crackShakeTime', 0.05, 2, 0.01, 'shake duration'],
    ['crackFlash', 0, 2, 0.01, 'screen flash'],
    ['crackLight', 0, 6, 0.01, 'light punch'],
    ['crackSparks', 0, 600, 1, 'crack embers'],
    ['crackAshBurst', 0, 300, 1, 'crack ash'],
    ['crackBurstSize', 0.05, 6, 0.05, 'fireball size'],
    ['crackBurstIntensity', 0, 5, 0.01, 'fireball intensity'],
    ['colorCrackBurstA', 'fireball shell'],
    ['colorCrackBurstB', 'fireball body'],
    ['colorCrackBurstC', 'fireball filaments'],
    ['colorCrackFlash', 'crack flash colour']
  ],
  'Release & snap': [
    ['muzzleSize', 0.05, 4, 0.05, 'handle flare size'],
    ['muzzleIntensity', 0, 5, 0.01, 'handle flare intensity'],
    ['castFlash', 0, 2, 0.01, 'release flash'],
    ['releaseSparks', 0, 400, 1, 'release embers'],
    ['snapShake', 0, 3, 0.01, 'extension thump'],
    ['snapShakeTime', 0.05, 2, 0.01, 'thump duration'],
    ['snapSparks', 0, 400, 1, 'extension embers'],
    ['rumble', 0, 0.3, 0.002, 'travel rumble'],
    ['colorMuzzleA', 'handle shell'],
    ['colorMuzzleB', 'handle body'],
    ['colorMuzzleC', 'handle arcs'],
    ['colorCastFlash', 'release flash colour']
  ],
  'Embers': [
    ['emberRate', 0, 800, 1, 'ember rate'],
    ['emberFallRate', 0, 1200, 1, 'ember rate (burn-out)'],
    ['emberSize', 0.005, 0.6, 0.005, 'ember size'],
    ['emberSpeed', 0, 20, 0.05, 'ember speed'],
    ['emberSpread', 0, 1, 0.01, 'ember spread'],
    ['emberLifetime', 0.1, 5, 0.05, 'ember lifetime'],
    ['emberGravity', -30, 5, 0.1, 'ember gravity'],
    ['emberStretch', 0, 2, 0.01, 'ember stretch'],
    ['colorEmber*', 'Ember colour']
  ],
  'Ash & smoke': [
    ['ashRate', 0, 500, 1, 'ash rate'],
    ['ashSize', 0.005, 0.6, 0.005, 'ash size'],
    ['ashSpeed', 0, 10, 0.05, 'ash speed'],
    ['ashSpread', 0, 1, 0.01, 'ash spread'],
    ['ashLifetime', 0.1, 8, 0.05, 'ash lifetime'],
    ['ashGravity', -12, 4, 0.05, 'ash gravity'],
    ['ashSpin', 0, 20, 0.1, 'ash tumble'],
    ['ashTurbulence', 0, 4, 0.01, 'ash turbulence'],
    ['smokeRate', 0, 300, 1, 'smoke rate'],
    ['smokeSize', 0.05, 4, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['smokeRise', -2, 4, 0.01, 'smoke rise'],
    ['colorAsh*', 'Ash colour'],
    ['colorSmoke*', 'Smoke colour']
  ],
  'Burns on the ground': [
    ['scorchRate', 0, 40, 0.1, 'marks / second'],
    ['scorchRadius', 0.05, 4, 0.05, 'mark radius'],
    ['scorchLife', 0.5, 20, 0.1, 'mark lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'mark intensity'],
    ['colorScorch', 'scorch'],
    ['colorScorchEmber', 'scorch embers']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightFlicker', 0, 1, 0.01, 'ember gutter'],
    ['lightFlickerSpeed', 1, 60, 1, 'gutter rate'],
    ['lightColor', 'light colour']
  ]
};
