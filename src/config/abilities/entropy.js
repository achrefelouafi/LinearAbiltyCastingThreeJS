/* ================================================================== */
/* ENTROPY WAVE — one number ages a material                           */
/* ================================================================== */
/**
 * A far cast, and the quietest thing in the sandbox. Almost nothing is drawn:
 * a ring of refraction runs out across the floor, three thin particle systems
 * shed off the ground behind it, and the **real** work is a single 0..1 handed
 * to `Hook.AGE`, which the floor's own `MeshStandardMaterial` reads and turns
 * into rust, dust, moss, pitting and bleaching.
 *
 * ### One field, five substances
 *
 * `wearRust` … `wearBleach` are five independent weights on one field, exactly
 * as invariant I5 asks, and they are not five tints. Each one moves a different
 * channel of the surface — rust takes metalness *up*, moss and dust take it
 * down, pitting darkens and roughens, bleaching desaturates and lifts — which
 * is the difference between a material that has aged and a decal that has been
 * laid on top of one. The maths is in `vfx/SceneHooks.js`; what lives here is
 * the mix.
 *
 * The five `*Onset` fractions are the only thing this block adds to that. They
 * stagger the terms along the zone's own age so the sequence is legible: the
 * stone pits and dusts almost at once, rust needs a moment, and moss is last
 * because moss is the slowest thing that happens to a floor. Set all five to
 * zero and the zone ages in one step, which looks like a filter.
 *
 * ### The sweep is one number too
 *
 * `lead` is the leading edge as a fraction of `fieldSpread × zoneRadius`. It
 * runs 0 → 1 while the wave crosses the floor, holds, and comes **back** to 0.
 * The same number places the refraction ring, seeds the particles and sets the
 * age token's radius, so the shimmer, the flakes and the rust cannot disagree
 * about where the front is. `retreatTrail` opens the token's inner cut as the
 * disc collapses, which is what gives the retreat a trailing edge instead of
 * making it a blob that shrinks.
 *
 * ### Restore is exact, and it is free
 *
 * The ability never puts anything back. `Ability#borrow()` hands the token to
 * the ledger, the ledger's `_restore(Hook.AGE)` writes the documented neutral
 * on release, and the floor is bit-for-bit the material it was — on a normal
 * finish, on **C**, on a fifth cast pushing this one off the concurrency cap,
 * and on teardown. That is the whole reason `SceneHooks` is a ledger rather
 * than a pair of functions, and this is the ability it was written for.
 */
export const entropy = {
  /* --- the cast --- */
  range: 20.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 40.0, // how fast the seed runs out to the circle, metres/second
  zoneRadius: 5.5, // the footprint the circle indicator draws, metres
  cooldown: 1.8, // seconds
  castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- where the cast leaves the caster --- */
  handForward: 0.5, // metres in front of the caster the seed leaves
  handHeight: 1.22, // metres above the floor

  /* --- the three beats --- */
  // impactDuration = spreadTime + holdTime; fadeDuration = retreatTime. There
  // is no fourth "settle" window: the restore *is* the retreat, and giving it a
  // tail of its own only ever produced a second of nothing at the end.
  spreadTime: 1.25, // seconds the wave takes to cross the circle
  holdTime: 0.85, // seconds the whole zone stands aged
  retreatTime: 1.6, // seconds the decay takes to come back in
  restoreHold: 0.55, // 0..1 of the retreat the wear holds at full before it washes out

  /* --- the field --- */
  fieldSpread: 1.0, // outer radius of the sweep, × zoneRadius
  fieldEdge: 0.4, // softness of both edges, as a fraction of the radius
  // Deliberately short of 1. The hook saturates this, so a default sitting on
  // the ceiling is a control that can only ever come down — and the harness
  // duly reports it as a dead slider, which is exactly what it is.
  fieldAmount: 0.92, // peak strength of the whole field, 0..1
  fieldGrain: 1.5, // metres — the feature size of the ageing patches
  spreadCurve: 0.75, // < 1 makes the front leave fast and arrive slowly
  retreatCurve: 1.35, // > 1 makes it hesitate before it lets go
  retreatTrail: 0.72, // how hollow the collapsing disc is, 0..1
  seedReach: 0.12, // how far the field has come while the cast is still travelling

  /* --- the five substances --- */
  wearRust: 0.85, // toward `colorRust`, patchy, and the only term that adds metal
  wearDust: 0.55, // an even settling that flattens everything under it
  wearMoss: 0.7, // in the low-frequency hollows, matte, kills metalness
  wearPit: 0.62, // darkened specks; the stone itself going
  wearBleach: 0.4, // desaturates and lifts whatever survived the other four
  rustOnset: 0.18, // 0..1 of the zone's age before this term starts
  dustOnset: 0.04,
  mossOnset: 0.45, // last, because moss is the slowest thing that happens to a floor
  pitOnset: 0.0,
  bleachOnset: 0.6,
  colorRust: '#7a3b1c', // iron oxide
  colorDust: '#8a8375', // settled grey
  colorMoss: '#3d5a20', // the green in the hollows

  /* --- the front: a ring of refraction lying on the floor --- */
  // Magnitudes are SCREEN FRACTIONS, not metres, and the post pass applies
  // `post.distortion × global.distortion` on top — never multiply either in
  // here. `frontDepthReject` ships at 0 for the reason Singularity's lens does:
  // this quad lies *on* the surface it is bending, so occlusion-testing it
  // against that surface throws the entire ring away and the pass looks broken.
  frontStrength: 0.22, // screen widths of offset at post.distortion = 1
  frontThickness: 0.85, // metres — how thick the wavefront is
  frontCompression: 1.15, // the leading half of the front
  frontRarefaction: 0.8, // the trailing half
  frontRings: 2, // 1..4 concentric fronts
  frontRingGap: 1.4, // metres between them
  frontRingDecay: 0.62, // how much weaker each ring behind the first is
  frontWindow: 0.9, // 0..1 of the radius the effect is windowed into
  frontMaxOffset: 1.2, // hard clamp on the offset, screen widths
  frontOpacity: 1.0,
  frontFalloff: 0.35, // × strength while the front is parked at full spread
  frontLift: 0.05, // metres the quad floats above the floor
  frontDepthReject: 0.0, // see the note above
  frontDepthFade: 0.5, // metres over which standing geometry cuts the ring
  frontPerspective: 0.4, // 0 = a fixed screen fraction, 1 = shrinks with distance
  frontPerspectiveRef: 16.0, // metres at which perspective = 1

  /* --- what comes off the floor --- */
  // All three are seeded by rejection against `sceneHooks.ageAt()`, so they can
  // only be born where the published field says the ground has actually aged.
  ageBias: 0.12, // minimum field strength at a point before it can shed anything

  /* --- the fine dust lifting off the pitting --- */
  moteRate: 90, // particles/second at full field
  moteSize: 0.045,
  moteSpeed: 0.4, // metres/second
  moteLifetime: 2.4, // seconds
  moteRise: 0.55, // metres/second² of lift
  moteOpacity: 0.5,
  moteTurbulence: 0.8,
  colorMoteA: '#b8ab95',
  colorMoteB: '#8a8375',
  colorMoteC: '#575046',
  colorMoteD: '#26221d',

  /* --- rust flakes peeling and blowing --- */
  flakeRate: 34, // particles/second at full field
  flakeSize: 0.05,
  flakeSpeed: 1.6, // metres/second
  flakeLifetime: 1.9, // seconds
  flakeGravity: -5.5, // metres/second² — flakes are light, they do not drop like chips
  flakeSpin: 7.5, // radians/second of tumble
  colorFlakeA: '#b85a26',
  colorFlakeB: '#7a3b1c',
  colorFlakeC: '#4a2513',
  colorFlakeD: '#241409',

  /* --- moss spores, once the moss has arrived --- */
  sporeRate: 26, // particles/second at full field
  sporeSize: 0.06,
  sporeSpeed: 0.55, // metres/second
  sporeLifetime: 3.2, // seconds
  sporeRise: 0.35, // metres/second² of lift
  sporeGlow: 0.6, // barely — this school does not glow, it rots
  sporeTurbulence: 1.0,
  colorSporeA: '#8fae5c',
  colorSporeB: '#5c7a34',
  colorSporeC: '#3d5a20',
  colorSporeD: '#16220c',

  /* --- the punctuation --- */
  castBurstSize: 1.6, // the puff at the caster's hand, metres
  castBurstIntensity: 0.9,
  castFlash: 0.04, // screen flash on release — small; nothing here is bright
  peakRingRadius: 7.5, // metres — the ring at the moment the wave reaches the rim
  peakRingIntensity: 0.7,
  restoreFlash: 0.05, // screen flash as the floor comes back
  impactShake: 0.22, // the wave landing
  shakeDuration: 0.9, // seconds
  rumble: 0.018, // continuous shake while the zone is aged
  colorCastA: '#4a3f30',
  colorCastB: '#8a8375',
  colorCastC: '#b8ab95',
  colorCastFlash: '#8a8375',
  colorRestoreFlash: '#cdc3ae',
  colorRingA: '#4a2513', // body of the floor ring
  colorRingB: '#b8ab95', // its crest

  /* --- dynamic light --- */
  // A light that *removes* light is not a thing a renderer will sell you, so
  // this one is under-driven and drains further as the field peaks; the floor's
  // own darkening does the rest of the work.
  lightIntensity: 7, // deliberately low
  lightRadius: 13, // metres
  lightDrain: 0.55, // × intensity removed at full field
  lightColor: '#9c8f74'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Entropy Wave.
 *
 * Everything worth reaching for is in "The five substances", and the one to
 * drag first is `wearRust` — it is the only term that moves metalness, and
 * metalness is what makes an aged patch read as a different *substance* rather
 * than a different colour. Take it to zero with the other four at full and the
 * whole zone collapses back into a stain; that comparison is the fastest way to
 * see what this ability actually is.
 *
 * After that, `fieldGrain`. The five terms are sampled at three deliberately
 * incommensurate multiples of it, so it is the size of the story: at 0.4 m the
 * floor looks corroded, at 4 m it looks like weather.
 *
 * `retreatTrail` is the retreat's only real control. At 0 the aged disc shrinks
 * as a blob; at 0.7 it collapses as a ring, which is the only version that
 * reads as a wave going back where it came from.
 */
export const entropySchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 5, 200, 1, 'travel speed'],
    ['zoneRadius', 1, 16, 0.1, 'footprint radius'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handHeight', 0, 3, 0.01, 'hand height']
  ],
  'The beats': [
    ['spreadTime', 0.1, 6, 0.01, 'spread time'],
    ['holdTime', 0, 6, 0.01, 'hold time'],
    ['retreatTime', 0.1, 8, 0.01, 'retreat time'],
    ['restoreHold', 0, 0.95, 0.01, 'wear holds through']
  ],
  'The sweep': [
    ['fieldSpread', 0.1, 3, 0.01, 'radius ×R'],
    ['fieldEdge', 0.01, 1, 0.01, 'edge softness'],
    ['fieldAmount', 0, 1, 0.01, 'peak strength'],
    ['fieldGrain', 0.1, 6, 0.05, 'patch size (m)'],
    ['spreadCurve', 0.2, 4, 0.01, 'spread curve'],
    ['retreatCurve', 0.2, 4, 0.01, 'retreat curve'],
    ['retreatTrail', 0, 0.99, 0.01, 'retreat hollow'],
    ['seedReach', 0, 1, 0.01, 'field while travelling']
  ],
  'The five substances': [
    ['wearRust', 0, 1, 0.01, 'rust'],
    ['wearDust', 0, 1, 0.01, 'dust'],
    ['wearMoss', 0, 1, 0.01, 'moss'],
    ['wearPit', 0, 1, 0.01, 'pitting'],
    ['wearBleach', 0, 1, 0.01, 'bleaching'],
    ['rustOnset', 0, 1, 0.01, 'rust onset'],
    ['dustOnset', 0, 1, 0.01, 'dust onset'],
    ['mossOnset', 0, 1, 0.01, 'moss onset'],
    ['pitOnset', 0, 1, 0.01, 'pit onset'],
    ['bleachOnset', 0, 1, 0.01, 'bleach onset'],
    ['colorRust', 'rust'],
    ['colorDust', 'dust'],
    ['colorMoss', 'moss']
  ],
  'The front': [
    ['frontStrength', 0, 1.5, 0.01, 'strength (screen widths)'],
    ['frontThickness', 0.05, 4, 0.01, 'front thickness (m)'],
    ['frontCompression', 0, 3, 0.01, 'compression'],
    ['frontRarefaction', 0, 3, 0.01, 'rarefaction'],
    ['frontRings', 1, 4, 1, 'rings'],
    ['frontRingGap', 0.1, 6, 0.05, 'ring gap (m)'],
    ['frontRingDecay', 0, 1, 0.01, 'ring decay'],
    ['frontWindow', 0.05, 1, 0.01, 'window'],
    ['frontMaxOffset', 0.1, 4, 0.01, 'max offset'],
    ['frontOpacity', 0, 1, 0.01, 'opacity'],
    ['frontFalloff', 0, 1, 0.01, 'strength while parked'],
    ['frontLift', 0, 1, 0.005, 'float above floor (m)'],
    ['frontDepthReject', 0, 1, 0.01, 'occlusion strength'],
    ['frontDepthFade', 0.05, 3, 0.01, 'occlusion fade (m)'],
    ['frontPerspective', 0, 1, 0.01, 'perspective'],
    ['frontPerspectiveRef', 1, 40, 0.5, 'perspective ref (m)']
  ],
  'What comes off the floor': [
    ['ageBias', 0, 0.9, 0.01, 'minimum age to shed'],
    ['moteRate', 0, 500, 1, 'dust rate'],
    ['moteSize', 0.005, 0.4, 0.005, 'dust size'],
    ['moteSpeed', 0, 6, 0.05, 'dust speed'],
    ['moteLifetime', 0.1, 8, 0.05, 'dust lifetime'],
    ['moteRise', -3, 5, 0.01, 'dust lift'],
    ['moteOpacity', 0, 1, 0.01, 'dust opacity'],
    ['moteTurbulence', 0, 3, 0.01, 'dust turbulence'],
    ['flakeRate', 0, 300, 1, 'flake rate'],
    ['flakeSize', 0.005, 0.4, 0.005, 'flake size'],
    ['flakeSpeed', 0, 10, 0.05, 'flake speed'],
    ['flakeLifetime', 0.1, 6, 0.05, 'flake lifetime'],
    ['flakeGravity', -25, 2, 0.1, 'flake gravity'],
    ['flakeSpin', 0, 20, 0.1, 'flake tumble'],
    ['sporeRate', 0, 300, 1, 'spore rate'],
    ['sporeSize', 0.005, 0.4, 0.005, 'spore size'],
    ['sporeSpeed', 0, 6, 0.05, 'spore speed'],
    ['sporeLifetime', 0.1, 8, 0.05, 'spore lifetime'],
    ['sporeRise', -3, 5, 0.01, 'spore lift'],
    ['sporeGlow', 0, 4, 0.01, 'spore glow'],
    ['sporeTurbulence', 0, 3, 0.01, 'spore turbulence'],
    ['colorMote*', 'Dust colour'],
    ['colorFlake*', 'Flake colour'],
    ['colorSpore*', 'Spore colour']
  ],
  'Punctuation': [
    ['castBurstSize', 0.1, 6, 0.05, 'cast puff (m)'],
    ['castBurstIntensity', 0, 3, 0.01, 'cast intensity'],
    ['castFlash', 0, 1, 0.01, 'cast flash'],
    ['peakRingRadius', 0.5, 24, 0.1, 'peak ring (m)'],
    ['peakRingIntensity', 0, 3, 0.01, 'peak ring intensity'],
    ['restoreFlash', 0, 1, 0.01, 'restore flash'],
    ['impactShake', 0, 3, 0.01, 'shake'],
    ['shakeDuration', 0.1, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.5, 0.005, 'running rumble'],
    ['colorCastA', 'cast shell'],
    ['colorCastB', 'cast body'],
    ['colorCastC', 'cast crest'],
    ['colorCastFlash', 'cast flash colour'],
    ['colorRestoreFlash', 'restore flash colour'],
    ['colorRingA', 'floor ring'],
    ['colorRingB', 'floor ring crest']
  ],
  'Dynamic light': [
    ['lightIntensity', 0, 60, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightDrain', 0, 1, 0.01, 'drain at full field'],
    ['lightColor', 'light colour']
  ]
};
