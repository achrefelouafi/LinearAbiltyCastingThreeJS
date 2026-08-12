/* ================================================================== */
/* CYCLONE — aether, far cast                                          */
/* ================================================================== */
/**
 * A vortex touching down on the aimed circle: a dust whorl gathers, a funnel
 * stands up out of it, holds while it grinds the floor, and then ropes out from
 * the bottom upward.
 *
 * **The profile is one function.** `vfx/Tube.js` in `FUNNEL` mode publishes
 * `radiusAt(tau)` — `throat + skirt(tau) + mouth(tau)` — and *everything* in
 * this ability places itself against it: the debris ribbons ride
 * `radiusAt(ribbonTop)`, the flock circles `radiusAt(swarmRide)`, the dust skirt
 * is emitted on `radiusAt(0)`, and the ground scour is `radiusAt(0) × scourReach`.
 * There is no second copy of the vortex's shape anywhere in the ability, which
 * is why dragging `funnelSkirtFlare` moves the grooves in the floor, the dust
 * ring and the bottom of every ribbon at the same time — with the clock paused.
 *
 * The first version of this block had `skirtRadius` as its own slider on the
 * ability and `scourRadius` as another, exactly as the `Tube` docs warn. They
 * were never the same number twice: every time the profile was tuned the
 * grooves ended up either inside the dust or out in clean floor.
 *
 * `zoneRadius` is the one measurement that is *not* the profile, deliberately.
 * It is the aim circle, and what it promises is the floor the vortex is drawing
 * air off — so it drives the intake ribbons crawling in across the ground and
 * the radius the dust is picked up from. The funnel's own foot is smaller than
 * that, which is what a tornado looks like from above.
 *
 * Keys prefixed `funnel*` are the `Tube` contract (79 of them, spread verbatim
 * from `tubeDefaults('funnel', TubePath.FUNNEL)` so the module's audit stays
 * quiet); the ones belonging to `WHIP`, `VINE` and `ARC` are inert on this path
 * and are filed together at the bottom of the editor folder rather than hidden,
 * because a key the panel cannot reach is a key nobody can rule out.
 */
export const cyclone = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 26.0, // how fast the whorl races to the touchdown point, metres/second
  zoneRadius: 5.0, // the aim circle: floor the vortex draws air off, metres
  lifetime: 3.4, // seconds the funnel stands after touchdown
  fadeTime: 1.8, // seconds it takes to rope out
  cooldown: 2.0,
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the column --- */
  height: 7.6, // metres from the floor to the mouth
  baseHeight: 0.04, // metres the foot floats above the floor while standing
  spinUp: 0.6, // seconds the funnel takes to stand up out of the whorl
  touchTaper: 0.1, // width multiplier at the instant of touchdown, 0..1
  ropeLift: 0.78, // fraction of the height the foot climbs to as it dies
  ropeTaper: 0.22, // width multiplier at the end of the rope-out, 0..1
  lightRide: 0.35, // where on the column the dynamic light sits, 0..1

  /* ------------------------------------------------------------------ */
  /* The funnel — vfx/Tube.js, prefix `funnel`, path FUNNEL              */
  /* ------------------------------------------------------------------ */
  /**
   * `funnelThroat + funnelSkirtFlare` is the foot (3.5 m shipped) and
   * `funnelThroat + funnelMouthFlare` is the mouth (4.3 m). Those two sums are
   * the whole silhouette, and nothing else in the ability writes them down.
   */
  funnelThroat: 0.9, // the vortex waist, metres
  funnelSkirtFlare: 2.6, // extra radius at the floor, metres
  funnelSkirtHeight: 0.22, // how far up the skirt reaches, fraction of height
  funnelSkirtCurve: 1.8, // how abruptly it flares, >1 = tighter to the floor
  funnelMouthFlare: 3.4, // extra radius at the top, metres
  funnelMouthStart: 0.58, // where the mouth begins to open, fraction of height
  funnelMouthCurve: 1.5, // how abruptly it opens
  funnelSpin: 1.15, // revolutions per second the surface rotates
  funnelSpinTwist: 1.9, // extra revolutions from floor to mouth
  funnelSway: 0.55, // how far the axis precesses, metres
  funnelSwayScale: 0.4, // twist of the precession along the height
  funnelSwaySpeed: 0.18, // revolutions per second it precesses
  funnelSwayCurve: 2.0, // how much of the sway is at the top, >1 = only the top

  /* --- the surface --- */
  funnelThrob: 0.035, // breathing amplitude, × radius
  funnelThrobScale: 2.1, // pressure waves along the column, cycles per length
  funnelThrobSpeed: 1.1, // Hz they travel at
  funnelWander: 0.07, // smooth low-frequency drift of the axis, metres
  funnelWanderScale: 0.9, // drift features per length
  funnelWanderSpeed: 0.55, // Hz the drift crawls at
  funnelRipple: 0.16, // radial break-up of the barrel, × radius
  funnelRippleBands: 1.8, // break-up features around the barrel
  funnelRippleScale: 2.2, // break-up features along it
  funnelRippleSpeed: 2.0, // Hz it crawls downrange at
  funnelStreak: 1.1, // dust filaments streaming around the surface
  funnelStreakSharp: 0.62, // 0 = soft wash, 1 = hard threads
  funnelStreakScale: 2.6, // filament features per length
  funnelStreakBands: 3.4, // filament features around the barrel
  funnelStreakGlow: 0.7, // how hard the sheath's filaments burn to core colour
  funnelFlowSpeed: -3.2, // metres-of-parameter per second the filaments run (negative = up)
  funnelBands: 0.0, // rings along the length, cycles per length (0 = off)
  funnelBandSharp: 2.0, // how tight each ring is
  funnelBandDepth: 0.5, // how much they modulate alpha, 0..1
  funnelBandSpeed: 0.6, // Hz they travel at

  /* --- the three layers --- */
  funnelCoreWidth: 0.94, // core radius, × the profile
  funnelCoreFill: 0.14, // how solid the core reads — low, so the throat is a hole
  funnelCoreSharp: 1.4, // axis-weighting exponent — the inversion
  funnelEdgePower: 2.2, // rim-weighting exponent for the sheath
  funnelSheathWidth: 1.0, // sheath radius, × the profile
  funnelSheathRim: 1.05, // strength of the sheath's silhouette
  funnelSheathFill: 0.22, // how much body the sheath keeps
  funnelSheathOpacity: 0.92,
  funnelHaloWidth: 1.26, // halo radius, × the profile
  funnelHaloRim: 2.2, // rim exponent — high, so it is only a silhouette
  funnelHaloOpacity: 0.55,

  /* --- the ends --- */
  funnelMuzzleGlow: 0.9, // brightness where the column meets the floor
  funnelMuzzleLength: 0.14, // how far that glow reaches, fraction of length
  funnelTipGlow: 0.7, // brightness at the mouth
  funnelTipLength: 0.12, // how soft that edge is, fraction of length

  /* --- funnel colour & render --- */
  funnelColorCore: '#e8eef4', // the axis-weighted middle
  funnelColorInner: '#c0c8d0', // just off the middle — the lit dust
  funnelColorOuter: '#6a7480', // the sheath body
  funnelColorHalo: '#20262c', // the outer bloom
  funnelOpacity: 0.92,
  funnelGlow: 1.0, // emissive gain into bloom — dust does not burn
  funnelSoftFade: 0.7, // metres of depth fade against the opaque scene

  /* --- inert on FUNNEL: the profile, whip, vine and arc groups --- */
  // `Tube` reads the whole contract whatever its path, so these are here to
  // keep the module's audit quiet and to stay reachable in the panel. Dragging
  // one of them does nothing on this path, and that is the honest answer.
  funnelRadius: 0.62, // far half-width, metres (STRAIGHT/WHIP/ARC only)
  funnelRadiusNear: 0.22, // near half-width, metres
  funnelRadiusCurve: 0.7, // how late the radius opens
  funnelFlare: 0.0, // extra half-width where it lands, × radius
  funnelFlareWidth: 0.1, // how much of the far end flares, fraction of length
  funnelWaveRate: 1.35, // WHIP: loops per second
  funnelWaveWidth: 0.16, // WHIP: loop width, fraction of length
  funnelWaveAmp: 0.3, // WHIP: lateral throw, fraction of length
  funnelWaveGain: 2.2, // WHIP: growth of the loop toward the tip, ×
  funnelWaveCurve: 1.6, // WHIP: when that growth happens
  funnelWaveRoll: 0.0, // WHIP: crack plane, radians
  funnelSag: 0.12, // WHIP: hang under its own weight, metres
  funnelCrackRatio: 1.0, // WHIP: tip ÷ wave speed the crack fires at
  funnelTipTaper: 1.3, // VINE: how fast the radius falls to zero at the front
  funnelMeander: 0.18, // VINE: helical wander of the stem, metres
  funnelMeanderTurns: 1.4, // VINE: turns of that helix over the length
  funnelRecoilAmp: 0.35, // VINE: spring pull-back, fraction
  funnelRecoilFreq: 2.6, // VINE: Hz the spring rings at
  funnelRecoilDamp: 3.4, // VINE: s⁻¹ it dies at
  funnelRecoilSway: 0.6, // VINE: lateral bow while recoiling, metres
  funnelArcHeight: 2.6, // ARC: apex height above the chord, metres
  funnelArcLateral: 0.0, // ARC: apex offset across the chord, metres
  funnelArcBias: 0.5, // ARC: where the apex sits, 0..1
  funnelArcCurve: 1.0, // ARC: apex sharpness

  /* ------------------------------------------------------------------ */
  /* The ribbons — vfx/FilamentPaths.js, two SPIRAL_IN roles             */
  /* ------------------------------------------------------------------ */
  /**
   * Role 0 rides the wall: it spirals from `radiusAt(0)` at the foot up to
   * `radiusAt(ribbonTop)`, so it is welded to the profile at both ends. Role 1
   * is the intake, crawling in across the floor from the aim circle to the foot.
   */
  wallRibbons: 9, // debris ribbons riding the funnel wall (capped at 18)
  ribbonTop: 0.74, // how far up the wall they reach, fraction of height
  ribbonHug: 1.06, // how far off the wall they ride, × radiusAt at that height
  ribbonTurns: 2.6, // full turns from the foot to the top
  ribbonSpin: 0.85, // turns per second the whole spiral rotates
  ribbonCurve: 1.15, // >1 lingers wide near the floor before climbing
  ribbonPhase: 1.0, // how evenly the ribbons are spread around, 1 = evenly
  ribbonWobble: 0.22, // 0..1 radial wobble on the spiral
  intakeArms: 6, // ground ribbons crawling in from the aim circle (capped at 12)
  intakeLift: 0.45, // metres the intake spiral starts above the floor
  intakeFloor: 0.03, // metres the intake is clamped above the floor
  intakeTurns: 1.5, // full turns on the way in
  intakeSpin: 0.5, // turns per second they sweep round
  intakeCurve: 1.3, // >1 lingers out at the rim before diving in
  intakePhase: 1.0, // how evenly the arms are spread around
  intakeWobble: 0.34, // 0..1 radial wobble
  intakeDamp: 0.25, // how much the kink's world-y is damped, 0..1 (flat roles want 0.3)

  /* --- the ribbon itself --- */
  ribbonWidth: 0.028, // half-width of the core ribbon, metres
  ribbonGlowWidth: 5.4, // halo half-width, × the core width
  ribbonGlowOpacity: 0.4, // halo alpha relative to the core
  ribbonJitter: 0.28, // metres of lateral kink at the coarsest octave
  ribbonJitterScale: 1.1, // kinks per metre of path
  ribbonOctaves: 3, // 1–5; each halves the amplitude and doubles the rate
  ribbonJitterFalloff: 0.58, // amplitude kept per octave
  ribbonCrawl: 2.2, // how fast the kinks slide along, per second
  ribbonPinch: 0.14, // fraction of the path the ends are pulled straight over
  ribbonRestrike: 9, // whole re-shapes per second — dust, not lightning
  ribbonFlicker: 0.16, // 0..1 depth of the whole-bundle brightness stutter
  ribbonFlickerSpeed: 14, // steps per second that stutter is quantised to
  ribbonStrandFlash: 0.3, // 0..1 depth of the per-ribbon blink
  ribbonCoreSharp: 3.2, // exponent on the core's edge falloff
  ribbonGlowFalloff: 2.1, // the same for the halo
  ribbonSoftFade: 0.6, // metres of depth fade against the opaque scene
  ribbonOpacity: 0.8,
  ribbonGlow: 0.85, // emissive multiplier fed into bloom
  ribbonDim: 0.75, // how secondary the wall ribbons read, 0..1
  intakeDim: 0.5, // ... and the ground ones
  colorRibbonCore: '#e4eaf0', // the bright centre line of a ribbon
  colorRibbonInner: '#b3bdc8',
  colorRibbonOuter: '#6a7480',
  colorRibbonHalo: '#20262c', // the wide, dim atmosphere around it

  /* ------------------------------------------------------------------ */
  /* The flock — vfx/Swarm.js, LEAF silhouette on an ORBIT lead          */
  /* ------------------------------------------------------------------ */
  swarmCount: 110, // live agents (capped at 192)
  swarmRide: 0.42, // where the flock circles, fraction of the height
  swarmHug: 1.55, // its orbit radius, × radiusAt at that height
  swarmRate: 0.42, // orbits per second the lead makes
  swarmTurns: 1.0, // turns of the lead path per unit of its parameter
  swarmLatticeX: 6, // cells across the formation
  swarmLatticeY: 4, // cells up it
  swarmLatticeZ: 8, // ranks strung out behind the lead
  swarmSpacingSide: 0.75, // metres between lateral cells
  swarmSpacingUp: 0.9, // metres between vertical cells
  swarmLag: 1.5, // seconds the back rank trails the lead by
  swarmJitter: 0.35, // metres of slop off the cell
  swarmChurn: 1.6, // radians/second the formation rolls
  swarmBreathe: 0.3, // fraction the formation swells by
  swarmBreatheRate: 1.1, // radians/second it breathes at
  swarmWander: 0.3, // metres of curl drift — keep under half the spacing
  swarmWanderScale: 0.45, // drift features per metre
  swarmWanderSpeed: 0.7, // Hz the drift crawls at
  swarmGather: 0.9, // 0 collapses every agent onto the lead's own path
  swarmSize: 0.34, // metres, nose to tail
  swarmAspect: 0.85, // span ÷ length
  swarmSizeJitter: 0.55, // ± fraction
  swarmBillboard: 0.25, // 0 agent frame, 1 camera facing
  swarmBank: 0.09, // radians of roll per m/s² of lateral acceleration
  swarmBankMax: 1.6, // radians
  swarmDihedral: 0.22, // fold across the card, fraction of size
  swarmFlapRate: 2.2, // beats/second the fold works at
  swarmCurl: 0.5, // leaf curl across the chord, fraction of size
  swarmEdgeStretch: 1.5, // how much an edge-on card grows, ≥1
  swarmEdgeGain: 1.6, // emission multiplier when it is edge-on
  swarmRevealSpread: 0.45, // width of the wave that brings agents in
  swarmLit: 1.0, // 0 emissive, 1 wrapped diffuse — debris is lit, not glowing
  swarmTint: 0.35, // where in the gradient the flock sits
  swarmTintJitter: 0.35, // ± per-agent walk along it
  swarmTintAlong: 0.4, // extra walk from head to tail
  swarmOpacity: 1.0,
  swarmGlow: 0.5,
  swarmSoftFade: 0.4, // metres of depth feather against solid geometry
  colorSwarmA: '#8d97a2', // gradient the flock is tinted along, near end
  colorSwarmB: '#6a7480',
  colorSwarmC: '#3e454d',
  colorSwarmD: '#20262c', // ... and far end

  /* ------------------------------------------------------------------ */
  /* The scour — vfx/GroundField.js, SCOUR mode                          */
  /* ------------------------------------------------------------------ */
  scourReach: 1.5, // the scoured radius, × the funnel's own foot radius
  scourHeight: 0.02, // metres the quad sits above the floor
  scourEdge: 0.55, // metres of feather on the growth front
  scourRagged: 0.3, // how far that front wanders, fraction of the radius
  scourRaggedScale: 0.6, // lobes per metre
  scourWarp: 0.7, // metres of domain warp on those lobes
  scourRelief: 0.85, // how hard the height field tilts the fake normal
  scourNormalStep: 0.05, // metres between the height taps
  scourAmbient: 0.3, // floor on the diffuse term
  scourWrap: 0.5, // 0..1 wraps the terminator round the back
  scourSpecular: 0.25,
  scourGloss: 16, // Blinn exponent
  scourParallax: 0.3, // metres of view-driven offset on interior detail
  scourDepth: 0.32, // metres the grooves are cut
  scourLift: 0.14, // metres the spoil ridges stand proud
  scourSharp: 0.62, // 0..1 how hard-edged a groove is
  scourDetail: 0.7, // 0..1 grain in the floor of the groove
  scourSwirl: 0.45, // spiral pitch — how fast a groove winds inward
  scourArms: 7, // grooves; whole numbers only, the phase tears otherwise
  scourSpin: 0.9, // radians/second the whole pattern turns
  scourEmissive: 0.5, // multiplier on every glowing term
  scourOpacity: 0.95,
  scourDepthFade: 0.5, // metres of soft fade against standing geometry
  scourAdditive: false, // false shades the floor, which is what dust does
  colorScourBase: '#4a5058', // the scoured stone
  colorScourEdge: '#9aa4ae', // the spoil ridges between the grooves
  colorScourGlow: '#79838d', // the dust caught in the bottom of a groove
  colorScourDeep: '#171b1f', // the deepest cut

  /* ------------------------------------------------------------------ */
  /* Dust, debris and grit                                               */
  /* ------------------------------------------------------------------ */
  /**
   * As in `thunder`: each system is coloured by a four-stop gradient sampled
   * over the particle's own lifetime, `A` at birth through `D` as it dies. The
   * dust is emitted on `radiusAt(0)` and swirled about the axis by the particle
   * shader's own orbit term, so it is the same one function again.
   */
  dustRate: 90, // dust lifted off the skirt, particles/second
  dustSize: 1.5,
  dustSpeed: 2.2, // metres/second outward off the foot
  dustLifetime: 2.6,
  dustRise: 1.4, // upward drift, metres/second
  dustSwirl: 3.4, // radians/second the dust orbits the axis
  dustSwirlExpand: 0.5, // how far the orbit opens out over a life, ×
  dustOpacity: 0.3,
  dustTurbulence: 0.55,
  colorDustA: '#8e98a2',
  colorDustB: '#6a7480',
  colorDustC: '#464e56',
  colorDustD: '#20262c',
  debrisRate: 34, // chips torn off the floor and carried up the wall
  debrisSize: 0.09,
  debrisSpeed: 5.5,
  debrisLifetime: 2.2,
  debrisGravity: -6.5, // metres/second² — the funnel is holding them up
  debrisSwirl: 4.2, // radians/second they orbit the axis
  debrisSwirlExpand: 0.25,
  colorDebrisA: '#8a8f96',
  colorDebrisB: '#5d646c',
  colorDebrisC: '#33393f',
  colorDebrisD: '#20262c',
  gritRate: 150, // fine grit streaming in across the floor
  gritSize: 0.1,
  gritSpeed: 8.0, // metres/second inward along the intake
  gritLifetime: 0.9,
  gritRise: 3.0, // metres/second² of lift once it reaches the foot
  gritStretch: 0.22, // how far a grain smears along its velocity
  gritTurbulence: 0.4,
  colorGritA: '#c8d0d8',
  colorGritB: '#98a2ac',
  colorGritC: '#5c646c',
  colorGritD: '#2a3036',

  /* --- the whorl, before the funnel stands --- */
  whorlRate: 120, // dust turned over on the floor while the cast travels, /second
  whorlRise: 0.4, // metres/second it lifts while it is only a whorl
  whorlSwirl: 5.0, // radians/second — tight and fast, it is winding up

  /* --- dynamic light --- */
  lightIntensity: 7.0,
  lightRadius: 14.0,
  lightColor: '#8e99a4',
  lightShimmer: 0.12, // depth of the light's breathing, 0 = steady
  lightShimmerSpeed: 2.4, // breaths per second

  /* --- touchdown and the ground it stands on --- */
  touchSize: 3.2, // the pressure shell at the moment of touchdown, metres
  touchIntensity: 1.1,
  touchFlash: 0.06, // screen flash on touchdown
  touchShake: 0.55,
  shakeDuration: 0.7,
  rumble: 0.05, // continuous shake while the funnel stands
  colorTouchA: '#8e98a2', // touchdown shell body
  colorTouchB: '#c0c8d0', // its billow
  colorTouchC: '#e8eef4', // the filaments racing across it
  colorTouchFlash: '#b6c0ca' // the full-screen flash
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Cyclone.
 *
 * Reach for **The vortex profile** first: `funnelThroat`, `funnelSkirtFlare`
 * and `funnelMouthFlare` are the three numbers the whole ability is hung off,
 * and every other consumer moves when they do. `scourReach` and `ribbonHug` are
 * *multiples* of that profile rather than metres, on purpose — they cannot
 * drift away from it.
 */
export const cycloneSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 4, 120, 0.5, 'whorl speed'],
    ['zoneRadius', 1, 16, 0.1, 'aim circle (m)'],
    ['lifetime', 0.2, 12, 0.05, 'hold'],
    ['fadeTime', 0.1, 8, 0.05, 'rope-out time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The column': [
    ['height', 1, 24, 0.1, 'funnel height (m)'],
    ['baseHeight', 0, 1, 0.005, 'foot clearance (m)'],
    ['spinUp', 0.05, 4, 0.01, 'spin-up (s)'],
    ['touchTaper', 0.01, 1, 0.01, 'width at touchdown'],
    ['ropeLift', 0, 1, 0.01, 'foot lift on death'],
    ['ropeTaper', 0.01, 1, 0.01, 'width at death'],
    ['lightRide', 0, 1, 0.01, 'light height on column']
  ],
  'The vortex profile': [
    ['funnelThroat', 0.02, 6, 0.01, 'throat (m)'],
    ['funnelSkirtFlare', 0, 10, 0.01, 'skirt flare (m)'],
    ['funnelSkirtHeight', 0.01, 1, 0.01, 'skirt height'],
    ['funnelSkirtCurve', 0.1, 6, 0.01, 'skirt curve'],
    ['funnelMouthFlare', 0, 14, 0.01, 'mouth flare (m)'],
    ['funnelMouthStart', 0, 0.99, 0.01, 'mouth start'],
    ['funnelMouthCurve', 0.1, 6, 0.01, 'mouth curve'],
    ['funnelSpin', -6, 6, 0.01, 'spin (rev/s)'],
    ['funnelSpinTwist', -8, 8, 0.01, 'twist'],
    ['funnelSway', 0, 4, 0.01, 'precession (m)'],
    ['funnelSwayScale', 0, 3, 0.01, 'precession twist'],
    ['funnelSwaySpeed', -3, 3, 0.01, 'precession (rev/s)'],
    ['funnelSwayCurve', 0.1, 6, 0.01, 'precession curve']
  ],
  'The vortex profile/Surface': [
    ['funnelThrob', 0, 0.5, 0.001, 'throb'],
    ['funnelThrobScale', 0, 12, 0.1, 'throb bands'],
    ['funnelThrobSpeed', 0, 8, 0.01, 'throb Hz'],
    ['funnelWander', 0, 1, 0.001, 'axis drift (m)'],
    ['funnelWanderScale', 0, 6, 0.01, 'drift scale'],
    ['funnelWanderSpeed', 0, 4, 0.01, 'drift Hz'],
    ['funnelRipple', 0, 1, 0.01, 'ripple'],
    ['funnelRippleBands', 0, 8, 0.01, 'ripple bands'],
    ['funnelRippleScale', 0, 12, 0.01, 'ripple scale'],
    ['funnelRippleSpeed', 0, 10, 0.01, 'ripple Hz'],
    ['funnelStreak', 0, 2, 0.01, 'streaks'],
    ['funnelStreakSharp', 0, 1, 0.01, 'streak sharpness'],
    ['funnelStreakScale', 0, 20, 0.1, 'streak scale'],
    ['funnelStreakBands', 0, 8, 0.01, 'streak bands'],
    ['funnelStreakGlow', 0, 3, 0.01, 'streak glow'],
    ['funnelFlowSpeed', -24, 24, 0.1, 'flow speed'],
    ['funnelBands', 0, 24, 0.1, 'rings/length'],
    ['funnelBandSharp', 0.05, 8, 0.01, 'ring sharpness'],
    ['funnelBandDepth', 0, 1, 0.01, 'ring depth'],
    ['funnelBandSpeed', -6, 6, 0.01, 'ring Hz']
  ],
  'The vortex profile/Core, sheath, halo': [
    ['funnelCoreWidth', 0.02, 2, 0.01, 'core width'],
    ['funnelCoreFill', 0, 2, 0.01, 'core fill'],
    ['funnelCoreSharp', 0.05, 8, 0.01, 'core axis power'],
    ['funnelEdgePower', 0.05, 8, 0.01, 'sheath rim power'],
    ['funnelSheathWidth', 0.05, 3, 0.01, 'sheath width'],
    ['funnelSheathRim', 0, 2, 0.01, 'sheath rim'],
    ['funnelSheathFill', 0, 1, 0.01, 'sheath fill'],
    ['funnelSheathOpacity', 0, 1, 0.01, 'sheath opacity'],
    ['funnelHaloWidth', 0.05, 6, 0.01, 'halo width'],
    ['funnelHaloRim', 0.05, 10, 0.01, 'halo rim power'],
    ['funnelHaloOpacity', 0, 1, 0.01, 'halo opacity'],
    ['funnelMuzzleGlow', 0, 5, 0.01, 'foot glow'],
    ['funnelMuzzleLength', 0, 0.6, 0.001, 'foot glow length'],
    ['funnelTipGlow', 0, 5, 0.01, 'mouth glow'],
    ['funnelTipLength', 0.001, 0.4, 0.001, 'mouth glow length']
  ],
  'The vortex profile/Colour': [
    'funnelColorCore',
    'funnelColorInner',
    'funnelColorOuter',
    'funnelColorHalo',
    ['funnelOpacity', 0, 1, 0.01, 'opacity'],
    ['funnelGlow', 0, 8, 0.01, 'glow'],
    ['funnelSoftFade', 0, 3, 0.01, 'soft fade (m)']
  ],
  'The vortex profile/Inert on this path': [
    ['funnelRadius', 0.01, 4, 0.01, 'far radius (m)'],
    ['funnelRadiusNear', 0.01, 4, 0.01, 'near radius (m)'],
    ['funnelRadiusCurve', 0.05, 4, 0.01, 'radius curve'],
    ['funnelFlare', 0, 4, 0.01, 'flare'],
    ['funnelFlareWidth', 0.01, 1, 0.01, 'flare width'],
    ['funnelWaveRate', 0, 6, 0.01, 'loops/second'],
    ['funnelWaveWidth', 0.02, 0.6, 0.001, 'loop width'],
    ['funnelWaveAmp', 0, 1, 0.001, 'loop throw'],
    ['funnelWaveGain', 0.2, 6, 0.01, 'loop gain'],
    ['funnelWaveCurve', 0.1, 6, 0.01, 'gain curve'],
    ['funnelWaveRoll', 0, 6.284, 0.01, 'crack plane (rad)'],
    ['funnelSag', 0, 2, 0.01, 'sag (m)'],
    ['funnelCrackRatio', 0.2, 4, 0.01, 'crack ratio'],
    ['funnelTipTaper', 0.05, 6, 0.01, 'tip taper'],
    ['funnelMeander', 0, 2, 0.01, 'meander (m)'],
    ['funnelMeanderTurns', 0, 8, 0.01, 'meander turns'],
    ['funnelRecoilAmp', 0, 1, 0.01, 'recoil'],
    ['funnelRecoilFreq', 0, 10, 0.01, 'recoil Hz'],
    ['funnelRecoilDamp', 0.1, 16, 0.01, 'recoil damping'],
    ['funnelRecoilSway', 0, 4, 0.01, 'recoil bow (m)'],
    ['funnelArcHeight', -12, 12, 0.01, 'apex height (m)'],
    ['funnelArcLateral', -12, 12, 0.01, 'apex offset (m)'],
    ['funnelArcBias', 0.05, 0.95, 0.01, 'apex position'],
    ['funnelArcCurve', 0.1, 4, 0.01, 'apex curve']
  ],
  'The ribbons': [
    ['wallRibbons', 0, 18, 1, 'wall ribbons'],
    ['ribbonTop', 0.05, 1, 0.01, 'wall reach (× height)'],
    ['ribbonHug', 0.2, 3, 0.01, 'wall hug (× radiusAt)'],
    ['ribbonTurns', 0, 8, 0.05, 'wall turns'],
    ['ribbonSpin', -6, 6, 0.01, 'wall spin (turns/s)'],
    ['ribbonCurve', 0.1, 4, 0.01, 'wall climb curve'],
    ['ribbonPhase', 0, 2, 0.01, 'wall phase spread'],
    ['ribbonWobble', 0, 1, 0.01, 'wall wobble'],
    ['intakeArms', 0, 12, 1, 'intake arms'],
    ['intakeLift', 0, 3, 0.01, 'intake start height (m)'],
    ['intakeFloor', 0, 0.5, 0.005, 'intake floor clamp (m)'],
    ['intakeTurns', 0, 8, 0.05, 'intake turns'],
    ['intakeSpin', -6, 6, 0.01, 'intake spin (turns/s)'],
    ['intakeCurve', 0.1, 4, 0.01, 'intake curve'],
    ['intakePhase', 0, 2, 0.01, 'intake phase spread'],
    ['intakeWobble', 0, 1, 0.01, 'intake wobble'],
    ['intakeDamp', 0, 1, 0.01, 'intake ground damping']
  ],
  'The ribbons/Look': [
    ['ribbonWidth', 0.002, 0.3, 0.001, 'width (m)'],
    ['ribbonGlowWidth', 1, 20, 0.1, 'halo width'],
    ['ribbonGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['ribbonJitter', 0, 2, 0.01, 'kink (m)'],
    ['ribbonJitterScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['ribbonOctaves', 1, 5, 1, 'octaves'],
    ['ribbonJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['ribbonCrawl', -12, 12, 0.05, 'kink crawl'],
    ['ribbonPinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['ribbonRestrike', 0.5, 60, 0.5, 'restrikes / sec'],
    ['ribbonFlicker', 0, 1, 0.01, 'brightness stutter'],
    ['ribbonFlickerSpeed', 1, 90, 1, 'stutter rate'],
    ['ribbonStrandFlash', 0, 1, 0.01, 'ribbon blink'],
    ['ribbonCoreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['ribbonGlowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['ribbonSoftFade', 0.02, 3, 0.01, 'soft fade (m)'],
    ['ribbonOpacity', 0, 2, 0.01, 'opacity'],
    ['ribbonGlow', 0, 6, 0.01, 'glow'],
    ['ribbonDim', 0, 1, 0.01, 'wall dim'],
    ['intakeDim', 0, 1, 0.01, 'intake dim'],
    'colorRibbonCore',
    'colorRibbonInner',
    'colorRibbonOuter',
    'colorRibbonHalo'
  ],
  'The flock': [
    ['swarmCount', 0, 192, 1, 'agents'],
    ['swarmRide', 0, 1, 0.01, 'ride height (× height)'],
    ['swarmHug', 0.2, 4, 0.01, 'orbit (× radiusAt)'],
    ['swarmRate', -3, 3, 0.01, 'orbits / second'],
    ['swarmTurns', 0.1, 4, 0.05, 'lead turns'],
    ['swarmLatticeX', 1, 16, 1, 'cells across'],
    ['swarmLatticeY', 1, 12, 1, 'cells up'],
    ['swarmLatticeZ', 1, 24, 1, 'ranks'],
    ['swarmSpacingSide', 0.05, 3, 0.01, 'side spacing (m)'],
    ['swarmSpacingUp', 0.05, 3, 0.01, 'up spacing (m)'],
    ['swarmLag', 0, 6, 0.01, 'tail lag (s)'],
    ['swarmJitter', 0, 2, 0.01, 'cell slop (m)'],
    ['swarmChurn', -6, 6, 0.01, 'churn (rad/s)'],
    ['swarmBreathe', 0, 1, 0.01, 'breathe'],
    ['swarmBreatheRate', 0, 6, 0.01, 'breathe rate'],
    ['swarmWander', 0, 2, 0.01, 'drift (m)'],
    ['swarmWanderScale', 0, 3, 0.01, 'drift scale'],
    ['swarmWanderSpeed', 0, 4, 0.01, 'drift Hz'],
    ['swarmGather', 0, 1, 0.01, 'gather']
  ],
  'The flock/Body': [
    ['swarmSize', 0.02, 2, 0.01, 'size (m)'],
    ['swarmAspect', 0.2, 4, 0.01, 'aspect'],
    ['swarmSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['swarmBillboard', 0, 1, 0.01, 'billboard'],
    ['swarmBank', 0, 0.4, 0.005, 'bank / accel'],
    ['swarmBankMax', 0, 3.2, 0.01, 'bank limit (rad)'],
    ['swarmDihedral', 0, 1, 0.01, 'fold'],
    ['swarmFlapRate', 0, 12, 0.1, 'fold rate'],
    ['swarmCurl', 0, 1, 0.01, 'curl'],
    ['swarmEdgeStretch', 1, 4, 0.01, 'edge stretch'],
    ['swarmEdgeGain', 0, 6, 0.01, 'edge gain'],
    ['swarmRevealSpread', 0.01, 1, 0.01, 'reveal spread'],
    ['swarmLit', 0, 1, 0.01, 'lit'],
    ['swarmTint', 0, 1, 0.01, 'tint'],
    ['swarmTintJitter', 0, 1, 0.01, 'tint jitter'],
    ['swarmTintAlong', 0, 1, 0.01, 'tint along'],
    ['swarmOpacity', 0, 2, 0.01, 'opacity'],
    ['swarmGlow', 0, 4, 0.01, 'glow'],
    ['swarmSoftFade', 0.02, 3, 0.01, 'soft fade (m)'],
    ['colorSwarm*', 'Debris colour']
  ],
  'The scour': [
    ['scourReach', 0.2, 4, 0.01, 'reach (× foot radius)'],
    ['scourHeight', 0, 0.3, 0.005, 'height (m)'],
    ['scourEdge', 0.01, 3, 0.01, 'front feather (m)'],
    ['scourRagged', 0, 1, 0.01, 'front wander'],
    ['scourRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['scourWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['scourRelief', 0, 3, 0.01, 'relief'],
    ['scourNormalStep', 0.005, 0.3, 0.005, 'normal step (m)'],
    ['scourAmbient', 0, 1, 0.01, 'ambient'],
    ['scourWrap', 0, 1, 0.01, 'terminator wrap'],
    ['scourSpecular', 0, 2, 0.01, 'specular'],
    ['scourGloss', 1, 80, 1, 'gloss'],
    ['scourParallax', 0, 1, 0.01, 'parallax (m)'],
    ['scourDepth', 0, 1.5, 0.01, 'groove depth (m)'],
    ['scourLift', 0, 1, 0.01, 'ridge height (m)'],
    ['scourSharp', 0, 1, 0.01, 'groove sharpness'],
    ['scourDetail', 0, 1, 0.01, 'grain'],
    ['scourSwirl', 0, 2, 0.01, 'spiral pitch'],
    ['scourArms', 1, 16, 1, 'grooves'],
    ['scourSpin', -4, 4, 0.01, 'rotation (rad/s)'],
    ['scourEmissive', 0, 3, 0.01, 'emissive'],
    ['scourOpacity', 0, 1, 0.01, 'opacity'],
    ['scourDepthFade', 0.01, 3, 0.01, 'depth fade (m)'],
    ['scourAdditive', 'additive'],
    'colorScourBase',
    'colorScourEdge',
    'colorScourGlow',
    'colorScourDeep'
  ],
  'Dust & debris': [
    ['dustRate', 0, 500, 1, 'dust rate'],
    ['dustSize', 0.05, 6, 0.01, 'dust size'],
    ['dustSpeed', 0, 20, 0.1, 'dust speed'],
    ['dustLifetime', 0.1, 8, 0.05, 'dust lifetime'],
    ['dustRise', -3, 8, 0.05, 'dust rise'],
    ['dustSwirl', -12, 12, 0.05, 'dust orbit (rad/s)'],
    ['dustSwirlExpand', 0, 3, 0.01, 'dust orbit growth'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['debrisRate', 0, 300, 1, 'debris rate'],
    ['debrisSize', 0.005, 0.6, 0.005, 'debris size'],
    ['debrisSpeed', 0, 25, 0.1, 'debris speed'],
    ['debrisLifetime', 0.1, 6, 0.05, 'debris lifetime'],
    ['debrisGravity', -40, 5, 0.1, 'debris gravity'],
    ['debrisSwirl', -12, 12, 0.05, 'debris orbit (rad/s)'],
    ['debrisSwirlExpand', 0, 3, 0.01, 'debris orbit growth'],
    ['gritRate', 0, 800, 1, 'grit rate'],
    ['gritSize', 0.005, 0.6, 0.005, 'grit size'],
    ['gritSpeed', 0, 30, 0.1, 'grit speed'],
    ['gritLifetime', 0.05, 4, 0.01, 'grit lifetime'],
    ['gritRise', -5, 15, 0.05, 'grit lift'],
    ['gritStretch', 0, 3, 0.01, 'grit stretch'],
    ['gritTurbulence', 0, 3, 0.01, 'grit turbulence'],
    ['whorlRate', 0, 600, 1, 'whorl rate'],
    ['whorlRise', -2, 6, 0.05, 'whorl rise'],
    ['whorlSwirl', -16, 16, 0.05, 'whorl orbit (rad/s)'],
    ['colorDust*', 'Dust colour'],
    ['colorDebris*', 'Debris colour'],
    ['colorGrit*', 'Grit colour']
  ],
  'Touchdown & light': [
    ['touchSize', 0.2, 14, 0.05, 'touchdown shell (m)'],
    ['touchIntensity', 0, 5, 0.01, 'shell intensity'],
    ['touchFlash', 0, 2, 0.01, 'screen flash'],
    ['touchShake', 0, 3, 0.01, 'touchdown shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.5, 0.005, 'standing rumble'],
    'colorTouchA',
    'colorTouchB',
    'colorTouchC',
    'colorTouchFlash',
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightShimmer', 0, 1, 0.01, 'light breathing'],
    ['lightShimmerSpeed', 0, 20, 0.05, 'breathing rate'],
    'lightColor'
  ]
};
