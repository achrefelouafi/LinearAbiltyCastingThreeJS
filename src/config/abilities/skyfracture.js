/* ================================================================== */
/* SKYFRACTURE — reverse-ordered cause and effect                      */
/* ================================================================== */
/**
 * The sky splits along the aimed line — and the floor knows about it first.
 *
 * ### The two gaps are the ability
 *
 * `skyGap` and `pressureGap` are the only two numbers in this block that
 * matter more than the colours, and they are at the top for that reason.
 *
 * ```
 *   the floor    ─────█████████████████████████████████████████████
 *   the sky      ──────────────── skyGap ────█████████████████████
 *   the pressure ───────────────────────────── pressureGap ───████
 * ```
 *
 * Beat one: a white fracture pattern inks itself across the floor with
 * *nothing above it* and no sound, no shake, no dust. Beat two, `skyGap`
 * seconds later: the sky opens along the same shape. Beat three,
 * `pressureGap` after that: the front arrives and the floor finally reacts.
 * Set both gaps to zero and this is a competent lightning ability. Set them to
 * 0.4 and 0.3 and it is the only slot in the sandbox where the effect precedes
 * its cause, which is worth more than any amount of shader.
 *
 * ### The same pattern, and how it stays the same
 *
 * The two fractures are *literally the same fracture*, one translated
 * downward and flattened. Both are `FilamentPaths` in `CRACK` mode, both are
 * given the identical seed, the identical trunk direction and the identical
 * eight branch parameters, and the branch geometry in that mode is a pure
 * function of those. Everything under **The fracture** below is therefore
 * shared by both copies deliberately — that sharing *is* the design, in the
 * sense `docs/EXPANSION.md` I5 allows. Two `crackAngle` sliders would let the
 * floor show a shape the sky never makes, which is the one failure this
 * ability cannot survive.
 *
 * What the copies are allowed to disagree about is everything that is not
 * shape: width, glow, flicker and all four colours. A reflection is dimmer and
 * colder than the thing it reflects, and it should be a separate set of
 * pickers.
 *
 * ### Why the fracture is horizontal, and has one height slider
 *
 * There is a single `skyHeight` and no far-end height. Tilting the sky crack
 * would tilt its trunk direction, `CRACK` builds each branch's frame off that
 * direction, and the floor copy — which is horizontal by construction —
 * would immediately start drawing a *different* fracture. One slider is not a
 * simplification; it is the constraint that keeps the trick true.
 *
 * `skyHeight` also wants to be lower than instinct says. The sandbox's camera
 * sits about seven metres up and eleven back with a 46° field of view, so a
 * fracture at twenty metres is a fracture nobody sees. 7.5 m puts it across
 * the top of the frame.
 *
 * ### No `filamentLook()` / `shellDefaults()` import
 *
 * Both would be the tidy way to write the bottom two-thirds of this file, and
 * both are unusable here: `Shell.js` imports `config/settings.js`,
 * `settings.js` spreads `ABILITY_SETTINGS` out of `config/abilities/index.js`,
 * and `index.js` imports this module. `scripts/check.mjs` loads
 * `abilities/registry.js` first, which walks that cycle and evaluates
 * `settings.js` while `ABILITY_SETTINGS` is still in its temporal dead zone —
 * it throws before an ability is constructed. So the `wave*` block is spelled
 * out, and this module keeps the promise the header of `index.js` makes: **a
 * settings module imports nothing.**
 */
export const skyfracture = {
  /* --- the cast --- */
  range: 26.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 46.0, // how fast the floor pattern inks itself, metres/second
  lifetime: 0.5, // seconds everything holds after the pressure front finishes
  fadeTime: 1.5, // seconds it all heals over
  cooldown: 1.5,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* ================================================================ */
  /* THE TWO GAPS — the whole ability. Read the block comment.         */
  /* ================================================================ */
  skyGap: 0.42, // seconds the SKY waits after the floor pattern has landed
  skyDraw: 0.14, // seconds the sky fracture takes to tear itself open
  pressureGap: 0.28, // seconds the PRESSURE waits after the sky has opened
  pressureRise: 0.6, // seconds the pressure front takes to reach full radius

  /* ================================================================ */
  /* The fracture — SHARED by the floor copy and the sky copy          */
  /* ================================================================ */
  // Every key in this group feeds both `FilamentPaths` instances with the same
  // number. Change one and both patterns change together, which is the point.
  crackCount: 14, // filaments; filament 0 is always the trunk
  crackAngle: 0.62, // radians a branch leaves its parent by
  crackLengthFrac: 0.5, // branch length as a fraction of its parent's
  crackDepthFalloff: 0.62, // extra shortening per generation
  crackSpread: 0.85, // ± fraction of variation on the branch angle
  crackStart: 0.18, // 0..1 earliest point on a parent a fork may happen
  crackForkBias: 0.5, // 0..1 slides the branch/twig split
  crackLead: 1.2, // metres in front of the caster the trunk starts
  crackRestrike: 0.02, // whole re-shapes per second. Near zero: a crack is not
  // lightning, it does not re-roll — and both copies must re-roll on the same
  // clock or they stop being the same crack for a frame at a time.
  crackJitter: 0.34, // metres of kink on a branch
  crackJitterScale: 0.55, // kinks per metre
  crackOctaves: 4, // 1..5 octaves of value noise
  crackJitterFalloff: 0.52, // amplitude kept per octave
  crackCrawl: 0.35, // how fast the kinks slide along the path
  crackPinch: 0.12, // 0..1 of the path the kink eases in over at each end
  groundHeight: 0.03, // metres above the floor the flattened copy is clamped to
  groundClearance: 0.6, // metres of safety margin on the projection sink — see
  // `SkyfractureAbility#_sync`. The floor copy is placed far *below* the floor
  // and clamped up onto it, which is how it becomes an exact plan projection of
  // the sky copy rather than an approximation of one.

  /* --- the sky copy --- */
  skyHeight: 7.5, // metres above the floor the fracture opens at
  skySag: 1.1, // metres each segment bows; y only, so it cannot alter the plan
  skyTipGlow: 3.2, // heat on the tearing edge while it opens
  skyTipLength: 0.05, // length of that edge, fraction of the path
  skyWidth: 0.05, // half-width of one filament, metres
  skyGlowWidth: 7.0, // halo half-width, × the core width
  skyGlowOpacity: 0.5, // halo alpha relative to the core
  skyFlicker: 0.22, // 0..1 depth of the whole-fracture brightness stutter
  skyFlickerSpeed: 26, // steps per second that stutter is quantised to
  skyStrandFlash: 0.35, // 0..1 depth of the per-filament blink
  skyCoreSharp: 4.6, // exponent on the core's edge falloff
  skyGlowFalloff: 2.2, // the same for the halo
  skySoftFade: 0.9, // metres of depth fade against the opaque scene
  skyOpacity: 1.0,
  skyGlow: 3.0, // emissive gain into bloom
  colorSkyCore: '#ffffff', // the white-hot centre line
  colorSkyInner: '#e6ecff',
  colorSkyOuter: '#c0d0ff',
  colorSkyHalo: '#1a2a4a', // the wide, dim atmosphere

  /* --- the floor copy: the shadow and the reflection --- */
  floorTipGlow: 1.6, // heat on the inking front
  floorTipLength: 0.07, // length of that front, fraction of the path
  floorWidth: 0.035, // half-width of one filament, metres
  floorGlowWidth: 5.0, // halo half-width, × the core width
  floorGlowOpacity: 0.32,
  floorFlicker: 0.1, // a reflection is steadier than the thing it reflects
  floorFlickerSpeed: 18,
  floorStrandFlash: 0.18,
  floorCoreSharp: 5.2, // thinner than the sky's: it is lying on stone
  floorGlowFalloff: 2.6,
  floorSoftFade: 0.35, // metres of depth fade — small, it is on the floor
  floorOpacity: 0.9,
  floorGlow: 1.5, // emissive gain before the sky opens
  floorSkyBoost: 0.9, // extra glow once there is genuinely something to reflect
  colorFloorCore: '#ffffff',
  colorFloorInner: '#d8e4ff',
  colorFloorOuter: '#8fa8e0',
  colorFloorHalo: '#101c33',

  /* --- the wet stone under it (GroundField, WET) --- */
  // Not the pattern — the *pool of light* the pattern is lying in. WET is
  // alpha-blended rather than additive, so the floor genuinely darkens and goes
  // glossy under the fracture instead of brightening, which is what makes the
  // white filaments read as a reflection in something rather than as paint on
  // top of something.
  wetSpan: 1.15, // patch radius as a fraction of half the cast length
  wetMargin: 1.6, // metres added to that radius
  wetEdge: 0.55, // metres of feather on the growth front
  wetRagged: 0.3, // how far that front wanders, fraction of the radius
  wetRaggedScale: 0.55, // lobes per metre
  wetWarp: 0.7, // metres of domain warp on those lobes
  wetRelief: 0.5, // how hard the height field tilts the fake normal
  wetNormalStep: 0.06, // metres between the height taps
  wetAmbient: 0.22, // floor on the diffuse term
  wetWrap: 0.4, // 0..1 wraps the terminator round the back
  wetSpecular: 0.9, // high: this is standing water
  wetGloss: 46, // Blinn exponent
  wetParallax: 0.25, // metres of view-driven offset on interior detail
  wetCell: 0.5, // metres — puddle scale
  wetLift: 0.006, // metres — surface ripple height
  wetDepth: 0.03, // metres — how deep the puddles read
  wetDetail: 0.55, // 0..1 ripple strength
  wetSpeed: 0.6, // ripple rate
  wetFlow: 0.12, // metres/second the surface drifts
  wetWind: 0.6, // radians — drift bearing in the quad's frame
  wetEmissive: 0.7, // multiplier on every glowing term
  wetOpacity: 0.7,
  wetDepthFade: 0.5, // metres of soft fade against standing geometry
  colorWetBase: '#141b26', // the soaked stone
  colorWetEdge: '#9fb4d8', // the sheen
  colorWetGlow: '#c0d0ff', // anything emissive in it
  colorWetDeep: '#070a10', // the deepest part of a puddle

  /* ================================================================ */
  /* The pressure front — one `Shell`, prefix `wave`, mode PRESSURE    */
  /* ================================================================ */

  /* --- the expansion --- */
  waveRadius: 1.2, // radius at t = 0, metres
  waveRadiusEnd: 16, // radius at t = 1, metres
  waveExpand: 4.2, // easing exponent: 1 − (1−t)^expand, >1 = fast then easing out
  waveHeight: 0.55, // axial extent, × radius (squashed, so it washes outward)
  waveSpan: 6, // CONE length / RING_TRAIN run, metres — inert in PRESSURE
  waveLift: 3.2, // metres up the axis the front is centred — it comes from above

  /* --- the surface --- */
  waveDisplace: 0.06, // billow along the normal, × radius
  waveNoiseScale: 1.2, // billow features per unit radius
  waveNoiseSpeed: 0.5, // Hz the billow crawls at
  waveTurbulence: 0.8, // master on the billow

  /* --- shading --- */
  waveFill: 0.02, // how much body the shell keeps, 0 = rim only
  waveRim: 1.6, // strength of the fresnel rim
  waveRimPower: 3.4, // how tight that rim is
  waveSeal: 1.4, // DOME only — inert here
  waveSealWidth: 0.12, // DOME only — inert here
  waveEdge: 1.2, // CONE only — inert here
  waveEdgeWidth: 0.16, // CONE only — inert here
  waveConeCurve: 1.0, // CONE only — inert here
  waveDissolve: 1.2, // how hard the age dissolve bites, 0 = fade evenly

  /* --- RING_TRAIN: inert in PRESSURE, but `Shell#sync` reads them all --- */
  waveRings: 10, // live instance count
  waveSpacing: 1.6, // metres between launched rings
  waveRingSpeed: 7.0, // metres/second they travel at
  waveRingThickness: 0.16, // radial thickness of one ring, metres
  waveRingSharp: 1.6, // how hard its profile falls off
  waveReflect: 1.0, // 0 = rings die at the far end, 1 = perfect reflection
  waveStanding: 1.0, // how much of the standing envelope modulates them
  waveSwell: 0.45, // extra radius at an antinode, × radius

  /* --- SUNDISC: also inert here --- */
  waveCoronaReach: 1.8, // how far past the rim the disc is drawn, × radius
  waveCorona: 1.3, // brightness of the filaments licking off the rim
  waveCoronaLength: 0.55, // how far they reach, × radius
  waveCoronaScale: 5.0, // filament features per radius
  waveCoronaWarp: 0.45, // domain warp — the thing that stops them being spokes
  waveCoronaSpeed: 0.7, // Hz they crawl at
  waveCoronaSharp: 0.72, // threshold: low fills the corona in and it reads as fog
  waveGranule: 0.45, // convection cells across the disc face
  waveGranuleScale: 6.0, // cells per radius
  waveRimWidth: 0.18, // hot band inside the rim, × radius

  /* --- rendering --- */
  waveOpacity: 0.85,
  waveGlow: 1.2, // emissive gain into bloom
  waveSoftFade: 0.8, // metres of depth fade against the opaque scene

  /* --- colour (I5: four pickers, none derived from another) --- */
  waveColorBody: '#1a2a4a', // the body of the shell
  waveColorRim: '#c0d0ff', // the fresnel rim
  waveColorEdge: '#ffffff', // the hottest mark it has
  waveColorCorona: '#8fa8e0', // SUNDISC only — inert here

  /* --- dust, kicked off the floor by beat three and by nothing else --- */
  dustRate: 220, // particles/second while the front is crossing
  dustSize: 0.9, // metres
  dustSpeed: 3.2, // metres/second
  dustLifetime: 2.0, // seconds
  dustRise: 0.6, // upward drift, metres/second
  dustOpacity: 0.16,
  colorDustA: '#6b7688', // birth
  colorDustB: '#4a5567',
  colorDustC: '#333d4c',
  colorDustD: '#161c25', // death

  /* --- glints falling out of the sky crack --- */
  glintRate: 90, // particles/second once the fracture is open
  glintSize: 0.07, // metres
  glintSpeed: 2.2, // metres/second
  glintLifetime: 1.6, // seconds
  glintFall: -2.2, // gravity, metres/second² (negative: they come down)
  glintTurbulence: 0.6,
  glintBurst: 120, // one-shot on the frame the sky opens
  colorGlintA: '#ffffff', // birth
  colorGlintB: '#e6ecff',
  colorGlintC: '#8fa8e0',
  colorGlintD: '#1a2a4a', // death

  /* --- feedback --- */
  skyFlash: 0.34, // full-screen flash on the frame the sky opens
  colorSkyFlash: '#dfe8ff',
  pressureShake: 0.9, // camera kick when the front arrives
  shakeDuration: 0.7, // seconds it rings for
  rumble: 0.0, // continuous shake while beat one is inking. DELIBERATELY ZERO:
  // beat one has to be silent or the reversal does not land. It is a slider so
  // that you can hear for yourself how much worse a rumbling beat one is.

  /* --- dynamic light --- */
  lightIntensity: 14,
  lightRadius: 16,
  lightColor: '#c0d0ff'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Sky Fracture.
 *
 * 'The order of events' is first because it is the ability. Drag `skyGap` to
 * zero and watch a good effect become an ordinary one; drag it to 1.2 and
 * watch it become a joke. Somewhere around 0.35–0.5 the floor has had just
 * long enough to be unsettling.
 *
 * 'The fracture' holds every number that both copies share. If the floor and
 * the sky ever stop matching, the cause is in that folder or in `crackRestrike`
 * specifically — both copies re-roll their branch hashes on the same clock, and
 * they have to.
 */
export const skyfractureSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'floor ink speed'],
    ['lifetime', 0.05, 4, 0.01, 'hold after the front'],
    ['fadeTime', 0.1, 6, 0.01, 'heal time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The order of events': [
    ['skyGap', 0, 2, 0.005, 'floor → sky gap (s)'],
    ['skyDraw', 0.01, 1.5, 0.005, 'sky tear time (s)'],
    ['pressureGap', 0, 2, 0.005, 'sky → pressure gap (s)'],
    ['pressureRise', 0.05, 3, 0.01, 'pressure rise (s)']
  ],
  'The fracture (shared by both copies)': [
    ['crackCount', 1, 24, 1, 'filaments'],
    ['crackAngle', 0, 1.6, 0.005, 'branch angle (rad)'],
    ['crackLengthFrac', 0.05, 1, 0.005, 'branch length'],
    ['crackDepthFalloff', 0.05, 1.5, 0.005, 'per-generation falloff'],
    ['crackSpread', 0, 2, 0.01, 'angle variation'],
    ['crackStart', 0, 0.95, 0.005, 'earliest fork'],
    ['crackForkBias', 0, 1, 0.01, 'branch / twig split'],
    ['crackLead', -2, 6, 0.01, 'trunk start (m)'],
    ['crackRestrike', 0.001, 12, 0.001, 're-shapes / sec'],
    ['crackJitter', 0, 2, 0.005, 'kink amplitude (m)'],
    ['crackJitterScale', 0.02, 4, 0.01, 'kinks / metre'],
    ['crackOctaves', 1, 5, 1, 'octaves'],
    ['crackJitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['crackCrawl', -8, 8, 0.01, 'kink crawl'],
    ['crackPinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['groundHeight', 0.001, 0.4, 0.001, 'floor copy height (m)'],
    ['groundClearance', 0, 8, 0.05, 'projection margin (m)']
  ],
  'The sky copy': [
    ['skyHeight', 1, 30, 0.05, 'fracture height (m)'],
    ['skySag', -6, 6, 0.01, 'segment bow (m)'],
    ['skyTipGlow', 0, 8, 0.05, 'tearing-edge glow'],
    ['skyTipLength', 0.005, 0.4, 0.005, 'tearing-edge length'],
    ['skyWidth', 0.002, 0.4, 0.001, 'filament width (m)'],
    ['skyGlowWidth', 1, 20, 0.1, 'halo width'],
    ['skyGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['skyFlicker', 0, 1, 0.01, 'brightness stutter'],
    ['skyFlickerSpeed', 1, 90, 1, 'stutter rate'],
    ['skyStrandFlash', 0, 1, 0.01, 'filament blink'],
    ['skyCoreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['skyGlowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['skySoftFade', 0.02, 4, 0.01, 'soft fade (m)'],
    ['skyOpacity', 0, 2, 0.01, 'opacity'],
    ['skyGlow', 0, 8, 0.01, 'glow'],
    ['colorSkyCore', 'sky core'],
    ['colorSkyInner', 'sky inner'],
    ['colorSkyOuter', 'sky outer'],
    ['colorSkyHalo', 'sky halo']
  ],
  'The floor copy': [
    ['floorTipGlow', 0, 8, 0.05, 'inking-front glow'],
    ['floorTipLength', 0.005, 0.4, 0.005, 'inking-front length'],
    ['floorWidth', 0.002, 0.4, 0.001, 'filament width (m)'],
    ['floorGlowWidth', 1, 20, 0.1, 'halo width'],
    ['floorGlowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['floorFlicker', 0, 1, 0.01, 'brightness stutter'],
    ['floorFlickerSpeed', 1, 90, 1, 'stutter rate'],
    ['floorStrandFlash', 0, 1, 0.01, 'filament blink'],
    ['floorCoreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['floorGlowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['floorSoftFade', 0.02, 4, 0.01, 'soft fade (m)'],
    ['floorOpacity', 0, 2, 0.01, 'opacity'],
    ['floorGlow', 0, 8, 0.01, 'glow before the sky opens'],
    ['floorSkyBoost', 0, 6, 0.01, 'extra glow once it opens'],
    ['colorFloorCore', 'floor core'],
    ['colorFloorInner', 'floor inner'],
    ['colorFloorOuter', 'floor outer'],
    ['colorFloorHalo', 'floor halo']
  ],
  'Wet stone': [
    ['wetSpan', 0, 3, 0.01, 'radius × half-length'],
    ['wetMargin', 0, 12, 0.05, 'radius margin (m)'],
    ['wetEdge', 0.01, 4, 0.01, 'front feather (m)'],
    ['wetRagged', 0, 1.5, 0.01, 'front wander'],
    ['wetRaggedScale', 0.05, 4, 0.01, 'lobes / metre'],
    ['wetWarp', 0, 4, 0.01, 'domain warp (m)'],
    ['wetRelief', 0, 3, 0.01, 'relief'],
    ['wetNormalStep', 0.005, 0.5, 0.005, 'normal step (m)'],
    ['wetAmbient', 0, 1, 0.01, 'ambient'],
    ['wetWrap', 0, 1, 0.01, 'terminator wrap'],
    ['wetSpecular', 0, 3, 0.01, 'specular'],
    ['wetGloss', 1, 128, 1, 'gloss'],
    ['wetParallax', 0, 2, 0.01, 'parallax (m)'],
    ['wetCell', 0.05, 4, 0.01, 'puddle scale (m)'],
    ['wetLift', 0, 0.1, 0.0005, 'ripple height (m)'],
    ['wetDepth', 0, 0.5, 0.001, 'puddle depth (m)'],
    ['wetDetail', 0, 1, 0.01, 'ripple strength'],
    ['wetSpeed', 0, 6, 0.01, 'ripple rate'],
    ['wetFlow', 0, 3, 0.01, 'drift (m/s)'],
    ['wetWind', 0, 6.2832, 0.01, 'drift bearing (rad)'],
    ['wetEmissive', 0, 4, 0.01, 'emissive'],
    ['wetOpacity', 0, 1, 0.01, 'opacity'],
    ['wetDepthFade', 0, 3, 0.01, 'soft fade (m)'],
    ['colorWetBase', 'soaked stone'],
    ['colorWetEdge', 'sheen'],
    ['colorWetGlow', 'glow'],
    ['colorWetDeep', 'puddle interior']
  ],
  'The pressure front/The shell': [
    ['waveRadius', 0.01, 20, 0.01, 'start radius (m)'],
    ['waveRadiusEnd', 0.01, 60, 0.01, 'end radius (m)'],
    ['waveExpand', 0.2, 12, 0.01, 'expansion curve'],
    ['waveHeight', 0.02, 4, 0.01, 'height × radius'],
    // Deliberately wider than `shellSchema`'s −2..2: this front is centred
    // several metres up, because it is arriving from a fracture overhead.
    ['waveLift', -2, 16, 0.01, 'centre height (m)'],
    ['waveDisplace', 0, 1.5, 0.01, 'billow'],
    ['waveNoiseScale', 0.1, 10, 0.01, 'billow scale'],
    ['waveNoiseSpeed', 0, 4, 0.01, 'billow Hz'],
    ['waveTurbulence', 0, 3, 0.01, 'turbulence']
  ],
  'The pressure front/Shading': [
    ['waveFill', 0, 1, 0.01, 'body fill'],
    ['waveRim', 0, 3, 0.01, 'rim'],
    ['waveRimPower', 0.1, 8, 0.01, 'rim power'],
    ['waveDissolve', 0, 2, 0.01, 'dissolve'],
    ['waveOpacity', 0, 1, 0.01, 'opacity'],
    ['waveGlow', 0, 8, 0.01, 'glow'],
    ['waveSoftFade', 0, 3, 0.01, 'soft fade (m)'],
    ['waveColorBody', 'shell body'],
    ['waveColorRim', 'shell rim'],
    ['waveColorEdge', 'shell edge']
  ],
  /**
   * `Shell#sync` writes every field it knows about regardless of the mode the
   * material was compiled for, so leaving these out would mean twenty-three
   * silent fallbacks to module defaults — values the editor cannot reach, which
   * is the one way `Shell.js` can be used to break I1. Present and labelled
   * beats absent and defaulted. The pause test will call them dead; it is
   * right, and they wake up if the shell is ever recompiled to another mode.
   */
  'The pressure front/Inert in PRESSURE mode': [
    ['waveSpan', 0.1, 40, 0.1, 'CONE length (m)'],
    ['waveSeal', 0, 4, 0.01, 'DOME floor seal'],
    ['waveSealWidth', 0.01, 1, 0.01, 'DOME seal width'],
    ['waveEdge', 0, 4, 0.01, 'CONE lip'],
    ['waveEdgeWidth', 0.01, 1, 0.01, 'CONE lip width'],
    ['waveConeCurve', 0.1, 4, 0.01, 'CONE curve'],
    ['waveRings', 1, 24, 1, 'TRAIN rings'],
    ['waveSpacing', 0.1, 8, 0.01, 'TRAIN spacing (m)'],
    ['waveRingSpeed', 0, 40, 0.1, 'TRAIN speed (m/s)'],
    ['waveRingThickness', 0.01, 2, 0.01, 'TRAIN thickness (m)'],
    ['waveRingSharp', 0.05, 8, 0.01, 'TRAIN sharpness'],
    ['waveReflect', 0, 1, 0.01, 'TRAIN reflection'],
    ['waveStanding', 0, 1, 0.01, 'TRAIN standing'],
    ['waveSwell', 0, 2, 0.01, 'TRAIN swell'],
    ['waveCoronaReach', 1, 4, 0.01, 'DISC corona reach'],
    ['waveCorona', 0, 4, 0.01, 'DISC corona'],
    ['waveCoronaLength', 0, 2, 0.01, 'DISC corona length'],
    ['waveCoronaScale', 0.1, 20, 0.1, 'DISC corona scale'],
    ['waveCoronaWarp', 0, 2, 0.01, 'DISC corona warp'],
    ['waveCoronaSpeed', 0, 4, 0.01, 'DISC corona Hz'],
    ['waveCoronaSharp', 0, 1, 0.01, 'DISC corona threshold'],
    ['waveGranule', 0, 2, 0.01, 'DISC granulation'],
    ['waveGranuleScale', 0.1, 20, 0.1, 'DISC granule scale'],
    ['waveRimWidth', 0, 1, 0.01, 'DISC rim width'],
    ['waveColorCorona', 'DISC corona colour']
  ],
  'Dust & glints': [
    ['dustRate', 0, 900, 1, 'dust rate'],
    ['dustSize', 0.05, 4, 0.01, 'dust size'],
    ['dustSpeed', 0, 14, 0.05, 'dust speed'],
    ['dustLifetime', 0.2, 8, 0.05, 'dust lifetime'],
    ['dustRise', -2, 4, 0.01, 'dust rise'],
    ['dustOpacity', 0, 1, 0.005, 'dust opacity'],
    ['colorDust*', 'Dust colour'],
    ['glintRate', 0, 600, 1, 'glint rate'],
    ['glintSize', 0.005, 0.5, 0.005, 'glint size'],
    ['glintSpeed', 0, 12, 0.05, 'glint speed'],
    ['glintLifetime', 0.1, 6, 0.05, 'glint lifetime'],
    ['glintFall', -30, 5, 0.1, 'glint gravity'],
    ['glintTurbulence', 0, 3, 0.01, 'glint turbulence'],
    ['glintBurst', 0, 600, 1, 'glints on the tear'],
    ['colorGlint*', 'Glint colour']
  ],
  Feedback: [
    ['skyFlash', 0, 2, 0.01, 'flash on the tear'],
    ['colorSkyFlash', 'flash colour'],
    ['pressureShake', 0, 3, 0.01, 'pressure shake'],
    ['shakeDuration', 0.05, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.3, 0.001, 'beat-one rumble (keep at 0)']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 90, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
