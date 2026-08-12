import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* SHEET LIGHTNING — storm, far cast                                   */
/* ================================================================== */
/**
 * Intracloud lightning, seen from underneath.
 *
 * Almost nothing in this block describes something you look *at*. The
 * discharge itself is a fracture buried in a slab of mist fifteen metres up and
 * you never see it cleanly — what you see is the **rest of the stage** strobing,
 * because the pulse train is written to the scene's key light and every real
 * shadow in the world snaps with it.
 *
 * That is why the folder order below is what it is. `The strobe` and
 * `The world's key light` come first and everything else is scenery. If you are
 * tuning this slot, tune those two folders with the camera pointed at the
 * *character*, not at the cloud.
 *
 * ## The two numbers that carry it
 *
 * `flashWidth` and `strobeRate`. Sheet lightning is short pulses with real gaps
 * between them; widen the pulse past about 0.12 s and the whole thing turns into
 * a lamp being switched on, which is what a naive version of this looks like and
 * why the first draft was thrown away. The gap is doing as much work as the
 * flash — the same lesson Thunderclap's `gapTime` teaches, applied to light
 * rather than to sound.
 *
 * ## The exception to I5's "nothing is derived"
 *
 * `zoneRadius` drives the sheet's span, the cloud's footprint and where the
 * motes are seeded. That sharing *is* the design: the circle the aim indicator
 * drew before the click is the circle the storm happens over, and three numbers
 * that could disagree about it would be three ways to break the promise.
 */
export const sheetlightning = {
  /* --- the cast --- */
  range: 30.0, // maximum cast distance, metres
  minRange: 5.0, // closer than this and the cast is refused
  zoneRadius: 9.0, // the footprint the indicator draws, metres
  speed: 95.0, // how fast the charge front runs out to the zone, metres/second
  cooldown: 1.2, // seconds
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws
  fadeTime: 0.75, // seconds the cloud and the hook blend back out over

  /* --- the strobe: THE TRICK --- */
  /**
   * A pulse train evaluated from the ability's own clock every frame. Nothing
   * here is latched: `strobeRate` moves the pulse boundaries under a standing
   * cast, so pausing mid-train and dragging it walks the world's shadows
   * forward and backward through the strobe.
   */
  flashes: 5, // pulses in one strike
  strobeRate: 6.5, // pulses per second
  flashWidth: 0.06, // seconds one pulse stays lit — see the header
  flashDecay: 2.4, // exponent on a pulse's fall; >1 snaps off, <1 lingers
  flashVary: 0.5, // 0..1 how unequal the pulses in a train are
  doubleChance: 0.5, // 0..1 chance a pulse fires twice, as real strokes do
  doubleGap: 1.8, // where the second stroke lands, in flash widths
  doubleLevel: 0.62, // how bright that second stroke is, 0..1 of the first
  afterglow: 0.6, // seconds of dying glow after the last pulse
  afterglowLevel: 0.2, // how bright that tail starts, 0..1

  /* --- the world's key light --- */
  /**
   * Absolute intensities in the same units as `environment.sunIntensity`, and
   * deliberately absolute rather than multipliers on it: an ability that scaled
   * the environment's own number would read completely differently on a stage
   * that had been lit down, and the whole point of this slot is that the strobe
   * level is *authored*.
   *
   * `keyWeight` is the blend against `settings.environment`. At 0 the hook is
   * transparent and the editor's own sun sliders read straight through, which is
   * also exactly what the ability restores to when it ends.
   */
  keyFlash: 7.5, // sun intensity at the top of a pulse
  keyDark: 0.42, // ... in the gaps between pulses
  keyCharge: 0.6, // ... while the charge is still running out to the zone
  keyWeight: 1.0, // 0..1 blend against settings.environment
  armTime: 0.4, // seconds the charge dim takes to reach full weight
  releaseTime: 0.5, // seconds the hook blends back to the environment over
  colorKeyFlash: '#dfe6ff', // the sun's colour at the top of a pulse
  colorKeyDark: '#3a4a7a', // ... and in the gaps

  /* --- the discharge inside the cloud --- */
  sheetHeight: 15.0, // metres above the floor the main fracture runs at
  sheetSpan: 1.35, // its reach across the zone, × zoneRadius
  sheetSag: -1.4, // metres the trunk bows; negative droops out of the cloud
  sheetDrop: 2.6, // metres the cross-fracture sits below the main one
  strands: 8, // filaments in the main fracture
  crossStrands: 6, // ... in the cross-fracture
  feelerCount: 4, // short cracks hanging out of the cloud's belly
  feelerDrop: 7.0, // metres they reach down from the cross-fracture
  feelerFloor: 5.5, // metres below which a feeler is clamped — it never lands
  feelerSag: 0.5, // metres of bow on a feeler
  sheetIdle: 0.07, // 0..1 residual glow between pulses (ionised air)

  /* --- the shape of one fracture --- */
  crackAngle: 0.62, // radians a fork turns off its parent
  crackLength: 0.58, // fork length, fraction of its parent
  crackFalloff: 0.6, // how much shorter each generation is again
  crackSpread: 0.8, // 0..1+ variation in the fork angle
  crackStart: 0.16, // earliest point along a parent a fork may leave
  crackForkBias: 0.5, // 0..1 slides the branch/twig split

  /* --- the ribbon --- */
  sheetWidth: 0.05, // half-width of a filament, metres
  sheetGlowWidth: 7.5, // the halo, × the core width
  sheetGlowOpacity: 0.5,
  sheetJitter: 0.9, // metres of kink at the coarsest octave
  sheetJitterScale: 0.5, // kinks per metre
  sheetOctaves: 4, // 1–5
  sheetJitterFalloff: 0.55, // amplitude kept per octave
  sheetCrawl: 1.4, // how fast the kinks slide along
  sheetPinch: 0.18, // fraction of the span the ends are pulled straight over
  sheetRestrike: 30, // times/second the filaments re-roll their shape
  sheetFlicker: 0.35, // depth of the whole-sheet brightness stutter
  sheetFlickerSpeed: 40, // stutters/second
  sheetStrandFlash: 0.5, // how much individual filaments blink out
  sheetCoreSharp: 4.0, // how hard the hot core falls off across the ribbon
  sheetGlowFalloff: 2.2, // the same for the halo
  sheetSoftFade: 0.9, // metres of soft fade where a filament meets geometry
  sheetOpacity: 1.0,
  sheetGlow: 2.6, // emissive gain at the top of a pulse
  colorSheetCore: '#ffffff', // the centre of a filament
  colorSheetInner: '#dfe6ff',
  colorSheetOuter: '#9db4ff',
  colorSheetHalo: '#2a3a9c', // the wide glow the mist scatters

  /* --- the slab of cloud the fracture is buried in --- */
  cloudLift: 15.5, // metres to the centre of the slab
  cloudThickness: 5.2, // metres, top to bottom
  cloudSpan: 1.5, // its footprint, × zoneRadius
  cloudIdle: 0.16, // 0..1 emission floor between pulses
  ...volumeHullDefaults('cloud', Medium.MIST, {
    // MIST ships with no emission at all, because a mist is normally lit from
    // outside. This one is not: the emission *is* the sheet, so it is the key
    // the strobe drives and it needs a real value to be driven from.
    cloudEmission: 2.6,
    cloudEmissionCurve: 1.3,
    cloudDensity: 0.7,
    cloudNoiseFrequency: 0.34,
    cloudNoiseStrength: 0.7,
    cloudFlatten: 0.72, // a cloud base is pancaked; a spherical one reads as steam
    cloudRise: 0.1,
    cloudSwirl: 0.08,
    cloudSteps: 22,
    cloudFeather: 0.35,
    cloudColorCore: '#cfe0ff',
    cloudColorMid: '#7e93c4',
    cloudColorEdge: '#3d4a72',
    cloudColorDeep: '#151b30'
  }),

  /* --- what the light finds in the air --- */
  /**
   * Two systems, and both of them exist to be *revealed* rather than to be
   * looked at. The motes are the aerosol the flash catches and their rate is
   * multiplied by the pulse, so between pulses the air is empty; the haze is the
   * cloud's own ragged underside and it drifts continuously.
   */
  moteRate: 240, // motes/second at the top of a pulse
  moteSize: 0.05,
  moteSpeed: 0.8,
  moteLifetime: 1.3,
  moteRise: 0.3, // upward drift, metres/second
  moteTurbulence: 0.8,
  colorMoteA: '#ffffff',
  colorMoteB: '#dfe6ff',
  colorMoteC: '#7d9bff',
  colorMoteD: '#101a44',
  hazeRate: 26, // wisps/second under the cloud
  hazeSize: 2.2,
  hazeSpeed: 0.5,
  hazeLifetime: 3.4,
  hazeRise: 0.25,
  hazeOpacity: 0.13,
  colorHazeA: '#5a6a8c',
  colorHazeB: '#48566f',
  colorHazeC: '#333e52',
  colorHazeD: '#1b2230',

  /* --- the sound of it, such as we have --- */
  openShake: 0.22, // one small jolt when the sheet first fires
  openShakeTime: 0.7, // seconds it decays over
  rollRumble: 0.05, // continuous rumble weighted by the pulse

  /* --- dynamic light --- */
  // The pooled point light rides the same envelope as the sun, seated at the
  // sheet's own height so it rakes downward rather than lighting the floor flat.
  lightIntensity: 30,
  lightRadius: 28,
  lightColor: '#cdd8ff'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Sheet Lightning.
 *
 * Point the camera at the character, not at the cloud, and start with
 * `flashWidth`, `strobeRate` and `keyFlash`. Those three are the ability. The
 * cloud folders below them are forty sliders of scenery and none of them will
 * make the effect land if the strobe is wrong.
 */
export const sheetlightningSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 15, 0.1, 'min range'],
    ['zoneRadius', 2, 24, 0.1, 'zone radius'],
    ['speed', 5, 400, 1, 'charge speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['fadeTime', 0.1, 4, 0.01, 'blow-out time'],
    ['castAnim', 'cast animation']
  ],
  'The strobe': [
    ['flashes', 1, 16, 1, 'pulses'],
    ['strobeRate', 0.5, 24, 0.1, 'pulses / sec'],
    ['flashWidth', 0.005, 0.4, 0.005, 'pulse width (s)'],
    ['flashDecay', 0.2, 8, 0.05, 'pulse decay'],
    ['flashVary', 0, 1, 0.01, 'pulse variation'],
    ['doubleChance', 0, 1, 0.01, 'double-stroke chance'],
    ['doubleGap', 0.2, 5, 0.05, 'double-stroke gap'],
    ['doubleLevel', 0, 1.5, 0.01, 'double-stroke level'],
    ['afterglow', 0.05, 3, 0.01, 'afterglow (s)'],
    ['afterglowLevel', 0, 1, 0.01, 'afterglow level']
  ],
  "The world's key light": [
    ['keyFlash', 0, 40, 0.1, 'sun at the flash'],
    ['keyDark', 0, 8, 0.01, 'sun between pulses'],
    ['keyCharge', 0, 8, 0.01, 'sun while charging'],
    ['keyWeight', 0, 1, 0.01, 'blend vs environment'],
    ['armTime', 0.02, 3, 0.01, 'arm time (s)'],
    ['releaseTime', 0.05, 3, 0.01, 'release time (s)'],
    ['colorKeyFlash', 'sun at the flash'],
    ['colorKeyDark', 'sun between pulses']
  ],
  'The discharge': [
    ['sheetHeight', 3, 40, 0.1, 'fracture height'],
    ['sheetSpan', 0.2, 3, 0.01, 'span × radius'],
    ['sheetSag', -8, 8, 0.05, 'trunk bow'],
    ['sheetDrop', 0, 10, 0.05, 'cross-fracture drop'],
    ['strands', 1, 20, 1, 'main filaments'],
    ['crossStrands', 0, 20, 1, 'cross filaments'],
    ['feelerCount', 0, 12, 1, 'feelers'],
    ['feelerDrop', 0, 20, 0.1, 'feeler reach'],
    ['feelerFloor', 0, 20, 0.1, 'feeler floor'],
    ['feelerSag', -4, 4, 0.05, 'feeler bow'],
    ['sheetIdle', 0, 1, 0.005, 'glow between pulses']
  ],
  'The fracture shape': [
    ['crackAngle', 0, 1.6, 0.01, 'fork angle'],
    ['crackLength', 0.05, 1.5, 0.01, 'fork length'],
    ['crackFalloff', 0.05, 1.5, 0.01, 'generation falloff'],
    ['crackSpread', 0, 2, 0.01, 'angle variation'],
    ['crackStart', 0, 1, 0.01, 'earliest fork'],
    ['crackForkBias', 0, 1, 0.01, 'branch / twig split']
  ],
  'The ribbon': [
    ['sheetWidth', 0.005, 0.6, 0.005, 'filament width'],
    ['sheetGlowWidth', 1, 30, 0.1, 'halo width'],
    ['sheetGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['sheetJitter', 0, 4, 0.01, 'kink amplitude'],
    ['sheetJitterScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['sheetOctaves', 1, 5, 1, 'octaves'],
    ['sheetJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['sheetCrawl', -20, 20, 0.1, 'kink crawl'],
    ['sheetPinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['sheetRestrike', 0.5, 90, 0.5, 'restrikes / sec'],
    ['sheetFlicker', 0, 1, 0.01, 'brightness stutter'],
    ['sheetFlickerSpeed', 1, 120, 1, 'stutter rate'],
    ['sheetStrandFlash', 0, 1, 0.01, 'filament blink'],
    ['sheetCoreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['sheetGlowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['sheetSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['sheetOpacity', 0, 2, 0.01, 'opacity'],
    ['sheetGlow', 0, 10, 0.01, 'glow at the flash'],
    ['colorSheetCore', 'core'],
    ['colorSheetInner', 'inner'],
    ['colorSheetOuter', 'outer'],
    ['colorSheetHalo', 'halo']
  ],
  'The cloud': [
    ['cloudLift', 2, 40, 0.1, 'slab centre height'],
    ['cloudThickness', 0.5, 20, 0.1, 'slab thickness'],
    ['cloudSpan', 0.2, 4, 0.01, 'span × radius'],
    ['cloudIdle', 0, 1, 0.005, 'emission between pulses']
  ],
  ...volumeHullSchema('cloud', { label: 'The cloud' }),
  'Air & haze': [
    ['moteRate', 0, 1200, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 8, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 6, 0.05, 'mote lifetime'],
    ['moteRise', -3, 6, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['hazeRate', 0, 200, 1, 'haze rate'],
    ['hazeSize', 0.1, 8, 0.05, 'haze size'],
    ['hazeSpeed', 0, 6, 0.05, 'haze speed'],
    ['hazeLifetime', 0.2, 10, 0.05, 'haze lifetime'],
    ['hazeRise', -2, 4, 0.01, 'haze rise'],
    ['hazeOpacity', 0, 1, 0.005, 'haze opacity'],
    ['colorMote*', 'Mote colour'],
    ['colorHaze*', 'Haze colour']
  ],
  'Shake & dynamic light': [
    ['openShake', 0, 2, 0.01, 'opening jolt'],
    ['openShakeTime', 0.05, 3, 0.01, 'jolt decay (s)'],
    ['rollRumble', 0, 0.5, 0.005, 'rumble'],
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 60, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
