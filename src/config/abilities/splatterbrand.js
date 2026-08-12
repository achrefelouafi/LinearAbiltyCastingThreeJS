/* ================================================================== */
/* SPLATTERBRAND — Splatterbrand                                       */
/* ================================================================== */
/**
 * A loaded brush flung down the line.
 *
 * The trick is **splatter morphology**, and the whole of it is that a thrown
 * blob does not make a circle. It makes three things, and the third one is the
 * one your eye actually recognises:
 *
 *  1. a **directional main mass**, stretched down the travel vector, blunter at
 *     the trailing edge than the leading one because the trailing edge is where
 *     the sheet tore away rather than where it spread to (`massAlong`,
 *     `massAcross`, `massLead`, `massRear`);
 *  2. a **crown of teeth** on the leading arc, which is a Rayleigh–Plateau
 *     breakup of an expanding rim and therefore genuinely periodic in bearing
 *     with a tooth count that rises with the rim's own radius (`crown`,
 *     `crownSpacing`, `crownSharp`, `crownGate`);
 *  3. **satellite droplets** thrown further along the travel vector, sized by a
 *     bounded Pareto law, with the small ones flying furthest and arriving last.
 *
 * Number three is where this block earns its keep. `satAlpha` is the exponent
 * of the power law and 2–3 is what fragmenting sheets actually do; set it to 8
 * and the draw collapses onto `satMin`, which is a dozen identical dots and
 * reads as a stencil. `throwCurve` couples distance to that same draw, so the
 * far field is fine and the near field coarse. Those two numbers are the
 * ability.
 *
 * ### Every droplet is flown, not just marked
 *
 * `vfx/InkDiffusion.js` uploads its satellite dice as uniform arrays rather
 * than hashing them in the shader, precisely so the CPU can ask exactly where
 * droplet *i* is going to land. This block therefore drives a `vfx/Projectile`
 * of `satellites + 1` bodies whose landing points and arrival times are
 * *derived from the mark* — the flying drop lands in its own splash on the
 * frame the splash pops in. Which is why the numbers below have no separate
 * scatter controls for the bodies in the air: there is one distribution and the
 * shader owns it.
 *
 * ### The school has no bloom in it
 *
 * No flash, no burst shell, no additive particle, no decal. `markCeiling` hard
 * clamps the field's luminance below `post.bloomThreshold`, and the trail is
 * `NormalBlending` with pigment-dark stops — even at `global.glow` pinned to
 * its maximum its luminance stays an order of magnitude under the threshold.
 * The only specular term in the ability is the wet gloss on the leading edge,
 * inside the clamp.
 */

export const splatterbrand = {
  /* --- the cast --- */
  range: 22.0, // maximum cast distance, metres
  minRange: 3.0, // closer than this and the cast is refused
  speed: 27.0, // how fast the blob crosses the line, metres/second
  cooldown: 1.2, // seconds
  castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

  /* --- the beats, in seconds ---
   * `impactDuration` is not `holdTime` on its own: the last satellite lands
   * `satDelay + satJitter` after the mass does, and a phase that ended before
   * then would tear the projectile out of the air mid-throw.
   */
  holdTime: 3.0, // seconds the mark stands once the last droplet is down
  fadeTime: 2.4, // seconds it soaks away over

  /* ================================================================ */
  /* The throw — Projectile(ARC)                                       */
  /* ================================================================ */
  /**
   * One launch point for all seventeen bodies, because it is one handful.
   *
   * There is no `spread` here and no `count`: how far each droplet is thrown
   * and how many there are is decided by the mark, under `The satellites`
   * below. What lives here is only what the *flight* needs.
   */
  handHeight: 1.42, // metres above the floor the handful leaves the caster at
  handForward: 0.62, // metres in front of the caster
  handSide: 0.3, // metres to the side (+ follows `Ability#side`)
  apex: 2.1, // metres of ballistic loft
  apexCurve: 1.05, // >1 flattens the top of the lob
  pathCurve: 1.0, // easing exponent on launch → land; >1 accelerates

  massRadius: 0.27, // metres — the blob in the air. Not the mark it makes
  dropScale: 0.72, // a droplet's body radius as a fraction of its own mark
  dropStretch: 1.85, // × along the heading — a drop in flight is not a sphere
  dropSpin: 2.4, // radians/second of tumble on the unaligned axis
  dropFlash: 0.05, // seconds of birth pop
  dropLinger: 0.09, // seconds a landed body stays before it has fully sunk
  dropSink: 2.6, // body radii it sinks over that linger — into its own splash

  /* --- the blob's silhouette. A change rebuilds the geometry --- */
  blobFacets: 1, // icosphere subdivisions, 0..2
  blobLumps: 0.34, // how far the surface wanders
  blobLumpScale: 1.7, // features per unit radius
  blobRough: 0.1, // fine break-up on top of the lumps
  blobRoughness: 0.36, // MeshStandardMaterial roughness — wet, not glossy
  blobMetalness: 0.0, // ink is not a metal and this is here to stay zero
  colorBlob: '#0e0d13', // the body in the air

  /* ================================================================ */
  /* The mark — InkDiffusion(SPLATTER)                                 */
  /* ================================================================ */

  /* --- the spread --- */
  markRadius: 4.6, // metres the *mass* is allowed to reach. Satellites are exempt
  markHeight: 0.02, // metres above the floor
  spread: 2.35, // metres of front radius at t = 1 s
  spreadPower: 0.36, // well under Fickian: a splat arrives, it does not diffuse
  edge: 0.075, // metres, the width of the interface
  clipSoft: 0.85, // metres the mass fades out over as it reaches `markRadius`
  sources: 3, // live nuclei — a flung blob lands in pieces
  sourceScatter: 0.22, // fraction of the radius the later nuclei scatter over
  sourceDelay: 0.05, // seconds each later nucleus starts behind the first

  /* --- the instability, riding on top of the directional mass --- */
  finger: 0.42, // overall amplitude; 0 gives a smooth lozenge
  fingerMax: 0.6, // cap, as a fraction of the front radius
  coarse: 1.5, // metres — the coarsest lobe. Tighter than a bloom's, on purpose
  onset: 0.6, // front radii per wavelength before a mode is admitted
  growth: 1.2, // e-folds per wavelength of front travel
  growthMax: 1.3, // saturation — a finger stops growing at its own width

  /* --- the film --- */
  core: 0.62, // density floor inside the mass
  falloff: 2.8, // metres of e-folding out from a nucleus
  film: 0.66, // alpha floor inside the coverage
  granulation: 0.24, // pigment settling into the paper's tooth as it dries
  granScale: 2.2, // features per metre
  ring: 0.62, // the deposition line at the interface
  ringWidth: 0.085, // metres

  /* --- wet and dry --- */
  dryTime: 1.5, // seconds for the gloss to fall to 1/e
  wetDarken: 0.45, // how far the wet film pulls toward `colorMarkWet`
  gloss: 0.26, // specular strength on the wet film — under the ceiling
  glossPower: 42, // its tightness
  meniscus: 0.62, // how far the film's normal tips at the interface

  /* --- the mass: the anisotropy is in the metric, never in a bearing --- */
  massAlong: 1.5, // metric stretch down the travel vector
  massAcross: 0.74, // and across it
  massLead: 0.24, // fraction of the front the mass sits forward by
  massRear: 1.55, // >1 blunts the trailing edge, where the sheet tore

  /* --- the crown on the leading arc --- */
  crown: 0.38, // fraction of the front the teeth add
  crownSpacing: 0.5, // metres of rim per tooth — the tooth count follows the radius
  crownSharp: 8, // tooth narrowness
  crownGate: 2.4, // how tightly the crown is held to the leading arc

  /* --- the satellites. `satAlpha` and `throwCurve` are the ability --- */
  satellites: 13, // live droplets, and the number of bodies flown after the mass
  satMin: 0.05, // metres, smallest droplet radius
  satMax: 0.4, // metres, largest
  satAlpha: 2.35, // exponent of the size power law — 2..3 is what splashes do
  throwNear: 1.7, // metres past the mass, nearest droplet
  throwFar: 9.5, // metres, furthest — also sizes the quad
  throwCurve: 1.8, // bias of the distance draw; small drops fly furthest
  throwSpread: 0.2, // lateral cone, as a fraction of the distance
  satTail: 2.5, // teardrop tail length, in droplet radii
  satDelay: 0.5, // seconds the furthest droplet lands behind the mass
  satJitter: 0.14, // seconds of per-droplet slop on that
  satPop: 0.055, // seconds a droplet's mark takes to appear

  /* --- how the mark is inked --- */
  markOpacity: 1.0,
  markCeiling: 0.6, // max linear luminance; `post.bloomThreshold` is 0.88
  markSoftFade: 0.25, // metres of depth feather against standing geometry
  markTint: 0.04, // where in the gradient a zero-density film sits
  markTintDensity: 1.12, // over 1, so a thick film reaches `colorMarkPool`
  colorMarkThin: '#a37f6e', // the thinnest film — vermilion runs warm when dilute
  colorMarkBody: '#8c2f1e',
  colorMarkDeep: '#42120c',
  colorMarkPool: '#160604', // where the mass went down
  colorMarkRing: '#5e1c0e', // the deposition line at the interface
  colorMarkWet: '#1e0805', // what the still-wet film pulls toward
  colorMarkGloss: '#d2c8bc', // the sheen on the wet leading edge

  /* ================================================================ */
  /* The ligaments — Projectile's instanced trail                      */
  /* ================================================================ */
  /**
   * One ribbon width serves every body, which is a real limitation of the
   * shared trail and one this ability happens to be able to live with: what
   * follows a detaching drop is a **ligament**, the thread that connects it to
   * the sheet, and a ligament's thickness is set by surface tension rather than
   * by the drop on the end of it. Turn `trailWidth` up past about 0.15 m and
   * the excuse stops working.
   */
  trailSpan: 0.24, // seconds of flight the tail reaches back over
  trailBurn: 0.14, // seconds the tail takes to catch the head up after landing
  trailWidth: 0.075, // metres at the head
  trailTaper: 1.6, // >1 sharpens the tail to a point
  trailLift: 0.0, // metres the tail floats above the flown path
  trailOpacity: 0.85,
  trailGlow: 0.55, // NOT a glow — the trail is NormalBlending and this only dims it
  trailCore: 2.6, // how tightly ink crowds the centre line
  trailHeadBias: 0.55, // >0 keeps the density near the body
  trailNoise: 0.45,
  trailNoiseScale: 2.4, // features per metre
  trailNoiseSpeed: 0.5,
  trailSoftFade: 0.35, // metres of depth feather
  colorTrailA: '#7a3020', // at the head, where the ligament is thickest
  colorTrailB: '#4a170e',
  colorTrailC: '#240a06',
  colorTrailD: '#0e0405',

  /* ================================================================ */
  /* Particles                                                         */
  /* ================================================================ */
  /**
   * Two systems, both **non-additive**, both burst-driven off the projectile's
   * own arrival list rather than emitted at a rate. A droplet throws its spatter
   * when it lands and never at any other time, which is what makes the far field
   * keep arriving after the mass has gone quiet.
   */

  /* --- the fine spatter thrown off every landing --- */
  spatterCount: 14, // particles per satellite arrival
  spatterMassCount: 90, // ...and at the mass
  spatterSize: 0.045,
  spatterSpeed: 3.2, // metres/second
  spatterLifetime: 0.85,
  spatterGravity: -9.5, // metres/second² — these are droplets, they fall
  colorSpatterA: '#8c2f1e',
  colorSpatterB: '#5a1a10',
  colorSpatterC: '#2c0b07',
  colorSpatterD: '#120504',

  /* --- atomised ink hanging over the mark --- */
  mistCount: 26, // puffs at the mass impact
  mistRate: 12, // puffs/second while the mark is still wet
  mistSize: 0.65,
  mistSpeed: 1.1, // metres/second
  mistLifetime: 2.2,
  mistOpacity: 0.07, // it occludes; more than a tenth and it is fog, not ink
  mistRise: 0.42, // metres/second
  colorMistA: '#5c3226',
  colorMistB: '#3e2019',
  colorMistC: '#281410',
  colorMistD: '#160b09',

  /* ================================================================ */
  /* Feedback                                                          */
  /* ================================================================ */
  // No flash and no burst: both are emissive and this school does not emit.
  impactShake: 0.42, // camera kick as the mass lands
  shakeDuration: 0.4, // seconds it decays over
  rumble: 0.008, // continuous shake while the handful is in the air

  /* --- dynamic light ---
   * Dim, and warm because the mark is vermilion and a wet vermilion floor
   * bounces warm. Above about 12 the splatter starts to look lit from within,
   * which is the failure mode of the school.
   */
  lightIntensity: 5.0,
  lightRadius: 8.5,
  lightColor: '#a8705c',
  lightPulse: 0.14, // depth of its slow swell, 0 = steady
  lightPulseSpeed: 2.2 // swells/second
};

/* ------------------------------------------------------------------ */
/* Editor layout                                                       */
/* ------------------------------------------------------------------ */
/**
 * Splatterbrand.
 *
 * **The satellites** is the folder that owns the ability. Drag `satAlpha` from
 * 2.35 up to 6 with the clock stopped and watch the far field collapse into a
 * row of identical dots; drag `throwCurve` to 0.2 and watch the biggest drops
 * fly furthest, which is the one thing a splatter never does. Both re-place the
 * flying bodies as well as the marks, because the bodies are derived from the
 * marks and there is only one distribution in the ability.
 *
 * **The mass** is the second stop. `massAcross` at 1.0 with `massAlong` at 1.0
 * is a circle, and a circle is the failure this whole slot exists to avoid.
 */
export const splatterbrandSchema = {
  'The cast': [
    ['range', 3, 60, 0.1, 'max range'],
    ['minRange', 0, 12, 0.1, 'min range'],
    ['speed', 4, 120, 0.5, 'throw speed'],
    ['cooldown', 0, 8, 0.05, 'cooldown'],
    ['castAnim', 'cast animation']
  ],
  'The beats': [
    ['holdTime', 0.2, 12, 0.05, 'hold time (s)'],
    ['fadeTime', 0.1, 8, 0.05, 'soak-away time (s)']
  ],
  'The satellites': [
    ['satellites', 0, 16, 1, 'droplets'],
    ['satAlpha', 1.1, 6, 0.01, 'size power law'],
    ['satMin', 0.005, 1, 0.005, 'smallest (m)'],
    ['satMax', 0.02, 2, 0.005, 'largest (m)'],
    ['throwNear', 0, 20, 0.05, 'nearest (m)'],
    ['throwFar', 0.5, 30, 0.05, 'furthest (m)'],
    ['throwCurve', 0.05, 6, 0.01, 'distance bias'],
    ['throwSpread', 0, 1, 0.005, 'lateral cone'],
    ['satTail', 0, 8, 0.05, 'teardrop tail (radii)'],
    ['satDelay', 0, 3, 0.01, 'furthest lands after (s)'],
    ['satJitter', 0, 1, 0.005, 'arrival slop (s)'],
    ['satPop', 0.005, 0.6, 0.005, 'mark pop-in (s)']
  ],
  'The mass': [
    ['massAlong', 0.1, 4, 0.01, 'stretch along'],
    ['massAcross', 0.1, 4, 0.01, 'stretch across'],
    ['massLead', -1, 1, 0.005, 'forward offset'],
    ['massRear', 0.2, 4, 0.01, 'trailing bluntness'],
    ['markRadius', 0.5, 14, 0.05, 'mass clip radius (m)'],
    ['spread', 0.1, 12, 0.01, 'front at 1 s (m)'],
    ['spreadPower', 0.1, 1.5, 0.005, 'front exponent'],
    ['sources', 1, 3, 1, 'nuclei'],
    ['sourceScatter', 0, 1, 0.005, 'nucleus scatter'],
    ['sourceDelay', 0, 1, 0.005, 'nucleus stagger (s)'],
    ['clipSoft', 0.05, 4, 0.01, 'clip feather (m)']
  ],
  'The crown': [
    ['crown', 0, 1.5, 0.005, 'tooth reach'],
    ['crownSpacing', 0.05, 3, 0.01, 'metres of rim / tooth'],
    ['crownSharp', 1, 30, 0.5, 'tooth narrowness'],
    ['crownGate', 0.05, 8, 0.05, 'held to the leading arc']
  ],
  'The instability': [
    ['coarse', 0.2, 8, 0.02, 'coarsest lobe (m)'],
    ['finger', 0, 2, 0.01, 'finger amplitude'],
    ['fingerMax', 0.05, 2, 0.01, 'finger cap (× front)'],
    ['onset', 0.05, 2, 0.01, 'admission (radii / λ)'],
    ['growth', 0, 4, 0.01, 'growth (e-folds / λ)'],
    ['growthMax', 0.1, 6, 0.01, 'growth saturation']
  ],
  'The film': [
    ['markHeight', 0.002, 0.2, 0.001, 'quad height (m)'],
    ['edge', 0.005, 1, 0.005, 'interface width (m)'],
    ['core', 0, 1, 0.005, 'density floor'],
    ['falloff', 0.2, 20, 0.05, 'density e-fold (m)'],
    ['film', 0, 1, 0.005, 'alpha floor'],
    ['granulation', 0, 1, 0.005, 'granulation'],
    ['granScale', 0.1, 8, 0.02, 'grain / metre'],
    ['ring', 0, 2, 0.01, 'deposition ring'],
    ['ringWidth', 0.01, 1, 0.005, 'ring width (m)'],
    ['dryTime', 0.05, 12, 0.05, 'dry time (s)'],
    ['wetDarken', 0, 1, 0.005, 'wet darkening'],
    ['gloss', 0, 1.5, 0.005, 'wet gloss'],
    ['glossPower', 2, 160, 1, 'gloss tightness'],
    ['meniscus', 0, 2, 0.01, 'meniscus'],
    ['markOpacity', 0, 2, 0.01, 'mark opacity'],
    ['markCeiling', 0.05, 1, 0.005, 'luminance ceiling'],
    ['markSoftFade', 0.01, 3, 0.01, 'soft intersection (m)'],
    ['markTint', 0, 1, 0.005, 'gradient floor'],
    ['markTintDensity', 0, 2, 0.01, 'gradient / density'],
    ['colorMarkThin', 'thinnest film'],
    ['colorMarkBody', 'body'],
    ['colorMarkDeep', 'deep'],
    ['colorMarkPool', 'the mass'],
    ['colorMarkRing', 'deposition line'],
    ['colorMarkWet', 'wet ink'],
    ['colorMarkGloss', 'wet sheen']
  ],
  'The throw': [
    ['handHeight', 0, 3, 0.01, 'hand height'],
    ['handForward', -1, 3, 0.01, 'hand forward'],
    ['handSide', -1.5, 1.5, 0.01, 'hand lateral'],
    ['apex', 0, 12, 0.05, 'loft (m)'],
    ['apexCurve', 0.1, 4, 0.01, 'loft flatness'],
    ['pathCurve', 0.2, 4, 0.01, 'path easing'],
    ['massRadius', 0.02, 1.5, 0.005, 'blob radius (m)'],
    ['dropScale', 0.05, 2, 0.01, 'droplet body / mark'],
    ['dropStretch', 0.2, 5, 0.01, 'stretch along heading'],
    ['dropSpin', 0, 20, 0.1, 'tumble (rad/s)'],
    ['dropFlash', 0, 1, 0.005, 'birth pop (s)'],
    ['dropLinger', 0, 1, 0.005, 'linger on landing (s)'],
    ['dropSink', 0, 8, 0.05, 'sink (radii)']
  ],
  'The blob': [
    ['blobFacets', 0, 2, 1, 'subdivisions'],
    ['blobLumps', 0, 1.5, 0.01, 'lumpiness'],
    ['blobLumpScale', 0.2, 6, 0.05, 'lumps / radius'],
    ['blobRough', 0, 1, 0.005, 'surface break-up'],
    ['blobRoughness', 0.02, 1, 0.005, 'material roughness'],
    ['blobMetalness', 0, 1, 0.01, 'material metalness'],
    ['colorBlob', 'blob colour']
  ],
  'The ligaments': [
    ['trailSpan', 0.01, 2, 0.005, 'tail reach (s)'],
    ['trailBurn', 0.01, 2, 0.005, 'tail catch-up (s)'],
    ['trailWidth', 0.005, 0.6, 0.005, 'ribbon width (m)'],
    ['trailTaper', 0.1, 5, 0.01, 'tail taper'],
    ['trailLift', 0, 1, 0.005, 'tail lift (m)'],
    ['trailOpacity', 0, 2, 0.01, 'ligament opacity'],
    ['trailGlow', 0, 2, 0.01, 'ligament level'],
    ['trailCore', 0.2, 8, 0.05, 'centre crowding'],
    ['trailHeadBias', -1, 2, 0.01, 'head bias'],
    ['trailNoise', 0, 2, 0.01, 'break-up'],
    ['trailNoiseScale', 0.1, 8, 0.05, 'break-up / metre'],
    ['trailNoiseSpeed', 0, 4, 0.01, 'break-up speed'],
    ['trailSoftFade', 0.01, 3, 0.01, 'soft intersection (m)'],
    ['colorTrail*', 'Ligament colour']
  ],
  'Spatter & mist': [
    ['spatterCount', 0, 120, 1, 'per droplet'],
    ['spatterMassCount', 0, 600, 1, 'at the mass'],
    ['spatterSize', 0.005, 0.4, 0.005, 'spatter size'],
    ['spatterSpeed', 0, 20, 0.05, 'spatter speed'],
    ['spatterLifetime', 0.05, 5, 0.01, 'spatter lifetime'],
    ['spatterGravity', -30, 5, 0.1, 'spatter gravity'],
    ['mistCount', 0, 200, 1, 'mist at the mass'],
    ['mistRate', 0, 200, 1, 'mist rate'],
    ['mistSize', 0.05, 4, 0.01, 'mist size'],
    ['mistSpeed', 0, 8, 0.05, 'mist speed'],
    ['mistLifetime', 0.2, 10, 0.05, 'mist lifetime'],
    ['mistOpacity', 0, 0.6, 0.002, 'mist opacity'],
    ['mistRise', -2, 4, 0.01, 'mist rise'],
    ['colorSpatter*', 'Spatter colour'],
    ['colorMist*', 'Mist colour']
  ],
  'Feedback & light': [
    ['impactShake', 0, 3, 0.01, 'impact shake'],
    ['shakeDuration', 0.05, 4, 0.01, 'shake duration'],
    ['rumble', 0, 0.2, 0.001, 'throw rumble'],
    ['lightIntensity', 0, 40, 0.5, 'light intensity'],
    ['lightRadius', 0.5, 40, 0.1, 'light radius'],
    ['lightPulse', 0, 1, 0.01, 'light swell'],
    ['lightPulseSpeed', 0.1, 12, 0.1, 'swell rate'],
    ['lightColor', 'light colour']
  ]
};
