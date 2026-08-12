/* ================================================================== */
/* FULMINANT ORB — storm, line                                         */
/* ================================================================== */
/**
 * A caged orb that travels slowly enough that you watch it come.
 *
 * Two things make it, and neither is a bolt. The first is that the filaments
 * **orbit**: great slow loops on inclined planes around a near-invisible
 * pressure shell, rather than the radiating fan every other storm slot draws.
 * The second is the speed — six and a half metres a second, which is walking
 * pace, and the only slot in the sandbox where the travel itself is the
 * spectacle rather than a delay before the impact.
 *
 * **The cage is measured against the shell, on purpose.** `orbitRadius` is a
 * multiple of the shell's live radius, not a metre count of its own. This is
 * the one derivation invariant I5 permits — the kind where the sharing *is* the
 * design, as `snare.zoneRadius` drives five consumers at once — and it is what
 * makes the impact work: the shell interpolates `orbRadius → orbRadiusEnd` on
 * its own easing as `t` runs 0→1, and the cage opens with it, in step, from one
 * slider. Authoring the cage in metres meant tuning the burst twice and getting
 * filaments *inside* the shell every time the two disagreed.
 *
 * **The earthing spikes are stateless.** A second `LINE` role stabs from the
 * orb to the floor now and then, and nothing remembers when. The clock is
 * quantised into `earthRate` slots per second, a hash of the slot index decides
 * whether that slot earths at all, and `earthDuty` says how much of the slot the
 * spike lives for. Nothing is captured, so dragging any of the three with the
 * clock stopped changes whether there is a spike standing in front of you — the
 * first version kept a fired-at timestamp and a bool, and neither of them could
 * be moved by a slider.
 *
 * The hum is the other half of the character. `humDepth` / `humRate` /
 * `humBeat` drive `lightShimmer()` as two sines beating against each other,
 * which is a *continuous* wobble; Storm Lance quantises a hash onto a step
 * clock and gets a hard stutter. Put the two side by side in the sandbox and
 * the difference is the whole personality of the slot.
 */
export const balllightning = {
  /* --- the cast --- */
  range: 18.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 6.5, // metres/second — deliberately slow; you watch it come
  lifetime: 0.9, // seconds the discharge holds after it lands
  fadeTime: 0.9, // seconds it takes to die away
  cooldown: 1.3, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the orb rides --- */
  handHeight: 1.24, // metres above the floor as it leaves the caster
  handForward: 0.6, // metres in front of the caster
  handSide: 0.18, // metres to the side (+ follows `Ability#side`)
  endHeight: 0.85, // metres above the floor where it arrives
  bobAmp: 0.09, // metres it rises and falls as it travels
  bobRate: 0.55, // bobs per second
  wanderAmp: 0.22, // metres it drifts off the aim line
  wanderRate: 0.31, // drifts per second — deliberately not a multiple of `bobRate`

  /* --- the shell (vfx/Shell.js, ShellMode.PRESSURE, prefix "orb") --- */
  // A pressure shell is ninety-five per cent fresnel rim and almost no body,
  // which is exactly what "near-invisible" wants. Hand-authored rather than
  // spread from `shellDefaults()` so every field can carry its unit.
  orbRadius: 0.55, // shell radius while travelling, metres
  orbRadiusEnd: 4.2, // shell radius at full discharge, metres
  orbExpand: 3.2, // easing exponent on that expansion: 1 − (1−t)^n
  orbHeight: 1.0, // axial extent, × radius — 1 is a ball
  orbSpan: 6.0, // CONE/RING_TRAIN run length, metres — inert in PRESSURE
  orbLift: 0.02, // hover above the anchor along the axis, metres
  orbDisplace: 0.09, // billow along the normal, × radius
  orbNoiseScale: 2.4, // billow features per unit radius
  orbNoiseSpeed: 0.9, // Hz the billow crawls at
  orbTurbulence: 1.0, // master on the billow
  orbFill: 0.03, // how much body the shell keeps, 0 = rim only
  orbRim: 1.7, // strength of the fresnel rim — this is the shell
  orbRimPower: 3.0, // how tight that rim is
  orbSeal: 1.4, // DOME floor seal — inert in PRESSURE
  orbSealWidth: 0.12, // width of that seal band — inert in PRESSURE
  orbEdge: 1.2, // CONE leading lip — inert in PRESSURE
  orbEdgeWidth: 0.16, // width of that lip — inert in PRESSURE
  orbConeCurve: 1.0, // CONE flare — inert in PRESSURE
  orbDissolve: 1.1, // how hard the age dissolve bites, 0 = fade evenly
  orbRings: 10, // RING_TRAIN instances — inert in PRESSURE
  orbSpacing: 1.6, // RING_TRAIN wavelength, metres — inert in PRESSURE
  orbRingSpeed: 7.0, // RING_TRAIN speed, metres/second — inert in PRESSURE
  orbRingThickness: 0.16, // RING_TRAIN ring thickness, metres — inert in PRESSURE
  orbRingSharp: 1.6, // RING_TRAIN profile — inert in PRESSURE
  orbReflect: 1.0, // RING_TRAIN end reflection — inert in PRESSURE
  orbStanding: 1.0, // RING_TRAIN standing envelope — inert in PRESSURE
  orbSwell: 0.45, // RING_TRAIN antinode swell, × radius — inert in PRESSURE
  orbCoronaReach: 1.8, // SUNDISC drawn reach, × radius — inert in PRESSURE
  orbCorona: 1.3, // SUNDISC corona brightness — inert in PRESSURE
  orbCoronaLength: 0.55, // SUNDISC filament reach, × radius — inert in PRESSURE
  orbCoronaScale: 5.0, // SUNDISC filaments per radius — inert in PRESSURE
  orbCoronaWarp: 0.45, // SUNDISC domain warp — inert in PRESSURE
  orbCoronaSpeed: 0.7, // SUNDISC corona Hz — inert in PRESSURE
  orbCoronaSharp: 0.72, // SUNDISC corona threshold — inert in PRESSURE
  orbGranule: 0.45, // SUNDISC convection cells — inert in PRESSURE
  orbGranuleScale: 6.0, // SUNDISC cells per radius — inert in PRESSURE
  orbRimWidth: 0.18, // SUNDISC hot band, × radius — inert in PRESSURE
  orbOpacity: 1.0,
  orbGlow: 1.4, // emissive gain into bloom
  orbSoftFade: 0.6, // metres of depth fade against the opaque scene
  orbColorBody: '#2f3fd0', // the little body the shell has
  orbColorRim: '#9fd0ff', // the fresnel rim — almost all of what you see
  orbColorEdge: '#ffffff', // the hottest mark it has
  orbColorCorona: '#9fd0ff', // SUNDISC filaments — inert in PRESSURE

  /* --- the cage: filaments in ORBIT around the shell --- */
  orbitCount: 9, // filaments looping around the orb
  orbitRadius: 1.45, // loop radius, × the shell's live radius (see the header)
  orbitArc: 0.62, // turns one filament covers; below 1 the loop is open
  orbitSpin: 0.42, // turns/second the loops travel — slow, on purpose
  orbitWobble: 0.35, // 0..1 how far from a clean circle
  orbitTilt: 0.5, // radians the mean orbital plane is tipped by
  orbitTiltSpread: 1.5, // radians of per-filament variation on that tilt
  orbitJitter: 0.22, // ± fraction of the radius, per filament
  orbitLean: 0.45, // metres the orbital pole leans along the heading
  orbitKink: 0.55, // multiplier on `jitter` for the cage role
  orbitWidth: 1.0, // multiplier on `width` for the cage role
  orbitDim: 1.0, // 0..1 alpha on the cage role
  orbitGroundDamp: 1.0, // 1 = the cage is in the air and wants no damping
  orbitBurst: 1.9, // multiplier on `orbitCount` once it has landed

  /* --- the ribbon, shared by all three roles --- */
  width: 0.024, // half-width of the core ribbon, metres
  glowWidth: 6.4, // halo half-width, × `width`
  glowOpacity: 0.46, // halo alpha relative to the core
  jitter: 0.24, // metres of lateral kink at the coarsest octave
  jitterScale: 2.2, // kinks per metre
  octaves: 3, // 1–5; each halves the amplitude and doubles the rate
  jitterFalloff: 0.5, // amplitude kept per octave
  crawl: 1.6, // how fast the kinks slide along, per second
  pinch: 0.2, // 0..1 of the path the kink is eased in over at each end
  restrike: 14, // whole re-shapes per second — half the bolt's, it is calmer
  flicker: 0.18, // 0..1 depth of the whole-cage brightness wobble
  flickerSpeed: 12, // steps/second that wobble is quantised to
  strandFlash: 0.3, // 0..1 depth of the per-filament blink
  coreSharp: 4.0, // exponent on the core's edge falloff
  glowFalloff: 2.2, // the same for the halo
  softFade: 0.7, // metres of depth fade against the opaque scene
  opacity: 1.0,
  glow: 2.1, // emissive gain into bloom

  /* --- colour of the ribbon --- */
  colorCore: '#ffffff', // the white-hot centre line
  colorInner: '#dcefff',
  colorOuter: '#9fd0ff',
  colorHalo: '#2f3fd0', // the wide, dim atmosphere

  /* --- the earthing spike --- */
  earthRate: 3.4, // slots per second in which a spike may happen
  earthChance: 0.42, // 0..1 of those slots that actually earth
  earthDuty: 0.45, // 0..1 of a slot the spike is alive for
  spikeStrands: 2, // filaments in one spike
  spikeBurst: 3.0, // multiplier on that count once it has landed
  spikeExit: 0.55, // where on the shell the spike leaves, × shell radius
  spikeDrop: 0.4, // how far below the centre it leaves, × shell radius
  spikeWander: 0.7, // metres the floor end may stray sideways
  spikeFloor: 0.04, // metres the spike is clamped above the floor
  spikeSag: 0.06, // metres it bows at mid-span
  spikeNear: 0.02, // metres it is fanned at the orb
  spikeSpread: 0.3, // ... and at the floor
  spikeCurve: 1.5, // how late that fan opens
  spikeTwist: 0.25, // turns of roll from orb to floor
  spikeTwistSpeed: 1.4, // turns/second the fan rolls
  spikeConverge: 0.8, // 0..1 — how hard the far end is pinned to the floor point
  spikeKink: 1.1, // multiplier on `jitter` for the spike role
  spikeWidth: 0.85, // multiplier on `width` for the spike role
  spikeDim: 0.9, // 0..1 alpha on the spike role
  spikeGroundDamp: 0.35, // 0..1 on the kink's world y near the floor
  spikeTipGlow: 1.8, // extra core colour where it hits the floor

  /* --- the ring of ground current the discharge lays down --- */
  ringCount: 8, // travelling arcs around the footprint
  ringRadius: 0.8, // footprint radius, × the shell's live radius
  ringSpan: 0.21, // turns one arc covers
  ringSpeed: 0.55, // turns/second the arcs travel around
  ringLift: 0.3, // metres an arc hops at mid-span
  ringJitter: 0.35, // 0..1 radial wobble
  ringHug: 0.05, // metres above the floor
  ringPhase: 0.13, // turns of constant offset between the two halves
  ringKink: 0.8, // multiplier on `jitter` for the ring role
  ringWidth: 0.9, // multiplier on `width` for the ring role
  ringDim: 0.85, // 0..1 alpha on the ring role
  ringGroundDamp: 0.28, // 0..1 on the kink's world y — flat filaments bury without this
  ringFloor: 0.02, // metres the ring is clamped above the floor
  ringGrow: 0.24, // seconds the ring takes to be drawn out
  ringTip: 0.16, // 0..1 of the path the growing front is smeared over
  ringTipGlow: 1.1, // extra core colour at that front

  /* --- what the ground does --- */
  wakeRate: 1.1, // burns laid per metre of travel — the orb's wake
  wakeRadius: 0.55, // radius of one wake burn, metres
  wakeLife: 0.7, // seconds a wake burn lingers
  wakeIntensity: 0.7,
  wakeBranches: 0.5, // how finely a wake burn splits into filaments
  scorchRadius: 0.34, // dark mark under the orb, metres
  scorchLife: 5.0, // seconds
  scorchIntensity: 0.3,
  colorArc: '#9fd0ff', // the branching burn
  colorEmber: '#4a7aff', // its hot centre
  colorScorch: '#080a14', // the dark mark
  shockRadius: 6.0, // impact shockwave ring, metres
  colorShockA: '#c9e4ff', // body of the shockwave ring
  colorShockB: '#ffffff', // its crest

  /* --- motes, sparks, smoke and debris --- */
  /**
   * Four-stop lifetime gradients, `A` at birth through `D` as it dies, spelled
   * out per system rather than derived from the ribbon palette — the motes want
   * to cool into the shell's indigo while the sparks stay white.
   */
  moteRate: 130, // ionised motes drawn around the orb, particles/second
  moteSize: 0.055,
  moteSpeed: 0.7, // metres/second
  moteLifetime: 1.1, // seconds
  moteRise: 0.35, // upward drift, metres/second
  moteTurbulence: 0.9,
  moteShell: 1.15, // where they are born, × shell radius
  colorMoteA: '#ffffff',
  colorMoteB: '#dcefff',
  colorMoteC: '#6f8fff',
  colorMoteD: '#0b1550',
  sparkRate: 60, // sparks shed by the cage, particles/second
  sparkSize: 0.11,
  sparkSpeed: 4.5, // metres/second
  sparkLifetime: 0.4, // seconds
  sparkGravity: -11.0, // metres/second²
  sparkStretch: 0.16, // how far a spark smears along its velocity
  colorSparkA: '#ffffff',
  colorSparkB: '#dcefff',
  colorSparkC: '#9fd0ff',
  colorSparkD: '#233a8a',
  smokeRate: 14, // thin haze off the scorched floor, particles/second
  smokeSize: 0.85,
  smokeSpeed: 0.9, // metres/second
  smokeLifetime: 2.2, // seconds
  smokeOpacity: 0.05,
  smokeRise: 0.45, // metres/second
  colorSmokeA: '#3a4a6e',
  colorSmokeB: '#30405e',
  colorSmokeC: '#283652',
  colorSmokeD: '#1a2338',
  debrisSize: 0.05,
  debrisSpeed: 5.0, // metres/second
  debrisLifetime: 1.2, // seconds
  debrisGravity: -17.0, // metres/second²
  colorDebrisA: '#252c36',
  colorDebrisB: '#1c222a',
  colorDebrisC: '#1c222a',
  colorDebrisD: '#141920',

  /* --- dynamic light: the hum --- */
  lightIntensity: 20, // the orb is its own lamp for the whole travel
  lightRadius: 13, // metres
  lightColor: '#7f9fff',
  humDepth: 0.3, // 0..1 depth of the hum, 0 = a steady lamp
  humRate: 6.5, // Hz of the first sine
  humBeat: 1.47, // the second sine's rate, × the first — keep it irrational-ish

  /* --- the release and the discharge --- */
  castFlash: 0.07, // screen flash as the orb leaves the hand
  colorCastFlash: '#c9e4ff',
  muzzleSize: 0.5, // the shell at the hand, metres
  muzzleIntensity: 1.5,
  burstSize: 4.0, // the shell at the discharge, metres
  burstIntensity: 1.7,
  burstSparks: 190, // sparks thrown by the discharge
  burstDebris: 55,
  burstMotes: 120, // motes released by the cage as it opens
  impactShake: 0.85,
  shakeDuration: 0.7, // seconds
  impactFlash: 0.3, // screen flash at the discharge
  impactLightPunch: 22.0, // additive light punch as it opens
  rumble: 0.012, // continuous shake while it travels
  colorMuzzleA: '#2f3fd0', // muzzle shell
  colorMuzzleB: '#9fd0ff', // muzzle body
  colorMuzzleC: '#ffffff', // muzzle arcs
  colorBurstA: '#2f3fd0', // discharge shell
  colorBurstB: '#9fd0ff', // discharge body
  colorBurstC: '#ffffff', // discharge arcs
  colorFlash: '#c9e4ff' // the full-screen flash at the discharge
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Fulminant Orb.
 *
 * **The cage** is the folder to open first. `orbitArc` below 1 is what makes a
 * filament a loop with two loose ends rather than a closed ring, `orbitSpin`
 * decides whether the orb is idling or furious, and `orbitTiltSpread` is the
 * one that turns nine coplanar rings into something that actually reads as a
 * cage from any angle. `orbitRadius` is a *multiple of the shell radius*, not
 * metres — see the header.
 *
 * **The hum** is three sliders and worth a minute. `humBeat` at exactly 1 or 2
 * gives a period you can count, which reads as a pulse; leave it somewhere
 * awkward and the level never quite repeats, which is what a hum is.
 *
 * The shell's mode-specific fields for `RING_TRAIN` and `SUNDISC` are still in
 * the block — `Shell` audits the whole contract and warns about a short one —
 * so they are filed together at the bottom rather than left to fall into
 * "More". They are pushed into uniforms the PRESSURE branch never reads.
 */
export const balllightningSchema = {
  'The cast': [
    ['range', 2, 60, 0.1, 'max range'],
    ['minRange', 0, 10, 0.1, 'min range'],
    ['speed', 0.5, 40, 0.1, 'travel speed (m/s)'],
    ['lifetime', 0.05, 6, 0.01, 'discharge lifetime'],
    ['fadeTime', 0.05, 4, 0.01, 'fade time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'Where the orb rides': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['endHeight', 0, 4, 0.01, 'height at target'],
    ['bobAmp', 0, 1, 0.005, 'bob amplitude (m)'],
    ['bobRate', 0, 6, 0.01, 'bobs / sec'],
    ['wanderAmp', 0, 2, 0.01, 'drift amplitude (m)'],
    ['wanderRate', 0, 4, 0.01, 'drifts / sec']
  ],
  'The shell': [
    ['orbRadius', 0.05, 6, 0.01, 'radius travelling (m)'],
    ['orbRadiusEnd', 0.05, 20, 0.01, 'radius discharging (m)'],
    ['orbExpand', 0.2, 12, 0.01, 'expansion curve'],
    ['orbHeight', 0.02, 4, 0.01, 'height × radius'],
    ['orbLift', -2, 2, 0.001, 'lift (m)'],
    ['orbDisplace', 0, 1.5, 0.01, 'billow'],
    ['orbNoiseScale', 0.1, 10, 0.01, 'billow scale'],
    ['orbNoiseSpeed', 0, 4, 0.01, 'billow Hz'],
    ['orbTurbulence', 0, 3, 0.01, 'turbulence'],
    ['orbFill', 0, 1, 0.01, 'body fill'],
    ['orbRim', 0, 3, 0.01, 'fresnel rim'],
    ['orbRimPower', 0.1, 8, 0.01, 'rim power'],
    ['orbDissolve', 0, 2, 0.01, 'dissolve'],
    ['orbOpacity', 0, 1, 0.01, 'opacity'],
    ['orbGlow', 0, 8, 0.01, 'glow'],
    ['orbSoftFade', 0, 3, 0.01, 'soft fade (m)'],
    ['orbColorBody', 'shell body'],
    ['orbColorRim', 'shell rim'],
    ['orbColorEdge', 'shell edge']
  ],
  'The cage': [
    ['orbitCount', 0, 24, 1, 'filaments'],
    ['orbitRadius', 0.2, 4, 0.01, 'loop radius × shell'],
    ['orbitArc', 0.05, 3, 0.01, 'turns per filament'],
    ['orbitSpin', -4, 4, 0.01, 'spin (turns/sec)'],
    ['orbitWobble', 0, 2, 0.01, 'wobble'],
    ['orbitTilt', -3.2, 3.2, 0.01, 'plane tilt (rad)'],
    ['orbitTiltSpread', 0, 3.2, 0.01, 'tilt spread (rad)'],
    ['orbitJitter', 0, 1, 0.01, 'radius jitter'],
    ['orbitLean', -3, 3, 0.01, 'pole lean (m)'],
    ['orbitKink', 0, 3, 0.01, 'kink ×'],
    ['orbitWidth', 0.1, 4, 0.01, 'width ×'],
    ['orbitDim', 0, 1, 0.01, 'alpha'],
    ['orbitGroundDamp', 0, 1, 0.01, 'ground damp'],
    ['orbitBurst', 1, 5, 0.01, 'count × on discharge']
  ],
  'The ribbon': [
    ['width', 0.005, 0.4, 0.001, 'core width (m)'],
    ['glowWidth', 1, 20, 0.1, 'halo width'],
    ['glowOpacity', 0, 2, 0.01, 'halo opacity'],
    ['jitter', 0, 3, 0.01, 'kink amplitude (m)'],
    ['jitterScale', 0.05, 6, 0.01, 'kinks / metre'],
    ['octaves', 1, 5, 1, 'octaves'],
    ['jitterFalloff', 0.1, 0.95, 0.01, 'octave falloff'],
    ['crawl', -20, 20, 0.1, 'kink crawl'],
    ['pinch', 0.01, 0.5, 0.005, 'end pinch'],
    ['restrike', 0.5, 90, 0.5, 'restrikes / sec'],
    ['flicker', 0, 1, 0.01, 'brightness wobble'],
    ['flickerSpeed', 1, 120, 1, 'wobble rate'],
    ['strandFlash', 0, 1, 0.01, 'filament blink'],
    ['coreSharp', 0.5, 12, 0.05, 'core sharpness'],
    ['glowFalloff', 0.2, 8, 0.05, 'halo falloff'],
    ['softFade', 0.02, 3, 0.01, 'soft intersection'],
    ['opacity', 0, 2, 0.01, 'opacity'],
    ['glow', 0, 8, 0.01, 'glow'],
    ['colorCore', 'core'],
    ['colorInner', 'inner'],
    ['colorOuter', 'outer'],
    ['colorHalo', 'halo']
  ],
  'The earthing spike': [
    ['earthRate', 0.1, 20, 0.05, 'slots / sec'],
    ['earthChance', 0, 1, 0.01, 'slots that earth'],
    ['earthDuty', 0.02, 1, 0.01, 'slot duty'],
    ['spikeStrands', 1, 8, 1, 'spike filaments'],
    ['spikeBurst', 1, 6, 0.01, 'count × on discharge'],
    ['spikeExit', 0, 2, 0.01, 'exit radius × shell'],
    ['spikeDrop', -1, 2, 0.01, 'exit drop × shell'],
    ['spikeWander', 0, 4, 0.01, 'floor wander (m)'],
    ['spikeFloor', 0, 1, 0.005, 'floor clamp (m)'],
    ['spikeSag', -1, 1, 0.01, 'spike sag (m)'],
    ['spikeNear', 0, 1, 0.005, 'fan at orb (m)'],
    ['spikeSpread', 0, 3, 0.01, 'fan at floor (m)'],
    ['spikeCurve', 0.2, 5, 0.01, 'fan curve'],
    ['spikeTwist', -4, 4, 0.01, 'twist'],
    ['spikeTwistSpeed', -6, 6, 0.01, 'twist speed'],
    ['spikeConverge', 0, 1, 0.01, 'lock onto floor'],
    ['spikeKink', 0, 3, 0.01, 'kink ×'],
    ['spikeWidth', 0.1, 4, 0.01, 'width ×'],
    ['spikeDim', 0, 1, 0.01, 'alpha'],
    ['spikeGroundDamp', 0, 1, 0.01, 'ground damp'],
    ['spikeTipGlow', 0, 6, 0.05, 'floor-strike glow']
  ],
  'The ring of ground current': [
    ['ringCount', 0, 16, 1, 'arcs'],
    ['ringRadius', 0.1, 3, 0.01, 'radius × shell'],
    ['ringSpan', 0.02, 1, 0.01, 'turns per arc'],
    ['ringSpeed', -3, 3, 0.01, 'travel (turns/sec)'],
    ['ringLift', 0, 2, 0.01, 'mid-span hop (m)'],
    ['ringJitter', 0, 2, 0.01, 'radial wobble'],
    ['ringHug', 0, 1, 0.005, 'float above floor (m)'],
    ['ringPhase', 0, 1, 0.01, 'phase offset'],
    ['ringKink', 0, 3, 0.01, 'kink ×'],
    ['ringWidth', 0.1, 4, 0.01, 'width ×'],
    ['ringDim', 0, 1, 0.01, 'alpha'],
    ['ringGroundDamp', 0, 1, 0.01, 'ground damp'],
    ['ringFloor', 0, 1, 0.005, 'floor clamp (m)'],
    ['ringGrow', 0.02, 2, 0.01, 'grow time'],
    ['ringTip', 0.01, 1, 0.01, 'front smear'],
    ['ringTipGlow', 0, 6, 0.05, 'front glow']
  ],
  'The wake on the ground': [
    ['wakeRate', 0.05, 8, 0.05, 'burns / metre'],
    ['wakeRadius', 0.1, 8, 0.05, 'burn radius'],
    ['wakeLife', 0.05, 5, 0.05, 'burn lifetime'],
    ['wakeIntensity', 0, 3, 0.01, 'burn intensity'],
    ['wakeBranches', 0, 3, 0.01, 'branch detail'],
    ['scorchRadius', 0.05, 4, 0.05, 'scorch radius'],
    ['scorchLife', 0.5, 20, 0.1, 'scorch lifetime'],
    ['scorchIntensity', 0, 2, 0.01, 'scorch intensity'],
    ['shockRadius', 0.5, 25, 0.1, 'shockwave radius'],
    ['colorArc', 'burn'],
    ['colorEmber', 'ember'],
    ['colorScorch', 'scorch'],
    ['colorShockA', 'shockwave ring'],
    ['colorShockB', 'shockwave crest']
  ],
  'Motes & sparks': [
    ['moteRate', 0, 600, 1, 'mote rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'mote size'],
    ['moteSpeed', 0, 12, 0.05, 'mote speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'mote lifetime'],
    ['moteRise', -3, 8, 0.05, 'mote rise'],
    ['moteTurbulence', 0, 3, 0.01, 'mote turbulence'],
    ['moteShell', 0.2, 4, 0.01, 'birth radius × shell'],
    ['sparkRate', 0, 1200, 1, 'spark rate'],
    ['sparkSize', 0.005, 0.8, 0.005, 'spark size'],
    ['sparkSpeed', 0, 40, 0.1, 'spark speed'],
    ['sparkLifetime', 0.05, 4, 0.01, 'spark lifetime'],
    ['sparkGravity', -50, 5, 0.1, 'spark gravity'],
    ['sparkStretch', 0, 3, 0.01, 'spark stretch'],
    ['colorMote*', 'Mote colour'],
    ['colorSpark*', 'Spark colour']
  ],
  'Smoke & debris': [
    ['smokeRate', 0, 500, 1, 'smoke rate'],
    ['smokeSize', 0.05, 4, 0.01, 'smoke size'],
    ['smokeSpeed', 0, 8, 0.05, 'smoke speed'],
    ['smokeLifetime', 0.2, 8, 0.05, 'smoke lifetime'],
    ['smokeOpacity', 0, 1, 0.005, 'smoke opacity'],
    ['smokeRise', -2, 4, 0.01, 'smoke rise'],
    ['debrisSize', 0.005, 0.4, 0.005, 'debris size'],
    ['debrisSpeed', 0, 25, 0.1, 'debris speed'],
    ['debrisLifetime', 0.1, 5, 0.05, 'debris lifetime'],
    ['debrisGravity', -50, 0, 0.1, 'debris gravity'],
    ['colorSmoke*', 'Smoke colour'],
    ['colorDebris*', 'Debris colour']
  ],
  'The hum': [
    ['lightIntensity', 0, 120, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 50, 0.1, 'light radius'],
    ['humDepth', 0, 1, 0.01, 'hum depth'],
    ['humRate', 0.1, 30, 0.05, 'hum rate (Hz)'],
    ['humBeat', 0.05, 4, 0.01, 'beat ratio'],
    ['lightColor', 'light colour']
  ],
  'Release & discharge': [
    ['castFlash', 0, 2, 0.01, 'flash on release'],
    ['colorCastFlash', 'release flash colour'],
    ['muzzleSize', 0.05, 6, 0.05, 'muzzle size'],
    ['muzzleIntensity', 0, 5, 0.01, 'muzzle intensity'],
    ['colorMuzzleA', 'muzzle shell'],
    ['colorMuzzleB', 'muzzle body'],
    ['colorMuzzleC', 'muzzle arcs'],
    ['burstSize', 0.2, 14, 0.05, 'discharge size'],
    ['burstIntensity', 0, 5, 0.01, 'discharge intensity'],
    ['burstSparks', 0, 600, 1, 'discharge sparks'],
    ['burstDebris', 0, 300, 1, 'discharge debris'],
    ['burstMotes', 0, 600, 1, 'discharge motes'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['impactFlash', 0, 2, 0.01, 'screen flash'],
    ['impactLightPunch', 0, 120, 0.5, 'light punch'],
    ['rumble', 0, 0.5, 0.005, 'travel rumble'],
    ['colorBurstA', 'discharge shell'],
    ['colorBurstB', 'discharge body'],
    ['colorBurstC', 'discharge arcs'],
    ['colorFlash', 'discharge flash colour']
  ],
  'The shell/Inert in PRESSURE mode': [
    ['orbSpan', 0.1, 40, 0.05, 'CONE / train length (m)'],
    ['orbSeal', 0, 4, 0.01, 'DOME floor seal'],
    ['orbSealWidth', 0.01, 0.6, 0.01, 'DOME seal width'],
    ['orbEdge', 0, 4, 0.01, 'CONE leading lip'],
    ['orbEdgeWidth', 0.01, 0.8, 0.01, 'CONE lip width'],
    ['orbConeCurve', 0.1, 4, 0.01, 'CONE flare curve'],
    ['orbRings', 1, 48, 1, 'train rings'],
    ['orbSpacing', 0.1, 12, 0.01, 'train wavelength (m)'],
    ['orbRingSpeed', 0, 40, 0.05, 'train speed (m/s)'],
    ['orbRingThickness', 0.01, 2, 0.01, 'train thickness (m)'],
    ['orbRingSharp', 0.05, 8, 0.01, 'train profile'],
    ['orbReflect', 0, 1, 0.01, 'train reflection'],
    ['orbStanding', 0, 1, 0.01, 'train standing wave'],
    ['orbSwell', 0, 2, 0.01, 'train antinode swell'],
    ['orbCoronaReach', 1, 4, 0.01, 'disc drawn reach'],
    ['orbCorona', 0, 4, 0.01, 'disc corona'],
    ['orbCoronaLength', 0, 3, 0.01, 'disc corona length'],
    ['orbCoronaScale', 0.5, 20, 0.1, 'disc corona scale'],
    ['orbCoronaWarp', 0, 2, 0.01, 'disc corona warp'],
    ['orbCoronaSpeed', 0, 4, 0.01, 'disc corona Hz'],
    ['orbCoronaSharp', 0, 0.98, 0.01, 'disc corona threshold'],
    ['orbGranule', 0, 2, 0.01, 'disc granulation'],
    ['orbGranuleScale', 0.5, 24, 0.1, 'disc granule scale'],
    ['orbRimWidth', 0.01, 0.6, 0.01, 'disc rim band'],
    ['orbColorCorona', 'disc corona colour']
  ]
};
