/* ================================================================== */
/* WASPFUNNEL — Wasp Funnel (hive, far cast)                           */
/* ================================================================== */
/**
 * A nest opens on the aimed circle and a funnel of wasps stands up out of it.
 *
 * **The surge is the ability.** Four keys — `waveAmp`, `waveLength`,
 * `waveSpeed` and `waveAlong` — put a *longitudinal* density wave through the
 * colony: every agent is displaced along the wave axis by a sine of its own
 * position on that axis, which crowds them at the zero crossings and thins them
 * at the extremes. Bands of higher density therefore travel up the funnel, the
 * way a real swarm surges, and they do it without anything being animated
 * globally and without a single agent being told where a band is.
 *
 * The first version of this modulated per-agent *opacity* on the same sine. It
 * looked like a strobing gradient painted over a static swarm, for the obvious
 * reason: density you can see is agents *arriving*, not agents brightening.
 * That mistake is now written into `vfx/Colony.js` so nobody repeats it.
 *
 * **Nothing here writes down a radius.** `vfx/Tube.js` in `FUNNEL` mode
 * publishes `radiusAt(tau)` — `throat + skirt(tau) + mouth(tau)` — and every
 * measurement in the ability that could have been its own slider is read off
 * that curve instead: the barrel of wasps is `radiusAt(barrel centre) ×
 * columnHug`, the crawlers cover `radiusAt(0) × crawlReach`, the pit in the
 * floor is `radiusAt(0) × pitReach`, the pollen leaves the mouth on a ring of
 * `radiusAt(1)`, and the grit is picked up at the skirt. Drag
 * `funnelSkirtFlare` with the clock stopped and all of them move together,
 * because there is only one of them.
 *
 * **The wasps sit in the barrel on purpose.** A funnel is a cone at both ends
 * and a cylinder in the middle, and `ColonySwarm`'s shape library has a column
 * but no cone. Rather than hide that, the colony is placed over exactly the
 * cylindrical section — `barrelFrom` to `barrelTo`, which want to sit inside
 * `funnelSkirtHeight`…`funnelMouthStart` — and the two flares are drawn by the
 * tube's own dust, the pit and the ejected pollen. A column of agents smeared
 * across a flaring profile is the version that looks wrong, and it looks wrong
 * everywhere at once.
 *
 * `zoneRadius` is the one measurement that is deliberately *not* the profile.
 * It is the aim circle, and what it promises is the ground the nest disturbs:
 * it drives where the grit is picked up from and how far the haze spreads. A
 * nest seen from above is a small dark mouth inside a much larger scuffed
 * patch, and those are the two numbers.
 */

import { TubePath, tubeDefaults, tubeSchema } from '../../vfx/Tube.js';

export const waspfunnel = {
  /* --- the cast --- */
  range: 19.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 26.0, // how fast the nest reaches the target circle, metres/second
  zoneRadius: 4.2, // the aim circle: the ground the nest disturbs, metres
  lifetime: 3.2, // seconds the funnel stands after it opens
  fadeTime: 1.6, // seconds it takes to sink back into the nest
  cooldown: 1.8,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the column --- */
  height: 6.4, // metres from the floor to the mouth
  baseHeight: 0.03, // metres the foot floats above the floor
  standTime: 0.7, // seconds the funnel takes to stand up out of the nest
  standTaper: 0.12, // width multiplier at the instant it opens, 0..1
  sinkTaper: 0.18, // width multiplier at the end of the collapse, 0..1
  sinkDrop: 0.55, // fraction of the height the mouth falls to as it dies
  lightRide: 0.4, // where on the column the dynamic light sits, 0..1

  /* ------------------------------------------------------------------ */
  /* THE SURGE — the density wave, and its three other consumers         */
  /* ------------------------------------------------------------------ */
  /**
   * `waveAlong` at 0 means the wave climbs, which is what a funnel does. The
   * crests travel at `waveSpeed` metres/second and sit `waveLength` metres
   * apart, so the beat you see arriving at the mouth is `waveSpeed /
   * waveLength` per second — worth knowing, because `surgeGain` fires a puff of
   * pollen on exactly that beat and `lightSurge` brightens the light on it. One
   * wave, three consumers, no second copy of the phase anywhere.
   */
  waveAmp: 0.5, // metres of longitudinal bunching — the whole read
  waveLength: 2.3, // metres between crests
  waveSpeed: 4.2, // metres/second the crests climb
  waveAlong: 0.0, // 0 the wave climbs, 1 it runs along the cast
  surgeGain: 0.85, // 0..1 how hard the mouth's pollen follows the crest
  lightSurge: 0.3, // 0..1 how hard the light follows it

  /* ------------------------------------------------------------------ */
  /* The funnel — vfx/Tube.js, prefix `funnel`, path FUNNEL              */
  /* ------------------------------------------------------------------ */
  /**
   * Spread verbatim from `tubeDefaults('funnel', TubePath.FUNNEL)` so the
   * module's own audit stays quiet; the keys belonging to `WHIP`, `VINE` and
   * `ARC` are inert on this path and are filed at the bottom of the editor
   * folder rather than hidden, because a key the panel cannot reach is a key
   * nobody can rule out.
   *
   * This tube is **not** the wasps. It is the pheromone haze and the dust the
   * colony holds in the air, so it is dim, wide and slow — `funnelOpacity` well
   * under half, a long `funnelFlowSpeed`, and a throat wide enough that the
   * barrel of agents sits comfortably inside it rather than poking through.
   */
  ...tubeDefaults('funnel', TubePath.FUNNEL, {
    funnelThroat: 0.85, // the waist of the nest column, metres
    funnelSkirtFlare: 1.9, // extra radius at the floor, metres
    funnelSkirtHeight: 0.2, // how far up the skirt reaches, fraction of height
    funnelSkirtCurve: 1.9,
    funnelMouthFlare: 2.6, // extra radius at the top, metres
    funnelMouthStart: 0.62, // where the mouth begins to open, fraction of height
    funnelMouthCurve: 1.5,
    funnelSpin: 0.7, // revolutions/second the haze turns
    funnelSpinTwist: 1.4, // extra revolutions from floor to mouth
    funnelSway: 0.3, // metres the axis precesses
    funnelSwayScale: 0.45,
    funnelSwaySpeed: 0.2,
    funnelSwayCurve: 2.0,
    funnelThrob: 0.05, // the haze breathes; the agents do the surging
    funnelThrobScale: 1.8,
    funnelThrobSpeed: 0.9,
    funnelWander: 0.06, // metres of low-frequency drift on the axis
    funnelWanderScale: 0.8,
    funnelWanderSpeed: 0.45,
    funnelRipple: 0.14, // radial break-up of the barrel
    funnelRippleBands: 2.2,
    funnelRippleScale: 2.6,
    funnelRippleSpeed: 1.4,
    funnelStreak: 0.8, // dust filaments climbing the surface
    funnelStreakSharp: 0.4,
    funnelStreakScale: 3.4,
    funnelStreakBands: 3.0,
    funnelStreakGlow: 0.5,
    funnelFlowSpeed: -2.4, // metres-of-parameter/second (negative = up)
    funnelBands: 0.0, // no rings: the density bands are the agents' job
    funnelCoreWidth: 0.3,
    funnelCoreFill: 0.35, // hollow — you have to be able to see through it
    funnelCoreSharp: 1.6,
    funnelEdgePower: 2.4,
    funnelSheathWidth: 1.0,
    funnelSheathRim: 1.0,
    funnelSheathFill: 0.12,
    funnelSheathOpacity: 0.55,
    funnelHaloWidth: 1.7,
    funnelHaloRim: 3.6,
    funnelHaloOpacity: 0.3,
    funnelMuzzleGlow: 0.7,
    funnelMuzzleLength: 0.16,
    funnelTipGlow: 0.9,
    funnelTipLength: 0.1,
    funnelOpacity: 0.42, // haze, not a beam
    funnelGlow: 0.55, // barely emissive — the nest is lit, not lit up
    funnelSoftFade: 0.7,
    funnelColorCore: '#e2d8a4', // dust in the throat
    funnelColorInner: '#b3a24e',
    funnelColorOuter: '#6d6a2a',
    funnelColorHalo: '#2a2a12' // the outer haze against the sky
  }),

  /* ------------------------------------------------------------------ */
  /* The colony in the barrel — vfx/Colony.js `ColonySwarm`              */
  /* ------------------------------------------------------------------ */
  wasps: 520, // live agents in the column (capped at 760)
  barrelFrom: 0.16, // bottom of the cylindrical section, fraction of height
  barrelTo: 0.72, // top of it — keep both inside skirtHeight…mouthStart
  columnHug: 1.0, // × the profile radius at the barrel's mid height
  condense: 0.9, // 0 pure flock, 1 pinned to the column
  shapeFill: 0.55, // 0 a sleeve of wasps, 1 a solid plug
  shapeSteps: 3, // gradient-descent steps onto the field, 1..4
  shapeSlack: 0.85, // fraction of each step taken
  shapeRough: 0.11, // unitless slop off the isosurface — a crowd, not a wall
  shapeSpin: 0.9, // radians/second the whole column turns
  latticeX: 11, // cells across
  latticeY: 8, // cells up
  latticeZ: 7, // ranks strung out behind the lead
  spacingSide: 0.4, // metres between lateral cells
  spacingUp: 0.4, // metres between vertical cells
  lag: 0.3, // seconds the back rank trails the lead by
  jitter: 0.16, // metres of per-agent slop off its own cell
  churn: 0.9, // radians/second the formation rolls
  breathe: 0.16, // fraction the formation swells by
  breatheRate: 2.1, // radians/second of that swell
  wander: 0.24, // metres of curl-noise drift
  wanderScale: 1.1, // features per metre of that drift
  wanderSpeed: 1.3, // how fast the drift field moves
  gather: 1.0, // 0 collapses every agent onto the lead's own path
  revealTime: 0.3, // seconds the colony takes to appear as the nest opens
  revealSpread: 0.45, // 0..1 width of that appearance wave

  /* --- one wasp --- */
  /**
   * `flapRate` is the second half of the trick and it is nearly free: the wing
   * fold runs on `sin(TAU · (flapRate · uTime + dice.y))`, and `dice.y` is per
   * agent, so five hundred wasps beat out of phase with no per-agent state and
   * nothing animated globally. `edgeGain` is what turns that into a shimmer —
   * a card going edge-on collapses to a line, and the line has to be *brighter*
   * than the plate was or the beat reads as a hole rather than as a flash.
   */
  size: 0.17, // metres, nose to tail
  aspect: 1.15, // wingspan / length
  sizeJitter: 0.4, // ±fraction of size
  sweep: 0.95, // how far the wings rake back
  dihedral: 0.62, // wing fold out of the card's plane, fraction of size
  wingCurl: 0.05, // static camber across the wing, fraction of size
  flapRate: 22.0, // wing-beats/second, per agent, out of phase
  bank: 0.05, // radians of roll per m/s² of lateral acceleration
  bankMax: 0.9, // radians
  billboard: 0.08, // 0 the agent's own frame, 1 camera-facing
  edgeStretch: 2.0, // how much an edge-on card grows so it stays a line
  edgeGain: 3.0, // how much brighter it gets while it is edge-on — the shimmer
  lit: 0.5, // 0 pure emissive, 1 wrapped diffuse

  /* --- the colony's colour --- */
  colorWaspA: '#ffe9a8', // birth end: a sunlit wing
  colorWaspB: '#e0a020', // wasp gold
  colorWaspC: '#6a4a12', // the dark of a banded abdomen
  colorWaspD: '#1a1408', // death end
  tint: 0.3, // where in that gradient the colony sits
  tintJitter: 0.42, // ±per-agent walk along it — the banding
  tintAlong: 0.35, // extra walk from head to tail
  opacity: 1.0,
  glow: 0.95, // emissive gain
  softFade: 0.3, // metres of soft fade where an agent meets geometry

  /* ------------------------------------------------------------------ */
  /* The crawlers on the nest mouth                                      */
  /* ------------------------------------------------------------------ */
  /**
   * A second `ColonySwarm`, condensed onto a *squashed ball* — which is a disc
   * — and pinned to the floor by `crawlCling`. They share the wasp's body and
   * gradient, because they are the same insect; the only thing they do not
   * share is where they are. Their disc is `radiusAt(0) × crawlReach`, so the
   * carpet on the ground grows and shrinks with the skirt above it.
   */
  crawlers: 180, // live agents on the ground (capped at 260)
  crawlReach: 1.25, // × the skirt radius the carpet covers
  crawlHeight: 0.09, // metres above the floor a crawler rides
  crawlCling: 0.95, // 0 flying, 1 pinned to the floor
  crawlCondense: 0.92, // how hard they are held to the disc
  crawlThickness: 0.16, // metres — half-height of the disc before the cling
  crawlLatticeX: 14, // cells across, for their own separation
  crawlLatticeZ: 12, // ranks
  crawlSpacing: 0.34, // metres between their cells
  crawlChurn: 0.35, // radians/second the carpet turns
  crawlJitter: 0.22, // metres of slop off a cell
  crawlSize: 0.85, // × the wasp size — the ones on the ground read smaller
  crawlOpacity: 1.0,
  crawlSwell: 1.7, // × their number as the column comes back down

  /* ------------------------------------------------------------------ */
  /* The nest mouth — vfx/GroundField.js, FUNNEL mode                    */
  /* ------------------------------------------------------------------ */
  pitReach: 1.15, // × the skirt radius the pit's rim sits at
  pitDepth: 0.85, // metres the throat reads as being below the floor
  pitSharp: 0.62, // 0..1 how steeply the wall falls away
  pitCell: 0.42, // metres — the size of a calved lip block
  pitCellJitter: 0.8, // 0..1 how irregular those blocks are
  pitSeam: 0.06, // metres of gap between them
  pitLipDrop: 0.1, // metres a lip block tilts in by
  pitSpoil: 0.07, // metres of chewed spoil heaped over the rim
  pitDetail: 0.7, // 0..1 grain on the walls
  pitGrowTime: 0.45, // seconds the mouth takes to open
  pitEdge: 0.3, // metres of feather on the growth front
  pitRagged: 0.3, // how far that front wanders, fraction of the radius
  pitRaggedScale: 0.9, // lobes per metre
  pitWarp: 0.4, // metres of domain warp on those lobes
  pitRelief: 0.85, // how hard the height field tilts the fake normal
  pitNormalStep: 0.05, // metres between the height taps
  pitAmbient: 0.26, // floor on the diffuse term
  pitWrap: 0.4, // 0..1 wraps the terminator round the back
  pitSpecular: 0.3,
  pitGloss: 22, // Blinn exponent
  pitParallax: 0.4, // metres of view-driven offset — the depth cue
  pitEmissive: 0.8, // multiplier on the glow down the throat
  pitOpacity: 1.0,
  pitDepthFade: 0.5, // metres of soft fade against standing geometry
  pitHeight: 0.014, // metres above the floor the quad sits at
  colorPitBase: '#6a6244', // the chewed ground
  colorPitEdge: '#b8ac72', // the calved lip
  colorPitGlow: '#c8a028', // what little light comes back up the throat
  colorPitDeep: '#141208', // the dark of it

  /* ------------------------------------------------------------------ */
  /* Pollen — thrown out of the mouth on the crest of each surge         */
  /* ------------------------------------------------------------------ */
  moteRate: 120, // particles/second at the crest
  moteSize: 0.05, // metres
  moteSpeed: 2.6, // metres/second
  moteLifetime: 1.7, // seconds
  moteRise: 0.35, // metres/second² of buoyancy
  moteTurbulence: 0.8,
  moteGlow: 1.5, // emissive gain
  colorMoteA: '#fff3c4',
  colorMoteB: '#e8c45c',
  colorMoteC: '#9a7c20',
  colorMoteD: '#2e2408',

  /* --- grit whipped up off the disturbed ground --- */
  gritRate: 90, // particles/second
  gritSize: 0.06, // metres
  gritSpeed: 3.0, // metres/second
  gritLifetime: 1.3, // seconds
  gritGravity: -8.0, // metres/second²
  gritSpin: 8.0, // radians/second of tumble
  colorGritA: '#cfc59a',
  colorGritB: '#9b8f5e',
  colorGritC: '#5f5836',
  colorGritD: '#241f12',

  /* --- haze at the foot --- */
  hazeRate: 40, // particles/second
  hazeSize: 0.9, // metres
  hazeSpeed: 1.2, // metres/second
  hazeLifetime: 2.6, // seconds
  hazeRise: 0.45, // metres/second² of buoyancy
  hazeOpacity: 0.45,
  hazeTurbulence: 0.6,
  colorHazeA: '#b8b092',
  colorHazeB: '#8d876c',
  colorHazeC: '#5c5844',
  colorHazeD: '#282620',

  /* ------------------------------------------------------------------ */
  /* Opening and collapse                                                */
  /* ------------------------------------------------------------------ */
  openSize: 2.2, // metres the burst of the nest opening reaches
  openIntensity: 0.9,
  openGrit: 90, // grit thrown by the opening
  openMotes: 70, // pollen thrown by the opening
  shockRadius: 3.8, // metres the ground ring reaches
  castFlash: 0.14, // screen flash as the nest opens
  impactShake: 0.4,
  shakeDuration: 0.55, // seconds the opening shake decays over
  impactFlash: 0.18,
  rumble: 0.05, // continuous shake while the funnel stands
  collapseGrit: 120, // grit thrown as the column sinks
  colorOpenA: '#e6d9a2', // the opening burst's shell
  colorOpenB: '#c09a2c', // its body
  colorOpenC: '#5f4a12', // its filaments
  colorShockA: '#e2d49a', // the ground ring's leading edge
  colorShockB: '#6d6428', // and its trail
  colorCastFlash: '#d8c66e',
  colorFlash: '#e0cf84',

  /* --- the dynamic light --- */
  lightColor: '#e5bf58', // nest gold
  lightIntensity: 1.7,
  lightRadius: 12.0, // metres
  lightFlicker: 0.12, // 0..1 depth of the wingbeat shimmer
  lightFlickerSpeed: 26.0 // shimmer steps/second
};

/** Editor layout. The surge comes first, because the surge is the ability. */
export const waspfunnelSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 2, 80, 0.5, 'travel speed'],
    ['zoneRadius', 0.5, 14, 0.1, 'aim circle (m)'],
    ['lifetime', 0.1, 8, 0.01, 'stand time'],
    ['fadeTime', 0.05, 6, 0.01, 'collapse time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The surge': [
    ['waveAmp', 0, 2, 0.01, 'bunching (m)'],
    ['waveLength', 0.2, 12, 0.05, 'crest spacing (m)'],
    ['waveSpeed', -20, 20, 0.1, 'crest speed (m/s)'],
    ['waveAlong', 0, 1, 0.01, 'climbs → runs down'],
    ['surgeGain', 0, 1, 0.01, 'pollen follows crest'],
    ['lightSurge', 0, 1, 0.01, 'light follows crest']
  ],
  // NOT 'The column': `tubeSchema` owns a folder of that name and it is spread
  // in below, so an identically named folder here would be silently replaced —
  // twenty-six controls vanished into "More" exactly once before this comment
  // was written.
  'The nest column': [
    ['height', 1, 20, 0.05, 'height (m)'],
    ['baseHeight', 0, 1, 0.005, 'foot float (m)'],
    ['standTime', 0.05, 4, 0.01, 'stand-up (s)'],
    ['standTaper', 0.01, 1, 0.01, 'width at open'],
    ['sinkTaper', 0.01, 1, 0.01, 'width at close'],
    ['sinkDrop', 0, 1, 0.01, 'mouth drop'],
    ['lightRide', 0, 1, 0.01, 'light height']
  ],
  ...tubeSchema('funnel', TubePath.FUNNEL),
  /**
   * The nineteen `Tube` keys that belong to WHIP, VINE and ARC. They are inert
   * on a FUNNEL and `tubeSchema` rightly does not file them — but a key the
   * panel cannot reach is a key nobody can rule out when something looks wrong,
   * so they are collected here at the bottom instead of being left to the
   * "More" folder's alphabetical soup.
   */
  'The funnel/Inert on this path': [
    ['funnelWaveRate', 0, 6, 0.01, 'whip: loops/second'],
    ['funnelWaveWidth', 0.02, 0.6, 0.001, 'whip: loop width'],
    ['funnelWaveAmp', 0, 1, 0.001, 'whip: loop throw'],
    ['funnelWaveGain', 0.2, 6, 0.01, 'whip: loop gain'],
    ['funnelWaveCurve', 0.1, 6, 0.01, 'whip: gain curve'],
    ['funnelWaveRoll', 0, 6.29, 0.01, 'whip: crack plane'],
    ['funnelSag', 0, 2, 0.01, 'whip: sag (m)'],
    ['funnelCrackRatio', 0.2, 4, 0.01, 'whip: crack ratio'],
    ['funnelTipTaper', 0.05, 6, 0.01, 'vine: tip taper'],
    ['funnelMeander', 0, 2, 0.01, 'vine: meander (m)'],
    ['funnelMeanderTurns', 0, 8, 0.01, 'vine: meander turns'],
    ['funnelRecoilAmp', 0, 1, 0.01, 'vine: recoil'],
    ['funnelRecoilFreq', 0, 10, 0.01, 'vine: recoil Hz'],
    ['funnelRecoilDamp', 0.1, 16, 0.01, 'vine: recoil damping'],
    ['funnelRecoilSway', 0, 4, 0.01, 'vine: recoil bow (m)'],
    ['funnelArcHeight', -12, 12, 0.01, 'arc: apex height (m)'],
    ['funnelArcLateral', -12, 12, 0.01, 'arc: apex offset (m)'],
    ['funnelArcBias', 0.05, 0.95, 0.01, 'arc: apex position'],
    ['funnelArcCurve', 0.1, 4, 0.01, 'arc: apex curve']
  ],
  'The colony': [
    ['wasps', 1, 760, 1, 'wasps'],
    ['barrelFrom', 0, 1, 0.01, 'barrel bottom'],
    ['barrelTo', 0, 1, 0.01, 'barrel top'],
    ['columnHug', 0.1, 3, 0.01, '× profile radius'],
    ['condense', 0, 1, 0.01, 'shape vs flock'],
    ['shapeFill', 0, 1, 0.01, 'sleeve → plug'],
    ['shapeSteps', 1, 4, 1, 'descent steps'],
    ['shapeSlack', 0.05, 1, 0.01, 'step relaxation'],
    ['shapeRough', 0, 0.5, 0.005, 'crowd slop'],
    ['shapeSpin', -6, 6, 0.01, 'column spin (rad/s)'],
    ['latticeX', 1, 20, 1, 'cells across'],
    ['latticeY', 1, 16, 1, 'cells up'],
    ['latticeZ', 1, 24, 1, 'ranks back'],
    ['spacingSide', 0.02, 3, 0.01, 'lateral spacing'],
    ['spacingUp', 0.02, 3, 0.01, 'vertical spacing'],
    ['lag', 0, 2.5, 0.01, 'rank lag'],
    ['jitter', 0, 1.5, 0.01, 'cell slop'],
    ['churn', -6, 6, 0.01, 'formation roll'],
    ['breathe', 0, 1.5, 0.01, 'swell'],
    ['breatheRate', 0, 8, 0.05, 'swell rate'],
    ['wander', 0, 1.5, 0.01, 'curl drift'],
    ['wanderScale', 0.05, 3, 0.01, 'drift features / m'],
    ['wanderSpeed', 0, 4, 0.01, 'drift speed'],
    ['gather', 0, 1, 0.01, 'collapse onto lead'],
    ['revealTime', 0.01, 3, 0.01, 'gather time'],
    ['revealSpread', 0.01, 1, 0.01, 'gather spread']
  ],
  'One wasp': [
    ['size', 0.02, 1, 0.005, 'size'],
    ['aspect', 0.3, 4, 0.01, 'span / length'],
    ['sizeJitter', 0, 1, 0.01, 'size jitter'],
    ['sweep', 0, 2, 0.01, 'wing rake'],
    ['dihedral', 0, 1.5, 0.01, 'wing fold'],
    ['wingCurl', -1, 1, 0.01, 'wing camber'],
    ['flapRate', 0, 60, 0.5, 'wing-beats / sec'],
    ['bank', 0, 0.5, 0.001, 'bank per m/s²'],
    ['bankMax', 0, 2, 0.01, 'max bank'],
    ['billboard', 0, 1, 0.01, 'camera facing'],
    ['edgeStretch', 1, 5, 0.01, 'edge-on stretch'],
    ['edgeGain', 0, 8, 0.01, 'edge-on gain'],
    ['lit', 0, 1, 0.01, 'diffuse mix']
  ],
  'Colony colour': [
    ['colorWasp*', 'Wasp gradient'],
    ['tint', 0, 1, 0.01, 'gradient position'],
    ['tintJitter', 0, 1, 0.01, 'per-agent walk'],
    ['tintAlong', 0, 1, 0.01, 'head-to-tail walk'],
    ['opacity', 0, 2, 0.01, 'opacity'],
    ['glow', 0, 4, 0.01, 'glow'],
    ['softFade', 0.02, 2, 0.01, 'soft intersection']
  ],
  'The crawlers': [
    ['crawlers', 0, 260, 1, 'crawlers'],
    ['crawlReach', 0.2, 4, 0.01, '× skirt radius'],
    ['crawlHeight', 0, 1, 0.005, 'ride height (m)'],
    ['crawlCling', 0, 1, 0.01, 'pinned to floor'],
    ['crawlCondense', 0, 1, 0.01, 'held to the disc'],
    ['crawlThickness', 0.02, 1, 0.01, 'disc half-height (m)'],
    ['crawlLatticeX', 1, 24, 1, 'cells across'],
    ['crawlLatticeZ', 1, 24, 1, 'ranks'],
    ['crawlSpacing', 0.02, 2, 0.01, 'cell spacing (m)'],
    ['crawlChurn', -4, 4, 0.01, 'carpet turn (rad/s)'],
    ['crawlJitter', 0, 1.5, 0.01, 'cell slop'],
    ['crawlSize', 0.2, 2, 0.01, '× wasp size'],
    ['crawlOpacity', 0, 2, 0.01, 'opacity'],
    ['crawlSwell', 1, 4, 0.01, 'number × on collapse']
  ],
  'The nest mouth': [
    ['pitReach', 0.2, 3, 0.01, '× skirt radius'],
    ['pitDepth', 0, 4, 0.01, 'depth (m)'],
    ['pitSharp', 0, 1, 0.01, 'wall steepness'],
    ['pitCell', 0.05, 2, 0.01, 'lip block (m)'],
    ['pitCellJitter', 0, 1, 0.01, 'block irregularity'],
    ['pitSeam', 0, 0.4, 0.005, 'block gap (m)'],
    ['pitLipDrop', 0, 0.6, 0.005, 'lip drop (m)'],
    ['pitSpoil', 0, 0.6, 0.005, 'spoil (m)'],
    ['pitDetail', 0, 1, 0.01, 'wall grain'],
    ['pitGrowTime', 0.05, 3, 0.01, 'opening (s)'],
    ['pitEdge', 0.02, 2, 0.01, 'front feather (m)'],
    ['pitRagged', 0, 1, 0.01, 'front wander'],
    ['pitRaggedScale', 0.05, 4, 0.01, 'lobes / m'],
    ['pitWarp', 0, 2, 0.01, 'domain warp (m)'],
    ['pitRelief', 0, 2, 0.01, 'relief'],
    ['pitNormalStep', 0.01, 0.4, 0.005, 'normal step (m)'],
    ['pitAmbient', 0, 1, 0.01, 'ambient'],
    ['pitWrap', 0, 1, 0.01, 'terminator wrap'],
    ['pitSpecular', 0, 2, 0.01, 'specular'],
    ['pitGloss', 1, 80, 1, 'gloss'],
    ['pitParallax', 0, 1, 0.01, 'parallax (m)'],
    ['pitEmissive', 0, 3, 0.01, 'emissive'],
    ['pitOpacity', 0, 1, 0.01, 'opacity'],
    ['pitDepthFade', 0.02, 2, 0.01, 'soft intersection'],
    ['pitHeight', 0.002, 0.1, 0.001, 'height off floor (m)'],
    ['colorPitBase', 'chewed ground'],
    ['colorPitEdge', 'calved lip'],
    ['colorPitGlow', 'light up the throat'],
    ['colorPitDeep', 'the dark of it']
  ],
  'Pollen': [
    ['moteRate', 0, 600, 1, 'pollen rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'pollen size'],
    ['moteSpeed', 0, 12, 0.05, 'pollen speed'],
    ['moteLifetime', 0.1, 6, 0.05, 'pollen lifetime'],
    ['moteRise', -2, 4, 0.01, 'pollen rise'],
    ['moteTurbulence', 0, 4, 0.01, 'pollen turbulence'],
    ['moteGlow', 0, 6, 0.01, 'pollen glow'],
    ['colorMote*', 'Pollen colour']
  ],
  'Grit': [
    ['gritRate', 0, 600, 1, 'grit rate'],
    ['gritSize', 0.005, 0.5, 0.005, 'grit size'],
    ['gritSpeed', 0, 20, 0.05, 'grit speed'],
    ['gritLifetime', 0.1, 6, 0.05, 'grit lifetime'],
    ['gritGravity', -30, 5, 0.1, 'grit gravity'],
    ['gritSpin', 0, 30, 0.1, 'grit tumble'],
    ['colorGrit*', 'Grit colour']
  ],
  'Haze': [
    ['hazeRate', 0, 400, 1, 'haze rate'],
    ['hazeSize', 0.05, 4, 0.01, 'haze size'],
    ['hazeSpeed', 0, 10, 0.05, 'haze speed'],
    ['hazeLifetime', 0.2, 8, 0.05, 'haze lifetime'],
    ['hazeRise', -2, 4, 0.01, 'haze rise'],
    ['hazeOpacity', 0, 1, 0.005, 'haze opacity'],
    ['hazeTurbulence', 0, 4, 0.01, 'haze turbulence'],
    ['colorHaze*', 'Haze colour']
  ],
  'Opening & collapse': [
    ['openSize', 0.05, 8, 0.05, 'opening burst size'],
    ['openIntensity', 0, 5, 0.01, 'opening burst intensity'],
    ['openGrit', 0, 600, 1, 'opening grit'],
    ['openMotes', 0, 600, 1, 'opening pollen'],
    ['shockRadius', 0.2, 14, 0.05, 'ground ring (m)'],
    ['castFlash', 0, 2, 0.01, 'opening flash'],
    ['impactShake', 0, 3, 0.01, 'opening shake'],
    ['shakeDuration', 0.05, 2, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'landing flash'],
    ['rumble', 0, 0.3, 0.002, 'standing rumble'],
    ['collapseGrit', 0, 600, 1, 'collapse grit'],
    ['colorOpenA', 'burst shell'],
    ['colorOpenB', 'burst body'],
    ['colorOpenC', 'burst filaments'],
    ['colorShockA', 'ring edge'],
    ['colorShockB', 'ring trail'],
    ['colorCastFlash', 'opening flash colour'],
    ['colorFlash', 'landing flash colour']
  ],
  'The light': [
    ['lightColor', 'light colour'],
    ['lightIntensity', 0, 8, 0.01, 'intensity'],
    ['lightRadius', 1, 40, 0.5, 'radius (m)'],
    ['lightFlicker', 0, 1, 0.01, 'wingbeat shimmer'],
    ['lightFlickerSpeed', 1, 60, 0.5, 'shimmer speed']
  ]
};
