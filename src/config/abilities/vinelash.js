/* ================================================================== */
/* VINELASH — Verdant Lash                                             */
/* ================================================================== */
/**
 * A vine that **grows** down the aimed line rather than flying along it, and
 * then snaps back like a released branch.
 *
 * Three things carry the read, and each one is a separate group below:
 *
 *  1. **the stem** — a `Tube` on the `VINE` path. The front *is* the length
 *     (`vineTipTaper` runs the radius to nothing at the growing tip), and
 *     `vineRecoilAmp/Freq/Damp` are a damped cosine that hauls the whole curve
 *     back at full extension and lets it overshoot. Every one of those is a
 *     live slider, so a paused vine re-springs under the mouse.
 *  2. **the bark** — a swept mesh whose vertices are re-read off the tube's own
 *     `pointAt()` / `radiusAt()` every frame, shaded with a *lengthwise* ridged
 *     field and a wet highlight on whichever facets happen to point up. This is
 *     the solid, lit, shadow-casting body; the tube behind it is only the sap
 *     light bleeding out around its silhouette and blazing at the tip.
 *  3. **the leaves** — a `Swarm` of `LEAF` agents strung out behind a lead that
 *     rides the growing front, so they unfurl along the stem as it passes; and
 *     a torn-leaf particle system that the *snap-back speed* feeds, so the
 *     stripping is a consequence of the geometry rather than a scheduled event.
 *
 * ### Why the seventy-nine `vine*` keys are spelled out here
 *
 * `Tube` reads a **prefixed** block (`c[keys.radius]` → `c.vineRadius`), and
 * `vfx/Tube.js` exports `tubeDefaults('vine', TubePath.VINE)` which returns
 * exactly this fragment in one line. It is written out instead, for two
 * reasons. The first is the house rule that every settings field carries a
 * trailing comment naming what it is and in what unit — a spread fragment
 * carries none, and eighty undocumented sliders is eighty sliders nobody will
 * touch. The second is an import cycle: `vfx/Tube.js` imports
 * `config/settings.js`, which imports `config/abilities/index.js`, which would
 * import this module — and whichever of the three a consumer happens to load
 * first decides whether `tubeDefaults` is initialised by the time this file
 * evaluates. Settings modules stay import-free, as `config/abilities/index.js`
 * says they must.
 *
 * The keys the other four tube paths use (`vineWave*`, the `FUNNEL` group, the
 * `ARC` group) are present and inert. They are here because `Tube#_audit`
 * warns once naming every key a block is missing, and because re-pathing this
 * ability is then a one-word change to the constructor rather than a settings
 * migration.
 */
export const vinelash = {
  /* --- the cast --- */
  range: 17.0, // maximum cast distance, metres
  minRange: 2.5, // closer than this and the cast is refused
  speed: 26.0, // how fast the growing tip travels, metres/second
  lifetime: 0.9, // seconds the vine holds and rings after the snap
  fadeTime: 1.1, // seconds it takes to wither
  cooldown: 0.9, // seconds before it can be cast again
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the stem leaves the caster --- */
  handHeight: 1.24, // metres above the floor the vine sprouts at
  handForward: 0.5, // metres in front of the caster
  handSide: 0.22, // metres to the side (+ follows `Ability#side`)
  endHeight: 0.55, // height of the stem where it reaches the target, metres

  /* ------------------------------------------------------------------ */
  /* The stem — `Tube`, path VINE, prefix `vine`                         */
  /* ------------------------------------------------------------------ */

  /* --- the radius profile (VINE reads `vineRadius` and `vineTipTaper`) --- */
  vineRadius: 0.19, // half-width of the stem at the base, metres
  vineRadiusNear: 0.22, // (inert on VINE) half-width at the muzzle, metres
  vineRadiusCurve: 0.7, // (inert on VINE) <1 opens early, >1 opens late
  vineFlare: 0.0, // (inert on VINE) extra half-width where it lands, × radius
  vineFlareWidth: 0.22, // (inert on VINE) fraction of the length that flares
  vineThrob: 0.035, // breathing amplitude of the stem, × radius
  vineThrobScale: 3.4, // pressure waves along the stem, cycles per length
  vineThrobSpeed: 1.1, // Hz they travel at

  /* --- the axis --- */
  vineWander: 0.035, // smooth low-frequency drift of the axis, metres
  vineWanderScale: 1.4, // drift features per length
  vineWanderSpeed: 0.55, // Hz the drift crawls at

  /* --- the surface of the sap column --- */
  vineRipple: 0.22, // radial break-up of the barrel, × radius
  vineRippleBands: 2.4, // break-up features around the barrel
  vineRippleScale: 4.2, // break-up features along it
  vineRippleSpeed: 1.2, // Hz it crawls downrange at
  vineStreak: 0.55, // sap filaments streaming down the surface
  vineStreakSharp: 0.62, // 0 = soft wash, 1 = hard threads
  vineStreakScale: 7.5, // filament features per length
  vineStreakBands: 3.2, // filament features around the barrel
  vineStreakGlow: 0.9, // how hard the sheath's filaments burn to core colour
  vineFlowSpeed: 1.6, // parameter-per-second the sap filaments run
  vineBands: 9.0, // leaf-node rings along the stem, cycles per length
  vineBandSharp: 2.6, // how tight each node ring is
  vineBandDepth: 0.5, // how much the rings modulate alpha, 0..1
  vineBandSpeed: 0.0, // Hz the rings travel at (0 = nodes stay put)

  /* --- the three layers --- */
  vineCoreWidth: 0.5, // core radius, × the profile
  vineCoreFill: 0.55, // how solid the sap core reads
  vineCoreSharp: 1.5, // axis-weighting exponent — the inversion
  vineEdgePower: 2.4, // rim-weighting exponent for the sheath
  vineSheathWidth: 1.12, // sheath radius, × the profile
  vineSheathRim: 1.0, // strength of the sheath's silhouette
  vineSheathFill: 0.14, // how much body the sheath keeps
  vineSheathOpacity: 0.85, // opacity of the sheath pass
  vineHaloWidth: 1.75, // halo radius, × the profile
  vineHaloRim: 2.8, // rim exponent — high, so it is only a silhouette
  vineHaloOpacity: 0.42, // opacity of the halo pass

  /* --- the ends --- */
  vineMuzzleGlow: 1.2, // brightness where the stem leaves the caster
  vineMuzzleLength: 0.08, // how far that glow reaches, fraction of length
  vineTipGlow: 2.4, // brightness of the growing tip
  vineTipLength: 0.05, // how soft that tip is, fraction of length

  /* --- WHIP group: inert on the VINE path --- */
  vineWaveRate: 1.35, // (inert) loops per second travelling handle → tip
  vineWaveWidth: 0.16, // (inert) how tight the loop is, fraction of length
  vineWaveAmp: 0.3, // (inert) lateral throw of the loop, fraction of length
  vineWaveGain: 2.2, // (inert) how much the loop grows toward the tip, ×
  vineWaveCurve: 1.6, // (inert) when that growth happens, >1 = late
  vineWaveRoll: 0.0, // (inert) plane the loop cracks in, radians
  vineSag: 0.12, // (inert) how far a whip hangs under its weight, metres
  vineCrackRatio: 1.0, // (inert) tip ÷ wave speed at which a whip cracks

  /* --- FUNNEL group: inert on the VINE path --- */
  vineThroat: 0.55, // (inert) the vortex waist, metres
  vineSkirtFlare: 1.6, // (inert) extra radius at the floor, metres
  vineSkirtHeight: 0.24, // (inert) how far up the skirt reaches, fraction
  vineSkirtCurve: 1.7, // (inert) how abruptly it flares
  vineMouthFlare: 2.4, // (inert) extra radius at the top, metres
  vineMouthStart: 0.55, // (inert) where the mouth opens, fraction of height
  vineMouthCurve: 1.4, // (inert) how abruptly it opens
  vineSpin: 0.9, // (inert) revolutions per second the surface rotates
  vineSpinTwist: 1.6, // (inert) extra revolutions floor → mouth
  vineSway: 0.35, // (inert) how far the axis precesses, metres
  vineSwayScale: 0.5, // (inert) twist of the precession along the height
  vineSwaySpeed: 0.25, // (inert) revolutions per second it precesses
  vineSwayCurve: 1.8, // (inert) how much of the sway is at the top

  /* --- VINE group: the ones that matter --- */
  vineTipTaper: 1.45, // how fast the radius falls to zero at the front
  vineMeander: 0.26, // helical wander of the stem, metres
  vineMeanderTurns: 1.15, // turns of that helix over the length
  vineRecoilAmp: 0.42, // how far the spring hauls the tip back, fraction
  vineRecoilFreq: 2.35, // Hz the recoil spring rings at
  vineRecoilDamp: 3.1, // s⁻¹ the ringing dies at
  vineRecoilSway: 0.85, // lateral bow while it is recoiling, metres

  /* --- ARC group: inert on the VINE path --- */
  vineArcHeight: 2.6, // (inert) apex height above the chord, metres
  vineArcLateral: 0.0, // (inert) apex offset across the chord, metres
  vineArcBias: 0.5, // (inert) where the apex sits, 0..1 along the chord
  vineArcCurve: 1.0, // (inert) >1 pinches the apex, <1 flattens the top

  /* --- rendering --- */
  vineOpacity: 0.95, // master alpha of the three sap layers
  vineGlow: 1.35, // emissive gain into bloom
  vineSoftFade: 0.5, // metres of depth fade against the opaque scene

  /* --- the sap palette (I5: four pickers, none derived from another) --- */
  vineColorCore: '#eaffc8', // the axis-weighted middle of the sap column
  vineColorInner: '#b6f07a', // just off the middle
  vineColorOuter: '#4e9a2c', // the sheath body
  vineColorHalo: '#123d12', // the outer bloom

  /* ------------------------------------------------------------------ */
  /* The bark — the swept, lit body                                      */
  /* ------------------------------------------------------------------ */
  barkScale: 0.86, // bark radius, × the tube's own profile
  barkSwell: 0.14, // extra radius on the node rings, × the profile
  barkNodes: 9.0, // node swellings along the stem, cycles per metre-parameter
  barkRidge: 0.75, // depth of the lengthwise grooves, 0..1
  barkRidgeScale: 0.55, // groove features per metre *along* the stem
  barkRidgeBands: 3.6, // groove features *around* the stem
  barkGrain: 0.32, // fine fibrous grain over the grooves, 0..1
  barkGrainScale: 9.0, // grain features per metre along the stem
  barkGrainBands: 7.0, // grain features around the stem
  barkDepth: 0.85, // how far a groove darkens toward `colorBarkDeep`
  barkRoughness: 0.72, // roughness on a ridge
  barkRoughnessWet: 0.24, // roughness in a groove, where the sap sits
  barkEnv: 0.45, // environment-map intensity on the bark
  sapGlow: 1.5, // emissive of the sap showing through the grooves
  sapPulse: 0.55, // depth of the pulse of sap running up the stem, 0..1
  sapPulseScale: 1.4, // pulses per metre along the stem
  sapPulseSpeed: 2.4, // metres/second the pulse travels
  sheen: 1.6, // strength of the wet highlight on upward-facing bark
  sheenPower: 5.5, // how tight that highlight band is; higher = narrower
  glisten: 0.9, // moving specks inside the highlight, 0..1
  glistenScale: 26.0, // specks per metre
  glistenSpeed: 0.7, // metres/second they crawl at
  witherDarken: 0.9, // how far the bark goes to `colorWither` as it dies
  colorBark: '#6ba83a', // the lit face of the bark
  colorBarkDeep: '#2a4a18', // the bottom of a groove
  colorSap: '#c8ff8a', // the sap glowing out of the grooves
  colorSheen: '#d8ffb0', // the wet highlight along the top of the curve
  colorWither: '#4a3a20', // what the bark goes to as the vine dies

  /* ------------------------------------------------------------------ */
  /* The leaves — `Swarm`, silhouette LEAF                               */
  /* ------------------------------------------------------------------ */
  leafCount: 84, // live leaves on the stem at full extension
  leafSize: 0.29, // metres, stalk to tip
  leafAspect: 0.78, // width ÷ length of one leaf
  leafSizeJitter: 0.45, // ± fraction of per-leaf size variation
  leafCurl: 0.42, // how far a leaf cups across its chord, fraction of size
  leafBank: 0.05, // radians of roll per m/s² of lateral acceleration
  leafBankMax: 1.4, // radians the bank is clamped to
  leafFold: 0.22, // out-of-plane fold of the two halves, fraction of size
  leafFlapRate: 2.6, // flutter cycles per second
  leafLatticeX: 5, // formation cells across the stem
  leafLatticeY: 3, // formation cells up
  leafLatticeZ: 12, // ranks strung out behind the growing tip
  leafSpacingSide: 0.28, // metres between lateral cells
  leafSpacingUp: 0.24, // metres between vertical cells
  leafSpan: 0.94, // fraction of the *grown* stem the leaves cover, 0..1
  leafJitter: 0.11, // metres of slop off the cell
  leafChurn: 0.5, // radians/second the formation rolls
  leafBreathe: 0.16, // fraction the formation swells by
  leafBreatheRate: 1.9, // radians/second of that swell
  leafWander: 0.09, // metres of curl drift — keep under half the spacing
  leafWanderScale: 0.8, // drift features per metre
  leafWanderSpeed: 0.6, // Hz the drift crawls at
  leafGather: 0.92, // 0 collapses every leaf onto the stem's own line
  leafLeadRise: 0.0, // metres the lead lofts at mid-span
  leafRevealSpread: 0.3, // width of the unfurl wave, fraction of the stem
  leafBillboard: 0.25, // 0 = a plate in the world, 1 = always camera-facing
  leafEdgeStretch: 1.5, // how much an edge-on leaf grows so it stays visible
  leafEdgeGain: 1.8, // emission multiplier when a leaf goes edge-on
  leafLit: 0.72, // 0 emissive, 1 wrapped diffuse
  leafTint: 0.35, // where in the gradient the flock sits
  leafTintJitter: 0.32, // ± per-leaf walk along the gradient
  leafTintAlong: 0.4, // extra walk from the tip back to the base
  leafOpacity: 1.0, // master alpha of the leaves
  leafGlow: 0.85, // emissive gain into bloom
  leafSoftFade: 0.3, // metres of depth feather against solid geometry
  colorLeafA: '#c8d86a', // new growth at the unfurling tip
  colorLeafB: '#7fc84a',
  colorLeafC: '#4b8a28',
  colorLeafD: '#22400f', // the oldest leaves, back at the caster's hand

  /* ------------------------------------------------------------------ */
  /* The snap                                                            */
  /* ------------------------------------------------------------------ */
  /**
   * The strip is driven by `Tube#tipSpeed`, which is the vine's own curve
   * differentiated with respect to the spring's clock — so it is correct on a
   * zero-length frame and a paused drag on `vineRecoilFreq` genuinely changes
   * how hard the leaves come off.
   */
  stripThreshold: 6.0, // metres/second of tip speed below which nothing strips
  stripRate: 22.0, // torn leaves per second per (m/s) over the threshold
  stripBurst: 90, // torn leaves thrown on the frame the snap fires
  stripFade: 0.55, // seconds the standing leaves take to wink out after the snap
  snapShake: 0.7, // camera shake on the snap
  shakeDuration: 0.5, // seconds that shake takes to die
  snapFlash: 0.16, // full-screen flash on the snap
  rumble: 0.02, // continuous shake while the vine is growing
  burstSize: 2.4, // the shell of leaf-litter at the tip, metres
  burstIntensity: 1.15, // brightness of that shell
  dustRadius: 1.5, // ground dust ring under the tip, metres
  dustLife: 1.6, // seconds it lingers
  dustIntensity: 0.55, // brightness of the dust ring
  colorBurstA: '#4b8a28', // burst shell
  colorBurstB: '#c8d86a', // burst body
  colorBurstC: '#eaffc8', // burst filaments
  colorSnapFlash: '#c8ff8a', // the screen flash on the snap
  colorDust: '#6d6042', // the ground dust ring

  /* ------------------------------------------------------------------ */
  /* Torn leaves, pollen and bark chips                                  */
  /* ------------------------------------------------------------------ */
  /**
   * As everywhere else in the sandbox each system is coloured by a four-stop
   * gradient sampled over the particle's own lifetime, `A` at birth through `D`
   * as it dies. Spelled out rather than derived from the leaf palette, so the
   * torn leaves can brown off while the ones still on the stem stay green.
   */
  tornSize: 0.16, // torn-leaf size
  tornSpeed: 4.5, // metres/second they are flung at
  tornLifetime: 2.4, // seconds one lives
  tornGravity: -4.2, // metres/second² — leaves fall slowly
  tornSpin: 5.5, // radians/second they tumble at
  colorTornA: '#d8f09a',
  colorTornB: '#8fc84a',
  colorTornC: '#5a8a2a',
  colorTornD: '#3a4a1a',
  pollenRate: 70, // motes drifting off the stem, particles/second
  pollenSize: 0.045, // mote size
  pollenSpeed: 0.9, // metres/second they leave the stem at
  pollenLifetime: 2.1, // seconds one lives
  pollenRise: 0.75, // upward drift, metres/second
  pollenTurbulence: 0.85, // how hard the curl field pushes them around
  colorPollenA: '#f2ffd0',
  colorPollenB: '#c8ff8a',
  colorPollenC: '#7fc84a',
  colorPollenD: '#20400f',
  chipRate: 26, // bark chips shed while the stem grows, particles/second
  chipSize: 0.05, // chip size
  chipSpeed: 2.6, // metres/second they are shed at
  chipLifetime: 1.5, // seconds one lives
  chipGravity: -13.0, // metres/second²
  colorChipA: '#5c4a2a',
  colorChipB: '#4a3a20',
  colorChipC: '#332616',
  colorChipD: '#241b10',

  /* --- dynamic light --- */
  lightIntensity: 14, // the sap light riding the growing tip
  lightRadius: 11, // metres it reaches
  lightColor: '#a8f060' // its colour
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Verdant Lash.
 *
 * The four controls that carry the character, reach for these first:
 * `vineTipTaper` (how needle-like the growing front is), `vineMeander` (how
 * much the stem writhes), `vineRecoilAmp` (how violently it snaps back) and
 * `barkRidge` (whether it reads as bark or as a glowing hose). Everything in
 * "The stem" is a `Tube` uniform read on the frame it changes, so the whole
 * folder reshapes a vine that is already standing with the clock stopped.
 */
export const vinelashSchema = {
  'The cast': [
    ['range', 2, 40, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 3, 90, 0.5, 'growth speed'],
    ['lifetime', 0.1, 5, 0.01, 'hold after the snap'],
    ['fadeTime', 0.1, 5, 0.01, 'wither time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where it sprouts': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['endHeight', 0, 4, 0.01, 'height at target']
  ],

  'The stem/The vine': [
    ['vineTipTaper', 0.05, 6, 0.01, 'tip taper'],
    ['vineMeander', 0, 2, 0.01, 'meander (m)'],
    ['vineMeanderTurns', 0, 8, 0.01, 'meander turns'],
    ['vineRecoilAmp', 0, 1, 0.01, 'recoil'],
    ['vineRecoilFreq', 0, 10, 0.01, 'recoil Hz'],
    ['vineRecoilDamp', 0.1, 16, 0.01, 'recoil damping'],
    ['vineRecoilSway', 0, 4, 0.01, 'recoil bow (m)']
  ],
  'The stem/Profile': [
    ['vineRadius', 0.01, 1.5, 0.005, 'stem radius (m)'],
    ['vineThrob', 0, 0.5, 0.001, 'throb'],
    ['vineThrobScale', 0, 12, 0.1, 'throb bands'],
    ['vineThrobSpeed', 0, 8, 0.01, 'throb Hz'],
    ['vineWander', 0, 1, 0.001, 'axis drift (m)'],
    ['vineWanderScale', 0, 6, 0.01, 'drift scale'],
    ['vineWanderSpeed', 0, 4, 0.01, 'drift Hz']
  ],
  'The stem/Core / sheath / halo': [
    ['vineCoreWidth', 0.02, 2, 0.01, 'core width'],
    ['vineCoreFill', 0, 2, 0.01, 'core fill'],
    ['vineCoreSharp', 0.05, 8, 0.01, 'core axis power'],
    ['vineEdgePower', 0.05, 8, 0.01, 'sheath rim power'],
    ['vineSheathWidth', 0.05, 3, 0.01, 'sheath width'],
    ['vineSheathRim', 0, 2, 0.01, 'sheath rim'],
    ['vineSheathFill', 0, 1, 0.01, 'sheath fill'],
    ['vineSheathOpacity', 0, 1, 0.01, 'sheath opacity'],
    ['vineHaloWidth', 0.05, 6, 0.01, 'halo width'],
    ['vineHaloRim', 0.05, 10, 0.01, 'halo rim power'],
    ['vineHaloOpacity', 0, 1, 0.01, 'halo opacity']
  ],
  'The stem/Sap surface': [
    ['vineRipple', 0, 1, 0.01, 'ripple'],
    ['vineRippleBands', 0, 8, 0.01, 'ripple bands'],
    ['vineRippleScale', 0, 12, 0.01, 'ripple scale'],
    ['vineRippleSpeed', 0, 10, 0.01, 'ripple Hz'],
    ['vineStreak', 0, 2, 0.01, 'sap filaments'],
    ['vineStreakSharp', 0, 1, 0.01, 'filament sharpness'],
    ['vineStreakScale', 0, 20, 0.1, 'filament scale'],
    ['vineStreakBands', 0, 8, 0.01, 'filament bands'],
    ['vineStreakGlow', 0, 3, 0.01, 'filament glow'],
    ['vineFlowSpeed', -12, 24, 0.1, 'flow speed'],
    ['vineBands', 0, 24, 0.1, 'node rings/length'],
    ['vineBandSharp', 0.05, 8, 0.01, 'ring sharpness'],
    ['vineBandDepth', 0, 1, 0.01, 'ring depth'],
    ['vineBandSpeed', -6, 6, 0.01, 'ring Hz']
  ],
  'The stem/The ends': [
    ['vineMuzzleGlow', 0, 5, 0.01, 'root glow'],
    ['vineMuzzleLength', 0, 0.6, 0.001, 'root glow length'],
    ['vineTipGlow', 0, 5, 0.01, 'tip glow'],
    ['vineTipLength', 0.001, 0.4, 0.001, 'tip length']
  ],
  'The stem/Sap colour & render': [
    ['vineColorCore', 'sap core'],
    ['vineColorInner', 'sap inner'],
    ['vineColorOuter', 'sap outer'],
    ['vineColorHalo', 'sap halo'],
    ['vineOpacity', 0, 1, 0.01, 'opacity'],
    ['vineGlow', 0, 8, 0.01, 'glow'],
    ['vineSoftFade', 0, 3, 0.01, 'soft fade (m)']
  ],
  /**
   * The keys the other four `TubePath`s use. Present so `Tube#_audit` stays
   * quiet and so the stem can be re-pathed without a settings migration;
   * dragging any of them does nothing on `VINE`, which is why they are filed
   * together and last.
   */
  'The stem/Inert here (WHIP · FUNNEL · ARC)': [
    ['vineRadiusNear', 0.01, 4, 0.01, 'near radius (m)'],
    ['vineRadiusCurve', 0.05, 4, 0.01, 'radius curve'],
    ['vineFlare', 0, 4, 0.01, 'flare'],
    ['vineFlareWidth', 0.01, 1, 0.01, 'flare width'],
    ['vineWaveRate', 0, 6, 0.01, 'loops/second'],
    ['vineWaveWidth', 0.02, 0.6, 0.001, 'loop width'],
    ['vineWaveAmp', 0, 1, 0.001, 'loop throw'],
    ['vineWaveGain', 0.2, 6, 0.01, 'loop gain'],
    ['vineWaveCurve', 0.1, 6, 0.01, 'gain curve'],
    ['vineWaveRoll', 0, 6.28318, 0.01, 'crack plane (rad)'],
    ['vineSag', 0, 2, 0.01, 'sag (m)'],
    ['vineCrackRatio', 0.2, 4, 0.01, 'crack ratio'],
    ['vineThroat', 0.02, 4, 0.01, 'throat (m)'],
    ['vineSkirtFlare', 0, 8, 0.01, 'skirt flare (m)'],
    ['vineSkirtHeight', 0.01, 1, 0.01, 'skirt height'],
    ['vineSkirtCurve', 0.1, 6, 0.01, 'skirt curve'],
    ['vineMouthFlare', 0, 12, 0.01, 'mouth flare (m)'],
    ['vineMouthStart', 0, 0.99, 0.01, 'mouth start'],
    ['vineMouthCurve', 0.1, 6, 0.01, 'mouth curve'],
    ['vineSpin', -6, 6, 0.01, 'spin (rev/s)'],
    ['vineSpinTwist', -8, 8, 0.01, 'twist'],
    ['vineSway', 0, 4, 0.01, 'precession (m)'],
    ['vineSwayScale', 0, 3, 0.01, 'precession twist'],
    ['vineSwaySpeed', -3, 3, 0.01, 'precession (rev/s)'],
    ['vineSwayCurve', 0.1, 6, 0.01, 'precession curve'],
    ['vineArcHeight', -12, 12, 0.01, 'apex height (m)'],
    ['vineArcLateral', -12, 12, 0.01, 'apex offset (m)'],
    ['vineArcBias', 0.05, 0.95, 0.01, 'apex position'],
    ['vineArcCurve', 0.1, 4, 0.01, 'apex curve']
  ],

  'The bark/Silhouette': [
    ['barkScale', 0.2, 1.6, 0.01, 'bark radius ×'],
    ['barkSwell', 0, 0.8, 0.01, 'node swell ×'],
    ['barkNodes', 0, 24, 0.1, 'nodes / metre']
  ],
  'The bark/Grooves & grain': [
    ['barkRidge', 0, 1, 0.01, 'groove depth'],
    ['barkRidgeScale', 0.02, 4, 0.01, 'grooves / m along'],
    ['barkRidgeBands', 0.5, 12, 0.05, 'grooves around'],
    ['barkGrain', 0, 1, 0.01, 'grain'],
    ['barkGrainScale', 0.5, 30, 0.1, 'grain / m along'],
    ['barkGrainBands', 0.5, 24, 0.1, 'grain around'],
    ['barkDepth', 0, 1, 0.01, 'groove darkening'],
    ['barkRoughness', 0.02, 1, 0.01, 'ridge roughness'],
    ['barkRoughnessWet', 0.02, 1, 0.01, 'groove roughness'],
    ['barkEnv', 0, 2, 0.01, 'env intensity']
  ],
  'The bark/Sap & wet highlight': [
    ['sapGlow', 0, 6, 0.01, 'sap glow'],
    ['sapPulse', 0, 1, 0.01, 'sap pulse depth'],
    ['sapPulseScale', 0, 6, 0.01, 'pulses / metre'],
    ['sapPulseSpeed', -8, 8, 0.01, 'pulse speed (m/s)'],
    ['sheen', 0, 5, 0.01, 'wet highlight'],
    ['sheenPower', 0.5, 20, 0.1, 'highlight tightness'],
    ['glisten', 0, 2, 0.01, 'glisten'],
    ['glistenScale', 1, 80, 0.5, 'glisten / metre'],
    ['glistenSpeed', -4, 4, 0.01, 'glisten crawl (m/s)'],
    ['witherDarken', 0, 1, 0.01, 'wither']
  ],
  'The bark/Colour': [
    ['colorBark', 'bark'],
    ['colorBarkDeep', 'groove'],
    ['colorSap', 'sap'],
    ['colorSheen', 'wet highlight'],
    ['colorWither', 'withered']
  ],

  'The leaves/Formation': [
    ['leafCount', 0, 220, 1, 'leaves'],
    ['leafLatticeX', 1, 16, 1, 'cells across'],
    ['leafLatticeY', 1, 10, 1, 'cells up'],
    ['leafLatticeZ', 1, 24, 1, 'ranks back'],
    ['leafSpacingSide', 0.02, 2, 0.01, 'lateral spacing (m)'],
    ['leafSpacingUp', 0.02, 2, 0.01, 'vertical spacing (m)'],
    ['leafSpan', 0, 1.4, 0.01, 'stem coverage'],
    ['leafJitter', 0, 1, 0.01, 'cell slop (m)'],
    ['leafChurn', -4, 4, 0.01, 'roll (rad/s)'],
    ['leafBreathe', 0, 1, 0.01, 'breathe'],
    ['leafBreatheRate', 0, 8, 0.01, 'breathe (rad/s)'],
    ['leafWander', 0, 1, 0.005, 'drift (m)'],
    ['leafWanderScale', 0, 4, 0.01, 'drift / metre'],
    ['leafWanderSpeed', 0, 4, 0.01, 'drift Hz'],
    ['leafGather', 0, 1, 0.01, 'hug the stem'],
    ['leafLeadRise', -2, 4, 0.01, 'lead loft (m)'],
    ['leafRevealSpread', 0.01, 1, 0.01, 'unfurl wave width']
  ],
  'The leaves/The leaf': [
    ['leafSize', 0.02, 1.5, 0.005, 'size (m)'],
    ['leafAspect', 0.1, 3, 0.01, 'aspect'],
    ['leafSizeJitter', 0, 1, 0.01, 'size jitter'],
    ['leafCurl', 0, 1.5, 0.01, 'cup'],
    ['leafFold', 0, 1.5, 0.01, 'fold'],
    ['leafFlapRate', 0, 14, 0.05, 'flutter Hz'],
    ['leafBank', 0, 0.4, 0.005, 'bank / (m/s²)'],
    ['leafBankMax', 0, 3, 0.01, 'bank limit (rad)'],
    ['leafBillboard', 0, 1, 0.01, 'camera facing'],
    ['leafEdgeStretch', 1, 4, 0.01, 'edge-on stretch'],
    ['leafEdgeGain', 0, 6, 0.01, 'edge-on gain']
  ],
  'The leaves/Colour': [
    ['leafLit', 0, 1, 0.01, 'lit ↔ emissive'],
    ['leafTint', 0, 1, 0.01, 'gradient position'],
    ['leafTintJitter', 0, 1, 0.01, 'gradient jitter'],
    ['leafTintAlong', 0, 1, 0.01, 'gradient along'],
    ['leafOpacity', 0, 1, 0.01, 'opacity'],
    ['leafGlow', 0, 4, 0.01, 'glow'],
    ['leafSoftFade', 0.02, 2, 0.01, 'soft fade (m)'],
    ['colorLeaf*', 'Leaf colour']
  ],

  'The snap': [
    ['stripThreshold', 0, 40, 0.1, 'strip threshold (m/s)'],
    ['stripRate', 0, 120, 0.5, 'strip rate / (m/s)'],
    ['stripBurst', 0, 400, 1, 'leaves torn on the snap'],
    ['stripFade', 0.05, 3, 0.01, 'standing leaves fade (s)'],
    ['snapShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['snapFlash', 0, 2, 0.01, 'screen flash'],
    ['rumble', 0, 0.5, 0.005, 'growth rumble'],
    ['burstSize', 0.2, 10, 0.05, 'burst size (m)'],
    ['burstIntensity', 0, 5, 0.01, 'burst intensity'],
    ['dustRadius', 0.1, 8, 0.05, 'dust radius (m)'],
    ['dustLife', 0.1, 8, 0.05, 'dust lifetime (s)'],
    ['dustIntensity', 0, 3, 0.01, 'dust intensity'],
    ['colorBurstA', 'burst shell'],
    ['colorBurstB', 'burst body'],
    ['colorBurstC', 'burst filaments'],
    ['colorSnapFlash', 'snap flash colour'],
    ['colorDust', 'dust colour']
  ],
  'Torn leaves & pollen': [
    ['tornSize', 0.005, 0.8, 0.005, 'torn leaf size'],
    ['tornSpeed', 0, 25, 0.1, 'torn leaf speed'],
    ['tornLifetime', 0.1, 8, 0.05, 'torn leaf lifetime'],
    ['tornGravity', -30, 2, 0.1, 'torn leaf gravity'],
    ['tornSpin', 0, 20, 0.1, 'torn leaf tumble'],
    ['pollenRate', 0, 600, 1, 'pollen rate'],
    ['pollenSize', 0.005, 0.4, 0.005, 'pollen size'],
    ['pollenSpeed', 0, 12, 0.05, 'pollen speed'],
    ['pollenLifetime', 0.1, 8, 0.05, 'pollen lifetime'],
    ['pollenRise', -3, 8, 0.05, 'pollen rise'],
    ['pollenTurbulence', 0, 3, 0.01, 'pollen turbulence'],
    ['colorTorn*', 'Torn leaf colour'],
    ['colorPollen*', 'Pollen colour']
  ],
  'Bark chips': [
    ['chipRate', 0, 300, 1, 'chip rate'],
    ['chipSize', 0.005, 0.4, 0.005, 'chip size'],
    ['chipSpeed', 0, 20, 0.1, 'chip speed'],
    ['chipLifetime', 0.1, 5, 0.05, 'chip lifetime'],
    ['chipGravity', -40, 0, 0.1, 'chip gravity'],
    ['colorChip*', 'Chip colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
