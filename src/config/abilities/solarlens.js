/* ================================================================== */
/* SOLAR LENS — lumen, zone                                            */
/* ================================================================== */
/**
 * A burning glass, hung in the air over the aimed circle.
 *
 * An element climbs out to the zone, tips over, and pulls focus: the cone of
 * light under it narrows from a soft wash to a point, and that point then
 * *walks* a rosette across the floor, charring what it crosses. The anamorphic
 * flare hanging off the burning point is depth-tested against the scene, so the
 * character walking between the camera and the burn dims it.
 *
 * Four numbers carry the whole read and are the ones to reach for first:
 *
 *  - `focusTight` — the half-angle of the cone once focus is pulled, radians.
 *    At 0.055 the spot is a coin and the floor smokes; at 0.3 it is a lamp and
 *    nothing burns. This is the difference between a magnifying glass and a
 *    torch, and it is one slider.
 *  - `walkPetals` — how many lobes the focus's rosette has. Whole numbers close
 *    the figure; 2.5 leaves it open and the burn never repeats itself.
 *  - `walkSpeed` — turns per second of the carrier angle. Slow is a brand, fast
 *    is a spirograph.
 *  - `flareOccRadius` — the screen-space disc the occlusion kernel averages
 *    over, as a fraction of frame height. Too small and the flare *switches*
 *    rather than dims as a silhouette crosses it; that is the failure the
 *    kernel exists to prevent, and this is its size.
 *
 * ### The four consumers of `zoneRadius`
 *
 * The walk's rosette, the char field the pits are recorded in, the caustic
 * net's own extent and the ember scatter all measure themselves against
 * `zoneRadius`, because they are four views of one footprint. Drag it while the
 * lens is standing and the whole burn — including pits already on the floor,
 * which are stored as *fractions* of it — rescales together. That sharing is
 * the design (I5); nothing else here is derived from anything else.
 *
 * ### Why the element's forty-four keys are spelled out
 *
 * The element is `vfx/Shell.js` in `SUNDISC` mode under the `disc` prefix, and
 * `Shell` reads its numbers by prefixed key straight off this block. The
 * fragment is available in one line as `shellDefaults('disc', ShellMode.SUNDISC)`
 * and is written out anyway, for the reason `vinelash` gives: a settings module
 * must import nothing, because `vfx/Shell.js` imports `config/settings.js` and
 * importing it back from here closes a cycle whose failure depends on which
 * module a consumer happens to load first. (One is already latent in the tree —
 * importing `vfx/GroundField.js` first in a bare Node process throws inside
 * `vfx/Tube.js`. Do not add another.) It also means every key gets the trailing
 * comment the house style asks for.
 */
export const solarlens = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 30.0, // how fast the element travels out to the zone, metres/second
  zoneRadius: 5.2, // the footprint — what the circle indicator measures out
  lifetime: 2.8, // seconds the lens burns for once it has arrived
  fadeTime: 1.0, // seconds the element and the light die over
  cooldown: 1.5,
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the element hangs --- */
  // The element is not a projectile: it climbs as the front runs out, so by the
  // time the circle is reached it is already overhead. `lensClimb` is the
  // exponent on that rise — above 1 it stays low and snaps up at the end.
  lensAltitude: 4.4, // metres above the floor the element settles at
  lensLead: -0.9, // metres from the zone centre toward the caster
  lensClimb: 1.7, // curve of the rise during travel; >1 climbs late
  lensBob: 0.16, // metres of vertical drift once it is standing
  lensBobSpeed: 0.32, // Hz of that drift
  lensSway: 0.22, // metres of lateral drift
  lensSwaySpeed: 0.21, // Hz of that

  /* --- pulling focus --- */
  focusTime: 0.6, // seconds the cone takes to narrow after arrival
  focusCurve: 2.0, // exponent on that ramp; >1 dwells wide then snaps in
  focusWide: 0.58, // cone half-angle before focus, radians
  focusTight: 0.055, // ... and after. This is the burn.
  focusLift: 0.07, // metres the flare's anchor sits above the floor

  /* --- the walk --- */
  // Everything here is unitless. The focus's position is a pure function of
  // `age`, the seed and these six numbers, evaluated fresh every frame, so
  // dragging any of them with the clock stopped *moves the burning point*
  // rather than changing where it will go next.
  walkSpeed: 0.21, // turns per second of the carrier angle
  walkPetals: 2.5, // lobes in the rosette; whole numbers close the figure
  walkInner: 0.14, // tightest radius, as a fraction of `zoneRadius`
  walkOuter: 0.9, // widest radius, ditto
  walkPhase: 0.0, // radians the rosette is rotated by
  walkWobble: 0.045, // fraction of `zoneRadius` of secondary jitter
  walkWobbleRate: 3.1, // Hz of that jitter

  /* --- the char it leaves (vfx/GroundField, POCK) --- */
  charMarksPerTurn: 34, // pits laid per turn of the walk — a rate, not a spacing
  charMarkRadius: 0.34, // metres, one pit at full strength
  charMarkLife: 8.0, // seconds a pit weathers away over
  charDepth: 0.1, // metres the bowl sinks
  charLift: 0.035, // metres the rim stands proud
  charSharp: 0.62, // 0..1 how crisp the rim is
  charDetail: 0.7, // 0..1 grain inside the bowl
  charEdge: 0.3, // metres of feather on the field's own front
  charRagged: 0.22, // how far that front wanders, as a fraction of the radius
  charRaggedScale: 0.75, // lobes per metre
  charWarp: 0.4, // metres of domain warp on those lobes
  charRelief: 0.75, // how hard the height field tilts the fake normal
  charNormalStep: 0.05, // metres between the height taps
  charAmbient: 0.28, // floor on the diffuse term
  charWrap: 0.45, // 0..1 wraps the terminator round the back
  charSpecular: 0.22, // charcoal is not glossy
  charGloss: 18, // Blinn exponent
  charParallax: 0.28, // metres of view-driven offset on interior detail
  charEmissive: 1.0, // multiplier on the ember term
  charOpacity: 1.0,
  charDepthFade: 0.4, // metres of soft fade against standing geometry
  colorCharBase: '#2b231b', // the burnt floor itself
  colorCharEdge: '#7a6448', // the raised lip of a pit
  colorCharGlow: '#ff7b26', // the ember still alive in a fresh pit
  colorCharDeep: '#0a0705', // the bottom of the bowl

  /* --- the focused light (vfx/Caustics, CONE) --- */
  // The net is a *fold* of a height field, not a pattern: `netDepth` times
  // (`netIor` − 1) is the whole term, so at `netDepth: 0` there is nothing to
  // fold and you are looking at `netRidgeMix` alone. Glass rather than water
  // here — 1.62 and a fat dispersion, because a lens is what this is.
  netRadius: 2.8, // metres — how far the fold pattern is drawn
  netDepth: 0.85, // metres of "glass" the light came through
  netIor: 1.62, // crown glass, not water
  netDispersion: 0.22, // how far apart the three channels' folds sit
  netSampleStep: 0.07, // metres between the Hessian taps
  netAbsorb: 0.08, // attenuation through the medium
  netFoldFloor: 0.18, // clamp on |det J| — how bright a fold may get
  netThreshold: 1.05, // where the filament starts
  netGain: 0.85,
  netSharpness: 1.7, // how hairline the filament is
  netRolloff: 0.18,
  netAmp: 0.13, // height of the lattice the fold is taken of
  netCellScale: 0.95, // cells per metre
  netCellRatio: 1.63, // the second lattice against the first
  netCellJitter: 0.85, // 0..1 how irregular the cells are
  netDriftAngle: 0.7, // radians the lattices drift along
  netDriftSpeed: 0.09, // metres/second
  netBoil: 1.15, // how fast the lattice churns in place
  netRidgeMix: 0.1, // the received worley-difference recipe, kept low
  netRidgeScale: 2.4,
  netRidgePower: 6,
  netPenumbra: 0.3, // softness of the cone's own edge, fraction of its radius
  netEmissive: 1.7, // multiplier on every glowing term
  netOpacity: 1.0,
  netWash: 0.24, // the general light in the pool, under the filaments
  netFringeAt: 1.4, // where a fold is hot enough to go white
  netDepthFade: 0.4, // metres of soft fade where the net meets a standing foot
  colorNet: '#fff0c6', // the filaments
  colorFringe: '#ffffff', // the very top of a fold
  colorWash: '#c8791f', // the general light in the burn

  /* --- the flare (vfx/LensFlare) --- */
  // Anchored to the burning point, not to the element — the burn is the bright
  // thing, and it is the thing the character can stand in front of. Occlusion
  // is the whole reason this module is here: `flareOcclusion` at 0 is a sticker
  // on the monitor, and worth setting once to see what the trick is worth.
  flareIntensity: 1.6,
  flareOpacity: 1.0,
  flareHeadroom: 6.0, // linear value the hue-preserving shoulder asymptotes to
  flareOcclusion: 1.0, // 0..1 master on the depth test
  flareOccRadius: 0.032, // the source's apparent half-size, fraction of frame height
  flareOccTaps: 7, // 1..9 taps in the disc kernel
  flareOccFade: 0.7, // metres over which the depth compare feathers
  flareOccSpin: 0.0, // radians the kernel is rotated off the pixel grid
  flareEdgeStart: 0.85, // |ndc| where the flare starts fading out
  flareEdgeEnd: 1.4, // ... and where it is gone
  flareCoreSize: 0.022, // fraction of frame height
  flareCoreGlow: 3.0,
  flareBurstBlades: 6, // iris blades; an odd count throws twice as many spikes
  flareBurstLength: 0.17, // spike reach, fraction of frame height
  flareBurstSharp: 24,
  flareBurstJitter: 0.35, // how uneven the spikes are
  flareBurstSpin: 0.3, // radians
  flareHaloSize: 0.055,
  flareHaloWidth: 0.35,
  flareHaloGlow: 0.85,
  flareStreakLength: 0.36, // per side, as a fraction of frame WIDTH
  flareStreakThickness: 0.013, // fraction of frame height
  flareStreakFalloff: 2.2,
  flareStreakTight: 9,
  flareStreakGlow: 1.5,
  flareStreakTilt: 0.0, // radians off horizontal
  flareStreakGrain: 0.35,
  flareStreakChroma: 0.6,
  flareGhosts: 5, // how many of the eight built instances draw
  flareGhostSpacing: 0.34, // first ghost, as a fraction of source→centre
  flareGhostStride: 0.3, // added per ghost; negative walks back out
  flareGhostScatter: 0.1,
  flareGhostSize: 0.045, // fraction of frame height
  flareGhostSizeStep: 0.88, // multiplied per ghost
  flareGhostSizeScatter: 0.25,
  flareGhostBlades: 6, // one iris, so one blade count for the whole train
  flareGhostRound: 0.1, // 0 polygon, 1 disc
  flareGhostRoundStep: 0.14, // the far ones defocus
  flareGhostSpin: 0.5, // radians added per ghost
  flareGhostFill: 0.3,
  flareGhostRim: 0.9,
  flareGhostRimWidth: 0.14,
  flareGhostSoft: 0.22,
  flareGhostChroma: 0.5,
  flareGhostGlow: 1.0,
  flareRing: 1.0, // 0 hides the wide iris ring
  flareRingSpacing: 1.15, // fraction of the source→centre vector
  flareRingSize: 0.26,
  flareRingWidth: 0.03,
  flareRingBlades: 6,
  flareRingChroma: 1.0,
  flareRingGlow: 0.5,
  colorFlareCore: '#fff6e2',
  colorFlareHalo: '#ffd9a0',
  colorFlareStreak: '#ffe6b0',
  colorFlareStreakEdge: '#ff7a1f',
  colorFlareGhostA: '#ffd9a0',
  colorFlareGhostB: '#ff9f6a',
  colorFlareGhostC: '#8fe0c8',
  colorFlareGhostD: '#9fb4ff',
  colorFlareRing: '#ffd08a',

  /* --- the element (vfx/Shell, SUNDISC, prefix `disc`) --- */
  discRadius: 0.55, // half-width on arrival, metres
  discRadiusEnd: 1.05, // ... once it is burning. The bloom as focus is pulled.
  discExpand: 2.2, // easing exponent between those two
  discHeight: 0.02, // metres the disc is lifted off its own plane
  discSpan: 6, // metres — CONE/RING_TRAIN only; unread here
  discLift: 0.03, // metres of extra lift on the rim
  discDisplace: 0.04, // metres the surface is pushed about by noise
  discNoiseScale: 2.2, // noise features per metre
  discNoiseSpeed: 0.5, // how fast that noise churns
  discTurbulence: 1.0, // multiplier on `discDisplace`
  discFill: 0.85, // how solid the face reads
  discRim: 0.5, // strength of the fresnel rim
  discRimPower: 2.2, // how tight that rim is
  discSeal: 1.4, // DOME only; unread here
  discSealWidth: 0.12, // ditto
  discEdge: 1.3, // brightness of the disc's own outline
  discEdgeWidth: 0.13, // metres-ish width of it
  discConeCurve: 1.0, // CONE only; unread here
  discDissolve: 0.25, // how much of the face is eaten away by noise
  discRings: 1, // RING_TRAIN only; one ring is the disc
  discSpacing: 1.6, // ditto
  discRingSpeed: 7, // ditto
  discRingThickness: 0.16, // ditto
  discRingSharp: 1.6, // ditto
  discReflect: 1, // ditto
  discStanding: 1, // ditto
  discSwell: 0.45, // ditto
  discCoronaReach: 1.7, // how far past the rim the corona geometry is drawn
  discCorona: 1.5, // its brightness
  discCoronaLength: 0.6, // how far the filaments actually reach
  discCoronaScale: 5.5, // ridged-noise features across the plane
  discCoronaWarp: 0.5, // domain warp on them — this is what stops it being spokes
  discCoronaSpeed: 0.65, // how fast the corona licks
  discCoronaSharp: 0.7,
  discGranule: 0.4, // the mottle on the face
  discGranuleScale: 6,
  discRimWidth: 0.16, // width of the bright annulus at the edge
  discOpacity: 1.0,
  discGlow: 3.0,
  discSoftFade: 0.6, // metres of soft fade where the element meets geometry
  discColorBody: '#ffbe52', // the face
  discColorRim: '#fff0c0', // the annulus at the edge
  discColorEdge: '#ffffff', // the outline
  discColorCorona: '#ffa63a', // the filaments licking off it

  /* --- embers, smoke and motes --- */
  /**
   * Each system is coloured by a four-stop gradient sampled over the particle's
   * own lifetime, `A` at birth through `D` as it dies. Spelled out rather than
   * derived from the light, so the embers can be made to cool to red while the
   * beam stays white.
   */
  emberRate: 130, // embers thrown off the burning point, particles/second
  emberSize: 0.1,
  emberSpeed: 2.6,
  emberLifetime: 1.1,
  emberGravity: 2.4, // positive: they rise on the thermal
  emberStretch: 0.14, // how far an ember smears along its velocity
  emberScatter: 0.07, // fraction of `zoneRadius` they are thrown from
  colorEmberA: '#fff6dc',
  colorEmberB: '#ffbe52',
  colorEmberC: '#ff5d18',
  colorEmberD: '#4a1103',
  smokeRate: 46, // the thread of smoke off the char, particles/second
  smokeSize: 0.7,
  smokeSpeed: 0.9,
  smokeLifetime: 2.6,
  smokeOpacity: 0.09,
  smokeRise: 0.75, // upward drift, metres/second
  colorSmokeA: '#4a4038',
  colorSmokeB: '#3b332c',
  colorSmokeC: '#2e2823',
  colorSmokeD: '#1a1613',
  moteRate: 55, // dust turning over inside the cone, particles/second
  moteSize: 0.05,
  moteSpeed: 0.6,
  moteLifetime: 2.4,
  moteRise: 0.35, // metres/second
  moteTurbulence: 0.55,
  moteSpread: 0.55, // fraction of the cone's floor radius they fill
  colorMoteA: '#fff4d8',
  colorMoteB: '#ffd28a',
  colorMoteC: '#c98a3a',
  colorMoteD: '#3a2411',

  /* --- dynamic light --- */
  lightIntensity: 22,
  lightRadius: 12,
  lightColor: '#ffd08a',
  lightPulse: 0.12, // depth of the light's breathing, 0 = steady
  lightPulseSpeed: 1.6, // Hz

  /* --- the beats --- */
  castFlash: 0.06, // screen flash as the element leaves the hand
  colorCastFlash: '#ffe7b8',
  igniteSize: 1.6, // the shell at the moment focus is pulled, metres
  igniteIntensity: 1.6,
  igniteFlash: 0.16, // screen flash on ignition
  igniteEmbers: 90, // extra embers thrown then
  colorIgniteA: '#ff8a1f',
  colorIgniteB: '#ffcf6a',
  colorIgniteC: '#fffbf0',
  colorFlash: '#fff0cc', // the full-screen flash on ignition
  impactShake: 0.22, // the knock as the element tips over
  shakeDuration: 0.5,
  rumble: 0.012 // continuous shake while the floor is burning
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Solar Lens.
 *
 * Two folders do most of the work. **Pulling focus** decides whether this is a
 * burning glass or a lamp, and **The walk** decides what it writes on the
 * floor. Everything in both re-resolves on the frame it changes, so the right
 * way to tune them is to cast, press **P** at the moment the spot lands, and
 * drag — the focus point moves under the cursor because its position is a
 * function of the sliders and not of anything that was integrated.
 */
export const solarlensSchema = {
  'The cast': [
    ['range', 4, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 4, 120, 0.5, 'element speed'],
    ['zoneRadius', 1, 14, 0.05, 'footprint radius'],
    ['lifetime', 0.2, 10, 0.05, 'burn duration'],
    ['fadeTime', 0.05, 4, 0.01, 'fade time'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where the element hangs': [
    ['lensAltitude', 0.5, 14, 0.05, 'altitude (m)'],
    ['lensLead', -6, 6, 0.05, 'lead toward caster (m)'],
    ['lensClimb', 0.2, 5, 0.01, 'climb curve'],
    ['lensBob', 0, 1.5, 0.01, 'bob (m)'],
    ['lensBobSpeed', 0, 3, 0.01, 'bob Hz'],
    ['lensSway', 0, 2, 0.01, 'sway (m)'],
    ['lensSwaySpeed', 0, 3, 0.01, 'sway Hz']
  ],
  'Pulling focus': [
    ['focusTime', 0.05, 4, 0.01, 'pull time (s)'],
    ['focusCurve', 0.2, 6, 0.01, 'pull curve'],
    ['focusWide', 0.02, 1.4, 0.005, 'unfocused half-angle (rad)'],
    ['focusTight', 0.01, 0.6, 0.001, 'focused half-angle (rad)'],
    ['focusLift', 0, 1, 0.005, 'flare anchor lift (m)']
  ],
  'The walk': [
    ['walkSpeed', -2, 2, 0.005, 'turns / second'],
    ['walkPetals', 0, 9, 0.05, 'rosette lobes'],
    ['walkInner', 0, 1, 0.005, 'tightest radius (× zone)'],
    ['walkOuter', 0, 1.4, 0.005, 'widest radius (× zone)'],
    ['walkPhase', 0, 6.2832, 0.01, 'rosette phase (rad)'],
    ['walkWobble', 0, 0.3, 0.001, 'jitter (× zone)'],
    ['walkWobbleRate', 0, 12, 0.05, 'jitter Hz']
  ],
  'The char': [
    ['charMarksPerTurn', 1, 120, 1, 'pits / turn'],
    ['charMarkRadius', 0.02, 2, 0.01, 'pit radius (m)'],
    ['charMarkLife', 0.5, 30, 0.1, 'pit lifetime (s)'],
    ['charDepth', 0, 0.6, 0.005, 'bowl depth (m)'],
    ['charLift', 0, 0.3, 0.001, 'rim lift (m)'],
    ['charSharp', 0, 1, 0.01, 'rim sharpness'],
    ['charDetail', 0, 1, 0.01, 'interior grain'],
    ['charEdge', 0.02, 2, 0.01, 'front feather (m)'],
    ['charRagged', 0, 1, 0.01, 'front wander'],
    ['charRaggedScale', 0.05, 3, 0.01, 'lobes / metre'],
    ['charWarp', 0, 3, 0.01, 'domain warp (m)'],
    ['charRelief', 0, 2, 0.01, 'relief'],
    ['charNormalStep', 0.01, 0.3, 0.005, 'normal tap (m)'],
    ['charAmbient', 0, 1, 0.01, 'ambient floor'],
    ['charWrap', 0, 1, 0.01, 'terminator wrap'],
    ['charSpecular', 0, 2, 0.01, 'specular'],
    ['charGloss', 1, 90, 1, 'gloss'],
    ['charParallax', 0, 1.5, 0.01, 'parallax (m)'],
    ['charEmissive', 0, 4, 0.01, 'ember gain'],
    ['charOpacity', 0, 1.5, 0.01, 'opacity'],
    ['charDepthFade', 0.02, 2, 0.01, 'soft fade (m)'],
    ['colorCharBase', 'burnt floor'],
    ['colorCharEdge', 'pit lip'],
    ['colorCharGlow', 'live ember'],
    ['colorCharDeep', 'bowl bottom']
  ],
  'The focused light': [
    ['netRadius', 0.2, 14, 0.05, 'net radius (m)'],
    ['netDepth', 0, 4, 0.01, 'glass depth (m)'],
    ['netIor', 1.001, 2.6, 0.001, 'index of refraction'],
    ['netDispersion', 0, 1, 0.005, 'dispersion'],
    ['netSampleStep', 0.01, 0.4, 0.005, 'Hessian tap (m)'],
    ['netAbsorb', 0, 2, 0.005, 'absorption'],
    ['netFoldFloor', 0.005, 1, 0.005, 'fold clamp'],
    ['netThreshold', 0, 4, 0.01, 'filament threshold'],
    ['netGain', 0, 3, 0.01, 'gain'],
    ['netSharpness', 0.05, 5, 0.01, 'sharpness'],
    ['netRolloff', 0, 2, 0.01, 'rolloff'],
    ['netAmp', 0, 1, 0.005, 'lattice height (m)'],
    ['netCellScale', 0.05, 4, 0.01, 'cells / metre'],
    ['netCellRatio', 0.1, 4, 0.01, 'lattice ratio'],
    ['netCellJitter', 0, 1, 0.01, 'cell jitter'],
    ['netDriftAngle', 0, 6.2832, 0.01, 'drift angle (rad)'],
    ['netDriftSpeed', 0, 1.5, 0.005, 'drift speed (m/s)'],
    ['netBoil', 0, 4, 0.01, 'boil'],
    ['netRidgeMix', 0, 1, 0.01, 'ridge mix'],
    ['netRidgeScale', 0.05, 8, 0.01, 'ridge scale'],
    ['netRidgePower', 0.5, 16, 0.1, 'ridge power'],
    ['netPenumbra', 0.02, 1, 0.01, 'penumbra'],
    ['netEmissive', 0, 6, 0.01, 'emissive'],
    ['netOpacity', 0, 2, 0.01, 'opacity'],
    ['netWash', 0, 1.5, 0.01, 'pool wash'],
    ['netFringeAt', 0, 5, 0.01, 'fringe threshold'],
    ['netDepthFade', 0.02, 2, 0.01, 'soft fade (m)'],
    ['colorNet', 'filaments'],
    ['colorFringe', 'fold crest'],
    ['colorWash', 'pool wash']
  ],
  'The flare/Occlusion': [
    ['flareOcclusion', 0, 1, 0.01, 'occlusion'],
    ['flareOccRadius', 0.002, 0.2, 0.001, 'source half-size'],
    ['flareOccTaps', 1, 9, 1, 'kernel taps'],
    ['flareOccFade', 0.02, 4, 0.01, 'depth feather (m)'],
    ['flareOccSpin', 0, 6.2832, 0.01, 'kernel spin (rad)']
  ],
  'The flare/Core & streak': [
    ['flareIntensity', 0, 6, 0.01, 'intensity'],
    ['flareOpacity', 0, 2, 0.01, 'opacity'],
    ['flareHeadroom', 0.5, 24, 0.1, 'shoulder headroom'],
    ['flareEdgeStart', 0.1, 2, 0.01, 'edge fade start'],
    ['flareEdgeEnd', 0.2, 3, 0.01, 'edge fade end'],
    ['flareCoreSize', 0.002, 0.2, 0.001, 'core size'],
    ['flareCoreGlow', 0, 8, 0.01, 'core glow'],
    ['flareBurstBlades', 3, 12, 1, 'iris blades'],
    ['flareBurstLength', 0, 0.6, 0.005, 'spike reach'],
    ['flareBurstSharp', 1, 80, 0.5, 'spike sharpness'],
    ['flareBurstJitter', 0, 1, 0.01, 'spike jitter'],
    ['flareBurstSpin', 0, 6.2832, 0.01, 'spike spin (rad)'],
    ['flareHaloSize', 0, 0.4, 0.001, 'halo size'],
    ['flareHaloWidth', 0.01, 1, 0.01, 'halo width'],
    ['flareHaloGlow', 0, 4, 0.01, 'halo glow'],
    ['flareStreakLength', 0, 1, 0.005, 'streak length'],
    ['flareStreakThickness', 0.001, 0.1, 0.001, 'streak thickness'],
    ['flareStreakFalloff', 0.2, 8, 0.05, 'streak falloff'],
    ['flareStreakTight', 1, 30, 0.5, 'streak tightness'],
    ['flareStreakGlow', 0, 5, 0.01, 'streak glow'],
    ['flareStreakTilt', -0.6, 0.6, 0.005, 'streak tilt (rad)'],
    ['flareStreakGrain', 0, 1, 0.01, 'streak grain'],
    ['flareStreakChroma', 0, 2, 0.01, 'streak chroma']
  ],
  'The flare/Ghosts & ring': [
    ['flareGhosts', 0, 8, 1, 'ghosts drawn'],
    ['flareGhostSpacing', -2, 2, 0.01, 'first ghost'],
    ['flareGhostStride', -1, 1, 0.01, 'stride / ghost'],
    ['flareGhostScatter', 0, 1, 0.01, 'spacing scatter'],
    ['flareGhostSize', 0.002, 0.3, 0.001, 'ghost size'],
    ['flareGhostSizeStep', 0.4, 1.6, 0.01, 'size step'],
    ['flareGhostSizeScatter', 0, 1, 0.01, 'size scatter'],
    ['flareGhostBlades', 3, 12, 1, 'ghost blades'],
    ['flareGhostRound', 0, 1, 0.01, 'roundness'],
    ['flareGhostRoundStep', 0, 0.5, 0.005, 'roundness step'],
    ['flareGhostSpin', -2, 2, 0.01, 'spin / ghost (rad)'],
    ['flareGhostFill', 0, 2, 0.01, 'fill'],
    ['flareGhostRim', 0, 3, 0.01, 'rim'],
    ['flareGhostRimWidth', 0.01, 0.6, 0.005, 'rim width'],
    ['flareGhostSoft', 0.01, 1, 0.005, 'edge softness'],
    ['flareGhostChroma', 0, 2, 0.01, 'chroma'],
    ['flareGhostGlow', 0, 4, 0.01, 'glow'],
    ['flareRing', 0, 2, 0.01, 'iris ring'],
    ['flareRingSpacing', -2, 2, 0.01, 'ring position'],
    ['flareRingSize', 0.01, 1, 0.005, 'ring size'],
    ['flareRingWidth', 0.002, 0.2, 0.001, 'ring width'],
    ['flareRingBlades', 3, 12, 1, 'ring blades'],
    ['flareRingChroma', 0, 3, 0.01, 'ring chroma'],
    ['flareRingGlow', 0, 3, 0.01, 'ring glow']
  ],
  'The flare/Colour': [
    ['colorFlareCore', 'core'],
    ['colorFlareHalo', 'halo'],
    ['colorFlareStreak', 'streak'],
    ['colorFlareStreakEdge', 'streak edge'],
    ['colorFlareGhostA', 'ghost A'],
    ['colorFlareGhostB', 'ghost B'],
    ['colorFlareGhostC', 'ghost C'],
    ['colorFlareGhostD', 'ghost D'],
    ['colorFlareRing', 'iris ring']
  ],
  'The element/The disc': [
    ['discRadius', 0.05, 6, 0.01, 'radius on arrival (m)'],
    ['discRadiusEnd', 0.05, 8, 0.01, 'radius burning (m)'],
    ['discExpand', 0.05, 8, 0.01, 'bloom curve'],
    ['discHeight', 0, 1, 0.005, 'plane lift (m)'],
    ['discLift', 0, 1, 0.005, 'rim lift (m)'],
    ['discDisplace', 0, 0.6, 0.005, 'surface noise (m)'],
    ['discNoiseScale', 0.1, 10, 0.05, 'noise scale'],
    ['discNoiseSpeed', 0, 4, 0.01, 'noise speed'],
    ['discTurbulence', 0, 3, 0.01, 'turbulence'],
    ['discDissolve', 0, 1, 0.01, 'face dissolve'],
    ['discGranule', 0, 2, 0.01, 'granulation'],
    ['discGranuleScale', 0.2, 20, 0.1, 'granule scale']
  ],
  'The element/Rim & corona': [
    ['discFill', 0, 2, 0.01, 'face fill'],
    ['discRim', 0, 3, 0.01, 'fresnel rim'],
    ['discRimPower', 0.1, 8, 0.01, 'rim power'],
    ['discRimWidth', 0.01, 1, 0.005, 'rim width'],
    ['discEdge', 0, 4, 0.01, 'outline'],
    ['discEdgeWidth', 0.01, 1, 0.005, 'outline width'],
    ['discCoronaReach', 1, 4, 0.01, 'corona reach'],
    ['discCorona', 0, 5, 0.01, 'corona brightness'],
    ['discCoronaLength', 0, 2, 0.01, 'filament length'],
    ['discCoronaScale', 0.5, 20, 0.1, 'corona scale'],
    ['discCoronaWarp', 0, 2, 0.01, 'corona warp'],
    ['discCoronaSpeed', 0, 4, 0.01, 'corona speed'],
    ['discCoronaSharp', 0.05, 3, 0.01, 'corona sharpness'],
    ['discOpacity', 0, 2, 0.01, 'opacity'],
    ['discGlow', 0, 8, 0.01, 'glow'],
    ['discSoftFade', 0.02, 3, 0.01, 'soft fade (m)'],
    ['discColorBody', 'face'],
    ['discColorRim', 'rim annulus'],
    ['discColorEdge', 'outline'],
    ['discColorCorona', 'corona']
  ],
  // `Shell.sync()` resolves every field whatever the mode is, so the twelve
  // keys the other four modes own are still read off this block and still have
  // to exist. Filed together and out of the way rather than left to fall into
  // "More", where they read as controls that ought to do something.
  'The element/Unread by SUNDISC': [
    ['discSpan', 0.05, 20, 0.05, 'span (CONE/train)'],
    ['discSeal', 0, 4, 0.01, 'seal (DOME)'],
    ['discSealWidth', 0.01, 1, 0.01, 'seal width (DOME)'],
    ['discConeCurve', 0.05, 4, 0.01, 'cone curve (CONE)'],
    ['discRings', 1, 24, 1, 'rings (train)'],
    ['discSpacing', 0.05, 6, 0.01, 'ring spacing (train)'],
    ['discRingSpeed', 0, 30, 0.1, 'ring speed (train)'],
    ['discRingThickness', 0.01, 1, 0.01, 'ring thickness (train)'],
    ['discRingSharp', 0.05, 6, 0.01, 'ring sharpness (train)'],
    ['discReflect', 0, 1, 0.01, 'end reflection (train)'],
    ['discStanding', 0, 1, 0.01, 'standing wave (train)'],
    ['discSwell', 0, 2, 0.01, 'antinode swell (train)']
  ],
  'Embers, smoke & motes': [
    ['emberRate', 0, 800, 1, 'ember rate'],
    ['emberSize', 0.005, 0.5, 0.005, 'ember size'],
    ['emberSpeed', 0, 14, 0.05, 'ember speed'],
    ['emberLifetime', 0.1, 5, 0.05, 'ember lifetime'],
    ['emberGravity', -20, 12, 0.1, 'ember gravity'],
    ['emberStretch', 0, 2, 0.01, 'ember stretch'],
    ['emberScatter', 0, 0.6, 0.005, 'ember scatter (× zone)'],
    ['smokeRate', 0, 400, 1, 'smoke rate'],
    ['smokeSize', 0.05, 3, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 6, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['smokeRise', -2, 4, 0.01, 'smoke rise'],
    ['moteRate', 0, 400, 1, 'mote rate'],
    ['moteSize', 0.005, 0.3, 0.005, 'mote size'],
    ['moteSpeed', 0, 6, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -2, 4, 0.01, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['moteSpread', 0, 2, 0.01, 'mote spread (× spot)'],
    ['colorEmber*', 'Ember colour'],
    ['colorSmoke*', 'Smoke colour'],
    ['colorMote*', 'Mote colour']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'breathing depth'],
    ['lightPulseSpeed', 0, 12, 0.05, 'breathing Hz'],
    ['lightColor', 'light colour']
  ],
  'The beats': [
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash'],
    ['igniteSize', 0.1, 8, 0.05, 'ignition shell (m)'],
    ['igniteIntensity', 0, 5, 0.01, 'ignition intensity'],
    ['igniteFlash', 0, 2, 0.01, 'ignition screen flash'],
    ['igniteEmbers', 0, 400, 1, 'ignition embers'],
    ['colorIgniteA', 'ignition shell'],
    ['colorIgniteB', 'ignition body'],
    ['colorIgniteC', 'ignition core'],
    ['colorFlash', 'ignition flash colour'],
    ['impactShake', 0, 2, 0.01, 'arrival shake'],
    ['shakeDuration', 0.1, 3, 0.01, 'shake duration'],
    ['rumble', 0, 0.3, 0.001, 'burn rumble']
  ]
};
