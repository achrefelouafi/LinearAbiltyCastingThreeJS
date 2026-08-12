/* ================================================================== */
/* RUNESEAL — Runic Seal                                               */
/* ================================================================== */
/**
 * A seal inscribed on the floor, which then goes off.
 *
 * The trick is **procedural letterforms**. Everything you can read on the floor
 * is a signed-distance field evaluated in metres by one fragment shader:
 * `vfx/GroundField.js`'s `RUNE` mode, which draws nested counter-rotating rings
 * of real glyphs — strokes with terminals, bowls with counters — struck through
 * by a chord armature, collared in tick marks and closed around a central
 * rosette. Nothing is a texture, nothing is a decal, and nothing was drawn by a
 * human: the alphabet is twenty-four stroke skeletons in JavaScript, unrolled
 * into straight-line GLSL at module load.
 *
 * Which is why the numbers below are **measurements and not proportions**.
 * `glyphSize` is the em box in metres, so widening `zoneRadius` gives you *more
 * runes* rather than bigger ones — the ring recomputes its slot count from its
 * own circumference every frame. `glyphStroke` is the half-width of a nib in
 * metres; `rule`, `armStroke` and `tickStroke` are the same measurement for the
 * three other kinds of line. Drag any of them with the clock stopped and the
 * standing seal re-inks itself.
 *
 * ### The one clock
 *
 * `inscribe` runs 0 → 1 once, and the seal spends it in three movements:
 * `armStart` is where the rings hand over to the armature, `sigilStart` is
 * where the armature hands over to the sigil. That is why the biggest mark on
 * the floor is always the last thing you watch finish. `ignite` then runs
 * outward from the middle, and `scorch` takes the fire back out of the ink and
 * leaves the writing as a scar.
 *
 * ### Where the keys come from
 *
 * Three sources, and the prefixes say which: bare keys are this ability's own,
 * `column*` is a `vfx/Tube.js` straight tube spread in by `tubeDefaults`, and
 * `wave*` is a `vfx/Shell.js` pressure shell spread in by `shellDefaults`. Both
 * of those are sliders the moment they land here, which is the point of the
 * prefixed-block convention.
 */

import { TubePath, tubeDefaults, tubeSchema } from '../../vfx/Tube.js';
import { ShellMode, shellDefaults, shellSchema } from '../../vfx/Shell.js';

export const runeseal = {
  /* --- the cast --- */
  range: 21.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 150.0, // how fast the scribe line reaches the point, metres/second
  zoneRadius: 4.6, // the seal's own radius, metres — the circle the aim drew
  cooldown: 1.7, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the four beats, in seconds --- */
  // These run off the cast's own age, not off the phase machine, so the seal
  // does not care how far downrange it was planted: a seal at 4 m and a seal at
  // 20 m inscribe at the same rate. `impactDuration` is their sum.
  inscribeTime: 1.25, // seconds the seal takes to draw itself
  igniteTime: 0.45, // seconds the ignition front takes to cross it
  dischargeTime: 0.9, // seconds the column and the ring are up for
  holdTime: 1.3, // seconds the scar smoulders before the quad starts to go
  fadeTime: 1.5, // seconds it takes to burn down to nothing but the decal

  /* --- where the scribe line runs --- */
  handHeight: 1.3, // metres above the floor the line leaves the caster at
  handForward: 0.5, // metres in front of the caster
  handSide: 0.2, // metres to the side (+ follows `Ability#side`)
  scribeLift: 0.05, // metres the line rides above the floor at the far end
  scribeRate: 1.1, // ink motes shed per metre of scribe travel

  /* ================================================================ */
  /* The seal — GroundField(RUNE)                                      */
  /* ================================================================ */

  /* --- the rings of glyphs --- */
  sealHeight: 0.02, // metres the quad floats above the floor
  rings: 3, // nested rings of runes, 1..4
  ringInner: 0.34, // innermost ring, as a fraction of zoneRadius
  glyphSize: 0.5, // metres — the em box. A measurement, not a proportion
  glyphStroke: 0.036, // metres — half-width of a nib stroke
  glyphGap: 1.3, // slot pitch, in glyph widths
  spin: 0.14, // radians/second, innermost ring
  spinFalloff: 0.55, // how much slower each ring out turns
  rule: 0.011, // metres — half-width of the compass circles

  /* --- the armature struck between the rings --- */
  armStart: 0.5, // 0..1 through the inscription the chords start being struck
  armRadius: 0.68, // the armature circle, as a fraction of zoneRadius
  armSides: 7, // chords struck around it — 7 is prime, so the star never closes early
  armTangent: 0.36, // apothem as a fraction of armRadius; 1 = a ring, 0 = through the middle
  armStroke: 0.019, // metres — half-width of a chord
  armPhase: 0.35, // radians — where the first chord starts
  armSpin: -0.05, // radians/second; negative so it turns against the inner ring

  /* --- the tick collar --- */
  tickCount: 64, // ticks around the outside
  tickRadius: 0.955, // collar radius, as a fraction of zoneRadius
  tickLength: 0.13, // metres — a minor tick
  tickStroke: 0.011, // metres — half-width of a tick
  tickMajor: 8, // every Nth tick is a long one
  tickMajorLen: 0.16, // metres of extra length on a major tick

  /* --- the central sigil, drawn last --- */
  sigilStart: 0.72, // 0..1 through the inscription the sigil starts
  sigilRadius: 0.38, // metres — how far each arm of the rosette sits out
  sigilSize: 0.78, // metres — its em box. Larger than glyphSize on purpose
  sigilArms: 5, // rotational symmetry of the rosette
  sigilStroke: 0.034, // metres — half-width of a sigil stroke
  sigilRing: 0.98, // metres — the ruled circle enclosing it
  sigilSpin: 0.07, // radians/second

  /* --- the incision and how it is lit --- */
  incision: 0.05, // metres the strokes are cut into the floor
  incisionWidth: 0.03, // metres of bevel on the walls of that cut
  relief: 0.85, // how hard the cut tilts the fake normal
  ambient: 0.26, // floor on the diffuse term
  wrap: 0.4, // 0..1 wraps the terminator round the back of the bevel
  specular: 0.55,
  gloss: 30, // Blinn exponent on the cut walls
  sealEdge: 0.5, // metres of feather on the seal's outer boundary
  sealRagged: 0.05, // how far that boundary wanders, as a fraction of the radius
  sealRaggedScale: 0.55, // lobes per metre
  sealWarp: 0.35, // metres of domain warp on those lobes
  sealEmissive: 1.25, // multiplier on every glowing term in the seal
  sealOpacity: 1.0,
  sealDepthFade: 0.45, // metres of soft fade where the seal meets standing geometry
  colorInk: '#ffd27a', // the substance of the writing
  colorRule: '#fff3d0', // the compass circles, the tick collar, the specular
  colorFire: '#ff8a2a', // everything that burns
  colorChar: '#2a1a0a', // the inside of the cut, and the scar it leaves

  /* ================================================================ */
  /* The discharge — Tube(STRAIGHT), prefix `column`                   */
  /* ================================================================ */

  columnHeight: 9.5, // metres the column stands, from the seal upward
  columnRise: 0.16, // seconds the column takes to reach full height
  columnCollapse: 2.4, // >1 holds the column and then drops it

  ...tubeDefaults('column', TubePath.STRAIGHT, {
    columnRadius: 0.36, // half-width at the top, metres
    columnRadiusNear: 0.92, // ...and where it stands on the seal
    columnRadiusCurve: 0.72, // <1 narrows fast off the floor, then holds
    columnFlare: 0.55, // the foot spreads where it meets the writing
    columnFlareWidth: 0.16,
    columnThrob: 0.06, // the column breathes
    columnThrobScale: 3.1,
    columnThrobSpeed: 2.4,
    columnWander: 0.05, // metres the axis drifts — a column of fire is not a pipe
    columnWanderScale: 1.6,
    columnWanderSpeed: 0.7,
    columnCoreWidth: 0.3,
    columnCoreFill: 0.85,
    columnCoreSharp: 1.5,
    columnEdgePower: 2.4,
    columnSheathWidth: 0.72,
    columnSheathRim: 1.1,
    columnSheathFill: 0.35,
    columnSheathOpacity: 0.6,
    columnHaloWidth: 2.3,
    columnHaloRim: 2.6,
    columnHaloOpacity: 0.34,
    columnRipple: 0.22,
    columnRippleBands: 2.6,
    columnRippleScale: 3.4,
    columnRippleSpeed: 2.2,
    columnStreak: 0.85, // vertical filaments running up the shaft
    columnStreakSharp: 0.62,
    columnStreakScale: 7.5,
    columnStreakBands: 1.4,
    columnStreakGlow: 1.5,
    columnFlowSpeed: 6.5, // metres/second the detail runs *upward*
    columnBands: 3.2, // rings of light climbing the column
    columnBandSharp: 2.6,
    columnBandDepth: 0.4,
    columnBandSpeed: -1.6, // negative: the rings climb rather than fall
    columnMuzzleGlow: 2.4, // the hot foot standing on the seal
    columnMuzzleLength: 0.13,
    columnTipGlow: 0.6, // the top is where it lets go, so it is cooler
    columnTipLength: 0.2,
    columnColorCore: '#fffaf0',
    columnColorInner: '#ffd27a',
    columnColorOuter: '#ff8a2a',
    columnColorHalo: '#8a3a06',
    columnOpacity: 1.0,
    columnGlow: 2.6,
    columnSoftFade: 0.7
  }),

  /* ================================================================ */
  /* The ring — Shell(PRESSURE), prefix `wave`                         */
  /* ================================================================ */

  ...shellDefaults('wave', ShellMode.PRESSURE, {
    waveRadius: 0.5, // metres it starts at
    waveRadiusEnd: 11.0, // ...and ends at. Deliberately past the seal
    waveExpand: 4.5, // fast out, easing hard — a front, not a balloon
    waveHeight: 0.22, // × radius: squashed flat, so it reads as a ring on the floor
    waveLift: 0.06, // metres above the seal so it does not z-fight the writing
    waveDisplace: 0.05, // barely billowed; a pressure front is smooth
    waveNoiseScale: 2.4,
    waveNoiseSpeed: 0.9,
    waveTurbulence: 1.0,
    waveFill: 0.03, // almost nothing but rim
    waveRim: 1.7,
    waveRimPower: 3.2,
    waveDissolve: 1.3,
    waveOpacity: 0.85,
    waveGlow: 1.6,
    waveSoftFade: 0.6,
    waveColorBody: '#8a4a10',
    waveColorRim: '#ffb44a',
    waveColorEdge: '#fff3d0'
  }),

  /* ================================================================ */
  /* Particles                                                         */
  /* ================================================================ */
  /**
   * Three systems, each with its own four-stop lifetime gradient (`A` at birth
   * through `D` as it dies) rather than a tint taken off the seal palette — so
   * the embers can be made to cool to red while the writing stays gold.
   */

  /* --- embers thrown off the strokes as the ignition front crosses them --- */
  emberRate: 220, // particles/second while the seal burns
  emberDischargeRate: 520, // ...and while the column is up
  emberSize: 0.11,
  emberSpeed: 3.4,
  emberLifetime: 1.1,
  emberRise: 2.6, // upward drift, metres/second (positive: they lift)
  emberStretch: 0.16, // how far an ember smears along its velocity
  emberInset: 0.12, // fraction of the radius the ember band is held inside the rim
  colorEmberA: '#fff6df',
  colorEmberB: '#ffd27a',
  colorEmberC: '#ff8a2a',
  colorEmberD: '#5c1c02',

  /* --- the slow gold motes hanging over the writing --- */
  moteRate: 95,
  moteSize: 0.06,
  moteSpeed: 1.0,
  moteLifetime: 2.1,
  moteRise: 0.85, // metres/second
  moteTurbulence: 0.65,
  colorMoteA: '#ffffff',
  colorMoteB: '#ffd27a',
  colorMoteC: '#ff8a2a',
  colorMoteD: '#2a1a0a',

  /* --- char smoke, once the fire has gone through the ink --- */
  smokeRate: 46,
  smokeSize: 1.1,
  smokeSpeed: 1.0,
  smokeLifetime: 2.6,
  smokeOpacity: 0.075,
  smokeRise: 0.5, // metres/second
  colorSmokeA: '#4a3a2c',
  colorSmokeB: '#3a2d22',
  colorSmokeC: '#2c2219',
  colorSmokeD: '#1a140f',

  /* ================================================================ */
  /* What is left on the floor                                         */
  /* ================================================================ */

  scorchRadius: 4.2, // metres — the burn the seal leaves behind
  scorchLife: 9.0, // seconds it lingers
  scorchIntensity: 0.6,
  colorScorch: '#140c05',
  colorSoot: '#7a4416', // the ember glow still in the scorch

  /* ================================================================ */
  /* Feedback                                                          */
  /* ================================================================ */

  igniteFlash: 0.12, // screen flash when the seal catches
  colorIgniteFlash: '#ffd27a',
  dischargeFlash: 0.34, // ...and when it goes off
  colorFlash: '#fff3d0',
  burstSize: 3.4, // metres — the shell thrown off at the discharge
  burstIntensity: 1.5,
  burstEmbers: 260, // extra embers at the discharge
  burstSmoke: 40,
  dischargeShake: 0.95,
  shakeDuration: 0.6,
  rumble: 0.022, // continuous shake while the seal inscribes
  colorBurstA: '#ff8a2a',
  colorBurstB: '#ffd27a',
  colorBurstC: '#fffaf0',

  /* --- dynamic light --- */
  lightIntensity: 22,
  lightRadius: 15,
  lightColor: '#ffb44a',
  lightHeight: 0.28, // 0..1 up the column the light sits once it is standing
  lightPulse: 0.16, // depth of the light's slow swell, 0 = steady
  lightPulseSpeed: 3.4 // swells/second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Runic Seal.
 *
 * The four folders worth reaching for first are **The rings**, **The armature**,
 * **The tick collar** and **The sigil** — between them they are the whole
 * drawing, and every one of them redraws a seal that is already on the floor.
 * `glyphSize` against `zoneRadius` is the single most instructive pair: shrink
 * the em box and the rings fill with smaller, denser writing rather than
 * scaling what is already there.
 */

/**
 * The `column` and `wave` prefixes come from `vfx/Tube.js` and `vfx/Shell.js`,
 * and each module publishes the folders for the keys its *own mode* uses. The
 * rest of the block — a whip's loop parameters on a straight tube, a ring
 * train's spacing on a pressure shell — is still there, still a slider, and
 * would otherwise land in the editor's catch-all "More" folder next to this
 * ability's real controls.
 *
 * So the leftovers are collected here, by difference, into a folder that says
 * what they are. Computing the set rather than listing it is deliberate: a
 * hand-written list goes stale the first time either module gains a field, and
 * a stale list is worse than none because it looks maintained.
 */
const covered = (schema) =>
  new Set(Object.values(schema).flat().map((entry) => (Array.isArray(entry) ? entry[0] : entry)));

const columnSchema = tubeSchema('column', TubePath.STRAIGHT);
const waveSchema = shellSchema('wave', ShellMode.PRESSURE);
const columnCovered = covered(columnSchema);
const waveCovered = covered(waveSchema);

const inactive = Object.keys(runeseal).filter(
  (key) =>
    (key.startsWith('column') && key in tubeDefaults('column') && !columnCovered.has(key)) ||
    (key.startsWith('wave') && key in shellDefaults('wave') && !waveCovered.has(key))
);

export const runesealSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 10, 400, 1, 'scribe speed'],
    ['zoneRadius', 1, 14, 0.05, 'seal radius'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['inscribeTime', 0.15, 6, 0.01, 'inscribe time'],
    ['igniteTime', 0.05, 4, 0.01, 'ignite time'],
    ['dischargeTime', 0.05, 4, 0.01, 'discharge time'],
    ['holdTime', 0, 4, 0.01, 'hold time'],
    ['fadeTime', 0.1, 6, 0.01, 'burn-down time']
  ],
  'The scribe line': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['scribeLift', 0, 1.5, 0.01, 'line height at the seal'],
    ['scribeRate', 0.05, 8, 0.05, 'ink motes / metre']
  ],
  'The rings': [
    ['sealHeight', 0.002, 0.2, 0.001, 'quad height (m)'],
    ['rings', 1, 4, 1, 'rings'],
    ['ringInner', 0.05, 0.9, 0.01, 'innermost ring'],
    ['glyphSize', 0.1, 2, 0.005, 'em box (m)'],
    ['glyphStroke', 0.004, 0.2, 0.001, 'nib half-width (m)'],
    ['glyphGap', 0.6, 3, 0.01, 'slot pitch'],
    ['spin', -2, 2, 0.005, 'inner ring spin (rad/s)'],
    ['spinFalloff', 0, 3, 0.01, 'spin falloff'],
    ['rule', 0.002, 0.08, 0.001, 'compass circle (m)']
  ],
  'The armature': [
    ['armStart', 0.05, 0.9, 0.01, 'starts at'],
    ['armRadius', 0.1, 1, 0.005, 'chord circle'],
    ['armSides', 3, 16, 1, 'chords'],
    ['armTangent', 0, 0.98, 0.005, 'tangent radius'],
    ['armStroke', 0.002, 0.12, 0.001, 'chord half-width (m)'],
    ['armPhase', 0, 6.2832, 0.01, 'first chord (rad)'],
    ['armSpin', -2, 2, 0.005, 'armature spin (rad/s)']
  ],
  'The tick collar': [
    ['tickCount', 6, 180, 1, 'ticks'],
    ['tickRadius', 0.2, 1.15, 0.005, 'collar radius'],
    ['tickLength', 0.01, 0.8, 0.005, 'minor tick (m)'],
    ['tickStroke', 0.002, 0.06, 0.0005, 'tick half-width (m)'],
    ['tickMajor', 1, 24, 1, 'every Nth is major'],
    ['tickMajorLen', 0, 0.8, 0.005, 'major extra (m)']
  ],
  'The sigil': [
    ['sigilStart', 0.1, 0.98, 0.01, 'starts at'],
    ['sigilRadius', 0, 3, 0.01, 'arm radius (m)'],
    ['sigilSize', 0.1, 3, 0.01, 'em box (m)'],
    ['sigilArms', 1, 12, 1, 'rosette arms'],
    ['sigilStroke', 0.004, 0.2, 0.001, 'stroke half-width (m)'],
    ['sigilRing', 0.05, 4, 0.01, 'enclosing circle (m)'],
    ['sigilSpin', -2, 2, 0.005, 'sigil spin (rad/s)']
  ],
  'The incision': [
    ['incision', 0, 0.5, 0.002, 'cut depth (m)'],
    ['incisionWidth', 0.002, 0.2, 0.001, 'bevel (m)'],
    ['relief', 0, 3, 0.01, 'relief'],
    ['ambient', 0, 1, 0.01, 'ambient'],
    ['wrap', 0, 1, 0.01, 'terminator wrap'],
    ['specular', 0, 3, 0.01, 'specular'],
    ['gloss', 1, 120, 1, 'gloss'],
    ['sealEdge', 0.01, 3, 0.01, 'boundary feather (m)'],
    ['sealRagged', 0, 1, 0.005, 'boundary wander'],
    ['sealRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['sealWarp', 0, 3, 0.01, 'lobe warp (m)'],
    ['sealEmissive', 0, 5, 0.01, 'seal emissive'],
    ['sealOpacity', 0, 2, 0.01, 'seal opacity'],
    ['sealDepthFade', 0.01, 3, 0.01, 'soft intersection (m)'],
    ['colorInk', 'the writing'],
    ['colorRule', 'circles & ticks'],
    ['colorFire', 'the burning'],
    ['colorChar', 'the cut & the scar']
  ],
  // Not 'The column': `tubeSchema` already publishes a folder by that name, and
  // two identical keys in one object literal is the later one silently winning.
  // The three keys below went missing into the editor's "More" folder for
  // exactly that reason.
  'The discharge': [
    ['columnHeight', 0.5, 40, 0.1, 'column height (m)'],
    ['columnRise', 0.01, 2, 0.005, 'rise time (s)'],
    ['columnCollapse', 0.2, 8, 0.01, 'collapse curve']
  ],
  ...columnSchema,
  ...waveSchema,
  'Prefixed keys this mode does not read': inactive,
  'Embers & motes': [
    ['emberRate', 0, 1200, 1, 'ember rate'],
    ['emberDischargeRate', 0, 2000, 1, 'ember rate (discharge)'],
    ['emberSize', 0.005, 0.6, 0.005, 'ember size'],
    ['emberSpeed', 0, 20, 0.05, 'ember speed'],
    ['emberLifetime', 0.05, 5, 0.01, 'ember lifetime'],
    ['emberRise', -8, 12, 0.05, 'ember rise'],
    ['emberStretch', 0, 2, 0.01, 'ember stretch'],
    ['emberInset', 0, 0.9, 0.01, 'ember band inset'],
    ['moteRate', 0, 600, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 10, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 6, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['colorEmber*', 'Ember colour'],
    ['colorMote*', 'Mote colour']
  ],
  'Smoke & the scar': [
    ['smokeRate', 0, 400, 1, 'smoke rate'],
    ['smokeSize', 0.05, 4, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['smokeRise', -2, 4, 0.01, 'smoke rise'],
    ['scorchRadius', 0.2, 14, 0.05, 'scorch radius'],
    ['scorchLife', 0.5, 30, 0.1, 'scorch lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'scorch intensity'],
    ['colorScorch', 'scorch'],
    ['colorSoot', 'scorch embers'],
    ['colorSmoke*', 'Smoke colour']
  ],
  'Ignition & discharge': [
    ['igniteFlash', 0, 2, 0.01, 'flash on ignition'],
    ['colorIgniteFlash', 'ignition flash colour'],
    ['dischargeFlash', 0, 2, 0.01, 'flash on discharge'],
    ['colorFlash', 'discharge flash colour'],
    ['burstSize', 0.2, 14, 0.05, 'burst size'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['burstEmbers', 0, 900, 1, 'burst embers'],
    ['burstSmoke', 0, 300, 1, 'burst smoke'],
    ['dischargeShake', 0, 3, 0.01, 'discharge shake'],
    ['shakeDuration', 0.05, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.3, 0.002, 'inscribe rumble'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst filaments']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightHeight', 0, 1, 0.01, 'light height up the column'],
    ['lightPulse', 0, 1, 0.01, 'light swell'],
    ['lightPulseSpeed', 0.1, 20, 0.1, 'swell rate'],
    ['lightColor', 'light colour']
  ]
};
