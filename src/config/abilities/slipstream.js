/* ================================================================== */
/* SLIPSTREAM — the vacuum blade                                       */
/* ================================================================== */
/**
 * A blade of vacuum drawn along the aimed line.
 *
 * This is the most restrained block in the sandbox and it is meant to be. The
 * ability draws a hairline thread and *nothing else*: everything you actually
 * read is the scene behind the blade sliding sideways, written into the
 * refraction buffer by one `DistortionField(BLADE)`. There is no shell, no
 * spark system, no ground burn. If you find yourself reaching for one, the two
 * sliders you actually wanted are `bladeHeight` and `refractStrength`.
 *
 * ### The two numbers that decide everything
 *
 * `bladeHeight` is how deep the sheet of disturbed air is, in metres, and
 * `refractStrength` is how hard it bends what is behind it, in **screen widths
 * at `post.distortion = 1`**. Not metres — a fragment writing `1` shifts the
 * frame under it by a whole `post.distortion` of screen width at any distance,
 * which is what makes an authored strength mean the same thing on a cast that
 * lands two metres away and one that lands twenty. Neither of the two master
 * gains (`post.distortion`, `global.distortion`) is folded in here; the pass
 * applies both, once.
 *
 * ### Metres, not fractions
 *
 * `DistortionField` expresses the hairline and the wake as fractions of the
 * blade's height, which is the right contract for a general emitter and the
 * wrong one for an ability: dragging `bladeHeight` would then scale the
 * hairline with it and the blade would read as the *same* blade, bigger.
 * `refractEdgeWidth` and `refractWakeDepth` below are therefore in metres and
 * `SlipstreamAbility#_sync` divides. Drag the height and the hairline stays
 * put; that is the difference between a blade getting deeper and a blade being
 * zoomed.
 *
 * ### Why the eighty `thread*` keys are spelled out and not spread
 *
 * `Tube.js` ships `tubeDefaults('thread', TubePath.STRAIGHT, …)` precisely so
 * a block like this one can be four lines, and `src/vfx/README.md` recommends
 * it. **It cannot be used here.** `Tube.js` imports `config/settings.js`,
 * `settings.js` spreads `ABILITY_SETTINGS` out of `config/abilities/index.js`,
 * and `index.js` imports this module — so importing the tube closes an ESM
 * evaluation cycle. Node walks it depth-first from whichever root loads first;
 * `scripts/check.mjs` imports `abilities/registry.js` on its first line, which
 * reaches `index.js` → this module → `Tube.js` → `settings.js`, and
 * `settings.js` then evaluates its body while `ABILITY_SETTINGS` is still in
 * its temporal dead zone. It throws before a single ability is constructed. So
 * the keys are written out, which also restores the rule the header of
 * `index.js` states plainly: **a settings module imports nothing.**
 *
 * The four path-specific groups at the end (WHIP / FUNNEL / VINE / ARC) are
 * present but inert. `Tube#sync` reads every field it knows about regardless of
 * the path the material was compiled for, so leaving them out means thirty
 * silent fallbacks to module defaults — values the editor cannot reach, which
 * is the one way `Tube.js` can be used to break I1. Present-and-dead is
 * honest; absent-and-defaulted is not. The pause test will list them as sliders
 * that do nothing, and it will be right.
 *
 * ### Why the thread is a whole `Tube`
 *
 * Three draw calls for a 1.6 cm filament looks extravagant until you look at
 * one without its halo. The first pass drew the cutting edge as a single
 * additive quad strip and at ten metres it simply stopped existing — a
 * one-pixel line has no bloom footprint and the tone mapper eats it. The halo
 * layer is what keeps a hairline legible at range, and it is the same argument
 * the bolt's glow pass makes.
 */
export const slipstream = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 2.0, // closer than this and the cast is refused
  speed: 88.0, // how fast the cutting front travels, metres/second
  lifetime: 0.18, // seconds the cut holds wide open before it starts to close
  fadeTime: 0.85, // seconds the disturbance takes to heal over
  cooldown: 0.7,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the plane of vacuum --- */
  // The blade is a rectangle standing in the air with its cutting edge along
  // the top. `bladeHeight` is measured *down* from that edge, because the edge
  // is the thing the player is aiming and the wake is what hangs off it.
  bladeHeight: 2.1, // metres of sheet hanging below the cutting edge — HEADLINE
  cutHeight: 1.34, // metres above the floor the edge leaves the hand
  endHeight: 1.05, // metres above the floor the edge reaches at the target
  bladeLead: 0.6, // metres in front of the caster the edge starts
  bladeSide: 0.14, // metres to the side (+ follows `Ability#side`)

  /* --- the refraction --- */
  // Screen fractions, never metres. See the block comment.
  // Arithmetic worth writing down, because it is the difference between a
  // vacuum blade and a broken renderer. The pass multiplies by
  // `post.distortion` (0.045) × `global.distortion` (1), so the body at 0.5
  // shifts the frame behind it by 0.5 × 0.045 ≈ **2.3% of screen width** —
  // about forty pixels at 1080p, which is a shear you cannot miss and cannot
  // mistake for a bug. The hairline runs at (1 + edgeGain) = 2.6× that inside a
  // 9 cm band, and the cut beat adds `refractCut` on top, peaking near 13% of
  // screen width for about a tenth of a second. The first pass shipped 0.95 /
  // 1.5 / 3.4 and the cut peaked past a third of the screen — at which point
  // the frame tears rather than bends and the whole thing reads as a
  // post-processing failure.
  refractStrength: 0.5, // how hard the body of the blade bends the scene — HEADLINE
  refractCut: 0.7, // extra strength during the cut beat, added on top
  refractCutSharp: 2.6, // how fast that spike decays over the hold, exponent
  refractGrazing: 1.25, // exponent on the edge-on path length
  refractEdgeWidth: 0.09, // metres of hairline concentration at the cutting edge
  refractEdgeGain: 1.6, // how much harder that hairline warps than the body
  refractWakeDepth: 1.8, // metres of the sheet the wake survives to
  refractRipple: 0.22, // break-up of the surface normal, 0 = a perfect mirror
  refractRippleScale: 1.15, // ripple cycles per metre
  refractRippleSpeed: 2.1, // metres/second the ripple crawls
  refractOpacity: 1.0, // coverage — who wins where two emitters overlap
  refractDepthReject: 1.0, // 0..1 how hard the floor and the body occlude it
  refractDepthFade: 0.4, // metres that occlusion feathers over
  refractPerspective: 0.0, // 0 = a screen fraction, 1 = shrinks with distance
  refractPerspectiveRef: 12.0, // metres at which perspective = 1

  /* ================================================================ */
  /* The hairline thread — one `Tube`, prefix `thread`, path STRAIGHT  */
  /* ================================================================ */

  /* --- the radius profile --- */
  threadRadius: 0.016, // half-width at the far end, metres
  threadRadiusNear: 0.007, // half-width at the muzzle, metres
  threadRadiusCurve: 0.55, // <1 opens early, >1 stays thin then opens late
  threadFlare: 0, // extra half-width where it lands, × radius (a cut does not bell)
  threadFlareWidth: 0.12, // how much of the far end flares, fraction of length
  threadThrob: 0.02, // breathing amplitude, × radius
  threadThrobScale: 3.4, // pressure waves along the column, cycles per length
  threadThrobSpeed: 2.2, // Hz they travel at

  /* --- the axis --- */
  threadWander: 0.015, // smooth low-frequency drift of the axis, metres
  threadWanderScale: 1.4, // drift features per length
  threadWanderSpeed: 0.9, // Hz the drift crawls at

  /* --- the surface --- */
  threadRipple: 0.05, // radial break-up of the barrel, × radius
  threadRippleBands: 1.0, // break-up features around the barrel
  threadRippleScale: 6.0, // break-up features along it
  threadRippleSpeed: 3.2, // Hz it crawls downrange at
  threadStreak: 0.35, // filaments streaming down the surface
  threadStreakSharp: 0.6, // 0 = soft wash, 1 = hard threads
  threadStreakScale: 14.0, // filament features per length
  threadStreakBands: 1.4, // filament features around the barrel
  threadStreakGlow: 1.4, // how hard the sheath's filaments burn to core colour
  threadFlowSpeed: 18.0, // metres-of-parameter per second the filaments run
  threadBands: 0.0, // rings along the length, cycles per length (0 = off)
  threadBandSharp: 2.0, // how tight each ring is
  threadBandDepth: 0.5, // how much they modulate alpha, 0..1
  threadBandSpeed: 0.6, // Hz they travel at

  /* --- the three layers --- */
  threadCoreWidth: 0.5, // core radius, × the profile
  threadCoreFill: 1.0, // how solid the core reads
  threadCoreSharp: 1.1, // axis-weighting exponent — the inversion
  threadEdgePower: 2.6, // rim-weighting exponent for the sheath
  threadSheathWidth: 1.15, // sheath radius, × the profile
  threadSheathRim: 0.55, // strength of the sheath's silhouette
  threadSheathFill: 0.1, // how much body the sheath keeps
  threadSheathOpacity: 0.55,
  threadHaloWidth: 6.5, // halo radius, × the profile — this is what carries it at range
  threadHaloRim: 3.2, // rim exponent — high, so it is only a silhouette
  threadHaloOpacity: 0.22,

  /* --- the ends --- */
  threadMuzzleGlow: 0.8, // brightness where the thread leaves the caster
  threadMuzzleLength: 0.06, // how far that glow reaches, fraction of length
  threadTipGlow: 3.2, // brightness of the leading edge — the brightest thing on screen
  threadTipLength: 0.03, // how soft that edge is, fraction of length

  /* --- rendering --- */
  threadOpacity: 1.0,
  threadGlow: 3.4, // emissive gain into bloom
  threadSoftFade: 0.25, // metres of depth fade against the opaque scene

  /* --- colour (I5: four pickers, none derived from another) --- */
  threadColorCore: '#ffffff', // the axis-weighted middle
  threadColorInner: '#eaf6ff', // just off the middle
  threadColorOuter: '#9fd8ff', // the sheath body
  threadColorHalo: '#123048', // the outer bloom

  /* --- inert: WHIP. Read by `Tube#sync`, unused by a STRAIGHT program. --- */
  threadWaveRate: 1.35, // loops per second travelling handle → tip
  threadWaveWidth: 0.16, // how tight the loop is, fraction of length
  threadWaveAmp: 0.3, // lateral throw of the loop, fraction of length
  threadWaveGain: 2.2, // how much the loop grows on its way to the tip, ×
  threadWaveCurve: 1.6, // when that growth happens, >1 = late
  threadWaveRoll: 0.0, // plane the loop cracks in, radians (0 = vertical)
  threadSag: 0.12, // how far the whip hangs under its own weight, metres
  threadCrackRatio: 1.0, // tip speed ÷ wave speed at which the crack fires

  /* --- inert: FUNNEL --- */
  threadThroat: 0.55, // the vortex waist, metres
  threadSkirtFlare: 1.6, // extra radius at the floor, metres
  threadSkirtHeight: 0.24, // how far up the skirt reaches, fraction of height
  threadSkirtCurve: 1.7, // how abruptly it flares, >1 = tighter to the floor
  threadMouthFlare: 2.4, // extra radius at the top, metres
  threadMouthStart: 0.55, // where the mouth begins to open, fraction of height
  threadMouthCurve: 1.4, // how abruptly it opens
  threadSpin: 0.9, // revolutions per second the surface rotates
  threadSpinTwist: 1.6, // extra revolutions from floor to mouth
  threadSway: 0.35, // how far the axis precesses, metres
  threadSwayScale: 0.5, // twist of the precession along the height
  threadSwaySpeed: 0.25, // revolutions per second it precesses
  threadSwayCurve: 1.8, // how much of the sway is at the top, >1 = only the top

  /* --- inert: VINE --- */
  threadTipTaper: 1.3, // how fast the radius falls to zero at the front
  threadMeander: 0.18, // helical wander of the stem, metres
  threadMeanderTurns: 1.4, // turns of that helix over the length
  threadRecoilAmp: 0.35, // how far the spring pulls the tip back, fraction
  threadRecoilFreq: 2.6, // Hz the spring rings at
  threadRecoilDamp: 3.4, // s⁻¹ it dies at
  threadRecoilSway: 0.6, // lateral bow while it is recoiling, metres

  /* --- inert: ARC --- */
  threadArcHeight: 2.6, // apex height above the chord, metres
  threadArcLateral: 0.0, // apex offset across the chord, metres
  threadArcBias: 0.5, // where the apex sits, 0..1 along the chord
  threadArcCurve: 1.0, // >1 pinches the apex, <1 flattens the top

  /* --- the line of disturbed dust --- */
  /**
   * The one particle system, and it is deliberately anaemic. Air that has been
   * cut open pulls dust *in* toward the seam and then lets it drift, so these
   * are emitted along the part of the line already cut, in a hairline column,
   * with almost no speed. At the shipped rate a whole cast is under a hundred
   * live particles. Turning `dustRate` up is the fastest way to make this
   * ability look like every other one.
   */
  dustRate: 55, // motes drawn into the seam, particles/second
  dustSize: 0.055, // metres
  dustSpeed: 0.5, // metres/second they drift at
  dustLifetime: 1.5, // seconds
  dustRise: 0.35, // upward drift, metres/second
  dustSpread: 0.1, // metres of scatter around the cut line
  dustTurbulence: 0.55, // curl-noise strength
  dustCut: 60, // extra motes released on the cut beat, one-shot
  colorDustA: '#e8f4ff', // birth
  colorDustB: '#a8bccc',
  colorDustC: '#6c7d8c',
  colorDustD: '#232b33', // death

  /* --- feedback --- */
  cutFlash: 0.07, // full-screen flash on the cut — barely there, on purpose
  colorCutFlash: '#dff0ff',
  cutShake: 0.22, // camera kick on the cut
  shakeDuration: 0.35, // seconds it rings for
  rumble: 0.012, // continuous shake while the blade is travelling

  /* --- dynamic light --- */
  // A vacuum does not glow. This exists only so the thread has something to
  // sit against on a dark floor; at 4.5 it is a suggestion, not a lamp.
  lightIntensity: 4.5,
  lightRadius: 7.0,
  lightColor: '#bfe4ff'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Slipstream.
 *
 * Reach for `bladeHeight` and `refractStrength` first — between them they are
 * the whole ability. `refractGrazing` is the one that is not obvious: a razor-
 * thin slab shifts what is behind it along its own surface normal, and the
 * shift grows as your view runs *along* the slab, because that is where the
 * path through it is longest. The exponent on that term is why you can see a
 * vacuum blade at all, and pushing it up makes the blade vanish when you orbit
 * to look squarely at its face — which is correct, and worth doing once.
 *
 * The tube's folders are nested under 'The hairline' rather than sitting at
 * the top level. `tubeSchema()` names them 'The column', 'The surface' and so
 * on; dropped straight in they sit next to 'The blade' and read as a second,
 * larger thing the ability draws, which is precisely the misreading this slot
 * cannot afford.
 */
export const slipstreamSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 5, 300, 1, 'cut speed'],
    ['lifetime', 0.02, 3, 0.01, 'cut hold'],
    ['fadeTime', 0.05, 4, 0.01, 'heal time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The blade': [
    ['bladeHeight', 0.1, 8, 0.01, 'blade depth (m)'],
    ['cutHeight', 0, 4, 0.01, 'edge height at hand (m)'],
    ['endHeight', 0, 4, 0.01, 'edge height at target (m)'],
    ['bladeLead', -1, 4, 0.01, 'start offset (m)'],
    ['bladeSide', -2, 2, 0.01, 'lateral offset (m)']
  ],
  Refraction: [
    ['refractStrength', 0, 4, 0.01, 'refract strength'],
    ['refractCut', 0, 6, 0.01, 'cut spike'],
    ['refractCutSharp', 0.2, 8, 0.05, 'cut spike decay'],
    ['refractGrazing', 0.1, 6, 0.01, 'grazing exponent'],
    ['refractEdgeWidth', 0.005, 1, 0.005, 'hairline width (m)'],
    ['refractEdgeGain', 0, 12, 0.05, 'hairline gain'],
    ['refractWakeDepth', 0.02, 8, 0.01, 'wake depth (m)'],
    ['refractRipple', 0, 1.5, 0.01, 'surface ripple'],
    ['refractRippleScale', 0.05, 8, 0.01, 'ripple cycles/m'],
    ['refractRippleSpeed', -8, 8, 0.01, 'ripple speed (m/s)'],
    ['refractOpacity', 0, 1, 0.01, 'coverage'],
    ['refractDepthReject', 0, 1, 0.01, 'occlusion'],
    ['refractDepthFade', 0.01, 3, 0.01, 'occlusion feather (m)'],
    ['refractPerspective', 0, 1, 0.01, 'shrink with distance'],
    ['refractPerspectiveRef', 1, 40, 0.1, 'perspective ref (m)']
  ],

  /* --- the tube, folder for folder as `tubeSchema('thread', STRAIGHT)` --- */
  'The hairline/The column': [
    ['threadRadius', 0.002, 1, 0.001, 'far radius (m)'],
    ['threadRadiusNear', 0.002, 1, 0.001, 'near radius (m)'],
    ['threadRadiusCurve', 0.05, 4, 0.01, 'radius curve'],
    ['threadFlare', 0, 4, 0.01, 'flare'],
    ['threadFlareWidth', 0.01, 1, 0.01, 'flare width'],
    ['threadThrob', 0, 0.5, 0.001, 'throb'],
    ['threadThrobScale', 0, 12, 0.1, 'throb bands'],
    ['threadThrobSpeed', 0, 8, 0.01, 'throb Hz'],
    ['threadWander', 0, 1, 0.001, 'axis drift (m)'],
    ['threadWanderScale', 0, 6, 0.01, 'drift scale'],
    ['threadWanderSpeed', 0, 4, 0.01, 'drift Hz']
  ],
  'The hairline/Core / sheath / halo': [
    ['threadCoreWidth', 0.02, 2, 0.01, 'core width'],
    ['threadCoreFill', 0, 2, 0.01, 'core fill'],
    ['threadCoreSharp', 0.05, 8, 0.01, 'core axis power'],
    ['threadEdgePower', 0.05, 8, 0.01, 'sheath rim power'],
    ['threadSheathWidth', 0.05, 3, 0.01, 'sheath width'],
    ['threadSheathRim', 0, 2, 0.01, 'sheath rim'],
    ['threadSheathFill', 0, 1, 0.01, 'sheath fill'],
    ['threadSheathOpacity', 0, 1, 0.01, 'sheath opacity'],
    ['threadHaloWidth', 0.05, 12, 0.01, 'halo width'],
    ['threadHaloRim', 0.05, 10, 0.01, 'halo rim power'],
    ['threadHaloOpacity', 0, 1, 0.01, 'halo opacity']
  ],
  'The hairline/The surface': [
    ['threadRipple', 0, 1, 0.01, 'ripple'],
    ['threadRippleBands', 0, 8, 0.01, 'ripple bands'],
    ['threadRippleScale', 0, 12, 0.01, 'ripple scale'],
    ['threadRippleSpeed', 0, 10, 0.01, 'ripple Hz'],
    ['threadStreak', 0, 2, 0.01, 'streaks'],
    ['threadStreakSharp', 0, 1, 0.01, 'streak sharpness'],
    ['threadStreakScale', 0, 30, 0.1, 'streak scale'],
    ['threadStreakBands', 0, 8, 0.01, 'streak bands'],
    ['threadStreakGlow', 0, 3, 0.01, 'streak glow'],
    ['threadFlowSpeed', 0, 40, 0.1, 'flow speed'],
    ['threadBands', 0, 24, 0.1, 'rings/length'],
    ['threadBandSharp', 0.05, 8, 0.01, 'ring sharpness'],
    ['threadBandDepth', 0, 1, 0.01, 'ring depth'],
    ['threadBandSpeed', -6, 6, 0.01, 'ring Hz']
  ],
  'The hairline/The ends': [
    ['threadMuzzleGlow', 0, 5, 0.01, 'muzzle glow'],
    ['threadMuzzleLength', 0, 0.6, 0.001, 'muzzle length'],
    ['threadTipGlow', 0, 8, 0.01, 'tip glow'],
    ['threadTipLength', 0.001, 0.4, 0.001, 'tip length']
  ],
  'The hairline/Colour & render': [
    'threadColorCore',
    'threadColorInner',
    'threadColorOuter',
    'threadColorHalo',
    ['threadOpacity', 0, 1, 0.01, 'opacity'],
    ['threadGlow', 0, 8, 0.01, 'glow'],
    ['threadSoftFade', 0, 3, 0.01, 'soft fade (m)']
  ],
  /**
   * The four groups `Tube#sync` writes and a STRAIGHT program never samples.
   * They are here so nothing lands in the trailing "More" folder, and they are
   * labelled so nobody spends five minutes wondering why 'loop throw' does
   * nothing. Compile the tube for another path and they wake up.
   */
  'The hairline/Inert on a straight tube': [
    ['threadWaveRate', 0, 6, 0.01, 'WHIP loops/second'],
    ['threadWaveWidth', 0.02, 0.6, 0.001, 'WHIP loop width'],
    ['threadWaveAmp', 0, 1, 0.001, 'WHIP loop throw'],
    ['threadWaveGain', 0.2, 6, 0.01, 'WHIP loop gain'],
    ['threadWaveCurve', 0.1, 6, 0.01, 'WHIP gain curve'],
    ['threadWaveRoll', 0, 6.2832, 0.01, 'WHIP crack plane (rad)'],
    ['threadSag', 0, 2, 0.01, 'WHIP sag (m)'],
    ['threadCrackRatio', 0.2, 4, 0.01, 'WHIP crack ratio'],
    ['threadThroat', 0.02, 4, 0.01, 'FUNNEL throat (m)'],
    ['threadSkirtFlare', 0, 8, 0.01, 'FUNNEL skirt flare (m)'],
    ['threadSkirtHeight', 0.01, 1, 0.01, 'FUNNEL skirt height'],
    ['threadSkirtCurve', 0.1, 6, 0.01, 'FUNNEL skirt curve'],
    ['threadMouthFlare', 0, 12, 0.01, 'FUNNEL mouth flare (m)'],
    ['threadMouthStart', 0, 0.99, 0.01, 'FUNNEL mouth start'],
    ['threadMouthCurve', 0.1, 6, 0.01, 'FUNNEL mouth curve'],
    ['threadSpin', -6, 6, 0.01, 'FUNNEL spin (rev/s)'],
    ['threadSpinTwist', -8, 8, 0.01, 'FUNNEL twist'],
    ['threadSway', 0, 4, 0.01, 'FUNNEL precession (m)'],
    ['threadSwayScale', 0, 3, 0.01, 'FUNNEL precession twist'],
    ['threadSwaySpeed', -3, 3, 0.01, 'FUNNEL precession (rev/s)'],
    ['threadSwayCurve', 0.1, 6, 0.01, 'FUNNEL precession curve'],
    ['threadTipTaper', 0.05, 6, 0.01, 'VINE tip taper'],
    ['threadMeander', 0, 2, 0.01, 'VINE meander (m)'],
    ['threadMeanderTurns', 0, 8, 0.01, 'VINE meander turns'],
    ['threadRecoilAmp', 0, 1, 0.01, 'VINE recoil'],
    ['threadRecoilFreq', 0, 10, 0.01, 'VINE recoil Hz'],
    ['threadRecoilDamp', 0.1, 16, 0.01, 'VINE recoil damping'],
    ['threadRecoilSway', 0, 4, 0.01, 'VINE recoil bow (m)'],
    ['threadArcHeight', -12, 12, 0.01, 'ARC apex height (m)'],
    ['threadArcLateral', -12, 12, 0.01, 'ARC apex offset (m)'],
    ['threadArcBias', 0.05, 0.95, 0.01, 'ARC apex position'],
    ['threadArcCurve', 0.1, 4, 0.01, 'ARC apex curve']
  ],

  'Disturbed dust': [
    ['dustRate', 0, 400, 1, 'dust rate'],
    ['dustSize', 0.005, 0.4, 0.005, 'dust size'],
    ['dustSpeed', 0, 6, 0.01, 'dust speed'],
    ['dustLifetime', 0.1, 6, 0.05, 'dust lifetime'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustSpread', 0.005, 1.5, 0.005, 'scatter (m)'],
    ['dustTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['dustCut', 0, 400, 1, 'dust on the cut'],
    ['colorDust*', 'Dust colour']
  ],
  Feedback: [
    ['cutFlash', 0, 1, 0.005, 'screen flash'],
    ['colorCutFlash', 'flash colour'],
    ['cutShake', 0, 2, 0.01, 'cut shake'],
    ['shakeDuration', 0.05, 3, 0.01, 'shake duration'],
    ['rumble', 0, 0.3, 0.001, 'travel rumble']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
