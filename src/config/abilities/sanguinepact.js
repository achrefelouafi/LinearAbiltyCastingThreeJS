import { Medium, volumeHullDefaults, volumeHullSchema } from '../../vfx/VolumeHull.js';

/* ================================================================== */
/* SANGUINE PACT — blood · far cast                                    */
/* ================================================================== */
/**
 * A pact sealed on a circle: a pool of blood draws itself on the floor, sends
 * up a slow mist column, and forty beads of blood climb out of it on real
 * inclined orbits. When the pact seals, the orbits flatten into the ring plane
 * and the beads merge into a rim.
 *
 * **`zoneRadius` is the promise, and five things keep it.** The aim indicator
 * measures out a circle before the click; the pool's footprint, the mist
 * column's radius, the beads' mean orbit, the sealed rim and the ring of
 * travelling arcs are all that radius times their own *fraction*. Drag it on a
 * standing pact and every one of them re-scales together, which is the one kind
 * of shared value I5 allows — the sharing is the design, not a shortcut.
 *
 * The three groups worth reaching for first:
 *
 *  - **The orbits** (`orbitTilt`, `orbitTiltSpread`, `orbitEccentric`) — the
 *    trick. Take `orbitTilt` to zero and the beads collapse into a flat ring
 *    and the whole cast turns into a decal; that is the failure this ability
 *    exists to avoid, and it is one slider away at all times.
 *  - **The seal** (`sealSnap`, `rimMerge`, `rimMergeStretch`) — how hard the
 *    punctuation lands.
 *  - **The mist** (`mistDensity`, `mistAbsorption`, `mistAnisotropy`) — the only
 *    soft thing in the cast. Everything else here has an edge.
 *
 * Deep red, almost black in shadow. `beadAmbient` is deliberately low and
 * `colorBeadDeep` is nearly black: a bead lit from one side and *black* on the
 * other is what makes forty of them read as wet spheres instead of dots.
 *
 * ### Two things the harness will mention, both of them expected
 *
 * The `mist*` keys are spread in by `volumeHullDefaults` and read back by
 * `VolumeHull.sync()` through a **key prefix** (`c[keys.Density]`), never by
 * bare name — so the static cross-check cannot see the reads and lists them as
 * "no visible read". They are all live; drag any of them on a standing column.
 *
 * `volumeHullDefaults` also emits the `GAS_BOIL`, sparse-point and `VOID`
 * fields, which `MIST` does not use. They are deliberately left out of the
 * schema's `only` list rather than filed into a folder of their own: filing
 * them would put twelve controls that do nothing next to eleven that do, and
 * the trailing "More" folder is exactly where a control nobody should reach for
 * belongs.
 */
export const sanguinepact = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 4.0, // closer than this and the cast is refused
  speed: 22.0, // how fast the pact runs out to the circle, metres/second
  zoneRadius: 4.6, // the footprint the indicator promises, metres
  holdTime: 2.7, // seconds the column stands and the beads climb
  sealTime: 2.2, // seconds the seal takes, including going out
  cooldown: 1.6,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats, all unitless fractions of their own phase --- */
  climbTime: 0.55, // 0..1 of the hold the beads take to reach full height
  columnTime: 0.42, // 0..1 of the hold the mist takes to reach full height
  sealSnap: 0.2, // 0..1 of the seal phase the flattening takes
  sealHold: 0.46, // 0..1 of it the sealed rim stands before it goes out

  /* --- the pool ------------------------------------------------------- */
  // A GroundField(POOL): standing liquid with a meniscus rim, alpha blended so
  // it is genuinely darker than the floor. `poolThickness` is the meniscus and
  // it is the read — surface tension pulls blood *up* the last few centimetres
  // before the edge, and without that lip a pool is a coloured disc.
  poolScale: 1.0, // × zoneRadius
  poolHeight: 0.014, // metres above the floor the quad sits at
  poolEdge: 0.34, // metres of feather on the growth front
  poolRagged: 0.3, // fraction of the radius the edge wanders by
  poolRaggedScale: 0.6, // lobes per metre
  poolWarp: 0.7, // metres of domain warp on those lobes
  poolRelief: 0.7, // how hard the surface tilts the fake normal
  poolNormalStep: 0.05, // metres between the height taps
  poolAmbient: 0.14,
  poolWrap: 0.45, // 0..1 wraps the terminator round the back
  poolSpecular: 1.9,
  poolGloss: 72, // Blinn exponent
  poolParallax: 0.22, // metres of view-driven offset on the interior
  poolCell: 0.4, // cycles per metre of the surface warp
  poolLift: 0.035, // metres the surface ripples by
  poolDepth: 0.16, // metres the middle sits below the rim
  poolThickness: 0.09, // metres — the meniscus, and the whole read
  poolDetail: 0.75, // 0..1 fine grain
  poolSpeed: 0.35, // radians/second the surface churns
  poolFlow: 0.1, // metres/second it drifts
  poolWindAngle: 0.4, // radians, in the quad's frame
  poolEmissive: 0.6, // multiplier on the sheen and the rim
  poolOpacity: 1.0,
  poolDepthFade: 0.35, // metres of soft fade against standing geometry
  colorPoolBase: '#7a0a14', // the liquid at the rim
  colorPoolEdge: '#c81a28', // the meniscus and the specular
  colorPoolGlow: '#3a0208', // the faint bloom out of the middle
  colorPoolDeep: '#120103', // looking straight down into it

  /* --- the mist column ------------------------------------------------ */
  // A CYLINDER of MIST: barely absorbing, strongly forward-scattering. It is
  // the anisotropy that makes it mist rather than fog, and the only soft thing
  // in the whole cast.
  mistScale: 0.72, // × zoneRadius — the column's radius
  mistHeight: 5.2, // metres the column reaches at full rise
  ...volumeHullDefaults('mist', Medium.MIST, {
    mistSteps: 30, //          the column is tall and thin; it does not need 40
    mistDensity: 0.85,
    mistAbsorption: 0.55,
    mistScatter: 0.9,
    mistAmbient: 0.3,
    mistAnisotropy: 0.62, //   forward scatter — this is what says "mist"
    mistNoiseFrequency: 0.85,
    mistNoiseStrength: 0.7,
    mistRise: 0.5, //          metres/second of buoyancy
    mistSwirl: 0.22, //        radians/second about the column's own axis
    mistHeightBias: 0.5, //    it thins out toward the top
    mistMargin: 0.22,
    mistFeather: 0.42,
    mistOpacity: 0.8,
    mistColorCore: '#7a2028',
    mistColorMid: '#4a1018',
    mistColorEdge: '#2a0a10',
    mistColorDeep: '#120508',
    mistColorLight: '#ffd0c8'
  }),

  /* --- the beads ------------------------------------------------------- */
  beadCount: 54, // live beads (capped at 96)
  beadSize: 0.115, // metres, radius of one bead
  beadSizeJitter: 0.4, // ± fraction of it
  beadClimbBase: 0.12, // metres above the pool the lowest orbit sits
  beadClimbTop: 3.6, // metres the highest orbit reaches
  beadWobble: 0.11, // metres of vertical breathing on every orbit
  beadWobbleRate: 1.5, // radians/second of it
  beadRevealSpread: 0.4, // 0..1 width of the appear wave
  beadAmbient: 0.13, // floor on the wrapped diffuse — keep it low
  beadWrap: 0.55, // 0..1 how far the terminator wraps round the back
  beadSpecular: 2.0,
  beadGloss: 54, // Blinn exponent
  beadFresnel: 1.2,
  beadGlow: 1.0,
  beadOpacity: 1.0,
  beadTintAlong: 0.55, // how far up the column the gradient walks
  beadTintJitter: 0.28, // ± per-bead walk on top of that
  colorBeadBody: '#c81a28', // the lit side
  colorBeadDeep: '#1e0206', // the shadow side — almost black, on purpose
  colorBeadRim: '#7a0a14', // the fresnel edge
  colorBeadSheen: '#ff9aa0', // the highlight

  /* --- the orbits ------------------------------------------------------ */
  orbitScale: 0.72, // × zoneRadius — the mean semi-major axis
  orbitRadiusJitter: 0.22, // ± fraction of it, per bead
  orbitEccentric: 0.42, // 0 circle .. 0.95 a long ellipse
  orbitTilt: 0.95, // radians the mean orbital plane is tipped off horizontal
  orbitTiltSpread: 0.7, // radians of per-bead variation on that
  orbitNodeJitter: 0.16, // 0..1 slop on the golden-angle node spacing
  orbitSpin: 0.22, // turns per second
  orbitSpinJitter: 0.35, // ± fraction of it, per bead

  /* --- the sealed rim --------------------------------------------------- */
  rimScale: 0.86, // × zoneRadius — where the flattened ring stands
  rimHeight: 0.42, // metres above the floor
  rimMerge: 1.0, // 0..1 how far the beads run together
  rimMergeStretch: 2.6, // how many times longer a fully merged bead is

  /* --- the filaments ---------------------------------------------------- */
  // One instanced strip, three roles, two draw calls: the threads climbing with
  // the beads, the arcs travelling round the sealed rim, and the leash that
  // runs out from the hand while the pact is being offered.
  threadCount: 7, // ORBIT filaments climbing with the beads
  threadRadiusScale: 0.66, // × zoneRadius
  threadPoleHeight: 3.0, // metres above the pool the mean orbital axis points to
  threadArc: 0.55, // turns one filament covers
  threadSpin: 0.14, // turns per second the loops travel
  threadWobble: 0.4, // 0..1 how far from a clean circle
  threadTilt: 1.0, // radians the plane is tipped
  threadTiltSpread: 0.8, // radians of per-filament variation
  threadRadiusJitter: 0.25, // ± fraction of the radius, per filament
  threadKink: 0.5, // × the shared jitter
  threadWidthScale: 0.9, // × the shared width
  threadDim: 0.85, // 0..1 how secondary this role is

  rimArcs: 9, // RIM filaments travelling round the sealed ring
  rimSpan: 0.16, // turns one arc covers
  rimSpeed: 0.4, // turns per second they travel
  rimArcLift: 0.16, // metres they hop at mid-span
  rimArcJitter: 0.1, // metres of per-arc radial slop
  rimArcHug: 0.06, // metres they float above the ring plane
  rimKink: 0.35, // × the shared jitter
  rimWidthScale: 1.15, // × the shared width
  rimDim: 1.0, // 0..1 how secondary this role is

  leashCount: 3, // LINE filaments running out from the hand
  handHeight: 1.24, // metres above the floor the leash leaves at
  handForward: 0.5, // metres in front of the caster
  handSide: 0.18, // metres to the side (+ follows `Ability#side`)
  leashSag: -0.35, // metres of bow at mid-span; negative droops, and blood droops
  leashSpread: 0.5, // metres the bundle is fanned at the circle
  leashSpreadNear: 0.05, // ... and at the hand
  leashSpreadCurve: 1.5, // >1 keeps it tight then opens it late
  leashTwist: 0.3, // turns of roll from end to end
  leashTwistSpeed: 0.4, // turns per second the fan rolls
  leashConverge: 0.9, // 0..1 how hard the far end is pinned to the circle
  leashKink: 0.7, // × the shared jitter
  leashWidthScale: 1.0, // × the shared width
  leashDim: 0.8, // 0..1 how secondary this role is

  threadWidth: 0.022, // metres — half-width of a core filament
  threadGlowWidth: 5.2, // halo half-width, × the core
  threadGlowOpacity: 0.3, // halo alpha relative to the core
  threadJitter: 0.16, // metres of lateral kink
  threadJitterScale: 1.1, // kinks per metre of path
  threadOctaves: 3, // 1..5
  threadJitterFalloff: 0.55, // amplitude kept per octave
  threadCrawl: 0.9, // how fast the kinks slide along, per second
  threadPinch: 0.2, // 0..1 of the path the kink eases in over at each end
  threadRestrike: 4.0, // whole re-shapes per second — slow; blood is not lightning
  threadFlicker: 0.1, // 0..1 depth of the whole-bundle stutter
  threadFlickerSpeed: 9, // steps per second that stutter is quantised to
  threadStrandFlash: 0.2, // 0..1 depth of the per-filament blink
  threadCoreSharp: 3.4, // exponent on the core's edge falloff
  threadGlowFalloff: 2.6, // the same for the halo
  threadSoftFade: 0.5, // metres of depth fade against the opaque scene
  threadOpacity: 0.95,
  threadGlow: 0.7, // sub-unity: these are wet threads, not filaments of light
  colorThreadCore: '#e0505c', // the centre line
  colorThreadInner: '#c81a28',
  colorThreadOuter: '#7a0a14',
  colorThreadHalo: '#2a040a', // the wide, dim atmosphere

  /* --- motes and drips -------------------------------------------------- */
  /**
   * Two systems only. The roster line says the mist is the only soft thing in
   * this cast, so there is no smoke and no haze here — the motes are hard flecks
   * carried up by the column and the drips are what falls back out of it.
   * Four-stop lifetime gradients, `A` at birth through `D` as it dies.
   */
  moteRate: 70, // flecks lifted by the column, particles/second
  moteSize: 0.045,
  moteSpeed: 0.7,
  moteLifetime: 2.6,
  moteRise: 1.5, // upward drift, metres/second
  moteTurbulence: 0.55,
  colorMoteA: '#c81a28',
  colorMoteB: '#7a0a14',
  colorMoteC: '#3a0208',
  colorMoteD: '#160103',
  dripRate: 34, // droplets shed by the beads, particles/second
  dripSize: 0.055,
  dripSpeed: 1.1,
  dripLifetime: 1.3,
  dripGravity: -13.0, // metres/second²
  colorDripA: '#e0505c',
  colorDripB: '#c81a28',
  colorDripC: '#7a0a14',
  colorDripD: '#2a040a',

  /* --- the seal --------------------------------------------------------- */
  sealBurstSize: 3.2, // the shell that snaps out of the rim, metres
  sealBurstIntensity: 1.1,
  sealDrips: 160, // droplets flung as the rim closes
  sealMotes: 110,
  sealShockRadius: 6.0, // the ring that runs out across the floor, metres
  sealShake: 0.7,
  sealShakeDuration: 0.5,
  sealFlash: 0.12, // screen flash on the seal
  rumble: 0.03, // continuous shake while the pact stands
  colorSealA: '#3a0208', // burst shell
  colorSealB: '#7a0a14', // burst body
  colorSealC: '#e0505c', // burst filaments
  colorSealShockA: '#7a0a14',
  colorSealShockB: '#c81a28',
  colorFlash: '#5a0810',

  /* --- what the pact leaves on the floor -------------------------------- */
  stainRadius: 3.0, // the residue where the pool stood, metres
  stainLife: 7.0, // seconds it lingers
  stainIntensity: 0.7,
  colorStainA: '#1e0509',
  colorStainB: '#6a1018',

  /* --- dynamic light ------------------------------------------------------ */
  // Low. Blood is not a light source; this is here so the beads have a second
  // highlight and the mist has something to scatter.
  lightIntensity: 9.0,
  lightRadius: 11.0,
  lightColor: '#c8323c'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Sanguine Pact.
 *
 * `The orbits` is the folder that owns the ability. `orbitTilt` at zero is a
 * flat ring and a flat ring is a sticker; anywhere between 0.6 and 1.2 radians
 * the beads pass in front of and behind the column and the cast has depth.
 * `The seal` is the punctuation and `Beat timing` is where it lands.
 */
export const sanguinepactSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 16, 0.1, 'min range'],
    ['speed', 4, 80, 0.5, 'run-out speed'],
    ['zoneRadius', 1, 14, 0.05, 'footprint radius'],
    ['holdTime', 0.2, 8, 0.05, 'hold duration'],
    ['sealTime', 0.2, 8, 0.05, 'seal duration'],
    ['cooldown', 0, 10, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Beat timing': [
    ['climbTime', 0.05, 1, 0.01, 'beads reach full height at'],
    ['columnTime', 0.05, 1, 0.01, 'column reaches full height at'],
    ['sealSnap', 0.02, 1, 0.01, 'flatten takes'],
    ['sealHold', 0.02, 1, 0.01, 'rim stands until']
  ],
  'The pool': [
    ['poolScale', 0.1, 2, 0.01, '× footprint'],
    ['poolHeight', 0, 0.2, 0.001, 'height off the floor'],
    ['poolEdge', 0.02, 3, 0.01, 'edge feather'],
    ['poolRagged', 0, 1, 0.01, 'edge raggedness'],
    ['poolRaggedScale', 0.05, 4, 0.01, 'raggedness scale'],
    ['poolWarp', 0, 4, 0.01, 'domain warp'],
    ['poolRelief', 0, 3, 0.01, 'relief'],
    ['poolNormalStep', 0.005, 0.4, 0.005, 'normal step'],
    ['poolAmbient', 0, 1, 0.01, 'ambient floor'],
    ['poolWrap', 0, 1, 0.01, 'terminator wrap'],
    ['poolSpecular', 0, 5, 0.01, 'specular'],
    ['poolGloss', 1, 200, 1, 'gloss'],
    ['poolParallax', 0, 2, 0.01, 'parallax'],
    ['poolCell', 0.05, 4, 0.01, 'surface scale'],
    ['poolLift', 0, 0.4, 0.001, 'surface ripple'],
    ['poolDepth', 0, 1, 0.005, 'bowl depth'],
    ['poolThickness', 0.005, 0.5, 0.005, 'meniscus'],
    ['poolDetail', 0, 1, 0.01, 'grain'],
    ['poolSpeed', 0, 4, 0.01, 'churn rate'],
    ['poolFlow', 0, 2, 0.01, 'drift'],
    ['poolWindAngle', -3.2, 3.2, 0.01, 'drift bearing'],
    ['poolEmissive', 0, 3, 0.01, 'sheen gain'],
    ['poolOpacity', 0, 1, 0.01, 'opacity'],
    ['poolDepthFade', 0.02, 3, 0.01, 'soft intersection'],
    ['colorPoolBase', 'liquid'],
    ['colorPoolEdge', 'meniscus'],
    ['colorPoolGlow', 'inner bloom'],
    ['colorPoolDeep', 'depth']
  ],
  'The column': [
    ['mistScale', 0.1, 2, 0.01, '× footprint'],
    ['mistHeight', 0.5, 16, 0.05, 'height (m)']
  ],
  ...volumeHullSchema('mist', {
    label: 'The column',
    only: ['march', 'shape', 'field', 'flow', 'optics', 'colour']
  }),
  'The beads': [
    ['beadCount', 0, 96, 1, 'beads'],
    ['beadSize', 0.01, 0.5, 0.005, 'bead radius'],
    ['beadSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['beadClimbBase', -0.5, 3, 0.01, 'lowest orbit'],
    ['beadClimbTop', 0.1, 12, 0.05, 'highest orbit'],
    ['beadWobble', 0, 1, 0.005, 'vertical breathing'],
    ['beadWobbleRate', 0, 8, 0.01, 'breathing rate'],
    ['beadRevealSpread', 0.02, 1, 0.01, 'appear width'],
    ['beadAmbient', 0, 1, 0.01, 'ambient floor'],
    ['beadWrap', 0, 1.5, 0.01, 'terminator wrap'],
    ['beadSpecular', 0, 6, 0.01, 'specular'],
    ['beadGloss', 2, 200, 1, 'gloss'],
    ['beadFresnel', 0, 4, 0.01, 'fresnel'],
    ['beadGlow', 0, 4, 0.01, 'glow'],
    ['beadOpacity', 0, 1, 0.01, 'opacity'],
    ['beadTintAlong', 0, 1, 0.01, 'gradient by height'],
    ['beadTintJitter', 0, 1, 0.01, 'gradient jitter'],
    ['colorBeadBody', 'lit side'],
    ['colorBeadDeep', 'shadow side'],
    ['colorBeadRim', 'fresnel edge'],
    ['colorBeadSheen', 'highlight']
  ],
  'The orbits': [
    ['orbitScale', 0.05, 2, 0.01, '× footprint'],
    ['orbitRadiusJitter', 0, 1, 0.01, 'radius jitter'],
    ['orbitEccentric', 0, 0.95, 0.01, 'eccentricity'],
    ['orbitTilt', 0, 1.6, 0.01, 'inclination'],
    ['orbitTiltSpread', 0, 1.6, 0.01, 'inclination spread'],
    ['orbitNodeJitter', 0, 1, 0.01, 'node jitter'],
    ['orbitSpin', -2, 2, 0.005, 'turns / second'],
    ['orbitSpinJitter', 0, 1, 0.01, 'rate jitter']
  ],
  'The seal': [
    ['rimScale', 0.05, 2, 0.01, '× footprint'],
    ['rimHeight', 0, 4, 0.01, 'rim height'],
    ['rimMerge', 0, 1, 0.01, 'beads merge'],
    ['rimMergeStretch', 1, 8, 0.01, 'merged length'],
    ['sealBurstSize', 0.2, 14, 0.05, 'burst size'],
    ['sealBurstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['sealDrips', 0, 600, 1, 'burst drips'],
    ['sealMotes', 0, 600, 1, 'burst motes'],
    ['sealShockRadius', 0.5, 24, 0.1, 'shockwave radius'],
    ['sealShake', 0, 3, 0.01, 'shake'],
    ['sealShakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['sealFlash', 0, 1, 0.005, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'standing rumble'],
    ['colorSealA', 'burst shell'],
    ['colorSealB', 'burst body'],
    ['colorSealC', 'burst filaments'],
    ['colorSealShockA', 'shockwave ring'],
    ['colorSealShockB', 'shockwave crest'],
    ['colorFlash', 'screen flash colour']
  ],
  'Climbing threads': [
    ['threadCount', 0, 20, 1, 'filaments'],
    ['threadRadiusScale', 0.05, 2, 0.01, '× footprint'],
    ['threadPoleHeight', 0.1, 12, 0.05, 'orbital axis height'],
    ['threadArc', 0.02, 2, 0.01, 'turns covered'],
    ['threadSpin', -2, 2, 0.005, 'turns / second'],
    ['threadWobble', 0, 1, 0.01, 'off-circle'],
    ['threadTilt', 0, 1.6, 0.01, 'inclination'],
    ['threadTiltSpread', 0, 1.6, 0.01, 'inclination spread'],
    ['threadRadiusJitter', 0, 1, 0.01, 'radius jitter'],
    ['threadKink', 0, 3, 0.01, '× kink'],
    ['threadWidthScale', 0, 4, 0.01, '× width'],
    ['threadDim', 0, 1, 0.01, 'dim']
  ],
  'Rim arcs': [
    ['rimArcs', 0, 20, 1, 'arcs'],
    ['rimSpan', 0.01, 1, 0.005, 'turns covered'],
    ['rimSpeed', -3, 3, 0.01, 'turns / second'],
    ['rimArcLift', 0, 2, 0.01, 'hop at mid-span'],
    ['rimArcJitter', 0, 2, 0.01, 'radial slop'],
    ['rimArcHug', 0, 1, 0.005, 'float above the plane'],
    ['rimKink', 0, 3, 0.01, '× kink'],
    ['rimWidthScale', 0, 4, 0.01, '× width'],
    ['rimDim', 0, 1, 0.01, 'dim']
  ],
  'The leash': [
    ['leashCount', 0, 12, 1, 'filaments'],
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['leashSag', -3, 3, 0.01, 'mid-span bow'],
    ['leashSpread', 0, 4, 0.01, 'fan at the circle'],
    ['leashSpreadNear', 0, 2, 0.01, 'fan at the hand'],
    ['leashSpreadCurve', 0.2, 5, 0.01, 'fan curve'],
    ['leashTwist', -4, 4, 0.01, 'twist over length'],
    ['leashTwistSpeed', -6, 6, 0.01, 'twist speed'],
    ['leashConverge', 0, 1, 0.01, 'lock onto the circle'],
    ['leashKink', 0, 3, 0.01, '× kink'],
    ['leashWidthScale', 0, 4, 0.01, '× width'],
    ['leashDim', 0, 1, 0.01, 'dim']
  ],
  'Filament look': [
    ['threadWidth', 0.002, 0.3, 0.001, 'core half-width'],
    ['threadGlowWidth', 1, 24, 0.1, 'halo width'],
    ['threadGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['threadJitter', 0, 2, 0.005, 'kink amplitude'],
    ['threadJitterScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['threadOctaves', 1, 5, 1, 'octaves'],
    ['threadJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['threadCrawl', -10, 10, 0.05, 'kink crawl'],
    ['threadPinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['threadRestrike', 0.5, 60, 0.5, 'restrikes / sec'],
    ['threadFlicker', 0, 1, 0.01, 'brightness stutter'],
    ['threadFlickerSpeed', 1, 90, 1, 'stutter rate'],
    ['threadStrandFlash', 0, 1, 0.01, 'filament blink'],
    ['threadCoreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['threadGlowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['threadSoftFade', 0.02, 3, 0.01, 'soft intersection'],
    ['threadOpacity', 0, 2, 0.01, 'opacity'],
    ['threadGlow', 0, 4, 0.01, 'glow'],
    ['colorThreadCore', 'core'],
    ['colorThreadInner', 'inner'],
    ['colorThreadOuter', 'outer'],
    ['colorThreadHalo', 'halo']
  ],
  'Motes & drips': [
    ['moteRate', 0, 500, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 8, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -2, 8, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['dripRate', 0, 300, 1, 'drip rate'],
    ['dripSize', 0.005, 0.4, 0.005, 'drip size'],
    ['dripSpeed', 0, 12, 0.05, 'drip speed'],
    ['dripLifetime', 0.1, 5, 0.05, 'drip lifetime'],
    ['dripGravity', -40, 0, 0.1, 'drip gravity'],
    ['colorMote*', 'Mote colour'],
    ['colorDrip*', 'Drip colour']
  ],
  'The stain': [
    ['stainRadius', 0.2, 12, 0.05, 'radius'],
    ['stainLife', 0.5, 24, 0.1, 'lifetime'],
    ['stainIntensity', 0, 3, 0.01, 'intensity'],
    ['colorStainA', 'stain'],
    ['colorStainB', 'rim']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
