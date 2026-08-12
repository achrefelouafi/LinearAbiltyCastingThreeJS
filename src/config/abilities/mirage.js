/* ================================================================== */
/* MIRAGE — the double made of refraction                              */
/* ================================================================== */
/**
 * A duplicate of the caster runs the aimed line, drawn with **nothing but the
 * refraction buffer**.
 *
 * There is no mesh on `LAYER.VFX` in this ability. No emissive, no particles,
 * no decal, no shell. Ten `DistortionField(REFRACT)` hulls — a head, a torso,
 * two upper arms, two forearms, two thighs, two shins — write a screen-space
 * offset into the half-resolution distortion target, and the only reason you
 * see anything at all is that the floor grid, the character and every particle
 * behind those hulls bends around them. Take the distortion pass out and this
 * cast is an empty frame.
 *
 * ### The two numbers that decide everything
 *
 * `bodyStrength` and `limbStrength` are in **screen widths at
 * `post.distortion = 1`** — never metres. A fragment writing 1 shifts the frame
 * behind it by a whole `post.distortion` of screen width whatever its distance,
 * which is what makes an authored strength mean the same thing on a cast that
 * lands three metres away and one that lands twenty-five. Neither master gain
 * (`post.distortion`, `global.distortion`) is folded in here; the pass applies
 * both, once. At the shipped 0.62 the torso displaces what is behind it by
 * 0.62 × 0.045 ≈ **2.8% of screen width** — fifty pixels at 1080p, a bend you
 * cannot miss and cannot mistake for a bug. The first pass shipped 1.6 and the
 * figure tore the frame into two halves that did not meet at its silhouette.
 *
 * The limbs run *lower* than the body on purpose. A refracting solid bends
 * hardest at its silhouette (the `refractPower` rim term), and a forearm is
 * nearly all silhouette — at equal strength the arms read as the brightest
 * thing in the figure and it comes apart into four sausages and a blob.
 *
 * ### Proportions are fractions of a height, and the height is measured
 *
 * Every dimension of the figure below is a **fraction of the caster's own
 * height** rather than a metre, and the height itself is read off the rigged
 * character in the scene every frame (`MirageAbility#_figureHeight`).
 * `figureHeight` is only the fallback for a scene with no character in it —
 * the headless harness, mostly. That is why the double is the caster's size
 * without anybody typing 1.78 twice, and why swapping the FBX for a taller rig
 * moves the mirage with it.
 *
 * The canon here is the rig's, not Vitruvius's: shoulders at 0.815 of height
 * and hips at 0.53 are what the Mixamo skeleton measures, and a figure built
 * on the textbook 0.5 hip line reads as a short-legged child at twenty metres.
 *
 * ### Why the gait is driven by distance and not by a clock
 *
 * `stride` is metres of ground per full gait cycle, and the phase is
 * `2π × travelled / stride`. Drive the legs off a frequency instead and the
 * feet skate the moment you drag `speed`, which is the single most obvious
 * tell in any running animation. Drag `stride` while paused and the double
 * re-poses on the spot.
 */
export const mirage = {
  /* --- the cast --- */
  range: 26.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 7.4, // how fast the double runs, metres/second — a hard run
  lifetime: 1.05, // seconds the halt beat lasts (the double stopping)
  fadeTime: 0.55, // seconds the last of the disturbance takes to go
  cooldown: 1.1,
  castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the double --- */
  // No proportions here, and that is the point: the figure IS the caster's rig,
  // cloned bone for bone, so its height, its build and the cut of its coat come
  // from the FBX and can never drift out of step with the man casting it.
  figureScale: 0.98, // × the caster. Deliberately not 1 — see `poseDelay`.
  figureLead: 0.55, // metres in front of the caster the double peels off
  figureSide: 0.0, // metres to the side (+ follows `Ability#side`)

  /* --- the pose track --- */
  // The double replays the caster's own animation from `poseDelay` seconds ago.
  // This is what stops it reading as double-vision: at 0 the two figures move
  // as one and the eye pairs them, and by about 0.2 s it is plainly a second
  // person doing the same thing a moment later.
  poseDelay: 0.28, // seconds behind the caster — HEADLINE
  rate: 45, // pose samples per second written to the track
  window: 2.5, // seconds of history kept; older samples fall off

  /* --- the halt: the beat where you lose it --- */
  haltTime: 0.72, // seconds the double takes to come to a standstill
  haltCoast: 1.7, // metres it carries past the target while stopping
  stopPower: 2.1, // exponent on speed → visibility; >1 loses it early
  stillness: 0.0, // refraction that survives a dead stop — 0 is the ability

  /* --- the refraction --- */
  bodyStrength: 0.9, // the whole body, screen widths at post.distortion = 1 — HEADLINE
  refractPower: 1.35, // rim exponent; 0 flattens every hull to a plain pane
  refractRipple: 0.16, // break-up of the surface normal — heat off a body
  refractRippleScale: 2.4, // ripple cycles per metre
  refractRippleSpeed: 1.7, // metres/second the ripple crawls
  refractOpacity: 0.95, // coverage — who wins where it overlaps another emitter
  // 0.3, not 1. The point of this term is to stop the double warping something
  // standing *in front of* it, and at 1 it does far more than that: the double
  // stands on a floor that recedes immediately behind its own silhouette, so
  // the depth test rejects most of the body against the ground it is walking
  // on. Measured, that cost about five-sixths of the effect. A partial reject
  // keeps the occlusion that matters and gives the figure back.
  refractDepthReject: 0.3, // 0..1 how hard the floor and the real body occlude it
  refractDepthFade: 0.7, // metres that occlusion feathers over
  refractPerspective: 0.35, // 0 = a flat screen fraction, 1 = shrinks with range
  refractPerspectiveRef: 10.0, // metres at which perspective = 1

  /* --- feedback --- */
  // A mirage weighs nothing and lands on nothing, so there is no impact shake
  // and no screen flash anywhere in this ability. The rumble is the only thing
  // the camera does and it is set where you feel it and do not see it.
  rumble: 0.006, // continuous shake while the double is running

  /* --- dynamic light --- */
  // Ships at zero, and that is the ability: a refracting solid has no radiance
  // of its own. The three keys are here because `Ability#_updateLight` indexes
  // them blind on every block. Dragging the intensity up is the one way to
  // cheat this slot, and it is worth doing once to see what it costs.
  lightIntensity: 0.0,
  lightRadius: 6.0,
  lightColor: '#cfe6ff'
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Mirage.
 *
 * Reach for `bodyStrength` first, then `refractPower`. The second one is the
 * unintuitive one: a solid of any real refractive index bends what is behind
 * it hardest at its silhouette, and the exponent on that rim term is the
 * difference between a person-shaped hole and a person-shaped pane of glass.
 * Take it to 0 and the body becomes a uniform offset — the whole figure
 * slides the scene sideways as one block and stops reading as a body.
 *
 * `stopPower` is the ability. Take it to 0.2 and the double is still plainly
 * there when it has stopped, which turns the slot into "a ghost that walks";
 * at the shipped 2.1 you lose it about two-thirds of the way through the halt,
 * while it is still moving, and the last thing you saw was already gone.
 *
 * There is no proportions folder any more and there never will be again: the
 * figure is the caster's rig, so the only shape control it needs is
 * `figureScale`. What replaced it is `poseDelay`, which is the difference
 * between a second person and a rendering fault.
 */
export const mirageSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 1, 30, 0.1, 'run speed (m/s)'],
    ['lifetime', 0.1, 4, 0.01, 'halt beat'],
    ['fadeTime', 0.05, 3, 0.01, 'fade time'],
    ['cooldown', 0, 6, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The double': [
    ['figureScale', 0.3, 2.5, 0.01, 'size × caster'],
    ['figureLead', -1, 4, 0.01, 'start offset (m)'],
    ['figureSide', -3, 3, 0.01, 'lateral offset (m)']
  ],
  'The double/Pose track': [
    ['poseDelay', 0, 2, 0.01, 'pose delay (s)'],
    ['rate', 5, 120, 1, 'samples / second'],
    ['window', 0.5, 6, 0.1, 'history kept (s)']
  ],
  'The halt': [
    ['haltTime', 0.05, 3, 0.01, 'halt time (s)'],
    ['haltCoast', 0, 8, 0.05, 'coast past target (m)'],
    ['stopPower', 0.1, 8, 0.05, 'loss-of-motion power'],
    ['stillness', 0, 1, 0.01, 'refraction at a standstill']
  ],
  Refraction: [
    ['bodyStrength', 0, 3, 0.01, 'body strength'],
    ['refractPower', 0, 6, 0.01, 'rim exponent'],
    ['refractRipple', 0, 1.5, 0.01, 'surface ripple'],
    ['refractRippleScale', 0.05, 10, 0.01, 'ripple cycles/m'],
    ['refractRippleSpeed', -8, 8, 0.01, 'ripple speed (m/s)'],
    ['refractOpacity', 0, 1, 0.01, 'coverage'],
    ['refractDepthReject', 0, 1, 0.01, 'occlusion'],
    ['refractDepthFade', 0.01, 3, 0.01, 'occlusion feather (m)'],
    ['refractPerspective', 0, 1, 0.01, 'shrink with distance'],
    ['refractPerspectiveRef', 1, 40, 0.1, 'perspective ref (m)']
  ],
  Feedback: [['rumble', 0, 0.2, 0.001, 'run rumble']],
  'Dynamic light': [
    ['lightIntensity', 0, 40, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 30, 0.1, 'light radius'],
    ['lightColor', 'light colour']
  ]
};
